// A card's work, read (#1223): the fold of its facts (facts.ts) as the window and the Agent API show it. The line, base
// and folder; each revision submitted with its round, files, time and builder; the verdicts tied to their submission
// and round; the checks per revision, counted or not; the marks (carried over, stale, outside the rules, merged in part,
// left the target); the integration; the decisions' generations; and whether the card is from before 1.0 or adopted.
// Pure: main reads the facts (workflow/cardWork.ts), the window formats revisions through its project's platform
// descriptor (`revisionShort`), never by switching on a platform's id.

import type { ConflictsRecord } from './conflicts'
import { askedQuestion, foldCard, type Actor, type AskAction, type AskActionKind, type CardKind, type CardState, type CheckRanData, type Fact, type FactData, type LoopAsk, type FileChange, type ForYouKind, type QueueEntry, type RoundChoice, type StageId } from './facts'
import type { StoredText } from '../types'
import { baseRulesetId, REVIEW_SKIPPED, rulesBaseId } from './compile'

/** An Override's move when the user applied changed options to a card in flight (§16.11.4, OP-38). */
export const APPLY_OPTIONS = 'applyOptions'

/**
 * The ruleset a started card keeps (§16.5.4): the one its cycle started with, unless changed options were applied to it
 * since (Apply to cards in flight: the latest such Override's). Null for a card not started, back in Todo (its next
 * cycle takes the rules in force then), or whose start recorded none (from before 1.0, rules not read). The runtime's
 * `rulesetOf` reads a card's rules by it; a lane's card in Todo uses its lane's, which this doesn't say.
 */
export function ownRuleset(facts: readonly Fact[], s: Pick<CardState, 'started' | 'stage' | 'cycle'>): string | null {
  if (!s.started || s.stage === 'todo') return null
  // The options applied to it since (an Override), or its target moved (HI-2753: its rules then, merging into the new one).
  const applied = facts.filter((x) => x.seq > s.cycle && !!x.ruleset && ((x.kind === 'Override' && (x.data as FactData['Override']).move === APPLY_OPTIONS) || x.kind === 'Retargeted')).at(-1)
  return (applied ?? facts.find((x) => x.seq === s.cycle))?.ruleset ?? null
}

/** A request waiting for the user (For you, §16.8.5), as the window lists it (IPC `tasks:forYou`). */
export interface ForYouItem {
  card: number
  /** The card's project (its folder name; empty: a card about the workspace). */
  project: string
  request: string
  kind: ForYouKind
  /** What it waits on: a gate (`review`, `okBefore`, `roundLimit`), `ask` (an agent's question), or a rule it couldn't keep. */
  gate: string
  /** In English, as agents read it (an agent's question: its own words). */
  text: string
  /** Combwork's own request's message, for the window in its language (#1264); none for an agent's words. */
  shown?: StoredText
  /** When it was asked. */
  since: string
  /** The agent who asked; null: Combwork. */
  asker: string | null
  /** Whom it waits on: the user (a person later, #439). */
  for: 'user'
  /** A Test request's checklist: what to try (#1267). */
  checklist?: string[]
  /** What an agent's question offers the user to do on its card (#1630), with its suggested reasons. */
  actions?: AskAction[]
}

/** What waits for the user, in a workspace or one project: each request, oldest first, and their count. */
export interface ForYouSummary {
  items: ForYouItem[]
  count: number
}

/**
 * The user's answer to a request (IPC `tasks:answer`): approve or decline it, or answer it with a reply, a decision (a
 * Decide request: recorded on the card) or, at the round limit, a choice (a carry on with the rounds it adds).
 */
export interface ForYouAnswer {
  outcome: 'approved' | 'declined' | 'answered'
  reply?: string
  decision?: string
  choice?: RoundChoice
  rounds?: number
  /** An action the question offers (#1630), done as the user with `reason`. */
  action?: AskActionKind
  reason?: string
}

/** Approve, with the user's optional note as its reply (HI-2286): a bare Approve sends none. */
export const approveAnswer = (note = ''): ForYouAnswer => (note.trim() ? { outcome: 'approved', reply: note.trim() } : { outcome: 'approved' })

/** Decline, with the user's reason as its reply (required: the window asks for one). */
export const declineAnswer = (why: string): ForYouAnswer => ({ outcome: 'declined', reply: why.trim() })

/**
 * Whether the user can do an action a question offers on its card now (#1630): Move to Done unless it is Done, Make It
 * No Code on a code card, Unblock on a blocked one, Skip Review before it is in Review; none on an archived card. The
 * window shows only these; main checks.
 */
export function askActionAvailable(kind: AskActionKind, card: { column: string; blocked?: string | null; archived?: boolean; kind?: CardKind }): boolean {
  if (card.archived) return false
  if (kind === 'done') return card.column !== 'done'
  if (kind === 'noCode') return (card.kind ?? 'code') === 'code'
  // Skip its review (HI-1734): before it is in Review (one skipped already is left as it is).
  if (kind === 'skipReview') return card.column === 'todo' || card.column === 'doing'
  return !!card.blocked
}

/**
 * A card's requests for the user, oldest first: from its facts folded (its open requests). On a card in Done, a question
 * (an agent's or the Assistant's) is settled however the card got there (#1638): only Combwork's own requests are listed (a
 * merge stopped part way, a decision after the merge).
 */
export function forYouItems(card: { card: number; project: string; stage: StageId }, facts: readonly Fact[]): ForYouItem[] {
  const open = foldCard(facts, card.stage).requests
  return (card.stage === 'done' ? open.filter((r) => !askedQuestion(r)) : open).map((r) => ({
    card: card.card,
    project: card.project,
    request: r.request,
    kind: r.kind,
    gate: r.gate,
    text: r.text,
    ...(r.requestText ? { shown: r.requestText } : {}),
    since: r.at,
    asker: r.asker ?? null,
    for: r.for ?? 'user',
    ...(r.checklist?.length ? { checklist: r.checklist } : {}),
    ...(r.actions?.length ? { actions: r.actions } : {})
  }))
}

export interface WorkRevision {
  /** The submission's id (its fact's seq): what verdicts name. */
  submission: number
  /** Null for a no-code card. */
  revision: string | null
  base: string | null
  round: number
  files: FileChange[]
  at: string
  /** The builder agent who submitted it (null: not an agent). */
  by: string | null
  /** The decision generation the builder had received. */
  generation: number
  sameRevision: boolean
  adopted: boolean
  /** Warnings that didn't refuse it. */
  warnings: string[]
  /** The builder's summary with it. */
  summary: string
  /**
   * What couldn't be read when it was submitted, and why (its fact's `platform.unknown`: `revision`, `files`…), so a
   * revision or diff never read isn't shown as none (#1224 round 1, finding 2). Empty when all was read.
   */
  unknown: Record<string, string>
  /** The same reasons as data where a platform's read gave one (its `platform.unknownText`, #1477): the window words them. */
  unknownText: Record<string, StoredText>
  /** HI-2869: jj's change id of the revision, and how many commits its chain holds, where the submission recorded them. */
  change?: string
  chain?: number
}

export interface WorkVerdict {
  submission: number
  revision: string | null
  reviewer: string
  pass: boolean
  failKind?: 'content' | 'explanation'
  round: number
  generation: number
  at: string
  /**
   * A verdict that still counts: on the latest submission, at the card's current decision generation, and not made stale
   * by another change since (a pass carried over to the same change still counts).
   */
  current: boolean
}

export interface WorkCheck {
  name: string
  /** The card's revision the run was for, and what was checked out where it ran. */
  revision: string
  tested: string
  result: CheckRanData['result']
  counted: boolean
  whyNot?: CheckRanData['whyNot']
  run: string
  by: string
  durationMs: number
  at: string
  /** Run with `--isolated` in a check copy of its own (#1435). */
  isolated?: true
}

export interface WorkMarks {
  /** Passes kept for a later revision that is the same change. */
  carriedOver: { from: string; to: string; how: FactData['CarriedOver']['how']; at: string }[]
  /** A content-stale pass, until the builder submits again. */
  stale: FactData['Stale'] | null
  /** Rules skipped when it was merged by hand before they passed: outside the rules. */
  outsideRules: string[]
  /** Some of the unfinished card's work found in the target. */
  mergedInPart: FactData['MergedInPart'] | null
  /** HI-2709: in Review, its submitted change is already in its target (it stays in Review); for the latest submission and target only. */
  inTarget: FactData['InTarget'] | null
  /** A Done card's revision no longer in its target. */
  leftTarget: FactData['LeftTarget'] | null
  /** The user (or the Assistant) moved the latest submission past its review and approvals. */
  overridden: boolean
  /** The latest move past the card's rules since its work was last Done (§16.8.4): who, which rules, why. */
  override: WorkOverride | null
}

/** A move past a card's rules (an `Override`): who made it, the move, the rules it skipped and why (may be empty). */
export interface WorkOverride {
  by: 'user' | 'assistant'
  move: string
  rules: string[]
  reason: string
  at: string
}

export interface WorkIntegration {
  revision: string
  target: string
  /** The target's revision with the change in it. */
  result: string
  method: FactData['Integrated']['method']
  by: FactData['Integrated']['by']
  /** The merge's own revision when it was merged with one (`method` merge): the result. */
  mergeCommit: string | null
  at: string
  /** HI-2869: how jj proved it (its fact's `platform.jj.via`: ancestry, replay, sameTree, candidate). */
  via?: string
}

/**
 * How a card was accepted where there is no merge to make (§16.4.2): None's code cards by revision, a no-code card by its
 * submission, on either platform.
 */
export interface WorkAcceptance {
  revision: string | null
  submission: number | null
  at: string
  actor: Actor
}

/** The merge queue's newest entry for the card this cycle, and how it stands. */
export interface WorkQueueEntry {
  entry: string
  revision: string
  target: string
  state: 'open' | 'started' | 'cancelled' | 'failed' | 'integrated'
  failure?: FactData['IntegrationFailed']['reason']
  cancelled?: FactData['IntegrationCancelled']['reason']
  /** A return (#1357, the Work section): the files a conflict named, the output kept (a check's, a hook's), whether it was the environment's failure, and when. */
  files?: string[]
  /** A conflict's hunks, file by file, as the queue's folder had them (HI-1181), bounded. */
  conflicts?: ConflictsRecord
  log?: string
  /** A red check's return (HI-1924): the check that failed and its run's log, as the outcome recorded them. */
  check?: string
  logPath?: string
  transient?: boolean
  at?: string
  /** Queued again unchanged: after a temporary failure, or the user's Retry merge. */
  requeue?: 'transient' | 'retry'
}

export interface WorkView {
  card: number
  stage: StageId
  /** A card from before 1.0: no facts are invented for it (§16.4.1). */
  preWorkflow: boolean
  /** Started by the upgrade from what could be read (an `Adopted` fact), and the column it was in. */
  adopted: boolean
  adoptedFrom?: 'doing' | 'review' | 'passed'
  /** Its kind (#1277): the card's own now (changed later as an override), else its cycle's; null when neither is known. */
  kind: CardKind | null
  /** A kind a project agent proposed when it made the card, not answered yet (OP-6/OP-7, #1277). */
  kindProposed: CardKind | null
  /** Its own Merges into as the card has it now (HI-2556), null: none (its lane's or the project's). Its start's is `target`. */
  cardTarget: string | null
  /** It skips review (#1625): who set it and their reason; null when it doesn't. */
  reviewSkip: ReviewSkip | null
  /** A project agent's proposal that it skip review, its reason, not answered yet (#1625). */
  reviewSkipProposed: string | null
  /** Where the card works: `project`, or the slot's folder. */
  folder: string | null
  /** The line it works on (Git: its branch); null for None. A jj card's is a key (`jj:…`), never shown: see `workspace`. */
  line: string | null
  /** HI-2869: a jj card's slot workspace, which the window shows in its line's place. */
  workspace?: string
  /**
   * HI-2913: its slot couldn't be prepared for this cycle (a `SlotPrepareFailed` for its lease, no `SlotPrepared` after
   * it): the slot, why (English, as its builder was told) and whether it was a stale jj workspace. The window shows the
   * card not ready there rather than started.
   */
  notReady?: { slot: string; why: string; stale: boolean }
  /** Every line it has started on, over its whole history (HI-1823: an open card's earlier work, never a leftover). */
  lines: string[]
  /** The revision its change starts from. */
  base: string | null
  target: string | null
  builder: string | null
  /** The last head seen in its folder. */
  head: string | null
  /** What couldn't be read when its work started, and why (`line`, `base`, `target`…, its Started's `platform.unknown`). */
  unknown: Record<string, string>
  /** The same reasons as data where a platform's read gave one (its `platform.unknownText`, #1477): the window words them. */
  unknownText: Record<string, StoredText>
  /** The revision the latest submission's passes now cover, and its base. */
  approved: { revision: string | null; base: string | null } | null
  /** This cycle's submissions, oldest first. */
  revisions: WorkRevision[]
  verdicts: WorkVerdict[]
  checks: WorkCheck[]
  marks: WorkMarks
  integration: WorkIntegration | null
  /** Its acceptance this cycle, where there is no merge (None, a no-code card). */
  accepted: WorkAcceptance | null
  queue: WorkQueueEntry | null
  /** Its latest refused request since its last move (#1279): cleared by the card's next move. */
  refused: WorkRefusal | null
  /** The card's newest decision generation (0: none) and the one each agent has received. */
  decisions: { generation: number; received: Record<string, number> }
  /** Failed verdicts and the user's declines, over the card's whole history. */
  rounds: number
  /** Open requests to the user (For you). */
  forYou: number
  /** Requests answered by a decision of the user's (HI-1932), newest first, at most RESOLVED_SHOWN: For you's resolved list. */
  resolvedByDecision: WorkResolved[]
  /**
   * A card loop's step waiting for its reviewer (a design, or a follow-up of reviewed work), null when none: until it is
   * answered, Retry merge is refused (HI-1667), so the window doesn't offer it.
   */
  loopStep: LoopAsk | null
  /** Retry merge was used since its latest submission: after a return, it isn't allowed again for it (HI-1667). */
  retried: boolean
  /** The newest fact's seq: a view is newer than another when this is higher. */
  lastSeq: number
  /** The ruleset it keeps while in flight (`ownRuleset`); null in Todo, before its start, or none recorded. */
  ruleset: string | null
  /** When its current cycle started (its Started's or Adopted's time); null before its first start. */
  startedAt: string | null
}

/**
 * A request answered by a decision the user made (HI-1932): its words as asked (an agent's own, or Combwork's request as data
 * for the window, `shown`), the decision it names (the card's decision's id: its text is the card's, joined in the window),
 * who recorded it (the authenticated recorder: "You", "Assistant") and when.
 */
export interface WorkResolved {
  request: string
  question: string
  shown?: StoredText
  decision: string
  recordedBy: string
  at: string
}

/** How many of a card's resolved requests its view keeps (HI-1932). */
export const RESOLVED_SHOWN = 10

/**
 * A refused request (a `Refused` fact, #1279): its rule and values, from which the window says it in its language as the
 * agent got it in English; `times`: the refusals in a row since the card last moved with the same rule (repeats collapse).
 */
export interface WorkRefusal {
  move: string
  rule: string
  values: Record<string, string | number | StoredText>
  at: string
  times: number
}

/**
 * What a view is made of beside its facts: the card's cached stage (the stage before its first `Moved`, so a card with
 * none, from before 1.0, keeps it: the view's stage is the fold's) and whether it is from before 1.0.
 */
export interface WorkCard {
  card: number
  stage: StageId
  preWorkflow: boolean
  /** Its kind as the card has it (the `kind` column, #1277). */
  kind?: CardKind
  /** Its own Merges into (HI-2556: the `target` column), absent for the project's or its lane's. */
  target?: string
}

/** The kind a project agent proposed (`KindProposed`) and nobody has answered yet (`KindDecided`), or null (#1277). */
export function kindProposed(facts: readonly Fact[]): CardKind | null {
  const p = facts.findLast((f) => f.kind === 'KindProposed')
  if (!p) return null
  return facts.some((f) => f.kind === 'KindDecided' && f.seq > p.seq) ? null : (p.data as FactData['KindProposed']).kind
}

/** A card's review skip and an open proposal of one, as its work view has them (#1625). */
const reviewSkipView = (facts: readonly Fact[]): Pick<WorkView, 'reviewSkip' | 'reviewSkipProposed'> => {
  const r = reviewSkipOf(facts)
  return { reviewSkip: r.skip, reviewSkipProposed: r.proposed }
}

/** A card's review skip (#1625): who set it and their reason, as the badge and the Agent API show it. */
export interface ReviewSkip {
  by: 'user' | 'assistant'
  reason: string
}

/**
 * Whether a card skips review (#1625), from its facts: its latest `ReviewSkipSet` (null: it doesn't), and the reason of a
 * project agent's proposal nobody has answered yet (a `ReviewSkipProposed` with no `ReviewSkipSet` after it).
 */
export function reviewSkipOf(facts: readonly Fact[]): { skip: ReviewSkip | null; proposed: string | null } {
  const set = facts.findLast((f) => f.kind === 'ReviewSkipSet')
  const p = facts.findLast((f) => f.kind === 'ReviewSkipProposed')
  const d = set ? (set.data as FactData['ReviewSkipSet']) : null
  return { skip: d?.skip ? { by: d.by, reason: d.reason } : null, proposed: p && (!set || set.seq < p.seq) ? (p.data as FactData['ReviewSkipProposed']).reason : null }
}

/** A fact's `platform.unknown`: each field that couldn't be read, and why (text only). */
/**
 * HI-2709: the card's "already in its target" mark while it is about what the card is now: its latest submission (that
 * very one), into its target; a later submission or another target shows none (the mark stays in its history), and
 * reconcile looks again for that one.
 */
export function inTargetNow(s: CardState): FactData['InTarget'] | null {
  const m = s.marks.inTarget
  return m && m.submission === s.latest?.id && m.revision === s.latest?.revision && m.target === (s.started?.target ?? null) ? m : null
}

function unknownOf(platform: Record<string, unknown> | undefined): Record<string, string> {
  const u = platform?.unknown
  if (!u || typeof u !== 'object') return {}
  return Object.fromEntries(Object.entries(u as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

/** A fact's `platform.unknownText` (#1477): each reason a platform's read gave as data (`{ id, values }`), from facts only. */
function unknownTextOf(platform: Record<string, unknown> | undefined): Record<string, StoredText> {
  const u = platform?.unknownText
  if (!u || typeof u !== 'object') return {}
  return Object.fromEntries(Object.entries(u as Record<string, unknown>).filter((e): e is [string, StoredText] => !!e[1] && typeof e[1] === 'object' && typeof (e[1] as StoredText).id === 'string'))
}

/** A card's work view from its facts, in seq order. Only the current cycle's (since its latest Started or Adopted). */
export function workView(c: WorkCard, facts: readonly Fact[]): WorkView {
  const s = foldCard(facts, c.stage)
  const cycle = facts.filter((f) => f.seq >= s.cycle)
  const at = new Map(facts.map((f) => [f.seq, f.at]))
  const latest = s.latest?.id ?? null
  const revisions = s.submissions.map(
    (x): WorkRevision => ({ submission: x.id, revision: x.revision, base: x.base, round: x.round, files: x.files, at: at.get(x.id) ?? '', by: x.by, generation: x.generation, sameRevision: x.sameRevision, adopted: !!x.adopted, warnings: x.warnings ?? [], summary: x.summary, unknown: unknownOf(x.platform), unknownText: unknownTextOf(x.platform), ...jjRevisionOf(x.platform) })
  )
  const verdicts = s.verdicts
    .filter((v) => v.seq >= s.cycle)
    .map(
      (v): WorkVerdict => ({ submission: v.submission, revision: v.revision, reviewer: v.reviewer, pass: v.pass, ...(v.failKind ? { failKind: v.failKind } : {}), round: v.round, generation: v.generation, at: at.get(v.seq) ?? '', current: v.submission === latest && v.generation === s.generation && !s.stale })
    )
  const checks = cycle
    .filter((f) => f.kind === 'CheckRan')
    .map((f) => {
      const d = f.data as CheckRanData
      return { name: d.name, revision: d.revision, tested: d.tested, result: d.result, counted: d.counted, ...(d.whyNot ? { whyNot: d.whyNot } : {}), run: d.run, by: d.by, durationMs: d.durationMs, at: f.at, ...(d.isolated ? { isolated: true as const } : {}) } satisfies WorkCheck
    })
  const carriedOver = cycle
    .filter((f) => f.kind === 'CarriedOver')
    .map((f) => {
      const d = f.data as FactData['CarriedOver']
      return { from: d.from, to: d.to, how: d.how, at: f.at }
    })
  const integrated = [...facts].reverse().find((f) => f.kind === 'Integrated')
  const accepted = s.accepted ? [...cycle].reverse().find((f) => f.kind === 'Accepted') : undefined
  const entry = s.entries.at(-1)
  const started = s.started
  // HI-2913: this cycle's preparation failed under its lease, and nothing prepared it since.
  const lease = started?.lease ?? null
  let notReady: FactData['SlotPrepareFailed'] | null = null
  if (lease) {
    for (const f of cycle) {
      if (f.kind === 'SlotPrepareFailed' && (f.data as FactData['SlotPrepareFailed']).lease === lease) notReady = f.data as FactData['SlotPrepareFailed']
      else if (f.kind === 'SlotPrepared' && (f.data as FactData['SlotPrepared']).lease === lease) notReady = null
    }
  }
  // Since its work was last Done (an earlier cycle that ended there): a drag's Override comes before its Started.
  const doneAt = facts.findLast((f) => f.seq < s.cycle && f.kind === 'Moved' && (f.data as FactData['Moved']).to === 'done')?.seq ?? 0
  const lastOverride = facts.findLast((f) => f.kind === 'Override' && f.seq > doneAt)
  const override = lastOverride ? ((d) => ({ by: d.by, move: d.move, rules: d.rules, reason: d.reason, at: lastOverride.at }))(lastOverride.data as FactData['Override']) : null
  // Refused since it last moved (#1279): the latest, with how many like it came in a row.
  const movedAt = facts.findLast((f) => f.kind === 'Moved')?.seq ?? 0
  const since = facts.filter((f) => f.kind === 'Refused' && f.seq > movedAt)
  const lastRefused = since.at(-1)
  const refused = lastRefused ? ((d) => ({ move: d.move, rule: d.rule, values: d.values ?? {}, at: lastRefused.at, times: since.filter((f) => (f.data as FactData['Refused']).rule === d.rule && (f.data as FactData['Refused']).move === d.move).length }))(lastRefused.data as FactData['Refused']) : null
  return {
    card: c.card,
    stage: s.stage,
    preWorkflow: c.preWorkflow,
    adopted: !!started?.adopted,
    ...(started?.adoptedFrom ? { adoptedFrom: started.adoptedFrom } : {}),
    // The card's kind now, not the one its cycle started with: a change after its start shows at once (HR3's #1277 round 1).
    kind: c.kind ?? started?.cardKind ?? null,
    kindProposed: kindProposed(facts),
    cardTarget: c.target ?? null,
    ...reviewSkipView(facts),
    folder: started?.folder ?? null,
    line: started?.line ?? null,
    ...(jjField(started?.platform, 'workspace') ? { workspace: jjField(started?.platform, 'workspace')! } : {}),
    ...(notReady ? { notReady: { slot: notReady.slot, why: notReady.why, stale: notReady.stale } } : {}),
    lines: s.lines,
    base: started?.base ?? null,
    target: started?.target ?? null,
    builder: started?.builder ?? null,
    head: s.head,
    unknown: unknownOf(started?.platform),
    unknownText: unknownTextOf(started?.platform),
    approved: s.approved,
    revisions,
    verdicts,
    checks,
    marks: { carriedOver, stale: s.stale, outsideRules: s.marks.outsideRules ?? [], mergedInPart: s.marks.mergedInPart ?? null, inTarget: inTargetNow(s), leftTarget: s.marks.leftTarget ?? null, overridden: s.approvalOverridden, override },
    integration: s.integrated && integrated ? { revision: s.integrated.revision, target: s.integrated.target, result: s.integrated.result, method: s.integrated.method, by: s.integrated.by, mergeCommit: s.integrated.method === 'merge' ? s.integrated.result : null, at: integrated.at, ...(jjField((integrated.data as { platform?: unknown }).platform, 'via') ? { via: jjField((integrated.data as { platform?: unknown }).platform, 'via')! } : {}) } : null,
    accepted: s.accepted && accepted ? { revision: s.accepted.revision ?? null, submission: s.accepted.submission ?? null, at: accepted.at, actor: accepted.actor } : null,
    refused,
    queue: entry ? queueEntryOf(entry, facts) : null,
    decisions: { generation: s.generation, received: s.received },
    rounds: s.rounds,
    forYou: s.requests.length,
    resolvedByDecision: facts
      .flatMap((f) => {
        const d = f.kind === 'Approval' ? (f.data as FactData['Approval']) : null
        const made = d?.byDecision ? s.made[d.request] : undefined
        return d?.byDecision ? [{ request: d.request, question: made?.text ?? '', ...(made?.requestText ? { shown: made.requestText } : {}), decision: d.byDecision.decision, recordedBy: d.byDecision.recordedBy, at: d.byDecision.at }] : []
      })
      .reverse()
      .slice(0, RESOLVED_SHOWN),
    loopStep: s.step?.step ?? null,
    retried: s.entries.some((x) => x.seq > (latest ?? 0) && x.requeue === 'retry'),
    lastSeq: s.lastSeq,
    ruleset: ownRuleset(facts, s),
    startedAt: s.cycle ? (at.get(s.cycle) ?? null) : null
  }
}

/** A queue entry as the Work section shows it, with its return's details and when it ended (its outcome's fact). */
function queueEntryOf(entry: QueueEntry, facts: readonly Fact[]): WorkQueueEntry {
  const f = entry.failure
  const end = facts.findLast((x) => (x.kind === 'IntegrationFailed' || x.kind === 'IntegrationCancelled' || x.kind === 'Integrated') && (x.data as { entry?: string }).entry === entry.id)
  return {
    entry: entry.id,
    revision: entry.revision,
    target: entry.target,
    state: entry.state,
    ...(f ? { failure: f.reason, transient: f.transient, ...(f.files?.length ? { files: f.files } : {}), ...(f.conflicts ? { conflicts: f.conflicts } : {}), ...(f.check ? { check: f.check } : {}), ...(f.logPath ? { logPath: f.logPath } : {}), ...(f.log ? { log: f.log } : {}) } : {}),
    ...(entry.cancelled ? { cancelled: entry.cancelled } : {}),
    ...(end ? { at: end.at } : {}),
    ...(entry.requeue ? { requeue: entry.requeue } : {})
  }
}

/** The revision a card's work stands at now: what its passes cover, else the latest submitted. */
export const currentRevision = (v: WorkView): string | null => v.approved?.revision ?? v.revisions.at(-1)?.revision ?? null

/** The checks run on a revision, newest last. */
export const checksOn = (v: WorkView, revision: string): WorkCheck[] => v.checks.filter((c) => c.revision === revision)

/** What a card's badges on the board need of its work (`workBadge`): little, for every live card at once. */
export interface WorkBadge {
  card: number
  stage: StageId
  preWorkflow: boolean
  adopted: boolean
  /** The revision under review or approved (`currentRevision`). */
  revision: string | null
  /** The newest verdict this cycle, on which revision, and whether it still counts. */
  verdict: { pass: boolean; revision: string | null; current: boolean } | null
  /** The checks on `revision`: the newest run of each check, by result, and the runs not counted. */
  checks: { passed: number; failed: number; notCounted: number }
  stale: boolean
  /** A content-stale pass (#1279): the revision it was for and the one now. */
  stalePass: { approved: string | null; current: string | null } | null
  /** A no-code card: no commits, so no revision or merge lines (#1279). */
  noCode: boolean
  /** Its latest refused request since it last moved (#1279). */
  refused: WorkRefusal | null
  overridden: boolean
  /** The latest move past its rules since it was last Done (the board's override mark). */
  override: WorkOverride | null
  outsideRules: boolean
  mergedInPart: boolean
  leftTarget: boolean
  /** Accepted where there is no merge (None, a no-code card). */
  accepted: boolean
  /** The target's revision with the card's change in it, once integrated (`Integrated`'s result): its merge commit. */
  merged: string | null
  forYou: number
  /** Its kind (no code: no commits, §16.7.3) and a kind an agent proposed, not answered yet (#1277). */
  kind: CardKind | null
  kindProposed: CardKind | null
  /** Its own Merges into (HI-2556), the card's now; absent: none (its lane's, shown on the lane, or the project's). */
  target?: string
  /** HI-2753: in flight (Doing to Merging), the branch it started on and merges into now (`Started.target`, or a move's). */
  startedOn?: string
  /** It skips review (#1625): who set it and their reason (the Review skipped mark); and an agent's proposal, its reason. */
  reviewSkip: ReviewSkip | null
  reviewSkipProposed: string | null
  /** A decision was recorded since the latest submission was made. */
  decisionSince: boolean
  /**
   * Old rules (§16.5.4, §16.6.5): in flight under a ruleset that isn't its project's current one (the options changed
   * since it started); its rules stay its own until it is Done, unless changed options are applied to it.
   */
  oldRules: boolean
  /**
   * The stages of the ruleset it keeps while in flight (#1421: HR4's round 1), in board order: what its category's stages
   * are for it, whatever its project's options produce now; null when it keeps none (in Todo, Done, none recorded).
   */
  stages: StageId[] | null
  /** The line it works on this cycle (Git: its branch, from its Started or Adopted; #1424); null for None or none. */
  line: string | null
  /** Every line it has started on, this cycle's and earlier ones' (HI-1823): while it is open, none is a leftover. */
  lines: string[]
  /**
   * In Review: the revision submitted for it, which its review waits on or runs on (its latest submission's; #1424). Whole,
   * the window shows it through its platform's short form. Null outside Review, or for a no-code card.
   */
  underReview: string | null
  /** When its current cycle (on `line`) started: what orders a branch's cards, one after another (#1424). */
  startedAt: string | null
  /** When this cycle's change was integrated (its merge), else accepted (no merge); null while neither (HI-1926). */
  endedAt: string | null
  lastSeq: number
}

/** Whether a card is in flight under rules that aren't `current` (its project's ruleset now; null: not known, no mark). */
export const onOldRules = (v: Pick<WorkView, 'stage' | 'ruleset'>, current: string | null | undefined): boolean => !!current && !!v.ruleset && v.stage !== 'todo' && v.stage !== 'done' && rulesBaseId(v.ruleset) !== current

/**
 * The stages a card in flight keeps (#1421), its review skip applied (#1625): its rules with no review while it skips
 * review (stored once the skip is set on a started card), else its base rules.
 */
function keptStages(v: WorkView, stagesOf: (ruleset: string) => StageId[] | null): StageId[] | null {
  if (!v.ruleset || v.stage === 'done') return null
  const base = baseRulesetId(v.ruleset)
  return (v.reviewSkip ? stagesOf(base + REVIEW_SKIPPED) : null) ?? stagesOf(base)
}

/**
 * `current`: the card's project's ruleset now, for its old rules mark (main's; none: no mark); `stagesOf`: a stored
 * ruleset's stages by its id (main's; none: not read).
 */
export function workBadge(v: WorkView, current?: string | null, stagesOf?: (ruleset: string) => StageId[] | null): WorkBadge {
  const revision = currentRevision(v)
  const newest = new Map<string, WorkCheck>()
  let notCounted = 0
  for (const c of revision ? checksOn(v, revision) : []) {
    if (!c.counted) notCounted++
    else newest.set(c.name, c)
  }
  const runs = [...newest.values()]
  const verdict = v.verdicts.at(-1)
  const latest = v.revisions.at(-1)
  return {
    card: v.card,
    stage: v.stage,
    preWorkflow: v.preWorkflow,
    adopted: v.adopted,
    revision,
    verdict: verdict ? { pass: verdict.pass, revision: verdict.revision, current: verdict.current } : null,
    checks: { passed: runs.filter((c) => c.result === 'passed').length, failed: runs.filter((c) => c.result !== 'passed').length, notCounted },
    stale: !!v.marks.stale,
    stalePass: v.marks.stale ? { approved: v.marks.stale.approved, current: v.marks.stale.current } : null,
    noCode: v.kind === 'no-code',
    refused: v.refused,
    overridden: v.marks.overridden,
    override: v.marks.override,
    outsideRules: v.marks.outsideRules.length > 0,
    mergedInPart: !!v.marks.mergedInPart,
    leftTarget: !!v.marks.leftTarget,
    accepted: !!v.accepted,
    merged: v.integration?.result ?? null,
    forYou: v.forYou,
    kind: v.kind,
    kindProposed: v.kindProposed,
    ...(v.cardTarget ? { target: v.cardTarget } : {}),
    ...(v.target && (v.stage === 'active' || v.stage === 'review' || v.stage === 'approved' || v.stage === 'merging') ? { startedOn: v.target } : {}),
    reviewSkip: v.reviewSkip,
    reviewSkipProposed: v.reviewSkipProposed,
    decisionSince: !!latest && v.decisions.generation > latest.generation,
    oldRules: onOldRules(v, current),
    stages: stagesOf ? keptStages(v, stagesOf) : null,
    line: v.line,
    lines: v.lines,
    underReview: v.stage === 'review' && v.kind !== 'no-code' ? (latest?.revision ?? null) : null,
    startedAt: v.startedAt,
    endedAt: v.integration?.at ?? v.accepted?.at ?? null,
    lastSeq: v.lastSeq
  }
}

/** A string field of a fact's `platform.jj` (HI-2869: the window's jj ids), or null.  */
function jjField(platform: unknown, field: string): string | null {
  const j = platform && typeof platform === 'object' ? (platform as { jj?: Record<string, unknown> }).jj : null
  return j && typeof j[field] === 'string' ? (j[field] as string) : null
}

/** A submission's jj ids for the window (HI-2869): its change id and its chain's length, where recorded. */
function jjRevisionOf(platform: unknown): { change?: string; chain?: number } {
  const change = jjField(platform, 'changeId')
  const j = platform && typeof platform === 'object' ? (platform as { jj?: { chain?: unknown } }).jj : null
  const chain = j && Array.isArray(j.chain) ? j.chain.length : 0
  return { ...(change ? { change } : {}), ...(chain > 1 ? { chain } : {}) }
}
