import type { KeySteps } from './providers/types'

/** A pick step couldn't find what it looks for on the CLI's screen: `what` says what (the adapter's words). */
export class PickNotFound extends Error {
  constructor(readonly what: string) {
    super(`Couldn't find ${what}.`) // i18n-ignore: never shown: callers say what wasn't found in their own words (`what`, the CLI's menu item)
  }
}

/**
 * Typing stopped before its keys were done (#363): the CLI wasn't safe to type into, `why` says why (it stayed busy,
 * it is asking the user something, its session ended). Nothing more went in.
 */
export class KeysStopped extends Error {
  constructor(readonly why: string) {
    super(why)
  }
}

/** How many times a held submission is sent again (#363), after the first. */
export const RESENDS = 2

/**
 * Types key steps into a CLI's terminal (#396). A plain step's keys go in as they are. A pick step reads the CLI's
 * screen as rendered, every 100 ms until it finds what it needs or `pickTimeoutMs` passes, and types what it chose
 * (Codex's /permissions menu: the number its menu shows beside a preset's label, which a Codex version can reorder).
 * Throws PickNotFound when it never finds it, after the steps before it have gone in. A step with `shown` waits the
 * same way for the screen to show what its keys act on, then types them (HI-3437).
 *
 * `ready` says whether the CLI is safe to type into now, waiting while it may become so (a task waits while the CLI is
 * busy): true, or why not, which stops the typing (KeysStopped, fail closed). It is asked before every write, and
 * nothing is awaited between its answer and the write, so each key goes into a CLI that was safe just then (#363).
 *
 * A step with `heldOn` submits something (Enter after a command, #363): if the screen still holds it unrun once the CLI
 * is ready, has then had `heldSettleMs` to draw what it did, and is still ready, its keys go in again, at most RESENDS times. Only what
 * the screen shows counts: a submission the CLI took (it ran, or the CLI queued it to run when it is free) leaves the
 * input, so it is never sent twice, and one that doesn't show as held isn't sent again on a guess.
 */
export async function typeKeySteps(
  steps: KeySteps,
  io: { write: (keys: string) => void; screen: () => string | null; ready?: () => Promise<true | string>; pickTimeoutMs?: number; heldSettleMs?: number }
): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** Until the CLI is safe to type into; throws once it isn't. The caller writes straight after, awaiting nothing. */
  const safe = async (): Promise<void> => {
    const r = io.ready ? await io.ready() : true
    if (r !== true) throw new KeysStopped(r)
  }
  for (const step of steps) {
    let keys: string
    if ('pick' in step) {
      let found: string | null = null
      for (const t0 = Date.now(); ; await sleep(100)) {
        await safe()
        const screen = io.screen()
        found = screen === null ? null : step.pick(screen)
        if (found !== null) break
        if (Date.now() - t0 >= (io.pickTimeoutMs ?? 4000)) throw new PickNotFound(step.what)
      }
      keys = found
    } else if (step.shown) {
      // Held until the screen shows what the keys act on (HI-3437), read as a pick is, and safe just before the write.
      const shown = step.shown
      for (const t0 = Date.now(); ; await sleep(100)) {
        await safe()
        const screen = io.screen()
        if (screen !== null && shown(screen)) break
        if (Date.now() - t0 >= (io.pickTimeoutMs ?? 4000)) throw new PickNotFound(step.what)
      }
      keys = step.keys
    } else {
      await safe()
      keys = step.keys
    }
    io.write(keys)
    await sleep(step.waitMs ?? 60)
    if (!('heldOn' in step) || !step.heldOn) continue
    const heldOn = step.heldOn
    const held = (): boolean => {
      const screen = io.screen()
      return screen !== null && heldOn(screen)
    }
    for (let resent = 0; resent < RESENDS && held(); resent++) {
      // Free first, then time to draw what it did with what it took, then safe again just before the write.
      await safe()
      await sleep(io.heldSettleMs ?? 1000)
      await safe()
      if (!held()) break
      io.write(keys)
      await sleep(step.waitMs ?? 60)
    }
  }
}
