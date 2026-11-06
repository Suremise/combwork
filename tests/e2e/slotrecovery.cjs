// Cards on slots across a restart (#1438, HR1's round 1): what a card's start owes (its line made in its slot, its builder
// placed there) is done from durable state by the next start's pass, once. Combwork ends at once (CW_TEST_SLOT_CRASH, no
// quit handler) at each point, and the next start recovers:
// 1. `afterAction`: the start's slot action marked done, nothing of it done: the restart makes the line and places B1;
// 2. `inPrepare`: the line checked out, its `SlotPrepared` not written: the restart records it (nothing switched twice);
// 3. `inPlacement`: the placement claimed, nothing delivered: the restart takes the claim over and gives the card once;
// 4. a lane started from the window with no slot free waits through a restart ("waiting for a slot", kept with the lane),
//    starts nothing while the rules are off, and starts once a slot is free with them back on: its builder's brief once;
// 5. a placement owed as Combwork is quit, its builder's conversation bound to the card's lease (HI-1746: its slot taken
//    over by its next card): the next start resumes that conversation there with the card, never a new one.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 60000

const at = (x) => path.join(lib.WORK, `slotrecovery-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const alpha = path.join(ws, 'alpha')
const root = path.join(`${ws}.worktrees`, 'alpha')
const PORT = Number(lib.port(47821))
const identity = { name: 'Combwork Slot Test', email: 'slots@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const git = (dir, ...a) => lib.git(dir, a).trim()

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  const env = lib.fakeClaude(userData, home, [alpha, ws, ...['slot-a', 'slot-b', 'slot-c', 'slot-d'].map((s) => path.join(root, s))])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  let h = null
  /** Combwork started on the workspace (`crash`: the point it ends at, once there). */
  const start = async (crash) => {
    h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off', ...(crash ? { CW_TEST_SLOT_CRASH: crash } : {}) } })
    h.page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(h.inv)
    await lib.openWorkspace(h.inv, h.page, ws)
    h.ended = false
    h.app.process().once('exit', () => (h.ended = true))
  }
  const inv = (...a) => h.inv(...a)
  const until = (fn, ms) => lib.until(fn, ms, 250)
  const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
  const launches = () => {
    const f = path.join(home, 'fake-launches.jsonl')
    const text = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    return text.slice(0, text.lastIndexOf('\n') + 1).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  }
  /** An agent running now (started if it isn't), and its Agent API token. */
  const tokenOf = async (id) => {
    if (!(await live(id))) await inv('session:start', alpha, { agentId: id })
    const sessionId = await until(async () => (await live(id))?.sessionId, HUNG_MS)
    // Its latest launch's (a resumed conversation's earlier launches' files are gone).
    const launch = await until(() => launches().filter((l) => l.sessionId === sessionId && l.opts['--mcp-config'] && fs.existsSync(l.opts['--mcp-config'])).at(-1), HUNG_MS)
    const server = launch ? JSON.parse(fs.readFileSync(launch.opts['--mcp-config'], 'utf8')).mcpServers.combwork : null
    return server ? JSON.parse(fs.readFileSync(server.env.CW_API_TOKEN_FILE, 'utf8')).token : null
  }
  const intent = async (token, n, name, body = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/tasks/${encodeURIComponent(`#${n}`)}/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    return res ? { status: res.status, body: await res.json().catch(() => null) } : { status: 0, body: null }
  }
  const facts = async (n) => inv('tasks:facts', n)
  const kinds = async (n) => (await facts(n)).map((f) => f.kind)
  const count = async (n, kind) => (await kinds(n)).filter((k) => k === kind).length
  const lane = async (id) => (await inv('lanes:list')).find((l) => l.id === id)
  /** Ends a run of Combwork that should end at its crash point, then starts it again with no crash point: it recovers. */
  const crashedThenRestart = async (label) => {
    check(`${label}: Combwork ended at the point`, !!(await until(() => h.ended, HUNG_MS)))
    await h.app.close().catch(() => {})
    await start(null)
  }
  /** Combwork started again to end at `point` (nothing owed then, so only the next step reaches it). */
  const restartToCrashAt = async (point) => {
    await h.app.close().catch(() => {})
    await start(point)
  }

  try {
    await start('afterAction')
    await lib.fitWindow(h.app, h.page, { width: 1400, height: 850 })
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const add = (name, workflowRole) => lib.addAgent(inv, alpha, { name, workflowRole })
    const [b1, b2, b3, b4, r1] = [await add('B1', 'builder'), await add('B2', 'builder'), await add('B3', 'builder'), await add('B4', 'builder'), await add('R1', 'reviewer')]
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const [c1, c2, c3, c4] = [await create('Recover one'), await create('Recover two'), await create('Recover three'), await create('Lane four')]
    const slotOf = async (n) => (await facts(n)).findLast((f) => f.kind === 'Started')?.data

    // --- 1. afterAction: the start written, its action marked done, then Combwork ends: the restart does the rest.
    const s1 = await intent(await tokenOf(b1.id), c1, 'start')
    // The crash point is the start's slot action, after its commit, and the start goes on to reply as Combwork ends: app.exit
    // closes the windows first (their workspaces disposed), so a loaded machine's reply can be "No workspace is open"
    // (HI-2549), or none comes. Any reply but the start's own is a Combwork that reached the point (only an accepted start
    // asks for the action), so it counts once Combwork ends there; the restart's checks then find the start recorded.
    check('1. B1 starts card 1 in a slot', (s1.status === 200 && !!s1.body?.data?.folder) || !!(await until(() => h.ended, HUNG_MS)), JSON.stringify(s1.body))
    await crashedThenRestart('1. afterAction')
    const st1 = await until(() => slotOf(c1), HUNG_MS)
    check("1. …restarted: card 1's line made in its slot, recorded once", !!(await until(async () => (await count(c1, 'SlotPrepared')) === 1, HUNG_MS)) && git(st1.folder, 'branch', '--show-current') === st1.line, JSON.stringify(await kinds(c1)))
    check('1. …B1 placed there once: started in its slot', !!(await until(async () => (await count(c1, 'BuilderPlaced')) === 1 && same((await live(b1.id))?.cwd, st1.folder), HUNG_MS)), JSON.stringify(await live(b1.id)))

    // --- 2. inPrepare: the line checked out, then Combwork ends before it is recorded: the restart records it once.
    await restartToCrashAt('inPrepare')
    const s2 = await intent(await tokenOf(b2.id), c2, 'start')
    check('2. B2 starts card 2 in a slot', s2.status === 200, JSON.stringify(s2.body))
    const st2 = await until(() => slotOf(c2), HUNG_MS)
    await crashedThenRestart('2. inPrepare')
    check('2. …its line was checked out before the end', git(st2.folder, 'branch', '--show-current') === st2.line)
    check('2. …restarted: recorded once, placed once', !!(await until(async () => (await count(c2, 'SlotPrepared')) === 1 && (await count(c2, 'BuilderPlaced')) === 1, HUNG_MS)), JSON.stringify(await kinds(c2)))

    // --- 3. inPlacement: claimed, nothing delivered, then Combwork ends: the restart takes the claim over and places once.
    await restartToCrashAt('inPlacement')
    const s3 = await intent(await tokenOf(b3.id), c3, 'start')
    check('3. B3 starts card 3 in a slot', s3.status === 200, JSON.stringify(s3.body))
    await crashedThenRestart('3. inPlacement')
    check('3. …the claim was made before the end', (await count(c3, 'PlacementClaimed')) >= 1)
    const st3 = await until(() => slotOf(c3), HUNG_MS)
    check('3. …restarted: the claim taken over, B3 placed once in its slot', !!(await until(async () => (await count(c3, 'BuilderPlaced')) === 1 && (await count(c3, 'PlacementClaimed')) === 2 && same((await live(b3.id))?.cwd, st3.folder), HUNG_MS)), JSON.stringify({ kinds: await kinds(c3), live: await live(b3.id) }))

    // --- 4. A lane waiting for a slot, through a restart and the rules switched off, starts once a slot is free.
    await lib.setMaxAgents(inv, 3)
    const lane4 = await inv('lanes:start', alpha, { builder: b4.id, reviewer: r1.id, cards: [c4], note: 'Keep it small.' })
    check('4. the lane waits for a slot, its agents not started', !!lane4.waitingForSlot && lane4.started.length === 0 && !(await live(b4.id)), JSON.stringify(lane4))
    // An ordinary quit with B3 running in slot-c (card 3's): its run's writer released before Combwork quit (HI-1801), so
    // the next start finds no slot held by the run that quit, and B3 can start there again.
    await h.app.close().catch(() => {})
    await start(null)
    const held = (await inv('slots:list', alpha)).filter((s) => s.writer)
    check('4. …restarted after a quit: no slot still held by a run of the Combwork that quit (HI-1801)', held.length === 0, JSON.stringify(held))
    const waiting = await until(async () => ((await lane(lane4.lane.id))?.status?.reason === 'slot' ? lane(lane4.lane.id) : null), HUNG_MS)
    check("4. …restarted: still 'waiting for a slot', paused", waiting?.state === 'paused', JSON.stringify(waiting?.status))
    // The rules off: card 3 put back frees a slot, but nothing is lent to the lane.
    await inv('advanced:set', 'cw.workflow.enforce', false)
    const pb = await intent(await tokenOf(b3.id), c3, 'put-back', { why: 'making room' })
    check('4. card 3 put back', pb.status === 200, JSON.stringify(pb.body))
    check("4. …its slot's lease ends (rules off too: data safety)", !!(await until(async () => !(await inv('slots:list', alpha)).some((s) => s.lease?.card === c3), HUNG_MS)))
    check('4. …B3 stopped once its turn is over', !!(await until(async () => !(await live(b3.id)), HUNG_MS)))
    const freed = await until(async () => ((await inv('slots:list', alpha)).some((s) => !s.lease && !s.writer && s.state === 'ready') ? true : null), HUNG_MS)
    check('4. …a slot is free', !!freed, JSON.stringify(await inv('slots:list', alpha)))
    check('4. …with the rules off, the lane is lent nothing and its builder not started', !(await live(b4.id)) && !(await inv('slots:list', alpha)).some((s) => s.lease?.lane === lane4.lane.id))
    await inv('advanced:set', 'cw.workflow.enforce', true)
    const inSlot = await until(async () => {
      const s = await live(b4.id)
      return s && (await inv('slots:list', alpha)).some((x) => x.lease?.lane === lane4.lane.id && same(x.folder, s.cwd)) ? s : null
    }, HUNG_MS)
    check('4. the rules back on: the lane gets the slot, B4 starts there', !!inSlot, JSON.stringify(await live(b4.id)))
    check('4. …R1 starts too', !!(await until(async () => !!(await live(r1.id)), HUNG_MS)))
    const sessionsOf = async (id) => (await inv('session:list', alpha)).filter((s) => s.agentId === id)
    // Its conversation is recorded after its launch shows as live (HI-2638: read at once under load, there was none yet).
    const b4Convs = await until(async () => {
      const list = await sessionsOf(b4.id)
      return list.length ? list : null
    }, HUNG_MS)
    check("4. …started once: one conversation of B4's, the lane waiting no more", b4Convs?.length === 1 && (await sessionsOf(b4.id)).length === 1 && !!(await until(async () => (await lane(lane4.lane.id))?.status?.reason !== 'slot', HUNG_MS)), JSON.stringify((await sessionsOf(b4.id)).length))

    // --- 5. A placement owed at a restart, the builder's conversation bound to the card's lease (HI-1746). B2 builds card 5
    // in a slot (its conversation there, under card 5's lease); in its turn, it puts card 5 back and starts card 6, which
    // takes its slot over (HI-1762: the conversation rebound to card 6's lease), so card 6's placement waits for the turn
    // to end; Combwork is quit then. The next start resumes that conversation there with card 6, once, never a new one.
    const [c5, c6] = [await create('Recover five'), await create('Recover six')]
    const pb2 = await intent(await tokenOf(b2.id), c2, 'put-back', { why: 'making room' })
    check('5. card 2 put back', pb2.status === 200, JSON.stringify(pb2.body))
    check('5. …B2 stopped once its turn is over', !!(await until(async () => !(await live(b2.id)), HUNG_MS)))
    check('5. …its slot free again', !!(await until(async () => (await inv('slots:list', alpha)).some((s) => !s.lease && !s.writer && s.state === 'ready'), HUNG_MS)), JSON.stringify(await inv('slots:list', alpha)))
    const s5 = await intent(await tokenOf(b2.id), c5, 'start')
    const st5 = await until(() => slotOf(c5), HUNG_MS)
    check('5. B2 starts card 5 in a slot, placed there', s5.status === 200 && !!(await until(async () => (await count(c5, 'BuilderPlaced')) === 1 && same((await live(b2.id))?.cwd, st5.folder) && ['ready', 'finished'].includes((await live(b2.id))?.status), HUNG_MS)), JSON.stringify({ s5: s5.body, live: await live(b2.id) }))
    const b2Conv = await live(b2.id)
    check("5. …its conversation there recorded under card 5's lease", !!(await until(async () => (await sessionsOf(b2.id)).find((s) => s.id === b2Conv?.sessionId && same(s.cwd, st5.folder) && !!s.lease), HUNG_MS)), JSON.stringify((await sessionsOf(b2.id)).map((s) => ({ id: s.id, cwd: s.cwd, lease: s.lease }))))
    const tb2 = await tokenOf(b2.id)
    // In a turn (until a file the test never makes): card 5's end doesn't stop it, card 6's start takes its slot over, and
    // card 6's placement waits for that turn to end.
    await lib.typeLine(inv, lib.ptyKey(alpha, b2.id), home, null, 'holduntil slotrecovery-5-never', { live: () => live(b2.id) })
    check('5. …in its turn', !!(await until(async () => (await live(b2.id))?.status === 'working', HUNG_MS)))
    const pb5 = await intent(tb2, c5, 'put-back', { why: 'starting another' })
    check('5. card 5 put back', pb5.status === 200, JSON.stringify(pb5.body))
    const s6 = await intent(tb2, c6, 'start')
    check('5. B2 starts card 6: its own slot taken over', s6.status === 200 && same(s6.body?.data?.folder, st5.folder), JSON.stringify(s6.body))
    const lease6 = await until(async () => (await inv('slots:list', alpha)).find((s) => s.lease?.card === c6 && same(s.folder, st5.folder))?.lease?.id, HUNG_MS)
    check('5. …its conversation rebound to card 6', !!lease6 && !!(await until(async () => (await sessionsOf(b2.id)).find((s) => s.id === b2Conv.sessionId && s.lease === lease6), HUNG_MS)), JSON.stringify((await sessionsOf(b2.id)).map((s) => ({ id: s.id, lease: s.lease }))))
    // Its slot's preparation and its placement both wait for that turn to end.
    check("5. …card 6's placement owed (B2's turn not over)", (await count(c6, 'BuilderPlaced')) === 0 && (await live(b2.id))?.status === 'working', JSON.stringify(await kinds(c6)))
    // Combwork quit with the placement owed; the next start places it.
    await h.app.close().catch(() => {})
    await start(null)
    const placed6 = await until(async () => (await facts(c6)).find((f) => f.kind === 'BuilderPlaced'), HUNG_MS)
    check('5. …restarted: B2 placed by resuming its conversation, not a new one', placed6?.data?.how === 'resumed', JSON.stringify(placed6?.data))
    check('5. …running there in that same conversation', !!(await until(async () => same((await live(b2.id))?.cwd, st5.folder) && (await live(b2.id))?.sessionId === b2Conv.sessionId, HUNG_MS)), JSON.stringify(await live(b2.id)))
    const resumed = await until(() => launches().find((l) => l.opts['--resume'] === b2Conv.sessionId), HUNG_MS)
    check('5. …its launch resumed it (--resume), and placed it once', !!resumed && (await count(c6, 'BuilderPlaced')) === 1, JSON.stringify(launches().filter((l) => l.sessionId === b2Conv.sessionId).map((l) => l.opts['--resume'] ?? l.opts['--session-id'])))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    await h?.app.close().catch(() => {})
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
