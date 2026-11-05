// Combwork's own test runners show in the Progress panel of the Combwork that launched the agent running them (#137): the e2e
// runner (tests/e2e/run.mjs) one step per suite, the scenarios runner (tests/scenarios/run.mjs) one per trial, the unit tests (a Vitest reporter, vitest.config.ts) one per file, each
// with an estimate from how long they took before (kept under %LOCALAPPDATA%\hive-test, never in the repo). Only when the
// Combwork variables are set and Combwork answers; never changes a result. Run under hive-progress, they print step lines for its
// run instead of reporting their own (one row). Off with --no-progress (e2e) or CW_PROGRESS=0. To remove it: delete this
// file and its two hooks.
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateFor, ProgressRun, progressTarget, recordTiming, wrappedLines, type ProgressTarget } from '../src/main/progressReporters/report.mts'

// Only the parts of Vitest's reporter API used here (no import from vitest: plain Node loads this file for run.mjs).
interface TestModule {
  moduleId: string
  relativeModuleId?: string
  ok(): boolean
}
interface TestSpecification {
  moduleId: string
}

// Where the runners' timings are kept (CW_TEST_PROGRESS_TIMINGS: another file, for this module's own tests).
const timings = (): string => process.env.CW_TEST_PROGRESS_TIMINGS || join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'progress-timings.json')

/** Whether to report: the Combwork variables are set (or it runs under hive-progress), and it isn't turned off. */
export function progressWanted(argv: string[] = process.argv): boolean {
  return !argv.includes('--no-progress') && (progressTarget() !== null || wrappedLines() !== undefined)
}

/** The expected time for the steps from `from` on: known ones as timed, unknown ones as the known ones' average. */
function remaining(estimates: (number | undefined)[], from: number): number | undefined {
  const known = estimates.filter((e): e is number => e !== undefined)
  if (!known.length) return undefined
  const average = known.reduce((a, b) => a + b, 0) / known.length
  return estimates.slice(from).reduce<number>((sum, e) => sum + (e ?? average), 0)
}

/** The e2e runner's run: suite(i, name) as each starts, done(name, ms, ok) as each ends, finish(ok, summary). */
export function e2eProgress(names: string[], argv: string[] = process.argv): { suite(i: number, name: string): void; done(name: string, ms: number, ok: boolean): void; finish(ok: boolean, summary?: string): Promise<void> } {
  if (!names.length || !progressWanted(argv)) return { suite() {}, done() {}, finish: async () => {} }
  const estimates = names.map((n) => estimateFor(timings(), `e2e:${n}`))
  const run = new ProgressRun(progressTarget(), {
    title: `e2e: ${names.length} suite${names.length === 1 ? '' : 's'}`,
    total: names.length,
    step: 0,
    estimateMs: remaining(estimates, 0),
    command: `npm run e2e${names.length <= 6 ? ` -- ${names.join(' ')}` : ''}`
  }, { lines: wrappedLines() })
  return {
    suite(i: number, name: string) {
      // The API counts the suites finished and names the one starting; the estimate is the time left from now.
      const left = remaining(estimates, i)
      run.update({ step: i, stepName: name, ...(left !== undefined ? { estimateMs: left } : {}) })
    },
    done(name: string, ms: number, ok: boolean) {
      if (ok) recordTiming(timings(), `e2e:${name}`, ms)
    },
    /** logPath: the run's record or logs, for its details in the panel. */
    finish: (ok: boolean, summary?: string, logPath?: string) => run.finish(ok, summary, undefined, logPath ? { logPath } : {}).then(() => undefined)
  }
}

/** What a scenarios run reports to: the Combwork's Agent API, or step lines for the hive-progress it runs under. */
export interface ProgressIo {
  target: ProgressTarget | null
  lines?: (line: string) => void
}

/**
 * The scenarios runner's run (tests/scenarios/run.mjs, #1457): one step per trial (a scenario, or one sample of it),
 * named with the results so far ("work-on-card · 11 ok, 1 failed"), so a run of an hour shows it moving and never goes
 * stale. `start(i, name)` as each begins, `done(id, ms, outcome)` as each ends (an ok trial's time kept for the next
 * run's estimate, by provider), `finish(ok, summary, logPath)`.
 */
export function scenariosProgress(names: string[], provider: string, argv: string[] = process.argv, io: ProgressIo = { target: progressTarget(), lines: wrappedLines() }): { start(i: number, name: string): void; done(id: string, ms: number, outcome: 'ok' | 'failed' | 'skipped'): void; finish(ok: boolean, summary?: string, logPath?: string): Promise<void> } {
  if (!names.length || argv.includes('--no-progress') || (!io.target && !io.lines)) return { start() {}, done() {}, finish: async () => {} }
  const key = (id: string): string => `scenario:${provider}:${id}`
  const estimates = names.map((n) => estimateFor(timings(), key(n)))
  const counts = { ok: 0, failed: 0, skipped: 0 }
  const so = (): string => {
    const parts = [...(counts.ok ? [`${counts.ok} ok`] : []), ...(counts.failed ? [`${counts.failed} failed`] : []), ...(counts.skipped ? [`${counts.skipped} skipped`] : [])]
    return parts.length ? ` · ${parts.join(', ')}` : ''
  }
  const run = new ProgressRun(io.target, {
    title: `scenarios: ${names.length} (${provider})`,
    total: names.length,
    step: 0,
    estimateMs: remaining(estimates, 0),
    command: `npm run scenarios${argv.length ? ` -- ${argv.join(' ')}` : ''}`
  }, { lines: io.lines })
  return {
    start(i: number, name: string) {
      const left = remaining(estimates, i)
      run.update({ step: i, stepName: `${name}${so()}`, ...(left !== undefined ? { estimateMs: left } : {}) })
    },
    done(id: string, ms: number, outcome: 'ok' | 'failed' | 'skipped') {
      counts[outcome]++
      if (outcome === 'ok') recordTiming(timings(), key(id), ms)
    },
    finish: (ok: boolean, summary?: string, logPath?: string) => run.finish(ok, summary, undefined, logPath ? { logPath } : {}).then(() => undefined)
  }
}

/**
 * A heavy run waiting for a test slot (tests/e2e/slots.mjs): a row of its own in the Progress panel ("e2e: waiting for
 * a test slot", naming who holds the slots) from the first time it has to wait until it gets one, so it shows as
 * waiting, not hung. Under hive-progress, the wrapper's row names the wait instead (wait lines). Either way the run is
 * waiting (#549): no time left, a waiting bar, and the wait not counted against the wrapper's estimate. Nothing until
 * waiting(), and nothing with --no-progress.
 */
export function slotWaitProgress(kind: string, command: string, argv: string[] = process.argv, resource = 'a test slot'): { waiting(holders: string): void; waitingAs(line: string): void; finish(summary: string): Promise<void> } {
  if (!progressWanted(argv)) return { waiting() {}, waitingAs() {}, finish: async () => {} }
  let run: ProgressRun | null = null
  const show = (waiting: string): void => {
    if (!run) run = new ProgressRun(progressTarget(), { title: `${kind}: waiting for ${resource}`, command, waiting }, { lines: wrappedLines() })
    else run.update({ waiting })
  }
  return {
    waiting: (holders: string) => show(`waiting for ${resource}: ${holders}`),
    // The whole line, as the test slots word it (slots.mjs waitSummary, HI-2070: what is ahead, by whose run).
    waitingAs: show,
    finish: async (summary: string) => {
      // Under hive-progress the wrapper's run goes on: it waits no more.
      run?.update({ waiting: '' })
      await run?.finish(true, summary)
    }
  }
}

/** The unit tests' run, as a Vitest reporter: one step per test file as it finishes. */
export class VitestProgress {
  private run: ProgressRun | null = null
  private files = 0
  private finished = 0
  private failed = 0
  private key = ''
  private started = 0

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    const names = [...new Set(specifications.map((s) => s.moduleId))].sort()
    this.files = names.length
    this.finished = 0
    this.failed = 0
    this.started = Date.now()
    // Timed as a whole: the same set of files (all of them, usually) takes about as long as last time.
    this.key = `unit:${names.length}:${names.join('|').length}`
    this.run = new ProgressRun(progressTarget(), { title: `unit: ${names.length} file${names.length === 1 ? '' : 's'}`, total: names.length, step: 0, estimateMs: estimateFor(timings(), this.key), command: 'npm test' }, { lines: wrappedLines() })
  }

  onTestModuleEnd(module: TestModule): void {
    this.finished++
    if (!module.ok()) this.failed++
    // Files run side by side: the count of those finished, with no one file named as running.
    this.run?.update({ step: Math.min(this.finished, this.files) })
  }

  async onTestRunEnd(_modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown> | undefined, reason: 'passed' | 'interrupted' | 'failed'): Promise<void> {
    const ok = reason === 'passed' && !errors?.length
    if (ok) recordTiming(timings(), this.key, Date.now() - this.started)
    const summary = reason === 'interrupted' ? 'interrupted' : `${this.finished - this.failed} passed, ${this.failed} failed`
    await this.run?.finish(ok, summary)
    this.run = null
  }
}
