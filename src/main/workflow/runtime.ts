// The workflow runtime (SPEC §16.7, §16.8): intents from agents and moves from the user pass through one place. It asks
// the platform adapter for the facts the guards need first, outside the transaction (slow reads); then, in one
// transaction, it reads the card's facts again, runs the ruleset's guards in order, and on a refusal appends `Refused`
// and returns it; else it writes the facts, `Moved`, the stage cache and the side effects as durable actions, which a
// worker runs after the commit (§16.4.5).
//
// P2 spike (#1118): the runtime over the spike's own store (factStore.ts), not wired into the app: no IPC, no Agent API
// route, no boardWrite. P4 puts it behind `tasks.ts` → `boardWrite` and the intents' routes.

import { join } from 'path'
import { agentOf, approvedByUser, foldCard, openEntry, passingReviewers, type Actor, type CardKind, type CardState, type Fact, type FactData, type FactKind, type ForYouKind, type StageId } from '../../shared/workflow/facts'
import { compile, hasStage, type Ruleset } from '../../shared/workflow/compile'
import { evaluate, notApproved, okBeforeApplies, type GuardInputs, type GuardRefusal } from '../../shared/workflow/guards'
import { reviewByYou, reviewerAgent, type WorkflowOptions } from '../../shared/workflow/options'
import type { GuardId, MoveId } from '../../shared/workflow/pieces'
import { refusal, type Refusal, type RuleId } from '../../shared/workflow/refusals'
import { parseCardRef } from '../../shared/workflow/cardRefs'
import { changeList, newLane, nextCard, type LaneList } from '../../shared/workflow/laneList'
import * as G from '../platform/git'
import { NoneAdapter } from '../platform/none'
import { isUnknown, type Maybe } from '../platform/types'
import { FactStore, type CardRecord, type Tx } from './factStore'

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

export const isRefusal = (r: unknown): r is Refusal => !!r && typeof r === 'object' && (r as Refusal).refused === true

/** What happens outside the store: a delivery per action, deduplicated by the action's id (§16.4.5). */
export interface Effects {
  wake?: (agent: string, card: CardRecord, why: string) => void
  notify?: (card: CardRecord, text: string) => void
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
  /** Paths an agent holds or held file locks on since its card started (a shared folder's own changes, G16). */
  locksOf?: (agent: string) => string[]
  /** Run the actions after each write (false: leave them pending, as a crash right after the commit would). */
  autoRun?: boolean
  effects?: Effects
  /** Test seams: called between gathering and the transaction. */
  hooks?: { beforeWrite?: (move: string) => void | Promise<void> }
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

/** What a finish needs from the platform, gathered before the transaction. */
interface FinishInputs {
  /** Committed is done: the revision on the folder's line. */
  contained?: Maybe<boolean>
  /** None: the card's paths' revision now. */
  noneRevision?: Maybe<string>
}

/** A write inside one transaction, for one card: facts with the ruleset and actor, the stage cache, actions. */
export class Write {
  readonly written: Fact[] = []
  constructor(
    readonly tx: Tx,
    readonly card: CardRecord,
    readonly ruleset: Ruleset | null,
    readonly actor: Actor,
    private stage: StageId
  ) {}

  fact<K extends FactKind>(kind: K, data: FactData[K], actor: Actor = this.actor): Fact<K> {
    const f = this.tx.append(this.card.id, { kind, actor, source: 'recorded', ...(this.ruleset ? { ruleset: this.ruleset.id } : {}), data })
    this.written.push(f)
    return f
  }

  move(to: StageId, cause: FactData['Moved']['cause']): void {
    if (to === this.stage) return
    this.fact('Moved', { from: this.stage, to, cause })
    this.tx.setStage(this.card.id, to)
    this.stage = to
  }

  get current(): StageId {
    return this.stage
  }

  action(kind: string, payload: Record<string, unknown> = {}): number {
    return this.tx.action(this.card.id, kind, payload, this.written.at(-1)?.seq ?? null)
  }

  /** The card's state with what this write has added. */
  state(): CardState {
    return foldCard(this.tx.facts(this.card.id))
  }
}

export class Workflow {
  readonly store: FactStore
  readonly none: NoneAdapter

  constructor(readonly cfg: WorkflowConfig) {
    this.store = cfg.store
    this.none = new NoneAdapter(cfg.project, cfg.options().excluded)
  }

  // --- Cards, rulesets, folders.

  createCard(input: { title: string; kind?: CardKind; labels?: string[]; blockedBy?: number[]; target?: string; paths?: string[]; reviewer?: string }): CardRecord {
    const n = this.store.cards().length + 1
    return this.store.createCard({ key: `${this.cfg.projectKey}-${n}`, title: input.title, kind: input.kind ?? 'code', labels: input.labels ?? [], blockedBy: input.blockedBy ?? [], ...(input.target ? { target: input.target } : {}), ...(input.paths ? { paths: input.paths } : {}), ...(input.reviewer ? { reviewer: input.reviewer } : {}) })
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
  currentRuleset(): Ruleset {
    const r = compile(this.cfg.options())
    if (!r.ok) throw new Error(`contradictory options: ${r.contradictions.join(', ')}`) // i18n-ignore: a programming error in the spike, never shown
    this.store.saveRuleset(r.ruleset)
    return r.ruleset
  }

  /**
   * The ruleset a card works under (§16.5.4): the one it started with until it's Done; a card in Todo uses its lane's
   * (the one in force when the lane started), else the current one.
   */
  rulesetOf(card: CardRecord, s: CardState = this.state(card)): Ruleset {
    if (s.started) {
      const f = this.store.facts(card.id).find((x) => x.seq === s.cycle)
      if (f?.ruleset) return this.store.ruleset(f.ruleset)
    }
    if (card.lane) {
      const lane = this.lane(card.lane)
      if (lane && !lane.ended) return this.store.ruleset(lane.ruleset)
    }
    return this.currentRuleset()
  }

  /** The card's folder on disk: its own, or the project folder. */
  folderOf(s: CardState): string {
    return !s.started || s.started.folder === 'project' ? this.cfg.project : s.started.folder
  }

  ownLine = (s: CardState): boolean => !!s.started && s.started.folder !== 'project'

  private async targetOf(card: CardRecord, o: WorkflowOptions): Promise<Maybe<string>> {
    return card.target || o.target || (await G.defaultBranch(this.cfg.project))
  }

  // --- Writing.

  /** One write for a card, in one transaction; then the actions run (unless left pending). */
  async write<T>(card: CardRecord, ruleset: Ruleset | null, actor: Actor, fn: (w: Write) => T): Promise<T> {
    const out = this.store.tx((tx) => fn(new Write(tx, tx.card(card.id), ruleset, actor, tx.card(card.id).stage)))
    if (this.cfg.autoRun !== false) await this.runActions()
    return out
  }

  /** A refusal: recorded as `Refused` when an agent or the Assistant was refused (the user's refused drags aren't). */
  async refuse(card: CardRecord | null, actor: Actor, move: string, g: GuardRefusal, override: Refusal['override'] = 'the user'): Promise<Refusal> {
    const out = refusal(g.rule, g.values, override)
    if (card && actor !== 'user') {
      this.store.tx((tx) => tx.append(card.id, { kind: 'Refused', actor, source: 'recorded', data: { move, rule: g.rule, message: out.message, next: out.next, values: g.values } }))
    }
    return out
  }

  private notFrom(card: CardRecord, actor: Actor, s: CardState, move: string): Promise<Refusal> {
    return this.refuse(card, actor, move, { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move, moves: this.movesFrom(s.stage).join(', ') } })
  }

  movesFrom(stage: StageId): string[] {
    const m: Record<StageId, string[]> = { hold: [], todo: ['start'], active: ['submit', 'put back'], review: ['start review', 'verdict'], approved: ['submit', 'report merge'], merging: [], done: [] }
    return m[stage]
  }

  private ok(card: CardRecord, from: StageId, to: StageId, data?: Record<string, unknown>, warnings?: string[]): Moved {
    return { ok: true, card: card.key, from, to, ...(data ? { data } : {}), ...(warnings?.length ? { warnings } : {}) }
  }

  /** Guards evaluated inside the transaction, on the card's facts as they are now. */
  private check(w: Write, move: MoveId, inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'>, only?: (id: GuardId) => boolean): GuardRefusal | null {
    const s = w.state()
    const ids = (w.ruleset?.guards[move] ?? []).filter((id) => !only || only(id))
    return evaluate(ids, { card: { key: w.card.key, kind: w.card.kind, labels: w.card.labels, blocked: s.blocked }, state: s, ruleset: w.ruleset!, ...inputs })
  }

  // --- Intents and moves (§16.7.2).

  /** start: Todo → Active, the card's line and base recorded, its folder prepared (slots). */
  async start(ref: unknown, actor: Actor, opts: { builder?: string; override?: FactData['Override'] } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'todo') return this.notFrom(card, actor, s, 'start')
    const r = this.rulesetOf(card, s)
    const o = r.options
    const builder = agentOf(actor) ?? opts.builder ?? 'user'
    // Dependencies Done by facts, in this card's target (§16.7.4).
    const waitingFor = card.blockedBy.filter((id) => !this.doneByFacts(id)).map((id) => this.store.card(id).key)
    const warnings: string[] = []
    if (s.blocked && !r.guards.start.includes('start.notBlocked')) warnings.push(`${card.key} is blocked: ${s.blocked}`) // i18n-ignore: agent-facing warning in the spike's reply
    let data: FactData['Started']
    if (o.platform === 'none') {
      const paths = card.paths ?? []
      const rev = this.none.revision(paths)
      if (isUnknown(rev)) return this.refuse(card, actor, 'start', { rule: 'platform.unknown', values: { card: card.key, what: rev.what, rule: 'start' } })
      const all = this.none.deliverables()
      if (!isUnknown(all)) {
        const m = this.none.manifest(all)
        if (!isUnknown(m)) this.store.setMeta(`deliverables:${card.id}`, JSON.stringify(m))
      }
      data = { folder: 'project', line: null, base: rev.revision, target: null, builder, cardKind: card.kind, manifest: rev.manifest }
    } else if (o.folder === 'slots') {
      const target = await this.targetOf(card, o)
      if (isUnknown(target)) return this.refuse(card, actor, 'start', { rule: 'platform.unknown', values: { card: card.key, what: target.what, rule: 'start' } })
      const base = await G.lineHead(this.cfg.project, target)
      if (isUnknown(base) || !base) return this.refuse(card, actor, 'start', { rule: 'platform.unknown', values: { card: card.key, what: `the head of ${target}`, rule: 'start' } })
      const slug = slugOf(card.title)
      const line = `hive/${this.cfg.projectKey}/${card.key}${slug ? `-${slug}` : ''}`
      data = { folder: join(this.cfg.slots, card.key), line, base, target, builder, cardKind: card.kind }
    } else {
      const line = await G.branch(this.cfg.project)
      const base = await G.head(this.cfg.project)
      if (isUnknown(line) || isUnknown(base)) return this.refuse(card, actor, 'start', { rule: 'platform.unknown', values: { card: card.key, what: isUnknown(base) ? base.what : 'the folder\'s branch', rule: 'start' } })
      // Committed is done: the target is the line the folder works on.
      const target = o.finish === 'committed' ? line : card.target || o.target || line
      data = { folder: 'project', line, base, target, builder, cardKind: card.kind }
    }
    this.store.saveRuleset(r)
    await this.cfg.hooks?.beforeWrite?.('start')
    const out = await this.write(card, r, actor, (w) => {
      // The user's Start across a rule: the rules skipped are recorded, and the start's own facts still are.
      const g = opts.override ? null : this.check(w, 'start', { agent: agentOf(actor), waitingFor, slotFree: true })
      if (g) return g
      if (opts.override) w.fact('Override', opts.override)
      w.fact('Started', data)
      w.move('active', opts.override ? 'override' : actor === 'user' ? 'user' : 'intent')
      if (data.folder !== 'project') w.action('prepareSlot', { folder: data.folder, line: data.line, base: data.base })
      return null
    })
    if (out) return this.refuse(card, actor, 'start', out)
    return this.ok(card, 'todo', 'active', { folder: this.folderOf(this.state(card)), line: data.line, base: data.base, target: data.target }, warnings)
  }

  /** put back: Active → Todo; its folder is released. */
  async putBack(ref: unknown, actor: Actor): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'active') return this.notFrom(card, actor, s, 'put back')
    await this.write(card, this.rulesetOf(card, s), actor, (w) => {
      w.move('todo', 'intent')
      w.action('releaseSlot', {})
    })
    return this.ok(card, 'active', 'todo')
  }

  /** Is a card Done by facts: integrated, or accepted (§16.5.3 `start.dependenciesIntegrated`), not just Approved. */
  doneByFacts(id: number): boolean {
    const s = this.state(id)
    return s.stage === 'done' && (!!s.integrated || !!s.accepted)
  }

  /** The card's revision now: its folder's head (own line), its newest attributed commit (shared folder), its paths' hash (None). */
  async revisionNow(card: CardRecord, s: CardState): Promise<Maybe<string | null>> {
    if (card.kind === 'no-code') return null
    const o = this.rulesetOf(card, s).options
    if (o.platform === 'none') {
      const r = this.none.revision(card.paths ?? [])
      return isUnknown(r) ? r : r.revision
    }
    if (this.ownLine(s)) return G.head(this.folderOf(s))
    return s.attributed.at(-1) ?? s.started?.base ?? null
  }

  /** What a finish needs from the platform (gathered before the transaction). */
  async finishInputs(card: CardRecord, s: CardState, r: Ruleset, revision: string | null | undefined): Promise<FinishInputs> {
    if (card.kind === 'no-code' || !revision) return {}
    if (r.options.platform === 'none') {
      const now = this.none.revision(card.paths ?? [])
      return { noneRevision: isUnknown(now) ? now : now.revision }
    }
    if (r.options.finish === 'committed' && s.started?.line) {
      const lh = await G.lineHead(this.cfg.project, s.started.line)
      if (isUnknown(lh)) return { contained: lh }
      return { contained: lh ? await G.isAncestor(this.cfg.project, revision, lh) : false }
    }
    return {}
  }

  /** Asks the user (For you, §16.8.5): `ApprovalRequested` and a notification. */
  askUser(w: Write, kind: ForYouKind, gate: string, text: string): string {
    const s = w.state()
    const request = `${w.card.key}/r${s.lastSeq + 1}`
    w.fact('ApprovalRequested', { request, kind, gate, text, ...(s.latest ? { submission: s.latest.id, revision: s.approved?.revision ?? s.latest.revision } : {}) })
    w.action('notify', { text })
    return request
  }

  /** Wakes an agent: a durable action delivered once (§16.4.5). */
  wake(w: Write, agent: string | null | undefined, why: string): void {
    if (agent && agent !== 'user') w.action('wake', { agent, why })
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
      w.fact('Accepted', { submission: s.latest!.id })
      w.move('done', 'derived')
      w.action('endLaneIfDone', {})
      return
    }
    if (o.platform === 'none') {
      // Accepted only if the card's paths still hash to the approved revision (§16.3.3).
      const approved = s.approved?.revision ?? null
      if (!isUnknown(fin.noneRevision) && fin.noneRevision === approved) {
        w.fact('Accepted', { revision: approved! })
        w.move('done', 'derived')
        w.action('endLaneIfDone', {})
      } else {
        w.fact('Stale', { approved, current: isUnknown(fin.noneRevision) ? null : (fin.noneRevision ?? null), why: 'change' })
        w.move(hasStage(r, 'review') ? 'review' : 'active', 'derived')
        this.wake(w, s.started?.builder, 'stale: your paths changed since the pass, submit again')
      }
      return
    }
    const needOk = okBeforeApplies(r, w.card.labels) && !approvedByUser(s, 'okBefore')
    switch (o.finish) {
      case 'hiveMerges':
        if (needOk) {
          w.move('approved', 'derived')
          this.askUser(w, 'approve', 'okBefore', `${w.card.key} is approved: OK to merge?`) // i18n-ignore: the request's text in the spike (P4 makes it a message)
        } else this.enqueue(w)
        return
      case 'agentMerges':
        w.move('approved', 'derived')
        if (needOk) this.askUser(w, 'approve', 'okBefore', `${w.card.key} is approved: OK to merge?`) // i18n-ignore: the request's text in the spike (P4 makes it a message)
        else this.wake(w, s.started?.builder, 'approved: merge it and report the merge')
        return
      case 'committed':
        // Its revision is on the folder's line by construction: done.contained.
        if (fin.contained === true) {
          w.fact('Integrated', { revision: s.approved!.revision!, target: s.started!.target ?? '', result: s.approved!.revision!, method: 'committed', by: 'hive' })
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
  async submit(ref: unknown, actor: Actor, args: { summary: string; revision?: string; note?: string; paths?: string[]; override?: FactData['Override'] }): Promise<Reply> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    let card = card0
    let s = this.state(card)
    if (!s.started) return this.notFrom(card, actor, s, 'submit')
    const r = this.rulesetOf(card, s)
    const o = r.options
    const agent = agentOf(actor)
    const folder = this.folderOf(s)
    const from = s.stage

    // After a queue failure: the same approved, unstale revision goes straight back into the queue (no review, no round).
    const last = s.entries.at(-1)
    if (from === 'active' && o.finish === 'hiveMerges' && card.kind === 'code' && last && (last.state === 'failed' || last.state === 'cancelled') && !s.stale) {
      const now = await this.revisionNow(card, s)
      if (!isUnknown(now) && now && now === s.approved?.revision) {
        await this.cfg.hooks?.beforeWrite?.('submit')
        const g = await this.write(card, r, actor, (w) => {
          const bad = this.check(w, 'requeue', { agent, revision: now })
          if (bad) return bad
          this.enqueue(w, 'transient')
          return null
        })
        return g ? this.refuse(card, actor, 'submit', g) : this.ok(card, from, 'merging', { requeued: true })
      }
    }
    if (!(from === 'active' || ((from === 'approved' || from === 'review') && s.stale) || from === 'review')) return this.notFrom(card, actor, s, 'submit')

    // The submission: revision, fixed endpoints, key and files.
    let revision: string | null = null
    let base: string | null = null
    let key: string | null = null
    let files: FactData['Submitted']['files'] = []
    let commits: string[] | undefined
    let paths: string[] | undefined
    const inputs: Omit<GuardInputs, 'card' | 'state' | 'ruleset'> = { agent, folder }
    const warnings: string[] = []
    if (card.kind === 'code' && o.platform === 'none') {
      if (args.paths) card = this.store.updateCard(card.id, { paths: args.paths })
      paths = card.paths ?? this.prefill(card)
      if (!card.paths) card = this.store.updateCard(card.id, { paths })
      const rev = this.none.revision(paths)
      if (isUnknown(rev)) return this.refuse(card, actor, 'submit', { rule: 'platform.unknown', values: { card: card.key, what: rev.what, rule: 'submit' } })
      revision = rev.revision
      base = s.started.base
      files = NoneAdapter.diff(s.started.manifest ?? {}, rev.manifest)
      key = revision
      if (!files.length && revision === s.started.base) return this.refuse(card, actor, 'submit', { rule: 'submit.empty', values: { card: card.key } })
    } else if (card.kind === 'code') {
      if (this.ownLine(s)) {
        const h = await G.head(folder)
        if (isUnknown(h)) return this.refuse(card, actor, 'submit', { rule: 'platform.unknown', values: { card: card.key, what: h.what, rule: 'submit' } })
        if (args.revision && args.revision !== h) return this.refuse(card, actor, 'submit', { rule: 'check.revisionMismatch', values: { revision: args.revision.slice(0, 7) } })
        revision = h
        const th = await G.lineHead(this.cfg.project, s.started.target ?? '')
        const mb = !isUnknown(th) && th ? await G.mergeBase(this.cfg.project, th, h) : th
        if (isUnknown(mb) || !mb) return this.refuse(card, actor, 'submit', { rule: 'platform.unknown', values: { card: card.key, what: 'the merge base with the target', rule: 'submit' } })
        base = mb
      } else {
        // A shared folder: the card's change is its own attributed commits (§16.3.2).
        const { reconcile } = await import('./reconcile')
        await reconcile(this, card)
        s = this.state(card)
        commits = s.attributed
        revision = commits.at(-1) ?? s.started!.base
        base = s.started!.base
      }
      if (revision && base) {
        const c = commits && commits.length ? await this.ownChange(base, commits) : await G.change(this.cfg.project, base, revision)
        if (isUnknown(c)) return this.refuse(card, actor, 'submit', { rule: 'platform.unknown', values: { card: card.key, what: c.what, rule: 'submit' } })
        files = c.files
        key = c.key
      }
      if (!revision || revision === base || !files.length) return this.refuse(card, actor, 'submit', { rule: 'submit.empty', values: { card: card.key } })
      // Gathered for the guards the ruleset holds.
      const guards = r.guards.submit
      if (guards.includes('submit.clean')) inputs.dirty = await G.dirty(folder, this.ownLine(s) || !agent || !this.cfg.locksOf ? undefined : this.cfg.locksOf(agent))
      if (guards.includes('submit.ready')) inputs.conflicts = []
      if (guards.includes('submit.trailer')) inputs.untrailered = this.untrailered(card, s)
      if (guards.includes('submit.identity')) inputs.badIdentity = await this.badIdentity(base!, revision, commits, o)
      if (o.sharedFolderWarning && !this.ownLine(s)) warnings.push(...this.othersFiles(card, s, files.map((f) => f.path)))
    }
    inputs.revision = revision
    if (r.guards.submit.includes('submit.checksPassed') && card.kind === 'code') inputs.checksMissing = o.preChecks.filter((name) => !s.checks.some((c) => c.name === name && c.revision === revision && c.result === 'passed' && c.counted))
    if (agent && this.cfg.runsOf) inputs.runsGoing = this.cfg.runsOf(agent)

    // The same revision again: a new submission only with a note (§16.8.1).
    const earlier = card.kind === 'code' ? s.submissions.find((x) => x.revision === revision) : undefined
    const waiting = (from === 'review' || from === 'approved') && !s.stale
    if (earlier && !waiting && !args.note && !args.override) return this.refuse(card, actor, 'submit', { rule: 'submit.sameRevisionNote', values: { revision: revision!.slice(0, 7) } })

    const fin = o.review === 'none' ? await this.finishInputs(card, s, r, revision) : {}
    await this.cfg.hooks?.beforeWrite?.('submit')
    const out = await this.write(card, r, actor, (w) => {
      const noCode = card.kind === 'no-code'
      const noCodeGuards: GuardId[] = ['submit.notDuplicate', 'submit.ownRunsStopped', 'submit.decisionsReceived']
      const bad = args.override ? null : this.check(w, 'submit', inputs, noCode ? (id) => noCodeGuards.includes(id) : undefined)
      if (bad) return bad
      if (args.override) w.fact('Override', args.override)
      if (from === 'review' && !s.stale) return { rule: 'move.notFromHere', values: { card: card.key, stage: from, move: 'submit', moves: this.movesFrom(from).join(', ') } } as GuardRefusal
      const st = w.state()
      const sub = w.fact('Submitted', {
        revision,
        base,
        head: revision,
        key,
        files,
        round: st.rounds + 1,
        generation: agent ? (st.received[agent] ?? 0) : st.generation,
        sameRevision: !!earlier,
        summary: args.summary,
        ...(args.note ? { note: args.note } : {}),
        ...(paths ? { paths } : {}),
        ...(commits ? { commits } : {}),
        ...(warnings.length ? { warnings } : {})
      })
      if (revision && o.platform === 'git') w.action('pin', { ref: `refs/hive/cards/${card.key.toLowerCase()}/${st.submissions.length + 1}`, revision, submission: sub.seq })
      if (o.review === 'none') {
        this.finish(w, fin)
        return null
      }
      w.move('review', args.override ? 'override' : 'intent')
      w.action('prepareReviewCopy', { revision })
      if (reviewerAgent(o.review)) this.wake(w, this.reviewerOf(card), `${card.key} is in Review`)
      else this.askUser(w, 'approve', 'review', `${card.key} waits for your review`) // i18n-ignore: the request's text in the spike (P4 makes it a message)
      return null
    })
    if (out) return this.refuse(card, actor, 'submit', out)
    return this.ok(card, from, this.state(card).stage, { revision, base, files: files.length }, warnings)
  }

  /** The combined change of a shared-folder card's own commits, applied in order (§16.3.2). */
  private async ownChange(base: string, commits: string[]): Promise<Maybe<{ files: FactData['Submitted']['files']; key: string | null }>> {
    const files = new Map<string, string>()
    const keys: string[] = []
    for (const c of commits) {
      const parent = await G.resolve(this.cfg.project, `${c}^`)
      if (isUnknown(parent)) return parent
      const ch = await G.change(this.cfg.project, parent ?? base, c)
      if (isUnknown(ch)) return ch
      for (const f of ch.files) files.set(f.path, f.status)
      if (ch.key) keys.push(ch.key)
    }
    return { files: [...files].map(([path, status]) => ({ path, status })), key: keys.length ? keys.join('+') : null }
  }

  /** A commit attributed to no card, made in the card's folder since it started, when another unfinished card shares it. */
  private untrailered(card: CardRecord, s: CardState): string | null {
    const others = this.store.cards().filter((c) => c.id !== card.id && ['active', 'review', 'approved'].includes(c.stage) && this.state(c).started?.folder === 'project')
    if (!others.length) return null
    const lastSub = s.latest?.commits?.at(-1)
    const rows = this.store.folderCommits(this.cfg.project)
    const since = lastSub ? rows.slice(rows.findIndex((x) => x.sha === lastSub) + 1) : rows
    return since.find((x) => x.card === null)?.sha ?? null
  }

  /** G16: files of the change that another agent holds or held file locks on (a warning, never a refusal). */
  private othersFiles(card: CardRecord, s: CardState, files: string[]): string[] {
    if (!this.cfg.locksOf) return []
    const out: string[] = []
    for (const c of this.store.cards()) {
      const b = c.id === card.id ? null : this.state(c).started?.builder
      if (!b || b === s.started?.builder) continue
      const theirs = this.cfg.locksOf(b)
      for (const f of files) if (theirs.includes(f)) out.push(`${f} is ${b}'s (${c.key})`) // i18n-ignore: agent-facing warning in the spike's reply
    }
    return out
  }

  private async badIdentity(base: string, revision: string, commits: string[] | undefined, o: WorkflowOptions): Promise<Maybe<string | null>> {
    if (!o.identity) return null
    const list = await G.commits(this.cfg.project, `${base}..${revision}`)
    if (isUnknown(list)) return list
    const mine = commits ? list.filter((c) => commits.includes(c.commit)) : list
    return mine.find((c) => c.email.toLowerCase() !== o.identity!.email.toLowerCase())?.commit ?? null
  }

  /** start review: the reviewer takes the latest submission (§16.8.1). */
  async startReview(ref: unknown, actor: Actor, args: { submission?: number } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'review') return this.notFrom(card, actor, s, 'start review')
    const sub = args.submission !== undefined ? s.submissions.find((x) => x.id === args.submission) : s.latest
    if (!sub) return this.refuse(card, actor, 'start review', { rule: 'review.noSubmission', values: { card: card.key } })
    const r = this.rulesetOf(card, s)
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.check(w, 'startReview', { agent: agentOf(actor) })
      if (bad) return bad
      w.fact('ReviewStarted', { reviewer: agentOf(actor) ?? 'user', submission: sub.id, revision: sub.revision })
      return null
    })
    if (out) return this.refuse(card, actor, 'start review', out)
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
    let moved: { to: string; base: string | null; same: boolean } | null = null
    if (args.pass && sub?.revision && this.ownLine(s)) {
      const h = await G.head(this.folderOf(s))
      if (!isUnknown(h) && h !== sub.revision) {
        const th = await G.lineHead(this.cfg.project, s.started!.target ?? '')
        const b2 = !isUnknown(th) && th ? await G.mergeBase(this.cfg.project, th, h) : null
        const same = r.options.sameness === 'change' && !!b2 && !isUnknown(b2) && !!sub.base && (await G.sameChange(this.cfg.project, { base: sub.base, revision: sub.revision, key: sub.key }, { base: b2, revision: h }))
        moved = { to: h, base: b2 && !isUnknown(b2) ? b2 : null, same }
      }
    }
    const fin = args.pass ? await this.finishInputs(card, s, r, moved?.same ? moved.to : sub?.revision) : {}
    await this.cfg.hooks?.beforeWrite?.('verdict')
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.check(w, 'verdict', { agent, submission: args.submission })
      if (bad) return bad
      const st = w.state()
      w.fact('Verdict', { reviewer: agent ?? 'user', submission: subId!, revision: sub?.revision ?? null, pass: args.pass, ...(args.failKind ? { failKind: args.failKind } : {}), round: args.pass ? st.rounds : st.rounds + 1, generation: agent ? (st.received[agent] ?? 0) : st.generation, comment: args.comment })
      if (!args.pass) {
        w.move('active', 'intent')
        this.wake(w, st.started?.builder, `${card.key} failed review`)
        return null
      }
      if (moved && !moved.same) {
        w.fact('Stale', { approved: sub!.revision, current: moved.to, why: r.options.sameness === 'exact' ? 'exact' : 'change' })
        if (hasStage(r, 'approved')) w.move('approved', 'derived')
        this.wake(w, st.started?.builder, 'stale: submit again')
        return null
      }
      if (moved?.same) w.fact('CarriedOver', { from: sub!.revision!, to: moved.to, toBase: moved.base, how: 'replay' })
      const now = w.state()
      if (passingReviewers(now).length < r.options.reviewers) return null
      if (reviewByYou(r.options.review) && !approvedByUser(now, 'review')) {
        this.askUser(w, 'approve', 'review', `${card.key} passed review: your OK?`) // i18n-ignore: the request's text in the spike (P4 makes it a message)
        return null
      }
      this.finish(w, fin)
      return null
    })
    if (out) return this.refuse(card, actor, 'verdict', out)
    return this.ok(card, 'review', this.state(card).stage)
  }

  /** The user answers a request (§16.8.5): an approval satisfies its gate; a decline is a round. Never a decision. */
  async answer(ref: unknown, request: string, answer: 'approved' | 'declined' | 'answered', note?: string): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const req = s.requests.find((x) => x.request === request)
    if (!req) return this.refuse(card, 'user', 'answer', { rule: 'move.notFromHere', values: { card: card.key, stage: s.stage, move: 'answer', moves: '' } })
    const r = this.rulesetOf(card, s)
    const fin = await this.finishInputs(card, s, r, s.approved?.revision ?? s.latest?.revision)
    const from = s.stage
    await this.write(card, r, 'user', (w) => {
      w.fact('Approval', { request, answer, ...(note ? { note } : {}), generation: s.generation, ...(req.submission !== undefined ? { submission: req.submission } : {}) })
      const builder = s.started?.builder
      if (answer === 'declined') {
        w.move('active', 'user')
        this.wake(w, builder, `${card.key}: the user declined it`)
        return
      }
      if (answer !== 'approved' || req.kind !== 'approve') {
        this.wake(w, builder, `${card.key}: the user answered`)
        return
      }
      const now = w.state()
      if (req.gate === 'review') {
        if (!notApproved(now, r, card.labels) || notApproved(now, r, card.labels)?.missing === 'userOk') this.finish(w, fin)
      } else if (req.gate === 'okBefore') {
        if (r.options.finish === 'hiveMerges') this.enqueue(w)
        else this.wake(w, builder, 'approved: merge it and report the merge')
      }
    })
    return this.ok(card, from, this.state(card).stage)
  }

  /** report merge (§16.9.3): the builder merged; Hive checks containment (unless Not checked), then Done. */
  async reportMerge(ref: unknown, actor: Actor, args: { result?: string } = {}): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    if (s.stage !== 'approved') return this.notFrom(card, actor, s, 'report merge')
    const r = this.rulesetOf(card, s)
    const target = s.started?.target ?? ''
    const rev = s.approved?.revision ?? s.latest?.revision ?? null
    let contained: Maybe<boolean> | undefined
    let method: FactData['Integrated']['method'] = 'merge'
    if (r.guards.reportMerge.includes('done.contained')) {
      // Integration needs a non-empty change (§16.4.4).
      if (!rev || !s.approved?.base || rev === s.approved.base) contained = false
      else {
        const c = await G.contains(this.cfg.project, target, { base: s.approved.base, revision: rev, key: s.latest?.key })
        contained = isUnknown(c) ? c : !!c
        if (!isUnknown(c) && c) method = c.method === 'sameTree' ? 'sameTree' : c.method
      }
    }
    const th = await G.lineHead(this.cfg.project, target)
    const out = await this.write(card, r, actor, (w) => {
      const bad = this.check(w, 'reportMerge', { agent: agentOf(actor), contained, revision: rev, target })
      if (bad) return bad
      if (contained === true) w.fact('Integrated', { revision: rev!, target, result: args.result ?? (!isUnknown(th) && th ? th : rev!), method, by: 'agent' })
      w.move('done', 'intent')
      w.action('endLaneIfDone', {})
      w.action('releaseSlot', {})
      return null
    })
    if (out) return this.refuse(card, actor, 'report merge', out)
    return this.ok(card, 'approved', 'done')
  }

  /** ask the user (§16.8.1): For you of a kind. */
  async askTheUser(ref: unknown, actor: Actor, args: { kind: ForYouKind; text: string }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      this.askUser(w, args.kind, 'ask', args.text)
    })
    return this.ok(card, s.stage, s.stage)
  }

  /** couldn't within the rules (#686): For you (Decide), never a failed round, never a stall. */
  async cannotWithinRules(ref: unknown, actor: Actor, args: { rule: string; why: string }): Promise<Reply> {
    const card = this.resolve(ref, actor)
    if (isRefusal(card)) return card
    const s = this.state(card)
    await this.write(card, s.started ? this.rulesetOf(card, s) : null, actor, (w) => {
      const request = `${card.key}/r${s.lastSeq + 1}`
      w.fact('CannotWithinRules', { rule: args.rule, why: args.why, request })
      w.fact('ApprovalRequested', { request, kind: 'decide', gate: args.rule, text: args.why })
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
      this.wake(w, s.started?.builder, `${card.key}: the reviewer asks: ${text}`)
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
      const generation = s.generation + 1
      w.fact('Decision', { decision: `${card.key}/d${generation}`, generation, text })
      this.wake(w, s.started?.builder, `${card.key} has a new decision`)
      if (['review', 'approved', 'merging'].includes(from)) this.wake(w, this.reviewerOf(card), `${card.key} has a new decision`)
      if (!r || (from !== 'approved' && from !== 'merging')) return
      const entry = openEntry(s)
      // After IntegrationStarted it's too late to stop that merge: it completes, then For you (§16.4.6).
      if (entry?.state === 'started') return
      w.fact('Stale', { approved: s.approved?.revision ?? null, current: s.approved?.revision ?? null, why: 'decision' })
      if (entry) w.fact('IntegrationCancelled', { entry: entry.id, reason: 'decision' })
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
    await this.write(card, null, actor, (w) => (reason ? w.fact('Blocked', { reason }) : w.fact('Unblocked', {})))
  }

  /** The rules a drag from one stage to another would skip (§16.8.4): the guards of the moves it jumps over. */
  skippedRules(card: CardRecord, r: Ruleset, from: StageId, to: StageId): string[] {
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
  async move(ref: unknown, to: StageId, by: 'user' | 'assistant', opts: { confirm?: boolean; reason?: string; builder?: string } = {}): Promise<Moved | Ask | Refusal> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const from = s.stage
    if (to === from) return this.ok(card, from, to)
    const r = this.rulesetOf(card, s)
    // On Hold cancels a queue entry and keeps the lease; leaving it returns the card where it was (§16.7.4).
    if (to === 'hold') {
      await this.write(card, r, by, (w) => {
        const e = openEntry(s)
        if (e) w.fact('IntegrationCancelled', { entry: e.id, reason: 'hold' })
        w.move('hold', 'user')
      })
      return this.ok(card, from, 'hold')
    }
    if (from === 'hold') {
      const back = [...this.store.facts(card.id)].reverse().find((f): f is Fact<'Moved'> => f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'hold')
      const was = back?.data.from ?? 'todo'
      if (to === was) {
        await this.write(card, r, by, (w) => {
          // A card that was queued (Merging, or Approved under Hive merges) is queued again.
          const requeue = was === 'merging' || (was === 'approved' && r.options.finish === 'hiveMerges' && !s.stale && !notApproved(s, r, card.labels))
          w.move(requeue ? 'approved' : was, 'user')
          if (requeue) this.enqueue(w)
        })
        return this.ok(card, from, this.state(card).stage)
      }
    }
    // A drag that stands for an intent (Todo → Active is Start) runs it: through its guards, or across them as an
    // override whose recorded facts still run (§16.8.4), never a bare move that leaves the card without its Started.
    if (from === 'todo' && to === 'active') {
      const started = await this.start(card.id, by, { builder: opts.builder })
      if (!isRefusal(started)) return started
      const rules = [...new Set([started.rule, ...r.guards.start])]
      if (started.rule === 'platform.unknown' || started.rule === 'card.plainNumber') return started
      if (by === 'user' && !opts.confirm) return { ask: true, card: card.key, rules }
      if (by === 'assistant' && !opts.reason) return this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: rules.join(', ') } }, 'the user or the Assistant')
      return this.start(card.id, by, { builder: opts.builder, override: { rules, move: 'todo→active', by, reason: opts.reason ?? '' } })
    }
    // Active → Review is a submit at the card's revision, for the reviewer to start a review of.
    if (from === 'active' && to === 'review' && card.kind === 'code' && hasStage(r, 'review')) {
      const rules = r.guards.submit.filter((g) => g !== 'submit.notDuplicate')
      if (rules.length && by === 'user' && !opts.confirm) return { ask: true, card: card.key, rules }
      if (rules.length && by === 'assistant' && !opts.reason) return this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: rules.join(', ') } }, 'the user or the Assistant')
      const sub = await this.submit(card.id, by, { summary: '', ...(rules.length ? { override: { rules, move: 'active→review', by, reason: opts.reason ?? '' } } : {}) })
      if (!isRefusal(sub) || sub.rule === 'platform.unknown') return sub
    }
    const skipped = this.skippedRules(card, r, from === 'hold' ? 'todo' : from, to)
    if (skipped.length && by === 'user' && !opts.confirm) return { ask: true, card: card.key, rules: skipped }
    if (skipped.length && by === 'assistant' && !opts.reason) return this.refuse(card, 'assistant', 'move', { rule: 'move.needsOverride', values: { card: card.key, stage: to, rules: skipped.join(', ') } }, 'the user or the Assistant')
    await this.write(card, r, by, (w) => {
      if (skipped.length) w.fact('Override', { rules: skipped, move: `${from}→${to}`, by, reason: opts.reason ?? '' })
      // Leaving a stage with a queue entry cancels it (the user moved it out).
      const e = openEntry(s)
      if (e && to !== 'merging') w.fact('IntegrationCancelled', { entry: e.id, reason: 'user' })
      w.move(to, skipped.length ? 'override' : 'user')
      if (to === 'done') w.action('endLaneIfDone', {})
    })
    return this.ok(card, from, to)
  }

  /**
   * An agent's `hive_update_task` column move (§16.7.1): refused with the intent to use; or, for one transition (P4
   * to P8), translated into that intent through the same guards (§16.17).
   */
  async agentColumnMove(ref: unknown, actor: Actor, column: 'doing' | 'review' | 'passed' | 'done' | 'todo', opts: { translate?: boolean; summary?: string } = {}): Promise<Reply> {
    const intent = { doing: 'start', review: 'submit', passed: 'verdict', done: 'report merge', todo: 'put back' }[column]
    if (!opts.translate) {
      const card = this.resolve(ref, actor)
      return this.refuse(isRefusal(card) ? null : card, actor, `column ${column}`, { rule: 'move.useIntent', values: { intent } }, null)
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
    await this.write(card, r, 'user', (w) => {
      if (!e) return
      w.fact('Override', { rules: ['integrate'], move: 'remove from queue', by: 'user', reason })
      w.fact('IntegrationCancelled', { entry: e.id, reason: 'removed' })
      w.move('approved', 'user')
    })
    return this.ok(card, s.stage, this.state(card).stage)
  }

  /** Retry merge (the user's override): requeues an unchanged revision once, even after a red check (§16.8.1). */
  async retryMerge(ref: unknown, reason = ''): Promise<Reply> {
    const card = this.resolve(ref)
    if (isRefusal(card)) return card
    const s = this.state(card)
    const r = this.rulesetOf(card, s)
    await this.write(card, r, 'user', (w) => {
      w.fact('Override', { rules: ['requeue.allowed'], move: 'retry merge', by: 'user', reason })
      this.enqueue(w, 'retry')
    })
    return this.ok(card, s.stage, this.state(card).stage)
  }

  // --- None: a card's paths (§16.3.3).

  /** Edits Hive saw through the card's agents' hooks and file locks: the pre-fill of its paths. */
  noteEdit(card: CardRecord, path: string): void {
    const key = `prefill:${card.id}`
    const list: string[] = JSON.parse(this.store.meta(key) ?? '[]')
    if (!list.includes(path)) this.store.setMeta(key, JSON.stringify([...list, path]))
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
    return JSON.parse(this.store.meta(`prefill:${card.id}`) ?? '[]')
  }

  /** declare paths (None): sets the card's paths; replies with the pre-fill, the unclaimed changes and the revision. */
  async declarePaths(ref: unknown, actor: Actor, paths: string[]): Promise<{ prefill: string[]; unclaimed: string[]; revision: string | null } | Refusal> {
    const card0 = this.resolve(ref, actor)
    if (isRefusal(card0)) return card0
    const card = this.store.updateCard(card0.id, { paths })
    const rev = this.none.revision(paths)
    return { prefill: this.prefill(card), unclaimed: this.unclaimed(card), revision: isUnknown(rev) ? null : rev.revision }
  }

  /** Deliverables changed since the card started that are in neither its paths nor its pre-fill: for it to add or leave. */
  unclaimed(card: CardRecord): string[] {
    const before: Record<string, string> = JSON.parse(this.store.meta(`deliverables:${card.id}`) ?? '{}')
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
    const v = this.store.meta(`lane:${id}`)
    return v ? JSON.parse(v) : null
  }

  private saveLane(l: LaneList): void {
    this.store.setMeta(`lane:${l.id}`, JSON.stringify(l))
  }

  /** Starts a lane: its cards use the ruleset in force now until it ends. */
  startLane(id: string, cards: number[], reviewer?: string): LaneList {
    const r = this.currentRuleset()
    const l = newLane(id, cards, r.id)
    for (const c of cards) this.store.updateCard(c, { lane: id, ...(reviewer ? { reviewer } : {}) })
    this.saveLane(l)
    return l
  }

  /** Changes a lane's list: never refused; queued while a card is in flight ("list changes after AM-2"). */
  changeLane(id: string, cards: number[]): { lane: LaneList; queuedAfter: string | null } {
    const l = this.lane(id)!
    const current = l.current !== null && !this.doneByFacts(l.current) ? l.current : null
    const next = changeList({ ...l, current }, cards)
    for (const c of cards) this.store.updateCard(c, { lane: id })
    this.saveLane(next)
    return { lane: next, queuedAfter: current !== null ? this.store.card(current).key : null }
  }

  /** The lane's next card, read from Hive: one at a time, a queued change applied at the boundary. */
  laneNext(id: string): number | null {
    const { lane, card } = nextCard(this.lane(id)!, (c) => this.doneByFacts(c))
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
        if (this.store.deliver({ action: id, kind, target: 'user', payload })) this.cfg.effects?.notify?.(card, String(payload.text))
        return
      case 'prepareSlot': {
        const f = await G.isolate(this.cfg.project, String(payload.folder), String(payload.line), String(payload.base))
        if (isUnknown(f)) throw new Error(f.what) // i18n-ignore: an action's failure, recorded on the action
        return
      }
      case 'pin':
        await G.pin(this.cfg.project, String(payload.ref), String(payload.revision))
        return
      case 'endLaneIfDone': {
        if (!card.lane) return
        const l = this.lane(card.lane)
        if (!l || l.ended) return
        const cards = l.pending ?? l.cards
        if (!cards.every((c) => this.doneByFacts(c))) return
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
