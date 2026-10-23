import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Dirent, type Stats } from 'original-fs'
import { copyFile, link, lstat, mkdir, open, opendir, readFile, readlink, rename, writeFile, stat, symlink, cp, rm, utimes } from 'original-fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { createHash } from 'crypto'
import { readdir } from 'original-fs/promises'
import { join } from 'path'
import { msg } from '../shared/i18n'
import { withValues } from '../shared/advanced'
import { HiveError } from './hiveError'

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Kept files: Hive's own settings and records (config.json, workspace.json, project.json, sessions.json).
// Each save also writes <file>.bak, the last good version. A file that can't be read as JSON is set aside
// as <file>.corrupt-<time> and the .bak restored, so one bad file never turns into lost settings or records.
// ---------------------------------------------------------------------------

type CorruptReport = (file: string, aside: string, restored: boolean) => void
let reportCorrupt: CorruptReport = () => undefined

/** Where a damaged kept file is reported (a notification); set once by the app. */
export function onCorruptFile(fn: CorruptReport): void {
  reportCorrupt = fn
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

/** Recovers a kept file whose text isn't valid JSON: set aside, then the .bak restored (or the fallback). */
function recoverText(path: string, bak: string | null): { value: unknown; restored: boolean; aside: string } | null {
  const aside = `${path}.corrupt-${stamp()}`
  try {
    renameSync(path, aside)
  } catch {
    // Already set aside by a read at the same moment.
  }
  if (bak !== null) {
    try {
      const value = JSON.parse(bak)
      return { value, restored: true, aside }
    } catch {
      // The copy is damaged too.
    }
  }
  return { value: null, restored: false, aside }
}

export async function readKeptJson<T>(path: string, fallback: T): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // Missing (or briefly locked): the caller's default, as before. Nothing is set aside.
    return fallback
  }
  try {
    return JSON.parse(text) as T
  } catch {
    const bak = await readFile(`${path}.bak`, 'utf8').catch(() => null)
    const r = recoverText(path, bak)!
    if (r.restored) await writeTextAtomic(path, bak!).catch(() => undefined)
    reportCorrupt(path, r.aside, r.restored)
    return r.restored ? (r.value as T) : fallback
  }
}

/** The same, for reads at startup that must be synchronous (config.json). */
export function readKeptJsonSync<T>(path: string, fallback: T): T {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text) as T
  } catch {
    let bak: string | null = null
    try {
      bak = readFileSync(`${path}.bak`, 'utf8')
    } catch {
      // No copy yet.
    }
    const r = recoverText(path, bak)!
    if (r.restored) {
      try {
        writeFileSync(path, bak!)
      } catch {
        // Written again on the next save.
      }
    }
    reportCorrupt(path, r.aside, r.restored)
    return r.restored ? (r.value as T) : fallback
  }
}

/**
 * The real location of a path, following symlinks and junctions (for a path that doesn't exist yet, its
 * nearest existing folder's real location plus the rest).
 */
export function realPath(p: string): string {
  let head = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      return rest.length ? join(realpathSync.native(head), ...rest.reverse()) : realpathSync.native(head)
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(p)
      rest.push(head.slice(up.length).replace(/^[\\/]/, ''))
      head = up
    }
  }
}

/**
 * A path's key for telling whether two paths are the same place: its real location (`realPath`), lower-cased. Git lists
 * worktrees by their real, long names, so a path Hive was given or saved as an 8.3 short name (C:\Users\RUNNER~1\…),
 * through a junction or a symlink only matches git's by this (#389). One that can't be resolved keys as written.
 */
export const placeKey = (p: string): string => realPath(p).toLowerCase()

/** Whether two paths are the same place (`placeKey`). */
export const samePlace = (a: string, b: string): boolean => placeKey(a) === placeKey(b)

/**
 * A test for whether a path is the place `folder` is, for matching the cwd a CLI recorded with Hive's spelling of a
 * folder (#493): the same spelling, or else the same real location (`placeKey`), each other spelling resolved once.
 */
export function placeMatcher(folder: string): (p: string) => boolean {
  const spelt = resolve(folder).toLowerCase()
  let key: string | undefined
  const seen = new Map<string, boolean>()
  return (p) => {
    const s = resolve(p).toLowerCase()
    if (s === spelt) return true
    let same = seen.get(s)
    if (same === undefined) {
      same = placeKey(p) === (key ??= placeKey(folder))
      seen.set(s, same)
    }
    return same
  }
}

/** Whether `outer` is `inner` or a folder containing it, by real paths (`placeKey`). */
export function containsPlace(outer: string, inner: string): boolean {
  const x = placeKey(outer).replace(/[\\/]$/, '')
  const y = placeKey(inner)
  return x === y || y.startsWith(x + sep)
}

/**
 * `to` relative to `from`, for showing (a locked file to an agent, from its folder): as written when `to` is inside `from`,
 * else by both paths' real locations when it is inside it by another name (a junction, an 8.3 short name: #494), so it
 * never reads `..\..\RUNNER~1\…`; else as written.
 */
export function placeRelative(from: string, to: string): string {
  return relativeInside(from, to) ?? relative(from, to)
}

/** `to` relative to `from` when it is inside it (or is it: ''), by spelling or else by real locations (`placeRelative`); else null. */
export function relativeInside(from: string, to: string): string | null {
  const rel = relative(from, to)
  if (!leavesFolder(rel)) return rel
  const real = relative(realPath(from), realPath(to))
  return leavesFolder(real) ? null : real
}

const leavesFolder = (rel: string): boolean => rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)

/**
 * Whether a path is inside an .asar archive (`…\app.asar\icon.png`). Such a path isn't a file on disk, and Electron's
 * readers that take a path (nativeImage, its file: loader) open the archive for it and keep it open until Hive quits,
 * so a build can't replace it (#246). Hive's file routes refuse them; the .asar itself is fine. Only an archive counts:
 * a folder of the path named *.asar is one when it is a file on disk (asked of original-fs, which never opens one as
 * an archive); a real folder of that name (`art.asar\icon.png`) is just a folder (#261).
 */
export function insideArchive(p: string): boolean {
  if (!/\.asar[\\/]/i.test(p)) return false
  // Missing is no archive (there is nothing to open); one that can't be looked at (under a file, say) counts as one.
  const archive = (dir: string): boolean => {
    try {
      return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === false
    } catch {
      return true
    }
  }
  for (let dir = dirname(resolve(p)); dirname(dir) !== dir; dir = dirname(dir)) if (/\.asar$/i.test(dir) && archive(dir)) return true
  return false
}

/** Whether a path is inside one of the folders: as written, and by its real location (a link inside can't lead outside). */
export function insideReal(p: string, roots: string[]): boolean {
  const within = (x: string, list: string[]): boolean =>
    list.some((r) => {
      const root = r.toLowerCase()
      const v = x.toLowerCase()
      return v === root || v.startsWith(root.endsWith(sep) ? root : root + sep)
    })
  return within(resolve(p), roots.map((r) => resolve(r))) && within(realPath(p), roots.map(realPath))
}

/**
 * Writes a text file from an editor. With `expected` (the text the editor loaded), throws CONFLICT
 * instead if the file has changed since (an agent edited it), so a save never silently drops that edit.
 */
export function writeTextUnlessChanged(path: string, text: string, expected?: string): Promise<void> {
  return withFileLock(path, async () => {
    if (expected !== undefined) {
      const current = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? '' : Promise.reject(e)))
      if (current !== expected) throw new Error('CONFLICT')
    }
    await writeTextAtomic(path, text)
  })
}

/** Kept files whose .bak this run has written (`bakOncePerRun`), by lower-case path. */
const backedUp = new Set<string>()

/**
 * Saves a kept file and its .bak copy. `compact`: JSON without spaces; `bakOncePerRun`: the .bak only at the first save
 * of the run (#1111: config.json, saved often, then costs one write a save, not two).
 */
export async function writeKeptJson(path: string, data: unknown, opts: { compact?: boolean; bakOncePerRun?: boolean } = {}): Promise<void> {
  const text = (opts.compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) + '\n'
  await writeTextAtomic(path, text)
  const k = path.toLowerCase()
  if (opts.bakOncePerRun && backedUp.has(k)) return
  await writeTextAtomic(`${path}.bak`, text).then(
    () => void backedUp.add(k),
    () => undefined
  )
}

/** Writes via a temp file + rename so a crash never leaves a half-written file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(data, null, 2) + '\n')
}

let tmpCounter = 0

/**
 * Each write has its own temp file, so two writes to one file at the same time can't mix their
 * contents; the last rename wins with a complete file. Windows briefly refuses a rename while
 * another process (or another rename) holds the target, so that is retried.
 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}-${++tmpCounter}.tmp`
  // A write that fails, while the temp file is written (a full disk) or renamed (retries given up, EPERM included),
  // removes it, so failed saves leave nothing behind (#1016). A crash part way still can: sweepLeftovers removes those.
  try {
    await writeFile(tmp, text, 'utf8')
    await renameRetrying(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

/**
 * A rename that Windows may refuse for a moment (a virus scanner or the search indexer looking at a file just written,
 * or another rename of the target): retried, waiting a little longer each time (about 2.3 s over 20 tries). `guard`,
 * when given, runs before every attempt (after each wait too) and stops the rename by throwing: work whose owner went
 * away meanwhile (a closed workspace) never renames late. `renameOnce` is the single rename (tests replace it).
 */
export async function renameRetrying(from: string, to: string, tries = 20, guard?: () => void, renameOnce: (a: string, b: string) => Promise<void> = rename): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    guard?.()
    try {
      await renameOnce(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= tries || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e
      await new Promise((r) => setTimeout(r, 15 + attempt * 10))
    }
  }
}

/**
 * Brings a copy of an append-only file (a CLI transcript) up to date. While the copy is still the start of
 * the source (the same first and last 4 KB at the copy's length), only the new bytes are appended, so a long
 * transcript isn't rewritten in full each time. Otherwise (the first copy, or a source that was rewritten)
 * the whole file is copied to a temp file and renamed into place. Copies of one file take turns.
 */
export function syncCopy(src: string, dest: string): Promise<void> {
  return withFileLock(dest, () => syncCopyLocked(src, dest))
}

/** syncCopy for a caller that already holds dest's lock (withFileLock isn't re-entrant). */
export async function syncCopyLocked(src: string, dest: string): Promise<void> {
  const s = await stat(src)
  const d = await stat(dest).catch(() => null)
  if (d && d.size > 0 && d.size <= s.size && (await samePrefix(src, dest, d.size))) {
    if (s.size > d.size) await appendRange(src, dest, d.size, s.size)
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}-${++tmpCounter}.tmp`
  try {
    // Not copyFile: Windows' CopyFile opens the source without sharing writes, so the CLI appending to its transcript
    // at that moment fails (EBUSY: a fake Claude Code died of it, #1041). Node's own opens share them.
    await copyWhole(src, tmp)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
  await publishCopy(tmp, dest, identity(d))
}

/** Which file is at a path and how far it has been written, to tell whether it changed: replaced, or written to. */
const identity = (s: Stats | null): string => (s ? `${s.ino}:${s.size}:${s.mtimeMs}` : '')

/**
 * Puts a finished whole copy in place of dest, unless dest changed since the copy began: the shutdown copy
 * (syncCopyNow) got there first, and it is newer, so it stays. The check and the rename are made together, at once,
 * on the main thread like the shutdown copy, so it can't come between them, and no rename is left under way while
 * it runs. Each retry (Windows briefly refuses a rename while another process holds the file) checks again.
 */
async function publishCopy(tmp: string, dest: string, began: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (identity(statOrNull(dest)) !== began) {
        rmSync(tmp, { force: true })
        return
      }
      renameSync(tmp, dest)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        rmSync(tmp, { force: true })
        throw e
      }
      await new Promise((r) => setTimeout(r, 15 + attempt * 10))
    }
  }
}

async function readRange(path: string, from: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, from)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Whether two files look the same over their first `len` bytes: the first, middle and last 4 KB. A sample,
 * not proof: enough for transcripts, which the CLIs only ever append to (one replaced or cut short fails it).
 */
async function samePrefix(a: string, b: string, len: number): Promise<boolean> {
  const n = Math.min(4096, len)
  for (const from of len > n ? [0, Math.floor((len - n) / 2), len - n] : [0]) {
    const [x, y] = await Promise.all([readRange(a, from, n), readRange(b, from, n)])
    if (x.length !== n || !x.equals(y)) return false
  }
  return true
}

/** Copies all of src, to its end as it is then, to dest, as copyFile does, but through Node's opens, which share writes. */
async function copyWhole(src: string, dest: string): Promise<void> {
  const r = await open(src, 'r')
  try {
    const w = await open(dest, 'w')
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024)
      for (let pos = 0; ; ) {
        const { bytesRead } = await r.read(buf, 0, buf.length, pos)
        if (!bytesRead) break
        for (let off = 0; off < bytesRead; ) off += (await w.write(buf, off, bytesRead - off, pos + off)).bytesWritten
        pos += bytesRead
      }
    } finally {
      await w.close()
    }
  } finally {
    await r.close()
  }
}

/**
 * Copies src's bytes [from, to) to the same place in dest. Each byte goes at its own offset, not the end, so a
 * copy that overlaps another (the shutdown copy, syncCopyNow) writes the same bytes to the same place.
 */
async function appendRange(src: string, dest: string, from: number, to: number): Promise<void> {
  const r = await open(src, 'r')
  try {
    const w = await open(dest, 'r+')
    try {
      const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, to - from))
      for (let pos = from; pos < to; ) {
        const { bytesRead } = await r.read(buf, 0, Math.min(buf.length, to - pos), pos)
        if (!bytesRead) throw new Error(`${src} ended before ${to} bytes`) // i18n-ignore: a low-level copy error, worded as Node's own (an outer error or the log says what failed)
        // A write can take less than it was given: the rest follows.
        for (let off = 0; off < bytesRead; ) off += (await w.write(buf, off, bytesRead - off, pos + off)).bytesWritten
        pos += bytesRead
      }
    } finally {
      await w.close()
    }
  } finally {
    await r.close()
  }
  // At least `to`: an overlapping copy may have gone further.
  const got = (await stat(dest)).size
  if (got < to) throw new Error(`The copy of ${src} is ${got} bytes, not ${to}`) // i18n-ignore: a low-level copy error, worded as Node's own (an outer error or the log says what failed)
}

/**
 * syncCopy done at once, for Windows ending the session: its callbacks don't wait for a Promise, so this blocks until
 * the copy is made or `deadline` (Date.now()) passes. It works in steps of SYNC_STEP bytes and starts none after the
 * deadline; a single step can't be cut short, so it can run over by about one. Out of time, a whole copy is dropped
 * (the backup stays as it was) and an append stops where it got to (a shorter backup, still the transcript's start).
 * It can overlap an ordinary syncCopy: appends write each byte at its own offset, and a whole copy of syncCopy's
 * doesn't replace a backup that changed after it began (publishCopy). Returns whether the copy has all of src.
 */
export function syncCopyNow(src: string, dest: string, deadline: number): boolean {
  const size = statSync(src).size
  const d = statOrNull(dest)
  if (d && d.size > 0 && d.size <= size && samePrefixSync(src, dest, d.size)) return copyRangeSync(src, dest, 'r+', d.size, size, deadline)
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}-${++tmpCounter}.tmp`
  try {
    if (!copyRangeSync(src, tmp, 'w', 0, size, deadline)) {
      rmSync(tmp, { force: true })
      return false
    }
    renameSync(tmp, dest)
    return true
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** How much syncCopyNow reads and writes at a time, between looks at the time. */
export const SYNC_STEP = 1024 * 1024

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function readRangeSync(path: string, from: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, from))
  } finally {
    closeSync(fd)
  }
}

/** samePrefix, at once. */
function samePrefixSync(a: string, b: string, len: number): boolean {
  const n = Math.min(4096, len)
  for (const from of len > n ? [0, Math.floor((len - n) / 2), len - n] : [0]) {
    const x = readRangeSync(a, from, n)
    if (x.length !== n || !x.equals(readRangeSync(b, from, n))) return false
  }
  return true
}

/**
 * Copies src's bytes [from, to) to the same place in dest (opened with `flags`), a step at a time, starting none
 * after `deadline`. Returns whether it got to `to`.
 */
function copyRangeSync(src: string, dest: string, flags: 'r+' | 'w', from: number, to: number, deadline: number): boolean {
  const r = openSync(src, 'r')
  try {
    const w = openSync(dest, flags)
    try {
      const buf = Buffer.alloc(Math.max(1, Math.min(SYNC_STEP, to - from)))
      for (let pos = from; pos < to; ) {
        if (Date.now() >= deadline) return false
        const bytesRead = readSync(r, buf, 0, Math.min(buf.length, to - pos), pos)
        if (!bytesRead) throw new Error(`${src} ended before ${to} bytes`) // i18n-ignore: a low-level copy error, worded as Node's own (an outer error or the log says what failed)
        for (let off = 0; off < bytesRead; ) off += writeSync(w, buf, off, bytesRead - off, pos + off)
        pos += bytesRead
      }
      return true
    } finally {
      closeSync(w)
    }
  } finally {
    closeSync(r)
  }
}

const fileLocks = new Map<string, Promise<unknown>>()
const fileLockCalls = new Map<string, number>()

/**
 * Runs fn with the file locked against other withFileLock calls for the same path, so a
 * read-modify-write (e.g. sessions.json when two agents finish together) never loses a change.
 */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = path.toLowerCase()
  const prev = fileLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  fileLocks.set(key, tail)
  fileLockCalls.set(key, (fileLockCalls.get(key) ?? 0) + 1)
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key)
    const left = (fileLockCalls.get(key) ?? 1) - 1
    if (left) fileLockCalls.set(key, left)
    else fileLockCalls.delete(key)
  })
  return run
}

/** How many withFileLock calls for path are running or waiting: tests wait on it for a write to be queued. */
export const fileLockDepth = (path: string): number => fileLockCalls.get(path.toLowerCase()) ?? 0

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, force: true })
}

/** Files copyMissing would have copied into a destination without apply, by lower-cased relative path: their size and time. */
export type PlannedCopies = Map<string, { size: number; mtimeMs: number }>

/**
 * Copies the files of src that dest hasn't got (#146: a moved folder's data), never overwriting: a file already in dest
 * with the same size and time is taken as copied before (copies keep the time), one that differs is kept and listed.
 * Links are left out; what can't be read is listed as failed. Without apply, only counts. Paths in the lists are relative
 * to src ('.' for src itself). Several sources copied into one dest share a `planned`, so without apply a later source
 * counts what an earlier one would copy as already there.
 */
export async function copyMissing(src: string, dest: string, apply: boolean, planned?: PlannedCopies): Promise<{ copy: number; kept: string[]; failed: string[] }> {
  const out = { copy: 0, kept: [] as string[], failed: [] as string[] }
  const walk = async (rel: string): Promise<void> => {
    // A folder or file that can't be read is listed as failed, not skipped: Repair says so and tries it again.
    const entries = await readdir(join(src, rel), { withFileTypes: true }).catch(() => null)
    if (!entries) {
      out.failed.push(rel || '.')
      return
    }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name
      if (e.isDirectory()) await walk(r)
      if (!e.isFile()) continue
      const from = join(src, r)
      const to = join(dest, r)
      const [a, there] = await Promise.all([stat(from).catch(() => null), stat(to).catch(() => null)])
      if (!a) {
        out.failed.push(r)
        continue
      }
      const b = there ?? (apply ? undefined : planned?.get(r.toLowerCase()))
      if (b) {
        if (b.size !== a.size || Math.abs(b.mtimeMs - a.mtimeMs) >= 2) out.kept.push(r)
        continue
      }
      if (!apply) {
        planned?.set(r.toLowerCase(), { size: a.size, mtimeMs: a.mtimeMs })
        out.copy++
        continue
      }
      try {
        await mkdir(dirname(to), { recursive: true })
        await copyFile(from, to, constants.COPYFILE_EXCL)
        await utimes(to, a.atime, a.mtime)
        out.copy++
      } catch {
        out.failed.push(r)
      }
    }
  }
  await walk('')
  return out
}

let swapCounter = 0

/** A swap that found its destination no longer as expected: nothing was replaced, and the destination is as it was. */
export class SwapAbandoned extends Error {}

/** A swap whose copy couldn't be made (its source gone, unreadable or changing): nothing was replaced. `cause` is why. Restore (Skills, modes) shows it in the window's language (#850). */
export class CopyFailed extends HiveError {}

/**
 * Why a skill's source couldn't be copied, without its path (the user's): gone, a file in it gone, not allowed, or
 * another error's code.
 */
export function sourceProblem(e: unknown, source: string): string {
  const code = ((e instanceof CopyFailed ? e.cause : e) as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return existsSync(source) ? 'a file in it went while it was being copied' : 'its folder in the workspace is gone' // i18n-ignore: a skill delivery's problem, which the launch's problems (agents) say
  if (code === 'EACCES' || code === 'EPERM') return 'its folder in the workspace could not be read (access denied)' // i18n-ignore: a skill delivery's problem, which the launch's problems (agents) say
  // Anything else (a disk full, a write that failed) is about making the copy, not the source.
  return `it could not be copied${code ? ` (${code})` : ''}` // i18n-ignore: a skill delivery's problem, which the launch's problems (agents) say
}

/** What a path holds, to compare with what a swap expects: its contentHash, null if nothing is there. */
async function hashOrNone(path: string): Promise<string | null> {
  const there = await lstat(path).then(
    () => true,
    (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? false : Promise.reject(e))
  )
  return there ? contentHash(path).catch(() => '\0unreadable') : null
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

/** Runs fn holding Hive's own write lock (withFileLock, as its editors use) on each of `paths`, taken in order. */
function withFileLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = [...new Set(paths)].sort()
  return first === undefined ? fn() : withFileLock(first, () => withFileLocks(rest, fn))
}

/** A folder's files (or the file itself), as absolute paths: the ones an editor might be saving. */
async function filesIn(path: string): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory()) return [path]
    return (await treeEntries(path, {})).map((e) => e.abs)
  } catch {
    return []
  }
}

/**
 * Replaces `dest` (a folder, or a file) with a copy of `src` (copySkillTree for a folder: links stay links), so a reader
 * never sees it half-copied: the copy is made beside it (a dot-name, which skill scans skip; `prepare` can add to it),
 * then the old one is renamed aside and the copy renamed into place. If Windows refuses a rename (a file in the old one
 * is open), the old one stays as it was and this throws. `cleanSwaps` tidies what a crash between the steps leaves.
 *
 * With `expected` (a contentHash, or null for nothing there), the swap is only for that destination: an automatic
 * update, never a user's newer version. It is checked after the copy is made (under Hive's own editors' file locks), on
 * the old one once it has been moved aside, and again before the old one is removed (a write through a file already
 * open); any difference puts the user's version back and throws SwapAbandoned, leaving the destination as the user has
 * it. What a rollback moves aside is removed only if it is still exactly what was staged, and anything a refused
 * rename leaves out of place is kept as a `-conflict-` copy: nothing that may hold the user's work is removed unchecked.
 * Without `expected` (Restore, Revert, Hive's own copies) it replaces whatever is there.
 */
export async function swapIn(src: string, dest: string, o: { prepare?: (copy: string, revision: string) => Promise<void>; expected?: string | null } = {}): Promise<string> {
  const tag = `${process.pid}-${++swapCounter}`
  const parent = dirname(dest)
  const name = dest.slice(parent.length + 1)
  const fresh = join(parent, `.${name}.hive-new-${tag}`)
  const old = join(parent, `.${name}.hive-old-${tag}`)
  const check = o.expected !== undefined
  await mkdir(parent, { recursive: true })
  // The copy, made within the limits as the source is read (it may change meanwhile), and checked before anything is
  // published: its revision is what was copied, not what the source was earlier. A copy over the limits, missing a link
  // or that couldn't be made replaces nothing.
  let revision: string
  try {
    try {
      if ((await lstat(src)).isDirectory()) {
        // A swap is all or nothing: a copy missing a link doesn't replace the old one.
        const skipped = await copySkillTree(src, fresh)
        if (skipped.length) throw new LinkNotCopied(linksNotCopied(skipped))
      } else await copyBounded(src, fresh, { bytes: HASH_LIMITS.bytes }, HASH_LIMITS.bytes)
      revision = await contentHash(fresh)
    } catch (e) {
      if (e instanceof ContentTooLarge || e instanceof LinkNotCopied) throw e
      throw new CopyFailed(withValues(msg({ id: 'service.fsutil.notCopied', defaultMessage: '{name} could not be copied', description: "An error putting back one of Hive's skills or modes: its copy couldn't be made ({name}: its folder or file name); nothing was replaced." }), { name }), { cause: e })
    }
    await o.prepare?.(fresh, revision)
  } catch (e) {
    await rm(fresh, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
  // What was staged: a rollback's backup of the destination is Hive's only while it is this (prepare adds only files
  // contentHash leaves out, such as a copy's marker).
  const staged = check ? revision : null
  /** Removes `p` if it is still `ok` (Hive's: nothing of the user's in it), else keeps it as a visible conflict copy. */
  const dispose = async (p: string, ok: string | null): Promise<void> => {
    if (ok !== null && (await hashOrNone(p)) === ok) await rm(p, { recursive: true, force: true }).catch(() => undefined)
    else await keepAsConflict(p, parent, name)
  }
  const publish = async (): Promise<void> => {
    if (check && (await hashOrNone(dest)) !== o.expected) throw new SwapAbandoned(`${name} changed before it could be replaced`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    const had = await exists(dest)
    // A file in the old one held open by a running session keeps it from moving: a few tries, then it stays.
    if (had) await renameRetrying(dest, old, 5)
    if (had && check && (await hashOrNone(old)) !== o.expected) {
      await renameRetrying(old, dest).catch(() => keepAsConflict(old, parent, name))
      throw new SwapAbandoned(`${name} changed while it was being replaced`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    }
    try {
      // Something new in its place meanwhile (the user's): it stays. On Windows the rename would fail anyway.
      if (check && (await exists(dest))) throw new SwapAbandoned(`${name} was put back while it was being replaced`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
      // The copy was just written: a scanner may be looking at it for a moment.
      await renameRetrying(fresh, dest)
    } catch (e) {
      // The old one back in its place if that is empty. If the user made a new one, theirs stays, and the old one goes
      // only if it is still the version this swap expected (else it is kept as a conflict copy).
      if (had && !(await exists(dest))) await renameRetrying(old, dest).catch(() => (check ? keepAsConflict(old, parent, name) : undefined))
      else if (had && check) await dispose(old, o.expected ?? null)
      throw e
    }
    if (!had) return
    // Written to through a file left open before the move: the user's version goes back in its place. What is in the
    // place now is moved aside first, and removed only if it is still exactly what was staged; if it was edited too, it
    // is kept as a conflict copy. Nothing that could hold the user's work is removed unchecked.
    if (check && (await hashOrNone(old)) !== o.expected) {
      const back = join(parent, `.${name}.hive-back-${tag}`)
      try {
        await renameRetrying(dest, back)
      } catch {
        // The new version can't move: it stays, and the user's edited old one is kept beside it.
        await keepAsConflict(old, parent, name)
        throw new SwapAbandoned(`${name} changed while it was being replaced; the edited copy is kept beside it`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
      }
      try {
        await renameRetrying(old, dest)
      } catch {
        await renameRetrying(back, dest).catch(() => keepAsConflict(back, parent, name))
        await keepAsConflict(old, parent, name)
        throw new SwapAbandoned(`${name} changed while it was being replaced; the edited copy is kept beside it`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
      }
      await dispose(back, staged)
      throw new SwapAbandoned(`${name} changed while it was being replaced`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    }
    await rm(old, { recursive: true, force: true }).catch(() => undefined)
  }
  try {
    if (check) await withFileLocks([...(await filesIn(dest)), ...(await filesIn(fresh)).map((f) => join(dest, f.slice(fresh.length)))], publish)
    else await publish()
  } finally {
    await rm(fresh, { recursive: true, force: true }).catch(() => undefined)
  }
  return revision
}

/**
 * Removes `dest` (a file or a folder) only while it is exactly `expected` (a contentHash): a retired item of Hive's that
 * the user never changed (#259). As swapIn guards a replacement: checked under Hive's own editors' file locks, again once
 * it has been moved aside (a dot-name, which scans skip), and again just before it goes (a write through a file left
 * open). Any difference puts it back in its place, or keeps it beside it as a `-conflict-` copy when something new has
 * taken that place, and throws SwapAbandoned: nothing that may hold the user's work is removed. `cleanSwaps` tidies what
 * a crash between the steps leaves.
 */
export async function swapOut(dest: string, expected: string): Promise<void> {
  const tag = `${process.pid}-${++swapCounter}`
  const parent = dirname(dest)
  const name = dest.slice(parent.length + 1)
  const old = join(parent, `.${name}.hive-old-${tag}`)
  const remove = async (): Promise<void> => {
    if ((await hashOrNone(dest)) !== expected) throw new SwapAbandoned(`${name} changed before it could be removed`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    await renameRetrying(dest, old, 5)
    const putBack = async (why: string): Promise<never> => {
      if (!(await exists(dest))) await renameRetrying(old, dest).catch(() => keepAsConflict(old, parent, name))
      else await keepAsConflict(old, parent, name)
      throw new SwapAbandoned(why)
    }
    if ((await hashOrNone(old)) !== expected) await putBack(`${name} changed while it was being removed`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    // Something new in its place meanwhile is the user's: it stays, and so does what was moved aside (as a conflict copy
    // if it was changed: it is removed only while it is still exactly Hive's).
    if ((await hashOrNone(old)) !== expected) await putBack(`${name} changed while it was being removed`) // i18n-ignore: why a swap was abandoned, for the log and a skill delivery's problem (agents); no person is shown it
    await rm(old, { recursive: true, force: true })
  }
  await withFileLocks(await filesIn(dest), remove)
}

/**
 * Keeps `p` (something a swap set aside that may hold the user's work) beside the item as `<name>-conflict-<time>`
 * (`<base>-conflict-<time><ext>` for a file), where the user can find it; it stays where it is if even that fails.
 */
async function keepAsConflict(p: string, parent: string, name: string): Promise<void> {
  if (!(await exists(p))) return
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 && !(await lstat(p)).isDirectory() ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  const when = new Date().toISOString().replace(/[:.]/g, '-')
  for (let i = 0; i < 100; i++) {
    const to = join(parent, `${base}-conflict-${when}${i ? `-${i}` : ''}${ext}`)
    if (await exists(to)) continue
    await renameRetrying(p, to).catch(() => undefined)
    return
  }
}

/**
 * After a crash during swapIn in `parent`: a staged copy never put in place goes; an old one (the destination moved
 * aside) whose place is empty comes back. An old one whose place has been filled, and a rollback's backup (what was in
 * the place when the user's version was being put back), are removed only if `disposable` says they hold nothing of the
 * user's (Hive's own copies; a version Hive shipped); otherwise they are kept beside it as `<name>-conflict-<time>`, so
 * they can be found and recovered. Old ones are handled first, so the user's original takes its place before a backup.
 */
export async function cleanSwaps(parent: string, disposable: (old: string, name: string) => Promise<boolean> = async () => true): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(parent)
  } catch {
    return
  }
  const found = names.flatMap((n) => {
    const m = /^\.(.+)\.hive-(new|old|back)-\d+-\d+$/.exec(n)
    return m ? [{ n, name: m[1], kind: m[2] }] : []
  })
  const order = { old: 0, back: 1, new: 2 } as Record<string, number>
  for (const { n, name, kind } of found.sort((a, b) => order[a.kind] - order[b.kind])) {
    const p = join(parent, n)
    if (kind === 'new') await rm(p, { recursive: true, force: true }).catch(() => undefined)
    else if (!(await exists(join(parent, name)))) await renameRetrying(p, join(parent, name)).catch(() => undefined)
    else if (await disposable(p, name).catch(() => false)) await rm(p, { recursive: true, force: true }).catch(() => undefined)
    else await keepAsConflict(p, parent, name)
  }
}

/** The marker file in a copy Hive made of a skill (Codex's .agents/skills copies): not part of the skill's content. */
export const COPY_MARKER = '.hive-copy'

/**
 * What Hive has read to know its skills, since it started (for measurements and tests): files and bytes hashed
 * (contentHash), directory entries listed (readDirBounded), and bytes of skills' headers read (SKILL.md frontmatter).
 */
export const readStats = { files: 0, bytes: 0, entries: 0, metaBytes: 0 }

/**
 * A folder's entries, read a batch at a time and no more than `max` of them: `more` when it has others (not read).
 * A huge folder costs only what was read.
 */
export async function readDirBounded(path: string, max: number, signal?: AbortSignal, count?: { entries: number }): Promise<{ entries: Dirent[]; more: boolean }> {
  const dir = await opendir(path, { bufferSize: 32 })
  const entries: Dirent[] = []
  try {
    for (;;) {
      signal?.throwIfAborted()
      const e = await dir.read()
      if (!e) return { entries, more: false }
      readStats.entries++
      if (count) count.entries++
      if (entries.length >= max) return { entries, more: true }
      entries.push(e)
    }
  } finally {
    await dir.close().catch(() => undefined)
  }
}

/**
 * The most contentHash and treeSignature take on, for a skill or mode: entries (files, folders and links), folder
 * depth, and bytes actually read. Past one they stop with ContentTooLarge rather than read on.
 */
export const HASH_LIMITS = { entries: 2000, depth: 12, bytes: 64 * 1024 * 1024 }

/** A skill or mode over HASH_LIMITS: it has no revision. */
export class ContentTooLarge extends Error {}

/** ContentTooLarge's reason for content over the byte limit (the same whether a stat or the read found it). */
export const overBytes = (limit: number): string => `it is over ${Math.round(limit / 1024 / 1024)} MB` // i18n-ignore: why a skill is too big, a delivery's problem (agents) and a kept revision's reason

/** A launch's problem for a skill over HASH_LIMITS. */
export const tooBigToDeliver = (e: ContentTooLarge): string => `it is too big for Hive to check (${e.message})` // i18n-ignore: a skill delivery's problem, which the launch's problems (agents) say

export interface HashOptions {
  /** Stops the work (a closed workspace): the call rejects with the signal's reason. */
  signal?: AbortSignal
  limits?: Partial<typeof HASH_LIMITS>
  /** Also counts what this call read here (files, bytes, directory entries), for the caller's own metrics. */
  count?: { files: number; bytes: number; entries: number }
}

interface TreeEntry {
  rel: string
  abs: string
  link: boolean
}

/** A file's or folder's files and links (never following one), in code-point order of their paths, within the limits. */
async function treeEntries(path: string, o: HashOptions): Promise<TreeEntry[]> {
  const lim = { ...HASH_LIMITS, ...o.limits }
  const top = await lstat(path)
  if (top.isSymbolicLink()) return [{ rel: '', abs: path, link: true }]
  if (top.isFile()) return [{ rel: '', abs: path, link: false }]
  const entries: TreeEntry[] = []
  let seen = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    o.signal?.throwIfAborted()
    if (depth > lim.depth) throw new ContentTooLarge(`it has folders more than ${lim.depth} deep`) // i18n-ignore: why a skill is too big, a delivery's problem (agents) and a kept revision's reason
    // The limit is on the skill's own entries: Hive's copy marker (one a folder at most) comes on top, so a skill at the
    // limit is still within it once Hive has marked its copy. The listing stays bounded: at most one more than allowed.
    const list = await readDirBounded(rel ? join(path, rel) : path, lim.entries - seen + 1, o.signal, o.count)
    const own = list.entries.length - (list.entries.some((e) => e.name === COPY_MARKER) ? 1 : 0)
    if (list.more || seen + own > lim.entries) throw new ContentTooLarge(`it has more than ${lim.entries} files and folders`) // i18n-ignore: why a skill is too big, a delivery's problem (agents) and a kept revision's reason
    seen += own
    for (const e of list.entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) entries.push({ rel: r, abs: join(path, r), link: true })
      else if (e.isDirectory()) await walk(r, depth + 1)
      else if (e.isFile()) {
        if (!CONTENT_HASH_SKIP.has(e.name)) entries.push({ rel: r, abs: join(path, r), link: false })
      } else entries.push({ rel: r, abs: join(path, r), link: true })
    }
  }
  await walk('', 1)
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * A hash of a file's or folder's content that ignores line endings (a git checkout's CRLF is the same skill), for
 * telling Hive's shipped versions of a skill or mode apart. Paths are compared as written, in code-point order.
 * A link (symlink or junction) is never followed: it counts by its name and where it points, so a copy with a link
 * the user added never hashes the same as a version Hive shipped (Hive ships none). Files are read in chunks, and
 * no more than HASH_LIMITS allow (ContentTooLarge): what it read, not what a stat said, counts.
 */
export async function contentHash(path: string, o: HashOptions = {}): Promise<string> {
  const limit = o.limits?.bytes ?? HASH_LIMITS.bytes
  const h = createHash('sha256')
  const buf = Buffer.allocUnsafe(64 * 1024)
  let total = 0
  for (const e of await treeEntries(path, o)) {
    h.update(e.rel)
    if (e.link) {
      h.update('\0link\0')
      h.update(await linkTarget(e.abs).catch(() => '?'))
      h.update('\0')
      continue
    }
    h.update('\0')
    readStats.files++
    if (o.count) o.count.files++
    const fh = await open(e.abs, 'r')
    try {
      // A CR at the end of a chunk waits for the next one: CRLF split between chunks is still one line ending.
      let cr = false
      for (;;) {
        o.signal?.throwIfAborted()
        const { bytesRead } = await fh.read(buf, 0, buf.length, null)
        if (!bytesRead) break
        total += bytesRead
        readStats.bytes += bytesRead
        if (o.count) o.count.bytes += bytesRead
        if (total > limit) throw new ContentTooLarge(overBytes(limit))
        let text: string = (cr ? '\r' : '') + buf.toString('latin1', 0, bytesRead)
        cr = text.endsWith('\r')
        if (cr) text = text.slice(0, -1)
        h.update(text.replace(/\r\n/g, '\n'), 'latin1')
      }
      if (cr) h.update('\r', 'latin1')
    } finally {
      await fh.close()
    }
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

/**
 * What a file's or folder's content looks like without reading it: each entry's path, size, times and file id (a
 * link's target), and the files' sizes added up (`bytes`, what contentHash would read). It changes whenever a file is
 * written, added, removed or renamed, so a contentHash taken with the same signature is still that content's. Bounded
 * like contentHash (entries, depth: past one it throws ContentTooLarge, having read no file).
 */
export async function treeSignature(path: string, o: HashOptions = {}): Promise<{ signature: string; bytes: number }> {
  const h = createHash('sha256')
  let bytes = 0
  for (const e of await treeEntries(path, o)) {
    h.update(e.rel)
    if (e.link) h.update(`\0link\0${await linkTarget(e.abs).catch(() => '?')}\0`)
    else {
      const st = await lstat(e.abs, { bigint: true })
      bytes += Number(st.size)
      h.update(`\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}\0${st.ino}\0`)
    }
  }
  return { signature: h.digest('hex'), bytes }
}

/**
 * Up to `max` bytes of a file, and whether it has more: the limit is on what is read, so a file that grew since an
 * earlier stat still isn't read past it.
 */
export async function readCapped(path: string, max: number): Promise<{ data: Buffer; more: boolean }> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(max + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, null)
      if (!bytesRead) break
      n += bytesRead
    }
    return { data: buf.subarray(0, Math.min(n, max)), more: n > max }
  } finally {
    await fh.close()
  }
}

/**
 * Where a link points, as one absolute path whatever form it was written in (relative, a junction's \\?\ prefix, a
 * trailing separator; case on Windows), so a link and Hive's copy of it (copySkillTree) are the same content.
 */
export async function linkTarget(abs: string): Promise<string> {
  const raw = (await readlink(abs)).replace(/^\\\\\?\\/, '')
  const target = resolve(dirname(abs), raw).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? target.toLowerCase() : target
}

/** A link in a skill that couldn't be made in the copy (Windows needs privileges for a link to a file). */
export class LinkNotCopied extends Error {}

/**
 * Copies a skill's folder, keeping each link a link to the same place (a junction for a folder on Windows) rather than
 * copying what it points to, so the copy is the same content as its source (contentHash) and the user's linked files
 * stay theirs. A link that can't be made is left out and everything else is still copied; it returns those links'
 * paths (relative, with /), for the caller to report. Any other failure throws.
 */
export async function copySkillTree(src: string, dest: string, o: HashOptions = {}): Promise<string[]> {
  const lim = { ...HASH_LIMITS, ...o.limits }
  const skipped: string[] = []
  // The limits contentHash keeps, kept while copying (the source can change as it is copied): entries listed a batch
  // at a time against what's left, depth, and bytes actually read; past one it stops with ContentTooLarge.
  const budget = { entries: lim.entries, bytes: lim.bytes }
  const walk = async (from: string, to: string, rel: string, depth: number): Promise<void> => {
    o.signal?.throwIfAborted()
    if (depth > lim.depth) throw new ContentTooLarge(`it has folders more than ${lim.depth} deep`) // i18n-ignore: why a skill is too big, a delivery's problem (agents) and a kept revision's reason
    await mkdir(to, { recursive: true })
    const list = await readDirBounded(from, budget.entries, o.signal)
    if (list.more) throw new ContentTooLarge(`it has more than ${lim.entries} files and folders`) // i18n-ignore: why a skill is too big, a delivery's problem (agents) and a kept revision's reason
    budget.entries -= list.entries.length
    for (const e of list.entries) {
      const f = join(from, e.name)
      const t = join(to, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        const made = await linkTarget(f)
          .then(async (target) => symlink(target, t, (await stat(f).then((x) => x.isDirectory(), () => false)) ? 'junction' : 'file'))
          .then(() => true, () => false)
        if (!made) skipped.push(r)
      } else if (e.isDirectory()) await walk(f, t, r, depth + 1)
      else if (e.isFile()) await copyBounded(f, t, budget, lim.bytes, o.signal)
    }
  }
  await walk(src, dest, '', 1)
  return skipped
}

/** Copies a file a chunk at a time, taking what it reads from `budget.bytes`: over it, ContentTooLarge (whatever a stat said). */
async function copyBounded(from: string, to: string, budget: { bytes: number }, limit: number, signal?: AbortSignal): Promise<void> {
  const src = await open(from, 'r')
  try {
    const dst = await open(to, 'w')
    try {
      const buf = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await src.read(buf, 0, buf.length, null)
        if (!bytesRead) break
        budget.bytes -= bytesRead
        if (budget.bytes < 0) throw new ContentTooLarge(overBytes(limit))
        // A write may take less than it was given: the rest of the chunk is written before the next read. One that
        // takes nothing fails the copy (nothing half-written is ever published).
        for (let done = 0; done < bytesRead; ) {
          signal?.throwIfAborted()
          const { bytesWritten } = await dst.write(buf, done, bytesRead - done)
          if (bytesWritten <= 0) throw Object.assign(new Error('EIO: the copy could not be written'), { code: 'EIO' }) // i18n-ignore: a low-level copy error, worded as Node's own (an outer error or the log says what failed)
          done += bytesWritten
        }
      }
    } finally {
      await dst.close()
    }
  } finally {
    await src.close()
  }
}

/** What a skill's links that couldn't be copied mean for the session that gets it. */
// i18n-ignore: a skill delivery's problem, which the launch's problems (agents) say
export const linksNotCopied = (paths: string[]): string => `${paths.length === 1 ? `the link ${paths[0]} is` : `the links ${paths.join(', ')} are`} missing from its copy: Windows didn't let Hive make ${paths.length === 1 ? 'it' : 'them'} (a link to a file needs a privilege)`

/** Files that aren't part of a skill's content: Hive's own copy marker and the operating systems' folder files. */
const CONTENT_HASH_SKIP = new Set([COPY_MARKER, '.DS_Store', 'Thumbs.db', 'desktop.ini'])

export async function removePath(path: string): Promise<void> {
  if (existsSync(path)) await rm(path, { recursive: true, force: true })
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * In Claude Code's config folder, only what Hive shows: the user CLAUDE.md and auto memory (editable),
 * and skills (read-only). Never credentials or settings.
 */
export function claudeFileAllowed(path: string, write: boolean, home: string): boolean {
  const rel = relative(resolve(home), resolve(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]/)
  if (!/\.md$/i.test(rel)) return false
  if (parts.length === 1) return parts[0].toLowerCase() === 'claude.md'
  if (parts[0] === 'projects') return parts.length === 4 && parts[2] === 'memory'
  if (parts[0] === 'skills' || parts[0] === 'plugins') return !write && parts[parts.length - 1].toLowerCase() === 'skill.md'
  return false
}

/** Windows' "in use" errors: another program has the file open without sharing it. */
export function isInUse(e: unknown): boolean {
  return ['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '')
}

/** Checks one of Hive's files can be moved (renamed aside and back), before any of a set goes. Throws if it can't. */
export async function movable(file: string): Promise<void> {
  const aside = `${file}.moving`
  await rename(file, aside)
  await rename(aside, file)
}

/**
 * Whether another program holds a file open without sharing it (Windows' sharing violation), found by opening it to
 * read and closing it at once: the file isn't changed. The CLIs' own transcripts are checked this way, never moved.
 */
export async function heldOpen(file: string): Promise<boolean> {
  try {
    const fh = await open(file, 'r')
    await fh.close()
    return false
  } catch (e) {
    return isInUse(e)
  }
}

/** The suffix of a spare of a file being sent to the Recycle Bin, to put it back if the rest fails. */
const SPARE = '.spare'

/**
 * Sends Hive's own files to the Recycle Bin all or nothing: each is first checked movable and given a spare name (a
 * hard link, else a copy); then each goes (`trash`), then `then` runs (e.g. the record's change). If any of it
 * fails, the files already gone are put back from their spares (a copy of each stays in the Recycle Bin) and the error
 * is thrown (isInUse tells one another program caused). The spares go in the end.
 */
export async function trashAllOrNothing(files: string[], trash: (file: string) => Promise<void>, then?: () => Promise<unknown>): Promise<void> {
  for (const f of files) await movable(f)
  const spares: string[] = []
  const gone: string[] = []
  try {
    for (const f of files) {
      await rm(`${f}${SPARE}`, { force: true })
      await link(f, `${f}${SPARE}`).catch(() => copyFile(f, `${f}${SPARE}`))
      spares.push(f)
    }
    for (const f of files) {
      await trash(f)
      gone.push(f)
    }
    await then?.()
  } catch (e) {
    for (const f of gone) await rename(`${f}${SPARE}`, f).catch(() => undefined)
    throw e
  } finally {
    for (const f of spares) await rm(`${f}${SPARE}`, { force: true }).catch(() => undefined)
  }
}
