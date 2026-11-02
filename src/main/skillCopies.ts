import { resolve } from 'path'
import { SKILLS_REMOVE_IDLE_COPIES } from '../shared/advanced'
import { samePath } from '../shared/movePaths'
import { advanced } from './advanced'
import { boardRead, boardReadOnly, boardWrite, boardWriteOp, onBoardUpgraded } from './boardStore'
import { createLogger, userText } from './logger'
import { removeHiveCopies } from './providers/common'
import type { SkillCopyBook, SkillCopyRecord } from './providers/types'
import { WorkspaceService, workspaceFor } from './workspace'

const log = createLogger('skills')

/**
 * Hive's skill copies in the folders agents work in (#1431, SPEC §16.10.7, §16.15 C row 15). Codex and Copilot read
 * Hive's skills from copies in `<folder>/.agents/skills/hive-*` (providers/common.ts syncAgentsSkills), which outlive
 * the session, so a CLI run on its own there still sees them; Claude Code's launch plugin leaves nothing behind. Hive
 * records each copy it makes (`skill_copies` in hive.db) and removes its own, unchanged ones (removeHiveCopies) once no
 * session of Hive's works in the folder, as Settings → Advanced's switch says: when the last session there ends, at
 * start for folders whose sessions are gone, and when a lease ends or a slot goes (removeCopiesIn, for #1438 and #1429).
 */

/** Where idle copies are removed (SKILLS_REMOVE_IDLE_COPIES). */
export type IdleCopies = 'slots' | 'everywhere' | 'never'

/** Whether a session of Hive's runs (or is starting) in a folder: sessions.ts's, given at start (initSkillCopies). */
let busyIn: (folder: string) => boolean = () => true

/** The switch's value; anything else (a hand-edited advanced.json) is the default. */
export function idleCopies(): IdleCopies {
  const v = advanced.get<string>(SKILLS_REMOVE_IDLE_COPIES)
  return v === 'everywhere' || v === 'never' ? v : 'slots'
}

/** Whether the switch removes idle copies from `folder` of the project at `project`: Slots only keeps the project folder's. */
export function removesIn(folder: string, project: string, value: IdleCopies = idleCopies()): boolean {
  return value === 'everywhere' || (value === 'slots' && !samePath(folder, project))
}

/** The record of a workspace's skill copies, in its hive.db. A board that can't be read or written records nothing. */
export function copyBook(ws: WorkspaceService): SkillCopyBook {
  const key = (folder: string): string => resolve(folder)
  return {
    of: async (folder) => {
      const rows = boardRead(ws, (db) => db.prepare('SELECT skill, project, revision FROM skill_copies WHERE folder = ?').all(key(folder)) as unknown as SkillCopyRecord[]) // i18n-ignore: SQL
      return new Map(rows.map((r) => [r.skill.toLowerCase(), { skill: r.skill, project: r.project, revision: r.revision }]))
    },
    record: (folder, project, skill, revision) =>
      boardWrite(ws, async () =>
        boardWriteOp(ws, (db) => {
          db.prepare('INSERT INTO skill_copies (folder, skill, project, revision, made_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (folder, skill) DO UPDATE SET project = excluded.project, revision = excluded.revision, made_at = excluded.made_at WHERE revision <> excluded.revision OR project <> excluded.project').run(key(folder), skill, resolve(project), revision, new Date().toISOString()) // i18n-ignore: SQL
        })
      ),
    forget: (folder, skill) =>
      boardWrite(ws, async () =>
        boardWriteOp(ws, (db) => {
          db.prepare('DELETE FROM skill_copies WHERE folder = ? AND skill = ?').run(key(folder), skill) // i18n-ignore: SQL
        })
      )
  }
}

/** The folders a workspace's records have copies in, each with its project folder. */
function recordedFolders(ws: WorkspaceService): { folder: string; project: string }[] {
  return boardRead(ws, (db) => db.prepare('SELECT folder, min(project) AS project FROM skill_copies GROUP BY folder').all() as unknown as { folder: string; project: string }[]) // i18n-ignore: SQL
}

/**
 * Removes Hive's own copies from a folder no session of Hive's works in: as the switch says, or `always` (a slot or copy
 * about to be removed, #1429's guarded clean-up). Never fails: what can't be removed now stays for a later clean-up.
 */
export async function removeCopiesIn(projectPath: string, folder: string, opts: { always?: boolean; why?: string } = {}): Promise<string[]> {
  const ws = workspaceFor(projectPath)
  // The Assistant works in the workspace folder, never a slot: its copies there are kept as a project folder's are.
  if (!ws || (!opts.always && !removesIn(folder, ws.isAssistantHome(projectPath) ? folder : projectPath))) return []
  try {
    const removed = await removeHiveCopies(folder, projectPath, copyBook(ws), () => busyIn(folder))
    if (removed.length) log.info(`Removed Hive's skill copies from ${userText(folder)}${opts.why ? ` (${opts.why})` : ''}: ${removed.join(', ')}`)
    return removed
  } catch (e) {
    log.warn(`Could not remove Hive's skill copies from ${userText(folder)}`, e)
    return []
  }
}

/** A session of Hive's ended in `folder`: with none left there, its copies go (as the switch says). */
export function sessionEnded(projectPath: string, folder: string): Promise<string[]> {
  return removeCopiesIn(projectPath, folder, { why: 'its last session ended' }) // i18n-ignore: the log's reason (English)
}

/** At start (a workspace opening): the copies in folders whose sessions are gone, as the switch says. */
export async function sweepIdleCopies(ws: WorkspaceService): Promise<void> {
  // A board waiting for its upgrade to 1.0 has no record yet: swept once it is upgraded (#1621).
  if (idleCopies() === 'never' || boardReadOnly(ws)) return
  let folders: { folder: string; project: string }[]
  try {
    folders = recordedFolders(ws)
  } catch (e) {
    log.warn("Could not read Hive's record of its skill copies", e)
    return
  }
  for (const f of folders) {
    if (ws.lifetime.aborted) return
    if (busyIn(f.folder)) continue
    await removeCopiesIn(f.project, f.folder, { why: 'no session works there' }) // i18n-ignore: the log's reason (English)
  }
}

let started = false
const running = new Set<Promise<unknown>>()

/** Starts the clean-up at each workspace's opening; `busy` says whether a session of Hive's runs in a folder. */
export function initSkillCopies(busy: (folder: string) => boolean): void {
  busyIn = busy
  if (started) return
  started = true
  const sweep = (ws: WorkspaceService): void => {
    if (!ws.path) return
    const run = sweepIdleCopies(ws)
      .catch((e) => log.warn("sweeping Hive's idle skill copies", e))
      .finally(() => running.delete(run))
    running.add(run)
  }
  WorkspaceService.openedListeners.add(sweep)
  // Opened while its board waited for the upgrade to 1.0: swept once it is upgraded (#1621).
  onBoardUpgraded(sweep)
}

/** For tests: every sweep under way has finished. */
export const sweepsSettled = (): Promise<unknown> => Promise.all([...running])
