// Two OpenCode agents at once (HI-2763; HI-2758's Q7), through Combwork with the fake opencode: two projects, each agent
// on an OpenCode account of its own. Each launch has its own private server (its own port and password, the
// machine-wide service off), its own account's roots and config folder, and its own session; a prompt typed into one pane
// reaches only its session (the other account's store never holds it); stopping one leaves the other running, its
// server and its pane still taking prompts. The fake's sessions live in each account's own store (fake-opencode/store.cjs:
// <XDG_DATA_HOME>\opencode\opencode.db), so what each holds is what reached it. Events and turn states, permissions and
// interrupts follow with HI-2760; tools with HI-2761; usage with HI-2762. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-profile')
const ws = path.join(lib.WORK, 'opencode-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const fakeLog = path.join(lib.WORK, 'opencode-fake.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** What an account's store holds (the fake's: one JSON file in its data root). */
const store = (dataHome) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataHome, 'opencode', 'opencode.db'), 'utf8'))
  } catch {
    return { sessions: {} }
  }
}
const texts = (dataHome) => Object.values(store(dataHome).sessions).flatMap((s) => s.messages.filter((m) => m.type === 'user').map((m) => m.text))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(fakeLog, { force: true })
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: path.join(__dirname, 'fake-opencode', 'opencode.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page } = await lib.launch({ userData, env: { FAKE_OPENCODE_LOG: fakeLog, CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
    await lib.waitForProvider(inv, 'opencode')
    await lib.openWorkspace(inv, page, ws)
    const fake = path.join(__dirname, 'fake-opencode', 'opencode.cmd')
    const selected = await lib.until(async () => (await inv('provider:refresh', 'opencode'))?.opencode?.path ?? null, HUNG_MS)
    if (String(selected ?? '').toLowerCase() !== fake.toLowerCase()) {
      console.log(`FAIL stopped before any session: Combwork selected ${selected ?? 'no opencode'}, not the fake`)
      process.exitCode = 1
      return
    }
    const live = async (project, agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped' && (!s.projectPath || s.projectPath.toLowerCase() === project.toLowerCase())) ?? null

    // --- Two accounts, an agent on each, in two projects.
    const accA = await inv('connections:add', 'opencode', 'OpenCode · A')
    await inv('connections:setOn', accA.id, true)
    const a = await lib.addAgent(inv, alpha, { name: 'OcA', provider: 'opencode' })
    const accB = await inv('connections:add', 'opencode', 'OpenCode · B')
    await inv('connections:setOn', accB.id, true)
    const b = await lib.addAgent(inv, beta, { name: 'OcB', provider: 'opencode' })
    // Each agent on its own account: a connection on each (the account's own, else one made), the agent pointed at it.
    const onAccount = async (acc, project, agentId) => {
      const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === acc.id) ?? (await inv('connection:add', acc.id, { name: `Test · ${acc.id}` }))
      await inv('agents:update', project, agentId, { connection: conn.id })
    }
    await onAccount(accA, alpha, a.id)
    await onAccount(accB, beta, b.id)

    const serveFor = (project) => lines().find((e) => e.kind === 'launch' && e.args[0] === 'serve' && e.cwd && fs.realpathSync.native(e.cwd).toLowerCase() === fs.realpathSync.native(project).toLowerCase()) ?? null
    const tuiFor = (project) => lines().find((e) => e.kind === 'launch' && e.args.includes('--server') && e.args.at(-1).toLowerCase() === fs.realpathSync.native(project).toLowerCase()) ?? null
    await inv('session:start', alpha, { agentId: a.id })
    await inv('session:start', beta, { agentId: b.id })
    const [sa, sb] = [await lib.until(async () => serveFor(alpha), HUNG_MS), await lib.until(async () => serveFor(beta), HUNG_MS)]
    const [ta, tb] = [await lib.until(async () => tuiFor(alpha), HUNG_MS), await lib.until(async () => tuiFor(beta), HUNG_MS)]
    const port = (e) => e?.args[e.args.indexOf('--port') + 1]
    const sessionOf = (e) => e?.args[e.args.indexOf('--session') + 1]
    check('each agent has its own private server, on its own port', !!sa && !!sb && sa.pid !== sb.pid && port(sa) !== port(sb) && sa.serviceDisabled && sb.serviceDisabled, JSON.stringify([sa?.args, sb?.args]))
    check('…each TUI on its own server, with its own session', !!ta && !!tb && ta.args[ta.args.indexOf('--server') + 1].endsWith(`:${port(sa)}`) && tb.args[tb.args.indexOf('--server') + 1].endsWith(`:${port(sb)}`) && sessionOf(ta) !== sessionOf(tb), JSON.stringify([ta?.args, tb?.args]))
    check('…its own config folder', !!sa && !!sb && sa.env.OPENCODE_CONFIG_DIR !== sb.env.OPENCODE_CONFIG_DIR)
    const homeA = sa?.env.XDG_DATA_HOME
    const homeB = sb?.env.XDG_DATA_HOME
    check("…and its own account's roots", !!homeA && !!homeB && homeA !== homeB, JSON.stringify([homeA, homeB]))
    check("…each session only in its account's store", !!store(homeA).sessions[sessionOf(ta)] && !store(homeA).sessions[sessionOf(tb)] && !!store(homeB).sessions[sessionOf(tb)] && !store(homeB).sessions[sessionOf(ta)])

    // --- A prompt typed into one pane reaches only its session.
    await lib.until(async () => (await live(alpha, a.id)) && (await live(beta, b.id)), HUNG_MS)
    await inv('pty:write', lib.ptyKey(alpha, a.id), 'marker-for-A')
    await inv('pty:write', lib.ptyKey(alpha, a.id), '\r')
    check("a prompt typed into A's pane reaches A's session", !!(await lib.until(async () => (texts(homeA).includes('marker-for-A') ? true : null), HUNG_MS)), JSON.stringify(texts(homeA)))
    check("…and never B's", !texts(homeB).includes('marker-for-A'), JSON.stringify(texts(homeB)))

    // --- Stopping A leaves B running, still taking prompts.
    await inv('session:stop', alpha, a.id)
    await lib.until(async () => !(await live(alpha, a.id)), HUNG_MS)
    check("stopped, A's server ends", !!(await lib.until(async () => (!alive(sa.pid) ? true : null), HUNG_MS)))
    check("…B's server is still running", alive(sb.pid) && !!(await live(beta, b.id)))
    await inv('pty:write', lib.ptyKey(beta, b.id), 'marker-for-B')
    await inv('pty:write', lib.ptyKey(beta, b.id), '\r')
    check('…and B still takes a prompt, into its own session', !!(await lib.until(async () => (texts(homeB).includes('marker-for-B') ? true : null), HUNG_MS)) && !texts(homeA).includes('marker-for-B'), JSON.stringify([texts(homeA), texts(homeB)]))
    await inv('session:stop', beta, b.id)
    await lib.until(async () => !(await live(beta, b.id)), HUNG_MS)
    check("stopped, B's server ends too", !!(await lib.until(async () => (!alive(sb.pid) ? true : null), HUNG_MS)))
    check('the fake logged no errors and never the shared service', lines().every((e) => e.kind !== 'error' && e.kind !== 'shared-service'), JSON.stringify(lines().filter((e) => e.kind === 'error' || e.kind === 'shared-service')))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
