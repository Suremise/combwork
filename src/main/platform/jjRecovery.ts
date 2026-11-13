// A stale jj workspace's recovery (SPEC §16.3.6 port 2, HI-2795's J2, its design HI-2795/s21 §1–2): explicit only (J7's
// operation; never the pool's clean-up), resumable from its durable journal after any stop, and never hiding anyone's
// edit. HI-2781 showed `jj workspace update-stale` with an unrecorded local edit leaves the file out of the checkout and
// keeps it only in a new divergent revision; this module keeps the bytes before jj runs and puts each one back only
// where nothing else changed it.
//
// Phases (the journal's `phase`; each written before the step it names):
// 1. planned: the stale operation S, the workspace's commit then (WS), its store and name, read pinned; the writers'
//    quiescence proved by the caller (its operation, no session, a quiet probe) and checked again before each mutation.
// 2. preserved: the files that differ from WS (tracked at WS, plus what git lists as not ignored, by jj's ignore rules),
//    their bytes copied outside every workspace (`<preserveRoot>/<token>/`, each fsynced, a manifest fsynced last),
//    read back and checked. Refused, nothing changed, when anything can't be listed, read, copied or checked, a path
//    crosses a link or junction, or the delta is past its bounds.
// 3. updated: a rescan (the same listing) right before `update-stale` preserves again if the folder changed (three
//    tries); then update-stale; then P1, the snapshot it wrote, found only by its exact shape (parents [S], a snapshot,
//    this workspace), and X, what it recorded. Anything X holds that the manifest doesn't (a write after the rescan) is
//    written beside its path (`.cw-recovered-<token>-late`) and X is kept.
// 4. restoring: path by path, the current file moved aside (atomic rename to a unique name, journalled first), then
//    put back as preserved only when the updated version (U) and the moved-aside one (C) both equal WS's: nobody
//    changed it. Otherwise C goes back (exclusive create) and the preserved version beside it. Nothing is overwritten.
// 5. restored: an owned record captures the files the folder now shows; X abandoned only if it is exactly the
//    preserved delta and nobody else's (no descendant, no bookmark, no workspace's); the preserved copy to the Recycle
//    Bin; the journal cleared.

import { createHash, randomBytes } from 'crypto'
import { constants, existsSync } from 'original-fs'
import { copyFile, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'original-fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { isUnknown } from './types'
import { checkoutOf, revsetName, type JjWorkspacePort } from './jjWorkspacePort'
import type { WorkspaceFence, WorkspaceIdentity, WorkspaceJournal } from './workspacePort'

/** A git command's answer (git.ts' git(), or a test's with its config isolated). */
export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string; buf: Buffer; err: string }>

export interface RecoveryDeps {
  port: JjWorkspacePort
  git: GitRun
  /** Where preserved bytes go: outside every workspace (the project's worktrees folder's `.cw-recovery`). */
  preserveRoot: string
  trash: (path: string) => Promise<void>
  /** The delta's bounds (an Advanced setting's): refused past either. */
  bounds?: { files: number; bytes: number }
  /**
   * The clock the record's collision wait reads and waits on (HI-3099); the real one by default. `now` is wall time (ms),
   * `wait` waits that long. The wait's cap counts the waits, never the wall clock (which can move back).
   */
  clock?: { now: () => number; wait: (ms: number) => Promise<void> }
  /** Test seams, run between steps. */
  hooks?: {
    afterPreserve?: () => void | Promise<void>
    beforeUpdate?: () => void | Promise<void>
    afterUpdate?: () => void | Promise<void>
    beforePlace?: (path: string) => void | Promise<void>
    afterPath?: (path: string) => void | Promise<void>
    afterRestore?: () => void | Promise<void>
    /** HI-3134: after the last pre-update read of the head, before `update-stale` is asked for (its recheck runs then). */
    beforeUpdateWrite?: () => void | Promise<void>
    /** HI-3099: right before phase 5's record (its `recordFrom` journalled). */
    beforeRecord?: () => void | Promise<void>
    /** Between a file's size read and its bytes read (tests: a writer growing it). */
    afterStat?: (path: string) => void | Promise<void>
    /** Each chunk a capped read takes from a file of the workspace (tests: the reader never passes its cap). */
    read?: (path: string, bytes: number) => void
  }
}

export interface RecoveryRequest {
  repo: string
  folder: string
  identity: WorkspaceIdentity
  journal: WorkspaceJournal
  /** The caller's operation still holds the folder. */
  fence: WorkspaceFence
  /** The folder's writers proved ended now (no session, the quiet probe). */
  quiet: () => Promise<boolean>
}

/**
 * What a recovery did: each path's outcome, by kind. A refusal says why, with the journal kept for a resume. `copies`: each
 * file it wrote beside its path (`beside` and `late`), relative to the folder with `/` (HI-2996: the window lists them);
 * `asides`: each file it moved aside and had to leave under that name (its path created again meanwhile); `x`: the commit
 * it kept (`xKept`), else null.
 */
export type RecoveryResult =
  | { ok: true; restored: string[]; beside: string[]; late: string[]; deletedLocally: string[]; kept: string[]; xKept: boolean; copies: { path: string; copy: string }[]; asides: { path: string; copy: string }[]; x: string | null; leftOut: string[] }
  | { ok: false; why: RecoveryRefusal; detail?: string; divergent?: RecoveryDivergent }

export type RecoveryRefusal = 'notStale' | 'busy' | 'unreadable' | 'link' | 'bounds' | 'preserve' | 'changing' | 'identity' | 'provenance' | 'update' | 'restore' | 'fence' | 'collision' | 'divergent'

/**
 * HI-3134: why a recovery was refused `divergent`: the commit the folder's checkout is (WS, `folder`) is still visible at
 * the head beside the commit the head gives the workspace now (HW, `head`); `same`: the same change (divergent), else
 * another. Full commit ids.
 */
export interface RecoveryDivergent {
  folder: string
  head: string
  same: boolean
}

interface Entry {
  path: string
  /** A file the folder holds (its bytes preserved), or one WS has that the folder deleted. */
  kind: 'file' | 'deleted'
  size: number
  sha256: string | null
  blob: string | null
  wsBlob: string | null
}

interface PathState {
  sub: 'planned' | 'aside' | 'done'
  aside: string
  recovered: string
  outcome?: 'already' | 'restored' | 'beside' | 'kept' | 'deletedLocally'
  /** The moved-aside file left under its name: its path was created again meanwhile (HI-2996: listed for the window). */
  asideKept?: boolean
}

interface Journal {
  token: string
  phase: 'planned' | 'preserved' | 'updated' | 'restoring' | 'restored'
  store: string
  workspace: string
  /** The folder's creation generation when recovery began: checked at entry and before every write (HR1, round 1). */
  generation: string
  folder: string
  S: string
  WS: string
  dir?: string
  manifestSha?: string
  P1?: string
  X?: string
  U?: string
  late?: string[]
  /** Each late path's copy, as written (HI-2996); none for a late deletion. */
  lateCopies?: Record<string, string>
  paths?: Record<string, PathState>
  /**
   * HI-3099 (HR3's round 1): phase 5's record's provenance, so a stop after it resumes. `recordFrom`: the operation head
   * right before the record, written first; `recorded`: the working copy's commit it recorded, written right after.
   */
  recordFrom?: string
  recorded?: string
  /** HI-3098: jj's line-ending conversion for this folder, read when recovery began (absent: `none`, as before). */
  eol?: EolConversion
}

const DEFAULT_BOUNDS = { files: 2000, bytes: 512 * 1024 * 1024 }
const SEP = '\u001f'
/** HI-3099: the record's collision wait polls this often, and gives up (`collision`, retryable) after this much waiting. */
const COLLISION_POLL_MS = 50
const COLLISION_CAP_MS = 3_000
const blobOf = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') // i18n-ignore: a protocol code, never wording

/** jj's `working-copy.eol-conversion` (HI-3098): `none` (the default) stores a file's bytes as they are. */
export type EolConversion = 'none' | 'input' | 'input-output'
/** How far into a file jj looks to decide it is binary (probed on 0.47.1, HI-3098). */
const EOL_WINDOW = 8192

/**
 * A file's bytes as jj stores them (HI-3098), so they compare with a commit's blobs. With `input` or `input-output` jj
 * stores every CRLF as LF, unless the file looks binary: a NUL in its first 8192 bytes, or a CR there followed by
 * anything but LF (a CR in the window's last byte, its next byte outside it, doesn't count). Probed on jj 0.47.1;
 * `.gitattributes` plays no part. With `none`, the bytes as they are.
 */
export function storedForm(bytes: Buffer, eol: EolConversion): Buffer {
  if (eol === 'none' || !bytes.includes(0x0d)) return bytes
  const end = Math.min(bytes.length, EOL_WINDOW)
  for (let i = 0; i < end; i++) {
    const b = bytes[i]
    if (b === 0x00) return bytes
    if (b === 0x0d && i + 1 < end && bytes[i + 1] !== 0x0a) return bytes
  }
  const out = Buffer.allocUnsafe(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue
    out[n++] = bytes[i]
  }
  return out.subarray(0, n)
}
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const norm = (p: string): string => p.split(/[\\/]+/).filter(Boolean).join('/')
const abs = (folder: string, rel: string): string => join(folder, ...rel.split('/'))

/** Writes a file durably: a temporary name, fsynced, then renamed into place. */
async function writeDurable(file: string, bytes: Buffer | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  const h = await open(tmp, 'wx')
  try {
    await h.writeFile(bytes)
    await h.sync()
  } finally {
    await h.close()
  }
  await rename(tmp, file)
}

/** A name beside `file` that doesn't exist yet: `<file><suffix>`, then `<file><suffix>-2`… */
function freeName(file: string, suffix: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${file}${suffix}${n === 1 ? '' : `-${n}`}`
    if (!existsSync(candidate)) return candidate
  }
}

/**
 * A file's bytes read from its opened handle, never more than `cap` bytes plus one byte to tell it is longer (HR1,
 * HI-2795 round 2): a file that grows after its size was read can't make the reader allocate past its bound. `over`
 * when it holds more than `cap`; null when it can't be opened or read. `seen`: told each chunk's size (tests).
 */
export async function readCapped(file: string, cap: number, seen?: (n: number) => void): Promise<Buffer | 'over' | null> {
  const h = await open(file, 'r').catch(() => null)
  if (!h) return null
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const want = Math.min(64 * 1024, cap + 1 - total)
      if (want <= 0) return 'over'
      const buf = Buffer.alloc(want)
      const { bytesRead } = await h.read(buf, 0, want, total)
      if (bytesRead === 0) break
      seen?.(bytesRead)
      chunks.push(buf.subarray(0, bytesRead))
      total += bytesRead
      if (total > cap) return 'over'
    }
    return Buffer.concat(chunks, total)
  } catch {
    return null
  } finally {
    await h.close().catch(() => undefined)
  }
}

/**
 * A copy of `src` beside its path under a name nobody has: `name` if free, else the next free one. Never overwrites
 * (an exclusive create, tried again on a name taken meanwhile). The name used.
 */
async function besideCopy(src: string, name: string): Promise<string> {
  for (let at = name, n = 2; ; at = `${name}-${n++}`) {
    try {
      await copyFile(src, at, constants.COPYFILE_EXCL)
      return at
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n > 1000) throw e
    }
  }
}

/** Every component of `rel` under `folder` a plain folder, and `rel` itself a regular file or absent; false: a link, a junction or another kind. */
async function plainPath(folder: string, rel: string): Promise<boolean> {
  const parts = rel.split('/')
  let at = folder
  for (let i = 0; i < parts.length; i++) {
    at = join(at, parts[i])
    const s = await lstat(at).catch(() => null)
    if (!s) return true
    if (s.isSymbolicLink()) return false
    if (i < parts.length - 1 ? !s.isDirectory() : !s.isFile()) return false
  }
  return resolve(at).toLowerCase().startsWith(resolve(folder).toLowerCase() + sep)
}

/** HI-3134: `update-stale`'s recheck found the operation head moved since the recovery's last decision. */
const HEAD_MOVED = 'headMoved'

export async function recoverStale(deps: RecoveryDeps, req: RecoveryRequest): Promise<RecoveryResult> {
  const { port, git } = deps
  const { folder, journal } = req
  const bounds = deps.bounds ?? DEFAULT_BOUNDS
  const refuse = (why: RecoveryRefusal, detail?: string): RecoveryResult => ({ ok: false, why, ...(detail ? { detail } : {}) })
  // Every write's precondition (HR1, round 1): the caller's operation still holds the folder, and the folder is still the
  // recorded workspace (its generation, name and store, read with no jj process). `fenced` adds the writers' quiescence
  // (the rename probe) at each phase's start; `mine` is checked before each step within a phase.
  const mine = async (): Promise<boolean> => (await req.fence.still()) && (await port.owns(folder, req.identity))
  const fenced = async (): Promise<boolean> => (await mine()) && (await req.quiet())

  let j = journal.read() as Journal | null
  /** The recovery's line-ending conversion (HI-3098), as journalled when it began. */
  const eolNow = (): EolConversion => j?.eol ?? 'none'
  if (j && (j.workspace !== req.identity.workspace || j.store.toLowerCase() !== req.identity.store.toLowerCase() || j.generation !== req.identity.generation || resolve(j.folder).toLowerCase() !== resolve(folder).toLowerCase())) return refuse('identity')
  // A folder that isn't the recorded workspace (a replacement at the same path, even of the same name and store) is
  // refused before anything is read or written, fresh or resumed.
  if (!(await port.owns(folder, req.identity))) return refuse('identity')
  const save = async (next: Journal): Promise<void> => {
    j = next
    await journal.write(next)
  }
  const store = req.identity.store

  /** The tree of a commit, from the Git store jj writes into: path → { mode, blob }. */
  const treeOf = async (commit: string): Promise<Map<string, { mode: string; blob: string }> | null> => {
    const r = await git(folder, [`--git-dir=${store}`, 'ls-tree', '-r', '-z', '--full-tree', commit])
    if (!r.ok) return null
    const m = new Map<string, { mode: string; blob: string }>()
    for (const rec of r.out.split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t')
      const [mode, , blob] = rec.slice(0, tab).split(' ')
      m.set(norm(rec.slice(tab + 1)), { mode, blob })
    }
    return m
  }

  /** The delta from WS as the folder is now: entries, or a refusal. */
  const scan = async (S: string, WS: string): Promise<Entry[] | RecoveryResult> => {
    const tracked = await port.jj(folder, ['file', 'list', '-r', WS], { op: S })
    if (!tracked.ok) return refuse('unreadable', tracked.err)
    const ws = await treeOf(WS)
    if (!ws) return refuse('unreadable', 'ls-tree')
    // What jj would snapshot: not ignored by .gitignore at any level, core.excludesFile, the store's info/exclude.
    const empty = join(deps.preserveRoot, `gitdir-${randomBytes(4).toString('hex')}`)
    await mkdir(deps.preserveRoot, { recursive: true })
    const init = await git(deps.preserveRoot, ['init', '--bare', '-q', empty])
    if (!init.ok) return refuse('unreadable', init.err)
    const others = await git(folder, [`--git-dir=${empty}`, `--work-tree=${folder}`, 'ls-files', '--others', '--exclude-standard', `--exclude-from=${join(store, 'info', 'exclude')}`, '-z'])
    await deps.trash(empty).catch(() => undefined)
    if (!others.ok) return refuse('unreadable', others.err)
    const set = new Set<string>()
    for (const p of lines(tracked.out)) set.add(norm(p))
    for (const p of others.out.split('\0').filter(Boolean)) if (!p.startsWith('.jj/') && !p.startsWith('.git/') && p !== '.git') set.add(norm(p))
    const out: Entry[] = []
    let bytes = 0
    for (const path of [...set].sort()) {
      const w = ws.get(path)
      if (w && w.mode !== '100644' && w.mode !== '100755') return refuse('link', path)
      if (!(await plainPath(folder, path))) return refuse('link', path)
      // Its size first (HR1, round 1): a file past what the bounds have left is refused before it is read.
      const st = await lstat(abs(folder, path)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined))
      if (st === undefined) return refuse('unreadable', path)
      if (st === null) {
        if (w) out.push({ path, kind: 'deleted', size: 0, sha256: null, blob: null, wsBlob: w.blob })
        if (out.length > bounds.files) return refuse('bounds')
        continue
      }
      if (bytes + st.size > bounds.bytes) return refuse('bounds')
      await deps.hooks?.afterStat?.(path)
      // Read capped at its size as stat said it (HR1, round 2): one that grew since is refused without being read whole.
      const buf = await readCapped(abs(folder, path), st.size, (n) => deps.hooks?.read?.(path, n))
      if (buf === null) return refuse('unreadable', path)
      if (buf === 'over' || buf.length !== st.size) return refuse('changing', path)
      // As jj will store it (HI-3098): compared with the commit's blob, and with X's later; its raw bytes are what is kept.
      const blob = blobOf(storedForm(buf, eolNow()))
      if (w && w.blob === blob) continue
      bytes += buf.length
      out.push({ path, kind: 'file', size: buf.length, sha256: sha256(buf), blob, wsBlob: w?.blob ?? null })
      if (out.length > bounds.files || bytes > bounds.bytes) return refuse('bounds')
    }
    return out
  }

  const sameDelta = (a: Entry[], b: Entry[]): boolean => a.length === b.length && a.every((e, i) => e.path === b[i].path && e.kind === b[i].kind && e.blob === b[i].blob)

  /** Preserves the delta's bytes in a new folder, durably, and reads them back. */
  const preserve = async (entries: Entry[], token: string): Promise<{ dir: string; manifestSha: string } | RecoveryResult> => {
    const dir = join(deps.preserveRoot, `${token}-${randomBytes(3).toString('hex')}`)
    try {
      for (const e of entries) {
        if (e.kind !== 'file') continue
        // The live file read again, capped at the size the scan saw: one that changed since is refused, never read whole.
        const buf = await readCapped(abs(folder, e.path), e.size, (n) => deps.hooks?.read?.(e.path, n))
        if (buf === null || buf === 'over' || sha256(buf) !== e.sha256) return refuse('changing', e.path)
        await writeDurable(join(dir, 'files', ...e.path.split('/')), buf)
      }
      const manifest = JSON.stringify({ entries })
      await writeDurable(join(dir, 'manifest.json'), manifest)
      const back = await readFile(join(dir, 'manifest.json'), 'utf8')
      if (back !== manifest) return refuse('preserve', 'manifest')
      for (const e of entries) if (e.kind === 'file' && sha256(await readFile(join(dir, 'files', ...e.path.split('/')))) !== e.sha256) return refuse('preserve', e.path)
      return { dir, manifestSha: sha256(Buffer.from(manifest)) }
    } catch (e) {
      return refuse('preserve', e instanceof Error ? e.message : String(e))
    }
  }

  /** The manifest of the journal's preservation, checked against its sha256; null when it doesn't match. */
  const manifestOf = async (cur: Journal): Promise<Entry[] | null> => {
    if (!cur.dir || !cur.manifestSha) return null
    const text = await readFile(join(cur.dir, 'manifest.json'), 'utf8').catch(() => null)
    if (text === null || sha256(Buffer.from(text)) !== cur.manifestSha) return null
    return (JSON.parse(text) as { entries: Entry[] }).entries
  }

  /**
   * HI-3134: the workspace's own recorded commit (WS, the folder's checkout) still visible at the head beside the commit
   * the head gives the workspace (HW): a record that raced another write, reconciled with the same change divergent (or
   * WS left beside another commit). `update-stale` would check HW out and take WS's files out of the folder, where only
   * WS holds them: refused, naming both, nothing changed. Read pinned at the head; unreadable fails closed. Otherwise the
   * head it was decided at, which `update-stale`'s recheck compares again (HR1's round 1).
   */
  const leftBeside = async (WS: string, workspace: string): Promise<RecoveryResult | { head: string }> => {
    const head = await port.pinned(folder)
    if (isUnknown(head)) return refuse('unreadable', head.detail ?? head.what)
    const hw = await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(workspace)}@`, '-T', 'commit_id ++ " " ++ change_id'], { op: head })
    const [HW, hwChange] = hw.ok ? hw.out.trim().split(' ') : []
    if (!HW || !/^[0-9a-f]{40}$/.test(HW) || !hwChange) return refuse('unreadable', hw.ok ? 'HW' : hw.err)
    if (HW === WS) return { head }
    // Visible at the head: an ancestor of a visible head (a hidden commit, abandoned or rewritten, isn't).
    const ws = await port.jj(folder, ['log', '--no-graph', '-r', `${WS} & ::visible_heads()`, '-T', 'change_id'], { op: head })
    if (!ws.ok) return refuse('unreadable', ws.err)
    const wsChange = ws.out.trim()
    if (!wsChange) return { head }
    return { ok: false, why: 'divergent', divergent: { folder: WS, head: HW, same: wsChange === hwChange } } // i18n-ignore: a refusal's code, said in words in the window
  }

  // 1. planned
  if (!j) {
    if (!(await fenced())) return refuse('busy')
    const stale = await port.stale(folder)
    if (isUnknown(stale)) return refuse('unreadable', stale.detail ?? stale.what)
    if (!stale) return refuse('notStale')
    const co = await checkoutOf(folder)
    if (!co || co.name !== req.identity.workspace) return refuse('identity')
    const ws = await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(co.name)}@`, '-T', 'commit_id'], { op: co.op })
    if (!ws.ok || !/^[0-9a-f]{40}$/.test(ws.out.trim())) return refuse('unreadable', ws.err)
    // HI-3098: the folder's bytes are compared with commits as jj will store them, under this folder's own setting
    // (user, repository or workspace config). Anything but its three values: refused, nothing changed.
    const conv = await port.jj(folder, ['config', 'get', 'working-copy.eol-conversion'], { op: co.op })
    const eol = conv.ok ? conv.out.trim() : ''
    if (eol !== 'none' && eol !== 'input' && eol !== 'input-output') return refuse('unreadable', conv.ok ? `eol-conversion ${eol}` : conv.err) // i18n-ignore: a protocol detail, never wording
    // HI-3134: refused before anything is written (no journal, no preservation).
    const beside = await leftBeside(ws.out.trim(), co.name)
    if ('ok' in beside) return beside
    await save({ token: `r-${randomBytes(6).toString('hex')}`, phase: 'planned', store, workspace: co.name, generation: req.identity.generation, folder: resolve(folder), S: co.op, WS: ws.out.trim(), ...(eol !== 'none' ? { eol } : {}) })
  }
  let cur = j as unknown as Journal

  // 2. preserved (again from planned: a stop before the copy was complete)
  if (cur.phase === 'planned') {
    if (!(await fenced())) return refuse('busy')
    const entries = await scan(cur.S, cur.WS)
    if (!Array.isArray(entries)) return entries
    const kept = await preserve(entries, cur.token)
    if ('ok' in kept) return kept
    await save({ ...cur, phase: 'preserved', ...kept })
    cur = j as unknown as Journal
    await deps.hooks?.afterPreserve?.()
  }

  // 3. updated
  if (cur.phase === 'preserved') {
    const stillStale = await port.stale(folder)
    if (isUnknown(stillStale)) return refuse('unreadable', stillStale.detail ?? stillStale.what)
    if (stillStale) {
      // A rescan right before jj runs: anything changed since the preservation is preserved again (three tries).
      for (let tries = 0; ; tries++) {
        if (!(await fenced())) return refuse('busy')
        const manifest = await manifestOf(cur)
        if (!manifest) return refuse('preserve', 'manifest')
        const now = await scan(cur.S, cur.WS)
        if (!Array.isArray(now)) return now
        if (sameDelta(now, manifest)) break
        if (tries === 2) return refuse('changing')
        const kept = await preserve(now, cur.token)
        if ('ok' in kept) return kept
        await save({ ...cur, ...kept })
        cur = j as unknown as Journal
      }
      await deps.hooks?.beforeUpdate?.()
      // HI-3134: again right before jj's update, whatever phase this recovery resumed from; the journal kept.
      const beside = await leftBeside(cur.WS, cur.workspace)
      if ('ok' in beside) return beside
      // The head that decision was made at, compared again in the write's recheck (HR1's round 1): moved meanwhile, the
      // decision is made again, never jj's update on a head it wasn't made for.
      const headsNow = await port.headsNow(folder)
      if (!headsNow) return refuse('unreadable', 'op heads') // i18n-ignore: a refusal's detail (English, for the log)
      await deps.hooks?.beforeUpdateWrite?.()
      if (!(await mine())) return refuse('fence')
      // The whole proof again under the file gate's admission, right before jj starts (HI-2918; with HI-2913's held path,
      // its held fence unsplit and in its own order).
      const up = await port.jj(folder, ['workspace', 'update-stale'], { write: true, recheck: async () => (!(await mine()) ? 'fence' : headsNow() !== beside.head ? HEAD_MOVED : null) })
      if (up.refused === HEAD_MOVED) {
        const again = await leftBeside(cur.WS, cur.workspace)
        return 'ok' in again ? again : refuse('changing', 'the operation head moved before the update') // i18n-ignore: a refusal's detail (English, for the log)
      }
      if (up.refused) return refuse('fence')
      if (!up.ok && (await port.stale(folder)) === true) return refuse('update', up.err)
    }
    await deps.hooks?.afterUpdate?.()
    // P1 by its exact shape, X what it recorded, U the updated working copy (at the head op now).
    const head = await port.pinned(folder)
    if (isUnknown(head)) return refuse('provenance', head.detail ?? head.what)
    const log = await port.jj(folder, ['op', 'log', '--no-graph', '--limit', '500', '-T', `id ++ "${SEP}" ++ parents.map(|p| p.id()).join(",") ++ "${SEP}" ++ snapshot ++ "${SEP}" ++ workspace_name ++ "\\n"`], { op: head })
    if (!log.ok) return refuse('provenance', log.err)
    const p1 = lines(log.out).map((l) => l.split(SEP)).filter(([, parents, snap, ws]) => parents === cur.S && snap === 'true' && ws === `${cur.workspace}@`)
    if (p1.length > 1) return refuse('provenance', 'several')
    const P1 = p1[0]?.[0]
    const X = P1 ? (await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(cur.workspace)}@`, '-T', 'commit_id'], { op: P1 })).out.trim() : ''
    if (P1 && !/^[0-9a-f]{40}$/.test(X)) return refuse('provenance', 'X')
    const U = (await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(cur.workspace)}@`, '-T', 'commit_id'], { op: head })).out.trim()
    if (!/^[0-9a-f]{40}$/.test(U)) return refuse('provenance', 'U')
    if (!P1 && (await port.stale(folder)) !== false) return refuse('provenance', 'no snapshot op') // i18n-ignore: a protocol code, never wording
    // A write jj recorded after the rescan (X's version differs from the manifest's): beside its path, X kept.
    const late: string[] = []
    const lateCopies: Record<string, string> = {}
    if (P1) {
      const manifest = await manifestOf(cur)
      const ws = await treeOf(cur.WS)
      const x = await treeOf(X)
      if (!manifest || !ws || !x) return refuse('unreadable', 'trees')
      const byPath = new Map(manifest.map((e) => [e.path, e]))
      const paths = new Set([...ws.keys(), ...x.keys()])
      for (const path of [...paths].sort()) {
        const before = ws.get(path)?.blob ?? null
        const after = x.get(path)?.blob ?? null
        if (before === after) continue
        const e = byPath.get(path)
        const preserved = e ? (e.kind === 'deleted' ? null : e.blob) : before
        if (after === preserved) continue
        if (after === null) {
          late.push(path)
          continue
        }
        const bytes = await git(folder, [`--git-dir=${store}`, 'cat-file', 'blob', after])
        if (!bytes.ok) return refuse('unreadable', path)
        if (!(await plainPath(folder, path))) return refuse('link', path)
        if (!(await mine())) return refuse('fence')
        const name = freeName(abs(folder, path), `.cw-recovered-${cur.token}-late`)
        await mkdir(dirname(name), { recursive: true })
        await writeFile(name, bytes.buf, { flag: 'wx' })
        late.push(path)
        lateCopies[path] = name
      }
    }
    await save({ ...cur, phase: 'updated', ...(P1 ? { P1, X } : {}), U, late, lateCopies })
    cur = j as unknown as Journal
  }

  // 4. restoring, path by path, journalled before each filesystem step.
  if (cur.phase === 'updated' || cur.phase === 'restoring') {
    if (!(await fenced())) return refuse('busy')
    const manifest = await manifestOf(cur)
    const u = cur.U ? await treeOf(cur.U) : null
    if (!manifest || !u) return refuse('unreadable', 'manifest or U') // i18n-ignore: a protocol code, never wording
    const paths: Record<string, PathState> = { ...cur.paths }
    if (cur.phase === 'updated') await save({ ...cur, phase: 'restoring', paths })
    for (const e of manifest) {
      cur = j as unknown as Journal
      const st = paths[e.path]
      if (st?.sub === 'done') continue
      if (!(await mine())) return refuse('fence')
      const target = abs(folder, e.path)
      if (!(await plainPath(folder, e.path))) return refuse('link', e.path)
      const preservedFile = e.kind === 'file' ? join(cur.dir!, 'files', ...e.path.split('/')) : null
      const setPath = async (s: PathState): Promise<void> => {
        paths[e.path] = s
        await save({ ...cur, paths: { ...paths } })
      }
      // Already as preserved (a resume after the step, or nothing to do): done.
      // Read capped at the preserved size (HR1, round 2): a live file never read past what it is compared with.
      const nowThere = existsSync(target)
      const nowBuf = nowThere && e.kind === 'file' ? await readCapped(target, e.size, (n) => deps.hooks?.read?.(e.path, n)) : null
      if (!st && ((e.kind === 'file' && Buffer.isBuffer(nowBuf) && sha256(nowBuf) === e.sha256) || (e.kind === 'deleted' && !nowThere))) {
        await setPath({ sub: 'done', aside: '', recovered: '', outcome: 'already' }) // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
        continue
      }
      let s: PathState = st ?? { sub: 'planned', aside: freeName(target, `.cw-before-recovery-${cur.token}`), recovered: freeName(target, `.cw-recovered-${cur.token}`) } // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
      if (!st) await setPath(s)
      if (s.sub === 'planned') {
        // The atomic move aside (or none: absent). A resume finds it done when the aside exists.
        if (!existsSync(s.aside) && existsSync(target)) await rename(target, s.aside)
        s = { ...s, sub: 'aside' } // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
        await setPath(s)
      }
      await deps.hooks?.beforePlace?.(e.path)
      if (!(await mine())) return refuse('fence')
      // The moved-aside file, read capped at the delta's byte bound: past it, it equals no version compared with.
      const asideThere = existsSync(s.aside)
      const asideRead = asideThere ? await readCapped(s.aside, bounds.bytes, (n) => deps.hooks?.read?.(e.path, n)) : null
      const C = Buffer.isBuffer(asideRead) ? blobOf(storedForm(asideRead, eolNow())) : asideThere ? 'unreadable or past the bound' : null // i18n-ignore: a value no blob equals, never shown
      const U = u.get(e.path)?.blob ?? null
      const WS = e.wsBlob
      let outcome: PathState['outcome']
      if (U === WS && C === WS) {
        // Nobody changed it: as preserved, never over a file created meanwhile.
        if (e.kind === 'file') {
          await mkdir(dirname(target), { recursive: true })
          try {
            await copyFile(preservedFile!, target, constants.COPYFILE_EXCL)
            outcome = 'restored'
          } catch {
            s = { ...s, recovered: await besideCopy(preservedFile!, s.recovered) }
            outcome = 'beside'
          }
        } else outcome = existsSync(target) ? 'kept' : 'restored'
        if (asideThere) await unlink(s.aside)
      } else {
        // An overlap (an upstream change, a later write, a deletion against an edit): the current file back as it was,
        // the preserved version beside it, or the local deletion listed.
        if (asideThere) {
          try {
            await copyFile(s.aside, target, constants.COPYFILE_EXCL)
            await unlink(s.aside)
          } catch {
            // The path was recreated meanwhile: the moved-aside file keeps its unique name, and the result says so.
            s = { ...s, asideKept: existsSync(s.aside) }
          }
        }
        if (e.kind === 'file') s = { ...s, recovered: await besideCopy(preservedFile!, s.recovered) }
        outcome = e.kind === 'file' ? 'beside' : 'deletedLocally'
      }
      await setPath({ ...s, sub: 'done', outcome }) // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
      await deps.hooks?.afterPath?.(e.path)
    }
    // Each outcome verified: what it says is on disk.
    for (const e of manifest) {
      const st = paths[e.path]
      const target = abs(folder, e.path)
      const at = st.outcome === 'beside' ? st.recovered : st.outcome === 'restored' || st.outcome === 'already' ? target : null
      const back = at && e.kind === 'file' ? await readCapped(at, e.size) : null
      if (at && e.kind === 'file' && !(Buffer.isBuffer(back) && sha256(back) === e.sha256)) return refuse('restore', e.path)
    }
    await save({ ...(j as unknown as Journal), phase: 'restored', paths })
    cur = j as unknown as Journal
    await deps.hooks?.afterRestore?.()
  }

  // 5. restored: recorded, X tidied only when it is exactly the preserved delta and nobody else's, the copy trashed.
  const manifest = (await manifestOf(cur)) ?? []
  const paths = cur.paths ?? {}
  if (!(await fenced())) return refuse('busy')
  // HI-3099: after `update-stale` over an operation the user abandoned (`jj op abandon`), the working copy U is a divergent
  // sibling of X (the same change, parents and author time). Recording the restored files then makes a commit identical
  // to X while the clock is still in X's committer second (Git's timestamps are whole seconds), which jj refuses ("already
  // exists"). So, while U and X share a change and that second hasn't passed, the record waits, polled, capped by the
  // waits it made (never the wall clock, which can move back), and stops at once when the fence is lost. At the cap:
  // `collision`, at the cap or a fence lost: nothing recorded or abandoned, the journal still `restored`, the preserved copy
  // and the restored files as they are, so Recover… again resumes here. Re-read after the last wait: U, X, the head; the
  // record's own owned guard (identity and fence) at its write.
  // A resume after this phase's own record (HR3's round 1; HR1's round 2: any number of stops): the working copy is no
  // longer U but a record of this phase's, proved by the journal: `recorded`, the working copy the last attempt accepted
  // or recorded, or `recordFrom`'s operation (the one snapshot of this workspace made directly on the head the last
  // attempt recorded from, whose working copy is the current one). Then nothing waits (U is rewritten already): the
  // record again records only what changed since. Anything else that moved the working copy is still refused.
  let ours = false
  let accepted: string | null = null
  const wsAt = async (op: string): Promise<string | null> => {
    const r = await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(cur.workspace)}@`, '-T', 'commit_id'], { op })
    return r.ok && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null
  }
  if (cur.X && cur.U && (cur.recorded || cur.recordFrom)) {
    const head = await port.pinned(folder)
    if (isUnknown(head)) return refuse('provenance', head.detail ?? head.what)
    const now = await wsAt(head)
    if (!now) return refuse('provenance', 'U')
    if (now !== cur.U) {
      ours = now === cur.recorded
      if (!ours && cur.recordFrom) {
        const log = await port.jj(folder, ['op', 'log', '--no-graph', '--limit', '500', '-T', `id ++ "${SEP}" ++ parents.map(|p| p.id()).join(",") ++ "${SEP}" ++ snapshot ++ "${SEP}" ++ workspace_name ++ "\\n"`], { op: head })
        if (!log.ok) return refuse('provenance', log.err)
        const snaps = lines(log.out).map((l) => l.split(SEP)).filter(([, parents, snap, ws]) => parents === cur.recordFrom && snap === 'true' && ws === `${cur.workspace}@`)
        ours = snaps.length === 1 && (await wsAt(snaps[0][0])) === now
      }
      if (!ours) return refuse('provenance', 'U or X') // i18n-ignore: a protocol code, never wording
      accepted = now
    }
  }
  if (cur.X && cur.U && !ours) {
    const clock = deps.clock ?? { now: () => Date.now(), wait: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)) }
    for (let waited = 0; ; waited += COLLISION_POLL_MS) {
      const head = await port.pinned(folder)
      if (isUnknown(head)) return refuse('provenance', head.detail ?? head.what)
      const read = await port.jj(folder, ['log', '--no-graph', '-r', `${revsetName(cur.workspace)}@ | ${cur.X}`, '-T', `commit_id ++ "${SEP}" ++ change_id ++ "${SEP}" ++ committer.timestamp().format("%s") ++ "\\n"`], { op: head })
      if (!read.ok) return refuse('provenance', read.err)
      const rows = lines(read.out).map((l) => l.split(SEP))
      const x = rows.find(([c]) => c === cur.X)
      const u = rows.find(([c]) => c !== cur.X)
      // The working copy is still U (nothing recorded since the update), X still there: else not this recovery's shape.
      if (!x || (u && u[0] !== cur.U)) return refuse('provenance', 'U or X') // i18n-ignore: a protocol code, never wording
      const second = Number(x[2])
      if (!Number.isFinite(second)) return refuse('provenance', 'X time') // i18n-ignore: a protocol code, never wording
      if (!u || u[1] !== x[1] || Math.floor(clock.now() / 1000) > second) break
      if (waited >= COLLISION_CAP_MS) return refuse('collision')
      if (!(await mine())) return refuse('fence')
      await clock.wait(COLLISION_POLL_MS)
    }
  }
  if (cur.X && cur.U) {
    // The record's provenance first, on every attempt (HR3's round 1, HR1's round 2): the head it starts from, and the
    // working copy it starts on when that is already a record of this phase's (none: U).
    const from = await port.pinned(folder)
    if (isUnknown(from)) return refuse('provenance', from.detail ?? from.what)
    const { recorded: _was, ...rest } = cur
    await save({ ...rest, recordFrom: from, ...(accepted ? { recorded: accepted } : {}) })
    cur = j as unknown as Journal
  }
  await deps.hooks?.beforeRecord?.()
  const rec = await port.recordLeftOut(folder, req.fence, req.identity)
  if (isUnknown(rec)) return refuse('fence', rec.detail ?? rec.what)
  // …and what it recorded, so a stop from here on resumes as this record's.
  if (cur.X && cur.U) {
    const head = await port.pinned(folder)
    const now = isUnknown(head) ? null : await wsAt(head)
    if (now && now !== cur.U && now !== cur.recorded) {
      await save({ ...cur, recorded: now })
      cur = j as unknown as Journal
    }
  }
  // New files jj leaves out for its size limit (HI-2973) are in the manifest but in no commit (X can't hold them): put
  // back on disk all the same, and named in the result; the slot's next record lists them as uncommitted.
  const leftOut = new Set(rec.leftOut.map((p) => p.replace(/\\/g, '/')))
  let xKept = !!cur.X
  if (cur.X && !(cur.late ?? []).length) {
    const head = await port.pinned(folder)
    if (!isUnknown(head)) {
      const safe = await port.jj(folder, ['log', '--no-graph', '-r', `${cur.X} & ~::(visible_heads() ~ ${cur.X}) & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], { op: head })
      const x = await treeOf(cur.X)
      const ws = await treeOf(cur.WS)
      const exact = !!x && !!ws && manifest.every((e) => leftOut.has(e.path) || (x.get(e.path)?.blob ?? null) === (e.kind === 'file' ? e.blob : null)) && [...x.keys()].every((p) => manifest.some((e) => e.path === p) || x.get(p)?.blob === ws.get(p)?.blob)
      if (safe.ok && lines(safe.out).length === 1 && exact && (await mine())) {
        const ab = await port.jj(folder, ['abandon', cur.X], { write: true, recheck: async () => ((await mine()) ? null : 'fence') })
        xKept = !ab.ok
      }
    }
  }
  if (cur.dir) await deps.trash(cur.dir).catch(() => undefined)
  await journal.clear()
  const by = (o: PathState['outcome']): string[] => Object.entries(paths).filter(([, s]) => s.outcome === o).map(([p]) => p)
  const rel = (file: string): string => norm(relative(folder, file))
  const copies = [...Object.entries(paths).filter(([, s]) => s.outcome === 'beside').map(([path, s]) => ({ path, copy: rel(s.recovered) })), ...Object.entries(cur.lateCopies ?? {}).map(([path, copy]) => ({ path, copy: rel(copy) }))]
  const asides = Object.entries(paths).filter(([, s]) => s.asideKept).map(([path, s]) => ({ path, copy: rel(s.aside) }))
  return { ok: true, restored: by('restored'), beside: by('beside'), late: cur.late ?? [], deletedLocally: by('deletedLocally'), kept: by('kept'), xKept, copies, asides, x: xKept ? (cur.X ?? null) : null, leftOut: [...leftOut] }
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length)
