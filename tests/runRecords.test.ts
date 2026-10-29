// What Hive keeps of its runs for their slot writers (HI-1886), in leftovers.json beside what agents left running: the
// runs whose processes it saw end (their jobs seen empty), also those whose releases couldn't be written. Read back by
// the next start (a new module, as a restarted Hive), kept forward until settled, and never offered as leftovers. No job
// host: no launch is running, so nothing is listed (the quit's look at running launches is agentProcesses.test.ts's).
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: () => undefined }))
/**
 * The job host as a stand-in (HR2's round 2): its helper (`instance`) and what each request answers. `onList` runs as
 * a job is listed, before its answer: a test loses the helper there (`lose`), as one ending mid-request does, and the
 * next request starts another, which holds none of the old jobs and lists any as empty, as the real one does.
 */
const jobs = vi.hoisted(() => ({
  instance: 1 as number | null,
  listed: [] as string[],
  onList: (_run: string) => undefined as void,
  lose: (): void => undefined,
  /** Jobs still holding a process (HI-2055), as the helper holding them lists them; any other lists empty. */
  members: new Set<string>()
}))
vi.mock('../src/main/processSupervisor', async (orig) => {
  class JobHost {
    constructor(private readonly opts: { onLost: (why: string) => void }) {
      jobs.lose = () => {
        jobs.instance = null
        this.opts.onLost('the helper ended (test)')
      }
    }
    get pid(): number | null {
      return jobs.instance === null ? null : 4242
    }
    get instance(): number | null {
      return jobs.instance
    }
    get usable(): boolean {
      return true
    }
    async ensure(): Promise<boolean> {
      return true
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
    async request(cmd: string, run?: string): Promise<unknown> {
      // A request with no helper starts a new one.
      if (jobs.instance === null) jobs.instance = 2
      if (cmd === 'add') return 'ok'
      // Asked to end its processes: only asked (they end when the test says, `members`).
      if (cmd === 'kill' || cmd === 'forget') return true
      if (cmd !== 'list') return null
      jobs.listed.push(run!)
      jobs.onList(run!)
      if (jobs.instance === null) return null
      // A helper started since holds none of the old jobs: it lists each as empty.
      const held = jobs.instance === 1 && jobs.members.has(run!)
      return { processes: held ? [{ pid: 7001, name: 'node.exe', cmd: 'node server.js', created: '133000000000000000' }] : [], total: held ? 1 : 0, adopted: 0 }
    }
  }
  return { ...((await orig()) as object), JobHost }
})
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

  it.runIf(process.platform === 'win32')("the quit's look keeps a launch as ended only from the helper that held its job: one lost meanwhile keeps none (HR2's round 2)", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
    const track = async (m: typeof import('../src/main/agentProcesses'), runId: string) => expect(await m.trackLaunch({ runId, projectPath: profile.dir, agentId: runId, agentName: runId }, 100)).toEqual({ tracked: true })
    // The helper holding both jobs answers: both empty, both kept.
    jobs.instance = 1
    jobs.onList = () => undefined
    let m = await restarted()
    await track(m, 'q-1')
    await track(m, 'q-2')
    await m.recordEndedLaunches()
    expect([await m.endedEarlier('q-1'), await m.endedEarlier('q-2')]).toEqual([true, true])
    // The helper ends as the first job is listed: both lost (unknown), and the helper started for the next request has
    // neither job, so lists any as empty. Neither is kept as ended, and the look asks no more of it.
    writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
    jobs.instance = 1
    m = await restarted()
    await track(m, 'r-1')
    await track(m, 'r-2')
    jobs.listed.length = 0
    jobs.onList = (run) => {
      if (run === 'r-1') jobs.lose()
    }
    await m.recordEndedLaunches()
    expect([m.runOutcome('r-1'), m.runOutcome('r-2')]).toEqual(['unknown', 'unknown'])
    expect([await m.endedEarlier('r-1'), await m.endedEarlier('r-2')]).toEqual([false, false])
    expect(jobs.listed).toEqual(['r-1'])
    // The helper replaced before the look begins (its jobs lost with the old one): nothing kept either.
    jobs.instance = 1
    m = await restarted()
    await track(m, 's-1')
    jobs.lose()
    jobs.onList = () => undefined
    await m.recordEndedLaunches()
    expect(await m.endedEarlier('s-1')).toBe(false)
  })

  /**
   * HI-2055: a launch whose CLI exited leaving processes, which Hive quitting then ends (Settings → Agents): asked to end,
   * its job is looked at until seen empty (`confirming`). The quit's look waits for it as for a running launch, by the same
   * rules: kept as ended only once the helper that held its job sees it empty.
   */
  describe('leftovers Hive ended as it quits (HI-2055)', () => {
    const track = async (m: typeof import('../src/main/agentProcesses'), runId: string) => expect(await m.trackLaunch({ runId, projectPath: profile.dir, agentId: runId, agentName: runId }, 100)).toEqual({ tracked: true })
    /** A launch that left a process running, ended by Hive quitting: asked, not yet seen gone. */
    async function endedAtQuit(runId: string): Promise<typeof import('../src/main/agentProcesses')> {
      writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
      jobs.instance = 1
      jobs.onList = () => undefined
      const m = await restarted()
      await track(m, runId)
      jobs.members.add(runId)
      expect((await m.launchEnded(runId))?.processes).toHaveLength(1)
      expect(await m.settleAllLeftovers('end')).toBe(1)
      expect(m.runOutcome(runId)).toBeNull()
      return m
    }

    it.runIf(process.platform === 'win32')('seen gone during the look: kept as ended, so its writer settles after the restart', async () => {
      const m = await endedAtQuit('c-gone')
      jobs.members.delete('c-gone')
      await m.recordEndedLaunches()
      await m.leftoversSaved()
      expect(await (await restarted()).endedEarlier('c-gone')).toBe(true)
    })

    it.runIf(process.platform === 'win32')('settled ended meanwhile (its own poll saw it gone): kept', async () => {
      const m = await endedAtQuit('c-polled')
      jobs.onList = (run) => {
        if (run === 'c-polled') m.settleRunForTests('c-polled', 'ended')
      }
      await m.recordEndedLaunches()
      await m.leftoversSaved()
      expect(await (await restarted()).endedEarlier('c-polled')).toBe(true)
    })

    it.runIf(process.platform === 'win32')('still running when the look gives up: not kept, so its writer stays held', async () => {
      const m = await endedAtQuit('c-stays')
      await m.recordEndedLaunches()
      await m.leftoversSaved()
      expect(await (await restarted()).endedEarlier('c-stays')).toBe(false)
    }, 20_000)

    it.runIf(process.platform === 'win32')('its helper lost during the look, and the next one lists it empty: not kept', async () => {
      const m = await endedAtQuit('c-lost')
      jobs.onList = (run) => {
        if (run === 'c-lost') jobs.lose()
      }
      await m.recordEndedLaunches()
      expect(m.runOutcome('c-lost')).toBe('unknown')
      await m.leftoversSaved()
      expect(await (await restarted()).endedEarlier('c-lost')).toBe(false)
    })
  })
})
