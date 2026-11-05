// Settings → Advanced's switches for an agent pane's keys and for what Combwork types (#1286, #966 rows 24 and 29), on a
// fake Claude Code session (fake-claude/, logging each read of its input), so nothing signs in or spends tokens.
// 1. Send prompts as typed: a card the user starts on a running agent without hive tools is typed into its CLI. By
//    default its prompt goes in on one line (spacing collapsed, line breaks gone); turned on, the paste keeps the
//    description's line breaks and spacing, and the CLI gets the prompt as written.
// 2. Ctrl+C and Ctrl+V go to the CLI: by default Ctrl+C over a selection copies it and Ctrl+V pastes the clipboard's
//    text; turned on, at once, the CLI gets both keys (^C, ^V) and Combwork neither copies nor reads the clipboard; off
//    again, Combwork's once more. The clipboard is stubbed in the page: never the real one.
// 3. All keys go to the CLI (#1292, #966 row 26): Combwork's Ctrl+P is Combwork's by default; turned on, it reaches the CLI
//    (^P), and the command palette's Ctrl+Shift+P still opens the palette.
// 4. A card's start in its own words (#1292, #966 row 30): the CLI gets the card's title and description alone.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'terminalinput-profile')
const ws = path.join(lib.WORK, 'terminalinput-ws')
const claudeHome = path.join(lib.WORK, 'terminalinput-claude-home')
const alpha = path.join(ws, 'alpha')
const PORT = Number(lib.port(47840))
const AS_TYPED = 'cw.prompt.asTyped'
const CTRL_CV = 'cw.terminal.ctrlCVToCli'
const ALL_KEYS = 'cw.terminal.allKeysToCli'
const RAW_START = 'cw.prompt.rawCardStart'
/** The start of the wrapper Combwork types around a card's start (prompt.card.start, src/shared/tasks.ts): it survives a rename. */
const WRAPPER = 'Work on task '
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha])
  fs.writeFileSync(path.join(claudeHome, 'fake-log-input.txt'), '')
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  // No hive tools, so a card the user starts on a running agent is typed into its CLI as their input (#650).
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, port: PORT, provideHiveMcp: false, allowSessionInput: true }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    // The clipboard, stubbed (as codexoverrides): what Combwork wrote, what a read gives (__clip) and how often Combwork read it.
    await page.evaluate(() => {
      window.__copied = []
      window.__reads = 0
      window.__clip = ''
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => (window.__reads++, window.__clip), writeText: async (t) => void window.__copied.push(t) } })
    })
    const copied = () => page.evaluate(() => window.__copied)
    const reads = () => page.evaluate(() => window.__reads)
    const setClip = (t) => page.evaluate((x) => (window.__clip = x), t)

    const def = await lib.addAgent(inv, alpha, { name: 'Tester' })
    await page.getByText('alpha', { exact: true }).first().click()
    const key = lib.ptyKey(alpha, def.id)
    const live = async () => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === def.id)
    await inv('session:start', alpha, { agentId: def.id })
    check('the fake Claude Code is ready', !!(await lib.until(async () => (await live())?.status === 'ready', HUNG_MS)), JSON.stringify(await live().then((l) => l && { status: l.status })))

    /** What the CLI read of its input since `from` reads, as it came. */
    const inputLog = path.join(claudeHome, 'fake-input.jsonl')
    const readsOfInput = () => (fs.existsSync(inputLog) ? fs.readFileSync(inputLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).data) : [])
    const inputSince = (from) => readsOfInput().slice(from).join('')
    const transcriptHas = (text) => {
      const dir = path.join(claudeHome, 'projects')
      return fs.existsSync(dir) && fs.readdirSync(dir).some((d) => fs.readdirSync(path.join(dir, d)).some((f) => f.endsWith('.jsonl') && fs.readFileSync(path.join(dir, d, f), 'utf8').includes(text)))
    }
    /** Starts a card on the agent as the user does from the board: typed into its CLI (no hive tools), its turn then ended. */
    const startCard = async (title, description) => {
      const card = await inv('tasks:create', { title, description, project: 'alpha' })
      // Combwork keeps an agent it just typed a card into as being given it for a few seconds, refuses one still working on
      // the last card's turn (its end can reach Combwork after the status read before), and one the user has just typed in
      // (the keys of part 3): started once none holds.
      let started = null
      await lib.until(async () => {
        started = await inv('tasks:start', card.number, { kind: 'agent', agentId: def.id }).then(() => true, (e) => String(e?.message ?? e))
        return started === true || !/being given another card|is working|has just typed in it/.test(started)
      }, HUNG_MS, 300)
      // Its prompt taken (in the transcript), then its turn over: the next card can be started on it.
      await lib.until(async () => transcriptHas(title), HUNG_MS, 200)
      await lib.until(async () => ['ready', 'finished'].includes((await live())?.status), HUNG_MS, 200)
      return started
    }
    const inTranscript = (text) => JSON.stringify(text).slice(1, -1)

    // ---- 1. Send prompts as typed: a card's description, with its lines and indentation.
    const written = 'Plan one:\n  step A\n\nstep B'
    let from = readsOfInput().length
    let started = await startCard('Card one', written)
    check('a card started on the agent is typed into its CLI', started === true, String(started))
    check('by default it goes in as one line, as a paste: spacing collapsed, line breaks gone', !!(await lib.until(async () => inputSince(from).includes('Card one Plan one: step A step B\x1b[201~'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    check('…and the CLI gets it on one line', !!(await lib.until(async () => transcriptHas(inTranscript('Card one Plan one: step A step B')), HUNG_MS, 200)))
    // What part 4 looks for to say Combwork's wrapper is left out: shown here to be typed, so that check can fail (HI-2514).
    check("by default it goes in inside Combwork's wrapper", inputSince(from).includes(WRAPPER), JSON.stringify(inputSince(from)))

    await inv('advanced:set', AS_TYPED, true)
    from = readsOfInput().length
    started = await startCard('Card two', written)
    check('as typed, a card started on the agent is typed into its CLI', started === true, String(started))
    check('as typed, the paste keeps its spacing and line breaks (each the Enter a terminal pastes)', !!(await lib.until(async () => inputSince(from).includes('Card two\r\rPlan one:\r  step A\r\rstep B\x1b[201~'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    check('…and the CLI gets the prompt as written', !!(await lib.until(async () => transcriptHas(inTranscript('Card two\n\nPlan one:\n  step A\n\nstep B')), HUNG_MS, 200)))
    await inv('advanced:set', AS_TYPED, false)

    // Invisible characters (#1547): Claude Code 2.1.309 leaves a prompt with one unsent until Enter again, so Combwork leaves
    // them out; those an emoji is made of stay.
    from = readsOfInput().length
    started = await startCard('Card three', 'Zero​width﻿ and a family \u{1f468}‍\u{1f469}')
    check('a card with invisible characters is typed without them, an emoji kept whole', !!(await lib.until(async () => inputSince(from).includes('Card three Zerowidth and a family \u{1f468}‍\u{1f469}\x1b[201~'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))

    // ---- 2. Ctrl+C and Ctrl+V. Text to select: typed into the CLI's input, never sent.
    const TEXT = 'SELECTME alpha beta delta'
    const textAt = (t) => page.evaluate(([k, x]) => window.__hiveTerminalTextAt(k, x), [key, t])
    const selection = () => page.evaluate((k) => window.__hiveTerminalSelection(k), key)
    const ctrlCV = () => page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.getAttribute('data-ctrl-cv'), key)
    const allKeys = () => page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.getAttribute('data-all-keys'), key)
    await inv('pty:write', key, TEXT)
    const at = await lib.until(async () => {
      const [s, al, d] = [await textAt('SELECTME'), await textAt('alpha beta'), await textAt('delta')]
      return s && al && d && s.y === d.y ? { s, d, w: (al.x - s.x) / 9 } : null
    }, HUNG_MS, 200)
    check("the typed text is in the CLI's input", !!at)
    const select = async () => {
      await page.mouse.move(at.s.x - at.w / 2 + 1, at.s.y)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) await page.mouse.move(at.s.x + ((at.d.x + 6 * at.w - at.s.x) * i) / 8, at.s.y)
      await page.mouse.up()
      return lib.until(async () => ((await selection())?.includes('SELECTME') ? await selection() : null), HUNG_MS, 100)
    }

    // The default: Combwork's copy and paste.
    let n = (await copied()).length
    from = readsOfInput().length
    check('a drag selects the text', !!(await select()), JSON.stringify(await selection()))
    await page.keyboard.press('Control+C')
    const got = await lib.until(async () => ((await copied()).length > n ? await copied() : null), HUNG_MS, 100)
    check('by default Ctrl+C copies the selection (the stubbed clipboard gets it)', !!got && got[n].includes('SELECTME'), JSON.stringify(got))
    check('…and the CLI gets no ^C', !inputSince(from).includes('\x03'), JSON.stringify(inputSince(from)))
    await setClip('PASTED')
    let r = await reads()
    from = readsOfInput().length
    await page.keyboard.press('Control+V')
    check("by default Ctrl+V pastes the clipboard's text (one read, a paste)", !!(await lib.until(async () => inputSince(from).includes('\x1b[200~PASTED\x1b[201~'), HUNG_MS, 100)) && (await reads()) === r + 1, `${(await reads()) - r} read(s), ${JSON.stringify(inputSince(from))}`)
    check('…and the CLI gets no ^V', !inputSince(from).includes('\x16'))
    await page.screenshot({ path: path.join(lib.WORK, 'terminalinput-1-default.png') })

    // Turned on, with the agent running: both keys go to the CLI at once.
    const pid = (await live())?.pid
    await inv('advanced:set', CTRL_CV, true)
    check('switched on: the pane gives Ctrl+C and Ctrl+V to the CLI at once', !!(await lib.until(async () => (await ctrlCV()) === 'cli', HUNG_MS, 100)), await ctrlCV())
    n = (await copied()).length
    check('a drag selects the text again', !!(await select()), JSON.stringify(await selection()))
    from = readsOfInput().length
    await page.keyboard.press('Control+C')
    check('switched on, Ctrl+C goes to the CLI (^C), selection or not', !!(await lib.until(async () => inputSince(from).includes('\x03'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    check('…and Combwork copies nothing', (await copied()).length === n, JSON.stringify(await copied()))
    r = await reads()
    from = readsOfInput().length
    await page.keyboard.press('Control+V')
    check('switched on, Ctrl+V goes to the CLI (^V)', !!(await lib.until(async () => inputSince(from).includes('\x16'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    check("…and Combwork doesn't read the clipboard or paste", (await reads()) === r && !inputSince(from).includes('\x1b[200~'), `${(await reads()) - r} read(s)`)
    check('…without a restart (the same CLI process)', (await live())?.pid === pid, JSON.stringify(await live().then((l) => l && { pid: l.pid, status: l.status })))
    await page.screenshot({ path: path.join(lib.WORK, 'terminalinput-2-to-cli.png') })

    // Off again: Combwork's again, at once.
    await inv('advanced:set', CTRL_CV, false)
    check("off again: the pane's Ctrl+C and Ctrl+V are Combwork's at once", !!(await lib.until(async () => (await ctrlCV()) === 'hive', HUNG_MS, 100)), await ctrlCV())
    await setClip('AGAIN')
    r = await reads()
    from = readsOfInput().length
    await page.keyboard.press('Control+V')
    check("off again, Ctrl+V is Combwork's paste once more", !!(await lib.until(async () => inputSince(from).includes('\x1b[200~AGAIN\x1b[201~'), HUNG_MS, 100)) && (await reads()) === r + 1, `${(await reads()) - r} read(s), ${JSON.stringify(inputSince(from))}`)
    check('…and the CLI gets no ^V', !inputSince(from).includes('\x16'))

    // ---- 3. All keys go to the CLI (#1292, #966 row 26): Combwork's shortcut Ctrl+P (Go to Project) is Combwork's by default;
    // turned on, it reaches the CLI (^P), and the command palette's own (Ctrl+Shift+P) still opens the palette.
    const palette = page.locator('.palette')
    const focusPane = async () => {
      await page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"] .xterm-helper-textarea`)?.focus(), key)
      return lib.until(() => page.evaluate((k) => !!document.activeElement?.closest(`.terminal-host[data-pty="${CSS.escape(k)}"]`), key), HUNG_MS, 100)
    }
    const closePalette = async () => {
      await page.keyboard.press('Escape')
      await lib.until(async () => (await palette.count()) === 0, HUNG_MS, 100)
    }
    check('the pane has the focus', !!(await focusPane()))
    from = readsOfInput().length
    await page.keyboard.press('Control+P')
    check("by default Ctrl+P in the pane is Combwork's: Go to Project opens", !!(await lib.until(async () => (await palette.count()) === 1, HUNG_MS, 100)))
    check('…and the CLI gets no ^P', !inputSince(from).includes('\x10'), JSON.stringify(inputSince(from)))
    await closePalette()
    await inv('advanced:set', ALL_KEYS, true)
    // The setting reaches the window as an event, after the call returns (and with the workspace's loads, up to their
    // batch's end: HI-1938): a key pressed before then is still Combwork's.
    check('switched on: the pane gives all keys to the CLI', !!(await lib.until(async () => (await allKeys()) === 'cli', HUNG_MS, 100)), await allKeys())
    check('switched on, the pane has the focus again', !!(await focusPane()))
    from = readsOfInput().length
    await page.keyboard.press('Control+P')
    check('switched on, Ctrl+P goes to the CLI (^P)', !!(await lib.until(async () => inputSince(from).includes('\x10'), HUNG_MS, 100)), JSON.stringify(inputSince(from)))
    check("…and Combwork's Go to Project doesn't open", (await palette.count()) === 0)
    await page.keyboard.press('Control+Shift+P')
    check("…while the command palette's Ctrl+Shift+P still opens it", !!(await lib.until(async () => (await palette.count()) === 1, HUNG_MS, 100)))
    await page.screenshot({ path: path.join(lib.WORK, 'terminalinput-3-all-keys.png') })
    await closePalette()
    // The palette rebound to two steps (HR4's round 1): its first key starts Combwork's chord, its second opens the palette,
    // neither reaching the CLI; another command's second step after that first key goes to the CLI.
    await inv('settings:update', { keybindings: { 'palette.show': 'Mod+K Mod+P' } })
    check('rebound, the pane has the focus again', !!(await focusPane()))
    from = readsOfInput().length
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+P')
    check('the two-step palette shortcut opens the palette from the pane', !!(await lib.until(async () => (await palette.count()) === 1, HUNG_MS, 100)))
    check('…and the CLI gets neither step', !inputSince(from).includes('\x0b') && !inputSince(from).includes('\x10'), JSON.stringify(inputSince(from)))
    await closePalette()
    check('the pane has the focus once more', !!(await focusPane()))
    from = readsOfInput().length
    await page.keyboard.press('Control+K')
    await page.keyboard.press('Control+G')
    check("after its first key, another key goes to the CLI (^G), and the palette doesn't open", !!(await lib.until(async () => inputSince(from).includes('\x07'), HUNG_MS, 100)) && (await palette.count()) === 0, JSON.stringify(inputSince(from)))
    await inv('settings:update', { keybindings: {} })
    await inv('advanced:set', ALL_KEYS, false)

    // ---- 4. A card's start in its own words (#1292, #966 row 30): its title and description, nothing of Combwork's.
    await inv('advanced:set', RAW_START, true)
    from = readsOfInput().length
    started = await startCard('Card raw', 'Only this.')
    check('in its own words, a card started on the agent is typed into its CLI', started === true, String(started))
    check("…as the card's title and description alone, with none of Combwork's wrapper", !!(await lib.until(async () => transcriptHas('Card raw Only this.'), HUNG_MS, 200)) && !inputSince(from).includes(WRAPPER),JSON.stringify(inputSince(from)))
    await inv('advanced:set', RAW_START, false)
  } catch (e) {
    check('the suite ran to its end', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
