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
  /**
   * What the switch is for, settled at its safe point just before anything is typed (HI-2195: a usage move writes the
   * agent's connection here, under its lock): false, nothing is left to switch for, and it ends cancelled with nothing
   * typed. Called again at each try while nothing has been typed. Without it, the switch is always for something.
   */
  commit?: () => Promise<boolean>
  /** sessions.quit for the run: 'held' means nothing was typed (a draft, a prompt): asked again at the next change. */
  quit: () => Promise<'sent' | 'held' | 'gone'>
  /** Resumes its last session on its connection as chosen now; refused (its workspace closing, Hive quitting) it throws. */
  resume: () => Promise<void>
  /**
   * A resume refused only for now (HI-2304: its slot held by what a run left running there): why, in English; null for a
   * failure. The switch then waits, looking again at each change, until it resumes, fails, or WAIT_MS has passed.
   */
  waits?: (e: unknown) => string | null
  /** Told once for each reason the resume waits (the user's notice). */
  told?: (why: string) => void
  /** Calls look at each change that may matter (its status, its exit, a slot freed); returns the unsubscribe. */
  watch: (look: () => void) => () => void
  log: (line: string) => void
}

export type SwitchEnd = 'resumed' | 'cancelled' | 'gone' | 'failed'

/** A switch's resume refused for now (HI-2304): its slot, held, and what holds it, in English. */
export class SlotHeld extends Error {
  constructor(
    readonly slot: string,
    readonly why: string
  ) {
    super(why)
  }
}

export interface SwitchOp {
  /** Typed: its exit was sent, and it waits for that run's exit to resume. */
  readonly typed: boolean
  done: Promise<SwitchEnd>
  cancel: (why: string) => void
}

/** How long a switch's resume waits for its slot (HI-2304) before it gives up. */
export const SWITCH_WAIT_MS = 24 * 60 * 60_000

export function runSwitch(d: SwitchDeps, waitMs = SWITCH_WAIT_MS): SwitchOp {
  let over = false
  let waitingFor: string | null = null
  let waitTimer: ReturnType<typeof setTimeout> | null = null
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
    if (waitTimer) clearTimeout(waitTimer)
    d.log(why)
    resolve(e)
  }
  const step = async (): Promise<void> => {
    if (!typed) {
      if (!d.running()) return finish('gone', 'its run ended before it was switched') // i18n-ignore: for the log
      const held = d.heldNow()
      if (held) return
      if (d.commit && !(await d.commit())) return finish('cancelled', 'cancelled: nothing left to switch for') // i18n-ignore: for the log
      if (over) return
      const r = await d.quit()
      if (over) return
      if (r === 'gone') return finish('gone', 'its run ended before it was switched') // i18n-ignore: for the log
      // Held: nothing was typed; the next change looks again. Sent: typed once, never again.
      if (r === 'sent') typed = true
      else return
    }
    // Typed: resumed only once that run has exited. One step at a time (look), so it is never resumed twice.
    if (d.running()) return
    try {
      await d.resume()
    } catch (e) {
      const why = over ? null : (d.waits?.(e) ?? null)
      if (why === null) return finish('failed', `not resumed: ${(e as Error).message ?? e}`) // i18n-ignore: for the log
      // Its slot held (HI-2304): it waits for what frees it, each change looking again; said once for each reason.
      if (why !== waitingFor) {
        // The user is told once; a change of what holds it (fewer processes) only logged.
        if (waitingFor === null) d.told?.(why)
        waitingFor = why
        d.log(`waits to resume: ${why}`)
      }
      if (!waitTimer) {
        waitTimer = setTimeout(() => finish('failed', `not resumed: it waited ${Math.round(waitMs / 3_600_000)} h for its slot (${waitingFor})`), waitMs) // i18n-ignore: for the log
        waitTimer.unref?.()
      }
      return
    }
    finish('resumed', 'resumed on its connection') // i18n-ignore: for the log
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
        // Once more for each change that came while it looked (finish ends it: over).
        for (;;) {
          again = false
          await step()
          if (!again || over) break
        }
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

/**
 * A usage move waiting for an agent's safe point (HI-2195, usageMoves.ts): `commit` checks it still holds and writes the
 * agent's connection, under its lock (false: dropped, nothing written); `ended` says how its switch ended.
 */
export interface UsageIntent {
  commit: () => Promise<boolean>
  ended: (e: SwitchEnd) => void
}

/**
 * What one waiting switch is for (HI-2195): `base`, HI-1755's own (a manual or fallback switch), and/or a usage move,
 * committed at the safe point (its commit is SwitchDeps.commit). A usage move rejected or dropped leaves a base switch to
 * go on; one alone ends it, nothing typed.
 */
export class SwitchIntents {
  base: boolean
  usage?: UsageIntent
  committed = false
  constructor(usage?: UsageIntent) {
    this.base = !usage
    this.usage = usage
  }
  /** Another reason for the waiting switch (one quit for both): false for a second usage move, or one after a commit. */
  join(usage?: UsageIntent): boolean {
    if (!usage) {
      this.base = true
      return true
    }
    if (this.usage || this.committed) return false
    this.usage = usage
    return true
  }
  /** At the safe point: a usage move's write, once; whether anything is left to switch for. */
  async commit(): Promise<boolean> {
    const u = this.usage
    if (u && !this.committed) {
      if (await u.commit().catch(() => false)) this.committed = true
      else if (this.usage === u) this.usage = undefined
    }
    return this.base || this.committed
  }
  /** Drops a usage move not yet committed: 'cancel' when nothing is left (the switch is cancelled), 'kept' when a base switch goes on. */
  drop(): 'cancel' | 'kept' | null {
    if (!this.usage || this.committed) return null
    const u = this.usage
    this.usage = undefined
    if (this.base) {
      u.ended('cancelled')
      return 'kept'
    }
    return 'cancel'
  }
  get usagePending(): boolean {
    return !!this.usage && !this.committed
  }
}
