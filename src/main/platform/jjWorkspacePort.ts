// jj's workspace lifecycle port (SPEC §16.3.6 port 2, HI-2795's J2): slots and copies as jj workspaces, made by
// `jj workspace add` and nothing else (R2.6: never `jj git init`, never a Git worktree command on them). Not registered
// (workspacePorts.ts' PORTS): a pool or copy pool gets it by injection only, until J6 switches a project to jj.
//
// What it answers, and why (the design, HI-2795/s21):
// - jj has no current bookmark (0.47.1's bookmarks.md): a workspace's line is always null, and every line operation
//   (prepare, attach, createOnNewLine, dropLine, restoreLine) and detach are refused until J3/J4 freeze them.
// - Reads are pinned: the one operation head (read from the store's op_heads, refused when there are several) confirmed
//   by jj, then every read `--at-op <id> --ignore-working-copy`, which never snapshots and never reconciles diverged
//   heads (HB3's note: a plain `--ignore-working-copy` read can write a reconcile operation).
// - A read can't see edits jj hasn't recorded (probed: `--ignore-working-copy status` in a stale workspace says "no
//   changes"), so `dirty` is unknown; `record` is the explicit snapshot, only for the holder of the folder's operation.
// - Staleness: the operation the folder's files were last updated at (`.jj/working_copy/checkout`, a hint confirmed by
//   jj) names another working-copy commit than the head does: stale, so unknown, never clean, lent, reset or removed.
// - `add` and `forget` snapshot the workspace they run from and refuse `--ignore-working-copy` (probed), so they run
//   from a control workspace of Combwork's own, sparse and empty (no file to snapshot), made once per project.
// - Removal is `forget`, read back, then the folder to the Recycle Bin, journalled; the folder's creation generation
//   (its file ids) is checked right before the trash, so a folder replaced at the same path is never trashed.

import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'original-fs'
import { lstat, mkdir, readdir, readFile, realpath, rmdir, stat } from 'original-fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { jjSupported } from '../../shared/jjTool'
import { UNREADABLE } from '../../shared/workflow/texts'
import { isUnknown, unknown, withDetail, type Maybe, type Unknown } from './types'
import { jjContextOf, type JjContext } from './jjDetect'
import { jjRunner, type JjRunner, type JjRunResult } from './jjRunner'
import type { OwnedWrite, WorkspaceHeads, WorkspaceIdentity, WorkspaceJournal, WorkspaceListing, WorkspacePort, WorkspaceStep } from './workspacePort'
import { chainIsBinding, isJjLineKey, parseJjLineKey, sameBinding, type JjBinding, type JjPrepJournal, type JjPrepStore } from './jjSlotPrep'

/** Why a jj workspace step was refused (a protocol code: the pool words what it shows). */
export const JJ_REFUSED = {
  line: 'jj workspaces have no checked-out line: not supported until J4', // i18n-ignore: jj's side of an error, in English as jj's messages are
  stale: 'the workspace is stale', // i18n-ignore: jj's side of an error, in English as jj's messages are
  divergent: 'the workspace is divergent', // i18n-ignore: jj's side of an error, in English as jj's messages are
  identity: 'the folder is not the workspace recorded', // i18n-ignore: jj's side of an error, in English as jj's messages are
  fence: 'the operation no longer holds the folder', // i18n-ignore: jj's side of an error, in English as jj's messages are
  heads: 'the repository has several operation heads', // i18n-ignore: jj's side of an error, in English as jj's messages are
  control: "Combwork's control workspace isn't ready", // i18n-ignore: jj's side of an error, in English as jj's messages are
  nested: 'the folder is inside another repository or workspace', // i18n-ignore: jj's side of an error, in English as jj's messages are
  exists: 'the folder exists already', // i18n-ignore: jj's side of an error, in English as jj's messages are
  tool: 'jj is not the version Combwork is tested with', // i18n-ignore: jj's side of an error, in English as jj's messages are
  notEmpty: "the workspace's working copy isn't empty", // i18n-ignore: jj's side of an error, in English as jj's messages are
  generation: "the folder's file ids can't be read", // i18n-ignore: as above
  superseded: "the slot's binding changed since this preparation began", // i18n-ignore: as above
  unintegrated: "the slot holds work that isn't its last card's integrated work", // i18n-ignore: as above
  notIntegrated: "the slot's last card's work isn't in its target yet", // i18n-ignore: as above
  base: "the card's base isn't a visible commit", // i18n-ignore: as above
  moved: 'the repository changed since the check', // i18n-ignore: as above
  uncertain: "a write's result couldn't be read back: decided on the next pass", // i18n-ignore: as above
  notBound: "the slot isn't bound to that card's preparation", // i18n-ignore: as above
  journal: "the preparation's record can't be read" // i18n-ignore: as above
} as const

/** What jj's port needs beside jj: where a project's control workspace goes and its record, and the trash and the lock. */
export interface JjPortDeps {
  runner?: JjRunner
  /** The project's control workspace: its folder (in the project's worktrees folder) and the record of it (board_meta). */
  control: (repo: string) => { folder: string; journal: WorkspaceJournal }
  /**
   * The project folder held against agent launches while its control is made (HI-2887: the app's launch hold), which
   * snapshots the project folder's working copy once (Darren's r9 on HI-2887: automatically, with no Combwork agent in
   * the project folder). Refused (who is there) when an agent works in it or is starting there.
   */
  projectHold: (repo: string) => { release: () => void } | { busy: string }
  /**
   * Whether a control that was ready once and is lost may be made again automatically (another snapshot of the project
   * folder): only on the user's decision covering it (HI-2887). Absent: never; the loss is reported and refused.
   */
  remakeAllowed?: () => boolean
  /** Told when a control was made (the project folder's working copy recorded once), for the log. */
  made?: (repo: string, ws: string) => void
  /** The store's repository lock (R1.1: one store, one lock), held around add, forget and the control's making. */
  lock: <T>(store: string, fn: () => Promise<T>) => Promise<T>
  /** The Recycle Bin (trash.ts), or a test's. */
  trash: (path: string) => Promise<void>
  /**
   * Where a store's slot bindings and preparation journals live (HI-2866: board_meta, jjSlotPrep.ts), or null where none
   * is kept (then no slot is bound: `line` answers none, `prepare` and `detach` refuse).
   */
  prep?: (store: string) => JjPrepStore | null
  /**
   * §16.3.2's containment test on the backing Git store (J5's fallback, gitHistory.contains): a previous card's submitted
   * work in its target before its slot is reused. Absent: such a slot is never reused (kept).
   */
  contains?: (store: string, target: string, change: { base: string; revision: string }, at: string) => Promise<Maybe<unknown | null>>
  /** Test hooks, run between steps. */
  hooks?: { afterForget?: (folder: string) => void | Promise<void> }
}

export interface JjWorkspacePort extends WorkspacePort {
  platform: 'jj'
  /** A workspace's name for a folder of this project: `cw-<project hash>-<folder's name>`, collision-safe across projects of one store. */
  nameFor(repo: string, folder: string): string
  /** Whether a folder's workspace is stale (unknown when that can't be read). */
  stale(folder: string): Promise<Maybe<boolean>>
  /** Whether a folder is still the recorded workspace (generation, name, store), read with no jj process: every write's precondition. */
  owns(folder: string, identity: WorkspaceIdentity | null | undefined): Promise<boolean>
  /** The pinned operation for a folder's repository: the one op head, confirmed by jj; unknown with several. */
  pinned(folder: string): Promise<Maybe<string>>
  /**
   * A card's submitted commits recorded on its slot's binding (HI-2866; J9b1 records them once a submission's pin is held,
   * HI-2868): only while the slot is still bound to that line and generation, and only from a later submission than the
   * one recorded (`seq`, its Submitted fact's), by compare and swap. What a reuse of the slot then allows over the base.
   */
  submitted(folder: string, line: string, commits: readonly string[], identity: WorkspaceIdentity | null | undefined, seq: number): Promise<boolean>
  /**
   * A slot's completed binding as it stands (HI-2866's `bindingNow`, for J9b1's start and submission, HI-2868): its
   * pointer, while the folder is the one it was made for and its working copy descends from its base; null with none.
   */
  binding(folder: string): Promise<Maybe<JjBinding | null>>
  /** A slot's pointer read synchronously from the bindings' store (an intent's evidence, HI-2868): null with none or no store. */
  pointerSync(store: string, workspace: string): JjBinding | null | 'unreadable'
  /** Runs jj (the port's runner) in a folder, pinned at `op` (a read) or writing. For recovery and tests. */
  jj(folder: string, args: readonly string[], o?: { op?: string; write?: boolean }): Promise<JjRunResult>
}

const SEPARATOR = '\u001f'
/** How far back the operation log is read for a preparation's marked write, and its records' end. */
const OP_WALK = 200
const OP_END = 'cw-op-end'
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length)
const step = (ok: boolean, err = ''): WorkspaceStep => ({ ok, err })
const ownedPrefix = (repoHash: string): string => `cw-${repoHash}-`
const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const realOr = async (p: string): Promise<string> => resolve(await realpath(p).catch(() => p))

/** A folder's creation generation: the file ids of the folder and its `.jj`, and the folder's birth time; null when unsupported. */
export async function generationOf(folder: string): Promise<string | null> {
  const a = await stat(folder, { bigint: true }).catch(() => null)
  const b = await stat(join(folder, '.jj'), { bigint: true }).catch(() => null)
  if (!a || !b || !a.isDirectory() || !b.isDirectory() || a.ino === 0n || b.ino === 0n) return null
  return `${a.ino}:${b.ino}:${a.birthtimeNs}`
}

/**
 * The operation a workspace's files were last updated at and its name, from `.jj/working_copy/checkout` (a protobuf:
 * field 2 the operation id's bytes, field 3 the name). A hint: jj confirms it by reading at that operation. Null when
 * it isn't readable or isn't that shape.
 */
export async function checkoutOf(folder: string): Promise<{ op: string; name: string } | null> {
  const buf = await readFile(join(folder, '.jj', 'working_copy', 'checkout')).catch(() => null)
  if (!buf || buf.length > 4096) return null
  let i = 0
  let op: string | null = null
  let name: string | null = null
  while (i < buf.length) {
    const tag = buf[i++]
    if ((tag & 7) !== 2) return null
    let len = 0
    for (let shift = 0; ; shift += 7) {
      if (i >= buf.length || shift > 28) return null
      const b = buf[i++]
      len |= (b & 0x7f) << shift
      if (!(b & 0x80)) break
    }
    if (i + len > buf.length) return null
    const v = buf.subarray(i, i + len)
    i += len
    if (tag >> 3 === 2) op = v.toString('hex')
    else if (tag >> 3 === 3) name = v.toString('utf8')
  }
  return op && name ? { op, name } : null
}

type JjPrepPhaseEnd = 'refused' | 'superseded'

export function createJjWorkspacePort(deps: JjPortDeps): JjWorkspacePort {
  const runner = deps.runner ?? jjRunner
  const contexts = new Map<string, Promise<JjContext | null>>()

  /** The jj repository holding a folder (cached per folder while it answers; detection's unknown is null). */
  const contextOf = (folder: string): Promise<JjContext | null> => {
    const key = resolve(folder).toLowerCase()
    let c = contexts.get(key)
    if (!c) {
      c = jjContextOf(folder, runner).then((d) => ('jj' in d ? d.jj : null))
      contexts.set(key, c)
      void c.then((v) => v ?? contexts.delete(key))
    }
    return c
  }

  const jj = (folder: string, args: readonly string[], o: { op?: string; write?: boolean } = {}): Promise<JjRunResult> =>
    runner.run(folder, o.op ? ['--at-op', o.op, ...args] : args, o.write ? { write: true } : {})

  /** The one operation head of a folder's repository, confirmed by jj; unknown with none, several or no answer. */
  const pinned = async (folder: string): Promise<Maybe<string>> => {
    const ctx = await contextOf(folder)
    const u = withDetail(unknown(UNREADABLE.state, { folder }), 'jj')
    if (!ctx || !jjSupported(ctx.tool)) return u
    const heads = await readdir(join(ctx.jjRepo, 'op_heads', 'heads')).catch(() => null)
    if (!heads) return u
    if (heads.length !== 1) return withDetail(u, JJ_REFUSED.heads)
    const r = await jj(folder, ['op', 'log', '--no-graph', '--limit', '1', '-T', 'id ++ "\\n"'], { op: heads[0] })
    return r.ok && r.out.trim() === heads[0] ? heads[0] : withDetail(u, r.err)
  }

  /** A pinned read, its output; unknown when jj didn't answer or failed. */
  const read = async (folder: string, op: string, args: readonly string[], what: Unknown): Promise<Maybe<string>> => {
    const r = await jj(folder, args, { op })
    return r.ok ? r.out : withDetail(what, r.err)
  }

  /** The store's workspaces at `op`: name, root and working-copy commit. */
  const listAt = async (folder: string, op: string): Promise<Maybe<{ name: string; root: string; commit: string }[]>> => {
    const out = await read(folder, op, ['workspace', 'list', '-T', `name ++ "${SEPARATOR}" ++ root ++ "${SEPARATOR}" ++ target.commit_id() ++ "\\n"`], unknown(UNREADABLE.worktrees, { folder }))
    if (isUnknown(out)) return out
    return lines(out).map((l) => {
      const [name, root, commit] = l.split(SEPARATOR)
      return { name, root, commit }
    })
  }

  /** A workspace's working-copy commit at `op`: id, empty, parents, divergent, conflicted. */
  const wcAt = async (folder: string, op: string, name: string): Promise<Maybe<{ commit: string; empty: boolean; parents: string[]; divergent: boolean; conflict: boolean }>> => {
    const out = await read(folder, op, ['log', '--no-graph', '-r', `${revsetName(name)}@`, '-T', `commit_id ++ "${SEPARATOR}" ++ empty ++ "${SEPARATOR}" ++ parents.map(|p| p.commit_id()).join(",") ++ "${SEPARATOR}" ++ divergent ++ "${SEPARATOR}" ++ conflict ++ "\\n"`], unknown(UNREADABLE.revisionIn, { folder }))
    if (isUnknown(out)) return out
    const [commit, empty, parents, divergent, conflict] = (lines(out)[0] ?? '').split(SEPARATOR)
    if (!commit) return unknown(UNREADABLE.revisionIn, { folder })
    return { commit, empty: empty === 'true', parents: parents ? parents.split(',') : [], divergent: divergent === 'true', conflict: conflict === 'true' }
  }

  /** A folder's workspace name, from its checkout file, confirmed by jj's list at `op` (its root this folder). */
  const nameAt = async (folder: string, op: string): Promise<Maybe<string>> => {
    const co = await checkoutOf(folder)
    const u = unknown(UNREADABLE.worktrees, { folder })
    if (!co) return u
    const listed = await listAt(folder, op)
    if (isUnknown(listed)) return listed
    const me = listed.find((w) => w.name === co.name)
    return me && samePath(await realOr(me.root), await realOr(folder)) ? co.name : withDetail(u, JJ_REFUSED.identity)
  }

  /** Whether a folder's files are behind its working-copy commit (another workspace rewrote it): stale. */
  const staleAt = async (folder: string, op: string): Promise<Maybe<boolean>> => {
    const co = await checkoutOf(folder)
    if (!co) return unknown(UNREADABLE.state, { folder })
    if (co.op === op) return false
    const then = await wcAt(folder, co.op, co.name)
    const now = await wcAt(folder, op, co.name)
    if (isUnknown(then)) return then
    if (isUnknown(now)) return now
    return then.commit !== now.commit
  }

  /** What a pinned read of a folder says: its op, name, working-copy commit and staleness; unknown if any can't be read. */
  const state = async (folder: string): Promise<Maybe<{ op: string; name: string; wc: { commit: string; empty: boolean; parents: string[]; divergent: boolean; conflict: boolean }; stale: boolean }>> => {
    const op = await pinned(folder)
    if (isUnknown(op)) return op
    const name = await nameAt(folder, op)
    if (isUnknown(name)) return name
    const wc = await wcAt(folder, op, name)
    if (isUnknown(wc)) return wc
    const stale = await staleAt(folder, op)
    if (isUnknown(stale)) return stale
    return { op, name, wc, stale }
  }

  const repoHash = async (repo: string): Promise<string> => createHash('sha256').update((await realOr(repo)).toLowerCase()).digest('hex').slice(0, 8)
  const nameFor = (hash: string, folder: string): string => `${ownedPrefix(hash)}${basename(folder).replace(/[^A-Za-z0-9._-]/g, '_')}`

  /** The identity check before a change: the folder is the recorded workspace (store, name, generation), at `op`. */
  const isRecorded = async (folder: string, op: string, identity: WorkspaceIdentity | null | undefined): Promise<boolean> => {
    if (!identity) return false
    const ctx = await contextOf(folder)
    if (!ctx || !samePath(ctx.store, identity.store)) return false
    const name = await nameAt(folder, op)
    if (isUnknown(name) || name !== identity.workspace) return false
    return (await generationOf(folder)) === identity.generation
  }

  /**
   * The identity check at a mutation boundary (HR1, HI-2795 round 1): with no jj process, the folder is still the recorded
   * workspace (its creation generation and its checkout's workspace name) of the recorded store. Run right before every
   * write, after every await that could let another process in.
   */
  const owns = async (folder: string, identity: WorkspaceIdentity | null | undefined): Promise<boolean> => {
    if (!identity) return false
    if ((await generationOf(folder)) !== identity.generation) return false
    if ((await checkoutOf(folder))?.name !== identity.workspace) return false
    const ctx = await contextOf(folder)
    return !!ctx && samePath(ctx.store, identity.store)
  }

  /** A bookmark's commit at `op`: its id, null when there is none, unknown when conflicted or unreadable. */
  const bookmarkAt = async (folder: string, op: string, line: string): Promise<Maybe<string | null>> => {
    const out = await read(folder, op, ['bookmark', 'list', '-T', `if(!remote, name ++ "${SEPARATOR}" ++ conflict ++ "${SEPARATOR}" ++ if(normal_target, normal_target.commit_id(), "") ++ "\\n")`, '--', `exact:${line}`], unknown(UNREADABLE.line, { branch: line }))
    if (isUnknown(out)) return out
    const row = lines(out).map((l) => l.split(SEPARATOR)).find(([n]) => n === line)
    if (!row) return null
    if (row[1] === 'true' || !row[2]) return withDetail(unknown(UNREADABLE.line, { branch: line }), 'conflicted') // i18n-ignore: a protocol detail
    return row[2]
  }

  /**
   * The project's control workspace (s21 §4; HI-2887's design s7–s20): sparse and empty, the cwd of every add and forget.
   * Each making is its own attempt, under the store's lock, its record journalled before each step, and decided again
   * inside the lock from the record as it is then:
   * - `intent` (a fresh token): a token folder Combwork then makes itself, empty, under `.cw-jj-controls`;
   * - `folder` (its generation recorded): `jj workspace add <token>/ws` under the attempt's own name
   *   (`cw-<hash>-control-<token>`), from the project folder (which snapshots its working copy: only when it is quiet);
   * - `ready` (`ws`'s own generation recorded right after the add): used only while its token folder's and `ws`'s
   *   generations, its checkout's name, its store and its empty sparse state all still hold.
   * An interrupted attempt is never adopted (a child with no recorded baseline proves nothing) and nothing unproved is
   * ever deleted: an empty token folder of its own is removed (not recursively); anything else, and any registration
   * under its name, is kept as a residue the record lists (the pool's prune forgets a residue registration whose folder is
   * gone, from the next control: no snapshot of the project folder). A new attempt takes a fresh token and name, so it
   * never collides with an earlier one. Null (refused) when it can't be proved, or the project folder isn't quiet.
   */
  const control = async (repo: string, ctx: JjContext): Promise<string | null> => {
    const c = deps.control(repo)
    const hash = await repoHash(repo)
    type Residue = { path: string; name?: string; why: string }
    type Rec = { everReady?: boolean; phase?: string; token?: string; name?: string; store?: string; tokenFolder?: string; tokenGeneration?: string; ws?: string; wsGeneration?: string; residues?: Residue[]; folder?: string; workspace?: string; generation?: string }
    const recNow = (): Rec | null => {
      const v = c.journal.read()
      return v && typeof v === 'object' && !('unreadable' in v) ? (v as Rec) : null
    }
    const folderGen = async (p: string): Promise<string | null> => {
      const s = await stat(p, { bigint: true }).catch(() => null)
      return s && s.isDirectory() && s.ino !== 0n ? `${s.ino}:${s.birthtimeNs}` : null
    }
    const emptySparse = async (p: string): Promise<boolean> => {
      const files = await readdir(p).catch(() => null)
      return !!files && files.every((f) => f === '.jj' || f === '.git')
    }
    const usable = async (rec: Rec | null): Promise<string | null> => {
      if (!rec || rec.phase !== 'ready' || !rec.store || !samePath(rec.store, ctx.store)) return null
      // A J9a record (one control, no token): its folder's generation and empty sparse state, as before.
      if (!rec.token) {
        if (!rec.folder || !samePath(rec.folder, c.folder) || (await generationOf(c.folder)) !== rec.generation) return null
        return (await emptySparse(c.folder)) ? c.folder : null
      }
      if (!rec.ws || !rec.tokenFolder || !rec.name) return null
      if ((await folderGen(rec.tokenFolder)) !== rec.tokenGeneration || (await generationOf(rec.ws)) !== rec.wsGeneration) return null
      if ((await checkoutOf(rec.ws))?.name !== rec.name) return null
      const there = await contextOf(rec.ws)
      if (!there || !samePath(there.store, ctx.store)) return null
      return (await emptySparse(rec.ws)) ? rec.ws : null
    }
    const fast = await usable(recNow())
    if (fast) return fast
    return deps.lock(ctx.store, async () => {
      // Everything decided from the record as it is now, inside the lock (another caller may have made it ready).
      const rec = recNow()
      if (rec?.store && !samePath(rec.store, ctx.store)) return null
      const now = await usable(rec)
      if (now) return now
      const residues: Residue[] = [...(rec?.residues ?? [])]
      const keep = (r: Residue): void => {
        if (!residues.some((x) => samePath(x.path, r.path) && x.name === r.name)) residues.push(r)
      }
      if (rec) {
        // The attempt the record names, preserved or cleaned up only where it is provably Combwork's and empty.
        const tokenFolder = rec.token ? rec.tokenFolder : rec.folder
        const name = rec.token ? rec.name : rec.workspace
        const op = await pinned(repo)
        if (isUnknown(op)) return null
        const listed = await listAt(repo, op)
        if (isUnknown(listed)) return null
        const registered = !!name && listed.some((w) => w.name === name)
        if (registered) keep({ path: rec.ws ?? tokenFolder ?? '', name, why: rec.phase === 'ready' ? 'lost' : 'unrecorded' }) // i18n-ignore: a residue's protocol code, for the log and the window's own words
        if (tokenFolder && existsSync(tokenFolder)) {
          const ours = !!rec.token && !!rec.tokenGeneration && (await folderGen(tokenFolder)) === rec.tokenGeneration
          const files = await readdir(tokenFolder).catch(() => null)
          if (ours && files && files.length === 0 && !registered) {
            // Its own, empty: removed (rmdir fails on anything inside, so nothing unproved goes).
            await rmdir(tokenFolder).catch(() => keep({ path: tokenFolder, why: 'notEmpty' })) // i18n-ignore: a residue's protocol code, for the log and the window's own words
          } else keep({ path: tokenFolder, ...(name ? { name } : {}), why: ours ? 'notEmpty' : 'unproved' }) // i18n-ignore: a residue's protocol code, for the log and the window's own words
        }
        // Ready once (a working control lost): made again only on the user's decision covering another snapshot.
        const lost = rec.phase === 'ready' || !!rec.everReady
        await c.journal.write({ phase: 'idle', store: ctx.store, residues, ...(lost ? { everReady: true } : {}) })
        if (lost && !deps.remakeAllowed?.()) return null
      }
      const token = randomUUID().replace(/-/g, '').slice(0, 12)
      const name = `${ownedPrefix(hash)}control-${token}` // i18n-ignore: a jj workspace name, not wording
      // Beside J9a's single control folder (a J9a control there stays as it was, a residue if it can't be used).
      const attempts = join(dirname(c.folder), '.cw-jj-controls')
      const tokenFolder = join(attempts, token)
      const ws = join(tokenFolder, 'ws')
      const base = { store: ctx.store, token, name, tokenFolder, residues, ...(rec?.everReady ? { everReady: true } : {}) }
      // The project folder held against agent launches for the whole making (lock order: the store's lock, then the
      // hold), released however it ends.
      const hold = deps.projectHold(repo)
      if ('busy' in hold) return null
      try {
        await c.journal.write({ phase: 'intent', ...base })
        await mkdir(attempts, { recursive: true }).catch(() => undefined)
        if (!(await mkdir(tokenFolder).then(() => true, () => false))) return null
        const tokenGeneration = await folderGen(tokenFolder)
        if (!tokenGeneration) return null
        await c.journal.write({ phase: 'folder', ...base, tokenGeneration })
        // The explicit owned record of the project folder: the one snapshot of it this attempt takes, under the lock and
        // the hold (no Combwork agent in the project folder).
        const add = await jj(repo, ['workspace', 'add', ws, '--name', name, '--sparse-patterns', 'empty', '--no-colocate'], { write: true })
        if (!add.ok) return null
        const wsGeneration = await generationOf(ws)
        if (!wsGeneration) return null
        await c.journal.write({ phase: 'ready', ...base, tokenGeneration, ws, wsGeneration, everReady: true })
        deps.made?.(repo, ws)
        return ws
      } finally {
        hold.release()
      }
    })
  }

  /** Refuses a folder at or under another repository or workspace than the project's own store. */
  const nestedIn = async (folder: string, ctx: JjContext): Promise<boolean> => {
    let dir = dirname(resolve(folder))
    for (let i = 0; i < 64; i++) {
      for (const m of ['.jj', '.git']) {
        const p = join(dir, m)
        if (existsSync(p)) {
          const there = await jjContextOf(dir, runner).catch(() => null)
          if (m === '.jj' && there && 'jj' in there && samePath(there.jj.store, ctx.store)) continue
          if (m === '.git' && samePath(await realOr(dir), await realOr(ctx.root)) && ctx.colocated) continue
          return true
        }
      }
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
    return false
  }

  /**
   * A slot's completed binding as it stands (HI-2866): its pointer, only while the folder is the one it was made for (its
   * generation) and its working copy descends from the binding's base, read pinned. Null with no binding (none kept, or a
   * fresh or detached slot); unknown when any part can't be read, never a guess.
   */
  const bindingNow = async (folder: string): Promise<Maybe<JjBinding | null>> => {
    const ctx = await contextOf(folder)
    const u = unknown(UNREADABLE.state, { folder })
    if (!ctx) return u
    const prep = deps.prep?.(ctx.store) ?? null
    if (!prep) return null
    const co = await checkoutOf(folder)
    if (!co) return u
    const b = prep.pointer(ctx.store, co.name)
    if (b === 'unreadable') return withDetail(u, JJ_REFUSED.journal)
    if (!b) return null
    if ((await generationOf(folder)) !== b.generation) return withDetail(u, JJ_REFUSED.identity)
    const op = await pinned(folder)
    if (isUnknown(op)) return op
    const out = await read(folder, op, ['log', '--no-graph', '-r', `present(${b.base}) & ::${revsetName(co.name)}@`, '-T', 'commit_id ++ "\\n"'], u)
    if (isUnknown(out)) return out
    return lines(out)[0] === b.base ? b : withDetail(u, JJ_REFUSED.notBound)
  }

  /**
   * A slot moved onto `next.base` for a binding, as an owned, journalled write (HI-2866/s10 §2, s13; HR1's round 1):
   * under the store's lock, the journal planned with the pointer it starts from (`prev`) and taken up by this attempt (a
   * fresh `run`), then the folder recorded, its chain over `prev`'s base checked (exactly `prev`'s submitted commits,
   * contained in `prev`'s target; with no binding, an empty working copy), `next.base` visible, and for a detach the
   * target still at it. The guard (the fence, the folder's identity, the pointer still exactly `prev`, the operation head
   * still the check's) runs after every journal write and right before each jj write, and again right before the binding
   * is published, whose compare and swap also requires the journal still this attempt's.
   *
   * The write is marked: `jj --config=cw.prep=<mark> new <base>`, the mark journalled before it runs, so jj's operation
   * log tells this preparation's own write apart from anyone else's. Landed means exactly one marked operation after the
   * check's operation, its parent that operation, its working copy empty on the base; none marked means it never ran;
   * anything else is uncertain and stays so (no blind retry). Before publishing, the folder is recorded (a snapshot) and
   * its working copy must still be the very commit the marked write made, empty on the base: an edit or a foreign write
   * since leaves it uncertain. A crash resumes from the journal by the same reading.
   */
  const ownedMove = async (folder: string, kind: JjPrepJournal['kind'], next: Omit<JjBinding, 'generation'>, o: OwnedWrite, target?: string): Promise<WorkspaceStep> => {
    if (!o.identity || !o.fence) return step(false, JJ_REFUSED.fence)
    const identity = o.identity
    const fence = o.fence
    const ctx = await contextOf(folder)
    const prep = ctx ? (deps.prep?.(ctx.store) ?? null) : null
    if (!ctx || !prep || !samePath(ctx.store, identity.store)) return step(false, JJ_REFUSED.control)
    const store = ctx.store
    const ws = identity.workspace
    let bound: JjBinding = { ...next, generation: identity.generation }
    return deps.lock(store, async () => {
      const ptr0 = prep.pointer(store, ws)
      if (ptr0 === 'unreadable') return step(false, JJ_REFUSED.journal)
      // A restart of the same card in its own slot (HI-2868, s10 §3): its earlier binding carried, with no jj write, only
      // when the slot is the folder it was bound in (its generation), on the same target, from the same base (the start
      // planned on the carried base). Anything else is a fresh preparation, checked as one.
      const carry = kind === 'prepare' && !!ptr0 && ptr0.card !== null && ptr0.card === bound.card && ptr0.key !== bound.key && ptr0.generation === bound.generation && ptr0.target === bound.target && ptr0.base === bound.base
      if (carry) bound = { ...bound, submitted: [...ptr0.submitted], ...(ptr0.submittedSeq !== undefined ? { submittedSeq: ptr0.submittedSeq } : {}) }
      // Already this preparation's (a retry after its publication, before the caller's fact): the same binding, nothing written.
      if (ptr0 && ptr0.prep === bound.prep && ptr0.key === bound.key && ptr0.base === bound.base && ptr0.generation === bound.generation) return step(true)
      const j0 = prep.journal(store, ws, bound.prep)
      if (j0 === 'unreadable') return step(false, JJ_REFUSED.journal)
      // A detach settles exactly the card's binding: never another's (a late settle after the slot was prepared again).
      if (kind === 'detach' && (!ptr0 || ptr0.key !== o.settles)) return step(false, JJ_REFUSED.notBound)
      const run = randomUUID()
      const fresh = !j0 || j0.phase === 'done' || j0.phase === 'superseded' || j0.phase === 'refused'
      let j: JjPrepJournal = fresh ? { kind, prep: bound.prep, next: bound, prev: ptr0, phase: 'planned', run } : { ...j0, run }
      const save = async (patch: Partial<JjPrepJournal>): Promise<void> => {
        j = { ...j, ...patch }
        await prep.writeJournal(store, ws, j)
      }
      await save({})
      const refuse = async (why: string, phase: JjPrepPhaseEnd = 'refused'): Promise<WorkspaceStep> => {
        await save({ phase, why })
        return step(false, why)
      }
      // Every write's precondition: still the holder's (with the folder quiet), still the recorded workspace, the slot's
      // binding still exactly the one this preparation started from, and (when given) the operation head still `at`.
      const guard = async (at?: string): Promise<string | null> => {
        if (!(await fence.still())) return JJ_REFUSED.fence
        if (!(await owns(folder, identity))) return JJ_REFUSED.identity
        const now = prep.pointer(store, ws)
        if (now === 'unreadable' || !sameBinding(now, j.prev)) return JJ_REFUSED.superseded
        if (at !== undefined && (await pinned(folder)) !== at) return JJ_REFUSED.moved
        return null
      }
      const refuseFor = (g: string): Promise<WorkspaceStep> => refuse(g, g === JJ_REFUSED.superseded ? 'superseded' : 'refused')
      // After the write landed, a failed guard keeps the journal at `written` (the holder's next attempt confirms and
      // publishes it), except a pointer that moved, which supersedes it.
      const stopAfterWrite = async (g: string): Promise<WorkspaceStep> => (g === JJ_REFUSED.superseded ? refuseFor(g) : step(false, g))
      const g0 = await guard()
      if (g0) return j.phase === 'written' ? stopAfterWrite(g0) : refuseFor(g0)
      // Published in the fence's own transaction where it has one (the pool's: its operation's token, its lease open, no
      // writer or job, checked in the same commit as the compare and swap; HR1's round 2), so an owner cancelled or
      // replaced while the write waited publishes nothing and the journal stays where it was.
      const publishNow = async (): Promise<WorkspaceStep> => {
        const fin = j
        const pub = fence.commit && prep.publishIn ? await fence.commit((db) => prep.publishIn!(db, store, ws, fin.prev, bound, fin)) : { held: true as const, value: await prep.publish(store, ws, j.prev, bound, j) }
        if (!pub.held) return step(false, JJ_REFUSED.fence)
        // Not published: the pointer moved, or a later attempt took the preparation over (its journal is its own now).
        if (!pub.value) return step(false, JJ_REFUSED.superseded)
        return step(true)
      }
      // Carried: the slot's working copy still on the binding's base (read pinned), then the guard at that head, then
      // published. Nothing in the folder changes.
      if (carry && j.phase !== 'writing' && j.phase !== 'written') {
        const H = await pinned(folder)
        if (isUnknown(H)) return refuse(H.detail ?? H.what)
        const on = await read(folder, H, ['log', '--no-graph', '-r', `present(${bound.base}) & ::${revsetName(ws)}@`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revisionIn, { folder }))
        if (isUnknown(on) || lines(on)[0] !== bound.base) return refuse(isUnknown(on) ? (on.detail ?? on.what) : JJ_REFUSED.notBound)
        const g = await guard(H)
        if (g) return refuseFor(g)
        return publishNow()
      }
      /**
       * Whether the marked write landed, read from jj's operation log (newest first, from the head back to the check's
       * operation): its operation and commit (exactly one marked operation, its parent the check's, its working copy empty
       * on the base), `none` (no marked operation since the check: it never ran), else `uncertain`.
       */
      const landed = async (): Promise<{ op: string; commit: string } | 'none' | 'uncertain'> => {
        if (!j.checkedAt || !j.mark) return 'uncertain'
        const head = await pinned(folder)
        if (isUnknown(head)) return 'uncertain'
        if (head === j.checkedAt) return 'none'
        const out = await read(folder, head, ['op', 'log', '--no-graph', '--limit', String(OP_WALK), '-T', `id ++ "${SEPARATOR}" ++ parents.map(|p| p.id()).join(",") ++ "${SEPARATOR}" ++ self.attributes() ++ "${SEPARATOR}${OP_END}\\n"`], unknown(UNREADABLE.state, { folder }))
        if (isUnknown(out)) return 'uncertain'
        const ops: { id: string; parents: string[]; marked: boolean }[] = []
        let reached = false
        for (const rec of out.split(`${SEPARATOR}${OP_END}`)) {
          const [id, parents, attrs] = rec.replace(/^\r?\n/, '').split(SEPARATOR)
          if (!id) continue
          if (id === j.checkedAt) {
            reached = true
            break
          }
          ops.push({ id, parents: parents ? parents.split(',') : [], marked: (attrs ?? '').includes(`cw.prep=${j.mark}`) })
        }
        if (!reached) return 'uncertain'
        const marked = ops.filter((x) => x.marked)
        if (!marked.length) return 'none'
        if (marked.length > 1 || marked[0].parents.length !== 1 || marked[0].parents[0] !== j.checkedAt) return 'uncertain'
        const wc = await wcAt(folder, marked[0].id, ws)
        if (isUnknown(wc) || !wc.empty || wc.parents.length !== 1 || wc.parents[0] !== bound.base) return 'uncertain'
        return { op: marked[0].id, commit: wc.commit }
      }
      // Resumed after its write began: jj's operation log decides.
      if (j.phase === 'writing') {
        const l = await landed()
        if (l === 'uncertain') return step(false, JJ_REFUSED.uncertain)
        if (l === 'none') await save({ phase: 'recorded', mark: undefined, wrote: undefined })
        else await save({ phase: 'written', wrote: l })
      }
      if (j.phase !== 'written') {
        const rec = await port.record!(folder, fence, identity)
        if (isUnknown(rec)) return refuse(rec.detail ?? rec.what)
        await save({ phase: 'recorded' })
        const H = await pinned(folder)
        if (isUnknown(H)) return refuse(H.detail ?? H.what)
        const stale = await staleAt(folder, H)
        if (isUnknown(stale) || stale) return refuse(isUnknown(stale) ? (stale.detail ?? stale.what) : JJ_REFUSED.stale)
        const wc = await wcAt(folder, H, ws)
        if (isUnknown(wc)) return refuse(wc.detail ?? wc.what)
        if (wc.divergent || wc.conflict) return refuse(wc.divergent ? JJ_REFUSED.divergent : JJ_REFUSED.unintegrated)
        // The chain over the previous binding's base (or, with none, the working copy's own parent: nothing may be there).
        const over = j.prev?.base ?? (wc.empty && wc.parents.length === 1 ? wc.parents[0] : null)
        if (!over) return refuse(JJ_REFUSED.notEmpty)
        const out = await read(folder, H, ['log', '--no-graph', '-r', `(${over}::${revsetName(ws)}@) ~ ${over}`, '-T', `commit_id ++ "${SEPARATOR}" ++ empty ++ "\\n"`], unknown(UNREADABLE.revisionIn, { folder }))
        if (isUnknown(out)) return refuse(out.detail ?? out.what)
        const chain = lines(out)
          .map((l) => l.split(SEPARATOR))
          .filter(([c, e]) => !(c === wc.commit && e === 'true'))
          .map(([c]) => c)
        if (!chainIsBinding(chain, j.prev)) return refuse(JJ_REFUSED.unintegrated)
        if (j.prev?.submitted.length) {
          if (!j.prev.target || !deps.contains) return refuse(JJ_REFUSED.notIntegrated)
          const th = await bookmarkAt(folder, H, j.prev.target)
          if (isUnknown(th) || !th) return refuse(JJ_REFUSED.notIntegrated)
          const c = await deps.contains(store, j.prev.target, { base: j.prev.base, revision: j.prev.submitted[j.prev.submitted.length - 1] }, th)
          if (isUnknown(c) || !c) return refuse(JJ_REFUSED.notIntegrated)
        }
        const at = await read(folder, H, ['log', '--no-graph', '-r', `present(${bound.base}) & ::visible_heads()`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revision, { revision: bound.base }))
        if (isUnknown(at) || lines(at)[0] !== bound.base) return refuse(JJ_REFUSED.base)
        if (target) {
          const th = await bookmarkAt(folder, H, target)
          if (isUnknown(th) || th !== bound.base) return refuse(JJ_REFUSED.moved)
        }
        await save({ phase: 'checked', checkedAt: H, from: wc.commit })
        const g1 = await guard(H)
        if (g1) return refuseFor(g1)
        await save({ phase: 'writing', mark: run })
        // Right before the write, after the journal's await: everything again.
        const g2 = await guard(H)
        if (g2) return refuseFor(g2)
        const nu = await jj(folder, [`--config=cw.prep=${run}`, 'new', bound.base], { write: true })
        const l = await landed()
        if (l === 'uncertain') return step(false, JJ_REFUSED.uncertain)
        if (l === 'none') return refuse(nu.ok ? JJ_REFUSED.uncertain : nu.err)
        await save({ phase: 'written', wrote: l })
        // The previous working copy, if jj kept it (jj abandons an empty one itself): abandoned only as the slot's own,
        // only with nothing else written since its own write.
        if (wc.empty && wc.commit !== l.commit) {
          const kept = await read(folder, l.op, ['log', '--no-graph', '-r', `present(${wc.commit}) & visible_heads() & empty() & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revision, { revision: wc.commit }))
          if (!isUnknown(kept) && lines(kept).length) {
            const g3 = await guard(l.op)
            if (g3) return stopAfterWrite(g3)
            await jj(folder, ['abandon', wc.commit], { write: true })
          }
        }
      }
      // Confirmed before publishing: recorded (unrecorded edits become visible), the working copy still exactly the
      // commit the marked write made, empty on the base; then the guard right before the compare and swap.
      const wrote = j.wrote
      if (!wrote) return step(false, JJ_REFUSED.uncertain)
      const files = await port.record!(folder, fence, identity)
      if (isUnknown(files)) return files.detail === JJ_REFUSED.fence || files.detail === JJ_REFUSED.identity ? stopAfterWrite(files.detail) : step(false, JJ_REFUSED.uncertain)
      const s = await state(folder)
      if (isUnknown(s)) return step(false, JJ_REFUSED.uncertain)
      if (files.length || s.stale || s.wc.divergent || s.wc.commit !== wrote.commit || !s.wc.empty || s.wc.parents.length !== 1 || s.wc.parents[0] !== bound.base) return step(false, JJ_REFUSED.uncertain)
      const g4 = await guard(s.op)
      if (g4) return stopAfterWrite(g4)
      return publishNow()
    })
  }

  const port: JjWorkspacePort = {
    platform: 'jj',
    nameFor: (repo, folder) => nameFor(createHash('sha256').update(resolve(repo).toLowerCase()).digest('hex').slice(0, 8), folder),
    pinned,
    jj,
    owns,
    stale: async (folder) => {
      const op = await pinned(folder)
      return isUnknown(op) ? op : staleAt(folder, op)
    },

    list: async (repo) => {
      const op = await pinned(repo)
      if (isUnknown(op)) return null
      const l = await listAt(repo, op)
      return isUnknown(l) ? null : l.map((w): WorkspaceListing => ({ path: resolve(w.root), line: null }))
    },
    head: async (folder) => {
      const s = await state(folder)
      if (isUnknown(s)) return s
      const u = unknown(UNREADABLE.revisionIn, { folder })
      if (s.stale) return withDetail(u, JJ_REFUSED.stale)
      if (s.wc.divergent) return withDetail(u, JJ_REFUSED.divergent)
      if (!s.wc.empty) return s.wc.commit
      return s.wc.parents.length === 1 ? s.wc.parents[0] : withDetail(u, 'merge') // i18n-ignore: a protocol detail
    },
    // A card's line under jj is its preparation's key, from the slot's completed binding (HI-2866): never a bookmark.
    line: async (folder) => {
      const bd = await bindingNow(folder)
      return isUnknown(bd) ? bd : (bd?.key ?? null)
    },
    shownLine: async () => '',
    currentLine: async () => null,
    checkout: () => null,
    heads: async (folder, target): Promise<WorkspaceHeads> => {
      const head = await port.head(folder)
      const t = await port.lineHead(folder, target)
      return { line: await port.line(folder), head, target: t }
    },
    dirty: async (folder) => withDetail(unknown(UNREADABLE.uncommitted, { folder }), 'jj: a read without a snapshot can\'t see unrecorded edits'), // i18n-ignore: a protocol detail
    lineHead: async (repo, line) => {
      // A preparation's key is no bookmark: it has no head of its own (HI-2866).
      if (isJjLineKey(line)) return null
      const op = await pinned(repo)
      return isUnknown(op) ? op : bookmarkAt(repo, op, line)
    },
    defaultLine: async (repo) => {
      const op = await pinned(repo)
      if (isUnknown(op)) return op
      for (const name of ['main', 'master']) {
        const b = await bookmarkAt(repo, op, name)
        if (isUnknown(b)) return b
        if (b) return name
      }
      return unknown(UNREADABLE.defaultBranch, { folder: repo })
    },
    lineExists: async (repo, line) => {
      const h = await port.lineHead(repo, line)
      return !isUnknown(h) && !!h
    },
    prunable: async (repo) => {
      const op = await pinned(repo)
      if (isUnknown(op)) return []
      const l = await listAt(repo, op)
      if (isUnknown(l)) return []
      const mine = ownedPrefix(await repoHash(repo))
      return l.filter((w) => w.name.startsWith(mine) && !existsSync(w.root)).map((w) => resolve(w.root))
    },

    create: async (repo, folder, at) => {
      const ctx = await contextOf(repo)
      if (!ctx) return step(false, JJ_REFUSED.control)
      if (!jjSupported(ctx.tool)) return step(false, JJ_REFUSED.tool)
      if (existsSync(folder)) return step(false, JJ_REFUSED.exists)
      if (await nestedIn(folder, ctx)) return step(false, JJ_REFUSED.nested)
      const from = await control(repo, ctx)
      if (!from) return step(false, JJ_REFUSED.control)
      const name = nameFor(await repoHash(repo), folder)
      return deps.lock(ctx.store, async () => {
        // From the control (empty, sparse: its snapshot is empty), full files, colocation chosen as the project's.
        const r = await jj(from, ['workspace', 'add', folder, '--name', name, '-r', at, '--sparse-patterns', 'full', ctx.colocated ? '--colocate' : '--no-colocate'], { write: true })
        if (!r.ok) return step(false, r.err)
        // Read back (rule 3): listed at that root, its working copy an empty child of exactly `at`, same store.
        const op = await pinned(folder)
        if (isUnknown(op)) return step(false, op.detail ?? op.what)
        const listed = await listAt(folder, op)
        const me = isUnknown(listed) ? undefined : listed.find((w) => w.name === name)
        if (!me || !samePath(await realOr(me.root), await realOr(folder))) return step(false, JJ_REFUSED.identity)
        const wc = await wcAt(folder, op, name)
        if (isUnknown(wc) || !wc.empty || wc.parents.length !== 1 || wc.parents[0] !== at) return step(false, JJ_REFUSED.identity)
        const there = await jjContextOf(folder, runner)
        if (!('jj' in there) || !samePath(there.jj.store, ctx.store) || !there.jj.linked || there.jj.colocated !== ctx.colocated) return step(false, JJ_REFUSED.identity)
        return step(true)
      })
    },
    identity: async (folder) => {
      const ctx = await contextOf(folder)
      const op = await pinned(folder)
      if (!ctx || isUnknown(op)) return null
      const name = await nameAt(folder, op)
      const generation = await generationOf(folder)
      return isUnknown(name) || !generation ? null : { store: ctx.store, workspace: name, generation }
    },
    attach: async () => step(false, JJ_REFUSED.line),
    createOnNewLine: async () => {
      throw new Error(JJ_REFUSED.line)
    },
    copyIgnored: async () => [],
    prune: async (repo) => {
      // Only this project's own workspaces whose folders are gone, each forgotten by name: never another's registration.
      const gone = await port.prunable(repo)
      const ctx = await contextOf(repo)
      if (!gone.length || !ctx) return
      const from = await control(repo, ctx)
      if (!from) return
      const op = await pinned(repo)
      if (isUnknown(op)) return
      const l = await listAt(repo, op)
      if (isUnknown(l)) return
      await deps.lock(ctx.store, async () => {
        for (const w of l) if (gone.some((g) => samePath(g, w.root))) await jj(from, ['workspace', 'forget', '--', w.name], { write: true })
      })
    },
    // A card cycle's preparation (HI-2866/s13): always onto its base (a card's line under jj is made, never "the one it
    // has"), owned and journalled; its binding published once the slot is on the base.
    prepare: async (folder, line, base, o = {}) => {
      const k = parseJjLineKey(line)
      if (!k || !base || !o.lease) return step(false, JJ_REFUSED.line)
      if (!o.identity || k.workspace !== o.identity.workspace) return step(false, JJ_REFUSED.identity)
      return ownedMove(folder, 'prepare', { prep: k.prep, key: line, card: k.card, cycle: k.cycle, lease: o.lease, target: o.target ?? null, base, submitted: [] }, o)
    },
    // A slot put back on its target's head after its card is Done (HI-2866/s13): only the card's own binding (`settles`),
    // its chain exactly the card's integrated submitted work, the target still at `revision` right before the write.
    detach: async (folder, revision, o = {}) => {
      const k = o.settles ? parseJjLineKey(o.settles) : null
      if (!k || !o.target) return step(false, JJ_REFUSED.notBound)
      return ownedMove(folder, 'detach', { prep: `detach:${k.prep}`, key: null, card: null, cycle: null, lease: null, target: null, base: revision, submitted: [] }, o, o.target)
    },
    binding: (folder) => bindingNow(folder),
    pointerSync: (store, workspace) => deps.prep?.(store)?.pointer(store, workspace) ?? null,
    submitted: async (folder, line, commits, identity, seq) => {
      const ctx = await contextOf(folder)
      const prep = ctx ? (deps.prep?.(ctx.store) ?? null) : null
      if (!ctx || !prep || !identity || !samePath(ctx.store, identity.store)) return false
      return deps.lock(ctx.store, async () => {
        // The live folder is still the workspace the submission was made in (HR2's round 2): its generation, its
        // checkout's workspace and store, checked here and again right before the publication; a replaced folder whose
        // old pointer still names that generation gets nothing.
        if (!(await owns(folder, identity))) return false
        const now = prep.pointer(ctx.store, identity.workspace)
        if (now === 'unreadable' || !now || now.key !== line || now.generation !== identity.generation) return false
        // A later submission's record already there: an older action's never replaces it (HI-2868).
        if ((now.submittedSeq ?? 0) >= seq) return (now.submittedSeq ?? 0) === seq && now.submitted.length === commits.length && now.submitted.every((c, i) => c === commits[i])
        const next = { ...now, submitted: [...commits], submittedSeq: seq }
        if (!(await owns(folder, identity))) return false
        return prep.publish(ctx.store, identity.workspace, now, next, { kind: 'prepare', prep: now.prep, next, prev: now, phase: 'done' })
      })
    },

    record: async (folder, fence, identity) => {
      const u = unknown(UNREADABLE.uncommitted, { folder })
      const op = await pinned(folder)
      if (isUnknown(op)) return op
      if (!(await isRecorded(folder, op, identity))) return withDetail(u, JJ_REFUSED.identity)
      const stale = await staleAt(folder, op)
      if (isUnknown(stale)) return stale
      if (stale) return withDetail(u, JJ_REFUSED.stale)
      // Right before the write: still its holder's, still the recorded workspace.
      if (!(await fence.still())) return withDetail(u, JJ_REFUSED.fence)
      if (!(await owns(folder, identity))) return withDetail(u, JJ_REFUSED.identity)
      // The explicit snapshot: `status` writing, never updating a stale copy (the runner's prefix keeps auto-update off).
      const snap = await jj(folder, ['--config=snapshot.auto-update-stale=false', 'status'], { write: true })
      if (!snap.ok) return withDetail(u, snap.err)
      const after = await pinned(folder)
      if (isUnknown(after)) return after
      const name = await nameAt(folder, after)
      if (isUnknown(name)) return name
      const out = await read(folder, after, ['diff', '--summary', '-r', `${revsetName(name)}@`], u)
      if (isUnknown(out)) return out
      return lines(out).map((l) => l.replace(/^[A-Z] /, ''))
    },
    copyIntact: async (folder, revision, fence, identity) => {
      const files = await port.record!(folder, fence, identity)
      if (isUnknown(files)) return files.detail === JJ_REFUSED.stale ? false : files
      if (files.length) return false
      const s = await state(folder)
      if (isUnknown(s)) return s
      return !s.stale && !s.wc.divergent && !s.wc.conflict && s.wc.empty && s.wc.parents.length === 1 && s.wc.parents[0] === revision
    },
    resetTo: async (folder, revision, o = {}) => {
      // A copy only, under its warm operation (copies.ts), as an owned change (HR1, round 1): its identity and its
      // operation checked before its first write and again before each later one; a replacement or a lost fence is
      // refused untouched. Stale or divergent copies are disposed of, never reset.
      const refused = (failed: 'checkout' | 'clean', err: string): { ok: false; failed: 'checkout' | 'clean'; err: string } => ({ ok: false, failed, err })
      const mine = async (): Promise<string | null> => {
        if (!o.fence || !(await o.fence.still())) return JJ_REFUSED.fence
        return (await owns(folder, o.identity)) ? null : JJ_REFUSED.identity
      }
      const first = await mine()
      if (first) return refused('checkout', first)
      const s = await state(folder)
      if (isUnknown(s)) return refused('checkout', s.detail ?? s.what)
      if (s.stale) return refused('checkout', JJ_REFUSED.stale)
      if (s.wc.divergent) return refused('checkout', JJ_REFUSED.divergent)
      // Stray files into the copy's own change, then a new empty change at exactly the revision.
      let why = await mine()
      if (why) return refused('checkout', why)
      const snap = await jj(folder, ['--config=snapshot.auto-update-stale=false', 'status'], { write: true })
      if (!snap.ok) return refused('clean', snap.err)
      const mid = await state(folder)
      if (isUnknown(mid)) return refused('clean', mid.detail ?? mid.what)
      const old = mid.wc.commit
      why = await mine()
      if (why) return refused('checkout', why)
      const nu = await jj(folder, ['new', revision], { write: true })
      if (!nu.ok) return refused('checkout', nu.err)
      const after = await state(folder)
      if (isUnknown(after)) return refused('checkout', after.detail ?? after.what)
      // The old change, if jj kept it (not empty): abandoned only as the copy's own (no descendant, no bookmark, no workspace's).
      const kept = await read(folder, after.op, ['log', '--no-graph', '-r', `${old} & visible_heads() & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revision, { revision: old }))
      if (isUnknown(kept)) return refused('clean', kept.detail ?? kept.what)
      if (lines(kept).length) {
        why = await mine()
        if (why) return refused('clean', why)
        const ab = await jj(folder, ['abandon', old], { write: true })
        if (!ab.ok) return refused('clean', ab.err)
      }
      const end = await state(folder)
      if (isUnknown(end)) return refused('checkout', end.detail ?? end.what)
      return end.wc.empty && end.wc.parents.length === 1 && end.wc.parents[0] === revision && !end.stale ? { ok: true } : refused('checkout', JJ_REFUSED.identity)
    },

    remove: async (repo, folder, o = {}) => {
      // Journalled (s21 §2): forget (read back whatever its exit), then the generation check, then the trash. A resume
      // reads the phase; a mismatch keeps the journal and trashes nothing.
      const identity = o.identity
      const journal = o.journal
      if (!identity || !journal) return step(false, JJ_REFUSED.identity)
      const ctx = await contextOf(repo)
      if (!ctx || !samePath(ctx.store, identity.store)) return step(false, JJ_REFUSED.identity)
      const at = (journal.read() as { phase?: string; workspace?: string; folder?: string; generation?: string } | null) ?? null
      if (at && (at.workspace !== identity.workspace || !at.folder || !samePath(at.folder, folder) || at.generation !== identity.generation)) return step(false, JJ_REFUSED.identity)
      const fenced = async (): Promise<boolean> => !o.fence || (await o.fence.still())
      let phase = at?.phase ?? 'start'
      if (phase === 'start') {
        if (existsSync(folder)) {
          const op = await pinned(folder)
          if (isUnknown(op)) return step(false, op.detail ?? op.what)
          if (!(await isRecorded(folder, op, identity))) return step(false, JJ_REFUSED.identity)
          if (!o.force) {
            const stale = await staleAt(folder, op)
            if (isUnknown(stale) || stale) return step(false, JJ_REFUSED.stale)
          }
        }
        if (!(await fenced())) return step(false, JJ_REFUSED.fence)
      }
      if (phase === 'start' || phase === 'forgetting') {
        const from = await control(repo, ctx)
        if (!from) return step(false, JJ_REFUSED.control)
        // Inside the store's lock, right before the forget (HR1, round 1): the operation still holds the folder and the
        // folder is still the recorded workspace, else nothing (registration, files, journal) is touched. The intent is
        // written here, so a lock taken over meanwhile leaves no intent behind.
        const forgot = await deps.lock(ctx.store, async () => {
          if (!(await fenced())) return null
          if (existsSync(folder) && !(await owns(folder, identity))) return 'identity' as const
          if (phase === 'start') await journal.write({ phase: 'forgetting', workspace: identity.workspace, folder, generation: identity.generation, store: identity.store })
          return jj(from, ['workspace', 'forget', '--', identity.workspace], { write: true })
        })
        if (forgot === null) return step(false, JJ_REFUSED.fence)
        if (forgot === 'identity') return step(false, JJ_REFUSED.identity)
        // Read back whatever forget's exit (0.47.1 commits the forget before unlinking a colocated Git worktree).
        const op = await pinned(repo)
        if (isUnknown(op)) return step(false, op.detail ?? op.what)
        const l = await listAt(repo, op)
        if (isUnknown(l)) return step(false, l.detail ?? l.what)
        if (l.some((w) => w.name === identity.workspace)) return step(false, forgot.err || JJ_REFUSED.identity)
        const gitLinkLeft = ctx.colocated && !forgot.ok
        await journal.write({ phase: 'forgotten', workspace: identity.workspace, folder, generation: identity.generation, store: identity.store, ...(gitLinkLeft ? { gitLinkLeft: true } : {}) })
        phase = 'forgotten'
        await deps.hooks?.afterForget?.(folder)
      }
      if (phase === 'forgotten') {
        if (existsSync(folder)) {
          // Right before the trash: still the folder made then (its file ids), never the project, the store or above them.
          const real = await realOr(folder)
          const guarded = [ctx.root, ctx.store, ctx.jjRepo, repo].map((p) => resolve(p).toLowerCase())
          if (guarded.some((g) => g === real.toLowerCase() || g.startsWith(real.toLowerCase() + sep))) return step(false, JJ_REFUSED.identity)
          if ((await generationOf(folder)) !== identity.generation) return step(false, JJ_REFUSED.identity)
          const pointer = (await readFile(join(folder, '.jj', 'repo'), 'utf8').catch(() => '')).trim()
          if (!pointer || !samePath(await realOr(resolve(folder, '.jj', pointer)), ctx.jjRepo)) return step(false, JJ_REFUSED.identity)
          if (!(await fenced())) return step(false, JJ_REFUSED.fence)
          try {
            await deps.trash(folder)
          } catch (e) {
            return step(false, e instanceof Error ? e.message : String(e))
          }
        }
        await journal.clear()
      }
      return step(true)
    },
    dropLine: async () => step(false, JJ_REFUSED.line),
    restoreLine: async () => step(false, JJ_REFUSED.line),
    errorLine: (err) => lines(err).find((l) => l.startsWith('Error:'))?.replace(/^Error:\s*/, '') ?? lines(err)[0] ?? ''
  }
  return port
}

/** A workspace name as a revset symbol (quoted: names may hold characters revsets treat as operators). */
export const revsetName = (name: string): string => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Every regular file under a folder (lstat: a link, junction or reparse point refuses), relative, `/`-separated; null to refuse. */
export async function plainFiles(root: string, skip: ReadonlySet<string> = new Set(['.jj', '.git'])): Promise<string[] | null> {
  const out: string[] = []
  const walk = async (dir: string): Promise<boolean> => {
    const names = await readdir(dir).catch(() => null)
    if (!names) return false
    for (const n of names) {
      const p = join(dir, n)
      const rel = relative(root, p).split(sep).join('/')
      if (dir === root && skip.has(n)) continue
      const s = await lstat(p).catch(() => null)
      if (!s || s.isSymbolicLink()) return false
      if (s.isDirectory()) {
        if (!(await walk(p))) return false
      } else if (s.isFile()) out.push(rel)
      else return false
    }
    return true
  }
  return (await walk(root)) ? out : null
}
