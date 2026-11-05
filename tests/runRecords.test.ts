// What Combwork keeps of its runs for their slot writers (HI-1886), in leftovers.json beside what agents left running: the
// runs whose processes it saw end (their jobs seen empty), also those whose releases couldn't be written. Read back by
// the next start (a new module, as a restarted Combwork), kept forward until settled, and never offered as leftovers. No job
// host: no launch is running, so nothing is listed (the quit's look at running launches is agentProcesses.test.ts's).
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
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
  members: new Set<string>(),
  /** The last helper lost: the next one started is the one after it (each its own identity, HI-2055). */
  last: 1,
  /** Told as a helper is made ready (`ensure`), before it answers (HI-2055: a loss then). */
  onEnsure: () => undefined as void,
  /** Told as a launch's job is made (`add`), before it answers (HI-2055: a loss then). */
  onAdd: () => undefined as void,
  /** Processes still running, "pid:created" (HI-2303: an earlier Combwork's helper, keeping). */
  alive: new Set<string>(),
  /** The host can't say which still run. */
  identifyFails: false
}))
vi.mock('../src/main/processSupervisor', async (orig) => {
  const next = (): number => Math.max(2, jobs.last + 1)
  class JobHost {
    constructor(private readonly opts: { onLost: (why: string) => void }) {
      jobs.lose = () => {
        jobs.last = jobs.instance ?? jobs.last
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
      // As a request, it starts a helper when none runs.
      jobs.onEnsure()
      if (jobs.instance === null) jobs.instance = next()
      return true
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
    async request(cmd: string, run?: string): Promise<unknown> {
      // A request with no helper starts a new one.
      if (cmd === 'add') jobs.onAdd()
      if (jobs.instance === null) jobs.instance = next()
      if (cmd === 'add') return 'ok'
      // Asked to end its processes: only asked (they end when the test says, `members`).
      if (cmd === 'kill' || cmd === 'forget') return true
      // Configured as a keeper (HI-2055): each helper its own identity.
      if (cmd === 'keeper') return `${4000 + jobs.instance}:1`
      // Which processes still run (HI-2303: a binding's helper, "pid:created"): those the test says.
      if (cmd === 'identify') return jobs.identifyFails ? null : run!.split(',').filter((id) => jobs.alive.has(id))
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
profile.dir = tempDir('cw-runrecords-profile-')
/** A hung run's bound: the records' writes follow each other, so this is never reached by a working one. */
const HUNG_MS = 10_000
const file = join(profile.dir, 'leftovers.json')
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as { launches: unknown[]; ended?: string[] }

/** The module as a Combwork started now finds it. */
async function restarted(): Promise<typeof import('../src/main/agentProcesses')> {
  vi.resetModules()
  return import('../src/main/agentProcesses')
}

describe("a run's record for its slot writer (HI-1886)", () => {
  it('kept as Combwork quits, read by the next start, kept forward until its writer is settled, and never listed as left running', async () => {
    writeFileSync(file, JSON.stringify({ version: 1, launches: [], ended: ['r-before'] }))
    let m = await restarted()
    expect(await m.endedEarlier('r-before')).toBe(true)
    expect(await m.endedEarlier('r-none')).toBe(false)
    expect(m.allLeftovers()).toEqual([])
    // This run: one seen to end, one kept running, one whose release couldn't be written; the earlier one kept too. Each
    // took a slot's writer (HI-2299: only those are kept).
    for (const r of ['r-done', 'r-kept', 'r-unwritten']) m.runTookWriter(r)
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

  it("a busy day's ended runs never push out those a later start needs (HI-2299)", async () => {
    // An earlier Combwork's record not settled yet (its workspace not reopened since).
    writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
    let m = await restarted()
    m.runTookWriter('w-earlier')
    m.keepRunEnded('w-earlier')
    await m.recordEndedLaunches()
    await m.leftoversSaved()
    m = await restarted()
    // A closed workspace's release that couldn't be written, kept first; then 150 runs end (no writer, or released);
    // then the last workspace's writer, stopped by the quit, its release not written yet.
    m.runTookWriter('w-closed')
    m.settleRunForTests('w-closed', 'ended')
    m.keepRunEnded('w-closed')
    for (let i = 0; i < 150; i++) {
      const run = `busy-${i}`
      if (i % 2) m.runTookWriter(run)
      m.settleRunForTests(run, 'ended')
      if (i % 2) m.runWriterReleased(run)
    }
    m.runTookWriter('w-last')
    m.settleRunForTests('w-last', 'ended')
    await m.recordEndedLaunches()
    await m.leftoversSaved()
    expect(saved().ended?.sort()).toEqual(['w-closed', 'w-earlier', 'w-last'])
    m = await restarted()
    expect([await m.endedEarlier('w-earlier'), await m.endedEarlier('w-closed'), await m.endedEarlier('w-last'), await m.endedEarlier('busy-1')]).toEqual([true, true, true, false])
  })

  it.runIf(process.platform === 'win32')("the quit's look keeps a launch as ended only from the helper that held its job: one lost meanwhile keeps none (HR2's round 2)", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
    const track = async (m: typeof import('../src/main/agentProcesses'), runId: string) => {
      // A slot's writer's run (HI-2299: only those are kept).
      m.runTookWriter(runId)
      expect(await m.trackLaunch({ runId, projectPath: profile.dir, agentId: runId, agentName: runId }, 100)).toEqual({ tracked: true })
    }
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
   * HI-2055: a launch whose CLI exited leaving processes, which Combwork quitting then ends (Settings → Agents): asked to end,
   * its job is looked at until seen empty (`confirming`). The quit's look waits for it as for a running launch, by the same
   * rules: kept as ended only once the helper that held its job sees it empty.
   */
  describe('leftovers Combwork ended as it quits (HI-2055)', () => {
    const track = async (m: typeof import('../src/main/agentProcesses'), runId: string) => {
      // A slot's writer's run (HI-2299: only those are kept).
      m.runTookWriter(runId)
      expect(await m.trackLaunch({ runId, projectPath: profile.dir, agentId: runId, agentName: runId }, 100)).toEqual({ tracked: true })
    }
    /** A launch that left a process running, ended by Combwork quitting: asked, not yet seen gone. */
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

  /**
   * HI-2055: a run bound to the helper that holds its job, kept in the profile, so the next start takes that helper's
   * keeper's state (keeper-<run>.json) for it, and nothing else: whole, its own run and Combwork, a helper bound and not
   * revoked. A lost helper is revoked before its replacement is given a launch, kept before it is.
   */
  describe("a keeper's state (HI-2055)", () => {
    const HIVE = '100:5'
    const keeperFile = (run: string) => join(profile.dir, 'keeper', `keeper-${run}.json`)
    const state = (run: string, o: Record<string, unknown> = {}) => ({ v: 1, run, helper: '4001:1', app: HIVE, state: 'ended', observed: 'complete', total: 0, members: [], at: 1, ...o })
    const plantState = (run: string, data: unknown) => {
      mkdirSync(join(profile.dir, 'keeper'), { recursive: true })
      writeFileSync(keeperFile(run), typeof data === 'string' ? data : JSON.stringify(data))
    }
    /** A Combwork started now, tracking with the first helper (4001:1). */
    async function tracking(): Promise<typeof import('../src/main/agentProcesses')> {
      writeFileSync(file, JSON.stringify({ version: 1, launches: [] }))
      jobs.instance = 1
      jobs.last = 1
      jobs.onList = () => undefined
      jobs.onEnsure = () => undefined
      jobs.onAdd = () => undefined
      const m = await restarted()
      m.setCombworkIdentity(async () => HIVE)
      return m
    }
    const failWrites = (m: typeof import('../src/main/agentProcesses')) => {
      m.testHooks.write = async () => {
        throw new Error('disk full (test)')
      }
    }
    const track = async (m: typeof import('../src/main/agentProcesses'), runId: string) => (await m.trackLaunch({ runId, projectPath: profile.dir, agentId: runId, agentName: runId }, 100)).tracked

    it.runIf(process.platform === 'win32')('its binding outlives a crash: the next start takes its "ended", and lists its "live" members', async () => {
      const m = await tracking()
      expect(await track(m, 'k-run')).toBe(true)
      await m.leftoversSaved()
      // Combwork gone without quitting: a new start reads the binding back.
      const next = await restarted()
      plantState('k-run', state('k-run'))
      expect(await next.keeperState('k-run', HIVE)).toEqual({ state: 'ended', helper: '4001:1' })
      plantState('k-run', state('k-run', { state: 'live', total: 2, members: [{ pid: 7001, created: '133000000000000000', name: 'node' }] }))
      // Its total counts one member it doesn't describe (HI-2309, HR1's round 3): said, so nothing takes the list as all.
      expect(await next.keeperState('k-run', HIVE)).toMatchObject({ state: 'live', helper: '4001:1', members: [{ pid: 7001, created: '133000000000000000', name: 'node' }], more: 1 })
      // Console hosts it describes are counted, never listed: not "more".
      plantState('k-run', state('k-run', { state: 'live', total: 2, members: [{ pid: 7001, created: '133000000000000000', name: 'node' }, { pid: 7002, created: '133000000000000000', name: 'conhost' }] }))
      expect(await next.keeperState('k-run', HIVE)).toMatchObject({ state: 'live', members: [{ pid: 7001 }], more: 0 })
    })

    it.runIf(process.platform === 'win32')("none taken unless whole and its own: another helper, Combwork or run, a version, an incomplete or non-empty \"ended\", a bad member, malformed or too large", async () => {
      const m = await tracking()
      expect(await track(m, 'k-bad')).toBe(true)
      const bad: unknown[] = [
        state('k-bad', { helper: '4999:1' }),
        state('k-bad', { app: '100:6' }),
        state('k-bad', { run: 'k-other' }),
        state('k-bad', { v: 2 }),
        state('k-bad', { observed: undefined }),
        state('k-bad', { total: 1 }),
        state('k-bad', { members: [{ pid: 7001, created: '133000000000000000', name: 'node' }] }),
        state('k-bad', { state: 'gone' }),
        state('k-bad', { state: 'live', total: 1, members: [{ pid: 7001, created: '0', name: 'node' }] }),
        state('k-bad', { state: 'live', total: 0, members: [{ pid: 7001, created: '133000000000000000', name: 'node' }] }),
        '{"v":1,"run":"k-bad",',
        state('k-bad', { pad: 'x'.repeat(70 * 1024) })
      ]
      for (const b of bad) {
        plantState('k-bad', b)
        expect(await m.keeperState('k-bad', HIVE), JSON.stringify(b).slice(0, 120)).toBeNull()
      }
      // A run never bound (tracked before this change, or by no keeper): none.
      plantState('k-unbound', state('k-unbound'))
      expect(await m.keeperState('k-unbound', HIVE)).toBeNull()
      // The good one, for contrast.
      plantState('k-bad', state('k-bad'))
      expect(await m.keeperState('k-bad', HIVE)).toEqual({ state: 'ended', helper: '4001:1' })
    })

    it.runIf(process.platform === 'win32')('a lost helper is revoked at once, and kept before its replacement is given a launch; a receipt it writes later frees nothing', async () => {
      const m = await tracking()
      expect(await track(m, 'k-old')).toBe(true)
      plantState('k-old', state('k-old'))
      expect(m.keeperStillBound('k-old', '4001:1')).toBe(true)
      jobs.lose()
      // Known at once (a clear's guard reads it), before anything is written.
      expect(m.keeperStillBound('k-old', '4001:1')).toBe(false)
      expect(await m.keeperState('k-old', HIVE)).toBeNull()
      // The next launch goes to the new helper, bound to it, once the revocation is kept.
      expect(await track(m, 'k-new')).toBe(true)
      expect(m.keeperStillBound('k-new', '4002:1')).toBe(true)
      await m.leftoversSaved()
      const kept = JSON.parse(readFileSync(file, 'utf8')) as { revoked?: string[]; helpers?: Record<string, string> }
      expect(kept.revoked).toEqual(['4001:1'])
      // The revoked helper's binding went with its revocation.
      expect(kept.helpers).toEqual({ 'k-new': '4002:1' })
      // After a restart too.
      expect(await (await restarted()).keeperState('k-old', HIVE)).toBeNull()
    })

    it.runIf(process.platform === 'win32')('a revocation never lapses: after more losses than the revoked list keeps, the first helper still frees nothing, after a restart too (HR2\'s round 1)', async () => {
      const m = await tracking()
      expect(await track(m, 'k-oldest')).toBe(true)
      plantState('k-oldest', state('k-oldest'))
      for (let i = 0; i < 55; i++) {
        jobs.lose()
        expect(await track(m, `k-${i}`)).toBe(true)
      }
      expect(await m.keeperState('k-oldest', HIVE)).toBeNull()
      await m.leftoversSaved()
      const kept = JSON.parse(readFileSync(file, 'utf8')) as { revoked?: string[]; helpers?: Record<string, string> }
      // The list kept is bounded, the binding went with the revocation.
      expect(kept.revoked).not.toContain('4001:1')
      expect(kept.helpers?.['k-oldest']).toBeUndefined()
      expect(await (await restarted()).keeperState('k-oldest', HIVE)).toBeNull()
    })

    it.runIf(process.platform === 'win32')("a helper lost while the launch's helper is made ready, its revocation not kept: the launch isn't tracked", async () => {
      const m = await tracking()
      expect(await track(m, 'k-before')).toBe(true)
      await m.leftoversSaved()
      failWrites(m)
      jobs.onEnsure = () => {
        jobs.onEnsure = () => undefined
        jobs.lose()
      }
      try {
        expect(await track(m, 'k-during-ensure')).toBe(false)
      } finally {
        m.testHooks.write = null
      }
      expect(m.keeperStillBound('k-before', '4001:1')).toBe(false)
      // Kept now: tracked by the new helper, bound to it.
      expect(await track(m, 'k-after')).toBe(true)
      expect(m.keeperStillBound('k-after', '4002:1')).toBe(true)
    })

    it.runIf(process.platform === 'win32')("a helper lost while the launch's job is made: its revocation not kept, the launch isn't tracked; kept, it is tracked but bound to no helper", async () => {
      const m = await tracking()
      expect(await track(m, 'k-first')).toBe(true)
      await m.leftoversSaved()
      failWrites(m)
      jobs.onAdd = () => {
        jobs.onAdd = () => undefined
        jobs.lose()
      }
      try {
        expect(await track(m, 'k-during-add')).toBe(false)
      } finally {
        m.testHooks.write = null
      }
      // The same, the revocation kept: its job was made by a helper its keeper wasn't configured on, so no binding.
      jobs.onAdd = () => {
        jobs.onAdd = () => undefined
        jobs.lose()
      }
      expect(await track(m, 'k-across-add')).toBe(true)
      for (const h of ['4001:1', '4002:1', '4003:1', '4004:1']) expect(m.keeperStillBound('k-across-add', h)).toBe(false)
    })

    it.runIf(process.platform === 'win32')("the revocation can't be kept: no launch is given to the new helper (untracked, said), until it can", async () => {
      const m = await tracking()
      expect(await track(m, 'k-first')).toBe(true)
      await m.leftoversSaved()
      failWrites(m)
      try {
        jobs.lose()
        const refused = await m.trackLaunch({ runId: 'k-refused', projectPath: profile.dir, agentId: 'k', agentName: 'k' }, 100)
        expect(refused).toMatchObject({ tracked: false })
        expect(m.runOutcome('k-refused')).toBeNull()
      } finally {
        m.testHooks.write = null
      }
      // Kept now: the next launch is tracked, by the new helper.
      expect(await track(m, 'k-later')).toBe(true)
      expect(m.keeperStillBound('k-later', '4002:1')).toBe(true)
      await m.leftoversSaved()
      expect((JSON.parse(readFileSync(file, 'utf8')) as { revoked?: string[] }).revoked).toEqual(['4001:1'])
    })

    /**
     * HI-2303: bindings are kept by need, not by age. A busy day's launches (160 here, past the old bound of 100) settle
     * as they go, and the few still holding a slot's writer, bound first, stay through a quit and a restart, where their
     * keepers' "ended" settles them.
     */
    it.runIf(process.platform === 'win32')('kept by need: 160 settled launches after them never push out the oldest still holding a writer, through a quit and a restart', async () => {
      const m = await tracking()
      const held = ['u-1', 'u-2', 'u-3']
      for (const run of held) {
        m.runTookWriter(run)
        expect(await track(m, run)).toBe(true)
      }
      for (let i = 0; i < 160; i++) {
        const run = `s-${i}`
        if (i % 2) m.runTookWriter(run)
        expect(await track(m, run)).toBe(true)
        // Ended, or kept running by the user: with a writer, its release written; without one, nothing to free.
        m.settleRunForTests(run, i % 3 ? 'ended' : 'kept')
        if (i % 2) m.runWriterReleased(run)
      }
      // Their processes not known to have ended (kept, the job lost): their writers stay held, so their bindings do too.
      for (const run of held) m.settleRunForTests(run, 'unknown')
      for (const run of held) expect(m.keeperStillBound(run, '4001:1')).toBe(true)
      expect(m.keeperStillBound('s-0', '4001:1')).toBe(false)
      expect(m.keeperStillBound('s-159', '4001:1')).toBe(false)
      // Combwork quits.
      await m.recordEndedLaunches()
      await m.leftoversSaved()
      expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { helpers?: Record<string, string> }).helpers ?? {}).sort()).toEqual(held)
      // The next start: each one's keeper says it ended, and its writer settles by it.
      const next = await restarted()
      for (const run of held) plantState(run, state(run))
      for (const run of held) expect(await next.keeperState(run, HIVE)).toEqual({ state: 'ended', helper: '4001:1' })
      next.forgetKeeperRun('u-1')
      expect(next.keeperStillBound('u-1', '4001:1')).toBe(false)
      await next.leftoversSaved()
      expect(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { helpers?: Record<string, string> }).helpers ?? {}).sort()).toEqual(['u-2', 'u-3'])
      expect(await next.keeperState('u-2', HIVE)).toEqual({ state: 'ended', helper: '4001:1' })
    })

    it.runIf(process.platform === 'win32')("an earlier Combwork's binding goes at the start only when its helper has gone and left no state: one keeping, or with a state, stays", async () => {
      writeFileSync(file, JSON.stringify({ version: 1, launches: [], helpers: { 'o-gone': '4007:1', 'o-state': '4007:1', 'o-keeping': '4008:1' } }))
      jobs.instance = 1
      jobs.alive = new Set(['4008:1'])
      try {
        const m = await restarted()
        plantState('o-state', state('o-state', { helper: '4007:1' }))
        await m.pruneKeeperStates()
        await m.leftoversSaved()
        expect((JSON.parse(readFileSync(file, 'utf8')) as { helpers?: Record<string, string> }).helpers).toEqual({ 'o-state': '4007:1', 'o-keeping': '4008:1' })
        expect(await m.keeperState('o-state', HIVE)).toEqual({ state: 'ended', helper: '4007:1' })
        // Which still run can't be told (the host doesn't answer): none goes.
        writeFileSync(file, JSON.stringify({ version: 1, launches: [], helpers: { 'o-gone': '4007:1' } }))
        jobs.identifyFails = true
        const unsure = await restarted()
        await unsure.pruneKeeperStates()
        expect(unsure.keeperStillBound('o-gone', '4007:1')).toBe(true)
      } finally {
        jobs.alive = new Set()
        jobs.identifyFails = false
      }
    })
  })
})
