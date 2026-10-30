// What an agent's command leaves running while the agent runs (HI-2111): one rule, a process in a running launch's job
// whose parent has exited (by its id and start time), shown once it has run ten minutes, and told once.
import { describe, expect, it, vi } from 'vitest'
import type { Lineage, Orphan } from '../src/main/orphanProcesses'

const switchOn = vi.hoisted(() => ({ on: true }))
vi.mock('../src/main/advanced', () => ({ advanced: { get: () => switchOn.on } }))
vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: () => undefined, onHiveEvent: () => () => undefined }))
// The launches running now: r1 unless a test stops it.
const runs = vi.hoisted(() => ({ ids: ['r1'] }))
vi.mock('../src/main/agentProcesses', () => ({ runningLaunches: () => runs.ids.map((runId) => ({ runId, projectPath: 'C:\\ws\\alpha', agentId: 'a1', agentName: 'HB2' })), launchLineage: async () => null, launchProcessesNow: async () => null }))

/** A Windows FILETIME for a Unix time in ms, as text. */
const ft = (ms: number): string => String(BigInt(ms) * 10000n + 116444736000000000n)
const launch = { runId: 'r1', projectPath: 'C:\\ws\\alpha', agentId: 'a1', agentName: 'HB2' }
const MIN = 60_000

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
  it('shows an orphan once it has run ten minutes and was seen at an earlier look, once', async () => {
    const { lookAtLaunch, ORPHAN_MS } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const young: Lineage = { pid: 20, created: ft(now - 9 * MIN), parent: 10, parentCreated: '0', cpu: 1 }
    // First look: an orphan, not shown yet (nine minutes).
    let r = lookAtLaunch(new Map(), launch, [young], now, ORPHAN_MS)
    expect([...r.orphans.values()].map((o) => o.shown)).toEqual([false])
    expect(r.due).toEqual([])
    // Ten minutes on: shown, due once.
    r = lookAtLaunch(r.orphans, launch, [{ ...young, cpu: 2 }], now + MIN, ORPHAN_MS)
    expect(r.due.map((o) => o.pid)).toEqual([20])
    expect([...r.orphans.values()][0]).toMatchObject({ shown: true, cpuMs: 2, agentId: 'a1' })
    // The next look: still shown, not due again.
    r = lookAtLaunch(r.orphans, launch, [young], now + 2 * MIN, ORPHAN_MS)
    expect(r.due).toEqual([])
    expect([...r.orphans.values()][0].shown).toBe(true)
  })

  it('isn’t shown at its first look however long it has run (a parent and child ending together)', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const r = lookAtLaunch(new Map(), launch, [{ pid: 20, created: ft(now - 60 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now)
    expect(r.due).toEqual([])
  })

  it('never counts a process whose parent runs, and forgets an orphan that has ended', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const child: Lineage = { pid: 30, created: ft(now - 60 * MIN), parent: 20, parentCreated: ft(now - 61 * MIN), cpu: 1 }
    const orphan: Lineage = { pid: 20, created: ft(now - 61 * MIN), parent: 10, parentCreated: '0', cpu: 1 }
    let r = lookAtLaunch(new Map(), launch, [child, orphan], now)
    expect([...r.orphans.values()].map((o) => o.pid)).toEqual([20])
    r = lookAtLaunch(r.orphans, launch, [child], now + MIN)
    expect(r.orphans.size).toBe(0)
  })

  it('follows a process by its id and start time: a later one by the same id is another', async () => {
    const { lookAtLaunch } = await import('../src/main/orphanProcesses')
    const now = Date.now()
    const first = lookAtLaunch(new Map(), launch, [{ pid: 20, created: ft(now - 30 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now)
    const r = lookAtLaunch(first.orphans, launch, [{ pid: 20, created: ft(now - 20 * MIN), parent: 10, parentCreated: '0', cpu: 1 }], now + MIN)
    expect(r.due).toEqual([])
  })
})

describe('telling the agent', () => {
  const orphan = (pid: number, shown = true): Orphan => ({ ...launch, pid, created: ft(Date.now() - 12 * MIN), cpuMs: 1, shown, told: false, label: 'grep -rh HI-2080 /', command: 'grep -rh HI-2080 /' })

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

  it('counts only a running launch’s: a stopped one’s are its leftovers, never counted twice', async () => {
    const { orphansOf, setOrphansForTests } = await import('../src/main/orphanProcesses')
    setOrphansForTests('r1', [orphan(20, false)])
    expect(orphansOf(launch.projectPath, 'a1').map((o) => o.pid)).toEqual([20])
    runs.ids = []
    expect(orphansOf(launch.projectPath, 'a1')).toEqual([])
    runs.ids = ['r1']
    setOrphansForTests('r1', null)
  })

  it('marks only shown orphans in Activity, with their CPU time', async () => {
    const { markOrphans, setOrphansForTests } = await import('../src/main/orphanProcesses')
    const o = orphan(20)
    setOrphansForTests('r1', [o, orphan(21, false)])
    const p = (pid: number, created: string) => ({ pid, created, name: 'node.exe', label: 'node' })
    expect(markOrphans('r1', [p(20, o.created), p(21, o.created), p(20, '1')]).map((x) => x.orphan ?? null)).toEqual([{ cpuMs: 1 }, null, null])
    setOrphansForTests('r1', null)
  })
})
