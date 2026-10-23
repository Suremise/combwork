// A project's slot pool (#1429, SPEC §16.10.1–16.10.2): the worktrees Hive lends to a card or a lane (a dispatch lease)
// and gets back when it ends, kept ready between loans. Slots and leases are typed rows of hive.db (schema/v1_0.ts,
// SLOTS_STEP): at most one open lease per slot, and one open dispatch lease and one carried lease per agent, by partial
// unique indexes, so two Hives (or processes) lending at once can't both get one slot, however their code races; the
// second is refused ("slot-b is in use by HI-B1 for AM-12").
//
// Operations. Whatever changes a slot outside one write (warming it for a lease, removing it) is an operation that owns
// the slot (`op` on its row) from the write that starts it to the write that ends it: its token, kind and holder process
// (pid and start). Every write it makes is fenced on its token (OpLost otherwise: it stops, writing nothing more and
// touching nothing on disk), and nothing else starts an operation, lends, adopts or removes the slot while it is held.
// Another Hive (or this one, for a token it no longer runs: a workspace closed and opened again) takes an operation
// over only once its holder process is gone, and only after settling its job: a command an operation runs is recorded
// (`job`, its job on the process supervisor) before it starts and cleared only once its processes are seen ended; until
// then the slot isn't lent, also after the operation ended (a job that couldn't be emptied), and `refresh` settles it
// again. A warming taken over is failed (its lease ended `interrupted`, the slot not ready: never reported ready);
// a removal taken over is looked at again (ready, dirty or gone).
//
// - Lending reserves a ready slot (the builder's last, then the most recently used) with its lease and a warming
//   operation in one write, or a new one (`slot-a`, `slot-b`…: skipping names in use, folders on disk such as the merge
//   queue's, and `copies`) while the pool is under its size (the builders, at most the agent cap). It is handed over only
//   once the operation has looked at it again (a free slot may have changed since it was released: dirty, a session or
//   a process in it; then it is marked so and another is tried), made it if new (a detached worktree at the target's
//   head, the project's copied files, its setup as one of Hive's runs, "Hive (slot slot-b)"), recreated it if gone, and
//   installed again when its lock files changed. A failed setup leaves it not ready, with the run's log: lending skips
//   it. The same card asking again gets its lease only once the slot is ready (`warming` while another Hive warms it).
// - A carried lease (#1441: an agent's migrated worktree) protects its slot: never lent to anyone else, nor cleaned up,
//   while it is open, even while its agent holds a dispatch lease elsewhere. Adopting one is refused while the slot has
//   an operation or a job, or when its recorded folder is another.
// - Releasing ends the lease; the slot is looked at once no operation holds it: `dirty` (uncommitted or untracked files
//   that aren't ignored, not lent until clean), `gone`, or `ready`. A leased slot gone from disk is marked `gone`.
// - Removal (the one way a slot goes) is an operation: guarded (never with a session or a process in it, the latter
//   proved by renaming its folder aside and back, an open lease, a queue entry in flight for a card it held,
//   uncommitted or untracked files, or a head the target doesn't contain: §16.3.2, squash merges included), the archive
//   command first (its failure, or processes it left that couldn't be ended, keep the slot), the guards again, a fenced
//   check that it still holds the slot, then git's own removal, never forced. Idle slots beyond the pool's size go so
//   (`tidy`, Settings → Advanced, Remove idle slots after a day).
//
// What a lease means for where an agent works (launch, resume, one writer per slot) is #1434's folder contract
// (agentFolders.ts), and lending for a card's start is #1438's: this module only keeps the pool.

import { createHash, randomBytes } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'original-fs'
import { readFile, rename } from 'original-fs/promises'
import { join } from 'path'
import { BOARD_MIGRATIONS } from './boardStore'
import { openDb } from './db'
import { samePlace } from './fsutil'
import { git } from './git'
import { createLogger, userText } from './logger'
import * as G from './platform/git'
import { isUnknown } from './platform/types'
import { copyIgnored, listWorktrees } from './worktrees'
import type { ProjectConfig } from '../shared/types'

const log = createLogger('slots')

/** Ports each slot gets (HIVE_SLOT_PORT_BASE and the 9 after it), and where a project's blocks start. */
export const SLOT_PORTS = 10
export const PORT_FLOOR = 41000
/** How long a ready slot beyond the pool's size stays unused before `tidy` removes it. */
export const IDLE_MS = 24 * 60 * 60 * 1000
/** Lock files whose contents decide whether a slot's dependencies are installed again. */
const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
/** Folder names in a project's worktrees folder a slot never takes: #1435's review and check copies. */
const RESERVED = new Set(['copies'])
/** What a warming taken over from a holder that is gone leaves as its error (never ready). */
export const INTERRUPTED = 'its setup was interrupted' // i18n-ignore: agent-facing and the log

export type SlotState = 'creating' | 'ready' | 'lent' | 'dirty' | 'gone' | 'removing'
export type LeaseKind = 'card' | 'lane' | 'carried'
export type OpKind = 'warm' | 'remove'

/** The operation that owns a slot now: its token, kind, the lease it warms for, and its holder process. */
export interface SlotOp {
  token: string
  kind: OpKind
  lease: string | null
  pid: number
  started: number
}

export interface Slot {
  /** The project's id (project.json's `id`): stable through renames. */
  project: string
  name: string
  folder: string
  state: SlotState
  portBase: number
  /** The branch it was made from (its clean-up checks its head is in it). */
  target: string | null
  /** Its last install's revision and lock files' hash (null: no lock file then). */
  installRev: string | null
  installHash: string | null
  /** Its last setup or install failed: why (in English, for the log and agents) and the run's log. Not lent meanwhile. */
  warmError: string | null
  warmLog: string | null
  createdAt: string
  usedAt: string
  op: SlotOp | null
  /** A command's job whose processes aren't known to have ended: the slot isn't lent while it is set. */
  job: string | null
  /**
   * The session that writes in it now (#1434, agentFolders.ts): its run, the lease and agent it started under, and its
   * Hive (pid and start). Reserved in the write that lets it start, cleared once it has exited: while it is set the slot
   * isn't lent, adopted, taken by hand or removed, and its lease's end waits for it to drain.
   */
  writer: SlotWriter | null
}

/** A slot's writer (Slot.writer). */
export interface SlotWriter {
  run: string
  lease: string
  agent: string
  pid: number
  started: number
}

export interface SlotLease {
  id: string
  project: string
  slot: string
  kind: LeaseKind
  card: number | null
  lane: string | null
  /** The builder agent's id. */
  agent: string
  from: string
  to: string | null
  why: string | null
  /** The slot's head when it ended (#1434): its conversations may resume by hand while the slot is free and still there. */
  endRev: string | null
}

/** Why a lend was refused (#1438 turns `noSlot` and `warming` into "waiting for a slot"). */
export type SlotRefusal =
  | { why: 'noSlot'; size: number }
  | { why: 'inUse'; slot: string; agent: string; card: number | null; lane: string | null }
  | { why: 'agentLeased'; slot: string; card: number | null; lane: string | null }
  | { why: 'warming'; slot: string }
  | { why: 'busy'; slot: string }
  | { why: 'notReady'; slot: string; state: SlotState; error: string | null }
  | { why: 'setupFailed'; slot: string; error: string; log: string | null }

export type LendResult = { ok: true; lease: SlotLease; slot: Slot } | { ok: false; refusal: SlotRefusal }

/** What a card's preparation came to (#1438): done at a revision, not now (tried again), or not possible (why). */
export type PrepareResult = { ok: true; revision: string } | { retry: string } | { error: string; logPath?: string | null }

/** Why a slot was kept rather than removed (its guards, §16.6.4 data safety). */
export type SlotKept =
  | { why: 'leased'; agent: string }
  | { why: 'session'; detail: string }
  | { why: 'process' }
  | { why: 'inFlight'; card: number }
  | { why: 'dirty'; files: number }
  | { why: 'unmerged'; target: string }
  | { why: 'cantCheck'; detail: string }
  | { why: 'archiveFailed'; error: string; log: string | null }
  | { why: 'busy'; state: SlotState }
  | { why: 'gitRefused'; detail: string }

/** A refusal in English, for agents and the log (the window words its own from the same fields). */
export function refusalText(r: SlotRefusal, name: (agent: string) => string = (a) => a, card: (n: number) => string = (n) => `#${n}`): string {
  const what = (c: number | null, l: string | null): string => (c !== null ? card(c) : `lane ${l}`)
  switch (r.why) {
    case 'noSlot':
      return `no slot free: the pool's ${r.size} ${r.size === 1 ? 'slot is' : 'slots are'} in use`
    case 'inUse':
      return `${r.slot} is in use by ${name(r.agent)} for ${what(r.card, r.lane)}`
    case 'agentLeased':
      return `this agent already builds in ${r.slot} for ${what(r.card, r.lane)}`
    case 'warming':
      return `${r.slot} is being set up`
    case 'busy':
      return `${r.slot} has a session or a process in it`
    case 'notReady':
      return `${r.slot} isn't ready (${r.error ?? r.state})`
    case 'setupFailed':
      return `${r.slot}'s setup failed: ${r.error}`
  }
}

/** A slot's environment for its sessions and runs: its name and its block of SLOT_PORTS ports. */
export function slotEnv(slot: Pick<Slot, 'name' | 'portBase'>): Record<string, string> {
  return { HIVE_SLOT: slot.name, HIVE_SLOT_PORT_BASE: String(slot.portBase) }
}

/** The nth generic slot name (0: slot-a … 25: slot-z, 26: slot-aa…). */
export function slotName(n: number): string {
  let s = ''
  for (let k = n + 1; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
  return `slot-${s}`
}

/** The first generic name free: not a slot of the project's, not a folder in its worktrees folder, not reserved. */
export function nextSlotName(taken: ReadonlySet<string>, root: string): string {
  for (let n = 0; ; n++) {
    const name = slotName(n)
    if (!taken.has(name) && !RESERVED.has(name) && !existsSync(join(root, name))) return name
  }
}

/** The hash of a folder's lock files (names and contents), or null when it has none. */
export async function lockHash(folder: string): Promise<string | null> {
  const h = createHash('sha256')
  let any = false
  for (const f of LOCK_FILES) {
    const data = await readFile(join(folder, f)).catch(() => null)
    if (!data) continue
    any = true
    h.update(`${f}\0${data.length}\0`).update(data)
  }
  return any ? h.digest('hex') : null
}

/**
 * A project's slot options now: project.json's `slots`, else today's worktree setup and copy (Settings → Agents &
 * Worktrees edits those until #1445's Version Control tab), `copyDefault` the settings' copy patterns it inherits.
 */
export function slotOptionsOf(cfg: Pick<ProjectConfig, 'slots' | 'worktreeSetup' | 'worktreeCopy'>, copyDefault: string): SlotOptionsNow {
  return {
    setup: cfg.slots?.setup ?? cfg.worktreeSetup ?? '',
    archive: cfg.slots?.archive ?? '',
    copy: cfg.slots?.copy ?? cfg.worktreeCopy ?? copyDefault ?? ''
  }
}

// --- The store.

/** The database a pool's store reads and writes: the board's in the app, a file's own in tests and other processes. */
export interface SlotConn {
  read<T>(fn: (db: DatabaseSync) => T): T
  /** One transaction (the app's boardWrite): the second of two at once waits for the first. */
  write<T>(fn: (db: DatabaseSync) => T): Promise<T>
  close(): void
}

/** A connection of its own to a workspace database's file (another process; tests): each write BEGIN IMMEDIATE. */
export function fileSlotConn(file: string): SlotConn {
  const db = openDb(file, { migrations: BOARD_MIGRATIONS, hiveVersion: 'slots' })
  const tx = <T>(begin: string, fn: (d: DatabaseSync) => T): T => {
    db.writer.exec(begin)
    try {
      const out = fn(db.writer)
      db.writer.exec('COMMIT')
      return out
    } catch (e) {
      if (db.writer.isTransaction) db.writer.exec('ROLLBACK')
      throw e
    }
  }
  return {
    read: (fn) => tx('BEGIN', fn),
    write: (fn) => Promise.resolve().then(() => tx('BEGIN IMMEDIATE', fn)),
    close: () => db.close()
  }
}

/** An operation no longer holds its slot (another took it over, or it ended): it stops, writing nothing more. */
export class OpLost extends Error {
  constructor(readonly slot: string) {
    super(`the operation no longer holds ${slot}`)
  }
}

type Row = Record<string, string | number | null>
const slotOfRow = (r: Row): Slot => ({
  project: r.project as string,
  name: r.name as string,
  folder: r.folder as string,
  state: r.state as SlotState,
  portBase: r.port_base as number,
  target: (r.target as string | null) ?? null,
  installRev: (r.install_rev as string | null) ?? null,
  installHash: (r.install_hash as string | null) ?? null,
  warmError: (r.warm_error as string | null) ?? null,
  warmLog: (r.warm_log as string | null) ?? null,
  createdAt: r.created_at as string,
  usedAt: r.used_at as string,
  op: r.op ? { token: r.op as string, kind: r.op_kind as OpKind, lease: (r.op_lease as string | null) ?? null, pid: (r.op_pid as number) ?? 0, started: (r.op_started as number) ?? 0 } : null,
  job: (r.job as string | null) ?? null,
  writer: r.writer_run ? { run: r.writer_run as string, lease: r.writer_lease as string, agent: r.writer_agent as string, pid: (r.writer_pid as number) ?? 0, started: (r.writer_started as number) ?? 0 } : null
})
const leaseOfRow = (r: Row): SlotLease => ({
  id: r.id as string,
  project: r.project as string,
  slot: r.slot as string,
  kind: r.kind as LeaseKind,
  card: (r.card as number | null) ?? null,
  lane: (r.lane as string | null) ?? null,
  agent: r.agent as string,
  from: r.from_at as string,
  to: (r.ended_at as string | null) ?? null,
  why: (r.why as string | null) ?? null,
  endRev: (r.end_rev as string | null) ?? null
})

/** Which unique index a failed insert hit: a slot's open lease, an agent's, or a slot's name or folder. */
function constraintOf(e: unknown): 'slot' | 'agent' | 'name' | null {
  const m = e instanceof Error ? e.message : ''
  if (!/UNIQUE constraint failed/i.test(m)) return null
  if (/slot_leases\.slot/.test(m)) return 'slot'
  if (/slot_leases\.agent/.test(m)) return 'agent'
  if (/slots\./.test(m)) return 'name'
  return null
}

/** The process an operation's holder is: its pid and start. */
export interface Holder {
  pid: number
  started: number
}

/** Fields an operation's last write may set. */
type SlotFields = Partial<Pick<Slot, 'installRev' | 'installHash' | 'warmError' | 'warmLog' | 'target'>>
const COLUMN = { installRev: 'install_rev', installHash: 'install_hash', warmError: 'warm_error', warmLog: 'warm_log', target: 'target' } as const

/** A slot free to start an operation on: no operation, no job unsettled, no open lease. */
const FREE = 'op IS NULL AND job IS NULL AND writer_run IS NULL AND NOT EXISTS (SELECT 1 FROM slot_leases l WHERE l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)'

/** One project's slots and leases (its id), on a connection. Reads are one snapshot each; writes one transaction each. */
export class SlotStore {
  constructor(
    readonly conn: SlotConn,
    readonly project: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private iso(): string {
    return this.now().toISOString()
  }

  slots(): Slot[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(slotOfRow))
  }

  slot(name: string): Slot | null {
    return this.conn.read((db) => this.slotIn(db, name))
  }

  private slotIn(db: DatabaseSync, name: string): Slot | null {
    const r = db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, name) as Row | undefined
    return r ? slotOfRow(r) : null
  }

  /** A slot's open lease, if any. */
  openLease(slot: string): SlotLease | null {
    return this.conn.read((db) => openLeaseIn(db, this.project, slot))
  }

  lease(id: string): SlotLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE id = ? AND project = ?').get(id, this.project) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /** The open lease of a card or a lane. */
  leaseOf(of: { card: number } | { lane: string }): SlotLease | null {
    return this.conn.read((db) => {
      const r = ('card' in of ? db.prepare('SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(of.card) : db.prepare('SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(of.lane)) as Row | undefined
      return r && (r.project as string).toLowerCase() === this.project.toLowerCase() ? leaseOfRow(r) : null
    })
  }

  /** The project's open leases. */
  openLeases(): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND ended_at IS NULL').all(this.project) as Row[]).map(leaseOfRow))
  }

  /** Leases of cards and lanes ended since `iso` (#1438: their merged lines are deleted once Done). */
  endedSince(iso: string): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND ended_at IS NOT NULL AND ended_at >= ?').all(this.project, iso) as Row[]).map(leaseOfRow))
  }

  /** An agent's open leases: its dispatch lease and its carried lease, each at most one. */
  leasesOf(agent: string): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL').all(this.project, agent) as Row[]).map(leaseOfRow))
  }

  /** The cards a slot was ever leased for, newest first (a queue entry in flight for one keeps it). */
  cardsOf(slot: string): number[] {
    return this.conn.read((db) => (db.prepare('SELECT card FROM slot_leases WHERE project = ? AND slot = ? AND card IS NOT NULL ORDER BY from_at DESC').all(this.project, slot) as { card: number }[]).map((r) => r.card))
  }

  /**
   * Reserves a slot for a lease in one write, with a warming operation (`token`, held by `holder`) on it: the one
   * named, else a ready, free one not in `skip` (the builder's last, then the most recently used), else a new one
   * (`creating`, its name and ports taken) while the project has fewer than `size`. The lease's row is in the same write,
   * so the indexes refuse a second open lease on the slot or for the agent. The same card or lane asking again gets its
   * lease and slot as they are (`again`): the caller checks it is ready.
   */
  async take(req: LeaseRequest, o: { size: number; root: string; target: string | null; token: string; holder: Holder; skip?: ReadonlySet<string> }): Promise<{ ok: true; lease: SlotLease; slot: Slot; fresh: boolean; again?: boolean } | { ok: false; refusal: SlotRefusal }> {
    try {
      return await this.conn.write((db) => {
        const at = this.iso()
        const mine = this.dispatchOf(db, req.agent)
        if (mine) {
          if ((req.card !== undefined && mine.card === req.card) || (req.lane !== undefined && mine.lane === req.lane)) return { ok: true as const, lease: mine, slot: this.slotIn(db, mine.slot)!, fresh: false, again: true }
          return { ok: false as const, refusal: { why: 'agentLeased' as const, slot: mine.slot, card: mine.card, lane: mine.lane } }
        }
        const held = req.card !== undefined ? (db.prepare('SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(req.card) as Row | undefined) : (db.prepare('SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(req.lane!) as Row | undefined)
        if (held) return { ok: false as const, refusal: { why: 'inUse' as const, slot: held.slot as string, agent: held.agent as string, card: (held.card as number | null) ?? null, lane: (held.lane as string | null) ?? null } }
        const all = (db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(slotOfRow)
        const usable = (s: Slot): boolean => s.state === 'ready' && !s.warmError && !s.op && !s.job && !s.writer && !openLeaseIn(db, this.project, s.name)
        let slot: Slot | undefined
        let fresh = false
        if (req.slot) {
          slot = all.find((s) => s.name.toLowerCase() === req.slot!.toLowerCase())
          const open = slot ? openLeaseIn(db, this.project, slot.name) : null
          if (open) return { ok: false as const, refusal: { why: 'inUse' as const, slot: open.slot, agent: open.agent, card: open.card, lane: open.lane } }
          if (slot && slot.op) return { ok: false as const, refusal: { why: 'warming' as const, slot: slot.name } }
          if (slot && !usable(slot)) return { ok: false as const, refusal: { why: 'notReady' as const, slot: slot.name, state: slot.state, error: slot.warmError } }
        } else {
          const free = all.filter((s) => usable(s) && !o.skip?.has(s.name))
          const last = (s: Slot): string | null => (db.prepare('SELECT agent FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, s.name) as { agent: string } | undefined)?.agent ?? null
          slot = free.find((s) => last(s) === req.agent) ?? free.sort((a, b) => b.usedAt.localeCompare(a.usedAt))[0]
        }
        const id = `l-${randomBytes(6).toString('hex')}`
        let name: string
        if (!slot) {
          if (all.length >= o.size) return { ok: false as const, refusal: { why: 'noSlot' as const, size: o.size } }
          name = req.slot ?? nextSlotName(new Set(all.map((s) => s.name.toLowerCase())), o.root)
          db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at, op, op_kind, op_lease, op_pid, op_started) VALUES (?, ?, ?, 'creating', ?, ?, ?, ?, ?, 'warm', ?, ?, ?)").run(this.project, name, join(o.root, name), freePort(all), o.target, at, at, o.token, id, o.holder.pid, o.holder.started)
          fresh = true
        } else {
          name = slot.name
          // Only from what this write read: free, still the state it had.
          const took = db.prepare(`UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ?, used_at = ? WHERE project = ? AND name = ? AND state = 'ready' AND ${FREE}`).run(o.token, id, o.holder.pid, o.holder.started, at, this.project, name)
          if (Number(took.changes) !== 1) return { ok: false as const, refusal: { why: 'notReady' as const, slot: name, state: slot.state, error: slot.warmError } }
        }
        const lease = this.insertLease(db, id, name, req.card !== undefined ? 'card' : 'lane', req, at)
        return { ok: true as const, lease, slot: this.slotIn(db, name)!, fresh }
      })
    } catch (e) {
      // The indexes are the last word (another process on the same file): refused, not thrown.
      const hit = constraintOf(e)
      if (hit === 'slot' && req.slot) {
        const open = this.openLease(req.slot)
        if (open) return { ok: false, refusal: { why: 'inUse', slot: open.slot, agent: open.agent, card: open.card, lane: open.lane } }
      }
      if (hit === 'agent') {
        const mine = this.leasesOf(req.agent).find((l) => l.kind !== 'carried')
        if (mine) return { ok: false, refusal: { why: 'agentLeased', slot: mine.slot, card: mine.card, lane: mine.lane } }
      }
      if (hit) return { ok: false, refusal: { why: 'noSlot', size: o.size } }
      throw e
    }
  }

  private dispatchOf(db: DatabaseSync, agent: string): SlotLease | null {
    const r = db.prepare("SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL AND kind <> 'carried'").get(this.project, agent) as Row | undefined
    return r ? leaseOfRow(r) : null
  }

  private insertLease(db: DatabaseSync, id: string, slot: string, kind: LeaseKind, req: { agent: string; card?: number; lane?: string }, at: string): SlotLease {
    db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, this.project, slot, kind, kind === 'card' ? req.card! : null, kind === 'lane' ? req.lane! : null, req.agent, at)
    return { id, project: this.project, slot, kind, card: kind === 'card' ? req.card! : null, lane: kind === 'lane' ? req.lane! : null, agent: req.agent, from: at, to: null, why: null, endRev: null }
  }

  /**
   * A carried lease (#1441): an agent's own worktree adopted in place as a slot under its folder's name, protected while
   * the lease is open. The slot's row is made if it has none. Refused (null) when the slot has an operation or a job, is
   * being removed, has a writer, or is recorded at another folder, or the slot or the agent has an open lease.
   */
  async carry(agent: string, slot: { name: string; folder: string; target: string | null }): Promise<SlotLease | null> {
    try {
      return await this.conn.write((db) => this.carryIn(db, agent, slot))
    } catch (e) {
      if (constraintOf(e)) return null
      throw e
    }
  }

  /**
   * `carry` inside a write of the caller's (#1434: the user's Resume taking a free slot, with the rest of its write). A
   * unique index refusing it throws, undoing that whole write.
   */
  carryIn(db: DatabaseSync, agent: string, slot: { name: string; folder: string; target: string | null }): SlotLease | null {
    const at = this.iso()
    const had = this.slotIn(db, slot.name)
    if (!had) db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, ?, ?, 'lent', ?, ?, ?, ?)").run(this.project, slot.name, slot.folder, freePort(this.slotsIn(db)), slot.target, at, at)
    else {
      if (!samePlace(had.folder, slot.folder)) return null
      const took = db.prepare(`UPDATE slots SET state = 'lent', used_at = ? WHERE project = ? AND name = ? AND state <> 'removing' AND ${FREE}`).run(at, this.project, slot.name)
      if (Number(took.changes) !== 1) return null
    }
    return this.insertLease(db, `l-${randomBytes(6).toString('hex')}`, slot.name, 'carried', { agent }, at)
  }

  private slotsIn(db: DatabaseSync): Slot[] {
    return (db.prepare('SELECT * FROM slots WHERE project = ?').all(this.project) as Row[]).map(slotOfRow)
  }

  /** Ends an open lease: the lease as ended, or null when it wasn't open. The slot is looked at by the pool. */
  async end(lease: string, why: string, check?: () => boolean): Promise<SlotLease | null> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE id = ? AND project = ? AND ended_at IS NULL').get(lease, this.project) as Row | undefined
      // The caller's condition, decided in this write (#1438: the card's cycle as the board has it now).
      if (!r || (check && !check())) return null
      const at = this.iso()
      db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE id = ?').run(at, why, lease)
      db.prepare('UPDATE slots SET used_at = ? WHERE project = ? AND name = ?').run(at, this.project, r.slot)
      return { ...leaseOfRow(r), to: at, why }
    })
  }

  /**
   * An ended lease's last revision (#1434): the slot's head once nothing of the lease writes there any more (its lease
   * ended and its writer gone), where its conversations may resume by hand. Only while it is still the slot's newest
   * lease, ended, with no writer on the slot and none recorded yet: a slot lent again since keeps its own. Whether it was.
   */
  async finalizeEndRev(lease: string, rev: string): Promise<boolean> {
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare(
              'UPDATE slot_leases SET end_rev = ? WHERE id = ? AND project = ? AND ended_at IS NOT NULL AND end_rev IS NULL AND id = (SELECT l.id FROM slot_leases l WHERE l.project = slot_leases.project AND l.slot = slot_leases.slot ORDER BY l.from_at DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.project = slot_leases.project AND s.name = slot_leases.slot AND s.writer_run IS NOT NULL)'
            )
            .run(rev, lease, this.project).changes
        ) === 1
    )
  }

  /** A run's writer cleared in every slot still naming it (one write): the slots it was cleared in. */
  async clearWriterRun(run: string): Promise<string[]> {
    return this.conn.write((db) => {
      const names = (db.prepare('SELECT name FROM slots WHERE project = ? AND writer_run = ?').all(this.project, run) as { name: string }[]).map((r) => r.name)
      db.prepare('UPDATE slots SET writer_run = NULL, writer_lease = NULL, writer_agent = NULL, writer_pid = NULL, writer_started = NULL WHERE project = ? AND writer_run = ?').run(this.project, run)
      return names
    })
  }

  /** A writer whose run has ended (or whose Hive is gone) cleared, only while it is still that run. Whether it was. */
  async clearWriter(name: string, run: string): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare('UPDATE slots SET writer_run = NULL, writer_lease = NULL, writer_agent = NULL, writer_pid = NULL, writer_started = NULL WHERE project = ? AND name = ? AND writer_run = ?').run(this.project, name, run).changes) === 1)
  }

  /** A slot's newest lease, open or ended (#1434: whose work it holds). */
  lastLease(slot: string): SlotLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, slot) as Row | undefined
      return r ? leaseOfRow(r) : null
    })
  }

  /**
   * Starts a removal on a slot in one write: only while it is free (no operation, job or open lease) and still in the
   * state it was read in. Whether it started.
   */
  async startRemoval(name: string, from: SlotState, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE slots SET state = 'removing', op = ?, op_kind = 'remove', op_lease = NULL, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = ? AND state <> 'removing' AND ${FREE}`).run(token, holder.pid, holder.started, this.project, name, from).changes) === 1)
  }

  /**
   * One write of an operation: only while it still holds the slot (its token), else OpLost and nothing written. `fn`
   * gets the slot as it is in this write.
   */
  async fenced<T>(name: string, token: string, fn: (db: DatabaseSync, s: Slot) => T): Promise<T> {
    return this.conn.write((db) => {
      const s = this.slotIn(db, name)
      if (!s || s.op?.token !== token) throw new OpLost(name)
      return fn(db, s)
    })
  }

  /** In a fenced write: the slot's state and fields set. */
  setIn(db: DatabaseSync, name: string, state: SlotState, fields: SlotFields = {}, also: { op?: null; job?: string | null } = {}): void {
    const sets = ['state = ?', ...Object.keys(fields).map((k) => `${COLUMN[k as keyof typeof COLUMN]} = ?`)]
    const args: (string | null)[] = [state, ...Object.values(fields).map((v) => v ?? null)]
    if (also.op === null) sets.push('op = NULL, op_kind = NULL, op_lease = NULL, op_pid = NULL, op_started = NULL')
    if (also.job !== undefined) {
      sets.push('job = ?')
      args.push(also.job)
    }
    db.prepare(`UPDATE slots SET ${sets.join(', ')} WHERE project = ? AND name = ?`).run(...args, this.project, name)
  }

  /** In a write: ends a lease if it is open (an operation's own). */
  endIn(db: DatabaseSync, lease: string, why: string): void {
    db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE id = ? AND ended_at IS NULL').run(this.iso(), why, lease)
  }

  /** Whether a lease is open (in a write). */
  openIn(db: DatabaseSync, lease: string): boolean {
    return !!db.prepare('SELECT 1 FROM slot_leases WHERE id = ? AND ended_at IS NULL').get(lease)
  }

  /**
   * Starts a card's preparation on its lease's slot (#1438), as a warming of that lease: only while the slot is lent
   * under it, with no operation or job, and no session writing there but the lease's own. Whether it started.
   */
  async startPrepare(name: string, lease: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare("UPDATE slots SET op = ?, op_kind = 'warm', op_lease = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND state = 'lent' AND op IS NULL AND job IS NULL AND (writer_run IS NULL OR writer_lease = ?) AND EXISTS (SELECT 1 FROM slot_leases l WHERE l.id = ? AND l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)")
            .run(token, lease, holder.pid, holder.started, this.project, name, lease, lease).changes
        ) === 1
    )
  }

  /** Takes over an operation whose holder is gone: only while `was` still holds it. Whether it was taken. */
  async takeOver(name: string, was: string, token: string, holder: Holder): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare('UPDATE slots SET op = ?, op_pid = ?, op_started = ? WHERE project = ? AND name = ? AND op = ?').run(token, holder.pid, holder.started, this.project, name, was).changes) === 1)
  }

  /** Sets a free slot's state from what it was (no operation, lease or writer meanwhile): whether it changed. */
  async look(name: string, from: SlotState, to: SlotState): Promise<boolean> {
    return this.conn.write((db) => Number(db.prepare(`UPDATE slots SET state = ? WHERE project = ? AND name = ? AND state = ? AND op IS NULL AND writer_run IS NULL AND NOT EXISTS (SELECT 1 FROM slot_leases l WHERE l.project = slots.project AND l.slot = slots.name AND l.ended_at IS NULL)`).run(to, this.project, name, from).changes) === 1)
  }

  /** A leased slot's folder is gone: marked so (its holder's sessions are refused, #1434). */
  async markGone(name: string): Promise<void> {
    await this.conn.write((db) => db.prepare("UPDATE slots SET state = 'gone' WHERE project = ? AND name = ? AND state = 'lent' AND op IS NULL").run(this.project, name))
  }

  /** A job left by an ended operation, settled since: cleared, only while no operation holds the slot. */
  async jobSettled(name: string, job: string): Promise<void> {
    await this.conn.write((db) => db.prepare('UPDATE slots SET job = NULL WHERE project = ? AND name = ? AND job = ? AND op IS NULL').run(this.project, name, job))
  }
}

function openLeaseIn(db: DatabaseSync, project: string, slot: string): SlotLease | null {
  const r = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL').get(project, slot) as Row | undefined
  return r ? leaseOfRow(r) : null
}

/** The lowest port block no slot of the project has. */
function freePort(all: Pick<Slot, 'portBase'>[]): number {
  const ports = new Set(all.map((s) => s.portBase))
  let p = PORT_FLOOR
  while (ports.has(p)) p += SLOT_PORTS
  return p
}

// --- The pool.

/** What a lend asks for: a card or a lane (one of them), its builder, and optionally the slot it wants. */
export interface LeaseRequest {
  card?: number
  lane?: string
  agent: string
  slot?: string
}

/** One of Hive's runs for a slot: its setup, an install, its archive command, in the job recorded for it. */
export interface SlotRun {
  /** The slot's name (or the copy's, with `of: 'copy'`: #1435's copies run theirs the same way). */
  slot: string
  of?: 'copy'
  what: 'setup' | 'install' | 'archive'
  command: string
  folder: string
  env: Record<string, string>
  /** Its job's name on the process supervisor, recorded on the slot before the run starts. */
  job: string
  /** Aborted as the workspace closes: the run's processes are ended. */
  signal: AbortSignal
}

export interface SlotRunEnd {
  ok: boolean
  exitCode: number | null
  timedOut?: boolean
  spawnError?: boolean
  /** Why it couldn't start, in English (no process supervisor). */
  error?: string
  logPath: string | null
  /** Its job's processes are all seen ended (false: some may run on; the job stays recorded). */
  settled: boolean
}

/** Runs a slot's command as one of Hive's runs ("Hive (slot slot-b)"), to its end, in its job; never throws. */
export type SlotRunner = (r: SlotRun) => Promise<SlotRunEnd>

/** A project's slot options as they apply now: project.json's `slots`, else today's worktree settings. */
export interface SlotOptionsNow {
  setup: string
  archive: string
  copy: string
}

/**
 * This process as an operations' holder: its identity, whether another holder's process still runs, and the tokens of
 * the operations it runs now (one of its own not among them was left by a workspace closed meanwhile: taken over too).
 * One per process in the app.
 */
export interface OpHolder {
  self(): Promise<Holder>
  /** Whether that process still runs; null when it can't be told (then it is taken to). */
  alive(pid: number, started: number): Promise<boolean | null>
  live: Set<string>
}

export interface PoolDeps {
  store: SlotStore
  /** The project's folder (its repository). */
  project: string
  /** Where its slots go: `<workspace>.worktrees/<project>` (worktreesRoot). */
  root: string
  options: () => Promise<SlotOptionsNow>
  /** How many builders the project has (setBuilderCount's, for this project). */
  builders: () => number | Promise<number>
  /** The project's agent cap (Settings → Advanced, Agents per project). */
  cap: () => number
  runner: SlotRunner
  /** Ends a recorded job and what it followed: true once none of its processes runs. */
  settle: (job: string) => Promise<boolean>
  holder: OpHolder
  /** A session running in a folder: what it is (for the log), or null. */
  sessionIn?: (folder: string) => string | null
  /** Whether a card has a merge queue entry in flight. */
  inFlight?: (card: number) => boolean | Promise<boolean>
  /** Settings → Advanced, Remove idle slots after a day. */
  removeIdle?: () => boolean
  /** A lease ended (#1434): its builder's session in the slot (the slot's writer) is stopped once its turn ends. */
  ended?: (lease: SlotLease, slot: Slot) => void
  /**
   * Whether a writer's run is over and its processes are known to have ended (#1434): only then does a refresh clear it
   * (a release that couldn't be written). A writer of a Hive that is gone is never cleared by a refresh: it stays held
   * until the user releases the slot.
   */
  writerOver?: (w: SlotWriter) => boolean | Promise<boolean>
  now?: () => number
}

/** The builder count a pool sizes by, per project folder: the project's agents unless given (#1438 wires the roles). */
let builderCount: ((projectPath: string) => number | Promise<number>) | null = null
export function setBuilderCount(fn: ((projectPath: string) => number | Promise<number>) | null): void {
  builderCount = fn
}
export const builderCountOf = (projectPath: string, fallback: () => number | Promise<number>): number | Promise<number> => (builderCount ? builderCount(projectPath) : fallback())

const newToken = (): string => `o-${randomBytes(8).toString('hex')}`
const newJob = (): string => `slot-${randomBytes(6).toString('hex')}`

export class SlotPool {
  private readonly store: SlotStore
  /** The operations this pool runs now, awaited as it closes. */
  private readonly running = new Set<Promise<unknown>>()
  private readonly life = new AbortController()

  constructor(readonly deps: PoolDeps) {
    this.store = deps.store
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The pool's size: the builders, at least one, at most the cap. */
  async size(): Promise<number> {
    return Math.max(1, Math.min(this.deps.cap(), await this.deps.builders()))
  }

  slots(): Slot[] {
    return this.store.slots()
  }

  slotOf(lease: SlotLease | string): Slot | null {
    const l = typeof lease === 'string' ? this.store.lease(lease) : lease
    return l ? this.store.slot(l.slot) : null
  }

  leaseOf(of: { card: number } | { lane: string }): SlotLease | null {
    return this.store.leaseOf(of)
  }

  lease(id: string): SlotLease | null {
    return this.store.lease(id)
  }

  leasesOf(agent: string): SlotLease[] {
    return this.store.leasesOf(agent)
  }

  openLeases(): SlotLease[] {
    return this.store.openLeases()
  }

  endedSince(iso: string): SlotLease[] {
    return this.store.endedSince(iso)
  }

  openLease(slot: string): SlotLease | null {
    return this.store.openLease(slot)
  }

  /** Runs an operation as this pool's: its token among the holder's live ones while it runs, awaited by `close`. */
  private async op<T>(token: string, fn: () => Promise<T>): Promise<T> {
    this.deps.holder.live.add(token)
    const p = fn()
    this.running.add(p)
    try {
      return await p
    } finally {
      this.running.delete(p)
      this.deps.holder.live.delete(token)
    }
  }

  /**
   * A start's claim of a slot's writer (#1434), tracked as this pool's work as an operation is: `close` awaits it until
   * the start has either spawned its process (which its session's exit then releases) or released the writer. Null
   * once the pool is closing: no claim is made then.
   */
  trackWriter(): { done: () => void } | null {
    if (this.closed) return null
    let done!: () => void
    const p = new Promise<void>((r) => (done = r))
    this.running.add(p)
    void p.then(() => this.running.delete(p))
    let once = false
    return {
      done: () => {
        if (once) return
        once = true
        done()
      }
    }
  }

  /** The workspace closes: running commands are ended (their runs' signal), and the operations awaited. */
  async close(): Promise<void> {
    this.life.abort()
    await Promise.allSettled([...this.running])
  }

  get closed(): boolean {
    return this.life.signal.aborted
  }

  /**
   * Lends a slot to a card or a lane for its builder: a ready one looked at again, else a new one while the pool is
   * under its size, warmed before it is given. Refused, with why, when none is free, the slot asked for is in use, the
   * agent already builds in another, the card's slot is being set up, or a new slot's setup failed (its lease then ended
   * `setupFailed`).
   */
  async lend(req: LeaseRequest, o: { target?: string; install?: boolean } = {}): Promise<LendResult> {
    if ((req.card === undefined) === (req.lane === undefined)) throw new Error('a lease is for a card or a lane')
    if (this.closed) return { ok: false, refusal: { why: 'noSlot', size: 0 } }
    await this.refresh()
    const target = o.target ?? (await this.defaultTarget())
    const holder = await this.deps.holder.self()
    const skip = new Set<string>()
    const size = await this.size()
    for (;;) {
      const token = newToken()
      // The operation is this pool's (its token live, its work awaited by close) from before the write that reserves the
      // slot: a refresh meanwhile never takes a reservation just committed for one whose holder is gone.
      const out = await this.op(token, async (): Promise<LendResult | 'skip'> => {
        const taken = await this.store.take(req, { size, root: this.deps.root, target, token, holder, skip })
        if (!taken.ok) return taken
        if (taken.again) {
          // Its lease already: handed over only once the slot is ready (another Hive may be warming it).
          const s = taken.slot
          if (s.op) return { ok: false, refusal: { why: 'warming', slot: s.name } }
          if (s.state !== 'lent' || s.job || s.warmError) return { ok: false, refusal: { why: 'notReady', slot: s.name, state: s.state, error: s.warmError } }
          return { ok: true, lease: taken.lease, slot: s }
        }
        const done = await this.warm(taken.slot, taken.lease, token, taken.fresh, target, o.install !== false)
        if (done === 'ready') return { ok: true, lease: this.store.lease(taken.lease.id)!, slot: this.store.slot(taken.slot.name)! }
        if (done !== 'skip') return { ok: false, refusal: done }
        skip.add(taken.slot.name)
        // The slot asked for by name, passed over: refused once, never reserved again and again.
        return req.slot ? { ok: false, refusal: { why: 'busy', slot: taken.slot.name } } : 'skip'
      })
      if (out !== 'skip') return out
    }
  }

  /** A carried lease for an agent's adopted worktree (#1441); null when it can't be adopted now (see SlotStore.carry). */
  carry(agent: string, slot: { name: string; folder: string; target?: string | null }): Promise<SlotLease | null> {
    return this.store.carry(agent, { ...slot, target: slot.target ?? null })
  }

  /**
   * Ends a lease and looks at its slot once no operation holds it. Whether it was ended. `check`: the caller's condition,
   * decided in the write that ends it (false: it stays open).
   */
  async release(lease: string, why: string, check?: () => boolean): Promise<boolean> {
    const ended = await this.store.end(lease, why, check)
    if (!ended) return false
    const slot = this.store.slot(ended.slot)
    // Its writer (the builder's session there) drains, and is stopped once its turn is over (#1434).
    if (slot) this.deps.ended?.(ended, slot)
    await this.drained(ended.slot)
    return true
  }

  /**
   * After a lease's end or its writer's exit (#1434): with no writer left, the ended lease's last revision recorded
   * (the slot's head now: nothing of it writes there any more) and the slot looked at. While a writer drains, nothing.
   */
  async drained(name: string): Promise<void> {
    const s = this.store.slot(name)
    if (!s || s.writer) return
    const last = this.store.lastLease(name)
    if (last?.to && !last.endRev && existsSync(s.folder)) {
      const rev = await G.head(s.folder)
      if (!isUnknown(rev)) await this.store.finalizeEndRev(last.id, rev)
    }
    await this.settle(name)
  }

  /** A slot no operation, lease or writer holds, looked at: ready, dirty or gone. Otherwise left to its holder. */
  private async settle(name: string): Promise<void> {
    const s = this.store.slot(name)
    if (!s || s.op || s.writer || this.store.openLease(name)) return
    if (s.state === 'creating' || s.state === 'removing') return
    const to = await this.look(s)
    if (to !== s.state) await this.store.look(name, s.state, to)
  }

  /** What a slot is on disk now: gone (no folder, or git doesn't list it), dirty, or ready. */
  private async look(s: Slot): Promise<SlotState> {
    if (!(await this.present(s))) return 'gone'
    const d = await G.dirty(s.folder)
    return isUnknown(d) || d.length ? 'dirty' : 'ready'
  }

  private async present(s: Slot): Promise<boolean> {
    if (!existsSync(s.folder)) return false
    const listed = await listWorktrees(this.deps.project).catch(() => null)
    return !listed || listed.some((l) => samePlace(l.path, s.folder))
  }

  /** Whether an operation's holder is gone: another process that ended, or this one, no longer running that token. */
  private async holderGone(op: SlotOp): Promise<boolean> {
    const me = await this.deps.holder.self()
    if (op.pid === me.pid && op.started === me.started) return !this.deps.holder.live.has(op.token)
    return (await this.deps.holder.alive(op.pid, op.started)) === false
  }

  /**
   * Brings the rows in step with what runs and what is on disk: an operation whose holder is gone is taken over and
   * recovered, a job left unsettled is settled again, an unleased slot left `lent` or `dirty` is looked at, a leased one
   * whose folder is gone is marked `gone`.
   */
  async refresh(): Promise<void> {
    for (const s of this.store.slots()) {
      if (this.closed) return
      // A writer whose run is over, its processes known to have ended, but not cleared (its release couldn't be written).
      if (s.writer && (await this.deps.writerOver?.(s.writer))) {
        if (await this.store.clearWriter(s.name, s.writer.run)) await this.drained(s.name)
        continue
      }
      if (s.op) {
        if (await this.holderGone(s.op)) await this.recover(s)
        continue
      }
      if (s.job) {
        if (await this.deps.settle(s.job)) await this.store.jobSettled(s.name, s.job)
        else continue
      }
      if (this.store.openLease(s.name)) {
        if (s.state === 'lent' && !(await this.present(s))) await this.store.markGone(s.name)
        continue
      }
      if (s.state === 'lent' || s.state === 'dirty' || s.state === 'gone') await this.settle(s.name)
    }
  }

  /**
   * Takes over an operation whose holder is gone: its job settled first (refused, and left to the next refresh, while
   * that fails); a warming is failed (its lease ended `interrupted`, the slot not ready), a removal is looked at again.
   */
  private async recover(s: Slot): Promise<void> {
    const was = s.op!
    const token = newToken()
    await this.op(token, async () => {
      // Eligible still, as the row is now (the holder looked at again), right before the write that takes it over.
      const now = this.store.slot(s.name)
      if (!now?.op || now.op.token !== was.token || !(await this.holderGone(now.op))) return
      if (!(await this.store.takeOver(s.name, was.token, token, await this.deps.holder.self()))) return
      log.warn(`Taking over slot ${userText(s.name)}'s ${was.kind} from process ${was.pid}, which is gone`)
      try {
        // Its processes may still run: then its job stays recorded (the slot out of the pool) until they are seen ended.
        const settled = !s.job || (await this.deps.settle(s.job))
        if (!settled) log.warn(`Slot ${userText(s.name)}'s job ${s.job} couldn't be emptied: it stays out of the pool`)
        const job = settled ? { job: null } : {}
        // A card's preparation (#1438: a warming of a slot already lent): its lease stays, the slot as it is.
        if (was.kind === 'warm' && s.state === 'lent') {
          await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, 'lent', {}, { op: null, ...job }))
          return
        }
        if (was.kind === 'warm') {
          await this.store.fenced(s.name, token, (db) => {
            if (was.lease) this.store.endIn(db, was.lease, 'interrupted')
            this.store.setIn(db, s.name, 'creating', { warmError: INTERRUPTED }, { op: null, ...job })
          })
          return
        }
        const to = await this.look(s)
        await this.store.fenced(s.name, token, (db) => this.store.setIn(db, s.name, to, {}, { op: null, ...job }))
      } catch (e) {
        if (!(e instanceof OpLost)) throw e
      }
    })
  }

  private async defaultTarget(): Promise<string | null> {
    const t = await G.defaultBranch(this.deps.project)
    return isUnknown(t) ? null : t
  }

  /**
   * Runs a command of an operation's in a job recorded on the slot first, the job cleared once its processes are seen
   * ended (else it stays: the slot isn't lent until `refresh` settles it). The run's end, settled or not.
   */
  private async run(name: string, token: string, r: Omit<SlotRun, 'job' | 'signal'>): Promise<SlotRunEnd> {
    const job = newJob()
    await this.store.fenced(name, token, (db) => db.prepare('UPDATE slots SET job = ? WHERE project = ? AND name = ?').run(job, this.store.project, name))
    const end = await this.deps.runner({ ...r, job, signal: this.life.signal })
    if (end.settled) await this.store.fenced(name, token, (db) => db.prepare('UPDATE slots SET job = NULL WHERE project = ? AND name = ? AND job = ?').run(this.store.project, name, job))
    return end
  }

  /**
   * The warming operation of a lease (`token` holds the slot): a free slot looked at again (dirty, a session or a process
   * in it: marked and `skip`ped, its lease ended), made if new or gone, installed again if its lock files changed; then
   * `ready` (the slot `lent`, or looked at if the lease ended meanwhile). A failure leaves the slot not ready with why,
   * its lease ended `setupFailed`; an operation taken over meanwhile stops (`warming`).
   */
  private async warm(slot: Slot, lease: SlotLease, token: string, fresh: boolean, target: string | null, install = true): Promise<'ready' | 'skip' | SlotRefusal> {
    const name = slot.name
    const fail = async (error: string, logPath: string | null = null): Promise<SlotRefusal> => {
      log.warn(`Slot ${userText(name)} of ${userText(this.deps.project)} isn't ready: ${userText(error)}`)
      await this.store.fenced(name, token, (db) => {
        this.store.endIn(db, lease.id, 'setupFailed')
        this.store.setIn(db, name, 'creating', { warmError: error, warmLog: logPath }, { op: null })
      })
      return { why: 'setupFailed', slot: name, error, log: logPath }
    }
    /** Not this time: marked, its lease ended, another slot tried. */
    const pass = async (state: SlotState, why: string): Promise<'skip'> => {
      await this.store.fenced(name, token, (db) => {
        this.store.endIn(db, lease.id, why)
        this.store.setIn(db, name, state, {}, { op: null })
      })
      return 'skip'
    }
    try {
      // The workspace closed between the reservation and now: nothing on disk changes. A new slot is left not ready
      // (nothing made: `tidy` forgets it), an existing one goes back as it was.
      if (this.closed) return fresh ? await fail('the workspace closed') : await this.unreserve(name, lease, token, slot.state)
      let made = fresh
      if (!made) {
        if (!(await this.present(slot))) {
          // Gone from disk while free: made again where it was (git's stale entry pruned first).
          if (existsSync(slot.folder)) return await fail('its folder is there but git does not list it as a worktree')
          await this.store.fenced(name, token, () => undefined)
          await git(this.deps.project, ['worktree', 'prune'])
          made = true
        } else {
          // Free since its last lease: what is in it now, not what was there then.
          const d = await G.dirty(slot.folder)
          if (isUnknown(d) || d.length) return await pass('dirty', 'notClean')
          if (this.deps.sessionIn?.(slot.folder) || !(await quiet(slot.folder))) return await pass('ready', 'busy')
        }
      }
      if (this.closed) return await fail('the workspace closed')
      const opts = await this.deps.options()
      // Still this operation's, right before the worktree is made or anything is copied into it.
      await this.store.fenced(name, token, () => undefined)
      if (made) {
        const at = target ? await G.lineHead(this.deps.project, target) : await G.head(this.deps.project)
        if (isUnknown(at) || !at) return await fail(`git couldn't read ${target ?? 'HEAD'}`)
        const r = await git(this.deps.project, ['worktree', 'add', '--detach', slot.folder, at])
        if (!r.ok) return await fail(`git worktree add: ${r.err.trim().split(/\r?\n/)[0] || 'failed'}`)
        log.info(`Made slot ${userText(name)} at ${at.slice(0, 7)} in ${userText(slot.folder)}`)
        if (opts.copy.trim()) await copyIgnored(this.deps.project, slot.folder, opts.copy).catch((e) => log.warn(`Could not copy files into slot ${userText(name)}`, e))
      }
      const hash = await lockHash(slot.folder)
      // An existing slot is installed again only when asked (#1438: with G15 off nothing is installed for a card).
      const needed = made || (install && hash !== null && hash !== slot.installHash)
      if (needed) {
        const failed = await this.install(name, token, slot, made ? 'setup' : 'install', opts.setup, hash)
        if (failed) return await fail(failed.error, failed.logPath)
      }
      const rev = await G.head(slot.folder)
      const fields: SlotFields = { warmError: null, warmLog: null, ...(needed ? { installRev: isUnknown(rev) ? null : rev, installHash: hash } : {}), ...(made && target ? { target } : {}) }
      // Released meanwhile: the slot as it is now, not lent.
      const after = this.store.lease(lease.id)?.to ? await this.look(slot) : 'lent'
      await this.store.fenced(name, token, (db) => this.store.setIn(db, name, this.store.openIn(db, lease.id) ? 'lent' : after === 'lent' ? 'ready' : after, fields, { op: null }))
      return 'ready'
    } catch (e) {
      if (e instanceof OpLost) return { why: 'warming', slot: name }
      // Anything else: the slot left not ready, never half made and lent.
      return fail(e instanceof Error ? e.message : String(e)).catch(() => ({ why: 'warming' as const, slot: name }))
    }
  }

  /** A slot's setup or install run (the project's setup, else `npm ci` for a package lock): why it failed, or null. */
  private async install(name: string, token: string, slot: Slot, what: 'setup' | 'install', setup: string, hash: string | null): Promise<{ error: string; logPath: string | null } | null> {
    const command = setup.trim() || (hash !== null && existsSync(join(slot.folder, 'package-lock.json')) ? 'npm ci' : '')
    if (!command) return null
    const end = await this.run(name, token, { slot: name, what, command, folder: slot.folder, env: slotEnv(slot) })
    if (!end.settled) return { error: 'processes its setup started could not be ended', logPath: end.logPath }
    if (!end.ok) return { error: end.error ?? (end.timedOut ? 'its setup ran out of time' : end.spawnError ? `its setup couldn't start: ${command}` : `its setup exited with code ${end.exitCode}`), logPath: end.logPath }
    return null
  }

  /**
   * Prepares a lent slot for its card (#1438, SPEC §16.10.1): the card's line checked out, made from `base` (the target's
   * head) or the line it already has (a card started again), and with `install` (G15, Slots are brought up to date)
   * its dependencies installed again when its lock files differ from its last install's. A warming operation of the
   * lease while it runs (#1429's: fenced by its token, taken over once its holder is gone), so nothing lends, removes or
   * starts a session in the slot meanwhile; only on the lease's own slot, with no session writing there but the lease's
   * own. `ready` is the caller's last word right before the slot's files change (its card still current, its builder
   * quiet): a reason, and nothing changes. A slot already on the line is prepared (a repeat changes nothing). `retry`:
   * not now (busy, or not ready); `error`: it can't be (changes not committed, git or the install failed).
   */
  async prepare(leaseId: string, p: { line: string; base: string; install: boolean; ready?: () => Promise<string | null>; around?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<PrepareResult> {
    const lease = this.store.lease(leaseId)
    if (!lease || lease.to) return { error: 'its lease has ended' }
    const name = lease.slot
    const token = newToken()
    return this.op(token, async (): Promise<PrepareResult> => {
      if (!(await this.store.startPrepare(name, leaseId, token, await this.deps.holder.self()))) return { retry: `${name} is busy: being set up, a command of its still running, or another session in it` }
      const end = async (fields: SlotFields = {}): Promise<void> => {
        await this.store.fenced(name, token, (db, s) => this.store.setIn(db, name, s.state, fields, { op: null }))
      }
      try {
        const slot = this.store.slot(name)!
        const on = await G.branch(slot.folder)
        if (isUnknown(on)) {
          await end()
          return { error: `git couldn't read ${name}'s branch` }
        }
        const there = on === p.line
        if (!there) {
          const d = await G.dirty(slot.folder)
          if (isUnknown(d) || d.length) {
            await end()
            return { error: isUnknown(d) ? `git couldn't read ${name}'s files` : `${name} has changes that aren't committed` }
          }
        }
        const had = there ? null : await G.lineHead(slot.folder, p.line)
        if (isUnknown(had)) {
          await end()
          return { error: `git couldn't read ${p.line}` }
        }
        const hash = p.install ? await lockHash(slot.folder) : null
        if (there && !(p.install && hash !== null && hash !== slot.installHash)) {
          await end()
          return { ok: true, revision: await this.headOf(slot.folder) }
        }
        // The caller's last word, then still this operation's, right before the slot's files change.
        const notYet = (await p.ready?.()) ?? null
        if (notYet) {
          await end()
          return { retry: notYet }
        }
        await this.store.fenced(name, token, () => undefined)
        if (!there) {
          // The switch under the caller's guard (the app's: the repository's lock, as merges and branch deletions take it).
          const sw = (): ReturnType<typeof git> => git(slot.folder, had ? ['switch', '--no-guess', p.line] : ['switch', '--no-guess', '-c', p.line, p.base])
          const r = await (p.around ? p.around(sw) : sw())
          if (!r.ok) {
            await end()
            return { error: `git switch: ${r.err.trim().split(/\r?\n/)[0] || 'failed'}` }
          }
          log.info(`Slot ${userText(name)} is on ${userText(p.line)} for lease ${leaseId}`)
        }
        const now = p.install ? await lockHash(slot.folder) : null
        if (p.install && now !== null && now !== slot.installHash) {
          const failed = await this.install(name, token, slot, 'install', (await this.deps.options()).setup, now)
          if (failed) {
            await end({ warmLog: failed.logPath })
            return { error: failed.error, logPath: failed.logPath }
          }
          const rev = await this.headOf(slot.folder)
          await end({ installRev: rev || null, installHash: now })
          return { ok: true, revision: rev }
        }
        await end()
        return { ok: true, revision: await this.headOf(slot.folder) }
      } catch (e) {
        if (e instanceof OpLost) return { retry: `${name}'s preparation was taken over` }
        await end().catch(() => undefined)
        return { error: e instanceof Error ? e.message : String(e) }
      }
    })
  }

  private async headOf(folder: string): Promise<string> {
    const h = await G.head(folder)
    return isUnknown(h) ? '' : h
  }

  /** A reservation given back untouched (the workspace closed before anything was done): its lease ended, the slot as it was. */
  private async unreserve(name: string, lease: SlotLease, token: string, state: SlotState): Promise<SlotRefusal> {
    await this.store.fenced(name, token, (db) => {
      this.store.endIn(db, lease.id, 'closed')
      this.store.setIn(db, name, state, {}, { op: null })
    })
    return { why: 'notReady', slot: name, state, error: 'the workspace closed' }
  }

  /**
   * Removes a slot, guarded (§16.6.4: no switch): kept, with why, while it has an open lease (carried included), an
   * operation or an unsettled job, a session or a process in it, a queue entry in flight for a card it held,
   * uncommitted or untracked files that aren't ignored, or a head its target doesn't contain; and when its archive
   * command fails or leaves processes that can't be ended. Null once removed.
   */
  async remove(name: string): Promise<SlotKept | null> {
    let s = this.store.slot(name)
    if (!s) return null
    if (s.op && (await this.holderGone(s.op))) {
      await this.recover(s)
      s = this.store.slot(name)
      if (!s) return null
    }
    const open = this.store.openLease(name)
    if (open) return { why: 'leased', agent: open.agent }
    if (s.op || s.job) return { why: 'busy', state: s.state }
    const token = newToken()
    const from = s.state
    const slot = s
    return this.op(token, async () => {
      // Taken out of the pool first, in a write that sees it free and as read: nothing lends or adopts it meanwhile.
      if (!(await this.store.startRemoval(name, from, token, await this.deps.holder.self()))) {
        const now = this.store.openLease(name)
        return now ? { why: 'leased', agent: now.agent } : { why: 'busy', state: this.store.slot(name)?.state ?? from }
      }
      const keep = async (kept: SlotKept): Promise<SlotKept> => {
        log.info(`Kept slot ${userText(name)} of ${userText(this.deps.project)}: ${kept.why}`)
        await this.store.fenced(name, token, (db) => this.store.setIn(db, name, from, {}, { op: null })).catch((e) => {
          if (!(e instanceof OpLost)) throw e
        })
        return kept
      }
      try {
        let kept = await this.guard(slot)
        if (kept) return await keep(kept)
        if (existsSync(slot.folder)) {
          const opts = await this.deps.options()
          if (opts.archive.trim()) {
            const end = await this.run(name, token, { slot: name, what: 'archive', command: opts.archive.trim(), folder: slot.folder, env: slotEnv(slot) })
            if (!end.settled) return await keep({ why: 'archiveFailed', error: 'processes it started could not be ended', log: end.logPath })
            if (!end.ok) return await keep({ why: 'archiveFailed', error: end.error ?? (end.timedOut ? 'ran out of time' : end.spawnError ? "couldn't start" : `exited with code ${end.exitCode}`), log: end.logPath })
          }
          // The archive command may have left files or processes: the guards again.
          kept = await this.guard(slot)
          if (kept) return await keep(kept)
          // Still ours, nothing leased meanwhile, right before the one step that can't be undone.
          if (!(await this.store.fenced(name, token, (db, now) => !openLeaseIn(db, this.store.project, name) && !now.job))) return await keep({ why: 'busy', state: from })
          const r = await git(this.deps.project, ['worktree', 'remove', slot.folder])
          if (!r.ok) return await keep({ why: 'gitRefused', detail: r.err.trim().split(/\r?\n/)[0] || 'git worktree remove failed' })
        } else await git(this.deps.project, ['worktree', 'prune'])
        await this.store.fenced(name, token, (db) => db.prepare('DELETE FROM slots WHERE project = ? AND name = ?').run(this.store.project, name))
        log.info(`Removed slot ${userText(name)} (${userText(slot.folder)})`)
        return null
      } catch (e) {
        if (e instanceof OpLost) return { why: 'busy', state: this.store.slot(name)?.state ?? from }
        return keep({ why: 'cantCheck', detail: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  /**
   * What would keep a slot if it were removed now (#1450, Unused Worktrees' rows): its lease, an operation, then the
   * removal's guards, without the rename probe (a listing doesn't touch the folder; the removal probes it). Null: it
   * would go.
   */
  async check(name: string): Promise<SlotKept | null> {
    const s = this.store.slot(name)
    if (!s) return null
    const open = this.store.openLease(name)
    if (open) return { why: 'leased', agent: open.agent }
    if (s.op || s.job || s.writer) return { why: 'busy', state: s.state }
    return this.guard(s, false)
  }

  /** The guards a removal checks, in order; null when nothing holds the slot. `probe`: also prove no process holds it. */
  private async guard(s: Slot, probe = true): Promise<SlotKept | null> {
    const session = this.deps.sessionIn?.(s.folder)
    if (session) return { why: 'session', detail: session }
    for (const card of this.store.cardsOf(s.name)) if (await this.deps.inFlight?.(card)) return { why: 'inFlight', card }
    if (!existsSync(s.folder)) return null
    if (probe && !(await quiet(s.folder))) return { why: 'process' }
    const d = await G.dirty(s.folder)
    if (isUnknown(d)) return { why: 'cantCheck', detail: d.what }
    if (d.length) return { why: 'dirty', files: d.length }
    const head = await G.head(s.folder)
    if (isUnknown(head)) return { why: 'cantCheck', detail: head.what }
    const target = s.target ?? (await this.defaultTarget())
    if (!target) return { why: 'cantCheck', detail: 'no target branch' }
    const t = await G.lineHead(this.deps.project, target)
    if (isUnknown(t) || !t) return { why: 'cantCheck', detail: `no ${target}` }
    if (t === head) return null
    const base = await G.mergeBase(this.deps.project, t, head)
    if (isUnknown(base) || !base) return { why: 'cantCheck', detail: `no merge base with ${target}` }
    const c = await G.contains(this.deps.project, target, { base, revision: head }, t)
    if (isUnknown(c)) return { why: 'cantCheck', detail: c.what }
    return c ? null : { why: 'unmerged', target }
  }

  /**
   * Removes the pool's idle slots: ready ones beyond its size, unused for IDLE_MS, oldest first (Settings → Advanced,
   * Remove idle slots after a day), and slots whose setup failed; `at` the time it counts from (tests). The slots removed.
   */
  async tidy(at: number = this.now()): Promise<string[]> {
    if (this.deps.removeIdle && !this.deps.removeIdle()) return []
    await this.refresh()
    const size = await this.size()
    const all = this.store.slots()
    const removed: string[] = []
    const free = (s: Slot): boolean => !s.op && !s.job && !this.store.openLease(s.name)
    for (const s of all.filter((x) => x.state === 'creating' && x.warmError && free(x))) if (!(await this.remove(s.name))) removed.push(s.name)
    let over = all.length - removed.length - size
    const idle = all.filter((s) => s.state === 'ready' && free(s) && at - Date.parse(s.usedAt) >= IDLE_MS).sort((a, b) => a.usedAt.localeCompare(b.usedAt))
    for (const s of idle) {
      if (over <= 0) break
      if (!(await this.remove(s.name))) {
        removed.push(s.name)
        over--
      }
    }
    return removed
  }
}

/**
 * Whether no process holds a folder (its working folder, or a file open in it): Windows refuses to rename a folder then.
 * Renamed aside and back at once; a folder that can't be put back is retried, and left aside (and logged) only if that
 * keeps failing, which nothing holding it can cause (it couldn't have been renamed).
 */
export async function quiet(folder: string): Promise<boolean> {
  const aside = `${folder}.hive-quiet-${randomBytes(3).toString('hex')}`
  try {
    await rename(folder, aside)
  } catch {
    return false
  }
  for (let i = 0; ; i++) {
    try {
      await rename(aside, folder)
      return true
    } catch (e) {
      if (i >= 20) {
        log.error(`Could not put slot folder ${userText(folder)} back from ${userText(aside)}`, e)
        return false
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
}
