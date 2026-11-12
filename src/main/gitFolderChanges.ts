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
import { copyFile, lstat, readdir, rm } from 'original-fs/promises'
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
  indexNotTaken: msg({ id: 'service.folderChanges.indexNotTaken', defaultMessage: "{action, select, commit {Git made the commit ({made})} other {Git set the changes aside in a stash ({made})}}, but Combwork couldn't update the index for those files afterwards: {why}. Until it's updated, git status may show them as changed in the index: once no git command is running, run git reset on them.", description: "HI-3021: an error from Commit or Set aside (a paused merge, a start's warning): git committed (or stashed) the files ({made}, a commit or stash id), but updating git's index (staging area) for them afterwards failed; {why} is git's own message (English), often another git command holding the index. {action} is commit or setAside. Keep git status and git reset as they are: commands." }),
  stashTimedOut: msg({ id: 'service.folderChanges.stashTimedOut', defaultMessage: "Git didn't finish setting the changes aside in {seconds, number} seconds, so Combwork ended it and everything it had started.{made, select, yes { It had kept them in a stash ({stash}) by then.} other {}} Check git stash list and the files before going on.", description: "HI-3021: an error from Set aside (a paused merge, a start's warning): git stash ran past its time limit ({seconds}) and Combwork ended it. {made} is yes when git had made a stash ({stash}, its id) by then. Keep git stash list as it is: a command." }),
  stashFailed: msg({ id: 'service.folderChanges.stashFailed', defaultMessage: 'Git did not set the changes aside: {why}', description: "HI-2944: an error from Set aside: git refused to stash the changes; {why} is its own message (English). The files are as they were." }),
  deletedKept: msg({ id: 'service.folderChanges.deletedKept', defaultMessage: "{file} is staged for removal from Git: commit it yourself in Git; Combwork won't add it back.", description: "HI-2982: an error from Commit or Set aside (a paused merge, a start's warning): the file ({file}, a path) had its removal from Git staged (Files' Stop Tracking) and is still on disk; git's commit or stash would put it back, so nothing was done. The user commits the removal in Git themselves." }),
  nestedRepo: msg({ id: 'service.folderChanges.nestedRepo', defaultMessage: '{folder} is a Git repository of its own inside this one, so Combwork doesn\'t commit it or set it aside. Add it to .gitignore, or as a submodule, yourself.', description: "HI-2983: an error from Commit or Set aside (a paused merge, a start's warning): one of the changes shown ({folder}, a folder path ending in /) is an untracked folder that is a Git repository of its own; nothing was done. Keep .gitignore: a file name." }),
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
async function withPrivateIndex<T>(folder: string, m: (typeof M)['commitFailed'] | (typeof M)['stashFailed'], fn: (env: NodeJS.ProcessEnv, copy: string) => Promise<T>): Promise<T> {
  const where = await git(folder, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!where.ok || !where.out.trim()) throw failed(m, where.err || "git didn't say where its index is") // i18n-ignore: stands in for git's own (English) words
  const copy = `${resolve(where.out.trim())}.combwork-${process.pid}-${++privateIndexes}`
  // No index yet (a repository with nothing added): git starts the copy empty, as it would the index.
  await copyFile(where.out.trim(), copy).catch((e: NodeJS.ErrnoException) => {
    if (e?.code !== 'ENOENT') throw failed(m, e?.message ?? String(e))
  })
  try {
    return await fn({ ...quietEnv(), GIT_INDEX_FILE: copy }, copy)
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
  for (const name of names.filter((n) => n === own || n.startsWith(`${own}.`))) {
    for (let t = 1; ; t++) {
      const e = await rm(join(dir, name), { force: true }).then(
        () => null,
        (err: NodeJS.ErrnoException) => err
      )
      if (!e) break
      if (t >= TAKE_TRIES || (e.code !== 'EBUSY' && e.code !== 'EPERM')) {
        log.warn(`A private index's file wasn't removed (${userText(name)}): ${userText(e.message)}`)
        break
      }
      await new Promise((res) => setTimeout(res, TAKE_RETRY_MS))
    }
  }
}

/** How many times the real index is tried while another git holds it, and how long between (INDEX_BUSY). */
const TAKE_TRIES = 10
const TAKE_RETRY_MS = 100

/**
 * HI-3021: the real index's entries for `files` made what git left them in the private index `copy`: each path's
 * entries removed, then each of the copy's put in (`update-index --index-info`, one short command under the real
 * index's lock, tried again while another git holds it). Every other entry is left.
 */
async function takeEntries(folder: string, copy: string, files: string[]): Promise<{ ok: true } | { ok: false; why: string }> {
  const from = await entriesIn(folder, files, copy)
  if (!from.ok) return from
  const fmt = await git(folder, ['rev-parse', '--show-object-format'])
  const none = '0'.repeat(fmt.out.trim() === 'sha256' ? 64 : 40)
  const input = [...files.map((p) => `0 ${none}\t${p}`), ...from.entries].map((l) => `${l}\0`).join('')
  const quiet = await noHooks(folder, copy)
  if (!quiet.ok) return quiet
  // HR2's round 4: never bounded, so never ended while it holds the real index's lock (on Windows an ended git leaves it):
  // it runs nothing of the repository's (noHooks), so it waits only on git's own work. Off main's thread (git's worker).
  const take = (): Promise<GitResult> => git(folder, [...quiet.args, 'update-index', '-z', '--index-info'], undefined, input)
  let r = await take()
  for (let t = 1; t < TAKE_TRIES && !r.ok && INDEX_BUSY.test(r.err); t++) {
    await new Promise((res) => setTimeout(res, TAKE_RETRY_MS))
    r = await take()
  }
  // Their stat data stays empty, so git compares their content once more: refreshing it could run a filter unbounded.
  return r.ok ? { ok: true } : { ok: false, why: gitErrorLine(r.err) || r.err.trim() }
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

/** The entries the private index `copy` has for `files`, as `ls-files -s` says them (mode, object, stage, path). */
async function entriesIn(folder: string, files: string[], copy: string): Promise<{ ok: true; entries: string[] } | { ok: false; why: string }> {
  // Every entry, those of `files` kept (ls-files takes no pathspecs on its input, and they can be many). No fsmonitor.
  const ls = await git(folder, ['-c', 'core.fsmonitor=false', 'ls-files', '-s', '-z', '--full-name'], undefined, undefined, { env: { ...process.env, GIT_INDEX_FILE: copy } })
  if (!ls.ok) return { ok: false, why: gitErrorLine(ls.err) || ls.err.trim() }
  const wanted = new Set(files)
  return { ok: true, entries: ls.out.split('\0').filter((e) => e && wanted.has(e.slice(e.indexOf('\t') + 1))) }
}

/** The same entries, whatever their order: each side sorted once (HR2's round 4: never once per entry). */
export function sameEntries(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((e, i) => e === y[i])
}

/**
 * HI-3021 (HR2's round 3): whether `now`, HEAD after a commit ended at its bound, is the commit this one made, not one
 * another git made meanwhile (the real index is free while the commit runs): its parent is the HEAD it started from
 * (none on an unborn branch), its message is this one's, and its tree has exactly the private index's entries for
 * `files` (git's commit --only puts the committed content there).
 */
async function madeByThis(folder: string, now: string, before: string | null, message: string, copy: string, files: string[]): Promise<boolean> {
  const parent = await git(folder, ['rev-parse', '-q', '--verify', `${now}^`])
  if (before === null ? parent.ok : !parent.ok || parent.out.trim() !== before) return false
  const said = await git(folder, ['log', '-1', '--format=%B', now])
  if (!said.ok || said.out.trim() !== message.trim()) return false
  const inCopy = await entriesIn(folder, files, copy)
  if (!inCopy.ok || inCopy.entries.some((e) => !/\t/.test(e) || e.split(' ')[2]?.split('\t')[0] !== '0')) return false
  // ls-tree's `mode type object\tpath`, the copy's `mode object 0\tpath`: compared as `mode object\tpath`.
  const tree = await git(folder, ['ls-tree', '-r', '-z', '--full-tree', now])
  if (!tree.ok) return false
  const wanted = new Set(files)
  const inTree = tree.out.split('\0').filter((e) => e && wanted.has(e.slice(e.indexOf('\t') + 1))).map((e) => {
    const [meta, path] = [e.slice(0, e.indexOf('\t')), e.slice(e.indexOf('\t') + 1)]
    const [mode, , object] = meta.split(' ')
    return `${mode} ${object}\t${path}`
  })
  const fromCopy = inCopy.entries.map((e) => {
    const [meta, path] = [e.slice(0, e.indexOf('\t')), e.slice(e.indexOf('\t') + 1)]
    const [mode, object] = meta.split(' ')
    return `${mode} ${object}\t${path}`
  })
  return sameEntries(inTree, fromCopy)
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
  return now.line
}

/**
 * Commits `files` by git alone, against a private copy of the index (withPrivateIndex, HI-3021): an untracked one added
 * there as intent-to-add first, then `commit --only`, which commits their working-tree content. The real index is
 * touched only once the commit is made: its entries for `files` become git's (takeEntries), every other one as it was.
 * A refused commit leaves the real index as it was, intent-to-add entries never in it. Never given a path whose removal
 * is staged while its file is still in the folder (settleChanges and commitIgnore refuse it first, keptDeleted).
 */
async function commitPaths(folder: string, files: string[], untracked: string[], message: string): Promise<string> {
  // What the branch was, to tell a commit made before the bound ended git (a post-commit hook); unreadable, nothing runs.
  const before = await headOf(folder)
  if (before === undefined) throw failed(M.commitFailed, "git couldn't read HEAD") // i18n-ignore: stands in for git's own (English) words
  return withPrivateIndex(folder, M.commitFailed, async (env, copy) => {
    if (untracked.length) {
      const add = await git(folder, ['add', '--intent-to-add', ...PATHS_IN], undefined, pathsIn(untracked), { env })
      if (!add.ok) throw failed(M.commitFailed, add.err)
    }
    const r = await git(folder, ['commit', '--only', '--quiet', '-m', message, ...PATHS_IN], undefined, pathsIn(files), { env, timeout: folderChangesBounds.actMs })
    // Ended at its bound after the commit was made (in post-commit): it is made. Only a HEAD read, moved, and proved this
    // commit's says so (HR2's round 3: another git can commit meanwhile, the real index being free).
    const now = r.ok || r.timedOut ? await headOf(folder) : undefined
    const made = typeof now === 'string' && (r.ok || (now !== before && (await madeByThis(folder, now, before, message, copy, files)))) ? now : null
    if (!made) {
      if (r.timedOut) throw combworkError(M.commitTimedOut, { seconds: boundSeconds() })
      throw failed(M.commitFailed, r.ok ? "git couldn't read HEAD after the commit" : `${r.err}\n${r.out}`) // i18n-ignore: stands in for git's own (English) words
    }
    if (!r.ok) log.warn(`A commit in ${userText(folder)} was ended at its bound after it was made (${made})`)
    const took = await takeEntries(folder, copy, files)
    if (!took.ok) throw combworkError(M.indexNotTaken, { action: 'commit', made: made.slice(0, 12), why: took.why })
    return made
  })
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
 * Sets `files` aside as a named stash (`git stash push --include-untracked`, the paths on its input): only those paths, other index
 * entries as they were. The stash made is told by the stash ref moving to a new object (never by its message: an older
 * one can have the same). A failure after git made it is said with the stash, kept: never rolled back. It runs against a
 * private copy of the index (withPrivateIndex, HI-3021): once a stash is made, the real index's entries for `files`
 * become what git left them (takeEntries), however far it got; with none made, the real index is as it was.
 */
async function setAsidePaths(folder: string, files: string[], message: string): Promise<string> {
  const before = await stashTop(folder)
  const { r, made } = await withPrivateIndex(folder, M.stashFailed, async (env, copy) => {
    const pushed = await git(folder, ['stash', 'push', '--include-untracked', '--quiet', '-m', message, ...PATHS_IN], undefined, pathsIn(files), { env, timeout: folderChangesBounds.actMs })
    const after = await stashTop(folder)
    const stash = after && after !== before ? after : null
    if (stash) {
      const took = await takeEntries(folder, copy, files)
      if (!took.ok) throw combworkError(M.indexNotTaken, { action: 'setAside', made: stash.slice(0, 12), why: took.why })
    }
    return { r: pushed, made: stash }
  })
  if (!r.ok && r.timedOut) {
    // HI-3021: ended at its bound, part way: the stash it made by then named, kept.
    if (made) log.warn(`A stash was made in ${userText(folder)} before git was ended at its bound: ${made}`)
    throw combworkError(M.stashTimedOut, { seconds: boundSeconds(), made: made ? 'yes' : 'no', stash: made ? made.slice(0, 12) : '' })
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
        const branch = await assertQuiet(projectPath, folder, target)
        guard?.()
        const now = await changedIn(folder)
        if (!shown.length || !shown.every((p) => now.has(p))) throw combworkError(M.changed, { folder })
        // A rename's other side goes with it: committed or set aside, the rename stays whole.
        const files = [...new Set(shown.flatMap((p) => [p, ...(now.get(p)?.from ? [now.get(p)!.from!] : [])]))]
        const message = action === 'commit' ? `Commit changes ${label}` : `Combwork: set aside ${label}` // i18n-ignore: the commit's or stash's message, in the repository (English, as Combwork's other commits)
        // A folder git lists whole: an untracked repository of its own, never committed or stashed as one (HI-2983).
        const nested = files.find((p) => p.endsWith('/'))
        if (nested) throw combworkError(M.nestedRepo, { folder: nested })
        const kept = await keptDeleted(folder, files, now)
        if (kept) throw combworkError(M.deletedKept, { file: kept })
        // Set aside: always exactly the paths shown, never the whole folder's (HR1's round 1: a change made after this
        // read, never shown, would go into the stash and off the disk); only as many as git's own commands can be given
        // (HI-2983), refused before any stash is made.
        if (action === 'setAside' && files.reduce((n, p) => n + stashPathCost(p), 0) > STASH_PATHS_MAX) throw combworkError(M.tooManyToSetAside, { count: files.length, folder })
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
