// HI-3465: a git operation left under way in a slot (a merge, rebase, am, cherry-pick, revert or bisect, as git names it:
// gitCommands.ts operationSync) and the command that ends it, said beside it in Slots and copies and in the notice
// Combwork gives once. Combwork never runs it by itself: ending an operation is the agent's or the user's choice
// (HI-3470: the user's, from Changes' panel, a click at a time).

/** HI-3470: the operations git can have under way in a folder, as git names them (gitCommands.ts GitOperation). */
export type GitOperationName = 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'

/** HI-3470: what the panel can do to the operation: carry on, drop the commit it stopped at, or end it (a bisect: reset). */
export type OperationStep = 'continue' | 'skip' | 'abort'

/** HI-3470: a conflicted file settled: its side from the folder's own work (`mine`), the other side's, or as it is now. */
export type ConflictPick = 'mine' | 'theirs' | 'resolved'

/** HI-3470: the steps each operation offers, in the panel's order (a bisect only ends: good and bad stay the user's terminal's). */
export const OPERATION_STEPS: Record<GitOperationName, readonly OperationStep[]> = {
  merge: ['continue', 'abort'],
  rebase: ['continue', 'skip', 'abort'],
  am: ['continue', 'skip', 'abort'],
  'cherry-pick': ['continue', 'skip', 'abort'],
  revert: ['continue', 'skip', 'abort'],
  bisect: ['abort']
}

export const isOperationName = (v: unknown): v is GitOperationName => typeof v === 'string' && Object.hasOwn(OPERATION_STEPS, v)

/**
 * HI-3518: what Changes' panel shows: a git operation under way, or `conflicts`: files left unmerged with none under way
 * (a stash's Apply or Pop that conflicted, HI-3472, or a terminal's): their files only, no step.
 */
export type PanelKind = GitOperationName | 'conflicts'

export const isPanelKind = (v: unknown): v is PanelKind => v === 'conflicts' || isOperationName(v)

/**
 * HI-3470: in a rebase, git's `--ours` is the line being replayed onto and `--theirs` the commit being replayed: the
 * folder's own work. Mine is that commit there, git's ours everywhere else (an am's too: its patch is the other side,
 * applied onto the folder's branch).
 */
export const mineIsTheirs = (what: PanelKind): boolean => what === 'rebase'

/** HI-3470: a file git lists as unmerged, and whether each side has it (a side that deleted it hasn't). */
export interface GitConflict {
  path: string
  mine: boolean
  theirs: boolean
  /**
   * HI-3502: a submodule (a gitlink, mode 160000) on a side: that side's commit, by the panel's mine and theirs. Git's
   * `checkout --ours/--theirs` never moves a submodule, so a pick of that side stages its commit instead (pickArgs).
   */
  submodule?: { mine?: string; theirs?: string }
  /**
   * HI-3518 (HR1's round 1): the conflict's fingerprint, its unmerged entries (modes, objects, stages) hashed: a pick
   * names the one the user saw (`seen`), and another conflict of the same file in its place is refused. Opaque.
   */
  stages?: string
}

/** HI-3470: the operation under way in a folder, as Changes' panel shows it (HI-3518: or files left in conflict). */
export interface GitOperationState {
  what: PanelKind
  /**
   * HR1's round 1: which stop of it this is (its kind, HEAD, the commit it stopped at, its step): a request names the one
   * the user saw, and one made when git is at another stop (a terminal went on, or another of the same kind began) is
   * refused, even of the same kind. Opaque to the window. Null (HR1's round 2): git's files that say where it is can't be
   * read, so the panel takes no step.
   */
  id: string | null
  /** The commit git stopped at (a merge's: the one merged), short, with its subject; absent when git doesn't say. */
  at?: { commit: string; subject: string }
  /** A rebase's or am's place in its list: the step it stopped at, of how many. */
  step?: { at: number; of: number }
  conflicts: GitConflict[]
  /** HI-3518: where files left in conflict came from, when Combwork knows: the stash applied (its message). */
  from?: { stash: string }
}

/** HI-3470: the folder's slot, when it is lent to a card or lane: the panel asks the user to confirm first, naming it. */
export interface OperationLent {
  slot: string
  lease: string
  agent: string
  card: string | null
  lane: string | null
}

/** HI-3470: `git:operation`'s answer: the operation under way, and the slot's lease it would act under. */
export interface OperationPanelState extends GitOperationState {
  lent: OperationLent | null
}

/**
 * HI-3470: what the panel asks main to do (`git:operationStep`): a step, or a conflicted file settled; `what` and `id` are
 * the operation and the stop of it the user saw (anything else under way now refuses it, HR1's round 1), `lease` the lent
 * slot's lease they confirmed.
 */
export type OperationRequest = { what: PanelKind; id: string; lease?: string } & ({ step: OperationStep } | { file: string; pick: ConflictPick; seen?: string })

/**
 * HI-3503: what a step did: git's output, and `stoppedAgain` when a Continue or Skip went on and git stopped at another
 * stop of the same operation (a rebase's next commit in conflict): git exits non-zero then, though the step went through.
 */
export interface OperationStepResult {
  output: string
  stoppedAgain?: true
}

/** HI-3470: the git command a step runs, shown in its tooltip as the panel runs it. Commands, never translated. */
export function operationCommand(what: GitOperationName, step: OperationStep): string {
  if (what === 'bisect') return 'git bisect reset' // i18n-ignore: a git command
  return `git ${what} --${step}` // i18n-ignore: a git command
}

/**
 * HI-3501: a conflicted file's path as a pathspec in a command shown to paste, so it touches that file alone: a literal
 * pathspec (`:(literal)a[1].txt`) where git would read it as a glob (`*`, `?`, `[`, `]`, `\`) or as magic (a leading
 * `:`), quoted as shellWord says; null where no quoting reads the same in both shells.
 */
export function pathArg(path: string): string | null {
  return shellWord(literalSpec(path))
}

/** A path as a pathspec that names it alone (pathArg), before quoting. */
const literalSpec = (path: string): string => (/[*?[\]\\]/.test(path) || path.startsWith(':') ? `:(literal)${path}` : path)

/**
 * HI-3502 (HR2's round 1): a word as both PowerShell and Git Bash take it, one argument as it is, so a shown command
 * pastes into either: plain as it is; else in single quotes, where neither expands anything (nor ends a command at `;`
 * or splits at a space); else, holding an apostrophe, in double quotes when it has nothing either shell expands there
 * (`$`, a backtick, `\`, `!`, `"`). PowerShell also takes the typographic quotes as quotes. Null when none fits.
 */
export function shellWord(w: string): string | null {
  if (/^[\w./@+=,-]+$/.test(w)) return w
  if (!/['‘’‚‛]/.test(w)) return `'${w}'`
  if (!/["$`\\!“”„]/.test(w)) return `"${w}"`
  return null
}

/**
 * A word for a tooltip's command: shellWord's, read alike by PowerShell and Git Bash. Else (HI-3513: an apostrophe with
 * something both shells expand, where no quoting suits both, probed) quoted for PowerShell, Windows' own shell: in single
 * quotes, each quote character doubled (PowerShell takes the typographic ones as quotes too).
 */
const tipWord = (w: string | null, raw: string): string => w ?? `'${raw.replace(/['‘’‚‛]/g, '$&$&')}'`

/**
 * HI-3502: the command that checks a submodule's staged commit out in its folder, as the notice after a pick shows it
 * (the path literal: HI-3501); null where no quoting reads the same in both shells. A command, never translated.
 */
export function submoduleUpdateCommand(path: string): string | null {
  const p = pathArg(path)
  return p === null ? null : `git submodule update -- ${p}` // i18n-ignore: a git command
}

/**
 * HI-3470: a pick's git command, for its tooltip (a side without the file: git rm). Commands, never translated. The path
 * is literal (pathArg), as the panel runs it (HI-3501: main's pickArgs, `--literal-pathspecs`).
 */
export function pickCommand(what: PanelKind, c: GitConflict, pick: ConflictPick): string {
  const p = tipWord(pathArg(c.path), literalSpec(c.path))
  if (pick === 'resolved') return `git add -A -- ${p}` // i18n-ignore: a git command
  const has = pick === 'mine' ? c.mine : c.theirs
  if (!has) return `git rm -- ${p}` // i18n-ignore: a git command
  // A submodule's side: its commit staged (HI-3502); update-index takes a path, never a pathspec.
  const link = c.submodule?.[pick]
  if (link) return `git update-index --cacheinfo 160000 ${link} ${tipWord(shellWord(c.path), c.path)}` // i18n-ignore: a git command
  const ours = (pick === 'mine') !== mineIsTheirs(what)
  return `git checkout --${ours ? 'ours' : 'theirs'} -- ${p}; git add -- ${p}` // i18n-ignore: git commands
}

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
 * HI-3467: a branch name as one literal argument where the user pastes it (PowerShell, Windows' shell; HR1's round 1;
 * HI-3516: the texts that show it say PowerShell, since cmd doesn't take single quotes and would read `&` in one):
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
