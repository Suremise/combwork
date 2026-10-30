// Where a card stands with the merge queue (#1354, SPEC §16.9.3), for agents: who merges it, by its own ruleset (the
// options it started under, or the user's change applied to it), never the project's current options; and, under Hive
// merges, what the queue is doing with it, worked out from the card's facts and the queue's order (queueOrder: its
// entries in the order they were requested, and the one testing now). One order for every place that says it: a card
// read, a lane's next, a refusal's next step, and the window's queue model (#1353, queueControls.ts's queueView).
import { openEntry, type CardState, type Fact, type FactData, type IntegrationFailReason } from '../../shared/workflow/facts'
import { CAME_BACK, type QueueQueued, type QueueStep, type QueueTesting } from '../../shared/workflow/queue'
import type { CardRecord } from './factStore'
import type { PauseReason, QueueStepInfo } from './mergeQueue'
import type { Workflow } from './runtime'
import { conflictPlaces } from '../../shared/workflow/conflicts'
import { HISTORY, storedText } from '../../shared/taskHistory'
import type { StoredText } from '../../shared/types'

export type QueueState =
  /** Waiting in the queue: `position` 1 is next, after the one testing now. */
  | { state: 'queued'; target: string; position: number }
  /** The queue's entry now, at its step (null: another Hive runs the queue, or its advance is recovered, step unknown). */
  | { state: 'testing'; target: string; step: QueueStep | null }
  /** In the queue, which is paused for its target (`card`: the card it paused on; `stuck`: an interrupted advance, asked in For you). */
  | { state: 'paused'; target: string; reason: PauseReason; card: string; stuck?: true }
  /** Back from the queue to its builder: a conflict, red checks, a hook (`failure`: what came back, as recorded). */
  | { state: 'returned'; reason: IntegrationFailReason; transient: boolean; failure: FactData['IntegrationFailed'] }
  /** Left the queue: it isn't approved any more (its pass stale, or a decision since). */
  | { state: 'left'; why: 'stale' | 'decision' }
  /** Approved, but its pass is stale (HI-1763): its line moved on since (`approved` what was passed, `current` its line). */
  | { state: 'stale'; approved: string | null; current: string | null }
  | { state: 'merged' }
  /** Not in the queue yet: it goes in once approved. */
  | { state: 'notYet' }

/** The card's queue state when its own ruleset says Hive merges it, else null (the agent merges, or nobody checks). */
export function queueStateOf(wf: Workflow, card: CardRecord, s: CardState = wf.state(card)): QueueState | null {
  if (wf.rulesetOf(card, s).options.finish !== 'hiveMerges') return null
  if (s.stage === 'done') return { state: 'merged' }
  const open = openEntry(s)
  if (open) {
    const order = queueOrder(wf, open.target)
    // The one testing now finishes its step even with the queue paused.
    if (order.testing?.entry === open.id) return { state: 'testing', target: open.target, step: order.testing.step }
    const pause = wf.store.queuePause(open.target) as { reason: PauseReason; card: string; stuck?: unknown } | null
    if (pause) return { state: 'paused', target: open.target, reason: pause.reason, card: pause.card, ...(pause.stuck ? { stuck: true as const } : {}) }
    return { state: 'queued', target: open.target, position: order.queued.findIndex((q) => q.entry === open.id) + 1 }
  }
  // Approved with a stale pass, never queued (HI-1763: HI-1737 sat so, its lane paused, nobody told): said, with what to do.
  if (s.stage === 'approved' && s.stale) return { state: 'stale', approved: s.stale.approved, current: s.stale.current }
  const last = s.entries.at(-1)
  if (last?.state === 'failed' && last.failure && (s.stage === 'active' || s.stage === 'todo')) return { state: 'returned', reason: last.failure.reason, transient: last.failure.transient, failure: last.failure }
  if (last?.state === 'cancelled' && (last.cancelled === 'stale' || last.cancelled === 'decision') && s.stage !== 'merging') return { state: 'left', why: last.cancelled }
  return { state: 'notYet' }
}

/** What runs a target's queue in this Hive now (queueHost's queueLive): whether it runs, and its entry at its step. */
export interface QueueLive {
  running: boolean
  now: QueueStepInfo | null
  run: string | null
}

export const NOT_RUN_HERE: QueueLive = { running: false, now: null, run: null }

/** A target's queue in order: its entries still to merge as requested, the one testing now, and those waiting behind it. */
export interface QueueOrder {
  open: { f: Fact; card: CardRecord; state: 'open' | 'started' }[]
  /** Every entry of the target, and their cards (for its outcomes). */
  entries: Set<string>
  cards: Set<number>
  testing: QueueTesting | null
  queued: QueueQueued[]
}

/**
 * A target's queue in order (#1353's model, shared with #1354's card states). Testing now: this Hive's entry at its
 * step; else an advance begun (its recovery finishes it), or, when another Hive runs the queue, its first entry (its
 * step isn't known here).
 */
export function queueOrder(wf: Workflow, target: string, live: QueueLive = wf.queueLive(target)): QueueOrder {
  const store = wf.store
  const states = new Map<number, { card: CardRecord; s: CardState }>()
  const of = (id: number): { card: CardRecord; s: CardState } => {
    let x = states.get(id)
    if (!x) {
      const card = store.card(id)
      states.set(id, (x = { card, s: wf.state(card) }))
    }
    return x
  }
  const open: QueueOrder['open'] = []
  const entries = new Set<string>()
  const cards = new Set<number>()
  for (const f of store.factsOfKind('IntegrationRequested')) {
    const d = f.data as FactData['IntegrationRequested']
    if (d.target !== target) continue
    entries.add(d.entry)
    cards.add(f.card)
    const { card, s } = of(f.card)
    const e = s.entries.find((x) => x.id === d.entry)
    if (e && (e.state === 'open' || e.state === 'started')) open.push({ f, card, state: e.state })
  }
  const named = (card: CardRecord): { card: number; key: string; title: string } => ({ card: card.id, key: card.key, title: card.title })
  let testing: QueueTesting | null = null
  if (live.now) {
    const n = live.now
    testing = { ...named(store.card(n.number)), entry: n.entry, revision: n.revision, expected: n.expected, step: n.step, started: n.started, run: live.run }
  } else {
    const begun = open.find((o) => o.state === 'started') ?? (store.queueLease(target) && !live.running ? open[0] : undefined)
    if (begun) {
      const d = begun.f.data as FactData['IntegrationRequested']
      const st = of(begun.card.id).s.entries.find((x) => x.id === d.entry)?.started
      testing = { ...named(begun.card), entry: d.entry, revision: d.revision, expected: st?.expected ?? null, step: st ? 'advance' : null, started: null, run: null }
    }
  }
  const queued: QueueQueued[] = open
    .filter((o) => (o.f.data as FactData['IntegrationRequested']).entry !== testing?.entry)
    .map((o) => {
      const d = o.f.data as FactData['IntegrationRequested']
      return { ...named(o.card), entry: d.entry, revision: d.revision, at: o.f.at }
    })
  return { open, entries, cards, testing, queued }
}

/**
 * What a paused queue waits for (#1406), by its pause as the queue saved it (read only): the user's answer in For you
 * (the question to update a checked-out target now, which Resume doesn't stand in for; a stuck advance's Decide, or
 * Resume once settled), a step that needs the user fixed and Resume (a needs-you pause with no question: git's error, an
 * earlier runner's process), the folder its target is checked out in put right (Resume checks it first), or the rules
 * enforced again (Hive resumes it then: queueHost's startOpen); anything else, the user's Resume.
 */
export type PauseWait = 'resume' | 'answer' | 'fix' | 'folder' | 'rules'

export function pauseWait(reason: PauseReason, stuck = false): PauseWait {
  switch (reason) {
    case 'approval':
    case 'mergeChoice':
      return 'answer'
    case 'needsYou':
      return stuck ? 'answer' : 'fix'
    case 'subfolderTarget':
    // G18 (#1179): the push after a merge, put right (a pull, a sign-in, a remote) or the option turned off, then Resume.
    case 'pushRejected':
    case 'pushFailed':
    case 'pushNoRemote':
    case 'pushUnreadable':
      return 'fix'
    case 'wrongBranch':
    case 'staged':
    case 'unstagedChanges':
    case 'folderBusy':
      return 'folder'
    case 'rulesOff':
      return 'rules'
    default:
      return 'resume'
  }
}

/** A paused queue's "it moves on once …" for agents: what the pause waits for, never a step of the agent's own. */
function pausedWaits(q: Extract<QueueState, { state: 'paused' }>): string {
  switch (pauseWait(q.reason, q.stuck)) {
    case 'answer':
      return q.reason === 'approval' ? `it moves on once the user answers, in For you, whether to update ${q.target} now` : q.reason === 'mergeChoice' ? 'it moves on once the user chooses, in For you, how Hive merges this project (merge style and commit message)' : 'it moves on once the user settles its interrupted advance (their answer in For you, or Resume)'
    case 'fix':
      return 'it moves on once the user fixes what stopped it and resumes it'
    case 'folder':
      return `it moves on once the user puts right the folder ${q.target} is checked out in and resumes it`
    case 'rules':
      return 'it paused while workflow rules were off; it moves on once they are enforced again (if they already are, once the user resumes it)'
    case 'resume':
      return 'it moves on once the user resumes it'
  }
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
      return `${who} The merge queue is ${q.step === 'advance' ? `moving ${q.target} to its merge` : q.step === 'checks' ? `running the merge checks on its merge into ${q.target}` : `testing its merge into ${q.target}`} now; it moves to Done once merged.`
    case 'paused':
      return `${who} It is in the merge queue for ${q.target}, which is paused (${q.reason}, on ${q.card}); ${pausedWaits(q)}.`
    case 'returned':
      return `${who} ${returnedText('It', q.failure, READ_MAX, READ_LINES)}`
    case 'left':
      return `${who} It left the merge queue: ${q.why === 'decision' ? 'a decision since its approval needs it reviewed again' : 'its pass is stale'}.`
    case 'stale':
      return `${who} Its pass is for ${shortRev(q.approved)}, but its line is at ${shortRev(q.current)} (changed since): submit it again for review (hive_submit); it is queued once that is approved.`
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
/** A branch, check or code name in a return's text, at most (a longer one is cut, marked with "…"). */
const NAME_MAX = 80
/** The last lines are shown only with at least this much room. */
const LINES_MIN = 20

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The files of a conflict in at most `room` characters: as many of the first FILES_NAMED as fit, then "and n more";
 * none fitting, how many.
 */
function listed(files: string[], room: number): string {
  const all = files.join(', ')
  if (files.length <= FILES_NAMED && all.length <= room) return all
  const shown: string[] = []
  for (const f of files.slice(0, FILES_NAMED)) {
    if (`${[...shown, f].join(', ')} and ${files.length - shown.length - 1} more`.length > room) break
    shown.push(f)
  }
  return shown.length ? `${shown.join(', ')} and ${files.length - shown.length} more` : `${files.length} files`
}

/**
 * A conflict's files in `room` characters, each with where its conflicts are (HI-1181) when they all fit, else the files
 * alone (`listed`).
 */
function placedFiles(f: FactData['IntegrationFailed'], room: number): string {
  const files = f.files ?? []
  const placed = files.map((x) => {
    const c = f.conflicts?.files.find((y) => y.file === x)
    return c ? `${x} (${conflictPlaces(c)})` : x
  })
  return placed.length <= FILES_NAMED && placed.join(', ').length <= room ? placed.join(', ') : listed(files, room)
}

/** What came back, in a few words: the reason, and the files (in `room` characters) or the check. Names already clipped. */
function failureText(f: FactData['IntegrationFailed'], room: number): string {
  switch (f.reason) {
    case 'conflict': {
      const head = `a conflict with ${f.target}`
      return f.files?.length ? `${head} in ${placedFiles(f, room - head.length - ' in '.length)}` : head
    }
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
    case 'notUpToDate': {
      // Strict's update conflicted (HI-1181 round 1): its files and where, as a conflict's are; else as before.
      const head = `it isn't up to date with ${f.target}`
      if (!f.files?.length) return head
      const lead = `${head}: a conflict in `
      return `${lead}${placedFiles(f, room - lead.length)}`
    }
    case 'focused': {
      // G20 (HI-1367): what stopped its focused tests, with the tests or paths named (as many as fit).
      const q = f.focused
      const named = (xs: string[] | undefined, lead: string): string => (xs?.length ? `${lead}${listed(xs, room - lead.length)}` : lead)
      if (q?.why === 'repick') return named(q.paths, "its focused tests couldn't be chosen for what changed in the merge: ")
      if (q?.why === 'noProof') return named(q.tests, 'no counted review run at the submitted revision for its real-CLI or packaged focused tests: ')
      if (q?.why === 'newProof') return named(q.tests, 'the merge needs real-CLI or packaged focused tests its review never ran: ')
      if (q?.why === 'noRunner') return 'the project has no command to run its focused tests'
      return 'no focused tests were chosen for its submission'
    }
  }
}

/** What to do next: a transient failure is the same revision submitted again; anything else a fix. */
function nextStep(f: FactData['IntegrationFailed']): string {
  if (f.reason === 'focused') {
    if (f.focused?.why === 'noProof' || f.focused?.why === 'newProof') return `Have its reviewer run those tests at the revision submitted (hive-progress --check "focused:<test>"), then submit the same revision again (hive_submit).`
    if (f.focused?.why === 'noRunner') return 'Tell the user: Version Control → Each card’s focused tests needs the command that runs them.'
    return 'Bring your worktree up to date, then submit again naming the tests the change needs (tests on hive_submit), for review.'
  }
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
 * A returned card in a few sentences (`subject`: its key, or "It"), at most `max` characters: what came back and the
 * next step always whole (names in them cut to NAME_MAX), fitted first; then, in the room left, the files (as many as
 * fit, "and n more"), its log's path (whole, or a pointer to the card), and the output's last lines (cut from their
 * start so the end shows, "…").
 */
export function returnedText(subject: string, f: FactData['IntegrationFailed'], max = WAKE_NOTE_MAX, lines = WAKE_LINES): string {
  const named: FactData['IntegrationFailed'] = { ...f, target: clip(f.target, NAME_MAX), ...(f.check ? { check: clip(f.check, NAME_MAX) } : {}), ...(f.code ? { code: clip(f.code, NAME_MAX) } : {}) }
  const lead = `${clip(subject, NAME_MAX)} ${CAME_BACK}: `
  const next = ` ${nextStep(named)}`
  // The reason and the next step are fixed; the files take what's left, keeping LINES_MIN for the rest.
  const fixed = lead.length + '.'.length + next.length
  const head = `${lead}${failureText(named, max - fixed - LINES_MIN)}.`
  let room = max - head.length - next.length
  let path = ''
  if (f.logPath) {
    const whole = ` Its log: ${f.logPath}.`
    const pointer = ' Its log path: hive_read_task.'
    path = whole.length <= room ? whole : pointer.length <= room ? pointer : ''
    room -= path.length
  }
  const tail = f.log ? lastLines(f.log, lines) : ''
  const frame = ' Its last lines: "".'.length
  const fit = room - frame
  const shown = tail && fit >= LINES_MIN ? (tail.length > fit ? `…${tail.slice(tail.length - fit + 1)}` : tail) : ''
  return `${head}${path}${shown ? ` Its last lines: "${shown}".` : ''}${next}`
}

/** A revision as a wake or a line names it: its first 7 characters ("—" when there is none). */
const shortRev = (r: string | null | undefined): string => (r ? r.slice(0, 7) : '—')

/**
 * A pass gone stale (HI-1763): what it was for, where the card's line is now, and what to do (its builder's wake, at
 * once: HI-1737 sat in Approved, nobody told).
 */
export const staleWake = (key: string, approved: string | null | undefined, current: string | null | undefined): string =>
  `${key}: its pass is stale: it is for ${shortRev(approved)}, but its line is at ${shortRev(current)} (changed since). Submit ${shortRev(current)} for review (hive_submit).` // i18n-ignore: a wake, agent-facing

/** A returned card's wake (#1354): its key, what came back, and what to do next. */
export const returnedWake = (key: string, f: FactData['IntegrationFailed']): string => returnedText(key, f)

/** How many characters a resubmitted card's wake gives what came back (its files): see resubmittedText. */
const RESUBMITTED_ROOM = 200

/**
 * HI-2143: a card its builder submitted again after the merge queue returned it, for its reviewer: that it is back, what
 * came back (the files of a conflict, in RESUBMITTED_ROOM characters: the wake line's bytes keep its end whole, in any
 * script), who submitted it again and what to review. One sentence (agent-facing, English).
 */
export function resubmittedText(key: string, f: FactData['IntegrationFailed'], builder: string): string {
  const named: FactData['IntegrationFailed'] = { ...f, target: clip(f.target, NAME_MAX), ...(f.check ? { check: clip(f.check, NAME_MAX) } : {}), ...(f.code ? { code: clip(f.code, NAME_MAX) } : {}) }
  const conflict = f.reason === 'conflict' || (f.reason === 'notUpToDate' && !!f.files?.length)
  const lead = `${clip(key, NAME_MAX)} is back in Review after the merge queue returned it (`
  const tail = `); ${clip(builder, NAME_MAX)} ${conflict ? 'resolved it' : 'changed it'} and submitted it again: review ${conflict ? 'the resolution' : 'what changed'}`
  return `${lead}${failureText(named, RESUBMITTED_ROOM)}${tail}`
}

/** How long the queue's comment on a returned card is, and how many of its output's last lines it quotes (HI-2087). */
const COMMENT_MAX = 1500
const COMMENT_LINES = 10
/** How many of the files a returned card's comment names in the window. */
const COMMENT_FILES = 10

/**
 * HI-2087: the comment the queue writes on a card it returned: in English for whoever reads the card (agents: what came
 * back and what to do next, as its wake says it, with more room), and as a message for the window (`shown`): why, and
 * the files.
 */
export function returnedComment(key: string, f: FactData['IntegrationFailed']): { text: string; shown: StoredText } {
  const reason = f.reason === 'checks' ? (f.check === 'install' ? 'install' : f.transient ? 'checksEnv' : f.check ? 'checks' : 'checksSome') : f.reason
  const files = f.files?.length ? `${f.files.slice(0, COMMENT_FILES).join(', ')}${f.files.length > COMMENT_FILES ? ', …' : ''}` : 'none'
  return { text: returnedText(key, f, COMMENT_MAX, COMMENT_LINES), shown: storedText(HISTORY.queueReturned, { reason, target: f.target, check: f.check ?? '', files }) }
}

/** A card that left the queue, not approved any more (#1354): why, and what to do next (`to`: where it went). */
export function leftWake(key: string, why: 'stale' | 'decision', to: 'review' | 'active'): string {
  if (why === 'decision') return `${key} left the merge queue: a decision since its approval needs it reviewed again. Read its decisions (hive_read_task)${to === 'review' ? '; it is back in Review, and queued again once approved.' : ', then submit again (hive_submit).'}`
  return `${key} left the merge queue: its pass is stale (its revision changed since it was approved). Submit the current revision (hive_submit) for review.`
}
