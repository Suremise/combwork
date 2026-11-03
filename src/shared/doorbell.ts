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
import { agentList, agentMsg, say } from './agentText'

/** Where the agent is told: a checkpoint (a tool call ended), before its turn ends (Stop), or typed while it is idle. */
export type NoticeAt = 'checkpoint' | 'drain' | 'doorbell'

/** What a notice names of a delivery: its id, kind and card (never its body or sender). */
export interface NoticeItem {
  id: string
  kind: DeliveryKind
  card?: number
}

/** Hive's notices begin with this, as its other lines do. */
// agent-protocol: the fixed prefix of Hive's lines, which agents and code tell them by
export const NOTICE_PREFIX = '[Hive] '
/**
 * What the doorbell and the checkpoint's notice say first, after the prefix: fixed, outside the catalogue (dialects,
 * HI-2437), since code finds the doorbell by it (isDoorbell: a prompt typed into an idle agent), as does the session
 * contract's inbox rule, which quotes it. A dialect words only what follows.
 */
// agent-protocol: the doorbell's fixed opening, which isDoorbell matches and the contract quotes
export const DOORBELL_PREFIX = `${NOTICE_PREFIX}New in your inbox: `

/** Whether a prompt is the doorbell (typed into an idle agent): by its fixed opening, never the words after it. */
export const isDoorbell = (text: string): boolean => text.startsWith(DOORBELL_PREFIX)

const T = {
  task: agentMsg({ id: 'doorbell.count.task', text: '{n, plural, one {# task} other {# tasks}}{cards}', note: 'Tasks waiting in the inbox, in a notice\'s counts. cards: " (HI-12, HI-14)", the cards they are about, or nothing.' }),
  handover: agentMsg({ id: 'doorbell.count.handover', text: '{n, plural, one {# handover} other {# handovers}}{cards}', note: 'Handovers waiting in the inbox, in a notice\'s counts. cards: " (HI-12)", or nothing.' }),
  answer: agentMsg({ id: 'doorbell.count.answer', text: '{n, plural, one {# answer} other {# answers}}{cards}', note: "The user's answers waiting in the inbox, in a notice's counts. cards: \" (HI-12)\", or nothing." }),
  rebrief: agentMsg({ id: 'doorbell.count.message', text: '{n, plural, one {# message} other {# messages}}{cards}', note: 'Messages (from the user, an agent or Hive: a brief, a lane change) waiting in the inbox, in a notice\'s counts. cards: " (HI-12)", or nothing.' }),
  'card-event': agentMsg({ id: 'doorbell.count.cardEvent', text: '{n, plural, one {# card event} other {# card events}}{cards}', note: 'Card events (a wake: a watched card changed) waiting in the inbox, in a notice\'s counts. cards: " (HI-12)", or nothing.' }),
  control: agentMsg({ id: 'doorbell.count.notice', text: '{n, plural, one {# notice} other {# notices}}{cards}', note: "Hive's notices waiting in the inbox, in a notice's counts. cards: \" (HI-12)\", or nothing." }),
  idsMore: agentMsg({ id: 'doorbell.ids.more', text: '{ids} and {more} more', note: 'Delivery ids in a notice past the first 20: the first 20 ("m1, m2"), then how many more.' }),
  checkpoint: agentMsg({
    id: 'doorbell.notice.checkpoint',
    text: '{what}. Call hive_inbox now to read {n, plural, one {it} other {them}}{ack, select, yes {; act on {n, plural, one {it} other {them}} and ack {n, plural, one {it} other {them}}} other {}}, then carry on.',
    note: 'After the fixed "[Hive] New in your inbox: ", in a hook\'s reply after a tool call while the agent works. what: the counts by kind with their ids ("1 task (m12)"); n: how many; ack: yes when one needs acking (#903, #1530).'
  }),
  drain: agentMsg({
    id: 'doorbell.notice.drain',
    text: 'Before you finish: your inbox has {what} you haven\'t read. Call hive_inbox{ack, select, yes {, act on {n, plural, one {it} other {them}} and ack {n, plural, one {it} other {them}}} other { and act on {n, plural, one {it} other {them}}}} before you end your turn.',
    note: 'After "[Hive] ", as the agent\'s turn ends with its inbox unread (the Stop drain). what: the counts by kind with their ids; n: how many; ack: yes when one needs acking (#903, #1530).'
  }),
  doorbell: agentMsg({
    id: 'doorbell.notice.doorbell',
    text: '{what}. Call hive_inbox to read {n, plural, one {it} other {them}}{ack, select, yes {, act on {n, plural, one {it} other {them}}, then ack {n, plural, one {it} other {them}}} other {}}.',
    note: 'The doorbell, after the fixed "[Hive] New in your inbox: ": one line typed into an idle agent as its prompt. what: the counts by kind with their ids ("1 task (m12)"); n: how many; ack: yes when one needs acking (#903, #1530).'
  }),
  lanes: agentMsg({
    id: 'doorbell.notice.lanesUnwatched',
    text: 'Lanes are running ({shown}) and nothing will wake you about them: watch the lanes (hive_wait_for_tasks with lanes ["all"], wake) before you finish.',
    note: "After \"[Hive] \": the Assistant's notice as its turn ends with lanes running and no watch on them (HI-2069). shown: the builders' names (\"HB1, HB2 and 3 more\"), or how many lanes (lanesCount)."
  }),
  namesMore: agentMsg({ id: 'doorbell.lanes.namesMore', text: '{names} and {more} more', note: "The lanes' builders past the first 10, in the unwatched lanes notice: the first 10 (\"HB1, HB2\"), then how many more." }),
  lanesCount: agentMsg({ id: 'doorbell.lanes.count', text: '{n, plural, one {# lane} other {# lanes}}', note: "The unwatched lanes notice's count of lanes when no builder's name is left to show (an emoji's)." })
}
const ORDER: readonly DeliveryKind[] = ['task', 'handover', 'answer', 'rebrief', 'card-event', 'control']

/** "1 message and 2 card events (#12, #14)": counts by kind, in a fixed order, with the cards they are about. */
export function noticeCounts(items: readonly NoticeItem[]): string {
  const parts: string[] = []
  for (const kind of ORDER) {
    const of = items.filter((i) => i.kind === kind)
    if (!of.length) continue
    const cards = [...new Set(of.map((i) => i.card).filter((c): c is number => Number.isInteger(c) && c! > 0))].sort((a, b) => a - b)
    parts.push(say(T[kind], { n: of.length, cards: cards.length ? ` (${cards.map((c) => `${cardRef(c)}`).join(', ')})` : '' }))
  }
  return agentList(parts)
}

/** Delivery ids as a notice lists them: only ids Hive made ("m12"), at most 20 (then "and n more"). */
function idList(items: readonly NoticeItem[]): string {
  const ids = [...new Set(items.map((i) => i.id).filter((id) => /^m\d{1,12}$/.test(id)))]
  return ids.length > 20 ? say(T.idsMore, { ids: ids.slice(0, 20).join(', '), more: String(ids.length - 20) }) : ids.join(', ')
}

/**
 * The notice for what an agent has unread, at a checkpoint, before its turn ends, or as the doorbell. Empty when there is
 * nothing. One line: the doorbell is typed as the CLI's prompt. With anything to ack (#903, #1530: not only card events
 * and notices, deliveries.ts' needsAck), each says to act on it, then ack.
 */
export function inboxNotice(at: NoticeAt, items: readonly NoticeItem[]): string {
  if (!items.length) return ''
  const values = { what: `${noticeCounts(items)} (${idList(items)})`, n: items.length, ack: items.some((i) => i.kind !== 'card-event' && i.kind !== 'control') ? 'yes' : 'no' }
  if (at === 'checkpoint') return DOORBELL_PREFIX + say(T.checkpoint, values)
  if (at === 'drain') return NOTICE_PREFIX + say(T.drain, values)
  return DOORBELL_PREFIX + say(T.doorbell, values)
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
  const listed = names.slice(0, 10).join(', ')
  const shown = names.length ? (more ? say(T.namesMore, { names: listed, more: String(more) }) : listed) : say(T.lanesCount, { n: more })
  return NOTICE_PREFIX + say(T.lanes, { shown })
}
