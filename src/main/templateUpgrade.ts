import { randomUUID } from 'crypto'
import { constants, existsSync } from 'original-fs'
import { copyFile, link, mkdir, readFile, readdir, unlink } from 'original-fs/promises'
import { join, resolve } from 'path'
import { HIVE_DIR } from '../shared/defaults'
import { isTemplateFile, TEMPLATE_VERSION } from '../shared/templates'
import { msg, tr } from '../shared/i18n'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from './boardStore'
import { createLogger, userText } from './logger'
import { withTemplatesLock } from './templates'
import type { WorkspaceService } from './workspace'

/**
 * 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123: "existing templates are wiped",
 * a clean cut-over). 1.0 never reads them (`readTemplate` refuses a version 1), so the user's saved ones, the workspace's
 * and each project's, are **moved into the 0.9 board backup's folder** (`.hive/backups/templates-0.9`, beside the copy
 * of hive.db the upgrade keeps, OP-37) rather than deleted: Help → Restore the 0.9 Board Backup… puts them back where
 * they were for 0.9.3 (`putBackV09Templates`). Hive's own templates take their place. One quiet notice says so.
 *
 * Once per workspace, after its upgrade (board_meta `templates.v09`), at each open until done. Done means every scan,
 * read and move succeeded: a folder or file that can't be read (other than gone) or a move that fails stops the run
 * without the mark, and the next open goes on from what is left (a kept copy, `.bak`, left behind by a move cut short
 * follows its template then). Safe to repeat (a file already moved is gone from its place, and one put back by Restore
 * is moved again after the next upgrade, whose board has no mark) and in two Hives at once: a file is published in its
 * new place by a hard link, which no process can make over a file already there, and only then unlinked from its old
 * one (`publish`), so nothing is ever replaced and each file ends in one place; the notice counts what the backup holds.
 * In this process each folder's move holds the templates' own lock, so no save there runs meanwhile. A file whose
 * version isn't 0.9's (a damaged one, a newer Hive's) is left where it is.
 */

const log = createLogger('templates')

/** board_meta's mark: how many files this Hive set aside (`0`: none), once every one is done. */
const MARK = 'templates.v09'
/** board_meta's notice to say once in the window: `due`, then `said`. */
const NOTICE = 'templates.v09.notice'
/** The folder in `.hive/backups` the files go to: `workspace`, and `projects/<project id>` (ids follow a rename, #508). */
export const V09_TEMPLATES = 'templates-0.9'

/** Seams for unit tests: a failure where a run reads or moves, and a moment just before a file is published. */
export const testHooks: {
  fail?: (op: 'scan' | 'read' | 'move', path: string) => void
  beforePublish?: (dest: string) => Promise<void>
} = {}

const backupDir = (workspacePath: string): string => join(workspacePath, HIVE_DIR, 'backups', V09_TEMPLATES)
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code

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

/** A folder's files; none when it isn't there. Any other failure throws (the run stops, unmarked, to go on later). */
async function filesIn(dir: string): Promise<string[]> {
  testHooks.fail?.('scan', dir)
  try {
    return await readdir(dir)
  } catch (e) {
    if (code(e) === 'ENOENT') return []
    throw e
  }
}

/**
 * Whether a template file is 0.9's: JSON whose version is a whole number under 1.0's. Not JSON, or another version: no.
 * Gone (another Hive moved it): no. A file that can't be read throws.
 */
async function from09(file: string): Promise<boolean> {
  testHooks.fail?.('read', file)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if (code(e) === 'ENOENT') return false
    throw e
  }
  try {
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { version?: unknown }
    return typeof raw?.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1 && raw.version < TEMPLATE_VERSION
  } catch {
    return false
  }
}

/**
 * Moves `src` to `dest` without ever replacing a file at `dest`, in any process: published by a hard link (refused when
 * `dest` is taken) or, on a volume without them, a copy that won't overwrite; then unlinked from `src`. `taken`: a file
 * is at `dest` (nothing changed); `gone`: `src` isn't there, or another Hive moved it meanwhile (then the second place
 * made here goes again, so the file is in one place).
 */
async function publish(src: string, dest: string): Promise<'moved' | 'taken' | 'gone'> {
  testHooks.fail?.('move', src)
  await testHooks.beforePublish?.(dest)
  try {
    await link(src, dest)
  } catch (e) {
    if (code(e) === 'EEXIST') return 'taken'
    if (code(e) === 'ENOENT') return 'gone'
    if (code(e) !== 'EXDEV' && code(e) !== 'EPERM' && code(e) !== 'ENOTSUP') throw e
    try {
      await copyFile(src, dest, constants.COPYFILE_EXCL)
    } catch (e2) {
      if (code(e2) === 'EEXIST') return 'taken'
      if (code(e2) === 'ENOENT') return 'gone'
      throw e2
    }
  }
  try {
    await unlink(src)
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e
    await unlink(dest).catch(() => undefined)
    return 'gone'
  }
  return 'moved'
}

/** The name a template takes in the backup: its own, else numbered ("pair-2.json"), with its `.bak` free too. */
function freeName(dir: string, file: string, n = 1): string {
  const name = n === 1 ? file : file.replace(/\.json$/, `-${n}.json`)
  return existsSync(join(dir, name)) || existsSync(join(dir, `${name}.bak`)) ? freeName(dir, file, n + 1) : name
}

/** Moves one 0.9 template into the backup under a free name, then its kept copy; true when this run moved it. */
async function setAsideOne(from: string, to: string, f: string): Promise<boolean> {
  for (let tries = 0; tries < 50; tries++) {
    const as = freeName(to, f)
    const r = await publish(join(from, f), join(to, as))
    if (r === 'taken') continue
    if (r === 'gone') return false
    // Its kept copy follows it; one that can't move stops the run, to follow it at the next open.
    if ((await publish(join(from, `${f}.bak`), join(to, `${as}.bak`))) === 'taken') await publish(join(from, `${f}.bak`), join(to, `${freeName(to, as)}.bak`))
    return true
  }
  throw new Error(`no free name for ${f} in the 0.9 templates' backup`) // i18n-ignore: a failure for the log (tried again at the next open)
}

/**
 * Sets 0.9's templates aside, once the workspace's board is upgraded (see the module's note). How many files this run
 * moved, or null when there was nothing to do (the upgrade waits, or it was done before). Throws when a folder, file or
 * move fails: nothing is marked, and the next open goes on.
 */
export async function setAsideV09Templates(ws: WorkspaceService): Promise<number | null> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, MARK) !== null) return null
  const life = ws.lifetime
  let moved = 0
  for (const { from, to } of await places(ws, path)) {
    const done = await withTemplatesLock(from, async () => {
      const here = await filesIn(from)
      let n = 0
      for (const f of here.filter(isTemplateFile)) {
        if (life.aborted) return null
        if (!(await from09(join(from, f)))) continue
        await mkdir(to, { recursive: true })
        if (await setAsideOne(from, to, f)) n++
      }
      // A kept copy whose template a run cut short already moved: it follows now.
      for (const bak of here.filter((x) => x.endsWith('.json.bak') && isTemplateFile(x.slice(0, -4)))) {
        const f = bak.slice(0, -4)
        if (!existsSync(join(from, f)) && existsSync(join(to, f))) await publish(join(from, bak), join(to, existsSync(join(to, bak)) ? `${freeName(to, f)}.bak` : bak))
      }
      return n
    })
    if (done === null) return null
    moved += done
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
 * Help → Restore the 0.9 Board Backup… (#1436): the templates set aside go back where they were, each published only
 * where no file of its name is (`publish`: never over a template saved since, in this or another process, which keeps
 * the set-aside one in the backup), under the templates' lock in this process. How many went back. The restored board
 * has no mark, so the next upgrade sets them aside again.
 */
export async function putBackV09Templates(ws: WorkspaceService): Promise<number> {
  const path = ws.path
  if (!path) return 0
  let back = 0
  for (const { from: home, to: kept } of await places(ws, path)) {
    back += await withTemplatesLock(home, async () => {
      let n = 0
      for (const f of (await filesIn(kept)).filter(isTemplateFile)) {
        await mkdir(home, { recursive: true })
        if ((await publish(join(kept, f), join(home, f))) !== 'moved') continue
        n++
        // Its kept copy too, where none is (else it stays in the backup).
        await publish(join(kept, `${f}.bak`), join(home, `${f}.bak`))
      }
      return n
    })
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
