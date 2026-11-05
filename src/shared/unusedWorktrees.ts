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
  notChecked: msg({ id: 'workspace.unused.notChecked', defaultMessage: "Combwork couldn't check it", description: "An unused worktree's state when git couldn't say." }),
  notMadeByCombwork: msg({ id: 'workspace.unused.notMadeByCombwork', defaultMessage: 'not made by Combwork', description: 'Who made an unused worktree: something other than Combwork (an agent\'s own git worktree add). Lower case: it follows its branch.' }),
  was: msg({ id: 'workspace.unused.was', defaultMessage: 'was {agent}', description: "Who made an unused worktree: the Combwork agent that worked in it ({agent}: its name). Lower case: it follows its branch." }),
  madeByCombwork: msg({ id: 'workspace.unused.madeByCombwork', defaultMessage: 'made by Combwork', description: 'Who made an unused worktree: Combwork, for an agent no longer known. Lower case: it follows its branch.' }),
  detached: msg({ id: 'workspace.unused.detached', defaultMessage: '(detached)', description: "An unused worktree with no branch (a detached HEAD), in the Changes tab's picker." }),
  pickMerged: msg({ id: 'workspace.unused.pickMerged', defaultMessage: 'merged, clean', description: "An unused worktree in the Changes tab's picker: merged and with no changes. Lower case." }),
  pickWork: msg({ id: 'workspace.unused.pickWork', defaultMessage: 'holds work', description: "An unused worktree in the Changes tab's picker: it holds work that is nowhere else. Lower case." }),
  pickNotChecked: msg({ id: 'workspace.unused.pickNotChecked', defaultMessage: 'not checked', description: "An unused worktree in the Changes tab's picker: git couldn't check it. Lower case." }),
  aboutUnused: msg({ id: 'workspace.changes.aboutUnusedShort', defaultMessage: 'Worktrees no agent of {project} works in: open one to see its changes and merge them, or remove it.', description: "The Changes tab's Unused worktrees page, at the top, in one sentence (#1314; its ⓘ says where they come from and what Remove does)." }),
  aboutUnusedTip: msg({ id: 'workspace.changes.aboutUnusedTip', defaultMessage: "Kept when their agent was removed (by hand, or when a template's agents replaced it), or made outside Combwork (by an agent's own git worktree add, say). Loading a template gives none of them to its agents.{known, select, yes { Those merged into {into} and clean can go with their branches; the others hold work that is nowhere else.} other {}}", description: "The ⓘ beside Unused worktrees' heading: where they come from and which can be removed. Keep git worktree add as it is; {into} is the main branch." }),
  aboutUnusedOne: msg({ id: 'workspace.changes.aboutUnusedOne', defaultMessage: "An unused worktree: everything on {branch} that isn't on {into}. Merge it, or go back to Unused worktrees to remove it.", description: "The Changes tab, over an unused worktree's changes. Unused worktrees is the page's name." }),
  aboutAgent: msg({ id: 'workspace.changes.aboutAgent', defaultMessage: "{agent}'s worktree: everything on {branch} since it left {base}. Merge… brings it into {base}.", description: "The Changes tab, over an agent's worktree's changes. Merge… is the button." }),
  aboutSlot: msg({ id: 'workspace.changes.aboutSlot', defaultMessage: '{is, select, carried {{agent} works in {name}, the slot kept for it} other {{agent} builds in {name}}}: {known, select, yes {everything on its branch since it left {base}.} other {what isn\'t committed there yet.}}', description: "The Changes tab, over the changes in the slot an agent works in (#1569): a slot it builds a card in, or the slot kept for it (its own worktree from before 1.0); {name} is the slot's name, such as slot-b; {base} the branch its work started from. Glossary: slot." }),
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
  kindSlot: msg({ id: 'workspace.unused.kind.slot', defaultMessage: 'free slot beyond the pool', description: "What an unused worktree is (#1450): one of Combwork's slots, free and set up, beyond the number the project needs now. Lower case: a badge after its name." }),
  kindDirtySlot: msg({ id: 'workspace.unused.kind.dirtySlot', defaultMessage: 'slot with changes, not lent', description: "What an unused worktree is (#1450): one of Combwork's slots, left with uncommitted or untracked files and lent to no card. Lower case: a badge after its name." }),
  kindCarried: msg({ id: 'workspace.unused.kind.carried', defaultMessage: "agent's old worktree, given up", description: "What an unused worktree is (#1450): an agent's 0.9 worktree Combwork carried into the slots (a carried lease), whose lease has ended. Lower case: a badge after its name." }),
  kindHome: msg({ id: 'workspace.unused.kind.home', defaultMessage: 'retired home, no conversation left', description: "What an unused worktree is (#1450): an agent's old folder kept so its conversations could resume (a reviewer's old worktree, say), none of which can now. Lower case: a badge after its name." }),
  kindQueue: msg({ id: 'workspace.unused.kind.queue', defaultMessage: "merge queue's old folder, not needed now", description: "What an unused worktree is (#1644): a folder the merge queue tested merges in, kept after its last merge, which no merge waiting or card in progress needs now (the queue makes a new one when it does). Lower case: a badge after its name. Glossary: merge queue." }),
  workNotice: msg({ id: 'workspace.unused.workNotice', defaultMessage: "{count, plural, one {# unused worktree has} other {# unused worktrees have}} work that isn't on {known, select, yes {{into}} other {the main branch}}", description: "The Changes tab's notice on unused worktrees holding work." }),
}

/** The id of the user guide's heading on kept worktrees. */
export const UNUSED_WORKTREES_GUIDE = 'unused-worktrees' // i18n-ignore: a user guide heading's id (#1535)

/** Whether it holds work that is nowhere else: commits not on the main branch, or uncommitted files. */
export const holdsWork = (w: UnusedWorktree): boolean => !w.check.removable && ((w.check.ahead ?? 0) > 0 || (w.check.dirty ?? 0) > 0)

/** Its state in a few words: "Merged into main · clean", "3 commits not on main · 2 changed files", or why git couldn't say. */
export function unusedState(w: UnusedWorktree): string {
  const c = w.check
  if (c.removable) return tr(M.merged, { into: c.into ?? '' })
  const parts = [(c.ahead ?? 0) > 0 ? (w.branch || w.slot ? tr(M.commitsNotOn, { count: c.ahead!, known: c.into ? 'yes' : 'no', into: c.into ?? '' }) : tr(M.commitsNoBranch, { count: c.ahead! })) : '', (c.dirty ?? 0) > 0 ? tr(M.changedFiles, { count: c.dirty! }) : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : (c.reason ?? tr(M.notChecked))
}

/** Who made it, in a few words (#476): "was B4" (the Hive agent that worked there), "made by Hive", "not made by Hive". */
export function originLabel(w: Pick<UnusedWorktree, 'origin'>): string {
  const o = w.origin
  if (!o) return ''
  if (o.madeBy === 'other') return tr(M.notMadeByCombwork)
  return o.agentName ? tr(M.was, { agent: o.agentName }) : tr(M.madeByCombwork)
}

/** Its name in lists (#1450): a slot's name (its branch after it, when it has one), else its branch, else "(detached)". */
export function unusedName(w: Pick<UnusedWorktree, 'branch' | 'slot'>): string {
  if (w.slot) return w.branch ? `${w.slot} · ${w.branch}` : w.slot
  return w.branch ?? tr(M.detached)
}

/** What it is to Hive's pools, in a few words (#1450), or '' for a worktree no agent works in. */
export function kindLabel(w: Pick<UnusedWorktree, 'kind'>): string {
  switch (w.kind) {
    case 'slot':
      return tr(M.kindSlot)
    case 'dirtySlot':
      return tr(M.kindDirtySlot)
    case 'carried':
      return tr(M.kindCarried)
    case 'home':
      return tr(M.kindHome)
    case 'queue':
      return tr(M.kindQueue)
    default:
      return ''
  }
}

/** Whether it is one of the slot pool's (#1450): removed only by its guarded clean-up, never given to an agent. */
export const isSlotRow = (w: Pick<UnusedWorktree, 'slot'>): boolean => !!w.slot

/** One unused worktree in the Changes tab's picker (#476): "cw/b4 · was B4 · holds work", "slot-b · slot with changes, not lent · …". */
export function unusedPickerLabel(w: UnusedWorktree): string {
  return [unusedName(w), kindLabel(w) || originLabel(w), tr(w.check.removable ? M.pickMerged : holdsWork(w) ? M.pickWork : M.pickNotChecked)].filter(Boolean).join(' · ')
}

/** What each page of the Changes tab shows, in one sentence at the top of the page's right side (#476). */
export const CHANGES_ABOUT = {
  unused: (project: string): string => tr(M.aboutUnused, { project }),
  /** Where unused worktrees come from and which can go (#1314: the ⓘ beside the heading, the page saying one sentence). */
  unusedTip: (into: string | null): string => tr(M.aboutUnusedTip, { known: into ? 'yes' : 'no', into: into ?? '' }),
  unusedOne: (branch: string, into: string): string => tr(M.aboutUnusedOne, { branch, into }),
  agent: (name: string, branch: string, base: string): string => tr(M.aboutAgent, { agent: name, branch, base }),
  /** An agent's slot, or the slot kept for it (#1569). */
  slot: (agent: string, is: 'slot' | 'carried', name: string, base: string | null): string => tr(M.aboutSlot, { agent, is, name, known: base ? 'yes' : 'no', base: base ?? '' }),
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
 * reply say it: "reused cw/b4, brought up to main at 66ce11b", or why it made a new one. In English (the Agent API's,
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

/** A slot as Unused Worktrees decides from it (#1450): its state, last use, and what holds it now. */
export interface SlotSeen {
  name: string
  state: string
  usedAt: string
  /** An open lease (a card's, a lane's or a carried one). */
  leased: boolean
  /** An operation, a job not settled, or a writer (a session) in it. */
  busy: boolean
  /** Its newest lease was a carried one that has ended (#1441's adopted worktree, given up). */
  carriedEnded: boolean
}

/**
 * Which of a project's slots Unused Worktrees lists, and as what (#1450): never one that is lent, protected by an open
 * carried lease, or busy. A carried folder whose lease ended (`carried`); a slot left with changes and no lease
 * (`dirtySlot`); free ready slots beyond the pool's `size`, the least recently used first (`slot`). Any other state
 * (being made or removed, gone) isn't listed.
 */
export function slotsListed(slots: readonly SlotSeen[], size: number): Map<string, 'slot' | 'dirtySlot' | 'carried'> {
  const out = new Map<string, 'slot' | 'dirtySlot' | 'carried'>()
  const free = slots.filter((s) => !s.leased && !s.busy)
  for (const s of free) {
    if (s.carriedEnded && (s.state === 'ready' || s.state === 'dirty')) out.set(s.name, 'carried')
    else if (s.state === 'dirty') out.set(s.name, 'dirtySlot')
  }
  let over = slots.length - size
  for (const s of free.filter((x) => x.state === 'ready' && !out.has(x.name)).sort((a, b) => a.usedAt.localeCompare(b.usedAt))) {
    if (over-- <= 0) break
    out.set(s.name, 'slot')
  }
  return out
}

/**
 * Whether a retired home is listed (#1450): only once no conversation can resume there any more, no session record of
 * an agent the project still has being in it.
 */
export function homeListed(home: string, sessions: readonly { cwd?: string | null; agentId?: string | null }[], agents: ReadonlySet<string>, same: (a: string, b: string) => boolean): boolean {
  return !sessions.some((s) => !!s.cwd && !!s.agentId && agents.has(s.agentId) && same(s.cwd, home))
}

