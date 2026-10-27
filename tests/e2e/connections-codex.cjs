// Codex connections (HI-1757; the test seam off so the real rule
// applies), on the fake Codex (no browser, no real sign-in): with none on, a Codex agent is refused; two connections
// signed in with Codex's own login in each one's folder; two agents on them at once, each launch's CODEX_HOME its own
// folder, its login kept there (the file store) and a token in Hive's environment never passed on; a conversation
// carried from one connection to the other (its rollout in the shared sessions folder, resumed), its plan usage then
// the connection's own, in the status bar (HI-1882); a login changed in a
// connection's folder warned of; a signed-out connection refused; and a removal that leaves the shared rollouts in the
// CLI home untouched.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'connections-codex-profile')
const claudeHome = path.join(lib.WORK, 'connections-codex-claude-home')
const codexHome = path.join(lib.WORK, 'connections-codex-home')
const ws = path.join(lib.WORK, 'connections-codex-ws')
const alpha = path.join(ws, 'alpha')
const accountsRoot = path.join(userData, 'accounts')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
/** The fake Codex's launches in a connection's folder (each with its home, agent and the login variables it got). */
const launchedIn = (id) => lines(path.join(accountsRoot, id, 'fake-launches.jsonl')).filter((l) => l.agent)
/** Every rollout file under a folder, by name. */
const rollouts = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /rollout-.*\.jsonl$/.test(f)).map((f) => path.basename(f)) : [])

;(async () => {
  for (const d of [userData, ws, claudeHome, codexHome]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [userData, claudeHome, codexHome]) fs.mkdirSync(d, { recursive: true })
  // Codex's own home: its Windows sandbox set up (the PC's), as Codex keeps it.
  fs.writeFileSync(path.join(codexHome, 'config.toml'), '[windows]\nsandbox = "unelevated"\n')
  lib.gitProject(alpha)
  fs.mkdirSync(path.join(alpha, '.hive'), { recursive: true })
  fs.writeFileSync(path.join(alpha, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a-one', name: 'One', provider: 'codex' }, { id: 'a-two', name: 'Two', provider: 'codex' }, { id: 'a-three', name: 'Three', provider: 'codex' }] }))
  lib.enableProviders(userData, ['claude-code', 'codex'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.codex.executablePath = path.join(__dirname, 'fake-codex', 'fake-codex.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // A token in Hive's own environment, as one set on the PC would be: a connection's Codex must never get it.
  // Each app server the fake runs (Hive's sign-in checks, its hook checks) notes its pid there.
  const appServers = path.join(userData, 'fake-appservers.txt')
  const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, CODEX_ACCESS_TOKEN: 'made-up-not-a-token', HIVE_TEST_CLI_HOME_CONNECTION: '0', FAKE_CODEX_APPSERVER_LOG: appServers }
  const { app, page } = await lib.launch({ userData, env, viewport: { width: 1400, height: 900 } })
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
    const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e))
    await lib.waitForProvider(inv, 'codex')
    await lib.openWorkspace(inv, page, ws)
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const view = async (id) => (await inv('connections:list')).connections.find((c) => c.id === id)
    const stop = async (agentId) => {
      await inv('session:stop', alpha, agentId)
      await lib.until(async () => !(await live(agentId)), HUNG_MS)
    }

    // --- No Codex connection on: refused, never launched from Codex's own home.
    const refused = await failure(inv('session:start', alpha, { agentId: 'a-one' }))
    check('with no Codex connection on, a Codex agent is refused, saying why', /No Codex connection is on in this workspace/.test(refused ?? ''), refused ?? 'started')
    check("…nothing launched on Codex's own home", lines(path.join(codexHome, 'fake-launches.jsonl')).filter((l) => l.agent).length === 0)

    // --- Two connections, each signed in with Codex's own login in its folder (the fake opens no browser).
    const connect = async (name, email) => {
      fs.mkdirSync(accountsRoot, { recursive: true })
      fs.writeFileSync(path.join(accountsRoot, 'fake-login-as.json'), JSON.stringify({ email, plan: 'plus' }))
      const a = await inv('connections:add', 'codex', name)
      await inv('connections:signIn', a.id)
      const ok = await lib.until(async () => (await view(a.id))?.accepted?.email === email, HUNG_MS)
      check(`${name} signed in as ${email}, its login in its own folder`, !!ok && fs.existsSync(path.join(accountsRoot, a.id, 'auth.json')))
      check(`…its rollouts shared: sessions and archived_sessions linked to Codex's own`, ['sessions', 'archived_sessions'].every((n) => fs.lstatSync(path.join(accountsRoot, a.id, n)).isSymbolicLink()))
      return a
    }
    const work = await connect('ChatGPT · Work', 'work@example.com')
    const home = await connect('ChatGPT · Home', 'home@example.com')
    await inv('connections:setOn', work.id, true)
    await inv('connections:setOn', home.id, true)
    check('the first turned on is the default', (await inv('connections:list')).workspace.codex?.default === work.id)

    // --- Two agents at once: One on the default (Work), Two on its own choice (Home).
    await inv('agents:update', alpha, 'a-two', { connection: home.id })
    await inv('session:start', alpha, { agentId: 'a-one' })
    await inv('session:start', alpha, { agentId: 'a-two' })
    check('One launches on the default connection, Work', !!(await lib.until(async () => launchedIn(work.id).some((l) => l.agent === 'One'), HUNG_MS)))
    check('…Two on its own, Home, at the same time', !!(await lib.until(async () => launchedIn(home.id).some((l) => l.agent === 'Two'), HUNG_MS)))
    const all = [...launchedIn(work.id), ...launchedIn(home.id)]
    check("…each with its connection's folder as CODEX_HOME", launchedIn(work.id).every((l) => l.home === path.join(accountsRoot, work.id)) && launchedIn(home.id).every((l) => l.home === path.join(accountsRoot, home.id)))
    check('…its login kept in that folder (the file store)', all.every((l) => l.args.join(' ').includes('cli_auth_credentials_store="file"')))
    check("…the PC's Windows sandbox passed on", all.every((l) => l.args.includes('windows.sandbox="unelevated"')))
    check("…and never the token in Hive's environment", all.every((l) => l.loginVars.length === 0), JSON.stringify(all.map((l) => l.loginVars)))
    check('…and its run says so', (await live('a-one'))?.launchedConnection?.id === work.id && (await live('a-two'))?.launchedConnection?.id === home.id)

    // --- A conversation carried over: Two's first turn on Home, then resumed on Work, through the shared rollouts.
    await inv('pty:write', lib.ptyKey(alpha, 'a-two'), 'hello')
    await lib.sleep(300) // on purpose: the fake takes a typed line before its Enter, as Codex does
    await inv('pty:write', lib.ptyKey(alpha, 'a-two'), '\r')
    const first = await lib.until(async () => (await live('a-two'))?.sessionId || null, HUNG_MS)
    check("Two's conversation has begun on Home", !!first)
    check("…its rollout written to Codex's own sessions folder, through Home's link", !!(await lib.until(async () => rollouts(path.join(codexHome, 'sessions')).some((f) => f.includes(first)), HUNG_MS)), JSON.stringify(rollouts(path.join(codexHome, 'sessions'))))
    await stop('a-two')
    await inv('agents:update', alpha, 'a-two', { connection: work.id })
    await inv('session:start', alpha, { agentId: 'a-two', resumeId: first })
    const resumed = await lib.until(async () => launchedIn(work.id).find((l) => l.agent === 'Two') ?? null, HUNG_MS)
    check('…resumed on Work, the same conversation', !!resumed && resumed.args[0] === 'resume' && resumed.args[1] === first, JSON.stringify(resumed?.args?.slice(0, 2)))
    check('…its rollout found there too, through Work’s link', rollouts(path.join(accountsRoot, work.id, 'sessions')).some((f) => f.includes(first)))

    // --- Its plan usage is Work's (HI-1882: a Codex login has no organisation, and every report was dropped): the
    // rollout's rate limits kept as Work's, and the status bar's Work item shows them.
    await lib.until(async () => (await live('a-two'))?.status === 'ready', HUNG_MS)
    await inv('pty:write', lib.ptyKey(alpha, 'a-two'), 'planusage 12 57')
    await lib.sleep(300) // on purpose: the fake takes a typed line before its Enter, as Codex does
    await inv('pty:write', lib.ptyKey(alpha, 'a-two'), '\r')
    const keptWork = await lib.until(async () => (await inv('app:connectionPlanUsage'))[work.id] ?? null, HUNG_MS)
    check("Two's rollout's rate limits are kept as Work's", keptWork?.limits?.map((l) => l.usedPercent).join(',') === '12,57' && !(await inv('app:planUsage')).codex, JSON.stringify({ kept: keptWork, cli: (await inv('app:planUsage')).codex ?? null }))
    const workItem = page.locator(`.statusbar .status-item[data-plan-connection="${work.id}"]`)
    const workText = async () => ((await workItem.count()) === 1 ? (await workItem.innerText()).replace(/\s+/g, ' ') : '')
    check('…and the status bar shows Work’s: 5h 12% · Week 57%', !!(await lib.until(async () => /Work.*5h 12%.*Week 57%/.test(await workText()), HUNG_MS)), await workText())

    // --- A third agent on a busy connection (HI-1873): One and Two run on Work, writing in its folder all the time as
    // Codex's databases do (and so does each check's app server), its login untouched. Three starts there, every time.
    fs.writeFileSync(path.join(accountsRoot, work.id, 'fake-busy'), '')
    const threes = () => launchedIn(work.id).filter((l) => l.agent === 'Three').length
    const refusedBusy = []
    for (let i = 0; i < 3; i++) {
      const before = threes()
      const out = await failure(inv('session:start', alpha, { agentId: 'a-three' }))
      if (out) refusedBusy.push(out)
      else {
        await lib.until(async () => threes() > before, HUNG_MS)
        await stop('a-three')
      }
    }
    check('a third agent starts on a connection two others are busy on, every time (3 of 3)', refusedBusy.length === 0, JSON.stringify(refusedBusy))
    fs.rmSync(path.join(accountsRoot, work.id, 'fake-busy'))
    await stop('a-two')

    // --- A login changed in Home's folder (signed in as someone else there): warned of, not taken on.
    fs.writeFileSync(path.join(accountsRoot, home.id, 'fake-account.json'), JSON.stringify({ email: 'other@example.com', plan: 'plus' }))
    fs.writeFileSync(path.join(accountsRoot, home.id, 'auth.json'), '{"fake":"changed"}')
    const changed = await lib.until(async () => {
      const c = await view(home.id)
      return c?.observed?.email === 'other@example.com' ? c : null
    }, HUNG_MS)
    check("a login changed in a connection's folder is seen (its login file watched)", !!changed)
    check('…and not taken on: it still says who it was signed in as', changed?.accepted?.email === 'home@example.com', JSON.stringify(changed?.accepted))

    // --- Work signed out: refused, never another connection in its place.
    await stop('a-one')
    fs.rmSync(path.join(accountsRoot, work.id, 'fake-account.json'))
    await inv('connections:list', true)
    await lib.until(async () => (await view(work.id))?.observed?.loggedIn === false, HUNG_MS)
    const out = await failure(inv('session:start', alpha, { agentId: 'a-one' }))
    check('a signed-out connection is refused, saying so', /Work is signed out/.test(out ?? ''), out ?? 'started')

    // --- Removing Home: its links first, then its folder; the rollouts in Codex's own home stay.
    const before = rollouts(path.join(codexHome, 'sessions'))
    await inv('connections:remove', home.id)
    check("Home's folder is gone", !fs.existsSync(path.join(accountsRoot, home.id)))
    check("…and Codex's own sessions are untouched", JSON.stringify(rollouts(path.join(codexHome, 'sessions'))) === JSON.stringify(before) && before.length > 0, JSON.stringify(before))

    // --- Every app server Hive ran for its checks was ended before its answer was taken: none is left running.
    const ran = fs.existsSync(appServers) ? fs.readFileSync(appServers, 'utf8').split(/\r?\n/).map(Number).filter((n) => n > 0) : []
    const alive = (pid) => {
      try {
        process.kill(pid, 0) // signal 0 asks, it ends nothing
        return true
      } catch {
        return false
      }
    }
    check("Hive's checks ran Codex's app server, and none of them is left running", ran.length > 0 && ran.every((pid) => !alive(pid)), JSON.stringify({ ran: ran.length, left: ran.filter(alive) }))
  } catch (e) {
    check('the suite ran to its end', false, e.stack)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
