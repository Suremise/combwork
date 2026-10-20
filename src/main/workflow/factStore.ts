// The fact log's store (SPEC §16.4.1, §16.4.5): facts, the card's stage cache and the durable actions they cause, written
// in one transaction, so a fact and the move it caused can't diverge and nothing outside happens for a write that
// rolled back. Observed facts carry a dedupe key, unique per card and kind, so two Hives observing one workspace write
// each transition once (§16.17).
//
// In the workspace's hive.db since #1215 (Darren, #1118: "the fact store replaced by hive.db tables written inside
// boardWrite"): the 1.0 group's facts step makes its tables (schema/v1_0.ts), and a card is the board's own row. A store
// is one project's: its cards, its lanes, its queue's pauses and its values. Writes join the transaction the connection
// is in (the caller's boardWrite: a fact commits with the card change it causes), else run in one of their own.

import type { DatabaseSync } from 'node:sqlite'
import { openDb, transaction, type Db } from '../db'
import { BOARD_MIGRATIONS, takeNumberIn } from '../boardStore'
import { decomposeCard, writeCardRows } from '../schema/cardRows'
import type { Actor, CardKind, Category, Fact, FactKind, NewFact, StageId } from '../../shared/workflow/facts'
import { STAGE_CATEGORY } from '../../shared/workflow/facts'
import type { Ruleset } from '../../shared/workflow/compile'
import { loadRuleset } from '../../shared/workflow/compile'
import type { LaneList } from '../../shared/workflow/laneList'

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
  /** The lane it is in, whose ruleset it uses (§16.11.1). */
  lane?: string
  /** The reviewer agent to wake (a lane's), else the pool. */
  reviewer?: string
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
  action(card: number, kind: string, payload: Record<string, unknown>, fact: number | null): number
  facts(card: number): Fact[]
  card(id: number): CardRecord
  putCard(card: CardRecord): void
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  /** A commit seen on a shared folder's line, and whose it is: false when it was already recorded. */
  recordFolderCommit(folder: string, sha: string, card: number | null, how: string): boolean
}

/** The stage a column stands for, for a card no 1.0 rule has moved yet (its `stage` empty). */
const COLUMN_STAGE: Record<Category, StageId> = { hold: 'hold', todo: 'todo', doing: 'active', review: 'review', passed: 'approved', done: 'done' }

/** The runtime's columns of a card, as the store reads them. */
interface CardCols {
  number: number
  title: string
  col: Category
  stage: StageId | null
  pre_workflow: number
  kind: CardKind
  target: string | null
  lane: string | null
  lane_reviewer: string | null
  paths_declared: number
}
const COLS = 'number, title, col, stage, pre_workflow, kind, target, lane, lane_reviewer, paths_declared'

export class FactStore {
  private now: () => Date

  /**
   * A project's store on the workspace database (the board's `Db`, or another connection to its file, as another Hive):
   * `project` is the project's name on the board (its cards' `project`), `key` its key.
   */
  constructor(
    readonly db: Db,
    readonly scope: { project: string; key: string; now?: () => Date },
    private readonly owned = false
  ) {
    this.now = scope.now ?? (() => new Date())
  }

  /** A store on a connection of its own to a workspace database's file, opened as the board opens it (another Hive on it; a restart). */
  static open(file: string, scope: { project: string; key: string; now?: () => Date }): FactStore {
    return new FactStore(openDb(file, { migrations: BOARD_MIGRATIONS, hiveVersion: 'workflow' }), scope, true)
  }

  private closed = false

  /** Closes the connection the store opened (one it was given is its owner's); once. */
  close(): void {
    if (!this.owned || this.closed) return
    this.closed = true
    this.db.close()
  }

  /** The writer: a write and the reads it makes see its own changes, and a store's reads see what was committed. */
  private get w(): DatabaseSync {
    return this.db.writer
  }

  private keyOf(n: number): string {
    return `${this.scope.key}-${n}`
  }

  // --- Cards.

  /** Cards' records by a condition on `cards` (this module's SQL, its arguments bound), in number order. */
  private records(where: string, args: (string | number)[]): CardRecord[] {
    const rows = this.w.prepare(`SELECT ${COLS} FROM cards WHERE ${where} ORDER BY number`).all(...args) as unknown as CardCols[]
    if (!rows.length) return []
    const of = `card IN (SELECT number FROM cards WHERE ${where})`
    const lists = (sql: string): Map<number, string[] | number[]> => {
      const m = new Map<number, (string | number)[]>()
      for (const r of this.w.prepare(sql).all(...args) as { card: number; v: string | number }[]) m.set(r.card, [...(m.get(r.card) ?? []), r.v])
      return m as Map<number, string[] | number[]>
    }
    const labels = lists(`SELECT card, label AS v FROM card_labels WHERE ${of} ORDER BY card, ord`)
    const blockedBy = lists(`SELECT card, target AS v FROM card_links WHERE ${of} AND kind = 'blockedBy' ORDER BY card, ord`)
    const paths = lists(`SELECT card, path AS v FROM card_paths WHERE ${of} AND kind = 'declared' ORDER BY card, ord`)
    return rows.map((r) => {
      const stage = r.stage ?? COLUMN_STAGE[r.col] ?? 'todo'
      return {
        id: r.number,
        key: this.keyOf(r.number),
        title: r.title,
        kind: r.kind,
        labels: (labels.get(r.number) as string[] | undefined) ?? [],
        blockedBy: (blockedBy.get(r.number) as number[] | undefined) ?? [],
        ...(r.target !== null ? { target: r.target } : {}),
        ...(r.paths_declared ? { paths: (paths.get(r.number) as string[] | undefined) ?? [] } : {}),
        ...(r.lane !== null ? { lane: r.lane } : {}),
        ...(r.lane_reviewer !== null ? { reviewer: r.lane_reviewer } : {}),
        ...(r.pre_workflow ? { preWorkflow: true } : {}),
        stage,
        category: r.col
      }
    })
  }

  card(id: number): CardRecord {
    const c = this.records('number = ?', [id])[0]
    if (!c) throw new Error(`no card ${id}`) // i18n-ignore: a programming error, never shown
    return c
  }

  /** A card of this project by its key (`AM-12`), or null. */
  cardByKey(key: string): CardRecord | null {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key)
    if (!m || m[1].toLowerCase() !== this.scope.key.toLowerCase()) return null
    return this.records('number = ? AND project = ?', [Number(m[2]), this.scope.project])[0] ?? null
  }

  /** This project's cards (not archived), in number order. */
  cards(): CardRecord[] {
    return this.records('project = ? AND archived = 0', [this.scope.project])
  }

  /** A new card of this project on the board (the runtime's own; the board's are made by tasks.ts), in Todo unless `stage` says. */
  createCard(c: Omit<CardRecord, 'id' | 'key' | 'stage' | 'category'> & { stage?: StageId }): CardRecord {
    const stage = c.stage ?? 'todo'
    return this.tx(() => {
      const n = takeNumberIn(this.w)
      const at = this.now().toISOString()
      const doc = { number: n, title: c.title, description: '', project: this.scope.project, agent: null, column: STAGE_CATEGORY[stage], order: n, labels: c.labels, blocked: null, blockedBy: c.blockedBy, links: [], comments: [], history: [], archived: false, createdAt: at, createdBy: 'Hive', updatedAt: at }
      writeCardRows(this.w, decomposeCard(n, doc))
      this.w.prepare('UPDATE cards SET stage = ?, kind = ?, pre_workflow = ? WHERE number = ?').run(stage, c.kind, c.preWorkflow ? 1 : 0, n)
      this.setColumns(n, c)
      return this.card(n)
    })
  }

  /** Changes what the runtime keeps of a card: its kind, target, declared paths, lane and lane's reviewer. */
  updateCard(id: number, patch: Partial<Omit<CardRecord, 'id' | 'key' | 'stage' | 'category'>>): CardRecord {
    const other = Object.keys(patch).filter((k) => !['kind', 'target', 'paths', 'lane', 'reviewer', 'title', 'labels', 'blockedBy', 'preWorkflow'].includes(k))
    if (other.length) throw new Error(`a card's ${other.join(', ')} isn't the runtime's to change`) // i18n-ignore: a programming error, never shown
    return this.tx(() => {
      if (patch.kind !== undefined) this.w.prepare('UPDATE cards SET kind = ? WHERE number = ?').run(patch.kind, id)
      this.setColumns(id, patch)
      return this.card(id)
    })
  }

  /** The columns beside the document a create or an update gives (each left as it is when not given). */
  private setColumns(id: number, c: { target?: string; paths?: string[]; lane?: string; reviewer?: string }): void {
    if ('target' in c) this.w.prepare('UPDATE cards SET target = ? WHERE number = ?').run(c.target ?? null, id)
    if ('lane' in c) this.w.prepare('UPDATE cards SET lane = ? WHERE number = ?').run(c.lane ?? null, id)
    if ('reviewer' in c) this.w.prepare('UPDATE cards SET lane_reviewer = ? WHERE number = ?').run(c.reviewer ?? null, id)
    if (c.paths) {
      this.w.prepare('UPDATE cards SET paths_declared = 1 WHERE number = ?').run(id)
      this.setPaths(id, 'declared', c.paths)
    }
  }

  private setPaths(id: number, kind: 'declared' | 'prefill', paths: string[]): void {
    this.w.prepare('DELETE FROM card_paths WHERE card = ? AND kind = ?').run(id, kind)
    const ins = this.w.prepare('INSERT OR IGNORE INTO card_paths (card, kind, ord, path) VALUES (?, ?, ?, ?)')
    paths.forEach((p, i) => ins.run(id, kind, i, p))
  }

  /** None: the paths Hive saw a card's agents edit (its pre-fill, §16.3.3), in the order seen. */
  prefill(id: number): string[] {
    return (this.w.prepare("SELECT path FROM card_paths WHERE card = ? AND kind = 'prefill' ORDER BY ord").all(id) as { path: string }[]).map((r) => r.path)
  }

  /** Adds a path to a card's pre-fill (once). */
  addPrefill(id: number, path: string): void {
    this.w.prepare("INSERT OR IGNORE INTO card_paths (card, kind, ord, path) VALUES (?, 'prefill', (SELECT coalesce(max(ord), -1) + 1 FROM card_paths WHERE card = ? AND kind = 'prefill'), ?)").run(id, id, path)
  }

  // --- Facts, rulesets, actions.

  facts(card: number): Fact[] {
    return (this.w.prepare('SELECT * FROM card_facts WHERE card = ? ORDER BY seq').all(card) as Record<string, string | number | null>[]).map(factOf)
  }

  /** This project's facts of a kind, in the order written (the queue's order). */
  factsOfKind(kind: FactKind): Fact[] {
    return (this.w.prepare('SELECT f.* FROM card_facts f JOIN cards c ON c.number = f.card WHERE f.kind = ? AND c.project = ? ORDER BY f.rowid').all(kind, this.scope.project) as Record<string, string | number | null>[]).map(factOf)
  }

  ruleset(id: string): Ruleset {
    const row = this.w.prepare('SELECT data FROM rulesets WHERE id = ?').get(id) as { data: string } | undefined
    if (!row) throw new Error(`no ruleset ${id}`) // i18n-ignore: a programming error, never shown
    const r = loadRuleset(JSON.parse(row.data))
    if (!r.ok) throw new Error(`ruleset ${id}: ${r.error} ${r.piece ?? ''}`) // i18n-ignore: a programming error, never shown
    return r.ruleset
  }

  saveRuleset(r: Ruleset): void {
    this.w.prepare('INSERT OR IGNORE INTO rulesets (id, data) VALUES (?, ?)').run(r.id, JSON.stringify(r))
  }

  /** This project's pending actions, in the order written. */
  pendingActions(): ActionRow[] {
    return (this.w.prepare("SELECT a.* FROM card_actions a JOIN cards c ON c.number = a.card WHERE a.state = 'pending' AND c.project = ? ORDER BY a.id").all(this.scope.project) as Record<string, string | number | null>[]).map(actionOf)
  }

  markAction(id: number, state: ActionRow['state']): void {
    this.w.prepare('UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ?').run(state, id)
  }

  /** Records an action's delivery once: false when it was already delivered (an action run twice, §16.4.5). */
  deliver(d: Delivery): boolean {
    return deliverOnce(this.w, d)
  }

  /** This project's actions' deliveries, in the actions' order. */
  deliveries(): Delivery[] {
    return (this.w.prepare('SELECT a.id, a.delivered FROM card_actions a JOIN cards c ON c.number = a.card WHERE a.delivered IS NOT NULL AND c.project = ? ORDER BY a.id').all(this.scope.project) as { id: number; delivered: string }[]).map((r) => ({ action: r.id, ...(JSON.parse(r.delivered) as Omit<Delivery, 'action'>) }))
  }

  // --- Shared folders, lanes, the queue's pauses, values.

  folderCommits(folder: string): { sha: string; card: number | null; how: string }[] {
    return this.w.prepare('SELECT sha, card, how FROM folder_commits WHERE folder = ? ORDER BY id').all(folder) as { sha: string; card: number | null; how: string }[]
  }

  recordFolderCommit(folder: string, sha: string, card: number | null, how: string): boolean {
    return Number(this.w.prepare('INSERT OR IGNORE INTO folder_commits (folder, sha, card, how) VALUES (?, ?, ?, ?)').run(folder, sha, card, how).changes) > 0
  }

  lane(id: string): LaneList | null {
    const p = this.scope.project
    const row = this.w.prepare('SELECT ruleset, current, ended, has_pending FROM workflow_lanes WHERE project = ? AND id = ?').get(p, id) as { ruleset: string; current: number | null; ended: number; has_pending: number } | undefined
    if (!row) return null
    const cards = (list: string): number[] => (this.w.prepare('SELECT card FROM workflow_lane_cards WHERE project = ? AND lane = ? AND list = ? ORDER BY ord').all(p, id, list) as { card: number }[]).map((r) => r.card)
    return { id, cards: cards('cards'), ruleset: row.ruleset, pending: row.has_pending ? cards('pending') : null, current: row.current, ended: row.ended === 1 }
  }

  saveLane(l: LaneList): void {
    const p = this.scope.project
    this.tx(() => {
      this.w.prepare('INSERT INTO workflow_lanes (project, id, ruleset, current, ended, has_pending) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project, id) DO UPDATE SET ruleset = excluded.ruleset, current = excluded.current, ended = excluded.ended, has_pending = excluded.has_pending').run(p, l.id, l.ruleset, l.current, l.ended ? 1 : 0, l.pending ? 1 : 0)
      this.w.prepare('DELETE FROM workflow_lane_cards WHERE project = ? AND lane = ?').run(p, l.id)
      const ins = this.w.prepare('INSERT INTO workflow_lane_cards (project, lane, list, ord, card) VALUES (?, ?, ?, ?, ?)')
      l.cards.forEach((c, i) => ins.run(p, l.id, 'cards', i, c))
      l.pending?.forEach((c, i) => ins.run(p, l.id, 'pending', i, c))
    })
  }

  queuePause(target: string): QueuePause | null {
    const p = this.scope.project
    const row = this.w.prepare('SELECT reason, card FROM workflow_queue_pauses WHERE project = ? AND target = ?').get(p, target) as { reason: string; card: string } | undefined
    if (!row) return null
    const files = (this.w.prepare('SELECT path FROM workflow_queue_pause_files WHERE project = ? AND target = ? ORDER BY ord').all(p, target) as { path: string }[]).map((r) => r.path)
    return { reason: row.reason, card: row.card, ...(files.length ? { files } : {}) }
  }

  /** Pauses a target's queue (`pause`), or resumes it (null). */
  setQueuePause(target: string, pause: QueuePause | null): void {
    const p = this.scope.project
    this.tx(() => {
      this.w.prepare('DELETE FROM workflow_queue_pauses WHERE project = ? AND target = ?').run(p, target)
      if (!pause) return
      this.w.prepare('INSERT INTO workflow_queue_pauses (project, target, reason, card) VALUES (?, ?, ?, ?)').run(p, target, pause.reason, pause.card)
      const ins = this.w.prepare('INSERT INTO workflow_queue_pause_files (project, target, ord, path) VALUES (?, ?, ?, ?)')
      pause.files?.forEach((f, i) => ins.run(p, target, i, f))
    })
  }

  /** One of this project's values (a scalar: a line's last head seen, a folder's installed manifests' hash). */
  meta(key: string): string | null {
    return (this.w.prepare('SELECT value FROM board_meta WHERE key = ?').get(this.metaKey(key)) as { value: string } | undefined)?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.w.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(this.metaKey(key), value)
  }

  private metaKey(key: string): string {
    return `workflow:${this.scope.project.toLowerCase()}:${key}`
  }

  // --- Writes.

  /**
   * One transaction: everything `fn` writes commits together or not at all. Inside the connection's transaction (the
   * caller's boardWrite) it is part of that one, committed or undone with the card change it belongs to; else its own
   * (BEGIN IMMEDIATE, so two Hives' writes are one after the other).
   */
  tx<T>(fn: (tx: Tx) => T): T {
    const w = this.w
    const at = (): string => this.now().toISOString()
    const nextSeq = (card: number): number => ((w.prepare('SELECT MAX(seq) AS m FROM card_facts WHERE card = ?').get(card) as { m: number | null }).m ?? 0) + 1
    const insert = <K extends FactKind>(card: number, f: NewFact<K> & { dedupe?: string }): Fact<K> => {
      const seq = nextSeq(card)
      const full = { ...f, seq, card, at: at() } as Fact<K>
      w.prepare('INSERT INTO card_facts (card, seq, kind, at, actor, source, ruleset, dedupe, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(card, seq, f.kind, full.at, f.actor, f.source, f.ruleset ?? null, f.dedupe ?? null, JSON.stringify(f.data))
      return full
    }
    const tx: Tx = {
      append: (card, f) => insert(card, f),
      appendObserved: (card, f) => {
        const exists = w.prepare('SELECT 1 FROM card_facts WHERE card = ? AND kind = ? AND dedupe = ?').get(card, f.kind, f.dedupe)
        return exists ? null : insert(card, { ...f, source: 'observed' })
      },
      setStage: (card, stage) => {
        // The stage cache, and the card's column its category (SPEC §16.4.3): the board shows where the fold put it.
        w.prepare('UPDATE cards SET stage = ?, col = ? WHERE number = ?').run(stage, STAGE_CATEGORY[stage], card)
      },
      action: (card, kind, payload, fact) => Number(w.prepare('INSERT INTO card_actions (card, kind, payload, fact) VALUES (?, ?, ?, ?)').run(card, kind, JSON.stringify(payload), fact).lastInsertRowid),
      facts: (card) => this.facts(card),
      card: (id) => this.card(id),
      putCard: (c) => {
        const { id, key: _k, stage: _s, category: _c, ...patch } = c
        this.updateCard(id, patch)
      },
      meta: (k) => this.meta(k),
      setMeta: (k, v) => this.setMeta(k, v),
      recordFolderCommit: (folder, sha, card, how) => this.recordFolderCommit(folder, sha, card, how)
    }
    return w.isTransaction ? fn(tx) : transaction(w, () => fn(tx))
  }
}

function factOf(r: Record<string, string | number | null>): Fact {
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

/** Records an action's delivery once (the conditional update is the guard): false when it was already delivered. */
export function deliverOnce(w: DatabaseSync, d: Delivery): boolean {
  const { action, ...rest } = d
  return Number(w.prepare('UPDATE card_actions SET delivered = ? WHERE id = ? AND delivered IS NULL').run(JSON.stringify(rest), action).changes) > 0
}

/** Every pending action of the workspace, in the order written (the actions worker's list). */
export function pendingActionsOf(db: DatabaseSync): ActionRow[] {
  return (db.prepare("SELECT * FROM card_actions WHERE state = 'pending' ORDER BY id").all() as Record<string, string | number | null>[]).map(actionOf)
}
