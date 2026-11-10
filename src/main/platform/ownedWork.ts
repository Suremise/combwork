// Work a platform runs for an owner (a project folder) that must end when its owner goes: a workspace closing, a project
// removed, Combwork quitting (HI-1185: the Git view's signing checks). Platform-neutral, so the app ends it without
// importing any platform's module (R9's guard): each platform registers what to end, and endOwnedWork ends it all,
// resolving once every piece has ended and cleaned up. Quitting (endAllOwnedWork, awaited in the quit sequence before the
// app exits) also stops any new work from being admitted; will-quit's endOwnedWorkNow is the synchronous fallback for a
// shutdown that can't wait.

type EndFor = (owner: (root: string) => boolean) => Promise<void>

const enders = new Set<EndFor>()
const nowEnders = new Set<() => void>()
let stopped = false

/** A platform's work to end for an owner, and its synchronous fallback for a shutdown that can't wait (at its module's load). */
export function onOwnerGone(end: EndFor, now?: () => void): void {
  enders.add(end)
  if (now) nowEnders.add(now)
}

/** Whether Combwork is quitting: no new owned work is admitted. */
export const ownedWorkStopped = (): boolean => stopped

/** Ends every platform's work for the owners `owner` accepts, and waits until it has ended. */
export async function endOwnedWork(owner: (root: string) => boolean): Promise<void> {
  await Promise.all([...enders].map((end) => end(owner).catch(() => undefined)))
}

/** Quitting: nothing new admitted from here on, and everything running ended and waited for. */
export async function endAllOwnedWork(): Promise<void> {
  stopped = true
  await endOwnedWork(() => true)
}

/** will-quit's fallback, synchronous: nothing new admitted, and what still runs ended at once (best effort). */
export function endOwnedWorkNow(): void {
  stopped = true
  for (const now of nowEnders) {
    try {
      now()
    } catch {
      // best effort, as the process exits
    }
  }
}

/** For tests only: admits work again after a test's quit. */
export function resetOwnedWorkForTests(): void {
  stopped = false
}
