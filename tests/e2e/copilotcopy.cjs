// Copying from a GitHub Copilot pane (#736, #737). Copilot tracks the mouse and selects text itself; Ctrl+C on its
// selection copies it with an OSC 52 write to the terminal, which Hive's terminal dropped (Copilot said "copied to
// clipboard" and the clipboard kept what it had). Right-click is Hive's in every pane (#737): it copies the terminal's
// selection (Shift+drag in Copilot's pane) or pastes, once, as the button never reaches Copilot; Settings → Advanced →
// Pass right-click to Copilot gives the button to Copilot instead, which copies its own selection with it. Hive never
// starts Copilot with --no-mouse (Copilot would save it into the user's own settings).
// The real Copilot CLI, offline against the scripted stand-in model (fake-copilot-api.cjs), in a folder it already
// trusts. An OSC 52 read is never answered (the clipboard isn't read) and a write from a terminal the user isn't using is
// refused, both logged. The clipboard is stubbed in the page: never the real one. Copilot runs in a home of the suite's
// own with the GitHub CLI's login hidden: never the user's ~/.copilot or gh sign-in. Skipped where Copilot isn't
// installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000

const userData = path.join(lib.WORK, 'copilotcopy-profile')
const ws = path.join(lib.WORK, 'copilotcopy-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'copilotcopy-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'copilotcopy-api.jsonl')
const TEXT = 'SELECTME alpha beta gamma delta'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(apiLog, { force: true })
  lib.gitProject(proj, { 'a.ts': 'probe\n' })
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47831), ...copilotTestEnv(api, copilotDir, { above: lib.WORK }) })
  // The folder is trusted already (as "Yes, and remember this folder" saves it): Copilot goes straight to its prompt.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [proj] }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  const hiveLog = path.join(userData, 'logs', 'hive.log')
  const logged = (re) => {
    try {
      return re.test(fs.readFileSync(hiveLog, 'utf8'))
    } catch {
      return false
    }
  }
  try {
    await lib.fitWindow(app, page, { width: 1200, height: 800 })
    await lib.appReady(page)
    // The clipboard, stubbed: what was written, what a read gives (__clip) and how often it was read. The window's focus
    // too, as the test says, not as Windows allows (a quiet test window never takes the OS focus): window.__focused,
    // with its blur and focus events.
    await page.evaluate(() => {
      window.__copied = []
      window.__reads = 0
      window.__clip = ''
      window.__focused = true
      document.hasFocus = () => window.__focused
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => (window.__reads++, window.__clip), writeText: async (t) => void window.__copied.push(t) } })
    })
    const copied = () => page.evaluate(() => window.__copied)
    const reads = () => page.evaluate(() => window.__reads)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => { const i = (await inv('provider:info')).copilot; return i && !i.checking ? i : null }, 60000, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (${info?.source ?? '?'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop', provider: 'copilot', location: 'project' })
    const key = lib.ptyKey(proj, a.id)
    const live = async () => (await inv('session:live')).find((l) => l.agentId === a.id)
    const status = async () => (await live())?.status
    const screen = async () => lib.plainText(await inv('pty:buffer', key).catch(() => ''))
    // What the terminal shows now (the pty's history keeps text since rubbed out).
    const onScreen = async () => ((await page.evaluate((k) => window.__hiveTerminalLines(k), key)) ?? []).join('\n')
    const textAt = (text) => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [key, text])
    const output = (data) => page.evaluate(([k, d]) => window.__hiveTerminalOutput(k, d), [key, data])
    const hiveSelection = () => page.evaluate((k) => window.__hiveTerminalSelection(k), key)
    const mouse = () => page.evaluate((k) => window.__hiveTerminalState(k)?.mouse, key)
    const rightClickGoesTo = () => page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.getAttribute('data-right-click'), key)

    await inv('session:start', proj, { agentId: a.id })
    check('Copilot is ready', !!(await lib.until(async () => (await status()) === 'ready', 60000, 200)), await status())
    const sent = await lib.sendPrompt(inv, key, `say ${TEXT}`, { submitted: async () => ['working', 'finished'].includes(await status()) })
    check('the prompt is taken', sent > 0, await status())
    check('the turn finishes', !!(await lib.until(async () => (await status()) === 'finished', 60000, 200)), await status())
    // Hive leaves Copilot its own mouse handling (no --no-mouse, #737): it tracks any motion.
    check('Copilot tracks the mouse', !!(await lib.until(async () => (await mouse()) === 'any', HUNG_MS, 100)), await mouse())
    check("right-click is Hive's", (await rightClickGoesTo()) === 'hive', await rightClickGoesTo())

    // Where the text is: the middle of its first character, and a character's width from two words' positions.
    const at = await lib.until(async () => {
      const [s, al, d] = [await textAt(TEXT), await textAt('alpha beta'), await textAt('delta')]
      return s && al && d && s.y === d.y ? { s, d, w: (al.x - s.x) / 9 } : null
    }, HUNG_MS, 200)
    check('the reply is on screen', !!at, JSON.stringify(at))
    // Copilot's own selection as it draws it (on a background colour): the whole text, as a user sees it before copying.
    const copilotSelected = async () => ((await page.evaluate((k) => window.__hiveTerminalHighlighted(k), key)) ?? []).some((r) => r.trimEnd() === TEXT)
    // A drag over the text. Without Shift it's Copilot's, which takes its last moves a moment after a key that follows at
    // once (#1299: Ctrl+C straight after the drag copied "SELE" while the whole text was drawn selected after it), so
    // it is over once Copilot draws the whole text selected, from none drawn before: true then.
    const drag = async (shift) => {
      const clear = shift || !!(await lib.until(async () => !(await copilotSelected()), HUNG_MS, 100))
      await page.mouse.move(at.s.x - at.w / 2 + 1, at.s.y)
      if (shift) await page.keyboard.down('Shift')
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(at.s.x + ((at.d.x + 6 * at.w - at.s.x) * i) / 8, at.s.y)
      await page.mouse.up()
      if (shift) await page.keyboard.up('Shift')
      return shift || (clear && !!(await lib.until(copilotSelected, HUNG_MS, 100)))
    }
    const rightClick = () => page.mouse.click(at.s.x + at.w, at.s.y, { button: 'right' })
    const clickBelow = () => page.mouse.click(at.s.x, at.s.y + 4 * at.w)

    // 1. Copilot's own selection: a drag (reported to Copilot, which tracks the mouse), then Ctrl+C. Copilot copies with
    // an OSC 52 write; the terminal is in use (focused, a key just now), so the text reaches the clipboard.
    const copiedOnScreen = (await screen()).split('copied to clipboard').length
    check('Copilot draws the drag as its selection, over the whole text', await drag(false), JSON.stringify(await page.evaluate((k) => window.__hiveTerminalHighlighted(k), key)))
    check("the drag makes Copilot's selection, not Hive's", (await hiveSelection()) === '', JSON.stringify(await hiveSelection()))
    await page.keyboard.press('Control+c')
    const got = await lib.until(async () => ((await copied()).length ? await copied() : null), HUNG_MS, 100)
    check("Ctrl+C on Copilot's selection puts its text on the clipboard (OSC 52)", JSON.stringify(got) === JSON.stringify([TEXT]), JSON.stringify(got))
    check('Copilot says it copied', !!(await lib.until(async () => (await screen()).split('copied to clipboard').length > copiedOnScreen, HUNG_MS, 100)))
    check('the agent was not interrupted', (await status()) === 'finished', await status())
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-1-copied.png') })

    // 2. Right-click with nothing of Hive's selected pastes, once: the button never reaches Copilot, which tracks the
    // mouse (as Codex did, which pasted on right-click too: everything was pasted twice).
    const readsBefore = await reads()
    await page.evaluate(() => {
      window.__clip = 'PASTEONCE'
    })
    await clickBelow()
    await rightClick()
    const shown = await lib.until(async () => ((await onScreen()).includes('PASTEONCE') ? await onScreen() : null), HUNG_MS, 100)
    check('right-click with nothing selected pastes', !!shown && (await reads()) === readsBefore + 1, `${(await reads()) - readsBefore} read(s)`)
    check('…once', !!shown && shown.split('PASTEONCE').length === 2, JSON.stringify(shown?.split('\n').filter((l) => l.includes('PASTEONCE'))))
    for (let i = 0; i < 'PASTEONCE'.length; i++) await page.keyboard.press('Backspace')
    check('…and is rubbed out again', !!(await lib.until(async () => !(await onScreen()).includes('PASTEONCE'), HUNG_MS, 100)), await onScreen())
    await page.evaluate(() => {
      window.__clip = ''
    })

    // 3. A read (what a program asks to get the clipboard back) is never answered, even from the terminal in use.
    const readsNow = await reads()
    await clickBelow()
    check('a read request is parsed', await output('\x1b]52;c;?\x07'))
    check('…and logged as refused', !!(await lib.until(() => logged(/OSC 52 clipboard read refused \(read\)/), HUNG_MS, 100)))
    check('…without reading the clipboard', (await reads()) === readsNow, `${(await reads()) - readsNow} read(s)`)

    // 4. A write from a terminal the user isn't using (the focus elsewhere) changes nothing.
    await page.evaluate(() => document.activeElement?.blur())
    check('a write request is parsed', await output(`\x1b]52;c;${Buffer.from('not asked for').toString('base64')}\x07`))
    check('…and logged as refused', !!(await lib.until(() => logged(/OSC 52 clipboard write refused \(not-in-use\)/), HUNG_MS, 100)))
    check('…leaving the clipboard as it was', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))

    // 4b. The pane keeps the focus but the window loses it (the user went to another app, just after a click in the pane):
    // a write is refused, and still is once the window is back without new input; a click in the pane then allows one.
    // A write's outcome is settled once xterm has parsed it (the handler and the stub's push run as it parses).
    const writeB64 = (t) => output(`\x1b]52;c;${Buffer.from(t).toString('base64')}\x07`)
    const setFocus = (f) => page.evaluate((focused) => {
      window.__focused = focused
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    }, f)
    const inPane = () => page.evaluate((k) => !!document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.contains(document.activeElement), key)
    await clickBelow()
    check('a click focuses the pane', !!(await lib.until(inPane, HUNG_MS, 100)))
    await setFocus(false)
    check('the window lost the focus, the pane kept it', await inPane())
    await writeB64('background overwrite')
    check('…a write is refused', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))
    await setFocus(true)
    await writeB64('no fresh input')
    check('back in the window without new input, a write is still refused', JSON.stringify(await copied()) === JSON.stringify([TEXT]), JSON.stringify(await copied()))
    await clickBelow()
    await writeB64('after a click')
    check('…and taken after a click in the pane', JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click']), JSON.stringify(await copied()))

    // 4c. The policy (#1292, Settings → Advanced: A CLI putting text on the clipboard). Block: a write from the pane in
    // use is refused too. Ask each time: the question shows the text; Don't Copy leaves the clipboard, Copy fills it.
    const POLICY = 'cw.terminal.osc52'
    const question = page.locator('.dialog', { hasText: 'Copy to the clipboard?' })
    // A change reaches the window in its states' batch (HI-1938), after the call answers: a write before it meets the old
    // policy, refused without a new log line (one per reason a minute).
    const setPolicy = async (v) => {
      await inv('advanced:set', POLICY, v)
      await lib.until(() => page.evaluate(([id, want]) => window.__hiveAdvancedValue(id) === want, [POLICY, v]), HUNG_MS, 100)
    }
    await setPolicy('block')
    await clickBelow()
    await writeB64('blocked write')
    check('Block: a write from the pane in use is refused', !!(await lib.until(() => logged(/OSC 52 clipboard write refused \(blocked\)/), HUNG_MS, 100)) && JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click']), JSON.stringify(await copied()))
    await setPolicy('ask')
    await clickBelow()
    await writeB64('asked write')
    check('Ask each time: the question shows the text', !!(await lib.until(async () => (await question.count()) === 1 && (await question.innerText()).includes('asked write'), HUNG_MS, 100)), await question.innerText().catch(() => 'no question'))
    check("…in the dialog's box, as the text to copy", ((await question.locator('.dialog-list').innerText().catch(() => '')).trim()) === 'asked write' && (await question.locator('.dialog-list button').count()) === 0, await question.innerHTML().catch(() => ''))
    check('…in monospace, as written (HR4: the plain list had lost it)', /Cascadia Mono|Consolas|monospace/.test(await question.locator('.dialog-list ul').evaluate((el) => getComputedStyle(el).fontFamily)), await question.locator('.dialog-list ul').evaluate((el) => getComputedStyle(el).fontFamily).catch(() => ''))
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-ask.png') })
    check('…and nothing is copied while it waits', JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click']), JSON.stringify(await copied()))
    await question.getByRole('button', { name: "Don't Copy" }).click()
    check("Don't Copy leaves the clipboard as it was", !!(await lib.until(async () => (await question.count()) === 0, HUNG_MS, 100)) && JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click']), JSON.stringify(await copied()))
    await clickBelow()
    await writeB64('copied when asked')
    check('…asked again for the next write', !!(await lib.until(async () => (await question.count()) === 1, HUNG_MS, 100)))
    await question.getByRole('button', { name: 'Copy', exact: true }).click()
    check('Copy puts the text on the clipboard', !!(await lib.until(async () => JSON.stringify(await copied()) === JSON.stringify([TEXT, 'after a click', 'copied when asked']), HUNG_MS, 100)), JSON.stringify(await copied()))
    await setPolicy('allow')

    // 5. Shift+drag: Hive's own selection, whatever Copilot does with the mouse; Ctrl+C copies it and Copilot never
    // sees the key (no new "copied to clipboard", no interrupt).
    const before = (await screen()).split('copied to clipboard').length
    const n = (await copied()).length
    await drag(true)
    const selected = await lib.until(async () => ((await hiveSelection())?.includes(TEXT) ? await hiveSelection() : null), HUNG_MS, 100)
    check("Shift+drag makes Hive's selection", !!selected, JSON.stringify(await hiveSelection()))
    await page.keyboard.press('Control+c')
    const hive = await lib.until(async () => ((await copied()).length > n ? await copied() : null), HUNG_MS, 100)
    check("Ctrl+C copies Hive's selection", !!hive && hive[n].includes(TEXT), JSON.stringify(hive))
    // Copilot takes its input in order: once it has answered a prompt typed after the Ctrl+C, a Ctrl+C it got would show.
    const since = (await live())?.statusSince
    const turnOver = async () => { const l = await live(); return l?.status === 'finished' && l.statusSince !== since }
    const next = await lib.sendPrompt(inv, key, 'say AFTERCOPY', { submitted: async () => (await status()) === 'working' || (await turnOver()) })
    check('the next prompt is answered', next > 0 && !!(await lib.until(turnOver, 60000, 200)), await status())
    check('…and Copilot got no Ctrl+C', (await screen()).split('copied to clipboard').length === before && (await copied()).length === n + 1, JSON.stringify(await copied()))
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-5-shift.png') })

    // 6. Shift+drag, then right-click: Hive's right-click copies Hive's selection, as in every pane, without a paste.
    const m6 = (await copied()).length
    const reads6 = await reads()
    await drag(true)
    check("Shift+drag makes Hive's selection again", !!(await lib.until(async () => (await hiveSelection())?.includes(TEXT), HUNG_MS, 100)), JSON.stringify(await hiveSelection()))
    // Moving the mouse to right-click keeps it: a move over a program tracking the mouse counts as input, which xterm
    // clears a selection on, so Hive doesn't report moves while there is one. The move is settled once the next
    // evaluation runs (Playwright waits for the page to take it).
    await page.mouse.move(at.s.x + at.w, at.s.y + at.w)
    await page.mouse.move(at.s.x + at.w, at.s.y)
    check('…and moving the mouse keeps it', (await hiveSelection())?.includes(TEXT), JSON.stringify(await hiveSelection()))
    await rightClick()
    const rc = await lib.until(async () => ((await copied()).length > m6 ? await copied() : null), HUNG_MS, 100)
    check('right-click copies it', !!rc && rc[m6].includes(TEXT), JSON.stringify(rc))
    check('…clears it, and pastes nothing', (await hiveSelection()) === '' && (await reads()) === reads6, `${JSON.stringify(await hiveSelection())}, ${(await reads()) - reads6} read(s)`)
    check('…without interrupting Copilot', (await status()) === 'finished', await status())

    // 7. Pass right-click to Copilot (at once, no restart): the button goes to Copilot, which copies its own selection
    // with it (an OSC 52 write); Hive neither copies nor pastes.
    await inv('advanced:set', 'copilot.mouse.rightClickToCli', true)
    check('right-click now goes to Copilot', !!(await lib.until(async () => (await rightClickGoesTo()) === 'cli', HUNG_MS, 100)), await rightClickGoesTo())
    const m7 = (await copied()).length
    const reads7 = await reads()
    check('Copilot draws the drag as its selection again', await drag(false), JSON.stringify(await page.evaluate((k) => window.__hiveTerminalHighlighted(k), key)))
    check("the drag makes Copilot's selection", (await hiveSelection()) === '', JSON.stringify(await hiveSelection()))
    await rightClick()
    const viaCopilot = await lib.until(async () => ((await copied()).length > m7 ? await copied() : null), HUNG_MS, 100)
    check("right-click over Copilot's selection: Copilot copies it", !!viaCopilot && viaCopilot[m7] === TEXT, JSON.stringify(viaCopilot))
    check('…and Hive pasted nothing (the clipboard was not read)', (await reads()) === reads7, `${(await reads()) - reads7} read(s)`)
    check('…without interrupting Copilot', (await status()) === 'finished', await status())
    await page.screenshot({ path: path.join(lib.WORK, 'copilotcopy-7-passed.png') })

    await inv('session:stop', proj, a.id).catch(() => {})
    await lib.until(async () => !(await live()), 30000, 200)
  } finally {
    await app.close().catch(() => {})
    await api.close()
  }
  if (failed) process.exitCode = 1
})().catch((e) => {
  console.error(e)
  console.log('FAIL the suite threw')
  process.exit(1)
})
