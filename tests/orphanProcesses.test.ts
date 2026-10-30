// What an agent's command leaves running while the agent runs (HI-2111): one rule, a process in a running launch's job
// whose parent has exited (by its id and start time), shown once it has run ten minutes and is named, and told once.
import { describe, expect, it, vi } from 'vitest'
import type { ActivityProcess } from '../src/shared/activity'
import type { Lineage, Orphan } from '../src/main/orphanProcesses'

const switchOn = vi.hoisted(() => ({ on: true }))
vi.mock('../src/main/advanced', () => ({ advanced: { get: () => switchOn.on } }))
const toasts = vi.hoisted(() => ({ list: [] as unknown[][] }))
vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: (...a: unknown[]) => void toasts.list.push(a), onHiveEvent: () => () => undefined }))
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
    await vi.waitFor(() => expect(release).not.toBe(null))
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
