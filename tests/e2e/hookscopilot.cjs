// Hooks health, part 2, for Copilot (#1371): its hooks carry no turn id, and Hive has no screen reading of its turns, so
// before this a Copilot agent whose hooks stopped arriving was never flagged. Now its events.jsonl names each turn (an
// interactionId), and a worked turn no hook came after is flagged. The real Copilot CLI, offline against the scripted
// stand-in model (fake-copilot-api.cjs), in a home of the suite's own; Hive loses its hooks while a file is there
// (HIVE_TEST_DROP_HOOKS: a Copilot hook can't be stopped at Copilot's end), and holds its checks while another is
// (HIVE_TEST_HOOKS_HOLD), so each turn is over before any check looks. Hive's bound at 3 s.
// - a healthy quick turn is never flagged; with its hooks lost, a quick marked turn is: "transcript", naming that turn's
//   interactionId, never the healthy one's;
// - its hooks back, the next turn's hook clears it.
// Skipped where Copilot isn't installed.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { startFakeCopilotApi, copilotTestEnv, copilotInstalled } = require('./fake-copilot-api.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'hookscopilot-profile')
const ws = path.join(lib.WORK, 'hookscopilot-ws')
const proj = path.join(ws, 'demo')
const copilotDir = path.join(lib.WORK, 'hookscopilot-cli')
const copilotHome = path.join(copilotDir, 'copilot-home')
const apiLog = path.join(lib.WORK, 'hookscopilot-api.jsonl')
const hold = path.join(lib.WORK, 'hookscopilot-hold')
const drop = path.join(lib.WORK, 'hookscopilot-drop')
let failed = 0
const check = (name, ok, extra = '') => {
  lib.checked(ok)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const jsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

;(async () => {
  if (!copilotInstalled()) lib.skip("environment: the GitHub Copilot CLI isn't installed (copilot)")
  for (const d of [userData, ws, copilotDir]) fs.rmSync(d, { recursive: true, force: true })
  for (const f of [apiLog, hold, drop]) fs.rmSync(f, { force: true })
  lib.gitProject(proj, { 'a.ts': 'probe\n' })
  lib.enableProviders(userData, ['claude-code', 'copilot'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(path.join(userData, 'advanced.json'), JSON.stringify({ format: 1, values: { 'cw.hooks.missingSeconds': 3 } }, null, 2))

  const api = await startFakeCopilotApi({ log: apiLog })
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: lib.port(47847), HIVE_TEST_TIPS: 'off', HIVE_TEST_HOOKS_HOLD: hold, HIVE_TEST_DROP_HOOKS: drop, ...copilotTestEnv(api, copilotDir, { above: lib.WORK }) })
  // The folder is trusted already: Copilot goes straight to loading.
  fs.writeFileSync(path.join(copilotHome, 'config.json'), JSON.stringify({ trustedFolders: [proj] }, null, 2))
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  try {
    const page = await app.firstWindow()
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(app, page, { width: 1200, height: 800 })
    await lib.appReady(page)
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const info = await lib.until(async () => { const i = (await inv('provider:info')).copilot; return i && !i.checking ? i : null }, 60000, 500)
    check('Copilot found', !!info?.found, JSON.stringify(info && { found: info.found, path: info.path }))
    console.log(`Copilot CLI ${info?.version ?? '?'} (${info?.source ?? '?'}), offline against the stand-in at ${api.url}`)
    await lib.openWorkspace(inv, page, ws)
    const a = await inv('agents:add', proj, { name: 'Cop', provider: 'copilot', location: 'project' })
    const key = lib.ptyKey(proj, a.id)
    const live = async () => (await inv('session:live')).find((l) => l.agentId === a.id)
    await inv('session:start', proj, { agentId: a.id })
    check('Copilot starts', !!(await until(async () => (await live())?.status === 'ready', 60000)), (await live())?.status)
    const events = path.join(copilotHome, 'session-state', (await live())?.sessionId ?? '-', 'events.jsonl')
    /** The prompt's interaction once its turn is over in events.jsonl (its user.message, then Copilot's agentStop hook ran). */
    const turnOver = (text) => {
      const all = jsonl(events)
      const i = all.findIndex((e) => e.type === 'user.message' && e.data?.content === text)
      if (i < 0) return null
      const id = all[i].data.interactionId
      const worked = all.slice(i).some((e) => e.type === 'assistant.message' && e.data?.interactionId === id)
      const stopped = all.slice(i).some((e) => e.type === 'hook.end' && e.data?.hookType === 'agentStop')
      return worked && stopped ? id : null
    }
    /** One quick turn with Hive's checks held until it is over in Copilot's own records. Its interactionId. */
    const quickTurn = async (text) => {
      fs.writeFileSync(hold, '')
      await inv('pty:write', key, text)
      await until(async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '').includes(text), HUNG_MS)
      await inv('pty:write', key, '\r')
      const id = await until(() => turnOver(text), HUNG_MS)
      fs.rmSync(hold, { force: true })
      return id
    }

    const healthy = await quickTurn('say Healthy turn.')
    check('a healthy quick turn, over before any check (held)', !!healthy && !!(await until(async () => (await live())?.status === 'finished', HUNG_MS)), (await live())?.status)
    fs.writeFileSync(drop, '')
    const deaf = await quickTurn('say Deaf turn.')
    check('with its hooks lost, a quick marked turn, over before any check (held)', !!deaf)
    const flagged = await until(async () => (await live())?.hooksMissing, HUNG_MS)
    check("released, its events show the turn no hook came after: hooks missing by the transcript, naming that turn's interactionId", flagged?.after === 'transcript' && flagged?.turn === deaf && deaf !== healthy, JSON.stringify({ flagged, deaf, healthy }))
    fs.rmSync(drop, { force: true })
    await inv('pty:write', key, 'say Back again.')
    await until(async () => lib.plainText((await inv('pty:buffer', key).catch(() => '')) ?? '').includes('say Back again.'), HUNG_MS)
    await inv('pty:write', key, '\r')
    check('its hooks back, the next turn’s hook clears it', !!(await until(async () => !(await live())?.hooksMissing, HUNG_MS)), JSON.stringify((await live())?.hooksMissing))
  } catch (e) {
    check('suite ran', false, e?.stack ?? String(e))
  } finally {
    for (const f of [hold, drop]) fs.rmSync(f, { force: true })
    await app.close().catch(() => undefined)
    await api.close?.()
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
})()
