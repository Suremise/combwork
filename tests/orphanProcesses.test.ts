// What an agent's command leaves running while the agent runs (HI-2111): one rule, a process in a running launch's job
// whose parent has exited (by its id and start time), shown once it has run ten minutes and is named, and told once.
import { describe, expect, it, vi } from 'vitest'
import type { ActivityProcess } from '../src/shared/activity'
import type { Lineage, Orphan } from '../src/main/orphanProcesses'

const switchOn = vi.hoisted(() => ({ on: true }))
// HI-3206: the minutes (10, the default) and the known hosts' pattern, as Settings → Advanced has them by default.
const hostsNow = vi.hoisted(() => ({ re: /^(WindowsSandboxRemoteSession|WindowsSandboxServer)\.exe$/i as RegExp | null }))
vi.mock('../src/main/advanced', () => ({ advanced: { get: () => switchOn.on, number: () => 10, pattern: () => hostsNow.re } }))
const toasts = vi.hoisted(() => ({ list: [] as unknown[][] }))
vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: (...a: unknown[]) => void toasts.list.push(a), onCombworkEvent: () => () => undefined }))
// The launches running now (r1 unless a test stops it), the host's lineage of each and their listed processes.
const host = vi.hoisted(() => ({ ids: ['r1'], lineage: null as Record<string, unknown> | null, processes: async (): Promise<unknown[] | null> => null }))
vi.mock('../src/main/agentProcesses', () => ({
  runningLaunches: () => host.ids.map((runId) => ({ runId, projectPath: 'C:\\ws\\alpha', agentId: 'a1', agentName: 'HB2' })),
  launchLineage: async () => host.lineage,
  launchProcessesNow: () => host.processes()
}))

/** A Windows FILETIME for a Unix time in ms, as text. */
const ft = (ms: number): string => String(BigInt(ms) * 10000n + 116444736000000000n)
const launch = { runId: 'r1', projectPath: 'C:\\ws\\alpha', agentId: 'a1', agentName: 'HB2' }
const MIN = 60_000
const proc = (pid: number, created: string, command = 'node linger.js'): ActivityProcess => ({ pid, created, name: 'node.exe', label: command, command })

describe('the rule', () => {
  const at = Date.now()
  const l = (parentCreated: string, created = ft(at)): Lineage => ({ pid: 20, created, parent: 10, parentCreated, cpu: 5 })

  it('is an orphan when its parent has exited', async () => {
    const { isOrphan } = await import('../src/main/orphanProcesses')
    expect(isOrphan(l('0'))).toBe(true)
  })

  it('is not one while its parent runs (started before it)', async () => {
    const { isOrphan } = await import('../src/main/orphanProcesses')
    expect(isOrphan(l(ft(at - 1000)))).toBe(false)
    expect(isOrphan(l(ft(at)))).toBe(false)
  })

  it('is one when its parent’s id names a process started after it (the id given again)', async () => {
    const { isOrphan } = await import('../src/main/orphanProcesses')
    expect(isOrphan(l(ft(at + 1000)))).toBe(true)
  })

  it('is not one when the parent can’t be told', async () => {
    const { isOrphan } = await import('../src/main/orphanProcesses')
    expect(isOrphan(l('?'))).toBe(false)
    expect(isOrphan(l('junk'))).toBe(false)
  })

  it('reads only well-formed entries of the host’s answer', async () => {
    const { parseLineage } = await import('../src/main/orphanProcesses')
    expect(parseLineage([{ pid: 5, created: '123', parent: 1, parentCreated: '0', cpu: 7 }, { pid: -1, created: '1', parentCreated: '0' }, { pid: 6, created: '0', parentCreated: '0' }, null])).toEqual([{ pid: 5, created: '123', parent: 1, parentCreated: '0', cpu: 7 }])
    expect(parseLineage('nope')).toEqual([])
  })
})

describe('a look at a launch', () => {
  it('makes an orphan due once it has run ten minutes and was seen at an earlier look; named, it is shown, once', async () => {
    const { lookAtLaunch, nameDue, ORPHAN_MS } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const young: Lineage = { pid: 20, created: ft(now - 9 * MIN), parent: 10, parentCreated: '0', cpu: 1 }
    // First look: an orphan, not due yet (nine minutes).
    let r = lookAtLaunch(new Map(), launch, [young], now, ORPHAN_MS)
    expect([...r.orphans.values()].map((o) => [o.present, o.shown])).toEqual([[true, false]])
    expect(r.due).toEqual([])
    // Ten minutes on: due; named, shown.
    r = lookAtLaunch(r.orphans, launch, [{ ...young, cpu: 2 }], now + MIN, ORPHAN_MS)
    expect(r.due.map((o) => o.pid)).toEqual([20])
    expect(nameDue(r.due, [proc(20, young.created)]).map((o) => o.label)).toEqual(['node linger.js'])
    expect([...r.orphans.values()][0]).toMatchObject({ shown: true, cpuMs: 2, agentId: 'a1', command: 'node linger.js' })
    // The next look: still shown, not due again.
    r = lookAtLaunch(r.orphans, launch, [young], now + 2 * MIN, ORPHAN_MS)
    expect(r.due).toEqual([])
    expect([...r.orphans.values()][0].shown).toBe(true)
  })

  it('isn’t due at its first look however long it has run (a parent and child ending together)', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const r = lookAtLaunch(new Map(), launch, [{ pid: 20, created: ft(now - 60 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now)
    expect(r.due).toEqual([])
  })

  it('never counts a process whose parent runs; one missing from a look is kept, not present', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const child: Lineage = { pid: 30, created: ft(now - 60 * MIN), parent: 20, parentCreated: ft(now - 61 * MIN), cpu: 1 }
    const orphan: Lineage = { pid: 20, created: ft(now - 61 * MIN), parent: 10, parentCreated: '0', cpu: 1 }
    let r = lookAtLaunch(new Map(), launch, [child, orphan], now)
    expect([...r.orphans.values()].map((o) => o.pid)).toEqual([20])
    r = lookAtLaunch(r.orphans, launch, [child], now + MIN)
    expect([...r.orphans.values()].map((o) => [o.pid, o.present])).toEqual([[20, false]])
  })

  it('keeps what it was told across a look that can’t tell its parent: due and told once in all (HR2’s round 1)', async () => {
    const { lookAtLaunch, nameDue, orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const created = ft(now - 30 * MIN)
    const at = (parentCreated: string): Lineage[] => [{ pid: 20, created, parent: 10, parentCreated, cpu: 1 }]
    let known = new Map<string, Orphan>()
    let due = 0
    let told = 0
    for (const [i, parent] of ['0', '0', '?', '0', '0'].entries()) {
      const r = lookAtLaunch(known, launch, at(parent), now + i * MIN)
      due += nameDue(r.due, [proc(20, created)]).length
      known = r.orphans
      setOrphansForTests('r1', [...known.values()])
      if (orphanLinesFor(launch.projectPath, 'a1')) told++
    }
    expect([due, told]).toEqual([1, 1])
    // A look it was missing from, then back: still the same, nothing due again.
    let r = lookAtLaunch(known, launch, [], now + 6 * MIN)
    r = lookAtLaunch(r.orphans, launch, at('0'), now + 7 * MIN)
    expect(r.due).toEqual([])
    expect([...r.orphans.values()][0]).toMatchObject({ present: true, shown: true, told: true })
    setOrphansForTests('r1', null)
  })

  it('follows a process by its id and start time: a later one by the same id is another', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const first = lookAtLaunch(new Map(), launch, [{ pid: 20, created: ft(now - 30 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now)
    const r = lookAtLaunch(first.orphans, launch, [{ pid: 20, created: ft(now - 20 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now + MIN)
    expect(r.due).toEqual([])
  })

  it('waits for a due orphan’s command line, then shows it by its pid alone after three looks', async () => {
    const { lookAtLaunch, nameDue } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const l: Lineage[] = [{ pid: 20, created: ft(now - 30 * MIN), parent: 10, parentCreated: '0', cpu: 1 }]
    let r = lookAtLaunch(new Map(), launch, l, now)
    const shownAt: number[] = []
    for (let i = 1; i <= 4; i++) {
      r = lookAtLaunch(r.orphans, launch, l, now + i * MIN)
      if (nameDue(r.due, []).length) shownAt.push(i)
    }
    expect(shownAt).toEqual([3])
    const o = [...r.orphans.values()][0]
    expect([o.shown, o.label]).toEqual([true, undefined])
  })
})

describe('a look as the timer makes it', () => {
  it('tells nothing while a due orphan’s command line is being read, then tells it with its command (HR2’s round 1)', async () => {
    const { lookForTests, orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const created = ft(Date.now() - 30 * MIN)
    host.lineage = { r1: [{ pid: 20, created, parent: 10, parentCreated: '0', cpu: 4 }] }
    toasts.list = []
    await lookForTests()
    let release: ((p: unknown[]) => void) | null = null
    host.processes = () => new Promise((r) => (release = r))
    const second = lookForTests()
    // Its names are being read: nothing told yet, however often the agent's hooks ask.
    // Bounded for a hung run (HI-3349), not Vitest's 1 s, which a loaded runner outlasts.
    await vi.waitFor(() => expect(release).not.toBe(null), { timeout: 20_000 })
    expect(orphanLinesFor(launch.projectPath, 'a1')).toBe('')
    release!([proc(20, created)])
    await second
    const line = orphanLinesFor(launch.projectPath, 'a1')
    expect(line).toContain('pid 20 `node linger.js`')
    expect(orphanLinesFor(launch.projectPath, 'a1')).toBe('')
    // One notice, routed by its project's path, clicking to its agent.
    expect(toasts.list.map((a) => [a[4], (a[5] as { agentId: string }).agentId])).toEqual([['C:\\ws\\alpha', 'a1']])
    host.processes = async () => null
    host.lineage = null
    setOrphansForTests('r1', null)
  })
})

describe('telling the agent', () => {
  const orphan = (pid: number, shown = true): Orphan => ({ ...launch, pid, created: ft(Date.now() - 12 * MIN), cpuMs: 1, present: true, shown, told: false, nameTries: 0, label: 'grep -rh HI-2080 /', command: 'grep -rh HI-2080 /' })

  it('tells it once of each shown orphan, with its pid and command, and never of one not shown yet', async () => {
    const { orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    switchOn.on = true
    setOrphansForTests('r1', [orphan(20), orphan(21, false)])
    const line = orphanLinesFor(launch.projectPath, 'a1')
    expect(line).toContain('pid 20 `grep -rh HI-2080 /`')
    expect(line).not.toContain('pid 21')
    expect(orphanLinesFor(launch.projectPath, 'a1')).toBe('')
    // Another agent's isn't its own.
    expect(orphanLinesFor(launch.projectPath, 'a2')).toBe('')
    setOrphansForTests('r1', null)
  })

  it('tells nothing with the switch off, and counts nothing as told', async () => {
    const { orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    setOrphansForTests('r1', [orphan(20)])
    switchOn.on = false
    expect(orphanLinesFor(launch.projectPath, 'a1')).toBe('')
    switchOn.on = true
    expect(orphanLinesFor(launch.projectPath, 'a1')).toContain('pid 20')
    setOrphansForTests('r1', null)
  })

  it('counts only a running launch’s present orphans: a stopped one’s are its leftovers, never counted twice', async () => {
    const { orphansOf, setOrphansForTests } = await import('../src/main/orphanProcesses')
    setOrphansForTests('r1', [orphan(20, false), { ...orphan(22, false), present: false }])
    expect(orphansOf(launch.projectPath, 'a1').map((o) => o.pid)).toEqual([20])
    host.ids = []
    expect(orphansOf(launch.projectPath, 'a1')).toEqual([])
    host.ids = ['r1']
    setOrphansForTests('r1', null)
  })

  it('marks only shown, present orphans in Activity, with their CPU time', async () => {
    const { markOrphans, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const o = orphan(20)
    setOrphansForTests('r1', [o, orphan(21, false)])
    const p = (pid: number, created: string) => ({ pid, created, name: 'node.exe', label: 'node' })
    expect(markOrphans('r1', [p(20, o.created), p(21, o.created), p(20, '1')]).map((x) => x.orphan ?? null)).toEqual([{ cpuMs: 1 }, null, null])
    setOrphansForTests('r1', null)
  })
})

describe('processes of a cw-progress run (HI-3206)', () => {
  const now = Date.now()
  const aged: Lineage = { pid: 30, created: ft(now - 30 * MIN), parent: 20, parentCreated: '0', cpu: 1 }
  const run = (life: 'live' | 'finished' | 'unconfirmed') => () => ({ runId: 'run-abcdef12', title: 'Sandbox: baseline cycle', life })

  it('a process in a live run’s tree isn’t due however long it has run; once its run ends, due at the first look after, with no new wait', async () => {
    const { lookAtLaunch, ORPHAN_MS } = await import('../src/main/orphanProcesses')
    let r = lookAtLaunch(new Map(), launch, [aged], now, ORPHAN_MS, run('live'))
    r = lookAtLaunch(r.orphans, launch, [aged], now + MIN, ORPHAN_MS, run('live'))
    expect(r.due).toEqual([])
    expect([...r.orphans.values()][0]).toMatchObject({ held: true, run: { runId: 'run-abcdef12', life: 'live' } })
    r = lookAtLaunch(r.orphans, launch, [aged], now + 2 * MIN, ORPHAN_MS, run('finished'))
    expect(r.due.map((o) => [o.pid, o.held ?? false, o.run?.life])).toEqual([[30, false, 'finished']])
  })

  it('an unrelated orphan during a live run is due as usual', async () => {
    const { lookAtLaunch, ORPHAN_MS } = await import('../src/main/orphanProcesses')
    const other: Lineage = { pid: 31, created: ft(now - 30 * MIN), parent: 21, parentCreated: '0', cpu: 1 }
    const runOf = (key: string) => (key.startsWith('30:') ? run('live')() : null)
    let r = lookAtLaunch(new Map(), launch, [aged, other], now, ORPHAN_MS, runOf)
    r = lookAtLaunch(r.orphans, launch, [aged, other], now + MIN, ORPHAN_MS, runOf)
    expect(r.due.map((o) => o.pid)).toEqual([31])
  })

  it('the minutes are the bound: due at the setting, not at ten', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const young: Lineage = { ...aged, created: ft(now - 12 * MIN) }
    let r = lookAtLaunch(new Map(), launch, [young], now, 15 * MIN)
    r = lookAtLaunch(r.orphans, launch, [young], now + MIN, 15 * MIN)
    expect(r.due).toEqual([])
    r = lookAtLaunch(r.orphans, launch, [young], now + 4 * MIN, 15 * MIN)
    expect(r.due.map((o) => o.pid)).toEqual([30])
  })

  it('a known host (the Windows Sandbox guest’s) is never told, and Activity still marks it', async () => {
    const { lookForTests, markOrphans, orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const created = ft(Date.now() - 30 * MIN)
    host.lineage = { r1: [{ pid: 90, created, parent: 10, parentCreated: '0', cpu: 4 }] }
    host.processes = async () => [{ pid: 90, created, name: 'WindowsSandboxRemoteSession.exe', label: 'WindowsSandboxRemoteSession --id 1', command: 'WindowsSandboxRemoteSession --id 1' }]
    toasts.list = []
    await lookForTests()
    await lookForTests()
    expect(toasts.list).toEqual([])
    expect(orphanLinesFor(launch.projectPath, 'a1')).toBe('')
    expect(markOrphans('r1', [{ pid: 90, created, name: 'WindowsSandboxRemoteSession.exe', label: 'x' }])[0].orphan).toEqual({ cpuMs: 4, host: true })
    host.processes = async () => null
    host.lineage = null
    setOrphansForTests('r1', null)
  })

  it('the agent’s line says the run ended only when it finished; else that it is no longer seen running', async () => {
    const { orphanLinesFor, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const base = { ...launch, created: ft(Date.now() - 12 * MIN), cpuMs: 1, present: true, shown: true, told: false, nameTries: 0, command: 'node serve.js' }
    setOrphansForTests('r1', [{ ...base, pid: 20, run: { runId: 'run-abcdef12', title: 'Sandbox: baseline cycle', life: 'finished' } }, { ...base, pid: 21, run: { runId: 'run-12345678', title: 'Sandbox: baseline cycle', life: 'unconfirmed' } }, { ...base, pid: 22 }])
    const line = orphanLinesFor(launch.projectPath, 'a1')
    expect(line).toContain('pid 20 `node serve.js` (running 12 min), still running after its cw-progress run "Sandbox: baseline cycle" (run run-abcd) ended')
    expect(line).toContain('pid 21 `node serve.js` (running 12 min); its cw-progress run "Sandbox: baseline cycle" (run run-1234) is no longer seen running')
    // In no run: worded as before, the list's last item, then its end.
    expect(line).toContain('pid 22 `node serve.js` (running 12 min). End them')
    expect(line).not.toMatch(/pid 21[^;]*ended/)
    setOrphansForTests('r1', null)
  })

  it('Activity marks one held back for its live run, as well as one told', async () => {
    const { markOrphans, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const created = ft(Date.now() - 12 * MIN)
    setOrphansForTests('r1', [{ ...launch, pid: 20, created, cpuMs: 3, present: true, shown: false, told: false, nameTries: 0, held: true, run: { runId: 'run-1', title: 'Sandbox: baseline cycle', life: 'live' } }])
    expect(markOrphans('r1', [{ pid: 20, created, name: 'node.exe', label: 'node' }])[0].orphan).toEqual({ cpuMs: 3, run: 'Sandbox: baseline cycle' })
    setOrphansForTests('r1', null)
  })
})

describe('the polling layer’s runs (HR1’s round 1 of HI-3206)', () => {
  const T = Date.now() - 60 * MIN
  const wrapper = { pid: 30, created: ft(T - 60_000), parent: 20, parentCreated: '0', cpu: 1 }
  const reporter = { pid: 40, created: ft(T - 1000), parent: 30, parentCreated: ft(T - 60_000), cpu: 1 }
  const run = (over: Record<string, unknown> = {}) => ({ id: 'run-x', title: 'Sandbox cycle', agentId: 'a1', projectPath: launch.projectPath, pid: 40, reporterSentAt: T, state: 'running', finishedAt: null, ...over }) as never

  it('a held orphan whose association is no longer there (the cap dropped it) is never live: due at the next look', async () => {
    const { lookAtLaunch, ORPHAN_MS } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const aged: Lineage = { pid: 30, created: ft(now - 30 * MIN), parent: 20, parentCreated: '0', cpu: 1 }
    const live = () => ({ runId: 'run-x', title: 'Sandbox cycle', life: 'live' as const })
    let r = lookAtLaunch(new Map(), launch, [aged], now, ORPHAN_MS, live)
    r = lookAtLaunch(r.orphans, launch, [aged], now + MIN, ORPHAN_MS, live)
    expect(r.due).toEqual([])
    // Evicted: runOf gives nothing now. Kept to name it, not live.
    r = lookAtLaunch(r.orphans, launch, [aged], now + 2 * MIN, ORPHAN_MS, () => null)
    expect(r.due.map((o) => [o.pid, o.run?.life])).toEqual([[30, 'unconfirmed']])
  })

  for (const order of [['r1', 'r2'], ['r2', 'r1']]) {
    it(`two launches of one agent in one project, the reporter only in r2, looked at ${order.join(' then ')}: its wrapper held`, async () => {
      const { lookForTests, markOrphans, setOrphanRuns, setOrphansForTests, stopOrphanWatch } = await import('../src/main/orphanProcesses')
      stopOrphanWatch()
      host.ids = order
      host.lineage = { r1: [{ pid: 70, created: ft(T), parent: 10, parentCreated: ft(T - 5000), cpu: 0 }], r2: [wrapper, reporter] }
      host.processes = async () => [proc(30, wrapper.created, 'cmd /c cw-progress --title "Sandbox cycle"')]
      setOrphanRuns(() => [run()])
      toasts.list = []
      await lookForTests()
      await lookForTests()
      expect(toasts.list).toEqual([])
      expect(markOrphans('r2', [proc(30, wrapper.created)])[0].orphan).toEqual({ cpuMs: 1, run: 'Sandbox cycle' })
      setOrphanRuns(null)
      setOrphansForTests('r1', null)
      setOrphansForTests('r2', null)
      host.ids = ['r1']
      host.lineage = null
      host.processes = async () => null
      stopOrphanWatch()
    })
  }

  // HI-3245: the lineage read before the run registered (its reporter not in that snapshot yet); a later look has it.
  for (const reused of [false, true]) {
    it(reused ? 'a later process given the reporter’s pid (started after it sent) never binds: the wrapper is told (HI-3245)' : 'a reporter missing from the first look is bound at a later one: its wrapper held, never told (HI-3245)', async () => {
      const { lookForTests, markOrphans, setOrphanRuns, setOrphansForTests, stopOrphanWatch } = await import('../src/main/orphanProcesses')
      stopOrphanWatch()
      host.ids = ['r1']
      host.lineage = { r1: [wrapper] }
      host.processes = async () => [proc(30, wrapper.created, 'cmd /c cw-progress --title "Sandbox cycle"')]
      setOrphanRuns(() => [run()])
      toasts.list = []
      try {
        await lookForTests()
        const later = reused ? { ...reporter, created: ft(T + 1000) } : reporter
        host.lineage = { r1: [wrapper, later] }
        await lookForTests()
        await lookForTests()
        if (reused) {
          expect(toasts.list).toHaveLength(1)
          expect(markOrphans('r1', [proc(30, wrapper.created)])[0].orphan?.run).toBeUndefined()
        } else {
          expect(toasts.list).toEqual([])
          expect(markOrphans('r1', [proc(30, wrapper.created)])[0].orphan).toEqual({ cpuMs: 1, run: 'Sandbox cycle' })
        }
      } finally {
        setOrphanRuns(null)
        setOrphansForTests('r1', null)
        host.lineage = null
        host.processes = async () => null
        stopOrphanWatch()
      }
    })
  }

  it('keeps a run’s binding and title only while needed: pruned as runs end and launches go; cleared when the watch stops', async () => {
    const { lookForTests, runStateForTests, setOrphanRuns, setOrphansForTests, stopOrphanWatch } = await import('../src/main/orphanProcesses')
    stopOrphanWatch()
    host.ids = ['r1']
    host.lineage = { r1: [reporter] }
    let runs = [run(), run({ id: 'run-y', pid: 41 }), run({ id: 'run-z', pid: 42 })]
    setOrphanRuns(() => runs)
    await lookForTests()
    expect(runStateForTests().reporters).toBe(3)
    // Two ended and gone from the list (history evicted): no longer kept.
    runs = [run()]
    await lookForTests()
    expect(runStateForTests()).toMatchObject({ reporters: 1, titles: 1 })
    // The launch gone: nothing kept.
    host.ids = []
    runs = []
    await lookForTests()
    expect(runStateForTests()).toEqual({ reporters: 0, titles: 0, trees: 0 })
    host.ids = ['r1']
    runs = [run()]
    await lookForTests()
    stopOrphanWatch()
    expect(runStateForTests()).toEqual({ reporters: 0, titles: 0, trees: 0 })
    setOrphanRuns(null)
    setOrphansForTests('r1', null)
    host.lineage = null
  })

  it('a known host’s pattern removed: its process is told at the next look, once', async () => {
    const { lookForTests, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const created = ft(Date.now() - 30 * MIN)
    host.lineage = { r1: [{ pid: 91, created, parent: 10, parentCreated: '0', cpu: 2 }] }
    host.processes = async () => [{ pid: 91, created, name: 'WindowsSandboxServer.exe', label: 'WindowsSandboxServer', command: 'WindowsSandboxServer' }]
    toasts.list = []
    await lookForTests()
    await lookForTests()
    expect(toasts.list).toEqual([])
    hostsNow.re = /^nothing$/
    await lookForTests()
    await lookForTests()
    expect(toasts.list.length).toBe(1)
    await lookForTests()
    expect(toasts.list.length).toBe(1)
    hostsNow.re = /^(WindowsSandboxRemoteSession|WindowsSandboxServer)\.exe$/i
    host.processes = async () => null
    host.lineage = null
    setOrphansForTests('r1', null)
  })
})
