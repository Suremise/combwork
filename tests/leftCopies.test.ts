// Test copies of Combwork an earlier run left running (HI-1453), ended at a run's start: only in the lanes no running runner
// holds, only those started before the lanes were read (a runner claiming a lane after that starts its own after it).
// The real processes: the harnessleftovers e2e.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { LANES, claimLane, idleLanes, laneWork } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { endLeftCopies } from './e2e/leftCopies.mjs'
import { tempDir } from './tempDir'

describe('the lanes a run sweeps at its start (HI-1453)', () => {
  it("are those with no claim or a gone runner's, a running runner's kept however old its claim", async () => {
    const dir = tempDir('cw-idle-lanes-')
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

  it("ends the copies recorded in those lanes' folders started before they were read, and none while every lane is held", async () => {
    const dir = tempDir('cw-left-copies-')
    const work = join(dir, 'e2e')
    const calls: { folders: string[]; before: number }[] = []
    const unrecorded = [{ pid: 7, commandLine: 'electron.exe --combwork-test-profile=x' }]
    const end = (folders: string[], o: { before: number }) => (calls.push({ folders, before: o.before }), { ended: 3, unrecorded })
    const runner = await claimLane(dir, { owner: 100, alive: () => true, free: async () => true })
    expect(runner.lane).toBe(0)
    const before = Date.now()
    const got = await endLeftCopies(dir, work, { alive: (pid: number) => pid === 100, end })
    expect(got).toEqual({ ended: 3, unrecorded, lanes: Array.from({ length: LANES - 1 }, (_, k) => k + 1) })
    expect(calls).toHaveLength(1)
    expect(calls[0].folders).toEqual(got.lanes.map((k: number) => laneWork(work, k)))
    expect(calls[0].folders).not.toContain(laneWork(work, 0))
    expect(calls[0].before).toBeGreaterThanOrEqual(before)
    for (let k = 1; k < LANES; k++) writeFileSync(join(dir, `lane-${k}.json`), JSON.stringify({ pid: 100, at: Date.now() }))
    expect(await endLeftCopies(dir, work, { alive: () => true, end })).toEqual({ ended: 0, unrecorded: [], lanes: [] })
    expect(calls).toHaveLength(1)
  })

  it('the runner ends only recorded copies, and lists the rest without ending them (run.mjs)', () => {
    const run = readFileSync(join(__dirname, 'e2e', 'run.mjs'), 'utf8')
    expect(run).toContain('await endLeftCopies(runContext.LANES_DIR, lib.WORK)')
    expect(run).toContain('left.unrecorded.map(')
    // A suite's folder alone (HI-2663 passes the runner's one process listing beside it).
    expect(run).toMatch(/endCopies\(\[dir\](, \{ list: [^}]*\})?\)\.ended/)
    const fp = readFileSync(join(__dirname, 'e2e', 'folderProcesses.cjs'), 'utf8')
    const endCopiesSource = fp.slice(fp.indexOf('function endCopies('), fp.indexOf('module.exports'))
    // What it ends comes from the records alone: the guess at copies (command lines) only fills the list.
    expect(endCopiesSource).toMatch(/const copies = copiesIn\(list, folders\.flatMap\(\(f\) => recordedCopies\(f\)\)\)/)
    expect(endCopiesSource).toMatch(/for \(const p of copies\)/)
    expect(endCopiesSource).not.toMatch(/lookLikeCopies\([^)]*\)[^\n]*pick\.set/)
  })
})
