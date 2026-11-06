import type { DatabaseSync } from 'node:sqlite'
import { LANE_RECORD_ADD, LANE_RECORD_DROP, V1_0_STEPS } from './v1_0'
import { LOOP_ROUNDS, LOOP_WAIT_HOURS } from '../../shared/lanes'

/**
 * One lane record (#1291): the 1.0 group's step that retires the runtime's own lane tables (`workflow_lanes`,
 * `workflow_lane_cards`) and a card's `lane`/`lane_reviewer` columns into lanes.ts's (`lanes`, `lane_cards`) and what the
 * runtime keeps beside them (`lane_runs`, `lane_pending`), all in the caller's transaction (the group's).
 *
 * Nothing a runtime lane holds is lost. It joins lanes.ts's lane of its id only when that lane is the same one: of its
 * project, with the same cards in the same order, running or ended alike; only what the runtime kept is added (and its
 * cards' reviewer, if lanes.ts's lane has none). Any other becomes a lane of its own, by the app itself (no agent registered it:
 * lanes.ts's builder fields need one), with its cards, state and its cards' reviewer, under its own id if no lane has it
 * and no other runtime lane keeps it, else the first `<id>-<n>` that no lane, runtime lane or id given before has.
 * lanes.ts keeps no lane without cards: one whose list is empty takes its queued list as its cards (its next card
 * boundary applies it anyway), and one with neither is left out. A card's lane is read from the lanes' lists from now
 * on: its columns go, and a reviewer named on a card with no lane (nothing in the app sets one) with them.
 */

export const LANE_RECORD_STEP = V1_0_STEPS.find((s) => s.name === 'one lane record')!

/** What the step moved, for the log. */
export interface LanesMoved {
  lanes: number
  added: number
  dropped: number
}

interface Source {
  project: string
  id: string
  ruleset: string
  current: number | null
  ended: boolean
  pending: number[] | null
  cards: number[]
  reviewer: string | null
}

const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((c, i) => c === b[i])

/**
 * Moves the runtime's lanes into lanes.ts's tables and drops its own (the step's whole work). Its code is the released
 * 1.0.0's (combworkMove10.test.ts holds it there): the lanes it adds are by 1.0's own name, which the names upgrade's values
 * step (valuesStep.ts) makes Combwork's. A new board has no runtime lanes, so it adds none (HI-2611): nothing of 1.0's.
 */
export function moveLaneRecords(db: DatabaseSync, now = new Date().toISOString()): LanesMoved {
  for (const sql of LANE_RECORD_ADD) db.exec(sql)
  const out: LanesMoved = { lanes: 0, added: 0, dropped: 0 }
  const listOf = db.prepare('SELECT card FROM workflow_lane_cards WHERE project = ? AND lane = ? AND list = ? ORDER BY ord') // i18n-ignore: SQL
  const reviewerOf = db.prepare('SELECT lane_reviewer FROM cards WHERE project = ? COLLATE NOCASE AND lane = ? AND lane_reviewer IS NOT NULL ORDER BY number LIMIT 1') // i18n-ignore: SQL
  const rows = db.prepare('SELECT project, id, ruleset, current, ended, has_pending FROM workflow_lanes ORDER BY project, id').all() as { project: string; id: string; ruleset: string; current: number | null; ended: number; has_pending: number }[] // i18n-ignore: SQL
  const sources: Source[] = []
  for (const r of rows) {
    const pending = r.has_pending ? (listOf.all(r.project, r.id, 'pending') as { card: number }[]).map((x) => x.card) : null
    let cards = (listOf.all(r.project, r.id, 'cards') as { card: number }[]).map((x) => x.card)
    if (!cards.length && pending?.length) cards = [...pending]
    if (!cards.length) {
      out.dropped++
      continue
    }
    sources.push({ project: r.project, id: r.id, ruleset: r.ruleset, current: r.current, ended: r.ended === 1, pending, cards, reviewer: (reviewerOf.get(r.project, r.id) as { lane_reviewer: string } | undefined)?.lane_reviewer ?? null })
  }

  // Each source's lane: lanes.ts's own when it is the same lane, else its id or a free one.
  const existing = new Map((db.prepare('SELECT id, project, state FROM lanes').all() as { id: string; project: string; state: string }[]).map((l) => [l.id, l])) // i18n-ignore: SQL
  const cardsOf = db.prepare('SELECT card FROM lane_cards WHERE lane = ? ORDER BY ord') // i18n-ignore: SQL
  const sourceIds = new Set(sources.map((s) => s.id))
  const given = new Set<string>()
  const dest = new Map<Source, { id: string; join: boolean }>()
  for (const s of sources) {
    const l = existing.get(s.id)
    if (l && l.project.toLowerCase() === s.project.toLowerCase() && (l.state !== 'active') === s.ended && same((cardsOf.all(s.id) as { card: number }[]).map((x) => x.card), s.cards) && !given.has(s.id)) {
      dest.set(s, { id: s.id, join: true })
      given.add(s.id)
    } else if (!l && !given.has(s.id)) {
      dest.set(s, { id: s.id, join: false })
      given.add(s.id)
    }
  }
  for (const s of sources) {
    if (dest.has(s)) continue
    let n = 2
    while (existing.has(`${s.id}-${n}`) || sourceIds.has(`${s.id}-${n}`) || given.has(`${s.id}-${n}`)) n++
    dest.set(s, { id: `${s.id}-${n}`, join: false })
    given.add(`${s.id}-${n}`)
  }

  let ord = (db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM lanes').get() as { n: number }).n // i18n-ignore: SQL
  const insCard = db.prepare('INSERT INTO lane_cards (lane, ord, card) VALUES (?, ?, ?)') // i18n-ignore: SQL
  const insPending = db.prepare('INSERT INTO lane_pending (lane, ord, card) VALUES (?, ?, ?)') // i18n-ignore: SQL
  for (const s of sources) {
    const { id, join } = dest.get(s)!
    if (join) {
      if (s.reviewer) db.prepare('UPDATE lanes SET reviewer_id = ?, reviewer_name = ? WHERE id = ? AND reviewer_id IS NULL').run(s.reviewer, s.reviewer, id) // i18n-ignore: SQL
    } else {
      // old-name: begin lanes-10-values
      db.prepare(`INSERT INTO lanes (id, ord, project, project_id, name, builder_id, builder_name, reviewer_id, reviewer_name, rounds, wait_minutes, state, started_by, started_at, updated_at, ended_at, merge_commit, extra)
        VALUES (?, ?, ?, NULL, NULL, 'hive', 'Hive', ?, ?, ?, ?, ?, 'Hive', ?, ?, ?, NULL, NULL)`).run(id, ord++, s.project, s.reviewer, s.reviewer, LOOP_ROUNDS, LOOP_WAIT_HOURS * 60, s.ended ? 'ended' : 'active', now, now, s.ended ? now : null) // i18n-ignore: SQL
      // old-name: end lanes-10-values
      s.cards.forEach((c, i) => insCard.run(id, i, c))
      out.added++
    }
    db.prepare('INSERT INTO lane_runs (lane, ruleset, current_card, has_pending) VALUES (?, ?, ?, ?)').run(id, s.ruleset, s.current, s.pending ? 1 : 0) // i18n-ignore: SQL
    s.pending?.forEach((c, i) => insPending.run(id, i, c))
    out.lanes++
  }
  for (const sql of LANE_RECORD_DROP) db.exec(sql)
  return out
}
