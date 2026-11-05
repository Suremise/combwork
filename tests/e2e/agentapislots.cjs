// The Agent API on slots (#1451, SPEC §16.10.3): a Git project's slots lent through the test copies' `slots:test`
// channel (as a card's or lane's start does), on the fake Claude Code, the Agent API on:
// 1. cw_project_status: B1 lent slot-a for a card is in `slot-a`; B2, a 0.9 agent whose worktree is carried as hb2, is
//    in `hb2` on its own branch; R1, a reviewer, in `project`; no agent has a `worktree` any more.
// 2. B1 running in the project folder when the lease came: its detail's `folder` (session: project) and `launchFolder`
//    (lease: slot-a) differ; its doc reads read the project folder it works in. Started again, it runs in slot-a: its
//    own reads read the slot's copy, `from=project` the project folder's.
// 3. Adding an agent in a worktree is refused, saying why (`location`, `worktree`, `existingWorktree`, `branch`), by
//    the Agent API (the Assistant's: only it adds agents) and the IPC, and so is a card's start on a new agent with
//    `worktree: true`; an agent added plainly is in the project folder; cw_add_agent offers no worktree arguments, and
//    its tools/call (and cw_start_task's) given them anyway is refused too, adding nothing and leaving the card as it was.
// 4. Storage counts each slot on disk once: lent (to its agent), and still once its lease ends and it waits free.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1578): B2 is a 0.9 worktree agent on purpose (agents:testLegacy), and B1's slot is lent through
// slots:test; a packaged build refuses both test channels.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 45000

const at = (x) => path.join(lib.WORK, `agentapislots-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47804))
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const NOTE = (where) => `# Note\n\nThe ${where} copy.\n`

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'NOTE.md': NOTE('project'), '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, ...['slot-a', 'slot-b', 'hb2'].map((s) => path.join(root, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' } })
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
    const op = (o) => inv('slots:test', alpha, o)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const idle = async (id) => ['ready', 'finished'].includes((await live(id))?.status)
    const launches = () => lines(path.join(home, 'fake-launches.jsonl'))
    /** The agent's running session's Agent API token (its launch's). */
    const tokenOf = async (id) => {
      const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const combwork = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
      return combwork ? JSON.parse(fs.readFileSync(combwork.env.CW_API_TOKEN_FILE, 'utf8')).token : null
    }
    const status = async () => Object.fromEntries((await api('GET', '/v1/projects/alpha')).body.agents.map((a) => [a.name, a]))
    const activity = async (id) => (await api('GET', `/v1/projects/alpha/agents/${encodeURIComponent(id)}/activity`)).body
    const read = async (token, from) => (await api('GET', `/v1/docs/section?path=NOTE.md${from ? `&from=${from}` : ''}`, undefined, token)).body?.content ?? ''
    const stop = async (id) => {
      await inv('session:stop', alpha, id)
      return !!(await until(async () => !(await live(id)), HUNG_MS))
    }

    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    // HI-2258: a call naming no agent (cw_agent_activity's `agent` left out: `agents//activity`) is the sole agent's,
    // and with several it is refused saying "agent" is missing, never "No route".
    const sole = await api('GET', '/v1/projects/alpha/agents//activity')
    check("HI-2258: no agent named, alone: the sole agent's activity", sole.status === 200 && sole.body?.agent === 'B1', JSON.stringify(sole))
    await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const several = await api('GET', '/v1/projects/alpha/agents//activity')
    check('…with several: refused (400), saying to name it with "agent"', several.status === 400 && /several agents: say which one with "agent"/.test(several.body?.error ?? ''), JSON.stringify(several))
    // B2: a 0.9 agent with its own worktree, as an upgraded project has one, adopted as its carried slot hb2.
    const b2 = await lib.addAgent(inv, alpha, { location: 'new-worktree', name: 'B2', branch: 'cw/hb2', workflowRole: 'builder' })
    const hb2 = (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha)).agents.find((a) => a.id === b2.id)?.worktree?.path
    check("B2's 0.9 worktree is there", !!hb2 && fs.existsSync(hb2), String(hb2))
    const carried = await op({ op: 'carry', agent: b2.id, slot: 'hb2', folder: hb2 })
    check('…carried as its slot hb2', carried?.kind === 'carried' && carried.agent === b2.id, JSON.stringify(carried))

    // --- 1. Before any lease: B1 and R1 in the project folder.
    let s = await status()
    check('B1 and R1 are in the project folder, no slot or branch', s.B1?.folder === 'project' && !s.B1.slot && s.B1.branch === null && s.R1?.folder === 'project' && s.R1.branch === null, JSON.stringify([s.B1, s.R1]))
    check('no agent has a worktree field', Object.values(s).every((a) => !('worktree' in a)), JSON.stringify(s))

    // --- 2. B1 runs in the project folder, then its card is lent slot-a.
    await inv('session:start', alpha, { agentId: b1.id })
    const first = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 runs in the project folder', same(first?.cwd, alpha), JSON.stringify(first))
    const l12 = await op({ op: 'lend', agent: b1.id, card: 12 })
    const slotA = l12.slot?.folder
    check("B1's card is lent slot-a", l12.ok && l12.slot.name === 'slot-a' && fs.existsSync(slotA ?? ''), JSON.stringify(l12))
    // The slot's copy of the note, changed there (not committed), so the two reads differ.
    fs.writeFileSync(path.join(slotA, 'NOTE.md'), NOTE('slot'))
    const act1 = await activity(b1.id)
    check("B1's detail: now in the project folder (its session), a new conversation in slot-a (its lease)", act1?.folder?.at === 'project' && act1.folder.why === 'session' && act1.launchFolder?.at === 'slot-a' && act1.launchFolder.why === 'lease', JSON.stringify({ folder: act1?.folder, launchFolder: act1?.launchFolder }))
    check('…and no worktree field', act1 && !('worktree' in act1), JSON.stringify(act1))
    const t1 = await tokenOf(b1.id)
    check("…its own doc read reads the project folder it works in now", /The project copy/.test(await read(t1)))
    check('B1 stopped', await stop(b1.id))
    s = await status()
    check('stopped, B1 is in slot-a (where it would start)', s.B1?.folder === 'slot-a' && s.B1.slot === 'slot-a', JSON.stringify(s.B1))

    // --- B1 started again: in slot-a.
    await inv('session:start', alpha, { agentId: b1.id })
    const second = await until(async () => ((await idle(b1.id)) ? live(b1.id) : null), HUNG_MS)
    check('B1 runs in slot-a now', same(second?.cwd, slotA), JSON.stringify(second))
    const act2 = await activity(b1.id)
    check("…its detail: in slot-a, where it would start too (no launchFolder)", act2?.folder?.at === 'slot-a' && act2.folder.why === 'session' && !('launchFolder' in act2) && act2.slot === 'slot-a', JSON.stringify(act2))
    const t2 = await tokenOf(b1.id)
    check("its own doc read reads slot-a's copy", /The slot copy/.test(await read(t2)), await read(t2))
    check('…from=project reads the project folder', /The project copy/.test(await read(t2, 'project')), await read(t2, 'project'))
    s = await status()
    check('cw_project_status: B1 in slot-a, B2 in its carried hb2 on its branch, R1 in project', s.B1?.folder === 'slot-a' && s.B1.slot === 'slot-a' && s.B2?.folder === 'hb2' && s.B2.slot === 'hb2' && s.B2.branch === 'cw/hb2' && s.R1?.folder === 'project' && !s.R1.slot, JSON.stringify(s))
    const actB2 = await activity(b2.id)
    check("B2's detail: in hb2, carried", actB2?.folder?.at === 'hb2' && actB2.folder.why === 'carried' && !('launchFolder' in actB2) && actB2.branch === 'cw/hb2', JSON.stringify(actB2))
    check('B1 stopped again', await stop(b1.id))

    // --- Storage: slot-a lent to B1, then free once its lease ends (kept on disk for the next card): counted both times.
    const PAYLOAD = 131072
    fs.writeFileSync(path.join(slotA, 'payload.bin'), Buffer.alloc(PAYLOAD))
    const slotRow = async () => (await inv('storage:project', alpha, true)).worktrees.find((w) => w.slot === 'slot-a')
    const lentRow = await slotRow()
    check('Storage counts slot-a, lent to B1', lentRow?.agent === 'B1' && lentRow.bytes >= PAYLOAD, JSON.stringify(lentRow))
    check("B1's card's lease ends", (await op({ op: 'release', lease: l12.lease.id, why: 'done' })) === true)
    check('…slot-a is still on disk, lent to no one', fs.existsSync(slotA) && !!(await until(async () => (await inv('slots:list', alpha)).find((x) => x.name === 'slot-a' && !x.lease), HUNG_MS)))
    const store = await inv('storage:project', alpha, true)
    const freeRow = store.worktrees.find((w) => w.slot === 'slot-a')
    check('…and Storage still counts it once, with no agent', !!freeRow && !freeRow.agent && freeRow.bytes >= PAYLOAD && store.worktrees.filter((w) => same(w.path, slotA)).length === 1 && !(store.unusedWorktrees ?? []).some((w) => same(w.path, slotA)) && store.total >= freeRow.bytes, JSON.stringify(store))

    // --- 3. No agent in a worktree of its own. Only the Assistant adds agents through the Agent API: its token.
    const assistantHome = (await inv('workspace:refresh')).assistant.path
    await inv('session:start', assistantHome, { agentId: 'assistant' })
    const asTokenFile = path.join(userData, 'assistant-api', `${createHash('sha256').update(ws.toLowerCase()).digest('hex').slice(0, 16)}.json`)
    const asToken = await until(async () => (fs.existsSync(asTokenFile) ? JSON.parse(fs.readFileSync(asTokenFile, 'utf8')).token : null), HUNG_MS)
    check('the Assistant starts, with its token', !!asToken)
    const before = (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha)).agents.length
    for (const body of [{ location: 'new-worktree' }, { worktree: true }, { existingWorktree: hb2 }, { branch: 'cw/x' }]) {
      const r = await api('POST', '/v1/projects/alpha/agents', { name: 'X', ...body }, asToken)
      check(`add-agent with ${Object.keys(body)[0]} is refused, saying why`, r.status === 400 && /aren't pinned to worktrees in 1\.0/.test(JSON.stringify(r.body)), JSON.stringify(r))
    }
    const ipc = await inv('agents:add', alpha, { name: 'X', location: 'new-worktree' }).then(() => null, (e) => String(e?.message ?? e))
    check('…and by the IPC', !!ipc && /pinned to worktrees/.test(ipc), String(ipc))
    const n = (await inv('tasks:create', { title: 'A card', project: 'alpha' })).number
    const started = await api('POST', `/v1/tasks/${encodeURIComponent(`#${n}`)}/start`, { worktree: true })
    check("a card's start on a new agent with worktree: true is refused", started.status === 400 && /pinned to worktrees/.test(JSON.stringify(started.body)), JSON.stringify(started))
    // The hive tools as the Assistant calls them, given 0.9's worktree arguments anyway: passed on, so refused.
    const mcp = (method, params) => JSON.parse(execFileSync(process.execPath, [path.join(lib.ROOT, 'out', 'main', 'cw-mcp.js')], { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n', env: lib.childEnv({ CW_API_URL: `http://127.0.0.1:${PORT}`, CW_WORKSPACE: ws, CW_ROLE: 'assistant', CW_ASSISTANT_CONTROL: 'projects', CW_API_TOKEN_FILE: asTokenFile, CW_API_TOKEN: '', CW_PROJECT: '' }), timeout: 60000 }).toString().split('\n')[0]).result
    const call = (name, args) => {
      const r = mcp('tools/call', { name, arguments: args })
      return { text: r.content[0].text, isError: !!r.isError }
    }
    for (const args of [{ worktree: true, branch: 'legacy-wanted' }, { location: 'new-worktree' }, { existingWorktree: hb2 }, { base: 'main' }]) {
      const r = call('cw_add_agent', { project: 'alpha', name: 'Unexpected MCP', ...args })
      check(`cw_add_agent given ${Object.keys(args).join(', ')} is refused, saying why`, r.isError && /pinned to worktrees/.test(r.text), JSON.stringify(r))
    }
    for (const args of [{ worktree: true }, { agent: 'B1', worktree: true }]) {
      const r = call('cw_start_task', { number: n, ...args })
      check(`cw_start_task given ${Object.keys(args).join(', ')} is refused, saying why`, r.isError && /pinned to worktrees/.test(r.text), JSON.stringify(r))
    }
    const cardNow = (await inv('tasks:list')).find((c) => c.number === n)
    check('…the card is left in Todo with no agent', cardNow?.column === 'todo' && !cardNow.agent, JSON.stringify(cardNow))
    check('…no agent was added by any of them', (await inv('workspace:refresh')).projects.find((p) => same(p.path, alpha)).agents.length === before)
    const added = await api('POST', '/v1/projects/alpha/agents', { name: 'B3', workflowRole: 'builder' }, asToken)
    const b3 = added.body?.project?.agents?.find((a) => a.name === 'B3')
    const tools = mcp('tools/list', {}).tools
    const addTool = tools.find((t) => t.name === 'cw_add_agent')
    const startTool = tools.find((t) => t.name === 'cw_start_task')
    check('cw_add_agent and cw_start_task offer no worktree arguments', !!addTool && !!startTool && !['worktree', 'existingWorktree', 'branch', 'base'].some((k) => k in addTool.inputSchema.properties) && !('worktree' in startTool.inputSchema.properties) && !/worktree/i.test(addTool.description), JSON.stringify({ add: Object.keys(addTool?.inputSchema?.properties ?? {}), start: Object.keys(startTool?.inputSchema?.properties ?? {}) }))
    check('an agent added plainly is in the project folder', added.status === 200 && b3?.folder === 'project' && b3.workflowRole === 'builder' && !('worktree' in b3), JSON.stringify(added.body))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
