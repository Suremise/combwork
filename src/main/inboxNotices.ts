import { LANES_UNWATCHED_NOTICE } from '../shared/advanced'
import { isUnread, type DeliveryRecord } from '../shared/deliveries'
import { inboxNotice, unwatchedLanesNotice, type NoticeItem } from '../shared/doorbell'
import { running } from '../shared/lanes'
import type { LiveSessionState } from '../shared/types'
import { advanced } from './advanced'
import { allows } from './assistantControl'
import { agentReadsInbox, countable, inboxSwitch } from './deliveries'
import { orphanLinesFor } from './orphanProcesses'
import { sessions } from './sessions'
import { workspaceFor } from './workspace'
import { pausedFor } from './teamPause'

/**
 * Notices in hooks (#650, plans/2026-10-12-messaging-redesign.md §3.2): a busy agent is told what it has unread at its
 * next checkpoint (a tool call of its own ended), and before its turn ends (the Stop drain), in the reply to that hook,
 * so nothing is typed into a working agent. The notice is Hive's fixed text with counts, cards and ids
 * (shared/doorbell.ts); the agent reads the bodies with cw_inbox, which alone makes them received. Each CLI says which
 * of its hooks can carry one (the adapter's noticeReply; sessions.hookReply asks only those).
 *
 * - **Checkpoint**: only deliveries it wasn't told of yet in this launch, so a long turn isn't told the same thing at
 *   every tool call; the drain and the doorbell catch one it let pass.
 * - **Drain**: everything unread, once a turn (sessions.hookReply: not after a continuation). Its reply carries the turn
 *   on, so the agent reads its inbox before it stops rather than being woken again by the doorbell. The Assistant's
 *   drain also says when lanes are running that no watch of its covers (HI-2069), so it watches them before it stops:
 *   nothing would wake it about them otherwise.
 *
 * Each has its switch (#1432, shared/inboxSwitches.ts: checkpoints, stopContinuation), read at each hook.
 */

/** What each launch was told at its checkpoints (its live state lives as long as the launch). */
const told = new WeakMap<LiveSessionState, Set<string>>()

/**
 * The deliveries an agent has unread that cw_inbox would give it now (HI-1687: what a notice names, a read gives and an
 * ack takes): `countable`, the gate's own check without making anything again; not expired, and not for another
 * conversation.
 */
async function unreadFor(st: LiveSessionState): Promise<DeliveryRecord[]> {
  const now = Date.now()
  return (await countable(st.projectPath, st.agentId)).filter((r) => isUnread(r) && Date.parse(r.expires) > now && !(r.conversation && st.sessionId && r.conversation !== st.sessionId))
}

const item = (r: DeliveryRecord): NoticeItem => ({ id: r.id, kind: r.kind, ...(r.card ? { card: r.card } : {}) })

/** The notice for a launch at a checkpoint or its turn's end; null when there is nothing (new) to tell. */
export async function noticeFor(st: LiveSessionState, at: 'checkpoint' | 'drain'): Promise<string | null> {
  // What its commands left running (HI-2111), told once each, whatever its inbox has.
  const orphans = orphanLinesFor(st.projectPath, st.agentId)
  const inbox = await inboxNoticeFor(st, at)
  return [inbox, orphans].filter(Boolean).join(' ') || null
}

/** The notice for what the agent has unread (and the Assistant's unwatched lanes); null when there is nothing new. */
async function inboxNoticeFor(st: LiveSessionState, at: 'checkpoint' | 'drain'): Promise<string | null> {
  // One that can't read an inbox (its hive tools off) is given no delivery (#650's decision): nothing to tell it here.
  if (!agentReadsInbox(st.projectPath, st.agentId)) return null
  // Its switch off (#1432): no notice there, so the turn goes on (or ends) as the CLI would; what is unread stays in the
  // inbox for the drain, the doorbell or cw_inbox. The checkpoint's not told isn't counted as told.
  if (!(await inboxSwitch(st.projectPath, at === 'checkpoint' ? 'checkpoints' : 'stopContinuation'))) return null
  const lanes = at === 'drain' ? await unwatchedLanes(st) : ''
  const unread = await unreadFor(st)
  if (!unread.length) return lanes || null
  const seen = told.get(st) ?? new Set<string>()
  told.set(st, seen)
  if (at === 'checkpoint' && unread.every((r) => seen.has(r.id))) return null
  for (const r of unread) seen.add(r.id)
  return [inboxNotice(at, unread.map(item)), lanes].filter(Boolean).join(' ') || null
}

/**
 * The Assistant's line for running lanes no watch of its covers (HI-2069), by their builders: none for a project agent,
 * with no lane running, with a lane watch on all of them (`lanes: ["all"]`, or each by id), with its switch off
 * (Settings → Advanced, LANES_UNWATCHED_NOTICE), or when its control level doesn't let it control agents (HI-2187: at
 * Look and advise the lanes are the user's to run, and a watch it starts on its own is still its choice). Once a turn,
 * as the drain is.
 */
async function unwatchedLanes(st: LiveSessionState): Promise<string> {
  if (!advanced.get<boolean>(LANES_UNWATCHED_NOTICE)) return ''
  const ws = workspaceFor(st.projectPath)
  if (!ws?.path || !ws.isAssistantHome(st.projectPath)) return ''
  if (!allows('agents')) return ''
  // Its team paused (HI-2081): nothing is due from the lanes, which wait for the resume.
  if (pausedFor(st.projectPath)) return ''
  // Loaded here, for the Assistant only: the lanes and watches services aren't every notice's to start.
  const [{ rawLanes }, { loadedWatchFor }] = await Promise.all([import('./lanes'), import('./watches')])
  const lanes = (await rawLanes(ws).catch(() => [])).filter(running)
  if (!lanes.length) return ''
  const watched = (await loadedWatchFor(ws, st.projectPath, st.agentId).catch(() => null))?.lanes ?? []
  if (watched.includes('all')) return ''
  return unwatchedLanesNotice(lanes.filter((l) => !watched.includes(l.id)).map((l) => l.builder.name))
}

/** Wires the notices into the hook replies (once, at start). */
export function initInboxNotices(): void {
  sessions.inboxNotice = noticeFor
}
