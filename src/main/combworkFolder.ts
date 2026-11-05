import { existsSync } from 'original-fs'
import { join } from 'path'
import { CW_DIR } from '../shared/defaults'
import { ASSISTANT_DIR } from '../shared/assistant'

/**
 * Where a host's data is (HI-2462): its `.combwork` folder, the only one read (HI-2594). The folder move (combworkMove.ts)
 * is what still looks at a host's `.hive`, as its input, at its workspace's open. Nothing here imports more than the file
 * system, so what runs before a workspace opens (the last run's report, restart's resume) can read through it.
 */

export type HostKind = 'workspace' | 'assistant' | 'project'

/** Whether a folder is ours: Combwork's files in it, for a host of this kind (the folder move's test of a `.hive`). */
export function ours(dir: string, kind: HostKind): boolean {
  if (existsSync(join(dir, 'project.json'))) return true
  return kind === 'workspace' && (existsSync(join(dir, 'workspace.json')) || existsSync(join(dir, 'hive.db')))
}

/** The folder a host's data is in: its `.combwork`. */
export const dataFolder = (host: string): string => join(host, CW_DIR)

/** The Assistant's home in a workspace, inside its data folder. */
export const assistantHomeIn = (workspacePath: string): string => join(dataFolder(workspacePath), ASSISTANT_DIR)
