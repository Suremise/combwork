// A folder's uncommitted changes, committed or set aside (HI-2944), the Git side of port 5's `folderChanges`: from a
// merge the queue paused on them, from a start's warning, and Files' Commit it after a shared exclude. Combwork acts only
// on what the window was shown, in a folder it finds itself (where the target is checked out: never one the window
// names), and checks everything again under the repository lock and that folder's fence, the queue's own order:
// the checkout, its branch, no git operation under way, no agent or run working there, and every path shown still
// changed. Nothing Git would allow is refused otherwise. A failure loses nothing: a refused commit leaves the files and
// the index as they were, and a stash git made before it failed is kept and named. A deletion the user staged (Files'
// Stop Tracking, `git rm --cached`) is committed as that deletion, never the file added back (HI-2982).
import { copyFile, lstat, open, rename, rm } from 'original-fs/promises'
import { join, resolve } from 'path'
import type { FolderChangeAction, FolderChangesDone } from '../shared/types'
import { agentMsg, say } from '../shared/agentText'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { changingFolder, inFolder } from './folderFence'
import { INDEX_BUSY, git, gitErrorLine } from './git'
import { busyAgentIn } from './gitRepo'
import { filesRepo } from './filesGit'
import { createLogger, userText } from './logger'
import { checkouts, OPERATION_MARKERS, worktreeNow } from './platform/git'
import { isUnknown } from './platform/types'
import { withRepoLock } from './repoLock'
import { workspace } from './workspace'

const log = createLogger('folder-changes')

const M = {
  noTarget: msg({ id: 'service.folderChanges.noTarget', defaultMessage: "{target} isn't checked out in a folder of this project now: nothing to commit or set aside there.", description: "HI-2944: an error from Commit or Set aside (a paused merge, a start's warning): the branch {target} isn't checked out anywhere now." }),
  moved: msg({ id: 'service.folderChanges.moved', defaultMessage: 'Where {target} is checked out changed meanwhile. Look again.', description: 'HI-2944: an error from Commit or Set aside: the folder the branch {target} is checked out in changed while Combwork waited to act; nothing was done.' }),
  wrongBranch: msg({ id: 'service.folderChanges.wrongBranch', defaultMessage: "{folder} isn't on {target} now. Look again.", description: 'HI-2944: an error from Commit or Set aside: the folder ({folder}, a path) is on another branch than {target} now; nothing was done.' }),
  detached: msg({ id: 'service.folderChanges.detached', defaultMessage: "{folder} isn't on a branch, so Combwork doesn't commit there.", description: "HI-2944: an error from Commit it (Files) or Commit: the folder ({folder}, a path) has a detached HEAD (git's term), so nothing is committed." }),
  midOperation: msg({ id: 'service.folderChanges.midOperation', defaultMessage: 'Git is in the middle of {state, select, merge {a merge} rebase {a rebase} cherryPick {a cherry-pick} other {a revert}} in {folder}. Finish or abort it first.', description: 'HI-2944: an error from Commit or Set aside: a git operation is under way in the folder ({folder}, a path); nothing was done.' }),
  agentBusy: msg({ id: 'service.folderChanges.agentBusy', defaultMessage: '{agent} is working in {folder}. Try again once it has finished.', description: 'HI-2944: an error from Commit or Set aside: an agent ({agent}) works in the folder ({folder}, a path); nothing was done.' }),
  busy: msg({ id: 'service.folderChanges.busy', defaultMessage: 'An agent or a run is working in {folder} ({what}). Try again once it has finished.', description: "HI-2944: an error from Commit or Set aside: an agent holds files or a run works in the folder ({folder}, a path); {what} names the first file or run's folder; nothing was done." }),
  changed: msg({ id: 'service.folderChanges.changed', defaultMessage: "The changes in {folder} aren't the ones shown any more. Look again.", description: 'HI-2944: an error from Commit or Set aside: a file shown is no longer changed in the folder ({folder}, a path), or none was shown; nothing was done.' }),
  nothing: msg({ id: 'service.folderChanges.nothing', defaultMessage: '{file} has no changes to commit.', description: "HI-2944: an error from Files' Commit it after Exclude from Git: the ignore file ({file}, such as .gitignore) has no uncommitted change." }),
  readFailed: msg({ id: 'service.folderChanges.readFailed', defaultMessage: "Git could not read the folder's changes: {why}", description: "HI-2944: an error from Commit or Set aside: git status failed; {why} is git's own message (English). Nothing was done." }),
  unplaced: msg({ id: 'service.folderChanges.unplaced', defaultMessage: "Git didn't say which repository {folder} is in, so Combwork doesn't commit .gitignore while it can't check the agents working there. Try again.", description: "HI-2962: an error from Files' Commit it after Exclude from Git: a project folder ({folder}, a path) inside the same repository couldn't be placed by git (it answered nothing), so nothing was committed. Keep .gitignore: a file name." }),
  indexBusy: msg({ id: 'service.folderChanges.indexBusy', defaultMessage: 'Another git command is using the repository. Try again in a moment.', description: "HI-2944: an error from Commit or Set aside: git's index is locked by another git command." }),
  commitFailed: msg({ id: 'service.folderChanges.commitFailed', defaultMessage: 'Git did not commit: {why}', description: "HI-2944: an error from Commit: git (or a hook, or signing) refused the commit; {why} is its own message (English). The files are as they were." }),
  stashFailed: msg({ id: 'service.folderChanges.stashFailed', defaultMessage: 'Git did not set the changes aside: {why}', description: "HI-2944: an error from Set aside: git refused to stash the changes; {why} is its own message (English). The files are as they were." }),
  deletedKept: msg({ id: 'service.folderChanges.deletedKept', defaultMessage: '{file} is taken out of Git but still in the folder: setting it aside would replace it with the copy last committed. Commit it instead, which keeps it out of Git and leaves the file as it is.', description: "HI-2982: an error from Set aside (a paused merge, a start's warning): the file ({file}, a path) had its deletion staged (Files' Stop Tracking) and is still on disk, so a stash would overwrite it with the committed copy; nothing was done. Commit is the button beside Set aside." }),
  stashPartial: msg({ id: 'service.folderChanges.stashPartial', defaultMessage: 'Git reported a problem while setting the changes aside, after keeping them in a stash ({stash}). Check git stash list and the files before going on. Git said: {why}', description: "HI-2944: an error from Set aside: git stashed the changes (the stash's id, {stash}) but then failed; the user checks the stash and the files. {why} is git's own message (English). Keep git stash list as it is: a command." })
}

/** What changes the folder, as its fence names it: the log, and an agent's reply refused meanwhile (agent-facing). */
const FENCE = {
  commit: agentMsg({ id: 'folderChanges.fence.commit', text: 'a commit of changes the user chose', note: "HI-2944: what changes a folder while the user's Commit runs there (a paused merge, a start's warning): Combwork types nothing into an agent there meanwhile." }),
  setAside: agentMsg({ id: 'folderChanges.fence.setAside', text: 'setting aside changes the user chose', note: "HI-2944: what changes a folder while the user's Set aside (a git stash) runs there." }),
  ignore: agentMsg({ id: 'folderChanges.fence.ignore', text: 'a commit of .gitignore', note: "HI-2944: what changes the project folder while Files' Commit it commits .gitignore." })
}

/** The most a commit or stash may take: a hook or a signer can wait; a bound for a hung one, never how long it should take. */
const ACT_MS = 120_000

/** The environment of these commits: no prompt is ever waited on (a passphrase, credentials, a credential manager). */
const quietEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' })

/** A repository-relative path as a pathspec that names exactly it, from the top whatever the folder. */
const literal = (rel: string): string => `:(top,literal)${rel}`

/** The markers worktreeNow lists for an operation under way, as the refusal names it. */
const STATES: Record<string, string> = { '(MERGE_HEAD)': 'merge', '(rebase-merge)': 'rebase', '(rebase-apply)': 'rebase', '(CHERRY_PICK_HEAD)': 'cherryPick', '(REVERT_HEAD)': 'revert' }

/**
 * One path git reports changed. `untracked`: git lists it as untracked (`??`). `deleted`: its index entry is gone (a
 * staged deletion, or a rename's old side), whatever is on disk: Stop Tracking leaves the file there, often also listed
 * untracked, so a path can be both (HI-2982). `from`: a rename's or copy's other side.
 */
interface Changed {
  untracked: boolean
  deleted?: boolean
  from?: string
}

/** What git status reports changed in a folder, by repository-relative path (`--porcelain=v1 -z`: renames' both sides). */
export async function changedIn(folder: string): Promise<Map<string, Changed>> {
  const r = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!r.ok) throw INDEX_BUSY.test(r.err) ? combworkError(M.indexBusy) : combworkError(M.readFailed, { why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) })
  const out = new Map<string, Changed>()
  // A path listed twice (`D ` and `??`) keeps what each line says, never only the last.
  const put = (path: string, c: Changed): void => {
    const was = out.get(path)
    const deleted = c.deleted || was?.deleted
    const from = c.from ?? was?.from
    out.set(path, { untracked: c.untracked || !!was?.untracked, ...(deleted ? { deleted } : {}), ...(from ? { from } : {}) })
  }
  const parts = r.out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const path = e.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') {
      const from = parts[++i]
      put(path, { untracked: false, from })
      if (from && xy[0] === 'R') put(from, { untracked: false, deleted: true })
    } else put(path, { untracked: xy === '??', deleted: xy[0] === 'D' })
  }
  return out
}

/** The window's list as repository-relative paths: strings, `/` separated, no `.` or `..`, each once. */
function cleanShown(shown: unknown): string[] {
  const list = Array.isArray(shown) ? shown : []
  const out = list.filter((p): p is string => typeof p === 'string').map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
  return [...new Set(out.filter((p) => p && !p.split('/').some((s) => s === '..' || s === '.' || s === '') && !/^\.git(\/|$)/i.test(p)))]
}

function failed(m: (typeof M)['commitFailed'] | (typeof M)['stashFailed'], err: string): Error {
  if (INDEX_BUSY.test(err)) return combworkError(M.indexBusy)
  return combworkError(m, { why: gitErrorLine(err) || err.trim().slice(0, 400) })
}

const samePlace = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * Under the lock and the fence: the folder still on `branch` (null: any branch, never a detached HEAD), no operation
 * under way, no agent or run working there. `agentsAt`: the projects whose agents count, each with the folder they'd
 * work in (the folder's own project's agents there, unless the caller names more). Throws the refusal, in the
 * window's words.
 */
async function assertQuiet(projectPath: string, folder: string, branch: string | null, agentsAt: readonly { project: string; folder: string }[] = [{ project: projectPath, folder }]): Promise<string> {
  const now = await worktreeNow(folder)
  if (isUnknown(now)) throw failed(M.commitFailed, now.detail ?? now.what)
  if (!now.line) throw combworkError(M.detached, { folder })
  if (branch !== null && now.line !== branch) throw combworkError(M.wrongBranch, { folder, target: branch })
  const marker = now.dirty.find((f) => OPERATION_MARKERS.has(f))
  if (marker) throw combworkError(M.midOperation, { state: STATES[marker] ?? 'revert', folder })
  const { folderBuilders } = await import('./workflow/queueHost')
  const held = folderBuilders(workspace, folder)
  if (held) throw combworkError(M.busy, { folder, what: held[0] })
  for (const at of agentsAt) {
    const agent = await busyAgentIn(at.project, at.folder)
    if (agent) throw combworkError(M.agentBusy, { agent, folder: at.folder })
  }
  return now.line
}

/**
 * Copies the folder's index to `to`: true when copied, false when there is no index (a repository that has none yet,
 * an empty index). Any other failure throws, as a refused commit: a copy that failed is never taken for an empty index.
 */
async function copyIndex(index: string, to: string): Promise<boolean> {
  try {
    await copyFile(index, to)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !(await lstat(index).then(() => true, () => false))) return false
    throw failed(M.commitFailed, `could not copy the index: ${(e as Error).message}`) // i18n-ignore: stands in for git's own (English) words
  }
}

/** How often, and how far apart, the folder's new index is tried as it is published (Windows refuses a rename while
 * another process has the file open for a moment). */
const PUBLISH_TRIES = 5
const PUBLISH_RETRY_MS = 100

/**
 * Commits `files` (repository-relative, as status reports them) in `folder` (a working tree's top), those paths only.
 * Git does the index work wherever it can (the Assistant's design note, round 3): `commit --only`, unless a path's
 * deletion is staged while its file is still in the folder (Stop Tracking), which `commit --only` would add back with
 * its local content (HI-2982); only then is the commit built in an index of Combwork's (commitKeepingDeletions).
 */
async function commitPaths(folder: string, files: string[], now: Map<string, Changed>, message: string): Promise<string> {
  for (const p of files) if (now.get(p)?.deleted && (await lstat(join(folder, p)).then(() => true, () => false))) return commitKeepingDeletions(folder, files, now, message)
  return commitOnly(folder, files, files.filter((p) => now.get(p)?.untracked && !now.get(p)?.deleted), message)
}

/**
 * `files` committed by git alone: an untracked one added as intent-to-add first (undone again if the commit fails, only
 * those this call added), then `commit --only`, which commits their working-tree content through a temporary index of
 * git's, under git's own index lock, and leaves every other index entry as it was. Never given a staged deletion whose
 * file is still in the folder (commitPaths).
 */
async function commitOnly(folder: string, files: string[], untracked: string[], message: string): Promise<string> {
  if (untracked.length) {
    const add = await git(folder, ['add', '--intent-to-add', '--', ...untracked.map(literal)])
    if (!add.ok) throw failed(M.commitFailed, add.err)
  }
  const r = await git(folder, ['commit', '--only', '--quiet', '-m', message, '--', ...files.map(literal)], undefined, undefined, { env: quietEnv(), timeout: ACT_MS })
  if (!r.ok) {
    // The files as they were: the intent-to-add entries this call made taken out again (the working tree never touched).
    if (untracked.length) await git(folder, ['reset', '--quiet', '--', ...untracked.map(literal)])
    throw failed(M.commitFailed, `${r.err}\n${r.out}`)
  }
  const head = await git(folder, ['rev-parse', 'HEAD'])
  return head.out.trim()
}

/**
 * Commits `files` as `commit --only` would but keeping a staged deletion whose file is still in the folder (HI-2982):
 * `commit --only` takes each path from the folder, so a file the user stopped tracking went back into Git with its
 * local content.
 *
 * Under the folder's own index lock throughout, as git's own commit holds it (HR1's round 1): `index.lock` taken first
 * (held by another git: refused, nothing done), so no other git writes the index from the snapshot to the end. The
 * commit is built in an index of its own: HEAD's tree (read over a copy of the index, so unchanged files keep their stat
 * data), each path taken as the folder has it (`update-index --add --remove`: added, changed, or gone from disk), except
 * a path whose index entry is gone, which is committed as gone; committed from it (hooks and signing as any commit). The
 * folder's new index (a copy with those paths brought to the commit, `reset -- <paths>`) is written into the lock and
 * renamed over the index, as git publishes one. A refused commit leaves the index and files untouched; a failure after
 * the commit puts the branch back where it was (only if still at the new commit) and refuses, never a success with the
 * index and HEAD apart. Both copies of the index are made before the commit, and only a missing index counts as none
 * (HR1's round 2).
 */
async function commitKeepingDeletions(folder: string, files: string[], now: Map<string, Changed>, message: string): Promise<string> {
  const gone = files.filter((p) => now.get(p)?.deleted)
  const taken = files.filter((p) => !now.get(p)?.deleted)
  const at = await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!at.ok || !at.out.trim()) throw failed(M.commitFailed, at.err || 'git did not name its index') // i18n-ignore: stands in for git's own (English) words
  const index = at.out.trim()
  const lock = `${index}.lock`
  const stamp = `${process.pid}-${Date.now().toString(36)}`
  const building = `${index}.cw-commit-${stamp}`
  const next = `${index}.cw-next-${stamp}`
  // update-index takes paths as they are (no pathspec magic), from the top; a nested repository is listed with a `/`.
  const plain = (p: string): string => p.replace(/\/+$/, '')
  let held = await open(lock, 'wx').catch(() => null)
  if (!held) throw combworkError(M.indexBusy)
  let published = false
  try {
    // HEAD read for certain (HR2's round 3): a staged deletion is of a file HEAD has, so there is always one here, and a
    // read that fails refuses: never taken for an unborn branch, whose empty tree would commit every other file deleted.
    const before = await git(folder, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const was = before.ok ? before.out.trim() : ''
    if (!/^[0-9a-f]{40,64}$/.test(was)) throw failed(M.commitFailed, before.err || 'git could not read HEAD') // i18n-ignore: stands in for git's own (English) words
    const env = { ...quietEnv(), GIT_INDEX_FILE: building }
    // Both copies of the index made before anything is committed (HR1's round 2): one the commit is built over, one the
    // folder's new index is made from. Only an index that isn't there (a repository with none yet) is no copy; any
    // other failure refuses here, nothing committed, never an index made from part of it.
    const copied = await copyIndex(index, building)
    if (copied !== (await copyIndex(index, next))) throw failed(M.commitFailed, 'the index changed while it was copied') // i18n-ignore: stands in for git's own (English) words
    if (!copied) throw failed(M.commitFailed, 'the repository has no index') // i18n-ignore: stands in for git's own (English) words
    // The tree of the HEAD read, by its id (never `HEAD` read again).
    let base = await git(folder, ['read-tree', '-m', was], undefined, undefined, { env })
    // A copied index git can't merge from (an unmerged entry): that tree alone.
    if (!base.ok) base = await git(folder, ['read-tree', was], undefined, undefined, { env })
    if (!base.ok) throw failed(M.commitFailed, base.err)
    if (taken.length) {
      const add = await git(folder, ['update-index', '--add', '--remove', '--', ...taken.map(plain)], undefined, undefined, { env })
      if (!add.ok) throw failed(M.commitFailed, add.err)
    }
    if (gone.length) {
      const del = await git(folder, ['update-index', '--force-remove', '--', ...gone.map(plain)], undefined, undefined, { env })
      if (!del.ok) throw failed(M.commitFailed, del.err)
    }
    const r = await git(folder, ['commit', '--quiet', '-m', message], undefined, undefined, { env, timeout: ACT_MS })
    if (!r.ok) throw failed(M.commitFailed, `${r.err}\n${r.out}`)
    // HEAD is this commit only when proved (HR2's round 3): read for certain, its parent the HEAD read and its tree the
    // one committed (git leaves the committed state in the index it was given). Another moving the branch around it
    // (which needs no index lock) leaves HEAD at a commit that isn't provably this one: then the branch is never moved
    // (a take-back could drop their commit), nothing more is written, and it is refused, saying to look at the history.
    const tree = await git(folder, ['write-tree'], undefined, undefined, { env })
    const after = await git(folder, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const made = after.ok ? after.out.trim() : ''
    const id = (r: { ok: boolean; out: string }): string => (r.ok && /^[0-9a-f]{40,64}$/.test(r.out.trim()) ? r.out.trim() : '')
    const ours =
      !!made && !!id(tree) && id(await git(folder, ['rev-parse', '--verify', `${made}^1`])) === was && id(await git(folder, ['rev-parse', '--verify', `${made}^{tree}`])) === id(tree)
    if (!ours) {
      log.warn(`Committed in ${userText(folder)}, but HEAD (${made || 'unread'}) isn't provably that commit: nothing taken back`)
      throw failed(M.commitFailed, 'the branch moved while the commit was made: look at git log before going on') // i18n-ignore: stands in for git's own (English) words
    }
    try {
      // The folder's index as the commit has those paths (a deletion's entry is gone already), from its copy made under
      // the lock before the commit: what `commit --only` leaves.
      if (taken.length) {
        const sync = await git(folder, ['reset', '--quiet', made, '--', ...taken.map(literal)], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: next } })
        if (!sync.ok) throw new Error(sync.err.trim() || 'git reset failed') // i18n-ignore: git's own words, or the command
      }
      await held.close()
      held = null
      await rename(next, lock)
      let last: Error | null = null
      for (let tries = 0; tries < PUBLISH_TRIES && !published; tries++) {
        try {
          await rename(lock, index)
          published = true
        } catch (e) {
          last = e as Error
          await new Promise((res) => setTimeout(res, PUBLISH_RETRY_MS))
        }
      }
      if (!published) throw last ?? new Error('the index could not be written') // i18n-ignore: a reason, log- and git-facing
    } catch (e) {
      // HEAD back where it was, only if still at this commit, proved this call's (compare and swap), the index never
      // written: as before.
      const back = await git(folder, ['update-ref', '-m', 'Combwork: put back, its index not written', 'HEAD', was, made])
      log.warn(`Committed in ${userText(folder)} but couldn't finish (${userText((e as Error).message)}); ${back.ok ? 'the commit was taken back' : `the commit couldn't be taken back: ${userText(back.err.trim())}`}`)
      throw failed(M.commitFailed, (e as Error).message)
    }
    return made
  } finally {
    await held?.close().catch(() => undefined)
    await rm(building, { force: true }).catch(() => undefined)
    await rm(next, { force: true }).catch(() => undefined)
    if (!published) await rm(lock, { force: true }).catch(() => undefined)
  }
}

/**
 * A path in `files` whose deletion is staged while its file is still in the folder (HI-2982): a stash puts the committed
 * copy back over it. Ignored, git refuses that after making the stash, every time; listed untracked too, the user's
 * file is replaced, kept only in the stash, which then can't be popped over the copy. Null when there is none.
 */
async function keptDeleted(folder: string, files: string[], now: Map<string, Changed>): Promise<string | null> {
  for (const p of files) {
    const c = now.get(p)
    if (!c?.deleted) continue
    if (await lstat(join(folder, p)).then(() => true, () => false)) return p
  }
  return null
}

/** The stash ref's object now (null: no stash). */
async function stashTop(folder: string): Promise<string | null> {
  const r = await git(folder, ['rev-parse', '-q', '--verify', 'refs/stash'])
  return r.ok ? r.out.trim() || null : null
}

/**
 * Sets `files` aside as a named stash (`git stash push --include-untracked -- <paths>`): only those paths, other index
 * entries as they were. The stash made is told by the stash ref moving to a new object (never by its message: an older
 * one can have the same). A failure after git made it is said with the stash, kept: never rolled back.
 */
async function setAsidePaths(folder: string, files: string[], message: string): Promise<string> {
  const before = await stashTop(folder)
  const r = await git(folder, ['stash', 'push', '--include-untracked', '--quiet', '-m', message, '--', ...files.map(literal)], undefined, undefined, { env: quietEnv(), timeout: ACT_MS })
  const after = await stashTop(folder)
  const made = after && after !== before ? after : null
  if (!r.ok) {
    if (made) {
      log.warn(`A stash was made in ${userText(folder)} before git failed: ${made}`)
      throw combworkError(M.stashPartial, { stash: made.slice(0, 12), why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) })
    }
    throw failed(M.stashFailed, r.err)
  }
  if (!made) throw failed(M.stashFailed, r.err || r.out || 'no stash was made') // i18n-ignore: stands in for git's own (English) words
  return made
}

/**
 * Commits or sets aside exactly `shown` in the folder `target` is checked out in (port 5's settleChanges): the folder
 * found from the project's own repository, then everything checked again under the lock and its fence before git runs.
 * `label` names why, in the commit's or stash's message (`before merging HI-12`).
 */
export async function settleChanges(projectPath: string, target: string, shownFolder: string, action: FolderChangeAction, shownIn: unknown, label: string, guard?: () => void): Promise<FolderChangesDone> {
  projectPath = workspace.assertProject(projectPath)
  const shown = cleanShown(shownIn)
  const where = await checkouts(projectPath)
  if (isUnknown(where)) throw failed(M.commitFailed, where.detail ?? where.what)
  const seen = where[target]
  if (!seen) throw combworkError(M.noTarget, { target })
  // Only where the user was shown the changes: the target checked out elsewhere since (another folder's same-named edit
  // is never theirs to commit), nothing is done.
  if (typeof shownFolder !== 'string' || !shownFolder || !samePlace(seen, shownFolder)) throw combworkError(M.moved, { target })
  const what = say(action === 'commit' ? FENCE.commit : FENCE.setAside)
  return withRepoLock(
    projectPath,
    () =>
      changingFolder(seen, what, async () => {
        // Where it is checked out read again, under the lock: moved meanwhile, nothing is done.
        const again = await checkouts(projectPath)
        if (isUnknown(again) || !again[target] || !samePlace(again[target], seen) || !samePlace(again[target], shownFolder)) throw combworkError(M.moved, { target })
        const folder = again[target]
        const branch = await assertQuiet(projectPath, folder, target)
        guard?.()
        const now = await changedIn(folder)
        if (!shown.length || !shown.every((p) => now.has(p))) throw combworkError(M.changed, { folder })
        // A rename's other side goes with it: committed or set aside, the rename stays whole.
        const files = [...new Set(shown.flatMap((p) => [p, ...(now.get(p)?.from ? [now.get(p)!.from!] : [])]))]
        const message = action === 'commit' ? `Commit changes ${label}` : `Combwork: set aside ${label}` // i18n-ignore: the commit's or stash's message, in the repository (English, as Combwork's other commits)
        if (action === 'setAside') {
          const kept = await keptDeleted(folder, files, now)
          if (kept) throw combworkError(M.deletedKept, { file: kept })
        }
        const made = action === 'commit' ? await commitPaths(folder, files, now, message) : await setAsidePaths(folder, files, message)
        log.info(`${action === 'commit' ? 'Committed' : 'Set aside'} ${files.length} paths in ${userText(folder)} on ${userText(branch)}`)
        return { action, folder, branch, files, message, made }
      }),
    { project: projectPath }
  )
}

/**
 * The workspace's projects in the working tree whose top is `top` (HI-2962): `own` first, then each other project folder
 * in it that git finds in the same tree (never one that is a repository of its own, nor another worktree). One git can't
 * place (its read failed, or answered nothing) refuses, never skipped: its agents may be working in this tree.
 */
async function projectsInTree(own: string, top: string): Promise<string[]> {
  const out = [own]
  for (const p of await workspace.listProjectPaths()) {
    if (samePlace(p, own) || !inFolder(p, top)) continue
    const r = await git(p, ['rev-parse', '--show-toplevel'])
    const found = r.ok ? r.out.trim() : ''
    if (!found) {
      if (!r.ok && INDEX_BUSY.test(r.err)) throw combworkError(M.indexBusy)
      // Git's own words when it gave any; else said in the window's words, the folder named.
      const why = r.ok ? '' : gitErrorLine(r.err) || r.err.trim().slice(0, 400)
      log.warn(`Commit it: git didn't place ${userText(p)}: ${userText(why || '(no answer)')}`)
      throw why ? combworkError(M.readFailed, { why }) : combworkError(M.unplaced, { folder: p })
    }
    if (samePlace(found, top)) out.push(p)
  }
  return out
}

/**
 * Files' Commit it after a shared Exclude from git: the repository's top .gitignore committed alone, as it is now (any
 * earlier edits to it with it), on the project folder's branch. Refused, as above, while an agent works there or git is
 * in the middle of something, and when it has no change. The commit moves the HEAD of the whole working tree, so a
 * project in a larger repository has that tree's top fenced and checked (HI-2962): a run anywhere in it, and the agents
 * of every project in it, refuse it, not only the project folder's own.
 */
export async function commitIgnore(projectPath: string): Promise<FolderChangesDone> {
  const repo = await filesRepo(projectPath)
  return withRepoLock(
    repo.top,
    () =>
      changingFolder(repo.top, say(FENCE.ignore), async () => {
        const agentsAt = (await projectsInTree(repo.cwd, repo.top)).map((p) => ({ project: p, folder: p }))
        const branch = await assertQuiet(repo.cwd, repo.top, null, agentsAt)
        // Its paths from the repository's top (the project folder may be a folder in a larger repository).
        const now = await changedIn(repo.top)
        const file = '.gitignore'
        if (!now.has(file)) throw combworkError(M.nothing, { file })
        const message = 'Update .gitignore' // i18n-ignore: the commit's message, in the repository (English, as Combwork's other commits)
        const made = await commitPaths(repo.top, [file], now, message)
        log.info(`Committed .gitignore in ${userText(repo.top)} on ${userText(branch)}`)
        return { action: 'commit', folder: repo.top, branch, files: [file], message, made }
      }),
    { project: repo.cwd }
  )
}
