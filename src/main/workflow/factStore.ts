// The fact log's store (SPEC §16.4.1, §16.4.5): facts, the card's stage cache and the durable actions they cause, written
// in one transaction, so a fact and the move it caused can't diverge and nothing outside happens for a write that
// rolled back. Observed facts carry a dedupe key, unique per card and kind, so two Combworks observing one workspace write
// each transition once (§16.17).
//
// In the workspace's combwork.db since #1215 (Darren, #1118: "the fact store replaced by combwork.db tables written inside
// boardWrite"): the 1.0 group's facts step makes its tables (schema/v1_0.ts), and a card is the board's own row. A store
// is one project's: its cards, its lanes, its queue's pauses and its values. It reaches the database one of two ways
// (HR4's #1215 round 1): on the board's (`forBoard`), its writes are part of the caller's boardWrite only, through the
// board's own guarded write path, and its reads are the board's, on one snapshot; on a connection of its own (`open`:
// another Combwork, a restart, the runtime's tests), its writes are its own transactions and its reads one snapshot each.

import { AsyncLocalStorage } from 'async_hooks'
import type { DatabaseSync } from 'node:sqlite'
import { openDb, type Db } from '../db'
import { BOARD_MIGRATIONS, boardChanged, boardRead, boardReadToken, boardWriteOp, takeNumberIn } from '../boardStore'
import { decomposeCard, writeCardRows } from '../schema/cardRows'
import { cardKeys, cardOfKey, currentKeys, keysHeld } from '../schema/keysStep'
import { KEY_FORM, normalKey } from '../../shared/projectKeys'
import type { WorkspaceService } from '../workspace'
import type { Actor, CardKind, Category, Fact, FactKind, NewFact, StageId } from '../../shared/workflow/facts'
import { CATEGORY_STAGE, STAGE_CATEGORY } from '../../shared/workflow/facts'
import type { Ruleset } from '../../shared/workflow/compile'
import { loadRuleset } from '../../shared/workflow/compile'
import { newLane, type LaneList } from '../../shared/workflow/laneList'
import { LOOP_ROUNDS, LOOP_WAIT_HOURS } from '../../shared/lanes'
import { shellLine, type QueueCommand, type QueueFileSide, type QueuePauseLogged, type QueueStuck } from '../../shared/workflow/queue'
import { pauseLogged, pauseLogKey, pauseLogOf } from './queueLogs'

/** What the runtime needs of a card: the board's card, with the columns the runtime keeps beside its document. */
export interface CardRecord {
  /** The card's number (`#N`). */
  id: number
  /** `<project key>-<number>` until the keys step (#1219) numbers cards per project. */
  key: string
  title: string
  kind: CardKind
  labels: string[]
  blockedBy: number[]
  /** A per-card target (OP-12). */
  target?: string
  /** None: the card's declared paths (§16.3.3); absent until it declares any. */
  paths?: string[]
  /** The running lane of its project with it in its list or a queued one, whose ruleset it uses (§16.11.1): lanes.ts's (#1291). */
  lane?: string
  /** The reviewer agent to wake: its lane's, else the pool. */
  reviewer?: string
  /** Its lane is reviewed by the project's reviewer pool (#1443, G17): each submission is given to a free pooled reviewer. */
  reviewerPool?: true
  /** Its lane's round limit (§16.11.4: the Card loops rounds the lane started with); none outside a running lane. */
  rounds?: number
  /** A card from before 1.0 (§16.4.1). */
  preWorkflow?: boolean
  stage: StageId
  /** The board's column. */
  category: Category
}

export interface ActionRow {
  id: number
  card: number
  kind: string
  payload: Record<string, unknown>
  state: 'pending' | 'done' | 'failed' | 'cancelled'
  attempts: number
  fact: number | null
}

export interface Delivery {
  action: number
  kind: string
  target: string
  payload: Record<string, unknown>
}

/** A target's merge queue paused (§16.9): why, by which card, the files a conflict named. */
export interface QueuePause {
  reason: string
  card: string
  files?: string[]
  /** A process Combwork couldn't end (a dead runner's, at a takeover: #1360). */
  pid?: number
  /** What git (or a signer) said, for a pause it caused (#1350): its message, in its own words. */
  message?: string
  /** Who paused it (#1353: Pause queue); left out, Combwork (its reason says why). */
  by?: 'user' | 'assistant'
  /** When (ISO), as the store saved it; left out of a pause written, the store's time then. */
  at?: string
  /**
   * An advance into a checked-out target left part way (#1351): its state, its listed files with their sides, and the
   * commands that finish or undo it. Its files are then `files` too, in that order.
   */
  stuck?: QueueStuck
}

type PauseRow = { reason: string; card: string; pid: number | null; message: string | null; paused_by: 'user' | 'assistant' | null; paused_at: string | null; folder: string | null; branch: string | null; ref: string | null; expected: string | null; result: string | null; phase: QueueStuck['phase'] | null }

/** A target's queue runner (#1360, queue_runners): who runs it, the holder process, when taken and last renewed. */
export interface QueueLease {
  target: string
  lease: string
  token: string
  profile: string
  pid: number
  /** The holder process's start (Unix ms): with `pid`, the process itself. */
  started: number
  takenAt: string
  renewedAt: string
}

export type QueueProcKind = 'job' | 'testMerge' | 'install' | 'check'

/** A process a runner owns (queue_runner_procs): its pid, and the clock readings either side of its start. */
export interface QueueProc {
  lease: string
  target: string
  pid: number
  startAfter: number
  startBefore: number
  what: QueueProcKind
}

/** A queue's worktree (queue_worktrees): its target and lease (null: kept for the next runner). */
export interface QueueFolder {
  folder: string
  target: string
  lease: string | null
}

/** A write inside one transaction: facts, the stage cache and actions together. */
export interface Tx {
  append<K extends FactKind>(card: number, fact: NewFact<K>): Fact<K>
  /** An observed fact: null when another writer already recorded the same transition (its dedupe key). */
  appendObserved<K extends FactKind>(card: number, fact: NewFact<K> & { dedupe: string }): Fact<K> | null
  setStage(card: number, stage: StageId): void
  /** A ruleset stored once by its id (a start's, #1216). */
  saveRuleset(r: Ruleset): void
  action(card: number, kind: string, payload: Record<string, unknown>, fact: number | null): number
  /** Whether an action of a kind was written for a fact of the card (an effect applied once, #1263). */
  hasAction(card: number, kind: string, fact: number): boolean
  facts(card: number): Fact[]
  card(id: number): CardRecord
  putCard(card: CardRecord): void
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  /** A commit seen on a shared folder's line, and whose it is: false when it was already recorded. */
  recordFolderCommit(folder: string, sha: string, card: number | null, how: string): boolean
}

/** How a store reaches its database: each read on one snapshot, each write in a transaction it may write in. */
interface Conn {
  read<T>(fn: (db: DatabaseSync) => T): T
  /** `quiet`: a write the window shows nothing of (the queue runner's lease and processes): no `tasks-changed` for it. */
  write<T>(fn: (db: DatabaseSync) => T, quiet?: boolean): T
  close(): void
  /** What is committed now, as a token (boardReadToken): reads may be served from a cache while it is the same. Null: never. */
  token?(): string | null
}

/**
 * The board's database: reads as the board's readers make them (the caller's change's transaction inside one of its
 * own, else the reader, on one snapshot); writes only inside a change of the workspace's board (boardWrite), by the
 * board's guard: a write outside one, from another change's async context, or once SQLite has undone the change, fails.
 */
const boardConn = (ws: WorkspaceService): Conn => ({
  read: (fn) => boardRead(ws, fn),
  token: () => boardReadToken(ws),
  // A fact (observed ones too) changes what the window shows of a card (its work view, #1223): `tasks-changed` once
  // the change commits.
  write: (fn, quiet) => {
    const out = boardWriteOp(ws, fn)
    if (!quiet) boardChanged(ws)
    return out
  },
  close: () => undefined
})

/** SQLite undid a store's own transaction part way (a full disk, an I/O error): nothing of it was saved. */
/**
 * The write fence of the work running here (#1360: a merge queue's, whose runner must still hold its target's lease):
 * checked inside every write a store makes from that work, in the write's own transaction, and throwing to refuse it
 * whole. Its facts, reconciliation's observed ones, values and pauses alike.
 */
const fences = new AsyncLocalStorage<() => void>()

/** Runs `fn` with every store write it makes (in its async context) checked by `check` inside that write. */
export function withWriteFence<T>(check: () => void, fn: () => Promise<T>): Promise<T> {
  return fences.run(check, fn)
}

/**
 * Runs `fn` outside any write fence: work that starts its own course (the actions worker's run, a queue host's run)
 * even when a fenced write set it going (its commit's listeners run in the writer's async context), so a fence never
 * reaches work that isn't the fenced queue's own (#1348).
 */
export function withoutWriteFence<T>(fn: () => T): T {
  return fences.exit(fn)
}

/** A connection whose writes check the fence of the work making them, inside each write. */
const fenced = (c: Conn): Conn => ({
  read: (fn) => c.read(fn),
  ...(c.token ? { token: () => c.token!() } : {}),
  write: (fn, quiet) =>
    c.write((db) => {
      fences.getStore()?.()
      return fn(db)
    }, quiet),
  close: () => c.close()
})

const lostTx = (): Error => new Error("The fact store's write was undone part way: nothing of it was saved") // i18n-ignore: an error from SQLite's side, logged and thrown to the runtime's caller

/**
 * A connection of the store's own (nothing else uses it): a write is a transaction of its own (BEGIN IMMEDIATE: another
 * Combwork's write waits for it), and what the store does inside it (synchronously: nothing else runs meanwhile) is part of
 * it; a read outside one is a read transaction of its own, one snapshot.
 */
class OwnConn implements Conn {
  private depth = 0
  private closed = false

  constructor(
    private readonly db: Db,
    private readonly owned: boolean
  ) {}

  private inOwn<T>(fn: (db: DatabaseSync) => T): T {
    if (!this.db.writer.isTransaction) throw lostTx()
    return fn(this.db.writer)
  }

  read<T>(fn: (db: DatabaseSync) => T): T {
    if (this.depth) return this.inOwn(fn)
    return this.run('BEGIN', fn)
  }

  write<T>(fn: (db: DatabaseSync) => T): T {
    if (this.depth) return this.inOwn(fn)
    return this.run('BEGIN IMMEDIATE', fn)
  }

  private run<T>(begin: string, fn: (db: DatabaseSync) => T): T {
    const w = this.db.writer
    w.exec(begin)
    this.depth++
    try {
      const out = fn(w)
      // Undone part way, whatever `fn` made of the error meanwhile: it fails whole.
      if (!w.isTransaction) throw lostTx()
      w.exec('COMMIT')
      return out
    } catch (e) {
      if (w.isTransaction) w.exec('ROLLBACK')
      throw e
    } finally {
      this.depth--
    }
  }

  close(): void {
    if (!this.owned || this.closed) return
    this.closed = true
    this.db.close()
  }
}

/** The runtime's columns of a card, as the store reads them. */
interface CardCols {
  number: number
  title: string
  col: Category
  stage: StageId | null
  pre_workflow: number
  kind: CardKind
  target: string | null
  paths_declared: number
}
const COLS = 'number, title, col, stage, pre_workflow, kind, target, paths_declared'

/**
 * A project's store: `project` its name on the board (its cards' `project`); `projectId` (#1294) its id now, whose key
 * (#1219) names it and its cards; `key` the name used where the board has none (a card or project without a key yet).
 */
type Scope = { project: string; key: string; projectId?: () => string | null; now?: () => Date }

/** For tests: runs once a read of cards' records has read their rows, before their lists (another connection committing there). */
export const factStoreTestHooks: { afterCards: (() => void) | null } = { afterCards: null }

export class FactStore {
  private now: () => Date

  private readonly conn: Conn

  private constructor(
    conn: Conn,
    readonly scope: Scope
  ) {
    this.conn = fenced(conn)
    this.now = scope.now ?? (() => new Date())
  }

  /**
   * A project's store on a workspace's board: its writes are part of the caller's change of that board (boardWrite) and
   * fail outside one; its reads see that change inside it, else what was committed. `project` is the project's name on
   * the board (its cards' `project`), `key` its key.
   */
  static forBoard(ws: WorkspaceService, scope: Scope): FactStore {
    return new FactStore(boardConn(ws), scope)
  }

  /** A store on a connection of its own to a workspace database's file, opened as the board opens it (another Combwork on it; a restart). */
  static open(file: string, scope: Scope): FactStore {
    return new FactStore(new OwnConn(openDb(file, { migrations: BOARD_MIGRATIONS, appVersion: 'workflow' }), true), scope)
  }

  /** Closes the connection the store opened; once. */
  close(): void {
    this.conn.close()
  }

  private keyOf(n: number): string {
    return `${this.scope.key}-${n}`
  }

  /** The project's key now (`HI`, #1219: a key changed since names it at once), else the scope's. */
  projectKey(): string {
    const id = this.scope.projectId?.()
    return (id && this.conn.read((db) => currentKeys(db).get(id))) || this.scope.key
  }

  // --- Cards.

  /** Cards' records by a condition on `cards` (this module's SQL, its arguments bound), in number order, on one snapshot. */
  private records(where: string, args: (string | number)[]): CardRecord[] {
    return this.conn.read((db) => {
      const rows = db.prepare(`SELECT ${COLS} FROM cards WHERE ${where} ORDER BY number`).all(...args) as unknown as CardCols[]
      if (!rows.length) return []
      factStoreTestHooks.afterCards?.()
      const of = `card IN (SELECT number FROM cards WHERE ${where})`
      const lists = <V>(sql: string): Map<number, V[]> => {
        const m = new Map<number, V[]>()
        for (const r of db.prepare(sql).all(...args) as { card: number; v: V }[]) m.set(r.card, [...(m.get(r.card) ?? []), r.v])
        return m
      }
      const labels = lists<string>(`SELECT card, label AS v FROM card_labels WHERE ${of} ORDER BY card, ord`)
      const blockedBy = lists<number>(`SELECT card, target AS v FROM card_links WHERE ${of} AND kind = 'blockedBy' ORDER BY card, ord`)
      const paths = lists<string>(`SELECT card, path AS v FROM card_paths WHERE ${of} AND kind = 'declared' ORDER BY card, ord`)
      // Its lane (#1291): the newest running lane of this project with it in its list or its queued one, the one whose
      // builder has it first (HI-1821: boardStore's cardOwnersNow, the same order).
      const lanes = new Map<number, { lane: string; reviewer: string | null; rounds: number; pool: number | null }>()
      // A lane reviewed by the pool says so in its `extra` (#1443); one kept whole there (an array) has no pool.
      const inLanes = `SELECT x.card, l.id AS lane, l.reviewer_id AS reviewer, l.rounds, CASE WHEN json_type(l.extra) = 'object' THEN json_extract(l.extra, '$.pool') END AS pool FROM (SELECT lane, card FROM lane_cards UNION ALL SELECT lane, card FROM lane_pending) x
        JOIN lanes l ON l.id = x.lane WHERE x.${of} AND l.state = 'active' AND l.project = ? COLLATE NOCASE ORDER BY (l.builder_id IS (SELECT agent FROM cards WHERE number = x.card)), l.started_at, l.id`
      for (const r of db.prepare(inLanes).all(...args, this.scope.project) as { card: number; lane: string; reviewer: string | null; rounds: number; pool: number | null }[]) lanes.set(r.card, { lane: r.lane, reviewer: r.reviewer, rounds: r.rounds, pool: r.pool })
      // Its key (#1294): its project's key now and its number there (#1219), else the scope's name and its number.
      const keys = cardKeys(db, rows.map((r) => r.number))
      return rows.map((r) => ({
        id: r.number,
        key: keys.get(r.number) ?? this.keyOf(r.number),
        title: r.title,
        kind: r.kind,
        labels: labels.get(r.number) ?? [],
        blockedBy: blockedBy.get(r.number) ?? [],
        ...(r.target !== null ? { target: r.target } : {}),
        ...(r.paths_declared ? { paths: paths.get(r.number) ?? [] } : {}),
        ...(lanes.has(r.number) ? { lane: lanes.get(r.number)!.lane } : {}),
        ...(lanes.get(r.number)?.reviewer ? { reviewer: lanes.get(r.number)!.reviewer! } : {}),
        ...(lanes.has(r.number) ? { rounds: lanes.get(r.number)!.rounds } : {}),
        ...(lanes.get(r.number)?.pool === 1 && !lanes.get(r.number)!.reviewer ? { reviewerPool: true as const } : {}),
        ...(r.pre_workflow ? { preWorkflow: true } : {}),
        stage: r.stage ?? CATEGORY_STAGE[r.col] ?? 'todo',
        category: r.col
      }))
    })
  }

  card(id: number): CardRecord {
    const c = this.records('number = ?', [id])[0]
    if (!c) throw new Error(`no card ${id}`) // i18n-ignore: a programming error, never shown
    return c
  }

  /**
   * A card of this project by its key (`HI-12`, any case; an old key of its project's too, and a card's name in a project
   * it left: #1219's resolver), its old number (`#1061`), or the name keys had before (`<name>-<old number>`, the scope's
   * name, which may hold hyphens: card trailers written before #1294 said it), or null.
   * A prefix any project holds or held as a key is a key, never that name form (HR5's #1294 round 1): a key no card has
   * here, or another project's card, is null, not the card with that number on the board. So where a project's name is
   * one of its keys, a name-form trailer finds only a card from before 1.0 (which kept its number in its project, #1219).
   */
  cardByKey(key: string): CardRecord | null {
    const ofThis = (n: number): CardRecord | null => this.records('number = ? AND project = ?', [n, this.scope.project])[0] ?? null
    const v = key.trim()
    const old = /^#(\d+)$/.exec(v)
    if (old) return ofThis(Number(old[1]))
    const m = /^(.+)-(\d+)$/.exec(v)
    if (!m) return null
    const prefix = m[1]
    const keyed = KEY_FORM.test(prefix) ? this.conn.read((db) => (keysHeld(db).some((k) => k.key === normalKey(prefix)) ? { card: cardOfKey(db, prefix, Number(m[2])) } : null)) : null
    if (keyed) return keyed.card === null ? null : ofThis(keyed.card)
    if (!this.scope.key || prefix.toLowerCase() !== this.scope.key.toLowerCase()) return null
    return ofThis(Number(m[2]))
  }

  /** HI-2709: the cards blocked by a card (their `blockedBy` names it), by number, any project's: the links' own index. */
  dependents(id: number): number[] {
    return this.conn.read((db) => (db.prepare("SELECT card FROM card_links WHERE target = ? AND kind = 'blockedBy' ORDER BY card").all(id) as { card: number }[]).map((r) => r.card))
  }

  /** Whether a card is archived (a gone card counts as archived: its pins may go). */
  isArchived(id: number): boolean {
    return this.conn.read((db) => ((db.prepare('SELECT archived FROM cards WHERE number = ?').get(id) as { archived: number } | undefined)?.archived ?? 1) === 1)
  }

  /** This project's cards (not archived), in number order. */
  cards(): CardRecord[] {
    return this.records('project = ? AND archived = 0', [this.scope.project])
  }

  /**
   * This project's cards (not archived) past Todo and not Done, in number order (#1629): the only ones that can be in
   * flight, read without the rest of the board (a Done card's facts can't make it so: a `Moved` sets its stage too).
   */
  cardsInFlight(): CardRecord[] {
    return this.records("project = ? AND archived = 0 AND coalesce(stage, CASE col WHEN 'todo' THEN 'todo' WHEN 'done' THEN 'done' END, '') NOT IN ('todo', 'done')", [this.scope.project])
  }

  /** This project's cards (not archived) in a stage, by number (#1443: whom each card in Review has reviewing it). */
  cardsAt(stage: StageId): number[] {
    return this.conn.read((db) => (db.prepare('SELECT number FROM cards WHERE project = ? AND archived = 0 AND (stage = ? OR (stage IS NULL AND col = ?)) ORDER BY number').all(this.scope.project, stage, STAGE_CATEGORY[stage]) as { number: number }[]).map((r) => r.number))
  }

  /**
   * Whether an agent holds an open dispatch lease of a project's slots (#1434: a card's or a lane's, not a carried one),
   * as the slots' table has it (`slotProject`: their project id); null when it can't be read. Read in a write, it is that
   * write's (#1443: the reviewer pool's assignment checks it where it records one).
   */
  dispatchLeased(slotProject: string, agent: string): boolean | null {
    try {
      return this.conn.read((db) => !!db.prepare("SELECT 1 FROM slot_leases WHERE project = ? AND agent = ? AND ended_at IS NULL AND kind <> 'carried'").get(slotProject, agent))
    } catch {
      return null
    }
  }

  /** A new card of this project on the board (the runtime's own; the board's are made by tasks.ts), in Todo unless `stage` says. */
  createCard(c: Omit<CardRecord, 'id' | 'key' | 'stage' | 'category' | 'lane' | 'reviewer' | 'reviewerPool' | 'rounds'> & { stage?: StageId }): CardRecord {
    const stage = c.stage ?? 'todo'
    return this.conn.write((db) => {
      const n = takeNumberIn(db)
      const at = this.now().toISOString()
      const doc = { number: n, title: c.title, description: '', project: this.scope.project, agent: null, column: STAGE_CATEGORY[stage], order: n, labels: c.labels, blocked: null, blockedBy: c.blockedBy, links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'Combwork', updatedAt: at }
      writeCardRows(db, decomposeCard(n, doc))
      db.prepare('UPDATE cards SET stage = ?, kind = ?, pre_workflow = ? WHERE number = ?').run(stage, c.kind, c.preWorkflow ? 1 : 0, n)
      setColumns(db, n, c)
      return this.card(n)
    })
  }

  /** Changes what the runtime keeps of a card: its kind, target and declared paths (its lane is its lanes', #1291). */
  updateCard(id: number, patch: Partial<Omit<CardRecord, 'id' | 'key' | 'stage' | 'category' | 'lane' | 'reviewer' | 'reviewerPool' | 'rounds'>>): CardRecord {
    const other = Object.keys(patch).filter((k) => !['kind', 'target', 'paths', 'title', 'labels', 'blockedBy', 'preWorkflow'].includes(k))
    if (other.length) throw new Error(`a card's ${other.join(', ')} isn't the runtime's to change`) // i18n-ignore: a programming error, never shown
    return this.conn.write((db) => {
      if (patch.kind !== undefined) db.prepare('UPDATE cards SET kind = ? WHERE number = ?').run(patch.kind, id)
      if (patch.preWorkflow !== undefined) db.prepare('UPDATE cards SET pre_workflow = ? WHERE number = ?').run(patch.preWorkflow ? 1 : 0, id)
      setColumns(db, id, patch)
      return this.card(id)
    })
  }

  /** None: the paths Combwork saw a card's agents edit (its pre-fill, §16.3.3), in the order seen. */
  prefill(id: number): string[] {
    return this.conn.read((db) => (db.prepare("SELECT path FROM card_paths WHERE card = ? AND kind = 'prefill' ORDER BY ord").all(id) as { path: string }[]).map((r) => r.path))
  }

  /** Adds a path to a card's pre-fill (once). */
  addPrefill(id: number, path: string): void {
    this.conn.write((db) => db.prepare("INSERT OR IGNORE INTO card_paths (card, kind, ord, path) VALUES (?, 'prefill', (SELECT coalesce(max(ord), -1) + 1 FROM card_paths WHERE card = ? AND kind = 'prefill'), ?)").run(id, id, path))
  }

  // --- Facts, rulesets, actions.

  facts(card: number): Fact[] {
    return this.cached(`card:${card}`, () => this.conn.read((db) => (db.prepare('SELECT * FROM card_facts WHERE card = ? ORDER BY seq').all(card) as Record<string, string | number | null>[]).map(factOf)))
  }

  /** This project's facts of a kind (or of any of these), in the order written (the queue's order). */
  factsOfKind(kind: FactKind | readonly FactKind[]): Fact[] {
    const kinds = typeof kind === 'string' ? [kind] : kind
    const sql = `SELECT f.* FROM card_facts f JOIN cards c ON c.number = f.card WHERE f.kind IN (${kinds.map(() => '?').join(', ')}) AND c.project = ? ORDER BY f.rowid`
    return this.cached(`kinds:${kinds.join(',')}`, () => this.conn.read((db) => (db.prepare(sql).all(...kinds, this.scope.project) as Record<string, string | number | null>[]).map(factOf)))
  }

  /**
   * Facts read since the board last committed anything (HI-1909: each agent's PreToolUse folded every current card's
   * facts again, about 2,200 short reads a minute with a dozen agents), by what was read. Cleared as soon as anything is
   * committed (the board's token moves on); never used inside a write, whose reads see its own changes. Each caller gets
   * its own array; the facts in it are shared, and never changed.
   */
  private cache: { token: string; reads: Map<string, Fact[]> } | null = null

  /** What is committed now, as a token (null inside a write, or a store that never caches): a cache of reads is good while it is the same. */
  readToken(): string | null {
    return this.conn.token?.() ?? null
  }

  private cached(key: string, read: () => Fact[]): Fact[] {
    const token = this.readToken()
    if (token === null) return read()
    if (this.cache?.token !== token) this.cache = { token, reads: new Map() }
    let facts = this.cache.reads.get(key)
    if (!facts) this.cache.reads.set(key, (facts = read()))
    return facts.slice()
  }

  ruleset(id: string): Ruleset {
    const row = this.conn.read((db) => db.prepare('SELECT data FROM rulesets WHERE id = ?').get(id) as { data: string } | undefined)
    if (!row) throw new Error(`no ruleset ${id}`) // i18n-ignore: a programming error, never shown
    const r = loadRuleset(JSON.parse(row.data))
    if (!r.ok) throw new Error(`ruleset ${id}: ${r.error} ${r.piece ?? ''}`) // i18n-ignore: a programming error, never shown
    return r.ruleset
  }

  saveRuleset(r: Ruleset): void {
    this.conn.write((db) => db.prepare('INSERT OR IGNORE INTO rulesets (id, data) VALUES (?, ?)').run(r.id, JSON.stringify(r)))
  }

  /** This project's pending actions, in the order written. */
  /** Whether an action of a kind was written for a fact of a card, whatever became of it (an effect applied once, #1263). */
  hasAction(card: number, kind: string, fact: number): boolean {
    return this.conn.read((db) => !!db.prepare('SELECT 1 FROM card_actions WHERE card = ? AND kind = ? AND fact = ? LIMIT 1').get(card, kind, fact))
  }

  pendingActions(): ActionRow[] {
    return this.conn.read((db) => (db.prepare("SELECT a.* FROM card_actions a JOIN cards c ON c.number = a.card WHERE a.state = 'pending' AND c.project = ? ORDER BY a.id").all(this.scope.project) as Record<string, string | number | null>[]).map(actionOf))
  }

  markAction(id: number, state: ActionRow['state']): void {
    this.conn.write((db) => db.prepare('UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ?').run(state, id))
  }

  /**
   * The runtime's own executor (Workflow.runActions, `tests/workflow` only: the app's actions worker makes real
   * deliveries, #1266): records an action's delivery once, as a row of `deliveries` under this store's own host, with
   * the action's id, whose unique index is the record. False when it was already delivered (an action run twice, §16.4.5).
   */
  deliver(d: Delivery): boolean {
    const at = this.now().toISOString()
    return this.conn.write(
      (db) =>
        Number(
          db
            .prepare("INSERT INTO deliveries (host, id, seq, agent_id, kind, sender, body, state, created, expires, action) VALUES (?, ?, ?, ?, ?, '{}', ?, 'received', ?, ?, ?) ON CONFLICT DO NOTHING")
            .run(this.runtimeHost(), `a${d.action}`, d.action, d.target, d.kind, JSON.stringify(d.payload), at, at, d.action).changes
        ) > 0
    )
  }

  /** What the runtime's own executor delivered (deliver), in the actions' order. */
  deliveries(): Delivery[] {
    return this.conn.read((db) => (db.prepare('SELECT action, kind, agent_id, body FROM deliveries WHERE host = ? ORDER BY action').all(this.runtimeHost()) as { action: number; kind: string; agent_id: string; body: string }[]).map((r) => ({ action: r.action, kind: r.kind, target: r.agent_id, payload: JSON.parse(r.body) as Record<string, unknown> })))
  }

  /** The host the runtime's own executor records its deliveries under: never a session host's (a folder or `assistant`). */
  private runtimeHost(): string {
    return `runtime:${this.scope.project.toLowerCase()}`
  }

  // --- Shared folders, lanes, the queue's pauses, values.

  folderCommits(folder: string): { sha: string; card: number | null; how: string }[] {
    return this.conn.read((db) => db.prepare('SELECT sha, card, how FROM folder_commits WHERE folder = ? ORDER BY id').all(folder) as { sha: string; card: number | null; how: string }[])
  }

  recordFolderCommit(folder: string, sha: string, card: number | null, how: string): boolean {
    return this.conn.write((db) => Number(db.prepare('INSERT OR IGNORE INTO folder_commits (folder, sha, card, how) VALUES (?, ?, ?, ?)').run(folder, sha, card, how).changes) > 0)
  }

  /**
   * One of this project's lanes as the runtime reads it (#1291: one record): lanes.ts's row and cards, and what the
   * runtime keeps beside them (`lane_runs`, `lane_pending`); ended once lanes.ts's state isn't active.
   */
  lane(id: string): LaneList | null {
    return this.conn.read((db) => {
      const row = db.prepare('SELECT state FROM lanes WHERE id = ? AND project = ? COLLATE NOCASE').get(id, this.scope.project) as { state: string } | undefined
      if (!row) return null
      const run = db.prepare('SELECT ruleset, current_card, has_pending FROM lane_runs WHERE lane = ?').get(id) as { ruleset: string | null; current_card: number | null; has_pending: number } | undefined
      const list = (table: 'lane_cards' | 'lane_pending'): number[] => (db.prepare(`SELECT card FROM ${table} WHERE lane = ? ORDER BY ord`).all(id) as { card: number }[]).map((r) => r.card)
      return { id, cards: list('lane_cards'), ruleset: run?.ruleset ?? null, pending: run?.has_pending ? list('lane_pending') : null, current: run?.current_card ?? null, ended: row.state !== 'active' }
    })
  }

  /** This project's running lanes, by id, oldest first (#1271: whose builders' lines are looked at between cards). */
  runningLanes(): string[] {
    return this.conn.read((db) => (db.prepare("SELECT id FROM lanes WHERE project = ? COLLATE NOCASE AND state = 'active' ORDER BY ord").all(this.scope.project) as { id: string }[]).map((r) => r.id))
  }

  /** The agent a card is given to on the board (its id), or null: none, or no such card (HI-1821: a lane's card held elsewhere). */
  cardAgent(n: number): string | null {
    return this.conn.read((db) => (db.prepare('SELECT agent FROM cards WHERE number = ?').get(n) as { agent: string | null } | undefined)?.agent ?? null)
  }

  /** A lane's builder agent (lanes.ts's), or null: the one to tell when its queued list applies (#1270). */
  laneBuilder(id: string): string | null {
    return this.conn.read((db) => (db.prepare('SELECT builder_id FROM lanes WHERE id = ? AND project = ? COLLATE NOCASE').get(id, this.scope.project) as { builder_id: string } | undefined)?.builder_id ?? null)
  }

  /**
   * The runtime starts a lane of this project (tests/workflow until #1270 wires the app's): lanes.ts's lane of that id,
   * its cards and reviewer (if given) set, or a new one by Combwork when there is none; with the ruleset in force now.
   */
  startLane(id: string, cards: number[], ruleset: string, reviewer?: string, rounds = LOOP_ROUNDS): LaneList {
    this.conn.write((db) => {
      const at = this.now().toISOString()
      const had = db.prepare('SELECT project FROM lanes WHERE id = ?').get(id) as { project: string } | undefined
      if (had && had.project.toLowerCase() !== this.scope.project.toLowerCase()) throw new Error(`lane ${id} is another project's`) // i18n-ignore: a programming error, never shown
      if (!had) {
        const ord = (db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM lanes').get() as { n: number }).n
        db.prepare(
          "INSERT INTO lanes (id, ord, project, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES (?, ?, ?, 'combwork', 'Combwork', ?, ?, ?, ?, 'active', 'Combwork', ?, ?)"
        ).run(id, ord, this.scope.project, reviewer ?? null, reviewer ?? null, rounds, LOOP_WAIT_HOURS * 60, at, at)
      } else if (reviewer) db.prepare('UPDATE lanes SET reviewer_id = ?, reviewer_name = ?, updated_at = ? WHERE id = ?').run(reviewer, reviewer, at, id)
      writeLane(db, newLane(id, cards, ruleset), at)
    })
    return this.lane(id)!
  }

  /** Saves the runtime's part of one of this project's lanes: its list, its end, the card in flight, a queued change. */
  saveLane(l: LaneList): void {
    this.conn.write((db) => {
      if (!db.prepare('SELECT 1 FROM lanes WHERE id = ? AND project = ? COLLATE NOCASE').get(l.id, this.scope.project)) throw new Error(`no lane ${l.id}`) // i18n-ignore: a programming error, never shown
      writeLane(db, l, this.now().toISOString())
    })
  }

  queuePause(target: string): QueuePause | null {
    const p = this.scope.project
    return this.conn.read((db) => {
      const row = db.prepare('SELECT reason, card, pid, message, paused_by, paused_at, folder, branch, ref, expected, result, phase FROM workflow_queue_pauses WHERE project = ? AND target = ?').get(p, target) as PauseRow | undefined
      if (!row) return null
      const rows = db.prepare('SELECT path, side FROM workflow_queue_pause_files WHERE project = ? AND target = ? ORDER BY ord').all(p, target) as { path: string; side: QueueFileSide | null }[]
      const files = rows.map((r) => r.path)
      let stuck: QueueStuck | undefined
      if (row.folder !== null && row.expected !== null && row.result !== null && row.phase !== null) {
        const commands = db.prepare('SELECT ord, purpose, place FROM workflow_queue_pause_commands WHERE project = ? AND target = ? ORDER BY ord').all(p, target) as { ord: number; purpose: QueueCommand['purpose']; place: QueueCommand['place'] }[]
        const args = db.prepare('SELECT command, arg FROM workflow_queue_pause_command_args WHERE project = ? AND target = ? ORDER BY command, ord').all(p, target) as { command: number; arg: string }[]
        const of = (ord: number): string[] => args.filter((a) => a.command === ord).map((a) => a.arg)
        stuck = { folder: row.folder, branch: row.branch, ref: row.ref, expected: row.expected, result: row.result, phase: row.phase, files: rows.map((r) => ({ path: r.path, side: r.side ?? 'other' })), commands: commands.map((c) => ({ purpose: c.purpose, place: c.place, args: of(c.ord), command: shellLine(of(c.ord)) })) }
      }
      return { reason: row.reason, card: row.card, ...(files.length ? { files } : {}), ...(row.pid !== null ? { pid: row.pid } : {}), ...(row.message !== null ? { message: row.message } : {}), ...(row.paused_by ? { by: row.paused_by } : {}), ...(row.paused_at ? { at: row.paused_at } : {}), ...(stuck ? { stuck } : {}) }
    })
  }

  /** The targets of this project whose queue is paused. */
  pausedTargets(): string[] {
    return this.conn.read((db) => (db.prepare('SELECT target FROM workflow_queue_pauses WHERE project = ?').all(this.scope.project) as { target: string }[]).map((r) => r.target))
  }

  /** When the user saw this project's returned queue entries (#1356), by entry id. */
  queueSeen(): Map<string, string> {
    return this.conn.read((db) => new Map((db.prepare('SELECT entry, seen_at FROM workflow_queue_seen WHERE project = ?').all(this.scope.project) as { entry: string; seen_at: string }[]).map((r) => [r.entry, r.seen_at])))
  }

  /** Marks returned entries seen (#1356), now; one seen already keeps its time. Whether any was new. */
  markQueueSeen(entries: readonly string[]): boolean {
    if (!entries.length) return false
    const at = this.now().toISOString()
    return this.conn.write((db) => {
      const ins = db.prepare('INSERT OR IGNORE INTO workflow_queue_seen (project, entry, seen_at) VALUES (?, ?, ?)')
      let n = 0
      for (const e of entries) n += Number(ins.run(this.scope.project, e, at).changes)
      return n > 0
    })
  }

  /**
   * Pauses a target's queue (`pause`), or resumes it (null). `keep`: only when it isn't paused already, decided in the same
   * write (HR4's #1351 round 1: Combwork's pause never replaces one saved meanwhile, the user's Pause queue say); whether it
   * was written.
   */
  setQueuePause(target: string, pause: QueuePause | null, keep = false): boolean {
    const p = this.scope.project
    return this.conn.write((db) => {
      const before = db.prepare('SELECT reason, card FROM workflow_queue_pauses WHERE project = ? AND target = ?').get(p, target) as { reason: string; card: string } | undefined
      if (keep && before) return false
      db.prepare('DELETE FROM workflow_queue_pauses WHERE project = ? AND target = ?').run(p, target)
      const now = this.now().toISOString()
      const at = pause ? (pause.at ?? now) : now
      // Its log (HI-1924), in the same write.
      this.logPause(db, target, before ?? null, pause ? { reason: pause.reason, card: pause.card, ...(pause.by ? { by: pause.by } : {}), ...(pause.message ? { message: pause.message } : {}), at } : null, now)
      if (!pause) return true
      const st = pause.stuck
      db.prepare('INSERT INTO workflow_queue_pauses (project, target, reason, card, pid, message, paused_by, paused_at, folder, branch, ref, expected, result, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(p, target, pause.reason, pause.card, pause.pid ?? null, pause.message ?? null, pause.by ?? null, at, st?.folder ?? null, st?.branch ?? null, st?.ref ?? null, st?.expected ?? null, st?.result ?? null, st?.phase ?? null)
      const ins = db.prepare('INSERT INTO workflow_queue_pause_files (project, target, ord, path, side) VALUES (?, ?, ?, ?, ?)')
      // A stuck advance's files are its listed files, each with its side; any other pause's, the files it names.
      if (st) st.files.forEach((f, i) => ins.run(p, target, i, f.path, f.side))
      else pause.files?.forEach((f, i) => ins.run(p, target, i, f, null))
      const cmd = db.prepare('INSERT INTO workflow_queue_pause_commands (project, target, ord, purpose, place) VALUES (?, ?, ?, ?, ?)')
      const arg = db.prepare('INSERT INTO workflow_queue_pause_command_args (project, target, command, ord, arg) VALUES (?, ?, ?, ?, ?)')
      st?.commands.forEach((c, i) => {
        cmd.run(p, target, i, c.purpose, c.place)
        c.args.forEach((a, j) => arg.run(p, target, i, j, a))
      })
      return true
    })
  }

  /** Resumes a target's queue only from a pause of this reason, in one write (a pause saved since in its place stays). */
  clearQueuePause(target: string, reason: string): boolean {
    return this.conn.write((db) => {
      const before = db.prepare('SELECT reason, card FROM workflow_queue_pauses WHERE project = ? AND target = ? AND reason = ?').get(this.scope.project, target, reason) as { reason: string; card: string } | undefined
      if (!before) return false
      db.prepare('DELETE FROM workflow_queue_pauses WHERE project = ? AND target = ? AND reason = ?').run(this.scope.project, target, reason)
      this.logPause(db, target, before, null, this.now().toISOString())
      return true
    })
  }

  /** A target's pause log (HI-1924), newest first. */
  queuePauseLog(target: string): QueuePauseLogged[] {
    return pauseLogOf(this.meta(pauseLogKey(target)))
  }

  /** The pause log after a pause saved or lifted, in the caller's write (`before`: the pause the target had; none, nothing ends). */
  private logPause(db: DatabaseSync, target: string, before: { reason: string; card: string } | null, pause: Omit<QueuePauseLogged, 'ended'> | null, now: string): void {
    if (!before && !pause) return
    const key = this.metaKey(pauseLogKey(target))
    const had = (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
    const log = pauseLogged(pauseLogOf(had), before, pause, now)
    db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(log))
  }

  // --- The queue's runner (#1360): its lease, its processes, its worktrees. Quiet writes: the window shows none of them.

  /** The lease of this project's queue for a target, or null when no runner holds it. */
  queueLease(target: string): QueueLease | null {
    return this.conn.read((db) => {
      const r = db.prepare('SELECT * FROM queue_runners WHERE project = ? AND target = ?').get(this.scope.project, target) as Record<string, string | number> | undefined
      return r ? { target: r.target as string, lease: r.lease as string, token: r.token as string, profile: r.profile as string, pid: r.pid as number, started: r.started as number, takenAt: r.taken_at as string, renewedAt: r.renewed_at as string } : null
    })
  }

  /**
   * Takes a target's lease: when no runner holds it (`replacing` null), or in place of the one whose token is `replacing`
   * (a takeover, decided outside the write: it is taken only while that lease is still the target's). Whether it was taken.
   */
  takeQueueLease(l: QueueLease, replacing: string | null): boolean {
    const p = this.scope.project
    return this.conn.write((db) => {
      if (replacing === null) return Number(db.prepare('INSERT INTO queue_runners (project, target, lease, token, profile, pid, started, taken_at, renewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(p, l.target, l.lease, l.token, l.profile, l.pid, l.started, l.takenAt, l.renewedAt).changes) > 0
      return Number(db.prepare('UPDATE queue_runners SET lease = ?, token = ?, profile = ?, pid = ?, started = ?, taken_at = ?, renewed_at = ? WHERE project = ? AND target = ? AND token = ?').run(l.lease, l.token, l.profile, l.pid, l.started, l.takenAt, l.renewedAt, p, l.target, replacing).changes) > 0
    }, true)
  }

  /** Whether the lease is still held with this token (inside a write: as that write sees it). */
  holdsQueueLease(lease: string, token: string): boolean {
    return this.conn.read((db) => !!db.prepare('SELECT 1 FROM queue_runners WHERE lease = ? AND token = ?').get(lease, token))
  }

  /** Notes a held lease as seen now (display only); false when it isn't held any more. */
  renewQueueLease(lease: string, token: string, at: string): boolean {
    return this.conn.write((db) => Number(db.prepare('UPDATE queue_runners SET renewed_at = ? WHERE lease = ? AND token = ?').run(at, lease, token).changes) > 0, true)
  }

  /** Gives up a lease: only its own row (by token), never a successor's. */
  dropQueueLease(lease: string, token: string): boolean {
    return this.conn.write((db) => Number(db.prepare('DELETE FROM queue_runners WHERE lease = ? AND token = ?').run(lease, token).changes) > 0, true)
  }

  /** The processes a lease's runner owns, or (`lease` null) every lease's of a target: its duties, kept until seen gone. */
  queueProcs(lease: string | null, target?: string): QueueProc[] {
    type Row = { lease: string; target: string; pid: number; start_after: number; start_before: number; what: QueueProcKind }
    return this.conn.read((db) =>
      ((lease !== null ? db.prepare('SELECT * FROM queue_runner_procs WHERE lease = ?').all(lease) : db.prepare('SELECT * FROM queue_runner_procs WHERE project = ? AND target = ?').all(this.scope.project, target ?? '')) as Row[]).map((r) => ({ lease: r.lease, target: r.target, pid: r.pid, startAfter: r.start_after, startBefore: r.start_before, what: r.what }))
    )
  }

  addQueueProc(p: QueueProc): void {
    this.conn.write((db) => db.prepare('INSERT OR REPLACE INTO queue_runner_procs (lease, project, target, pid, start_after, start_before, what) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.lease, this.scope.project, p.target, p.pid, p.startAfter, p.startBefore, p.what), true)
  }

  dropQueueProc(lease: string, pid: number): void {
    this.conn.write((db) => db.prepare('DELETE FROM queue_runner_procs WHERE lease = ? AND pid = ?').run(lease, pid), true)
  }

  /** This project's queue worktrees (for a target), as recorded. */
  queueFolders(target?: string): QueueFolder[] {
    const p = this.scope.project
    return this.conn.read((db) =>
      (target === undefined ? db.prepare('SELECT folder, target, lease FROM queue_worktrees WHERE project = ?').all(p) : db.prepare('SELECT folder, target, lease FROM queue_worktrees WHERE project = ? AND target = ?').all(p, target)) as unknown as QueueFolder[]
    )
  }

  setQueueFolder(f: QueueFolder): void {
    this.conn.write((db) => db.prepare('INSERT INTO queue_worktrees (folder, project, target, lease) VALUES (?, ?, ?, ?) ON CONFLICT (folder) DO UPDATE SET target = excluded.target, lease = excluded.lease').run(f.folder, this.scope.project, f.target, f.lease), true)
  }

  dropQueueFolder(folder: string): void {
    this.conn.write((db) => db.prepare('DELETE FROM queue_worktrees WHERE folder = ?').run(folder), true)
  }

  /** Several of the runner's quiet writes, and the reads between them, as one write (a fence's check and what it guards). */
  quiet<T>(fn: () => T): T {
    return this.conn.write(() => fn(), true)
  }

  /** One of this project's values (a scalar: a line's last head seen, a folder's installed manifests' hash). */
  meta(key: string): string | null {
    return this.conn.read((db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(this.metaKey(key)) as { value: string } | undefined)?.value ?? null)
  }

  /** A workspace-wide board_meta value, unscoped (HI-2799: the platform fence), read in the write under way if there is one. */
  boardMeta(key: string): string | null {
    return this.conn.read((db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null)
  }

  setMeta(key: string, value: string): void {
    this.conn.write((db) => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(this.metaKey(key), value))
  }

  /** The provenance epoch's key: the project's stable id (never its name or key, which a rename changes), else its scope. */
  private epochKey(): string {
    return `provenance_epoch:${(this.scope.projectId?.() ?? this.scope.project).toLowerCase()}`
  }

  /**
   * The project's provenance epoch (HI-2868): how many submissions and adoptions its cards have had recorded, moved in
   * each one's own transaction. Read in the write under way if there is one.
   */
  provenanceEpoch(): number {
    return this.conn.read((db) => Number((db.prepare('SELECT value FROM board_meta WHERE key = ?').get(this.epochKey()) as { value: string } | undefined)?.value ?? 0))
  }

  private metaKey(key: string): string {
    return `workflow:${this.scope.project.toLowerCase()}:${key}`
  }

  // --- Writes.

  /**
   * One transaction: everything `fn` writes commits together or not at all. On the board, the caller's change (outside
   * one, it fails); on a connection of the store's own, a transaction of its own, which what `fn` does joins.
   */
  tx<T>(fn: (tx: Tx) => T): T {
    return this.conn.write((w) => {
      const at = (): string => this.now().toISOString()
      const nextSeq = (card: number): number => ((w.prepare('SELECT MAX(seq) AS m FROM card_facts WHERE card = ?').get(card) as { m: number | null }).m ?? 0) + 1
      const insert = <K extends FactKind>(card: number, f: NewFact<K> & { dedupe?: string }): Fact<K> => {
        const seq = nextSeq(card)
        const full = { ...f, seq, card, at: at() } as Fact<K>
        w.prepare('INSERT INTO card_facts (card, seq, kind, at, actor, source, ruleset, dedupe, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(card, seq, f.kind, full.at, f.actor, f.source, f.ruleset ?? null, f.dedupe ?? null, JSON.stringify(f.data))
        // The project's provenance epoch (HI-2868): moved in the same transaction as every accepted submission or adoption,
        // so an intent that decided on the provenance before it (jj's attribution) sees it moved in its own write.
        if (f.kind === 'Submitted' || f.kind === 'Adopted') w.prepare("INSERT INTO board_meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(this.epochKey())
        return full
      }
      const tx: Tx = {
        append: (card, f) => this.conn.write(() => insert(card, f)),
        appendObserved: (card, f) =>
          this.conn.write(() => {
            const exists = w.prepare('SELECT 1 FROM card_facts WHERE card = ? AND kind = ? AND dedupe = ?').get(card, f.kind, f.dedupe)
            return exists ? null : insert(card, { ...f, source: 'observed' })
          }),
        setStage: (card, stage) => {
          // The stage cache, and the card's column its category (SPEC §16.4.3): the board shows where the fold put it. A
          // card the workflow moves is a 1.0 card from then on (HI-1674: one from before 1.0 started by an intent kept its
          // mark, so the board's moves of it skipped its rules, Done in the column and Active in the stage).
          this.conn.write(() => w.prepare('UPDATE cards SET stage = ?, col = ?, pre_workflow = 0 WHERE number = ?').run(stage, STAGE_CATEGORY[stage], card))
        },
        action: (card, kind, payload, fact) => this.conn.write(() => Number(w.prepare('INSERT INTO card_actions (card, kind, payload, fact) VALUES (?, ?, ?, ?)').run(card, kind, JSON.stringify(payload), fact).lastInsertRowid)),
        saveRuleset: (r) => this.saveRuleset(r),
        hasAction: (card, kind, fact) => this.hasAction(card, kind, fact),
        facts: (card) => this.facts(card),
        card: (id) => this.card(id),
        putCard: (c) => {
          const { id, key: _k, stage: _s, category: _c, lane: _l, reviewer: _r, reviewerPool: _p, rounds: _n, ...patch } = c
          this.updateCard(id, patch)
        },
        meta: (k) => this.meta(k),
        setMeta: (k, v) => this.setMeta(k, v),
        recordFolderCommit: (folder, sha, card, how) => this.recordFolderCommit(folder, sha, card, how)
      }
      return fn(tx)
    })
  }
}

/** The columns beside the document a create or an update gives (each left as it is when not given). */
/**
 * A lane's part the runtime writes: its list (lanes.ts's `lane_cards`), its end (as lanes.ts ends one; never reopened
 * here), and what the runtime keeps beside it: the ruleset, the card in flight, a queued list change.
 */
function writeLane(db: DatabaseSync, l: LaneList, at: string): void {
  const cards = (db.prepare('SELECT card FROM lane_cards WHERE lane = ? ORDER BY ord').all(l.id) as { card: number }[]).map((r) => r.card)
  if (cards.length !== l.cards.length || cards.some((c, i) => c !== l.cards[i])) {
    db.prepare('DELETE FROM lane_cards WHERE lane = ?').run(l.id)
    const ins = db.prepare('INSERT INTO lane_cards (lane, ord, card) VALUES (?, ?, ?)')
    l.cards.forEach((c, i) => ins.run(l.id, i, c))
    db.prepare('UPDATE lanes SET updated_at = ? WHERE id = ?').run(at, l.id)
  }
  if (l.ended) db.prepare("UPDATE lanes SET state = 'ended', ended_at = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(at, at, l.id)
  db.prepare('INSERT INTO lane_runs (lane, ruleset, current_card, has_pending) VALUES (?, ?, ?, ?) ON CONFLICT (lane) DO UPDATE SET ruleset = excluded.ruleset, current_card = excluded.current_card, has_pending = excluded.has_pending').run(l.id, l.ruleset, l.current, l.pending ? 1 : 0)
  db.prepare('DELETE FROM lane_pending WHERE lane = ?').run(l.id)
  const ins = db.prepare('INSERT INTO lane_pending (lane, ord, card) VALUES (?, ?, ?)')
  l.pending?.forEach((c, i) => ins.run(l.id, i, c))
}

/** The columns beside the document a create or an update gives (each left as it is when not given). */
function setColumns(db: DatabaseSync, id: number, c: { target?: string; paths?: string[] }): void {
  if ('target' in c) db.prepare('UPDATE cards SET target = ? WHERE number = ?').run(c.target ?? null, id)
  if (c.paths) {
    db.prepare('UPDATE cards SET paths_declared = 1 WHERE number = ?').run(id)
    db.prepare("DELETE FROM card_paths WHERE card = ? AND kind = 'declared'").run(id)
    const ins = db.prepare("INSERT OR IGNORE INTO card_paths (card, kind, ord, path) VALUES (?, 'declared', ?, ?)")
    c.paths.forEach((p, i) => ins.run(id, i, p))
  }
}

/** A `card_facts` row as a fact. */
export function factOf(r: Record<string, string | number | null>): Fact {
  return {
    seq: r.seq as number,
    card: r.card as number,
    kind: r.kind as FactKind,
    at: r.at as string,
    actor: r.actor as Actor,
    source: r.source as 'recorded' | 'observed',
    ...(r.ruleset ? { ruleset: r.ruleset as string } : {}),
    ...(r.dedupe ? { dedupe: r.dedupe as string } : {}),
    data: JSON.parse(r.data as string)
  }
}

function actionOf(r: Record<string, string | number | null>): ActionRow {
  return { id: r.id as number, card: r.card as number, kind: r.kind as string, payload: JSON.parse(r.payload as string), state: r.state as ActionRow['state'], attempts: r.attempts as number, fact: r.fact as number | null }
}

/** Every pending action of the workspace, in the order written (the actions worker's list). */
export function pendingActionsOf(db: DatabaseSync): ActionRow[] {
  return (db.prepare("SELECT * FROM card_actions WHERE state = 'pending' ORDER BY id").all() as Record<string, string | number | null>[]).map(actionOf)
}
