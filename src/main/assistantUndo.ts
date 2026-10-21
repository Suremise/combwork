import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { AgentDef, AgentPatch, AssistantUndoResult, LaneInfo, TaskCard, TaskPatch } from '../shared/types'
import { CARD_FIELDS, cardValue, markUndone, notRecording, recordedChanges, sameValue, type CardField, type FieldChange, type RecordedChange, type Value } from './assistantChanges'
import * as assistant from './assistantControl'
import { config } from './config'
import * as lanes from './lanes'
import { updateAgent } from './projectAgents'
import { sessions } from './sessions'
import { applySetting, entryOf, removedPrices } from './settingsTools'
import * as tasks from './tasks'
import { inWorkspace, type WorkspaceService } from './workspace'

/**
 * Undo for the Hive Assistant's changes (#1282, SPEC §16.14), from what assistantChanges.ts recorded: one change, or every
 * change of a message of the user's, newest first. Each field goes back to what the change replaced only while it still
 * holds what the change wrote, checked at the moment of the write under that thing's own lock: a card's (its change's
 * `check`), the lanes' (lanes.ts' restoreLane, abandonLaneIf), the project's for an agent's settings (updateAgent's
 * `check`), a setting's guard. One someone changed since (the user, an agent, the Assistant later) is left as it is and
 * said, never overwritten, and the rest still goes back. A card it made is archived while nobody else has changed it since
 * (its history past what the change left); a column move goes back through the card's rules as a move with the override
 * reason "undo"; a lane it started is abandoned while it is as it started; an agent it started is stopped while that same
 * launch runs (its work stays). What can't be undone (a prompt, a comment, a decision) says why. The Assistant's own undo
 * passes its guard (its control level, its launch), checked again under each write's lock: turned down or ended meanwhile,
 * the undo stops there, the changes undone so far marked. An undo's own writes aren't recorded as changes.
 */

/** Who undoes: the user (the window) or the Assistant (its tool). */
export type UndoBy = 'user' | 'assistant'

/** An undo asked for something that isn't there: no such change (kept 7 days), or no changes for that message. */
export class UndoNotFound extends Error {}

/** Fields found changed since at the moment of the write (a card's check under its lock, a setting's guard): nothing written. */
class ChangedSince extends Error {
  constructor(public fields: string[]) {
    super(`changed since: ${fields.join(', ')}`) // i18n-ignore: an internal signal, never shown
  }
}

/** The undo's guard refused at a write (the Assistant's control turned down, its launch ended): the undo stops. */
class UndoStopped extends Error {
  constructor(public refusal: unknown) {
    super((refusal as Error)?.message ?? String(refusal))
  }
}

/** Whether an error, however a write wrapped it, is the undo's guard refusing. */
const stopped = (e: unknown): UndoStopped | null => (e instanceof UndoStopped ? e : (e as { cause?: unknown } | null)?.cause instanceof UndoStopped ? (e as { cause: UndoStopped }).cause : null)

/**
 * Undoes the change `sel.change` names, or every change of the message `sel.group` names, newest first. A change undone
 * before is left as it is (`already`); every other one is marked undone as soon as it is tried, as far as it could be:
 * what was skipped stays as it is. `guard` (the Assistant's own undo): checked at each write, under its lock; its refusal
 * stops the undo and is thrown, with what was undone before it kept and marked.
 */
export async function undoChanges(ws: WorkspaceService, sel: { change?: string; group?: string }, by: UndoBy, guard?: () => void): Promise<AssistantUndoResult[]> {
  const list = recordedChanges(ws, sel)
  // i18n-ignore: an Agent API refusal (English); the window offers only changes it listed
  if (!list.length) throw new UndoNotFound(sel.change ? `No change of the Assistant's ${sel.change} is kept (changes are kept 7 days).` : `No changes of the Assistant's are kept for message ${sel.group ?? ''} (they are kept 7 days).`)
  const g = guard
    ? (): void => {
        try {
          guard()
        } catch (e) {
          throw new UndoStopped(e)
        }
      }
    : undefined
  return notRecording(async () => {
    const out: AssistantUndoResult[] = []
    for (const c of list) {
      const head = { change: c.id, act: c.act, what: c.what, ...(c.card !== undefined ? { card: c.card } : {}) }
      if (c.undoneAt) out.push({ ...head, undone: [], skipped: [], already: true })
      else if (c.kind === 'final') out.push({ ...head, undone: [], skipped: [], final: c.final ?? '' })
      else {
        let r: Outcome
        try {
          r = await undoOne(ws, c, by, g)
        } catch (e) {
          const s = stopped(e)
          throw s ? s.refusal : e
        }
        out.push({ ...head, ...r })
        await markUndone(ws, [c.id])
      }
    }
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
type Skipped = Outcome['skipped']
const changed = (fields: readonly string[]): Skipped => fields.map((field) => ({ field, why: 'changed' as const })) // i18n-ignore: a skip's code, worded by whoever shows it
const failedAll = (fields: readonly string[], e: unknown): Outcome => ({ undone: [], skipped: fields.map((field) => ({ field, why: 'failed' as const, error: (e as Error).message })) }) // i18n-ignore: a skip's code, worded by whoever shows it
const goneAll = (fields: readonly string[]): Outcome => ({ undone: [], skipped: fields.map((field) => ({ field, why: 'gone' as const })) }) // i18n-ignore: a skip's code, worded by whoever shows it

/** A write's failure: the guard's refusal stops the undo (thrown on); another is the change's, said as failed. */
const failedOr = (fields: readonly string[], e: unknown): Outcome => {
  if (stopped(e)) throw e
  return failedAll(fields, e)
}

function undoOne(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard?: () => void): Promise<Outcome> {
  switch (c.kind) {
    case 'card':
      return undoCard(ws, c, by, guard)
    case 'lane':
      return undoLane(ws, c, by, guard)
    case 'agent':
      return undoAgent(ws, c, guard)
    case 'setting':
      return undoSetting(ws, c, by, guard)
    case 'started':
      return undoStarted(ws, c, guard)
    default:
      return Promise.resolve({ undone: [], skipped: [] })
  }
}

/**
 * What of a change's fields to set back, from where they are as read: those back as they were already count as undone,
 * those someone changed since are skipped, the rest (still as the change left them) are to be set back, under the
 * write's lock, which checks them again.
 */
function plan(values: readonly FieldChange[], now: (field: string) => unknown): { back: FieldChange[]; undone: string[]; skipped: Skipped } {
  const back: FieldChange[] = []
  const undone: string[] = []
  const skipped: Skipped = []
  for (const v of values) {
    const cur = now(v.field)
    if (sameValue(cur, v.old)) undone.push(v.field)
    else if (sameValue(cur, v.new)) back.push(v)
    else skipped.push(...changed([v.field]))
  }
  return { back, undone, skipped }
}

/**
 * Sets fields back with `write`, which checks them again under its lock (throwing ChangedSince for those moved since,
 * nothing written); then the rest is tried again alone, so a later change of one field never keeps the others back.
 */
async function setBack(back: FieldChange[], write: (back: FieldChange[]) => Promise<void>, fail: (fields: readonly string[], e: unknown) => Outcome = failedOr): Promise<Outcome> {
  let rest = back
  const skipped: Skipped = []
  while (rest.length) {
    try {
      await write(rest)
      return { undone: rest.map((v) => v.field), skipped }
    } catch (e) {
      if (!(e instanceof ChangedSince)) return { undone: [], skipped: [...skipped, ...fail(rest.map((v) => v.field), e).skipped] }
      skipped.push(...changed(e.fields))
      const left = rest.filter((v) => !e.fields.includes(v.field))
      // Nothing it named among those tried: said as changed, all of them, rather than tried again forever.
      if (left.length === rest.length) return { undone: [], skipped: [...skipped, ...changed(rest.map((v) => v.field))] }
      rest = left
    }
  }
  return { undone: [], skipped }
}

const BY_NAME: Record<UndoBy, string> = { user: 'You', assistant: 'Assistant' } // i18n-ignore: who undid, as the board and lanes store an actor's name (shown through their own messages)

/** A card's history past the entry the change left it at (`id`), or null when that entry is no longer kept. */
function historyAfter(card: TaskCard, id: string | undefined): TaskCard['history'] | null {
  if (!id) return null
  const i = card.history.findIndex((h) => h.id === id)
  return i < 0 ? null : card.history.slice(i + 1)
}

/**
 * A card: one it made is archived while its history goes no further than the change left it (Hive's own notes aside),
 * checked under the board's lock; its fields go back in one change of the card, checked under the card's lock.
 */
async function undoCard(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard?: () => void): Promise<Outcome> {
  const n = c.card!
  const actor: tasks.TaskActor = by === 'user' ? { kind: 'user' } : { kind: 'assistant' }
  const card = await inWorkspace(ws, () => tasks.getTask(n, ws)).catch(() => null)
  if (!card || card.archived) return goneAll(c.fields)
  if (c.fields.includes('created')) {
    const check = (now: TaskCard): void => {
      const since = historyAfter(now, c.target)
      if (!since || since.some((h) => h.by !== 'Hive')) throw new ChangedSince(['created'])
      guard?.()
    }
    try {
      await inWorkspace(ws, () => tasks.archiveTask(n, true, { check, actor }))
      return { undone: ['created'], skipped: [] }
    } catch (e) {
      if (e instanceof ChangedSince) return { undone: [], skipped: changed(['created']) }
      return failedOr(['created'], e)
    }
  }
  const values = c.values.filter((v) => (CARD_FIELDS as readonly string[]).includes(v.field))
  const { back, undone, skipped } = plan(values, (f) => cardValue(card, f as CardField))
  if (!back.length) return { undone, skipped }
  const r = await setBack(back, async (rest) => {
    const patch: TaskPatch = {}
    for (const v of rest) setCardField(patch, v.field as CardField, v.old as Value)
    // A move back skips what it must of the card's rules, as an override whose reason is the undo (SPEC §16.8.4); the
    // runtime writes the Override only when a rule refuses the move.
    if (patch.column) patch.override = { reason: 'undo' } // i18n-ignore: the override's reason, a code (SPEC §16.14)
    const check = (now: TaskCard): void => {
      const moved = rest.filter((v) => !sameValue(cardValue(now, v.field as CardField), v.new)).map((v) => v.field)
      if (moved.length) throw new ChangedSince(moved)
    }
    await inWorkspace(ws, () => tasks.updateTask(n, patch, actor, { check, ...(guard ? { commit: guard } : {}) }))
  })
  return { undone: [...undone, ...r.undone], skipped: [...skipped, ...r.skipped] }
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

/** A lane as the Agent API lists it, as its record's values (assistantChanges' laneValues). */
const infoValues = (l: LaneInfo): Record<string, Value> => ({ cards: l.queued ?? l.cards.map((x) => x.number), reviewer: l.reviewer?.id ?? null, rounds: l.rounds, waitMinutes: l.waitMinutes, name: l.name })

/** A lane's refusal under its lock, as undo says it: the fields changed since, or the lane ended or gone. */
function laneFail(fields: readonly string[], e: unknown): Outcome {
  if (e instanceof lanes.LaneChangedSince) return { undone: [], skipped: (e.why === 'changed' ? fields : e.fields).map((field) => ({ field, why: e.why })) }
  return failedOr(fields, e)
}

/**
 * A lane: one it started is abandoned while it runs as it started (lanes.ts' abandonLaneIf, under the lanes' lock); its
 * list, reviewer, rounds, wait or name go back (restoreLane), each only while still as the change left it.
 */
async function undoLane(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard?: () => void): Promise<Outcome> {
  if (!c.target) return goneAll(c.fields)
  if (c.fields.includes('created')) {
    const expect = Object.fromEntries(c.values.filter((v) => v.field !== 'created').map((v) => [v.field, v.new]))
    try {
      await lanes.abandonLaneIf(ws, c.target, expect, guard)
      return { undone: ['created'], skipped: [] }
    } catch (e) {
      return laneFail(['created'], e)
    }
  }
  const lane = (await lanes.listLanes(ws, { all: true })).find((l) => l.id === c.target)
  if (!lane) return goneAll(c.fields)
  if (lane.state !== 'active' && lane.state !== 'paused') return { undone: [], skipped: c.fields.map((field) => ({ field, why: 'ended' as const })) } // i18n-ignore: a skip's code, worded by whoever shows it
  const now = infoValues(lane)
  const { back, undone, skipped } = plan(c.values, (f) => now[f])
  if (!back.length) return { undone, skipped }
  const r = await setBack(
    back,
    async (rest) => {
      try {
        await lanes.restoreLane(ws, c.target!, rest, BY_NAME[by], guard)
      } catch (e) {
        if (e instanceof lanes.LaneChangedSince && e.why === 'changed') throw new ChangedSince(e.fields)
        throw e
      }
    },
    laneFail
  )
  return { undone: [...undone, ...r.undone], skipped: [...skipped, ...r.skipped] }
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

/** An agent's settings: those still as the change left them go back, checked under the project's lock (an agent removed since is gone). */
async function undoAgent(ws: WorkspaceService, c: RecordedChange, guard?: () => void): Promise<Outcome> {
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
  const r = await setBack(set, async (rest) => {
    const check = (current: AgentDef): void => {
      const moved = rest.filter((v) => !sameValue(current[v.field as keyof AgentDef] ?? null, v.new)).map((v) => v.field)
      if (moved.length) throw new ChangedSince(moved)
      guard?.()
    }
    await updateAgent(projectPath, c.target!, agentPatch(rest), { check })
  })
  return { undone: [...undone, ...r.undone], skipped: [...skipped, ...failed, ...r.skipped] }
}

/**
 * A Hive setting: its value set back through the same checked change, refused at the moment of the change if it changed
 * since; a provider's removed models with it only while they too are as the change left them (else left, and said). The
 * Assistant's own undo only while Settings → Assistant → Control → Change settings is on, as any change of a setting.
 */
async function undoSetting(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard?: () => void): Promise<Outcome> {
  const value = c.values.find((v) => v.field === 'value')
  const removed = c.values.find((v) => v.field === 'removed')
  if (!value || !c.target) return { undone: [], skipped: [] }
  if (by === 'assistant' && config.settings.assistant?.changeSettings !== true) return failedAll(c.fields, new Error('Settings → Assistant → Control → Change settings is off: the user can undo it in your panel.')) // i18n-ignore: an Agent API reply (English)
  const projectPath = c.project && ws.path ? join(ws.path, c.project) : null
  const e = entryOf(c.target)
  const apply = async (withRemoved: boolean): Promise<void> => {
    await applySetting(
      e,
      value.old,
      projectPath,
      (current) => {
        if (!sameValue(current, value.new)) throw new ChangedSince(['value'])
        if (withRemoved && removed && e.provider && !sameValue(removedPrices(e.provider), removed.new)) throw new ChangedSince(['removed'])
        guard?.()
      },
      withRemoved && removed ? (removed.old as string[]) : undefined
    )
  }
  try {
    await apply(true)
    return { undone: c.fields, skipped: [] }
  } catch (err) {
    if (!(err instanceof ChangedSince)) return failedOr(c.fields, err)
    if (err.fields.includes('value')) return { undone: [], skipped: changed(c.fields) }
    // Only its removed models changed since: its value goes back alone, they stay.
    try {
      await apply(false)
      return { undone: ['value'], skipped: changed(['removed']) }
    } catch (again) {
      if (again instanceof ChangedSince) return { undone: [], skipped: changed(c.fields) }
      return failedOr(c.fields, again)
    }
  }
}

/** An agent it started: stopped only while the launch it started still runs (what it did meanwhile stays). */
async function undoStarted(ws: WorkspaceService, c: RecordedChange, guard?: () => void): Promise<Outcome> {
  const run = c.values.find((v) => v.field === 'run')?.new
  if (!ws.path || !c.project || !c.target || typeof run !== 'string') return goneAll(['running'])
  const projectPath = join(ws.path, c.project)
  // Another launch since (the user started it again), or none: not this change's to stop.
  if (sessions.liveFor(projectPath, c.target)?.runId !== run) return { undone: [], skipped: [{ field: 'running', why: 'ended' }] } // i18n-ignore: a skip's code, worded by whoever shows it
  try {
    guard?.()
    sessions.stop(projectPath, c.target)
    return { undone: ['running'], skipped: [] }
  } catch (e) {
    return failedOr(['running'], e)
  }
}
