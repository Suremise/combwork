// HI-3473: Version Control → Branches & remotes' Repository health (SPEC §16.10.2, Repository health): three of git's
// own repairs, the user's click at a time, never Combwork's own and never an agent's tool.
// - Prune worktrees: the entries `git worktree prune --dry-run` lists (their folder gone), each dropped as listed on
//   HI-3069's owned-entry proof (gitWorkspacePort.ts dropRegistration), never by a repository-wide prune, which would
//   also drop an entry gone since the user looked.
// - Remove stale lock: a lock file of git's in the repository's git folder (index.lock, HEAD.lock, packed-refs.lock, a
//   ref's) at least `cw.git.staleLockSeconds` old, while no git process (`cw.git.processNames`) that started before it
//   was last written runs: Windows can't say a process's folder, and a git started after a lock was made fails on it, so
//   only an older one can hold it. Moved aside and proved to be the file the user saw before it is removed. No process
//   is ever ended.
// - Fetch with prune: per remote set up as git's default (its branches into `refs/remotes/<name>/`, HR1's round 1), the
//   remote-tracking branches `git ls-remote --heads` no longer lists, then `git fetch --prune <remote> <that refspec>`
//   with tag pruning off, so nothing but those can be dropped; as Fetch reaches the remote (its bound and Cancel).
// Each refuses while an agent's session works in a folder of the repository (git's list of worktrees unreadable refuses
// too), a run or an agent's file lock is in one, a slot is being made or removed, or a Combwork run works in one (a
// merge check, a slot's setup), checked under the repository's lock, held until it is done (Fetch with prune's fetch
// included): a merge holding it (the merge queue's or the user's) is waited for, with the notice of who holds it, never
// run beside.
import { readdir, readFile, rm } from 'original-fs/promises'
import { existsSync, lstatSync, readFileSync, renameSync } from 'original-fs'
import { randomBytes } from 'crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { lockAsks, pruneAsks, remoteAsks, type GitLockFile, type LockHeld, type PrunableOwner, type PrunableWorktree, type RemotePrune, type RepoHealth } from '../../../shared/gitHealth'
import { legacyWorktree } from '../../../shared/agentFolders'
import { projectAgents } from '../../../shared/defaults'
import { fmt, msg, tr } from '../../../shared/i18n'
import { boardSlots } from '../../agentFolders'
import { combworkError } from '../../combworkError'
import { containsPlace, samePlace } from '../../fsutil'
import { git, gitErrorLine, type GitResult } from '../../git'
import { gitRunSignal } from '../../gitCancel'
import { busyAgentIn, FOLDER_BUSY, oneAtATime, parseWorktrees } from '../../gitRepo'
import { checkProject } from '../../branchWatch'
import { createLogger, userText } from '../../logger'
import { listNamedProcesses, type NamedProcess } from '../../processTree'
import { progress } from '../../progressService'
import { commonGitDir, withRepoLock } from '../../repoLock'
import { sessions } from '../../sessions'
import { workspace } from '../../workspace'
import { platformLimits } from '../limits'
import { asideOf, entryIdSync, worktreesOf } from './gitLink'
import { workspacePortOf } from '../workspacePorts'

const log = createLogger('git-health')

export const HEALTH_TEXT = {
  invalid: msg({ id: 'service.gitHealth.invalid', defaultMessage: 'That was asked for wrongly: nothing was done.', description: 'HI-3473: an error from Repository health (Version Control → Branches & remotes): the request was malformed (not reached from the window).' }),
  agentBusy: msg({ id: 'service.gitHealth.agentBusy', defaultMessage: '{agent} is working in {folder}: nothing was done. Try again once it has finished.', description: "HI-3473: an error from Repository health: an agent ({agent}, its name) works in a folder of the repository ({folder}, a path)." }),
  busy: msg({ id: 'service.gitHealth.busy', defaultMessage: 'A run or an agent is working in {folder} ({what}): nothing was done. Try again once it has finished.', description: "HI-3473: an error from Repository health: a run (a test, a build) or an agent's file lock is in a folder of the repository ({folder}, a path); {what} names the first one's folder or file." }),
  combworkRun: msg({ id: 'service.gitHealth.combworkRun', defaultMessage: 'Combwork is running “{what}” in {folder}: nothing was done. Try again once it has finished.', description: "HI-3473: an error from Repository health: one of Combwork's own runs (a merge check, a slot's setup; {what} is its title) works in a folder of the repository ({folder}, a path)." }),
  slotBusy: msg({ id: 'service.gitHealth.slotBusy', defaultMessage: '{slot} is being {state, select, creating {made} other {removed}}: nothing was done. Try again in a moment.', description: 'HI-3473: an error from Repository health: the slot {slot} (such as slot-a; glossary: slot) is being made or removed now. Keep the select keys.' }),
  unlisted: msg({ id: 'service.gitHealth.unlisted', defaultMessage: "Git couldn't list this repository's worktrees, so Combwork can't tell nothing works in them: nothing was done. Git said: {why}", description: "HI-3473 (a reviewer's round 1): an error from Repository health: git worktree list failed, so a worktree an agent or a run works in could be missed. {why} is git's error line, in English." }),
  notStandard: msg({ id: 'service.gitHealth.notStandard', defaultMessage: "{remote} isn't fetched as git sets a remote up (its remote.{remote}.fetch names more than its branches, or it's a mirror), so pruning could drop more than its remote-tracking branches: Combwork leaves it to you, in a terminal.", description: "HI-3473 (a reviewer's round 1): why Fetch with Prune skips or refuses the remote {remote}: its fetch settings aren't git's default. remote.{remote}.fetch is a git setting's name: keep it." }),
  noProcesses: msg({ id: 'service.gitHealth.noProcesses', defaultMessage: "Windows' list of processes couldn't be read, so no lock can be called stale: nothing was removed. Try again.", description: 'HI-3473: an error from Remove stale lock: the list of running processes (used to rule out a git holding the lock) could not be read whole.' }),
  pruned: msg({ id: 'service.gitHealth.pruned', defaultMessage: '{n, plural, =0 {No worktree entry was dropped.} one {Dropped # worktree entry.} other {Dropped # worktree entries.}}{kept, plural, =0 {} one { # was kept: {keptList}.} other { # were kept: {keptList}.}}', description: "HI-3473: after Prune worktrees: how many of git's entries for missing worktrees were dropped ({n}), and how many were kept ({kept}) with each one's name and why ({keptList}, a list of 'name (why)')." }),
  removed: msg({ id: 'service.gitHealth.removed', defaultMessage: '{n, plural, =0 {No lock file was removed.} one {Removed # lock file.} other {Removed # lock files.}}{kept, plural, =0 {} one { # was kept: {keptList}.} other { # were kept: {keptList}.}}', description: "HI-3473: after Remove stale lock: how many of git's lock files were removed ({n}), and how many kept ({kept}) with each one's path and why ({keptList}, a list of 'path (why)')." }),
  fetchedPruned: msg({ id: 'service.gitHealth.fetchedPruned', defaultMessage: 'Fetched {remotes}. {n, plural, =0 {No remote-tracking branch was dropped.} one {Dropped # remote-tracking branch: {branches}.} other {Dropped # remote-tracking branches: {branches}.}}', description: 'HI-3473: after Fetch with prune: the remotes fetched from ({remotes}, a list of names) and the remote-tracking branches dropped because they were deleted on the remote ({n}; {branches} lists them, such as origin/old).' }),
  fetchFailed: msg({ id: 'service.gitHealth.fetchFailed', defaultMessage: 'Fetching {remote} failed: {why}', description: "HI-3473: an error from Fetch with prune: git's fetch from the remote {remote} failed; {why} is git's error line, in English." }),
  stopped: msg({ id: 'service.gitHealth.stopped', defaultMessage: 'Stopped here. What git fetched or dropped before it stopped stays: look again to see where things stand.', description: 'HI-3473: after the user cancelled Fetch with prune or its check of a remote.' }),
  gaveUp: msg({ id: 'service.gitHealth.gaveUp', defaultMessage: 'git gave up after {minutes, number} minutes (no answer from the remote, or a sign-in left open).', description: 'HI-3473: why the check or fetch of a remote failed: git waited {minutes} minutes (Settings → Advanced, the longest a fetch takes) and was ended.' }),
  // Why one asked for was kept (each a phrase in the done message's list).
  keptChanged: msg({ id: 'service.gitHealth.kept.changed', defaultMessage: 'it changed since you looked', description: 'HI-3473: why Repository health kept a worktree entry or a lock file the user ticked: it is gone, or not the one they were shown any more. A phrase in a list.' }),
  keptFolder: msg({ id: 'service.gitHealth.kept.folder', defaultMessage: 'its folder is there', description: "HI-3473: why Prune worktrees kept an entry: the worktree's folder exists again. A phrase in a list." }),
  keptRefused: msg({ id: 'service.gitHealth.kept.refused', defaultMessage: "it couldn't be proved to be the one you saw", description: "HI-3473: why Prune worktrees or Remove stale lock kept something: Combwork couldn't prove, as it moved it aside, that it was what the user was shown (a file in use, a link, something replaced). A phrase in a list." }),
  keptHeld: msg({ id: 'service.gitHealth.kept.held', defaultMessage: "it isn't stale now", description: 'HI-3473: why Remove stale lock kept a lock: by the time the user confirmed, a git that may hold it is running, or it was written again. A phrase in a list.' })
}
const M = HEALTH_TEXT

/** What a clock skew between Windows' process start times and a file's times is allowed: a process this much younger still counts. */
export const START_SKEW_MS = 2000

/** The lock files of git's in a git folder (its top, or a worktree's own): git's own names, never Combwork's (`cw-merge.lock`). */
export const LOCK_NAME = /^(?:index|packed-refs|config|config\.worktree|shallow|[A-Z][A-Z_]*)\.lock$/

/** The most entries a scan of `refs` reads (a repository with many loose refs): past it, the rest isn't looked at. */
const REFS_SCAN_MAX = 50_000

/**
 * Folders of the repository: the project's and every worktree git lists that is there. Git's list unreadable refuses
 * (HR1's round 1): a worktree it would have named could have an agent or a run in it.
 */
async function repoFolders(projectPath: string): Promise<string[]> {
  const r = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!r.ok) throw combworkError(M.unlisted, { why: gitErrorLine(r.err) || r.err.trim().slice(0, 400) }, { kind: 'conflict' })
  const listed = parseWorktrees(r.out).map((w) => w.path)
  const out = [projectPath]
  for (const p of listed) if (!out.some((x) => samePlace(x, p)) && existsSync(p)) out.push(p)
  return out
}

/**
 * Throws the refusal while anything works on the repository: an agent's session in one of its folders (or an agent placed
 * there working), a run or an agent's file lock there, a slot being made or removed, or a Combwork run there. Its
 * callers hold the repository's lock, so no merge runs meanwhile.
 */
export async function assertRepoQuiet(projectPath: string): Promise<void> {
  const folders = await repoFolders(projectPath)
  const inRepo = (p: string | null | undefined): string | null => (p ? (folders.find((f) => containsPlace(f, p)) ?? null) : null)
  for (const st of sessions.liveStates()) {
    const at = inRepo(st.cwd)
    if (at && st.status && FOLDER_BUSY.has(st.status)) throw combworkError(M.agentBusy, { agent: st.agentName ?? st.agentId, folder: at }, { kind: 'conflict' })
  }
  const { folderBuilders } = await import('../../workflow/queueHost')
  for (const f of folders) {
    const held = folderBuilders(workspace, f)
    if (held) throw combworkError(M.busy, { folder: f, what: held[0] }, { kind: 'conflict' })
    const agent = await busyAgentIn(projectPath, f)
    if (agent) throw combworkError(M.agentBusy, { agent, folder: f }, { kind: 'conflict' })
  }
  const ws = workspace.path
  const own = ws ? progress.list(ws).find((r) => r.source === 'combwork' && r.state === 'running' && !!inRepo(r.folder)) : undefined
  if (own) throw combworkError(M.combworkRun, { what: own.title, folder: inRepo(own.folder) ?? projectPath }, { kind: 'conflict' })
  const making = (await boardSlots(projectPath)).find((s) => s.state === 'creating' || s.state === 'removing')
  if (making) throw combworkError(M.slotBusy, { slot: making.name, state: making.state }, { kind: 'conflict' })
}

// ---------------------------------------------------------------------------
// Prune worktrees
// ---------------------------------------------------------------------------

/** The folder a worktree entry's `gitdir` names (`<folder>/.git`), or null when it names none (unreadable, or not a `.git`). */
function entryFolder(entry: string, gitdir: string | null): string | null {
  const t = gitdir?.trim()
  if (!t) return null
  const at = isAbsolute(t) ? resolve(t) : resolve(entry, t)
  return basename(at).toLowerCase() === '.git' ? dirname(at) : null
}

/** The entries git's dry run lists, by name, with its reason (git prints them on its standard error). */
export function parsePruneDryRun(text: string): { id: string; reason: string }[] {
  return [...text.matchAll(/^Removing worktrees\/([^:\r\n]+): ?(.*)$/gm)].map((m) => ({ id: m[1], reason: m[2].trim() }))
}

/** The worktree entries a prune would drop, each with its folder and whose it was. */
async function prunable(projectPath: string, store: string): Promise<PrunableWorktree[]> {
  const r = await git(projectPath, ['worktree', 'prune', '--dry-run', '--verbose'])
  if (!r.ok) return []
  const found = parsePruneDryRun(`${r.out}\n${r.err}`)
  if (!found.length) return []
  const slots = await boardSlots(projectPath)
  const agents = await workspace.projectConfig(projectPath).then(projectAgents, () => [])
  const ownerOf = (folder: string | null): PrunableOwner => {
    if (!folder) return null
    const slot = slots.find((s) => samePlace(s.folder, folder))
    if (slot) return { kind: 'slot', name: slot.name }
    const agent = agents.find((a) => {
      const w = legacyWorktree(a)
      return !!w && samePlace(w.path, folder)
    })
    return agent ? { kind: 'agent', name: agent.name } : null
  }
  const out: PrunableWorktree[] = []
  for (const f of found) {
    const entry = join(worktreesOf(store), f.id)
    const folder = entryFolder(entry, await readFile(join(entry, 'gitdir'), 'utf8').catch(() => null))
    out.push({ id: f.id, folder, reason: f.reason, owner: ownerOf(folder) })
  }
  return out
}

/** Whether a path is absent: only ENOENT or ENOTDIR count, any other error is doubt. */
function absentSync(p: string): boolean {
  try {
    lstatSync(p)
    return false
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

/**
 * An entry that names no folder (its `gitdir` missing, unreadable or not a `.git`), which dropRegistration can't find
 * by folder: proved by its own file id, not `locked`, its `gitdir` as read, synchronously from the proof to the move
 * aside, then proved again on what was moved before it is removed. Anything else is left (back under its name if free).
 */
async function dropNamelessEntry(store: string, id: string): Promise<'dropped' | 'refused'> {
  const entry = join(worktreesOf(store), id)
  const gitdirOf = (at: string): string | null => {
    try {
      return readFileSync(join(at, 'gitdir'), 'utf8')
    } catch {
      return null
    }
  }
  const was = entryIdSync(entry)
  if (!was) return 'refused'
  const gitdir = gitdirOf(entry)
  if (entryFolder(entry, gitdir) !== null || !absentSync(join(entry, 'locked'))) return 'refused'
  const aside = asideOf(store, randomBytes(8).toString('hex'))
  try {
    renameSync(entry, aside)
  } catch {
    return 'refused'
  }
  if (entryIdSync(aside) !== was || gitdirOf(aside) !== gitdir || !absentSync(join(aside, 'locked'))) {
    try {
      if (absentSync(entry)) renameSync(aside, entry)
    } catch {
      log.warn(`A worktree entry moved aside for Prune worktrees was left at ${userText(aside)}`)
    }
    return 'refused'
  }
  await rm(aside, { recursive: true, force: true }).catch((e: Error) => log.warn(`A pruned worktree entry wasn't removed: ${userText(e.message)}`))
  return 'dropped'
}

/** HI-3473: the user's Prune worktrees: each entry as the list showed it, dropped only while git still lists it so. */
export async function pruneWorktrees(projectPath: string, raw: unknown): Promise<string> {
  const asks = pruneAsks(raw)
  if (!asks) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return withRepoLock(
    projectPath,
    async () => {
      await assertRepoQuiet(projectPath)
      const store = await commonGitDir(projectPath)
      const now = await prunable(projectPath, store)
      let dropped = 0
      const kept: string[] = []
      for (const ask of asks) {
        const name = ask.folder ?? ask.id
        const e = now.find((x) => x.id === ask.id && (x.folder === null ? ask.folder === null : ask.folder !== null && samePlace(x.folder, ask.folder)))
        if (!e) {
          kept.push(`${name} (${tr(M.keptChanged)})`)
          continue
        }
        if (e.folder !== null && !absentSync(e.folder)) {
          kept.push(`${name} (${tr(M.keptFolder)})`)
          continue
        }
        // Git's workspace port's (HI-3069), through its registry.
        const drop = workspacePortOf('git')?.dropRegistration
        const r = e.folder !== null ? (drop ? await drop(projectPath, e.folder) : ('none' as const)) : await dropNamelessEntry(store, e.id)
        if (r === 'dropped') {
          dropped++
          log.info(`The user's Prune worktrees dropped ${userText(e.id)} (${userText(name)})`)
        } else {
          if (typeof r === 'object') log.info(`Prune worktrees kept ${userText(e.id)}: ${userText(r.left)}`)
          kept.push(`${name} (${tr(r === 'none' ? M.keptChanged : M.keptRefused)})`)
        }
      }
      void checkProject(projectPath)
      return tr(M.pruned, { n: dropped, kept: kept.length, keptList: fmt.list(kept, 'unit') })
    },
    { project: projectPath }
  )
}

// ---------------------------------------------------------------------------
// Remove stale lock
// ---------------------------------------------------------------------------

/** A lock file's identity and times as read now, or null when it isn't a plain file there. */
function lockNowSync(p: string): { stamp: string; at: number; size: number } | null {
  try {
    const s = lstatSync(p, { bigint: true })
    if (!s.isFile()) return null
    // The later of when it was made and last written: Windows can carry an old file's creation time over to one made
    // again under its name moments later (file tunnelling), so its creation time alone could make a live lock look old.
    const at = Math.max(Number(s.mtimeMs), Number(s.birthtimeMs))
    return { stamp: `${s.ino}:${s.birthtimeNs}:${s.mtimeNs}:${s.size}`, at, size: Number(s.size) }
  } catch {
    return null
  }
}

/** Whether a path (under the git folder, forward slashes) is one of git's lock files Repository health looks at. */
export function isGitLockPath(rel: string): boolean {
  const parts = rel.split('/')
  const name = parts.at(-1) ?? ''
  if (parts.length === 1) return LOCK_NAME.test(name)
  if (parts[0] === 'worktrees') return parts.length === 3 && LOCK_NAME.test(name)
  return parts[0] === 'refs' && name.endsWith('.lock') && name.length > '.lock'.length
}

/** The lock files under a git folder (its path, forward slashes, from the folder): its top, each worktree's own, and `refs`. */
async function lockPaths(store: string): Promise<string[]> {
  const out: string[] = []
  const names = async (dir: string): Promise<{ name: string; file: boolean; dir: boolean }[]> =>
    (await readdir(dir, { withFileTypes: true }).catch(() => [])).map((d) => ({ name: d.name, file: d.isFile(), dir: d.isDirectory() }))
  for (const d of await names(store)) if (d.file && LOCK_NAME.test(d.name)) out.push(d.name)
  for (const w of await names(worktreesOf(store))) {
    if (!w.dir) continue
    for (const d of await names(join(worktreesOf(store), w.name))) if (d.file && LOCK_NAME.test(d.name)) out.push(`worktrees/${w.name}/${d.name}`)
  }
  let seen = 0
  const walk = async (rel: string): Promise<void> => {
    for (const d of await names(join(store, ...rel.split('/')))) {
      if (++seen > REFS_SCAN_MAX) return
      const child = `${rel}/${d.name}`
      if (d.dir) await walk(child)
      else if (d.file && isGitLockPath(child)) out.push(child)
    }
  }
  await walk('refs')
  return out
}

/**
 * Why a lock written at `at` isn't stale at `now`, or null when it is: young, a git (by `names`) that started no later
 * than it ran in `procs` (null: the list couldn't be read whole), as HI-3473's rule says.
 */
export function lockHeld(at: number, now: number, procs: NamedProcess[] | null, names: RegExp, minAgeMs: number): LockHeld | null {
  if (now - at < minAgeMs) return { why: 'young', seconds: Math.ceil(minAgeMs / 1000) } // i18n-ignore: a reason's code (the window words it)
  if (!procs) return { why: 'unlisted' } // i18n-ignore: a reason's code (the window words it)
  const older = procs.filter((p) => names.test(p.name) && p.started <= at + START_SKEW_MS).sort((a, b) => a.started - b.started)[0]
  return older ? { why: 'process', pid: older.pid, name: older.name, started: older.started } : null // i18n-ignore: a reason's code (the window words it)
}

/** The lock files, each judged (a process list taken once, only when there is a lock to judge). */
async function locksIn(store: string): Promise<GitLockFile[]> {
  const paths = await lockPaths(store)
  if (!paths.length) return []
  const procs = await listNamedProcesses()
  const now = Date.now()
  const names = platformLimits.gitProcessNames()
  const out: GitLockFile[] = []
  for (const path of paths) {
    const s = lockNowSync(join(store, ...path.split('/')))
    if (s) out.push({ path, at: s.at, size: s.size, stamp: s.stamp, held: lockHeld(s.at, now, procs, names, platformLimits.staleLockMs()) })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/**
 * HI-3473: the user's Remove stale lock: each lock as the list showed it (its stamp), removed only while it is still
 * that file and still stale by a process list taken now: moved aside in the git folder (renaming a file a live git has
 * open fails), proved again on what was moved, then removed; anything else stays, back under its name if free.
 */
export async function removeLocks(projectPath: string, raw: unknown): Promise<string> {
  const asks = lockAsks(raw)
  if (!asks || asks.some((a) => !isGitLockPath(a.path))) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return withRepoLock(
    projectPath,
    async () => {
      await assertRepoQuiet(projectPath)
      const store = await commonGitDir(projectPath)
      const procs = await listNamedProcesses()
      if (!procs) throw combworkError(M.noProcesses, undefined, { kind: 'conflict' })
      const names = platformLimits.gitProcessNames()
      let removed = 0
      const kept: string[] = []
      for (const ask of asks) {
        const p = join(store, ...ask.path.split('/'))
        // Synchronous from the read to the move: nothing awaited between the proof and the rename.
        const before = lockNowSync(p)
        if (!before || before.stamp !== ask.stamp) {
          kept.push(`${ask.path} (${tr(M.keptChanged)})`)
          continue
        }
        if (lockHeld(before.at, Date.now(), procs, names, platformLimits.staleLockMs())) {
          kept.push(`${ask.path} (${tr(M.keptHeld)})`)
          continue
        }
        const aside = join(store, `.cw-stale-lock-${randomBytes(8).toString('hex')}`)
        try {
          renameSync(p, aside)
        } catch {
          kept.push(`${ask.path} (${tr(M.keptRefused)})`)
          continue
        }
        if (lockNowSync(aside)?.stamp !== ask.stamp) {
          try {
            if (absentSync(p)) renameSync(aside, p)
          } catch {
            log.warn(`A lock moved aside for Remove stale lock was left at ${userText(aside)}`)
          }
          kept.push(`${ask.path} (${tr(M.keptRefused)})`)
          continue
        }
        await rm(aside, { force: true }).catch((e: Error) => log.warn(`A stale lock moved aside wasn't removed: ${userText(e.message)}`))
        removed++
        log.info(`The user's Remove stale lock removed ${userText(ask.path)} in ${userText(store)}`)
      }
      void checkProject(projectPath)
      return tr(M.removed, { n: removed, kept: kept.length, keptList: fmt.list(kept, 'unit') })
    },
    { project: projectPath }
  )
}

/** HI-3473: what Repository health finds without reaching a remote: the worktree entries a prune would drop, and git's lock files. */
export async function repoHealth(projectPath: string): Promise<RepoHealth> {
  const store = await commonGitDir(projectPath)
  const [worktrees, locks] = await Promise.all([prunable(projectPath, store), locksIn(store)])
  return { worktrees, locks, staleSeconds: Math.ceil(platformLimits.staleLockMs() / 1000) }
}

// ---------------------------------------------------------------------------
// Fetch with prune
// ---------------------------------------------------------------------------

/** A command that reaches a remote: Fetch's bound and the user's Cancel (gitCancel.ts), no prompt. */
const net = (cwd: string, args: string[]): Promise<GitResult> => {
  const signal = gitRunSignal()
  return git(cwd, args, 16 * 1024 * 1024, undefined, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: platformLimits.gitNetworkMs(), ...(signal ? { signal } : {}) })
}

/** A remote's command that failed or was stopped, said in the window's words (a Cancel throws). */
function netWhy(r: GitResult): string {
  if (r.cancelled) throw combworkError(M.stopped)
  if (r.timedOut) return tr(M.gaveUp, { minutes: Math.round(platformLimits.gitNetworkMs() / 60_000) })
  return gitErrorLine(r.err) || r.err.trim().slice(0, 400) || r.out.trim().slice(0, 400)
}

/** The repository's remotes, as git lists them. */
async function remotesOf(projectPath: string): Promise<string[]> {
  const r = await git(projectPath, ['remote'])
  return r.ok ? r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('-')) : []
}

/** The refspec Fetch with prune fetches a remote by, and the only one it prunes: its branches, as remote-tracking branches. */
export const trackingSpec = (remote: string): string => `+refs/heads/*:refs/remotes/${remote}/*`

/**
 * HR1's round 1: whether a remote is fetched as git's default sets it up (`remote.<name>.fetch` exactly its branches into
 * `refs/remotes/<name>/`, with or without `+`; not a mirror), the one setup whose pruning is what the dialog shows. Any
 * other (a tag refspec, another destination, several) could prune refs the dialog never listed, so it isn't done.
 */
async function standardRemote(projectPath: string, remote: string): Promise<boolean> {
  const specs = await git(projectPath, ['config', '--get-all', `remote.${remote}.fetch`])
  const lines = specs.ok ? specs.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
  const mirror = (await git(projectPath, ['config', '--type=bool', '--get', `remote.${remote}.mirror`])).out.trim() === 'true'
  return !mirror && lines.length === 1 && (lines[0] === trackingSpec(remote) || lines[0] === trackingSpec(remote).slice(1))
}

/** What `git ls-remote --heads` lists: the remote's branch names. */
export function parseLsRemoteHeads(text: string): Set<string> {
  return new Set([...text.matchAll(/^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/gm)].map((m) => m[1].trim()))
}

/** A remote's remote-tracking branches now, by name (`old` for `refs/remotes/origin/old`), its HEAD left out. */
async function trackingNames(projectPath: string, remote: string): Promise<Set<string>> {
  const r = await git(projectPath, ['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`])
  const prefix = `refs/remotes/${remote}/`
  return new Set(r.ok ? r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(prefix) && l !== `${prefix}HEAD`).map((l) => l.slice(prefix.length)) : [])
}

/**
 * HI-3473: per remote, the remote-tracking branches deleted on it (its branches as `git ls-remote --heads` lists them,
 * against `refs/remotes/<name>/`: exactly what a fetch of trackingSpec with --prune drops), each with the local branches
 * that track it. A remote not set up as git's default is listed with why, never fetched (HR1's round 1).
 */
export async function remotePrunePreview(projectPath: string): Promise<RemotePrune[]> {
  return oneAtATime(projectPath, async () => {
    const remotes = await remotesOf(projectPath)
    const tracks = await git(projectPath, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)', 'refs/heads'])
    const rows = tracks.ok ? tracks.out.split(/\r?\n/).map((l) => l.split('\0')).filter((f) => f.length === 2 && f[1]) : []
    const out: RemotePrune[] = []
    for (const remote of remotes) {
      if (!(await standardRemote(projectPath, remote))) {
        out.push({ remote, branches: [], error: tr(M.notStandard, { remote }) })
        continue
      }
      const r = await net(projectPath, ['ls-remote', '--heads', remote])
      if (!r.ok) {
        out.push({ remote, branches: [], error: netWhy(r) })
        continue
      }
      const there = parseLsRemoteHeads(r.out)
      const gone = [...(await trackingNames(projectPath, remote))].filter((b) => !there.has(b)).sort((a, b) => a.localeCompare(b, 'en'))
      out.push({ remote, branches: gone.map((b) => `${remote}/${b}`).map((name) => ({ name, trackedBy: rows.filter((f) => f[1] === name).map((f) => f[0]) })) })
    }
    return out
  })
}

/**
 * HI-3473: the user's Fetch with prune of `raw`'s remotes, each in turn: its branches fetched into its remote-tracking
 * branches and those deleted on it dropped (trackingSpec, given on the command line so no configured refspec is pruned,
 * and tag pruning off whatever the config says: HR1's round 1), saying what was dropped. Under the repository's lock,
 * the quiet check made as it starts (HR1's round 1: no merge beside it, nothing started since the check).
 */
export async function fetchPrune(projectPath: string, raw: unknown): Promise<string> {
  const asks = remoteAsks(raw)
  if (!asks) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  const known = await remotesOf(projectPath)
  if (asks.some((a) => !known.includes(a))) throw combworkError(M.invalid, undefined, { kind: 'invalid' })
  return oneAtATime(projectPath, () =>
    withRepoLock(
      projectPath,
      async () => {
        await assertRepoQuiet(projectPath)
        for (const remote of asks) if (!(await standardRemote(projectPath, remote))) throw combworkError(M.notStandard, { remote }, { kind: 'conflict' })
        const dropped: string[] = []
        for (const remote of asks) {
          const before = await trackingNames(projectPath, remote)
          const r = await net(projectPath, ['-c', 'fetch.pruneTags=false', '-c', `remote.${remote}.pruneTags=false`, 'fetch', '--prune', '--', remote, trackingSpec(remote)])
          if (!r.ok) throw combworkError(M.fetchFailed, { remote, why: netWhy(r) })
          const after = await trackingNames(projectPath, remote)
          for (const b of before) if (!after.has(b)) dropped.push(`${remote}/${b}`)
        }
        log.info(`The user's Fetch with prune of ${userText(asks.join(', '))} in ${userText(projectPath)} dropped ${dropped.length}`)
        void checkProject(projectPath)
        return tr(M.fetchedPruned, { remotes: fmt.list(asks), n: dropped.length, branches: fmt.list(dropped, 'unit') })
      },
      { project: projectPath }
    )
  )
}
