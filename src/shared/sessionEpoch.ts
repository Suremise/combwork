// Which terminal an agent's pane shows (HI-2213): a new one for each run (launch) of its session, never another for the
// same run. Main tells a run's start more than once (a `starting` status updated while it starts, and the workspace's own
// report of its agents' states, which may come first), and each re-creation of the terminal throws away its screen and
// its WebGL context: under load the Assistant's terminal was re-mounted after it had drawn.

/**
 * Keeps, per agent terminal (pty key), the run its epoch (its React key's suffix) was made for. `starting` answers a
 * run's start with the terminal's epoch: a new one the first time a run is told, undefined (it stays) after that. `shown`
 * is the run the window's state already shows (the workspace reported it before the status event): with no epoch yet,
 * its terminal is already mounted for that run, at epoch 0.
 */
export function sessionEpochBook(): { starting: (key: string, runId: string, epoch: number | undefined, shown: string | undefined) => number | undefined } {
  const runs = new Map<string, string>()
  return {
    starting(key, runId, epoch, shown) {
      if (runs.get(key) === runId) return undefined
      runs.set(key, runId)
      if (epoch === undefined && shown === runId) return 0
      return (epoch ?? 0) + 1
    }
  }
}
