import { randomBytes, randomUUID } from 'crypto'
import { constants } from 'original-fs'
import { copyFile, link, mkdir, readFile, readdir, unlink, writeFile } from 'original-fs/promises'
import { join, resolve } from 'path'
import { CW_DIR } from '../shared/defaults'
import { isTemplateFile, TEMPLATE_VERSION } from '../shared/templates'
import { msg, tr } from '../shared/i18n'
import { boardValue, boardWrite, setBoardValue, upgradeWaiting } from './boardStore'
import { createLogger, userText } from './logger'
import type { WorkspaceService } from './workspace'

/**
 * 0.9's agent templates at the upgrade to 1.0 (#1436; Darren's 19 Oct decision on #1123: "existing templates are wiped",
 * a clean cut-over; the Assistant's scope call of 23 Oct: copy only). 1.0 doesn't use them: the lists skip a version-1
 * file and an import of one is refused (`readTemplate`). The user's saved ones, the workspace's and each project's, are
 * **copied** into the 0.9 board backup's folder (`.combwork/backups/templates-0.9`, beside the copy of hive.db the upgrade
 * keeps, OP-37); the originals are never moved, deleted or rewritten. One quiet notice says so. The upgrade is one-way:
 * nothing puts them back.
 *
 * Once per workspace after its upgrade (board_meta `templates.v09`), at each open until done. Idempotent, with no state
 * of its own to recover: a template whose bytes the backup already has is copied already; a copy is written under a
 * temporary name of its own (never a template's, removed by the copy that made it) and published at the first free name
 * by a link that never replaces a file (a copy that won't overwrite where links can't be made), so a rerun or two runs at
 * once (two Hives) never lose or change anything, never touch each other's temporary files, and copy each template once.
 * A temporary file left by a crash is harmless (no template's name, never listed or read) and left alone. A folder or
 * file that can't be read (other than gone) stops the run unmarked, for the next open.
 */

const log = createLogger('templates')

/** board_meta's mark: how many templates this Hive copied (`0`: none), once every folder was read and copied. */
const MARK = 'templates.v09'
/** board_meta's notice to say once in the window: `due`, then `said`. */
const NOTICE = 'templates.v09.notice'
/** The folder in `.combwork/backups` the copies go to: `workspace`, and `projects/<project id>` (ids follow a rename, #508). */
export const V09_TEMPLATES = 'templates-0.9'
/** Seams for unit tests: a failure where a run reads or writes, and the moment a copy is written but not yet published. */
export const testHooks: { fail?: (op: 'scan' | 'read' | 'write', path: string) => void; beforePublish?: (part: string) => Promise<void> } = {}

const backupDir = (workspacePath: string): string => join(workspacePath, CW_DIR, 'backups', V09_TEMPLATES)
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code

/** The template folders to look in, each with where its copies go in the backup: the workspace's and each project's. */
async function places(ws: WorkspaceService, workspacePath: string): Promise<{ from: string; to: string }[]> {
  const dir = backupDir(workspacePath)
  const out = [{ from: join(workspacePath, CW_DIR, 'templates'), to: join(dir, 'workspace') }]
  const ids = await ws.projectIds()
  for (const p of await ws.listProjectPaths()) {
    const id = ids.byPath.get(resolve(p).toLowerCase())
    if (id) out.push({ from: join(p, CW_DIR, 'templates'), to: join(dir, 'projects', id) })
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

/** A file's bytes; null when it is gone. Any other failure throws. */
async function bytesOf(file: string): Promise<Buffer | null> {
  testHooks.fail?.('read', file)
  try {
    return await readFile(file)
  } catch (e) {
    if (code(e) === 'ENOENT') return null
    throw e
  }
}

/** Whether a template file's text is 0.9's: JSON whose version is a whole number under 1.0's. */
export function isV09Template(text: string): boolean {
  try {
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { version?: unknown }
    return typeof raw?.version === 'number' && Number.isInteger(raw.version) && raw.version >= 1 && raw.version < TEMPLATE_VERSION
  } catch {
    return false
  }
}

/** A name for `file` in `dir`'s listing: itself, else numbered ("pair-2.json"). */
const nameFor = (file: string, n: number): string => (n === 1 ? file : file.replace(/\.json$/, `-${n}.json`))

/** Publishes `src` at `dest` without ever replacing a file there: false when one is there. */
async function publishNew(src: string, dest: string): Promise<boolean> {
  try {
    await link(src, dest)
    return true
  } catch (e) {
    if (code(e) === 'EEXIST') return false
    if (code(e) !== 'EXDEV' && code(e) !== 'EPERM' && code(e) !== 'ENOTSUP') throw e
  }
  try {
    await copyFile(src, dest, constants.COPYFILE_EXCL)
    return true
  } catch (e) {
    if (code(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * Copies one 0.9 template into `to`, unless the backup has its bytes already (under any name, a numbered one too).
 * True when this run made a copy.
 */
async function copyOne(bytes: Buffer, to: string, f: string): Promise<boolean> {
  const stem = f.replace(/\.json$/, '')
  const mine = (n: string): boolean => n === f || (n.startsWith(`${stem}-`) && /^\d+\.json$/.test(n.slice(stem.length + 1)))
  for (let n = 1; n < 1000; n++) {
    const name = nameFor(f, n)
    const there = await bytesOf(join(to, name))
    if (there?.equals(bytes)) return false
    if (there) continue
    // Copied already under a later number (a name freed since): still once.
    for (const other of (await filesIn(to)).filter(mine)) if ((await bytesOf(join(to, other)))?.equals(bytes)) return false
    testHooks.fail?.('write', join(to, name))
    const part = join(to, `.${name}.${randomBytes(6).toString('hex')}.part`)
    try {
      await writeFile(part, bytes, { flag: 'wx' })
      await testHooks.beforePublish?.(part)
      if (await publishNew(part, join(to, name))) return true
    } finally {
      await unlink(part).catch(() => undefined)
    }
  }
  throw new Error(`no free name for ${f} in the 0.9 templates' backup`) // i18n-ignore: a failure for the log (tried again at the next open)
}

/**
 * Copies 0.9's templates, once the workspace's board is upgraded (see the module's note). How many this run copied, or
 * null when there was nothing to do (the upgrade waits, or it was done before). Throws when a folder or file can't be
 * read or a copy can't be written: nothing is marked, and the next open goes on.
 */
export async function copyV09Templates(ws: WorkspaceService): Promise<number | null> {
  const path = ws.path
  if (!path || upgradeWaiting(path) || boardValue(ws, MARK) !== null) return null
  const life = ws.lifetime
  let copied = 0
  for (const { from, to } of await places(ws, path)) {
    for (const f of (await filesIn(from)).filter(isTemplateFile)) {
      if (life.aborted) return null
      const bytes = await bytesOf(join(from, f))
      if (!bytes || !isV09Template(bytes.toString('utf8'))) continue
      await mkdir(to, { recursive: true })
      if (await copyOne(bytes, to, f)) copied++
    }
  }
  await boardWrite(ws, async () => {
    if (life.aborted || ws.path !== path) return
    setBoardValue(ws, MARK, String(copied))
    if (copied) setBoardValue(ws, NOTICE, 'due')
  })
  if (copied) log.info(`copied ${copied} template file(s) from 0.9 in ${userText(path)} into ${V09_TEMPLATES} in the backups`)
  return copied
}

/** Says once, quietly, that 0.9's templates aren't used and a copy is kept (in the workspace's window). */
export async function sayV09TemplatesOnce(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  const life = ws.lifetime
  if (!path || upgradeWaiting(path) || boardValue(ws, NOTICE) !== 'due') return
  const n = (await backupFiles(path)).filter((f) => isTemplateFile(f.split('/').pop())).length
  const title = tr(msg({ id: 'service.templates.v09Title', defaultMessage: 'Your 0.9 agent templates aren’t used in 1.0', description: "A quiet notice's title, once after the upgrade to Hive 1.0: the agent templates saved in 0.9 aren't listed or loaded any more (a copy is kept)." }))
  const message = tr(msg({ id: 'service.templates.v09', defaultMessage: '1.0 templates don’t pin agents to worktrees, so the Combwork templates take their place. A copy of {n, plural, one {the template} other {the # templates}} is kept with the 0.9 board backup.', description: "A quiet notice once after the upgrade to Hive 1.0: the {n} agent templates saved in 0.9 aren't used; a copy of each was put in the folder of the board's 0.9 backup. \"The Combwork templates\" are Combwork's own templates (the Templates view's Combwork group)." }), { n })
  ws.emit({ type: 'toast', toast: { id: randomUUID(), level: 'info', title, message, timestamp: new Date().toISOString(), quiet: true } })
  void boardWrite(ws, async () => {
    if (!life.aborted && ws.path === path) setBoardValue(ws, NOTICE, 'said')
  }).catch((e) => log.warn('noting the 0.9 templates notice as said', e))
}

/** For the log and tests: the backup folder's files, by place ("workspace", "projects/<id>"). */
export async function backupFiles(workspacePath: string): Promise<string[]> {
  const dir = backupDir(workspacePath)
  const out: string[] = []
  for (const f of await readdir(join(dir, 'workspace')).catch(() => [] as string[])) out.push(`workspace/${f}`)
  for (const id of await readdir(join(dir, 'projects')).catch(() => [] as string[])) for (const f of await readdir(join(dir, 'projects', id)).catch(() => [] as string[])) out.push(`projects/${id}/${f}`)
  return out.sort()
}
