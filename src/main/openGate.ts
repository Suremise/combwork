// HI-1954 (design HI-1954/s19 §1, s21 §3): a workspace's open point holds its agents back while its commands run. The
// gate is reserved as the workspace opens, before anything hears of the open (WorkspaceService.open), when its open
// point has commands; every start of an agent is refused while it is held (sessions.ts assertStartsAllowed), and Hive's
// own starts at an open (restartResume.ts) wait for it. It settles once: the list ended, the user didn't wait or chose
// Stop here, or the workspace closed or switched (its lifetime ended), when nothing it held starts.

/** How an open's gate settled. */
export type GateEnd = 'done' | 'detached' | 'stopped' | 'closed'

const settledListeners = new Set<() => void>()

/** Called each time a gate settles (restart-resume pumps again). */
export function onGateSettled(fn: () => void): () => void {
  settledListeners.add(fn)
  return () => settledListeners.delete(fn)
}

export class OpenGate {
  held = true
  end: GateEnd | null = null
  readonly settled: Promise<GateEnd>
  private resolveEnd!: (e: GateEnd) => void

  /** `generation`: the open it holds (WorkspaceService's generation then); `life`: that open's lifetime. */
  constructor(
    readonly generation: number,
    life: AbortSignal
  ) {
    this.settled = new Promise((r) => (this.resolveEnd = r))
    if (life.aborted) this.settle('closed')
    else life.addEventListener('abort', () => this.settle('closed'), { once: true })
  }

  /** Settles it, once: a later call does nothing (and says so). */
  settle(end: GateEnd): boolean {
    if (!this.held) return false
    this.held = false
    this.end = end
    this.resolveEnd(end)
    for (const l of settledListeners) l()
    return true
  }
}
