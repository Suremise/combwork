// Each card's focused tests (G20, HI-1367; SPEC §16.9.1, §16.13): the tests a card's change needs, chosen when it is
// submitted and run by the merge queue at the merged result. Combwork knows none of a project's tests: its picker
// (`focused.pick`) names them and its runner (`focused.run`) runs them. What is shared by the submission, the queue and
// the window is here, pure: the ids, the picker's output, a change's identity path by path, and the runner's results.
//
// - A selection never passes by default: a pick that failed, timed out or said "every test" is `unknown` or `tooBroad`,
//   and only a list the builder gives (`manual`, reviewed with the change) stands in for it.
// - The approved selection holds at the merged result only for a path whose change is exactly the same (`sameChange`:
//   status, both endpoints, both modes and both blob ids); any other path is picked again there.
// - A real-CLI or packaged test is never run by the queue (the user's decision, 28 Oct): it is proved by its reviewer's
//   counted run at the submitted revision, accepted as review evidence, and one only the queue's own pick adds returns
//   the card. HI-2660 (the user's decision, 7 Nov): or by another agent's run there (the builder's) that the reviewer's
//   pass accepts by its run id, the run keeping its own agent.

import type { CheckRanData } from './facts'

/** What a test needs to run: the queue runs `unit` and `fake` (and a test with no needs); `real` and `packaged` it doesn't. */
export type FocusedNeed = 'unit' | 'fake' | 'real' | 'packaged'
export const FOCUSED_NEEDS: readonly FocusedNeed[] = ['unit', 'fake', 'real', 'packaged']

export interface FocusedTest {
  /** The project's own id for it: opaque to Combwork (a file, a suite, `file.py::test`). */
  id: string
  needs: FocusedNeed[]
}

/** The pick's outcome: a list (possibly empty: nothing needed), or none Combwork can use. */
export type FocusedPickState = 'chosen' | 'unknown' | 'tooBroad'

/** Why a pick is `unknown`, as a code (the window and the agents' reply say it in words). */
export type FocusedPickWhy = 'noPicker' | 'failed' | 'timedOut' | 'badOutput' | 'tooMany' | 'moved' | 'dirty' | 'changed' | 'noChange' | 'cancelled'

/** One path's change, exactly: the identity the queue compares (`sameChange`). Null where a side has none. */
export interface PathChange {
  /** git's raw status letter (A, M, D, R, C, T…). */
  status: string
  oldPath: string | null
  newPath: string | null
  oldMode: string | null
  newMode: string | null
  oldBlob: string | null
  newBlob: string | null
}

/** A submission's focused tests, recorded with it (its `Submitted.focused`). */
export interface FocusedChoice {
  /** What the picker gave; `chosen` with `source: 'manual'` never happens (a manual list stands in for a pick). */
  state: FocusedPickState
  why?: FocusedPickWhy
  /** `picked`: the picker's list; `manual`: the builder's, which stands in for an `unknown` or `tooBroad` pick. */
  source: 'picked' | 'manual'
  picked: FocusedTest[]
  /** The builder's own additions (`tests` on submit), reviewed with the change. */
  added: FocusedTest[]
  /** The change it was chosen for, path by path; null when it couldn't be read (every path is then changed). */
  change: PathChange[] | null
  /** The picker's stderr, bounded: for the reviewer, never part of the selection. */
  diagnostics?: string
}

/** At most this many tests in a list, and characters in an id. */
export const FOCUSED_MAX_TESTS = 500
export const FOCUSED_MAX_ID = 500
/** The picker's output read, at most (more is `tooMany`); its diagnostics kept, at most. */
export const FOCUSED_MAX_OUTPUT = 256 * 1024
export const FOCUSED_MAX_DIAGNOSTICS = 4000
/** The runner's results file, read at most (larger is refused before it is parsed). */
export const FOCUSED_MAX_RESULTS_BYTES = 1024 * 1024

/** Whether a string can be a test id: 1 to FOCUSED_MAX_ID characters, no control characters (NUL included). */
// oxlint-disable-next-line no-control-regex
export const validTestId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= FOCUSED_MAX_ID && !/[\u0000-\u001f\u007f]/.test(id)

/** A test as the builder gives it (`tests` on submit): an id, or `{ id, needs }`. Null when it isn't one. */
export function testOf(v: unknown): FocusedTest | null {
  if (validTestId(v)) return { id: v, needs: [] }
  if (!v || typeof v !== 'object') return null
  const o = v as { id?: unknown; needs?: unknown }
  if (!validTestId(o.id)) return null
  const needs = o.needs === undefined ? [] : o.needs
  if (!Array.isArray(needs) || !needs.every((n) => (FOCUSED_NEEDS as readonly unknown[]).includes(n))) return null
  return { id: o.id, needs: [...new Set(needs as FocusedNeed[])] }
}

/** The builder's `tests`: each valid and unique, at most FOCUSED_MAX_TESTS; else why not (agent-facing English). */
export function testsGiven(v: unknown): { tests: FocusedTest[] } | { bad: string } {
  if (!Array.isArray(v)) return { bad: 'tests must be a list' } // i18n-ignore: agent-facing
  if (v.length > FOCUSED_MAX_TESTS) return { bad: `at most ${FOCUSED_MAX_TESTS} tests` } // i18n-ignore: agent-facing
  const out: FocusedTest[] = []
  for (const x of v) {
    const t = testOf(x)
    if (!t) return { bad: `not a test id: ${JSON.stringify(x).slice(0, 80)}` } // i18n-ignore: agent-facing
    if (out.some((o) => o.id === t.id)) return { bad: `${t.id} is named twice` } // i18n-ignore: agent-facing
    out.push(t)
  }
  return { tests: out }
}

/**
 * The picker's stdout: JSON lines, `{"test": id, "needs": [...]}` each, or one `{"every": true}`. Empty is an explicit
 * "nothing needed". Anything else, a duplicate or more than FOCUSED_MAX_TESTS is `unknown`.
 */
export function parsePick(stdout: string): { state: 'chosen'; tests: FocusedTest[] } | { state: 'tooBroad' } | { state: 'unknown'; why: FocusedPickWhy } {
  if (stdout.length > FOCUSED_MAX_OUTPUT) return { state: 'unknown', why: 'tooMany' } // i18n-ignore: codes (a why, a check name), never shown as text
  const tests: FocusedTest[] = []
  let every = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      return { state: 'unknown', why: 'badOutput' } // i18n-ignore: codes (a why, a check name), never shown as text
    }
    if (v && typeof v === 'object' && (v as { every?: unknown }).every === true) {
      every = true
      continue
    }
    const t = v && typeof v === 'object' ? testOf({ id: (v as { test?: unknown }).test, needs: (v as { needs?: unknown }).needs }) : null
    if (!t || tests.some((x) => x.id === t.id)) return { state: 'unknown', why: 'badOutput' } // i18n-ignore: codes (a why, a check name), never shown as text
    if (tests.length >= FOCUSED_MAX_TESTS) return { state: 'unknown', why: 'tooMany' } // i18n-ignore: codes (a why, a check name), never shown as text
    tests.push(t)
  }
  return every ? { state: 'tooBroad' } : { state: 'chosen', tests }
}

/** The path a change is known by (its new path; a deletion's old one). */
export const changePath = (c: PathChange): string => c.newPath ?? c.oldPath ?? ''

/** Every path a change names (both sides of a rename), for the picker's stdin. */
export const changePaths = (cs: PathChange[]): string[] => [...new Set(cs.flatMap((c) => [c.oldPath, c.newPath].filter((p): p is string => !!p)))]

const same = (a: PathChange, b: PathChange): boolean => a.status === b.status && a.oldPath === b.oldPath && a.newPath === b.newPath && a.oldMode === b.oldMode && a.newMode === b.newMode && a.oldBlob === b.oldBlob && a.newBlob === b.newBlob

/**
 * The result's changes not exactly as the submission's (HR4's s22): a path whose status, endpoints, modes or blobs differ,
 * one the submission didn't have, or every one when either side couldn't be read. Exact identity only: the same edit at
 * another place in a file, or after the target changed that file, is a change (picked again), never assumed the same.
 */
export function changedSince(submitted: PathChange[] | null, result: PathChange[] | null): PathChange[] {
  if (!result) return []
  if (!submitted) return result
  return result.filter((r) => !submitted.some((s) => same(s, r)))
}

/** The selection a submission stands for: the picker's, or the builder's in its stead, with the builder's additions. */
export function chosenTests(c: FocusedChoice): FocusedTest[] {
  const all = c.source === 'manual' ? c.added : [...c.picked, ...c.added]
  const out: FocusedTest[] = []
  for (const t of all) {
    const i = out.findIndex((o) => o.id === t.id)
    if (i < 0) out.push({ id: t.id, needs: [...t.needs] })
    else out[i] = { id: t.id, needs: [...new Set([...out[i].needs, ...t.needs])] }
  }
  return out
}

/** Whether a submission's choice can be merged on: a pick, or the builder's list in place of one that failed. */
export const choiceStands = (c: FocusedChoice | undefined | null): boolean => !!c && (c.state === 'chosen' || c.source === 'manual')

/** A test the queue never runs: proved by its review instead (realProof = review). */
export const reviewProved = (t: FocusedTest): boolean => t.needs.includes('real') || t.needs.includes('packaged')

/** The check name a review's run of one focused test is recorded under (`cw-progress --check "focused:<id>"`). */
export const focusedCheckName = (id: string): string => `focused:${id}`

/** At most this many tests a reviewer's pass accepts others' runs of (HI-2660, `cw_verdict`'s `accept`). */
export const ACCEPT_MAX = 50

/**
 * HI-2660: the run that stands for a focused test at a revision: its latest counted run of `focused:<id>` there, never
 * the merge queue's own (`entry`); none when there is no such run, or when a command configured for that name has
 * changed since (an old command's result doesn't prove the check as it is now). Whether it passed is the caller's to
 * require: an earlier pass never stands behind a later counted failure.
 */
export function standingFocusedRun(checks: readonly CheckRanData[], test: string, revision: string, commands: Readonly<Record<string, string>>): CheckRanData | undefined {
  const name = focusedCheckName(test)
  const run = checks.findLast((c) => c.name === name && c.revision === revision && c.counted && !c.entry)
  return run && (commands[name] === undefined || commands[name] === run.command) ? run : undefined
}

/** The queue's run of a card's focused tests, as its `CheckRan` names it. */
export const FOCUSED_CHECK = 'focused tests' // i18n-ignore: codes (a why, a check name), never shown as text

export interface FocusedResult {
  test: string
  result: 'passed' | 'failed' | 'skipped'
  why?: string
}

/**
 * The runner's results file against the tests it was given: exactly one record each, a known result, and nothing
 * else. Anything less is `bad` (never green); otherwise the failed and the skipped.
 */
export function readResults(raw: string, ids: string[]): { bad: string } | { failed: FocusedResult[]; skipped: FocusedResult[] } {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { bad: 'its results file is not JSON' } // i18n-ignore: a check's output, agent-facing
  }
  if (!Array.isArray(v)) return { bad: 'its results file is not a list' } // i18n-ignore: a check's output, agent-facing
  const seen = new Map<string, FocusedResult>()
  for (const x of v) {
    const r = x as Partial<FocusedResult> | null
    if (!r || typeof r.test !== 'string' || !['passed', 'failed', 'skipped'].includes(String(r.result))) return { bad: 'a result is not { test, result: passed | failed | skipped }' } // i18n-ignore: a check's output, agent-facing
    if (!ids.includes(r.test)) return { bad: `a result for a test it wasn't given: ${r.test.slice(0, 80)}` } // i18n-ignore: a check's output, agent-facing
    if (seen.has(r.test)) return { bad: `two results for ${r.test.slice(0, 80)}` } // i18n-ignore: a check's output, agent-facing
    seen.set(r.test, { test: r.test, result: r.result as FocusedResult['result'], ...(typeof r.why === 'string' ? { why: r.why.slice(0, 300) } : {}) })
  }
  const missing = ids.filter((id) => !seen.has(id))
  if (missing.length) return { bad: `no result for ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}` } // i18n-ignore: a check's output, agent-facing
  const all = [...seen.values()]
  return { failed: all.filter((r) => r.result === 'failed'), skipped: all.filter((r) => r.result === 'skipped') }
}
