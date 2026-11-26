// HI-3477: the Files tab's Discard Changes… and Restore From… (SPEC §16.10.2, Discard and restore a file), the user's
// click at a time, never an agent's tool: one tracked file of the project folder.
// - Discard: the file's uncommitted changes (staged and not) stashed, which puts it back to the commit checked out: a
//   stash of that file alone (HI-3587: `git stash push -- <file>` keeps every staged file's changes too), stashFile.
// - Restore From: its changes stashed the same way when it has any, then its version on the target (the commit the
//   confirm showed, even if the target moves meanwhile) or in a commit picked: `git restore --source=<commit>
//   --worktree -- <file>`, so it shows in Changes as a change to commit.
// The stash keeps what was there, named as Set Aside's are (`Combwork: set aside before discarding <file> [cw:…]`), so
// Changes' Stashes (HI-3472) lists it and Apply brings it back. Each runs under the repository lock and the folder's
// fence, refused as Stashes' Apply is (gitStashes.ts): an operation under way or the file in conflict, a Combwork run or
// an agent's lock there, an agent working there, or the caller's guard (a session there: fileRestorePanel.ts).
import { randomBytes } from 'crypto'
import { rm } from 'original-fs/promises'
import { join, resolve, sep } from 'path'
import { HISTORY_COMMITS, type GitCommitRow } from '../../../shared/gitRepo'
import type { FileCommits, FileRestored, FileRestorePlan, FileRestoreRequest, RestoreSource } from '../../../shared/gitFileRestore'
import type { GitDiff } from '../../../shared/types'
import { msg } from '../../../shared/i18n'
import { combworkError } from '../../combworkError'
import { changingFolder } from '../../folderFence'
import { insideReal } from '../../fsutil'
import { git, gitErrorLine, isBinary, MAX_DIFF_BYTES, tooLargeDiff, workingCopy, type GitResult } from '../../git'
import { operationSync } from '../../gitCommands'
import { busyAgentIn } from '../../gitRepo'
import { createLogger, userText } from '../../logger'
import { withRepoLock } from '../../repoLock'
import { workspace } from '../../workspace'
import { platformLimits } from '../limits'

const log = createLogger('git-restore')

export const RESTORE_TEXT = {
  invalid: msg({ id: 'service.gitRestore.invalid', defaultMessage: 'That was asked for wrongly: nothing was done.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: the request was malformed (not reached from the window)." }),
  notTracked: msg({ id: 'service.gitRestore.notTracked', defaultMessage: "Git doesn't track {file}: nothing was done.", description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: the file ({file}, a path) isn't one git tracks." }),
  noTarget: msg({ id: 'service.gitRestore.noTarget', defaultMessage: "The project's target isn't a branch here: nothing was done.", description: "HI-3477: an error from the Files tab's Restore From → Target Branch: the project's target branch isn't a branch in this repository." }),
  noCommit: msg({ id: 'service.gitRestore.noCommit', defaultMessage: "That commit isn't in this repository: nothing was done.", description: "HI-3477: an error from the Files tab's Restore From → A Commit…: the commit chosen can't be found." }),
  notFile: msg({ id: 'service.gitRestore.notFile', defaultMessage: "{file} isn't a file in {commit} (a folder or a submodule there): nothing was done.", description: "HI-3477: an error from the Files tab's Restore From…: at the commit chosen or on the target ({commit}, a short commit id) the path ({file}) is a folder or a submodule, not a file, so it can't be restored as one." }),
  missing: msg({ id: 'service.gitRestore.missing', defaultMessage: "{file} isn't in {commit}: nothing was done.", description: "HI-3477: an error from the Files tab's Restore From…: the file ({file}, a path) isn't in the commit chosen or on the target ({commit}, a short commit id)." }),
  nothing: msg({ id: 'service.gitRestore.nothing', defaultMessage: '{file} has no uncommitted changes: nothing was done.', description: "HI-3477: an error from the Files tab's Discard Changes…: the file ({file}, a path) has nothing to discard (committed or discarded meanwhile)." }),
  moved: msg({ id: 'service.gitRestore.moved', defaultMessage: 'The commit checked out changed meanwhile: nothing was done. Look again.', description: "HI-3477: an error from the Files tab's Discard Changes…: the folder's HEAD moved since the confirm showed the diff (a commit, a switch)." }),
  operation: msg({ id: 'service.gitRestore.operation', defaultMessage: 'Git is in the middle of {what, select, merge {a merge} rebase {a rebase} am {an am} cherryPick {a cherry-pick} bisect {a bisect} other {a revert}} in {folder}: nothing was done. Finish it first (Version Control → Changes).', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: an operation is under way in the folder ({what}, git's word for it; {folder} a path); Changes' panel ends it." }),
  conflicted: msg({ id: 'service.gitRestore.conflicted', defaultMessage: '{file} is in conflict: nothing was done. Settle it first.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: the file ({file}, a path) is in conflict." }),
  agentBusy: msg({ id: 'service.gitRestore.agentBusy', defaultMessage: '{agent} is working in {folder}: nothing was done. Try again once it has finished.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: an agent ({agent}) works in the folder ({folder}, a path)." }),
  busy: msg({ id: 'service.gitRestore.busy', defaultMessage: 'A run or an agent is working in {folder} ({what}): nothing was done. Try again once it has finished.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: a run (a test, a build) or an agent's file lock is in the folder ({folder}, a path); {what} names the first one's folder or file." }),
  failed: msg({ id: 'service.gitRestore.failed', defaultMessage: 'Git refused: {why}', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: git's own command failed; {why} is git's error line, in English." }),
  stashedFailed: msg({ id: 'service.gitRestore.stashedFailed', defaultMessage: "Git refused: {why}. The file's changes are kept in Version Control → Changes → Stashes.", description: "HI-3477: an error from the Files tab's Restore From…: the file's changes were stashed, then git's restore failed; {why} is git's error line, in English. Apply in the Stashes list brings them back." }),
  timedOut: msg({ id: 'service.gitRestore.timedOut', defaultMessage: 'Git was still running after {seconds, number} seconds, so Combwork ended it. Look at {file} and Version Control → Changes → Stashes before you try again.', description: "HI-3477: an error from the Files tab's Discard Changes… or Restore From…: git ran past Settings → Advanced's longest commit or set aside time ({seconds}) and was ended; {file} is a path." })
}
const M = RESTORE_TEXT

/** What the folder fence says while a Discard or Restore runs (the queue's log and its starts' wait). */
const FENCE = 'the user restoring a file' // i18n-ignore: the fence's name, in the log

/** Git never waits on an editor or a sign-in nobody sees. */
const restoreEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' })

const refused = (r: GitResult): Error => combworkError(M.failed, { why: gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400) })

/** The file as the window named it (a path in the project folder, `/`-separated), or refused. */
function fileOf(projectPath: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  const p = rel.replace(/\\/g, '/')
  const abs = resolve(projectPath, p)
  if (p.split('/').includes('..') || !abs.toLowerCase().startsWith(resolve(projectPath).toLowerCase() + sep) || !insideReal(abs, [projectPath])) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return p
}

/**
 * Refused unless git tracks the file itself: an index entry of exactly that path (a file staged as new is one too), a
 * file's, never a folder with tracked files in it or a submodule.
 */
async function assertTracked(projectPath: string, rel: string): Promise<void> {
  const r = await git(projectPath, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', rel])
  const entry = r.ok ? r.out.split('\0').find((row) => row.slice(row.indexOf('\t') + 1) === rel) : undefined
  if (!entry || entry.startsWith('160000 ')) throw combworkError(M.notTracked, { file: rel }, { kind: 'conflict' })
}

/** The file's row in `git status`: its two letters, or null when it has no uncommitted changes. */
async function statusOf(projectPath: string, rel: string): Promise<string | null> {
  const r = await git(projectPath, ['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', rel])
  if (!r.ok) throw refused(r)
  const row = r.out.split('\0').find(Boolean)
  return row ? row.slice(0, 2) : null
}

const isConflict = (xy: string): boolean => xy.includes('U') || xy === 'AA' || xy === 'DD'

async function commitOf(projectPath: string, rev: string): Promise<string | null> {
  const r = await git(projectPath, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])
  return r.ok ? r.out.trim() || null : null
}

/** The commit a source names: HEAD, the target branch, or the commit picked; refused when it isn't one here. */
async function sourceCommit(projectPath: string, source: RestoreSource, target: string | null, commit: string | null): Promise<string> {
  if (source === 'head') {
    const head = await commitOf(projectPath, 'HEAD')
    if (!head) throw combworkError(M.noCommit, undefined, { kind: 'conflict' })
    return head
  }
  if (source === 'target') {
    const at = target ? await commitOf(projectPath, `refs/heads/${target}`) : null
    if (!at) throw combworkError(M.noTarget, undefined, { kind: 'conflict' })
    return at
  }
  const at = commit ? await commitOf(projectPath, commit) : null
  if (!at) throw combworkError(M.noCommit, undefined, { kind: 'conflict' })
  return at
}

/** The file's content in a commit, or null when it isn't there (`./` keeps the path the project folder's). */
async function versionAt(projectPath: string, commit: string, rel: string): Promise<GitResult | null> {
  const r = await git(projectPath, ['show', `${commit}:./${rel}`], MAX_DIFF_BYTES * 2)
  return r.ok ? r : null
}

/**
 * What the path is in a commit: a file ('blob'), something else (a folder, a submodule), or null when it isn't there.
 * Only a file is restored: a folder at that path would turn the file into it (round 1's finding).
 */
async function entryAt(projectPath: string, commit: string, rel: string): Promise<'blob' | 'other' | null> {
  const r = await git(projectPath, ['cat-file', '-t', `${commit}:./${rel}`])
  if (!r.ok) return null
  return r.out.trim() === 'blob' ? 'blob' : 'other'
}

/** Refused when the path is in the commit but isn't a file there. Whether it is a file there. */
async function fileAt(projectPath: string, commit: string, rel: string): Promise<boolean> {
  const kind = await entryAt(projectPath, commit, rel)
  if (kind === 'other') throw combworkError(M.notFile, { file: rel, commit: commit.slice(0, 7) }, { kind: 'conflict' })
  return kind === 'blob'
}

/** HI-3477: what Discard (source head) or Restore would do to `rel`, for its confirm. */
export async function restorePlan(projectPath: string, relRaw: unknown, source: RestoreSource, target: string | null, picked: string | null): Promise<FileRestorePlan> {
  const rel = fileOf(projectPath, relRaw)
  await assertTracked(projectPath, rel)
  const commit = await sourceCommit(projectPath, source, target, picked)
  const exists = await fileAt(projectPath, commit, rel)
  const [xy, at, working] = await Promise.all([statusOf(projectPath, rel), exists ? versionAt(projectPath, commit, rel) : null, workingCopy(projectPath, resolve(projectPath, rel))])
  const plan = { rel, source, commit, short: commit.slice(0, 7), target: source === 'target' ? target : null, exists, changed: !!xy }
  const diff = ((): GitDiff => {
    if (!Buffer.isBuffer(working)) return tooLargeDiff(rel, working.tooLarge)
    const becomes = at?.buf ?? Buffer.alloc(0)
    if (becomes.length > MAX_DIFF_BYTES) return tooLargeDiff(rel, becomes.length)
    if (isBinary(working) || isBinary(becomes)) return { path: rel, original: '', modified: '', binary: true }
    return { path: rel, original: working.toString('utf8'), modified: becomes.toString('utf8'), binary: false }
  })()
  return { ...plan, diff }
}

/** HI-3477: A Commit…'s list: a page of the commits that changed `rel` on the folder's branch, newest first. */
export async function fileCommits(projectPath: string, relRaw: unknown, pageRaw: unknown): Promise<FileCommits> {
  const rel = fileOf(projectPath, relRaw)
  if (!(await commitOf(projectPath, 'HEAD'))) return { commits: [], page: 1, pages: 1, total: 0 }
  const count = await git(projectPath, ['--literal-pathspecs', 'rev-list', '--count', 'HEAD', '--', rel])
  if (!count.ok) throw refused(count)
  const total = Number(count.out.trim()) || 0
  const pages = Math.max(1, Math.ceil(total / HISTORY_COMMITS))
  const page = Math.min(pages, Math.max(1, Math.floor(Number(pageRaw) || 1)))
  const r = await git(projectPath, ['--literal-pathspecs', 'log', '-n', String(HISTORY_COMMITS), '--skip', String((page - 1) * HISTORY_COMMITS), '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e', 'HEAD', '--', rel])
  if (!r.ok) throw refused(r)
  const commits = r.out
    .split('\x1e')
    .map((x) => x.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map((x): GitCommitRow => {
      const f = x.split('\0')
      return { hash: f[0], short: f[1], author: f[2], email: f[3], date: Number(f[4]) * 1000, refs: f[5] ? f[5].split(', ').filter(Boolean) : [], subject: f[6] ?? '' }
    })
  return { commits, page, pages, total }
}

/** Runs a git that writes the folder, bounded as Set Aside's (Settings → Advanced, `cw.git.commitMinutes`). */
async function writing(projectPath: string, rel: string, args: string[], env: NodeJS.ProcessEnv = restoreEnv()): Promise<GitResult> {
  const r = await git(projectPath, args, undefined, undefined, { env, timeout: platformLimits.gitCommitMs() })
  if (r.timedOut) {
    log.warn(`git ${args.find((a) => !a.startsWith('-'))} of a file in ${userText(projectPath)} ran past its bound and was ended`)
    throw combworkError(M.timedOut, { seconds: Math.round(platformLimits.gitCommitMs() / 1000), file: rel })
  }
  return r
}

/**
 * HI-3587: stashes `rel`'s uncommitted changes, staged and not, and only its: `git stash push -- <file>` keeps the whole
 * index in its stash, so applying it brought back what other files had staged. The stash is made as git makes one, from
 * a temporary index that is HEAD's tree with `rel`'s entry from the real index (the stash's index commit), then its file
 * on disk (its work tree commit, on HEAD and that), stored under `message`; then `rel` is put back to HEAD (a file new
 * in the index taken out, as git's stash does).
 */
/**
 * HI-3587 round 1: git's stash commits with `git stash <git@stash>` where no identity is configured (its fallback,
 * `user.useConfigOnly` too), and commit-tree has none: the same names, as git's environment for the stash's own
 * commits, wherever neither `user.*` nor that side's `author.*`/`committer.*` names one, and the environment doesn't
 * either. The user's config is never changed.
 */
async function stashIdent(projectPath: string): Promise<NodeJS.ProcessEnv> {
  const r = await git(projectPath, ['config', '--get-regexp', '^(user|author|committer)\\.(name|email)$'])
  const set = new Set(r.out.split(/\r?\n/).map((row) => row.split(' ')[0].toLowerCase()).filter(Boolean))
  const env: NodeJS.ProcessEnv = {}
  for (const side of ['author', 'committer'] as const)
    for (const [what, fallback] of [['name', 'git stash'], ['email', 'git@stash']] as const) { // i18n-ignore: git stash's own fallback identity, in the repository
      const key = `GIT_${side.toUpperCase()}_${what.toUpperCase()}`
      if (!set.has(`user.${what}`) && !set.has(`${side}.${what}`) && !process.env[key]) env[key] = fallback
    }
  return env
}

async function stashFile(projectPath: string, rel: string, message: string): Promise<void> {
  const read = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    const r = await writing(projectPath, rel, args, env)
    if (!r.ok) throw refused(r)
    return r.out.trim()
  }
  const head = await read(['rev-parse', '--verify', 'HEAD^{commit}'])
  const branch = (await git(projectPath, ['symbolic-ref', '-q', '--short', 'HEAD'])).out.trim() || '(no branch)' // i18n-ignore: git's own word in a stash's subject
  const subject = await read(['log', '-1', '--format=%s', head])
  const gitDir = await read(['rev-parse', '--absolute-git-dir'])
  const index = join(gitDir, `index.cw-restore-${randomBytes(4).toString('hex')}`)
  const ident = await stashIdent(projectPath)
  const env = { ...restoreEnv(), ...ident, GIT_INDEX_FILE: index }
  try {
    await read(['read-tree', head], env)
    const entry = (await read(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', rel])).split('\0').find((row) => row.slice(row.indexOf('\t') + 1) === rel)
    if (entry) {
      const [mode, sha] = entry.slice(0, entry.indexOf('\t')).split(' ')
      await read(['update-index', '--add', '--cacheinfo', mode, sha, rel], env)
    } else await read(['update-index', '--force-remove', '--', rel], env)
    const indexTree = await read(['write-tree'], env)
    const indexCommit = await read(['commit-tree', indexTree, '-p', head, '-m', `index on ${branch}: ${head.slice(0, 7)} ${subject}`], env) // i18n-ignore: git's own subject for a stash's index commit
    await read(['update-index', '--add', '--remove', '--', rel], env)
    const workTree = await read(['write-tree'], env)
    const said = `On ${branch}: ${message}` // i18n-ignore: git's own subject for a stash, as `git stash push -m` writes it
    const stash = await read(['commit-tree', workTree, '-p', head, '-p', indexCommit, '-m', said], env)
    await read(['stash', 'store', '-q', '-m', said, stash], { ...restoreEnv(), ...ident })
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
  }
  const inHead = (await git(projectPath, ['cat-file', '-e', `${head}:./${rel}`])).ok
  const back = inHead
    ? await writing(projectPath, rel, ['--literal-pathspecs', 'restore', `--source=${head}`, '--staged', '--worktree', '--', rel])
    : await writing(projectPath, rel, ['--literal-pathspecs', 'rm', '-q', '-f', '--', rel])
  if (!back.ok) throw combworkError(M.stashedFailed, { why: gitErrorLine(`${back.err}\n${back.out}`) || back.err.trim().slice(0, 400) })
}

/**
 * HI-3477: Discard (source head) or Restore of `req.rel` in the project folder, under the repository lock and its
 * fence. Its uncommitted changes are stashed first; a Restore then writes the version at `req.commit` (the confirm's).
 * `guard` runs there before git does and refuses by throwing.
 */
export async function restoreFile(projectPath: string, req: FileRestoreRequest, guard?: () => Promise<void> | void): Promise<FileRestored> {
  const rel = fileOf(projectPath, req.rel)
  return withRepoLock(
    projectPath,
    () =>
      changingFolder(projectPath, FENCE, async () => {
        const op = operationSync(projectPath)
        if (op) throw combworkError(M.operation, { what: op === 'cherry-pick' ? 'cherryPick' : op, folder: projectPath }, { kind: 'conflict' })
        const { folderBuilders } = await import('../../workflow/queueHost')
        const held = folderBuilders(workspace, projectPath)
        if (held) throw combworkError(M.busy, { folder: projectPath, what: held[0] }, { kind: 'conflict' })
        const agent = await busyAgentIn(projectPath, projectPath)
        if (agent) throw combworkError(M.agentBusy, { agent, folder: projectPath }, { kind: 'conflict' })
        await guard?.()
        await assertTracked(projectPath, rel)
        const xy = await statusOf(projectPath, rel)
        if (xy && isConflict(xy)) throw combworkError(M.conflicted, { file: rel }, { kind: 'conflict' })
        if (req.source === 'head') {
          if ((await commitOf(projectPath, 'HEAD')) !== req.commit) throw combworkError(M.moved, undefined, { kind: 'conflict' })
          if (!xy) throw combworkError(M.nothing, { file: rel }, { kind: 'conflict' })
        } else {
          if (!(await commitOf(projectPath, req.commit))) throw combworkError(M.noCommit, undefined, { kind: 'conflict' })
          if (!(await fileAt(projectPath, req.commit, rel))) throw combworkError(M.missing, { file: rel, commit: req.commit.slice(0, 7) }, { kind: 'conflict' })
        }
        let stashed = false
        if (xy) {
          const why = req.source === 'head' ? `before discarding ${rel}` : `before restoring ${rel} from ${req.commit.slice(0, 7)}` // i18n-ignore: the stash's message, in the repository (English, as Set Aside's)
          const message = `Combwork: set aside ${why} [cw:${randomBytes(3).toString('hex')}]` // i18n-ignore: the stash's message, in the repository
          log.info(`The user's ${req.source === 'head' ? 'discard' : 'restore'} of a file in ${userText(projectPath)}: its changes stashed`)
          await stashFile(projectPath, rel, message)
          stashed = true
        }
        if (req.source === 'head') return { stashed }
        log.info(`The user's restore of a file in ${userText(projectPath)} from ${req.commit.slice(0, 12)}`)
        const r = await writing(projectPath, rel, ['--literal-pathspecs', 'restore', `--source=${req.commit}`, '--worktree', '--', rel])
        if (!r.ok) {
          const why = gitErrorLine(`${r.err}\n${r.out}`) || r.err.trim().slice(0, 400)
          throw stashed ? combworkError(M.stashedFailed, { why }) : combworkError(M.failed, { why })
        }
        return { stashed }
      }),
    { project: projectPath }
  )
}
