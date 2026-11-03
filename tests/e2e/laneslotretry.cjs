// HI-2466: a lane that waits for a slot gets it once what held the slot is gone, with no restart. On fake Claude Code
// agents, the Assistant off, one slot (Maximum agents: 1), Pair with Hive merges and each card in its own folder:
// 1. B1's first lane is lent slot-a, B1 runs there; the lane is ended and B1 stopped, slot-a free (ready, no lease);
// 2. a process still holds slot-a (a file in it open, as a CLI's child holds it for a while after its session ends:
//    the incident's "busy" leases); B1's next lane, started then, can't be lent slot-a: it waits for a slot, and its
//    status says what holds the slot (slot-a, a process in it), never that every slot is in use;
// 3. the process ends, and nothing else changes (no board or lane change, no session ending): the lane is lent slot-a
//    and B1 starts there.
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
const alpha = path.join(ws, 'alpha')
const slotA = path.join(`${ws}.worktrees`, 'alpha', 'slot-a')
const PORT = Number(lib.port(47790))
const identity = { name: 'Hive Slot Retry Test', email: 'slotretry@example.com' }
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
/** Whether a folder can be renamed now (Hive's own look at a free slot, slots.ts quiet): nothing holds it. */
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
  lib.gitProject(alpha, { 'a.txt': 'a\n', '.gitignore': '.hive/\n' })
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
  const env = lib.fakeClaude(userData, home, [alpha, ws, slotA])
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const h = await lib.launch({ userData, env: { ...env, HIVE_API_PORT: String(PORT), HIVE_TEST_TIPS: 'off' } })
  const { app, page, inv } = h
  let holder = null
  try {
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.waitForProvider(inv)
    await lib.openWorkspace(inv, page, ws)
    const until = (fn, ms) => lib.until(fn, ms, 250)
    await inv('workflow:setOptions', alpha, { preset: null, options: { review: 'agent', noSelfReview: true, finish: 'hiveMerges', folder: 'slots', target: 'integration', style: 'merge', preChecks: [], mergeChecks: [], identity, okBefore: { mode: 'never', labels: [] } } })
    const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
    const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'reviewer' })
    await lib.setMaxAgents(inv, 1)
    const live = async (id) => (await inv('session:live')).find((s) => same(s.projectPath, alpha) && s.agentId === id) ?? null
    const lane = async (id) => (await inv('lanes:list', { all: true })).find((l) => l.id === id)
    const slotNow = async () => (await inv('slots:list', alpha)).find((s) => s.name === 'slot-a')
    const create = async (title) => (await inv('tasks:create', { title, project: 'alpha' })).number
    const c1 = await create('Retry one')
    const c2 = await create('Retry two')

    // --- 1. The first lane in slot-a, then ended: B1 stopped, slot-a free.
    const first = await inv('lanes:start', alpha, { builder: b1.id, reviewer: r1.id, cards: [c1] })
    check('the first lane is lent slot-a', first.slot === 'slot-a' && first.started.every((s) => s.how !== 'failed'), JSON.stringify(first))
    check('B1 runs in slot-a', !!(await until(async () => same((await live(b1.id))?.cwd, slotA) && ['ready', 'finished'].includes((await live(b1.id))?.status), HUNG_MS)), JSON.stringify(await live(b1.id)))
    await inv('lanes:end', first.lane.id, true)
    check('the first lane is ended, B1 stopped, slot-a free', !!(await until(async () => !!(await lane(first.lane.id))?.endedAt && !(await live(b1.id)) && (await slotNow())?.state === 'ready' && !(await slotNow())?.lease, HUNG_MS)), JSON.stringify(await slotNow()))
    // What B1's run left in slot-a (its processes exiting) gone first, so only the holder holds it from here.
    check('…nothing left holding slot-a', !!(await until(() => renamable(slotA), HUNG_MS)))

    // --- 2. A process holds slot-a: B1's next lane waits for a slot, and says what holds it.
    fs.mkdirSync(path.join(slotA, '.hive'), { recursive: true })
    holder = spawn(process.execPath, [hold, path.join(slotA, '.hive', 'hold.lock'), holdGo, holdBeat, String(HUNG_MS * 3)], { cwd: tools, stdio: 'ignore', windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } })
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
      const db = new DatabaseSync(path.join(ws, '.hive', 'hive.db'), { readOnly: true })
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
  } catch (e) {
    check('no exception', false, e?.stack ?? String(e))
  } finally {
    fs.writeFileSync(holdGo, 'go')
    if (holder && holder.exitCode === null) holder.kill()
    await app.close().catch(() => undefined)
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
})()
