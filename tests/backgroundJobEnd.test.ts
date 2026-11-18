// HI-3376: Stop It and Resume resumes a conversation only once the background job holding it is seen to have ended:
// gone from Claude Code's own listing of running sessions (`claude agents --json`, recorded with 2.1.327) and its own
// process (by pid and start) gone. A listing that fails is no answer, and still running or unknown at the bound refuses
// the resume. Time is faked.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runningJobsIn } = await import('../src/main/providers/claude/adapter')
const { backgroundJobEnded, backgroundTestHooks, BACKGROUND_END_MS } = await import('../src/main/sessions')
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
  return { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined, runningBackgroundJobs: async () => answers[Math.min(i++, answers.length - 1)] } } as unknown as Adapter
}
const JOB = '701b98b1'
const proc = { pid: 50124, parent: 80380, started: 1794975870720 }

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
    expect(runningJobsIn(out('running'))).toEqual([{ id: JOB, pid: 50124 }])
    expect(runningJobsIn(JSON.stringify([{ pid: 7, kind: 'interactive', status: 'idle' }]))).toEqual([])
  })

  it('after claude stop: none running (it stays only in --all, without a process)', () => {
    expect(runningJobsIn(out('after claude stop'))).toEqual([])
    expect(runningJobsIn(out('after the stop, first look: claude agents --json --all'))).toEqual([{ id: JOB, pid: null }])
  })

  it("what isn't a JSON list is no answer, not none running", () => {
    expect(runningJobsIn('')).toBeNull()
    expect(runningJobsIn("'claude agents --json' is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW.")).toBeNull()
    expect(runningJobsIn('{"id":"x"}')).toBeNull()
  })
})

describe('Stop It and Resume waits to see the job end (HI-3376)', () => {
  it('gone from the listing and its process gone: ended', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [{ pid: 1, parent: 0, started: 1 }]
    expect(await settle(backgroundJobEnded(adapterWith([[{ id: JOB, pid: 50124 }], [{ id: JOB, pid: 50124 }], []]), 'claude', JOB, proc))).toBe('ended')
  })

  it('gone from the listing but its process still running (by pid and start): running, so not resumed', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [proc]
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, proc))).toBe('running')
  })

  it('its pid now another process (a different start): that one is not the job, so ended', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => [{ ...proc, started: proc.started + 60_000 }]
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, proc))).toBe('ended')
  })

  it('still listed at the bound: running', async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([[{ id: JOB, pid: 50124 }]]), 'claude', JOB, proc))).toBe('running')
  })

  it("the listing failing at the bound (or a CLI that can't list its jobs): unknown, so not resumed", async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => []
    expect(await settle(backgroundJobEnded(adapterWith([null]), 'claude', JOB, proc))).toBe('unknown')
    const noListing = { background: { backgroundJobIn: () => null, stopBackgroundJob: async () => undefined } } as unknown as Adapter
    expect(await settle(backgroundJobEnded(noListing, 'claude', JOB, proc))).toBe('unknown')
  })

  it("the process listing failing once the CLI says it's gone: unknown at the bound", async () => {
    vi.useFakeTimers()
    backgroundTestHooks.list = async () => null
    expect(await settle(backgroundJobEnded(adapterWith([[]]), 'claude', JOB, proc))).toBe('unknown')
  })
})
