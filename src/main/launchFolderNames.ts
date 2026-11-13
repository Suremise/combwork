// HI-3144: the names of agents' launch folders (`<project>/.combwork/launch-<agent id>`), with no other dependency, so a
// provider's adapter and the clean-up (launchFolders.ts) name them alike.
import { join } from 'path'
import { CW_DIR } from '../shared/defaults'

/** An agent id as a folder name may hold it: letters, digits, `-` and `_` (Combwork's `a-1234abcd`, older `a2`). */
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}'
const NAME = new RegExp(`^launch-(${ID})$`)
/** One set aside to be removed (a sweep stopped part way): its agent's id, and never a name a launch makes. */
export const SET_ASIDE = new RegExp(`^launch-(${ID})\\.removing-[0-9a-f]{8}$`)

/** An agent's launch folder's name. */
export const launchFolderName = (agentId: string): string => `launch-${agentId}`

/** An agent's launch folder in a project. */
export const launchFolderOf = (projectPath: string, agentId: string): string => join(projectPath, CW_DIR, launchFolderName(agentId))

/** The agent id a `.combwork` entry's name says it is the launch folder of; null for any other name. */
export function launchFolderAgent(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null
}
