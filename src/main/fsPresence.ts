import { lstatSync, statSync, type Stats } from 'original-fs'
import { lstat } from 'original-fs/promises'

/**
 * Whether something is there, for the one-way upgrade's steps (HI-2587's names upgrade, HI-2462's folder move, HI-2598's
 * stored values; the Assistant's note on HI-2598 after HR1's rounds): only its absence (ENOENT; for a path's own look,
 * ENOTDIR too: a parent that is a file) answers "not there". Any other error (another program holds it, access denied, a drive not ready)
 * throws, so the step fails, nothing is recorded done, and the next open or start tries again, rather than a step
 * taking a folder or file it couldn't look at for one that isn't there, and moving on without it.
 */

const absent = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Whether a path is there (following a link); throws on anything but its absence. */
export function present(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (e) {
    if (absent(e)) return false
    throw e
  }
}

/** A path's own entry (a link not followed), or null when it isn't there; throws on anything but its absence. */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (e) {
    if (absent(e)) return null
    throw e
  }
}

/** lstatOrNull, without blocking: for many hosts at once. */
export async function lstatOrNullAsync(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (e) {
    if (absent(e)) return null
    throw e
  }
}

/**
 * For `.catch()`: `value` when what was read isn't there (ENOENT), else the error again: a folder that is a file where
 * one is listed (ENOTDIR) fails the step too (HR2's round 1 on HI-2587).
 */
export const ifAbsent =
  <T>(value: T) =>
  (e: unknown): T | Promise<never> =>
    (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? value : Promise.reject(e)
