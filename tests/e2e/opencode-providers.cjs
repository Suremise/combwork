// Each OpenCode connection reaches only its own provider (HI-2769, the "Keep OpenCode to the connection's own provider"
// override, on by default; HI-2768's allowlist), through Combwork with the fake opencode, which enforces provider.use for
// a session's model as 2.2.6 does (HI-2763):
// - on: the private config denies every provider and allows the model's own, before Claude Agent's deny; a prompt on the
//   connection's own model finishes; a project config (let in) setting another provider's model can't reach it: the
//   turn fails at once rather than going there;
// - on, with no model: the launch is refused, saying what to do;
// - off (the user's explicit choice): no allowlist, no model needed (OpenCode chooses its own), and the project's other
//   provider is used, as outside Combwork.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-providers-profile')
const ws = path.join(lib.WORK, 'opencode-providers-ws')
const alpha = path.join(ws, 'alpha')
const fakeLog = path.join(lib.WORK, 'opencode-providers-fake.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const failure = (p) => p.then(() => null, (e) => String(e?.message ?? e))
const providerRules = (c) => (c?.policies ?? []).filter((p) => p.action === 'provider.use').map((p) => `${p.resource}:${p.effect}`)

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(fakeLog, { force: true })
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha)
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: path.join(__dirname, 'fake-opencode', 'opencode.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  // Two providers the fake offers besides its built-in ones: the connection's own (mylab) and another (elsewhere).
  const { app, page } = await lib.launch({ userData, env: { FAKE_OPENCODE_LOG: fakeLog, FAKE_OPENCODE_MODELS: 'mylab/m7,elsewhere/x9', CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
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
    const account = await inv('connections:add', 'opencode', 'OpenCode · Providers')
    await inv('connections:setOn', account.id, true)
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode', model: 'mylab/m7' })
    const live = async () => (await inv('session:live')).find((s) => s.agentId === agent.id && s.status !== 'stopped') ?? null

    /** One launch, a prompt typed into it: its written config and its turn (the model the fake used, and how it ended). */
    async function launch(label) {
      const from = lines().length
      await inv('session:start', alpha, { agentId: agent.id })
      const serve = await lib.until(async () => lines().slice(from).find((e) => e.kind === 'launch' && e.args[0] === 'serve') ?? null, HUNG_MS)
      const configDir = serve?.env.OPENCODE_CONFIG_DIR
      const written = configDir ? JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8')) : null
      await lib.until(async () => lines().slice(from).some((e) => e.kind === 'tui'), HUNG_MS)
      const key = lib.ptyKey(alpha, agent.id)
      await inv('pty:write', key, 'hello')
      await inv('pty:write', key, '\r')
      const end = await lib.until(async () => lines().slice(from).find((e) => e.kind === 'turn-end') ?? null, HUNG_MS)
      const turn = lines().slice(from).find((e) => e.kind === 'turn') ?? null
      await inv('session:stop', alpha, agent.id)
      await lib.until(async () => !(await live()), HUNG_MS)
      check(`${label}: it launched and took a prompt`, !!serve && !!turn && !!end, JSON.stringify({ serve: !!serve, turn, end }))
      return { written, turn, end }
    }
    const modelOf = (t) => (t?.model ? `${t.model.providerID}/${t.model.id}` : null)

    // --- On (the default): only the connection's own provider.
    const on = await launch('on')
    check("on: every provider denied, the connection's own allowed, Claude Agent's deny after", providerRules(on.written).slice(0, 3).join() === '*:deny,mylab:allow,claude-agent:deny', JSON.stringify(providerRules(on.written)))
    check("…a prompt on the connection's own model finishes", modelOf(on.turn) === 'mylab/m7' && on.end?.outcome === 'succeeded', JSON.stringify({ model: modelOf(on.turn), end: on.end }))

    // --- On, with the project's config let in setting another provider's model: it can't reach it.
    fs.writeFileSync(path.join(alpha, 'opencode.json'), JSON.stringify({ model: 'elsewhere/x9' }))
    await lib.setAgentLaunch(inv, alpha, agent.id, { overrides: { keepProjectConfigOut: false } })
    const hostile = await launch('on, the project setting elsewhere/x9')
    // Combwork sets the connection's model on the session at every start (HI-2767), so the project's model never applies:
    // the turn runs on the connection's own, and the allowlist still denies every other provider.
    check("…the project's other provider is never used: the turn runs on the connection's own model, every other provider still denied", modelOf(hostile.turn) === 'mylab/m7' && hostile.end?.outcome === 'succeeded' && providerRules(hostile.written).slice(0, 2).join() === '*:deny,mylab:allow' && !lines().some((e) => e.kind === 'turn' && /^elsewhere\//.test(modelOf(e) ?? '')), JSON.stringify({ model: modelOf(hostile.turn), end: hostile.end, rules: providerRules(hostile.written) }))

    // --- On, with no model: refused, saying what to do.
    fs.rmSync(path.join(alpha, 'opencode.json'), { force: true })
    await lib.setAgentLaunch(inv, alpha, agent.id, { overrides: { keepProjectConfigOut: true } })
    await lib.setLaunch(inv, alpha, agent.id, { model: '' })
    const refused = await failure(inv('session:start', alpha, { agentId: agent.id }))
    check('on, with no model: the launch is refused, naming the model to choose and the setting to turn off', /names none/.test(refused ?? '') && /Keep OpenCode to the connection's own provider/.test(refused ?? ''), refused ?? 'started')
    await lib.until(async () => !(await live()), HUNG_MS)

    // --- Off: OpenCode's own rules; no model needed; the project's other provider used.
    await lib.setAgentLaunch(inv, alpha, agent.id, { overrides: { ownProviderOnly: false } })
    const off = await launch('off, no model')
    check('off: no allowlist (Claude Agent still denied)', !providerRules(off.written).includes('*:deny') && providerRules(off.written).includes('claude-agent:deny'), JSON.stringify(providerRules(off.written)))
    check('…with no model, OpenCode chooses its own (the fake\'s default)', modelOf(off.turn) === 'opencode/big-pickle' && off.end?.outcome === 'succeeded', JSON.stringify({ model: modelOf(off.turn), end: off.end }))
    fs.writeFileSync(path.join(alpha, 'opencode.json'), JSON.stringify({ model: 'elsewhere/x9' }))
    await lib.setAgentLaunch(inv, alpha, agent.id, { overrides: { ownProviderOnly: false, keepProjectConfigOut: false } })
    const offHostile = await launch('off, the project setting elsewhere/x9')
    check("…and the project's other provider is used, as outside Combwork", modelOf(offHostile.turn) === 'elsewhere/x9' && offHostile.end?.outcome === 'succeeded', JSON.stringify({ model: modelOf(offHostile.turn), end: offHostile.end }))

    check('the fake logged no errors', !lines().some((e) => e.kind === 'error'), JSON.stringify(lines().filter((e) => e.kind === 'error')))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
