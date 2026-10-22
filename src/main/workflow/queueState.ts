// Where a card stands with the merge queue (#1354, SPEC §16.9.3), for agents: who merges it, by its own ruleset (the
// options it started under, or the user's change applied to it), never the project's current options; and, under Hive
// merges, what the queue is doing with it, worked out from the card's facts and the queue's order (its entries in the
// order they were requested: MergeQueue.entries). One helper for every place that says it: a card read, a lane's next,
// a refusal's next step, and the window's queue model (#1353) when it comes.
import { openEntry, type CardState, type FactData, type IntegrationFailReason } from '../../shared/workflow/facts'
import type { CardRecord } from './factStore'
import type { PauseReason } from './mergeQueue'
import type { Workflow } from './runtime'

export type QueueState =
  /**
   * In the queue: `position` 1 is first (being tested now, or next). An entry stays open while its test merge and checks
   * run (no fact says so until they end), so the one being tested counts ahead of those behind it.
   */
  | { state: 'queued'; target: string; position: number }
  /** Started: its target being moved to the result (`advance`), or a run recovered after a restart (`merge`). */
  | { state: 'testing'; target: string; step: 'merge' | 'advance' }
  /** In the queue, which is paused for its target (`card`: the card it paused on). */
  | { state: 'paused'; target: string; reason: PauseReason; card: string }
  /** Back from the queue to its builder: a conflict, red checks, a hook (`failure`: what came back, as recorded). */
  | { state: 'returned'; reason: IntegrationFailReason; transient: boolean; failure: FactData['IntegrationFailed'] }
  /** Left the queue: it isn't approved any more (its pass stale, or a decision since). */
  | { state: 'left'; why: 'stale' | 'decision' }
  | { state: 'merged' }
  /** Not in the queue yet: it goes in once approved. */
  | { state: 'notYet' }

/** The card's queue state when its own ruleset says Hive merges it, else null (the agent merges, or nobody checks). */
export function queueStateOf(wf: Workflow, card: CardRecord, s: CardState = wf.state(card)): QueueState | null {
  if (wf.rulesetOf(card, s).options.finish !== 'hiveMerges') return null
  if (s.stage === 'done') return { state: 'merged' }
  const open = openEntry(s)
  if (open) {
    if (open.state === 'started') return { state: 'testing', target: open.target, step: open.phases.length ? 'advance' : 'merge' }
    const pause = wf.store.queuePause(open.target) as { reason: PauseReason; card: string } | null
    if (pause) return { state: 'paused', target: open.target, reason: pause.reason, card: pause.card }
    return { state: 'queued', target: open.target, position: positionOf(wf, open.id, open.target) }
  }
  const last = s.entries.at(-1)
  if (last?.state === 'failed' && last.failure && (s.stage === 'active' || s.stage === 'todo')) return { state: 'returned', reason: last.failure.reason, transient: last.failure.transient, failure: last.failure }
  if (last?.state === 'cancelled' && (last.cancelled === 'stale' || last.cancelled === 'decision') && s.stage !== 'merging') return { state: 'left', why: last.cancelled }
  return { state: 'notYet' }
}

/** An open entry's place among the target's open entries, in the order they were requested (1: next). */
function positionOf(wf: Workflow, entry: string, target: string): number {
  let ahead = 0
  for (const f of wf.store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    if (d.target !== target) continue
    if (d.entry === entry) break
    const e = wf.state(wf.store.card(f.card)).entries.find((x) => x.id === d.entry)
    if (e?.state === 'open') ahead++
  }
  return ahead + 1
}

/**
 * The card's queue state in a sentence for agents (English: agent-facing). `enforced` false (Settings → Advanced:
 * workflow rules not enforced): nothing refuses, so the agent merges and reports as before 1.0.
 */
export function queueLine(q: QueueState, enforced = true): string {
  if (!enforced) return "Hive merges this card (its rules), but workflow rules aren't enforced: merge it yourself and report the merge (hive_report_merge)."
  const who = "Hive merges this card (its rules): don't merge it yourself."
  switch (q.state) {
    case 'queued':
      return `${who} It is in the merge queue for ${q.target}, position ${q.position}; it moves to Done once merged.`
    case 'testing':
      return `${who} The merge queue is ${q.step === 'advance' ? `moving ${q.target} to its merge` : `testing its merge into ${q.target}`} now; it moves to Done once merged.`
    case 'paused':
      return `${who} It is in the merge queue for ${q.target}, which is paused (${q.reason}, on ${q.card}); it moves on once the user resumes it.`
    case 'returned':
      return `${who} ${returnedText('It', q.failure, READ_MAX, READ_LINES)}`
    case 'left':
      return `${who} It left the merge queue: ${q.why === 'decision' ? 'a decision since its approval needs it reviewed again' : 'its pass is stale'}.`
    case 'merged':
      return 'Hive merged this card.'
    case 'notYet':
      return `${who} Once it is approved, the merge queue merges it and moves it to Done.`
  }
}

/** What a returned card's wake says of it, at most (watch.ts's room for Hive's own note in a wake line). */
export const WAKE_NOTE_MAX = 600
/** What a card read says of it, at most, and how many of the log's last lines. */
const READ_MAX = 1500
const READ_LINES = 15
const WAKE_LINES = 5
/** Files named before "and n more". */
const FILES_NAMED = 8

const listed = (files: string[]): string => (files.length > FILES_NAMED ? `${files.slice(0, FILES_NAMED).join(', ')} and ${files.length - FILES_NAMED} more` : files.join(', '))

/** What came back, in a few words: the reason, and the files or the check. */
function failureText(f: FactData['IntegrationFailed']): string {
  switch (f.reason) {
    case 'conflict':
      return f.files?.length ? `a conflict with ${f.target} in ${listed(f.files)}` : `a conflict with ${f.target}`
    case 'checks': {
      const what = f.check === 'install' ? 'the install before the merge checks' : f.check ? `the merge check ${f.check}` : 'a merge check'
      return f.transient ? `${what} failed for the environment, not the work (${f.cause ?? 'temporary'}${f.code ? `: ${f.code}` : ''})` : `${what} failed on the merged result`
    }
    case 'hook':
      return 'a git hook refused its merge commit'
    case 'targetMoved':
      return `${f.target} moved while it was being merged`
    case 'folderBusy':
      return `the folder ${f.target} is checked out in was busy`
    case 'notUpToDate':
      return `it isn't up to date with ${f.target}`
  }
}

/** What to do next: a transient failure is the same revision submitted again; anything else a fix. */
function nextStep(f: FactData['IntegrationFailed']): string {
  if (f.transient) return 'Submit the same revision again (hive_submit): it goes straight back into the queue, at most twice in a row.'
  if (f.reason === 'conflict') return `Merge ${f.target} into your worktree, resolve the conflict, commit and submit again (hive_submit).`
  return 'Fix it in your worktree, commit and submit again (hive_submit).'
}

/** The output's last `n` non-blank lines, on one line. */
function lastLines(log: string, n: number): string {
  return log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ')
}

/**
 * A returned card in a few sentences (`subject`: its key, or "It"): what came back, its log's path, the output's last
 * lines (the part that gives way, cut from its start so the end shows), and the next step; at most `max` characters.
 */
export function returnedText(subject: string, f: FactData['IntegrationFailed'], max = WAKE_NOTE_MAX, lines = WAKE_LINES): string {
  const head = `${subject} came back from the merge queue: ${failureText(f)}.`
  const path = f.logPath ? ` Its log: ${f.logPath}.` : ''
  const next = ` ${nextStep(f)}`
  const tail = f.log ? lastLines(f.log, lines) : ''
  const room = max - head.length - path.length - next.length - ' Its last lines: "".'.length
  const shown = tail && room > 20 ? (tail.length > room ? `…${tail.slice(tail.length - room + 1)}` : tail) : ''
  return `${head}${path}${shown ? ` Its last lines: "${shown}".` : ''}${next}`.slice(0, max)
}

/** A returned card's wake (#1354): its key, what came back, and what to do next. */
export const returnedWake = (key: string, f: FactData['IntegrationFailed']): string => returnedText(key, f)

/** A card that left the queue, not approved any more (#1354): why, and what to do next (`to`: where it went). */
export function leftWake(key: string, why: 'stale' | 'decision', to: 'review' | 'active'): string {
  if (why === 'decision') return `${key} left the merge queue: a decision since its approval needs it reviewed again. Read its decisions (hive_read_task)${to === 'review' ? '; it is back in Review, and queued again once approved.' : ', then submit again (hive_submit).'}`
  return `${key} left the merge queue: its pass is stale (its revision changed since it was approved). Submit the current revision (hive_submit) for review.`
}
