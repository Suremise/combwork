// Test copies of Hive an earlier run left running (HI-1453), ended at a run's start: only in the lanes no running runner
// holds, only those started before the lanes were read (a runner claiming a lane after that starts its own after it).
// The real processes: the harnessleftovers e2e.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { LANES, claimLane, idleLanes, laneWork } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { endLeftCopies } from './e2e/leftCopies.mjs'
import { tempDir } from './tempDir'

describe('the lanes a run sweeps at its start (HI-1453)', () => {
  it("are those with no claim or a gone runner's, a running runner's kept however old its claim", async () => {
    const dir = tempDir('hive-idle-lanes-')
    const day = 25 * 60 * 60_000
    writeFileSync(join(dir, 'lane-0.json'), JSON.stringify({ pid: 100, at: Date.now() }))
    writeFileSync(join(dir, 'lane-1.json'), JSON.stringify({ pid: 200, at: Date.now() }))
    writeFileSync(join(dir, 'lane-2.json'), JSON.stringify({ pid: 100, at: Date.now() - day }))
    writeFileSync(join(dir, 'lane-3.json'), 'not json')
    const before = Date.now()
    const idle = await idleLanes(dir, { alive: (pid: number) => pid === 100 })
    expect(idle.lanes).toEqual(Array.from({ length: LANES }, (_, k) => k).filter((k) => k !== 0 && k !== 2))
    expect(idle.at).toBeGreaterThanOrEqual(before)
  })

  it("ends copies in those lanes' folders started before they were read, and none while every lane is held", async () => {
    const dir = tempDir('hive-left-copies-')
    const work = join(dir, 'e2e')
    const calls: { folders: string[]; before: number }[] = []
    const end = (folders: string[], o: { before: number }) => (calls.push({ folders, before: o.before }), 3)
    const runner = await claimLane(dir, { owner: 100, alive: () => true, free: async () => true })
    expect(runner.lane).toBe(0)
    const got = await endLeftCopies(dir, work, { alive: (pid: number) => pid === 100, end })
    expect(got).toEqual({ ended: 3, lanes: Array.from({ length: LANES - 1 }, (_, k) => k + 1) })
    expect(calls).toHaveLength(1)
    expect(calls[0].folders).toEqual(got.lanes.map((k: number) => laneWork(work, k)))
    expect(calls[0].folders).not.toContain(laneWork(work, 0))
    for (let k = 1; k < LANES; k++) writeFileSync(join(dir, `lane-${k}.json`), JSON.stringify({ pid: 100, at: Date.now() }))
    expect(await endLeftCopies(dir, work, { alive: () => true, end })).toEqual({ ended: 0, lanes: [] })
    expect(calls).toHaveLength(1)
  })
})
