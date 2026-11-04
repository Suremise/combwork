import { basename, join } from 'path'
import { readFile } from 'original-fs/promises'
import { DELIVER_WORKSPACE_NOTES, WORKSPACE_NOTES_MAX_ID } from '../shared/advanced'
import { deliveredNotes, notesFor, WORKSPACE_NOTES_PATH } from '../shared/workspaceNotes'
import { advanced } from './advanced'
import { createLogger } from './logger'
import { workspaceOf } from './workspace'

const log = createLogger('notes')

/** The note's file in a workspace's `.combwork/shared`. */
export const workspaceNotesFile = (sharedDir: string): string => join(sharedDir, WORKSPACE_NOTES_PATH)

/**
 * What a launch in `projectPath` (a project, or the Hive Assistant's home) adds to its instructions of the Workspace notes
 * note (#1433): its part for the project, bounded (Settings → Advanced), as the note is now; '' when the switch is off,
 * the note is empty or missing, or it can't be read (the launch goes on without it). A running session keeps what it
 * started with: an edit reaches each agent's next launch or new conversation.
 */
export async function workspaceNotesFor(projectPath: string): Promise<string> {
  if (!advanced.get<boolean>(DELIVER_WORKSPACE_NOTES)) return ''
  const ws = workspaceOf(projectPath)
  if (!ws.path) return ''
  const text = await readFile(workspaceNotesFile(ws.sharedDir), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') log.warn('Could not read the Workspace notes note; launching without it', e)
    return ''
  })
  if (!text.trim()) return ''
  const assistant = ws.isAssistantHome(projectPath)
  // Hidden projects too: their sections are theirs, not everyone's.
  const listed = async (hidden: boolean): Promise<string[]> => ws.listProjectPaths({ hidden }).catch(() => [] as string[])
  const projects = assistant ? [] : [...(await listed(false)), ...(await listed(true)), projectPath].map((p) => basename(p))
  return deliveredNotes(notesFor(text, assistant ? null : basename(projectPath), projects), advanced.get<number>(WORKSPACE_NOTES_MAX_ID)).text
}
