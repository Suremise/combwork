import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { agentPlace, folderFacts } from './agentFolders'
import { readFile, stat } from 'original-fs/promises'
import { projectAgents } from '../shared/defaults'
import {
  BRANCHES_SHOWN,
  HISTORY_COMMITS,
  HISTORY_TAGS,
  folderBusyData,
  gitStateKey,
  identityProblemData,
  parentRepoData,
  redactRemoteUrl,
  redactUrlsIn,
  scrubSecrets,
  urlSecrets,
  parsePushPorcelain,
  remoteNameProblemData,
  remoteUrlProblemData,
  type PushedRef,
  type PushScope,
  type FolderSlot,
  type GitBranchRow,
  type GitFolderAction,
  type GitHistory,
  type GitIdentity,
  type GitIdentityPart,
  type GitRemote,
  type GitRepoInfo,
  type GitRepoState,
  type GitRepoSummary,
  type GitWorktreeRow,
  type LeftoverInfo,
  type BranchAt,
  type BranchDrops,
  type GitRemoteBranchRow,
  type BranchUpdateHow,
  type BranchUpdatePlan
} from '../shared/gitRepo'
import { localUse, remoteKept } from '../shared/branchCleanup'
import { samePath } from '../shared/movePaths'
import * as G from './platform/git'
import { plainRepo } from './platform/repoRefs'
import { resolvedOf } from './workflow/rulesets'
import { workBadges } from './workflow/cardWork'
import { workflowWrite } from './workflow/writes'
import { checkProject } from './branchWatch'
import { samePlace } from './fsutil'
import type { AgentDef } from '../shared/types'
import { withRepoLock } from './repoLock'
import { branchOfRef, git, type GitResult } from './git'
import { gitProblem, gitTool } from './gitTool'
import { gitProblemData } from '../shared/gitTool'
import { linesOf, listOf, shownText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import { fmt, msg, tr, type Msg } from '../shared/i18n'
import { errorText, HiveError } from './hiveError'
import { changingFolder } from './folderFence'
import { createLogger, userText } from './logger'
import { mergeSlots } from './mergeSlotHost'
import { sessions } from './sessions'
import { workspace, workspaceOf } from './workspace'
import { lineCard } from './branchMerge'
import { queueStateOf } from './workflow/queueState'
import { workflowFor } from './workflow/service'

const log = createLogger('gitRepo')

/**
 * The Git view (#607): a project folder's branch, remotes, upstream, history, tags and identity, and the user's actions
 * on them. Everything here is the user's, from the window: no agent tool or Agent API route reaches it. Actions take
 * only a project folder (`assertProject`), never a worktree: agents' worktrees change through the merge flow. Nothing
 * fetches by itself: ahead/behind is as of the user's last fetch.
 */

/** Fetch, pull and push can wait on a sign-in window (Git Credential Manager): long, but never forever. */
const NETWORK_MS = 5 * 60_000

/** Commands that reach a remote never prompt in a terminal nobody sees: they fail instead (a credential helper's window still opens). */
function networkEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

const net = (cwd: string, args: string[]): Promise<GitResult> => git(cwd, args, 16 * 1024 * 1024, undefined, { env: networkEnv(), timeout: NETWORK_MS })

/**
 * The Git view's words (#850): what an action did, why it was refused or failed. Only the window reads them, so what an
 * action did is said in its language at once (`tr`), and a refusal is a HiveError (English to the log, the window's
 * language through IPC). Git's own words stay as git said them.
 */
const M = {
  gaveUp: msg({ id: 'service.gitRepo.gaveUp', defaultMessage: 'git gave up after {minutes} minutes (no answer from the remote, or a sign-in left open).', description: 'Why fetching, pulling or pushing failed: git waited {minutes} minutes for the remote (or a sign-in window) and stopped.' }),
  exitCode: msg({ id: 'service.gitRepo.exitCode', defaultMessage: 'exit code {code}', description: 'Why a git command failed when git said nothing: the number it exited with.' }),
  command: msg({ id: 'service.gitRepo.command', defaultMessage: '{command}: {why}', description: "An error in the Git view: a git command ({command}, as it is: \"git log\") failed; {why} is git's own words, or why git can't run." }),
  switchFailed: msg({ id: 'service.gitRepo.switchFailed', defaultMessage: "Couldn't switch to {branch}: {why}", description: "An error switching the project folder to the branch {branch}; {why} is git's own words." }),
  createFailed: msg({ id: 'service.gitRepo.createFailed', defaultMessage: "Couldn't create {name}: {why}", description: "An error creating the branch or tag {name}; {why} is git's own words." }),
  noCommits: msg({ id: 'service.gitRepo.noCommits', defaultMessage: 'The repository has no commits yet: commit something first.', description: 'An error creating a branch in a repository with no commit yet.' }),
  noRemote: msg({ id: 'service.gitRepo.noRemote', defaultMessage: "There's no remote {remote}.", description: 'An error pushing or tagging: the repository has no remote called {remote}.' }),
  fetchFailed: msg({ id: 'service.gitRepo.fetchFailed', defaultMessage: "Couldn't fetch: {why}", description: "An error fetching from the repository's remotes; {why} is git's own words (any password in a URL hidden)." }),
  noBranch: msg({ id: 'service.gitRepo.noBranch', defaultMessage: "There's no branch {branch}.", description: 'An error in the Git view (switching branch, choosing what a branch tracks): the repository has no branch called {branch}.' }),
  detachedPush: msg({ id: 'service.gitRepo.detachedPush', defaultMessage: 'HEAD is detached: switch to a branch to push.', description: 'An error pushing in the Git view: the project folder is on no branch (a detached HEAD: keep HEAD as it is).' }),
  nothingToPush: msg({ id: 'service.gitRepo.nothingToPush', defaultMessage: 'The repository has no commits yet: nothing to push.', description: 'An error pushing in the Git view: the repository has no commit yet.' }),
  pushFailed: msg({ id: 'service.gitRepo.pushFailed', defaultMessage: "Couldn't push to {to}: {why}", description: "An error pushing to the remote branch {to} in the Git view; {why} is git's own words." }),
  pushed: msg({ id: 'service.gitRepo.pushed', defaultMessage: 'Pushed {branch} to {to}.', description: 'After pushing in the Git view: the branch {branch} went to the remote branch {to}.' }),
  pushedAll: msg({ id: 'service.gitRepo.pushedAll', defaultMessage: 'Pushed every branch and tag to {remote}:', description: "After Push to… with all branches and tags in the Git view: the first line, what went to the remote {remote}; a line for each outcome follows (service.gitRepo.pushOutcome)." }),
  pushAllRefused: msg({ id: 'service.gitRepo.pushAllRefused', defaultMessage: "{remote} refused {n, plural, one {# branch or tag} other {# branches and tags}} (Combwork never forces a push): it has commits they haven't, so pull or merge them first. What happened to each:", description: "An error after Push to… with all branches and tags in the Git view: the first line, the remote {remote} refused {n} of them; a line for each outcome follows (service.gitRepo.pushOutcome)." }),
  pushOutcome: msg({ id: 'service.gitRepo.pushOutcome', defaultMessage: '{result, select, pushed {Pushed: {refs}.} upToDate {Already up to date: {refs}.} refused {Refused: {refs}.} other {Tags pushed: {refs}.}}', description: "A line after Push to… with all branches and tags in the Git view: the branches pushed, already up to date, refused (branches or tags), or the tags pushed. {refs} lists them all by name." }),
  remoteTrackingChanged: msg({ id: 'service.gitRepo.remoteTrackingChanged', defaultMessage: "The branches tracking {remote} changed since you were asked, so nothing was removed: look at them again.", description: 'An error removing a remote in the Git view: the local branches tracking it are not the ones the confirmation listed (one started or stopped tracking it meanwhile).' }),
  notOnRemote: msg({ id: 'service.gitRepo.notOnRemote', defaultMessage: '{remote} has no {branch} (as of the last fetch): push it there first, or fetch.', description: 'An error choosing what a branch tracks in the Git view: the remote {remote} has no branch {branch} that Hive knows of.' }),
  badName: msg({ id: 'service.gitRepo.badName', defaultMessage: "{kind, select, tag {{hasName, select, yes {{name} isn't a valid tag name.} other {That isn't a valid tag name.}}} other {{hasName, select, yes {{name} isn't a valid branch name.} other {That isn't a valid branch name.}}}}", description: "An error creating a branch or a tag ({kind}): its name {name} is one git refuses. {hasName} is no when no name was given (then it says That)." })
}

/** A refusal or failure from a message and its values. */
const refusal = (m: Msg, values?: TextValues): HiveError => new HiveError(values ? withValues(m, values) : m)

/**
 * Git's own words for a failure, a few lines of them (a switch lists the files in the way), without its hints, and with
 * every URL it quotes shown without its password or token (`redactUrlsIn`): the message reaches the window and the log.
 */
export function gitSays(r: GitResult): string {
  return shownText(gitSaid(r))
}

/** gitSays as text: git's own lines as they came, Hive's words (it gave up, an exit code alone) as a message. */
export function gitSaid(r: GitResult): TextPart {
  if (r.timedOut) return withValues(M.gaveUp, { minutes: NETWORK_MS / 60_000 })
  const lines = `${r.err}\n${r.out}`
    .split(/\r?\n/)
    .map((l) => l.replace(/^(error|fatal): /, '').trimEnd())
    .filter((l) => l.trim() && !l.startsWith('hint:'))
  return redactUrlsIn(lines.slice(0, 8).join('\n')) || withValues(M.exitCode, { code: r.code })
}

/** A git command's failure: the message `m` with its values and `why` (git's own words, or why git can't run). */
function failed(m: Msg, values: TextValues, r: GitResult): Error {
  return refusal(m, { ...values, why: gitProblemData(gitTool()) ?? gitSaid(r) })
}

/** A failed git command, named as it is ("git log"). */
const commandFailed = (command: string, r: GitResult): Error => failed(M.command, { command }, r)

const EMPTY: GitRepoSummary = { isRepo: false, branch: null, head: null, state: null, upstream: null, remotes: [], fetchedAt: null }

/** ahead 2, behind 1 / gone / "" → counts. */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  return { ahead: parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10), behind: parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10), gone: /\bgone\b/.test(track) }
}

const STATE_FILES: [string, GitRepoState][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect']
]

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

/**
 * The folder's branch (or detached HEAD), any merge or rebase in progress, its upstream with ahead/behind as of the last
 * fetch, its remotes and when it last fetched. Cheap enough for the status bar: no working-tree scan.
 */
export async function repoSummary(root: string): Promise<GitRepoSummary> {
  const problem = gitProblem()
  if (problem) return { ...EMPTY, gitProblem: problem }
  // HI-2115: read again with git only when what it is read from changed (summaryKey); the state and the fetch time,
  // read from the files, are always read again.
  const k = resolve(root).toLowerCase()
  const had = summaries.get(k)
  const basis: KeyBasis = { upstream: had?.summary.upstream ?? null, configs: had?.configs ?? [] }
  const before = await summaryKey(root, basis)
  if (had && before !== null && before === had.key) {
    keep(k, had)
    return { ...had.summary, ...(await fileParts(had.gitDir)) }
  }
  const read = await readSummary(root)
  if (!read.gitDir || !read.configs || before === null) summaries.delete(k)
  else {
    // Kept only when nothing changed while git read it: its key as it is now, from what git just named (its upstream,
    // the config files it read).
    const still = (await summaryKey(root, basis)) === before
    const key = still ? await summaryKey(root, { upstream: read.summary.upstream, configs: read.configs }) : null
    if (key !== null) keep(k, { key, gitDir: read.gitDir, configs: read.configs, summary: read.summary })
    else summaries.delete(k)
  }
  return read.summary
}

/** HI-2115: each folder's last summary (lower-cased path), its git dir, the config files git read, and its key (summaryKey). */
type KeptSummary = { key: string; gitDir: string; configs: string[]; summary: GitRepoSummary }
const summaries = new Map<string, KeptSummary>()

/**
 * HI-2135: how many folders' summaries are kept: the most recently read, the oldest dropped first, so the folders of a
 * long session (projects removed, slots and review copies gone, other workspaces) aren't kept for as long as Hive runs.
 * A folder dropped is read with git again the next time, as one never read is.
 */
const SUMMARIES_MAX = 200
let summariesMax = SUMMARIES_MAX

/** A folder's summary kept as the most recently read (a Map's order is its insertion's), dropping the oldest past the bound. */
function keep(k: string, kept: KeptSummary): void {
  summaries.delete(k)
  summaries.set(k, kept)
  while (summaries.size > summariesMax) summaries.delete(summaries.keys().next().value!)
}

/** Tests: forgets the summaries read. */
export function forgetSummaries(): void {
  summaries.clear()
}

/** Tests: how many folders' summaries are kept at most (null: as Hive keeps them), and how many are kept now. */
export function summariesForTests(max?: number | null): number {
  if (max !== undefined) summariesMax = max ?? SUMMARIES_MAX
  return summaries.size
}

/** What a summary's key is read with: the upstream and the config files of the last read (none before the first). */
interface KeyBasis {
  upstream: GitRepoSummary['upstream']
  configs: readonly string[]
}

/**
 * HI-2115: what a folder's summary is read from, from its files with no git process: HEAD, the branch's and its
 * upstream's commits, the packed refs, and every config file git reads there (remotes and upstreams can come from any):
 * those its last read named, the repository's own, and the global ones whether they exist yet or not. The status bar
 * reads the summary again at each usage change of the project's agents (several a second while lanes build): the same
 * key is git's same answer. Only for a plain repository (plainRepo, the one rule of Hive's git caches), every one of
 * those config files free of includes: null otherwise, as where the files can't say (no `.git` of its own, a branch or
 * an upstream whose commit isn't read from them) or config is given in the environment.
 */
async function summaryKey(root: string, basis: KeyBasis): Promise<string | null> {
  if (process.env.GIT_CONFIG_PARAMETERS || process.env.GIT_CONFIG_COUNT || process.env.GIT_CONFIG) return null
  const own = G.gitDirSync(root)
  const common = own ? G.commonDirSync(root) : null
  if (!own || !common) return null
  const configs = [...new Set([...basis.configs, join(common, 'config'), join(own, 'config.worktree'), ...globalConfigs()].map((f) => resolve(f).toLowerCase()))].sort()
  // A reftable's refs, an include's files, replacements: what can change the answer unseen gets no key (HR3's rounds 1, 2).
  if (!plainRepo(common, own, configs)) return null
  const head = await readFile(join(own, 'HEAD'), 'utf8').then((h) => h.trim(), () => null)
  if (head === null) return null
  const ref = /^ref: (.+)$/.exec(head)?.[1]
  // A branch whose commit the files don't give (unborn, or a ref backend they can't read): no key, git each time.
  const commit = ref ? G.refSync(common, ref) : head
  if (!commit) return null
  let up: string | null = null
  if (basis.upstream) {
    up = G.refSync(common, basis.upstream.remote ? `refs/remotes/${basis.upstream.name}` : `refs/heads/${basis.upstream.name}`)
    if (!up) return null
  }
  const at = (p: string): Promise<string> => stat(p).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')
  const stats = await Promise.all([join(common, 'packed-refs'), ...configs].map(at))
  return JSON.stringify([own.toLowerCase(), head, commit, up, configs, stats])
}

/** The global config files git reads, as it finds them: GIT_CONFIG_GLOBAL, else ~/.gitconfig and the XDG one. */
function globalConfigs(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL) return [process.env.GIT_CONFIG_GLOBAL]
  const home = process.env.HOME || homedir()
  return [join(home, '.gitconfig'), process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'git', 'config') : join(home, '.config', 'git', 'config')]
}

/** What a summary reads from the git dir's files each time: a merge or rebase under way, and the last fetch. */
async function fileParts(gitDir: string): Promise<Pick<GitRepoSummary, 'state' | 'fetchedAt'>> {
  let state: GitRepoState | null = null
  for (const [file, s] of STATE_FILES) {
    if (await exists(join(gitDir, file))) {
      state = s
      break
    }
  }
  const fetched = await stat(join(gitDir, 'FETCH_HEAD')).catch(() => null)
  return { state, fetchedAt: fetched ? fetched.mtimeMs : null }
}

/**
 * The config files `git config --list --show-origin -z` read in `root` (each entry its origin, then its key and value),
 * as absolute paths; null when an entry came from elsewhere than a file or the command line (a blob, standard input),
 * which no file's change would show. The command line's are Hive's own (GIT_PREFIX), the same at every read; config
 * given in the environment (also said as the command line's) isn't kept at all (summaryKey).
 */
export function configOrigins(out: string, root: string): string[] | null {
  const parts = out.split('\0')
  const files = new Set<string>()
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]
    if (origin === 'command line:') continue
    if (!origin.startsWith('file:')) return null
    files.add(resolve(root, origin.slice(5)))
  }
  return [...files]
}

/** A summary read by git, its git dir, and the config files git read there (null: unknown, so it isn't kept). */
async function readSummary(root: string): Promise<{ summary: GitRepoSummary; gitDir: string | null; configs?: string[] | null }> {
  const dir = await git(root, ['rev-parse', '--absolute-git-dir', '--show-toplevel'])
  if (!dir.ok) {
    if (gitProblem()) return { summary: { ...EMPTY, gitProblem: gitProblem()! }, gitDir: null }
    if (/not a git repository/i.test(dir.err)) return { summary: EMPTY, gitDir: null }
    throw commandFailed('git rev-parse', dir) // i18n-ignore: a git command, as it is
  }
  const [gitDir, top] = dir.out.split(/\r?\n/).map((l) => l.trim())
  // A folder inside another repository (a workspace kept in git) shows it, but changes nothing of it.
  const parentRepo = top && !samePlace(top, root) ? resolve(top) : undefined
  // HI-2115: the config files git reads here (system, global, the repository's, included), which the summary's key
  // watches: an entry's origin is `file:<path>`; other origins (the command line, a blob) aren't files to watch.
  const [sym, head, remotes, origins] = await Promise.all([git(root, ['symbolic-ref', '-q', 'HEAD']), git(root, ['rev-parse', '-q', '--verify', '--short', 'HEAD']), git(root, ['remote']), git(root, ['config', '--list', '--show-origin', '-z'])])
  const configs = origins.ok ? configOrigins(origins.out, root) : null
  // symbolic-ref says 1 for a detached HEAD; anything else is a failure, not "detached" (#346).
  if (!sym.ok && sym.code !== 1) throw commandFailed('git symbolic-ref', sym) // i18n-ignore: a git command, as it is
  if (!remotes.ok) throw commandFailed('git remote', remotes) // i18n-ignore: a git command, as it is
  // The full ref, cut: `--short` says heads/x beside a tag x, a name no ref or card matches (HI-2426).
  const branch = sym.ok ? branchOfRef(sym.out) : null
  let upstream: GitRepoSummary['upstream'] = null
  if (branch) {
    const r = await git(root, ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:track,nobracket)', `refs/heads/${branch}`])
    if (!r.ok) throw commandFailed('git for-each-ref', r) // i18n-ignore: a git command, as it is
    const row = r.out.split('\n').map((l) => l.split('\0')).find((f) => f[0] === `refs/heads/${branch}`)
    if (row?.[1]) upstream = { name: upstreamName(row[1]), remote: row[2] && row[2] !== '.' ? row[2] : null, ...parseTrack(row[3] ?? '') }
    if (upstream && !upstream.gone) delete upstream.gone
  }
  const summary = { isRepo: true, branch, head: head.ok ? head.out.trim() || null : null, upstream, remotes: remotes.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), ...(await fileParts(gitDir)), ...(parentRepo ? { parentRepo } : {}) }
  // A folder inside another repository is never kept: its `.git` isn't its own (summaryKey reads none).
  return { summary, gitDir: parentRepo ? null : gitDir, configs }
}

/**
 * A branch's upstream by its whole ref (`%(upstream)`): `origin/main`, or a local branch's name. `%(upstream:short)` says
 * remotes/origin/main beside a tag origin/main, a name no ref matches (HI-2426).
 */
const upstreamName = (full: string): string => branchOfRef(full, 'refs/remotes/') ?? branchOfRef(full) ?? full.trim()

/** `git remote -v`: each remote's fetch and push URL (passwords hidden). */
export function parseRemotes(out: string): GitRemote[] {
  const by = new Map<string, GitRemote>()
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const r = by.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') r.fetchUrl = redactRemoteUrl(m[2])
    else r.pushUrl = redactRemoteUrl(m[2])
    by.set(m[1], r)
  }
  return [...by.values()]
}

/** `git worktree list --porcelain`: each worktree but the first (the main one). */
export function parseWorktrees(out: string): GitWorktreeRow[] {
  const rows: GitWorktreeRow[] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (!path) continue
    rows.push({ path: path.replace(/\//g, '\\'), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null, head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]?.slice(0, 8) ?? null })
  }
  return rows.slice(1)
}

/** `git config --get-regexp ^user\.(name|email)$` (one scope or all): the last of each wins, as git takes it. */
export function parseIdentity(r: GitResult): GitIdentityPart {
  const out: GitIdentityPart = {}
  if (!r.ok) return out
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^user\.(name|email) (.*)$/i.exec(line)
    if (m) out[m[1].toLowerCase() as 'name' | 'email'] = m[2]
  }
  return out
}

async function identity(root: string): Promise<GitIdentity> {
  const re = '^user\\.(name|email)$'
  // Exit 1 is "none set"; other failures leave that part empty too (the section then says it isn't set).
  const [local, global, effective] = await Promise.all([git(root, ['config', '--local', '--get-regexp', re]), git(root, ['config', '--global', '--get-regexp', re]), git(root, ['config', '--get-regexp', re])])
  return { local: parseIdentity(local), global: parseIdentity(global), effective: parseIdentity(effective) }
}

/**
 * Branches & remotes: the summary, the branches (local and remote), remotes with their URLs, other worktrees, identity.
 * With `workTarget` (the project's workflow target, null for none: the default branch), each branch's commits not in it
 * (#1642); left out, none are counted.
 */
export async function repoInfo(root: string, workTarget?: string | null): Promise<GitRepoInfo> {
  const summary = await repoSummary(root)
  const none: GitRepoInfo = { summary, branches: [], remoteBranches: [], remotes: [], worktrees: [], identity: { local: {}, global: {}, effective: {} } }
  if (!summary.isRepo) return none
  const fields = ['%(refname)', '%(refname:short)', '%(upstream)', '%(upstream:track,nobracket)', '%(objectname:short)', '%(committerdate:unix)', '%(contents:subject)', '%(upstream:remotename)', '%(objectname)', '%(symref)']
  const [refs, remotes, wts, id, targets] = await Promise.all([
    git(root, ['for-each-ref', '--sort=-committerdate', `--format=${fields.join('%00')}`, 'refs/heads', 'refs/remotes']),
    git(root, ['remote', '-v']),
    git(root, ['worktree', 'list', '--porcelain']),
    identity(root),
    // Only the view's read groups its branches (#1642): an action reading the branches (a switch) skips it.
    workTarget === undefined ? { target: null, defaultBranch: null } : branchTargets(root, workTarget)
  ])
  if (!refs.ok) throw commandFailed('git for-each-ref', refs) // i18n-ignore: a git command, as it is
  if (!remotes.ok) throw commandFailed('git remote', remotes) // i18n-ignore: a git command, as it is
  const worktrees = wts.ok ? parseWorktrees(wts.out) : []
  const remoteList = parseRemotes(remotes.out)
  // A remote branch's remote: the longest remote name it starts with (a remote's name may hold a slash).
  const remoteOf = (name: string): string | null => remoteList.map((r) => r.name).filter((r) => name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? null
  const branches: GitBranchRow[] = []
  const remoteBranches: string[] = []
  const remoteRows: GitRemoteBranchRow[] = []
  const remoteHeads = new Set<string>()
  for (const line of refs.out.split('\n')) {
    const f = line.split('\0')
    if (f.length < 10) continue
    if (f[0].startsWith('refs/remotes/')) {
      if (f[0].endsWith('/HEAD')) {
        if (f[9]) remoteHeads.add(f[9].replace(/^refs\/remotes\//, ''))
        continue
      }
      // Each named off its whole ref, as summary.branch is: `refname:short` says heads/x, remotes/o/x beside a tag x, o/x (HI-2426).
      const name = branchOfRef(f[0], 'refs/remotes/') ?? f[1]
      remoteBranches.push(name)
      const remote = remoteOf(name)
      if (remote) remoteRows.push({ name, remote, branch: name.slice(remote.length + 1), sha: f[8], date: Number(f[5]) * 1000, toTarget: null, remoteHead: false })
      continue
    }
    const name = branchOfRef(f[0]) ?? f[1]
    const wt = worktrees.find((w) => w.branch === name)
    branches.push({ name, current: name === summary.branch, upstream: f[2] ? upstreamName(f[2]) : null, ...parseTrack(f[3]), worktree: wt?.path ?? null, commit: f[4], date: Number(f[5]) * 1000, subject: f[6], upstreamRemote: f[7] && f[7] !== '.' ? f[7] : null, sha: f[8] })
  }
  for (const r of remoteRows) r.remoteHead = remoteHeads.has(r.name)
  const shown = branches.slice(0, BRANCHES_SHOWN)
  const shownRemote = remoteRows.slice(0, BRANCHES_SHOWN)
  if (targets.target) await measure(root, targets.target, shown, shownRemote)
  return { summary, branches: shown, remoteBranches: remoteBranches.slice(0, BRANCHES_SHOWN), remotes: remoteList, worktrees, identity: id, target: targets.target, defaultBranch: targets.defaultBranch, remoteRows: shownRemote }
}

/**
 * Every local branch, for the Changes tab's leftover branches (HI-1823): never cut at BRANCHES_SHOWN as `repoInfo`'s
 * are, so none is left out. Each with the worktree it is checked out in and its commits not in the target as `measure`
 * counts them: 0 only when git said it is merged, a count for the first COUNTED unmerged ones, null for the rest and
 * for any it couldn't read (`uncounted` says how many). No remote work, no identity.
 */
export async function leftoverInfo(root: string, workTarget: string | null): Promise<LeftoverInfo> {
  const summary = await repoSummary(root)
  if (!summary.isRepo) return { isRepo: false, branches: [], target: null, defaultBranch: null, uncounted: 0 }
  // The whole ref, its name read off it (HR1's round 1): `refname:short` says `heads/x` where a tag is also called x, a
  // name no worktree, card, count or action would match.
  const fields = ['%(refname)', '%(objectname:short)', '%(committerdate:unix)', '%(contents:subject)', '%(objectname)']
  const [refs, wts, targets, sym] = await Promise.all([git(root, ['for-each-ref', '--sort=-committerdate', `--format=${fields.join('%00')}`, 'refs/heads']), git(root, ['worktree', 'list', '--porcelain']), branchTargets(root, workTarget), git(root, ['symbolic-ref', '-q', 'HEAD'])])
  if (!refs.ok) throw commandFailed('git for-each-ref', refs) // i18n-ignore: a git command, as it is
  // The folder's branch by its whole ref too (`--short` is as ambiguous); 1 is a detached HEAD, anything else unknown.
  if (!sym.ok && sym.code !== 1) throw commandFailed('git symbolic-ref', sym) // i18n-ignore: a git command, as it is
  const current = sym.ok && sym.out.trim().startsWith('refs/heads/') ? sym.out.trim().slice('refs/heads/'.length) : null
  // A worktree list git couldn't give: no branch is known to be free of one, so none is offered (main checks again too).
  if (!wts.ok) throw commandFailed('git worktree list', wts) // i18n-ignore: a git command, as it is
  const worktrees = parseWorktrees(wts.out)
  const branches: GitBranchRow[] = []
  for (const line of refs.out.split('\n')) {
    const f = line.split('\0')
    if (f.length < 5 || !f[0].startsWith('refs/heads/')) continue
    const name = f[0].slice('refs/heads/'.length)
    branches.push({ name, current: name === current, upstream: null, ahead: 0, behind: 0, gone: false, worktree: worktrees.find((w) => w.branch === name)?.path ?? null, commit: f[1], date: Number(f[2]) * 1000, subject: f[3], sha: f[4] })
  }
  if (targets.target) await measure(root, targets.target, branches, [])
  return { isRepo: true, branches, target: targets.target, defaultBranch: targets.defaultBranch, uncounted: branches.filter((b) => b.toTarget == null).length }
}

/** The unmerged branches whose commits are counted, at most (a count is a git run each): the rest show as not merged. */
const COUNTED = 60

/**
 * Each branch's commits not in the target (#1642): 0 for those merged into it (one `for-each-ref --merged`), a count for
 * the first COUNTED others, null past them. Measured against the local target branch.
 */
async function measure(root: string, target: string, local: GitBranchRow[], remote: GitRemoteBranchRow[]): Promise<void> {
  const merged = await git(root, ['for-each-ref', `--merged=refs/heads/${target}`, '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  if (!merged.ok) return
  const inTarget = new Set(merged.out.split(/\r?\n/).filter(Boolean))
  const rows = [...local.map((b) => ({ ref: `refs/heads/${b.name}`, row: b as { toTarget?: number | null } })), ...remote.map((r) => ({ ref: `refs/remotes/${r.name}`, row: r as { toTarget?: number | null } }))]
  let counted = 0
  // Merged branches' counts of what they lack, apart: they never take an unmerged branch's count.
  let behindCounted = 0
  for (const { ref, row } of rows) {
    if (inTarget.has(ref)) {
      row.toTarget = 0
      // A local branch with nothing of its own may still lack the target's newest (HR4's HI-1180 round 1: a card's new line
      // behind its target): Update from <target> fast-forwards it.
      if (ref.startsWith('refs/heads/') && behindCounted++ < COUNTED) {
        const n = await git(root, ['rev-list', '--count', `${ref}..refs/heads/${target}`, '--'])
        ;(row as { fromTarget?: number | null }).fromTarget = n.ok ? Number(n.out.trim()) || 0 : null
      }
    } else if (counted++ < COUNTED) {
      // Both ways in one run: the target's commits it hasn't (HI-1180's Update from <target>), and its own.
      const n = await git(root, ['rev-list', '--left-right', '--count', `refs/heads/${target}...${ref}`, '--'])
      const [from, to] = n.ok ? n.out.trim().split(/\s+/).map(Number) : []
      row.toTarget = n.ok ? to || null : null
      if (ref.startsWith('refs/heads/')) (row as { fromTarget?: number | null }).fromTarget = n.ok && Number.isFinite(from) ? from : null
    } else row.toTarget = null
  }
}

/**
 * The branch a project's work merges into, for grouping its branches (#1642): its workflow's target (given), else the
 * repository's default branch; null when that branch doesn't exist here. And the default branch itself.
 */
async function branchTargets(root: string, workTarget?: string | null): Promise<{ target: string | null; defaultBranch: string | null }> {
  const d = await G.defaultBranch(root).catch(() => null)
  const defaultBranch = typeof d === 'string' ? d : null
  const want = workTarget || defaultBranch
  const found = want ? (await git(root, ['show-ref', '--verify', '-q', `refs/heads/${want}`])).ok : false
  return { target: found ? want : null, defaultBranch }
}

/** A project's workflow target as its options in force name it (empty: none named, the default branch). */
export async function workTargetOf(projectPath: string): Promise<string | null> {
  const ws = workspaceOf(projectPath)
  const p = ws.info()?.projects.find((x) => samePath(x.path, projectPath))
  if (p?.platform?.id !== 'git') return null
  try {
    return resolvedOf(ws, p.path, 'git', await ws.projectConfig(p.path)).options.target || null
  } catch (e) {
    log.warn(`reading ${userText(projectPath)}'s target for its branches`, e)
    return null
  }
}

/** The project folder's last commits, and its tags, newest first. */
export async function repoHistory(root: string, opts: { ref?: string | null; page?: number; workTarget?: string | null } = {}): Promise<GitHistory> {
  const summary = await repoSummary(root)
  const none: GitHistory = { commits: [], tags: [], moreTags: 0, ref: null, defaultRef: null, target: null, branches: [], remoteBranches: [], page: 1, pages: 1, total: 0 }
  if (!summary.isRepo || !summary.head) return none
  // The branches it can show (#1643), named as the repository has them: a branch asked for that isn't one shows the default.
  const refs = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  if (!refs.ok) throw commandFailed('git for-each-ref', refs) // i18n-ignore: a git command, as it is
  const branches: string[] = []
  const remoteBranches: string[] = []
  for (const r of refs.out.split(/\r?\n/).filter(Boolean)) {
    if (r.startsWith('refs/heads/')) branches.push(r.slice('refs/heads/'.length))
    else if (r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')) remoteBranches.push(r.slice('refs/remotes/'.length))
  }
  // By default the project's target (where its work goes: 1.0.0 for hive, not main), else the folder's branch.
  const target = opts.workTarget && branches.includes(opts.workTarget) ? opts.workTarget : null
  // Named whole (round 1): a local branch called origin/main never hides the remote's of that name.
  const defaultRef = target ? `refs/heads/${target}` : summary.branch ? `refs/heads/${summary.branch}` : null
  const known = (r: string): boolean => (r.startsWith('refs/heads/') && branches.includes(r.slice('refs/heads/'.length))) || (r.startsWith('refs/remotes/') && remoteBranches.includes(r.slice('refs/remotes/'.length)))
  const ref = opts.ref && known(opts.ref) ? opts.ref : defaultRef
  const spec = ref ?? 'HEAD'
  const count = await git(root, ['rev-list', '--count', spec, '--'])
  if (!count.ok) throw commandFailed('git rev-list', count) // i18n-ignore: a git command, as it is
  const total = Number(count.out.trim()) || 0
  const pages = Math.max(1, Math.ceil(total / HISTORY_COMMITS))
  const page = Math.min(pages, Math.max(1, Math.floor(Number(opts.page) || 1)))
  const [log_, tags] = await Promise.all([
    git(root, ['log', '-n', String(HISTORY_COMMITS), '--skip', String((page - 1) * HISTORY_COMMITS), '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e', spec, '--']),
    git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%00%(objecttype)%00%(*objectname:short)%00%(objectname:short)%00%(creatordate:unix)%00%(contents:subject)%00%(*subject)', 'refs/tags'])
  ])
  if (!log_.ok) throw commandFailed('git log', log_) // i18n-ignore: a git command, as it is
  if (!tags.ok) throw commandFailed('git for-each-ref', tags) // i18n-ignore: a git command, as it is
  const commits = log_.out
    .split('\x1e')
    .map((r) => r.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const f = r.split('\0')
      return { hash: f[0], short: f[1], author: f[2], email: f[3], date: Number(f[4]) * 1000, refs: f[5] ? f[5].split(', ').filter(Boolean) : [], subject: f[6] ?? '' }
    })
  const all = tags.out
    .split('\n')
    .map((l) => l.split('\0'))
    .filter((f) => f.length >= 7 && f[0])
    .map((f) => {
      const annotated = f[1] === 'tag'
      return { name: f[0], commit: annotated ? f[2] : f[3], date: Number(f[4]) * 1000, subject: (annotated ? f[5] : f[5] || f[6]) ?? '', annotated }
    })
  const byName = (a: string, b: string): number => a.localeCompare(b, 'en')
  return { commits, tags: all.slice(0, HISTORY_TAGS), moreTags: Math.max(0, all.length - HISTORY_TAGS), ref, defaultRef, target, branches: branches.sort(byName), remoteBranches: remoteBranches.sort(byName), page, pages, total }
}

// ---------------------------------------------------------------------------
// The user's actions
// ---------------------------------------------------------------------------

/** One action at a time per project folder (a second click, or another window). */
const running = new Map<string, Promise<unknown>>()

export function oneAtATime<T>(projectPath: string, fn: () => Promise<T>, urls: string[] = []): Promise<T> {
  const key = projectPath.toLowerCase()
  const prev = running.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn).catch(async (e: unknown) => {
    throw await scrubbed(projectPath, e, urls)
  })
  const tail = run.catch(() => undefined)
  running.set(key, tail)
  void tail.then(() => running.get(key) === tail && running.delete(key))
  return run
}

/**
 * An action's failure without any secret of the repository's remote URLs (and of `urls`, one being added), however the
 * message quotes them: `gitSays` hides what looks like a URL's password or query, and this the exact parts of every
 * configured one (`urlSecrets`), in case git quoted one some other way. The message reaches the window and the log.
 */
async function scrubbed(projectPath: string, e: unknown, urls: string[]): Promise<unknown> {
  if (!(e instanceof Error)) return e
  const r = await git(projectPath, ['config', '--get-regexp', String.raw`^remote\..*\.(push)?url$`])
  const configured = r.ok ? r.out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(l.indexOf(' ') + 1)) : []
  const secrets = [...new Set([...configured, ...urls].flatMap(urlSecrets))].sort((a, b) => b.length - a.length)
  // A HiveError's text is cleaned part by part (git's words are values), so the window's language never brings one back.
  if (e instanceof HiveError) {
    const text = scrubText(e.text, secrets) as Text
    // agent-protocol: the same error's text with its secrets cleaned out: its messages are found where it was thrown
    return JSON.stringify(text) === JSON.stringify(e.text) ? e : new HiveError(text, e.kind ? { kind: e.kind } : undefined)
  }
  const message = scrubSecrets(e.message, secrets)
  return message === e.message ? e : new Error(message)
}

/** Text with every part of its own (git's words, a URL) cleaned of `secrets`; messages and numbers as they are. */
function scrubText(t: TextPart, secrets: string[]): TextPart {
  if (typeof t === 'string') return scrubSecrets(t, secrets)
  if (typeof t === 'number' || 'id' in t) return t
  if ('list' in t) return { ...t, list: t.list.map((x) => scrubText(x, secrets)) }
  if ('lines' in t) return { lines: t.lines.map((x) => scrubText(x, secrets)) }
  if ('cap' in t) return { cap: scrubText(t.cap, secrets) }
  if ('shown' in t) return 'agent' in t ? { shown: scrubText(t.shown, secrets), agent: scrubText(t.agent, secrets) } : { shown: scrubText(t.shown, secrets), english: scrubSecrets(t.english, secrets) }
  const values = t.values && Object.fromEntries(Object.entries(t.values).map(([k, v]) => [k, scrubText(v, secrets)]))
  if ('said' in t) return values ? { said: t.said, values } : { said: t.said }
  return { m: t.m, values: values! }
}

/**
 * The project's agents working in its folder now (#1451: their current folder, `currentFolder`: a running session's, else
 * where a new conversation would start), with their sessions' status. One with input of Hive's still on its way (#646
 * round 1: a prompt or launch task given and not taken yet, or a line typed and not taken) counts as working: its CLI may
 * start that turn any moment, and the folder's fence can't take back what is in its input.
 */
async function folderAgents(projectPath: string, folder = projectPath): Promise<{ name: string; status: string | null }[]> {
  const cfg = await workspace.projectConfig(projectPath)
  const facts = await folderFacts(projectPath)
  const here: AgentDef[] = []
  for (const a of projectAgents(cfg)) {
    const live = sessions.liveFor(projectPath, a.id)
    if (samePlace((await agentPlace(projectPath, a, live ? { cwd: live.cwd } : null, facts)).now.path, folder)) here.push(a)
  }
  return here
    .map((a) => {
      const status = sessions.liveFor(projectPath, a.id)?.status ?? null
      const pending = !!status && (!!sessions.agentNow(projectPath, a.id)?.pending || sessions.lineWaiting(projectPath, a.id))
      return { name: a.name, status: pending ? 'working' : status }
    })
}

function folderSlots(projectPath: string): FolderSlot[] {
  return mergeSlots
    .list(projectPath)
    .filter((s) => samePath(s.project, projectPath))
    .map((s) => ({ branch: s.branch, holder: s.holder && s.holder.kind !== 'user' ? s.holder.name : null, ...(s.holder?.kind === 'user' ? { byUser: true } : {}), waiting: s.waiting.map((w) => w.name) }))
}

/**
 * Switching branch or pulling moves the ground under the agents working in the folder and under a merge into its
 * branch: refused while one works there or the merge slot is held or waited for, saying why. The change itself runs
 * holding the slot of the branch it leaves and the repository lock (repoLock.ts, across Hives), so a merge can't start in the middle. An agent may
 * start working while it waits for them, so it is checked again once they are held, right before git runs (nothing is
 * awaited between that check and starting git).
 */
async function changeFolder<T>(projectPath: string, action: GitFolderAction, branch: string | null, fn: () => Promise<T>): Promise<T> {
  const why = folderBusyData(await folderAgents(projectPath), folderSlots(projectPath), action)
  if (why) throw new HiveError(why)
  const locked = (): Promise<T> =>
    withRepoLock(projectPath, () =>
      // The folder is fenced from here to git's end (#646): no line of Hive's is typed into its agents and none starts
      // there meanwhile, so no turn of Hive's begins between this last check and git changing the files.
      // i18n-ignore: what changes the folder, for the log and an agent's reply (agent-facing, English)
      changingFolder(projectPath, `a Git ${action}`, async () => {
        // The slot is this action's own now (asUser refuses when anyone else holds or waits for it); without a branch to
        // hold it for (a detached HEAD), the slots are checked again too.
        const now = folderBusyData(await folderAgents(projectPath), branch ? [] : folderSlots(projectPath), action)
        if (now) throw new HiveError(now)
        return fn()
      }), { project: projectPath }
    )
  return branch ? mergeSlots.asUser(projectPath, branch, locked) : locked()
}

/** After the folder's branch or commit changed: the window's project info, and worktree agents' unmerged counts. */
async function changed(projectPath: string): Promise<void> {
  await workspaceOf(projectPath).refresh().catch((e) => log.warn('refreshing after a git change', e))
  void checkProject(projectPath)
}

async function summaryOf(projectPath: string): Promise<GitRepoSummary> {
  const s = await repoSummary(projectPath)
  // Git's problem as data; else (it changed meanwhile) the summary's English as it is.
  // agent-text: gitProblemData
  if (s.gitProblem) throw new HiveError(gitProblemData(gitTool()) ?? linesOf([s.gitProblem]))
  if (!s.isRepo) throw refusal(msg({ id: 'service.gitRepo.notRepo', defaultMessage: "{folder} isn't a git repository.", description: 'An error in the Git view: the project folder {folder} is not in a git repository.' }), { folder: projectPath })
  const parent = parentRepoData(s)
  if (parent) throw new HiveError(parent)
  return s
}

async function refFormatOk(projectPath: string, args: string[]): Promise<boolean> {
  return (await git(projectPath, ['check-ref-format', ...args])).ok
}

/** Switches the project folder to a local branch, or to a remote one (origin/x) as a new local branch tracking it. */
export async function switchBranch(projectPath: string, target: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (target === s.branch) return tr(msg({ id: 'service.gitRepo.alreadyOn', defaultMessage: 'Already on {branch}.', description: 'After switching branch in the Git view: the project folder was on {branch} already.' }), { branch: target })
    const info = await repoInfo(projectPath)
    const local = info.branches.find((b) => b.name === target) ?? ((await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${target}`])).ok ? { worktree: null } : null)
    const remote = !local && info.remoteBranches.includes(target)
    if (!local && !remote) throw refusal(M.noBranch, { branch: target })
    if (local?.worktree) throw refusal(msg({ id: 'service.gitRepo.inWorktree', defaultMessage: '{branch} is checked out in another worktree ({folder}): a branch can be in only one folder at a time.', description: 'An error switching branch in the Git view: the branch {branch} is checked out in the worktree {folder}.' }), { branch: target, folder: local.worktree })
    const r = await changeFolder(projectPath, 'switch', s.branch, () => git(projectPath, local ? ['checkout', '-q', target, '--'] : ['checkout', '-q', '--track', target, '--']))
    if (!r.ok) throw failed(M.switchFailed, { branch: target }, r)
    log.info(`Switched ${userText(projectPath)} to ${userText(target)}`)
    await changed(projectPath)
    return local
      ? tr(msg({ id: 'service.gitRepo.switched', defaultMessage: 'Switched to {branch}.', description: 'After switching branch in the Git view: the project folder is on {branch} now.' }), { branch: target })
      : tr(msg({ id: 'service.gitRepo.switchedTracking', defaultMessage: 'Switched to {branch}, tracking {remote}.', description: 'After switching to a remote branch in the Git view: a new local branch {branch} was made, following the remote branch {remote} (origin/x).' }), { branch: target.slice(target.indexOf('/') + 1), remote: target })
  })
}

/** Creates a branch at the folder's commit, switching to it unless `stay`. */
export async function createBranch(projectPath: string, name: string, stay = false): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!name || name.startsWith('-') || !(await refFormatOk(projectPath, ['--branch', name]))) throw refusal(M.badName, { kind: 'branch', hasName: name ? 'yes' : 'no', name })
    if (!s.head) throw refusal(M.noCommits)
    if (stay) {
      const r = await git(projectPath, ['branch', '--no-track', name])
      if (!r.ok) throw failed(M.createFailed, { name }, r)
      log.info(`Created branch ${userText(name)} in ${userText(projectPath)}`)
      return tr(msg({ id: 'service.gitRepo.createdAt', defaultMessage: 'Created {name} at {commit}.', description: 'After creating a branch in the Git view without switching to it: {name} starts at the commit {commit} (a short hash).' }), { name, commit: s.head })
    }
    const r = await changeFolder(projectPath, 'create', s.branch, () => git(projectPath, ['checkout', '-q', '--no-track', '-b', name, '--']))
    if (!r.ok) throw failed(M.createFailed, { name }, r)
    log.info(`Created and switched to ${userText(name)} in ${userText(projectPath)}`)
    await changed(projectPath)
    return tr(msg({ id: 'service.gitRepo.createdSwitched', defaultMessage: 'Created {name} and switched to it.', description: 'After creating a branch in the Git view: the project folder is on the new branch {name}.' }), { name })
  })
}

export async function addRemote(projectPath: string, name: string, url: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  url = url.trim()
  const problem = remoteNameProblemData(name) ?? remoteUrlProblemData(url)
  if (problem) throw new HiveError(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    const r = await git(projectPath, ['remote', 'add', '--', name, url])
    if (!r.ok) throw failed(msg({ id: 'service.gitRepo.addFailed', defaultMessage: "Couldn't add {remote}: {why}", description: "An error adding the remote {remote} in the Git view; {why} is git's own words." }), { remote: name }, r)
    log.info(`Added remote ${userText(name)} to ${userText(projectPath)}`)
    return tr(msg({ id: 'service.gitRepo.added', defaultMessage: 'Added {remote}.', description: 'After adding a remote in the Git view: {remote} is its name.' }), { remote: name })
  }, [url])
}

/** Changes a remote's URL (its fetch URL, and its push URL unless that is set separately). */
export async function setRemoteUrl(projectPath: string, name: string, url: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  url = url.trim()
  const problem = remoteUrlProblemData(url)
  if (problem) throw new HiveError(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    const r = await git(projectPath, ['remote', 'set-url', '--', name, url])
    if (!r.ok) throw failed(msg({ id: 'service.gitRepo.urlFailed', defaultMessage: "Couldn't change {remote}'s URL: {why}", description: "An error changing the address of the remote {remote} in the Git view; {why} is git's own words." }), { remote: name }, r)
    log.info(`Changed remote ${userText(name)}'s URL in ${userText(projectPath)}`)
    return tr(msg({ id: 'service.gitRepo.urlChanged', defaultMessage: "Changed {remote}'s URL.", description: 'After changing the address of the remote {remote} in the Git view.' }), { remote: name })
  }, [url])
}

/** Fetches every remote: the only way ahead/behind changes (Hive never fetches by itself). */
export async function fetchAll(projectPath: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.remotes.length) throw refusal(msg({ id: 'service.gitRepo.noRemotesFetch', defaultMessage: 'This repository has no remotes to fetch from: add one first.', description: 'An error fetching in the Git view: the repository has no remote.' }))
    const r = await net(projectPath, ['fetch', '--all'])
    if (!r.ok) throw failed(M.fetchFailed, {}, r)
    log.info(`Fetched ${userText(projectPath)}`)
    void checkProject(projectPath)
    return tr(msg({ id: 'service.gitRepo.fetched', defaultMessage: 'Fetched {remotes}.', description: "After fetching in the Git view: {remotes} lists the remotes fetched from (their names), in the language's way." }), { remotes: fmt.list(s.remotes) })
  })
}

/**
 * Fetches the branch's upstream, then brings the branch up to it only when that needs no merge (fast-forward): a
 * branch that has diverged is left as it is, with what to do.
 */
export async function pull(projectPath: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.branch) throw refusal(msg({ id: 'service.gitRepo.detachedPull', defaultMessage: 'HEAD is detached: switch to a branch to pull.', description: 'An error pulling in the Git view: the project folder is on no branch (a detached HEAD: keep HEAD as it is).' }))
    if (!s.upstream) throw refusal(msg({ id: 'service.gitRepo.noUpstream', defaultMessage: '{branch} tracks no remote branch: push it first, or switch to one that does.', description: 'An error pulling in the Git view: the branch {branch} follows no remote branch.' }), { branch: s.branch })
    if (s.state) throw refusal(msg({ id: 'service.gitRepo.midOperation', defaultMessage: 'Git is in the middle of a {state}: finish or abort it first.', description: "An error pulling in the Git view: a git operation is under way in the project folder; {state} is git's word for it (merge, rebase, cherry-pick, revert or bisect: keep it as it is)." }), { state: s.state })
    // Refused before the fetch too, so a pull that can't go ahead doesn't wait on the network first.
    const why = folderBusyData(await folderAgents(projectPath), folderSlots(projectPath), 'pull')
    if (why) throw new HiveError(why)
    if (s.upstream.remote) {
      const f = await net(projectPath, ['fetch', '--', s.upstream.remote])
      if (!f.ok) throw failed(M.fetchFailed, {}, f)
    }
    const now = await summaryOf(projectPath)
    const u = now.upstream
    if (!u || u.gone) throw refusal(msg({ id: 'service.gitRepo.upstreamGone', defaultMessage: '{upstream} is gone from the remote.', description: 'An error pulling in the Git view: the remote branch {upstream} the branch follows was deleted there.' }), { upstream: s.upstream.name })
    if (u.behind === 0) return tr(msg({ id: 'service.gitRepo.upToDate', defaultMessage: '{branch} is up to date with {upstream}.', description: 'After pulling in the Git view: the branch {branch} has every commit of the remote branch {upstream} already.' }), { branch: now.branch ?? '', upstream: u.name })
    if (u.ahead > 0) throw refusal(msg({ id: 'service.gitRepo.diverged', defaultMessage: '{branch} and {upstream} have diverged ({ahead, plural, one {# commit} other {# commits}} here, {behind, number} there), so pulling needs a merge or rebase. Do that in a terminal, or ask an agent to.', description: 'An error pulling in the Git view: the branch {branch} has {ahead} commits the remote branch {upstream} hasn\'t, and it has {behind} the branch hasn\'t; Hive pulls only when no merge is needed.' }), { branch: now.branch ?? '', upstream: u.name, ahead: u.ahead, behind: u.behind })
    const r = await changeFolder(projectPath, 'pull', now.branch, () => git(projectPath, ['merge', '--ff-only', '@{upstream}']))
    if (!r.ok) throw failed(msg({ id: 'service.gitRepo.pullFailed', defaultMessage: "Couldn't pull: {why}", description: "An error pulling in the Git view; {why} is git's own words." }), {}, r)
    log.info(`Pulled ${userText(projectPath)}`)
    await changed(projectPath)
    return tr(msg({ id: 'service.gitRepo.pulled', defaultMessage: 'Pulled {n, plural, one {# commit} other {# commits}} from {upstream}.', description: 'After pulling in the Git view: {n} commits came from the remote branch {upstream}.' }), { n: u.behind, upstream: u.name })
  })
}

/** A push's refusal, naming the branch: Hive never forces, so the user pulls or merges first. */
const rejected = (to: string, branch: string): HiveError => refusal(msg({ id: 'service.gitRepo.rejected', defaultMessage: "{to} has commits {branch} hasn't, so the push was refused (Combwork never forces a push). Pull first, or merge them in a terminal.", description: "An error pushing the branch {branch} in the Git view: the remote branch {to} has commits it hasn't, so the remote refused." }), { to, branch })

/** Pushes the branch to its upstream, or to `remote` (setting it as the upstream) when it has none. Never forced. */
export async function push(projectPath: string, remote?: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.branch) throw refusal(M.detachedPush)
    if (!s.head) throw refusal(M.nothingToPush)
    let args: string[]
    let to: string
    if (s.upstream?.remote && !s.upstream.gone && !remote) {
      const merge = (await git(projectPath, ['config', '--get', `branch.${s.branch}.merge`])).out.trim()
      const dest = merge.startsWith('refs/heads/') ? merge : `refs/heads/${s.branch}`
      args = ['push', '--', s.upstream.remote, `refs/heads/${s.branch}:${dest}`]
      to = s.upstream.name
    } else {
      const r = remote ?? (s.remotes.length === 1 ? s.remotes[0] : s.remotes.includes('origin') ? 'origin' : null)
      if (!r) throw s.remotes.length ? refusal(msg({ id: 'service.gitRepo.chooseRemote', defaultMessage: 'Choose the remote to push to.', description: 'An error pushing in the Git view: the repository has several remotes and none was chosen.' })) : refusal(msg({ id: 'service.gitRepo.noRemotes', defaultMessage: 'This repository has no remotes: add one first.', description: 'An error pushing in the Git view: the repository has no remote.' }))
      if (!s.remotes.includes(r)) throw refusal(M.noRemote, { remote: r })
      args = ['push', '--set-upstream', '--', r, `refs/heads/${s.branch}:refs/heads/${s.branch}`]
      to = `${r}/${s.branch}`
    }
    const r = await net(projectPath, args)
    if (!r.ok) {
      if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.err)) throw rejected(to, s.branch)
      throw failed(M.pushFailed, { to }, r)
    }
    log.info(`Pushed ${userText(projectPath)} to ${userText(to)}`)
    void checkProject(projectPath)
    return tr(M.pushed, { branch: s.branch, to })
  })
}

/**
 * Push to… (#1385): the branch checked out, or every branch and then every tag, to any remote, never changing what a
 * branch tracks (no --set-upstream) and never forced. Each ref's outcome is read from git's porcelain output: with all
 * branches, one the remote refuses is named with the others' counts, as a failure.
 */
export async function pushToRemote(projectPath: string, remote: string, scope: PushScope, branch?: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.remotes.includes(remote)) throw refusal(M.noRemote, { remote })
    if (!s.head) throw refusal(M.nothingToPush)
    if (scope === 'branch') {
      // The branch the user confirmed, by name (HR5's #1385 round 1): never whichever is checked out by the time it runs.
      const b = branch ?? s.branch
      if (!b) throw refusal(M.detachedPush)
      if (b.startsWith('-') || !(await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${b}`])).ok) throw refusal(M.noBranch, { branch: b })
      const to = `${remote}/${b}`
      const r = await net(projectPath, ['push', '--porcelain', '--', remote, `refs/heads/${b}:refs/heads/${b}`])
      const ref = parsePushPorcelain(r.out).find((x) => x.kind === 'branch' && x.name === b)
      if (ref?.result === 'refused') throw rejected(to, b)
      if (!r.ok) throw failed(M.pushFailed, { to }, r)
      log.info(`Pushed ${userText(projectPath)}'s ${userText(b)} to ${userText(remote)}`)
      void checkProject(projectPath)
      return ref?.result === 'upToDate' ? tr(msg({ id: 'service.gitRepo.pushUpToDate', defaultMessage: '{to} already has {branch}: nothing to push.', description: 'After Push to… in the Git view: the remote branch {to} already had every commit of the branch {branch}.' }), { to, branch: b }) : tr(M.pushed, { branch: b, to })
    }
    const refs: PushedRef[] = []
    for (const what of ['--all', '--tags']) {
      const r = await net(projectPath, ['push', '--porcelain', what, '--', remote])
      const got = parsePushPorcelain(r.out)
      // A refusal is the remote's answer about a ref, counted below; any other failure (no answer, a sign-in) is git's.
      if (!r.ok && !got.some((x) => x.result === 'refused')) throw failed(M.pushFailed, { to: remote }, r)
      refs.push(...got)
    }
    log.info(`Pushed every branch and tag of ${userText(projectPath)} to ${userText(remote)}`)
    void checkProject(projectPath)
    const refused = refs.filter((x) => x.result === 'refused')
    const lines = [withValues(refused.length ? M.pushAllRefused : M.pushedAll, { remote, n: refused.length }), ...pushOutcomes(refs)]
    if (refused.length) throw new HiveError(linesOf(lines))
    return shownText(linesOf(lines))
  })
}

/**
 * All branches and tags' outcomes (#1385, HR5's round 1: each branch by name), a line each: the branches pushed, those
 * already up to date, the refs refused (branches and tags), the tags pushed, every one by name (HR5's round 2: none left out). Tags already
 * there aren't listed.
 */
function pushOutcomes(refs: PushedRef[]): Text[] {
  const names = (list: PushedRef[]): Text => listOf([...list].sort((a, b) => a.name.localeCompare(b.name, 'en')).map((x) => x.name), 'unit')
  const out: Text[] = []
  const branches = refs.filter((x) => x.kind === 'branch')
  for (const result of ['pushed', 'upToDate'] as const) {
    const list = branches.filter((x) => x.result === result)
    if (list.length) out.push(withValues(M.pushOutcome, { result, refs: names(list) }))
  }
  const refused = refs.filter((x) => x.result === 'refused')
  if (refused.length) out.push(withValues(M.pushOutcome, { result: 'refused', refs: names(refused) }))
  const tags = refs.filter((x) => x.kind === 'tag' && x.result === 'pushed')
  if (tags.length) out.push(withValues(M.pushOutcome, { result: 'tags', refs: names(tags) }))
  return out
}

/**
 * The local branches tracking a remote's branches, by name, all of them (#1385, HR5's round 1: never the view's capped
 * list): what Remove's confirmation lists.
 */
export async function remoteTracking(projectPath: string, remote: string): Promise<string[]> {
  projectPath = workspace.assertProject(projectPath)
  return trackingRemote(projectPath, remote)
}

async function trackingRemote(projectPath: string, remote: string): Promise<string[]> {
  // By whole refs: `refname:short` says heads/x beside a tag x (HI-2426).
  const r = await git(projectPath, ['for-each-ref', '--format=%(refname)%00%(upstream:remotename)', 'refs/heads'])
  if (!r.ok) throw commandFailed('git for-each-ref', r) // i18n-ignore: a git command, as it is
  return r.out.split(/\r?\n/).map((l) => l.split('\0')).filter((f) => f[1] === remote).map((f) => branchOfRef(f[0])).filter((b): b is string => !!b)
}

/**
 * Removes a remote (#1385, `git remote remove`): its remote-tracking branches and the upstream of every local branch
 * tracking it go with it. Nothing on the remote server changes. `expected`, the branches the user was shown: refused when
 * those tracking it now differ (one started or stopped tracking it meanwhile).
 */
export async function removeRemote(projectPath: string, name: string, expected?: string[]): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.remotes.includes(name)) throw refusal(M.noRemote, { remote: name })
    const branches = await trackingRemote(projectPath, name)
    if (expected && (expected.length !== branches.length || branches.some((b) => !expected.includes(b)))) throw refusal(M.remoteTrackingChanged, { remote: name })
    const r = await git(projectPath, ['remote', 'remove', '--', name])
    if (!r.ok) throw failed(msg({ id: 'service.gitRepo.removeRemoteFailed', defaultMessage: "Couldn't remove {remote}: {why}", description: "An error removing the remote {remote} in the Git view; {why} is git's own words." }), { remote: name }, r)
    log.info(`Removed remote ${userText(name)} from ${userText(projectPath)}`)
    void checkProject(projectPath)
    return tr(msg({ id: 'service.gitRepo.remoteRemoved', defaultMessage: '{n, plural, =0 {Removed {remote}.} one {Removed {remote}: {branches} no longer tracks a remote branch.} other {Removed {remote}: {branches} no longer track a remote branch.}}', description: 'After removing the remote {remote} in the Git view. {branches} lists the local branches that tracked it ({n} of them).' }), { remote: name, n: branches.length, branches: fmt.list(branches, 'unit') })
  })
}

/** Renames a remote (#1385, `git remote rename`): the branches tracking it follow it. A name taken or invalid is refused. */
export async function renameRemote(projectPath: string, from: string, to: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  to = to.trim()
  const problem = remoteNameProblemData(to)
  if (problem) throw new HiveError(problem)
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.remotes.includes(from)) throw refusal(M.noRemote, { remote: from })
    if (to === from) return tr(msg({ id: 'service.gitRepo.remoteSameName', defaultMessage: '{remote} keeps its name.', description: 'After Rename in the Git view, when the remote {remote} was given its own name.' }), { remote: from })
    // Remote-tracking branches are files under refs/remotes: on Windows two names differing only in case are one folder.
    if (s.remotes.some((x) => x !== from && x.toLowerCase() === to.toLowerCase())) throw refusal(msg({ id: 'service.gitRepo.remoteTaken', defaultMessage: 'There is a remote called {remote} already.', description: 'An error renaming a remote in the Git view: another remote has that name ({remote}).' }), { remote: to })
    const branches = await trackingRemote(projectPath, from)
    const r = await git(projectPath, ['remote', 'rename', '--', from, to])
    if (!r.ok) throw failed(msg({ id: 'service.gitRepo.renameRemoteFailed', defaultMessage: "Couldn't rename {remote}: {why}", description: "An error renaming the remote {remote} in the Git view; {why} is git's own words." }), { remote: from }, r)
    log.info(`Renamed remote ${userText(from)} to ${userText(to)} in ${userText(projectPath)}`)
    void checkProject(projectPath)
    return tr(msg({ id: 'service.gitRepo.remoteRenamed', defaultMessage: '{n, plural, =0 {Renamed {from} to {to}.} one {Renamed {from} to {to}: {branches} tracks it by its new name.} other {Renamed {from} to {to}: {branches} track it by its new name.}}', description: 'After renaming a remote in the Git view from {from} to {to}. {branches} lists the local branches tracking it ({n} of them), which follow the rename.' }), { from, to, n: branches.length, branches: fmt.list(branches, 'unit') })
  })
}

/**
 * Changes what a local branch tracks (#1385): `remote`'s `remoteBranch` (`git branch --set-upstream-to`), or nothing
 * (`remote` null: `--unset-upstream`). A remote branch not there yet (as of the last fetch) is refused unless `pushFirst`:
 * then the branch is pushed there first (never forced), which makes it.
 */
export async function setUpstream(projectPath: string, branch: string, remote: string | null, remoteBranch = '', pushFirst = false): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  remoteBranch = remoteBranch.trim()
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!branch || branch.startsWith('-') || !(await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${branch}`])).ok) throw refusal(M.noBranch, { branch })
    const up = await git(projectPath, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`])
    if (!up.ok) throw commandFailed('git for-each-ref', up) // i18n-ignore: a git command, as it is
    const was = up.out.trim() && upstreamName(up.out)
    if (remote === null) {
      if (!was) return tr(msg({ id: 'service.gitRepo.trackedNothing', defaultMessage: '{branch} tracks no remote branch already.', description: 'After Stop tracking in the Git view, when the branch {branch} tracked nothing.' }), { branch })
      const r = await git(projectPath, ['branch', '--unset-upstream', '--', branch])
      if (!r.ok) throw commandFailed('git branch --unset-upstream', r) // i18n-ignore: a git command, as it is
      log.info(`${userText(branch)} of ${userText(projectPath)} no longer tracks ${userText(was)}`)
      void checkProject(projectPath)
      return tr(msg({ id: 'service.gitRepo.untracked', defaultMessage: '{branch} no longer tracks {upstream}.', description: 'After Stop tracking in the Git view: the branch {branch} no longer follows the remote branch {upstream}.' }), { branch, upstream: was })
    }
    if (!s.remotes.includes(remote)) throw refusal(M.noRemote, { remote })
    if (!remoteBranch || remoteBranch.startsWith('-') || !(await refFormatOk(projectPath, ['--branch', remoteBranch]))) throw refusal(M.badName, { kind: 'branch', hasName: remoteBranch ? 'yes' : 'no', name: remoteBranch })
    const upstream = `${remote}/${remoteBranch}`
    const there = async (): Promise<boolean> => (await git(projectPath, ['show-ref', '--verify', '-q', `refs/remotes/${remote}/${remoteBranch}`])).ok
    let pushed = false
    if (!(await there())) {
      if (!pushFirst) throw refusal(M.notOnRemote, { remote, branch: remoteBranch })
      const r = await net(projectPath, ['push', '--porcelain', '--', remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`])
      if (parsePushPorcelain(r.out).some((x) => x.result === 'refused')) throw rejected(upstream, branch)
      if (!r.ok) throw failed(M.pushFailed, { to: upstream }, r)
      // A remote whose fetch settings don't map its branches here: read it once, so the branch can track it.
      if (!(await there())) await net(projectPath, ['fetch', '--', remote])
      if (!(await there())) throw refusal(M.notOnRemote, { remote, branch: remoteBranch })
      pushed = true
    }
    const r = await git(projectPath, ['branch', `--set-upstream-to=${upstream}`, '--', branch])
    if (!r.ok) throw commandFailed('git branch --set-upstream-to', r) // i18n-ignore: a git command, as it is
    log.info(`${userText(branch)} of ${userText(projectPath)} tracks ${userText(upstream)}${pushed ? ' (pushed first)' : ''}`)
    void checkProject(projectPath)
    return tr(msg({ id: 'service.gitRepo.tracking', defaultMessage: '{pushed, select, yes {Pushed {branch} to {upstream}, and it tracks it now.} other {{branch} tracks {upstream} now.}}', description: 'After Track… in the Git view: the branch {branch} follows the remote branch {upstream} (pushed there first when {pushed} is yes).' }), { branch, upstream, pushed: pushed ? 'yes' : 'no' })
  })
}

/** Tags the folder's commit: annotated when there's a message. Pushes the tag to `pushTo` when given. */
export async function createTag(projectPath: string, name: string, message: string, pushTo?: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  message = message.trim()
  return oneAtATime(projectPath, async () => {
    const s = await summaryOf(projectPath)
    if (!s.head) throw refusal(msg({ id: 'service.gitRepo.nothingToTag', defaultMessage: 'The repository has no commits yet: nothing to tag.', description: 'An error tagging in the Git view: the repository has no commit yet.' }))
    if (!name || name.startsWith('-') || !(await refFormatOk(projectPath, [`refs/tags/${name}`]))) throw refusal(M.badName, { kind: 'tag', hasName: name ? 'yes' : 'no', name })
    if (pushTo && !s.remotes.includes(pushTo)) throw refusal(M.noRemote, { remote: pushTo })
    const r = await git(projectPath, message ? ['tag', '-a', '-m', message, name, 'HEAD'] : ['tag', name, 'HEAD'])
    if (!r.ok) throw failed(M.createFailed, { name }, r)
    log.info(`Tagged ${userText(projectPath)} ${userText(name)}`)
    if (!pushTo) return tr(msg({ id: 'service.gitRepo.tagged', defaultMessage: 'Tagged {commit} {name}.', description: 'After tagging in the Git view: the commit {commit} (a short hash) has the tag {name}.' }), { commit: s.head, name })
    const p = await net(projectPath, ['push', '--', pushTo, `refs/tags/${name}:refs/tags/${name}`])
    if (!p.ok) throw failed(msg({ id: 'service.gitRepo.tagPushFailed', defaultMessage: "Tagged {commit} {name}, but couldn't push it to {remote}: {why}", description: "An error in the Git view: the commit {commit} was tagged {name}, but pushing the tag to the remote {remote} failed; {why} is git's own words." }), { commit: s.head, name, remote: pushTo }, p)
    return tr(msg({ id: 'service.gitRepo.taggedPushed', defaultMessage: 'Tagged {commit} {name} and pushed it to {remote}.', description: 'After tagging in the Git view: the commit {commit} has the tag {name}, which went to the remote {remote} too.' }), { commit: s.head, name, remote: pushTo })
  })
}

/** Sets this repository's own commit name and email (`git config --local`); an empty one is removed, so the global one applies. */
export async function setIdentity(projectPath: string, name: string, email: string): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  name = name.trim()
  email = email.trim()
  const problem = identityProblemData(name, email)
  if (problem) throw new HiveError(problem)
  return oneAtATime(projectPath, async () => {
    await summaryOf(projectPath)
    for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
      const r = value ? await git(projectPath, ['config', '--local', key, value]) : await git(projectPath, ['config', '--local', '--unset-all', key])
      // --unset-all says 5 when there was none to remove.
      if (!r.ok && !(r.code === 5 && !value)) throw failed(msg({ id: 'service.gitRepo.setFailed', defaultMessage: "Couldn't set {key}: {why}", description: "An error setting the repository's commit identity in the Git view: the git setting {key} (user.name or user.email: keep it) couldn't be set; {why} is git's own words." }), { key }, r)
    }
    log.info(`Set the commit identity of ${userText(projectPath)}`)
    return name || email
      ? tr(msg({ id: 'service.gitRepo.identitySet', defaultMessage: "Set this repository's commit identity.", description: "After setting the repository's own commit name and email in the Git view." }))
      : tr(msg({ id: 'service.gitRepo.identityRemoved', defaultMessage: "Removed this repository's own identity: your global one applies.", description: "After clearing the repository's own commit name and email in the Git view: git uses the user's global ones." }))
  })
}

// ---------------------------------------------------------------------------
// Branches cleaned up (#1642)
// ---------------------------------------------------------------------------

const B = {
  noTarget: msg({ id: 'service.gitRepo.noTarget', defaultMessage: "There's no branch {target} here to check the branches against.", description: "An error deleting branches in Version Control → Branches & remotes: the branch the project's work merges into ({target}; the default branch when none is set) isn't in the repository, so Hive can't tell which branches are merged." }),
  kept: msg({ id: 'service.gitRepo.branchKept', defaultMessage: "{why, select, target {{branch} is the branch work merges into: kept.} default {{branch} is the default branch: kept.} current {{branch} is checked out in the project folder: kept.} worktree {{branch} is checked out in a worktree or slot: kept.} card {An open card works on {branch}: kept.} remoteHead {{branch} is the remote's default branch: kept.} moved {{branch} has moved since you were shown it: kept. Look at it again.} unmerged {{branch} has commits that aren't in {target}: kept.} gone {There's no branch {branch}.} other {{branch} isn't a valid branch name.}}", description: "Why a branch wasn't deleted (Clean Up Merged Branches, Delete branch…, in Version Control → Branches & remotes). {branch} is its name, {target} the branch the project's work merges into. Keep the select keys." }),
  deleteFailed: msg({ id: 'service.gitRepo.deleteBranchFailed', defaultMessage: "Couldn't delete {branch}: {why}", description: "An error deleting the branch {branch} in Version Control → Branches & remotes; {why} is git's own words." }),
  deleted: msg({ id: 'service.gitRepo.branchesDeleted', defaultMessage: '{n, plural, one {Deleted {branches}.} other {Deleted # branches: {branches}.}}', description: 'After deleting branches in Version Control → Branches & remotes: {branches} lists them ({n}).' }),
  remoteDeleted: msg({ id: 'service.gitRepo.remoteBranchesDeleted', defaultMessage: '{n, plural, one {Deleted {branches} on {remote}.} other {Deleted # branches on {remote}: {branches}.}}', description: 'After deleting branches on the remote {remote} (Clean Up Merged Branches): {branches} lists them ({n}).' }),
  remoteRefused: msg({ id: 'service.gitRepo.remoteDeleteRefused', defaultMessage: "{remote} refused to delete {branches}: it has commits there you haven't fetched, or it doesn't allow deleting them.", description: 'After deleting branches on the remote {remote}: it refused those listed in {branches} (Hive deletes a remote branch only at the commit you were shown).' })
}

/** The branches of open cards (any but Done) on the board, any project's (#1642): never deleted. */
function cardLines(projectPath: string): Set<string> {
  const ws = workspaceOf(projectPath)
  if (!ws.path) return new Set()
  // Every line an open card has started on, earlier cycles' too (HI-1823: one back from Done that started again elsewhere
  // still has its work there).
  return new Set(workBadges(ws).filter((b) => !b.noCode && b.stage !== 'done').flatMap((b) => [...(b.line ? [b.line] : []), ...(b.lines ?? [])]))
}

const kept = (why: string, branch: string, target = ''): Text => withValues(B.kept, { why, branch, target })

const branchNameOk = async (projectPath: string, name: string): Promise<boolean> => !!name && !name.startsWith('-') && (await refFormatOk(projectPath, ['--branch', name]))

/**
 * Deletes local branches (#1642): each only at the commit the user was shown (`sha`), merged into the project's target
 * (unless `unmerged`, one branch the user confirmed with the commits it drops), and never one in use (the target, the
 * default branch, the folder's, a worktree's or slot's, an open card's). Each branch's check and its deletion happen in
 * one hold of the repository's lock, which slot preparation, merges, branch switches and a target change take too
 * (round 3), so none of them lands between the two. The ref is removed only at the commit checked (`update-ref -d <ref>
 * <sha>`, atomic: a git outside the lock moving it makes git refuse; never `branch -D`, which takes whatever it points
 * at, nor `-d`, which measures against HEAD), and put back if a worktree has it checked out after all (round 4). What is
 * kept is said, why.
 */
export async function deleteBranches(projectPath: string, items: BranchAt[], unmerged = false): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  if (!Array.isArray(items) || !items.length || (unmerged && items.length !== 1)) throw new HiveError({ lines: ['git:deleteBranches takes branches, and one when unmerged'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return oneAtATime(projectPath, () =>
    guarded(projectPath, async () => {
        await summaryOf(projectPath)
        await targetOrRefuse(projectPath)
        const deleted: string[] = []
        const notes: Text[] = []
        for (const { name, sha } of items) {
          const branch = String(name ?? '')
          if (!(await branchNameOk(projectPath, branch))) {
            notes.push(kept('invalid', branch))
            continue
          }
          const head = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`])
          if (!head.ok) {
            notes.push(kept('gone', branch))
            continue
          }
          if (head.out.trim() !== sha) {
            notes.push(kept('moved', branch))
            continue
          }
          // Its use read now, right before it goes (#1642 round 2): never the batch's first look, nor one from before
          // the lock (the target changed while it waited, an open card took an earlier item's neighbour meanwhile).
          const now = await branchUseNow(projectPath, branch)
          if (now.why) {
            notes.push(kept(now.why, branch))
            continue
          }
          if (!now.target) {
            notes.push(withValues(B.noTarget, { target: now.defaultBranch ?? '' }))
            continue
          }
          if (!unmerged && !(await git(projectPath, ['merge-base', '--is-ancestor', sha, `refs/heads/${now.target}`])).ok) {
            notes.push(kept('unmerged', branch, now.target))
            continue
          }
          // Removed only at the commit checked (round 4): a git outside Hive's lock that moved it meanwhile makes git
          // refuse, and its new commits stay. Then checked out anywhere after all (taken around the lock): put back at
          // that commit, kept. Its config goes only once it is gone for good.
          const r = await git(projectPath, ['update-ref', '-d', `refs/heads/${branch}`, sha])
          if (!r.ok) {
            const moved = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`])
            notes.push(moved.ok && moved.out.trim() !== sha ? kept('moved', branch) : withValues(B.deleteFailed, { branch, why: gitSaid(r) }))
            continue
          }
          const after = await git(projectPath, ['worktree', 'list', '--porcelain'])
          if (!after.ok || parseWorktrees(after.out).some((w) => w.branch === branch)) {
            const back = await git(projectPath, ['update-ref', `refs/heads/${branch}`, sha, ''])
            notes.push(back.ok ? kept('worktree', branch) : withValues(B.deleteFailed, { branch, why: gitSaid(back) }))
            continue
          }
          await git(projectPath, ['config', '--remove-section', `branch.${branch}`])
          deleted.push(branch)
        }
        if (deleted.length) log.info(`Deleted ${deleted.length} branch(es) of ${userText(projectPath)}: ${userText(deleted.join(', '))}${unmerged ? ' (unmerged, confirmed)' : ''}`)
        if (!deleted.length) throw new HiveError(linesOf(notes))
        void checkProject(projectPath)
        return shownText(linesOf([withValues(B.deleted, { n: deleted.length, branches: listOf(deleted, 'unit') }), ...notes]))
    })
  )
}

/**
 * Deletes branches on a remote (#1642, `git push --delete`, outward-facing: the window asks for each with its own tick):
 * each named as the window has it (nas/hive/hb1), only merged into the project's target, never the remote's default
 * branch, the target or the default branch, nor one whose local branch is in use, and only at the commit the user was
 * shown (`--force-with-lease`: a branch that moved on the remote is refused there). The checks and the push are one hold
 * of the repository's lock (round 3), bounded by the network timeout: a slot, worktree or target change waits for it.
 */
export async function deleteRemoteBranches(projectPath: string, remote: string, items: BranchAt[]): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  if (!Array.isArray(items) || !items.length) throw new HiveError({ lines: ['git:deleteRemoteBranches takes branches'] }, { kind: 'invalid' }) // i18n-ignore: a mistake in a caller, never the window's
  return oneAtATime(projectPath, async () => {
    return guarded(projectPath, async () => {
        const s = await summaryOf(projectPath)
        if (!s.remotes.includes(remote)) throw refusal(M.noRemote, { remote })
        await targetOrRefuse(projectPath)
        const head = await git(projectPath, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`])
        const remoteHead = head.ok ? head.out.trim().replace(/^refs\/remotes\//, '') : null
        const said: Text[] = []
        const ready: { name: string; branch: string; sha: string }[] = []
        for (const { name, sha } of items) {
          const full = String(name ?? '')
          const branch = full.startsWith(`${remote}/`) ? full.slice(remote.length + 1) : ''
          if (!(await branchNameOk(projectPath, branch))) {
            said.push(kept('invalid', full))
            continue
          }
          const at = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/remotes/${full}^{commit}`])
          if (!at.ok) {
            said.push(kept('gone', full))
            continue
          }
          if (at.out.trim() !== sha) {
            said.push(kept('moved', full))
            continue
          }
          // As a local branch's: its use read now, for each (a remote branch whose local one is in use stays too).
          const now = await branchUseNow(projectPath, branch)
          if (remoteKept({ branch, remoteHead: full === remoteHead }, now)) {
            said.push(kept(full === remoteHead ? 'remoteHead' : branch === now.target ? 'target' : 'default', full))
            continue
          }
          if (now.why) {
            said.push(kept(now.why, full))
            continue
          }
          if (!now.target) {
            said.push(withValues(B.noTarget, { target: now.defaultBranch ?? '' }))
            continue
          }
          if (!(await git(projectPath, ['merge-base', '--is-ancestor', sha, `refs/heads/${now.target}`])).ok) {
            said.push(kept('unmerged', full, now.target))
            continue
          }
          ready.push({ name: full, branch, sha })
        }
        if (!ready.length) throw new HiveError(linesOf(said))
        // The push under the lock too (round 3): no slot, worktree or target change lands between the checks and it.
        const r = await net(projectPath, ['push', '--porcelain', ...ready.map((g) => `--force-with-lease=refs/heads/${g.branch}:${g.sha}`), '--', remote, ...ready.map((g) => `:refs/heads/${g.branch}`)])
        const got = parsePushPorcelain(r.out)
        const done = ready.filter((g) => got.some((x) => x.kind === 'branch' && x.name === g.branch && x.result === 'pushed'))
        const refused = ready.filter((g) => !done.includes(g))
        if (!done.length && !got.length && !r.ok) throw failed(M.pushFailed, { to: remote }, r)
        if (done.length) log.info(`Deleted ${done.length} branch(es) on ${userText(remote)} of ${userText(projectPath)}: ${userText(done.map((g) => g.branch).join(', '))}`)
        void checkProject(projectPath)
        const lines = [...(done.length ? [withValues(B.remoteDeleted, { n: done.length, remote, branches: listOf(done.map((g) => g.branch), 'unit') })] : []), ...(refused.length ? [withValues(B.remoteRefused, { remote, branches: listOf(refused.map((g) => g.branch), 'unit') })] : []), ...said]
        if (!done.length) throw new HiveError(linesOf(lines))
        return shownText(linesOf(lines))
    })
  })
}

/**
 * A clean-up's one hold (#1642 rounds 3 and 5), from each branch's last check through its deletion (a remote's push
 * included): the repository's lock, across Hives, which slot preparation, merges, branch switches and every workflow
 * options write that can move the project's target take (`withRepoLocks`: the project's, a level's, a setting's tool,
 * a platform switch), then this Hive's turn of workflow writes. In that order everywhere, so none waits on another.
 */
function guarded<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  return withRepoLock(projectPath, () => workflowWrite(fn), { project: projectPath })
}

/** The project's target read now, refusing when that branch isn't here (nothing can be measured against it). */
async function targetOrRefuse(projectPath: string): Promise<string> {
  const workTarget = await workTargetOf(projectPath)
  const targets = await branchTargets(projectPath, workTarget)
  if (!targets.target) throw refusal(B.noTarget, { target: workTarget || targets.defaultBranch || '' })
  return targets.target
}

/**
 * A local branch's use as it is now (#1642 round 2), read for each branch right before it is deleted: the project's
 * target (its options read again) and default branch, the folder's branch, the worktrees and slots, the board's open
 * cards. Read under the repository's lock, which the worktrees, slots and the target change only under (round 3); an
 * open card's line is in use only where a slot or worktree has it checked out, which git refuses to delete.
 */
async function branchUseNow(projectPath: string, branch: string): Promise<{ why: ReturnType<typeof localUse>; target: string | null; defaultBranch: string | null }> {
  const targets = await branchTargets(projectPath, await workTargetOf(projectPath))
  const [head, wts] = await Promise.all([git(projectPath, ['symbolic-ref', '-q', 'HEAD']), git(projectPath, ['worktree', 'list', '--porcelain'])])
  if (!wts.ok) throw commandFailed('git worktree list', wts) // i18n-ignore: a git command, as it is
  const worktree = parseWorktrees(wts.out).find((w) => w.branch === branch)?.path ?? null
  const why = localUse({ name: branch, current: head.ok && branchOfRef(head.out) === branch, worktree }, targets, cardLines(projectPath))
  return { why, ...targets }
}

/** The commits deleting an unmerged local branch drops (#1642): those not in the project's target, the newest 20, and how many. */
export async function branchDrops(projectPath: string, name: string): Promise<BranchDrops> {
  projectPath = workspace.assertProject(projectPath)
  const targets = await branchTargets(projectPath, await workTargetOf(projectPath))
  if (!targets.target) throw refusal(B.noTarget, { target: targets.defaultBranch ?? '' })
  if (!(await branchNameOk(projectPath, name)) || !(await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${name}`])).ok) throw refusal(M.noBranch, { branch: name })
  const range = `refs/heads/${targets.target}..refs/heads/${name}`
  const [count, commitLog] = await Promise.all([git(projectPath, ['rev-list', '--count', range, '--']), git(projectPath, ['log', '-n', '20', '--format=%h%x00%ct%x00%s', range, '--'])])
  if (!count.ok) throw commandFailed('git rev-list', count) // i18n-ignore: a git command, as it is
  if (!commitLog.ok) throw commandFailed('git log', commitLog) // i18n-ignore: a git command, as it is
  const commits = commitLog.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\0'))
    .map((f) => ({ short: f[0], date: Number(f[1]) * 1000, subject: f[2] ?? '' }))
  return { target: targets.target, total: Number(count.out.trim()) || 0, commits }
}

// ---------------------------------------------------------------------------
// Update from <target> (HI-1180)
// ---------------------------------------------------------------------------

const UPDATE = {
  noTarget: msg({ id: 'service.gitRepo.update.noTarget', defaultMessage: 'The project has no target branch here, so there is nothing to update {branch} from.', description: "An error updating a branch from its target (Version Control → Branches, HI-1180): the project's workflow target (or the repository's default branch) doesn't exist in this repository. {branch} is the branch." }),
  isTarget: msg({ id: 'service.gitRepo.update.isTarget', defaultMessage: '{branch} is the target itself.', description: 'An error updating a branch from its target: the branch picked ({branch}) is the target.' }),
  agentBusy: msg({
    id: 'service.gitRepo.update.agentBusy',
    defaultMessage:
      '{agent} {status, select, starting {is starting} working {is working} waiting {is waiting for your answer} background {is waiting on background tasks it started} watching {is waiting for cards to change (a card watch)} other {stopped in the middle of a task when its sign-in expired}} in {folder}: update {branch} once it has finished.',
    description: "Why updating a branch from its target is refused now: an agent works in the folder the branch is checked out in ({folder}: a slot's name, such as slot-a, or a folder's name or path). {agent} is the agent's name; {status} what it is doing (select: translate each); {branch} the branch."
  }),
  dirty: msg({ id: 'service.gitRepo.update.dirty', defaultMessage: '{folder} has uncommitted changes: commit them, or set them aside, before updating {branch}.', description: "Why updating a branch from its target is refused: the folder it is checked out in ({folder}: a slot's name, a folder's name or a path) has changes not committed. {branch} is the branch." }),
  midOperation: msg({ id: 'service.gitRepo.update.midOperation', defaultMessage: 'Git is in the middle of a {state} in {folder}: finish or abort it first.', description: "Why updating a branch from its target is refused: a git operation ({state}: merge, rebase…, as git names it) is under way in the folder the branch is checked out in ({folder}: a slot's name, a folder's name or a path)." }),
  queued: msg({ id: 'service.gitRepo.update.queued', defaultMessage: '{card} is in the merge queue, which brings it up to date itself: take it out of the queue first to update {branch} here.', description: "Why updating a branch from its target is refused: the branch is the line of a card ({card}: its key, such as HI-12) that Hive's merge queue is merging now. {branch} is the branch." }),
  upToDate: msg({ id: 'service.gitRepo.update.upToDate', defaultMessage: '{branch} already has everything in {target}.', description: 'After Update from <target> (HI-1180): the branch {branch} already contains every commit of the target {target}; nothing was done.' }),
  conflict: msg({ id: 'service.gitRepo.update.conflict', defaultMessage: '{how, select, rebase {Rebasing} other {Merging}} {branch} with {target} stopped at a conflict in {files}, so it was undone: {branch} is as it was. Update it by hand, or ask its builder to.', description: 'An error updating a branch from its target: git stopped at a conflict, and Hive aborted it, leaving the branch and its folder as they were. {how}: merge or rebase (select: translate each); {branch} the branch, {target} the target; {files} the files in conflict, joined (src/a.ts and src/b.ts).' }),
  failed: msg({ id: 'service.gitRepo.update.failed', defaultMessage: "Couldn't update {branch} from {target}, so it is as it was: {why}", description: "An error updating a branch from its target that isn't a conflict (a hook refused the commit, signing failed…); Hive undid what git started. {why} is git's own words." }),
  moved: msg({ id: 'service.gitRepo.update.moved', defaultMessage: '{branch} changed while it was being updated, so nothing was changed: try again.', description: 'An error updating a branch from its target: the branch moved to another commit meanwhile (a commit, a push), so Hive left it as it is.' }),
  merged: msg({ id: 'service.gitRepo.update.merged', defaultMessage: 'Merged {target} into {branch} ({commit}).', description: 'After Update from <target> with Merge (HI-1180): the target {target} was merged into the branch {branch}, as the commit {commit} (a short id: keep it as it is).' }),
  rebased: msg({ id: 'service.gitRepo.update.rebased', defaultMessage: "Rebased {branch}'s {n, plural, one {# commit} other {# commits}} onto {target} ({commit}).", description: 'After Update from <target> with Rebase (HI-1180): the branch {branch} has its {n} commits replayed onto the target {target}; {commit} is its new head (a short id: keep it as it is).' }),
  forwarded: msg({ id: 'service.gitRepo.update.forwarded', defaultMessage: 'Fast-forwarded {branch} to {target} ({commit}).', description: 'After Update from <target> on a branch with no commits of its own (HI-1180): it was moved forward to the target {target}; {commit} is its new head (a short id: keep it as it is).' }),
  notUndone: msg({ id: 'service.gitRepo.update.notUndone', defaultMessage: "Updating {branch} from {target} stopped, and Combwork couldn't undo it: {folder} is {state, select, none {left changed} merge {still in the middle of a merge} rebase {still in the middle of a rebase} other {still in the middle of a git operation}}. Finish or abort it there yourself (git status says how), then check {branch}. Git said: {why}", description: "An error updating a branch from its target (HI-1180): git stopped, and Hive's own abort failed, so the folder ({folder}: a slot's name, a folder's name or a path) is left as git left it ({state}: none, merge, rebase or another operation; select: translate each). {why} is git's own words." }),
  notUndoneTemporary: msg({ id: 'service.gitRepo.update.notUndoneTemporary', defaultMessage: "Updating {branch} from {target} stopped, and Combwork couldn't undo it in its temporary folder {folder}, kept as git left it: {branch} itself is as it was. Remove that folder in Unused worktrees once you have looked. Git said: {why}", description: "An error updating a branch from its target (HI-1180) that was checked out nowhere: git stopped in the temporary folder Hive made ({folder}: its path), and Hive's abort failed, so the folder is kept; the branch itself wasn't moved. {state} is unused here. {why} is git's own words." }),
  temporaryLeft: msg({ id: 'service.gitRepo.update.temporaryLeft', defaultMessage: "Combwork couldn't remove its temporary folder {folder}: remove it in Unused worktrees.", description: 'A second line after Update from <target> on a branch checked out nowhere (HI-1180): the temporary folder Hive made for it ({folder}: its path) could not be removed.' }),
  missed: msg({ id: 'service.gitRepo.update.missed', defaultMessage: '{branch} was changed, but it still lacks commits of {target}: check it in History before going on.', description: "An error after Update from <target> (HI-1180): git said it succeeded, but the branch {branch} still doesn't contain the target {target}'s head." })
}

/** The sessions' statuses that keep a folder busy, as folderBusyData's. */
const FOLDER_BUSY = new Set(['starting', 'working', 'waiting', 'background', 'watching', 'signin'])

/** Where a branch is checked out: the project folder, another worktree (a slot's, or not), or nowhere (null). */
async function branchFolder(projectPath: string, branch: string): Promise<Pick<BranchUpdatePlan, 'where' | 'folder' | 'slot'>> {
  const s = await repoSummary(projectPath)
  if (s.branch === branch) return { where: 'project', folder: projectPath, slot: null }
  const trees = await git(projectPath, ['worktree', 'list', '--porcelain'])
  const tree = (trees.ok ? parseWorktrees(trees.out) : []).find((w) => w.branch === branch && !samePlace(w.path, projectPath))
  if (!tree) return { where: 'temporary', folder: null, slot: null }
  const slot = (await folderFacts(projectPath).catch(() => null))?.slots.find((x) => samePlace(x.folder, tree.path))
  return { where: slot ? 'slot' : 'worktree', folder: tree.path, slot: slot?.name ?? null }
}

/** A folder as the update's messages name it: its slot's name, the project folder's name, or its path. */
const folderName = (p: Pick<BranchUpdatePlan, 'where' | 'folder' | 'slot'>, projectPath: string): string => p.slot ?? (p.where === 'project' ? basename(projectPath) : (p.folder ?? ''))

/** Whether a folder has changes to tracked files (untracked files are left to git: a merge that would overwrite one stops). */
async function dirtyIn(folder: string): Promise<boolean> {
  const r = await git(folder, ['status', '--porcelain', '--untracked-files=no'])
  return !r.ok || !!r.out.trim()
}

/** What Update from <target> would do to `branch` now (HI-1180), for its dialog; checked again when it runs. */
export async function branchUpdatePlan(projectPath: string, branch: string): Promise<BranchUpdatePlan> {
  projectPath = workspace.assertProject(projectPath)
  await summaryOf(projectPath)
  const { target } = await branchTargets(projectPath, await workTargetOf(projectPath))
  if (!target) throw refusal(UPDATE.noTarget, { branch })
  if (branch === target) throw refusal(UPDATE.isTarget, { branch })
  if (!(await git(projectPath, ['show-ref', '--verify', '-q', `refs/heads/${branch}`])).ok) throw refusal(M.noBranch, { branch })
  const counts = await git(projectPath, ['rev-list', '--left-right', '--count', `refs/heads/${target}...refs/heads/${branch}`, '--'])
  if (!counts.ok) throw commandFailed('git rev-list', counts) // i18n-ignore: a git command, as it is
  const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number)
  const place = await branchFolder(projectPath, branch)
  const agents = place.folder ? await folderAgents(projectPath, place.folder) : []
  const line = await lineCard(projectPath, branch)
  const wf = line ? await workflowFor(workspaceOf(projectPath), projectPath).catch(() => null) : null
  const rec = line && wf ? wf.store.cards().find((c) => c.id === line.number) : undefined
  const st = rec && wf ? wf.state(rec) : null
  const q = rec && wf && st ? queueStateOf(wf, rec, st) : null
  const pushed = (await git(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).ok
  const where = folderName(place, projectPath)
  let blocked: Text | null = null
  const busy = agents.find((a) => a.status && FOLDER_BUSY.has(a.status))
  if (busy) blocked = withValues(UPDATE.agentBusy, { agent: busy.name, status: busy.status!, folder: where, branch })
  else if (line && q && (q.state === 'queued' || q.state === 'testing' || q.state === 'paused')) blocked = withValues(UPDATE.queued, { card: line.key, branch })
  else if (place.folder) {
    const state = (await repoSummary(place.folder)).state
    if (state) blocked = withValues(UPDATE.midOperation, { state, folder: where })
    else if (await dirtyIn(place.folder)) blocked = withValues(UPDATE.dirty, { folder: where, branch })
  }
  return {
    branch,
    target,
    behind: behind || 0,
    ahead: ahead || 0,
    ...place,
    card: line && st ? { key: line.key, stage: st.stage } : null,
    agents,
    approval: rec && wf && st?.stage === 'approved' ? (wf.rulesetOf(rec, st).options.sameness === 'change' ? 'carries' : 'reviewAgain') : null,
    pushed,
    blocked: blocked ? shownText(blocked) : null
  }
}

/**
 * Update from <target> (HI-1180): merges the target into `branch` (one merge commit, with the card's trailer for a card's
 * line), or rebases its commits onto the target, where it is checked out, or, checked out nowhere, in a temporary
 * worktree that is then removed, the branch moved only if it hasn't moved meanwhile. Refused while an agent works there,
 * the folder has uncommitted changes or git is mid-operation, or its card is in the merge queue. As switch and pull: the
 * folder fenced, the repository locked, the branch's merge slot held. A conflict is aborted at once, nothing left half
 * done, naming its files. A card's pass then follows the rules (reconcile: carried over when the same change, else stale).
 */
export async function updateBranch(projectPath: string, branch: string, how: BranchUpdateHow): Promise<string> {
  projectPath = workspace.assertProject(projectPath)
  return oneAtATime(projectPath, () => mergeSlots.asUser(projectPath, branch, () => withRepoLock(projectPath, () => updateLocked(projectPath, branch, how), { project: projectPath })))
}

async function updateLocked(projectPath: string, branch: string, how: BranchUpdateHow): Promise<string> {
  const place = await branchFolder(projectPath, branch)
  // The folder fenced from the last check to git's end (#646): no Hive line typed into its agents, none started there.
  // i18n-ignore: what changes the folder, for the log and an agent's reply (agent-facing, English)
  const fenced = <T>(fn: () => Promise<T>): Promise<T> => (place.folder ? changingFolder(place.folder, 'a Git update from the target', fn) : fn())
  return fenced(async () => {
    // Checked again under the locks: nothing changes between this and git starting.
    const plan = await branchUpdatePlan(projectPath, branch)
    // agent-text: branchUpdatePlan
    if (plan.blocked) throw new HiveError(linesOf([plan.blocked]))
    if (plan.behind === 0) return tr(UPDATE.upToDate, { branch, target: plan.target })
    // The target branch's commit, read now (HR4's round 1, finding 2): git is given it, never the name, which a tag of the
    // same name would take.
    const at = await git(projectPath, ['rev-parse', '--verify', '-q', `refs/heads/${plan.target}^{commit}`])
    if (!at.ok) throw refusal(UPDATE.noTarget, { branch })
    const target = at.out.trim()
    const card = (await lineCard(projectPath, branch))?.key
    // i18n-ignore: a commit message, in English
    const message = ['-m', `Merge ${plan.target} into ${branch}`, ...(card ? ['-m', `Hive-Card: ${card}`] : [])]
    // Nothing of its own (behind only): brought up by a fast-forward, whichever was asked; a merge commit would hold nothing.
    const forward = plan.ahead === 0
    // A rebase moves only the branch it rebases (HR4's #1352 round 1: never another ref with `rebase.updateRefs` on).
    const step = (f: string): Promise<GitResult> =>
      forward
        ? git(f, ['merge', '--ff-only', target])
        : how === 'rebase'
          ? git(f, ['-c', 'rebase.updateRefs=false', 'rebase', '--no-update-refs', '--no-autostash', target])
          : git(f, ['merge', '--no-ff', '--no-edit', ...message, target])
    const where = folderName(plan, projectPath)

    /**
     * What git started is undone: aborted, then checked (no operation left, HEAD where it was, nothing changed). Undone,
     * a conflict is named by its files, any other failure by git's words; not undone (HR4's round 1, finding 1: an abort
     * that failed), the error says so and how the folder is, and a temporary folder is kept as git left it.
     */
    const undo = async (f: string, was: string, r: GitResult, temporary: boolean): Promise<{ error: Error; undone: boolean }> => {
      const u = await git(f, ['diff', '--name-only', '--diff-filter=U'])
      const files = u.ok ? u.out.split(/\r?\n/).filter(Boolean) : []
      const inProgress = (await repoSummary(f)).state
      const abort = inProgress ? await git(f, inProgress === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort']) : null
      const left = (await repoSummary(f)).state
      const now = await git(f, ['rev-parse', 'HEAD'])
      if (!left && now.ok && now.out.trim() === was && !(await dirtyIn(f))) {
        log.info(`Update of ${userText(branch)} from ${userText(plan.target)} undone: ${files.length ? `${files.length} file(s) in conflict` : 'git failed'}`)
        return { undone: true, error: files.length ? refusal(UPDATE.conflict, { how: forward ? 'merge' : how, branch, target: plan.target, files: listOf(files, 'unit') }) : failed(UPDATE.failed, { branch, target: plan.target }, r) }
      }
      log.warn(`Update of ${userText(branch)} from ${userText(plan.target)} couldn't be undone in ${userText(f)}: ${left ? `still mid-${left}` : 'left changed'}`)
      const values = { branch, target: plan.target, folder: temporary ? f : where, state: left ? gitStateKey(left) : 'none', why: gitSaid(abort && !abort.ok ? abort : r) }
      return { undone: false, error: refusal(temporary ? UPDATE.notUndoneTemporary : UPDATE.notUndone, values) }
    }

    let head: string
    let note: string | null = null
    if (plan.folder) {
      const was = (await git(plan.folder, ['rev-parse', 'HEAD'])).out.trim()
      const r = await step(plan.folder)
      if (!r.ok) throw (await undo(plan.folder, was, r, false)).error
      head = (await git(plan.folder, ['rev-parse', 'HEAD'])).out.trim()
    } else {
      // Checked out nowhere: a temporary detached worktree beside the merge queue's, removed after (said if it can't be).
      const was = (await git(projectPath, ['rev-parse', `refs/heads/${branch}`])).out.trim()
      const tmp = join(workspaceOf(projectPath).worktreesRoot, basename(projectPath), `update-${randomUUID().slice(0, 8)}`)
      const add = await git(projectPath, ['worktree', 'add', '--detach', tmp, was])
      if (!add.ok) throw failed(UPDATE.failed, { branch, target: plan.target }, add)
      const removed = async (): Promise<string | null> => ((await git(projectPath, ['worktree', 'remove', '--force', tmp])).ok ? null : tr(UPDATE.temporaryLeft, { folder: tmp }))
      const r = await step(tmp)
      if (!r.ok) {
        const { error, undone } = await undo(tmp, was, r, true)
        // Not undone: kept as git left it, as the error says. Undone: removed, and said if it couldn't be.
        const left = undone ? await removed() : null
        throw left ? new HiveError(linesOf([errorText(error), withValues(UPDATE.temporaryLeft, { folder: tmp })])) : error
      }
      head = (await git(tmp, ['rev-parse', 'HEAD'])).out.trim()
      // Moved only from the commit it was updated from: a branch that moved meanwhile is left as it is.
      const moved = (await git(projectPath, ['update-ref', `refs/heads/${branch}`, head, was])).ok
      note = await removed()
      if (!moved) throw note ? new HiveError(linesOf([withValues(UPDATE.moved, { branch }), withValues(UPDATE.temporaryLeft, { folder: tmp })])) : refusal(UPDATE.moved, { branch })
    }
    // What it was asked to do, done: the target's commit is in the branch now.
    if (!(await git(projectPath, ['merge-base', '--is-ancestor', target, head])).ok) throw refusal(UPDATE.missed, { branch, target: plan.target })
    log.info(`Updated ${userText(branch)} from ${userText(plan.target)} by ${forward ? 'fast-forward' : how} (${plan.where})`)
    await changed(projectPath)
    const commit = head.slice(0, 7)
    const done = forward ? tr(UPDATE.forwarded, { branch, target: plan.target, commit }) : how === 'rebase' ? tr(UPDATE.rebased, { branch, n: plan.ahead, target: plan.target, commit }) : tr(UPDATE.merged, { target: plan.target, branch, commit })
    return note ? `${done}\n${note}` : done
  })
}
