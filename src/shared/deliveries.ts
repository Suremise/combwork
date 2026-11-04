/**
 * Deliveries (#647, plans/2026-10-12-messaging-redesign.md §3.1): everything Hive has for an agent to read is a record
 * with an id, its target, kind, sender, card, body and state, saved in its workspace's database (#1018: under its project) and offered
 * by one scheduler (main/deliveries.ts): every way into an agent makes one (#649). The agent collects them with
 * cw_inbox (received) and acknowledges them once it has acted on them (acked). This file is the pure part: the states and their moves, coalescing, the typed line and the
 * inbox's reply. No imports beyond shared files with none of their own: hive-mcp.js runs outside the app bundle.
 */
import type { InboxBrief, InboxSummary } from './types'
import { agentMsg, say } from './agentText'
import { currentPrefix, currentProtocolText, inboxNotice } from './doorbell'
import { cardRef } from './projectKeys'

/** What a delivery is: a task, a re-brief (a message for the work it is on), a card event, the user's answer, a handover, a control notice. */
export const DELIVERY_KINDS = ['task', 'rebrief', 'card-event', 'answer', 'handover', 'control'] as const
export type DeliveryKind = (typeof DELIVERY_KINDS)[number]

/**
 * Kinds the agent acks once it has acted on them (#649): a message, a task, a handover, the user's answer. A card event
 * or a control notice is done once received: never overdue, never waiting for an ack.
 */
export const needsAck = (kind: DeliveryKind): boolean => kind !== 'card-event' && kind !== 'control'
/** Kinds offered in a line of their own (a task, a handover), never with other deliveries. */
export const goesAlone = (kind: DeliveryKind): boolean => kind === 'task' || kind === 'handover'
/**
 * What an agent must be doing to be offered a delivery: idle (ready, finished or watching: a watching agent takes a
 * message or a wake, and its watch carries on), free (ready or finished: not watching, which takes no new work), or
 * stalled (free, or stopped by a refused sign-in: the carry-on after signing in again).
 */
export type DeliveryNeed = 'idle' | 'free' | 'stalled'

/**
 * queued: waiting to be offered; offered: Hive has told the agent of it (#650: the doorbell typed into its terminal, which
 * names it by id; never its text); received: the agent fetched it with cw_inbox (#645: received is automatic on fetch;
 * #650: the only receipt. Before #650 a line that carried its whole text also made it received once its CLI took it,
 * receivedVia 'typed', which saved records may still say); acked: the agent says it has acted on it. Ended without that: cancelled (by
 * whom), refused (its sender may no longer send it), expired (too old, or its agent is in another conversation now),
 * stale (#652: tied to a card's round, and that card has moved on: passed, out of Doing and Review, or in a new round).
 * uncertain: offered when Hive stopped or its agent's launch ended, before it was received: it may not have reached the
 * agent, so it is offered once more, saying it may repeat (`again`), and stays uncertain if that one isn't received.
 */
export const DELIVERY_STATES = ['queued', 'offered', 'received', 'acked', 'cancelled', 'refused', 'expired', 'uncertain', 'stale'] as const
export type DeliveryState = (typeof DELIVERY_STATES)[number]

/**
 * Who a delivery is from. The Assistant's names its workspace and the launch that sent it: its permission is worked out
 * again from those and the settings at every step (never a token or a closure, which can't be saved), and a launch that
 * has ended sends nothing more (#645). Hive's own (board events) and the user's need no more. An agent's (HI-1866: its
 * request for the Assistant on a card) names its project and id, so whoever reads it knows which agent asked.
 */
export type DeliverySender = { kind: 'assistant'; name: string; workspace: string; launch: string } | { kind: 'hive'; name: string } | { kind: 'user'; name: string } | { kind: 'agent'; name: string; project: string; agentId: string }

export interface DeliveryRecord {
  /** Short and unique in its project ("m12"): what the agent acks. */
  id: string
  seq: number
  agentId: string
  /** The agent's name when it was made, for what is shown. */
  agentName?: string
  /** The conversation it is for (the provider's session id), when known: another conversation of the agent doesn't get it. */
  conversation: string | null
  kind: DeliveryKind
  from: DeliverySender
  card?: number
  /**
   * The round of its card it is for (#652, with `card`: a re-brief for the work under way, the card's failed reviews plus
   * one when it was made): it is relevant only while the card is in Doing or Review in that round, and stale after.
   */
  round?: number
  /** What it says (a card event's short line, a message's text). */
  body: string
  state: DeliveryState
  created: string
  expires: string
  offered?: string
  /** How many times it was offered (again after Hive stopped while offering it). */
  offers?: number
  received?: string
  /** How it was received: fetched with cw_inbox ('typed': its line taken by its CLI, before #650 made the inbox the only receipt). */
  receivedVia?: 'inbox' | 'typed'
  /** The launch its offer was typed into (an offer holds only while that launch runs). */
  offerRun?: string
  acked?: string
  /** When it was cancelled, refused or expired. */
  ended?: string
  /** Why it ended, or why it is uncertain. */
  detail?: string
  /** Why it may repeat (#649: it was offered when Hive stopped or its launch ended): said when it is offered once more. */
  again?: string
  /**
   * What made it (#649: a watch, a loop wake…), told when it is received or ends, and its key there (`ref`): a live
   * delivery with the same source and ref is that one, never made twice.
   */
  source?: string
  ref?: string
  /** Its source's own few facts (what it was made from), for when it is made again or checked. */
  meta?: Record<string, string | number | boolean>
  /** What its agent must be doing to be offered it (default idle). */
  need?: 'free' | 'stalled'
  /** Only for this launch of its agent (a mode notice, a lock's go-ahead): it expires once that launch has ended. */
  forRun?: string
  /**
   * The durable action that made it (`card_actions.id`, SPEC §16.4.5): one delivery per action, never two (the unique
   * `deliveries.action`), so an action run again (a restart, another Hive) finds it and makes nothing.
   */
  action?: number
}

/**
 * The longest a delivery's text may be (#649: a task's prompt, a card's description and the user's note in it, is the
 * longest a producer makes): refused when it is made, and the same as what is read back, so whatever is saved restores.
 */
export const DELIVERY_BODY_MAX_CHARS = 100_000
/** The longest a reason it ended (or may repeat) is kept: longer ones are cut when they are set, never refused on reading back. */
export const DELIVERY_DETAIL_MAX_CHARS = 500

/** Unacked this long after it was made, a delivery is overdue: shown as such to the user and the Assistant. */
export const OVERDUE_MINUTES = 30
/** How long a delivery waits to be received before it expires. */
export const DELIVERY_EXPIRY_HOURS = 24

const NEXT: Record<DeliveryState, readonly DeliveryState[]> = {
  queued: ['offered', 'received', 'acked', 'cancelled', 'refused', 'expired', 'stale'],
  // Back to queued: the offer didn't happen after all (nothing was typed). Cancelled: while it is still being typed.
  offered: ['received', 'acked', 'uncertain', 'queued', 'cancelled', 'refused', 'expired', 'stale'],
  uncertain: ['offered', 'received', 'acked', 'cancelled', 'refused', 'expired', 'stale'],
  received: ['acked', 'expired'],
  acked: [],
  cancelled: [],
  refused: [],
  expired: [],
  stale: []
}

export const canMove = (from: DeliveryState, to: DeliveryState): boolean => NEXT[from].includes(to)
/** Not ended: still for the agent to receive, or (a kind it acks) to ack. */
export const isLive = (r: Pick<DeliveryRecord, 'state' | 'kind'>): boolean => r.state === 'queued' || r.state === 'offered' || r.state === 'uncertain' || (r.state === 'received' && needsAck(r.kind))
/** Not received yet: what cw_inbox lists and the pane counts. */
export const isUnread = (r: Pick<DeliveryRecord, 'state'>): boolean => r.state === 'queued' || r.state === 'offered' || r.state === 'uncertain'
/** Waiting to be offered: queued, or uncertain and not offered again yet (offered once more, #649). */
export const isWaiting = (r: Pick<DeliveryRecord, 'state' | 'offers'>): boolean => r.state === 'queued' || (r.state === 'uncertain' && (r.offers ?? 0) < 2)

/** A delivery moved to another state at `at` (ISO), its times filled in; null when that move isn't allowed. */
export function moved(r: DeliveryRecord, to: DeliveryState, at: string, detail?: string): DeliveryRecord | null {
  if (!canMove(r.state, to)) return null
  const next: DeliveryRecord = { ...r, state: to }
  delete next.detail
  if (to === 'offered') {
    next.offered = at
    next.offers = (r.offers ?? 0) + 1
  } else if (to === 'queued') {
    // Not offered after all: as it was before the offer.
    next.offers = Math.max(0, (r.offers ?? 1) - 1)
    if (!next.offers) {
      delete next.offered
      delete next.offers
    }
  } else if (to === 'received') next.received = at
  else if (to === 'acked') {
    next.acked = at
    next.received ??= at
  } else if (to !== 'uncertain') next.ended = at
  if (detail) next.detail = detail.length > DELIVERY_DETAIL_MAX_CHARS ? `${detail.slice(0, DELIVERY_DETAIL_MAX_CHARS - 1)}…` : detail
  return next
}

/** Whether a live delivery of a kind the agent acks hasn't been acked OVERDUE_MINUTES (or `overdueMs`) after it was made. */
export const isOverdue = (r: DeliveryRecord, now: number, overdueMs = OVERDUE_MINUTES * 60_000): boolean => isLive(r) && needsAck(r.kind) && now - Date.parse(r.created) >= overdueMs

/** One item of the inbox: a delivery, or a card's events coalesced ("#607: 3 changes, read the card"). */
export interface InboxItem {
  ids: string[]
  kind: DeliveryKind
  from: string
  card?: number
  text: string
  at: string
}

/**
 * The unread deliveries as the inbox lists them, oldest first: a card's events in one item, where its first one was.
 * Combwork's own unread messages written before HI-2463 are handed out with the current names (currentProtocolText);
 * a person's or an agent's words never change.
 */
export function inboxItems(records: readonly DeliveryRecord[]): InboxItem[] {
  const out: InboxItem[] = []
  const byCard = new Map<number, { item: InboxItem; events: DeliveryRecord[] }>()
  for (const r of [...records].filter(isUnread).sort((a, b) => a.seq - b.seq)) {
    if (r.kind === 'card-event' && r.card) {
      const had = byCard.get(r.card)
      if (had) {
        had.item.ids.push(r.id)
        had.events.push(r)
        // agent-protocol: the senders' join, which this line splits back to find a sender already named
        if (!had.item.from.split(' and ').includes(r.from.name)) had.item.from += ` and ${r.from.name}`
        continue
      }
      const item: InboxItem = { ids: [r.id], kind: r.kind, from: r.from.name, card: r.card, text: '', at: r.created }
      byCard.set(r.card, { item, events: [r] })
      out.push(item)
      continue
    }
    out.push({ ids: [r.id], kind: r.kind, from: r.from.name, ...(r.card ? { card: r.card } : {}), text: r.from.kind === 'hive' ? currentProtocolText(r.body) : r.body, at: r.created })
  }
  // A card's events quote people's and agents' comments, kept as written: only Combwork's own prefix is made current.
  for (const { item, events } of byCard.values()) item.text = currentPrefix(coalesced(events))
  return out
}

/**
 * A card's events in one line: one as it is; several counted. HI-2087: led by the merge queue's latest return of the
 * card (its line marked so where it was made: `meta.queueReturn`) while it still says where the work is, that is while
 * nothing but comments on it came after (`meta.commentOnly`: the queue's own comment, say); a later move, verdict, merge
 * or removal is newer than the return, so the count again.
 */
function coalesced(events: readonly DeliveryRecord[]): string {
  if (events.length === 1 && events[0].body) return events[0].body
  const i = events.findLastIndex((r) => r.meta?.queueReturn === true)
  if (i < 0 || !events.slice(i + 1).every((r) => r.meta?.commentOnly === true)) return say(T.counted, { n: events.length, count: String(events.length) })
  return say(T.withMore, { body: events[i].body, n: events.length - 1, more: String(events.length - 1) })
}

const idList = (ids: readonly string[]): string => ids.join(', ')

const T = {
  counted: agentMsg({ id: 'inbox.cardEvents.counted', text: '{n, plural, one {{count} change} other {{count} changes}}, read the card', note: "A card's events in one inbox item, counted (several changes to a watched card since the agent last read its inbox). n and count: how many." }),
  withMore: agentMsg({ id: 'inbox.cardEvents.withMore', text: '{body} (with {more} more {n, plural, one {change} other {changes}}: read the card)', note: "A card's events in one inbox item, led by the merge queue's return of the card while only comments came after it (HI-2087). body: the return's own line; n and more: how many events came after it." }),
  again: agentMsg({ id: 'inbox.offer.again', text: '({ids} again: {why}, so {n, plural, one {it} other {they}} may repeat.)', note: 'After the doorbell: deliveries offered again, which the agent may have seen before. ids: their ids ("m12, m14"); why: why each is offered again, joined by "; " (inbox.again.*); n: how many.' }),
  watchOn: agentMsg({ id: 'inbox.offer.watchOn', text: '(Your watch is still on, {watch}: do what this asks, then end your turn, and Combwork wakes you when it changes.)', note: "After the doorbell, typed into an agent waiting on a watch: its watch carries on. watch: the watch's label, its first letter in lower case (\"waiting on HI-12\")." }),
  older: agentMsg({ id: 'inbox.read.older', text: 'Received before, not acked yet: {ids}.', note: "In cw_inbox's reply: deliveries the agent read before and has not acked. ids: their ids (\"m12, m14\")." }),
  nothingNew: agentMsg({ id: 'inbox.read.nothingNew', text: 'Nothing new.', note: "cw_inbox's reply when nothing is unread (before inbox.read.older, if any)." }),
  newCount: agentMsg({ id: 'inbox.read.newCount', text: '{count} new:', note: "cw_inbox's first line, before one line per item (ids · sender · card: text). count: how many items." }),
  ackEach: agentMsg({ id: 'inbox.read.ackEach', text: 'Ack each with cw_inbox (ack: its ids) once you have acted on it.', note: "cw_inbox's last line, after what is new." }),
  acked: agentMsg({ id: 'inbox.ack.acked', text: 'Acked {ids}.', note: "cw_inbox ack's reply: what it acked. ids: their ids (\"m12, m14\")." }),
  nothingAcked: agentMsg({ id: 'inbox.ack.none', text: 'Nothing acked.', note: "cw_inbox ack's reply when none of the ids was acked." }),
  notReadBefore: agentMsg({ id: 'inbox.ack.notReadBefore', text: 'Not read before: {ids}, not acked: ack {n, plural, one {it} other {them}} once you have acted on {n, plural, one {it} other {them}}.', note: "In cw_inbox ack's reply with read: true (#1531): ids it was asked to ack that the agent hadn't read, now in the read that follows. ids: their ids; n: how many." }),
  notReadYet: agentMsg({ id: 'inbox.ack.notReadYet', text: 'Not read yet: {ids}: read {n, plural, one {it} other {them}} with cw_inbox first.', note: "In cw_inbox ack's reply: ids it was asked to ack that the agent hasn't read. ids: their ids; n: how many." }),
  unknown: agentMsg({ id: 'inbox.ack.unknown', text: 'Not in your inbox: {ids}.', note: "In cw_inbox ack's reply: ids it was asked to ack that aren't the agent's deliveries. ids: those ids." })
}

/**
 * The line that offers deliveries by typing, one line: the CLI's prompt. The doorbell (#650, plans/2026-10-12-messaging-
 * redesign.md §3.4): Hive's fixed words with counts by kind, cards and ids (shared/doorbell.ts), never what they say,
 * which the agent reads with cw_inbox, labelled with its sender; ids that may repeat say so; and the watch that carries
 * on if the agent is watching.
 */
export function offerLine(records: readonly DeliveryRecord[], watchLabel: string | null): string {
  const sorted = [...records].sort((a, b) => a.seq - b.seq)
  const bell = inboxNotice('doorbell', sorted.map((r) => ({ id: r.id, kind: r.kind, ...(r.card ? { card: r.card } : {}) })))
  const again = sorted.filter((r) => r.again)
  const repeat = again.length ? ` ${say(T.again, { ids: idList(again.map((r) => r.id)), why: [...new Set(again.map((r) => r.again))].join('; '), n: again.length })}` : ''
  const tail = watchLabel ? ` ${say(T.watchOn, { watch: `${watchLabel.charAt(0).toLowerCase()}${watchLabel.slice(1)}` })}` : ''
  return `${bell}${repeat}${tail}`
}

/** cw_inbox's reply: what is new (now received), and what was received before and isn't acked yet. */
export function inboxText(items: readonly InboxItem[], unacked: readonly string[]): string {
  const older = unacked.length ? say(T.older, { ids: idList(unacked) }) : ''
  if (!items.length) return `${say(T.nothingNew)}${older ? ` ${older}` : ''}`
  const rows = items.map((i) => `${i.ids.join(',')} · ${i.from}${i.card ? ` · ${cardRef(i.card)}` : ''}: ${i.text}`)
  return [say(T.newCount, { count: String(items.length) }), ...rows, ...(older ? [older] : []), say(T.ackEach)].join('\n')
}

/** cw_inbox ack's reply; `reading`: with read: true (#1531), the ids not read yet are in the read that follows. */
export function ackText(acked: readonly string[], unknown: readonly string[], unread: readonly string[] = [], reading = false): string {
  const a = acked.length ? say(T.acked, { ids: idList(acked) }) : say(T.nothingAcked)
  const notRead = unread.length ? ` ${say(reading ? T.notReadBefore : T.notReadYet, { ids: idList(unread), n: unread.length })}` : ''
  return `${a}${notRead}${unknown.length ? ` ${say(T.unknown, { ids: idList(unknown) })}` : ''}`
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** What an agent's pane shows of its deliveries: those not received yet, and how many are overdue; undefined when neither. */
export function inboxSummary(records: readonly DeliveryRecord[], now: number, overdueMs?: number): InboxSummary | undefined {
  const unread: InboxBrief[] = records
    .filter(isUnread)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({ id: r.id, from: r.from.name, text: clip(r.body || (r.card ? `${cardRef(r.card)} changed` : ''), 120), at: r.created, state: r.state, ...(r.card ? { card: r.card } : {}) }))
  const overdue = records.filter((r) => isOverdue(r, now, overdueMs)).length
  return unread.length || overdue ? { unread, overdue } : undefined
}

/** A delivery as the Agent API and cw_agent_activity show it: its state and times, the start of what it says. */
export interface DeliveryRow {
  id: string
  kind: DeliveryKind
  from: string
  card?: number
  text: string
  state: DeliveryState
  created: string
  offered?: string
  received?: string
  receivedVia?: 'inbox' | 'typed'
  acked?: string
  ended?: string
  detail?: string
  overdue?: true
}

export function deliveryRow(r: DeliveryRecord, now: number, textChars = 80, overdueMs?: number): DeliveryRow {
  return {
    id: r.id,
    kind: r.kind,
    from: r.from.name,
    ...(r.card ? { card: r.card } : {}),
    text: clip(r.body, textChars),
    state: r.state,
    created: r.created,
    ...(r.offered ? { offered: r.offered } : {}),
    ...(r.received ? { received: r.received, ...(r.receivedVia ? { receivedVia: r.receivedVia } : {}) } : {}),
    ...(r.acked ? { acked: r.acked } : {}),
    ...(r.ended ? { ended: r.ended } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(isOverdue(r, now, overdueMs) ? { overdue: true as const } : {})
  }
}

const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max
const time = (x: unknown): x is string => str(x, 40) && x.length > 0 && Number.isFinite(Date.parse(x))
const optTime = (x: unknown): boolean => x === undefined || time(x)

function readSender(v: unknown): DeliverySender | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  if (!str(s.name, 200) || !s.name) return null
  if (s.kind === 'assistant') return str(s.workspace, 1024) && s.workspace && str(s.launch, 200) ? { kind: 'assistant', name: s.name, workspace: s.workspace, launch: s.launch } : null
  if (s.kind === 'agent') return str(s.project, 300) && s.project && str(s.agentId, 128) && s.agentId ? { kind: 'agent', name: s.name, project: s.project, agentId: s.agentId } : null
  if (s.kind === 'hive' || s.kind === 'user') return { kind: s.kind, name: s.name }
  return null
}

/** A saved delivery, checked in full (the file can be edited by hand) and rebuilt from what checks out; null if it isn't one. */
export function readDelivery(v: unknown): DeliveryRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (!str(r.id, 32) || !/^m\d+$/.test(r.id) || !Number.isInteger(r.seq) || (r.seq as number) < 1 || !str(r.agentId, 128) || !r.agentId) return null
  if (!(DELIVERY_KINDS as readonly unknown[]).includes(r.kind) || !(DELIVERY_STATES as readonly unknown[]).includes(r.state)) return null
  const from = readSender(r.from)
  if (!from || !str(r.body, DELIVERY_BODY_MAX_CHARS) || !time(r.created) || !time(r.expires)) return null
  if (!(r.conversation === null || str(r.conversation, 200))) return null
  if (r.card !== undefined && !(Number.isInteger(r.card) && (r.card as number) > 0)) return null
  if (r.round !== undefined && !(r.card !== undefined && Number.isInteger(r.round) && (r.round as number) > 0)) return null
  if (![r.offered, r.received, r.acked, r.ended].every(optTime)) return null
  if (r.offers !== undefined && !(Number.isInteger(r.offers) && (r.offers as number) >= 0)) return null
  if (r.receivedVia !== undefined && r.receivedVia !== 'inbox' && r.receivedVia !== 'typed') return null
  if (r.again !== undefined && !str(r.again, DELIVERY_DETAIL_MAX_CHARS)) return null
  if (r.source !== undefined && !(str(r.source, 40) && /^[a-z-]+$/.test(r.source))) return null
  if (r.ref !== undefined && !str(r.ref, 300)) return null
  if (r.need !== undefined && r.need !== 'free' && r.need !== 'stalled') return null
  if (r.forRun !== undefined && !str(r.forRun, 200)) return null
  if (r.meta !== undefined && !readMeta(r.meta)) return null
  if (r.detail !== undefined && !str(r.detail, DELIVERY_DETAIL_MAX_CHARS)) return null
  if (r.agentName !== undefined && !str(r.agentName, 300)) return null
  if (r.offerRun !== undefined && !str(r.offerRun, 200)) return null
  if (r.action !== undefined && !(Number.isInteger(r.action) && (r.action as number) > 0)) return null
  const out: DeliveryRecord = { id: r.id, seq: r.seq as number, agentId: r.agentId, conversation: (r.conversation as string | null) || null, kind: r.kind as DeliveryKind, from, body: r.body, state: r.state as DeliveryState, created: r.created, expires: r.expires }
  if (r.agentName) out.agentName = r.agentName as string
  if (r.card) out.card = r.card as number
  if (r.round) out.round = r.round as number
  for (const k of ['offered', 'received', 'acked', 'ended', 'detail'] as const) if (r[k]) out[k] = r[k] as string
  if (r.offers) out.offers = r.offers as number
  if (r.receivedVia) out.receivedVia = r.receivedVia as 'inbox' | 'typed'
  if (r.offerRun) out.offerRun = r.offerRun as string
  for (const k of ['again', 'source', 'ref', 'forRun'] as const) if (r[k]) out[k] = r[k] as string
  if (r.need) out.need = r.need as 'free' | 'stalled'
  if (r.meta) out.meta = { ...(r.meta as Record<string, string | number | boolean>) }
  if (r.action) out.action = r.action as number
  return out
}

/** A source's facts as saved: a few short values. */
function readMeta(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const e = Object.entries(v as Record<string, unknown>)
  return e.length <= 20 && e.every(([k, x]) => k.length <= 40 && ((typeof x === 'string' && x.length <= 500) || (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean'))
}
