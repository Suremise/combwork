// Which profile folders this run uses (HI-2461, SPEC §4.3): Combwork's (`%APPDATA%\Combwork`, `%LOCALAPPDATA%\Combwork`;
// a dev build's `Combwork-Dev`), and Hive's from before (`Hive`, `Hive-Dev`) only as a fallback while Combwork's isn't
// there. The installer moves the folders, with the app closed (HI-2460); the app never moves, locks or deletes them. It
// only looks: decided for each of the two on its own, before anything reads the profile (index.ts, before userData is
// set). Both there: Combwork's is used, Hive's is left as it is.
//
// A folder is missing only when the system says so (ENOENT, ENOTDIR). One that can't be looked at (no permission, an
// I/O error) is never taken for missing: Combwork's is used then, as the profile Hive would make, and the reason kept for
// the log. Nothing here logs (the logger writes into the profile): the choice carries what to log once it is set.

import { statSync } from 'original-fs'
import { join } from 'path'

/** What looking at a folder found. */
type Seen = 'folder' | 'missing' | 'other' | { error: string }

/** How a folder is looked at: `statSync`, or a failing one in tests. */
export type Stat = (path: string) => { isDirectory(): boolean }

function look(path: string, stat: Stat): Seen {
  try {
    return stat(path).isDirectory() ? 'folder' : 'other'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : { error: code ?? String((e as Error).message ?? e) }
  }
}

export interface ProfileChoice {
  /** The folder this run uses. */
  use: string
  /** Combwork's folder, whether used or not. */
  current: string
  /** Hive's old folder is used, Combwork's not being there. */
  fallback: boolean
  /** Why Combwork's folder was used without knowing whether it is there (it couldn't be looked at), for the log. */
  unreadable?: string
}

/**
 * The folder to use in `parent` (`%APPDATA%` or `%LOCALAPPDATA%`): `current` (Combwork's) when it is a folder, Hive's
 * `legacy` one when Combwork's is confirmed missing (or a file of that name is there) and Hive's is a folder, else
 * `current` (a new profile, made as usual). Reads only.
 */
export function chooseProfile(parent: string, legacy: string, current: string, stat: Stat = statSync): ProfileChoice {
  const now = join(parent, current)
  const old = join(parent, legacy)
  const seen = look(now, stat)
  if (seen === 'folder') return { use: now, current: now, fallback: false }
  if (typeof seen === 'object') return { use: now, current: now, fallback: false, unreadable: seen.error }
  return look(old, stat) === 'folder' ? { use: old, current: now, fallback: true } : { use: now, current: now, fallback: false }
}

/** The log's line for a choice, in English (index.ts wraps the paths in userText), or null when there's nothing to say. */
export function choiceLine(c: ProfileChoice, show: (p: string) => string): string | null {
  if (c.fallback) return `profile: ${show(c.current)} isn't there; using ${show(c.use)}, from before Combwork` // i18n-ignore: the log (English)
  if (c.unreadable) return `profile: ${show(c.current)} couldn't be looked at (${c.unreadable}); using it` // i18n-ignore: the log (English)
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
