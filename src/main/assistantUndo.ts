import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { AgentDef, AgentPatch, AssistantUndoResult, TaskCard, TaskPatch } from '../shared/types'
import { CARD_FIELDS, cardValue, laneValues, markUndone, notRecording, recordedChanges, sameValue, type CardField, type FieldChange, type RecordedChange, type Value } from './assistantChanges'
import * as lanes from './lanes'
import { updateAgent } from './projectAgents'
import { sessions } from './sessions'
import { applySetting, entryOf } from './settingsTools'
import { config } from './config'
import * as assistant from './assistantControl'
import * as tasks from './tasks'
import { inWorkspace, type WorkspaceService } from './workspace'

/**
 * Undo for the Hive Assistant's changes (#1282, SPEC §16.14), from what assistantChanges.ts recorded: one change, or every
 * change of a message of the user's, newest first. Each field goes back to what the change replaced only while it still
 * holds what the change wrote, checked at the moment of the write (under the card's lock, a setting's guard): one someone
 * changed since (the user, an agent, the Assistant later) is skipped and said, never overwritten. A card it made is
 * archived (unless anyone else has changed it since); a column move goes back through the card's rules as a move with
 * the override reason "undo"; a lane it started is abandoned, and a lane's list, reviewer, rounds, wait or name it changed
 * go back through the lane record; an agent's settings and a Hive setting are set back; an agent it started is stopped
 * (its work stays). What can't be undone (a prompt, a comment) says why. An undo's own writes aren't recorded as changes:
 * undoing is never itself undone. The user undoes from the window (IPC), the Assistant its own with its tool.
 */

/** Who undoes: the user (the window) or the Assistant (its tool). */
export type UndoBy = 'user' | 'assistant'

/** An undo asked for something that isn't there: no such change (kept 7 days), or no changes for that message. */
export class UndoNotFound extends Error {}

/** A field found changed since at the moment of the write (a card's check under its lock, a setting's guard). */
class ChangedSince extends Error {
  constructor(public fields: string[]) {
    super(`changed since: ${fields.join(', ')}`) // i18n-ignore: an internal signal, never shown
  }
}

/**
 * Undoes the change `sel.change` names, or every change of the message `sel.group` names, newest first. A change undone
 * before is left as it is (`already`); every other one is marked undone once tried, as far as it could be: what was
 * skipped stays as it is.
 */
export async function undoChanges(ws: WorkspaceService, sel: { change?: string; group?: string }, by: UndoBy): Promise<AssistantUndoResult[]> {
  const list = recordedChanges(ws, sel)
  // i18n-ignore: an Agent API refusal (English); the window offers only changes it listed
  if (!list.length) throw new UndoNotFound(sel.change ? `No change of the Assistant's ${sel.change} is kept (changes are kept 7 days).` : `No changes of the Assistant's are kept for message ${sel.group ?? ''} (they are kept 7 days).`)
  return notRecording(async () => {
    const out: AssistantUndoResult[] = []
    const tried: string[] = []
    for (const c of list) {
      const head = { change: c.id, act: c.act, what: c.what, ...(c.card !== undefined ? { card: c.card } : {}) }
      if (c.undoneAt) out.push({ ...head, undone: [], skipped: [], already: true })
      else if (c.kind === 'final') out.push({ ...head, undone: [], skipped: [], final: c.final ?? '' })
      else {
        out.push({ ...head, ...(await undoOne(ws, c, by)) })
        tried.push(c.id)
      }
    }
    await markUndone(ws, tried)
    return out
  })
}

/**
 * The user undoes from the window (its panel, #1283): as undoChanges, listed in the Assistant's activity list as theirs
 * (its cards when it was about one or several), as Revert on a setting is.
 */
export async function userUndo(ws: WorkspaceService, sel: { change?: string; group?: string }): Promise<AssistantUndoResult[]> {
  const results = await undoChanges(ws, sel, 'user')
  const cards = [...new Set(results.flatMap((r) => (r.card !== undefined ? [r.card] : [])))]
  const undone = results.filter((r) => r.undone.length).length
  // i18n-ignore: the activity list's line, in English as the Assistant's other lines (#763: the event stream's too)
  if (ws.path) assistant.record(ws.path, { kind: 'undo', ...(cards.length === 1 ? { card: cards[0] } : cards.length ? { cards } : {}) }, `You undid ${undone} of ${results.length} of the Assistant's changes`)
  return results
}

type Outcome = Pick<AssistantUndoResult, 'undone' | 'skipped'>
const failedAll = (fields: readonly string[], e: unknown): Outcome => ({ undone: [], skipped: fields.map((field) => ({ field, why: 'failed' as const, error: (e as Error).message })) }) // i18n-ignore: a skip's code, worded by whoever shows it
const goneAll = (fields: readonly string[]): Outcome => ({ undone: [], skipped: fields.map((field) => ({ field, why: 'gone' as const })) }) // i18n-ignore: a skip's code, worded by whoever shows it

function undoOne(ws: WorkspaceService, c: RecordedChange, by: UndoBy): Promise<Outcome> {
  switch (c.kind) {
    case 'card':
      return undoCard(ws, c, by)
    case 'lane':
      return undoLane(ws, c, by)
    case 'agent':
      return undoAgent(ws, c)
    case 'setting':
      return undoSetting(ws, c, by)
    case 'started':
      return undoStarted(ws, c)
    default:
      return Promise.resolve({ undone: [], skipped: [] })
  }
}

/**
 * What of a change's fields to set back, from where they are now: those back as they were already count as undone,
 * those someone changed since are skipped, the rest (still as the change left them) are set back.
 */
function plan(values: readonly FieldChange[], now: (field: string) => unknown): { back: FieldChange[]; undone: string[]; skipped: Outcome['skipped'] } {
  const back: FieldChange[] = []
  const undone: string[] = []
  const skipped: Outcome['skipped'] = []
  for (const v of values) {
    const cur = now(v.field)
    if (sameValue(cur, v.old)) undone.push(v.field)
    else if (sameValue(cur, v.new)) back.push(v)
    else skipped.push({ field: v.field, why: 'changed' }) // i18n-ignore: a skip's code, worded by whoever shows it
  }
  return { back, undone, skipped }
}

const BY_NAME: Record<UndoBy, string> = { user: 'You', assistant: 'Assistant' } // i18n-ignore: who started a lane, as the board stores it (shown through its own messages)

/**
 * A card: one it made is archived, unless someone other than the Assistant or Hive has changed it since; its fields go
 * back in one change of the card, which checks under the card's lock that each is still as the change left it.
 */
async function undoCard(ws: WorkspaceService, c: RecordedChange, by: UndoBy): Promise<Outcome> {
  const n = c.card!
  const actor: tasks.TaskActor = by === 'user' ? { kind: 'user' } : { kind: 'assistant' }
  const card = await inWorkspace(ws, () => tasks.getTask(n, ws)).catch(() => null)
  if (!card || card.archived) return goneAll(c.fields)
  if (c.fields.includes('created')) {
    const others = card.history.some((h) => h.at > c.at && h.by !== 'Assistant' && h.by !== 'Hive')
    if (others) return { undone: [], skipped: [{ field: 'created', why: 'changed' }] } // i18n-ignore: a skip's code, worded by whoever shows it
    try {
      await inWorkspace(ws, () => tasks.archiveTask(n, true))
      return { undone: ['created'], skipped: [] }
    } catch (e) {
      return failedAll(['created'], e)
    }
  }
  const values = c.values.filter((v) => (CARD_FIELDS as readonly string[]).includes(v.field))
  const { back, undone, skipped } = plan(values, (f) => cardValue(card, f as CardField))
  if (!back.length) return { undone, skipped }
  const patch: TaskPatch = {}
  for (const v of back) setCardField(patch, v.field as CardField, v.old as Value)
  // A move back skips what it must of the card's rules, as an override whose reason is the undo (SPEC §16.8.4).
  if (patch.column) patch.override = { reason: 'undo' } // i18n-ignore: the override's reason, a code (SPEC §16.14: undo's moves show as overrides)
  const check = (now: TaskCard): void => {
    const moved = back.filter((v) => !sameValue(cardValue(now, v.field as CardField), v.new)).map((v) => v.field)
    if (moved.length) throw new ChangedSince(moved)
  }
  try {
    await inWorkspace(ws, () => tasks.updateTask(n, patch, actor, { check }))
    return { undone: [...undone, ...back.map((v) => v.field)], skipped }
  } catch (e) {
    // Changed meanwhile: nothing was written (the whole change is refused), so those still as left are tried again alone.
    if (e instanceof ChangedSince) {
      const rest = back.filter((v) => !e.fields.includes(v.field))
      const again = rest.length ? await undoCard(ws, { ...c, values: rest, fields: rest.map((v) => v.field) }, by) : { undone: [], skipped: [] }
      return { undone: [...undone, ...again.undone], skipped: [...skipped, ...e.fields.map((field) => ({ field, why: 'changed' as const })), ...again.skipped] } // i18n-ignore: a skip's code, worded by whoever shows it
    }
    return { undone, skipped: [...skipped, ...failedAll(back.map((v) => v.field), e).skipped] }
  }
}

function setCardField(patch: TaskPatch, field: CardField, v: Value): void {
  switch (field) {
    case 'labels':
      patch.labels = (v as string[] | null) ?? []
      break
    case 'blockedBy':
      patch.blockedBy = (v as number[] | null) ?? []
      break
    case 'links':
      patch.links = (v as number[] | null) ?? []
      break
    case 'blocked':
      patch.blocked = (v as string | null) ?? ''
      break
    case 'agent':
      patch.agent = (v as string | null) ?? ''
      break
    case 'column':
      patch.column = v as TaskCard['column']
      break
    case 'project':
      patch.project = v as string
      break
    default:
      patch[field] = v as string
  }
}

/**
 * A lane: one it started is abandoned while it runs (an ended one stays as it ended); its list, reviewer, rounds, wait or
 * name go back through the lane record (a list change while a card is in flight is queued to that card's end, as any).
 */
async function undoLane(ws: WorkspaceService, c: RecordedChange, by: UndoBy): Promise<Outcome> {
  const lane = (await lanes.listLanes(ws, { all: true })).find((l) => l.id === c.target)
  if (!lane) return goneAll(c.fields)
  const running = lane.state === 'active' || lane.state === 'paused'
  if (c.fields.includes('created')) {
    if (!running) return { undone: [], skipped: [{ field: 'created', why: 'ended' }] } // i18n-ignore: a skip's code, worded by whoever shows it
    try {
      await lanes.endLane(ws, lane.id, { abandoned: true })
      return { undone: ['created'], skipped: [] }
    } catch (e) {
      return failedAll(['created'], e)
    }
  }
  if (!running) return { undone: [], skipped: c.fields.map((field) => ({ field, why: 'ended' as const })) } // i18n-ignore: a skip's code, worded by whoever shows it
  const now = laneValues(lane)
  const { back, undone, skipped } = plan(c.values, (f) => now[f])
  if (!back.length) return { undone, skipped }
  const old = (f: string, fallback: Value): Value => back.find((v) => v.field === f)?.old as Value ?? fallback
  try {
    await lanes.startLane(ws, {
      project: lane.project,
      builder: lane.builder.id,
      reviewer: old('reviewer', now.reviewer) as string | null,
      cards: old('cards', now.cards) as number[],
      rounds: old('rounds', now.rounds) as number,
      waitMinutes: old('waitMinutes', now.waitMinutes) as number,
      name: old('name', now.name) as string | null,
      by: BY_NAME[by]
    })
    return { undone: [...undone, ...back.map((v) => v.field)], skipped }
  } catch (e) {
    return { undone, skipped: [...skipped, ...failedAll(back.map((v) => v.field), e).skipped] }
  }
}

/** The patch that sets an agent's setting back: an empty or missing one follows the project again. */
function agentPatch(back: readonly FieldChange[]): AgentPatch {
  const p: AgentPatch = {}
  for (const v of back) {
    const old = v.old as Value
    if (v.field === 'use200kContext') p.use200kContext = typeof old === 'boolean' ? old : null
    else if (v.field === 'mcpServers') p.mcpServers = Array.isArray(old) ? (old as string[]) : null
    else if (v.field === 'name' || v.field === 'provider' || v.field === 'model' || v.field === 'effort' || v.field === 'permissionMode') (p as Record<string, unknown>)[v.field] = old ?? ''
  }
  return p
}

/** An agent's settings: those still as the change left them go back (an agent removed since is gone). */
async function undoAgent(ws: WorkspaceService, c: RecordedChange): Promise<Outcome> {
  if (!ws.path || !c.project || !c.target) return goneAll(c.fields)
  const projectPath = join(ws.path, c.project)
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const def = cfg ? projectAgents(cfg).find((a) => a.id === c.target) : undefined
  if (!def) return goneAll(c.fields)
  const { back, undone, skipped } = plan(c.values, (f) => def[f as keyof AgentDef] ?? null)
  // A provider that followed the project's can't be followed again by a change of the agent's: said so.
  const followed = back.filter((v) => v.field === 'provider' && v.old === null)
  const set = back.filter((v) => !followed.includes(v))
  const failed = followed.map((v) => ({ field: v.field, why: 'failed' as const, error: "It followed the project's provider: set it in the agent's settings." })) // i18n-ignore: an Agent API reply (English)
  if (!set.length) return { undone, skipped: [...skipped, ...failed] }
  try {
    await updateAgent(projectPath, c.target, agentPatch(set))
    return { undone: [...undone, ...set.map((v) => v.field)], skipped: [...skipped, ...failed] }
  } catch (e) {
    return { undone, skipped: [...skipped, ...failed, ...failedAll(set.map((v) => v.field), e).skipped] }
  }
}

/**
 * A Hive setting: set back through the same checked change, refused at the moment of the change if it changed since. The
 * Assistant's own undo only while Settings → Assistant → Control → Change settings is on, as any change of a setting.
 */
async function undoSetting(ws: WorkspaceService, c: RecordedChange, by: UndoBy): Promise<Outcome> {
  const value = c.values.find((v) => v.field === 'value')
  const removed = c.values.find((v) => v.field === 'removed')
  if (!value || !c.target) return { undone: [], skipped: [] }
  if (by === 'assistant' && config.settings.assistant?.changeSettings !== true) return failedAll(c.fields, new Error("Settings → Assistant → Control → Change settings is off: the user can undo it in your panel.")) // i18n-ignore: an Agent API reply (English)
  const projectPath = c.project && ws.path ? join(ws.path, c.project) : null
  try {
    const e = entryOf(c.target)
    await applySetting(
      e,
      value.old,
      projectPath,
      (current) => {
        if (!sameValue(current, value.new)) throw new ChangedSince(['value'])
      },
      removed ? (removed.old as string[]) : undefined
    )
    return { undone: c.fields, skipped: [] }
  } catch (e) {
    if (e instanceof ChangedSince) return { undone: [], skipped: c.fields.map((field) => ({ field, why: 'changed' as const })) } // i18n-ignore: a skip's code, worded by whoever shows it
    return failedAll(c.fields, e)
  }
}

/** An agent it started: stopped if it still runs (what it did meanwhile stays). */
async function undoStarted(ws: WorkspaceService, c: RecordedChange): Promise<Outcome> {
  if (!ws.path || !c.project || !c.target) return goneAll(['running'])
  const projectPath = join(ws.path, c.project)
  if (!sessions.liveFor(projectPath, c.target)) return { undone: [], skipped: [{ field: 'running', why: 'ended' }] } // i18n-ignore: a skip's code, worded by whoever shows it
  try {
    sessions.stop(projectPath, c.target)
    return { undone: ['running'], skipped: [] }
  } catch (e) {
    return failedAll(['running'], e)
  }
}
