// A folder's uncommitted changes, committed or set aside (HI-2944), the Git side of port 5's `folderChanges`: from a
// merge the queue paused on them, from a start's warning, and Files' Commit it after a shared exclude. Combwork acts only
// on what the window was shown, in a folder it finds itself (where the target is checked out: never one the window
// names), and checks everything again under the repository lock and that folder's fence, the queue's own order:
// the checkout, its branch, no git operation under way, no agent or run working there, and every path shown still
// changed. Nothing Git would allow is refused otherwise. A failure loses nothing: a refused commit leaves the files and
// the index as they were, and a stash git made before it failed is kept and named. Git does all the index work
// (`commit --only`, `stash push`): a path whose removal from Git is staged while its file is still in the folder (Files'
// Stop Tracking, `git rm --cached`), which either would put back, is refused by name before anything runs (HI-2982;
// Darren, 11 Nov 2026). The commit or stash runs against a private copy of the index (HI-3021), so a hook, filter or
// signer past its bound never leaves the real index locked; once something is made, its entries for the paths are
// taken into the real index in one short step.
import { copyFile, lstat, open, readFile, readdir, rename, rm, writeFile } from 'original-fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { FolderChangeAction, FolderChangesDone } from '../shared/types'
import { agentMsg, say } from '../shared/agentText'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { changingFolder, inFolder } from './folderFence'
import { INDEX_BUSY, git, gitErrorLine, type GitResult } from './git'
import { busyAgentIn } from './gitRepo'
import { filesRepo } from './filesGit'
import { createLogger, userText } from './logger'
import { checkouts, worktreeNow } from './platform/git'
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
  commitTimedOut: msg({ id: 'service.folderChanges.commitTimedOut', defaultMessage: "Git didn't finish the commit in {seconds, number} seconds (a hook still running, or signing waiting for an answer), so Combwork ended it and everything it had started. The files and the index are as they were.", description: "HI-3021: an error from Commit (a paused merge, a start's warning) or Files' Commit it: git's commit ran past its time limit ({seconds}) and Combwork ended it with its hook; nothing was committed, and the files and git's index (staging area) are unchanged. Keep git as it is." }),
  commitTimedOutMoved: msg({ id: 'service.folderChanges.commitTimedOutMoved', defaultMessage: "Git didn't finish the commit in {seconds, number} seconds (a hook still running, or signing waiting for an answer), so Combwork ended it and everything it had started. {head, select, none {Combwork couldn't read the branch's commit afterwards} other {The branch moved meanwhile, to {head}, and Combwork can't tell that it is this commit}}, so it left the index as it was. Check git log and git status before going on.", description: "HI-3075: an error from Commit (a paused merge, a start's warning) or Files' Commit it: git's commit ran past its time limit ({seconds}) and Combwork ended it, but the branch's commit changed meanwhile ({head}, a commit id; none when it couldn't be read), which may or may not be this commit; git's index (staging area) wasn't updated. Keep git log and git status as they are: commands." }),
  indexNotTaken: msg({ id: 'service.folderChanges.indexNotTaken', defaultMessage: "{action, select, commit {Git made the commit ({made})} other {Git set the changes aside in a stash ({made})}}, but Combwork couldn't update the index for those files afterwards: {why}. Until it's updated, git status may show them as changed in the index: once no git command is running, run git reset on them.", description: "HI-3021: an error from Commit or Set aside (a paused merge, a start's warning): git committed (or stashed) the files ({made}, a commit or stash id), but updating git's index (staging area) for them afterwards failed; {why} is git's own message (English), often another git command holding the index. {action} is commit or setAside. Keep git status and git reset as they are: commands." }),
  indexKept: msg({ id: 'service.folderChanges.indexKept', defaultMessage: "{action, select, commit {Git made the commit ({made})} other {Git set the changes aside in a stash ({made})}}, but another git command staged {file}{others, plural, =0 {} one { and one other file} other { and # other files}} meanwhile, so Combwork kept that staging as it was. Check git status before going on.", description: "HI-3053: an error from Commit or Set aside (a paused merge, a start's warning) or Files' Commit it: git committed (or stashed) the files ({made}, a commit or stash id), but while it ran another git command (the user's git add, say) changed git's index (staging area) for {file} (a path) and {others} more files; Combwork left those as that command staged them rather than writing over them. {action} is commit or setAside. Keep git status as it is: a command." }),
  stashTimedOut: msg({ id: 'service.folderChanges.stashTimedOut', defaultMessage: "Git didn't finish setting the changes aside in {seconds, number} seconds, so Combwork ended it and everything it had started.{made, select, yes { It had kept them in a stash ({stash}) by then.} other {}} Check git stash list and the files before going on.", description: "HI-3021: an error from Set aside (a paused merge, a start's warning): git stash ran past its time limit ({seconds}) and Combwork ended it. {made} is yes when git had made a stash ({stash}, its id) by then. Keep git stash list as it is: a command." }),
  stashFailed: msg({ id: 'service.folderChanges.stashFailed', defaultMessage: 'Git did not set the changes aside: {why}', description: "HI-2944: an error from Set aside: git refused to stash the changes; {why} is its own message (English). The files are as they were." }),
  deletedKept: msg({ id: 'service.folderChanges.deletedKept', defaultMessage: "{file} is staged for removal from Git: commit it yourself in Git; Combwork won't add it back.", description: "HI-2982: an error from Commit or Set aside (a paused merge, a start's warning): the file ({file}, a path) had its removal from Git staged (Files' Stop Tracking) and is still on disk; git's commit or stash would put it back, so nothing was done. The user commits the removal in Git themselves." }),
  caseRename: msg({ id: 'service.folderChanges.caseRename', defaultMessage: "{from} is renamed to {to}, a change of letter case only, which Git can't set aside. Commit it instead, or rename it back yourself.", description: "HI-3024: an error from Set aside (a paused merge, a start's warning): the file {from} (a path) was renamed to {to} (the same path in other letter case); git's stash fails on such a rename, so nothing was done. Commit works for it." }),
  removedForFolder: msg({ id: 'service.folderChanges.removedForFolder', defaultMessage: "{file} was removed from Git, and a folder of that name is in its place: setting the removal aside would take the folder's files too. Commit the removal instead, or use git stash yourself.", description: "HI-3024: an error from Set aside (a paused merge, a start's warning): the file {file} (a path) was removed from Git and a folder of the same name is now there; git's stash would take the folder's files with the removal, so nothing was done. Keep git stash as it is: a command." }),
  unmerged: msg({ id: 'service.folderChanges.unmerged', defaultMessage: "{file} is in conflict in Git: resolve it there first (fix the file, then git add it). Combwork doesn't commit or set aside a file in conflict.", description: "HI-3025: an error from Commit or Set aside (a paused merge, a start's warning) or Files' Commit it: the file ({file}, a path) has a conflict git hasn't had resolved (after a git stash pop that conflicted, say); committing it would put its conflict markers into the commit, so nothing was done. Keep git add as it is: a command." }),
  nestedRepo: msg({ id: 'service.folderChanges.nestedRepo', defaultMessage: '{folder} is a Git repository of its own inside this one, so Combwork doesn\'t commit it or set it aside. Add it to .gitignore, or as a submodule, yourself.', description: "HI-2983: an error from Commit or Set aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path ending in /) is an untracked folder that is a Git repository of its own; nothing was done. Keep .gitignore: a file name." }),
  submoduleInside: msg({ id: 'service.folderChanges.submoduleInside', defaultMessage: '{folder} is a submodule whose changes are inside it, so Combwork can\'t commit them or set them aside here. Commit them or set them aside inside {folder}, then commit its new commit here if you want it.', description: "HI-3023: an error from Commit or Set aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule with edited or untracked files inside it and its recorded commit unchanged, which git can't commit or stash from this repository; nothing was done." }),
  submoduleMoved: msg({ id: 'service.folderChanges.submoduleMoved', defaultMessage: "{folder} is a submodule now at another commit, which Git can't set aside. Commit it instead, or check out its recorded commit inside {folder} yourself.", description: "HI-3052: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule whose checked-out commit differs from the one recorded (a new commit made inside it, say); git's stash can't put it back, so nothing was done. Commit works for it." }),
  tooManyToSetAside: msg({ id: 'service.folderChanges.tooManyToSetAside', defaultMessage: "Git can't set aside this many files ({count, number}) at once in {folder}. Commit them, or set them aside with git stash yourself.", description: "HI-2983: an error from Set aside (a paused merge, a start's warning): too many files ({count}) for git stash to be given by name (Windows' command-line limit, inside git); nothing was done. Keep git stash as it is: a command." }),
  stashPartial: msg({ id: 'service.folderChanges.stashPartial', defaultMessage: 'Git reported a problem while setting the changes aside, after keeping them in a stash ({stash}). Check git stash list and the files before going on. Git said: {why}', description: "HI-2944: an error from Set aside: git stashed the changes (the stash's id, {stash}) but then failed; the user checks the stash and the files. {why} is git's own message (English). Keep git stash list as it is: a command." })
}

/** What changes the folder, as its fence names it: the log, and an agent's reply refused meanwhile (agent-facing). */
const FENCE = {
  commit: agentMsg({ id: 'folderChanges.fence.commit', text: 'a commit of changes the user chose', note: "HI-2944: what changes a folder while the user's Commit runs there (a paused merge, a start's warning): Combwork types nothing into an agent there meanwhile." }),
  setAside: agentMsg({ id: 'folderChanges.fence.setAside', text: 'setting aside changes the user chose', note: "HI-2944: what changes a folder while the user's Set aside (a git stash) runs there." }),
  ignore: agentMsg({ id: 'folderChanges.fence.ignore', text: 'a commit of .gitignore', note: "HI-2944: what changes the project folder while Files' Commit it commits .gitignore." })
}

/**
 * The most a commit or stash may take (`actMs`): a hook or a signer can wait; a bound for a hung one, never how long it
 * should take. Tests shorten it.
 */
export const folderChangesBounds = { actMs: 120_000 }

/** HI-3021: the bound a commit or stash ended at, in seconds, as its refusal says it. */
const boundSeconds = (): number => Math.round(folderChangesBounds.actMs / 1000)

/** The branch's commit (null: none yet, an unborn branch; undefined: git couldn't read it). */
async function headOf(folder: string): Promise<string | null | undefined> {
  const r = await git(folder, ['rev-parse', '-q', '--verify', 'HEAD'])
  if (r.ok && r.out.trim()) return r.out.trim()
  // Unborn: `-q --verify` exits 1 and says nothing. Anything else is a read that failed, never "no commit".
  return !r.ok && r.code === 1 && !r.err.trim() ? null : undefined
}

let privateIndexes = 0

/**
 * HI-3021: runs a commit or stash against a private copy of the folder's index (GIT_INDEX_FILE, beside it), so the real
 * index and its lock are never held while hooks, filters or a signer run: ended at its bound (on Windows a git ended
 * from outside never removes its lock), git leaves only the copy's lock, Combwork's own by its name, removed with the
 * copy. What git did to the shown paths' entries is then taken into the real index in one short step (takeEntries).
 */
async function withPrivateIndex<T>(folder: string, files: string[], m: (typeof M)['commitFailed'] | (typeof M)['stashFailed'], fn: (env: NodeJS.ProcessEnv, copy: string, take: (made?: Made) => Promise<Taken>) => Promise<T>): Promise<T> {
  const where = await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!where.ok || !where.out.trim()) throw failed(m, where.err || "git didn't say where its index is") // i18n-ignore: stands in for git's own (English) words
  const index = resolve(where.out.trim())
  const copy = `${index}.combwork-${process.pid}-${++privateIndexes}`
  // No index yet (a repository with nothing added): git starts the copy empty, as it would the index.
  await copyFile(index, copy).catch((e: NodeJS.ErrnoException) => {
    if (e?.code !== 'ENOENT') throw failed(m, e?.message ?? String(e))
  })
  try {
    // HI-3053: the real index's entries as the copy was taken (git writes an index whole, by its lock and a rename, so
    // the copy is one index git wrote): what they must still be when git's are taken in, or kept. Every entry (HI-3074:
    // a commit's hook can change paths beyond `files`).
    const was = await entriesIn(folder, null, copy)
    if (!was.ok) throw failed(m, was.why)
    return await fn({ ...quietEnv(), GIT_INDEX_FILE: copy }, copy, (made) => takeEntries(folder, index, copy, made?.paths ?? files, was.entries, made?.entries))
  } finally {
    await removePrivateIndex(copy)
  }
}

/**
 * The private index and every file git made after its name (its lock, a stash's own index beside it,
 * `<copy>.stash.<pid>` and its lock): Combwork's by that name alone. A process just ended can hold one a moment longer
 * (Windows closes its handles after it is ended), so a removal refused is tried again briefly.
 */
async function removePrivateIndex(copy: string): Promise<void> {
  const dir = dirname(copy)
  const own = basename(copy)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names.filter((n) => n === own || n.startsWith(`${own}.`))) await removeOwn(join(dir, name))
}

/** One of the private index's files removed, tried again briefly while a process just ended still holds it. False: it is still there. */
async function removeOwn(file: string): Promise<boolean> {
  for (let t = 1; ; t++) {
    const e = await rm(file, { force: true }).then(
      () => null,
      (err: NodeJS.ErrnoException) => err
    )
    if (!e) return true
    if (t >= TAKE_TRIES || (e.code !== 'EBUSY' && e.code !== 'EPERM')) {
      log.warn(`A private index's file wasn't removed (${userText(basename(file))}): ${userText(e.message)}`)
      return false
    }
    await new Promise((res) => setTimeout(res, TAKE_RETRY_MS))
  }
}

/** How many times the real index is tried while another git holds it, and how long between (INDEX_BUSY). */
const TAKE_TRIES = 10
const TAKE_RETRY_MS = 100
/** HI-3056: how many times the new index is made again while another git keeps writing the real one. */
const PREPARE_TRIES = 3

/** takeEntries' answer: `kept`, the paths whose real entries another git changed meanwhile, left as it made them. */
type Taken = { ok: true; kept: string[] } | { ok: false; why: string }

/** An `ls-files -s` line's path (`mode object stage\tpath`). */
const pathOf = (entry: string): string => entry.slice(entry.indexOf('\t') + 1)

/** `ls-files -s` lines grouped by path, each sorted: one pass and one sort (HR1's round 1: never a scan per path). */
function byPath(entries: readonly string[]): Map<string, string> {
  const out = new Map<string, string[]>()
  for (const e of entries) {
    const p = pathOf(e)
    const list = out.get(p)
    if (list) list.push(e)
    else out.set(p, [e])
  }
  return new Map([...out].map(([p, list]) => [p, list.sort().join('\0')]))
}

/**
 * HI-3053: the paths of `files` whose entries in `now` aren't those in `was` (each an `ls-files -s` listing), in
 * `files`' order. Linear in the entries (it runs on main's thread, as the entries are taken in).
 */
export function changedPaths(files: readonly string[], was: readonly string[], now: readonly string[]): string[] {
  const a = byPath(was)
  const b = byPath(now)
  return files.filter((p) => (a.get(p) ?? '') !== (b.get(p) ?? ''))
}

/**
 * HI-3021: the real index's entries for `files` made what git left them in the private index `copy`: each path's
 * entries removed, then each of the copy's put in. Every other entry is left. HI-3053: the real index is free while the
 * commit or stash runs, so another git can stage one of `files` meanwhile (the user's `git add`): a path whose real
 * entries aren't `was` (as the copy was taken) any more keeps them, never written over, and is answered `kept`.
 *
 * HI-3056 (HR3's round 1): the new index is made in a scratch file beside the copy before the real index is locked, from
 * the real index's bytes as read then (`build`): the taken entries written by `update-index --index-info`, then their
 * stat data refreshed (`add --refresh`, which may run a clean filter, so bounded; the scratch is Combwork's own, so an
 * ended git leaves nothing of the real index's). Only then is the real index's own lock taken, as git takes it
 * (`index.lock`, made only if none is there; another git holding it waited on briefly), and, the index still exactly
 * those bytes, the scratch is put in as the lock and the lock renamed onto the index, as git commits a lock: nothing but
 * Combwork's own file steps while the lock is held. Another git wrote the index meanwhile: made again from its new bytes,
 * a few times; still moving, the entries are made under the lock unrefreshed (git's own work alone, no filter).
 */
async function takeEntries(folder: string, index: string, copy: string, files: string[], was: readonly string[], made?: readonly string[]): Promise<Taken> {
  const from = made ? { ok: true as const, entries: [...made] } : await entriesIn(folder, files, copy)
  if (!from.ok) return from
  const fmt = await git(folder, ['rev-parse', '--show-object-format'])
  const none = '0'.repeat(fmt.out.trim() === 'sha256' ? 64 : 40)
  const quiet = await noHooks(folder, copy)
  if (!quiet.ok) return quiet
  // Named after the private index, so removed with it whatever happens here.
  const scratch = `${copy}.take`
  const lock = `${index}.lock`
  const present = new Set(from.entries.map(pathOf))

  /** The new index made in the scratch (which holds the real index as it was read): which paths are kept, and whether anything is to be written. */
  const build = async (fresh: boolean): Promise<{ ok: true; kept: string[]; write: boolean } | { ok: false; why: string }> => {
    const now = await entriesIn(folder, files, scratch)
    if (!now.ok) return now
    const kept = changedPaths(files, was, now.entries)
    const keptSet = new Set(kept)
    const taken = new Set(files.filter((p) => !keptSet.has(p)))
    if (!taken.size) return { ok: true, kept, write: false }
    const input = [...[...taken].map((p) => `0 ${none}\t${p}`), ...from.entries.filter((e) => taken.has(pathOf(e)))].map((l) => `${l}\0`).join('')
    // HR2's round 4: it runs nothing of the repository's (noHooks), so it waits only on git's own work: never bounded,
    // as under the lock (the fallback) an ended git must never be what holds it up. Off main's thread (git's worker).
    const r = await git(folder, [...quiet.args, 'update-index', '-z', '--index-info'], undefined, input, { env: { ...process.env, GIT_INDEX_FILE: scratch } })
    if (!r.ok) return { ok: false, why: gitErrorLine(r.err) || r.err.trim() }
    // HI-3056: their stat data is empty after --index-info, and what trusts it (the queue's `read-tree -m -u`) refuses
    // them as "not uptodate". Only these paths; failed or ended, they go in as they are.
    const refresh = [...taken].filter((p) => present.has(p))
    if (fresh && refresh.length) {
      const f = await git(folder, [...quiet.args, 'add', '--refresh', ...PATHS_IN], undefined, pathsIn(refresh), { env: { ...quietEnv(), GIT_INDEX_FILE: scratch }, timeout: folderChangesBounds.actMs })
      if (!f.ok) log.warn(`The index entries taken in ${userText(folder)} weren't refreshed${f.timedOut ? ' (ended at its bound)' : ''}: ${userText(gitErrorLine(f.err) || f.err.trim())}`)
    }
    if (!fresh && refresh.length) log.warn(`The index in ${userText(folder)} kept changing: its entries taken in unrefreshed`)
    return { ok: true, kept, write: true }
  }

  /** The real index as git last wrote it (null: none yet). */
  const indexBytes = (): Promise<Buffer | null> => readFile(index).catch((e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' ? null : Promise.reject(e)))
  /**
   * The scratch made the real index's bytes (none: no scratch, which git reads as an empty index). A refresh ended at its
   * bound leaves the scratch's lock (on Windows an ended git never removes it): Combwork's own by its name, removed.
   */
  const startFrom = async (bytes: Buffer | null): Promise<void> => {
    if (!(await removeOwn(`${scratch}.lock`)) || !(await removeOwn(scratch))) throw new Error(`Combwork couldn't remove ${scratch}`) // i18n-ignore: stands in for git's own (English) words
    if (bytes) await writeFile(scratch, bytes)
  }

  /** `fn` under the real index's lock: only one made here (`wx`), and only that one removed, unless it became the index. */
  const locked = async <T>(fn: (publish: () => Promise<void>) => Promise<T>): Promise<T | { ok: false; why: string }> => {
    for (let t = 1; ; t++) {
      const e = await open(lock, 'wx').then(
        async (h) => {
          await h.close()
          return null
        },
        (err: NodeJS.ErrnoException) => err
      )
      if (!e) break
      if (e.code !== 'EEXIST' || t >= TAKE_TRIES) return { ok: false, why: e.code === 'EEXIST' ? `Unable to create '${lock}': File exists` : e.message } // i18n-ignore: git's own (English) words for a held lock
      await new Promise((res) => setTimeout(res, TAKE_RETRY_MS))
    }
    let renamed = false
    const publish = async (): Promise<void> => {
      await rename(scratch, lock)
      // A git reading the index can hold it open a moment (Windows refuses the rename then): tried again briefly.
      for (let t = 1; ; t++) {
        const e = await rename(lock, index).then(
          () => null,
          (err: NodeJS.ErrnoException) => err
        )
        if (!e) {
          renamed = true
          return
        }
        if (t >= TAKE_TRIES || (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES')) throw e
        await new Promise((res) => setTimeout(res, TAKE_RETRY_MS))
      }
    }
    try {
      return await fn(publish)
    } finally {
      if (!renamed) await rm(lock, { force: true }).catch((e: Error) => log.warn(`The index lock Combwork took wasn't removed: ${userText(e.message)}`))
    }
  }

  try {
    for (let t = 1; t <= PREPARE_TRIES; t++) {
      const base = await indexBytes()
      await startFrom(base)
      const built = await build(true)
      if (!built.ok) return built
      if (!built.write) return { ok: true, kept: built.kept }
      const done = await locked(async (publish) => {
        const now = await indexBytes()
        if (base === null ? now !== null : now === null || !base.equals(now)) return false
        await publish()
        return true
      })
      if (done !== true && done !== false) return done
      if (done) return { ok: true, kept: built.kept }
    }
    // Still moving: made under the lock from the index as it is then, with git's own work alone.
    return await locked(async (publish): Promise<Taken> => {
      await startFrom(await indexBytes())
      const built = await build(false)
      if (!built.ok) return built
      if (built.write) await publish()
      return { ok: true, kept: built.kept }
    })
  } catch (e) {
    return { ok: false, why: (e as Error)?.message ?? String(e) }
  }
}

/**
 * HI-3021 (HR2's rounds 3 and 4): git's options for reading and writing an index with nothing of the repository's run:
 * no hook from a hooks folder (`core.hooksPath`, a folder named after the private index, never made), each hook set in
 * git's config made `true` (`hook.<name>.command`, whose last value wins; `core.hooksPath` doesn't reach them), and no
 * fsmonitor. Not ok when git's config can't be read: a hook might then run.
 */
async function noHooks(folder: string, copy: string): Promise<{ ok: true; args: string[] } | { ok: false; why: string }> {
  const r = await git(folder, ['config', '--get-regexp', '^hook\\..*\\.(command|event)$'])
  // Exit 1, nothing said: no such setting.
  if (!r.ok && !(r.code === 1 && !r.err.trim())) return { ok: false, why: gitErrorLine(r.err) || r.err.trim() || "git couldn't read its config" } // i18n-ignore: stands in for git's own (English) words
  const names = new Set(
    r.out
      .split('\n')
      .map((l) => /^hook\.(.+)\.(?:command|event)(?:\s|$)/i.exec(l.trim())?.[1])
      .filter((n): n is string => !!n)
  )
  return { ok: true, args: ['-c', `core.hooksPath=${copy}.no-hooks`, '-c', 'core.fsmonitor=false', ...[...names].flatMap((n) => ['-c', `hook.${n}.command=true`])] }
}

/** The entries the private index `copy` has for `files` (null: every one), as `ls-files -s` says them (mode, object, stage, path). */
async function entriesIn(folder: string, files: string[] | null, copy: string): Promise<{ ok: true; entries: string[] } | { ok: false; why: string }> {
  // Every entry, those of `files` kept (ls-files takes no pathspecs on its input, and they can be many). No fsmonitor.
  const ls = await git(folder, ['-c', 'core.fsmonitor=false', 'ls-files', '-s', '-z', '--full-name'], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: copy } })
  if (!ls.ok) return { ok: false, why: gitErrorLine(ls.err) || ls.err.trim() }
  const wanted = files && new Set(files)
  return { ok: true, entries: ls.out.split('\0').filter((e) => e && (!wanted || wanted.has(e.slice(e.indexOf('\t') + 1)))) }
}

/** The same entries, whatever their order: each side sorted once (HR2's round 4: never once per entry). */
export function sameEntries(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((e, i) => e === y[i])
}

/** HI-3074: what a commit leaves the index: its paths (those shown, and every path it changed) and its entries for them. */
interface Made {
  paths: string[]
  entries: string[]
}

/**
 * HI-3074: the index entries commit `made` gives `files` and every path it changed from `before` (null: its first
 * commit, all of its paths), as `ls-files -s` says them (`mode object 0\tpath`): a path not in its tree has none (taken
 * out of the index). So the index matches the commit, whatever its hooks staged.
 */
async function entriesOfCommit(folder: string, made: string, before: string | null, files: string[]): Promise<({ ok: true } & Made) | { ok: false; why: string }> {
  const changed = await git(folder, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--no-commit-id', ...(before ? [before, made] : ['--root', made])])
  if (!changed.ok) return { ok: false, why: gitErrorLine(changed.err) || changed.err.trim() }
  const paths = [...new Set([...files, ...changed.out.split('\0').filter(Boolean)])]
  const tree = await git(folder, ['ls-tree', '-r', '-z', '--full-tree', made])
  if (!tree.ok) return { ok: false, why: gitErrorLine(tree.err) || tree.err.trim() }
  const wanted = new Set(paths)
  // ls-tree's `mode type object\tpath` as the index's `mode object 0\tpath`.
  const entries = tree.out
    .split('\0')
    .filter((e) => e && wanted.has(pathOf(e)))
    .map((e) => {
      const [mode, , object] = e.slice(0, e.indexOf('\t')).split(' ')
      return `${mode} ${object} 0\t${pathOf(e)}`
    })
  return { ok: true, paths, entries }
}

/** The environment of these commits: no prompt is ever waited on (a passphrase, credentials, a credential manager). */
const quietEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never' })

/** A repository-relative path as a pathspec that names exactly it, from the top whatever the folder. */
const literal = (rel: string): string => `:(top,literal)${rel}`

/**
 * HI-2983: paths given to git on its standard input, NUL-separated, never on the command line: a few hundred paths
 * passed Windows' 32,767-character limit (`spawn ENAMETOOLONG`), and a start's warning lists every changed file. The
 * arguments that read them, and the input; git 2.26 or later (`stash push`'s; Combwork asks for 2.38).
 */
const PATHS_IN = ['--pathspec-from-file=-', '--pathspec-file-nul']
const pathsIn = (paths: string[]): string => paths.map(literal).join('\0')

/**
 * HI-2983: `git stash push` with pathspecs passes them on to git commands of its own as arguments (`add`, `diff-index`,
 * each as `':(top,literal,prefix:0)<path>'`), so their total, not Combwork's command line, meets Windows' 32,767
 * characters; git then fails after it made the stash. The most they may take, with room for the rest of that command
 * line (git's own path, the command), and what each path takes.
 */
const STASH_PATHS_MAX = 30_000
const stashPathCost = (rel: string): number => rel.length + 28

/** The markers worktreeNow lists for an operation under way, as the refusal names it. */
const STATES: Record<string, string> = { '(MERGE_HEAD)': 'merge', '(rebase-merge)': 'rebase', '(rebase-apply)': 'rebase', '(CHERRY_PICK_HEAD)': 'cherryPick', '(REVERT_HEAD)': 'revert' }

/**
 * One path git reports changed. `untracked`: git lists it as untracked (`??`). `deleted`: its index entry is gone (a
 * staged deletion, or a rename's old side), whatever is on disk: Stop Tracking leaves the file there, often also listed
 * untracked, so a path can be both (HI-2982). `from`: a rename's or copy's other side. `unmerged`: in conflict (HI-3025:
 * `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`), with no operation under way needed (a `git stash pop` that conflicted).
 */
interface Changed {
  untracked: boolean
  deleted?: boolean
  from?: string
  unmerged?: boolean
  /** HI-3024: a change staged (porcelain's X column), a rename's both sides included. */
  staged?: boolean
  /** HI-3076: its file deleted from the folder, the deletion not staged (porcelain's Y column `D`). */
  gone?: boolean
}

/** Porcelain v1's states of a path in conflict (git's `git status` short format). */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

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
    const unmerged = c.unmerged || was?.unmerged
    const staged = c.staged || was?.staged
    const gone = c.gone || was?.gone
    out.set(path, { untracked: c.untracked || !!was?.untracked, ...(deleted ? { deleted } : {}), ...(from ? { from } : {}), ...(unmerged ? { unmerged } : {}), ...(staged ? { staged } : {}), ...(gone ? { gone } : {}) })
  }
  const parts = r.out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const path = e.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') {
      const from = parts[++i]
      // HR1's round 1 (HI-3076): a staged rename's new side deleted since (`RD`) is gone too.
      put(path, { untracked: false, from, staged: true, gone: xy[1] === 'D' })
      if (from && xy[0] === 'R') put(from, { untracked: false, deleted: true, staged: true })
    } else if (UNMERGED.has(xy)) put(path, { untracked: false, unmerged: true })
    else put(path, { untracked: xy === '??', deleted: xy[0] === 'D', staged: xy[0] !== ' ' && xy[0] !== '?', gone: xy[1] === 'D' })
  }
  return out
}

/**
 * The window's list as repository-relative paths: strings, `/` separated, no `.` or `..`, each once. A folder git lists
 * whole (`nested/`, an untracked repository of its own) keeps its one trailing `/`, so it is refused by name rather than
 * dropped (HI-2983).
 */
function cleanShown(shown: unknown): string[] {
  const list = Array.isArray(shown) ? shown : []
  const out = list.filter((p): p is string => typeof p === 'string').map((p) => p.replace(/\\/g, '/').replace(/^\/+/, ''))
  return [...new Set(out.filter((p) => p && !p.replace(/\/$/, '').split('/').some((s) => s === '..' || s === '.' || s === '') && !/^\.git(\/|$)/i.test(p)))]
}

function failed(m: (typeof M)['commitFailed'] | (typeof M)['stashFailed'], err: string): Error {
  if (INDEX_BUSY.test(err)) return combworkError(M.indexBusy)
  return combworkError(m, { why: gitErrorLine(err) || err.trim().slice(0, 400) })
}

/** HI-3053: the commit or stash made, said with the paths another git staged meanwhile, kept as it staged them. */
function indexKept(action: FolderChangeAction, made: string, kept: string[]): Error {
  log.warn(`${action === 'commit' ? 'A commit' : 'A stash'} was made (${made}), and ${kept.length} paths staged meanwhile by another git were kept`)
  return combworkError(M.indexKept, { action, made: made.slice(0, 12), file: kept[0], others: kept.length - 1 })
}

const samePlace = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * Under the lock and the fence: the folder still on `branch` (null: any branch, never a detached HEAD), no operation
 * under way, no agent or run working there. `agentsAt`: the projects whose agents count, each with the folder they'd
 * work in (the folder's own project's agents there, unless the caller names more). Throws the refusal, in the
 * window's words.
 */
async function assertQuiet(projectPath: string, folder: string, branch: string | null, agentsAt: readonly { project: string; folder: string }[] = [{ project: projectPath, folder }]): Promise<{ line: string; inside: string[]; submodules: string[] }> {
  const now = await worktreeNow(folder)
  if (isUnknown(now)) throw failed(M.commitFailed, now.detail ?? now.what)
  if (!now.line) throw combworkError(M.detached, { folder })
  if (branch !== null && now.line !== branch) throw combworkError(M.wrongBranch, { folder, target: branch })
  // The operations under way, apart from the files (HI-2983: a changed file named `(MERGE_HEAD)` is a file).
  const marker = now.operations?.[0]
  if (marker) throw combworkError(M.midOperation, { state: STATES[marker] ?? 'revert', folder })
  const { folderBuilders } = await import('./workflow/queueHost')
  const held = folderBuilders(workspace, folder)
  if (held) throw combworkError(M.busy, { folder, what: held[0] })
  for (const at of agentsAt) {
    const agent = await busyAgentIn(at.project, at.folder)
    if (agent) throw combworkError(M.agentBusy, { agent, folder: at.folder })
  }
  return { line: now.line, inside: now.insideOnly ?? [], submodules: now.submodules ?? [] }
}

/**
 * Commits `files` by git alone, against a private copy of the index (withPrivateIndex, HI-3021): an untracked one added
 * there as intent-to-add first, then `commit --only`, which commits their working-tree content. The real index is
 * touched only once the commit is made: its entries for `files` become git's (takeEntries), every other one as it was.
 * A refused commit leaves the real index as it was, intent-to-add entries never in it. Never given a path whose removal
 * is staged while its file is still in the folder (settleChanges and commitIgnore refuse it first, keptDeleted).
 */
async function commitPaths(folder: string, files: string[], untracked: string[], message: string, byIndex?: { removed: string[]; staged: string[] }): Promise<string> {
  // What the branch was, to tell whether a commit ended at its bound moved it; unreadable, nothing runs.
  const before = await headOf(folder)
  if (before === undefined) throw failed(M.commitFailed, "git couldn't read HEAD") // i18n-ignore: stands in for git's own (English) words
  return withPrivateIndex(folder, files, M.commitFailed, async (env, copy, take) => {
    const r = byIndex ? await commitByIndex(folder, env, files, message, byIndex) : await commitOnly(folder, env, copy, files, untracked, message)
    if (r.timedOut) {
      // HI-3075 (Darren, 12 Nov): a commit ended at its bound is never credited, whatever HEAD is now: a hook's own git
      // (which inherits everything this one has) can move HEAD or commit too, and nothing proves which made it. HEAD
      // where it started: nothing was made. Moved (or unread): said so, where it is now, the index left as it was.
      const now = await headOf(folder)
      if (now === before) throw combworkError(M.commitTimedOut, { seconds: boundSeconds() })
      log.warn(`A commit in ${userText(folder)} was ended at its bound, HEAD moved meanwhile to ${now ?? '(unread)'}: not credited`)
      throw combworkError(M.commitTimedOutMoved, { seconds: boundSeconds(), head: typeof now === 'string' ? now.slice(0, 12) : 'none' })
    }
    const made = r.ok ? await headOf(folder) : undefined
    if (typeof made !== 'string') throw failed(M.commitFailed, r.ok ? "git couldn't read HEAD after the commit" : `${r.err}\n${r.out}`) // i18n-ignore: stands in for git's own (English) words
    // HI-3074: from the commit, never the private index: a pre-commit hook's `git add` (a formatter, a generated file)
    // goes into what git commits, not into the private index.
    const entries = await entriesOfCommit(folder, made, before, files)
    if (!entries.ok) throw combworkError(M.indexNotTaken, { action: 'commit', made: made.slice(0, 12), why: entries.why })
    const took = await take(entries)
    if (!took.ok) throw combworkError(M.indexNotTaken, { action: 'commit', made: made.slice(0, 12), why: took.why })
    if (took.kept.length) throw indexKept('commit', made, took.kept)
    return made
  })
}

/** The commit as git's own partial commit makes it, in the private index: untracked paths as intent-to-add first. */
async function commitOnly(folder: string, env: NodeJS.ProcessEnv, copy: string, files: string[], untracked: string[], message: string): Promise<GitResult> {
  if (untracked.length) {
    // HI-3079: Combwork's own step, not the commit: nothing of the repository's run (a post-index-change hook, an
    // fsmonitor), as for the step into the real index (noHooks), and bounded as the commit is. Ended, nothing was made.
    const quiet = await noHooks(folder, copy)
    if (!quiet.ok) throw failed(M.commitFailed, quiet.why)
    const add = await git(folder, [...quiet.args, 'add', '--intent-to-add', ...PATHS_IN], undefined, pathsIn(untracked), { env, timeout: folderChangesBounds.actMs })
    if (!add.ok && add.timedOut) throw combworkError(M.commitTimedOut, { seconds: boundSeconds() })
    if (!add.ok) throw failed(M.commitFailed, add.err)
  }
  return git(folder, ['commit', '--only', '--quiet', '-m', message, ...PATHS_IN], undefined, pathsIn(files), { env, timeout: folderChangesBounds.actMs })
}

/**
 * HI-3024: the commit built in the private index, for what git's partial commit can't take (a case-only rename: "will
 * not add file alias"; a removal whose path is now a folder): every other staged change, and every other path in
 * conflict (HR1's round 1: a plain commit refuses an index with one), taken back to HEAD there (`staged`; the real
 * index keeps them), the removed paths taken out of it, the rest added as they are in the folder, then a plain commit.
 * The same commit `commit --only` makes: HEAD with `files` as the folder has them. Each step bounded, as the private
 * index is Combwork's own to leave.
 */
async function commitByIndex(folder: string, env: NodeJS.ProcessEnv, files: string[], message: string, by: { removed: string[]; staged: string[] }): Promise<GitResult> {
  const bound = { env, timeout: folderChangesBounds.actMs }
  const step = async (args: string[], paths: string[]): Promise<GitResult | null> => {
    if (!paths.length) return null
    const r = await git(folder, [...args, ...PATHS_IN], undefined, pathsIn(paths), bound)
    return r.ok ? null : r
  }
  const added = files.filter((p) => !by.removed.includes(p))
  const failedStep = (await step(['reset', '-q'], by.staged)) ?? (await step(['rm', '--cached', '-q', '--ignore-unmatch'], by.removed)) ?? (await step(['add', '-A'], added))
  if (failedStep) return failedStep
  return git(folder, ['commit', '--quiet', '-m', message], undefined, undefined, bound)
}

/**
 * A path in `files` whose removal from Git is staged while its file is still in the folder (HI-2982), refused by name
 * before Commit or Set Aside runs: `commit --only` takes each path from the folder, so it would put the file back into
 * Git with its local content (a secret just taken out); a stash puts the committed copy back over it (ignored, git
 * refuses that after making the stash, every time; listed untracked too, the file is replaced, kept only in a stash
 * that can't be popped over the copy). Null when there is none.
 */
async function keptDeleted(removed: Map<string, Removed>): Promise<string | null> {
  return [...removed].find(([, k]) => k === 'file')?.[0] ?? null
}

/**
 * HI-3024: what is in the folder where a path whose index entry is gone (`deleted`) was: `absent`; `file`, a file of
 * exactly that name (Stop Tracking's kept file, HI-2982); `folder`, a folder now in its place; or `alias`, another
 * name in another letter case (Windows' folders don't tell `b.txt` from `B.txt`: a case-only rename's old side).
 */
type Removed = 'absent' | 'file' | 'folder' | 'alias'

/** Removed's answer for each path of `files` whose index entry is gone. */
async function removedIn(folder: string, files: string[], now: Map<string, Changed>): Promise<Map<string, Removed>> {
  const out = new Map<string, Removed>()
  for (const p of files) {
    const c = now.get(p)
    if (c?.deleted) out.set(p, await onDisk(folder, p))
    // HI-3076: a deletion not staged, with a folder now in its place (` D b.txt`, `?? b.txt/x.txt`), is the staged one's
    // case (HI-3024): git's stash takes the folder's files with it, shown or not, and its partial commit can't take it.
    // Any other unstaged deletion is git's ordinary one.
    else if (c?.gone && (await onDisk(folder, p)) === 'folder') out.set(p, 'folder')
  }
  return out
}

async function onDisk(folder: string, rel: string): Promise<Removed> {
  // Absent only when the system says so (HR2's round 5): any other stat failure (EPERM, EACCES, I/O) is a file, as git
  // could still read it and add it back.
  const s = await lstat(join(folder, rel)).then(
    (st) => st,
    (e: NodeJS.ErrnoException) => (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? null : undefined)
  )
  if (s === null) return 'absent'
  if (s === undefined) return 'file'
  // Each part of the path, as its folder lists it: one only in another letter case is another name (an unreadable
  // folder counts as the name being there).
  const parts = rel.split('/')
  for (let i = 0; i < parts.length; i++) {
    const names = await readdir(join(folder, ...parts.slice(0, i))).catch(() => null)
    if (names && !names.includes(parts[i])) return names.some((n) => n.toLowerCase() === parts[i].toLowerCase()) ? 'alias' : 'absent'
  }
  return s.isDirectory() ? 'folder' : 'file'
}

/**
 * HI-3022: a staged rename's old sides put back from HEAD after the stash took the new sides, in the private index:
 * their entries from HEAD (`reset`), then their files by `checkout-index` without `--force`, which refuses a path that
 * exists rather than writing over it (HR1's round 1: a file made there since the check, never in the stash, kept; the
 * refusal, "… already exists, no checkout", then said with the stash made). Both bounded.
 */
async function restoreOldSides(folder: string, env: NodeJS.ProcessEnv, olds: string[]): Promise<GitResult> {
  const bound = { env, timeout: folderChangesBounds.actMs }
  const entries = await git(folder, ['reset', '-q', ...PATHS_IN], undefined, pathsIn(olds), bound)
  if (!entries.ok) return entries
  // Paths, not pathspecs, on its input (checkout-index takes no pathspec magic).
  return git(folder, ['checkout-index', '-z', '--stdin'], undefined, olds.map((p) => `${p}\0`).join(''), bound)
}

/** HI-3022: none of `files` changed in the folder now, as git status reads it (false when it can't be read). */
async function leftUnchanged(folder: string, files: string[]): Promise<boolean> {
  const now = await changedIn(folder).catch(() => null)
  return !!now && !files.some((p) => now.has(p))
}

/** The stash ref's object now (null: no stash). */
async function stashTop(folder: string): Promise<string | null> {
  const r = await git(folder, ['rev-parse', '-q', '--verify', 'refs/stash'])
  return r.ok ? r.out.trim() || null : null
}

/**
 * Sets `files` aside as a named stash (`git stash push --include-untracked`, the paths on its input): only those paths, other index
 * entries as they were. The stash made is told by the stash ref moving to a new object (never by its message: an older
 * one can have the same). A failure after git made it is said with the stash, kept: never rolled back. It runs against a
 * private copy of the index (withPrivateIndex, HI-3021): once a stash is made, the real index's entries for `files`
 * become what git left them (takeEntries), however far it got; with none made, the real index is as it was.
 */
async function setAsidePaths(folder: string, files: string[], message: string, renamedFrom: string[] = []): Promise<string> {
  const before = await stashTop(folder)
  // HI-3022: a staged rename's old side is in neither the index nor the folder, and git's stash, given it, makes the
  // stash and then dies on it ("pathspec … did not match any files"), every try. Given the new side alone, it stashes
  // the rename whole (the stash's index and folder both without the old side, so `git stash pop --index` gives the
  // rename back) and leaves the old side's removal staged: the old side is then put back from HEAD.
  const stashed = files.filter((p) => !renamedFrom.includes(p))
  // Never a stash with no paths: it would take every change in the folder.
  if (!stashed.length) throw failed(M.stashFailed, 'nothing to set aside but a rename\'s old side') // i18n-ignore: stands in for git's own (English) words
  const { r, made } = await withPrivateIndex(folder, files, M.stashFailed, async (env, _copy, take) => {
    let pushed = await git(folder, ['stash', 'push', '--include-untracked', '--quiet', '-m', message, ...PATHS_IN], undefined, pathsIn(stashed), { env, timeout: folderChangesBounds.actMs })
    const after = await stashTop(folder)
    const stash = after && after !== before ? after : null
    if (stash && pushed.ok && renamedFrom.length) pushed = await restoreOldSides(folder, env, renamedFrom)
    if (stash) {
      const took = await take()
      if (!took.ok) throw combworkError(M.indexNotTaken, { action: 'setAside', made: stash.slice(0, 12), why: took.why })
      if (took.kept.length) throw indexKept('setAside', stash, took.kept)
    }
    return { r: pushed, made: stash }
  })
  if (!r.ok && r.timedOut) {
    // HI-3021: ended at its bound, part way: the stash it made by then named, kept.
    if (made) log.warn(`A stash was made in ${userText(folder)} before git was ended at its bound: ${made}`)
    throw combworkError(M.stashTimedOut, { seconds: boundSeconds(), made: made ? 'yes' : 'no', stash: made ? made.slice(0, 12) : '' })
  }
  // HI-3022: a file added then deleted on disk (`AD`): git stashes it, then says "No valid patches in input" putting
  // back what it has none of. With the stash made and none of the paths changed any more, that is the job done.
  if (!r.ok && made && /No valid patches in input/.test(r.err) && (await leftUnchanged(folder, files))) {
    log.warn(`git stash reported a problem in ${userText(folder)} after setting the paths aside (${made}), all of them left unchanged: ${userText(gitErrorLine(r.err))}`)
    return made
  }
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
        const { line: branch, inside, submodules } = await assertQuiet(projectPath, folder, target)
        guard?.()
        const now = await changedIn(folder)
        if (!shown.length || !shown.every((p) => now.has(p))) throw combworkError(M.changed, { folder })
        // A rename's other side goes with it: committed or set aside, the rename stays whole.
        // HI-3022: either side shown brings the other.
        const files = [...new Set(shown.flatMap((p) => [p, ...(now.get(p)?.from ? [now.get(p)!.from!] : []), ...[...now].filter(([, c]) => c.from === p).map(([q]) => q)]))]
        const message = action === 'commit' ? `Commit changes ${label}` : `Combwork: set aside ${label}` // i18n-ignore: the commit's or stash's message, in the repository (English, as Combwork's other commits)
        // A folder git lists whole: an untracked repository of its own, never committed or stashed as one (HI-2983).
        const nested = files.find((p) => p.endsWith('/'))
        if (nested) throw combworkError(M.nestedRepo, { folder: nested })
        // HI-3025: a path in conflict, refused by name: commit --only would add it as it is, markers and all, marking it
        // resolved; git itself refuses an ordinary commit then.
        const conflicted = files.find((p) => now.get(p)?.unmerged)
        if (conflicted) throw combworkError(M.unmerged, { file: conflicted })
        // A submodule changed only inside it (HI-3023): its commit unchanged, git has nothing of it to commit or stash here.
        const sub = files.find((p) => inside.includes(p))
        if (sub) throw combworkError(M.submoduleInside, { folder: sub })
        const removed = await removedIn(folder, files, now)
        const kept = await keptDeleted(removed)
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        if (action === 'setAside') {
          // HI-3052: a submodule whose commit moved (or whose new commit is staged): git's stash saves its recorded commit
          // but never checks the old one out again, so it would stay changed, reported set aside. Commit takes it.
          const moved = files.find((p) => submodules.includes(p))
          if (moved) throw combworkError(M.submoduleMoved, { folder: moved })
          // HI-3024: git's stash can't set aside a case-only rename (it fails after making the stash, the old name
          // "already exists"), nor a removal whose path is now a folder without taking the folder's files, shown or not.
          const alias = [...removed].find(([, k]) => k === 'alias')?.[0]
          if (alias) throw combworkError(M.caseRename, { from: alias, to: [...now].find(([, c]) => c.from === alias)?.[0] ?? alias })
          // HR1's round 1: never, whatever is shown: the stash takes the folder's files by that path, a file made in it
          // after this check too (HI-2983's unshown capture).
          const replaced = [...removed].find(([, k]) => k === 'folder')?.[0]
          if (replaced) throw combworkError(M.removedForFolder, { file: replaced })
        }
        // Set aside: always exactly the paths shown, never the whole folder's (HR1's round 1: a change made after this
        // read, never shown, would go into the stash and off the disk); only as many as git's own commands can be given
        // (HI-2983), refused before any stash is made.
        if (action === 'setAside' && files.reduce((n, p) => n + stashPathCost(p), 0) > STASH_PATHS_MAX) throw combworkError(M.tooManyToSetAside, { count: files.length, folder })
        // HI-3024: git's partial commit can't take a case-only rename ("will not add file alias") nor a removal whose path is
        // now a folder ("does not have a commit checked out"): those are built in the private index (byIndex).
        const byIndex = [...removed.values()].some((k) => k === 'alias' || k === 'folder') ? { removed: [...removed.keys()], staged: [...now].filter(([p, c]) => (c.staged || c.unmerged) && !files.includes(p)).map(([p]) => p) } : undefined
        const made = action === 'commit' ? await commitPaths(folder, files, files.filter((p) => now.get(p)?.untracked && !now.get(p)?.deleted), message, byIndex) : await setAsidePaths(folder, files, message, [...removed.keys()].filter((p) => [...now.values()].some((c) => c.from === p)))
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
        const { line: branch } = await assertQuiet(repo.cwd, repo.top, null, agentsAt)
        // Its paths from the repository's top (the project folder may be a folder in a larger repository).
        const now = await changedIn(repo.top)
        const file = '.gitignore'
        if (!now.has(file)) throw combworkError(M.nothing, { file })
        const message = 'Update .gitignore' // i18n-ignore: the commit's message, in the repository (English, as Combwork's other commits)
        if (now.get(file)?.unmerged) throw combworkError(M.unmerged, { file })
        const kept = await keptDeleted(await removedIn(repo.top, [file], now))
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        const made = await commitPaths(repo.top, [file], now.get(file)!.untracked ? [file] : [], message)
        log.info(`Committed .gitignore in ${userText(repo.top)} on ${userText(branch)}`)
        return { action: 'commit', folder: repo.top, branch, files: [file], message, made }
      }),
    { project: repo.cwd }
  )
}
