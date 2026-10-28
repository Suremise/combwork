import { lstat, realpath } from 'original-fs/promises'
import { join, relative, resolve, sep } from 'path'

/**
 * The file checks of the card attachments' clean-up (HI-1842 round 2), used by its plan and again by
 * each card's removal (on main, in the board's change): a card's folder is the host's own, a real folder at every step,
 * and a file is the one planned (the same on-disk file, unchanged).
 */

/** A file as it is on disk: what says it is the same, unchanged file (its identity, size and last write). */
export interface FileIdentity {
  dev: string
  ino: string
  size: string
  mtimeNs: string
}

/**
 * Whether `folder` (a card's, under `host`) is the host's own: every step from the host to it a real folder, never a
 * link or a junction, and its real path where its path says, inside the host's. False when any step is missing.
 */
export async function ownFolder(host: string, folder: string): Promise<boolean> {
  const rel = relative(host, folder)
  if (!rel || rel.startsWith('..') || rel.includes(':')) return false
  let p = host
  for (const step of rel.split(sep)) {
    p = join(p, step)
    const st = await lstat(p).catch(() => null)
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false
  }
  const [realHost, realFolder] = await Promise.all([realpath(host).catch(() => null), realpath(folder).catch(() => null)])
  return !!realHost && !!realFolder && resolve(realHost, rel).toLowerCase() === realFolder.toLowerCase()
}

/** A plain file's identity now; null when it is missing, a link, or not a file. */
export async function fileIdentity(file: string): Promise<FileIdentity | null> {
  const st = await lstat(file, { bigint: true }).catch(() => null)
  if (!st || st.isSymbolicLink() || !st.isFile()) return null
  return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs) }
}

export const sameFile = (a: FileIdentity | null, b: FileIdentity | null): boolean => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
