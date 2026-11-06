import { basename, join } from 'path'
import { projectAgents } from '../shared/defaults'
import { agentRuntime } from '../shared/runtime'
import { REVIEW_WAIT_STALL_MS, backgroundTaskMinutes, builderJobOf, columnSince, laneOrderWaitReason, loopStepWaitReason, notWatchingReason, pendingDesign, reviewVerdictWaitReason, reviewWaitReason, stalledReason, startFailedReason, startWaitingReason, type BuilderJob, type LaneOrderView, type ReviewOwed, type StallAgent } from '../shared/tasks'
import { agentWorkflowRole, reviewsWork } from '../shared/workflow/roles'
import { poolReviewerOf } from './loopReviewer'
import { FactStore } from './workflow/factStore'
import { advanced } from './advanced'
import { WORKFLOW_ENFORCE } from '../shared/advanced'
import type { AgentInfo, AgentStart, DueDeps, LaneStatus, ProgressRun, TaskCard } from '../shared/types'
import { LOOP_STEP_WAIT_MINUTES, laneStatusText } from '../shared/lanes'
import { forYouOfCards } from './workflow/cardWork'
import { projectPreferences } from './workflow/preferences'
import { queueReturnOf, staleApprovalOf } from './queueReturn'
import { isResuming } from './restartResume'
import { startNow, startSeq } from './agentStarts'
import { sessions } from './sessions'
import { workspaceOf, type WorkspaceService } from './workspace'
import { config } from './config'
import { pausedFor, resumedAt } from './teamPause'
import { IDLE_WATCH_STALL_MS, idleWatchReason, nothingWaitsOn } from '../shared/idleWatch'
import { agentMsg, say } from '../shared/agentText'

/** Why a lane's next card is stalled once the cards it depends on are Done (HI-2618). Agent-facing. */
const DEPS_DONE = agentMsg({ id: 'stall.laneNext.depsDone', text: "{card} is the lane's next card: the last of the cards it depends on went Done {minutes} min ago, and {doing}", note: "The Agent API's and lane watches' stalled (HI-2618): a lane's next card whose dependencies are all Done, not started since. card: its key; minutes: how long since the last of them went Done; doing: what its builder does, a sentence (\"B1 is only watching without starting it.\")." })

/**
 * Why a card is stalled, in one place (the Agent API's `stalled`, and lane watches, #531): a Doing card nobody works on
 * (its agent gone or not running), a card an agent in a card loop left with no watch (#376), or one waiting in Review on
 * a reviewer that watches it but hasn't started (#521), or on one that started and only watches it, with no verdict (#843),
 * or one whose lane is deadlocked, its reviewer waiting for another of its cards while its builder waits on it (#1410),
 * or a card whose builder waits on a check nobody gives: of its design in Doing (#1382), or of its follow-up in Review or
 * Passed (#1467), or a card the merge queue returned that its builder, idle or only watching, hasn't taken up (HI-1721),
 * or a running lane's next card its builder, idle, only watching or not running, hasn't started (HI-1741), or a card in
 * Review whose reviewer has waited minutes for a review copy (HI-1764).
 * Null when it isn't.
 */

/**
 * Why a card's review has waited too long for a review copy (HI-1764), given by reviewCopies.ts as it loads: imported
 * here, it brought copiesApp, slotsApp and windows into everything that reads a card's stall (HI-1785).
 */
let reviewCopyWaitReason: ((c: TaskCard, wsPath: string | null) => string | null) | null = null
export function setReviewCopyWaitReason(fn: typeof reviewCopyWaitReason): void {
  reviewCopyWaitReason = fn
}

/**
 * A workspace's Progress runs (by its folder), given by the app as it starts (progressService brings in the windows):
 * a review waiting on its builder's run for the card isn't stalled (HI-1993). None in unit tests.
 */
let runsOf: ((wsPath: string) => ProgressRun[]) | null = null
export function setStallRuns(fn: typeof runsOf): void {
  runsOf = fn
}

/** How long a card the merge queue returned waits in Doing, its builder idle or watching, before it is stalled (HI-1721). */
export const RETURN_STALL_MS = 15 * 60_000

/**
 * Why a card the merge queue returned to its builder is stalled (HI-1721), or null: in Doing, not blocked, unchanged for
 * RETURN_STALL_MS since it came back, and its builder not in a turn (idle, or only watching: HB2 watched
 * HI-1694 for Done for three hours while it waited for HB2). A builder not running is stalledReason's. Agent-facing.
 */
export function returnedWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked' | 'updatedAt'>, returned: { at: string } | null | undefined, builder: { name: string; status: string; watching: boolean } | null, now = Date.now()): string | null {
  if (!returned || !builder || c.archived || c.blocked || c.column !== 'doing') return null
  // Its turn's state decides (HR1's round 1): a watch kept while it works (a loop wake leaves it running) is no stall;
  // the watch only words it.
  if (!IDLE.includes(builder.status)) return null
  const since = Math.max(Date.parse(returned.at) || 0, Date.parse(c.updatedAt) || 0)
  if (!since || now - since < RETURN_STALL_MS) return null
  const min = Math.round((now - since) / 60_000)
  const name = c.key ?? `#${c.number}`
  return `${name} came back from the merge queue ${min} min ago; ${builder.name} is ${builder.watching ? 'only watching it' : 'idle'}, not fixing it.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** How long an approved card with a stale pass waits, its builder idle or watching, before it is stalled (HI-1763). */
export const STALE_STALL_MS = 10 * 60_000

/**
 * Why an approved card whose pass went stale is stalled (HI-1763), or null: in Passed (Approved), not blocked, stale for
 * STALE_STALL_MS since its `Stale` fact (a stable start: nothing later moves it), and its builder not in a turn (idle,
 * or only watching; a watch kept while it works isn't a stall). Agent-facing.
 */
export function staleWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked'>, stale: { since: string; approved: string | null; current: string | null } | null | undefined, builder: { name: string; status: string; watching: boolean } | null, now = Date.now()): string | null {
  if (!stale || !builder || c.archived || c.blocked || c.column !== 'passed') return null
  if (!IDLE.includes(builder.status)) return null
  const since = Date.parse(stale.since) || 0
  if (!since || now - since < STALE_STALL_MS) return null
  const name = c.key ?? `#${c.number}`
  const rev = (r: string | null): string => (r ? r.slice(0, 7) : '—')
  return `${name}'s pass is for ${rev(stale.approved)} but its line is at ${rev(stale.current)}; ${builder.name} is ${builder.watching ? 'only watching it' : 'idle'}, not submitting it.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** A builder's statuses with no turn going (watching counts too: returnedWaitReason). */
const IDLE = ['ready', 'finished', 'watching']

/**
 * Why a card in Review is stalled on its reviewer after its builder's reply (HI-2428), or null: the builder replied to
 * it ("Replied to the reviewer", HI-2302), and since then, for REVIEW_WAIT_STALL_MS, nobody has moved: its reviewer (the
 * review started on it) has written nothing on the card and isn't in a turn, watching or not; nor is its builder; and no
 * job of the builder's for the card is running (`job`, builderJobOf: the clock starts again from its end). On HI-2410 a
 * pool reviewer with no watch of its own asked its builder for a full run and sat idle for seven hours after the answer;
 * #843's check counts only a reviewer that watches. While the builder works on what was asked it isn't the reviewer's
 * stall: so its own reply ("running it now") starts nothing until it, too, is idle. Agent-facing.
 */
export function replyWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked' | 'project' | 'review' | 'history' | 'comments'>, reviewer: { name: string; status: string } | null, builder: { status: string } | null, job?: BuilderJob | null, now = Date.now()): string | null {
  if (!c.review || !reviewer || c.archived || c.blocked || c.column !== 'review' || job?.running) return null
  if (!IDLE.includes(reviewer.status) || (builder && !IDLE.includes(builder.status))) return null
  const reply = c.history.findLast((h) => /^Replied to the reviewer\b/.test(h.what))
  if (!reply) return null
  // Its board name, as its lines and comments are signed ("R1 (alpha)").
  const names = new Set([c.review.agentName, reviewer.name].flatMap((n) => (n ? [n.toLowerCase(), `${n} (${c.project})`.toLowerCase()] : [])))
  const by = (x: { at: string; by: string }): boolean => x.at > reply.at && names.has(x.by.toLowerCase())
  if (c.history.some(by) || c.comments.some(by)) return null
  const since = Math.max(Date.parse(reply.at) || 0, job?.endedAt ?? 0)
  if (!since || now - since < REVIEW_WAIT_STALL_MS) return null
  const min = Math.round((now - since) / 60_000)
  return `${c.key ?? `#${c.number}`}'s builder replied to ${reviewer.name} ${min} min ago; ${reviewer.name} is ${reviewer.status === 'watching' ? 'only watching' : 'idle'}, with no verdict or answer since.` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** How long a running lane's next card waits in Todo after the card before it is Done, its builder idle (HI-1741). */
export const LANE_NEXT_STALL_MS = 15 * 60_000

/**
 * Why a running lane's next card is stalled (HI-1741), or null: in Todo, not blocked, every card before it in the lane
 * Done, the last of them Done for LANE_NEXT_STALL_MS, and the lane's builder not in a turn (idle, only watching, or not
 * running: HB3 read HI-1727's Done and ended its turn without starting HI-1735, and the lane sat for two hours). A
 * paused lane's isn't, nor one whose start waits for a card it depends on to be Done (HI-2129), nor one with a card it
 * depends on not Done on the board (HI-2618, `due`: then counted from the last of them going Done). `builder`: the lane's builder as it is now (null: not running and not about to resume, else
 * its name and status). Agent-facing.
 */
export function laneNextWaitReason(c: Pick<TaskCard, 'number' | 'key' | 'column' | 'archived' | 'blocked'>, lane: LaneOrderView | null | undefined, builder: { name: string; status: string | null }, now = Date.now()): string | null {
  if (!lane || lane.state === 'paused' || c.archived || c.blocked || c.column !== 'todo') return null
  // Waiting for a card it depends on to be Done (HI-2129): Combwork starts it then, so its builder has nothing to do yet.
  if (lane.waitsForDependency?.card === c.number) return null
  // Waiting on the cards it depends on, as the board has them (HI-2618: HB6's HI-2616 was reported stalled 29 times while
  // its three dependencies were still in other lanes), whatever the lane-start look last said.
  const due = lane.due?.card === c.number ? lane.due : null
  if (due?.open.length) return null
  const at = lane.cards.findIndex((x) => x.number === c.number)
  if (at < 0 || lane.cards.slice(0, at).some((x) => x.column !== 'done')) return null
  if (builder.status !== null && !IDLE.includes(builder.status)) return null
  // Its first card (HI-2029): since the lane started; a later one, since the card before it went Done.
  const before = at > 0 ? lane.cards[at - 1] : null
  // Once its dependencies are all Done, from when the last of them went Done if that was later (HI-2618).
  const prior = Date.parse((before ? before.movedAt : lane.startedAt) ?? '') || 0
  const ready = Date.parse(due?.readyAt ?? '') || 0
  const since = Math.max(prior, ready)
  if (!since || now - since < LANE_NEXT_STALL_MS) return null
  const min = Math.round((now - since) / 60_000)
  const name = (x: { number: number; key?: string }): string => x.key ?? `#${x.number}`
  const doing = `${builder.name} ${builder.status === null ? "isn't running" : builder.status === 'watching' ? 'is only watching' : 'is idle'} without starting it.` // i18n-ignore: agent-facing (the Agent API's stalled)
  if (ready > prior) return say(DEPS_DONE, { card: name(c), minutes: String(min), doing })
  return before ? `${name(c)} is the lane's next card: ${name(before)} went Done ${min} min ago, and ${doing}` : `${name(c)} is the lane's first card: the lane started ${min} min ago, and ${doing}` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** A workspace's live agents (by its folder): their names, projects, cards left with no watch, card watches (and since when), and how each is now. */
function liveOf(wsPath: string): { name: string; project: string; agentId: string; notWatching?: number[]; untaken: boolean; cards: number[]; watchSince?: string; watchesMore: boolean; status: string; silentMinutes?: number; backgroundTasks?: number; backgroundEndedAt?: string }[] {
  const ws = wsPath.toLowerCase()
  return sessions
    .liveStates()
    .filter((s) => workspaceOf(s.projectPath).path?.toLowerCase() === ws)
    .map((s) => ({ name: s.agentName ?? s.agentId, project: basename(s.projectPath), agentId: s.agentId, notWatching: s.notWatching, untaken: !!s.untakenLine, cards: s.watch?.cards ?? [], watchSince: s.watch?.since, watchesMore: !!(s.watch?.usage || s.watch?.lanes || s.watch?.agents?.length), status: s.status, silentMinutes: agentRuntime(s).silentMinutes, backgroundTasks: s.backgroundTasks, backgroundEndedAt: s.backgroundEndedAt }))
}

export type { StallAgent }

/**
 * An agent as it is now, for the stall check: running while its session runs, while this run's restart resume will
 * bring it back (HI-1707), and while a start of it is under way (HI-1976: a Start, its slot being prepared and its
 * builder placed, its session spawning); else why its last start failed, if it did.
 */
export function agentNowOf(projectPath: string, agentId: string, name: string): StallAgent {
  const start = startNow(projectPath, agentId)
  // Waiting for its slot (HI-2304): its placement's hold doesn't make it starting, so it says why it waits.
  const running = !!sessions.liveFor(projectPath, agentId) || isResuming(projectPath, agentId) || sessions.startingFor(projectPath, agentId) || (start.starting && !start.waiting)
  return { name, running, ...(!running && start.failed ? { failed: start.failed } : {}), ...(!running && !start.failed && start.waiting ? { waiting: start.waiting } : {}) }
}

/**
 * The agent's start as the window's agent info carries it (HI-1977), so the board's Stalled mark agrees with this check:
 * starting while agentNowOf has it running with no session yet, else why its last start failed.
 */
export function agentStartOf(projectPath: string, agentId: string): AgentStart | undefined {
  const now = agentNowOf(projectPath, agentId, '')
  if (now.failed) return { failed: now.failed }
  if (now.waiting) return { waiting: now.waiting }
  return now.running && !sessions.liveFor(projectPath, agentId) ? { starting: true } : undefined
}

/**
 * A project's agents with their starts (agentStartOf), for its ProjectInfo, each with the count of start changes they
 * were read at (`startSeq`): the window keeps a change it was told later than that (an older read reaching it after).
 */
export function withAgentStarts<T extends { agents: AgentInfo[] }>(projectPath: string, info: T): T {
  const startsAt = startSeq()
  return {
    ...info,
    agents: info.agents.map((a) => {
      const start = agentStartOf(projectPath, a.id)
      return { ...a, startSeq: startsAt, ...(start ? { start } : {}) }
    })
  }
}

/** Whether the card has an open For you request this agent asked (HI-2080): the user's answer is what it waits for. */
function ownQuestionOpen(wsPath: string, c: TaskCard, agentId: string): boolean {
  try {
    return (forYouOfCards(workspaceOf(join(wsPath, c.project)), [c.number]).get(c.number) ?? []).some((r) => r.asker === agentId)
  } catch {
    // The board unreadable now: the stall stands, as before.
    return false
  }
}

/**
 * Why a card is stalled, given its agent as it is now (null: removed; its name, whether it runs, why its start failed),
 * its workspace's folder, its running lane (none: no lane's deadlock is looked for), and how long a design waits for its
 * check (stepWaitMs: its project's workflow option Design check wait, HI-1766), and who owes its review (`due`,
 * reviewDueOf, HI-2636).
 */
export function cardStall(c: TaskCard, agentNow: StallAgent | null, wsPath: string | null, lane?: LaneOrderView | null, stepWaitMs = LOOP_STEP_WAIT_MINUTES * 60_000, returned?: { at: string } | null, stale?: { since: string; approved: string | null; current: string | null } | null, due?: ReviewDue): string | null {
  // Waiting on purpose (HI-2618: HB3 held HI-2590 for a quiet window and was reported stalled four times): what it
  // waits for is said on the card, never a stall, until it is cleared or the card leaves Doing.
  if (c.waitingFor && c.column === 'doing') return null
  // Its team paused (HI-2081): its agents parking (idle, stopped, not watching) is what was asked of them, never a stall.
  // Once it resumes the usual checks apply again, each timed one counted from the resume too (HR1's s12 check): it needs
  // its own wait since then as well as since what it times.
  const at = wsPath && c.project ? join(wsPath, c.project) : null
  if (at && pausedFor(at)) return null
  const resumed = at ? resumedAt(at) : 0
  const waited = (ms: number): boolean => Date.now() - resumed >= ms
  const live = wsPath ? liveOf(wsPath) : []
  const watchers = live.filter((a) => a.cards.length)
  const builder = (returned || stale) && c.agent && c.project ? live.find((a) => a.agentId === c.agent && a.project.toLowerCase() === c.project!.toLowerCase()) : undefined
  const now = builder ? { name: builder.name, status: builder.status, watching: builder.cards.length > 0 } : null
  const back = now ? ((waited(RETURN_STALL_MS) ? returnedWaitReason(c, returned, now) : null) ?? (waited(STALE_STALL_MS) ? staleWaitReason(c, stale, now) : null)) : null
  // A started review's builder's job for the card (HI-1993): only read for a card it could stall.
  const job = c.column === 'review' && c.review && c.agent && wsPath ? builderJobOf(c, runsOf?.(wsPath) ?? [], live.find((a) => a.agentId === c.agent && a.project.toLowerCase() === c.project.toLowerCase()) ?? null, backgroundTaskMinutes(config.settings.agents.backgroundTaskMinutes) * 60_000) : null
  // HI-2080: a reviewer waiting on its own question to the user (For you) isn't stalled for only watching the card; the
  // board is read only for a card that would be.
  const verdictWait = (): string | null => {
    const why = waited(REVIEW_WAIT_STALL_MS) ? reviewVerdictWaitReason(c, watchers, Date.now(), undefined, job) : null
    return why && wsPath && c.review && ownQuestionOpen(wsPath, c, c.review.agent) ? null : why
  }
  // HI-2428: its builder's reply waiting on a reviewer, watching or not, while nobody moves.
  const replyWait = (): string | null => {
    if (!waited(REVIEW_WAIT_STALL_MS) || !c.review) return null
    const of = (id: string) => live.find((a) => a.agentId === id && a.project.toLowerCase() === c.project.toLowerCase())
    const reviewer = of(c.review.agent)
    const why = replyWaitReason(c, reviewer ? { name: reviewer.name, status: reviewer.status } : null, c.agent ? (of(c.agent) ?? null) : null, job)
    return why && wsPath && ownQuestionOpen(wsPath, c, c.review.agent) ? null : why
  }
  return startFailedReason(c, agentNow) ?? startWaitingReason(c, agentNow) ?? stalledReason(c, agentNow) ?? notWatchingReason(c, live.filter((a) => a.notWatching?.length)) ?? back ?? (waited(REVIEW_WAIT_STALL_MS) ? reviewWaitReason(c, watchers, Date.now(), undefined, due?.owed, due?.reviews) : null) ?? verdictWait() ?? replyWait() ?? (waited(REVIEW_WAIT_STALL_MS) ? laneOrderWaitReason(c, lane, watchers) : null) ?? (waited(REVIEW_WAIT_STALL_MS) ? loopStepWaitReason(c, watchers, stepWaitMs) : null) ?? (waited(IDLE_WATCH_STALL_MS) ? idleWatch(c, lane, live, wsPath) : null) ?? (waited(LANE_NEXT_STALL_MS) ? laneNext(c, lane, live, agentNow) : null) ?? reviewCopyWaitReason?.(c, wsPath) ?? null
}

/**
 * HI-2285: a running lane's builder only watching its own card while nothing on it waits on anyone (idleWatchReason); the
 * board's For you items are read only for a card that would be stalled.
 */
function idleWatch(c: TaskCard, lane: LaneOrderView | null | undefined, live: ReturnType<typeof liveOf>, wsPath: string | null): string | null {
  if (!lane || !wsPath || !c.project || !nothingWaitsOn(c, lane.builder, false)) return null
  const watcher = live.find((a) => a.agentId === lane.builder && a.project.toLowerCase() === c.project.toLowerCase())
  const why = idleWatchReason(c, lane, watcher)
  return why && !forYouOpen(wsPath, c) ? why : null
}

/** Whether the card has any open For you request (HI-2285): the user's answer is what it waits on. Unreadable: none. */
function forYouOpen(wsPath: string, c: TaskCard): boolean {
  try {
    return (forYouOfCards(workspaceOf(join(wsPath, c.project)), [c.number]).get(c.number) ?? []).length > 0
  } catch {
    return false
  }
}

/**
 * The lane-next stall (laneNextWaitReason) with its builder as it is: running (live, by the card's project), else not
 * running only as the card's own agent says (agentNow: a builder queued to resume counts as running); unknown: none.
 */
function laneNext(c: TaskCard, lane: LaneOrderView | null | undefined, live: ReturnType<typeof liveOf>, agentNow: StallAgent | null): string | null {
  if (!lane || c.column !== 'todo' || !c.project) return null
  const fresh = freshBlockedReason(c, lane)
  if (fresh) return fresh
  const b = live.find((a) => a.agentId === lane.builder && a.project.toLowerCase() === c.project!.toLowerCase())
  if (b) return laneNextWaitReason(c, lane, { name: b.name, status: b.status })
  if (c.agent === lane.builder && agentNow && !agentNow.running) return laneNextWaitReason(c, lane, { name: agentNow.name, status: null })
  return null
}

/**
 * A lane's next card held by its builder's new conversation that Combwork stopped trying to start (HI-2034, the lane's status
 * `startWait` `fresh` with `freshBlocked`): stalled at once, as only the user's Retry or ending the lane moves it (the
 * lane watch's `stalled`). Its card, in Todo with every card before it Done; null otherwise.
 */
function freshBlockedReason(c: Pick<TaskCard, 'number' | 'key' | 'column'>, lane: LaneOrderView): string | null {
  if (!lane.freshBlocked || lane.state === 'paused') return null
  const at = lane.cards.findIndex((x) => x.number === c.number)
  if (at < 0 || lane.cards.slice(0, at).some((x) => x.column !== 'done')) return null
  return `${c.key ?? `#${c.number}`} waits: ${lane.freshBlocked}` // i18n-ignore: agent-facing (the Agent API's stalled)
}

/** A running lane as the stall check reads it (#1410), its cards' keys and last moves from the board's cards (`card`). */
export const laneOrderView = (l: { builder: { id: string }; reviewer: { id: string } | null; state?: string; startedAt?: string; status?: LaneStatus | null; dueDeps?: DueDeps; cards: { number: number; column: string }[] }, card: (n: number) => Pick<TaskCard, 'key' | 'history'> | undefined): LaneOrderView => ({
  builder: l.builder.id,
  reviewer: l.reviewer?.id ?? null,
  ...(l.state ? { state: l.state } : {}),
  ...(l.startedAt ? { startedAt: l.startedAt } : {}),
  // Its agent's new conversation no more tried (HI-2034), said as the lane's status says it.
  ...(l.status?.reason === 'startWait' && l.status.why === 'fresh' && l.status.freshBlocked ? { freshBlocked: laneStatusText(l.status) } : {}),
  // Its next card waiting for a card it depends on (HI-2129): Combwork starts it once that one is Done.
  ...(l.status?.reason === 'startWait' && l.status.why === 'dependencies' && l.status.card !== null ? { waitsForDependency: { card: l.status.card, on: l.status.waitsFor ?? '' } } : {}),
  // Its due card's dependencies as the board has them (HI-2618).
  ...(l.dueDeps ? { due: { card: l.dueDeps.card, open: [...l.dueDeps.open], readyAt: l.dueDeps.readyAt } } : {}),
  cards: l.cards.map((c) => {
    const t = card(c.number)
    return { number: c.number, column: c.column, movedAt: t ? columnSince(t) : null, ...(t?.key ? { key: t.key } : {}) }
  })
})

/**
 * Who owes the review of a card waiting in Review, unstarted (HI-2636), for reviewWaitReason: its lane's reviewer; else
 * the reviewer the pool gave its latest submission, with when (its `ReviewerAssigned`, none given up since), and how it is
 * now; else null for a card nobody was given yet that the pool gives out (a pool lane's, or one in no lane while workflow
 * rules are on, HI-2046). Only with the rules off (or its record unreadable) does a watcher count when its workflow role
 * reviews (`reviews`). None for a card the check can't stall.
 */
export async function reviewDueOf(ws: WorkspaceService, c: TaskCard, agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>()): Promise<ReviewDue | undefined> {
  if (c.archived || c.column !== 'review' || c.review || c.blocked || !c.project || !ws.path) return undefined
  const p = join(ws.path, c.project)
  const key = p.toLowerCase()
  if (!agents.has(key)) agents.set(key, ws.projectConfig(p).then(projectAgents, () => []))
  const all = await agents.get(key)!
  const reviews = (id: string): boolean => {
    const a = all.find((x) => x.id === id)
    return !!a && reviewsWork(agentWorkflowRole(a))
  }
  const store = FactStore.forBoard(ws, { project: c.project, key: '' })
  let rec: ReturnType<typeof store.card>
  try {
    rec = store.card(c.number)
  } catch {
    return { reviews }
  }
  const named = (id: string, givenAt?: string): ReviewOwed | null => {
    const a = all.find((x) => x.id === id)
    if (!a) return null
    const status = sessions.liveFor(p, id)?.status
    return { agentId: id, name: a.name, ...(givenAt ? { givenAt } : {}), ...(status ? { status } : {}) }
  }
  if (rec.reviewer) return { owed: named(rec.reviewer) }
  const facts = store.facts(c.number)
  const given = poolReviewerOf(facts)
  if (given) return { owed: named(given, facts.findLast((f) => f.kind === 'ReviewerAssigned' && (f.data as { reviewer?: string }).reviewer === given)?.at) }
  // Nobody given it yet: a pool lane's card, or one in no lane while the rules are on (the pool gives those out too,
  // HI-2046), owes nobody; only with the rules off may any watcher that reviews count.
  return rec.reviewerPool || advanced.get<boolean>(WORKFLOW_ENFORCE) ? { owed: null } : { reviews }
}

/** Who owes a card's review (reviewDueOf): `owed` when its record says (null: nobody yet), else which agents may review. */
export interface ReviewDue {
  owed?: ReviewOwed | null
  reviews?: (agentId: string) => boolean
}

/** How long a card's design waits for its check (#1382), from its project's options: read only for a card with one waiting. */
export async function stepWaitOf(ws: WorkspaceService, c: TaskCard): Promise<number | undefined> {
  if (c.column !== 'doing' || !c.project || !ws.path || !pendingDesign(c)) return undefined
  const path = join(ws.path, c.project)
  return projectPreferences(ws, path, await ws.projectConfig(path).catch(() => null)).loopStepWaitMinutes * 60_000
}

/**
 * Why a card is stalled, working out its agent from its project's agents (each project read once a call, through
 * `agents`). For callers that don't have the agent at hand (lane watches).
 */
export async function cardStallIn(ws: WorkspaceService, c: TaskCard, agents = new Map<string, Promise<ReturnType<typeof projectAgents>>>(), lane?: LaneOrderView | null): Promise<string | null> {
  let now: StallAgent | null = null
  if (c.agent && c.project && ws.path) {
    const p = join(ws.path, c.project)
    const key = p.toLowerCase()
    if (!agents.has(key)) agents.set(key, ws.projectConfig(p).then(projectAgents, () => []))
    const def = (await agents.get(key)!).find((a) => a.id === c.agent)
    // An agent queued to resume after a restart (HI-1707), or being started (HI-1976), isn't stalled meanwhile.
    now = def ? agentNowOf(p, c.agent, def.name) : null
  }
  // A card in Doing with its agent: has the merge queue returned it (HI-1721)?
  const returned = c.column === 'doing' && c.agent && c.project && ws.path ? await queueReturnOf(ws, join(ws.path, c.project), c.number) : null
  // An approved card whose pass went stale (HI-1763).
  const stale = c.column === 'passed' && c.agent && c.project && ws.path ? await staleApprovalOf(ws, join(ws.path, c.project), c.number) : null
  return cardStall(c, now, ws.path, lane, await stepWaitOf(ws, c), returned, stale, await reviewDueOf(ws, c, agents))
}
