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
import { dirname, join, resolve, sep } from 'path'
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
  /** Test seams, run between steps. */
  hooks?: {
    afterPreserve?: () => void | Promise<void>
    beforeUpdate?: () => void | Promise<void>
    afterUpdate?: () => void | Promise<void>
    beforePlace?: (path: string) => void | Promise<void>
    afterPath?: (path: string) => void | Promise<void>
    afterRestore?: () => void | Promise<void>
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

/** What a recovery did: each path's outcome, by kind. A refusal says why, with the journal kept for a resume. */
export type RecoveryResult =
  | { ok: true; restored: string[]; beside: string[]; late: string[]; deletedLocally: string[]; kept: string[]; xKept: boolean }
  | { ok: false; why: RecoveryRefusal; detail?: string }

export type RecoveryRefusal = 'notStale' | 'busy' | 'unreadable' | 'link' | 'bounds' | 'preserve' | 'changing' | 'identity' | 'provenance' | 'update' | 'restore' | 'fence'

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
}

interface Journal {
  token: string
  phase: 'planned' | 'preserved' | 'updated' | 'restoring' | 'restored'
  store: string
  workspace: string
  folder: string
  S: string
  WS: string
  dir?: string
  manifestSha?: string
  P1?: string
  X?: string
  U?: string
  late?: string[]
  paths?: Record<string, PathState>
}

const DEFAULT_BOUNDS = { files: 2000, bytes: 512 * 1024 * 1024 }
const SEP = '\u001f'
const blobOf = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') // i18n-ignore: a protocol code, never wording
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

export async function recoverStale(deps: RecoveryDeps, req: RecoveryRequest): Promise<RecoveryResult> {
  const { port, git } = deps
  const { folder, journal } = req
  const bounds = deps.bounds ?? DEFAULT_BOUNDS
  const refuse = (why: RecoveryRefusal, detail?: string): RecoveryResult => ({ ok: false, why, ...(detail ? { detail } : {}) })
  const fenced = async (): Promise<boolean> => (await req.fence.still()) && (await req.quiet())

  let j = journal.read() as Journal | null
  if (j && (j.workspace !== req.identity.workspace || j.store.toLowerCase() !== req.identity.store.toLowerCase() || resolve(j.folder).toLowerCase() !== resolve(folder).toLowerCase())) return refuse('identity')
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
      const buf = await readFile(abs(folder, path)).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined))
      if (buf === undefined) return refuse('unreadable', path)
      if (buf === null) {
        if (w) out.push({ path, kind: 'deleted', size: 0, sha256: null, blob: null, wsBlob: w.blob })
        continue
      }
      const blob = blobOf(buf)
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
        const buf = await readFile(abs(folder, e.path))
        if (sha256(buf) !== e.sha256) return refuse('changing', e.path)
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
    await save({ token: `r-${randomBytes(6).toString('hex')}`, phase: 'planned', store, workspace: co.name, folder: resolve(folder), S: co.op, WS: ws.out.trim() })
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
      if (!(await req.fence.still())) return refuse('fence')
      const up = await port.jj(folder, ['workspace', 'update-stale'], { write: true })
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
        const name = freeName(abs(folder, path), `.cw-recovered-${cur.token}-late`)
        await mkdir(dirname(name), { recursive: true })
        await writeFile(name, bytes.buf, { flag: 'wx' })
        late.push(path)
      }
    }
    await save({ ...cur, phase: 'updated', ...(P1 ? { P1, X } : {}), U, late })
    cur = j as unknown as Journal
  }

  // 4. restoring, path by path, journalled before each filesystem step.
  if (cur.phase === 'updated' || cur.phase === 'restoring') {
    const manifest = await manifestOf(cur)
    const u = cur.U ? await treeOf(cur.U) : null
    if (!manifest || !u) return refuse('unreadable', 'manifest or U') // i18n-ignore: a protocol code, never wording
    const paths: Record<string, PathState> = { ...cur.paths }
    if (cur.phase === 'updated') await save({ ...cur, phase: 'restoring', paths })
    for (const e of manifest) {
      cur = j as unknown as Journal
      const st = paths[e.path]
      if (st?.sub === 'done') continue
      if (!(await req.fence.still())) return refuse('fence')
      const target = abs(folder, e.path)
      if (!(await plainPath(folder, e.path))) return refuse('link', e.path)
      const preservedFile = e.kind === 'file' ? join(cur.dir!, 'files', ...e.path.split('/')) : null
      const setPath = async (s: PathState): Promise<void> => {
        paths[e.path] = s
        await save({ ...cur, paths: { ...paths } })
      }
      // Already as preserved (a resume after the step, or nothing to do): done.
      const nowBuf = await readFile(target).catch(() => null)
      if (!st && ((e.kind === 'file' && nowBuf && sha256(nowBuf) === e.sha256) || (e.kind === 'deleted' && !nowBuf))) {
        await setPath({ sub: 'done', aside: '', recovered: '', outcome: 'already' }) // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
        continue
      }
      let s: PathState = st ?? { sub: 'planned', aside: freeName(target, `.cw-before-recovery-${cur.token}`), recovered: freeName(target, `.cw-recovered-${cur.token}`) } // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
      if (!st) await setPath(s)
      if (s.sub === 'planned') {
        // The atomic move aside (or none: absent). A resume finds it done when the aside exists.
        if (!existsSync(s.aside) && nowBuf) await rename(target, s.aside)
        s = { ...s, sub: 'aside' } // i18n-ignore: a protocol value (journal phase, hash header or refusal detail), never shown
        await setPath(s)
      }
      await deps.hooks?.beforePlace?.(e.path)
      const asideBuf = await readFile(s.aside).catch(() => null)
      const C = asideBuf ? blobOf(asideBuf) : null
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
        if (asideBuf) await unlink(s.aside)
      } else {
        // An overlap (an upstream change, a later write, a deletion against an edit): the current file back as it was,
        // the preserved version beside it, or the local deletion listed.
        if (asideBuf) {
          try {
            await copyFile(s.aside, target, constants.COPYFILE_EXCL)
            await unlink(s.aside)
          } catch {
            // The path was recreated meanwhile: the moved-aside file keeps its unique name.
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
      if (at && e.kind === 'file' && sha256(await readFile(at).catch(() => Buffer.alloc(0))) !== e.sha256) return refuse('restore', e.path)
    }
    await save({ ...(j as unknown as Journal), phase: 'restored', paths })
    cur = j as unknown as Journal
    await deps.hooks?.afterRestore?.()
  }

  // 5. restored: recorded, X tidied only when it is exactly the preserved delta and nobody else's, the copy trashed.
  const manifest = (await manifestOf(cur)) ?? []
  const paths = cur.paths ?? {}
  const rec = await port.record!(folder, req.fence, req.identity)
  if (isUnknown(rec)) return refuse('fence', rec.detail ?? rec.what)
  let xKept = !!cur.X
  if (cur.X && !(cur.late ?? []).length) {
    const head = await port.pinned(folder)
    if (!isUnknown(head)) {
      const safe = await port.jj(folder, ['log', '--no-graph', '-r', `${cur.X} & ~::(visible_heads() ~ ${cur.X}) & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], { op: head })
      const x = await treeOf(cur.X)
      const ws = await treeOf(cur.WS)
      const exact = !!x && !!ws && manifest.every((e) => (x.get(e.path)?.blob ?? null) === (e.kind === 'file' ? e.blob : null)) && [...x.keys()].every((p) => manifest.some((e) => e.path === p) || x.get(p)?.blob === ws.get(p)?.blob)
      if (safe.ok && lines(safe.out).length === 1 && exact) {
        const ab = await port.jj(folder, ['abandon', cur.X], { write: true })
        xKept = !ab.ok
      }
    }
  }
  if (cur.dir) await deps.trash(cur.dir).catch(() => undefined)
  await journal.clear()
  const by = (o: PathState['outcome']): string[] => Object.entries(paths).filter(([, s]) => s.outcome === o).map(([p]) => p)
  return { ok: true, restored: by('restored'), beside: by('beside'), late: cur.late ?? [], deletedLocally: by('deletedLocally'), kept: by('kept'), xKept }
}

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length)
