import type { DatabaseSync } from 'node:sqlite'
import { LANE_RECORD_ADD, LANE_RECORD_DROP, V1_0_STEPS } from './v1_0'
import { LOOP_ROUNDS, LOOP_WAIT_HOURS } from '../../shared/lanes'

/**
 * One lane record (#1291): the 1.0 group's step that retires the runtime's own lane tables (`workflow_lanes`,
 * `workflow_lane_cards`) and a card's `lane`/`lane_reviewer` columns into lanes.ts's (`lanes`, `lane_cards`) and what the
 * runtime keeps beside them (`lane_runs`, `lane_pending`), all in the caller's transaction (the group's).
 *
 * A runtime lane whose id lanes.ts has keeps lanes.ts's row: only what the runtime kept is added. One it hasn't becomes
 * a lane of its own, by Hive (no agent registered it: lanes.ts's builder fields need one), with its project's cards and
 * state, its reviewer the one its cards named; one with no cards is left out (lanes.ts keeps no lane without cards). An
 * id another project's lane holds gets a suffix. A card's lane is read from the lanes' lists from now on: its columns
 * go, and a reviewer named on a card with no lane (nothing in the app sets one) with them.
 */

export const LANE_RECORD_STEP = V1_0_STEPS.find((s) => s.name === 'one lane record')!

/** What the step moved, for the log. */
export interface LanesMoved {
  lanes: number
  added: number
  dropped: number
}

/** Moves the runtime's lanes into lanes.ts's tables and drops its own (the step's whole work). */
export function moveLaneRecords(db: DatabaseSync, now = new Date().toISOString()): LanesMoved {
  for (const sql of LANE_RECORD_ADD) db.exec(sql)
  const out: LanesMoved = { lanes: 0, added: 0, dropped: 0 }
  const lanes = db.prepare('SELECT project, id, ruleset, current, ended, has_pending FROM workflow_lanes ORDER BY project, id').all() as { project: string; id: string; ruleset: string; current: number | null; ended: number; has_pending: number }[] // i18n-ignore: SQL
  const listOf = db.prepare('SELECT card FROM workflow_lane_cards WHERE project = ? AND lane = ? AND list = ? ORDER BY ord') // i18n-ignore: SQL
  const reviewerOf = db.prepare('SELECT lane_reviewer FROM cards WHERE project = ? COLLATE NOCASE AND lane = ? AND lane_reviewer IS NOT NULL ORDER BY number LIMIT 1') // i18n-ignore: SQL
  const has = db.prepare('SELECT project, reviewer_id FROM lanes WHERE id = ?') // i18n-ignore: SQL
  const nextOrd = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM lanes') // i18n-ignore: SQL
  for (const l of lanes) {
    const cards = (listOf.all(l.project, l.id, 'cards') as { card: number }[]).map((r) => r.card)
    const pending = (listOf.all(l.project, l.id, 'pending') as { card: number }[]).map((r) => r.card)
    const reviewer = (reviewerOf.get(l.project, l.id) as { lane_reviewer: string } | undefined)?.lane_reviewer ?? null
    let id = l.id
    let row = has.get(id) as { project: string; reviewer_id: string | null } | undefined
    for (let n = 2; row && row.project.toLowerCase() !== l.project.toLowerCase(); n++) row = has.get((id = `${l.id}-${n}`)) as typeof row
    if (!row) {
      if (!cards.length) {
        out.dropped++
        continue
      }
      const ord = (nextOrd.get() as { n: number }).n
      db.prepare(`INSERT INTO lanes (id, ord, project, project_id, name, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at, ended_at, merge_commit, extra)
        VALUES (?, ?, ?, NULL, NULL, 'hive', 'Hive', ?, ?, ?, ?, ?, 'Hive', ?, ?, ?, NULL, NULL)`).run(id, ord, l.project, reviewer, reviewer, LOOP_ROUNDS, LOOP_WAIT_HOURS * 60, l.ended ? 'ended' : 'active', now, now, l.ended ? now : null) // i18n-ignore: SQL
      const ins = db.prepare('INSERT INTO lane_cards (lane, ord, card) VALUES (?, ?, ?)') // i18n-ignore: SQL
      cards.forEach((c, i) => ins.run(id, i, c))
      out.added++
    } else if (reviewer && row.reviewer_id === null) {
      db.prepare('UPDATE lanes SET reviewer_id = ?, reviewer_name = ? WHERE id = ?').run(reviewer, reviewer, id) // i18n-ignore: SQL
    }
    db.prepare('INSERT INTO lane_runs (lane, ruleset, current_card, has_pending) VALUES (?, ?, ?, ?)').run(id, l.ruleset, l.current, l.has_pending ? 1 : 0) // i18n-ignore: SQL
    const ins = db.prepare('INSERT INTO lane_pending (lane, ord, card) VALUES (?, ?, ?)') // i18n-ignore: SQL
    if (l.has_pending) pending.forEach((c, i) => ins.run(id, i, c))
    out.lanes++
  }
  for (const sql of LANE_RECORD_DROP) db.exec(sql)
  return out
}
