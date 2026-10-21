// A card's work, read (#1223): the fold of its facts (facts.ts) as the window and the Agent API show it. The line, base
// and folder; each revision submitted with its round, files, time and builder; the verdicts tied to their submission
// and round; the checks per revision, counted or not; the marks (carried over, stale, outside the rules, merged in part,
// left the target); the integration; the decisions' generations; and whether the card is from before 1.0 or adopted.
// Pure: main reads the facts (workflow/cardWork.ts), the window formats revisions through its project's platform
// descriptor (`revisionShort`), never by switching on a platform's id.

import { foldCard, type Actor, type CardKind, type CheckRanData, type Fact, type FactData, type FileChange, type ForYouKind, type RoundChoice, type StageId } from './facts'
import type { StoredText } from '../types'

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
  /** Hive's own request's message, for the window in its language (#1264); none for an agent's words. */
  shown?: StoredText
  /** When it was asked. */
  since: string
  /** The agent who asked; null: Hive. */
  asker: string | null
  /** Whom it waits on: the user (a person later, #439). */
  for: 'user'
  /** A Test request's checklist: what to try (#1267). */
  checklist?: string[]
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
}

/** A card's requests for the user, oldest first: from its facts folded (its open requests). */
export function forYouItems(card: { card: number; project: string; stage: StageId }, facts: readonly Fact[]): ForYouItem[] {
  return foldCard(facts, card.stage).requests.map((r) => ({
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
    ...(r.checklist?.length ? { checklist: r.checklist } : {})
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
  /** Where the card works: `project`, or the slot's folder. */
  folder: string | null
  /** The line it works on (Git: its branch); null for None. */
  line: string | null
  /** The revision its change starts from. */
  base: string | null
  target: string | null
  builder: string | null
  /** The last head seen in its folder. */
  head: string | null
  /** What couldn't be read when its work started, and why (`line`, `base`, `target`…, its Started's `platform.unknown`). */
  unknown: Record<string, string>
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
  /** The newest fact's seq: a view is newer than another when this is higher. */
  lastSeq: number
}

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
}

/** The kind a project agent proposed (`KindProposed`) and nobody has answered yet (`KindDecided`), or null (#1277). */
export function kindProposed(facts: readonly Fact[]): CardKind | null {
  const p = facts.findLast((f) => f.kind === 'KindProposed')
  if (!p) return null
  return facts.some((f) => f.kind === 'KindDecided' && f.seq > p.seq) ? null : (p.data as FactData['KindProposed']).kind
}

/** A fact's `platform.unknown`: each field that couldn't be read, and why (text only). */
function unknownOf(platform: Record<string, unknown> | undefined): Record<string, string> {
  const u = platform?.unknown
  if (!u || typeof u !== 'object') return {}
  return Object.fromEntries(Object.entries(u as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

/** A card's work view from its facts, in seq order. Only the current cycle's (since its latest Started or Adopted). */
export function workView(c: WorkCard, facts: readonly Fact[]): WorkView {
  const s = foldCard(facts, c.stage)
  const cycle = facts.filter((f) => f.seq >= s.cycle)
  const at = new Map(facts.map((f) => [f.seq, f.at]))
  const latest = s.latest?.id ?? null
  const revisions = s.submissions.map(
    (x): WorkRevision => ({ submission: x.id, revision: x.revision, base: x.base, round: x.round, files: x.files, at: at.get(x.id) ?? '', by: x.by, generation: x.generation, sameRevision: x.sameRevision, adopted: !!x.adopted, warnings: x.warnings ?? [], summary: x.summary, unknown: unknownOf(x.platform) })
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
      return { name: d.name, revision: d.revision, tested: d.tested, result: d.result, counted: d.counted, ...(d.whyNot ? { whyNot: d.whyNot } : {}), run: d.run, by: d.by, durationMs: d.durationMs, at: f.at } satisfies WorkCheck
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
    folder: started?.folder ?? null,
    line: started?.line ?? null,
    base: started?.base ?? null,
    target: started?.target ?? null,
    builder: started?.builder ?? null,
    head: s.head,
    unknown: unknownOf(started?.platform),
    approved: s.approved,
    revisions,
    verdicts,
    checks,
    marks: { carriedOver, stale: s.stale, outsideRules: s.marks.outsideRules ?? [], mergedInPart: s.marks.mergedInPart ?? null, leftTarget: s.marks.leftTarget ?? null, overridden: s.approvalOverridden, override },
    integration: s.integrated && integrated ? { revision: s.integrated.revision, target: s.integrated.target, result: s.integrated.result, method: s.integrated.method, by: s.integrated.by, mergeCommit: s.integrated.method === 'merge' ? s.integrated.result : null, at: integrated.at } : null,
    accepted: s.accepted && accepted ? { revision: s.accepted.revision ?? null, submission: s.accepted.submission ?? null, at: accepted.at, actor: accepted.actor } : null,
    refused,
    queue: entry ? { entry: entry.id, revision: entry.revision, target: entry.target, state: entry.state, ...(entry.failure ? { failure: entry.failure.reason } : {}), ...(entry.cancelled ? { cancelled: entry.cancelled } : {}) } : null,
    decisions: { generation: s.generation, received: s.received },
    rounds: s.rounds,
    forYou: s.requests.length,
    lastSeq: s.lastSeq
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
  /** A decision was recorded since the latest submission was made. */
  decisionSince: boolean
  lastSeq: number
}

export function workBadge(v: WorkView): WorkBadge {
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
    decisionSince: !!latest && v.decisions.generation > latest.generation,
    lastSeq: v.lastSeq
  }
}

