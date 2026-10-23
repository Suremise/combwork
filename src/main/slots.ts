// A project's slot pool (#1429, SPEC §16.10.1–16.10.2): the worktrees Hive lends to a card or a lane (a dispatch lease)
// and gets back when it ends, kept ready between loans. Slots and leases are typed rows of hive.db (schema/v1_0.ts,
// SLOTS_STEP): at most one open lease per slot, and one open dispatch lease and one carried lease per agent, by partial
// unique indexes, so two Hives (or processes) lending at once can't both get one slot, however their code races; the
// second is refused ("slot-b is in use by HI-B1 for AM-12").
//
// - Lending takes a ready slot in one write (preferring the one the builder last had, then the most recently used), or
//   reserves a new one (`slot-a`, `slot-b`…: skipping names in use, folders on disk such as the merge queue's and
//   `copies`) while the pool is under its size: as many slots as the project has builders, at most the agent cap. A
//   new slot is a detached worktree at the target's head, with the project's copied files (`slots.copy`), set up by its
//   setup command (`slots.setup`) as one of Hive's runs, "Hive (slot slot-b)", never in an agent's terminal; an existing
//   one is installed again when its lock files changed since its last install. A failed setup leaves the slot not
//   ready, with the run's log: lending skips it. A slot gone from disk is recreated when it is next lent, or marked
//   `gone` while leased.
// - A carried lease (#1441: an agent's migrated worktree) protects its slot: never lent to anyone else, nor cleaned up,
//   while it is open, even while its agent holds a dispatch lease elsewhere.
// - Releasing ends the lease; a slot left with uncommitted or untracked files that aren't ignored is `dirty` and isn't
//   lent until it is clean.
// - Clean-up (`remove`, the one way a slot goes) is guarded: never with a session or a process in it (a rename of its
//   folder proves no process holds it), an open lease, a queue entry in flight for a card it held, uncommitted or
//   untracked files, or a head the target doesn't contain (§16.3.2, squash merges included). The archive command runs
//   first, as a run; a failure keeps the slot. The pool's idle slots beyond its size, unused for a day, go so
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

export type SlotState = 'creating' | 'ready' | 'lent' | 'dirty' | 'gone' | 'removing'
export type LeaseKind = 'card' | 'lane' | 'carried'

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
}

/** Why a lend was refused (#1438 turns `noSlot` into "waiting for a slot"). */
export type SlotRefusal =
  | { why: 'noSlot'; size: number }
  | { why: 'inUse'; slot: string; agent: string; card: number | null; lane: string | null }
  | { why: 'agentLeased'; slot: string; card: number | null; lane: string | null }
  | { why: 'notReady'; slot: string; state: SlotState; error: string | null }
  | { why: 'setupFailed'; slot: string; error: string; log: string | null }

export type LendResult = { ok: true; lease: SlotLease; slot: Slot } | { ok: false; refusal: SlotRefusal }

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
  const what = (c: number | null, l: string | null): string => (c !== null ? card(c) : `lane ${l}`) // i18n-ignore: agent-facing
  switch (r.why) {
    case 'noSlot':
      return `no slot free: the pool's ${r.size} ${r.size === 1 ? 'slot is' : 'slots are'} in use` // i18n-ignore: agent-facing
    case 'inUse':
      return `${r.slot} is in use by ${name(r.agent)} for ${what(r.card, r.lane)}` // i18n-ignore: agent-facing
    case 'agentLeased':
      return `this agent already builds in ${r.slot} for ${what(r.card, r.lane)}` // i18n-ignore: agent-facing
    case 'notReady':
      return `${r.slot} isn't ready (${r.error ?? r.state})` // i18n-ignore: agent-facing
    case 'setupFailed':
      return `${r.slot}'s setup failed: ${r.error}` // i18n-ignore: agent-facing
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
  usedAt: r.used_at as string
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
  why: (r.why as string | null) ?? null
})

/** Which unique index a failed insert hit: a slot's open lease, or an agent's. */
function constraintOf(e: unknown): 'slot' | 'agent' | 'name' | null {
  const m = e instanceof Error ? e.message : ''
  if (!/UNIQUE constraint failed/i.test(m)) return null
  if (/slot_leases\.slot/.test(m)) return 'slot'
  if (/slot_leases\.agent/.test(m)) return 'agent'
  if (/slots\./.test(m)) return 'name'
  return null
}

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
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, name) as Row | undefined
      return r ? slotOfRow(r) : null
    })
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

  /** An agent's open leases: its dispatch lease and its carried lease, each at most one. */
  leasesOf(agent: string): SlotLease[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL').all(this.project, agent) as Row[]).map(leaseOfRow))
  }

  /** The cards a slot was ever leased for, newest first (a queue entry in flight for one keeps it). */
  cardsOf(slot: string): number[] {
    return this.conn.read((db) => (db.prepare('SELECT card FROM slot_leases WHERE project = ? AND slot = ? AND card IS NOT NULL ORDER BY from_at DESC').all(this.project, slot) as { card: number }[]).map((r) => r.card))
  }

  /** The agent a slot was last leased to, if any. */
  lastAgentOf(slot: string): string | null {
    return this.conn.read((db) => (db.prepare('SELECT agent FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, slot) as { agent: string } | undefined)?.agent ?? null)
  }

  /**
   * Takes a slot for a lease in one write: the one named (refused when it is lent or not ready), else a ready slot with
   * no open lease (the builder's last, then the most recently used), else a new one reserved (`creating`, its name and
   * ports taken) while the project has fewer than `size`. The lease's row is written in the same write, so the indexes
   * refuse a second open lease on the slot or for the agent.
   */
  async take(req: LeaseRequest, o: { size: number; root: string; target: string | null }): Promise<{ ok: true; lease: SlotLease; slot: Slot; fresh: boolean; again?: boolean } | { ok: false; refusal: SlotRefusal }> {
    try {
      return await this.conn.write((db) => {
        const at = this.iso()
        const mine = this.dispatchOf(db, req.agent)
        if (mine) {
          // The same card or lane asking again (a restart, a retry): the lease it has.
          if ((req.card !== undefined && mine.card === req.card) || (req.lane !== undefined && mine.lane === req.lane)) return { ok: true as const, lease: mine, slot: slotOfRow(db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, mine.slot) as Row), fresh: false, again: true }
          return { ok: false as const, refusal: { why: 'agentLeased' as const, slot: mine.slot, card: mine.card, lane: mine.lane } }
        }
        const held = req.card !== undefined ? (db.prepare('SELECT * FROM slot_leases WHERE card = ? AND ended_at IS NULL').get(req.card) as Row | undefined) : (db.prepare('SELECT * FROM slot_leases WHERE lane = ? AND ended_at IS NULL').get(req.lane!) as Row | undefined)
        if (held) return { ok: false as const, refusal: { why: 'inUse' as const, slot: held.slot as string, agent: held.agent as string, card: (held.card as number | null) ?? null, lane: (held.lane as string | null) ?? null } }
        const all = (db.prepare('SELECT * FROM slots WHERE project = ? ORDER BY name').all(this.project) as Row[]).map(slotOfRow)
        let slot: Slot | undefined
        let fresh = false
        if (req.slot) {
          slot = all.find((s) => s.name.toLowerCase() === req.slot!.toLowerCase())
          const open = slot ? openLeaseIn(db, this.project, slot.name) : null
          if (open) return { ok: false as const, refusal: { why: 'inUse' as const, slot: open.slot, agent: open.agent, card: open.card, lane: open.lane } }
          if (slot && (slot.state !== 'ready' || slot.warmError)) return { ok: false as const, refusal: { why: 'notReady' as const, slot: slot.name, state: slot.state, error: slot.warmError } }
        } else {
          const free = all.filter((s) => s.state === 'ready' && !s.warmError && !openLeaseIn(db, this.project, s.name))
          const last = (s: Slot): string | null => (db.prepare('SELECT agent FROM slot_leases WHERE project = ? AND slot = ? ORDER BY from_at DESC LIMIT 1').get(this.project, s.name) as { agent: string } | undefined)?.agent ?? null
          slot = free.find((s) => last(s) === req.agent) ?? free.sort((a, b) => b.usedAt.localeCompare(a.usedAt))[0]
        }
        if (!slot) {
          if (all.length >= o.size) return { ok: false as const, refusal: { why: 'noSlot' as const, size: o.size } }
          const name = req.slot ?? nextSlotName(new Set(all.map((s) => s.name.toLowerCase())), o.root)
          const ports = new Set(all.map((s) => s.portBase))
          let portBase = PORT_FLOOR
          while (ports.has(portBase)) portBase += SLOT_PORTS
          db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, ?, ?, 'creating', ?, ?, ?, ?)").run(this.project, name, join(o.root, name), portBase, o.target, at, at)
          slot = slotOfRow(db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, name) as Row)
          fresh = true
        }
        const lease = this.insertLease(db, slot.name, req.card !== undefined ? 'card' : 'lane', req, at)
        if (!fresh) db.prepare("UPDATE slots SET state = 'lent', used_at = ? WHERE project = ? AND name = ?").run(at, this.project, slot.name)
        return { ok: true as const, lease, slot: { ...slot, state: fresh ? slot.state : 'lent', usedAt: at }, fresh }
      })
    } catch (e) {
      // Another Hive's write between our read and our insert can't happen inside one write; the indexes are the last
      // word anyway (another process on the same file): refused, not thrown.
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

  private insertLease(db: DatabaseSync, slot: string, kind: LeaseKind, req: { agent: string; card?: number; lane?: string }, at: string): SlotLease {
    const id = `l-${randomBytes(6).toString('hex')}`
    db.prepare('INSERT INTO slot_leases (id, project, slot, kind, card, lane, agent, from_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, this.project, slot, kind, kind === 'card' ? req.card! : null, kind === 'lane' ? req.lane! : null, req.agent, at)
    return { id, project: this.project, slot, kind, card: kind === 'card' ? req.card! : null, lane: kind === 'lane' ? req.lane! : null, agent: req.agent, from: at, to: null, why: null }
  }

  /**
   * A carried lease (#1441): an agent's own worktree adopted in place as a slot under its folder's name, protected while
   * the lease is open. The slot's row is made if it has none. Refused (null) when the slot or the agent has an open lease.
   */
  async carry(agent: string, slot: { name: string; folder: string; target: string | null }): Promise<SlotLease | null> {
    try {
      return await this.conn.write((db) => {
        const at = this.iso()
        const has = db.prepare('SELECT 1 FROM slots WHERE project = ? AND name = ?').get(this.project, slot.name)
        if (!has) {
          const ports = new Set((db.prepare('SELECT port_base FROM slots WHERE project = ?').all(this.project) as { port_base: number }[]).map((r) => r.port_base))
          let portBase = PORT_FLOOR
          while (ports.has(portBase)) portBase += SLOT_PORTS
          db.prepare("INSERT INTO slots (project, name, folder, state, port_base, target, created_at, used_at) VALUES (?, ?, ?, 'lent', ?, ?, ?, ?)").run(this.project, slot.name, slot.folder, portBase, slot.target, at, at)
        } else db.prepare("UPDATE slots SET state = 'lent', used_at = ? WHERE project = ? AND name = ?").run(at, this.project, slot.name)
        return this.insertLease(db, slot.name, 'carried', { agent }, at)
      })
    } catch (e) {
      if (constraintOf(e)) return null
      throw e
    }
  }

  /** Ends an open lease: whether it was open. The slot stays `lent` until the caller has looked at it (settle). */
  async end(lease: string, why: string): Promise<SlotLease | null> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT * FROM slot_leases WHERE id = ? AND project = ? AND ended_at IS NULL').get(lease, this.project) as Row | undefined
      if (!r) return null
      const at = this.iso()
      db.prepare('UPDATE slot_leases SET ended_at = ?, why = ? WHERE id = ?').run(at, why, lease)
      db.prepare('UPDATE slots SET used_at = ? WHERE project = ? AND name = ?').run(at, this.project, r.slot)
      return { ...leaseOfRow(r), to: at, why }
    })
  }

  /**
   * Sets a slot's state, only from the states given (and, with `unleased`, only while it has no open lease): whether it
   * changed. The other fields given change with it.
   */
  async setState(name: string, to: SlotState, from: SlotState[], o: { unleased?: boolean; fields?: Partial<Pick<Slot, 'installRev' | 'installHash' | 'warmError' | 'warmLog' | 'target'>> } = {}): Promise<boolean> {
    return this.conn.write((db) => {
      const r = db.prepare('SELECT * FROM slots WHERE project = ? AND name = ?').get(this.project, name) as Row | undefined
      if (!r || !from.includes(r.state as SlotState)) return false
      if (o.unleased && openLeaseIn(db, this.project, name)) return false
      const f = o.fields ?? {}
      const col = { installRev: 'install_rev', installHash: 'install_hash', warmError: 'warm_error', warmLog: 'warm_log', target: 'target' } as const
      const sets = Object.entries(f).map(([k]) => `${col[k as keyof typeof col]} = ?`)
      db.prepare(`UPDATE slots SET state = ?${sets.map((s) => `, ${s}`).join('')} WHERE project = ? AND name = ?`).run(to, ...Object.values(f).map((v) => v ?? null), this.project, name)
      return true
    })
  }

  /** Forgets a removed slot (its leases with it). */
  async drop(name: string): Promise<void> {
    await this.conn.write((db) => db.prepare("DELETE FROM slots WHERE project = ? AND name = ? AND state = 'removing'").run(this.project, name))
  }
}

function openLeaseIn(db: DatabaseSync, project: string, slot: string): SlotLease | null {
  const r = db.prepare('SELECT * FROM slot_leases WHERE project = ? AND slot = ? AND ended_at IS NULL').get(project, slot) as Row | undefined
  return r ? leaseOfRow(r) : null
}

// --- The pool.

/** What a lend asks for: a card or a lane (one of them), its builder, and optionally the slot it wants. */
export interface LeaseRequest {
  card?: number
  lane?: string
  agent: string
  slot?: string
}

/** One of Hive's runs for a slot: its setup, an install, its archive command. */
export interface SlotRun {
  slot: string
  /** `setup`, `install` or `archive`. */
  what: 'setup' | 'install' | 'archive'
  command: string
  folder: string
  env: Record<string, string>
}

export interface SlotRunEnd {
  ok: boolean
  exitCode: number | null
  timedOut?: boolean
  spawnError?: boolean
  logPath: string | null
}

/** Runs a slot's command as one of Hive's runs ("Hive (slot slot-b)"), to its end. */
export type SlotRunner = (r: SlotRun) => Promise<SlotRunEnd>

/** A project's slot options as they apply now: project.json's `slots`, else today's worktree settings. */
export interface SlotOptionsNow {
  setup: string
  archive: string
  copy: string
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
  /** A session running in a folder: what it is (for the log), or null. */
  sessionIn?: (folder: string) => string | null
  /** Whether a card has a merge queue entry in flight. */
  inFlight?: (card: number) => boolean | Promise<boolean>
  /** Settings → Advanced, Remove idle slots after a day. */
  removeIdle?: () => boolean
  now?: () => number
}

/** The builder count a pool sizes by, per project folder: the project's agents unless given (#1438 wires the roles). */
let builderCount: ((projectPath: string) => number | Promise<number>) | null = null
export function setBuilderCount(fn: ((projectPath: string) => number | Promise<number>) | null): void {
  builderCount = fn
}
export const builderCountOf = (projectPath: string, fallback: () => number | Promise<number>): number | Promise<number> => (builderCount ? builderCount(projectPath) : fallback())

export class SlotPool {
  private readonly store: SlotStore
  /** Slots this pool is warming or removing now, so two calls in one Hive don't both. */
  private readonly busy = new Set<string>()

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

  leasesOf(agent: string): SlotLease[] {
    return this.store.leasesOf(agent)
  }

  openLease(slot: string): SlotLease | null {
    return this.store.openLease(slot)
  }

  /**
   * Lends a slot to a card or a lane for its builder: a ready one, else a new one while the pool is under its size,
   * warmed before it is given. Refused, with why, when none is free, the slot asked for is in use, the agent already
   * builds in another, or a new slot's setup failed (its lease then ended `setupFailed`).
   */
  async lend(req: LeaseRequest, o: { target?: string } = {}): Promise<LendResult> {
    if ((req.card === undefined) === (req.lane === undefined)) throw new Error('a lease is for a card or a lane') // i18n-ignore: a mistake in Hive's code
    await this.refresh()
    const target = o.target ?? (await this.defaultTarget())
    const taken = await this.store.take(req, { size: await this.size(), root: this.deps.root, target })
    if (!taken.ok) return taken
    if (taken.again) return { ok: true, lease: taken.lease, slot: taken.slot }
    const problem = await this.warm(taken.slot, taken.fresh ? 'create' : 'lend', target)
    if (problem) {
      await this.store.end(taken.lease.id, 'setupFailed')
      const s = this.store.slot(taken.slot.name)
      return { ok: false, refusal: { why: 'setupFailed', slot: taken.slot.name, error: problem, log: s?.warmLog ?? null } }
    }
    return { ok: true, lease: taken.lease, slot: this.store.slot(taken.slot.name)! }
  }

  /** A carried lease for an agent's adopted worktree (#1441); null when its slot or the agent has an open lease. */
  carry(agent: string, slot: { name: string; folder: string; target?: string | null }): Promise<SlotLease | null> {
    return this.store.carry(agent, { ...slot, target: slot.target ?? null })
  }

  /**
   * Ends a lease and looks at its slot: `dirty` when it has uncommitted or untracked files that aren't ignored, `gone`
   * when its folder is, else `ready`. Whether the lease was open.
   */
  async release(lease: string, why: string): Promise<boolean> {
    const ended = await this.store.end(lease, why)
    if (!ended) return false
    await this.settle(ended.slot)
    return true
  }

  /** A slot with no open lease, looked at: ready, dirty or gone. Leased or busy here, it is left as it is. */
  private async settle(name: string): Promise<void> {
    const s = this.store.slot(name)
    if (!s || this.busy.has(name) || this.store.openLease(name)) return
    if (s.state === 'creating' || s.state === 'removing') return
    const to = await this.look(s)
    if (to !== s.state) await this.store.setState(name, to, [s.state], { unleased: true })
  }

  /** What a slot with no lease is now: gone (no folder, or git doesn't list it), dirty, or ready. */
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

  /**
   * Brings the rows in step with the disk: an unleased slot left `lent` (a Hive that stopped between ending a lease and
   * looking at its slot) or `dirty` is looked at again; a leased slot whose folder is gone is marked `gone` (#1434
   * refuses its sessions); a ready one gone is recreated when it's next lent.
   */
  async refresh(): Promise<void> {
    for (const s of this.store.slots()) {
      if (this.busy.has(s.name)) continue
      const open = this.store.openLease(s.name)
      if (open) {
        if (s.state === 'lent' && !(await this.present(s))) await this.store.setState(s.name, 'gone', ['lent'])
        continue
      }
      if (s.state === 'lent' || s.state === 'dirty' || s.state === 'gone') await this.settle(s.name)
    }
  }

  private async defaultTarget(): Promise<string | null> {
    const t = await G.defaultBranch(this.deps.project)
    return isUnknown(t) ? null : t
  }

  /**
   * Makes or readies a slot for a lease it holds: `create` makes its worktree (detached at the target's head), copies
   * the project's files into it and runs its setup; `lend` recreates it if it is gone and installs again when its lock
   * files changed since its last install. Null when it is ready (its state `lent`), else why not (the slot is left
   * `creating` with the error and the run's log: lending skips it).
   */
  private async warm(slot: Slot, how: 'create' | 'lend', target: string | null): Promise<string | null> {
    this.busy.add(slot.name)
    try {
      const fail = async (error: string, logPath: string | null = null): Promise<string> => {
        log.warn(`Slot ${userText(slot.name)} of ${userText(this.deps.project)} isn't ready: ${userText(error)}`)
        await this.store.setState(slot.name, 'creating', ['creating', 'lent', 'gone', 'ready'], { fields: { warmError: error, warmLog: logPath } })
        return error
      }
      let made = how === 'create'
      if (!made && !(await this.present(slot))) {
        // Gone from disk while free: made again where it was (recreateWorktree's way: git's stale entry pruned first).
        if (existsSync(slot.folder)) return fail('its folder is there but git does not list it as a worktree') // i18n-ignore: agent-facing and the log
        await git(this.deps.project, ['worktree', 'prune'])
        made = true
      }
      const opts = await this.deps.options()
      if (made) {
        const at = target ? await G.lineHead(this.deps.project, target) : await G.head(this.deps.project)
        if (isUnknown(at) || !at) return fail(`git couldn't read ${target ?? 'HEAD'}`) // i18n-ignore: agent-facing and the log
        const r = await git(this.deps.project, ['worktree', 'add', '--detach', slot.folder, at])
        if (!r.ok) return fail(`git worktree add: ${r.err.trim().split(/\r?\n/)[0] || 'failed'}`) // i18n-ignore: agent-facing and the log
        log.info(`Made slot ${userText(slot.name)} at ${at.slice(0, 7)} in ${userText(slot.folder)}`)
        if (opts.copy.trim()) await copyIgnored(this.deps.project, slot.folder, opts.copy).catch((e) => log.warn(`Could not copy files into slot ${userText(slot.name)}`, e))
      }
      const hash = await lockHash(slot.folder)
      const fresh = this.store.slot(slot.name)
      const needed = made || fresh?.warmError !== null || (hash !== (fresh?.installHash ?? null) && hash !== null)
      if (needed) {
        const command = opts.setup.trim() || (hash !== null && existsSync(join(slot.folder, 'package-lock.json')) ? 'npm ci' : '') // i18n-ignore: a command
        if (command) {
          const end = await this.deps.runner({ slot: slot.name, what: made ? 'setup' : 'install', command, folder: slot.folder, env: slotEnv(slot) })
          if (!end.ok) return fail(end.timedOut ? 'its setup ran out of time' : end.spawnError ? `its setup couldn't start: ${command}` : `its setup exited with code ${end.exitCode}`, end.logPath) // i18n-ignore: agent-facing and the log
        }
      }
      const rev = await G.head(slot.folder)
      await this.store.setState(slot.name, 'lent', ['creating', 'lent', 'gone', 'ready'], { fields: { warmError: null, warmLog: null, ...(needed ? { installRev: isUnknown(rev) ? null : rev, installHash: hash } : {}), ...(made && target ? { target } : {}) } })
      return null
    } finally {
      this.busy.delete(slot.name)
    }
  }

  /**
   * Removes a slot, guarded (§16.6.4: no switch): kept, with why, while it has an open lease (carried included), a
   * session or a process in it, a queue entry in flight for a card it held, uncommitted or untracked files that aren't
   * ignored, or a head its target doesn't contain; and when its archive command fails. Null once removed.
   */
  async remove(name: string): Promise<SlotKept | null> {
    const s = this.store.slot(name)
    if (!s) return null
    const open = this.store.openLease(name)
    if (open) return { why: 'leased', agent: open.agent }
    if (this.busy.has(name)) return { why: 'busy', state: s.state }
    // Taken out of the pool first, in a write that sees no open lease: lending can't take it meanwhile.
    if (!(await this.store.setState(name, 'removing', ['ready', 'dirty', 'gone', 'creating'], { unleased: true }))) {
      const now = this.store.openLease(name)
      return now ? { why: 'leased', agent: now.agent } : { why: 'busy', state: this.store.slot(name)?.state ?? s.state }
    }
    this.busy.add(name)
    let kept: SlotKept | null = null
    try {
      kept = await this.guard(s)
      if (!kept && existsSync(s.folder)) {
        const opts = await this.deps.options()
        if (opts.archive.trim()) {
          const end = await this.deps.runner({ slot: name, what: 'archive', command: opts.archive.trim(), folder: s.folder, env: slotEnv(s) })
          if (!end.ok) kept = { why: 'archiveFailed', error: end.timedOut ? 'ran out of time' : end.spawnError ? "couldn't start" : `exited with code ${end.exitCode}`, log: end.logPath } // i18n-ignore: agent-facing and the log
        }
        // The archive command may have left files: the guards again, then git's own removal (never forced).
        if (!kept) kept = await this.guard(s)
        if (!kept) {
          const r = await git(this.deps.project, ['worktree', 'remove', s.folder])
          if (!r.ok) kept = { why: 'gitRefused', detail: r.err.trim().split(/\r?\n/)[0] || 'git worktree remove failed' } // i18n-ignore: agent-facing and the log
        }
      } else if (!kept) await git(this.deps.project, ['worktree', 'prune'])
      if (kept) {
        log.info(`Kept slot ${userText(name)} of ${userText(this.deps.project)}: ${kept.why}`)
        await this.store.setState(name, s.state, ['removing'])
        return kept
      }
      await this.store.drop(name)
      log.info(`Removed slot ${userText(name)} (${userText(s.folder)})`)
      return null
    } finally {
      this.busy.delete(name)
    }
  }

  /** The guards a removal checks, in order; null when nothing holds the slot. */
  private async guard(s: Slot): Promise<SlotKept | null> {
    const session = this.deps.sessionIn?.(s.folder)
    if (session) return { why: 'session', detail: session }
    for (const card of this.store.cardsOf(s.name)) if (await this.deps.inFlight?.(card)) return { why: 'inFlight', card }
    if (!existsSync(s.folder)) return null
    if (!(await quiet(s.folder))) return { why: 'process' }
    const d = await G.dirty(s.folder)
    if (isUnknown(d)) return { why: 'cantCheck', detail: d.what }
    if (d.length) return { why: 'dirty', files: d.length }
    const head = await G.head(s.folder)
    if (isUnknown(head)) return { why: 'cantCheck', detail: head.what }
    const target = s.target ?? (await this.defaultTarget())
    if (!target) return { why: 'cantCheck', detail: 'no target branch' } // i18n-ignore: agent-facing and the log
    const t = await G.lineHead(this.deps.project, target)
    if (isUnknown(t) || !t) return { why: 'cantCheck', detail: `no ${target}` } // i18n-ignore: agent-facing and the log
    if (t === head) return null
    const base = await G.mergeBase(this.deps.project, t, head)
    if (isUnknown(base) || !base) return { why: 'cantCheck', detail: `no merge base with ${target}` } // i18n-ignore: agent-facing and the log
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
    const failed = all.filter((s) => s.state === 'creating' && s.warmError && !this.busy.has(s.name) && !this.store.openLease(s.name))
    for (const s of failed) if (!(await this.remove(s.name))) removed.push(s.name)
    let over = all.length - removed.length - size
    const idle = all.filter((s) => s.state === 'ready' && !this.store.openLease(s.name) && at - Date.parse(s.usedAt) >= IDLE_MS).sort((a, b) => a.usedAt.localeCompare(b.usedAt))
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
