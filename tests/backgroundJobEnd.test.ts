// HI-3376: Stop It and Resume resumes a conversation only once the background job holding it is seen to have ended:
// gone from Claude Code's own listing of running sessions (`claude agents --json`, recorded with 2.1.327) and its own
// process (by pid and start) gone. A listing that fails is no answer, and still running or unknown at the bound refuses
// the resume. Time is faked.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { timing } from './timing.cjs'

const { runningJobsIn } = await import('../src/main/providers/claude/adapter')
const { completeProcessList } = await import('../src/main/processTree')
const { backgroundJobEnded, backgroundTestHooks, jobProcess, BACKGROUND_END_MS } = await import('../src/main/sessions')
const { completeListing, listProcesses } = await import('../src/main/processTree')
const { advanced } = await import('../src/main/advanced')
const { tempDir } = await import('./tempDir')
type Adapter = Parameters<typeof backgroundJobEnded>[0]

/** The recorded listings (tests/fixtures/advanced/agents-json-claude-2.1.327.jsonl), by step. */
const recorded = readFileSync(join(__dirname, 'fixtures', 'advanced', 'agents-json-claude-2.1.327.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { step: string; out: unknown[] })
const out = (step: string): string => JSON.stringify(recorded.find((r) => r.step.startsWith(step))!.out)

/** An adapter whose listing of running jobs is each of `answers` in turn (past the last, the last); null: it failed. */
const adapterWith = (answers: ({ id: string; pid: number | null }[] | null)[]): Adapter => {
  let i = 0
  const listing = (jobs: { id: string; pid: number | null }[] | null) => (jobs === null ? null : { jobs, names: (id: string) => jobs.some((j) => j.id === id) })
  return { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined, runningBackgroundJobs: async () => listing(answers[Math.min(i++, answers.length - 1)]) } } as unknown as Adapter
}
/** An adapter whose listing is what Claude Code printed, each time (`stdouts` in turn, past the last the last), read by runningJobsIn. */
const adapterReading = (stdouts: string[]): Adapter => {
  let i = 0
  return { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined, runningBackgroundJobs: async () => runningJobsIn(stdouts[Math.min(i++, stdouts.length - 1)]) } } as unknown as Adapter
}
const JOB = '701b98b1'
const proc = { pid: 50124, parent: 80380, started: 1794975870720 }
/** What was known before the stop: its own process. */
const known = { kind: 'process' as const, proc }

afterEach(() => {
  backgroundTestHooks.list = undefined
  vi.useRealTimers()
})

/** backgroundJobEnded's answer, run to its end on fake time. */
async function settle(p: Promise<string>): Promise<string> {
  let got: string | null = null
  void p.then((v) => (got = v))
  await vi.advanceTimersByTimeAsync(BACKGROUND_END_MS + 5000)
  return got!
}

describe("Claude Code's listing of running sessions (2.1.327)", () => {
  it('a background job running: its id (the one claude stop takes) and its own process; interactive sessions have no id and are left out', () => {
    expect(runningJobsIn(out('running'))?.jobs).toEqual([{ id: JOB, pid: 50124 }])
    expect(runningJobsIn(out('running'))?.names(JOB)).toBe(true)
    expect(runningJobsIn(JSON.stringify([{ pid: 7, kind: 'interactive', status: 'idle' }]))?.jobs).toEqual([])
  })

  it('after claude stop: none running (it stays only in --all, without a process)', () => {
    expect(runningJobsIn(out('after claude stop'))?.jobs).toEqual([])
    expect(runningJobsIn(out('after claude stop'))?.names(JOB)).toBe(false)
    expect(runningJobsIn(out('after the stop, first look: claude agents --json --all'))?.jobs).toEqual([{ id: JOB, pid: null }])
  })

  it("what isn't a JSON list is no answer, not none running", () => {
    expect(runningJobsIn('')).toBeNull()
    expect(runningJobsIn("'claude agents --json' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.")).toBeNull()
    expect(runningJobsIn('{"id":"x"}')).toBeNull()
  })
})

describe("HR3's round 2: the id field wrong, read through the parser, the before-capture and the end's looks", () => {
  it('the recorded running row with idField wrong: unknown before the stop, so unknown, though the listing parses to no jobs', async () => {
    advanced.load(tempDir('cw-bgjob-advanced-'))
    try {
      await advanced.set('claude-code.background.idField', 'wrongId')
      backgroundTestHooks.list = async () => [proc]
      // Before the stop, and after it, Claude Code lists the job as recorded: its id under `id`, not `wrongId`.
      const cli = adapterReading([out('running')])
      expect(runningJobsIn(out('running'))?.jobs).toEqual([])
      const before = await jobProcess(cli, 'claude', JOB)
      expect(before).toEqual({ kind: 'unknown' })
      vi.useFakeTimers()
      expect(await settle(backgroundJobEnded(cli, 'claude', JOB, before))).toBe('unknown')
      // With the field right, the same row is the job's own process.
      vi.useRealTimers()
      await advanced.set('claude-code.background.idField', null)
      expect(await jobProcess(adapterReading([out('running')]), 'claude', JOB)).toEqual({ kind: 'process', proc })
    } finally {
      await advanced.resetAll()
      advanced.stop()
    }
  })

  it('after the stop, a listing that names the job without reading it as one is unknown, never ended', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    const cli = adapterReading([JSON.stringify([{ jobId: JOB, pid: 50124, kind: 'background' }])])
    expect(await settle(backgroundJobEnded(cli, 'claude', JOB, known))).toBe('unknown')
  })
})

describe('a real PowerShell listing that reports an error part way is no answer (HR3\'s round 2)', () => {
  it('valid rows, then a non-terminating error, then the rest: null; the same without the error: the rows', async () => {
    expect(await completeListing("'4 0 1000'; Write-Error 'synthetic mid-list failure'; '5 0 1001'", 20_000)).toBeNull()
    expect(await completeListing("'4 0 1000'; '5 0 1001'", 20_000)).toEqual([
      { pid: 4, parent: 0, started: 1000 },
      { pid: 5, parent: 0, started: 1001 }
    ])
  }, timing('test.hang'))

  it("HI-3433: Windows' System Idle Process row (pid 0) is no process, and the listing still complete; the real listing has this process", async () => {
    expect(await completeListing("'0 0 1794561628732'; '4 0 1000'", 20_000)).toEqual([{ pid: 4, parent: 0, started: 1000 }])
    const list = await listProcesses()
    expect(list?.some((p) => p.pid === process.pid)).toBe(true)
  }, timing('test.hang'))
})

describe("a process listing is an answer only when complete (HR1's round 1)", () => {
  it('exited by itself with 0, every line a process, ending with its end line: the processes', () => {
    expect(completeProcessList('50124 80380 1794975870720\r\n4 0 1000\r\nend\r\n', true)).toEqual([proc, { pid: 4, parent: 0, started: 1000 }])
    // HI-3433: led by Windows' System Idle Process (pid 0), not a process: the rest, never no answer.
    expect(completeProcessList('0 0 1794561628732\r\n50124 80380 1794975870720\r\n4 0 1000\r\nend\r\n', true)).toEqual([proc, { pid: 4, parent: 0, started: 1000 }])
    expect(completeProcessList('0 0 1794561628732\r\nend\r\n', true)).toBeNull()
  })

  it('some valid rows, then cut short (ended at its bound or failing: not ok), or without its end line, or with a line not a process: no answer', () => {
    expect(completeProcessList('4 0 1000\r\n', false)).toBeNull()
    expect(completeProcessList('4 0 1000\r\nend\r\n', false)).toBeNull()
    expect(completeProcessList('4 0 1000\r\n5 0 1001\r\n', true)).toBeNull()
    expect(completeProcessList('4 0 1000\r\nGet-CimInstance : Access denied\r\nend\r\n', true)).toBeNull()
    expect(completeProcessList('end\r\n', true)).toBeNull()
  })
})

describe('Stop It and Resume waits to see the job end (HI-3376)', () => {
  it("HR1's case: nothing known before the stop (its listing failed), then an empty listing: unknown, never ended", async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, { kind: 'unknown' }))).toBe('unknown')
  })

  it('the job listed without a process before the stop (the process field wrong, or none given): unknown', async () => {
    vi.useFakeTimers()
    expect(runningJobsIn(JSON.stringify([{ id: JOB, processId: 50124 }]))?.jobs).toEqual([{ id: JOB, pid: null }])
    expect(runningJobsIn(JSON.stringify([{ jobId: JOB, pid: 50124 }]))?.jobs).toEqual([])
    // Not read as a job, but named: no proof it isn't running.
    expect(runningJobsIn(JSON.stringify([{ jobId: JOB, pid: 50124 }]))?.names(JOB)).toBe(true)
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, { kind: 'unknown' }))).toBe('unknown')
  })

  it('not running before the stop (a parsed listing without it), or its process already gone: ended once the listing says so', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [proc]
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, { kind: 'notRunning' }))).toBe('ended')
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, { kind: 'gone' }))).toBe('ended')
  })

  it('each look bounded by the time left: a CLI that takes its whole bound each time is given only what is left', async () => {
    vi.useFakeTimers()
    const given: number[] = []
    const slow = { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined, runningBackgroundJobs: (_exe: string, ms?: number) => (given.push(ms ?? -1), new Promise((r) => setTimeout(() => r({ jobs: [{ id: JOB, pid: 50124 }], names: (id: string) => id === JOB }), ms ?? 0))) } } as unknown as Adapter
    backgroundTestHooks.list = async () => [proc]
    let got: string | null = null
    void backgroundJobEnded(slow, 'claude', JOB, known).then((v) => (got = v))
    await vi.advanceTimersByTimeAsync(BACKGROUND_END_MS)
    expect(got).toBe('running')
    expect(given[0]).toBe(BACKGROUND_END_MS)
    expect(given.every((ms) => ms > 0 && ms <= BACKGROUND_END_MS)).toBe(true)
  })

  it('gone from the listing and its process gone: ended', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [{ pid: 1, parent: 0, started: 1 }]
    expect(await settle(backgroundJobEnded(adapterWith([[{ id: JOB, pid: 50124 }], [{ id: JOB, pid: 50124 }], []]), 'claude', JOB, known))).toBe('ended')
  })

  it('gone from the listing but its process still running (by pid and start): running, so not resumed', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [proc]
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, known))).toBe('running')
  })

  it('its pid now another process (a different start): that one is not the job, so ended', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [{ ...proc, started: proc.started + 60_000 }]
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, known))).toBe('ended')
  })

  it('still listed at the bound: running', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([[{ id: JOB, pid: 50124 }]]), 'claude', JOB, known))).toBe('running')
  })

  it("the listing failing at the bound (or a CLI that can't list its jobs): unknown, so not resumed", async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([null]), 'claude', JOB, known))).toBe('unknown')
    const noListing = { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined } } as unknown as Adapter
    expect(await settle(backgroundJobEnded(noListing, 'claude', JOB, known))).toBe('unknown')
  })

  it("the process listing failing once the CLI says it's gone: unknown at the bound", async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => null
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, known))).toBe('unknown')
  })
})
