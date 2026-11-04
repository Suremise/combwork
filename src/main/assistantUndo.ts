import { join } from 'path'
import { projectAgents } from '../shared/defaults'
import type { AgentDef, AgentPatch, AssistantUndoResult, LaneInfo, PageLayout, ProjectConfig, TaskCard, TaskPatch, WorkflowForm } from '../shared/types'
import { AGENT_FIELDS, CARD_FIELDS, CONNECTION_ID, cardValue, markUndone, notRecording, PROVIDER_DEPENDENTS, recordedChanges, REVIEW, reviewOf, sameValue, type CardField, type FieldChange, type RecordedChange, type Value } from './assistantChanges'
import * as assistant from './assistantControl'
import { boardWrite } from './boardStore'
import { config } from './config'
import * as lanes from './lanes'
import { updateAgent } from './projectAgents'
import { sessions } from './sessions'
import { applySetting, entryOf, removedPrices } from './settingsTools'
import * as tasks from './tasks'
import { isWorkflowRole } from '../shared/workflow/roles'
import { restoreProjectAgents } from './templates'
import { setWorkflowOptions, workflowForm, WorkflowStale } from './workflow/optionsForm'
import { inWorkspace, workspaceOf, type WorkspaceService } from './workspace'

/**
 * Undo for the Hive Assistant's changes (#1282, SPEC §16.14), from what assistantChanges.ts recorded: one change, or every
 * change of a message of the user's, newest first.
 *
 * The invariant (round 3): undo writes a value only if, at the write and under the target's own lock, the current value
 * still equals what the Assistant wrote; that holds for every value the write changes, those it changes implicitly too
 * (a provider's dependent settings, the agent and review a project move clears, the review a column move would stop).
 * Otherwise it skips and says so, never overwriting a later change; the rest still goes back. What a write did is read
 * inside the write itself, so what is reported is what it saved. The Assistant's own undo re-checks its guard (control
 * level, launch; Change settings for a setting) inside each write, every attempt: a refusal stops the whole undo, and
 * what was undone before stays marked. A change is marked undone only when every field ended undone or skipped for good
 * (changed, gone, ended); one with a failure, or stopped, stays to be tried again. Undo's own writes aren't recorded.
 */

/** Who undoes: the user (the window) or the Assistant (its tool). */
export type UndoBy = 'user' | 'assistant'

/** An undo asked for something that isn't there: no such change (kept 7 days), or no changes for that message. */
export class UndoNotFound extends Error {}

/** Fields found changed since at the moment of the write (under its lock): nothing written. */
class ChangedSince extends Error {
  constructor(public fields: string[]) {
    super(`changed since: ${fields.join(', ')}`) // i18n-ignore: an internal signal, never shown
  }
}

/** The undo's guard refused at a write (the Assistant's control turned down, its launch ended, Change settings off): the undo stops. */
class UndoStopped extends Error {
  constructor(public refusal: unknown) {
    super((refusal as Error)?.message ?? String(refusal))
  }
}

/** Whether an error, however a write wrapped it, is the undo's guard refusing. */
const stopped = (e: unknown): UndoStopped | null => (e instanceof UndoStopped ? e : (e as { cause?: unknown } | null)?.cause instanceof UndoStopped ? (e as { cause: UndoStopped }).cause : null)

/** What undo's guard runs at each write: the Assistant's own guard, its refusal turned into the undo's stop. */
type Guard = (() => void) | undefined

/**
 * Undoes the change `sel.change` names, or every change of the message `sel.group` names, newest first. A change undone
 * before is left as it is (`already`). `guard` (the Assistant's own undo): checked inside each write; its refusal stops
 * the undo and is thrown, what was undone before it kept and marked.
 */
export async function undoChanges(ws: WorkspaceService, sel: { change?: string; group?: string }, by: UndoBy, guard?: () => void): Promise<AssistantUndoResult[]> {
  const list = recordedChanges(ws, sel)
  // i18n-ignore: an Agent API refusal (English); the window offers only changes it listed
  if (!list.length) throw new UndoNotFound(sel.change ? `No change of the Assistant's ${sel.change} is kept (changes are kept 7 days).` : `No changes of the Assistant's are kept for message ${sel.group ?? ''} (they are kept 7 days).`)
  const g: Guard = guard
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
        // Done for good (each field undone, or skipped as changed, gone or ended): marked; a failure stays to try again.
        if (!r.skipped.some((s) => s.why === 'failed')) await markUndone(ws, c.id, { undone: r.undone, skipped: r.skipped.flatMap((s) => (s.why === 'failed' ? [] : [{ field: s.field, why: s.why }])) })
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
const NOT_BACK = 'It was saved, but not as it was: read it again.' // i18n-ignore: an Agent API reply (English)

/** A write's failure: the guard's refusal stops the undo (thrown on); another is the change's, said as failed. */
const failedOr = (fields: readonly string[], e: unknown): Outcome => {
  if (stopped(e)) throw e
  return failedAll(fields, e)
}

/** What a write saved, as read inside it: the fields now as they were (undone), and those that aren't (failed). */
function readBack(rest: readonly FieldChange[], now: (field: string) => unknown): Outcome {
  const undone = rest.filter((v) => sameValue(now(v.field), v.old)).map((v) => v.field)
  const off = rest.filter((v) => !undone.includes(v.field)).map((v) => v.field)
  return { undone, skipped: failedAll(off, new Error(NOT_BACK)).skipped }
}

function undoOne(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard: Guard): Promise<Outcome> {
  // A template's load (HI-1502): its agents and its workflow, recorded as agent changes of the project, named by their act.
  if (c.act === 'load-template') return undoLoaded(ws, c, guard)
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
 * nothing written) and returns what it saved, read inside it; then the rest is tried again alone, so a later change of
 * one field never keeps the others back.
 */
async function setBack(back: FieldChange[], write: (back: FieldChange[]) => Promise<Outcome>, fail: (fields: readonly string[], e: unknown) => Outcome = failedOr): Promise<Outcome> {
  let rest = back
  const skipped: Skipped = []
  while (rest.length) {
    try {
      const r = await write(rest)
      return { undone: r.undone, skipped: [...skipped, ...r.skipped] }
    } catch (e) {
      if (!(e instanceof ChangedSince)) return { undone: [], skipped: [...skipped, ...fail(rest.map((v) => v.field), e).skipped] }
      const moved = rest.filter((v) => e.fields.includes(v.field)).map((v) => v.field)
      skipped.push(...changed(moved))
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
 * checked under the board's lock. Its fields go back in one board transaction: a project move back first (only while the
 * card's agent and review are as the move left them: a later assignment or review is never cleared), then its agent, each
 * checked under the card's lock; both or neither. A column move back only while the card's review is as the change left it.
 */
async function undoCard(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard: Guard): Promise<Outcome> {
  const n = c.card!
  const actor: tasks.TaskActor = by === 'user' ? { kind: 'user' } : { kind: 'assistant' }
  const card = await inWorkspace(ws, () => tasks.getTask(n, ws)).catch(() => null)
  if (!card || card.archived) return goneAll(c.fields)
  if (c.fields.includes('created')) {
    const check = (now: TaskCard): void => {
      const since = historyAfter(now, c.target)
      if (!since || since.some((h) => h.by !== 'Combwork' && h.by !== 'Hive')) throw new ChangedSince(['created'])
      guard?.()
    }
    try {
      const saved = await inWorkspace(ws, () => tasks.archiveTask(n, true, { check, actor }))
      return saved.archived ? { undone: ['created'], skipped: [] } : failedAll(['created'], new Error(NOT_BACK))
    } catch (e) {
      if (e instanceof ChangedSince) return { undone: [], skipped: changed(['created']) }
      return failedOr(['created'], e)
    }
  }
  const values = c.values.filter((v) => (CARD_FIELDS as readonly string[]).includes(v.field))
  const review = c.values.find((v) => v.field === REVIEW)
  const agentChange = values.find((v) => v.field === 'agent')
  const { back, undone, skipped } = plan(values, (f) => cardValue(card, f as CardField))
  if (!back.length) return { undone, skipped }
  const r = await setBack(back, async (rest) => {
    const project = rest.find((v) => v.field === 'project')
    const agent = project ? rest.find((v) => v.field === 'agent') : undefined
    const first = rest.filter((v) => v !== agent)
    let saved: TaskCard | null = null
    // One board transaction: the project back and then its agent, both or neither (round 3).
    await boardWrite(ws, async () => {
      const patch: TaskPatch = {}
      for (const v of first) setCardField(patch, v.field as CardField, v.old as Value)
      // A move back skips what it must of the card's rules, as an override whose reason is the undo (SPEC §16.8.4); the
      // runtime writes the Override only when a rule refuses the move.
      if (patch.column) patch.override = { reason: 'undo' } // i18n-ignore: the override's reason, a code (SPEC §16.14)
      const check = (now: TaskCard): void => {
        const moved = first.filter((v) => !sameValue(cardValue(now, v.field as CardField), v.new)).map((v) => v.field)
        // A move (of project or column) would stop a review, or a project move clear an agent, given since: kept.
        const moves = first.filter((v) => v.field === 'project' || v.field === 'column').map((v) => v.field)
        if (moves.length && review && !sameValue(reviewOf(now), review.new)) moved.push(...moves)
        if (project && !sameValue(cardValue(now, 'agent'), agentChange ? agentChange.new : null)) moved.push('project', ...(agent ? ['agent'] : []))
        if (moved.length) throw new ChangedSince([...new Set(moved)])
      }
      await inWorkspace(ws, () => tasks.updateTask(n, patch, actor, { check, ...(guard ? { commit: guard } : {}) }))
      if (agent) {
        const checkAgent = (now: TaskCard): void => {
          if (!sameValue(cardValue(now, 'agent'), agent.new)) throw new ChangedSince(['project', 'agent'])
        }
        await inWorkspace(ws, () => tasks.updateTask(n, { agent: (agent.old as string | null) ?? '' }, actor, { check: checkAgent, ...(guard ? { commit: guard } : {}) }))
      }
      // What it saved, read inside its transaction.
      saved = await inWorkspace(ws, () => tasks.getTask(n, ws))
    })
    return readBack(rest, (f) => cardValue(saved!, f as CardField))
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
async function undoLane(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard: Guard): Promise<Outcome> {
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
        const saved = await lanes.restoreLane(ws, c.target!, rest, BY_NAME[by], guard)
        return readBack(rest, (f) => saved[f])
      } catch (e) {
        if (e instanceof lanes.LaneChangedSince && e.why === 'changed') throw new ChangedSince(e.fields)
        throw e
      }
    },
    laneFail
  )
  return { undone: [...undone, ...r.undone], skipped: [...skipped, ...r.skipped] }
}

/** The patch that sets an agent's setting back through updateAgent: an empty or missing one follows the project again. */
function agentPatch(back: readonly FieldChange[]): AgentPatch {
  const p: AgentPatch = {}
  for (const v of back) {
    const old = v.old as Value
    if (v.field === 'mcpServers') p.mcpServers = Array.isArray(old) ? (old as string[]) : null
    else if (v.field === 'workflowRole') p.workflowRole = isWorkflowRole(old) ? old : null
    else if (v.field === 'connection') p.connection = typeof old === 'string' ? old : null
    else if (v.field === 'name') p.name = typeof old === 'string' ? old : ''
  }
  return p
}

const PROVIDER_SET: readonly string[] = ['provider', ...PROVIDER_DEPENDENTS]
/** An agent's own launch settings as changes before HI-2108 recorded them: none can be put back since HI-2122. */
const OWN_LAUNCH = ['model', 'effort', 'permissionMode', 'use200kContext'] as const
const OWN_LAUNCH_GONE = "An agent has no model, effort, mode or context of its own any more: its connection holds them, which the user changes." // i18n-ignore: an Agent API reply (English)
const AGENT_RUNNING = 'Stop the agent before its provider goes back.' // i18n-ignore: an Agent API reply (English)

/** What of an agent a template's load made undo compares (HI-1502): who it is and its settings, never its conversation. */
const loadedFields = (a: AgentDef): Value => {
  const r = a as unknown as Record<string, unknown>
  return Object.fromEntries(['id', 'role', 'pairedWith', 'connection', ...AGENT_FIELDS].map((f) => [f, (r[f] ?? null) as Value]))
}
const sameAgents = (list: readonly AgentDef[], recorded: unknown): boolean => Array.isArray(recorded) && sameValue(list.map(loadedFields), (recorded as AgentDef[]).map(loadedFields))

/**
 * A template's load (HI-1502): its two changes, each undone alone. The agents and layout (`agents`, `layout`) go back
 * through the load's own replacement (templates.ts `restoreProjectAgents`: one at a time, the project's starts fenced,
 * the names checked against other projects' holding the names lock, the agents and layout checked under the project
 * file's lock to be exactly those the load left, none running or starting); an old name another project's agent has now
 * is never renamed: the change stays, said, to try again. The workflow options (`workflow`) go back through the Workflow
 * form's save, only while they are still those the load saved (`base`). Undo's guard is checked inside each write.
 */
async function undoLoaded(ws: WorkspaceService, c: RecordedChange, guard: Guard): Promise<Outcome> {
  if (!ws.path || !c.project) return goneAll(c.fields)
  const projectPath = join(ws.path, c.project)
  const field = (f: string): FieldChange | undefined => c.values.find((v) => v.field === f)
  const wf = field('workflow')
  if (wf) return undoLoadedWorkflow(ws, projectPath, wf, guard)
  const agents = field('agents')
  const layout = field('layout')
  if (!agents || !layout) return { undone: [], skipped: [] }
  const fields = ['agents', 'layout']
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  if (!cfg) return goneAll(fields)
  const now = (c2: ProjectConfig): { agents: AgentDef[]; layout: Value } => ({ agents: projectAgents(c2), layout: c2.layout ?? 'auto' })
  const cur = now(cfg)
  if (sameAgents(cur.agents, agents.old) && sameValue(cur.layout, layout.old)) return { undone: fields, skipped: [] }
  if (!sameAgents(cur.agents, agents.new) || !sameValue(cur.layout, layout.new)) return { undone: [], skipped: changed(fields) }
  try {
    await restoreProjectAgents(
      projectPath,
      { agents: agents.old as AgentDef[], layout: layout.old as PageLayout },
      (list, c2) => {
        if (!sameAgents(list, agents.new) || !sameValue(c2.layout ?? 'auto', layout.new)) throw new ChangedSince(fields)
        guard?.()
      },
      (clash) => new Error(`${clash.map((t) => `${t.name} is now ${t.project}'s agent`).join('; ')}: its agents weren't put back (agent names are unique across the workspace).`) // i18n-ignore: an Agent API reply (English)
    )
  } catch (e) {
    if (e instanceof ChangedSince) return { undone: [], skipped: changed(fields) }
    return failedOr(fields, e)
  }
  const saved = await ws.projectConfig(projectPath)
  return readBack([agents, layout], (f) => (f === 'agents' ? (sameAgents(projectAgents(saved), agents.old) ? agents.old : null) : (saved.layout ?? 'auto')))
}

/** A load's workflow options, set back through the Workflow form's save while they are still those the load saved. */
async function undoLoadedWorkflow(ws: WorkspaceService, projectPath: string, wf: FieldChange, guard: Guard): Promise<Outcome> {
  const own = (f: WorkflowForm): Value => ({ platform: f.platform, preset: f.preset, options: f.own as Value })
  const form = await workflowForm(ws, projectPath).catch(() => null)
  if (!form) return goneAll(['workflow'])
  if (sameValue(own(form), wf.old)) return { undone: ['workflow'], skipped: [] }
  if (!sameValue(own(form), wf.new)) return { undone: [], skipped: changed(['workflow']) }
  const old = wf.old as { preset: WorkflowForm['preset']; options: WorkflowForm['own'] }
  const was = wf.new as { preset: WorkflowForm['preset']; options: WorkflowForm['own'] }
  try {
    const saved = await setWorkflowOptions(ws, projectPath, { preset: old.preset, options: old.options, base: { preset: was.preset, options: was.options } }, { check: () => guard?.() })
    return readBack([wf], () => own(saved))
  } catch (e) {
    if (e instanceof WorkflowStale) return { undone: [], skipped: changed(['workflow']) }
    return failedOr(['workflow'], e)
  }
}

/**
 * An agent's settings, each checked under the project's lock. Its provider goes back only with every setting a provider
 * change resets (model, effort, permission mode, context, its last conversation), each still as the change left it, in
 * one write of the agent as it was (an absent one absent again: a provider it inherited is inherited again), and never
 * while the agent runs; one of them changed since keeps them all. Its other settings go through updateAgent.
 */
/**
 * An agent's connection set back (HI-2109's Choose Connections…, recorded by its id as `connectionId`, with `provider`
 * and `lastSessionId` when its CLI changed with it): all of them or none, only while each is still as the change left
 * it (read under the project's lock, in updateAgent's check), and its CLI only while it is stopped.
 */
async function undoConnection(projectPath: string, agentId: string, def: AgentDef, values: readonly FieldChange[], guard: Guard): Promise<Outcome> {
  const fields = values.map((v) => v.field)
  const raw = (d: AgentDef, f: string): unknown => (f === CONNECTION_ID ? (d.connection ?? null) : ((d as unknown as Record<string, unknown>)[f] ?? null))
  if (values.every((v) => sameValue(raw(def, v.field), v.old))) return { undone: fields, skipped: [] }
  const connection = values.find((v) => v.field === CONNECTION_ID)!
  const provider = values.find((v) => v.field === 'provider')
  try {
    if (provider && sessions.liveFor(projectPath, agentId)) throw new Error(AGENT_RUNNING)
    const session = values.find((v) => v.field === 'lastSessionId')
    // One write, under the project's lock: every field it recorded (its last conversation too) still as the change left
    // it, and all of them set back together.
    const saved = await updateAgent(projectPath, agentId, { connection: (connection.old ?? null) as string | null, ...(provider ? { provider: provider.old as AgentDef['provider'] } : {}) }, {
      ...(session ? { session: (session.old ?? null) as string | null } : {}),
      check: (cur) => {
        if (provider && sessions.liveFor(projectPath, agentId)) throw new Error(AGENT_RUNNING)
        if (values.some((v) => !sameValue(raw(cur, v.field), v.new))) throw new ChangedSince(fields)
        guard?.()
      }
    })
    await workspaceOf(projectPath).refresh()
    return readBack(values, (f) => raw(saved, f))
  } catch (e) {
    if (e instanceof ChangedSince) return { undone: [], skipped: changed(fields) }
    return failedOr(fields, e)
  }
}

async function undoAgent(ws: WorkspaceService, c: RecordedChange, guard: Guard): Promise<Outcome> {
  if (!ws.path || !c.project || !c.target) return goneAll(c.fields)
  const projectPath = join(ws.path, c.project)
  const agentId = c.target
  const cfg = await ws.projectConfig(projectPath).catch(() => null)
  const def = cfg ? projectAgents(cfg).find((a) => a.id === agentId) : undefined
  if (!def) return goneAll(c.fields)
  // Choose Connections… (HI-2109): its connection by id, with its CLI and last conversation when they changed with it.
  if (c.values.some((v) => v.field === CONNECTION_ID)) return undoConnection(projectPath, agentId, def, c.values, guard)
  const current = (d: AgentDef, f: string): unknown => d[f as keyof AgentDef] ?? null
  // A model, effort, mode or context recorded as the agent's before HI-2108: an agent has none of its own since HI-2122,
  // so it can't be put back (its connection holds them: the user changes that connection).
  const ownLaunch = c.values.filter((v) => (OWN_LAUNCH as readonly string[]).includes(v.field))
  const values = c.values.filter((v) => !ownLaunch.includes(v))
  const withProvider = values.some((v) => v.field === 'provider')
  const set = withProvider ? values.filter((v) => PROVIDER_SET.includes(v.field)) : []
  const others = values.filter((v) => !set.includes(v))
  const out: Outcome = { undone: [], skipped: ownLaunch.map((v) => ({ field: v.field, why: 'failed' as const, error: OWN_LAUNCH_GONE })) } // i18n-ignore: an Agent API reply (English)
  // Its other settings: each as any undo of a field, through updateAgent and its check.
  const { back, undone, skipped } = plan(others, (f) => current(def, f))
  out.undone.push(...undone)
  out.skipped.push(...skipped)
  if (back.length) {
    const r = await setBack(back, async (rest) => {
      let saved: AgentDef | null = null
      const check = (cur: AgentDef): void => {
        const moved = rest.filter((v) => !sameValue(current(cur, v.field), v.new)).map((v) => v.field)
        if (moved.length) throw new ChangedSince(moved)
        guard?.()
      }
      saved = await updateAgent(projectPath, agentId, agentPatch(rest), { check })
      return readBack(rest, (f) => current(saved!, f))
    })
    out.undone.push(...r.undone)
    out.skipped.push(...r.skipped)
  }
  // Its provider, with everything a provider change resets: all of it or none.
  if (set.length) {
    const fields = set.map((v) => v.field)
    if (set.every((v) => sameValue(current(def, v.field), v.old))) out.undone.push(...fields)
    else {
      try {
        // Its CLI and connection through updateAgent (HI-2108: its CLI follows its connection), its last conversation
        // after, in the agent's own write.
        const launch = set.filter((v) => v.field !== 'lastSessionId')
        const patch: AgentPatch = { ...agentPatch(launch), provider: (set.find((v) => v.field === 'provider')?.old ?? undefined) as AgentDef['provider'] }
        if (sessions.liveFor(projectPath, agentId)) throw new Error(AGENT_RUNNING)
        let saved = await updateAgent(projectPath, agentId, patch, {
          check: (cur) => {
            if (sessions.liveFor(projectPath, agentId)) throw new Error(AGENT_RUNNING)
            if (set.some((v) => !sameValue(current(cur, v.field), v.new))) throw new ChangedSince(fields)
            guard?.()
          }
        })
        const session = set.find((v) => v.field === 'lastSessionId')
        if (session) saved = await workspaceOf(projectPath).updateAgent(projectPath, agentId, { lastSessionId: (session.old ?? undefined) as string | undefined })
        await workspaceOf(projectPath).refresh()
        const r = readBack(set, (f) => current(saved, f))
        out.undone.push(...r.undone)
        out.skipped.push(...r.skipped)
      } catch (e) {
        if (e instanceof ChangedSince) out.skipped.push(...changed(fields))
        else out.skipped.push(...failedOr(fields, e).skipped)
      }
    }
  }
  return out
}

/**
 * A Hive setting: its value set back through the same checked change, refused at the moment of the change if it changed
 * since; a provider's removed models with it only while they too are as the change left them (else the value alone is
 * tried again, under the same checks). The guard is checked inside the change on every attempt: the Assistant's control
 * and launch, and for its own undo Change settings, whose refusal stops the undo.
 */
async function undoSetting(ws: WorkspaceService, c: RecordedChange, by: UndoBy, guard: Guard): Promise<Outcome> {
  const value = c.values.find((v) => v.field === 'value')
  const removed = c.values.find((v) => v.field === 'removed')
  if (!value || !c.target) return { undone: [], skipped: [] }
  const projectPath = c.project && ws.path ? join(ws.path, c.project) : null
  const e = entryOf(c.target)
  const apply = async (withRemoved: boolean): Promise<Outcome> => {
    const r = await applySetting(
      e,
      value.old,
      projectPath,
      (current) => {
        guard?.()
        if (by === 'assistant' && config.settings.assistant?.changeSettings !== true) throw new UndoStopped(new Error('Settings → Assistant → Control → Change settings is off: the user can undo it in your panel.')) // i18n-ignore: an Agent API refusal (English)
        if (!sameValue(current, value.new)) throw new ChangedSince(['value'])
        if (withRemoved && removed && e.provider && !sameValue(removedPrices(e.provider), removed.new)) throw new ChangedSince(['removed'])
      },
      withRemoved && removed ? (removed.old as string[]) : undefined
    )
    // What the change saved, as it returned it.
    const fields = withRemoved && removed ? [value, removed] : [value]
    return readBack(fields, (f) => (f === 'value' ? r.new : (r.removed?.new ?? (e.provider ? removedPrices(e.provider) : null))))
  }
  try {
    return await apply(true)
  } catch (err) {
    if (!(err instanceof ChangedSince)) return failedOr(c.fields, err)
    if (err.fields.includes('value')) return { undone: [], skipped: changed(c.fields) }
    // Only its removed models changed since: its value goes back alone, they stay.
    try {
      const r = await apply(false)
      return { undone: r.undone, skipped: [...r.skipped, ...changed(['removed'])] }
    } catch (again) {
      if (again instanceof ChangedSince) return { undone: [], skipped: changed(c.fields) }
      return failedOr(c.fields, again)
    }
  }
}

/** An agent it started: stopped only while the launch the start returned still runs (what it did meanwhile stays). */
async function undoStarted(ws: WorkspaceService, c: RecordedChange, guard: Guard): Promise<Outcome> {
  const run = c.values.find((v) => v.field === 'run')?.new
  if (!ws.path || !c.project || !c.target || typeof run !== 'string') return goneAll(['running'])
  const projectPath = join(ws.path, c.project)
  // Another launch since (the user started it again), or none: not this change's to stop. Checked and stopped with
  // nothing awaited between.
  if (sessions.liveFor(projectPath, c.target)?.runId !== run) return { undone: [], skipped: [{ field: 'running', why: 'ended' }] } // i18n-ignore: a skip's code, worded by whoever shows it
  try {
    guard?.()
    sessions.stop(projectPath, c.target)
    return { undone: ['running'], skipped: [] }
  } catch (e) {
    return failedOr(['running'], e)
  }
}
