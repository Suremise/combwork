import { randomBytes } from 'crypto'
import { join } from 'path'
import { refusalBody, type Refusal } from '../shared/workflow/refusals'
import { projectPreferences } from './workflow/preferences'
import { existsSync } from 'original-fs'
import { CW_DIR, projectAgents } from '../shared/defaults'
import { agentWorkflowRole, buildsWork, inWorkflow, reviewsWork } from '../shared/workflow/roles'
import { allDone, isFrozen, keptLanes, laneName, laneView, listedLanes, nextBrief, ownOpen, readLanes, running, stampWait, type LaneAgent, type FreshStart, type LaneCardFacts, type LaneChange, type LaneRecord, type LaneSlotHeld, type LaneStartWait, type WaitStamp } from '../shared/lanes'
import type { CombworkErrorKind, DueDeps, LaneCard, LaneInfo, LaneSlotInfo, TaskCard } from '../shared/types'
import { columnSince } from '../shared/tasks'
import { designReviewer, reviewingNow } from '../shared/workflow/reviewerPool'
import { withValues, type Text } from '../shared/advanced'
import { fmt, msg } from '../shared/i18n'
import { agentMsg, inDefaultDialect, inDialectOf, say } from '../shared/agentText'
import { CombworkError, saidError } from './combworkError'
import { onCombworkEvent } from './events'
import { readFile } from 'original-fs/promises'
import { placeKey, renameRetrying, withFileLock } from './fsutil'
import { openTable, readTable, saveTable, saveTableInBoard } from './storeTables'
import { boardOpen, boardRead, boardWrite, cardOwnersNow, cardPlacesNow, dbGeneration, onDbReplaced, upgradeWaiting } from './boardStore'
import { FactStore } from './workflow/factStore'
import { branchExists, pickTarget, projectTargets, type ProjectTargets } from './workflow/targets'
import { targetedOf, targetOfRulesetId } from '../shared/workflow/compile'
import { onAction } from './workflow/actionWorker'
import { foldCard, forYou, SLOT_DIRTY_GATE } from '../shared/workflow/facts'
import { createDelivery, offerNow } from './deliveries'
import { isProjectId, projectIdNamed, projectNameOf, projectNow, savedProjectName } from '../shared/projectIds'
import { coalesced } from './coalesce'
import { createLogger, userText } from './logger'
import { cardsNow, inScope } from './tasks'
import { journalFact } from './journalService'
import { openWorkspaces, type WorkspaceService } from './workspace'
import { cardRef } from '../shared/projectKeys'
import { withCardNames } from './projectKeys'
import { factHeadsOf, roundLimitCards, rulesetStages } from './workflow/cardWork'
import { rulesEnforced } from './workflow/recorder'
import { rulesetsNow } from './workflow/rulesets'
import { laneValues, noteLaneIn, sameValue, type FieldChange } from './assistantChanges'
import type { workspaceDb } from './boardStore'
import { lineWaiting, onLineWaitChanged } from './workflow/lineUpdates'
import { hooksMissingFor, onHooksHealthChanged } from './hooksHealth'
import { teamPauseOf } from './teamPause'
import { independentIn } from './independent'
import { admitOrThrow, projectIdOf } from './platform/fenceAdmit'
import { platformIdOf } from './platform/registry'

const log = createLogger('lanes')

/**
 * Lanes (#483): the card loops a workspace runs, kept in its `.combwork/lanes.json` beside the board. The builder's card-loop
 * registers its lane (start), the reviewer's joins it by the builder's name, the Assistant can start one when it briefs
 * a pair. Combwork follows the board for the rest: a lane is paused while its current card is blocked, ends when every card
 * is Done (or its builder ends it after the merge), and is abandoned when its builder or reviewer is removed.
 *
 * Bookkeeping, never a gate: nothing here refuses or holds up work on a card, and a loop with no lane runs as before.
 * Changes to a workspace's lanes happen under their lock, read and written whole. They are kept in the workspace database
 * (#1212: a row a lane in its typed tables, storeTables.ts), moved in from `.combwork/lanes.json` the first time.
 */

/** The lanes' file before #1018 (moved in at the first open, then kept as a backup); its path is also the lanes' lock. */
const fileOf = (ws: WorkspaceService): string => join(ws.combworkDir, 'lanes.json')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const KINDS: Record<number, CombworkErrorKind> = { 400: 'invalid', 403: 'forbidden', 404: 'notFound', 409: 'conflict' }

/**
 * A lane change Combwork refuses (status: the HTTP status the Agent API answers with). Most come only from agents (cw_lane),
 * in English; one the window can meet too (Progress → Lanes: ending a lane) is text, in its language there (#850).
 */
export class LaneError extends CombworkError {
  constructor(
    readonly status: number,
    message: string | Text
  ) {
    // An agent's refusal, English only: its words as they are, in every language.
    super(typeof message === 'string' ? { lines: [message] } : message, KINDS[status] ? { kind: KINDS[status] } : undefined)
  }
}

/** Refusals the window can meet (ending a lane from Progress → Lanes), in its language. */
const M = {
  noWorkspace: msg({ id: 'service.lanes.noWorkspace', defaultMessage: 'No workspace is open', description: "An error changing a workspace's lanes (card loops) while no workspace is open in the window." }),
  unknown: msg({ id: 'service.lanes.unknown', defaultMessage: 'Unknown lane {id}', description: 'An error: there is no lane (a card loop) with the id {id}, perhaps removed meanwhile.' }),
  targetNotListed: msg({ id: 'service.lanes.targetNotListed', defaultMessage: '{hasTargets, select, yes {{target} isn’t a branch work can merge into here: name {default}{hasOthers, select, yes { or one of {others}} other {}}, or add it under Other branches work can merge into (Version Control → Workflow).} other {This project merges work into no branch Combwork can pick: a lane’s Merges into is for Git projects.}}', description: 'HI-2556: an error starting a lane (a card loop) whose Merges into is a branch the project doesn’t list. {target} is the branch named, {default} the project’s Work merges into, {others} the others listed (a list). Other branches work can merge into and Version Control → Workflow are names in the window: as translated there. Keep the select keys.' }),
  targetMissing: msg({ id: 'service.lanes.targetMissing', defaultMessage: '{unknown, select, yes {Combwork can’t tell whether the branch {target} exists, so the lane wasn’t started.} other {There is no branch {target} in this repository: make it first, then start the lane on it.}}', description: 'HI-2556: an error starting a lane (a card loop) on a branch the project lists under Other branches work can merge into but which doesn’t exist (yet) in the repository. {target} is the branch name. unknown yes: git couldn’t say. Keep the select keys.' }),
  targetFixed: msg({ id: 'service.lanes.targetFixed', defaultMessage: '{builder}’s lane merges into {target} until it ends: start a new lane for another branch. Once {target} has been merged into another branch, a retarget of Work merges into moves the lane and its card there (Also retarget what can move).', description: 'HI-2556, HI-2753: an error changing a running lane’s Merges into (fixed for its life, except through a retarget once its branch has been merged into another). {builder} is the lane’s builder agent, {target} its branch. Work merges into and Also retarget what can move are names in the window (Version Control → Workflow, Save…): as translated there.' }),
  targetCard: msg({ id: 'service.lanes.targetCard', defaultMessage: '{card} merges into {cardTarget}, and this lane into {target}: a lane’s cards merge where it does. Leave it out, or start it in a lane of its own.', description: 'HI-2556: an error putting a card whose own Merges into is another branch than the lane’s into that lane. {card} is the card’s key (HI-12); {cardTarget} and {target} are branch names.' }),
  targetBuilder: msg({ id: 'service.lanes.targetBuilder', defaultMessage: 'A lane’s Merges into is set by the user or the Assistant, not its builder.', description: 'HI-2556: an error, a lane’s own builder agent named the branch its lane merges into; only the user or the Combwork Assistant (or a script) sets it.' }),
  targetRulesOff: msg({ id: 'service.lanes.targetRulesOff', defaultMessage: 'A lane merges into another branch only while workflow rules are enforced (Settings → Advanced).', description: 'HI-2556: an error starting a lane with a Merges into other than the project’s while the switch “Workflow rules are enforced” (Settings → Advanced) is off.' }),
  teamPaused: msg({ id: 'service.lanes.teamPaused', defaultMessage: 'The team is paused (before an update): resume the team first, then start the lane.', description: "An error starting a lane (a card loop) while the user or the Combwork Assistant has paused the whole team before an update (HI-2081): nothing of a lane starts until the team resumes (Resume the Team, in the Progress panel's Lanes)." })
}

/**
 * What lanes say to agents (dialects, HI-2435): cw_lane's refusals and replies, the lines Combwork delivers to a lane's
 * builder, and the journal's lane facts. Said where they are sent: a refusal in the request's scope, a delivery in its
 * builder's (inDialectOf), and what is stored for any reader (a journal fact, a fact's reason) in the Default.
 * `{card}` is a card's key or number, `{builder}`/`{reviewer}`/`{agent}` an agent's name.
 */
const A = {
  readFailed: agentMsg({ id: 'lane.store.readFailed', text: 'Could not read the lanes ({error})', note: "The workspace's lanes.json from before #1018 couldn't be read to move it in (Windows holding it, no permission); {error} is the system's error. The next open tries again." }),
  damaged: agentMsg({ id: 'lane.store.damaged', text: "The lanes file is damaged and couldn't be set aside ({error}): it was left as it is", note: "lanes.json from before #1018 isn't JSON lanes and couldn't be renamed aside; {error} is the system's error." }),
  listChanged: agentMsg({ id: 'lane.tell.listChanged', text: "Your lane's card list changed, as queued: its cards are now {cards}. cw_lane next names your next card.", note: "Delivered to a lane's builder once a queued change of its card list applies (#1270); {cards} is the list, in order." }),
  reordered: agentMsg({ id: 'lane.tell.reordered', text: 'Your lane was reordered now by {by}: {card} is back in Todo (its work stays on {line}): stop working on it. Its cards are now {cards}. cw_lane next names your next card.', note: "Delivered to a lane's builder after a reorder applied now (HI-1995) put its card in flight back; {by} is who reordered it, {line} its branch (or lane.reorder.itsBranch)." }),
  itsBranch: agentMsg({ id: 'lane.reorder.itsBranch', text: 'its branch', note: "In place of {line}: where a put-back card's work stays, when its branch's name isn't known." }),
  putBackWhy: agentMsg({ id: 'lane.reorder.putBackWhy', text: 'Put back by a lane reorder applied now ({by})', note: "The reason recorded on a card put back by a reorder applied now (HI-1995), stored on the card's facts; {by} is who reordered." }),
  independent: agentMsg({ id: 'lane.refused.independent', text: "{agent} is Independent: it takes no part in the workflow (its own role, or its connection launches it without Combwork's tools), so it is never a lane's builder or reviewer. Choose a builder, a reviewer or an either-role agent.", note: "cw_lane's refusal (HI-2670): an Independent agent is never a lane's builder or reviewer." }),
  wrongSide: agentMsg({ id: 'lane.refused.wrongSide', text: "{agent} is a {part, select, builder {reviewer} other {builder}} by its role, so it has no {part}'s tools: a lane's {part} is a {part} or an either-role agent. Choose another, or change {agent}'s role first.", note: "cw_lane's refusal (HI-2664): an agent's Combwork tools follow its workflow role, so a lane part only for a role that does it. {part} is builder or reviewer." }),
  oldTools: agentMsg({ id: 'lane.refused.oldTools', text: "{agent}'s role changed while it was running, and it still has its old role's tools: it can't take this part of the lane until it restarts. Restart it first (its pane says it needs a restart), then try again.", note: "cw_lane's refusal (HI-2664): an agent keeps the tools it launched with until it restarts, so a lane part needing its new role's tools waits for that." }),
  generalist: agentMsg({ id: 'lane.refused.generalist', text: "{agent} is a generalist: it takes no side in the workflow, so it is never a lane's builder or reviewer. Choose a builder, a reviewer or an either-role agent.", note: "cw_lane's refusal (HI-686): a generalist agent is never a lane's builder or reviewer." }),
  sharedItem: agentMsg({ id: 'lane.warn.sharedItem', text: "{card} is also in {builder}'s lane ({lane})", note: "One card of a start's list another builder's running lane lists too (HI-1821); {lane} is that lane's id. Joined with \"; \" into lane.warn.shared's {items}." }),
  shared: agentMsg({ id: 'lane.warn.shared', text: "Warning: {items}. A card belongs to one lane: ask the Assistant or the user to take it out of one of them (a builder's own cw_lane start never takes a card off its lane).", note: "cw_lane start's warning (HI-1821, HI-2169): cards on two lanes; {items} are lane.warn.sharedItem's." }),
  freshItem: agentMsg({ id: 'lane.warn.freshItem', text: '{card} was created {ago} s ago by {who}', note: 'One card of a start\'s list made by someone else since the caller\'s turn began (HI-2167); {ago} in seconds. Joined with "; " into lane.warn.fresh\'s {items}.' }),
  fresh: agentMsg({ id: 'lane.warn.fresh', text: "Warning: {items}: is it the card you meant? To put a new card on a lane, create it with cw_create_task's lane, never by its guessed key.", note: "cw_lane start's safety net (HI-2167): a card in its list may be a guessed key; {items} are lane.warn.freshItem's." }),
  inReview: agentMsg({ id: 'lane.refused.applyNow.inReview', text: '{card} is in {where, select, review {Review} other {Approved or merging}}: putting it back would lose its review or merge. Change the order without applyNow (it applies once {card} is Done), or wait.', note: "A reorder applied now (HI-1995) refused: the builder's card in flight is in Review (where review) or Approved or merging." }),
  inATurn: agentMsg({ id: 'lane.refused.applyNow.inATurn', text: '{agent} {status, select, working {is working} starting {is starting} waiting {is waiting for the user} other {has background tasks running}}: a reorder applied now never puts its card back under it. Ask it to finish and end its turn, then reorder again.', note: 'A reorder applied now (HI-1995) refused: the builder is in a turn of its own ({status}: working, starting, waiting for the user, or background tasks running).' }),
  uncommitted: agentMsg({ id: 'lane.refused.applyNow.uncommitted', text: "{card}'s folder has changes that aren't committed: commit them first (or ask {agent} to), then reorder again, so its work stays on its branch.", note: "A reorder applied now (HI-1995) refused: the card in flight's folder has uncommitted changes." }),
  notPutBack: agentMsg({ id: 'lane.refused.applyNow.notPutBack', text: "{card} couldn't be put back", note: "A reorder applied now (HI-1995) refused: putting the card in flight back was refused, with no reason given." }),
  carriedBrief: agentMsg({ id: 'lane.start.carried', text: "{builder}'s lane {lane} had just ended (all merged): started a new lane with its {what, select, brief {brief} name {name} other {brief and name}}; pass brief to change it.", note: "cw_lane start's note (HI-2097, HI-2104): a list change raced its lane's end, so a new lane started with the ended one's brief, name, or both ({what})." }),
  reviewerIs: agentMsg({ id: 'lane.refused.unknownReviewer.has', text: "No agent \"{name}\" in {project}; this lane's reviewer is {reviewer}: leave reviewer out to keep it.", note: "cw_lane start refused (HI-2273): it names a reviewer that is no agent of the project, and the builder's running lane has its reviewer." }),
  reviewerPool: agentMsg({ id: 'lane.refused.unknownReviewer.pool', text: "No agent \"{name}\" in {project}; this lane is reviewed by the project's reviewer pool: leave reviewer out.", note: "cw_lane start refused (HI-2273): it names a reviewer that is no agent of the project, and the lane is reviewed by the pool." }),
  reviewerNone: agentMsg({ id: 'lane.refused.unknownReviewer.none', text: 'No agent "{name}" in {project}; this lane has no reviewer yet: leave reviewer out, or name an agent of {project}.', note: 'cw_lane start refused (HI-2273): it names a reviewer that is no agent of the project, and the lane has none yet.' }),
  unknownBuilder: agentMsg({ id: 'lane.refused.unknownBuilder', text: 'Unknown agent: the builder must be an agent of the project', note: "cw_lane start refused: its builder isn't an agent of the project." }),
  unknownReviewer: agentMsg({ id: 'lane.refused.unknownReviewer', text: 'Unknown agent: the reviewer must be an agent of the project', note: "cw_lane start refused: its reviewer isn't an agent of the project." }),
  unknownPair: agentMsg({ id: 'lane.refused.unknownPair', text: 'Unknown agent: the builder and reviewer must be agents of the project', note: "cw_lane join refused: its builder or reviewer isn't an agent of the project." }),
  selfReview: agentMsg({ id: 'lane.refused.selfReview', text: "A lane's builder can't be its reviewer", note: 'cw_lane start or join refused: the same agent named as builder and reviewer.' }),
  poolReviewer: agentMsg({ id: 'lane.refused.poolReviewer', text: 'A lane reviewed by the pool has no reviewer of its own', note: 'cw_lane start refused: a reviewer named for a lane reviewed by the pool (#1443).' }),
  endedMeanwhile: agentMsg({ id: 'lane.refused.applyNow.endedMeanwhile', text: "{card} was put back in Todo (its work stays on its branch), but the lane was ended meanwhile: its list wasn't changed and nothing was started. cw_lane list shows the lanes.", note: 'A reorder applied now (HI-1995): its card was put back, then the lane ended before its list was saved.' }),
  changedMeanwhile: agentMsg({ id: 'lane.refused.applyNow.changedMeanwhile', text: "{card} was put back in Todo (its work stays on its branch), but the lane's list changed meanwhile: this list wasn't applied. cw_lane list shows it now.", note: "A reorder applied now (HI-1995): its card was put back, then the lane's list changed before this one was saved." }),
  noLaneToPlace: agentMsg({ id: 'lane.refused.noLaneToPlace', text: "{builder} has no running lane in {project}: the card was made but not placed. Start one with cw_lane start (its key is in this reply), or pass lane as '{ builder, reviewer }' to start one as you create a card.", note: "cw_create_task's lane refused (HI-2167): the builder named has no running lane to place the card on. '{ builder, reviewer }' is quoted ICU: it shows as { builder, reviewer }." }),
  allDoneNoLane: agentMsg({ id: 'lane.refused.allDone', text: '{cards} {n, plural, one {is} other {are}} already Done: no lane started.', note: 'cw_lane start refused: every card of its list is already Done; {n} is how many.' }),
  keptChanging: agentMsg({ id: 'lane.refused.keptChanging', text: 'The lane kept changing: try again', note: "cw_lane start refused: the lane's cards kept moving between its read and its save." }),
  queued: agentMsg({ id: 'lane.start.queued', text: 'The list change is queued: it applies once {card} is Done, and you are told then.', note: "cw_lane start's note (#1270): a list change while a card is in flight waits for that card ({card}) to be Done." }),
  applied: agentMsg({ id: 'lane.start.applied', text: "Applied now: {card} is back in Todo (its work stays on {line}); the lane's cards are now in this order, and {builder} is told.", note: "cw_lane start's note for a reorder applied now (HI-1995); {line} is the card's branch (or lane.reorder.itsBranch)." }),
  leftOut: agentMsg({ id: 'lane.start.leftOut', text: '{cards} {n, plural, one {is} other {are}} already Done: left out.', note: "cw_lane start's note (HI-2097): cards already Done, left out of a new lane; {n} is how many." }),
  stays: agentMsg({ id: 'lane.start.stays', text: "{cards} {n, plural, one {stays} other {stay}} on the lane, after the cards you listed: a builder's own cw_lane start adds or reorders cards, never takes one off (the Assistant or the user does).", note: "cw_lane start's note (HI-2169): a builder's own start left cards of its lane out, and they are kept after its list; {n} is how many." }),
  joinPool: agentMsg({ id: 'lane.refused.joinPool', text: "{builder}'s lane is reviewed by the reviewer pool: there is nothing to join. Combwork gives you its cards when it assigns them to you.", note: 'cw_lane join refused (#1443): a lane reviewed by the pool has nobody to join it.' }),
  joinNoLane: agentMsg({ id: 'lane.refused.joinNoLane', text: '{builder} has no lane running yet: give the cards too, and the lane starts with you as its reviewer', note: "cw_lane join refused: the builder has no running lane, and no cards were given to start one." }),
  joinedFirst: agentMsg({ id: 'lane.join.first', text: "{builder} hadn't registered it yet: its own start updates it.", note: "cw_lane join's note: the reviewer joined first, starting the lane from its cards; the builder's own start updates it." }),
  endNotOurs: agentMsg({ id: 'lane.refused.end.notOurs', text: "Only a lane's builder or reviewer ends it (or the user, or the Assistant)", note: "cw_lane end refused: a project agent that isn't the lane's builder or reviewer." }),
  abandonNotOurs: agentMsg({ id: 'lane.refused.end.abandon', text: 'Only the user or the Assistant abandons a lane: tell the user if it should stop', note: 'cw_lane end with abandoned refused (#1270, §16.8.2): an agent never abandons its lane.' }),
  endNotDone: agentMsg({ id: 'lane.refused.end.notDone', text: 'The lane ends by itself once all its cards are Done: {cards} not yet', note: "cw_lane end refused (#1270): an agent's lane ends by itself once all its cards are Done; {cards} are those not Done yet." }),
  movedOn: agentMsg({ id: 'lane.refused.end.movedOn', text: 'Its cards moved on meanwhile: read the lane again', note: "cw_lane end refused: the lane's cards moved between its read and its save (a card reopened)." }),
  nextEnded: agentMsg({ id: 'lane.refused.next.ended', text: "Your lane {lane} has ended: all its cards are Done. Nothing more on it: don't start it again; end your turn unless you have other work.", note: "cw_lane next, for an agent whose lane just ended (HI-2273): never \"start one\", which invited a builder to start it again." }),
  nextEndedOpen: agentMsg({ id: 'lane.refused.next.endedOpen', text: "Your lane {lane} was ended with {cards} not Done: nothing more on it. Don't start it again; ask the user before starting another lane with {n, plural, one {that card} other {those cards}}.", note: 'cw_lane next (HI-3118), for an agent whose lane was just ended (by the user, say) while cards of it were still open: never "all its cards are Done". {cards} is their keys, joined with ", "; {n} how many.' }),
  nextEndedUnknown: agentMsg({ id: 'lane.refused.next.endedUnknown', text: "Your lane {lane} has ended. Nothing more on it: don't start it again; end your turn unless you have other work.", note: "cw_lane next (HI-3118), for an agent whose lane just ended when how its cards stood then wasn't kept: says nothing of them." }),
  nextAbandoned: agentMsg({ id: 'lane.refused.next.abandoned', text: "Your lane {lane} was abandoned: don't start it again; ask the user if there is more to do.", note: 'cw_lane next, for an agent whose lane was just abandoned (HI-2273).' }),
  nextNone: agentMsg({ id: 'lane.refused.next.none', text: 'No running lane of yours: start one with cw_lane start, or ask the user', note: 'cw_lane next, for an agent with no running lane.' }),
  journal: agentMsg({ id: 'lane.journal.fact', text: 'Lane {named, select, yes {"{name}" } other {}}{state, select, started {started} ended {ended} merged {ended, merged at {commit}} other {abandoned}}: {who}, {cards}', note: "A lane's start or end as a fact in the Assistant's journal (#1031), stored: {who} is \"builder / reviewer\", {cards} its cards; {named} yes when the lane has a name ({name})." })
}

/** Each lane's project id as it was read, so a lane whose project the workspace doesn't have now keeps it. */
const readIds = new WeakMap<LaneRecord, string>()

/**
 * A workspace's lanes; each names its project by its stable id too (#508): its project is the one that has the id now
 * (projectNow), and a lane saved before ids has its name only.
 */
async function read(ws: WorkspaceService): Promise<LaneRecord[]> {
  const gen = dbGeneration(ws.path!)
  const data = await savedLanes(ws)
  const raw = data && typeof data === 'object' && Array.isArray((data as { lanes?: unknown }).lanes) ? ((data as { lanes: unknown[] }).lanes as Record<string, unknown>[]) : []
  const seen = JSON.stringify(raw)
  // Listed now: the cards read against these lanes next see the same projects (a lane and its cards agree).
  const ids = await ws.projectIds({ fresh: true })
  const idOf = new Map<string, string>()
  for (const v of raw) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !isProjectId(v.projectId)) continue
    idOf.set(v.id, v.projectId)
    if (typeof v.project === 'string') v.project = projectNow(ids, v.project, v.projectId)
  }
  const lanes = readLanes(data)
  for (const l of lanes) if (idOf.has(l.id)) readIds.set(l, idOf.get(l.id)!)
  readGens.set(lanes, gen)
  readAs.set(lanes, seen)
  return lanes
}

/** The workspace database's generation each list was read in (#1207 round 2): written back only into that one. */
const readGens = new WeakMap<LaneRecord[], number>()

/**
 * The lanes each list was read from, as saved (HR6's #1270 round 4): written back only while the tables still hold
 * them, checked under the board's lock. The runtime writes the lanes too (a queued list applied at a card's start), so a
 * list read before that is never saved over it: the save is refused (StaleLane) and decided again from a fresh read.
 */
const readAs = new WeakMap<LaneRecord[], string>()

/**
 * Workspaces whose lanes were opened (moved in from lanes.json, the first time) since Combwork started, by spelling, with the
 * workspace's place as it entered (#1456).
 */
const opened = new Map<string, string>()
// The database replaced (the upgrade to 1.0, a restore): lanes.json is looked for again (its move may have waited), under
// every spelling of the workspace, by the place each recorded.
onDbReplaced((workspacePath, place) => {
  for (const [k, at] of [...opened]) if (k === workspacePath.toLowerCase() || at === place) opened.delete(k)
})

/**
 * lanes.json from before #1018, read to move it in (#1018 round 1): null only when there is none. One that can't be read
 * now (Windows holding it, no permission) is an error, so nothing is marked moved and the next open tries again; one that
 * isn't JSON lanes is set aside (`lanes.json.damaged-<time>`, renamed, never deleted) and none are moved in, or, if it
 * can't be set aside, that is an error too and it is left as it is.
 */
export async function readLanesFile(file: string): Promise<{ docs: unknown[] } | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw saidError(A.readFailed, { error: (e as Error).message }, { cause: e })
  }
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    v = null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v) || ((v as { lanes?: unknown }).lanes !== undefined && !Array.isArray((v as { lanes?: unknown }).lanes))) {
    const to = `${file}.damaged-${Date.now()}`
    try {
      await renameRetrying(file, to)
    } catch (e) {
      throw saidError(A.damaged, { error: (e as Error).message }, { cause: e })
    }
    log.warn(`The lanes file was damaged: set aside as ${userText(to)}`)
    return { docs: [] }
  }
  return { docs: (v as { lanes?: unknown[] }).lanes ?? [] }
}

/**
 * The lanes as saved, in the form lanes.json had (`{ version, lanes }`): the workspace database's tables, after moving
 * the file in the first time (#1018, #1212). Read under the lanes' lock.
 */
async function savedLanes(ws: WorkspaceService): Promise<{ version: 1; lanes: Record<string, unknown>[] }> {
  const path = ws.path!
  const key = path.toLowerCase()
  const file = fileOf(ws)
  // Its place resolved as it enters, before anything is awaited (#1456).
  const place = opened.has(key) ? null : placeKey(path)
  const data = place === null
    ? readTable(path, 'lanes')
    : await openTable(path, 'lanes', file, () => readLanesFile(file))
  // While the upgrade to 1.0 waits nothing was moved in: looked for again once it is upgraded.
  if (place !== null && !upgradeWaiting(path)) opened.set(key, place)
  return { version: 1, lanes: data.docs as Record<string, unknown>[] }
}

/** The lanes as saved: each with its project's id beside its name (the id it had, for a project the workspace doesn't have now). */
/**
 * Told as soon as a workspace's lanes are written, before the settled `lanes-changed` event (300 ms later): a lane's
 * reviewer decides who a loop wake goes to, and a wake being typed checks that nothing changed meanwhile (#578 round 2:
 * one typed to a reviewer taken off the lane inside that window).
 */
const writtenListeners = new Set<() => void>()
export function onLanesWritten(fn: () => void): () => void {
  writtenListeners.add(fn)
  return () => writtenListeners.delete(fn)
}

async function write(ws: WorkspaceService, lanes: LaneRecord[], check?: () => void, also?: (db: Writer) => void, inBoard = false): Promise<void> {
  bumpListRevs(lanes)
  const ids = await ws.projectIds()
  const stamped = keptLanes(lanes, Date.now()).map((l) => {
    const saved = savedProjectName(l.project)
    const projectId = (saved === l.project ? projectIdNamed(ids, saved) : null) ?? readIds.get(l)
    const { id, project: _shown, ...rest } = l
    return { id, project: saved, ...(projectId ? { projectId } : {}), ...rest }
  })
  // Read from a database since replaced (the upgrade to 1.0, a restore): never written over the file as it is now.
  const gen = readGens.get(lanes)
  const seen = readAs.get(lanes)
  const path = ws.path!
  const guard = (): void => {
    if (gen !== undefined && gen !== dbGeneration(path)) throw new Error("the workspace's database was replaced since these lanes were read: nothing was saved") // i18n-ignore: a save refused as a mistake's error, for the log
    // Another writer (the runtime, #1270) changed the lanes since they were read: nothing is saved over it.
    if (seen !== undefined && boardOpen(path) && JSON.stringify(readTable(path, 'lanes').docs) !== seen) throw new StaleRead('the lanes changed since they were read') // i18n-ignore: internal, caught and retried (never shown)
    // Under the board's lock, with nothing awaited before the save: what a decision read of the cards still holds.
    check?.()
  }
  // Inside a board change (HI-2898: a window's lane edit with the card it changes), in its transaction: the listeners
  // are told once it commits (mutateInBoard).
  if (inBoard) {
    if (also) throw new Error('a lane save inside a board change takes no extra writes') // i18n-ignore: a mistake in Combwork's code, never shown
    return saveTableInBoard(ws, 'lanes', stamped, guard)
  }
  await saveTable(path, 'lanes', stamped, {}, guard, also)
  for (const fn of writtenListeners) fn()
}

/**
 * Each lane whose list (`cards` or `pending`) this save changes from what was read gets the next list revision
 * (HI-2898, LaneRecord.listRev); a new lane keeps none (0). Before the save, so the revision is in its transaction.
 */
function bumpListRevs(lanes: LaneRecord[]): void {
  const seen = readAs.get(lanes)
  if (seen === undefined) return
  const was = new Map<string, { cards?: unknown; pending?: unknown }>()
  for (const v of JSON.parse(seen) as unknown[]) if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') was.set((v as { id: string }).id, v as { cards?: unknown; pending?: unknown })
  for (const l of lanes) {
    const w = was.get(l.id)
    if (!w) continue
    if (JSON.stringify(w.cards ?? null) !== JSON.stringify(l.cards) || JSON.stringify(w.pending ?? null) !== JSON.stringify(l.pending ?? null)) l.listRev = (l.listRev ?? 0) + 1
  }
}

/**
 * Each lane names its project by id too (#508), once, when the workspace opens: those saved before ids whose name is a
 * project get its id, and those whose project was renamed since its name now (lanes.json, from before, is kept as the
 * database's import backup, #1018). Lanes under a name no project has are left as they are (Repair:
 * moveOrphanLanes). Changes nothing the second time. Returns how many lanes changed.
 */
export async function stampLaneProjects(ws: WorkspaceService): Promise<number> {
  if (!ws.path) return 0
  const file = fileOf(ws)
  const n = await readAgain(() => withFileLock(file, async () => {
    const before = await savedLanes(ws)
    if (!before.lanes.length) return 0
    const lanes = await read(ws)
    const ids = await ws.projectIds()
    const names = new Map(lanes.map((l) => [l.id, l.project]))
    const changing = (before.lanes as Record<string, unknown>[]).filter((v) => {
      if (!v || typeof v !== 'object' || typeof v.project !== 'string') return false
      if (isProjectId(v.projectId)) return names.get(v.id as string) !== v.project && !!projectNameOf(ids, v.projectId)
      return !!projectIdNamed(ids, v.project)
    }).length
    if (!changing) return 0
    await write(ws, lanes)
    return changing
  }))
  if (n) {
    log.info(`${n} lane(s) now name their project by its id`)
    changed(ws)
  }
  return n
}

/**
 * Repair (#508): lanes saved before ids under a project's old name go to the project they belong to now, with its id.
 * In lanes.json's lock, read again there; one with an id, or under another name now, is left as it is. Returns how many.
 */
export async function moveOrphanLanes(ws: WorkspaceService, m: { from: string; to: string }): Promise<number> {
  if (!ws.path) return 0
  const file = fileOf(ws)
  const n = await readAgain(() => withFileLock(file, async () => {
    const lanes = await read(ws)
    const moving = lanes.filter((l) => !readIds.has(l) && same(l.project, m.from))
    if (!moving.length) return 0
    for (const l of moving) {
      l.project = m.to
      l.updatedAt = now()
    }
    await write(ws, lanes)
    return moving.length
  }))
  if (n) {
    log.info(`Repair gave ${n} lane(s) of ${userText(m.from)} to ${userText(m.to)}`)
    changed(ws)
  }
  return n
}

/** The lanes saved before ids (#508), as Repair weighs whose they are: their project's name and their agents. */
export async function legacyLanes(ws: WorkspaceService): Promise<{ name: string; agents: string[] }[]> {
  return (await read(ws)).filter((l) => !readIds.has(l)).map((l) => ({ name: l.project, agents: [l.builder.id, ...(l.reviewer ? [l.reviewer.id] : [])] }))
}

/** Changes a workspace's lanes under its lock: fn changes the list it is given (or throws), and says whether it did. */
/**
 * HI-2680: runs `fn` holding the lanes' file lock, which every lane start and list change holds while it decides: a
 * save taking a branch out of the project's targets holds it around its board write, so a lane start on that branch
 * and the removal are serial (the one that comes second is refused).
 */
export function withLanesLock<T>(ws: WorkspaceService, fn: () => Promise<T>): Promise<T> {
  if (!ws.path) return fn()
  return withFileLock(fileOf(ws), fn)
}

async function mutate<T>(ws: WorkspaceService, fn: (lanes: LaneRecord[], checks: (() => void)[], also: ((db: Writer) => void)[]) => T | Promise<T>): Promise<T> {
  if (!ws.path) throw new LaneError(409, M.noWorkspace)
  const result = await readAgain(() => withFileLock(fileOf(ws), async () => {
    const lanes = await read(ws)
    const checks: (() => void)[] = []
    // Writes that belong with the save, in its transaction (the Assistant's change for undo, #1282).
    const also: ((db: Writer) => void)[] = []
    const r = await fn(lanes, checks, also)
    await write(ws, lanes, () => checks.forEach((c) => c()), (db) => also.forEach((w) => w(db)))
    return r
  }))
  changed(ws)
  return result
}

/**
 * A change of the lanes saved with changes of the board, in one transaction (HI-2898: a window's lane edit and the card
 * assignment it makes). Under the lanes' lock, as mutate: the lanes are read first (before the board's change, which
 * holds every card change while it runs), then `decide` works out the change from them, with the awaited reads it needs;
 * then, inside one board change, `commit` makes the card changes (through the card-change owner, re-entrant into this
 * change) and the checks run with the lanes' save. A refusal, a check, or a stale read (the runtime changed the lanes
 * meanwhile: decided again from a fresh read, as mutate) rolls all of it back. Listeners are told after it commits.
 */
export async function mutateInBoard<D, T>(ws: WorkspaceService, decide: (lanes: LaneRecord[]) => Promise<D>, commit: (lanes: LaneRecord[], d: D, checks: (() => void)[]) => Promise<T>): Promise<T> {
  if (!ws.path) throw new LaneError(409, M.noWorkspace)
  const result = await readAgain(() => withFileLock(fileOf(ws), async () => {
    const lanes = await read(ws)
    const d = await decide(lanes)
    return boardWrite(ws, async () => {
      const checks: (() => void)[] = []
      const r = await commit(lanes, d, checks)
      await write(ws, lanes, () => checks.forEach((c) => c()), undefined, true)
      return r
    })
  }))
  for (const fn of writtenListeners) fn()
  changed(ws)
  return result
}

/**
 * Runs a read and its save again while the lanes changed between them (StaleRead: the runtime applied a queued list
 * meanwhile, #1270), a few times; fn starts from its own read each time, so it resets what it gathers.
 */
async function readAgain<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof StaleRead) || attempt >= 4) throw e
    }
  }
}

const now = (): string => new Date().toISOString()
const newId = (): string => `lane-${randomBytes(3).toString('hex')}`

/** A lane's start or end as a fact in the Assistant's journal (#1031): who, which cards, how it ended, its merge. */
function laneFact(ws: WorkspaceService, l: LaneRecord): void {
  const who = `${l.builder.name}${l.reviewer ? ` / ${l.reviewer.name}` : ''}`
  const cards = withCardNames(ws, () => l.cards.map(cardRef).join(', '))
  const state = l.state === 'active' ? 'started' : l.state === 'ended' ? (l.mergeCommit ? 'merged' : 'ended') : 'abandoned'
  // Stored for any reader (the Assistant, the journal browser): in the Default, until stored text is said when read.
  // Kept as its message too (HI-2438's summaryText), so a later reader can be told it in their own dialect.
  const values = { named: l.name ? 'yes' : 'no', name: l.name ?? '', state, commit: l.mergeCommit ?? '', who, cards }
  const summary = inDefaultDialect(() => say(A.journal, values))
  journalFact(ws, {
    summary,
    summaryText: { id: A.journal.id, values },
    project: l.project,
    importance: l.mergeCommit ? 2 : 1,
    links: [...l.cards.map((n) => ({ type: 'card' as const, ref: String(n) })), ...(l.mergeCommit ? [{ type: 'commit' as const, ref: l.mergeCommit }] : [])].slice(0, 40),
    tags: ['lane']
  })
}

/**
 * Ends a lane: ended when all its cards are merged (or `merged` says so), else abandoned. `cards`: its cards as they read
 * just now, kept as it was left (#512), when they are still its list (a start may have changed it meanwhile).
 */
function close(l: LaneRecord, state: 'ended' | 'abandoned', cards: readonly LaneCard[] | undefined, mergeCommit?: string | null): void {
  l.state = state
  l.endedAt = l.updatedAt = now()
  if (mergeCommit) l.mergeCommit = mergeCommit
  if (cards && cards.length === l.cards.length && cards.every((c, i) => c.number === l.cards[i])) l.frozen = [...cards]
}

/** The lane cards as the board has them now, each read once, as the lane's project sees them. */
async function cardsOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<number, TaskCard | null>>> {
  const out = new Map<string, Map<number, TaskCard | null>>()
  // An ended lane reads as it was left: nothing to read. The others' cards in one read, each kept until it changes
  // (HI-1780: cardsNow).
  const cards = await cardsNow(ws, lanes.filter((l) => !isFrozen(l)).flatMap((l) => l.cards))
  for (const l of lanes) {
    const m = new Map<number, TaskCard | null>()
    out.set(l.id, m)
    if (isFrozen(l)) continue
    for (const n of l.cards) {
      const card = cards.get(n) ?? null
      m.set(n, card && !card.archived && inScope(card, l.project) ? card : null)
    }
  }
  return out
}

/** Each project's agents' names now, by id (a renamed agent shows its new name). */
async function namesOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<string, string> | null>> {
  const out = new Map<string, Map<string, string> | null>()
  for (const l of lanes) {
    const k = l.project.toLowerCase()
    if (out.has(k) || !ws.path) continue
    // A project not there by that name (renamed a moment ago, or gone) is unknown, not one without agents.
    const p = join(ws.path, l.project)
    const cfg = existsSync(join(p, CW_DIR, 'project.json')) ? await ws.projectConfig(p).catch(() => null) : null
    out.set(k, cfg ? new Map(projectAgents(cfg).map((a) => [a.id, a.name])) : null)
  }
  return out
}

/** The workflow service, loaded when first needed (it reaches tasks.ts, which reaches this module). */
const service = (): Promise<typeof import('./workflow/service')> => import('./workflow/service')

/** Whether workflow rules are enforced now (Settings → Advanced): off, a lane is bookkeeping, as before 1.0. */
async function enforced(): Promise<boolean> {
  return (await service()).workflowEnforced()
}
export const lanesEnforced = enforced

/**
 * What a running lane's status reads of its cards' facts (#1270): each card's fold, while workflow rules are enforced
 * (null otherwise, or for a lane whose facts can't be read now: it says only what the board says).
 */
async function factsOf(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<Map<string, Map<number, LaneCardFacts> | null>> {
  const out = new Map<string, Map<number, LaneCardFacts> | null>()
  const on = await enforced()
  // Each card's kept by its facts' head (HI-1780: every board change reads every running lane, and facts are only ever
  // added): only a card with new facts is read and folded again.
  const heads = on && ws.path ? factHeadsOf(ws, lanes.filter(running).flatMap((l) => l.cards)) : new Map<number, string>()
  const kept = keptLaneFacts(ws)
  for (const l of lanes) {
    if (!on || !running(l) || !ws.path) {
      out.set(l.id, null)
      continue
    }
    try {
      const store = FactStore.forBoard(ws, { project: l.project, key: l.project })
      const m = new Map<number, LaneCardFacts>()
      for (const n of l.cards) {
        const key = heads.get(n) ?? ''
        const was = kept.get(n)
        if (was?.key === key) {
          m.set(n, was.facts)
          continue
        }
        const facts = cardFactsOf(store, n)
        kept.set(n, { key, facts })
        m.set(n, facts)
      }
      out.set(l.id, m)
    } catch (e) {
      log.warn(`reading lane ${l.id}'s cards' facts`, e)
      out.set(l.id, null)
    }
  }
  return out
}

/** What a lane reads of one card's facts (factsOf, laneNow): its fold's stage, an open request for you, a stale pass, its rounds. */
function cardFactsOf(store: FactStore, n: number): LaneCardFacts {
  const all = store.facts(n)
  const s = foldCard(all)
  const asks = forYou(s)
  // Who reviewed and reviews it (#1446: a pool lane's hover names them).
  const last = s.verdicts.at(-1)
  // A pool lane's design nobody has taken yet (HI-2310): the lane waits for a reviewer, as for a submission.
  const designWaits = s.stage === 'active' && s.step?.step === 'design' && poolOf(store, n) && !designReviewer(all, () => true)
  return { stage: s.stage, forYou: asks.length > 0, ...(asks[0] ? { ask: asks[0].kind } : {}), stale: !!s.stale, rounds: s.rounds, lastVerdict: last ? { reviewer: last.reviewer, pass: last.pass } : null, reviewing: reviewingNow(all, () => true)?.reviewing ?? null, ...(s.requests.some((r) => r.gate === SLOT_DIRTY_GATE) ? { slotDirty: true } : {}), ...(designWaits ? { designWaits: true } : {}) }
}

/** Whether a card's lane is reviewed by the pool (#1443), as the board has it. */
function poolOf(store: FactStore, n: number): boolean {
  try {
    return !!store.card(n).reviewerPool
  } catch {
    return false
  }
}

/** Each workspace's lane cards' facts as factsOf read them, with their facts' head then; a workspace opened again starts afresh. */
const laneFacts = new WeakMap<WorkspaceService, { path: string | null; life: unknown; cards: Map<number, { key: string; facts: LaneCardFacts }> }>()
function keptLaneFacts(ws: WorkspaceService): Map<number, { key: string; facts: LaneCardFacts }> {
  let c = laneFacts.get(ws)
  if (!c || c.path !== ws.path || c.life !== ws.lifetime) laneFacts.set(ws, (c = { path: ws.path, life: ws.lifetime, cards: new Map() }))
  return c.cards
}

/**
 * A running lane's builder or reviewer whose role doesn't do its part (HI-2664: a lane from before roles counted, or a
 * guessed role), by id: its part. Its tools follow its role, so the lane pauses (offSide) and is given nothing new.
 */
function offSideOf(ws: WorkspaceService, l: LaneRecord): Map<string, 'builder' | 'reviewer'> {
  const agents = ws.path ? ws.info()?.projects.find((p) => same(p.name, l.project))?.config.agents : undefined
  const role = (id: string) => {
    const a = agents?.find((x) => x.id === id)
    return a ? agentWorkflowRole(a) : null
  }
  const out = new Map<string, 'builder' | 'reviewer'>()
  const b = role(l.builder.id)
  if (b && inWorkflow(b) && !buildsWork(b)) out.set(l.builder.id, 'builder')
  const r = l.reviewer ? role(l.reviewer.id) : null
  if (l.reviewer && r && inWorkflow(r) && !reviewsWork(r)) out.set(l.reviewer.id, 'reviewer')
  return out
}

/** A running lane's agents that are Independent now (HI-2670), by id. */
function outOfWorkflow(ws: WorkspaceService, l: LaneRecord): Set<string> {
  return new Set([l.builder, l.reviewer].filter((a): a is LaneAgent => !!a && !!ws.path && independentIn(ws, join(ws.path, l.project), a.id)).map((a) => a.id))
}

/** Lanes as they read now. */
async function views(ws: WorkspaceService, lanes: readonly LaneRecord[]): Promise<LaneInfo[]> {
  const cards = await cardsOf(ws, lanes)
  const names = await namesOf(ws, lanes)
  const facts = await factsOf(ws, lanes)
  // The running lanes' cards waiting for the user at their round limit (§16.11.4): from their facts, while the rules
  // are enforced (turned off, nothing pauses a lane for a rule).
  const atLimit = ws.path && rulesEnforced() ? roundLimitCards(ws, lanes.filter((l) => !isFrozen(l)).flatMap((l) => l.cards)) : new Set<number>()
  // Their agents whose hooks aren't arriving (#1336): such a lane pauses.
  const deaf = (l: LaneRecord): Set<string> => new Set([l.builder, l.reviewer].filter((a): a is LaneAgent => !!a && !!ws.path && hooksMissingFor(join(ws.path, l.project), a.id)).map((a) => a.id))
  // And those Independent now (HI-2670): such a lane pauses too.
  const out = (l: LaneRecord): Set<string> => outOfWorkflow(ws, l)
  // Each project's ruleset now, for the old rules marks (#1421): only read when a running lane recorded one.
  const recorded = lanes.filter((l) => running(l) && l.ruleset).map((l) => l.ruleset!)
  const current = recorded.length ? await rulesetsNow(ws) : new Map<string, string>()
  // And their own stages, which a lane under old rules keeps (HR4's #1421 round 1).
  const stagesOf = ws.path ? rulesetStages(ws, recorded) : new Map<string, null>()
  // Each running lane's cards' owner lanes (HI-1821): a card given to no agent is the lane's that owns it.
  const owned = ws.path ? cardOwnersNow(ws, [...new Set(lanes.filter(running).flatMap((l) => l.cards))]) : new Map<number, { lane: string | null }>()
  const owners = new Map([...owned].map(([n, o]) => [n, o.lane]))
  const deps = await dueDepsOf(ws, lanes, cards)
  return withWaitTimes(ws, lanes.map((l) => laneView(l, cards.get(l.id)!, names.get(l.project.toLowerCase()) ?? undefined, facts.get(l.id), atLimit, rulesEnforced() ? lineWaiting(ws, l.id) : null, running(l) ? deaf(l) : undefined, current.get(l.project.toLowerCase()), l.ruleset ? stagesOf.get(l.ruleset) : null, running(l) ? slotView(ws, l) : null, owners, running(l) && ws.path ? startWaits(ws.path, l.id) : null, !!teamPauseOf(ws), deps.get(l.id) ?? null, running(l) ? out(l) : undefined, running(l) ? offSideOf(ws, l) : undefined)))
}

/**
 * Each running lane's due card's dependencies (HI-2618, LaneInfo.dueDeps), from the board: its first card not Done, in
 * Todo, with `blockedBy`, where Combwork waits for them (the rules off: a lane is bookkeeping and its builder starts
 * it; on: only under the start's rule that they be Done, else Combwork starts it regardless). The ones not Done by key,
 * and once none is, when the last of them went Done (their history's move into Done). laneView says it only for its
 * current card.
 */
async function dueDepsOf(ws: WorkspaceService, lanes: readonly LaneRecord[], cards: Map<string, Map<number, TaskCard | null>>): Promise<Map<string, DueDeps>> {
  const out = new Map<string, DueDeps>()
  if (!ws.path) return out
  const due = new Map<string, TaskCard>()
  for (const l of lanes) {
    if (!running(l)) continue
    const mine = cards.get(l.id)
    const next = l.cards.map((n) => mine?.get(n) ?? null).find((c) => !!c && c.column !== 'done')
    if (next && next.column === 'todo' && next.blockedBy.length) due.set(l.id, next)
  }
  if (!due.size) return out
  const deps = await cardsNow(ws, [...new Set([...due.values()].flatMap((c) => c.blockedBy))])
  const rulesOn = rulesEnforced()
  for (const [id, c] of due) {
    const l = lanes.find((x) => x.id === id)!
    const wf = await (await import('./workflow/service')).workflowFor(ws, join(ws.path, l.project)).catch(() => null)
    if (rulesOn && !startWaitsForDependencies(wf, c.number)) continue
    const found = c.blockedBy.map((n) => deps.get(n) ?? null).filter((d): d is TaskCard => !!d)
    // By key as the workflow names its cards (the board's key where it can't).
    const keyOf = (d: TaskCard): string => {
      try {
        return wf?.store.card(d.number).key ?? d.key ?? `#${d.number}`
      } catch {
        return d.key ?? `#${d.number}`
      }
    }
    const open = found.filter((d) => d.column !== 'done').map(keyOf)
    const doneAt = found.map((d) => columnSince(d) ?? '').filter(Boolean).sort()
    out.set(id, { card: c.number, open, readyAt: open.length || !doneAt.length ? null : doneAt.at(-1)! })
  }
  return out
}

/** Whether card n's rules start it only once the cards it depends on are Done (`start.dependenciesIntegrated`); unknown: no. */
function startWaitsForDependencies(wf: Awaited<ReturnType<typeof import('./workflow/service')['workflowFor']>> | null, n: number): boolean {
  try {

    return !!wf && wf.rulesetOf(wf.store.card(n)).guards.start.includes('start.dependenciesIntegrated')
  } catch {
    return false
  }
}

/**
 * Each workspace's running lanes' waits as last listed (HI-1926): by lane, its stamp (none while it doesn't wait). One
 * for every window on the workspace, so none resets another's; a workspace opened again starts afresh, and a lane that
 * stops running leaves it. At most WAIT_STAMPS_MAX lanes, the oldest listed dropped first.
 */
const waitStamps = new WeakMap<WorkspaceService, { path: string | null; life: unknown; lanes: Map<string, WaitStamp | undefined> }>()
const WAIT_STAMPS_MAX = 500

/** Lanes with when each one's wait began (`status.since`), from its stamp; `atLeast` where Combwork didn't see it begin. */
function withWaitTimes(ws: WorkspaceService, list: LaneInfo[]): LaneInfo[] {
  let c = waitStamps.get(ws)
  if (!c || c.path !== ws.path || c.life !== ws.lifetime) waitStamps.set(ws, (c = { path: ws.path, life: ws.lifetime, lanes: new Map() }))
  const at = Date.now()
  return list.map((v) => {
    if (v.state !== 'active' && v.state !== 'paused') {
      c.lanes.delete(v.id)
      return v
    }
    const known = c.lanes.has(v.id)
    const stamp = stampWait(c.lanes.get(v.id), v.status, at, known)
    c.lanes.delete(v.id)
    c.lanes.set(v.id, stamp)
    while (c.lanes.size > WAIT_STAMPS_MAX) c.lanes.delete(c.lanes.keys().next().value!)
    return stamp && v.status ? { ...v, status: { ...v.status, since: stamp.since, ...(stamp.observed ? {} : { atLeast: true }) } } : v
  })
}

/**
 * A running lane's slot, and whether it waits for one (Start Lane… found none free, `slotWait`, and it has none yet),
 * with the free slot it was last refused as held, and what holds it (HI-2466).
 */
function slotView(ws: WorkspaceService, l: LaneRecord): { slot: string | null; waiting: boolean; info: LaneSlotInfo | null; held: LaneSlotHeld | null } {
  const info = slotOf ? slotOf(ws, l) : null
  // A lane waits for a slot only for one lent to it: its builder's carried slot doesn't end the wait.
  const lent = info && !info.carried ? info.name : null
  const waiting = !lent && !!l.slotWait
  return { slot: info?.name ?? null, waiting, info, held: waiting && ws.path ? slotHeldOf(ws.path, l.id) : null }
}

/**
 * A lane's wait for a slot (#1438): set as Start Lane… finds none free (with the user's note for its agents' briefs),
 * cleared once it has one and its agents start (null). A lane not running is left as it is.
 */
/** A change of the lanes under their lock, in one save (laneBriefs.ts: a brief's delivery recorded, HI-1795). */
export async function mutateLanes(ws: WorkspaceService, fn: (lanes: LaneRecord[]) => void): Promise<void> {
  await mutate(ws, (lanes) => fn(lanes))
}

export async function setLaneSlotWait(ws: WorkspaceService, id: string, wait: LaneRecord['slotWait'] | null): Promise<void> {
  await mutate(ws, (lanes) => {
    const l = lanes.find((x) => x.id === id)
    if (!l || (wait && !running(l))) return
    if (wait) l.slotWait = wait
    else delete l.slotWait
  })
}

/**
 * A lane agent's new conversation owed (HI-2034): its start found it not free. One per role (a later one replaces it);
 * a lane not running, or whose agent in that role is another now, gets nothing.
 */
export async function oweFreshStart(ws: WorkspaceService, id: string, agent: string, role: 'builder' | 'reviewer', oldSession: string | null, note = ''): Promise<void> {
  await mutate(ws, (lanes) => {
    const l = lanes.find((x) => x.id === id)
    if (!l || !running(l) || (role === 'builder' ? l.builder.id : l.reviewer?.id) !== agent) return
    const entry: FreshStart = { id: randomBytes(6).toString('hex'), agent, role, since: new Date().toISOString(), oldSession, ...(note ? { note: note.slice(0, 4000) } : {}) }
    l.freshStart = [...(l.freshStart ?? []).filter((f) => f.role !== role), entry]
  })
}

/**
 * Changes fresh start `entryId` of lane `id` under the lanes' lock (HI-2034): `fn` gets it while the lane runs with that
 * agent in that role, and returns it changed, or null to drop it; the lane's others are left as they are. Whether it was
 * there (and so changed): an obligation gone meanwhile is never acted on.
 */
export async function changeFreshStart(ws: WorkspaceService, id: string, entryId: string, fn: (f: FreshStart) => FreshStart | null): Promise<boolean> {
  let found = false
  await mutate(ws, (lanes) => {
    found = false
    const l = lanes.find((x) => x.id === id)
    const f = l?.freshStart?.find((x) => x.id === entryId)
    if (!l || !f) return
    // Its lane ended or its agent in that role changed: the obligation is gone with it.
    const owner = running(l) && (f.role === 'builder' ? l.builder.id : l.reviewer?.id) === f.agent
    const next = owner ? fn(f) : null
    found = owner
    const rest = l.freshStart!.filter((x) => x.id !== entryId)
    if (next) rest.push(next)
    if (rest.length) l.freshStart = rest
    else delete l.freshStart
  })
  return found
}

/**
 * A lane's fresh starts no more tried, tried again (HI-2034: the user's Retry, from the lane's row or the Assistant's
 * `POST /v1/lanes/{id}/fresh-start`): each of `ids` still blocked (the same obligation the caller cleaned up after)
 * becomes a new one (new id, its wait from now), the same old conversation to leave and note. Which were.
 */
export async function retryFreshStarts(ws: WorkspaceService, id: string, ids: ReadonlySet<string>, commit?: () => void): Promise<FreshStart[]> {
  let retried: FreshStart[] = []
  await mutate(ws, (lanes, checks) => {
    // A revocable caller's authority (HI-2420), checked again in the save.
    if (commit) checks.push(commit)
    retried = []
    const l = lanes.find((x) => x.id === id)
    if (!l || !running(l) || !l.freshStart) return
    l.freshStart = l.freshStart.map((f) => {
      if (!f.blocked || !ids.has(f.id)) return f
      retried.push(f)
      return { id: randomBytes(6).toString('hex'), agent: f.agent, role: f.role, since: new Date().toISOString(), oldSession: f.oldSession, ...(f.note ? { note: f.note } : {}) }
    })
  })
  return retried
}

/**
 * A running lane's fresh starts as kept, read synchronously (laneStarts.ts: as it decides, and just before a start): only
 * those whose agent still has that role in it (one reassigned meanwhile is no longer owed).
 */
export function freshStartsNow(ws: WorkspaceService, id: string): FreshStart[] {
  if (!ws.path) return []
  const rec = readLanes({ version: 1, lanes: readTable(ws.path, 'lanes').docs as Record<string, unknown>[] }).find((l) => l.id === id)
  return rec && running(rec) ? (rec.freshStart ?? []).filter((f) => (f.role === 'builder' ? rec.builder.id : rec.reviewer?.id) === f.agent) : []
}

/**
 * Whether lane `id` runs now, as kept, with `agent` in `role` (HI-2232, HR1's round 1: a renewal's launch checks it just
 * before the old conversation stops and again before the new one spawns). Read synchronously, as freshStartsNow is.
 */
export function laneRunsWith(ws: WorkspaceService, id: string, role: 'builder' | 'reviewer', agent: string): boolean {
  if (!ws.path) return false
  const rec = readLanes({ version: 1, lanes: readTable(ws.path, 'lanes').docs as Record<string, unknown>[] }).find((l) => l.id === id)
  return !!rec && running(rec) && (role === 'builder' ? rec.builder.id : rec.reviewer?.id) === agent
}

/** The lanes as kept (#1438's slot passes: their state, cards and builders, without reading the board). */
export async function rawLanes(ws: WorkspaceService): Promise<LaneRecord[]> {
  return ws.path ? read(ws) : []
}

/** The running lanes waiting for a slot, as kept (#1438). */
export async function lanesWaitingForSlot(ws: WorkspaceService): Promise<LaneRecord[]> {
  if (!ws.path) return []
  return (await read(ws)).filter((l) => running(l) && !!l.slotWait)
}

/**
 * A running lane's slot (#1438: slotCards.ts gives it; none, no slots): the one lent to the lane, else its builder's
 * carried slot (#1441), with what its row's hover tells (#1446).
 */
let slotOf: ((ws: WorkspaceService, lane: LaneRecord) => LaneSlotInfo | null) | null = null
export function setLaneSlots(fn: typeof slotOf): void {
  slotOf = fn
}

/** The free slot a lane waiting for one was last refused as held, and what holds it (HI-2466: slotCards.ts gives it), by workspace folder and lane. */
let slotHeldOf: (wsPath: string, lane: string) => LaneSlotHeld | null = () => null
export function setLaneSlotHeld(fn: typeof slotHeldOf | null): void {
  slotHeldOf = fn ?? (() => null)
}

/** A decision about a lane made on a read its cards have since moved on from (#1270): not saved; the lanes are read again. */
class StaleLane extends Error {}
/** The lanes themselves changed since they were read (readAs): read again at once. */
class StaleRead extends StaleLane {}

/** Where a lane's cards are now, as the board has committed them: a card archived, gone or in another project is gone. */
function placesOf(ws: WorkspaceService, l: LaneRecord, cards: readonly number[] = l.cards): string[] {
  const places = cardPlacesNow(ws, cards)
  return cards.map((n) => {
    const c = places.get(n)
    return !c || c.archived || !same(c.project, l.project) ? 'gone' : c.column
  })
}

/**
 * Checked under the board's lock (#1270): the lane still has no card of its own left to do (allDone: each Done, gone, or
 * held elsewhere, HI-3117, as stillBetweenCards reads an owner), else nothing is saved.
 */
const stillAllDone = (ws: WorkspaceService, l: LaneRecord, cards: readonly number[]) => (): void => {
  const places = placesOf(ws, l, cards)
  const owners = cardOwnersNow(ws, cards)
  // Given to another agent (allDone's givenAway): a card given to none stays the lane's to wait for (HI-3118).
  const others = (n: number): boolean => {
    const o = owners.get(n)
    return !!o?.agent && o.agent !== l.builder.id
  }
  if (!places.every((c, i) => c === 'done' || c === 'gone' || others(cards[i]))) throw new StaleLane(`lane ${l.id}: its cards moved on`) // i18n-ignore: internal, caught and retried (never shown)
}

/**
 * Checked under the board's lock (#1270): none of the lane's own cards is in flight now, else its queued list waits. A
 * card held elsewhere isn't the lane's (HI-1821, as its view reads it: another agent's, or given to none and another
 * lane's by cardOwnersNow).
 */
const stillBetweenCards = (ws: WorkspaceService, l: LaneRecord, cards: readonly number[]) => (): void => {
  if (ownInFlight(ws, l, cards)) throw new StaleLane(`lane ${l.id}: a card is in flight again`) // i18n-ignore: as above
}

/** Who reviews each card now, as the board has it (its review's agent; null: none), on one read (HI-3118). */
function reviewOwnersNow(ws: WorkspaceService, numbers: readonly number[]): Map<number, string | null> {
  if (!numbers.length) return new Map()
  return boardRead(ws, (db) => new Map((db.prepare(`SELECT number, review_agent FROM cards WHERE number IN (${numbers.map(() => '?').join(', ')})`).all(...numbers) as { number: number; review_agent: string | null }[]).map((r) => [r.number, r.review_agent]))) // i18n-ignore: SQL
}

/** Whether one of a lane's own cards (HI-1821: not another agent's or lane's) is in flight now: Doing, Review or Passed. */
function ownInFlight(ws: WorkspaceService, l: LaneRecord, cards: readonly number[]): boolean {
  const places = cardPlacesNow(ws, cards)
  const owners = cardOwnersNow(ws, cards)
  return cards.some((n) => {
    const c = places.get(n)
    const o = owners.get(n)
    const own = o?.agent ? o.agent === l.builder.id : !o?.lane || o.lane === l.id
    return !!c && !c.archived && same(c.project, l.project) && FLYING.has(c.column) && own
  })
}

/**
 * A running lane's list as its next start reads it (HI-3118): its queued list once none of its own cards is in flight
 * (the boundary has passed, so the queue applies at the next start), else its list. Read only: the queue stays queued
 * for its boundary writer (applyLaneList, the runtime's applyLaneBoundary).
 */
export function effectiveCards(ws: WorkspaceService, l: LaneRecord): number[] {
  return l.pending?.length && !ownInFlight(ws, l, l.cards) ? [...l.pending] : [...l.cards]
}

const FLYING: ReadonlySet<string> = new Set(['doing', 'review', 'passed'])

/** A lane's own cards in flight: started, not Done (in Doing, Review or Passed), and not another agent's (HI-1821). */
const flyingCards = (v: LaneInfo): number[] => v.cards.filter((c) => FLYING.has(c.column) && !c.elsewhere).map((c) => c.number)

/** A lane's card in flight, the first such in the lane's order; null: none. */
const inFlight = (v: LaneInfo): number | null => flyingCards(v)[0] ?? null

/**
 * How a lane's list change (`was` to `cards`) goes (#1270): `behind`, the card in flight it is queued after, or null when
 * it applies at once, and then `check`, the cards none of which may be in flight for its builder as it saves
 * (stillBetweenCards). A change that only takes cards out (the list as it was, less some, in its order) and keeps every
 * card in flight applies at once, checked against the cards it takes out (HI-1821: a card moved to another lane leaves
 * at once); any other waits for the lane's card in flight.
 */
function listChange(v: LaneInfo, was: readonly number[], cards: readonly number[]): { behind: number | null; check: number[] } {
  const flying = flyingCards(v)
  const removal = sameList(was.filter((n) => cards.includes(n)), cards)
  if (removal && flying.every((n) => cards.includes(n))) return { behind: null, check: was.filter((n) => !cards.includes(n)) }
  return { behind: flying[0] ?? null, check: [...was] }
}

/**
 * Gives a running lane a new list (`cards`), as Combwork owns it (#1270, §16.11.1): with the rules on, a change while a
 * card of it is in flight is queued for the next card boundary (`pending`), never refused; between cards it applies now,
 * checked as it saves (stillBetweenCards, pushed onto `checks`). With rules off, at once. Returns the card in flight it
 * was queued after, or null. The one place a lane's list changes for cw_lane start and the window's edits (HI-2898).
 */
export async function applyLaneList(ws: WorkspaceService, was: LaneRecord, cards: readonly number[], on: boolean, checks: (() => void)[]): Promise<number | null> {
  const change = on && !sameList(was.cards, cards) ? listChange((await views(ws, [was]))[0], was.cards, cards) : null
  if (change && change.behind !== null) {
    was.pending = [...cards]
    return change.behind
  }
  if (change) checks.push(stillBetweenCards(ws, was, change.check))
  was.cards = [...cards]
  delete was.pending
  return null
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((n, i) => n === b[i])

/**
 * The ruleset in force for a project now, stored, for a lane starting (#1270, §16.11.1: its cards, Todo ones too, keep
 * it until the lane ends); undefined while workflow rules aren't enforced, or when it can't be read (then its cards use
 * the current one, as before).
 */
async function rulesetNow(ws: WorkspaceService, project: string, target?: string | null): Promise<string | undefined> {
  if (!ws.path || !(await enforced())) return undefined
  try {
    const wf = await (await service()).workflowFor(ws, join(ws.path, project))
    // Merging into another branch (HI-2556): the rules now with G7 set to it, stored too.
    return wf
      ? await boardWrite(ws, async () => {
          const r = targetedOf(wf.currentRuleset(true), target)
          if (target) wf.store.saveRuleset(r)
          return r.id
        })
      : undefined
  } catch (e) {
    log.warn(`the ruleset for a lane of ${userText(project)}`, e)
    return undefined
  }
}

/**
 * What a lane that ended by its cards brought in (#1270, §16.8.2): each card's result revision from its `Integrated`
 * fact (null: Done with nothing merged, as under Not checked, or a card from before 1.0), and the last of them, the
 * lane's merge commit, never an agent's say-so.
 */
function resultsOf(ws: WorkspaceService, l: LaneRecord): { card: number; revision: string | null }[] {
  try {
    const store = FactStore.forBoard(ws, { project: l.project, key: l.project })
    return l.cards.map((n) => ({ card: n, revision: foldCard(store.facts(n)).integrated?.result ?? null }))
  } catch (e) {
    log.warn(`reading lane ${l.id}'s results`, e)
    return l.cards.map((n) => ({ card: n, revision: null }))
  }
}

/**
 * Ends a lane its cards finished (#1270): verified from the facts while rules are enforced, its merge commit the last
 * result; one given (`given`: the user's, the Assistant's or a script's, never an agent's) only when the facts name none.
 */
function endVerified(ws: WorkspaceService, l: LaneRecord, cards: readonly LaneCard[] | undefined, on: boolean, ended: EndedLane[], given: string | null = null): void {
  const results = resultsOf(ws, l)
  const last = [...results].reverse().find((r) => r.revision)?.revision ?? null
  close(l, 'ended', cards, on ? (last ?? given) : (given ?? l.mergeCommit))
  ended.push({ lane: l.id, project: l.project, results })
}

/** A lane that ended, for the verified lane-end event (#1270). */
interface EndedLane {
  lane: string
  project: string
  results: { card: number; revision: string | null }[]
}

/**
 * The verified lane-end event (#1270): once per lane, as it ends with its cards Done, with what each brought in. Code
 * that follows lanes listens for it (onCombworkEvent); the Agent API's event stream carries it.
 */
function tellEnded(ws: WorkspaceService, ended: readonly EndedLane[]): void {
  if (!ws.path) return
  for (const e of ended) ws.emit({ type: 'lane-ended', workspacePath: ws.path, lane: e.lane, project: e.project, results: e.results })
}

/** The builder is told a queued list change applied (#1270): its lane's cards now, in order. */
async function tellListChanged(ws: WorkspaceService, l: LaneRecord): Promise<void> {
  if (!ws.path) return
  const projectPath = join(ws.path, l.project)
  // Said in the builder's dialect: the delivery is for it alone.
  const body = inDialectOf({ projectPath, agentId: l.builder.id }, () => withCardNames(ws, () => say(A.listChanged, { cards: l.cards.map(cardRef).join(', ') })))
  try {
    // agent-protocol: the sender's name, Combwork's own
    await createDelivery(projectPath, { agentId: l.builder.id, agentName: l.builder.name, kind: 'rebrief', from: { kind: 'combwork', name: 'Combwork' }, body, source: 'lane', ref: l.id }) // i18n-ignore: the sender's name, Combwork's own
    await offerNow(projectPath, l.builder.id)
  } catch (e) {
    log.warn(`telling lane ${l.id}'s builder its list changed`, e)
  }
}

/** A project agent of the lane's project, by id: its name now. */
async function agentIn(ws: WorkspaceService, project: string, id: string): Promise<LaneAgent | null> {
  if (!ws.path) return null
  const cfg = await ws.projectConfig(join(ws.path, project)).catch(() => null)
  const a = cfg ? projectAgents(cfg).find((x) => x.id === id) : undefined
  return a ? { id: a.id, name: a.name } : null
}

/**
 * A generalist takes no side in the workflow (HI-686): never a lane's builder or reviewer, however the lane is started
 * or joined (the window's Start Lane, the Agent API, the cw_ tools). Refused before anything changes. `ids`: the
 * lane's builder, then its reviewer. Each part only for a role that does it (HI-2664: its tools follow its role, so a
 * builder named a lane's reviewer would have no cw_verdict), as Start Lane… offers them: a builder or either-role agent
 * builds, a reviewer or either-role agent reviews.
 */
async function refuseGeneralist(ws: WorkspaceService, project: string, ids: readonly (string | null | undefined)[]): Promise<void> {
  if (!ws.path) return
  const cfg = await ws.projectConfig(join(ws.path, project)).catch(() => null)
  for (const [i, id] of ids.entries()) {
    const a = id && cfg ? projectAgents(cfg).find((x) => x.id === id) : undefined
    const role = a ? agentWorkflowRole(a) : null
    if (a && role === 'generalist') throw new LaneError(400, say(A.generalist, { agent: a.name }))
    // Independent (HI-2670): no part in the workflow at all.
    if (a && role === 'independent') throw new LaneError(400, say(A.independent, { agent: a.name }))
    if (a && role && (i === 0 ? !buildsWork(role) : !reviewsWork(role))) throw new LaneError(400, say(A.wrongSide, { agent: a.name, part: i === 0 ? 'builder' : 'reviewer' }))
  }
}

/**
 * Whether an agent's running session has a lane part's tools (HI-2664): the session manager's (sessions.sideAllows), set
 * by launchSides.ts, as laneParts is the other way. Until set (unit tests of the lanes alone): every one has.
 */
let partToolsLoaded: (projectPath: string, agentId: string, part: 'builder' | 'reviewer') => boolean = () => true
export function setPartToolsCheck(f: typeof partToolsLoaded): void {
  partToolsLoaded = f
}

/**
 * An agent whose role changed while it ran and that hasn't restarted since keeps its old side's tools (HI-2664, HR3's
 * round 1): never given a lane part it can't do yet. Refused before anything changes, saying to restart it first.
 */
function refuseOldTools(ws: WorkspaceService, project: string, parts: readonly { agent: { id: string; name: string } | null | undefined; part: 'builder' | 'reviewer' }[]): void {
  if (!ws.path) return
  const projectPath = join(ws.path, project)
  for (const { agent, part } of parts) if (agent && !partToolsLoaded(projectPath, agent.id, part)) throw new LaneError(409, say(A.oldTools, { agent: agent.name }))
}

/**
 * A card in two lanes (HI-1821): the open cards (not Done, archived or gone) of a builder's start that another builder's
 * running lane of the project lists, or has in its queued list, as a warning for the start's reply; null: none. The
 * card's agent decides whose it is (a lane never takes another agent's card); a card leaves a lane by the Assistant's,
 * the user's or a script's start of it without the card, never its builder's own (HI-2169: that keeps every card).
 */
function sharedCards(ws: WorkspaceService, lanes: readonly LaneRecord[], project: string, builder: string, cards: readonly number[]): string | null {
  const others = lanes.filter((l) => running(l) && same(l.project, project) && l.builder.id !== builder)
  const listed = others.flatMap((l) => cards.filter((n) => l.cards.includes(n) || !!l.pending?.includes(n)).map((n) => ({ n, l })))
  if (!listed.length) return null
  const places = cardPlacesNow(ws, listed.map((x) => x.n))
  const shared = listed.filter(({ n, l }) => {
    const c = places.get(n)
    return !!c && !c.archived && same(c.project, l.project) && c.column !== 'done'
  })
  if (!shared.length) return null
  return withCardNames(ws, () => say(A.shared, { items: shared.map(({ n, l }) => say(A.sharedItem, { card: cardRef(n), builder: l.builder.name, lane: l.id })).join('; ') }))
}

export interface StartLane {
  project: string
  /** The builder's and reviewer's agent ids (reviewer null: none yet; undefined: keep a running lane's). */
  builder: string
  reviewer?: string | null
  /**
   * The reviewer the caller named that is no agent of the project (`reviewer` null): a new lane starts without one, but a
   * running lane's start is refused, naming its reviewer, never left without it (HI-2273).
   */
  unknownReviewer?: string
  /** Reviewed by the project's reviewer pool (#1443), with `reviewer` null; undefined: a running lane keeps what it has. */
  pool?: boolean
  cards: number[]
  rounds?: number
  waitMinutes?: number
  name?: string | null
  /** The builder's brief (HI-1795, nextBrief): undefined keeps a running lane's; '' clears it. */
  brief?: string
  /** The builder's conversation running as a new lane is started with a brief (outside slots, never offered into it). */
  briefNotIn?: string | null
  /** Who starts it, as the board names them. */
  by: string
  /**
   * A changed list for the builder's running lane applied now, not queued behind its card in flight (HI-1995): that card
   * put back when it isn't first any more, the new first card started next (reorderNow). Ignored with the rules off, or
   * when the change would apply at once anyway.
   */
  applyNow?: boolean
  /**
   * A new card placed on the builder's lane as it is made (HI-2167, cw_create_task's lane): the list is the running
   * lane's, as read under the lock (its queued list when it has one), with the card added last or `next` (before its first
   * card still in Todo); with no running lane, a new lane of the card alone, or refused when `needsLane`. `cards` is
   * ignored.
   */
  place?: LanePlace
  /**
   * The lane's own builder changes its running lane (HI-2169: a project agent's own cw_lane start, from the
   * authenticated caller, never the request): with the rules enforced, the cards of the lane's list (its queued one when
   * it has one) that the new list leaves out are kept, after the given ones. A builder adds and reorders cards; taking one
   * off is the Assistant's, the user's or a script's.
   */
  ownBuilder?: boolean
  /**
   * Its Merges into (HI-2556): one of the project's targets (null or the default: the project's own), fixed for the lane's
   * life; undefined keeps a running lane's. Never a builder's own start's (ownBuilder): the user's, the Assistant's or a
   * script's.
   */
  target?: string | null
  /**
   * A revocable caller's authority (HI-2420, the Assistant's guard): checked again in the lanes' save, with nothing
   * awaited before it, and as a reorder applied now puts its card back; once it no longer holds, nothing is saved.
   */
  commit?: () => void
}

/** Where a new card goes on its builder's lane (HI-2167). */
export interface LanePlace {
  card: number
  position?: 'last' | 'next'
  /** Placed only on a running lane (cw_create_task's lane: "<builder>"): never starts one. */
  needsLane?: boolean
}

/** How recently a card was made for cw_lane start to ask whether it is the one meant (HI-2167). */
export const FRESH_CARD_MS = 2 * 60_000

/**
 * cw_lane start's safety net (HI-2167): a card in its list made by someone else than the caller since the caller's turn
 * began (`since`), in the last FRESH_CARD_MS, may be a guessed key (a create batched with the start, another agent's card
 * taking the number); one made before the turn began is one the caller was told of. Null for none, and with no turn.
 * Only cards in the caller's `scope` (a project agent's project; null: the workspace) are read: one outside it is told as
 * one that doesn't exist, nothing of it named (HR3's HI-2167 round 1).
 */
export async function freshCardsNote(ws: WorkspaceService, cards: readonly number[], by: string, since: number | null, scope: string | null, at = Date.now()): Promise<string | null> {
  if (since === null) return null
  const board = await cardsNow(ws, cards)
  const fresh = cards.flatMap((n) => {
    const c = board.get(n)
    const made = c?.createdAt ? Date.parse(c.createdAt) : NaN
    return c && inScope(c, scope) && c.createdBy && c.createdBy !== by && made >= since && at - made >= 0 && at - made < FRESH_CARD_MS ? [{ n, ago: Math.max(1, Math.round((at - made) / 1000)), who: c.createdBy }] : []
  })
  if (!fresh.length) return null
  return withCardNames(ws, () => say(A.fresh, { items: fresh.map((f) => say(A.freshItem, { card: cardRef(f.n), ago: f.ago, who: f.who })).join('; ') }))
}

/** A lane's list with a new card placed on it (HI-2167): last, or before its first card still in Todo (`next`). */
async function placed(ws: WorkspaceService, was: LaneRecord | undefined, p: LanePlace): Promise<number[]> {
  const list = (was ? (was.pending ?? was.cards) : []).filter((n) => n !== p.card)
  if (p.position !== 'next') return [...list, p.card]
  const board = await cardsNow(ws, list)
  const at = list.findIndex((n) => {
    const c = board.get(n)
    return !!c && !c.archived && c.column === 'todo'
  })
  return at < 0 ? [...list, p.card] : [...list.slice(0, at), p.card, ...list.slice(at)]
}

/**
 * Starts a lane for a builder, or updates its running one: one running lane per builder. A running lane that shares a
 * card with the new list is the same loop (resumed, or changed: a card added, the order changed) and is updated in
 * place, keeping its reviewer unless one is given. One that shares none ends and a new lane starts: ended when it has
 * no card left to do (every one Passed, Done or gone: it waits only for its merge), else abandoned.
 */
/** A builder's statuses in a turn of its own: a reorder applied now never puts its card back under it (HI-1995). */
const IN_A_TURN: ReadonlySet<string> = new Set(['working', 'starting', 'waiting', 'background'])

/**
 * A changed list applied now (HI-1995, `applyNow`): when the builder's own card in flight would be queued behind (it is
 * no longer the new list's first own open card), checked here first and refused with why (409) while that card is in
 * Review, Approved or merging, its builder is in a turn or waits on a watch of other cards, or its folder has changes
 * not committed; then the runtime's reorder, one write (reorderLaneNow, through the card's intent path so the board
 * follows: put back, the list saved, the card to start next), checking the builder again there. A watch on that card
 * alone is ended once it is done (the reorder tells the builder instead). Null when there's nothing to apply now (no
 * card in flight, or it stays first): the start's own edit applies the list. Else what it did, for the reply.
 */
/**
 * A changed list applied now (HI-1995, `applyNow`; Darren's decision of 29 Oct: two steps Combwork already has): when the
 * builder's own card in flight is no longer the new list's first own open card, it is put back first, as `cw_put_back`
 * does (the runtime's put back, through the card's intent path: to Todo, its line and work kept); the start's own edit
 * then applies the list, at once now that no card of the lane is in flight (bound to this lane: one ended or changed in
 * between is refused there, nothing resumed or recreated). Refused here (409, nothing changed) while that card is in
 * Review, Approved or merging, its builder is in a turn, or its folder has changes not committed. Null: nothing to put
 * back (no card in flight, or it stays first): the edit runs as any other.
 */
async function putBackForReorder(ws: WorkspaceService, s: StartLane, builder: LaneAgent): Promise<{ lane: string; cards: number[]; pending: number[] | null; putBack: string; line: string | null } | null> {
  if (!ws.path) return null
  const projectPath = join(ws.path, s.project)
  const was = (await read(ws)).find((l) => running(l) && same(l.project, s.project) && l.builder.id === builder.id)
  if (!was) return null
  const v = (await views(ws, [was]))[0]
  const flying = v.cards.find((c) => ownOpen(c) && (c.column === 'doing' || c.column === 'review' || c.column === 'passed'))
  if (!flying) return null
  // The new first own open card, as the board has it now: whether the card in flight stays first.
  const cards = await cardsNow(ws, s.cards)
  const first = s.cards.find((n) => {
    const c = cards.get(n)
    return !!c && !c.archived && c.column !== 'done' && (!c.agent || c.agent === builder.id)
  })
  if (first === flying.number) return null
  const key = cards.get(flying.number)?.key ?? `#${flying.number}`
  if (flying.column !== 'doing') throw new LaneError(409, say(A.inReview, { card: key, where: flying.column === 'review' ? 'review' : 'other' }))
  const { sessions } = await import('./sessions')
  const st = sessions.liveFor(projectPath, builder.id)
  if (st && IN_A_TURN.has(st.status)) throw new LaneError(409, say(A.inATurn, { agent: builder.name, status: st.status }))
  const wf = await (await service()).workflowFor(ws, projectPath).catch(() => null)
  if (!wf) return null
  const state = wf.state(wf.store.card(flying.number))
  const folder = state.started?.folder
  if (folder && folder !== 'project') {
    const { gitCantRead, slotWorkspaces } = await import('./platform/workspacePorts')
    // A non-colocated jj slot (HI-2896): Git can't read it, and jj can't see unrecorded edits without a snapshot: kept.
    const d = (await gitCantRead(folder)) ? null : await slotWorkspaces().dirty(folder)
    if (!Array.isArray(d) || d.length) throw new LaneError(409, say(A.uncommitted, { card: key, agent: builder.name }))
  }
  const { runIntent, CW_LANE_START } = await import('./tasks')
  const { reply } = await runIntent(wf, flying.number, CW_LANE_START, (w) => w.putBack(`#${flying.number}`, 'combwork', { why: inDefaultDialect(() => say(A.putBackWhy, { by: s.by })) }), undefined, s.commit)
  const r = reply as { ok?: boolean; refused?: boolean; message?: string }
  // agent-protocol: a refusal's message, said again in the reader's dialect by refusalBody
  if (r.refused) throw new LaneError(409, (r.refused && typeof (reply as Refusal).rule === 'string' && (reply as Refusal).values ? (refusalBody(reply as Refusal).message as string) : r.message) ?? say(A.notPutBack, { card: key }))
  log.info(`Lane ${was.id}: #${flying.number} put back by a reorder applied now (${userText(s.by)})`)
  return { lane: was.id, cards: [...was.cards], pending: was.pending ? [...was.pending] : null, putBack: key, line: state.started?.line ?? null }
}

/** A lane's builder told of a reorder applied now (HI-1995): the card put back, the lane's cards now. */
async function tellReordered(ws: WorkspaceService, l: LaneRecord, put: { putBack: string; line: string | null }, by: string): Promise<void> {
  if (!ws.path) return
  const projectPath = join(ws.path, l.project)
  // Said in the builder's dialect: the delivery is for it alone.
  const body = inDialectOf({ projectPath, agentId: l.builder.id }, () => withCardNames(ws, () => say(A.reordered, { by, card: put.putBack, line: put.line ?? say(A.itsBranch), cards: l.cards.map(cardRef).join(', ') })))
  try {
    // agent-protocol: the sender's name, Combwork's own
    await createDelivery(projectPath, { agentId: l.builder.id, agentName: l.builder.name, kind: 'rebrief', from: { kind: 'combwork', name: 'Combwork' }, body, source: 'lane', ref: l.id }) // i18n-ignore: the sender's name, Combwork's own
    await offerNow(projectPath, l.builder.id)
  } catch (e) {
    log.warn(`telling lane ${l.id}'s builder of its reorder`, e)
  }
}

/** How recently a builder's lane ended for a new start to carry its brief and name (HI-2097). */
export const LANE_CARRY_MS = 10 * 60_000

/** The builder's lane that ended (all its cards merged) within LANE_CARRY_MS, the latest; never one abandoned. */
function justEnded(lanes: readonly LaneRecord[], project: string, builder: string): LaneRecord | undefined {
  const since = Date.now() - LANE_CARRY_MS
  return lanes
    .filter((l) => l.state === 'ended' && same(l.project, project) && l.builder.id === builder && !!l.endedAt && Date.parse(l.endedAt) >= since)
    .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!))[0]
}

/**
 * What a start that carried a just-ended lane's brief and name says (HI-2097), or null when it carried neither: only
 * what it carried, so not the name when the start gave its own (HI-2104).
 */
function carriedNote(builder: string, from: LaneRecord | null, ownName: boolean): string | null {
  const brief = !!from?.brief?.text
  const name = !!from?.name && !ownName
  if (!from || (!brief && !name)) return null
  return say(A.carriedBrief, { builder, lane: from.id, what: brief && name ? 'both' : brief ? 'brief' : 'name' })
}

/** HI-2944: a lane's target's folder with uncommitted changes, told to the window; the warning for the caller, or null. */
async function targetChangesWarning(ws: WorkspaceService, projectPath: string, target: string | null): Promise<string | null> {
  if (!target) return null
  const wf = await (await service()).workflowFor(ws, projectPath).catch(() => null)
  return wf ? wf.targetChangesWarning(target) : null
}

/** A project's targets (HI-2556), or null: not a Git project, or none readable. */
async function projectTargetsOf(ws: WorkspaceService, project: string): Promise<ProjectTargets | null> {
  return ws.path ? await projectTargets(ws, join(ws.path, project)).catch(() => null) : null
}

/** A project's own Merges into (HI-2556: its Work merges into), for a lane's target check (HI-2898's window edits); null: none. */
export async function laneDefaultTarget(ws: WorkspaceService, project: string): Promise<string | null> {
  return ws.path ? ((await projectTargetsOf(ws, project))?.default ?? null) : null
}

/** A lane's Merges into as a start names it (HI-2556): null for the project's own, else a branch it lists; refused otherwise. */
async function lanePick(ws: WorkspaceService, project: string, raw: unknown): Promise<string | null> {
  const t = await projectTargetsOf(ws, project)
  const p = pickTarget(t, raw)
  if ('target' in p) {
    // A listed branch work can start from now (HR2's round 1: listed is not made).
    const there = p.target && ws.path ? await branchExists(join(ws.path, project), p.target) : true
    if (there !== true) throw new LaneError(409, withValues(M.targetMissing, { target: p.target ?? '', unknown: there === 'unknown' ? 'yes' : 'no' })) // i18n-ignore: select keys
    return p.target
  }
  throw new LaneError(400, withValues(M.targetNotListed, { hasTargets: t ? 'yes' : 'no', target: typeof raw === 'string' ? raw.trim() : '', default: t?.default ?? '', hasOthers: t?.others.length ? 'yes' : 'no', others: fmt.list(t?.others ?? []) })) // i18n-ignore: select keys
}

/**
 * HI-2556: a lane is one target: refused when a card of `cards` has its own Merges into (the board's `target`) and it isn't
 * the lane's (`target`, null: the project's). Read under the lanes' lock, as the list is.
 */
export function refuseOtherTargets(ws: WorkspaceService, project: string, cards: readonly number[], target: string | null, def: string | null, scope: string | null): void {
  const store = FactStore.forBoard(ws, { project, key: '' })
  for (const n of cards) {
    let own: string | null = null
    try {
      own = store.card(n).target ?? null
    } catch {
      continue
    }
    // Its own target may name the project's own as itself (HI-2985: a forward's resolution, pinned): the same branch.
    if (own && own !== (target ?? def)) throw new LaneError(409, withCardNames(ws, () => withValues(M.targetCard, { card: cardRef(n), cardTarget: own, target: target ?? def ?? '' }), scope))
  }
}

/** The team paused (HI-2081, HR1's s8 check): no lane starts or changes its list until it resumes (Start Lane, the API). */
export function refuseWhileTeamPaused(ws: WorkspaceService): void {
  if (teamPauseOf(ws)) throw new LaneError(409, M.teamPaused)
}

/**
 * HI-2273: a start for the builder's running lane naming a reviewer that is no agent of the project, refused with the
 * lane's reviewer (a builder guessing a name dropped its lane's, and its failed round went unwatched).
 */
function unknownReviewerRefusal(name: string, project: string, lane: LaneRecord): never {
  throw new LaneError(404, lane.reviewer ? say(A.reviewerIs, { name, project, reviewer: lane.reviewer.name }) : say(lane.pool ? A.reviewerPool : A.reviewerNone, { name, project }))
}

export async function startLane(ws: WorkspaceService, s: StartLane): Promise<LaneChange> {
  refuseWhileTeamPaused(ws)
  // Its name as the reader keeps it (HI-3119): every way in (the window, cw_lane, the API) saves at most LANE_NAME_MAX.
  const named = laneName(s.name)
  const builder = await agentIn(ws, s.project, s.builder)
  if (!builder) throw new LaneError(404, say(A.unknownBuilder))
  const reviewer = s.reviewer ? await agentIn(ws, s.project, s.reviewer) : s.reviewer === undefined ? undefined : null
  if (s.reviewer && !reviewer) throw new LaneError(404, say(A.unknownReviewer))
  if (reviewer && reviewer.id === builder.id) throw new LaneError(400, say(A.selfReview))
  if (reviewer && s.pool) throw new LaneError(400, say(A.poolReviewer))
  await refuseGeneralist(ws, s.project, [builder.id, reviewer?.id])
  refuseOldTools(ws, s.project, [{ agent: builder, part: 'builder' }, { agent: reviewer, part: 'reviewer' }])
  // A named reviewer makes it one reviewer per lane; the pool, none of its own (#1443).
  const pool = s.pool ? true : reviewer ? false : undefined
  // Rounds and wait the start doesn't give (#412): the project's workflow options as they resolve now (HI-1766).
  const projectPath = ws.path ? join(ws.path, s.project) : s.project
  const laneCfg = ws.path ? await ws.projectConfig(projectPath).catch(() => null) : null
  const prefs = projectPreferences(ws, projectPath, laneCfg)
  // The platform fence (HI-2799): a new lane is an admission on its project's repository, refused while it switches.
  const admission = { id: projectIdOf(laneCfg, projectPath), platform: platformIdOf(projectPath, laneCfg?.platform) }
  const defaults = { rounds: prefs.loopRounds, waitHours: prefs.loopWaitHours }
  const on = await enforced()
  // The texts for the caller name cards as it may see them (HR3's HI-2169 round 1): a builder's own start is a project
  // agent's, whose project's cards alone are named by key; another's by number, as for a card that doesn't exist.
  const scope = s.ownBuilder ? s.project : null
  // A changed list applied now (HI-1995): its card in flight put back first; the edit below then applies the list at
  // once (between cards), bound to that lane.
  // HI-2273: never with a reviewer that is no agent: a running lane's start is then refused (under the lock below), and a
  // new lane has nothing to put back, so whatever lane a start meanwhile makes, nothing is put back before the refusal.
  // Its Merges into (HI-2556), checked as the start is asked: one of the project's targets, set by the user, the
  // Assistant or a script, never the lane's own builder; recorded in the lane's ruleset, so only with the rules on.
  // Checked before anything changes (HR2's round 1: a refused target never leaves a card put back), and again under the
  // lanes' lock below, as the list is saved.
  const pick = s.target === undefined ? undefined : await lanePick(ws, s.project, s.target)
  if (pick && s.ownBuilder) throw new LaneError(403, M.targetBuilder)
  if (pick && !on) throw new LaneError(409, M.targetRulesOff)
  const defaultTarget = ws.path ? ((await projectTargetsOf(ws, s.project))?.default ?? null) : null
  if (ws.path) {
    const running0 = (await read(ws)).find((l) => running(l) && same(l.project, s.project) && l.builder.id === builder.id)
    const target0 = running0?.ruleset ? targetOfRulesetId(running0.ruleset) : null
    if (running0 && on && pick !== undefined && (pick ?? null) !== target0) throw new LaneError(409, withValues(M.targetFixed, { builder: running0.builder.name, target: target0 ?? defaultTarget ?? '' }))
    refuseOtherTargets(ws, s.project, s.cards, running0 && on ? target0 : (pick ?? null), defaultTarget, s.ownBuilder ? s.project : null)
  }
  const put = s.applyNow && on && s.unknownReviewer === undefined ? await putBackForReorder(ws, s, builder) : null
  const ruleset = await rulesetNow(ws, s.project, pick)
  const ended: EndedLane[] = []
  let queuedAfter: number | null = null
  let shared: string | null = null
  let carried: LaneRecord | null = null
  let leftOut: number[] = []
  let kept: number[] = []
  // One decision a save (HR6's #1270 round 2): a change applied at once is saved only while none of the lane's cards is
  // in flight, checked under the board's lock; a card started meanwhile makes it decide again, and queue it.
  const decide = () => mutate(ws, async (lanes, checks, also) => {
    if (s.commit) checks.push(s.commit)
    // HI-2680: the picked branch read again under the lanes' lock, against the options as they are now: a removal from
    // the project's targets that came first refuses this start (`withLanesLock`).
    if (pick) await lanePick(ws, s.project, pick)
    queuedAfter = null
    ended.length = 0
    carried = null
    leftOut = []
    kept = []
    // After a put back for a reorder applied now (HI-1995), only the lane it was for, as it was then: ended or changed in
    // between, refused with why, nothing resumed or recreated (Darren's decision).
    const bound = put ? lanes.find((l) => l.id === put.lane) : undefined
    if (put && (!bound || !running(bound))) throw new LaneError(409, say(A.endedMeanwhile, { card: put.putBack }))
    if (put && bound && (!sameList(bound.cards, put.cards) || !sameList(bound.pending ?? [], put.pending ?? []))) throw new LaneError(409, say(A.changedMeanwhile, { card: put.putBack }))
    const was = bound ?? lanes.find((l) => running(l) && same(l.project, s.project) && l.builder.id === builder.id)
    if (was && s.unknownReviewer !== undefined) unknownReviewerRefusal(s.unknownReviewer, s.project, was)
    // A new card placed on the lane (HI-2167): its list as it is under this lock, so a change made meanwhile is kept.
    if (s.place?.needsLane && !was) throw new LaneError(409, say(A.noLaneToPlace, { builder: builder.name, project: s.project }))
    const given = s.place ? await placed(ws, was, s.place) : s.cards
    // A builder's own start never takes a card off its lane (HI-2169: HB6's registration with its first card alone cut
    // the Assistant's second one, and the lane ended after the first merged); as read under this lock.
    const prev = was && on && s.ownBuilder ? (was.pending ?? was.cards) : []
    kept = prev.filter((n) => !given.includes(n))
    const cards = kept.length ? [...given, ...kept] : given
    // HI-2556: a running lane's Merges into is fixed for its life, and a lane is one target: a card of its own other target
    // is refused into it.
    const wasTarget = was?.ruleset ? targetOfRulesetId(was.ruleset) : null
    if (was && pick !== undefined && (pick ?? null) !== wasTarget) throw new LaneError(409, withValues(M.targetFixed, { builder: was.builder.name, target: wasTarget ?? defaultTarget ?? '' }))
    refuseOtherTargets(ws, s.project, cards, was ? wasTarget : (pick ?? null), defaultTarget, scope)
    shared = sharedCards(ws, lanes, s.project, builder.id, cards)
    // As it was under this lock, for the Assistant's change (#1282): recorded with the save, in its transaction.
    const before = was ? laneValues(was) : null
    const t = now()
    // With rules on, any new list for the builder's running lane is an edit of that lane (HR6's #1270 round 1), so a card
    // in flight is never left behind; with them off, a list sharing no card is another loop, as before 1.0.
    if (was && (was.cards.some((n) => cards.includes(n)) || on)) {
      // Combwork owns the list (#1270, §16.11.1): a change while a card is in flight is queued for the next card boundary,
      // never refused; between cards it applies now. With rules off, at once, as before.
      queuedAfter = await applyLaneList(ws, was, cards, on, checks)
      Object.assign(was, {
        builder,
        ...(reviewer !== undefined ? { reviewer } : {}),
        ...(s.rounds !== undefined ? { rounds: s.rounds } : {}),
        ...(s.waitMinutes !== undefined ? { waitMinutes: s.waitMinutes } : {}),
        ...(named !== null ? { name: named } : {}),
        updatedAt: t
      })
      // Its brief under the same lock (HI-1795): kept unless the start gives one; a queued list change keeps it too.
      // An edit of a running lane: its working conversation is never excluded (only a new lane's earlier one is).
      const brief = nextBrief(was.brief, s.brief)
      if (brief) was.brief = brief
      if (pool) {
        was.pool = true
        was.reviewer = null
      } else if (pool === false) delete was.pool
      also.push((db) => noteLaneIn(db, ws.path!, before, was))
      return { rec: was, did: 'updated' as const, replaced: null }
    }
    let replaced: LaneRecord | null = null
    if (was) {
      const v = (await views(ws, [was]))[0]
      if (v.current === null && allDone(v.cards)) endVerified(ws, was, v.cards, on, ended)
      else close(was, v.current === null ? 'ended' : 'abandoned', v.cards)
      replaced = was
    }
    // A list change that raced its lane's end (HI-2097): the builder's lane ended just now, so this start is a new lane.
    // Given no brief, it carries that lane's brief and name; a card already Done is left out of the new list.
    const just = was ? undefined : justEnded(lanes, s.project, builder.id)
    carried = just && s.brief === undefined ? just : null
    const board = await cardsNow(ws, cards)
    const done = cards.filter((n) => board.get(n)?.column === 'done')
    if (done.length && done.length === cards.length) throw new LaneError(409, withCardNames(ws, () => say(A.allDoneNoLane, { cards: done.map(cardRef).join(', '), n: done.length }), scope))
    leftOut = done
    const rec: LaneRecord = {
      id: newId(),
      project: s.project,
      name: named ?? carried?.name ?? null,
      builder,
      reviewer: reviewer ?? null,
      cards: cards.filter((n) => !done.includes(n)),
      rounds: s.rounds ?? defaults.rounds,
      waitMinutes: s.waitMinutes ?? defaults.waitHours * 60,
      state: 'active',
      startedBy: s.by,
      startedAt: t,
      updatedAt: t,
      endedAt: null,
      mergeCommit: null,
      ...(ruleset ? { ruleset } : {}),
      ...(pool ? { pool: true as const } : {})
    }
    const brief = nextBrief(undefined, carried?.brief?.text ?? s.brief, s.briefNotIn)
    if (brief) rec.brief = brief
    lanes.push(rec)
    also.push((db) => admitOrThrow(db, admission.id, admission.platform))
    also.push((db) => noteLaneIn(db, ws.path!, null, rec))
    return { rec, did: 'started' as const, replaced }
  })
  let r: Awaited<ReturnType<typeof decide>> | null = null
  for (let attempt = 0; !r; attempt++) {
    queuedAfter = null
    ended.length = 0
    try {
      r = await decide()
    } catch (e) {
      // A card of the lane started between the read and the save: decided again from the board as it is now.
      if (!(e instanceof StaleLane) || attempt >= 4) throw e instanceof StaleLane ? new LaneError(409, say(A.keptChanging)) : e
    }
  }
  const [lane, replaced] = await views(ws, [r.rec, ...(r.replaced ? [r.replaced] : [])])
  log.info(`Lane ${r.rec.id} ${r.did} for ${userText(builder.name)} in ${userText(s.project)}: ${(r.rec.pending ?? r.rec.cards).map((n) => `#${n}`).join(', ')}`)
  if (r.replaced) laneFact(ws, r.replaced)
  if (r.did === 'started') laneFact(ws, r.rec)
  tellEnded(ws, ended)
  const queued = queuedAfter !== null ? withCardNames(ws, () => say(A.queued, { card: cardRef(queuedAfter!) }), scope) : null
  // The builder told of a reorder applied now, once its list is saved (HI-1995).
  if (put) await tellReordered(ws, r.rec, put, s.by)
  const applied = put ? say(A.applied, { card: put.putBack, line: put.line ?? say(A.itsBranch), builder: builder.name }) : null
  const carriedText = carriedNote(builder.name, carried, s.name != null)
  const gone = leftOut.length ? withCardNames(ws, () => say(A.leftOut, { cards: leftOut.map(cardRef).join(', '), n: leftOut.length }), scope) : null
  const stays = kept.length ? withCardNames(ws, () => say(A.stays, { cards: kept.map(cardRef).join(', '), n: kept.length }), scope) : null
  // HI-2944: the folder its target is checked out in has uncommitted changes: said before its first card starts.
  const dirty = r.did === 'started' && ws.path ? await targetChangesWarning(ws, join(ws.path, s.project), (r.rec.ruleset ? targetOfRulesetId(r.rec.ruleset) : null) ?? defaultTarget) : null
  const note = [applied, carriedText, gone, stays, queued, shared, dirty].filter(Boolean).join(' ') || undefined
  return { lane, did: r.did, replaced: replaced ?? null, ...(note ? { note } : {}) }
}

/**
 * A reviewer joins the builder's running lane: with `cards`, only one that shares a card with them (a builder's earlier
 * lane, its cards passed and waiting for the merge, is another loop). With no such lane yet (the reviewer started
 * first), one is started from `cards` as the builder's start would (ending that earlier lane), which the builder's own
 * start then updates.
 */
/** `commit`: a revocable caller's authority (HI-2420), checked again in the lanes' save (as startLane's). */
export async function joinLane(ws: WorkspaceService, j: { project: string; builder: string; reviewer: string; cards?: number[]; by: string; commit?: () => void }): Promise<LaneChange> {
  const reviewer = await agentIn(ws, j.project, j.reviewer)
  const builder = await agentIn(ws, j.project, j.builder)
  if (!reviewer || !builder) throw new LaneError(404, say(A.unknownPair))
  if (reviewer.id === builder.id) throw new LaneError(400, say(A.selfReview))
  await refuseGeneralist(ws, j.project, [builder.id, reviewer.id])
  refuseOldTools(ws, j.project, [{ agent: reviewer, part: 'reviewer' }])
  const found = await mutate(ws, (lanes, checks, also) => {
    if (j.commit) checks.push(j.commit)
    const l = lanes.find((x) => running(x) && same(x.project, j.project) && x.builder.id === builder.id)
    if (!l || (j.cards?.length && !l.cards.some((n) => j.cards!.includes(n)))) return null
    // Reviewed by the pool (#1443): nobody joins it; each card's assignment is its reviewer's start.
    if (l.pool) throw new LaneError(409, say(A.joinPool, { builder: builder.name }))
    const before = laneValues(l)
    l.reviewer = reviewer
    l.updatedAt = now()
    also.push((db) => noteLaneIn(db, ws.path!, before, l))
    return l
  })
  if (found) {
    log.info(`${userText(reviewer.name)} joined lane ${found.id}`)
    return { lane: (await views(ws, [found]))[0], did: 'joined' }
  }
  if (!j.cards?.length) throw new LaneError(404, say(A.joinNoLane, { builder: builder.name }))
  const r = await startLane(ws, { project: j.project, builder: builder.id, reviewer: reviewer.id, cards: j.cards, by: j.by, ...(j.commit ? { commit: j.commit } : {}) })
  return { ...r, did: 'joined', note: say(A.joinedFirst, { builder: builder.name }) }
}

/** A database writer, as a lane's save gives one to the writes that go with it. */
type Writer = ReturnType<typeof workspaceDb>['writer']

/** An undo found a lane's fields changed since (or the lane ended or gone), checked under the lanes' lock: nothing saved. */
export class LaneChangedSince extends Error {
  constructor(
    public fields: string[],
    public why: 'changed' | 'ended' | 'gone'
  ) {
    super(`lane ${why}: ${fields.join(', ')}`) // i18n-ignore: an internal signal, never shown
  }
}

/**
 * Undo of the Assistant's change of a running lane (#1282): each field back to what it was, only while every one still
 * holds what the change wrote, checked under the lanes' lock (with `guard`, the undo's own permission, just before the
 * save). A list goes back as any list change does (queued while a card is in flight); a reviewer or name back to none
 * too. Throws LaneChangedSince (nothing saved) otherwise. Returns its record's values as saved.
 */
export async function restoreLane(ws: WorkspaceService, id: string, back: readonly FieldChange[], by: string, guard?: () => void): Promise<Record<string, unknown>> {
  const on = await enforced()
  const saved = await mutate(ws, async (lanes, checks) => {
    const l = lanes.find((x) => x.id === id)
    if (!l) throw new LaneChangedSince(back.map((v) => v.field), 'gone')
    if (!running(l)) throw new LaneChangedSince(back.map((v) => v.field), 'ended')
    const cur = laneValues(l)
    const moved = back.filter((v) => !sameValue(cur[v.field], v.new)).map((v) => v.field)
    if (moved.length) throw new LaneChangedSince(moved, 'changed')
    for (const v of back) {
      if (v.field === 'cards') {
        const cards = v.old as number[]
        if (sameList(l.cards, cards)) delete l.pending
        else {
          const change = on ? listChange((await views(ws, [l]))[0], l.cards, cards) : null
          if (change && change.behind !== null) l.pending = [...cards]
          else {
            if (change) checks.push(stillBetweenCards(ws, l, change.check))
            l.cards = [...cards]
            delete l.pending
          }
        }
      } else if (v.field === 'reviewer') {
        const reviewer = typeof v.old === 'string' ? await agentIn(ws, l.project, v.old) : null
        if (typeof v.old === 'string' && !reviewer) throw new LaneChangedSince(['reviewer'], 'gone')
        l.reviewer = reviewer
      } else if (v.field === 'rounds' && typeof v.old === 'number') l.rounds = v.old
      else if (v.field === 'waitMinutes' && typeof v.old === 'number') l.waitMinutes = v.old
      else if (v.field === 'name') l.name = typeof v.old === 'string' ? v.old : null
    }
    l.updatedAt = now()
    if (guard) checks.push(guard)
    // What it saves, as read here under the lock: what the undo reports.
    return laneValues(l)
  })
  log.info(`Lane ${id}: ${back.map((v) => v.field).join(', ')} set back (${userText(by)}'s undo)`)
  return saved
}

/**
 * Undo of a lane the Assistant started (#1282): abandoned while it runs with its record as the start left it (`expect`,
 * field by field), checked under the lanes' lock with `guard` just before the save. Throws LaneChangedSince otherwise.
 */
export async function abandonLaneIf(ws: WorkspaceService, id: string, expect: Record<string, unknown>, guard?: () => void): Promise<void> {
  const rec = await mutate(ws, async (lanes, checks) => {
    const l = lanes.find((x) => x.id === id)
    if (!l) throw new LaneChangedSince(['created'], 'gone')
    if (!running(l)) throw new LaneChangedSince(['created'], 'ended')
    const cur = laneValues(l)
    const moved = Object.keys(expect).filter((k) => !sameValue(cur[k], expect[k]))
    if (moved.length) throw new LaneChangedSince(moved, 'changed')
    close(l, 'abandoned', (await views(ws, [l]))[0].cards)
    if (guard) checks.push(guard)
    return l
  })
  log.info(`Lane ${id} abandoned (an undo)`)
  laneFact(ws, rec)
}

/**
 * Ends a lane (its builder after the merge, the Assistant, the user): ended, with the merge commit if given, unless
 * `abandoned`. `agent`: a project agent ending it, which must be its builder or reviewer.
 */
/** `commit`: a revocable caller's authority (HI-2420), checked again in the lanes' save (as startLane's). */
export async function endLane(ws: WorkspaceService, id: string, o: { abandoned?: boolean; mergeCommit?: string | null; project?: string; agent?: string; commit?: () => void }): Promise<LaneInfo> {
  let ended = false
  const on = await enforced()
  const verified: EndedLane[] = []
  const rec = await mutate(ws, async (lanes, checks) => {
    if (o.commit) checks.push(o.commit)
    ended = false
    verified.length = 0
    const l = lanes.find((x) => x.id === id && (!o.project || same(x.project, o.project)))
    if (!l) throw new LaneError(404, withValues(M.unknown, { id }))
    if (o.agent && l.builder.id !== o.agent && l.reviewer?.id !== o.agent) throw new LaneError(403, say(A.endNotOurs))
    if (running(l)) {
      const v = (await views(ws, [l]))[0]
      // HI-3118: its cards as its next start reads them, a queued list included once its boundary has passed (read
      // here, never applied: refused, the queue stays for its own writer; ended, it was all Done anyway).
      const list = effectiveCards(ws, l)
      const queued = !sameList(list, l.cards)
      const ev = queued ? (await views(ws, [{ ...l, cards: list, pending: undefined }]))[0] : v
      // Combwork owns the lane (#1270, §16.8.2): with rules enforced, an agent ends it only once its cards are all Done,
      // and only the user and the Assistant abandon it; its merge commit is the cards' facts', not the agent's say-so.
      if (on && o.agent && o.abandoned) throw new LaneError(403, say(A.abandonNotOurs))
      if (on && o.agent && !allDone(ev.cards)) throw new LaneError(409, withCardNames(ws, () => say(A.endNotDone, { cards: ev.cards.filter((c) => c.column !== 'done' && c.column !== 'gone' && !c.givenAway).map((c) => cardRef(c.number)).join(', ') })))
      // An agent's say-so isn't a merge (§16.8.2): the user's, the Assistant's or a script's is kept where facts name none.
      const given = on && o.agent ? null : (o.mergeCommit ?? null)
      if (!o.abandoned && allDone(ev.cards)) {
        checks.push(stillAllDone(ws, l, list))
        // Ended on its queued list (every card of it Done): that list is the one it ends with.
        if (queued) {
          l.cards = list
          delete l.pending
        }
        endVerified(ws, l, ev.cards, on, verified, given)
      }
      else close(l, o.abandoned ? 'abandoned' : 'ended', v.cards, given)
      ended = true
    } else if ((!on || !o.agent) && o.mergeCommit && !l.mergeCommit) {
      l.mergeCommit = o.mergeCommit
      ended = true
    }
    return l
  }).catch((e) => {
    // Its cards moved on between the read and the save (a card reopened): nothing was saved.
    throw e instanceof StaleLane ? new LaneError(409, say(A.movedOn)) : e
  })
  log.info(`Lane ${id} ${rec.state}`)
  if (ended) laneFact(ws, rec)
  tellEnded(ws, verified)
  return (await views(ws, [rec]))[0]
}

/**
 * The next card of an agent's running lane (#1270, `cw_lane next`): the card to start, the one in flight to carry on,
 * or why the lane waits (a card passed but not merged: one card at a time, §16.11.2); none once every card is Done.
 */
export async function laneNext(ws: WorkspaceService, project: string, agentId: string): Promise<{ lane: LaneInfo; next: { card: number; title: string; carryOn: boolean } | null; waits: LaneInfo['status']; review?: { card: number; title: string } | null }> {
  // An agent that reviews lanes and builds none (HI-3118): a reviewer's answer, the first card of its lanes (in their
  // order) waiting in Review, or none; never a builder's next card. One that builds a lane gets that lane, as before.
  const runningHere = (await read(ws)).filter((l) => running(l) && same(l.project, project))
  if (!runningHere.some((l) => l.builder.id === agentId)) {
    const reviews = runningHere.filter((l) => l.reviewer?.id === agentId)
    if (reviews.length) {
      const vs = await views(ws, reviews)
      // Who reviews each card in Review now (its review's agent on the board): one another agent holds is theirs (HR2's
      // round 1), never offered; one already the caller's first (it carries on with it), else the first free one.
      const inReview = vs.flatMap((v) => v.cards.filter((x) => x.column === 'review' && !x.elsewhere).map((x) => x.number))
      const owners = reviewOwnersNow(ws, inReview)
      for (const holder of [agentId, null])
        for (const v of vs) {
          const c = v.cards.find((x) => x.column === 'review' && !x.elsewhere && (owners.get(x.number) ?? null) === holder)
          if (c) return { lane: v, next: null, waits: null, review: { card: c.number, title: c.title } }
        }
      return { lane: vs[0], next: null, waits: null, review: null }
    }
  }
  const lane = await laneOf(ws, project, agentId)
  if (!lane) {
    // HI-2273: its lane just ended (all its cards Done) or was abandoned: said so, never "start one", which invited a
    // builder to start its lane again with a guessed reviewer.
    const gone = (await read(ws))
      .filter((l) => !running(l) && same(l.project, project) && (l.builder.id === agentId || l.reviewer?.id === agentId) && !!l.endedAt && Date.parse(l.endedAt) >= Date.now() - LANE_CARRY_MS)
      .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!))[0]
    // HI-3118: "all its cards are Done" only when they were: its kept snapshot, or, with none (the runtime's own end, as
    // its last card finished), its cards' places on the board now; ended with cards open (the user's End), which; a
    // place unrecorded or unreadable, nothing claimed.
    if (gone?.state === 'ended') {
      let columns: { number: number; column: string }[] | null = gone.frozen ?? null
      if (!columns) {
        try {
          const places = placesOf(ws, gone, gone.cards)
          columns = gone.cards.map((n, i) => ({ number: n, column: places[i] }))
        } catch {
          columns = null
        }
      }
      if (!columns || columns.some((c) => c.column === 'unrecorded')) throw new LaneError(404, say(A.nextEndedUnknown, { lane: gone.id }))
      const open = columns.filter((c) => c.column !== 'done' && c.column !== 'gone')
      if (open.length) throw new LaneError(404, withCardNames(ws, () => say(A.nextEndedOpen, { lane: gone.id, cards: open.map((c) => cardRef(c.number)).join(', '), n: open.length })))
      throw new LaneError(404, say(A.nextEnded, { lane: gone.id }))
    }
    if (gone) throw new LaneError(404, say(A.nextAbandoned, { lane: gone.id }))
    throw new LaneError(404, say(A.nextNone))
  }
  // Its queued list once the boundary has passed (HI-3118: no card of its own in flight), as the next start reads it.
  const rec = (await read(ws)).find((x) => x.id === lane.id)
  const list = rec ? effectiveCards(ws, rec) : null
  const eff = rec && list && !sameList(list, rec.cards) ? (await views(ws, [{ ...rec, cards: list, pending: undefined }]))[0] : lane
  // Another agent's card is never the lane's next (HI-1821).
  const open = eff.cards.filter(ownOpen)
  const pauses = lane.state === 'paused' ? lane.status : null
  if (pauses) return { lane, next: null, waits: pauses }
  const flying = open.find((c) => c.column === 'doing' || c.column === 'review')
  if (flying) return { lane, next: { card: flying.number, title: flying.title, carryOn: true }, waits: lane.status }
  const todo = open.find((c) => c.column === 'todo')
  return { lane, next: todo ? { card: todo.number, title: todo.title, carryOn: false } : null, waits: lane.status }
}

/**
 * A running lane as it reads now, without waiting (HI-1990): `laneView` itself, the window's and `cw_lane`'s reading,
 * from the same inputs read synchronously (its record, its cards' rows, their facts while the rules are enforced, the
 * round limit, its agents' hooks, its slot, its line, the cards' owners), so it pauses for what the lane view pauses for
 * (a request for the user, a block, a merge, a slot…). Only the names it shows aren't read (agents' new names, the old
 * rules mark): nothing that decides whether it waits. With a list change queued, its cards are that list, which applies
 * once no card is in flight. Read inside a write's transaction it is what that write sees, so a check there can't be
 * undone by a lane or card change. By its id, or the builder's lane holding `card`. `as`: a card as the caller has it
 * (a start's write moves its card in the same transaction: the lane is read as it stood for that start). Null: no such
 * running lane.
 */
export function laneNow(ws: WorkspaceService, by: { lane: string } | { card: number; builder: string }, as?: TaskCard): LaneInfo | null {
  if (!ws.path) return null
  const recs = readLanes({ version: 1, lanes: readTable(ws.path, 'lanes').docs as Record<string, unknown>[] }).filter(running)
  const rec = 'lane' in by ? recs.find((l) => l.id === by.lane) : recs.find((l) => l.builder.id === by.builder && (l.cards.includes(by.card) || !!l.pending?.includes(by.card)))
  if (!rec) return null
  const l: LaneRecord = rec.pending?.length ? { ...rec, cards: rec.pending } : rec
  const on = rulesEnforced()
  const cards = boardRead(ws, (db) => {
    // i18n-ignore: SQL, not text
    const rows = db.prepare(`SELECT number, title, project, col, agent, blocked, archived, review_agent FROM cards WHERE number IN (${l.cards.map(() => '?').join(',')})`).all(...l.cards) as { number: number; title: string; project: string; col: TaskCard['column']; agent: string | null; blocked: string | null; archived: number; review_agent: string | null }[]
    // As cardsOf has them: archived or another project's, gone. Only what laneCard reads of a card (its rounds aside).
    return new Map(l.cards.map((n) => {
      if (as?.number === n) return [n, !as.archived && inScope(as, l.project) ? as : null]
      const r = rows.find((x) => x.number === n)
      return [n, r && !r.archived && inScope({ project: r.project }, l.project) ? ({ number: n, title: r.title, project: r.project, column: r.col, agent: r.agent, blocked: r.blocked, review: r.review_agent ? { agent: r.review_agent } : null, history: [] } as unknown as TaskCard) : null]
    }))
  })
  const facts = on ? new Map(l.cards.map((n) => [n, cardFactsOf(FactStore.forBoard(ws, { project: l.project, key: l.project }), n)])) : null
  const atLimit = on ? roundLimitCards(ws, l.cards) : new Set<number>()
  const deaf = new Set([l.builder, l.reviewer].filter((a): a is LaneAgent => !!a && hooksMissingFor(join(ws.path!, l.project), a.id)).map((a) => a.id))
  const owners = new Map([...cardOwnersNow(ws, l.cards)].map(([n, o]) => [n, o.lane]))
  return laneView(l, cards, undefined, facts, atLimit, on ? lineWaiting(ws, l.id) : null, deaf, undefined, null, slotView(ws, l), owners, null, !!teamPauseOf(ws), null, outOfWorkflow(ws, l), offSideOf(ws, l))
}

/** The running lane of a project agent (as builder, else as reviewer), or null. */
export async function laneOf(ws: WorkspaceService, project: string, agentId: string): Promise<LaneInfo | null> {
  const lanes = (await read(ws)).filter((l) => running(l) && same(l.project, project))
  const l = lanes.find((x) => x.builder.id === agentId) ?? lanes.find((x) => x.reviewer?.id === agentId)
  return l ? (await views(ws, [l]))[0] : null
}

/** A project agent's parts in its project's running lanes (HI-2049): builder of one, reviewer of another, or none. */
export async function laneParts(ws: WorkspaceService, project: string, agentId: string): Promise<('builder' | 'reviewer')[]> {
  const lanes = (await read(ws)).filter((l) => running(l) && same(l.project, project))
  return [...(lanes.some((l) => l.builder.id === agentId) ? ['builder' as const] : []), ...(lanes.some((l) => l.reviewer?.id === agentId) ? ['reviewer' as const] : [])]
}

/**
 * The running lanes holding any of `cards` (their list, or one queued to apply), each with its builder's name and the
 * cards of `cards` it holds (HI-2267: a reply about a lane's card says whose lane it is, as the lane keeps its own order).
 */
export async function lanesHolding(ws: WorkspaceService, cards: readonly number[]): Promise<{ id: string; builder: string; cards: number[] }[]> {
  if (!ws.path || !cards.length) return []
  return (await read(ws))
    .filter(running)
    .map((l) => ({ id: l.id, builder: l.builder.name, cards: cards.filter((n) => l.cards.includes(n) || !!l.pending?.includes(n)) }))
    .filter((l) => l.cards.length > 0)
}

/**
 * HI-2556: the running lanes holding any of `cards`, each with its builder's name and its Merges into: the target its
 * recorded ruleset marks (`targetOfRulesetId`), null for the project's own.
 */
export async function laneTargetsHolding(ws: WorkspaceService, cards: readonly number[]): Promise<{ id: string; builder: string; target: string | null }[]> {
  if (!ws.path || !cards.length) return []
  return (await read(ws))
    .filter((l) => running(l) && cards.some((n) => l.cards.includes(n) || !!l.pending?.includes(n)))
    .map((l) => ({ id: l.id, builder: l.builder.name, target: l.ruleset ? targetOfRulesetId(l.ruleset) : null }))
}

/** A workspace's lanes: those listed (running, or ended lately), or with `all` every one kept; `project` narrows them. */
export async function listLanes(ws: WorkspaceService, o: { project?: string | null; all?: boolean } = {}): Promise<LaneInfo[]> {
  if (!ws.path) return []
  const lanes = (await read(ws)).filter((l) => !o.project || same(l.project, o.project))
  return views(ws, o.all ? [...lanes].sort((a, b) => a.startedAt.localeCompare(b.startedAt)) : listedLanes(lanes, Date.now()))
}

/** The lanes that ended (or were abandoned) at or after `since` (ms), newest first (HI-2898: Progress → Lanes' Ended today). */
export async function lanesEndedSince(ws: WorkspaceService, since: number): Promise<LaneInfo[]> {
  if (!ws.path) return []
  const ended = (await read(ws)).filter((l) => !running(l) && !!l.endedAt && Date.parse(l.endedAt) >= since)
  return views(ws, ended.sort((a, b) => b.endedAt!.localeCompare(a.endedAt!)))
}

/** One lane by id (`project`: only one of that project's). */
export async function getLane(ws: WorkspaceService, id: string, project?: string | null): Promise<LaneInfo> {
  const l = (await read(ws)).find((x) => x.id === id && (!project || same(x.project, project)))
  if (!l) throw new LaneError(404, withValues(M.unknown, { id }))
  return (await views(ws, [l]))[0]
}

/** An agent was removed from its project: its running lanes, as builder or reviewer, are abandoned. */
export async function laneAgentRemoved(ws: WorkspaceService, project: string, agentId: string): Promise<void> {
  if (!ws.path) return
  const has = (await read(ws)).some((l) => running(l) && same(l.project, project) && (l.builder.id === agentId || l.reviewer?.id === agentId))
  if (!has) return
  await mutate(ws, async (lanes) => {
    for (const l of lanes) if (running(l) && same(l.project, project) && (l.builder.id === agentId || l.reviewer?.id === agentId)) close(l, 'abandoned', (await views(ws, [l]))[0].cards)
  })
}

// ---------------------------------------------------------------------------
// Following the board: each change to a workspace's cards reads its lanes again, ends those whose cards are all Done,
// abandons those whose agent is gone, and tells the window when what it lists changed.
// ---------------------------------------------------------------------------

/** What each workspace's window was last told (by its path), so an unchanged list isn't sent again. */
const told = new Map<string, string>()
const timers = new Map<string, NodeJS.Timeout>()
/** A board change and the follow-up are read together: changes landing within this are one look. */
const SETTLE_MS = 300

/** What laneStarts.ts finds a lane's card waiting for to start (HI-2029), read into its status (set at its start). */
let startWaits: (wsPath: string, lane: string) => LaneStartWait | null = () => null
export function setLaneStartWaits(fn: typeof startWaits): void {
  startWaits = fn
}
/** A lane's status changed outside the board (laneStarts.ts' start waits): the window and watches told, as for a board change. */
export const laneViewsChanged = (ws: WorkspaceService): void => changed(ws)

/** Builders whose lane's start is launching them ("<workspace>#<project>|<builder>" → how many starts), see holdLaneStart. */
const launching = new Map<string, number>()
const launchKey = (ws: WorkspaceService, project: string, builder: string): string => `${(ws.path ?? '').toLowerCase()}#${project.toLowerCase()}|${builder}`
/**
 * A lane's start launching its agents (Start Lane…, a lane the Assistant or a script records or updates), from before
 * the lane's record until its slot is lent and its agents started: laneStarts.ts never starts the builder's lane card
 * meanwhile (HI-2029: it found the builder not running yet and started the card itself, taking the slot the start was
 * lending, or giving the builder a second conversation). By builder, as the lane isn't recorded yet as it is held. The
 * release lets it look again.
 */
export function holdLaneStart(ws: WorkspaceService, project: string, builder: string): () => void {
  const k = launchKey(ws, project, builder)
  launching.set(k, (launching.get(k) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (launching.get(k) ?? 1) - 1
    if (n > 0) launching.set(k, n)
    else launching.delete(k)
    changed(ws)
  }
}
/**
 * Whether a running lane waits for a slot now, as kept (`slotWait`), read synchronously (laneStarts.ts, as it decides
 * and again just before its start, HI-2029). The slot pass clears it only once it has lent the slot and launched the
 * lane's agents (startWaitingLane), so it covers that deferred launch too, `stoppedOnly` or not.
 */
export function laneWaitsForSlot(ws: WorkspaceService, id: string): boolean {
  if (!ws.path) return false
  const rec = readLanes({ version: 1, lanes: readTable(ws.path, 'lanes').docs as Record<string, unknown>[] }).find((l) => l.id === id)
  return !!rec && running(rec) && !!rec.slotWait
}
/** Whether a lane's start is launching this builder now (holdLaneStart). */
export const laneStartHeld = (ws: WorkspaceService, project: string, builder: string): boolean => launching.has(launchKey(ws, project, builder))

/** A workspace's lanes changed: look again soon. */
function changed(ws: WorkspaceService): void {
  const k = ws.path?.toLowerCase()
  if (!k || timers.has(k)) return
  const t = setTimeout(() => {
    timers.delete(k)
    // One refresh at a time (#1011): a slow one isn't overlapped by the next.
    void coalesced(`lanes:${k}`, () => refresh(ws).catch((e) => log.warn('following the lanes', e)))
  }, SETTLE_MS)
  t.unref?.()
  timers.set(k, t)
}

/** Reads a workspace's lanes against the board, closes the finished ones, and tells its window what changed. */
export async function refresh(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  const lanes = await read(ws)
  const live = lanes.filter(running)
  if (live.length) {
    const vs = await views(ws, live)
    const names = await namesOf(ws, live)
    // A list change queued while a card was in flight applies at the card boundary (#1270): none in flight now.
    const boundary = live.filter((l, i) => l.pending && inFlight(vs[i]) === null)
    if (boundary.length) {
      const applied: LaneRecord[] = []
      const checks: (() => void)[] = []
      try {
        await withFileLock(fileOf(ws), async () => {
          const kept = await read(ws)
          for (const l of kept) {
            const was = boundary.find((b) => b.id === l.id)
            // As the decision read it: the same list, still queued (another change meanwhile is looked at afresh).
            if (!running(l) || !l.pending || !was || !sameList(l.cards, was.cards) || !sameList(l.pending, was.pending ?? [])) continue
            checks.push(stillBetweenCards(ws, l, [...l.cards]))
            // A lane keeps at least a card (lanes.ts keeps none without): a change to none leaves it as it was.
            if (l.pending.length) l.cards = l.pending
            delete l.pending
            l.updatedAt = now()
            applied.push(l)
          }
          await write(ws, kept, () => checks.forEach((c) => c()))
        })
      } catch (e) {
        if (!(e instanceof StaleLane)) throw e
        log.info(`a lane's queued list waits: ${e.message}`)
        changed(ws)
        return
      }
      for (const l of applied) {
        log.info(`Lane ${l.id}: its queued list change applied`)
        await tellListChanged(ws, l)
      }
      if (ws.path && same(ws.path, path)) return refresh(ws)
      return
    }
    const done = live.filter((l, i) => allDone(vs[i].cards))
    // An agent no longer in its project (removed while Combwork was closed, or by hand): its lane is abandoned.
    const orphan = live.filter((l) => {
      const n = names.get(l.project.toLowerCase())
      return !!n && (!n.has(l.builder.id) || (!!l.reviewer && !n.has(l.reviewer.id)))
    })
    if (done.length || orphan.length) {
      const laneCardsNow = new Map(live.map((l, i) => [l.id, vs[i].cards]))
      const on = await enforced()
      const ended: EndedLane[] = []
      const closed: LaneRecord[] = []
      const checks: (() => void)[] = []
      try {
        await withFileLock(fileOf(ws), async () => {
          const kept = await read(ws)
          for (const l of kept) {
            if (!running(l)) continue
            const decided = done.find((d) => d.id === l.id)
            // Every card Done (#1270): the lane ends by itself, its results from the cards' facts, if its list is the
            // one the decision read and its cards are still all Done as it saves (else nothing is saved, and it is read
            // again: HR6's #1270 round 1, a card reopened meanwhile).
            if (decided && sameList(l.cards, decided.cards)) {
              checks.push(stillAllDone(ws, l, [...l.cards]))
              endVerified(ws, l, laneCardsNow.get(l.id), on, ended)
            } else if (orphan.some((d) => d.id === l.id)) close(l, 'abandoned', laneCardsNow.get(l.id))
            else continue
            closed.push(l)
          }
          await write(ws, kept, () => checks.forEach((c) => c()))
        })
      } catch (e) {
        if (!(e instanceof StaleLane)) throw e
        log.info(`a lane's end waits: ${e.message}`)
        changed(ws)
        return
      }
      for (const l of closed) laneFact(ws, l)
      tellEnded(ws, ended)
      if (ws.path && same(ws.path, path)) return refresh(ws)
      return
    }
  }
  if (!ws.path || !same(ws.path, path)) return
  const listed = await listLanes(ws)
  const text = JSON.stringify(listed)
  if (told.get(path.toLowerCase()) === text) return
  // Nothing listed before and nothing now (a workspace with no lanes): nothing to tell.
  if (!told.has(path.toLowerCase()) && !listed.length) {
    told.set(path.toLowerCase(), text)
    return
  }
  told.set(path.toLowerCase(), text)
  ws.emit({ type: 'lanes-changed', workspacePath: path, lanes: listed })
}

let started = false

/** Follows the boards of open workspaces for their lanes. Once, at startup. */
export function startLanes(): void {
  if (started) return
  started = true
  onCombworkEvent((e) => {
    // The workspace's projects read again (their version control recorded as a window opens it): the lanes' old rules
    // marks and stages need their projects' rulesets now, which a first look before that couldn't read (#1421).
    if (e.type === 'workspace-changed') {
      const ws = e.workspace ? openWorkspaces().find((w) => w.path && same(w.path, e.workspace!.path)) : undefined
      if (ws) changed(ws)
      return
    }
    // A connection changed (HI-2670: its tools off makes its agents Independent): every open workspace's lanes look again.
    if (e.type === 'connections-changed') {
      openWorkspaces().forEach((w) => changed(w))
      return
    }
    // A project's workflow written (#1421): its lanes' old rules marks may have come or gone. Its team paused or resumed
    // (HI-2081): every running lane is paused or goes on.
    if (e.type !== 'tasks-changed' && e.type !== 'workflow-changed' && e.type !== 'team-pause-changed') return
    const ws = openWorkspaces().find((w) => w.path && same(w.path, e.workspacePath))
    if (ws) changed(ws)
  })
  // A lane starting or stopping to wait for its builder's branch (#1271): read again.
  onLineWaitChanged((ws) => changed(ws))
  // An agent's hooks going missing or coming back (#1336) pauses or resumes its lanes.
  onHooksHealthChanged(() => openWorkspaces().forEach((ws) => changed(ws)))
  // The runtime's `endLaneIfDone` (a card Done, #1270): the lanes are read again, and one whose cards are all Done ends.
  onAction('endLaneIfDone', (_a, ws) => changed(ws), 'repeatable')
  // An ended lane leaves the list after an hour: looked at again each minute (only workspaces whose window was told some).
  const tick = setInterval(() => {
    for (const ws of openWorkspaces()) if (ws.path && told.get(ws.path.toLowerCase()) !== '[]' && told.has(ws.path.toLowerCase())) changed(ws)
  }, 60_000)
  tick.unref?.()
}
