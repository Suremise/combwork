// What Hive says about unused worktrees (#353): shared by the window and its tests. Window text, in the language Hive
// shows (main's for lostLines, which main words for the removal's confirmation); reuseNote is also the Agent API's, so
// it words its text in English unless given the window's tr().
import type { UnusedWorktree, WorktreeReuse } from './types'
import { tr } from './i18n'
import { msg } from './i18n/msg'

/** The window's tr(), passed to what the Agent API words too (#798's pattern, shared/tasks.ts). */
type Tr = typeof tr

const M = {
  merged: msg({ id: 'workspace.unused.merged', defaultMessage: 'Merged into {into} · clean', description: "An unused worktree's state: its branch is merged into {into} (main) and it has no changes." }),
  commitsNotOn: msg({ id: 'workspace.unused.commitsNotOn', defaultMessage: '{count, plural, one {# commit} other {# commits}} not on {known, select, yes {{into}} other {the main branch}}', description: "An unused worktree's state: commits on its branch that {into} (main) doesn't have." }),
  commitsNoBranch: msg({ id: 'workspace.unused.commitsNoBranch', defaultMessage: '{count, plural, one {# commit} other {# commits}} on no branch', description: "An unused worktree's state: commits only its detached HEAD has." }),
  changedFiles: msg({ id: 'workspace.unused.changedFiles', defaultMessage: '{count, plural, one {# changed file} other {# changed files}}', description: "An unused worktree's state: files changed and not committed." }),
  notChecked: msg({ id: 'workspace.unused.notChecked', defaultMessage: "Hive couldn't check it", description: "An unused worktree's state when git couldn't say." }),
  notMadeByHive: msg({ id: 'workspace.unused.notMadeByHive', defaultMessage: 'not made by Hive', description: 'Who made an unused worktree: something other than Hive (an agent\'s own git worktree add). Lower case: it follows its branch.' }),
  was: msg({ id: 'workspace.unused.was', defaultMessage: 'was {agent}', description: "Who made an unused worktree: the Hive agent that worked in it ({agent}: its name). Lower case: it follows its branch." }),
  madeByHive: msg({ id: 'workspace.unused.madeByHive', defaultMessage: 'made by Hive', description: 'Who made an unused worktree: Hive, for an agent no longer known. Lower case: it follows its branch.' }),
  detached: msg({ id: 'workspace.unused.detached', defaultMessage: '(detached)', description: "An unused worktree with no branch (a detached HEAD), in the Changes tab's picker." }),
  pickMerged: msg({ id: 'workspace.unused.pickMerged', defaultMessage: 'merged, clean', description: "An unused worktree in the Changes tab's picker: merged and with no changes. Lower case." }),
  pickWork: msg({ id: 'workspace.unused.pickWork', defaultMessage: 'holds work', description: "An unused worktree in the Changes tab's picker: it holds work that is nowhere else. Lower case." }),
  pickNotChecked: msg({ id: 'workspace.unused.pickNotChecked', defaultMessage: 'not checked', description: "An unused worktree in the Changes tab's picker: git couldn't check it. Lower case." }),
  aboutUnused: msg({ id: 'workspace.changes.aboutUnusedShort', defaultMessage: 'Worktrees no agent of {project} works in: open one to see its changes and merge them, or give it to an agent.', description: "The Changes tab's Unused worktrees page, at the top, in one sentence (#1314; its ⓘ says where they come from and what Remove does)." }),
  aboutUnusedTip: msg({ id: 'workspace.changes.aboutUnusedTip', defaultMessage: "Kept when their agent was removed, made outside Hive (by an agent's own git worktree add, say), or from another template (loading that template gives them back to its agents).{known, select, yes { Those merged into {into} and clean can go with their branches; the others hold work that is nowhere else.} other {}}", description: "The ⓘ beside Unused worktrees' heading: where they come from and which can be removed. Keep git worktree add as it is; {into} is the main branch." }),
  aboutUnusedOne: msg({ id: 'workspace.changes.aboutUnusedOne', defaultMessage: "An unused worktree: everything on {branch} that isn't on {into}. Merge it, or go back to Unused worktrees to give it to an agent or remove it.", description: "The Changes tab, over an unused worktree's changes. Unused worktrees is the page's name." }),
  aboutAgent: msg({ id: 'workspace.changes.aboutAgent', defaultMessage: "{agent}'s worktree: everything on {branch} since it left {base}. Merge… brings it into {base}.", description: "The Changes tab, over an agent's worktree's changes. Merge… is the button." }),
  aboutProject: msg({ id: 'workspace.changes.aboutProject', defaultMessage: "The project folder: what isn't committed yet, from you or the agents working in the folder itself (those without a worktree).", description: "The Changes tab, over the project folder's changes." }),
  lostCommits: msg({ id: 'workspace.unused.lostCommits', defaultMessage: '{count, plural, one {# commit} other {# commits}} on {branch} not on {known, select, yes {{into}} other {any other branch}}', description: "What removing an unused worktree anyway loses: a line of the confirmation's list." }),
  lostDetached: msg({ id: 'workspace.unused.lostDetached', defaultMessage: '{count, plural, one {# commit on no branch (only its detached HEAD has it)} other {# commits on no branch (only its detached HEAD has them)}}', description: "What removing an unused worktree anyway loses: a line of the confirmation's list." }),
  lostFiles: msg({ id: 'workspace.unused.lostFiles', defaultMessage: '{count, plural, one {# uncommitted file} other {# uncommitted files}} in {path}', description: "What removing an unused worktree anyway loses: a line of the confirmation's list ({path}: its folder)." }),
  lostIgnored: msg({ id: 'workspace.unused.lostIgnored', defaultMessage: 'the files git ignores in its folder (build output, copied .env files)', description: "What removing an unused worktree anyway loses: the last line of the confirmation's list. Lower case." }),
  newTree: msg({ id: 'workspace.reuse.newTree', defaultMessage: "made a new worktree, leaving {branch}'s unused one as it is ({why})", description: 'After adding an agent: it got a new worktree rather than the unused one of its branch; {why} says why. Lower case: it follows the agent.' }),
  notCheckedWhy: msg({ id: 'workspace.reuse.notChecked', defaultMessage: 'not checked', description: "Why an unused worktree wasn't reused, when it couldn't be checked. Lower case." }),
  keptWork: msg({ id: 'workspace.reuse.keptWork', defaultMessage: 'reused {branch} as it is (it keeps its work)', description: 'After adding an agent: it works in an unused worktree again, with its work. Lower case: it follows the agent.' }),
  upTo: msg({ id: 'workspace.reuse.upTo', defaultMessage: 'reused {branch}, brought up to {base} at {commit}', description: 'After adding an agent: it works in an unused worktree again, brought up to {base} (main) at commit {commit}. Lower case: it follows the agent.' }),
  alreadyAt: msg({ id: 'workspace.reuse.alreadyAt', defaultMessage: 'reused {branch}, already at {base}', description: 'After adding an agent: it works in an unused worktree again, already up to {base} (main). Lower case: it follows the agent.' }),
  summary: msg({ id: 'workspace.unused.summary', defaultMessage: '{count, plural, one {# unused worktree} other {# unused worktrees}} ({merged, number} merged)', description: "The Overview's line on a project's unused worktrees." }),
  workNotice: msg({ id: 'workspace.unused.workNotice', defaultMessage: "{count, plural, one {# unused worktree has} other {# unused worktrees have}} work that isn't on {known, select, yes {{into}} other {the main branch}}", description: "The Changes tab's notice on unused worktrees holding work." }),
}

/** The user guide's heading on kept worktrees. */
export const UNUSED_WORKTREES_GUIDE = 'Unused worktrees' // i18n-ignore: a heading of the user guide (English until the guide is translated, D2)

/** Whether it holds work that is nowhere else: commits not on the main branch, or uncommitted files. */
export const holdsWork = (w: UnusedWorktree): boolean => !w.check.removable && ((w.check.ahead ?? 0) > 0 || (w.check.dirty ?? 0) > 0)

/** Its state in a few words: "Merged into main · clean", "3 commits not on main · 2 changed files", or why git couldn't say. */
export function unusedState(w: UnusedWorktree): string {
  const c = w.check
  if (c.removable) return tr(M.merged, { into: c.into ?? '' })
  const parts = [(c.ahead ?? 0) > 0 ? (w.branch ? tr(M.commitsNotOn, { count: c.ahead!, known: c.into ? 'yes' : 'no', into: c.into ?? '' }) : tr(M.commitsNoBranch, { count: c.ahead! })) : '', (c.dirty ?? 0) > 0 ? tr(M.changedFiles, { count: c.dirty! }) : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : (c.reason ?? tr(M.notChecked))
}

/** Who made it, in a few words (#476): "was B4" (the Hive agent that worked there), "made by Hive", "not made by Hive". */
export function originLabel(w: Pick<UnusedWorktree, 'origin'>): string {
  const o = w.origin
  if (!o) return ''
  if (o.madeBy === 'other') return tr(M.notMadeByHive)
  return o.agentName ? tr(M.was, { agent: o.agentName }) : tr(M.madeByHive)
}

/** One unused worktree in the Changes tab's picker (#476): "hive/b4 · was B4 · holds work". */
export function unusedPickerLabel(w: UnusedWorktree): string {
  return [w.branch ?? tr(M.detached), originLabel(w), tr(w.check.removable ? M.pickMerged : holdsWork(w) ? M.pickWork : M.pickNotChecked)].filter(Boolean).join(' · ')
}

/** What each page of the Changes tab shows, in one sentence at the top of the page's right side (#476). */
export const CHANGES_ABOUT = {
  unused: (project: string): string => tr(M.aboutUnused, { project }),
  /** Where unused worktrees come from and which can go (#1314: the ⓘ beside the heading, the page saying one sentence). */
  unusedTip: (into: string | null): string => tr(M.aboutUnusedTip, { known: into ? 'yes' : 'no', into: into ?? '' }),
  unusedOne: (branch: string, into: string): string => tr(M.aboutUnusedOne, { branch, into }),
  agent: (name: string, branch: string, base: string): string => tr(M.aboutAgent, { agent: name, branch, base }),
  get project(): string {
    return tr(M.aboutProject)
  }
}

/** What removing a worktree anyway loses, one line each, as its danger confirm lists them (#353). */
export function lostLines(w: { path: string; branch: string | null; into: string | null; ahead: number; dirty: number }): string[] {
  return [
    ...(w.ahead ? [w.branch ? tr(M.lostCommits, { count: w.ahead, branch: w.branch, known: w.into ? 'yes' : 'no', into: w.into ?? '' }) : tr(M.lostDetached, { count: w.ahead })] : []),
    ...(w.dirty ? [tr(M.lostFiles, { count: w.dirty, path: w.path })] : []),
    tr(M.lostIgnored)
  ]
}

/**
 * What Remove anyway loses, as the list shows it; null when git couldn't count it (then there is no Remove anyway: what
 * would go can't be named). The confirmation itself shows what a fresh check finds (`worktrees:removalPreview`).
 */
export function lostByRemoving(w: UnusedWorktree): string[] | null {
  const c = w.check
  if (c.dirty === undefined || c.ahead === undefined) return null
  return lostLines({ path: w.path, branch: w.branch, into: c.into, ahead: c.ahead, dirty: c.dirty })
}

/**
 * What adding an agent did about an unused worktree it could reuse (#456), as the dialog's notice and the Agent API's
 * reply say it: "reused hive/b4, brought up to main at 66ce11b", or why it made a new one. In English (the Agent API's,
 * and the log's) unless given the window's tr().
 */
export function reuseNote(r: WorktreeReuse, t?: Tr): string {
  if (!r.reused) {
    if (t) return t(M.newTree, { branch: r.branch, why: r.notReused ?? t(M.notCheckedWhy) })
    return `made a new worktree, leaving ${r.branch}'s unused one as it is (${r.notReused ?? 'not checked'})` // i18n-ignore: the Agent API's reply and the log (English)
  }
  if (r.keptWork) return t ? t(M.keptWork, { branch: r.branch }) : `reused ${r.branch} as it is (it keeps its work)` // i18n-ignore: the Agent API's reply and the log (English)
  if (r.upTo) return t ? t(M.upTo, { branch: r.branch, base: r.base, commit: r.upTo.slice(0, 7) }) : `reused ${r.branch}, brought up to ${r.base} at ${r.upTo.slice(0, 7)}` // i18n-ignore: the Agent API's reply and the log (English)
  return t ? t(M.alreadyAt, { branch: r.branch, base: r.base }) : `reused ${r.branch}, already at ${r.base}` // i18n-ignore: the Agent API's reply and the log (English)
}

/**
 * Files whose change means a reused worktree runs the project's worktree setup again (#456): the lockfiles of the usual
 * package managers. A worktree brought up to the base without one of them changing doesn't (its node_modules is there).
 */
const SETUP_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|packages\.lock\.json)$/i

/** Whether any of these changed files (git's paths) is a lockfile, so a reused worktree's setup runs again (#456). */
export const lockfileChanged = (files: readonly string[]): boolean => files.some((f) => SETUP_FILES.test(f.trim()))

/** The Overview's line (#400): "7 unused worktrees (7 merged)", or null with none. */
export function unusedSummary(list: UnusedWorktree[]): string | null {
  if (!list.length) return null
  const merged = list.filter((w) => w.check.removable).length
  return tr(M.summary, { count: list.length, merged })
}

/** The Changes tab's notice (#353), or null: only for unused worktrees holding work. */
export function unusedWorkNotice(list: UnusedWorktree[]): string | null {
  const n = list.filter(holdsWork).length
  if (!n) return null
  const into = list.find(holdsWork)?.check.into
  return tr(M.workNotice, { count: n, known: into ? 'yes' : 'no', into: into ?? '' })
}

