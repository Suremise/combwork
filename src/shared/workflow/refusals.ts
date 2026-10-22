// Refusals as instructions (SPEC §16.8.3): every refusal names the rule, what happened, the exact next step possible
// under the card's ruleset, and where the rule is changed. Three whole sentences, each its own message, never glued from
// pieces; agents get them in English (`refusal`), the window shows them translated (`refusalLines`), each a line.

import { englishText } from '../advanced'
import { msg, type Msg } from '../i18n/msg'
import type { StoredText } from '../types'
import type { GuardId } from './pieces'
import { MOVE_NAMES, RULE_NAMES, STAGE_NAME, workflowLine } from './texts'

/** Refusals that aren't a guard of the piece library: the move itself, card references, facts that couldn't be read. */
export type MoveRule = 'move.notFromHere' | 'move.noStage' | 'move.useIntent' | 'move.needsOverride' | 'lane.oneAtATime' | 'lane.lineBehind' | 'card.plainNumber' | 'platform.unknown' | 'review.noSubmission' | 'submit.empty' | 'submit.sameRevisionNote' | 'check.revisionMismatch' | 'evidence.changed' | 'loop.roundLimit' | 'merge.hiveMerges'

export type RuleId = GuardId | MoveRule

interface RefusalText {
  message: Msg
  next: Msg
  change: Msg | null
}

const r = (message: Msg, next: Msg, change: Msg | null = null): RefusalText => ({ message, next, change })

/** The three sentences of each rule. Placeholders: {card} the card's key, {revision} a short revision, and per rule. */
export const REFUSALS: Record<RuleId, RefusalText> = {
  'start.notBlocked': r(
    msg({ id: 'workflow.refused.start.notBlocked.message', defaultMessage: "{card} can't start: it is blocked ({reason}).", description: 'A refused start of a card. {card} is a card key like AM-12; {reason} is why the card is blocked, in the words given.' }),
    msg({ id: 'workflow.refused.start.notBlocked.next', defaultMessage: 'Wait for it to be unblocked, or work on another card.', description: 'The next step after a refused start of a blocked card.' }),
    msg({ id: 'workflow.refused.start.notBlocked.change', defaultMessage: 'This rule is set in Version Control → Cards start only when the cards they wait for are done.', description: 'Where the rule that refused starting a blocked card is changed.' })
  ),
  'start.dependenciesIntegrated': r(
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.message', defaultMessage: "{card} can't start: {waitsFor} isn't done yet.", description: "A refused start of a card. {card} and {waitsFor} are card keys (AM-12): the card waits for {waitsFor}'s work to be merged or accepted." }),
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.next', defaultMessage: 'Wait for {waitsFor} to be done, or work on another card.', description: 'The next step after a refused start: {waitsFor} is the card key it waits for.' }),
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.change', defaultMessage: 'This rule is set in Version Control → Cards start only when the cards they wait for are merged.', description: 'Where the rule that refused starting a card before the cards it waits for are done is changed.' })
  ),
  'start.slotAvailable': r(
    msg({ id: 'workflow.refused.start.slotAvailable.message', defaultMessage: "{card} can't start: no slot is free.", description: 'A refused start: every working folder (slot) is lent to other work. {card} is a card key.' }),
    msg({ id: 'workflow.refused.start.slotAvailable.next', defaultMessage: 'Wait for a slot to be free.', description: 'The next step after a refused start for want of a slot.' }),
    msg({ id: 'workflow.refused.start.slotAvailable.change', defaultMessage: 'This is set in Version Control → Where cards are built.', description: 'Where the rule that refused starting for want of a slot is changed.' })
  ),
  'submit.notDuplicate': r(
    msg({ id: 'workflow.refused.submit.notDuplicate.message', defaultMessage: '{card} is already submitted at {revision} and waits for review or merging.', description: 'A refused submit: the same revision is already waiting. {card} is a card key, {revision} a short revision id.' }),
    msg({ id: 'workflow.refused.submit.notDuplicate.next', defaultMessage: 'Wait for its review or merge.', description: 'The next step after a refused duplicate submission.' })
  ),
  'requeue.allowed': r(
    msg({ id: 'workflow.refused.requeue.allowed.message', defaultMessage: "{card} at {revision} can't go back into the merge queue unchanged: {why}", description: 'A refused resubmission into the merge queue. {card} is a card key, {revision} a short revision id, {why} one of the requeue reasons below, a whole sentence.' }),
    msg({ id: 'workflow.refused.requeue.allowed.next', defaultMessage: 'Fix the failure, commit and submit the new revision.', description: 'The next step after a refused unchanged requeue.' }),
    msg({ id: 'workflow.refused.requeue.allowed.change', defaultMessage: 'Retry merge on the merge queue retries it once.', description: 'Who can override a refused requeue: the user, with Retry merge on the merge queue (glossary 2.5: merge queue).' })
  ),
  'submit.ready': r(
    msg({ id: 'workflow.refused.submit.ready.message', defaultMessage: '{card} at {revision} has unresolved conflicts: {files}.', description: 'A refused submit: the revision stores conflicts. {files} lists file paths.' }),
    msg({ id: 'workflow.refused.submit.ready.next', defaultMessage: 'Resolve the conflicts, then submit again.', description: 'The next step after a refused submit of a conflicted revision.' })
  ),
  'submit.clean': r(
    msg({ id: 'workflow.refused.submit.clean.message', defaultMessage: "{card} can't go to review: {folder} has uncommitted changes ({files}).", description: 'A refused submit: the working folder has uncommitted changes. {folder} is a folder path, {files} a list of file paths.' }),
    msg({ id: 'workflow.refused.submit.clean.next', defaultMessage: 'Commit your changes (or remove them), then submit again.', description: 'The next step after a refused submit with uncommitted changes.' }),
    msg({ id: 'workflow.refused.submit.clean.change', defaultMessage: 'This rule comes with review and merging in Version Control.', description: 'Where the rule that refused a submit with uncommitted changes comes from.' })
  ),
  'submit.trailer': r(
    msg({ id: 'workflow.refused.submit.trailer.message', defaultMessage: "{card}: commit {commit} has no card trailer, and another card's agent works in this folder.", description: 'A refused submit in a shared folder: a commit lacks the Hive-Card trailer. {commit} is a short commit id.' }),
    msg({ id: 'workflow.refused.submit.trailer.next', defaultMessage: 'Run {command}, then submit again.', description: 'The next step after a refused submit for a missing trailer: {command} is the git command to run.' }),
    msg({ id: 'workflow.refused.submit.trailer.change', defaultMessage: 'Each card in its own folder needs no trailers: Version Control → Where cards are built.', description: 'Where the setting that needs commit trailers is changed.' })
  ),
  'submit.checksPassed': r(
    msg({ id: 'workflow.refused.submit.checksPassed.message', defaultMessage: "Review refused: {check} hasn't passed on {revision}.", description: 'A refused submit: a configured check has no passing counted run on the revision. {check} is the check name, {revision} a short revision id.' }),
    msg({ id: 'workflow.refused.submit.checksPassed.next', defaultMessage: 'Run {command}, then submit again.', description: 'The next step after a refused submit for a missing check: {command} is the command to run.' }),
    msg({ id: 'workflow.refused.submit.checksPassed.change', defaultMessage: 'This rule is set in Version Control → Checks pass before review.', description: 'Where the rule that refused a submit for a missing check is changed.' })
  ),
  'submit.identity': r(
    msg({ id: 'workflow.refused.submit.identity.message', defaultMessage: "{card}: commit {commit} isn't authored with the project's identity ({email}).", description: "A refused submit: a commit's author email isn't the project's. {email} is the project's email address." }),
    msg({ id: 'workflow.refused.submit.identity.next', defaultMessage: 'Set the identity, run {command}, then submit again.', description: "The next step after a refused submit for a commit's identity: {command} is the git command to fix it." }),
    msg({ id: 'workflow.refused.submit.identity.change', defaultMessage: "This rule is set in Version Control → Commits use the project's identity.", description: 'Where the identity rule is changed.' })
  ),
  'submit.ownRunsStopped': r(
    msg({ id: 'workflow.refused.submit.ownRunsStopped.message', defaultMessage: '{card}: runs you started are still going ({runs}).', description: 'A refused submit: the agent still has runs going. {runs} lists their titles.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.next', defaultMessage: 'Stop them or let them finish, then submit again.', description: 'The next step after a refused submit while runs are going.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.change', defaultMessage: 'This rule is set in Version Control → Agents stop what they started before review.', description: 'Where the rule about stopping runs before review is changed.' })
  ),
  'submit.decisionsReceived': r(
    msg({ id: 'workflow.refused.submit.decisionsReceived.message', defaultMessage: "{card} has a decision you haven't read.", description: 'A refused submit: the card has a newer decision than the builder has received.' }),
    msg({ id: 'workflow.refused.submit.decisionsReceived.next', defaultMessage: 'Read it, check your work against it, then submit.', description: 'The next step after a refused submit for an unread decision.' })
  ),
  'review.notAuthor': r(
    msg({ id: 'workflow.refused.review.notAuthor.message', defaultMessage: "You worked on {card}, so you can't review it.", description: 'A refused review: the reviewer is one of the agents who built the card.' }),
    msg({ id: 'workflow.refused.review.notAuthor.next', defaultMessage: 'Leave the review to another reviewer.', description: 'The next step after a refused self-review.' }),
    msg({ id: 'workflow.refused.review.notAuthor.change', defaultMessage: 'Only Move anyway, on the card, skips this rule.', description: 'Who can override the no-self-review rule: only the user, moving the card anyway (glossary 2.4: override, Move anyway).' })
  ),
  'review.decisionsReceived': r(
    msg({ id: 'workflow.refused.review.decisionsReceived.message', defaultMessage: "{card} has a decision you haven't read.", description: 'A refused review or verdict: the card has a newer decision than the reviewer has received.' }),
    msg({ id: 'workflow.refused.review.decisionsReceived.next', defaultMessage: 'Read it, judge whether the work meets it, then give your verdict.', description: 'The next step after a refused verdict for an unread decision.' })
  ),
  'verdict.reviewing': r(
    msg({ id: 'workflow.refused.verdict.reviewing.message', defaultMessage: "You haven't started a review of {card}'s submission {submission}.", description: 'A refused verdict: the reviewer never started reviewing that submission. {submission} is its number.' }),
    msg({ id: 'workflow.refused.verdict.reviewing.next', defaultMessage: 'Start the review first, then give your verdict.', description: 'The next step after a verdict without a started review.' })
  ),
  'verdict.currentSubmission': r(
    msg({ id: 'workflow.refused.verdict.currentSubmission.message', defaultMessage: "Submission {submission} isn't {card}'s latest.", description: 'A refused verdict: it names an older submission. {submission} is its number.' }),
    msg({ id: 'workflow.refused.verdict.currentSubmission.next', defaultMessage: 'Review the latest submission, {latest}.', description: 'The next step after a verdict on an old submission: {latest} is the latest submission number.' })
  ),
  'approval.given': r(
    msg({ id: 'workflow.refused.approval.given.message', defaultMessage: '{card} waits for the OK before merging.', description: "A refused move: the user has to approve the card first (glossary 2.3: approval; Version Control → Your OK before merging)." }),
    msg({ id: 'workflow.refused.approval.given.next', defaultMessage: 'Wait for the OK, given on the card or in For you.', description: 'The next step after a move refused for want of the user’s approval.' }),
    msg({ id: 'workflow.refused.approval.given.change', defaultMessage: 'This rule is set in Version Control → Your OK before merging.', description: "Where the rule that waits for the user's OK is changed." })
  ),
  'integrate.approved': r(
    msg({ id: 'workflow.refused.integrate.approved.message', defaultMessage: "{card} at {revision} isn't approved: {why}", description: "A refused merge: the revision lacks the passes or approvals its rules need. {why} is a whole sentence saying what's missing." }),
    msg({ id: 'workflow.refused.integrate.approved.next', defaultMessage: 'Submit it for review.', description: 'The next step after a merge refused for want of approval.' })
  ),
  'integrate.upToDate': r(
    msg({ id: 'workflow.refused.integrate.upToDate.message', defaultMessage: "{card} at {revision} doesn't contain {target}'s head.", description: 'A refused merge (strict): the revision is behind its target. {target} is a branch name.' }),
    msg({ id: 'workflow.refused.integrate.upToDate.next', defaultMessage: 'The merge queue brings it up to date itself.', description: 'What happens next after the strict up-to-date rule refuses.' }),
    msg({ id: 'workflow.refused.integrate.upToDate.change', defaultMessage: 'This rule is set in Version Control → Work is up to date before it merges.', description: 'Where the strict rule is changed.' })
  ),
  'integrate.checksPassed': r(
    msg({ id: 'workflow.refused.integrate.checksPassed.message', defaultMessage: "The merge checks failed on {card}'s merged result.", description: 'A merge returned: the merge checks failed on the test merge.' }),
    msg({ id: 'workflow.refused.integrate.checksPassed.next', defaultMessage: 'Fix the failures, commit and submit the new revision.', description: 'The next step after failed merge checks.' }),
    msg({ id: 'workflow.refused.integrate.checksPassed.change', defaultMessage: 'This rule is set in Version Control → Checks pass on the merged result.', description: 'Where the merge checks are changed.' })
  ),
  'done.contained': r(
    msg({ id: 'workflow.refused.done.contained.message', defaultMessage: "{card} at {revision} isn't in {target}.", description: 'A refused Done: the approved revision is not in the target branch. {target} is a branch name.' }),
    msg({ id: 'workflow.refused.done.contained.next', defaultMessage: 'Merge {revision} into {target}, then report the merge again.', description: 'The next step after a refused report of a merge.' }),
    msg({ id: 'workflow.refused.done.contained.change', defaultMessage: 'This rule is set in Version Control → Who merges.', description: 'Where the rule that checks a merge is changed.' })
  ),
  'merge.hiveMerges': r(
    msg({ id: 'workflow.refused.merge.hiveMerges.message', defaultMessage: "Hive merges {card}: agents don't merge it or report its merge.", description: "A refused report of a merge, or a claim of the merge slot, for a card whose rules say Hive merges it (the merge queue). {card} is a card key like AM-12." }),
    // Its next step is the card's place in the queue (QUEUE_NEXT, by its `queue` value).
    msg({ id: 'workflow.refused.merge.hiveMerges.next', defaultMessage: 'Once it is approved, the merge queue merges it and moves it to Done: wait for that, or for it to come back.', description: "The next step after a refused merge of a card Hive merges, when it isn't in the merge queue yet." }),
    msg({ id: 'workflow.refused.merge.hiveMerges.change', defaultMessage: 'This rule is set in Version Control → Who merges. A card keeps the rules it started with.', description: 'Where the rule that Hive merges cards is changed; a card keeps the rules it started under unless the change is applied to it.' })
  ),
  'move.notFromHere': r(
    msg({ id: 'workflow.refused.move.notFromHere.message', defaultMessage: "{card} is in {stage}: {move} isn't possible from there.", description: 'A refused intent: not possible from the stage the card is in. {stage} is a stage name, {move} the intent.' }),
    msg({ id: 'workflow.refused.move.notFromHere.next', defaultMessage: 'From {stage}, use: {moves}.', description: 'The next step: the intents possible from the stage. {moves} lists them.' })
  ),
  'move.noStage': r(
    msg({ id: 'workflow.refused.move.noStage.message', defaultMessage: "{card} can't go to {stage}: this project's rules have no such step.", description: 'A refused move: the card was moved to a board stage the project\'s workflow rules don\'t have (Review with no review, say). {card} is a card key, {stage} a stage name.' }),
    msg({ id: 'workflow.refused.move.noStage.next', defaultMessage: 'Move it to one of its steps: {stages}.', description: 'The next step after a move to a stage the rules lack: the stages they have. {stages} lists stage names.' }),
    msg({ id: 'workflow.refused.move.noStage.change', defaultMessage: "A project's steps follow its options in Version Control.", description: 'Where the stages a project has are set: its Version Control options (a tab name: use it as Hive shows it).' })
  ),
  'move.useIntent': r(
    msg({ id: 'workflow.refused.move.useIntent.message', defaultMessage: "Agents don't move cards between columns.", description: 'A refused column move by an agent: agents act by intent.' }),
    msg({ id: 'workflow.refused.move.useIntent.next', defaultMessage: 'Use the {intent} intent instead.', description: 'The next step after a refused column move: {intent} is the intent to use.' })
  ),
  'move.needsOverride': r(
    msg({ id: 'workflow.refused.move.needsOverride.message', defaultMessage: 'Moving {card} to {stage} skips: {rules}.', description: 'A move that skips rules: {rules} lists the rule names.' }),
    msg({ id: 'workflow.refused.move.needsOverride.next', defaultMessage: "Move it anyway only with the user's reason: one they gave for it, or one they give once told which rules this skips.", description: "The next step for a move that skips rules (said to the Hive Assistant): move anyway (an override) only with the user's own reason, given with the request or after being told which rules the move skips." }),
    msg({ id: 'workflow.refused.move.needsOverride.change', defaultMessage: 'These rules are set in Version Control, where the user can change them.', description: 'Where the rules a move would skip are changed: the project\'s Version Control tab (a tab name: use it as Hive shows it).' })
  ),
  'lane.lineBehind': r(
    msg({ id: 'workflow.refused.lane.lineBehind.message', defaultMessage: "{card} can't start yet: {line} still has {earlier}'s work, which was squashed into {target}.", description: "A refused start (§16.19.2): the builder's branch (in its own worktree) still has the previous card's commits, which were merged into the target as one squashed commit, so the next card's change would include them. {card} and {earlier} are card keys like AM-12; {line} a branch name; {target} the branch merged into." }),
    msg({ id: 'workflow.refused.lane.lineBehind.next', defaultMessage: 'Leave it as it is: Hive brings {line} up to date with {target} once you are idle, or asks the user, and tells you when {card} can start.', description: 'The next step after a start refused because the branch still has squashed work: wait (end the turn); Hive moves the branch, or asks the user first, and says when the card can start. {line} a branch name, {target} the branch merged into, {card} a card key.' }),
    msg({ id: 'workflow.refused.lane.lineBehind.change', defaultMessage: "Settings → Advanced → Bring an agent's branch up to date after a squash merge says whether Hive moves it or asks first.", description: 'Where it is decided whether Hive moves the branch itself or asks the user first (a setting name: use it as Hive shows it).' })
  ),
  'lane.oneAtATime': r(
    msg({ id: 'workflow.refused.lane.oneAtATime.message', defaultMessage: "{card} can't start yet: {earlier}, before it in its lane, isn't Done.", description: 'A refused start (glossary 2.4): a lane takes one card at a time, so a card starts only once the cards before it in its lane are Done. {card} and {earlier} are card keys like AM-12.' }),
    msg({ id: 'workflow.refused.lane.oneAtATime.next', defaultMessage: 'Finish {earlier} first: once it is Done, the lane goes on to {card}.', description: 'The next step after a start refused because an earlier card of the lane is not Done. {card} and {earlier} are card keys like AM-12.' }),
    msg({ id: 'workflow.refused.lane.oneAtATime.change', defaultMessage: 'A lane always takes one card at a time; turning off Settings → Advanced → Workflow rules are enforced turns every rule off.', description: 'Where the rule that a lane takes one card at a time is changed: it has no option of its own; the switch that turns every workflow rule off (a setting name: use it as Hive shows it).' })
  ),
  'card.plainNumber': r(
    msg({ id: 'workflow.refused.card.plainNumber.message', defaultMessage: 'A plain number is not a card reference.', description: 'A refused intent: the card was named by a bare number.' }),
    msg({ id: 'workflow.refused.card.plainNumber.next', defaultMessage: 'Name the card as {key} or {alias}.', description: 'The forms a card reference takes: {key} like AM-12, {alias} like #1061.' })
  ),
  'platform.unknown': r(
    msg({ id: 'workflow.refused.platform.unknown.message', defaultMessage: "{card}: Hive couldn't read {what}, so the rule {rule} can't be checked.", description: 'A refused move: a fact a rule needs could not be read (git missing, folder gone). {what} says what, {rule} the rule id.' }),
    msg({ id: 'workflow.refused.platform.unknown.next', defaultMessage: 'Check Agent Setup or the folder, then try again.', description: 'The next step when Hive could not read what a rule needs.' })
  ),
  'loop.roundLimit': r(
    msg({ id: 'workflow.refused.loop.roundLimit.message', defaultMessage: '{card} reached its round limit: it goes on once its round-limit question is answered.', description: "A refused submission or move: the card failed as many reviews as its card loop allows (Settings → Card loops), and Hive asked how to go on (For you); until that question is answered, its loop is paused. Read by agents and shown in the window alike: it names no one (never \"the user\"). {card} is a card key." }),
    msg({ id: 'workflow.refused.loop.roundLimit.next', defaultMessage: 'The question is on the card (For you): once it is answered, Hive wakes the agents waiting on it.', description: "The next step while a card waits at its round limit for its question (For you, a label: use it as Hive shows it) to be answered. Read by agents and shown in the window alike: it names no one (never \"the user\"); Hive then wakes the agents that wait on the card." })
  ),
  'review.noSubmission': r(
    msg({ id: 'workflow.refused.review.noSubmission.message', defaultMessage: '{card} has nothing submitted to review.', description: 'A refused review: the card has no submission.' }),
    msg({ id: 'workflow.refused.review.noSubmission.next', defaultMessage: 'Wait for its builder to submit it.', description: 'The next step when there is nothing to review.' })
  ),
  'submit.empty': r(
    msg({ id: 'workflow.refused.submit.empty.message', defaultMessage: '{card} has no change to review.', description: 'A refused submit: the change from the base is empty.' }),
    msg({ id: 'workflow.refused.submit.empty.next', defaultMessage: 'Commit the work, then submit.', description: 'The next step after submitting an empty change.' })
  ),
  'submit.sameRevisionNote': r(
    msg({ id: 'workflow.refused.submit.sameRevisionNote.message', defaultMessage: '{revision} was already reviewed.', description: 'A refused submit: the same revision again without a note.' }),
    msg({ id: 'workflow.refused.submit.sameRevisionNote.next', defaultMessage: 'Submit it again with a note saying what changed in your answer, or commit a new revision.', description: 'The next step when submitting a reviewed revision again.' })
  ),
  'evidence.changed': r(
    msg({ id: 'workflow.refused.evidence.changed.message', defaultMessage: 'What Hive read for {card} changed while it decided.', description: "A refused intent: a branch head, a file or another card the rule depends on changed between Hive's reading it and recording the move. {card} is a card key." }),
    msg({ id: 'workflow.refused.evidence.changed.next', defaultMessage: 'Try again: Hive reads it afresh.', description: 'The next step after a refusal because what a rule read changed meanwhile.' })
  ),
  'check.revisionMismatch': r(
    msg({ id: 'workflow.refused.check.revisionMismatch.message', defaultMessage: "{revision} isn't what's checked out here.", description: 'A refused check run: the revision named is not the checked-out one.' }),
    msg({ id: 'workflow.refused.check.revisionMismatch.next', defaultMessage: 'Run the check where {revision} is checked out, or without a revision.', description: 'The next step after a check run named the wrong revision.' })
  )
}

/** The {why} sentences of refusals that have several reasons. */
export const WHY = {
  requeueNotTransient: msg({ id: 'workflow.refused.why.requeueNotTransient', defaultMessage: 'its last merge failed for a reason in the work (a conflict, red checks or a hook), which needs a new revision.', description: "The {why} of a refused requeue: the merge failure wasn't transient. Starts lower case: it follows a colon." }),
  requeueLimit: msg({ id: 'workflow.refused.why.requeueLimit', defaultMessage: 'it was sent back unchanged {n, plural, one {# time} other {# times}} already.', description: 'The {why} of a refused requeue: the limit of unchanged requeues was reached. {n} is how many.' }),
  stale: msg({ id: 'workflow.refused.why.stale', defaultMessage: 'its pass is stale.', description: "The {why} of a refused merge or requeue: the revision's pass no longer holds." }),
  passes: msg({ id: 'workflow.refused.why.passes', defaultMessage: '{n, number} of {q, plural, one {# reviewer} other {# reviewers}} passed it.', description: 'The {why} of a refused merge: not enough distinct reviewers passed the revision. {n} and {q} are numbers.' }),
  userOk: msg({ id: 'workflow.refused.why.userOk', defaultMessage: "it waits for the OK before merging.", description: "The {why} of a refused merge: the user's approval is missing." })
} satisfies Record<string, Msg>

/**
 * The next step of `merge.hiveMerges` by the card's place in the merge queue (its `queue` value: queueState.ts's state);
 * one not listed (not queued yet, or left it) is the rule's own next.
 */
export const QUEUE_NEXT = {
  queued: msg({ id: 'workflow.refused.merge.hiveMerges.nextQueued', defaultMessage: 'It is in the merge queue for {target} (position {n, number}) and moves to Done once merged: wait for that, or for it to come back.', description: 'The next step after a refused merge of a card Hive merges, waiting in the merge queue. {target} is a branch name; {n} its place in the queue (1 is next).' }),
  testing: msg({ id: 'workflow.refused.merge.hiveMerges.nextTesting', defaultMessage: 'The merge queue is merging it into {target} now and moves it to Done once merged: wait for that, or for it to come back.', description: 'The next step after a refused merge of a card the merge queue is testing or merging now. {target} is a branch name.' }),
  paused: msg({ id: 'workflow.refused.merge.hiveMerges.nextPaused', defaultMessage: 'It is in the merge queue for {target}, which is paused until it is resumed: wait for Done, or for it to come back.', description: "The next step after a refused merge of a card in a paused merge queue. {target} is a branch name." }),
  returned: msg({ id: 'workflow.refused.merge.hiveMerges.nextReturned', defaultMessage: 'It came back from the merge queue: fix it in your worktree, commit and submit again.', description: 'The next step after a refused merge of a card the merge queue returned to its builder (a conflict, failed checks, a hook).' }),
  merged: msg({ id: 'workflow.refused.merge.hiveMerges.nextMerged', defaultMessage: 'The merge queue has merged it already: nothing is left to do.', description: 'The next step after a refused merge of a card Hive has already merged.' })
} satisfies Record<string, Msg>

/** The next step of `move.notFromHere` when nothing can be done from the stage (a request answered meanwhile). */
export const NOTHING_FROM_HERE = msg({ id: 'workflow.refused.move.notFromHere.nextNone', defaultMessage: 'Nothing waits to be done there now.', description: "The next step after a refused move when nothing is possible from the card's stage (the request it answered is no longer open)." })

/**
 * A refusal's values: names and numbers, the same in every language, or a message of its own kept as data (what a
 * platform couldn't read, texts.ts). {stage}, {move}, {intent}, {moves}, {rule} and {rules} hold the code's names, which
 * agents read as they are and the window shows through texts.ts's messages.
 */
export type RefusalValues = Record<string, string | number | StoredText>

/** A refusal as the Agent API sends it (HTTP 409), in English for agents, with its rule and values for the window. */
export interface Refusal {
  refused: true
  rule: RuleId
  message: string
  next: string
  change?: string
  override: 'the user' | 'the user or the Assistant' | null
  values: RefusalValues
}

/** How a refusal's sentences are formatted: in English for agents, or in the window's language (`refusalLines`). */
export interface RefusalFormat {
  one: (m: Msg, values?: Record<string, string | number>) => string
  list: (items: string[]) => string
  /** Whether names in the code are shown through their messages (the window) or as they are (agents). */
  names: boolean
}

const IN_ENGLISH: RefusalFormat = { one: (m, values) => englishText(values ? { m, values } : m), list: (items) => items.join(', '), names: false }

/** The three sentences of a refusal, formatted by `f`: `change` null when the rule has none. */
export function refusalLines(rule: RuleId, values: RefusalValues, f: RefusalFormat): { message: string; next: string; change: string | null } {
  const t = REFUSALS[rule]
  const vals: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(values)) vals[k] = typeof v === 'object' ? (workflowLine(v, f.one) ?? '') : v
  if (f.names) {
    const name = (x: string): string => {
      const m = MOVE_NAMES[x] ?? RULE_NAMES[x]
      return m ? f.one(m) : f.one(STAGE_NAME, { stage: x })
    }
    const names = (s: string | number): string => f.list(String(s).split(', ').filter(Boolean).map(name))
    if (typeof vals.stage === 'string') vals.stage = f.one(STAGE_NAME, { stage: vals.stage })
    for (const k of ['move', 'intent', 'rule'] as const) if (typeof vals[k] === 'string') vals[k] = name(vals[k] as string)
    for (const k of ['moves', 'rules'] as const) if (vals[k] !== undefined) vals[k] = names(vals[k])
    // A list of stages (`move.noStage`'s), each by its stage name.
    if (vals.stages !== undefined) vals.stages = f.list(String(vals.stages).split(', ').filter(Boolean).map((x) => f.one(STAGE_NAME, { stage: x })))
  }
  // The {why} of a rule with several reasons is the whole sentence of its `cause`.
  if (typeof values.cause === 'string' && Object.hasOwn(WHY, values.cause)) vals.why = f.one(WHY[values.cause as keyof typeof WHY], { n: vals.n ?? 0, q: vals.q ?? 0 })
  const queued = rule === 'merge.hiveMerges' && typeof values.queue === 'string' && Object.hasOwn(QUEUE_NEXT, values.queue) ? QUEUE_NEXT[values.queue as keyof typeof QUEUE_NEXT] : null
  const next = rule === 'move.notFromHere' && !values.moves ? NOTHING_FROM_HERE : (queued ?? t.next)
  return { message: f.one(t.message, vals), next: f.one(next, vals), change: t.change ? f.one(t.change, vals) : null }
}

/** Builds a refusal from its rule and values: three English sentences, each from its own message. */
// i18n-ignore: the override field's values are agent-facing English (§16.8.3)
export function refusal(rule: RuleId, values: RefusalValues, override: Refusal['override'] = 'the user'): Refusal {
  const l = refusalLines(rule, values, IN_ENGLISH)
  return { refused: true, rule, message: l.message, next: l.next, ...(l.change !== null ? { change: l.change } : {}), override, values }
}
