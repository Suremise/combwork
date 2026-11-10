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

import { createHash } from 'crypto'
import { existsSync } from 'original-fs'
import { lstat, readdir, readFile, realpath, stat } from 'original-fs/promises'
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
   * Whether the project folder is quiet: no session, no process in it (the pool's proof). Only then is the control made,
   * which snapshots the project folder's working copy once (an explicit owned record, HI-2795/s21 §4).
   */
  projectQuiet: (repo: string) => Promise<boolean>
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
   * A card's submitted commits recorded on its slot's binding (HI-2866; J9b calls it at a submission): only while the slot
   * is still bound to that line and generation, by compare and swap. What a reuse of the slot then allows over the base.
   */
  submitted(folder: string, line: string, commits: readonly string[], identity: WorkspaceIdentity | null | undefined): Promise<boolean>
  /** Runs jj (the port's runner) in a folder, pinned at `op` (a read) or writing. For recovery and tests. */
  jj(folder: string, args: readonly string[], o?: { op?: string; write?: boolean }): Promise<JjRunResult>
}

const SEPARATOR = '\u001f'
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
   * The project's control workspace (s21 §4): sparse and empty, the cwd of every add and forget. Made once, from the
   * project folder (which snapshots the project folder's working copy: so only when it's quiet, under the store's lock),
   * its generation and empty sparse state checked before each use. Null (refused) when it can't be proved.
   */
  const control = async (repo: string, ctx: JjContext): Promise<string | null> => {
    const c = deps.control(repo)
    const hash = await repoHash(repo)
    const name = `${ownedPrefix(hash)}control` // i18n-ignore: a jj workspace name, not wording
    const rec = c.journal.read() as { phase?: string; store?: string; workspace?: string; folder?: string; generation?: string } | null
    const ok = async (): Promise<boolean> => {
      if (!rec || rec.phase !== 'ready' || !rec.folder || !samePath(rec.folder, c.folder) || rec.workspace !== name || !rec.store || !samePath(rec.store, ctx.store)) return false
      if ((await generationOf(c.folder)) !== rec.generation) return false
      // Empty sparse state: no file but .jj in it.
      const files = (await readdir(c.folder).catch(() => null)) ?? null
      return !!files && files.every((f) => f === '.jj' || f === '.git')
    }
    if (await ok()) return c.folder
    // A record that isn't ready (an interrupted making) or doesn't match: refused, never taken for an ordinary slot.
    if (rec && rec.phase !== 'ready') return null
    if (rec) return null
    if (existsSync(c.folder)) return null
    return deps.lock(ctx.store, async () => {
      if (!(await deps.projectQuiet(repo))) return null
      await c.journal.write({ phase: 'creating', store: ctx.store, workspace: name, folder: c.folder })
      // The explicit owned record of the project folder: the one snapshot of it Combwork takes, under the lock, quiet.
      const add = await jj(repo, ['workspace', 'add', c.folder, '--name', name, '--sparse-patterns', 'empty', '--no-colocate'], { write: true })
      if (!add.ok) return null
      const generation = await generationOf(c.folder)
      if (!generation) return null
      await c.journal.write({ phase: 'ready', store: ctx.store, workspace: name, folder: c.folder, generation })
      return c.folder
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
   * A slot moved onto `next.base` for a binding, as an owned, journalled write (HI-2866/s10 §2, s13): the journal planned
   * with the pointer it starts from (`prev`), then under the store's lock the folder recorded, its chain over `prev`'s
   * base checked (exactly `prev`'s submitted commits, contained in `prev`'s target; with no binding, an empty working
   * copy), `next.base` visible, and for a detach the target still at it; right before the write the fence, the folder's
   * identity, the pointer (still exactly `prev`) and the operation head (still the check's) all hold; then `jj new`, read
   * back, and the binding published by compare and swap. Anything else refuses before the write. A crash resumes from
   * the journal: after `writing`, the read-back decides whether the write landed.
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
    const bound: JjBinding = { ...next, generation: identity.generation }
    const ptr0 = prep.pointer(store, ws)
    if (ptr0 === 'unreadable') return step(false, JJ_REFUSED.journal)
    // Already this preparation's (a retry after its publication, before the caller's fact): the same binding, nothing written.
    if (ptr0 && ptr0.prep === bound.prep && ptr0.key === bound.key && ptr0.base === bound.base && ptr0.generation === bound.generation) return step(true)
    let j0 = prep.journal(store, ws, bound.prep)
    if (j0 === 'unreadable') return step(false, JJ_REFUSED.journal)
    // A detach settles exactly the card's binding: never another's (a late settle after the slot was prepared again).
    if (kind === 'detach' && (!ptr0 || ptr0.key !== o.settles)) return step(false, JJ_REFUSED.notBound)
    if (!j0 || j0.phase === 'done' || j0.phase === 'superseded' || j0.phase === 'refused') {
      j0 = { kind, prep: bound.prep, next: bound, prev: ptr0, phase: 'planned' }
      await prep.writeJournal(store, ws, j0)
    }
    let j: JjPrepJournal = j0
    const save = async (patch: Partial<JjPrepJournal>): Promise<void> => {
      j = { ...j, ...patch }
      await prep.writeJournal(store, ws, j)
    }
    return deps.lock(store, async () => {
      const refuse = async (why: string, phase: JjPrepPhaseEnd = 'refused'): Promise<WorkspaceStep> => {
        await save({ phase, why })
        return step(false, why)
      }
      // Every write's precondition: still the holder's (with the folder quiet), still the recorded workspace, and the
      // slot's binding still exactly the one this preparation started from.
      const guard = async (): Promise<string | null> => {
        if (!(await fence.still())) return JJ_REFUSED.fence
        if (!(await owns(folder, identity))) return JJ_REFUSED.identity
        const now = prep.pointer(store, ws)
        return now === 'unreadable' || !sameBinding(now, j.prev) ? JJ_REFUSED.superseded : null
      }
      const g0 = await guard()
      if (g0) return refuse(g0, g0 === JJ_REFUSED.superseded ? 'superseded' : 'refused')
      const onBase = (s: { wc: { empty: boolean; parents: string[] } }): boolean => s.wc.empty && s.wc.parents.length === 1 && s.wc.parents[0] === bound.base
      // Resumed after its write began: the read-back decides.
      if (j.phase === 'writing' || j.phase === 'written') {
        const s = await state(folder)
        if (isUnknown(s)) return step(false, JJ_REFUSED.uncertain)
        if (onBase(s)) await save({ phase: 'written' })
        else if (j.phase === 'writing') await save({ phase: 'recorded' })
        else return step(false, JJ_REFUSED.uncertain)
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
        await save({ phase: 'checked', checkedAt: H })
        // Right before the write.
        const g1 = await guard()
        if (g1) return refuse(g1, g1 === JJ_REFUSED.superseded ? 'superseded' : 'refused')
        if ((await pinned(folder)) !== H) return refuse(JJ_REFUSED.moved)
        await save({ phase: 'writing' })
        const nu = await jj(folder, ['new', bound.base], { write: true })
        const s = await state(folder)
        if (isUnknown(s)) return step(false, JJ_REFUSED.uncertain)
        if (!onBase(s)) {
          // Not landed: the working copy is where it was (nothing changed), else uncertain until read again.
          if (s.wc.commit === wc.commit) return refuse(nu.ok ? JJ_REFUSED.uncertain : nu.err)
          return step(false, JJ_REFUSED.uncertain)
        }
        await save({ phase: 'written' })
        // The previous working copy, if jj kept it (jj abandons an empty one itself): abandoned only as the slot's own.
        if (wc.empty && wc.commit !== s.wc.commit) {
          const kept = await read(folder, s.op, ['log', '--no-graph', '-r', `present(${wc.commit}) & visible_heads() & empty() & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revision, { revision: wc.commit }))
          if (!isUnknown(kept) && lines(kept).length) {
            const g2 = await guard()
            if (!g2) await jj(folder, ['abandon', wc.commit], { write: true })
          }
        }
      }
      if (!(await prep.publish(store, ws, j.prev, bound, j))) return refuse(JJ_REFUSED.superseded, 'superseded')
      return step(true)
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
    submitted: async (folder, line, commits, identity) => {
      const ctx = await contextOf(folder)
      const prep = ctx ? (deps.prep?.(ctx.store) ?? null) : null
      if (!ctx || !prep || !identity || !samePath(ctx.store, identity.store)) return false
      return deps.lock(ctx.store, async () => {
        const now = prep.pointer(ctx.store, identity.workspace)
        if (now === 'unreadable' || !now || now.key !== line || now.generation !== identity.generation) return false
        const next = { ...now, submitted: [...commits] }
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
