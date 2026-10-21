// The fact log's store (SPEC §16.4.1, §16.4.5): facts, the card's stage cache and the durable actions they cause, written
// in one transaction, so a fact and the move it caused can't diverge and nothing outside happens for a write that
// rolled back. Observed facts carry a dedupe key, unique per card and kind, so two Hives observing one workspace write
// each transition once (§16.17).
//
// In the workspace's hive.db since #1215 (Darren, #1118: "the fact store replaced by hive.db tables written inside
// boardWrite"): the 1.0 group's facts step makes its tables (schema/v1_0.ts), and a card is the board's own row. A store
// is one project's: its cards, its lanes, its queue's pauses and its values. It reaches the database one of two ways
// (HR4's #1215 round 1): on the board's (`forBoard`), its writes are part of the caller's boardWrite only, through the
// board's own guarded write path, and its reads are the board's, on one snapshot; on a connection of its own (`open`:
// another Hive, a restart, the runtime's tests), its writes are its own transactions and its reads one snapshot each.

import type { DatabaseSync } from 'node:sqlite'
import { openDb, type Db } from '../db'
import { BOARD_MIGRATIONS, boardChanged, boardRead, boardWriteOp, takeNumberIn } from '../boardStore'
import { decomposeCard, writeCardRows } from '../schema/cardRows'
import type { WorkspaceService } from '../workspace'
import type { Actor, CardKind, Category, Fact, FactKind, NewFact, StageId } from '../../shared/workflow/facts'
import { CATEGORY_STAGE, STAGE_CATEGORY } from '../../shared/workflow/facts'
import type { Ruleset } from '../../shared/workflow/compile'
import { loadRuleset } from '../../shared/workflow/compile'
import { newLane, type LaneList } from '../../shared/workflow/laneList'
import { LOOP_ROUNDS, LOOP_WAIT_HOURS } from '../../shared/lanes'

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
  write<T>(fn: (db: DatabaseSync) => T): T
  close(): void
}

/**
 * The board's database: reads as the board's readers make them (the caller's change's transaction inside one of its
 * own, else the reader, on one snapshot); writes only inside a change of the workspace's board (boardWrite), by the
 * board's guard: a write outside one, from another change's async context, or once SQLite has undone the change, fails.
 */
const boardConn = (ws: WorkspaceService): Conn => ({
  read: (fn) => boardRead(ws, fn),
  // A fact (observed ones too) changes what the window shows of a card (its work view, #1223): `tasks-changed` once
  // the change commits.
  write: (fn) => {
    const out = boardWriteOp(ws, fn)
    boardChanged(ws)
    return out
  },
  close: () => undefined
})

/** SQLite undid a store's own transaction part way (a full disk, an I/O error): nothing of it was saved. */
const lostTx = (): Error => new Error("The fact store's write was undone part way: nothing of it was saved") // i18n-ignore: an error from SQLite's side, logged and thrown to the runtime's caller

/**
 * A connection of the store's own (nothing else uses it): a write is a transaction of its own (BEGIN IMMEDIATE: another
 * Hive's write waits for it), and what the store does inside it (synchronously: nothing else runs meanwhile) is part of
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

type Scope = { project: string; key: string; now?: () => Date }

/** For tests: runs once a read of cards' records has read their rows, before their lists (another connection committing there). */
export const factStoreTestHooks: { afterCards: (() => void) | null } = { afterCards: null }

export class FactStore {
  private now: () => Date

  private constructor(
    private readonly conn: Conn,
    readonly scope: Scope
  ) {
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

  /** A store on a connection of its own to a workspace database's file, opened as the board opens it (another Hive on it; a restart). */
  static open(file: string, scope: Scope): FactStore {
    return new FactStore(new OwnConn(openDb(file, { migrations: BOARD_MIGRATIONS, hiveVersion: 'workflow' }), true), scope)
  }

  /** Closes the connection the store opened; once. */
  close(): void {
    this.conn.close()
  }

  private keyOf(n: number): string {
    return `${this.scope.key}-${n}`
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
      // Its lane (#1291): the newest running lane of this project with it in its list or its queued one.
      const lanes = new Map<number, { lane: string; reviewer: string | null; rounds: number }>()
      const inLanes = `SELECT x.card, l.id AS lane, l.reviewer_id AS reviewer, l.rounds FROM (SELECT lane, card FROM lane_cards UNION ALL SELECT lane, card FROM lane_pending) x
        JOIN lanes l ON l.id = x.lane WHERE x.${of} AND l.state = 'active' AND l.project = ? COLLATE NOCASE ORDER BY l.started_at, l.id`
      for (const r of db.prepare(inLanes).all(...args, this.scope.project) as { card: number; lane: string; reviewer: string | null; rounds: number }[]) lanes.set(r.card, { lane: r.lane, reviewer: r.reviewer, rounds: r.rounds })
      return rows.map((r) => ({
        id: r.number,
        key: this.keyOf(r.number),
        title: r.title,
        kind: r.kind,
        labels: labels.get(r.number) ?? [],
        blockedBy: blockedBy.get(r.number) ?? [],
        ...(r.target !== null ? { target: r.target } : {}),
        ...(r.paths_declared ? { paths: paths.get(r.number) ?? [] } : {}),
        ...(lanes.has(r.number) ? { lane: lanes.get(r.number)!.lane } : {}),
        ...(lanes.get(r.number)?.reviewer ? { reviewer: lanes.get(r.number)!.reviewer! } : {}),
        ...(lanes.has(r.number) ? { rounds: lanes.get(r.number)!.rounds } : {}),
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

  /** A card of this project by its key (`<key>-12`, any case; the key may itself hold hyphens: a project's name), or null. */
  cardByKey(key: string): CardRecord | null {
    const m = /^(.+)-(\d+)$/.exec(key.trim())
    if (!m || !this.scope.key || m[1].toLowerCase() !== this.scope.key.toLowerCase()) return null
    return this.records('number = ? AND project = ?', [Number(m[2]), this.scope.project])[0] ?? null
  }

  /** This project's cards (not archived), in number order. */
  cards(): CardRecord[] {
    return this.records('project = ? AND archived = 0', [this.scope.project])
  }

  /** A new card of this project on the board (the runtime's own; the board's are made by tasks.ts), in Todo unless `stage` says. */
  createCard(c: Omit<CardRecord, 'id' | 'key' | 'stage' | 'category' | 'lane' | 'reviewer' | 'rounds'> & { stage?: StageId }): CardRecord {
    const stage = c.stage ?? 'todo'
    return this.conn.write((db) => {
      const n = takeNumberIn(db)
      const at = this.now().toISOString()
      const doc = { number: n, title: c.title, description: '', project: this.scope.project, agent: null, column: STAGE_CATEGORY[stage], order: n, labels: c.labels, blocked: null, blockedBy: c.blockedBy, links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'Hive', updatedAt: at }
      writeCardRows(db, decomposeCard(n, doc))
      db.prepare('UPDATE cards SET stage = ?, kind = ?, pre_workflow = ? WHERE number = ?').run(stage, c.kind, c.preWorkflow ? 1 : 0, n)
      setColumns(db, n, c)
      return this.card(n)
    })
  }

  /** Changes what the runtime keeps of a card: its kind, target and declared paths (its lane is its lanes', #1291). */
  updateCard(id: number, patch: Partial<Omit<CardRecord, 'id' | 'key' | 'stage' | 'category' | 'lane' | 'reviewer' | 'rounds'>>): CardRecord {
    const other = Object.keys(patch).filter((k) => !['kind', 'target', 'paths', 'title', 'labels', 'blockedBy', 'preWorkflow'].includes(k))
    if (other.length) throw new Error(`a card's ${other.join(', ')} isn't the runtime's to change`) // i18n-ignore: a programming error, never shown
    return this.conn.write((db) => {
      if (patch.kind !== undefined) db.prepare('UPDATE cards SET kind = ? WHERE number = ?').run(patch.kind, id)
      if (patch.preWorkflow !== undefined) db.prepare('UPDATE cards SET pre_workflow = ? WHERE number = ?').run(patch.preWorkflow ? 1 : 0, id)
      setColumns(db, id, patch)
      return this.card(id)
    })
  }

  /** None: the paths Hive saw a card's agents edit (its pre-fill, §16.3.3), in the order seen. */
  prefill(id: number): string[] {
    return this.conn.read((db) => (db.prepare("SELECT path FROM card_paths WHERE card = ? AND kind = 'prefill' ORDER BY ord").all(id) as { path: string }[]).map((r) => r.path))
  }

  /** Adds a path to a card's pre-fill (once). */
  addPrefill(id: number, path: string): void {
    this.conn.write((db) => db.prepare("INSERT OR IGNORE INTO card_paths (card, kind, ord, path) VALUES (?, 'prefill', (SELECT coalesce(max(ord), -1) + 1 FROM card_paths WHERE card = ? AND kind = 'prefill'), ?)").run(id, id, path))
  }

  // --- Facts, rulesets, actions.

  facts(card: number): Fact[] {
    return this.conn.read((db) => (db.prepare('SELECT * FROM card_facts WHERE card = ? ORDER BY seq').all(card) as Record<string, string | number | null>[]).map(factOf))
  }

  /** This project's facts of a kind, in the order written (the queue's order). */
  factsOfKind(kind: FactKind): Fact[] {
    return this.conn.read((db) => (db.prepare('SELECT f.* FROM card_facts f JOIN cards c ON c.number = f.card WHERE f.kind = ? AND c.project = ? ORDER BY f.rowid').all(kind, this.scope.project) as Record<string, string | number | null>[]).map(factOf))
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

  /**
   * The runtime starts a lane of this project (tests/workflow until #1270 wires the app's): lanes.ts's lane of that id,
   * its cards and reviewer (if given) set, or a new one by Hive when there is none; with the ruleset in force now.
   */
  startLane(id: string, cards: number[], ruleset: string, reviewer?: string, rounds = LOOP_ROUNDS): LaneList {
    this.conn.write((db) => {
      const at = this.now().toISOString()
      const had = db.prepare('SELECT project FROM lanes WHERE id = ?').get(id) as { project: string } | undefined
      if (had && had.project.toLowerCase() !== this.scope.project.toLowerCase()) throw new Error(`lane ${id} is another project's`) // i18n-ignore: a programming error, never shown
      if (!had) {
        const ord = (db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM lanes').get() as { n: number }).n
        db.prepare(
          "INSERT INTO lanes (id, ord, project, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at) VALUES (?, ?, ?, 'hive', 'Hive', ?, ?, ?, ?, 'active', 'Hive', ?, ?)"
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
      const row = db.prepare('SELECT reason, card FROM workflow_queue_pauses WHERE project = ? AND target = ?').get(p, target) as { reason: string; card: string } | undefined
      if (!row) return null
      const files = (db.prepare('SELECT path FROM workflow_queue_pause_files WHERE project = ? AND target = ? ORDER BY ord').all(p, target) as { path: string }[]).map((r) => r.path)
      return { reason: row.reason, card: row.card, ...(files.length ? { files } : {}) }
    })
  }

  /** Pauses a target's queue (`pause`), or resumes it (null). */
  setQueuePause(target: string, pause: QueuePause | null): void {
    const p = this.scope.project
    this.conn.write((db) => {
      db.prepare('DELETE FROM workflow_queue_pauses WHERE project = ? AND target = ?').run(p, target)
      if (!pause) return
      db.prepare('INSERT INTO workflow_queue_pauses (project, target, reason, card) VALUES (?, ?, ?, ?)').run(p, target, pause.reason, pause.card)
      const ins = db.prepare('INSERT INTO workflow_queue_pause_files (project, target, ord, path) VALUES (?, ?, ?, ?)')
      pause.files?.forEach((f, i) => ins.run(p, target, i, f))
    })
  }

  /** One of this project's values (a scalar: a line's last head seen, a folder's installed manifests' hash). */
  meta(key: string): string | null {
    return this.conn.read((db) => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(this.metaKey(key)) as { value: string } | undefined)?.value ?? null)
  }

  setMeta(key: string, value: string): void {
    this.conn.write((db) => db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(this.metaKey(key), value))
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
          // The stage cache, and the card's column its category (SPEC §16.4.3): the board shows where the fold put it.
          this.conn.write(() => w.prepare('UPDATE cards SET stage = ?, col = ? WHERE number = ?').run(stage, STAGE_CATEGORY[stage], card))
        },
        action: (card, kind, payload, fact) => this.conn.write(() => Number(w.prepare('INSERT INTO card_actions (card, kind, payload, fact) VALUES (?, ?, ?, ?)').run(card, kind, JSON.stringify(payload), fact).lastInsertRowid)),
        saveRuleset: (r) => this.saveRuleset(r),
        hasAction: (card, kind, fact) => this.hasAction(card, kind, fact),
        facts: (card) => this.facts(card),
        card: (id) => this.card(id),
        putCard: (c) => {
          const { id, key: _k, stage: _s, category: _c, lane: _l, reviewer: _r, rounds: _n, ...patch } = c
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
