// HI-2466: a lane that waits for a slot gets it once what held the slot is gone, with no restart. On fake Claude Code
// agents, the Assistant off, one slot (Maximum agents: 1), Pair with Combwork merges and each card in its own folder:
// 1. B1's first lane is lent slot-a, B1 runs there; the lane is ended and B1 stopped, slot-a free (ready, no lease);
// 2. a process still holds slot-a (a file in it open, as a CLI's child holds it for a while after its session ends:
//    the incident's "busy" leases); B1's next lane, started then, can't be lent slot-a: it waits for a slot, and its
//    status says what holds the slot (slot-a, a process in it), never that every slot is in use;
// 3. the process ends, and nothing else changes (no board or lane change, no session ending): the lane is lent slot-a
//    and B1 starts there.
// Through the Agent API (POST /v1/lanes, as the Assistant starts a lane: HR1 on HI-2466 round 1), the slot held by
// what B1's own run left there (the incident's: a Windows Sandbox server started from the agent's slot, its working
// folder slot-a, outliving the session):
// 4. B1, in a turn in slot-a, starts a process that outlives it (detached, a file in slot-a open); its lane is ended
//    and its next one recorded over it while its turn still runs: Combwork leaves the running builder as it is and gives it
//    the lane's first card once it is free. Its turn ends and it is stopped; the card's start is refused while the
//    process holds slot-a, its status (HI-2468) and its row in the Progress panel naming slot-a and the program B1's run left
//    (text, hover, screenshot); once the process ends, the card starts in slot-a with no other call;
// 5. the Assistant's second sighting: B1 stopped, a process holding slot-a, a lane recorded through the API waits for a
//    slot, its row in the Progress panel saying what holds it (screenshot), and is lent slot-a once the process ends.
// HI-2467, Windows Sandbox's broker (a stand-in whose current folder is slot-a, CW_TEST_SYSTEM_BROKER):
// 6. a broker working elsewhere while a process holds slot-a: only the process is said; the broker working in slot-a
//    once the process has gone: a retry names it, idle (status and the Progress panel's row, screenshot); a Sandbox
//    starting and stopping: later retries say so; the broker ending: the lane is lent slot-a with no other call.
// Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { DatabaseSync } = require('node:sqlite')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 90000

const at = (x) => path.join(lib.WORK, `laneslotretry-${x}`)
const userData = at('profile')
const ws = at('ws')
const home = at('claude-home')
const tools = at('tools')
const shots = at('shots')
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47790))
const identity = { name: 'Combwork Slot Retry Test', email: 'slotretry@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** Whether a folder can be renamed now (Combwork's own look at a free slot, slots.ts quiet): nothing holds it. */
const renamable = (dir) => {
  try {
    fs.renameSync(dir, `${dir}.probe`)
  } catch {
    return false
  }
  fs.renameSync(`${dir}.probe`, dir)
  return true
}

;(async () => {
  for (const d of [userData, ws, `${ws}.worktrees`, tools]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(tools, { recursive: true })
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.combwork/\n' })
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.git(alpha, ['branch', 'integration'])
  lib.git(alpha, ['config', 'user.name', identity.name])
  lib.git(alpha, ['config', 'user.email', identity.email])
  // What holds slot-a in step 2: a process with a file in it open (git-ignored, so the slot stays clean), until
  // hold-go.txt (bounded against a hang), writing its heartbeat meanwhile.
  const hold = path.join(tools, 'hold.js')
  const holdGo = path.join(tools, 'hold-go.txt')
  const holdBeat = path.join(tools, 'hold-beat.txt')
  fs.writeFileSync(hold, `const fs = require('fs'); const [file, go, beat, ms] = process.argv.slice(2); const fd = fs.openSync(file, 'w'); const t = Date.now(); const tick = () => { if (fs.existsSync(go) || Date.now() - t > Number(ms)) { fs.closeSync(fd); process.exit(0) } fs.writeFileSync(beat, String(Date.now())); setTimeout(tick, 100) }; tick()\n`)
  /** Whether the holder runs now: alive, its heartbeat fresh. */
  const holding = (p) => !!p && p.exitCode === null && fs.existsSync(holdBeat) && Date.now() - Number(fs.readFileSync(holdBeat, 'utf8') || 0) < 2000
  /** Whether a holder with heartbeat `beat` runs now (one started by B1's run: not this suite's child). */
  const beating = (beat) => fs.existsSync(beat) && Date.now() - Number(fs.readFileSync(beat, 'utf8') || 0) < 2000
  // Step 4's turn: B1's command starts a holder that outlives it (detached, as a sandbox server is), then runs until
  // turn-go.txt, so B1 is in a turn meanwhile.
  const turn = path.join(tools, 'turn.js')
  const turnGo = path.join(tools, 'turn-go.txt')
  const go4 = path.join(tools, 'hold4-go.txt')
  const beat4 = path.join(tools, 'hold4-beat.txt')
  fs.writeFileSync(turn, `const fs = require('fs'); const { spawn } = require('child_process'); const c = spawn(process.execPath, [${JSON.stringify(hold)}, require('path').join(process.cwd(), '.combwork', 'hold4.lock'), ${JSON.stringify(go4)}, ${JSON.stringify(beat4)}, '${HUNG_MS * 4}'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); const t = Date.now(); const tick = () => { if (fs.existsSync(${JSON.stringify(turnGo)}) || Date.now() - t > ${HUNG_MS * 3}) process.exit(0); setTimeout(tick, 100) }; tick()\n`)
  // Step 6's stand-in broker (HI-2467): only its current folder in the slot, no file open, until stand-go.txt (bounded),
  // writing its own PID/current-folder heartbeat. brokers.txt lists the stand-ins' ids (CW_TEST_SYSTEM_BROKER), brokers-active.txt the
  // Sandbox's own processes running now (CW_TEST_SYSTEM_BROKER_ACTIVE; while it is missing, none).
  const stand = path.join(tools, 'stand.js')
  fs.writeFileSync(stand, `const fs = require('fs'); const [go, beat, ms] = process.argv.slice(2); const t = Date.now(); const tick = () => { if (fs.existsSync(go) || Date.now() - t > Number(ms)) process.exit(0); fs.writeFileSync(beat, JSON.stringify({ pid: process.pid, cwd: process.cwd(), at: Date.now() })); setTimeout(tick, 100) }; tick()\n`)
  const brokers = path.join(tools, 'brokers.txt')
  const brokersActive = path.join(tools, 'brokers-active.txt')
  fs.writeFileSync(brokers, '')
  const env = { ...lib.fakeClaude(userData, home, [alpha, ws, slotA]), CW_TEST_SYSTEM_BROKER: brokers, CW_TEST_SYSTEM_BROKER_ACTIVE: brokersActive }
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  cfg.settings.agentApi = { ...cfg.settings.agentApi, enabled: true }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, CW_API_PORT: String(PORT), CW_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  let holder = null
  let stopBrokerStatus = null
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'combworkMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    await lib.setMaxAgents(inv, 1)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
    const slotNow = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Retry one')
    const c2 = await create('Retry two')
    const c3 = await create('Retry three')
    const c4 = await create('Retry four')
    const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
    /** A lane recorded through the Agent API, as the Assistant's cw_lane start records one. */
    const apiLane = async (cards) => {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/lanes`, { method: 'POST', headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'alpha', builder: 'B1', reviewer: 'R1', cards }) })
      return { status: res.status, body: await res.json().catch(() => null) }
    }
    /**
     * slot-a free and settled: B1 stopped, no lease, no writer (its run released: HI-2468's run found step 6 set up its
     * holders while B1's ended run still held slot-a, whose release then let the lend through), nothing holding it.
     */
    const settled = async () => !(await live(b1.id)) && !(await slotNow())?.lease && !(await slotNow())?.writer && renamable(slotA)
    const laneOf = async (n) => (await inv('lanes:list', { all: true })).find((l) => !l.endedAt && l.cards.some((c) => c.number === n))
    /** The Progress panel's Lanes tab, opened (the rail toggles the panel: clicked only while it is closed). */
    const panel = page.locator('.progress-panel')
    const openLanes = async () => {
      if ((await panel.count()) === 0) await page.locator('.progress-rail').click().catch(() => undefined)
      await until(async () => (await panel.count()) === 1, HUNG_MS)
      await panel.locator('.progress-tab[data-tab="lanes"]').click()
    }
    const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)
    /** The lane's status as it changes, each new one with when (ms from `t0`), until `stop` (what HR1 asked to see). */
    const watchStatus = (n, t0) => {
      const seen = []
      let last = ''
      const watching = { on: true }
      const look = async () => {
        while (watching.on) {
          const l = await laneOf(n).catch(() => null)
          const s = await slotNow().catch(() => null)
          const now = JSON.stringify({ state: l?.state, status: l?.status ? { reason: l.status.reason, why: l.status.why, slot: l.status.slot, held: l.status.held, broker: l.status.broker, idle: l.status.idle } : null, slot: l?.slot ?? null, lease: s?.lease?.lane ?? null, b1: (await live(b1.id).catch(() => null))?.status ?? 'stopped' })
          if (now !== last) seen.push(`${Date.now() - t0} ms ${now}`)
          last = now
          await new Promise((r) => setTimeout(r, 250))
        }
      }
      const done = look()
      return async () => ((watching.on = false), await done, seen)
    }

    // --- 1. The first lane in slot-a, then ended: B1 stopped, slot-a free.
    const first = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1] })
    check('the first lane is lent slot-a', first.slot === 'slot-a' && first.started.every((s) => s.how !== 'failed'), JSON.stringify(first))
    check('B1 runs in slot-a', !!(await until(async () => same((await live(b1.id))?.cwd, slotA) && ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)), JSON.stringify(await live(b1.id)))
    await inv('lanes:end', first.lane.id, true)
    check('the first lane is ended, B1 stopped, slot-a free', !!(await until(async () => !!(await lane(first.lane.id))?.endedAt && !(await live(b1.id)) && (await slotNow())?.state === 'ready' && !(await slotNow())?.lease, HUNG_MS)), JSON.stringify(await slotNow()))
    // What B1's run left in slot-a (its processes exiting) gone first, so only the holder holds it from here.
    check('…nothing left holding slot-a', !!(await until(() => renamable(slotA), HUNG_MS)))

    // --- 2. A process holds slot-a: B1's next lane waits for a slot, and says what holds it.
    fs.mkdirSync(path.join(slotA, '.combwork'), { recursive: true })
    holder = spawn(process.execPath, [hold, path.join(slotA, '.combwork', 'hold.lock'), holdGo, holdBeat, String(HUNG_MS * 3)], { cwd: tools, stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
    const exited = new Promise((r) => holder.once('exit', r))
    check('a process holds slot-a', !!(await until(() => holding(holder) && !renamable(slotA), HUNG_MS)))
    const second = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c2] })
    check('B1’s next lane waits for a slot, nobody started', !!second.waitingForSlot && second.started.length === 0 && !(await live(b1.id)), JSON.stringify(second))
    const named = async () => {
      const l = await lane(second.lane.id)
      return l?.state === 'paused' && l.status?.reason === 'slot' && l.status.slot === 'slot-a' && l.status.held === 'process' ? l : null
    }
    check('…paused, its status naming slot-a and the process in it', !!(await until(named, HUNG_MS)), JSON.stringify((await lane(second.lane.id))?.status))
    check('…slot-a ready, with no lease, the process still holding it', !!(await until(async () => (await slotNow())?.state === 'ready' && !(await slotNow())?.lease, HUNG_MS)) && holding(holder), JSON.stringify(await slotNow()))
    // The passes its start asked for (its own, the lanes' and the board's) are over: no try to lend it a slot for 2 s,
    // so what lends it one from here is what notices the process has gone.
    const lastTry = () => {
      const db = new DatabaseSync(path.join(ws, '.combwork', 'combwork.db'), { readOnly: true })
      try {
        return Date.parse(db.prepare('SELECT MAX(from_at) AS at FROM slot_leases WHERE lane = ?').get(second.lane.id)?.at ?? '') || 0
      } finally {
        db.close()
      }
    }
    check('…its start’s tries to lend it slot-a are over', !!(await until(() => Date.now() - lastTry() > 2000, HUNG_MS)) && holding(holder) && !(await slotNow())?.lease)

    // --- 3. The process ends, nothing else changes: the lane is lent slot-a, B1 starts there.
    fs.writeFileSync(holdGo, 'go')
    await exited
    check('the lane is lent slot-a once the process has gone', !!(await until(async () => (await lane(second.lane.id))?.slot === 'slot-a', HUNG_MS)), JSON.stringify(await lane(second.lane.id)))
    check('…B1 starts there', !!(await until(async () => same((await live(b1.id))?.cwd, slotA), HUNG_MS)), JSON.stringify(await live(b1.id)))
    check('…and its lane waits for a slot no more', (await lane(second.lane.id))?.status?.reason !== 'slot', JSON.stringify((await lane(second.lane.id))?.status))

    // --- 4. Through the API, B1 still in its turn: its run leaves a process holding slot-a.
    const key = lib.ptyKey(alpha, b1.id)
    await lib.typeLine(inv, key, home, 'B1', `shell: node "${turn}"`, { taken: async () => beating(beat4) && (await live(b1.id))?.status === 'working', ready: async () => ['ready', 'finished'].includes((await live(b1.id))?.status), hungMs: HUNG_MS })
    check('B1 is in a turn in slot-a, a process it started holding slot-a', !!(await until(async () => beating(beat4) && (await live(b1.id))?.status === 'working' && !renamable(slotA), HUNG_MS)), JSON.stringify(await live(b1.id)))
    await inv('lanes:end', second.lane.id, true)
    const t4 = Date.now()
    const stop4 = watchStatus(c3, t4)
    const third = await apiLane([c3])
    check('B1’s next lane, recorded through the API while B1 is still in its turn: B1 left as it is, Combwork to give it the card', third.status === 200 && (await live(b1.id))?.status === 'working', JSON.stringify(third.body))
    fs.writeFileSync(turnGo, 'go')
    check('…B1’s turn ends and it is stopped (its old lane’s lease gone), the process still holding slot-a', !!(await until(async () => !(await live(b1.id)), HUNG_MS)) && beating(beat4) && !renamable(slotA), JSON.stringify(await live(b1.id)))
    check('…its card isn’t started while slot-a is held', !!(await until(async () => (await laneOf(c3))?.status?.reason === 'startWait' || (await laneOf(c3))?.status?.reason === 'slot', HUNG_MS)) && (await card(c3))?.column === 'todo' && beating(beat4), JSON.stringify((await laneOf(c3))?.status))
    // HI-2468: its start refused for its slot (never a wait for a slot: B1 ran as it was recorded), its status naming
    // slot-a and what holds it: the program B1's own last run left there (slot-a's writer, so no slot is free), in the
    // lane's status and in its row in the Progress panel's Lanes tab, its hover saying it whole.
    const refusedHeld = async () => {
      const s = (await laneOf(c3))?.status
      return s?.reason === 'startWait' && s.why === 'refused' && s.slot === 'slot-a' && s.held === 'left' && s.heldBy === 'B1' && s.program === 'node' && s.agent === 'B1' ? s : null
    }
    const held4 = await until(refusedHeld, HUNG_MS)
    check('…its start refused, its status naming slot-a and the program B1’s last run left in it', !!held4 && (await card(c3))?.column === 'todo', JSON.stringify((await laneOf(c3))?.status))
    await openLanes()
    const why4 = panel.locator(`.progress-lane[data-lane="${(await laneOf(c3)).id}"] .progress-lane-why`)
    const said4 = `${(await card(c3)).key} waits to start: its start was refused for now, slot-a still in use (B1’s last run left node${held4?.more ? ` and ${held4.more} more` : ''} running in it), and Combwork tries again`
    check(`…its row in the Progress panel says "${said4}"`, !!(await until(async () => ((await why4.textContent().catch(() => '')) ?? '') === said4, HUNG_MS)), await why4.textContent().catch(() => ''))
    check('…and its hover says it whole', ((await why4.getAttribute('title').catch(() => '')) ?? '').startsWith(said4), await why4.getAttribute('title').catch(() => ''))
    fs.mkdirSync(shots, { recursive: true })
    await panel.screenshot({ path: path.join(shots, 'lane-start-held.png') })
    fs.writeFileSync(go4, 'go')
    check('the process ends: the card starts in slot-a with no other call, B1 there', !!(await until(async () => (await card(c3))?.column === 'doing' && same((await live(b1.id))?.cwd, slotA) && (await laneOf(c3))?.slot === 'slot-a', HUNG_MS)), JSON.stringify({ card: (await card(c3))?.column, lane: await laneOf(c3), b1: await live(b1.id) }))
    console.log(`INFO step 4's lane, as it went: ${(await stop4()).join(' | ')}`)

    // --- 5. Through the API, B1 stopped, a process holding slot-a: the lane waits, says why, and is lent it once free.
    const third4 = await laneOf(c3)
    await inv('lanes:end', third4.id, true)
    check('the lane is ended, B1 stopped, slot-a free and held by nothing', !!(await until(settled, HUNG_MS)), JSON.stringify(await slotNow()))
    const go5 = path.join(tools, 'hold5-go.txt')
    const beat5 = path.join(tools, 'hold5-beat.txt')
    const holder5 = spawn(process.execPath, [hold, path.join(slotA, '.combwork', 'hold5.lock'), go5, beat5, String(HUNG_MS * 3)], { cwd: tools, stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
    const exited5 = new Promise((r) => holder5.once('exit', r))
    check('a process holds slot-a', !!(await until(() => beating(beat5) && !renamable(slotA), HUNG_MS)))
    const t5 = Date.now()
    const stop5 = watchStatus(c4, t5)
    const fourth = await apiLane([c4])
    check('a lane recorded through the API over B1, stopped: it waits for a slot', fourth.status === 200 && !(await live(b1.id)), JSON.stringify(fourth.body))
    check('…its status naming slot-a and the process in it', !!(await until(async () => (await laneOf(c4))?.status?.reason === 'slot' && (await laneOf(c4))?.status?.held === 'process' && (await laneOf(c4))?.status?.slot === 'slot-a', HUNG_MS)), JSON.stringify((await laneOf(c4))?.status))
    // The window: its row in the Progress panel's Lanes tab says what holds the slot.
    await openLanes()
    const why =panel.locator(`.progress-lane[data-lane="${(await laneOf(c4)).id}"] .progress-lane-why`)
    const said = 'waiting for slot-a: a process still has a file or folder in it open'
    check(`…its row in the Progress panel says "${said}"`, !!(await until(async () => ((await why.textContent().catch(() => '')) ?? '') === said, HUNG_MS)), await why.textContent().catch(() => ''))
    fs.mkdirSync(shots, { recursive: true })
    await panel.screenshot({ path: path.join(shots, 'lane-slot-held.png') })
    // The row's reason is cut short in a narrow panel: its title (the hover) says it whole.
    check('…and its hover says it whole', ((await why.getAttribute('title').catch(() => '')) ?? '').startsWith(said), await why.getAttribute('title').catch(() => ''))
    fs.writeFileSync(go5, 'go')
    await exited5
    check('the process ends: the lane is lent slot-a with no other call, B1 starts there', !!(await until(async () => (await laneOf(c4))?.slot === 'slot-a' && same((await live(b1.id))?.cwd, slotA), HUNG_MS)), JSON.stringify({ lane: await laneOf(c4), b1: await live(b1.id) }))
    check('…its row waits for a slot no more', !!(await until(async () => ((await why.textContent().catch(() => '')) ?? '') !== said, HUNG_MS)), await why.textContent().catch(() => ''))
    console.log(`INFO step 5's lane, as it went: ${(await stop5()).join(' | ')}`)

    // --- 6. HI-2467: Windows Sandbox's broker working in slot-a (a stand-in: a process whose current folder is slot-a,
    // its id in CW_TEST_SYSTEM_BROKER, so its path, read by the helper, is taken as the broker's). Named only while it
    // is seen working there, idle or not as the Sandbox's own processes run, looked at again on each retry.
    await inv('lanes:end', (await laneOf(c4)).id, true)
    check('the lane is ended, B1 stopped, slot-a free and held by nothing', !!(await until(settled, HUNG_MS)), JSON.stringify(await slotNow()))
    const standGo = path.join(tools, 'stand-go.txt')
    let standInstance = 0
    /** A stand-in broker, ready only once that process has reported its own PID and working folder. */
    const standIn = (cwd) => {
      const standBeat = path.join(tools, `stand-beat-${++standInstance}.json`)
      const c = spawn(process.execPath, [stand, standGo, standBeat, String(HUNG_MS * 3)], { cwd, stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
      fs.writeFileSync(brokers, `${c.pid}\n`)
      const ready = () => {
        try {
          const beat = JSON.parse(fs.readFileSync(standBeat, 'utf8'))
          return c.exitCode === null && beat.pid === c.pid && same(beat.cwd, cwd) && Date.now() - beat.at < 2000 ? beat : null
        } catch {
          return null // The child hasn't written yet, or this read overlapped its next heartbeat.
        }
      }
      return { c, ready, exited: new Promise((r) => c.once('exit', r)) }
    }
    // 6a. The broker working elsewhere while a process holds slot-a (a file in it open): only the process is said.
    const go6 = path.join(tools, 'hold6-go.txt')
    const beat6 = path.join(tools, 'hold6-beat.txt')
    const holder6 = spawn(process.execPath, [hold, path.join(slotA, '.combwork', 'hold6.lock'), go6, beat6, String(HUNG_MS * 3)], { cwd: tools, stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
    const exited6 = new Promise((r) => holder6.once('exit', r))
    const away = standIn(tools)
    check('a process holds slot-a, the broker running elsewhere', !!(await until(() => beating(beat6) && away.ready() && !renamable(slotA), HUNG_MS)))
    const c5 = await create('Retry five')
    const fifth = await apiLane([c5])
    stopBrokerStatus = watchStatus(c5, Date.now())
    check('a lane recorded through the API: it waits for a slot', fifth.status === 200 && !(await live(b1.id)), JSON.stringify(fifth.body))
    const status5 = async () => (await laneOf(c5))?.status ?? null
    check('…its status names the process, not the broker working elsewhere', !!(await until(async () => (await status5())?.reason === 'slot' && (await status5())?.held === 'process' && !(await status5())?.broker, HUNG_MS)), JSON.stringify(await status5()))
    fs.writeFileSync(standGo, 'go')
    await away.exited
    fs.rmSync(standGo, { force: true })
    // 6b. The broker working in slot-a, the process gone: the broker is named, idle (none of the Sandbox's processes run).
    const here = standIn(slotA)
    // HI-2489: the away broker's fresh heartbeat and holder6's file used to satisfy this before here had started.
    // Keep the file held until this new process is ready, so its startup leaves no quiet gap for a waiting lend.
    const hereReady = await until(() => {
      const beat = here.ready()
      return beat && !renamable(slotA) ? beat : null
    }, HUNG_MS)
    check('the new broker reports its own PID and slot-a before the file closes', !!hereReady, JSON.stringify(here.ready()))
    if (!hereReady) throw new Error('the slot broker was not ready before closing the file holder')
    console.log(`INFO broker handoff ready: ${JSON.stringify(hereReady)}`)
    fs.writeFileSync(go6, 'go')
    await exited6
    const brokerSaid = (idle) => async () => {
      const s = await status5()
      return s?.reason === 'slot' && s.held === 'broker' && s.broker === 'WindowsSandboxServer' && s.idle === idle ? s : null
    }
    check('…once the file is closed, a retry names the broker working in slot-a, idle', !!(await until(brokerSaid(true), HUNG_MS)), JSON.stringify(await status5()))
    const why6 = panel.locator(`.progress-lane[data-lane="${(await laneOf(c5)).id}"] .progress-lane-why`)
    const said6 = 'waiting for slot-a: a process still has a file or folder in it open: Windows Sandbox’s broker (WindowsSandboxServer) is working in it, with no Sandbox running'
    check(`…its row in the Progress panel says "${said6}"`, !!(await until(async () => ((await why6.textContent().catch(() => '')) ?? '') === said6, HUNG_MS)), await why6.textContent().catch(() => ''))
    await panel.screenshot({ path: path.join(shots, 'lane-slot-broker.png') })
    // 6c. A Sandbox starts (its client running): a later retry says so; it stops again: idle again.
    fs.writeFileSync(brokersActive, 'windowssandboxclient.exe\n')
    check('a Sandbox running: a later retry says the broker works in slot-a with a Sandbox running', !!(await until(brokerSaid(false), HUNG_MS)), JSON.stringify(await status5()))
    fs.rmSync(brokersActive, { force: true })
    check('…and idle again once it has stopped', !!(await until(brokerSaid(true), HUNG_MS)), JSON.stringify(await status5()))
    // 6d. The broker ends: the lane is lent slot-a with no other call, and its status names nothing any more.
    fs.writeFileSync(standGo, 'go')
    await here.exited
    check('the broker ends: the lane is lent slot-a with no other call, B1 starts there', !!(await until(async () => (await laneOf(c5))?.slot === 'slot-a' && same((await live(b1.id))?.cwd, slotA), HUNG_MS)), JSON.stringify({ lane: await laneOf(c5), b1: await live(b1.id) }))
    check('…its status waits for a slot no more', (await status5())?.reason !== 'slot', JSON.stringify(await status5()))
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    if (stopBrokerStatus) console.log(`INFO step 6's lane, as it went: ${(await stopBrokerStatus()).join(' | ')}`)
    for (const f of [holdGo, turnGo, path.join(tools, 'hold4-go.txt'), path.join(tools, 'hold5-go.txt'), path.join(tools, 'hold6-go.txt'), path.join(tools, 'stand-go.txt')]) fs.writeFileSync(f, 'go')
    if (holder && holder.exitCode === null) holder.kill()
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
