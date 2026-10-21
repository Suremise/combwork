import { createHash, randomUUID } from 'crypto'
import { basename, join, resolve } from 'path'
import { createReadStream, existsSync } from 'original-fs'
import { lstat, readdir, readlink } from 'original-fs/promises'
import { projectAgents, slugify } from '../shared/defaults'
import { fmt, msg, tr, type Msg } from '../shared/i18n'
import type { AgentBranchStatus, AgentWorktree, MergeResult, SessionRecord, UnusedWorktree, UnusedWorktreeOrigin, UnusedWorktreePreview, UnusedWorktreeRemoval, UnusedWorktrees } from '../shared/types'
import { lostLines } from '../shared/unusedWorktrees'
import { hiveBranchNumber } from '../shared/hiveBranches'
import { containsPlace, placeKey, realPath } from './fsutil'
import { git, gitReading } from './git'
import { gitProblem } from './gitTool'
import { createLogger, userText } from './logger'
import { checkProject } from './branchWatch'
import { branchPlace, mergeInProject, reserveForRemoval } from './projectAgents'
import { workspace, workspaceOf } from './workspace'
import * as wt from './worktrees'
import { FactStore } from './workflow/factStore'

const log = createLogger('worktrees')

/**
 * Unused worktrees (#353): the git worktrees of a project that no agent of it works in, kept when their agent was
 * removed with "Keep worktree and branch" (or made outside Hive). Each is checked with #291's `worktreeCheck` (merged
 * into the repository's main branch and clean; anything git can't say counts as not removable, #346). Only folders git
 * lists as the project's worktrees, that exist, aren't the project, don't contain it or the workspace and aren't another
 * project. Removal is the user's alone (no Agent API route or tool): Remove deletes a merged, clean one and its branch
 * through `removeCheckedWorktree`; Remove anyway (forced) only what the user was shown it would lose.
 */

const key = placeKey
/** Whether `a` is `b` or a folder containing it, by real paths (#389). */
const contains = containsPlace

/** Why Hive won't touch a listed worktree folder (null: it may), whoever uses it. */
async function unsafe(projectPath: string, path: string): Promise<string | null> {
  const ws = workspaceOf(projectPath)
  if (contains(path, projectPath) || (ws.path && contains(path, ws.path))) return tr(msg({ id: 'main.unused.why.contains', defaultMessage: 'it contains the project or the workspace', description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause." }))
  const projects = [...(await ws.listProjectPaths()), ...(await ws.listProjectPaths({ hidden: true }))]
  if (projects.some((p) => key(p) === key(path)) || workspace.isAssistantHome(path)) return tr(msg({ id: 'main.unused.why.otherProject', defaultMessage: 'it is another project of the workspace', description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause." }))
  return null
}

/**
 * The merge queue's folders a running runner holds now (#1360): never offered, whoever's Hive runs it. A folder of a
 * runner whose process has gone (it crashed), or kept for the next one, is an unused worktree like any other.
 */
function queueFoldersInUse(projectPath: string): Set<string> {
  try {
    const store = FactStore.forBoard(workspaceOf(projectPath), { project: basename(projectPath), key: basename(projectPath) })
    const out = new Set<string>()
    for (const f of store.queueFolders()) {
      const holder = f.lease ? store.queueLease(f.target) : null
      if (holder && holder.lease === f.lease && running(holder.pid)) out.add(key(f.folder))
    }
    return out
  } catch {
    // A board still 0.9's (no queue tables), or none open: no queue runs.
    return new Set()
  }
}

/** Whether a process with this id runs (a quick look: a pid given again keeps a folder hidden, never shows a used one). */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The worktrees git lists for the project that no agent works in, as they are now (no check yet). */
async function candidates(projectPath: string, reads?: wt.RepoReads): Promise<{ listed: { path: string; branch: string | null }[]; problem?: string }> {
  const all = await (reads ? reads.worktrees() : wt.listWorktrees(projectPath))
  if (!all.length) {
    const problem = gitProblem()
    return problem ? { listed: [], problem } : { listed: [] }
  }
  const used = new Set([...projectAgents(await workspace.projectConfig(projectPath)).flatMap((a) => (a.worktree ? [key(a.worktree.path)] : [])), ...queueFoldersInUse(projectPath)])
  const listed: { path: string; branch: string | null }[] = []
  for (const w of all) {
    if (key(w.path) === key(projectPath) || used.has(key(w.path)) || !existsSync(w.path)) continue
    if (await unsafe(projectPath, w.path)) continue
    listed.push(w)
  }
  return { listed }
}

/**
 * A detached worktree, never removable by Remove (no branch to check): its uncommitted files, and as `ahead` the commits
 * its HEAD alone holds (on no branch, tag or remote branch: removing the worktree loses them). Left out when git can't
 * count them, so nothing is offered that can't say what it loses.
 */
async function detachedCheck(projectPath: string, path: string, reads: wt.RepoReads): Promise<UnusedWorktree['check']> {
  const [dirty, alone] = await Promise.all([reads.dirty(path), unreferencedCommits(path)])
  return { removable: false, into: await reads.primaryBranchStrict().catch(() => null), reason: gitProblem() ?? tr(msg({ id: 'main.unused.why.detached', defaultMessage: 'it is not on a branch (detached HEAD)', description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause. detached HEAD is git's term." })), ...(dirty === null ? {} : { dirty }), ...(alone === null ? {} : { ahead: alone }) }
}

/**
 * Commits a worktree's HEAD holds that no branch, tag or remote branch has (but `except`, the branch removing it would
 * delete); null when git can't say.
 */
async function unreferencedCommits(path: string, except?: string): Promise<number | null> {
  const r = await git(path, ['rev-list', '--count', 'HEAD', '--not', ...(except ? [`--exclude=refs/heads/${except}`] : []), '--branches', '--tags', '--remotes'])
  const n = parseInt(r.out.trim(), 10)
  return r.ok && Number.isFinite(n) ? n : null
}

/**
 * Who made an unused worktree (#476): the Hive agent whose session last ran in it (sessions.json keeps each session's
 * folder and its agent's name), else Hive when it is in Hive's worktrees folder for the project, else not Hive.
 */
export function worktreeOrigin(path: string, sessions: readonly Pick<SessionRecord, 'cwd' | 'agentName' | 'agentId' | 'lastActiveAt'>[], hiveFolder: string | null): UnusedWorktreeOrigin {
  const ran = sessions.filter((s) => s.cwd && key(s.cwd) === key(path) && (s.agentId || s.agentName)).sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1))[0]
  if (ran) return ran.agentName ? { madeBy: 'hive', agentName: ran.agentName } : { madeBy: 'hive' }
  return hiveFolder && contains(hiveFolder, path) ? { madeBy: 'hive' } : { madeBy: 'other' }
}

async function describe(projectPath: string, w: { path: string; branch: string | null }, origin: UnusedWorktreeOrigin, reads: wt.RepoReads): Promise<UnusedWorktree> {
  const check = w.branch ? await wt.worktreeCheck(projectPath, { path: w.path, branch: w.branch, base: '' }, reads) : await detachedCheck(projectPath, w.path, reads)
  const [head, last] = await Promise.all([git(w.path, ['rev-parse', '--verify', '--quiet', 'HEAD']), git(w.path, ['log', '-1', '--format=%cI%x00%s'])])
  const [at, subject] = last.ok ? last.out.trim().split('\0') : []
  return {
    path: w.path,
    branch: w.branch,
    check,
    ...(head.ok && head.out.trim() ? { head: head.out.trim() } : {}),
    ...(at ? { lastCommit: { at, subject: subject ?? '' } } : {}),
    origin
  }
}

/** The folders of the project's unused worktrees, unchecked (Storage measures them). */
export async function unusedWorktreeFolders(projectPath: string): Promise<{ path: string; branch: string | null }[]> {
  return (await candidates(projectPath).catch(() => ({ listed: [] }))).listed
}

/**
 * The project's unused worktrees, each checked. Read-only, so one set of reads serves them all (#733): the worktree list,
 * the main branch and its commit are read once, not once per worktree. Removing one checks it afresh.
 */
export async function unusedWorktrees(projectPath: string): Promise<UnusedWorktrees> {
  projectPath = workspace.assertProject(projectPath)
  const reads = new wt.RepoReads(projectPath)
  const { listed, problem } = await candidates(projectPath, reads)
  if (problem) return { worktrees: [], gitProblem: problem }
  const worktrees: UnusedWorktree[] = []
  const ws = workspaceOf(projectPath)
  // Without them each worktree is only "made by Hive" or not, never by whom: said in the log rather than hidden (#1149).
  const sessions = (await workspace.sessionsFile(projectPath).catch((e) => void log.warn(`reading ${userText(basename(projectPath))}'s session records for its unused worktrees`, e)))?.sessions ?? []
  // Where Hive makes the project's agent worktrees (projectAgents.ts).
  const hiveFolder = ws.path ? join(ws.worktreesRoot, basename(projectPath)) : null
  for (const w of listed) worktrees.push(await describe(projectPath, w, worktreeOrigin(w.path, sessions, hiveFolder), reads))
  // The Changes tab may read these (and only these) now (#400).
  workspaceOf(projectPath).noteUnusedWorktrees(projectPath, worktrees.map((w) => w.path))
  return { worktrees }
}

/**
 * One of the project's unused worktrees, by its folder, as a worktree to show and merge in Changes (#400): only one git
 * lists as the project's that no agent uses and Hive may touch, on a branch (a detached one has nothing to merge), with
 * the branch it would merge into as its base. Throws otherwise.
 */
async function unusedWorktree(projectPath: string, path: string): Promise<AgentWorktree> {
  const { listed, problem } = await candidates(projectPath)
  const w = listed.find((x) => key(x.path) === key(path))
  if (!w) throw new Error(problem ?? tr(msg({ id: 'main.unused.gone', defaultMessage: "It isn't one of the project's unused worktrees any more.", description: "An error merging one of the Overview's unused worktrees (Remove, Remove anyway, Merge): it changed meanwhile." })))
  if (!w.branch) throw new Error(tr(msg({ id: 'main.unused.nothingToMerge', defaultMessage: 'It is not on a branch (detached HEAD): there is nothing to merge.', description: "An error merging one of the Overview's unused worktrees (Remove, Remove anyway, Merge). detached HEAD is git's term." })))
  const into = await wt.primaryBranch(projectPath)
  if (!into) throw new Error(gitProblem() ?? tr(msg({ id: 'main.unused.noBase', defaultMessage: "Git couldn't say which branch it would merge into.", description: "An error merging one of the Overview's unused worktrees (Remove, Remove anyway, Merge)." })))
  return { path: w.path, branch: w.branch, base: into }
}

/** What an unused worktree's branch holds that its project's branch doesn't, as the Merge dialog shows it (#400). */
export async function unusedBranchStatus(projectPath: string, path: string): Promise<AgentBranchStatus> {
  projectPath = workspace.assertProject(projectPath)
  return wt.branchStatus(projectPath, await unusedWorktree(projectPath, path))
}

/**
 * Merges an unused worktree's branch into the project folder's (#400), as an agent's merge does (one at a time, holding
 * the merge slot). It is fenced first, as a removal is (`reserveForRemoval`): nothing gives it to an agent until the merge
 * is over (an Add Agent or template load refuses it under the project file's lock, #289), and under that lock no agent
 * may have it already. So the merge never stages or commits files of an agent's worktree, whenever one was given it.
 * `cleanup`: then removes it with its branch through the same checked removal as Remove (its own fence and checks;
 * merged and clean now, else kept and said why).
 */
export async function mergeUnused(projectPath: string, path: string, opts: { squash: boolean; message: string; cleanup: boolean }): Promise<MergeResult> {
  projectPath = workspace.assertProject(projectPath)
  let worktree: AgentWorktree
  let result: MergeResult
  const release = reserveForRemoval(path)
  try {
    // Under the project file's lock, after the fence: an agent given it before keeps it, and none can be from now on.
    let owned = false
    await workspace.mutateProjectConfig(projectPath, (now) => {
      owned = projectAgents(now).some((a) => a.worktree && key(a.worktree.path) === key(path))
      return {}
    })
    if (owned) throw new Error(tr(msg({ id: 'main.unused.ownedMerge', defaultMessage: 'An agent works in it now: merge it from that agent.', description: "An error merging one of the Overview's unused worktrees (Remove, Remove anyway, Merge): an agent was given it meanwhile." })))
    worktree = await unusedWorktree(projectPath, path)
    result = await mergeInProject(projectPath, worktree, { squash: opts.squash, message: opts.message })
  } finally {
    release()
  }
  workspaceOf(projectPath).scheduleRefresh()
  void checkProject(projectPath)
  if (!result.ok || !opts.cleanup) return result
  const removed = await removeUnusedWorktree(projectPath, worktree.path, { expectInto: worktree.base })
  return removed.deleted ? { ...result, cleanedUp: true } : { ...result, cleanupKept: removed.reason ?? tr(msg({ id: 'main.unused.kept', defaultMessage: 'it was kept', description: "After merging one of the Overview's unused worktrees (Remove, Remove anyway, Merge) and removing it: it was kept, for no reason given. A clause." })) }
}

/** Counts for the Assistant's project status (#353): how many, and how many are merged and clean. Null with none. */
export async function unusedWorktreeCounts(projectPath: string): Promise<{ count: number; merged: number } | null> {
  const { worktrees } = await unusedWorktrees(projectPath).catch(() => ({ worktrees: [] as UnusedWorktree[] }))
  return worktrees.length ? { count: worktrees.length, merged: worktrees.filter((w) => w.check.removable).length } : null
}

/**
 * The project's unused worktrees named after these agents as Hive names worktrees (`hive/<workspace>/<project>/<slug>`,
 * or `hive/<slug>` from before #703, in `<worktrees>/<project>/<slug>`, or numbered `-2`…): what a deleted template's
 * worktree agents left (#353's hint).
 */
export async function unusedWorktreesNamed(projectPath: string, names: string[]): Promise<string[]> {
  if (!names.length) return []
  const root = join(workspaceOf(projectPath).worktreesRoot, basename(projectPath))
  const { listed } = await candidates(projectPath).catch(() => ({ listed: [] as { path: string; branch: string | null }[] }))
  const numbered = (s: string, stem: string): boolean => s === stem || (s.startsWith(`${stem}-`) && /^\d+$/.test(s.slice(stem.length + 1)))
  const home = await branchPlace(projectPath)
  return listed
    // Its folder named after one of them, and its branch Hive's for that one, in either form (#703).
    .filter((w) => key(resolve(w.path, '..')) === key(root) && !!w.branch && names.some((n) => numbered(basename(w.path).toLowerCase(), slugify(n)) && hiveBranchNumber(w.branch!, home, n) !== null))
    .map((w) => w.path)
}

/**
 * What Remove anyway would delete, exactly as it is now (#353): the folder (canonical path), its branch or detached HEAD,
 * the commit checked out, the main branch and its commit it was checked against, the commits and uncommitted files only
 * it holds, and a fingerprint of everything in the folder, ignored files included, and of its git index (`fingerprint`:
 * whole contents, not sizes and times). Taken for the confirmation and again just before
 * the removal, which goes ahead only if the two are the same. Throws when any of it can't be read: what can't be named
 * isn't offered.
 */
interface Snapshot {
  path: string
  branch: string | null
  head: string
  into: string | null
  intoTip: string | null
  ahead: number
  dirty: number
  files: string
}

/** Entries a fingerprint walks at most, and bytes it reads: a bigger folder isn't fingerprinted (Remove anyway refuses). */
const SNAPSHOT_MAX_ENTRIES = 300_000
const SNAPSHOT_MAX_BYTES = 4 * 1024 ** 3

/**
 * Every entry of a worktree's folder (its `.git` file aside) as it is: each path and kind, a file's whole content
 * (streamed, ignored and large ones too), a link's target; plus its git index as git lists it (staged content: mode,
 * blob and stage per path). Two fingerprints are the same only when nothing a forced removal would discard differs.
 * Throws when anything can't be read, or the folder is past the bounds.
 */
async function fingerprint(root: string): Promise<string> {
  const h = createHash('sha256')
  const index = await gitReading(root, ['ls-files', '--stage', '-z'])
  if (!index.ok) throw new Error(tr(msg({ id: 'main.unused.noIndex', defaultMessage: "git couldn't list its index ({why})", description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds. {why} is git's message. index is git's term." }), { why: index.err.split(/\r?\n/)[0] || tr(msg({ id: 'main.unused.gitFailed', defaultMessage: '{command} failed', description: "Why git couldn't do something, when it said nothing itself. {command} is the git command: keep it." }), { command: 'ls-files' }) }))
  h.update('index\0').update(index.buf)
  let entries = 0
  let bytes = 0
  const dirs = ['']
  const found: { rel: string; kind: 'd' | 'f' | 'l' }[] = []
  while (dirs.length) {
    const rel = dirs.pop()!
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      // The worktree's .git file is git's, not the work's.
      if (!rel && e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const kind = e.isSymbolicLink() ? 'l' : e.isDirectory() ? 'd' : 'f'
      if (++entries > SNAPSHOT_MAX_ENTRIES) throw new Error(tr(msg({ id: 'main.unused.tooMany', defaultMessage: 'it holds more than {n, number} files and folders, too many to check', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause. {n} is the limit." }), { n: SNAPSHOT_MAX_ENTRIES }))
      found.push({ rel: r, kind })
      if (kind === 'd') dirs.push(r)
    }
  }
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  for (const f of found) {
    h.update(`\n${f.kind}\0${f.rel}\0`)
    const abs = join(root, f.rel)
    if (f.kind === 'l') h.update(await readlink(abs))
    else if (f.kind === 'f') {
      const size = (await lstat(abs)).size
      if ((bytes += size) > SNAPSHOT_MAX_BYTES) throw new Error(tr(msg({ id: 'main.unused.tooBig', defaultMessage: 'it holds more than {n, number} GB of files, too much to check', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause. {n} is the limit." }), { n: SNAPSHOT_MAX_BYTES / 1024 ** 3 }))
      h.update(`${size}\0`)
      await new Promise<void>((res, rej) => {
        const s = createReadStream(abs)
        s.on('data', (chunk) => h.update(chunk))
        s.on('error', rej)
        s.on('end', () => res())
      })
    }
  }
  return h.digest('hex')
}

/** The snapshot of an unused worktree as it is now; throws (saying why) when git or the folder can't say. */
async function snapshot(projectPath: string, path: string): Promise<Snapshot> {
  const fail = (why: string): never => {
    throw new Error(tr(msg({ id: 'main.unused.cantCheck', defaultMessage: "Hive couldn't check what it holds: {why}", description: "An error asking to Remove anyway one of the Overview's unused worktrees (Remove, Remove anyway, Merge). {why} says why (main.unused.read.*, or git's message)." }), { why: gitProblem() ?? why }))
  }
  const head = await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const tip = head.ok ? head.out.trim() : ''
  if (!tip) fail(tr(msg({ id: 'main.unused.read.head', defaultMessage: 'git could not read its HEAD', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause (main.unused.cantCheck). HEAD is git's term." })))
  const sym = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  // Exit 1 with nothing said: detached. Anything else that fails: can't tell.
  if (!sym.ok && !(sym.code === 1 && !sym.err)) fail(tr(msg({ id: 'main.unused.read.branch', defaultMessage: 'git could not read its branch', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause (main.unused.cantCheck)." })))
  const branch = sym.ok ? sym.out.trim() : null
  // Strictly: a main branch git couldn't look for is not "none" (that would count the commits against no branch).
  let into: string | null = null
  try {
    into = await wt.primaryBranchStrict(projectPath)
  } catch (e) {
    fail((e as Error).message)
  }
  const intoTip = into ? await wt.tipOf(projectPath, into) : null
  if (into && !intoTip) fail(tr(msg({ id: 'main.unused.read.base', defaultMessage: 'git could not read {branch}', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause (main.unused.cantCheck). {branch} is the project's main branch." }), { branch: into }))
  // On a branch: its commits not on the main branch (a squash merge counting). Detached, or no main branch: the commits
  // no branch, tag or remote branch has.
  const ahead = branch && intoTip ? await wt.unmergedCommits(projectPath, intoTip, tip) : await unreferencedCommits(path, branch ?? undefined)
  if (ahead === null) fail(tr(msg({ id: 'main.unused.read.commits', defaultMessage: 'git could not count its commits', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause (main.unused.cantCheck)." })))
  const dirty = await wt.dirtyCount(path)
  if (dirty === null) fail(tr(msg({ id: 'main.unused.read.status', defaultMessage: 'git status failed', description: "Why Hive couldn't check what one of the Overview's unused worktrees (Remove, Remove anyway, Merge) holds: a clause (main.unused.cantCheck). git status is a command: keep it." })))
  let files = ''
  try {
    files = await fingerprint(path)
  } catch (e) {
    fail((e as Error).message)
  }
  return { path: realPath(resolve(path)), branch, head: tip, into, intoTip, ahead: ahead!, dirty: dirty!, files }
}

/** Previews shown in a Remove anyway confirmation, by token: good for 15 minutes, at most 50 kept, each used once. */
const previews = new Map<string, { project: string; at: number; snap: Snapshot }>()
export const PREVIEW_MS = 15 * 60_000

/**
 * A preview's token presented to remove (#373): taken off the list whatever comes of the removal (used once), and
 * refused once older than PREVIEW_MS, whether or not another preview has pruned it yet.
 */
function takePreview(token: string): { ok: true; preview: { project: string; at: number; snap: Snapshot } } | { ok: false; reason: string } {
  const shown = previews.get(token)
  previews.delete(token)
  if (!shown) return { ok: false, reason: tr(msg({ id: 'main.unused.notChecked', defaultMessage: 'what it holds was not checked for this removal', description: "Why Remove anyway did nothing to one of the Overview's unused worktrees (Remove, Remove anyway, Merge): the confirmation was not for it. A clause; the window then looks again and asks again, saying this." })) }
  if (Date.now() - shown.at > PREVIEW_MS)
    return {
      ok: false,
      reason: tr(msg({ id: 'main.unused.stale', defaultMessage: '{n, plural, one {what it holds was checked more than # minute ago} other {what it holds was checked more than # minutes ago}}', description: "Why Remove anyway did nothing to one of the Overview's unused worktrees (Remove, Remove anyway, Merge): the confirmation was too old. {n} is how many minutes it lasts. A clause; the window then looks again and asks again, saying this." }), { n: PREVIEW_MS / 60_000 })
    }
  return { ok: true, preview: shown }
}

/**
 * Remove anyway's confirmation (#353): what removing the worktree loses, from a snapshot kept under a token that the
 * removal must present. Throws when what it holds can't be established (then there is nothing to confirm).
 */
export async function removalPreview(projectPath: string, path: string): Promise<UnusedWorktreePreview> {
  projectPath = workspace.assertProject(projectPath)
  const listed = (await wt.listWorktrees(projectPath)).find((w) => key(w.path) === key(path))
  if (!listed || key(listed.path) === key(projectPath)) throw new Error(gitProblem() ?? tr(msg({ id: 'main.unused.why.notListed', defaultMessage: "git doesn't list it as one of the project's worktrees", description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause." })))
  const why = await unsafe(projectPath, listed.path)
  if (why) throw new Error(tr(msg({ id: 'main.unused.refused', defaultMessage: "Hive doesn't remove it: {why}.", description: "An error asking to Remove anyway one of the Overview's unused worktrees (Remove, Remove anyway, Merge). {why} says why (main.unused.why.*)." }), { why }))
  const snap = await snapshot(projectPath, listed.path)
  const now = Date.now()
  for (const [k, p] of previews) if (now - p.at > PREVIEW_MS) previews.delete(k)
  while (previews.size >= 50) previews.delete(previews.keys().next().value!)
  const token = randomUUID()
  previews.set(token, { project: key(projectPath), at: now, snap })
  return { token, path: listed.path, branch: snap.branch, lost: lostLines({ path: listed.path, branch: snap.branch, into: snap.into, ahead: snap.ahead, dirty: snap.dirty }) }
}

/** What each snapshot field is, for the refusal. */
const SNAPSHOT_FIELD: Record<keyof Snapshot, Msg> = {
  path: msg({ id: 'main.unused.field.path', defaultMessage: 'its folder', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  branch: msg({ id: 'main.unused.field.branch', defaultMessage: 'its branch', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  head: msg({ id: 'main.unused.field.head', defaultMessage: 'its commit', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  into: msg({ id: 'main.unused.field.into', defaultMessage: 'the main branch', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  intoTip: msg({ id: 'main.unused.field.intoTip', defaultMessage: "the main branch's commit", description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  ahead: msg({ id: 'main.unused.field.ahead', defaultMessage: 'its unmerged commits', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  dirty: msg({ id: 'main.unused.field.dirty', defaultMessage: 'its uncommitted files', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." }),
  files: msg({ id: 'main.unused.field.files', defaultMessage: 'its files', description: "What changed in one of the Overview's unused worktrees (Remove, Remove anyway, Merge) since the user was shown it, in a list (main.unused.changed)." })
}

/**
 * Removes an unused worktree (#353), the user's choice from the Overview. Reserved first, so no agent can be given it
 * meanwhile (`reserveForRemoval`, which addAgent and template loads check under the project file's lock), then refused
 * if git no longer lists it, an agent works in it, or it is a folder Hive never deletes. Without `force` (Remove), only
 * a merged, clean one, checked now (`worktreeCheck`, then `removeCheckedWorktree`: never --force, its branch deleted only
 * from the commit checked, and only while the main branch the user was shown, `expectInto`, still holds it). With
 * `force` (Remove anyway), the token of the preview the user confirmed (used once, and only within PREVIEW_MS of it,
 * #373): the worktree is snapshotted again and removed only
 * if nothing differs (folder, branch, commit, main branch, every file); then the folder (forced) and the branch the
 * preview named, only from the commit it showed.
 */
export async function removeUnusedWorktree(projectPath: string, path: string, opts: { expectInto?: string | null; force?: string } = {}): Promise<UnusedWorktreeRemoval> {
  projectPath = workspace.assertProject(projectPath)
  // The token is spent now, whatever happens next: a refused removal asks for a new look.
  const taken = opts.force !== undefined ? takePreview(opts.force) : null
  let release: () => void
  try {
    release = reserveForRemoval(path)
  } catch (e) {
    return { deleted: false, reason: (e as Error).message }
  }
  try {
    const listed = (await wt.listWorktrees(projectPath)).find((w) => key(w.path) === key(path))
    if (!listed || key(listed.path) === key(projectPath)) return { deleted: false, reason: gitProblem() ?? tr(msg({ id: 'main.unused.why.notListed', defaultMessage: "git doesn't list it as one of the project's worktrees", description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause." })) }
    const why = await unsafe(projectPath, listed.path)
    if (why) return { deleted: false, reason: why }
    // Under the project file's lock, after the reservation: an agent given it before keeps it; none can be from now on.
    let owned = false
    await workspace.mutateProjectConfig(projectPath, (now) => {
      owned = projectAgents(now).some((a) => a.worktree && key(a.worktree.path) === key(listed.path))
      return {}
    })
    if (owned) return { deleted: false, reason: tr(msg({ id: 'main.unused.why.owned', defaultMessage: 'an agent works in it now', description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause." })) }
    let done: UnusedWorktreeRemoval
    if (opts.force !== undefined) {
      // Refusals a new look settles are marked `lookAgain` (#377): the window checks again and asks again.
      if (!taken?.ok) return { deleted: false, lookAgain: true, reason: taken?.reason ?? tr(msg({ id: 'main.unused.notChecked', defaultMessage: 'what it holds was not checked for this removal', description: "Why Remove anyway did nothing to one of the Overview's unused worktrees (Remove, Remove anyway, Merge): the confirmation was not for it. A clause; the window then looks again and asks again, saying this." })) }
      const shown = taken.preview
      if (shown.project !== key(projectPath) || shown.snap.path !== realPath(resolve(listed.path))) return { deleted: false, lookAgain: true, reason: tr(msg({ id: 'main.unused.notChecked', defaultMessage: 'what it holds was not checked for this removal', description: "Why Remove anyway did nothing to one of the Overview's unused worktrees (Remove, Remove anyway, Merge): the confirmation was not for it. A clause; the window then looks again and asks again, saying this." })) }
      let now: Snapshot
      try {
        now = await snapshot(projectPath, listed.path)
      } catch (e) {
        return { deleted: false, reason: (e as Error).message }
      }
      const changed = (Object.keys(now) as (keyof Snapshot)[]).filter((k) => now[k] !== shown.snap[k])
      if (changed.length)
        return {
          deleted: false,
          lookAgain: true,
          reason: tr(msg({ id: 'main.unused.changed', defaultMessage: 'it changed since you were shown what it holds ({changed})', description: "Why Remove anyway did nothing to one of the Overview's unused worktrees (Remove, Remove anyway, Merge). {changed} lists what changed (main.unused.field.*). A clause; the window then looks again and asks again, saying this." }), { changed: fmt.list(changed.map((k) => tr(SNAPSHOT_FIELD[k]))) })
        }
      const snap = shown.snap
      await wt.removeWorktree(projectPath, { path: listed.path, branch: snap.branch ?? '', base: '' }, false)
      // The branch shown, and only from the commit shown (git refuses otherwise).
      const branch = snap.branch ? await git(projectPath, ['update-ref', '-d', `refs/heads/${snap.branch}`, snap.head]) : null
      done = branch && !branch.ok ? { deleted: true, branchKept: true, reason: tr(msg({ id: 'main.unused.branchKept', defaultMessage: 'git kept {branch}: {why}', description: "After Remove anyway removed one of the Overview's unused worktrees (Remove, Remove anyway, Merge): its branch, {branch}, stayed. {why} is git's message." }), { branch: snap.branch ?? '', why: branch.err.split(/\r?\n/)[0] || tr(msg({ id: 'main.unused.gitFailed', defaultMessage: '{command} failed', description: "Why git couldn't do something, when it said nothing itself. {command} is the git command: keep it." }), { command: 'update-ref' }) }) } : { deleted: true }
      log.info(`Removed unused worktree ${userText(listed.path)} anyway (${snap.ahead} commits only it held, ${snap.dirty} uncommitted files)`)
    } else {
      if (!listed.branch) return { deleted: false, reason: tr(msg({ id: 'main.unused.why.detached', defaultMessage: 'it is not on a branch (detached HEAD)', description: "Why Hive won't remove or merge one of the Overview's unused worktrees (Remove, Remove anyway, Merge): a clause. detached HEAD is git's term." })) }
      const tree: AgentWorktree = { path: listed.path, branch: listed.branch, base: '' }
      const check = await wt.worktreeCheck(projectPath, tree)
      done = await wt.removeCheckedWorktree(projectPath, tree, check, opts.expectInto).catch((e: Error) => ({ deleted: false, reason: e.message.split('\n')[0] }))
    }
    if (done.deleted) {
      // A removed worktree's setup isn't pending any more.
      await workspace.mutateProjectConfig(projectPath, (now) => (Array.isArray(now.setupPending) ? { setupPending: now.setupPending.filter((p) => typeof p !== 'string' || key(p) !== key(listed.path)) } : {}))
    }
    return done
  } finally {
    release()
  }
}
