// Refusals as instructions (SPEC §16.8.3): every refusal names the rule, what happened, the exact next step possible
// under the card's ruleset, and where the rule is changed. Three whole sentences, each its own message, never glued from
// pieces; agents get them in English (`englishText`), the window shows them translated.
//
// P2 spike (#1118): not wired into the app yet.

import { englishText } from '../advanced'
import { msg, type Msg, type Values } from '../i18n/msg'
import type { GuardId } from './pieces'

/** Refusals that aren't a guard of the piece library: the move itself, card references, facts that couldn't be read. */
export type MoveRule = 'move.notFromHere' | 'move.useIntent' | 'move.needsOverride' | 'card.plainNumber' | 'platform.unknown' | 'review.noSubmission' | 'submit.empty' | 'submit.sameRevisionNote' | 'check.revisionMismatch' | 'evidence.changed'

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
    msg({ id: 'workflow.refused.start.notBlocked.next', defaultMessage: 'Ask the user to unblock it, or work on another card.', description: 'The next step after a refused start of a blocked card.' }),
    msg({ id: 'workflow.refused.start.notBlocked.change', defaultMessage: 'The user can change this rule in Version Control → Cards start only when the cards they wait for are done.', description: 'Where the rule that refused starting a blocked card is changed.' })
  ),
  'start.dependenciesIntegrated': r(
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.message', defaultMessage: "{card} can't start: {waitsFor} isn't done yet.", description: "A refused start of a card. {card} and {waitsFor} are card keys (AM-12): the card waits for {waitsFor}'s work to be merged or accepted." }),
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.next', defaultMessage: 'Wait for {waitsFor} to be done, or work on another card.', description: 'The next step after a refused start: {waitsFor} is the card key it waits for.' }),
    msg({ id: 'workflow.refused.start.dependenciesIntegrated.change', defaultMessage: 'The user can change this rule in Version Control → Cards start only when the cards they wait for are merged.', description: 'Where the rule that refused starting a card before the cards it waits for are done is changed.' })
  ),
  'start.slotAvailable': r(
    msg({ id: 'workflow.refused.start.slotAvailable.message', defaultMessage: "{card} can't start: no slot is free.", description: 'A refused start: every working folder (slot) is lent to other work. {card} is a card key.' }),
    msg({ id: 'workflow.refused.start.slotAvailable.next', defaultMessage: 'Wait for a slot to be free.', description: 'The next step after a refused start for want of a slot.' }),
    msg({ id: 'workflow.refused.start.slotAvailable.change', defaultMessage: 'The user can change this in Version Control → Where cards are built.', description: 'Where the rule that refused starting for want of a slot is changed.' })
  ),
  'submit.notDuplicate': r(
    msg({ id: 'workflow.refused.submit.notDuplicate.message', defaultMessage: '{card} is already submitted at {revision} and waits for review or merging.', description: 'A refused submit: the same revision is already waiting. {card} is a card key, {revision} a short revision id.' }),
    msg({ id: 'workflow.refused.submit.notDuplicate.next', defaultMessage: 'Wait for its review or merge.', description: 'The next step after a refused duplicate submission.' })
  ),
  'requeue.allowed': r(
    msg({ id: 'workflow.refused.requeue.allowed.message', defaultMessage: "{card} at {revision} can't go back into the merge queue unchanged: {why}", description: 'A refused resubmission into the merge queue. {card} is a card key, {revision} a short revision id, {why} one of the requeue reasons below, a whole sentence.' }),
    msg({ id: 'workflow.refused.requeue.allowed.next', defaultMessage: 'Fix the failure, commit and submit the new revision.', description: 'The next step after a refused unchanged requeue.' }),
    msg({ id: 'workflow.refused.requeue.allowed.change', defaultMessage: 'The user can retry the merge once from the queue.', description: 'Who can override a refused requeue: the user, with Retry merge.' })
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
    msg({ id: 'workflow.refused.submit.checksPassed.change', defaultMessage: 'The user can change this rule in Version Control → Checks pass before review.', description: 'Where the rule that refused a submit for a missing check is changed.' })
  ),
  'submit.identity': r(
    msg({ id: 'workflow.refused.submit.identity.message', defaultMessage: "{card}: commit {commit} isn't authored with the project's identity ({email}).", description: "A refused submit: a commit's author email isn't the project's. {email} is the project's email address." }),
    msg({ id: 'workflow.refused.submit.identity.next', defaultMessage: 'Set the identity, run {command}, then submit again.', description: "The next step after a refused submit for a commit's identity: {command} is the git command to fix it." }),
    msg({ id: 'workflow.refused.submit.identity.change', defaultMessage: "The user can change this rule in Version Control → Commits use the project's identity.", description: 'Where the identity rule is changed.' })
  ),
  'submit.ownRunsStopped': r(
    msg({ id: 'workflow.refused.submit.ownRunsStopped.message', defaultMessage: '{card}: runs you started are still going ({runs}).', description: 'A refused submit: the agent still has runs going. {runs} lists their titles.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.next', defaultMessage: 'Stop them or let them finish, then submit again.', description: 'The next step after a refused submit while runs are going.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.change', defaultMessage: 'The user can change this rule in Version Control → Agents stop what they started before review.', description: 'Where the rule about stopping runs before review is changed.' })
  ),
  'submit.decisionsReceived': r(
    msg({ id: 'workflow.refused.submit.decisionsReceived.message', defaultMessage: "{card} has a decision you haven't read.", description: 'A refused submit: the card has a newer decision than the builder has received.' }),
    msg({ id: 'workflow.refused.submit.decisionsReceived.next', defaultMessage: 'Read it, check your work against it, then submit.', description: 'The next step after a refused submit for an unread decision.' })
  ),
  'review.notAuthor': r(
    msg({ id: 'workflow.refused.review.notAuthor.message', defaultMessage: "You worked on {card}, so you can't review it.", description: 'A refused review: the reviewer is one of the agents who built the card.' }),
    msg({ id: 'workflow.refused.review.notAuthor.next', defaultMessage: 'Leave the review to another reviewer.', description: 'The next step after a refused self-review.' }),
    msg({ id: 'workflow.refused.review.notAuthor.change', defaultMessage: 'Only the user can override this rule, on the card.', description: 'Who can override the no-self-review rule.' })
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
    msg({ id: 'workflow.refused.approval.given.message', defaultMessage: '{card} waits for your OK.', description: 'A refused move: the user has to approve the card first.' }),
    msg({ id: 'workflow.refused.approval.given.next', defaultMessage: 'Approve it on the card or in For you.', description: 'The next step after a move refused for want of the user’s approval.' }),
    msg({ id: 'workflow.refused.approval.given.change', defaultMessage: 'The user can change this rule in Version Control → Your OK before merging.', description: "Where the rule that waits for the user's OK is changed." })
  ),
  'integrate.approved': r(
    msg({ id: 'workflow.refused.integrate.approved.message', defaultMessage: "{card} at {revision} isn't approved: {why}", description: "A refused merge: the revision lacks the passes or approvals its rules need. {why} is a whole sentence saying what's missing." }),
    msg({ id: 'workflow.refused.integrate.approved.next', defaultMessage: 'Submit it for review.', description: 'The next step after a merge refused for want of approval.' })
  ),
  'integrate.upToDate': r(
    msg({ id: 'workflow.refused.integrate.upToDate.message', defaultMessage: "{card} at {revision} doesn't contain {target}'s head.", description: 'A refused merge (strict): the revision is behind its target. {target} is a branch name.' }),
    msg({ id: 'workflow.refused.integrate.upToDate.next', defaultMessage: 'The merge queue brings it up to date itself.', description: 'What happens next after the strict up-to-date rule refuses.' }),
    msg({ id: 'workflow.refused.integrate.upToDate.change', defaultMessage: 'The user can change this rule in Version Control → Work is up to date before it merges.', description: 'Where the strict rule is changed.' })
  ),
  'integrate.checksPassed': r(
    msg({ id: 'workflow.refused.integrate.checksPassed.message', defaultMessage: "The merge checks failed on {card}'s merged result.", description: 'A merge returned: the merge checks failed on the test merge.' }),
    msg({ id: 'workflow.refused.integrate.checksPassed.next', defaultMessage: 'Fix the failures, commit and submit the new revision.', description: 'The next step after failed merge checks.' }),
    msg({ id: 'workflow.refused.integrate.checksPassed.change', defaultMessage: 'The user can change this rule in Version Control → Checks pass on the merged result.', description: 'Where the merge checks are changed.' })
  ),
  'done.contained': r(
    msg({ id: 'workflow.refused.done.contained.message', defaultMessage: "{card} at {revision} isn't in {target}.", description: 'A refused Done: the approved revision is not in the target branch. {target} is a branch name.' }),
    msg({ id: 'workflow.refused.done.contained.next', defaultMessage: 'Merge {revision} into {target}, then report the merge again.', description: 'The next step after a refused report of a merge.' }),
    msg({ id: 'workflow.refused.done.contained.change', defaultMessage: 'The user can change this rule in Version Control → Who merges.', description: 'Where the rule that checks a merge is changed.' })
  ),
  'move.notFromHere': r(
    msg({ id: 'workflow.refused.move.notFromHere.message', defaultMessage: "{card} is in {stage}: {move} isn't possible from there.", description: 'A refused intent: not possible from the stage the card is in. {stage} is a stage name, {move} the intent.' }),
    msg({ id: 'workflow.refused.move.notFromHere.next', defaultMessage: 'From {stage}, use: {moves}.', description: 'The next step: the intents possible from the stage. {moves} lists them.' })
  ),
  'move.useIntent': r(
    msg({ id: 'workflow.refused.move.useIntent.message', defaultMessage: "Agents don't move cards between columns.", description: 'A refused column move by an agent: agents act by intent.' }),
    msg({ id: 'workflow.refused.move.useIntent.next', defaultMessage: 'Use the {intent} intent instead.', description: 'The next step after a refused column move: {intent} is the intent to use.' })
  ),
  'move.needsOverride': r(
    msg({ id: 'workflow.refused.move.needsOverride.message', defaultMessage: 'Moving {card} to {stage} skips: {rules}.', description: 'A move that skips rules: {rules} lists the rule names.' }),
    msg({ id: 'workflow.refused.move.needsOverride.next', defaultMessage: 'Give a reason to move it anyway, or take the steps the rules need.', description: 'The next step for a move that skips rules: an override with a reason.' })
  ),
  'card.plainNumber': r(
    msg({ id: 'workflow.refused.card.plainNumber.message', defaultMessage: 'A plain number is not a card reference.', description: 'A refused intent: the card was named by a bare number.' }),
    msg({ id: 'workflow.refused.card.plainNumber.next', defaultMessage: 'Name the card as {key} or {alias}.', description: 'The forms a card reference takes: {key} like AM-12, {alias} like #1061.' })
  ),
  'platform.unknown': r(
    msg({ id: 'workflow.refused.platform.unknown.message', defaultMessage: "{card}: Hive couldn't read {what}, so the rule {rule} can't be checked.", description: 'A refused move: a fact a rule needs could not be read (git missing, folder gone). {what} says what, {rule} the rule id.' }),
    msg({ id: 'workflow.refused.platform.unknown.next', defaultMessage: 'Check Agent Setup or the folder, then try again.', description: 'The next step when Hive could not read what a rule needs.' })
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
  userOk: msg({ id: 'workflow.refused.why.userOk', defaultMessage: "the user hasn't approved it.", description: "The {why} of a refused merge: the user's approval is missing." })
} satisfies Record<string, Msg>

/** A refusal as the Agent API sends it (HTTP 409), in English for agents, with its rule and values for the window. */
export interface Refusal {
  refused: true
  rule: RuleId
  message: string
  next: string
  change?: string
  override: 'the user' | 'the user or the Assistant' | null
  values: Values
}

/** Builds a refusal from its rule and values: three English sentences, each from its own message. */
// i18n-ignore: the override field's values are agent-facing English (§16.8.3)
export function refusal(rule: RuleId, values: Values, override: Refusal['override'] = 'the user'): Refusal {
  const t = REFUSALS[rule]
  const vals = { ...values } as Record<string, string | number>
  // The {why} of a rule with several reasons is the whole sentence of its `cause`.
  if (typeof vals.cause === 'string' && Object.hasOwn(WHY, vals.cause)) vals.why = englishText({ m: WHY[vals.cause as keyof typeof WHY], values: { n: vals.n ?? 0, q: vals.q ?? 0 } })
  const one = (m: Msg) => englishText({ m, values: vals })
  return { refused: true, rule, message: one(t.message), next: one(t.next), ...(t.change ? { change: one(t.change) } : {}), override, values }
}
