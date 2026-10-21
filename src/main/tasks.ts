import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { mkdir, writeFile } from 'original-fs/promises'
import { projectAgents } from '../shared/defaults'
import { englishText, forAgents, withValues, type Text } from '../shared/advanced'
import { msg, tr, type Msg } from '../shared/i18n'
import { COLUMN_CHOICES, TASK_COLUMNS, cardMatches, isTaskColumn, restoreOrders, sortCards } from '../shared/tasks'
import { HISTORY, storedLineText, storedText } from '../shared/taskHistory'
import { MAX_CONTEXT, MAX_CONTEXT_REF, parseDocRef } from '../shared/docRefs'
import { contextProblems } from './docSections'
import { providerMessage } from '../shared/providers'
import type { TaskMoveResult } from '../shared/types'
import { workflowMessage } from '../shared/workflow/texts'
import type { ArchiveBatch, ArchiveRequest, ArchiveResult, ContextProblem, SetAsideCard, StoredText, TaskCard, TaskDecision, TaskColumn, TaskComment, TaskHistoryEntry, TaskPatch, UnarchiveResult } from '../shared/types'
import { returnRound } from '../shared/watch'
import { holdsOf, trackHolds } from '../shared/cardCosts'
import { isProjectId, projectIdNamed, projectNameOf, projectNow, savedProjectName, type ProjectIdIndex } from '../shared/projectIds'
import { decisionGenerations, gatherReads, isStorageError, recordChange, recording, recordingAs, recordingByRuntime, type Planned } from './workflow/recorder'
import { alongside, isRefusal, type Workflow } from './workflow/runtime'
import { hasStage } from '../shared/workflow/compile'
import { answerFits, CATEGORY_STAGE, STAGE_CATEGORY, type RoundChoice, type StageId } from '../shared/workflow/facts'
import type { ForYouAnswer } from '../shared/workflow/workView'
import { LANE_MAX_ROUNDS } from '../shared/lanes'
import { REFUSALS, refusal as refusalOf, type Refusal } from '../shared/workflow/refusals'
import { afterBoardWrite, archiveBatchDocs, boardSavepoint, movedNames, boardRead, cardHeads, archivedSummaryDocs, boardChanged, boardWrite, cardDoc, cardDocs, cardNumbers, cardPlaces, costDocs, deleteCard, cardKeys, hasCard, holdDocs, keepOwnNumber, putCard, setArchiveBatches, setAsideAdded, setAsideFile, setAsideFiles, SET_ASIDE, takeNumber, type CardQuery } from './boardStore'
import { keysForSearch } from './projectKeys'
import { config } from './config'
import { HiveError, hiveError } from './hiveError'
import { createLogger, userText } from './logger'
import { workspace, type WorkspaceService } from './workspace'
import { trash } from './trash'
import { journalFact } from './journalService'

const log = createLogger('tasks')

/**
 * The board's refusals (#846, E10b of #677) are HiveErrors: the window reads them in its language, agents (the Agent API,
 * the hive tools) in English, exactly as before. A refusal's `kind` is set where it is the status its English always
 * gave (servers.ts `statusFor`); without one, the English still gives it. A column (`{column}`) is its key, and each
 * message chooses its words.
 */
const ERR = {
  unknownTask: msg({ id: 'tasks.error.unknownTask', defaultMessage: 'Unknown card #{n}', description: 'An error: there is no card #{n} (a number), or none the caller may see.' }),
  noWorkspace: msg({ id: 'tasks.error.noWorkspace', defaultMessage: 'No workspace is open', description: "An error: a change to the task board needs an open workspace, and there is none." }),
  needsTitle: msg({ id: 'tasks.error.needsTitle', defaultMessage: 'A card needs a title.', description: 'An error: a card was saved with an empty title.' }),
  unknownColumn: msg({ id: 'tasks.error.unknownColumn', defaultMessage: 'Unknown column "{column}": {choices}.', description: 'An error: {column} is not a column of the board; {choices} lists the column ids the call takes (hold, todo, doing… kept as they are).' }),
  archived: msg({ id: 'tasks.error.archived', defaultMessage: '#{n} is archived. Only the user can bring it back.', description: 'An error: card #{n} (a number) is archived, so an agent or the Assistant cannot change it; only the user can bring it back from the archive.' }),
  noCard: msg({ id: 'tasks.error.noCard', defaultMessage: 'There is no card #{n}.', description: 'An error: there is no card #{n} (a number) that the caller may see.' }),
  cardsTooMany: msg({ id: 'tasks.error.cardsTooMany', defaultMessage: 'cards: at most {max, number} cards at once.', description: 'An error: a call listed more than {max} cards. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsNotNumber: msg({ id: 'tasks.error.cardsNotNumber', defaultMessage: 'cards: "{value}" is not a card number', description: 'An error: {value} in the list of cards is not a card number. "cards:" is the name of the call\'s field: keep it as it is.' }),
  cardsTwice: msg({ id: 'tasks.error.cardsTwice', defaultMessage: 'cards: #{n} is listed twice', description: 'An error: the list of cards names card #{n} (a number) twice. "cards:" is the name of the call\'s field: keep it as it is.' }),
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
 * Who changes a card: the user (Hive's window), the Hive Assistant, or an agent or script through the Agent API.
 * `self` is the agent whose call it is (its project's folder name and id); scripts have none. `scope` confines a
 * project agent to its project's cards: others are "unknown" to it, as if they didn't exist.
 */
export type TaskActor = { kind: 'user' } | { kind: 'assistant' } | { kind: 'agent'; name: string; self?: { project: string; agentId: string }; scope?: string }

/** The project an actor is confined to on the board (a project agent's own), or null for the whole workspace. */
export const scopeOf = (a: TaskActor): string | null => (a.kind === 'agent' && a.scope !== undefined ? a.scope : null)

/** Whether a card is one the scope may see: every card without a scope, else only its project's (not the workspace's). */
export const inScope = (c: { project: string }, scope: string | null): boolean => scope === null || (!!c.project && c.project.toLowerCase() === scope.toLowerCase())

/** What a confined agent is told about a card outside its project: the same as for one that doesn't exist. */
export const unknownTask = (n: number): Error => new HiveError(forAgents(withValues(ERR.unknownTask, { n }), `Unknown task #${n}`), { kind: 'notFound' }) // i18n-ignore: agent-facing: the Agent API's words, as before (#910)
/** An empty title: the window says card; agents read the words they always did (#910). */
const needsTitle = (): HiveError => new HiveError(forAgents(ERR.needsTitle, 'A task needs a title.'), { kind: 'invalid' }) // i18n-ignore: agent-facing: the Agent API's words, as before (#910)

/** The calling agent, when a card of `project` going into Doing with no agent named should be given to it. */
const selfIn = (actor: TaskActor, project: string): string | null =>
  actor.kind === 'agent' && actor.self && project && actor.self.project.toLowerCase() === project.toLowerCase() ? actor.self.agentId : null

/** Who changed a card, as its history, comments and decisions store it: English, read by agents (the window words them, shared/taskHistory.ts BY_TEXT). */
const BY = { you: 'You', assistant: 'Assistant', hive: 'Hive', repair: 'Repair' } as const // i18n-ignore: stored with cards in English, as agents read them

export const actorName = (a: TaskActor): string => (a.kind === 'user' ? BY.you : a.kind === 'assistant' ? BY.assistant : a.name)

/** A change only the user may make (or the Assistant once the user said yes): thrown for others. The Agent API's 403. */
export class TaskPermissionError extends HiveError {
  constructor(text: Text) {
    super(text, { kind: 'forbidden' })
  }
}

/** A change the card's state rules out now (another agent is working on it): the Agent API's 409. */
export class TaskConflictError extends HiveError {
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
    super(withValues(REFUSALS[refusal.rule].message, refusal.values as Record<string, string | number>))
  }
}

const MAX_TITLE = 200
const MAX_TEXT = 20_000
const MAX_LABELS = 12
const MAX_COMMENTS = 500
const MAX_DECISIONS = 100
const MAX_DECISION = 4000
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
  return holdDocs(ws, o).map(({ number, doc }) => {
    const c = clean(doc as Partial<TaskCard> & { projectId?: unknown }, number, ids)
    return { number, project: c.project, held: c.held, history: c.history, agent: c.agent, agentName: c.agentName, review: c.review }
  })
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
  return sortCards(
    cardPlaces(ws).map(({ number, raw }) => {
      const c = clean(raw as Partial<TaskCard> & { projectId?: unknown }, number, ids)
      return { number, column: c.column, order: c.order, archived: c.archived, project: c.project }
    })
  )
}

/** Cards on the board, filtered; with `scope`, only that project's (asking for another project is refused). */
export async function listTasks(opts: { project?: string; column?: TaskColumn; archived?: boolean; scope?: string | null } = {}): Promise<TaskCard[]> {
  const scope = opts.scope ?? null
  if (scope !== null && opts.project !== undefined && opts.project.toLowerCase() !== scope.toLowerCase()) {
    throw new TaskPermissionError(withValues(msg({ id: 'tasks.error.ownCardsOnly', defaultMessage: "You can see only your project's cards ({project}).", description: "An error: an agent asked for another project's cards; it sees only its own project's ({project}, its folder name)." }), { project: scope }))
  }
  return (await allTasks(workspace, { archived: opts.archived ?? false })).filter(
    (c) =>
      (opts.project === undefined || c.project.toLowerCase() === opts.project.toLowerCase()) &&
      (!opts.column || c.column === opts.column) &&
      inScope(c, scope)
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
 * Saves a card (in a board change) with its project's id beside its name (#508). A card whose project the workspace doesn't
 * have now (removed, or renamed before it had an id) keeps the id it was saved with, if any, and never takes another
 * project's: shown as goneProject's while another project has its name, it is saved with that name as it was.
 */
async function saveCard(ws: WorkspaceService, n: number, card: TaskCard, before?: TaskCard | null): Promise<void> {
  // Who holds it now, for its cost (#602): a hold that ended gets its end, a new one starts.
  trackHolds(card, new Date().toISOString())
  const ids = await ws.projectIds()
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
  // Its facts, in the same transaction (#1216): what this change moved, started, submitted, reviewed, blocked or decided.
  recordChange(ws, before !== undefined ? before : was ? clean(was, n, ids) : null, { ...card, project: saved })
  // Its key now (#1219: a card moved to another project has that project's): what callers return of it.
  const key = cardKeys(ws, [n]).get(n)
  if (key) card.key = key
  else delete card.key
}

/** A card's fields in Hive's order, with its project and id as given (the rest as they were). */
function withProject(raw: Record<string, unknown>, project: string, projectId: string): Record<string, unknown> {
  const { number, title, description, project: _was, projectId: _id, ...rest } = raw
  return { number, title, description, project, projectId, ...rest }
}

/**
 * Each card names its project by id too (#508), once: a card saved before ids (or by an older Hive, which leaves the id
 * out) whose name is a project of the workspace gets that project's id, and a card whose project was renamed or moved
 * since gets its name now. A card with an id no project has (its project removed or gone) is left as it is, and so is one
 * saved before ids under a name no project has (Repair can give those to their project). In one board change, every
 * field kept (the cards' files as they were before 0.9 are kept in `.hive/tasks.imported-<time>`, #1017). Run each time
 * the workspace opens; it changes nothing the second time.
 */
export function stampCardProjects(ws: WorkspaceService): Promise<number> {
  if (!ws.path) return Promise.resolve(0)
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
    if (!projectId) throw hiveError(msg({ id: 'tasks.error.repairNoProject', defaultMessage: "{project} isn't a project of the workspace now", description: "An error from Repair: the project {project} (a folder name) it was to give cards to isn't in the workspace any more." }), { project: m.to })
    let n = 0
    for (const x of m.cards) {
      const moved = await (async () => {
        const raw = cardDoc(ws, x)
        if (!raw || isProjectId(raw.projectId) || typeof raw.project !== 'string' || raw.project.toLowerCase() !== m.from.toLowerCase()) return false
        const history = Array.isArray(raw.history) ? raw.history : []
        const entry = entryOf(new Date().toISOString(), BY.repair, storedText(HISTORY.repaired, { from: m.from, to: m.to }))
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
 * The cards an older Hive saved after the board moved to its database, set aside in `.hive/tasks.set-aside` (#1017's
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
    if (!entry || !raw) throw hiveError(msg({ id: 'tasks.error.setAsideGone', defaultMessage: 'That set-aside card is gone, or isn\'t a card: it can only be discarded.', description: "An error in the Review… dialog for cards an older Hive saved: the card's file was removed meanwhile, or can't be read as a card." }), undefined, { kind: 'notFound' })
    const ids = await ws.projectIds()
    const was = entry.number
    const n = hasCard(ws, was) ? await nextNumber(ws) : was
    const now = new Date().toISOString()
    const c = clean(raw, n, ids)
    // Every field the older Hive stored is kept (#1044 round 1: its own fields, past holds for its cost), Hive's own
    // fields as read (round 2: one of the wrong type gets its safe default, as on any read, so it can't stop the card
    // coming back; the original stays in the Recycle Bin): but its number, place, history and date. A review under way
    // there isn't one here (saveCard ends its reviewer's hold).
    const { review: _review, ...known } = c
    // Hive's optional fields only as read: one left out as broken isn't kept from the stored card either.
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
  if (!hit) throw hiveError(msg({ id: 'tasks.error.unknownProject', defaultMessage: 'Unknown project "{project}"', description: 'An error: the workspace has no project named {project}.' }), { project: v }, { kind: 'notFound' })
  return hit
}

/** An agent of the project, by id or name: its id and name. */
async function agentOf(project: string, agent: string): Promise<{ id: string; name: string }> {
  if (!project) throw new HiveError(forAgents(msg({ id: 'tasks.error.chooseProject', defaultMessage: 'Choose a project before giving the card to an agent.', description: "An error: a card of the whole workspace (no project) can't be given to an agent: agents belong to a project." }), 'Choose a project before giving the task to an agent.'), { kind: 'invalid' }) // i18n-ignore: agent-facing: the Agent API's words, as before (#910)
  const cfg = await workspace.projectConfig(join(workspace.path!, project))
  const a = projectAgents(cfg).find((x) => x.id === agent || x.name.toLowerCase() === agent.toLowerCase())
  if (!a) throw hiveError(UNKNOWN_AGENT, { agent, project }, { kind: 'notFound' })
  return { id: a.id, name: a.name }
}

/** An agent named that the project doesn't have (also taskStart.ts's). */
export const UNKNOWN_AGENT = msg({ id: 'tasks.error.unknownAgent', defaultMessage: 'Unknown agent "{agent}" in {project}', description: 'An error: the project {project} (a folder name) has no agent named {agent}.' })

/** A field of a card, by what its "too long" refusal calls it. */
type TextField = 'title' | 'description' | 'comment' | 'decision' | 'blockedReason'

const text = (v: unknown, max: number, what: TextField): string => {
  const s = String(v ?? '')
  if (s.length > max) {
    throw hiveError(msg({ id: 'tasks.error.tooLong', defaultMessage: '{what, select, title {The title is too long (at most {max, number} characters).} description {The description is too long (at most {max, number} characters).} comment {The comment is too long (at most {max, number} characters).} decision {The decision is too long (at most {max, number} characters).} other {The blocked reason is too long (at most {max, number} characters).}}', description: "An error: a card's field is longer than it may be ({what}, select: its title, description, comment, decision or blocked reason; translate each sentence); {max} is the most characters it takes." }), { what, max }, { kind: 'invalid' })
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
 * What a card's context references came to when it was started (#819), recorded on it as Hive: the problems, or none.
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
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.contextList', defaultMessage: 'context must be a list', description: `An error: the call gave the card's context (the doc sections to read first) as something other than a list. "context" is the name of the call's field: keep it as it is.` }), undefined, { kind: 'invalid' })
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
  if (out.length > MAX_CONTEXT) throw hiveError(msg({ id: 'tasks.error.tooManyContext', defaultMessage: 'A card can have up to {max} doc sections to read first.', description: 'An error: a card was given more context references (doc sections the agent reads first) than it may have ({max}, a number).' }), { max: MAX_CONTEXT }, { kind: 'invalid' })
  const bad = out.find((r) => r.length > MAX_CONTEXT_REF || !parseDocRef(r))
  if (bad !== undefined) throw hiveError(msg({ id: 'tasks.error.contextRef', defaultMessage: `"{ref}" isn't a doc section: give a Markdown file, optionally with # and a heading's slug ("docs/PLAN.md#setup", "shared:plans/notes.md#open-questions"), never a line number.`, description: `An error: one of the card's context references isn't a Markdown file with an optional #heading-slug. Keep the examples in quotes as they are.` }), { ref: bad.slice(0, 80) }, { kind: 'invalid' })
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
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.labelsList', defaultMessage: 'labels must be a list', description: 'An error: the call gave the card\'s labels as something other than a list. "labels" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  const out = normalLabels(v)
  if (out.length > MAX_LABELS) throw hiveError(TOO_MANY_LABELS, { max: MAX_LABELS }, { kind: 'invalid' })
  return out
}

/** addLabels or removeLabels, read as labels is (normalLabels). */
function someLabels(v: unknown, field: 'addLabels' | 'removeLabels'): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.labelFieldList', defaultMessage: '{field} must be a list', description: 'An error: the call gave the labels to add or remove as something other than a list. {field} is the name of the call\'s field ("addLabels" or "removeLabels"): keep it as it is.' }), { field }, { kind: 'invalid' })
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
  if (both.length) throw hiveError(msg({ id: 'tasks.error.labelsAddedAndRemoved', defaultMessage: "A label can't be both added and removed: {labels}.", description: 'An error: the call named the same labels ({labels}, separated by commas) both to add to the card and to take off it.' }), { labels: both.join(', ') }, { kind: 'invalid' })
  const added = plus.filter((l) => !labels.includes(l))
  const removed = minus.filter((l) => labels.includes(l))
  if (!added.length && !removed.length) return null
  const next = [...labels.filter((l) => !removed.includes(l)), ...added]
  if (next.length > MAX_LABELS) throw hiveError(TOO_MANY_LABELS, { max: MAX_LABELS }, { kind: 'invalid' })
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
  if (!Array.isArray(v)) throw hiveError(msg({ id: 'tasks.error.refsList', defaultMessage: '{field} must be a list of card numbers', description: 'An error: the call gave {field} (the name of its field: blockedBy or links, kept as it is) as something other than a list of card numbers.' }), { field: what })
  const nums = [...new Set(v.map((x) => Number(String(x).replace(/^#/, ''))))]
  const hidden = await refsOutside(kept, scope)
  const noCard = (n: number): HiveError => hiveError(msg({ id: 'tasks.error.refsNoCard', defaultMessage: '{field}: there is no card #{n}', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) names card #{n} (a number), which there is not.' }), { field: what, n }, { kind: 'invalid' })
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1) throw hiveError(msg({ id: 'tasks.error.refsNotNumber', defaultMessage: '{field}: "{value}" is not a card number', description: 'An error: the list {field} (the name of the call\'s field: blockedBy or links, kept as it is) has {value} in it, which is not a card number.' }), { field: what, value: String(n) }, { kind: 'invalid' })
    if (n === self) throw hiveError(msg({ id: 'tasks.error.refsSelf', defaultMessage: "{field}: a card can't refer to itself", description: "An error: the list {field} (the name of the call's field: blockedBy or links, kept as it is) names the card itself." }), { field: what }, { kind: 'invalid' })
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
      ? withValues(msg({ id: 'tasks.error.holdCard', defaultMessage: 'Only the user or the Assistant puts cards On Hold: ask the user to park #{n}.', description: 'An error: an agent tried to move card #{n} (a number) On Hold (a board column), which only the user or the Assistant may do.' }), { n })
      : msg({ id: 'tasks.error.holdNew', defaultMessage: 'Only the user or the Assistant puts cards On Hold: ask the user to park it.', description: 'An error: an agent tried to add a card On Hold (a board column), which only the user or the Assistant may do.' })
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
  if (position !== undefined && position !== 'top' && position !== 'bottom') throw hiveError(msg({ id: 'tasks.error.unknownPosition', defaultMessage: 'Unknown position "{position}": top or bottom.', description: 'An error: the call\'s position was {position}, which it doesn\'t take. "top" and "bottom" are the values it takes: keep them as they are.' }), { position: String(position) }, { kind: 'invalid' })
  if (placed && before !== undefined && before !== null && position !== undefined) throw hiveError(msg({ id: 'tasks.error.beforeOrPosition', defaultMessage: 'Give before or position, not both.', description: 'An error: the call gave both of its fields "before" and "position" (keep them as they are), which place a card in two ways.' }), undefined, { kind: 'invalid' })
  const list = all.filter((c) => c.column === column && !c.archived && c.number !== card.number)
  // A confined agent places its card among its project's cards: the top and bottom of those, never past another project's.
  const scope = scopeOf(actor)
  const own = list.filter((c) => inScope(c, scope))
  if (placed && actor.kind !== 'user') {
    if (column === 'done') throw new TaskPermissionError(ERR.onlyUserDone)
    if (before != null && !own.some((c) => c.number === before)) {
      const other = all.find((c) => c.number === before && inScope(c, scope))
      if (before === card.number) throw hiveError(msg({ id: 'tasks.error.beforeItself', defaultMessage: "A card can't go before itself.", description: 'An error: a card was to be placed just above itself.' }), undefined, { kind: 'invalid' })
      if (!other) throw hiveError(ERR.noCard, { n: before }, { kind: 'invalid' })
      // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
      if (other.archived) throw hiveError(msg({ id: 'tasks.error.beforeArchived', defaultMessage: "#{before} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: #{n} can only go before a card in the column it's in.", description: 'An error: card #{n} was to be placed just above card #{before} (numbers), which is archived, not in the column {column} (select: a board column; translate each).' }), { before, column, n: card.number }, { kind: 'conflict' })
      throw hiveError(msg({ id: 'tasks.error.beforeElsewhere', defaultMessage: "#{before} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}: #{n} can only go before a card in the column it's in.", description: 'An error: card #{n} was to be placed just above card #{before} (numbers), which is in the column {other}, not in {column} (select: board columns; translate each).' }), { before, other: other.column, column, n: card.number }, { kind: 'invalid' })
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
          ? storedText(HISTORY.movedBefore, { column, before: before! })
          : storedText(HISTORY.movedBeforeIn, { column, before: before! })
  return { order, said }
}

/**
 * Puts cards at the top of a column in the order given; the column's other cards keep their order below them. The
 * listed cards have to be in that column already (this never moves cards between columns), and only the user puts
 * Done in order. An agent's or the Assistant's list adds a line to each card it moved.
 */
export function reorderTasks(column: TaskColumn, numbers: unknown, actor: TaskActor): Promise<TaskCard[]> {
  return recordingAs(actor, () => cardBatch(workspace, () => boardLock(workspace, () => reorderTasksLocked(column, numbers, actor))))
}

async function reorderTasksLocked(column: TaskColumn, numbers: unknown, actor: TaskActor): Promise<TaskCard[]> {
  if (!isTaskColumn(column)) throw unknownColumn(column)
  if (column === 'done' && actor.kind !== 'user') throw new TaskPermissionError(ERR.onlyUserDone)
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.orderNone', defaultMessage: 'cards: list the card numbers in the order wanted.', description: 'An error: a call to put cards in order listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > 500) throw hiveError(ERR.cardsTooMany, { max: 500 }, { kind: 'invalid' })
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
    if (!other) throw hiveError(ERR.noCard, { n: x }, { kind: 'invalid' })
    // Archived, it is a conflict (409) as its English always said; in another column, a mistake in the call (400).
    if (other.archived) throw hiveError(msg({ id: 'tasks.error.orderArchived', defaultMessage: '#{n} is archived, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card #{n} (a number) was listed to be put in order in the column {column}, but it is archived (select: a board column; translate each).' }), { n: x, column }, { kind: 'conflict' })
    throw hiveError(msg({ id: 'tasks.error.orderElsewhere', defaultMessage: '#{n} is in {other, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{other}}}, not in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}. Only cards already in {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}} can be put in order there.', description: 'An error: card #{n} (a number) was listed to be put in order in the column {column}, but it is in the column {other} (select: board columns; translate each).' }), { n: x, other: other.column, column }, { kind: 'invalid' })
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
      if (card.column !== column || card.archived) throw hiveError(msg({ id: 'tasks.error.orderChanged', defaultMessage: '#{n} changed while the cards were being put in order; read the board again.', description: 'An error: card #{n} (a number) moved or was archived while the cards were being put in order, so the order asked for no longer holds.' }), { n: x }, { kind: 'conflict' })
      card.order = orderAt(i)
      if (was !== i && actor.kind !== 'user') note(card, by, i === 0 ? storedText(HISTORY.movedTop, { column }) : storedText(HISTORY.placed, { place: i + 1, column }))
      await saveCard(ws, x, card)
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

/** A message within a history line's values: a CLI's sentence (providerMessage) or the workflow's (a request's, #1266). */
const lineMessage = (id: string): Msg | null => providerMessage(id) ?? workflowMessage(id)

/** A history line's English, from its message and values: what agents read and Hive's own code matches (`what`). */
const englishSaid = (s: StoredText): string => {
  const t = storedLineText(s, (m, values) => englishText(values ? withValues(m, values) : m), lineMessage)
  if (t === null) throw new Error(`No history line ${s.id}`) // i18n-ignore: a mistake in Hive's code, never shown
  return t
}

/**
 * A line in the card's history: its English (`what`), and as data (`whatText`, #846) for the window to show in its
 * language. Text from elsewhere (an agent-facing note, noteOnCard) is kept in English only.
 */
function note(card: TaskCard, by: string, said: StoredText | string): void {
  const at = new Date().toISOString()
  card.history = [...card.history, entryOf(at, by, said)].slice(-MAX_HISTORY)
  card.updatedAt = at
}

const entryOf = (at: string, by: string, said: StoredText | string): TaskHistoryEntry =>
  typeof said === 'string' ? { at, by, what: said, id: entryId() } : { at, by, what: englishSaid(said), whatText: said, id: entryId() }

/** Column names in English, for the log. */
const COLUMN_WORD = Object.fromEntries(TASK_COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>

const unknownColumn = (column: unknown): HiveError => hiveError(ERR.unknownColumn, { column: String(column), choices: COLUMN_CHOICES }, { kind: 'invalid' })

/** Card numbers as a call lists them ("#3" or 3), each checked: a whole number, listed once. */
function checkedNumbers(numbers: unknown[]): number[] {
  const nums = numbers.map((x) => Number(String(x).replace(/^#/, '')))
  const seen = new Set<number>()
  for (const x of nums) {
    if (!Number.isInteger(x) || x < 1) throw hiveError(ERR.cardsNotNumber, { value: String(x) }, { kind: 'invalid' })
    if (seen.has(x)) throw hiveError(ERR.cardsTwice, { n: x }, { kind: 'invalid' })
    seen.add(x)
  }
  return nums
}

/** Who can return a failed card for review: its own agent (its hive tools, or the Agent API with its token) or the user. */
const returnsCard = (actor: TaskActor, card: TaskCard): boolean => actor.kind === 'user' || (actor.kind === 'agent' && !!card.agent && actor.self?.agentId === card.agent)

export async function createTask(...args: Parameters<typeof createTaskLocked>): Promise<TaskCard> {
  const [input, actor] = args
  const ws = workspace
  // Made in Doing or Review with an agent, its work starts or is submitted: the platform's reads, before the change (#1216).
  const column = input.column ?? 'todo'
  const project = (column === 'doing' || column === 'review') && ws.path ? await projectName(scopeOf(actor) !== null && input.project === undefined ? scopeOf(actor)! : input.project).catch(() => '') : ''
  const agent = project ? await agentIdIn(ws, project, input.agent ?? selfIn(actor, project)) : null
  const reads = agent ? await gatherReads(ws, [{ number: NEW_CARD, project, agent, why: column === 'doing' ? 'start' : 'submit' }]) : null // i18n-ignore: an internal value
  return recording(actor, reads, () => boardLock(ws, () => createTaskLocked(...args)))
}

async function createTaskLocked(
  input: { title: string; description?: string; project?: string; agent?: string | null; column?: TaskColumn; labels?: string[]; blocked?: string | null; blockedBy?: number[]; links?: number[]; context?: string[] },
  actor: TaskActor
): Promise<TaskCard> {
  if (!workspace.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
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
  const ws = workspace
  const by = actorName(actor)
  const now = new Date().toISOString()
  const blockedBy = input.blockedBy ? await cardRefs(input.blockedBy, null, 'blockedBy', scope) : []
  const links = input.links ? await cardRefs(input.links, null, 'links', scope) : []
  const context = input.context ? contextOf(input.context) : []
  const problems = context.length ? await contextProblems(project && workspace.path ? join(workspace.path, project) : null, workspace.sharedDir, context) : []
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
    history: [entryOf(now, by, storedText(HISTORY.created, { column }))],
    archived: false,
    createdAt: now,
    createdBy: by,
    updatedAt: now
  }
  await saveCard(ws, n, card, null)
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
 * Changes a card. `comment` is the same call's comment (the hive tools' and PATCH's): saved with the change in one write,
 * so nothing that reads the card meanwhile (a card watch waking its agent, the board) sees the move without it.
 */
export async function updateTask(...args: Parameters<typeof updateTaskLocked>): Promise<TaskCard> {
  const [n, patch, actor, opts = {}] = args
  const ws = workspace
  checkOverride(patch, actor)
  // The user's or the Assistant's column move, through the card's workflow rules (#1265): its reads made by the runtime,
  // before its own lock; the rest of the change saved with the move, in its transaction.
  const gate = await gateOf(ws, n, patch, actor)
  if (gate) return moveThrough(gate, n, patch, actor, opts)
  const reads = await gatherReads(ws, await planned(ws, [n], patch, actor))
  return recording(actor, reads, () => boardLock(ws, () => updateTaskLocked(...args)))
}

/** An override is the user's or the Assistant's (SPEC §16.8.4): agents never override a rule. */
function checkOverride(patch: TaskPatch, actor: TaskActor): void {
  if (patch.override === undefined) return
  if (actor.kind === 'agent') throw new TaskPermissionError(msg({ id: 'tasks.error.overrideNotAgents', defaultMessage: "Agents can't override workflow rules: only the user or the Assistant can.", description: 'An error: an agent passed an override (moving a card across a workflow rule, with a reason); only the user or the Hive Assistant can.' }))
  if (!patch.override || typeof patch.override !== 'object' || typeof patch.override.reason !== 'string') throw hiveError(msg({ id: 'tasks.error.overrideShape', defaultMessage: 'An override needs a reason: why the card moves across its rules, as text.', description: 'An error: an override (moving a card across a workflow rule) was passed without its reason as text.' }), undefined, { kind: 'invalid' })
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
  if (!rec || rec.preWorkflow) return null
  const to = CATEGORY_STAGE[patch.column]
  const s = wf.state(rec)
  // A stage its ruleset lacks: refused by the runtime with why (the window's move, `anyStage`); the board's other moves
  // keep P3's recorded move until the window asks through tasks:move (#1275), so today's columns go on working.
  if (s.stage === to || (!o.anyStage && !hasStage(wf.rulesetOf(rec, s), to))) return null
  const agent = patch.agent !== undefined ? await agentIdIn(ws, head.project, patch.agent) : typeof head.agent === 'string' && head.agent ? head.agent : null
  return { wf, to, by: actor.kind, ...(agent ? { builder: agent } : {}) }
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
  zero9: (w: { was: StageId; current: StageId }, first: boolean) => { patch?: TaskPatch; opts?: Parameters<typeof updateTaskLocked>[3] } = () => ({})
): Promise<{ reply: R; saved: TaskCard | null }> {
  let saved: TaskCard | null = null
  let first = true
  const reply = await recording(actor, null, () =>
    alongside(
      {
        written: async (w) => {
          const extra = zero9(w, first)
          first = false
          // The write's move, for the loop wake it makes (#1266: into Passed or Done wakes the builder).
          const moved = w.written.findLast((f) => f.kind === 'Moved')?.seq ?? null
          // Its column only when it moved: a write that moves nothing (an answer, a review's start) leaves the card's
          // place, so a failed card still in Review isn't "returned for review" by it (#1269 round 3).
          const p: TaskPatch = { ...extra.patch, ...(moved !== null ? { column: STAGE_CATEGORY[w.current] } : {}) }
          saved = await recordingByRuntime(() => updateTaskAs(n, p, actor, { ...extra.opts, was: STAGE_CATEGORY[w.was] }), moved)
        }
      },
      () => call(wf)
    )
  )
  return { reply, saved }
}

/**
 * A column move through the card's runtime (#1265): `Workflow.move` on the intent path, the change's other fields (and
 * its comment) saved with its first write, its place with the write that reaches the column asked for. The user's move
 * with `confirm` skips what it must and records an `Override`; the Assistant's needs `override.reason` for that.
 */
async function moveThroughRules(g: Gate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}, confirm = true): Promise<MoveResult> {
  const ws = workspace
  const target = patch.column!
  const { column: _column, before, position, override, ...rest } = patch
  const reason = override?.reason.trim()
  const { reply, saved } = await runIntent(
    g.wf,
    n,
    actor,
    (wf) => wf.move(n, g.to, g.by, { confirm, ...(reason ? { reason } : {}), ...(g.builder ? { builder: g.builder } : {}) }),
    (w, first) => {
      const placed = STAGE_CATEGORY[w.current] === target ? { ...(before !== undefined ? { before } : {}), ...(position !== undefined ? { position } : {}) } : {}
      return { patch: { ...(first ? rest : {}), ...placed }, opts: first ? opts : {} }
    }
  )
  // A drag that went as far as it could (its start written, its submission refused for what no override makes true).
  if (isRefusal(reply)) return saved ? { moved: saved, stopped: reply } : { refused: reply }
  if ('ask' in reply) return saved ? { moved: saved } : { ask: reply.rules }
  if (saved) return { moved: saved }
  // Nothing moved (the card was already there): the rest of the change, as any other.
  const others: TaskPatch = { ...rest, ...(before !== undefined ? { before } : {}), ...(position !== undefined ? { position } : {}) }
  return { moved: Object.keys(others).length || opts.comment ? await updateTask(n, others, actor, opts) : await getTask(n, ws) }
}

async function moveThrough(g: Gate, n: number, patch: TaskPatch, actor: TaskActor, opts: Parameters<typeof updateTaskLocked>[3] = {}): Promise<TaskCard> {
  // The window's change (`ask`: IPC tasks:update, #1275) never skips a rule unasked: its moves go through tasks:move,
  // which asks; one that would skip a rule here is refused with the rules it names. Hive's own calls for the user (a
  // card's Start) confirm as before.
  const { ask, ...rest } = opts
  const r = await moveThroughRules(g, n, patch, actor, rest, !ask)
  if ('refused' in r) throw new WorkflowRefusedError(r.refused)
  // Stopped part way: the user sees where the card is; the Assistant is told why it stopped there (its start kept).
  if ('moved' in r && r.stopped && actor.kind !== 'user') throw new WorkflowRefusedError(r.stopped)
  if ('ask' in r) throw new WorkflowRefusedError(refusalOf('move.needsOverride', { card: `#${n}`, stage: g.to, rules: r.ask.join(', ') }, 'the user')) // i18n-ignore: who can override, agent-facing (§16.8.3)
  return r.moved
}

/**
 * The window's move (`tasks:move`, #1265): through the card's rules when they apply, asking first unless `confirm`
 * (the rules it would skip, nothing written), else a plain move. Never refused for a rule: the user overrides.
 */
export async function moveTask(n: number, column: TaskColumn, o: { before?: number | null; confirm?: boolean; reason?: string; agent?: string | null } = {}): Promise<MoveResult> {
  const actor: TaskActor = { kind: 'user' }
  // `agent`: the Move to Doing dialog's choice (an agent, or nobody), given with the move.
  const patch: TaskPatch = { column, ...(o.before !== undefined ? { before: o.before } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}), ...(o.reason ? { override: { reason: o.reason } } : {}) }
  const gate = await gateOf(workspace, n, patch, actor, { anyStage: true })
  if (!gate) {
    const { override: _o, ...plain } = patch
    return { moved: await updateTask(n, plain, actor) }
  }
  return moveThroughRules(gate, n, patch, actor, {}, !!o.confirm)
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

/** An answer the window sent that can't be one (the request's kind decides which fields it takes). */
const BAD_ANSWER = msg({ id: 'tasks.error.badAnswer', defaultMessage: "That answer doesn't fit the request: approve or decline an approval, answer a question with a reply or a decision, and choose a way on at the round limit (a carry on with 1 to {max} more rounds).", description: "An error answering a request for the user (For you): what was sent doesn't fit the request's kind. {max} is the most rounds a carry on can add (a number)." })

/**
 * The user answers a card's request (IPC `tasks:answer`, #1269, SPEC §16.8.5): only the user (Darren's point 7: never
 * an agent or the Assistant). On the intent path (`runIntent`), so the answer, what it moves and the card's 0.9 fields
 * are one transaction, checked there (the request still open, the card where it was asked, its generation current). A
 * decision (a Decide answer) is the card's, added with the answer's write: a new generation, its agents told (#1266). A
 * reply is kept with the answer and relayed to the waiting agent. Refused with the rule's text when the request was
 * answered or retired meanwhile.
 */
export async function answerTask(n: number, request: string, a: ForYouAnswer): Promise<TaskCard> {
  const ws = workspace
  const actor: TaskActor = { kind: 'user' }
  const bad = (): HiveError => hiveError(BAD_ANSWER, { max: LANE_MAX_ROUNDS }, { kind: 'invalid' })
  if (!a || !['approved', 'declined', 'answered'].includes(a.outcome) || typeof request !== 'string' || !request) throw bad()
  const reply = typeof a.reply === 'string' && a.reply.trim() ? text(a.reply.trim(), MAX_TEXT, 'comment') : undefined
  const decision = typeof a.decision === 'string' && a.decision.trim() ? text(a.decision.trim(), MAX_DECISION, 'decision') : undefined
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
  if (!wf || !req) throw new WorkflowRefusedError(refusalOf('move.notFromHere', { card: `#${n}`, stage: CATEGORY_STAGE[head.column as TaskColumn] ?? 'todo', move: 'answer', moves: '' }))
  // What each kind takes (answerFits): an approval is approved or declined; at the round limit, a choice (a carry on with
  // its rounds); any other question, a reply or a decision. Checked before anything is written.
  const choice = a.choice as RoundChoice | undefined
  if (!answerFits(req, { outcome: a.outcome, reply: !!reply, decision: !!decision, choice, rounds: a.rounds }, LANE_MAX_ROUNDS)) throw bad()
  const { reply: r } = await runIntent(
    wf,
    n,
    actor,
    (w) => w.answer(n, request, a.outcome, { ...(reply ? { note: reply } : {}), ...(decision ? { decided: true } : {}), ...(choice ? { choice } : {}), ...(choice === 'carryOn' ? { rounds: a.rounds } : {}) }),
    (_w, first) => ({ patch: first && decision ? { decision } : {} })
  )
  if (isRefusal(r)) throw new WorkflowRefusedError(r)
  return getTask(n, ws)
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

async function updateTaskLocked(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[]; comment?: string; commit?: () => void; was?: TaskColumn; ask?: boolean } = {}): Promise<TaskCard> {
  // Its facts are this actor's (#1216), with the reads its caller made before the change, if any.
  return recordingAs(actor, () => updateTaskAs(n, patch, actor, opts))
}

async function updateTaskAs(n: number, patch: TaskPatch, actor: TaskActor, opts: { check?: (card: TaskCard) => void; said?: string[]; comment?: string; commit?: () => void; was?: TaskColumn }): Promise<TaskCard> {
  await taskTestHooks.beforeUpdate?.(n)
  const ws = workspace
  const by = actorName(actor)
  const comment = opts.comment === undefined ? null : commentText(opts.comment)
  // Moved into Done: merged, a fact for the Assistant's journal (#1031) once it is saved.
  let intoDone = false
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
    if (card.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { n }))
    // A card in Doing with another agent is that agent's work in progress: a project agent can't move it on to Review or
    // Done (a reviewer whose review ended when it came back for more work, say). Checked on the card as it is, before
    // anything else in the change (giving it to itself in the same call doesn't get round it). A project agent is one
    // calling with its own token (actor.self); the user, the Assistant and scripts with the workspace token can.
    // A review verdict or start is refused on a card in Doing anyway (reviewChange), with its own reason.
    const moving = patch.review === undefined && (patch.column === 'review' || patch.column === 'passed' || patch.column === 'done')
    if (actor.kind === 'agent' && actor.self && moving && card.column === 'doing' && card.agent && card.agent !== actor.self.agentId) {
      const column = patch.column!
      throw new TaskConflictError(
        card.agentName
          ? withValues(msg({ id: 'tasks.error.inDoingWith', defaultMessage: "#{n} is in Doing with {agent}, who is working on it: newer work is in progress, so it can't be moved to {column, select, review {Review} passed {Passed} done {Done} other {{column}}} by another agent. Leave it where it is; {agent} moves it to Review when done, and the user can move it.", description: 'An error: an agent tried to move card #{n} (a number) on to {column} (select: a board column; translate each), but the card is in Doing with another agent ({agent}, its name), whose work is in progress. Doing and Review are board columns.' }), { n, agent: card.agentName, column })
          : withValues(msg({ id: 'tasks.error.inDoingWithAnother', defaultMessage: "#{n} is in Doing with another agent, who is working on it: newer work is in progress, so it can't be moved to {column, select, review {Review} passed {Passed} done {Done} other {{column}}} by another agent. Leave it where it is; another agent moves it to Review when done, and the user can move it.", description: "An error: an agent tried to move card #{n} (a number) on to {column} (select: a board column; translate each), but the card is in Doing with another agent (whose name isn't known), whose work is in progress. Doing and Review are board columns." }), { n, column })
      )
    }
    const said: StoredText[] = []
    // Whether a move to Review returns a failed card for review (#214): decided on the card as it is before this change,
    // by whoever has it now, so giving it to the caller in the same change never makes it the caller's to return.
    const returning = patch.column === 'review' && patch.review === undefined && returnsCard(actor, card) ? returnRound(card) : null
    const { agent: hadAgent, project: hadProject } = card
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
        if (patch.agent) throw hiveError(msg({ id: 'tasks.error.projectThenAgent', defaultMessage: 'Move the card to the other project first, then give it to one of its agents.', description: "An error: one change both moved a card to another project and gave it to an agent; those are two changes, in that order." }), undefined, { kind: 'invalid' })
        said.push(p ? storedText(HISTORY.toProject, { project: p }) : storedText(HISTORY.toWorkspace))
        if (card.agent) said.push(card.project ? storedText(HISTORY.takenFromOf, { agent: card.agentName ?? card.agent, project: card.project }) : storedText(HISTORY.takenFromOfWorkspace, { agent: card.agentName ?? card.agent }))
        if (card.review) {
          said.push(storedText(HISTORY.reviewStopped, { agent: card.review.agentName }))
          delete card.review
        }
        card.project = p
        card.agent = null
        delete card.agentName
        transferred = true
      }
    }
    // An agent that moves a card into Doing from another column, naming no agent, is taking it (not in a project
    // change): also from another agent, who wasn't working on it since it wasn't in Doing ("Given to …" in its history).
    const own = !transferred && patch.agent === undefined && patch.column === 'doing' && card.column !== 'doing' ? selfIn(actor, card.project) : null
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
      if (column === 'done' && card.column !== 'done') intoDone = true
      card.column = column
    }
    if (patch.decision !== undefined) {
      // Recorded by whoever calls (the user, the Assistant, an agent), decided by the user: agents only write down what
      // the user decided (their tool's description says so). Editing or removing one is the user's (editDecision).
      const t = text(patch.decision, MAX_DECISION, 'decision').trim()
      if (!t) throw hiveError(ERR.emptyDecision)
      const list = card.decisions ?? []
      if (list.length >= MAX_DECISIONS) throw hiveError(msg({ id: 'tasks.error.tooManyDecisions', defaultMessage: 'A card can have up to {max} decisions.', description: 'An error: a card already has as many decisions as it may have ({max}, a number).' }), { max: MAX_DECISIONS })
      card.decisions = [...list, { id: entryId(), text: t, decidedBy: 'user', recordedBy: by, at: new Date().toISOString() }]
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
      if (patch.labels !== undefined) throw hiveError(LABELS_MIXED, undefined, { kind: 'invalid' })
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
    if (patch.blockedBy !== undefined) {
      card.blockedBy = await cardRefs(patch.blockedBy, n, 'blockedBy', scope, card.blockedBy)
      said.push(card.blockedBy.length ? storedText(HISTORY.dependsOn, { cards: card.blockedBy.map((x) => `#${x}`).join(', ') }) : storedText(HISTORY.noDependencies))
    }
    if (patch.links !== undefined) {
      card.links = await cardRefs(patch.links, n, 'links', scope, card.links)
      said.push(card.links.length ? storedText(HISTORY.linked, { cards: card.links.map((x) => `#${x}`).join(', ') }) : storedText(HISTORY.linksRemoved))
    }
    // What changed, in the history's words (English), for a caller that confirms it (the hive tools' short replies).
    opts.said?.push(...said.map(englishSaid))
    if (!said.length && !reordered && !reviewed && !comment) return card
    for (const s of said) note(card, by, s)
    if (comment) addComment(card, by, comment)
    // The last thing before the write, after every read above: a caller whose authority can change while those awaits run
    // (the Assistant's control and session) checks it here, so a revoked change saves nothing. Unlike `check`, it doesn't
    // see the card as it was before this change.
    opts.commit?.()
    await saveCard(ws, n, card, before)
    return card
  })()
  changed(ws)
  if (intoDone) afterBoardWrite(ws, () => journalFact(ws, { summary: `#${n} "${result.title}" is Done (merged), moved there by ${by}`, project: result.project || null, links: [{ type: 'card', ref: String(n) }], tags: ['done'] })) // i18n-ignore: a journal fact (the Assistant's, English)
  return result
}

/** A batch changes at most this many cards (its reply names each one). */
export const MAX_CHANGE_BATCH = 100

/** The fields a batch sets on every card it names (hive_update_tasks): comments, decisions and titles stay on the single call. */
export type BatchPatch = Pick<TaskPatch, 'column' | 'position' | 'blocked' | 'labels' | 'addLabels' | 'removeLabels' | 'agent' | 'override'>

/** What a batch did with one card: its change's history lines, or why it was refused (the card left as it was). */
export interface BatchItem {
  number: number
  card: TaskCard | null
  said: string[]
  error: string | null
}

/** The card numbers of a batch: at least one, at most MAX_CHANGE_BATCH, each once. Checked before anything changes or is counted. */
export function batchNumbers(numbers: unknown): number[] {
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.changeNone', defaultMessage: 'cards: list the card numbers to change.', description: 'An error: a call to change several cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_CHANGE_BATCH) throw hiveError(ERR.cardsTooMany, { max: MAX_CHANGE_BATCH }, { kind: 'invalid' })
  return checkedNumbers(numbers)
}

/**
 * Changes many cards with the same fields, in the order given, in one board change. Each card goes through updateTask,
 * authorised against the card as it is then, with the same refusals and history lines as a single call. A refused card
 * (unknown, another project's, archived, in Doing with another agent, say) is left as it was and the others still apply:
 * each card is all or nothing, the batch is not. Its error is the one a missing card gets, so it reveals no more.
 * Position applies to each card in turn, so the last listed ends at the top (or bottom): hive_reorder_tasks sets an order.
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
          // The locked change itself: the batch's reads were made before its lock, never under it (HR4's #1216 round 1).
          return gate ? await moveThrough(gate, n, patch, actor, { said, commit: opts.commit }) : await updateTaskLocked(n, patch, actor, { said, commit: opts.commit })
        },
        (e) => e instanceof WorkflowRefusedError
      )
      items.push({ number: n, card, said, error: null })
    } catch (e) {
      // The board's storage failing (a card's facts, SQLite) fails the batch whole: part of the card may be written.
      if (isStorageError(e)) throw e
      items.push({ number: n, card: null, said: [], error: (e as Error).message })
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
  if (!me) throw new TaskPermissionError(msg({ id: 'tasks.error.reviewAgentsOnly', defaultMessage: "Only an agent of the card's project reviews it, through its own hive tools.", description: "An error: the user, the Assistant or a script tried to start or end a card's review; only an agent of the card's project does that, with its hive tools (a name: keep it)." }))
  const since = (r: NonNullable<TaskCard['review']>): string => r.since.slice(0, 16).replace('T', ' ')
  const n = card.number
  if (patch.review === 'start') {
    if (patch.column !== undefined || patch.agent !== undefined) throw hiveError(msg({ id: 'tasks.error.reviewOnItsOwn', defaultMessage: 'Start a review on its own: the card stays where it is, with its agent.', description: 'An error: a call started a review and also moved the card or gave it to an agent; a review starts on its own.' }))
    if (card.column !== 'review') throw hiveError(msg({ id: 'tasks.error.reviewNotInReview', defaultMessage: '#{n} is in {column, select, hold {On Hold} todo {Todo} doing {Doing} passed {Passed} done {Done} other {{column}}}. A card is reviewed in Review; if it needs more work, that is work on it (move it to doing).', description: 'An error: an agent tried to review card #{n} (a number), which is in the column {column} (select: a board column; translate each), not in Review. "doing" is the value the call takes: keep it as it is.' }), { n, column: card.column })
    if (card.review && card.review.agent !== me) throw hiveError(msg({ id: 'tasks.error.reviewTaken', defaultMessage: '{agent} is already reviewing #{n} (since {since} UTC).', description: 'An error: another agent ({agent}, its name) is already reviewing card #{n} (a number), since {since} (a date and time, UTC).' }), { agent: card.review.agentName, n, since: since(card.review) })
    const a = await agentOf(card.project, me)
    if (!card.review) said.push(storedText(HISTORY.reviewStarted))
    card.review = { agent: a.id, agentName: a.name, since: new Date().toISOString() }
    return true
  }
  if (patch.review !== 'passed' && patch.review !== 'failed') throw hiveError(msg({ id: 'tasks.error.unknownReview', defaultMessage: 'Unknown review "{review}": start, passed or failed.', description: 'An error: the call\'s review was {review}, which it doesn\'t take. "start", "passed" and "failed" are the values it takes: keep them as they are.' }), { review: String(patch.review) })
  // A failed card stays in Review for its fixes: never on to Passed or Done with its verdict.
  if (patch.review === 'failed' && patch.column !== undefined && patch.column !== 'review') throw hiveError(msg({ id: 'tasks.error.failedStays', defaultMessage: 'A failed review leaves #{n} in Review: give the verdict without column.', description: 'An error: a failed review also moved card #{n} (a number) out of Review; a failed card stays in Review. "column" is the name of the call\'s field: keep it as it is.' }), { n }, { kind: 'invalid' })
  if (card.review && card.review.agent !== me) throw hiveError(msg({ id: 'tasks.error.verdictNotYours', defaultMessage: '{agent} is reviewing #{n}: its verdict is its own.', description: "An error: an agent tried to give a verdict on card #{n} (a number), which another agent ({agent}, its name) is reviewing." }), { agent: card.review.agentName, n })
  if (!card.review || card.column !== 'review') {
    throw hiveError(msg({ id: 'tasks.error.notReviewing', defaultMessage: 'You aren\'t reviewing #{n} now: its review ended (the card moved, or your session ended) or never started. Start one with review "start" if it is in Review.', description: 'An error: an agent tried to give a verdict on card #{n} (a number), but it has no review going on it. "review" and "start" are the call\'s field and value: keep them as they are.' }), { n })
  }
  said.push(storedText(patch.review === 'passed' ? HISTORY.reviewPassed : HISTORY.reviewFailed))
  delete card.review
  return true
}

/**
 * Notes on a card something Hive did about it without changing it (#420: an agent's watch on it ended), as Hive: English
 * text (kept as it is), or a message of the card history's (shared/taskHistory.ts), which the window shows in its language.
 */
export async function noteOnCard(n: number, what: string | StoredText, ws: WorkspaceService = workspace): Promise<void> {
  await boardLock(ws, async () => {
    const card = await getTask(n, ws)
    note(card, BY.hive, what)
    await saveCard(ws, n, card)
    changed(ws)
  })
}

/**
 * A comment from Hive itself on a card (#606: its agent's model changed after a safeguard stop), for whoever reads the
 * card. `still`: whether the card, as it is in the change, is still the one meant (its column, project and agent may
 * have changed since it was chosen). True when it was written. `said`: English text, or a message of the card history's
 * (shared/taskHistory.ts), kept as its English (`text`) and as data (`hiveText`, #846) for the window to show in its language.
 */
export async function commentAsHive(n: number, said: string | StoredText, ws: WorkspaceService = workspace, still: (card: TaskCard) => boolean = () => true): Promise<boolean> {
  return boardLock(ws, async () => {
    const card = await getTask(n, ws)
    if (card.archived || !still(card)) return false
    addComment(card, BY.hive, typeof said === 'string' ? said : englishSaid(said), typeof said === 'string' ? undefined : said)
    await saveCard(ws, n, card)
    changed(ws)
    return true
  })
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

async function endReviewsUnbatched(project: string, agentId: string, why: ReviewEnd, ws: WorkspaceService): Promise<number[]> {
  const mine = (await allTasks(ws, { reviewers: [agentId] })).filter((c) => c.review?.agent === agentId && c.project.toLowerCase() === project.toLowerCase())
  const out: number[] = []
  for (const c of mine) {
    const ended = await (async () => {
      const card = await getTask(c.number, ws)
      if (card.review?.agent !== agentId) return false
      note(card, BY.hive, storedText(HISTORY.reviewEnded, { agent: card.review.agentName, why: REVIEW_END[why] }))
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

/**
 * A card's newest comment (the last one added; comments are kept in the order they were added, so equal times
 * don't matter), or null when it has none. Read as `readTask` reads: a confined agent can't read another project's.
 */
export async function latestComment(n: number, actor: TaskActor): Promise<{ number: number; comment: TaskComment | null }> {
  const c = await readTask(n, actor)
  const last = c.comments.at(-1)
  return { number: c.number, comment: last ? withoutId(last) : null }
}

/** A comment or history entry as callers see it: its id is the card watches' (#224). */
export const withoutId = <T extends { id?: string }>({ id: _id, ...rest }: T): Omit<T, 'id'> => rest

/** A comment's text, checked: within the limit and not empty. */
function commentText(comment: string): string {
  const t = text(comment, MAX_TEXT, 'comment').trim()
  if (!t) throw hiveError(msg({ id: 'tasks.error.emptyComment', defaultMessage: 'The comment is empty.', description: 'An error: a comment on a card has no text.' }), undefined, { kind: 'invalid' })
  return t
}

/** Adds a comment; one Hive writes itself can carry its text as data (`hiveText`) beside its English. */
function addComment(c: TaskCard, by: string, t: string, hiveText?: StoredText): void {
  const at = new Date().toISOString()
  c.comments = [...c.comments, { at, by, text: t, ...(hiveText ? { hiveText } : {}), id: entryId() }].slice(-MAX_COMMENTS)
  c.updatedAt = at
}

export async function commentTask(n: number, comment: string, actor: TaskActor): Promise<TaskCard> {
  const ws = workspace
  const t = commentText(comment)
  return recordingAs(actor, () => boardLock(ws, async () => {
    const c = await getTask(n, ws)
    if (!inScope(c, scopeOf(actor))) throw unknownTask(n)
    if (c.archived && actor.kind !== 'user') throw new TaskPermissionError(withValues(ERR.archived, { n }))
    addComment(c, actorName(actor), t)
    await saveCard(ws, n, c)
    changed(ws)
    return c
  }))
}

/**
 * Changes the words of one of a card's decisions, or removes it (text null): the user's alone (#357). Agents and the
 * Assistant only record decisions; the history keeps what each said.
 */
export async function editDecision(n: number, id: string, newText: string | null, actor: TaskActor): Promise<TaskCard> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.decisionsUsers', defaultMessage: "Only the user changes or removes a card's decisions.", description: "An error: an agent or the Assistant tried to change or remove a decision on a card; only the user does that (they only record them)." }))
  const ws = workspace
  const t = newText === null ? null : text(newText, MAX_DECISION, 'decision').trim()
  if (t === '') throw hiveError(msg({ id: 'tasks.error.decisionEmptied', defaultMessage: 'The decision is empty: remove it instead.', description: "An error: the user emptied a decision's text; to take it off the card, remove it." }))
  return recordingAs(actor, () => boardLock(ws, async () => {
    const c = await getTask(n, ws)
    const d = c.decisions?.find((x) => x.id === id)
    if (!d) throw hiveError(msg({ id: 'tasks.error.decisionGone', defaultMessage: 'That decision is no longer on #{n}.', description: 'An error: the decision being changed was removed from card #{n} (a number) meanwhile.' }), { n })
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
export function archiveTask(n: number, archived: boolean): Promise<TaskCard> {
  return boardLock(workspace, () => archiveTaskLocked(n, archived))
}

async function archiveTaskLocked(n: number, archived: boolean): Promise<TaskCard> {
  const ws = workspace
  return (async () => {
    const c = await getTask(n, ws)
    if (c.archived === archived) return c
    c.archived = archived
    if (archived) c.archivedFor = 'user'
    else delete c.archivedFor
    // Brought back on its own, it leaves its batch: that batch's Undo no longer moves it.
    delete c.archivedBatch
    note(c, BY.you, storedText(archived ? HISTORY.archived : HISTORY.unarchived))
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
export function archiveBatch(numbers: unknown, req: ArchiveRequest, actor: TaskActor, opts: { busy?: (card: TaskCard) => string | null } = {}): Promise<ArchiveResult> {
  return recordingAs(actor, () => cardBatch(workspace, () => archiveBatchUnbatched(numbers, req, actor, opts)))
}

async function archiveBatchUnbatched(numbers: unknown, req: ArchiveRequest, actor: TaskActor, opts: { busy?: (card: TaskCard) => string | null }): Promise<ArchiveResult> {
  if (actor.kind !== 'user') throw new TaskPermissionError(msg({ id: 'tasks.error.onlyUserArchives', defaultMessage: 'Only the user archives cards.', description: 'An error: an agent or the Assistant tried to archive cards; only the user does that.' }))
  if (!Array.isArray(numbers) || !numbers.length) throw hiveError(msg({ id: 'tasks.error.archiveNone', defaultMessage: 'cards: list the cards to archive.', description: 'An error: a call to archive cards listed none. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (numbers.length > MAX_BATCH) throw hiveError(ERR.cardsTooMany, { max: MAX_BATCH }, { kind: 'invalid' })
  const nums = [...new Set(numbers.map((x) => Number(x)))]
  if (nums.some((x) => !Number.isInteger(x) || x < 1)) throw hiveError(msg({ id: 'tasks.error.archiveNumbers', defaultMessage: 'cards: card numbers only.', description: 'An error: the list of cards to archive has something other than card numbers in it. "cards:" is the name of the call\'s field: keep it as it is.' }), undefined, { kind: 'invalid' })
  if (req.column !== null && !isTaskColumn(req.column)) throw unknownColumn(req.column)
  const ws = workspace
  if (!ws.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
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
      ? tr(msg({ id: 'tasks.skipped.movedColumn', defaultMessage: 'moved to {column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: 'Why Archive All left a card on the board (after its number, "#12 moved to Doing"): it moved to the column {column} meanwhile (select: a board column; translate each). Lower case: it follows the number.' }), { column: c.column })
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
  if (!ws.path) throw hiveError(ERR.noWorkspace, undefined, { kind: 'conflict' })
  const result = await (async (): Promise<UnarchiveResult> => {
    const batches = await readBatches(ws)
    const batch = batches.find((b) => b.id === id)
    if (!batch) throw hiveError(msg({ id: 'tasks.error.batchGone', defaultMessage: 'That batch is no longer kept: unarchive its cards from Archived.', description: "An error: the Archive All batch to bring back is no longer kept (Hive keeps the latest 50); its cards can still be brought back one by one from the board's Archived list." }))
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
  const dir = join(ws.hiveDir, 'deleted-cards')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${n}.json`)
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await trash(file)
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
      note(fresh, BY.hive, storedText(HISTORY.archivedDone, { days }))
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
// A project leaving Hive: its cards are archived (Hide, Remove) or deleted (Delete), and come back on Restore.
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

