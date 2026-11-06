import { createHash, randomBytes } from 'crypto'
import { basename, join } from 'path'
import { mkdir, writeFile } from 'original-fs/promises'
import { projectAgents } from '../shared/defaults'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { agentText, englishText, forAgents, saidText, withValues, type Text, type TextPart, type TextValues } from '../shared/advanced'
import { agentMsg, currentChain, inDefaultDialect, overridesAny } from '../shared/agentText'
import { RETURNED_COMMENT, returnedCommentFrom } from './workflow/queueState'
import { msg, tr, type Msg } from '../shared/i18n'
import { COLUMN_CHOICES, TASK_COLUMNS, cardMatches, isTaskColumn, restoreOrders, searchedWords, sortCards } from '../shared/tasks'
import { HISTORY, setStoredAgentRenderer, setStoredForAgents, storedAgentText, storedIds, storedLineText, storedText } from '../shared/taskHistory'
import { MAX_CONTEXT, MAX_CONTEXT_REF, parseDocRef } from '../shared/docRefs'
import { contextProblems } from './docSections'
import { providerMessage } from '../shared/providers'
import type { CombworkErrorKind, TaskMoveResult } from '../shared/types'
import { workflowMessage } from '../shared/workflow/texts'
import type { ArchiveBatch, ArchiveRequest, ArchiveResult, ContextProblem, SetAsideCard, StoredText, TaskCard, TaskChanges, TaskCursor, TaskDecision, TaskColumn, TaskComment, TaskHistoryEntry, TaskPatch, UnarchiveResult } from '../shared/types'
import { returnRound } from '../shared/watch'
import { INTENT_TOOL } from '../shared/toolReplies'
import { holdsOf, trackHolds } from '../shared/cardCosts'
import { isProjectId, projectIdNamed, projectNameOf, projectNow, savedProjectName, type ProjectIdIndex } from '../shared/projectIds'
import { actorOf, changeByRuntime, decisionGenerations, gatherReads, isStorageError, recordChange, recording, recordingAs, recordingByRuntime, type Planned } from './workflow/recorder'
import { noteCard } from './assistantChanges'
import { FactStore } from './workflow/factStore'
import { loopReviewerOf } from './loopReviewer'
import { gitStep } from './platform/git'
import type { CardKind } from '../shared/workflow/facts'
import { alongside, isRefusal, type Reply, type Workflow, type Write } from './workflow/runtime'
import { linkToComment, moveCardFolder, publish, removeCardAttachments, trashCardFolder, type CleanupFile, type Staging } from './cardAttachments'
import { attachmentHref, attachmentMarkdown, attachmentRefs, withStoredIds } from '../shared/cardAttachments'
import { hasStage, skipReviewOf } from '../shared/workflow/compile'
import { isStageId, STAGE_TEXT, stageName, type StageNames } from '../shared/workflow/stages'
import { answerFits, approveNote, ASK_ACTIONS, CATEGORY_STAGE, DECISION_ANSWERS_MAX, decisionAnswers, STAGE_CATEGORY, type AskActionKind, type FactData, type Request, type RoundChoice, type StageId } from '../shared/workflow/facts'
import { askActionAvailable, kindProposed, reviewSkipOf, type ForYouAnswer } from '../shared/workflow/workView'
import { LANE_MAX_ROUNDS } from '../shared/lanes'
import { REFUSALS, refusal as refusalOf, type Refusal } from '../shared/workflow/refusals'
import { archiveBatchDocs, boardReadToken, boardGeneration, boardSavepoint, cardChanges, movedNames, boardRead, boardReadOnly, cardHeads, cardHeadDocs, headChanges, archivedSummaryDocs, boardChanged, boardWrite, cardDoc, cardDocs, cardNumbers, cardPlaces, costDocs, deleteCard, cardKeys, cardRevs, hasCard, holdChanges, holdDocs, keepOwnNumber, putCard, searchCards, setArchiveBatches, setAsideAdded, setAsideFile, setAsideFiles, SET_ASIDE, takeNumber, decisionChanges, cardsOnBoard, type CardQuery } from './boardStore'
import { keysForSearch } from './projectKeys'
import { config } from './config'
import { CombworkError, combworkError } from './combworkError'
import { createLogger, userText } from './logger'
import { workspace, workspaceFor, type WorkspaceService } from './workspace'
import { trash } from './trash'
import { cardRef } from '../shared/projectKeys'
import { projectPreferences } from './workflow/preferences'

const log = createLogger('tasks')

/**
 * Where agents' words for a board refusal differ from the window's (#910: the window says card, agents read the words
 * the Agent API always gave): agent messages (dialects, HI-2440), the agent branch of `forAgents`.
 */
const BOARD_AGENT = {
  unknownTask: agentMsg({ id: 'board.agent.unknownTask', text: 'Unknown task #{n}', note: '#910: the words the Agent API always gave (the window says card). Also what a confined agent is told about a card outside its project.' }),
  needsTitle: agentMsg({ id: 'board.agent.needsTitle', text: 'A task needs a title.', note: '#910: the words the Agent API always gave (the window says card).' }),
  chooseProject: agentMsg({ id: 'board.agent.chooseProject', text: 'Choose a project before giving the task to an agent.', note: '#910: the words the Agent API always gave (the window says card).' })
}

/**
 * The board's refusals (#846, E10b of #677) are CombworkErrors: the window reads them in its language, agents (the Agent API,
 * the cw_ tools) in English, exactly as before. A refusal's `kind` is set where it is the status its English always
 * gave (servers.ts `statusFor`); without one, the English still gives it. A column (`{column}`) is its key, and each
 * message chooses its words.
 */
const ERR = {
  unknownTask: msg({ id: 'tasks.error.unknownTask', defaultMessage: 'Unknown card {card}', description: 'An error: there is no card {card} (its key, such as HI-12), or none the caller may see.' }),
  noWorkspace: msg({ id: 'tasks.error.noWorkspace', defaultMessage: 'No workspace is open', description: "An error: a change to the task board needs an open workspace, and there is none." }),
  needsTitle: msg({ id: 'tasks.error.needsTitle', defaultMessage: 'A card needs a title.', description: 'An error: a card was saved with an empty title.' }),
  unknownColumn: msg({ id: 'tasks.error.unknownColumn', defaultMessage: 'Unknown column "{column}": {choices}.', description: 'An error: {column} is not a column of the board; {choices} lists the column ids the call takes (hold, todo, doing… kept as they are).' }),
  archived: msg({ id: 'tasks.error.archived', defaultMessage: '{card} is archived. Only the user can bring it back.', description: 'An error: card {card} (its key, such as HI-12) is archived, so an agent or the Assistant cannot change it; only the user can bring it back from the archive.' }),
  waitingNotYours: msg({ id: 'tasks.error.waitingNotYours', defaultMessage: "Only {card}'s own agent, the user or the Assistant can mark it waiting or clear that.", description: "An error, read by agents (HI-2618): an agent tried to mark card {card} (its key, such as HI-12) as waiting on purpose, or clear that mark, but the card isn't its own. A waiting card isn't reported as stalled." }),
  waitingNotActive: msg({ id: 'tasks.error.waitingNotActive', defaultMessage: "{card} isn't in {active}: only a card in {active} can be marked waiting.", description: "An error (HI-2618): only a card in the stage {active} (the board's name for it, such as Active) can be marked as waiting on purpose; card {card} (its key, such as HI-12) is elsewhere." }),
  waitingTooLong: msg({ id: 'tasks.error.waitingTooLong', defaultMessage: 'The waiting reason is too long (at most {max, number} characters).', description: "An error (HI-2618): the reason a card waits on purpose is longer than it may be; {max} is the most characters it takes." }),
  noCard: msg({ id: 'tasks.error.noCard', defaultMessage: 'There is no card {card}.', description: 'An error: there is no card {card} (its key, such as HI-12) that the caller may see.' }),
  cardsTooMany: msg({ id: 'tasks.error.cardsTooMany', defaultMessage: 'cards: at most {max, number} cards at once.', description: 'An error: a call listed more than {max} cards. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsNotNumber: msg({ id: 'tasks.error.cardsNotNumber', defaultMessage: 'cards: "{value}" is not a card number', description: 'An error: {value} in the list of cards is not a card number. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsTwice: msg({ id: 'tasks.error.cardsTwice', defaultMessage: 'cards: {card} is listed twice', description: 'An error: the list of cards names card {card} (its key, such as HI-12) twice. "cards:" is the name of the call\'s field: keep it as it is.' }),
  emptyDecision: msg({ id: 'tasks.error.emptyDecision', defaultMessage: 'The decision is empty.', description: "An error: a decision recorded on a card has no text." }),
  onlyUserDone: msg({ id: 'tasks.error.onlyUserOrdersDone', defaultMessage: 'Only the user puts the cards in Done in order.', description: 'An error: an agent or the Assistant tried to put the cards of the Done column in order; only the user does that.' })
}

/**
 * The workspace's task board: one row per card in the workspace's database (boardStore.ts, #1017), each the card's JSON
 * document, and the next number. Cards belong to a project and can be given to one of its agents. A card names its project by folder name
 * and by the project's stable id (#508, `projectId` in the file): the name is read back from the id, so a project
 * renamed or moved keeps its cards, and saving a card writes both (the name for people and for exports to older versions).
 */

/**
 * Who changes a card: the user (Combwork's window), the Combwork Assistant, or an agent or script through the Agent API.
 * `self` is the agent whose call it is (its project's folder name and id); scripts have none. `scope` confines a
 * project agent to its project's cards: others are "unknown" to it, as if they didn't exist.
 */
export type TaskActor = { kind: 'user' } | { kind: 'assistant' } | { kind: 'agent'; name: string; self?: { project: string; agentId: string }; scope?: string }

/** Combwork itself starting a lane's next card on its builder (HI-1990, laneStarts.ts): its start goes through the card's rules. */
// agent-protocol: who did it, as cards' history stores it: Combwork's own name (HI-2463)
export const CW_LANE_START: TaskActor = { kind: 'agent', name: 'Combwork' } // i18n-ignore: who did it, as cards' history and agents name Combwork

/** The project an actor is confined to on the board (a project agent's own), or null for the whole workspace. */
export const scopeOf = (a: TaskActor): string | null => (a.kind === 'agent' && a.scope !== undefined ? a.scope : null)

/** Whether a card is one the scope may see: every card without a scope, else only its project's (not the workspace's). */
export const inScope = (c: { project: string }, scope: string | null): boolean => scope === null || (!!c.project && c.project.toLowerCase() === scope.toLowerCase())

/** What a confined agent is told about a card outside its project: the same as for one that doesn't exist. */
export const unknownTask = (n: number): Error => new CombworkError(forAgents(withValues(ERR.unknownTask, { card: cardRef(n) }), saidText(BOARD_AGENT.unknownTask, { n: String(n) })), { kind: 'notFound' })
/** An empty title: the window says card; agents read the words they always did (#910). */
const needsTitle = (): CombworkError => new CombworkError(forAgents(ERR.needsTitle, saidText(BOARD_AGENT.needsTitle)), { kind: 'invalid' })

/** The calling agent, when a card of `project` going into Doing with no agent named should be given to it. */
const selfIn = (actor: TaskActor, project: string): string | null =>
  actor.kind === 'agent' && actor.self && project && actor.self.project.toLowerCase() === project.toLowerCase() ? actor.self.agentId : null

/** Who changed a card, as its history, comments and decisions store it: English, read by agents (the window words them, shared/taskHistory.ts BY_TEXT). */
// agent-protocol: who changed a card, as its history stores it (names, read back: recorder.ts)
const BY = { you: 'You', assistant: 'Assistant', combwork: 'Combwork', repair: 'Repair' } as const // i18n-ignore: stored with cards in English, as agents read them

export const actorName = (a: TaskActor): string => (a.kind === 'user' ? BY.you : a.kind === 'assistant' ? BY.assistant : a.name)

/** A change only the user may make (or the Assistant once the user said yes): thrown for others. The Agent API's 403. */
export class TaskPermissionError extends CombworkError {
  constructor(text: Text) {
    super(text, { kind: 'forbidden' })
  }
}

/** A change the card's state rules out now (another agent is working on it): the Agent API's 409. */
export class TaskConflictError extends CombworkError {
  constructor(text: Text) {
    super(text, { kind: 'conflict' })
  }
}

/**
 * A move the card's workflow rules refused (#1265, SPEC §16.8.3): its message for the window and the log, and the whole
 * refusal (rule, the three English sentences, who can override) for the Agent API's 409.
 */
export class WorkflowRefusedError extends TaskConflictError {
  constructor(readonly refusal: Refusal) {
    // agent-text: REFUSALS
    super(withValues(REFUSALS[refusal.rule].message, refusal.values as Record<string, string | number>))
  }
}

const MAX_TITLE = 200
const MAX_TEXT = 20_000
const MAX_LABELS = 12
const MAX_COMMENTS = 500
const MAX_DECISIONS = 100
const MAX_DECISION = 4000
/** The longest reason a card waits on purpose (HI-2618), in characters. */
const MAX_WAITING = 500
/**
 * A new history entry's or comment's id, unique on its card (#224): two entries alike in time, author and words are
 * still two. Card watches count what they have seen by it; the Agent API's card views leave it out.
 */
const entryId = (): string => randomBytes(6).toString('hex')
const MAX_HISTORY = 300

/**
 * A change of the board (#1017): under the board's lock (each change reads the board and writes its cards; a card's
 * place is worked out from every card's order), in one transaction, told once after it commits. Re-entrant: a change
 * made inside another is part of it. Keyed by the workspace folder, so every window's service shares it.
 */
export function boardLock<T>(ws: WorkspaceService, fn: () => Promise<T>): Promise<T> {
  return boardWrite(ws, fn)
}

/** The board changed: told once the change running here commits (at once outside one). */
function changed(ws: WorkspaceService = workspace): void {
  boardChanged(ws)
}

/**
 * A change of many cards (#1011), told to the board once, after it: one transaction (#1017), so all of it is saved or,
 * if it fails part way, none. Each tasks-changed is a read of the board for each of its listeners; told for each card
 * written, a batch under load piled up reads until main ran out of memory (#988).
 */
export async function cardBatch<T>(ws: WorkspaceService, fn: () => Promise<T>): Promise<T> {
  if (!ws.path) return fn()
  return boardWrite(ws, fn)
}


/** A card as saved, with anything missing or of the wrong type made safe (a card from an older Hive or an export may lack fields). */
function clean(raw: Partial<TaskCard> & { projectId?: unknown }, n: number, ids?: ProjectIdIndex, key?: string): TaskCard {
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [])
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const now = new Date(0).toISOString()
  return {
    number: n,
    // Its key (#1219: HI-12), from its project's key and its number there; not part of what is saved.
    ...(key ? { key } : {}),
    title: typeof raw.title === 'string' ? raw.title : `Task ${n}`, // i18n-ignore: a damaged card's stand-in title, saved and read by agents
    description: typeof raw.description === 'string' ? raw.description : '',
    // Renamed or moved since it was saved: the project that has its id now (projectNow).
    project: ids ? projectNow(ids, typeof raw.project === 'string' ? raw.project : '', raw.projectId) : typeof raw.project === 'string' ? raw.project : '',
    agent: typeof raw.agent === 'string' && raw.agent ? raw.agent : null,
    ...(typeof raw.agentName === 'string' ? { agentName: raw.agentName } : {}),
    ...(raw.review && typeof raw.review.agent === 'string' && raw.review.agent && typeof raw.review.since === 'string'
      ? { review: { agent: raw.review.agent, agentName: typeof raw.review.agentName === 'string' ? raw.review.agentName : raw.review.agent, since: raw.review.since } }
      : {}),
    column: isTaskColumn(raw.column) ? raw.column : 'todo',
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : n,
    labels: strs(raw.labels),
    // Absent when it has none (#818), so a card's JSON doesn't grow for it.
    ...(strs(raw.context).length ? { context: strs(raw.context).slice(0, MAX_CONTEXT) } : {}),
    ...problemsOf(raw.contextProblems),
    blocked: typeof raw.blocked === 'string' && raw.blocked.trim() ? raw.blocked : null,
    // Waiting on purpose (HI-2618), as kept: a move out of Doing clears it where it is written (updateTaskAs), which reads
    // it to say so, so it is kept whatever the column here (a runtime move has saved the new column first).
    ...(raw.waitingFor && typeof raw.waitingFor.reason === 'string' && raw.waitingFor.reason.trim() && typeof raw.waitingFor.by === 'string' && typeof raw.waitingFor.at === 'string' ? { waitingFor: { reason: raw.waitingFor.reason, by: raw.waitingFor.by, at: raw.waitingFor.at } } : {}),
    blockedBy: nums(raw.blockedBy),
    links: nums(raw.links),
    comments: Array.isArray(raw.comments) ? raw.comments.filter((c) => c && typeof c.text === 'string') : [],
    history: Array.isArray(raw.history) ? raw.history.filter((h) => h && typeof h.what === 'string') : [],
    archived: raw.archived === true,
    ...(raw.archivedFor ? { archivedFor: raw.archivedFor } : {}),
    ...(raw.archived === true && typeof raw.archivedBatch === 'string' && raw.archivedBatch ? { archivedBatch: raw.archivedBatch } : {}),
    ...decisionsOf(raw.decisions),
    ...holdsOf(raw.held),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now
  }
}

/** A card's decisions as saved (#357): only well-formed ones, each with an id; none, no field. */
function decisionsOf(v: unknown): { decisions?: TaskDecision[] } {
  if (!Array.isArray(v)) return {}
  const out = v.flatMap((d): TaskDecision[] =>
    d && typeof d.text === 'string' && d.text.trim()
      ? [
          {
            id: typeof d.id === 'string' && d.id ? d.id : entryId(),
            text: d.text,
            decidedBy: 'user',
            recordedBy: typeof d.recordedBy === 'string' ? d.recordedBy : '',
            at: typeof d.at === 'string' ? d.at : new Date(0).toISOString(),
            ...(typeof d.editedAt === 'string' ? { editedAt: d.editedAt } : {})
          }
        ]
      : []
  )
  return out.length ? { decisions: out } : {}
}

/**
 * Leaves out references to cards that are gone. A card deleted while another was being linked to it can leave
 * one behind; it is never shown or passed on, and leaves the file the next time that card is saved. Numbers are
 * never reused, so a reference can't come to mean another card.
 */
function withoutGone(card: TaskCard, exists: (n: number) => boolean): TaskCard {
  card.blockedBy = card.blockedBy.filter(exists)
  card.links = card.links.filter(exists)
  return card
}

/**
 * The cards on the board (archived ones too), in board order; `q` narrows it in the query (#1017): only archived cards
 * or only the others, these numbers, these agents' cards. A reader that needs a few cards asks for those.
 */
export async function allTasks(ws: WorkspaceService = workspace, q: CardQuery = {}): Promise<TaskCard[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  const docs = cardDocs(ws, q)
  const keys = cardKeys(ws, q.archived === undefined && !q.numbers && !q.agents && !q.reviewers ? undefined : docs.map((d) => d.number))
  // References to cards that are gone are left out: every number the board has, when only some cards were read.
  const numbers = q.archived === undefined && !q.numbers && !q.agents && !q.reviewers ? new Set(docs.map((d) => d.number)) : cardNumbers(ws)
  return sortCards(docs.map((d) => withoutGone(clean(d.doc, d.number, ids, keys.get(d.number)), (x) => numbers.has(x))))
}

/**
 * The board as the window shows it (#1017): the cards on it in full, archived ones in short (`summary`) unless `full`.
 * The window reads them in full while its Archived view or an archived card's dialog is open.
 */
export async function windowTasks(ws: WorkspaceService = workspace, full = false): Promise<TaskCard[]> {
  if (full || !ws.path) return allTasks(ws)
  const ids = await ws.projectIds()
  if (!ws.path) return []
  const numbers = cardNumbers(ws)
  const keys = cardKeys(ws)
  const live = cardDocs(ws, { archived: false }).map((d) => withoutGone(clean(d.doc, d.number, ids, keys.get(d.number)), (x) => numbers.has(x)))
  const short = archivedSummaryDocs(ws).map((d): TaskCard => ({ ...clean(d.doc, d.number, ids, keys.get(d.number)), summary: true }))
  return sortCards([...live, ...short])
}

/**
 * The board as the window keeps it (HI-1715): the cards changed since its cursor, or every card when it has none, its
 * board's stamp changed or the board keeps no revisions (windowTasks' cards: archived ones in short). The stamp is the
 * board's opening and what a card shows from outside its rows (its key, its project's name by id): either changing makes
 * the read whole. The project ids are the only await: the board opened again or the workspace changed meanwhile, the read
 * is `stale` (the window reads again); everything else is one snapshot (cardChanges).
 */
export async function windowChanges(ws: WorkspaceService = workspace, since: TaskCursor | null = null): Promise<TaskChanges> {
  const path = ws.path
  if (!path) return { stale: true }
  const generation = boardGeneration(ws)
  const ids = await ws.projectIds()
  if (ws.path !== path) return { stale: true }
  let read = cardChanges(ws, since ? since.mark : null)
  if (read.generation !== generation) return { stale: true }
  let board = boardStamp(read.generation, ids, read.keys)
  const full = !since || read.mark === null || since.board !== board
  if (full && since) {
    read = cardChanges(ws, null)
    if (read.generation !== generation) return { stale: true }
    board = boardStamp(read.generation, ids, read.keys)
  }
  const numbers = new Set(read.numbers)
  const live = read.live.map((d) => withoutGone(clean(d.doc, d.number, ids, read.keys.get(d.number)), (x) => numbers.has(x)))
  const short = read.summaries.map((d): TaskCard => ({ ...clean(d.doc, d.number, ids, read.keys.get(d.number)), summary: true }))
  return { board, mark: read.mark, full, cards: [...live, ...short], numbers: read.numbers }
}

/** A board's stamp for a window's cursor: its opening, and a hash of the project names by id and the cards' keys. */
function boardStamp(generation: number, ids: ProjectIdIndex, keys: Map<number, string>): string {
  const h = createHash('sha1')
  h.update(JSON.stringify([...ids.byId]))
  h.update(JSON.stringify([...keys]))
  return `${generation}:${h.digest('hex')}`
}

/** A card's holds, project, agent and reviewer, for costs; its history only when it keeps no holds (holdsFromHistory). */
export type CardHolds = Pick<TaskCard, 'number' | 'project' | 'held' | 'history' | 'agent' | 'agentName' | 'review'>

/**
 * Every card's holds (archived ones too), for costs (#602): only those fields of each document, made in the query
 * (#1107), so a card's comments are never parsed for it.
 */
export async function cardHolds(ws: WorkspaceService, o: { live?: boolean } = {}): Promise<CardHolds[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  return holdDocs(ws, o).map(({ number, doc }) => holdFields(doc, number, ids))
}

const holdFields = (doc: Record<string, unknown>, number: number, ids: ProjectIdIndex): CardHolds => {
  const c = clean(doc as Partial<TaskCard> & { projectId?: unknown }, number, ids)
  return { number, project: c.project, held: c.held, history: c.history, agent: c.agent, agentName: c.agentName, review: c.review }
}

/** Each workspace's cards' holds as boardHolds last read them: the board's opening and mark then, and the project names by id. */
const keptHolds = new WeakMap<WorkspaceService, { path: string; stamp: string; mark: number; cards: Map<number, CardHolds> }>()

/**
 * Every card's holds, as cardHolds gives them, in number order: kept, and read again only for the cards a change
 * touched (holdChanges, HI-1748: the usage history reads them after every board change, a dozen agents' changes a
 * minute). Read whole after the board was opened again or a project's name or id changed (a card's project is named by
 * them), and on a board waiting for its 1.0 upgrade. A kept card's object is the same until it changes.
 */
export async function boardHolds(ws: WorkspaceService): Promise<CardHolds[]> {
  const path = ws.path
  if (!path) return []
  const ids = await ws.projectIds()
  if (ws.path !== path) return []
  const was = keptHolds.get(ws)
  const names = JSON.stringify([...ids.byId])
  const same = (generation: number): boolean => !!was && was.path === path && was.stamp === `${generation}:${names}`
  let got = holdChanges(ws, was && was.path === path ? was.mark : null)
  if (!got) return cardHolds(ws)
  if (was && got.docs.length !== got.numbers.length && !same(got.generation)) got = holdChanges(ws, null)
  if (!got) return cardHolds(ws)
  const cards = was && same(got.generation) ? was.cards : new Map<number, CardHolds>()
  for (const { number, doc } of got.docs) cards.set(number, holdFields(doc, number, ids))
  if (cards.size > got.numbers.length) {
    const live = new Set(got.numbers)
    for (const n of cards.keys()) if (!live.has(n)) cards.delete(n)
  }
  keptHolds.set(ws, { path, stamp: `${got.generation}:${names}`, mark: got.mark, cards })
  return got.numbers.flatMap((n) => cards.get(n) ?? [])
}

/** Each workspace's live cards with decisions as liveDecisionCards last read them: the board's opening and project names then, its mark, each card with its decision generation. */
const keptDecisions = new WeakMap<WorkspaceService, { path: string; stamp: string; mark: number; cards: Map<number, { card: TaskCard; generation: number }> }>()

/**
 * The live cards that have decisions, each with its decision generation read with it (#1216), with only what a
 * decision notice reads of them (boardStore's DECISION_FIELDS: no title, description, comments, links or key): kept,
 * and read again only for the cards a change touched (decisionChanges, HI-1789: decision notices read them on every
 * Combwork tool reply after a board change, a dozen agents' changes a minute). Each read touches only those cards and the
 * kept ones (still live), never the whole board. A decision's generation is recorded in the change that writes the
 * card's decisions (recorder.ts), so it moves only with the card's revision. Read whole after the board was opened
 * again or a project's name or id changed (a card's project is named by them); on a board waiting for its 1.0 upgrade,
 * every live card in full, as allTasksSeen.
 */
export async function liveDecisionCards(ws: WorkspaceService): Promise<{ cards: TaskCard[]; generations: Map<number, number> }> {
  const path = ws.path
  if (!path) return { cards: [], generations: new Map() }
  const ids = await ws.projectIds()
  if (ws.path !== path) return { cards: [], generations: new Map() }
  const was = keptDecisions.get(ws)
  const names = JSON.stringify([...ids.byId])
  const same = (generation: number): boolean => !!was && was.path === path && was.stamp === `${generation}:${names}`
  // The changed cards, their generations and which kept cards are still live, from one snapshot: what a line tells, its receipt records.
  const read = (since: number | null, kept: number[]) =>
    boardRead(ws, () => {
      const got = decisionChanges(ws, since)
      return got && { ...got, live: cardsOnBoard(ws, kept, { live: true }), generations: decisionGenerations(ws, got.docs.map((d) => d.number)) }
    })
  let r = was && was.path === path ? read(was.mark, [...was.cards.keys()]) : read(null, [])
  if (r && was && !same(r.generation)) r = read(null, [])
  if (!r) return allTasksSeen(ws, { archived: false })
  const cards = was && same(r.generation) ? was.cards : new Map<number, { card: TaskCard; generation: number }>()
  // Archived or gone from the board since, or changed and without decisions now.
  for (const n of cards.keys()) if (!r.live.has(n)) cards.delete(n)
  for (const n of r.changed) cards.delete(n)
  for (const { number, doc } of r.docs) {
    const card = clean(doc, number, ids)
    if (card.decisions?.length) cards.set(number, { card, generation: r.generations.get(number) ?? 0 })
  }
  keptDecisions.set(ws, { path, stamp: `${r.generation}:${names}`, mark: r.mark, cards })
  return { cards: sortCards([...cards.values()].map((x) => x.card)), generations: new Map([...cards].map(([n, x]) => [n, x.generation])) }
}

/**
 * The cards given, with what their cost needs (#1210: number, title, project, column, holds, history, agent and reviewer; the rest as a
 * card without them has it): their comments, descriptions and decisions never read. In number order.
 */
export async function costCards(ws: WorkspaceService, numbers: number[]): Promise<TaskCard[]> {
  if (!ws.path || !numbers.length) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  return costDocs(ws, numbers).map(({ number, doc }) => clean(doc as Partial<TaskCard> & { projectId?: unknown }, number, ids))
}

/**
 * The live cards (with `done`, the live Done ones alone) with what readers run on each board change need (HI-1690:
 * number, title, project, column, agent and reviewer; the rest as a card without them has it): no archived card, and no
 * card's description, comments, decisions or history read. In board order, as allTasks gives them (a reader taking the
 * first card that fits takes the one highest in its column: HR6's round 1).
 */
export async function liveCardHeads(ws: WorkspaceService, o: { done?: boolean } = {}): Promise<TaskCard[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  return sortCards(liveHeadDocs(ws, o).map(({ number, doc }) => ({ ...cleanHead(doc, number, ids) })))
}

/** Each head as cleaned, kept while its document read and the project ids are the ones it was cleaned with (HI-1909). */
const cleanHeads = new WeakMap<Record<string, unknown>, { ids: ProjectIdIndex; card: TaskCard }>()

function cleanHead(doc: Record<string, unknown>, number: number, ids: ProjectIdIndex): TaskCard {
  const kept = cleanHeads.get(doc)
  if (kept?.ids === ids) return kept.card
  const card = clean(doc as Partial<TaskCard> & { projectId?: unknown }, number, ids)
  cleanHeads.set(doc, { ids, card })
  return card
}

type HeadDocs = ReturnType<typeof cardHeadDocs>

/**
 * The live cards' heads as read (HI-1909: each board change had its readers, the Doing cards' records, loop checks,
 * watches and the fresh-start nudge, read every live card's each, ~1 ms of main's thread a time): kept by number, with
 * the board's mark, and read again after a commit only for the cards at that mark or above (headChanges); until the
 * board commits again, the readers share the lists (`token`, boardReadToken), the Done ones taken from all of them.
 * Never kept or read from in a write.
 */
const headReads = new WeakMap<WorkspaceService, { token: string; generation: number; mark: number; heads: Map<number, Record<string, unknown>>; all?: HeadDocs; done?: HeadDocs }>()

function liveHeadDocs(ws: WorkspaceService, o: { done?: boolean }): HeadDocs {
  const token = boardReadToken(ws)
  if (token === null) return cardHeadDocs(ws, o)
  let kept = headReads.get(ws)
  if (kept?.token !== token) {
    const was = kept
    let read = headChanges(ws, was?.mark ?? null)
    if (read && was && read.generation !== was.generation) read = headChanges(ws, null)
    if (!read) {
      headReads.delete(ws)
      return cardHeadDocs(ws, o)
    }
    const fresh = new Map(read.docs.map((d) => [d.number, d.doc]))
    const heads = new Map<number, Record<string, unknown>>()
    for (const n of read.live) {
      const doc = fresh.get(n) ?? (read.generation === was?.generation ? was.heads.get(n) : undefined)
      if (doc) heads.set(n, doc)
    }
    headReads.set(ws, (kept = { token, generation: read.generation, mark: read.mark, heads }))
  }
  const k = kept
  k.all ??= [...k.heads].map(([number, doc]) => ({ number, doc }))
  if (!o.done) return k.all
  return (k.done ??= k.all.filter((d) => (d.doc as { column?: unknown }).column === 'done'))
}

/** A card's place on the board: all that placing another card needs of it (#458). */
type CardPlace = Pick<TaskCard, 'number' | 'column' | 'order' | 'archived' | 'project'>

/**
 * Every card's place (archived ones too), in board order, for placing a card (#458): the place fields from the board's
 * index (#1017), with no card's document read.
 */
export async function boardPlaces(ws: WorkspaceService): Promise<CardPlace[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  return sortCards(placesOf(cardPlaces(ws), ids))
}

const placesOf = (rows: ReturnType<typeof cardPlaces>, ids: ProjectIdIndex): CardPlace[] =>
  rows.map(({ number, raw }) => {
    const c = clean(raw as Partial<TaskCard> & { projectId?: unknown }, number, ids)
    return { number, column: c.column, order: c.order, archived: c.archived, project: c.project }
  })

/**
 * The live cards in a column, in board order, by their places alone (HI-1887): where a changed card is in its column,
 * which every agent's comment is told (reading the whole board for it cost main 15 ms a comment).
 */
export async function columnPlaces(ws: WorkspaceService, column: TaskColumn): Promise<CardPlace[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  if (!ws.path) return []
  return sortCards(placesOf(cardPlaces(ws, { column, known: TASK_COLUMNS.map((c) => c.id) }), ids).filter((c) => !c.archived && c.column === column))
}

/** Cards on the board, filtered; with `scope`, only that project's (asking for another project is refused). */
export async function listTasks(opts: { project?: string; column?: TaskColumn; archived?: boolean; scope?: string | null; query?: string } = {}): Promise<TaskCard[]> {
  const scope = opts.scope ?? null
  if (scope !== null && opts.project !== undefined && opts.project.toLowerCase() !== scope.toLowerCase()) {
    throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.ownCardsOnly', defaultMessage: "You can see only your project's cards ({project}).", description: "An error: an agent asked for another project's cards; it sees only its own project's ({project}, its folder name)." }), { project: scope }))
  }
  // The board's search (#1237): words through the full-text index, so only the cards it finds are read; the rest (a
  // number, a key, words too short for the index) as the board matches them. Either way cardMatches has the last word.
  const query = opts.query?.trim() ?? ''
  const keys = query ? keysForSearch(workspace) : []
  const moved = query ? movedNames(workspace) : {}
  const words = query ? searchedWords(query, keys) : null
  const found = words === null ? null : searchCards(workspace, words)
  return (await allTasks(workspace, { archived: opts.archived ?? false, ...(found ? { numbers: [...found] } : {}) })).filter(
    (c) =>
      (opts.project === undefined || c.project.toLowerCase() === opts.project.toLowerCase()) &&
      (!opts.column || c.column === opts.column) &&
      inScope(c, scope) &&
      (!query || cardMatches(c, query, keys, moved))
  )
}

/** A card, as an actor may see it: a confined agent gets "Unknown card" for another project's. */
export async function readTask(n: number, actor: TaskActor): Promise<TaskCard> {
  const c = await getTask(n)
  if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
  return c
}

/**
 * readTask, with the card's decision generation read in the same snapshot as the card (#1216): what an agent reading it
 * in full is given, for its receipt (never a decision written after the read).
 */
export async function readTaskSeen(n: number, actor: TaskActor): Promise<{ card: TaskCard; generation: number }> {
  const ws = workspace
  if (!Number.isInteger(n) || n < 1 || !ws.path) throw unknownTask(n)
  const ids = await ws.projectIds()
  if (!ws.path) throw unknownTask(n)
  const { raw, generation, key } = boardRead(ws, () => ({ raw: cardDoc(ws, n), generation: decisionGenerations(ws, [n]).get(n) ?? 0, key: cardKeys(ws, [n]).get(n) }))
  if (!raw) throw unknownTask(n)
  const c = withoutGone(clean(raw, n, ids, key), (x) => hasCard(ws, x))
  if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
  return { card: c, generation }
}

/**
 * allTasks, with each card's decision generation read in the same snapshot as the cards (#1216): decision lines tell an
 * agent of the decisions read here, and their receipts record these generations.
 */
export async function allTasksSeen(ws: WorkspaceService, q: CardQuery = {}): Promise<{ cards: TaskCard[]; generations: Map<number, number> }> {
  if (!ws.path) return { cards: [], generations: new Map() }
  const ids = await ws.projectIds()
  if (!ws.path) return { cards: [], generations: new Map() }
  const { docs, numbers, generations, keys } = boardRead(ws, () => {
    const read = cardDocs(ws, q)
    return { docs: read, numbers: cardNumbers(ws), generations: decisionGenerations(ws, read.map((d) => d.number)), keys: cardKeys(ws, read.map((d) => d.number)) }
  })
  return { cards: sortCards(docs.map((d) => withoutGone(clean(d.doc, d.number, ids, keys.get(d.number)), (x) => numbers.has(x)))), generations }
}

/** The cards `refs` names that are outside the scope (another project's, or the workspace's): a confined agent sees only their numbers. */
export async function refsOutside(refs: number[], scope: string | null): Promise<number[]> {
  if (scope === null) return []
  const out: number[] = []
  for (const n of refs) if (!inScope(await getTask(n).catch(() => ({ project: '' })), scope)) out.push(n)
  return out
}

export async function getTask(n: number, ws: WorkspaceService = workspace): Promise<TaskCard> {
  if (!Number.isInteger(n) || n < 1 || !ws.path) throw unknownTask(n)
  const ids = await ws.projectIds()
  const raw = ws.path ? cardDoc(ws, n) : null
  if (!raw) throw unknownTask(n)
  return withoutGone(clean(raw, n, ids, cardKeys(ws, [n]).get(n)), (x) => hasCard(ws, x))
}

/**
 * Cards as getTask reads them (null: not on the board; undefined: it couldn't be read now), kept (HI-1780: the lanes read every running lane's cards on each
 * board change, three times): one is read in full again only once its revision (CARD_REVS_STEP: any write to its row or
 * its parts), its key, the project names by id or the board's opening changed; a card one links to or waits for that
 * is gone since leaves its lists, as getTask leaves it out. The same object is given until then: never change it. On a
 * board waiting for its 1.0 upgrade (no revisions), each is read as getTask does.
 */
export async function cardsNow(ws: WorkspaceService, numbers: readonly number[]): Promise<Map<number, TaskCard | null | undefined>> {
  const out = new Map<number, TaskCard | null | undefined>()
  const path = ws.path
  if (!path || !numbers.length) return out
  const ids = await ws.projectIds()
  if (ws.path !== path) return out
  const wanted = [...new Set(numbers)]
  const revs = cardRevs(ws, wanted)
  if (!revs) {
    for (const n of wanted) out.set(n, await getTask(n, ws).catch(unreadable))
    return out
  }
  const keys = cardKeys(ws, wanted)
  const names = JSON.stringify([...ids.byId])
  let kept = keptCards.get(ws)
  if (!kept || kept.path !== path || kept.generation !== revs.generation || kept.names !== names) keptCards.set(ws, (kept = { path, generation: revs.generation, names, cards: new Map() }))
  // The cards the kept ones link to or wait for that are still on the board (one read of those alone).
  let all: Set<number> | null = null
  const there = (x: number): boolean => {
    if (!all) {
      const refs = [...kept!.cards.values()].flatMap(({ card }) => [...card.blockedBy, ...card.links])
      all = new Set([...(cardRevs(ws, [...new Set(refs)])?.revs.keys() ?? [])])
    }
    return all.has(x)
  }
  for (const n of wanted) {
    const rev = revs.revs.get(n)
    if (rev === undefined) {
      kept.cards.delete(n)
      out.set(n, null)
      continue
    }
    const at = `${rev}\n${keys.get(n) ?? ''}`
    const was = kept.cards.get(n)
    if (was?.at === at) {
      out.set(n, was.card.blockedBy.length || was.card.links.length ? withoutGone(was.card, there) : was.card)
      continue
    }
    // Read at its revision or after: a write since raises it again (it is below the mark), so the next look reads it
    // again. A card at the mark keeps its revision through another write, so it isn't kept: read each time until a
    // later change moves the mark past it.
    const card = await getTask(n, ws).catch(unreadable)
    if (card && rev < revs.mark) kept.cards.set(n, { at, card })
    else kept.cards.delete(n)
    out.set(n, card)
  }
  return out
}
/** A card read refused: null when there is no such card, undefined when it couldn't be read. */
const unreadable = (e: Error): null | undefined => (e.message.startsWith('Unknown task') ? null : undefined)
/** Each workspace's cards cardsNow read, with the revision and key each was read at, for an opening and project names. */
const keptCards = new WeakMap<WorkspaceService, { path: string; generation: number; names: string; cards: Map<number, { at: string; card: TaskCard }> }>()

/**
 * Saves a card (in a board change) with its project's id beside its name (#508). A card whose project the workspace doesn't
 * have now (removed, or renamed before it had an id) keeps the id it was saved with, if any, and never takes another
 * project's: shown as goneProject's while another project has its name, it is saved with that name as it was.
 * `commit`: a caller whose authority can change while it waits (the Assistant's Control and session, assistantChange's
 * guard) checks it here, after the last await and just before the write (HI-2415), so a revoked change saves nothing.
 */
async function saveCard(ws: WorkspaceService, n: number, card: TaskCard, before?: TaskCard | null, withRow?: () => void, commit?: () => void): Promise<void> {
  // Who holds it now, for its cost (#602): a hold that ended gets its end, a new one starts.
  trackHolds(card, new Date().toISOString())
  const ids = await ws.projectIds()
  commit?.()
  const saved = savedProjectName(card.project)
  let projectId = saved && saved === card.project ? projectIdNamed(ids, saved) : null
  // The card as it was, for its facts (#1216): given by a caller that has it (null: a new card), else read.
  const was = before === undefined || (!projectId && saved) ? cardDoc(ws, n) : null
  if (!projectId && saved) {
    const old = was as { project?: unknown; projectId?: unknown } | null
    if (old && isProjectId(old.projectId) && typeof old.project === 'string' && old.project.toLowerCase() === saved.toLowerCase()) projectId = old.projectId
  }
  const { number, title, description, project: _shown, key: _key, ...rest } = card
  putCard(ws, n, { number, title, description, project: saved, ...(projectId ? { projectId } : {}), ...rest })
  // What the caller writes with its row before its facts are recorded (a new card's kind, #1277: a card made in Doing
  // starts as the kind it was made).
  withRow?.()
  // Its facts, in the same transaction (#1216): what this change moved, started, submitted, reviewed, blocked or decided.
  const prior = before !== undefined ? before : was ? clean(was, n, ids) : null
  recordChange(ws, prior, { ...card, project: saved })
  // The Assistant's change of it, for undo (#1282): what it replaced, in the same transaction.
  noteCard(ws, prior, card)
  // Its key now (#1219: a card moved to another project has that project's): what callers return of it.
  const key = cardKeys(ws, [n]).get(n)
  if (key) card.key = key
  else delete card.key
}

/** A card's fields in Combwork's order, with its project and id as given (the rest as they were). */
function withProject(raw: Record<string, unknown>, project: string, projectId: string): Record<string, unknown> {
  const { number, title, description, project: _was, projectId: _id, ...rest } = raw
  return { number, title, description, project, projectId, ...rest }
}

/**
 * Each card names its project by id too (#508), once: a card saved before ids (or by an older Hive, which leaves the id
 * out) whose name is a project of the workspace gets that project's id, and a card whose project was renamed or moved
 * since gets its name now. A card with an id no project has (its project removed or gone) is left as it is, and so is one
 * saved before ids under a name no project has (Repair can give those to their project). In one board change, every
 * field kept (the cards' files as they were before 0.9 are kept in `.combwork/tasks.imported-<time>`, #1017). Run each time
 * the workspace opens, and again once its board is upgraded to 1.0 (#1621: until then it takes no writes, and is skipped);
 * it changes nothing the second time.
 */
export function stampCardProjects(ws: WorkspaceService): Promise<number> {
  if (!ws.path || boardReadOnly(ws)) return Promise.resolve(0)
  return boardLock(ws, async () => {
    if (!ws.path) return 0
    const ids = await ws.projectIds()
    let n = 0
    for (const { number, doc: raw } of cardDocs(ws)) {
      const f = `#${number}`
      const did = await (async () => {
        if (typeof raw.project !== 'string' || !raw.project) return false
        let next: { project: string; projectId: string } | null = null
        if (isProjectId(raw.projectId)) {
          const now = projectNameOf(ids, raw.projectId)
          if (now && now !== raw.project) next = { project: now, projectId: raw.projectId }
        } else {
          const id = projectIdNamed(ids, raw.project)
          if (id) next = { project: raw.project, projectId: id }
        }
        if (!next) return false
        const stamped = !isProjectId(raw.projectId)
        putCard(ws, number, withProject(raw, next.project, next.projectId))
        // Given its project's id only now: a card from before keeps its own number there (#1219).
        if (stamped) keepOwnNumber(ws, number)
        return true
      })().catch((e) => {
        log.warn(`giving card ${f} its project's id`, e)
        return false
      })
      if (did) n++
    }
    if (n) {
      log.info(`${n} card(s) now name their project by its id`)
      changed(ws)
    }
    return n
  })
}

/** The cards saved before ids (#508: no projectId in the file), as Repair weighs whose they are: their project's name and agents. */
export async function legacyCards(ws: WorkspaceService): Promise<{ number: number; name: string; agents: string[] }[]> {
  if (!ws.path) return []
  const out: { number: number; name: string; agents: string[] }[] = []
  for (const { number: n, doc: raw } of cardDocs(ws)) {
    if (isProjectId(raw.projectId) || typeof raw.project !== 'string' || !raw.project) continue
    const review = raw.review as { agent?: unknown } | undefined
    const agents = [raw.agent, review?.agent].filter((a): a is string => typeof a === 'string' && !!a)
    out.push({ number: Number(n), name: raw.project, agents })
  }
  return out.sort((a, b) => a.number - b.number)
}

/**
 * Gives cards saved before ids under a project's old name to the project they belong to now (#508, Repair's plan), with
 * its id and a line in each one's history by Repair; nothing else of the card changes (its date neither: nobody edited
 * it, and an archived card's date is when Archived says it was archived). In one board change, each card read again
 * there: one with an id, or under another name now, is left as it is. Returns how many moved.
 */
export function moveOrphanCards(ws: WorkspaceService, m: { from: string; to: string; cards: number[] }): Promise<number> {
  return boardLock(ws, async () => {
    const projectId = projectIdNamed(await ws.projectIds(), m.to)
    if (!projectId) throw combworkError(msg({ id: 'tasks.error.repairNoProject', defaultMessage: "{project} isn't a project of the workspace now", description: "An error from Repair: the project {project} (a folder name) it was to give cards to isn't in the workspace any more." }), { project: m.to }, { kind: 'notFound' })
    let n = 0
    for (const x of m.cards) {
      const moved = await (async () => {
        const raw = cardDoc(ws, x)
        if (!raw || isProjectId(raw.projectId) || typeof raw.project !== 'string' || raw.project.toLowerCase() !== m.from.toLowerCase()) return false
        const history = Array.isArray(raw.history) ? raw.history : []
        const entry = entryOf(new Date().toISOString(), BY.repair, storedText(HISTORY.repaired, { from: m.from, to: m.to }))
        await moveCardFolder(ws, x, raw.project, m.to)
        putCard(ws, x, { ...withProject(raw, m.to, projectId), history: [...history, entry].slice(-MAX_HISTORY) })
        return true
      })()
      if (moved) n++
    }
    if (n) {
      log.info(`Repair gave ${n} card(s) of ${userText(m.from)} to ${userText(m.to)}`)
      changed(ws)
    }
    return n
  })
}

/** The start of a set-aside card's description the Review… dialog shows. */
const PREVIEW_CHARS = 600

/** A set-aside file's card as the older Hive saved it, or null when it isn't one. */
function setAsideDoc(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The cards an older Hive saved after the board moved to its database, set aside in `.combwork/tasks.set-aside` (#1017's
 * downgrade, #1044): what the Review… dialog lists, oldest number first. A file that isn't a card is listed as unreadable.
 */
export async function setAsideCards(ws: WorkspaceService = workspace): Promise<SetAsideCard[]> {
  if (!ws.path) return []
  const ids = await ws.projectIds()
  const numbers = cardNumbers(ws)
  return setAsideFiles(ws).map(({ file, number, text }) => {
    const raw = setAsideDoc(text)
    const c = raw ? clean(raw, number, ids) : null
    return {
      file,
      number,
      free: !numbers.has(number),
      readable: !!c,
      title: c?.title ?? file,
      preview: c ? c.description.slice(0, PREVIEW_CHARS) : '',
      project: c?.project ?? '',
      column: c?.column ?? 'todo',
      createdBy: c?.createdBy ?? '',
      createdAt: c?.createdAt ?? '',
      comments: c?.comments.length ?? 0
    }
  })
}

/**
 * Adds a set-aside card to the board (#1044, Darren's decision on #1017): under its old number if no card has it, else
 * the next free one, with everything it had (comments, decisions, links as they were: nothing else is rewritten), placed
 * last in its column and a line in its history by Repair saying where it came from. In one board change, the file read
 * again there; its content is recorded as added in the same transaction, so it is never added twice.
 */
export function addSetAsideCard(ws: WorkspaceService, file: string): Promise<TaskCard> {
  return boardLock(ws, async () => {
    const path = setAsideFile(ws, file)
    const entry = path ? setAsideFiles(ws).find((f) => f.file === file) : undefined
    const raw = setAsideDoc(entry?.text ?? null)
    if (!entry || !raw) throw combworkError(msg({ id: 'tasks.error.setAsideGone', defaultMessage: 'That set-aside card is gone, or isn\'t a card: it can only be discarded.', description: "An error in the Review… dialog for cards an older Combwork saved: the card's file was removed meanwhile, or can't be read as a card." }), undefined, { kind: 'notFound' })
    const ids = await ws.projectIds()
    const was = entry.number
    const n = hasCard(ws, was) ? await nextNumber(ws) : was
    const now = new Date().toISOString()
    const c = clean(raw, n, ids)
    // Every field the older Hive stored is kept (#1044 round 1: its own fields, past holds for its cost), Combwork's own
    // fields as read (round 2: one of the wrong type gets its safe default, as on any read, so it can't stop the card
    // coming back; the original stays in the Recycle Bin): but its number, place, history and date. A review under way
    // there isn't one here (saveCard ends its reviewer's hold).
    const { review: _review, ...known } = c
    // Combwork's optional fields only as read: one left out as broken isn't kept from the stored card either.
    const { agentName: _a, review: _r, archivedFor: _f, archivedBatch: _b, decisions: _d, held: _h, ...stored } = raw
    const card = {
      ...stored,
      ...known,
      number: n,
      order: orderIn(await boardPlaces(ws), c.column, null, null),
      history: [...c.history, entryOf(now, BY.repair, storedText(HISTORY.fromOlder, { was }))].slice(-MAX_HISTORY),
      updatedAt: now
    } as TaskCard
    await saveCard(ws, n, card)
    setAsideAdded(ws, file, entry.text!)
    log.info(`#${n} added from ${SET_ASIDE} (made in an older Hive as #${was}): ${userText(card.title)}`)
    changed(ws)
    return clean(card, n, ids)
  })
}

/** Discards a set-aside card (#1044): its file goes to the Recycle Bin. The window asks first. */
export async function discardSetAsideCard(ws: WorkspaceService, file: string): Promise<void> {
  const path = setAsideFile(ws, file)
  if (!path) return
  await trash(path)
  log.info(`discarded ${file} from ${SET_ASIDE}`)
  changed(ws)
}

/** The next card number, never reused (in a board change). */
async function nextNumber(ws: WorkspaceService): Promise<number> {
  return takeNumber(ws)
}

/** A project of the workspace by folder name ('' for the workspace itself); throws for an unknown one. */
async function projectName(name: string | undefined): Promise<string> {
  const v = (name ?? '').trim()
  if (!v) return ''
  const hit = (await workspace.listProjectPaths()).map((p) => basename(p)).find((p) => p.toLowerCase() === v.toLowerCase())
  if (!hit) throw combworkError(msg({ id: 'tasks.error.unknownProject', defaultMessage: 'Unknown project "{project}"', description: 'An error: the workspace has no project named {project}.' }), { project: v }, { kind: 'notFound' })
  return hit
}

/** An agent of the project, by id or name: its id and name. */
async function agentOf(project: string, agent: string): Promise<{ id: string; name: string }> {
  if (!project) throw new CombworkError(forAgents(msg({ id: 'tasks.error.chooseProject', defaultMessage: 'Choose a project before giving the card to an agent.', description: "An error: a card of the whole workspace (no project) can't be given to an agent: agents belong to a project." }), saidText(BOARD_AGENT.chooseProject)), { kind: 'invalid' })
  const cfg = await workspace.projectConfig(join(workspace.path!, project))
  const a = projectAgents(cfg).find((x) => x.id === agent || x.name.toLowerCase() === agent.toLowerCase())
  if (!a) throw combworkError(UNKNOWN_AGENT, { agent, project }, { kind: 'notFound' })
  return { id: a.id, name: a.name }
}

/** An agent named that the project doesn't have (also taskStart.ts's). */
export const UNKNOWN_AGENT = msg({ id: 'tasks.error.unknownAgent', defaultMessage: 'Unknown agent "{agent}" in {project}', description: 'An error: the project {project} (a folder name) has no agent named {agent}.' })

/** A field of a card, by what its "too long" refusal calls it. */
type TextField = 'title' | 'description' | 'comment' | 'decision' | 'blockedReason'

const text = (v: unknown, max: number, what: TextField): string => {
  const s = String(v ?? '')
  if (s.length > max) {
    throw combworkError(msg({ id: 'tasks.error.tooLong', defaultMessage: '{what, select, title {The title is too long (at most {max, number} characters).} description {The description is too long (at most {max, number} characters).} comment {The comment is too long (at most {max, number} characters).} decision {The decision is too long (at most {max, number} characters).} other {The blocked reason is too long (at most {max, number} characters).}}', description: "An error: a card's field is longer than it may be ({what}, select: its title, description, comment, decision or blocked reason; translate each sentence); {max} is the most characters it takes." }), { what, max }, { kind: 'invalid' })
  }
  return s
}

/** The folder a card's project files are read from (#818): its project's, or none for a card about the workspace. */
const cardProject = (card: Pick<TaskCard, 'project'>, ws: WorkspaceService = workspace): string | null => (card.project && ws.path ? join(ws.path, card.project) : null)

/** A stored card's context problems (#819) that are well formed, or none (absent). */
function problemsOf(raw: unknown): { contextProblems?: ContextProblem[] } {
  const list = Array.isArray(raw) ? raw.filter((p): p is ContextProblem => !!p && typeof p.ref === 'string' && typeof p.problem === 'string').slice(0, MAX_CONTEXT) : []
  return list.length ? { contextProblems: list.map((p) => ({ ref: p.ref, problem: p.problem, ...(Array.isArray(p.closest) ? { closest: p.closest.filter((x): x is string => typeof x === 'string').slice(0, 5) } : {}) })) } : {}
}

/** Sets or clears a card's context problems (#819). */
function withProblems(card: TaskCard, problems: ContextProblem[]): void {
  if (problems.length) card.contextProblems = problems
  else delete card.contextProblems
}

/**
 * What a card's context references came to when it was started (#819), recorded on it as Combwork: the problems, or none.
 * No history line: the card shows them while they last. `checked`: the card as the check was made for it (its Start's:
 * its references, project, agent and column), compared under the board's lock with the card as it is: one changed
 * meanwhile in any of those, archived, or gone (deleted) keeps what it has, and the reply is false, so its Start stops
 * rather than giving the agent a card that isn't its to start any more. Other changes (labels, a comment) don't count.
 */
export async function setContextProblems(n: number, problems: ContextProblem[], checked: { context: readonly string[]; project: string; agent?: string | null; column?: TaskColumn }, ws: WorkspaceService = workspace): Promise<boolean> {
  return boardLock(ws, async () => {
    const card = await getTask(n, ws).catch(() => null)
    if (!card || card.archived || card.project !== checked.project || (card.context ?? []).join('\n') !== checked.context.join('\n')) return false
    if ((checked.agent !== undefined && card.agent !== checked.agent) || (checked.column !== undefined && card.column !== checked.column)) return false
    if (JSON.stringify(card.contextProblems ?? []) === JSON.stringify(problems)) return true
    withProblems(card, problems)
    await saveCard(ws, n, card)
    changed(ws)
    return true
  })
}

/** A card's context references (#818), checked: a list of Markdown files with an optional #slug, never line numbers. */
function contextOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw combworkError(msg({ id: 'tasks.error.contextList', defaultMessage: 'context must be a list', description: `An error: the call gave the card's context (the doc sections to read first) as something other than a list. "context" is the name of the call's field: keep it as it is.` }), undefined, { kind: 'invalid' })
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
  if (out.length > MAX_CONTEXT) throw combworkError(msg({ id: 'tasks.error.tooManyContext', defaultMessage: 'A card can have up to {max} doc sections to read first.', description: 'An error: a card was given more context references (doc sections the agent reads first) than it may have ({max}, a number).' }), { max: MAX_CONTEXT }, { kind: 'invalid' })
  const bad = out.find((r) => r.length > MAX_CONTEXT_REF || !parseDocRef(r))
  if (bad !== undefined) throw combworkError(msg({ id: 'tasks.error.contextRef', defaultMessage: `"{ref}" isn't a doc section: give a Markdown file, optionally with # and a heading's slug ("docs/PLAN.md#setup", "shared:plans/notes.md#open-questions"), never a line number.`, description: `An error: one of the card's context references isn't a Markdown file with an optional #heading-slug. Keep the examples in quotes as they are.` }), { ref: bad.slice(0, 80) }, { kind: 'invalid' })
  return out
}

const LABELS_MIXED = msg({ id: 'tasks.error.labelsMixed', defaultMessage: "labels replaces a card's labels: give it alone, or addLabels and removeLabels to change only those.", description: 'An error: the call gave the card\'s labels in full (labels, which replaces them) and also labels to add or take off. "labels", "addLabels" and "removeLabels" are the names of the call\'s fields: keep them as they are.' })
const TOO_MANY_LABELS = msg({ id: 'tasks.error.tooManyLabels', defaultMessage: 'A card can have up to {max} labels.', description: 'An error: a card was given more labels than it may have ({max}, a number).' })

/**
 * Labels as a card keeps them: each cut to 40 characters and trimmed, empty ones dropped, then each once (#1131 round 1:
 * cut after removing repeats, two labels alike in their first 40 characters were kept twice).
 */
function normalLabels(v: readonly unknown[]): string[] {
  return [...new Set(v.map((x) => String(x).trim().slice(0, 40).trim()).filter(Boolean))]
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) throw combworkError(msg({ id: 'tasks.error.labelsList', defaultMessage: 'labels must be a list', description: 'An error: the call gave the card\'s labels as something other than a list. "labels" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  const out = normalLabels(v)
  if (out.length > MAX_LABELS) throw combworkError(TOO_MANY_LABELS, { max: MAX_LABELS }, { kind: 'invalid' })
  return out
}

/** addLabels or removeLabels, read as labels is (normalLabels). */
function someLabels(v: unknown, field: 'addLabels' | 'removeLabels'): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw combworkError(msg({ id: 'tasks.error.labelFieldList', defaultMessage: '{field} must be a list', description: 'An error: the call gave the labels to add or remove as something other than a list. {field} is the name of the call\'s field ("addLabels" or "removeLabels"): keep it as it is.' }), { field }, { kind: 'invalid' })
  return normalLabels(v)
}

/**
 * A card's labels with some added and some taken off (#1131: tagging cards without replacing their other labels): those
 * added where missing, at the end in the order given, and those taken off where present; the others stay as they are.
 * Null when nothing changes (a label there already, one missing). Refused beside labels, which replaces them, and for a
 * label both added and removed.
 */
export function labelChange(labels: readonly string[], add: unknown, remove: unknown): { labels: string[]; said: StoredText } | null {
  const plus = someLabels(add, 'addLabels')
  const minus = someLabels(remove, 'removeLabels')
  const both = plus.filter((l) => minus.includes(l))
  if (both.length) throw combworkError(msg({ id: 'tasks.error.labelsAddedAndRemoved', defaultMessage: "A label can't be both added and removed: {labels}.", description: 'An error: the call named the same labels ({labels}, separated by commas) both to add to the card and to take off it.' }), { labels: both.join(', ') }, { kind: 'invalid' })
  const added = plus.filter((l) => !labels.includes(l))
  const removed = minus.filter((l) => labels.includes(l))
  if (!added.length && !removed.length) return null
  const next = [...labels.filter((l) => !removed.includes(l)), ...added]
  if (next.length > MAX_LABELS) throw combworkError(TOO_MANY_LABELS, { max: MAX_LABELS }, { kind: 'invalid' })
  const said = !removed.length
    ? storedText(HISTORY.labelsAdded, { labels: added.join(', ') })
    : !added.length
      ? storedText(HISTORY.labelsTakenOff, { labels: removed.join(', ') })
      : storedText(HISTORY.labelsAddedTakenOff, { added: added.join(', '), removed: removed.join(', ') })
  return { labels: next, said }
}

/**
 * The cards a list names (blockedBy, links), checked. A confined agent can only name its project's cards; when it
 * changes a card's list, the cards from other projects already on it (`kept`, which it sees only as numbers) stay.
 */
async function cardRefs(v: unknown, self: number | null, what: 'blockedBy' | 'links', scope: string | null = null, kept: number[] = []): Promise<number[]> {
  // `what` is the call's field, named as it is in every language.
  if (!Array.isArray(v)) throw combworkError(msg({ id: 'tasks.error.refsList', defaultMessage: '{field} must be a list of card numbers', description: 'An error: the call gave {field} (the name of its field: blockedBy or links, kept as it is) as something other than a list of card numbers.' }), { field: what }, { kind: 'invalid' })
  const nums = [...new Set(v.map((x) => Number(String(x).replace(/^#/, ''))))]
  const hidden = await refsOutside(kept, scope)
  const noCard = (n: number): CombworkError => combworkError(msg({ id: 'tasks.error.refsNoCard', defaultMessage: '{field}: there is no card {card}', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) names card #{n} (a number), which there is not.' }), { field: what, card: cardRef(n) }, { kind: 'invalid' })
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1) throw combworkError(msg({ id: 'tasks.error.refsNotNumber', defaultMessage: '{field}: "{value}" is not a card number', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) has {value} in it, which is not a card number.' }), { field: what, value: String(n) }, { kind: 'invalid' })
    if (n === self) throw combworkError(msg({ id: 'tasks.error.refsSelf', defaultMessage: "{field}: a card can't refer to itself", description: "An error: the list {field} (the name of the call's field: blockedBy or links, kept as it is) names the card itself." }), { field: what }, { kind: 'invalid' })
    if (!hasCard(workspace, n)) throw noCard(n)
    if (!hidden.includes(n) && !inScope(await getTask(n), scope)) throw noCard(n)
  }
  return [...nums, ...hidden.filter((n) => !nums.includes(n))]
}

/** The order that puts a card before `before` in `column` (at the end without one). */
function orderIn(cards: CardPlace[], column: TaskColumn, self: number | null, before: number | null | undefined): number {
  const list = cards.filter((c) => c.column === column && !c.archived && c.number !== self)
  const i = before ? list.findIndex((c) => c.number === before) : -1
  if (i < 0) return (list.length ? Math.max(...list.map((c) => c.order)) : 0) + 1
  const prev = i > 0 ? list[i - 1].order : list[i].order - 2
  return (prev + list[i].order) / 2
}

/**
 * On Hold is the user's and the Assistant's (#170): parked work nobody picks up. A project agent (its own token) can't
 * park a card, by a move or by creating it there; taking one out (the user asked it to work on it) is a move like any.
 */
function checkHold(column: TaskColumn, actor: TaskActor, n?: number): void {
  if (column !== 'hold' || actor.kind !== 'agent' || !actor.self) return
  throw new TaskPermissionError(
    n
      ? withValues(msg({ id: 'tasks.error.holdCard', defaultMessage: 'Only the user or the Assistant puts cards On Hold. Where the user has decided to park {card}, ask the Assistant (cw_ask_assistant); otherwise ask the user.', description: 'An error: an agent tried to move card {card} (its key, such as HI-12) On Hold (a board column), which only the user or the Assistant may do (HI-2227): a decision already made goes to the Assistant, cw_ask_assistant (a tool name: keep it as it is), else the user is asked.' }), { card: cardRef(n) })
      : msg({ id: 'tasks.error.holdNew', defaultMessage: 'Only the user or the Assistant puts cards On Hold. Add it to Todo; where the user has decided to park it, ask the Assistant (cw_ask_assistant), otherwise ask the user.', description: 'An error: an agent tried to add a card On Hold (a board column), which only the user or the Assistant may do (HI-2227): add it to Todo, then a decision already made goes to the Assistant, cw_ask_assistant (a tool name: keep it as it is), else the user is asked.' })
  )
}

/**
 * Where a change puts a card in `column`: before a card, at the top or bottom, or (without either) at the end. An
 * agent's or the Assistant's explicit placement is checked (the card it names has to be in the column; never in
 * Done) and, when it moves the card, says so for the history; the user's drags are saved quietly.
 */
function placement(all: CardPlace[], card: TaskCard, column: TaskColumn, patch: TaskPatch, actor: TaskActor): { order: number; said?: StoredText } {
  const { before, position } = patch
  const placed = (before !== undefined && before !== null) || position !== undefined
  if (position !== undefined && position !== 'top' && position !== 'bottom') throw combworkError(msg({ id: 'tasks.error.unknownPosition', defaultMessage: 'Unknown position "{position}": top or bottom.', description: 'An error: the call\'s position was {position}, which it doesn\'t take. "top" and "bottom" are the values it takes: keep them as they are.' }), { position: String(position) }, { kind: 'invalid' })
  if (placed && before !== undefined && before !== null && position !== undefined) throw combworkError(msg({ id: 'tasks.error.beforeOrPosition', defaultMessage: 'Give before or position, not both.', description: 'An error: the call gave both of its fields "before" and "position" (keep them as they are), which place a card in two ways.' }), undefined, { kind: 'invalid' })
  const list = all.filter((c) => c.column === column && !c.archived && c.number !== card.number)
  // A confined agent places its card among its project's cards: the top and bottom of those, never past another project's.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  if (placed && actor.kind !== 'user') {
    if (column === 'done') throw new TaskPermissionError(ERR.onlyUserDone)
    if (before != null && !own.some((c) => c.number === before)) {
      const other = all.find((c) => c.number === before && inScope(c, scope))
      if (before === card.number) throw combworkError(msg({ id: 'tasks.error.beforeItself', defaultMessage: "A card can't go before itself.", description: 'An error: a card was to be placed just above itself.' }), undefined, { kind: 'invalid' })
      if (!other) throw combworkError(ERR.noCard, { card: cardRef(before) }, { kind: 'invalid' })
      // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
      if (other.archived) throw combworkError(msg({ id: 'tasks.error.beforeArchived', defaultMessage: "{before} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: {card} can only go before a card in the column it's in.", description: 'An error: card {card} was to be placed just above card {before} (their keys, such as HI-12), which is archived, not in the column {column} (select: a board column; translate each).' }), { before: cardRef(before), column, card: cardRef(card.number) }, { kind: 'conflict' })
      throw combworkError(msg({ id: 'tasks.error.beforeElsewhere', defaultMessage: "{before} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: {card} can only go before a card in the column it's in.", description: 'An error: card {card} was to be placed just above card {before} (their keys, such as HI-12), which is in the column {other}, not in {column} (select: board columns; translate each).' }), { before: cardRef(before), other: other.column, column, card: cardRef(card.number) }, { kind: 'invalid' })
    }
  }
  const order =
    scope !== null && position === 'top'
      ? orderIn(all, column, card.number, own[0]?.number ?? null)
      : scope !== null && position === 'bottom'
        ? orderIn(all, column, card.number, own.length ? (list[list.indexOf(own[own.length - 1]) + 1]?.number ?? null) : null)
        : position === 'top'
          ? list.length
            ? list[0].order - 1
            : 1
          : orderIn(all, column, card.number, position === 'bottom' ? null : before)
  if (!placed || actor.kind === 'user') return { order }
  const moved = column !== card.column
  // Within its column, a placement that leaves it where it was isn't worth a line.
  const rank = (o: number): number => sortCards([...list, { ...card, column, order: o }]).findIndex((c) => c.number === card.number)
  if (!moved && rank(card.order) === rank(order)) return { order }
  const said =
    position === 'top'
      ? storedText(HISTORY.movedTop, { column })
      : position === 'bottom'
        ? storedText(HISTORY.movedBottom, { column })
        : moved
          ? storedText(HISTORY.movedBefore, { column, before: cardRef(before!) })
          : storedText(HISTORY.movedBeforeIn, { column, before: cardRef(before!) })
  return { order, said }
}

/**
 * Puts cards at the top of a column in the order given; the column's other cards keep their order below them. The
 * listed cards have to be in that column already (this never moves cards between columns), and only the user puts
 * Done in order. An agent's or the Assistant's list adds a line to each card it moved. `commit`: a revocable caller's
 * check (HI-2420, the Assistant's guard), made as each card is saved: one batch, so a refusal part way saves none.
 */
export function reorderTasks(column: TaskColumn, numbers: unknown, actor: TaskActor, opts: { commit?: () => void } = {}): Promise<TaskCard[]> {
  return recordingAs(actor, () => cardBatch(workspace, () => boardLock(workspace, () => reorderTasksLocked(column, numbers, actor, opts.commit))))
}

async function reorderTasksLocked(column: TaskColumn, numbers: unknown, actor: TaskActor, commit?: () => void): Promise<TaskCard[]> {
  if (!isTaskColumn(column)) throw unknownColumn(column)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(ERR.onlyUserDone)
  if (!Array.isArray(numbers) || !numbers.length) throw combworkError(msg({ id: 'tasks.error.orderNone', defaultMessage: 'cards: list the card numbers in the order wanted.', description: 'An error: a call to put cards in order listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > 500) throw combworkError(ERR.cardsTooMany, { max: 500 }, { kind: 'invalid' })
  const nums = checkedNumbers(numbers)
  const ws = workspace
  const by = actorName(actor)
  const W = COLUMN_WORD[column]
  const all = await boardPlaces(ws)
  const list = all.filter((c) => c.column === column && !c.archived)
  // A confined agent orders its project's cards only, and they stay where the project's cards are in the column.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  for (const x of nums) {
    if (own.some((c) => c.number === x)) continue
    const other = all.find((c) => c.number === x && inScope(c, scope))
    if (!other) throw combworkError(ERR.noCard, { card: cardRef(x) }, { kind: 'invalid' })
    // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
    if (other.archived) throw combworkError(msg({ id: 'tasks.error.orderArchived', defaultMessage: '{card} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card {card} (its key, such as HI-12) was listed to be put in order in the column {column}, but it is archived (select: a board column; translate each).' }), { card: cardRef(x), column }, { kind: 'conflict' })
    throw combworkError(msg({ id: 'tasks.error.orderElsewhere', defaultMessage: '{card} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card {card} (its key, such as HI-12) was listed to be put in order in the column {column}, but it is in the column {other} (select: board columns; translate each).' }), { card: cardRef(x), other: other.column, column }, { kind: 'invalid' })
  }
  // The listed cards take the place of the first of the cards in view, in the order given; the rest keep theirs below.
  const first = own[0]
  const above = list[list.indexOf(first) - 1]
  const orderAt = (i: number): number => (above ? above.order + ((first.order - above.order) * (i + 1)) / (nums.length + 1) : first.order - nums.length + i)
  for (const [i, x] of nums.entries()) {
    const was = own.findIndex((c) => c.number === x)
    await (async () => {
      const card = await getTask(x, ws)
      // Every write is the caller's to make on the card as it is now: moved to another project since the list was
      // read, it is unknown to a confined agent (its order and history stay as they are).
      if (!inScope(card, scope)) throw unknownTask(x)
      // Moved or archived since the list was read: the order asked for no longer holds.
      if (card.column !== column || card.archived) throw combworkError(msg({ id: 'tasks.error.orderChanged', defaultMessage: '{card} changed while the cards were being put in order; read the board again.', description: 'An error: card {card} (its key, such as HI-12) moved or was archived while the cards were being put in order, so the order asked for no longer holds.' }), { card: cardRef(x) }, { kind: 'conflict' })
      card.order = orderAt(i)
      if (was !== i && actor.kind !== 'user') note(card, by, i === 0 ? storedText(HISTORY.movedTop, { column }) : storedText(HISTORY.placed, { place: i + 1, column }))
      await saveCard(ws, x, card, undefined, undefined, commit)
    })()
  }
  log.info(`${W} put in order by ${userText(by)}: ${nums.map((x) => `#${x}`).join(', ')}`)
  changed(ws)
  return (await allTasks(ws, { archived: false })).filter((c) => c.column === column && inScope(c, scope))
}

/** Words quoted in a history line, cut short. */
const clip = (s: string, max = 80): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** A reviewer's request to its builder (#912) as its history line, which watches count (#1272). */
export const requestNote = (asked: string): StoredText => storedText(HISTORY.reviewerRequest, { text: clip(asked) })

/** A card loop's step (#1382) as its history line, which watches count (shared/watch.ts' handoffs); an answer says what it checked (`of`, #1467). */
export const loopStepNote = (step: string, said: string, until?: string, of?: string): StoredText => {
  const s = storedText(HISTORY.loopStep, { step: of === 'followUp' && (step === 'ok' || step === 'gaps') ? `${step}FollowUp` : step, text: clip(said) })
  // A design's line keeps when its check is due (#1382), a value its words don't show: what the stall check reads.
  return until ? { ...s, values: { ...s.values, until } } : s
}

/**
 * Whether a comment counts as its reviewer's request to the builder (#1410): a plain comment (no move, no verdict) by
 * the reviewer of the card's running lane, on its card in Review that it hasn't started reviewing ("waiting for #12
 * first"), so its builder is woken as for cw_request_builder. Off with the project's loop wakes (Card loops → Wake
 * reviewers and builders). Read in the change, on the card as it is then.
 */
async function laneReviewerAsks(ws: WorkspaceService, card: TaskCard, patch: TaskPatch, actor: TaskActor, said: StoredText[]): Promise<boolean> {
  const self = actor.kind === 'agent' ? actor.self : undefined
  if (!self || !card.project || !ws.path || said.length || patch.column !== undefined || patch.review !== undefined) return false
  if (card.archived || card.column !== 'review' || card.review || !card.agent || card.agent === self.agentId) return false
  if (FactStore.forBoard(ws, { project: card.project, key: '' }).card(card.number).reviewer !== self.agentId) return false
  const path = join(ws.path, card.project)
  return projectPreferences(ws, path, await ws.projectConfig(path).catch(() => null)).loopWakes
}

/** A card's arrival in Review for a round: a submission, a return for review, a follow-up handed over (HI-1832). */
const ROUND_START = /^(Moved to (the (top|bottom) of )?Review\b|Returned for review\b|Follow-up submitted\b)/

/**
 * Whether a comment counts as its builder's reply to its reviewer (HI-2302, the other way of #1410): a plain comment (no
 * move, no verdict) by the card's agent, on its card in Review, after the card's loop reviewer (loopReviewerOf: its
 * lane's, or the pool's for this round) commented on it in this round, so that reviewer is woken with it (a loop wake);
 * on PE-39 the builder's answer to a reviewer's question reached nobody. Off with the project's loop wakes. Read in the
 * change, on the card as it is then.
 */
async function builderReplies(ws: WorkspaceService, card: TaskCard, patch: TaskPatch, actor: TaskActor, said: StoredText[]): Promise<boolean> {
  const self = actor.kind === 'agent' ? actor.self : undefined
  if (!self || !card.project || !ws.path || said.length || patch.column !== undefined || patch.review !== undefined) return false
  if (card.archived || card.column !== 'review' || !card.agent || card.agent !== self.agentId) return false
  const reviewer = await loopReviewerOf(ws, card)
  if (!reviewer || reviewer.id === self.agentId) return false
  const start = card.history.findLast((h) => ROUND_START.test(h.what))
  if (!card.comments.some((c) => c.by.toLowerCase() === reviewer.name.toLowerCase() && (!start || c.at >= start.at))) return false
  const path = join(ws.path, card.project)
  return projectPreferences(ws, path, await ws.projectConfig(path).catch(() => null)).loopWakes
}

/** A builder's reply to its reviewer (HI-2302) as its history line, which watches count and the recorder wakes the reviewer with. */
export const replyNote = (said: string): StoredText => storedText(HISTORY.builderReply, { text: clip(said) })

/**
 * A comment's own history line in a card loop, whichever way it is written (a change with a comment, or a comment alone,
 * HI-2428: cw_update_task with only a comment is commentTask's, where neither was read, so on HI-2410 a pool
 * reviewer's builder answered it twice and nobody was woken): a lane reviewer's request to its builder (#1410), or its
 * builder's reply to its reviewer (HI-2302). Null: only a comment.
 */
async function commentNote(ws: WorkspaceService, card: TaskCard, patch: TaskPatch, actor: TaskActor, said: StoredText[], comment: string): Promise<StoredText | null> {
  if (await laneReviewerAsks(ws, card, patch, actor, said)) return requestNote(comment)
  if (await builderReplies(ws, card, patch, actor, said)) return replyNote(comment)
  return null
}

/**
 * Whether the acting agent is the reviewer of a card it moves back from Review or Passed (HI-1832): the one reviewing it
 * now (its board review), or its running lane's reviewer (the board's own record). Such a move leaves the card its
 * builder's: on HI-1772 a reviewer's move to Doing gave the card to the reviewer and ended its builder's watch. Anyone
 * else's move keeps taking it.
 */
function reviewerMovesBack(ws: WorkspaceService, card: TaskCard, actor: TaskActor): boolean {
  const self = actor.kind === 'agent' ? actor.self : undefined
  if (!self || !card.project || !card.agent || card.agent === self.agentId || (card.column !== 'review' && card.column !== 'passed')) return false
  if (card.review?.agent === self.agentId) return true
  try {
    return FactStore.forBoard(ws, { project: card.project, key: '' }).card(card.number).reviewer === self.agentId
  } catch {
    return false
  }
}

/** A message within a history line's values: a CLI's sentence (providerMessage) or the workflow's (a request's, #1266). */
const lineMessage = (id: string): Msg | null => providerMessage(id) ?? workflowMessage(id)

/** A history line's English, from its message and values: what agents read and Combwork's own code matches (`what`). */
const englishSaid = (s: StoredText): string => {
  const t = storedLineText(s, agentEnglish, lineMessage)
  if (t === null) throw new Error(`No history line ${s.id}`) // i18n-ignore: a mistake in Combwork's code, never shown
  return t
}

/**
 * A line in the card's history: its English (`what`), and as data (`whatText`, #846) for the window to show in its
 * language. Text from elsewhere (an agent-facing note, noteOnCard) is kept in English only.
 */
/**
 * The time of a change to a card (HI-2315): now, or a millisecond after the card's latest entry or change when now isn't
 * later (two changes written back to back in one millisecond, or the clock set back). A card's changes so come in time
 * order across its history and comments, which only times relate: a watch begun after the watcher's own comment
 * (watch.ts ownCut) tells a reassignment just before that comment from one after it.
 */
function changeTime(card: TaskCard): string {
  const now = Date.now()
  const latest = Math.max(...[card.updatedAt, card.history.at(-1)?.at, card.comments.at(-1)?.at].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t)), -Infinity)
  return new Date(now > latest ? now : latest + 1).toISOString()
}

/** Adds a line to a card's history, at `at` (a change's one time, HI-2016, from changeTime) or as a change of its own. */
function note(card: TaskCard, by: string, said: StoredText | string, at = changeTime(card)): void {
  card.history = [...card.history, entryOf(at, by, said)].slice(-MAX_HISTORY)
  card.updatedAt = at
}

const entryOf = (at: string, by: string, said: StoredText | string): TaskHistoryEntry =>
  typeof said === 'string' ? { at, by, what: said, id: entryId() } : { at, by, what: englishSaid(said), whatText: said, id: entryId() }

/** Column names in English, for the log. */
const COLUMN_WORD = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>

/**
 * A board message in agents' English (#1458): the window's words say Active and Approved for doing and passed, while
 * agents read the columns' own names (TASK_COLUMNS: Doing, Passed). Each column value (`column`, `other`) is given as
 * that name, which the message's column select says through its `other {{column}}`, as every board message's does.
 */
export function agentEnglish(m: Msg, values?: TextValues): string {
  return englishText(agentColumns(m, values)) // agent-stored: a history line's `what`, re-rendered for each reader by storedForAgents
}

/** A board message with agents' column names for its values (agentEnglish): text to say for agents, or store. */
export function agentColumns(m: Msg, values?: TextValues): Text {
  if (!values) return m
  const named = (k: string, v: TextPart): TextPart => ((k === 'column' || k === 'other') && isTaskColumn(v) ? COLUMN_WORD[v] : v)
  return withValues(m, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, named(k, v)])))
}

/**
 * A stored line or comment for an agent (dialects, HI-2440): said again in the reader's chain where the chain overrides
 * a message it names (its own, or one stored inside its values), whatever wording the English had when it was stored:
 * with no such override, a line reads exactly as stored. An id this Combwork doesn't know (storedLineText's null) reads as
 * stored too. A comment whose agents' English is worded apart from its window message (`agent`, HI-2087's return) is
 * said again from its own data: as stored unless the chain changes what it says.
 */
// agent-text: HISTORY (each line by its stored id)
setStoredForAgents((english, stored) => {
  const s = stored as Partial<StoredText> | null
  if (s?.agent) {
    if (!currentChain()) return english
    const said = storedAgentText(s.agent)
    return said === null || said === inDefaultDialect(() => storedAgentText(s.agent!)) ? english : said
  }
  // Compatibility: a return comment written before its data was kept (HI-2440 round 3) can't be said again: as stored.
  if (s?.id === HISTORY.queueReturned.id) return english
  if (!overridesAny(storedIds(stored))) return english
  return storedLineText(stored, (m, values) => agentText(agentColumns(m, values)), lineMessage) ?? english
})
setStoredAgentRenderer(RETURNED_COMMENT, returnedCommentFrom)

/** A board error naming columns: the window's words in its language, agents' as before (agentColumns), in their dialect. */
export const columnError = (m: Msg, values: TextValues, options?: { kind?: CombworkErrorKind }): CombworkError => new CombworkError(forAgents(withValues(m, values), agentColumns(m, values)), options)

const unknownColumn = (column: unknown): CombworkError => combworkError(ERR.unknownColumn, { column: String(column), choices: COLUMN_CHOICES }, { kind: 'invalid' })

/** Card numbers as a call lists them ("#3" or 3), each checked: a whole number, listed once. */
function checkedNumbers(numbers: unknown[]): number[] {
  const nums = numbers.map((x) => Number(String(x).replace(/^#/, '')))
  const seen = new Set<number>()
  for (const x of nums) {
    if (!Number.isInteger(x) || x < 1) throw combworkError(ERR.cardsNotNumber, { value: String(x) }, { kind: 'invalid' })
    if (seen.has(x)) throw combworkError(ERR.cardsTwice, { card: cardRef(x) }, { kind: 'invalid' })
    seen.add(x)
  }
  return nums
}

/** Who can return a failed card for review: its own agent (its Combwork tools, or the Agent API with its token) or the user. */
const returnsCard = (actor: TaskActor, card: TaskCard): boolean => actor.kind === 'user' || (actor.kind === 'agent' && !!card.agent && actor.self?.agentId === card.agent)

export async function createTask(...args: Parameters<typeof createTaskLocked>): Promise<TaskCard> {
  const [input, actor] = args
  const ws = workspace
  // Made in Doing or Review with an agent, its work starts or is submitted: the platform's reads, before the change (#1216).
  const column = input.column ?? 'todo'
  // A project agent's card made in Doing, Review or Passed, with the rules enforced (#1268): made in Todo, then moved by
  // the intent that column stands for, in one change, refused whole as the intent is. A column the project's rules
  // don't have (Review with no review) is made there as before (HR2's #1268 round 2), as a move to it is.
  if (actor.kind === 'agent' && actor.self && (column === 'doing' || column === 'review' || column === 'passed') && (await agentTranslates(ws, actor, input, column))) {
    return cardBatch(ws, async () => {
      const card = await recording(actor, null, () => createTaskLocked({ ...input, column: 'todo' }, actor))
      // Given to another agent: started for it (its builder), the card staying its.
      const move: TaskPatch = { column, ...(card.agent && card.agent !== actor.self?.agentId ? { agent: card.agent } : {}) }
      const g = await agentGateOf(ws, card.number, move, actor)
      // Never left in Todo: with no intent to run after all, P3's move to the column asked for.
      return g ? moveAsAgent(g, card.number, move, actor) : recordingAs(actor, () => updateTaskAs(card.number, move, actor, {}))
    })
  }
  const project = (column === 'doing' || column === 'review') && ws.path ? await projectName(scopeOf(actor) !== null && input.project === undefined ? scopeOf(actor)! : input.project).catch(() => '') : ''
  const agent = project ? await agentIdIn(ws, project, input.agent ?? selfIn(actor, project)) : null
  const reads = agent ? await gatherReads(ws, [{ number: NEW_CARD, project, agent, why: column === 'doing' ? 'start' : 'submit' }]) : null // i18n-ignore: an internal value
  return recording(actor, reads, () => boardLock(ws, () => createTaskLocked(...args)))
}

/** The Assistant's card made in Doing with nobody on it (HI-2062): refused, naming the user's three choices. */
export const DOING_NOBODY_NEW = msg({ id: 'tasks.error.doingNobodyNew', defaultMessage: 'A card made in Active needs an agent on it (agent). Ask the user which they want: an agent on it, an agent started on it (make it in Todo, then cw_start_task), or nobody on it (make it in Todo, then move it with override and their reason).', description: "An error said to the Combwork Assistant (HI-2062): it made a card straight into the Active stage with no agent on it. agent, override and cw_start_task are names of a call's fields and a tool: keep them as they are. Active and Todo are stage names." })

async function createTaskLocked(
  input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; blocked?: string | null; blockedBy?: number[]; links?: number[]; context?: string[]; kind?: CardKind; skipReview?: string },
  actor: TaskActor,
  opts: { commit?: () => void } = {}
): Promise<TaskCard> {
  if (!workspace.path) throw combworkError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const title = text(input.title, MAX_TITLE, 'title').trim()
  if (!title) throw needsTitle()
  const column = input.column ?? 'todo'
  if (!isTaskColumn(column)) throw unknownColumn(column)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserDone', defaultMessage: 'Only the user puts cards in Done.', description: 'An error: an agent or the Assistant tried to add a card straight into Done (a board column), which only the user does.' }))
  checkHold(column, actor)
  // A confined agent's cards are its project's (by default too); never another project's or the workspace's.
  const scope = scopeOf(actor)
  const project = await projectName(scope !== null && input.project === undefined ? scope : input.project)
  if (!inScope({ project }, scope)) throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.addOwnOnly', defaultMessage: 'You can add cards only to your project ({project}).', description: "An error: an agent tried to add a card to another project, or to the whole workspace; it adds cards only to its own project ({project}, its folder name)." }), { project: scope ?? '' }))
  // An agent that puts a new card straight into Doing, naming no agent, is taking it.
  const own = column === 'doing' && input.agent === undefined ? selfIn(actor, project) : null
  const agent = input.agent ? await agentOf(project, input.agent) : own ? await agentOf(project, own) : null
  // The Assistant's card made in Doing with nobody on it (HI-2062): which the user wants is theirs, as a move's is.
  if (actor.kind === 'assistant' && column === 'doing' && project && !agent) throw new TaskConflictError(DOING_NOBODY_NEW)
  const ws = workspace
  const by = actorName(actor)
  const now = new Date().toISOString()
  const blockedBy = input.blockedBy ? await cardRefs(input.blockedBy, null, 'blockedBy', scope) : []
  const links = input.links ? await cardRefs(input.links, null, 'links', scope) : []
  const context = input.context ? contextOf(input.context) : []
  const problems = context.length ? await contextProblems(project && workspace.path ? join(workspace.path, project) : null, workspace.sharedDir, context) : []
  // Its kind (#1277, §16.7.3): the user's or the Assistant's from the start; a project agent's only proposed (OP-6/OP-7).
  const kind = kindOf(input.kind)
  const proposes = kind === 'no-code' && actor.kind === 'agent'
  // Review: Skip (#1625): the user's (an optional note) or the Assistant's (the user's reason) from the start; a project
  // agent's (with its reason) only proposed. Only where the card's rules review.
  const skipReason = input.skipReview === undefined ? null : reviewSkipArg(input.skipReview)
  if (skipReason === false) throw combworkError(msg({ id: 'tasks.error.badReviewSkipNew', defaultMessage: "A new card reviews as its rules say: give skipReview the user's reason to skip it, or leave it out.", description: "An error: a card was made with skipReview false. Keep skipReview as it is (a field's name)." }), undefined, { kind: 'invalid' })
  if (skipReason !== null && actor.kind !== 'user' && !skipReason) throw new TaskConflictError(SKIP.needsReason)
  if (skipReason !== null && !(await reviewsOf(ws, project, null))?.reviews) throw new TaskConflictError(SKIP.nothingNew)
  const n = await nextNumber(ws)
  const card: TaskCard = {
    number: n,
    title,
    description: text(input.description, MAX_TEXT, 'description'),
    project,
    agent: agent?.id ?? null,
    ...(agent ? { agentName: agent.name } : {}),
    column,
    order: orderIn(await boardPlaces(ws), column, null, null),
    labels: input.labels ? labelsOf(input.labels) : [],
    blocked: input.blocked?.trim() ? text(input.blocked.trim(), 1000, 'blockedReason') : null,
    blockedBy,
    links,
    ...(context.length ? { context } : {}),
    ...(problems.length ? { contextProblems: problems } : {}),
    comments: [],
    history: [
      entryOf(now, by, storedText(HISTORY.created, { column })),
      ...(kind === 'no-code' ? [entryOf(now, by, storedText(HISTORY.kind, { how: proposes ? 'proposed' : 'made', kind }))] : []),
      ...(skipReason !== null ? [entryOf(now, by, storedText(HISTORY.reviewSkip, { how: actor.kind === 'agent' ? 'proposed' : 'set' }))] : [])
    ],
    archived: false,
    createdAt: now,
    createdBy: by,
    updatedAt: now
  }
  const store = kind === 'no-code' ? FactStore.forBoard(ws, { project: card.project, key: '' }) : null
  // A revocable caller's authority checked as it is written (HI-2415: saveCard's `commit`), so a revoked one makes no card.
  await saveCard(ws, n, card, null, store && !proposes ? () => store.updateCard(n, { kind }) : undefined, opts.commit)
  if (store && proposes) store.tx((tx) => tx.append(n, { kind: 'KindProposed', actor: actorOf(actor), source: 'recorded', data: { kind } }))
  if (skipReason !== null) {
    const facts = store ?? FactStore.forBoard(ws, { project: card.project, key: '' })
    const setBy = actor.kind === 'assistant' ? 'assistant' : 'user'
    facts.tx((tx) => tx.append(n, actor.kind === 'agent' ? { kind: 'ReviewSkipProposed', actor: actorOf(actor), source: 'recorded', data: { reason: skipReason } } : { kind: 'ReviewSkipSet', actor: actorOf(actor), source: 'recorded', data: { skip: true, by: setBy, reason: skipReason } }))
  }
  log.info(`#${n} created by ${userText(by)}: ${userText(title)}`)
  changed(ws)
  return card
}

/**
 * Changes a card. Anyone moves it between columns, Done included (each move is in its history, with who made it),
 * except into On Hold (the user's and the Assistant's); putting Done in order is the user's. An archived card only
 * changes once the user brings it back.
 */
/**
 * Changes a card. `comment` is the same call's comment (the Combwork tools' and PATCH's): saved with the change in one write,
 * so nothing that reads the card meanwhile (a card watch waking its agent, the board) sees the move without it.
 */
export async function updateTask(...args: Parameters<typeof updateTaskLocked>): Promise<TaskCard> {
  const [n, patch, actor, opts = {}] = args
  const ws = workspace
  // HI-1932: a decision naming the requests it answers, its own path (one write with its answers).
  if (patch.answers !== undefined) return decideAndAnswer(n, patch, actor, opts)
  checkOverride(patch, actor)
  // The user's or the Assistant's column move, through the card's workflow rules (#1265): its reads made by the runtime,
  // before its own lock; the rest of the change saved with the move, in its transaction.
  const gate = await gateOf(ws, n, patch, actor)
  if (gate) return moveThrough(gate, n, patch, actor, opts)
  // An agent's column move or review, translated into its intent for one transition (#1268).
  const asAgent = await agentGateOf(ws, n, patch, actor)
  if (asAgent) return moveAsAgent(asAgent, n, patch, actor, opts)
  const reads = await gatherReads(ws, await planned(ws, [n], patch, actor))
  return recording(actor, reads, () => boardLock(ws, () => updateTaskLocked(...args)))
}

/** An override is the user's or the Assistant's (SPEC §16.8.4): agents never override a rule. */
function checkOverride(patch: TaskPatch, actor: TaskActor): void {
  if (patch.override === undefined) return
  if (actor.kind === 'agent') throw new TaskPermissionError(msg({ id: 'tasks.error.overrideNotAgents', defaultMessage: "Agents can't override workflow rules: only the user or the Assistant can.", description: 'An error: an agent passed an override (moving a card across a workflow rule, with a reason); only the user or the Combwork Assistant can.' }))
  if (!patch.override || typeof patch.override !== 'object' || typeof patch.override.reason !== 'string') throw combworkError(msg({ id: 'tasks.error.overrideShape', defaultMessage: 'An override needs a reason: why the card moves across its rules, as text.', description: 'An error: an override (moving a card across a workflow rule) was passed without its reason as text.' }), undefined, { kind: 'invalid' })
}

/** A column move the workflow runtime makes: the card's runtime, the stage it goes to, by whom, and the agent a start gives it to. */
interface Gate {
  wf: Workflow
  to: StageId
  by: 'user' | 'assistant'
  builder?: string
}

/**
 * Whether a change is a column move through the card's workflow rules (#1265, SPEC §16.7.1): the user's or the
 * Assistant's (agents' moves are #1268's), with the rules enforced (Settings → Advanced), of a card from 1.0 (one from
 * before keeps P3's path until it starts) in a project with a platform, to a stage its ruleset has. A column its
 * ruleset doesn't have (Review with no review, say) keeps P3's recorded move until the board asks about it (#1290).
 */
async function gateOf(ws: WorkspaceService, n: number, patch: TaskPatch, actor: TaskActor, o: { anyStage?: boolean } = {}): Promise<Gate | null> {
  if (patch.column === undefined || !isTaskColumn(patch.column) || (actor.kind !== 'user' && actor.kind !== 'assistant')) return null
  // Imported when first needed: the service reaches the board's notices (#1266), which reach back here.
  const { workflowEnforced, workflowFor } = await import('./workflow/service')
  if (!ws.path || !workflowEnforced()) return null
  const head = cardHeads(ws, [n])[0]
  if (!head || typeof head.project !== 'string' || !head.project || head.column === patch.column) return null
  const wf = await workflowFor(ws, join(ws.path, head.project)).catch(() => null)
  if (!wf) return null
  const rec = (() => {
    try {
      return wf.store.card(n)
    } catch {
      return null
    }
  })()
  if (!rec) return null
  const to = CATEGORY_STAGE[patch.column]
  const s = wf.state(rec)
  if (rec.preWorkflow && !startsOld(s.stage, to)) return null
  // A stage its ruleset lacks: refused by the runtime with why (the window's move, `anyStage`); the board's other moves
  // keep P3's recorded move until the window asks through tasks:move (#1275), so today's columns go on working.
  if (s.stage === to || (!o.anyStage && !hasStage(wf.rulesetOf(rec, s), to))) return null
  // The agent it is started for: one named, else the card's, which a change of project takes off (HI-2062).
  const leaves = patch.project !== undefined && patch.project !== head.project
  const agent = patch.agent !== undefined ? await agentIdIn(ws, head.project, patch.agent) : !leaves && typeof head.agent === 'string' && head.agent ? head.agent : null
  // An agent named that the project lacks is its own error (agentOf's), never a start for nobody (HI-2062).
  if (!agent && typeof patch.agent === 'string' && patch.agent) await agentOf(head.project, patch.agent)
  return { wf, to, by: actor.kind, ...(agent ? { builder: agent } : {}) }
}

/**
 * Whether a move of a card from before 1.0 is its start (HI-1966): into Active from Todo, or from Done (reopened). That
 * start is the runtime's, as an intent's is (HI-1674), so it gets a slot where the project builds in slots and the card
 * becomes a 1.0 card; P3's recorded start lent none and recorded the agent's 0.9 worktree, or the project folder (rc.9:
 * the Assistant's Start of HI-1612 launched HB2 in the main checkout). Its other moves keep P3's path until it starts.
 */
const startsOld = (stage: StageId, to: StageId): boolean => to === 'active' && (stage === 'todo' || stage === 'done')

/** An agent's move or review translated into the intent it stands for (#1268): the card's runtime, and which. */
interface AgentGate {
  wf: Workflow
  column?: 'doing' | 'review' | 'passed' | 'done' | 'todo'
  review?: 'start' | 'passed' | 'failed'
  /** Doing: the agent the card is started for, when the change gives it to another. */
  builder?: string
}

/**
 * Whether a project agent's change (its own token) is an old move translated into an intent, for one transition (#1268,
 * SPEC §16.17: P4 until P8 rewrites the skills): its `review` (start: start review; passed, failed: a verdict on the
 * latest submission) or its column (Doing: start, Review: submit, Passed: a passing verdict, Done: report merge, Todo:
 * put back), with the rules enforced, of a card from 1.0 in a project with a platform. Every new cycle is a start (from
 * Todo, a Done card reopened, a card On Hold never started; given to another agent: started for it). Anything else
 * keeps P3's path: the rules off (the agents' moves of 0.9, its checks only), a card from before 1.0 until it starts, a
 * column the card is in already, back into Doing from Review or Passed (the same cycle), a column its ruleset lacks (and
 * a card in one, or On Hold while worked on), another agent's card in Doing moved on (its refusal), and scripts (the
 * workspace's token).
 */
async function agentGateOf(ws: WorkspaceService, n: number, patch: TaskPatch, actor: TaskActor): Promise<AgentGate | null> {
  // Combwork starting a lane's next card on its builder (HI-1990, laneStarts.ts): its start for that agent, as an agent's move
  // giving a card to another is, and the put back undoing it; nothing else of Combwork's.
  const laneStart = actor === CW_LANE_START
  if (actor.kind !== 'agent' || (!actor.self && !laneStart)) return null
  if (laneStart && (patch.review !== undefined || (patch.column === 'doing' ? !patch.agent : patch.column !== 'todo'))) return null
  const review = patch.review === 'start' || patch.review === 'passed' || patch.review === 'failed' ? patch.review : undefined
  // A review's start with a move or an agent is refused by P3's checks (a review starts on its own); one of another value too.
  if (patch.review !== undefined && (!review || (review === 'start' && (patch.column !== undefined || patch.agent !== undefined)))) return null
  // A failed review moved anywhere but Doing: refused by P3's check (HI-1946), before anything is written, on either path.
  if (review === 'failed' && patch.column !== undefined && patch.column !== 'doing') return null
  const column = patch.column
  if (!review && (column === undefined || !isTaskColumn(column) || column === 'hold')) return null
  const { workflowEnforced, workflowFor } = await import('./workflow/service')
  if (!ws.path || !workflowEnforced()) return null
  const head = cardHeads(ws, [n])[0]
  if (!head || typeof head.project !== 'string' || !head.project || !inScope({ project: head.project }, scopeOf(actor))) return null
  // Another agent's card in Doing, moved on: refused by P3's check, as before (its work is in progress).
  if (!review && column !== 'doing' && column !== 'todo' && head.column === 'doing' && typeof head.agent === 'string' && head.agent && head.agent !== actor.self?.agentId) return null
  const wf = await workflowFor(ws, join(ws.path, head.project)).catch(() => null)
  if (!wf) return null
  const rec = (() => {
    try {
      return wf.store.card(n)
    } catch {
      return null
    }
  })()
  if (!rec) return null
  // A column its rules don't have (Review in a project with no review), and a review there: P3's move, as the user's
  // (#1290), so today's columns go on working until the skills use the intents.
  // So does a card in such a column (moved there by P3's path), and one On Hold (the user's: an agent takes it out when
  // the user asks it to work on it).
  const s = wf.state(rec)
  // A card from before 1.0: only its start is translated (HI-1966), the rest P3's until then.
  if (rec.preWorkflow && (review || !startsOld(s.stage, CATEGORY_STAGE[column as TaskColumn]))) return null
  const r = wf.rulesetOf(rec, s)
  // A card On Hold never started is started by its move to Doing, as from Todo (HR2's #1268 round 1: a new cycle always
  // goes through Start's guards); one held while being worked on goes back to it by P3's move.
  const heldNew = s.stage === 'hold' && !s.started && column === 'doing' && !review
  if ((s.stage === 'hold' && !heldNew) || (!heldNew && !hasStage(r, s.stage)) || !hasStage(r, review ? 'review' : CATEGORY_STAGE[column as TaskColumn])) return null
  if (review) return { wf, review }
  if (STAGE_CATEGORY[s.stage] === column) {
    // A card failed by a review before the transition, still in Review, returned for review by its agent (#214): its
    // new submission. Any other move to where the card is moves nothing.
    const card = column === 'review' ? await getTask(n, ws).catch(() => null) : null
    if (!card || !returnsCard(actor, card) || !returnRound(card)) return null
  }
  if (column !== 'doing') return { wf, column: column as AgentGate['column'] }
  // Back into Doing from Review or Passed (fixes, more work the user asked for): the same cycle, nothing started, so P3's
  // move, as before. A new cycle is a start, through Start's guards (HR2's #1268 round 1): from Todo, a Done card
  // reopened, a card On Hold never started.
  if (s.stage !== 'todo' && s.stage !== 'done' && !heldNew) return null
  // Given to another agent in the same change: started for that agent (its builder); an agent no project has, or none
  // (taken away), is P3's to refuse or keep in Doing unstarted.
  if (patch.agent === undefined) return { wf, column: 'doing' }
  const builder = patch.agent ? await agentIdIn(ws, head.project, patch.agent) : null
  return builder ? { wf, column: 'doing', builder } : null
}

/**
 * Whether a project agent's new card would have its column translated (#1268): the rules enforced, its project's runtime,
 * the column's stage in its rules (another agent named: started for it).
 */
async function agentTranslates(ws: WorkspaceService, actor: TaskActor & { kind: 'agent' }, input: { project?: string; agent?: string | null }, column: TaskColumn): Promise<boolean> {
  const { workflowEnforced, workflowFor } = await import('./workflow/service')
  if (!ws.path || !workflowEnforced() || !actor.self) return false
  const scope = scopeOf(actor)
  const project = await projectName(scope !== null && input.project === undefined ? scope : input.project).catch(() => '')
  if (!project || (input.agent && !(await agentIdIn(ws, project, input.agent)))) return false
  const wf = await workflowFor(ws, join(ws.path, project)).catch(() => null)
  // The column's stage in the rules a new card starts under (no lane yet: the current ones).
  return !!wf && hasStage(wf.currentRuleset(false), CATEGORY_STAGE[column])
}

/**
 * An agent's old move or review as its intent (#1268), on the one intent path (`runIntent`): the runtime's guards
 * decide (a refusal is the 409 contract, with that intent's rule), its facts are written once, and the card's 0.9 fields
 * follow in its write. Each is one write (a verdict with the review it starts, a Done card's reopening with its start),
 * so a refusal or an error leaves nothing of the change: its other fields and its comment (the submission's summary, the
 * verdict's comment, put back's why) go with that write. A start gives the card to the agent it is for; every other
 * write keeps the card's agent. The reply (`said`) names the intent's tool to call next time.
 */
async function moveAsAgent(g: AgentGate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}): Promise<TaskCard> {
  const self = actor.kind === 'agent' ? actor.self : undefined
  const { column: target, review: _review, before, position, ...rest } = patch
  const named = `#${n}`
  const who = actorOf(actor)
  // The comment checked before anything is gathered or written (HR2's #1268 round 1): an empty or oversized one refuses
  // the whole change, as P3's path does. Each translated intent is one write, so nothing else of it can half-apply.
  const words = opts.comment === undefined ? '' : commentText(opts.comment)
  const verdict = g.review === 'passed' || g.review === 'failed' || g.column === 'passed'
  let commented = false
  const { reply, saved } = await runIntent(
    g.wf,
    n,
    actor,
    (wf): Promise<Reply> => (g.review ? wf.agentReview(named, who, g.review, words) : wf.agentColumnMove(named, who, g.column!, { translate: true, summary: words, ...(g.builder ? { builder: g.builder } : {}) })),
    (w, first) => {
      const v = w.written.find((f) => f.kind === 'Verdict')
      const started = w.written.some((f) => f.kind === 'Started')
      const review: TaskPatch['review'] = v ? ((v.data as { pass: boolean }).pass ? 'passed' : 'failed') : w.written.some((f) => f.kind === 'ReviewStarted') ? 'start' : undefined
      const placed = target !== undefined && STAGE_CATEGORY[w.current] === target ? { ...(before !== undefined ? { before } : {}), ...(position !== undefined ? { position } : {}) } : {}
      // A verdict's comment goes with the verdict, never with the review it started first (a builder woken by the comment
      // reads the card as it is then).
      const withComment = !commented && (verdict ? !!v : true)
      if (withComment) commented = true
      return {
        patch: { ...(first ? rest : {}), ...placed, ...(review && self ? { review } : {}), ...(started && rest.agent === undefined && self ? { agent: self.agentId } : {}) },
        opts: { ...(first ? { check: opts.check, commit: opts.commit } : { commit: opts.commit }), said: opts.said, ...(withComment && opts.comment !== undefined ? { comment: opts.comment } : {}), keepAgent: !started }
      }
    }
  )
  if (isRefusal(reply)) throw new WorkflowRefusedError(reply)
  const intent = String((reply as { data?: { useNextTime?: string } }).data?.useNextTime ?? '')
  if (INTENT_TOOL[intent]) opts.said?.push(`As ${intent}: next time call ${INTENT_TOOL[intent]}`) // i18n-ignore: a tool reply, agent-facing
  return saved ?? (await getTask(n, workspace))
}

/** What a move through the rules came to: moved (the card as saved), asked (the rules it would skip), or refused. */
export type MoveResult = TaskMoveResult

/**
 * A column move through the card's runtime (#1265): the runtime's intents and facts, and in each of its writes the
 * card's 0.9 fields (column, place, history, agent, review), so the board, watches, lanes and the Agent API's card follow
 * it in the same transaction; the rest of the change (`patch`'s other fields, the comment) is saved with the first
 * write, its place with the write that reaches the column asked for. The user's move with `confirm` skips what it must
 * and records an `Override`; the Assistant's needs `override.reason` for that.
 */
/**
 * The one intent path (#1265, SPEC §16.7): runs a runtime intent of a card (`call`, given the card's runtime: start,
 * submit, a verdict, a move…) and, inside each write it makes, in the same transaction, the card's 0.9 fields that
 * readers still use (column, place, history, agent, review: watches, lanes, costs, the Agent API's card), so they
 * follow the stage the write left. `zero9(w, first)` says what else of the card that write changes (the change's other
 * fields with the first write; a verdict's history line…); its column is the stage's. The runtime writes the intent's
 * facts, so the recorder writes none of a move's (one owner per fact). The intent's own reads (the platform's) are made
 * by the runtime before its writes, outside the lock unless the caller holds it (a batch). Returns the intent's reply
 * and the card as last saved (null: nothing was written).
 */
export async function runIntent<R>(
  wf: Workflow,
  n: number,
  actor: TaskActor,
  call: (wf: Workflow) => Promise<R>,
  zero9: (w: Pick<Write, 'was' | 'current' | 'written'>, first: boolean) => { patch?: TaskPatch; opts?: Parameters<typeof updateTaskLocked>[3] } = () => ({}),
  // A revocable caller's check (HI-2420, the Assistant's guard): made as each of the card's writes saves the card, in
  // the write's own transaction after the runtime's facts, so a refusal undoes its facts too.
  commit?: () => void
): Promise<{ reply: R; saved: TaskCard | null }> {
  let saved: TaskCard | null = null
  let first = true
  const reply = await recording(actor, null, () =>
    alongside(
      {
        written: async (w) => {
          // Only this intent's own card's writes: another card's write made under its context (something it set off,
          // scheduled from inside it) is that card's business, never this card's 0.9 fields (#1287).
          if (w.card.id !== n) return
          const extra = zero9(w, first)
          first = false
          // Requests the write closed unanswered (#1638): a line each in the card's history.
          const closed = w.written.flatMap((f) => (f.kind === 'RequestClosed' ? [storedText(HISTORY.requestClosed, { why: (f.data as { why: string }).why })] : []))
          if (closed.length) extra.opts = { ...extra.opts, note: [...(extra.opts?.note ?? []), ...closed] }
          // The write's move, for the loop wake it makes (#1266: into Passed or Done wakes the builder).
          const moved = w.written.findLast((f) => f.kind === 'Moved')?.seq ?? null
          // Its column only when it moved: a write that moves nothing (an answer, a review's start) leaves the card's
          // place, so a failed card still in Review isn't "returned for review" by it (#1269 round 3).
          const p: TaskPatch = { ...extra.patch, ...(moved !== null ? { column: STAGE_CATEGORY[w.current] } : {}) }
          saved = await recordingByRuntime(() => updateTaskAs(n, p, actor, { ...extra.opts, was: STAGE_CATEGORY[w.was], ...(commit ? { commit } : {}) }), moved)
        }
      },
      // One git step (#1376): what it asks git about fixed commits is asked once in it.
      () => gitStep(() => call(wf))
    )
  )
  return { reply, saved }
}

/**
 * A column move through the card's runtime (#1265): `Workflow.move` on the intent path, the change's other fields (and
 * its comment) saved with its first write, its place with the write that reaches the column asked for. The user's move
 * with `confirm` skips what it must and records an `Override`; the Assistant's needs `override.reason` for that.
 */
async function moveThroughRules(g: Gate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}, confirm = true, paths?: { paths?: string[]; askPaths?: boolean }): Promise<MoveResult> {
  const ws = workspace
  const target = patch.column!
  const { column: _column, before, position, override, ...rest } = patch
  const reason = override?.reason.trim()
  const { reply, saved } = await runIntent(
    g.wf,
    n,
    actor,
    (wf) => wf.move(n, g.to, g.by, { confirm, ...(reason ? { reason } : {}), ...(g.builder ? { builder: g.builder } : {}), ...paths }),
    (w, first) => {
      const placed = STAGE_CATEGORY[w.current] === target ? { ...(before !== undefined ? { before } : {}), ...(position !== undefined ? { position } : {}) } : {}
      // A write that takes the card into Active (a start, or back from Review: HI-2062): whether its Override lets the card
      // be left with nobody on it, checked on the card as the write leaves it (updateTaskAs).
      const entered = w.current === 'active' && w.was !== 'active' ? { entered: { nobodyOk: w.written.some((f) => f.kind === 'Override' && (f.data as FactData['Override']).rules.includes('move.doingNobody')) } } : {}
      return { patch: { ...(first ? rest : {}), ...placed }, opts: { ...(first ? opts : {}), ...entered } }
    }
  )
  // A drag that went as far as it could (its start written, its submission refused for what no override makes true).
  if (isRefusal(reply)) return saved ? { moved: saved, stopped: reply } : { refused: reply }
  if ('ask' in reply) return saved ? { moved: saved } : reply.leftOut ? { leftOut: reply.leftOut } : { ask: reply.rules }
  if (saved) return { moved: saved }
  // Nothing moved (the card was already there): the rest of the change, as any other.
  const others: TaskPatch = { ...rest, ...(before !== undefined ? { before } : {}), ...(position !== undefined ? { position } : {}) }
  return { moved: Object.keys(others).length || opts.comment ? await updateTask(n, others, actor, opts) : await getTask(n, ws) }
}

async function moveThrough(g: Gate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}): Promise<TaskCard> {
  // The window's change (`ask`: IPC tasks:update, #1275) never skips a rule unasked: its moves go through tasks:move,
  // which asks; one that would skip a rule here is refused with the rules it names. Combwork's own calls for the user (a
  // card's Start) confirm as before.
  const { ask, ...rest } = opts
  const r = await moveDecidedAgain(g, n, patch, actor, rest, !ask)
  if ('refused' in r) throw new WorkflowRefusedError(r.refused)
  // Stopped part way: the user sees where the card is; the Assistant is told why it stopped there (its start kept).
  if ('moved' in r && r.stopped && actor.kind !== 'user') throw new WorkflowRefusedError(r.stopped)
  if ('ask' in r) throw new WorkflowRefusedError(refusalOf('move.needsOverride', { card: cardRef(n), stage: g.to, rules: r.ask.join(', ') }, 'the user')) // i18n-ignore: who can override, agent-facing (§16.8.3)
  // Never `leftOut` here: only the window's tasks:move asks what a card's paths leave out (HI-2352).
  return 'moved' in r ? r.moved : getTask(n, workspace)
}

/**
 * The card's agent changed under the Assistant's move into Active (HI-2062): its write left the card with nobody on it,
 * though the move was decided for an agent. The write is undone; the move is decided again on the card as it is now.
 */
class NobodyChanged extends Error {
  constructor(n: number) {
    super(`#${n}'s agent changed under its move into Active`) // i18n-ignore: an internal signal, never shown
  }
}

/**
 * moveThroughRules, decided again when its write into Active found the card's agent gone (NobodyChanged): with the gate read
 * again, the move is for nobody now, so it is refused without the user's reason, or its one Override names the rule. A
 * card still changing under it after that is refused, as nobody on it.
 */
async function moveDecidedAgain(g: Gate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3], confirm: boolean): Promise<MoveResult> {
  for (let tries = 0; ; tries++) {
    try {
      return await moveThroughRules(g, n, patch, actor, opts, confirm)
    } catch (e) {
      if (!(e instanceof NobodyChanged)) throw e
      const again = tries < 2 ? await gateOf(workspace, n, patch, actor) : null
      if (!again) throw new WorkflowRefusedError(refusalOf('move.doingNobody', { card: cardRef(n), stage: 'active' }, 'the user or the Assistant')) // i18n-ignore: who can override, agent-facing (§16.8.3)
      g = again
    }
  }
}

/**
 * The window's move (`tasks:move`, #1265): through the card's rules when they apply, asking first unless `confirm`
 * (the rules it would skip, nothing written), else a plain move. Never refused for a rule: the user overrides.
 * `paths` (HI-2352): a None code card's submission asks first what its paths leave out (`leftOut`, nothing written);
 * moved again with the paths to submit with (Include Them), or null (Leave Them Out), it doesn't ask.
 */
export async function moveTask(n: number, column: TaskColumn, o: { before?: number | null; confirm?: boolean; reason?: string; agent?: string | null; paths?: string[] | null } = {}): Promise<MoveResult> {
  const actor: TaskActor = { kind: 'user' }
  // `agent`: the Move to Doing dialog's choice (an agent, or nobody), given with the move.
  const patch: TaskPatch = { column, ...(o.before !== undefined ? { before: o.before } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}), ...(o.reason ? { override: { reason: o.reason } } : {}) }
  const gate = await gateOf(workspace, n, patch, actor, { anyStage: true })
  if (!gate) {
    const { override: _o, ...plain } = patch
    return { moved: await updateTask(n, plain, actor) }
  }
  const paths = Array.isArray(o.paths) && o.paths.length && o.paths.every((p) => typeof p === 'string' && p.length > 0) ? { paths: o.paths } : o.paths === undefined ? { askPaths: true } : {}
  return moveThroughRules(gate, n, patch, actor, {}, !!o.confirm, paths)
}

/**
 * The rules the user's Start of a card would skip (#1275: its move into Doing, the start its rules stand for), asked
 * before anything is done (no agent added, nothing launched): none when no rule applies or none is skipped. `agent`: the
 * agent it is given to (null: one not added yet).
 */
export async function startAsks(n: number, agent: string | null): Promise<string[]> {
  const actor: TaskActor = { kind: 'user' }
  const gate = await gateOf(workspace, n, { column: 'doing', ...(agent ? { agent } : {}) }, actor, { anyStage: true })
  if (!gate) return []
  const r = await gate.wf.move(n, gate.to, 'user', { dry: true, ...(gate.builder ? { builder: gate.builder } : {}) })
  return !isRefusal(r) && 'ask' in r ? r.rules : []
}

/**
 * The columns a card can be moved to under its rules (IPC `tasks:columns`, #1275): its ruleset's stages as columns
 * (On Hold always), where the window's drag highlights a drop; null when no rule applies to it (the rules off, a card
 * from before 1.0, a project with no platform): every column. A Done card dragged on is reopened: its next cycle's.
 */
export async function moveColumns(n: number): Promise<TaskColumn[] | null> {
  const ws = workspace
  const { workflowEnforced, workflowFor } = await import('./workflow/service')
  if (!ws.path || !workflowEnforced()) return null
  const head = cardHeads(ws, [n])[0]
  if (!head || typeof head.project !== 'string' || !head.project) return null
  const wf = await workflowFor(ws, join(ws.path, head.project)).catch(() => null)
  const rec = (() => {
    try {
      return wf?.store.card(n) ?? null
    } catch {
      return null
    }
  })()
  if (!wf || !rec || rec.preWorkflow) return null
  const s = wf.state(rec)
  const r = wf.rulesetOf(rec, s.stage === 'done' ? { ...s, stage: 'todo' } : s)
  return TASK_COLUMNS.map((c) => c.id).filter((c) => c === 'hold' || c === head.column || r.stages.some((x) => STAGE_CATEGORY[x.id] === c))
}

/** A card's kind as a call gives it (#1277): `code` unless `no-code`; anything else is refused. */
export function kindOf(v: unknown): CardKind {
  if (v === undefined || v === null || v === 'code') return 'code'
  if (v === 'no-code') return 'no-code'
  throw combworkError(KIND.bad, { kind: String(v) }, { kind: 'invalid' })
}

const KIND = {
  bad: msg({ id: 'tasks.error.badKind', defaultMessage: 'A card is code or no-code, not {kind}.', description: "An error: a card's kind was given as {kind}; it is code (work in commits, the default) or no-code (a decision, a write-up, a trial). Keep code and no-code as they are (they are values)." }),
  agents: msg({ id: 'tasks.error.kindNotAgents', defaultMessage: "Agents can't change a card's kind: propose no-code when you make the card, and the user or the Assistant confirms it.", description: "An error: an agent tried to change a card's kind (code or no-code) after it was made, or to answer a proposed kind; only the user or the Combwork Assistant can." }),
  needsReason: msg({ id: 'tasks.error.kindNeedsReason', defaultMessage: "Changing a card's kind after it is made is an exception to its rules: pass override.reason with the user's reason.", description: "An error said to the Combwork Assistant: it changed a card's kind (code or no-code) after the card was made without giving the user's reason (override.reason: keep it as it is)." }),
  noProposal: msg({ id: 'tasks.error.noKindProposal', defaultMessage: 'Nothing proposes a kind for {card}: its kind is {kind}.', description: "An error: confirming a card's proposed kind, but no agent proposed one (or it was answered already). {card} is the card's key (HI-12); {kind} its kind, code or no-code (values: keep them as they are)." })
}

/** The card's open kind proposal (an agent's KindProposed not yet answered), from its facts: its kind, or null. */
function kindProposal(store: FactStore, n: number): CardKind | null {
  const facts = store.facts(n)
  const p = facts.findLast((f) => f.kind === 'KindProposed')
  if (!p) return null
  return facts.some((f) => f.kind === 'KindDecided' && f.seq > p.seq) ? null : (p.data as { kind: CardKind }).kind
}

/**
 * Changes a card's kind after it was made (#1277, §16.7.3): an exception to its rules, recorded as one `Override`
 * (`card.kind`), the user's (asked first: `ask` unless `confirm`) or the Assistant's (with `reason`, the user's); never
 * an agent's. An open proposal is answered by it too.
 */
export async function setKind(n: number, kind: unknown, actor: TaskActor, o: { confirm?: boolean; reason?: string; commit?: () => void } = {}): Promise<{ ask: true } | TaskCard> {
  if (actor.kind === 'agent') throw new TaskPermissionError(KIND.agents)
  const to = kindOf(kind)
  const ws = workspace
  const reason = typeof o.reason === 'string' ? text(o.reason.trim(), 1000, 'blockedReason') : ''
  return recordingAs(actor, () =>
    boardLock(ws, async () => {
      const card = await getTask(n, ws)
      if (card.archived) throw new TaskPermissionError(withValues(ERR.archived, { card: cardRef(n) }))
      const store = FactStore.forBoard(ws, { project: card.project, key: '' })
      const was = store.card(n).kind
      if (was === to) return card
      if (actor.kind === 'user' && !o.confirm) return { ask: true as const }
      if (actor.kind === 'assistant' && !reason) throw new TaskConflictError(KIND.needsReason)
      // The caller's authority, checked last before anything is written (the Assistant's Control and session, under this
      // lock: HR3's #1277 round 1; as it is written, HI-2415), as updateTask's `commit`.
      const before = structuredClone(card)
      note(card, actorName(actor), storedText(HISTORY.kind, { how: 'changed', kind: to }))
      await saveCard(ws, n, card, before, undefined, o.commit)
      const proposed = kindProposal(store, n)
      store.updateCard(n, { kind: to })
      store.tx((tx) => {
        tx.append(n, { kind: 'Override', actor: actorOf(actor), source: 'recorded', data: { rules: ['card.kind'], move: `kind ${was}→${to}`, by: actor.kind === 'assistant' ? 'assistant' : 'user', reason } }) // i18n-ignore: a fact's kind and codes, not text
        if (proposed) tx.append(n, { kind: 'KindDecided', actor: actorOf(actor), source: 'recorded', data: { kind: to, proposed } })
      })
      changed(ws)
      return card
    })
  )
}

/**
 * Answers a kind an agent proposed (#1277, OP-6/OP-7): the user's or the Assistant's. `accept` makes it the card's kind;
 * else the card stays code. Refused when nothing proposes one (answered meanwhile).
 */
export async function confirmKind(n: number, accept: boolean, actor: TaskActor, o: { commit?: () => void } = {}): Promise<TaskCard> {
  if (actor.kind === 'agent') throw new TaskPermissionError(KIND.agents)
  const ws = workspace
  return recordingAs(actor, () =>
    boardLock(ws, async () => {
      const card = await getTask(n, ws)
      const store = FactStore.forBoard(ws, { project: card.project, key: '' })
      const proposed = kindProposal(store, n)
      if (!proposed) throw new TaskConflictError(withValues(KIND.noProposal, { card: cardRef(n), kind: store.card(n).kind }))
      const kind: CardKind = accept ? proposed : 'code'
      const before = structuredClone(card)
      note(card, actorName(actor), storedText(HISTORY.kind, { how: accept ? 'confirmed' : 'kept', kind }))
      await saveCard(ws, n, card, before, undefined, o.commit)
      store.updateCard(n, { kind })
      store.tx((tx) => tx.append(n, { kind: 'KindDecided', actor: actorOf(actor), source: 'recorded', data: { kind, proposed } }))
      changed(ws)
      return card
    })
  )
}

const SKIP = {
  agents: msg({ id: 'tasks.error.reviewSkipNotAgents', defaultMessage: "Agents can't make a card skip review: propose it when you make the card (skipReview, with your reason), and the user or the Assistant decides.", description: "An error: an agent tried to make a card skip its review, or to answer a proposal that it skip review, after the card was made; only the user or the Combwork Assistant can. Keep skipReview as it is (a field's name)." }),
  needsReason: msg({ id: 'tasks.error.reviewSkipNeedsReason', defaultMessage: "A card skips review only with the user's reason: pass skipReview with it, in the user's words.", description: "An error said to the Combwork Assistant (or an agent proposing it): it asked for a card to skip its review without a reason. Keep skipReview as it is (a field's name)." }),
  nothingNew: msg({ id: 'tasks.error.reviewSkipNothingNew', defaultMessage: "This card's rules don't review it: there is no review to skip.", description: "An error making a card: it was to skip its review, but its project's workflow has no review (Solo, or no workflow)." }),
  nothing: msg({ id: 'tasks.error.reviewSkipNothing', defaultMessage: "{card}'s rules don't review it: there is no review to skip.", description: "An error: a card was to skip its review, but its project's workflow has no review (Solo, or no workflow). {card} is the card's key (HI-12)." }),
  inReview: msg({ id: 'tasks.error.reviewSkipInReview', defaultMessage: "{card} is in Review: whether it skips review is decided before it is submitted. To take it past its review now, the user moves it on (an override, with their reason).", description: "An error: a card's review skip was to change while the card is in Review. The way past its review is the user's override of the move (dragging it on, or the Assistant moving it with the user's reason). {card} is the card's key (HI-12)." }),
  past: msg({ id: 'tasks.error.reviewSkipPast', defaultMessage: '{stage, select, done {{card} is Done: it has no review left to skip.} other {{card} is past its review already: there is nothing left to skip.}}', description: "An error: a card's review skip was to change once the card was past Review (approved, being merged, or Done). {card} is the card's key (HI-12); {stage} its stage (select: done, or another)." })
}

/** A card's review skip as a call gives it (#1625): a reason (possibly empty) or `false` (not skipped); else invalid. */
export function reviewSkipArg(v: unknown): string | false {
  if (v === false) return false
  if (typeof v === 'string') return text(v.trim(), 1000, 'blockedReason')
  throw combworkError(msg({ id: 'tasks.error.badReviewSkip', defaultMessage: "skipReview is the user's reason the card skips review (text), or false to review it after all.", description: "An error: a card's skipReview was given as something else than a reason (text) or false. Keep skipReview and false as they are (a field's name and a value)." }), undefined, { kind: 'invalid' })
}

/** Whether a card's rules (before its skip) review it: its runtime's, else the project's now; null without a workflow. */
async function reviewsOf(ws: WorkspaceService, project: string, n: number | null): Promise<{ wf: Workflow; reviews: boolean; stage: StageId } | null> {
  const { workflowFor } = await import('./workflow/service')
  if (!ws.path || !project) return null
  const wf = await workflowFor(ws, join(ws.path, project)).catch(() => null)
  if (!wf) return null
  const rec = n === null ? null : (() => {
    try {
      return wf.store.card(n)
    } catch {
      return null
    }
  })()
  const s = rec ? wf.state(rec) : null
  const r = rec && s ? wf.reviewedRuleset(rec, s) : wf.currentRuleset(false)
  return { wf, reviews: r.options.review !== 'none', stage: s?.stage ?? 'todo' }
}

/**
 * Makes a card skip review, or review it after all (#1625, SPEC §16.7.3): the user's (`reason` their optional note) or the
 * Assistant's (`reason` the user's, required to skip); never an agent's (it proposes at creation). An open proposal is
 * answered by it. Decided before submission: in Review or past it, refused, naming the way on.
 */
export async function setReviewSkip(n: number, skip: boolean, actor: TaskActor, o: { reason?: string; commit?: () => void } = {}): Promise<TaskCard> {
  if (actor.kind === 'agent') throw new TaskPermissionError(SKIP.agents)
  const ws = workspace
  const reason = typeof o.reason === 'string' ? text(o.reason.trim(), 1000, 'blockedReason') : ''
  if (skip && actor.kind === 'assistant' && !reason) throw new TaskConflictError(SKIP.needsReason)
  return recordingAs(actor, () =>
    boardLock(ws, async () => {
      const card = await getTask(n, ws)
      if (card.archived) throw new TaskPermissionError(withValues(ERR.archived, { card: cardRef(n) }))
      const store = FactStore.forBoard(ws, { project: card.project, key: '' })
      const now = reviewSkipOf(store.facts(n))
      if (!!now.skip === skip && now.proposed === null) return card
      const rules = await reviewsOf(ws, card.project, n)
      if (skip && !rules?.reviews) throw new TaskConflictError(withValues(SKIP.nothing, { card: cardRef(n) }))
      const stage = rules?.stage ?? 'todo'
      if (stage === 'review') throw new TaskConflictError(withValues(SKIP.inReview, { card: cardRef(n) }))
      if (stage === 'approved' || stage === 'merging' || stage === 'done') throw new TaskConflictError(withValues(SKIP.past, { card: cardRef(n), stage }))
      const before = structuredClone(card)
      const how = now.proposed !== null ? (skip ? 'confirmed' : 'kept') : skip ? 'set' : 'removed'
      note(card, actorName(actor), storedText(HISTORY.reviewSkip, { how }))
      await saveCard(ws, n, card, before, undefined, o.commit)
      const by = actor.kind === 'assistant' ? 'assistant' : 'user'
      store.tx((tx) => tx.append(n, { kind: 'ReviewSkipSet', actor: actorOf(actor), source: 'recorded', data: { skip, by, reason, ...(now.proposed !== null ? { proposed: now.proposed } : {}) } }))
      // A started card's stages are its rules with no review from now on: stored, so the board shows them at once.
      if (skip && rules && stage === 'active') {
        const rec = rules.wf.store.card(n)
        rules.wf.store.saveRuleset(skipReviewOf(rules.wf.reviewedRuleset(rec, rules.wf.state(rec))))
      }
      changed(ws)
      return card
    })
  )
}

/** An answer the window sent that can't be one (the request's kind decides which fields it takes). */
const BAD_ANSWER = msg({ id: 'tasks.error.badAnswer', defaultMessage: "That answer doesn't fit the request: approve or decline an approval, answer a question with a reply or a decision, and choose a way on at the round limit (a carry on with 1 to {max} more rounds).", description: "An error answering a request for the user (For you): what was sent doesn't fit the request's kind. {max} is the most rounds a carry on can add (a number)." })

/** An action a question offered that the card no longer allows (#1630: Done already, no code already, not blocked). */
const ACTION_GONE = msg({ id: 'tasks.error.actionGone', defaultMessage: "{action, select, done {{card} is already in Done.} noCode {{card} is already no code.} other {{card} isn't blocked.}} Answer the question with a reply instead.", description: "An error when the user clicks an action an agent's question offered on its card (For you): the card has changed so the action no longer applies. {card} is the card's key (HI-12); keep the select keys as they are. Answer with a reply: type an answer in the box instead." })

/**
 * Does an action an agent's question offered (#1630), as the user and with their reason, as the board does it: Move to
 * Done through the card's rules, the rules it skips recorded as an override (Move Anyway's); Make It No Code, the
 * `card.kind` override; Skip Review (HI-1734), set as the user's with the reason; Unblock, the reason as the user's
 * comment. Throws when it is refused or stops short of Done.
 */
async function doAskAction(n: number, kind: AskActionKind, reason: string | undefined): Promise<void> {
  const actor: TaskActor = { kind: 'user' }
  if (kind === 'done') {
    const r = await moveTask(n, 'done', { confirm: true, paths: null, ...(reason ? { reason } : {}) })
    if ('refused' in r) throw new WorkflowRefusedError(r.refused)
    if ('ask' in r) throw new WorkflowRefusedError(refusalOf('move.needsOverride', { card: cardRef(n), stage: 'done', rules: r.ask.join(', ') }, 'the user')) // i18n-ignore: who can override, agent-facing (§16.8.3)
    if ('moved' in r && r.stopped) throw new WorkflowRefusedError(r.stopped)
  } else if (kind === 'noCode') {
    await setKind(n, 'no-code', actor, { confirm: true, ...(reason ? { reason } : {}) })
  } else if (kind === 'skipReview') {
    await setReviewSkip(n, true, actor, reason ? { reason } : {})
  } else {
    await updateTask(n, { blocked: null }, actor, reason ? { comment: reason } : {})
  }
}

/**
 * The user answers a card's request (IPC `tasks:answer`, #1269, SPEC §16.8.5): only the user (Darren's point 7: never
 * an agent or the Assistant). On the intent path (`runIntent`), so the answer, what it moves and the card's 0.9 fields
 * are one transaction, checked there (the request still open, the card where it was asked, its generation current). A
 * decision (a Decide answer) is the card's, added with the answer's write: a new generation, its agents told (#1266). A
 * reply is kept with the answer, added to the card as the user's comment and relayed to the waiting agent; on an agent's
 * question approved with one, it is the card's decision too (HI-2286, `approveNote`). Refused with the rule's text when the request was
 * answered or retired meanwhile. An action the question offered (#1630) and the answer are one change of the board
 * (HR5's round 1): the request still open and the action still allowed, checked under its lock, then the action, then
 * the answer; any of them refused, none of it is kept and the question stays open.
 */
export async function answerTask(n: number, request: string, a: ForYouAnswer): Promise<TaskCard> {
  const ws = workspace
  const actor: TaskActor = { kind: 'user' }
  const bad = (): CombworkError => combworkError(BAD_ANSWER, { max: LANE_MAX_ROUNDS }, { kind: 'invalid' })
  if (!a || !['approved', 'declined', 'answered'].includes(a.outcome) || typeof request !== 'string' || !request) throw bad()
  const typed = typeof a.reply === 'string' && a.reply.trim() ? text(a.reply.trim(), MAX_TEXT, 'comment') : undefined
  const decided = typeof a.decision === 'string' && a.decision.trim() ? text(a.decision.trim(), MAX_DECISION, 'decision') : undefined
  const asked = a.action === undefined ? undefined : ASK_ACTIONS.includes(a.action) ? a.action : null
  if (asked === null || (asked && typed)) throw bad()
  // An action's reason, as an override's (setKind's).
  const given = asked && typeof a.reason === 'string' && a.reason.trim() ? text(a.reason.trim(), 1000, 'blockedReason') : undefined
  const head = ws.path ? cardHeads(ws, [n])[0] : undefined
  if (!head) throw unknownTask(n)
  const { workflowFor } = await import('./workflow/service')
  const wf = typeof head.project === 'string' && head.project && ws.path ? await workflowFor(ws, join(ws.path, head.project)).catch(() => null) : null
  const rec = (() => {
    try {
      return wf?.store.card(n) ?? null
    } catch {
      return null
    }
  })()
  const req = wf && rec ? wf.state(rec).requests.find((r) => r.request === request) : undefined
  if (!wf || !req) throw new WorkflowRefusedError(refusalOf('move.notFromHere', { card: cardRef(n), stage: CATEGORY_STAGE[head.column as TaskColumn] ?? 'todo', move: 'answer', moves: '' }))
  // HI-1734: approving an Approve question that offers one action is that action, done as the user's own act (the reply,
  // if any, its reason, else the agent's), in one change with the answer as a click on it is.
  const one = !asked && req.kind === 'approve' && a.outcome === 'approved' && req.actions?.length === 1 ? req.actions[0] : null
  const action = asked ?? one?.kind
  const reason = given ?? (one ? (typed ?? one.reason) : undefined)
  const reply = one ? undefined : typed
  const outcome = one ? 'answered' : a.outcome
  // HI-2286: an agent's question approved with a note: the note is a reply and the user's decision on the card too.
  const decision = !asked && !one && req.kind === 'approve' && a.outcome === 'approved' && reply && approveNote(req) === 'decision' ? text(reply, MAX_DECISION, 'decision') : decided
  // What each kind takes (answerFits): an approval is approved or declined; at the round limit, a choice (a carry on with
  // its rounds); any other question, a reply or a decision. Checked before anything is written.
  const choice = a.choice as RoundChoice | undefined
  if (!answerFits(req, { outcome, reply: !!reply, decision: !!decision, choice, rounds: a.rounds, ...(action ? { action } : {}) }, LANE_MAX_ROUNDS)) throw bad()
  const answerIt = async (): Promise<TaskCard> => {
    const { reply: r } = await runIntent(
      wf,
      n,
      actor,
      (w) => w.answer(n, request, outcome, { ...(reply ? { note: reply } : reason ? { note: reason } : {}), ...(decision ? { decided: true } : {}), ...(choice ? { choice } : {}), ...(choice === 'carryOn' ? { rounds: a.rounds } : {}), ...(action ? { action } : {}) }),
      // A reply is on the card too, as the user's comment (#1626), so the card shows it and the wake's "in full" is there.
      (_w, first) => ({ patch: first && decision ? { decision } : {}, ...(first && reply ? { opts: { comment: reply } } : {}) })
    )
    if (isRefusal(r)) throw new WorkflowRefusedError(r)
    return getTask(n, ws)
  }
  if (!action) {
    const card = await answerIt()
    // Not carried out by Combwork: the Assistant has it too (HI-1734), when an agent asked: every answer, a bare Approve or
    // Decline too (HR1's round 1), with how the user answered and what they wrote, each whole.
    if (req.gate === 'ask' && req.asker) await relayToAssistant(ws, card, req, { outcome, ...(reply ? { reply } : {}), ...(decision ? { decision } : {}) }, wf)
    return card
  }
  return cardBatch(ws, async () => {
    // Under the board's lock: the request still open (answered or retired from another window meanwhile: refused before
    // anything is done) and the action still allowed.
    if (!wf.state(wf.store.card(n)).requests.some((x) => x.request === request)) throw new WorkflowRefusedError(refusalOf('move.notFromHere', { card: cardRef(n), stage: CATEGORY_STAGE[head.column as TaskColumn] ?? 'todo', move: 'answer', moves: '' }))
    if (!askActionAvailable(action, { ...(await getTask(n, ws)), kind: wf.store.card(n).kind })) throw combworkError(ACTION_GONE, { action, card: cardRef(n) }, { kind: 'conflict' })
    // The answer first (#1638: once the card is in Done, its requests are closed and none can be answered), then the
    // action: either refused, both are undone.
    await answerIt()
    await doAskAction(n, action, reason)
    return getTask(n, ws)
  })
}

const DECIDE = {
  agents: msg({ id: 'tasks.error.answersNotAgents', defaultMessage: "Only the user, or the Assistant recording the user's decision, closes a request for the user.", description: "An error (HI-1932): an agent recorded a decision naming the card's requests it answers (For you); only the user, or the Combwork Assistant writing down the user's own decision, may close them that way." }),
  shape: msg({ id: 'tasks.error.answersShape', defaultMessage: 'answers takes the ids of 1 to {max, number} of the card’s open requests, with a decision and nothing else in the same change.', description: "An error (HI-1932): a decision naming the card's requests it answers was sent wrongly: answers must list between 1 and {max} request ids (For you's requests), together with the decision's text and no other change. Keep answers as it is (a field's name)." }),
  not: msg({ id: 'tasks.error.answersNot', defaultMessage: "{why, select, open {{request} isn't an open request on {card}.} other {A decision can't answer {request} on {card}: approve, decline or choose it in For you.}}", description: "An error (HI-1932): a decision named a request ({request}: its id, such as r12) of card {card} (its key) that it can't answer: it isn't open on the card (answered or closed meanwhile), or it is an approval or one of Combwork's own requests (a review, the OK before merging, the round limit), which the user answers in For you. Keep the select keys." })
}

/**
 * Who may send a decision's `answers` and its shape (HI-1932), checked before anything is written: the user's or the
 * Assistant's only; 1 to DECISION_ANSWERS_MAX ids, each a string as sent (never coerced); `wrong` when anything else
 * comes with it or the decision is missing. The Agent API checks its raw body with it too, as some of its fields
 * (kind, skipReview, attachments) are changed outside the card's patch.
 */
export function checkDecisionAnswers(actor: TaskActor, answers: unknown, wrong: boolean): asserts answers is string[] {
  if (actor.kind !== 'user' && actor.kind !== 'assistant') throw new TaskPermissionError(DECIDE.agents)
  if (wrong || !Array.isArray(answers) || !answers.length || answers.length > DECISION_ANSWERS_MAX || answers.some((x) => typeof x !== 'string' || !x.trim() || x.length > 64)) throw combworkError(DECIDE.shape, { max: DECISION_ANSWERS_MAX }, { kind: 'invalid' })
}

/**
 * A decision the user made answers some of a card's open requests (HI-1932, Darren's decision of 28 Oct: the Assistant
 * records it naming the requests it answers, and Combwork closes them). The user's or the Assistant's only, never an
 * agent's: no agent closes its own request. `answers`: 1 to DECISION_ANSWERS_MAX request ids (duplicates once), with a
 * non-empty decision and nothing else. Each must be an open request a decision may answer (`decisionAnswers`), checked
 * here and again under the write: any that isn't refuses all of it, the decision included. The decision (its id fixed
 * here, the one each answer names), the answers and a history line each are one write; the agents asking are woken once
 * it commits.
 */
async function decideAndAnswer(n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}): Promise<TaskCard> {
  const ws = workspace
  const { answers, decision, ...rest } = patch
  const t = typeof decision === 'string' ? text(decision, MAX_DECISION, 'decision').trim() : ''
  checkDecisionAnswers(actor, answers, !t || Object.entries(rest).some(([, v]) => v !== undefined) || !!opts.comment)
  const requests = [...new Set(answers.map((x) => x.trim()))]
  const head = ws.path ? cardHeads(ws, [n])[0] : undefined
  if (!head) throw unknownTask(n)
  const { workflowFor } = await import('./workflow/service')
  const wf = typeof head.project === 'string' && head.project && ws.path ? await workflowFor(ws, join(ws.path, head.project)).catch(() => null) : null
  const open = (() => {
    try {
      return wf ? wf.state(wf.store.card(n)).requests : []
    } catch {
      return []
    }
  })()
  for (const id of requests) {
    const req = open.find((r) => r.request === id)
    if (!req || !decisionAnswers(req)) throw combworkError(DECIDE.not, { why: req ? 'kind' : 'open', request: id, card: cardRef(n) }, { kind: req ? 'invalid' : 'conflict' }) // i18n-ignore: select keys, never shown
  }
  const decisionId = entryId()
  const recordedBy = actorName(actor)
  const lines = requests.map((id) => storedText(HISTORY.closedByDecision, { question: clip(open.find((r) => r.request === id)!.text) }))
  const { reply } = await runIntent(
    wf!,
    n,
    actor,
    (w) => w.answerByDecision(n, requests, { text: t, decision: decisionId, recordedBy }),
    // The decision and the history's lines with the answers' write: one transaction, with the Assistant's change record
    // (assistantChange's commit: Control, its session, the change limit) in it.
    // Only with the write that holds its answers: a refusal is written too (its Refused fact), and takes no decision.
    // HI-2220: what it wrote (the decision, each question closed) goes to the caller's `said` with that write only, so
    // the short reply confirms it rather than "No change", and a refusal confirms nothing.
    (w) => (w.written.some((f) => f.kind === 'Approval' && !!(f.data as { byDecision?: unknown }).byDecision) ? { patch: { decision: t, decisionId }, opts: { note: lines, ...(opts.commit ? { commit: opts.commit } : {}), ...(opts.said ? { said: opts.said } : {}) } } : {})
  )
  if (isRefusal(reply)) throw new WorkflowRefusedError(reply)
  return getTask(n, ws)
}

/**
 * HI-1734: the user's answer to an agent's question that Combwork didn't carry out, given to the Assistant too
 * (answerRelay.ts), with what only someone other than its agent can do on the card as it is now, if anything: an action
 * the question offered; an open no-code or review-skip proposal (Combwork's own after a pass with nothing to merge too); a
 * card in Passed its agent can't move on (it doesn't merge it); a block. Read from the card's state, never from the answer's text.
 */
async function relayToAssistant(ws: WorkspaceService, card: TaskCard, req: Request, answer: { outcome: 'approved' | 'declined' | 'answered'; reply?: string; decision?: string }, wf: Workflow): Promise<void> {
  const rec = wf.store.card(card.number)
  const s = wf.state(rec)
  const facts = wf.store.facts(card.number)
  // In Passed, an agent moves its card on only by reporting its own merge.
  const finish = wf.rulesetOf(rec, s).options.finish
  const need: AskActionKind | null =
    req.actions?.[0]?.kind ?? (kindProposed(facts) === 'no-code' ? 'noCode' : reviewSkipOf(facts).proposed !== null ? 'skipReview' : card.column === 'passed' && finish !== 'agentMerges' ? 'done' : card.blocked ? 'unblock' : null)
  const asker = ws.path && card.project ? (await ws.projectConfig(join(ws.path, card.project)).then(projectAgents, () => [])).find((x) => x.id === req.asker) : undefined
  const { relayAnswer } = await import('./answerRelay')
  await relayAnswer(ws, { card: card.number, key: rec.key || card.key || cardRef(card.number), project: card.project, asker: req.asker!, askerName: asker ? `${asker.name} (${card.project})` : req.asker!, request: req.request, question: req.text, ...answer, need })
}

/** A new card's reads, made before its number is taken (#1216: recorder.ts' NEW_CARD). */
const NEW_CARD = 0

/** An agent of a project by its id or name, as its id; null when there is none of that name (the change says so itself). */
async function agentIdIn(ws: WorkspaceService, project: string, agent: string | null | undefined): Promise<string | null> {
  if (!agent || !ws.path) return null
  try {
    const a = projectAgents(await ws.projectConfig(join(ws.path, project))).find((x) => x.id === agent || x.name.toLowerCase() === agent.toLowerCase())
    return a?.id ?? null
  } catch {
    return null
  }
}

/**
 * The cards a change may start (into Doing with an agent) or submit (into Review), read as they are before it, for the
 * platform's reads made before the change (#1216). A guess from the card as it is now: the change itself decides, on
 * the card as it is then, and a fact whose reads don't match what happened records them as not read.
 */
async function planned(ws: WorkspaceService, numbers: number[], patch: Pick<TaskPatch, 'column' | 'agent'>, actor: TaskActor): Promise<Planned[]> {
  if (patch.column !== 'doing' && patch.column !== 'review' && patch.agent === undefined) return []
  const out: Planned[] = []
  // Their project, column and agent from the board's columns: no card's document is read for it.
  for (const head of ws.path ? cardHeads(ws, numbers) : []) {
    const n = head.number
    // Read as clean() reads them: a project or agent of another type is none, a column not a column is Todo.
    const card = { project: typeof head.project === 'string' ? head.project : '', column: isTaskColumn(head.column) ? head.column : 'todo', agent: typeof head.agent === 'string' && head.agent ? head.agent : null }
    if (!card.project) continue
    const agent = patch.agent !== undefined ? await agentIdIn(ws, card.project, patch.agent) : patch.column === 'doing' && card.column !== 'doing' ? (selfIn(actor, card.project) ?? card.agent) : card.agent
    const column = patch.column ?? card.column
    if (column === 'doing' && agent && (card.column !== 'doing' || agent !== card.agent)) out.push({ number: n, project: card.project, agent, why: 'start' }) // i18n-ignore: an internal value
    else if (column === 'review') out.push({ number: n, project: card.project, agent, why: 'submit' }) // i18n-ignore: an internal value
  }
  return out
}

/** For tests: runs as a card's change begins, in its board change (to hold a batch at a card). */
export const taskTestHooks: { beforeUpdate: ((n: number) => Promise<void>) | null } = { beforeUpdate: null }

async function updateTaskLocked(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[]; comment?: string; commit?: () => void; was?: TaskColumn; keepAgent?: boolean; ask?: boolean; note?: StoredText[]; entered?: { nobodyOk: boolean } } = {}): Promise<TaskCard> {
  // Its facts are this actor's (#1216), with the reads its caller made before the change, if any.
  return recordingAs(actor, () => updateTaskAs(n, patch, actor, opts))
}

/**
 * The names stages have on a project's board (HI-1585): its own where it renamed them (N5, the options in force, as the
 * board shows them: projectStages), null for none (the defaults), or for a project with no version control yet.
 */
async function stageNamesOf(ws: WorkspaceService, project: string | null | undefined): Promise<StageNames | null> {
  if (!ws.path || !project) return null
  const { projectStages } = await import('./workflow/optionsForm')
  const names = (await projectStages(ws, join(ws.path, project)).catch(() => null))?.names
  return names && Object.keys(names).length ? names : null
}

async function updateTaskAs(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[]; comment?: string; commit?: () => void; was?: TaskColumn; keepAgent?: boolean; note?: StoredText[]; entered?: { nobodyOk: boolean } }): Promise<TaskCard> {
  await taskTestHooks.beforeUpdate?.(n)
  const ws = workspace
  const by = actorName(actor)
  const comment = opts.comment === undefined ? null : commentText(opts.comment)
  const result = await (async () => {
    const card = await getTask(n, ws)
    // A move the runtime made in this transaction (#1265) has saved the card's column already: its 0.9 fields (history,
    // place, review) are worked out from where it was.
    if (opts.was) card.column = opts.was
    // As it was, for the change's facts (#1216): the change edits `card` in place.
    const before = structuredClone(card)
    const scope = scopeOf(actor)
    if (!inScope(card, scope)) throw unknownTask(n)
    // The caller's own conditions, on the card as it is now (Start: not archived or done meanwhile).
    opts.check?.(card)
    if (card.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { card: cardRef(n) }))
    // A card in Doing with another agent is that agent's work in progress: a project agent can't move it on to Review or
    // Done (a reviewer whose review ended when it came back for more work, say). Checked on the card as it is, before
    // anything else in the change (giving it to itself in the same call doesn't get round it). A project agent is one
    // calling with its own token (actor.self); the user, the Assistant and scripts with the workspace token can.
    // A review verdict or start is refused on a card in Doing anyway (reviewChange), with its own reason.
    const moving = patch.review === undefined && (patch.column === 'review' || patch.column === 'passed' || patch.column === 'done')
    if (actor.kind === 'agent' && actor.self && moving && card.column === 'doing' && card.agent && card.agent !== actor.self.agentId) {
      const column = patch.column!
      // Stages by the names the board shows (#1604: agents read "Active", never the column's id): the project's own where
      // it renamed them (HR5's HI-1585 round 1), in English by default.
      const names = await stageNamesOf(ws, card.project)
      const stages = { active: stageName('active', names), review: stageName('review', names), stage: stageName(column === 'passed' ? 'approved' : column, names) }
      throw new TaskConflictError(
        card.agentName
          ? withValues(msg({ id: 'tasks.error.inDoingWith', defaultMessage: "{card} is in {active} with agent {agent}, who is working on it: newer work is in progress, so another agent can't move it to {stage}. Leave it where it is; agent {agent} moves it to {review} when done, and the user can move it.", description: 'An error, read by agents: an agent tried to move card {card} (its key, such as HI-12) on to the stage {stage}, but the card is in {active} with another agent ({agent}, its name), whose work is in progress. {active}, {review} and {stage} are stage names as the board shows them (glossary 2.2).' }), { card: cardRef(n), agent: card.agentName, ...stages })
          : withValues(msg({ id: 'tasks.error.inDoingWithAnother', defaultMessage: "{card} is in {active} with another agent, who is working on it: newer work is in progress, so another agent can't move it to {stage}. Leave it where it is; that agent moves it to {review} when done, and the user can move it.", description: "An error, read by agents: an agent tried to move card {card} (its key, such as HI-12) on to the stage {stage}, but the card is in {active} with another agent (whose name isn't known), whose work is in progress. {active}, {review} and {stage} are stage names as the board shows them (glossary 2.2)." }), { card: cardRef(n), ...stages })
      )
    }
    const said: StoredText[] = []
    // Whether a move to Review returns a failed card for review (#214): decided on the card as it is before this change,
    // by whoever has it now, so giving it to the caller in the same change never makes it the caller's to return.
    const returning = patch.column === 'review' && patch.review === undefined && returnsCard(actor, card) ? returnRound(card) : null
    const { agent: hadAgent, project: hadProject } = card
    // A failed review (P3's path: HI-1946) sends the card back to Doing, still its builder's, as the verdict intent does:
    // checked first in reviewChange (who reviews, a column other than Doing refused), then moved as any change moves it.
    const failing = patch.review === 'failed' && !changeByRuntime()
    if (failing && patch.column === undefined) patch = { ...patch, column: 'doing' }
    // A card moved within its column: saved, but not worth a line in its history.
    let reordered = false
    let transferred = false
    if (patch.title !== undefined) {
      const t = text(patch.title, MAX_TITLE, 'title').trim()
      if (!t) throw needsTitle()
      if (t !== card.title) said.push(storedText(HISTORY.renamed, { title: t }))
      card.title = t
    }
    if (patch.description !== undefined) {
      const d = text(patch.description, MAX_TEXT, 'description')
      if (d !== card.description) said.push(storedText(HISTORY.description))
      card.description = d
    }
    if (patch.project !== undefined) {
      const p = await projectName(patch.project)
      if (!inScope({ project: p }, scope)) throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.staysInProject', defaultMessage: 'Cards stay in your project ({project}).', description: "An error: an agent tried to move a card to another project, or to the whole workspace; its cards stay in its own project ({project}, its folder name)." }), { project: scope ?? '' }))
      if (p !== card.project) {
        // A card that changes project always leaves its agent (of the old project): giving it to one of the new
        // project's agents is a change of its own, after this one.
        if (patch.agent) throw combworkError(msg({ id: 'tasks.error.projectThenAgent', defaultMessage: 'Move the card to the other project first, then give it to one of its agents.', description: "An error: one change both moved a card to another project and gave it to an agent; those are two changes, in that order." }), undefined, { kind: 'invalid' })
        said.push(p ? storedText(HISTORY.toProject, { project: p }) : storedText(HISTORY.toWorkspace))
        if (card.agent) said.push(card.project ? storedText(HISTORY.takenFromOf, { agent: card.agentName ?? card.agent, project: card.project }) : storedText(HISTORY.takenFromOfWorkspace, { agent: card.agentName ?? card.agent }))
        if (card.review) {
          said.push(storedText(HISTORY.reviewStopped, { agent: card.review.agentName }))
          delete card.review
        }
        // Its attachments (HI-1700) follow it: copied to the new project in this change (refused if they can't be).
        await moveCardFolder(ws, n, card.project, p)
        card.project = p
        card.agent = null
        delete card.agentName
        transferred = true
      }
    }
    // An agent that moves a card into Doing from another column, naming no agent, is taking it (not in a project
    // change): also from another agent, who wasn't working on it since it wasn't in Doing ("Given to …" in its history).
    // Not when the change keeps its agent (#1267: a reviewer's failed verdict moves the card back into Doing, its builder's
    // still, whoever it is given to by then), nor the card's reviewer's own move back (HI-1832: it stays its builder's).
    const own = !opts.keepAgent && !failing && !transferred && patch.agent === undefined && patch.column === 'doing' && card.column !== 'doing' && !reviewerMovesBack(ws, card, actor) ? selfIn(actor, card.project) : null
    const agent = patch.agent !== undefined ? patch.agent : (own ?? undefined)
    if (agent !== undefined && !(transferred && !agent)) {
      if (agent) {
        const a = await agentOf(card.project, agent)
        if (a.id !== card.agent) said.push(storedText(HISTORY.given, { agent: a.name }))
        card.agent = a.id
        card.agentName = a.name
      } else if (card.agent) {
        said.push(card.agentName ? storedText(HISTORY.takenFrom, { agent: card.agentName }) : storedText(HISTORY.takenFromAgent))
        card.agent = null
        delete card.agentName
      }
    }
    // The Assistant's move into Doing leaving nobody on the card (HI-2062), on the card as it is now, its agent as this
    // change leaves it (a project change takes it off): nobody on it is the user's choice, passed as override with their
    // reason (null: refused). A runtime move's write into Active (a start, or back from Review) is checked the same way:
    // its Override names the rule when its move was for nobody; one decided for an agent that this change leaves off
    // (taken off meanwhile) undoes the write, and the move is decided again on the card as it is now (moveThrough).
    const leftEmpty = actor.kind === 'assistant' && patch.column === 'doing' && card.column !== 'doing' && !!card.project && !card.agent
    if (leftEmpty && changeByRuntime() && opts.entered && !opts.entered.nobodyOk) throw new NobodyChanged(n)
    const nobody = leftEmpty && !changeByRuntime() ? patch.override?.reason.trim() || null : undefined
    if (nobody === null) throw new WorkflowRefusedError(refusalOf('move.doingNobody', { card: cardRef(n), stage: 'active' }, 'the user or the Assistant')) // i18n-ignore: who can override, agent-facing (§16.8.3)
    // A review renewed by its reviewer changes the card (when it started) without a line in its history: saved too.
    const reviewed = patch.review !== undefined && (await reviewChange(card, patch, actor, said))
    if (patch.column !== undefined || patch.before !== undefined || patch.position !== undefined) {
      const column = patch.column ?? card.column
      if (!isTaskColumn(column)) throw unknownColumn(column)
      if (column !== card.column) checkHold(column, actor, n)
      const place = placement(await boardPlaces(ws), card, column, patch, actor)
      if (column !== card.column) said.push(place.said ?? storedText(HISTORY.moved, { column }))
      else {
        // Moved to Review by its agent (or the user, on the board) while still there after a failed review: returned for
        // its next round, which wakes a reviewer waiting for it to come back (#214). Not when this change also gives it to
        // another agent or project (that starts a new round of its own); any other move in place is no change.
        if (returning && card.agent === hadAgent && card.project === hadProject) said.push(storedText(HISTORY.returned, { round: returning }))
        if (place.said) said.push(place.said)
      }
      // A review is of the card in Review: moved on without a verdict, it stops.
      if (card.review && column !== 'review') {
        said.push(storedText(HISTORY.reviewStopped, { agent: card.review.agentName }))
        delete card.review
      }
      const order = place.order
      reordered = order !== card.order
      card.order = order
      card.column = column
    }
    if (patch.decision !== undefined) {
      // Recorded by whoever calls (the user, the Assistant, an agent), decided by the user: agents only write down what
      // the user decided (their tool's description says so). Editing or removing one is the user's (editDecision).
      const t = text(patch.decision, MAX_DECISION, 'decision').trim()
      if (!t) throw combworkError(ERR.emptyDecision)
      const list = card.decisions ?? []
      if (list.length >= MAX_DECISIONS) throw combworkError(msg({ id: 'tasks.error.tooManyDecisions', defaultMessage: 'A card can have up to {max} decisions.', description: 'An error: a card already has as many decisions as it may have ({max}, a number).' }), { max: MAX_DECISIONS }, { kind: 'invalid' })
      card.decisions = [...list, { id: patch.decisionId ?? entryId(), text: t, decidedBy: 'user', recordedBy: by, at: new Date().toISOString() }]
      said.push(storedText(HISTORY.decision, { decision: clip(t) }))
    }
    if (patch.context !== undefined) {
      const refs = contextOf(patch.context)
      if (refs.join('\n') !== (card.context ?? []).join('\n')) said.push(refs.length ? storedText(HISTORY.context, { refs: refs.join(', ') }) : storedText(HISTORY.contextRemoved))
      if (refs.length) card.context = refs
      else delete card.context
      // Checked as they are saved (#819): what doesn't resolve shows on the card.
      withProblems(card, await contextProblems(cardProject(card), workspace.sharedDir, refs))
    }
    if (patch.labels !== undefined) {
      card.labels = labelsOf(patch.labels)
      said.push(card.labels.length ? storedText(HISTORY.labels, { labels: card.labels.join(', ') }) : storedText(HISTORY.labelsRemoved))
    }
    if (patch.addLabels !== undefined || patch.removeLabels !== undefined) {
      if (patch.labels !== undefined) throw combworkError(LABELS_MIXED, undefined, { kind: 'invalid' })
      const change = labelChange(card.labels, patch.addLabels, patch.removeLabels)
      if (change) {
        card.labels = change.labels
        said.push(change.said)
      }
    }
    if (patch.blocked !== undefined) {
      const b = patch.blocked?.trim() ? text(patch.blocked.trim(), 1000, 'blockedReason') : null
      if (b !== card.blocked) said.push(b ? storedText(HISTORY.blocked, { reason: b }) : storedText(HISTORY.unblocked))
      card.blocked = b
    }
    if (patch.waitingFor !== undefined) {
      // Marked or cleared (HI-2618): by its own agent, the user or the Assistant (a script with the workspace token too),
      // never another project agent, who would silence this card's stalls.
      if (actor.kind === 'agent' && actor.self && card.agent !== actor.self.agentId) throw new TaskPermissionError(withValues(ERR.waitingNotYours, { card: cardRef(n) }))
      // A whole mark is undo's, put back as it was (who marked it, when); a string is a new one, by the caller, now.
      const whole = patch.waitingFor && typeof patch.waitingFor === 'object' ? patch.waitingFor : null
      const reason = (whole ? whole.reason : (patch.waitingFor as string | null))?.trim() ?? ''
      if (reason.length > MAX_WAITING) throw combworkError(ERR.waitingTooLong, { max: MAX_WAITING }, { kind: 'invalid' })
      if (reason) {
        if (card.column !== 'doing') throw combworkError(ERR.waitingNotActive, { card: cardRef(n), active: stageName('active', await stageNamesOf(ws, card.project)) }, { kind: 'conflict' })
        const mark = whole ? { reason, by: whole.by, at: whole.at } : { reason, by, at: new Date().toISOString() }
        if (reason !== card.waitingFor?.reason || (whole && (whole.by !== card.waitingFor?.by || whole.at !== card.waitingFor?.at))) {
          if (reason !== card.waitingFor?.reason) said.push(storedText(HISTORY.waiting, { reason }))
          card.waitingFor = mark
        }
      } else if (card.waitingFor) {
        delete card.waitingFor
        said.push(storedText(HISTORY.notWaiting))
      }
    }
    // Out of Doing however it went (submitted, put back, a verdict, moved on the board): its waiting mark goes with it.
    if (card.waitingFor && card.column !== 'doing') {
      delete card.waitingFor
      said.push(storedText(HISTORY.notWaiting))
    }
    if (patch.blockedBy !== undefined) {
      card.blockedBy = await cardRefs(patch.blockedBy, n, 'blockedBy', scope, card.blockedBy)
      said.push(card.blockedBy.length ? storedText(HISTORY.dependsOn, { cards: card.blockedBy.map(cardRef).join(', ') }) : storedText(HISTORY.noDependencies))
    }
    if (patch.links !== undefined) {
      card.links = await cardRefs(patch.links, n, 'links', scope, card.links)
      said.push(card.links.length ? storedText(HISTORY.linked, { cards: card.links.map(cardRef).join(', ') }) : storedText(HISTORY.linksRemoved))
    }
    // History lines of the caller's own (#1272: a reviewer's request, which watches count).
    // A loop step's line keeps the column it was written in (#1495), a value its words don't show: what pendingStep reads
    // when the history that said so has been trimmed.
    if (opts.note) said.push(...opts.note.map((s) => (s.id === HISTORY.loopStep.id ? { ...s, values: { ...s.values, column: card.column } } : s)))
    else if (comment) {
      const asked = await commentNote(ws, card, patch, actor, said, comment)
      if (asked) said.push(asked)
    }
    // What changed, in the history's words (English), for a caller that confirms it (the Combwork tools' short replies).
    opts.said?.push(...said.map(englishSaid))
    if (!said.length && !reordered && !reviewed && !comment) {
      // Nothing of the card's own to save, but a runtime write (an intent's facts, HI-2420) may be in this transaction:
      // the caller's authority checked here too, after the last await, so a revoked one leaves those undone.
      opts.commit?.()
      return card
    }
    // One change, one time (HI-2016): its lines share it, so what reads them as one change (a failed verdict's own move
    // back to Doing, watch.ts wakeAbout) does so however slowly they are written.
    const at = changeTime(card)
    for (const s of said) note(card, by, s, at)
    if (comment) addComment(card, by, comment, undefined, undefined, at)
    // The last thing before the write, after every read (saveCard's own too, HI-2415): a caller whose authority can change
    // while those awaits run (the Assistant's control and session) checks it there, so a revoked change saves nothing.
    // Unlike `check`, it doesn't see the card as it was before this change.
    await saveCard(ws, n, card, before, undefined, opts.commit)
    // Nobody on it, by the user's reason: recorded as an override is (setKind's), with the rule it passes.
    if (nobody) FactStore.forBoard(ws, { project: card.project, key: '' }).tx((tx) => tx.append(n, { kind: 'Override', actor: actorOf(actor), source: 'recorded', data: { rules: ['move.doingNobody'], move: `${CATEGORY_STAGE[before.column]}→active`, by: 'assistant', reason: nobody } })) // i18n-ignore: a fact's kind and codes, not text
    return card
  })()
  changed(ws)
  return result
}

/** A batch changes at most this many cards (its reply names each one). */
export const MAX_CHANGE_BATCH = 100

/** The fields a batch sets on every card it names (cw_update_tasks): comments, decisions and titles stay on the single call. */
export type BatchPatch = Pick<TaskPatch, 'column' | 'position' | 'blocked' | 'labels' | 'addLabels' | 'removeLabels' | 'agent' | 'override'>

/** What a batch did with one card: its change's history lines, or why it was refused (the card left as it was). */
export interface BatchItem {
  number: number
  card: TaskCard | null
  said: string[]
  error: string | null
  /** A refusal by the card's rules: its rule, next step and who can change it, as a single change's refusal gives them (HI-2238). */
  refused?: Pick<Refusal, 'rule' | 'next' | 'change'>
}

/** The card numbers of a batch: at least one, at most MAX_CHANGE_BATCH, each once. Checked before anything changes or is counted. */
export function batchNumbers(numbers: unknown): number[] {
  if (!Array.isArray(numbers) || !numbers.length) throw combworkError(msg({ id: 'tasks.error.changeNone', defaultMessage: 'cards: list the card numbers to change.', description: 'An error: a call to change several cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_CHANGE_BATCH) throw combworkError(ERR.cardsTooMany, { max: MAX_CHANGE_BATCH }, { kind: 'invalid' })
  return checkedNumbers(numbers)
}

/**
 * Changes many cards with the same fields, in the order given, in one board change. Each card goes through updateTask,
 * authorised against the card as it is then, with the same refusals and history lines as a single call. A refused card
 * (unknown, another project's, archived, in Doing with another agent, say) is left as it was and the others still apply:
 * each card is all or nothing, the batch is not. Its error is the one a missing card gets, so it reveals no more.
 * Position applies to each card in turn, so the last listed ends at the top (or bottom): cw_reorder_tasks sets an order.
 */
export async function updateTasks(numbers: number[], patch: BatchPatch, actor: TaskActor, opts: { commit?: () => void } = {}): Promise<BatchItem[]> {
  checkOverride(patch, actor)
  const ws = workspace
  const reads = await gatherReads(ws, await planned(ws, Array.isArray(numbers) ? numbers.filter((x) => Number.isInteger(x)).slice(0, MAX_CHANGE_BATCH) : [], patch, actor))
  return recording(actor, reads, () => cardBatch(ws, () => updateTasksUnbatched(numbers, patch, actor, opts)))
}

async function updateTasksUnbatched(numbers: number[], patch: BatchPatch, actor: TaskActor, opts: { commit?: () => void }): Promise<BatchItem[]> {
  const items: BatchItem[] = []
  for (const n of numbers) {
    const said: string[] = []
    try {
      // Each card a part of the batch's change undone on its own when refused (HR2's #1265 round 1: the runtime may have
      // written before a later check refused), keeping only a workflow refusal's own record (its Refused fact).
      const card = await boardSavepoint(
        workspace,
        async () => {
          // A move through the card's rules (#1265): the runtime's reads are made in the batch's change (a batch is one).
          const gate = await gateOf(workspace, n, patch, actor)
          if (gate) return await moveThrough(gate, n, patch, actor, { said, commit: opts.commit })
          // An agent's move, translated into its intent (#1268), as a single change's.
          const asAgent = await agentGateOf(workspace, n, patch, actor)
          if (asAgent) return await moveAsAgent(asAgent, n, patch, actor, { said, commit: opts.commit })
          // The locked change itself: the batch's reads were made before its lock, never under it (HR4's #1216 round 1).
          return await updateTaskLocked(n, patch, actor, { said, commit: opts.commit })
        },
        (e) => e instanceof WorkflowRefusedError
      )
      items.push({ number: n, card, said, error: null })
    } catch (e) {
      // The board's storage failing (a card's facts, SQLite) fails the batch whole: part of the card may be written.
      if (isStorageError(e)) throw e
      // A refusal by the card's rules keeps its English lines, as cw_update_task's reply has them (HI-2238): the message
      // with its stage's name, and the next step an agent would otherwise never see.
      const r = e instanceof WorkflowRefusedError ? e.refusal : null
      items.push({ number: n, card: null, said: [], error: r ? r.message : (e as Error).message, ...(r ? { refused: { rule: r.rule, next: r.next, ...(r.change ? { change: r.change } : {}) } } : {}) })
    }
  }
  return items
}

/**
 * A review (TaskPatch.review): the calling agent marks the card in Review that it reviews ("start"; the card keeps the
 * agent that did the work), or ends its review with a verdict ("passed", "failed"). One reviewer at a time: another
 * is refused, naming it; the same agent starting again only renews its mark. A verdict is only for the review the
 * caller has going on the card now: once the card has moved on (out of Review, say, for fixes, which ends the review)
 * an old verdict can't settle newer work. The user, the Assistant and scripts don't review through this (they have no
 * agent of the project to mark the card with). Returns whether the card changed (a renewal changes it without a line in
 * its history). Runs in the card's change, with the card as it is now.
 */
async function reviewChange(card: TaskCard, patch: TaskPatch, actor: TaskActor, said: StoredText[]): Promise<boolean> {
  const me = selfIn(actor, card.project)
  if (!me) throw new TaskPermissionError(msg({ id: 'tasks.error.reviewAgentsOnly', defaultMessage: "Only an agent of the card's project reviews it, through its own Combwork tools.", description: "An error: the user, the Assistant or a script tried to start or end a card's review; only an agent of the card's project does that, with its Combwork tools (the app's name)." }))
  const since = (r: NonNullable<TaskCard['review']>): string => r.since.slice(0, 16).replace('T', ' ')
  const n = card.number
  if (patch.review === 'start') {
    // (The runtime's own start review, #1267, writes the column its stage leaves, which is Review: the card stays.)
    if ((patch.column !== undefined && !(changeByRuntime() && patch.column === card.column)) || patch.agent !== undefined) throw combworkError(msg({ id: 'tasks.error.reviewOnItsOwn', defaultMessage: 'Start a review on its own: the card stays where it is, with its agent.', description: 'An error: a call started a review and also moved the card or gave it to an agent; a review starts on its own.' }), undefined, { kind: 'invalid' })
    if (card.column !== 'review') throw combworkError(msg({ id: 'tasks.error.reviewNotInReview', defaultMessage: '{card} is in {column, select, hold {On Hold} todo {Todo} doing {Doing} passed {Passed} done {Done} other {{column}}}. A card is reviewed in Review; if it needs more work, that is work on it (move it to doing).', description: 'An error: an agent tried to review card {card} (its key, such as HI-12), which is in the column {column} (select: a board column; translate each), not in Review. "doing" is the value the call takes: keep it as it is.' }), { card: cardRef(n), column: card.column }, { kind: 'invalid' })
    if (card.review && card.review.agent !== me && !changeByRuntime()) throw combworkError(msg({ id: 'tasks.error.reviewTaken', defaultMessage: '{agent} is already reviewing {card} (since {since} UTC).', description: 'An error: another agent ({agent}, its name) is already reviewing card {card} (its key, such as HI-12), since {since} (a date and time, UTC).' }), { agent: card.review.agentName, card: cardRef(n), since: since(card.review) }, { kind: 'invalid' })
    const a = await agentOf(card.project, me)
    if (!card.review) said.push(storedText(HISTORY.reviewStarted))
    card.review = { agent: a.id, agentName: a.name, since: new Date().toISOString() }
    return true
  }
  if (patch.review !== 'passed' && patch.review !== 'failed') throw combworkError(msg({ id: 'tasks.error.unknownReview', defaultMessage: 'Unknown review "{review}": start, passed or failed.', description: 'An error: the call\'s review was {review}, which it doesn\'t take. "start", "passed" and "failed" are the values it takes: keep them as they are.' }), { review: String(patch.review) }, { kind: 'invalid' })
  // A failed card goes back to Doing for its fixes, its builder's (HI-1946: as the verdict intent does, whatever the
  // rules): never anywhere else with its verdict. (The runtime's own verdict, #1267, moves a failed card itself: its
  // column is the stage it left.)
  if (patch.review === 'failed' && patch.column !== undefined && patch.column !== 'doing' && !changeByRuntime()) throw combworkError(msg({ id: 'tasks.error.failedToDoing', defaultMessage: 'A failed review sends {card} back to Doing, to its builder: give the verdict without column.', description: 'An error: a failed review also tried to move card {card} (its key, such as HI-12) somewhere other than Doing; a failed card goes back to Doing, to the agent that built it. "column" is the name of the call\'s field: keep it as it is.' }), { card: cardRef(n) }, { kind: 'invalid' })
  // The runtime's own verdict (#1267, #1268) was checked by its guards (who reviews, which submission): the card's review
  // mark, a 0.9 field, may be missing (its session ended since) or another reviewer's.
  if (card.review && card.review.agent !== me && !changeByRuntime()) throw combworkError(msg({ id: 'tasks.error.verdictNotYours', defaultMessage: '{agent} is reviewing {card}: its verdict is its own.', description: "An error: an agent tried to give a verdict on card {card} (its key, such as HI-12), which another agent ({agent}, its name) is reviewing." }), { agent: card.review.agentName, card: cardRef(n) }, { kind: 'invalid' })
  if ((!card.review || card.column !== 'review') && !changeByRuntime()) {
    throw combworkError(msg({ id: 'tasks.error.notReviewing', defaultMessage: 'You aren\'t reviewing {card} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.', description: 'An error: an agent tried to give a verdict on card {card} (its key, such as HI-12), but it has no review going on it. "review" and "start" are the call\'s field and value: keep them as they are.' }), { card: cardRef(n) }, { kind: 'invalid' })
  }
  said.push(storedText(patch.review === 'passed' ? HISTORY.reviewPassed : HISTORY.reviewFailed))
  delete card.review
  return true
}

/**
 * Notes on a card something Combwork did about it without changing it (#420: an agent's watch on it ended), as Combwork: English
 * text (kept as it is), or a message of the card history's (shared/taskHistory.ts), which the window shows in its language.
 */
export async function noteOnCard(n: number, what: string | StoredText, ws: WorkspaceService = workspace): Promise<void> {
  await boardLock(ws, async () => {
    const card = await getTask(n, ws)
    note(card, BY.combwork, what)
    await saveCard(ws, n, card)
    changed(ws)
  })
}

/**
 * A comment from Combwork itself on a card (#606: its agent's model changed after a safeguard stop), for whoever reads the
 * card. `still`: whether the card, as it is in the change, is still the one meant (its column, project and agent may
 * have changed since it was chosen). True when it was written. `said`: English text, or a message of the card history's
 * (shared/taskHistory.ts), kept as its English (`text`) and as data (`appText`, #846) for the window to show in its language.
 * `key`: the comment's id, at most once on the card. Or both (HI-2087): its English as agents read it (`text`, longer
 * than the window's), and the message the window shows (`shown`).
 */
export async function commentAsCombwork(n: number, said: string | StoredText | { text: string; shown: StoredText }, ws: WorkspaceService = workspace, still: (card: TaskCard) => boolean = () => true, key?: string): Promise<boolean> {
  return boardLock(ws, async () => {
    const card = await getTask(n, ws)
    // `key` (HI-2014): the comment's id, written once on the card: a retry finds it and writes nothing.
    if (card.archived || !still(card) || (key && card.comments.some((c) => c.id === key))) return false
    // Agents' English beside the window's message (and, where it is worded apart, what it is said from: `agent`).
    if (typeof said !== 'string' && 'shown' in said) addComment(card, BY.combwork, said.text, said.shown, key)
    else addComment(card, BY.combwork, typeof said === 'string' ? said : englishSaid(said), typeof said === 'string' ? undefined : said, key)
    await saveCard(ws, n, card)
    changed(ws)
    return true
  })
}

/** Why the clean-up left a card's planned files (HI-1842 round 2): what changed since its plan. */
export type CleanupLeft = 'gone' | 'unarchived' | 'moved' | 'hidden' | 'policy' | 'changed' | 'unsafe'

/**
 * The clean-up of an archived card's attachments (HI-1842, cardAttachmentCleanup.ts): its planned files to the Recycle
 * Bin and their rows, with a comment of Combwork's saying how many, which and why, in one change of the board, refused when
 * the run's workspace is no longer open (`alive`, checked again once the lock is held). In the change, the card is
 * checked again: still on the board, archived and in the planned project, that project still shown (not hidden or
 * removed), and still due under the project's setting as it is now (`days`, read here); then each file
 * (removeCardAttachments). What it left says why.
 */
export async function cleanUpAttachments(
  n: number,
  plan: { project: string; files: CleanupFile[]; visible: () => boolean; days: () => Promise<number | null>; due: (card: TaskCard, days: number) => boolean },
  ws: WorkspaceService,
  alive: () => boolean
): Promise<{ files: { name: string; size: number }[]; left: number; why?: CleanupLeft }> {
  return boardWrite(
    ws,
    async () => {
      const card = await getTask(n, ws).catch(() => null)
      const leave = (why: CleanupLeft) => ({ files: [], left: plan.files.length, why })
      if (!card) return leave('gone')
      if (!card.archived) return leave('unarchived')
      if ((card.project ?? '').toLowerCase() !== plan.project.toLowerCase()) return leave('moved')
      // Its project hidden or removed since the plan: its cards wait for it to come back (HR5's round 2).
      if (!plan.visible()) return leave('hidden')
      const days = await plan.days()
      if (days === null || !plan.due(card, days)) return leave('policy')
      const done = await removeCardAttachments(ws, n, plan.files)
      if (done.unsafe) return leave('unsafe')
      if (done.removed.length) {
        const said = storedText(HISTORY.attachmentsCleaned, { n: done.removed.length, names: done.removed.map((f) => f.name).join(', '), days })
        addComment(card, BY.combwork, englishSaid(said), said)
        await saveCard(ws, n, card)
        changed(ws)
      }
      return { files: done.removed, left: done.left, ...(done.left ? { why: 'changed' as const } : {}) } // i18n-ignore: a reason's key (CleanupLeft)
    },
    { alive }
  )
}

/** Why an agent's reviews stop, as its callers say it (in English), and its key in the history line's message. */
export type ReviewEnd = 'its session ended' | 'the agent was removed'
const REVIEW_END: Record<ReviewEnd, string> = { 'its session ended': 'sessionEnded', 'the agent was removed': 'agentRemoved' }

/**
 * Stops the reviews an agent has going (its session ended, or it was removed), so a card never shows a reviewer that
 * has gone. A review started again meanwhile by another agent is left alone.
 */
export function endReviews(project: string, agentId: string, why: ReviewEnd, ws: WorkspaceService = workspace): Promise<number[]> {
  return cardBatch(ws, () => endReviewsUnbatched(project, agentId, why, ws))
}

/**
 * A session ended: the reviews its agent had going end, on its own workspace's board (#1381). None when no window has
 * that workspace open now (closed as its agents stopped: its board isn't opened again, and workspaceOf's fallback, another
 * window's board, has other cards under the same project name), nor for the Assistant. Null when there is nothing to do.
 */
export function endExitedReviews(projectPath: string, agentId: string): Promise<number[]> | null {
  const ws = workspaceFor(projectPath)
  if (!ws || ws.isAssistantHome(projectPath)) return null
  return endReviews(basename(projectPath), agentId, 'its session ended', ws) // i18n-ignore: the reason's key (ReviewEnd)
}

async function endReviewsUnbatched(project: string, agentId: string, why: ReviewEnd, ws: WorkspaceService): Promise<number[]> {
  const mine = (await allTasks(ws, { reviewers: [agentId] })).filter((c) => c.review?.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
  const out: number[] = []
  for (const c of mine) {
    const ended = await (async () => {
      const card = await getTask(c.number, ws)
      if (card.review?.agent !== agentId) return false
      note(card, BY.combwork, storedText(HISTORY.reviewEnded, { agent: card.review.agentName, why: REVIEW_END[why] }))
      delete card.review
      await saveCard(ws, c.number, card)
      return true
    })().catch((e) => {
      log.warn(`Could not end the review of #${c.number}`, e)
      return false
    })
    if (ended) out.push(c.number)
  }
  if (out.length) changed(ws)
  return out
}

let amidRepair: (() => Promise<void> | void) | null = null
/** For tests: awaited inside endReviewsWithoutSession, once it has listed the cards (the moment a test switches workspaces in). */
export const setAmidRepairForTests = (fn: (() => Promise<void> | void) | null): void => {
  amidRepair = fn
}
/**
 * As a workspace opens (#1392): the reviews whose reviewer has no session running end, as its session's end would have
 * ended them. An end that came as its window closed the workspace (or after) didn't reach its board, which is fenced
 * then, so the card kept a reviewer that had gone. `live`: whether that agent of that project has a session now, asked
 * again just before each card is changed, so a reviewer that started meanwhile keeps its review. Only for the workspace
 * open as it is called: closed or switched meanwhile, it stops, and neither that board nor the next one is changed.
 */
export async function endReviewsWithoutSession(ws: WorkspaceService, live: (project: string, agentId: string) => boolean): Promise<number[]> {
  const path = ws.path
  const life = ws.lifetime
  // A board waiting for its upgrade to 1.0 takes no writes: repaired once it is upgraded (#1621).
  if (!path || boardReadOnly(ws)) return []
  const alive = (): boolean => !life.aborted && ws.path === path
  return boardWrite(ws, async () => {
    const gone = (await allTasks(ws, { archived: false })).filter((c) => c.review && c.review.agent !== ASSISTANT_AGENT_ID && !live(c.project, c.review.agent))
    await amidRepair?.()
    const out: number[] = []
    for (const c of gone) {
      if (!alive()) break
      const ended = await (async () => {
        const card = await getTask(c.number, ws)
        if (!alive() || !card.review || card.review.agent !== c.review!.agent || live(c.project, card.review.agent)) return false
        note(card, BY.combwork, storedText(HISTORY.reviewEnded, { agent: card.review.agentName, why: REVIEW_END['its session ended'] }))
        delete card.review
        await saveCard(ws, c.number, card)
        return true
      })().catch((e) => {
        log.warn(`Could not end the review of #${c.number}`, e)
        return false
      })
      if (ended) out.push(c.number)
    }
    if (out.length) changed(ws)
    return out
  }, { alive })
}

/**
 * A card's newest comment (the last one added; comments are kept in the order they were added, so equal times
 * don't matter), or null when it has none. Read as `readTask` reads: a confined agent can't read another project's.
 */
export async function latestComment(n: number, actor: TaskActor): Promise<{ number: number; comment: TaskComment | null; commentId: string | null; sources: Pick<TaskComment, 'id' | 'by' | 'at'>[] }> {
  const c = await readTask(n, actor)
  const last = c.comments.at(-1)
  // Its id and the card's comments' authors and times (HI-2402): for its attachments and where each came, never in a reply.
  return { number: c.number, comment: last ? withoutId(last) : null, commentId: last?.id ?? null, sources: c.comments.map(({ id, by, at }) => ({ id, by, at })) }
}

/** A comment or history entry as callers see it: its id is the card watches' (#224). */
export const withoutId = <T extends { id?: string }>({ id: _id, ...rest }: T): Omit<T, 'id'> => rest

/** A comment's text, checked: within the limit and not empty. */
function commentText(comment: string): string {
  const t = text(comment, MAX_TEXT, 'comment').trim()
  if (!t) throw combworkError(msg({ id: 'tasks.error.emptyComment', defaultMessage: 'The comment is empty.', description: 'An error: a comment on a card has no text.' }), undefined, { kind: 'invalid' })
  return t
}

/** Adds a comment, at `at` (its change's one time) or as a change of its own; one Combwork writes itself can carry its text as data (`appText`) beside its English. */
function addComment(c: TaskCard, by: string, t: string, appText?: StoredText, id?: string, at = changeTime(c)): void {
  c.comments = [...c.comments, { at, by, text: t, ...(appText ? { appText } : {}), id: id ?? entryId() }].slice(-MAX_COMMENTS)
  c.updatedAt = at
}

/** Comments on a card. `commit`: a revocable caller's last check before the write (HI-2415, as updateTask's). */
export async function commentTask(n: number, comment: string, actor: TaskActor, opts: { commit?: () => void } = {}): Promise<TaskCard> {
  const ws = workspace
  const t = commentText(comment)
  return recordingAs(actor, () => boardLock(ws, async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    if (c.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { card: cardRef(n) }))
    // A loop's request or reply (HI-2428), as updateTask's comment: its history line, which watches count and the
    // recorder wakes the other side with, in the same change.
    const own = await commentNote(ws, c, {}, actor, [], t)
    const by = actorName(actor)
    const at = changeTime(c)
    if (own) note(c, by, own, at)
    addComment(c, by, t, undefined, undefined, at)
    await saveCard(ws, n, c, undefined, undefined, opts.commit)
    changed(ws)
    return c
  }))
}

/**
 * An agent's request for the Combwork Assistant on a card (HI-1866, assistantAsk.ts): written as its comment, with a history
 * line, in one change of the board. `check` sees the card as it is in the change (another project's is unknown first) and
 * throws to refuse it, so a refused request writes nothing.
 */
export async function askAssistantOn(n: number, asked: string, actor: TaskActor, check: (card: TaskCard) => void, ws: WorkspaceService = workspace): Promise<TaskCard> {
  const t = commentText(asked)
  return recordingAs(actor, () => boardLock(ws, async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    check(c)
    const by = actorName(actor)
    note(c, by, storedText(HISTORY.assistantAsked, { text: clip(t) }))
    addComment(c, by, t)
    await saveCard(ws, n, c)
    changed(ws)
    return c
  }))
}

/** Files attached with a card's change (HI-1700): staged (cardAttachments.stage), and the draft link each stands for, if any. */
export interface ChangeAttachments {
  staging: Staging
  /** By source, in order: the draft (`draft-<k>`) the change's text links to it by, or null (a link to it is added). */
  drafts: (string | null)[]
}

/**
 * A card's change (`run`: a new card, a change, a comment) with files attached in the same change of the board (HI-1700,
 * s11 §4): published after it, the draft links in the text it made (the new comment's, else the description's) given the
 * stored ids and a link added for each file the text doesn't name; all of it saved, or none (the files go again). The
 * staging is removed whatever happens. Without files, just `run`. `commit`: a revocable caller's check (HI-2415), made
 * again before the files' own write, after their publish's awaits (`run` makes its own).
 */
export async function changeWithAttachments(actor: TaskActor, files: ChangeAttachments | null, where: 'comment' | 'description', run: () => Promise<TaskCard>, commit?: () => void): Promise<TaskCard & { attached?: { name: string; path: string; added: boolean }[] }> {
  if (!files) return run()
  const ws = workspace
  try {
    return await boardLock(ws, async () => {
      const made = await run()
      const n = made.number
      const before = await getTask(n, ws)
      const card = structuredClone(before)
      const comment = where === 'comment' ? card.comments.at(-1) : undefined
      const pub = await publish(ws, n, files.staging, actorName(actor), null)
      // Drafts (the window's) get their stored ids wherever the change's text links them; a file no draft names (an
      // agent's) gets a link of its own, in the comment, else at the end of the description.
      const ids = new Map<string, string>()
      const added: string[] = []
      for (const [i, a] of pub.attachments.entries()) {
        const draft = files.drafts[i]
        if (draft) ids.set(draft, a.id)
        else if (!added.some((l) => l.includes(a.id))) added.push(attachmentMarkdown(a.name, a.kind, attachmentHref(a.id)))
      }
      const withAdded = (t: string): string => (added.length ? `${t}${t.trim() ? '\n\n' : ''}${added.join('\n')}` : t)
      card.description = withStoredIds(card.description, ids)
      if (comment) comment.text = withAdded(withStoredIds(comment.text, ids))
      else card.description = withAdded(card.description)
      // Where each new file came: the comment that links it, else the description.
      const inComment = new Set(comment ? attachmentRefs(comment.text) : [])
      const fresh = pub.attachments.filter((_a, i) => pub.added[i]).map((a) => a.id)
      if (comment?.id) linkToComment(ws, n, fresh.filter((id) => inComment.has(id)), comment.id)
      linkToComment(ws, n, fresh.filter((id) => !inComment.has(id)), 'description')
      await saveCard(ws, n, card, before, undefined, commit)
      changed(ws)
      return { ...card, attached: pub.attachments.map((a, i) => ({ name: a.name, path: a.path, added: pub.added[i] })) }
    })
  } finally {
    await files.staging.dispose()
  }
}

/**
 * Changes the words of one of a card's decisions, or removes it (text null): the user's alone (#357). Agents and the
 * Assistant only record decisions; the history keeps what each said.
 */
export async function editDecision(n: number, id: string, newText: string | null, actor: TaskActor): Promise<TaskCard> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.decisionsUsers', defaultMessage: "Only the user changes or removes a card's decisions.", description: "An error: an agent or the Assistant tried to change or remove a decision on a card; only the user does that (they only record them)." }))
  const ws = workspace
  const t = newText === null ? null : text(newText, MAX_DECISION, 'decision').trim()
  if (t === '') throw combworkError(msg({ id: 'tasks.error.decisionEmptied', defaultMessage: 'The decision is empty: remove it instead.', description: "An error: the user emptied a decision's text; to take it off the card, remove it." }), undefined, { kind: 'invalid' })
  return recordingAs(actor, () => boardLock(ws, async () => {
    const c = await getTask(n, ws)
    const d = c.decisions?.find((x) => x.id === id)
    if (!d) throw combworkError(msg({ id: 'tasks.error.decisionGone', defaultMessage: 'That decision is no longer on {card}.', description: 'An error: the decision being changed was removed from card {card} (its key, such as HI-12) meanwhile.' }), { card: cardRef(n) }, { kind: 'notFound' })
    if (t === null) {
      c.decisions = c.decisions!.filter((x) => x.id !== id)
      if (!c.decisions.length) delete c.decisions
      note(c, BY.you, storedText(HISTORY.decisionRemoved, { decision: clip(d.text) }))
    } else {
      if (t === d.text) return c
      note(c, BY.you, storedText(HISTORY.decisionChanged, { decision: clip(t), was: clip(d.text) }))
      d.text = t
      d.editedAt = new Date().toISOString()
    }
    await saveCard(ws, n, c)
    changed(ws)
    return c
  }))
}

/** Archives a card (hidden from the board, kept) or brings it back. The user's alone. */
/**
 * Archives a card or brings it back, as the user (or `opts.actor`); `opts.check` sees the card as saved, under the board's
 * lock, and refuses by throwing (#1282: an undo archives a card only while no one has changed it since).
 */
export function archiveTask(n: number, archived: boolean, opts: { check?: (card: TaskCard) => void; actor?: TaskActor } = {}): Promise<TaskCard> {
  return boardLock(workspace, () => archiveTaskLocked(n, archived, opts))
}

async function archiveTaskLocked(n: number, archived: boolean, opts: { check?: (card: TaskCard) => void; actor?: TaskActor } = {}): Promise<TaskCard> {
  const ws = workspace
  return (async () => {
    const c = await getTask(n, ws)
    if (c.archived === archived) return c
    opts.check?.(c)
    c.archived = archived
    if (archived) c.archivedFor = 'user'
    else delete c.archivedFor
    // Brought back on its own, it leaves its batch: that batch's Undo no longer moves it.
    delete c.archivedBatch
    note(c, opts.actor ? actorName(opts.actor) : BY.you, storedText(archived ? HISTORY.archived : HISTORY.unarchived))
    // Back at the end of its column.
    if (!archived) c.order = orderIn(await boardPlaces(ws), c.column, n, null)
    await saveCard(ws, n, c)
    changed(ws)
    return c
  })()
}

// ---------------------------------------------------------------------------
// Bulk archiving (#351): the user's Archive All in a column and Archive All Cards. Each is a batch, recorded with its
// columns as they were, so Undo and "Unarchive this batch" bring its cards back where they were. Each is one board
// change (#1017), told once, not once a card.
// ---------------------------------------------------------------------------

const MAX_BATCH = 5000
const KEEP_BATCHES = 50

const isBatch = (b: unknown): b is ArchiveBatch => {
  const x = b as ArchiveBatch | null
  return !!x && typeof x.id === 'string' && typeof x.at === 'string' && typeof x.label === 'string' && Array.isArray(x.cards) && !!x.columns && typeof x.columns === 'object'
}

async function readBatches(ws: WorkspaceService): Promise<ArchiveBatch[]> {
  return archiveBatchDocs(ws).filter(isBatch)
}

/** The bulk archives kept (the latest 50), oldest first. */
export async function archiveBatches(ws: WorkspaceService = workspace): Promise<ArchiveBatch[]> {
  return ws.path ? readBatches(ws) : []
}

/**
 * Archives the cards listed, as one batch: the user's alone (agents and the Assistant never archive). Each card is checked
 * again as it is when it is archived, against what the user asked for: still in the column and project
 * the board showed and matching its search, and, unless `includeBusy`, not one an agent is on now (`busy`: its running
 * agent in Doing, its reviewer, an agent watching it). Those that aren't, or can't be read or saved, stay on the board
 * and come back in `skipped` with why; cards already archived or gone are passed over. Returns the batch (null when
 * nothing was archived) and the cards it archived.
 */
export function archiveBatch(numbers: unknown, req: ArchiveRequest, actor: TaskActor, opts: ArchiveOpts = {}): Promise<ArchiveResult> {
  return recordingAs(actor, () => cardBatch(workspace, () => archiveBatchUnbatched(numbers, req, actor, opts)))
}

/**
 * What archiving checks each card against besides the request: whether an agent is on it (`busy`), and its stage now
 * from its facts (`stageOf`, for a stage column's request: #1420).
 */
export interface ArchiveOpts {
  busy?: (card: TaskCard) => string | null
  stageOf?: (card: TaskCard) => StageId | null
}

async function archiveBatchUnbatched(numbers: unknown, req: ArchiveRequest, actor: TaskActor, opts: ArchiveOpts): Promise<ArchiveResult> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserArchives', defaultMessage: 'Only the user archives cards.', description: 'An error: an agent or the Assistant tried to archive cards; only the user does that.' }))
  if (!Array.isArray(numbers) || !numbers.length) throw combworkError(msg({ id: 'tasks.error.archiveNone', defaultMessage: 'cards: list the cards to archive.', description: 'An error: a call to archive cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_BATCH) throw combworkError(ERR.cardsTooMany, { max: MAX_BATCH }, { kind: 'invalid' })
  const nums = [...new Set(numbers.map((x) => Number(x)))]
  if (nums.some((x) => !Number.isInteger(x) || x < 1)) throw combworkError(msg({ id: 'tasks.error.archiveNumbers', defaultMessage: 'cards: card numbers only.', description: 'An error: the list of cards to archive has something other than card numbers in it. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (req.column !== null && !isTaskColumn(req.column)) throw unknownColumn(req.column)
  const stage = req.stage !== undefined && isStageId(req.stage) && req.column !== null && STAGE_CATEGORY[req.stage] === req.column ? req.stage : null
  // A card's stage as the board places it: its facts' while that is in its column's category, else its column's default.
  const stageNow = (c: TaskCard): StageId => {
    const s = opts.stageOf?.(c) ?? null
    return s && STAGE_CATEGORY[s] === c.column ? s : CATEGORY_STAGE[c.column]
  }
  const ws = workspace
  if (!ws.path) throw combworkError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const what = String(req.label ?? '').trim().slice(0, 80) || 'Archive All' // i18n-ignore: the batch's name, stored in English and quoted in its cards' history (the window words it, archiveBatchText)
  const project = typeof req.project === 'string' ? req.project : null
  const query = typeof req.query === 'string' ? req.query : ''
  // The board's search as the window ran it: keys and old keys too (#1221).
  const searchKeys = keysForSearch(ws)
  const searchMoved = movedNames(ws)
  const busy = req.includeBusy === true ? null : (opts.busy ?? null)
  // Why a card, as it is now, isn't one the user asked to archive (null: it is). Only the window reads it: in its language.
  const outside = (c: TaskCard): string | null =>
    req.column !== null && c.column !== req.column
      ? tr(msg({ id: 'tasks.skipped.movedColumn', defaultMessage: 'moved to {column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: 'Why Archive All left a card on the board (after its number, "#12 moved to Active"): it moved to the column {column} meanwhile (select: a board column; translate each). Lower case: it follows the number.' }), { column: c.column })
      : stage && stageNow(c) !== stage
        ? tr(msg({ id: 'tasks.skipped.movedStage', defaultMessage: 'moved to {stage}', description: 'Why Archive All of a stage column (Approved beside Merging) left a card on the board (after its number, "#12 moved to Merging"): it moved to another stage of the column meanwhile. {stage} is the stage’s name (glossary 2.2). Lower case: it follows the number.' }), { stage: tr(STAGE_TEXT[stageNow(c)]) })
      : project !== null && c.project.toLowerCase() !== project.toLowerCase()
        ? tr(msg({ id: 'tasks.skipped.movedProject', defaultMessage: 'moved to another project', description: 'Why Archive All left a card on the board (after its number, "#12 moved to another project"): it moved to another project meanwhile. Lower case: it follows the number.' }))
        : !cardMatches(c, query, searchKeys, searchMoved)
          ? tr(msg({ id: 'tasks.skipped.noMatch', defaultMessage: 'no longer matches the search', description: 'Why Archive All left a card on the board (after its number, "#12 no longer matches the search"): it changed meanwhile, and the board\'s search no longer finds it. Lower case: it follows the number.' }))
          : (busy?.(c) ?? null)
  const result = await boardLock(ws, async (): Promise<ArchiveResult> => {
    const all = await boardPlaces(ws)
    const want = new Set(nums)
    const going = all.filter((c) => want.has(c.number) && !c.archived)
    if (!going.length) return { batch: null, archived: [], skipped: [] }
    // Each column the batch leaves, as it is now: where its cards come back to.
    const columns: Partial<Record<TaskColumn, number[]>> = {}
    for (const c of going) columns[c.column] ??= all.filter((x) => x.column === c.column && !x.archived).map((x) => x.number)
    const batch: ArchiveBatch = { id: `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, at: new Date().toISOString(), by: BY.you, label: what, cards: going.map((c) => c.number), columns }
    const kept = await readBatches(ws)
    const done: number[] = []
    const skipped: { number: number; why: string }[] = []
    for (const c of going) {
      await (async () => {
        if (!hasCard(ws, c.number)) return
        const fresh = await getTask(c.number, ws).catch(() => null)
        if (!fresh) return void skipped.push({ number: c.number, why: tr(msg({ id: 'tasks.skipped.unreadable', defaultMessage: "couldn't be read", description: 'Why Archive All left a card on the board (after its number, "#12 couldn\'t be read"): its file could not be read. Lower case: it follows the number.' })) })
        if (fresh.archived) return
        const why = outside(fresh)
        if (why) return void skipped.push({ number: c.number, why })
        fresh.archived = true
        fresh.archivedFor = 'user'
        fresh.archivedBatch = batch.id
        note(fresh, BY.you, storedText(HISTORY.archivedInBatch, { n: going.length, label: what }))
        await saveCard(ws, c.number, fresh)
        done.push(c.number)
      })().catch((e) => {
        log.warn(`Could not archive #${c.number} with its batch`, e)
        skipped.push({ number: c.number, why: tr(msg({ id: 'tasks.skipped.unsaved', defaultMessage: "couldn't be saved", description: 'Why Archive All left a card on the board (after its number, "#12 couldn\'t be saved"): its file could not be written. Lower case: it follows the number.' })) })
      })
    }
    // In the same change as its cards: the batch lists exactly the cards it archived.
    batch.cards = done
    if (done.length) setArchiveBatches(ws, [...kept, batch].slice(-KEEP_BATCHES))
    return { batch: done.length ? batch : null, archived: done, skipped }
  })
  if (result.archived.length) {
    log.info(`Archived ${result.archived.length} card(s) in batch ${result.batch!.id} (${what})${result.skipped.length ? `; ${result.skipped.length} left on the board` : ''}`)
    changed(ws)
  }
  return result
}

/**
 * Brings a batch back (Undo, "Unarchive this batch"): the user's alone. Each of its cards still archived with it goes back
 * to its column, where it was among the cards there (restoreOrders); one brought back on its own meanwhile, archived
 * again since, or deleted is left as it is. A card that can't be read or saved stays archived with the batch and is in
 * `failed`: the batch is kept, so bringing it back again retries those. Once nothing failed, the batch is forgotten.
 */
export function unarchiveBatch(id: string, actor: TaskActor): Promise<UnarchiveResult> {
  return recordingAs(actor, () => cardBatch(workspace, () => boardLock(workspace, () => unarchiveBatchLocked(id, actor))))
}

async function unarchiveBatchLocked(id: string, actor: TaskActor): Promise<UnarchiveResult> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserUnarchives', defaultMessage: 'Only the user brings archived cards back.', description: 'An error: an agent or the Assistant tried to bring archived cards back onto the board; only the user does that.' }))
  const ws = workspace
  if (!ws.path) throw combworkError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const result = await (async (): Promise<UnarchiveResult> => {
    const batches = await readBatches(ws)
    const batch = batches.find((b) => b.id === id)
    if (!batch) throw combworkError(msg({ id: 'tasks.error.batchGone', defaultMessage: 'That batch is no longer kept: unarchive its cards from Archived.', description: "An error: the Archive All batch to bring back is no longer kept (Combwork keeps the latest 50); its cards can still be brought back one by one from the board's Archived list." }))
    const failed = new Set<number>()
    // The batch's own list, read card by card: one that can't be read now still belongs to it.
    const back: TaskCard[] = []
    for (const n of batch.cards) {
      if (!hasCard(ws, n)) continue
      const c = await getTask(n, ws).catch(() => null)
      if (!c) failed.add(n)
      else if (c.archived && c.archivedBatch === id) back.push(c)
    }
    const all = await boardPlaces(ws)
    const restored: number[] = []
    for (const { id: column } of TASK_COLUMNS) {
      const mine = back.filter((c) => c.column === column)
      if (!mine.length) continue
      const orders = restoreOrders(
        all.filter((c) => c.column === column && !c.archived),
        batch.columns[column] ?? [],
        mine.map((c) => c.number)
      )
      for (const c of mine) {
        await (async () => {
          if (!hasCard(ws, c.number)) return
          const fresh = await getTask(c.number, ws).catch(() => null)
          if (!fresh) return void failed.add(c.number)
          if (!fresh.archived || fresh.archivedBatch !== id) return
          fresh.archived = false
          delete fresh.archivedFor
          delete fresh.archivedBatch
          fresh.order = orders.get(c.number) ?? orderIn(await boardPlaces(ws), column, c.number, null)
          note(fresh, BY.you, storedText(HISTORY.backWithBatch, { label: batch.label }))
          await saveCard(ws, c.number, fresh)
          restored.push(c.number)
        })().catch((e) => {
          log.warn(`Could not bring #${c.number} back with its batch`, e)
          failed.add(c.number)
        })
      }
    }
    // Kept while any of its cards couldn't come back: bringing it back again tries those (the others aren't its any more).
    if (!failed.size) setArchiveBatches(ws, batches.filter((b) => b.id !== id))
    return { restored, failed: [...failed] }
  })()
  if (result.restored.length) {
    log.info(`Brought back ${result.restored.length} card(s) of batch ${id}${result.failed.length ? `; ${result.failed.length} couldn't be` : ''}`)
    changed(ws)
  }
  return result
}

/** The open cards (not archived or done) given to one agent of a project. */
export async function agentCards(project: string, agentId: string, ws: WorkspaceService = workspace): Promise<TaskCard[]> {
  return (await allTasks(ws, { archived: false, agents: [agentId] })).filter((c) => c.column !== 'done' && c.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
}

/**
 * Takes an agent's open cards from it (it is being removed): nobody has them, and Doing ones go back to Todo. A card
 * given to someone else meanwhile is left alone.
 */
export function releaseAgentCards(project: string, agentId: string, actor: TaskActor): Promise<number[]> {
  return recordingAs(actor, () => cardBatch(workspace, () => releaseAgentCardsUnbatched(project, agentId, actor)))
}

async function releaseAgentCardsUnbatched(project: string, agentId: string, actor: TaskActor): Promise<number[]> {
  const out: number[] = []
  for (const c of await agentCards(project, agentId)) {
    try {
      await updateTaskLocked(c.number, { agent: null, ...(c.column === 'doing' ? { column: 'todo' as const } : {}) }, actor, {
        check: (now) => {
          if (now.agent !== agentId || now.archived || now.column === 'done') throw new Error('changed meanwhile') // i18n-ignore: only logged
        }
      })
      out.push(c.number)
    } catch (e) {
      if (isStorageError(e)) throw e
      log.info(`#${c.number} left as it is: ${userText((e as Error).message)}`)
    }
  }
  return out
}

/**
 * A card being deleted (in its change): to the Recycle Bin as a file (`<n>.json`, as Export Board to JSON writes it),
 * from where the user can still get it back, then off the board.
 */
async function binCard(ws: WorkspaceService, n: number): Promise<boolean> {
  const doc = cardDoc(ws, n)
  if (!doc) return false
  const dir = join(ws.combworkDir, 'deleted-cards')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${n}.json`)
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await trash(file)
  // Its attachments (HI-1700) go with it: renamed into the cards' trash in this change, to the Recycle Bin once it commits.
  await trashCardFolder(ws, n, typeof doc.project === 'string' ? doc.project : null)
  return deleteCard(ws, n)
}

/** Deletes a card (to the Recycle Bin). The user's alone. Other cards' references to it are dropped. */
export async function deleteTask(n: number): Promise<void> {
  const ws = workspace
  // One change: a change already reading it finishes first, and one waiting finds it gone rather than writing it back.
  await boardLock(ws, async () => {
    if (!(await binCard(ws, n))) return
    await dropRefs(ws, new Set([n]))
    changed(ws)
  })
}

/** Drops references to cards that are gone from the others' blockedBy and links. */
async function dropRefs(ws: WorkspaceService, gone: Set<number>): Promise<void> {
  // As saved: a card read through getTask already leaves out references to cards that are gone.
  for (const { number, doc } of cardDocs(ws)) {
    const refs = [...(Array.isArray(doc.blockedBy) ? doc.blockedBy : []), ...(Array.isArray(doc.links) ? doc.links : [])]
    if (!refs.some((x) => gone.has(x as number))) continue
    const fresh = await getTask(number, ws).catch(() => null)
    if (fresh) await saveCard(ws, number, fresh)
  }
}

/**
 * When a card last went into Done: its latest "Moved to Done", "Created in Done" or bringing back from the
 * archive (a card the user brought back gets its days again). Its last change when its history has none.
 */
export function doneSince(card: TaskCard): number {
  const at = card.history.filter((h) => /^(Moved to Done|Created in Done|Brought back)/.test(h.what)).map((h) => Date.parse(h.at))
  const t = Math.max(...at.filter(Number.isFinite))
  return Number.isFinite(t) ? t : Date.parse(card.updatedAt) || 0
}

/** Archives the cards that have been in Done for Settings → Board's days (none when that is 0). */
export function archiveOldDone(ws: WorkspaceService, now = Date.now()): Promise<number[]> {
  // A board waiting for its upgrade to 1.0 takes no writes: archived once it is upgraded (#1621).
  if (ws.path && boardReadOnly(ws)) return Promise.resolve([])
  return cardBatch(ws, () => archiveOldDoneUnbatched(ws, now))
}

async function archiveOldDoneUnbatched(ws: WorkspaceService, now: number): Promise<number[]> {
  const days = Number(config.settings.board?.archiveDoneDays) || 0
  if (!ws.path || days <= 0) return []
  const cutoff = now - days * 86_400_000
  const out: number[] = []
  for (const c of await allTasks(ws, { archived: false })) {
    if (c.column !== 'done' || doneSince(c) > cutoff) continue
    await (async () => {
      // As it is now: moved out of Done or archived meanwhile, it stays.
      const fresh = await getTask(c.number, ws).catch(() => null)
      if (!fresh || fresh.archived || fresh.column !== 'done' || doneSince(fresh) > cutoff) return
      fresh.archived = true
      fresh.archivedFor = 'done'
      note(fresh, BY.combwork, storedText(HISTORY.archivedDone, { days }))
      await saveCard(ws, c.number, fresh)
      out.push(c.number)
    })()
  }
  if (out.length) {
    log.info(`Archived ${out.length} card(s) done for ${days}+ days: ${out.map((n) => `#${n}`).join(', ')}`)
    changed(ws)
  }
  return out
}

// ---------------------------------------------------------------------------
// A project leaving Combwork: its cards are archived (Hide, Remove) or deleted (Delete), and come back on Restore.
// ---------------------------------------------------------------------------

export async function projectCards(ws: WorkspaceService, project: string): Promise<TaskCard[]> {
  return (await allTasks(ws)).filter((c) => c.project.toLowerCase() === project.toLowerCase())
}

/** Archives the project's cards that are on the board, marked so restoring the project brings them back. */
export function archiveProjectCards(ws: WorkspaceService, project: string, why: 'project-hidden' | 'project-removed'): Promise<TaskCard[]> {
  return cardBatch(ws, () => archiveProjectCardsUnbatched(ws, project, why))
}

async function archiveProjectCardsUnbatched(ws: WorkspaceService, project: string, why: 'project-hidden' | 'project-removed'): Promise<TaskCard[]> {
  const out: TaskCard[] = []
  for (const c of await projectCards(ws, project)) {
    if (c.archived) continue
    await (async () => {
      const fresh = await getTask(c.number, ws)
      fresh.archived = true
      fresh.archivedFor = why
      note(fresh, BY.you, storedText(why === 'project-hidden' ? HISTORY.archivedHidden : HISTORY.archivedRemoved, { project }))
      await saveCard(ws, c.number, fresh)
      out.push(fresh)
    })()
  }
  if (out.length) changed(ws)
  return out
}

/** Brings back the cards archived when the project was hidden or removed. */
export function restoreProjectCards(ws: WorkspaceService, project: string): Promise<number> {
  return cardBatch(ws, () => restoreProjectCardsUnbatched(ws, project))
}

async function restoreProjectCardsUnbatched(ws: WorkspaceService, project: string): Promise<number> {
  let n = 0
  for (const c of await projectCards(ws, project)) {
    if (!c.archived || (c.archivedFor !== 'project-hidden' && c.archivedFor !== 'project-removed')) continue
    await (async () => {
      const fresh = await getTask(c.number, ws)
      fresh.archived = false
      delete fresh.archivedFor
      note(fresh, BY.you, storedText(HISTORY.restored, { project }))
      await saveCard(ws, c.number, fresh)
      n++
    })()
  }
  if (n) changed(ws)
  return n
}

/** Deletes the project's cards (to the Recycle Bin), with other cards' references to them. */
export function deleteProjectCards(ws: WorkspaceService, project: string): Promise<number> {
  return cardBatch(ws, () => deleteProjectCardsUnbatched(ws, project))
}

async function deleteProjectCardsUnbatched(ws: WorkspaceService, project: string): Promise<number> {
  const gone = new Set<number>()
  for (const c of await projectCards(ws, project)) {
    await binCard(ws, c.number)
    gone.add(c.number)
  }
  if (gone.size) {
    await dropRefs(ws, gone)
    changed(ws)
  }
  return gone.size
}

/**
 * Adds cards from another board (a removed project's, packed in its folder): each gets a new number, and their
 * references to each other follow; references to cards that didn't come along are dropped.
 */
export function importCards(ws: WorkspaceService, cards: TaskCard[], project: string): Promise<number> {
  return cardBatch(ws, () => boardLock(ws, () => importCardsLocked(ws, cards, project)))
}

async function importCardsLocked(ws: WorkspaceService, cards: TaskCard[], project: string): Promise<number> {
  if (!cards.length) return 0
  const map = new Map<number, number>()
  for (const c of cards) map.set(c.number, await nextNumber(ws))
  const all = await boardPlaces(ws)
  for (const raw of cards) {
    const c = clean(raw, map.get(raw.number)!)
    c.project = project
    c.blockedBy = c.blockedBy.flatMap((x) => (map.has(x) ? [map.get(x)!] : []))
    c.links = c.links.flatMap((x) => (map.has(x) ? [map.get(x)!] : []))
    if (c.archivedFor === 'project-removed' || c.archivedFor === 'project-hidden') {
      c.archived = false
      delete c.archivedFor
    }
    c.order = orderIn(all, c.column, null, null) + c.order / 1e6
    note(c, BY.you, storedText(HISTORY.imported, { project, was: raw.number }))
    await saveCard(ws, c.number, c)
  }
  changed(ws)
  return cards.length
}

