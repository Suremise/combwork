import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { UNDO_FINAL, type ActivityKind } from '../shared/assistantActivity'
import type { AgentDef, AssistantChangeGroup, AssistantChangeKind, AssistantChangeRow, TaskCard } from '../shared/types'
import type { LaneRecord } from '../shared/lanes'
import { currentTurn, type AssistantTurn } from './assistantControl'
import { boardRead, boardReadOnly, boardWrite, boardWriteOp } from './boardStore'
import type { Db } from './db'
import { changeActor } from './workflow/recorder'
import type { WorkspaceService } from './workspace'
import { config } from './config'
import { agentProvider } from '../shared/providers'

/**
 * The record undo is built on (#1282, SPEC §16.14): each change the Combwork Assistant makes, with what it replaced and what
 * it wrote, field by field, in combwork.db's `assistant_changes` and `assistant_change_values` (schema/v1_0.ts), grouped by
 * the user's message it came from (assistantControl's turn) and kept KEEP_DAYS days. A change the Assistant makes runs
 * inside `recordingChanges` (servers.ts' assistantChange, its batches): a card it changes is recorded as the card is
 * saved, in the same transaction (tasks.ts' saveCard calls noteCard), one change per card; a lane, an agent's settings,
 * a Combwork setting or an agent it started by the route that made it (noteChange); and what can't be undone (a prompt, a
 * comment, a project made) with why, so the window can say so. Undoing them is assistantUndo.ts'.
 */

/** A value as recorded: what JSON can say (a missing one is null). */
export type Value = null | boolean | number | string | Value[] | { [k: string]: Value }

/** A lane's record as undo puts it back: its cards (a queued list as it will be), reviewer, rounds, wait and name. */
export const laneValues = (l: LaneRecord): Record<string, Value> => ({ cards: [...(l.pending ?? l.cards)], reviewer: l.reviewer?.id ?? null, rounds: l.rounds, waitMinutes: l.waitMinutes, name: l.name })

/** An agent's settings undo puts back: those the Assistant can change (servers.ts' agentSettings, and its name). */
export const AGENT_FIELDS = ['name', 'provider', 'connection', 'mcpServers', 'workflowRole'] as const

/** A field a change set: what it was, and what the change wrote. */
export interface FieldChange {
  field: string
  old: unknown
  new: unknown
}

/** How long changes are kept (OP-15), from the message they came from. */
export const KEEP_DAYS = 7
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60_000

/** The change being made here: its workspace, the user's message, its line, and the change recorded for each card. */
interface Recording {
  workspace: string
  turn: AssistantTurn
  act: ActivityKind
  what: string
  cards: Map<number, string>
  /** Each card's change that can't be undone (a decision, a comment, its place), and why. */
  finals: Map<number, { id: string; why: Set<string> }>
  recorded: number
}
const recording = new AsyncLocalStorage<Recording | null>()

/**
 * Runs one of the Assistant's changes (`act`: its action's kind; `what`: its line, "change #12 on the board"), recording
 * what it changes for undo.
 */
export function recordingChanges<T>(workspacePath: string, act: ActivityKind, what: string, fn: () => Promise<T>): Promise<T> {
  return recording.run({ workspace: workspacePath, turn: currentTurn(workspacePath), act, what, cards: new Map(), finals: new Map(), recorded: 0 }, fn)
}

/** Runs `fn` recording nothing, inside one of the Assistant's changes too: an undo's own writes aren't changes to undo. */
export function notRecording<T>(fn: () => T): T {
  return recording.run(null, fn)
}

/** How many changes the change running here has recorded so far (0 outside one). */
export const recordedHere = (): number => recording.getStore()?.recorded ?? 0

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** A card's fields undo puts back (SPEC §16.14): its words, labels, block, links, agent, column and project. */
export const CARD_FIELDS = ['title', 'description', 'labels', 'blocked', 'blockedBy', 'links', 'agent', 'column', 'project', 'waitingFor'] as const
export type CardField = (typeof CARD_FIELDS)[number]

/** The implicit field a card's move records (its review, as it was and became): checked by undo, never restored. */
export const REVIEW = 'review'
/** A card's review as a value: who reviews it and since when (a later review by the same reviewer is another). */
export const reviewOf = (card: Pick<TaskCard, 'review'>): Value => (card.review ? { agent: card.review.agent, since: card.review.since } : null)

/** A card's field as a value. */
export function cardValue(card: TaskCard, field: CardField): Value {
  switch (field) {
    case 'labels':
      return [...card.labels]
    case 'blockedBy':
      return [...card.blockedBy]
    case 'links':
      return [...card.links]
    case 'agent':
      return card.agent ?? null
    case 'blocked':
      return card.blocked ?? null
    // Waiting on purpose (HI-2618), whole: why, who marked it and when, so undo puts back the mark as it was.
    case 'waitingFor':
      return card.waitingFor ? { reason: card.waitingFor.reason, by: card.waitingFor.by, at: card.waitingFor.at } : null
    default:
      return card[field]
  }
}

/** A value with its objects' keys in order: two that say the same compare equal. */
const stable = (v: unknown): string => JSON.stringify(v ?? null, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
/** Whether two values say the same. */
export const sameValue = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

/**
 * What of a card's change undo can't put back (#1282 round 1: never left out), and why: a decision recorded (only the
 * user changes or removes decisions), a comment, its place in its column, the doc sections to read first.
 */
function finalsOf(before: TaskCard | null, after: TaskCard): string[] {
  if (!before) return []
  const out: string[] = []
  // Why, in the Assistant's tool replies (English); the window words it from its code (finalWhys, #1283).
  if ((after.decisions?.length ?? 0) > (before.decisions?.length ?? 0)) out.push(UNDO_FINAL.decision)
  // A comment added (HI-2642): one the card didn't have, by its id; a card at its 500 keeps the same count as the oldest
  // is archived (HI-2641), so a count alone misses it. A comment without an id is an older one's: counted as before.
  const had = new Set(before.comments.flatMap((c) => (c.id ? [c.id] : [])))
  if (after.comments.length > before.comments.length || after.comments.some((c) => c.id && !had.has(c.id))) out.push(UNDO_FINAL.comment)
  if (after.order !== before.order && after.column === before.column) out.push(UNDO_FINAL.cardPlace)
  if (!sameValue(after.context ?? [], before.context ?? [])) out.push(UNDO_FINAL.context)
  return out
}

/**
 * A card saved inside one of the Assistant's changes (tasks.ts' saveCard, in the board change's transaction): what it
 * changed of the card's fields, as one change per card (a batch's cards each their own); a new card, as made by it, with
 * the last entry of its history as the change left it (`target`: what came after it is someone else's). What of it undo
 * can't put back is a change of its own, final, with why. Only the Assistant's own saves count, not Combwork's or another
 * actor's inside the same call.
 */
export function noteCard(ws: WorkspaceService, before: TaskCard | null, after: TaskCard): void {
  const r = recording.getStore()
  if (!r || !ws.path || !same(ws.path, r.workspace) || changeActor()?.kind !== 'assistant') return
  const n = after.number
  const fields: FieldChange[] = before ? CARD_FIELDS.filter((f) => !sameValue(cardValue(before, f), cardValue(after, f))).map((f) => ({ field: f, old: cardValue(before, f), new: cardValue(after, f) })) : [{ field: 'created', old: false, new: true }]
  // A move (of column or project) can stop a review: what the card's review was and became, its reviewer and when it
  // started, so undo's move back never stops a review someone started since (round 3). Compared, never written back.
  if (before && fields.some((f) => f.field === 'column' || f.field === 'project')) fields.push({ field: REVIEW, old: reviewOf(before), new: reviewOf(after) })
  const finals = finalsOf(before, after)
  const made = r.cards.get(n)
  if (!fields.length && !finals.length && !made) return
  boardWriteOp(ws, (db) => {
    let id = made
    if (!id && fields.length) {
      id = randomUUID()
      r.cards.set(n, id)
      insertChange(db, id, r, { kind: 'card', card: n, project: after.project || null })
      r.recorded++
    }
    if (id) {
      for (const f of fields) putField(db, id, f)
      // A card it made: the last history entry as this change has left it so far.
      const last = after.history.at(-1)?.id
      if (last) db.prepare("UPDATE assistant_changes SET target = ? WHERE id = ? AND EXISTS (SELECT 1 FROM assistant_change_values WHERE change = ? AND field = 'created')").run(last, id, id) // i18n-ignore: SQL
    }
    if (finals.length) {
      const had = r.finals.get(n)
      if (had) {
        for (const w of finals) had.why.add(w)
        db.prepare('UPDATE assistant_changes SET final = ? WHERE id = ?').run([...had.why].join(' '), had.id) // i18n-ignore: SQL
      } else {
        const fid = randomUUID()
        r.finals.set(n, { id: fid, why: new Set(finals) })
        insertChange(db, fid, r, { kind: 'final', card: n, project: after.project || null, final: finals.join(' ') })
        r.recorded++
      }
    }
    prune(ws.path!, db)
  })
}

/**
 * Records one of the Assistant's changes that isn't a card's (a lane, an agent's settings, a Combwork setting, an agent it
 * started), or one that can't be undone (`final`: why), in the change running here. Its own board change. Returns its id,
 * or null outside one of the Assistant's changes.
 */
export async function noteChange(ws: WorkspaceService, o: NoteChange): Promise<string | null> {
  const r = recording.getStore()
  if (!r || !ws.path || !same(ws.path, r.workspace)) return null
  let id: string | null = null
  await boardWrite(ws, async () => boardWriteOp(ws, (db) => (id = noteChangeIn(db, ws.path!, o))))
  return id
}

/** One of the Assistant's changes as noteChange records it. */
interface NoteChange {
  kind: Exclude<AssistantChangeKind, 'card'>
  project?: string | null
  target?: string | null
  card?: number | null
  fields?: FieldChange[]
  final?: string
}

/**
 * noteChange's write, in a transaction the caller has open (a lane's save: its record of the change is part of it). Null,
 * and nothing written, outside one of the Assistant's changes in this workspace.
 */
export function noteChangeIn(db: Db['writer'], workspacePath: string, o: NoteChange): string | null {
  const r = recording.getStore()
  if (!r || !same(workspacePath, r.workspace)) return null
  const id = randomUUID()
  insertChange(db, id, r, o)
  for (const f of o.fields ?? []) putField(db, id, f)
  r.recorded++
  // Every recording path prunes (#1282 round 2): a workspace whose Assistant changes only settings, lanes or agents too.
  prune(workspacePath, db)
  return id
}

function insertChange(db: Db['writer'], id: string, r: Recording, o: { kind: AssistantChangeKind; project?: string | null; target?: string | null; card?: number | null; final?: string }): void {
  db.prepare('INSERT INTO assistant_changes (id, grp, grp_at, at, kind, act, what, card, project, target, final) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, r.turn.id, r.turn.at, new Date().toISOString(), o.kind, r.act, r.what, o.card ?? null, o.project ?? null, o.target ?? null, o.final ?? null) // i18n-ignore: SQL
}

/**
 * A field of a change: what it replaced, written once (the first save of the change that set it), and what it wrote,
 * replaced by each later save of the same change (a move through several stages ends where the last one left it).
 */
function putField(db: Db['writer'], change: string, f: FieldChange): void {
  const had = db.prepare("SELECT 1 FROM assistant_change_values WHERE change = ? AND field = ? AND side = 'old' LIMIT 1").get(change, f.field) // i18n-ignore: SQL
  if (!had) putValue(db, change, f.field, 'old', f.old)
  db.prepare("DELETE FROM assistant_change_values WHERE change = ? AND field = ? AND side = 'new'").run(change, f.field) // i18n-ignore: SQL
  putValue(db, change, f.field, 'new', f.new)
}

function putValue(db: Db['writer'], change: string, field: string, side: 'old' | 'new', v: unknown): void {
  const put = db.prepare('INSERT INTO assistant_change_values (change, field, side, ord, path, type, text, num) VALUES (?, ?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
  for (const r of rowsOf(v)) put.run(change, field, side, r.ord, r.path, r.type, r.text ?? null, r.num ?? null)
}

/** Separates a member's keys in a value row's path: no key has it. */
const SEP = '\u001f'

/** A value's row (assistant_change_values): its place, path, type and what it holds. */
export interface ValueRow {
  ord: number
  path: string
  type: 'null' | 'bool' | 'num' | 'text' | 'arr' | 'obj'
  text?: string | null
  num?: number | null
}

/** A value as rows: itself at path '', each member of a list or object after it, its path its parent's and its key. */
export function rowsOf(v: unknown): ValueRow[] {
  const out: Omit<ValueRow, 'ord'>[] = []
  const walk = (x: unknown, path: string): void => {
    if (x === null || x === undefined) out.push({ path, type: 'null' })
    else if (typeof x === 'boolean') out.push({ path, type: 'bool', num: x ? 1 : 0 })
    else if (typeof x === 'number') out.push({ path, type: 'num', num: x })
    else if (typeof x === 'string') out.push({ path, type: 'text', text: x })
    else if (Array.isArray(x)) {
      out.push({ path, type: 'arr' })
      x.forEach((y, i) => walk(y, `${path}${SEP}${i}`))
    } else if (typeof x === 'object') {
      out.push({ path, type: 'obj' })
      for (const [k, y] of Object.entries(x as Record<string, unknown>)) if (y !== undefined) walk(y, `${path}${SEP}${k}`)
    } else out.push({ path, type: 'text', text: String(x) })
  }
  walk(v, '')
  return out.map((r, ord) => ({ ...r, ord }))
}

/** A value from its rows (in their order). */
export function valueOf(rows: readonly ValueRow[]): Value {
  const containers = new Map<string, Value[] | { [k: string]: Value }>()
  let root: Value = null
  for (const r of rows) {
    const v: Value = r.type === 'null' ? null : r.type === 'bool' ? r.num === 1 : r.type === 'num' ? (r.num ?? 0) : r.type === 'text' ? (r.text ?? '') : r.type === 'arr' ? [] : {}
    if (r.path === '') root = v
    else {
      const i = r.path.lastIndexOf(SEP)
      const parent = containers.get(r.path.slice(0, i))
      if (Array.isArray(parent)) parent.push(v)
      else if (parent) parent[r.path.slice(i + 1)] = v
    }
    if (r.type === 'arr' || r.type === 'obj') containers.set(r.path, v as Value[] | { [k: string]: Value })
  }
  return root
}

/** Prunes changes past KEEP_DAYS, once an hour at most per workspace (inside a write, with the change being recorded). */
const pruned = new Map<string, number>()
function prune(workspacePath: string, db: Db['writer'], now = Date.now()): void {
  const key = workspacePath.toLowerCase()
  if (now - (pruned.get(key) ?? 0) < 60 * 60_000) return
  pruned.set(key, now)
  db.prepare('DELETE FROM assistant_changes WHERE grp_at < ?').run(new Date(now - KEEP_MS).toISOString()) // i18n-ignore: SQL
}

/** Prunes now, whenever it last did (tests; the window's list does it on its way). */
export async function pruneChanges(ws: WorkspaceService, now = Date.now()): Promise<void> {
  pruned.delete((ws.path ?? '').toLowerCase())
  await boardWrite(ws, async () => boardWriteOp(ws, (db) => prune(ws.path ?? '', db, now)))
}

/** A change as recorded, with its fields' values. */
export interface RecordedChange extends AssistantChangeRow {
  groupAt: string
  target?: string
  values: FieldChange[]
}

interface ChangeRecordRow {
  id: string
  grp: string
  grp_at: string
  at: string
  kind: AssistantChangeKind
  act: ActivityKind
  what: string
  card: number | null
  project: string | null
  target: string | null
  final: string | null
  undone_at: string | null
}

/** What undo did with a change's fields once it was marked undone: put back, or left as they are, and why (#1283). */
export type UndoOutcome = NonNullable<AssistantChangeRow['outcome']>

/**
 * The changes recorded within KEEP_DAYS: one by id, a group's (the user's message), or all of them; newest first. With
 * their fields' values.
 */
export function recordedChanges(ws: WorkspaceService, sel: { change?: string; group?: string } = {}, now = Date.now()): RecordedChange[] {
  // A 0.9 board waiting for its upgrade to 1.0 has no change record yet: nothing is kept (HI-1820).
  if (boardReadOnly(ws)) return []
  const since = new Date(now - KEEP_MS).toISOString()
  return boardRead(ws, (db) => {
    const rows = (
      sel.change
        ? db.prepare('SELECT * FROM assistant_changes WHERE id = ? AND grp_at >= ?').all(sel.change, since) // i18n-ignore: SQL
        : sel.group
          ? db.prepare('SELECT * FROM assistant_changes WHERE grp = ? AND grp_at >= ? ORDER BY at DESC, rowid DESC').all(sel.group, since) // i18n-ignore: SQL
          : db.prepare('SELECT * FROM assistant_changes WHERE grp_at >= ? ORDER BY grp_at DESC, at DESC, rowid DESC').all(since) // i18n-ignore: SQL
    ) as unknown as ChangeRecordRow[]
    const valuesOf = db.prepare('SELECT field, side, ord, path, type, text, num FROM assistant_change_values WHERE change = ? ORDER BY field, side, ord') // i18n-ignore: SQL
    const outcomesOf = db.prepare('SELECT field, outcome FROM assistant_change_outcomes WHERE change = ? ORDER BY field') // i18n-ignore: SQL
    return rows.map((r) => {
      const byField = new Map<string, { old: ValueRow[]; new: ValueRow[] }>()
      for (const v of valuesOf.all(r.id) as unknown as (ValueRow & { field: string; side: 'old' | 'new' })[]) {
        const f = byField.get(v.field) ?? { old: [], new: [] }
        f[v.side].push(v)
        byField.set(v.field, f)
      }
      const values = [...byField].map(([field, v]) => ({ field, old: valueOf(v.old), new: valueOf(v.new) }))
      // What undo did with its fields, once marked (none for one marked before outcomes were kept: it reads as undone).
      const outcomes = r.undone_at !== null ? (outcomesOf.all(r.id) as unknown as { field: string; outcome: 'undone' | 'changed' | 'gone' | 'ended' }[]) : []
      const outcome: UndoOutcome | null = outcomes.length ? { undone: outcomes.filter((o) => o.outcome === 'undone').map((o) => o.field), skipped: outcomes.flatMap((o) => (o.outcome === 'undone' ? [] : [{ field: o.field, why: o.outcome }])) } : null
      return {
        id: r.id,
        group: r.grp,
        groupAt: r.grp_at,
        at: r.at,
        kind: r.kind,
        act: r.act,
        what: r.what,
        ...(r.card !== null ? { card: r.card } : {}),
        ...(r.project !== null ? { project: r.project } : {}),
        ...(r.target !== null ? { target: r.target } : {}),
        ...(r.final !== null ? { final: r.final } : {}),
        ...(r.undone_at !== null ? { undoneAt: r.undone_at } : {}),
        ...(outcome ? { outcome } : {}),
        // The fields it set; its implicit snapshot (a card's review, checked by undo) isn't one.
        fields: values.map((f) => f.field).filter((f) => f !== REVIEW),
        values
      }
    })
  })
}

/** The changes kept, by the user's message they came from, newest first (the window's undo list, the Assistant's tool). */
export function changeGroups(ws: WorkspaceService, now = Date.now()): AssistantChangeGroup[] {
  const groups = new Map<string, AssistantChangeGroup>()
  for (const c of recordedChanges(ws, {}, now)) {
    const g = groups.get(c.group) ?? { id: c.group, at: c.groupAt, changes: [] }
    const { values: _values, groupAt: _at, target: _target, ...row } = c
    g.changes.push(row)
    groups.set(c.group, g)
  }
  return [...groups.values()]
}

/**
 * Marks a change undone (as far as it could be: what was skipped stays as it was), so it isn't undone again, with what
 * undo did with each of its fields (#1283: the panel's Undone, Partly undone or Kept, and why). Marked once: a change
 * marked before keeps its outcome.
 */
export async function markUndone(ws: WorkspaceService, id: string, outcome: UndoOutcome, at = new Date().toISOString()): Promise<void> {
  await boardWrite(ws, async () =>
    boardWriteOp(ws, (db) => {
      if (!Number(db.prepare('UPDATE assistant_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(at, id).changes)) return // i18n-ignore: SQL
      const put = db.prepare('INSERT INTO assistant_change_outcomes (change, field, outcome) VALUES (?, ?, ?) ON CONFLICT DO NOTHING') // i18n-ignore: SQL
      for (const field of outcome.undone) put.run(id, field, 'undone')
      for (const s of outcome.skipped) put.run(id, s.field, s.why)
    })
  )
}

/**
 * A lane the Assistant started (`before` null: it is made, with its record as it started) or changed (what of its record
 * changed), recorded for undo in the lane's save (lanes.ts: `before` read under the lanes' lock, `after` as saved).
 */
export function noteLaneIn(db: Db['writer'], workspacePath: string, before: Record<string, Value> | null, after: LaneRecord): void {
  const now = laneValues(after)
  const fields = before ? Object.keys(now).filter((k) => !sameValue(before[k], now[k])).map((k) => ({ field: k, old: before[k], new: now[k] })) : [{ field: 'created', old: false, new: true }, ...Object.keys(now).map((k) => ({ field: k, old: null, new: now[k] }))]
  if (fields.length) noteChangeIn(db, workspacePath, { kind: 'lane', project: after.project, target: after.id, fields })
}

/**
 * What a provider change resets of an agent (projectAgents' updateAgent): undo puts its provider back only with these,
 * each as the change left it, so they are all recorded with it, changed or not (round 3). Since HI-2108 its CLI follows its
 * connection, so the two go back together.
 */
export const PROVIDER_DEPENDENTS = ['connection', 'lastSessionId'] as const

/**
 * An agent's connection by its id (HI-2109, Choose Connections…), as a change records it: never the adapter's
 * `connection` (an account's id), so two connections with the same values are told apart.
 */
export const CONNECTION_ID = 'connectionId'

/**
 * An agent's change of connection the Assistant made (HI-2109): its connection's id, and its CLI and last conversation
 * when they changed with it, from the agent as saved just before and after; undone together (assistantUndo.ts).
 */
export async function noteConnection(ws: WorkspaceService, project: string, was: AgentDef, now: AgentDef): Promise<void> {
  if ((was.connection ?? null) === (now.connection ?? null)) return
  const fields: FieldChange[] = [{ field: CONNECTION_ID, old: was.connection ?? null, new: now.connection ?? null }]
  if ((was.provider ?? null) !== (now.provider ?? null)) fields.push({ field: 'provider', old: was.provider ?? null, new: now.provider ?? null }, { field: 'lastSessionId', old: was.lastSessionId ?? null, new: now.lastSessionId ?? null })
  await noteChange(ws, { kind: 'agent', project, target: now.id, fields })
}

/**
 * An agent's settings the Assistant changed (as saved under the project's lock just before, and after), recorded for
 * undo: those that changed; with a provider change, everything it resets too.
 */
export async function noteAgent(ws: WorkspaceService, project: string, wasDef: AgentDef, nowDef: AgentDef): Promise<void> {
  // A CLI it didn't name (one from before 0.2) is the one it ran, which the accounts migration pins it to (decision A).
  const was = wasDef.provider ? wasDef : { ...wasDef, provider: agentProvider(wasDef, config.settings) }
  const now = nowDef
  const keys: (keyof AgentDef)[] = AGENT_FIELDS.filter((k) => !sameValue(was[k], now[k]))
  if (keys.includes('provider')) for (const k of PROVIDER_DEPENDENTS) if (!keys.includes(k)) keys.push(k)
  const fields = keys.map((k) => ({ field: k, old: was[k] ?? null, new: now[k] ?? null }))
  if (fields.length) await noteChange(ws, { kind: 'agent', project, target: now.id, fields })
}
