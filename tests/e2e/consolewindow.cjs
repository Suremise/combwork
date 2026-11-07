// The developer console's window (#637): hidden (no Help item, no palette entry, the shortcut does nothing, opening is
// refused) until Settings → Advanced → Show developer features is on; then Help → Developer Console opens it as a window
// of its own, whose page calls only the console's channels; picking a source shows a fake Claude Code's launch and hooks
// live, each event's raw payload beside what Combwork made of it; event type, provider and search filter the list; pause
// holds it (new events counted) and resume fills it in; clear empties it; the shortcut brings the open window forward;
// it remembers its size; closing it ends capture; Clear while paused drops what was held for good; a console belongs to
// its window's workspace (switching or closing it there closes the console and ends its capture, another window's
// console carrying on); recording writes a file, redacted unless text is ticked for that recording, with the CLIs' versions
// in its header, ending with the window or its workspace; Copy Diagnostics attaches the newest recording when asked, only
// a redacted one; opened on a display smaller than its saved bounds, it fits that display (#862); and turning the setting
// off closes it.
// Fake Claude Code; dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'consolewindow-profile')
const ws = path.join(lib.WORK, 'consolewindow-ws')
const claudeHome = path.join(lib.WORK, 'consolewindow-claude-home')
const alpha = path.join(ws, 'alpha')
// Two more workspaces: one for a second window, one the first window switches to.
const ws2 = path.join(lib.WORK, 'consolewindow-ws2')
const ws3 = path.join(lib.WORK, 'consolewindow-ws3')
const PORT = Number(lib.port(47872))
// What the prompt says that must never reach the window.
const PRIVATE = 'walrus-lantern-pebble'
// What a recording that opted in to text keeps, and every other one leaves out.
const SPOKEN = 'heron-copper-meadow'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, ws2, ws3]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha)
  lib.gitProject(path.join(ws2, 'beta'))
  lib.gitProject(path.join(ws3, 'gamma'))
  const claudeEnv = lib.fakeClaude(userData, claudeHome, [alpha, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    await lib.waitForProvider(inv)
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1' })
    const consoles = () => app.windows().filter((w) => w.url().endsWith('#console'))
    const helpItems = async () => {
      await page.locator('.menubar-item', { hasText: 'Help' }).click()
      const items = await page.locator('.menu .menu-item span:nth-child(2)').allTextContents()
      await page.keyboard.press('Escape')
      return items
    }

    // --- Hidden while Show developer features is off.
    check('off: no Developer Console in the Help menu', !(await helpItems()).includes('Developer Console'))
    await page.keyboard.press('Control+Shift+P')
    const paletteInput = page.locator('.palette input')
    await paletteInput.fill('Developer')
    // Developer Tools shows for "Developer": the list has filtered by then.
    const paletteRows = await lib.until(async () => {
      const rows = await page.locator('.palette .palette-item').allTextContents()
      return rows.some((r) => r.includes('Toggle Developer Tools')) ? rows : null
    }, HUNG_MS)
    check('…nor in the command palette', !!paletteRows && !paletteRows.some((r) => r.includes('Developer Console')), JSON.stringify(paletteRows))
    // Escape clears what is typed, then closes it.
    await paletteInput.press('Escape')
    await lib.until(async () => (await paletteInput.inputValue()) === '', HUNG_MS)
    await paletteInput.press('Escape')
    await lib.until(async () => (await page.locator('.palette').count()) === 0, HUNG_MS)
    await page.keyboard.press('Control+Alt+J')
    const refused = await inv('console:open').then(
      () => null,
      (e) => e.message
    )
    check('…opening it is refused, and says where to turn it on', /Show developer features/.test(refused ?? ''), refused ?? 'opened')
    check('…and neither the shortcut nor the call opened a window', consoles().length === 0)

    // --- On in Settings → Advanced.
    await page.locator('.activity-btn[aria-label="Settings"]').click()
    await page.locator('.settings-nav .row', { hasText: 'Advanced' }).click()
    const toggle = page.getByRole('switch', { name: 'Show developer features' })
    await toggle.click()
    await lib.until(async () => (await inv('settings:get')).advanced?.showDeveloperFeatures === true, HUNG_MS)
    check('Settings → Advanced → Show developer features turns it on', (await toggle.getAttribute('aria-checked')) === 'true')
    check('…and Help lists Developer Console', (await helpItems()).includes('Developer Console'))

    // --- Help → Developer Console opens its own window.
    await page.locator('.menubar-item', { hasText: 'Help' }).click()
    await page.locator('.menu .menu-item', { hasText: 'Developer Console' }).click()
    const dc = await lib.until(() => consoles()[0] ?? null, HUNG_MS)
    check('Help → Developer Console opens a window of its own', !!dc && dc !== page)
    if (!dc) throw new Error('no console window')
    dc.on('pageerror', (e) => check('no console page errors', false, e.message))
    await dc.locator('.dc-source').waitFor({ timeout: HUNG_MS })
    const title = await lib.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).find((x) => x.startsWith('Developer Console — consolewindow-ws')) ?? null), HUNG_MS)
    check('…titled for its workspace', !!title, String(title))
    const outside = await dc.evaluate(() => window.combwork.invoke('settings:update', { general: { userName: 'console-page' } }).then(() => 'allowed', (e) => e.message))
    check("…and its page may call only the console's channels", /Not allowed/.test(outside) && (await inv('settings:get')).general.userName !== 'console-page', outside)
    check('…watching nothing until a source is picked', (await dc.locator('.dc-live').textContent()).includes('Not watching') && (await inv('console:sources')).every((s) => !s.capturing))

    // --- The source picker: Combwork itself, the Assistant, and the project's agent (HI-2511: the app's name).
    const options = await lib.until(async () => {
      const o = await dc.locator('.dc-source option').evaluateAll((els) => els.map((e) => [e.value, e.textContent, e.parentElement.getAttribute('label')]))
      return o.some(([, t]) => t.startsWith('B1')) ? o : null
    }, HUNG_MS)
    check('the picker lists Combwork, the Assistant and the project\'s agents', options?.some(([v, t, g]) => v.startsWith('combwork:') && t.startsWith('Combwork') && g === 'Combwork') && options.some(([v, t, g]) => v.includes('#assistant') && t.startsWith('Assistant') && g === 'Combwork') && options.some(([, t, g]) => t.startsWith('B1') && g === 'alpha') && options.filter(([, , g]) => g === 'Combwork').every(([, t]) => t.startsWith('Combwork') || t.startsWith('Assistant')), JSON.stringify(options))
    const b1Option = options.find(([, t]) => t.startsWith('B1'))[0]
    await dc.locator('.dc-source').selectOption(b1Option)
    await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.capturing, HUNG_MS)
    check('picking B1 starts its capture, shown live', (await dc.locator('.dc-live').textContent()).includes('Live'))

    // --- B1's launch and hooks arrive, each with what Combwork made of it.
    await inv('session:start', alpha, { agentId: b1.id })
    const rows = () => dc.locator('.dc-row').evaluateAll((els) => els.map((e) => ({ seq: Number(e.dataset.seq), kind: e.dataset.kind, name: e.querySelector('.dc-name').textContent, summary: e.querySelector('.dc-summary').textContent })))
    const row = (pred) => lib.until(async () => (await rows()).find(pred), HUNG_MS)
    check('its launch shows', !!(await row((r) => r.kind === 'launch')))
    const start = await row((r) => r.name === 'SessionStart')
    check('SessionStart shows with its summary', !!start && start.summary.startsWith('SessionStart → start'), JSON.stringify(start))
    await dc.locator('.dc-row', { has: dc.locator('.dc-name', { hasText: 'SessionStart' }) }).first().click()
    const detail = dc.locator('.dc-detail')
    await detail.waitFor({ timeout: HUNG_MS })
    const raw = await detail.locator('.dc-raw').textContent()
    const made = await detail.locator('.dc-made').textContent()
    check('a picked event shows its raw payload beside what Combwork made of it', raw.includes('hook_event_name') && raw.includes('"SessionStart"') && made.includes('event') && made.includes('"start"'), `${raw.slice(0, 200)} | ${made.slice(0, 200)}`)
    await dc.screenshot({ path: path.join(lib.WORK, 'consolewindow-detail.png') })
    await detail.locator('.icon-btn[aria-label="Close (Esc)"]').click()
    await lib.agentIdle(inv, b1.id, HUNG_MS)

    // --- Filters: event type, provider and search.
    await dc.locator('.dc-kind[data-kind="hook"]').click()
    await lib.until(async () => (await rows()).every((r) => r.kind !== 'hook'), HUNG_MS)
    check('turning hooks off hides them', (await rows()).length > 0 && (await rows()).every((r) => r.kind !== 'hook'), JSON.stringify(await rows()))
    await dc.locator('.dc-kind[data-kind="hook"]').click()
    await lib.until(async () => (await rows()).some((r) => r.kind === 'hook'), HUNG_MS)
    const providers = await dc.locator('.dc-provider option').evaluateAll((els) => els.map((e) => e.value))
    check('the provider filter offers the events\' provider', providers.includes('claude-code'), JSON.stringify(providers))
    await dc.locator('.dc-provider').selectOption('claude-code')
    check('…and keeps its events', (await rows()).some((r) => r.name === 'SessionStart'))
    await dc.locator('.dc-provider').selectOption('')
    await dc.locator('.dc-search input').fill('SessionStart')
    await lib.until(async () => (await rows()).every((r) => r.name === 'SessionStart' || r.summary.includes('SessionStart')), HUNG_MS)
    check('search narrows the list to what matches', (await rows()).length >= 1 && (await rows()).every((r) => `${r.name} ${r.summary}`.includes('SessionStart')), JSON.stringify(await rows()))
    await dc.locator('.dc-search input').fill('')

    // --- Pause holds the list, counting what comes; resume fills it in.
    const before = (await rows()).length
    await dc.locator('.dc-pause').click()
    await lib.until(async () => (await dc.locator('.dc-live').textContent()).includes('Paused'), HUNG_MS)
    const key = lib.ptyKey(alpha, b1.id)
    await lib.sendPrompt(inv, key, `edit a.ts ${PRIVATE}`, { submitted: async () => /\(\d+ new\)/.test(await dc.locator('.dc-live').textContent()) })
    await lib.agentIdle(inv, b1.id, HUNG_MS)
    const held = await dc.locator('.dc-live').textContent()
    await dc.screenshot({ path: path.join(lib.WORK, 'consolewindow-paused.png') })
    check('paused: the list holds, and the indicator counts what came', /Paused \(\d+ new\)/.test(held) && (await rows()).length === before, `${held}; ${(await rows()).length} vs ${before}`)
    await dc.locator('.dc-pause').click()
    // Waits for the whole fill-in: the held rows and the indicator can land in separate renders.
    const resumed = async () => { const list = await rows(); return list.some((r) => r.name === 'UserPromptSubmit') && list.some((r) => r.name === 'Stop') && (await dc.locator('.dc-live').textContent()).includes('Live') }
    await lib.until(resumed, HUNG_MS)
    check('resume fills in what came while paused', await resumed(), `${await dc.locator('.dc-live').textContent()}; ${JSON.stringify((await rows()).map((r) => r.name))}`)
    check("the prompt's words reach no row", !JSON.stringify(await rows()).includes(PRIVATE))

    // --- Clear empties the list.
    await dc.locator('.dc-clear').click()
    // Only what came before it goes: a status line may arrive just after.
    const cleared = await lib.until(async () => ((await rows()).some((r) => r.name === 'UserPromptSubmit' || r.kind === 'launch') ? null : await rows()), HUNG_MS)
    check('clear empties the list', !!cleared && (await dc.locator('.dc-status').textContent()).includes('(cleared)'), JSON.stringify(cleared))

    // --- Clear while paused: a whole turn held back goes too, resume brings none of it back, and what comes after shows.
    await dc.locator('.dc-pause').click()
    await lib.until(async () => (await dc.locator('.dc-live').textContent()).includes('Paused'), HUNG_MS)
    // The ring's latest event at the pause, not the list's: the list was just cleared, so its rows held almost nothing
    // and every earlier event counted as held, more than the indicator could reach (its wait ran out, HI-2663).
    const ring = () => dc.evaluate((src) => window.combwork.invoke('console:snapshot', src, 0), b1Option)
    const lastShown = Math.max(0, ...(await ring()).map((e) => e.seq))
    await lib.sendPrompt(inv, key, 'edit a.ts', { submitted: async () => /\(\d+ new\)/.test(await dc.locator('.dc-live').textContent()) })
    await lib.agentIdle(inv, b1.id, HUNG_MS)
    const heldTurn = await lib.until(async () => {
      const r = (await ring()).filter((e) => e.seq > lastShown)
      return r.some((e) => e.name === 'Stop') ? r : null
    }, HUNG_MS)
    const waitingNow = async () => Number((await dc.locator('.dc-live').textContent()).match(/\((\d+) new\)/)?.[1] ?? 0)
    await lib.until(async () => (await waitingNow()) >= heldTurn.length, HUNG_MS)
    await dc.locator('.dc-clear').click()
    await lib.until(async () => (await rows()).length === 0 && (await waitingNow()) === 0, HUNG_MS)
    check('clear while paused empties the list and what it held', (await rows()).length === 0 && (await dc.locator('.dc-live').textContent()).trim() === 'Paused', await dc.locator('.dc-live').textContent())
    await dc.locator('.dc-pause').click()
    await lib.sendPrompt(inv, key, 'work 1', { submitted: async () => (await rows()).some((r) => r.name === 'UserPromptSubmit') })
    await row((r) => r.name === 'Stop')
    const heldMax = Math.max(...heldTurn.map((e) => e.seq))
    const afterClear = await rows()
    check('…resume brings none of the cleared turn back; the next turn shows', afterClear.filter((r) => r.name === 'UserPromptSubmit').length === 1 && afterClear.filter((r) => r.name === 'Stop').length === 1 && afterClear.every((r) => r.seq > heldMax), JSON.stringify(afterClear))
    await lib.agentIdle(inv, b1.id, HUNG_MS)

    // --- Recording to a file (#638): redacted by default, text only when ticked for that recording.
    const recordingsDir = path.join(userData, 'console-recordings')
    const readRecording = (name) => fs.readFileSync(path.join(recordingsDir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const recordingText = async () => (await dc.locator('.dc-status .dc-recording').textContent().catch(() => '')) ?? ''
    const bReady = () => lib.agentIdle(inv, b1.id, HUNG_MS)
    /** Records one turn of B1 ("text": with the box ticked), stops, and returns the file's lines and what the bar said. */
    let menuShot = false
    const recordTurn = async (turn, text) => {
      await dc.locator('.dc-record').click()
      if (!menuShot) {
        menuShot = true
        await dc.screenshot({ path: path.join(lib.WORK, 'consolewindow-record.png') })
      }
      const box = dc.locator('.dc-record-menu input[type="checkbox"]')
      const ticked = await box.isChecked()
      if (text) await box.check()
      await dc.locator('.dc-record-start').click()
      await lib.until(async () => /^Recording \d+ events to console-/.test((await recordingText()).trim()), HUNG_MS)
      await lib.sendPrompt(inv, key, turn, { submitted: async () => /^Recording [1-9]\d* events/.test((await recordingText()).trim()) })
      await bReady()
      await lib.until(async () => Number((await recordingText()).match(/Recording (\d+) events/)?.[1] ?? 0) >= 2, HUNG_MS)
      await dc.locator('.dc-record-stop').click()
      const saved = await lib.until(async () => {
        const t = (await recordingText()).trim()
        return /^Saved \d+ events to console-.*\.jsonl/.test(t) ? t : null
      }, HUNG_MS)
      const name = saved?.match(/(console-\S+\.jsonl)/)?.[1]
      return { ticked, saved, lines: name ? readRecording(name) : [] }
    }
    const plain = await recordTurn(`edit a.ts ${SPOKEN}`, false)
    check('Record writes the source to a file, and the bar says where', !!plain.saved && plain.lines.length > 2, String(plain.saved))
    const plainHead = plain.lines[0]
    check("…its header: Combwork's version, the CLIs' installed and tested-with versions, no text", plainHead?.type === 'recording' && plainHead.text === false && plainHead.source?.kind === 'session' && plainHead.clis?.some((c) => c.provider === 'claude-code' && c.version), JSON.stringify(plainHead))
    check('…its events, the prompt among them, and its end', plain.lines.some((l) => l.type === 'event' && l.name === 'UserPromptSubmit') && plain.lines.at(-1)?.type === 'end' && plain.lines.at(-1).reason === 'stopped')
    check('…redacted: the prompt\'s words are not in it', !JSON.stringify(plain.lines).includes(SPOKEN))
    const spoken = await recordTurn(`edit a.ts ${SPOKEN}`, true)
    check('ticking text for a recording keeps the prompt in that one', spoken.lines[0]?.text === true && JSON.stringify(spoken.lines).includes(SPOKEN), JSON.stringify(spoken.lines[0]))
    const again2 = await recordTurn('work 1', false)
    check('…and the box starts unticked for the next one', again2.ticked === false && again2.lines[0]?.text === false && spoken.ticked === false)

    // --- Copy Diagnostics attaches the newest recording only when asked, and only a redacted one.
    const openDiagnostics = async () => {
      await page.locator('.menubar-item', { hasText: 'Help' }).click()
      await page.locator('.menu .menu-item', { hasText: 'Copy Diagnostics' }).click()
      await lib.until(async () => !/Collecting/.test((await page.locator('.diagnostics-preview').textContent().catch(() => 'Collecting')) ?? 'Collecting'), HUNG_MS)
    }
    // The dialog reads its recording row and its preview with two calls (#718): the row can come after the preview, and
    // until it does there is no row (#723). The read is slowed here so it always comes last, and the checks wait for the
    // newest recording's row rather than reading once.
    await app.evaluate(() => {
      process.env.CW_TEST_SLOW_IPC = 'console:recordings=1500'
    })
    await openDiagnostics()
    const offer = page.locator('.diagnostics-recording')
    const offered = await lib.until(async () => ((await offer.locator('input').count()) === 1 ? offer.locator('input') : null), HUNG_MS)
    check('Copy Diagnostics offers the newest recording, unticked', !!offered && !(await offered.isChecked()) && !(await page.locator('.diagnostics-preview').textContent()).includes('Developer console recording'), JSON.stringify(await offer.allTextContents()))
    await offer.locator('input').check()
    const attached = await lib.until(async () => {
      const t = (await page.locator('.diagnostics-preview').textContent()) ?? ''
      return t.includes('### Developer console recording') ? t : null
    }, HUNG_MS)
    await page.screenshot({ path: path.join(lib.WORK, 'consolewindow-diagnostics.png') })
    const section = attached?.slice(attached.indexOf('### Developer console recording')) ?? ''
    check('…ticked, the preview has its newest events', /session source \(claude-code\).*redacted; the newest \d+/.test(section) && section.includes('"name":"Stop"'), section.slice(0, 300))
    check("…with the workspace's folder and the agent's name taken out", !section.toLowerCase().includes(ws.toLowerCase().replace(/\\/g, '\\\\')) && !section.toLowerCase().includes(ws.toLowerCase()) && !section.includes('alpha · B1'), section.slice(0, 600))
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.diagnostics-preview').count()) === 0, HUNG_MS)
    // The newest recording with text: never attached.
    await recordTurn(`edit a.ts ${SPOKEN}`, true)
    await openDiagnostics()
    // Until the slowed read returns there is no row (#723: it was the previous open's offerable one): no checkbox shows
    // at any point before the text row does.
    let staleOffer = 0
    const notOffered = async () => {
      if ((await page.locator('.diagnostics-recording input').count()) > 0) staleOffer++
      return (await page.locator('.diagnostics-recording input').count()) === 0 && /includes prompt and reply text, so it can't be attached/.test((await page.locator('.diagnostics-recording').textContent().catch(() => '')) ?? '')
    }
    check('a recording with text is never offered', !!(await lib.until(notOffered, HUNG_MS)), JSON.stringify(await page.locator('.diagnostics-recording').allTextContents()))
    check("…nor the last open's row while its read is pending (#723)", staleOffer === 0, `a checkbox showed in ${staleOffer} looks`)
    await app.evaluate(() => {
      delete process.env.CW_TEST_SLOW_IPC
    })
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.diagnostics-preview').count()) === 0, HUNG_MS)
    // Picking another source ends a recording, with what it had captured.
    await dc.locator('.dc-record').click()
    await dc.locator('.dc-record-start').click()
    const switched = await lib.until(async () => (await recordingText()).trim().match(/^Recording \d+ events to (console-\S+\.jsonl)/)?.[1] ?? null, HUNG_MS)
    const combworkOption = (await dc.locator('.dc-source option').evaluateAll((els) => els.map((e) => e.value))).find((v) => v.startsWith('combwork:'))
    await dc.locator('.dc-source').selectOption(combworkOption)
    // The file's end line is written before the window hears it ended: wait for both.
    const switchedEnd = await lib.until(async () => {
      const end = readRecording(switched).find((l) => l.type === 'end')
      return end && /^Saved \d+ events/.test((await recordingText()).trim()) ? end : null
    }, HUNG_MS)
    check('picking another source ends the recording', switchedEnd?.reason === 'stopped', `${JSON.stringify(switchedEnd)} · ${await recordingText()}`)
    await dc.locator('.dc-source').selectOption(b1Option)
    await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.capturing, HUNG_MS)

    // --- Size remembered; the shortcut brings the open window forward rather than opening another.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.setSize(900, 600))
    const saved = await lib.until(async () => {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      return c.consoleWindow?.width === 900 ? c.consoleWindow : null
    }, HUNG_MS)
    check('its size is remembered', saved?.height === 600, JSON.stringify(saved))
    await page.keyboard.press('Control+Alt+J')
    await inv('console:open')
    check('…the shortcut and Help open the same window, not another', consoles().length === 1)

    // --- Closing it while a recording's start is still on its way (#638 round 2): nothing records, nothing captures.
    const combworkLog = path.join(userData, 'logs', 'combwork.log')
    const notStarted = () => (fs.readFileSync(combworkLog, 'utf8').match(/recording not started/g) ?? []).length
    const refusedBefore = notStarted()
    const filesBefore = new Set(fs.readdirSync(recordingsDir))
    await app.evaluate(() => {
      process.env.CW_TEST_SLOW_IPC = 'console:record=1500*1'
    })
    await dc.locator('.dc-record').click()
    await dc.locator('.dc-record-start').click()

    // --- Closing it ends capture; it opens again at its size.
    await dc.close()
    // The start, held back until after the close, is refused (Combwork logs it), and makes no recording.
    await lib.until(() => notStarted() > refusedBefore, HUNG_MS)
    const madeSince = fs.readdirSync(recordingsDir).filter((n) => !filesBefore.has(n))
    check('a recording started just as its console closes never records', madeSince.length === 0 && !(await inv('console:recordings')).latest?.recording, JSON.stringify(madeSince))
    await lib.until(async () => (await inv('console:sources')).every((s) => !s.capturing && s.events === 0), HUNG_MS)
    check('closing it ends capture and keeps nothing', (await inv('console:sources')).every((s) => !s.capturing && s.events === 0))
    await page.keyboard.press('Control+Alt+J')
    const again = await lib.until(() => consoles()[0] ?? null, HUNG_MS)
    const size = await lib.until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.getSize() ?? null), HUNG_MS)
    check('the shortcut opens it again, at its remembered size', !!again && size?.[0] === 900 && size[1] === 600, JSON.stringify(size))

    // --- A console belongs to its window's workspace: opening another workspace in that window, or closing it, closes the
    // console and ends its capture, while another window's console carries on.
    await again.locator('.dc-source').selectOption(b1Option)
    await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === b1.id)?.capturing, HUNG_MS)
    // A recording going on when the window leaves its workspace ends with it.
    await again.locator('.dc-record').click()
    await again.locator('.dc-record-start').click()
    const leftRecording = await lib.until(async () => (await again.locator('.dc-status .dc-recording').textContent().catch(() => ''))?.match(/(console-\S+\.jsonl)/)?.[1] ?? null, HUNG_MS)
    const nextWindow = app.waitForEvent('window')
    await inv('window:new')
    const page2 = await nextWindow
    page2.on('pageerror', (e) => check('no page errors (second window)', false, e.message))
    await lib.appReady(page2)
    const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv2, page2, ws2)
    await inv2('console:open')
    // The console showing a workspace's sources, by its folder's name.
    const consoleOn = (name) =>
      lib.until(async () => {
        for (const c of consoles()) {
          const list = await c.evaluate(() => window.combwork.invoke('console:sources')).catch(() => null)
          if (list?.length && list.every((x) => x.workspacePath.toLowerCase().endsWith(name))) return c
        }
        return null
      }, HUNG_MS)
    const dc2 = await consoleOn('consolewindow-ws2')
    const combwork2 = (await inv2('console:sources')).find((x) => x.kind === 'combwork')
    await lib.until(async () => (await dc2.locator('.dc-source option').evaluateAll((els) => els.map((e) => e.value))).includes(combwork2.id), HUNG_MS)
    await dc2.locator('.dc-source').selectOption(combwork2.id)
    const combwork2Live = async () => !!(await inv2('console:sources')).find((x) => x.kind === 'combwork')?.capturing && (await dc2.locator('.dc-live').textContent()).includes('Live')
    await lib.until(combwork2Live, HUNG_MS)
    check("a second window's console watches its own workspace", await combwork2Live())

    await inv('session:stop', alpha, b1.id)
    await lib.until(async () => (await inv('session:live')).find((s) => s.agentId === b1.id)?.status !== 'ready', HUNG_MS)
    await lib.openWorkspace(inv, page, ws3)
    await lib.until(() => !consoles().includes(again), HUNG_MS)
    check('another workspace opened in its window closes its console', !consoles().includes(again))
    const leftEnd = await lib.until(() => readRecording(leftRecording).find((l) => l.type === 'end') ?? null, HUNG_MS)
    check('…ending its recording', ['closed', 'workspace'].includes(leftEnd?.reason), JSON.stringify(leftEnd))
    check("…and the other window's console carries on", consoles().includes(dc2) && (await combwork2Live()))
    await inv('console:open')
    const dc3 = await consoleOn('consolewindow-ws3')
    const ws3Sources = await dc3.evaluate(() => window.combwork.invoke('console:sources'))
    check('opened again, it shows the new workspace only', ws3Sources.every((x) => x.workspacePath.toLowerCase().endsWith('consolewindow-ws3')), JSON.stringify(ws3Sources.map((x) => x.id)))
    const oldWatch = await dc3.evaluate((id) => window.combwork.invoke('console:subscribe', [id]), b1Option)
    const oldRead = await dc3.evaluate((id) => window.combwork.invoke('console:snapshot', id, 0), b1Option)
    check("…and can't watch or read the old workspace's sources", JSON.stringify(oldWatch) === '{}' && oldRead.length === 0, `${JSON.stringify(oldWatch)} ${oldRead.length}`)
    const combwork3 = ws3Sources.find((x) => x.kind === 'combwork')
    await dc3.locator('.dc-source').selectOption(combwork3.id)
    await lib.until(async () => (await inv('console:sources')).find((x) => x.kind === 'combwork')?.capturing, HUNG_MS)
    await inv('workspace:close')
    await lib.until(() => !consoles().includes(dc3), HUNG_MS)
    check('closing the workspace closes its console', !consoles().includes(dc3))
    check("…the other window's still carrying on", await combwork2Live())
    await lib.openWorkspace(inv, page, ws)
    const back = await inv('console:sources')
    check('back in the first workspace, nothing of the old watch is captured or kept', back.length > 0 && back.every((x) => !x.capturing && x.events === 0), JSON.stringify(back))
    // The window closes under its own call: its answer never comes.
    await inv2('window:close').catch(() => undefined)
    await lib.until(() => !consoles().includes(dc2), HUNG_MS)
    check('a console closes with its window', !consoles().includes(dc2))

    // --- Opening on a display smaller than its saved bounds (saved on a larger display: #862), it fits that display
    // rather than running off its edge. The display is a stand-in (Electron's screen, answering for a 1000 x 640 one,
    // as tabstrip's #812 check does); its bounds are saved larger than that first.
    const consoleSize = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.getSize() ?? null)
    await inv('console:open')
    const large = await lib.until(() => consoles()[0] ?? null, HUNG_MS)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith('Developer Console'))?.setSize(1600, 900))
    const savedLarge = await lib.until(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).consoleWindow?.width === 1600, HUNG_MS)
    check('its larger size is saved', !!savedLarge, JSON.stringify(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).consoleWindow))
    await large.close()
    await lib.until(() => consoles().length === 0, HUNG_MS)
    const SMALL = { x: 0, y: 0, width: 1000, height: 640 }
    await app.evaluate(({ screen }, area) => {
      const display = { ...screen.getPrimaryDisplay(), bounds: area, workArea: area }
      screen.getPrimaryDisplay = () => display
      screen.getAllDisplays = () => [display]
      screen.getDisplayNearestPoint = () => display
    }, SMALL)
    await inv('console:open')
    const fitted = await lib.until(async () => (consoles().length === 1 ? await consoleSize() : null), HUNG_MS)
    check('opened on a display smaller than its saved bounds, it fits that display', !!fitted && fitted[0] <= SMALL.width && fitted[1] <= SMALL.height, JSON.stringify(fitted))

    // --- Turning the setting off closes it and hides it again.
    await inv('console:open')
    await lib.until(() => consoles().length === 1, HUNG_MS)
    await inv('settings:update', { advanced: { showDeveloperFeatures: false } })
    await lib.until(() => consoles().length === 0, HUNG_MS)
    check('turning developer features off closes the console', consoles().length === 0)
    check('…and hides it from Help again', !(await helpItems()).includes('Developer Console'))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
    await app.windows()[0]?.screenshot({ path: path.join(lib.WORK, 'consolewindow-failed.png') }).catch(() => undefined)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
