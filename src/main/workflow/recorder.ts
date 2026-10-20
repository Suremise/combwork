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
import { agentActor, foldCard } from '../../shared/workflow/facts'
import { boardRead, boardReadOnly, boardWrite } from '../boardStore'
import { createLogger, userText } from '../logger'
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

async function readsFor(ws: WorkspaceService, p: Planned): Promise<Reads> {
  const projectPath = join(ws.path!, p.project)
  const cfg = await ws.projectConfig(projectPath)
  const def = projectAgents(cfg).find((a) => a.id === p.agent)
  const folder = def?.worktree?.path ?? projectPath
  const r: Reads = { agent: p.agent!, folder: def?.worktree ? folder : 'project', line: null, head: null, target: null, base: null, files: [], key: null, unknown: {} }
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
 * or was submitted, a review's start or verdict, blocked or unblocked, a decision. `before` is null for a new card. A card
 * from before 1.0 gets none until it starts, which makes it a 1.0 card (Darren, #1119 decision 4). Never refuses: a
 * failure here is logged and the change goes on (P3 records; it doesn't decide), unless SQLite undid the transaction,
 * which fails the change whole as any other write.
 */
export function recordChange(ws: WorkspaceService, before: TaskCard | null, after: TaskCard): void {
  const ctx = context.getStore()
  try {
    write(ws, ctx, before, after)
  } catch (e) {
    log.warn(`recording the facts of #${after.number}'s change (${userText(after.title)})`, e)
  }
}

function write(ws: WorkspaceService, ctx: Context | undefined, before: TaskCard | null, after: TaskCard): void {
  const n = after.number
  const actor = actorOf(ctx?.actor)
  const store = FactStore.forBoard(ws, { project: after.project, key: '' })
  const record = store.card(n)
  // The stage before this change: its cache, else its column's (the row is already saved with the new column).
  const cached = boardRead(ws, (db) => (db.prepare('SELECT stage FROM cards WHERE number = ?').get(n) as { stage: StageId | null } | undefined)?.stage ?? null)
  const was: StageId = cached ?? (before ? STAGE_OF[before.column] : STAGE_OF[after.column])
  const moved = !!before && before.column !== after.column
  const intoDoing = after.column === 'doing' && !!after.agent && (!before || before.column !== 'doing' || before.agent !== after.agent)
  const history = added(before?.history ?? [], after.history)
  const returned = history.some((h) => h.whatText?.id === HISTORY.returned.id)
  const intoReview = after.column === 'review' && !!before && (before.column !== 'review' || returned)
  const comment = added(before?.comments ?? [], after.comments).at(-1)?.id ?? ''
  // Before 1.0 until it starts (its mark cleared by the start): no facts.
  if (record.preWorkflow && !intoDoing) return
  store.tx((tx) => {
    if (record.preWorkflow) store.updateCard(n, { preWorkflow: false })
    const facts = () => foldCard(tx.facts(n), was)
    if (intoDoing) {
      const r = ctx?.reads.get(n) ?? (before ? undefined : ctx?.reads.get(NEW_CARD))
      const mine = r && r.agent === after.agent ? r : null
      tx.append(n, {
        kind: 'Started',
        actor,
        source: 'recorded',
        data: {
          folder: mine?.folder ?? 'project',
          line: mine?.line ?? null,
          base: mine?.base ?? null,
          target: mine?.target ?? null,
          builder: after.agent!,
          cardKind: record.kind,
          ...unknownOf(mine, ['line', 'base', 'target'])
        }
      })
    }
    if (moved || !before) {
      const from = was
      const to = STAGE_OF[after.column]
      if (moved && from !== to) tx.append(n, { kind: 'Moved', actor, source: 'recorded', data: { from, to, cause: causeOf(ctx?.actor) } })
      if (from !== to) tx.setStage(n, to)
    }
    if (intoReview) {
      const s = facts()
      const r = ctx?.reads.get(n)
      const mine = r && r.agent === after.agent ? r : null
      const builder = after.agent ?? s.started?.builder ?? null
      const failed = s.latest && s.verdicts.findLast((v) => v.submission === s.latest!.id && !v.pass)
      tx.append(n, {
        kind: 'Submitted',
        actor,
        source: 'recorded',
        data: {
          revision: mine?.head ?? null,
          base: mine?.base ?? null,
          head: mine?.head ?? null,
          key: mine?.key ?? null,
          files: mine?.files ?? [],
          round: roundOf(after),
          generation: builder ? (s.received[builder] ?? 0) : 0,
          sameRevision: !!failed && !!mine?.head && failed.revision === mine.head,
          summary: comment,
          ...unknownOf(mine, ['revision', 'base', 'files', 'key'])
        }
      })
    }
    if (after.review && (!before?.review || before.review.agent !== after.review.agent)) {
      const s = facts()
      tx.append(n, { kind: 'ReviewStarted', actor, source: 'recorded', data: { reviewer: after.review.agent, submission: s.latest?.id ?? 0, revision: s.latest?.revision ?? null } })
    }
    for (const h of history) {
      if (h.whatText?.id !== HISTORY.reviewPassed.id && h.whatText?.id !== HISTORY.reviewFailed.id) continue
      const s = facts()
      const reviewer = before?.review?.agent ?? (ctx?.actor.kind === 'agent' ? (ctx.actor.self?.agentId ?? ctx.actor.name) : 'unknown')
      tx.append(n, {
        kind: 'Verdict',
        actor,
        source: 'recorded',
        data: { reviewer, submission: s.latest?.id ?? 0, revision: s.latest?.revision ?? null, pass: h.whatText.id === HISTORY.reviewPassed.id, round: roundOf(before ?? after), generation: s.generation, comment }
      })
    }
    if ((before?.blocked ?? null) !== after.blocked) {
      if (after.blocked) tx.append(n, { kind: 'Blocked', actor, source: 'recorded', data: { reason: after.blocked } })
      else if (before?.blocked) tx.append(n, { kind: 'Unblocked', actor, source: 'recorded', data: {} })
    }
    const decisions = after.decisions ?? []
    const had = new Set((before?.decisions ?? []).map((d) => d.id))
    decisions.forEach((d, i) => {
      if (!had.has(d.id)) tx.append(n, { kind: 'Decision', actor, source: 'recorded', data: { decision: d.id, generation: i + 1, text: d.text } })
    })
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
 * An agent read a card in full (hive_read_task): what it has received of the card's decisions (`DecisionsReceived`, its
 * newest generation), once per generation, in a board change of its own. In the background: never in the read's way.
 */
export async function recordDecisionsRead(ws: WorkspaceService, agentId: string, n: number): Promise<void> {
  try {
    await boardWrite(ws, async () => {
      const card = boardRead(ws, (db) => db.prepare('SELECT project, pre_workflow FROM cards WHERE number = ?').get(n) as { project: string; pre_workflow: number } | undefined)
      if (!card || card.pre_workflow) return
      const store = FactStore.forBoard(ws, { project: card.project, key: '' })
      const s = foldCard(store.facts(n))
      if (!s.generation || (s.received[agentId] ?? 0) >= s.generation) return
      store.tx((tx) => tx.append(n, { kind: 'DecisionsReceived', actor: agentActor(agentId), source: 'recorded', data: { agent: agentId, generation: s.generation } }))
    })
  } catch (e) {
    log.warn(`recording what an agent received of #${n}'s decisions`, e)
  }
}

/** A card's facts, oldest first (the window's `tasks:facts`; #1223's work view builds on them): none for an unknown card or a board waiting for its upgrade. */
export function cardFacts(ws: WorkspaceService, n: number): Fact[] {
  if (!ws.path || !Number.isInteger(n) || boardReadOnly(ws)) return []
  return FactStore.forBoard(ws, { project: '', key: '' }).facts(n)
}
