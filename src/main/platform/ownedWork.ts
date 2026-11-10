// Work a platform runs for an owner (a project folder) that must end when its owner goes: a workspace closing, a project
// removed, Combwork quitting (HI-1185: the Git view's signing checks). Platform-neutral, so the app ends it without
// importing any platform's module (R9's guard): each platform registers what to end, and endOwnedWork ends it all,
// resolving once every piece has ended and cleaned up.

type EndFor = (owner: (root: string) => boolean) => Promise<void>

const enders = new Set<EndFor>()

/** A platform's work to end for an owner (called at its module's load). */
export function onOwnerGone(end: EndFor): void {
  enders.add(end)
}

/** Ends every platform's work for the owners `owner` accepts, and waits until it has ended. */
export async function endOwnedWork(owner: (root: string) => boolean): Promise<void> {
  await Promise.all([...enders].map((end) => end(owner).catch(() => undefined)))
}
