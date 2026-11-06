import type { DatabaseSync } from 'node:sqlite'
import { V1_0_STEPS } from './v1_0'
import { cardKey, normalKey, suggestKey, type KeyHeld } from '../../shared/projectKeys'

/**
 * Project keys and per-project numbers in combwork.db (#1219, #704; SPEC §16.12). The tables are #1208's (v1_0.ts, the
 * "project keys" step); this module is every query on them, for the 1.0 step and for the board (boardStore.ts), all on a
 * connection the caller holds (inside its transaction).
 *
 * Darren, 20 Oct (#1119): an existing card keeps its number in its own project (#1061 is HI-1061), and each project's
 * counter carries on from its highest. A card's global number stays its id (`#N`, what the tools take until P8) and a
 * permanent alias. A card moved to another project takes that project's next number there, its old one kept as an alias
 * (`card_aliases`); a key changed keeps the old one as an alias (`project_keys`, current 0).
 */

export const KEYS_STEP = V1_0_STEPS.find((s) => s.name === 'project keys')!

type Sql = DatabaseSync

/** Every key held, current and old, with its project. */
export function keysHeld(db: Sql): (KeyHeld & { current: boolean })[] {
  return (db.prepare('SELECT key, project_id, current FROM project_keys').all() as { key: string; project_id: string; current: number }[]).map((r) => ({ key: r.key, projectId: r.project_id, current: r.current === 1 })) // i18n-ignore: SQL
}

/** Each project's current key, by its id. */
export function currentKeys(db: Sql): Map<string, string> {
  return new Map((db.prepare('SELECT project_id, key FROM project_keys WHERE current = 1').all() as { project_id: string; key: string }[]).map((r) => [r.project_id, r.key])) // i18n-ignore: SQL
}

/** Gives a project its key (it had none): kept upper case, from now. */
export function addKey(db: Sql, projectId: string, key: string, at = new Date().toISOString()): void {
  db.prepare('INSERT INTO project_keys (key, project_id, current, since) VALUES (?, ?, 1, ?)').run(normalKey(key), projectId, at) // i18n-ignore: SQL
}

/**
 * Makes `key` a project's current key, its key before kept as an alias; a key it had before becomes current again. The
 * caller checked it (keyProblem): another project's key throws here (a key belongs to one project for good).
 */
export function changeKey(db: Sql, projectId: string, key: string, at = new Date().toISOString()): void {
  const k = normalKey(key)
  const had = db.prepare('SELECT project_id FROM project_keys WHERE key = ?').get(k) as { project_id: string } | undefined // i18n-ignore: SQL
  if (had && had.project_id !== projectId) throw new Error(`${k} is another project's key`) // i18n-ignore: a mistake in Combwork's code (checked before), logged
  db.prepare('UPDATE project_keys SET current = 0 WHERE project_id = ? AND current = 1').run(projectId) // i18n-ignore: SQL
  if (had) db.prepare('UPDATE project_keys SET current = 1, since = ? WHERE key = ?').run(at, k) // i18n-ignore: SQL
  else db.prepare('INSERT INTO project_keys (key, project_id, current, since) VALUES (?, ?, 1, ?)').run(k, projectId, at) // i18n-ignore: SQL
}

/**
 * A project's next card number, taken: past every number a card has or had there (an alias's included, so `AM-12` never
 * names two cards), and past the counter (a number taken by a change undone since stays unused).
 */
export function takeProjectNumber(db: Sql, projectId: string): number {
  const row = db.prepare('SELECT next FROM project_counters WHERE project_id = ?').get(projectId) as { next: number } | undefined // i18n-ignore: SQL
  const cards = (db.prepare('SELECT max(project_number) AS m FROM cards WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0 // i18n-ignore: SQL
  const aliases = (db.prepare('SELECT max(number) AS m FROM card_aliases WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0 // i18n-ignore: SQL
  const n = Math.max(row?.next ?? 1, cards + 1, aliases + 1)
  db.prepare('INSERT INTO project_counters (project_id, next) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next = excluded.next').run(projectId, n + 1) // i18n-ignore: SQL
  return n
}

/**
 * Gives a card saved just now its number in its project, after `was` (its project and number before the save, null for a
 * new card): kept while it stays in its project; in another project, that project's number it had there before (it came
 * back) or its next one, the number it leaves kept as an alias; none for a card about the workspace (no project id).
 */
export function numberCard(db: Sql, n: number, was: { projectId: string | null; projectNumber: number | null } | null): void {
  const now = db.prepare('SELECT project_id, project_number FROM cards WHERE number = ?').get(n) as { project_id: string | null; project_number: number | null } | undefined // i18n-ignore: SQL
  if (!now) return
  const from = was?.projectId || null
  const fromNumber = was?.projectNumber ?? null
  const to = now.project_id || null
  if (to !== null && to === from && now.project_number !== null) return
  if (from !== null && fromNumber !== null && from !== to) db.prepare('INSERT OR IGNORE INTO card_aliases (project_id, number, card) VALUES (?, ?, ?)').run(from, fromNumber, n) // i18n-ignore: SQL
  if (to === null) {
    // Only when it had one: a save that changes nothing writes nothing (#1210).
    if (now.project_number !== null) db.prepare('UPDATE cards SET project_number = NULL WHERE number = ?').run(n) // i18n-ignore: SQL
    return
  }
  // Back in a project it was in: its number there again (that key names it already).
  const back = db.prepare('SELECT number FROM card_aliases WHERE project_id = ? AND card = ? ORDER BY number LIMIT 1').get(to, n) as { number: number } | undefined // i18n-ignore: SQL
  if (back) db.prepare('DELETE FROM card_aliases WHERE project_id = ? AND number = ?').run(to, back.number) // i18n-ignore: SQL
  db.prepare('UPDATE cards SET project_number = ? WHERE number = ?').run(back?.number ?? takeProjectNumber(db, to), n) // i18n-ignore: SQL
}

/** A card's project and number there, before a save changes them (numberCard's `was`); null for a new card. */
export function cardPlace(db: Sql, n: number): { projectId: string | null; projectNumber: number | null } | null {
  const r = db.prepare('SELECT project_id, project_number FROM cards WHERE number = ?').get(n) as { project_id: string | null; project_number: number | null } | undefined // i18n-ignore: SQL
  return r ? { projectId: r.project_id, projectNumber: r.project_number } : null
}

/** Each card's key (`HI-12`), by number: these cards, or all; none for a card whose project has no key or which has no number. */
export function cardKeys(db: Sql, numbers?: readonly number[]): Map<number, string> {
  const rows = (
    numbers
      ? db.prepare('SELECT c.number, k.key, c.project_number AS pn FROM cards c JOIN project_keys k ON k.project_id = c.project_id AND k.current = 1 WHERE c.project_number IS NOT NULL AND c.number IN (SELECT value FROM json_each(?))').all(JSON.stringify(numbers)) // i18n-ignore: SQL
      : db.prepare('SELECT c.number, k.key, c.project_number AS pn FROM cards c JOIN project_keys k ON k.project_id = c.project_id AND k.current = 1 WHERE c.project_number IS NOT NULL').all() // i18n-ignore: SQL
  ) as { number: number; key: string; pn: number }[]
  return new Map(rows.map((r) => [r.number, cardKey(r.key, r.pn)]))
}

/**
 * The card a key names (`HI-12`, any case): through any key its project has had, the card with that number there, or the
 * card that had it before moving on (an alias). Null when none does.
 */
export function cardOfKey(db: Sql, key: string, number: number): number | null {
  const k = db.prepare('SELECT project_id FROM project_keys WHERE key = ?').get(normalKey(key)) as { project_id: string } | undefined // i18n-ignore: SQL
  if (!k) return null
  const card = db.prepare('SELECT number FROM cards WHERE project_id = ? AND project_number = ?').get(k.project_id, number) as { number: number } | undefined // i18n-ignore: SQL
  if (card) return card.number
  const alias = db.prepare('SELECT card FROM card_aliases WHERE project_id = ? AND number = ?').get(k.project_id, number) as { card: number } | undefined // i18n-ignore: SQL
  return alias?.card ?? null
}

/**
 * Every name a card moved to another project still has in a project it left (#1221): `HI-1` → its card, under each key
 * that project holds or held, for the window, which resolves the other names from the board and the keys.
 */
export function movedCardNames(db: Sql): Record<string, number> {
  const rows = db.prepare('SELECT k.key, a.number, a.card FROM card_aliases a JOIN project_keys k ON k.project_id = a.project_id').all() as { key: string; number: number; card: number }[] // i18n-ignore: SQL
  return Object.fromEntries(rows.map((r) => [`${r.key}-${r.number}`, r.card]))
}

/**
 * The 1.0 step for keys (#1219): #1208's tables made; each project with cards given a suggested key (from its name, the
 * projects with the most cards choosing first), every card of a project its own number as its number there (HI-1061),
 * and each project's counter set past its highest. Projects with no card get theirs when the workspace opens. A board
 * that had cards notes that the window should say so once (`keys.notice`).
 */
export function moveKeys(db: Sql, at = new Date().toISOString()): void {
  for (const sql of KEYS_STEP.ddl) db.exec(sql)
  const projects = db.prepare("SELECT project_id, max(number) AS top, count(*) AS cards, (SELECT c2.project FROM cards c2 WHERE c2.project_id = c.project_id ORDER BY c2.number DESC LIMIT 1) AS name FROM cards c WHERE project_id IS NOT NULL AND project_id != '' GROUP BY project_id ORDER BY cards DESC, project_id").all() as { project_id: string; top: number; cards: number; name: string }[] // i18n-ignore: SQL
  const held: KeyHeld[] = []
  for (const p of projects) {
    const key = suggestKey(p.name ?? '', p.project_id, held)
    held.push({ key, projectId: p.project_id })
    addKey(db, p.project_id, key, at)
    db.prepare('INSERT INTO project_counters (project_id, next) VALUES (?, ?)').run(p.project_id, p.top + 1) // i18n-ignore: SQL
  }
  db.exec("UPDATE cards SET project_number = number WHERE project_id IS NOT NULL AND project_id != ''")
  if (projects.length) db.prepare("INSERT INTO board_meta (key, value) VALUES ('keys.notice', 'due') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run() // i18n-ignore: SQL
}
