// Which profile folders this run uses (HI-2461, SPEC §4.3): Combwork's (`%APPDATA%\Combwork`, `%LOCALAPPDATA%\Combwork`;
// a dev build's `Combwork-Dev`), the only ones it runs on (HI-2594). The installer moves 1.0's folders from before
// (`Hive`, `Hive-Dev`) to them with the app closed (HI-2460); where that didn't happen (its rename failed, or a dev
// build), the names upgrade's profile step does it here, at start, before anything reads the profile (index.ts, before
// userData is set), each of the two on its own and by the installer's rule: one rename, only while 1.0's is a folder and
// Combwork's is confirmed absent, never a copy or a delete. A move it can't make refuses the start, naming both folders:
// a blank Combwork profile made in its place would win at every later start, and 1.0's data would look lost.
//
// A folder is missing only when the system says so (ENOENT, ENOTDIR). One that can't be looked at (no permission, an
// I/O error) is never taken for missing: Combwork's is used then, as the profile 1.0 would make, and the reason kept for
// the log; 1.0's that can't be looked at, Combwork's missing, refuses the start. Nothing here logs (the logger writes
// into the profile): the choice carries what to log once it is set.

import { renameSync, rmSync, statSync, writeFileSync } from 'original-fs'
import { join } from 'path'

/** What looking at a folder found. */
type Seen = 'folder' | 'missing' | 'other' | { error: string }

/** How the profile step works with the file system: Node's, or failing stand-ins in tests. */
export interface ProfileFs {
  stat: (path: string) => { isDirectory(): boolean }
  rename: (from: string, to: string) => void
  write: (path: string, text: string) => void
  remove: (path: string) => void
}

const nodeFs: ProfileFs = { stat: statSync, rename: renameSync, write: (p, t) => writeFileSync(p, t), remove: (p) => rmSync(p, { force: true }) }

function look(path: string, fs: ProfileFs): Seen {
  try {
    return fs.stat(path).isDirectory() ? 'folder' : 'other'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : { error: code ?? String((e as Error).message ?? e) }
  }
}

/** The record of a move in the new local folder (HI-2461's contract with the installer; profileNotices.ts reads it). */
export const MOVE_RECORD = 'profile-move.json'

export interface ProfileChoice {
  /** The folder this run uses: Combwork's. */
  use: string
  /** 1.0's folder this start moved to it (the names upgrade), if it did. */
  movedFrom?: string
  /** Why Combwork's folder was used without knowing whether it is there (it couldn't be looked at), for the log. */
  unreadable?: string
}

/** A move the start can't make: refused, both folders as they were (index.ts says so and quits). */
export class ProfileMoveRefused extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly reason: string
  ) {
    super(`${from} → ${to}: ${reason}`) // i18n-ignore: the log (English); the window's words are index.ts's message
  }
}

/**
 * The folder to use in `parent` (`%APPDATA%` or `%LOCALAPPDATA%`): `current` (Combwork's) when it is a folder, or a new
 * profile when neither is there. 1.0's `legacy` folder, Combwork's confirmed missing, is renamed to it first: in the
 * local folder (`record`), with the installer's record put in it before the rename (`by: "app"`), so it arrives with the
 * folder or not at all and the sign-in check runs at the first window, as after the installer's move. Throws
 * ProfileMoveRefused when 1.0's can't be looked at or moved (a 1.0 app still running holds it, a file has Combwork's name).
 */
export function chooseProfile(parent: string, legacy: string, current: string, o: { record?: boolean; fs?: ProfileFs } = {}): ProfileChoice {
  const fs = o.fs ?? nodeFs
  const now = join(parent, current)
  const old = join(parent, legacy)
  const seen = look(now, fs)
  if (seen === 'folder') return { use: now }
  if (typeof seen === 'object') return { use: now, unreadable: seen.error }
  const was = look(old, fs)
  if (was === 'missing' || was === 'other') return { use: now }
  if (typeof was === 'object') throw new ProfileMoveRefused(old, now, `it couldn't be looked at (${was.error})`) // i18n-ignore: the reason's detail, in English (the error box's {reason} says so)
  if (seen === 'other') throw new ProfileMoveRefused(old, now, `a file is there under ${current}'s name`) // i18n-ignore: the reason's detail, in English (the error box's {reason} says so)
  const rec = join(old, MOVE_RECORD)
  // One there already (the installer's, left by a rename of its that failed, or anyone's) is kept as it is, and moves.
  const record = !!o.record && look(rec, fs) === 'missing'
  if (record) {
    try {
      fs.write(rec, JSON.stringify({ v: 1, from: old, movedAt: new Date().toISOString(), by: 'app' }, null, 2))
    } catch (e) {
      throw new ProfileMoveRefused(old, now, `the record of the move couldn't be put in it (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`) // i18n-ignore: the reason's detail, in English (the error box's {reason} says so)
    }
  }
  try {
    fs.rename(old, now)
  } catch (e) {
    if (record) {
      try {
        fs.remove(rec)
      } catch {
        // Left in Combwork's folder: it is the move's own, and read only once the folder has moved.
      }
    }
    throw new ProfileMoveRefused(old, now, `it couldn't be renamed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`) // i18n-ignore: the reason's detail, in English (the error box's {reason} says so)
  }
  return { use: now, movedFrom: old }
}

/** The log's line for a choice, in English (index.ts wraps the paths in userText), or null when there's nothing to say. */
export function choiceLine(c: ProfileChoice, show: (p: string) => string): string | null {
  if (c.movedFrom) return `profile: moved ${show(c.movedFrom)} to ${show(c.use)}, from before Combwork (the names upgrade)` // i18n-ignore: the log (English)
  if (c.unreadable) return `profile: ${show(c.use)} couldn't be looked at (${c.unreadable}); using it` // i18n-ignore: the log (English)
  return null
}

// ------------------------------------------------------------------------------------------------ this run's folders

export interface ProfileChoices {
  roaming: ProfileChoice | null
  local: ProfileChoice | null
}

let choices: ProfileChoices = { roaming: null, local: null }

/** What this run chose (index.ts), for the notices and accounts.ts. */
export const profileChoices = (): ProfileChoices => choices

export function setProfileChoices(c: ProfileChoices): void {
  choices = c
}

/** The local profile folder this run uses (accounts, the connections' CLI homes), or null: none was chosen (a test copy). */
export const localProfileInUse = (): string | null => choices.local?.use ?? null
