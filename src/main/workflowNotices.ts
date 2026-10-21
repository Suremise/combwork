import { join } from 'path'
import { shownText, withValues, type Text, type TextPart } from '../shared/advanced'
import { msg } from '../shared/i18n'
import { laneHits, newLaneBase, type LaneHit, type LaneMark } from '../shared/laneWatch'
import { cardLabel } from '../shared/projectKeys'
import { workflowLine } from '../shared/workflow/texts'
import { coalesced } from './coalesce'
import { onHiveEvent } from './events'
import { createLogger } from './logger'
import { sessions } from './sessions'
import { listLanes } from './lanes'
import { allTasks, getTask } from './tasks'
import { lanesNowIn } from './watches'
import { onAction } from './workflow/actionWorker'
import type { ActionRow } from './workflow/factStore'
import { openWorkspaces, type WorkspaceService } from './workspace'

/**
 * What Hive tells the user of the work itself (#1266, SPEC §16.11.4), with or without the Assistant: a card's request for
 * the user (the runtime's `notify` action: For you, a "couldn't within the rules"), and what the Assistant's lane watch
 * reports of each running lane (a failed review, a card blocked or stalled, every card passed so the merge is due, the
 * merge stalled). Each is a notice, a banner in the window the user is using or a Windows notification, as the user's
 * notification settings say (Settings → Notifications: their off switch); a quiet test copy records it to
 * HIVE_TEST_NOTIFY_LOG. A lane's events found together are one notice, per lane.
 *
 * A notice makes no delivery, so a `notify` action is claimed (marked done before it is shown: at most once, never twice).
 * Lane notices follow every running lane of each open workspace from what the board and lanes are now, by marks of
 * their own kept in memory (as a lane watch's): a lane already running when Hive started is followed from then, so a
 * restart never tells again what was told before it.
 */

const log = createLogger('workflow')

const M = {
  forYou: msg({ id: 'service.workflowNotice.forYou', defaultMessage: '{card} needs you', description: "A notification's title: a card (its key, e.g. HI-12) waits for the user (an approval, a decision, a question an agent asked). Its body says what." }),
  lane: msg({ id: 'service.workflowNotice.lane', defaultMessage: 'Lane {lane}', description: "A notification's title: something happened in a lane (Hive's record of a card loop, a builder and a reviewer taking cards in turn). {lane} is its label, e.g. “B1 / R1 (greetings)”. Its body lists what happened." }),
  failed: msg({ id: 'service.workflowNotice.failed', defaultMessage: '{card} failed review', description: "A line of a lane's notification: its reviewer gave a card (its key, e.g. HI-12) a failing verdict, so it goes back to its builder." }),
  blocked: msg({ id: 'service.workflowNotice.blocked', defaultMessage: '{card} is blocked: {reason}', description: "A line of a lane's notification: a card (its key, e.g. HI-12) was marked blocked, with the reason given ({reason}, the user's or an agent's own words)." }),
  blockedNoReason: msg({ id: 'service.workflowNotice.blockedNoReason', defaultMessage: '{card} is blocked', description: "A line of a lane's notification: a card (its key, e.g. HI-12) was marked blocked." }),
  stalled: msg({ id: 'service.workflowNotice.stalled', defaultMessage: '{card} has stalled', description: "A line of a lane's notification: a card (its key, e.g. HI-12) has stalled: nothing has happened on it for a long time, or its agent stopped." }),
  mergeDue: msg({ id: 'service.workflowNotice.mergeDue', defaultMessage: 'Every card passed review: its merge is due', description: "A line of a lane's notification: all of the lane's cards passed review, so its work is ready to be merged." }),
  mergeStalled: msg({ id: 'service.workflowNotice.mergeStalled', defaultMessage: 'Its merge has stalled', description: "A line of a lane's notification: every card passed review, but nobody has started merging the work for a while (its builder is idle or stopped)." })
}

/** The events Hive tells the user of, as the Assistant's lane watch does by default (§16.11.4), less what it says itself. */
const EVENTS = ['failed', 'blocked', 'stalled', 'merge-due'] as const

/** How often running lanes are looked at with no change (a stall comes with time), as lane watches are. */
const TICK_MS = 30_000

/** A notice about a project's work, as the user's notification settings say. */
function tell(projectPath: string, title: Text, lines: TextPart[]): void {
  sessions.notice(projectPath, title, lines.length === 1 ? lines[0] : { lines })
}

/**
 * A `notify` action: the card's request for the user. Its text in the language Hive shows when the runtime kept its
 * message (`shown`, #1264: Hive's own requests), else as written (an agent's own words), and in English for the Agent API.
 */
async function notifyFromAction(a: ActionRow, ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  const card = await getTask(a.card, ws).catch(() => null)
  if (!card?.project || card.archived) return
  const projectPath = join(ws.path, card.project)
  const text = typeof a.payload.text === 'string' ? a.payload.text : ''
  const shown = a.payload.shown ? workflowLine(a.payload.shown, (m, values) => shownText(values ? withValues(m, values) : m)) : null
  const body: TextPart[] = shown ? [{ shown, english: text || shown }] : text ? [text] : []
  tell(projectPath, withValues(M.forYou, { card: cardLabel(card) }), body)
}

/** A lane's events as the notice's lines, each card named as the window names it (`labels`: by number, #1221). */
function linesOf(hit: LaneHit, labels: Map<number, string>): TextPart[] {
  return hit.parts.map((p) => {
    const card = p.n !== null ? (labels.get(p.n) ?? `#${p.n}`) : ''
    switch (p.event) {
      case 'failed':
        return withValues(M.failed, { card })
      case 'blocked':
        return p.detail ? withValues(M.blocked, { card, reason: p.detail }) : withValues(M.blockedNoReason, { card })
      case 'stalled':
        return p.n === null ? M.mergeStalled : withValues(M.stalled, { card })
      default:
        return M.mergeDue
    }
  })
}

/** Per workspace (by path): when Hive began following its lanes, and each lane as last told. */
const follows = new Map<string, { since: string; marks: Record<string, LaneMark> }>()

/** Looks at a workspace's running lanes now: each one's events since it was last looked at, one notice per lane. */
async function check(ws: WorkspaceService): Promise<void> {
  const path = ws.path
  if (!path) return
  const key = path.toLowerCase()
  const f = follows.get(key) ?? { since: new Date().toISOString(), marks: {} }
  follows.set(key, f)
  const lanes = new Map((await listLanes(ws, { all: true })).map((l) => [l.id, l]))
  const nows = await lanesNowIn(ws, f.marks, f.since)
  // Closed, or another workspace opened in its window, meanwhile: nothing told for it.
  if (ws.path !== path || !openWorkspaces().includes(ws)) return
  const marks: Record<string, LaneMark> = {}
  for (const now of nows) {
    const lane = lanes.get(now.id)
    // A lane first seen: one started since Hive began following starts empty (what it came with is told), else from now.
    const base = f.marks[now.id] ?? (lane && Date.parse(lane.startedAt) > Date.parse(f.since) ? newLaneBase(now, f.since) : null)
    marks[now.id] = now.mark
    const hit = laneHits(base, now, EVENTS, f.since)
    if (!hit || !lane) continue
    const numbers = hit.parts.flatMap((p) => (p.n !== null ? [p.n] : []))
    const labels = new Map(numbers.length ? (await allTasks(ws, { numbers })).map((c) => [c.number, cardLabel(c)]) : [])
    tell(join(path, lane.project), withValues(M.lane, { lane: hit.label }), linesOf(hit, labels))
  }
  // Only running lanes are followed on: one ended, abandoned or gone is dropped.
  f.marks = Object.fromEntries(Object.entries(marks).filter(([, m]) => m.state === 'active' || m.state === 'paused'))
}

/** A workspace's lanes looked at soon: one look at a time, a change during it looked at again after. */
function checkSoon(ws: WorkspaceService): void {
  if (!ws.path) return
  void coalesced(`lane-notices:${ws.path.toLowerCase()}`, () => check(ws)).catch((e) => log.warn('lane notices', e))
}

let started = false
/** Wires Hive's own notices of the work (once, at start): the `notify` action, and lanes followed on every change and tick. */
export function initWorkflowNotices(): void {
  if (started) return
  started = true
  // A notice makes no delivery: claimed (marked done before it is shown), so at most once.
  onAction('notify', notifyFromAction, 'claimed')
  onHiveEvent((e) => {
    if (e.type !== 'tasks-changed' && e.type !== 'lanes-changed') return
    const ws = openWorkspaces().find((w) => w.path?.toLowerCase() === e.workspacePath.toLowerCase())
    if (ws) checkSoon(ws)
  })
  setInterval(() => {
    for (const ws of openWorkspaces()) checkSoon(ws)
  }, TICK_MS).unref?.()
}

/** For tests: looks at a workspace's lanes now (what a change or the tick does), and forgets what was followed. */
export const checkLanesNow = (ws: WorkspaceService): Promise<void> => check(ws)
export const forgetLaneNotices = (): void => follows.clear()
