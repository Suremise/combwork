// HI-3465: a git operation left under way in a slot (a merge, rebase, am, cherry-pick, revert or bisect, as git names it:
// gitCommands.ts operationSync) and the command that ends it, said beside it in Slots and copies and in the notice
// Combwork gives once. Combwork never runs it itself: ending an operation is the agent's or the user's choice.

/**
 * The command that ends an operation in its folder, putting the folder back as it was before it began (a bisect: back
 * where it started); null for one git has no such command for here. Commands, never translated.
 */
export function gitOperationEnd(what: string): string | null {
  switch (what) {
    case 'merge':
    case 'rebase':
    case 'am':
    case 'cherry-pick':
    case 'revert':
      return `git ${what} --abort` // i18n-ignore: a git command
    case 'bisect':
      return 'git bisect reset' // i18n-ignore: a git command
    default:
      return null
  }
}

/** HI-3467: a slot's operation record (and SlotView's `operation`) for a detach at its target that failed, not a git operation. */
export const DETACH_FAILED = 'detach'

/**
 * HI-3467: a branch name as one literal argument where the user pastes it (PowerShell, Windows' shell; HR1's round 1):
 * as it is when it holds only letters, digits and `._/-`, else single-quoted, a quote inside doubled (PowerShell takes
 * the typographic quotes as quotes too). Git allows `$`, `&`, `;`, quotes… in branch names, which a shell would read.
 */
export function shellArg(name: string): string {
  return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(name) ? name : `'${name.replace(/['‘’‚‛]/g, (q) => q + q)}'`
}

/**
 * HI-3467: the command that puts a slot's folder at its target branch's head, as Combwork's own detach does (the way out
 * Combwork names when that keeps failing), its branch one literal argument (`shellArg`). A command, never translated.
 */
export const gitDetachCommand = (target: string): string => `git switch --detach ${shellArg(target)}` // i18n-ignore: a git command
