/**
 * Times the steps of something that can be slow for reasons a log can't otherwise show (a session's start, #1177):
 * each mark ends the step begun at the one before. `slowLine()` says which steps took longer than `slowMs`.
 */
export class StepTimes {
  private readonly started: number
  private last: number
  readonly steps: [step: string, ms: number][] = []

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = this.last = now()
  }

  mark(step: string): void {
    const t = this.now()
    this.steps.push([step, t - this.last])
    this.last = t
  }

  /** From the start to now. */
  elapsed(): number {
    return this.now() - this.started
  }

  /**
   * "took 43.1 s: resumeProvider 42.0 s, usage 1.1 s" once the whole took over `slowMs` (the steps over it named, the
   * slowest first; none named when the time went on many short ones), else null.
   */
  slowLine(slowMs = 1000): string | null {
    const total = this.elapsed()
    if (total <= slowMs) return null
    const slow = this.steps.filter(([, ms]) => ms > slowMs).sort((a, b) => b[1] - a[1])
    const named = slow.map(([step, ms]) => `${step} ${seconds(ms)}`).join(', ')
    return `took ${seconds(total)}${named ? `: ${named}` : ` (no step over ${seconds(slowMs)})`}` // i18n-ignore: for the log
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}
