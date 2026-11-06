import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo, ArchiveBatch, BoardColumnId, BoardFold, ProjectInfo, StoredText, TaskCard, TaskColumn, TaskDecision, TaskPatch, TaskStartTarget } from '@shared/types'
import { BUSY, BY_TEXT, storedLineText } from '@shared/taskHistory'
import { gitProblemText } from '@shared/gitTool'
import { agentRuntime, hooksMissingText } from '@shared/runtime'
import { LOOP_STEP_WAIT_MINUTES } from '@shared/lanes'
import { projectInfoPreferences } from '@shared/workflow/preferences'
import { COLUMN_TEXT, REVIEW_WAIT_STALL_MS, TASK_COLUMNS, applyBoardFold, archiveBatchLabel, archiveBatchText, backgroundTaskMinutes, builderJobOf, cardMatches, newSinceStart, archivedAt, columnColor, columnName, laneOrderWaitReason, loopStepWait, loopStepWaitReason, notWatchingAgent, notWatchingReason, reviewStalled, reviewVerdictWaitReason, reviewWaitReason, reviewWaiter, stallAgentOf, stalledReason, startFailedReason, startWaitingReason, taskOverview, type BoardFoldChange, type LaneOrderView, type ReviewOwed } from '@shared/tasks'
import { agentWorkflowRole, reviewsWork } from '@shared/workflow/roles'
import { isProviderEnabled, providerMessage, providerName } from '@shared/providers'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, agentProviderOf, cardHasActivity, cardLabelOf, choose, confirm, findProject, get, loadTasks, notify, openCardActivity, prompt, revealAgent, set, setProjectTab, showView, useDateStyle, useLanguage, useStore, wantFullArchive, type ArchiveAllRequest, type DoingRequest } from '../store'
import { cardLabel } from '@shared/projectKeys'
import { cardNumberOf } from '../projectKeys'
import { MARKDOWN_CARDS } from '../cardLinks'
import { CardWork, WorkBadges } from './CardWork'
import { ForYouChip, ForYouSection } from './ForYou'
import { KindField, KindMark, KindProposal } from './CardKind'
import { ReviewSkipField, ReviewSkipMark, ReviewSkipProposal, useProjectReviews } from './CardReviewSkip'
import { askedByNow, useForYou } from '../forYou'
import { useTeamPause, workspacePaused } from '../teamPause'
import type { ForYouItem } from '@shared/workflow/workView'
import { useWorkBadges } from '../cardWork'
import type { WorkBadge } from '@shared/workflow/workView'
import { RULE_NAMES, workflowMessage } from '@shared/workflow/texts'
import { refusalLines, type Refusal, type RefusalFormat } from '@shared/workflow/refusals'
import { selectProject } from '../actions'
import { cx, timeAgo } from '../util'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { formatDateTime } from '@shared/dates'
import { returnRound } from '@shared/watch'
import { BusyButton, Icon, IconButton, InfoTip, Markdown, Modal, SearchInput, STATUS_TEXT, statusText, Tooltip, useBusy, useContextMenu, type MenuEntry } from './ui'
import { attachmentLookup, CardAttachmentList, DraftChips, openAttachmentLink, useAttachDrafts, useCardAttachments } from './CardAttachments'
import { attachmentImage, withAttachmentUrls } from '../cardAttachLinks'
import { DataTable, type DataColumn } from './DataTable'
import { DialogList } from './Overlays'
import { openLaneStart } from './LaneStartDialog'
import { EXPORT_BOARD, exportBoard, reportArchived, unarchiveBatch } from '../boardBatches'
import { readOnlyReason } from './BoardUpgrade'
import { SET_ASIDE_ITEM } from './SetAside'
import { useNow } from '../usage'
import { ProviderIcon } from './ProviderIcon'
import { cliReadyOf, ConnectionChoice, firstReadyConnection, offeredConnections, useConnections } from './ConnectionChoice'
import { CardCostLine } from './CardCost'
import { useLaneOf, useLanes } from '../laneSource'
import { DocRefViewer, problemLines } from './DocRefViewer'
import { boardLayout, cardColumn, cardStage, ownStageName, type BoardProject, type BoardStageColumn } from '../boardStages'
import { BoardWorkflowLink, useBoardProjects } from './BoardWorkflow'
import { useAdvancedValue } from '../advanced'
import type { StageId } from '@shared/workflow/facts'
import { parseDocRef, splitDocRefs } from '@shared/docRefs'
import { gist } from '@shared/gist'

const NO_TASKS: TaskCard[] = []
const NO_FOLD: BoardFold = {}
const NO_BOARD_PROJECTS: BoardProject[] = []

/** This workspace's board as the user left it (#170): its collapsed columns and folded cards. */
function useBoardFold(): BoardFold {
  return useStore((s) => (s.workspace ? s.boardFold[s.workspace.path.toLowerCase()] : undefined) ?? NO_FOLD)
}

/**
 * Changes this workspace's board fold (a view preference in Combwork's own settings, never in the cards' files): shown at
 * once, and saved by main as a change to what is saved now, so another window's folds (of its workspace) are never
 * written over with what this window read earlier. Folded cards no longer on the board, archived ones included, are
 * dropped (once the board has been read).
 */
function saveFold(what: BoardFoldChange): void {
  const ws = get().workspace?.path
  if (!ws) return
  const tasks = get().tasks
  const full = { ...what, ...(tasks.length ? { known: tasks.map((c) => c.number) } : {}) }
  set({ boardFold: applyBoardFold(get().boardFold, ws, full) })
  void call('ui:changeBoardFold', full)
    .then((saved) => set({ boardFold: saved }))
    .catch(() => undefined)
}

/** Reads every workspace's board fold as saved now (a window opening a workspace another window changed). */
function loadBoardFold(): void {
  void call('ui:get')
    .then((ui) => set({ boardFold: ui.boardFold ?? {} }))
    .catch(() => undefined)
}

const collapseColumn = (col: BoardColumnId, collapsed: boolean): void => saveFold({ columns: { ids: [col], collapsed } })

const foldCards = (numbers: number[], folded: boolean): void => saveFold({ cards: { numbers, folded } })

/** The project and agent a card is given to, as they are now (null when the card has none). */
function cardAgent(projects: ProjectInfo[], c: TaskCard): { project: ProjectInfo | null; agent: AgentInfo | null } {
  const project = c.project ? (projects.find((p) => p.name.toLowerCase() === c.project.toLowerCase()) ?? null) : null
  return { project, agent: c.agent ? (project?.agents.find((a) => a.id === c.agent) ?? null) : null }
}

/**
 * Why nobody is working on the card, from the agents as the window knows them: a Doing card's agent gone or stopped, an
 * agent looping on the card (Doing or Review) whose turn ended with no card watch (#376), or a card in Review an agent
 * watches but hasn't started reviewing for a while (#521), or one its reviewer started and only watches, with no verdict (#843),
 * or one its lane's deadlock holds up (#1410: `lane`, its running lane, useLaneOf), or a Doing card whose builder waits on
 * a check of its design nobody gives (#1382).
 */
export function cardStalled(projects: ProjectInfo[], c: TaskCard, lane?: LaneOrderView | null): string | null {
  return cardStall(projects, c, lane)?.text ?? null
}

/** What a stalled card's hover says to do, by why it is stalled. */
type StallKind = 'nobody' | 'not-watching' | 'wake-untaken' | 'review-silent' | 'review-wait' | 'review-verdict' | 'lane-order' | 'loop-step' | 'follow-up'

/** The agents as every card's stall reads them: those that may loop on a card, and those watching cards. */
function stallAgentsOf(projects: ProjectInfo[]) {
  const loopers = projects.flatMap((p) => p.agents.map((a) => ({ name: a.name, project: p.name, notWatching: a.live?.notWatching, untaken: !!a.live?.untakenLine })))
  const watchers = projects.flatMap((p) => p.agents.flatMap((a) => (a.live?.watch?.cards.length ? [{ name: a.name, project: p.name, agentId: a.id, cards: a.live.watch.cards, watchSince: a.live.watch.since, status: a.live.status, silentMinutes: agentRuntime(a.live).silentMinutes }] : [])))
  return { loopers, watchers }
}

/**
 * stallAgentsOf, worked out once for the projects as they are and reused for a second (HI-1806): the board and its
 * sidebar read every card's stall each time an agent changes state, and made these lists again for each card. A
 * watcher's silence is timed, so the lists are made again after the second.
 */
const stallAgents = new WeakMap<ProjectInfo[], { at: number; agents: ReturnType<typeof stallAgentsOf> }>()
function stallAgentsNow(projects: ProjectInfo[]): ReturnType<typeof stallAgentsOf> {
  const now = Date.now()
  const had = stallAgents.get(projects)
  if (had && now - had.at < 1000) return had.agents
  const agents = stallAgentsOf(projects)
  stallAgents.set(projects, { at: now, agents })
  return agents
}

/** Why the card is stalled (cardStalled), in the window's language, and which kind of stall it is. */
function cardStall(projects: ProjectInfo[], c: TaskCard, lane?: LaneOrderView | null): { text: string; kind: StallKind } | null {
  // The team paused (HI-2081): its agents parking is what was asked of them, never a stall; once it resumes, each timed
  // stall needs its own wait since then too, as main's check has it.
  if (workspacePaused(get().workspace?.path)) return null
  // Waiting on purpose (HI-2618), as main's check has it: never a stall while it is marked.
  if (c.waitingFor && c.column === 'doing') return null
  const resumed = useTeamPause.getState().resumedAt
  const waited = (ms: number): boolean => Date.now() - resumed >= ms
  const { agent } = cardAgent(projects, c)
  // Main's start state (HI-1977): an agent starting isn't stalled, one whose start failed says why.
  const now = agent ? stallAgentOf(agent) : null
  const nobody = startFailedReason(c, now, tr) ?? startWaitingReason(c, now, tr) ?? stalledReason(c, now, tr)
  if (nobody) return { text: nobody, kind: 'nobody' }
  const { loopers, watchers } = stallAgentsNow(projects)
  const looping = notWatchingReason(c, loopers, tr)
  if (looping) return { text: looping, kind: notWatchingAgent(c, loopers)?.untaken ? 'wake-untaken' : 'not-watching' }
  // Only the agent owing the review (HI-2636): its lane's reviewer, else a watcher that may review, never a builder only
  // watching it (the pool's choice is main's; its stall says it).
  const owed = lane?.reviewer ? reviewerOwed(projects, c, lane.reviewer) : undefined
  const reviews = (id: string): boolean => mayReview(projects, c, id)
  const waiting = waited(REVIEW_WAIT_STALL_MS) ? reviewWaitReason(c, watchers, Date.now(), tr, owed, reviews) : null
  if (!waiting) {
    if (!waited(REVIEW_WAIT_STALL_MS)) return null
    const verdict = reviewVerdictWaitReason(c, watchers, Date.now(), tr, reviewJob(c, agent))
    // HI-2080: a reviewer waiting on its own question to the user (For you) isn't stalled, as main's check has it.
    if (verdict && !(c.review && askedByNow(c.number, c.review.agent))) return { text: verdict, kind: 'review-verdict' }
    const order = laneOrderWaitReason(c, lane, watchers, Date.now(), tr)
    if (order) return { text: order, kind: 'lane-order' }
    // loopStepWait's own first tests, before the project's options are worked out for it (HI-1806: for every card).
    if (c.archived || c.blocked || !c.agent || (c.column !== 'doing' && c.column !== 'review' && c.column !== 'passed')) return null
    const project = cardAgent(projects, c).project
    // The project's Design check wait (its workflow option, HI-1766), over Combwork's and the workspace's.
    const st = get()
    const bound = (project ? projectInfoPreferences(project, st.settings?.workflow, st.workspace?.config.workflow).loopStepWaitMinutes : LOOP_STEP_WAIT_MINUTES) * 60_000
    const step = loopStepWaitReason(c, watchers, bound, Date.now(), tr)
    return step ? { text: step, kind: loopStepWait(c, watchers, bound)?.step === 'followUp' ? 'follow-up' : 'loop-step' } : null
  }
  // The watcher reviewWaitReason names: its state unknown (silent) or not.
  const w = reviewWaiter(c, watchers, owed, reviews)
  return { text: waiting, kind: w?.silentMinutes !== undefined ? 'review-silent' : 'review-wait' }
}

/** The card's project's agent, as the window knows it. */
const projectAgentOf = (projects: ProjectInfo[], c: Pick<TaskCard, 'project'>, id: string): AgentInfo | undefined => projects.find((p) => p.name.toLowerCase() === c.project.toLowerCase())?.agents.find((a) => a.id === id)

/** A lane's reviewer owing a card's review (HI-2636), or null when it isn't one of the project's agents now. */
function reviewerOwed(projects: ProjectInfo[], c: Pick<TaskCard, 'project'>, id: string): ReviewOwed | null {
  const a = projectAgentOf(projects, c, id)
  return a ? { agentId: a.id, name: a.name } : null
}

/** Whether an agent of the card's project may review (its workflow role, HI-2636). */
function mayReview(projects: ProjectInfo[], c: Pick<TaskCard, 'project'>, id: string): boolean {
  const a = projectAgentOf(projects, c, id)
  return !!a && reviewsWork(agentWorkflowRole(a))
}

/**
 * A started review's builder's job for the card (HI-1993: its Progress run for the card, or its background tasks), as
 * main's stall check reads it; null for a card it couldn't stall.
 */
function reviewJob(c: TaskCard, builder: AgentInfo | null | undefined): ReturnType<typeof builderJobOf> {
  if (c.column !== 'review' || !c.review || !c.agent) return null
  const st = get()
  return builderJobOf(c, st.progressRuns, builder?.live ?? null, backgroundTaskMinutes(st.settings?.agents.backgroundTaskMinutes) * 60_000)
}

/** A stalled card's hover: what to do about it. */
function stallHint(kind: StallKind): string {
  if (kind === 'wake-untaken') return tr(msg({ id: 'board.stall.hintWakeUntaken', defaultMessage: "Combwork typed this card's wake into that agent, but its CLI didn't send it. Show the agent, click its terminal and press Enter.", description: "Tooltip on a stalled card: Combwork typed the line that wakes the agent into its terminal, and the agent's CLI never sent it (it waits in the agent's prompt)." }))
  if (kind === 'not-watching') return tr(msg({ id: 'board.stall.hintNotWatching', defaultMessage: 'Nothing will wake that agent when this card changes. Show it and ask it to carry on its card loop.', description: "Tooltip on a stalled card: an agent in a card loop stopped without a card watch (what wakes it when the card changes)." }))
  if (kind === 'review-silent') return tr(msg({ id: 'board.stall.hintReviewSilent', defaultMessage: 'Its reviewer may have finished its turn without Combwork seeing it end. Show the reviewer: if its terminal waits at its prompt, Mark idle, and the watch wakes it.', description: 'Tooltip on a card stalled in Review whose reviewer Combwork has heard nothing from. "Mark idle" is a command in the agent\'s menu: keep its wording as that command is translated.' }))
  if (kind === 'review-verdict') return tr(msg({ id: 'board.stall.hintReviewVerdict', defaultMessage: 'Its reviewer stopped without a verdict and waits on the card. Read its latest comment (it may have a question for you), then show the reviewer and ask it to finish its review.', description: 'Tooltip on a card stalled in Review: its reviewer started reviewing, then went back to waiting on the card without passing or failing it.' }))
  if (kind === 'lane-order') return tr(msg({ id: 'board.stall.hintLaneOrder', defaultMessage: "Its builder and its lane's reviewer are each waiting for the other. Ask the builder to send the card its reviewer waits for, or ask the reviewer to review this one.", description: "Tooltip on a card stalled in Review by its card loop's deadlock: the builder sent this card to Review and waits for its verdict, while the loop's reviewer waits for another card of the loop to arrive." }))
  if (kind === 'loop-step') return tr(msg({ id: 'board.stall.hintLoopStep', defaultMessage: 'Its builder waits for its reviewer to check the design it posted. Ask the reviewer to answer it, or tell the builder to go ahead as posted.', description: 'Tooltip on a card stalled in Doing (#1382): in a card loop, the builder posted a design for its reviewer to check before building, and nobody answered.' }))
  if (kind === 'follow-up') return tr(msg({ id: 'board.stall.hintFollowUp', defaultMessage: 'Its builder waits for its reviewer to check the follow-up it posted. Show the reviewer and ask it to answer it.', description: 'Tooltip on a card stalled in Review or Passed (#1467): in a card loop, the builder posted a follow-up for its reviewer to check (a change asked of reviewed work, such as a screenshot\'s), and nobody answered.' }))
  if (kind === 'review-wait') return tr(msg({ id: 'board.stall.hintReviewWait', defaultMessage: "Its reviewer's watch didn't wake it. Show the reviewer and ask it to review the card.", description: 'Tooltip on a card stalled in Review: its reviewer watches it but has not started.' }))
  return tr(msg({ id: 'board.stall.hintNobody', defaultMessage: 'Nobody is working on it. Start it again (on this agent or another), or move it back to Todo.', description: 'Tooltip on a card stalled in Doing: no agent is working on it. Todo is a board column.' }))
}

const inProject = (c: TaskCard, project: string | null): boolean => project === null || c.project.toLowerCase() === project.toLowerCase()

/**
 * Who has a card now, so Archive All passes over it unless asked (#351): its agent working on it (in Doing, running), its
 * reviewer, or an agent (or the Assistant) watching it. Null when nobody is on it.
 */
function cardBusy(c: TaskCard, projects: ProjectInfo[], assistant: ProjectInfo | null): string | null {
  if (c.column === 'doing') {
    const { agent } = cardAgent(projects, c)
    if (agent?.live) return tr(BUSY.working, { agent: agent.name })
  }
  if (c.review) return tr(BUSY.reviewing, { agent: c.review.agentName })
  // HI-2153: a watch on a card in Done waits for nothing more (Combwork ends it): nobody is on it for that.
  if (c.column === 'done') return null
  for (const p of assistant ? [...projects, assistant] : projects) {
    const a = p.agents.find((x) => x.live?.watch?.cards.includes(c.number))
    if (a && p === assistant) return tr(BUSY.assistantWatching)
    if (a) return tr(BUSY.watching, { agent: a.name })
  }
  return null
}

/**
 * The cards Archive All would take (#351): those of the column (or board) shown, and how many there are in all. A stage
 * column's (Approved beside Merging, #1420) only its stage's, as `stageOf` places each card.
 */
function archiveScope(all: TaskCard[], r: Pick<ArchiveAllRequest, 'column' | 'stage' | 'project' | 'scope' | 'query'>, stageOf?: (c: TaskCard) => StageId): { shown: TaskCard[]; total: number } {
  const there = all.filter((c) => !c.archived && (r.column === null || c.column === r.column) && (!r.stage || stageOf?.(c) === r.stage) && inProject(c, r.scope))
  return { shown: there.filter((c) => inProject(c, r.project) && cardMatches(c, r.query, get().projectKeys, get().movedCardNames)), total: there.length }
}

/** The menu item that opens Archive All: a column's, or the board's (column null). Counted, and off with nothing shown. */
function archiveAllItem(all: TaskCard[], r: ArchiveAllRequest, readOnly: string | null, stageOf?: (c: TaskCard) => StageId): MenuEntry {
  const { shown, total } = archiveScope(all, r, stageOf)
  const where = r.column === null ? null : (r.name ?? columnName(r.column, tr))
  let label: string
  if (shown.length < total && where) label = tr(msg({ id: 'board.archiveAll.menuShownIn', defaultMessage: 'Archive the {n, number} Shown (of {total, number})…', description: "Menu item in a board column's ⋯ menu, when a search hides some of its cards: archive the {n} cards shown, of the column's {total}. Opens a dialog (…)." }), { n: shown.length, total })
  else if (shown.length < total) label = tr(msg({ id: 'board.archiveAll.menuShown', defaultMessage: '{n, plural, one {Archive the # Shown Card (of {total, number})…} other {Archive the # Shown Cards (of {total, number})…}}', description: "Menu item in the board's ⋯ menu, when a search hides some cards: archive the {n} cards shown, of the board's {total}. Opens a dialog (…)." }), { n: shown.length, total })
  else if (where) label = tr(msg({ id: 'board.archiveAll.menuColumn', defaultMessage: 'Archive All in {column} ({total, number})…', description: "Menu item in a board column's ⋯ menu: archive all {total} cards of the column ({column}, its name). Opens a dialog (…)." }), { column: where, total })
  else label = tr(msg({ id: 'board.archiveAll.menuAll', defaultMessage: 'Archive All Cards ({total, number})…', description: "Menu item in the board's ⋯ menu: archive all {total} cards. Opens a dialog (…)." }), { total })
  return { label, icon: 'archive', disabled: !shown.length || !!readOnly, ...(readOnly ? { detail: readOnly } : {}), onClick: () => set({ boardArchiveAll: r }) }
}

/** Changes a card; a failure is a toast titled `what` (default: Could not change the card). */
async function change(n: number, patch: TaskPatch, what?: string): Promise<boolean> {
  try {
    await call('tasks:update', n, patch)
    await loadTasks()
    return true
  } catch (e) {
    notify('error', what ?? tr(msg({ id: 'board.error.change', defaultMessage: 'Could not change the card', description: "An error toast's title: changing a card failed." })), errorMessage(e))
    return false
  }
}

/** A refusal's sentences in the window's language: names (stages, moves, rules) by their messages (#1264). */
const IN_WINDOW: RefusalFormat = { one: (m, values) => tr(m, values), list: (items) => fmt.list(items, 'unit'), names: true }

const MOVE = {
  askTitle: msg({ id: 'board.move.askTitle', defaultMessage: 'Move {card} to {column} anyway?', description: "Title of the question before a move that skips some of the card's workflow rules (glossary: rule). {card} is the card's name (its key, such as AM-12, or #12), {column} the board column it is moved to." }),
  askMessage: msg({ id: 'board.move.askMessage', defaultMessage: '{n, plural, one {This skips a rule of its project:} other {This skips # rules of its project:}}', description: "The question before a move that skips workflow rules (glossary: rule): how many it skips ({n}), listed below by name. Moving anyway records an exception on the card (glossary: override), with the reason the user gives." }),
  detail: msg({ id: 'board.move.askDetail', defaultMessage: 'Moving it anyway records an override on the card, with your reason.', description: "Under the rules a move would skip, in the question before it: making the move records it on the card as an exception to the rules (glossary: override), with the reason the user gives below." }),
  reason: msg({ id: 'board.move.reason', defaultMessage: 'Reason (optional)', description: "The label of the field in the question before a move that skips rules: why the user makes the exception, kept with it on the card. Optional." }),
  anyway: msg({ id: 'board.move.anyway', defaultMessage: 'Move Anyway', description: 'The button of the question before a move that skips rules: makes the move, recording it as an override (glossary: override).' }),
  refused: msg({ id: 'board.move.refused', defaultMessage: "{card} can't move to {column}", description: "A toast's title: a card's move was refused for something no exception to the rules can make true (nothing to submit, something Combwork couldn't read). {card} is the card's name, {column} a board column. The toast's text says why and what to do." }),
  notMoved: msg({ id: 'board.move.notMoved', defaultMessage: 'Your other changes are saved; the card stays in {column}.', description: "In the card dialog, after Save: the user changed the card's Column, but its move was cancelled or refused (a toast says why); everything else was saved. {column} is the board column it is in." }),
  stopped: msg({ id: 'board.move.stopped', defaultMessage: '{card} stopped in {column}', description: "A toast's title: a drag went part of the way (the card's work started) and stopped in {column} (a board column), for something no exception to the rules can make true. {card} is the card's name. The toast's text says why and what to do." })
}

/** The question before submitting a card of a project without version control whose paths leave files out (HI-2352). */
const LEFT_OUT = {
  title: msg({ id: 'board.leftOut.title', defaultMessage: "Include files {card}'s paths leave out?", description: "Title of the question before a card of a project without version control is submitted (moved to Review): files changed that its paths (the files its work is made of) don't list. {card} is the card's name (its key, such as AM-12, or #12)." }),
  message: msg({ id: 'board.leftOut.message', defaultMessage: "{n, plural, one {This file changed since {card} started, but isn't in its paths. Without version control, its work is only the files its paths list, so its review won't see this one:} other {These # files changed since {card} started, but aren't in its paths. Without version control, its work is only the files its paths list, so its review won't see them:}}", description: "The question before a card of a project without version control is submitted: {n} files changed since the card started that its paths (the files its work is made of) don't list; they are listed below. {card} is the card's name." }),
  detail: msg({ id: 'board.leftOut.detail', defaultMessage: "{hasPaths, select, yes {Its paths: {paths}.} other {It has no paths yet.}} A file changed meanwhile may be another card's work or your own: include only what belongs to {card}.", description: "Under the files listed in the question before submitting a card of a project without version control: its paths now ({paths}, a list of file paths; {hasPaths} is yes or no: keep both as they are), and a warning that a changed file may belong to another card or the user's own edit. {card} is the card's name." }),
  leave: msg({ id: 'board.leftOut.leave', defaultMessage: '{n, plural, one {Leave It Out} other {Leave Them Out}}', description: "A button of the question before submitting a card of a project without version control: submits it with its paths as they are, without the {n} changed files listed. Title case, as the dialog's other buttons." }),
  include: msg({ id: 'board.leftOut.include', defaultMessage: '{n, plural, one {Include It} other {Include Them}}', description: "A button of the question before submitting a card of a project without version control: adds the {n} changed files listed to its paths, and submits it with them. Title case, as the dialog's other buttons." })
}

/**
 * What a None card's submission leaves out of its paths (HI-2352), asked before its move: the paths to submit with
 * (Include Them: its paths and every file listed), null to submit as it is (Leave Them Out), or undefined on Cancel.
 */
async function askLeftOut(name: string, left: { paths: string[]; files: string[] }): Promise<string[] | null | undefined> {
  const n = left.files.length
  const choice = await choose({
    title: tr(LEFT_OUT.title, { card: name }),
    message: tr(LEFT_OUT.message, { n, card: name }),
    list: left.files,
    detail: tr(LEFT_OUT.detail, { hasPaths: left.paths.length ? 'yes' : 'no', paths: fmt.list(left.paths, 'unit'), card: name }),
    choices: [
      { label: tr(LEFT_OUT.leave, { n }), value: 'leave' },
      { label: tr(LEFT_OUT.include, { n }), value: 'include' }
    ]
  })
  return choice === 'include' ? [...left.paths, ...left.files.filter((f) => !left.paths.includes(f))] : choice === 'leave' ? null : undefined
}

/** A refusal's three sentences, one per line, in the window's language, the card named as the window names it (`name`). */
const refusalText = (r: Refusal, name: string): string => {
  const l = refusalLines(r.rule, { ...r.values, ...(r.values.card !== undefined ? { card: name } : {}) }, { ...IN_WINDOW, forUser: true })
  return [l.message, l.next, ...(l.change ? [l.change] : [])].join('\n')
}

/**
 * The question before a move (or a Start) that skips rules (#1275): the rules by name, a reason, Move Anyway. The reason
 * given (maybe empty), or null when the user cancels.
 */
function askToSkip(name: string, column: TaskColumn, rules: readonly string[]): Promise<string | null> {
  return prompt({
    title: tr(MOVE.askTitle, { card: name, column: tr(COLUMN_TEXT[column].label) }),
    message: tr(MOVE.askMessage, { n: rules.length }),
    list: rules.map((id) => (RULE_NAMES[id] ? tr(RULE_NAMES[id]) : id)),
    listOnly: true,
    detail: tr(MOVE.detail),
    fieldLabel: tr(MOVE.reason),
    confirmLabel: tr(MOVE.anyway)
  })
}

/**
 * Moves a card to a column through its rules (`tasks:move`, #1275, SPEC §16.8.4): a move that skips some asks first
 * (the rules it skips, a reason, Move Anyway), then records one override; a step no override can make true shows why,
 * and the card stays where the move stopped. `agent`: the Move to Doing dialog's choice. Whether it reached the column;
 * the board is read again either way (an optimistic move undone on Cancel or a refusal).
 */
export async function moveCard(c: Pick<TaskCard, 'number' | 'project'>, column: TaskColumn, o: { before?: number | null; agent?: string | null; rethrow?: boolean } = {}): Promise<boolean> {
  const name = cardLabelOf(get(), c.number)
  const where = tr(COLUMN_TEXT[column].label)
  const { rethrow, ...first } = o
  let move: typeof first & { paths?: string[] | null } = first
  try {
    let r = await call('tasks:move', c.number, column, move)
    // Without version control, what its paths leave out is asked first (HI-2352); the choice goes with every later call.
    if ('leftOut' in r) {
      const paths = await askLeftOut(name, r.leftOut)
      if (paths === undefined) return false
      move = { ...move, paths }
      r = await call('tasks:move', c.number, column, move)
    }
    if ('ask' in r) {
      const reason = await askToSkip(name, column, r.ask)
      if (reason === null) return false
      r = await call('tasks:move', c.number, column, { ...move, confirm: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })
    }
    if ('refused' in r) {
      notify('error', tr(MOVE.refused, { card: name, column: where }), refusalText(r.refused, name))
      return false
    }
    if ('ask' in r || 'leftOut' in r) return false
    if (r.stopped) {
      notify('warning', tr(MOVE.stopped, { card: name, column: tr(COLUMN_TEXT[r.moved.column].label) }), refusalText(r.stopped, name))
      return false
    }
    return true
  } catch (e) {
    // A dialog that offers Try Again (Move to Doing, the card dialog's Save) shows the failure itself.
    if (rethrow) throw e
    notify('error', tr(MOVE_FAILED), errorMessage(e))
    return false
  } finally {
    await loadTasks()
  }
}

// Cards being archived from the menu: a second click while one runs is ignored.
const archiving = new Set<number>()

/** Archives a card or brings it back; `reload` false leaves the board's read to its caller (a bulk change reads it once, HI-1864). */
async function archive(c: TaskCard, archived: boolean, reload = true): Promise<void> {
  if (archiving.has(c.number)) return
  archiving.add(c.number)
  try {
    await call('tasks:archive', c.number, archived)
    if (reload) await loadTasks()
  } catch (e) {
    notify('error', archived ? tr(msg({ id: 'board.error.archive', defaultMessage: 'Could not archive the card', description: "An error toast's title: archiving a card failed." })) : tr(msg({ id: 'board.error.unarchive', defaultMessage: 'Could not bring the card back', description: "An error toast's title: bringing an archived card back to the board failed." })), errorMessage(e))
  } finally {
    archiving.delete(c.number)
  }
}

/** Deletes a card after asking; the question stays open, with a spinner, until it's done. */
function remove(c: TaskCard): Promise<boolean> {
  return confirm({
    title: tr(msg({ id: 'board.delete.title', defaultMessage: 'Delete {card}?', description: "Title of the confirmation before a card is deleted. {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: cardLabel(c) }),
    message: tr(msg({ id: 'board.delete.message', defaultMessage: '"{title}" goes to the Recycle Bin, with its comments and history. Archive it instead to keep it out of sight but searchable.', description: "The confirmation before a card is deleted. {title} is the card's title. Recycle Bin is Windows' name for it." }), { title: c.title }),
    confirmLabel: tr(msg({ id: 'board.delete.button', defaultMessage: 'Delete', description: 'Button: deletes the card (to the Recycle Bin).' })),
    busyLabel: tr(msg({ id: 'board.delete.busy', defaultMessage: 'Deleting…', description: 'The Delete button while the card is being deleted.' })),
    danger: true,
    run: async () => {
      await call('tasks:delete', c.number)
      await loadTasks()
    }
  })
}

/** The right-click menu of a card; on a read-only board (readOnly: why) only Open can be chosen. */
function cardMenu(c: TaskCard, readOnly: string | null): MenuEntry[] {
  return [
    { label: tr(msg({ id: 'board.menu.open', defaultMessage: 'Open', description: "Menu item on a card (right-click): opens the card's dialog." })), icon: 'go-to-file', onClick: () => set({ taskOpen: c.number }) },
    ...(c.archived
      ? []
      : [
          { label: tr(msg({ id: 'board.menu.start', defaultMessage: 'Start…', description: 'Menu item on a card (right-click): gives it to an agent to start (opens a dialog).' })), icon: 'play', disabled: !c.project || !!readOnly, ...(readOnly ? { detail: readOnly } : {}), onClick: () => set({ taskStartFor: c.number }) },
          ...(c.column === 'todo' && c.project ? [{ label: tr(msg({ id: 'board.menu.startLane', defaultMessage: 'Start Lane with It…', description: "Menu item on a Todo card (right-click): opens Start Lane with this card first in the lane's list (a lane: a builder and a reviewer working through cards in turn). Glossary: lane." })), icon: 'list-ordered', disabled: !!readOnly, onClick: () => openLaneStart(c.project, [c.number]) }] : []),
          // What runs on it now (HI-1743), for a card in progress.
          ...(cardHasActivity(c) ? [{ label: tr(ACTIVITY), icon: 'type-hierarchy', onClick: () => void openCardActivity(c) }] : []),
          // Waiting on purpose (HI-2618): marked with why in the card dialog's Waiting box, or cleared at once.
          ...(c.column === 'doing'
            ? [
                c.waitingFor
                  ? { label: tr(msg({ id: 'board.menu.clearWaiting', defaultMessage: 'Clear Waiting', description: "Menu item on a card in Active that waits on purpose (right-click, HI-2618): clears that mark, so Combwork reports it as stalled again if nobody gets on with it." })), icon: 'watch', disabled: !!readOnly, onClick: () => void change(c.number, { waitingFor: null }) }
                  : { label: tr(msg({ id: 'board.menu.markWaiting', defaultMessage: 'Mark as Waiting…', description: "Menu item on a card in Active (right-click, HI-2618): opens the card's dialog to say why it waits on purpose (held for a quiet window, say), so Combwork doesn't report it as stalled meanwhile." })), icon: 'watch', disabled: !!readOnly, onClick: () => set({ taskOpen: c.number }) }
              ]
            : []),
          { separator: true },
          { header: true, label: tr(msg({ id: 'board.menu.moveTo', defaultMessage: 'Move to', description: "A heading in a card's right-click menu, above the board columns it can move to." })) },
          ...TASK_COLUMNS.filter((x) => x.id !== c.column).map((x) => ({ label: tr(COLUMN_TEXT[x.id].label), icon: 'arrow-right', disabled: !!readOnly, onClick: () => (x.id === 'doing' ? moveToDoing({ n: c.number, project: c.project, agent: c.agent }) : void moveCard(c, x.id)) })),
          // A failed card still in Review goes back to its reviewer for the next round (#214).
          ...(returnRound(c) ? [{ label: tr(msg({ id: 'board.menu.nextRound', defaultMessage: 'Review (next round)', description: "Menu item on a card that failed review and is still in Review: returns it to its reviewer for the next round. Review is the board column." })), icon: 'refresh', disabled: !!readOnly, onClick: () => void moveCard(c, 'review') }] : []),
          { separator: true }
        ]),
    { label: c.archived ? tr(BRING_BACK) : tr(ARCHIVE), icon: c.archived ? 'discard' : 'archive', disabled: !!readOnly, onClick: () => void archive(c, !c.archived) },
    { label: tr(msg({ id: 'board.menu.delete', defaultMessage: 'Delete…', description: 'Menu item on a card (right-click): deletes it after asking.' })), icon: 'trash', danger: true, disabled: !!readOnly, onClick: () => void remove(c) }
  ]
}

/** A card in progress's Activity (HI-1743): the card dialog's button and its right-click menu's item. */
const ACTIVITY = msg({ id: 'board.dialog.activity', defaultMessage: 'Activity', description: "A button in the card dialog and an item of a card's right-click menu, for a card in Doing or Review: opens its project's Activity tab on the agent working on it, showing what runs on it now." })
const ACTIVITY_TIP = msg({ id: 'board.dialog.activityTip', defaultMessage: 'See what runs on this card now: the turn, tool calls, background tasks, subagents and processes of the agent working on it.', description: "Tooltip of the card dialog's Activity button, and the detail of the card menu's Activity item." })

/** A card's agent when its name isn't known. */
const ITS_AGENT = msg({ id: 'board.agent.unnamed', defaultMessage: 'its agent', description: "Stands for a card's agent when its name isn't known (it was removed), in place of a name in other messages. Lower case." })
/** A card's agent removed from its project. */
const REMOVED_AGENT = msg({ id: 'board.agent.removed', defaultMessage: '{agent} (removed)', description: "A card's agent that was removed from its project, on the card. {agent} is its name." })
/** The archived cards' view with none. */
const NO_ARCHIVED = msg({ id: 'board.archived.none', defaultMessage: 'No archived cards.', description: "The archived cards' view (and its table) when there are none." })
/** A new card: the board toolbar's button and the card dialog's title. */
const NEW_CARD = msg({ id: 'board.newCard.button', defaultMessage: 'New Card', description: "The board toolbar's button that adds a card, and the title of the dialog it opens." })
/** Cards in Review, counted (the Overview's strip, the Board sidebar's section). */
const WAITING_FOR_REVIEW = msg({ id: 'board.overview.waitingForReview', defaultMessage: 'Waiting for review', description: "Cards in the Review column, counted: on the Overview's board strip (after the number) and as a heading in the Board sidebar." })
/** Stalled cards, counted (the Overview's strip, the Board sidebar's section). */
const STALLED = msg({ id: 'board.overview.stalled', defaultMessage: 'Stalled', description: "Cards nobody is getting on with, counted: on the Overview's board strip (after the number) and as a heading in the Board sidebar." })
/** Dialog buttons. */
/** Start lane… (#1280): the board's ⋯ menu item. */
const START_LANE = msg({ id: 'board.toolbar.startLane', defaultMessage: 'Start Lane…', description: "An item of the board's ⋯ menu: opens Start Lane (a builder and a reviewer agent work through cards in turn). Glossary: lane." })
const CANCEL = msg({ id: 'board.dialog.cancel', defaultMessage: 'Cancel', description: "Button: closes a board dialog without doing anything." })
const TRY_AGAIN = msg({ id: 'board.dialog.tryAgain', defaultMessage: 'Try Again', description: "A board dialog's main button after it failed: does it again." })
const ARCHIVING = msg({ id: 'board.dialog.archiving', defaultMessage: 'Archiving…', description: 'A button while cards are being archived.' })
const SAVING = msg({ id: 'board.dialog.saving', defaultMessage: 'Saving…', description: 'A button while the card (or a decision) is being saved.' })
const STARTING = msg({ id: 'board.dialog.starting', defaultMessage: 'Starting…', description: 'A button while a card is being started on an agent.' })
const CREATING_WORKTREE = msg({ id: 'board.dialog.creatingWorktree', defaultMessage: 'Creating the worktree…', description: "A button while a card is being started on a new agent in its own git worktree (making the worktree takes a moment)." })
const SAVE = msg({ id: 'board.dialog.save', defaultMessage: 'Save', description: 'Button: saves the card (or a changed decision).' })
const ADDING = msg({ id: 'board.dialog.adding', defaultMessage: 'Adding…', description: 'A button while a new card or decision is being added.' })
/** The board's name: the Board view's title and its sidebar's. */
const TASK_BOARD = msg({ id: 'board.view.title', defaultMessage: 'Task Board', description: "The board's name: the title of the Task Board view and of its sidebar." })
const BRING_BACK = msg({ id: 'board.card.bringBack', defaultMessage: 'Bring Back', description: "Menu item (a card's right-click menu) and button (its dialog) on an archived card: brings it back to the board." })
const ARCHIVE = msg({ id: 'board.card.archive', defaultMessage: 'Archive', description: "Menu item (a card's right-click menu) and button (its dialog): archives the card (off the board, still searchable)." })
/** Start with no project. */
const NEEDS_PROJECT = msg({ id: 'board.dialog.needsProject', defaultMessage: 'Give it a project first: its agent works there.', description: "Why a card with no project can't be started (a tooltip, and the Start dialog)." })
/** The card dialog's Blocked field (its label and the box's name). */
const BLOCKED_FIELD = msg({ id: 'board.dialog.blocked', defaultMessage: 'Blocked', description: "A field label in the card dialog: why the card can't go on (empty: it isn't blocked)." })
/** The card dialog's Waiting field (HI-2618): its label and the box's name. */
const WAITING_FIELD = msg({ id: 'board.dialog.waiting', defaultMessage: 'Waiting', description: "A field label in the card dialog, for a card in Active (HI-2618): why it waits on purpose (empty: it isn't). Not the same as Blocked." })
/** No agent has the card. */
const NOBODY_YET = msg({ id: 'board.dialog.nobodyYet', defaultMessage: 'Nobody yet', description: "No agent has the card: the card dialog's agent choice, and a choice of the Move to Doing dialog." })
/** Start the card (the Start and Move to Doing dialogs' button). */
const START = msg({ id: 'board.dialog.startButton', defaultMessage: 'Start', description: 'Button of the Start dialog (and of Move to Doing with Assign and start): starts the card on the chosen agent.' })
/** Save with no title. */
const NEEDS_TITLE = msg({ id: 'board.dialog.needsTitle', defaultMessage: 'A card needs a title.', description: 'An error in the card dialog: Save with an empty title.' })
/** The card dialog's fields by key, as a warning names them when someone else changed them too. */
const FIELD_NAMES: Record<string, Msg> = {
  title: msg({ id: 'board.field.title', defaultMessage: 'title', description: "A card's field, named in a list (\"Your title, labels replaced the change made meanwhile\"). Lower case." }),
  description: msg({ id: 'board.field.description', defaultMessage: 'description', description: "A card's field, named in a list (\"Your title, description replaced the change made meanwhile\"). Lower case." }),
  project: msg({ id: 'board.field.project', defaultMessage: 'project', description: "A card's field, named in a list (\"Your project replaced the change made meanwhile\"). Lower case." }),
  agent: msg({ id: 'board.field.agent', defaultMessage: 'agent', description: "A card's field, named in a list (\"Your agent replaced the change made meanwhile\"). Lower case." }),
  column: msg({ id: 'board.field.column', defaultMessage: 'column', description: "A card's field, named in a list (\"Your column replaced the change made meanwhile\"): the board column it is in. Lower case." }),
  labels: msg({ id: 'board.field.labels', defaultMessage: 'labels', description: "A card's field, named in a list (\"Your labels replaced the change made meanwhile\"). Lower case." }),
  blocked: msg({ id: 'board.field.blocked', defaultMessage: 'blocked', description: "A card's field, named in a list (\"Your blocked replaced the change made meanwhile\"): why it can't go on. Lower case." }),
  blockedBy: msg({ id: 'board.field.blockedBy', defaultMessage: 'dependencies', description: "A card's field, named in a list (\"Your dependencies replaced the change made meanwhile\"): the cards it depends on (the dialog's Depends on). Lower case." }),
  context: msg({ id: 'board.field.context', defaultMessage: 'doc sections to read first', description: "A card's field, named in a list (\"Your doc sections to read first replaced the change made meanwhile\"): its Read first references. Lower case." }),
  links: msg({ id: 'board.field.links', defaultMessage: 'links', description: "A card's field, named in a list (\"Your links replaced the change made meanwhile\"): its related cards. Lower case." })
}
/** The New card buttons' tooltip. */
const NEW_CARD_TIP = msg({ id: 'board.newCard.tip', defaultMessage: 'New card', description: 'Tooltip on the + buttons that add a card (the Todo column, the Board sidebar).' })
/** A card's move failed. */
/** What closing the card dialog would lose: an answer to a For you request, written and not sent (#1276). */
const UNSENT_ANSWER = msg({ id: 'board.discard.answer', defaultMessage: 'the answer you are writing', description: 'What closing the card dialog would lose, in "Closing loses {what}.": an answer to a request for the user (For you) not sent yet. Lower case.' })
const MOVE_FAILED = msg({ id: 'board.error.move', defaultMessage: 'Could not move the card', description: "An error toast's title: moving a card to another column failed." })
/** Where a card with no project belongs (on the card, and the archived cards' Project column). */
const WORKSPACE_CARD = msg({ id: 'board.card.workspace', defaultMessage: 'workspace', description: "Where a card that belongs to no project is (it is about the whole workspace): shown in place of a project's name on the card. Lower case." })
/** An agent whose session isn't running. */
const NOT_RUNNING = msg({ id: 'board.agent.notRunning', defaultMessage: 'Not running', description: "A card's agent's state, on the card: its session isn't running." })

/** What the card's agent is doing (Doing cards), or who has it. */
function AgentLine({ c, agent, projectPath, live }: { c: TaskCard; agent: AgentInfo | null; projectPath: string | null; live: boolean }) {
  if (!c.agent) return null
  const name = agent?.name ?? c.agentName ?? tr(ITS_AGENT)
  if (!agent) return <span className="task-agent faint">{tr(REMOVED_AGENT, { agent: name })}</span>
  const status = agent.live?.status ?? 'stopped'
  // Its hooks not arriving (#1336): the line says so, and so does its tooltip, where a status cut short is read whole (#1634).
  const hooksMissing = live && agent.live ? hooksMissingText(agent.live, tr) : null
  const text = hooksMissing ?? (agent.live ? statusText(agent.live) : tr(NOT_RUNNING))
  return (
    <Tooltip content={tr(msg({ id: 'board.agent.tip', defaultMessage: '{agent}: {status}. Click to show it.', description: "Tooltip on a card's agent line: the agent's name and what it is doing ({status}: \"Working…\", \"Not running\")." }), { agent: name, status: text })}>
      <span
        className={cx('task-agent', live && 'live')}
        onClick={(e) => {
          e.stopPropagation()
          const project = projectPath ? findProject(get(), projectPath) : null
          if (!project) return
          selectProject(project.path)
          revealAgent(project, agent.id)
        }}
      >
        {live && <span className={cx('dot', agent.live ? status : 'stopped')} />}
        <span className="task-agent-name">{name}</span>
        {/* Its hooks not arriving (#1336): its status word would be a guess. */}
        {live && <span className="faint">{agent.live ? (hooksMissing ?? STATUS_TEXT[status]) : tr(NOT_RUNNING)}</span>}
      </span>
    </Tooltip>
  )
}

/** Who is reviewing the card now (TaskCard.review): click to show it; in amber when it has gone or isn't running. */
function ReviewLine({ c, reviewer, projectPath }: { c: TaskCard; reviewer: AgentInfo | null; projectPath: string | null }) {
  if (!c.review) return null
  const name = reviewer?.name ?? c.review.agentName
  const stalled = reviewStalled(c, reviewer ? { name: reviewer.name, running: !!reviewer.live } : null, tr)
  const values = { agent: name, ago: timeAgo(c.review.since) }
  const tip = !stalled
    ? tr(msg({ id: 'board.review.tip', defaultMessage: '{agent} is reviewing it (since {ago}). Click to show it.', description: "Tooltip on a card's reviewer line: who is reviewing it, since when ({ago}: \"5 min ago\")." }), values)
    : reviewer
      ? tr(msg({ id: 'board.review.tipNotRunning', defaultMessage: "{agent} started reviewing it {ago}, and isn't running.", description: "Tooltip on a card's reviewer line, in amber: the reviewer ({agent}) started {ago} (\"5 min ago\") but its session isn't running now." }), values)
      : tr(msg({ id: 'board.review.tipRemoved', defaultMessage: '{agent} started reviewing it {ago}, and was removed.', description: "Tooltip on a card's reviewer line, in amber: the reviewer ({agent}) started {ago} (\"5 min ago\") and was removed from the project since." }), values)
  return (
    <Tooltip content={tip}>
      <div
        className={cx('task-review', stalled && 'stalled')}
        onClick={(e) => {
          const project = projectPath ? findProject(get(), projectPath) : null
          if (!project || !reviewer) return
          e.stopPropagation()
          selectProject(project.path)
          revealAgent(project, reviewer.id)
        }}
      >
        <Icon name="eye" />
        <span className="task-note-text">
          {!stalled
            ? tr(msg({ id: 'board.review.line', defaultMessage: 'Reviewing: {agent} · {ago}', description: "A card's reviewer line on the board: who is reviewing it and since when ({ago}: \"5 min ago\")." }), values)
            : reviewer
              ? tr(msg({ id: 'board.review.lineNotRunning', defaultMessage: 'Reviewing: {agent} (not running)', description: "A card's reviewer line on the board, in amber: its reviewer's session isn't running." }), values)
              : tr(msg({ id: 'board.review.lineRemoved', defaultMessage: 'Reviewing: {agent} (removed)', description: "A card's reviewer line on the board, in amber: its reviewer was removed from the project." }), values)}
        </span>
      </div>
    </Tooltip>
  )
}

/**
 * A column's fold (#276): « on its header collapses it sideways into a strip, » on the strip expands it; the horizontal
 * convention (VS Code's panels), so it doesn't look like a card's ▾ / ▸, which folds a card to one line. Two codicon
 * chevrons drawn over each other (codicons have no double one).
 */
function Chevrons({ dir }: { dir: 'left' | 'right' }) {
  return (
    <span className="board-chevrons" aria-hidden>
      <Icon name={`chevron-${dir}`} />
      <Icon name={`chevron-${dir}`} />
    </span>
  )
}

/** A folded card's agent: a dot in its status's colour (Doing cards) or a plain one, with who and what in its tooltip. */
function FoldedAgent({ c, agent }: { c: TaskCard; agent: AgentInfo | null }) {
  if (!c.agent) return null
  const name = agent?.name ?? c.agentName ?? tr(ITS_AGENT)
  const live = c.column === 'doing'
  const text = !agent ? tr(REMOVED_AGENT, { agent: name }) : tr(msg({ id: 'board.agent.folded', defaultMessage: '{agent}: {status}', description: "Tooltip on a folded card's agent dot: the agent's name and what it is doing ({status}: \"Working…\", \"Not running\")." }), { agent: name, status: agent.live ? statusText(agent.live) : tr(NOT_RUNNING) })
  return (
    <Tooltip content={text}>
      <span className="task-folded-agent" aria-label={text}>
        <span className={cx('dot', live ? (agent?.live?.status ?? 'stopped') : 'stopped')} />
      </span>
    </Tooltip>
  )
}

/**
 * What a card shows of the agents (HI-1806): worked out by the board, so a tile renders again only when its own agent,
 * reviewer or stall changes, not each time any agent in the workspace changes state.
 */
type TileAgents = { agent: AgentInfo | null; reviewer: AgentInfo | null; projectPath: string | null; stall: string | null; stallKind: StallKind | null }

function tileAgents(projects: ProjectInfo[], c: TaskCard, lane: LaneOrderView | null | undefined): TileAgents {
  const { project, agent } = cardAgent(projects, c)
  const stall = cardStall(projects, c, lane)
  const reviewer = c.review ? (project?.agents.find((a) => a.id === c.review!.agent) ?? null) : null
  return { agent, reviewer, projectPath: project?.path ?? null, stall: stall?.text ?? null, stallKind: stall?.kind ?? null }
}

/** A card on the board, drawn again only when what it shows changes (HI-1806: each tile is many tooltips and messages). */
const CardTile = memo(function CardTile({
  c,
  agent,
  reviewer,
  projectPath,
  stall: stalled,
  stallKind,
  column,
  showProject,
  folded,
  onDragStart,
  dropHere,
  readOnly,
  work,
  forYou,
  stageNote = null
}: TileAgents & {
  c: TaskCard
  /** The board column it is shown in, for its drag. */
  column: BoardColumnId
  showProject: boolean
  /** Its own project's name for its stage, where the column shows another (several projects naming it differently). */
  stageNote?: string | null
  /** Folded to one line (#170): its number, title, agent and any stalled or blocked marker. */
  folded: boolean
  /** The same function on every render: one made afresh would draw every tile again. */
  onDragStart: (e: React.DragEvent, c: TaskCard, column: BoardColumnId) => void
  dropHere: boolean
  /** Why the board takes no changes (it can't be dragged then), or null. */
  readOnly: string | null
  /** What its work's facts say, for its badges (#1224). */
  work?: WorkBadge
  /** What on it waits for the user (#1276): its chip. */
  forYou?: ForYouItem[]
}) {
  const menu = useContextMenu()
  // Memo, it isn't drawn again with the board (HI-1806): it follows a change of language and of date format itself.
  useLanguage()
  useDateStyle()
  // A Doing card whose agent has finished is waiting for someone to look: it shows like a finished agent.
  const finished = c.column === 'doing' && agent?.live?.status === 'finished'
  // Read again each minute: its reviewer line's "5 min ago" (the board works out its stall each minute too, #521).
  useNow(60_000)
  const fold = (
    <IconButton
      icon={folded ? 'chevron-right' : 'chevron-down'}
      title={folded ? tr(msg({ id: 'board.card.expand', defaultMessage: 'Expand {card}', description: 'Tooltip on the chevron of a card folded to one line: shows it in full. {card} is its name: its key, such as AM-12, or #12 for a card with none.' }), { card: cardLabel(c) }) : tr(msg({ id: 'board.card.collapse', defaultMessage: 'Collapse {card} to one line', description: 'Tooltip on the chevron of a card: folds it to one line. {card} is its name: its key, such as AM-12, or #12 for a card with none.' }), { card: cardLabel(c) })}
      className="task-fold"
      expanded={!folded}
      onClick={() => foldCards([c.number], !folded)}
    />
  )
  const blockedTip = c.blocked ? tr(msg({ id: 'board.card.blockedTip', defaultMessage: 'Blocked: {reason}', description: "Tooltip on a blocked card: why it can't go on ({reason}, in the user's or an agent's own words)." }), { reason: c.blocked }) : ''
  const blockedLabel = tr(msg({ id: 'board.card.blocked', defaultMessage: 'Blocked', description: "Accessible name of a folded card's blocked mark (a card that can't go on)." }))
  const waitingTip = c.waitingFor ? tr(msg({ id: 'board.card.waitingTip', defaultMessage: 'Waiting: {reason} (marked by {by}). Combwork doesn’t report it as stalled meanwhile.', description: "Tooltip on a card in Active that waits on purpose (HI-2618): why ({reason}, in the user's or an agent's own words) and who marked it ({by}: the user (\"You\"), the Assistant or an agent's name)." }), { reason: c.waitingFor.reason, by: c.waitingFor.by }) : ''
  const stalledText = stalled ? tr(msg({ id: 'board.card.stalled', defaultMessage: 'Stalled: {why}', description: 'On a stalled card (and its tooltip when folded): nobody is getting on with it, and why ({why}, a sentence).' }), { why: stalled }) : ''
  const props = {
    className: cx('task-card', folded && 'folded', c.blocked && 'blocked', finished && 'finished', stalled && !c.blocked && 'stalled'),
    draggable: !c.archived && !readOnly,
    // Why it doesn't drag (#1230 round 2).
    title: readOnly ?? undefined,
    onDragStart: (e: React.DragEvent) => onDragStart(e, c, column),
    onClick: () => set({ taskOpen: c.number }),
    onContextMenu: (e: React.MouseEvent) => menu.open(e, cardMenu(c, readOnly)),
    'data-task': c.number
  }
  if (folded) {
    return (
      <>
        {dropHere && <div className="task-drop" />}
        <div {...props}>
          <div className="task-card-line">
            {fold}
            <span className="task-number">{cardLabel(c)}</span>
            <Tooltip content={c.title}>
              <span className="task-title">{c.title}</span>
            </Tooltip>
            {c.blocked && (
              <Tooltip content={blockedTip}>
                <span className="task-flag blocked" aria-label={blockedLabel}>
                  <Icon name="circle-slash" />
                </span>
              </Tooltip>
            )}
            {c.waitingFor && c.column === 'doing' && (
              <Tooltip content={waitingTip}>
                <span className="task-flag waiting" aria-label={tr(msg({ id: 'board.card.waitingMark', defaultMessage: 'Waiting', description: "Accessible name of a folded card's waiting mark (HI-2618: it waits on purpose)." }))}>
                  <Icon name="watch" />
                </span>
              </Tooltip>
            )}
            {stalled && (
              <Tooltip content={stalledText}>
                <span className="task-flag stalled" aria-label={tr(msg({ id: 'board.card.stalledMark', defaultMessage: 'Stalled', description: "Accessible name of a folded card's stalled mark (nobody is getting on with it)." }))}>
                  <Icon name="debug-pause" />
                </span>
              </Tooltip>
            )}
            <ForYouChip items={forYou} />
            <FoldedAgent c={c} agent={agent} />
          </div>
        </div>
        {menu.element}
      </>
    )
  }
  return (
    <>
      {dropHere && <div className="task-drop" />}
      <div {...props}>
        <div className="task-card-top">
          {fold}
          <span className="task-number">{cardLabel(c)}</span>
          {showProject && c.project && (stageNote ? (
            <Tooltip content={tr(msg({ id: 'board.card.stageInProject', defaultMessage: 'In {project}, this stage is {stage}', description: "Tooltip on a card's project name on the board when its project names the card's stage differently from the column's heading (glossary 2.2: stage). {project} is the project, {stage} its own name for the stage." }), { project: c.project, stage: stageNote })}>
              <span className="task-project" data-stage-note={stageNote}>{c.project}</span>
            </Tooltip>
          ) : (
            // Cut with "…" in a narrow column: whole on hover (#1634).
            <Tooltip content={c.project}>
              <span className="task-project">{c.project}</span>
            </Tooltip>
          ))}
          {!c.project && <span className="task-project faint">{tr(WORKSPACE_CARD)}</span>}
        </div>
        <div className="task-title">{c.title}</div>
        {/* Long reasons (hashes, paths) wrap anywhere, at most three lines on the card; the whole on hover (#372). */}
        {c.blocked && (
          <Tooltip block content={blockedTip}>
            <div className="task-blocked">
              <Icon name="circle-slash" />
              <span className="task-note-text">{c.blocked}</span>
            </div>
          </Tooltip>
        )}
        {/* Waiting on purpose (HI-2618): quiet, not red; why on hover too. */}
        {c.waitingFor && c.column === 'doing' && (
          <Tooltip block content={waitingTip}>
            <div className="task-waiting">
              <Icon name="watch" />
              <span className="task-note-text">{c.waitingFor.reason}</span>
            </div>
          </Tooltip>
        )}
        {/* Read first references that didn't resolve when last checked (#819): named, why on hover. */}
        {!!c.contextProblems?.length && (
          <Tooltip block content={problemLines(c.contextProblems).join('\n')}>
            <div className="task-stalled task-context-broken">
              <Icon name="warning" />
              <span className="task-note-text">
                {tr(msg({ id: 'board.card.contextBroken', defaultMessage: '{n, plural, one {Read first no longer resolves: {refs}} other {# Read first references no longer resolve: {refs}}}', description: "A warning on a card (#819): its Read first references (doc sections) that didn't resolve when last checked: how many ({n}) and which ({refs}: references such as \"docs/PLAN.md#setup\", separated by commas; keep them as they are). The tooltip says why." }), { n: c.contextProblems.length, refs: c.contextProblems.map((p) => p.ref).join(', ') })}
              </span>
            </div>
          </Tooltip>
        )}
        {stalled && stallKind && (
          <Tooltip block content={stallHint(stallKind)}>
            <div className="task-stalled">
              <Icon name="debug-pause" />
              <span className="task-note-text">{stalledText}</span>
            </div>
          </Tooltip>
        )}
        <ReviewLine c={c} reviewer={reviewer} projectPath={projectPath} />
        {(!!forYou?.length || work?.kind === 'no-code' || work?.kindProposed === 'no-code' || !!work?.reviewSkip || (work?.reviewSkipProposed ?? null) !== null) && (
          <div className="task-for-you-row">
            <ForYouChip items={forYou} />
            <KindMark b={work} />
            <ReviewSkipMark b={work} />
          </div>
        )}
        <WorkBadges b={work} card={c} />
        {(c.labels.length > 0 || c.blockedBy.length > 0 || c.comments.length > 0 || !!c.decisions?.length) && (
          <div className="task-meta">
            {c.labels.map((l) => (
              <span key={l} className="task-label" title={l}>
                {l}
              </span>
            ))}
            {c.blockedBy.length > 0 && (
              <Tooltip content={tr(msg({ id: 'board.card.dependsOn', defaultMessage: 'Depends on {cards}', description: 'Tooltip on a card\'s dependencies: the cards to finish first ({cards}: "#3, #5").' }), { cards: fmt.list(c.blockedBy.map((n) => cardLabelOf(get(), n)), 'unit') })}>
                <span className="faint">
                  <Icon name="link" /> {c.blockedBy.map((n) => cardLabelOf(get(), n)).join(' ')}
                </span>
              </Tooltip>
            )}
            {c.comments.length > 0 && (
              <span className="faint">
                <Icon name="comment" /> {c.comments.length}
              </span>
            )}
            {!!c.decisions?.length && (
              <Tooltip content={tr(msg({ id: 'board.card.decisionsTip', defaultMessage: 'Decisions: {n}. {decisions}', description: "Tooltip on a card's decision count: how many decisions the user recorded ({n}), then each one, cut short ({decisions}, the user's own words, separated by ·)." }), { n: c.decisions.length, decisions: c.decisions.map((d) => gist(d.text, 80)).join(' · ') })}>
                <span className="faint task-decision-count" aria-label={tr(msg({ id: 'board.card.decisionsCount', defaultMessage: 'Decisions: {n}', description: "Accessible name of a card's decision count: how many decisions the user recorded about it." }), { n: c.decisions.length })}>
                  <Icon name="law" /> {c.decisions.length}
                </span>
              </Tooltip>
            )}
          </div>
        )}
        <AgentLine c={c} agent={agent} projectPath={projectPath} live={c.column === 'doing'} />
      </div>
      {menu.element}
    </>
  )
})

type DragState = { n: number; column: BoardColumnId; before: number | null }

/**
 * The board: six columns of cards (one project's, or all of them). Cards drag between and within columns;
 * click opens one, right-click has the rest. Each column collapses to a narrow strip and each card folds to one line
 * (#170), as the user leaves them for this workspace. With archived, the archived cards as a list instead. scope: the
 * board this is part of (a project's Tasks tab: its project), for Archive All's "the n shown (of m)" (#351).
 */
export function Board({ project, scope = null, query, archived, forYouOnly = false }: { project: string | null; scope?: string | null; query: string; archived: boolean; forYouOnly?: boolean }) {
  useLanguage()
  const readOnly = readOnlyReason(useStore((s) => s.boardState?.readOnly))
  const all = useStore((s) => s.tasks)
  const keys = useStore((s) => s.projectKeys)
  const movedNames = useStore((s) => s.movedCardNames)
  // Each card's work badges (#1224), read with the board.
  const workBadges = useWorkBadges()
  // The lanes, for a card held up by its lane's deadlock (#1410).
  useLanes()
  // What waits for the user on each card (#1276): its chip, and the For you filter.
  const forYou = useForYou().byCard
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const colored = useStore((s) => s.settings?.board.columnColors ?? true)
  const colors = useStore((s) => s.settings?.board.colors)
  const fold = useBoardFold()
  const headerMenu = useContextMenu()
  // Its columns from the shown projects' stages (#1420): their options' stages and any a card of theirs is in. Null
  // until those are known: the board's frame shows without columns meanwhile, never a set the workflow then changes (HI-1682).
  const known = useBoardProjects(project)
  const shownProjects = known ?? NO_BOARD_PROJECTS
  const live = useMemo(() => all.filter((c) => !c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase())), [all, project])
  const stageOf = (c: TaskCard) => cardStage(c.column, workBadges.get(c.number)?.stage)
  const enforced = useAdvancedValue<boolean>('cw.workflow.enforce')
  const layout = boardLayout(shownProjects, live.map((c) => ({ project: c.project, stage: stageOf(c) })), tr, enforced)
  const columnOf = (c: TaskCard): BoardColumnId => cardColumn(c.column, stageOf(c), layout)
  const [drag, showDrag] = useState<DragState | null>(null)
  // The handlers read the drag from here, not from the last render: a dragover or drop can come before React has
  // drawn the drag's start (a quick drag), and would then be refused.
  const dragNow = useRef<DragState | null>(null)
  const setDrag = (d: DragState | null): void => {
    dragNow.current = d
    showDrag(d)
  }
  // The columns the dragged card can be dropped in under its rules (#1275: tasks:columns, asked as the drag starts);
  // null until known, or when no rule applies: every column. A column its rules lack is no drop target.
  const dropsNow = useRef<{ n: number; columns: Set<TaskColumn> | null } | null>(null)
  const droppable = (column: BoardColumnId): boolean => {
    // Merging takes no drop (its cards come through the merge queue), and a card in Merging leaves it only by Remove
    // from queue, never by a drag into Approved (#1420).
    if (column === 'merging' || (column === 'passed' && dragNow.current?.column === 'merging')) return false
    const d = dropsNow.current
    return !d || d.n !== dragNow.current?.n || !d.columns || d.columns.has(column)
  }
  // One function for every tile's drag start (HI-1806): one made afresh each render would draw every tile again.
  const startDrag = useCallback((e: React.DragEvent, c: TaskCard, column: BoardColumnId): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cardLabel(c))
    dragNow.current = { n: c.number, column, before: c.number }
    showDrag(dragNow.current)
    dropsNow.current = { n: c.number, columns: null }
    void call('tasks:columns', c.number)
      .then((cols) => {
        if (dropsNow.current?.n === c.number) dropsNow.current = { n: c.number, columns: cols ? new Set(cols) : null }
      })
      .catch(() => undefined)
  }, [])
  // Each card's agents and stall (tileAgents), worked out again each minute too: a card waiting in Review becomes
  // stalled with time (#521).
  useNow(60_000)
  const laneOf = useLaneOf()
  // The archived cards in full while they are shown (#1017): their search reads descriptions too.
  useEffect(() => (archived ? wantFullArchive() : undefined), [archived])
  const cards = useMemo(
    () => all.filter((c) => c.archived === archived && (project === null || c.project.toLowerCase() === project.toLowerCase()) && (!forYouOnly || forYou.has(c.number)) && cardMatches(c, query, keys, movedNames)),
    [all, project, query, archived, keys, movedNames, forYouOnly, forYou]
  )
  const boardRef = useRef<HTMLDivElement>(null)

  /**
   * Where the dragged card would land with the pointer at (x, y), from what is under it now: over a card, before it
   * (its top half) or the next one; below a column's last card (or in an empty column), at the end; in a gap between
   * cards, where it was. Called on every dragover, and after each step of scrolling (the board's or the browser's), so the marker follows what
   * scrolling brings under the pointer.
   */
  const place = (x: number, y: number): void => {
    const d = dragNow.current
    if (!d) return
    const at = document.elementFromPoint(x, y) as HTMLElement | null
    const colEl = at?.closest<HTMLElement>('.board-column')
    const column = colEl?.dataset.column as BoardColumnId | undefined
    if (!at || !colEl || !column || !boardRef.current?.contains(colEl)) return
    if (!droppable(column)) return
    const list = cards.filter((c) => columnOf(c) === column)
    const tile = at.closest<HTMLElement>('.task-card')
    let before: number | null
    // A collapsed column's strip: at its top, the true top of the board's cards there (#263), not the top of those the
    // search shows: a card the search hides would otherwise stay above it.
    if (colEl.classList.contains('collapsed')) before = live.find((c) => columnOf(c) === column && c.number !== d.n)?.number ?? null
    else if (tile) {
      const n = Number(tile.dataset.task)
      const r = tile.getBoundingClientRect()
      const i = list.findIndex((c) => c.number === n)
      before = y < r.top + r.height / 2 ? n : (list[i + 1]?.number ?? null)
    } else {
      const tiles = colEl.querySelectorAll('.task-card')
      const last = tiles[tiles.length - 1]?.getBoundingClientRect()
      if (!last || y > last.bottom || d.column !== column) before = null
      else return
    }
    if (d.column !== column || d.before !== before) setDrag({ ...d, column, before })
  }
  const placeNow = useRef(place)
  placeNow.current = place

  // While a card is dragged: near the top or bottom of a column's cards (or over its heading), that column scrolls;
  // near the board's sides, the board does. Every frame, so it keeps going with the pointer held still (dragover
  // doesn't come at a steady rate, or at all without a move). Stops when the drag ends, is dropped or cancelled, or
  // the pointer leaves the board.
  const dragging = !!drag
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!dragging) return
    const over = (e: DragEvent): void => {
      pointer.current = boardRef.current?.contains(e.target as Node) ? { x: e.clientX, y: e.clientY } : null
    }
    const stop = (): void => {
      pointer.current = null
    }
    // Out of the window: no more dragovers, so the last place would go on scrolling.
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) stop()
    }
    // Scrolled by something else (Chromium's own drag autoscroll near an edge, the wheel): what is under the pointer
    // changed too. Otherwise, when Chromium takes a column the last step to its top, no frame below moves it and the
    // marker stays a card off (#256).
    const scrolled = (): void => {
      const p = pointer.current
      if (p) placeNow.current(p.x, p.y)
    }
    document.addEventListener('dragover', over, true)
    document.addEventListener('drop', stop, true)
    document.addEventListener('dragleave', leave, true)
    document.addEventListener('scroll', scrolled, true)
    let frame = 0
    let last = performance.now()
    const step = (now: number): void => {
      // As far as the time since the last frame allows: as fast however often the window draws.
      const ms = now - last
      last = now
      const p = pointer.current
      const board = boardRef.current
      if (p && board) {
        let moved = false
        const body = (document.elementFromPoint(p.x, p.y) as HTMLElement | null)?.closest('.board-column')?.querySelector<HTMLElement>('.board-column-body')
        if (body && body.scrollHeight > body.clientHeight) {
          const r = body.getBoundingClientRect()
          const top = body.scrollTop
          body.scrollTop = clampScroll(top, frameStep(edgeSpeed(p.y, r.top, r.bottom), ms), body.scrollHeight - body.clientHeight)
          moved = body.scrollTop !== top
        }
        if (board.scrollWidth > board.clientWidth) {
          const r = board.getBoundingClientRect()
          const left = board.scrollLeft
          board.scrollLeft = clampScroll(left, frameStep(edgeSpeed(p.x, r.left, r.right), ms), board.scrollWidth - board.clientWidth)
          moved ||= board.scrollLeft !== left
        }
        if (moved) placeNow.current(p.x, p.y)
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('drop', stop, true)
      document.removeEventListener('dragleave', leave, true)
      document.removeEventListener('scroll', scrolled, true)
      pointer.current = null
    }
  }, [dragging])

  if (archived) return <ArchivedTable cards={cards} project={project} query={query} />
  if (!known) return <div ref={boardRef} className={cx('board', colored && 'colored')} data-loading="" />

  const drop = async (into: BoardColumnId): Promise<void> => {
    const d = dragNow.current
    setDrag(null)
    if (!d) return
    // A drop into a stage is its category's move (#1420).
    const column: TaskColumn = into === 'merging' ? 'passed' : into
    const card = all.find((c) => c.number === d.n)
    if (!card || (card.column === column && d.before === d.n)) return
    // Into Doing from another column: who works on it is asked first, and the card stays put until then (Cancel).
    if (column === 'doing' && card.column !== 'doing') return moveToDoing({ n: card.number, project: card.project, agent: card.agent, before: d.before })
    // Shown moved at once; the board is read again when the change lands (back where it was on Cancel or a refusal).
    set((s) => ({ tasks: s.tasks.map((c) => (c.number === d.n ? { ...c, column } : c)) }))
    // A move within its column is only a new place: no rule is in it.
    if (card.column === column) await change(d.n, { column, before: d.before }, tr(MOVE_FAILED))
    else await moveCard(card, column, { before: d.before })
  }

  const folded = new Set(fold.cards ?? [])
  const collapseLabel = (name: string): string => tr(msg({ id: 'board.columns.collapse', defaultMessage: 'Collapse {column}', description: "Tooltip, accessible name and menu item: folds a board column ({column}, its name) sideways into a narrow strip." }), { column: name })
  const columnMenu = (col: BoardStageColumn, list: TaskCard[]): MenuEntry[] => [
    { label: tr(msg({ id: 'board.columns.collapseCards', defaultMessage: 'Collapse All Cards', description: "Menu item in a board column's menu: folds each of its cards to one line." })), icon: 'collapse-all', disabled: !list.some((c) => !folded.has(c.number)), onClick: () => foldCards(list.map((c) => c.number), true) },
    { label: tr(msg({ id: 'board.columns.expandCards', defaultMessage: 'Expand All Cards', description: "Menu item in a board column's menu: shows each of its folded cards in full." })), icon: 'expand-all', disabled: !list.some((c) => folded.has(c.number)), onClick: () => foldCards(list.map((c) => c.number), false) },
    { separator: true },
    { label: collapseLabel(col.name), icon: 'chevron-left', onClick: () => collapseColumn(col.id, true) },
    { separator: true },
    // Todo's cards as a lane (#1280), in the column's order: the first card's project's (a lane is one project's).
    ...(col.id === 'todo' && list.some((c) => c.project)
      ? [
          {
            label: tr(msg({ id: 'board.columns.startLane', defaultMessage: 'Start Lane with These Cards…', description: "Menu item in the Todo column's menu: opens Start Lane with the column's cards, in its order (a lane: a builder and a reviewer working through cards in turn). Glossary: lane." })),
            icon: 'list-ordered',
            disabled: !!readOnly,
            onClick: () => {
              const first = list.find((c) => c.project)!.project
              openLaneStart(first, list.filter((c) => c.project.toLowerCase() === first.toLowerCase()).map((c) => c.number))
            }
          },
          { separator: true }
        ]
      : []),
    // Merging's cards are the merge queue's: no Archive All there. A column's archives its own stage's cards only, whether
    // or not another stage of its category shows now: a card can move on to Merging while the dialog is open (HR2's
    // #1420 rounds 1 and 2), and main checks each card's stage again.
    ...(col.id === 'merging' ? [] : [archiveAllItem(all, { column: col.category, stage: col.stage, name: col.name, project, scope, query }, readOnly, stageOf)])
  ]

  const column = (col: BoardStageColumn) => {
        const list = cards.filter((c) => columnOf(c) === col.id)
        const name = col.name
        const description = col.id === 'merging' ? tr(MERGING_TIP) : tr(COLUMN_TEXT[col.category].description)
        const columnProps = {
          'data-column': col.id,
          'data-stage': col.stage,
          style: colored ? ({ '--col': columnColor(colors, col.category) } as React.CSSProperties) : undefined,
          onDragOver: (e: React.DragEvent) => {
            // A column the card's rules don't have takes no drop (no highlight: the drag shows it can't go there).
            if (!dragNow.current || !droppable(col.id)) return
            e.preventDefault()
            place(e.clientX, e.clientY)
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            if (droppable(col.id)) void drop(col.id)
            else setDrag(null)
          }
        }
        // Collapsed: a narrow strip with its name and count; a card dropped on it goes to its top.
        if (fold.columns?.includes(col.id)) {
          return (
            <div key={col.id} className={cx('board-column', 'collapsed', drag?.column === col.id && 'drag-over')} {...columnProps}>
              <Tooltip content={tr(msg({ id: 'board.columns.expandTip', defaultMessage: 'Expand {column}: {description}', description: "Tooltip on a collapsed board column's strip: expands it. {column} is its name, {description} what the column is for." }), { column: name, description })}>
                <button className="board-column-strip" aria-label={tr(msg({ id: 'board.columns.expand', defaultMessage: 'Expand {column}', description: "Accessible name of a collapsed board column's strip: expands the column ({column}, its name)." }), { column: name })} aria-expanded={false} onClick={() => collapseColumn(col.id, false)} onContextMenu={(e) => headerMenu.open(e, columnMenu(col, list).slice(0, 2))}>
                  <Chevrons dir="right" />
                  <span className="count">{list.length}</span>
                  <span className="board-column-label">{name}</span>
                </button>
              </Tooltip>
            </div>
          )
        }
        return (
          <div key={col.id} className={cx('board-column', drag?.column === col.id && 'drag-over')} {...columnProps}>
            <div className="board-column-header" onContextMenu={(e) => headerMenu.open(e, columnMenu(col, list))}>
              <Tooltip content={collapseLabel(name)}>
                <button className="icon-btn board-fold" aria-label={collapseLabel(name)} aria-expanded onClick={() => collapseColumn(col.id, true)}>
                  <Chevrons dir="left" />
                </button>
              </Tooltip>
              <ColumnLabel name={name} description={description} />
              {/* The count, + and ⋯ wrap together (#1490): beside the name while it fits, else a row of their own under it. */}
              <span className="board-column-tools">
                <span className="count">{list.length}</span>
                <span className="grow" />
                {col.id === 'todo' && <IconButton icon="add" title={readOnly ?? tr(NEW_CARD_TIP)} disabled={!!readOnly} onClick={() => set({ taskOpen: { project: project ?? '' } })} />}
                <IconButton
                  icon="ellipsis"
                  title={tr(msg({ id: 'board.columns.more', defaultMessage: '{column}: more', description: "Tooltip on a board column's ⋯ button: opens its menu. {column} is its name." }), { column: name })}
                  onClick={(e) => {
                    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    headerMenu.openAt(b.left, b.bottom, columnMenu(col, list))
                  }}
                />
              </span>
            </div>
            <div className="board-column-body">
              {list.map((c) => (
                <CardTile
                  key={c.number}
                  c={c}
                  {...tileAgents(projects, c, laneOf(c))}
                  column={col.id}
                  showProject={project === null}
                  stageNote={c.project ? ownStageName(shownProjects, c.project, stageOf(c), name, tr) : null}
                  folded={folded.has(c.number)}
                  dropHere={!!drag && drag.column === col.id && drag.before === c.number && drag.n !== c.number}
                  readOnly={readOnly}
                  work={workBadges.get(c.number)}
                  forYou={forYou.get(c.number)}
                  onDragStart={startDrag}
                />
              ))}
              {drag?.column === col.id && drag.before === null && <div className="task-drop" />}
              {list.length === 0 && !drag && <div className="board-empty faint">{col.id === 'todo' ? tr(msg({ id: 'board.columns.emptyTodo', defaultMessage: 'No cards. + adds one.', description: 'In the empty Todo column of the board. + is the button in its header that adds a card.' })) : tr(msg({ id: 'board.columns.empty', defaultMessage: 'Nothing here.', description: 'In an empty board column.' }))}</div>}
            </div>
          </div>
        )
  }

  const grouped = layout.some((g) => g.columns.length > 1)
  return (
    <div ref={boardRef} className={cx('board', colored && 'colored', grouped && 'grouped')} onDragEnd={() => setDrag(null)}>
      {layout.map((g) => {
        if (g.columns.length === 1) return column(g.columns[0])
        // A category with several stages (Approved with Merging): one heading over its stages' columns (#1420).
        const open = g.columns.filter((c) => !fold.columns?.includes(c.id)).length
        return (
          <div key={g.category} className={cx('board-category', !open && 'collapsed')} data-category={g.category} style={{ flexGrow: open, ...({ '--stages': g.columns.length, '--folded': g.columns.length - open } as React.CSSProperties), ...(colored ? ({ '--col': columnColor(colors, g.category) } as React.CSSProperties) : {}) }}>
            <div className="board-category-head">
              <span>{tr(COLUMN_TEXT[g.category].label)}</span>
            </div>
            <div className="board-category-columns">{g.columns.map(column)}</div>
          </div>
        )
      })}
      {headerMenu.element}
    </div>
  )
}

/** Merging's description (its hover): no drop there (#1420). */
const MERGING_TIP = msg({ id: 'board.columns.mergingTip', defaultMessage: "Cards in Combwork's merge queue. They come here through the queue once approved, never by a drag; Remove from queue takes one out.", description: "The Merging column's description (its hover; glossary 2.2: Merging, a stage inside Approved). Remove from queue is the button on the card's Work section and in the Progress panel." })

/**
 * A board column's name in its header: wrapped between words when the column is narrow, a word too long for it ending in
 * "…" (never broken within, HI-2160), and always given in full in its tooltip with what the column is for (#886, #1420).
 */
function ColumnLabel({ name, description }: { name: string; description: string }) {
  return (
    <Tooltip
      content={
        <>
          <strong>{name}</strong>
          <div>{description}</div>
        </>
      }
    >
      <span className="board-column-label">{name}</span>
    </Tooltip>
  )
}

/** An archived card's agent, as it was named when it last had one. */
const lastAgent = (c: TaskCard): string => (c.agent ? (c.agentName ?? c.agent) : '')

/** The archived cards' table columns, in the window's language (made again when it changes). */
const archivedColumns = (): DataColumn<TaskCard>[] => [
  { key: 'number', header: '#', num: true, descFirst: true, cell: (c) => <span className="task-number" data-task={c.number}>{cardLabel(c)}</span>, sortValue: (c) => c.number, filter: { kind: 'text', value: (c) => cardLabel(c) } },
  { key: 'title', header: tr(msg({ id: 'board.archived.title', defaultMessage: 'Title', description: "A column header of the archived cards' table: the card's title." })), cell: (c) => <span className="archive-title">{c.title}</span>, sortValue: (c) => c.title, filter: { kind: 'text', value: (c) => c.title } },
  { key: 'project', header: tr(msg({ id: 'board.archived.project', defaultMessage: 'Project', description: "A column header of the archived cards' table: the card's project." })), cell: (c) => (c.project ? <span className="task-project">{c.project}</span> : <span className="faint">{tr(WORKSPACE_CARD)}</span>), sortValue: (c) => c.project || null, filter: { kind: 'choice', value: (c) => c.project || tr(WORKSPACE_CARD) } },
  {
    key: 'labels',
    header: tr(msg({ id: 'board.archived.labels', defaultMessage: 'Labels', description: "A column header of the archived cards' table: the card's labels." })),
    cell: (c) => (
      <span className="archive-labels">
        {c.labels.map((l) => (
          <span key={l} className="task-label">
            {l}
          </span>
        ))}
      </span>
    ),
    sortValue: (c) => c.labels.join(', ') || null,
    filter: { kind: 'choice', value: (c) => c.labels.join(', '), values: (c) => c.labels }
  },
  { key: 'agent', header: tr(msg({ id: 'board.archived.agent', defaultMessage: 'Agent', description: "A column header of the archived cards' table: the agent the card last had." })), cell: (c) => lastAgent(c) || <span className="faint">–</span>, sortValue: (c) => lastAgent(c) || null, filter: { kind: 'text', value: lastAgent } },
  { key: 'column', header: tr(msg({ id: 'board.archived.from', defaultMessage: 'From', description: "A column header of the archived cards' table: the board column the card was archived from." })), cell: (c) => columnName(c.column, tr), sortValue: (c) => TASK_COLUMNS.findIndex((x) => x.id === c.column), filter: { kind: 'choice', value: (c) => c.column }, choiceLabel: (v) => columnName(v as TaskColumn, tr) },
  { key: 'archived', header: tr(msg({ id: 'board.archived.archived', defaultMessage: 'Archived', description: "A column header of the archived cards' table: when the card was archived (a date and time)." })), descFirst: true, cell: (c) => formatDateTime(archivedAt(c)), sortValue: (c) => archivedAt(c) },
  { key: 'created', header: tr(msg({ id: 'board.archived.created', defaultMessage: 'Created', description: "A column header of the archived cards' table: when the card was created (a date and time)." })), descFirst: true, cell: (c) => formatDateTime(c.createdAt), sortValue: (c) => c.createdAt },
  {
    key: 'actions',
    header: '',
    className: 'archive-actions',
    cell: (c) => (
      <Tooltip content={tr(msg({ id: 'board.archived.unarchiveTip', defaultMessage: 'Bring {card} back to the end of {column}', description: "Tooltip on an archived card's Unarchive button. {card} is its name: its key, such as AM-12, or #12 for a card with none, {column} the board column it was archived from." }), { card: cardLabel(c), column: columnName(c.column, tr) })}>
        <button
          className="btn small subtle"
          onClick={(e) => {
            e.stopPropagation()
            void archive(c, false)
          }}
        >
          {tr(msg({ id: 'board.archived.unarchive', defaultMessage: 'Unarchive', description: 'Button on an archived card in the archived cards\' table: brings it back to the board.' }))}
        </button>
      </Tooltip>
    )
  }
]

/**
 * The archived cards (#249): a table that sorts, filters and pages (DataTable), newest archived first. A row opens its
 * card; Unarchive brings one back, or every selected one, to the end of the column it was archived from. The board's
 * search narrows the rows too. Batch picks one bulk archive (#351): its cards, and "Unarchive this batch", which brings
 * them all back where they were.
 */
function ArchivedTable({ cards: archivedCards, project, query }: { cards: TaskCard[]; project: string | null; query: string }) {
  useDateStyle()
  const language = useLanguage()
  const all = useStore((s) => s.tasks)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bringing, setBringing] = useState(false)
  const [batches, setBatches] = useState<ArchiveBatch[]>([])
  const [batch, setBatch] = useState('')
  useEffect(() => {
    let current = true
    void call('tasks:archiveBatches')
      .then((b) => current && setBatches(b))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [all])
  // The batches that still have archived cards, newest first, each with how many.
  const kept = useMemo(
    () =>
      batches
        .map((b) => ({ b, n: all.filter((c) => c.archived && c.archivedBatch === b.id).length }))
        .filter((x) => x.n > 0)
        .reverse(),
    [batches, all]
  )
  const chosen = kept.find((x) => x.b.id === batch) ?? null
  const cards = useMemo(() => (chosen ? archivedCards.filter((c) => c.archivedBatch === chosen.b.id) : archivedCards), [archivedCards, chosen])
  const bringBatch = async (id: string): Promise<void> => {
    setBringing(true)
    try {
      // Cards that couldn't come back stay with the batch, still shown here to try again.
      if (await unarchiveBatch(id)) setBatch('')
    } finally {
      setBringing(false)
    }
  }
  // Only cards still archived (and shown) stay selected.
  const shown = useMemo(() => new Set(cards.map((c) => String(c.number))), [cards])
  const picked = [...selected].filter((k) => shown.has(k))
  // In one project's view, its cards only: no project column.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => archivedColumns().filter((c) => project === null || c.key !== 'project'), [project === null, language])
  const unarchiveSelected = async (): Promise<void> => {
    setBringing(true)
    try {
      // Each brought back in turn, the board read once after them all (HI-1864: a read and a render per card before).
      for (const k of picked) {
        const c = cards.find((x) => String(x.number) === k)
        if (c) await archive(c, false, false)
      }
      await loadTasks()
      setSelected(new Set())
    } finally {
      setBringing(false)
    }
  }
  if (!archivedCards.length) return <div className="empty-state">{query ? tr(msg({ id: 'board.archived.noneMatch', defaultMessage: 'No archived cards match.', description: "The archived cards' view when none match the board's search." })) : tr(NO_ARCHIVED)}</div>
  const batchLabel = tr(msg({ id: 'board.archived.batch', defaultMessage: 'Batch', description: "Label of the archived cards' batch picker: which bulk archive (Archive All) to show." }))
  return (
    <div className="task-archive">
      <div className="task-archive-actions">
        <span className="faint">
          {picked.length
            ? tr(msg({ id: 'board.archived.countSelected', defaultMessage: '{n, plural, one {# archived card} other {# archived cards}} · {selected, plural, one {# selected} other {# selected}}', description: "Above the archived cards' table: how many archived cards it shows ({n}) and how many of them are selected ({selected})." }), { n: cards.length, selected: picked.length })
            : tr(msg({ id: 'board.archived.count', defaultMessage: '{n, plural, one {# archived card} other {# archived cards}}', description: "Above the archived cards' table: how many archived cards it shows." }), { n: cards.length })}
        </span>
        <button className="btn small" disabled={!picked.length || bringing} onClick={() => void unarchiveSelected()}>
          <Icon name="discard" /> {picked.length ? tr(msg({ id: 'board.archived.unarchiveSelectedN', defaultMessage: 'Unarchive Selected ({n, number})', description: "Button above the archived cards' table: brings the {n} selected cards back to the board." }), { n: picked.length }) : tr(msg({ id: 'board.archived.unarchiveSelected', defaultMessage: 'Unarchive Selected', description: "Button above the archived cards' table (off while none is selected): brings the selected cards back to the board." }))}
        </button>
        {kept.length > 0 && (
          <label className="archive-batch faint">
            {batchLabel}
            <select className="select" aria-label={batchLabel} value={chosen ? chosen.b.id : ''} onChange={(e) => setBatch(e.target.value)}>
              <option value="">{tr(msg({ id: 'board.archived.allBatches', defaultMessage: 'All archived cards', description: "The archived cards' batch picker's first choice: every archived card, whatever archived it." }))}</option>
              {kept.map(({ b, n }) => (
                <option key={b.id} value={b.id}>
                  {formatDateTime(b.at)} · {archiveBatchText(b.label, tr)} · {cardsWord(n)}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && (
          <Tooltip content={tr(msg({ id: 'board.archived.unarchiveBatchTip', defaultMessage: '{n, plural, one {Bring the # card archived in this batch back to its column, where it was} other {Bring the # cards archived in this batch back to their columns, where they were}}', description: "Tooltip on Unarchive this batch: brings the {n} cards of one bulk archive back where they were on the board." }), { n: chosen.n })}>
            <button className="btn small" disabled={bringing} onClick={() => void bringBatch(chosen.b.id)}>
              <Icon name="discard" /> {tr(msg({ id: 'board.archived.unarchiveBatch', defaultMessage: 'Unarchive this batch ({n, number})', description: "Button above the archived cards' table: brings the {n} cards of the chosen bulk archive back where they were." }), { n: chosen.n })}
            </button>
          </Tooltip>
        )}
      </div>
      <DataTable
        id="archived-cards"
        className="archived-cards"
        rows={cards}
        columns={columns}
        rowKey={(c) => String(c.number)}
        defaultSort={{ key: 'archived', desc: true }}
        defaultPageSize={20}
        empty={tr(NO_ARCHIVED)}
        onRowClick={(c) => set({ taskOpen: c.number })}
        rowLabel={(c) => tr(msg({ id: 'board.archived.openRow', defaultMessage: 'Open {card} {title}', description: "Accessible name of a row of the archived cards' table: opens the card. {card} is its name: its key, such as AM-12, or #12 for a card with none, {title} its title." }), { card: cardLabel(c), title: c.title })}
        selection={{ selected, onChange: setSelected, label: (c) => tr(msg({ id: 'board.archived.selectRow', defaultMessage: 'Select {card}', description: "Accessible name of a row's checkbox in the archived cards' table. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none." }), { card: cardLabel(c) }) }}
      />
    </div>
  )
}

/** The board's toolbar: search, archived, New Card, and its ⋯ menu (Archive All Cards…). */
export function BoardToolbar({
  project,
  scope = null,
  query,
  setQuery,
  archived,
  setArchived,
  forYouOnly,
  setForYouOnly
}: {
  project: string | null
  scope?: string | null
  query: string
  setQuery: (q: string) => void
  archived: boolean
  setArchived: (v: boolean) => void
  /** Only the cards something waits on the user for (#1276); with the search, both apply. */
  forYouOnly: boolean
  setForYouOnly: (v: boolean) => void
}) {
  useLanguage()
  const readOnly = readOnlyReason(useStore((s) => s.boardState?.readOnly))
  const count = useStore((s) => (s.tasks ?? NO_TASKS).filter((c) => c.archived && (project === null || c.project.toLowerCase() === project.toLowerCase())).length)
  // How many cards an older Hive saved are set aside (#1044): the ⋯ menu offers them while any are. Read again as the board
  // changes, and as their dialog closes: a discard there changes no card, so the board alone wouldn't say (HI-1860).
  const tasks = useStore((s) => s.tasks)
  const asideOpen = useStore((s) => s.setAsideOpen)
  const [aside, setAside] = useState(0)
  useEffect(() => {
    let live = true
    call('tasks:setAside').then(
      (a) => live && setAside(a.length),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [tasks, asideOpen])
  const menu = useContextMenu()
  const waiting = useForYou().summary.items
  const forYouCount = new Set(waiting.filter((i) => project === null || i.project.toLowerCase() === project.toLowerCase()).map((i) => i.card)).size
  return (
    <div className="board-toolbar">
      <div className="board-search">
        <Icon name="search" />
        <SearchInput placeholder={tr(msg({ id: 'board.toolbar.search', defaultMessage: 'Search cards (AM-12, words, labels)', description: "Placeholder of the board's search box: finds cards by name (AM-12: a project key, a hyphen and a number; AM- finds all of that project's; #12 works too), words or labels." }))} value={query} onChange={setQuery} />
      </div>
      <label className="flex muted board-for-you-filter" style={{ cursor: 'pointer' }}>
        <input type="checkbox" className="checkbox" checked={forYouOnly} onChange={(e) => setForYouOnly(e.target.checked)} /> {tr(msg({ id: 'board.toolbar.forYou', defaultMessage: 'For you ({n, number})', description: "A checkbox in the board's toolbar: shows only the cards something waits on the user for (an approval, a decision, a question), and how many there are ({n}). Glossary: For you." }), { n: forYouCount })}
      </label>
      <label className="flex muted" style={{ cursor: 'pointer' }}>
        <input type="checkbox" className="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {tr(msg({ id: 'board.toolbar.archived', defaultMessage: 'Archived ({n, number})', description: "A checkbox in the board's toolbar: shows the archived cards instead (how many there are: {n})." }), { n: count })}
      </label>
      <BoardWorkflowLink project={project} />
      <div className="grow" />
      <button className="btn primary" disabled={!!readOnly} title={readOnly ?? undefined} onClick={() => set({ taskOpen: { project: project ?? '' } })}>
        <Icon name="add" /> {tr(NEW_CARD)}
      </button>
      {!archived && (
        <IconButton
          icon="ellipsis"
          title={tr(msg({ id: 'board.toolbar.more', defaultMessage: 'Board: more', description: "Tooltip on the board toolbar's ⋯ button: opens the board's menu (Archive All Cards…)." }))}
          className="board-more"
          onClick={(e) => {
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
            menu.openAt(b.left, b.bottom, [
              { label: tr(START_LANE), icon: 'list-ordered', disabled: !!readOnly, onClick: () => openLaneStart(project) },
              { separator: true },
              archiveAllItem(get().tasks, { column: null, project, scope, query }, readOnly),
              { label: tr(EXPORT_BOARD), icon: 'export', onClick: () => void exportBoard() },
              ...(aside ? [{ label: tr(SET_ASIDE_ITEM, { n: aside }), icon: 'archive', onClick: () => set({ setAsideOpen: true }) }] : [])
            ])
          }}
        />
      )}
      {menu.element}
    </div>
  )
}

/**
 * The board at a glance, on the Workspace Overview (every card; each number opens the Task Board) and a project's
 * Overview (its cards only; each number opens its Tasks tab).
 */
export function TaskStrip({ project }: { project: ProjectInfo | null }) {
  useLanguage()
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // Counted again each minute: a card waiting in Review becomes stalled with time (#521).
  const tick = useNow(60_000)
  useLanes()
  const laneOf = useLaneOf()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const o = useMemo(() => taskOverview(tasks, project?.name ?? null, (c) => !!cardStalled(projects, c, laneOf(c))), [tasks, projects, project?.name, tick, laneOf])
  const open = (): void => {
    if (project) return setProjectTab(project.path, 'tasks')
    set({ boardProject: null, boardArchived: false, boardQuery: '' })
    showView('board')
  }
  if (!o.total) {
    if (!project) return null
    return (
      <div className="board-strip" data-project={project.name}>
        <Icon name="project" />
        <span>{tr(msg({ id: 'board.overview.noCards', defaultMessage: 'No cards for this project.', description: "A project's Overview, where its cards are counted, when it has none." }))}</span>
        <button className="board-strip-item" onClick={open}>
          {tr(msg({ id: 'board.overview.openTasks', defaultMessage: 'Open Tasks', description: "Button on a project's Overview with no cards: opens its Tasks tab." }))}
        </button>
      </div>
    )
  }
  const items: { key: string; label: string; n: number; tone?: string }[] = [
    { key: 'hold', label: tr(COLUMN_TEXT.hold.label), n: o.hold },
    { key: 'todo', label: tr(COLUMN_TEXT.todo.label), n: o.todo },
    { key: 'doing', label: tr(COLUMN_TEXT.doing.label), n: o.doing },
    { key: 'review', label: tr(WAITING_FOR_REVIEW), n: o.review, tone: 'accent' },
    { key: 'passed', label: tr(COLUMN_TEXT.passed.label), n: o.passed },
    { key: 'done', label: tr(COLUMN_TEXT.done.label), n: o.done },
    { key: 'stalled', label: tr(STALLED), n: o.stalled, tone: 'warning' },
    { key: 'blocked', label: tr(msg({ id: 'board.overview.blocked', defaultMessage: 'Blocked', description: "A count on the Overview's board strip: cards that are blocked (can't go on). Follows the number." })), n: o.blocked, tone: 'error' }
  ]
  return (
    <div className="board-strip" data-project={project?.name}>
      <Icon name="project" />
      {items.map((x) => (
        <button key={x.key} data-count={x.key} className={cx('board-strip-item', x.n > 0 && x.tone)} onClick={open}>
          <span className="n">{x.n}</span> {x.label}
        </button>
      ))}
    </div>
  )
}

const cardsWord = (n: number): string => tr(msg({ id: 'board.cards.count', defaultMessage: '{n, plural, one {# card} other {# cards}}', description: 'A number of cards ("3 cards"), in Archive All and the archived cards\' batch picker.' }), { n })

/**
 * Archive All in a column, or Archive All Cards (#351): what it takes (the cards the board shows, every one when nothing
 * hides any), cards agents are on passed over unless the box is ticked, and per column for the whole board. Archived as
 * one batch; the toast's Undo (and "Unarchive this batch" in Archived) brings it back where it was.
 */
export function ArchiveAllDialog() {
  useLanguage()
  const req = useStore((s) => s.boardArchiveAll)
  const all = useStore((s) => s.tasks)
  // Each card's stage from its facts: a stage column's Archive All takes its own (#1420).
  const badges = useWorkBadges()
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const assistant = useStore((s) => s.workspace?.assistant ?? null)
  const [include, setInclude] = useState(false)
  const action = useBusy()
  const { setError } = action
  useEffect(() => {
    setInclude(false)
    setError(null)
  }, [req, setError])
  if (!req) return null
  const close = (): void => set({ boardArchiveAll: null })
  const { shown, total } = archiveScope(all, req, (c) => cardStage(c.column, badges.get(c.number)?.stage))
  const held = shown.flatMap((c) => {
    const why = cardBusy(c, projects, assistant)
    return why ? [{ c, why }] : []
  })
  const going = include ? shown : shown.filter((c) => !held.some((h) => h.c === c))
  const filtered = shown.length < total
  const where = req.column === null ? null : (req.name ?? columnName(req.column, tr))
  const n = going.length
  let title: string
  if (where && filtered) title = tr(msg({ id: 'board.archiveAll.titleShownIn', defaultMessage: 'Archive the {n, number} Shown in {column}?', description: "Title of the Archive All dialog for a column whose cards a search narrows: the {n} cards shown in the column ({column}, its name)." }), { n: shown.length, column: where })
  else if (where) title = tr(msg({ id: 'board.archiveAll.titleColumn', defaultMessage: 'Archive All in {column}?', description: "Title of the Archive All dialog for a board column ({column}, its name)." }), { column: where })
  else if (filtered) title = tr(msg({ id: 'board.archiveAll.titleShown', defaultMessage: '{n, plural, one {Archive the # Shown Card?} other {Archive the # Shown Cards?}}', description: 'Title of the Archive All dialog for the whole board when a search narrows its cards: the {n} cards shown.' }), { n: shown.length })
  else title = tr(msg({ id: 'board.archiveAll.titleAll', defaultMessage: 'Archive All Cards?', description: 'Title of the Archive All dialog for the whole board.' }))
  let message: string
  // Every card it took left while it was open (moved on, archived, taken to another stage or project, #1463): none is
  // held either, so there is no box to tick.
  if (!shown.length) message = tr(msg({ id: 'board.archiveAll.noneLeft', defaultMessage: '{hasColumn, select, yes {No cards are left in {column} to archive: they moved on while this was open.} other {No cards are left to archive: they moved on while this was open.}}', description: 'In the Archive All dialog when every card it would have archived left while it was open (moved to another column or stage, or archived): nothing is left to archive. With hasColumn yes, {column} is the column\'s or stage\'s name (select: translate each sentence).' }), { hasColumn: where ? 'yes' : 'no', column: where ?? '' })
  else if (!n) message = tr(msg({ id: 'board.archiveAll.allBusy', defaultMessage: '{n, plural, one {Every card here is one an agent is on. Tick the box below to archive it anyway.} other {Every card here is one an agent is on. Tick the box below to archive them anyway.}}', description: 'In the Archive All dialog when an agent is on every card it would archive ({n} cards). The box is "Also archive cards agents are working on".' }), { n: shown.length })
  else if (filtered && where) message = tr(msg({ id: 'board.archiveAll.messageShownIn', defaultMessage: 'Archive the {n, plural, one {# card} other {# cards}} shown in {column} (of {total, number})? You can unarchive them from Archived.', description: 'The Archive All dialog for a column a search narrows: archives the {n} cards shown in {column} (its name), of its {total}. Archived is the checkbox that shows archived cards.' }), { n, column: where, total })
  else if (filtered) message = tr(msg({ id: 'board.archiveAll.messageShown', defaultMessage: 'Archive the {n, plural, one {# card} other {# cards}} shown (of {total, number})? You can unarchive them from Archived.', description: "The Archive All dialog for the whole board when a search narrows it: archives the {n} cards shown, of the board's {total}. Archived is the checkbox that shows archived cards." }), { n, total })
  else if (where) message = tr(msg({ id: 'board.archiveAll.messageColumn', defaultMessage: 'Archive {n, plural, one {# card} other {# cards}} in {column}? You can unarchive them from Archived.', description: 'The Archive All dialog for a column: archives its {n} cards ({column}, its name). Archived is the checkbox that shows archived cards.' }), { n, column: where })
  else message = tr(msg({ id: 'board.archiveAll.messageAll', defaultMessage: 'Archive {n, plural, one {# card} other {# cards}}? You can unarchive them from Archived.', description: "The Archive All dialog for the whole board: archives its {n} cards. Archived is the checkbox that shows archived cards." }), { n })
  const perColumn = TASK_COLUMNS.flatMap((col) => {
    const k = going.filter((c) => c.column === col.id).length
    return k ? [tr(msg({ id: 'board.archiveAll.columnCount', defaultMessage: '{column} {n, number}', description: 'In the Archive All dialog for the whole board: how many cards it archives from a column ("Done 4"), listed with the other columns.' }), { column: tr(COLUMN_TEXT[col.id].label), n: k })] : []
  })
  // The batch's name, kept with it in English and quoted in its cards' history; the archive's picker shows it translated.
  const label = archiveBatchLabel(req.column, filtered ? n : null)
  // Main checks each card again as it archives it (still in the column, project and search shown, and nobody on it
  // unless the box is ticked), so a card an agent took while this was open stays.
  const run = async (): Promise<void> => {
    const r = await call(
      'tasks:archiveBatch',
      going.map((c) => c.number),
      { label, column: req.column, ...(req.stage ? { stage: req.stage } : {}), project: req.project, query: req.query, includeBusy: include }
    )
    await loadTasks()
    close()
    reportArchived(r)
  }
  return (
    <Modal
      title={title}
      icon={where ? 'question' : 'warning'}
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(CANCEL)}
          </button>
          <BusyButton className={where ? 'primary' : 'danger'} autoFocus disabled={!going.length} busy={action.busy === 'archive'} busyLabel={tr(ARCHIVING)} onClick={() => void action.run('archive', run)}>
            {action.error ? tr(TRY_AGAIN) : tr(msg({ id: 'board.archiveAll.button', defaultMessage: '{n, plural, one {Archive # card} other {Archive # cards}}', description: 'The Archive All dialog\'s button: archives {n} cards.' }), { n })}
          </BusyButton>
        </>
      }
    >
      <div className="archive-all">
        <div>{message}</div>
        {filtered && <div className="faint">{tr(msg({ id: 'board.archiveAll.filteredNote', defaultMessage: 'Cards the search or filter hides stay on the board.', description: 'In the Archive All dialog when a search or filter narrows the board.' }))}</div>}
        {!where && perColumn.length > 0 && <div className="archive-all-counts">{perColumn.join(' · ')}</div>}
        {held.length > 0 && (
          <>
            <div className="archive-all-held">
              {include
                ? tr(msg({ id: 'board.archiveAll.heldIncluded', defaultMessage: '{n, plural, one {Archived too: a card an agent is on} other {Archived too: # cards agents are on}}', description: 'In the Archive All dialog, above the cards agents are on, when the user ticked to archive them too ({n} cards).' }), { n: held.length })
                : tr(msg({ id: 'board.archiveAll.heldSkipped', defaultMessage: '{n, plural, one {Skipped: a card an agent is on} other {Skipped: # cards agents are on}}', description: 'In the Archive All dialog, above the cards agents are on, which it leaves on the board ({n} cards).' }), { n: held.length })}
            </div>
            <DialogList
              items={held.map((h) =>
                include
                  ? tr(msg({ id: 'board.archiveAll.heldRow', defaultMessage: '{card} {title} · {why}', description: 'A card an agent is on, listed in the Archive All dialog: its name (its key, such as AM-12, or #12 for a card with none), title and who is on it ({why}: "Alfie is working on it").' }), { card: cardLabel(h.c), title: h.c.title, why: h.why })
                  : tr(msg({ id: 'board.archiveAll.heldRowSkipped', defaultMessage: '{card} {title} · {why} · skipped', description: 'A card an agent is on, listed in the Archive All dialog, which it leaves on the board: its name (its key, such as AM-12, or #12 for a card with none), title and who is on it ({why}: "Alfie is working on it").' }), { card: cardLabel(h.c), title: h.c.title, why: h.why })
              )}
            />
            <label className="flex dialog-check">
              <input type="checkbox" checked={include} disabled={!!action.busy} onChange={(e) => setInclude(e.target.checked)} /> {tr(msg({ id: 'board.archiveAll.includeBusy', defaultMessage: 'Also archive cards agents are working on', description: 'A checkbox in the Archive All dialog: archives the cards agents are on too.' }))}
            </label>
            {include && <div className="archive-all-warning">{tr(msg({ id: 'board.archiveAll.includeWarning', defaultMessage: "Their agents lose their card: an archived card can't be changed or moved by them, and a watch on it ends, telling the agent it was archived.", description: 'A warning in the Archive All dialog once the user ticks to archive the cards agents are on. A watch is how an agent waits for a card to change.' }))}</div>}
          </>
        )}
      </div>
    </Modal>
  )
}

/** A decision being changed in the card dialog: its new words, and its words when the change began. */
interface DecisionEdit {
  id: string
  text: string
  was: string
}

/**
 * A card's decisions (#357), pinned above its comments: what the user decided, newest last, each saying who recorded it
 * (the user decides; an agent or the Assistant may write it down) and "new since start" when it came after work on the
 * card began. The user adds, changes and removes them; agents and the Assistant can only add one (cw_update_task).
 */
function Decisions({
  card,
  draft,
  setDraft,
  editing,
  setEditing,
  setBusy,
  readOnly
}: {
  card: TaskCard
  draft: string
  setDraft: (v: string) => void
  editing: DecisionEdit | null
  setEditing: (v: DecisionEdit | null) => void
  setBusy: (busy: boolean) => void
  /** Why the board takes no changes (#1230): nothing can be added, changed or removed then. */
  readOnly: string | null
}) {
  const action = useBusy()
  // The card dialog waits for a decision being saved before it closes.
  useEffect(() => setBusy(!!action.busy), [action.busy, setBusy])
  const list = card.decisions ?? []
  const add = (): void =>
    void action.run('add', async () => {
      await call('tasks:update', card.number, { decision: draft })
      await loadTasks()
      setDraft('')
    })
  const save = (): void => {
    if (!editing) return
    void action.run('edit', async () => {
      await call('tasks:editDecision', card.number, editing.id, editing.text)
      await loadTasks()
      setEditing(null)
    })
  }
  const removeDecision = (d: TaskDecision): void =>
    void confirm({
      title: tr(msg({ id: 'board.decision.removeTitle', defaultMessage: 'Remove this decision?', description: "Title of the confirmation before a card's decision is removed." })),
      message: tr(msg({ id: 'board.decision.removeMessage', defaultMessage: '"{decision}" leaves {card}. Its history keeps what it said.', description: "The confirmation before a decision is removed: {decision} is its text (cut short), {card} the card’s name: its key, such as AM-12, or #12 for a card with none." }), { decision: d.text.length > 200 ? `${d.text.slice(0, 199)}…` : d.text, card: cardLabel(card) }),
      confirmLabel: tr(msg({ id: 'board.decision.remove', defaultMessage: 'Remove', description: 'Button: removes the decision from the card.' })),
      busyLabel: tr(msg({ id: 'board.decision.removing', defaultMessage: 'Removing…', description: 'The Remove button while the decision is being removed.' })),
      danger: true,
      run: async () => {
        await call('tasks:editDecision', card.number, d.id, null)
        await loadTasks()
      }
    })
  return (
    <div className="task-decisions">
      <div className="task-section-h">
        {tr(msg({ id: 'board.decision.heading', defaultMessage: 'Decisions ({n})', description: "A heading in the card dialog: the decisions the user recorded about the card, and how many ({n})." }), { n: list.length })}
        <InfoTip text={tr(msg({ id: 'board.decision.info', defaultMessage: 'What you decided about this card: scope, wording, a default. Agents read them when they start and again before Review, and follow them where the description says otherwise; reviewers check the work against them. An agent or the Assistant can write down a decision you made; only you change or remove one.', description: "The (i) beside the card dialog's Decisions heading. Review is the board column; the Assistant is the Combwork Assistant." }))} />
      </div>
      {list.map((d) => (
        <div key={d.id} className={cx('task-decision', newSinceStart(card, d) && 'new')}>
          {editing?.id === d.id ? (
            <div className="task-decision-edit">
              <textarea className="input" aria-label={tr(msg({ id: 'board.decision.editLabel', defaultMessage: 'Decision', description: 'Accessible name of the box where a decision is changed (card dialog).' }))} value={editing.text} autoFocus onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && save()} />
              <div className="flex">
                <button className="btn small subtle" disabled={!!action.busy} onClick={() => setEditing(null)}>
                  {tr(CANCEL)}
                </button>
                <BusyButton className="small" busy={action.busy === 'edit'} busyLabel={tr(SAVING)} disabled={!editing.text.trim() || editing.text.trim() === d.text} onClick={save}>
                  {tr(SAVE)}
                </BusyButton>
              </div>
            </div>
          ) : (
            <>
              <Markdown className="task-decision-text" source={d.text} cards={MARKDOWN_CARDS} />
              <div className="task-decision-by faint">
                {/* "You" is how a decision the user recorded names its recorder (stored, English). */}
                {d.recordedBy && d.recordedBy !== 'You' ? tr(msg({ id: 'board.decision.byRecorded', defaultMessage: 'Decided by you · recorded by {recorder}', description: "Under a decision in the card dialog: the user decided it, and an agent or the Assistant wrote it down ({recorder}, its name)." }), { recorder: d.recordedBy }) : tr(msg({ id: 'board.decision.by', defaultMessage: 'Decided by you', description: 'Under a decision in the card dialog: the user decided it (and recorded it).' }))} · <Tooltip content={formatDateTime(d.at)}><span>{timeAgo(d.at)}</span></Tooltip>
                {d.editedAt ? ` · ${tr(msg({ id: 'board.decision.edited', defaultMessage: 'edited', description: 'Under a decision in the card dialog, after when it was decided: it was changed since. Lower case.' }))}` : ''}
                {newSinceStart(card, d) && <span className="badge accent">{tr(msg({ id: 'board.decision.new', defaultMessage: 'new since start', description: 'A badge on a decision in the card dialog: it was recorded after work on the card began. Lower case, short.' }))}</span>}
                <span className="grow" />
                {!card.archived && (
                  <>
                    <IconButton icon="edit" title={readOnly ?? tr(msg({ id: 'board.decision.change', defaultMessage: 'Change this decision', description: 'Tooltip on the pencil button beside a decision (card dialog).' }))} disabled={!!readOnly} onClick={() => setEditing({ id: d.id, text: d.text, was: d.text })} />
                    <IconButton icon="trash" title={readOnly ?? tr(msg({ id: 'board.decision.removeTip', defaultMessage: 'Remove this decision', description: 'Tooltip on the bin button beside a decision (card dialog).' }))} disabled={!!readOnly} onClick={() => removeDecision(d)} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ))}
      {!card.archived && (
        <div className="task-decision-new">
          <textarea className="input" aria-label={tr(msg({ id: 'board.decision.newLabel', defaultMessage: 'New decision', description: 'Accessible name of the box where a new decision is written (card dialog).' }))} placeholder={tr(msg({ id: 'board.decision.newPlaceholder', defaultMessage: 'Record a decision you made about this card (agents follow it over the description)', description: 'Placeholder of the box where a new decision is written (card dialog).' }))} title={readOnly ?? undefined} disabled={!!readOnly} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim() && add()} />
          {/* Easy to see once there is something to add (#432), and the dialog's Save adds it too. */}
          <div className="task-new-actions">
            {draft.trim() && <span className="faint">{tr(msg({ id: 'board.decision.saveAddsIt', defaultMessage: 'Save adds it too', description: "Beside Add Decision once something is written: the card dialog's Save button adds the decision as well." }))}</span>}
            <Tooltip content={readOnly}>
              <BusyButton className={cx('small', draft.trim() && 'primary')} busy={action.busy === 'add'} busyLabel={tr(ADDING)} disabled={!draft.trim() || !!readOnly} onClick={add}>
                <Icon name="law" /> {tr(msg({ id: 'board.decision.add', defaultMessage: 'Add Decision', description: 'Button in the card dialog: records the decision written above.' }))}
              </BusyButton>
            </Tooltip>
          </div>
        </div>
      )}
      {action.error && <div className="field-error">{action.error}</div>}
    </div>
  )
}

/** The Board view (activity bar): every project's cards, or the one chosen in the sidebar. */
export function BoardView() {
  const project = useStore((s) => s.boardProject)
  const query = useStore((s) => s.boardQuery)
  const archived = useStore((s) => s.boardArchived)
  const forYouOnly = useStore((s) => s.boardForYou)
  // Its path only (HI-1806): an agent's state changing renders the cards that show it, not the whole board.
  const workspace = useStore((s) => s.workspace?.path ?? null)
  useLanguage()
  useEffect(() => {
    void loadTasks()
    loadBoardFold()
  }, [workspace])
  if (!workspace) return <div className="empty-state">{tr(msg({ id: 'board.view.noWorkspace', defaultMessage: 'Open a workspace to see its task board.', description: 'The Task Board view with no workspace open.' }))}</div>
  return (
    <div className="board-view">
      <div className="board-header">
        <h1>
          {tr(TASK_BOARD)}
          {project !== null && <span className="faint"> · {project || tr(msg({ id: 'board.view.workspaceCards', defaultMessage: 'workspace cards', description: "After the Task Board's title when the sidebar shows the cards of no project (about the whole workspace). Lower case." }))}</span>}
        </h1>
        <span className="faint">{tr(msg({ id: 'board.view.intro', defaultMessage: 'Plan work as cards, start them on agents, and see where each one is on its way to Done.', description: 'Under the Task Board\'s title, whatever the workflow (HI-2341: some have no Review or Approved). Done is the board\'s last column, in every workflow.' }))}</span>
      </div>
      <BoardToolbar project={project} query={query} setQuery={(q) => set({ boardQuery: q })} archived={archived} setArchived={(v) => set({ boardArchived: v })} forYouOnly={forYouOnly} setForYouOnly={(v) => set({ boardForYou: v })} />
      <Board project={project} query={query} archived={archived} forYouOnly={forYouOnly} />
    </div>
  )
}

/** A project's Tasks tab: its cards on the board. */
export function ProjectTasksTab({ project }: { project: ProjectInfo }) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [forYouOnly, setForYouOnly] = useState(false)
  useLanguage()
  useEffect(() => {
    void loadTasks()
    loadBoardFold()
  }, [project.path])
  return (
    <div className="board-view in-tab">
      <BoardToolbar project={project.name} scope={project.name} query={query} setQuery={setQuery} archived={archived} setArchived={setArchived} forYouOnly={forYouOnly} setForYouOnly={setForYouOnly} />
      <Board project={project.name} scope={project.name} query={query} archived={archived} forYouOnly={forYouOnly} />
    </div>
  )
}

/** The Board's sidebar: which project's cards to show, with how many each has open. */
export function BoardPanel() {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const chosen = useStore((s) => s.boardProject)
  useLanguage()
  const readOnly = readOnlyReason(useStore((s) => s.boardState?.readOnly))
  const open = (name: string | null): number => tasks.filter((c) => !c.archived && c.column !== 'done' && (name === null || c.project.toLowerCase() === name.toLowerCase())).length
  const review = tasks.filter((c) => !c.archived && c.column === 'review')
  useNow(60_000)
  useLanes()
  const laneOf = useLaneOf()
  const stalled = tasks.filter((c) => cardStalled(projects, c, laneOf(c)))
  const row = (name: string | null, label: string, icon: string) => (
    <div key={name === null ? 'all' : `p:${name}`} className={cx('row', chosen === name && 'selected')} onClick={() => set({ boardProject: name })}>
      <Icon name={icon} /> <span className="label">{label}</span>
      <span className="count">{open(name) || ''}</span>
    </div>
  )
  return (
    <>
      <div className="pane-header">
        {tr(TASK_BOARD)}
        <InfoTip text={tr(msg({ id: 'board.panel.info', defaultMessage: "The workspace's cards, in .combwork/tasks. Agents and the Assistant read, change and move them through Combwork's tools (finished work goes to Review); only you archive or delete them.", description: "The (i) beside the Board sidebar's title. Keep .combwork/tasks as it is (a folder). Review is a board column." }))} />
        <div className="actions">
          <IconButton icon="add" title={readOnly ?? tr(NEW_CARD_TIP)} disabled={!!readOnly} onClick={() => set({ taskOpen: { project: chosen ?? '' } })} />
          <IconButton icon="refresh" title={tr(msg({ id: 'board.panel.refresh', defaultMessage: 'Refresh', description: "Tooltip on the Board sidebar's refresh button: reads the cards again." }))} onClick={() => void loadTasks()} />
        </div>
      </div>
      <div className="pane-body">
        {row(null, tr(msg({ id: 'board.panel.allProjects', defaultMessage: 'All projects', description: "The Board sidebar's first row: shows every project's cards." })), 'layers')}
        {projects.map((p) => row(p.name, p.name, 'folder'))}
        {row('', tr(msg({ id: 'board.panel.workspace', defaultMessage: 'Workspace', description: "A row of the Board sidebar: shows the cards of no project (about the whole workspace)." })), 'root-folder')}
        {stalled.length > 0 && (
          <>
            <div className="section-header">
              {tr(STALLED)} <span className="count">{stalled.length}</span>
              <InfoTip text={tr(msg({ id: 'board.panel.stalledInfo', defaultMessage: "Cards in Active that nobody is working on: no agent has them, or their agent was removed or isn't running. Also cards in Active or Review that an agent in a card loop left without waiting on them.", description: "The (i) beside the Board sidebar's Stalled heading. Active and Review are board columns." }))} />
            </div>
            {stalled.map((c) => (
              <Tooltip key={c.number} block content={cardStalled(projects, c, laneOf(c)) ?? ''}>
                <div className="row" onClick={() => set({ taskOpen: c.number })}>
                  <span className="task-number">{cardLabel(c)}</span> <span className="label">{c.title}</span>
                </div>
              </Tooltip>
            ))}
          </>
        )}
        {review.length > 0 && (
          <>
            <div className="section-header">
              {tr(WAITING_FOR_REVIEW)} <span className="count">{review.length}</span>
            </div>
            {review.map((c) => (
              <div key={c.number} className="row" onClick={() => set({ taskOpen: c.number })}>
                <span className="task-number">{cardLabel(c)}</span> <span className="label">{c.title}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
/**
 * A line of a card's history, or a comment Combwork wrote, as the window shows it (#846): from its message and values, in the
 * window's language (a batch's name worded as the archive's picker words it); its English for an entry from before, or
 * one whose message this Combwork doesn't know.
 */
function storedLine(english: string, stored: StoredText | undefined): string {
  if (!stored) return english
  const shown = stored.values && typeof stored.values.label === 'string' ? { ...stored, values: { ...stored.values, label: archiveBatchText(stored.values.label, tr) } } : stored
  // A message within its values: a CLI's sentence, or the workflow's (a request's question, #1266).
  return storedLineText(shown, (m, values) => tr(m, values), (id) => providerMessage(id) ?? workflowMessage(id)) ?? english
}

/** Who wrote a history line or a comment, as stored (English: "You", "Assistant", "Repair"), in the window's language; Combwork and agents' names as they are. */
const byText = (by: string): string => (Object.hasOwn(BY_TEXT, by) ? tr(BY_TEXT[by]) : by)
/** Who added a card, as board.dialog.added selects it: the user, the Assistant, Repair, or an agent (other, by name). */
const ADDED_BY: Record<string, string> = { You: 'you', Assistant: 'assistant', Repair: 'repair' }
const addedBy = (by: string): string => (Object.hasOwn(ADDED_BY, by) ? ADDED_BY[by] : 'other')

// The card dialog: a new card, or one card in full (its fields, description, comments and history).
// ---------------------------------------------------------------------------

/** The cards a Depends on or Related box names: keys (AM-12), #12 or 12 (#1221). */
const refs = (v: string): number[] =>
  v
    .split(/[\s,]+/)
    .map((x) => (x ? cardNumberOf(x) : null))
    .filter((x): x is number => x !== null && x > 0)
/** The cards a Depends on or Related box shows: by key where they have one. */
const refsText = (ns: readonly number[]): string => ns.map((n) => cardLabelOf(get(), n)).join(' ')

export function TaskDialog() {
  const open = useStore((s) => s.taskOpen)
  useDateStyle()
  useLanguage()
  const card = useStore((s) => (typeof s.taskOpen === 'number' ? (s.tasks.find((c) => c.number === s.taskOpen) ?? null) : null))
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // What on it waits for the user (#1276): answered in its For you section.
  const forYouItems = useForYou().byCard.get(card?.number ?? -1)
  // Its work's badges: its kind and a kind an agent proposed (#1277).
  const badge = useWorkBadges().get(card?.number ?? -1)
  // A new card's kind (#1277): no code, or code (the default).
  const [noCode, setNoCode] = useState(false)
  // A new card's Review: Skip (#1625), and the user's optional note on why.
  const [skipReview, setSkipReview] = useState(false)
  const [skipNote, setSkipNote] = useState('')
  // Why the board takes no changes (#1230): its 1.0 upgrade waits, or a newer Combwork saved it. The card can be read, not changed.
  const readOnly = readOnlyReason(useStore((s) => s.boardState?.readOnly))
  const ro = !!readOnly
  const isNew = open !== null && typeof open === 'object'
  // An archived card in full while its dialog is open (#1017): the board has it in short until then, and the dialog's
  // fields are filled once it is in full.
  const archivedCard = !!card?.archived
  const ready = !card?.summary
  useEffect(() => (archivedCard ? wantFullArchive() : undefined), [archivedCard, open])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [project, setProject] = useState('')
  const [agent, setAgent] = useState('')
  const [column, setColumn] = useState<TaskColumn>('todo')
  const [labels, setLabels] = useState('')
  const [blocked, setBlocked] = useState('')
  const [waiting, setWaiting] = useState('')
  const [blockedBy, setBlockedBy] = useState('')
  const [links, setLinks] = useState('')
  // Its doc sections to read first (#818), one reference a line.
  const [context, setContext] = useState('')
  // The saved references that didn't resolve when last checked (#819), while they are still in the box.
  const broken = (card?.contextProblems ?? []).filter((p) => splitDocRefs(context).includes(p.ref))
  // A reference being read in the section viewer.
  const [viewRef, setViewRef] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [comment, setComment] = useState('')
  // A decision being written, one being changed (with its words before) and whether one is being saved (#357): the
  // dialog keeps them, so closing asks before they are lost and waits for a save.
  const [decision, setDecision] = useState('')
  const [decisionEdit, setDecisionEdit] = useState<DecisionEdit | null>(null)
  const [decisionBusy, setDecisionBusy] = useState(false)
  // The drafts as they are now, for a save run again later: Move to Doing's Try Again calls the same prepare, made when
  // Save was clicked. Each is cleared here as soon as it is written, so a retry writes only what is still unsaved (#432).
  const drafts = useRef<{ decision: string; comment: string; edit: DecisionEdit | null }>({ decision: '', comment: '', edit: null })
  drafts.current = { decision, comment, edit: decisionEdit }
  const action = useBusy()
  // Its attachments (HI-1700), and files pasted or dropped into its description or comment box, kept until Save or Post.
  const files = useCardAttachments(card?.number ?? null)
  const attach = useAttachDrafts((text) => action.setError(text))
  const lookup = attachmentLookup(files.list, attach.drafts)
  const onAttachmentLink = (href: string): boolean => openAttachmentLink(href, files.list)
  const attachmentImages = attachmentImage(lookup)
  // Answers to its For you requests being written, by request (#1276 round 1): kept here, so closing asks first, as for a
  // comment; and whether one is being sent (the dialog doesn't close meanwhile).
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({})
  const [answering, setAnswering] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  // The fields as the dialog opened: Save sends only what the user changed since, so a change an agent made
  // meanwhile (moving the card to Review, say) isn't put back.
  const orig = useRef<Record<string, string>>({})
  // Bumped as the fields open, so the dialog draws again with them (#548): when every field already holds what it is set
  // to (the first New Card), no state changes, React skips that render, and Escape answers with the first render's view
  // (made before `orig` was filled), asking to discard an empty card.
  const [, setOpened] = useState(0)

  // Filled from the card when it opens (later changes by agents show in its comments and history), before anything is
  // drawn or answered: a render with the last card's fields (or none) would show them, and take them for edits (#288).
  const { setError: setActionError } = action
  useLayoutEffect(() => {
    // Files pasted or dropped and not saved (HI-1700) never outlive the card they were for: dropped, previews revoked,
    // whenever the dialog closes (Cancel, Discard) or opens on another card. A Save has read them before it closes it.
    attach.clear('description', 'comment')
    if (open === null || !ready) return
    setActionError(null)
    setAnswerDrafts({})
    setNoCode(false)
    setSkipReview(false)
    setSkipNote('')
    const c = typeof open === 'number' ? get().tasks.find((x) => x.number === open) : null
    setTitle(c?.title ?? '')
    setDescription(c?.description ?? '')
    setProject(c ? c.project : typeof open === 'object' ? open.project : '')
    setAgent(c?.agent ?? '')
    setColumn(c?.column ?? 'todo')
    setLabels(c?.labels.join(', ') ?? '')
    setBlocked(c?.blocked ?? '')
    setWaiting(c?.waitingFor?.reason ?? '')
    setBlockedBy(c ? refsText(c.blockedBy) : '')
    setLinks(c ? refsText(c.links) : '')
    setContext(c?.context?.join('\n') ?? '')
    orig.current = {
      title: c?.title ?? '',
      description: c?.description ?? '',
      project: c ? c.project : typeof open === 'object' ? open.project : '',
      agent: c?.agent ?? '',
      column: c?.column ?? 'todo',
      labels: c?.labels.join(', ') ?? '',
      blocked: c?.blocked ?? '',
      waiting: c?.waitingFor?.reason ?? '',
      blockedBy: c ? refsText(c.blockedBy) : '',
      links: c ? refsText(c.links) : '',
      context: c?.context?.join('\n') ?? ''
    }
    setOpened((n) => n + 1)
    setPreview(!!c?.description)
    setComment('')
    setDecision('')
    setDecisionEdit(null)
    setShowHistory(false)
    // A new card's title takes the keyboard, unless it is already in the dialog: in a busy window the timer can fire
    // after the user has moved on to another field, and what they type next would land in the title (#229).
    setTimeout(() => {
      const t = titleRef.current
      if (!c && t && !t.closest('.dialog')?.contains(document.activeElement)) t.focus()
    }, 30)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready])

  // Whether the chosen project's rules review (#1625): Skip review is offered, and sent, only where they do.
  const projectReviews = useProjectReviews(projects.find((p) => p.name === project)?.path ?? null)
  if (open === null || (!isNew && (!card || !ready))) return null
  const close = (): void => set({ taskOpen: null })
  const proj = projects.find((p) => p.name === project) ?? null
  const labelList = labels
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  const fields: Record<string, string> = { title, description, project, agent, column, labels, blocked, blockedBy, links, context }
  // Edits not saved yet: the fields as they opened, or a comment being written.
  const edited = Object.keys(fields).filter((k) => fields[k] !== (orig.current[k] ?? ''))
  const decisionChanged = !!decisionEdit && decisionEdit.text.trim() !== decisionEdit.was
  // An answer written to a request still open (one answered or retired meanwhile has nothing left to send).
  const answerUnsent = (forYouItems ?? []).some((i) => !!answerDrafts[i.request]?.trim())
  const unsaved = edited.length > 0 || !!comment.trim() || !!decision.trim() || decisionChanged || answerUnsent

  /**
   * Closing (Escape, ×, outside, Cancel, going to a Read first reference, or after Save): asks first when something would
   * be lost; says whether it closed. `saved`: after Save, which saved the rest: only an unsent answer is left to lose.
   */
  const tryClose = async (saved = false): Promise<boolean> => {
    if (action.busy || decisionBusy || answering) return false
    if (saved ? answerUnsent : unsaved) {
      const what = saved ? [tr(UNSENT_ANSWER)] : [
        edited.length ? (isNew ? tr(msg({ id: 'board.discard.newCard', defaultMessage: 'this new card', description: 'What closing the card dialog would lose, in "Closing loses {what}.": a card not added yet. Lower case.' })) : tr(msg({ id: 'board.discard.changes', defaultMessage: 'your changes to the card', description: 'What closing the card dialog would lose, in "Closing loses {what}.": changed fields. Lower case.' }))) : '',
        comment.trim() ? tr(msg({ id: 'board.discard.comment', defaultMessage: 'the comment you are writing', description: 'What closing the card dialog would lose, in "Closing loses {what}.": a comment not posted. Lower case.' })) : '',
        decision.trim() ? tr(msg({ id: 'board.discard.decision', defaultMessage: 'the decision you are writing', description: 'What closing the card dialog would lose, in "Closing loses {what}.": a decision not added. Lower case.' })) : '',
        decisionChanged ? tr(msg({ id: 'board.discard.decisionChange', defaultMessage: 'your change to a decision', description: 'What closing the card dialog would lose, in "Closing loses {what}.": a decision changed and not saved. Lower case.' })) : '',
        answerUnsent ? tr(UNSENT_ANSWER) : ''
      ].filter(Boolean)
      const choice = await choose({
        title: tr(msg({ id: 'board.discard.title', defaultMessage: 'Discard unsaved changes?', description: 'Title of the question when the card dialog closes with something not saved.' })),
        message: tr(msg({ id: 'board.discard.message', defaultMessage: 'Closing loses {what}.', description: 'When the card dialog closes with something not saved: {what} lists what would be lost ("your changes to the card and the comment you are writing").' }), { what: fmt.list(what) }),
        choices: [
          { label: tr(msg({ id: 'board.discard.discard', defaultMessage: 'Discard', description: 'Button: closes the card dialog, losing what was not saved.' })), value: 'discard' },
          { label: tr(msg({ id: 'board.discard.keep', defaultMessage: 'Keep Editing', description: 'Button: goes back to the card dialog, nothing lost.' })), value: 'keep' }
        ]
      })
      if (choice !== 'discard') return false
    }
    close()
    return true
  }

  /**
   * Saves the card (creates a new one); the dialog's fields become the saved ones. hold: all but its column and agent,
   * which the Move to Doing dialog sets (they stay unsaved here until it has).
   */
  const persist = async (hold = false): Promise<void> => {
    if (!title.trim()) throw new Error(tr(NEEDS_TITLE))
    if (isNew) {
      const c = await call('tasks:create', { title, description, project, agent: agent || null, column, labels: labelList, ...(splitDocRefs(context).length ? { context: splitDocRefs(context) } : {}), ...(noCode ? { kind: 'no-code' as const } : {}), ...(skipReview && projectReviews === true ? { skipReview: skipNote.trim() } : {}) }, await attach.payload({ description }))
      attach.clear('description')
      const extra: TaskPatch = {}
      if (blocked.trim()) extra.blocked = blocked
      if (refs(blockedBy).length) extra.blockedBy = refs(blockedBy)
      if (refs(links).length) extra.links = refs(links)
      if (Object.keys(extra).length) await call('tasks:update', c.number, extra)
    } else if (card) {
      const was = orig.current
      const patch: TaskPatch = {}
      if (title !== was.title) patch.title = title
      if (description !== was.description) patch.description = description
      if (project !== was.project) patch.project = project
      if (agent !== was.agent && !hold) patch.agent = agent || null
      if (column !== was.column && !hold) patch.column = column
      if (labels !== was.labels) patch.labels = labelList
      if (blocked !== was.blocked) patch.blocked = blocked.trim() || null
      if (waiting !== was.waiting) patch.waitingFor = waiting.trim() || null
      if (blockedBy !== was.blockedBy) patch.blockedBy = refs(blockedBy)
      if (links !== was.links) patch.links = refs(links)
      if (context !== was.context) patch.context = splitDocRefs(context)
      // Someone else changed a field the user also changed: the user's choice wins, but they are told.
      const now: Record<string, string> = {
        title: card.title,
        description: card.description,
        project: card.project,
        agent: card.agent ?? '',
        column: card.column,
        labels: card.labels.join(', '),
        blocked: card.blocked ?? '',
        blockedBy: refsText(card.blockedBy),
        links: refsText(card.links),
        context: card.context?.join('\n') ?? ''
      }
      const clashed = Object.keys(patch).filter((k) => now[k] !== was[k])
      // A card that changes project leaves its agent; one of the new project's agents is given it afterwards.
      const give = patch.project !== undefined && patch.agent ? patch.agent : null
      if (give) delete patch.agent
      // The column last, through the card's rules (#1275): asked first when the move skips one.
      const to = patch.column
      delete patch.column
      // Files pasted or dropped (HI-1700) go with the change, the comment's too (and the comment with them), in one call.
      const said = drafts.current.comment
      const withComment = Object.keys(patch).length > 0 && !!said.trim() && attach.drafts.comment.length > 0
      const sent = Object.keys(patch).length ? await attach.payload({ ...(patch.description !== undefined ? { description: patch.description } : {}), ...(withComment ? { comment: said } : {}) }) : undefined
      if (Object.keys(patch).length) await call('tasks:update', card.number, patch, sent || withComment ? { ...(withComment ? { comment: said } : {}), ...(sent ? { drafts: sent } : {}) } : undefined)
      attach.clear('description')
      if (withComment) {
        drafts.current.comment = ''
        setComment('')
        attach.clear('comment')
      }
      if (give) await call('tasks:update', card.number, { agent: give })
      if (to !== undefined && !(await moveCard(card, to, { rethrow: true }))) {
        // Where the move left it (back where it was, or part of the way: started, say), as the board has just read it:
        // the dialog's saved state follows, so Save again or Cancel never claims a column it isn't in.
        const at = get().tasks.find((t) => t.number === card.number)?.column ?? card.column
        orig.current = { ...fields, column: at }
        setColumn(at)
        throw new Error(tr(MOVE.notMoved, { column: tr(COLUMN_TEXT[at].label) }))
      }
      if (clashed.length) {
        notify(
          'warning',
          tr(msg({ id: 'board.clash.title', defaultMessage: '{card} was also changed while you edited it', description: "A warning toast's title after saving the card dialog: someone (an agent, say) changed the same fields meanwhile. {card} is the card’s name: its key, such as AM-12, or #12 for a card with none." }), { card: cardLabel(card) }),
          tr(msg({ id: 'board.clash.message', defaultMessage: 'Your {fields} replaced the change made meanwhile (see its history).', description: "A warning toast after saving the card dialog: the user's values won over a change made meanwhile. {fields} lists the fields (\"title, labels\")." }), { fields: fmt.list(clashed.map((k) => tr(FIELD_NAMES[k] ?? FIELD_NAMES.title)), 'unit') })
        )
      }
    }
    orig.current = hold ? { ...fields, agent: orig.current.agent, column: orig.current.column } : { ...fields }
    await loadTasks()
  }

  /** A decision being changed to nothing: Save refuses it (removing one is its bin's, never Save's). */
  const BLANK_DECISION = tr(msg({ id: 'board.decision.blank', defaultMessage: "A decision can't be empty: write it again, cancel the change, or remove the decision with its bin.", description: 'An error in the card dialog: Save with a decision changed to nothing. The bin is the button that removes a decision.' }))
  const blankEdit = (): boolean => {
    const e = drafts.current.edit
    return !!e && !e.text.trim() && e.was !== ''
  }

  /**
   * The decision being written, and a change to one, recorded (#432: Save leaves nothing typed in the dialog behind, as
   * for a comment). Read from `drafts` and cleared there once recorded, so a retry (a failure after it, Try Again in Move
   * to Doing) doesn't record it twice.
   */
  const saveDecisions = async (): Promise<void> => {
    if (!card) return
    if (blankEdit()) throw new Error(BLANK_DECISION)
    let changed = false
    const e = drafts.current.edit
    if (e && e.text.trim() !== e.was) {
      await call('tasks:editDecision', card.number, e.id, e.text)
      drafts.current.edit = null
      setDecisionEdit(null)
      changed = true
    }
    const d = drafts.current.decision
    if (d.trim()) {
      await call('tasks:update', card.number, { decision: d })
      drafts.current.decision = ''
      setDecision('')
      changed = true
    }
    if (changed) await loadTasks()
  }

  /** The comment being written, posted (Save leaves nothing in the dialog behind); from `drafts`, as above. */
  const postComment = async (): Promise<void> => {
    const c = drafts.current.comment
    if (!card || !c.trim()) return
    await call('tasks:comment', card.number, c, await attach.payload({ comment: c }))
    drafts.current.comment = ''
    setComment('')
    attach.clear('comment')
    await loadTasks()
  }

  /** Save: the card's fields, and a decision and a comment being written (so nothing in the dialog is left behind). */
  const save = async (): Promise<void> => {
    // Into Doing from another column: the Move to Doing dialog asks who works on it, and saves the rest when it is
    // confirmed (Cancel there leaves this dialog open, nothing saved).
    if (card && column === 'doing' && orig.current.column !== 'doing') {
      if (!title.trim()) return action.setError(tr(NEEDS_TITLE))
      if (blankEdit()) return action.setError(BLANK_DECISION)
      return moveToDoing({
        n: card.number,
        project,
        agent: agent || null,
        prepare: async () => {
          await persist(true)
          await saveDecisions()
          await postComment()
        },
        done: close
      })
    }
    const r = await action.run('save', async () => {
      // Checked before anything is saved: a refused Save changes nothing.
      if (blankEdit()) throw new Error(BLANK_DECISION)
      await persist()
      await saveDecisions()
      await postComment()
    })
    // Saved: an answer not sent yet (Save doesn't send it) is asked about before the dialog closes (#1276 round 1).
    if (r) await tryClose(true)
  }

  /** Start…: unsaved edits are saved first, so the agent gets the card as shown (a failed save starts nothing). */
  const start = async (): Promise<void> => {
    if (!card) return
    if (edited.length && !(await action.run('start', () => persist()))) return
    set({ taskStartFor: card.number })
  }

  const addComment = async (): Promise<void> => {
    if (!card || !comment.trim()) return
    const r = await action.run('comment', async () => {
      await call('tasks:comment', card.number, comment, await attach.payload({ comment }))
      await loadTasks()
    })
    if (r) {
      setComment('')
      attach.clear('comment')
    }
  }

  return (
    <>
      <Modal
        // Its key alone (#1221, HI-1661), as agents name it too.
        title={isNew ? tr(NEW_CARD) : cardLabel(card!)}
        icon="checklist"
        wide
        onClose={() => void tryClose()}
        busy={!!action.busy || decisionBusy}
        error={action.error}
        footer={
          <>
            {card && (
              <>
                <button className={cx('btn subtle danger-text', ro && 'ro-off') /* i18n-ignore: class names */} disabled={ro} title={readOnly ?? undefined} onClick={() => void remove(card).then((ok) => ok && close())}>
                  <Icon name="trash" /> {tr(msg({ id: 'board.dialog.delete', defaultMessage: 'Delete', description: "Button in the card dialog: deletes the card (after asking)." }))}
                </button>
                <Tooltip content={readOnly}>
                <BusyButton
                  className={cx('subtle', ro && 'ro-off') /* i18n-ignore: class names */}
                  disabled={ro}
                  busy={action.busy === 'archive'}
                  busyLabel={card.archived ? tr(msg({ id: 'board.dialog.bringingBack', defaultMessage: 'Bringing back…', description: 'The Bring Back button while the archived card is being brought back.' })) : tr(ARCHIVING)}
                  onClick={() =>
                    void action
                      .run('archive', async () => {
                        await call('tasks:archive', card.number, !card.archived)
                        await loadTasks()
                      })
                      .then((r) => r && close())
                  }
                >
                  <Icon name={card.archived ? 'discard' : 'archive'} /> {card.archived ? tr(BRING_BACK) : tr(ARCHIVE)}
                </BusyButton>
                </Tooltip>
                {!card.archived && (
                  <Tooltip content={readOnly ?? (!card.project ? tr(NEEDS_PROJECT) : edited.length ? tr(msg({ id: 'board.dialog.startTipSave', defaultMessage: 'Save your changes, then give it to an agent with the card as its prompt.', description: "Tooltip on the card dialog's Save and Start… button." })) : tr(msg({ id: 'board.dialog.startTip', defaultMessage: 'Give it to an agent, with the card as its prompt.', description: "Tooltip on the card dialog's Start… button." })))}>
                    <BusyButton className={cx('subtle', ro && 'ro-off') /* i18n-ignore: class names */} busy={action.busy === 'start'} busyLabel={tr(SAVING)} disabled={!card.project || !title.trim() || ro} onClick={() => void start()}>
                      <Icon name="play" /> {edited.length ? tr(msg({ id: 'board.dialog.saveAndStart', defaultMessage: 'Save and Start…', description: 'Button in the card dialog with unsaved changes: saves them, then asks which agent starts the card.' })) : tr(msg({ id: 'board.dialog.start', defaultMessage: 'Start…', description: 'Button in the card dialog: asks which agent starts the card.' }))}
                    </BusyButton>
                  </Tooltip>
                )}
                {/* Only for a card in progress (HI-1743): what runs on it now; its history is the card's. */}
                {cardHasActivity(card) && (
                  <Tooltip content={tr(ACTIVITY_TIP)}>
                    <button className="btn subtle" onClick={() => void tryClose().then((closed) => (closed ? openCardActivity(card) : undefined))}>
                      <Icon name="type-hierarchy" /> {tr(ACTIVITY)}
                    </button>
                  </Tooltip>
                )}
              </>
            )}
            <div className="grow" />
            <button className="btn subtle" onClick={() => void tryClose()}>
              {tr(CANCEL)}
            </button>
            <Tooltip content={readOnly}>
              <BusyButton className={cx('primary', ro && 'ro-off') /* i18n-ignore: class names */} busy={action.busy === 'save'} busyLabel={isNew ? tr(ADDING) : tr(SAVING)} disabled={!title.trim() || card?.archived || ro} onClick={() => void save()}>
                {isNew ? tr(msg({ id: 'board.dialog.addCard', defaultMessage: 'Add Card', description: 'The New Card dialog\'s main button: adds the card.' })) : tr(SAVE)}
              </BusyButton>
            </Tooltip>
          </>
        }
      >
        {readOnly && (
          <div className="banner warn task-read-only" role="status">
            <Icon name="warning" /> {readOnly}
          </div>
        )}
        {card?.archived && (
          <div className="banner info">
            <Icon name="archive" />{' '}
            {tr(msg({ id: 'board.dialog.archivedBanner', defaultMessage: '{cause, select, hidden {Archived when {project} was hidden.} removed {Archived when {project} was removed from Combwork.} done {Archived automatically after its days in Done (Settings → Board).} other {Archived.}} Bring it back to change it.', description: "A banner in an archived card's dialog: why it was archived (its project {project} hidden or removed, or after its days in the Done column: Settings → Board is where that is set), and that it must be brought back to be changed." }), { cause: card.archivedFor === 'project-hidden' ? 'hidden' : card.archivedFor === 'project-removed' ? 'removed' : card.archivedFor === 'done' ? 'done' : 'user', project: card.project })}
          </div>
        )}
        {card && !card.archived && <KindProposal card={card} b={badge} readOnly={ro} />}
        {card && !card.archived && <ReviewSkipProposal card={card} b={badge} readOnly={ro} />}
        {card && !card.archived && <ForYouSection card={card} kind={badge?.kind ?? undefined} items={forYouItems} drafts={answerDrafts} setDraft={(request, text) => setAnswerDrafts((d) => ({ ...d, [request]: text }))} setAnswering={setAnswering} />}
        <input ref={titleRef} className="input task-title-input" placeholder={tr(msg({ id: 'board.dialog.titlePlaceholder', defaultMessage: 'Title', description: "Placeholder of the card dialog's title box." }))} value={title} maxLength={200} readOnly={ro} onChange={(e) => setTitle(e.target.value)} />
        <div className="agent-form task-form">
          <label>{tr(msg({ id: 'board.dialog.project', defaultMessage: 'Project', description: "A field label in the card dialog: the card's project." }))}</label>
          <select
            className="select"
            value={project}
            disabled={ro}
            onChange={(e) => {
              setProject(e.target.value)
              setAgent('')
              // A skip ticked for another project isn't this one's choice (HR1's #1625 round 1): ticked again if wanted.
              setSkipReview(false)
              setSkipNote('')
            }}
          >
            <option value="">{tr(msg({ id: 'board.dialog.noProject', defaultMessage: 'None (about the workspace)', description: "The card dialog's project choice for a card of no project: it is about the whole workspace." }))}</option>
            {projects.map((p) => (
              <option key={p.path} value={p.name}>
                {p.name}
              </option>
            ))}
            {project && !proj && <option value={project}>{tr(msg({ id: 'board.dialog.projectGone', defaultMessage: '{project} (not in the workspace)', description: "The card dialog's project choice when the card's project ({project}) is no longer in the workspace." }), { project })}</option>}
          </select>
          <label>{tr(msg({ id: 'board.dialog.agent', defaultMessage: 'Agent', description: "A field label in the card dialog: the agent the card is given to." }))}</label>
          <select className="select" value={agent} disabled={!proj || ro} onChange={(e) => setAgent(e.target.value)}>
            <option value="">{tr(NOBODY_YET)}</option>
            {proj?.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.live ? tr(msg({ id: 'board.dialog.agentStatus', defaultMessage: '{agent} ({status})', description: "An agent in the card dialog's agent choice, with what it is doing ({status}: \"Working…\")." }), { agent: a.name, status: statusText(a.live) }) : a.name}
              </option>
            ))}
            {agent && proj && !proj.agents.some((a) => a.id === agent) && <option value={agent}>{tr(REMOVED_AGENT, { agent: card?.agentName ?? agent })}</option>}
          </select>
          <label>{tr(msg({ id: 'board.dialog.column', defaultMessage: 'Column', description: 'A field label in the card dialog: the board column the card is in.' }))}</label>
          <select className="select" value={column} disabled={ro} onChange={(e) => setColumn(e.target.value as TaskColumn)}>
            {TASK_COLUMNS.map((c) => (
              <option key={c.id} value={c.id}>
                {tr(COLUMN_TEXT[c.id].label)}
              </option>
            ))}
          </select>
          <KindField card={card} b={badge} noCode={noCode} setNoCode={setNoCode} readOnly={ro} />
          <ReviewSkipField card={card} b={badge} reviews={projectReviews} skip={skipReview} setSkip={setSkipReview} note={skipNote} setNote={setSkipNote} readOnly={ro} />
          <label>{tr(msg({ id: 'board.dialog.labels', defaultMessage: 'Labels', description: "A field label in the card dialog: the card's labels." }))}</label>
          <input className="input" placeholder={tr(msg({ id: 'board.dialog.labelsPlaceholder', defaultMessage: 'Comma separated, e.g. bug, ui', description: "Placeholder of the card dialog's labels box: labels separated by commas (bug and ui are examples)." }))} value={labels} readOnly={ro} onChange={(e) => setLabels(e.target.value)} />
          <label>{tr(BLOCKED_FIELD)}</label>
          {/* One line of text, wrapped to show all of a long reason (#372): Enter adds no line break. */}
          <textarea
            className="input task-blocked-input"
            rows={1}
            aria-label={tr(BLOCKED_FIELD)}
            placeholder={tr(msg({ id: 'board.dialog.blockedPlaceholder', defaultMessage: "Why it can't go on (empty: not blocked)", description: "Placeholder of the card dialog's Blocked box: why the card can't go on; empty means it isn't blocked." }))}
            value={blocked}
            readOnly={ro}
            onChange={(e) => setBlocked(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault()
            }}
          />
          {/* Waiting on purpose (HI-2618), a card in Active only. */}
          {card && card.column === 'doing' && (
            <>
              <label>{tr(WAITING_FIELD)}</label>
              <textarea
                className="input task-blocked-input"
                rows={1}
                aria-label={tr(WAITING_FIELD)}
                placeholder={tr(msg({ id: 'board.dialog.waitingPlaceholder', defaultMessage: 'Why it waits on purpose (empty: not waiting). It isn’t reported as stalled; its agent keeps running.', description: "Placeholder of the card dialog's Waiting box (HI-2618), for a card in Active: why it waits on purpose (held for a quiet window, an answer from someone). Combwork then doesn't report it as stalled, and nothing is stopped. Empty means it isn't waiting." }))}
                value={waiting}
                readOnly={ro}
                onChange={(e) => setWaiting(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) e.preventDefault()
                }}
              />
            </>
          )}
          <label>{tr(msg({ id: 'board.dialog.dependsOn', defaultMessage: 'Depends on', description: 'A field label in the card dialog: the cards to finish before this one.' }))}</label>
          <input className="input" placeholder={tr(msg({ id: 'board.dialog.dependsOnPlaceholder', defaultMessage: 'Cards to finish first, e.g. AM-3 AM-5', description: "Placeholder of the card dialog's Depends on box: cards by name (AM-3 AM-5 are examples: a project key, a hyphen and a number; #3 works too)." }))} value={blockedBy} readOnly={ro} onChange={(e) => setBlockedBy(e.target.value)} />
          <label>{tr(msg({ id: 'board.dialog.related', defaultMessage: 'Related', description: 'A field label in the card dialog: related cards.' }))}</label>
          <input className="input" placeholder={tr(msg({ id: 'board.dialog.relatedPlaceholder', defaultMessage: 'Related cards, e.g. AM-7', description: "Placeholder of the card dialog's Related box: cards by name (AM-7 is an example: a project key, a hyphen and a number)." }))} value={links} readOnly={ro} onChange={(e) => setLinks(e.target.value)} />
          <label>{tr(msg({ id: 'board.dialog.context', defaultMessage: 'Read first', description: "A field label in the card dialog (#818): doc sections the card's agent reads before starting, given in its start prompt." }))}</label>
          <div className="task-context">
            <textarea
              className="input"
              rows={Math.min(4, Math.max(1, splitDocRefs(context).length))}
              placeholder={tr(msg({ id: 'board.dialog.contextPlaceholder', defaultMessage: 'Doc sections, one a line: docs/PLAN.md#setup, shared:plans/notes.md#open-questions', description: "Placeholder of the card dialog's Read first box (#818): references to doc sections, one a line (keep the examples as they are)." }))}
              value={context}
              readOnly={ro}
              onChange={(e) => setContext(e.target.value)}
            />
            {/* Each reference opens its section in Combwork's viewer (#818). */}
            {splitDocRefs(context).some((r) => parseDocRef(r)) && (
              <div className="task-context-links">
                {splitDocRefs(context)
                  .filter((r) => parseDocRef(r))
                  .map((r) => (
                    <button key={r} className={cx('link-button', broken.some((p) => p.ref === r) && 'broken')} onClick={() => setViewRef(r)}>
                      {r}
                    </button>
                  ))}
              </div>
            )}
            {/* What didn't resolve when it was last checked (saved, or the card started, #819): why, and the closest headings. */}
            {broken.length > 0 && (
              <div className="task-context-problems" role="status">
                {problemLines(broken).map((line) => (
                  <div key={line}>
                    <Icon name="warning" /> {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="task-section-h">
          {tr(msg({ id: 'board.dialog.description', defaultMessage: 'Description', description: "A heading in the card dialog: the card's description." }))}
          <span className="grow" />
          <button className={cx('btn small subtle', !preview && 'active') /* i18n-ignore: class names, not text */} disabled={ro} title={readOnly ?? undefined} onClick={() => setPreview(false)}>
            {tr(msg({ id: 'board.dialog.write', defaultMessage: 'Write', description: "A tab button in the card dialog: edit the description's Markdown." }))}
          </button>
          <button className={cx('btn small subtle', preview && 'active') /* i18n-ignore: class names, not text */} onClick={() => setPreview(true)}>
            {tr(msg({ id: 'board.dialog.preview', defaultMessage: 'Preview', description: 'A tab button in the card dialog: show the description as it reads (Markdown rendered).' }))}
          </button>
        </div>
        {preview ? (
          <div className="task-description" onDoubleClick={() => !ro && setPreview(false)}>
            {description.trim() ? <Markdown source={withAttachmentUrls(description, lookup)} cards={MARKDOWN_CARDS} onLink={onAttachmentLink} images={attachmentImages} /> : <span className="faint">{tr(msg({ id: 'board.dialog.noDescription', defaultMessage: 'No description. Double-click to write one.', description: "The card dialog's description preview when there is none." }))}</span>}
          </div>
        ) : (
          <textarea className="input task-description-input" placeholder={tr(msg({ id: 'board.dialog.descriptionPlaceholder', defaultMessage: "What to do, and how to tell it's done (Markdown). Whoever starts the card reads only this.", description: "Placeholder of the card dialog's description box." }))} value={description} readOnly={ro} title={readOnly ?? undefined} onChange={(e) => setDescription(e.target.value)} {...(ro ? {} : attach.boxProps('description', description, setDescription))} />
        )}
        <DraftChips box="description" drafts={attach.drafts.description} onRemove={(key) => attach.remove('description', key, description, setDescription)} />
        {card && <CardAttachmentList card={card} label={cardLabel(card)} list={files.list} reload={files.reload} readOnly={ro} />}
        {card && (
          <>
            <Decisions card={card} draft={decision} setDraft={setDecision} editing={decisionEdit} setEditing={setDecisionEdit} setBusy={setDecisionBusy} readOnly={readOnly} />
            <CardWork card={card} />
            <div className="task-section-h">{tr(msg({ id: 'board.dialog.comments', defaultMessage: 'Comments ({n})', description: "A heading in the card dialog: the card's comments, and how many ({n})." }), { n: card.comments.length })}</div>
            {card.comments.map((c, i) => (
              <div key={i} className="task-comment">
                <div className="task-comment-by">
                  <strong>{byText(c.by)}</strong> <span className="faint">{timeAgo(c.at)}</span>
                </div>
                <Markdown source={withAttachmentUrls(storedLine(c.text, c.appText), lookup)} cards={MARKDOWN_CARDS} onLink={onAttachmentLink} images={attachmentImages} />
              </div>
            ))}
            {!card.archived && (
              <div className="task-comment-new">
                <textarea className="input" aria-label={tr(msg({ id: 'board.dialog.newComment', defaultMessage: 'New comment', description: 'Accessible name of the box where a comment is written (card dialog).' }))} placeholder={tr(msg({ id: 'board.dialog.commentPlaceholder', defaultMessage: 'Add a comment', description: "Placeholder of the card dialog's comment box." }))} title={readOnly ?? undefined} disabled={ro} value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void addComment()} {...(ro ? {} : attach.boxProps('comment', comment, setComment))} />
                <DraftChips box="comment" drafts={attach.drafts.comment} onRemove={(key) => attach.remove('comment', key, comment, setComment)} />
                <div className="task-new-actions">
                  {comment.trim() && <span className="faint">{tr(msg({ id: 'board.dialog.savePostsIt', defaultMessage: 'Save posts it too', description: "Beside the Comment button once something is written: the card dialog's Save button posts the comment as well." }))}</span>}
                  <Tooltip content={readOnly}>
                  <BusyButton className={cx('small', comment.trim() && 'primary')} busy={action.busy === 'comment'} busyLabel={tr(msg({ id: 'board.dialog.posting', defaultMessage: 'Posting…', description: 'The Comment button while the comment is being posted.' }))} disabled={!comment.trim() || ro} onClick={() => void addComment()}>
                    <Icon name="comment" /> {tr(msg({ id: 'board.dialog.comment', defaultMessage: 'Comment', description: 'Button in the card dialog: posts the comment written above.' }))}
                  </BusyButton>
                  </Tooltip>
                </div>
              </div>
            )}
            <div className="task-section-h clickable" data-section="history" onClick={() => setShowHistory(!showHistory)}>
              <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} /> {tr(msg({ id: 'board.dialog.history', defaultMessage: 'History ({n})', description: "A heading in the card dialog (click to show or hide): the card's history of changes, and how many entries ({n})." }), { n: card.history.length })}
            </div>
            {showHistory && (
              <div className="task-history">
                {[...card.history].reverse().map((h, i) => (
                  <div key={i}>
                    <span className="faint">{formatDateTime(h.at)}</span> <strong>{byText(h.by)}</strong> {storedLine(h.what, h.whatText)}
                  </div>
                ))}
              </div>
            )}
            <CardCostLine card={card} />
            <div className="faint task-created">
              {card.createdBy
                ? tr(msg({ id: 'board.dialog.added', defaultMessage: '{who, select, you {Added by you} assistant {Added by the Assistant} repair {Added by Repair} other {Added by {by}}} {added} · changed {changed}', description: "At the foot of the card dialog: who added the card ({who}: you, the user; assistant, the Combwork Assistant; repair, Combwork's Repair, which gives cards back to a moved project; other: an agent, {by} its name), when ({added}: \"3 days ago\"), and when it last changed ({changed})." }), { who: addedBy(card.createdBy), by: card.createdBy, added: timeAgo(card.createdAt), changed: timeAgo(card.updatedAt) })
                : tr(msg({ id: 'board.dialog.addedUnknown', defaultMessage: 'Added by unknown {added} · changed {changed}', description: "At the foot of the card dialog when who added the card isn't known: when it was added ({added}: \"3 days ago\") and last changed ({changed})." }), { added: timeAgo(card.createdAt), changed: timeAgo(card.updatedAt) })}
            </div>
          </>
        )}
      </Modal>
      {viewRef && <DocRefViewer projectPath={projects.find((p) => p.name === project)?.path ?? null} docRef={viewRef} onClose={() => setViewRef(null)} onOpen={(go) => void tryClose().then((closed) => closed && go())} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Start: which agent the card goes to.
// ---------------------------------------------------------------------------

type StartChoice = { kind: 'agent'; id: string } | { kind: 'new' } | { kind: 'worktree' }

/** An agent that can take a card now: stopped, or running and idle (Start checks again). */
const freeAgent = (a: AgentInfo): boolean => !a.live || a.live.status === 'ready' || a.live.status === 'finished' || a.live.status === 'stopped'

/**
 * Who starts a card, as the Start and Move to Doing dialogs ask it: an existing agent that can take it (the card's
 * own first), a new agent, or a new agent in its own worktree. Agents are as the window knows them now, so one that
 * gets busy while the dialog is open can no longer be chosen (and Start refuses it in any case).
 */
function useStartPick(project: ProjectInfo | null) {
  const settings = useStore((s) => s.settings)
  // Git that can't run makes no worktree, whatever the project folder holds (#346).
  const gitProblem = useStore((s) => gitProblemText(s.gitTool))
  const worktreeWhy = !project ? null : gitProblem ? `${gitProblem}.` : project.isGitRepo ? null : tr(msg({ id: 'board.start.notGit', defaultMessage: 'The project is not a git repository.', description: 'Why a card cannot start on a new agent in its own worktree (the Start dialog): the project has no git repository.' }))
  const [choice, setChoice] = useState<StartChoice | null>(null)
  const [name, setName] = useState('')
  // A new agent's connection (HI-2121, decision A): its id, the first usable in the order of accounts until the user
  // chooses one; '' while none is (yet). Its CLI follows from it, as in Add Agent.
  const [connection, setConnection] = useState('')
  const [connectionChosen, setConnectionChosen] = useState(false)
  const view = useConnections()
  const providers = useStore((s) => s.providers)
  const firstReady = firstReadyConnection(view, settings, cliReadyOf(providers))
  useEffect(() => {
    if (!connectionChosen) setConnection(firstReady.id ?? '')
  }, [connectionChosen, firstReady.id])
  const usable = (a: AgentInfo): boolean => !!project && freeAgent(a) && isProviderEnabled(settings, agentProviderOf(a))
  /** Back to the first choice: the card's own agent if it can take it, else the first that can, else a new agent. */
  const reset = (agentId: string | null): void => {
    const mine = agentId && project ? project.agents.find((a) => a.id === agentId) : null
    const first = mine && usable(mine) ? mine : project?.agents.find(usable)
    setChoice(first ? { kind: 'agent', id: first.id } : { kind: 'new' })
    setName('')
    setConnectionChosen(false)
    setConnection(firstReady.id ?? '')
  }
  const chooseConnection = (id: string): void => {
    setConnectionChosen(true)
    setConnection(id)
  }
  // A new agent waits for the automatic choice while connections are offered here (Add Agent's rule, HI-2108 round 2);
  // with none offered at all, main picks as before accounts.
  const unresolved = !connection && offeredConnections(view, settings).length > 0
  const chosen = choice?.kind === 'agent' ? (project?.agents.find((a) => a.id === choice.id) ?? null) : null
  const ready = !!project && !!choice && (choice.kind === 'agent' ? !!chosen && usable(chosen) : !unresolved && (choice.kind === 'new' || !worktreeWhy))
  const target = (): TaskStartTarget =>
    choice?.kind === 'agent' ? { kind: 'agent', agentId: choice.id } : { kind: 'new-agent', worktree: choice?.kind === 'worktree', name: name.trim() || undefined, connection: connection || undefined }
  return { settings, choice, setChoice, name, setName, connection, chooseConnection, checking: !connection && firstReady.checking, reset, ready, target, worktreeWhy }
}

type StartPick = ReturnType<typeof useStartPick>

function StartChoices({ project, pick }: { project: ProjectInfo; pick: StartPick }) {
  const { settings, choice, setChoice, name, setName, connection, chooseConnection, checking, worktreeWhy } = pick
  return (
    <>
      <div className="choice-list">
        {project.agents.map((a) => {
          const p = agentProviderOf(a)
          const enabled = isProviderEnabled(settings, p)
          const ok = enabled && freeAgent(a)
          return (
            <label key={a.id} className={cx('choice', choice?.kind === 'agent' && choice.id === a.id && 'selected', !ok && 'disabled')}>
              <input type="radio" disabled={!ok} checked={choice?.kind === 'agent' && choice.id === a.id} onChange={() => setChoice({ kind: 'agent', id: a.id })} />
              <div>
                <strong>
                  <ProviderIcon provider={p} /> {a.name}
                </strong>
                <div className="faint">
                  {!enabled
                    ? tr(msg({ id: 'board.start.providerOff', defaultMessage: '{provider} is turned off.', description: "Under an agent in the Start dialog that can't take the card: its CLI ({provider}: Claude Code, Codex…) is turned off in Settings." }), { provider: providerName(p) })
                    : a.live
                      ? freeAgent(a)
                        ? tr(msg({ id: 'board.start.idle', defaultMessage: '{status}: gets the card as its next message.', description: "Under an idle agent in the Start dialog: what it is doing ({status}: \"Ready\", \"Finished\"), and that the card is typed to it next." }), { status: statusText(a.live) })
                        : tr(msg({ id: 'board.start.busy', defaultMessage: "{status}. Choose it once it's idle.", description: "Under a busy agent in the Start dialog, which can't take the card yet: what it is doing ({status}: \"Working\")." }), { status: statusText(a.live).replace(/…$/, '') })
                      : tr(msg({ id: 'board.start.stopped', defaultMessage: 'Stopped: starts a new conversation on the card.', description: 'Under a stopped agent in the Start dialog: starting the card starts it with a new conversation.' }))}
                </div>
              </div>
            </label>
          )
        })}
        <label className={cx('choice', choice?.kind === 'new' && 'selected')}>
          <input type="radio" checked={choice?.kind === 'new'} onChange={() => setChoice({ kind: 'new' })} />
          <div>
            <strong>
              <Icon name="add" /> {tr(msg({ id: 'board.start.newAgent', defaultMessage: 'A new agent', description: 'A choice in the Start dialog: the card starts on a new agent of the project.' }))}
            </strong>
            <div className="faint">{tr(msg({ id: 'board.start.newAgentText', defaultMessage: 'Works in the project folder, next to the others.', description: 'Under "A new agent" in the Start dialog.' }))}</div>
          </div>
        </label>
        <label className={cx('choice', choice?.kind === 'worktree' && 'selected', !!worktreeWhy && 'disabled')}>
          <input type="radio" disabled={!!worktreeWhy} checked={choice?.kind === 'worktree'} onChange={() => setChoice({ kind: 'worktree' })} />
          <div>
            <strong>
              <Icon name="git-branch" /> {tr(msg({ id: 'board.start.worktreeAgent', defaultMessage: 'A new agent in its own worktree', description: 'A choice in the Start dialog: the card starts on a new agent with its own git worktree (branch and folder).' }))}
            </strong>
            <div className="faint">{worktreeWhy ?? tr(msg({ id: 'board.start.worktreeText', defaultMessage: 'Its own branch and folder; merge its work back when the card is done.', description: 'Under "A new agent in its own worktree" in the Start dialog.' }))}</div>
          </div>
        </label>
      </div>
      {(choice?.kind === 'new' || choice?.kind === 'worktree') && (
        <div className="agent-form nested">
          <label>{tr(msg({ id: 'board.start.name', defaultMessage: 'Name', description: "A field label in the Start dialog: the new agent's name." }))}</label>
          <input className="input" placeholder={tr(msg({ id: 'board.start.namePlaceholder', defaultMessage: 'Default: Agent n', description: "Placeholder of the new agent's name in the Start dialog: left empty, it is named Agent and a number." }))} value={name} onChange={(e) => setName(e.target.value)} />
          {/* Its connection holds its model, effort, context and mode; its CLI follows from it (HI-2121). */}
          <ConnectionChoice id="start-agent-connection" value={connection} onChange={chooseConnection} />
          {checking && (
            <div className="hint span2" data-connection-checking>
              <Icon name="loading" spin /> {tr(msg({ id: 'board.start.checkingConnection', defaultMessage: 'Finding out which coding agents are installed, to choose the first connection that can run…', description: "Under the new agent's choice of connection in the Start dialog (HI-2121) while Combwork still looks for the installed coding agent CLIs: the first usable connection is chosen once it knows; Start waits until then." }))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Starts a card (the Start and Move to Doing dialogs) and says so, with Show. A start that skips rules asks first
 * (#1275), before any agent is added or anything launched: false when the user cancels (nothing done).
 */
async function startCard(card: TaskCard, project: ProjectInfo, target: TaskStartTarget): Promise<boolean> {
  let r = await call('tasks:start', card.number, target)
  if ('ask' in r) {
    const reason = await askToSkip(cardLabel(card), 'doing', r.ask)
    if (reason === null) return false
    r = await call('tasks:start', card.number, target, { confirm: true, ...(reason.trim() ? { reason: reason.trim() } : {}) })
    if ('ask' in r) return false
  }
  notify('success', tr(msg({ id: 'board.start.started', defaultMessage: '{card} started on agent {agent}', description: "A toast's title after a card started: its name: its key, such as AM-12, or #12 for a card with none and the agent ({agent}, its name). The card's title follows. A noun before the name (glossary §1 rule 4)." }), { card: cardLabel(card), agent: r.agentName }), card.title, [{ label: tr(msg({ id: 'board.start.show', defaultMessage: 'Show', description: "A button on the toast after a card started: shows the agent it started on." })), command: 'agent.show', args: [project.path, r.agentId] }])
  return true
}

export function TaskStartDialog() {
  const n = useStore((s) => s.taskStartFor)
  const card = useStore((s) => s.tasks.find((c) => c.number === s.taskStartFor) ?? null)
  const project = useStore((s) => (card ? (s.workspace?.projects.find((p) => p.name.toLowerCase() === card.project.toLowerCase()) ?? null) : null))
  const pick = useStartPick(project)
  const action = useBusy()
  const { setError: setStartError } = action
  useLanguage()

  useEffect(() => {
    if (n === null || !project) return
    pick.reset(card?.agent ?? null)
    setStartError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n])

  if (n === null || !card) return null
  const close = (): void => set({ taskStartFor: null })
  if (!project) {
    return (
      <Modal
        title={tr(msg({ id: 'board.start.titleShort', defaultMessage: 'Start {card}', description: "Title of the Start dialog when the card can't start: {card} is its name: its key, such as AM-12, or #12 for a card with none." }), { card: cardLabel(card) })}
        icon="play"
        onClose={close}
        footer={
          <button className="btn primary" onClick={close}>
            {tr(msg({ id: 'board.start.ok', defaultMessage: 'OK', description: 'Button: closes the Start dialog of a card that has no project.' }))}
          </button>
        }
      >
        <p>
          {card.project ? tr(msg({ id: 'board.start.projectGone', defaultMessage: "{project} isn't a project in this workspace.", description: "Why a card can't start: its project ({project}) isn't in the workspace." }), { project: card.project }) : tr(msg({ id: 'board.start.noProject', defaultMessage: 'The card has no project.', description: "Why a card can't start: it belongs to no project." }))} {tr(NEEDS_PROJECT)}
        </p>
      </Modal>
    )
  }

  const go = async (): Promise<void> => {
    if (!pick.ready) return
    // The dialog stays open (no closing, a spinner) until the agent has the card; a failure shows here. A start the
    // user cancelled at its question (#1275) leaves it open, nothing done.
    let started = false
    const r = await action.run('start', async () => {
      started = await startCard(card, project, pick.target())
    })
    if (!r || !started) return
    close()
    set({ taskOpen: null })
    await loadTasks()
  }

  return (
    <Modal
      title={tr(msg({ id: 'board.start.title', defaultMessage: 'Start {card}: {title}', description: "Title of the Start dialog: the card’s name: its key, such as AM-12, or #12 for a card with none and title." }), { card: cardLabel(card), title: card.title })}
      icon="play"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(CANCEL)}
          </button>
          <BusyButton className="primary" busy={action.busy === 'start'} busyLabel={pick.choice?.kind === 'worktree' ? tr(CREATING_WORKTREE) : tr(STARTING)} disabled={!pick.ready} onClick={() => void go()}>
            <Icon name="play" /> {action.error ? tr(TRY_AGAIN) : tr(START)}
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{tr(msg({ id: 'board.start.intro', defaultMessage: 'The agent gets the card as its prompt (title and description), and the card moves to Active. A stopped agent starts a new conversation; an idle one gets it as its next message.', description: 'At the top of the Start dialog. Active is a board column.' }))}</p>
      <StartChoices project={project} pick={pick} />
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Move to Doing: nobody yet, an agent, or an agent that starts on it.
// ---------------------------------------------------------------------------

type DoingMode = 'nobody' | 'assign' | 'start'

const doingProject = (req: DoingRequest): ProjectInfo | null => (req.project ? (get().workspace?.projects.find((p) => p.name.toLowerCase() === req.project.toLowerCase()) ?? null) : null)

/**
 * Moves a card into Doing from another column the way the user means it: the Move to Doing dialog asks (nobody yet,
 * an agent, or an agent that starts on it). A card with no project in this workspace can only go there with its
 * agent as it is, so it moves at once. Reordering within Doing never comes here.
 */
export function moveToDoing(req: DoingRequest): void {
  if (doingProject(req)) return set({ taskDoing: req })
  void (async () => {
    try {
      await req.prepare?.()
      if (await moveCard({ number: req.n, project: req.project }, 'doing', req.before !== undefined ? { before: req.before } : {})) req.done?.()
    } catch (e) {
      notify('error', tr(MOVE_FAILED), errorMessage(e))
      await loadTasks()
    }
  })()
}

export function MoveToDoingDialog() {
  const req = useStore((s) => s.taskDoing)
  const card = useStore((s) => (s.taskDoing ? (s.tasks.find((c) => c.number === s.taskDoing!.n) ?? null) : null))
  const project = useStore((s) => (s.taskDoing?.project ? (s.workspace?.projects.find((p) => p.name.toLowerCase() === s.taskDoing!.project.toLowerCase()) ?? null) : null))
  const [mode, setMode] = useState<DoingMode>('nobody')
  const [assignee, setAssignee] = useState('')
  const pick = useStartPick(project)
  const action = useBusy()
  const { setError } = action
  useLanguage()

  useEffect(() => {
    if (!req) return
    // The card's agent (or the one the card editor has) is the default: assigned, nothing started.
    const own = req.agent && project?.agents.some((a) => a.id === req.agent) ? req.agent : null
    setMode(own ? 'assign' : 'nobody')
    setAssignee(own ?? project?.agents[0]?.id ?? '')
    pick.reset(own)
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  if (!req || !card || !project) return null
  const close = (): void => set({ taskDoing: null })
  const assignable = project.agents.some((a) => a.id === assignee)
  const ready = mode === 'nobody' || (mode === 'assign' ? assignable : pick.ready)
  const before = req.before !== undefined ? { before: req.before } : {}
  const holder = req.agent ? (project.agents.find((a) => a.id === req.agent)?.name ?? card.agentName ?? tr(ITS_AGENT)) : null

  const go = async (): Promise<void> => {
    if (!ready) return
    let moved = true
    const r = await action.run(mode, async () => {
      await req.prepare?.()
      if (mode === 'start') {
        // Cancelled at its question (#1275): nothing done, the card where it was.
        if (!(await startCard(card, project, pick.target()))) {
          moved = false
          return
        }
        // Start doesn't place the card: where it was dropped, if it still can be (the order only).
        if (req.before !== undefined) await call('tasks:update', card.number, before).catch(() => undefined)
      } else if (!(await moveCard(card, 'doing', { agent: mode === 'assign' ? assignee : null, ...before, rethrow: true }))) {
        // Cancelled or refused (its toast says why): the dialog closes, the card where the move left it.
        moved = false
      }
    })
    if (!r) return
    close()
    if (!moved) return
    await loadTasks()
    req.done?.()
  }

  const row = (m: DoingMode, icon: string, title: string, text: string, disabled = false) => (
    <label className={cx('choice', mode === m && 'selected', disabled && 'disabled')}>
      <input type="radio" name="doing-mode" disabled={disabled} checked={mode === m} onChange={() => setMode(m)} />
      <div>
        <strong>
          <Icon name={icon} /> {title}
        </strong>
        <div className="faint">{text}</div>
      </div>
    </label>
  )
  const label = action.error ? tr(TRY_AGAIN) : mode === 'start' ? tr(START) : tr(msg({ id: 'board.doing.button', defaultMessage: 'Move to Active', description: 'The Move to Active dialog\'s button: moves the card into the Active column (a board column).' }))

  return (
    <Modal
      title={tr(msg({ id: 'board.doing.title', defaultMessage: 'Move {card} to Active', description: 'Title of the Move to Active dialog: {card} is the card\'s name: its key, such as AM-12, or #12 for a card with none. Active is a board column.' }), { card: cardLabel(card) })}
      icon="arrow-right"
      onClose={close}
      busy={!!action.busy}
      error={action.error}
      footer={
        <>
          <button className="btn subtle" onClick={close}>
            {tr(CANCEL)}
          </button>
          <BusyButton className="primary" busy={!!action.busy} busyLabel={mode === 'start' ? (pick.choice?.kind === 'worktree' ? tr(CREATING_WORKTREE) : tr(STARTING)) : tr(msg({ id: 'board.doing.moving', defaultMessage: 'Moving…', description: 'The Move to Doing button while the card is being moved.' }))} disabled={!ready} onClick={() => void go()}>
            {mode === 'start' && <Icon name="play" />} {label}
          </BusyButton>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        <strong>{card.title}</strong> · {project.name}
      </p>
      <div className="choice-list doing-modes">
        {row('nobody', 'circle-large-outline', tr(NOBODY_YET), holder ? tr(msg({ id: 'board.doing.nobodyFrom', defaultMessage: 'Moves it with no agent. Takes it from {agent}.', description: 'Under "Nobody yet" in the Move to Doing dialog, when the card has an agent ({agent}, its name).' }), { agent: holder }) : tr(msg({ id: 'board.doing.nobody', defaultMessage: 'Moves it with no agent.', description: 'Under "Nobody yet" in the Move to Doing dialog.' })))}
        {row('assign', 'person', tr(msg({ id: 'board.doing.assign', defaultMessage: 'Assign an agent', description: 'A choice in the Move to Doing dialog: give the card to an agent without starting anything.' })), project.agents.length ? tr(msg({ id: 'board.doing.assignText', defaultMessage: 'Gives it to an agent of the project. Nothing is sent to the agent and nothing starts.', description: 'Under "Assign an agent" in the Move to Doing dialog.' })) : tr(msg({ id: 'board.doing.noAgents', defaultMessage: 'The project has no agents yet.', description: 'Under "Assign an agent" in the Move to Doing dialog (off) when the project has no agents.' })), !project.agents.length)}
        {mode === 'assign' && (
          <div className="agent-form nested doing-sub">
            <label>{tr(msg({ id: 'board.doing.agent', defaultMessage: 'Agent', description: 'A field label in the Move to Doing dialog: which agent gets the card.' }))}</label>
            <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {project.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {tr(msg({ id: 'board.doing.agentStatus', defaultMessage: '{agent} ({status})', description: "An agent in the Move to Doing dialog's agent choice, with what it is doing ({status}: \"Working…\", \"Stopped\")." }), { agent: a.name, status: a.live ? statusText(a.live) : tr(msg({ id: 'board.doing.stopped', defaultMessage: 'Stopped', description: "An agent's state in the Move to Doing dialog's agent choice: its session isn't running." })) })}
                </option>
              ))}
            </select>
          </div>
        )}
        {row('start', 'play', tr(msg({ id: 'board.doing.start', defaultMessage: 'Assign and start', description: 'A choice in the Move to Doing dialog: give the card to an agent and start it on the card.' })), tr(msg({ id: 'board.doing.startText', defaultMessage: 'The agent gets the card as its prompt: a stopped one starts a new conversation, an idle one gets it as its next message.', description: 'Under "Assign and start" in the Move to Doing dialog.' })))}
        {mode === 'start' && (
          <div className="doing-sub">
            <StartChoices project={project} pick={pick} />
          </div>
        )}
      </div>
    </Modal>
  )
}
