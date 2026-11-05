import { readFileSync, renameSync, writeFileSync } from 'original-fs'
import { rm } from 'original-fs/promises'
import { join } from 'path'

/**
 * The names upgrade's steps in the profile (HI-2587, nameUpgrade.ts), as the app starts, before what they rename is read:
 * each looks at its own file and changes only what is still old. The log's files are logger.ts's (moveOldLogs), before its
 * first line.
 *
 * - **The profile folders** (HI-2594): Hive's `Hive` (`Hive-Dev`) moved to Combwork's where the installer hasn't
 *   (profileFolders.ts chooseProfile, before userData is set); a move it can't make refuses the start.
 * - **The run marker** (`running.json`, lastRun.ts): the version that wrote it, `hive` before 1.1, is `app`. Rewritten
 *   before the last run's marker is read (checkLastRun), so a 1.0 or RC run that ended without quitting is still told.
 * - **The progress command's old names** (HI-2594): 1.0 and the RCs put `hive-progress` and `hive-progress.cmd` beside
 *   `cw-progress` in the profile's bin folder. They are removed before the shims are written (index.ts), so no session
 *   finds the old command.
 */

/**
 * The profile folder's name before HI-2461 (`Hive`, a dev build's `Hive-Dev`): the input of the profile folders' step
 * (profileFolders.ts chooseProfile), where the installer hasn't moved it (HI-2460).
 */
export const oldProfileFolder = (packaged: boolean): string => (packaged ? 'Hive' : 'Hive-Dev') // i18n-ignore: folder names

/** The progress command's shims under their names before 1.1, in the profile's bin folder. */
export const OLD_SHIMS: readonly string[] = ['hive-progress', 'hive-progress.cmd']

/** Removes the old shims from `binDir` (none there: nothing to do). Never throws: one left is never run by Combwork. */
export async function removeOldShims(binDir: string): Promise<void> {
  for (const name of OLD_SHIMS) await rm(join(binDir, name), { force: true }).catch(() => undefined)
}

/** A run marker's text with its old key renamed; null when it has nothing old (or isn't JSON: read as it is). */
export function upgradedRunMarker(text: string): string | null {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !('hive' in d) || 'app' in d) return null
  const { hive, ...rest } = d as Record<string, unknown>
  return JSON.stringify({ ...rest, app: hive })
}

/** Rewrites the run marker in place when it has the old key. Never throws: the marker is read as it is then. */
export function upgradeRunMarkerFile(file: string): void {
  try {
    const now = upgradedRunMarker(readFileSync(file, 'utf8'))
    if (now === null) return
    writeFileSync(`${file}.upgrading`, now)
    renameSync(`${file}.upgrading`, file)
  } catch {
    // Missing or held: nothing to do, or the marker is read as it is.
  }
}
