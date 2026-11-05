// A message's doorbell typed into a real Codex or Copilot that is busy for a moment (#600), as wakepaste does for Claude
// Code (#597): the suites wakepaste-codex and wakepaste-copilot run this. The CLI's processes are suspended while Combwork
// types the doorbell, so the line and its Enter reach it in one read when it reads its input again. Typed so, Codex
// dropped that Enter (its paste-burst handling) and Copilot didn't send the line on it either; Combwork pressed Enter again
// 10 s later. Now Copilot gets the line as a bracketed paste and Combwork presses Codex's Enter once Codex has drawn the line:
// each doorbell is taken at its first Enter, with no Enter again, also when the CLI reads its input as usual.
// A busy round resumes the CLI only once Combwork's log shows the whole line written (Copilot: its Enter too; Codex: Combwork
// waiting for it to be drawn), so the round always tests input read in one go; Codex's wait to be drawn is set long
// (Settings → Advanced) so that it can't end while the CLI is suspended. Processes are suspended and resumed only as
// the processes they were when listed (folderProcesses.suspensions), never by a pid alone. Last, a doorbell put off
// part-way (HI-1974): held before its Enter in a narrow pane while idle wakes are turned off, it is taken back
// whole, and the next one goes alone.
// Codex: the signed-in test home (a few short turns, low effort). Copilot: offline against the stand-in model (no cost).
// Dev build, throwaway profile and workspace.
const lib = require('../lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { processes, descendantsIn, suspensions } = require('../folderProcesses.cjs')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('../fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000
/** How long the CLI stays suspended once Combwork has written the line: input it then reads in one go. */
const PAUSES = [0, 1500, 3000]

module.exports = async function run(provider) {
  const name = `wakepaste-${provider}`
  const userData = path.join(lib.WORK, `${name}-profile`)
  const ws = path.join(lib.WORK, `${name}-ws`)
  const proj = path.join(ws, 'alpha')
  const cliDir = path.join(lib.WORK, `${name}-cli`)
  // While it is there, a line Combwork typed waits before its Enter (HI-1974's round).
  const hold = path.join(lib.WORK, `${name}-hold`)
  // The Assistant (the fake Claude Code), whose token leaves the messages: only the Assistant may, through the API.
  const claudeHome = path.join(lib.WORK, `${name}-claude-home`)
  const PORT = Number(lib.port(47962))
  let failed = 0
  const check = (what, ok, extra = '') => {
    lib.checked(ok)
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !extra ? '' : ` (${extra})`}`)
  }
  if (provider === 'copilot' && !copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, cliDir, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  lib.gitProject(proj, { 'README.md': '# alpha\n' })
  lib.enableProviders(userData, ['claude-code', provider])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, '..', 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true, port: PORT, provideHiveMcp: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  // Codex: a wait to be drawn longer than any suspension here (Settings → Advanced, Codex → Typed line: wait to be drawn).
  if (provider === 'codex') fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'codex.prompt.drawnSeconds': 60 } }, null, 2))

  let api = null
  let cliEnv
  if (provider === 'codex') {
    lib.trustForCodex(proj, lib.CODEX_HOME)
    cliEnv = { CODEX_HOME: lib.CODEX_HOME, PATH: lib.pathWithoutStoreAliases() }
  } else {
    api = await startFakeCopilotApi({ log: path.join(cliDir, 'api.jsonl') })
    cliEnv = copilotTestEnv(api, cliDir, { above: lib.WORK })
  }
  fs.rmSync(hold, { force: true })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off', HIVE_TEST_HOLD_TYPED: hold, CLAUDE_CONFIG_DIR: claudeHome, ...cliEnv })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  // The CLI's processes this suite has suspended and not resumed yet, each by the identity it was suspended as: the one
  // list every resume goes by, the rounds' and cleanup's alike (folderProcesses.suspensions).
  const paused = suspensions()
  try {
    await lib.fitWindow(app, page, { width: 1400, height: 900 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    await lib.openWorkspace(inv, page, ws)
    const home = (await inv('workspace:refresh')).assistant.path
    const liveIn = async (p, agentId) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === p.toLowerCase() && s.agentId === agentId)
    await inv('session:start', home, { agentId: 'assistant' })
    // The fake asks to trust its folder first, as Claude Code does.
    await lib.until(async () => (await liveIn(home, 'assistant'))?.status === 'waiting', HUNG_MS, 300)
    await inv('pty:write', lib.ptyKey(home, 'assistant'), '\r')
    check('the Assistant starts', !!(await lib.until(async () => (await liveIn(home, 'assistant'))?.status === 'ready', HUNG_MS, 300)))
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token
    const callApi = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const def = await lib.addAgent(inv, proj, { name: 'Tester', provider, location: 'project', ...(provider === 'codex' ? { model: 'gpt-6-luna', effort: 'low' } : {}) })
    const id = def.id
    const live = async () => (await inv('session:live')).find((s) => s.agentId === id)
    const idle = async () => ['ready', 'finished'].includes((await live())?.status)
    const hiveLog = () => {
      const f = path.join(userData, 'logs', 'hive.log')
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    }
    /** Combwork's log lines about lines typed into the agent (its wakes' and doorbells' outcomes). */
    const wakeLines = () => hiveLog().split('\n').filter((l) => l.includes(id) && /\[watches\] (Woke|The wake typed into)/.test(l))
    /** The CLI's processes in this Combwork's tree (by their command lines), each { pid, started }: what a busy round suspends. */
    const cliProcesses = () => {
      const list = processes()
      const mine = descendantsIn(list, app.process().pid).map((d) => list.find((p) => p.pid === d.pid && p.started === d.started)).filter(Boolean)
      const roots = mine.filter((p) => new RegExp(`[\\\\/]${provider}(\\.exe)?"?(\\s|$)`, 'i').test(p.commandLine))
      const ids = new Map()
      for (const r of roots) for (const t of [{ pid: r.pid, started: r.started }, ...descendantsIn(list, r.pid)]) ids.set(t.pid, t)
      return [...ids.values()]
    }
    /** What the agent's pane shows now (its terminal's lines, as drawn). */
    const screen = async (key) => ((await page.evaluate((k) => window.__hiveTerminalLines(k), key)) ?? []).join('\n')
    const paneCols = async (key) => (await page.evaluate((k) => window.__hiveTerminalState(k), key))?.cols
    /**
     * The doorbells on its screen, each by its id, however its rows were wrapped: by its "(m4). Call cw_inbox" with
     * whitespace dropped, and up to a few non-letters between "Call" and "cw_inbox", as the CLI can draw in a doorbell's
     * first row where it wraps (HI-2387: Copilot's time and its border, "(m4). Call   19:34 ┃" / "cw_inbox …").
     */
    const doorbellIds = async (key) => [...(await screen(key)).replace(/\s+/g, '').matchAll(/\((m\d+)\)\.Call[^A-Za-z]{0,16}cw_inbox/g)].map((x) => x[1])
    /** How many doorbells its screen shows for a message (`delivery`: one of them). */
    const copies = async (key, delivery) => (await doorbellIds(key)).filter((x) => x === delivery).length
    /** Combwork has written the whole line into the agent: its Enter too (Woke), or, for Codex, waiting for it to be drawn. */
    const written = (from) => hiveLog().split('\n').slice(from).some((l) => (l.includes(id) && /\[watches\] Woke /.test(l)) || /the line Hive typed is in; Enter once it shows/.test(l))

    await inv('session:start', proj, { agentId: id })
    await lib.cliStep(`${provider} starts`, { session: lib.ptyKey(proj, id) }, async () => {
      // Copilot asks whether to trust the folder first (Codex's test home trusts it already).
      if (provider === 'copilot' && (await lib.until(async () => /Do you trust the files in this folder/.test(lib.plainText(await inv('pty:buffer', lib.ptyKey(proj, id)).catch(() => ''))), HUNG_MS, 300))) await inv('pty:write', lib.ptyKey(proj, id), '\r')
      check(`${provider} starts and is ready`, !!(await lib.until(idle, HUNG_MS, 300)), JSON.stringify(await live()))
      // Combwork types nothing into it until its CLI has connected Combwork's tools (#865: a second or two after it is ready).
      check(`${provider} connects Combwork's tools`, !!(await lib.until(() => hiveLog().split('\n').some((l) => l.includes(id) && l.includes('hive tools connected')), HUNG_MS, 300)))
    })

    for (const [i, pause] of PAUSES.entries()) {
      const what = pause ? `busy for ${pause} ms` : 'reading its input as usual'
      await lib.cliStep(`a doorbell, ${what}`, { session: lib.ptyKey(proj, id) }, async () => {
        check(`${what}: the agent is idle first`, !!(await lib.until(idle, HUNG_MS, 300)), JSON.stringify(await live()))
        const lines = wakeLines().length
        const logLines = hiveLog().split('\n').length - 1
        if (pause) {
          const procs = cliProcesses()
          check(`${what}: its CLI's processes are found`, procs.length > 0)
          const s = paused.suspend(procs)
          check(`${what}: its CLI is suspended (every process of it)`, procs.length > 0 && s.done.length === procs.length, JSON.stringify(s.failed))
          // Not all of it suspended, the round wouldn't test what it says: it stops here (cleanup resumes what was).
          if (!procs.length || s.failed.length) throw new Error(`${what}: its CLI couldn't be suspended: ${JSON.stringify(s.failed)}`)
        }
        const left = callApi('POST', `/v1/projects/alpha/agents/Tester/message`, { text: `Round ${i + 1}: nothing to do. Read this, ack it, and reply with just: ok` })
        if (pause) {
          // Resumed only once Combwork has written the whole line while the CLI was suspended, so it reads it in one go.
          check(`${what}: Combwork writes the line while its CLI is suspended`, !!(await lib.until(() => written(logLines), HUNG_MS, 100)))
          await lib.sleep(pause) // on purpose: how long the CLI stays suspended with the line written
          const failedResumes = paused.resume()
          check(`${what}: its CLI is resumed`, !paused.held().length, JSON.stringify(failedResumes))
          // Still suspended, nothing after this can be waited for: the round stops (cleanup tries again, then ends it).
          if (paused.held().length) throw new Error(`${what}: its CLI couldn't be resumed: ${JSON.stringify(failedResumes)}`)
        }
        const r = await left
        check(`${what}: the message is left and its doorbell typed`, r.status === 200 && r.body?.typed === true, JSON.stringify(r.body))
        const outcome = await lib.until(() => wakeLines().slice(lines).find((l) => /was taken after \d+ ms|wasn't taken/.test(l)), HUNG_MS, 300)
        const mine = wakeLines().slice(lines)
        check(`${what}: the doorbell is taken at its first Enter (no Enter again)`, !!outcome && /was taken after/.test(outcome) && !mine.some((l) => /pressed Enter again|wasn't taken/.test(l)), mine.join(' | '))
        const read = await lib.until(async () => {
          const inbox = (await callApi('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.inbox
          return !!inbox?.deliveries?.some((d) => d.id === r.body?.id && (d.state === 'received' || d.state === 'acked'))
        }, HUNG_MS, 500)
        check(`${what}: the agent reads the message from its inbox`, read)
        check(`${what}: nothing is marked as not taken`, !(await live())?.untakenLine)
      })
    }

    // A doorbell put off part-way (HI-1974): typed into a narrow pane, so it wraps, held before its Enter
    // (HIVE_TEST_HOLD_TYPED), and no longer wanted meanwhile (idle wakes turned off). What Combwork typed is taken back whole
    // (one Ctrl+U clears the whole line in Codex and Copilot), and the next doorbell goes alone.
    await lib.cliStep('a doorbell put off part-way', { session: lib.ptyKey(proj, id) }, async () => {
      const key = lib.ptyKey(proj, id)
      check('put off: the agent is idle first', !!(await lib.until(idle, HUNG_MS, 300)), JSON.stringify(await live()))
      // A narrow window, so the doorbell wraps in its pane, and the CLI is as wide as the pane that shows it.
      await page.getByText('alpha', { exact: true }).first().click()
      await lib.fitWindow(app, page, { width: 640, height: 900 })
      check('put off: its pane is narrow, and the CLI as wide', !!(await lib.until(async () => (await page.evaluate(() => window.__hiveTerminalsFitted())) && (await paneCols(key)) <= 60 && (await inv('pty:size', key))?.cols === (await paneCols(key)), HUNG_MS, 300)), JSON.stringify({ pane: await paneCols(key), pty: await inv('pty:size', key) }))
      const earlier = new Set(await doorbellIds(key))
      const lines = wakeLines().length
      const logLines = hiveLog().split('\n').length - 1
      const since = (re) => hiveLog().split('\n').slice(logLines).some((l) => re.test(l))
      fs.writeFileSync(hold, '')
      const left = callApi('POST', `/v1/projects/alpha/agents/Tester/message`, { text: 'Last round: nothing to do. Read this, ack it, and reply with just: ok' })
      check('put off: its doorbell is typed, and held before its Enter', !!(await lib.until(() => since(/the line Hive typed is held before its Enter/), HUNG_MS, 100)))
      // Its delivery's id, from the line in its input (the message's reply waits for the line).
      const m = await lib.until(async () => (await doorbellIds(key)).find((x) => !earlier.has(x)), HUNG_MS, 300)
      check('put off: …it shows in its input', !!m && (await copies(key, m)) === 1, await screen(key))
      await inv('advanced:set', 'cw.inbox.idleWakes', false)
      check('put off: idle wakes turned off, the doorbell is put off part-way', !!(await lib.until(() => since(/put off: It is no longer wanted/), HUNG_MS, 100)))
      check('put off: …what Combwork typed is taken back whole', !!m && !!(await lib.until(async () => (await copies(key, m)) === 0, HUNG_MS, 300)), await screen(key))
      fs.rmSync(hold, { force: true })
      await inv('advanced:set', 'cw.inbox.idleWakes', null)
      const outcome = await lib.until(() => wakeLines().slice(lines).find((l) => /was taken after \d+ ms|wasn't taken/.test(l)), HUNG_MS, 300)
      check('put off: idle wakes on again, the next doorbell is typed and taken', !!outcome && /was taken after/.test(outcome), wakeLines().slice(lines).join(' | '))
      const r = await left
      const read = await lib.until(async () => {
        const inbox = (await callApi('GET', '/v1/projects/alpha/agents/Tester/activity')).body?.inbox
        return !!inbox?.deliveries?.some((d) => d.id === r.body?.id && (d.state === 'received' || d.state === 'acked'))
      }, HUNG_MS, 500)
      check('put off: …the agent reads the message', read, JSON.stringify(r.body))
      // In its conversation once: a copy left behind would show this message's doorbell twice, glued to the one sent.
      check('put off: …and the doorbell it was sent is alone', !!r.body?.id && !!(await lib.until(async () => (await copies(key, r.body.id)) === 1, HUNG_MS, 300)), await screen(key))
    })
  } finally {
    fs.rmSync(hold, { force: true })
    // What is still suspended (a round stopped part-way) is resumed; what can't be is ended, by its identity, so the
    // test's Combwork can close and no CLI is left suspended.
    const left = paused.release()
    if (left.ended.length) console.log(`Couldn't resume ${JSON.stringify(left.failed)}: ended instead`)
    await app.close().catch(() => undefined)
    await api?.close()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
}
