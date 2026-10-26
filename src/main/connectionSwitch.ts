/**
 * A switch to another connection at an agent's next safe point (HI-1755): once its turn is over, its CLI is ended with
 * its own exit (HI-1706's quit, never mid-turn), and once that exact run has exited, its last session is resumed, once,
 * on the connection it would launch on then. One per agent: asking again while one waits changes nothing (the resume
 * reads the choice as it is then). A manual stop or start, its workspace closing or Hive quitting cancels it; it is never
 * kept across a restart (not the install-restart's record).
 *
 * The steps are given (SwitchDeps), so unit tests drive each boundary: Hive's are in sessions.ts.
 */

export interface SwitchDeps {
  /** Whether the run being switched is still the agent's, running. */
  running: () => boolean
  /** Why its turn isn't over yet (in a turn, its turn open, its runs going, a line waiting), or null. */
  heldNow: () => string | null
  /** sessions.quit for the run: 'held' means nothing was typed (a draft, a prompt): asked again at the next change. */
  quit: () => Promise<'sent' | 'held' | 'gone'>
  /** Resumes its last session on its connection as chosen now; refused (its workspace closing, Hive quitting) it throws. */
  resume: () => Promise<void>
  /** Calls look at each change that may matter (its status, its exit); returns the unsubscribe. */
  watch: (look: () => void) => () => void
  log: (line: string) => void
}

export type SwitchEnd = 'resumed' | 'cancelled' | 'gone' | 'failed'

export interface SwitchOp {
  /** Typed: its exit was sent, and it waits for that run's exit to resume. */
  readonly typed: boolean
  done: Promise<SwitchEnd>
  cancel: (why: string) => void
}

export function runSwitch(d: SwitchDeps): SwitchOp {
  let over = false
  let typed = false
  let looking = false
  let again = false
  let resolve!: (e: SwitchEnd) => void
  const done = new Promise<SwitchEnd>((r) => (resolve = r))
  let unwatch: (() => void) | null = null
  const finish = (e: SwitchEnd, why: string): void => {
    if (over) return
    over = true
    unwatch?.()
    d.log(why)
    resolve(e)
  }
  const step = async (): Promise<void> => {
    if (!typed) {
      if (!d.running()) return finish('gone', 'its run ended before it was switched')
      const held = d.heldNow()
      if (held) return
      const r = await d.quit()
      if (over) return
      if (r === 'gone') return finish('gone', 'its run ended before it was switched')
      // Held: nothing was typed; the next change looks again. Sent: typed once, never again.
      if (r === 'sent') typed = true
      else return
    }
    // Typed: resumed only once that run has exited.
    if (d.running()) return
    over = true
    unwatch?.()
    try {
      await d.resume()
      d.log('resumed on its connection')
      resolve('resumed')
    } catch (e) {
      d.log(`not resumed: ${(e as Error).message ?? e}`)
      resolve('failed')
    }
  }
  const look = (): void => {
    if (over) return
    if (looking) {
      again = true
      return
    }
    looking = true
    void (async () => {
      try {
        do {
          again = false
          await step()
        } while (again && !over)
      } finally {
        looking = false
      }
    })()
  }
  unwatch = d.watch(look)
  look()
  return {
    get typed() {
      return typed
    },
    done,
    cancel: (why) => finish('cancelled', `cancelled: ${why}`)
  }
}
