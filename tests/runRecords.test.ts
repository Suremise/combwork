// What Hive keeps of its runs for their slot writers (HI-1886), in leftovers.json beside what agents left running: the
// runs whose processes it saw end (their jobs seen empty), also those whose releases couldn't be written. Read back by
// the next start (a new module, as a restarted Hive), kept forward until settled, and never offered as leftovers. No job
// host: no launch is running, so nothing is listed (the quit's look at running launches is agentProcesses.test.ts's).
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: () => undefined }))
const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => profile.dir } }
})
profile.dir = tempDir('hive-runrecords-profile-')
/** A hung run's bound: the records' writes follow each other, so this is never reached by a working one. */
const HUNG_MS = 10_000
const file = join(profile.dir, 'leftovers.json')
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as { launches: unknown[]; ended?: string[] }

/** The module as a Hive started now finds it. */
async function restarted(): Promise<typeof import('../src/main/agentProcesses')> {
  vi.resetModules()
  return import('../src/main/agentProcesses')
}

describe("a run's record for its slot writer (HI-1886)", () => {
  it('kept as Hive quits, read by the next start, kept forward until its writer is settled, and never listed as left running', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, launches: [], ended: ['r-before'] }))
    let m = await restarted()
    expect(await m.endedEarlier('r-before')).toBe(true)
    expect(await m.endedEarlier('r-none')).toBe(false)
    expect(m.allLeftovers()).toEqual([])
    // This run: one seen to end, one kept running, one whose release couldn't be written; the earlier one kept too.
    m.settleRunForTests('r-done', 'ended')
    m.settleRunForTests('r-kept', 'kept')
    m.keepRunEnded('r-unwritten')
    await m.recordEndedLaunches()
    await m.leftoversSaved()
    expect(saved().ended?.sort()).toEqual(['r-before', 'r-done', 'r-unwritten'])
    m = await restarted()
    expect(await m.endedEarlier('r-done')).toBe(true)
    expect(await m.endedEarlier('r-kept')).toBe(false)
    // Settled: forgotten, the others kept.
    m.forgetEarlierRun('r-before')
    m.forgetEarlierRun('r-done')
    await vi.waitFor(
      async () => {
        await m.leftoversSaved()
        expect(saved()).toMatchObject({ ended: ['r-unwritten'] })
      },
      { timeout: HUNG_MS }
    )
    expect(await (await restarted()).endedEarlier('r-unwritten')).toBe(true)
  })
})
