// Where a card stands with the merge queue (#1354, SPEC §16.9.3), for agents: who merges it, by its own ruleset (the
// options it started under, or the user's change applied to it), never the project's current options; and, under Combwork
// merges, what the queue is doing with it, worked out from the card's facts and the queue's order (queueOrder: its
// entries in the order they were requested, and the one testing now). One order for every place that says it: a card
// read, a lane's next, a refusal's next step, and the window's queue model (#1353, queueControls.ts's queueView).
import { openEntry, QUEUE_PUBLISH_GATE, type CardState, type Fact, type FactData, type IntegrationFailReason } from '../../shared/workflow/facts'
import { CAME_BACK, type QueueQueued, type QueueStep, type QueueTesting } from '../../shared/workflow/queue'
import type { CardRecord } from './factStore'
import type { PauseReason, QueueStepInfo } from './mergeQueue'
import type { Workflow } from './runtime'
import { conflictPlaces } from '../../shared/workflow/conflicts'
import { HISTORY, storedText } from '../../shared/taskHistory'
import type { StoredText } from '../../shared/types'
import { agentMsg, say } from '../../shared/agentText'
import { inDefaultDialect } from '../../shared/agentText/asyncScope'

/** What agents are told of a card and the merge queue (dialects, HI-2435): card reads, a lane's next, wakes, the queue's comment. */
const Q = {
  unenforced: agentMsg({ id: 'queue.line.unenforced', text: "Combwork merges this card (its rules), but workflow rules aren't enforced: merge it yourself and report the merge (cw_report_merge).", note: 'A card read under Combwork merges while Settings → Advanced: workflow rules are enforced is off: nothing refuses, so the agent merges and reports as before 1.0.' }),
  who: agentMsg({ id: 'queue.line.who', text: "Combwork merges this card (its rules): don't merge it yourself.", note: "The first sentence of every queue line for a card Combwork's merge queue merges (#1354): the agent never merges it itself." }),
  queued: agentMsg({ id: 'queue.line.queued', text: '{who} It is in the merge queue for {target}, position {position}; it moves to Done once merged.', note: '{who}: queue.line.who. {target}: the branch it merges into. {position}: 1 is next, after the one testing now.' }),
  waiting: agentMsg({ id: 'queue.line.waiting', text: '{who} It is in the merge queue for {target}, waiting for {cards} to be Done: it is blocked by them, and the queue merges it once they are.', note: '{who}: queue.line.who. {target}: the branch it merges into. {cards}: the cards it is blocked by that are not Done yet (keys, comma-joined). HI-2709.' }),
  testing: agentMsg({ id: 'queue.line.testing', text: '{who} The merge queue is {step, select, advance {moving {target} to its merge} checks {running the merge checks on its merge into {target}} other {testing its merge into {target}}} now; it moves to Done once merged.', note: "{who}: queue.line.who. {target}: the branch it merges into. {step}: the queue's step with it (advance, checks; other: another or not known here)." }),
  paused: agentMsg({ id: 'queue.line.paused', text: '{who} It is in the merge queue for {target}, which is paused ({reason}, on {card}); {waits}.', note: "{who}: queue.line.who. {reason}: the pause's code (as the window's queue names it). {card}: the card it paused on. {waits}: what it waits for (queue.paused.*), never a step of the agent's own (#1406)." }),
  returned: agentMsg({ id: 'queue.line.returned', text: '{who} {returned}', note: '{who}: queue.line.who. {returned}: what came back and what to do next (queue.returned.*).' }),
  left: agentMsg({ id: 'queue.line.left', text: '{who} It left the merge queue: {why, select, decision {a decision since its approval needs it reviewed again} other {its pass is stale}}.', note: "{who}: queue.line.who. {why}: decision (a decision since its approval) or stale (its pass)." }),
  stale: agentMsg({ id: 'queue.line.stale', text: '{who} Its pass is for {approved}, but its line is at {current} (changed since): submit it again for review (cw_submit); it is queued once that is approved.', note: 'HI-1763: approved with a stale pass, never queued (HI-1737 sat so, its lane paused, nobody told). {who}: queue.line.who. {approved}, {current}: short revisions ("—" for none).' }),
  merged: agentMsg({ id: 'queue.line.merged', text: 'Combwork merged this card.', note: 'A card the merge queue merged.' }),
  notYet: agentMsg({ id: 'queue.line.notYet', text: '{who} Once it is approved, the merge queue merges it and moves it to Done.', note: '{who}: queue.line.who. Not in the queue yet: it goes in once approved.' }),
  waitsApproval: agentMsg({ id: 'queue.paused.approval', text: 'it moves on once the user answers, in For you, whether to update {target} now', note: "What a queue paused for the user's answer waits for (#1406): whether to update a checked-out target now (Resume doesn't stand in for it). {target}: the branch." }),
  waitsMergeChoice: agentMsg({ id: 'queue.paused.mergeChoice', text: 'it moves on once the user chooses, in For you, how Combwork merges this project (merge style and commit message)', note: "What a queue paused for the project's merge style waits for (#1406)." }),
  waitsStuck: agentMsg({ id: 'queue.paused.stuck', text: 'it moves on once the user settles its interrupted advance (their answer in For you, or Resume)', note: 'What a queue paused on an interrupted advance waits for (#1406): Decide in For you, or Resume once settled.' }),
  waitsPublish: agentMsg({ id: 'queue.paused.publish', text: 'it moves on once the user says whether its push reached the remote (their answer in For you), or Resume finds it there', note: 'What a queue paused on an unknown publication waits for (HI-1183, follow mode): Approve or Decline in For you; Resume looks at the remote again.' }),
  waitsPublishAnswered: agentMsg({ id: 'queue.paused.publishAnswered', text: 'the user has answered whether its push reached the remote; it moves on as the queue takes up that answer', note: "HI-3091: a queue still paused on an unknown publication whose For you question the user has answered (nothing left to ask): the queue's next run settles it." }),
  waitsFix: agentMsg({ id: 'queue.paused.fix', text: 'it moves on once the user fixes what stopped it and resumes it', note: "What a queue paused on a step that needs the user waits for (#1406): git's error, a push (G18, #1179), then Resume." }),
  waitsFolder: agentMsg({ id: 'queue.paused.folder', text: 'it moves on once the user puts right the folder {target} is checked out in and resumes it', note: 'What a queue paused on the folder its target is checked out in waits for (#1406). {target}: the branch.' }),
  waitsRules: agentMsg({ id: 'queue.paused.rules', text: 'it paused while workflow rules were off; it moves on once they are enforced again (if they already are, once the user resumes it)', note: "What a queue paused while workflow rules weren't enforced waits for (#1406): Combwork resumes it once they are." }),
  waitsResume: agentMsg({ id: 'queue.paused.resume', text: 'it moves on once the user resumes it', note: "What any other paused queue waits for: the user's Resume (#1406)." }),
  subjectIt: agentMsg({ id: 'queue.returned.subjectIt', text: 'It', note: "The subject of a returned card's sentence in its own card read (a wake names it by its key)." }),
  lead: agentMsg({ id: 'queue.returned.lead', text: '{subject} {cameBack}: {failure}.', note: '{subject}: the card (its key, or queue.returned.subjectIt). {cameBack}: "came back from the merge queue". {failure}: what came back (queue.failure.*).' }),
  log: agentMsg({ id: 'queue.returned.log', text: 'Its log: {path}.', note: "A returned card's log, by its path, where it fits." }),
  logPointer: agentMsg({ id: 'queue.returned.logPointer', text: 'Its log path: cw_read_task.', note: "Where a returned card's log path is, when the path itself doesn't fit." }),
  lastLines: agentMsg({ id: 'queue.returned.lastLines', text: 'Its last lines: "{lines}".', note: "The last lines of a returned card's output, joined with \" | \" and cut from their start (\"…\") to fit." }),
  more: agentMsg({ id: 'queue.files.more', text: '{files} and {n} more', note: 'A list of files cut to fit: {files} the first ones, {n} how many more.' }),
  filesCount: agentMsg({ id: 'queue.files.count', text: '{n} files', note: 'A list of files when none of their names fits: how many.' }),
  conflict: agentMsg({ id: 'queue.failure.conflict', text: 'a conflict with {target}', note: 'What came back: a conflict merging into {target} (its files follow, queue.failure.in).' }),
  failureIn: agentMsg({ id: 'queue.failure.in', text: '{head} in {files}', note: '{head}: what came back (queue.failure.conflict). {files}: its files, each with where its conflicts are when they fit (HI-1181).' }),
  checkInstall: agentMsg({ id: 'queue.failure.check.install', text: 'the install before the merge checks', note: 'The merge check that failed: the install that runs before them.' }),
  checkNamed: agentMsg({ id: 'queue.failure.check.named', text: 'the merge check {check}', note: 'The merge check that failed, by its name.' }),
  checkSome: agentMsg({ id: 'queue.failure.check.some', text: 'a merge check', note: 'A merge check that failed, its name not known.' }),
  checkEnv: agentMsg({ id: 'queue.failure.check.environment', text: '{what} failed for the environment, not the work ({cause}{code})', note: '{what}: the check (queue.failure.check.*). {cause}: why, as recorded (queue.failure.temporary when none). {code}: ": " and its code, or nothing.' }),
  temporary: agentMsg({ id: 'queue.failure.temporary', text: 'temporary', note: "The cause of a check that failed for its environment, when none was recorded." }),
  checkFailed: agentMsg({ id: 'queue.failure.check.failed', text: '{what} failed on the merged result', note: '{what}: the check (queue.failure.check.*): it failed on the work merged with its target.' }),
  hook: agentMsg({ id: 'queue.failure.hook', text: 'a git hook refused its merge commit', note: 'What came back: a git hook refused the merge commit.' }),
  targetMoved: agentMsg({ id: 'queue.failure.targetMoved', text: '{target} moved while it was being merged', note: 'What came back: its target branch moved during the merge.' }),
  pushRefused: agentMsg({ id: 'queue.failure.pushRefused', text: 'publishing it to {target}’s remote was refused (a pre-push hook or the remote); it is tested again after Resume', note: 'What came back (HI-1183, follow mode): the project’s pre-push hook or the remote refused the push of the merge; nothing was published.' }),
  direction: agentMsg({ id: 'queue.failure.direction', text: 'a forward merge into {target} against the release path’s direction (into an older version or the default branch, or two branches Combwork can’t order), its request with no override; nothing merged', note: 'What came back (HI-2892): a forward merge card the queue refused to merge, against the release path’s direction.' }),
  nextDirection: agentMsg({ id: 'queue.next.direction', text: 'Leave it to the user or the Assistant: Remove from queue ends it (Retry is refused); only a new request with the user’s explicit override merges it.', note: 'The next step after a forward merge came back against the release path’s direction (HI-2892).' }),
  directionResolution: agentMsg({ id: 'queue.failure.directionResolution', text: 'the resolution of {forward}, bringing {to} up to date with {from}, is against the release path’s direction now (the default branch or the branches changed since Resolve), and {forward}’s request recorded no override; nothing merged', note: 'What came back (HI-2998): a card made by Resolve on a builder to merge branch {from} into branch {to} by hand, refused at its merge: that direction no longer reads forward. {forward}: the forward merge card it resolves (a key like HI-12).' }),
  nextDirectionResolution: agentMsg({ id: 'queue.next.directionResolution', text: 'Don’t submit it again yet: it comes back the same way. Say so on the card and leave it to the user: only their explicit override (a forward request of {from} into {to} with the override, which records it on this card) lets it merge. Once it is recorded, you are told to submit the same revision again.', note: 'The next step, for its builder, after a resolution of a forward merge came back against the release path’s direction (HI-2998; HI-3040: the override request records it on the resolution).' }),
  resolution: agentMsg({ id: 'queue.failure.resolution', text: 'the resolution of {forward} doesn’t contain {source}, the commit it resolves (cherry-picked or copied, not merged); nothing merged', note: 'What came back (HI-2999): a card made by Resolve on a builder whose revision lacks the commit it resolves. {forward}: the forward merge card (a key like HI-12); {source}: a commit id.' }),
  nextResolution: agentMsg({ id: 'queue.next.resolution', text: 'In its branch, run git merge {source}, resolve the conflict, commit, and submit again.', note: 'The next step after a resolution came back without the commit it resolves (HI-2999). {source}: a full commit id.' }),
  notPublished: agentMsg({ id: 'queue.failure.notPublished', text: 'the user said its publication to {target}’s remote didn’t happen; it is tested again', note: 'What came back (HI-1183, follow mode): an unknown publication the user said wasn’t published.' }),
  folderBusy: agentMsg({ id: 'queue.failure.folderBusy', text: 'the folder {target} is checked out in was busy', note: 'What came back: the folder its target branch is checked out in was busy.' }),
  notUpToDate: agentMsg({ id: 'queue.failure.notUpToDate', text: "it isn't up to date with {target}", note: 'What came back: under Strict, the card isn\'t up to date with its target.' }),
  notUpToDateFiles: agentMsg({ id: 'queue.failure.notUpToDate.files', text: '{head}: a conflict in {files}', note: "HI-1181 round 1: Strict's update conflicted. {head}: queue.failure.notUpToDate. {files}: its files and where, as a conflict's are." }),
  repick: agentMsg({ id: 'queue.failure.focused.repick', text: "its focused tests couldn't be chosen for what changed in the merge: {paths}", note: 'G20 (HI-1367): its focused tests couldn\'t be picked for the merge. {paths}: the paths, as many as fit.' }),
  noProof: agentMsg({ id: 'queue.failure.focused.noProof', text: 'no counted review run at the submitted revision for its real-CLI or packaged focused tests: {tests}', note: 'G20 (HI-1367): focused tests the queue doesn\'t run had no counted run at the submitted revision. {tests}: the tests, as many as fit.' }),
  newProof: agentMsg({ id: 'queue.failure.focused.newProof', text: 'the merge needs real-CLI or packaged focused tests its review never ran: {tests}', note: 'G20 (HI-1367): the merge needs focused tests the queue doesn\'t run and the review didn\'t either. {tests}: the tests, as many as fit.' }),
  noRunner: agentMsg({ id: 'queue.failure.focused.noRunner', text: 'the project has no command to run its focused tests', note: 'G20 (HI-1367): no focused-test command in the project.' }),
  noneChosen: agentMsg({ id: 'queue.failure.focused.none', text: 'no focused tests were chosen for its submission', note: 'G20 (HI-1367): its submission had no focused tests chosen.' }),
  nextProof: agentMsg({ id: 'queue.next.proof', text: 'Have its reviewer run those tests at the revision submitted (cw-progress --check "focused:<test>"), then submit the same revision again (cw_submit).', note: 'The next step when its focused tests that the queue doesn\'t run need a counted run (G20, HI-1367).' }),
  nextRunner: agentMsg({ id: 'queue.next.runner', text: 'Tell the user: Version Control → Each card’s focused tests needs the command that runs them.', note: 'The next step when the project has no focused-test command: the setting is the user\'s (a tab and option name, as the window shows them).' }),
  nextRepick: agentMsg({ id: 'queue.next.repick', text: 'Bring your worktree up to date, then submit again naming the tests the change needs (tests on cw_submit), for review.', note: "The next step when its focused tests couldn't be chosen (G20, HI-1367)." }),
  nextTransient: agentMsg({ id: 'queue.next.transient', text: 'Submit the same revision again (cw_submit): it goes straight back into the queue, at most twice in a row.', note: 'The next step after a failure of the environment, not the work.' }),
  nextConflict: agentMsg({ id: 'queue.next.conflict', text: 'Merge {target} into your worktree, resolve the conflict, commit and submit again (cw_submit).', note: 'The next step after a conflict with {target}, the branch.' }),
  nextConflictRemote: agentMsg({ id: 'queue.next.conflictRemote', text: '{target} on its remote ({remote}) is at {commit}, which the queue tested on and your local {target} doesn’t have yet: merge that commit into your worktree (git merge {commit}: it is in the repository already), resolve the conflict, commit and submit again (cw_submit).', note: 'HI-3127: the next step after a conflict with {target} under “The target branch follows its remote”, when the remote’s head the queue tested on ({commit}, a full commit id, kept in the repository) is newer than the local {target}. {remote}: the remote branch, as <remote>/<branch>.' }),
  nextFixRemote: agentMsg({ id: 'queue.next.fixRemote', text: 'Fix it in your worktree, commit and submit again (cw_submit). It was tested merged with {commit}, {target}’s head on its remote ({remote}), which your local {target} doesn’t have yet: merge that commit (git merge {commit}: it is in the repository already) to see what the queue saw.', note: 'HI-3127: the next step after a red check or a hook under “The target branch follows its remote”, when the remote’s head the queue tested on ({commit}, a full commit id, kept in the repository) is newer than the local {target}. {remote}: the remote branch, as <remote>/<branch>.' }),
  nextForward: agentMsg({ id: 'queue.next.forward', text: 'A forward merge has no builder, and no agent works on it: the user or the Assistant decides. Retry merge tries again with {from} as it is then; Resolve on a builder ends it and makes a card for a builder to merge {from} into {to} and resolve this there; Remove from queue ends it, nothing merged.', note: "HI-2959: the next step on a forward merge card (Combwork merging branch {from} into {to}) the merge queue returned: no agent may act on it. Retry merge, Resolve on a builder and Remove from queue are the window's commands." }),
  nextFix: agentMsg({ id: 'queue.next.fix', text: 'Fix it in your worktree, commit and submit again (cw_submit).', note: 'The next step after anything else that came back.' }),
  staleWake: agentMsg({ id: 'queue.wake.stale', text: '{card}: its pass is stale: it is for {approved}, but its line is at {current} (changed since). Submit {current} for review (cw_submit).', note: "HI-1763: a pass gone stale, its builder's wake at once (HI-1737 sat in Approved, nobody told). {approved}, {current}: short revisions (\"—\" for none)." }),
  resubmitted: agentMsg({ id: 'queue.wake.resubmitted', text: '{card} is back in Review after the merge queue returned it ({failure}); {builder} {conflict, select, yes {resolved it} other {changed it}} and submitted it again: review {conflict, select, yes {the resolution} other {what changed}}', note: "HI-2143: a card submitted again after the queue returned it, its reviewer's wake. {failure}: what came back (queue.failure.*). {conflict}: yes when it came back with a conflict." }),
  leftDecision: agentMsg({ id: 'queue.wake.left.decision', text: '{card} left the merge queue: a decision since its approval needs it reviewed again. Read its decisions (cw_read_task){to, select, review {; it is back in Review, and queued again once approved.} other {, then submit again (cw_submit).}}', note: "#1354: its builder's wake for a card that left the queue for a decision since its approval. {to}: review (it went back to Review) or active." }),
  leftStale: agentMsg({ id: 'queue.wake.left.stale', text: '{card} left the merge queue: its pass is stale (its revision changed since it was approved). Submit the current revision (cw_submit) for review.', note: "#1354: its builder's wake for a card that left the queue, its pass stale." })
}

export type QueueState =
  /** Waiting in the queue: `position` 1 is next, after the one testing now. */
  | { state: 'queued'; target: string; position: number }
  /** HI-2709: in the queue, but blocked by cards that aren't Done (`on`, their keys): the queue goes on without it. */
  | { state: 'waiting'; target: string; on: string[] }
  /** The queue's entry now, at its step (null: another Combwork runs the queue, or its advance is recovered, step unknown). */
  | { state: 'testing'; target: string; step: QueueStep | null }
  /** In the queue, which is paused for its target (`card`: the card it paused on; `stuck`: an interrupted advance, asked in For you). */
  | { state: 'paused'; target: string; reason: PauseReason; card: string; stuck?: true; answered?: true }
  /** Back from the queue to its builder: a conflict, red checks, a hook (`failure`: what came back, as recorded). */
  | { state: 'returned'; reason: IntegrationFailReason; transient: boolean; failure: FactData['IntegrationFailed']; about?: ReturnedForward }
  /** Left the queue: it isn't approved any more (its pass stale, or a decision since). */
  | { state: 'left'; why: 'stale' | 'decision' }
  /** Approved, but its pass is stale (HI-1763): its line moved on since (`approved` what was passed, `current` its line). */
  | { state: 'stale'; approved: string | null; current: string | null }
  | { state: 'merged' }
  /** Not in the queue yet: it goes in once approved. */
  | { state: 'notYet' }

/** The card's queue state when its own ruleset says Combwork merges it, else null (the agent merges, or nobody checks). */
export function queueStateOf(wf: Workflow, card: CardRecord, s: CardState = wf.state(card)): QueueState | null {
  if (wf.rulesetOf(card, s).options.finish !== 'combworkMerges') return null
  if (s.stage === 'done') return { state: 'merged' }
  const open = openEntry(s)
  if (open) {
    const order = queueOrder(wf, open.target)
    // The one testing now finishes its step even with the queue paused.
    if (order.testing?.entry === open.id) return { state: 'testing', target: open.target, step: order.testing.step }
    // HI-2709: blocked by cards that aren't Done: it waits for them, whatever the queue is doing.
    const on = open.state === 'open' ? wf.queueWaitingOn(card.id) : []
    if (on.length) return { state: 'waiting', target: open.target, on }
    const pause = wf.store.queuePause(open.target) as { reason: PauseReason; card: string; stuck?: unknown } | null
    if (pause) return { state: 'paused', target: open.target, reason: pause.reason, card: pause.card, ...(pause.stuck ? { stuck: true as const } : {}), ...(publishAnswered(wf, pause) ? { answered: true as const } : {}) }
    return { state: 'queued', target: open.target, position: order.queued.findIndex((q) => q.entry === open.id) + 1 }
  }
  // Approved with a stale pass, never queued (HI-1763: HI-1737 sat so, its lane paused, nobody told): said, with what to do.
  if (s.stage === 'approved' && s.stale) return { state: 'stale', approved: s.stale.approved, current: s.stale.current }
  const last = s.entries.at(-1)
  if (last?.state === 'failed' && last.failure && (s.stage === 'active' || s.stage === 'todo')) {
    const about = returnedAbout(s)
    return { state: 'returned', reason: last.failure.reason, transient: last.failure.transient, failure: last.failure, ...(about ? { about } : {}) }
  }
  if (last?.state === 'cancelled' && (last.cancelled === 'stale' || last.cancelled === 'decision') && s.stage !== 'merging') return { state: 'left', why: last.cancelled }
  return { state: 'notYet' }
}

/** What runs a target's queue in this Combwork now (queueHost's queueLive): whether it runs, and its entry at its step. */
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
 * A target's queue in order (#1353's model, shared with #1354's card states). Testing now: this Combwork's entry at its
 * step; else an advance begun (its recovery finishes it), or, when another Combwork runs the queue, its first entry (its
 * step isn't known here).
 */
export function queueOrder(wf: Workflow, target: string, live: QueueLive = wf.queueLive(target), openCards?: ReadonlyMap<number, CardRecord>): QueueOrder {
  const store = wf.store
  // HI-3169: a Done card holds no open entry (merged, or moved there, which cancels it: queueStateOf), so only the cards
  // not Done are read and folded, all in one read (`openCards`: a listing's, read once for all its targets): the target's
  // history, all Done, costs nothing here.
  const notDone = openCards ?? new Map(store.cardsOpen().map((c) => [c.id, c]))
  const states = new Map<number, { card: CardRecord; s: CardState }>()
  const of = (id: number): { card: CardRecord; s: CardState } => {
    let x = states.get(id)
    if (!x) {
      const card = notDone.get(id) ?? store.card(id)
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
    if (!notDone.has(f.card)) continue
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
    // Another Combwork's run: its first entry that isn't waiting for a blocker (HI-2709: the queue goes on without those).
    // HI-3091: a begun entry the queue is paused on isn't being merged (an unknown publication waiting for the user's
    // answer, an interrupted advance): it is shown with the pause, never as "moving the target to its merge now".
    const pausedOn = store.queuePause(target)?.card ?? null
    const begun = open.find((o) => o.state === 'started' && o.card.key !== pausedOn) ?? (store.queueLease(target) && !live.running ? open.find((o) => o.card.key !== pausedOn && !wf.queueWaitingOn(o.card.id).length) : undefined)
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
      // HI-2709: what it waits for, as the board is now (a dependency's edit shows at once); still in the list, in its place.
      const on = o.state === 'open' ? wf.queueWaitingOn(o.card.id) : []
      const fw = of(o.card.id).s.forward
      return { ...named(o.card), entry: d.entry, revision: d.revision, at: o.f.at, ...(on.length ? { waitingOn: on } : {}), ...(fw ? { forward: { from: fw.from, to: fw.to } } : {}) }
    })
  return { open, entries, cards, testing, queued }
}

/**
 * What a paused queue waits for (#1406), by its pause as the queue saved it (read only): the user's answer in For you
 * (the question to update a checked-out target now, which Resume doesn't stand in for; a stuck advance's Decide, or
 * Resume once settled), a step that needs the user fixed and Resume (a needs-you pause with no question: git's error, an
 * earlier runner's process), the folder its target is checked out in put right (Resume checks it first), or the rules
 * enforced again (Combwork resumes it then: queueHost's startOpen); anything else, the user's Resume.
 */
export type PauseWait = 'resume' | 'answer' | 'fix' | 'folder' | 'rules'

export function pauseWait(reason: PauseReason, stuck = false): PauseWait {
  switch (reason) {
    case 'approval':
    case 'mergeChoice':
    // G21 (HI-1183): an unknown publication waits for the user's answer (Resume only looks at the remote again).
    case 'publishUnknown':
      return 'answer'
    case 'needsYou':
      return stuck ? 'answer' : 'fix'
    case 'subfolderTarget':
    // G18 (#1179): the push after a merge, put right (a pull, a sign-in, a remote) or the option turned off, then Resume.
    case 'pushRejected':
    case 'pushFailed':
    case 'pushNoRemote':
    case 'pushUnreadable':
    // HI-1183: the remote's refusal, and follow mode's remote put right (what it tracks, its address, a sign-in, a pull).
    case 'pushRefused':
    case 'publishRefused':
    case 'publishFailed':
    case 'noUpstream':
    case 'remoteAmbiguous':
    case 'remoteUnsupported':
    case 'fetchFailed':
    case 'remoteDiverged':
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

/**
 * HI-3091: a pause on an unknown publication whose For you question is closed (the user answered it): the card it paused
 * on has no open publish question. Any other pause: false.
 */
function publishAnswered(wf: Workflow, pause: { reason: PauseReason; card: string }): boolean {
  if (pause.reason !== 'publishUnknown') return false
  const on = wf.store.cardByKey(pause.card)
  return !!on && !wf.state(on).requests.some((r) => r.gate === QUEUE_PUBLISH_GATE)
}

/** A paused queue's "it moves on once …" for agents: what the pause waits for, never a step of the agent's own. */
function pausedWaits(q: Extract<QueueState, { state: 'paused' }>): string {
  switch (pauseWait(q.reason, q.stuck)) {
    case 'answer':
      return q.reason === 'approval' ? say(Q.waitsApproval, { target: q.target }) : q.reason === 'mergeChoice' ? say(Q.waitsMergeChoice) : q.reason === 'publishUnknown' ? say(q.answered ? Q.waitsPublishAnswered : Q.waitsPublish) : say(Q.waitsStuck)
    case 'fix':
      return say(Q.waitsFix)
    case 'folder':
      return say(Q.waitsFolder, { target: q.target })
    case 'rules':
      return say(Q.waitsRules)
    case 'resume':
      return say(Q.waitsResume)
  }
}

/**
 * The card's queue state in a sentence for agents (English: agent-facing). `enforced` false (Settings → Advanced:
 * workflow rules not enforced): nothing refuses, so the agent merges and reports as before 1.0.
 */
export function queueLine(q: QueueState, enforced = true): string {
  if (!enforced) return say(Q.unenforced)
  const who = say(Q.who)
  switch (q.state) {
    case 'queued':
      return say(Q.queued, { who, target: q.target, position: q.position })
    case 'waiting':
      return say(Q.waiting, { who, target: q.target, cards: q.on.join(', ') })
    case 'testing':
      return say(Q.testing, { who, target: q.target, step: q.step === 'advance' || q.step === 'checks' ? q.step : 'other' })
    case 'paused':
      return say(Q.paused, { who, target: q.target, reason: q.reason, card: q.card, waits: pausedWaits(q) })
    case 'returned':
      return say(Q.returned, { who, returned: returnedText(say(Q.subjectIt), q.failure, READ_MAX, READ_LINES, q.about) })
    case 'left':
      return say(Q.left, { who, why: q.why })
    case 'stale':
      return say(Q.stale, { who, approved: shortRev(q.approved), current: shortRev(q.current) })
    case 'merged':
      return say(Q.merged)
    case 'notYet':
      return say(Q.notYet, { who })
  }
}

/** What a returned card's wake says of it, at most (watch.ts's room for Combwork's own note in a wake line). */
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
    if (say(Q.more, { files: [...shown, f].join(', '), n: files.length - shown.length - 1 }).length > room) break
    shown.push(f)
  }
  return shown.length ? say(Q.more, { files: shown.join(', '), n: files.length - shown.length }) : say(Q.filesCount, { n: files.length })
}

/** A message's length with `value` left empty: the room its own words take, so what it frames is fitted to the rest. */
const frame = (m: Parameters<typeof say>[0], values: Record<string, string | number>, value: string): number => say(m, { ...values, [value]: '' }).length

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
function failureText(f: FactData['IntegrationFailed'], room: number, about?: ReturnedForward): string {
  switch (f.reason) {
    case 'conflict': {
      const head = say(Q.conflict, { target: f.target })
      return f.files?.length ? say(Q.failureIn, { head, files: placedFiles(f, room - frame(Q.failureIn, { head }, 'files')) }) : head
    }
    case 'checks': {
      const what = f.check === 'install' ? say(Q.checkInstall) : f.check ? say(Q.checkNamed, { check: f.check }) : say(Q.checkSome)
      return f.transient ? say(Q.checkEnv, { what, cause: f.cause ?? say(Q.temporary), code: f.code ? `: ${f.code}` : '' }) : say(Q.checkFailed, { what })
    }
    case 'hook':
      return say(Q.hook)
    case 'targetMoved':
      return say(Q.targetMoved, { target: f.target })
    case 'pushRefused':
      return say(Q.pushRefused, { target: f.target })
    case 'notPublished':
      return say(Q.notPublished, { target: f.target })
    case 'direction':
      if (about?.resolution) return say(Q.directionResolution, { forward: clip(about.resolution, NAME_MAX), from: clip(about.from, NAME_MAX), to: clip(about.to, NAME_MAX) })
      return say(Q.direction, { target: f.target })
    case 'resolution':
      return say(Q.resolution, { forward: clip(about?.resolution ?? '?', NAME_MAX), source: about?.source ?? '?' })
    case 'folderBusy':
      return say(Q.folderBusy, { target: f.target })
    case 'notUpToDate': {
      // Strict's update conflicted (HI-1181 round 1): its files and where, as a conflict's are; else as before.
      const head = say(Q.notUpToDate, { target: f.target })
      if (!f.files?.length) return head
      return say(Q.notUpToDateFiles, { head, files: placedFiles(f, room - frame(Q.notUpToDateFiles, { head }, 'files')) })
    }
    case 'focused': {
      // G20 (HI-1367): what stopped its focused tests, with the tests or paths named (as many as fit).
      const q = f.focused
      const named = (xs: string[] | undefined, m: Parameters<typeof say>[0], value: string): string => say(m, { [value]: xs?.length ? listed(xs, room - frame(m, {}, value)) : '' })
      if (q?.why === 'repick') return named(q.paths, Q.repick, 'paths')
      if (q?.why === 'noProof') return named(q.tests, Q.noProof, 'tests')
      if (q?.why === 'newProof') return named(q.tests, Q.newProof, 'tests')
      if (q?.why === 'noRunner') return say(Q.noRunner)
      return say(Q.noneChosen)
    }
  }
}

/**
 * HI-2959: a forward merge's branches, for what its return says to do next. HI-2998: `resolution`, the forward's key when
 * the card is its resolution (Resolve on a builder: its builder's card), not the forward itself.
 */
export interface ReturnedForward {
  from: string
  to: string
  resolution?: string
  /** HI-2999: with `resolution`, the commit it resolves. */
  source?: string
}

/** What a card's return is about (HI-2959, HI-2998): its forward merge, or the forward it resolves; else none. */
export function returnedAbout(s: CardState): ReturnedForward | undefined {
  if (s.forward) return { from: s.forward.from, to: s.forward.to }
  if (s.resolves) return { from: s.resolves.from, to: s.resolves.to, resolution: s.resolves.forward, source: s.resolves.source }
  return undefined
}

/** What to do next: a transient failure is the same revision submitted again; anything else a fix. */
function nextStep(f: FactData['IntegrationFailed'], forward?: ReturnedForward): string {
  // HI-2998: a resolution returned for its direction: its builder can't change that, the user decides.
  if (forward?.resolution) {
    if (f.reason === 'direction') return say(Q.nextDirectionResolution, { from: clip(forward.from, NAME_MAX), to: clip(forward.to, NAME_MAX) })
    if (f.reason === 'resolution') return say(Q.nextResolution, { source: forward.source ?? '?' })
    forward = undefined
  }
  // HI-2959: a forward merge's choices are the user's or the Assistant's, never a builder's (it has none).
  if (forward && f.reason !== 'direction') return say(Q.nextForward, { from: clip(forward.from, NAME_MAX), to: clip(forward.to, NAME_MAX) })
  if (f.reason === 'focused') {
    if (f.focused?.why === 'noProof' || f.focused?.why === 'newProof') return say(Q.nextProof)
    if (f.focused?.why === 'noRunner') return say(Q.nextRunner)
    return say(Q.nextRepick)
  }
  if (f.reason === 'direction') return say(Q.nextDirection)
  if (f.transient) return say(Q.nextTransient)
  // HI-3127: under follow mode, the remote's head it was tested on, when the local target hasn't it: named, as it is kept.
  const remote = f.onto && f.remote ? { target: f.target, remote: f.remote, commit: f.onto } : null
  if (f.reason === 'conflict' || (f.reason === 'notUpToDate' && remote)) return remote ? say(Q.nextConflictRemote, remote) : say(Q.nextConflict, { target: f.target })
  return remote ? say(Q.nextFixRemote, remote) : say(Q.nextFix)
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
export function returnedText(subject: string, f: FactData['IntegrationFailed'], max = WAKE_NOTE_MAX, lines = WAKE_LINES, forward?: ReturnedForward): string {
  const named: FactData['IntegrationFailed'] = { ...f, target: clip(f.target, NAME_MAX), ...(f.check ? { check: clip(f.check, NAME_MAX) } : {}), ...(f.code ? { code: clip(f.code, NAME_MAX) } : {}) }
  const lead = { subject: clip(subject, NAME_MAX), cameBack: CAME_BACK }
  const next = ` ${nextStep(named, forward)}`
  // The reason and the next step are fixed; the files take what's left, keeping LINES_MIN for the rest.
  const fixed = frame(Q.lead, lead, 'failure') + next.length
  const head = say(Q.lead, { ...lead, failure: failureText(named, max - fixed - LINES_MIN, forward) })
  let room = max - head.length - next.length
  let path = ''
  if (f.logPath) {
    const whole = ` ${say(Q.log, { path: f.logPath })}`
    const pointer = ` ${say(Q.logPointer)}`
    path = whole.length <= room ? whole : pointer.length <= room ? pointer : ''
    room -= path.length
  }
  const tail = f.log ? lastLines(f.log, lines) : ''
  const fit = room - ' '.length - frame(Q.lastLines, {}, 'lines')
  const shown = tail && fit >= LINES_MIN ? (tail.length > fit ? `…${tail.slice(tail.length - fit + 1)}` : tail) : ''
  return `${head}${path}${shown ? ` ${say(Q.lastLines, { lines: shown })}` : ''}${next}`
}

/** A revision as a wake or a line names it: its first 7 characters ("—" when there is none). */
const shortRev = (r: string | null | undefined): string => (r ? r.slice(0, 7) : '—')

/**
 * A pass gone stale (HI-1763): what it was for, where the card's line is now, and what to do (its builder's wake, at
 * once: HI-1737 sat in Approved, nobody told).
 */
export const staleWake = (key: string, approved: string | null | undefined, current: string | null | undefined): string => say(Q.staleWake, { card: key, approved: shortRev(approved), current: shortRev(current) })

/** A returned card's wake (#1354): its key, what came back, and what to do next. */
export const returnedWake = (key: string, f: FactData['IntegrationFailed'], forward?: ReturnedForward): string => returnedText(key, f, WAKE_NOTE_MAX, WAKE_LINES, forward)

/** How many characters a resubmitted card's wake gives what came back (its files): see resubmittedText. */
const RESUBMITTED_ROOM = 200

/**
 * HI-2143: a card its builder submitted again after the merge queue returned it, for its reviewer: that it is back, what
 * came back (the files of a conflict, in RESUBMITTED_ROOM characters: the wake line's bytes keep its end whole, in any
 * script), who submitted it again and what to review. One sentence (agent-facing, English).
 */
export function resubmittedText(key: string, f: FactData['IntegrationFailed'], builder: string, about?: ReturnedForward): string {
  const named: FactData['IntegrationFailed'] = { ...f, target: clip(f.target, NAME_MAX), ...(f.check ? { check: clip(f.check, NAME_MAX) } : {}), ...(f.code ? { code: clip(f.code, NAME_MAX) } : {}) }
  const conflict = f.reason === 'conflict' || (f.reason === 'notUpToDate' && !!f.files?.length)
  return say(Q.resubmitted, { card: clip(key, NAME_MAX), failure: failureText(named, RESUBMITTED_ROOM, about), builder: clip(builder, NAME_MAX), conflict: conflict ? 'yes' : 'no' })
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
export function returnedComment(key: string, f: FactData['IntegrationFailed'], forward?: ReturnedForward): { text: string; shown: StoredText } {
  const reason = f.reason === 'checks' ? (f.check === 'install' ? 'install' : f.transient ? 'checksEnv' : f.check ? 'checks' : 'checksSome') : f.reason
  const files = f.files?.length ? `${f.files.slice(0, COMMENT_FILES).join(', ')}${f.files.length > COMMENT_FILES ? ', …' : ''}` : 'none'
  // Stored in the Default, for any reader; what it is said from is kept beside it, so a reader's dialect says it again
  // when it is read (storedForAgents, HI-2440).
  // Of its log, only the lines the comment quotes (lastLines reads the same from them): a comment stays small.
  const kept: FactData['IntegrationFailed'] = f.log ? { ...f, log: f.log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-COMMENT_LINES).join('\n') } : f
  const agent = { render: RETURNED_COMMENT, data: { key, failure: kept, ...(forward ? { forward: { from: forward.from, to: forward.to, ...(forward.resolution ? { resolution: forward.resolution } : {}), ...(forward.source ? { source: forward.source } : {}) } } : {}) } }
  return { text: inDefaultDialect(() => returnedCommentFrom(agent.data)!), shown: { ...storedText(HISTORY.queueReturned, { reason, target: f.target, check: f.check ?? '', files }), agent } }
}

/** The return comment's renderer, by the name its stored data keeps (HI-2440). */
export const RETURNED_COMMENT = 'queue.returned'

/** A return comment's English from its stored data, in the current chain; null for data that isn't one. */
export function returnedCommentFrom(data: unknown): string | null {
  const d = data as { key?: unknown; failure?: unknown; forward?: unknown } | null
  if (!d || typeof d.key !== 'string' || !d.failure || typeof d.failure !== 'object') return null
  const fw = d.forward as { from?: unknown; to?: unknown; resolution?: unknown; source?: unknown } | null | undefined
  const forward = fw && typeof fw.from === 'string' && typeof fw.to === 'string' ? { from: fw.from, to: fw.to, ...(typeof fw.resolution === 'string' ? { resolution: fw.resolution } : {}), ...(typeof fw.source === 'string' ? { source: fw.source } : {}) } : undefined
  try {
    return returnedText(d.key, d.failure as FactData['IntegrationFailed'], COMMENT_MAX, COMMENT_LINES, forward)
  } catch {
    return null
  }
}

/** A card that left the queue, not approved any more (#1354): why, and what to do next (`to`: where it went). */
export function leftWake(key: string, why: 'stale' | 'decision', to: 'review' | 'active'): string {
  if (why === 'decision') return say(Q.leftDecision, { card: key, to })
  return say(Q.leftStale, { card: key })
}
