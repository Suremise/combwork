import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import { join } from 'path'
import { CW_DIR } from '../shared/defaults'
import { msg, type Msg } from '../shared/i18n'
import { boardFileNeeded, moveBoardFile, NEW_DB_FILE } from './boardFileMove'
import { writeTextAtomic } from './fsutil'
import { HiveError, errorText, hiveError } from './hiveError'
import { createLogger } from './logger'
import { upgradeWorkspaceFiles } from './nameUpgradeFiles'
import { upgradeProject } from './nameUpgradeProjects'

/**
 * The one-way names upgrade (HI-2587, its design HI-2587/s15 with s20, s23 and s26): what 1.0 and the 1.1 release
 * candidates stored under Hive's names gets Combwork's, once, and nothing reads the old names afterwards. Each step looks
 * at its own item and changes only what is still old, so a 1.0.0 install, a partly converted RC2 and an upgrade
 * interrupted halfway all end in the same state.
 *
 * Where each runs: the profile folders by the installer (HI-2460); the profile's files as the app starts (the log in
 * logger.ts, settings as they load); a workspace's and its projects' at its open, under the folder move's lock, after
 * `.hive` → `.combwork` and before anything of the workspace is admitted (combworkMove.ts calls `workspaceNeeds` and
 * `upgradeWorkspace`); values inside databases in their schema steps (db.ts). A step that fails refuses the open,
 * naming what it was renaming; the next open does it again.
 *
 * What is looked at on every open is cheap: the board's file names, and `combwork-names.json`, written in the
 * workspace's `.combwork` once every step has worked. Without it (a 1.0 or RC workspace, or a run interrupted), every
 * step runs again over the whole workspace: each is idempotent. A project that comes into an open workspace later gets
 * its own steps then (`only`), whatever the file says.
 */

const log = createLogger('nameUpgrade')

/** Written once every step has worked for the workspace: the names upgrade's version. */
export const NAMES_DONE_FILE = 'combwork-names.json'
const NAMES_VERSION = 2

export type WorkspaceStep = 'board' | 'files' | 'projects'

const M = {
  failed: msg({ id: 'service.nameUpgrade.failed', defaultMessage: "Combwork couldn't finish renaming {what} from Hive's names to Combwork's: {error} Open the workspace again to finish. Nothing was lost.", description: "An error opening a workspace (HI-2587): a step of the one-time upgrade of the names Hive stored (files, settings) to Combwork's failed; the next open tries again. {what} is what it was renaming (main.nameUpgrade.what.*); {error} says why, a sentence." }),
  what: {
    board: msg({ id: 'main.nameUpgrade.what.board', defaultMessage: "the board's file", description: "What the names upgrade was renaming when it failed (service.nameUpgrade.failed): the task board's database file, hive.db to combwork.db." }),
    files: msg({ id: 'main.nameUpgrade.what.files', defaultMessage: "the workspace's .gitignore, README and MCP definitions", description: 'What the names upgrade was renaming when it failed (service.nameUpgrade.failed): files in the workspace\'s .combwork folder. Keep .gitignore, README and MCP as they are.' }),
    projects: msg({ id: 'main.nameUpgrade.what.projects', defaultMessage: "the projects' skill copies, git exclude lines and refs", description: "What the names upgrade was renaming when it failed (service.nameUpgrade.failed): markers in Combwork's copies of skills in projects, comment lines in git's exclude files, and git refs Combwork keeps (refs/hive/… to refs/cw/…)." })
  } satisfies Record<WorkspaceStep, Msg<string>>
}

/**
 * The record, in a host's `.combwork`: the workspace's once every step has worked; a project's once its own steps have
 * (HR2's round 1: a project that comes into an upgraded workspace later, its folder `.combwork` already, gets its steps
 * by its own record, whatever the workspace's says). Both are this machine's: the workspace's is in its .gitignore, a
 * project's `.combwork` is out of git whole.
 */
const recordOf = (host: string): string => join(host, CW_DIR, NAMES_DONE_FILE)

async function recorded(host: string): Promise<boolean> {
  try {
    return (JSON.parse(await readFile(recordOf(host), 'utf8')) as { version?: unknown }).version === NAMES_VERSION
  } catch {
    return false
  }
}

/** Writes a host's record (its `.combwork` there): only under the move's lock, after the other processes' refusal (combworkMove.ts). */
export const record = async (host: string): Promise<void> => {
  if (existsSync(join(host, CW_DIR))) await writeTextAtomic(recordOf(host), JSON.stringify({ version: NAMES_VERSION, at: new Date().toISOString() }) + '\n')
}

/** Whether a project's own steps have run (its record): looked at as a project comes into an open workspace. */
export const projectNamesDone = (host: string): Promise<boolean> => recorded(host)

/** Whether a workspace may still have anything under an old name: looked at cheaply, on every open. */
export async function workspaceNeeds(ws: string): Promise<boolean> {
  const dir = join(ws, CW_DIR)
  if (!existsSync(dir)) return false
  return (await boardFileNeeded(dir)) || !(await recorded(ws))
}

export interface UpgradeOptions {
  stop: () => void
  /** Folds the board's old file's log in and closes it (the move's worker). */
  checkpoint: (file: string) => Promise<{ ok: boolean; error?: string }>
  /** The folders the board's skill copies records name (the move's worker). */
  copyFolders: (boardFile: string) => Promise<string[]>
  /** The workspace's projects' folders. */
  projects: readonly string[]
  /** A single project that came into the open workspace later: its own steps only. */
  only?: string
}

/** The steps (under the move's lock, nothing of the workspace open): each throws a HiveError naming it when it can't. */
export async function upgradeWorkspace(ws: string, o: UpgradeOptions): Promise<void> {
  const dir = join(ws, CW_DIR)
  if (o.only) {
    const only = o.only
    return step('projects', o.stop, async () => {
      await upgradeProject(only, [])
      await record(only)
    })
  }
  if (!existsSync(dir)) return
  await step('board', o.stop, () => moveBoardFile(dir, o.checkpoint))
  await step('files', o.stop, async () => upgradeWorkspaceFiles(dir, (await import('./workspace')).WORKSPACE_README))
  await step('projects', o.stop, async () => {
    // Each project, then each folder its agents worked in that the board's records name (slots, worktrees, copies: the
    // same repository's exclude file, already done, and their own skill copies).
    const copyFolders = (await o.copyFolders(join(dir, NEW_DB_FILE))).filter((f) => existsSync(f))
    for (const p of o.projects) {
      o.stop()
      await upgradeProject(p, [])
      await record(p)
    }
    o.stop()
    await upgradeProject(null, copyFolders)
  })
  o.stop()
  await record(ws)
  log.info(`The names upgrade is done for this workspace (${NAMES_DONE_FILE})`)
}

async function step(what: WorkspaceStep, stop: () => void, fn: () => Promise<void>): Promise<void> {
  stop()
  try {
    await fn()
  } catch (e) {
    if (e instanceof HiveError) throw e
    log.warn(`the names upgrade's ${what} step`, e)
    throw hiveError(M.failed, { what: M.what[what], error: errorText(e) }, { kind: 'conflict' })
  }
}
