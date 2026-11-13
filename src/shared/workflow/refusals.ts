// Refusals as instructions (SPEC §16.8.3): every refusal names the rule, what happened, the exact next step possible
// under the card's ruleset, and where the rule is changed. Three whole sentences, each its own message, never glued from
// pieces; agents get them in English (`refusal`), the window shows them translated (`refusalLines`), each a line.

import { agentText, englishText } from '../advanced'
import { currentChain } from '../agentText'
import { msg, type Msg } from '../i18n/msg'
import type { StoredText } from '../types'
import type { GuardId } from './pieces'
import { MOVE_NAMES, RULE_NAMES, workflowLine } from './texts'
import { STAGE_TEXT, isStageId, type StageNames } from './stages'

/** Refusals that aren't a guard of the piece library: the move itself, card references, facts that couldn't be read. */
export type MoveRule = 'move.notFromHere' | 'move.noStage' | 'move.useIntent' | 'move.needsOverride' | 'move.doingNobody' | 'lane.oneAtATime' | 'lane.lineBehind' | 'card.plainNumber' | 'paths.excluded' | 'platform.unknown' | 'platform.targetGone' | 'platform.offLine' | 'platform.slotLeft' | 'platform.jjRefused' | 'platform.switching' | 'platform.changed' | 'platform.keptAcross' | 'platform.noTarget' | 'platform.detachedFolder' | 'platform.keptLine' | 'review.noSubmission' | 'review.inProgress' | 'review.headMoved' | 'submit.empty' | 'submit.unchanged' | 'submit.sameRevisionNote' | 'submit.followUpNotBuilder' | 'check.revisionMismatch' | 'forward.notAgents' | 'forward.resolutionTarget' | 'forward.resolutionSource' | 'evidence.changed' | 'loop.roundLimit' | 'loop.stepNotYours' | 'loop.stepNotHere' | 'loop.noStep' | 'loop.noReviewer' | 'loop.staleStep' | 'loop.tooEarly' | 'loop.followUpChecked' | 'loop.followUpMerging'| 'merge.combworkMerges' | 'merge.waitsForBlockers' | 'queue.advancing'

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
  'start.platformReady': r(
    msg({ id: 'workflow.refused.start.platformReady.message', defaultMessage: "{card} can't start: cards don't run in a jj project yet.", description: 'A refused start of a card in a project using jj (Jujutsu, HI-2799): Combwork shows its repository but doesn’t start card work there yet. {card} is a card key. Keep jj (the tool’s name).' }),
    msg({ id: 'workflow.refused.start.platformReady.next', defaultMessage: 'Work on it outside Combwork’s cards, or switch the project to Git in Version Control.', description: 'The next step after a refused start in a jj project (HI-2799). Version Control is the tab’s name (glossary 2.1). Keep Git and jj.' })
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
    msg({ id: 'workflow.refused.submit.clean.next', defaultMessage: "Commit the card's changes, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. Changes that aren't the card's: ask before removing them.", description: "The next step after a refused submit for review with uncommitted changes (HI-1618, HI-2227, HI-2257): an agent doing the card commits its work; one asked only to submit it asks the user before committing; changes that aren't the card's are removed only once asked about." }),
    msg({ id: 'workflow.refused.submit.clean.change', defaultMessage: 'This rule comes with review and merging in Version Control.', description: 'Where the rule that refused a submit with uncommitted changes comes from.' })
  ),
  'submit.trailer': r(
    msg({ id: 'workflow.refused.submit.trailer.message', defaultMessage: "{card}: commit {commit} has no card trailer, and another card's agent works in this folder.", description: 'A refused submit in a shared folder: a commit lacks the Combwork-Card trailer. {commit} is a short commit id.' }),
    msg({ id: 'workflow.refused.submit.trailer.next', defaultMessage: "{at, select, head {Run {command}, then submit again.} other {Other commits follow it, so amending or rebasing would rewrite them, other agents' work among them: do neither. Report it with cw_cannot_within_rules (rule submit.trailer), and the user decides.}}", description: "The next step after a refused submit for a missing trailer (HI-2562). {at} (select): head when the commit is the folder's newest, so amending it is safe; other when commits follow it. {command} is the git command to run, kept as typed; cw_cannot_within_rules is a tool's name, kept as typed." }),
    msg({ id: 'workflow.refused.submit.trailer.change', defaultMessage: 'Each card in its own folder needs no trailers: Version Control → Where cards are built.', description: 'Where the setting that needs commit trailers is changed.' })
  ),
  'submit.checksPassed': r(
    msg({ id: 'workflow.refused.submit.checksPassed.message', defaultMessage: "Review refused: {check} hasn't passed on {revision}.{why, select, notCheck { Its last run passed but didn't count: it wasn't the check's configured command.} notContained { Its last run passed but didn't count: what it ran on doesn't contain the revision.} dirty { Its last run passed but didn't count: the folder had uncommitted changes{files, select, none {} other { ({files})}}.} moved { Its last run passed but didn't count: something else was checked out by its end.} changed { Its last run passed but didn't count: files changed in the folder while it ran{files, select, none {} other { ({files})}}.} revisionChanged { Its last run passed but didn't count: the card's files changed while it ran.} other {}}", description: "A refused submit: a configured check has no passing counted run on the revision. {check} is the check name, {revision} a short revision id. {why} picks why its last run there didn't count (#1654; keep each branch's key as it is; 'other': it didn't run there, or failed, and nothing is added); {files} lists the paths that changed, or is 'none' (keep the key)." }),
    msg({ id: 'workflow.refused.submit.checksPassed.next', defaultMessage: "{why, select, dirty {Commit or remove the uncommitted changes, run {command} again, then submit again.} changed {{copy, select, yes {Run {command} again with nothing else writing in the folder, or add --isolated to run it in a check copy of its own, then submit again.} other {Run {command} again with nothing else writing in the folder, then submit again.}}} notContained {Run {command} in the card's own folder, at its revision, then submit again.} other {Run {command}, then submit again.}}", description: "The next step after a refused submit for a missing check: {command} is the command to run. {why} picks the remedy for why its last run didn't count (#1654; keep each branch's key as it is); {copy} is 'yes' where a check copy (--isolated, kept as typed) can be used." }),
    msg({ id: 'workflow.refused.submit.checksPassed.change', defaultMessage: 'This rule is set in Version Control → Checks pass before review.', description: 'Where the rule that refused a submit for a missing check is changed.' })
  ),
  'submit.focusedChosen': r(
    msg({ id: 'workflow.refused.submit.focusedChosen.message', defaultMessage: "Review refused: {card}'s focused tests couldn't be chosen for {revision}: {state, select, tooBroad {its project's picker says the change needs every test.} other {{why, select, noPicker {the project has no picker.} timedOut {its project's picker took too long.} badOutput {its project's picker gave output Combwork can't read.} tooMany {its project's picker named too many tests.} moved {its folder moved to another revision while the picker ran.} dirty {its folder had uncommitted changes.} changed {files changed in its folder while the picker ran.} noChange {its change couldn't be read.} other {its project's picker failed.}}}}", description: "A refused submit (G20, HI-1367): the tests the card's change needs couldn't be chosen. {card} is its key, {revision} a short commit id; {state} and {why} pick the reason (keep each branch's key as it is)." }),
    msg({ id: 'workflow.refused.submit.focusedChosen.next', defaultMessage: 'Name the tests the change needs with tests on submit, for the reviewer to check, or fix what stopped the picker, then submit again.', description: 'The next step after a refused submit for focused tests (G20), addressed to the agent: tests is the submit tool’s argument, kept as typed.' }),
    msg({ id: 'workflow.refused.submit.focusedChosen.change', defaultMessage: 'This rule is set in Version Control → Each card’s focused tests.', description: 'Where the rule that refused a submit for focused tests (G20) is changed.' })
  ),
  'submit.identity': r(
    msg({ id: 'workflow.refused.submit.identity.message', defaultMessage: "{missing, select, yes {{card} can't be submitted: its commits must use the project's identity, and git has none set for the project.} other {{card}: commit {commit} isn't authored with the project's identity ({email}).}}", description: "A refused submit: a commit's author email isn't the project's, as git config has it now. {missing} (select; keep the keys): yes when git has no identity (name and email) for the project at all. {commit} is a short commit id, {email} the project's email address." }),
    msg({ id: 'workflow.refused.submit.identity.next', defaultMessage: "{missing, select, yes {Set the project's identity in Version Control → Branches & remotes → Commit identity (or with {command}), then submit again.} other {Set the identity, run {command}, then submit again.}}", description: "The next step after a refused submit for a commit's identity: {command} is the git command to use (kept as typed). {missing} (select; keep the keys): yes when git has no identity for the project; Version Control → Branches & remotes → Commit identity is where Combwork's window sets it (use the names Combwork shows for the tab, its section and heading)." }),
    msg({ id: 'workflow.refused.submit.identity.change', defaultMessage: "This rule is set in Version Control → Commits use the project's identity.", description: 'Where the identity rule is changed.' })
  ),
  'submit.ownRunsStopped': r(
    msg({ id: 'workflow.refused.submit.ownRunsStopped.message', defaultMessage: '{card}: runs you started are still going ({runs}).', description: 'A refused submit: the agent still has runs going. {runs} lists their titles.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.next', defaultMessage: 'Stop them or let them finish, then submit again.', description: 'The next step after a refused submit while runs are going.' }),
    msg({ id: 'workflow.refused.submit.ownRunsStopped.change', defaultMessage: 'This rule is set in Version Control → Agents stop what they started before review.', description: 'Where the rule about stopping runs before review is changed.' })
  ),
  'submit.decisionsReceived': r(
    msg({ id: 'workflow.refused.submit.decisionsReceived.message', defaultMessage: "{card} has a decision or a comment from the user that you haven't seen.", description: 'A refused submit (HI-2854): the card has a decision, or a comment the user wrote, newer than the builder has received.' }),
    msg({ id: 'workflow.refused.submit.decisionsReceived.next', defaultMessage: 'Check your work against each (listed below, or read the card), then submit again.', description: 'The next step after a refused submit for an unseen decision or comment of the user\'s: the agent\'s reply lists them below when it can.' })
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
  // HI-2709: a card isn't closed as merged while a card it depends on isn't Done (the merge queue waits for it too).
  'merge.waitsForBlockers': r(
    msg({ id: 'workflow.refused.merge.waitsForBlockers.message', defaultMessage: "{card} depends on {waitsFor}, which isn't Done: it isn't closed as merged before then.", description: "HI-2709: a refused report of a merge: the card depends on {waitsFor} (card keys, comma-joined), which aren't Done yet. {card} is a card key like AM-12." }),
    msg({ id: 'workflow.refused.merge.waitsForBlockers.next', defaultMessage: 'Wait for {waitsFor} to be Done, then report the merge again.', description: 'HI-2709: the next step after a merge report refused for an unfinished dependency: {waitsFor} are card keys.' })
  ),
  'merge.combworkMerges': r(
    msg({ id: 'workflow.refused.merge.combworkMerges.message', defaultMessage: "Combwork merges {card}: agents don't merge it or report its merge.", description: "A refused report of a merge, or a claim of the merge slot, for a card whose rules say Combwork merges it (the merge queue). {card} is a card key like AM-12." }),
    // Its next step is the card's place in the queue (QUEUE_NEXT, by its `queue` value).
    msg({ id: 'workflow.refused.merge.combworkMerges.next', defaultMessage: 'Once it is approved, the merge queue merges it and moves it to Done: wait for that, or for it to come back.', description: "The next step after a refused merge of a card Combwork merges, when it isn't in the merge queue yet." }),
    msg({ id: 'workflow.refused.merge.combworkMerges.change', defaultMessage: 'This rule is set in Version Control → Who merges. A card keeps the rules it started with.', description: 'Where the rule that Combwork merges cards is changed; a card keeps the rules it started under unless the change is applied to it.' })
  ),
  'move.notFromHere': r(
    msg({ id: 'workflow.refused.move.notFromHere.message', defaultMessage: "{card} is in {stage}: {move} isn't possible from there.", description: 'A refused intent: not possible from the stage the card is in. {stage} is a stage name, {move} the intent.' }),
    msg({ id: 'workflow.refused.move.notFromHere.next', defaultMessage: 'From {stage}, use: {moves}.', description: 'The next step: the intents possible from the stage. {moves} lists them.' })
  ),
  'move.noStage': r(
    msg({ id: 'workflow.refused.move.noStage.message', defaultMessage: "{card} can't go to {stage}: this project's rules have no such step.", description: 'A refused move: the card was moved to a board stage the project\'s workflow rules don\'t have (Review with no review, say). {card} is a card key, {stage} a stage name.' }),
    msg({ id: 'workflow.refused.move.noStage.next', defaultMessage: 'Move it to one of its steps: {stages}.', description: 'The next step after a move to a stage the rules lack: the stages they have. {stages} lists stage names.' }),
    msg({ id: 'workflow.refused.move.noStage.change', defaultMessage: "A project's steps follow its options in Version Control.", description: 'Where the stages a project has are set: its Version Control options (a tab name: use it as Combwork shows it).' })
  ),
  'move.useIntent': r(
    msg({ id: 'workflow.refused.move.useIntent.message', defaultMessage: "Agents don't move cards between columns.", description: 'A refused column move by an agent: agents act by intent.' }),
    msg({ id: 'workflow.refused.move.useIntent.next', defaultMessage: 'Use the {intent} intent instead.', description: 'The next step after a refused column move: {intent} is the intent to use.' })
  ),
  'move.needsOverride': r(
    msg({ id: 'workflow.refused.move.needsOverride.message', defaultMessage: 'Moving {card} to {stage} skips: {rules}.', description: 'A move that skips rules: {rules} lists the rule names.' }),
    msg({ id: 'workflow.refused.move.needsOverride.next', defaultMessage: "{reader, select, you {Moving it anyway needs your reason: one you gave for it, or one you give once told which rules this skips.} other {Move it anyway only with the user's reason. One they gave with their request is enough (\"I merged it by hand\", say): move it again with override and that reason, in their words. With none, tell them which rules this skips and ask for theirs.}}", description: "The next step for a move that skips rules (said to the Combwork Assistant): move anyway (an override) only with the user's own reason, given with the request (then the agent moves it at once, HI-2260) or after being told which rules the move skips. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." }),
    msg({ id: 'workflow.refused.move.needsOverride.change', defaultMessage: "{reader, select, you {These rules are set in Version Control, where you can change them.} other {These rules are set in Version Control, where the user can change them.}}", description: 'Where the rules a move would skip are changed: the project\'s Version Control tab (a tab name: use it as Combwork shows it). {reader} (select): you is the window\'s wording, other the agent\'s (the user named as the user); translate both whole sentences.' })
  ),
  // The Assistant's move into Active leaving nobody on the card (HI-2062): which of the three the user wants is theirs.
  'move.doingNobody': r(
    msg({ id: 'workflow.refused.move.doingNobody.message', defaultMessage: '{card} would be in {stage} with nobody on it{also, select, yes {, and the move skips: {rules}} other {}}.', description: "A refused move into the Active stage by the Combwork Assistant (HI-2062): the card {card} (its key, like AM-12) would have no agent on it. {stage} is the stage's name. {also} (select): yes when the move also skips other rules, listed in {rules}; translate both branches." }),
    msg({ id: 'workflow.refused.move.doingNobody.next', defaultMessage: "{reader, select, you {Choose nobody on it, an agent on it, or an agent started on it.} other {Ask the user which they want: nobody on it (move it again with override and their reason), an agent on it (agent), or an agent started on it (cw_start_task).}}", description: "The next step after the Assistant's move into Active was refused for leaving nobody on the card: the user chooses nobody on it, an agent given the card, or an agent started on it. override, agent and cw_start_task are names of a call's fields and a tool: keep them as they are. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." })
  ),
  'lane.lineBehind': r(
    msg({ id: 'workflow.refused.lane.lineBehind.message', defaultMessage: "{card} can't start yet: {line} still has {earlier}'s work, which was squashed into {target}.", description: "A refused start (§16.19.2): the builder's branch (in its own worktree) still has the previous card's commits, which were merged into the target as one squashed commit, so the next card's change would include them. {card} and {earlier} are card keys like AM-12; {line} a branch name; {target} the branch merged into." }),
    msg({ id: 'workflow.refused.lane.lineBehind.next', defaultMessage: "{reader, select, you {Leave it as it is: Combwork brings {line} up to date with {target} once the agent is idle, or asks you first, and tells the agent when {card} can start.} other {Leave it as it is: Combwork brings {line} up to date with {target} once you are idle, or asks the user, and tells you when {card} can start.}}", description: 'The next step after a start refused because the branch still has squashed work: wait (end the turn); Combwork moves the branch, or asks the user first, and says when the card can start. {line} a branch name, {target} the branch merged into, {card} a card key. {reader} (select): you is the window\'s wording, other the agent\'s (the user named as the user); translate both whole sentences.' }),
    msg({ id: 'workflow.refused.lane.lineBehind.change', defaultMessage: "Settings → Advanced → Bring an agent's branch up to date after a squash merge says whether Combwork moves it or asks first.", description: 'Where it is decided whether Combwork moves the branch itself or asks the user first (a setting name: use it as Combwork shows it).' })
  ),
  'lane.oneAtATime': r(
    msg({ id: 'workflow.refused.lane.oneAtATime.message', defaultMessage: "{card} can't start yet: {earlier}, before it in its lane, isn't Done.", description: 'A refused start (glossary 2.4): a lane takes one card at a time, so a card starts only once the cards before it in its lane are Done. {card} and {earlier} are card keys like AM-12.' }),
    msg({ id: 'workflow.refused.lane.oneAtATime.next', defaultMessage: 'Finish {earlier} first: once it is Done, the lane goes on to {card}.', description: 'The next step after a start refused because an earlier card of the lane is not Done. {card} and {earlier} are card keys like AM-12.' }),
    msg({ id: 'workflow.refused.lane.oneAtATime.change', defaultMessage: 'A lane always takes one card at a time; turning off Settings → Advanced → Workflow rules are enforced turns every rule off.', description: 'Where the rule that a lane takes one card at a time is changed: it has no option of its own; the switch that turns every workflow rule off (a setting name: use it as Combwork shows it).' })
  ),
  'card.plainNumber': r(
    msg({ id: 'workflow.refused.card.plainNumber.message', defaultMessage: 'A plain number is not a card reference.', description: 'A refused intent: the card was named by a bare number.' }),
    msg({ id: 'workflow.refused.card.plainNumber.next', defaultMessage: 'Name the card by its key: {key}.', description: 'How to name a card instead of a bare number: by its key, {key} (such as AM-12).' })
  ),
  'paths.excluded': r(
    msg({ id: 'workflow.refused.paths.excluded.message', defaultMessage: "{card}: {path} is in {folder}, which a project without version control leaves out of its work.", description: "A refused declaration of a card's paths (#1511): in a project without version control (None), a card's paths are the files of its work; {path} is under {folder} (node_modules, .venv, .git, .combwork or a folder the project excludes), which never counts as work. {card} is a card key like AM-12." }),
    msg({ id: 'workflow.refused.paths.excluded.next', defaultMessage: "Declare only the files of the work, outside {folder}: a card's paths narrow the project's work, never widen it.", description: "The next step after a refused declaration of a card's paths: name files outside the excluded folder {folder} (#1511)." })
  ),
  'platform.unknown': r(
    msg({ id: 'workflow.refused.platform.unknown.message', defaultMessage: "{card}: Combwork couldn't read {what}, so the rule {rule} can't be checked.", description: 'A refused move: a fact a rule needs could not be read (git missing, folder gone). {what} says what, {rule} the rule id.' }),
    msg({ id: 'workflow.refused.platform.unknown.next', defaultMessage: 'Check Provider Setup or the folder, then try again.', description: 'The next step when Combwork could not read what a rule needs.' })
  ),
  'platform.switching': r(
    msg({ id: 'workflow.refused.platform.switching.message', defaultMessage: "{card} can't start now: its repository's version control is being switched.", description: 'HI-2799: a refused start: the project’s repository is switching between Git and jj, and nothing starts on it meanwhile. {card} is a card key like AM-12.' }),
    msg({ id: 'workflow.refused.platform.switching.next', defaultMessage: 'Try again in a moment, once the switch has finished.', description: 'HI-2799: the next step after a start refused while the repository’s version control is switched.' })
  ),
  'platform.changed': r(
    msg({ id: 'workflow.refused.platform.changed.message', defaultMessage: "{card} can't start under these rules: its project uses {platform} now.", description: 'HI-2799: a refused start: the start was prepared under the project’s previous version control, and the project was switched meanwhile. {card} is a card key; {platform} is None, Git or jj.' }),
    msg({ id: 'workflow.refused.platform.changed.next', defaultMessage: 'Start it again: it is then checked under {platform}’s rules.', description: 'HI-2799: the next step after a start refused because the project switched version control meanwhile. {platform} is None, Git or jj.' })
  ),
  'platform.noTarget': r(
    msg({ id: 'workflow.refused.platform.noTarget.message', defaultMessage: '{card} can’t start: its project has no target bookmark chosen, the one its work merges into.', description: 'HI-3106: a refused start in a project using jj (Jujutsu): no target bookmark (Work merges into) is chosen, and jj has no default to fall back on, as Git has its default branch. {card} is a card key like AM-12. A bookmark is jj’s name for a branch.' }),
    msg({ id: 'workflow.refused.platform.noTarget.next', defaultMessage: 'Choose one in Version Control → Workflow (Work merges into), then start it again.', description: 'HI-3106: the next step after a start refused for no target bookmark: the user chooses it in the window. Version Control, Workflow and Work merges into are names in the window: as translated there.' })
  ),
  'platform.detachedFolder': r(
    msg({ id: 'workflow.refused.platform.detachedFolder.message', defaultMessage: '{card} can’t start: the project folder is on no branch (its head is detached at {head}), so what its builder commits would be on none.', description: 'HI-3104: a refused start in a Git project whose cards are built in the project folder: the folder has no branch checked out (a detached head, as a jj repository colocated with Git leaves it after switching back to Git), so commits made there would belong to no branch. {card} is a card key like AM-12; {head} a short commit id.' }),
    msg({ id: 'workflow.refused.platform.detachedFolder.next', defaultMessage: '{has, select, yes {Check out its branch in the project folder (git switch {branch}), then start it again.} other {Check out a branch in the project folder (an existing one with git switch, or a new one with git switch -c), then start it again.}}', description: 'HI-3104: the next step after a start refused because the project folder is on no branch. has (select): yes when Combwork found the branch to check out ({branch}, its name), other when it found none it could name. git switch and git switch -c are commands: keep them as they are. Translate both whole sentences.' })
  ),
  'platform.keptLine': r(
    msg({ id: 'workflow.refused.platform.keptLine.message', defaultMessage: '{card} can’t start: its branch was made from {kept} and still holds history {target} lacks, but its lane merges into {target}.', description: 'HI-3112: a refused start: the card was started before, put back, and its branch (made from {kept}, the branch it merged into then) is kept, so it keeps merging into {kept}; but the card is in a lane whose cards merge into {target}. {card} is a card key like AM-12; {kept} and {target} are branch names.' }),
    msg({ id: 'workflow.refused.platform.keptLine.next', defaultMessage: 'Take it out of the lane and start it on its own, to merge into {kept}; or make a new card for {target}.', description: 'HI-3112: the next step after a start refused because the card’s kept branch ({kept}) isn’t its lane’s ({target}). {kept} and {target} are branch names.' })
  ),
  'platform.keptAcross': r(
    msg({ id: 'workflow.refused.platform.keptAcross.message', defaultMessage: "{card} can't start: its committed work from before it was put back is kept in slot {slot}, a {platform} slot from before the repository switched to {now}.", description: 'HI-3069: a refused start: the card was put back with commits under one version control, kept for it in its slot, and the repository has since switched to the other, so that slot can’t be lent back and the card would start without its work. {card} is a card key like AM-12; {slot} a slot’s name; {platform} and {now} are Git or jj (keep them).' }),
    msg({ id: 'workflow.refused.platform.keptAcross.next', defaultMessage: '{gone, select, yes {Its folder is gone, so nothing of it is left to go on with: remove the slot (Version Control → Slots and copies, Remove…), and {card} starts afresh from its target.} other {Switch the repository back to {platform} to go on with {card} in that slot.}}', description: 'HI-3069: the next step after a start refused because the card’s kept slot is of the other version control. gone (select): yes when the slot’s folder was deleted, so removing the slot lets the card start afresh; other: switching back is the way on. Version Control, Slots and copies and Remove… are names in the window: as translated there. {platform} is Git or jj; {card} a card key.' })
  ),
  'platform.targetGone': r(
    msg({ id: 'workflow.refused.platform.targetGone.message', defaultMessage: '{card} was started on {target}, which no longer exists in this repository.', description: 'HI-2753: a refused move (a submit): the branch the card was started on and merges into (its target, {target}) was deleted, as an integration branch is once it has been merged. {card} is a card key like AM-12.' }),
    msg({ id: 'workflow.refused.platform.targetGone.next', defaultMessage: 'The user or the Assistant can move it to another branch with its work kept: set its Merges into, or retarget Work merges into.', description: 'HI-2753: the next step when the branch a card started on is gone: the user or the Combwork Assistant moves the card to another branch (its Merges into, or a retarget after changing Work merges into). Merges into and Work merges into are names in the window: as translated there.' })
  ),
  'platform.offLine': r(
    msg({ id: 'workflow.refused.platform.offLine.message', defaultMessage: "{card}'s folder isn't on its branch {line}: {where, select, detached {its head is detached at {head}} other {it is on {on}}}, so the work there isn't what the card would merge.", description: "HI-3010: a refused submit: the card's slot (its folder) has another branch or no branch checked out (a detached head), so its commits there aren't on the card's own branch, which is what review and the merge read. {card} is a card key like AM-12; {line} and {on} are branch names; {head} is a short commit id. Translate each branch of the select." }),
    msg({ id: 'workflow.refused.platform.offLine.next', defaultMessage: "{where, select, detached {Put the commits on the card's branch: git switch -c {lineArg} if it doesn't exist yet, else git switch {lineArg} and git cherry-pick the commits made off it. Then submit again.} other {{made, select, no {The card's branch doesn't exist yet: make it from where the card started with git switch -c {lineArg} {start}, then git cherry-pick there the card's own commits made on {onArg}. Then submit again.} other {Switch back with git switch {lineArg}, and git cherry-pick there any commits of the card's made on {onArg}. Then submit again.}}}}", description: 'HI-3010, HI-3116: the next step after a submit refused because the card’s folder isn’t on its branch, by where it is (where, select: a detached head, or another branch) and, on another branch, whether the card’s branch exists yet (made, select: no, or yes). git switch -c, git switch and git cherry-pick are commands: keep them and their arguments exactly as they are. {lineArg} and {onArg} are branch names as typed in a shell (possibly in quotes); {start} is a commit id.' })
  ),
  'platform.slotLeft': r(
    msg({ id: 'workflow.refused.platform.slotLeft.message', defaultMessage: "{unknown, select, yes {Combwork couldn't tell whether {card}'s slot {slot} ({folder}) is still the card's, so it wasn't submitted.} other {{card}'s slot {slot} ({folder}) isn't the card's any more: Combwork ended its lease there, so the work in that folder may be another card's now.}}", description: "HI-3118: a refused submit: the card was started in a slot (a working folder Combwork lends to one card or lane at a time), and Combwork no longer holds that slot for it (its lane ended, say), so the folder may have been lent to another card since. unknown yes: whether it still holds it couldn't be read. {card} is a card key like AM-12; {slot} a slot's name like slot-a; {folder} its path. Translate each branch of the select." }),
    msg({ id: 'workflow.refused.platform.slotLeft.next', defaultMessage: "{unknown, select, yes {Try again in a moment.} other {Put the card back and start it again: it gets a slot of its own, with its committed work if the slot was kept for it.}}", description: 'HI-3118: the next step after a submit refused because the card’s slot is no longer held for it (unknown yes: that couldn’t be read). Put back and start are actions on the card.' })
  ),
  'platform.jjRefused': r(
    msg({ id: 'workflow.refused.platform.jjRefused.message', defaultMessage: "{why, select, tooLarge {{card}: jj left {count, plural, one {a new file} other {# new files}} out of its snapshot for being over its size limit for new files (snapshot.max-new-file-size), so the work isn't all recorded: {files}.} autoTrack {{card}: jj's setting snapshot.auto-track is {setting} here, not all(), so jj doesn't record new files by itself and the work may not all be recorded.} mergeWorkingCopy {{card}: the slot's working copy has more than one parent, so its work isn't one line of commits.} notFromBase {{card}: the work in its slot doesn't start from the card's base {base}.} otherCard {{card}: commit {commit} is {other}'s work.} divergent {{card}: commit {commit} is divergent in jj (its change has more than one visible commit).} conflicted {{card}: commit {commit} has unresolved conflicts.} tooLong {{card}: its work has more than {max, number} commits.} unbound {{card}: its slot isn't prepared for this card any more.} isolated {{card}: jj projects have no check copies yet.} recovered {{card}: commits of its work hold copies that Recover… wrote beside the original files: {files}.} other {{card}: jj refused it.}}", description: "HI-2868: a refused move on a card of a project using jj (Jujutsu): why its work can't be taken as it is. {card} is a card key like AM-12; {commit} and {base} are short commit ids; {other} is another card's key; {max} is a number; {files} is a list of file paths and {count} their number (HI-2973). 'working copy', 'divergent' and 'snapshot' are jj's terms; snapshot.max-new-file-size is jj's setting: keep it as it is. Translate each sentence. autoTrack (HI-3096): the user's jj setting snapshot.auto-track ({setting}, its value) isn't all(), so jj leaves new files untracked; snapshot.auto-track and all() are jj's: keep them. recovered (HI-2996): Recover… (a button of a stale slot, as the window names it) wrote a copy of the user's version beside a file that had changed meanwhile, and commits of the card's work hold that copy; {files} is a list of file paths, as they are." }),
    msg({ id: 'workflow.refused.platform.jjRefused.next', defaultMessage: "{why, select, tooLarge {Leave a file out deliberately with .gitignore, or raise jj's limit (jj config set --repo snapshot.max-new-file-size and a size in bytes) and commit it with jj commit, then submit again.} autoTrack {Set it back to all() for this repository (jj config set --repo snapshot.auto-track 'all()'), then submit again: jj then records the new files.} mergeWorkingCopy {Commit the work with jj commit, so the working copy is empty on one parent, then submit again.} notFromBase {Rebase the work onto the card's base, or start the card again.} otherCard {Leave that card's commits out of this card's work (rebase without them), then submit again.} divergent {Resolve the divergence in jj (abandon or rewrite one side), then try again.} conflicted {Resolve the conflicts in jj, then try again.} tooLong {Squash some of the commits, then submit again.} unbound {Put the card back and start it again.} isolated {Run the check again without --isolated, in the card's slot.} recovered {Compare each copy with its original and keep what you want under the original name, then take the copies out of every commit of the work (jj squash or jj diffedit: deleting them in a later commit leaves them in its history) and submit again.} other {Look at the slot with jj, then try again.}}", description: "HI-2868: the next step after a refused move on a jj project's card, by the reason (why, select). jj commit, --isolated, .gitignore, jj config set --repo snapshot.max-new-file-size and jj config set --repo snapshot.auto-track 'all()' are commands and names: keep them as they are. 'working copy' and 'divergent' are jj's terms. Translate each sentence. recovered (HI-2996): copies Recover… wrote beside the originals are in commits of the card's work: the user's version of each is compared with the original, kept under the original name if wanted, and the copies taken out of every commit (jj squash and jj diffedit are commands: keep them)." })
  ),
  'loop.roundLimit': r(
    msg({ id: 'workflow.refused.loop.roundLimit.message', defaultMessage: '{card} reached its round limit: it goes on once its round-limit question is answered.', description: "A refused submission or move: the card failed as many reviews as its card loop allows (Settings → Card loops), and Combwork asked how to go on (For you); until that question is answered, its loop is paused. Read by agents and shown in the window alike: it names no one (never \"the user\"). {card} is a card key." }),
    msg({ id: 'workflow.refused.loop.roundLimit.next', defaultMessage: 'The question is on the card (For you): once it is answered, Combwork wakes the agents waiting on it.', description: "The next step while a card waits at its round limit for its question (For you, a label: use it as Combwork shows it) to be answered. Read by agents and shown in the window alike: it names no one (never \"the user\"); Combwork then wakes the agents that wait on the card." })
  ),
  'loop.stepNotYours': r(
    msg({ id: 'workflow.refused.loop.stepNotYours.message', defaultMessage: '{side, select, builder {Only the builder of {card} posts its design or follow-up, or goes ahead with a design.} other {Only the reviewer of {card} checks its design or follow-up.}}', description: "A refused card loop step (#1382, #1467): the agent isn't on the side of the loop the step belongs to (a reviewer posting a design or a follow-up, a builder answering its own). A follow-up: a change asked of reviewed work (such as a screenshot's), ready for the reviewer's check. {card} is a card key; side (select): builder or reviewer, whose step it is. Translate each sentence." }),
    msg({ id: 'workflow.refused.loop.stepNotYours.next', defaultMessage: "{side, select, builder {Leave it to the card's builder; a reviewer answers with ok or gaps.} other {Leave it to the card's reviewer; nobody checks their own work.}}", description: "The next step after a refused card loop step from the wrong side (#1382, #1467). side: builder or reviewer, the agent the step belongs to. ok and gaps are the reviewer's answers, as agents name them: keep them as they are." })
  ),
  'loop.stepNotHere': r(
    msg({ id: 'workflow.refused.loop.stepNotHere.message', defaultMessage: '{step, select, followUp {{card} is in {stage}: a follow-up is posted for its check once the work is in review or has passed it.} other {{card} is in {stage}: a design is posted for its check before the work goes to review.}}', description: "A refused card loop step (#1382, #1467): a design was posted for a card that isn't being worked on (not in Doing), or a follow-up (a change asked of reviewed work, such as a screenshot's) for a card that isn't in Review or Passed. {card} is a card key; {stage} the stage it is in; step (select): followUp, or other for a design. Translate each sentence." }),
    msg({ id: 'workflow.refused.loop.stepNotHere.next', defaultMessage: '{step, select, followUp {Send the work to review, or say it in a comment.} other {Post it while the card is being worked on, or say it in a comment.}}', description: 'The next step after a design posted for a card that is not being worked on, or a follow-up for a card not in Review or Passed (#1382, #1467). step (select): followUp, or other for a design. Translate each sentence.' })
  ),
  'loop.noStep': r(
    msg({ id: 'workflow.refused.loop.noStep.message', defaultMessage: '{card} has no design or follow-up waiting for its check.', description: "A refused card loop step (#1382, #1467): an answer (OK, gaps) or going ahead when no design or follow-up posted by its builder waits for its reviewer's check. A follow-up: a change asked of reviewed work, such as a screenshot's. {card} is a card key." }),
    msg({ id: 'workflow.refused.loop.noStep.next', defaultMessage: 'Read the card: it may have been answered, or the card moved on. Feedback still worth giving goes on the card as a comment.', description: 'The next step after a card loop step with nothing to answer (#1382): what was posted for the check may have been answered, or the card left the column it was posted in (HI-3011: a design closes when its card is put back). A reviewer with feedback for it comments on the card instead.' })
  ),
  'loop.noReviewer': r(
    msg({ id: 'workflow.refused.loop.noReviewer.message', defaultMessage: '{card} has no reviewer to check it: it is in no lane with a reviewer, and nobody has reviewed it yet.', description: "A refused design or follow-up posted for a check (#1382, #1467): nobody can be woken to check it. {card} is a card key. A lane: a card loop's record of its builder and reviewer." }),
    msg({ id: 'workflow.refused.loop.noReviewer.next', defaultMessage: 'Start a lane for the card with a reviewer, or say it in a comment instead.', description: 'The next step after a design or follow-up refused for want of a reviewer (#1382, #1467).' })
  ),
  'loop.staleStep': r(
    msg({ id: 'workflow.refused.loop.staleStep.message', defaultMessage: '{card}: that is about {design}, but the one waiting for its check now is {waiting}.', description: "A refused answer to a design or follow-up, or going ahead with a design (#1382, #1467): it names an earlier one than the one waiting now, so it can't settle it. {card} is a card key; {design} and {waiting} are their ids, such as AM-12/s40." }),
    msg({ id: 'workflow.refused.loop.staleStep.next', defaultMessage: "Read the card's latest comment and answer the one it names.", description: 'The next step after an answer to an earlier design or follow-up (#1382, #1467).' })
  ),
  'loop.tooEarly': r(
    msg({ id: 'workflow.refused.loop.tooEarly.message', defaultMessage: "{card}: its design's check is due in {minutes, plural, one {# minute} other {# minutes}}.", description: "A refused going ahead with a design before its reviewer's check is due (#1382, Card loops → Design check wait). {card} is a card key; {minutes} how many minutes are left." }),
    msg({ id: 'workflow.refused.loop.tooEarly.next', defaultMessage: 'Wait for the answer; with none by then, go ahead as posted.', description: 'The next step after going ahead with a design too early (#1382).' }),
    msg({ id: 'workflow.refused.loop.tooEarly.change', defaultMessage: 'How long is set in Project Settings → Card loops → Design check wait.', description: 'Where the wait for a design check is changed (#1382). Names of settings: keep them as Combwork shows them.' })
  ),
  'loop.followUpChecked': r(
    msg({ id: 'workflow.refused.loop.followUpChecked.message', defaultMessage: "{card}: a follow-up waits for its reviewer's check, with no going ahead without it.", description: "A refused going ahead unchecked (#1467): what waits is a follow-up (a change asked of reviewed work, such as a screenshot's), which only its reviewer's answer settles. {card} is a card key." }),
    msg({ id: 'workflow.refused.loop.followUpChecked.next', defaultMessage: "{reader, select, you {The agent waits for the reviewer's ok or gaps; if none comes, it asks you.} other {Wait for the reviewer's ok or gaps; if none comes, ask the user.}}", description: "The next step after going ahead with a follow-up unchecked (#1467). ok and gaps are the reviewer's answers, as agents name them: keep them as they are. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." })
  ),
  'loop.followUpMerging': r(
    msg({ id: 'workflow.refused.loop.followUpMerging.message', defaultMessage: '{card} is being merged now: a follow-up can no longer take it out of the merge queue.', description: 'A refused follow-up (#1623): a follow-up on a queued card takes it out of the merge queue first, but the queue has already begun merging this one. {card} is a card key.' }),
    msg({ id: 'workflow.refused.loop.followUpMerging.next', defaultMessage: 'Wait for the merge; if the follow-up is still needed, put it on a new card.', description: 'The next step after a follow-up refused because the card is being merged now (#1623).' })
  ),
  'queue.advancing': r(
    msg({ id: 'workflow.refused.queue.advancing.message', defaultMessage: '{card} is being merged into {target} now: it can no longer be taken out of the merge queue.', description: "A refused Remove from queue: the merge queue has begun moving the target to the card's merge (it finishes even after a restart). {card} is a card key, {target} a branch name." }),
    msg({ id: 'workflow.refused.queue.advancing.next', defaultMessage: "Wait for the merge to finish. If the change isn't wanted, revert it in {target}.", description: 'The next step after a refused Remove from queue while the card is being merged. {target} is a branch name.' })
  ),
  'review.noSubmission': r(
    msg({ id: 'workflow.refused.review.noSubmission.message', defaultMessage: '{card} has nothing submitted to review.', description: 'A refused review: the card has no submission.' }),
    msg({ id: 'workflow.refused.review.noSubmission.next', defaultMessage: 'Wait for its builder to submit it.', description: 'The next step when there is nothing to review.' })
  ),
  // HI-2487: another reviewer has the submission's review in progress (a stale wake once took HI-2444's from HR2).
  'review.inProgress': r(
    msg({ id: 'workflow.refused.review.inProgress.message', defaultMessage: "{who, select, user {The user is reviewing {card}'s submission {submission}} other {{reviewer} is reviewing {card}'s submission {submission}}}, and has been for {minutes, plural, =0 {less than a minute} one {# minute} other {# minutes}}.", description: "A refused start of a review (HI-2487): someone else started reviewing the same submission and hasn't given its verdict. {who}: user (the user reviews it) or agent (another reviewer agent, named by {reviewer}, its name). {card} is a card key like AM-12, {submission} the submission's number, {minutes} how long ago its review started (select: translate each branch)." }),
    msg({ id: 'workflow.refused.review.inProgress.next', defaultMessage: "{who, select, user {Leave it to the user} other {Leave it to {reviewer}}}: don't review {card} or give it a verdict.", description: 'The next step after a review refused because someone else is reviewing the card (HI-2487). {who}: user (the user reviews it) or agent (another reviewer agent, named by {reviewer}). {card} is a card key (select: translate each branch).' }),
    msg({ id: 'workflow.refused.review.inProgress.change', defaultMessage: 'Only the user takes a review over; one whose reviewer has left the project or stopped is free again.', description: "Who can take over a review in progress (HI-2487): only the user; it is free again once its reviewer agent is removed from the project or its session has stopped." })
  ),
  'review.headMoved': r(
    msg({ id: 'workflow.refused.review.headMoved.message', defaultMessage: "{card}'s line has moved since it was submitted: it was submitted at {submitted}, and its head is now {head}, a different change. A pass covers only the revision submitted.", description: "A refused passing verdict (HI-1763): the card's branch has new commits since the revision under review (a follow-up, say). {card} is the card's key; {submitted} and {head} are commits' short hashes." }),
    msg({ id: 'workflow.refused.review.headMoved.next', defaultMessage: 'A commit you asked for: ask its builder to submit {head} as a follow-up (cw_request_builder), which keeps it in Review with no round counted, then start your review again. Otherwise give a failing verdict saying so (cw_verdict, pass: false), and its builder submits it as the next round.', description: "The next step after a pass refused because the branch moved on (HI-1763, HI-1832): a commit the reviewer asked for is submitted by the builder as a follow-up (the card stays in Review, no round counted) and reviewed again; any other is failed so the builder submits it as a new round. {head} is a commit's short hash; keep the tool names and the argument as they are." })
  ),
  // Submitting is "submit for review": it hands committed work to review and never commits it (HI-1618, Darren's
  // decision): what is missing is said in git's words. An agent doing the card commits its work (HI-2227); one asked
  // only to submit asks the user before committing (HI-2257, Darren's decision: both rules, said here only).
  'submit.empty': r(
    msg({ id: 'workflow.refused.submit.empty.message', defaultMessage: '{card}: nothing committed to review.', description: "A refused submit for review: the card's line has no commit since it started (git's words: nothing committed). {card} is a card key." }),
    msg({ id: 'workflow.refused.submit.empty.next', defaultMessage: "{changes, select, yes {Commit the card's work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing.} none {Its folder has no changes either. A card that needs none (it only runs or checks something, or its work is already there) is no-code: ask for that with cw_ask_user (action noCode), or cw_ask_assistant where it's already decided. Otherwise make its change, commit it and submit again.} other {Commit the card's work, then submit for review again; if you were asked only to submit it (not to do the card), ask the user before committing. A card that needs no change is no-code: ask for that with cw_ask_user (action noCode).}}", description: "The next step after a refused submit for review with nothing committed (HI-2227, HI-2257). {changes} (select): yes when the card's folder has uncommitted changes (an agent doing the card commits them; one asked only to submit it asks the user first), none when it has none (a card needing no change is made no-code by the user, asked with the tools named), other when unknown. cw_ask_user, cw_ask_assistant and noCode are names of tools and an option: keep them as they are; translate each branch's whole sentences." })
  ),
  // A project with no version control: nothing is committed there, only the card's files changed or not.
  'submit.unchanged': r(
    msg({ id: 'workflow.refused.submit.unchanged.message', defaultMessage: "{card}: its files haven't changed since it started.", description: 'A refused submit for review in a project with no version control: none of the card\'s files changed. {card} is a card key.' }),
    msg({ id: 'workflow.refused.submit.unchanged.next', defaultMessage: "Change the card's files, then submit it for review.", description: 'The next step after a refused submit for review in a project with no version control, nothing changed.' })
  ),
  'submit.sameRevisionNote': r(
    msg({ id: 'workflow.refused.submit.sameRevisionNote.message', defaultMessage: '{revision} was already reviewed.', description: 'A refused submit: the same revision again without a note.' }),
    msg({ id: 'workflow.refused.submit.sameRevisionNote.next', defaultMessage: 'Submit it again with a note saying what changed in your answer, or commit a new revision.', description: 'The next step when submitting a reviewed revision again.' })
  ),
  // HI-1832: a follow-up in Review is its builder's (or the user's, the Assistant's): another agent's would move the review.
  'submit.followUpNotBuilder': r(
    msg({ id: 'workflow.refused.submit.followUpNotBuilder.message', defaultMessage: "{card}'s follow-up is its builder's to submit: you aren't building it.", description: 'A refused follow-up submission (HI-1832: a commit its reviewer asked for, submitted while the card is in Review): only the agent building the card submits one. {card} is a card key.' }),
    msg({ id: 'workflow.refused.submit.followUpNotBuilder.next', defaultMessage: 'Leave it to its builder, or say what you found in a comment.', description: "The next step after a follow-up submission refused because the agent is not the card's builder (HI-1832)." })
  ),
  'evidence.changed': r(
    msg({ id: 'workflow.refused.evidence.changed.message', defaultMessage: 'What Combwork read for {card} changed while it decided.', description: "A refused intent: a branch head, a file or another card the rule depends on changed between Combwork's reading it and recording the move. {card} is a card key." }),
    msg({ id: 'workflow.refused.evidence.changed.next', defaultMessage: 'Try again: Combwork reads it afresh.', description: 'The next step after a refusal because what a rule read changed meanwhile.' })
  ),
  'check.revisionMismatch': r(
    msg({ id: 'workflow.refused.check.revisionMismatch.message', defaultMessage: "{why, select, ambiguous {{revision} is the start of more than one commit here: give more of it. {head} is checked out.} other {{revision} isn't what's checked out here: {head} is.}}", description: 'A refused check run or submission (HI-2671): the revision named ({revision}, as given, a commit id or its start) is not the checked-out commit ({head}, its first 12 characters). why=ambiguous: {revision} is the start of the checked-out commit but also of another one, so more of its characters are needed.' }),
    msg({ id: 'workflow.refused.check.revisionMismatch.next', defaultMessage: 'Run the check where {revision} is checked out, or without a revision.', description: 'The next step after a check run named the wrong revision.' })
  ),
  'forward.notAgents': r(
    msg({ id: 'workflow.refused.forward.notAgents.message', defaultMessage: '{card} brings one branch up to date with another: only the user or the Assistant acts on it.', description: 'HI-2679: a refused intent: an agent acted on a forward-merge card (Combwork’s own card that merges one of the project’s target branches into another). {card} is its key (HI-12).' }),
    msg({ id: 'workflow.refused.forward.notAgents.next', defaultMessage: 'Leave it to the user or the Assistant.', description: 'HI-2679: the next step after an agent was refused acting on a forward-merge card.' })
  ),
  'forward.resolutionTarget': r(
    msg({ id: 'workflow.refused.forward.resolutionTarget.message', defaultMessage: '{card} resolves the merge of {from} into {to}, but it would start from {target} and merge there.', description: 'HI-2985: a refused start of a card made by Resolve on a builder (it merges branch {from} into branch {to} by hand): its Merges into is another branch now ({target}), as when the project’s Work merges into moved on after it was made. {card} is a card key like AM-12.' }),
    msg({ id: 'workflow.refused.forward.resolutionTarget.next', defaultMessage: 'The user or the Assistant can set its Merges into to {to}, then start it again.', description: 'HI-2985: the next step after a refused start of a Resolve on a builder card: set its Merges into (a name in the window: as translated there) to branch {to}.' })
  ),
  'forward.resolutionSource': r(
    msg({ id: 'workflow.refused.forward.resolutionSource.message', defaultMessage: '{card} resolves the merge of {from} into {to}, but {revision} doesn’t contain {source}, the commit that came back: a cherry-pick or a copy of its changes leaves it out of {to}’s history, so the next Bring Up to Date would conflict again.', description: 'HI-2999: a refused submission of a card made by Resolve on a builder (it merges branch {from} into branch {to} by hand): the revision submitted ({revision}, a short commit id) doesn’t have the commit it resolves ({source}, a full commit id) in its history. Bring Up to Date is a command’s name in the window: as translated there. {card} is a card key like AM-12.' }),
    msg({ id: 'workflow.refused.forward.resolutionSource.next', defaultMessage: 'In its branch, run git merge {source}, resolve the conflict, commit, and submit again.', description: 'HI-2999: the next step after that refusal: merge the commit ({source}, a full commit id; "git merge" is a command, never translated) into the card’s branch.' })
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
 * The next step of `merge.combworkMerges` by the card's place in the merge queue (its `queue` value: queueState.ts's state);
 * one not listed (not queued yet, or left it) is the rule's own next.
 */
export const QUEUE_NEXT = {
  queued: msg({ id: 'workflow.refused.merge.combworkMerges.nextQueued', defaultMessage: 'It is in the merge queue for {target} (position {n, number}) and moves to Done once merged: wait for that, or for it to come back.', description: 'The next step after a refused merge of a card Combwork merges, waiting in the merge queue. {target} is a branch name; {n} its place in the queue (1 is next).' }),
  testing: msg({ id: 'workflow.refused.merge.combworkMerges.nextTesting', defaultMessage: 'The merge queue is merging it into {target} now and moves it to Done once merged: wait for that, or for it to come back.', description: 'The next step after a refused merge of a card the merge queue is testing or merging now. {target} is a branch name.' }),
  paused: msg({ id: 'workflow.refused.merge.combworkMerges.nextPaused', defaultMessage: "{reader, select, you {It is in the merge queue for {target}, which is paused until you resume it; it moves to Done once merged, or comes back.} other {It is in the merge queue for {target}, which is paused until it is resumed: wait for Done, or for it to come back.}}", description: "The next step after a refused merge of a card in a paused merge queue. {target} is a branch name. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." }),
  returned: msg({ id: 'workflow.refused.merge.combworkMerges.nextReturned', defaultMessage: 'It came back from the merge queue: fix it in your worktree, commit and submit again.', description: 'The next step after a refused merge of a card the merge queue returned to its builder (a conflict, failed checks, a hook).' }),
  stale: msg({ id: 'workflow.refused.merge.combworkMerges.nextStale', defaultMessage: 'Its pass is stale: its line changed since it passed review (it is at {current}). Submit it again for review; it is queued once it passes again.', description: "The next step after a refused merge of a card Combwork merges, approved but its pass stale: its branch has commits the review didn't cover. {current} is a commit's short hash." }),
  merged: msg({ id: 'workflow.refused.merge.combworkMerges.nextMerged', defaultMessage: 'The merge queue has merged it already: nothing is left to do.', description: 'The next step after a refused merge of a card Combwork has already merged.' })
} satisfies Record<string, Msg>

/**
 * The next step for a card in a paused merge queue by what the pause waits for (#1406, the refusal's `waits`, from
 * queueState.ts's pauseWait): the user's Resume is QUEUE_NEXT.paused.
 */
export const PAUSED_NEXT = {
  answer: msg({ id: 'workflow.refused.merge.combworkMerges.nextPausedAnswer', defaultMessage: "{reader, select, you {It is in the merge queue for {target}, which is paused until you answer in For you; it moves to Done once merged, or comes back.} other {It is in the merge queue for {target}, which is paused until the user answers in For you: wait for Done, or for it to come back.}}", description: "The next step after a refused merge of a card in a merge queue paused for the user's answer (in For you: whether to update the branch now, or how to settle a merge Combwork couldn't finish). {target} is a branch name. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." }),
  fix: msg({ id: 'workflow.refused.merge.combworkMerges.nextPausedFix', defaultMessage: "{reader, select, you {It is in the merge queue for {target}, which is paused until you fix what stopped it and resume it; it moves to Done once merged, or comes back.} other {It is in the merge queue for {target}, which is paused until the user fixes what stopped it and resumes it: wait for Done, or for it to come back.}}", description: 'The next step after a refused merge of a card in a merge queue paused by something only the user can fix (an error from git, say), then Resume. {target} is a branch name. {reader} (select): you is the window\'s wording, other the agent\'s (the user named as the user); translate both whole sentences.' }),
  folder: msg({ id: 'workflow.refused.merge.combworkMerges.nextPausedFolder', defaultMessage: "{reader, select, you {It is in the merge queue for {target}, which is paused until you put right the folder {target} is checked out in and resume it; it moves to Done once merged, or comes back.} other {It is in the merge queue for {target}, which is paused until the user puts right the folder {target} is checked out in and resumes it: wait for Done, or for it to come back.}}", description: "The next step after a refused merge of a card in a merge queue paused for the folder its branch is checked out in (on another branch, files staged or changed, agents at work there). {target} is a branch name. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." }),
  rules: msg({ id: 'workflow.refused.merge.combworkMerges.nextPausedRules', defaultMessage: "{reader, select, you {It is in the merge queue for {target}, which paused while workflow rules were off and moves on once they are enforced again (if they already are, once you resume it); it moves to Done once merged, or comes back.} other {It is in the merge queue for {target}, which paused while workflow rules were off and moves on once they are enforced again (if they already are, once the user resumes it): wait for Done, or for it to come back.}}", description: 'The next step after a refused merge of a card in a merge queue that paused while the workflow rules were turned off: Combwork resumes it when they are turned on again. {target} is a branch name. {reader} (select): you is the window\'s wording, other the agent\'s (the user named as the user); translate both whole sentences.' })
} satisfies Record<string, Msg>

/**
 * The next step of `platform.unknown` for a Git card whose repository is gone (#1419, S20: its `offer` value): Git's
 * rules hold until the repository is back or the project is switched to None, which applies from the next card.
 */
export const REPOSITORY_GONE_NEXT = msg({ id: 'workflow.refused.platform.unknown.nextGone', defaultMessage: "{reader, select, you {The project's Git repository is gone: restore it, or switch the project to None in its Version Control tab (from the next card).} other {The project's Git repository is gone: ask the user to restore it, or to switch the project to None in its Version Control tab (from the next card).}}", description: 'The next step when a card was refused because its Git repository was removed or moved: the user restores it, or switches the project to None (no version control) in the Version Control tab, which applies to cards started after. Read by agents and shown in the window. {reader} (select): you is the window\'s wording, other the agent\'s (the user named as the user); translate both whole sentences.' })

/** The next step of `move.notFromHere` when nothing can be done from the stage (a request answered meanwhile). */
/**
 * The next step after a start or submit refused on a card in Done (HI-2227): more work on it the user asked for takes it
 * back to Doing (work-on-card's after-review.md), and a separate follow-up is a new card. Other moves refused there (an
 * answer to a request no longer open) keep NOTHING_FROM_HERE.
 */
export const DONE_NEXT = msg({ id: 'workflow.refused.move.notFromHere.nextDone', defaultMessage: "{reader, select, you {It's finished. More work on it that you ask for takes it back to Doing; separate follow-up work goes on a new card.} other {It's finished. More work on it that the user asked for: move it back with cw_update_task (column: doing), then work on it as usual. Separate follow-up work goes on a new card (cw_create_task).}}", description: "The next step after an agent's start or submit was refused on a card in Done (HI-2227): more work on that card the user asked for moves it back to Doing; separate follow-up work is a new card. cw_update_task, cw_create_task and column: doing are a tool, its argument and value: keep them as they are. Doing is a column name: use it as Combwork shows it. {reader} (select): you is the window's wording, other the agent's (the user named as the user); translate both whole sentences." })

export const NOTHING_FROM_HERE = msg({ id: 'workflow.refused.move.notFromHere.nextNone', defaultMessage: 'Nothing waits to be done there now.', description: "The next step after a refused move when nothing is possible from the card's stage (the request it answered is no longer open)." })

/**
 * The next step of `move.notFromHere` by the side of the agent refused (#1604, its `whose` value from the runtime), where
 * the intents of the card's stage are the other side's: a reviewer's review or verdict on a card no longer in Review, or
 * its builder's move while it waits in Review.
 */
export const SIDE_NEXT = {
  reviewer: msg({ id: 'workflow.refused.move.notFromHere.nextReviewer', defaultMessage: '{back, select, yes {Its review is over: it went back for more work. Leave it where it is, with no verdict, and wait for it to come back to Review.} other {Its review is over: it has moved on from Review. Leave it where it is, with no verdict.}}', description: "The next step after a reviewer's review or verdict was refused because the card is no longer in Review (#1604): its review ended. back (select): yes when the card went back to be worked on (Todo or Active), other when it moved on (approved, merged). Review is a stage name: use it as Combwork shows it. Read by agents and shown in the window alike: it names no one. Translate each sentence." }),
  builder: msg({ id: 'workflow.refused.move.notFromHere.nextBuilder', defaultMessage: "It waits for its reviewer's verdict: wait for that, which brings it back if there is more to do.", description: "The next step after a card's builder was refused a move while the card waits in Review for its reviewer (#1604): the review's verdict comes first. Read by agents and shown in the window alike: it names no one." }),
  builderSubmit: msg({ id: 'workflow.refused.move.notFromHere.nextBuilderSubmit', defaultMessage: "A change asked for while it is in Review, committed: submit it again with followUp: true, which keeps it in Review for its reviewer to check. Anything else waits for its reviewer's verdict.", description: "The next step after a card's builder submitted it again while it waits in Review (HI-1832): the verdict comes first, but a change the reviewer asked for is submitted as a follow-up. followUp is the tool's option, as agents type it: keep it as it is. Read by agents and shown in the window alike: it names no one." })
} satisfies Record<string, Msg>

/**
 * A refusal's values: names and numbers, the same in every language, or a message of its own kept as data (what a
 * platform couldn't read, texts.ts). {stage}, {move}, {intent}, {moves}, {rule} and {rules} hold the code's names, which
 * agents read as they are (a stage by its board name in English) and the window shows through texts.ts's messages.
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
  /** What else the agent should know, in English (HI-2339: the files a None submit's paths leave out). */
  warnings?: string[]
  /**
   * HI-2854: a refused submit's unseen decisions and comments of the user's, each in full with who and when (agent text):
   * received with the refusal, so the next submit goes on unless more came meanwhile.
   */
  unread?: string[]
}

/** How a refusal's sentences are formatted: in English for agents, or in the window's language (`refusalLines`). */
export interface RefusalFormat {
  one: (m: Msg, values?: Record<string, string | number>) => string
  list: (items: string[]) => string
  /** Whether names in the code are shown through their messages (the window) or as they are (agents). */
  names: boolean
  /** The project's own stage names (N5), where the window knows them: a renamed stage is named so. */
  stageNames?: StageNames | null
  /** The user's own move refused (the board's drag, the card dialog): a rule with words of its own for them (`FOR_USER`). */
  forUser?: boolean
  /**
   * Who reads it (HI-1585, glossary §1 rule 10): the window says *you* for the user, agents read *the user*; a sentence that
   * names the user has both, chosen by `{reader}` (never kept in the refusal's values). The window's, unless said.
   */
  reader?: 'you' | 'agent'
}

/**
 * A refusal's sentences where the user's own move is refused, for rules whose words are the agent's (HI-1851): the board's
 * toast names the card in its title ("AL-2 can't move to Review"), so the message doesn't again.
 */
const FOR_USER: Partial<Record<RuleId, Partial<Omit<RefusalText, 'change'>>>> = {
  'submit.empty': {
    message: msg({ id: 'workflow.refused.submit.empty.messageForUser', defaultMessage: 'Nothing is committed to review yet.', description: "A refused move of a card to Review by the user (a drag on the board): the card's line has no commit since it started. Shown under a title that names the card and the column, so it doesn't name them." }),
    next: msg({ id: 'workflow.refused.submit.empty.nextForUser', defaultMessage: "Commit the card's work, then move it again.", description: 'The next step after the user\'s move of a card to Review was refused with nothing committed: commit the work, then move the card again.' })
  }
}

// agent-stored: a refusal's sentences, said again in the reader's dialect by refusalBody (dialects, HI-2440)
const IN_ENGLISH: RefusalFormat = { one: (m, values) => englishText(values ? { m, values } : m), list: (items) => items.join(', '), names: false, reader: 'agent' }
/** Agents' sentences in the current chain (dialects, HI-2440): each message's override, else IN_ENGLISH's words. */
const IN_AGENTS: RefusalFormat = { ...IN_ENGLISH, one: (m, values) => agentText(values ? { m, values } : m) }

/**
 * Values a rule's text takes that refusals recorded earlier don't have (their facts keep the values of their time), and
 * what each was then: `submit.checksPassed`'s last run's reason (#1654), none before.
 */
const VALUES_BEFORE: Partial<Record<RuleId, Record<string, string>>> = {
  'submit.checksPassed': { why: 'none', files: 'none', copy: 'no' }, // i18n-ignore: select keys, never shown
  'move.doingNobody': { also: 'no' }, // i18n-ignore: select keys, never shown
  'submit.empty': { changes: 'unknown' }, // i18n-ignore: select keys, never shown
  'submit.trailer': { at: 'head' } // i18n-ignore: select keys, never shown
}

/** The three sentences of a refusal, formatted by `f`: `change` null when the rule has none. */
export function refusalLines(rule: RuleId, values: RefusalValues, f: RefusalFormat): { message: string; next: string; change: string | null } {
  const t = REFUSALS[rule]
  // A refusal recorded before its rule's text took a value has none of it: the value its text had before (#1654).
  const vals: Record<string, string | number> = { ...VALUES_BEFORE[rule] }
  for (const [k, v] of Object.entries(values)) vals[k] = typeof v === 'object' ? (workflowLine(v, f.one) ?? '') : v
  // Who reads it: the format's, never a value the refusal recorded.
  vals.reader = f.reader ?? 'you'
  // A stage by its name (stages.ts), as the board shows it, to agents too (#1604: "Active", never the id "active"): the
  // project's own, else its message; an id this Combwork doesn't know as it is.
  const stage = (x: string): string => f.stageNames?.[x as keyof StageNames] || (isStageId(x) ? f.one(STAGE_TEXT[x]) : x)
  if (typeof vals.stage === 'string') vals.stage = stage(vals.stage)
  // A list of stages (`move.noStage`'s), each by its stage name.
  if (vals.stages !== undefined) vals.stages = f.list(String(vals.stages).split(', ').filter(Boolean).map(stage))
  if (f.names) {
    // Intents and rules by their names in the window; agents get them as they are, the names they call them by.
    const name = (x: string): string => {
      const m = MOVE_NAMES[x] ?? RULE_NAMES[x]
      return m ? f.one(m) : stage(x)
    }
    const names = (s: string | number): string => f.list(String(s).split(', ').filter(Boolean).map(name))
    for (const k of ['move', 'intent', 'rule'] as const) if (typeof vals[k] === 'string') vals[k] = name(vals[k] as string)
    for (const k of ['moves', 'rules'] as const) if (vals[k] !== undefined) vals[k] = names(vals[k])
  }
  // The {why} of a rule with several reasons is the whole sentence of its `cause`.
  if (typeof values.cause === 'string' && Object.hasOwn(WHY, values.cause)) vals.why = f.one(WHY[values.cause as keyof typeof WHY], { n: vals.n ?? 0, q: vals.q ?? 0 })
  const paused = values.queue === 'paused' && typeof values.waits === 'string' && Object.hasOwn(PAUSED_NEXT, values.waits) ? PAUSED_NEXT[values.waits as keyof typeof PAUSED_NEXT] : null
  const queued = rule === 'merge.combworkMerges' && typeof values.queue === 'string' && Object.hasOwn(QUEUE_NEXT, values.queue) ? (paused ?? QUEUE_NEXT[values.queue as keyof typeof QUEUE_NEXT]) : null
  const side = rule === 'move.notFromHere' && typeof values.whose === 'string' && Object.hasOwn(SIDE_NEXT, values.whose) ? SIDE_NEXT[values.whose as keyof typeof SIDE_NEXT] : null
  const user = f.forUser ? FOR_USER[rule] : undefined
  const done = rule === 'move.notFromHere' && values.stage === 'done' && (values.move === 'start' || values.move === 'submit') ? DONE_NEXT : null
  const next = user?.next ?? side ?? done ?? (rule === 'move.notFromHere' && !values.moves ? NOTHING_FROM_HERE : rule === 'platform.unknown' && values.offer === 'repositoryGone' ? REPOSITORY_GONE_NEXT : (queued ?? t.next))
  return { message: f.one(user?.message ?? t.message, vals), next: f.one(next, vals), change: t.change ? f.one(t.change, vals) : null }
}

/**
 * A workflow refusal as the Agent API gives it (SPEC §16.8.3): its rule, three sentences, who can override, and its
 * warnings (HI-2339). The sentences are the reader's (dialects, HI-2440): with a chain that overrides texts, they are said
 * again from the rule and its values in it; with none, they are those the refusal was made with, as they always were.
 */
export function refusalBody(x: Refusal): Record<string, unknown> {
  const l = currentChain() ? refusalLines(x.rule, x.values, IN_AGENTS) : { message: x.message, next: x.next, change: x.change ?? null }
  return { refused: true, rule: x.rule, message: l.message, next: l.next, ...(l.change ? { change: l.change } : {}), override: x.override, ...(x.warnings?.length ? { warnings: x.warnings } : {}), ...(x.unread?.length ? { unread: x.unread } : {}) }
}

/** Builds a refusal from its rule and values: three English sentences, each from its own message. */
// i18n-ignore: the override field's values are agent-facing English (§16.8.3)
export function refusal(rule: RuleId, values: RefusalValues, override: Refusal['override'] = /* agent-protocol: who can override, the Agent API's fixed `override` value (AGENT_API.md) */ 'the user'): Refusal {
  const l = refusalLines(rule, values, IN_ENGLISH)
  return { refused: true, rule, message: l.message, next: l.next, ...(l.change !== null ? { change: l.change } : {}), override, values }
}
