// The profile folders move from Hive's names to Combwork's (HI-2461, SPEC §4.3): %APPDATA%\Hive → %APPDATA%\Combwork
// and %LOCALAPPDATA%\Hive → %LOCALAPPDATA%\Combwork (a dev build's Hive-Dev → Combwork-Dev), once, at the first start of
// a build with the new names, before anything reads or writes the profile (index.ts, before userData is set).
//
// Never losing data comes first. The old folder is copied, never moved: into `<new>.moving` beside it, which becomes the
// new folder by one rename once the copy is whole, and only then is the old folder renamed to a dated backup
// (`Hive.backup-2026-11-03`). A copy that fails (a locked file, a full disk) removes only its own partial copy, and this
// run keeps using the old folder, as it was; the next start tries again. A backup rename that fails (a file still open in
// the old folder) leaves the old folder beside the new one, recorded as pending, and the next start renames it then.
//
// The record (`profile-move.json`, in the new folder) says where it came from, its backup, whether the new folder has
// opened once, and what the user answered the offer to remove the backup. The backup is only ever removed on the user's
// answer, to the Recycle Bin (profileMoveNotices.ts).
//
// Synchronous on purpose: it runs once, before the app is ready and before any window, session or watcher exists, and
// nothing else may touch the profile while it runs. It logs nothing itself (the logger writes into the profile): its
// outcome carries what to log once the profile is set.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'original-fs'
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
const OWNER_FILE = '.profile-move-owner.json'

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
  /** The copy failed: nothing changed, the old folder is used for this run. */
  | { kind: 'failed'; use: string; to: string; why: string }
  /** Another start of this build is copying now: this one gives way. */
  | { kind: 'busy'; use: string }

/** File operations the move uses: real ones by default, failing ones in tests (a locked file, a full disk). */
export interface MoveOps {
  copyFile: (from: string, to: string) => void
  rename: (from: string, to: string) => void
  /** Whether a process with this id runs (a previous copy's owner). */
  alive: (pid: number) => boolean
  pid: number
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
  pid: process.pid
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

/**
 * Copies a folder's tree: files, folders, and links as links (accounts link to the CLI's home by junctions). A link to
 * somewhere inside the old folder points to the same place in the new one (`finalRoot`), any other keeps its target.
 */
function copyTree(from: string, to: string, root: { old: string; final: string }, ops: MoveOps, skip: readonly string[]): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (skip.includes(name)) continue
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
    } else if (st.isDirectory()) copyTree(src, dest, root, ops, [])
    else ops.copyFile(src, dest)
  }
}

/**
 * Moves `<parent>\<oldName>` to `<parent>\<newName>` as the head comment says, and says which folder this run uses.
 * `skip`: top-level entries not copied (REGENERATED for the roaming profile).
 */
export function moveProfile(parent: string, oldName: string, newName: string, opts: { now?: Date; skip?: readonly string[]; ops?: MoveOps } = {}): MoveOutcome {
  const ops = opts.ops ?? realOps
  const now = opts.now ?? new Date()
  const oldDir = join(parent, oldName)
  const newDir = join(parent, newName)
  const temp = join(parent, `${newName}.moving`)
  const hasOld = isDir(oldDir)
  const hasNew = isDir(newDir)

  if (hasNew) {
    if (!hasOld) return { kind: 'current', use: newDir }
    const r = readRecord(newDir)
    // This move's backup rename, still pending: try it again now.
    if (r && r.backup === null && samePath(r.from, oldDir)) {
      const backup = renameToBackup(parent, oldName, now, ops)
      if (backup) writeRecord(newDir, { ...r, backup })
      return { kind: 'backedUp', use: newDir, backup }
    }
    return { kind: 'both', use: newDir, other: oldDir }
  }
  if (!hasOld) return { kind: 'fresh', use: newDir }

  // The copy's folder is this start's alone: another start copying now has it (its owner runs), one left by a start
  // that ended partway is its own partial copy, removed before starting again.
  if (existsSync(temp)) {
    const owner = readOwner(temp)
    if (owner !== null && owner !== ops.pid && ops.alive(owner)) return { kind: 'busy', use: oldDir }
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch (e) {
      return { kind: 'failed', use: oldDir, to: newDir, why: reason(e) }
    }
  }
  try {
    mkdirSync(temp)
    writeFileSync(join(temp, OWNER_FILE), JSON.stringify({ pid: ops.pid }))
    copyTree(oldDir, temp, { old: oldDir, final: newDir }, ops, opts.skip ?? [])
    rmSync(join(temp, OWNER_FILE), { force: true })
    writeRecord(temp, { v: 1, from: oldDir, movedAt: now.toISOString(), backup: null, opened: false })
    ops.rename(temp, newDir)
  } catch (e) {
    // Only this start's own partial copy goes; the old folder was never changed.
    try {
      rmSync(temp, { recursive: true, force: true })
    } catch {
      // Left for the next start, which removes it first.
    }
    return { kind: 'failed', use: oldDir, to: newDir, why: reason(e) }
  }
  const backup = renameToBackup(parent, oldName, now, ops)
  if (backup) {
    const r = readRecord(newDir)
    if (r) writeRecord(newDir, { ...r, backup })
  }
  return { kind: 'moved', use: newDir, backup }
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

function readOwner(temp: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(join(temp, OWNER_FILE), 'utf8')) as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : null
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
      return `profile move: another start is copying ${show(o.use)} now` // i18n-ignore: the log (English)
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
