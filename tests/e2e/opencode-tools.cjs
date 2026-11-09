// What an OpenCode agent is given (HI-2761), through Combwork with the fake opencode, in a project that defines a
// same-name combwork server, a server of its own, plugins and a parent folder's config:
// - managed (the default): exactly Combwork's server (its own token, never the project's) and the workspace server given to
//   the agent, never one not given nor any of the project's; Combwork's skills in its private config folder's skills,
//   offered and loaded with OpenCode's skill tool (HI-2761's R0b); a Combwork tool called through Code Mode's execute
//   reaching Combwork's own MCP server; Combwork's guidance in that folder's AGENTS.md;
// - Independent, after that managed launch (HI-2731's terminal preset): no Combwork server, skills or guidance left from
//   it, the switches off, and the project's own server starting, as in a terminal (no mcp.use rules), Claude Agent still
//   denied;
// - the contrast: a managed launch with no server at all (Combwork's tools off, not the whole preset) and the project's
//   config let in still denies every server: the project's never starts.
// Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30000

const userData = path.join(lib.WORK, 'opencode-tools-profile')
const ws = path.join(lib.WORK, 'opencode-tools-ws')
const home = path.join(lib.WORK, 'opencode-tools-home')
const alpha = path.join(ws, 'alpha')
const fakeLog = path.join(lib.WORK, 'opencode-tools-fake.jsonl')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const lines = () => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [])
const under = (p, dir) => !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)
const w = (f, s) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s))
}

;(async () => {
  for (const d of [userData, ws, home]) fs.rmSync(d, { recursive: true, force: true })
  fs.rmSync(fakeLog, { force: true })
  fs.mkdirSync(userData, { recursive: true })
  lib.gitProject(alpha)
  // A server that only waits (started is all a check needs), and the hostile project around it.
  const idle = path.join(ws, 'idle-server.js')
  w(idle, 'process.stdin.resume()\n')
  const local = (token) => ({ type: 'local', command: [process.execPath, idle], environment: { CW_MCP_TOKEN: token } })
  w(path.join(alpha, 'opencode.json'), { mcp: { servers: { combwork: local('T-EVIL'), proj_tool: local('T-PROJECT') } }, plugins: ['./rootplug'] })
  w(path.join(alpha, 'rootplug', 'index.js'), '// a plugin: the fake never runs it\n')
  w(path.join(alpha, '.opencode', 'opencode.json'), { mcp: { servers: { evil_dot: local('T-EVIL-DOT') } } })
  w(path.join(ws, 'opencode.json'), { mcp: { servers: { evil_parent: local('T-EVIL-PARENT') } } })
  w(path.join(alpha, 'AGENTS.md'), '# The project rules\n')
  lib.enableProviders(userData, ['claude-code', 'opencode'])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.providers.opencode = { ...cfg.settings.providers.opencode, executablePath: path.join(__dirname, 'fake-opencode', 'opencode.cmd') }
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const { app, page } = await lib.launch({ userData, env: { FAKE_OPENCODE_LOG: fakeLog, USERPROFILE: home, HOME: home, CW_TEST_CLI_HOME_CONNECTION: '0' }, viewport: { width: 1400, height: 900 } })
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
    // The workspace's servers: one given to the project, one not.
    for (const [name, token] of [['given_tool', 'T-GIVEN'], ['other_tool', 'T-OTHER']]) {
      await inv('mcp:create', name)
      await inv('mcp:save', name, JSON.stringify({ description: `A test server (${name})`, command: process.execPath, args: [idle], env: { CW_MCP_TOKEN: token } }, null, 2))
    }
    // Added as shown (an Add names the definition it showed).
    const shown = (await inv('mcp:list')).find((m) => m.name === 'given_tool')
    await inv('mcp:add', alpha, 'given_tool', { def: shown.def, revision: shown.revision })
    const live = async (agentId) => (await inv('session:live')).find((s) => s.agentId === agentId && s.status !== 'stopped') ?? null
    const agent = await lib.addAgent(inv, alpha, { name: 'Oc', provider: 'opencode' })
    // The workspace's OpenCode CLI file (HI-2764) with one text of Combwork's guidance changed: every OpenCode agent's.
    const MARK = 'OC-DIALECT-MARK: put scratch files in a temp folder, never in the project.'
    const cliFile = path.join(ws, '.combwork', 'dialects', 'opencode', 'cli.json')
    await lib.until(async () => fs.existsSync(cliFile), HUNG_MS)
    fs.writeFileSync(cliFile, JSON.stringify({ name: 'OpenCode', texts: { 'contract.agent.scratch': { text: MARK, why: 'HI-2764: a test of the OpenCode CLI file' } } }, null, 2))
    const agentNow = async () => (await inv('workspace:refresh')).projects.find((x) => x.name === 'alpha').agents.find((x) => x.id === agent.id)
    const account = await inv('connections:add', 'opencode', 'OpenCode · Local')
    await inv('connections:setOn', account.id, true)
    const conn = (await inv('connections:list')).connectionRows.find((c) => c.account === account.id) ?? (await inv('connection:add', account.id, { name: 'Test · OpenCode' }))
    await inv('agents:update', alpha, agent.id, { connection: conn.id })

    /** One launch: its serve's line, what it started and loaded, its written config and guidance; `typed` typed into its pane. */
    async function launch(label, typed = null) {
      const from = lines().length
      await inv('session:start', alpha, { agentId: agent.id })
      const serve = await lib.until(async () => lines().slice(from).find((e) => e.kind === 'launch' && e.args[0] === 'serve') ?? null, HUNG_MS)
      const mcp = await lib.until(async () => lines().slice(from).find((e) => e.kind === 'mcp' && e.pid === serve?.pid) ?? null, HUNG_MS)
      const configDir = serve?.env.OPENCODE_CONFIG_DIR
      const written = configDir ? JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8')) : null
      const guidance = configDir && fs.existsSync(path.join(configDir, 'AGENTS.md')) ? fs.readFileSync(path.join(configDir, 'AGENTS.md'), 'utf8') : ''
      const skills = lines().slice(from).filter((e) => e.pid === serve?.pid && e.kind === 'skill').map((e) => e.path)
      await lib.until(async () => await live(agent.id), HUNG_MS)
      const launched = (await lib.until(async () => (await agentNow())?.live?.launched ?? null, HUNG_MS)) ?? null
      let after = []
      if (typed) {
        await lib.until(async () => await live(agent.id), HUNG_MS)
        const key = lib.ptyKey(alpha, agent.id)
        await inv('pty:write', key, typed)
        await inv('pty:write', key, '\r')
        after = await lib.until(async () => {
          const l = lines().slice(from).filter((e) => e.pid === serve?.pid)
          return l.some((e) => e.kind === 'turn-end') ? l : null
        }, HUNG_MS)
      }
      await inv('session:stop', alpha, agent.id)
      await lib.until(async () => !(await live(agent.id)), HUNG_MS)
      check(`${label}: it launched`, !!serve && !!mcp, JSON.stringify({ serve: !!serve, mcp }))
      return { serve, mcp, written, guidance, skills, configDir, after, launched }
    }
    const mcpRules = (c) => (c?.policies ?? []).filter((p) => p.action === 'mcp.use')

    // --- Managed: exactly Combwork's server and the one given; Combwork's skills and guidance; a tool through execute.
    let managed = await launch('managed')
    const skillName = managed.skills.map((p) => path.basename(p))[0]
    check('managed: exactly Combwork\'s server and the workspace server given, never one not given or the project\'s', !!managed.mcp && [...managed.mcp.started].sort().join() === 'combwork,given_tool', JSON.stringify(managed.mcp))
    // Combwork's own server carries this agent's token file in Combwork's data; the project's would carry T-EVIL.
    check("…Combwork's server with this agent's own token, never the project's same-name one", !!managed.mcp && under(managed.mcp.tokens?.combwork, userData) && managed.mcp.tokens.given_tool === 'T-GIVEN', JSON.stringify(managed.mcp?.tokens))
    const rules = mcpRules(managed.written)
    check('…every server denied but those given', JSON.stringify(rules[0]) === JSON.stringify({ action: 'mcp.use', resource: '*', effect: 'deny' }) && rules.slice(1).map((r) => `${r.resource}:${r.effect}`).sort().join() === 'combwork:allow,given_tool:allow', JSON.stringify(managed.written?.policies))
    check("…Combwork's skills in its private config folder's skills, offered to the model", managed.skills.length > 0 && managed.skills.every((p) => under(p, path.join(managed.configDir, 'skills'))), JSON.stringify(managed.skills))
    check("…Combwork's guidance in that folder's AGENTS.md", /cw_inbox/.test(managed.guidance), managed.guidance.slice(0, 200))
    // HI-2764: the OpenCode CLI file is in its chain, and its changed text is what the agent was told.
    const layers = managed.launched?.dialect?.layers ?? []
    check("…its launch record's dialect chain has the workspace's OpenCode CLI file", layers.some((l) => l.layer === 'cli' && l.file === 'opencode/cli.json') && /^[0-9a-f]{16}$/.test(managed.launched?.dialect?.hash ?? ''), JSON.stringify(managed.launched?.dialect))
    check('…and the text changed in it is in the guidance it was given, in place of the Default', managed.guidance.includes(MARK) && !managed.guidance.includes('Put scratch, probes and logs in a temp folder'), managed.guidance.slice(0, 600))
    check("…its Combwork server given that chain's file (CW_DIALECT_FILE), as its shell is", !!managed.written?.mcp?.servers?.combwork?.environment?.CW_DIALECT_FILE && managed.serve?.env?.CW_DIALECT_FILE === managed.written.mcp.servers.combwork.environment.CW_DIALECT_FILE, JSON.stringify({ server: managed.written?.mcp?.servers?.combwork?.environment?.CW_DIALECT_FILE, shell: managed.serve?.env?.CW_DIALECT_FILE }))
    managed = await launch('managed, used', `skill ${skillName} then cw cw_inbox {}`)
    const skillCall = managed.after.find((e) => e.kind === 'skill-tool')
    check("…a skill loaded with OpenCode's skill tool, by its id", !!skillCall && skillCall.id === skillName && skillCall.found === true, JSON.stringify(skillCall))
    const toolCall = managed.after.find((e) => e.kind === 'mcp-call')
    check("…a Combwork tool called through execute reaches Combwork's own server, and answers", !!toolCall && toolCall.server === 'combwork' && toolCall.tool === 'cw_inbox' && toolCall.isError === false, JSON.stringify(toolCall))

    // --- Independent, after it: none of Combwork's, the switches off, the project's own servers as in a terminal.
    await inv('agents:update', alpha, agent.id, { workflowRole: 'independent' })
    const ind = await launch('Independent')
    // A server named combwork there is the project's own (its token), as a terminal's OpenCode would run it: never Combwork's.
    check("Independent: neither Combwork's server nor the one given", !!ind.mcp && !ind.mcp.started.includes('given_tool') && (ind.mcp.tokens?.combwork === undefined || ind.mcp.tokens.combwork === 'T-EVIL'), JSON.stringify(ind.mcp))
    check('…the project\'s harmless server is let in', !!ind.mcp && ind.mcp.started.includes('proj_tool'), JSON.stringify(ind.mcp))
    check('…no mcp.use rules in its config, Claude Agent still denied', mcpRules(ind.written).length === 0 && (ind.written?.policies ?? []).some((p) => p.action === 'provider.use' && p.resource === 'claude-agent' && p.effect === 'deny'), JSON.stringify(ind.written?.policies))
    check('…none of Combwork\'s skills or guidance left from the managed launch', !ind.skills.some((p) => under(p, path.join(ind.configDir, 'skills'))) && !/cw_inbox/.test(ind.guidance), JSON.stringify({ skills: ind.skills, guidance: ind.guidance.slice(0, 120) }))
    check('…its switches off, as a terminal\'s', !!ind.serve && ind.serve.env.OPENCODE_DISABLE_PROJECT_CONFIG === undefined && ind.serve.env.OPENCODE_DISABLE_CLAUDE_CODE === undefined)
    check("…its own roots and the machine-wide service still Combwork's", !!ind.serve && under(ind.serve.env.XDG_DATA_HOME, userData) && ind.serve.serviceDisabled === true)

    // --- The contrast: managed, Combwork's tools off (not the whole preset), no server, the project's config let in.
    await inv('agents:update', alpha, agent.id, { workflowRole: null })
    await inv('mcp:remove', alpha, 'given_tool')
    await lib.setAgentLaunch(inv, alpha, agent.id, { tools: false, guidance: true, typing: true, overrides: { keepProjectConfigOut: false } })
    const bare = await launch('managed with no servers')
    check('…still every server denied: the project\'s never starts', !!bare.mcp && bare.mcp.started.length === 0 && JSON.stringify(mcpRules(bare.written)) === JSON.stringify([{ action: 'mcp.use', resource: '*', effect: 'deny' }]), JSON.stringify({ mcp: bare.mcp, rules: mcpRules(bare.written) }))
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
