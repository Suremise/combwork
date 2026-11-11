// The project's merge checks on a jj card's candidate (HI-2938, design HI-2938/s7 and s11, HR1's OK; extends HI-2871's
// candidate). Decision A holds: the user integrates; nothing here moves a bookmark or pushes.
//
// One run for one candidate attempt, its parts given by the app (jjCandidateChecksApp.ts) or a test:
// - its journal (`ChecksJournal`, board_meta), each check's phase written before its step: `started`, then `ended`
//   with what it came to. A journal for another attempt, fingerprint or checks key is discarded: a new key never reuses a
//   green from an old one. A check `started` with no end (Combwork stopped mid-run) is ended `interrupted` (transient).
// - a check copy leased at exactly the candidate's commit (the copies pool's, with its job: every process of a check in
//   it), never while the journal's earlier lease isn't freed (its tree may still write: the pool's barrier proves it
//   ended), always given back (`give`) whatever happens: the pool frees it only once quiet.
// - the install when the options ask for it every time (`mergeInstall: 'always'`; the pool installs again on a reset
//   whose lock files changed), then each check in order, skipping one ended counted-green at this candidate under the
//   same key, each bracketed (jj's check bracket at the copy) and recorded (`CheckRan`).
// - validity (`valid`): HI-2871's fingerprint still the card's, the checks key the options', the target at the
//   candidate's head and the candidate still the recorded commit; read before the lease and before each check.
// Its answer is the caller's to publish, in a write that checks the same again.

import { stableHash } from '../../shared/workflow/compile'
import type { WorkflowOptions } from '../../shared/workflow/options'
import type { TransientFailure } from '../../shared/types'
import type { CheckWhyNot } from '../../shared/types'
import { sameFingerprint, type JjCandidateFingerprint } from '../platform/jjCandidateStep'
import type { Spawn } from './queueChecks'
import type { CheckContext, CheckResult } from './mergeQueue'

/** What a candidate's check results are bound to besides the candidate (s11 §2): the checks, their commands, the install. */
export function checksKeyOf(o: Pick<WorkflowOptions, 'mergeChecks' | 'commands' | 'mergeInstall'>, setup: string): string {
  return stableHash(JSON.stringify({ names: o.mergeChecks, commands: o.mergeChecks.map((n) => o.commands[n] ?? n), install: o.mergeInstall, setup }))
}

export interface JournalledCheck {
  name: string
  command: string
  run?: string
  phase: 'started' | 'ended'
  /** Ended: passed (exit 0), and whether it counted for exactly `revision`. */
  ok?: boolean
  counted?: boolean
  whyNot?: CheckWhyNot
  revision?: string
  transient?: boolean
  interrupted?: boolean
}

/** A candidate's checks, as journalled (s11 §2). */
export interface ChecksJournal {
  fp: JjCandidateFingerprint
  attempt: string
  /** The candidate's commit and the target head it is built on. */
  result: string
  expected: string
  checksKey: string
  /** The copy lease the last run held (the next waits until it is freed). */
  lease?: string
  checks: JournalledCheck[]
}

/** A copy leased for the run: its folder, the spawn that starts a process in its job, and its return. */
export interface ChecksLease {
  id: string
  folder: string
  spawn: Spawn
  /** Given back (`why`): the pool frees it once quiet; its job ended first when `end`. */
  give(why: string, end?: boolean): Promise<void>
}

export interface CandidateChecksDeps {
  journal: { read(): ChecksJournal | null; write(j: ChecksJournal): Promise<void> }
  /** Whether a lease is freed (or gone): the pool's barrier passed, so nothing of its tree can still write. */
  leaseFreed(id: string): Promise<boolean>
  lease(revision: string): Promise<ChecksLease | { wait: string } | { refused: string }>
  runCheck(name: string, command: string, folder: string, ctx: CheckContext, spawn: Spawn): Promise<CheckResult>
  install(folder: string, ctx: CheckContext, spawn: Spawn): Promise<CheckResult & { skipped?: boolean }>
  /** jj's check bracket at the copy, for exactly `revision`. */
  bracket(folder: string, revision: string): Promise<{ end(): Promise<{ counted: boolean; tested: string; whyNot?: CheckWhyNot }> }>
  valid(): Promise<boolean>
  checkRan(c: { name: string; command: string; revision: string; tested: string; ok: boolean; run: string; durationMs: number; counted: boolean; whyNot?: CheckWhyNot }): Promise<void>
  /** Whether Stop (the Progress panel) ended this run (taken once). */
  stopped(run: string): boolean
  hook?: (point: `beforeCheck:${string}` | `afterCheck:${string}` | 'leased' | 'afterInstall') => Promise<void> | void
  /** The workspace's life (s11 §3): once aborted, a running check's job is ended and its lease given back; nothing more runs. */
  signal?: AbortSignal
  /**
   * How often validity is read again while a command runs (HR1's round 1 finding 4; default WATCH_MS): an invalidation
   * mid-command ends the lease's job (its whole tree) at once, never waiting for the command to finish.
   */
  watchMs?: number
}

/** How often a running command's candidate is checked for validity (HR1's round 1 finding 4). */
export const WATCH_MS = 2_000

export interface CandidateChecksInput {
  card: { key: string; number: number }
  fp: JjCandidateFingerprint
  attempt: string
  result: string
  expected: string
  checksKey: string
  names: string[]
  commands: Record<string, string>
  installAlways: boolean
}

export type CandidateChecksOutcome =
  | { green: true; checks: string[] }
  | { red: { check: string; output: string; logPath?: string } }
  | { transient: { check: string; why: string; cause?: TransientFailure } }
  | { stopped: { check: string } }
  | { invalid: true }
  | { wait: string }
  | { closed: true }

/** The board_meta key of a candidate attempt's checks journal, by the project's canonical id. */
export const checksJournalKey = (project: string, card: string, cycle: number, attempt: string): string => `jj_candidate_checks:${project.toLowerCase()}:${card.toLowerCase()}:${cycle}:${attempt}`

/** What reads and writes the journal on the board (the records' connection). */
type MetaDb = { prepare(sql: string): { get(...a: (string | number)[]): unknown; run(...a: (string | number)[]): unknown } }

/** A checks journal as stored (unreadable: none, so nothing stands from it). */
export function readChecksJournal(db: MetaDb, key: string): ChecksJournal | null {
  const r = db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined // i18n-ignore: SQL
  try {
    const v = r ? (JSON.parse(r.value) as ChecksJournal) : null
    return v && typeof v === 'object' && Array.isArray(v.checks) && v.fp ? v : null
  } catch {
    return null
  }
}

export function writeChecksJournal(db: MetaDb, key: string, j: ChecksJournal): void {
  db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(j)) // i18n-ignore: SQL
}

/** A journal for exactly this input (s11 §2), its interrupted checks ended; else a fresh one. */
export function journalFor(was: ChecksJournal | null, i: CandidateChecksInput): ChecksJournal {
  const same = !!was && was.attempt === i.attempt && was.result === i.result && was.expected === i.expected && was.checksKey === i.checksKey && sameFingerprint(was.fp, i.fp)
  if (!same) return { fp: i.fp, attempt: i.attempt, result: i.result, expected: i.expected, checksKey: i.checksKey, ...(was?.lease ? { lease: was.lease } : {}), checks: [] }
  return { ...was!, checks: was!.checks.map((c) => (c.phase === 'started' ? { ...c, phase: 'ended', ok: false, counted: false, transient: true, interrupted: true } : c)) }
}

/** A check that stands for this journal: ended, passed and counted for exactly the candidate. */
const stands = (j: ChecksJournal, name: string): boolean => j.checks.some((c) => c.name === name && c.phase === 'ended' && c.ok === true && c.counted === true && c.revision === j.result)

/** One run of the candidate's checks (above). Never throws for a check's failure; the lease is always given back. */
export async function runCandidateChecks(deps: CandidateChecksDeps, i: CandidateChecksInput): Promise<CandidateChecksOutcome> {
  if (deps.signal?.aborted) return { closed: true }
  const j = journalFor(deps.journal.read(), i)
  await deps.journal.write(j)
  if (!(await deps.valid())) return { invalid: true }
  if (i.names.every((n) => stands(j, n))) return { green: true, checks: [...i.names] }
  // The last run's copy: never another run while its tree may still write (its lease not through the barrier).
  if (j.lease && !(await deps.leaseFreed(j.lease))) return { wait: 'previous' }
  const l = await deps.lease(i.result)
  if ('wait' in l) return { wait: l.wait }
  if ('refused' in l) return { transient: { check: 'copy', why: l.refused } }
  j.lease = l.id
  await deps.journal.write(j)
  let ended = false
  const give = async (why: string, end = false): Promise<void> => {
    if (ended) return
    ended = true
    await l.give(why, end).catch(() => undefined)
  }
  // The workspace closing mid-run: its job ended (the running check's whole tree) and the lease given back at once.
  const onClose = (): void => void give('closed', true)
  deps.signal?.addEventListener('abort', onClose, { once: true })
  // While a command runs, its candidate's validity read again (finding 4): invalid, its job ended at once.
  let invalidated = false
  const watched = async <T>(fn: () => Promise<T>): Promise<T> => {
    let reading = false
    const timer = setInterval(() => {
      if (reading || invalidated || ended) return
      reading = true
      void deps
        .valid()
        .then(async (ok) => {
          if (ok || invalidated || ended) return
          invalidated = true
          await give('invalid', true)
        })
        .catch(() => undefined)
        .finally(() => (reading = false))
    }, deps.watchMs ?? WATCH_MS)
    timer.unref?.()
    try {
      return await fn()
    } finally {
      clearInterval(timer)
    }
  }
  try {
    await deps.hook?.('leased')
    const ctx: CheckContext = { card: i.card.key, number: i.card.number, revision: i.result, env: { CW_CHECK_BASE: i.expected } }
    let noInstall = false
    if (i.installAlways) {
      const r = await watched(() => deps.install(l.folder, ctx, l.spawn))
      if (deps.signal?.aborted) return { closed: true }
      if (invalidated) return { invalid: true }
      // Stop pressed on the install's run (finding 2): stopped, never red or retried by itself.
      if (r.run && deps.stopped(r.run)) return { stopped: { check: 'install' } }
      if (!r.ok) return r.transient ? { transient: { check: 'install', why: r.output.slice(-400), ...(r.cause ? { cause: r.cause } : {}) } } : { red: { check: 'install', output: r.output, ...(r.logPath ? { logPath: r.logPath } : {}) } }
      noInstall = !!r.skipped
      await deps.hook?.('afterInstall')
    }
    for (const name of i.names) {
      if (stands(j, name)) continue
      if (deps.signal?.aborted) return { closed: true }
      await deps.hook?.(`beforeCheck:${name}`)
      if (!(await deps.valid())) {
        await give('invalid', true)
        return { invalid: true }
      }
      const command = i.commands[name] ?? name
      const entry: JournalledCheck = { name, command, phase: 'started' }
      j.checks = [...j.checks.filter((c) => c.name !== name), entry]
      await deps.journal.write(j)
      const t0 = Date.now()
      const b = await deps.bracket(l.folder, i.result)
      const r = await watched(() => deps.runCheck(name, command, l.folder, { ...ctx, ...(noInstall ? { noInstall } : {}) }, l.spawn))
      noInstall = false
      const end = await b.end()
      const run = r.run ?? ''
      if (deps.signal?.aborted) return { closed: true }
      if (invalidated) return { invalid: true }
      const stopped = !!run && deps.stopped(run)
      Object.assign(entry, { phase: 'ended', run, ok: r.ok, counted: end.counted, revision: i.result, ...(end.whyNot ? { whyNot: end.whyNot } : {}), ...(r.transient || stopped ? { transient: true } : {}) })
      await deps.journal.write(j)
      await deps.checkRan({ name, command: r.command ?? command, revision: i.result, tested: end.tested, ok: r.ok, run, durationMs: Math.max(0, Date.now() - t0), counted: end.counted, ...(end.whyNot ? { whyNot: end.whyNot } : {}) })
      r.note?.({ name, counted: end.counted, ...(end.whyNot ? { whyNot: end.whyNot } : {}) })
      await deps.hook?.(`afterCheck:${name}`)
      if (stopped) return { stopped: { check: name } }
      if (!r.ok) return r.transient ? { transient: { check: name, why: r.output.slice(-400), ...(r.cause ? { cause: r.cause } : {}) } } : { red: { check: name, output: r.output, ...(r.logPath ? { logPath: r.logPath } : {}) } }
      // Exit 0 but not counted (it wrote in the copy, the copy moved): never green; tried again.
      if (!end.counted) return { transient: { check: name, why: `uncounted:${end.whyNot ?? 'unknown'}` } } // i18n-ignore: a protocol code, for the log and the record
    }
    return { green: true, checks: [...i.names] }
  } finally {
    deps.signal?.removeEventListener('abort', onClose)
    await give('checksEnded')
  }
}
