import { randomBytes } from 'crypto'
import { join } from 'path'
import { lstat, readdir, rename, stat } from 'original-fs/promises'
import { CW_DIR } from '../shared/defaults'
import { launchFolderAgent, launchFolderName, launchFolderOf, SET_ASIDE, whileRemovingLaunchFolder } from './launchFolderNames'
import { removePath } from './fsutil'
import { createLogger, userText } from './logger'
import { trash, TrashNoLonger } from './trash'
import { WorkspaceService, workspace } from './workspace'

const log = createLogger('launch-folders')

/**
 * The launch folders of a project's agents (HI-3144): `<project>/.combwork/launch-<agent id>`, where a CLI's launch keeps
 * what Combwork generates for it alone (Claude Code's: its plugin with the session's skills, MCP config and hooks), made
 * again at every launch. Nothing in one is the user's or outlives the agent, so a removed agent's goes: when the agent is
 * removed, in a sweep as each workspace opens (folders left from before HI-3144, or by a crash) and from Storage's Clean
 * Up. Only a folder named exactly `launch-<id>` is ever touched, never a current agent's (in the project's agents) nor
 * one whose agent is starting or running, and nothing else in `.combwork`.
 */

/** A removed agent's launch folder, as Clean Up lists it. */
export interface StaleLaunchFolder {
  agentId: string
  path: string
}

/** Whether an agent of a project is starting or running (sessions.ts's, given at start): until then, every one is. */
let busy: (projectPath: string, agentId: string) => boolean = () => true

/**
 * The project's agents by id (lower-cased), from its project.json read now: null when it can't say (the file missing or
 * unreadable), so nothing is taken for removed on a read that failed.
 */
async function currentAgents(projectPath: string): Promise<Set<string> | null> {
  if (!(await stat(join(projectPath, CW_DIR, 'project.json')).catch(() => null))?.isFile()) return null
  try {
    const cfg = await workspace.projectConfig(projectPath, { unsettled: 'throw' })
    return new Set(cfg.agents.map((a) => a.id.toLowerCase()))
  } catch (e) {
    log.warn(`Could not read the agents of ${userText(projectPath)}: its launch folders are left`, e)
    return null
  }
}

/** A real folder (not a link, a junction or a file) at `path`. */
async function isFolder(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null)
  return !!st && st.isDirectory() && !st.isSymbolicLink()
}

/**
 * The launch folders in a project's `.combwork` whose agent is no longer the project's and isn't starting or running.
 * None when its agents can't be read.
 */
export async function staleLaunchFolders(projectPath: string): Promise<StaleLaunchFolder[]> {
  const agents = await currentAgents(projectPath)
  if (!agents) return []
  const out: StaleLaunchFolder[] = []
  for (const name of await readdir(join(projectPath, CW_DIR)).catch(() => [] as string[])) {
    const id = launchFolderAgent(name)
    if (!id || agents.has(id.toLowerCase()) || busy(projectPath, id)) continue
    const path = join(projectPath, CW_DIR, name)
    if (await isFolder(path)) out.push({ agentId: id, path })
  }
  return out
}

/**
 * Removes a removed agent's launch folder. It qualifies when it is a real folder, its agent isn't the project's (its
 * project.json read now) and isn't starting or running, that last checked with nothing awaited before the move. Once it
 * qualifies, the removal runs under the guard a launch shares (whileRemovingLaunchFolder: a launch of that agent waits for
 * its end), and qualifies again before each move it makes, the Recycle Bin's retries of a held folder too (HR2's round
 * 1): an agent added back or started meanwhile stops it, nothing changed. Deleted, it is renamed aside first, then
 * removed under a name no launch uses; to the Recycle Bin (`trash`, as Clean Up does), it is moved there under its own
 * name. Whether it went.
 */
export async function removeLaunchFolder(projectPath: string, agentId: string, how: 'delete' | 'trash' = 'delete'): Promise<boolean> {
  if (launchFolderAgent(launchFolderName(agentId)) !== agentId) return false
  const path = launchFolderOf(projectPath, agentId)
  const qualifies = async (): Promise<boolean> => {
    if (!(await isFolder(path))) return false
    const agents = await currentAgents(projectPath)
    // Last, after every read: nothing is awaited between this and the move that follows a yes.
    return !!agents && !agents.has(agentId.toLowerCase()) && !busy(projectPath, agentId)
  }
  if (!(await qualifies())) return false
  const removed = await whileRemovingLaunchFolder(projectPath, agentId, async () => {
    if (how === 'trash') {
      try {
        await trash(path, { still: qualifies })
        return true
      } catch (e) {
        if (e instanceof TrashNoLonger) return false
        throw e
      }
    }
    if (!(await qualifies())) return false
    const aside = `${path}.removing-${randomBytes(4).toString('hex')}`
    try {
      await rename(path, aside)
    } catch (e) {
      log.warn(`Could not set aside the launch folder of ${userText(agentId)} in ${userText(projectPath)}`, e)
      return false
    }
    await removePath(aside)
    return true
  })
  if (removed) log.info(`Removed the launch folder of ${userText(agentId)}, no longer an agent of ${userText(projectPath)}`)
  return removed
}

/** Folders set aside by a removal that stopped part way: no launch uses one, so they go. */
async function removeSetAside(projectPath: string): Promise<void> {
  for (const name of await readdir(join(projectPath, CW_DIR)).catch(() => [] as string[])) {
    const path = join(projectPath, CW_DIR, name)
    if (SET_ASIDE.test(name) && (await isFolder(path))) await removePath(path).catch((e) => log.warn(`Could not remove ${userText(path)}`, e))
  }
}

/** A workspace opening: each project's launch folders of removed agents go. Never fails. */
export async function sweepLaunchFolders(ws: WorkspaceService): Promise<void> {
  // Its projects as listed now (the listing the open reads may not be made yet when this is told).
  const listed = ws.info() ?? (await ws.refresh().catch(() => null))
  for (const p of listed?.projects ?? []) {
    if (ws.lifetime.aborted) return
    try {
      await removeSetAside(p.path)
      for (const f of await staleLaunchFolders(p.path)) await removeLaunchFolder(p.path, f.agentId)
    } catch (e) {
      log.warn(`Could not sweep the launch folders of ${userText(p.path)}`, e)
    }
  }
}

let started = false
const running = new Set<Promise<unknown>>()

/** Starts the sweep at each workspace's opening; `isBusy` says whether an agent of a project is starting or running. */
export function initLaunchFolders(isBusy: (projectPath: string, agentId: string) => boolean): void {
  busy = isBusy
  if (started) return
  started = true
  const sweep = (ws: WorkspaceService): void => {
    if (!ws.path) return
    const run = sweepLaunchFolders(ws)
      .catch((e) => log.warn('sweeping the launch folders of removed agents', e))
      .finally(() => running.delete(run))
    running.add(run)
  }
  WorkspaceService.openedListeners.add(sweep)
}

/** For tests: every sweep under way has finished. */
export const launchSweepsSettled = (): Promise<unknown> => Promise.all([...running])
