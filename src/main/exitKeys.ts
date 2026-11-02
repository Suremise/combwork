/**
 * Ending a CLI with its exit key on conditions (HI-2272), for Stop (sessions.endProcess) on a CLI whose adapter says
 * what its screen shows once the key is armed (exitKeys.armed: Copilot's "ctrl+c again to exit"). The key at a fixed
 * beat (three Ctrl+C 400 ms apart) lost the exit under load: a turn's cancel took ~380 ms, the second key arrived 18 ms
 * after the turn ended and was lost as it wound down, and the third only armed it again, so Copilot was killed without
 * writing its token totals. Here each key waits for what it is for:
 * - A turn under way (or its dialog): the key cancels it, then its end is waited for, as Hive's own view of it says
 *   (the turn ledger, read from the CLI's events about a second after it ended).
 * - At its prompt: the key arms the exit, and the hint is waited for. Not shown in `armMs`, the key was lost: the
 *   next arms it again (a key at its prompt only ever arms or exits it).
 * - Armed: the key exits it. The hint gone and the CLI still running, the exit was lost too: it starts again.
 * It stops once the CLI has gone (`alive`); the caller's kill after the grace is only for a CLI that hangs.
 */

/** What the driver reads and does, the session's own (sessions.ts) or a test's. */
export interface ExitKeysIO {
  /** Its CLI still runs (this session's, not a restart's). */
  alive(): boolean
  /** A turn is under way, or its dialog asks something, as Hive's view of it says. */
  inTurn(): boolean
  /** Its screen shows the exit armed (the adapter's `armed`). */
  armed(): boolean
  /** Types the exit key, only into this session's CLI (the driver also asks `alive` just before). */
  press(): void
  /** Resolves after `ms` (a test's clock, or a timer). */
  wait(ms: number): Promise<void>
}

/** How often the driver looks again while it waits for a condition. */
export const EXIT_POLL_MS = 50

/** Types `io`'s exit key on conditions until its CLI has gone (above). `armMs`: how long the hint is waited for. */
export async function driveExitKeys(io: ExitKeysIO, armMs: number): Promise<void> {
  // Whether `cond` holds within `ms`, looking again every EXIT_POLL_MS; false once the CLI has gone.
  const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
    for (let waited = 0; io.alive(); waited += EXIT_POLL_MS) {
      if (cond()) return true
      if (waited >= ms) return false
      await io.wait(EXIT_POLL_MS)
    }
    return false
  }
  // Each key only while its CLI is still the one being stopped, checked at the key itself: every wait yields, and its
  // session can end and a restart take its terminal meanwhile (HR2 on HI-2272).
  const press = (): boolean => {
    if (!io.alive()) return false
    io.press()
    return true
  }
  while (io.alive()) {
    // The hint showing wins over Hive's view of a turn, which lags the CLI's: it is at its prompt, armed.
    if (io.inTurn() && !io.armed()) {
      if (!press()) return
      // Its end, however long the cancel takes; one that never ends is the kill's. The hint showing means it is over too.
      await until(() => !io.inTurn() || io.armed(), Infinity)
      continue
    }
    if (!io.armed()) {
      if (!press()) return
      if (!(await until(io.armed, armMs))) continue
    }
    if (!press()) return
    // Its exit (until returns once it has gone), or the hint gone with it still running: armed again from the top.
    await until(() => !io.armed(), Infinity)
  }
}
