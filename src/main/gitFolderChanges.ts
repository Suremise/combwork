// A folder's uncommitted changes, committed or set aside (HI-2944), the Git side of port 5's `folderChanges`: from a
// merge the queue paused on them, from a start's warning, and Files' Commit it after a shared exclude. Combwork acts only
// on what the window was shown, in a folder it finds itself (where the target is checked out: never one the window
// names), and checks everything again under the repository lock and that folder's fence, the queue's own order:
// the checkout, its branch, no git operation under way, no agent or run working there, and every path shown still
// changed. Nothing Git would allow is refused otherwise. A failure loses nothing: a refused commit leaves the files and
// the index as they were, and a stash git made before it failed is kept and named. Git does all the index work
// (`commit --only`, `stash push`): a path whose removal from Git is staged while its file is still in the folder (Files'
// Stop Tracking, `git rm --cached`), which either would put back, is refused by name before anything runs (HI-2982;
// Darren, 11 Nov 2026).
import { lstat } from 'original-fs/promises'
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
  deletedKept: msg({ id: 'service.folderChanges.deletedKept', defaultMessage: "{file} is staged for removal from Git: commit it yourself in Git; Combwork won't add it back.", description: "HI-2982: an error from Commit or Set aside (a paused merge, a start's warning): the file ({file}, a path) had its removal from Git staged (Files' Stop Tracking) and is still on disk; git's commit or stash would put it back, so nothing was done. The user commits the removal in Git themselves." }),
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
 * Commits `files` by git alone: an untracked one added as intent-to-add first (undone again if the commit fails, only
 * those this call added), then `commit --only`, which commits their working-tree content through a temporary index of
 * git's, under git's own index lock, and leaves every other index entry as it was. Never given a path whose removal is
 * staged while its file is still in the folder (settleChanges and commitIgnore refuse it first, keptDeleted).
 */
async function commitPaths(folder: string, files: string[], untracked: string[], message: string): Promise<string> {
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
 * A path in `files` whose removal from Git is staged while its file is still in the folder (HI-2982), refused by name
 * before Commit or Set Aside runs: `commit --only` takes each path from the folder, so it would put the file back into
 * Git with its local content (a secret just taken out); a stash puts the committed copy back over it (ignored, git
 * refuses that after making the stash, every time; listed untracked too, the file is replaced, kept only in a stash
 * that can't be popped over the copy). Null when there is none.
 */
async function keptDeleted(folder: string, files: string[], now: Map<string, Changed>): Promise<string | null> {
  for (const p of files) {
    const c = now.get(p)
    if (!c?.deleted) continue
    // Absent only when the system says so (HR2's round 5): any other stat failure (EPERM, EACCES, I/O) refuses, as git
    // could still read the file and add it back.
    const absent = await lstat(join(folder, p)).then(
      () => false,
      (e: NodeJS.ErrnoException) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR'
    )
    if (!absent) return p
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
        const kept = await keptDeleted(folder, files, now)
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        const made = action === 'commit' ? await commitPaths(folder, files, files.filter((p) => now.get(p)?.untracked && !now.get(p)?.deleted), message) : await setAsidePaths(folder, files, message)
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
        const kept = await keptDeleted(repo.top, [file], now)
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        const made = await commitPaths(repo.top, [file], now.get(file)!.untracked ? [file] : [], message)
        log.info(`Committed .gitignore in ${userText(repo.top)} on ${userText(branch)}`)
        return { action: 'commit', folder: repo.top, branch, files: [file], message, made }
      }),
    { project: repo.cwd }
  )
}
