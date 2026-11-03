// The profile folders move from Hive's names to Combwork's (HI-2461, SPEC §4.3): %APPDATA%\Hive → %APPDATA%\Combwork
// and %LOCALAPPDATA%\Hive → %LOCALAPPDATA%\Combwork (a dev build's Hive-Dev → Combwork-Dev), once, at the first start of
// a build with the new names, before anything reads or writes the profile (index.ts, before userData is set).
//
// Never losing data comes first. The old folder is copied, never moved: into a staging folder of this attempt's own
// beside it (`<new>.moving-<token>`, marked inside as this move's), which becomes the new folder by one rename once the
// copy is whole, and only then is the old folder renamed to a dated backup (`Hive.backup-2026-11-03`). A copy that fails
// (a locked file, a full disk) removes only its own partial copy, and this run keeps using the old folder, as it was; the
// next start tries again. A backup rename that fails (a file still open in the old folder) leaves the old folder beside
// the new one, recorded as pending, and the next start renames it then.
//
// One start at a time (HI-2461 round 2): everything that changes anything (staging, publishing, the backup and its
// record) happens holding the move's lock, `<new>.move-lock` beside the folders. It is taken atomically: written whole
// to a file of its own, then hard-linked to the lock's name, which fails if one is there, so a lock is never seen half
// written. The copy refreshes it as it goes. A lock held by a live start that refreshed it lately makes this start give
// way (index.ts exits, as a second start does); one whose start has ended is claimed by renaming it to a name of this
// start's own (only one contender's rename succeeds) and checked to be the one judged; anything else (a lock that can't
// be read, or a live start's that hasn't moved for a while) is never removed: this run uses the old folder and says so.
// A staging folder is only ever removed by the lock's holder, and only when its marker says it is this move's: a folder
// of any other name, or without the marker, is left as it is.
//
// The record (`profile-move.json`, in the new folder) says where it came from, its backup, whether the new folder has
// opened once, and what the user answered the offer to remove the backup. The backup is only ever removed on the user's
// answer, to the Recycle Bin (profileMoveNotices.ts).
//
// Synchronous on purpose: it runs once, before the app is ready and before any window, session or watcher exists, and
// nothing else may touch the profile while it runs. It logs nothing itself (the logger writes into the profile): its
// outcome carries what to log once the profile is set.

import { randomBytes } from 'crypto'
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'original-fs'
import { isAbsolute, join, relative, resolve } from 'path'

/** The record of a move, kept in the new folder. */
export interface MoveRecord {
  v: 1
  /** The old folder it was copied from. */
  from: string
  movedAt: string
  /** The old folder's backup, once renamed; null while that rename is pending. */
  backup: string | null
  /** The new folder has opened once (its first window loaded): from then on the backup may be offered for removal. */
  opened: boolean
  /** The user's answer to the offer: kept (never offered again) or removed (to the Recycle Bin). */
  offer?: 'kept' | 'removed'
  /** The connections were checked for sign-ins after the move (said once). */
  signInChecked?: boolean
}

export const RECORD_FILE = 'profile-move.json'
/** The marker in a staging folder: which attempt made it. */
export const STAGING_MARKER = '.profile-move-staging.json'
/** A lock its holder hasn't refreshed for this long is no longer taken as a copy under way. */
export const LOCK_STALE_MS = 2 * 60_000
/** How often the copy refreshes its lock. */
const LOCK_REFRESH_MS = 10_000

/**
 * Chromium's caches in the roaming profile, which it makes again: not copied, so the move is quicker. Everything else
 * (settings, Local Storage, IndexedDB, logs, crash dumps) is.
 */
export const REGENERATED = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache'] // i18n-ignore: Chromium's folder names

export type MoveOutcome =
  /** Neither folder exists: a new install, the new folder is made as usual. */
  | { kind: 'fresh'; use: string }
  /** The new folder is there and the old one isn't (moved before). */
  | { kind: 'current'; use: string }
  /** Copied across now; `backup` null if the old folder couldn't be renamed yet (tried again next start). */
  | { kind: 'moved'; use: string; backup: string | null }
  /** A pending backup rename, done (or still pending) at this start. */
  | { kind: 'backedUp'; use: string; backup: string | null }
  /** Both are there and the old one isn't this move's: both left as they are, the new one used. */
  | { kind: 'both'; use: string; other: string }
  /** The move didn't happen (a copy that failed, a lock it couldn't take): nothing changed, `use` is the old folder. */
  | { kind: 'failed'; use: string; to: string; why: string }
  /** Another start holds the move now: this one gives way. */
  | { kind: 'busy'; use: string }

/** File operations the move uses: real ones by default, failing or interleaving ones in tests. */
export interface MoveOps {
  copyFile: (from: string, to: string) => void
  rename: (from: string, to: string) => void
  /** Whether a process with this id runs (a lock's holder). */
  alive: (pid: number) => boolean
  pid: number
  now: () => number
  /** A step of the move, for tests to run another start in between (`staged`, `published`). */
  step?: (name: 'locked' | 'staged' | 'published') => void
}

const realOps: MoveOps = {
  copyFile: (a, b) => copyFileSync(a, b),
  rename: (a, b) => renameRetrying(a, b),
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  pid: process.pid,
  now: () => Date.now()
}

/** A rename tried again briefly: Windows' indexer or an antivirus can hold a file for a moment. */
function renameRetrying(from: string, to: string, tries = 10): void {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= tries - 1 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readRecord(folder: string): MoveRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(folder, RECORD_FILE), 'utf8')) as MoveRecord
    return r && r.v === 1 && typeof r.from === 'string' ? r : null
  } catch {
    return null
  }
}

export function writeRecord(folder: string, r: MoveRecord): void {
  const file = join(folder, RECORD_FILE)
  writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 2))
  renameRetrying(`${file}.tmp`, file)
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()

/** The dated backup's path beside the old folder, unused: `Hive.backup-2026-11-03`, then `-2`, `-3`… */
export function backupPath(parent: string, oldName: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  for (let n = 1; ; n++) {
    const p = join(parent, `${oldName}.backup-${day}${n > 1 ? `-${n}` : ''}`)
    if (!existsSync(p)) return p
  }
}

// ------------------------------------------------------------------------------------------------ the lock

interface LockInfo {
  v: 1
  pid: number
  token: string
  at: string
}

/** The lock this start holds: its file and token, refreshed as the copy goes. */
interface Held {
  file: string
  token: string
  refreshed: number
}

export const lockFile = (parent: string, newName: string): string => join(parent, `${newName}.move-lock`)

function readLock(file: string): LockInfo | null {
  try {
    const l = JSON.parse(readFileSync(file, 'utf8')) as LockInfo
    return l && l.v === 1 && typeof l.pid === 'number' && typeof l.token === 'string' && /^[0-9a-f]{16}$/.test(l.token) ? l : null
  } catch {
    return null
  }
}

const lockAge = (file: string, ops: MoveOps): number => {
  try {
    return ops.now() - statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Removes a file this start made, if it is there. */
function drop(file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Not there.
  }
}

/**
 * Takes the move's lock: `held`, `busy` (a live start holds it and refreshed it lately) or `refused` (one that can't be
 * read, or a live start's left unrefreshed, which is never removed). An ended start's lock is claimed, then taken.
 */
function takeLock(file: string, ops: MoveOps): { held: Held } | { busy: true } | { refused: string } {
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = randomBytes(8).toString('hex')
    const mine = `${file}.${token}.tmp`
    try {
      writeFileSync(mine, JSON.stringify({ v: 1, pid: ops.pid, token, at: new Date(ops.now()).toISOString() } satisfies LockInfo), { flag: 'wx' })
      // Whole before it has the lock's name: a hard link fails if the name is taken.
      linkSync(mine, file)
      return { held: { file, token, refreshed: ops.now() } }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') return { refused: reason(e) }
    } finally {
      drop(mine)
    }
    const other = readLock(file)
    if (!other) {
      // Gone meanwhile (its holder released it): try again. Anything else that can't be read is never removed.
      if (!existsSync(file)) continue
      return { refused: `the move's lock ${file} can't be read` } // i18n-ignore: the notice's reason, a detail
    }
    if (ops.alive(other.pid)) return lockAge(file, ops) < LOCK_STALE_MS ? { busy: true } : { refused: `the move's lock is held by process ${other.pid}, which hasn't moved for a while` } // i18n-ignore: the notice's reason, a detail
    // Its start has ended: claimed by renaming it to a name of this start's own (one contender's rename succeeds), then
    // checked to be the very lock judged ended. One taken over meanwhile goes back.
    const claimed = `${file}.claimed-${randomBytes(8).toString('hex')}`
    try {
      renameSync(file, claimed)
    } catch {
      continue
    }
    if (readLock(claimed)?.token === other.token) {
      drop(claimed)
      continue
    }
    try {
      linkSync(claimed, file)
      drop(claimed)
    } catch {
      // The name is another's again: theirs stays; this copy of the one taken over is kept for inspection.
    }
    return { busy: true }
  }
  return { refused: "the move's lock kept changing" } // i18n-ignore: the notice's reason, a detail
}

/** Refreshes the lock's time now and then, so a copy under way never looks ended. */
function refresh(h: Held, ops: MoveOps): void {
  const now = ops.now()
  if (now - h.refreshed < LOCK_REFRESH_MS) return
  h.refreshed = now
  try {
    utimesSync(h.file, new Date(now), new Date(now))
  } catch {
    // Seen as stale later at worst: a live holder is then refused, never removed.
  }
}

/** Lets the lock go, only if it is still this start's. */
function releaseLock(h: Held): void {
  if (readLock(h.file)?.token === h.token) drop(h.file)
}

// ------------------------------------------------------------------------------------------------ the copy

/**
 * Copies a folder's tree: files, folders, and links as links (accounts link to the CLI's home by junctions). A link to
 * somewhere inside the old folder points to the same place in the new one (`finalRoot`), any other keeps its target.
 */
function copyTree(from: string, to: string, root: { old: string; final: string }, ops: MoveOps, held: Held, skip: readonly string[]): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (skip.includes(name)) continue
    refresh(held, ops)
    const src = join(from, name)
    const dest = join(to, name)
    const st = lstatSync(src)
    if (st.isSymbolicLink()) {
      const target = readlinkSync(src)
      const abs = isAbsolute(target) ? target : resolve(from, target)
      const rel = relative(root.old, abs)
      const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      const pointTo = inside ? join(root.final, rel) : abs
      // A folder link becomes a junction (no privilege needed); a file link, a file link.
      let folder = true
      try {
        folder = statSync(abs).isDirectory()
      } catch {
        // A link to nothing: kept as a junction, as Hive makes them.
      }
      symlinkSync(pointTo, dest, folder ? 'junction' : 'file')
    } else if (st.isDirectory()) copyTree(src, dest, root, ops, held, [])
    else ops.copyFile(src, dest)
  }
}

const STAGING = /^(.+)\.moving-([0-9a-f]{16})$/

/** The token in a staging folder's marker, when it names the folder's own (a folder of this move's), else null. */
function stagingToken(dir: string, name: string): string | null {
  const m = STAGING.exec(name)
  if (!m) return null
  try {
    const t = (JSON.parse(readFileSync(join(dir, STAGING_MARKER), 'utf8')) as { token?: unknown }).token
    return t === m[2] ? m[2] : null
  } catch {
    return null
  }
}

/** Staging folders an ended attempt left: only those marked as this move's are removed (the lock's holder alone). */
function removeLeftStaging(parent: string, newName: string, mine: string): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(`${newName}.moving-`) || name.endsWith(mine)) continue
    const dir = join(parent, name)
    if (!stagingToken(dir, name)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Removed at a later start.
    }
  }
}

/**
 * Moves `<parent>\<oldName>` to `<parent>\<newName>` as the head comment says, and says which folder this run uses.
 * `skip`: top-level entries not copied (REGENERATED for the roaming profile).
 */
export function moveProfile(parent: string, oldName: string, newName: string, opts: { now?: Date; skip?: readonly string[]; ops?: MoveOps } = {}): MoveOutcome {
  const ops = opts.ops ?? realOps
  const now = opts.now ?? new Date(ops.now())
  const oldDir = join(parent, oldName)
  const newDir = join(parent, newName)
  // Nothing to change: no lock needed.
  if (isDir(newDir) && !isDir(oldDir)) return { kind: 'current', use: newDir }
  if (!isDir(newDir) && !isDir(oldDir)) return { kind: 'fresh', use: newDir }

  const got = takeLock(lockFile(parent, newName), ops)
  if ('busy' in got) return { kind: 'busy', use: isDir(newDir) ? newDir : oldDir }
  if ('refused' in got) return isDir(newDir) ? { kind: 'both', use: newDir, other: oldDir } : { kind: 'failed', use: oldDir, to: newDir, why: got.refused }
  const held = got.held
  try {
    ops.step?.('locked')
    // Decided again holding the lock: another start may have moved it meanwhile.
    const hasOld = isDir(oldDir)
    const hasNew = isDir(newDir)
    if (hasNew && !hasOld) return { kind: 'current', use: newDir }
    if (!hasNew && !hasOld) return { kind: 'fresh', use: newDir }
    if (hasNew) {
      const r = readRecord(newDir)
      // This move's backup rename, still pending: try it again now.
      if (r && r.backup === null && samePath(r.from, oldDir)) {
        const backup = renameToBackup(parent, oldName, now, ops)
        if (backup) writeRecord(newDir, { ...r, backup })
        return { kind: 'backedUp', use: newDir, backup }
      }
      return { kind: 'both', use: newDir, other: oldDir }
    }
    removeLeftStaging(parent, newName, held.token)
    const temp = join(parent, `${newName}.moving-${held.token}`)
    try {
      mkdirSync(temp)
      writeFileSync(join(temp, STAGING_MARKER), JSON.stringify({ token: held.token, pid: ops.pid }))
      copyTree(oldDir, temp, { old: oldDir, final: newDir }, ops, held, [...(opts.skip ?? []), STAGING_MARKER])
      writeRecord(temp, { v: 1, from: oldDir, movedAt: now.toISOString(), backup: null, opened: false })
      ops.step?.('staged')
      ops.rename(temp, newDir)
    } catch (e) {
      // Only this attempt's own partial copy goes; the old folder was never changed.
      if (stagingToken(temp, `${newName}.moving-${held.token}`) === held.token) {
        try {
          rmSync(temp, { recursive: true, force: true })
        } catch {
          // Left marked, for a later start to remove.
        }
      }
      return { kind: 'failed', use: oldDir, to: newDir, why: reason(e) }
    }
    drop(join(newDir, STAGING_MARKER))
    ops.step?.('published')
    const backup = renameToBackup(parent, oldName, now, ops)
    if (backup) {
      const r = readRecord(newDir)
      if (r) writeRecord(newDir, { ...r, backup })
    }
    return { kind: 'moved', use: newDir, backup }
  } finally {
    releaseLock(held)
  }
}

function renameToBackup(parent: string, oldName: string, now: Date, ops: MoveOps): string | null {
  const to = backupPath(parent, oldName, now)
  try {
    ops.rename(join(parent, oldName), to)
    return to
  } catch {
    return null
  }
}

/** Why a step failed, for the notice and the log: the error's code and the file it names. */
function reason(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  return err.code ? `${err.code}${err.path ? ` (${err.path})` : ''}` : String(err?.message ?? e)
}

/** The log's line for an outcome, in English (index.ts wraps the paths in userText). */
export function outcomeLine(o: MoveOutcome, show: (p: string) => string): string | null {
  switch (o.kind) {
    case 'moved':
      return `profile moved to ${show(o.use)}; backup ${o.backup ? show(o.backup) : 'pending (the old folder is in use)'}` // i18n-ignore: the log (English)
    case 'backedUp':
      return `profile's old folder ${o.backup ? `renamed to its backup ${show(o.backup)}` : 'still in use: its backup is pending'}` // i18n-ignore: the log (English)
    case 'both':
      return `profile: both ${show(o.use)} and ${show(o.other)} exist; using the new one, the old one left as it is` // i18n-ignore: the log (English)
    case 'failed':
      return `profile move to ${show(o.to)} failed (${show(o.why)}): using ${show(o.use)} for this run` // i18n-ignore: the log (English)
    case 'busy':
      return `profile move: another start is moving ${show(o.use)} now` // i18n-ignore: the log (English)
    default:
      return null
  }
}

// ------------------------------------------------------------------------------------------------ this run's folders

export interface ProfileMoves {
  roaming: MoveOutcome | null
  local: MoveOutcome | null
}

let moves: ProfileMoves = { roaming: null, local: null }

/** What the move did at this start (index.ts), for the notices and accounts.ts. */
export const profileMoves = (): ProfileMoves => moves

export function setProfileMoves(m: ProfileMoves): void {
  moves = m
}

/** The local profile folder this run uses (accounts, the connections' CLI homes), or null: the move didn't run. */
export const localProfileInUse = (): string | null => moves.local?.use ?? null
