// What Hive keeps of its runs for their slot writers (HI-1886), in leftovers.json beside what agents left running: the
// launches not seen to end as Hive quit (their processes as last listed) and the runs seen to end. Read back by the
// next start (a new module, as a restarted Hive), kept forward until settled, and never offered as leftovers. No job
// host: no launch is running, so nothing is listed.
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
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as { launches: unknown[]; open?: { runId: string }[]; ended?: string[] }

/** The module as a Hive started now finds it. */
async function restarted(): Promise<typeof import('../src/main/agentProcesses')> {
  vi.resetModules()
  return import('../src/main/agentProcesses')
}

describe("a run's record for its slot writer (HI-1886)", () => {
  it('kept as Hive quits, read by the next start, kept forward until its writer is settled, and never listed as left running', async () => {
    const node = { pid: 5150, name: 'node.exe', label: 'node serve.js', created: '133900000000000000' }
    writeFileSync(file, JSON.stringify({ version: 1, launches: [], open: [{ runId: 'r-open', projectPath: 'C:\\p', agentId: 'b1', agentName: 'B1', since: '2026-10-27T22:22:10.000Z', processes: [node] }] }))
    let m = await restarted()
    expect(await m.earlierRun('r-open')).toEqual({ processes: [node] })
    expect(await m.earlierRun('r-none')).toBeNull()
    expect(m.allLeftovers()).toEqual([])
    // This run: one seen to end, one whose release couldn't be written; both kept as it quits, the earlier one too.
    m.settleRunForTests('r-done', 'ended')
    m.settleRunForTests('r-kept', 'kept')
    m.keepRunEnded('r-unwritten')
    await m.recordOpenLaunches()
    await m.leftoversSaved()
    expect(saved().open?.map((l) => l.runId)).toEqual(['r-open'])
    expect(saved().ended?.sort()).toEqual(['r-done', 'r-unwritten'])
    m = await restarted()
    expect(await m.earlierRun('r-done')).toEqual({ ended: true })
    expect(await m.earlierRun('r-kept')).toBeNull()
    // Settled: forgotten, the others kept.
    m.forgetEarlierRun('r-open')
    m.forgetEarlierRun('r-done')
    await vi.waitFor(async () => {
      await m.leftoversSaved()
      expect(saved()).toMatchObject({ ended: ['r-unwritten'] })
    }, { timeout: HUNG_MS })
    expect(saved().open).toBeUndefined()
    expect(await (await restarted()).earlierRun('r-unwritten')).toEqual({ ended: true })
  })
})
