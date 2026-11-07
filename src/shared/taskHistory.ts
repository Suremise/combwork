import { msg, type MessageArgs, type Msg } from './i18n/msg'
import type { StoredText } from './types'

/**
 * What Combwork writes in a card's history (#846, E10b of #677), as messages: main stores each entry's English in `what`
 * (agents read it, Combwork's own code matches it, scenarios too) and its message's id and values in `whatText`, and the
 * card dialog shows that in the window's language. Imports only msg.ts: cw-mcp reaches shared/tasks, and this stays
 * out of its way. A column (`{column}`) or a reason (`{why}`) is stored as its key and the message chooses its words;
 * other values are names, numbers and the user's own words, the same in every language.
 */
export const HISTORY = {
  startsWithout: msg({ id: 'tasks.history.startsWithout', defaultMessage: '{card} was moved to Done without its work in the target ({reason}): this card can start without it.', description: "A comment from Combwork on a card that depends on another (HI-2014): the user (or the Combwork Assistant with the user's reason) moved {card} (a card's key, such as HI-12) to Done by an override, without its work being merged into the target branch; this card no longer waits for it and starts without that work. {reason} is the override's reason, in the words it was given." }),
  kind: msg({ id: 'tasks.history.kind', defaultMessage: '{how, select, made {Made as no code} proposed {Proposed as no code} confirmed {Confirmed as no code} kept {Kept as code} other {Kind changed to {kind, select, code {code} other {no code}}}}', description: "A line in a card's history (#1277): the card's kind, code (the default) or no code (a decision, a write-up, a trial: no commits): it was made as no code, an agent proposed no code, the user or the Assistant confirmed that or kept it as code, or its kind was changed later (an exception to the rules). Select keys: translate each sentence." }),
  target: msg({ id: 'tasks.history.target', defaultMessage: '{own, select, yes {Merges into {target}} other {Merges into the project’s branch}}', description: "A line in a card's history (HI-2556): the branch its work merges into (its Merges into) was set: own yes, to {target} (a branch); else back to the project's Work merges into. Keep the select keys." }),
  reviewSkip: msg({ id: 'tasks.history.reviewSkip', defaultMessage: '{how, select, set {Set to skip review} proposed {Proposed to skip review} confirmed {Confirmed to skip review} kept {Kept with its review} other {Set to be reviewed}}', description: "A line in a card's history (#1625): whether the card skips its review: it was set to skip review (by the user, or the Assistant with the user's reason), an agent proposed that, the user or the Assistant confirmed it or kept the review, or it was set back to be reviewed. Select keys: translate each sentence." }),
  created: msg({ id: 'tasks.history.created', defaultMessage: 'Created in {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: the card was added, in this column. {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  moved: msg({ id: 'tasks.history.moved', defaultMessage: 'Moved to {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: the card was moved to this column. {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  movedTop: msg({ id: 'tasks.history.movedTop', defaultMessage: 'Moved to the top of {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: the card was put first in this column. {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  movedBottom: msg({ id: 'tasks.history.movedBottom', defaultMessage: 'Moved to the bottom of {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: the card was put last in this column. {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  movedBefore: msg({ id: 'tasks.history.movedBefore', defaultMessage: 'Moved to {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}, before {before}', description: "A line in a card's history: the card was moved to this column, just above card {before} (its key, such as HI-12; #12 in lines from before keys). {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  movedBeforeIn: msg({ id: 'tasks.history.movedBeforeIn', defaultMessage: 'Moved before {before} in {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: within its column, the card was moved just above card {before} (its key, such as HI-12; #12 in lines from before keys). {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  placed: msg({ id: 'tasks.history.placed', defaultMessage: 'Placed {place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} in {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A line in a card's history: an agent put the column's cards in order, and this card is now at place {place} (an ordinal: 2nd, 3rd). {column} is a board column (select: On Hold, Todo, Active, Review, Approved, Done): translate each." }),
  followUpSubmitted: msg({ id: 'tasks.history.followUpSubmitted', defaultMessage: 'Follow-up submitted for review at {revision}', description: "A line in a card's history (HI-1832): while the card was in Review, its builder submitted a change its reviewer asked for (a follow-up), which its reviewer reviews now, with no new round. {revision} is a commit's short hash (keep it as it is)." }),
  returned: msg({ id: 'tasks.history.returned', defaultMessage: 'Returned for review, round {round}', description: "A line in a card's history: after a failed review, the card was sent back for its next review; {round} is the round's number." }),
  renamed: msg({ id: 'tasks.history.renamed', defaultMessage: 'Renamed to "{title}"', description: "A line in a card's history: the card's title was changed to {title}." }),
  description: msg({ id: 'tasks.history.description', defaultMessage: 'Changed the description', description: "A line in a card's history: the card's description was edited." }),
  toProject: msg({ id: 'tasks.history.toProject', defaultMessage: 'Moved to {project}', description: "A line in a card's history: the card now belongs to another project ({project}, its folder name)." }),
  toWorkspace: msg({ id: 'tasks.history.toWorkspace', defaultMessage: 'Moved to the workspace', description: "A line in a card's history: the card no longer belongs to a project, only to the workspace." }),
  takenFromOf: msg({ id: 'tasks.history.takenFromOf', defaultMessage: 'Taken from {agent} of {project}', description: "A line in a card's history: the card was moved to another project, so it no longer belongs to {agent} (an agent's name) of its old project {project}." }),
  takenFromOfWorkspace: msg({ id: 'tasks.history.takenFromOfWorkspace', defaultMessage: 'Taken from {agent} of the workspace', description: "A line in a card's history: the card was moved to a project, so it no longer belongs to {agent} (an agent's name) of the workspace." }),
  given: msg({ id: 'tasks.history.given', defaultMessage: 'Given to {agent}', description: "A line in a card's history: the card was given to the agent {agent} (its name) to work on." }),
  takenFrom: msg({ id: 'tasks.history.takenFrom', defaultMessage: 'Taken from {agent}', description: "A line in a card's history: the card no longer belongs to the agent {agent} (its name)." }),
  takenFromAgent: msg({ id: 'tasks.history.takenFromAgent', defaultMessage: 'Taken from its agent', description: "A line in a card's history: the card no longer belongs to the agent it had (whose name isn't known)." }),
  reviewStarted: msg({ id: 'tasks.history.reviewStarted', defaultMessage: 'Started reviewing', description: "A line in a card's history: an agent (named beside it) began reviewing the card." }),
  reviewPassed: msg({ id: 'tasks.history.reviewPassed', defaultMessage: 'Review passed', description: "A line in a card's history: the reviewer (named beside it) passed the card's review." }),
  reviewFailed: msg({ id: 'tasks.history.reviewFailed', defaultMessage: 'Review failed', description: "A line in a card's history: the reviewer (named beside it) failed the card's review: it needs more work." }),
  reviewStopped: msg({ id: 'tasks.history.reviewStopped', defaultMessage: 'Review by {agent} stopped', description: "A line in a card's history: the review the agent {agent} (its name) had going on the card ended without a verdict (the card moved on)." }),
  reviewEnded: msg({ id: 'tasks.history.reviewEnded', defaultMessage: 'Review by {agent} stopped: {why, select, sessionEnded {its session ended} agentRemoved {the agent was removed} other {{why}}}', description: "A line in a card's history: the review the agent {agent} (its name) had going on the card ended, because its session ended or it was removed from the project ({why}, select: translate each)." }),
  reviewCopyWaiting: msg({ id: 'tasks.history.reviewCopyWaiting', defaultMessage: '{agent} is waiting for a review copy', description: "A line in a card's history (#1439): the reviewer {agent} (its name) started reviewing, but every review copy is in use or being set up; Combwork gives it one when it can. A review copy: a folder Combwork keeps at exactly the revision under review." }),
  reviewCopyLeased: msg({ id: 'tasks.history.reviewCopyLeased', defaultMessage: '{agent} reviews in {copy} at {revision}', description: "A line in a card's history (#1439): the reviewer {agent} (its name) reviews in the review copy {copy} (its name, \"copy-2\": keep it as it is), a folder at exactly the revision {revision} (a commit id: keep it as it is)." }),
  reviewerRequest: msg({ id: 'tasks.history.reviewerRequest', defaultMessage: 'Asked the builder: "{text}"', description: "A line in a card's history: the card's reviewer (named beside it), mid-review, asked the agent building it for something (a commit, a run); {text} is what it asked (cut short). Builder: the agent working on the card." }),
  builderReply: msg({ id: 'tasks.history.builderReply', defaultMessage: 'Replied to the reviewer: "{text}"', description: "A line in a card's history (HI-2302): the agent building the card (named beside it) commented on it in Review after its reviewer asked or said something in that round of review, so the reviewer was woken with the reply; {text} is what it said (cut short)." }),
  assistantAsked: msg({ id: 'tasks.history.assistantAsked', defaultMessage: 'Asked the Assistant: "{text}"', description: "A line in a card's history (HI-1866): an agent (named beside it) asked the Combwork Assistant for something only it or the user can do on the card (put a card On Hold, move it past its rules on the user's answer); {text} is what it asked (cut short). The request went to the Assistant's inbox." }),
  assistantAskUntold: msg({ id: 'tasks.history.assistantAskUntold', defaultMessage: "The Assistant couldn't be told of {agent}'s request on this card: read it in the card's comments and act on it yourself if it needs doing", description: "A line in a card's history (and a notification), HI-1866: the agent {agent} (its name) asked the Combwork Assistant for something on the card, but the request couldn't reach the Assistant (its tools are off, Settings → Assistant → Control doesn't let it change cards, or it went unread too long). The request is the agent's comment on the card." }),
  loopStep: msg({ id: 'tasks.history.loopStep', defaultMessage: '{step, select, design {Posted a design for the reviewer to check} followUp {Posted a follow-up for the reviewer to check} ok {Checked the design: OK} gaps {Checked the design: gaps} okFollowUp {Checked the follow-up: OK} gapsFollowUp {Checked the follow-up: gaps} other {Went ahead with the design unchecked}}: "{text}"', description: "A line in a card's history (#1382, #1467), a step of a card loop: its builder (named beside it) posted a design for its reviewer to check before building (design), or a follow-up of reviewed work for its check, such as a change asked of a screenshot (followUp); the reviewer checked a design and found it OK (ok) or found gaps (gaps), or checked a follow-up so (okFollowUp, gapsFollowUp); or, with no answer in time, the builder went ahead with its design as posted (other). {text} is what they said (cut short). Select keys: translate each sentence." }),
  decision: msg({ id: 'tasks.history.decision', defaultMessage: 'Recorded a decision: "{decision}"', description: "A line in a card's history: a decision the user made was written on the card; {decision} is its text (cut short)." }),
  decisionRemoved: msg({ id: 'tasks.history.decisionRemoved', defaultMessage: 'Removed a decision: "{decision}"', description: "A line in a card's history: the user removed one of the card's decisions; {decision} is its text (cut short)." }),
  decisionChanged: msg({ id: 'tasks.history.decisionChanged', defaultMessage: 'Changed a decision to "{decision}" (was "{was}")', description: "A line in a card's history: the user changed the words of one of the card's decisions; {decision} is the new text and {was} the old (each cut short)." }),
  labels: msg({ id: 'tasks.history.labels', defaultMessage: 'Labels: {labels}', description: "A line in a card's history: the card's labels were set to these ({labels}: the user's labels, separated by commas)." }),
  labelsRemoved: msg({ id: 'tasks.history.labelsRemoved', defaultMessage: 'Removed the labels', description: "A line in a card's history: the card's labels were all removed." }),
  labelsAdded: msg({ id: 'tasks.history.labelsAdded', defaultMessage: 'Labels: added {labels}', description: "A line in a card's history: these labels were added to the card, its other labels kept ({labels}: the user's labels, separated by commas)." }),
  labelsTakenOff: msg({ id: 'tasks.history.labelsTakenOff', defaultMessage: 'Labels: removed {labels}', description: "A line in a card's history: these labels were taken off the card, its other labels kept ({labels}: the user's labels, separated by commas)." }),
  labelsAddedTakenOff: msg({ id: 'tasks.history.labelsAddedTakenOff', defaultMessage: 'Labels: added {added}; removed {removed}', description: "A line in a card's history: in one change, the labels {added} were added to the card and the labels {removed} taken off, its other labels kept (each: the user's labels, separated by commas)." }),
  blocked: msg({ id: 'tasks.history.blocked', defaultMessage: 'Blocked: {reason}', description: "A line in a card's history: the card was marked blocked, with this reason ({reason}, written by whoever blocked it)." }),
  unblocked: msg({ id: 'tasks.history.unblocked', defaultMessage: 'No longer blocked', description: "A line in a card's history: the card's blocked reason was cleared." }),
  waiting: msg({ id: 'tasks.history.waiting', defaultMessage: 'Waiting: {reason}', description: "A line in a card's history (HI-2618): the card, in Active, was marked as waiting on purpose (held for a quiet window, say), with this reason ({reason}, written by whoever marked it). Combwork doesn't report it as stalled meanwhile. Not the same as Blocked." }),
  notWaiting: msg({ id: 'tasks.history.notWaiting', defaultMessage: 'No longer waiting', description: "A line in a card's history (HI-2618): the card's waiting mark was cleared, by hand or because the card left Active." }),
  dependsOn: msg({ id: 'tasks.history.dependsOn', defaultMessage: 'Depends on {cards}', description: "A line in a card's history: the cards that have to be done first were set to these ({cards}: card keys such as \"HI-3, HI-4\")." }),
  noDependencies: msg({ id: 'tasks.history.noDependencies', defaultMessage: 'No longer depends on other cards', description: "A line in a card's history: the list of cards that had to be done first was cleared." }),
  linked: msg({ id: 'tasks.history.linked', defaultMessage: 'Linked to {cards}', description: "A line in a card's history: the card's related cards were set to these ({cards}: card keys such as \"HI-3, HI-4\")." }),
  context: msg({ id: 'tasks.history.context', defaultMessage: 'Read first: {refs}', description: "A line in a card's history: the doc sections the agent reads first were set to these ({refs}: references such as \"docs/PLAN.md#setup\", separated by commas; keep them as they are)." }),
  contextRemoved: msg({ id: 'tasks.history.contextRemoved', defaultMessage: 'Removed the doc sections to read first', description: "A line in a card's history: the card's list of doc sections the agent reads first was cleared." }),
  linksRemoved: msg({ id: 'tasks.history.linksRemoved', defaultMessage: 'Removed the links', description: "A line in a card's history: the card's links to related cards were all removed." }),
  archived: msg({ id: 'tasks.history.archived', defaultMessage: 'Archived', description: "A line in a card's history: the user archived the card (hidden from the board, kept)." }),
  unarchived: msg({ id: 'tasks.history.unarchived', defaultMessage: 'Brought back from the archive', description: "A line in a card's history: the user brought the card back onto the board from the archive." }),
  archivedInBatch: msg({ id: 'tasks.history.archivedInBatch', defaultMessage: 'Archived in a batch of {n, number} ({label})', description: "A line in a card's history: the user archived {n} cards at once (Archive All), this one among them; {label} is the batch's name (\"All in Done\")." }),
  backWithBatch: msg({ id: 'tasks.history.backWithBatch', defaultMessage: 'Brought back with its batch ({label})', description: "A line in a card's history: the user undid an Archive All, which brought this card back; {label} is the batch's name (\"All in Done\")." }),
  archivedDone: msg({ id: 'tasks.history.archivedDone', defaultMessage: 'Archived after {days, plural, one {# day} other {# days}} in Done', description: "A line in a card's history: Combwork archived the card on its own, because it had been in the Done column for {days} days (Settings → Board)." }),
  archivedHidden: msg({ id: 'tasks.history.archivedHidden', defaultMessage: 'Archived: {project} was hidden', description: "A line in a card's history: the card was archived because the user hid its project {project} (its folder name) from Combwork." }),
  archivedRemoved: msg({ id: 'tasks.history.archivedRemoved', defaultMessage: 'Archived: {project} was removed from Combwork', description: "A line in a card's history: the card was archived because the user removed its project {project} (its folder name) from Combwork." }),
  // HI-1842: Combwork's comment on an archived card whose attachments its project's clean-up removed (Project Settings → Storage).
  attachmentsCleaned: msg({
    id: 'tasks.history.attachmentsCleaned',
    defaultMessage: "{n, plural, one {Removed # attachment} other {Removed # attachments}} ({names}): this project removes archived cards' attachments {days, plural, one {# day} other {# days}} after archiving (Project Settings → Storage). {n, plural, one {It is} other {They are}} in the Recycle Bin.",
    description: "A comment Combwork writes on an archived card when it removes the files kept with it: {n} how many, {names} their names (a list), {days} the project's setting (days after the card was archived). Project Settings → Storage is where the setting is: use its translated name."
  }),
  restored: msg({ id: 'tasks.history.restored', defaultMessage: 'Brought back: {project} was restored', description: "A line in a card's history: the card came back onto the board because the user restored its project {project} (its folder name)." }),
  imported: msg({ id: 'tasks.history.imported', defaultMessage: 'Brought back with {project} (it was #{was})', description: "A line in a card's history: the card came back with its removed project {project} (its folder name), under a new number; {was} was its number before." }),
  repaired: msg({ id: 'tasks.history.repaired', defaultMessage: 'Project: {from} → {to} (renamed or moved)', description: "A line in a card's history, by Repair: the card was given to the project {to}, the new name of its project {from} (folder names), which was renamed or moved." }),
  stageRepaired: msg({ id: 'tasks.history.stageRepaired', defaultMessage: 'Recorded as Done, as the board had it: its workflow still had it in {stage, select, hold {On Hold} todo {Todo} active {Active} review {Review} approved {Approved} merging {Merging} other {{stage}}}', description: "A line in a card's history, by Combwork (HI-1674): the card was in the Done column, but a move had not reached its workflow, which still had it at an earlier stage ({stage}, select: a board stage; translate each); Combwork recorded it as Done and closed its open questions." }),
  fromOlder: msg({ id: 'tasks.history.fromOlder', defaultMessage: 'Added from an older Combwork, where it was made as #{was}', description: "A line in a card's history, by Repair: the card was made in an older version of Combwork (which saved it after the board moved to its database), set aside, and the user added it to the board from Review…; {was} is the number it had there (it keeps it when no card here has it)." }),
  // Lines and a comment Combwork writes from outside the board service (#866): the same English as before, word for word.
  loopWake: msg({ id: 'tasks.history.loopWake', defaultMessage: 'Woke {agent} {kind, select, review {to review it} step {with a card loop step} other {with its verdict}} (a loop wake)', description: "A line in a card's history: in a card loop, Combwork woke the agent {agent} (its name), as the card arrived in Review for it to review (review), with a step of the loop for it (step: its builder's design to check, or its reviewer's answer, #1382), or with its review's verdict (other). \"Card loop\" and \"loop wake\" are Combwork's terms." }),
  answerUntold: msg({ id: 'tasks.history.answerUntold', defaultMessage: "The Assistant couldn't be told of your answer to {agent}'s question: only {agent} has it", description: "A line in a card's history (and a notification): the user answered a question the agent {agent} (its name) asked on the card; Combwork gives such answers to the Combwork Assistant too, in case they grant something the agent can't do itself, but the Assistant couldn't be told (its tools are off, or Settings → Assistant → Control doesn't let it change cards)." }),
  answerUntoldNeed: msg({ id: 'tasks.history.answerUntoldNeed', defaultMessage: "{agent} can't {action, select, done {move this card to Done} noCode {make this card no code} skipReview {skip this card's review} other {unblock this card}} by itself, and the Assistant couldn't be told of your answer: do it yourself if you agreed to it", description: "A line in a card's history (and a notification): the user answered a question the agent {agent} (its name) asked on the card; the card needs something only the user or the Combwork Assistant may do (select: translate each; keep the keys), the agent can't, and the Assistant couldn't be told (its tools are off, or Settings → Assistant → Control doesn't let it change cards)." }),
  answerTold: msg({ id: 'tasks.history.answerTold', defaultMessage: 'Told agent {agent} of your answer', description: "A line in a card's history: Combwork told the agent {agent} (its name) of the user's answer to a request for them (For you: an approval, a reply, a decision, a choice at the round limit). A noun before the name (glossary §1 rule 4)." }),
  decisionsTold: msg({ id: 'tasks.history.decisionsTold', defaultMessage: 'Told {agent} of {count, plural, one {# new decision} other {# new decisions}}', description: "A line in a card's history: Combwork told the agent {agent} (its name) of {count} decisions the user recorded on the card since it last read them." }),
  closedByDecision: msg({ id: 'tasks.history.closedByDecision', defaultMessage: 'Closed a question for you with your decision: "{question}"', description: "A line in a card's history (HI-1932): a question waiting for the user (For you) was answered by a decision the user made, recorded on the card (by the user, or by the Combwork Assistant writing down the user's words: the history line's author says who). {question} is the question, cut short." }),
  requestClosed: msg({ id: 'tasks.history.requestClosed', defaultMessage: '{why, select, done {Closed a question for you: the card is in Done} other {Closed a question for you: the agent that asked carried on}}', description: "A line in a card's history (#1638): a question waiting for the user (For you) was closed without an answer, because the card reached Done, or because the agent that asked moved the card on itself (answered some other way). Keep the select keys." }),
  notified: msg({ id: 'tasks.history.notified', defaultMessage: "Notified you {event, select, failed {that its review failed} blocked {that it's blocked} stalled {that it has stalled} mergeDue {that every card of lane {lane} passed review, so its merge is due} mergeStalled {that the merge of lane {lane} has stalled} other {that it needs you}}{hasWhy, select, yes {: {why}} other {}}", description: "A line in a card's history: Combwork sent the user a notification about this card (a banner or a Windows notification): its review failed, it is blocked, it has stalled, every card of its lane ({lane}, a label such as “B1 / R1 (greetings)”) passed review so the lane's work can be merged, that merge has stalled, or the card needs the user (an approval, a question) (select: translate each). A lane is Combwork's record of a card loop. With hasWhy yes, it ends with what the notification said ({why}): why it is blocked or stalled, or the question (someone's own words, or Combwork's own sentence already translated)." }),
  queueReturned: msg({
    id: 'tasks.history.queueReturned',
    defaultMessage:
      "Came back from the merge queue: {reason, select, conflict {a conflict with {target}} checks {the merge check {check} failed on the merged result} checksSome {a merge check failed on the merged result} checksEnv {the merge check {check} failed because of the environment, not the work} install {the install before the merge checks failed} hook {a git hook refused its merge commit} targetMoved {{target} moved while it was being merged} folderBusy {the folder {target} is checked out in was busy} notUpToDate {it isn't up to date with {target}} focused {its focused tests couldn't run on the merged result} other {{reason}}}{files, select, none {} other { (in {files})}}. The card's Work section shows the run.",
    description:
      "A comment Combwork writes on a card when the merge queue sends it back to its builder instead of merging it (HI-2087). {reason} says why (select: translate each; keep the keys): a merge conflict with the target branch {target} (a branch name, such as main), a merge check {check} (the check's name, such as typecheck) that failed on the merged result or failed because of the machine or network rather than the code, the install before the checks, a git hook that refused the merge commit, the target branch moving while it was merged, the folder where the target branch is checked out being busy, the card's work not being up to date with the target, or its focused tests. {files} lists the files concerned (file paths, keep them; none: leave that part out). \"Merge queue\" and \"Work section\" are Combwork's terms."
  }),
  watchEnded: msg({ id: 'tasks.history.watchEnded', defaultMessage: "Ended {watcher}'s watch on it: {why, select, blocked {the card is blocked} reviewer {{agent} reviews it} reviewTaken {its review was taken from it} reassigned {reassigned to {agent}} unassigned {reassigned to no agent} done {the card is in Done} laneEnded {its lane ended} laneAbandoned {its lane was abandoned} other {{why}}}", description: "A line in a card's history: Combwork stopped the agent {watcher} (its name) waiting for the card to change, because the card is blocked, another agent ({agent}) now reviews it, the review it waited for was taken from it, the card was given to another agent ({agent}) or to none, the card reached the Done column (its work merged), or the card loop (lane) the agent waited in ended or was abandoned ({why}, select: translate each)." }),
  safeguardStop: msg({ id: 'tasks.history.safeguardStop', defaultMessage: '**{agent}, after a safeguard stop:** {stops, plural, =0 {} other {A safety classifier stopped a response{model, select, none {} other { on {model}}} at {time}{stops, plural, =1 {} other { (# this session)}}. }}It now runs on {to} instead of {from} (since {since}).{state, select, asks { Its CLI asks what to do about it.} idle { Idle after the stop: give it a nudge.} other {}}{hasTools, select, yes { Before it, its last tool calls: {tools}.} other {}}{hasHelp, select, yes { {help}} other {}}', description: "A comment Combwork writes on the cards an agent works on, after its CLI's safety classifier stopped a response and the agent moved to another model. {agent}: the agent's name, in bold (keep the ** marks). Then, when it stopped any ({stops}: how many this session), on which model ({model}: its name; none: leave that branch empty) and when ({time}: \"15:12\"); the model it runs on now ({to}) instead of the old one ({from}) since a time ({since}); whether its CLI asks what to do (asks) or it sits idle (idle); its last tool calls before the stop ({tools}: tool names, keep them); and what to do about it in that CLI ({help}: its own sentence, already translated). Only names, never what was stopped." })
}

/**
 * Who wrote a history line or a comment as Combwork stores it (in English: agents read it), in the window's language: the
 * user, the Assistant, Repair; Combwork and an agent's name stay as they are.
 */
export const BY_TEXT: Record<string, Msg> = {
  You: msg({ id: 'tasks.by.you', defaultMessage: 'You', description: "Who made a change or wrote a comment on a card (beside a history line or a comment): the user. Short." }),
  Assistant: msg({ id: 'tasks.by.assistant', defaultMessage: 'Assistant', description: "Who made a change or wrote a comment on a card (beside a history line or a comment): the Combwork Assistant. Short." }),
  Repair: msg({ id: 'tasks.by.repair', defaultMessage: 'Repair', description: "Who made a change on a card (beside a history line): Combwork's Repair, which gave cards of a renamed or moved project back to it, or added a card an older Combwork made. Short." })
}

/** Why Archive All leaves a card on the board (#351): who is on it now. The window's text only (the board's dialog and main's check). */
export const BUSY = {
  working: msg({ id: 'board.busy.working', defaultMessage: '{agent} is working on it', description: "Why Archive All skips a card (listed in its dialog): an agent ({agent}, its name) is working on it." }),
  workingUnnamed: msg({ id: 'board.busy.workingUnnamed', defaultMessage: 'Its agent is working on it', description: "Why Archive All skips a card (listed in its dialog): its agent (whose name isn't known) is working on it." }),
  reviewing: msg({ id: 'board.busy.reviewing', defaultMessage: '{agent} is reviewing it', description: "Why Archive All skips a card (listed in its dialog): an agent ({agent}, its name) is reviewing it." }),
  assistantWatching: msg({ id: 'board.busy.assistantWatching', defaultMessage: 'The Assistant is watching it', description: 'Why Archive All skips a card (listed in its dialog): the Combwork Assistant waits for it to change.' }),
  watching: msg({ id: 'board.busy.watching', defaultMessage: '{agent} is watching it', description: "Why Archive All skips a card (listed in its dialog): an agent ({agent}, its name) waits for it to change." }),
  watchingUnnamed: msg({ id: 'board.busy.watchingUnnamed', defaultMessage: 'An agent is watching it', description: "Why Archive All skips a card (listed in its dialog): an agent (whose name isn't known) waits for it to change." })
}

const BY_ID = new Map<string, Msg>(Object.values(HISTORY).map((m) => [m.id, m]))

/** The message a stored line names, by its id: null for an id this Combwork doesn't know (a record from a newer one). */
export const storedMessage = (s: StoredText | undefined): Msg | null => (s ? (BY_ID.get(s.id) ?? null) : null)

/**
 * The lines whose value names a card, stored as its key since HI-1661 and as its number before it: a number there is the
 * old `#N` it showed then.
 */
const CARD_VALUES: Record<string, string> = { 'tasks.history.movedBefore': 'before', 'tasks.history.movedBeforeIn': 'before' }

/** How deep messages within a stored line's values go: Combwork nests one (a CLI's sentence); more is a damaged file. */
const MAX_NESTED = 3

/**
 * A stored line's text, by `format` (the window's language, or English): its message with its values, a value that is a
 * message of its own formatted first, found by `more` when it isn't the history's (a CLI's sentence: providerMessage).
 * Null when this Combwork doesn't know a message it names (a record from a newer one), or the record isn't one (a card file
 * edited by hand: an id that isn't text, values that aren't an object of text, numbers and messages): the window then
 * shows the stored English.
 */
export function storedLineText(s: unknown, format: (m: Msg, values?: Record<string, string | number>) => string, more: (id: string) => Msg | null = () => null, depth = 0): string | null {
  if (!isRecord(s) || typeof s.id !== 'string' || depth > MAX_NESTED) return null
  const m = BY_ID.get(s.id) ?? more(s.id)
  if (!m) return null
  if (s.values === undefined) return format(m)
  if (!isRecord(s.values)) return null
  const values: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(s.values)) {
    if (typeof v === 'number' && Number.isFinite(v) && CARD_VALUES[s.id] === k) values[k] = `#${v}`
    else if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) values[k] = v
    else {
      const t = storedLineText(v, format, more, depth + 1)
      if (t === null) return null
      values[k] = t
    }
  }
  return format(m, values)
}

/** The ids a stored line names: its message's, and those of messages stored inside its values (a CLI's sentence). */
export function storedIds(s: unknown, depth = 0, into: string[] = []): string[] {
  if (!isRecord(s) || typeof s.id !== 'string' || depth > MAX_NESTED) return into
  into.push(s.id)
  if (isRecord(s.values)) for (const v of Object.values(s.values)) storedIds(v, depth + 1, into)
  return into
}

const agentRenderers = new Map<string, (data: unknown) => string | null>()

/** Registers how a comment's own agents' English is said from its stored data (`StoredText.agent`), by name. */
export function setStoredAgentRenderer(name: string, fn: (data: unknown) => string | null): void {
  agentRenderers.set(name, fn)
}

/** A comment's own agents' English, said from its stored data in the current chain; null where no renderer takes it. */
export function storedAgentText(agent: { render: string; data: unknown }): string | null {
  const fn = typeof agent?.render === 'string' ? agentRenderers.get(agent.render) : undefined
  return fn ? fn(agent.data) : null
}

let forAgents: ((english: string, stored: unknown) => string) | null = null

/** Registers how a stored line is said for an agent (main's board service, tasks.ts): see storedForAgents. */
export function setStoredForAgents(fn: ((english: string, stored: unknown) => string) | null): void {
  forAgents = fn
}

/**
 * A history line or Combwork's comment as an agent reads it (dialects, HI-2440; design section 2): said again from its
 * message and values in the reader's chain where that chain overrides a message it names, else its English as stored.
 * A record from before #845, with no message (decision 5), is shown as stored. Where none is registered (cw-mcp.js,
 * which renders no history), the stored English.
 */
export const storedForAgents = (english: string, stored: unknown): string => (stored && forAgents ? forAgents(english, stored) : english)

/** An object, not null or a list. */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A message and its values as they are kept in a card's file: its id and values, never its English. */
export function storedText<Id extends string>(m: Msg<Id>, ...values: MessageArgs<Id>): StoredText {
  const v = values[0] as Record<string, string | number> | undefined
  return v ? { id: m.id, values: v } : { id: m.id }
}
