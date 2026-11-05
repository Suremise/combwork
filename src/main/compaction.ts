/** How long the CLI has to begin a compaction once Combwork has submitted its /compact (PreCompact), before Combwork stops waiting. */
export const BEGIN_MS = 20_000
/** How long a begun compaction may take, should the CLI never say it ended. */
export const LIMIT_MS = 10 * 60_000

/**
 * A compaction Combwork asked for (Compact), from the moment it is reserved, through typing its /compact (no limit
 * runs yet: a long focus takes a while to type) and its submission, until it is over. The CLI says so with
 * PostCompact; when it doesn't, Combwork learns it from the transcript (a compaction more than before), the terminal
 * (the CLI refused or failed it, which sends no hook), or the time limits. `over` is called once, whichever comes
 * first; a hook that ends it (PostCompact, or a prompt that starts a new turn) calls end() and takes care of the
 * status itself. One the CLI began by itself while the agent was idle is watched the same way from its PreCompact
 * (#1115: nothing else may say it is over).
 */
export class Compaction {
  started = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private output = ''
  private done = false

  constructor(
    /**
     * What came before it in the transcript: how many compactions (Combwork's own Compact counts them before typing it), or
     * when it began (one the CLI began by itself, #1115: counted after its PreCompact, a compaction written meanwhile
     * would pass for an earlier one), so only a compaction recorded since then is this one.
     */
    private readonly before: number | { since: number },
    /** What the CLI prints when it refuses or fails a compaction (ProviderAdapter.compactFailure). */
    private readonly failure: RegExp | null,
    private readonly over: () => void
  ) {}

  /** Combwork submitted the /compact: the CLI has BEGIN_MS to begin it. */
  submitted(): void {
    if (this.done || this.started) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.finish(), BEGIN_MS)
  }

  /** The CLI began it (PreCompact): it may now take up to LIMIT_MS. */
  begin(): void {
    if (this.done) return
    this.started = true
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.finish(), LIMIT_MS)
  }

  /** The transcript's compactions: one more than before, or one recorded since it began, means it is done. */
  transcript(compactions: readonly { timestamp: string }[]): void {
    const b = this.before
    if (typeof b === 'number' ? compactions.length > b : compactions.some((c) => Date.parse(c.timestamp) >= b.since)) this.finish()
  }

  /** Terminal output while it runs. */
  terminal(data: string): void {
    if (this.done || !this.failure) return
    // Terminal UIs draw spaces as cursor moves (ESC[1C), so control sequences become spaces. Keep a
    // short tail so a message split across chunks still matches.
    this.output = (this.output + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')).replace(/\s+/g, ' ').slice(-2000)
    if (this.failure.test(this.output)) this.finish()
  }

  /** Over, without `over` (a hook ended it, or the session exited). */
  end(): void {
    this.done = true
    clearTimeout(this.timer)
  }

  private finish(): void {
    if (this.done) return
    this.end()
    this.over()
  }
}
