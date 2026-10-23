import { isUnread, type DeliveryRecord } from '../shared/deliveries'
import { inboxNotice, type NoticeItem } from '../shared/doorbell'
import type { LiveSessionState } from '../shared/types'
import { agentReadsInbox, deliveriesOf, inboxSwitch } from './deliveries'
import { sessions } from './sessions'

/**
 * Notices in hooks (#650, plans/2026-10-12-messaging-redesign.md §3.2): a busy agent is told what it has unread at its
 * next checkpoint (a tool call of its own ended), and before its turn ends (the Stop drain), in the reply to that hook,
 * so nothing is typed into a working agent. The notice is Hive's fixed text with counts, cards and ids
 * (shared/doorbell.ts); the agent reads the bodies with hive_inbox, which alone makes them received. Each CLI says which
 * of its hooks can carry one (the adapter's noticeReply; sessions.hookReply asks only those).
 *
 * - **Checkpoint**: only deliveries it wasn't told of yet in this launch, so a long turn isn't told the same thing at
 *   every tool call; the drain and the doorbell catch one it let pass.
 * - **Drain**: everything unread, once a turn (sessions.hookReply: not after a continuation). Its reply carries the turn
 *   on, so the agent reads its inbox before it stops rather than being woken again by the doorbell.
 *
 * Each has its switch (#1432, shared/inboxSwitches.ts: checkpoints, stopContinuation), read at each hook.
 */

/** What each launch was told at its checkpoints (its live state lives as long as the launch). */
const told = new WeakMap<LiveSessionState, Set<string>>()

/** The deliveries an agent has unread that may still reach it: not expired, and not for another conversation. */
async function unreadFor(st: LiveSessionState): Promise<DeliveryRecord[]> {
  const now = Date.now()
  return (await deliveriesOf(st.projectPath, st.agentId)).filter((r) => isUnread(r) && Date.parse(r.expires) > now && !(r.conversation && st.sessionId && r.conversation !== st.sessionId))
}

const item = (r: DeliveryRecord): NoticeItem => ({ id: r.id, kind: r.kind, ...(r.card ? { card: r.card } : {}) })

/** The notice for a launch at a checkpoint or its turn's end; null when there is nothing (new) to tell. */
export async function noticeFor(st: LiveSessionState, at: 'checkpoint' | 'drain'): Promise<string | null> {
  // One that can't read an inbox (its hive tools off) is given no delivery (#650's decision): nothing to tell it here.
  if (!agentReadsInbox(st.projectPath, st.agentId)) return null
  // Its switch off (#1432): no notice there, so the turn goes on (or ends) as the CLI would; what is unread stays in the
  // inbox for the drain, the doorbell or hive_inbox. The checkpoint's not told isn't counted as told.
  if (!(await inboxSwitch(st.projectPath, at === 'checkpoint' ? 'checkpoints' : 'stopContinuation'))) return null
  const unread = await unreadFor(st)
  if (!unread.length) return null
  const seen = told.get(st) ?? new Set<string>()
  told.set(st, seen)
  if (at === 'checkpoint' && unread.every((r) => seen.has(r.id))) return null
  for (const r of unread) seen.add(r.id)
  return inboxNotice(at, unread.map(item)) || null
}

/** Wires the notices into the hook replies (once, at start). */
export function initInboxNotices(): void {
  sessions.inboxNotice = noticeFor
}
