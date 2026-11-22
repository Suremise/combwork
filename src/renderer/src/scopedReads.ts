/**
 * HI-3505 (HR2's round 1): reads of something that belongs to a scope (Changes' status of one folder and base), however
 * many things ask for them (a file event, the window's focus, the minute, a git change, Refresh). One read at a time:
 * those asked while one is under way for the same scope are one more after it. A read for another scope starts at once,
 * and every read of the earlier one is over: its answer is never taken, and it is never read again for what was asked
 * meanwhile. `take` gets each answer that is still the current scope's.
 */
export function scopedReader<T>(read: (scope: string) => Promise<T>, take: (scope: string, answer: { ok: true; value: T } | { ok: false; error: unknown }) => void): (scope: string) => void {
  let reads = 0
  /** The read under way (its number and scope), and whether another was asked for meanwhile. */
  let running: { n: number; scope: string; again: boolean } | null = null
  const reload = (scope: string): void => {
    if (running?.scope === scope) {
      running.again = true
      return
    }
    const n = ++reads
    running = { n, scope, again: false }
    const settled = (answer: { ok: true; value: T } | { ok: false; error: unknown }): void => {
      // Another scope's read began meanwhile: this one is over, answer and all.
      if (running?.n !== n) return
      take(scope, answer)
      const again = running.again
      running = null
      if (again) reload(scope)
    }
    void read(scope).then(
      (value) => settled({ ok: true, value }),
      (error: unknown) => settled({ ok: false, error })
    )
  }
  return reload
}
