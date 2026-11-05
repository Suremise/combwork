import { existsSync } from 'original-fs'
import { join } from 'path'
import { CW_DIR } from '../shared/defaults'
import { LEGACY_HIVE_DIR } from '../shared/hiveFolderMove'
import { ASSISTANT_DIR } from '../shared/assistant'

/**
 * Which of a host's folders holds Combwork's data now (HI-2462): `.combwork`, or, until the folder move has run at its
 * workspace's open, our own `.hive`. Nothing here imports more than the file system, so what runs before a workspace
 * opens (the last run's report, restart's resume) can read through it. combworkMove.ts moves the folders.
 */

export type HostKind = 'workspace' | 'assistant' | 'project'

/** Whether a folder is ours: Combwork's files in it, for a host of this kind. */
export function ours(dir: string, kind: HostKind): boolean {
  if (existsSync(join(dir, 'project.json'))) return true
  return kind === 'workspace' && (existsSync(join(dir, 'workspace.json')) || existsSync(join(dir, 'hive.db')))
}

/**
 * The folder a host's data is in now, for what reads (and writes) it before its workspace opens: `.combwork` once
 * there, else our own `.hive` while it hasn't moved (what is written there moves with it), else `.combwork`. Never makes
 * either, so there is only ever one tree.
 */
export function dataFolder(host: string, kind: HostKind = 'project'): string {
  const now = join(host, CW_DIR)
  if (existsSync(now)) return now
  const old = join(host, LEGACY_HIVE_DIR)
  if (existsSync(old) && ours(old, kind)) return old
  return now
}

/** The Assistant's home in a workspace, inside whichever of its folders is in use (dataFolder). */
export const assistantHomeIn = (workspacePath: string): string => join(dataFolder(workspacePath, 'workspace'), ASSISTANT_DIR)
