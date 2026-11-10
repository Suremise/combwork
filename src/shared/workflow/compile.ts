// Options → ruleset (SPEC §16.5.4): the stages and, for every move, the ordered guards the ruleset holds. A ruleset is
// plain data with a content hash as its id; a card keeps the one it started with until it's Done. Pieces are looked up
// by id, so a ruleset can't run arbitrary code: an unknown id refuses to load.
//
// In the app (#1263): the runtime compiles a project's resolved options (main/workflow/rulesets.ts) and stores each
// ruleset a card starts under.

import { accepts, deliversCommits, hasCapability, merges } from '../platform/descriptors'
import type { Category, StageId } from './facts'
import { STAGE_CATEGORY } from './facts'
import { contradictions, reviewerAgent, userReportsMerge, type Contradiction, type WorkflowOptions } from './options'
import { GUARDS, isGuard, MOVES, type GuardId, type MoveId } from './pieces'

export const RULESET_VERSION = 1

export interface StageDef {
  id: StageId
  category: Category
}

export interface Ruleset {
  id: string
  version: number
  /** The options it was compiled from (the pieces' parameters: check names, target, style…), without names (N5: `ruleOptions`). */
  options: WorkflowOptions
  stages: StageDef[]
  guards: Record<MoveId, GuardId[]>
}

/** A short, stable hash of a string (FNV-1a, 64 bits, as hex): the ruleset's id. Pure, so the window can compute it too. */
export function stableHash(text: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

/** JSON with keys sorted, so equal options hash alike whatever order they were written in. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/**
 * The options a ruleset is made of: all but the names (N5), which apply at once and never make "old rules" (#1417). G17
 * as one reviewer per lane is left out too (#1443): it is what a ruleset without it means, so every ruleset compiled
 * before P7 keeps its id. G18, pushing the target after a merge (#1179), isn't a rule: the queue reads it as the options
 * are when it pushes, so it is left out whatever its value (a ruleset's options have it off). G19, the merge's commit
 * message (HI-1697), likewise: read as the options are when the queue merges. The preferences (HI-1766: card loops,
 * file locks; HI-2001: Maximum agents) aren't rules either: read as the options are when they're used.
 */
export function ruleOptions(o: WorkflowOptions): WorkflowOptions {
  const { stageNames: _names, otherTargets: _others, reviewerMode, pushTarget: _push, followRemote: _follow, commitMessage: _message, loopWakes: _wakes, loopRounds: _rounds, loopWaitHours: _wait, loopStepWaitMinutes: _step, fileLocks: _locks, maxAgents: _max, ...rules } = o
  return (reviewerMode === 'pool' ? { ...rules, reviewerMode } : rules) as WorkflowOptions
}

/** Does any rule need the card's change (so its folder must be clean and its revision ready)? */
export const needsChange = (o: WorkflowOptions): boolean => deliversCommits(o.platform) && (o.review !== 'none' || o.finish === 'committed' || o.finish === 'combworkMerges' || o.finish === 'agentMerges' || o.finish === 'userIntegrates')

/**
 * The stages the options produce (§16.5.2), in board order: Review with any review; Approved when something follows a
 * review (Combwork merges after it or after your OK, the agent merges, or Not checked after a review); Merging when Combwork
 * merges. stages.ts names them.
 */
export function producedStages(o: WorkflowOptions): StageId[] {
  const review = o.review !== 'none'
  const merging = merges(o.platform)
  // Approved when a review or your OK before merging (G10) approves the work and something follows it (§16.5.2, decided
  // on #1417): where work merges (Git) a merge (Combwork's, the agent's, or one Combwork doesn't check); where it is
  // accepted (None) your OK after the reviewer agent's pass (N1).
  const approves = review || o.okBefore.mode !== 'never'
  // Where its user integrates (jj, HI-2799), your integration follows the approval, as a merge Combwork doesn't check follows Git's.
  const approved = merging ? approves && (o.finish === 'combworkMerges' || o.finish === 'agentMerges' || o.finish === 'notChecked') : accepts(o.platform) ? o.review === 'agentThenYou' : approves && o.finish === 'userIntegrates'
  const out: StageId[] = ['hold', 'todo', 'active']
  if (review) out.push('review')
  if (approved) out.push('approved')
  if (merging && o.finish === 'combworkMerges') out.push('merging')
  out.push('done')
  return out
}

function guardsOf(o: WorkflowOptions): Record<MoveId, GuardId[]> {
  const g = Object.fromEntries(MOVES.map((m) => [m, [] as GuardId[]])) as Record<MoveId, GuardId[]>
  const review = o.review !== 'none'
  const agent = reviewerAgent(o.review)
  if (o.dependenciesDone) g.start.push('start.notBlocked', 'start.dependenciesIntegrated')
  // HI-2799: a jj card can't start yet (its slot's line under jj is a later card's): refused first, whatever else holds.
  if (o.platform === 'jj') g.start.push('start.platformReady')
  if (o.folder === 'slots') g.start.push('start.slotAvailable')
  g.submit.push('submit.notDuplicate')
  if (needsChange(o)) g.submit.push('submit.ready', 'submit.clean')
  if (needsChange(o) && o.folder === 'project') g.submit.push('submit.trailer')
  if (o.identity) g.submit.push('submit.identity')
  if (o.preChecks.length) g.submit.push('submit.checksPassed')
  // G20 (HI-1367): each card's focused tests are chosen, or named by its builder, before it goes to review.
  if (o.focusedTests && o.finish === 'combworkMerges') g.submit.push('submit.focusedChosen')
  if (o.stopOwnRuns) g.submit.push('submit.ownRunsStopped')
  // A decision the builder hasn't read holds its submit with any review or a merge step (SPEC §16.5.3, HI-2275): All off
  // and Solo (committed) stay free.
  if (review || o.finish === 'combworkMerges' || o.finish === 'agentMerges') g.submit.push('submit.decisionsReceived')
  // The builder's submit after a queue failure holds the same unread decision (HI-2275).
  if (o.finish === 'combworkMerges') g.requeue.push('submit.notDuplicate', 'requeue.allowed', ...(review ? (['integrate.approved'] as const) : []), 'submit.decisionsReceived')
  if (agent) {
    if (o.noSelfReview) g.startReview.push('review.notAuthor')
    g.startReview.push('review.decisionsReceived')
    g.verdict.push('verdict.reviewing', 'verdict.currentSubmission')
    if (o.noSelfReview) g.verdict.push('review.notAuthor')
    g.verdict.push('review.decisionsReceived')
  }
  if (review || o.okBefore.mode !== 'never') g.approve.push('approval.given')
  // G10 holds the report of a merge Combwork doesn't check too (#1592): only its containment isn't checked.
  if ((o.finish === 'agentMerges' || userReportsMerge(o.finish)) && o.okBefore.mode !== 'never') g.reportMerge.push('approval.given')
  if (o.finish === 'agentMerges') g.reportMerge.push('done.contained')
  if (o.finish === 'combworkMerges') {
    if (review) g.integrate.push('integrate.approved')
    if (o.strict) g.integrate.push('integrate.upToDate')
    if (o.mergeChecks.length || o.focusedTests) g.integrate.push('integrate.checksPassed')
    g.integrate.push('done.contained')
  }
  if (o.finish === 'committed') g.finish.push('done.contained')
  return g
}

export type CompileResult = { ok: true; ruleset: Ruleset } | { ok: false; contradictions: Contradiction[] }

/** Compiles options into a ruleset, or names the contradictions that stop it (refused when saved). */
export function compile(withNames: WorkflowOptions): CompileResult {
  // Names aren't rules (#1417): a rename never changes a ruleset or its id.
  const o = ruleOptions(withNames)
  const bad = contradictions(o)
  if (bad.length) return { ok: false, contradictions: bad }
  const guards = guardsOf(o)
  // A guard whose capability the platform lacks can't be in its rulesets (§16.5.3).
  for (const m of MOVES) guards[m] = guards[m].filter((id) => !GUARDS[id].needs || hasCapability(o.platform, GUARDS[id].needs))
  const stages = producedStages(o).map((id) => ({ id, category: STAGE_CATEGORY[id] }))
  const body = { version: RULESET_VERSION, options: o, stages, guards }
  return { ok: true, ruleset: { id: stableHash(canonical(body)), ...body } }
}

/** compile(), for options already validated: throws on a contradiction. */
export function mustCompile(o: WorkflowOptions): Ruleset {
  const r = compile(o)
  if (!r.ok) throw new Error(`contradictory options: ${r.contradictions.join(', ')}`) // i18n-ignore: a programming error, never shown
  return r.ruleset
}

export type LoadResult = { ok: true; ruleset: Ruleset; readOnly: boolean } | { ok: false; error: 'unknownPiece' | 'malformed'; piece?: string }

/**
 * A stored ruleset, checked before use: every guard must be a piece this Combwork has (an unknown id refuses), and one from
 * a newer Combwork opens read-only (§16.5.4).
 */
export function loadRuleset(data: unknown): LoadResult {
  const r = data as Partial<Ruleset> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || typeof r.version !== 'number' || !r.guards || !r.options || !Array.isArray(r.stages)) return { ok: false, error: 'malformed' }
  for (const [move, ids] of Object.entries(r.guards)) {
    if (!(MOVES as readonly string[]).includes(move)) return { ok: false, error: 'unknownPiece', piece: move }
    for (const id of ids as string[]) if (!isGuard(id)) return { ok: false, error: 'unknownPiece', piece: id }
  }
  return { ok: true, ruleset: r as Ruleset, readOnly: r.version > RULESET_VERSION }
}

export const hasStage = (r: Ruleset, id: StageId): boolean => r.stages.some((s) => s.id === id)

/** What marks a ruleset as its base's with no review (#1625): its id is the base's with this after it. */
export const REVIEW_SKIPPED = '~skipReview'

/** The ruleset a ruleset's id was made from: itself, unless it is one with review skipped (#1625). */
export const baseRulesetId = (id: string): string => (id.endsWith(REVIEW_SKIPPED) ? id.slice(0, -REVIEW_SKIPPED.length) : id)

/**
 * What marks a ruleset as its base's merging into another target (HI-2556: a lane's Merges into): its id is the base's
 * with this and the target (URI-encoded) after it. Comes before REVIEW_SKIPPED when both apply.
 */
export const TARGETED = '~target:'

/** An id with a forward merge's mark (HI-2679) taken off: its base's. */
const unforwarded = (id: string): string => (id.endsWith('~forward') ? id.slice(0, -'~forward'.length) : id)

/**
 * A ruleset's rules for old rules (§16.5.4, HI-2556): its id with neither a review skip nor another target marked, so a
 * lane merging into another branch under the options in force is on today's rules.
 */
export const rulesBaseId = (id: string): string => {
  const base = unforwarded(baseRulesetId(id))
  const at = base.indexOf(TARGETED)
  return at < 0 ? base : base.slice(0, at)
}

/** The other target a ruleset's id marks (HI-2556), or null: the one its options name (G7) is its own. */
export function targetOfRulesetId(id: string): string | null {
  const base = unforwarded(baseRulesetId(id))
  const at = base.indexOf(TARGETED)
  if (at < 0) return null
  try {
    return decodeURIComponent(base.slice(at + TARGETED.length)) || null
  } catch {
    return null
  }
}

/**
 * The rules of a lane merging into `target` (HI-2556): its base's with G7 set to it, the base found again by its id
 * (`rulesBaseId`). The base itself when `target` is empty or already its G7.
 */
export function targetedOf(r: Ruleset, target: string | null | undefined): Ruleset {
  if (!target || target === r.options.target) return r
  const base = r.id.indexOf(TARGETED) < 0 ? r.id : r.id.slice(0, r.id.indexOf(TARGETED))
  const c = mustCompile({ ...r.options, target })
  return { ...c, id: base + TARGETED + encodeURIComponent(target) }
}

/** What marks a forward merge's rules (HI-2679): its id is its base's (`targetedOf` the destination's) with this after it. */
export const FORWARD = '~forward'

/**
 * The rules a forward merge (HI-2679) runs under: its base's merging into `to` (G7), with no review (its authority is
 * its `ForwardRequested`), a merge commit always (G6: never squashing or rebasing a release's history), the source never
 * brought up to date with the destination (G8 off: that would change the source), and the shared merge checks alone (no
 * focused tests, G20: they read a card's own change). Found again by its id (`rulesBaseId`).
 */
export function forwardOf(r: Ruleset, to: string): Ruleset {
  const base = targetedOf(r, to)
  const c = mustCompile({ ...base.options, target: to, review: 'none', reviewers: 1, reviewerMode: 'lane', style: 'merge', strict: false, focusedTests: false })
  return { ...c, id: base.id + FORWARD }
}

/**
 * The rules a card that skips review runs under (#1625, SPEC §16.7.3): its base's with no review, so its submission
 * finishes it (a no-code card is Done; a code card goes on as its finish says, the merge checks and the OK before merging
 * kept). Its id is the base's marked, so the base is found again (`baseRulesetId`). Rules that don't review are their own.
 */
export function skipReviewOf(r: Ruleset): Ruleset {
  if (r.options.review === 'none' || r.id.endsWith(REVIEW_SKIPPED)) return r
  const c = mustCompile({ ...r.options, review: 'none', reviewers: 1, reviewerMode: 'lane' })
  return { ...c, id: r.id + REVIEW_SKIPPED }
}

/**
 * A card the agent merges under rules with no Approved stage (no review and no OK before merging, §16.5.2 as decided on
 * #1417): once submitted it waits in Active for the agent's merge, as an approved card waits in Approved.
 */
export const awaitsAgentMerge = (r: Ruleset, s: { stage: StageId; latest: unknown }): boolean => r.options.finish === 'agentMerges' && !hasStage(r, 'approved') && s.stage === 'active' && !!s.latest
export const holds = (r: Ruleset, move: MoveId, id: GuardId): boolean => r.guards[move].includes(id)
