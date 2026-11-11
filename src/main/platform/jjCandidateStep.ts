// jj's pre-integration candidate (HI-2871, design HI-2871/s13 and s21, HR3's OK): for a jj card in Approved that J5's
// proof finds not yet in its target, J4's candidate is built on the target's head, as strict's update and the test merge
// are for Git, so the user integrates a result Combwork made and checked for conflicts (merge checks on it are HI-2938's).
// Decision A holds: nothing here moves a bookmark or pushes; J4's writes are private new commits and its own pins.
//
// One step per reconciliation, in order:
// 1. Every attempt the card's cycle journalled that isn't settled (a phase short of done, a step under way, uncertain
//    commits) is recovered with J4's `recoverJjAttempt` and dropped with `dropJjAttempt`, before anything new is built.
// 2. The target's head read (J5's `jjTargetHead`).
// 3. A done candidate for exactly this fingerprint (the approval, the rules' id, style, strict) and this head, still
//    visible (`jjCandidateNow`), is offered again: nothing is built. A failure for exactly them is answered again.
// 4. Every other done candidate or update (another fingerprint, another head) is superseded: dropped with J4's
//    `dropJjAttempt`, which keeps whatever the target reaches.
// 5. Strict's update (merge and squash, when strict is on) then the candidate, each a J4 attempt journalled under the
//    fingerprint, its owner the fingerprint still being the card's (`still`, read from the board before every write).
// The caller publishes what this answers only while the fingerprint and the head are still these (reconcile.ts).

import { dropJjAttempt, isCandidate, isInterrupted, jjCandidateNow, prepareJjCandidate, prepareJjUpdate, recoverJjAttempt, type JjAttemptRecord, type JjCandidateDeps, type JjCandidateStyle } from './jjCandidates'
import { isJjUnknown, type JjReadUnknown } from './jjReads'
import type { ConflictsRecord } from '../../shared/workflow/conflicts'
import type { SqlDb } from './jjObligations'

/**
 * What a candidate is valid for (HI-2871/s21 §2): the card's exact approval (its cycle, approved submission, revision,
 * base, key, recorded jj commit and target), the effective rules (the ruleset's id, its options' hash) and the style and
 * strict it was built with. A candidate is current only for its fingerprint and the target head it was built on.
 */
export interface JjCandidateFingerprint {
  cycle: number
  submission: number
  revision: string
  base: string
  key: string | null
  commit: string | null
  target: string
  ruleset: string
  style: JjCandidateStyle
  strict: boolean
}

const FP_KEYS = ['cycle', 'submission', 'revision', 'base', 'key', 'commit', 'target', 'ruleset', 'style', 'strict'] as const

export const sameFingerprint = (a: JjCandidateFingerprint | null | undefined, b: JjCandidateFingerprint | null | undefined): boolean => !!a && !!b && FP_KEYS.every((k) => a[k] === b[k])

/** Why a candidate returned its card: J4's failure for it (or for strict's update), its files, hunks and log. */
export interface JjCandidateFailure {
  reason: 'conflict' | 'notUpToDate' | 'notSame'
  files?: string[]
  log: string
  conflicts?: ConflictsRecord
}

/**
 * One journalled attempt of a card's cycle (board_meta, the caller's): its fingerprint, J4's record as journalled, what
 * became of it here (`dropped`, or `kept` when a drop left something the target reaches or recovery couldn't own), and a
 * failure's details (answered again for the same fingerprint and head, never rebuilt).
 */
export interface JjAttemptEntry {
  fp: JjCandidateFingerprint
  record: JjAttemptRecord
  state?: 'dropped' | 'kept'
  failure?: JjCandidateFailure
  /** A candidate's change id (J4's record keeps its commit), for `jjCandidateNow`. */
  change?: string
}

/** What the step needs beside J4's own dependencies (the owner and journal are the step's). */
export interface JjCandidateStepDeps {
  j4: Omit<JjCandidateDeps, 'owner' | 'journal'>
  /** The target's head now (J5's), or why it can't be read. */
  targetHead(target: string): Promise<{ head: string } | { unknown: string }>
  /** The card's cycle's journalled attempts, as stored now. */
  entries(): JjAttemptEntry[]
  /** Durable before it returns: the entry stored (merged by its attempt). */
  save(e: JjAttemptEntry): Promise<void>
  /** Whether the fingerprint is still the card's, read synchronously from the board (J4's owner). */
  still(): boolean
  /** A fresh attempt token ([a-z0-9], 6–40). */
  token(): string
}

export interface JjCandidateOffer {
  attempt: string
  result: string
  change: string
  target: string
  expected: string
  style: JjCandidateStyle
  /** Strict's update it was built on: its result. */
  updated?: string
}

export type JjCandidateStep =
  | { offer: JjCandidateOffer }
  | { returned: JjCandidateFailure & { attempt: string; expected: string } }
  | { none: 'signing' }
  | { unknown: string }

/** An unknown's code and its detail, bounded, for the log and the record. */
const why = (u: JjReadUnknown): string => (u.detail ? `${u.jjUnknown}: ${u.detail.slice(0, 200)}` : u.jjUnknown)

const settled = (r: JjAttemptRecord): boolean => (r.phase === 'done' || r.phase === 'dropped') && !r.step && !r.uncertain?.length

/** The step (above), for the card `card` (its key: J4's pins and records name it). `message`: a merge's or squash's description; `updateMessage`: strict's merge's. */
export async function jjCandidateStep(deps: JjCandidateStepDeps, card: string, fp: JjCandidateFingerprint, text: { message: string; updateMessage: string }): Promise<JjCandidateStep> {
  const j4 = (entryFp: JjCandidateFingerprint): JjCandidateDeps => ({
    ...deps.j4,
    owner: { still: () => deps.still() },
    journal: (record) => deps.save({ fp: entryFp, record })
  })
  // Clean-up runs under any fingerprint: its owner is only that the card's approval still stands as the step began.
  const cleanUp = j4(fp)

  // 1. Recovery and drop of what isn't settled.
  for (const e of deps.entries()) {
    if (e.state || settled(e.record)) continue
    const rec = await recoverJjAttempt(cleanUp, e.record)
    if (isInterrupted(rec)) return { unknown: `recover:${rec.interrupted.why}` }
    const d = await dropJjAttempt(cleanUp, rec.record, e.fp.target)
    if (isInterrupted(d)) {
      // Uncertain commits are never owned or dropped: kept, so they never block a new candidate.
      if (d.interrupted.why === 'uncertain') {
        await deps.save({ ...e, record: d.record, state: 'kept' })
        continue
      }
      return { unknown: `drop:${d.interrupted.why}` }
    }
    await deps.save({ ...e, record: d.record, state: d.dropped.keptRefs.some((k) => k.why === 'reached') ? 'kept' : 'dropped' })
  }

  // 2. The target's head.
  const th = await deps.targetHead(fp.target)
  if ('unknown' in th) return th
  const head = th.head

  // 3. The current answer for exactly this fingerprint and head, if there is one.
  const live = deps.entries().filter((e) => !e.state && e.record.phase === 'done')
  const mine = live.filter((e) => sameFingerprint(e.fp, fp) && e.record.expected === head)
  const failed = mine.find((e) => e.failure)
  if (failed) return { returned: { ...failed.failure!, attempt: failed.record.attempt, expected: head } }
  let current: JjAttemptEntry | null = null
  for (const e of mine) {
    if ((e.record.kind ?? 'candidate') !== 'candidate' || e.record.outcome !== 'candidate' || !e.record.result) continue
    const change = changeOf(e)
    if (!change) continue
    const now = await jjCandidateNow(deps.j4, { result: e.record.result, change })
    if (isJjUnknown(now)) return { unknown: `candidate:${why(now)}` }
    if (now === 'current') current = e
    break
  }

  // 4. Everything else superseded: dropped, keeping what the target reaches. The current candidate's update stays.
  const keep = new Set(current ? [current.record.attempt, ...(current.record.updated ? [current.record.updated.attempt] : [])] : [])
  for (const e of live) {
    if (keep.has(e.record.attempt) || e.failure || (e.record.outcome !== 'candidate' && e.record.outcome !== 'updated')) continue
    const d = await dropJjAttempt(cleanUp, e.record, e.fp.target)
    if (isInterrupted(d)) return { unknown: `drop:${d.interrupted.why}` }
    await deps.save({ ...e, record: d.record, state: d.dropped.keptRefs.some((k) => k.why === 'reached') ? 'kept' : 'dropped' })
  }
  if (current) return { offer: offerOf(current, head) }

  // 5. Strict's update (merge and squash), then the candidate.
  let updated: JjAttemptRecord | undefined
  if (fp.strict && fp.style !== 'rebase') {
    const attempt = deps.token()
    const u = await prepareJjUpdate(j4(fp), { card, attempt, revision: fp.revision, base: fp.base, expected: head, how: fp.style === 'squash' ? 'rebase' : 'merge', message: text.updateMessage })
    if (isJjUnknown(u)) return { unknown: `update:${why(u)}` }
    if (isInterrupted(u)) return { unknown: `update:${u.interrupted.why}` }
    if ('pause' in u) return { none: 'signing' }
    if ('fail' in u) return failure(deps, fp, u.record, { reason: u.fail === 'conflict' ? 'conflict' : u.fail === 'notSame' ? 'notSame' : 'notUpToDate', ...(u.files ? { files: u.files } : {}), log: u.log, ...(u.conflicts ? { conflicts: u.conflicts } : {}) }, head) // i18n-ignore: a failure's code, not text
    if (u.updated) updated = u.record
  }
  const attempt = deps.token()
  const c = await prepareJjCandidate(j4(fp), { card, attempt, revision: fp.revision, base: fp.base, expected: head, style: fp.style, message: text.message, ...(updated ? { updated } : {}) })
  if (isJjUnknown(c)) return { unknown: `candidate:${why(c)}` }
  if (isInterrupted(c)) return { unknown: `candidate:${c.interrupted.why}` }
  if ('pause' in c) return { none: 'signing' }
  if (!isCandidate(c)) return failure(deps, fp, c.record, { reason: c.fail === 'conflict' ? 'conflict' : 'notUpToDate', ...(c.files ? { files: c.files } : {}), log: c.log, ...(c.conflicts ? { conflicts: c.conflicts } : {}) }, head) // i18n-ignore: a failure's code, not text
  await deps.save({ fp, record: c.record, change: c.candidate.change })
  return { offer: { attempt, result: c.candidate.result, change: c.candidate.change, target: fp.target, expected: head, style: fp.style, ...(updated?.result ? { updated: updated.result } : {}) } }
}

async function failure(deps: JjCandidateStepDeps, fp: JjCandidateFingerprint, record: JjAttemptRecord, f: JjCandidateFailure, head: string): Promise<JjCandidateStep> {
  await deps.save({ fp, record, failure: f })
  return { returned: { ...f, attempt: record.attempt, expected: head } }
}

const changeOf = (e: JjAttemptEntry): string | null => e.change ?? null

function offerOf(e: JjAttemptEntry, head: string): JjCandidateOffer {
  return { attempt: e.record.attempt, result: e.record.result!, change: changeOf(e)!, target: e.fp.target, expected: head, style: e.fp.style, ...(e.record.updated ? { updated: e.record.updated.result } : {}) }
}

/**
 * A card's cycle integrated (HI-2871): every live candidate and update it journalled dropped with J4's `dropJjAttempt`,
 * which keeps whatever the target reaches (the candidate the user integrated stays). Nothing else is built or answered;
 * an interrupted drop is left for the record (its pins keep its evidence) and the rest go on. How many it dropped.
 */
export async function dropCandidates(deps: Pick<JjCandidateStepDeps, 'j4' | 'entries' | 'save'>): Promise<number> {
  const j4: JjCandidateDeps = { ...deps.j4, owner: { still: () => true }, journal: () => undefined }
  let n = 0
  for (const e of deps.entries()) {
    if (e.state || e.failure || e.record.phase !== 'done' || (e.record.outcome !== 'candidate' && e.record.outcome !== 'updated')) continue
    const d = await dropJjAttempt({ ...j4, journal: (record) => deps.save({ ...e, record }) }, e.record, e.fp.target)
    if (isInterrupted(d)) continue
    await deps.save({ ...e, record: d.record, state: d.dropped.keptRefs.some((k) => k.why === 'reached') ? 'kept' : 'dropped' })
    n++
  }
  return n
}

/** The board_meta key of a card and cycle's candidate attempts, by the project's canonical id. */
export const attemptsKey = (project: string, card: string, cycle: number): string => `jj_attempts:${project.toLowerCase()}:${card.toLowerCase()}:${cycle}`

/** A card and cycle's attempts as stored (an unreadable row reads as none: nothing recovered or credited from it). */
export function readAttempts(db: SqlDb, key: string): JjAttemptEntry[] {
  const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL
  try {
    const v = r ? (JSON.parse(r.value) as unknown) : []
    return Array.isArray(v) ? (v as JjAttemptEntry[]).filter((e) => !!e && typeof e === 'object' && !!e.record && typeof e.record.attempt === 'string') : []
  } catch {
    return []
  }
}

/** An attempt's entry stored in its write: merged by its attempt, so a later phase of one never erases another's. */
export function saveAttemptIn(db: SqlDb, key: string, e: JjAttemptEntry): void {
  const kept = readAttempts(db, key).filter((x) => x.record.attempt !== e.record.attempt)
  db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify([...kept, e])) // i18n-ignore: SQL
}
