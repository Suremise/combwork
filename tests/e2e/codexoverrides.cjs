// Codex's Advanced switches from #1167, live against the real Codex in its test home (codex-home.cjs, signed in).
// 1. Right-click in a Codex pane (Codex tracks the mouse since 0.163, ?1003h) is Combwork's by default: over Combwork's own
//    selection (Shift+drag) it copies it, clears it and pastes nothing; with nothing selected it pastes once (the button
//    never reaches Codex, which would paste too). Settings → Advanced → Pass right-click to Codex turns that off at once,
//    with the agent running: Combwork then neither copies nor pastes, and back off it is Combwork's again.
// 2. Set Codex's terminal title (on by default): Codex is started with -c tui.terminal_title=[…] and Combwork reads "Action
//    Required" from the title to show the agent waiting on an approval. Off (for sessions started afterwards): the flag is
//    left out and the hooks (PermissionRequest) tell Combwork instead. One tiny prompt each that needs an approval in
//    Read only, approved in the terminal; each status the agent showed, with when, goes to codexoverrides.json.
// 3. Claude Code's pane (the fake Claude Code, which like Claude Code 2.1.305 tracks no mouse): Pass right-click to
//    Claude Code turns Combwork's copy/paste off and back at once; passed, a right-click sends nothing and Combwork does nothing.
// The clipboard is stubbed in the page, and no CLI ever gets a mouse button: while right-click is passed, the pane's
// mouse reports are held back (__hiveHoldMouseReports, test builds), never the machine's clipboard. gpt-6-luna at low effort.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const scratch = lib.WORK
const userData = path.join(scratch, 'cxover-profile')
const ws = path.join(scratch, 'cxover-ws')
const proj = path.join(ws, 'demo')
const small = { provider: 'codex', model: 'gpt-6-luna', effort: 'low' }
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 15000
const READY_MS = 90000
const TURN_MS = 180000
// How long Combwork may take to show the agent waiting once Codex's approval is on its screen (a hook or the title follows
// the screen): a bound for a hung run.
const WAITING_MS = 30000
const TEXT = 'SELECTME alpha beta gamma delta'
const TITLE_ID = 'codex.override.terminalTitle'
const RIGHT_ID = 'codex.mouse.rightClickToCli'
const CLAUDE_RIGHT_ID = 'claude-code.mouse.rightClickToCli'
// Codex's approval of a shell command (0.163): "Would you like to run the following command?", "1. Yes, proceed (y)".
const APPROVAL = /Would you like to run the following command|Yes, proceed/
const record = { rightClick: {}, titleOn: null, titleOff: null }
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

function prepare() {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(proj)
  lib.trustForCodex(proj)
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
}

/** The command line of the codex.exe a launch started (its hooks name its run id), or null. */
function codexCommandLine(runId) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', env: lib.baseEnv() })
  return out.split(/\r?\n/).find((l) => l.includes(`run=${runId}`)) ?? null
}

;(async () => {
  prepare()
  // The fake Claude Code for part 3 (its folder trusted, so it asks nothing).
  const claudeEnv = lib.fakeClaude(userData, path.join(scratch, 'cxover-claude-home'), [proj])
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47839), CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases(), ...claudeEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], env })
  let page
  let inv
  let def
  let claudeDef
  const live = async () => (await inv('session:live')).find((l) => l.agentId === def.id)
  const status = async () => (await live())?.status
  const stop = async () => {
    await inv('session:stop', proj, def.id).catch(() => {})
    return lib.until(async () => !(await live()), 30000, 200)
  }
  try {
    page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1400, height: 850 })
    await lib.appReady(page)
    inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    // The clipboard, stubbed (as copilotcopy): what Combwork wrote, what a read gives (__clip) and how often Combwork read it.
    await page.evaluate(() => {
      window.__copied = []
      window.__reads = 0
      window.__clip = ''
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => (window.__reads++, window.__clip), writeText: async (t) => void window.__copied.push(t) } })
    })
    const copied = () => page.evaluate(() => window.__copied)
    const reads = () => page.evaluate(() => window.__reads)
    const setClip = (t) => page.evaluate((x) => (window.__clip = x), t)

    const info = await lib.until(async () => { const i = (await inv('provider:info')).codex; return i && !i.checking ? i : null }, 60000, 500)
    check('Codex found and signed in', !!info?.found && info.loggedIn === true, JSON.stringify(info && { found: info.found, loggedIn: info.loggedIn }))
    console.log(`Codex ${info?.version ?? '?'} in ${lib.CODEX_HOME}`)
    record.codexVersion = info?.version ?? null

    await lib.openWorkspace(inv, page, ws)
    def = await lib.addAgent(inv, proj, { name: 'Codex', ...small, permissionMode: 'read-only' })
    await page.getByText('demo', { exact: true }).first().click()
    const key = lib.ptyKey(proj, def.id)
    // What the terminal shows now (the pty's history keeps text since rubbed out).
    const onScreen = async () => ((await page.evaluate((k) => window.__hiveTerminalLines(k), key)) ?? []).join('\n')
    const textAt = (text) => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [key, text])
    const hiveSelection = () => page.evaluate((k) => window.__hiveTerminalSelection(k), key)
    const mouse = () => page.evaluate((k) => window.__hiveTerminalState(k)?.mouse, key)
    const rightClickGoesTo = () => page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.getAttribute('data-right-click'), key)
    const lineWith = async (text) => (await onScreen()).split('\n').find((l) => l.includes(text)) ?? null
    const startReady = async (label) => {
      await inv('session:start', proj, { agentId: def.id })
      const ready = await lib.until(async () => { const l = await live(); return ['ready', 'waiting'].includes(l?.status) ? l : null }, READY_MS, 300)
      check(`${label}: Codex reaches its prompt (ready)`, ready?.status === 'ready', JSON.stringify(ready && { status: ready.status, msg: ready.statusMessage }))
      return ready?.status === 'ready' ? ready : null
    }

    // ---- 1. Right-click, Combwork's (the default): no prompt is sent, so no tokens.
    const r1 = await startReady('right-click')
    if (r1) {
      check('Codex tracks the mouse (any motion)', !!(await lib.until(async () => (await mouse()) === 'any', HUNG_MS, 100)), await mouse())
      check("right-click is Combwork's by default", (await rightClickGoesTo()) === 'hive', await rightClickGoesTo())
      // Text to select: typed into Codex's input, never sent.
      await inv('pty:write', key, TEXT)
      const at = await lib.until(async () => {
        const [s, al, d] = [await textAt(TEXT), await textAt('alpha beta'), await textAt('delta')]
        return s && al && d && s.y === d.y ? { s, d, w: (al.x - s.x) / 9 } : null
      }, HUNG_MS, 200)
      check('the typed text is in Codex’s input', !!at, JSON.stringify(at))
      const drag = async (shift) => {
        await page.mouse.move(at.s.x - at.w / 2 + 1, at.s.y)
        if (shift) await page.keyboard.down('Shift')
        await page.mouse.down()
        for (let i = 1; i <= 8; i++) await page.mouse.move(at.s.x + ((at.d.x + 6 * at.w - at.s.x) * i) / 8, at.s.y)
        await page.mouse.up()
        if (shift) await page.keyboard.up('Shift')
      }
      const rightClick = () => page.mouse.click(at.s.x + at.w, at.s.y, { button: 'right' })
      const pid = r1.pid
      const runId = r1.runId

      // Shift+drag: Combwork's selection; right-click copies it, clears it and pastes nothing; Codex isn't interrupted.
      const n = (await copied()).length
      const r0 = await reads()
      await drag(true)
      const selected = await lib.until(async () => ((await hiveSelection())?.includes(TEXT) ? await hiveSelection() : null), HUNG_MS, 100)
      check("Shift+drag makes Combwork's selection", !!selected, JSON.stringify(await hiveSelection()))
      // Moving to right-click keeps it (Combwork doesn't report moves over a mouse-tracking program while there is one).
      await page.mouse.move(at.s.x + at.w, at.s.y + at.w)
      await page.mouse.move(at.s.x + at.w, at.s.y)
      check('…and moving the mouse keeps it', (await hiveSelection())?.includes(TEXT), JSON.stringify(await hiveSelection()))
      await page.screenshot({ path: path.join(scratch, 'codexoverrides-1-selected.png') })
      await rightClick()
      const got = await lib.until(async () => ((await copied()).length > n ? await copied() : null), HUNG_MS, 100)
      check('right-click copies the selection (the stubbed clipboard gets it)', !!got && got[n].includes(TEXT), JSON.stringify(got))
      check('…clears it, and pastes nothing (no clipboard read)', (await hiveSelection()) === '' && (await reads()) === r0, `${JSON.stringify(await hiveSelection())}, ${(await reads()) - r0} read(s)`)
      check('…and the input is as it was (nothing pasted into Codex)', (await lineWith(TEXT))?.split('SELECTME').length === 2 && !(await onScreen()).includes(`${TEXT}${TEXT}`), JSON.stringify(await lineWith(TEXT)))
      const after1 = await live()
      check('…without interrupting Codex (still ready, the same process)', after1?.status === 'ready' && after1.pid === pid && after1.runId === runId, JSON.stringify(after1 && { status: after1.status, pid: after1.pid }))
      record.rightClick.copy = { copied: got?.[n] ?? null, reads: (await reads()) - r0 }

      // Nothing selected: right-click pastes, once (Combwork reads the clipboard once; Codex never gets the button).
      const before = await lineWith(TEXT)
      await setClip('PASTEONCE')
      const r2 = await reads()
      await rightClick()
      const shown = await lib.until(async () => ((await onScreen()).includes('PASTEONCE') ? await onScreen() : null), HUNG_MS, 100)
      check('right-click with nothing selected pastes', !!shown && (await reads()) === r2 + 1, `${(await reads()) - r2} read(s)`)
      const pasted = await lineWith('PASTEONCE')
      check('…once: the input is what it was with the text once, nothing else', !!shown && shown.split('PASTEONCE').length === 2 && pasted?.replace('PASTEONCE', '').trimEnd() === before?.trimEnd(), JSON.stringify({ before, pasted }))
      check('…without interrupting Codex', (await status()) === 'ready' && (await live())?.pid === pid, await status())
      await page.screenshot({ path: path.join(scratch, 'codexoverrides-2-pasted.png') })
      record.rightClick.paste = { reads: (await reads()) - r2, line: pasted }
      await inv('pty:write', key, '\x15')
      check('…and the input is cleared again', !!(await lib.until(async () => !(await onScreen()).includes('SELECTME'), HUNG_MS, 100)), await lineWith('SELECTME'))
      await setClip('')

      // Pass right-click to Codex, with the agent running: at once, no restart. The pane's mouse reports are held back
      // meanwhile (__hiveHoldMouseReports) and never reach Codex, whose own paste would read the machine's clipboard: the
      // test sees the button's reports Combwork would have sent, and that Combwork itself neither copies nor pastes.
      const hold = (on) => page.evaluate(([k, h]) => window.__hiveHoldMouseReports(k, h), [key, on])
      const holding = Array.isArray(await hold(true))
      check('the pane holds its mouse reports back (a test build)', holding)
      if (holding) {
        try {
          await inv('advanced:set', RIGHT_ID, true)
          check('Pass right-click to Codex: right-click goes to Codex at once', !!(await lib.until(async () => (await rightClickGoesTo()) === 'cli', HUNG_MS, 100)), await rightClickGoesTo())
          const same = await live()
          check('…without a restart (the same Codex process and launch)', same?.pid === pid && same.runId === runId && same.status === 'ready', JSON.stringify(same && { status: same.status, pid: same.pid }))
          await page.screenshot({ path: path.join(scratch, 'codexoverrides-3-passed.png') })
          const n3 = (await copied()).length
          const r3 = await reads()
          await drag(true)
          await rightClick()
          // A right button's press and release, as xterm encodes them for Codex's SGR tracking (?1006h): ESC [ < 2 ; x ; y M, then m.
          const reports = await lib.until(async () => { const h = await hold(true); return h.some((r) => /\x1b\[<2;\d+;\d+M/.test(r)) && h.some((r) => /\x1b\[<2;\d+;\d+m/.test(r)) ? h : null }, HUNG_MS, 100)
          check('…a right-click then goes to Codex: its press and release, as mouse reports', !!reports, JSON.stringify(await hold(true)))
          check("…and Combwork neither copies nor pastes (no clipboard write or read by Combwork)", (await copied()).length === n3 && (await reads()) === r3, `${(await copied()).length - n3} write(s), ${(await reads()) - r3} read(s)`)
          check('…and Codex keeps running (the same process)', !!(await live()) && (await live()).pid === pid, JSON.stringify(await live().then((l) => l && { status: l.status, pid: l.pid })))
          record.rightClick.passedToCodex = { hiveWrites: (await copied()).length - n3, hiveReads: (await reads()) - r3, rightButtonReports: (reports ?? []).filter((r) => /\x1b\[<2;/.test(r)).length }
        } finally {
          await hold(false)
        }
      }

      // Off again: Combwork's again, at once.
      await inv('advanced:set', RIGHT_ID, false)
      check("off again: right-click is Combwork's at once", !!(await lib.until(async () => (await rightClickGoesTo()) === 'hive', HUNG_MS, 100)), await rightClickGoesTo())
      await setClip('BACKAGAIN')
      const r4 = await reads()
      await rightClick()
      const back = await lib.until(async () => ((await onScreen()).includes('BACKAGAIN') ? await onScreen() : null), HUNG_MS, 100)
      check('…and a right-click pastes once again (one read)', !!back && back.split('BACKAGAIN').length === 2 && (await reads()) === r4 + 1, `${(await reads()) - r4} read(s)`)
      check('…still the same Codex process', (await live())?.pid === pid, JSON.stringify(await live().then((l) => l && { pid: l.pid })))
      await inv('pty:write', key, '\x15')
      await setClip('')
    }
    check('right-click: the session stops', !!(await stop()))

    // ---- 2. The terminal title, on and off: one prompt each that needs an approval (Read only).
    const sources = await lib.until(async () => { const l = await inv('console:sources'); return l.some((s) => s.agentId === def.id) ? l : null }, HUNG_MS, 200)
    const source = sources?.find((s) => s.agentId === def.id)?.id
    check("the agent is a developer console source (its hooks and title events, for the record)", !!source)
    const titleRun = async (on) => {
      const label = `title ${on ? 'on' : 'off'}`
      const out = { setting: on, commandHasTitle: null, timeline: [], approvalShownAt: null, waitingAt: null, waitingMessage: null, finishedAt: null, events: [] }
      if (source) await inv('console:subscribe', [source])
      const seqBefore = source ? Math.max(0, ...(await inv('console:snapshot', source, 0)).map((e) => e.seq)) : 0
      const ready = await startReady(label)
      if (!ready) return out
      const cmd = await lib.until(() => codexCommandLine(ready.runId), HUNG_MS, 500)
      out.commandHasTitle = cmd ? cmd.includes('tui.terminal_title') : null
      check(`${label}: Codex's command line ${on ? 'has' : 'has no'} -c tui.terminal_title`, !!cmd && out.commandHasTitle === on, cmd ? `has it: ${out.commandHasTitle}` : 'no codex.exe with its run id')
      await page.screenshot({ path: path.join(scratch, `codexoverrides-${on ? 5 : 7}-title-${on ? 'on' : 'off'}-ready.png`) })
      await lib.cliStep(`${label}: the approval turn`, { session: key }, async () => {
        const t0 = Date.now()
        let last = 'ready'
        const note = (s, msg) => {
          if (s === last) return
          last = s
          out.timeline.push({ ms: Date.now() - t0, status: s, message: msg ?? null })
        }
        // Every status until Codex's approval is on screen and Combwork has shown the agent waiting (or the bound after it).
        const untilAsked = () => lib.until(async () => {
          const l = await live()
          note(l?.status, l?.statusMessage)
          if (l?.status === 'waiting' && out.waitingAt === null) [out.waitingAt, out.waitingMessage] = [Date.now() - t0, l.statusMessage ?? null]
          if (out.approvalShownAt === null && APPROVAL.test(await onScreen())) out.approvalShownAt = Date.now() - t0
          if (out.approvalShownAt !== null && out.waitingAt !== null) return true
          if (out.approvalShownAt !== null && Date.now() - t0 - out.approvalShownAt > WAITING_MS) return 'not waiting'
          return l?.status === 'finished' ? 'finished without asking' : null
        }, TURN_MS, 250)
        const taken = async () => ['working', 'waiting', 'finished'].includes(await status())
        // Whether to ask is the model's (on-request): it is told to, and once more if it ran the command in the sandbox
        // without asking (it fails there, Read only), which is the model's choice, not Combwork's.
        const sent = await lib.sendPrompt(inv, key, 'Run this shell command with escalated permissions, requesting my approval: Set-Content approved.txt hi', { submitted: taken })
        check(`${label}: the prompt is taken (working)`, sent > 0, await status())
        let asked = await untilAsked()
        out.attempts = 1
        if (asked === 'finished without asking') {
          out.attempts = 2
          last = 'finished'
          await lib.sendPrompt(inv, key, 'It failed in the sandbox. Run it again with escalated permissions (sandbox_permissions require_escalated), so I can approve it.', { submitted: async () => ['working', 'waiting'].includes(await status()) })
          asked = await untilAsked()
        }
        await page.screenshot({ path: path.join(scratch, `codexoverrides-${on ? 5 : 7}-title-${on ? 'on' : 'off'}-asked.png`) })
        fs.writeFileSync(path.join(scratch, `codexoverrides-title-${on ? 'on' : 'off'}-asked.txt`), await onScreen())
        check(`${label}: Codex asks for an approval`, out.approvalShownAt !== null, `${asked}; ${(await onScreen()).replace(/\s+/g, ' ').slice(-400)}`)
        check(`${label}: Combwork shows the agent waiting while Codex asks`, out.waitingAt !== null, `${asked}; timeline ${JSON.stringify(out.timeline)}`)
        if (out.approvalShownAt === null) return
        // Approve it in the terminal (Yes, proceed): the command runs and the turn ends.
        await inv('pty:write', key, 'y')
        const done = await lib.until(async () => {
          const l = await live()
          note(l?.status, l?.statusMessage)
          return l?.status === 'finished'
        }, TURN_MS, 250)
        out.finishedAt = done ? Date.now() - t0 : null
        check(`${label}: approved, the turn finishes`, !!done, JSON.stringify(out.timeline))
        check(`${label}: …and the command ran`, fs.existsSync(path.join(proj, 'approved.txt')))
        check(`${label}: waiting ended with the answer (working or finished after it)`, out.timeline.findIndex((t) => t.status === 'waiting') < out.timeline.findLastIndex((t) => t.status === 'finished'), JSON.stringify(out.timeline))
      })
      await page.screenshot({ path: path.join(scratch, `codexoverrides-${on ? 6 : 8}-title-${on ? 'on' : 'off'}-finished.png`) })
      if (source) {
        // What reached Combwork meanwhile (hooks, title reads) with when: names and Combwork's summaries only.
        out.events = (await inv('console:snapshot', source, seqBefore)).filter((e) => e.kind === 'hook' || e.kind === 'terminal' || e.kind === 'launch').map((e) => ({ at: e.at, kind: e.kind, name: e.name, summary: e.summary }))
      }
      fs.rmSync(path.join(proj, 'approved.txt'), { force: true })
      check(`${label}: the session stops`, !!(await stop()))
      return out
    }
    record.titleOn = await titleRun(true)
    const set = await inv('advanced:set', TITLE_ID, false)
    check("Set Codex's terminal title: off", !!set)
    record.titleOff = await titleRun(false)
    await inv('advanced:set', TITLE_ID, true)
    if (source) await inv('console:subscribe', [])

    // ---- 3. Claude Code's pane: the fake Claude Code, tracking no mouse (as Claude Code 2.1.305 at its prompt).
    claudeDef = await lib.addAgent(inv, proj, { name: 'Claude', provider: 'claude-code' })
    const ckey = lib.ptyKey(proj, claudeDef.id)
    await inv('session:start', proj, { agentId: claudeDef.id })
    const claudeLive = async () => (await inv('session:live')).find((l) => l.agentId === claudeDef.id)
    const cready = await lib.until(async () => ((await claudeLive())?.status === 'ready' ? await claudeLive() : null), READY_MS, 300)
    check('Claude Code (fake): ready', !!cready, JSON.stringify(await claudeLive().then((l) => l && { status: l.status })))
    if (cready) {
      await lib.showAgent(page, 'Claude')
      const cGoesTo = () => page.evaluate((k) => document.querySelector(`.terminal-host[data-pty="${CSS.escape(k)}"]`)?.getAttribute('data-right-click'), ckey)
      const cmouse = () => page.evaluate((k) => window.__hiveTerminalState(k)?.mouse, ckey)
      check('Claude Code tracks no mouse', (await cmouse()) === 'none', await cmouse())
      check("right-click is Combwork's by default", (await cGoesTo()) === 'hive', await cGoesTo())
      const pt = await lib.until(() => page.evaluate(([k, t]) => window.__hiveTerminalTextAt(k, t), [ckey, '? for shortcuts']), HUNG_MS, 200)
      check('its prompt is on screen', !!pt)
      const cRightClick = () => page.mouse.click(pt.x, pt.y, { button: 'right' })
      // Combwork's: with nothing selected, a right-click pastes (one read of the stubbed clipboard).
      await setClip('CLAUDEPASTE')
      const c0 = await reads()
      await cRightClick()
      check("…a right-click pastes (Combwork's: one read)", !!(await lib.until(async () => (await reads()) === c0 + 1, HUNG_MS, 100)), `${(await reads()) - c0} read(s)`)
      await inv('pty:write', ckey, '\x15')
      // Passed to Claude Code: Combwork neither copies nor pastes, and nothing goes to it (it asked for no mouse reports).
      const chold = (on) => page.evaluate(([k, h]) => window.__hiveHoldMouseReports(k, h), [ckey, on])
      if (Array.isArray(await chold(true))) {
        try {
          await inv('advanced:set', CLAUDE_RIGHT_ID, true)
          check('Pass right-click to Claude Code: right-click goes to Claude Code at once', !!(await lib.until(async () => (await cGoesTo()) === 'cli', HUNG_MS, 100)), await cGoesTo())
          const [n5, r5] = [(await copied()).length, await reads()]
          await cRightClick()
          // Settled once the page has run the click's handlers: the next evaluation runs after them.
          check('…a right-click then: Combwork neither copies nor pastes', (await copied()).length === n5 && (await reads()) === r5, `${(await copied()).length - n5} write(s), ${(await reads()) - r5} read(s)`)
          check('…and sends Claude Code no mouse report (it tracks none)', (await chold(true)).length === 0, JSON.stringify(await chold(true)))
          check('…and Claude Code keeps running', (await claudeLive())?.pid === cready.pid, JSON.stringify(await claudeLive().then((l) => l && { status: l.status })))
          await page.screenshot({ path: path.join(scratch, 'codexoverrides-9-claude-passed.png') })
        } finally {
          await chold(false)
        }
        await inv('advanced:set', CLAUDE_RIGHT_ID, false)
        check("off again: Claude Code's right-click is Combwork's at once", !!(await lib.until(async () => (await cGoesTo()) === 'hive', HUNG_MS, 100)), await cGoesTo())
      } else check('the pane holds its mouse reports back (a test build)', false)
      await setClip('')
    }
  } finally {
    fs.writeFileSync(path.join(scratch, 'codexoverrides.json'), JSON.stringify(record, null, 2))
    if (def) await stop().catch(() => {})
    if (claudeDef) await inv('session:stop', proj, claudeDef.id).catch(() => {})
    await app.close().catch(() => {})
  }
  console.log(`INFO title on: ${JSON.stringify(record.titleOn && { approval: record.titleOn.approvalShownAt, waiting: record.titleOn.waitingAt, finished: record.titleOn.finishedAt, timeline: record.titleOn.timeline })}`)
  console.log(`INFO title off: ${JSON.stringify(record.titleOff && { approval: record.titleOff.approvalShownAt, waiting: record.titleOff.waitingAt, finished: record.titleOff.finishedAt, timeline: record.titleOff.timeline })}`)
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  console.log('FAIL the suite threw')
  process.exit(1)
})
