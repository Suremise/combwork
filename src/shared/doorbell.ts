/**
 * What Hive tells an agent that has something to read (#650, plans/2026-10-12-messaging-redesign.md §3.2, §3.5): a
 * notice in a hook's reply while it works (a checkpoint, after a tool call), one before its turn ends (the Stop drain), or
 * a short line typed into an idle agent (the doorbell). Each is Hive's own fixed wording with counts by kind, card
 * numbers and delivery ids, never a delivery's body, a sender's name or anything a person or an agent wrote: those are
 * fetched with hive_inbox, labelled with their sender, as data. Codex takes hook context as developer messages, so this
 * text must stay code-owned. No imports beyond shared types: hive-mcp.js runs outside the app bundle.
 */
import type { DeliveryKind } from './deliveries'
import { cardRef } from './projectKeys'

/** Where the agent is told: a checkpoint (a tool call ended), before its turn ends (Stop), or typed while it is idle. */
export type NoticeAt = 'checkpoint' | 'drain' | 'doorbell'

/** What a notice names of a delivery: its id, kind and card (never its body or sender). */
export interface NoticeItem {
  id: string
  kind: DeliveryKind
  card?: number
}

const NOUN: Record<DeliveryKind, [string, string]> = {
  task: ['task', 'tasks'],
  rebrief: ['message', 'messages'],
  'card-event': ['card event', 'card events'],
  answer: ['answer', 'answers'],
  handover: ['handover', 'handovers'],
  control: ['notice', 'notices']
}
const ORDER: readonly DeliveryKind[] = ['task', 'handover', 'answer', 'rebrief', 'card-event', 'control']

/** Hive's notices begin with this, as its other lines do. */
export const NOTICE_PREFIX = '[Hive] '

/** Whether a prompt is the doorbell (typed into an idle agent): it names what waits by id. */
export const isDoorbell = (text: string): boolean => text.startsWith(`${NOTICE_PREFIX}New in your inbox: `)

/** "1 message and 2 card events (#12, #14)": counts by kind, in a fixed order, with the cards they are about. */
export function noticeCounts(items: readonly NoticeItem[]): string {
  const parts: string[] = []
  for (const kind of ORDER) {
    const of = items.filter((i) => i.kind === kind)
    if (!of.length) continue
    const cards = [...new Set(of.map((i) => i.card).filter((c): c is number => Number.isInteger(c) && c! > 0))].sort((a, b) => a - b)
    parts.push(`${of.length} ${NOUN[kind][of.length === 1 ? 0 : 1]}${cards.length ? ` (${cards.map((c) => `${cardRef(c)}`).join(', ')})` : ''}`)
  }
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** Delivery ids as a notice lists them: only ids Hive made ("m12"), at most 20 (then "and n more"). */
function idList(items: readonly NoticeItem[]): string {
  const ids = [...new Set(items.map((i) => i.id).filter((id) => /^m\d{1,12}$/.test(id)))]
  return ids.length > 20 ? `${ids.slice(0, 20).join(', ')} and ${ids.length - 20} more` : ids.join(', ')
}

/**
 * The notice for what an agent has unread, at a checkpoint, before its turn ends, or as the doorbell. Empty when there is
 * nothing. One line: the doorbell is typed as the CLI's prompt. With anything to ack (#903, #1530: not only card events
 * and notices, deliveries.ts' needsAck), each says to act on it, then ack.
 */
export function inboxNotice(at: NoticeAt, items: readonly NoticeItem[]): string {
  if (!items.length) return ''
  const what = `${noticeCounts(items)} (${idList(items)})`
  const it = items.length === 1 ? 'it' : 'them'
  const ack = items.some((i) => i.kind !== 'card-event' && i.kind !== 'control')
  if (at === 'checkpoint') return `${NOTICE_PREFIX}New in your inbox: ${what}. Call hive_inbox now to read ${it}${ack ? `; act on ${it} and ack ${it}` : ''}, then carry on.`
  if (at === 'drain') return `${NOTICE_PREFIX}Before you finish: your inbox has ${what} you haven't read. Call hive_inbox${ack ? `, act on ${it} and ack ${it}` : ` and act on ${it}`} before you end your turn.`
  return `${NOTICE_PREFIX}New in your inbox: ${what}. Call hive_inbox to read ${it}${ack ? `, act on ${it}, then ack ${it}` : ''}.`
}

/**
 * The Assistant's notice before its turn ends with lanes running and no watch covering them (HI-2069), by their builders'
 * names: Hive's fixed text, with names kept to what agent names hold (letters, digits, spaces, `.`, `_`, `-`; at most 40
 * characters, 10 names, then "and n more"), since Codex takes it as a developer message. A name with nothing left of it
 * (an emoji's) is counted among the more, or alone as "1 lane" (HR1's round 1: a lane is never dropped for its name).
 * Empty with no lanes.
 */
export function unwatchedLanesNotice(builders: readonly string[]): string {
  if (!builders.length) return ''
  const cleaned = builders.map((b) => b.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40))
  const names = [...new Set(cleaned.filter(Boolean))]
  const more = Math.max(0, names.length - 10) + cleaned.filter((n) => !n).length
  const shown = names.length ? `${names.slice(0, 10).join(', ')}${more ? ` and ${more} more` : ''}` : `${more} lane${more === 1 ? '' : 's'}` // i18n-ignore: agent-facing
  return `${NOTICE_PREFIX}Lanes are running (${shown}) and nothing will wake you about them: watch the lanes (hive_wait_for_tasks with lanes ["all"], wake) before you finish.`
}
