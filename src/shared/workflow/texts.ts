// The workflow core's text for the window (SPEC §16.8.3, §16.8.5; #1264), as messages kept as data. What main records
// keeps its English (agents, the Agent API and the log read it) and, beside it, a `StoredText` (the message's id and
// values) that the window formats in its language: a For you request, what a platform couldn't read. A refusal's values
// that are names in the code (a stage, an intent, a rule) are shown through these messages too (`refusalLines`).
// Main and the window both use it.

import { englishText } from '../advanced'
import { msg, type MessageArgs, type Msg } from '../i18n/msg'
import type { StoredText } from '../types'
import { storedLineText } from '../taskHistory'

/** What Hive asks the user (For you, §16.8.5): `ApprovalRequested`'s text and the notification with it. */
export const FOR_YOU = {
  review: msg({ id: 'workflow.forYou.review', defaultMessage: '{card} waits for your review', description: 'A For you request: the card waits for the user to review it (Version Control → Work is reviewed before it is merged: You). {card} is a card key like AM-12.' }),
  okBefore: msg({ id: 'workflow.forYou.okBefore', defaultMessage: '{card} is approved: OK to merge?', description: "A For you request: the card passed review and waits for the user's OK before it merges (glossary 2.3: approval). {card} is a card key like AM-12." }),
  passedReview: msg({ id: 'workflow.forYou.passedReview', defaultMessage: '{card} passed review: your OK?', description: "A For you request: reviewer agents passed the card, and the user reviews after them (A reviewer agent, then you). {card} is a card key like AM-12." }),
  newDecision: msg({ id: 'workflow.forYou.newDecision', defaultMessage: '{card} has a new decision: your review again?', description: 'A For you request: the user decided something new on a card in Review, so their review is asked again. {card} is a card key like AM-12.' }),
  slotDirty: msg({ id: 'workflow.forYou.slotDirty', defaultMessage: '{card} is Done, but {slot} has uncommitted changes, so it stays on {line}. Commit or discard them there: Hive then detaches the slot at {target}, ready for its next card.', description: "A For you request (Decide, HI-2014): a card reached Done while its slot (a reused working folder, such as slot-b) had uncommitted changes, so Hive left the slot on the card's branch {line} instead of detaching it at the target branch {target}. {card} is a card key like AM-12; {slot}, {line} and {target} are names, kept as they are." }),
  decidedAfterMerge: msg({ id: 'workflow.forYou.decidedAfterMerge', defaultMessage: '{card} was decided after it merged: does it need a follow-up?', description: "A For you request (Decide): a decision was recorded on the card while its work was being merged, so the merged work didn't see it. {card} is a card key like AM-12." }),
  lineAsk: msg({ id: 'workflow.forYou.lineAsk', defaultMessage: "{line} still has {card}'s work, squashed into {target}: approve and Hive brings the branch up to date once, or decline and do it yourself before {next} starts.", description: "A For you request (approve or decline, §16.19.2): Settings → Advanced has Hive ask before moving an agent's branch after a squash merge. Approving lets Hive move it this once (git reset --keep, which never overwrites uncommitted work); declining leaves it to the user. {line} a branch name; {card} and {next} card keys like AM-12; {target} the branch merged into." }),
  lineWork: msg({ id: 'workflow.forYou.lineWork', defaultMessage: "{line} has work that isn't in {target}: {commits}. Decide what happens to it: {next} starts once the branch is up to date.", description: "A For you request (Decide, §16.19.2): the builder's branch has commits that weren't merged (made after the card was approved, say), so Hive won't move the branch and lose them; the lane waits. {line} a branch name, {target} the branch merged into, {commits} a list of short commit ids with their subjects, {next} a card key." }),
  lineRefused: msg({ id: 'workflow.forYou.lineRefused', defaultMessage: "Git wouldn't bring {line} up to date with {target}: {reason}. {next} starts once the branch is up to date.", description: "A For you request (Decide, §16.19.2): Hive tried to move the builder's branch after a squash merge and git refused; the lane waits. {line} a branch name, {target} the branch merged into, {reason} git's own message (English), {next} a card key." }),
  lineUnfinished: msg({ id: 'workflow.forYou.lineUnfinished', defaultMessage: "Hive's move of {line} to {to} didn't finish and couldn't be put back. Bring the branch to {target} with its files and index clean, or back where it was: {next} starts once it is settled.", description: "A For you request (Decide, §16.19.2): moving the builder's branch failed part way and Hive couldn't undo it, so the branch, its files or its index may disagree; the lane waits. {line} a branch name, {to} a short commit id, {target} the branch merged into, {next} a card key." }),
  focusedSkip: msg({ id: 'workflow.forYou.focusedSkip', defaultMessage: '{card}’s focused tests were skipped at its merge: {tests}. Merge it with them skipped?', description: 'A For you request (Approve, G20, HI-1367): the merge queue ran the card’s focused tests ({tests}: test names, each with why it was skipped in brackets, as its project’s runner said) and some were skipped for their environment (a usage limit, a sign-in, the network). Approve merges the card with them skipped; Decline returns it. The card’s reviewer agent is asked too.' }),
  queueAdvance: msg({ id: 'workflow.forYou.queueAdvance', defaultMessage: '{card} is tested and ready to merge: update {target} in {folder} now?', description: "A For you request (Approve, §16.9.2): the merge queue has merged and checked the card's work, and waits for the user's OK before it updates the branch {target}, which is checked out in the folder {folder} (its files change there). Settings → Advanced → Merge into a checked-out branch: Ask each time. {card} is a card key like AM-12." }),
  mergeChoice: msg({ id: 'workflow.forYou.mergeChoice', defaultMessage: "How should Hive merge {project}'s cards into {target}? Choose the merge style and the commit message: until now Hive made a merge commit with its own message (the card's key and title, with trailers). The merge queue waits for your answer.", description: "A For you request (Decide, HI-1697): a project from before Hive 1.0 reached the merge queue for the first time, and nobody chose how its cards are merged, so the queue asks. {project} is a project's name, {target} the branch merged into. Merge style and Commit message are workflow options' names (glossary 2.6): use their words. Trailers: git's “Key: value” lines at a message's end." }),
  queueStuck: msg({
    id: 'workflow.forYou.queueStuck',
    defaultMessage:
      "{card}'s merge into {target} stopped part way in {folder}, with {files, plural, one {# file} other {# files}} left between the two, and Hive changes nothing more there. The card's Work section lists each file and its side, and the commands to copy. {how, select, both {To finish it, run {finish} (PowerShell) in {project}; to undo it, run {undo} (PowerShell) in {folder}.} finish {To finish it, run {finish} (PowerShell) in {folder}.} undo {To undo it, run {undo} (PowerShell) in {folder}.} other {Its files are neither as they were nor as merged: put them right by hand.}} Then answer here, and the queue looks again.",
    description:
      "A For you request (Decide, §16.9.2's terminal state): the merge queue was updating the branch {target}, checked out in the folder {folder}, and something (a crash, another program) left it half done, so the merge queue for {target} is paused until the user settles it. {card} is a card key like AM-12; {files} how many files the merge left part way; the card's Work section is a section of the card's dialog (glossary 2.4: work); {project} the project folder; {finish} and {undo} are git commands for PowerShell (keep them exactly, with (PowerShell) after them). Translate each choice of {how}; keep the codes before the braces."
  }),
  roundLimit: msg({ id: 'workflow.forYou.roundLimit', defaultMessage: '{card} failed {rounds, plural, one {# review} other {# reviews}}: carry on with more rounds, split it, accept it with follow-ups, or take it over?', description: "A For you request (Decide): the card reached its card loop's round limit (Settings → Card loops), so its loop pauses until the user chooses one of four ways on. {card} is a card key like AM-12; {rounds} the reviews it failed (a number)." })
}

/** A For you request's kind (§16.8.5, OP-11), as the window names it. */
export const FOR_YOU_KIND = msg({ id: 'workflow.forYouKind', defaultMessage: '{kind, select, approve {Approve} decide {Decide} test {Test} signIn {Sign in} other {Other}}', description: 'The kind of a request for the user (For you), shown as its label: approve something, decide something, test something, sign in somewhere, or anything else. Translate each choice; keep the codes before the braces.' })

/** The optional note beside Approve (HI-2286), saying what it becomes (`approveNote`): For you and the card's merge queue. */
export const APPROVE_NOTE = msg({ id: 'workflow.approveNote', defaultMessage: '{becomes, select, decision {Note (optional): also recorded as your decision} reason {Note (optional): the reason for what the agent asked} other {Note (optional): added as your comment}}', description: "The label and placeholder of an optional text box beside Approve (For you, the card dialog's merge queue): a note sent with the approval. It says what the note becomes: on an agent's question (decision), one of the card's decisions as well as the user's comment; on a question that offers one action (reason), the reason for that action; on Hive's own requests (other), the user's comment on the card. Keep the select keys as they are; translate each choice. Glossary: decision." })

/** The user's choices at a card's round limit (§16.11.4), as the window names them. */
export const ROUND_CHOICE = msg({ id: 'workflow.roundChoice', defaultMessage: '{choice, select, carryOn {Carry on} split {Split it} accept {Accept with follow-ups} takeOver {Take it over} other {{choice}}}', description: "One of the user's four choices when a card reaches its card loop's round limit: carry on with more review rounds, split the card into smaller ones, accept the work as it is with follow-up cards, or take the work over themselves. Translate each choice; keep the codes before the braces." })

/**
 * What a platform couldn't read (§16.3.1), the {what} of "Hive couldn't read {what}" (workflow.refused.platform.unknown):
 * each a noun phrase, the object of that sentence. Revisions are short ids, folders paths, branches names.
 */
export const UNREADABLE = {
  gitFolder: msg({ id: 'workflow.unreadable.gitFolder', defaultMessage: 'the Git folder of {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the repository\'s .git folder. {folder} is a folder path.' }),
  head: msg({ id: 'workflow.unreadable.head', defaultMessage: 'the latest commit in {where}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the commit checked out in a folder, or at the tip of a branch. {where} is a folder path or a branch name.' }),
  branch: msg({ id: 'workflow.unreadable.branch', defaultMessage: 'the branch checked out in {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {folder} is a folder path.' }),
  line: msg({ id: 'workflow.unreadable.line', defaultMessage: 'the branch {branch}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": a Git branch. {branch} is its name.' }),
  revision: msg({ id: 'workflow.unreadable.revision', defaultMessage: 'the revision {revision}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …" (glossary 2.3: revision). {revision} is a commit id or name.' }),
  files: msg({ id: 'workflow.unreadable.files', defaultMessage: 'the files of {revision}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the files as they are at a revision. {revision} is a commit id or name.' }),
  defaultBranch: msg({ id: 'workflow.unreadable.defaultBranch', defaultMessage: 'the default branch of {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the branch work merges into by default. {folder} is a folder path.' }),
  contains: msg({ id: 'workflow.unreadable.contains', defaultMessage: 'whether {revision} is in {target}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {revision} and {target} are short commit ids.' }),
  branchedOff: msg({ id: 'workflow.unreadable.branchedOff', defaultMessage: 'where {a} and {b} branched off', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the commit two lines of work have in common. {a} and {b} are commit ids or branch names.' }),
  branchedOffTarget: msg({ id: 'workflow.unreadable.branchedOffTarget', defaultMessage: 'where the work branched off its target', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the commit the card\'s work and the branch it merges into have in common.' }),
  uncommitted: msg({ id: 'workflow.unreadable.uncommitted', defaultMessage: 'the uncommitted changes in {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {folder} is a folder path.' }),
  state: msg({ id: 'workflow.unreadable.state', defaultMessage: 'the state of {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": whether a merge or rebase is going on in the folder. {folder} is a folder path.' }),
  filesChanged: msg({ id: 'workflow.unreadable.filesChanged', defaultMessage: 'the files changed from {from} to {to}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {from} and {to} are short commit ids.' }),
  change: msg({ id: 'workflow.unreadable.change', defaultMessage: 'the change from {from} to {to}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …" (glossary 2.3: change). {from} and {to} are short commit ids.' }),
  changeFingerprint: msg({ id: 'workflow.unreadable.changeFingerprint', defaultMessage: "the change's fingerprint", description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": what tells a change apart from others (glossary 2.3: change).' }),
  replayedFiles: msg({ id: 'workflow.unreadable.replayedFiles', defaultMessage: 'the files of the change applied again', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the result of applying the change again on another commit, to tell whether two revisions are the same change.' }),
  replay: msg({ id: 'workflow.unreadable.replay', defaultMessage: '{revision} applied onto {onto}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the result of applying a revision\'s change onto another commit. {revision} and {onto} are short commit ids.' }),
  target: msg({ id: 'workflow.unreadable.target', defaultMessage: 'the target branch {target}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the branch the work merges into. {target} is its name.' }),
  history: msg({ id: 'workflow.unreadable.history', defaultMessage: 'the history of {target}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the commits of a branch. {target} is a branch name.' }),
  commitsOn: msg({ id: 'workflow.unreadable.commitsOn', defaultMessage: 'the commits on {target}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {target} is a branch name.' }),
  holdsChange: msg({ id: 'workflow.unreadable.holdsChange', defaultMessage: 'whether {where} holds the change', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": whether the card\'s change is already in a commit or branch (glossary 2.3: change). {where} is a short commit id or a branch name.' }),
  commitsSince: msg({ id: 'workflow.unreadable.commitsSince', defaultMessage: 'the commits of {revision} since {base}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {revision} and {base} are short commit ids.' }),
  commitsOf: msg({ id: 'workflow.unreadable.commitsOf', defaultMessage: 'the commits of {range}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …". {range} is a Git range of commits, like a1b2c3d..e4f5a6b.' }),
  worktrees: msg({ id: 'workflow.unreadable.worktrees', defaultMessage: 'the worktrees of {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the Git worktrees of a repository. {folder} is its folder path.' }),
  folderFor: msg({ id: 'workflow.unreadable.folderFor', defaultMessage: 'a folder for {branch}', description: 'What Hive couldn\'t make, the object of "Hive couldn\'t read …": a working folder (a Git worktree) for a branch. {branch} is its name.' }),
  revisionIn: msg({ id: 'workflow.unreadable.revisionIn', defaultMessage: 'the revision in {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the revision checked out in a folder (glossary 2.3: revision). {folder} is a folder path.' }),
  deliverables: msg({ id: 'workflow.unreadable.deliverables', defaultMessage: 'the work in {project}: it has over {n, plural, one {# file} other {# files}}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": a project without version control has too many files to read its work. {project} is a project name, {n} the limit.' }),
  pathOutside: msg({ id: 'workflow.unreadable.pathOutside', defaultMessage: 'the path {path}, which is outside the project', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": a card\'s path that isn\'t in its project. {path} is the path.' }),
  cardPathsFiles: msg({ id: 'workflow.unreadable.cardPathsFiles', defaultMessage: "the card's paths: they hold over {n, plural, one {# file} other {# files}}", description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the files a card names hold too many files. {n} is the limit.' }),
  cardPathsSize: msg({ id: 'workflow.unreadable.cardPathsSize', defaultMessage: "the card's paths: they hold over {n, number} GB", description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the files a card names are too large. {n} is a size in gigabytes (GB, of 1024 MB): write the unit as your language does.' }),
  writes: msg({ id: 'workflow.unreadable.writes', defaultMessage: 'the files written in {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": which files changed in a folder. {folder} is a folder path.' }),
  ignored: msg({ id: 'workflow.unreadable.ignored', defaultMessage: 'what Git ignores in {folder}', description: 'What Hive couldn\'t read, the object of "Hive couldn\'t read …": the files Git is told to leave out. {folder} is a folder path.' })
}

/**
 * What an agent or the user asked for, named in a refusal's {move}, {intent} and {moves} (agents read the intent's name,
 * the window this). Keys are the names the runtime records.
 */
export const MOVE_NAMES: Record<string, Msg> = {
  start: msg({ id: 'workflow.move.start', defaultMessage: 'Start', description: 'A move on a card, named in a refused move ("… isn\'t possible from there"): starting work on it.' }),
  'put back': msg({ id: 'workflow.move.putBack', defaultMessage: 'Put back', description: 'A move on a card, named in a refused move: putting a started card back in Todo.' }),
  submit: msg({ id: 'workflow.move.submit', defaultMessage: 'Submit for review', description: 'A move on a card, named in a refused move: sending its work to Review.' }),
  'declare paths': msg({ id: 'workflow.move.declarePaths', defaultMessage: "Set the card's paths", description: 'A move on a card, named in a refused move: saying which files are its work (a project without version control).' }),
  'start review': msg({ id: 'workflow.move.startReview', defaultMessage: 'Start review', description: 'A move on a card, named in a refused move: a reviewer beginning a review.' }),
  verdict: msg({ id: 'workflow.move.verdict', defaultMessage: 'Verdict', description: 'A move on a card, named in a refused move: a reviewer passing or failing it (glossary 2.3: verdict).' }),
  'report merge': msg({ id: 'workflow.move.reportMerge', defaultMessage: 'Report the merge', description: 'A move on a card, named in a refused move: the agent saying it merged the work.' }),
  'retry merge': msg({ id: 'workflow.move.retryMerge', defaultMessage: 'Retry merge', description: "A move on a card, named in a refused move: the user's Retry merge on the merge queue's card." }),
  'remove from queue': msg({ id: 'workflow.move.removeFromQueue', defaultMessage: 'Remove from queue', description: "A move on a card, named in a refused move: the user taking it out of the merge queue." }),
  'loop step': msg({ id: 'workflow.move.loopStep', defaultMessage: 'Card loop step', description: "A move on a card, named in a refused move (#1382): a step between a card loop's builder and reviewer that moves nothing (a design posted for a check, its answer)." }),
  move: msg({ id: 'workflow.move.move', defaultMessage: 'Move', description: 'A move on a card, named in a refused move: dragging it to another column.' }),
  answer: msg({ id: 'workflow.move.answer', defaultMessage: 'Answer', description: "A move on a card, named in a refused move: the user's answer to a For you request (Approve, Decline, a reply)." })
}

/** A rule as the user reads it (glossary 3: a gate is a rule), for a refusal's {rule} and {rules}: the option it comes from. */
export const RULE_NAMES: Record<string, Msg> = {
  'card.kind': msg({ id: 'workflow.rule.card.kind', defaultMessage: "A card's kind is set when it is made", description: "A rule of the workflow, named where a change skips it: a card is code or no code (a decision, a write-up, a trial) from when it is made; changing it later is an exception the user makes (glossary: override)." }),
  'move.doingNobody': msg({ id: 'workflow.rule.move.doingNobody', defaultMessage: 'A card in Active has someone on it, unless you say otherwise', description: "A rule of the workflow, named where a move skips it (HI-2062): the Hive Assistant moves a card into Active with nobody on it only with the user's reason (glossary: override). Active is a stage's name." }),
  'start.notBlocked': msg({ id: 'workflow.rule.start.notBlocked', defaultMessage: "Blocked cards don't start", description: 'A rule of the workflow, named where a move skips or can\'t check it.' }),
  'start.dependenciesIntegrated': msg({ id: 'workflow.rule.start.dependenciesIntegrated', defaultMessage: 'Cards start only when the cards they wait for are done', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: N6, G14).' }),
  'start.slotAvailable': msg({ id: 'workflow.rule.start.slotAvailable', defaultMessage: 'Each card in its own folder', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G11 values): a card starts only when a folder is free.' }),
  'submit.notDuplicate': msg({ id: 'workflow.rule.submit.notDuplicate', defaultMessage: 'Work is submitted once', description: 'A rule of the workflow, named where a move skips or can\'t check it: the same revision isn\'t submitted twice.' }),
  'requeue.allowed': msg({ id: 'workflow.rule.requeue.allowed', defaultMessage: 'Unchanged work is queued again only after a failure outside it', description: 'A rule of the workflow, named where a move skips or can\'t check it: work goes back into the merge queue unchanged only after a merge failed for a reason outside the work (a network error, a timeout).' }),
  'submit.ready': msg({ id: 'workflow.rule.submit.ready', defaultMessage: 'Work has no unresolved conflicts', description: 'A rule of the workflow, named where a move skips or can\'t check it.' }),
  'submit.clean': msg({ id: 'workflow.rule.submit.clean', defaultMessage: 'Work is committed before review', description: 'A rule of the workflow, named where a move skips or can\'t check it.' }),
  'submit.trailer': msg({ id: 'workflow.rule.submit.trailer', defaultMessage: 'Commits name their card', description: 'A rule of the workflow, named where a move skips or can\'t check it: in a shared folder, each commit names its card.' }),
  'submit.checksPassed': msg({ id: 'workflow.rule.submit.checksPassed', defaultMessage: 'Checks pass before review', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: N3, G3).' }),
  'submit.focusedChosen': msg({ id: 'workflow.rule.submit.focusedChosen', defaultMessage: 'Each card’s focused tests are chosen before review', description: 'A rule of the workflow, named where a move skips or can’t check it (G20, HI-1367): the tests a card’s change needs are chosen, or named by its builder, when it is submitted.' }),
  'submit.identity': msg({ id: 'workflow.rule.submit.identity', defaultMessage: "Commits use the project's identity", description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G12).' }),
  'submit.ownRunsStopped': msg({ id: 'workflow.rule.submit.ownRunsStopped', defaultMessage: 'Agents stop what they started before review', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G13).' }),
  'submit.decisionsReceived': msg({ id: 'workflow.rule.submit.decisionsReceived', defaultMessage: 'The builder has read every decision', description: 'A rule of the workflow, named where a move skips or can\'t check it: the agent who built the card has read every decision on it (glossary 2.5: builder).' }),
  'review.notAuthor': msg({ id: 'workflow.rule.review.notAuthor', defaultMessage: 'Nobody reviews their own work', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: N2, G2).' }),
  'review.decisionsReceived': msg({ id: 'workflow.rule.review.decisionsReceived', defaultMessage: 'The reviewer has read every decision', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.5: reviewer).' }),
  'verdict.reviewing': msg({ id: 'workflow.rule.verdict.reviewing', defaultMessage: 'A verdict follows a review', description: 'A rule of the workflow, named where a move skips or can\'t check it: a reviewer starts a review before giving a verdict (glossary 2.3: verdict).' }),
  'verdict.currentSubmission': msg({ id: 'workflow.rule.verdict.currentSubmission', defaultMessage: 'A verdict is on the latest submission', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.3: verdict).' }),
  'approval.given': msg({ id: 'workflow.rule.approval.given', defaultMessage: 'Your OK before merging', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G10).' }),
  'integrate.approved': msg({ id: 'workflow.rule.integrate.approved', defaultMessage: "Work is reviewed before it's merged", description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G1).' }),
  'integrate.upToDate': msg({ id: 'workflow.rule.integrate.upToDate', defaultMessage: 'Work is up to date before it merges', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G8, without the branch name).' }),
  'integrate.checksPassed': msg({ id: 'workflow.rule.integrate.checksPassed', defaultMessage: 'Checks pass on the merged result', description: 'A rule of the workflow, named where a move skips or can\'t check it (glossary 2.6: G9).' }),
  'done.contained': msg({ id: 'workflow.rule.done.contained', defaultMessage: 'Hive checks the merge', description: 'A rule of the workflow, named where a move skips or can\'t check it: a card is done only when its work is in its target (glossary 2.6: G5).' })
}

/** A card's slot notices, shown on the card as its notify action's text (HI-1796: a preparation that failed; HI-1746: a placement waiting or giving up). */
export const SLOT_NOTICES = {
  notPrepared: msg({ id: 'service.slots.notPrepared', defaultMessage: "Hive couldn't get {slot} ready for {card}: {why}", description: "A notice: a card was started in a slot (a worktree Hive lends to a card or a lane), and Hive couldn't check out the card's branch there or install its dependencies. {slot} is the slot's name (slot-b), {card} the card's key, {why} git's or the setup's reason, in English." }),
  resumeHeld: msg({ id: 'service.slots.resumeHeld', defaultMessage: "Hive can't give {card} to {agent} yet: {agent}'s conversation in {slot} can't resume now ({why}). Hive gives it {card} once it can.", description: "A notice (HI-1746): a card was started for an agent (its builder) in a slot, and Hive hasn't handed the card to it yet; the agent's last conversation, in that slot, can't be resumed now, and Hive never starts a new conversation instead. {card} is the card's key, {agent} the agent's name, {slot} the slot's name (slot-b), {why} the reason, in English." }),
  resumeFailed: msg({ id: 'service.slots.resumeFailed', defaultMessage: "Hive couldn't resume {agent}'s conversation in {slot} for {card} (three tries): {why}. Resume {agent} from Sessions, or start it fresh, and Hive gives it {card}.", description: "A notice (HI-1746): a card was started for an agent (its builder) in a slot, and Hive's resumes of the agent's last conversation there failed three times, so it stopped trying. Once the user resumes the agent, or starts it, Hive hands it the card. {card} is the card's key, {agent} the agent's name, {slot} the slot's name (slot-b), {why} the last failure's reason, in English." })
}

const BY_ID = new Map<string, Msg>([...Object.values(FOR_YOU), FOR_YOU_KIND, ROUND_CHOICE, ...Object.values(UNREADABLE), ...Object.values(MOVE_NAMES), ...Object.values(RULE_NAMES), ...Object.values(SLOT_NOTICES)].map((m) => [m.id, m]))

/** The workflow's message of an id: null for one this Hive doesn't know (a record from a newer one). */
export const workflowMessage = (id: string): Msg | null => BY_ID.get(id) ?? null

/** A workflow message and its values as they are kept in a fact: its id and values, never its English. */
export function workflowText<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): StoredText {
  const v = values[0] as Record<string, string | number> | undefined
  return v ? { id: m.id, values: v } : { id: m.id }
}

/** A stored workflow text by `format` (the window's language, or English); null when this Hive doesn't know its message. */
export const workflowLine = (s: unknown, format: (m: Msg, values?: Record<string, string | number>) => string): string | null => storedLineText(s, format, workflowMessage)

/**
 * The notes main records in a fact's `platform.unknown` for a field it read nothing of (recorder.ts), in English for
 * agents: the window words each itself (`unreadWhy`, #1477), for facts recorded before and since alike.
 */
export const UNREAD_NOTES = {
  /** The reads weren't made for the card's agent before the change (it had none, or another's): nothing was read. */
  beforeChange: 'not read before the change', // i18n-ignore: a fact's note, in English for agents
  /** A start with no head or target to find its base from. */
  noTarget: 'no target to start from', // i18n-ignore: a fact's note, in English for agents
  /** A submission with no base or head, so no files to compare. */
  noBaseOrHead: 'no base or head to compare' // i18n-ignore: a fact's note, in English for agents
} as const

/**
 * Why a fact's field wasn't read, for the window's messages that say so (the card dialog's Work section, #1477): one of
 * UNREAD_NOTES by its key (`note`: the message words it), else `other` with what couldn't be read by `format`, from the
 * reason kept as data (`platform.unknownText`), or its English for a fact without one.
 */
export function unreadWhy(field: string, of: { unknown: Record<string, string>; unknownText: Record<string, StoredText> }, format: (m: Msg, values?: Record<string, string | number>) => string): { note: string; why: string } {
  const english = of.unknown[field] ?? ''
  const note = (Object.keys(UNREAD_NOTES) as (keyof typeof UNREAD_NOTES)[]).find((k) => UNREAD_NOTES[k] === english)
  if (note) return { note, why: '' }
  const t = of.unknownText[field]
  return { note: 'other', why: (t && workflowLine(t, format)) || english }
}

/** A stored workflow text in English (agents, the Agent API, the log); its id when this Hive doesn't know it. */
export const workflowEnglish = (s: StoredText): string => workflowLine(s, (m, values) => englishText(values ? { m, values } : m)) ?? s.id
