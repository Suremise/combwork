// HI-3477: Restore From → A Commit…'s picks. Each click reads that commit's plan; what the confirm shows and what
// Restore acts on are both the latest click's answer, never an earlier click's answer arriving later (round 1's
// finding: a late answer for A must not make Restore write A while B is shown).

/** What the list shows under it: the commit picked, its plan once read, or why it couldn't be. */
export interface PickShown<P> {
  commit: string
  plan: P | null
  error?: string
}

export interface CommitPicks<P> {
  /** A click on a commit: its plan read, and only the latest click's answer kept. */
  pick(commit: string): void
  /** The plan Restore acts on: the latest pick's, once read, and only if the file is there. */
  chosen(): P | null
  /** What is shown now. */
  shown(): PickShown<P> | null
  /** Told each time what is shown changes; returns its undo. */
  watch(fn: (s: PickShown<P> | null) => void): () => void
}

export function commitPicks<P extends { exists: boolean }>(read: (commit: string) => Promise<P>, errorText: (e: unknown) => string): CommitPicks<P> {
  let seq = 0
  let chosen: P | null = null
  let shown: PickShown<P> | null = null
  let listener: ((s: PickShown<P> | null) => void) | null = null
  const show = (s: PickShown<P>): void => {
    shown = s
    listener?.(s)
  }
  return {
    pick(commit) {
      const n = ++seq
      chosen = null
      show({ commit, plan: null })
      read(commit).then(
        (plan) => {
          if (n !== seq) return
          chosen = plan.exists ? plan : null
          show({ commit, plan })
        },
        (e) => {
          if (n !== seq) return
          show({ commit, plan: null, error: errorText(e) })
        }
      )
    },
    chosen: () => chosen,
    shown: () => shown,
    watch(fn) {
      listener = fn
      return () => {
        if (listener === fn) listener = null
      }
    }
  }
}
