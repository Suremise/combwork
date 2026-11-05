import { readFileSync, renameSync, writeFileSync } from 'original-fs'

/**
 * The names upgrade's steps in the profile (HI-2587, nameUpgrade.ts), as the app starts, before what they rename is read:
 * each looks at its own file and changes only what is still old. The log's files are logger.ts's (moveOldLogs), before its
 * first line.
 *
 * - **The run marker** (`running.json`, lastRun.ts): the version that wrote it, `hive` before 1.1, is `app`. Rewritten
 *   before the last run's marker is read (checkLastRun), so a 1.0 or RC run that ended without quitting is still told.
 */

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
