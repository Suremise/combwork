// "The main process was busy" (#1109): a gap spanning the PC's sleep isn't a stall, and a real one names the work that
// overlapped it (IPC calls, Agent API requests, hooks, and HI-1692's synchronous steps: a database's BEGIN or commit) and
// the main thread's CPU time. A gap the watchdog thread had too is the whole process paused, not a stall (HI-1692).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiLabel, beginWork, fileWaitWatcher, hookLabel, keepStall, recentStalls, resetStallsForTests, stallClock, stallWatcher, timedStep, workDuring, FILE_WAIT_TIMING, STALL_TIMING } from '../src/main/mainStalls'
import { MAIN_STALLS_KEPT, mostlyWaiting, type MainStall } from '../src/shared/mainStalls'
import { noteStep } from '../src/main/stallWork'
import { pausedAlongside, probeEnded, slowProbe, watchdogTick, PROBE_SLOW_MS, WATCHDOG_SLOTS } from '../src/main/stallWatchdog'

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
  /** The stalls kept for the Performance view (HI-1135), with their end. */
  const recorded: { stall: Omit<MainStall, 'at'>; end: number }[] = []
  const w = stallWatcher({
    record: (stall, end) => recorded.push({ stall, end }),
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
    recorded,
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
    s.w.power(true)
    s.settle()
    expect(s.warnings).toEqual([])
    expect(s.infos).toEqual(['The main process was paused for 18695 ms while the PC slept: not counted as busy'])
  })

  it('does not warn when the resume is only told after the late timer', () => {
    const s = watcher()
    s.tick()
    s.stall(5087, 2)
    s.w.power(true)
    s.settle()
    expect(s.warnings).toEqual([])
  })

  it('warns for a busy stall soon after a resume, even when the tick before it fell before the resume (HI-2317)', () => {
    const s = watcher()
    s.tick()
    s.w.power()
    s.stall(1500, 3)
    // The resume is told just after the late tick, and the next stall begins before the next tick: its `since` reaches
    // back past the resume, to within the grace a suspend gets.
    now += 50
    s.w.power(true)
    now += 100
    s.stall(1500)
    s.settle()
    expect(s.infos).toEqual(['The main process was paused for 1500 ms while the PC slept: not counted as busy'])
    expect(s.warnings).toEqual(['The main process was busy for 1500 ms (main thread CPU 1500 ms); nothing marked was under way (no IPC call, Agent API request or hook, nor a database or kept file step)'])
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

describe("the Performance view's stalls (HI-1135)", () => {
  beforeEach(() => resetStallsForTests())

  it('keeps a stall with its length and CPU, the step that held the thread apart from the work that overlapped it', () => {
    const s = watcher()
    s.tick()
    const call = beginWork('ipc tasks:list')
    let route = 'api POST /v1/tasks'
    const request = beginWork(() => route)
    timedStep('db commit hive.db', () => s.stall(900, 40))
    call()
    s.settle()
    expect(s.recorded).toHaveLength(1)
    const { stall, end } = s.recorded[0]
    expect(end).toBe(now)
    expect(stall).toMatchObject({ ms: 900, cpuMs: 40, stepsMore: 0, workMore: 0 })
    expect(stall.steps).toEqual([{ label: 'db commit hive.db', count: 1, ms: 900, running: false }])
    expect(stall.work).toEqual(expect.arrayContaining([{ label: 'ipc tasks:list', count: 1, ms: 900, running: false }, { label: 'api POST /v1/tasks', count: 1, ms: 900, running: true }]))
    // Copied as it was: a label made later, or the work ending later, doesn't change it.
    route = 'api POST /v1/changed'
    now += 5000
    request()
    expect(stall.work.find((w) => w.label.startsWith('api'))).toEqual({ label: 'api POST /v1/tasks', count: 1, ms: 900, running: true })
    // As the log says it, the same CPU.
    expect(s.warnings[0]).toMatch(/^The main process was busy for 900 ms \(main thread CPU 40 ms\)/)
  })

  it("lists each label once with its count and total, the longest total first, and counts the works of those left out (the Assistant's review)", () => {
    const s = watcher()
    s.tick()
    // A burst of one call, short each (a stall needs some overlap), beside one long call and six other labels.
    for (let i = 0; i < 4; i++) ran('ipc performance:stalls', 1)
    const long = beginWork('ipc queue:list')
    for (let i = 0; i < 6; i++) ran(`ipc other-${i}`, 10 + i)
    s.stall(1500, 1500)
    long()
    s.settle()
    const { work, workMore } = s.recorded[0].stall
    expect(work).toHaveLength(5)
    expect(work[0]).toMatchObject({ label: 'ipc queue:list', count: 1 })
    expect(new Set(work.map((w) => w.label)).size).toBe(5)
    // Shown longest first; the four 0 ms calls are one label, its four works counted among the more.
    expect(work.map((w) => w.ms)).toEqual([...work.map((w) => w.ms)].sort((a, b) => b - a))
    expect(work.some((w) => w.label === 'ipc performance:stalls')).toBe(false)
    expect(workMore).toBe(4 + 2)
    // Ranked by total: four of them at 30 ms each outrank one at 100 ms.
    const t = watcher()
    t.tick()
    noteStep('db transaction a database', now - 100)
    for (let i = 0; i < 4; i++) noteStep('db open hive.db', now - 30)
    t.stall(900, 0)
    t.settle()
    expect(t.recorded[0].stall.steps).toEqual([
      { label: 'db open hive.db', count: 4, ms: 120, running: false },
      { label: 'db transaction a database', count: 1, ms: 100, running: false }
    ])
  })

  it("keeps every stall in the log's quiet minute, which the log leaves out", () => {
    const s = watcher()
    for (const ms of [400, 500, 600]) {
      s.stall(ms)
      s.settle()
    }
    expect(s.warnings).toHaveLength(1)
    expect(s.recorded.map((r) => r.stall.ms)).toEqual([400, 500, 600])
  })

  it("keeps no pause: the PC's sleep, or the whole process paused", () => {
    const s = watcher()
    s.tick()
    s.w.power()
    s.stall(18_695, 3)
    s.w.power()
    s.settle()
    for (let i = 0; i < 20; i++) s.tick()
    s.watchdog.paused = true
    s.stall(7957, 0)
    s.settle()
    expect(s.infos).toHaveLength(2)
    expect(s.recorded).toEqual([])
  })

  it('keeps CPU it can\'t tell as unknown, never as waiting; little CPU is waiting', () => {
    const kept: Omit<MainStall, 'at'>[] = []
    let t = now
    const w = stallWatcher({ now: () => t, longestDelayMs: () => 0, cpuMs: () => null, defer: (fn) => fn(), warn: () => undefined, info: () => undefined, record: (stall) => kept.push(stall) })
    t += 500 + 800
    w.tick()
    expect(kept).toEqual([{ ms: 800, cpuMs: null, steps: [], stepsMore: 0, work: [], workMore: 0 }])
    expect(mostlyWaiting(kept[0])).toBe(false)
    expect(mostlyWaiting({ ms: 800, cpuMs: 399 })).toBe(true)
    expect(mostlyWaiting({ ms: 800, cpuMs: 400 })).toBe(false)
  })

  it(`lists the last ${MAIN_STALLS_KEPT}, newest first, and counts them all`, () => {
    const stall = (i: number): MainStall => ({ at: 1000 + i, ms: 300 + i, cpuMs: 100, steps: [], stepsMore: 0, work: [], workMore: 0 })
    for (let i = 0; i < MAIN_STALLS_KEPT + 10; i++) keepStall(stall(i))
    const r = recentStalls()
    expect(r.total).toBe(MAIN_STALLS_KEPT + 10)
    expect(r.stalls).toHaveLength(MAIN_STALLS_KEPT)
    expect(r.stalls[0].ms).toBe(300 + MAIN_STALLS_KEPT + 9)
    expect(r.stalls.at(-1)!.ms).toBe(310)
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

  it("names the step first when five calls waited behind it, beyond the five named (HR6's round 1)", () => {
    const s = watcher()
    s.tick()
    // A burst of calls begins, then a step blocks the thread; the tick runs only once the step has returned.
    const calls = [0, 1, 2, 3, 4].map((i) => {
      now += 1
      return beginWork(`ipc waiting-${i}`)
    })
    timedStep('db begin hive.db', () => {
      now += 4000
    })
    now += 10
    s.stall(0, 2)
    for (const done of calls) done()
    // The loop's delay as the tick measured it: the step's whole block.
    s.settle()
    const line = s.warnings[0] ?? ''
    expect(line).toMatch(/during it: db begin hive\.db \(4\.0 s\), ipc waiting-/)
    expect(line).toMatch(/ and 1 more$/)
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

describe('slow file calls, timed on the watchdog thread (HI-1702)', () => {
  /** A file-wait watcher on the fake clock, reading a fake watchdog's latest slow probe; its decisions run at settle(). */
  function files() {
    let probe: { n: number; start: number; ms: number } | null = null
    const deferred: (() => void)[] = []
    const warnings: string[] = []
    const paused = { value: false }
    const w = fileWaitWatcher({ now: () => now, slowProbe: () => probe, defer: (fn) => deferred.push(fn), warn: (l) => warnings.push(l), pausedAlongside: () => paused.value }, 16)
    return {
      w,
      warnings,
      paused,
      /** The watchdog's probe began now and took `ms`; main ticks once it has ended, then decides. */
      slow(ms: number) {
        const start = now
        now += ms
        probe = { n: (probe?.n ?? 0) + 1, start, ms }
        w.tick()
      },
      settle() {
        for (const fn of deferred.splice(0)) fn()
      }
    }
  }

  it('warns for a slow file call, naming the work under way, without saying it was the pool alone', () => {
    const f = files()
    const done = beginWork('ipc session:list')
    f.slow(900)
    done()
    f.settle()
    expect(f.warnings).toEqual(["A file call took 900 ms to end (timed off main's thread): it waited for the thread pool, whose 16 threads main and its worker threads share for file, zlib, crypto and DNS work, or for the disk; during it: ipc session:list (0.9 s)"])
  })

  it("is the watchdog's probe alone: main's thread held meanwhile isn't a file call's wait (HR2's round 1)", () => {
    const f = files()
    // Main blocked for 650 ms (the busy warning's), the watchdog's probe quick: nothing slow recorded, nothing said.
    f.w.tick()
    now += 650
    f.w.tick()
    f.settle()
    expect(f.warnings).toEqual([])
  })

  it('says each slow probe once, however many ticks read it', () => {
    const f = files()
    f.slow(400)
    f.w.tick()
    f.w.tick()
    f.settle()
    expect(f.warnings).toHaveLength(1)
  })

  it("leaves out a probe the PC's sleep or a pause of the whole process covered", () => {
    const f = files()
    f.w.power()
    f.slow(8000)
    f.settle()
    now += FILE_WAIT_TIMING.quietMs
    f.paused.value = true
    f.slow(7000)
    f.settle()
    expect(f.warnings).toEqual([])
    f.paused.value = false
    f.slow(600)
    f.settle()
    expect(f.warnings[0]).toMatch(/^A file call took 600 ms to end/)
  })

  it('warns for a slow file call that began just after a resume: that sleep was over (HI-2317)', () => {
    const f = files()
    f.w.power()
    now += 1500
    f.w.power(true)
    now += 100
    f.slow(900)
    f.settle()
    expect(f.warnings[0]).toMatch(/^A file call took 900 ms to end/)
  })

  it('warns once a minute, counting the slow calls between', () => {
    const f = files()
    f.slow(600)
    f.settle()
    f.slow(700)
    f.settle()
    f.slow(800)
    f.settle()
    now += FILE_WAIT_TIMING.quietMs
    f.slow(500)
    f.settle()
    expect(f.warnings).toHaveLength(2)
    expect(f.warnings[0]).toMatch(/^A file call took 600 ms/)
    expect(f.warnings[1]).toMatch(/^A file call took 500 ms .*; 2 more slow file call\(s\) since the last warning, not logged$/)
  })

  it("the watchdog keeps only its slow probes, the latest with its start and time", () => {
    const ticks = new Float64Array(WATCHDOG_SLOTS)
    probeEnded(ticks, 1000, 1000 + PROBE_SLOW_MS)
    expect(slowProbe(ticks)).toBeNull()
    probeEnded(ticks, 2000, 2900)
    probeEnded(ticks, 5000, 5400)
    expect(slowProbe(ticks)).toEqual({ n: 2, start: 5000, ms: 400 })
    // Its gaps are untouched by it.
    expect(pausedAlongside(ticks, 2000, 2900)).toBe(false)
  })
})
