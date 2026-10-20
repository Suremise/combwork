// Recording facts from today's moves (#1216, SPEC §16.4.2; P3: "facts recorded", nothing refused). Every card change is
// saved by tasks.ts' saveCard, which hands this the card as it was and as it is now: each move leaves its facts in the
// same transaction (a column change `Moved`, into Doing with an agent `Started`, into Review `Submitted`, a review's start
// and verdict, blocked and unblocked, a decision recorded), and the card's stage cache follows. Nothing here refuses:
// P4's gates will read these facts.
//
// Platform reads (Git: the folder's line, head, the merge base with the target, the files changed, the candidate key)
// are slow, so they are made before the change's transaction, outside the board's lock (`gatherReads`, from the public
// entry points of tasks.ts), and handed in through the change's context. A read that couldn't be made never refuses:
// its field is null and the fact names it, with why, in `platform.unknown`.

import { AsyncLocalStorage } from 'async_hooks'
import { join } from 'path'
import { projectAgents } from '../../shared/defaults'
import { HISTORY } from '../../shared/taskHistory'
import type { TaskCard } from '../../shared/types'
import type { Actor, Fact, FileChange, StageId } from '../../shared/workflow/facts'
import { compile, type Ruleset } from '../../shared/workflow/compile'
import type { WorkflowOptions } from '../../shared/workflow/options'
import { agentActor, foldCard } from '../../shared/workflow/facts'
import { boardRead, boardReadOnly, boardWrite } from '../boardStore'
import { createLogger } from '../logger'
import * as G from '../platform/git'
import { projectPlatform } from '../platform/registry'
import { isUnknown, type Maybe } from '../platform/types'
import type { WorkspaceService } from '../workspace'
import { FactStore } from './factStore'

const log = createLogger('workflow')

/** Who made a change, as tasks.ts has it. */
export type ChangeActor = { kind: 'user' } | { kind: 'assistant' } | { kind: 'agent'; name: string; self?: { project: string; agentId: string } }

/** What the platform said of a card's folder, read before its change (outside the lock). */
export interface Reads {
  /** The agent the reads were made for, and its folder (`project`, or its worktree's path). */
  agent: string
  folder: string
  line: string | null
  head: string | null
  target: string | null
  /** The merge base of the folder's head with the target's (a start), or the start's base (a submission). */
  base: string | null
  files: FileChange[]
  key: string | null
  /** The project's ruleset now (a start's: the options in project.json, `workflow`, compiled; SPEC §16.6). */
  ruleset?: Ruleset
  /** Each field that couldn't be read, and why. */
  unknown: Record<string, string>
}

/** A change's context: who made it, and the reads made for its cards before it. */
interface Context {
  actor: ChangeActor
  reads: Map<number, Reads>
}
const context = new AsyncLocalStorage<Context>()

/** Runs a card change (inside its board change) with who made it and the reads made for it, for the facts it saves. */
export function recording<T>(actor: ChangeActor, reads: Map<number, Reads> | null, fn: () => Promise<T>): Promise<T> {
  return context.run({ actor, reads: reads ?? new Map() }, fn)
}

/** Runs a card change as this actor's, keeping the reads its caller made before it (a change inside another, a batch's card). */
export function recordingAs<T>(actor: ChangeActor, fn: () => Promise<T>): Promise<T> {
  return context.run({ actor, reads: context.getStore()?.reads ?? new Map() }, fn)
}

/** The reads made for a card not made yet (tasks.ts' createTask), before its number is taken. */
const NEW_CARD = 0

/** A fact's actor (§16.4.1): the user, the Assistant, an agent by its id, or Hive itself. */
export function actorOf(a: ChangeActor | undefined): Actor {
  if (!a) return 'hive'
  if (a.kind === 'user') return 'user'
  if (a.kind === 'assistant') return 'assistant'
  if (a.self) return agentActor(a.self.agentId)
  return a.name === 'Hive' || a.name === 'Repair' ? 'hive' : agentActor(a.name)
}

/** The stage a column stands for (P3: a move is to the column's stage). */
const STAGE_OF: Record<TaskCard['column'], StageId> = { hold: 'hold', todo: 'todo', doing: 'active', review: 'review', passed: 'approved', done: 'done' }

/** What may happen to a card in a change, before it is made: whose folder to read, and for what. */
export interface Planned {
  number: number
  project: string
  /** The agent the card will have (id), if any. */
  agent: string | null
  why: 'start' | 'submit'
}

/**
 * The platform reads a change may need, made before it (outside the board's lock): for a card going into Doing with an
 * agent (where its work starts) or into Review (what is submitted). Never throws: a read that fails is named in `unknown`.
 */
export async function gatherReads(ws: WorkspaceService, planned: Planned[]): Promise<Map<number, Reads>> {
  const out = new Map<number, Reads>()
  for (const p of planned) {
    if (!p.agent || !p.project || !ws.path) continue
    try {
      out.set(p.number, await readsFor(ws, p))
    } catch (e) {
      log.warn(`reading the work of #${p.number} before its change`, e)
    }
  }
  return out
}

/** For tests: told of each card's reads as they begin (whether that is inside a board change: it never should be). */
export const recorderTestHooks: { onRead: ((n: number) => void) | null } = { onRead: null }

async function readsFor(ws: WorkspaceService, p: Planned): Promise<Reads> {
  recorderTestHooks.onRead?.(p.number)
  const projectPath = join(ws.path!, p.project)
  const cfg = await ws.projectConfig(projectPath)
  const def = projectAgents(cfg).find((a) => a.id === p.agent)
  const folder = def?.worktree?.path ?? projectPath
  const r: Reads = { agent: p.agent!, folder: def?.worktree ? folder : 'project', line: null, head: null, target: null, base: null, files: [], key: null, unknown: {} }
  // The ruleset the card starts under (HR4's round 1 finding 7): the project's options as #1218 keeps them, compiled.
  if (p.why === 'start') {
    const options = (cfg as { workflow?: { options?: unknown } }).workflow?.options
    try {
      const c = options && typeof options === 'object' ? compile(options as WorkflowOptions) : null
      if (c?.ok) r.ruleset = c.ruleset
      else r.unknown.ruleset = c ? `the project's options contradict each other (${c.contradictions.join(', ')})` : "the project has no options yet (project.json's workflow)"
    } catch (e) {
      r.unknown.ruleset = `the project's options couldn't be read (${e instanceof Error ? e.message : String(e)})`
    }
  }
  // None (no version control): no line, head or base yet (P5 adds its manifests).
  if (projectPlatform(projectPath, cfg.platform).id !== 'git') return r
  const take = <T>(field: string, v: Maybe<T>): T | null => {
    if (isUnknown(v)) {
      r.unknown[field] = v.what
      return null
    }
    return v
  }
  r.line = take('line', await G.branch(folder))
  r.head = take('head', await G.head(folder))
  r.target = def?.worktree?.base ?? take('target', await G.defaultBranch(folder))
  if (p.why === 'start') {
    const targetHead = r.target ? take('base', await G.lineHead(folder, r.target)) : null
    r.base = r.head && targetHead ? take('base', await G.mergeBase(folder, r.head, targetHead)) : null
    // Not read: why (its head or target couldn't be read, or there is no target to start from).
    if (!r.base && !r.unknown.base) r.unknown.base = r.unknown.head ?? r.unknown.target ?? 'no target to start from'
    return r
  }
  // A submission: from where its work started (its Started), else the merge base with the target now.
  const started = FactStore.forBoard(ws, { project: p.project, key: '' }).facts(p.number)
  r.base = foldCard(started).started?.base ?? null
  if (!r.base && r.head && r.target) {
    const targetHead = take('base', await G.lineHead(folder, r.target))
    r.base = targetHead ? take('base', await G.mergeBase(folder, r.head, targetHead)) : null
  }
  if (r.base && r.head) {
    r.files = take('files', await G.filesChanged(folder, r.base, r.head)) ?? []
    r.key = take('key', await G.candidateKey(folder, r.base, r.head))
  } else {
    r.unknown.files ??= 'no base or head to compare'
  }
  return r
}

/** A history entry or comment new in `after` (not in `before`), by id. */
const added = <T extends { id?: string }>(before: readonly T[], after: readonly T[]): T[] => {
  const had = new Set(before.map((x) => x.id))
  return after.filter((x) => !had.has(x.id))
}

/** The review round a card is in: its failed reviews since it last passed, and one (today's returnRound's count). */
const roundOf = (card: TaskCard): number => {
  const passed = card.history.findLastIndex((h) => h.whatText?.id === HISTORY.reviewPassed.id)
  return card.history.slice(passed + 1).filter((h) => h.whatText?.id === HISTORY.reviewFailed.id).length + 1
}

/**
 * The facts of a card's change, written in its transaction (from saveCard, inside the change): what moved, what started
 * or was submitted, a review's start or verdict, blocked or unblocked, its decisions' changes. `before` is null for a new
 * card. A card from before 1.0 gets none until it starts, which makes it a 1.0 card (Darren, #1119 decision 4). Never
 * refuses for what it couldn't read (named unknown), but a failure to write fails the change whole (HR4's #1216 round 1:
 * a card and its facts never diverge).
 */
export function recordChange(ws: WorkspaceService, before: TaskCard | null, after: TaskCard): void {
  try {
    write(ws, context.getStore(), before, after)
  } catch (e) {
    throw e instanceof FactWriteError ? e : new FactWriteError(e)
  }
}

/** A card's facts couldn't be written: its change fails whole, a batch's too (never a card without its facts). */
export class FactWriteError extends Error {
  constructor(cause: unknown) {
    super(`The card's facts couldn't be saved (${cause instanceof Error ? cause.message : String(cause)}): nothing of the change was saved`) // i18n-ignore: an error from the database's side, shown as the reason a change failed like a system error
    this.cause = cause
  }
}

/**
 * Whether an error is the board's storage failing (a card's facts, or SQLite itself), not a refusal of the change: a
 * batch that skips a refused card fails whole on this, since part of the card may have been written (HR4's #1216 round 2).
 */
export const isStorageError = (e: unknown): boolean => e instanceof FactWriteError || (e as { code?: unknown } | null)?.code === 'ERR_SQLITE_ERROR'

/**
 * Cards' decision generations (the newest `Decision` fact's; 0 for none, or a board without facts), read in the snapshot
 * the caller is in: what a reply or a line gives an agent is bound to the generation read with it (HR4's round 2).
 */
export function decisionGenerations(ws: WorkspaceService, numbers: number[]): Map<number, number> {
  const out = new Map<number, number>()
  if (!numbers.length) return out
  try {
    const rows = boardRead(ws, (db) => db.prepare("SELECT card, max(json_extract(data, '$.generation')) AS g FROM card_facts WHERE kind = 'Decision' AND card IN (SELECT value FROM json_each(?)) GROUP BY card").all(JSON.stringify(numbers)) as { card: number; g: number }[]) // i18n-ignore: SQL
    for (const r of rows) out.set(r.card, Number(r.g) || 0)
  } catch {
    // A board waiting for its upgrade has no facts: none.
  }
  return out
}

function write(ws: WorkspaceService, ctx: Context | undefined, before: TaskCard | null, after: TaskCard): void {
  const n = after.number
  const actor = actorOf(ctx?.actor)
  const store = FactStore.forBoard(ws, { project: after.project, key: '' })
  const record = store.card(n)
  // The stage before this change: its cache, else its column's (the row is already saved with the new column); a new
  // card's starts in Todo (HR4's round 1 finding 6: its first move is recorded like any other).
  const cached = boardRead(ws, (db) => (db.prepare('SELECT stage FROM cards WHERE number = ?').get(n) as { stage: StageId | null } | undefined)?.stage ?? null)
  const was: StageId = before ? (cached ?? STAGE_OF[before.column]) : 'todo'
  const earlier = foldCard(store.facts(n), was)
  const to = STAGE_OF[after.column]
  const history = added(before?.history ?? [], after.history)
  const returned = history.some((h) => h.whatText?.id === HISTORY.returned.id)
  // A new work cycle only for a real start (HR4's round 1 finding 1): none yet, or one that ended Done (reopened). A
  // card back in Doing for its review's fixes, or out of Hold, goes on in its cycle, its base and rounds kept.
  const intoDoing = after.column === 'doing' && !!after.agent && (!before || before.column !== 'doing' || before.agent !== after.agent)
  const starts = intoDoing && (!earlier.started || earlier.stage === 'done' || before?.column === 'done')
  const intoReview = after.column === 'review' && (!before || before.column !== 'review' || returned)
  const comment = added(before?.comments ?? [], after.comments).at(-1)?.id ?? ''
  // Before 1.0 until it starts (its mark cleared by the start): no facts.
  if (record.preWorkflow && !starts) return
  const reads = ctx?.reads.get(n) ?? (before ? undefined : ctx?.reads.get(NEW_CARD))
  store.tx((tx) => {
    let generation = earlier.generation
    const decision = (d: { id: string; text: string }, removed = false): void =>
      void tx.append(n, { kind: 'Decision', actor, source: 'recorded', ...ruleset(), data: { decision: d.id, generation: ++generation, text: d.text, ...(removed ? { removed: true } : {}) } })
    // The ruleset the card's cycle works under (its Started's), on each fact of it.
    const ruleset = (): { ruleset?: string } => {
      const id = tx.facts(n).findLast((f) => f.kind === 'Started')?.ruleset
      return id ? { ruleset: id } : {}
    }
    if (record.preWorkflow) {
      store.updateCard(n, { preWorkflow: false })
      // What it was decided before it became a 1.0 card, as it stands: what later receipts are matched with.
      for (const d of before?.decisions ?? []) decision(d)
    }
    const facts = () => foldCard(tx.facts(n), was)
    if (starts) {
      const mine = reads && reads.agent === after.agent ? reads : null
      if (mine?.ruleset) tx.saveRuleset(mine.ruleset)
      tx.append(n, {
        kind: 'Started',
        actor,
        source: 'recorded',
        ...(mine?.ruleset ? { ruleset: mine.ruleset.id } : {}),
        data: {
          folder: mine?.folder ?? 'project',
          line: mine?.line ?? null,
          base: mine?.base ?? null,
          target: mine?.target ?? null,
          builder: after.agent!,
          cardKind: record.kind,
          ...unknownOf(mine, ['line', 'base', 'target', 'ruleset'])
        }
      })
    }
    if (was !== to) {
      tx.append(n, { kind: 'Moved', actor, source: 'recorded', ...ruleset(), data: { from: was, to, cause: causeOf(ctx?.actor) } })
      tx.setStage(n, to)
    }
    if (intoReview) {
      const s = facts()
      const builder = after.agent ?? s.started?.builder ?? null
      const failed = s.latest && s.verdicts.findLast((v) => v.submission === s.latest!.id && !v.pass)
      const common = { round: roundOf(after), generation: builder ? (s.received[builder] ?? 0) : 0, summary: comment }
      // A no-code card has no revision (SPEC §16.7.3): its submission is its summary.
      const data =
        record.kind === 'no-code'
          ? { revision: null, base: null, head: null, key: null, files: [], sameRevision: !!failed, ...common }
          : (() => {
              const mine = reads && reads.agent === after.agent ? reads : null
              return {
                revision: mine?.head ?? null,
                base: mine?.base ?? null,
                head: mine?.head ?? null,
                key: mine?.key ?? null,
                files: mine?.files ?? [],
                sameRevision: !!failed && !!mine?.head && failed.revision === mine.head,
                ...common,
                ...unknownOf(mine, ['revision', 'base', 'files', 'key'])
              }
            })()
      tx.append(n, { kind: 'Submitted', actor, source: 'recorded', ...ruleset(), data })
    }
    if (after.review && (!before?.review || before.review.agent !== after.review.agent)) {
      const s = facts()
      tx.append(n, { kind: 'ReviewStarted', actor, source: 'recorded', ...ruleset(), data: { reviewer: after.review.agent, submission: s.latest?.id ?? 0, revision: s.latest?.revision ?? null } })
    }
    for (const h of history) {
      if (h.whatText?.id !== HISTORY.reviewPassed.id && h.whatText?.id !== HISTORY.reviewFailed.id) continue
      const s = facts()
      const reviewer = before?.review?.agent ?? (ctx?.actor.kind === 'agent' ? (ctx.actor.self?.agentId ?? ctx.actor.name) : 'unknown')
      // The generation the reviewer had received (HR4's round 1 finding 4): never decisions it hasn't seen.
      tx.append(n, {
        kind: 'Verdict',
        actor,
        source: 'recorded',
        ...ruleset(),
        data: { reviewer, submission: s.latest?.id ?? 0, revision: s.latest?.revision ?? null, pass: h.whatText.id === HISTORY.reviewPassed.id, round: roundOf(before ?? after), generation: s.received[reviewer] ?? 0, comment }
      })
    }
    if ((before?.blocked ?? null) !== after.blocked) {
      if (after.blocked) tx.append(n, { kind: 'Blocked', actor, source: 'recorded', ...ruleset(), data: { reason: after.blocked } })
      else if (before?.blocked) tx.append(n, { kind: 'Unblocked', actor, source: 'recorded', ...ruleset(), data: {} })
    }
    // Each change of its decisions, a new generation each (HR4's round 1 finding 3): added, its words changed, removed.
    // Compared with what it had (a card starting from before 1.0: as just recorded above, once).
    const had = new Map((before?.decisions ?? []).map((d) => [d.id, d.text]))
    const now = new Map((after.decisions ?? []).map((d) => [d.id, d.text]))
    for (const [id, text] of now) if (!had.has(id) || had.get(id) !== text) decision({ id, text })
    for (const [id, text] of had) if (!now.has(id)) decision({ id, text }, true)
  })
}

/** A move's cause (§16.4.2): the user's from the window, an agent's or the Assistant's by its tools or the API, Hive's derived. */
function causeOf(a: ChangeActor | undefined): 'intent' | 'user' | 'derived' {
  if (!a) return 'derived'
  if (a.kind === 'user') return 'user'
  return actorOf(a) === 'hive' ? 'derived' : 'intent'
}

/** The fields of a fact that couldn't be read, and why (as `platform.unknown`); none when the reads weren't made at all, named so. */
function unknownOf(r: Reads | null, fields: string[]): { platform?: Record<string, unknown> } {
  if (!r) return { platform: { unknown: Object.fromEntries(fields.map((f) => [f, 'not read before the change'])) } }
  const map: Record<string, string> = {}
  for (const f of fields) {
    const from = f === 'revision' ? 'head' : f
    if (r.unknown[from]) map[f] = r.unknown[from]
  }
  return Object.keys(map).length ? { platform: { unknown: map } } : {}
}

/**
 * What an agent received of a card's decisions (`DecisionsReceived`): the card read in full (hive_read_task), or a line
 * telling it of new decisions (a decision delivery) received. Bound to what it was given (HR4's #1216 rounds 1 and 2):
 * `generation` is the card's decision generation read in the same snapshot as the decisions it was given, never one
 * looked up later. Recorded once per generation, in a board change of its own, only while the workspace (and the card's
 * project, when given) is the one the receipt was for. In the background: never in the read's way.
 */
export async function recordDecisionsReceived(ws: WorkspaceService, agentId: string, n: number, generation: number, project?: string): Promise<void> {
  const path = ws.path
  if (!path || !(generation > 0)) return
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path
  try {
    await boardWrite(
      ws,
      async () => {
        if (!alive()) return
        const card = boardRead(ws, (db) => db.prepare('SELECT project, pre_workflow FROM cards WHERE number = ?').get(n) as { project: string; pre_workflow: number } | undefined)
        if (!card || card.pre_workflow || (project !== undefined && card.project.toLowerCase() !== project.toLowerCase())) return
        const store = FactStore.forBoard(ws, { project: card.project, key: '' })
        if ((foldCard(store.facts(n)).received[agentId] ?? 0) >= generation) return
        store.tx((tx) => tx.append(n, { kind: 'DecisionsReceived', actor: agentActor(agentId), source: 'recorded', data: { agent: agentId, generation } }))
      },
      { alive }
    )
  } catch (e) {
    if (alive()) log.warn(`recording what an agent received of #${n}'s decisions`, e)
  }
}

/** A card's facts, oldest first (the window's `tasks:facts`; #1223's work view builds on them): none for an unknown card or a board waiting for its upgrade. */
export function cardFacts(ws: WorkspaceService, n: number): Fact[] {
  if (!ws.path || !Number.isInteger(n) || boardReadOnly(ws)) return []
  return FactStore.forBoard(ws, { project: '', key: '' }).facts(n)
}
