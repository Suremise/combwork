// The GitHub Copilot CLI's contract with Combwork (#638): what the installed Copilot sends Combwork (its hooks, and what Combwork
// made of each) is recorded through the developer console's own recording (redacted, the header naming the CLI's and
// Combwork's tested-with versions), made into a fixture as `npm run console-fixture` would, and compared with the one
// recorded before (tests/fixtures/console/copilot.json): a hook that stops arriving, a field gone or of another type,
// or Combwork reading a hook differently fails; a new hook or field is flagged in the log. Run with the real tier: before a
// release and after a Copilot update. The real Copilot CLI offline, against the scripted stand-in model
// (fake-copilot-api.cjs: no sign-in, no credits), in a home of the suite's own with the GitHub CLI's login hidden: never
// the user's ~/.copilot or gh sign-in. Skipped where Copilot isn't installed. A deliberate change to what Copilot sends
// is accepted by recording the fixture again (tests/fixtures/console/README.md); this run's is kept as
// contract-copilot-live.json with --keep-files.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const userData = path.join(lib.WORK, 'contract-copilot-profile')
const ws = path.join(lib.WORK, 'contract-copilot-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'contract-copilot-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'contract-copilot-api.jsonl')
const FIXTURE = path.join(lib.ROOT, 'tests', 'fixtures', 'console', 'copilot.json')
// The scripted turn the fixture was recorded with: Copilot reads a file, then answers.
const TURN = 'view a.ts then say Done.'
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  const { compareContract, recordingToFixture, parseRecording, RECOGNITION_MARKERS } = await import('../../src/shared/consoleFixtures.mts')
  const fixture = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : null
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
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47873), ...copilotTestEnv(api, copilotDir, { above: lib.WORK }) })
  // The folder is trusted already (as "Yes, and remember this folder" saves it): no trust question in the contract.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [proj] }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1200, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => {
      const i = (await inv('provider:info')).copilot
      return i && !i.checking ? i : null
    }, HUNG_MS, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (tested with ${info?.tested?.version ?? 'none recorded'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop', provider: 'copilot', location: 'project' })
    const source = await lib.until(async () => (await inv('console:sources')).find((s) => s.agentId === a.id) ?? null, HUNG_MS)

    // --- Recorded from before the launch to after the exit, as a user's recording would be.
    await inv('console:subscribe', [source.id])
    const started = await inv('console:record', source.id)
    check('recording starts, redacted', started.recording === true && started.includeText === false, JSON.stringify(started))
    const ring = () => inv('console:snapshot', source.id, 0)
    const seen = (pred) => lib.until(async () => (await ring()).find(pred) ?? null, HUNG_MS)
    await inv('session:start', proj, { agentId: a.id })
    await lib.until(async () => (await inv('session:live')).find((l) => l.agentId === a.id)?.status === 'ready', HUNG_MS)
    // What Combwork recognises on the screen (its prompt, its footer) is noted as the screen draws, whatever the status, and
    // can come after the agent is ready: the turn waits for each the fixture has. A CLI whose screen changed never shows
    // one; the comparison below says which.
    for (const name of new Set((fixture?.events ?? []).filter((e) => e.kind === 'terminal' && RECOGNITION_MARKERS.includes(e.name)).map((e) => e.name))) await seen((e) => e.kind === 'terminal' && e.name === name)
    const key = lib.ptyKey(proj, a.id)
    await lib.sendPrompt(inv, key, TURN, { submitted: async () => !!(await ring()).find((e) => e.name === 'UserPromptSubmit') })
    check('the turn ends (its Stop hook)', !!(await seen((e) => e.kind === 'hook' && e.name === 'Stop')))
    await inv('session:stop', proj, a.id)
    check('…and the session (its exit)', !!(await seen((e) => e.kind === 'exit')))
    const stopped = await inv('console:stopRecording')
    check('recording stops with its events counted', stopped?.recording === false && stopped.events > 0 && stopped.reason === 'stopped', JSON.stringify(stopped))

    // --- The recording: its header, and what it holds.
    const text = fs.readFileSync(stopped.file, 'utf8')
    const rec = parseRecording(text)
    const cli = rec.header?.clis.find((c) => c.provider === 'copilot')
    check("the recording's header: Combwork's version, Copilot's installed and tested-with versions, no text", !!rec.header && rec.header.text === false && cli?.version === (info?.version ?? null) && cli?.tested === (info?.tested?.version ?? null) && rec.end?.reason === 'stopped', JSON.stringify(rec.header))
    check("…and the turn's prompt isn't in it", !text.includes('view a.ts then'))

    // --- The contract: what Copilot sends now against the recorded fixture.
    const live = recordingToFixture(text)
    fs.writeFileSync(path.join(lib.WORK, 'contract-copilot-live.json'), `${JSON.stringify(live, null, 2)}\n`)
    if (!fixture) {
      check(`a recorded fixture to compare with (${path.relative(lib.ROOT, FIXTURE)})`, false, 'none: record one (tests/fixtures/console/README.md)')
    } else {
      const findings = compareContract(fixture, live)
      for (const f of findings.filter((x) => x.level === 'new')) console.log(`FLAG ${f.event}: ${f.what} (Copilot ${live.cli ?? '?'}; the fixture is ${fixture.cli ?? '?'})`)
      const changes = findings.filter((x) => x.level === 'change')
      check(`Copilot ${live.cli ?? '?'} keeps the contract recorded with ${fixture.cli ?? '?'}: every hook arrives with its fields, read as before`, changes.length === 0, changes.map((f) => `${f.event}: ${f.what}`).join('; '))
    }
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
    await api.close()
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED')
  process.exit(failed ? 1 : 0)
})()
