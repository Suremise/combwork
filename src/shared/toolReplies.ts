/**
 * The short forms of Hive's replies to agents (the hive MCP tools) and the Agent API's opt-in short views. Every
 * character a tool returns goes into an agent's context and is paid for again on each later turn, so: a change
 * confirms what changed (and what the agent can't know: a new card's number, where a card is now), a listing
 * returns a short row per item, and full detail comes on request. No imports beyond shared code without side
 * effects: hive-mcp.js runs outside the app bundle.
 */
import type { LiveSessionState, MergeSlotInfo, StoredText, TaskCard, TaskColumn, TaskDecision } from './types'
import { storedForAgents } from './taskHistory'
import { holderText, minutes, slotLine } from './mergeSlot'
import { columnLabel, commentSummary } from './tasks'
import { cardName, cardRef, namedBy, namesFrom, namesOf } from './projectKeys'
import { shortDuration } from './progress'
import { LANE_DEFAULT_EVENTS, type LaneEvent, type LaneWatchAgents, type LaneWatchCards } from './laneWatch'
import type { StageId } from './workflow/facts'
import type { NextStep } from './workflow/nextStep'
import type { QueuePublic } from './workflow/queue'
import { INBOX_SWITCHES, type InboxSwitch } from './inboxSwitches'
import { unsubmittedText, type UnsubmittedCard } from './unsubmitted'
import { idleWatchText } from './idleWatch'
import { agentMsg, say, type AgentMsg } from './agentText'

/**
 * The replies' text (dialects, HI-2065; HI-2435): said when a reply is built, in its caller's dialect. Numbers are plain
 * `{n}` (as the code wrote them, no grouping), except where the code grouped them (`{n, number}`). A flag is a `select`
 * on `yes`/`no`. Names, keys, paths and other messages' text come in as values.
 */
const R = {
  checksHint: agentMsg({ id: 'reply.checks.hint', text: 'before review: run one with cw-progress --check <name> --card "{card}" {isolated, select, yes {(--isolated: in a check copy at the card\'s revision; work-on-card)} other {(work-on-card)}}', note: "A code card's checks before review (HI-2276): how to run one, with <name> left for the agent to fill (a configured name is never quoted into a command, HR1's rounds 1 and 2). {card} is the card's key; isolated: its platform can make a check copy." }),
  commentsInvalid: agentMsg({ id: 'reply.read.commentsInvalid', text: 'comments must be a whole number from 0: "{raw}"', note: "GET /v1/tasks/{n}'s comments= (HI-2412) was not a whole number from 0. {raw} is what was given." }),
  place: agentMsg({ id: 'reply.card.place', text: '{column} ({position} of {of})', note: "Where a card is now: its column's name and its place in it (an ordinal such as 51st, of how many)." }),
  created: agentMsg({ id: 'reply.card.created', text: '{card} created in {place}{forProject, select, yes { for {project}} other {}}{givenTo, select, yes {, given to {agent}} other {}}: {title}{changed, select, yes {. {changes}} other {}}', note: 'A new card (reply: short): its name (key and number), where it is, its project and agent, its title and the changes made with it (joined by "; ").' }),
  changed: agentMsg({ id: 'reply.card.changed', text: '{card} {title}: {what}. Now in {place}{hasProject, select, yes {, {project}} other {}}{hasAgent, select, yes {, {agent}} other {}}.', note: "A card changed (reply: short): its name and title, what changed (or reply.card.noChange), and where it is now, its project and its agent." }),
  noChange: agentMsg({ id: 'reply.card.noChange', text: 'No change', note: 'What changed on a card when nothing did, in reply.card.changed.' }),
  nextIntents: agentMsg({ id: 'reply.next.intents', text: 'Next on it: {tools}.', note: "What comes next on a card under its rules (#1530): the intent tools it can take (joined with reply.list.or). An agent follows it rather than infer the step from a column." }),
  nextReview: agentMsg({ id: 'reply.next.review', text: "Next: a reviewer's verdict.", note: 'What comes next on a card (#1530): it waits for a review.' }),
  nextUser: agentMsg({ id: 'reply.next.user', text: "Next: the user's OK, asked under For you: wait for it.", note: "What comes next on a card (#1530): the user's approval, asked under For you." }),
  nextMerge: agentMsg({ id: 'reply.next.merge', text: 'Next: its builder merges it, then reports the merge (cw_report_merge).', note: 'What comes next on a card (#1530): its builder merges it.' }),
  nextQueue: agentMsg({ id: 'reply.next.queue', text: "Next: Combwork's merge queue merges it.", note: "What comes next on a card (#1530): Combwork's merge queue merges it." }),
  nextDone: agentMsg({ id: 'reply.next.done', text: 'Done: nothing more on it.', note: 'What comes next on a card (#1530): nothing, it is done.' }),
  warning: agentMsg({ id: 'reply.warning', text: 'Warning: {warning}', note: "A warning on a line of its own after a reply (an intent's, a refusal's). {warning} is its text." }),
  intentStill: agentMsg({ id: 'reply.intent.still', text: 'still {stage}', note: "An intent's reply when the card stayed in its stage (#1267). {stage} is the stage's id (active, review…)." }),
  intentDone: agentMsg({ id: 'reply.intent.done', text: 'done', note: "An intent's reply when it names no stages (#1267)." }),
  listMore: agentMsg({ id: 'reply.list.more', text: '{items} and {n} more', note: 'A list cut short: the items shown, and how many more there are.' }),
  listNone: agentMsg({ id: 'reply.list.none', text: 'none', note: "An intent's empty list (start review's files, say)." }),
  or: agentMsg({ id: 'reply.list.or', text: '{a} or {b}', note: 'Two choices, or a list of them joined one by one ("a or b or c").' }),
  and: agentMsg({ id: 'reply.list.and', text: '{a} and {b}', note: 'Two items, or a list of them joined one by one ("a and b and c").' }),
  askedNone: agentMsg({ id: 'reply.ask.assistantNone', text: "{card}: your request is on the card, but the Assistant couldn't be given it; the user is told. Ask the user instead (cw_ask_user).", note: "cw_ask_assistant (HI-1866) when the request couldn't be delivered to the Assistant. {card} is the card's key." }),
  asked: agentMsg({ id: 'reply.ask.assistant', text: '{card}: asked the Assistant ({delivery} in its inbox). Its answer comes to your inbox.', note: "cw_ask_assistant (HI-1866): the request's id in the Assistant's inbox ({delivery}, m41)." }),
  notifiedOpens: agentMsg({ id: 'reply.notify.opens', text: 'Notification shown; a click opens {opens}.', note: 'cw_notify (HI-1961): what a click on the notification opens (an agent or a card).' }),
  notified: agentMsg({ id: 'reply.notify.shown', text: 'Notification shown.', note: 'cw_notify: the notification was shown.' }),
  changesNoneFor: agentMsg({ id: 'reply.undo.noneForGroup', text: 'No changes of yours are kept for message {group}.', note: "cw_undo's list for one message (#1282) when none is kept. {group} is the message's group id." }),
  changeUndone: agentMsg({ id: 'reply.undo.markUndone', text: '[undone]', note: "A mark after one of the Assistant's changes in cw_undo's list (#1282): it has been undone." }),
  changeFinal: agentMsg({ id: 'reply.undo.markFinal', text: "[can't be undone: {why}]", note: "A mark after one of the Assistant's changes in cw_undo's list (#1282): it can't be undone, and why." }),
  changesMore: agentMsg({ id: 'reply.undo.listMore', text: 'and {n} more: undo the group to undo them all.', note: "cw_undo's list of a message's changes, cut at 40: how many more." }),
  changesNone: agentMsg({ id: 'reply.undo.none', text: 'No changes of yours are kept (they are kept 7 days).', note: "cw_undo's list when none of the Assistant's changes is kept (#1282)." }),
  changeGroup: agentMsg({ id: 'reply.undo.group', text: '{group} (your message at {at}): {n, plural, one {{n} change} other {{n} changes}}, {left} to undo{hasCards, select, yes {; cards {cards}} other {}}', note: "A message's line in cw_undo's list (#1282): its group id, when, how many changes and how many are left to undo, and its cards." }),
  skippedChanged: agentMsg({ id: 'reply.undo.skipped.changed', text: 'changed since', note: 'Why an undo left a field: it changed since the Assistant changed it.' }),
  skippedGone: agentMsg({ id: 'reply.undo.skipped.gone', text: 'gone', note: 'Why an undo left a field: what it was on is gone.' }),
  skippedEnded: agentMsg({ id: 'reply.undo.skipped.ended', text: 'it has ended', note: 'Why an undo left a field: what it was on has ended.' }),
  skippedFailed: agentMsg({ id: 'reply.undo.skipped.failed', text: 'refused', note: 'Why an undo left a field: putting it back was refused.' }),
  undoHead: agentMsg({ id: 'reply.undo.head', text: 'Undid {done} of {n, plural, one {{n} change} other {{n} changes}} in full.', note: "cw_undo's reply (#1282): how many changes were undone in full, of how many." }),
  undoBefore: agentMsg({ id: 'reply.undo.before', text: '{name}: undone before.', note: 'cw_undo: this change had been undone before. {name} is its card or what it was.' }),
  undoFinal: agentMsg({ id: 'reply.undo.final', text: "{name}: can't be undone: {final}", note: "cw_undo: this change can't be undone, and why." }),
  undoPartial: agentMsg({ id: 'reply.undo.partial', text: '{name}: {putBack, select, yes {{undone} put back; } other {}}{skipped}.', note: 'cw_undo: what of this change was put back, and each field left (reply.undo.field, joined by ", ").' }),
  undoField: agentMsg({ id: 'reply.undo.field', text: '{field} left ({why}{hasError, select, yes {: {error}} other {}})', note: 'cw_undo: a field left as it is, why (reply.undo.skipped.*) and the error if one was given.' }),
  undoMore: agentMsg({ id: 'reply.undo.more', text: 'and {n} more left as they were.', note: "cw_undo's notes, cut at 40: how many more were left." }),
  batchChanged: agentMsg({ id: 'reply.batch.changed', text: '{n, plural, one {{n} card} other {{n} cards}} changed:', note: 'A batch change (reply: short): how many cards changed, each on a line below.' }),
  batchNone: agentMsg({ id: 'reply.batch.none', text: 'No card changed.', note: 'A batch change in which no card changed.' }),
  batchRefused: agentMsg({ id: 'reply.batch.refused', text: 'Refused, left as they were: {list}.', note: 'A batch change: the cards refused, each with why (joined by "; ").' }),
  batchRefusedRule: agentMsg({ id: 'reply.batch.refusedRule', text: 'Refused, left as it was: {named, select, yes {} other {{ref}: }}{error} ({rule})', note: "A batch change: a card refused by its rules (HI-2238), named first where its message doesn't name it, then the message and the rule; its next step and who can change it follow on lines of their own." }),
  reorder: agentMsg({ id: 'reply.reorder', text: '{column} now starts {cards}{more, select, yes {; its other {rest, plural, one {{rest} card} other {{rest} cards}} keep their order below} other {}}.', note: 'A reorder (reply: short): the cards now at the top of the column, and how many others keep their order.' }),
  laneOrder: agentMsg({ id: 'reply.reorder.laneOrder', text: "{cards} {one, select, yes {is} other {are}} on {builder}'s lane ({lane}), which keeps its own order and takes {one, select, yes {it} other {them}} in that order. To change it: cw_lane start with its cards in the new order (applyNow: true to apply it now).", note: "HI-2267: put back or reordered on the board, a lane's card is still where its lane's own list has it. The Assistant, calling the tools without a skill, reordered the column and was told nothing of it." }),
  statusIdle: agentMsg({ id: 'reply.agent.status.idle', text: 'idle', note: "An agent's status in a card row or project row: ready or finished." }),
  statusBackground: agentMsg({ id: 'reply.agent.status.background', text: 'waiting on background tasks', note: "An agent's status: its turn ended with background tasks running." }),
  statusWaiting: agentMsg({ id: 'reply.agent.status.waiting', text: 'waiting for the user', note: "An agent's status: it waits for the user." }),
  statusWatching: agentMsg({ id: 'reply.agent.status.watching', text: 'waiting for cards', note: "An agent's status: it waits on a card watch." }),
  statusSignin: agentMsg({ id: 'reply.agent.status.signin', text: 'waiting for the user to sign in', note: "An agent's status: its CLI's sign-in expired." }),
  backgroundTasks: agentMsg({ id: 'reply.agent.backgroundTasks', text: '{n, plural, one {{n} background task} other {{n} background tasks}}', note: "How many background tasks an agent runs, in a card row's agent." }),
  rowAgent: agentMsg({ id: 'reply.row.agent', text: '{name} ({state})', note: "A card row's agent: its name, its status and background tasks (joined by \", \")." }),
  rowBlocked: agentMsg({ id: 'reply.row.blocked', text: 'blocked: {why}', note: "A card row (cw_list_tasks): why it is blocked." }),
  rowAfter: agentMsg({ id: 'reply.row.after', text: 'after {cards}', note: 'A card row: the cards it waits for.' }),
  rowElsewhere: agentMsg({ id: 'reply.row.elsewhere', text: '{card} (another project)', note: "A card row: a card it waits for that is another project's." }),
  rowStalled: agentMsg({ id: 'reply.row.stalled', text: 'stalled: {why}', note: 'A card row: why it has stalled.' }),
  rowReviewing: agentMsg({ id: 'reply.row.reviewing', text: 'reviewing: {name}{stalled, select, yes { (stalled: {why})} other {}}', note: 'A card row: the agent reviewing it, and why that has stalled if it has.' }),
  rowComments: agentMsg({ id: 'reply.row.comments', text: '{n, plural, one {{n} comment} other {{n} comments}}', note: 'A card row: how many comments it has.' }),
  listNoArchived: agentMsg({ id: 'reply.list.noArchived', text: 'No archived cards.', note: 'cw_list_tasks with archived when there are none.' }),
  listNoCards: agentMsg({ id: 'reply.list.noCards', text: 'No cards.', note: 'cw_list_tasks when there are none.' }),
  listPast: agentMsg({ id: 'reply.list.past', text: 'There are {n} cards: offset {offset} is past the last.', note: "cw_list_tasks's offset past the last card." }),
  listPage: agentMsg({ id: 'reply.list.page', text: 'Cards {from}–{to} of {n}.', note: 'cw_list_tasks from an offset: which cards this page has.' }),
  listColumn: agentMsg({ id: 'reply.list.column', text: '{archived, select, yes {Archived, last in {column} ({n}):} other {{column} ({n}, top first):}}', note: "A column's heading in cw_list_tasks: its name and how many cards it has (top first: a column's order is its priority)." }),
  listRest: agentMsg({ id: 'reply.list.rest', text: '…and {n} more: offset {next} carries on.', note: 'cw_list_tasks cut at 200 rows: how many more, and the offset that carries on.' }),
  listRead: agentMsg({ id: 'reply.list.read', text: 'cw_read_task gives a card in full.', note: "cw_list_tasks's last line." }),
  progress: agentMsg({ id: 'reply.progress', text: '{title}{steps}{state, select, stopped {, stopped reporting} eta {, about {left} left} other {}}', note: "An agent's open progress run in a project row: its title (clipped), its steps (\" 4/12\") and the time left, or that it stopped reporting." }),
  projectHead: agentMsg({ id: 'reply.project.head', text: '{name} ({active, select, yes {on} other {off}}{hasBranch, select, yes {, {branch}} other {}})', note: 'A project row (cw_list_projects): its name (with its workspace when there are several), on or off, and its branch.' }),
  projectNoAgents: agentMsg({ id: 'reply.project.noAgents', text: '{head}: no agents', note: 'A project row for a project with no agents.' }),
  projectAgent: agentMsg({ id: 'reply.project.agent', text: '{name} [{tags}] {state}{hasBackground, select, yes { ({background} background)} other {}}{hasProgress, select, yes { (running {progress})} other {}}', note: "An agent in a project row: its name, its provider, role and branch, its status (or what it waits for), its background tasks and its progress run." }),
  projectRead: agentMsg({ id: 'reply.project.read', text: "cw_project_status gives one project in full (its agents' ids and sessions, its settings).", note: "cw_list_projects's last line." }),
  projectsNone: agentMsg({ id: 'reply.project.none', text: 'No projects.', note: 'cw_list_projects when there are none.' }),
  notesRead: agentMsg({ id: 'reply.notes.read', text: 'cw_read_shared_note reads one.', note: "cw_list_shared_notes's last line." }),
  notesNone: agentMsg({ id: 'reply.notes.none', text: 'No shared notes yet.', note: 'cw_list_shared_notes when there are none.' }),
  noteHead: agentMsg({ id: 'reply.note.head', text: '{path}{hasRevision, select, yes { (revision {revision})} other {}}', note: "A note or handover read: its path and its revision (for a write's expectedRevision); its text follows as it is." }),
  noteAppended: agentMsg({ id: 'reply.note.appended', text: 'Appended {n, number} characters to {path}{hasRevision, select, yes { (revision {revision})} other {}}.', note: 'A note appended to: how much, and its new revision.' }),
  noteWrote: agentMsg({ id: 'reply.note.wrote', text: 'Wrote {path} ({n, number} characters{hasRevision, select, yes {, revision {revision}} other {}}).', note: 'A note written: how much, and its new revision.' }),
  thousands: agentMsg({ id: 'reply.size.thousands', text: '{n}k', note: 'A size in characters, short: 3.2k, 56k. {n} is the thousands, as the code rounds them.' }),
  outlineNone: agentMsg({ id: 'reply.doc.noHeadings', text: '{path} ({size} characters) has no headings: read it whole.', note: 'cw_doc_outline (#817) for a document with no headings.' }),
  outlineHead: agentMsg({ id: 'reply.doc.outline', text: '{path}: {n} headings, {size} characters. [slug] and size per section (subsections included):', note: "cw_doc_outline's first line (#817); a line per heading follows, with its slug in brackets." }),
  outlineMore: agentMsg({ id: 'reply.doc.outlineMore', text: '… {n} more: depth={depth} lists fewer.', note: 'cw_doc_outline cut at 200 headings: how many more, and the depth that lists fewer.' }),
  outlineRead: agentMsg({ id: 'reply.doc.outlineRead', text: 'cw_read_section reads one as #<slug>.', note: "cw_doc_outline's last line." }),
  sectionHead: agentMsg({ id: 'reply.doc.section', text: '{path}#{slug} ({size, number} characters)', note: 'cw_read_section: where the section is and its size; its text follows as it is.' }),
  docHead: agentMsg({ id: 'reply.doc.whole', text: '{path} ({size, number} characters)', note: 'cw_read_section with no heading (#818): the whole document and its size.' }),
  sectionLong: agentMsg({ id: 'reply.doc.sectionLong', text: '{head}: long, so here is its text before its subsections, then their outline.', note: "cw_read_section for a long section: its own text, then its subsections' outline." }),
  sectionRead: agentMsg({ id: 'reply.doc.sectionRead', text: 'cw_read_section reads one of them as #<slug>, or this whole section with full=true.', note: "cw_read_section's last line for a long section." }),
  bytes: agentMsg({ id: 'reply.attachment.bytes', text: '{n, number} bytes', note: "An attachment's size (HI-1751)." }),
  attachmentFile: agentMsg({ id: 'reply.attachment.file', text: '{name}: {kind, select, binary {not text} pdf {a PDF} other {an image}} ({size}). Open it with your own file reading: {path}', note: "cw_read_attachment (HI-1751) for an image, a PDF or a binary file: its path, for the CLI's own reading." }),
  attachmentRange: agentMsg({ id: 'reply.attachment.range', text: 'bytes {from, number}–{to, number} of {size}', note: 'cw_read_attachment: which bytes of the file this page is.' }),
  attachmentText: agentMsg({ id: 'reply.attachment.text', text: '{name} ({where}{hasNext, select, yes {; more from offset {next}} other {}})', note: 'cw_read_attachment: which bytes this is, and the byte offset the next page starts at (to pass back as offset); the text follows as it is.' }),
  levelHive: agentMsg({ id: 'reply.skill.level.cw', text: 'Combwork', note: "Where a skill comes from in cw_list_skills: Combwork's own." }),
  levelMachine: agentMsg({ id: 'reply.skill.level.machine', text: 'user', note: "Where a skill comes from: the user's own, on this machine." }),
  levelPlugin: agentMsg({ id: 'reply.skill.level.plugin', text: 'plugin', note: 'Where a skill comes from: a plugin.' }),
  levelLocal: agentMsg({ id: 'reply.skill.level.local', text: 'local', note: "Where a skill comes from: the project's own." }),
  skillNobody: agentMsg({ id: 'reply.skill.nobody', text: 'given to nobody: {problem}', note: 'A Combwork skill nobody gets (its header is broken or its audience unknown), and why.' }),
  skillFor: agentMsg({ id: 'reply.skill.for', text: 'for {audience, select, all {agents and the Assistant} assistant {the Assistant} other {agents}}', note: "Who a Combwork skill is for." }),
  skillLine: agentMsg({ id: 'reply.skill.line', text: '{name} ({where}): {description}', note: 'A skill in cw_list_skills: its name, where it comes from and who it is for, and what it is for.' }),
  skillNoDescription: agentMsg({ id: 'reply.skill.noDescription', text: 'no description', note: 'A skill with no description.' }),
  skillsNone: agentMsg({ id: 'reply.skill.none', text: 'No skills.', note: 'cw_list_skills when there are none.' }),
  lanesLeft: agentMsg({ id: 'reply.wait.lanesLeft', text: 'This replaces your lane watch: {n, plural, one {1 running lane ({lanes}) is} other {{n} running lanes ({lanes}) are}} no longer followed. To follow them as well, watch them with this instead: cw_wait_for_tasks with lanes, and agents or cards.', note: 'HI-1987: a card or agent watch that replaces a lane watch while its lanes run says what it drops, and how to keep them.' }),
  waitKeptCards: agentMsg({ id: 'reply.wait.keptCards', text: 'It kept {cards} from your last lane watch (cards: [] for none).', note: 'A lane watch (#726): the cards beside its lanes it kept from the last lane watch.' }),
  waitReplaceCards: agentMsg({ id: 'reply.wait.replaceCards', text: 'Its cards replace {cards}.', note: "A lane watch: its cards replace the last lane watch's." }),
  waitNoLonger: agentMsg({ id: 'reply.wait.noLonger', text: 'It no longer watches {cards}.', note: "A lane watch: the last lane watch's cards it no longer watches." }),
  waitDropped: agentMsg({ id: 'reply.wait.dropped', text: '{cards} left it (done or gone).', note: 'A lane watch: cards that left it.' }),
  waitInLanes: agentMsg({ id: 'reply.wait.inLanes', text: 'Warning: {cards} {one, select, yes {is a card} other {are cards}} of the lanes you watch: listed too, {one, select, yes {it wakes} other {they wake}} you on every move. For a lane, pass lanes only.', note: "A lane watch given cards of its own lanes: they wake the agent on every move." }),
  waitKeptAgents: agentMsg({ id: 'reply.wait.keptAgents', text: 'It kept {agents} from your last lane watch (agents: [] for none).', note: 'A lane watch (HI-1987): the agents beside its lanes it kept from the last lane watch.' }),
  waitNotFollowed: agentMsg({ id: 'reply.wait.notFollowed', text: 'Not followed, not working now: {agents}.', note: 'A lane watch: agents not followed for not working now, each with its state.' }),
  waitAlsoCards: agentMsg({ id: 'reply.wait.alsoCards', text: 'a change to {cards}', note: 'What else wakes a lane watch: a change to its cards.' }),
  waitAlsoAgents: agentMsg({ id: 'reply.wait.alsoAgents', text: '{agents} finishing, waiting for the user or stopping', note: 'What else wakes a lane watch: its agents.' }),
  waitLane: agentMsg({ id: 'reply.wait.lane', text: '{watching}{events}. End your turn now: Combwork types a line into this session on a lane event{hasAlso, select, yes { or {also}} other {}}, or at {limit} if none comes.', note: "A lane watch begun (#531): what it watches (and its events, when they aren't the default), and what wakes it." }),
  waitReplaced: agentMsg({ id: 'reply.wait.replaced', text: 'It replaces your watch ({watch}).', note: 'A watch begun: the watch it replaced.' }),
  theLimit: agentMsg({ id: 'reply.wait.theLimit', text: 'the limit', note: "When a watch ends if nothing comes, where its limit's time isn't known." }),
  waitGone: agentMsg({ id: 'reply.wait.gone', text: '{card} {archived, select, yes {was archived} other {was archived or deleted}}', note: 'A watched card that is gone.' }),
  waitMoved: agentMsg({ id: 'reply.wait.moved', text: '{card} is in {column} ({changes}{hasBy, select, yes {, by {by}} other {}})', note: 'A watched card that changed: its column, what changed, and who changed it.' }),
  waitComment: agentMsg({ id: 'reply.wait.comment', text: '{change}; latest comment by {by}: "{line}"', note: "A watched card's change, with its latest comment's author and first line (cw_read_task with latestComment gives it all)." }),
  waitEndTurnLower: agentMsg({ id: 'reply.wait.endTurnThen', text: 'end your turn: Combwork types a line into this session when it changes, or at {limit} if nothing does.', note: 'HI-2245: after handing a card over first, what to do then.' }),
  waitIdle: agentMsg({ id: 'reply.wait.idle', text: '{watching}. {idle} Combwork types a line into this session when it changes, or at {limit} if nothing does.', note: "HI-2285: a lane's builder watching only its own card with nothing waiting on it carries on rather than end the turn." }),
  waitEndTurn: agentMsg({ id: 'reply.wait.endTurn', text: 'End your turn now: Combwork types a line into this session when it changes, or at {limit} if nothing does.', note: 'A card watch begun: end the turn, and what wakes it.' }),
  waitWatching: agentMsg({ id: 'reply.wait.watching', text: '{watching}. {step} Nothing runs meanwhile.', note: 'A card watch begun: what it waits for, then what to do (reply.wait.endTurn, or hand a card over first).' }),
  already: agentMsg({ id: 'reply.wait.already', text: 'Already: {what}.', note: 'A watch whose condition was met already: no watch started.' }),
  waitEnded: agentMsg({ id: 'reply.wait.ended', text: 'Your watch ({watch}) has ended.', note: 'HI-2195: a usage watch already met ends the watch before it.' }),
  since: agentMsg({ id: 'reply.wait.since', text: 'since: {since}', note: 'The since to pass to the next bounded wait (a parameter name: keep it).' }),
  waitNoChange: agentMsg({ id: 'reply.wait.noChange', text: 'No change.', note: 'A bounded wait with no change.' }),
  agentReplaced: agentMsg({ id: 'reply.agentWatch.replaced', text: 'It replaces your card watch ({watch}).', note: 'An agent watch begun (#416): the card watch it replaced.' }),
  agentDropped: agentMsg({ id: 'reply.agentWatch.dropped', text: "It replaces your watch on {agents}: pass every agent you're following.", note: "#1346 item 6: the agents the earlier agent watch followed and this call doesn't." }),
  agentCardEnded: agentMsg({ id: 'reply.agentWatch.cardEnded', text: 'Your card watch ({watch}) has ended.', note: 'An agent watch met at once ends the card watch before it.' }),
  agentDroppedEnded: agentMsg({ id: 'reply.agentWatch.droppedEnded', text: "Your watch on {agents} has ended: watch again, passing every agent you're following.", note: 'An agent watch met at once ends the earlier one too (#1346 item 6).' }),
  agentWatching: agentMsg({ id: 'reply.agentWatch.watching', text: '{watching}. End your turn now: Combwork types a line into this session when one finishes, waits for the user or stops, or at {limit} if none does. Nothing runs meanwhile.', note: 'An agent watch begun (#416): end the turn, and what wakes it.' }),
  settingNoMatch: agentMsg({ id: 'reply.setting.noMatch', text: 'No setting matches "{query}".', note: 'cw_list_settings with a query nothing matches.' }),
  settingsNone: agentMsg({ id: 'reply.setting.none', text: 'No settings.', note: 'cw_list_settings with none.' }),
  settingRow: agentMsg({ id: 'reply.setting.row', text: '{id} = {value}{hasDefault, select, yes { (default {def})} other {}}{readOnly, select, yes { [read-only]} other {}}', note: "A setting in cw_list_settings: its id, its value, its default when it differs, and whether it is read-only to the Assistant." }),
  settingInherit: agentMsg({ id: 'reply.setting.inherit', text: 'Set to inherit:', note: "cw_list_settings (HI-1712): those set to inherit come last, under this line." }),
  settingMore: agentMsg({ id: 'reply.setting.more', text: '… {n} more: offset {next} carries on.', note: 'cw_list_settings cut at 200: how many more, and the offset that carries on.' }),
  settingHead: agentMsg({ id: 'reply.setting.head', text: '{title} ({id}){hasProject, select, yes { in {project}} other {}}: {value}{isDefault, select, yes { (the default)} other { (default {def})}}', note: "cw_read_setting's first line: the setting, its project, its value and its default." }),
  settingWhere: agentMsg({ id: 'reply.setting.where', text: 'Where: {path}. Takes {takes}.', note: 'cw_read_setting: where the user finds it, and what it takes.' }),
  settingShownAs: agentMsg({ id: 'reply.setting.shownAs', text: 'The user sees it as: {shownAs}.', note: "cw_read_setting (#767): where the user sees it, in the language Combwork shows them." }),
  settingHelps: agentMsg({ id: 'reply.setting.helps', text: 'When it helps: {helps}', note: 'cw_read_setting: when the setting helps.' }),
  settingRestart: agentMsg({ id: 'reply.setting.restart', text: 'A change applies {restart}.', note: 'cw_read_setting: when a change applies.' }),
  settingReadOnly: agentMsg({ id: 'reply.setting.readOnly', text: 'Read-only to you: {why}', note: "cw_read_setting: the Assistant can't change it, and why." }),
  settingDocs: agentMsg({ id: 'reply.setting.docs', text: 'User guide: "{docs}".', note: "cw_read_setting: the user guide's section on it." }),
  settingSame: agentMsg({ id: 'reply.setting.same', text: '{path}{hasProject, select, yes { ({project})} other {}} was already {value}: nothing changed.', note: 'cw_update_setting when the value was already so.' }),
  settingChanged: agentMsg({ id: 'reply.setting.changed', text: "Changed {path}{hasProject, select, yes { in {project}} other {}} ({id}): {old} → {new}. {hasRestart, select, yes {It applies {restart}.} other {It applies now.}} The user can undo it in your panel's list.", note: "cw_update_setting's reply: what changed, old → new, and when it applies." }),
  journalNoMatch: agentMsg({ id: 'reply.journal.noMatch', text: 'No entries match "{query}".', note: 'cw_journal_recall with a query nothing matches (#1031).' }),
  journalNone: agentMsg({ id: 'reply.journal.none', text: 'No entries.', note: 'cw_journal_recall with no entries.' }),
  markEssential: agentMsg({ id: 'reply.journal.mark.essential', text: 'essential', note: "A journal entry's mark: importance 3." }),
  markImportant: agentMsg({ id: 'reply.journal.mark.important', text: 'important', note: "A journal entry's mark: importance 2." }),
  markByHive: agentMsg({ id: 'reply.journal.mark.byCombwork', text: 'by Combwork', note: "A journal entry's mark: Combwork recorded it." }),
  markDetail: agentMsg({ id: 'reply.journal.mark.detail', text: 'detail', note: "A journal entry's mark: it has detail (hive_journal_get reads it)." }),
  markSuperseded: agentMsg({ id: 'reply.journal.mark.superseded', text: 'superseded by #{id}', note: "A journal entry's mark: the entry that superseded it." }),
  journalHead: agentMsg({ id: 'reply.journal.head', text: '#{id} {kind}{hasProject, select, yes { · {project}} other {}}, {at}{byHive, select, yes {, by Combwork} other {}}, importance {importance}{changed, select, yes {, changed {updatedAt}} other {}}', note: "A journal entry in full: its id, kind, project, when, who recorded it, its importance and when it changed." }),
  journalWhy: agentMsg({ id: 'reply.journal.why', text: 'Why: {why}', note: "A journal entry's why." }),
  journalDigest: agentMsg({ id: 'reply.journal.digest', text: 'Digest of {of}.', note: 'A journal entry that digests others.' }),
  journalLinks: agentMsg({ id: 'reply.journal.links', text: 'Links: {links}', note: "A journal entry's links (type and ref)." }),
  journalTags: agentMsg({ id: 'reply.journal.tags', text: 'Tags: {tags}', note: "A journal entry's tags." }),
  journalSupersededBy: agentMsg({ id: 'reply.journal.supersededBy', text: 'Superseded by #{id}.', note: 'A journal entry superseded by another.' }),
  journalSupersedes: agentMsg({ id: 'reply.journal.supersedes', text: 'Supersedes {ids}.', note: 'The entries a journal entry supersedes.' }),
  slotLost: agentMsg({ id: 'reply.slot.lost', text: 'Your earlier hold on the merge slot for {branch} ended: {why}.', note: "The merge slot (#350): the agent's earlier hold ended, and why; the reply's own line follows." }),
  slotHeld: agentMsg({ id: 'reply.slot.held', text: 'You hold the merge slot for {branch}{extended, select, yes { (extended)} other {}}, {left} left. Release it once merged.', note: 'A claim of the merge slot: held, and how long is left.' }),
  slotNotInLine: agentMsg({ id: 'reply.slot.notInLine', text: "You aren't in line for the merge slot for {branch} any more: claim it again.", note: 'A claim of the merge slot that lost its place.' }),
  slotWaiting: agentMsg({ id: 'reply.slot.waiting', text: 'Waiting for the merge slot for {branch}: {position} in line{hasHolder, select, yes {; {holder}} other {}}. Claim again to keep your place.', note: "A claim of the merge slot: its place in line (an ordinal), and who holds it." }),
  slotReleased: agentMsg({ id: 'reply.slot.released', text: 'Released the merge slot for {branch}{hasNext, select, yes {; {next} has it now} other {}}.', note: 'A release of the merge slot, and who has it now.' }),
  slotLeft: agentMsg({ id: 'reply.slot.left', text: 'Left the line for the merge slot for {branch}.', note: 'A release while waiting in line.' }),
  slotHeldMark: agentMsg({ id: 'reply.slot.heldMark', text: '{branch} ({held, select, yes {held} other {waiting}})', note: 'A merge slot the agent holds or waits for (#586).' }),
  slotYours: agentMsg({ id: 'reply.slot.yours', text: 'Yours: {slots}; release with its branch.', note: 'A release of a slot not held (#586): the ones the agent does hold or wait for.' }),
  slotNoOther: agentMsg({ id: 'reply.slot.noOther', text: 'You hold and wait for no other merge slot of this project.', note: 'A release of a slot not held, when the agent has no other.' }),
  slotFree: agentMsg({ id: 'reply.slot.free', text: 'it is free', note: 'Who holds a merge slot: nobody.' }),
  slotNotHeld: agentMsg({ id: 'reply.slot.notHeld', text: "You don't hold the merge slot for {branch} ({holder}).", note: "A release of a slot the agent doesn't hold, and who does." }),
  slotStatus: agentMsg({ id: 'reply.slot.status', text: 'Merge slot for {branch}: {line}{hasWaiting, select, yes {; waiting: {waiting}} other {}}.', note: "A merge slot's status: who holds it, for how long, and who waits." }),
  consoleNone: agentMsg({ id: 'reply.console.none', text: 'No developer console sources you can read.', note: 'cw_console (#636) with no sources.' }),
  consoleRow: agentMsg({ id: 'reply.console.row', text: '{label}{hasProvider, select, yes { ({provider})} other {}}: {capturing, select, yes {captured, {events} events} other {not captured}} [{args}]', note: 'A developer console source: its label, its provider, whether an open console captures it, and the arguments cw_console takes for it.' }),
  consoleMore: agentMsg({ id: 'reply.console.more', text: 'Sources {from}–{to} of {total}: offset={to} for more.', note: 'cw_console sources, one page: which, and the offset for more.' }),
  consoleNotCaptured: agentMsg({ id: 'reply.console.notCaptured', text: "not captured: the developer console isn't open on it (Combwork captures only while the user has it open), so there is nothing to read.", note: 'A read of a source no open console captures: there is nothing to read, and why.' }),
  consoleGone: agentMsg({ id: 'reply.console.gone', text: 'Not in its buffer now: {events}.', note: 'Events asked for in full that are no longer kept.' }),
  consoleNoEvents: agentMsg({ id: 'reply.console.noEvents', text: '{label}: captured by the open console; no events{hasNewest, select, yes { after #{newest}} other { yet}}.', note: 'A read with no events (after the one given).' }),
  consoleCut: agentMsg({ id: 'reply.console.cut', text: '[cut]', note: "A console event's mark: its summary was cut." }),
  consoleNewer: agentMsg({ id: 'reply.console.newer', text: '{n} more after these.', note: 'A read of events: how many more after these.' }),
  consoleOlder: agentMsg({ id: 'reply.console.older', text: '{n} earlier not shown.', note: 'A read of events: how many earlier ones are not shown.' }),
  consoleNext: agentMsg({ id: 'reply.console.next', text: "Next: since={newest}. seq=[n] gives an event's raw payload and what Combwork made of it.", note: 'A read of events: the since for the next one, and how to read one in full.' }),
  queuePaused: agentMsg({ id: 'reply.queue.paused', text: 'paused ({reason}{by, select, user {, by the user} assistant {, by the Assistant} other {}}{hasCard, select, yes {, at {card}} other {}}{hasFiles, select, yes {: {files}} other {}})', note: "A merge queue's state (#1353): paused, why, by whom, at which card and on which files." }),
  queueRunBy: agentMsg({ id: 'reply.queue.runBy', text: 'run by {by}', note: "A merge queue's state: another Combwork runs it." }),
  queueRunning: agentMsg({ id: 'reply.queue.running', text: 'running', note: "A merge queue's state: running." }),
  queueEmpty: agentMsg({ id: 'reply.queue.empty', text: 'empty', note: "A merge queue's state: nothing in it." }),
  queueHead: agentMsg({ id: 'reply.queue.head', text: 'Merge queue for {target} in {project}: {state}.', note: "cw_queue list's line for a target's queue." }),
  queueHow: agentMsg({ id: 'reply.queue.how', text: "to {purpose}, in the {place, select, project {project folder} other {target's folder}}: {command}", note: "A merge queue stopped part way (#1351): a command that settles it, what for and where to run it. Joined by \"; \", its first letter made a capital." }),
  queueFilesMore: agentMsg({ id: 'reply.queue.filesMore', text: '{files}, {n} more', note: 'A list cut short (files, processes): those shown, and how many more.' }),
  queueStuck: agentMsg({ id: 'reply.queue.stuck', text: 'Stopped part way ({phase}): {hasBranch, select, yes {the folder is on {branch}} other {the folder has no branch}}, {target} at {ref} (expected {expected}, result {result}){hasFiles, select, yes {; files {files}} other {}}.', note: 'An advance into the checked-out target left part way (#1351): where it stands; how to settle it follows.' }),
  queueTesting: agentMsg({ id: 'reply.queue.testing', text: 'Testing: {key} {title} at {revision}{hasStep, select, yes { ({step})} other {}}.', note: 'The entry the merge queue is testing, and its step.' }),
  queueQueued: agentMsg({ id: 'reply.queue.queued', text: 'Queued: {entries}{hasMore, select, yes {; {more} more} other {}}.', note: 'The entries waiting in the merge queue, in order.' }),
  queueMerged: agentMsg({ id: 'reply.queue.merged', text: '{key} merged ({result}{outside, select, yes {, outside Combwork} other {}})', note: 'A recent outcome of the merge queue: merged, at which commit.' }),
  queueReturned: agentMsg({ id: 'reply.queue.returned', text: '{key} returned ({reason}{transient, select, yes {, transient} other {}}{hasFiles, select, yes {: {files}} other {}})', note: 'A recent outcome of the merge queue: returned, why, and its files.' }),
  queueCancelled: agentMsg({ id: 'reply.queue.cancelled', text: '{key} cancelled ({reason})', note: 'A recent outcome of the merge queue: cancelled, why.' }),
  queueRecent: agentMsg({ id: 'reply.queue.recent', text: 'Recent: {outcomes}.', note: "The merge queue's latest outcomes, newest first." }),
  queuesNone: agentMsg({ id: 'reply.queue.none', text: 'No merge queue in {project}: no card has been queued, and none is paused.', note: 'cw_queue list with no queue.' }),
  queueStillPaused: agentMsg({ id: 'reply.queue.stillPaused', text: 'Still paused: its cause is still there. {queue}', note: 'Resume while the cause is still there: the queue as it is now.' }),
  teamNotPaused: agentMsg({ id: 'reply.team.notPaused', text: 'The team is not paused.', note: 'cw_team (HI-2081): not paused.' }),
  teamParked: agentMsg({ id: 'reply.team.parked', text: 'The team is paused (by {by}) and parked.', note: 'cw_team: paused and parked.' }),
  teamPaused: agentMsg({ id: 'reply.team.paused', text: 'The team is paused (by {by}), not parked yet: {n} still running or unchecked.', note: 'cw_team: paused, not parked yet.' }),
  theUser: agentMsg({ id: 'reply.team.theUser', text: 'the user', note: 'Who paused the team, where none is named.' }),
  teamSafe: agentMsg({ id: 'reply.team.safe', text: 'Safe to install: {safe, select, yes {yes} other {no}}.', note: 'cw_team: whether it is safe to install an update now.' }),
  teamHive: agentMsg({ id: 'reply.team.cw', text: 'Combwork', note: "What still runs that isn't an agent's: Combwork's own." }),
  teamUnchecked: agentMsg({ id: 'reply.team.unchecked', text: "(can't be checked)", note: 'cw_team: what still runs whose state is unknown.' }),
  teamMore: agentMsg({ id: 'reply.team.more', text: '…and {n} more.', note: 'cw_team cut at 200 rows.' }),
  releaseNone: agentMsg({ id: 'reply.release.none', text: 'Nothing to release in {project}: no slot is kept for an agent, and no ended run holds one.', note: 'cw_release_slot list (#1561) with nothing to release.' }),
  releaseCarried: agentMsg({ id: 'reply.release.carried', text: '{slot}: kept for {agent} (kind carried).', note: 'cw_release_slot list: a slot kept for an agent (kind is what release takes).' }),
  releaseProcs: agentMsg({ id: 'reply.release.processes', text: 'Its run left running: {processes} (end: true ends them first).', note: "cw_release_slot list: a held writer's processes still running." }),
  releaseUnknown: agentMsg({ id: 'reply.release.unknown', text: "Combwork doesn't know which of its processes still run.", note: "cw_release_slot list: a held writer's processes are not known." }),
  releaseHeld: agentMsg({ id: 'reply.release.held', text: '{slot}: held by {agent}\'s ended run {run}, its Combwork {hive} (kind writer, confirm \'{\'"slot":"{slot}","run":"{run}"\'}\').', note: 'cw_release_slot list: a slot held by an ended run, and the confirm release takes (JSON: keep it as it is).' }),
  releasedCarried: agentMsg({ id: 'reply.release.releasedCarried', text: 'Released {slot} in {project}: no longer kept for {agent}; its folder and branch stay.', note: 'cw_release_slot release of a carried slot.' }),
  releasedWriter: agentMsg({ id: 'reply.release.releasedWriter', text: "Released {slot} in {project}: {agent}'s ended run no longer holds it{ended, select, yes {, its listed processes ended first} other {}}.", note: "cw_release_slot release of a writer's slot." }),
  context200k: agentMsg({ id: 'reply.connection.context200k', text: '200K', note: "A connection's value: the 200K context window." }),
  connectionArgs: agentMsg({ id: 'reply.connection.args', text: 'args {args}', note: "A connection's extra arguments for its CLI." }),
  connectionTag: agentMsg({ id: 'reply.connection.tag', text: 'tag {tag}', note: "A connection's free-text tag (HI-2530), which a usage move matches by." }),
  cliDefaults: agentMsg({ id: 'reply.connection.cliDefaults', text: "the CLI's defaults", note: 'A connection with no values of its own.' }),
  connectionRow: agentMsg({ id: 'reply.connection.row', text: '{name} (id {id}) on {account}, {cli}: {values}{unusable, select, yes {. Not usable here: its account is off} other {}}', note: 'cw_connection list (HI-2108): a connection, its account and CLI, its values, and whether it is usable here.' }),
  unknownCli: agentMsg({ id: 'reply.connection.unknownCli', text: 'unknown CLI', note: "A connection whose CLI isn't known." }),
  accountBare: agentMsg({ id: 'reply.connection.accountBare', text: 'Account {name} (id {id}), {cli}: no connections{off, select, yes {, off here} other {}}', note: 'cw_connection list: an account with no connections.' }),
  connectionsNone: agentMsg({ id: 'reply.connection.none', text: 'No connections: the user adds an account in Settings → Accounts & Connections.', note: 'cw_connection list with none.' }),
  usageLimit: agentMsg({ id: 'reply.usage.limit', text: '{label} {percent}%{hasReset, select, yes { (resets {at}Z)} other {}}', note: "An account's limit (HI-2195): its share used and when it resets (UTC)." }),
  usageMove: agentMsg({ id: 'reply.usage.move', text: 'moves its agents to {to} at {percent}% of {limit, select, weekly {the weekly limit} fiveHour {the 5-hour limit} other {either limit}}', note: "An account's usage move (HI-2195): where its agents move, at what share of which limit." }),
  usageNoFigures: agentMsg({ id: 'reply.usage.noFigures', text: 'no figures yet', note: 'An account with no usage figures yet.' }),
  usage: agentMsg({ id: 'reply.usage.line', text: 'Usage of {account}: {usage}', note: "cw_connection list's line for an account's usage (joined by \"; \")." }),
  connectionChanged: agentMsg({ id: 'reply.connection.changed', text: '{verb, select, Changed {Changed} other {Made}} {name} (id {id}) on {account}: {values}.{verb, select, Changed { Running agents on it take it when restarted.} other {}}', note: 'cw_connection add or update (HI-2108): what it is now.' }),
  templatesNone: agentMsg({ id: 'reply.template.none', text: 'No templates for {project}.', note: 'cw_template list (HI-1502) with none.' }),
  templateRow: agentMsg({ id: 'reply.template.row', text: "{name} (scope {scope}{hasFrom, select, yes {, from {from}} other {}}, file {file}): {agents} agents{hasWorkflow, select, yes {, workflow for {workflow}} other {}}{hasProblem, select, yes {. Can't be used: {problem}} other {}}", note: 'cw_template list: a template, what load needs to name it (scope, from and file), its agents and workflow, and why it can\'t be used.' }),
  wfGitOnly: agentMsg({ id: 'reply.template.wf.gitOnly', text: 'Its workflow is for Git only and this project has no version control.', note: "A template's workflow that can't apply: Git only." }),
  wfDropped: agentMsg({ id: 'reply.template.wf.dropped', text: "Its workflow ({platforms}) can't be used here.", note: "A template's workflow that can't apply here." }),
  wfChanges: agentMsg({ id: 'reply.template.wf.changes', text: '{n} options {will, select, yes {change} other {changed}} ({changes})', note: "A template's workflow: how many options it changes (or changed), each old → new." }),
  wfNoChanges: agentMsg({ id: 'reply.template.wf.noChanges', text: 'no option changes', note: "A template's workflow that changes no option." }),
  wfPlan: agentMsg({ id: 'reply.template.wf.plan', text: 'Workflow ({platform}): {changes}', note: "A plan's workflow: what it would change." }),
  wfSaved: agentMsg({ id: 'reply.template.wf.saved', text: 'Workflow ({platform}) saved: {changes}', note: "A load's workflow saved." }),
  wfNotSaved: agentMsg({ id: 'reply.template.wf.notSaved', text: 'Workflow not saved: {why}', note: "A load's workflow not saved, and why." }),
  wfNone: agentMsg({ id: 'reply.template.wf.none', text: 'it has none for this project', note: "Why a load's workflow wasn't saved, where none is given." }),
  wfLine: agentMsg({ id: 'reply.template.wf.line', text: '{head}{hasMissing, select, yes {; checks with no command here (set them in Version Control): {commands}} other {}}{identityOff, select, yes {; identity stays off (no git identity here)} other {}}.{keep, select, yes { Lanes and cards in flight keep their rules.} other {}}', note: "A template's workflow in a plan's or a load's reply: what it changes, checks with no command, the identity left off." }),
  planAgent: agentMsg({ id: 'reply.template.planAgent', text: '{name}{renamed, select, yes { ({template})} other {}} {role}{paired, select, yes { with {pairedWith}} other {}} on {connection}', note: "cw_template plan: an agent it would create, its template's name, its role, who it pairs with and its connection." }),
  noConnection: agentMsg({ id: 'reply.template.noConnection', text: 'no connection', note: 'An agent a plan would create with no connection.' }),
  noAgents: agentMsg({ id: 'reply.template.noAgents', text: 'no agents', note: 'A plan or load that removes no agents.' }),
  planHead: agentMsg({ id: 'reply.template.planHead', text: '"{name}" into {project}: removes {remove}; creates {create}.', note: 'cw_template plan (HI-1502): what loading would do.' }),
  planTaken: agentMsg({ id: 'reply.template.taken', text: 'Taken: {names}.', note: 'cw_template plan: names taken, each with a free one.' }),
  planTakenOne: agentMsg({ id: 'reply.template.takenOne', text: '{name} ({project}\'s): try "{suggestion}"', note: "A name taken by another project's agent, and a free one." }),
  planOptions: agentMsg({ id: 'reply.template.options', text: 'Connections here: {connections}.', note: 'cw_template plan: the connections the agents can take.' }),
  planBlocked: agentMsg({ id: 'reply.template.blocked', text: "Can't load yet: {why}", note: 'cw_template plan: what stops the load.' }),
  loadRenamed: agentMsg({ id: 'reply.template.renamed', text: '{template} named {name}', note: 'cw_template load: an agent given another name than its template\'s.' }),
  loadOn: agentMsg({ id: 'reply.template.on', text: 'On: {connections}.', note: 'cw_template load: the connections its agents got.' }),
  loaded: agentMsg({ id: 'reply.template.loaded', text: 'Loaded "{name}" into {project}: removed {removed}; created {created}{renamed}.{on}{workflow} cw_undo can put the agents and options back.', note: 'cw_template load (HI-1502): what was loaded, names given, and its workflow saved or why not.' }),
  appliedNone: agentMsg({ id: 'reply.template.appliedNone', text: 'no agent changed (each already on it)', note: 'cw_template apply (HI-2109) that changed no agent.' }),
  appliedRestart: agentMsg({ id: 'reply.template.appliedRestart', text: 'Running on the old one until restarted: {agents}.', note: 'cw_template apply: agents that keep the old connection until restarted.' }),
  appliedSkipped: agentMsg({ id: 'reply.template.appliedSkipped', text: 'Skipped: {agents}.', note: 'cw_template apply: agents skipped, each with why.' }),
  applied: agentMsg({ id: 'reply.template.applied', text: 'Connections in {project}: {changed}.{restart}{skipped}{undo, select, yes { cw_undo can put them back.} other {}}', note: 'cw_template apply (HI-2109): who got which connection, who to restart, who was skipped.' }),
  tellsCheckpoints: agentMsg({ id: 'reply.message.tells.checkpoints', text: 'at its next tool call', note: 'How Combwork tells an agent of a message (#1432): at its next tool call.' }),
  tellsStop: agentMsg({ id: 'reply.message.tells.stopContinuation', text: "at its turn's end", note: "How Combwork tells an agent of a message: at its turn's end." }),
  tellsIdle: agentMsg({ id: 'reply.message.tells.idleWakes', text: 'once it is idle', note: 'How Combwork tells an agent of a message: once it is idle.' }),
  tells: agentMsg({ id: 'reply.message.tells', text: 'Combwork tells it {ways}', note: 'cw_message_agent (#1497): how Combwork tells the agent of the message (joined with reply.list.or).' }),
  inboxWaits: agentMsg({ id: 'reply.message.inbox', text: 'it waits in its inbox until it reads it with cw_inbox (the user can Deliver Now)', note: 'cw_message_agent with no carrying-on switch on: the message waits in its inbox.' }),
  queued: agentMsg({ id: 'reply.message.queued', text: 'Queued for {who} ({id}{tied}, {status}): {how}; {queued} waiting. cw_agent_activity says when it is received and acked.', note: "cw_message_agent's reply for a message queued (#1497)." })
} as const

const yn = (b: unknown): 'yes' | 'no' => (b ? 'yes' : 'no')
/** A list joined one by one with reply.list.or or reply.list.and ("a or b or c"), as the code always joined them. */
const joined = (items: readonly string[], m: AgentMsg): string => items.reduce((a, b) => say(m, { a, b }))

/** A running agent's CLI's own default, where its launch gave none and it hasn't said (HI-1996). */
// agent-protocol: a model or effort value in cw_agent_activity's JSON, the CLI's default
export const CLI_DEFAULT = 'default'

/**
 * The model and effort a running agent uses (HI-1996, cw_agent_activity): what its CLI reports, else what its launch
 * gave it (after the agent's, project's and connection's choices), else its CLI's default. Null: not running.
 */
export function modelInUse(st: Pick<LiveSessionState, 'modelId' | 'modelName' | 'effort' | 'launchedWith'> | null | undefined): { model: string; effort: string } | null {
  if (!st) return null
  return { model: st.modelId || st.modelName || st.launchedWith?.model || CLI_DEFAULT, effort: st.effort || st.launchedWith?.effort || CLI_DEFAULT }
}

/** A launch's retry waits as cw_agent_activity gives them (HI-1996); `latest.ongoing`: it waits now. */
export interface RetryWaitsView {
  waits: number
  seconds: number
  latest: { since: string; seconds: number; tries: number; status: number | null; network?: true; ongoing?: true; retryAt?: string }
}

/**
 * A launch's time waiting for its CLI to retry a model request (HI-1996): its finished waits, with the one under way
 * counted to now and the latest. Absent when it has had none, so a reply stays as it was.
 */
export function retryWaitsView(st: Pick<LiveSessionState, 'retryWait' | 'retryWaited'> | null | undefined, now = Date.now()): RetryWaitsView | undefined {
  const done = st?.retryWaited
  const w = st?.retryWait
  if (!done && !w) return undefined
  const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000))
  const doneSeconds = done ? secs(done.ms) : 0
  if (!w) {
    const l = done!.latest
    return { waits: done!.waits, seconds: doneSeconds, latest: { since: l.since, seconds: secs(Date.parse(l.ended) - Date.parse(l.since)), tries: l.tries, status: l.status, ...(l.network ? { network: true as const } : {}) } }
  }
  const so = secs(now - (Date.parse(w.since) || now))
  return { waits: (done?.waits ?? 0) + 1, seconds: doneSeconds + so, latest: { since: w.since, seconds: so, tries: w.attempt, status: w.status, ...(w.network ? { network: true as const } : {}), ongoing: true, ...(w.retryAt ? { retryAt: w.retryAt } : {}) } }
}

/** A card's request waiting for the user, as agents read it (TaskView.forYou); `asker` absent: Hive asked. */
export interface CardRequest {
  request: string
  kind: string
  gate: string
  text: string
  /** With `summary=true`, the whole text's length when `text` is only its first line (as a comment's). */
  length?: number
  asker?: string
  since: string
}

/**
 * A card's open requests for its reader (HI-1992): whole, or with `summary` each one's text cut as a comment's summary is
 * (#532). Absent when none waits, so a card with none reads as before.
 */
export function cardRequests(items: readonly { request: string; kind: string; gate: string; text: string; shown?: StoredText; asker: string | null; since: string }[], summary = false): CardRequest[] | undefined {
  if (!items.length) return undefined
  return items.map((i) => {
    // Hive's own request (`shown`, its message as data): said again in the reader's chain, else its English as stored (HI-2464).
    const text = storedForAgents(i.text, i.shown)
    const said = summary ? commentSummary({ text }) : { text }
    return { request: i.request, kind: i.kind, gate: i.gate, ...said, ...(i.asker ? { asker: i.asker } : {}), since: i.since }
  })
}

/** A card as the Agent API shows it: with what its agent is doing now, and why it is stalled. */
export interface TaskView extends Omit<TaskCard, 'agent' | 'decisions' | 'held'> {
  /** The user's decisions, first (#357); without their ids. Absent when there are none. */
  decisions?: Omit<TaskDecision, 'id'>[]
  agent: { id: string; name: string; status: string; backgroundTasks: number } | null
  stalled: string | null
  /** With a review going on (TaskCard.review): why it has stalled (its reviewer removed or not running), if it has. */
  reviewStalled?: string
  /**
   * Who merges it and where it is with the merge queue, when its own rules say Hive merges it (#1354): queued (its
   * position), testing, paused, returned (what came back and what to do), left the queue, merged.
   */
  merge?: string
  /** For a project agent: the cards in blockedBy and links that are another project's (it sees only their numbers). */
  elsewhere?: number[]
  /**
   * Its requests waiting for the user (For you, HI-1932), oldest first, just after its decisions (HI-1992): each one's id
   * (what a decision's `answers` names), kind, gate, words, who asked and when. Absent when none waits.
   */
  forYou?: CardRequest[]
  /**
   * Files kept with the card (HI-1700), newest first: full path (open it with your tools), name, size, who added it and
   * when, and where it came (a comment's author and time, the description, a session). `missing`: its file is gone.
   */
  attachments?: { path: string; name: string; size: number; by: string; at: string; from: string; missing?: true }[]
  /**
   * A narrowed read (HI-2402: `comments=n`, `summary=true`): how many attachments it leaves out, those that didn't come
   * with a comment returned in full (`attachments=true` gives them all). Absent when none is left out.
   */
  attachmentsOmitted?: number
  /** Its 1.0 stage (#1223): `column` is the stage's category. Last, after the card's own fields. */
  stage: StageId
  /**
   * A code card's checks before review, by its own rules (HI-2276): their names, as data. Absent where its rules name
   * none, or once it is past review; `checksHint` then too.
   */
  checks?: string[]
  /** With `checks`: how to run one as that check of the card, a fixed line with `<name>` (`checksView`). */
  checksHint?: string
}

/**
 * The checks a code card's rules name before review and how to run one (HI-2276): the names as data and a fixed hint
 * with a `<name>` placeholder, never a shell command built from a configured name (free text: quoting it for every
 * shell kept failing, HR1's rounds 1 and 2). The rule for running them stays in work-on-card. `card` is its key;
 * `isolated`: its platform can make a check copy.
 */
export function checksView(names: readonly string[], card: string, isolated: boolean): { checks: string[]; checksHint: string } | null {
  if (!names.length) return null
  return { checks: [...names], checksHint: say(R.checksHint, { card, isolated: yn(isolated) }) }
}

/** A card in a listing (GET /v1/tasks?view=short): what it is and where it stands, without its text. */
export interface TaskRow {
  number: number
  /** Its key (#1219: HI-12), when it has one. */
  key?: string
  /** How its text names the cards it waits for (#1219: "HI-3 (#12)"), by number, for the hive MCP server (namesOf). */
  names?: Record<string, string>
  title: string
  column: TaskColumn
  project: string
  agent: { name: string; status: string; backgroundTasks: number } | null
  labels: string[]
  blocked: string | null
  blockedBy: number[]
  /** Cards in blockedBy that are another project's (a project agent sees only their numbers). */
  elsewhere?: number[]
  stalled: string | null
  /** The agent reviewing it now (TaskCard.review), and why that has stalled if it has. */
  reviewing?: { name: string; stalled?: string }
  comments: number
  archived: boolean
}

export function taskRow(v: TaskView): TaskRow {
  return {
    number: v.number,
    ...(v.key ? { key: v.key } : {}),
    title: v.title,
    column: v.column,
    project: v.project,
    agent: v.agent && { name: v.agent.name, status: v.agent.status, backgroundTasks: v.agent.backgroundTasks },
    labels: v.labels,
    blocked: v.blocked,
    blockedBy: v.blockedBy,
    ...(namesOf(v.blockedBy) ? { names: namesOf(v.blockedBy) } : {}),
    ...(v.elsewhere?.length ? { elsewhere: v.elsewhere } : {}),
    stalled: v.stalled,
    ...(v.review ? { reviewing: { name: v.review.agentName, ...(v.reviewStalled ? { stalled: v.reviewStalled } : {}) } } : {}),
    comments: v.comments.length,
    archived: v.archived
  }
}

/** A card without its history (GET /v1/tasks/{n}?history=false): the description and comments stay. */
export function withoutHistory<T extends { history: unknown[] }>(v: T): Omit<T, 'history'> & { historyEntries: number } {
  const { history, ...rest } = v
  return { ...rest, historyEntries: history.length }
}

/**
 * A card with only its newest `n` comments (GET /v1/tasks/{n}?comments=n): its description stays, and commentsOmitted
 * says how many earlier ones there are, so a long card's latest feedback can be read without its whole thread.
 */
export function newestComments<T extends { comments: unknown[] }>(v: T, n: number): T & { commentsOmitted: number } {
  const omitted = Math.max(0, v.comments.length - n)
  return { ...v, comments: v.comments.slice(omitted), commentsOmitted: omitted }
}

/**
 * GET /v1/tasks/{n}'s `comments=` (HI-2412): null when absent, else a whole number from 0 (0: none of them, all counted in
 * commentsOmitted); anything else is a string saying what's wrong.
 */
export function commentsParam(raw: string | null): number | null | { error: string } {
  if (raw === null) return null
  const n = raw.trim() === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : { error: say(R.commentsInvalid, { raw }) }
}

/**
 * cw_read_task's query for GET /v1/tasks/{n} (HI-2412): `comments` passes through whenever it is given, 0 included (0
 * reads none of them), so the API answers it or says what's wrong with it, never falling back to every comment.
 */
export function readTaskQuery(a: { history?: unknown; comments?: unknown; summary?: unknown; attachments?: unknown }): string {
  const c = a.comments === undefined || a.comments === null ? '' : `comments=${typeof a.comments === 'number' && Number.isFinite(a.comments) ? Math.floor(a.comments) : encodeURIComponent(String(a.comments))}`
  return [a.history ? '' : 'history=false', c, a.summary ? 'summary=true' : '', a.attachments === true ? 'attachments=true' : ''].filter(Boolean).join('&')
}

/** What a change did to a card (reply: "short"): the changes in words and where the card is now. */
export interface TaskChange {
  number: number
  /** Its key (#1219: HI-12), when it has one. */
  key?: string
  title: string
  column: TaskColumn
  /** Its place in its column, 1 at the top; null when archived. */
  position: number | null
  of: number
  project: string
  agent: string | null
  changes: string[]
  /** A line suggesting a shorter title (HI-1872, main/titleNudge.ts): the agent's long title was kept. */
  nudge?: string
}

export const ordinal = (n: number): string => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

const place = (c: Pick<TaskChange, 'column' | 'position' | 'of'>): string => (c.position ? say(R.place, { column: columnLabel(c.column), position: ordinal(c.position), of: c.of }) : columnLabel(c.column))

/** "HI-61 (#61) created in Todo (51st of 51) for alpha, given to Coder: Lean replies" (#61 for a card with no key). */
export function createdText(c: TaskChange): string {
  // The files it was made with (HI-1700), each stored or already kept.
  const line = say(R.created, { card: cardName(c), place: place(c), forProject: yn(c.project), project: c.project, givenTo: yn(c.agent), agent: c.agent ?? '', title: c.title, changed: yn(c.changes.length), changes: c.changes.join('; ') })
  return `${line}${c.nudge ? `\n${c.nudge}` : ''}`
}

/** "HI-60 (#60) Lean replies: Commented; Moved to Review. Now in Review (1st of 4), alpha, Coder." */
export function changedText(c: TaskChange): string {
  const what = c.changes.length ? c.changes.join('; ') : say(R.noChange)
  const line = say(R.changed, { card: cardName(c), title: c.title, what, place: place(c), hasProject: yn(c.project), project: c.project, hasAgent: yn(c.agent), agent: c.agent ?? '' })
  return `${line}${c.nudge ? `\n${c.nudge}` : ''}`
}

/** What a card's intent did (#1267, SPEC §16.8.1): the card, the stage it left and the one it is in, what the intent says of it (start: folder, line, base, target; start review: revision, base, files), warnings. */
export interface IntentDone {
  ok: true
  card: string
  from: string
  to: string
  data?: Record<string, unknown>
  warnings?: string[]
  /** What comes next on the card under its rules (#1530, shared/workflow/nextStep.ts). */
  next?: NextStep
  /** The card watch Hive armed for the agent after its submission or failed verdict in a lane (#1639, main/intentWatch.ts). */
  watch?: string
  /**
   * A lane's builder starting its lane's card itself (HI-2092): what Hive's start of it would have given it, the start
   * prompt's skill line and the lane's brief, on lines of their own after the rest.
   */
  lane?: string
}

/** What a reply says comes next (#1530): an agent follows it rather than infer the step from a column. */
function nextText(n: NextStep): string {
  switch (n.step) {
    case 'intents':
      return say(R.nextIntents, { tools: joined(n.intents.map((i) => INTENT_TOOL[i] ?? i), R.or) })
    case 'review':
      return say(R.nextReview)
    case 'user':
      return say(R.nextUser)
    case 'merge':
      return say(R.nextMerge)
    case 'queue':
      return say(R.nextQueue)
    case 'done':
      return say(R.nextDone)
  }
}

/** The hive tool of each intent: an old move's reply says to call it next time (#1268), an intent's names what's next (#1530). */
/** A workflow refusal as the Agent API gives it (SPEC §16.8.3). */
export interface Refused {
  refused: true
  rule: string
  message: string
  next: string
  change?: string
  override: string | null
  /** HI-2339: what else to know (a None submit's files left out of its paths), each a line, as a moved reply's. */
  warnings?: string[]
}

/** A refusal's three sentences, each on a line, and its rule: what was refused, what to do next, where the rule is changed; then its warnings. */
export const refusedText = (r: Refused): string => [`${r.message} (${r.rule})`, r.next, ...(r.change ? [r.change] : []), ...(r.warnings ?? []).map((warning) => say(R.warning, { warning }))].join('\n')

// agent-protocol: intent names and the hive tools that take them
export const INTENT_TOOL: Record<string, string> = { start: 'cw_start_card', submit: 'cw_submit', verdict: 'cw_verdict', 'report merge': 'cw_report_merge', 'put back': 'cw_put_back', 'start review': 'cw_start_review' }

/** At most this many of a list in an intent's reply (start review's files): the rest counted. */
const INTENT_LIST_MAX = 20

/** "HI-12: active → review. revision: 3f2a…; base: 9c1d… Next on it: cw_start_review or cw_verdict." and a line per warning. */
export function intentText(d: IntentDone): string {
  const where = d.from && d.to ? (d.from === d.to ? say(R.intentStill, { stage: d.to }) : `${d.from} → ${d.to}`) : say(R.intentDone)
  // A list's item: a changed file as git's letter and its path ("M greet.js", #1444: start review's files read
  // [object Object]), anything else as it is.
  const item = (x: unknown): string => (x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string' ? `${(x as { status?: string }).status ? `${(x as { status: string }).status} ` : ''}${(x as { path: string }).path}` : typeof x === 'object' ? JSON.stringify(x) : String(x))
  const value = (v: unknown): string =>
    Array.isArray(v) ? (v.length > INTENT_LIST_MAX ? say(R.listMore, { items: v.slice(0, INTENT_LIST_MAX).map(item).join(', '), n: v.length - INTENT_LIST_MAX }) : v.map(item).join(', ') || say(R.listNone)) : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const facts = Object.entries(d.data ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${value(v)}`)
  return [`${d.card}: ${where}.${facts.length ? ` ${facts.join('; ')}` : ''}${d.next ? ` ${nextText(d.next)}` : ''}${d.watch ? ` ${d.watch}` : ''}`, ...(d.warnings ?? []).map((warning) => say(R.warning, { warning })), ...(d.lane ? ['', d.lane] : [])].join('\n')
}

/** What asking the Hive Assistant on a card did (HI-1866): the card, and the request's id in the Assistant's inbox ('' when it couldn't be given). */
export interface AskedAssistant {
  ok: true
  card: string
  delivery: string
}

/** "HI-12: asked the Hive Assistant (m41 in its inbox). Its answer comes to your inbox." */
export function askedAssistantText(a: AskedAssistant): string {
  if (!a.delivery) return say(R.askedNone, { card: a.card })
  return say(R.asked, { card: a.card, delivery: a.delivery })
}

/** "Notification shown; a click opens HB4." (HI-1961: `opens`, the agent or card its target names.) */
export const notifiedText = (r: { opens?: string }): string => (r.opens ? say(R.notifiedOpens, { opens: r.opens }) : say(R.notified))

/** One of the Assistant's changes as GET /v1/assistant/changes lists it (#1282). */
export interface ChangeListed {
  id: string
  what: string
  card?: number
  fields: string[]
  final?: string
  undone?: true
}

/** A message's changes as GET /v1/assistant/changes lists them, newest first. */
export interface ChangeGroupListed {
  group: string
  at: string
  changes: ChangeListed[]
}

/** The most changes of one message cw_undo lists before counting the rest. */
const UNDO_LIST_MAX = 40

/**
 * The Assistant's changes kept for undo (#1282): a line per message (its group id, when, how many changes and how many
 * are left to undo, and its cards); with `group`, that message's changes, a line each with its id.
 */
export function changeListText(groups: readonly ChangeGroupListed[], group?: string): string {
  if (group) {
    const g = groups.find((x) => x.group === group)
    if (!g) return say(R.changesNoneFor, { group })
    const line = (c: ChangeListed): string => `${c.id}: ${c.card !== undefined ? `${cardRef(c.card)} ` : ''}${c.what}${c.fields.length ? ` (${c.fields.join(', ')})` : ''}${c.undone ? ` ${say(R.changeUndone)}` : c.final ? ` ${say(R.changeFinal, { why: c.final })}` : ''}`
    const shown = g.changes.slice(0, UNDO_LIST_MAX).map(line)
    return [...shown, ...(g.changes.length > UNDO_LIST_MAX ? [say(R.changesMore, { n: g.changes.length - UNDO_LIST_MAX })] : [])].join('\n')
  }
  if (!groups.length) return say(R.changesNone)
  return groups
    .map((g) => {
      const left = g.changes.filter((c) => !c.undone && !c.final).length
      const cards = [...new Set(g.changes.flatMap((c) => (c.card !== undefined ? [c.card] : [])))]
      const listed = cards.slice(0, 12).map((n) => cardRef(n)).join(', ')
      return say(R.changeGroup, { group: g.group, at: g.at, n: g.changes.length, left, hasCards: yn(cards.length), cards: cards.length > 12 ? say(R.listMore, { items: listed, n: cards.length - 12 }) : listed })
    })
    .join('\n')
}

/** What undoing one change did (POST /v1/assistant/undo's `results`). */
export interface UndoneListed {
  change: string
  what: string
  card?: number
  undone: string[]
  skipped: { field: string; why: string; error?: string }[]
  final?: string
  already?: true
}

const SKIPPED_WHY: Record<string, AgentMsg> = { changed: R.skippedChanged, gone: R.skippedGone, ended: R.skippedEnded, failed: R.skippedFailed }

/** An undo's reply: how many changes were undone, then what of each was left and why (put back in full says nothing more). */
export function undoText(results: readonly UndoneListed[]): string {
  const done = results.filter((r) => r.undone.length && !r.skipped.length).length
  const head = say(R.undoHead, { done, n: results.length })
  const name = (r: UndoneListed): string => (r.card !== undefined ? cardRef(r.card) : r.what)
  const why = (w: string): string => (SKIPPED_WHY[w] ? say(SKIPPED_WHY[w]) : w)
  const notes = results.flatMap((r) => {
    if (r.already) return [say(R.undoBefore, { name: name(r) })]
    if (r.final !== undefined) return [say(R.undoFinal, { name: name(r), final: r.final })]
    if (!r.skipped.length) return []
    const skipped = r.skipped.map((s) => say(R.undoField, { field: s.field, why: why(s.why), hasError: yn(s.error), error: s.error ?? '' })).join(', ')
    return [say(R.undoPartial, { name: name(r), putBack: yn(r.undone.length), undone: r.undone.join(', '), skipped })]
  })
  return [head, ...notes.slice(0, UNDO_LIST_MAX), ...(notes.length > UNDO_LIST_MAX ? [say(R.undoMore, { n: notes.length - UNDO_LIST_MAX })] : [])].join('\n')
}

/** What a reorder did (reply: "short"). */
export interface TaskReorder {
  column: TaskColumn
  /** The cards put at the top, in order. */
  top: number[]
  /** How many cards the column has. */
  count: number
  /** How its text names those cards (#1219), by number (namesOf). */
  names?: Record<string, string>
  /** The running lanes holding any of them (HI-2267): their own order stands, and the reply says how to change it. */
  lanes?: LaneHolding[]
}

/** What a batch change did (reply: "short"): each card changed, and each card refused with why (left as it was). */
export interface TaskBatch {
  changed: TaskChange[]
  /**
   * `ref`: a key no card has (its number 0), as it was given. A refusal by the card's rules has its `rule`, `next` step
   * and `change` (who can change the rule), as cw_update_task's refusal does (HI-2238); `error` is then its message.
   */
  refused: { number: number; ref?: string; error: string; rule?: string; next?: string; change?: string }[]
  /** How its text names the cards refused (#1219), by number (namesOf). */
  names?: Record<string, string>
}

export function batchText(b: TaskBatch): string {
  return namedBy(namesFrom(b.names), () => batchLines(b))
}
function batchLines(b: TaskBatch): string {
  const lines = [b.changed.length ? say(R.batchChanged, { n: b.changed.length }) : say(R.batchNone)]
  for (const c of b.changed) lines.push(changedText(c))
  const plain = b.refused.filter((r) => !r.rule)
  if (plain.length) lines.push(say(R.batchRefused, { list: plain.map((r) => (r.ref ? r.error : `${cardRef(r.number)} (${r.error})`)).join('; ') }))
  // Refused by its rules: as cw_update_task's refusal reads (the message, its rule, the next step, who can change it),
  // named by its card first where its message doesn't name it ("{revision} was already reviewed.").
  for (const r of b.refused) {
    if (!r.rule) continue
    const ref = cardRef(r.number)
    const named = new RegExp(`(^|[^\\w-])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(r.error)
    lines.push(say(R.batchRefusedRule, { named: yn(named), ref, error: r.error, rule: r.rule }), ...(r.next ? [r.next] : []), ...(r.change ? [r.change] : []))
  }
  return lines.join('\n')
}

export function reorderText(r: TaskReorder): string {
  const rest = r.count - r.top.length
  const line = say(R.reorder, { column: columnLabel(r.column), cards: namedBy(namesFrom(r.names), () => r.top.map(cardRef).join(', ')), more: yn(rest > 0), rest })
  return [line, ...(r.lanes ?? []).map((l) => namedBy(namesFrom(r.names), () => laneOrderNote(l)))].join('\n')
}

/** A running lane holding cards a reply is about (HI-2267): its id, its builder's name and those cards. */
export interface LaneHolding {
  id: string
  builder: string
  cards: number[]
}

/**
 * HI-2267: put back or reordered on the board, a lane's card is still where its lane's own list has it, and the lane
 * takes it again in that order. The Assistant, calling the tools without a skill, reordered the column and was told
 * nothing of it. "AL-1 is on Coder's lane (lane-3f2a), which keeps its own order: to change it, cw_lane start…".
 */
export function laneOrderNote(l: LaneHolding): string {
  const one = l.cards.length === 1
  return say(R.laneOrder, { cards: l.cards.map(cardRef).join(', '), one: yn(one), builder: l.builder, lane: l.id })
}

const STATUS: Record<string, AgentMsg> = { ready: R.statusIdle, finished: R.statusIdle, background: R.statusBackground, waiting: R.statusWaiting, watching: R.statusWatching, signin: R.statusSignin }
/** An agent's status in words, or its status id where there are none. */
const statusText = (status: string): string => (STATUS[status] ? say(STATUS[status]) : status)

function agentText(a: TaskRow['agent']): string {
  if (!a) return ''
  const bits = [statusText(a.status)]
  if (a.backgroundTasks > 0 && a.status !== 'background') bits.push(say(R.backgroundTasks, { n: a.backgroundTasks }))
  return say(R.rowAgent, { name: a.name, state: bits.join(', ') })
}

/** "HI-35 (#35) Number settings · alpha · Coder (working) · bug · blocked: … · after #12 · reviewing: Codex · 3 comments". */
export function taskRowText(r: TaskRow): string {
  return namedBy(namesFrom(r.names), () => rowText(r))
}
function rowText(r: TaskRow): string {
  const bits = [`${cardName(r)} ${r.title}`]
  if (r.project) bits.push(r.project)
  if (r.agent) bits.push(agentText(r.agent))
  if (r.labels.length) bits.push(r.labels.join(', '))
  if (r.blocked) bits.push(say(R.rowBlocked, { why: r.blocked }))
  if (r.blockedBy.length) bits.push(say(R.rowAfter, { cards: r.blockedBy.map((n) => (r.elsewhere?.includes(n) ? say(R.rowElsewhere, { card: cardRef(n) }) : `${cardRef(n)}`)).join(', ') }))
  if (r.stalled) bits.push(say(R.rowStalled, { why: r.stalled }))
  if (r.reviewing) bits.push(say(R.rowReviewing, { name: r.reviewing.name, stalled: yn(r.reviewing.stalled), why: r.reviewing.stalled ?? '' }))
  if (r.comments) bits.push(say(R.rowComments, { n: r.comments }))
  return bits.join(' · ')
}

/** At most this many rows in one listing; the reply says how many more there are and where to carry on. */
export const MAX_ROWS = 200

/**
 * A listing of cards, by column in board order (top first), one line each: at most MAX_ROWS of them from `offset`.
 * A column's heading counts all its cards, also when the page starts or ends inside it.
 */
export function taskListText(rows: TaskRow[], opts: { archived?: boolean; offset?: number } = {}): string {
  if (!rows.length) return say(opts.archived ? R.listNoArchived : R.listNoCards)
  const from = Math.max(0, Math.floor(opts.offset ?? 0))
  if (from >= rows.length) return say(R.listPast, { n: rows.length, offset: from })
  const shown = rows.slice(from, from + MAX_ROWS)
  const out: string[] = from ? [say(R.listPage, { from: from + 1, to: from + shown.length, n: rows.length })] : []
  let column: TaskColumn | null = null
  for (const r of shown) {
    if (r.column !== column) {
      column = r.column
      const n = rows.filter((x) => x.column === column).length
      out.push(`${out.length ? '\n' : ''}${say(R.listColumn, { archived: yn(opts.archived), column: columnLabel(column), n })}`)
    }
    out.push(taskRowText(r))
  }
  const rest = rows.length - from - shown.length
  if (rest > 0) out.push(`\n${say(R.listRest, { n: rest, next: from + shown.length })}`)
  out.push(`\n${say(R.listRead)}`)
  return out.join('\n')
}

/** A project in a listing (GET /v1/projects?view=short). */
export interface ProjectRow {
  name: string
  workspace: string
  active: boolean
  branch: string | null
  /**
   * `watching`: what a watching agent waits for ("Waiting for #12 → Review"). `progress`: its open progress run, short
   * ("e2e: 12 suites 4/12, about 6 min left").
   */
  agents: { name: string; provider: string; workflowRole?: string; status: string; branch: string | null; backgroundTasks: number; watching?: string; progress?: string }[]
}

/** An agent's open progress run in a few words, title clipped, for the short listing. */
export function progressLabel(p: { title: string; step?: number; total?: number; etaMs?: number; stale?: boolean }): string {
  const title = p.title.length > 60 ? `${p.title.slice(0, 59)}…` : p.title
  const steps = p.total !== undefined ? ` ${p.step ?? 0}/${p.total}` : ''
  return say(R.progress, { title, steps, state: p.stale ? 'stopped' : p.etaMs !== undefined ? 'eta' : 'none', left: p.etaMs !== undefined ? shortDuration(p.etaMs) : '' })
}

export function projectRowText(p: ProjectRow, many: boolean): string {
  const head = say(R.projectHead, { name: `${many ? `${p.workspace}/` : ''}${p.name}`, active: yn(p.active), hasBranch: yn(p.branch), branch: p.branch ?? '' })
  if (!p.agents.length) return say(R.projectNoAgents, { head })
  const agents = p.agents.map((a) =>
    say(R.projectAgent, {
      name: a.name,
      tags: `${a.provider}${a.workflowRole ? `, ${a.workflowRole}` : ''}${a.branch ? `, ${a.branch}` : ''}`,
      // agent-protocol: the watch's own label (a value), its first word made lower case to follow the name
      state: a.watching ? a.watching.replace(/^Waiting/, 'waiting') : statusText(a.status),
      hasBackground: yn(a.backgroundTasks > 0),
      background: a.backgroundTasks,
      hasProgress: yn(a.progress),
      progress: a.progress ?? ''
    })
  )
  return `${head}: ${agents.join('; ')}`
}

export function projectListText(rows: ProjectRow[]): string {
  if (!rows.length) return say(R.projectsNone)
  const many = new Set(rows.map((r) => r.workspace)).size > 1
  return `${rows.map((r) => projectRowText(r, many)).join('\n')}\n\n${say(R.projectRead)}`
}

/**
 * cw_project_status: GET /v1/projects/{id} without what its settings only repeat or keep for Hive's own bookkeeping
 * (HI-1712): `lastPath` (its `path`), the file's `version` and `stepsDone` (one-time steps already taken).
 */
export function projectStatusReply(p: unknown): unknown {
  if (!p || typeof p !== 'object' || !('settings' in p) || !p.settings || typeof p.settings !== 'object') return p
  const { lastPath: _path, version: _version, stepsDone: _steps, ...settings } = p.settings as Record<string, unknown>
  return { ...p, settings }
}

/** The shared notes as a flat list of files (newest last-modified shown), not the folder tree. */
export interface NoteEntry {
  relPath: string
  isDir: boolean
  modified?: string
  children?: NoteEntry[]
}

export function notesListText(tree: NoteEntry[]): string {
  const files: string[] = []
  const walk = (list: NoteEntry[]): void => {
    for (const e of list) {
      if (e.isDir) walk(e.children ?? [])
      else files.push(`${e.relPath}${e.modified ? ` (${e.modified.slice(0, 10)})` : ''}`)
    }
  }
  walk(tree)
  return files.length ? `${files.join('\n')}\n\n${say(R.notesRead)}` : say(R.notesNone)
}

/** A note or handover to read: its path and revision (for a write's expectedRevision), then its text as it is (not inside a JSON string). */
export const noteText = (n: { path: string; content: string; revision?: string }): string => `${say(R.noteHead, { path: n.path, hasRevision: yn(n.revision), revision: n.revision ?? '' })}\n\n${n.content}`

/** A note written or appended to: how much, and its new revision. */
export function noteWrittenText(path: string, characters: number, append: boolean, revision?: string): string {
  return say(append ? R.noteAppended : R.noteWrote, { n: characters, path, hasRevision: yn(revision), revision: revision ?? '' })
}

/** A heading of a document read by section (#817, GET /v1/docs/outline). */
export interface DocHeadingRow {
  level: number
  text: string
  slug: string
  size: number
}

/** A size in characters, short: "840", "3.2k", "56k". */
const charsShort = (n: number): string => (n < 1000 ? String(n) : say(R.thousands, { n: n < 10_000 ? (n / 1000).toFixed(1) : String(Math.round(n / 1000)) }))

/** A heading's line: indented by its level, its marks, its text, its slug and its section's size. */
// agent-protocol: layout only (a heading's marks, text, slug and size, no words)
const headingLine = (h: DocHeadingRow): string => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} [${h.slug}] ${charsShort(h.size)}`

/**
 * A document's outline: its headings down to `depth` (all by default), at most MAX_ROWS, each with its slug (what
 * cw_read_section takes) and its section's size in characters, subsections included.
 */
export function docOutlineText(o: { path: string; size: number; headings: DocHeadingRow[] }, depth?: number): string {
  if (!o.headings.length) return say(R.outlineNone, { path: o.path, size: charsShort(o.size) })
  const within = depth ? o.headings.filter((h) => h.level <= depth) : o.headings
  const shown = within.slice(0, MAX_ROWS)
  const lines = [say(R.outlineHead, { path: o.path, n: o.headings.length, size: charsShort(o.size) }), ...shown.map(headingLine)]
  if (within.length > shown.length) lines.push(say(R.outlineMore, { n: within.length - shown.length, depth: Math.max(1, Math.max(...within.map((h) => h.level)) - 1) }))
  return `${lines.join('\n')}\n\n${say(R.outlineRead)}`
}

/**
 * A section of a document: where it is, then its text as it is. A long one (`partial`) is its own text and its
 * subsections' outline, to read one of them, or all of it with full=true.
 */
export function docSectionText(s: { path: string; heading?: DocHeadingRow; size?: number; content: string; subsections?: DocHeadingRow[]; partial?: boolean }): string {
  // No heading: the whole document (#818).
  const head = s.heading ? say(R.sectionHead, { path: s.path, slug: s.heading.slug, size: s.heading.size }) : say(R.docHead, { path: s.path, size: s.size ?? s.content.length })
  if (!s.partial) return `${head}\n\n${s.content}`
  return `${say(R.sectionLong, { head })}\n\n${s.content}\n\n${(s.subsections ?? []).map(headingLine).join('\n')}\n\n${say(R.sectionRead)}`
}

/** A card's attachment as GET /v1/tasks/:n/attachments/:name gives it (HI-1751): a page of its text, or its kind and path. */
export type AttachmentReply =
  | { name: string; file: string; size: number; kind: 'text'; offset: number; content: string; next?: number }
  | { name: string; file: string; size: number; kind: 'image' | 'pdf' | 'binary'; path: string }

/**
 * A card's attachment (HI-1751): a line saying which bytes of it this is and where the next page starts (the byte offset
 * to pass back as offset), then that text as it is; an image, a PDF or a binary file: its path, for the CLI's own reading.
 */
export function attachmentText(a: AttachmentReply): string {
  const bytes = (n: number): string => say(R.bytes, { n })
  if (a.kind !== 'text') return say(R.attachmentFile, { name: a.name, kind: a.kind, size: bytes(a.size), path: a.path })
  const to = a.next ?? a.size
  const where = a.offset === 0 && to === a.size ? bytes(a.size) : say(R.attachmentRange, { from: a.offset, to, size: bytes(a.size) })
  return `${say(R.attachmentText, { name: a.name, where, hasNext: yn(a.next !== undefined), next: a.next ?? '' })}\n\n${a.content}`
}

/** A skill in a listing (GET /v1/skills?view=short): where it comes from and what it is for, without its folder. */
export interface SkillRow {
  name: string
  description: string
  level: 'combwork' | 'machine' | 'plugin' | 'local'
  provider?: string
  plugin?: string
  audience?: 'agents' | 'assistant' | 'all'
  /** A Hive skill nobody gets (its header is broken or its audience unknown): why. */
  problem?: string
}

const SKILL_LEVEL: Record<SkillRow['level'], AgentMsg> = { combwork: R.levelHive, machine: R.levelMachine, plugin: R.levelPlugin, local: R.levelLocal }

/** "work-on-card (Hive, for agents): Carry a card…", a line per skill. */
export function skillListText(rows: SkillRow[]): string {
  if (!rows.length) return say(R.skillsNone)
  const line = (r: SkillRow): string => {
    const who = r.problem ? say(R.skillNobody, { problem: r.problem }) : r.audience ? say(R.skillFor, { audience: r.audience }) : ''
    const where = [SKILL_LEVEL[r.level] ? say(SKILL_LEVEL[r.level]) : '', r.provider, r.plugin, who].filter(Boolean).join(', ')
    return say(R.skillLine, { name: r.name, where, description: r.description || say(R.skillNoDescription) })
  }
  return rows.map(line).join('\n')
}

/** A card change as POST /v1/tasks/wait reports it (shared/watch.ts CardChange). */
export interface WaitChange {
  number: number
  column: string
  changes: string[] | 'gone'
  by: string | null
  comment: { by: string; firstLine: string } | null
  archived?: boolean
}

/**
 * cw_wait_for_tasks, as the model gets it: a watch begun (end the turn), a condition already met, the changes (each
 * card, where it is now, who changed it, the latest comment's author and first line), or no change; with `since` for the
 * next wait. Short: the full comment is cw_read_task with latestComment.
 */
type WaitReply = { done?: string; unsubmitted?: UnsubmittedCard[]; idle?: number; watching?: string; limitAt?: string; already?: WaitChange; usageAlready?: string[]; lanesAlready?: string[]; changes?: WaitChange[]; timedOut?: boolean; since?: string; events?: string[]; replaced?: string; cards?: LaneWatchCards; agents?: LaneWatchAgents; lanesLeft?: string[]; names?: Record<string, string> }

/**
 * HI-1987: a card or agent watch that replaces a lane watch while its lanes run says what it drops, and how to keep them
 * (the lane watch takes cards and agents beside its lanes).
 */
const lanesLeftText = (lanes: readonly string[] | undefined): string => (lanes?.length ? ` ${say(R.lanesLeft, { n: lanes.length, lanes: lanes.join(', ') })}` : '')
export function taskWaitText(r: WaitReply): string {
  return namedBy(namesFrom(r.names), () => waitText(r))
}
function waitText(r: WaitReply): string {
  if (r.done) return r.done
  // A lane watch (#531): what it counts, and the watch it replaced.
  // The events only when they aren't the default (lean: the agent asked for them, or knows the default).
  if (r.watching && r.events) {
    const own = r.events.length !== LANE_DEFAULT_EVENTS.length || r.events.some((e) => !LANE_DEFAULT_EVENTS.includes(e as LaneEvent))
    // The cards beside its lanes (#726): kept from the last lane watch, replacing its cards, or left (done or gone).
    const c = r.cards
    const list = (ns: number[]): string => ns.map((n) => `${cardRef(n)}`).join(', ')
    const cards = c
      ? `${c.kept && c.now.length ? ` ${say(R.waitKeptCards, { cards: list(c.now) })}` : ''}${c.replaced?.length ? ` ${say(c.now.length ? R.waitReplaceCards : R.waitNoLonger, { cards: list(c.replaced) })}` : ''}${c.dropped?.length ? ` ${say(R.waitDropped, { cards: list(c.dropped) })}` : ''}${c.inLanes?.length ? ` ${say(R.waitInLanes, { cards: list(c.inLanes), one: yn(c.inLanes.length === 1) })}` : ''}`
      : ''
    // Its agents beside the lanes (HI-1987): kept from the last lane watch, and those not followed for not working now.
    const a = r.agents
    const agents = a ? `${a.kept && a.now.length ? ` ${say(R.waitKeptAgents, { agents: a.now.join(', ') })}` : ''}${a.already?.length ? ` ${say(R.waitNotFollowed, { agents: a.already.join('; ') })}` : ''}` : ''
    const also = [...(c?.now.length ? [say(R.waitAlsoCards, { cards: list(c.now) })] : []), ...(a?.now.length ? [say(R.waitAlsoAgents, { agents: a.now.join(', ') })] : [])]
    const head = say(R.waitLane, { watching: r.watching, events: own ? ` (${r.events.join(', ')})` : '', hasAlso: yn(also.length), also: also.length ? joined(also, R.or) : '', limit: r.limitAt ?? say(R.theLimit) })
    return `${head}${r.replaced ? ` ${say(R.waitReplaced, { watch: lowerWaiting(r.replaced) })}` : ''}${cards}${agents}`
  }
  const line = (c: WaitChange): string => {
    const change = c.changes === 'gone' ? say(R.waitGone, { card: cardRef(c.number), archived: yn(c.archived) }) : say(R.waitMoved, { card: cardRef(c.number), column: `${c.column[0].toUpperCase()}${c.column.slice(1)}`, changes: c.changes.join(', '), hasBy: yn(c.by), by: c.by ?? '' })
    return c.comment ? say(R.waitComment, { change, by: c.comment.by, line: c.comment.firstLine }) : change
  }
  const limit = r.limitAt ?? say(R.theLimit)
  // HI-2245: the builder's own card in Review with commits past its submission: handed over first, then the turn ends.
  const first = unsubmittedText(r.unsubmitted, say(R.waitEndTurnLower, { limit }))
  // HI-2285: a lane's builder watching only its own card with nothing waiting on it: carry on rather than end the turn.
  if (r.watching && r.idle !== undefined && !first) return `${say(R.waitIdle, { watching: r.watching, idle: idleWatchText({ number: r.idle }), limit })}${lanesLeftText(r.lanesLeft)}`
  if (r.watching) return `${say(R.waitWatching, { watching: r.watching, step: first ?? say(R.waitEndTurn, { limit }) })}${lanesLeftText(r.lanesLeft)}`
  if (r.already) return `${say(R.already, { what: line(r.already) })}${r.unsubmitted?.length ? ` ${unsubmittedText(r.unsubmitted)}` : ''}${lanesLeftText(r.lanesLeft)}`
  // A usage watch whose account is there already (HI-2195): no watch started, the one before it ended.
  // A lane watch naming a lane that has ended (HI-2521): no watch started, the one before it ended.
  if (r.lanesAlready) return `${say(R.already, { what: r.lanesAlready.join('; ') })}${r.replaced ? ` ${say(R.waitEnded, { watch: lowerWaiting(r.replaced) })}` : ''}`
  if (r.usageAlready) return `${say(R.already, { what: r.usageAlready.join('; ') })}${r.replaced ? ` ${say(R.waitEnded, { watch: lowerWaiting(r.replaced) })}` : ''}${lanesLeftText(r.lanesLeft)}`
  const since = r.since ? `\n${say(R.since, { since: r.since })}` : ''
  if (r.timedOut || !r.changes?.length) return `${say(R.waitNoChange)}${since}`
  return `${r.changes.map(line).join('\n')}${since}`
}

/** A watch's own label (a value: "Waiting for HI-12 → Review") inside a sentence: its first word in lower case. */
// agent-protocol: the label's first word, made lower case to follow the sentence; the label itself is the watch's
const lowerWaiting = (label: string): string => label.replace(/^Waiting/, 'waiting')

/**
 * cw_wait_for_agents with wake or cancel (#416), as the model gets it: an agent watch begun (end the turn, and the card
 * watch it replaced), agents not working already (each and its state), or the cancel. The bounded wait replies as JSON.
 */
export function agentWatchText(r: { done?: string; watching?: string; limitAt?: string; replaced?: string; dropped?: string[]; already?: string[]; lanesLeft?: string[] }): string {
  if (r.done) return r.done
  const replaced = r.lanesLeft?.length ? lanesLeftText(r.lanesLeft) : r.replaced ? ` ${say(R.agentReplaced, { watch: lowerWaiting(r.replaced) })}` : ''
  // #1346 item 6: the agents your earlier agent watch followed and this call doesn't; an answer at once ends it too.
  const dropped = r.dropped?.length ? ` ${say(R.agentDropped, { agents: r.dropped.join(', ') })}` : ''
  if (r.already) return `${say(R.already, { what: r.already.join('; ') })}${r.lanesLeft?.length ? lanesLeftText(r.lanesLeft) : r.replaced ? ` ${say(R.agentCardEnded, { watch: lowerWaiting(r.replaced) })}` : ''}${r.dropped?.length ? ` ${say(R.agentDroppedEnded, { agents: r.dropped.join(', ') })}` : ''}`
  return `${say(R.agentWatching, { watching: String(r.watching), limit: r.limitAt ?? say(R.theLimit) })}${replaced}${dropped}`
}

/** A setting in a listing (GET /v1/settings): where it is, its value (and default when it differs), what it does. */
export interface SettingRow {
  id: string
  title: string
  /** As the tools show it: on/off, a number, inherit, (empty). */
  value: string
  /** Only when the value differs from it. */
  default?: string
  /** Its description's first sentence. */
  desc: string
  /** The Assistant can read it but not change it. */
  readOnly?: true
}

/**
 * cw_list_settings: one line a setting, read-only ones marked; what each does only when a query narrowed them (a
 * title is enough to choose from among them all); cw_read_setting has the rest. Those set to inherit (most of a
 * project's own, HI-1712) come last under one line saying so, each without its value.
 */
export function settingListText(rows: SettingRow[], opts: { query?: string; offset?: number } = {}): string {
  if (!rows.length) return opts.query ? say(R.settingNoMatch, { query: opts.query }) : say(R.settingsNone)
  const offset = Math.max(0, opts.offset ?? 0)
  const shown = rows.slice(offset, offset + MAX_ROWS)
  const name = (r: SettingRow): string => ` · ${r.title}${opts.query ? `: ${r.desc}` : ''}`
  const inherits = (r: SettingRow): boolean => r.value === 'inherit' && r.default === undefined && !r.readOnly
  const lines = shown.filter((r) => !inherits(r)).map((r) => `${say(R.settingRow, { id: r.id, value: r.value, hasDefault: yn(r.default !== undefined), def: r.default ?? '', readOnly: yn(r.readOnly) })}${name(r)}`)
  const inheriting = shown.filter(inherits)
  if (inheriting.length) lines.push(say(R.settingInherit), ...inheriting.map((r) => `${r.id}${name(r)}`))
  const more = rows.length - offset - shown.length
  if (more > 0) lines.push(say(R.settingMore, { n: more, next: offset + shown.length }))
  return lines.join('\n')
}

/** One setting in full (GET /v1/settings/{id}). */
export interface SettingDetail {
  id: string
  title: string
  /** "Settings → Sessions → Suggest compacting above". */
  path: string
  /** Where the user sees it, in the language Hive shows them, when that isn't English (#767). */
  shownAs?: string
  scope: string
  project?: string
  value: string
  default: string
  /** "1000 to 2000000, or 0 for Never", "one of: …", "on or off", "text". */
  takes: string
  desc: string
  tip?: string
  helps?: string
  restart?: string
  readOnly?: string
  docs: string
}

export function settingText(d: SettingDetail): string {
  return [
    say(R.settingHead, { title: d.title, id: d.id, hasProject: yn(d.project), project: d.project ?? '', value: d.value, isDefault: yn(d.value === d.default), def: d.default }),
    say(R.settingWhere, { path: d.path, takes: d.takes }),
    d.shownAs ? say(R.settingShownAs, { shownAs: d.shownAs }) : '',
    d.desc,
    d.tip && d.tip.trim() !== '' ? d.tip : '',
    d.helps ? say(R.settingHelps, { helps: d.helps }) : '',
    d.restart ? say(R.settingRestart, { restart: d.restart }) : '',
    d.readOnly ? say(R.settingReadOnly, { why: d.readOnly }) : '',
    say(R.settingDocs, { docs: d.docs })
  ]
    .filter(Boolean)
    .join('\n')
}

/** cw_update_setting's reply: what changed, old → new, and when it applies. */
export function settingChangedText(c: { title: string; id: string; path: string; project?: string; changed?: boolean; old: string; new: string; restart?: string }): string {
  if (c.changed === false || (c.changed === undefined && c.old === c.new)) return say(R.settingSame, { path: c.path, hasProject: yn(c.project), project: c.project ?? '', value: c.new })
  return say(R.settingChanged, { path: c.path, hasProject: yn(c.project), project: c.project ?? '', id: c.id, old: c.old, new: c.new, hasRestart: yn(c.restart), restart: c.restart ?? '' })
}

// The Assistant's journal (#1031): a recall is a line an entry; an entry in full on request.

/** A recalled entry (POST /v1/journal/recall). */
export interface JournalRow {
  id: number
  at: string
  kind: string
  project: string | null
  summary: string
  importance: number
  source: string
  supersededBy: number | null
  hasDetail: boolean
}

/** cw_journal_recall: "#12 2026-10-18 decision · hive: summary [important, detail]", newest or best first. */
export function journalRecallText(rows: JournalRow[], query?: string): string {
  if (!rows.length) return query ? say(R.journalNoMatch, { query }) : say(R.journalNone)
  return rows
    .map((r) => {
      const marks = [r.importance >= 3 ? say(R.markEssential) : r.importance === 2 ? say(R.markImportant) : '', r.source === 'combwork' ? say(R.markByHive) : '', r.hasDetail ? say(R.markDetail) : '', r.supersededBy ? say(R.markSuperseded, { id: r.supersededBy }) : ''].filter(Boolean)
      return `#${r.id} ${r.at.slice(0, 10)} ${r.kind}${r.project ? ` · ${r.project}` : ''}: ${r.summary}${marks.length ? ` [${marks.join(', ')}]` : ''}`
    })
    .join('\n')
}

/** An entry in full (GET /v1/journal/{id}). */
export interface JournalEntryDetail extends JournalRow {
  detail: string | null
  why: string | null
  digestOf: string | null
  updatedAt: string | null
  links: { type: string; ref: string }[]
  tags: string[]
  supersedes: number[]
}

export function journalEntryText(e: JournalEntryDetail): string {
  return [
    say(R.journalHead, { id: e.id, kind: e.kind, hasProject: yn(e.project), project: e.project ?? '', at: e.at, byHive: yn(e.source === 'combwork'), importance: e.importance, changed: yn(e.updatedAt), updatedAt: e.updatedAt ?? '' }),
    e.summary,
    e.why ? say(R.journalWhy, { why: e.why }) : '',
    e.detail ?? '',
    e.digestOf ? say(R.journalDigest, { of: e.digestOf }) : '',
    e.links.length ? say(R.journalLinks, { links: e.links.map((l) => `${l.type} ${l.ref}`).join(', ') }) : '',
    e.tags.length ? say(R.journalTags, { tags: e.tags.join(', ') }) : '',
    e.supersededBy ? say(R.journalSupersededBy, { id: e.supersededBy }) : '',
    e.supersedes.length ? say(R.journalSupersedes, { ids: e.supersedes.map((x) => `#${x}`).join(', ') }) : ''
  ]
    .filter(Boolean)
    .join('\n')
}

// The merge slot (#350): what an agent claiming, releasing or looking at it is told, in a line.

type SlotHolder = MergeSlotInfo['holder']
interface SlotLost {
  branch: string
  why: string
}
const lostText = (l: SlotLost | undefined): string => (l ? `${say(R.slotLost, { branch: l.branch, why: l.why })} ` : '')

/** A claim's reply: held (and how long is left), or its place in line and who holds the slot. */
export function claimText(r: { held: boolean; branch: string; until?: number; extended?: boolean; position?: number; holder?: SlotHolder; lost?: SlotLost }, now: number): string {
  const lost = lostText(r.lost)
  if (r.held) return `${lost}${say(R.slotHeld, { branch: r.branch, extended: yn(r.extended), left: minutes((r.until ?? now) - now) })}`
  if (!r.position) return `${lost}${say(R.slotNotInLine, { branch: r.branch })}`
  return `${lost}${say(R.slotWaiting, { branch: r.branch, position: ordinal(r.position), hasHolder: yn(r.holder), holder: r.holder ? holderText(r.holder) : '' })}`
}

/** A release's reply. */
export function releaseText(r: { branch: string; released?: boolean; next?: string | null; left?: boolean; none?: boolean; holder?: SlotHolder; yours?: { branch: string; held: boolean }[]; lost?: SlotLost }): string {
  const lost = lostText(r.lost)
  if (r.released) return `${lost}${say(R.slotReleased, { branch: r.branch, hasNext: yn(r.next), next: r.next ?? '' })}`
  if (r.left) return `${lost}${say(R.slotLeft, { branch: r.branch })}`
  // What it does hold or wait for (#586), so it can name that branch.
  const yours = r.yours?.length ? ` ${say(R.slotYours, { slots: r.yours.map((y) => say(R.slotHeldMark, { branch: y.branch, held: yn(y.held) })).join(', ') })}` : ` ${say(R.slotNoOther)}`
  return `${lost}${say(R.slotNotHeld, { branch: r.branch, holder: r.holder ? holderText(r.holder) : say(R.slotFree) })}${yours}`
}

/** A slot's status in a line: who holds it, for how long, and who waits. */
export function mergeSlotText(s: MergeSlotInfo, now: number): string {
  return say(R.slotStatus, { branch: s.branch, line: slotLine(s, now), hasWaiting: yn(s.waiting.length), waiting: s.waiting.map((w) => w.name).join(', ') })
}

/** A developer console source as GET /v1/console/sources and /v1/console/events give it (#636). */
export interface ConsoleSourceRow {
  /** For display only: cut and masked. */
  label: string
  kind: string
  /** How a read names it, exactly: { source } for Hive or the Assistant, { agent: <its id>, project: <its project's name> } for an agent. */
  select?: { source?: string; agent?: string; project?: string }
  provider?: string
  /** An open developer console is capturing it now. */
  capturing: boolean
  events: number
}

/** The arguments cw_console takes for a source, exactly as the listing gives them (JSON strings, so any name reads back). */
const consoleArgs = (r: ConsoleSourceRow): string =>
  Object.entries(r.select ?? {})
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ')

/** A page of the sources a caller can read (GET /v1/console/sources), a line each, and where the next page starts. */
export function consoleSourcesText(page: { total: number; offset: number; sources: ConsoleSourceRow[] }): string {
  if (!page.total) return say(R.consoleNone)
  const rows = page.sources.map((r) => say(R.consoleRow, { label: r.label, hasProvider: yn(r.provider), provider: r.provider ?? '', capturing: yn(r.capturing), events: r.events, args: consoleArgs(r) }))
  const end = page.offset + page.sources.length
  const more = end < page.total ? `\n${say(R.consoleMore, { from: page.offset + 1, to: end, total: page.total })}` : ''
  return `${rows.join('\n')}${more}`
}

/** An event in a read: a row, or in full (seq) with its raw payload and what Hive made of it. */
export interface ConsoleEventRow {
  seq: number
  at: string
  kind: string
  name: string
  summary: string
  truncated?: boolean
  raw?: unknown
  made?: unknown
}

/** What a read says when no open console captures the source: there is nothing to read, and why (said with `say()`). */
export const CONSOLE_NOT_CAPTURED = R.consoleNotCaptured

/** One read of a source (times in UTC): its rows, or the events asked for in full, and how to go on. */
export function consoleEventsText(r: { source: ConsoleSourceRow; events: ConsoleEventRow[]; older?: number; newer?: number; newest?: number; missing?: number[] }): string {
  const label = r.source.label
  if (r.missing) {
    const gone = r.missing.length ? `\n${say(R.consoleGone, { events: r.missing.map((n) => `#${n}`).join(', ') })}` : ''
    return `${label}:\n${r.events.map((e) => JSON.stringify(e)).join('\n')}${gone}`
  }
  if (!r.source.capturing) return `${label}: ${say(CONSOLE_NOT_CAPTURED)}`
  if (!r.events.length) return say(R.consoleNoEvents, { label, hasNewest: yn(r.newest), newest: r.newest ?? '' })
  const rows = r.events.map((e) => `#${e.seq} ${e.at.slice(11, 19)} ${e.kind} ${e.summary}${e.truncated ? ` ${say(R.consoleCut)}` : ''}`)
  const more = r.newer ? `\n${say(R.consoleNewer, { n: r.newer })}` : r.older ? `\n${say(R.consoleOlder, { n: r.older })}` : ''
  // agent-protocol: layout only (values, punctuation and line breaks, no words)
  return `${label}:\n${rows.join('\n')}${more}\n${say(R.consoleNext, { newest: String(r.newest) })}`
}

/** How many of a queue's waiting entries and outcomes its line names (the rest counted). */
const QUEUE_SHOWN = 5
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/**
 * A target's merge queue (#1353, cw_queue list) in a few lines: paused or running and by whom, the entry testing
 * and its step, the entries waiting in order, the latest outcomes (newest first).
 */
export function queueText(q: QueuePublic): string {
  const rev = (r: string | null | undefined): string => (r ? r.slice(0, 7) : '?')
  const state = q.paused
    ? say(R.queuePaused, { reason: q.paused.reason, by: !q.paused.by ? 'none' : q.paused.by === 'user' ? 'user' : 'assistant', hasCard: yn(q.paused.card), card: q.paused.card ?? '', hasFiles: yn(q.paused.files.length), files: q.paused.files.slice(0, QUEUE_SHOWN).join(', ') })
    : q.runBy && !q.runHere
      ? say(R.queueRunBy, { by: q.runBy })
      : say(q.testing || q.queued.length ? R.queueRunning : R.queueEmpty)
  const lines = [say(R.queueHead, { target: q.target, project: q.project, state })]
  const st = q.paused?.stuck
  if (st) {
    // An advance into the checked-out target left part way (#1351): where it stands, and how to settle it.
    const files = st.files.slice(0, QUEUE_SHOWN).map((f) => `${f.path} (${f.side})`).join(', ')
    const how = st.commands.map((c) => say(R.queueHow, { purpose: c.purpose, place: c.place === 'project' ? 'project' : 'target', command: c.command })).join('; ')
    const stuck = say(R.queueStuck, { phase: st.phase, hasBranch: yn(st.branch), branch: st.branch ?? '', target: q.target, ref: rev(st.ref), expected: rev(st.expected), result: rev(st.result), hasFiles: yn(files), files: st.files.length > QUEUE_SHOWN ? say(R.queueFilesMore, { files, n: st.files.length - QUEUE_SHOWN }) : files })
    lines.push(`${stuck}${how ? ` ${how.charAt(0).toUpperCase()}${how.slice(1)}.` : ''}`)
  }
  if (q.testing) lines.push(say(R.queueTesting, { key: q.testing.key, title: clip(q.testing.title, 60), revision: rev(q.testing.revision), hasStep: yn(q.testing.step), step: q.testing.step ?? '' }))
  if (q.queued.length) {
    const more = q.queued.length - QUEUE_SHOWN
    lines.push(say(R.queueQueued, { entries: q.queued.slice(0, QUEUE_SHOWN).map((e) => `${e.key} ${clip(e.title, 40)}`).join('; '), hasMore: yn(more > 0), more }))
  }
  if (q.recent.length) {
    const said = q.recent.slice(0, QUEUE_SHOWN).map((r) => {
      if (r.outcome === 'merged') return say(R.queueMerged, { key: r.key, result: rev(r.result), outside: yn(r.by === 'outside') })
      if (r.outcome === 'returned') return say(R.queueReturned, { key: r.key, reason: String(r.reason), transient: yn(r.transient), hasFiles: yn(r.files?.length), files: (r.files ?? []).slice(0, 3).join(', ') })
      return say(R.queueCancelled, { key: r.key, reason: String(r.reason) })
    })
    lines.push(say(R.queueRecent, { outcomes: said.join('; ') }))
  }
  return lines.join('\n')
}

/** Several targets' queues (cw_queue list), or why there are none. */
export function queuesText(qs: QueuePublic[], project: string): string {
  if (!qs.length) return say(R.queuesNone, { project })
  return qs.map(queueText).join('\n')
}

/** What Resume did: resumed, or still paused (its cause still there), with the queue as it is now. */
export function queueResumedText(r: { resumed: boolean; queue: QueuePublic }): string {
  return r.resumed ? queueText(r.queue) : say(R.queueStillPaused, { queue: queueText(r.queue) })
}

/** The team's pause as the Agent API gives it to the Assistant (HI-2081, GET /v1/team): its workspace's, other ones in a line. */
export interface TeamPublic {
  paused: boolean
  pausedBy: string | null
  since: string | null
  parked: boolean
  safeToInstall: boolean
  running: { project: string; agent: string; state: string; what: string }[]
  others: string[]
}

/** cw_team: paused or not, parked or not, safe to install or not, then what still runs, a short row each. */
export function teamText(t: TeamPublic): string {
  const by = t.pausedBy ?? say(R.theUser)
  const head = !t.paused ? say(R.teamNotPaused) : t.parked ? say(R.teamParked, { by }) : say(R.teamPaused, { by, n: t.running.length })
  const install = t.paused ? ` ${say(R.teamSafe, { safe: yn(t.safeToInstall) })}` : ''
  const rows = t.running.slice(0, MAX_ROWS).map((r) => `- ${r.project ? `${r.project}/` : ''}${r.agent || say(R.teamHive)}: ${r.what}${r.state === 'unknown' ? ` ${say(R.teamUnchecked)}` : ''}`)
  const more = t.running.length > MAX_ROWS ? [say(R.teamMore, { n: t.running.length - MAX_ROWS })] : []
  return [head + install, ...rows, ...more, ...t.others].join('\n')
}

/** A project's slots to release as the Agent API lists them (#1561, GET /v1/projects/{name}/slots/releasable). */
export interface ReleasablePublic {
  project: string
  carried: { slot: string; agent: string }[]
  held: { slot: string; agent: string; run: string; hive: string; processes: { list: { pid: number; label: string }[]; more: number } | null }[]
}

/** How many processes a held writer's line names (the rest counted). */
const PROCESSES_SHOWN = 5

/**
 * cw_release_slot list (#1561): a line per carried slot and per held writer, each with what release needs (a writer's
 * confirm, and its processes, which end: true ends first), or that there is none.
 */
export function releasableText(r: ReleasablePublic): string {
  if (!r.carried.length && !r.held.length) return say(R.releaseNone, { project: r.project })
  const lines = r.carried.map((c) => say(R.releaseCarried, { slot: c.slot, agent: c.agent }))
  for (const h of r.held) {
    const more = h.processes ? h.processes.list.length + h.processes.more - PROCESSES_SHOWN : 0
    const listed = h.processes ? h.processes.list.slice(0, PROCESSES_SHOWN).map((p) => `${clip(p.label, 40)} (${p.pid})`).join(', ') : ''
    const procs = h.processes?.list.length ? ` ${say(R.releaseProcs, { processes: more > 0 ? say(R.queueFilesMore, { files: listed, n: more }) : listed })}` : ` ${say(R.releaseUnknown)}`
    lines.push(`${say(R.releaseHeld, { slot: h.slot, agent: h.agent, run: h.run, hive: h.hive })}${procs}`)
  }
  return lines.join('\n')
}

/** cw_release_slot release (#1561): what was released. */
export function slotReleasedText(r: { project: string; kind: 'carried' | 'writer'; slot: string; agent: string; ended?: boolean }): string {
  return r.kind === 'carried' ? say(R.releasedCarried, { slot: r.slot, project: r.project, agent: r.agent }) : say(R.releasedWriter, { slot: r.slot, project: r.project, agent: r.agent, ended: yn(r.ended) })
}

/** A template as the Agent API lists it (HI-1502, GET /v1/projects/{name}/templates). */
export interface TemplateRowPublic {
  scope: string
  from?: string
  file: string
  name: string
  agents: number
  workflow: string[]
  problem?: string
}

/** A connection as the Agent API gives it (HI-2108): the setup agents choose, on an account. */
export interface ConnectionPublic {
  id: string
  name: string
  account: string
  cli: string | null
  model?: string
  effort?: string
  context200k?: boolean
  mode?: string
  extraArgs?: string
  tag?: string
  usable?: false
}

/** A connection's values, short: "opus · high · 200K · plan", or "the CLI's defaults". */
const connectionValuesText = (c: ConnectionPublic): string => [c.model, c.effort, c.context200k ? say(R.context200k) : '', c.mode, c.extraArgs ? say(R.connectionArgs, { args: c.extraArgs }) : '', c.tag ? say(R.connectionTag, { tag: c.tag }) : ''].filter(Boolean).join(' · ') || say(R.cliDefaults)

/**
 * cw_connection list (HI-2108): one row per connection, by account, those not usable here marked; then the accounts with
 * none; then each account's plan usage and usage move (HI-2195).
 */
export function connectionListText(r: { connections: ConnectionPublic[]; accounts: { id: string; name: string; cli: string; on?: boolean }[]; usage?: AccountUsagePublic[] }): string {
  const rows = r.connections.map((c) => say(R.connectionRow, { name: c.name, id: c.id, account: c.account, cli: c.cli ?? say(R.unknownCli), values: connectionValuesText(c), unusable: yn(c.usable === false) }))
  const bare = r.accounts.filter((a) => !r.connections.some((c) => c.account === a.name)).map((a) => say(R.accountBare, { name: a.name, id: a.id, cli: a.cli, off: yn(a.on === false) }))
  return [...rows, ...bare, ...(r.usage ?? []).map(accountUsageText)].join('\n') || say(R.connectionsNone)
}

/** An account's plan usage and usage move (HI-2195), as GET /v1/connections gives them. */
export interface AccountUsagePublic {
  account: string
  limits: { label: string; usedPercent: number; resetsAt: string | null }[]
  move?: { percent: number; limit: 'weekly' | 'fiveHour' | 'any'; to: string }
}

/** cw_connection list's line for an account's usage (HI-2195): each limit's share and reset (UTC), and its usage move. */
export function accountUsageText(u: AccountUsagePublic): string {
  const limits = u.limits.map((l) => say(R.usageLimit, { label: l.label, percent: l.usedPercent, hasReset: yn(l.resetsAt), at: l.resetsAt ? new Date(l.resetsAt).toISOString().slice(0, 16) : '' })).join(', ')
  const move = u.move ? say(R.usageMove, { to: u.move.to, percent: u.move.percent, limit: u.move.limit }) : ''
  return say(R.usage, { account: u.account, usage: [limits || say(R.usageNoFigures), move].filter(Boolean).join('; ') })
}

/** cw_connection add or update (HI-2108): what it is now. `verb` chooses the wording (an id, not text). */
export function connectionChangedText(verb: 'Made' | 'Changed', c: ConnectionPublic): string {
  return say(R.connectionChanged, { verb, name: c.name, id: c.id, account: c.account, values: connectionValuesText(c) })
}

/** cw_template list (HI-1502): a line per template, with what load needs to name it (scope and file, from). */
export function templateListText(r: { project: string; templates: TemplateRowPublic[] }): string {
  if (!r.templates.length) return say(R.templatesNone, { project: r.project })
  return r.templates
    .map((t) => say(R.templateRow, { name: t.name, scope: t.scope, hasFrom: yn(t.from), from: t.from ?? '', file: t.file, agents: t.agents, hasWorkflow: yn(t.workflow.length), workflow: t.workflow.length ? joined(t.workflow, R.and) : '', hasProblem: yn(t.problem), problem: t.problem ?? '' }))
    .join('\n')
}

/** A template's workflow as a plan or a load reports it (HI-1502). */
interface TemplateWorkflowPublic {
  platform: string
  applies: boolean
  needsGit: boolean
  dropped: string[]
  changes: { key: string; now: unknown; next: unknown }[]
  missingCommands: string[]
  identityOff: boolean
  problems: string[]
  saved?: boolean
  notSaved?: string
}

/** A plan as the Agent API reports it (HI-1502, POST /v1/projects/{name}/templates/plan). */
export interface TemplatePlanPublic {
  project: string
  template: { scope: string; file: string; name: string }
  remove: string[]
  create: { name: string; template: string; role: string; connection: string | null; pairedWith?: string }[]
  taken: { name: string; project: string; suggestion: string }[]
  options: { id: string; name: string; cli: string; account: string }[]
  blocked: string[]
  workflow: TemplateWorkflowPublic | null
}

/** A load as the Agent API reports it (HI-1502, POST /v1/projects/{name}/templates/load). */
export interface TemplateLoadPublic {
  project: string
  template: { scope: string; file: string; name: string }
  removed: string[]
  created: string[]
  renamed: { template: string; name: string }[]
  connections: { name: string; connection: string }[]
  workflow: TemplateWorkflowPublic | null
}

/** Choose Connections as the Agent API reports it (HI-2109, POST /v1/projects/{name}/templates/apply). */
export interface ConnectionsAppliedPublic {
  project: string
  changed: { name: string; connection: string }[]
  restart: string[]
  skipped: { name: string; why: string }[]
}

const shownValue = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? null))

/** A workflow's part of a plan's or a load's reply: what it changes, checks with no command, the identity left off. */
function templateWorkflowText(w: TemplateWorkflowPublic | null, will: boolean): string {
  if (!w) return ''
  if (!w.applies) return w.needsGit ? ` ${say(R.wfGitOnly)}` : w.dropped.length ? ` ${say(R.wfDropped, { platforms: w.dropped.join(', ') })}` : ''
  const changes = w.changes.length ? say(R.wfChanges, { n: w.changes.length, will: yn(will), changes: w.changes.map((c) => `${c.key}: ${shownValue(c.now)} → ${shownValue(c.next)}`).join('; ') }) : say(R.wfNoChanges)
  const head = will ? say(R.wfPlan, { platform: w.platform, changes }) : w.saved ? say(R.wfSaved, { platform: w.platform, changes }) : say(R.wfNotSaved, { why: w.notSaved ?? say(R.wfNone) })
  return ` ${say(R.wfLine, { head, hasMissing: yn(w.missingCommands.length), commands: w.missingCommands.join(', '), identityOff: yn(w.identityOff), keep: yn(w.saved || will) })}`
}

/** cw_template plan (HI-1502): what loading would do, what stops it, names taken (with free ones) and its workflow. */
export function templatePlanText(r: TemplatePlanPublic): string {
  const made = r.create.map((a) => say(R.planAgent, { name: a.name, renamed: yn(a.name !== a.template), template: a.template, role: a.role, paired: yn(a.pairedWith), pairedWith: a.pairedWith ?? '', connection: a.connection ?? say(R.noConnection) })).join(', ')
  const head = say(R.planHead, { name: r.template.name, project: r.project, remove: r.remove.length ? r.remove.join(', ') : say(R.noAgents), create: made })
  const taken = r.taken.length ? ` ${say(R.planTaken, { names: r.taken.map((t) => say(R.planTakenOne, { name: t.name, project: t.project, suggestion: t.suggestion })).join('; ') })}` : ''
  const options = r.options.length ? ` ${say(R.planOptions, { connections: r.options.map((o) => `${o.name} (${o.cli}, ${o.id})`).join(', ') })}` : ''
  const blocked = r.blocked.length ? ` ${say(R.planBlocked, { why: r.blocked.join(' ') })}` : ''
  return `${head}${taken}${options}${templateWorkflowText(r.workflow, true)}${blocked}`
}

/** cw_template load (HI-1502): what was loaded, names given, and its workflow saved or why not. */
export function templateLoadedText(r: TemplateLoadPublic): string {
  const renamed = r.renamed.length ? ` (${r.renamed.map((x) => say(R.loadRenamed, { template: x.template, name: x.name })).join(', ')})` : ''
  const conn = r.connections.length ? ` ${say(R.loadOn, { connections: r.connections.map((c) => `${c.name} ${c.connection}`).join(', ') })}` : ''
  return say(R.loaded, { name: r.template.name, project: r.project, removed: r.removed.length ? r.removed.join(', ') : say(R.noAgents), created: r.created.join(', '), renamed, on: conn, workflow: templateWorkflowText(r.workflow, false) })
}

/** cw_template apply (HI-2109): who got which connection, who to restart for it, who was skipped and why. */
export function connectionsAppliedText(r: ConnectionsAppliedPublic): string {
  const changed = r.changed.length ? `${r.changed.map((c) => `${c.name} → ${c.connection}`).join(', ')}` : say(R.appliedNone)
  const restart = r.restart.length ? ` ${say(R.appliedRestart, { agents: r.restart.join(', ') })}` : ''
  const skipped = r.skipped.length ? ` ${say(R.appliedSkipped, { agents: r.skipped.map((s) => `${s.name} (${s.why})`).join('; ') })}` : ''
  return say(R.applied, { project: r.project, changed, restart, skipped, undo: yn(r.changed.length) })
}

/** How Hive tells an agent of what waits for it, by the carrying-on switch that does it (#1432, shared/inboxSwitches.ts). */
const TELLS: Record<InboxSwitch, AgentMsg> = { checkpoints: R.tellsCheckpoints, stopContinuation: R.tellsStop, idleWakes: R.tellsIdle }

/**
 * cw_message_agent's reply for a message queued (#1497): how Hive tells the agent of it, only by the switches on for it
 * (`tells`, in INBOX_SWITCHES' order), or, with none, that it waits in its inbox.
 */
export function messageQueuedText(r: { who: string; id: string; tied: string; status: string; queued: number; tells: readonly InboxSwitch[] }): string {
  const ways = INBOX_SWITCHES.filter((s) => r.tells.includes(s)).map((s) => say(TELLS[s]))
  const how = ways.length ? say(R.tells, { ways: ways.length > 1 ? say(R.or, { a: ways.slice(0, -1).join(', '), b: ways.at(-1) ?? '' }) : ways[0] }) : say(R.inboxWaits)
  return say(R.queued, { who: r.who, id: r.id, tied: r.tied, status: r.status, how, queued: r.queued })
}
