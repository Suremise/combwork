// Cards on slots (#1438, SPEC §16.10): Pair with Hive merges and Where cards are built: Each card in its own folder, on
// fake Claude Code agents, the Assistant off, a temp Git project (its package-lock.json changing, G15 on, the slots'
// setup a script that records what it installed):
// 1. A lane of two cards from the window: it gets slot-a before its agents start, and B1, running in the project folder,
//    is started again there in a new conversation; card 1's start makes its line hive/<KEY>/<KEY>-n-slot-one in slot-a
//    from the target's head; reviewed, passed, Hive's queue merges it, and the lane keeps slot-a;
//    HI-2335: the lane's no-code card next starts where B1 is (no slot, no lease, slot-a untouched, B1 left in its
//    conversation there); put back, the lane keeps slot-a's lease; started again, reviewed and Done with no merge;
// 2. card 2 starts in slot-a, on the lane's same lease, from the new target, installed again first (card 1 changed the lock file), and card 1's
//    line, merged, is deleted (LineDeleted on card 1);
// 3. with one slot (Maximum agents: 1), a second lane waits ("waiting for a slot", paused) and starts in slot-a once
//    the first ends, its builder there; the first's builder is stopped. HI-2335: meanwhile, slot-a lent, a generalist
//    in the project folder starts a no-code card there, and its code card is still refused start.slotAvailable;
// 4. HI-2014 (Legible's LE-249): the second lane's card 3, committed and not merged, moved to Done by the user's override:
//    slot-a leaves its line (detached at the target's head), the line kept; card 4, which depends on it, is told it
//    starts without card 3's work, and starts as the lane's next card in slot-a.
// 5. HI-2170: no card of the lanes was ever asked about slot-a's uncommitted changes (the pool's detach as a lane ended
//    read halfway through); card 4 moved to Done with a file left uncommitted in slot-a, the second lane ends and slot-a
//    stays on card 4's line, the user asked on card 4 (For you).
// After each Done, the lane's slot leaves the card's line once its builder is quiet (HI-2014, HI-1986).
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotcards-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const tools = at('tools')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const slotA = path.join(root, 'slot-a')
const setupLog = path.join(tools, 'setup.log')
const PORT = Number(lib.port(47819))
const identity = { name: 'Hive Slot Test', email: 'slots@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const git = (dir, ...a) => lib.git(dir, a).trim()
const commitIn = (dir, files, message) => {
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'add', '-A'])
  lib.git(dir, ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '-qm', message])
  return git(dir, 'rev-parse', 'HEAD')
}
/** Whether a commit is in a branch of the project. */
const isIn = (rev, ref) => {
  try {
    lib.git(alpha, ['merge-base', '--is-ancestor', rev, ref])
    return true
  } catch {
    return false
  }
}
// The slots' installs only (a merge check's install runs the same setup, outside any slot: HIVE_SLOT unset).
const installs = () => (fs.existsSync(setupLog) ? fs.readFileSync(setupLog, 'utf8').trim().split('\n').filter((l) => l.startsWith('slot-')) : [])

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, tools]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(tools, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', 'package-lock.json': '{"v":1}\n', '.gitignore': '.hive/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  // The identity its commits use, in its git config: G12 reads it from git each time (HI-2266, HI-2283).
  lib.git(alpha, ['config', 'user.name', identity.name])
  lib.git(alpha, ['config', 'user.email', identity.email])
  // The slots' setup: records the slot and the lock file it installed from.
  const setup = path.join(tools, 'setup.js')
  fs.writeFileSync(setup, `require('fs').appendFileSync(${JSON.stringify(setupLog)}, process.env.HIVE_SLOT + ' ' + require('fs').readFileSync('package-lock.json', 'utf8').trim() + '\\n')\n`)
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  // #1553: every read of the agents' input recorded (fake-input.jsonl), for typeLine and what B1's terminal got around its held run.
  lib.logFakeInput(home)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    // Pair with Hive merges into integration (checked out nowhere), cards in slots, slots brought up to date (G15).
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    // G15 on, written into project.json as the Version Control tab will offer it (#1445; this version doesn't yet).
    const pj = path.join(alpha, '.hive', 'project.json')
    const raw = JSON.parse(fs.readFileSync(pj, 'utf8'))
    const own = (function find(o) {
      if (!o || typeof o !== 'object') return null
      if (o.folder === 'slots' && o.finish === 'hiveMerges') return o
      for (const v of Object.values(o)) {
        const f = find(v)
        if (f) return f
      }
      return null
    })(raw.workflow)
    if (own) own.slotsUpToDate = true
    fs.writeFileSync(pj, JSON.stringify(raw, null, 2))
    check("G15 is the project's", !!own && (await inv('workflow:form', alpha))?.options?.slotsUpToDate === true, JSON.stringify(raw.workflow))
    await inv('project:updateConfig', alpha, { slots: { setup: `node "${setup}"` } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
    const r2 = await lib.addAgent(inv, alpha, { name: 'R2', workflowRole: 'reviewer' })
    // HI-2335's generalist (step 3), never counted in the pool's size.
    const g1 = await lib.addAgent(inv, alpha, { name: 'G1', workflowRole: 'generalist' })
    // One slot for the project: its pool is its builders, at most its Maximum agents (HI-2001).
    await lib.setMaxAgents(inv, 1)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const launches = () => {
      const f = path.join(home, 'fake-launches.jsonl')
      const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
      return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    }
    /** The agent's running session's Agent API token (its launch's). */
    const tokenOf = async (id) => {
      const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
      const launch = await until(() => launches().find((l) => l.sessionId === sessionId && l.opts['--mcp-config']), HUNG_MS)
      const hive = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.hive : null
      return hive ? JSON.parse(fs.readFileSync(hive.env.HIVE_API_TOKEN_FILE, 'utf8')).token : null
    }
    const intent = async (token, n, name, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
    const slots = () => inv('slots:list', alpha)
    const branchIn = (dir) => git(dir, 'branch', '--show-current')
    const hasLine = (line) => {
      try {
        git(alpha, 'rev-parse', '--verify', '-q', `refs/heads/${line}`)
        return true
      } catch {
        return false
      }
    }
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Slot one')
    const c2 = await create('Slot two')
    const c3 = await create('Slot three')
    const c4 = (await inv('tasks:create', { title: 'Slot four', project: 'alpha', blockedBy: [c3] })).number
    // HI-2335: no-code cards, the lane's and a generalist's own, and the generalist's code card.
    const cN = (await inv('tasks:create', { title: 'Decide the names', project: 'alpha', kind: 'no-code' })).number
    const cG = (await inv('tasks:create', { title: 'Write it down', project: 'alpha', kind: 'no-code' })).number
    const cGc = (await inv('tasks:create', { title: 'Code meanwhile', project: 'alpha' })).number
    const key = (await card(c1)).key.split('-')[0]
    const line = (n, slug) => `hive/${key}/${key}-${n}-${slug}`

    // --- 1. A lane of two cards: slot-a lent before its agents start; B1 started again there in a new conversation.
    await inv('session:start', alpha, { agentId: b1.id })
    const firstSession = await until(async () => ((await live(b1.id))?.status === 'ready' ? (await live(b1.id)).sessionId : null), HUNG_MS)
    check('B1 runs in the project folder', !!firstSession && same((await live(b1.id))?.cwd, alpha))
    const started = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1, cN, c2] })
    check('the lane is lent slot-a, and both agents start', started.slot === 'slot-a' && started.started.every((s) => s.how !== 'failed') && started.started.find((s) => s.role === 'builder')?.how === 'fresh', JSON.stringify(started))
    check("slot-a was set up first (its setup's run, from the target's lock file)", installs()[0] === 'slot-a {"v":1}', JSON.stringify(installs()))
    const inSlot = await until(async () => {
      const s = await live(b1.id)
      return s && same(s.cwd, slotA) && s.sessionId !== firstSession && ['ready', 'finished'].includes(s.status) ? s : null
    }, HUNG_MS)
    check('B1 now runs in slot-a, in a new conversation', !!inSlot, JSON.stringify(await live(b1.id)))
    check('the lane names its slot', (await lane(started.lane.id))?.slot === 'slot-a')
    const tb1 = await tokenOf(b1.id)
    const s1 = await intent(tb1, c1, 'start')
    // Its own start, or Hive's for the lane's next card landing first (HI-1990: that start is its reply): slot-a either way.
    check("card 1's start: built in slot-a, B1 told to end its turn there (or that Hive started it)", s1.status === 200 && same(s1.body?.data?.folder, slotA) && /You'll continue in slot-a|Hive started [A-Z]+-\d+ for you, as your lane's next card/.test(JSON.stringify(s1.body)), JSON.stringify(s1.body))
    const base1 = git(alpha, 'rev-parse', 'integration')
    check(`card 1's line ${line(c1, 'slot-one')} is made in slot-a from the target's head`, !!(await until(() => branchIn(slotA) === line(c1, 'slot-one'), HUNG_MS)) && git(slotA, 'rev-parse', 'HEAD') === base1, branchIn(slotA))
    check('card 1 records its slot and lease', ((await inv('tasks:facts', c1)).find((f) => f.kind === 'Started')?.data?.slot ?? '') === 'slot-a')
    // B1 works there: card 1's change, with a new lock file.
    const rev1 = commitIn(slotA, { 'one.txt': 'one\n', 'package-lock.json': '{"v":2}\n' }, 'Slot one')
    check('B1 submits card 1', (await intent(tb1, c1, 'submit', { summary: 'Slot one: ready' })).status === 200)
    const tr1 = await tokenOf(r1.id)
    check('R1 reviews and passes it', (await intent(tr1, c1, 'start-review')).status === 200 && (await intent(tr1, c1, 'verdict', { pass: true, comment: 'Slot one: passed' })).status === 200)
    check("Hive's queue merges card 1: Done", !!(await until(async () => (await card(c1))?.column === 'done', HUNG_MS)), (await card(c1))?.column)
    check('…into integration', isIn(rev1, 'integration'))
    const lent = (await slots()).find((s) => s.name === 'slot-a')
    check('the lane keeps slot-a after card 1 is Done', !!lent?.lease && lent.lease.lane === started.lane.id, JSON.stringify(lent))
    check("…and slot-a leaves card 1's line: detached at integration's head (HI-2014)", !!(await until(() => branchIn(slotA) === '' && git(slotA, 'rev-parse', 'HEAD') === git(alpha, 'rev-parse', 'integration'), HUNG_MS)), branchIn(slotA))

    // --- 1b. HI-2335: the lane's no-code card takes no slot, and leaves the lane's alone.
    const laneLease = lent?.lease?.id
    const b1Run = await live(b1.id)
    const factsN = async () => await inv('tasks:facts', cN)
    const slotNow = async () => (await slots()).find((s) => s.name === 'slot-a')
    /** The card started: B1's own start, or Hive's for the lane's next card (HI-1990) landing first. */
    const startN = async () => (await until(async () => ((await card(cN))?.column === 'doing' ? true : (await intent(tb1, cN, 'start')).status === 200 || null), HUNG_MS)) === true
    check("the lane's no-code card starts", await startN(), JSON.stringify(await card(cN)))
    const startedN = (await factsN()).findLast((f) => f.kind === 'Started')?.data
    check('…where B1 is: no folder of its own, no slot, no lease', startedN?.folder === 'project' && !startedN.slot && !startedN.lease && startedN.cardKind === 'no-code', JSON.stringify(startedN))
    const untouched = async () => {
      const s = await slotNow()
      return s?.lease?.id === laneLease && s.lease.lane === started.lane.id && branchIn(slotA) === '' && !(await factsN()).some((f) => f.kind === 'SlotPrepared') && (await slots()).filter((x) => x.lease).length === 1
    }
    check("…slot-a untouched: the lane's lease, detached, nothing prepared, no other slot lent", !!laneLease && (await untouched()), JSON.stringify(await slots()))
    const b1Now = await live(b1.id)
    check('…B1 left where it runs: slot-a, the same conversation', same(b1Now?.cwd, slotA) && b1Now?.sessionId === b1Run?.sessionId, JSON.stringify({ was: b1Run, now: b1Now }))
    const putN = await intent(tb1, cN, 'put-back', { why: 'not yet' })
    check('B1 puts the no-code card back', putN.status === 200 && !!(await until(async () => (await factsN()).some((f) => f.kind === 'Moved' && f.data?.to === 'todo'), HUNG_MS)), JSON.stringify(putN.body))
    check("…the lane keeps slot-a's lease", await untouched(), JSON.stringify(await slots()))
    check('…started again, still with no slot', (await startN()) && (await factsN()).filter((f) => f.kind === 'Started').at(-1)?.data?.folder === 'project' && (await untouched()), JSON.stringify(await factsN()))
    check('B1 submits it (a summary); R1 passes it: Done, nothing merged', (await intent(tb1, cN, 'submit', { summary: 'Names: decided' })).status === 200 && (await intent(tr1, cN, 'start-review')).status === 200 && (await intent(tr1, cN, 'verdict', { pass: true, comment: 'Names: fine' })).status === 200 && !!(await until(async () => (await card(cN))?.column === 'done', HUNG_MS)), JSON.stringify(await card(cN)))
    check("…and the lane still keeps slot-a's lease", await untouched(), JSON.stringify(await slots()))

    // --- 2. Card 2 in slot-a from the new target, installed again first; card 1's line, merged, deleted. While B1 has a
    // run going in slot-a (HR1's round 1 finding 3), nothing of the slot changes: prepared only once it is quiet.
    const hold = path.join(tools, 'hold.js')
    const holdGo = path.join(tools, 'hold-go.txt')
    const holdSaw = path.join(tools, 'hold-saw.txt')
    // Held until hold-go.txt, bounded against a hang; as it ends it records the branch its folder is on (still card 1's),
    // read from the worktree's HEAD.
    fs.writeFileSync(hold, `const fs = require('fs'); const t = Date.now(); const tick = () => { if (fs.existsSync(${JSON.stringify(holdGo)})) { fs.writeFileSync(${JSON.stringify(holdSaw)}, fs.readFileSync(require('path').join(fs.readFileSync('.git', 'utf8').replace('gitdir:', '').trim(), 'HEAD'), 'utf8').replace('ref: refs/heads/', '').trim()); process.exit(0) } if (Date.now() - t > 120000) process.exit(3); setTimeout(tick, 100) }; tick()\n`)
    const progressRuns = async () => (await inv('progress:snapshot')).runs.filter((r) => r.state === 'running' || r.state === 'queued')
    // B1's command typed as its shell would get it. Hive may type a wake into B1 at the same moment (card 1's Done, #1553):
    // typeLine types it again when the wake disturbed it or B1 dropped it.
    await lib.typeLine(inv, lib.ptyKey(alpha, b1.id), home, 'B1', `shell: hive-progress --title "B1 holds slot-a" -- node "${hold}"`, {
      ready: async () => ['ready', 'finished'].includes((await live(b1.id))?.status),
      taken: async () => (await progressRuns()).length > 0,
      hungMs: HUNG_MS,
    })
    // What B1's CLI read, took as a wake, or dropped (#1553: a run that never started).
    const inputs = () => ['fake-input.jsonl', 'fake-wakes.jsonl', 'fake-dropped.jsonl', 'fake-shell.jsonl'].map((f) => (fs.existsSync(path.join(home, f)) ? `${f}:\n${fs.readFileSync(path.join(home, f), 'utf8').slice(-4000)}` : `${f}: none`)).join('\n')
    check("B1's run is going in slot-a", !!(await until(async () => (await progressRuns()).length > 0, HUNG_MS)), `${JSON.stringify(await progressRuns())}\n${inputs()}`)
    const headBusy = git(slotA, 'rev-parse', 'HEAD')
    const s2 = await intent(tb1, c2, 'start')
    const busyFacts = async () => (await inv('tasks:facts', c2)).map((f) => f.kind)
    check('card 2 started while B1 is busy: the slot not touched yet', s2.status === 200 && !!(await until(async () => (await busyFacts()).includes('Started'), HUNG_MS)) && branchIn(slotA) === '' && git(slotA, 'rev-parse', 'HEAD') === headBusy && !(await busyFacts()).includes('SlotPrepared'), JSON.stringify({ branch: branchIn(slotA), facts: await busyFacts() }))
    fs.writeFileSync(holdGo, 'go')
    check("…B1's run over, slot-a still detached where it was as it ended", !!(await until(async () => (await progressRuns()).length === 0, HUNG_MS)) && fs.existsSync(holdSaw) && fs.readFileSync(holdSaw, 'utf8') === headBusy, fs.existsSync(holdSaw) ? fs.readFileSync(holdSaw, 'utf8') : 'no record')
    check("card 2 starts in the lane's slot-a", s2.status === 200 && same(s2.body?.data?.folder, slotA), JSON.stringify(s2.body))
    const started2 = (await inv('tasks:facts', c2)).findLast((f) => f.kind === 'Started')?.data
    check("…on the lane's same lease, kept through its no-code card (HI-2335)", started2?.lease === laneLease && started2?.slot === 'slot-a', JSON.stringify(started2))
    const base2 = git(alpha, 'rev-parse', 'integration')
    check(`card 2's line from the target as it is now (card 1 in it)`, !!(await until(() => branchIn(slotA) === line(c2, 'slot-two'), HUNG_MS)) && git(slotA, 'rev-parse', 'HEAD') === base2 && base2 !== base1)
    check('G15: slot-a installed again before card 2, from the new lock file', !!(await until(() => installs().length === 2, HUNG_MS)) && installs()[1] === 'slot-a {"v":2}', JSON.stringify(installs()))
    check("card 1's merged line is deleted, and noted on card 1", !!(await until(async () => !hasLine(line(c1, 'slot-one')) && (await inv('tasks:facts', c1)).some((f) => f.kind === 'LineDeleted'), HUNG_MS)))
    check("card 2's line is kept (not merged)", hasLine(line(c2, 'slot-two')))

    // --- 3. One slot, a second lane: it waits for a slot, then starts in slot-a when the first ends.
    const second = await inv('lanes:start', alpha, { builder: b2.id, reviewer: r2.id, cards: [c3, c4] })
    check('the second lane is recorded, waiting for a slot, its agents not started', !!second.waitingForSlot && second.started.length === 0 && !(await live(b2.id)), JSON.stringify(second))
    const waiting = await lane(second.lane.id)
    check("…its lane says 'waiting for a slot', paused", waiting?.status?.reason === 'slot' && waiting.state === 'paused' && waiting.slot === null, JSON.stringify(waiting?.status))
    // HI-2335: every slot lent (slot-a, the first lane's): a generalist in the project folder starts a no-code card there.
    await inv('session:start', alpha, { agentId: g1.id })
    check('G1 runs in the project folder', !!(await until(async () => ['ready', 'finished'].includes((await live(g1.id))?.status) && same((await live(g1.id))?.cwd, alpha), HUNG_MS)), JSON.stringify(await live(g1.id)))
    const tg1 = await tokenOf(g1.id)
    const sG = await intent(tg1, cG, 'start')
    const startedG = (await inv('tasks:facts', cG)).findLast((f) => f.kind === 'Started')?.data
    check('with every slot lent, G1 starts its no-code card in the project folder', sG.status === 200 && same(sG.body?.data?.folder, alpha) && startedG?.folder === 'project' && !startedG.lease && !/You'll continue in|waits for a slot/.test(JSON.stringify(sG.body)), JSON.stringify({ body: sG.body, startedG }))
    check("…slot-a still the first lane's", (await slotNow())?.lease?.lane === started.lane.id, JSON.stringify(await slotNow()))
    const sGc = await intent(tg1, cGc, 'start')
    check('…while its code card still waits for a slot (start.slotAvailable)', sGc.status === 409 && sGc.body?.rule === 'start.slotAvailable' && (await card(cGc))?.column === 'todo', JSON.stringify(sGc.body))
    check('G1 puts its no-code card back: nothing of a slot to give back', (await intent(tg1, cG, 'put-back', { why: 'done looking' })).status === 200 && (await slotNow())?.lease?.lane === started.lane.id)
    const rev2 = commitIn(slotA, { 'two.txt': 'two\n' }, 'Slot two')
    check('B1 submits card 2; R1 passes it', (await intent(tb1, c2, 'submit', { summary: 'Slot two: ready' })).status === 200 && (await intent(tr1, c2, 'start-review')).status === 200 && (await intent(tr1, c2, 'verdict', { pass: true, comment: 'Slot two: passed' })).status === 200)
    check('card 2 merged: the first lane ends', !!(await until(async () => (await card(c2))?.column === 'done' && !!(await lane(started.lane.id))?.endedAt, HUNG_MS)) && isIn(rev2, 'integration'))
    check("the first lane's builder is stopped once its turn is over", !!(await until(async () => !(await live(b1.id)), HUNG_MS)))
    const b2There = await until(async () => {
      const s = await live(b2.id)
      return s && same(s.cwd, slotA) ? s : null
    }, HUNG_MS)
    check('the second lane gets slot-a and starts: B2 runs there', !!b2There, JSON.stringify(await live(b2.id)))
    const now = await lane(second.lane.id)
    check('…its lane names slot-a and waits no more', now?.slot === 'slot-a' && now?.status?.reason !== 'slot', JSON.stringify(now))
    check('…R2 starts too', !!(await until(async () => !!(await live(r2.id)), HUNG_MS)))

    // --- 4. HI-2014 (LE-249): card 3 committed, not merged, moved to Done by the user's override.
    const tb2 = await tokenOf(b2.id)
    check('B2 starts card 3 in slot-a', (await intent(tb2, c3, 'start')).status === 200 && !!(await until(() => branchIn(slotA) === line(c3, 'slot-three'), HUNG_MS)), branchIn(slotA))
    const rev3 = commitIn(slotA, { 'three.txt': 'three\n' }, 'Slot three')
    const why = 'Merged by hand in another repository'
    const moved3 = await inv('tasks:move', c3, 'done', { confirm: true, reason: why })
    check("the user's override moves card 3 to Done", (await card(c3))?.column === 'done', JSON.stringify(moved3))
    const finished3 = (await inv('tasks:facts', c3)).find((f) => f.kind === 'Finished')
    check('…its finish recorded as an override, with no merge', finished3?.data?.how === 'override' && finished3.data.verified === null && finished3.data.reason === why, JSON.stringify(finished3))
    check("slot-a leaves card 3's line once B2 is quiet: detached at integration's head", !!(await until(() => branchIn(slotA) === '' && git(slotA, 'rev-parse', 'HEAD') === git(alpha, 'rev-parse', 'integration'), HUNG_MS)), branchIn(slotA))
    check("…card 3's line kept, with its work (not in the target)", hasLine(line(c3, 'slot-three')) && git(alpha, 'rev-parse', line(c3, 'slot-three')) === rev3 && !isIn(rev3, 'integration'))
    const note = async () => (await card(c4))?.comments?.find((c) => c.hiveText?.id === 'tasks.history.startsWithout') ?? null
    check("card 4 is told it starts without card 3's work", !!(await until(note, HUNG_MS)) && (await note()).hiveText.values.reason === why, JSON.stringify((await card(c4))?.comments))
    const next4 = (await lane(second.lane.id))
    check("the lane goes on: card 4 is its next, nothing waits", next4?.state === 'active' && next4?.status?.reason !== 'you', JSON.stringify(next4?.status))
    const s4 = await intent(tb2, c4, 'start')
    check('card 4 starts (its dependency counts as accepted) in slot-a, from the target', s4.status === 200 && same(s4.body?.data?.folder, slotA) && !!(await until(() => branchIn(slotA) === line(c4, 'slot-four'), HUNG_MS)), JSON.stringify(s4.body))

    // --- 5. HI-2170: asked about slot-a's uncommitted changes only when they are really there.
    const slotAsks = async (n) => (await inv('tasks:facts', n)).filter((f) => f.kind === 'ApprovalRequested' && f.data?.gate === 'slotDirty')
    const before = await Promise.all([c1, c2, c3].map(slotAsks))
    check("no card was asked about slot-a through the lanes' merges and ends", before.every((a) => a.length === 0), JSON.stringify(before))
    fs.writeFileSync(path.join(slotA, 'wip.txt'), 'not committed\n')
    const moved4 = await inv('tasks:move', c4, 'done', { confirm: true, reason: 'Done by hand' })
    check('card 4 moved to Done with a file left uncommitted in slot-a: the second lane ends', !!(await until(async () => (await card(c4))?.column === 'done' && !!(await lane(second.lane.id))?.endedAt, HUNG_MS)), JSON.stringify(moved4))
    check("…its builder stopped, card 4 is asked about slot-a once (For you)", !!(await until(async () => !(await live(b2.id)) && (await slotAsks(c4)).length === 1 && (await inv('tasks:forYou')).items.some((i) => i.card === c4 && i.gate === 'slotDirty'), HUNG_MS)), JSON.stringify(await slotAsks(c4)))
    check("…slot-a stays on card 4's line, the file kept", branchIn(slotA) === line(c4, 'slot-four') && fs.existsSync(path.join(slotA, 'wip.txt')), branchIn(slotA))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
