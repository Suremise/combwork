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
import { randomBytes } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import type { FolderChangeAction, FolderChangesDone } from '../shared/types'
import { withValues, type Text } from '../shared/advanced'
import { agentMsg, say } from '../shared/agentText'
import { msg } from '../shared/i18n'
import { combworkError } from './combworkError'
import { changingFolder, inFolder } from './folderFence'
import { INDEX_BUSY, git, gitErrorLine, type GitResult } from './git'
import { busyAgentIn } from './gitRepo'
import { filesRepo } from './filesGit'
import { createLogger, userText } from './logger'
import { checkouts, worktreeNow } from './platform/git'
import type { SubmoduleChange } from './platform/history'
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
  indexNotTaken: msg({ id: 'service.folderChanges.indexNotTaken', defaultMessage: "{action, select, commit {Git made the commit ({made})} other {Git set the changes aside in a stash ({made})}}, but Combwork couldn't update the index for those files afterwards: {why}. Until it's updated, git status may show them as changed in the index: once no git command is running, run git reset on them.", description: "HI-3021, HI-3059: the text under a warning notification after Commit or Set aside (a paused merge, a start's warning, Files' Commit it), titled as done: git committed (or stashed) the files ({made}, a commit or stash id), but updating git's index (staging area) for them afterwards failed; {why} is git's own message (English), often another git command holding the index. {action} is commit or setAside. Keep git status and git reset as they are: commands." }),
  indexKept: msg({ id: 'service.folderChanges.indexKept', defaultMessage: "{action, select, commit {Git made the commit ({made})} other {Git set the changes aside in a stash ({made})}}, but another git command staged {file}{others, plural, =0 {} one { and one other file} other { and # other files}} meanwhile, so Combwork kept that staging as it was. Check git status before going on.", description: "HI-3053, HI-3059: the text under a warning notification after Commit or Set aside (a paused merge, a start's warning) or Files' Commit it, titled as done: git committed (or stashed) the files ({made}, a commit or stash id), but while it ran another git command (the user's git add, say) changed git's index (staging area) for {file} (a path) and {others} more files; Combwork left those as that command staged them rather than writing over them. {action} is commit or setAside. Keep git status as it is: a command." }),
  stashTimedOut: msg({ id: 'service.folderChanges.stashTimedOut', defaultMessage: "Git didn't finish setting the changes aside in {seconds, number} seconds, so Combwork ended it and everything it had started.{made, select, yes { It had kept them in a stash ({stash}) by then.} other {}} Check git stash list and the files before going on.", description: "HI-3021: an error from Set aside (a paused merge, a start's warning): git stash ran past its time limit ({seconds}) and Combwork ended it. {made} is yes when git had made a stash ({stash}, its id) by then. Keep git stash list as it is: a command." }),
  stashFailed: msg({ id: 'service.folderChanges.stashFailed', defaultMessage: 'Git did not set the changes aside: {why}', description: "HI-2944: an error from Set aside: git refused to stash the changes; {why} is its own message (English). The files are as they were." }),
  deletedKept: msg({ id: 'service.folderChanges.deletedKept', defaultMessage: "{file} is staged for removal from Git: commit it yourself in Git; Combwork won't add it back.", description: "HI-2982: an error from Commit or Set aside (a paused merge, a start's warning): the file ({file}, a path) had its removal from Git staged (Files' Stop Tracking) and is still on disk; git's commit or stash would put it back, so nothing was done. The user commits the removal in Git themselves." }),
  caseRename: msg({ id: 'service.folderChanges.caseRename', defaultMessage: "{from} is renamed to {to}, a change of letter case only, which Git can't set aside. Commit it instead, or rename it back yourself.", description: "HI-3024: an error from Set aside (a paused merge, a start's warning): the file {from} (a path) was renamed to {to} (the same path in other letter case); git's stash fails on such a rename, so nothing was done. Commit works for it." }),
  removedForFolder: msg({ id: 'service.folderChanges.removedForFolder', defaultMessage: "{file} was removed from Git, and a folder of that name is in its place: setting the removal aside would take the folder's files too. Commit the removal instead, or use git stash yourself.", description: "HI-3024: an error from Set aside (a paused merge, a start's warning): the file {file} (a path) was removed from Git and a folder of the same name is now there; git's stash would take the folder's files with the removal, so nothing was done. Keep git stash as it is: a command." }),
  unmerged: msg({ id: 'service.folderChanges.unmerged', defaultMessage: "{file} is in conflict in Git: resolve it there first (fix the file, then git add it). Combwork doesn't commit or set aside a file in conflict.", description: "HI-3025: an error from Commit or Set aside (a paused merge, a start's warning) or Files' Commit it: the file ({file}, a path) has a conflict git hasn't had resolved (after a git stash pop that conflicted, say); committing it would put its conflict markers into the commit, so nothing was done. Keep git add as it is: a command." }),
  nestedRepo: msg({ id: 'service.folderChanges.nestedRepo', defaultMessage: '{folder} is a Git repository of its own inside this one, so Combwork doesn\'t commit it or set it aside. Add it to .gitignore, or as a submodule, yourself.', description: "HI-2983: an error from Commit or Set aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path ending in /) is an untracked folder that is a Git repository of its own; nothing was done. Keep .gitignore: a file name." }),
  submoduleInside: msg({ id: 'service.folderChanges.submoduleInside', defaultMessage: '{folder} is a submodule whose changes are inside it, so Combwork can\'t commit them or set them aside here. Commit them or set them aside inside {folder}, then commit its new commit here if you want it.', description: "HI-3023: an error from Commit or Set aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule with edited or untracked files inside it and its recorded commit unchanged, which git can't commit or stash from this repository; nothing was done." }),
  submoduleMoved: msg({ id: 'service.folderChanges.submoduleMoved', defaultMessage: "{folder} is a submodule now at another commit, which Git can't set aside. Commit it instead, or check out its recorded commit inside {folder} yourself.", description: "HI-3052, HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule whose checked-out commit differs from the one recorded (a new commit made inside it, say), not staged; git's stash can't put it back, so nothing was done. Commit works for it." }),
  submoduleStaged: msg({ id: 'service.folderChanges.submoduleStaged', defaultMessage: "{folder} is a submodule whose new commit is staged, which Git can't set aside. Commit it instead, or unstage it (git restore --staged -- {path}) and check out its recorded commit inside {folder} yourself.", description: "HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule with a new commit staged (git add of the submodule); git's stash can't set it aside, so nothing was done. Commit works for it; unstaging it and checking out the recorded commit inside it clears it. Keep git restore --staged as it is: a command. {path} is that path as the command takes it (quoted, or written as :(literal)<path> for git, when it needs to be): keep it as it is, right after the command's --." }),
  submoduleStagedBack: msg({ id: 'service.folderChanges.submoduleStagedBack', defaultMessage: "{folder} is a submodule with a new commit staged, but its recorded commit is checked out in it again, so there's nothing to commit or set aside. Unstage it with git restore --staged -- {path}.", description: "HI-3124: an error from Commit or Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule whose new commit is staged while the commit already recorded is checked out inside it again; git has nothing to commit and can't stash it, so nothing was done. Unstaging it clears the change. Keep git restore --staged as it is: a command. {path} is that path as the command takes it (quoted, or written as :(literal)<path> for git, when it needs to be): keep it as it is, right after the command's --." }),
  submoduleAdded: msg({ id: 'service.folderChanges.submoduleAdded', defaultMessage: "{folder} is a submodule added here, which Git can't set aside. Commit it instead.", description: "HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a newly added submodule; git's stash can't set it aside, so nothing was done. Commit works for it." }),
  submoduleRemoved: msg({ id: 'service.folderChanges.submoduleRemoved', defaultMessage: "{folder} is a submodule removed from Git here, which Git can't set aside. Commit the removal instead.", description: "HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule whose removal is staged (git rm); git's stash fails on it, so nothing was done. Commit works for it." }),
  submoduleDeleted: msg({ id: 'service.folderChanges.submoduleDeleted', defaultMessage: "{folder} is a submodule whose folder was deleted, which Git can't set aside. Commit its removal instead, or bring it back with git submodule update -- {path}.", description: "HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule whose folder was deleted (not through git); git's stash can't set that aside, so nothing was done. Committing records its removal; git submodule update checks it out again. Keep git submodule update as it is: a command. {path} is that path as the command takes it (quoted, or written as :(literal)<path> for git, when it needs to be): keep it as it is, right after the command's --." }),
  submoduleOther: msg({ id: 'service.folderChanges.submoduleOther', defaultMessage: "{folder} is a submodule, and Git can't set aside a submodule's change. Commit it instead.", description: "HI-3124: an error from Set Aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path) is a submodule changed in another way (renamed, say); git's stash can't set a submodule's change aside, so nothing was done. Commit works for it." }),
  tooManyToSetAside: msg({ id: 'service.folderChanges.tooManyToSetAside', defaultMessage: "Git can't set aside this many files ({count, number}) at once in {folder}. Commit them, or set them aside with git stash yourself.", description: "HI-2983: an error from Set aside (a paused merge, a start's warning): too many files ({count}) for git stash to be given by name (Windows' command-line limit, inside git); nothing was done. Keep git stash as it is: a command." }),
  stashUnproved: msg({ id: 'service.folderChanges.stashUnproved', defaultMessage: "Git set changes aside, but Combwork can't tell which stash is its own: another git made a stash of the same name at that moment, or one of them couldn't be read. Check git stash list and the files before going on.", description: "HI-3125: an error from Set Aside (a paused merge, a start's warning): git's stash ran, but another git command (the user's terminal, an agent) made a stash with the same name at the same moment, or git couldn't show what one holds, so Combwork can't say which stash holds the changes and doesn't treat any as done. Keep git stash list as it is: a command." }),
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
    // a commit's hook can change paths beyond `files`). With their flags (HI-3125), as takeEntries compares them.
    const was = await entriesIn(folder, null, copy, true)
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
    // With their flags (HI-3125), as `was` is: a flag set on one meanwhile (skip-worktree, say) keeps it, as a re-stage does.
    const now = await entriesIn(folder, files, scratch, true)
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

/**
 * The entries the private index `copy` has for `files` (null: every one), as `ls-files -s` says them (mode, object,
 * stage, path). `flags`: each with its tag first, as `-v` gives it (`H`; `S` skip-worktree; lower case, assume
 * unchanged), for comparing (HI-3125: a flag another git sets meanwhile is a change of that entry); never for
 * `--index-info`, which takes the plain lines.
 */
async function entriesIn(folder: string, files: string[] | null, copy: string, flags = false): Promise<{ ok: true; entries: string[] } | { ok: false; why: string }> {
  // Every entry, those of `files` kept (ls-files takes no pathspecs on its input, and they can be many). No fsmonitor.
  const ls = await git(folder, ['-c', 'core.fsmonitor=false', 'ls-files', '-s', ...(flags ? ['-v'] : []), '-z', '--full-name'], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: copy } })
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
  /** HI-3081: added as intent-to-add (`git add -N`: porcelain's ` A`, or a rename's new side, ` R`). */
  ita?: boolean
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
    const ita = c.ita || was?.ita
    out.set(path, { untracked: c.untracked || !!was?.untracked, ...(deleted ? { deleted } : {}), ...(from ? { from } : {}), ...(unmerged ? { unmerged } : {}), ...(staged ? { staged } : {}), ...(gone ? { gone } : {}), ...(ita ? { ita } : {}) })
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
    } else if (xy[1] === 'R' || xy[1] === 'C') {
      // HI-3081: a rename git sees in the folder only (` R`, its new side intent-to-add): its other side is the next
      // entry, never one of its own; the old side's deletion isn't staged.
      const from = parts[++i]
      put(path, { untracked: false, from, ita: true })
      if (from && xy[1] === 'R') put(from, { untracked: false, gone: true })
    } else if (UNMERGED.has(xy)) put(path, { untracked: false, unmerged: true })
    else put(path, { untracked: xy === '??', deleted: xy[0] === 'D', staged: xy[0] !== ' ' && xy[0] !== '?', gone: xy[1] === 'D', ita: xy === ' A' })
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

/**
 * A commit or stash made (its id), with what its index step left for the user to check, if anything (HI-3059: a
 * warning on a success, never an error: the window says it was made).
 */
interface MadeWith {
  made: string
  warning?: Text
}

/**
 * What taking a made commit's or stash's entries into the real index gave: nothing to say, or the warning. HI-3053: the
 * paths another git staged meanwhile, kept as it staged them; HI-3021: the step failed.
 */
function indexWarning(action: FolderChangeAction, made: string, took: Taken): Text | undefined {
  const what = action === 'commit' ? 'A commit' : 'A stash' // i18n-ignore: part of a log line
  if (!took.ok) {
    log.warn(`${what} was made (${made}), but its entries weren't taken into the index: ${userText(took.why)}`)
    return withValues(M.indexNotTaken, { action, made: made.slice(0, 12), why: took.why })
  }
  if (!took.kept.length) return undefined
  log.warn(`${what} was made (${made}), and ${took.kept.length} paths staged meanwhile by another git were kept`)
  return withValues(M.indexKept, { action, made: made.slice(0, 12), file: took.kept[0], others: took.kept.length - 1 })
}

/**
 * HI-3124: the first of `subs` whose new commit is staged while its recorded commit (HEAD's) is checked out in it again
 * (`MM`): git commits what the folder has, the recorded commit, so there's nothing to commit. Its commit read inside
 * it; unreadable, it isn't named (the commit then says what git says).
 */
async function stagedBack(folder: string, subs: readonly SubmoduleChange[]): Promise<string | null> {
  for (const s of subs) {
    if (s.state !== 'staged' || !s.recorded) continue
    const r = await git(join(folder, s.path), ['rev-parse', '-q', '--verify', 'HEAD'])
    if (r.ok && r.out.trim() === s.recorded) return s.path
  }
  return null
}

/**
 * HI-3124 (HR3's round 1): a path as one argument of a git command the user is told to run, after `--` (so a path
 * starting with `-` isn't an option), in whichever terminal they use (PowerShell, cmd or Git Bash): as it is when
 * nothing in it needs quoting; else in double quotes, which all three take as one argument with its spaces; else, a
 * character double quotes don't keep literal in one of them being in it (`$`, a backtick, `"`, `!`, `%`), in single
 * quotes, PowerShell's (and Git Bash's, but for a `'` in it, doubled for PowerShell).
 */
export function commandPath(path: string): string {
  if (/^[\p{L}\p{N}._/@+,=:-]+$/u.test(path)) return path
  if (!/[$`"!%]/.test(path)) return `"${path}"`
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * HI-3124 (HR3's round 2): a path as a git command the user is told to run takes it, literal at both layers: to git, a
 * path with a glob character in it (`*`, `?`, `[`, `\`) or starting with `:` (pathspec magic) as `:(literal)<path>`, or
 * `libs/[ab]` would also match `libs/a` (`git restore --staged` then unstaging that too); to the shell, commandPath.
 */
export function gitPathArg(path: string): string {
  return commandPath(/[*?[\\]|^:/.test(path) ? `:(literal)${path}` : path)
}

/** HI-3124: Set Aside's refusal of a submodule, saying how it changed and what clears it. */
function submoduleRefusal(s: SubmoduleChange): Error {
  const folder = s.path
  switch (s.state) {
    case 'moved':
      return combworkError(M.submoduleMoved, { folder })
    case 'staged':
      return combworkError(M.submoduleStaged, { folder, path: gitPathArg(folder) })
    case 'added':
      return combworkError(M.submoduleAdded, { folder })
    case 'removed':
      return combworkError(M.submoduleRemoved, { folder })
    case 'deleted':
      return combworkError(M.submoduleDeleted, { folder, path: gitPathArg(folder) })
    default:
      return combworkError(M.submoduleOther, { folder })
  }
}

const samePlace = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/**
 * Under the lock and the fence: the folder still on `branch` (null: any branch, never a detached HEAD), no operation
 * under way, no agent or run working there. `agentsAt`: the projects whose agents count, each with the folder they'd
 * work in (the folder's own project's agents there, unless the caller names more). Throws the refusal, in the
 * window's words.
 */
async function assertQuiet(projectPath: string, folder: string, branch: string | null, agentsAt: readonly { project: string; folder: string }[] = [{ project: projectPath, folder }]): Promise<{ line: string; inside: string[]; submodules: SubmoduleChange[] }> {
  const now = await worktreeNow(folder)
  if (isUnknown(now)) throw failed(M.commitFailed, now.detail ?? now.what)
  // The operations under way, apart from the files (HI-2983: a changed file named `(MERGE_HEAD)` is a file). First
  // (HI-3081): a rebase detaches HEAD, and is what the user should hear about, not a detached HEAD.
  const marker = now.operations?.[0]
  if (marker) throw combworkError(M.midOperation, { state: STATES[marker] ?? 'revert', folder })
  if (!now.line) throw combworkError(M.detached, { folder })
  if (branch !== null && now.line !== branch) throw combworkError(M.wrongBranch, { folder, target: branch })
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
async function commitPaths(folder: string, files: string[], untracked: string[], message: string, byIndex?: { removed: string[]; staged: string[] }): Promise<MadeWith> {
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
    if (!r.ok) throw failed(M.commitFailed, `${r.err}\n${r.out}`)
    // HI-3125: this commit, never whatever HEAD is now (another git can commit right after it): the one git says it made.
    const made = await ownCommit(folder, before, message, r.out)
    if (made === undefined) throw failed(M.commitFailed, "git couldn't read the branch after the commit") // i18n-ignore: stands in for git's own (English) words
    if (made === null) {
      log.warn(`git committed in ${userText(folder)}, but no commit "${userText(message)}" is on the branch since ${before ?? '(none)'}: not credited`)
      throw failed(M.commitFailed, "git said it committed, but the commit isn't on the branch now (another git moved it): check git log") // i18n-ignore: stands in for git's own (English) words
    }
    // HI-3074: from the commit, never the private index: a pre-commit hook's `git add` (a formatter, a generated file)
    // goes into what git commits, not into the private index.
    const entries = await entriesOfCommit(folder, made, before, files)
    // HI-3059: from here the commit is made, whatever its index step gives: said with it, never as a failure.
    const took = entries.ok ? await take(entries) : entries
    return { made, warning: indexWarning('commit', made, took) }
  })
}

/**
 * HI-3125 (HR1's round 1): the commit a `git commit` says it made, from its summary (`[main 1a2b3c4] …`, or
 * `[main (root-commit) …]`), which git prints last, after its post-commit hook: the last such line's
 * object, abbreviated as git makes it unique. Undefined: none printed.
 */
export function reportedCommit(out: string): string | undefined {
  // HR1's round 2: the branch as one word (a branch name has no space, but may have `]`), `(root-commit)` after it on a
  // first commit, then the object as short as `core.abbrev` allows (4). Never detached here: Commit refuses that first.
  const all = [...out.matchAll(/^\[[^ \n]+(?: \(root-commit\))? ([0-9a-f]{4,64})\] /gm)]
  return all.at(-1)?.[1]
}

/**
 * HI-3125: the commit this `git commit` made, git having said it did, on the branch since `before` (first parents, from
 * HEAD back; the branch's whole history when it had none). Never HEAD alone: another git (the user's terminal, an agent)
 * can commit right after it, or just before it. The commit git's own summary named (its `out`): a hook may rewrite the
 * message (HR1's round 1: a ticket prefix), and another commit can have the same one. With no summary to read, the
 * newest there with `message`. Null: none there; undefined: the branch unreadable. Bounded to the branch's last 50
 * commits: no more land in a moment.
 */
async function ownCommit(folder: string, before: string | null, message: string, out: string): Promise<string | null | undefined> {
  const r = await git(folder, ['log', '--first-parent', '-n', '50', '--format=%H%x00%s', before ? `${before}..HEAD` : 'HEAD', '--'])
  if (!r.ok) return undefined
  const since = r.out.split('\n').map((line) => ({ oid: line.slice(0, Math.max(0, line.indexOf('\0'))).trim(), subject: line.slice(line.indexOf('\0') + 1) })).filter((c) => c.oid)
  const said = reportedCommit(out)
  if (said) {
    // Resolved as it was printed (unique then); unresolvable, none.
    const full = await git(folder, ['rev-parse', '-q', '--verify', `${said}^{commit}`])
    const oid = full.ok ? full.out.trim() : ''
    return since.some((c) => c.oid === oid) ? oid : null
  }
  return since.find((c) => c.subject === message)?.oid ?? null
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
  // Not --quiet (HI-3125): its summary names the commit it made (reportedCommit).
  return git(folder, ['commit', '--only', '-m', message, ...PATHS_IN], undefined, pathsIn(files), { env, timeout: folderChangesBounds.actMs })
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
  // Not --quiet (HI-3125): its summary names the commit it made (reportedCommit).
  return git(folder, ['commit', '-m', message], undefined, undefined, bound)
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

/** The folder's stashes now, newest first: each one's object and subject (`On main: <message>`). Null: unreadable. */
async function stashesNow(folder: string): Promise<{ oid: string; subject: string }[] | null> {
  const r = await git(folder, ['stash', 'list', '--format=%H%x00%s'])
  if (!r.ok) return null
  return r.out
    .split('\n')
    .map((l) => ({ oid: l.slice(0, l.indexOf('\0')).trim(), subject: l.slice(l.indexOf('\0') + 1) }))
    .filter((s) => s.oid)
}

/**
 * HI-3125: the stash this `stash push -m <message>` made, its message carrying this Set Aside's own mark (`[cw:…]`,
 * settleChanges): the one new stash (not among `before`, the objects there as it started) with exactly that message
 * (`On <branch>: <message>`). Never the stash ref having moved (another git's stash just before or after it moves it
 * too; a push that saved nothing moves it not at all), nor a message another git can reuse (HR1's rounds 1 and 2,
 * HR2's round 3: the shown path stashed in Combwork's words just before its push, which then saved nothing). None: not
 * made. The stashes unreadable, or two with its mark: not known, never guessed.
 */
async function ownStash(folder: string, before: ReadonlySet<string>, message: string): Promise<string | null | 'unproved'> {
  const now = await stashesNow(folder)
  if (!now) return 'unproved'
  const mine = now.filter((s) => !before.has(s.oid) && s.subject.endsWith(`: ${message}`))
  if (mine.length > 1) return 'unproved'
  return mine[0]?.oid ?? null
}

/**
 * Sets `files` aside as a named stash (`git stash push --include-untracked`, the paths on its input): only those paths, other index
 * entries as they were. The stash made is told by its message, which carries this Set Aside's own mark (ownStash),
 * among the new ones. A failure after git made it is said with the stash, kept: never rolled back. It runs against a
 * private copy of the index (withPrivateIndex, HI-3021): once a stash is made, the real index's entries for `files`
 * become what git left them (takeEntries), however far it got; with none made, the real index is as it was.
 */
async function setAsidePaths(folder: string, files: string[], message: string, renamedFrom: string[] = [], ita: string[] = []): Promise<MadeWith> {
  // HI-3081: git's stash on a branch with no commit yet fails, saying why only without --quiet: said here instead.
  if ((await headOf(folder)) === null) throw failed(M.stashFailed, "the branch has no commit yet, and git can't set changes aside before its first one") // i18n-ignore: stands in for git's own (English) words
  // HI-3125: the stashes there as it starts, so its own is told by its message among the new ones.
  const was = await stashesNow(folder)
  if (!was) throw failed(M.stashFailed, "git couldn't list the stashes") // i18n-ignore: stands in for git's own (English) words
  const before = new Set(was.map((s) => s.oid))
  // HI-3022: a staged rename's old side is in neither the index nor the folder, and git's stash, given it, makes the
  // stash and then dies on it ("pathspec … did not match any files"), every try. Given the new side alone, it stashes
  // the rename whole (the stash's index and folder both without the old side, so `git stash pop --index` gives the
  // rename back) and leaves the old side's removal staged: the old side is then put back from HEAD.
  const stashed = files.filter((p) => !renamedFrom.includes(p))
  // Never a stash with no paths: it would take every change in the folder.
  if (!stashed.length) throw failed(M.stashFailed, 'nothing to set aside but a rename\'s old side') // i18n-ignore: stands in for git's own (English) words
  const { r, made, warning } = await withPrivateIndex(folder, files, M.stashFailed, async (env, copy, take) => {
    // HI-3081: git's stash can't take an intent-to-add entry ("Entry … not uptodate. Cannot merge"): taken out of the
    // private index first, the file is set aside as the untracked file it is (and comes back untracked). Combwork's own
    // step: nothing of the repository's run, bounded.
    if (ita.length) {
      const quiet = await noHooks(folder, copy)
      if (!quiet.ok) throw failed(M.stashFailed, quiet.why)
      const out = await git(folder, [...quiet.args, 'rm', '--cached', '-q', '--ignore-unmatch', ...PATHS_IN], undefined, pathsIn(ita), { env, timeout: folderChangesBounds.actMs })
      if (!out.ok) throw out.timedOut ? combworkError(M.stashTimedOut, { seconds: boundSeconds(), made: 'no', stash: '' }) : failed(M.stashFailed, out.err)
    }
    let pushed = await git(folder, ['stash', 'push', '--include-untracked', '--quiet', '-m', message, ...PATHS_IN], undefined, pathsIn(stashed), { env, timeout: folderChangesBounds.actMs })
    const own = await ownStash(folder, before, message)
    if (own === 'unproved') {
      // HR1's round 2: never another git's stash taken for its own, nor its index step run on one; the stashes kept.
      log.warn(`A stash "${userText(message)}" in ${userText(folder)}: which is Combwork's can't be told (another git's of the same name, or one unreadable)`)
      throw combworkError(M.stashUnproved)
    }
    const stash = own
    if (stash && pushed.ok && renamedFrom.length) pushed = await restoreOldSides(folder, env, renamedFrom)
    // HI-3059: a stash made is said made, whatever its index step gives (logged there too, should git's own failure be
    // what is said below).
    const said = stash ? indexWarning('setAside', stash, await take()) : undefined
    return { r: pushed, made: stash, warning: said }
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
    return { made, warning }
  }
  if (!r.ok) {
    if (made) {
      log.warn(`A stash was made in ${userText(folder)} before git failed: ${made}`)
      throw combworkError(M.stashPartial, { stash: made.slice(0, 12), why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) })
    }
    throw failed(M.stashFailed, r.err)
  }
  if (!made) {
    // HI-3125: git's push saved nothing (it says so and exits 0): never done. The paths unchanged now (another git put
    // them back, or set them aside itself, just before): the changes aren't the ones shown any more.
    if (await leftUnchanged(folder, files)) throw combworkError(M.changed, { folder })
    throw failed(M.stashFailed, r.err || r.out || 'no stash was made') // i18n-ignore: stands in for git's own (English) words
  }
  return { made, warning }
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
        // HI-3125 (HR2's round 3): a stash's name carries this Set Aside's own mark, so it is told from another git's of the
        // same words (one made just before, say, of the same file, while this push saves nothing). Still named after the card.
        const message = action === 'commit' ? `Commit changes ${label}` : `Combwork: set aside ${label} [cw:${randomBytes(3).toString('hex')}]` // i18n-ignore: the commit's or stash's message, in the repository (English, as Combwork's other commits)
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
        // HI-3124: a new commit staged for a submodule that has its recorded commit checked out again: git's commit (of
        // what the folder has) finds nothing to commit, and its stash can't take it. Unstaging is the way out.
        const back = await stagedBack(folder, submodules.filter((s) => files.includes(s.path)))
        if (back) throw combworkError(M.submoduleStagedBack, { folder: back, path: gitPathArg(back) })
        const removed = await removedIn(folder, files, now)
        const kept = await keptDeleted(removed)
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        if (action === 'setAside') {
          // HI-3052: git's stash sets no submodule aside (its checked-out commit, staged or not, added, or deleted, stays
          // as it is, reported set aside; its staged removal fails the stash). Commit takes each. HI-3124: refused saying
          // how it changed, with what clears it.
          const changedSub = submodules.find((s) => files.includes(s.path))
          if (changedSub) throw submoduleRefusal(changedSub)
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
        const { made, warning } = action === 'commit' ? await commitPaths(folder, files, files.filter((p) => now.get(p)?.untracked && !now.get(p)?.deleted), message, byIndex) : await setAsidePaths(folder, files, message, [...removed.keys()].filter((p) => [...now.values()].some((c) => c.from === p)), files.filter((p) => now.get(p)?.ita))
        log.info(`${action === 'commit' ? 'Committed' : 'Set aside'} ${files.length} paths in ${userText(folder)} on ${userText(branch)}`)
        return { action, folder, branch, files, message, made, ...(warning ? { warning } : {}) }
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
        const { made, warning } = await commitPaths(repo.top, [file], now.get(file)!.untracked ? [file] : [], message)
        log.info(`Committed .gitignore in ${userText(repo.top)} on ${userText(branch)}`)
        return { action: 'commit', folder: repo.top, branch, files: [file], message, made, ...(warning ? { warning } : {}) }
      }),
    { project: repo.cwd }
  )
}
