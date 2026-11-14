// jj's durable publish obligations and retained bundles (HI-2882's J9b2, design HI-2882/s10–s22), on the workspace
// database's tables (schema/jjPublishStep.ts), every row and query scoped by the project's canonical id. Pure SQL on a
// connection it is given: no Electron, no logger, so the publish worker (jjPublishWorker.ts) runs it inside its own
// transaction, and main reads it (bounded, indexed reads only) and writes its rows in the Integrated transaction.
//
// `sqlObligations` is HI-2873's ObligationStore: every change one compare-and-set statement (its conditions in SQL), its
// answer whether it changed (a single row's `changes`); owed rows read whole (never truncated), settled history only
// through `recheckPage`'s indexed, limited page.

import type { JjBundle, JjObligation, ObligationKey, ObligationStore, PublishCheck, PublishSeen, RecheckSweep } from './jjIntegration'

/** The SQL a store needs of a connection (node:sqlite's DatabaseSync, or the board's own). */
export interface SqlDb {
  prepare(sql: string): { run(...a: unknown[]): { changes: number | bigint }; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
}

type Row = { card: string; cycle: number; bundle: string; target: string; result: string; since: number; state: JjObligation['state']; pushed: string | null; at: number | null; seq: number | null; seen: string | null; check: string | null }

const parse = <T>(s: string | null): T | undefined => {
  if (s === null) return undefined
  try {
    return JSON.parse(s) as T
  } catch {
    return undefined
  }
}

const rowOf = (r: Row): JjObligation => ({
  card: r.card,
  cycle: r.cycle,
  bundle: r.bundle,
  target: r.target,
  result: r.result,
  since: r.since,
  state: r.state,
  ...(r.pushed !== null ? { pushed: r.pushed } : {}),
  ...(r.at !== null ? { at: r.at } : {}),
  ...(r.seq !== null ? { seq: r.seq } : {}),
  ...(r.seen !== null && parse<PublishSeen>(r.seen) ? { seen: parse<PublishSeen>(r.seen)! } : {}),
  ...(r.check !== null && parse<PublishCheck>(r.check) ? { check: parse<PublishCheck>(r.check)! } : {})
})

const COLS = 'card, cycle, bundle, target, result, since, state, pushed, at, seq, seen, "check"' // i18n-ignore: SQL

/** HI-2873's store on the project's rows of `db` (see the module's comment). */
export function sqlObligations(db: SqlDb, project: string): ObligationStore {
  const one = (r: { changes: number | bigint }): boolean => Number(r.changes) === 1
  const targetRow = (target: string): { seq: number; gen: number; after: number; end: number } | null =>
    (db.prepare('SELECT seq, gen, after, "end" FROM jj_oblig_targets WHERE project = ? AND target = ?').get(project, target) as { seq: number; gen: number; after: number; end: number } | undefined) ?? null // i18n-ignore: SQL
  const ensureTarget = (target: string): void => void db.prepare('INSERT INTO jj_oblig_targets (project, target) VALUES (?, ?) ON CONFLICT (project, target) DO NOTHING').run(project, target) // i18n-ignore: SQL
  return {
    list: (target) => (db.prepare(`SELECT ${COLS} FROM jj_obligations WHERE project = ? AND target = ? ORDER BY since`).all(project, target) as Row[]).map(rowOf), // i18n-ignore: SQL
    owed: (target) => (db.prepare(`SELECT ${COLS} FROM jj_obligations WHERE project = ? AND target = ? AND state = 'owed'`).all(project, target) as Row[]).map(rowOf), // i18n-ignore: SQL
    create: (o) => one(db.prepare("INSERT INTO jj_obligations (project, card, cycle, bundle, target, result, since, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'owed') ON CONFLICT (project, card, cycle, bundle) DO NOTHING").run(project, o.card, o.cycle, o.bundle, o.target, o.result, o.since)), // i18n-ignore: SQL
    settle: (k: ObligationKey, result, to, seen) => {
      const row = db.prepare("SELECT target FROM jj_obligations WHERE project = ? AND card = ? AND cycle = ? AND bundle = ? AND result = ? AND state = 'owed'").get(project, k.card, k.cycle, k.bundle, result) as { target: string } | undefined // i18n-ignore: SQL
      if (!row) return false
      const seq = (targetRow(row.target)?.seq ?? 0) + 1
      const ok = one(db.prepare("UPDATE jj_obligations SET state = ?, at = ?, seq = ?, seen = ?, pushed = ? WHERE project = ? AND card = ? AND cycle = ? AND bundle = ? AND result = ? AND state = 'owed'").run(to, seen.at, seq, JSON.stringify(seen), to === 'published' ? seen.pushed : null, project, k.card, k.cycle, k.bundle, result)) // i18n-ignore: SQL
      if (!ok) return false
      ensureTarget(row.target)
      db.prepare('UPDATE jj_oblig_targets SET seq = ? WHERE project = ? AND target = ?').run(seq, project, row.target) // i18n-ignore: SQL
      return true
    },
    flag: (k, result, from, recordedAt, check) => one(db.prepare("UPDATE jj_obligations SET state = 'checkThis', \"check\" = ? WHERE project = ? AND card = ? AND cycle = ? AND bundle = ? AND result = ? AND state = ? AND at = ?").run(JSON.stringify(check), project, k.card, k.cycle, k.bundle, result, from, recordedAt)), // i18n-ignore: SQL
    recheckPage: (target, after, end, limit) => (db.prepare(`SELECT ${COLS} FROM jj_obligations WHERE project = ? AND target = ? AND state IN ('published', 'notHeld') AND seen IS NOT NULL AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`).all(project, target, after, end, limit) as Row[]).map(rowOf), // i18n-ignore: SQL
    maxSeq: (target) => targetRow(target)?.seq ?? 0,
    getSweep: (target) => {
      const t = targetRow(target)
      return t && t.gen > 0 ? { gen: t.gen, after: t.after, end: t.end } : null
    },
    setSweep: (target, expectedGen, next: RecheckSweep) => {
      if (next.gen <= expectedGen) return false
      ensureTarget(target)
      return one(db.prepare('UPDATE jj_oblig_targets SET gen = ?, after = ?, "end" = ? WHERE project = ? AND target = ? AND gen = ?').run(next.gen, next.after, next.end, project, target, expectedGen)) // i18n-ignore: SQL
    }
  }
}

/** The targets of the project with owed rows or settled rows to re-check (the publish pass's targets): one indexed read. */
export function publishTargets(db: SqlDb, project: string): string[] {
  return (db.prepare("SELECT DISTINCT target FROM jj_obligations WHERE project = ? AND state IN ('owed', 'published', 'notHeld')").all(project) as { target: string }[]).map((r) => r.target) // i18n-ignore: SQL
}

/** An Integrated jj card's records, written in its Integrated transaction: its obligation (owed) and its retained bundle. */
export function recordIntegration(db: SqlDb, project: string, o: { card: string; cycle: number; bundle: string; target: string; result: string; since: number }): void {
  db.prepare("INSERT INTO jj_obligations (project, card, cycle, bundle, target, result, since, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'owed') ON CONFLICT (project, card, cycle, bundle) DO NOTHING").run(project, o.card, o.cycle, o.bundle, o.target, o.result, o.since) // i18n-ignore: SQL
  db.prepare('INSERT INTO jj_retained (project, card, cycle, bundle, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, card, cycle, bundle) DO NOTHING').run(project, o.card, o.cycle, o.bundle, o.since) // i18n-ignore: SQL
}

/** A retained bundle's row, as the retention pass reads it. */
export interface RetainedRow {
  card: string
  cycle: number
  bundle: string
  checkedAt: number
  outcome: string | null
}

/**
 * The retention pass's page (HI-2882/s13 §2): the project's due rows (`checked_at` 0, marked by an invalidation or new,
 * or older than `every`), oldest first, at most `limit`, from the index; and whether more are due after them.
 */
export function dueRetained(db: SqlDb, project: string, now: number, every: number, limit: number): { rows: RetainedRow[]; more: boolean } {
  const rows = db.prepare('SELECT card, cycle, bundle, checked_at AS checkedAt, outcome FROM jj_retained WHERE project = ? AND (checked_at = 0 OR checked_at <= ?) ORDER BY checked_at, card, cycle, bundle LIMIT ?').all(project, now - every, limit + 1) as RetainedRow[] // i18n-ignore: SQL
  return { rows: rows.slice(0, limit), more: rows.length > limit }
}

/** Whether any of the project's retained rows is due (one indexed read: the minute tick's). */
export function anyRetainedDue(db: SqlDb, project: string, now: number, every: number): boolean {
  return !!db.prepare('SELECT 1 AS one FROM jj_retained WHERE project = ? AND (checked_at = 0 OR checked_at <= ?) LIMIT 1').get(project, now - every) // i18n-ignore: SQL
}

/** A visit recorded, whatever its outcome: the row to the back (`checked_at` now), its outcome kept for the window. */
export function retainedVisited(db: SqlDb, project: string, r: { card: string; cycle: number; bundle: string }, at: number, outcome: string): void {
  db.prepare('UPDATE jj_retained SET checked_at = ?, outcome = ? WHERE project = ? AND card = ? AND cycle = ? AND bundle = ?').run(Math.max(1, at), outcome, project, r.card, r.cycle, r.bundle) // i18n-ignore: SQL
}

/** Rows marked due by an invalidation: one bundle's (a change under its pins), or all the project's (null: packed refs). */
export function markRetainedDue(db: SqlDb, project: string, r: { card: string; cycle: number; bundle: string } | null): void {
  if (r) db.prepare('UPDATE jj_retained SET checked_at = 0 WHERE project = ? AND card = ? AND cycle = ? AND bundle = ?').run(project, r.card, r.cycle, r.bundle) // i18n-ignore: SQL
  else db.prepare('UPDATE jj_retained SET checked_at = 0 WHERE project = ?').run(project) // i18n-ignore: SQL
}

/**
 * A card and cycle's journalled bundles merged with a newer write (HR1's round 1): each bundle kept by its id, a bundle
 * another observer journalled never erased by a write made from an older snapshot; for one id, its pins merged by ref,
 * the incoming state taken unless it is only an `intent` the stored one has gone past. Run inside the journal's write.
 */
export function mergeBundles(stored: readonly JjBundle[], incoming: readonly JjBundle[]): JjBundle[] {
  const out = new Map<string, JjBundle>(stored.map((b) => [b.bundle, structuredClone(b)]))
  for (const b of incoming) {
    const had = out.get(b.bundle)
    if (!had) {
      out.set(b.bundle, structuredClone(b))
      continue
    }
    const pins = new Map(had.pins.map((p) => [p.ref, p]))
    for (const p of b.pins) {
      const old = pins.get(p.ref)
      pins.set(p.ref, old && p.state === 'intent' && old.state !== 'intent' ? old : { ...p })
    }
    out.set(b.bundle, { ...had, endpoints: { ...b.endpoints }, pins: [...pins.values()] })
  }
  return [...out.values()]
}
