import { randomUUID } from 'crypto'
import { existsSync } from 'original-fs'
import { mkdir, readFile, readdir, rename } from 'original-fs/promises'
import { join, resolve } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import { isTemplateFile, TEMPLATE_VERSION } from '../shared/templates'
import { msg, tr } from '../shared/i18n'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from './boardStore'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

/**
 * 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123: "existing templates are wiped",
 * a clean cut-over). 1.0 never reads them (`readTemplate` refuses a version 1), so the user's saved ones, the workspace's
 * and each project's, are **moved into the 0.9 board backup's folder** (`.hive/backups/templates-0.9`, beside the copy
 * of hive.db the upgrade keeps, OP-37) rather than deleted: Help → Restore the 0.9 Board Backup… puts them back where
 * they were for 0.9.3 (`putBackV09Templates`). Hive's own templates take their place. One quiet notice says so.
 *
 * Once per workspace, after its upgrade (board_meta `templates.v09`, written once the files are moved), at each open
 * until then: safe to repeat (a file already moved is gone from its place, and one put back by Restore is moved again
 * after the next upgrade, whose board has no mark) and in two Hives at once (each file moves in one rename and ends in
 * the backup once, never lost; both may count it, so the notice counts what the backup holds). A file whose version isn't
 * 0.9's (a damaged one, a newer Hive's) is left where it is.
 */

const log = createLogger('templates')

/** board_meta's mark: how many files this Hive set aside (`0`: none), once done. */
const MARK = 'templates.v09'
/** board_meta's notice to say once in the window: `due`, then `said`. */
const NOTICE = 'templates.v09.notice'
/** The folder in `.hive/backups` the files go to: `workspace`, and `projects/<project id>` (ids follow a rename, #508). */
export const V09_TEMPLATES = 'templates-0.9'

const backupDir = (workspacePath: string): string => join(workspacePath, HIVE_DIR, 'backups', V09_TEMPLATES)

/** The template folders to look in, each with where its files go in the backup: the workspace's and each project's. */
async function places(ws: WorkspaceService, workspacePath: string): Promise<{ from: string; to: string }[]> {
  const dir = backupDir(workspacePath)
  const out = [{ from: join(workspacePath, HIVE_DIR, 'templates'), to: join(dir, 'workspace') }]
  const ids = await ws.projectIds()
  for (const p of await ws.listProjectPaths()) {
    const id = ids.byPath.get(resolve(p).toLowerCase())
    if (id) out.push({ from: join(p, HIVE_DIR, 'templates'), to: join(dir, 'projects', id) })
  }
  return out
}

/** Whether a template file is 0.9's: JSON whose version is a whole number under 1.0's. */
async function from09(file: string): Promise<boolean> {
  try {
    const raw = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')) as { version?: unknown }
    return typeof raw?.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1 && raw.version < TEMPLATE_VERSION
  } catch {
    return false
  }
}

/** A name for `file` in `dir` no file has: itself, else numbered ("pair-2.json"), so nothing kept there is replaced. */
function freeName(dir: string, file: string): string {
  if (!existsSync(join(dir, file))) return file
  for (let n = 2; ; n++) {
    const next = file.replace(/\.json$/, `-${n}.json`)
    if (!existsSync(join(dir, next))) return next
  }
}

/** Moves one file (and its kept copy, `.bak`) from one folder to another; false when it was gone (another Hive moved it). */
async function move(from: string, to: string, file: string, as = file): Promise<boolean> {
  try {
    await rename(join(from, file), join(to, as))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
  await rename(join(from, `${file}.bak`), join(to, `${as}.bak`)).catch(() => undefined)
  return true
}

/**
 * Sets 0.9's templates aside, once the workspace's board is upgraded (see the module's note). How many files moved, or
 * null when there was nothing to do (the upgrade waits, or it was done before).
 */
export async function setAsideV09Templates(ws: WorkspaceService): Promise<number | null> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, MARK) !== null) return null
  const life = ws.lifetime
  let moved = 0
  for (const { from, to } of await places(ws, path)) {
    const files = (await readdir(from).catch(() => [] as string[])).filter(isTemplateFile)
    for (const f of files) {
      if (life.aborted) return null
      if (!(await from09(join(from, f)))) continue
      await mkdir(to, { recursive: true })
      if (await move(from, to, f, freeName(to, f))) moved++
    }
  }
  await boardWrite(ws, async () => {
    if (life.aborted || ws.path !== path) return
    setBoardValue(ws, MARK, String(moved))
    if (moved) setBoardValue(ws, NOTICE, 'due')
  })
  if (moved) log.info(`set aside ${moved} template file(s) from 0.9 in ${userText(path)} (${V09_TEMPLATES} in the backups)`)
  return moved
}

/** Says once, quietly, that 0.9's templates were set aside (in the workspace's window). */
export async function sayV09TemplatesOnce(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  const life = ws.lifetime
  if (!path || upgradeWaiting(path) || boardValue(ws, NOTICE) !== 'due') return
  const n = (await setAsideFiles(path)).filter((f) => isTemplateFile(f.split('/').pop())).length
  const title = tr(msg({ id: 'service.templates.v09Title', defaultMessage: 'Your 0.9 agent templates were set aside', description: "A quiet notice's title, once after the upgrade to Hive 1.0: the agent templates saved in 0.9 were moved out of the way (into the 0.9 backup)." }))
  const message = tr(msg({ id: 'service.templates.v09', defaultMessage: "1.0 templates don't pin agents to worktrees. The Hive templates replace them; {n, plural, one {the file is} other {the # files are}} kept with the 0.9 board backup.", description: "A quiet notice once after the upgrade to Hive 1.0: the {n} agent template files saved in 0.9 were moved into the folder of the board's 0.9 backup (Help → Restore the 0.9 Board Backup puts them back). \"The Hive templates\" are Hive's own templates (the Templates view's Hive group)." }), { n })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  void boardWrite(ws, async () => {
    if (!life.aborted && ws.path === path) setBoardValue(ws, NOTICE, 'said')
  }).catch((e) => log.warn('noting the 0.9 templates notice as said', e))
}

/**
 * Help → Restore the 0.9 Board Backup… (#1436): the templates set aside go back where they were, each only where no file
 * of its name is now (a template saved since is never replaced: the set-aside one stays in the backup). How many went
 * back. The restored board has no mark, so the next upgrade sets them aside again.
 */
export async function putBackV09Templates(ws: WorkspaceService): Promise<number> {
  const path = ws.path
  if (!path) return 0
  let back = 0
  for (const { from: home, to: kept } of await places(ws, path)) {
    const files = (await readdir(kept).catch(() => [] as string[])).filter(isTemplateFile)
    for (const f of files) {
      if (existsSync(join(home, f))) continue
      await mkdir(home, { recursive: true })
      if (await move(kept, home, f)) back++
    }
  }
  if (back) log.info(`put ${back} template file(s) from 0.9 back in ${userText(path)}`)
  return back
}

/** For the log and tests: the backup folder's files, by place ("workspace", "projects/<id>"). */
export async function setAsideFiles(workspacePath: string): Promise<string[]> {
  const dir = backupDir(workspacePath)
  const out: string[] = []
  for (const f of await readdir(join(dir, 'workspace')).catch(() => [] as string[])) out.push(`workspace/${f}`)
  for (const id of await readdir(join(dir, 'projects')).catch(() => [] as string[])) for (const f of await readdir(join(dir, 'projects', id)).catch(() => [] as string[])) out.push(`projects/${id}/${f}`)
  return out.sort()
}
