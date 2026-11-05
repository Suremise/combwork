// The Git view (#607): a project folder's branch, remotes, upstream, history, tags and commit identity, and what the
// window says about them. Shared by the main process, the window and their tests. Only the user changes these: there is
// no agent tool or Agent API route for any of it.
import { msg, tr, type Msg } from './i18n'
import { listOf, shownText, withValues, type Text } from './advanced'
import type { PlatformId } from './platform/descriptors'
import { queueShown } from './progressQueue'
import type { QueueView } from './workflow/queue'

/** A merge, rebase or other operation git has in progress in the folder. */
export type GitRepoState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

/** The branch the folder's branch tracks, with how far apart they are as of the last fetch. */
export interface GitUpstream {
  /** As git shows it: origin/main. */
  name: string
  /** The remote it is on, or null when it is a local branch. */
  remote: string | null
  ahead: number
  behind: number
  /** The remote branch no longer exists (deleted there, and a fetch noticed). */
  gone?: boolean
}

/** What the status bar shows, and the top of Branches & remotes. */
export interface GitRepoSummary {
  isRepo: boolean
  /** Git can't run (#346): said instead of "isn't a git repository". */
  gitProblem?: string
  /** The branch checked out, or null when HEAD is detached (or not a repository). */
  branch: string | null
  /** The commit checked out (short), or null before the first commit. */
  head: string | null
  state: GitRepoState | null
  upstream: GitUpstream | null
  /** The remotes' names. */
  remotes: string[]
  /** When the folder last fetched (FETCH_HEAD's time), or null if it never has. */
  fetchedAt: number | null
  /**
   * The folder isn't a repository's own top but inside one (a workspace kept in git): that repository's folder. The view
   * shows it, read-only: Hive changes only a project's own repository.
   */
  parentRepo?: string
}

export interface GitRemote {
  name: string
  /** Its password or token shows as ••• (`redactRemoteUrl`). */
  fetchUrl: string
  pushUrl: string
}

export interface GitBranchRow {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  gone: boolean
  /** Checked out in another worktree (an agent's, or an unused one): that folder. */
  worktree: string | null
  commit: string
  /** Its last commit's time (ms). */
  date: number
  subject: string
  /** The remote its upstream is on (#1385: Remove remote names the branches tracking it), or null: none, or a local branch. */
  upstreamRemote?: string | null
  /** Its commit, whole: what a deletion is checked against (#1642). */
  sha?: string
  /** Its commits not in the project's target (#1642): 0 merged into it, null not counted (no target, or too many to count). */
  toTarget?: number | null
  /** The target's commits it hasn't (HI-1180: Update from <target> while it has its own work too); null not counted. */
  fromTarget?: number | null
}

/**
 * What Update from <target> would do to a branch (HI-1180), as its dialog says it: where it runs, whose card's line it is,
 * who works there, whether a pass carries over, and why it can't run now.
 */
export interface BranchUpdatePlan {
  branch: string
  target: string
  /** The target's commits the branch hasn't, and its own commits the target hasn't. */
  behind: number
  ahead: number
  /** Where it runs: the folder the branch is checked out in; a temporary one Hive makes when it is checked out nowhere. */
  where: 'project' | 'slot' | 'worktree' | 'temporary'
  folder: string | null
  slot: string | null
  /** The card whose line it is, while that card isn't Done. */
  card: { key: string; stage: string } | null
  /** Agents working in that folder, none of them in a turn (one in a turn blocks it), each with its status. */
  agents: { name: string; status: string | null }[]
  /** A passed card's pass: kept when the update is the same change ("A pass survives a clean rebase"), else reviewed again. */
  approval: 'carries' | 'reviewAgain' | null
  /** It tracks a remote branch: a rebase rewrites commits pushed there. */
  pushed: boolean
  /** Why it can't run now, in the window's language; null when it can. */
  blocked: string | null
}

/** How Update from <target> brings a branch up to date (HI-1180). */
export type BranchUpdateHow = 'merge' | 'rebase'

/** A remote branch as Branches & remotes groups it (#1642). */
export interface GitRemoteBranchRow {
  /** As git names it: nas/cw/hb1. */
  name: string
  remote: string
  /** On the remote: cw/hb1. */
  branch: string
  sha: string
  date: number
  /** As GitBranchRow's. */
  toTarget: number | null
  /** The remote's own default branch (its HEAD), never offered for deletion. */
  remoteHead: boolean
}

/** What a deletion of branches (#1642) is given for each: its name and the commit the user saw it at. */
export interface BranchAt {
  name: string
  sha: string
}

/** The commits deleting an unmerged branch drops (#1642): the newest few, and how many in all. */
export interface BranchDrops {
  target: string
  total: number
  commits: { short: string; subject: string; date: number }[]
}

/** What a push did to one ref (#1385), from `git push --porcelain`. */
export interface PushedRef {
  /** The branch or tag as the remote has it (refs/heads/ and refs/tags/ left off). */
  name: string
  kind: 'branch' | 'tag' | 'other'
  result: 'pushed' | 'upToDate' | 'refused'
}

/**
 * `git push --porcelain`'s lines, one per ref (`<flag>\t<from>:<to>\t<summary>`): `=` up to date, `!` refused (rejected
 * by the remote, or not a fast-forward: Hive never forces), anything else pushed. Other lines (To …, Done) are skipped.
 */
export function parsePushPorcelain(out: string): PushedRef[] {
  const refs: PushedRef[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^([ +\-*!=])\t[^\t]*:([^\t]+)\t/.exec(line)
    if (!m) continue
    const to = m[2]
    const kind = to.startsWith('refs/heads/') ? 'branch' : to.startsWith('refs/tags/') ? 'tag' : 'other'
    refs.push({ name: to.replace(/^refs\/(heads|tags)\//, ''), kind, result: m[1] === '=' ? 'upToDate' : m[1] === '!' ? 'refused' : 'pushed' })
  }
  return refs
}

/** What Push to… pushes (#1385): the branch checked out, or every branch and tag. */
export type PushScope = 'branch' | 'all'

export interface GitWorktreeRow {
  path: string
  branch: string | null
  head: string | null
  /** One of Hive's own (HI-1710): a review copy, or the merge queue's folder. Never an unused worktree, never removed here. */
  hive?: 'copy' | 'queue'
}

export interface GitIdentityPart {
  name?: string
  email?: string
}

/** Who commits are made as: this repository's own setting, the global one, and the one git uses (last wins). */
export interface GitIdentity {
  local: GitIdentityPart
  global: GitIdentityPart
  effective: GitIdentityPart
}

/** Branches & remotes. */
export interface GitRepoInfo {
  summary: GitRepoSummary
  branches: GitBranchRow[]
  /** Remote branches (origin/feature), newest first, without the remotes' HEAD. */
  remoteBranches: string[]
  remotes: GitRemote[]
  /** The repository's other worktrees (agents' and unused ones): shown, never changed here. */
  worktrees: GitWorktreeRow[]
  identity: GitIdentity
  /** The branch the project's work merges into (its workflow's target, else the default branch) when it exists (#1642). */
  target?: string | null
  /** The repository's default branch (main or master, else the folder's). */
  defaultBranch?: string | null
  /** The remote branches with their state (#1642), as remoteBranches. */
  remoteRows?: GitRemoteBranchRow[]
}

export interface GitCommitRow {
  hash: string
  short: string
  author: string
  email: string
  /** ms */
  date: number
  /** Branches and tags pointing at it, as git decorates them (HEAD -> main, tag: v1.0, origin/main). */
  refs: string[]
  subject: string
}

export interface GitTagRow {
  name: string
  /** The commit it points at (short). */
  commit: string
  /** ms: the tag's own date when annotated, else its commit's. */
  date: number
  /** An annotated tag's message, else the commit's subject. */
  subject: string
  annotated: boolean
}

export interface GitHistory {
  /** A page of the branch's commits, newest first (HISTORY_COMMITS a page). */
  commits: GitCommitRow[]
  /** The branch shown, named whole (refs/heads/x, refs/remotes/origin/x), null for a detached HEAD (#1643). */
  ref: string | null
  /** What it shows unless another is chosen, named whole: the project's target when it is a branch here, else the folder's. */
  defaultRef: string | null
  /** The project's target when it is a branch here. */
  target: string | null
  /** The branches it can show, by name: local, and remote ones. */
  branches: string[]
  remoteBranches: string[]
  /** Which page, of how many, of how many commits in all. */
  page: number
  pages: number
  total: number
  /** Newest first, at most HISTORY_TAGS. */
  tags: GitTagRow[]
  /** Tags not listed. */
  moreTags: number
}

/**
 * Every local branch as the Changes tab's leftover branches read them (HI-1823): uncut, each with its worktree and its
 * commits not in the target (0: merged, as git said; null: not counted or unknown, never taken for merged).
 */
export interface LeftoverInfo {
  isRepo: boolean
  branches: GitBranchRow[]
  target: string | null
  defaultBranch: string | null
  /** Branches whose commits not in the target aren't known (past the ones counted, or a read that failed). */
  uncounted: number
}

/** A local branch the Changes tab can compare (HI-1824), and the folder it is checked out in, if any. */
export interface CompareBranch {
  name: string
  folder: string | null
}

/** What the Changes tab can compare (HI-1824): the local branches, the main line, and the project's integration line. */
export interface CompareLines {
  isRepo: boolean
  /** Git can't run (#346): nothing else is known. */
  gitProblem?: string
  /** By name. */
  branches: CompareBranch[]
  /** The repository's default branch, when it is a local branch. */
  main: string | null
  /** The project's target (G7) when it is a local branch other than main: the comparison shown by default. */
  integration: string | null
  /** The project's slots whose folder has a branch checked out, by name (free ones and blocked cards' included). */
  slots: CompareSlot[]
}

/** A slot as the Changes tab's picker lists it (HI-1824): its branch, and its lease's card and agent when it is lent. */
export interface CompareSlot {
  name: string
  folder: string
  branch: string
  card: number | null
  agent: string | null
  /** The branch its lines merge into, when the pool knows it. */
  target: string | null
}

/** A file `head` changes since it left `base`, as git's name-status letter. */
export interface CompareFile {
  path: string
  status: string
}

/** Two branches compared (HI-1824): read-only, nothing checked out. */
export interface GitComparison {
  base: string
  head: string
  /**
   * The commits compared: each branch's tip as this comparison read it. A file's diff is asked for these (never the
   * branches' tips then), so it belongs to the counts and files shown even if a branch has moved since.
   */
  baseCommit: string
  headCommit: string
  /** Where head left base; null when they share no history (the files are then base's tip against head's). */
  mergeBase: string | null
  /** Head's commits base hasn't, and base's head hasn't. */
  ahead: number
  behind: number
  /** A page of each side's commits, newest first (COMPARE_COMMITS a page). */
  aheadCommits: GitCommitRow[]
  behindCommits: GitCommitRow[]
  page: number
  pages: number
  /** The files head changes since it left base, by path, at most COMPARE_FILES; `filesTotal` counts them all. */
  files: CompareFile[]
  filesTotal: number
}

/** The Changes tab's comparison: commits a page, and files listed at most (HI-1824). */
export const COMPARE_COMMITS = 50
export const COMPARE_FILES = 5000

/** Git → History's commits a page (#1643). */
export const HISTORY_COMMITS = 20
export const HISTORY_TAGS = 50
/** Branches listed (local and remote, each); the rest are counted. */
export const BRANCHES_SHOWN = 200

const M = {
  workflow: msg({ id: 'git.section.workflow', defaultMessage: 'Workflow', description: "The Version Control tab's section with the project's workflow options (glossary 2.1: workflow)." }),
  changes: msg({ id: 'git.section.changes', defaultMessage: 'Changes', description: "The Git tab's section with the uncommitted changes." }),
  history: msg({ id: 'git.section.history', defaultMessage: 'History', description: "The Git tab's section with the last commits and the tags." }),
  branches: msg({ id: 'git.section.branches', defaultMessage: 'Branches & remotes', description: "The Git tab's section with the branch, branches, remotes, worktrees and commit identity." }),
  queue: msg({ id: 'git.section.queue', defaultMessage: 'Merge queue', description: "The Git tab's section with the project's merge queues (#1357): each target's queue now, its history, Pause and Resume. Glossary 2.5: merge queue." }),
  agentBusy: msg({
    id: 'git.busy.agent',
    defaultMessage:
      '{agent} {status, select, starting {is starting} working {is working} waiting {is waiting for your answer} background {is waiting on background tasks it started} watching {is waiting for cards to change (a card watch)} other {stopped in the middle of a task when its sign-in expired}} in the project folder: {action, select, switch {switch branches} create {create and switch to a branch} other {pull}} once it has finished.',
    description: "Why switching branch (or creating one, or pulling) is refused now: an agent works in the project folder. {agent} is the agent's name; {status} what it is doing; {action} what was refused."
  }),
  yourMerge: msg({ id: 'git.busy.yourMerge', defaultMessage: 'Your merge into {branch} is running: {action, select, switch {switch branches} create {create and switch to a branch} other {pull}} once it is done.', description: "Why switching branch (or creating one, or pulling) is refused now: the user's own merge into {branch} is running." }),
  slotHeld: msg({ id: 'git.busy.slotHeld', defaultMessage: '{agent} holds the merge slot for {branch}: {action, select, switch {switch branches} create {create and switch to a branch} other {pull}} once that merge is done.', description: "Why switching branch (or creating one, or pulling) is refused now: an agent is merging into {branch} (it holds the merge slot). {agent} is the agent's name." }),
  slotWaiting: msg({ id: 'git.busy.slotWaiting', defaultMessage: '{agents} {count, plural, one {is} other {are}} waiting for the merge slot for {branch}: {action, select, switch {switch branches} create {create and switch to a branch} other {pull}} once those merges are done.', description: "Why switching branch (or creating one, or pulling) is refused now: agents wait to merge into {branch}. {agents} is their names as a list; {count} how many." }),
  state: msg({ id: 'git.state', defaultMessage: '{state, select, merge {merging} rebase {rebasing} cherrypick {cherry-picking} revert {reverting} other {bisecting}}', description: 'What git has in progress in the project folder, in the status bar and the Git tab (badge), lower case: "main · merging".' }),
  detachedAt: msg({ id: 'git.head.detachedAt', defaultMessage: 'detached at {commit}', description: 'What the project folder has checked out when HEAD is detached. {commit} is a short commit hash. Lower case: also in the status bar ("detached at abc1234 · rebasing").' }),
  noCommitsYet: msg({ id: 'git.head.noCommits', defaultMessage: 'no commits yet', description: "What the project folder has checked out in a repository with no commit yet. Lower case: also in the status bar." }),
  aheadBehind: msg({ id: 'git.status.aheadBehind', defaultMessage: '↑{ahead, number} ↓{behind, number}', description: 'Status bar and Git → Branches & remotes: how many commits a branch is ahead of the remote branch it tracks (↑, to push) and behind it (↓, to pull), "↑2 ↓0". Keep the arrows and the order.' }),
  upstreamGone: msg({ id: 'git.upstream.gone', defaultMessage: 'upstream gone', description: 'In place of the ahead/behind counts: the remote branch a branch tracked was deleted on the remote.' }),
  parentRepo: msg({ id: 'git.parentRepo', defaultMessage: "This project is inside the git repository in {folder}, so the Version Control tab only shows it: Combwork changes only a project's own repository.", description: "Banner in the Version Control tab of a project whose folder is inside another repository (a workspace kept in git). {folder} is that repository's folder." }),
  noUpstream: msg({ id: 'git.status.noUpstream', defaultMessage: 'no upstream', description: 'Status bar, after the branch: it tracks no remote branch ("main · no upstream").' }),
  tipOn: msg({ id: 'git.tip.on', defaultMessage: 'On {branch}', description: "First line of the status bar's git tooltip: the branch checked out." }),
  tipDetached: msg({ id: 'git.tip.detached', defaultMessage: 'HEAD is detached at {commit}', description: "First line of the status bar's git tooltip. {commit} is a short commit hash." }),
  tipNoCommits: msg({ id: 'git.tip.noCommits', defaultMessage: 'No commits yet', description: "First line of the status bar's git tooltip, in a repository with no commit yet." }),
  tipState: msg({ id: 'git.tip.state', defaultMessage: 'Git is {state, select, merge {merging} rebase {rebasing} cherrypick {cherry-picking} revert {reverting} other {bisecting}}: finish or abort it in a terminal.', description: "The status bar's git tooltip, while git has an operation in progress in the project folder." }),
  tipGone: msg({ id: 'git.tip.gone', defaultMessage: 'It tracked {upstream}, which is gone from the remote.', description: "The status bar's git tooltip. {upstream} is the remote branch, such as origin/main." }),
  tipTracks: msg({ id: 'git.tip.tracks', defaultMessage: 'Tracks {upstream}: {ahead, plural, =0 {nothing} one {# commit} other {# commits}} to push, {behind, plural, =0 {nothing} one {# commit} other {# commits}} to pull.', description: "The status bar's git tooltip. {upstream} is the remote branch, such as origin/main; the counts are as of the last fetch." }),
  tipNoTracking: msg({ id: 'git.tip.noTracking', defaultMessage: 'It tracks no remote branch: Push sets one.', description: "The status bar's git tooltip. Push is the Git tab's button." }),
  tipNoRemotes: msg({ id: 'git.tip.noRemotes', defaultMessage: 'No remotes.', description: "The status bar's git tooltip: the repository has no remote." }),
  tipFetched: msg({ id: 'git.tip.fetched', defaultMessage: 'As of the last fetch, {when}. Combwork never fetches by itself.', description: 'The status bar\'s git tooltip. {when} is how long ago, such as "5m ago".' }),
  tipNeverFetched: msg({ id: 'git.tip.neverFetched', defaultMessage: 'Never fetched: Combwork never fetches by itself.', description: "The status bar's git tooltip, when the repository was never fetched." }),
  tipClick: msg({ id: 'git.tip.click', defaultMessage: 'Click for Version Control → Branches & remotes.', description: "Last line of the status bar's git tooltip. Version Control → Branches & remotes is the tab and its section: keep them as they are named there." }),
  identityMissing: msg({ id: 'git.identity.missing', defaultMessage: 'Git has no {missing, select, both {user.name or user.email} name {user.name} other {user.email}} for this repository, so commits fail. Set them here (or in your global git config).', description: 'Warning in Git → Branches & remotes → Commit identity. user.name and user.email are git settings: keep them.' }),
  identityPublic: msg({ id: 'git.identity.public', defaultMessage: "Commits pushed to GitHub show {email} to anyone who reads them. GitHub's no-reply address (…@users.noreply.github.com, in GitHub's email settings) keeps your address private.", description: 'Warning in Git → Branches & remotes → Commit identity. {email} is the address commits are made as.' }),
  enterName: msg({ id: 'git.validate.enterName', defaultMessage: 'Enter a name', description: "Under a form's name box (a remote, a branch, a tag) while it is empty." }),
  remoteNameChars: msg({ id: 'git.validate.remoteName', defaultMessage: 'Use letters, digits, ".", "_" and "-"', description: "Under Add a remote's name box when the name has other characters." }),
  enterUrl: msg({ id: 'git.validate.enterUrl', defaultMessage: 'Enter a URL', description: "Under a remote's URL box while it is empty." }),
  notUrl: msg({ id: 'git.validate.notUrl', defaultMessage: "That isn't a URL or path", description: "Under a remote's URL box." }),
  wholeUrl: msg({ id: 'git.validate.wholeUrl', defaultMessage: 'Type the whole URL: its password or token is hidden here', description: "Under a remote's URL box when it still has ••• for a hidden password." }),
  nameLine: msg({ id: 'git.validate.nameLine', defaultMessage: 'A name is one line, without < or >', description: 'Under a commit identity form when the name has a line break, < or >.' }),
  notEmail: msg({ id: 'git.validate.notEmail', defaultMessage: "That isn't an email address", description: 'Under a commit identity form.' })
}

/** The Version Control tab's sections (#1416, SPEC §16.6): Workflow, then the platform's own. */
export const VC_SECTIONS: readonly { id: 'workflow' | 'changes' | 'history' | 'branches' | 'queue'; label: Msg; icon: string }[] = [
  { id: 'workflow', label: M.workflow, icon: 'git-pull-request' },
  { id: 'changes', label: M.changes, icon: 'git-compare' },
  { id: 'history', label: M.history, icon: 'history' },
  { id: 'branches', label: M.branches, icon: 'git-branch' },
  { id: 'queue', label: M.queue, icon: 'git-merge' }
]
export type VcSection = (typeof VC_SECTIONS)[number]['id']

/** Each platform's own sections, after Workflow: None has none of its own. */
const PLATFORM_SECTIONS: Record<PlatformId, readonly VcSection[]> = {
  git: ['changes', 'history', 'branches', 'queue'],
  none: []
}

/**
 * The sections the tab shows (#1416): Workflow, then the platform's own; and Merge queue while an old Git ruleset's queue
 * is still there (#1356's rule from the project's queues' actual state, `queueShown`), whatever the platform is now,
 * until that state is clear.
 */
export function vcSections(platform: PlatformId, queues: readonly QueueView[], now: number): VcSection[] {
  const own = PLATFORM_SECTIONS[platform]
  const queue = queues.some((v) => queueShown(v, now))
  return ['workflow', ...own, ...(queue && !own.includes('queue') ? (['queue'] as const) : [])]
}

/** The section a project opens at when none is kept (or the kept one isn't shown): Changes for Git, else Workflow. */
export function vcSectionShown(kept: VcSection | undefined, shown: readonly VcSection[]): VcSection {
  if (kept && shown.includes(kept)) return kept
  return shown.includes('changes') ? 'changes' : 'workflow'
}

/** The actions refused while an agent works in the project folder or holds its merge slot. */
export type GitFolderAction = 'switch' | 'create' | 'pull'

/** An agent working in the project folder (no worktree), with its session's status. */
export interface FolderAgent {
  name: string
  status?: string | null
}

/** A merge slot of the project folder: who holds it and who waits. */
export interface FolderSlot {
  branch: string
  /** The agent holding it; null when free or when it's the user's own merge (`byUser`). */
  holder: string | null
  byUser?: boolean
  waiting: string[]
}

/** The sessions' statuses that keep the project folder busy. */
const BUSY = new Set(['starting', 'working', 'waiting', 'background', 'watching', 'signin'])

/**
 * Why switching branch or pulling in the project folder is refused now, or null: it moves the ground under an agent
 * that works there, and under a merge into its branch. Checked in the window (the buttons are disabled with this as the
 * reason) and again by the main process before it acts. As text (#871): main's refusal logs its English.
 */
export function folderBusyData(agents: FolderAgent[], slots: FolderSlot[], action: GitFolderAction): Text | null {
  for (const a of agents) if (a.status && BUSY.has(a.status)) return withValues(M.agentBusy, { agent: a.name, status: a.status, action })
  for (const s of slots) {
    if (s.byUser) return withValues(M.yourMerge, { branch: s.branch, action })
    if (s.holder) return withValues(M.slotHeld, { agent: s.holder, branch: s.branch, action })
    if (s.waiting.length) return withValues(M.slotWaiting, { agents: listOf(s.waiting, 'unit'), count: s.waiting.length, branch: s.branch, action })
  }
  return null
}

/** Text in the language shown, or null. */
const inLanguage = (t: Text | null): string | null => (t ? shownText(t) : null)

/** folderBusyData in the language shown (the window's buttons). */
export const folderBusy = (agents: FolderAgent[], slots: FolderSlot[], action: GitFolderAction): string | null => inLanguage(folderBusyData(agents, slots, action))

/** A state as messages select on (their keys have no "-"). */
export const gitStateKey = (state: GitRepoState): string => state.replace('-', '')

/** "merging" and so on, for a state git has in progress. */
export function gitStateText(state: GitRepoState): string {
  return tr(M.state, { state: gitStateKey(state) })
}

/** What HEAD is: the branch, or "detached at abc1234" (or "no commits yet"). */
export function headText(s: Pick<GitRepoSummary, 'branch' | 'head'>): string {
  return s.branch ?? (s.head ? tr(M.detachedAt, { commit: s.head }) : tr(M.noCommitsYet))
}

/** ↑2 ↓0, or "upstream gone". */
export function aheadBehindText(u: Pick<GitUpstream, 'ahead' | 'behind' | 'gone'>): string {
  return u.gone ? tr(M.upstreamGone) : tr(M.aheadBehind, { ahead: u.ahead, behind: u.behind })
}

/** Why the Git view doesn't change a folder inside another repository (`parentRepo`), or null. */
export function parentRepoData(s: Pick<GitRepoSummary, 'parentRepo'>): Text | null {
  return s.parentRepo ? withValues(M.parentRepo, { folder: s.parentRepo }) : null
}

/** parentRepoData in the language shown. */
export const parentRepoText = (s: Pick<GitRepoSummary, 'parentRepo'>): string | null => inLanguage(parentRepoData(s))

/** The status bar's item: "main · origin · ↑2 ↓0", "main · no upstream", "detached at abc1234 · rebasing". Empty when not a repository. */
export function gitStatusText(s: GitRepoSummary): string {
  if (!s.isRepo) return ''
  const parts = [headText(s)]
  if (s.state) parts.push(gitStateText(s.state))
  if (s.upstream) parts.push(s.upstream.remote ?? s.upstream.name, aheadBehindText(s.upstream))
  else if (s.branch && s.remotes.length) parts.push(tr(M.noUpstream))
  return parts.join(' · ')
}

/** The status bar item's tooltip, with when the counts are from. */
export function gitStatusTip(s: GitRepoSummary, fetched: string | null): string {
  const lines = [s.branch ? tr(M.tipOn, { branch: s.branch }) : s.head ? tr(M.tipDetached, { commit: s.head }) : tr(M.tipNoCommits)]
  if (s.state) lines.push(tr(M.tipState, { state: gitStateKey(s.state) }))
  if (s.upstream?.gone) lines.push(tr(M.tipGone, { upstream: s.upstream.name }))
  else if (s.upstream) lines.push(tr(M.tipTracks, { upstream: s.upstream.name, ahead: s.upstream.ahead, behind: s.upstream.behind }))
  else if (s.branch && s.remotes.length) lines.push(tr(M.tipNoTracking))
  else if (!s.remotes.length) lines.push(tr(M.tipNoRemotes))
  if (s.remotes.length) lines.push(fetched ? tr(M.tipFetched, { when: fetched }) : tr(M.tipNeverFetched))
  lines.push(tr(M.tipClick))
  return lines.join('\n')
}

/** What stands for a hidden password or token. */
export const HIDDEN = '•••'

const URL_START = /^([a-z][a-z0-9+.-]*:\/\/)([\s\S]*)$/i
/** Schemes whose user name is often a token itself: all of their userinfo is hidden. */
const TOKEN_SCHEMES = /^(https?|ftps?):/i

/**
 * A remote URL with its password or token hidden (https://•••@github.com/x/y, ftp://•••@host/r, ssh://me:•••@host/r,
 * https://host/r.git?•••), wherever it is shown or logged. Others (git@github.com:x/y, a folder) as they are. It errs
 * towards hiding: the sign-in is everything before the last @ ahead of the query (a password may hold / or '), and the
 * whole query and fragment go (any value of them may be a token).
 */
export function redactRemoteUrl(url: string): string {
  const m = URL_START.exec(url)
  if (!m) return url
  const [, scheme, rest] = m
  const q = rest.search(/[?#]/)
  let place = q < 0 ? rest : rest.slice(0, q)
  const at = place.lastIndexOf('@')
  if (at >= 0) {
    const info = place.slice(0, at)
    // All of it for http(s) and ftp(s); for other schemes (ssh://git@host) the user name stays and only a password goes.
    const shown = TOKEN_SCHEMES.test(scheme) ? HIDDEN : info.includes(':') ? `${info.slice(0, info.indexOf(':'))}:${HIDDEN}` : info
    place = `${shown}${place.slice(at)}`
  }
  return `${scheme}${place}${q < 0 ? '' : `${rest[q]}${HIDDEN}`}`
}

/**
 * Text that may quote remote URLs (git's own error messages): each URL in it, to the next whitespace (a quote or
 * apostrophe can be part of a password or query), as `redactRemoteUrl` shows it.
 */
export function redactUrlsIn(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, (u) => redactRemoteUrl(u))
}

/**
 * The secret parts of a remote URL as configured: its password (an http(s) or ftp(s) URL's whole userinfo too), its
 * query and each of its values, as written and decoded, so text that quotes them in any other way can be cleaned of
 * them (`scrubSecrets`). Parts shorter than four characters are left: replacing them would garble the text.
 */
export function urlSecrets(url: string): string[] {
  const m = URL_START.exec(url.trim())
  if (!m) return []
  const [, scheme, rest] = m
  const out: string[] = []
  const q = rest.search(/[?#]/)
  const place = q < 0 ? rest : rest.slice(0, q)
  const at = place.lastIndexOf('@')
  if (at >= 0) {
    const info = place.slice(0, at)
    if (TOKEN_SCHEMES.test(scheme)) out.push(info)
    if (info.includes(':')) out.push(info.slice(info.indexOf(':') + 1))
  }
  if (q >= 0) {
    const query = rest.slice(q + 1)
    out.push(query, ...query.split(/[&;#]/).map((p) => (p.includes('=') ? p.slice(p.indexOf('=') + 1) : p)))
  }
  const decoded = out.map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  return [...new Set([...out, ...decoded])].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)
}

/** Text with each of `secrets` (longest first) replaced by •••. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join(HIDDEN)
  return out
}

/** A GitHub remote. */
export function isGitHubUrl(url: string): boolean {
  return /(^|[@/.])github\.com[:/]/i.test(url)
}

/** GitHub's no-reply address (12345+name@users.noreply.github.com, or name@users.noreply.github.com). */
export function isNoReplyEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/i.test(email.trim())
}

/**
 * What the identity section warns about: commits that would fail (no name or email), and a personal address on commits
 * that go to GitHub, where everyone can read it (GitHub's no-reply address keeps it private).
 */
export function identityWarnings(id: GitIdentity, remotes: Pick<GitRemote, 'fetchUrl' | 'pushUrl'>[]): string[] {
  const out: string[] = []
  const missing = !id.effective.name && !id.effective.email ? 'both' : !id.effective.name ? 'name' : !id.effective.email ? 'email' : null
  if (missing) out.push(tr(M.identityMissing, { missing }))
  const email = id.effective.email
  if (email && !isNoReplyEmail(email) && remotes.some((r) => isGitHubUrl(r.fetchUrl) || isGitHubUrl(r.pushUrl))) out.push(tr(M.identityPublic, { email }))
  return out
}

/** A remote's name as `git remote add` takes it here: letters, digits, . _ - (not starting with - or .). */
export function remoteNameProblemData(name: string): Text | null {
  if (!name.trim()) return M.enterName
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name.trim())) return M.remoteNameChars
  return null
}

/** remoteNameProblemData in the language shown (a dialog's check). */
export const remoteNameProblem = (name: string): string | null => inLanguage(remoteNameProblemData(name))

/** A remote URL Hive passes to git: one line, not an option. */
export function remoteUrlProblemData(url: string): Text | null {
  const u = url.trim()
  if (!u) return M.enterUrl
  if (/\s/.test(u) || u.startsWith('-')) return M.notUrl
  if (u.includes(HIDDEN)) return M.wholeUrl
  return null
}

/** remoteUrlProblemData in the language shown (a dialog's check). */
export const remoteUrlProblem = (url: string): string | null => inLanguage(remoteUrlProblemData(url))

/** Name and email for `git config user.*`: one line each; an email has an @. Empty clears this repository's own. */
export function identityProblemData(name: string, email: string): Text | null {
  if (/[\r\n<>]/.test(name)) return M.nameLine
  if (email.trim() && (!/^[^\s<>@]+@[^\s<>@]+$/.test(email.trim()))) return M.notEmail
  return null
}

/** identityProblemData in the language shown (a dialog's check). */
export const identityProblem = (name: string, email: string): string | null => inLanguage(identityProblemData(name, email))

/** The id of the user guide's heading for this view. */
// i18n-ignore: a user guide heading's id (#1535)
export const GIT_VIEW_GUIDE = 'version-control-tab'
