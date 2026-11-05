import { watch, existsSync, type FSWatcher } from 'original-fs'
import { cp, lstat, mkdir, readdir, readFile, rename, rmdir, stat, writeFile } from 'original-fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { HIVE_DIR, assertSessionId } from '../shared/defaults'
import type { AttachmentContent, FileContent, FileEntry, SessionAttachment, SessionAttachmentGroup } from '../shared/types'
import { attachmentKind, isSessionFolder } from '../shared/attachments'
import { attachmentsDir, movedAttachment } from './attachmentsFolder'
import { emit } from './events'
import { heldOpen, insideReal, isInUse, trashAllOrNothing, withFileLock } from './fsutil'
import { INDEX_BUSY, git } from './git'
import { msg } from '../shared/i18n'
import { hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { sessions } from './sessions'
import { workspace, workspaceFor } from './workspace'
import { trash as toTrash } from './trash'
import { followMovedLink } from './combworkMove'

const log = createLogger('files')

const HIDDEN = new Set(['.git'])
/** Files the hive-img: protocol may serve to the renderer (image and PDF previews). */
export const SERVABLE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf)$/i
const SERVABLE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf' }
/** The content type hive-img: serves a servable file as. */
export const servableType = (p: string): string => SERVABLE_TYPES[p.slice(p.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'

const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/')

/** The Files and Attachments tabs' refusals, in the window's language (#850): only the window reads them. */
const M = {
  outside: msg({ id: 'service.files.outside', defaultMessage: 'Path is outside the project', description: "An error in the Files tab: a file's path leads out of the project." }),
  exists: msg({ id: 'service.files.exists', defaultMessage: '"{name}" already exists', description: 'An error making or renaming a file or folder in the Files tab: one called {name} is already there.' }),
  notKept: msg({ id: 'service.files.notKept', defaultMessage: 'Not one of the session attachments Combwork keeps.', description: "An error deleting a session's attachment (a file pasted or dropped into a session): it isn't one Hive keeps, or it is a link." }),
  inUse: msg({ id: 'service.files.inUse', defaultMessage: 'Another program has this file open. Close it, then try again.', description: "An error deleting a session's attachment: another program has the file open, so Windows won't move it." })
}

/**
 * Resolves a project-relative path, refusing anything outside the project. '' is the project root.
 * A link (symlink or junction) inside the project can't lead outside it: reading or writing through
 * one is refused. With `entry`, the path is the entry itself (renaming, moving, copying or deleting a
 * link acts on the link), so only the folder holding it must really be inside the project.
 */
function inProject(projectPath: string, rel: string, allowRoot = false, entry = false): string {
  const root = resolve(projectPath)
  const abs = resolve(root, rel || '.')
  if (abs === root) {
    if (allowRoot) return abs
    throw hiveError(msg({ id: 'service.files.needsEntry', defaultMessage: 'This action needs a file or folder inside the project', description: "An error in the Files tab: the action (rename, move, delete…) was given the project's own folder, not something in it." }))
  }
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + sep)) throw hiveError(M.outside)
  if (!insideReal(entry ? dirname(abs) : abs, [root])) throw hiveError(msg({ id: 'service.files.throughLink', defaultMessage: 'Path leads outside the project (through a link)', description: "An error in the Files tab: a file's path goes through a link (a symbolic link or junction) to somewhere outside the project." }))
  return abs
}

function validName(name: string): string {
  const n = name.trim()
  if (!n || n === '.' || n === '..' || /[\\/:*?"<>|]/.test(n)) throw hiveError(msg({ id: 'service.files.badName', defaultMessage: '"{name}" is not a valid name', description: "An error making or renaming a file or folder: {name} is empty, . or .., or has a character Windows can't have in a name." }), { name })
  return n
}

/** "name.ext", "name copy.ext", "name copy 2.ext", … — the first that does not exist in dir. */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  for (let i = 1; ; i++) {
    const candidate = `${stem} copy${i > 1 ? ` ${i}` : ''}${ext && ext !== name ? ext : ''}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
}

/** check-ignore's tries when git can't open or read the index (another git command is rewriting it), and the pause. */
export const IGNORE_TRIES = 4
const IGNORE_RETRY_MS = 50
const NOT_A_REPO = /not a git repository/i

/**
 * The entries git ignores, or null when git couldn't say (#222). check-ignore exits 0 (some ignored) or 1 (none); a
 * failure (128) used to read as "none ignored", so a listing made while another git command rewrote the index (a
 * user's `git add`, an agent's commit) showed ignored folders undimmed. A busy index is tried again briefly; outside
 * a repository nothing is ignored.
 */
async function ignoredSet(projectPath: string, rels: string[]): Promise<Set<string> | null> {
  const out = new Set<string>()
  // Chunked to stay under the Windows command-line limit.
  for (let i = 0; i < rels.length; i += 200) {
    // -z needs --stdin, which the helper does not support, so read one path per line.
    const args = ['check-ignore', '--', ...rels.slice(i, i + 200)]
    let r = await git(projectPath, args)
    for (let t = 1; t < IGNORE_TRIES && r.code !== 0 && r.code !== 1 && INDEX_BUSY.test(r.err); t++) {
      await new Promise((res) => setTimeout(res, IGNORE_RETRY_MS))
      r = await git(projectPath, args)
    }
    if (r.code !== 0 && r.code !== 1) {
      if (NOT_A_REPO.test(r.err)) return new Set()
      ignoreFailed(projectPath, r.err)
      return null
    }
    for (const p of r.out.split(/\r?\n/)) if (p) out.add(p.replace(/\/$/, ''))
  }
  return out
}

/** Projects whose check-ignore failure has been logged (once each). */
const loggedIgnore = new Set<string>()
function ignoreFailed(projectPath: string, err: string): void {
  const key = projectPath.toLowerCase()
  if (loggedIgnore.has(key) || loggedIgnore.size >= 100) return
  loggedIgnore.add(key)
  log.warn(`git check-ignore failed in ${userText(projectPath)}; showing the last known ignored state and listing again: ${userText(err.slice(0, 200))}`)
}

/**
 * The ignored entries of the folders listed last (a bounded memory: the most recently listed 500), kept for a listing
 * whose check-ignore failed: it shows them as they were rather than undimmed, and the folder is listed again shortly
 * (at most RELIST_MAX times in a row while it keeps failing).
 */
const lastIgnored = new Map<string, Set<string>>()
const LAST_IGNORED_MAX = 500
/** Folders whose listing failed to check what is ignored: a re-list pending, and how many in a row so far. */
const relists = new Map<string, { pending: boolean; count: number }>()
export const RELIST_MAX = 3
const RELIST_MS = 500

function rememberIgnored(key: string, ignored: Set<string>): void {
  relists.delete(key)
  lastIgnored.delete(key)
  lastIgnored.set(key, ignored)
  if (lastIgnored.size > LAST_IGNORED_MAX) lastIgnored.delete(lastIgnored.keys().next().value!)
}

function relistLater(projectPath: string, rel: string, key: string): void {
  const r = relists.get(key) ?? { pending: false, count: 0 }
  if (r.pending || r.count >= RELIST_MAX || (!relists.has(key) && relists.size >= LAST_IGNORED_MAX)) return
  relists.set(key, { pending: true, count: r.count + 1 })
  setTimeout(() => {
    const now = relists.get(key)
    if (!now?.pending) return
    now.pending = false
    emit({ type: 'files-changed', projectPath, dirs: [rel] })
  }, RELIST_MS).unref?.()
}

export async function listDir(projectPath: string, rel: string): Promise<FileEntry[]> {
  projectPath = workspace.assertRoot(projectPath)
  const dir = inProject(projectPath, rel, true)
  const entries = await readdir(dir, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue
    const abs = join(dir, e.name)
    const s = await stat(abs).catch(() => null)
    if (!s) continue
    out.push({ name: e.name, relPath: toRel(projectPath, abs), isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString(), ignored: false })
  }
  const key = `${projectPath.toLowerCase()}\0${toRel(projectPath, dir)}`
  let ignored = await ignoredSet(
    projectPath,
    out.map((f) => (f.isDir ? `${f.relPath}/` : f.relPath))
  )
  if (ignored) rememberIgnored(key, ignored)
  else {
    // Git couldn't say: as last known (nothing for a folder not listed before), and listed again shortly.
    ignored = lastIgnored.get(key) ?? new Set()
    relistLater(projectPath, toRel(projectPath, dir), key)
  }
  for (const f of out) f.ignored = ignored.has(f.relPath) || f.relPath === HIVE_DIR || f.relPath.startsWith(`${HIVE_DIR}/`)
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.isDir ? -1 : 1))
}

export async function create(projectPath: string, parentRel: string, name: string, isDir: boolean): Promise<string> {
  projectPath = workspace.assertRoot(projectPath)
  const parent = inProject(projectPath, parentRel, true)
  // Allow "sub/dir/file.txt" to create intermediate folders, like VS Code.
  const parts = name.split(/[\\/]/).filter(Boolean).map(validName)
  if (!parts.length) throw hiveError(msg({ id: 'service.files.nameRequired', defaultMessage: 'A name is required', description: 'An error making a file or folder with no name.' }))
  const abs = inProject(projectPath, toRel(projectPath, join(parent, ...parts)))
  if (existsSync(abs)) throw hiveError(M.exists, { name: parts.join('/') })
  if (isDir) await mkdir(abs, { recursive: true })
  else {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, '', { flag: 'wx' })
  }
  return toRel(projectPath, abs)
}

export async function renameEntry(projectPath: string, rel: string, newName: string): Promise<string> {
  projectPath = workspace.assertRoot(projectPath)
  const abs = inProject(projectPath, rel, false, true)
  const dest = join(dirname(abs), validName(newName))
  if (dest === abs) return rel
  // A case-only rename on Windows is the same file, so existsSync would be true.
  if (existsSync(dest) && dest.toLowerCase() !== abs.toLowerCase()) throw hiveError(M.exists, { name: newName })
  await rename(abs, dest)
  return toRel(projectPath, dest)
}

function assertNotInside(src: string, destDir: string): void {
  const s = src.toLowerCase()
  const d = destDir.toLowerCase()
  if (d === s || d.startsWith(s + sep)) throw hiveError(msg({ id: 'service.files.insideItself', defaultMessage: 'Cannot put "{name}" inside itself', description: 'An error moving a folder ({name}) into itself, or into a folder inside it.' }), { name: basename(src) })
}

/** Moves entries into destRel. Returns their new relative paths. */
export async function move(projectPath: string, rels: string[], destRel: string): Promise<string[]> {
  projectPath = workspace.assertRoot(projectPath)
  const destDir = inProject(projectPath, destRel, true)
  // Every entry is checked before any moves, so a name taken in the destination moves nothing at all
  // (the renderer moves unsaved edits along only when the whole move worked).
  const plan: { src: string; dest: string | null; rel: string }[] = []
  const taken = new Set<string>()
  for (const rel of rels) {
    const src = inProject(projectPath, rel, false, true)
    if (dirname(src).toLowerCase() === destDir.toLowerCase()) {
      plan.push({ src, dest: null, rel })
      continue
    }
    assertNotInside(src, destDir)
    const dest = join(destDir, basename(src))
    if (existsSync(dest) || taken.has(dest.toLowerCase())) throw hiveError(msg({ id: 'service.files.existsIn', defaultMessage: '{root, select, yes {"{name}" already exists in the project root} other {"{name}" already exists in {folder}}}', description: 'An error moving files: the folder they go to already has one called {name}. {root} is yes when that folder is the project\'s own (its root), else {folder} is its path in the project.' }), { name: basename(src), root: destRel ? 'no' : 'yes', folder: destRel })
    taken.add(dest.toLowerCase())
    plan.push({ src, dest, rel })
  }
  const out: string[] = []
  for (const p of plan) {
    if (p.dest) await rename(p.src, p.dest)
    out.push(p.dest ? toRel(projectPath, p.dest) : p.rel)
  }
  return out
}

/** Copies entries into destRel (also used for Duplicate). Name clashes get a " copy" suffix. */
export async function copy(projectPath: string, rels: string[], destRel: string): Promise<string[]> {
  projectPath = workspace.assertRoot(projectPath)
  return copyInto(projectPath, rels.map((r) => inProject(projectPath, r, false, true)), inProject(projectPath, destRel, true))
}

/** Copies files from anywhere (e.g. dropped from Explorer) into destRel. */
export async function importPaths(projectPath: string, sources: string[], destRel: string): Promise<string[]> {
  projectPath = workspace.assertRoot(projectPath)
  return copyInto(projectPath, sources.map((s) => resolve(s)), inProject(projectPath, destRel, true))
}

async function copyInto(projectPath: string, sources: string[], destDir: string): Promise<string[]> {
  const out: string[] = []
  for (const src of sources) {
    assertNotInside(src, destDir)
    const dest = join(destDir, uniqueName(destDir, basename(src)))
    await cp(src, dest, { recursive: true, errorOnExist: true, force: false })
    out.push(toRel(projectPath, dest))
  }
  return out
}

/** Moves entries to the Recycle Bin. */
export async function trash(projectPath: string, rels: string[]): Promise<void> {
  projectPath = workspace.assertRoot(projectPath)
  for (const rel of rels) await toTrash(inProject(projectPath, rel, false, true))
}

/** Absolute path of a project entry, for opening, revealing and pasting into the terminal. */
export function absPath(projectPath: string, rel: string): string {
  return inProject(workspace.assertRoot(projectPath), rel, true, true)
}

/** A path inside the project as it is spelled on disk (Windows ignores case; the Files tree doesn't). */
async function spelledOnDisk(projectPath: string, rel: string): Promise<string> {
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.')
  let dir = resolve(projectPath)
  const out: string[] = []
  for (const part of parts) {
    const names = await readdir(dir).catch(() => [] as string[])
    const name = names.includes(part) ? part : (names.find((n) => n.toLowerCase() === part.toLowerCase()) ?? part)
    out.push(name)
    dir = join(dir, name)
  }
  return out.join('/')
}

/**
 * For the terminal's file links: each entry's path as spelled on disk when it is a file, or null (a folder,
 * missing, outside the project).
 */
export async function linkFiles(projectPath: string, rels: string[]): Promise<(string | null)[]> {
  projectPath = workspace.assertRoot(projectPath)
  return Promise.all(
    (Array.isArray(rels) ? rels : []).slice(0, 100).map(async (rel) => {
      const isFile = (r: string): Promise<boolean> => stat(inProject(projectPath, r)).then((s) => s.isFile(), () => false)
      try {
        if (typeof rel !== 'string') return null
        if (await isFile(rel)) return await spelledOnDisk(projectPath, rel)
        // A path into a .hive folder that moved leads to it in .combwork (HI-2462), and one into the old images folder to
        // the file where it is now, in attachments (#387).
        const ws = workspaceFor(projectPath)?.path
        const to = await followMovedLink(join(projectPath, rel), ws ? [ws] : [], movedAttachment)
        const moved = to ? toRel(projectPath, to) : null
        return moved && (await isFile(moved)) ? await spelledOnDisk(projectPath, moved) : null
      } catch {
        return null
      }
    })
  )
}

const MAX_EDIT_BYTES = 5 * 1024 * 1024

export async function readText(projectPath: string, rel: string): Promise<FileContent> {
  projectPath = workspace.assertRoot(projectPath)
  const abs = inProject(projectPath, rel)
  const s = await stat(abs)
  const meta = { size: s.size, modified: s.mtime.toISOString() }
  if (s.size > MAX_EDIT_BYTES) return { kind: 'too-large', text: '', bom: false, ...meta }
  const buf = await readFile(abs)
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return { kind: 'binary', text: '', bom: false, ...meta }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = decodeUtf8(buf.subarray(bom ? 3 : 0))
  // Not UTF-8 (a Windows-1252 file, say): decoding it would put U+FFFD in place of its bytes, and saving would
  // write those over them (HI-2331), so it isn't offered for editing.
  if (text === null) return { kind: 'not-utf8', text: '', bom: false, ...meta }
  return { kind: 'text', text, bom, ...meta }
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The bytes as text, or null when they aren't valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8Strict.decode(bytes)
  } catch {
    return null
  }
}

export async function writeText(projectPath: string, rel: string, text: string, expectedModified: string | null, bom: boolean): Promise<{ modified: string; size: number }> {
  projectPath = workspace.assertRoot(projectPath)
  const abs = inProject(projectPath, rel)
  // Checked and written under one lock: two saves at once can't both pass the check. Written in place
  // (not via a temp file), so the file keeps its identity for editors and tools that hold it open.
  return withFileLock(abs, async () => {
    if (expectedModified) {
      const cur = await stat(abs).catch(() => null)
      // A file deleted on disk is simply recreated; one changed since it was opened is a conflict.
      if (cur && Math.abs(cur.mtime.getTime() - Date.parse(expectedModified)) > 1) throw new Error('CONFLICT')
    }
    await writeFile(abs, bom ? '\uFEFF' + text : text, 'utf8')
    const s = await stat(abs)
    return { modified: s.mtime.toISOString(), size: s.size }
  })
}

const SKIP_WALK = new Set(['.git', 'node_modules'])

/** Files whose path contains every word of the query. Uses git's file list (respects .gitignore) when it can. */
export async function find(projectPath: string, query: string, limit = 500): Promise<FileEntry[]> {
  projectPath = workspace.assertRoot(projectPath)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  let paths: string[] = []
  const r = await git(projectPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  if (r.ok) paths = r.out.split('\0').filter(Boolean)
  else {
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 12 || paths.length > 50000) return
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (SKIP_WALK.has(e.name)) continue
        const abs = join(dir, e.name)
        if (e.isDirectory()) await walk(abs, depth + 1)
        else paths.push(toRel(projectPath, abs))
      }
    }
    await walk(projectPath, 0)
  }
  const out: FileEntry[] = []
  for (const p of paths) {
    const lower = p.toLowerCase()
    if (!words.every((w) => lower.includes(w))) continue
    if (p.startsWith(`${HIVE_DIR}/`)) continue
    out.push({ name: p.split('/').pop()!, relPath: p, isDir: false, size: 0, modified: '', ignored: false })
    if (out.length >= limit) break
  }
  // Matches in the file name first, then shorter paths.
  const last = words[words.length - 1]
  return out.sort((a, b) => Number(!a.name.toLowerCase().includes(last)) - Number(!b.name.toLowerCase().includes(last)) || a.relPath.length - b.relPath.length)
}

// ---------------------------------------------------------------------------
// Live updates: one recursive watcher per project while a Files or Attachments tab is open.
// ---------------------------------------------------------------------------

const watchers = new Map<string, { w: FSWatcher; refs: number; dirs: Set<string>; timer?: NodeJS.Timeout }>()

export function watchProject(projectPath: string): void {
  // A project or worktree, or the Assistant's home (its Attachments: .combwork/attachments there).
  projectPath = workspace.isAssistantHome(projectPath) ? workspace.assertSessionHost(projectPath) : workspace.assertRoot(projectPath)
  const key = projectPath.toLowerCase()
  const existing = watchers.get(key)
  if (existing) {
    existing.refs++
    return
  }
  try {
    const entry = { w: null as unknown as FSWatcher, refs: 1, dirs: new Set<string>(), timer: undefined as NodeJS.Timeout | undefined, since: 0 }
    const flush = (): void => {
      clearTimeout(entry.timer)
      entry.timer = undefined
      entry.since = 0
      emit({ type: 'files-changed', projectPath, dirs: [...entry.dirs] })
      entry.dirs.clear()
    }
    entry.w = watch(projectPath, { recursive: true }, (_evt, file) => {
      if (!file) return
      const rel = String(file).split(sep).join('/')
      if (rel === '.git' || rel.startsWith('.git/')) return
      // An install writes thousands of files there; the tree shows the folder itself.
      if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return
      entry.dirs.add(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
      // Quiet for 250 ms, or at least once a second while files keep changing (a build, an install).
      entry.since ||= Date.now()
      if (Date.now() - entry.since >= 1000) return flush()
      clearTimeout(entry.timer)
      entry.timer = setTimeout(flush, 250)
    })
    entry.w.on('error', (e) => log.warn('watch error', e))
    watchers.set(key, entry)
  } catch (e) {
    log.warn(`Could not watch ${userText(projectPath)}`, e)
  }
}

export function unwatchProject(projectPath: string): void {
  const key = projectPath.toLowerCase()
  const entry = watchers.get(key)
  if (!entry || --entry.refs > 0) return
  clearTimeout(entry.timer)
  entry.w.close()
  watchers.delete(key)
}

/**
 * Closes the watchers on these folders whoever opened them (a project being deleted: they hold it open). The
 * function returned opens them again as they were, for when the folders stay after all.
 */
export function suspendWatching(paths: string[]): () => void {
  const closed: { path: string; refs: number }[] = []
  for (const p of paths) {
    const entry = watchers.get(p.toLowerCase())
    if (!entry) continue
    clearTimeout(entry.timer)
    entry.w.close()
    watchers.delete(p.toLowerCase())
    closed.push({ path: p, refs: entry.refs })
  }
  return () => {
    for (const c of closed) for (let i = 0; i < c.refs; i++) watchProject(c.path)
  }
}

export function unwatchAll(): void {
  for (const e of watchers.values()) e.w.close()
  watchers.clear()
}

// ---------------------------------------------------------------------------
// Session attachments (#387)
// ---------------------------------------------------------------------------

/**
 * A session host's attachments folder (.combwork/attachments, moved from .combwork/images first), when it is a real folder of
 * the host's own: never one linked from elsewhere (a junction or symbolic link), which Hive neither lists nor deletes
 * through. Null when there is none.
 */
async function attachmentsRoot(host: string): Promise<string | null> {
  const root = await attachmentsDir(host)
  const st = await lstat(root).catch(() => null)
  if (!st) return null
  if (st.isSymbolicLink() || !st.isDirectory() || !insideReal(root, [host])) {
    log.warn(`${userText(root)} is a link to another folder: Combwork leaves it alone`)
    return null
  }
  return root
}

/** Throws unless p is a real folder or file (not a link) inside the attachments root, as Hive keeps them. */
async function assertOwnAttachment(root: string, p: string, kind: 'dir' | 'file'): Promise<void> {
  const st = await lstat(p).catch(() => null)
  if (!st || st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile()) || !insideReal(p, [root])) throw hiveError(M.notKept)
}

/** The attachments root and the session folder of a path in it (`<root>\<session>\<file>`); throws for anything else. */
async function attachmentAt(projectPath: string, path: string): Promise<{ root: string; sessionId: string; abs: string }> {
  const root = await attachmentsRoot(projectPath)
  const abs = resolve(path)
  const parts = root ? relative(root, abs).split(sep) : []
  if (!root || parts.length !== 2 || parts[0] === '..' || !isSessionFolder(parts[0])) throw hiveError(msg({ id: 'service.files.notAttachment', defaultMessage: 'Not a session attachment', description: "An error opening or deleting a session's attachment: the path isn't a file in a session's attachments folder." }))
  return { root, sessionId: assertSessionId(parts[0]), abs }
}

/** A project's session attachments, or the Hive Assistant's (its home is a session host: `.combwork/assistant/.combwork/attachments`). */
export async function listAttachments(projectPath: string): Promise<SessionAttachmentGroup[]> {
  projectPath = workspace.assertSessionHost(projectPath)
  const root = await attachmentsRoot(projectPath)
  if (!root) return []
  const records = new Map((await workspace.sessionsFile(projectPath)).sessions.map((s) => [s.id, s]))
  const groups: SessionAttachmentGroup[] = []
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    // The cards' folder (HI-1700) is listed with the cards, never as a session.
    if (!d.isDirectory() || !isSessionFolder(d.name)) continue
    const attachments: SessionAttachment[] = []
    for (const f of await readdir(join(root, d.name), { withFileTypes: true }).catch(() => [])) {
      if (!f.isFile()) continue
      const p = join(root, d.name, f.name)
      const s = await stat(p).catch(() => null)
      if (s) attachments.push({ path: p, name: f.name, size: s.size, modified: s.mtime.toISOString(), kind: attachmentKind(f.name) })
    }
    if (!attachments.length) continue
    // Names start with the time (see sessions.attachmentFile), so they order reliably even after copying.
    attachments.sort((a, b) => b.name.localeCompare(a.name) || b.modified.localeCompare(a.modified))
    const rec = records.get(d.name)
    groups.push({ sessionId: d.name, name: rec?.name ?? null, archived: rec?.archived ?? false, provider: rec ? rec.agent || 'claude-code' : null, attachments })
  }
  return groups.sort((a, b) => b.attachments[0].name.localeCompare(a.attachments[0].name))
}

/** The most of an attachment's text the viewer previews (a session's, or a card's: HI-1958). */
export const MAX_ATTACHMENT_TEXT = 2 * 1024 * 1024

/** A kept attachment's text for the viewer's previews (text, CSV, Markdown, code): 'binary' or 'too-large' otherwise. */
export async function readAttachment(projectPath: string, path: string): Promise<AttachmentContent> {
  projectPath = workspace.assertSessionHost(projectPath)
  const { root, abs } = await attachmentAt(projectPath, path)
  await assertOwnAttachment(root, abs, 'file')
  if ((await stat(abs)).size > MAX_ATTACHMENT_TEXT) return { kind: 'too-large', text: '' }
  const buf = await readFile(abs)
  for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return { kind: 'binary', text: '' }
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return { kind: 'text', text: buf.toString('utf8', bom ? 3 : 0) }
}

/**
 * Moves a session attachment to the Recycle Bin (a project's or the Assistant's), with the checks of deleting sessions
 * (#239): with its session reserved and not running (whileStopped: it can't resume and paste meanwhile), only a file
 * Hive keeps (no link out of .combwork/attachments), and not one another program has open.
 */
export async function trashAttachment(projectPath: string, path: string): Promise<void> {
  projectPath = workspace.assertSessionHost(projectPath)
  const { root, sessionId, abs } = await attachmentAt(projectPath, path)
  await sessions.whileStopped(projectPath, sessionId, async () => {
    await assertOwnAttachment(root, join(root, sessionId), 'dir')
    await assertOwnAttachment(root, abs, 'file')
    if (await heldOpen(abs)) throw hiveError(M.inUse)
    await toTrash(abs)
  })
}

/**
 * Moves the attachments of one session (a group of the Attachments tab) to the Recycle Bin, all or none, with the checks
 * of deleting sessions (#239): not while the session runs (it may paste more), and none if another program has one open
 * (trashAllOrNothing puts back any already gone). How many went.
 */
export async function trashAttachmentGroup(projectPath: string, sessionId: string): Promise<number> {
  projectPath = workspace.assertSessionHost(projectPath)
  assertSessionId(sessionId)
  if (!isSessionFolder(sessionId)) throw hiveError(M.notKept)
  const root = await attachmentsRoot(projectPath)
  if (!root) throw hiveError(M.notKept)
  const dir = join(root, sessionId)
  // Reserved and not running from here to the end: it can't resume (and paste) while its attachments go.
  const n = await sessions.whileStopped(projectPath, sessionId, async () => {
    await assertOwnAttachment(root, dir, 'dir')
    const files = (await readdir(dir, { withFileTypes: true })).filter((f) => f.isFile()).map((f) => join(dir, f.name))
    for (const f of files) await assertOwnAttachment(root, f, 'file')
    try {
      await trashAllOrNothing(files, (f) => toTrash(f))
    } catch (e) {
      if (isInUse(e)) throw hiveError(msg({ id: 'service.files.groupInUse', defaultMessage: 'Another program has one of these files open. Close it, then try again.', description: "An error deleting a session's attachments: another program has one of them open, so none was moved." }), undefined, { cause: e })
      throw e
    }
    // The folder goes too once empty (Hive makes it again for the next attachment).
    await rmdir(dir).catch(() => undefined)
    return files.length
  })
  log.info(`Moved ${n} attachments of session ${sessionId} in ${userText(projectPath)} to the Recycle Bin`)
  return n
}
