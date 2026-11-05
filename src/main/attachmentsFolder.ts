// A session host's attachments folder (#387), `.combwork/attachments`, and the move of the folder it replaces, `.combwork/images`.
// Attachments stay inside the host (decision 4): nothing is written or moved through a junction or symbolic link, at the
// folder, its session folders or any folder above them.
import { lstat, mkdir, readdir, readFile, rename, rmdir } from 'original-fs/promises'
import { extname, join, relative, sep } from 'path'
import { ATTACHMENTS_DIR, OLD_ATTACHMENTS_DIR, isSessionFolder, movedAttachmentPath } from '../shared/attachments'
import { HIVE_DIR } from '../shared/defaults'
import { insideReal, writeJsonAtomic } from './fsutil'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'

const log = createLogger('attachments')

/**
 * In the attachments folder: the files the move renamed because their name was taken, by their old path in the old
 * folder (`<session>/<name>`, forward slashes) to their name now. Old links lead to them, not to the file that kept the
 * name.
 */
const MOVED_FILE = '.moved.json'

/** Each host's move, once a run: every use of the folder waits for it, so nothing is saved or listed half-way. */
const moves = new Map<string, Promise<void>>()

/**
 * The host's attachments folder, `<host>\.combwork\attachments` (it may not exist yet), after moving what its old
 * `.combwork\images` folder holds into it. A move that fails part-way (a file another program has open) leaves the rest in
 * the old folder for the next run.
 */
export async function attachmentsDir(host: string): Promise<string> {
  const key = host.toLowerCase()
  let move = moves.get(key)
  if (!move) {
    move = moveOldFolder(host).catch((e) => log.warn(`Could not move the images folder of ${userText(host)} to attachments`, e))
    moves.set(key, move)
  }
  await move
  return join(host, HIVE_DIR, ATTACHMENTS_DIR)
}

/** Tests only: forgets which hosts were moved, so a test can move one again (as a restart would). */
export function forgetMoves(): void {
  moves.clear()
}

/** A folder Hive may keep attachments in: a real folder (not a link), really inside the host. */
async function isOwnFolder(host: string, p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return !!st && !st.isSymbolicLink() && st.isDirectory() && insideReal(p, [host])
}

/** A session folder's name: a session id, or run-<launch> (no separators, never "." or ".."). */
const SESSION_FOLDER = /^(?!\.{1,2}$)[\w.-]+$/

/**
 * The host's attachments folder, or a session folder in it, made where missing, after checking that it and every folder
 * from the host down to it (`.combwork`, `attachments`, the session's) is a real folder of the host's own: never a junction
 * or symbolic link, never really outside the host. Throws otherwise, so nothing is written through one.
 */
export async function ownAttachmentsFolder(host: string, sessionFolder?: string): Promise<string> {
  if (sessionFolder !== undefined && !SESSION_FOLDER.test(sessionFolder)) throw hiveError(msg({ id: 'service.attachments.badFolder', defaultMessage: 'Not a session folder name.', description: "An error: a name given for a session's attachments folder isn't one Hive makes (a session id)." }), undefined, { kind: 'invalid' })
  const root = await attachmentsDir(host)
  const chain = [join(host, HIVE_DIR), root, ...(sessionFolder !== undefined ? [join(root, sessionFolder)] : [])]
  for (const p of chain) {
    if (!(await lstat(p).catch(() => null))) await mkdir(p).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)))
    if (!(await isOwnFolder(host, p))) {
      log.warn(`${userText(p)} is a link or not a folder: no attachments are kept through it`)
      throw hiveError(msg({ id: 'service.attachments.notOwn', defaultMessage: "{folder} is a link or not a folder of the project's own, so Combwork keeps no attachments in it.", description: "An error keeping a pasted or dropped file for a session: its folder {folder} (in the project's .combwork) is a link or leads elsewhere, so Hive writes nothing through it." }), { folder: p })
    }
  }
  return chain[chain.length - 1]
}

/**
 * An attachment's name in its folder: the time it came, then the file's own name (a clipboard image has none), so they
 * list in the order they came and an agent sees what each is. Characters Windows refuses, and control characters,
 * become "_"; a long name keeps its end (the extension).
 */
export function attachmentName(name: string | null, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  const own = name ? name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(-100) : ''
  const ext = own ? extname(own) : '.png'
  const base = own ? `${stamp}_${own.slice(0, own.length - ext.length)}` : stamp
  return `${base}${ext}`
}

/** A name free in a folder: taken means anything there, a link (even a broken one) included. */
export async function freeName(dir: string, name: string, suffix: (i: number) => string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let target = join(dir, name)
  for (let i = 1; await lstat(target).then(() => true, () => false); i++) target = join(dir, `${stem}${suffix(i)}${ext}`)
  return target
}

/**
 * Moves `.combwork\images` to `.combwork\attachments`: renamed whole when there is no attachments folder yet, else file by file
 * into the session folders of the same names (a name already taken gets " (moved)", recorded in MOVED_FILE). Only real
 * folders and files of the host's own move, into real folders of its own: a link, at either end or above, stays where
 * it is with what it holds.
 */
async function moveOldFolder(host: string): Promise<void> {
  const hive = join(host, HIVE_DIR)
  const old = join(hive, OLD_ATTACHMENTS_DIR)
  if (!(await lstat(old).catch(() => null))) return
  if (!(await isOwnFolder(host, hive)) || !(await isOwnFolder(host, old))) return log.warn(`${userText(old)} is a link or not a folder: Combwork leaves it alone`)
  const dest = join(hive, ATTACHMENTS_DIR)
  const there = await lstat(dest).catch(() => null)
  if (there && !(await isOwnFolder(host, dest))) return log.warn(`${userText(dest)} is a link or not a folder: the images folder stays`)
  if (!there) {
    try {
      // A link inside moves as the link it is: what it leads to stays where it is.
      await rename(old, dest)
      log.info(`Moved ${userText(old)} to ${ATTACHMENTS_DIR}`)
      return
    } catch (e) {
      // Something in it is open: move what can be moved, file by file.
      log.warn(`Could not rename ${userText(old)}; moving its files one by one`, e)
    }
  }
  let moved = 0
  let left = 0
  for (const d of await readdir(old)) {
    const from = join(old, d)
    const to = join(dest, d)
    if (!SESSION_FOLDER.test(d) || !isSessionFolder(d) || !(await isOwnFolder(host, from))) {
      left++
      continue
    }
    if (!(await lstat(to).catch(() => null))) await mkdir(to).catch(() => undefined)
    if (!(await isOwnFolder(host, to))) {
      log.warn(`${userText(to)} is a link or not a folder: ${userText(from)} stays`)
      left++
      continue
    }
    for (const f of await readdir(from)) {
      const st = await lstat(join(from, f)).catch(() => null)
      if (!st || st.isSymbolicLink() || !st.isFile()) {
        left++
        continue
      }
      const target = await freeName(to, f, (i) => ` (moved${i > 1 ? ` ${i}` : ''})`)
      try {
        // A renamed file's new name is on disk before it moves: if recording it fails, it stays at its old path (where
        // old links find it first); if the move then fails or Hive stops, the record is unused while the old path is.
        if (target !== join(to, f)) await recordRenamed(dest, `${d}/${f}`, `${d}/${target.slice(to.length + 1)}`)
        await rename(join(from, f), target)
        moved++
      } catch (e) {
        left++
        log.warn(`Could not move ${userText(f)} to ${ATTACHMENTS_DIR}`, e)
      }
    }
    await rmdir(from).catch(() => undefined)
  }
  await rmdir(old).catch(() => undefined)
  log.info(`Moved ${moved} file(s) of ${userText(old)} to ${ATTACHMENTS_DIR}${left ? `; ${left} left there` : ''}`)
}

/** The renamed files' record, for resolving old links: empty when there is none or it can't be read. */
async function readMoved(root: string): Promise<Record<string, string>> {
  try {
    const v = JSON.parse(await readFile(join(root, MOVED_FILE), 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * Adds one renamed file to the record, keeping every entry already there. Throws when the record is there but can't be
 * read as one (damaged, or not a file): it is never replaced by a record that has lost what it held.
 */
async function recordRenamed(root: string, from: string, to: string): Promise<void> {
  const path = join(root, MOVED_FILE)
  let map: Record<string, string> = {}
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw hiveError(msg({ id: 'service.attachments.badRecord', defaultMessage: '{file} is not a record of moved files', description: "An error: the file {file} where Hive records attachments it renamed can't be read as one (damaged)." }), { file: MOVED_FILE })
    map = v as Record<string, string>
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await writeJsonAtomic(path, { ...map, [from]: to })
}

/**
 * Where a path into a host's old `.combwork\images` leads now: the file the move put in `.combwork\attachments`, under its new
 * name when the move had to rename it. Null for a path not in an old folder. The old path itself, while it is still
 * there, is the caller's to try first.
 */
export async function movedAttachment(oldPath: string): Promise<string | null> {
  const plain = movedAttachmentPath(oldPath)
  if (!plain) return null
  const m = /[\\/]\.combwork[\\/]attachments[\\/]/i.exec(plain)!
  const root = plain.slice(0, m.index + m[0].length - 1)
  const rel = relative(root, plain).split(sep).join('/')
  const map = await readMoved(root)
  // Windows names ignore case, as the old link may.
  const key = Object.keys(map).find((k) => k.toLowerCase() === rel.toLowerCase())
  const renamed = key ? map[key] : undefined
  // Only a file of a session folder of the same root, whatever the file says.
  const parts = typeof renamed === 'string' ? renamed.split('/') : []
  const ok = parts.length === 2 && SESSION_FOLDER.test(parts[0]) && !/[\\:]/.test(parts[1]) && parts[1] !== '.' && parts[1] !== '..'
  return ok ? join(root, ...parts) : plain
}
