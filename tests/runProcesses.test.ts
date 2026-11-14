// HI-3206: a cw-progress run's processes, by identity and ancestry: its reporter bound once, strictly before the time it
// took itself before sending (a pid reused since is refused, whatever the delays), its tree linked by each process's
// parent id and that parent's creation time, remembered when a parent exits, bounded; and whether the run is live.
import { describe, expect, it } from 'vitest'
import { bindReporter, keyOf, MAX_REMEMBERED, runLife, runTrees } from '../src/main/runProcesses'
import type { Lineage } from '../src/main/orphanProcesses'

/** A Windows FILETIME for a Unix time in ms, as text (and with an extra 100 ns). */
const ft = (ms: number, plus = 0): string => String(BigInt(ms) * 10000n + 116444736000000000n + BigInt(plus))
const T = 1_763_000_000_000
const proc = (pid: number, createdMs: number, parent = 0, parentCreatedMs: number | '0' = '0', plus = 0): Lineage => ({ pid, created: ft(createdMs, plus), parent, parentCreated: parentCreatedMs === '0' ? '0' : ft(parentCreatedMs), cpu: 0 })

describe('binding a run’s reporter (HI-3206)', () => {
  it('takes the process by its pid created strictly before the time the reporter took before sending', () => {
    const reporter = proc(40, T - 80)
    expect(bindReporter([reporter], 40, T)).toBe(keyOf(reporter))
  })

  it('the delayed request: the reporter sends, exits, its pid is reused, then the lineage is read: never the replacement', () => {
    const replacement = proc(40, T + 5)
    expect(bindReporter([replacement], 40, T)).toBe(null)
  })

  it('a replacement in the very millisecond it sent: refused (strictly before, in FILETIME’s precision)', () => {
    expect(bindReporter([proc(40, T, 0, '0', 1)], 40, T)).toBe(null)
    expect(bindReporter([proc(40, T)], 40, T)).toBe(null)
    expect(bindReporter([proc(40, T - 1, 0, '0', 9999)], 40, T)).toBe(keyOf(proc(40, T - 1, 0, '0', 9999)))
  })

  it('no identity: the pid not in the lineage, no time, a time that isn’t finite, an unreadable creation time', () => {
    expect(bindReporter([proc(41, T - 80)], 40, T)).toBe(null)
    expect(bindReporter([proc(40, T - 80)], 40, undefined)).toBe(null)
    expect(bindReporter([proc(40, T - 80)], 40, Number.NaN)).toBe(null)
    expect(bindReporter([{ ...proc(40, T - 80), created: 'x' }], 40, T)).toBe(null)
    expect(bindReporter([proc(40, T - 80)], null, T)).toBe(null)
  })
})

describe('a run’s process tree (HI-3206)', () => {
  // The agent's shell (exited: the wrapper's parent gone), the wrapper started before the run registered, the reporter, its
  // command and that command's child; an unrelated orphan beside them.
  const wrapper = proc(30, T - 500, 20, '0')
  const reporter = proc(40, T - 80, 30, T - 500)
  const command = proc(50, T + 100, 40, T - 80)
  const grandchild = proc(60, T + 200, 50, T + 100)
  const unrelated = proc(70, T + 300, 21, '0')
  const lineage = [wrapper, reporter, command, grandchild, unrelated]

  it('is its reporter, the wrapper above it (by ancestry, not time) and all below; never an unrelated process', () => {
    const tree = runTrees(lineage, [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map())
    expect(new Set(tree.keys())).toEqual(new Set([wrapper, reporter, command, grandchild].map(keyOf)))
    expect(tree.get(keyOf(unrelated))).toBeUndefined()
  })

  it('remembers a descendant once an intermediate exits; drops what is gone', () => {
    const before = runTrees(lineage, [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map())
    // The command exits: the grandchild's parent is gone (parentCreated '0'), and the reporter has exited too.
    const after = runTrees([wrapper, { ...grandchild, parentCreated: '0' }, unrelated], [{ runId: 'run-1', reporter: keyOf(reporter) }], before)
    expect(after.get(keyOf(grandchild))).toBe('run-1')
    expect(after.get(keyOf(wrapper))).toBe('run-1')
    expect(after.has(keyOf(command))).toBe(false)
    expect(after.get(keyOf(unrelated))).toBeUndefined()
  })

  it('a child naming a reused pid as its parent (a different creation time) joins no tree', () => {
    const stranger = proc(80, T + 400, 40, T + 350)
    const tree = runTrees([reporter, stranger], [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map())
    expect(tree.get(keyOf(stranger))).toBeUndefined()
  })

  // HI-3273: the host gives a parent's pid with the creation time of whatever holds that pid now. A holder created after the
  // child is another process given the pid again (isOrphan's rule): the child is an orphan, never that process's child.
  it('an orphan whose exited parent’s pid now belongs to the run’s tree joins no tree, at any look', () => {
    // A server started with & at T - 1000 from a shell (pid 25) since exited; the run's command then got pid 25.
    const server = proc(90, T - 1000, 25, T + 100)
    const command25 = proc(25, T + 100, 40, T - 80)
    const run = [{ runId: 'run-1', reporter: keyOf(reporter) }]
    const first = runTrees([wrapper, reporter, command25, server], run, new Map())
    expect(first.get(keyOf(command25))).toBe('run-1')
    expect(first.get(keyOf(server))).toBeUndefined()
    // The command exits (the server's parent gone): still no run's, then or later.
    const second = runTrees([wrapper, reporter, { ...server, parentCreated: '0' }], run, first)
    expect(second.get(keyOf(server))).toBeUndefined()
  })

  it('…nor when the reporter itself reuses the pid, nor above it: a reporter’s parent reused later isn’t its wrapper', () => {
    const server = proc(90, T - 1000, 40, T - 80)
    expect(runTrees([reporter, server], [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map()).get(keyOf(server))).toBeUndefined()
    // The reporter names pid 35 as its parent, and pid 35 is now a process started after it.
    const late = proc(35, T + 50, 20, '0')
    const orphanedReporter = proc(40, T - 80, 35, T + 50)
    const tree = runTrees([orphanedReporter, late], [{ runId: 'run-1', reporter: keyOf(orphanedReporter) }], new Map())
    expect(tree.get(keyOf(late))).toBeUndefined()
    expect(tree.get(keyOf(orphanedReporter))).toBe('run-1')
  })

  it('a parent created in the same 100 ns as its child is still its parent', () => {
    const same = proc(50, T - 80, 40, T - 80)
    expect(runTrees([reporter, same], [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map()).get(keyOf(same))).toBe('run-1')
  })

  it('two runs at once with the same title: each tree its own, by its reporter', () => {
    const r2 = proc(41, T - 70, 31, '0')
    const c2 = proc(51, T + 150, 41, T - 70)
    const tree = runTrees([...lineage, r2, c2], [{ runId: 'run-1', reporter: keyOf(reporter) }, { runId: 'run-2', reporter: keyOf(r2) }], new Map())
    expect(tree.get(keyOf(command))).toBe('run-1')
    expect(tree.get(keyOf(c2))).toBe('run-2')
  })

  it('a run with no identity holds nothing; the map is capped, the oldest dropped first', () => {
    expect(runTrees(lineage, [{ runId: 'run-1', reporter: null }], new Map()).size).toBe(0)
    const many = Array.from({ length: MAX_REMEMBERED + 5 }, (_, i) => proc(1000 + i, T + i, 40, T - 80))
    const tree = runTrees([reporter, ...many], [{ runId: 'run-1', reporter: keyOf(reporter) }], new Map())
    expect(tree.size).toBe(MAX_REMEMBERED)
  })
})

describe('whether a run is live for its processes (HI-3206)', () => {
  const present = new Set(['40:1'])
  it('live only while running with its bound reporter present; finished once it has a finish; else no longer seen running', () => {
    expect(runLife({ state: 'running', finishedAt: null }, '40:1', present)).toBe('live')
    expect(runLife({ state: 'passed', finishedAt: T }, '40:1', present)).toBe('finished')
    expect(runLife({ state: 'stopped', finishedAt: T }, '40:1', new Set())).toBe('finished')
    // Stale (its reporter may still run): not live, and not "ended".
    expect(runLife({ state: 'stale', finishedAt: null }, '40:1', present)).toBe('unconfirmed')
    // Its reporter gone, or its pid reused (the bound identity not present), no identity, no record.
    expect(runLife({ state: 'running', finishedAt: null }, '40:1', new Set(['40:2']))).toBe('unconfirmed')
    expect(runLife({ state: 'running', finishedAt: null }, null, present)).toBe('unconfirmed')
    expect(runLife(undefined, '40:1', present)).toBe('unconfirmed')
  })
})
