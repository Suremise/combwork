// The workflow runtime (SPEC §16.7, §16.8): intents from agents and moves from the user pass through one place. It asks
// the platform adapter for the facts the guards need first, outside the transaction (slow reads); then, in one
// transaction, it reads the card's facts again, runs the ruleset's guards in order, and on a refusal appends `Refused`
// and returns it; else it writes the facts, `Moved`, the stage cache and the side effects as durable actions, which a
// worker runs after the commit (§16.4.5).
//
// In the app, one instance per project of an open workspace comes from service.ts (#1263), on the board's store, its
// writes changes of the board and its actions run by the actions worker; reconciliation uses it. P4 routes `tasks.ts`'s
// moves and the intents' routes through it (#1265 on). `tests/workflow` runs it on a store of its own, with `runActions`.

import { AsyncLocalStorage } from 'async_hooks'
import { agentOf, answerFits, approvedByUser, atRoundLimit, foldCard, openEntry, passingReviewers, ROUND_LIMIT_GATE, type Actor, type CardKind, type CardState, type Fact, type FactData, type FactKind, type ForYouKind, type RoundChoice, type StageId } from '../../shared/workflow/facts'
import { compile, hasStage, type Ruleset } from '../../shared/workflow/compile'
import { evaluate, evaluateAll, notApproved, okBeforeApplies, type GuardInputs, type GuardRefusal } from '../../shared/workflow/guards'
import { reviewByYou, reviewerAgent, type WorkflowOptions } from '../../shared/workflow/options'
import type { GuardId, MoveId } from '../../shared/workflow/pieces'
import { refusal, type Refusal, type RuleId } from '../../shared/workflow/refusals'
import { FOR_YOU, workflowEnglish, workflowText } from '../../shared/workflow/texts'
import type { StoredText } from '../../shared/types'
import { parseCardRef } from '../../shared/workflow/cardRefs'
import { changeList, nextCard, type LaneList } from '../../shared/workflow/laneList'
import { LANE_MAX_ROUNDS } from '../../shared/lanes'
import type { FinishInputs, PlatformAdapter } from '../platform/adapter'
import { GitPlatform } from '../platform/gitPlatform'
import { NoneAdapter } from '../platform/none'
import { NonePlatform } from '../platform/nonePlatform'
import { isUnknown, type Maybe } from '../platform/types'
import type { PlatformId } from '../../shared/platform/descriptors'
import { FactStore, type CardRecord, type Tx } from './factStore'

/** An Override's move when the user applied changed options to a card in flight (§16.11.4, OP-38). */
export const APPLY_OPTIONS = 'applyOptions'

export interface Moved {
  ok: true
  card: string
  from: StageId
  to: StageId
  data?: Record<string, unknown>
  warnings?: string[]
}

/** The user's drag across rules: what it would skip, asked before it's done (§16.8.4). */
export interface Ask {
  ask: true
  card: string
  rules: string[]
}

export type Reply = Moved | Refusal

/** What an intent decided on, fingerprinted (`evidenceOf`): the adapter's primed reads and the fingerprint then. */
export interface Evidence {
  primed: unknown
  value: string | null
  /** The platform's own answer by content, taken with it (`content`), when it has one. */
  content: string | null
}

/** The user's (or the Assistant's) drag running an intent: asking first, or across the rules that refuse, with a reason. */
export interface Drag {
  by: 'user' | 'assistant'
  reason: string
  ask: boolean
}

/**
 * What runs inside each write of an intent that changes the card, in its transaction, after the runtime's own facts
 * (#1265): the board's 0.9 fields (tasks.ts) follow the stage the write left, so a reader never sees one without the
 * other. Set per call (`alongside`), for every write the intent makes (a drag's start, then its submit).
 */
export interface Alongside {
  written: (w: Write) => Promise<void>
}
const alongsideOf = new AsyncLocalStorage<Alongside>()

/** Runs `fn` (a runtime call) with `a` run inside each of its writes that change a card. */
export function alongside<T>(a: Alongside, fn: () => Promise<T>): Promise<T> {
  return alongsideOf.run(a, fn)
}

export const isRefusal = (r: unknown): r is Refusal => !!r && typeof r === 'object' && (r as Refusal).refused === true

/** What happens outside the store: a delivery per action, deduplicated by the action's id (§16.4.5). */
export interface Effects {
  wake?: (agent: string, card: CardRecord, why: string) => void
  /** A notice to the user: its English, and its text as data for the window when Hive wrote it (an agent's words have none). */
  notify?: (card: CardRecord, text: string, shown?: StoredText) => void
}

export interface WorkflowConfig {
  store: FactStore
  /** The project folder. */
  project: string
  /** The project key (`AM`). */
  projectKey: string
  /** The project's resolved options (§16.6.6); a card in flight keeps its own ruleset. */
  options: () => WorkflowOptions
  /** Where cards' own folders go (the spike's stand-in for slots). */
  slots: string
  /** Runs an agent started that are still going (G13). */
  runsOf?: (agent: string) => string[]
  /**
   * An agent's own worktree (SPEC §16.19.1: before P7's slots, it stands in for a card's slot): its folder, and the line
   * its project.json names as its base. Null for an agent without one.
   */
  agentFolder?: (agent: string) => Promise<{ path: string; base: string | null } | null>
  /** Paths an agent holds or held file locks on since its card started (a shared folder's own changes, G16). */
  locksOf?: (agent: string) => string[]
  /** Run the actions after each write (false: leave them pending, as a crash right after the commit would). */
  autoRun?: boolean
  effects?: Effects
  /** Test seams: called between gathering and the transaction. */
  hooks?: { beforeWrite?: (move: string) => void | Promise<void> }
  /**
   * Runs a write of the store under the lock its store needs (#1217): in the app, a change of the workspace's board
   * (boardWrite), since the board's store writes only inside one; left out, the write runs as it is (a store on its own
   * connection).
   */
  locked?: <T>(fn: () => T) => Promise<T>
  /**
   * Whether reconciliation acts on what it observes (§16.4.4's moves: Done when integrated outside, a queue entry
   * cancelled, the builder woken, a stale card moved back), or only records it (#1217: P3 is record-only). The P4
   * runtime turns it on; the P2 scenarios run with it.
   */
  reconcileActs?: boolean
  /**
   * Whether the ruleset's guards run (#1265: Settings → Advanced → Workflow rules are enforced): off, no guard refuses or
   * is skipped, so nothing asks, is refused for a rule or records an Override; facts are recorded under the card's
   * ruleset as ever. Read at each use; left out, always.
   */
  enforced?: () => boolean
}

/** A branch name's slug from a card title (§16.10.1): lower case ASCII letters, digits and hyphens, at most 40. */
export function slugOf(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

const ORDER: StageId[] = ['todo', 'active', 'review', 'approved', 'merging', 'done']

/** The user's choice at the round limit, as an agent's wake says it (English). */
const CHOICE_WORDS: Record<RoundChoice, string> = { carryOn: 'carry on', split: 'split it', accept: 'accept it with follow-ups', takeOver: 'the user takes it over' } // i18n-ignore: a wake, agent-facing

/** A write inside one transaction, for one card: facts with the ruleset and actor, the stage cache, actions. */
export class Write {
  readonly written: Fact[] = []
  /**
   * The user's answer this write records, as agents read it (#1269): every wake it makes is an answer's (`about:
   * 'answer'`, delivered with or without a loop), saying the answer first; `woken`, the agents it woke.
   */
  answer: string | null = null
  readonly woken: string[] = []
  /** The card's stage when the write began. */
  readonly was: StageId
  constructor(
    readonly tx: Tx,
    readonly card: CardRecord,
    readonly ruleset: Ruleset | null,
    readonly actor: Actor,
    private stage: StageId
  ) {
    this.was = stage
  }

  fact<K extends FactKind>(kind: K, data: FactData[K], actor: Actor = this.actor): Fact<K> {
    const f = this.tx.append(this.card.id, { kind, actor, source: 'recorded', ...(this.ruleset ? { ruleset: this.ruleset.id } : {}), data })
    this.written.push(f)
    return f
  }

  move(to: StageId, cause: FactData['Moved']['cause'], why?: string): void {
    if (to === this.stage) return
    this.fact('Moved', { from: this.stage, to, cause, ...(why ? { why } : {}) }) // i18n-ignore: a fact's kind and codes, not text
    this.tx.setStage(this.card.id, to)
    this.stage = to
  }

  get current(): StageId {
    return this.stage
  }

  /** An action for the card, for the fact that caused it (the last this write wrote, unless named). */
  action(kind: string, payload: Record<string, unknown> = {}, fact: number | null = this.written.at(-1)?.seq ?? null): number {
    return this.tx.action(this.card.id, kind, payload, fact)
  }

  /** The card's state with what this write has added. */
  state(): CardState {
    return foldCard(this.tx.facts(this.card.id))
  }
}

/** A start gathered outside the lock (§16.7): what its write records, and what its guards decide on. */
interface StartGathered {
  r: Ruleset
  o: WorkflowOptions
  data: FactData['Started']
  existing: boolean
  ins: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>
  before: Evidence
  warnings: string[]
}

/** A submission gathered outside the lock: the revision with its endpoints, keys and files, and its guards' inputs. */
interface SubmitGathered {
  r: Ruleset
  o: WorkflowOptions
  /** The card as gathered (None: with the paths the submission sets, `setPaths`). */
  card: CardRecord
  s: CardState
  from: StageId
  agent: string | null
  /** Whose own running work the submission waits for (G13): the submitting agent, else the card's builder. */
  runner: string | null
  setPaths: string[] | null
  revision: string | null
  base: string | null
  key: string | null
  files: FactData['Submitted']['files']
  commits?: string[]
  paths?: string[]
  inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>
  warnings: string[]
  earlier: boolean
  fin: FinishInputs | Record<string, never>
  before: Evidence
  only?: (id: GuardId) => boolean
}

/** The guards a no-code card's submission keeps (§16.7.3). */
const NO_CODE_GUARDS: GuardId[] = ['submit.notDuplicate', 'submit.ownRunsStopped', 'submit.decisionsReceived']

/** A drag's write undone (it throws, so its part of the change is undone): a refusal, or rules not decided on (ask again). */
class DragUndone extends Error {
  constructor(readonly refused: GuardRefusal) {
    super(refused.rule)
  }
}

export class Workflow {
  readonly store: FactStore
  readonly none: NoneAdapter
  /** The platform adapters (§16.3.1): the runtime asks them, and never switches on a platform id. */
  private platforms: Record<PlatformId, PlatformAdapter>

  constructor(readonly cfg: WorkflowConfig) {
    this.store = cfg.store
    this.none = new NoneAdapter(cfg.project, cfg.options().excluded)
    this.platforms = { git: new GitPlatform(this), none: new NonePlatform(this, this.none) }
  }

  /** The adapter of a ruleset's platform (a card keeps its ruleset's, so a switch applies from the next card). */
  platform(o: WorkflowOptions): PlatformAdapter {
    return this.platforms[o.platform]
  }

  /** A card's platform adapter, by the ruleset it works under. */
  platformOf(card: CardRecord, s: CardState = this.state(card)): PlatformAdapter {
    return this.platform(this.rulesetOf(card, s).options)
  }

  // --- Cards, rulesets, folders.

  createCard(input: { title: string; kind?: CardKind; labels?: string[]; blockedBy?: number[]; target?: string; paths?: string[] }): CardRecord {
    return this.store.createCard({ title: input.title, kind: input.kind ?? 'code', labels: input.labels ?? [], blockedBy: input.blockedBy ?? [], ...(input.target ? { target: input.target } : {}), ...(input.paths ? { paths: input.paths } : {}) })
  }

  /** A card by reference (`AM-12`, `#12`) or id; a plain number from an agent is refused (§16.12). */
  resolve(ref: unknown, actor: Actor = 'user'): CardRecord | Refusal {
    if (typeof ref === 'number' && !agentOf(actor)) return this.store.card(ref)
    const p = parseCardRef(ref)
    if (!p.ok) return refusal('card.plainNumber', { key: `${this.cfg.projectKey}-12`, alias: '#1061' }, null)
    const c = 'key' in p.ref ? this.store.cardByKey(p.ref.key) : this.store.cards().find((x) => x.id === (p.ref as { alias: number }).alias)
    return c ?? refusal('card.plainNumber', { key: `${this.cfg.projectKey}-12`, alias: '#1061' }, null)
  }

  state(card: CardRecord | number): CardState {
    return foldCard(this.store.facts(typeof card === 'number' ? card : card.id))
  }

  /** The current options, compiled and stored. */
  currentRuleset(save = true): Ruleset {
    const r = compile(this.cfg.options())
    if (!r.ok) throw new Error(`contradictory options: ${r.contradictions.join(', ')}`) // i18n-ignore: a programming error in the spike, never shown
    if (save) this.store.saveRuleset(r.ruleset)
    return r.ruleset
  }

  /**
   * The ruleset a card works under (§16.5.4): the one it started with until it's Done, unless the user applied changed
   * options to it since (an Override, §16.11.4: the latest one's); a card in Todo uses its lane's (the one in force when
   * the lane started), else the current one.
   */
  rulesetOf(card: CardRecord, s: CardState = this.state(card)): Ruleset {
    // A card back in Todo (put back, or a Done card reopened) starts its next cycle under the rules then (§16.5.4,
    // HR2's #1290 round 1): its last cycle's ruleset isn't its own any more.
    if (s.started && s.stage !== 'todo') {
      const facts = this.store.facts(card.id)
      const applied = facts.filter((x) => x.seq > s.cycle && x.kind === 'Override' && !!x.ruleset && (x.data as FactData['Override']).move === APPLY_OPTIONS).at(-1)
      const f = applied ?? facts.find((x) => x.seq === s.cycle)
      if (f?.ruleset) return this.store.ruleset(f.ruleset)
    }
    if (card.lane) {
      const lane = this.lane(card.lane)
      if (lane && !lane.ended && lane.ruleset) return this.store.ruleset(lane.ruleset)
    }
    // Not stored here (a read): a write naming it stores it in its own transaction (write()).
    return this.currentRuleset(false)
  }

  /** The card's folder on disk: its own, or the project folder. */
  folderOf(s: CardState): string {
    return !s.started || s.started.folder === 'project' ? this.cfg.project : s.started.folder
  }

  ownLine = (s: CardState): boolean => !!s.started && s.started.folder !== 'project'

  // --- Writing.

  /** One write for a card, in one transaction; then the actions run (unless left pending). */
  async write<T>(card: CardRecord, ruleset: Ruleset | null, actor: Actor, fn: (w: Write) => T): Promise<T> {
    const also = alongsideOf.getStore()
    const out = await this.locked(async () => {
      let w: Write | null = null
      const r = this.store.tx((tx) => {
        // The ruleset its facts name, stored with them.
        if (ruleset) tx.saveRuleset(ruleset)
        w = new Write(tx, tx.card(card.id), ruleset, actor, tx.card(card.id).stage)
        return fn(w)
      })
      // What the call runs alongside (the board's 0.9 fields), in the same transaction, once this write changed the card.
      if (also && w && (w as Write).written.length) await also.written(w)
      return r
    })
    if (this.cfg.autoRun !== false) await this.runActions()
    return out
  }

  /** Runs a write under the lock its store needs (cfg.locked), else as it is. */
  locked<T>(fn: () => T): Promise<T> {
    return this.cfg.locked ? this.cfg.locked(fn) : Promise.resolve(fn())
  }

  /** A refusal: recorded as `Refused` when an agent or the Assistant was refused (the user's refused drags aren't). */
  async refuse(card: CardRecord | null, actor: Actor, move: string, g: GuardRefusal, override: Refusal['override'] = 'the user'): Promise<Refusal> { // i18n-ignore: the override field, agent-facing (§16.8.3)
    const out = refusal(g.rule, g.values, override)
    if (card && actor !== 'user') {
      // Under the store's lock, as every write (in the app, a change of the board).
      await this.locked(() => this.store.tx((tx) => tx.append(card.id, { kind: 'Refused', actor, source: 'recorded', data: { move, rule: g.rule, message: out.message, next: out.next, values: g.values } }))) // i18n-ignore: a fact's kind and codes, not text
    }
    return out
  }

  private notFrom(card: CardRecord, actor: Actor, s: CardState, move: string): Promise<Refusal> {
    return this.refuse(card, actor, move, { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move, moves: this.movesFrom(s.stage, this.rulesetOf(card, s), s).join(', ') } })
  }

  /** The intents an agent can use from a stage under a ruleset (§16.7.2's table): what a refusal offers as the next step. */
  movesFrom(stage: StageId, r?: Ruleset, s?: CardState): string[] {
    const o = r?.options
    switch (stage) {
      case 'todo':
        return ['start']
      case 'active':
        return ['submit', 'put back'] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      case 'review':
        return !o || reviewerAgent(o.review) ? ['start review', 'verdict'] : [] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      case 'approved':
        return [...(s?.stale ? ['submit'] : []), ...(!o || o.finish === 'agentMerges' || o.finish === 'notChecked' ? ['report merge'] : [])] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      default:
        return []
    }
  }

  private ok(card: CardRecord, from: StageId, to: StageId, data?: Record<string, unknown>, warnings?: string[]): Moved {
    return { ok: true, card: card.key, from, to, ...(data ? { data } : {}), ...(warnings?.length ? { warnings } : {}) }
  }

  /** Guards evaluated inside the transaction, on the card's facts as they are now. */
  private check(w: Write, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): GuardRefusal | null {
    return evaluate(this.guardIds(w, move, only), this.guardInputs(w, inputs))
  }

  private guardIds(w: Write, move: MoveId, only?: (id: GuardId) => boolean): GuardId[] {
    return this.idsOf(w.ruleset, move, only)
  }

  /** Whether the guards run (cfg.enforced: Settings → Advanced, #1265). */
  enforced(): boolean {
    return this.cfg.enforced ? this.cfg.enforced() : true
  }

  /** A move's guards in a ruleset, those `only` keeps; none while the rules aren't enforced. */
  private idsOf(r: Ruleset | null, move: MoveId, only?: (id: GuardId) => boolean): GuardId[] {
    if (!this.enforced()) return []
    return (r?.guards[move] ?? []).filter((id) => !only || only(id))
  }

  private guardInputs(w: Write, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>): GuardInputs {
    return this.inputsOf(w.card, w.state(), w.ruleset!, inputs)
  }

  private inputsOf(card: CardRecord, s: CardState, r: Ruleset, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>): GuardInputs {
    return { card: { key: card.key, kind: card.kind, labels: card.labels, blocked: s.blocked }, state: s, ruleset: r, ...inputs }
  }

  /** The rules a move's guards refuse on a state, read outside the write (a drag deciding what to ask): none, each once. */
  private failingOf(card: CardRecord, s: CardState, r: Ruleset, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): string[] {
    return [...new Set(evaluateAll(this.idsOf(r, move, only), this.inputsOf(card, s, r, inputs)).map((f) => f.rule))]
  }

  /** The same, in the write, on the card's facts as they are now. */
  private failingIn(w: Write, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): string[] {
    return [...new Set(evaluateAll(this.guardIds(w, move, only), this.guardInputs(w, inputs)).map((f) => f.rule))]
  }

  /**
   * An intent's guards for the user's (or the Assistant's) drag (§16.8.4): nothing refuses → it just moves; else, asking,
   * the rules that refuse (`move.needsOverride`, nothing written); across them, an `Override` naming exactly those.
   */
  private across(w: Write, move: MoveId, to: StageId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, drag: Drag, only?: (id: GuardId) => boolean): GuardRefusal | null {
    const failing = evaluateAll(this.guardIds(w, move, only), this.guardInputs(w, inputs))
    if (!failing.length) return null
    const rules = [...new Set(failing.map((f) => f.rule))]
    if (drag.ask) return { rule: 'move.needsOverride', values: { card: w.card.key, stage: to, rules: rules.join(', ') } }
    w.fact('Override', { rules, move: `${w.current}→${to}`, by: drag.by, reason: drag.reason }) // i18n-ignore: a fact's kind and codes, not text
    return null
  }

  // --- Intents and moves (§16.7.2).

  /** start: Todo → Active, the card's line and base recorded, its folder prepared (slots). */
  async start(ref: unknown, actor: Actor, opts: { builder?: string; drag?: Drag } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'todo') return this.notFrom(card, actor, s, 'start')
    const g = await this.gatherStart(card, s, actor, opts.builder)
    if (!('data' in g)) return this.refuse(card, actor, 'start', g)
    // Its ruleset is stored by the write that names it (write()), under the store's lock.
    await this.cfg.hooks?.beforeWrite?.('start')
    if (await this.revalidate(card, s, g.o, g.before)) return this.regather(card, () => this.start(ref, actor, opts))
    const out = await this.write(card, g.r, actor, (w) => {
      const changed = this.stillAt(w, s, 'start') ?? this.evidenceChanged(w, g.o, g.before)
      if (changed) return changed
      // The user's Start across a rule: the rules skipped are recorded, and the start's own facts still are.
      const bad = opts.drag ? this.across(w, 'start', 'active', g.ins, opts.drag) : this.check(w, 'start', g.ins)
      if (bad) return bad
      this.applyStart(w, g, w.written.some((f) => f.kind === 'Override') ? 'override' : actor === 'user' ? 'user' : 'intent')
      return null
    })
    if (out) return this.refuse(card, actor, 'start', out)
    return this.ok(card, 'todo', 'active', { folder: this.folderOf(this.state(card)), line: g.data.line, base: g.data.base, target: g.data.target }, g.warnings)
  }

  /** A start's slow part, outside the lock: its folder, line, base and target, the cards it waits for, its evidence. */
  private async gatherStart(card: CardRecord, s: CardState, actor: Actor, builderOpt?: string): Promise<StartGathered | GuardRefusal> {
    const r = this.rulesetOf(card, s)
    const o = r.options
    const builder = agentOf(actor) ?? builderOpt ?? 'user'
    const warnings: string[] = []
    if (s.blocked && !r.guards.start.includes('start.notBlocked')) warnings.push(`${card.key} is blocked: ${s.blocked}`) // i18n-ignore: agent-facing warning in the spike's reply
    const before = await this.evidenceOf(card, s, o)
    const plan = await this.platform(o).start(card, o, builder)
    if (isUnknown(plan)) return { rule: 'platform.unknown', values: { card: card.key, what: plan.whatText ?? plan.what, rule: 'start' } }
    const { existing, ...planned } = plan
    const data: FactData['Started'] = { ...planned, builder, cardKind: card.kind }
    // Dependencies Done by facts, in this card's target (§16.7.4).
    const waitingFor = r.guards.start.includes('start.dependenciesIntegrated') ? await this.waitingFor(card, data.target, o) : []
    return { r, o, data, existing: !!existing, ins: { agent: agentOf(actor), waitingFor, slotFree: true }, before, warnings }
  }

  /** A start's facts and actions, in its write: `Started`, the move into Active, its folder prepared (a slot of its own). */
  private applyStart(w: Write, g: StartGathered, cause: FactData['Moved']['cause']): void {
    w.fact('Started', g.data) // i18n-ignore: a fact's kind and codes, not text
    w.move('active', cause)
    if (g.data.folder !== 'project' && !g.existing) w.action('prepareSlot', { folder: g.data.folder, line: g.data.line, base: g.data.base })
  }

  /** The card's state as it would be once a gathered start is written (a drag gathers its submission on it). */
  private predicted(card: CardRecord, s: CardState, g: StartGathered): CardState {
    const facts = this.store.facts(card.id)
    const seq = (facts.at(-1)?.seq ?? 0) + 1
    const at = new Date().toISOString()
    const started: Fact<'Started'> = { seq, card: card.id, kind: 'Started', at, actor: 'hive', source: 'recorded', data: g.data } // i18n-ignore: a fact's kind and codes, not text
    const moved: Fact<'Moved'> = { seq: seq + 1, card: card.id, kind: 'Moved', at, actor: 'hive', source: 'recorded', data: { from: s.stage, to: 'active', cause: 'user' } } // i18n-ignore: a fact's kind and codes, not text
    return foldCard([...facts, started, moved])
  }

  /** put back: Active → Todo; its folder is released. */
  async putBack(ref: unknown, actor: Actor, args: { why?: string } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'active') return this.notFrom(card, actor, s, 'put back') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, this.rulesetOf(card, s), actor, (w) => {
      const changed = this.stillAt(w, s, 'put back') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (changed) return changed
      w.move('todo', 'intent', args.why)
      w.action('releaseSlot', {})
      return null
    })
    if (out) return this.refuse(card, actor, 'put back', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, 'active', 'todo')
  }

  /**
   * The card changed between the reads an intent gathered and its transaction (another intent or move won the race):
   * its stage, cycle, latest submission or queue entries differ. Refused from where it is now, never applied to a card
   * that moved on (§16.7, ARCHITECTURE "The one path").
   */
  stillAt(w: Write, s: CardState, move: string): GuardRefusal | null {
    const now = w.state()
    if (now.stage === s.stage && now.cycle === s.cycle && (now.latest?.id ?? 0) === (s.latest?.id ?? 0) && now.entries.length === s.entries.length) return null
    return { rule: 'move.notFromHere', values: { card: w.card.key, stage: now.stage, move, moves: this.movesFrom(now.stage).join(', ') } }
  }

  /**
   * What an intent decides on, fingerprinted (§16.7, ARCHITECTURE "The one path"): its platform's evidence (refs,
   * None's paths' hash) and the facts of the cards it waits for. Taken before the slow reads and again inside the
   * transaction (`evidenceChanged`), so nothing is written on evidence that changed meanwhile.
   */
  async evidenceOf(card: CardRecord, s: CardState, o: WorkflowOptions): Promise<Evidence> {
    const primed = await this.platform(o).prime(card, s, o)
    const content = await this.platform(o).content(card, s, o, primed)
    return { primed, value: this.evidenceNow(card, s, o, primed), content }
  }

  /** Cards whose intent is being gathered again (`regather`): at most once, so a fingerprint moving again refuses. */
  private regathering = new Set<number>()

  /**
   * Just before an intent's transaction (#1206): whether to gather it again from the top. Only when the fingerprint
   * moved since it was taken while the platform's answer by content, asked again outside the transaction, is the same
   * (with the fingerprint steady across the asking and the cards waited for unchanged): what moved is likely cached
   * stat data only (an outside `git status`, a file touched). Even then, what the intent read in between (its guards'
   * inputs: dirty files, the revision) may have seen another state and back, so it is never reused with a new
   * fingerprint: the intent starts again, reading everything afresh, once (`regather`). A real change refuses at once,
   * as does a fingerprint moving again in the second pass. Git, the files and SQLite can't be one transaction:
   * reconciliation settles what comes after the transaction's read.
   */
  private async revalidate(card: CardRecord, s: CardState, o: WorkflowOptions, before: Evidence): Promise<boolean> {
    if (before.value === null || before.content === null || this.regathering.has(card.id)) return false
    const a = this.evidenceNow(card, s, o, before.primed)
    if (a === null || a === before.value || this.depsOf(a) !== this.depsOf(before.value)) return false
    const content = await this.platform(o).content(card, s, o, before.primed)
    const b = this.evidenceNow(card, s, o, before.primed)
    return content !== null && content === before.content && b === a
  }

  /** Runs an intent again from the top, once (`revalidate`). */
  private async regather<T>(card: CardRecord, run: () => Promise<T>): Promise<T> {
    this.regathering.add(card.id)
    try {
      return await run()
    } finally {
      this.regathering.delete(card.id)
    }
  }

  /** The part of a fingerprint that is the cards waited for (`evidenceNow`). */
  private depsOf(value: string): string {
    const i = value.indexOf('#')
    return i < 0 ? '' : value.slice(i)
  }

  private evidenceNow(card: CardRecord, s: CardState, o: WorkflowOptions, primed: unknown): string | null {
    const platform = this.platform(o).evidence(card, s, o, primed)
    return platform === null ? null : [platform, ...card.blockedBy.map((id) => `${id}:${this.state(id).lastSeq}`)].join('#')
  }

  /** Refused when the evidence changed since it was taken, or can't be read now or then (unknown never satisfies). */
  private evidenceChanged(w: Write, o: WorkflowOptions, before: Evidence, card: CardRecord = w.card): GuardRefusal | null {
    const now = this.evidenceNow(card, w.state(), o, before.primed)
    return before.value !== null && now === before.value ? null : { rule: 'evidence.changed', values: { card: w.card.key } }
  }

  /** Is a card Done by facts: integrated, or accepted (§16.5.3 `start.dependenciesIntegrated`), not just Approved. */
  doneByFacts(id: number): boolean {
    const s = this.state(id)
    return s.stage === 'done' && (!!s.integrated || !!s.accepted)
  }

  /**
   * A lane's card is finished once it is Done, however it got there (Not checked finishes with no `Integrated`): the
   * lane goes on. Dependencies need more (`waitingFor`).
   */
  laneDone(id: number): boolean {
    return this.state(id).stage === 'done'
  }

  /**
   * The cards a card waits for that aren't Done by facts **in its target** (§16.7.4): accepted, or with their change in
   * that target now, by containment of their stored endpoints (merged into a release branch and then into main counts;
   * a target reset since doesn't). A Done card with no `Integrated` (Not checked, an override) counts once its change is
   * found there: verified, never assumed.
   */
  async waitingFor(card: CardRecord, target: string | null, o: WorkflowOptions): Promise<Maybe<string[]>> {
    const out: string[] = []
    for (const id of card.blockedBy) {
      const dep = this.store.card(id)
      // From its cached stage (#1265): a card from before 1.0 has no facts, only where it is.
      const d = foldCard(this.store.facts(id), dep.stage)
      const key = dep.key
      if (d.stage !== 'done') {
        out.push(key)
        continue
      }
      // Done before 1.0, or never started under the rules (moved to Done by hand): nothing to look for in the target.
      if (d.accepted || dep.preWorkflow || !d.started) continue
      const revision = d.integrated?.revision ?? d.approved?.revision ?? d.latest?.revision
      const base = d.approved?.base ?? d.latest?.base ?? d.started?.base
      if (!revision || !base || !target || revision === base) {
        out.push(key)
        continue
      }
      const c = await this.platform(o).contains(target, { base, revision, key: d.latest?.key })
      if (isUnknown(c)) return c
      if (!c) out.push(key)
    }
    return out
  }

  /** The card's revision now (its platform's answer). */
  revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>> {
    return this.platformOf(card, s).revisionNow(card, s)
  }

  /** What a finish needs from the platform (gathered before the transaction). */
  finishInputs(card: CardRecord, s: CardState, r: Ruleset, revision: string | null | undefined): Promise<FinishInputs> {
    return this.platform(r.options).finishInputs(card, s, r.options, revision)
  }

  /**
   * Asks the user (For you, §16.8.5): `ApprovalRequested` and a notification. `asker`: the agent whose own question it
   * is; `unbound`: a question no new submission retires (the round limit's, answered only by the user); `revision` and
   * `checklist`: an agent's ask about a revision of its choice, with a Test checklist (#1267).
   */
  askUser(w: Write, kind: ForYouKind, gate: string, text: string | StoredText, o: { asker?: string | null; unbound?: boolean; revision?: string; checklist?: string[] } = {}): string {
    const s = w.state()
    // Hive's own requests are messages (FOR_YOU): the English for agents and the Agent API, the message for the window.
    const english = typeof text === 'string' ? text : workflowEnglish(text)
    const shown = typeof text === 'string' ? {} : { requestText: text }
    const request = `${w.card.key}/r${s.lastSeq + 1}`
    // Bound to what the user is shown: the submission and revision, the stage and the decision generation it is asked at.
    w.fact('ApprovalRequested', { request, kind, gate, text: english, ...shown, for: 'user', ...(o.asker ? { asker: o.asker } : {}), stage: w.current, generation: s.generation, ...(s.latest && !o.unbound ? { submission: s.latest.id, revision: s.approved?.revision ?? s.latest.revision } : {}), ...(o.revision ? { revision: o.revision } : {}), ...(o.checklist ? { checklist: o.checklist } : {}) })
    w.action('notify', { text: english, ...(typeof text === 'string' ? {} : { shown: text }) })
    return request
  }

  /**
   * Asks the user again for a gate still unmet where the card now is (its request was retired by a trip to On Hold):
   * the review under "You" (or "…, then you" once the reviewers passed it) in Review, the OK before merging in Approved.
   */
  reask(w: Write): void {
    const r = w.ruleset
    const s = w.state()
    if (!r || !s.latest || s.stale || s.requests.some((x) => x.gate === 'review' || x.gate === 'okBefore')) return
    const o = r.options
    if (w.current === 'review' && reviewByYou(o.review) && !approvedByUser(s, 'review') && (o.review === 'you' || passingReviewers(s).length >= o.reviewers)) {
      this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.review, { card: w.card.key }))
    } else if (w.current === 'approved' && this.enforced() && okBeforeApplies(r, w.card.labels) && !approvedByUser(s, 'okBefore') && notApproved(s, r, w.card.labels)?.missing === 'userOk') {
      this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
    }
  }

  /**
   * At the round limit (§16.11.4): Hive asks the user (Decide: carry on, split, accept with follow-ups, take it over), and
   * the card's lane pauses until they answer. Only for a card in a running lane (its rounds: the Card loops settings it
   * started with) and while the rules are enforced (Settings → Advanced).
   */
  askAtLimit(w: Write): void {
    const s = w.state()
    if (!this.enforced() || !atRoundLimit(s, w.card.rounds)) return
    // Not bound to the submission: a new one can't retire it, only the user's answer (HR3's #1269 round 1 finding 1).
    this.askUser(w, 'decide', ROUND_LIMIT_GATE, workflowText(FOR_YOU.roundLimit, { card: w.card.key, rounds: s.rounds }), { unbound: true })
  }

  /**
   * Refuses an agent's or the Assistant's submission or forward move while the card waits for the user at its round
   * limit (§16.11.4): only the user's answer resumes its loop. The user's own moves go on.
   */
  private atLimit(card: CardRecord, s: CardState, actor: Actor): GuardRefusal | null {
    if (actor === 'user' || !this.enforced() || !s.requests.some((r) => r.gate === ROUND_LIMIT_GATE)) return null
    return { rule: 'loop.roundLimit', values: { card: card.key } } as GuardRefusal
  }

  /**
   * Wakes an agent: a durable action delivered once (§16.4.5). `about: 'answer'`: the user's answer, which reaches the
   * agent whether or not the card has a reviewer (loopWakes.ts).
   */
  wake(w: Write, agent: string | null | undefined, why: string, about?: 'answer'): void {
    if (!agent || agent === 'user') return
    // In the user's answer's write (finish's wakes too): an answer's wake, the answer first (HR3's #1269 round 2).
    const answer = about ?? (w.answer !== null ? 'answer' : undefined)
    const said = w.answer !== null && !why.startsWith(w.answer) ? `${w.answer}. ${why}` : why
    w.action('wake', { agent, why: said, ...(answer ? { about: answer } : {}) })
    w.woken.push(agent)
  }

  /** The reviewer to wake: the card's (a lane's), else the pool. */
  reviewerOf(card: CardRecord): string {
    return card.reviewer ?? 'reviewers'
  }

  /** Puts a card in the merge queue: a new entry (`IntegrationRequested`). */
  enqueue(w: Write, requeue?: 'transient' | 'retry'): void {
    const s = w.state()
    const target = s.started?.target ?? ''
    w.fact('IntegrationRequested', { entry: `${w.card.key}/e${s.lastSeq + 1}`, revision: s.approved?.revision ?? s.latest?.revision ?? '', key: s.latest?.key ?? null, target, style: w.ruleset!.options.style, ...(requeue ? { requeue } : {}) })
    w.move('merging', 'derived')
    w.action('enqueue', { target })
  }

  /** Finish (§16.7.2): after review, or straight after submit with no review. */
  finish(w: Write, fin: FinishInputs): void {
    const r = w.ruleset!
    const o = r.options
    const s = w.state()
    if (w.card.kind === 'no-code') {
      w.fact('Accepted', { submission: s.latest!.id }) // i18n-ignore: a fact's kind and codes, not text
      w.move('done', 'derived')
      w.action('endLaneIfDone', {})
      return
    }
    if (o.finish === 'accept') {
      // Accepted only if the card's work still has the approved revision (None: its paths still hash to it, §16.3.3).
      const approved = s.approved?.revision ?? null
      if (!isUnknown(fin.currentRevision) && fin.currentRevision === approved) {
        w.fact('Accepted', { revision: approved! }) // i18n-ignore: a fact's kind and codes, not text
        w.move('done', 'derived')
        w.action('endLaneIfDone', {})
      } else {
        w.fact('Stale', { approved, current: isUnknown(fin.currentRevision) ? null : (fin.currentRevision ?? null), why: 'change' }) // i18n-ignore: a fact's kind and codes, not text
        w.move(hasStage(r, 'review') ? 'review' : 'active', 'derived')
        this.wake(w, s.started?.builder, 'stale: your paths changed since the pass, submit again') // i18n-ignore: a wake, agent-facing
      }
      return
    }
    // G10 asks only while the rules are enforced (Settings → Advanced): off, the card goes on as if it were never set.
    const needOk = this.enforced() && okBeforeApplies(r, w.card.labels) && !approvedByUser(s, 'okBefore')
    switch (o.finish) {
      case 'hiveMerges':
        if (needOk) {
          w.move('approved', 'derived')
          this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        } else this.enqueue(w)
        return
      case 'agentMerges':
        w.move('approved', 'derived')
        if (needOk) this.askUser(w, 'approve', 'okBefore', workflowText(FOR_YOU.okBefore, { card: w.card.key }))
        else this.wake(w, s.started?.builder, 'approved: merge it and report the merge') // i18n-ignore: a wake, agent-facing
        return
      case 'committed':
        // Its revision is on the folder's line by construction: done.contained.
        if (fin.contained === true) {
          w.fact('Integrated', { revision: s.approved!.revision!, target: s.started!.target ?? '', result: s.approved!.revision!, method: 'committed', by: 'hive' }) // i18n-ignore: a fact's kind and codes, not text
          w.move('done', 'derived')
          w.action('endLaneIfDone', {})
        }
        return
      case 'notChecked':
        if (o.review !== 'none') w.move('approved', 'derived')
        else {
          w.move('done', 'derived')
          w.action('endLaneIfDone', {})
        }
        return
      default:
        return
    }
  }

  /**
   * submit (§16.8.1): the card's revision with its endpoints, keys and files → Review, or Finish without review, or
   * back into the merge queue after a transient failure (`requeue.allowed`).
   */
  async submit(ref: unknown, actor: Actor, args: { summary: string; revision?: string; note?: string; paths?: string[]; drag?: Drag }): Promise<Reply> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    let card = card0
    let s = this.state(card)
    if (!s.started) return this.notFrom(card, actor, s, 'submit')
    const limit = this.atLimit(card, s, actor)
    if (limit) return this.refuse(card, actor, 'submit', limit)
    const r = this.rulesetOf(card, s)
    const o = r.options
    const agent = agentOf(actor)
    const from = s.stage

    // After a queue failure: the same approved, unstale revision goes straight back into the queue (no review, no round).
    const last = s.entries.at(-1)
    // (A decision's cancel isn't a queue failure: the builder resubmits as usual, with a note for the same revision.)
    if (from === 'active' && o.finish === 'hiveMerges' && card.kind === 'code' && last && (last.state === 'failed' || (last.state === 'cancelled' && last.cancelled !== 'decision')) && !s.stale) {
      // The same evidence protocol as an ordinary submit: taken before the revision is read, checked at the write.
      const evidence = await this.evidenceOf(card, s, o)
      const now = await this.revisionNow(card, s)
      if (!isUnknown(now) && now && now === s.approved?.revision) {
        await this.cfg.hooks?.beforeWrite?.('submit')
        if (await this.revalidate(card, s, o, evidence)) return this.regather(card, () => this.submit(ref, actor, args))
        const g = await this.write(card, r, actor, (w) => {
          const bad = this.stillAt(w, s, 'submit') ?? this.evidenceChanged(w, o, evidence) ?? this.check(w, 'requeue', { agent, revision: now })
          if (bad) return bad
          this.enqueue(w, 'transient')
          return null
        })
        return g ? this.refuse(card, actor, 'submit', g) : this.ok(card, from, 'merging', { requeued: true })
      }
    }
    if (!(from === 'active' || ((from === 'approved' || from === 'review') && s.stale) || from === 'review')) return this.notFrom(card, actor, s, 'submit')

    const g = await this.gatherSubmit(card, s, actor, args)
    if (!('inputs' in g)) return this.refuse(card, actor, 'submit', g)
    // The same revision again: a new submission only with a note (§16.8.1).
    const waiting = (from === 'review' || from === 'approved') && !g.s.stale
    if (g.earlier && !waiting && !args.note && !args.drag) return this.refuse(card, actor, 'submit', { rule: 'submit.sameRevisionNote', values: { revision: g.revision!.slice(0, 7) } })

    await this.cfg.hooks?.beforeWrite?.('submit')
    if (await this.revalidate(g.card, g.s, g.o, g.before)) return this.regather(card, () => this.submit(ref, actor, args))
    const out = await this.write(card, g.r, actor, (w) => {
      const changed = this.stillAt(w, g.s, 'submit') ?? this.evidenceChanged(w, g.o, g.before, g.card)
      if (changed) return changed
      // Every refusal before anything is written: an override never commits without its move.
      if (from === 'review' && !g.s.stale) return { rule: 'move.notFromHere', values: { card: card.key, stage: from, move: 'submit', moves: this.movesFrom(from, g.r).join(', ') } } as GuardRefusal
      const ins = this.submitInputs(g)
      const bad = args.drag ? this.across(w, 'submit', 'review', ins, args.drag, g.only) : this.check(w, 'submit', ins, g.only)
      if (bad) return bad
      this.applySubmit(w, g, args, w.written.some((f) => f.kind === 'Override') ? 'override' : 'intent')
      return null
    })
    if (out) return this.refuse(card, actor, 'submit', out)
    return this.ok(card, from, this.state(card).stage, { revision: g.revision, base: g.base, files: g.files.length }, g.warnings)
  }

  /**
   * A submission's slow part, outside the lock (it writes nothing): the card's revision with its fixed endpoints, key and
   * files, and its guards' inputs. None's paths it sets are kept with it (`setPaths`), written by its write. `r`: the
   * ruleset, for a state predicted after a start (a drag's) whose ruleset isn't stored yet.
   */
  private async gatherSubmit(card0: CardRecord, s0: CardState, actor: Actor, args: { revision?: string; paths?: string[] }, r: Ruleset = this.rulesetOf(card0, s0), predicted = false): Promise<SubmitGathered | GuardRefusal> {
    let card = card0
    let s = s0
    const o = r.options
    const agent = agentOf(actor)
    const from = s.stage
    let revision: string | null = null
    let base: string | null = null
    let key: string | null = null
    let files: FactData['Submitted']['files'] = []
    let commits: string[] | undefined
    let paths: string[] | undefined
    const inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'> = { agent, folder: this.folderOf(s) }
    const warnings: string[] = []
    // The card's declared paths (None) are its data: what the evidence and the revision are read with (args, else the
    // pre-fill), written with the submission.
    const setPaths = args.paths ?? (card.kind === 'code' && o.platform === 'none' && !card.paths ? this.prefill(card) : null)
    if (setPaths) card = { ...card, paths: setPaths }
    const before = await this.evidenceOf(card, s, o)
    if (card.kind === 'code') {
      const plan = await this.platform(o).submission(card, s, o, { revision: args.revision, agent, guards: r.guards.submit, predicted })
      if (!plan.ok) return plan.refusal
      ;({ revision, base, key, files, commits, paths } = plan)
      Object.assign(inputs, plan.inputs)
      warnings.push(...plan.warnings)
      // The adapter may have reconciled (a shared folder's attribution): the card and its state as they are now.
      if (!predicted) {
        card = { ...this.store.card(card.id), ...(setPaths ? { paths: setPaths } : {}) }
        s = this.state(card)
      }
    }
    inputs.revision = revision
    if (r.guards.submit.includes('submit.checksPassed') && card.kind === 'code') inputs.checksMissing = o.preChecks.filter((name) => !s.checks.some((c) => c.name === name && c.revision === revision && c.result === 'passed' && c.counted))
    // G13: the builder's own running work, whoever submits (an agent itself; the user's or the Assistant's move: the
    // card's builder). Read again in the write (`runsNow`): work started meanwhile counts.
    const runner = agent ?? (s.started?.builder && s.started.builder !== 'user' ? s.started.builder : null)
    if (runner && this.cfg.runsOf) inputs.runsGoing = this.cfg.runsOf(runner)
    const earlier = card.kind === 'code' && s.submissions.some((x) => x.revision === revision)
    const fin = o.review === 'none' ? await this.finishInputs(card, s, r, revision) : {}
    const only = card.kind === 'no-code' ? (id: GuardId) => NO_CODE_GUARDS.includes(id) : undefined
    return { r, o, card, s, from, agent, runner, setPaths, revision, base, key, files, ...(commits ? { commits } : {}), ...(paths ? { paths } : {}), inputs, warnings, earlier, fin, before, ...(only ? { only } : {}) }
  }

  /** A submission's guard inputs in its write: as gathered, its builder's running work read again (HR2's #1265 round 2). */
  private submitInputs(g: SubmitGathered): Omit<GuardInputs, 'card' | 'state' | 'ruleset'> {
    return g.runner && this.cfg.runsOf ? { ...g.inputs, runsGoing: this.cfg.runsOf(g.runner) } : g.inputs
  }

  /** A submission's facts and actions, in its write: `Submitted`, its pin, then Review (its reviewer woken or the user asked) or Finish. */
  private applySubmit(w: Write, g: SubmitGathered, args: { summary: string; note?: string }, cause: FactData['Moved']['cause']): void {
    if (g.setPaths) this.store.updateCard(g.card.id, { paths: g.setPaths })
    const st = w.state()
    const sub = w.fact('Submitted', { // i18n-ignore: a fact's kind and codes, not text
      revision: g.revision,
      base: g.base,
      head: g.revision,
      key: g.key,
      files: g.files,
      round: st.rounds + 1,
      generation: g.agent ? (st.received[g.agent] ?? 0) : st.generation,
      sameRevision: g.earlier,
      summary: args.summary,
      ...(args.note ? { note: args.note } : {}),
      ...(g.paths ? { paths: g.paths } : {}),
      ...(g.commits ? { commits: g.commits } : {}),
      ...(g.warnings.length ? { warnings: g.warnings } : {})
    })
    if (g.revision) w.action('pin', { ref: `refs/hive/cards/${g.card.key.toLowerCase()}/${st.submissions.length + 1}`, revision: g.revision, submission: sub.seq })
    if (g.o.review === 'none') {
      this.finish(w, g.fin)
      return
    }
    w.move('review', cause)
    w.action('prepareReviewCopy', { revision: g.revision })
    if (reviewerAgent(g.o.review)) this.wake(w, this.reviewerOf(g.card), `${g.card.key} is in Review`) // i18n-ignore: a wake, agent-facing
    else this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.review, { card: g.card.key }))
  }

  /** start review: the reviewer takes the latest submission (§16.8.1). */
  async startReview(ref: unknown, actor: Actor, args: { submission?: number } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'review') return this.notFrom(card, actor, s, 'start review') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const sub = args.submission !== undefined ? s.submissions.find((x) => x.id === args.submission) : s.latest
    if (!sub) return this.refuse(card, actor, 'start review', { rule: 'review.noSubmission', values: { card: card.key } }) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.stillAt(w, s, 'start review') ?? this.check(w, 'startReview', { agent: agentOf(actor) }) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (bad) return bad
      w.fact('ReviewStarted', { reviewer: agentOf(actor) ?? 'user', submission: sub.id, revision: sub.revision })
      return null
    })
    if (out) return this.refuse(card, actor, 'start review', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, 'review', 'review', { submission: sub.id, revision: sub.revision, base: sub.base, files: sub.files })
  }

  /** verdict (§16.7.2): always recorded; a pass may finish, ask the user, or go stale at once if the head moved to another change. */
  async verdict(ref: unknown, actor: Actor, args: { submission?: number; pass: boolean; failKind?: 'content' | 'explanation'; comment: string }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'review') return this.notFrom(card, actor, s, 'verdict')
    const r = this.rulesetOf(card, s)
    const agent = agentOf(actor)
    const subId = args.submission ?? s.latest?.id
    const sub = s.submissions.find((x) => x.id === subId)
    // The head moved since the submission (a card with its own line): same change or not (§16.4.4).
    const before = await this.evidenceOf(card, s, r.options)
    const moved = args.pass && sub?.revision ? await this.platform(r.options).headMoved(card, s, r.options, { base: sub.base, revision: sub.revision, key: sub.key }) : null
    const fin = args.pass ? await this.finishInputs(card, s, r, moved?.same ? moved.to : sub?.revision) : {}
    await this.cfg.hooks?.beforeWrite?.('verdict')
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.verdict(ref, actor, args))
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.stillAt(w, s, 'verdict') ?? this.evidenceChanged(w, r.options, before) ?? this.check(w, 'verdict', { agent, submission: args.submission })
      if (bad) return bad
      const st = w.state()
      w.fact('Verdict', { reviewer: agent ?? 'user', submission: subId!, revision: sub?.revision ?? null, pass: args.pass, ...(args.failKind ? { failKind: args.failKind } : {}), round: args.pass ? st.rounds : st.rounds + 1, generation: agent ? (st.received[agent] ?? 0) : st.generation, comment: args.comment }) // i18n-ignore: a fact's kind and codes, not text
      if (!args.pass) {
        w.move('active', 'intent')
        this.wake(w, st.started?.builder, `${card.key} failed review`) // i18n-ignore: a wake, agent-facing
        this.askAtLimit(w)
        return null
      }
      if (moved && !moved.same) {
        w.fact('Stale', { approved: sub!.revision, current: moved.to, why: r.options.sameness === 'exact' ? 'exact' : 'change' }) // i18n-ignore: a fact's kind and codes, not text
        if (hasStage(r, 'approved')) w.move('approved', 'derived')
        this.wake(w, st.started?.builder, 'stale: submit again') // i18n-ignore: a wake, agent-facing
        return null
      }
      if (moved?.same) w.fact('CarriedOver', { from: sub!.revision!, to: moved.to, toBase: moved.base, how: 'replay' })
      const now = w.state()
      if (passingReviewers(now).length < r.options.reviewers) return null
      if (reviewByYou(r.options.review) && !approvedByUser(now, 'review')) {
        this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.passedReview, { card: card.key }))
        return null
      }
      this.finish(w, fin)
      return null
    })
    if (out) return this.refuse(card, actor, 'verdict', out)
    return this.ok(card, 'review', this.state(card).stage)
  }

  /**
   * The user answers a request (§16.8.5): only the user (Darren's point 7, #1269: never an agent or the Assistant). An
   * approval satisfies its gate; a decline of a gate's request is a round, the card back to its builder; a reply (`note`)
   * is relayed. At the round limit the answer is the user's `choice`, and a carry on adds `rounds`. Never a decision (the
   * board records those). The agent waiting on it is woken: whoever asked (an agent's own question), else the builder;
   * at the round limit the builder and the reviewer, whose lane paused for it.
   */
  async answer(ref: unknown, request: string, answer: 'approved' | 'declined' | 'answered', opts: { note?: string; choice?: RoundChoice; rounds?: number; decided?: boolean } = {}): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const req = s.requests.find((x) => x.request === request)
    if (!req) return this.refuse(card, 'user', 'answer', { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move: 'answer', moves: '' } })
    const r = this.rulesetOf(card, s)
    const before = await this.evidenceOf(card, s, r.options)
    const fin = await this.finishInputs(card, s, r, s.approved?.revision ?? s.latest?.revision)
    const from = s.stage
    const { note, choice } = opts
    // What the answer may be follows its request (HR3's #1269 round 1 finding 2): checked before anything is written.
    if (!answerFits(req, { outcome: answer, reply: !!note, decision: !!opts.decided, choice, rounds: opts.rounds }, LANE_MAX_ROUNDS)) throw new Error(`an answer (${answer}${choice ? `, ${choice}` : ''}) that doesn't fit request ${request} (${req.kind}, ${req.gate})`) // i18n-ignore: a programming error (tasks.ts checks first, in the user's words)
    const rounds = choice === 'carryOn' ? opts.rounds : undefined
    await this.cfg.hooks?.beforeWrite?.('answer')
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.answer(ref, request, answer, opts))
    const out = await this.write(card, r, 'user', (w) => {
      // Under the transaction: the request still open (a newer submission retires the old one's), the card where it was.
      const changed = this.stillAt(w, s, 'answer') ?? this.evidenceChanged(w, r.options, before)
      if (changed) return changed
      const st = w.state()
      if (!st.requests.some((x) => x.request === request)) return { rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: 'answer', moves: '' } } as GuardRefusal
      w.fact('Approval', { request, answer, ...(note ? { note } : {}), generation: st.generation, ...(req.submission !== undefined ? { submission: req.submission } : {}), ...(choice ? { choice } : {}), ...(rounds ? { rounds } : {}) }) // i18n-ignore: a fact's kind and codes, not text
      const builder = st.started?.builder
      const said = `${card.key}: the user ${answer === 'approved' ? 'approved' : answer === 'declined' ? 'declined' : 'answered'} "${req.text}"${choice ? `: ${CHOICE_WORDS[choice]}${rounds ? ` (${rounds} more round${rounds === 1 ? '' : 's'})` : ''}` : ''}${note ? `: ${note}` : ''}` // i18n-ignore: a wake, agent-facing
      w.answer = said
      if (req.gate === ROUND_LIMIT_GATE) {
        this.wake(w, builder, said, 'answer')
        // Its lane's reviewer, which paused with it.
        if (card.reviewer && card.reviewer !== builder) this.wake(w, card.reviewer, said, 'answer')
        return null
      }
      if (req.gate !== 'review' && req.gate !== 'okBefore') {
        // A question an agent asked (or Hive's own, after a merge): recorded, and the asker told; nothing moves.
        this.wake(w, req.asker ?? builder, said, 'answer')
        return null
      }
      if (answer === 'declined') {
        w.move('active', 'user')
        this.wake(w, builder, said, 'answer')
        this.askAtLimit(w)
        return null
      }
      // The gate is evaluated before anything moves on: passes and approvals at the current generation, not stale.
      const now = w.state()
      const missing = notApproved(now, r, card.labels)
      if (req.gate === 'review') {
        if (!missing || (missing.missing === 'userOk' && approvedByUser(now, 'review'))) this.finish(w, fin)
      } else if (!missing && st.stage === 'approved') {
        if (r.options.finish === 'hiveMerges') this.enqueue(w)
        else this.wake(w, builder, 'approved: merge it and report the merge') // i18n-ignore: a wake, agent-facing
      }
      // Whatever the approval led to (finished, queued, still waiting on another gate), its builder hears of it, once.
      if (!w.woken.includes(builder ?? '')) this.wake(w, builder, said)
      return null
    })
    if (out) return this.refuse(card, 'user', 'answer', out)
    return this.ok(card, from, this.state(card).stage)
  }

  /** report merge (§16.9.3): the builder merged; Hive checks containment (unless Not checked), then Done. */
  async reportMerge(ref: unknown, actor: Actor, args: { result?: string } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    // Only where the builder merges (or nothing is checked): under Hive merges the queue merges, never a report.
    if (s.stage !== 'approved' || (r.options.finish !== 'agentMerges' && r.options.finish !== 'notChecked')) return this.notFrom(card, actor, s, 'report merge') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const before = await this.evidenceOf(card, s, r.options)
    const target = s.started?.target ?? ''
    const rev = s.approved?.revision ?? s.latest?.revision ?? null
    let contained: Maybe<boolean> | undefined
    let method: FactData['Integrated']['method'] = 'merge'
    if (r.guards.reportMerge.includes('done.contained')) {
      // Integration needs a non-empty change (§16.4.4).
      if (!rev || !s.approved?.base || rev === s.approved.base) contained = false
      else {
        const c = await this.platform(r.options).contains(target, { base: s.approved.base, revision: rev, key: s.latest?.key })
        contained = isUnknown(c) ? c : !!c
        if (!isUnknown(c) && c) method = c.method === 'sameTree' ? 'sameTree' : c.method
      }
    }
    const th = await this.platform(r.options).targetHead(target)
    if (await this.revalidate(card, s, r.options, before)) return this.regather(card, () => this.reportMerge(ref, actor, args))
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.stillAt(w, s, 'report merge') ?? this.evidenceChanged(w, r.options, before) ?? this.check(w, 'reportMerge', { agent: agentOf(actor), contained, revision: rev, target }) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (bad) return bad
      if (contained === true) w.fact('Integrated', { revision: rev!, target, result: args.result ?? (!isUnknown(th) && th ? th : rev!), method, by: 'agent' }) // i18n-ignore: a fact's kind and codes, not text
      w.move('done', 'intent')
      w.action('endLaneIfDone', {})
      w.action('releaseSlot', {})
      return null
    })
    if (out) return this.refuse(card, actor, 'report merge', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, 'approved', 'done')
  }

  /** ask the user (§16.8.1): For you of a kind. */
  async askTheUser(ref: unknown, actor: Actor, args: { kind: ForYouKind; text: string; revision?: string; checklist?: string[] }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    let request = ''
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      request = this.askUser(w, args.kind, 'ask', args.text, { asker: agentOf(actor), ...(args.revision ? { revision: args.revision } : {}), ...(args.checklist?.length ? { checklist: args.checklist } : {}) })
    })
    return this.ok(card, s.stage, s.stage, { request })
  }

  /** couldn't within the rules (#686): For you (Decide), never a failed round, never a stall. */
  async cannotWithinRules(ref: unknown, actor: Actor, args: { rule: string; why: string }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      const request = `${card.key}/r${s.lastSeq + 1}`
      w.fact('CannotWithinRules', { rule: args.rule, why: args.why, request })
      w.fact('ApprovalRequested', { request, kind: 'decide', gate: args.rule, text: args.why, for: 'user', ...(agentOf(actor) ? { asker: agentOf(actor)! } : {}) })
      w.action('notify', { text: args.why })
    })
    return this.ok(card, s.stage, s.stage)
  }

  /** request to builder (#912): the reviewer's request mid-review; wakes the builder now. */
  async requestToBuilder(ref: unknown, actor: Actor, text: string): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, this.rulesetOf(card, s), actor, (w) => {
      w.fact('ReviewerRequest', { text })
      this.wake(w, s.started?.builder, `${card.key}: the reviewer asks: ${text}`) // i18n-ignore: a wake, agent-facing
    })
    return this.ok(card, s.stage, s.stage)
  }

  /**
   * A comment or message on a card: no fact can move it (§16.8.2: only a submission or a decision moves an Approved
   * card back to Review). The board keeps comments; the workflow sees nothing.
   */
  comment(ref: unknown, actor: Actor): Reply {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    return this.ok(card, s.stage, s.stage)
  }

  /** The user records a decision (§16.4.6): a new generation; passes and approvals before it go stale. */
  async recordDecision(ref: unknown, text: string): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = s.started ? this.rulesetOf(card, s) : null
    const from = s.stage
    await this.write(card, r, 'user', (w) => {
      // Read under the transaction: where the card is now, not where it was when the call began.
      const now = w.state()
      const generation = now.generation + 1
      w.fact('Decision', { decision: `${card.key}/d${generation}`, generation, text }) // i18n-ignore: a fact's kind and codes, not text
      this.wake(w, now.started?.builder, `${card.key} has a new decision`) // i18n-ignore: a wake, agent-facing
      if (['review', 'approved', 'merging'].includes(now.stage)) this.wake(w, this.reviewerOf(card), `${card.key} has a new decision`) // i18n-ignore: a wake, agent-facing
      // The user's own review request was for the old generation (retired by the decision): asked again at once.
      if (r && now.stage === 'review' && r.options.review === 'you' && now.latest) this.askUser(w, 'approve', 'review', workflowText(FOR_YOU.newDecision, { card: card.key }))
      if (!r || (now.stage !== 'approved' && now.stage !== 'merging')) return
      const entry = openEntry(now)
      // After IntegrationStarted it's too late to stop that merge: it completes, then For you (§16.4.6).
      if (entry?.state === 'started') return
      w.fact('Stale', { approved: now.approved?.revision ?? null, current: now.approved?.revision ?? null, why: 'decision' }) // i18n-ignore: a fact's kind and codes, not text
      if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'decision' }) // i18n-ignore: a fact's kind and codes, not text
      w.move(hasStage(r, 'review') ? 'review' : 'active', 'derived')
    })
    return this.ok(card, from, this.state(card).stage)
  }

  /** An agent received the card's decisions (the delivery, its reply flag, or reading the card after them). */
  async received(ref: unknown, agent: string): Promise<void> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return
    const s = this.state(card)
    await this.write(card, null, `agent:${agent}`, (w) => {
      w.fact('DecisionsReceived', { agent, generation: s.generation })
    })
  }

  async block(ref: unknown, actor: Actor, reason: string): Promise<void> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return
    await this.write(card, null, actor, (w) => (reason ? w.fact('Blocked', { reason }) : w.fact('Unblocked', {}))) // i18n-ignore: a fact's kind and codes, not text
  }

  /** The rules a drag from one stage to another would skip (§16.8.4): the guards of the moves it jumps over. */
  skippedRules(card: CardRecord, r: Ruleset, from: StageId, to: StageId): string[] {
    if (!this.enforced()) return []
    const a = ORDER.indexOf(from)
    const b = ORDER.indexOf(to)
    if (a < 0 || b < 0 || b <= a) return []
    const out = new Set<string>()
    const past = (stage: StageId) => a <= ORDER.indexOf(stage) && b > ORDER.indexOf(stage)
    if (past('todo')) r.guards.start.forEach((g) => out.add(g))
    if (past('active') && card.kind === 'code') r.guards.submit.filter((g) => g !== 'submit.notDuplicate').forEach((g) => out.add(g))
    if ((past('review') || past('approved')) && (r.options.review !== 'none' || okBeforeApplies(r, card.labels))) out.add('integrate.approved')
    if (to === 'done' && card.kind === 'code') {
      if (r.options.finish === 'hiveMerges') r.guards.integrate.filter((g) => g !== 'integrate.approved').forEach((g) => out.add(g))
      if (r.options.finish === 'agentMerges') r.guards.reportMerge.forEach((g) => out.add(g))
      if (r.options.finish === 'committed') r.guards.finish.forEach((g) => out.add(g))
    }
    return [...out]
  }

  /**
   * The user's drag (or menu): never refused. A move that skips rules asks first, then records an `Override`; a move
   * that skips nothing just moves (§16.7.1). The Assistant passes `override: { reason }` or is refused.
   */
  async move(ref: unknown, to: StageId, by: 'user' | 'assistant', opts: { confirm?: boolean; reason?: string; builder?: string; dry?: boolean } = {}): Promise<Moved | Ask | Refusal> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const from = s.stage
    if (to === from) return this.ok(card, from, to)
    // `dry` (the user's, #1275): only whether it would ask, and which rules; nothing written (a window Start asks first).
    if (opts.dry && by !== 'user') throw new Error('a dry move is the user\'s') // i18n-ignore: a programming error, never shown
    // The Assistant's move on, while the card waits for the user at its round limit: only the user's answer resumes it.
    const limit = ORDER.indexOf(to) > ORDER.indexOf(from === 'hold' ? 'active' : from) ? this.atLimit(card, s, by) : null
    if (limit) return this.refuse(card, by, 'move', limit)
    // A Done card dragged on is reopened: its next cycle's rules (as from Todo), not its last's.
    const reopened = from === 'done' && ORDER.indexOf(to) > ORDER.indexOf('todo')
    const r = this.rulesetOf(card, reopened ? { ...s, stage: 'todo' } : s)
    // Never into a stage the card's ruleset doesn't have (no review: no Review; no merge step: no Approved or Merging).
    if (!hasStage(r, to)) return this.refuse(card, by, 'move', { rule: 'move.noStage', values: { card: card.key, stage: to, stages: r.stages.map((x) => x.id).join(', ') } })
    // On Hold cancels a queue entry and keeps the lease; leaving it returns the card where it was (§16.7.4).
    if (to === 'hold') {
      if (opts.dry) return this.ok(card, from, to)
      const out = await this.write(card, r, by, (w) => {
        const changed = this.stillAt(w, s, 'move')
        if (changed) return changed
        const e = openEntry(s)
        if (e) w.fact('IntegrationCancelled', { entry: e.id, reason: 'hold' }) // i18n-ignore: a fact's kind and codes, not text
        w.move('hold', 'user')
        return null
      })
      return out ? this.refuse(card, by, 'move', out) : this.ok(card, from, 'hold')
    }
    if (from === 'hold') {
      const back = [...this.store.facts(card.id)].reverse().find((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'hold')
      const was = back?.data.from ?? 'todo'
      const forward = ORDER.indexOf(to) > ORDER.indexOf(was) && to !== 'done'
      // Past where it was: back there and the intents of a drag from there, in one write (dragForward).
      if (forward) return this.dragForward(card, was, to, by, opts, was)
      if (to === was) {
        if (opts.dry) return this.ok(card, from, to)
        const out = await this.write(card, r, by, (w) => {
          const changed = this.stillAt(w, s, 'move')
          if (changed) return changed
          // A card that was queued (Merging, or Approved under Hive merges) is queued again.
          const requeue = to === was && (was === 'merging' || (was === 'approved' && r.options.finish === 'hiveMerges' && !s.stale && !notApproved(s, r, card.labels)))
          w.move(requeue ? 'approved' : was, 'user')
          if (requeue) this.enqueue(w)
          // The trip to On Hold retired the gate's request (it belongs to its stage): asked again, if still unmet.
          else this.reask(w)
          return null
        })
        if (out) return this.refuse(card, by, 'move', out)
        return this.ok(card, from, this.state(card).stage)
      }
    }
    // Reopening a Done card past Todo (§16.7.4): no rule skipped by the reopening; back to Todo and a drag from there, a
    // new cycle (its start), in one write.
    if (from === 'done' && ORDER.indexOf(to) > ORDER.indexOf('todo') && to !== 'done') return this.dragForward(card, from, to, by, opts, 'todo')
    // A forward drag into Active, Review, Approved or Merging stands for intents, and runs them in order (Start, then
    // submit, then the review skipped): never a bare move that leaves a card with no start, nothing to review or no
    // queue entry. Each step that skips nothing just happens; one that would skip a rule asks first (§16.8.4).
    if (from !== 'hold' && ORDER.indexOf(to) > ORDER.indexOf(from) && to !== 'done') return this.dragForward(card, from, to, by, opts)
    // Out of On Hold, the rules a move skips count from where the card was, not from Todo.
    const heldFrom = from === 'hold' ? ([...this.store.facts(card.id)].reverse().find((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'hold')?.data.from ?? 'todo') : from
    const skipped = this.skippedRules(card, r, heldFrom, to)
    if (skipped.length && by === 'user' && (!opts.confirm || opts.dry)) return { ask: true, card: card.key, rules: skipped }
    if (opts.dry) return this.ok(card, from, to)
    if (skipped.length && by === 'assistant' && !opts.reason) return this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: skipped.join(', ') } }, 'the user or the Assistant') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, r, by, (w) => {
      // The drag was made on the card as it was: if it moved on meanwhile, the user sees where it is now and drags again.
      const changed = this.stillAt(w, s, 'move')
      if (changed) return changed
      if (skipped.length) w.fact('Override', { rules: skipped, move: `${from}→${to}`, by, reason: opts.reason ?? '' }) // i18n-ignore: a fact's kind and codes, not text
      // Leaving a stage with a queue entry cancels it (the user moved it out).
      const e = openEntry(s)
      if (e && to !== 'merging') w.fact('IntegrationCancelled', { entry: e.id, reason: 'user' }) // i18n-ignore: a fact's kind and codes, not text
      w.move(to, skipped.length ? 'override' : 'user')
      if (to === 'done') w.action('endLaneIfDone', {})
      return null
    })
    return out ? this.refuse(card, by, 'move', out) : this.ok(card, from, to)
  }

  /**
   * A forward drag's intents (§16.8.4), decided whole and written in one write (HR2's #1265 round 1): each step is
   * gathered first, outside the lock (a start; a submission on the state the start would leave; past Review, the review
   * skipped), and the rules they would skip, together, are the question (the user's, nothing written), the refusal (the
   * Assistant's without a reason: only its `Refused`) or one `Override` naming them all. A step refused for what no
   * override makes true (nothing to submit, a fact that couldn't be read) refuses the drag, nothing written. The write
   * checks the rules again: one not decided on undoes it, and asks again. `fromHold`: where the card goes first, in the
   * same write (back from On Hold to where it was; a Done card reopened, to Todo), the drag counted from there.
   */
  private async dragForward(card: CardRecord, from: StageId, to: StageId, by: 'user' | 'assistant', opts: { confirm?: boolean; reason?: string; builder?: string; dry?: boolean }, fromHold?: StageId): Promise<Moved | Ask | Refusal> {
    const asking = by === 'user' ? !opts.confirm || !!opts.dry : !opts.reason
    const s0 = this.state(card)
    // Back from On Hold: the drag counts from where the card was.
    const s: CardState = fromHold ? { ...s0, stage: fromHold } : s0
    // The rules of where the drag counts from (a reopened card's: its next cycle's).
    const r = this.rulesetOf(card, s)
    const gs = s.stage === 'todo' ? await this.gatherStart(card, s, by, opts.builder) : null
    if (gs && !('data' in gs)) return this.refuse(card, by, 'start', gs)
    const s1 = gs ? this.predicted(card, s, gs) : s
    const gsub = ORDER.indexOf(to) > ORDER.indexOf('active') && s1.stage === 'active' ? await this.gatherSubmit(card, s1, by, {}, gs ? gs.r : r, !!gs) : null
    if (gsub && !('inputs' in gsub)) {
      // A submission refused for what no override makes true stops the drag there (§16.8.4), after its start. Its folder
      // may only exist once started (a slot of its own): the start alone, then the submission gathered again on it.
      if (!gs) return this.refuse(card, by, 'submit', gsub)
      if (opts.dry) return this.dragForward(card, from, 'active', by, opts, fromHold)
      const started = await this.dragForward(card, from, 'active', by, opts, fromHold)
      return isRefusal(started) || 'ask' in started ? started : this.dragForward(card, from, to, by, opts)
    }
    // Where the card is once submitted (null: Finish decides, with no review), and what is left to the stage dragged to.
    const after: StageId | null = gsub ? (r.options.review === 'none' ? null : 'review') : s1.stage
    const approved = !gsub && !!s1.latest && !s1.stale && !notApproved(s1, r, card.labels)
    const queueOnly = approved && to === 'merging' && r.options.finish === 'hiveMerges' && ORDER.indexOf(s1.stage) < ORDER.indexOf('merging')
    const pastReview = !approved && after !== null && ORDER.indexOf(after) < ORDER.indexOf(to)
    if (!gs && !gsub && !pastReview && !queueOnly && !fromHold) return this.ok(card, from, s0.stage)
    const rules = new Set<string>()
    if (gs) for (const x of this.failingOf(card, s, gs.r, 'start', gs.ins)) rules.add(x)
    if (gsub) for (const x of this.failingOf(gsub.card, gsub.s, gsub.r, 'submit', gsub.inputs, gsub.only)) rules.add(x)
    // Past Review (or the user's OK): the review and approvals are skipped, and the change counts as approved.
    if (pastReview && this.enforced()) rules.add('integrate.approved')
    const skipped = [...rules]
    const needs = (list: string[]): Ask | Refusal => (by === 'user' ? { ask: true, card: card.key, rules: list } : refusal('move.needsOverride', { card: card.key, stage: to, rules: list.join(', ') }, 'the user or the Assistant')) // i18n-ignore: who can override, agent-facing (§16.8.3)
    if (opts.dry && !skipped.length) return this.ok(card, from, s0.stage)
    if (skipped.length && asking) return by === 'user' ? needs(skipped) : this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: skipped.join(', ') } }, 'the user or the Assistant') // i18n-ignore: who can override, agent-facing (§16.8.3)
    await this.cfg.hooks?.beforeWrite?.('move')
    if (gs && (await this.revalidate(card, s, gs.o, gs.before))) return this.regather(card, () => this.dragForward(card, from, to, by, opts, fromHold))
    if (!gs && gsub && (await this.revalidate(gsub.card, gsub.s, gsub.o, gsub.before))) return this.regather(card, () => this.dragForward(card, from, to, by, opts, fromHold))
    const cause: FactData['Moved']['cause'] = skipped.length ? 'override' : 'user'
    // The rules as they are in the write: one not decided on undoes the write (it throws), to ask again.
    const decided = (now: string[]): void => {
      const more = now.filter((x) => !rules.has(x))
      if (more.length) throw new DragUndone({ rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: [...skipped, ...more].join(', ') } })
    }
    let out: GuardRefusal | null
    try {
      out = await this.write(card, r, by, (w) => {
        const moved = this.stillAt(w, s0, 'move')
        if (moved) return moved
        // One Override naming every rule skipped: after the submission when it approves it (past Review: it counts as
        // approved for the latest submission), else first.
        const override = (): void => void (skipped.length && w.fact('Override', { rules: skipped, move: `${s.stage}→${to}`, by, reason: opts.reason ?? '' })) // i18n-ignore: a fact's kind and codes, not text
        const approves = pastReview && !!gsub
        if (!approves) override()
        if (fromHold) w.move(fromHold, 'user')
        // The evidence on the state it was gathered on (back where it was, from On Hold): moved since, the write is undone.
        const changed = gs ? this.evidenceChanged(w, gs.o, gs.before) : gsub ? this.evidenceChanged(w, gsub.o, gsub.before, gsub.card) : null
        if (changed) throw new DragUndone(changed)
        if (gs) {
          decided(this.failingIn(w, 'start', gs.ins))
          this.applyStart(w, gs, cause)
        }
        if (gsub) {
          // After the start, the submission's evidence as it was gathered on the state the start leaves.
          const shifted = gs ? this.evidenceChanged(w, gsub.o, gsub.before, gsub.card) : null
          if (shifted) throw new DragUndone(shifted)
          decided(this.failingIn(w, 'submit', this.submitInputs(gsub), gsub.only))
          this.applySubmit(w, gsub, { summary: '' }, cause)
          if (approves) override()
        }
        if (queueOnly) this.enqueue(w)
        else if (pastReview && ORDER.indexOf(w.current) < ORDER.indexOf(to)) {
          if (to === 'merging' && r.options.finish === 'hiveMerges') this.enqueue(w)
          else w.move(hasStage(r, 'approved') ? 'approved' : to, cause)
        }
        return null
      })
    } catch (e) {
      if (!(e instanceof DragUndone)) throw e
      if (e.refused.rule === 'move.needsOverride' && by === 'user') return needs(String(e.refused.values.rules).split(', '))
      return this.refuse(card, by, 'move', e.refused, e.refused.rule === 'move.needsOverride' ? 'the user or the Assistant' : 'the user') // i18n-ignore: who can override, agent-facing (§16.8.3)
    }
    return out ? this.refuse(card, by, 'move', out) : this.ok(card, from, this.state(card).stage)
  }

  /**
   * An agent's `hive_update_task` column move (§16.7.1): refused with the intent to use; or, for one transition (P4
   * to P8), translated into that intent through the same guards (§16.17).
   */
  async agentColumnMove(ref: unknown, actor: Actor, column: 'doing' | 'review' | 'passed' | 'done' | 'todo', opts: { translate?: boolean; summary?: string } = {}): Promise<Reply> {
    const intent = { doing: 'start', review: 'submit', passed: 'verdict', done: 'report merge', todo: 'put back' }[column] // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    if (!opts.translate) {
      const card = this.resolve(ref, actor)
      return this.refuse(isRefusal(card) ? null : card, actor, `column ${column}`, { rule: 'move.useIntent', values: { intent } }, null) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    }
    const reply = await (column === 'doing'
      ? this.start(ref, actor)
      : column === 'review'
        ? this.submit(ref, actor, { summary: opts.summary ?? '' })
        : column === 'passed'
          ? this.verdictOnLatest(ref, actor)
          : column === 'done'
            ? this.reportMerge(ref, actor)
            : this.putBack(ref, actor))
    return isRefusal(reply) ? reply : { ...reply, data: { ...reply.data, useNextTime: intent } }
  }

  private async verdictOnLatest(ref: unknown, actor: Actor): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.latest && !(s.reviewing[s.latest.id] ?? []).includes(agentOf(actor) ?? '')) {
      const started = await this.startReview(card.key, actor)
      if (isRefusal(started)) return started
    }
    return this.verdict(card.key, actor, { pass: true, comment: '' })
  }

  /** Remove from queue (the user's): `IntegrationCancelled`, recorded as an override; a rebuilt queue skips it. */
  async removeFromQueue(ref: unknown, reason = ''): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const e = openEntry(s)
    const r = this.rulesetOf(card, s)
    await this.cfg.hooks?.beforeWrite?.('remove from queue') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    const out = await this.write(card, r, 'user', (w) => {
      const changed = this.stillAt(w, s, 'remove from queue') // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      if (changed) return changed
      if (!e) return null
      w.fact('Override', { rules: ['integrate'], move: 'remove from queue', by: 'user', reason }) // i18n-ignore: a fact's kind and codes, not text
      w.fact('IntegrationCancelled', { entry: e.id, reason: 'removed' }) // i18n-ignore: a fact's kind and codes, not text
      // Never into a stage the ruleset doesn't have (no review, no G10: no Approved).
      w.move(hasStage(r, 'approved') ? 'approved' : 'active', 'user')
      return null
    })
    if (out) return this.refuse(card, 'user', 'remove from queue', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /** Retry merge (the user's override): requeues an unchanged revision once, even after a red check (§16.8.1). */
  async retryMerge(ref: unknown, reason = ''): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, 'user', (w) => {
      // Only for a card the queue returned (Active, its last entry failed), approved and unstale, once per revision.
      const st = w.state()
      const last = st.entries.at(-1)
      const retries = st.entries.filter((x) => x.seq > (st.latest?.id ?? 0) && x.requeue === 'retry').length
      if (st.stage !== 'active' || last?.state !== 'failed' || st.stale || notApproved(st, r, card.labels) || retries >= 1) return { rule: 'move.notFromHere', values: { card: card.key, stage: st.stage, move: 'retry merge', moves: this.movesFrom(st.stage).join(', ') } } as GuardRefusal // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
      w.fact('Override', { rules: ['requeue.allowed'], move: 'retry merge', by: 'user', reason }) // i18n-ignore: a fact's kind and codes, not text
      this.enqueue(w, 'retry')
      return null
    })
    if (out) return this.refuse(card, 'user', 'retry merge', out) // i18n-ignore: intent names (the window: texts.ts's MOVE_NAMES)
    return this.ok(card, s.stage, this.state(card).stage)
  }

  // --- None: a card's paths (§16.3.3).

  /** Edits Hive saw through the card's agents' hooks and file locks: the pre-fill of its paths. */
  noteEdit(card: CardRecord, path: string): void {
    this.store.addPrefill(card.id, path)
    this.none.invalidate(path)
  }

  /**
   * A deliverable write the watcher saw: pre-filled for the card whose agent's turn ran alone in the folder (no other
   * agent or the user active), else left as an unclaimed change.
   */
  noteWrite(path: string, active: { agents: string[]; user: boolean }): void {
    this.none.invalidate(path)
    if (active.user || active.agents.length !== 1) return
    const card = this.store.cards().find((c) => c.stage === 'active' && this.state(c).started?.builder === active.agents[0])
    if (card) this.noteEdit(card, path)
  }

  prefill(card: CardRecord): string[] {
    return this.store.prefill(card.id)
  }

  /** declare paths (None): sets the card's paths; replies with the pre-fill, the unclaimed changes and the revision. */
  async declarePaths(ref: unknown, actor: Actor, paths: string[]): Promise<{ prefill: string[]; unclaimed: string[]; revision: string | null } | Refusal> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    const card = await this.locked(() => this.store.updateCard(card0.id, { paths }))
    const rev = this.none.revision(paths)
    return { prefill: this.prefill(card), unclaimed: this.unclaimed(card), revision: isUnknown(rev) ? null : rev.revision }
  }

  /** Deliverables changed since the card started that are in neither its paths nor its pre-fill: for it to add or leave. */
  unclaimed(card: CardRecord): string[] {
    const before = this.state(card).started?.deliverables ?? {}
    const all = this.none.deliverables()
    if (isUnknown(all)) return []
    const now = this.none.manifest(all)
    if (isUnknown(now)) return []
    const mine = new Set([...(card.paths ?? []), ...this.prefill(card)])
    return NoneAdapter.diff(before, now)
      .map((f) => f.path)
      .filter((p) => !mine.has(p))
  }

  // --- Lanes (§16.11).

  lane(id: string): LaneList | null {
    return this.store.lane(id)
  }

  private saveLane(l: LaneList): void {
    this.store.saveLane(l)
  }

  /** Starts a lane (lanes.ts's of that id, else a new one): its cards use the ruleset in force now until it ends. */
  startLane(id: string, cards: number[], reviewer?: string, rounds?: number): LaneList {
    return this.store.startLane(id, cards, this.currentRuleset().id, reviewer, rounds)
  }

  /** Changes a lane's list: never refused; queued while a card is in flight ("list changes after AM-2"). */
  changeLane(id: string, cards: number[]): { lane: LaneList; queuedAfter: string | null } {
    const l = this.lane(id)!
    const current = l.current !== null && !this.laneDone(l.current) ? l.current : null
    // A card queued is in the lane already (its queued list): it uses the lane's ruleset.
    const next = changeList({ ...l, current }, cards)
    this.saveLane(next)
    return { lane: next, queuedAfter: current !== null ? this.store.card(current).key : null }
  }

  /** The lane's next card, read from Hive: one at a time, a queued change applied at the boundary. */
  laneNext(id: string): number | null {
    const { lane, card } = nextCard(this.lane(id)!, (c) => this.laneDone(c))
    this.saveLane(lane)
    return card
  }

  // --- Actions (§16.4.5).

  /** Runs pending actions in order; each checks its effect first, so running one twice delivers once. */
  async runActions(): Promise<void> {
    for (const a of this.store.pendingActions()) {
      try {
        await this.perform(a.id, a.card, a.kind, a.payload)
        this.store.markAction(a.id, 'done')
      } catch {
        this.store.markAction(a.id, 'failed')
      }
    }
  }

  private async perform(id: number, cardId: number, kind: string, payload: Record<string, unknown>): Promise<void> {
    const card = this.store.card(cardId)
    switch (kind) {
      case 'wake':
        if (this.store.deliver({ action: id, kind, target: String(payload.agent), payload })) this.cfg.effects?.wake?.(String(payload.agent), card, String(payload.why))
        return
      case 'notify':
        if (this.store.deliver({ action: id, kind, target: 'user', payload })) this.cfg.effects?.notify?.(card, String(payload.text), payload.shown as StoredText | undefined)
        return
      case 'prepareSlot':
      case 'pin':
        await this.platformOf(card).perform(kind, payload)
        return
      case 'endLaneIfDone': {
        if (!card.lane) return
        const l = this.lane(card.lane)
        if (!l || l.ended) return
        const cards = l.pending ?? l.cards
        if (!cards.every((c) => this.laneDone(c))) return
        const results = cards.map((c) => this.state(c).integrated?.result ?? null)
        this.saveLane({ ...l, ended: true, current: null })
        this.store.deliver({ action: id, kind: 'laneEnded', target: l.id, payload: { results } })
        return
      }
      default:
        // prepareReviewCopy, releaseSlot, enqueue: P5 and P7 build them; the queue reads its entries from facts.
        return
    }
  }
}

export type { RuleId }
