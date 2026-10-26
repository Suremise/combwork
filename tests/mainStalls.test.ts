// "The main process was busy" (#1109): a gap spanning the PC's sleep isn't a stall, and a real one names the work that
// overlapped it (IPC calls, Agent API requests, hooks, and HI-1692's synchronous steps: a database's BEGIN or commit) and
// the main thread's CPU time. A gap the watchdog thread had too is the whole process paused, not a stall (HI-1692).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiLabel, beginWork, hookLabel, stallClock, stallWatcher, timedStep, workDuring, STALL_TIMING } from '../src/main/mainStalls'
import { noteStep } from '../src/main/stallWork'
import { pausedAlongside, watchdogTick, WATCHDOG_SLOTS } from '../src/main/stallWatchdog'

let now = 0
let base = 0
const realMono = stallClock.mono

/** Work that has just ended after `ms`. */
function ran(label: string, ms: number): void {
  const end = now
  now = end - ms
  const done = beginWork(label)
  now = end
  done()
}

/** A watcher on a fake clock and loop delay: its deferred decisions run when settle() is called. */
function watcher() {
  let delay = 0
  let cpu = 0
  const deferred: (() => void)[] = []
  const warnings: string[] = []
  const infos: string[] = []
  /** Whether the watchdog thread stopped over a span too (the whole process paused). */
  const watchdog = { paused: false, asked: [] as [number, number][] }
  const w = stallWatcher({
    now: () => now,
    longestDelayMs: () => {
      const d = delay
      delay = 0
      return d
    },
    cpuMs: () => cpu,
    defer: (fn) => deferred.push(fn),
    warn: (l) => warnings.push(l),
    info: (l) => infos.push(l),
    pausedAlongside: (from, to) => {
      watchdog.asked.push([from, to])
      return watchdog.paused
    }
  })
  return {
    w,
    warnings,
    infos,
    watchdog,
    /** The loop held for `ms` (using `cpuMs` of CPU), then the next tick. */
    stall(ms: number, cpuMs = ms) {
      now += ms
      cpu += cpuMs
      delay = ms
      w.tick()
    },
    tick(ms = STALL_TIMING.every) {
      now += ms
      w.tick()
    },
    /** The decisions deferred so far (the clock left as it is, so the next tick isn't late). */
    settle() {
      for (const fn of deferred.splice(0)) fn()
    }
  }
}

beforeEach(() => {
  // Each test on its own stretch of the fake clock, so work recorded by another never overlaps.
  base += 10_000_000
  now = base
  stallClock.mono = () => now
})
afterEach(() => {
  stallClock.mono = realMono
})

describe('main process stalls (#1109)', () => {
  it('does not warn for a gap spanning a suspend and resume, and says why in an info line', () => {
    const s = watcher()
    s.tick()
    s.w.power()
    s.stall(18_695, 3)
    s.w.power()
    s.settle()
    expect(s.warnings).toEqual([])
    expect(s.infos).toEqual(['The main process was paused for 18695 ms while the PC slept: not counted as busy'])
  })

  it('does not warn when the resume is only told after the late timer', () => {
    const s = watcher()
    s.tick()
    s.stall(5087, 2)
    s.w.power()
    s.settle()
    expect(s.warnings).toEqual([])
  })

  it('warns for a stall with no power event, naming the IPC call that blocked and the CPU time', () => {
    const s = watcher()
    s.tick()
    const done = beginWork('ipc test:block')
    s.stall(1500, 1490)
    done()
    s.settle()
    expect(s.warnings).toEqual(['The main process was busy for 1500 ms (main thread CPU 1490 ms); during it: ipc test:block (1.5 s)'])
  })

  it('names work still running and work that ended, the most overlap first, five at most, and counts the rest', () => {
    const s = watcher()
    s.tick()
    const long = beginWork('ipc git:status')
    ran('api GET /v1/tasks', 0)
    s.stall(2000)
    ran('api POST /v1/tasks/:n', 1900)
    ran('hook PreToolUse', 60)
    ran('hook Stop', 40)
    ran('hook PostToolUse', 30)
    ran('hook Notification', 20)
    now += 1000
    s.settle()
    long()
    expect(s.warnings[0]).toBe('The main process was busy for 2000 ms (main thread CPU 2000 ms); during it: ipc git:status (3.0 s, still running), api POST /v1/tasks/:n (1.9 s), hook PreToolUse (0.1 s), hook Stop (0.0 s), hook PostToolUse (0.0 s) and 1 more')
  })

  it('keeps the work a stall overlapped, however much ends before the warning is decided', () => {
    const s = watcher()
    s.tick()
    const done = beginWork('ipc culprit:block')
    s.stall(1500)
    done()
    for (let i = 0; i < 201; i++) ran('api GET /v1/tasks', 1)
    s.settle()
    expect(s.warnings[0]).toContain('during it: ipc culprit:block (1.5 s)')
  })

  it('names an API request still running when the warning is decided, by its route once known', () => {
    const s = watcher()
    s.tick()
    let route = '(no route)'
    const done = beginWork(() => apiLabel('POST', route))
    route = '/v1/tasks/:n'
    s.stall(1500)
    now += 2000
    s.settle()
    done()
    expect(s.warnings[0]).toContain('during it: api POST /v1/tasks/:n (3.5 s, still running)')
  })

  it('leaves out the requests that wait by design, which would crowd out the work that blocked', () => {
    const s = watcher()
    const waits = ['api GET /v1/events', 'api POST /v1/tasks/wait', 'api POST /v1/agents/wait'].map((l) => beginWork(l))
    for (let i = 0; i < 10; i++) s.tick()
    const done = beginWork('ipc app:info')
    s.stall(1500)
    done()
    now += 2500
    s.settle()
    for (const w of waits) w()
    expect(s.warnings[0]).toMatch(/during it: ipc app:info \(1\.5 s\)$/)
  })

  it('names a request begun long before that woke from an await, blocked, and is awaiting again (HR2, round 3)', () => {
    const s = watcher()
    const open = beginWork('api POST /v1/tasks/:n')
    for (let i = 0; i < 10; i++) s.tick()
    s.stall(1500, 1500)
    now += 3000
    s.settle()
    open()
    expect(s.warnings[0]).toContain('during it: api POST /v1/tasks/:n (9.5 s, still running)')
  })

  it('leaves out a wait by design even when it ended during the stall, and names a request begun in it', () => {
    const s = watcher()
    const wait = beginWork('api POST /v1/agents/wait')
    for (let i = 0; i < 10; i++) s.tick()
    const fresh = beginWork('api GET /v1/tasks')
    s.stall(1500)
    wait()
    s.settle()
    fresh()
    expect(s.warnings[0]).toMatch(/during it: api GET \/v1\/tasks \(1\.5 s, still running\)$/)
  })

  it("names hooks and requests only by names Hive knows, never by what a client sent", () => {
    expect(hookLabel(false, { hook_event_name: 'PreToolUse' })).toBe('hook PreToolUse')
    expect(hookLabel(false, { hook_event_name: 'PrivateCustomerName' })).toBe('hook (other event)')
    expect(hookLabel(false, null)).toBe('hook (other event)')
    expect(hookLabel(true, { hook_event_name: 'Stop' })).toBe('hook status line')
    expect(apiLabel('GET', '/v1/tasks')).toBe('api GET /v1/tasks')
    expect(apiLabel('PrivateCustomerName', '(no route)')).toBe('api other (no route)')
    expect(apiLabel(undefined, '(no route)')).toBe('api other (no route)')
  })

  it('says when nothing tracked was running, and leaves CPU out where it is unknown', () => {
    const lines: string[] = []
    let t = now
    const w = stallWatcher({ now: () => t, longestDelayMs: () => 0, cpuMs: () => null, defer: (fn) => fn(), warn: (l) => lines.push(l), info: () => undefined })
    t += 500 + 800
    w.tick()
    expect(lines).toEqual(['The main process was busy for 800 ms; nothing marked was under way (no IPC call, Agent API request or hook, nor a database or kept file step)'])
  })

  it('ignores short delays and a power event long before the stall', () => {
    const s = watcher()
    s.w.power()
    for (let i = 0; i < 10; i++) s.tick()
    s.stall(200)
    s.settle()
    expect(s.warnings).toEqual([])
    s.stall(900)
    s.settle()
    expect(s.warnings).toHaveLength(1)
  })

  it('warns at most once a minute, counting the stalls left out', () => {
    const s = watcher()
    s.stall(400)
    s.settle()
    s.stall(400)
    s.settle()
    s.stall(400)
    s.settle()
    expect(s.warnings).toHaveLength(1)
    for (let i = 0; i < 120; i++) s.tick()
    s.stall(600)
    s.settle()
    expect(s.warnings).toHaveLength(2)
    expect(s.warnings[1]).toMatch(/; 2 more stall\(s\) since the last warning, not logged$/)
  })

  it('lists the work overlapping a span only', () => {
    ran('ipc before', 100)
    now += 1000
    const done = beginWork('ipc inside')
    now += 100
    done()
    now += 1000
    expect(workDuring(base + 900, base + 1200).work).toEqual(['ipc inside (0.1 s)'])
  })
})

describe('the steps that can wait, and a whole-process pause (HI-1692)', () => {
  it('names a synchronous step that held main: a busy wait in BEGIN IMMEDIATE, with no CPU', () => {
    const s = watcher()
    s.tick()
    // The step blocks the thread: the clock moves on inside it, and the next tick finds the loop held as long.
    timedStep('db begin hive.db', () => s.stall(5200, 3))
    s.settle()
    expect(s.warnings).toEqual(['The main process was busy for 5200 ms (main thread CPU 3 ms); during it: db begin hive.db (5.2 s)'])
  })

  it('names the step over the IPC call that only waited behind it: the most overlap first', () => {
    const s = watcher()
    s.tick()
    const call = beginWork('ipc tasks:list')
    timedStep('db commit hive.db', () => s.stall(900, 0))
    call()
    s.settle()
    expect(s.warnings[0]).toMatch(/during it: (db commit hive\.db \(0\.9 s\), ipc tasks:list|ipc tasks:list \(0\.9 s\), db commit hive\.db)/)
    expect(s.warnings[0]).toContain('db commit hive.db (0.9 s)')
  })

  it("names a log write noted only because it was slow: a restore point freezing the profile's drive held hooks.log", () => {
    const s = watcher()
    s.tick()
    const call = beginWork('hook PreToolUse')
    const start = now
    s.stall(7957, 0)
    noteStep('log write hooks.log', start)
    call()
    s.settle()
    expect(s.warnings[0]).toMatch(/^The main process was busy for 7957 ms \(main thread CPU 0 ms\); during it: /)
    expect(s.warnings[0]).toContain('log write hooks.log (8.0 s)')
  })

  it("a stall the watchdog thread had too is the whole process paused: an info line, not counted as busy", () => {
    const s = watcher()
    s.tick()
    s.watchdog.paused = true
    s.stall(7957, 0)
    s.settle()
    expect(s.warnings).toEqual([])
    expect(s.infos).toEqual(["The main process was paused for 7957 ms with the rest of Hive's process (its watchdog thread stopped too: the PC or the process was paused): not counted as busy"])
    // Asked about the stall's own span.
    expect(s.watchdog.asked.at(-1)).toEqual([now - 7957, now])
    // One it ticked through is main's own: warned.
    s.watchdog.paused = false
    s.stall(7119, 0)
    s.settle()
    expect(s.warnings[0]).toMatch(/^The main process was busy for 7119 ms/)
  })

  it("the watchdog's ticks: a gap of its own covering most of a span is a pause; one it ticked through isn't; one it can't speak for isn't", () => {
    const ticks = new Float64Array(WATCHDOG_SLOTS)
    let t = 1_000_000
    for (let i = 0; i < 10; i++) watchdogTick(ticks, (t += 50))
    // Paused 8 s with the rest of the process, then ticking again.
    const from = t
    watchdogTick(ticks, (t += 8000))
    for (let i = 0; i < 10; i++) watchdogTick(ticks, (t += 50))
    expect(pausedAlongside(ticks, from + 100, from + 7900)).toBe(true)
    // A stall of main's own, at a time it ticked through.
    expect(pausedAlongside(ticks, t - 400, t - 100)).toBe(false)
    // Mostly outside its gap: not a pause of the whole process.
    expect(pausedAlongside(ticks, from + 6000, from + 12_000)).toBe(false)
    // After its last tick: it can't say.
    expect(pausedAlongside(ticks, t + 100, t + 500)).toBe(false)
  })
})
