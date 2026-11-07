// The Combwork Assistant loads a template through the Agent API (HI-1502, SPEC §16.10.6): alpha (Git) has Ann and Rob, beta
// has Bea, plain has no version control. On the fake Claude Code, the Agent API on:
// 1. A script (the user's token) and a project agent (Bea's) are refused all three routes (403), before any template is
//    read.
// 2. The Assistant at Look and advise lists templates and plans a load, but its load is refused (403): nothing changes.
// 3. At Control agents: a plan of Team 3×3 into alpha with its first builder named Coder; a name beta's agent has is
//    refused (409) with a free one; an ambiguous key is refused (400). The load replaces Ann and Rob with the six
//    (Coder paired with its reviewer), and saves the template's workflow as alpha's options; it is in its actions.
// 4. Undo (POST /v1/assistant/undo, its message) puts Ann and Rob back with their ids, the layout and the options, and
//    lists what stays (the replaced agents' cards and lanes).
// 5. A Git-only template into plain is refused, saying Git is the user's; with workflow: false its agents load alone.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `templateapi-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
const plain = path.join(ws, 'plain')
const PORT = Number(lib.port(47809))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const cfgOf = (p) => JSON.parse(fs.readFileSync(path.join(p, '.combwork', 'project.json'), 'utf8'))

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.gitProject(beta, { '.gitignore': '.combwork/\n' })
  fs.mkdirSync(plain, { recursive: true })
  const env = lib.fakeClaude(userData, home, [alpha, beta, plain, ws])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' }, viewport: { width: 1400, height: 900 } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    const userToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    const api = async (method, route, body, token = userToken) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: r.status, body: await r.json().catch(() => null) }
    }
    const live = async (projectPath, id) => (await inv('session:live')).find((s) => same(s.projectPath, projectPath) && s.agentId === id) ?? null
    const launches = () => lines(path.join(home, 'fake-launches.jsonl'))
    /** The agent's running session's Agent API token (its launch's). */
    const tokenOf = async (p, id) => {
      const sessionId = await until(async () => (await live(p, id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const list = (p, token) => api('GET', `/v1/projects/${p}/templates`, undefined, token)
    const plan = (p, body, token) => api('POST', `/v1/projects/${p}/templates/plan`, body, token)
    const load = (p, body, token) => api('POST', `/v1/projects/${p}/templates/load`, body, token)
    const names = (p) => cfgOf(p).agents.map((a) => a.name)

    const ann = await lib.addAgent(inv, alpha, { name: 'Ann', workflowRole: 'builder' })
    const rob = await lib.addAgent(inv, alpha, { name: 'Rob', workflowRole: 'reviewer' })
    const bea = await lib.addAgent(inv, beta, { name: 'Bea', workflowRole: 'builder' })
    // A template with only a Git workflow: alpha's, saved with its options.
    await inv('templates:save', alpha, 'workspace', 'Git only')
    const alphaBefore = cfgOf(alpha)
    const formBefore = await inv('workflow:form', alpha)

    // --- 1. A script and a project agent are refused, before any template is read.
    for (const [what, r] of [['list', await list('alpha')], ['plan', await plan('alpha', { template: 'team-3x3.json' })], ['load', await load('alpha', { template: 'team-3x3.json' })]]) {
      check(`a script's ${what} is refused (403), naming the Assistant`, r.status === 403 && /Only the Assistant/.test(r.body?.error ?? ''), JSON.stringify(r))
    }
    await inv('session:start', beta, { agentId: bea.id })
    const beaToken = await tokenOf(beta, bea.id)
    check("Bea (a project agent) has its token", !!beaToken)
    const byAgent = [await list('beta', beaToken), await plan('beta', { template: 'team-3x3.json' }, beaToken), await load('beta', { template: 'team-3x3.json' }, beaToken)]
    check("a project agent's list, plan and load are all refused (403)", byAgent.every((r) => r.status === 403), JSON.stringify(byAgent.map((r) => r.status)))
    await inv('session:stop', beta, bea.id)
    await until(async () => !(await live(beta, bea.id)), HUNG_MS)

    // --- 2. The Assistant at Look and advise: reads only.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    await until(async () => {
      const s = await live(assistantHome, 'assistant')
      if (s?.status === 'waiting') await inv('pty:write', lib.ptyKey(assistantHome, 'assistant'), '\r')
      return s?.status === 'ready'
    }, HUNG_MS)
    const tokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const assistant = (await until(() => fs.existsSync(tokenFile), HUNG_MS)) ? JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token : null
    check('the Assistant has its token', !!assistant)
    await inv('settings:update', { assistant: { control: 'look' } })
    const listed = await list('alpha', assistant)
    check("at Look and advise it lists alpha's templates: Combwork's own and the workspace's", listed.status === 200 && listed.body?.templates?.some((t) => t.scope === 'combwork' && t.file === 'team-3x3.json' && t.agents === 6) && listed.body.templates.some((t) => t.scope === 'workspace' && t.name === 'Git only' && t.workflow.join() === 'git'), JSON.stringify(listed.body))
    const looked = await plan('alpha', { template: 'team-3x3.json' }, assistant)
    check('…plans a load', looked.status === 200 && looked.body?.remove?.join() === 'Ann,Rob' && looked.body.create?.length === 6, JSON.stringify(looked.body))
    const lookLoad = await load('alpha', { template: 'team-3x3.json' }, assistant)
    check('…but its load is refused (403)', lookLoad.status === 403, JSON.stringify(lookLoad.body))
    check('nothing changed', JSON.stringify(names(alpha)) === '["Ann","Rob"]')

    // --- 3. At Control agents.
    await inv('settings:update', { assistant: { control: 'agents' } })
    const planned = await plan('alpha', { template: 'Team 3×3', names: { 1: 'Coder' } }, assistant)
    const key = /^([A-Z]+)-B2$/.exec(planned.body?.create?.[1]?.name ?? '')?.[1] ?? ''
    check('a plan by name, its first builder named Coder, paired with its reviewer; the workflow shown', planned.status === 200 && planned.body.create[0].name === 'Coder' && planned.body.create[0].template === `${key}-B1` && planned.body.create[0].pairedWith === `${key}-R1` && planned.body.create[3].pairedWith === 'Coder' && planned.body.workflow?.platform === 'git' && planned.body.workflow.applies && planned.body.blocked.length === 0, JSON.stringify(planned.body))
    const clash = await load('alpha', { template: 'team-3x3.json', names: { 2: 'Bea' } }, assistant)
    check("a name beta's agent has is refused (409) with a free one, never filled in", clash.status === 409 && /"Bea" is beta's agent: try "[^"]+"/.test(clash.body?.error ?? ''), JSON.stringify(clash.body))
    const ambiguous = await plan('alpha', { template: 'team-3x3.json', names: { '{key}-B{n}': 'X' } }, assistant)
    check('a key that names several agents is refused (400), listing them', ambiguous.status === 400 && /is 3 of its agents: name each by its place or name/.test(ambiguous.body?.error ?? ''), JSON.stringify(ambiguous.body))
    check('…nothing changed', JSON.stringify(names(alpha)) === '["Ann","Rob"]')
    const loaded = await load('alpha', { template: 'team-3x3.json', names: { 1: 'Coder' } }, assistant)
    check('the load: Ann and Rob replaced by the six, Coder first; its workflow saved', loaded.status === 200 && loaded.body?.removed?.join() === 'Ann,Rob' && loaded.body.created?.[0] === 'Coder' && loaded.body.created.length === 6 && JSON.stringify(loaded.body.renamed) === JSON.stringify([{ template: `${key}-B1`, name: 'Coder' }]) && loaded.body.workflow?.saved === true, JSON.stringify(loaded.body))
    const now = cfgOf(alpha)
    check("…project.json has them, Coder paired with its reviewer", JSON.stringify(now.agents.map((a) => a.name)) === JSON.stringify(['Coder', `${key}-B2`, `${key}-B3`, `${key}-R1`, `${key}-R2`, `${key}-R3`]) && now.agents[0].pairedWith === `${key}-R1` && now.agents[3].pairedWith === 'Coder', JSON.stringify(now.agents.map((a) => [a.name, a.pairedWith])))
    const formAfter = await inv('workflow:form', alpha)
    check("…and alpha's own options are the template's (Team)", formAfter.preset === 'team' && JSON.stringify(formAfter.own) !== JSON.stringify(formBefore.own), JSON.stringify([formBefore.preset, formAfter.preset]))
    const actions = await inv('assistant:actions')
    check('the load is in its actions', actions.some((x) => x.ok && x.kind === 'load-template' && x.project === 'alpha'), JSON.stringify(actions.map((x) => [x.kind, x.ok, x.text])))

    // --- 4. Undo: the agents with their ids, the layout and the options; what stays is listed.
    const undone = await api('POST', '/v1/assistant/undo', { group: 'latest' }, assistant)
    const results = undone.body?.results ?? []
    check('undo puts the workflow, then the agents and layout, back; what stays is said', undone.status === 200 && results.some((r) => r.undone.join() === 'workflow') && results.some((r) => r.undone.join() === 'agents,layout') && results.some((r) => /cards and lanes of the agents a template replaced stay/.test(r.final ?? '')), JSON.stringify(undone.body))
    const back = cfgOf(alpha)
    check('…Ann and Rob are back with their ids', JSON.stringify(back.agents.map((a) => [a.id, a.name])) === JSON.stringify([[ann.id, 'Ann'], [rob.id, 'Rob']]), JSON.stringify(back.agents.map((a) => [a.id, a.name])))
    check('…and so are the options', JSON.stringify((await inv('workflow:form', alpha)).own) === JSON.stringify(formBefore.own) && back.layout === alphaBefore.layout)

    // --- 5. A Git-only template into plain: refused with its workflow; its agents alone with workflow: false.
    const free = { 1: 'P-Ann', 2: 'P-Rob' }
    const noGit = await load('plain', { template: 'Git only', names: free }, assistant)
    check("a Git-only workflow into a project with no version control is refused (409): Git is the user's", noGit.status === 409 && /set up Git in the project's Version Control first \(that is the user's choice\)/.test(noGit.body?.error ?? ''), JSON.stringify(noGit.body))
    check('…nothing changed', (cfgOf(plain).agents ?? []).length === 0)
    const agentsOnly = await load('plain', { template: 'Git only', names: free, workflow: false }, assistant)
    check('with workflow: false its agents load alone', agentsOnly.status === 200 && agentsOnly.body?.created?.join() === 'P-Ann,P-Rob' && agentsOnly.body.workflow === null, JSON.stringify(agentsOnly.body))
    check('…plain still has no version control', (await inv('workflow:form', plain)).platform === 'none')

    // --- 6. Connections (HI-2109): a plan names each agent's and what may be named; apply (Choose Connections) changes
    // only existing agents' connections, checked first, the Assistant's alone.
    check('a plan names each agent’s connection and the connections usable here', planned.body.create.every((a) => typeof a.connection === 'string' && a.connection) && planned.body.options?.length > 0, JSON.stringify([planned.body.create, planned.body.options]))
    const apply = (p, body, token) => api('POST', `/v1/projects/${p}/templates/apply`, body, token)
    const option = planned.body.options[0]
    check("a script's apply is refused (403)", (await apply('plain', { connections: { '*': option.id } })).status === 403)
    const typo = await apply('plain', { connections: { builders: option.id } }, assistant)
    check('apply: a key that is no role or agent is refused (400), naming the agents', typo.status === 400 && /builders is not "\*", a role \(builder, reviewer, either, generalist, independent\) or one of its agents: 1 \(P-Ann\), 2 \(P-Rob\)/.test(typo.body?.error ?? ''), JSON.stringify(typo.body))
    const gone = await apply('plain', { connections: { reviewer: 'Nowhere' } }, assistant)
    check('…a connection not usable here is refused (409), nothing changed', gone.status === 409 && /no connection "Nowhere" can be used here/.test(gone.body?.error ?? ''), JSON.stringify(gone.body))
    const applied = await apply('plain', { connections: { '*': option.name } }, assistant)
    check('…by name: each agent on it, said (none moved: already there)', applied.status === 200 && applied.body?.project === 'plain' && Array.isArray(applied.body.changed) && applied.body.skipped?.length === 0 && cfgOf(plain).agents.every((a) => a.connection === option.id), JSON.stringify(applied.body))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL PASSED')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
