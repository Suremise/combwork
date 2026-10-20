// The fact log's store (SPEC §16.4.1, §16.4.5): facts, the card's stage cache and the durable actions they cause, written
// in one transaction, so a fact and the move it caused can't diverge and nothing outside happens for a write that
// rolled back. Observed facts carry a dedupe key, unique per card and kind, so two Hives observing one workspace write
// each transition once (§16.17).
//
// P2 spike (#1118): a database file of its own with the tables P3's migration adds to hive.db (`card_facts`,
// `card_actions`, `rulesets`), and a minimal card table standing in for the board's. Not wired into the app.

import { openDb, transaction, type Db, type Migration } from '../db'
import type { Actor, CardKind, Category, Fact, FactKind, NewFact, StageId } from '../../shared/workflow/facts'
import { STAGE_CATEGORY } from '../../shared/workflow/facts'
import type { Ruleset } from '../../shared/workflow/compile'
import { loadRuleset } from '../../shared/workflow/compile'

/** What the spike needs of a card (the board's card stands in for it from P3). */
export interface CardRecord {
  id: number
  key: string
  title: string
  kind: CardKind
  labels: string[]
  blockedBy: number[]
  /** A per-card target (OP-12). */
  target?: string
  /** None: the card's declared paths (§16.3.3). */
  paths?: string[]
  /** The lane it is in, whose ruleset it uses (§16.11.1). */
  lane?: string
  /** The reviewer agent to wake (a lane's), else the pool. */
  reviewer?: string
  /** A card from before 1.0 (§16.4.1). */
  preWorkflow?: boolean
  stage: StageId
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

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'workflow spike',
    up: (db) => {
      db.exec('CREATE TABLE wf_cards (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL, stage TEXT NOT NULL, category TEXT NOT NULL) STRICT')
      db.exec('CREATE TABLE card_facts (card INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL, ruleset TEXT, dedupe TEXT, data TEXT NOT NULL, PRIMARY KEY (card, seq)) STRICT')
      db.exec('CREATE UNIQUE INDEX card_facts_dedupe ON card_facts (card, kind, dedupe) WHERE dedupe IS NOT NULL')
      db.exec("CREATE TABLE card_actions (id INTEGER PRIMARY KEY, card INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, fact INTEGER) STRICT")
      db.exec('CREATE TABLE rulesets (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT')
      db.exec('CREATE TABLE deliveries (action INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL) STRICT')
      db.exec('CREATE TABLE folder_commits (folder TEXT NOT NULL, sha TEXT NOT NULL, card INTEGER, how TEXT NOT NULL, PRIMARY KEY (folder, sha)) STRICT')
      db.exec('CREATE TABLE wf_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    }
  }
]

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

export class FactStore {
  readonly db: Db
  private now: () => Date

  constructor(file: string, opts: { now?: () => Date } = {}) {
    this.db = openDb(file, { migrations: MIGRATIONS, hiveVersion: 'spike' })
    this.now = opts.now ?? (() => new Date())
  }

  close(): void {
    this.db.close()
  }

  // --- Reads (the writer connection: the spike reads its own writes at once).

  card(id: number): CardRecord {
    const row = this.db.writer.prepare('SELECT data, stage, category FROM wf_cards WHERE id = ?').get(id) as { data: string; stage: StageId; category: Category } | undefined
    if (!row) throw new Error(`no card ${id}`) // i18n-ignore: a programming error in the spike, never shown
    return { ...JSON.parse(row.data), id, stage: row.stage, category: row.category }
  }

  cardByKey(key: string): CardRecord | null {
    const row = this.db.writer.prepare('SELECT id FROM wf_cards WHERE key = ?').get(key) as { id: number } | undefined
    return row ? this.card(row.id) : null
  }

  cards(): CardRecord[] {
    return (this.db.writer.prepare('SELECT id FROM wf_cards ORDER BY id').all() as { id: number }[]).map((r) => this.card(r.id))
  }

  facts(card: number): Fact[] {
    const rows = this.db.writer.prepare('SELECT * FROM card_facts WHERE card = ? ORDER BY seq').all(card) as Record<string, string | number | null>[]
    return rows.map((r) => ({
      seq: r.seq as number,
      card: r.card as number,
      kind: r.kind as FactKind,
      at: r.at as string,
      actor: r.actor as Actor,
      source: r.source as 'recorded' | 'observed',
      ...(r.ruleset ? { ruleset: r.ruleset as string } : {}),
      ...(r.dedupe ? { dedupe: r.dedupe as string } : {}),
      data: JSON.parse(r.data as string)
    }))
  }

  /** Every fact of a kind across cards, in the order written (the queue's order). */
  factsOfKind(kind: FactKind): Fact[] {
    const ids = this.db.writer.prepare('SELECT card, seq FROM card_facts WHERE kind = ? ORDER BY rowid').all(kind) as { card: number; seq: number }[]
    return ids.map((r) => this.facts(r.card).find((f) => f.seq === r.seq)!)
  }

  ruleset(id: string): Ruleset {
    const row = this.db.writer.prepare('SELECT data FROM rulesets WHERE id = ?').get(id) as { data: string } | undefined
    if (!row) throw new Error(`no ruleset ${id}`) // i18n-ignore: a programming error in the spike, never shown
    const r = loadRuleset(JSON.parse(row.data))
    if (!r.ok) throw new Error(`ruleset ${id}: ${r.error} ${r.piece ?? ''}`) // i18n-ignore: a programming error in the spike, never shown
    return r.ruleset
  }

  saveRuleset(r: Ruleset): void {
    this.db.writer.prepare('INSERT OR IGNORE INTO rulesets (id, data) VALUES (?, ?)').run(r.id, JSON.stringify(r))
  }

  pendingActions(): ActionRow[] {
    return (this.db.writer.prepare("SELECT * FROM card_actions WHERE state = 'pending' ORDER BY id").all() as Record<string, string | number | null>[]).map((r) => ({
      id: r.id as number,
      card: r.card as number,
      kind: r.kind as string,
      payload: JSON.parse(r.payload as string),
      state: r.state as ActionRow['state'],
      attempts: r.attempts as number,
      fact: r.fact as number | null
    }))
  }

  markAction(id: number, state: ActionRow['state']): void {
    this.db.writer.prepare('UPDATE card_actions SET state = ?, attempts = attempts + 1 WHERE id = ?').run(state, id)
  }

  /** Records a delivery once per action: false when it was already delivered (an action run twice, §16.4.5). */
  deliver(d: Delivery): boolean {
    const r = this.db.writer.prepare('INSERT OR IGNORE INTO deliveries (action, kind, target, payload) VALUES (?, ?, ?, ?)').run(d.action, d.kind, d.target, JSON.stringify(d.payload))
    return Number(r.changes) > 0
  }

  deliveries(): Delivery[] {
    return (this.db.writer.prepare('SELECT * FROM deliveries ORDER BY action').all() as Record<string, string | number>[]).map((r) => ({ action: r.action as number, kind: r.kind as string, target: r.target as string, payload: JSON.parse(r.payload as string) }))
  }

  folderCommits(folder: string): { sha: string; card: number | null; how: string }[] {
    return this.db.writer.prepare('SELECT sha, card, how FROM folder_commits WHERE folder = ? ORDER BY rowid').all(folder) as { sha: string; card: number | null; how: string }[]
  }

  recordFolderCommit(folder: string, sha: string, card: number | null, how: string): boolean {
    return Number(this.db.writer.prepare('INSERT OR IGNORE INTO folder_commits (folder, sha, card, how) VALUES (?, ?, ?, ?)').run(folder, sha, card, how).changes) > 0
  }

  meta(key: string): string | null {
    return (this.db.writer.prepare('SELECT value FROM wf_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.writer.prepare('INSERT INTO wf_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  createCard(c: Omit<CardRecord, 'id' | 'stage' | 'category'> & { stage?: StageId }): CardRecord {
    const stage = c.stage ?? 'todo'
    const { stage: _s, ...data } = c
    const r = this.db.writer.prepare('INSERT INTO wf_cards (key, data, stage, category) VALUES (?, ?, ?, ?)').run(c.key, JSON.stringify(data), stage, STAGE_CATEGORY[stage])
    return this.card(Number(r.lastInsertRowid))
  }

  updateCard(id: number, patch: Partial<Omit<CardRecord, 'id' | 'stage' | 'category'>>): CardRecord {
    const { id: _id, stage: _st, category: _c, ...data } = { ...this.card(id), ...patch }
    this.db.writer.prepare('UPDATE wf_cards SET data = ? WHERE id = ?').run(JSON.stringify(data), id)
    return this.card(id)
  }

  /** One transaction (BEGIN IMMEDIATE): everything `fn` writes commits together or not at all. */
  tx<T>(fn: (tx: Tx) => T): T {
    const w = this.db.writer
    const at = () => this.now().toISOString()
    const nextSeq = (card: number) => ((w.prepare('SELECT MAX(seq) AS m FROM card_facts WHERE card = ?').get(card) as { m: number | null }).m ?? 0) + 1
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
        w.prepare('UPDATE wf_cards SET stage = ?, category = ? WHERE id = ?').run(stage, STAGE_CATEGORY[stage], card)
      },
      action: (card, kind, payload, fact) => Number(w.prepare('INSERT INTO card_actions (card, kind, payload, fact) VALUES (?, ?, ?, ?)').run(card, kind, JSON.stringify(payload), fact).lastInsertRowid),
      facts: (card) => this.facts(card),
      card: (id) => this.card(id),
      putCard: (c) => {
        this.updateCard(c.id, c)
      },
      meta: (k) => this.meta(k),
      setMeta: (k, v) => this.setMeta(k, v),
      recordFolderCommit: (folder, sha, card, how) => this.recordFolderCommit(folder, sha, card, how)
    }
    return transaction(w, () => fn(tx))
  }
}
