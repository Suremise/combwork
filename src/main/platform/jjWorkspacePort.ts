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
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'original-fs'
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, stat } from 'original-fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { jjSupported } from '../../shared/jjTool'
import { UNREADABLE } from '../../shared/workflow/texts'
import { isUnknown, unknown, withDetail, type Maybe, type Unknown } from './types'
import { jjContextOf, type JjContext } from './jjDetect'
import { boundaryOf } from './repoBoundary'
import { readOpHeads } from './jjView'
import { jjRunner, type JjRunner, type JjRunResult } from './jjRunner'
import { jjFileGate, pathKey, rootKey, storeKey } from './jjFileGate'
import { asideOf, asReceipt, entryIdSync, linksTo, provedSync, receiptOf, residuesOf, worktreesOf, type GitLinkReceipt } from './jjGitLink'
import { refusedDetail, snapshotRefused } from './jjSnapshotRefused'
import type { OwnedWrite, SlotWord, WorkspaceFence, WorkspaceHeads, WorkspaceIdentity, WorkspaceJournal, WorkspaceListing, WorkspacePort, WorkspaceStep } from './workspacePort'
import { agentMsg, type AgentMsg } from '../../shared/agentText'
import { carriesBinding, chainIsBinding, forgetBindingIn, isJjLineKey, parseJjLineKey, sameBinding, type JjBinding, type JjPrepJournal, type JjPrepStore } from './jjSlotPrep'

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
  /** HI-3050: what a slot's make refused `exists` adds after what it read there (never where the folder came from). */
  existsLeft: 'Combwork makes a slot only in a folder it creates itself, so it left this one as it is: remove or move it to make the slot here', // i18n-ignore: as above
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
  journal: "the preparation's record can't be read", // i18n-ignore: as above
  gitLink: "a Git worktree entry is still registered for this folder and Combwork can't prove it is its own: it was left as it is, for you to remove or keep" // i18n-ignore: as above
} as const

/**
 * HI-3003: the slot pool's failures in jj's words (WorkspacePort.says): a jj slot's agent was told of git, branches and
 * `git switch`, none of which apply in a jj workspace, and may then have run git there.
 */
export const JJ_SAYS: Partial<Record<SlotWord, AgentMsg>> = {
  branchUnread: agentMsg({ id: 'slot.jj.workspaceUnread', text: "jj couldn't read {slot}'s workspace", note: "HI-3003: why a jj slot couldn't be prepared for its card: jj couldn't read the slot's workspace (what it is bound to). The jj counterpart of slot.prepare.branchUnread: names no git or branch." }),
  filesUnread: agentMsg({ id: 'slot.jj.filesUnread', text: "jj couldn't read {slot}'s files", note: "HI-3003: why a jj slot couldn't be prepared for its card: jj couldn't say whether its working copy has changes. The jj counterpart of slot.prepare.filesUnread." }),
  lineUnread: agentMsg({ id: 'slot.jj.lineUnread', text: "jj couldn't read {what}", note: "HI-3003: a jj slot's setup or preparation error: jj couldn't read the card's line or the target bookmark. {what} is its name. The jj counterpart of slot.error.gitRead." }),
  switchFailed: agentMsg({ id: 'slot.jj.prepareFailed', text: "jj couldn't prepare {slot} for the card: {error}", note: "HI-3003: why a jj slot couldn't be prepared for its card: jj refused or failed the step that puts its workspace on the card's base. {error} is jj's first line, else failed. The jj counterpart of slot.prepare.switchFailed: names no git or switch." }),
  createFailed: agentMsg({ id: 'slot.jj.workspaceAdd', text: 'jj workspace add: {error}', note: "HI-3003: a jj slot's setup error: `jj workspace add` failed. {error} is jj's first line, else failed. The jj counterpart of slot.error.worktreeAdd." }),
  notListed: agentMsg({ id: 'slot.jj.notListed', text: 'its folder is there but jj does not list it as a workspace', note: "HI-3003: a jj slot's setup error: its folder exists but isn't a workspace jj knows, so Combwork leaves it alone. The jj counterpart of slot.error.notListed." }),
  removeFailed: agentMsg({ id: 'slot.jj.forgetFailed', text: 'jj workspace forget failed', note: "HI-3003: why a jj slot is kept, not removed: jj's removal of its workspace refused and said nothing. The jj counterpart of slot.remove.failed." }),
  noTarget: agentMsg({ id: 'slot.jj.noTarget', text: 'no target bookmark', note: "HI-3003: why Combwork can't tell whether a jj slot's work is in its target: the project has no target bookmark (Version Control → Workflow's Work merges into). The jj counterpart of slot.check.noTarget." })
}

/** A colocation change under a jj workspace since its context was read (HI-2896): refused inside the store's lock, nothing written. */
export class JjStoreChanged extends Error {
  constructor(readonly root: string) {
    super(`the jj repository at ${root} changed its Git store (its colocation) since it was read: nothing was written`) // i18n-ignore: jj's side of an error, in English as jj's messages are
  }
}

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
  /** A test's seam (HI-2887): run after a control proof's awaited reads, before its synchronous check. */
  controlProved?: () => void
  /** A test's seam (HI-2870): run once a slot's parent folder is made, before the control's proof for its add. */
  slotParentMade?: () => void
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
  /**
   * HI-2924 (Darren's decision): whether the user's own Done stands for a binding's card cycle whose containment isn't
   * proved (`doneUnproved`: a hand-resolved integration). True: the slot is reused or detached as if contained; its chain
   * must still be exactly the card's submitted work. Absent: never.
   */
  doneByUser?: (store: string, binding: JjBinding) => boolean | Promise<boolean>
  /**
   * HI-3046: where a colocated slot's Git worktree receipt is kept (board_meta, by its folder), so an entry its deleted
   * folder left can be proved Combwork's and cleared before the slot is made again. Absent: no receipt, nothing cleared.
   */
  gitLink?: (repo: string, folder: string) => WorkspaceJournal
  /**
   * Test hooks, run between steps. `beforeGitLinkAside` runs synchronously between a Git worktree entry's last check and
   * its move aside; `afterGitLinkAside` right after the move, before the moved entry is proved again (HI-3046).
   */
  hooks?: { afterForget?: (folder: string) => void | Promise<void>; beforeGitLinkAside?: (entry: string) => void; afterGitLinkAside?: (aside: string) => void | Promise<void>; beforeLeftoverAside?: (folder: string) => void }
}

export interface JjWorkspacePort extends WorkspacePort {
  platform: 'jj'
  /** A workspace's name for a folder of this project: `cw-<project hash>-<folder's name>`, collision-safe across projects of one store. */
  nameFor(repo: string, folder: string): string
  /** Whether a folder's workspace is stale (unknown when that can't be read). */
  stale(folder: string): Promise<Maybe<boolean>>
  /**
   * `record`, with the new files jj left out of the snapshot for its size limit (HI-2973) apart as well: `files` is
   * `record`'s answer (they are in it), `leftOut` those files alone, as jj named them.
   */
  recordLeftOut(folder: string, fence: WorkspaceFence, identity?: WorkspaceIdentity | null): Promise<Maybe<{ files: string[]; leftOut: string[] }>>
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
  /** What an interrupted or lost control making left (HI-2887's residues), at most `limit`, and how many there are (HI-2869). */
  residues(repo: string, limit: number): { rows: { path: string; name?: string; why: string }[]; total: number }
  /**
   * Residues proved gone dropped from the record (HI-2869/s13, s16): under the store's lock, a fair batch of at most 16
   * (rotating), each dropped only when its path is absent (ENOENT or ENOTDIR) and its registration isn't in jj's list at
   * the single head; the head, the absences and the record checked again synchronously right before the write. How many.
   */
  pruneResidues(repo: string): Promise<number>
  /**
   * Runs jj (the port's runner) in a folder, pinned at `op` (a read) or writing; a write's `recheck` runs under the file
   * gate's admission right before jj starts (HI-2918). For recovery and tests.
   */
  jj(folder: string, args: readonly string[], o?: { op?: string; write?: boolean; recheck?: () => Promise<string | null> | string | null }): Promise<JjRunResult>
}

const SEPARATOR = '\u001f'
/** How far back the operation log is read for a preparation's marked write, and its records' end. */
const OP_WALK = 200
const OP_END = 'cw-op-end'
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length)
const step = (ok: boolean, err = ''): WorkspaceStep => ({ ok, err })

/**
 * A failed add's error with what it left (HI-3050/s10 §3): jj's `Error:` line (the one the pool shows: the port's
 * errorLine), else its first line, saying the folder was kept and why, then jj's full answer as it was.
 */
export function keptNote(err: string, folder: string, why: string): string {
  const all = lines(err)
  const line = all.find((l) => l.startsWith('Error:'))?.replace(/^Error:\s*/, '') ?? all[0] ?? 'failed' // i18n-ignore: as JJ_REFUSED
  return `Error: ${line} (its folder ${folder} was left as it is: ${why})${err.trim() ? `\n${err}` : ''}` // i18n-ignore: as JJ_REFUSED
}
const ownedPrefix = (repoHash: string): string => `cw-${repoHash}-`
/** Residues a prune looks at in one pass (HI-2869/s16: bounded, rotating). */
const PRUNE_BATCH = 16
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
  // Read under Combwork's file gate (HI-2918): never while a jj write of Combwork's replaces it (or waits to).
  const key = await pathKey(folder)
  if (!key) return null
  const buf = await jjFileGate.read([rootKey(key)], () => readFile(join(folder, '.jj', 'working_copy', 'checkout')).catch(() => null))
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

  /**
   * The jj repository holding a folder (cached per folder while it answers; detection's unknown is null). A cached one is
   * used only while its folder's files still name its store (HI-2896, s13 §3): a colocation change (the store moving
   * between `.jj/repo/store/git` and `.git`) drops it, and the folder is detected afresh.
   */
  const contextOf = async (folder: string): Promise<JjContext | null> => {
    const key = resolve(folder).toLowerCase()
    const was = contexts.get(key)
    const cached = was ? await was : null
    if (cached && (await storeStill(cached))) return cached
    if (was && contexts.get(key) === was) contexts.delete(key)
    let c = contexts.get(key)
    if (!c) {
      c = jjContextOf(folder, runner).then((d) => ('jj' in d ? d.jj : null))
      contexts.set(key, c)
      void c.then((v) => v ?? contexts.delete(key))
    }
    return c
  }

  /** Whether a context's root still names its store and colocation by its files (HI-2896: no colocation change since). */
  const storeStill = async (ctx: JjContext): Promise<boolean> => {
    const b = await boundaryOf(ctx.root)
    if ('jj' in b) return !ctx.colocated && samePath(await realOr(b.jj.store), await realOr(ctx.store))
    if ('colocated' in b) return ctx.colocated && samePath(await realOr(b.colocated.store), await realOr(ctx.store))
    return false
  }

  /**
   * The store's lock with the store checked again inside it (HI-2896, s13 §3): a colocation change after `ctx` was read
   * refuses before anything is written (a JjStoreChanged), and the folder's context is detected afresh next time.
   */
  const lockCtx = <T>(ctx: JjContext, fn: () => Promise<T>): Promise<T> =>
    deps.lock(ctx.store, async () => {
      if (!(await storeStill(ctx))) {
        for (const [k, v] of contexts) if ((await v)?.root === ctx.root) contexts.delete(k)
        throw new JjStoreChanged(ctx.root)
      }
      return fn()
    })

  /** A write's `recheck` runs under the file gate's admission, right before jj starts; `also`: other workspaces it writes (HI-2918). */
  const jj = (folder: string, args: readonly string[], o: { op?: string; write?: boolean; recheck?: () => Promise<string | null> | string | null; also?: readonly string[] } = {}): Promise<JjRunResult> =>
    runner.run(folder, o.op ? ['--at-op', o.op, ...args] : args, o.write ? { write: true, ...(o.recheck ? { recheck: o.recheck } : {}), ...(o.also ? { also: o.also } : {}) } : {})

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

  /** A control's record and residues as the journal keeps them (HI-2887). */
  type ControlResidue = { path: string; name?: string; why: string }
  type ControlRec = { everReady?: boolean; phase?: string; token?: string; name?: string; store?: string; tokenFolder?: string; tokenGeneration?: string; ws?: string; wsGeneration?: string; residues?: ControlResidue[]; folder?: string; workspace?: string; generation?: string }

  /** The control's record read now, and whether a record proves its control usable now (the path) (HI-2887). */
  const controlReads = (repo: string, ctx: JjContext) => {
    const c = deps.control(repo)
    type Rec = ControlRec
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
    return { recNow, usable, folderGen }
  }

  /**
   * The control proved for one use (HR1's rounds 1–2 on HI-2887, J5's and J7's pattern): every awaited read first (the
   * record, both generations, the checkout's name, its store, the empty sparse state, and the bytes of its checkout
   * record and its repository pointer), then `check()`, synchronous, which the consumer calls in the same continuation
   * immediately before starting its add or forget, with nothing awaited between: the journal still exactly that record,
   * both folders' identities (file id and birth time) still those, the folder still holding nothing but `.jj`/`.git`, and
   * those two files' bytes still the ones read. Any change: the use is refused (the next look recovers by the residue
   * rules). Null when the control isn't usable now.
   */
  const controlProof = async (repo: string, ctx: JjContext): Promise<{ path: string; check: () => boolean } | null> => {
    const c = deps.control(repo)
    const r = controlReads(repo, ctx)
    const rec = r.recNow()
    if (!rec) return null
    const path = rec.token ? rec.ws : c.folder
    if (!path) return null
    const pointer = join(path, '.jj', 'repo')
    const checkout = join(path, '.jj', 'working_copy', 'checkout')
    // The bytes first, then the proof (its checkout name read after them): the final check compares these bytes. Both
    // under Combwork's file gate for the control's working copy (HI-2918); the final check's sync reads get nothing (a
    // failed check) while a write holds or waits on it, unless they are that write's own recheck.
    const key = await pathKey(path)
    if (!key) return null
    const gate = [rootKey(key)]
    const bytes = await jjFileGate.read(gate, () => Promise.all([readFile(pointer).catch(() => null), readFile(checkout).catch(() => null)]))
    if (!bytes[0] || !bytes[1]) return null
    if ((await r.usable(rec)) !== path) return null
    const snap = JSON.stringify(rec)
    const sameBytes = (file: string, was: Buffer): boolean =>
      jjFileGate.readSync(
        gate,
        () => {
          try {
            return readFileSync(file).equals(was)
          } catch {
            return false
          }
        },
        false
      )
    const gen = (p: string, withJj: boolean): string | null => {
      try {
        const a = statSync(p, { bigint: true })
        if (!a.isDirectory() || a.ino === 0n) return null
        if (!withJj) return `${a.ino}:${a.birthtimeNs}`
        const b = statSync(join(p, '.jj'), { bigint: true })
        return b.isDirectory() && b.ino !== 0n ? `${a.ino}:${b.ino}:${a.birthtimeNs}` : null
      } catch {
        return null
      }
    }
    const check = (): boolean => {
      if (JSON.stringify(r.recNow()) !== snap) return false
      if (rec.token ? gen(rec.tokenFolder!, false) !== rec.tokenGeneration || gen(path, true) !== rec.wsGeneration : gen(path, true) !== rec.generation) return false
      let files: string[]
      try {
        files = readdirSync(path)
      } catch {
        return false
      }
      if (!files.every((f) => f === '.jj' || f === '.git')) return false
      return sameBytes(pointer, bytes[0]!) && sameBytes(checkout, bytes[1]!)
    }
    deps.controlProved?.()
    return check() ? { path, check } : null
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
    const { recNow, usable, folderGen } = controlReads(repo, ctx)
    type Residue = ControlResidue
    const fast = await usable(recNow())
    if (fast) return fast
    return lockCtx(ctx, async () => {
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
        // Its destination gated with it (HI-2918): nothing of Combwork's reads the new workspace's files while jj writes them.
        const add = await jj(repo, ['workspace', 'add', ws, '--name', name, '--sparse-patterns', 'empty', '--no-colocate'], { write: true, also: [ws] })
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

  /** A `gitLink` refusal naming the entry and the folder it blocks (HI-3046). */
  const gitLinkRefused = (entry: string, folder: string): string => `${JJ_REFUSED.gitLink} (${entry}, for ${folder})` // i18n-ignore: as JJ_REFUSED

  /**
   * One step of clearing a slot's Git worktree entry (HI-3046/s11–s14), under the store's lock: the entry at `at` (`entry`:
   * in place; `aside`: a clearing's, moved aside before a restart) is removed only when, with the file gate held for the
   * slot's folder and the store, and nothing awaited between: the operation head is still the one whose listing showed
   * no workspace at the folder or under the receipt's name, and `provedSync` holds, before the move and again on what
   * was moved (a replacement or a `locked` between the check and the move is what the second check finds). Then removed
   * (asynchronously, off main's thread), the gate held until it ends. Null when removed; else why not, and what it left.
   */
  const clearAt = async (ctx: JjContext, repo: string, r: GitLinkReceipt, at: string, where: 'entry' | 'aside'): Promise<{ why: string; left?: string } | null> => {
    const op = await pinned(repo)
    if (isUnknown(op)) return { why: 'unreadable' } // i18n-ignore: a protocol code
    const l = await listAt(repo, op)
    if (isUnknown(l)) return { why: 'unreadable' } // i18n-ignore: a protocol code
    if (l.some((w) => w.name === r.workspace || samePath(w.root, r.folder))) return { why: 'registered' } // i18n-ignore: a protocol code
    const [fk, sk] = await Promise.all([pathKey(r.folder), pathKey(ctx.store)])
    if (!fk || !sk) return { why: 'unreadable' } // i18n-ignore: a protocol code
    const grant = await jjFileGate.acquire([rootKey(fk), storeKey(sk)], 'exclusive')
    try {
      const check = (p: string, w: 'entry' | 'aside'): string | null => (readOpHeads(ctx.jjRepo)?.join() !== op ? 'moved' : provedSync(r, p, w)) // i18n-ignore: a protocol code
      let aside = at
      if (where === 'entry') {
        const before = check(at, 'entry')
        if (before) return { why: before }
        aside = asideOf(ctx.store, r.clearing!)
        deps.hooks?.beforeGitLinkAside?.(at)
        try {
          renameSync(at, aside)
        } catch {
          return { why: 'rename' } // i18n-ignore: a protocol code
        }
        await deps.hooks?.afterGitLinkAside?.(aside)
      }
      const after = check(aside, 'aside')
      if (after) {
        // What was moved isn't the receipt's entry now: put back under its name when that is still free, else left aside.
        if (where === 'entry' && !existsSync(at)) {
          try {
            renameSync(aside, at)
            return { why: after }
          } catch {
            /* left aside: a residue */
          }
        }
        return { why: after, left: aside }
      }
      try {
        await rm(aside, { recursive: true })
      } catch {
        return { why: 'remove', left: aside } // i18n-ignore: a protocol code
      }
      return null
    } finally {
      grant.release()
    }
  }

  /**
   * Before a colocated slot is made (HI-3046): a Git worktree entry its deleted folder left at `folder` cleared, when it
   * is provably the one Combwork's receipt names; a clearing interrupted by a restart finished on the same proof. Any
   * entry there that can't be proved Combwork's is left as it is and the make refused (never an add known to collide).
   * Null: nothing in the way. Runs under the store's lock.
   */
  const clearGitLink = async (repo: string, ctx: JjContext, folder: string): Promise<string | null> => {
    if (!ctx.colocated) return null
    const j = deps.gitLink?.(repo, folder) ?? null
    const raw = j?.read() ?? null
    const residues = residuesOf(raw)
    const found = asReceipt(raw)
    let rec = found && samePath(found.store, ctx.store) && samePath(found.folder, folder) ? found : null
    const keep = async (left: string, why: string): Promise<void> => {
      if (!j) return
      const all = [...residues.filter((x) => !samePath(x.path, left)), { path: left, why }]
      await j.write(rec ? { ...rec, clearing: undefined, residues: all } : { residues: all })
    }
    if (rec?.clearing && j) {
      // A clearing interrupted: its intent authorises nothing by itself. What was moved aside is removed only on the full
      // proof now; anything else is a residue.
      const aside = asideOf(ctx.store, rec.clearing)
      if (existsSync(aside)) {
        const r = await clearAt(ctx, repo, rec, aside, 'aside')
        if (r) {
          await keep(aside, r.why)
          return gitLinkRefused(aside, folder)
        }
      }
      rec = { ...rec, clearing: undefined }
      await j.write(rec)
    }
    const links = await linksTo(ctx.store, folder)
    if (!links) return gitLinkRefused(worktreesOf(ctx.store), folder)
    if (!links.length) return null
    if (!j || !rec || links.length !== 1 || !samePath(links[0], rec.entry)) return gitLinkRefused(links[0], folder)
    const token = randomUUID().replace(/-/g, '').slice(0, 12)
    rec = { ...rec, clearing: token }
    await j.write(rec)
    const r = await clearAt(ctx, repo, rec, rec.entry, 'entry')
    if (r) {
      if (r.left) await keep(r.left, r.why)
      else {
        rec = { ...rec, clearing: undefined }
        await j.write(rec)
      }
      return gitLinkRefused(r.left ?? rec.entry, folder)
    }
    rec = { ...rec, clearing: undefined }
    await j.write(rec)
    return null
  }

  /** A real directory's file id and birth time (never a link's), read synchronously; null when it isn't one or can't be read. */
  const dirIdSync = (p: string): string | null => {
    try {
      const s = lstatSync(p, { bigint: true })
      return s.isDirectory() && !s.isSymbolicLink() && s.ino !== 0n ? `${s.ino}:${s.birthtimeNs}` : null
    } catch {
      return null
    }
  }
  const emptySync = (p: string): boolean => {
    try {
      return readdirSync(p).length === 0
    } catch {
      return false
    }
  }

  /**
   * A slot's folder made by this attempt itself (HI-3050/s10): exclusively (anything there already is `exists`), its file
   * id and birth time read in the same synchronous step, so a folder at the path with that id is provably this attempt's.
   * `error`: it couldn't be made (nothing made), or was made and can't be read (kept: `kept` set).
   */
  const makeOwn = (folder: string): { id: string } | 'exists' | { error: string; kept?: true } => {
    try {
      mkdirSync(folder)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      return code === 'EEXIST' ? 'exists' : { error: `the folder couldn't be made (${code ?? 'error'})` } // i18n-ignore: as JJ_REFUSED
    }
    const id = dirIdSync(folder)
    return id ? { id } : { error: JJ_REFUSED.generation, kept: true }
  }

  /** A slot's make refused `exists` (HI-3050/s10 §3): only what was read there, never where it came from. */
  const existsRefused = async (repo: string, folder: string): Promise<string> => {
    const files = await readdir(folder).catch(() => null)
    const facts: string[] = []
    if (files) facts.push(files.length ? 'not empty' : 'empty') // i18n-ignore: as JJ_REFUSED
    const op = await pinned(repo)
    const l = isUnknown(op) ? null : await listAt(repo, op)
    if (l && !isUnknown(l) && l.some((w) => samePath(w.root, folder))) facts.push('and jj lists a workspace there') // i18n-ignore: as JJ_REFUSED
    return `${JJ_REFUSED.exists}${facts.length ? `, ${facts.join(', ')}` : ''}: ${JJ_REFUSED.existsLeft}`
  }

  /**
   * After a slot's add failed (HI-3050/s10 §2), under the store's lock: the folder this attempt made (`id0`) removed when
   * it is provably that and nothing else. Only once jj's outcome is settled (`settled`: it didn't start, or ran to its own
   * exit), jj registers no workspace at the folder (under any name) at the single operation head, and no Git worktree entry
   * points at it; then, with the file gate held for the folder and the store and nothing awaited: the operation head still
   * that one, the folder still `id0` and empty, moved aside, proved again on what was moved, and only then `rmdir`ed (never
   * anything non-empty). A mismatch after the move puts it back under its name while that is free, else leaves it aside.
   * Null when removed (or already gone); else why it was kept, and where when that isn't its own path.
   */
  const dropLeftover = async (repo: string, ctx: JjContext, folder: string, id0: string, settled: boolean): Promise<{ why: string; at?: string } | null> => {
    // Each `why` a protocol code, for the setup error and the log.
    if (!settled) return { why: 'uncertain' } // i18n-ignore: a protocol code
    const there = await lstat(folder).catch((e: { code?: string }) => (e?.code === 'ENOENT' ? null : 'unreadable'))
    if (there === null) return null
    if (there === 'unreadable') return { why: 'unreadable' } // i18n-ignore: a protocol code
    if (dirIdSync(folder) !== id0) return { why: 'replaced' } // i18n-ignore: a protocol code
    const op = await pinned(repo)
    if (isUnknown(op)) return { why: 'unreadable' } // i18n-ignore: a protocol code
    const l = await listAt(repo, op)
    if (isUnknown(l)) return { why: 'unreadable' } // i18n-ignore: a protocol code
    // Any workspace at the folder, whatever its name (its name may be another folder's of the same name: not this one's).
    const real = await realOr(folder)
    for (const w of l) if (samePath(w.root, folder) || samePath(await realOr(w.root), real)) return { why: 'registered' } // i18n-ignore: a protocol code
    if (ctx.colocated) {
      const links = await linksTo(ctx.store, folder)
      if (!links) return { why: 'unreadable' } // i18n-ignore: a protocol code
      if (links.length) return { why: 'gitLink' } // i18n-ignore: a protocol code
    }
    const [fk, sk] = await Promise.all([pathKey(folder), pathKey(ctx.store)])
    if (!fk || !sk) return { why: 'unreadable' } // i18n-ignore: a protocol code
    const grant = await jjFileGate.acquire([rootKey(fk), storeKey(sk)], 'exclusive')
    try {
      const check = (p: string): string | null => (readOpHeads(ctx.jjRepo)?.join() !== op ? 'moved' : dirIdSync(p) !== id0 ? 'replaced' : emptySync(p) ? null : 'notEmpty')
      const before = check(folder)
      if (before) return { why: before }
      const aside = join(dirname(folder), `.cw-add-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
      deps.hooks?.beforeLeftoverAside?.(folder)
      try {
        renameSync(folder, aside)
      } catch {
        return { why: 'rename' } // i18n-ignore: a protocol code
      }
      const after = check(aside)
      if (after) {
        // What was moved isn't this attempt's empty folder now: put back under its name while that is free, else left aside.
        if (!existsSync(folder)) {
          try {
            renameSync(aside, folder)
            return { why: after }
          } catch {
            /* left aside */
          }
        }
        return { why: after, at: aside }
      }
      try {
        rmdirSync(aside)
      } catch {
        return { why: 'remove', at: aside } // i18n-ignore: a protocol code
      }
      return null
    } finally {
      grant.release()
    }
  }

  /**
   * A slot's make that failed after its folder was made (HI-3050/s10 §3): the step's error is what failed, its `Error:`
   * line saying what was left when the folder was kept (so the pool's setup error, which shows that line, says it).
   */
  const failedAdd = async (repo: string, ctx: JjContext, folder: string, id0: string, err: string, settled: boolean): Promise<WorkspaceStep> => {
    const kept = await dropLeftover(repo, ctx, folder, id0, settled)
    if (!kept) return step(false, err)
    return step(false, keptNote(err, kept.at ?? folder, kept.why))
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
    return lockCtx(ctx, async () => {
      const ptr0 = prep.pointer(store, ws)
      if (ptr0 === 'unreadable') return step(false, JJ_REFUSED.journal)
      // A restart of the same card in its own slot (HI-2868, s10 §3): its earlier binding carried, with no jj write, only
      // when the slot is the folder it was bound in (its generation), on the same target, from the same base (the start
      // planned on the carried base). Anything else is a fresh preparation, checked as one.
      const carry = kind === 'prepare' && carriesBinding(ptr0, bound)
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
        // Also (HI-2913) exactly the shape a rebase of the card's commit leaves: the working copy empty, neither conflicted nor
        // divergent (both refused above), with one parent, the previous binding's base itself, so nothing lies between them.
        // An empty range alone proves nothing (a working copy on unrelated history has none); its integration is still
        // required below.
        const onPrevBase = !!j.prev && wc.empty && wc.parents.length === 1 && wc.parents[0] === j.prev.base
        // The slot's own work (HI-2995): a detach refused for it is `kept` (the card's, not a refusal to retry).
        const keptStep = (r: WorkspaceStep): WorkspaceStep => (kind === 'detach' && !!j.prev?.card ? { ...r, kept: true } : r)
        // Also (HI-2980, Darren's decision A, with HR1's full-ancestry proof) a slot whose card's commits were rewritten
        // as they were integrated (described, rebased onto a moved target, squashed): nothing in it that isn't in the
        // previous binding's target already. Its working copy empty, a previous binding with a target, that target one
        // known commit T at H, and everything below the working copy (its parents and all their ancestry, not only the
        // range over the old base: unrelated work there is refused) in T's history, read pinned at H. Unknown fails
        // closed. Integration is still proved below, separately: neither stands in for the other.
        const inTarget = async (): Promise<boolean> => {
          const prev = j.prev
          if (!prev?.target || !wc.empty) return false
          const T = await bookmarkAt(folder, H, prev.target)
          if (isUnknown(T) || !T) return false
          const left = await read(folder, H, ['log', '--no-graph', '-n', '1', '-r', `::(${revsetName(ws)}@-) ~ ::${T}`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revisionIn, { folder }))
          return !isUnknown(left) && lines(left).length === 0
        }
        if (!onPrevBase && !chainIsBinding(chain, j.prev) && !(await inTarget())) return keptStep(await refuse(JJ_REFUSED.unintegrated))
        if (j.prev?.submitted.length) {
          const prev = j.prev
          const contained = async (): Promise<boolean> => {
            if (!prev.target || !deps.contains) return false
            const th = await bookmarkAt(folder, H, prev.target)
            if (isUnknown(th) || !th) return false
            const c = await deps.contains(store, prev.target, { base: prev.base, revision: prev.submitted[prev.submitted.length - 1] }, th)
            return !isUnknown(c) && !!c
          }
          // Not proved (HI-2924): the user's own Done on exactly that card cycle stands for it.
          if (!(await contained()) && !(prev.key && deps.doneByUser && (await deps.doneByUser(store, prev)))) return keptStep(await refuse(JJ_REFUSED.notIntegrated))
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
        // Right before the write, after the journal's await: everything again; and again under the file gate's admission,
        // right before jj starts (HI-2918: its wait mustn't leave this proof stale).
        const g2 = await guard(H)
        if (g2) return refuseFor(g2)
        const nu = await jj(folder, [`--config=cw.prep=${run}`, 'new', bound.base], { write: true, recheck: () => guard(H) })
        if (nu.refused) return refuseFor(nu.refused)
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
            const ab = await jj(folder, ['abandon', wc.commit], { write: true, recheck: () => guard(l.op) })
            if (ab.refused) return stopAfterWrite(ab.refused)
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
    says: JJ_SAYS,
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
      if (existsSync(folder)) return step(false, await existsRefused(repo, folder))
      if (await nestedIn(folder, ctx)) return step(false, JJ_REFUSED.nested)
      const from = await control(repo, ctx)
      if (!from) return step(false, JJ_REFUSED.control)
      const name = nameFor(await repoHash(repo), folder)
      return lockCtx(ctx, async () => {
        // A Git worktree entry a deleted slot left here (HI-3046): cleared when provably Combwork's, else refused before
        // the add (which would collide with it in Git and leave a folder behind).
        const blocked = await clearGitLink(repo, ctx, folder)
        if (blocked) return step(false, blocked)
        if (existsSync(folder)) return step(false, await existsRefused(repo, folder))
        // Its parent made first, which jj doesn't make (HI-2870): before the control's proof, so nothing is awaited
        // between the proof's final check and the add (HI-2887).
        await mkdir(dirname(folder), { recursive: true })
        deps.slotParentMade?.()
        // The folder itself made by this attempt, exclusively, its id read with it (HI-3050/s10 §1): jj adds into an
        // empty folder and keeps it, so a failed add's leftover is provably this attempt's and can go (failedAdd).
        const own = makeOwn(folder)
        if (own === 'exists') return step(false, await existsRefused(repo, folder))
        if ('error' in own) return step(false, own.kept ? keptNote(own.error, folder, 'unreadable') : own.error) // i18n-ignore: a protocol code
        const failed = (err: string, settled = true): Promise<WorkspaceStep> => failedAdd(repo, ctx, folder, own.id, err, settled)
        // The control proved for this add, inside the lock; its synchronous check right before the add starts (HI-2887).
        const proof = await controlProof(repo, ctx)
        if (!proof || proof.path !== from || !proof.check()) return failed(JJ_REFUSED.control)
        // From the control (empty, sparse: its snapshot is empty), full files, colocation chosen as the project's. Its
        // destination gated with it, and the control's synchronous check again under the file gate's admission, right
        // before jj starts (HI-2918; HI-2887's "nothing awaited between the check and the add" kept across the wait).
        const r = await jj(from, ['workspace', 'add', folder, '--name', name, '-r', at, '--sparse-patterns', 'full', ctx.colocated ? '--colocate' : '--no-colocate'], { write: true, also: [folder], recheck: () => (proof.check() ? null : JJ_REFUSED.control) })
        // Settled: jj never started (refused), or ran to its own exit. A timeout, a cancellation or a lost worker may
        // leave jj running: the folder is kept.
        if (r.refused) return failed(r.refused)
        if (!r.ok) return failed(r.err, r.code >= 0)
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
        // Its Git worktree entry's receipt (HI-3046), replacing an earlier slot's there; residues carried over. None
        // provable: the old receipt goes, so nothing of this slot's is ever cleared on it.
        const j = ctx.colocated ? (deps.gitLink?.(repo, folder) ?? null) : null
        if (j) {
          const generation = await generationOf(folder)
          const receipt = generation ? await receiptOf({ store: ctx.store, folder, workspace: name, generation }) : null
          const residues = residuesOf(j.read())
          if (receipt) await j.write({ ...receipt, ...(residues.length ? { residues } : {}) })
          else if (residues.length) await j.write({ residues })
          else await j.clear()
        }
        return step(true)
      })
    },
    forgetIn: (db, id) => forgetBindingIn(db, id.store, id.workspace),
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
      await lockCtx(ctx, async () => {
        for (const w of l) {
          if (!gone.some((g) => samePath(g, w.root))) continue
          // Proved again under the lock (HI-2946): what was found gone before the waits may have been restored or
          // replaced since. Still registered under that name at that root, read afresh…
          const now = await pinned(repo)
          if (isUnknown(now)) return
          const fresh = await listAt(repo, now)
          if (isUnknown(fresh)) return
          const cur = fresh.find((x) => x.name === w.name)
          if (!cur || !samePath(cur.root, w.root)) continue
          // The control proved for each forget; its synchronous check right before the forget starts (HI-2887).
          const proof = await controlProof(repo, ctx)
          if (!proof || proof.path !== from || !proof.check()) return
          // …and, with the control's proof, under the file gate's admission right before jj starts (HI-2918), nothing
          // awaited: the operation head still the one that listing read (HR1's round 1 on HI-2946: any registration
          // changed since, such as the name forgotten and added again at another, live root, moves it: not forgotten,
          // decided on the next prune), and its folder still absent (a folder back by then is a live workspace, kept
          // registered with everything in it).
          const f = await jj(from, ['workspace', 'forget', '--', w.name], {
            write: true,
            recheck: () => (!proof.check() ? JJ_REFUSED.control : readOpHeads(ctx.jjRepo)?.join() !== now ? JJ_REFUSED.moved : existsSync(cur.root) ? JJ_REFUSED.exists : null)
          })
          if (f.refused === JJ_REFUSED.exists) continue
          if (f.refused) return
        }
      })
    },
    // A card cycle's preparation (HI-2866/s13): always onto its base (a card's line under jj is made, never "the one it
    // has"), owned and journalled; its binding published once the slot is on the base.
    heldFor: async (folder, identity, card) => {
      if (!identity || !(await owns(folder, identity))) return false
      const b = await bindingNow(folder)
      return !isUnknown(b) && !!b && b.card === card && b.generation === identity.generation
    },
    carries: async (folder, line, base, o) => {
      const k = parseJjLineKey(line)
      if (!k || !base || !o.identity || k.workspace !== o.identity.workspace || !(await owns(folder, o.identity))) return false
      const ctx = await contextOf(folder)
      const prep = ctx && samePath(ctx.store, o.identity.store) ? (deps.prep?.(ctx.store) ?? null) : null
      const ptr = prep ? prep.pointer(ctx!.store, o.identity.workspace) : null
      return ptr !== 'unreadable' && carriesBinding(ptr, { card: k.card, key: line, generation: o.identity.generation, target: o.target ?? null, base })
    },
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
    residues: (repo, limit) => {
      const v = deps.control(repo).journal.read() as { residues?: { path: string; name?: string; why: string }[] } | null
      const all = v && typeof v === 'object' && Array.isArray(v.residues) ? v.residues : []
      return { rows: all.slice(0, Math.max(0, limit)), total: all.length }
    },
    pruneResidues: async (repo) => {
      const ctx = await contextOf(repo)
      if (!ctx) return 0
      const c = deps.control(repo)
      return deps.lock(ctx.store, async () => {
        type Res = { path: string; name?: string; why: string }
        const snap = c.journal.read() as ({ residues?: Res[]; pruneCursor?: number } & Record<string, unknown>) | null
        const all = snap && Array.isArray(snap.residues) ? snap.residues : []
        if (!snap || !all.length) return 0
        const start = (snap.pruneCursor ?? 0) % all.length
        const batch = [...all.slice(start), ...all.slice(0, start)].slice(0, PRUNE_BATCH)
        const op = await pinned(repo)
        if (isUnknown(op)) return 0
        const listed = await listAt(repo, op)
        if (isUnknown(listed)) return 0
        const absent = async (p: string): Promise<boolean> => lstat(p).then(() => false, (e: { code?: string }) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR')
        const candidates: Res[] = []
        for (const r of batch) if ((await absent(r.path)) && (!r.name || !listed.some((w) => w.name === r.name))) candidates.push(r)
        if (!c.journal.update) return 0
        const absentNow = (p: string): boolean => {
          try {
            lstatSync(p)
            return false
          } catch (e) {
            const code = (e as { code?: string }).code
            return code === 'ENOENT' || code === 'ENOTDIR'
          }
        }
        // The final step runs inside the journal's own write (HR2's round 1), after any wait for its lock, nothing awaited:
        // the record still exactly the one read, the head unchanged, each absence again; anything else writes nothing.
        let dropped = 0
        const wrote = await c.journal.update((current) => {
          if (JSON.stringify(current) !== JSON.stringify(snap)) return undefined
          if (readOpHeads(ctx.jjRepo)?.join() !== op) return undefined
          const drop = new Set(candidates.filter((r) => absentNow(r.path)))
          const keep = all.filter((r) => !drop.has(r))
          dropped = drop.size
          return { ...snap, residues: keep, pruneCursor: keep.length ? (start + PRUNE_BATCH - drop.size) % keep.length : 0 }
        })
        return wrote ? dropped : 0
      })
    },
    binding: (folder) => bindingNow(folder),
    pointerSync: (store, workspace) => deps.prep?.(store)?.pointer(store, workspace) ?? null,
    submitted: async (folder, line, commits, identity, seq) => {
      const ctx = await contextOf(folder)
      const prep = ctx ? (deps.prep?.(ctx.store) ?? null) : null
      if (!ctx || !prep || !identity || !samePath(ctx.store, identity.store)) return false
      return lockCtx(ctx, async () => {
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
      const r = await port.recordLeftOut(folder, fence, identity)
      return isUnknown(r) ? r : r.files
    },
    recordLeftOut: async (folder, fence, identity) => {
      const u = unknown(UNREADABLE.uncommitted, { folder })
      const op = await pinned(folder)
      if (isUnknown(op)) return op
      if (!(await isRecorded(folder, op, identity))) return withDetail(u, JJ_REFUSED.identity)
      const stale = await staleAt(folder, op)
      if (isUnknown(stale)) return stale
      if (stale) return withDetail(u, JJ_REFUSED.stale)
      // Right before the write: still its holder's, still the recorded workspace; both again under the file gate's
      // admission, right before jj starts (HI-2918).
      const still = async (): Promise<string | null> => (!(await fence.still()) ? JJ_REFUSED.fence : !(await owns(folder, identity)) ? JJ_REFUSED.identity : null)
      const before = await still()
      if (before) return withDetail(u, before)
      // The explicit snapshot: `status` writing, never updating a stale copy (the runner's prefix keeps auto-update off).
      const snap = await jj(folder, ['--config=snapshot.auto-update-stale=false', 'status'], { write: true, recheck: still })
      if (snap.refused) return withDetail(u, snap.refused)
      if (!snap.ok) return withDetail(u, snap.err)
      const after = await pinned(folder)
      if (isUnknown(after)) return after
      const name = await nameAt(folder, after)
      if (isUnknown(name)) return name
      const out = await read(folder, after, ['diff', '--summary', '-r', `${revsetName(name)}@`], u)
      if (isUnknown(out)) return out
      // A new file jj left out for its size (HI-2973) is on disk and in no commit: listed with the rest, so a release,
      // a reuse, a removal or a copy's check sees it as an uncommitted edit, as Git's would an untracked file.
      const leftOut = snapshotRefused(snap.err)?.files ?? []
      const files = lines(out).map((l) => l.replace(/^[A-Z] /, ''))
      return { files: [...files, ...leftOut.filter((f) => !files.includes(f))], leftOut }
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
      // Each write's check again under the file gate's admission, right before jj starts (HI-2918).
      const snap = await jj(folder, ['--config=snapshot.auto-update-stale=false', 'status'], { write: true, recheck: mine })
      if (snap.refused) return refused('checkout', snap.refused)
      if (!snap.ok) return refused('clean', snap.err)
      // A stray file jj left out for its size (HI-2973) would stay on disk past the reset: not the revision's files.
      const left = snapshotRefused(snap.err)
      if (left) return refused('clean', refusedDetail(left))
      const mid = await state(folder)
      if (isUnknown(mid)) return refused('clean', mid.detail ?? mid.what)
      const old = mid.wc.commit
      why = await mine()
      if (why) return refused('checkout', why)
      const nu = await jj(folder, ['new', revision], { write: true, recheck: mine })
      if (nu.refused) return refused('checkout', nu.refused)
      if (!nu.ok) return refused('checkout', nu.err)
      const after = await state(folder)
      if (isUnknown(after)) return refused('checkout', after.detail ?? after.what)
      // The old change, if jj kept it (not empty): abandoned only as the copy's own (no descendant, no bookmark, no workspace's).
      const kept = await read(folder, after.op, ['log', '--no-graph', '-r', `${old} & visible_heads() & ~bookmarks() & ~working_copies()`, '-T', 'commit_id ++ "\\n"'], unknown(UNREADABLE.revision, { revision: old }))
      if (isUnknown(kept)) return refused('clean', kept.detail ?? kept.what)
      if (lines(kept).length) {
        why = await mine()
        if (why) return refused('clean', why)
        const ab = await jj(folder, ['abandon', old], { write: true, recheck: mine })
        if (ab.refused) return refused('clean', ab.refused)
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
        const forgot = await lockCtx(ctx, async () => {
          if (!(await fenced())) return null
          if (existsSync(folder) && !(await owns(folder, identity))) return 'identity' as const
          // The control proved for the forget; the journal's intent written; then, with nothing awaited, its synchronous
          // check and the forget's start (HI-2887).
          const proof = await controlProof(repo, ctx)
          if (!proof || proof.path !== from) return 'control' as const
          if (phase === 'start') await journal.write({ phase: 'forgetting', workspace: identity.workspace, folder, generation: identity.generation, store: identity.store })
          if (!proof.check()) return 'control' as const
          // All of it again under the file gate's admission, right before jj starts (HI-2918): still the holder's, still
          // the recorded workspace, the control's check (inside the store's lock, which this context already holds).
          const again = async (): Promise<string | null> => (!(await fenced()) ? 'fence' : existsSync(folder) && !(await owns(folder, identity)) ? 'identity' : !proof.check() ? 'control' : null)
          // The removed workspace's root in its admission too (HR2's HI-2918 round 1): its recheck reads that checkout.
          const f = await jj(from, ['workspace', 'forget', '--', identity.workspace], { write: true, recheck: again, also: [folder] })
          if (f.refused === 'fence') return null
          if (f.refused === 'identity' || f.refused === 'control') return f.refused
          return f
        })
        if (forgot === null) return step(false, JJ_REFUSED.fence)
        if (forgot === 'identity') return step(false, JJ_REFUSED.identity)
        if (forgot === 'control') return step(false, JJ_REFUSED.control)
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
        // Its Git worktree entry gone with the forget (HI-3046): its receipt goes too. One jj left (the folder was gone)
        // keeps it, so the slot's next make can clear that entry.
        const j = ctx.colocated ? (deps.gitLink?.(repo, folder) ?? null) : null
        const raw = j?.read() ?? null
        const rec = asReceipt(raw)
        if (j && rec && !rec.clearing && entryIdSync(rec.entry) !== rec.entryId) {
          const residues = residuesOf(raw)
          await (residues.length ? j.write({ residues }) : j.clear())
        }
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
