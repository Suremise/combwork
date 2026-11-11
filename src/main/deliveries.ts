import { basename, dirname, join, resolve } from 'path'
import { writeFile } from 'original-fs/promises'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { agentMsg, inDialectOf, say } from '../shared/agentText'
import { ASSISTANT_AGENT_ID } from '../shared/assistant'
import { NOTICE_PREFIX } from '../shared/doorbell'
import { CW_DIR } from '../shared/defaults'
import {
  DELIVERY_BODY_MAX_CHARS,
  DELIVERY_EXPIRY_HOURS,
  OVERDUE_MINUTES,
  deliveryRow,
  goesAlone,
  inboxItems,
  inboxSummary,
  isLive,
  isUnread,
  isWaiting,
  moved,
  needsAck,
  offerLine,
  readDelivery,
  type DeliveryKind,
  type DeliveryNeed,
  type DeliveryRecord,
  type DeliveryRow,
  type DeliverySender,
  type DeliveryState,
  type InboxItem
} from '../shared/deliveries'
import { reviewRounds } from '../shared/laneBar'
import type { ProjectConfig, TaskCard } from '../shared/types'
import { INBOX_SWITCH_ID, inboxSwitchOn, type InboxSwitch } from '../shared/inboxSwitches'
import { advanced } from './advanced'
import * as assistant from './assistantControl'
import { config } from './config'
import { onCombworkEvent } from './events'
import { placeKey, readCapped, readJson, realPath, renameRetrying, withFileLock } from './fsutil'
import { openTable, readStore, saveTable, storeValue } from './storeRows'
import { boardLock, dbGenerationAt, onDbReplaced, upgradeWaiting, withLeasedDb, workspaceDb } from './boardStore'
import { transaction } from './db'
import { addDeliveriesFile, countDeliveries, readDeliveries as readDeliveryRows, readDeliveriesWithBases, saveDeliveryChanges, StaleDeliveries } from './schema/sessionDeliveryTables'
import { canTypeLine, lineBusy, typeLine, whyNoLine } from './lineWriter'
import { createLogger, userText } from './logger'
import { readyFor } from './readiness'
import { sessions } from './sessions'
import { folderChanging, folderSteady, inFolder, onFolderSteady } from './folderFence'
import { cardsNow } from './tasks'
import { workspaceFor, WorkspaceService } from './workspace'
import { pausedFor } from './teamPause'
import { pauseHolds } from '../shared/teamPause'
import { isAdmitted, refusedOpen } from './openingFence'
import { cardRef } from '../shared/projectKeys'
import { workStartedAt } from '../shared/tasks'
import { scopeOfHost, withCardNames } from './projectKeys'
import { saidError } from './combworkError'

/**
 * The delivery service (#647, plans/2026-10-12-messaging-redesign.md §3.1). Everything Combwork has for an agent to read is a
 * delivery record (shared/deliveries.ts), saved in its session host's .combwork/deliveries.json (a project's, or the
 * Assistant's home's) with atomic writes, and restored when Combwork starts. Every way into an agent makes one (#649): a
 * message, a task, a watch's or a loop's wake, the user's decisions, a mode notice, a lock's go-ahead, the carry-on after
 * a sign-in, a handover. This service alone offers them, to an idle agent by typing the doorbell (#650: Combwork's fixed
 * words with counts and ids, shared/doorbell.ts, through lineWriter.typeLine); a busy one is told in its hooks' replies
 * instead (inboxNotices.ts). Producers neither type nor keep their own cursors.
 *
 * **Receipts.** A typed doorbell makes what it names offered. It is received only when the agent fetches it with
 * cw_inbox (#650: the doorbell carries no text, so its CLI taking the line is no receipt); never because it was typed.
 * A card event or a control notice is done then; a message, a task, a handover or the user's answer waits for the agent's
 * ack (cw_inbox), and one not acked OVERDUE_MINUTES after it was made is overdue. A doorbell its CLI took whose agent is
 * idle again without having read it rings once more (#650: its turn's Stop drain asked it first), never a third time; it
 * stays offered, unread in the pane, until it is read. One offered when Combwork stopped, or when its agent's launch ended
 * before it was read, is uncertain: it may not have reached the agent, so it is offered once more, saying it may repeat,
 * and stays uncertain (shown) if that one isn't received either.
 *
 * **No inbox** (Darren's decision on #650): an agent that can't read an inbox (`readsInbox`: a project agent while the
 * Agent API or its combwork server is off) is given no delivery, and its bodies are never typed instead: each is refused with
 * the reason its sender sees (`noInbox`: made, NoInbox; one already waiting, refused when next looked at). Only the
 * user's own action, a task they give it from Combwork (Start), is typed as their input, as their typing in its pane is: no
 * delivery, no receipt.
 *
 * **Sources.** What made a delivery (`source`: a watch, a loop wake…) registers itself here: it can make its line again
 * just before it is offered, from things as they are then (`refresh`; null: no longer due, and it is cancelled), say
 * whether it still holds before each key (`holds`), and is told when it is received (its cursor moves on then, never on
 * "typed") or ends. A live delivery's source and `ref` name it: the same one is never made twice.
 *
 * **Transactions.** Each host's records change one transaction at a time (`transact`, under the host's lock): planned on
 * a copy of what is published, with its checks (below), saved by one atomic write, and only then published, so nothing (a
 * read, the pane) ever sees a change that isn't on disk. An operation takes effect at that save: a permission change that
 * lands while it is saved applies to the next operation, not this one (it was decided before). A save that fails changes
 * nothing, on disk or in memory (NotSaved): the rename never happened. The offer's writer checks again before each piece
 * of the line and its Enter (`offerHolds`).
 *
 * **Authority.** A sender's permission is worked out again at every step, from the sender saved with it and the settings
 * now (never a closure or token): the Assistant's needs Settings → Assistant → Control at Control agents and the launch
 * that sent it still running (#645: a launch that has ended sends nothing more; its waiting messages are refused, and the
 * refusal is in the Assistant's activity list and the agent's). One is for its agent's conversation when that was known.
 *
 * **Relevance** (#652). One tied to a card's round (`card` and `round`: a re-brief for the work under way) is stale once
 * that card has moved on (passed, done or archived, out of Doing and Review, or in a later round): ended as stale, with
 * why, never offered or given: checked under the host's lock as an offer or a read is planned (`relevanceNow`, judged
 * current right before the plan and read again if the board changed meanwhile; overtaken every time, the tied ones are
 * held back unread rather than judged on an outdated read), and as the board changes (`sweepStale`), so a doorbell
 * already rung for it finds nothing. On #699 (13 Oct) the Assistant's re-brief for a round's finding reached its
 * builder a second after the card passed, and it reopened the card to apply it.
 *
 * The rules, for every operation (create, offer, readInbox, ack, cancel): **one async lock per host**, inside it copy,
 * check (sender permission, expiry, the target conversation) and change the copy, save atomically, then publish and
 * return; no check after the save. A line typed into the agent is checked again by its writer before each key with the
 * same check (`offerHolds`); one that no longer holds gets no Enter. Once typed, the doorbell is never cleared or
 * withdrawn (#652): it names ids, never what they say, so an Enter again for one that no longer holds gives the agent
 * nothing (cw_inbox checks each delivery as it reads it). One the user typed into before its CLI took it is theirs:
 * never submitted by Combwork, what it named waits again, and nothing more is typed there until a prompt is sent
 * (sessions.leaveToUser).
 */

const log = createLogger('deliveries')

/** Ended deliveries kept per agent (the newest), and for how long at most. */
const KEEP_ENDED = 50
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000
/** Received deliveries never acked are kept this long, then expire. */
const KEEP_RECEIVED_MS = 7 * 24 * 60 * 60_000
/** The most deliveries a host keeps live; more are refused when made. */
export const MAX_LIVE_PER_HOST = 500
/** The most Combwork reads back from a deliveries file; what it writes stays within fileBudget, half of it. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
let fileBudget = 4 * 1024 * 1024
/** Room kept for each live delivery to grow to its end (its times, receipt, a reason it ended). */
const GROWTH_PER_LIVE = 800
/** For tests: a smaller budget for the file. */
export const setFileBudgetForTests = (bytes: number): void => {
  fileBudget = bytes
}

/** How long until a delivery is overdue: OVERDUE_MINUTES, or an unpackaged test build's (CW_TEST_DELIVERY_OVERDUE_MS). */
export const overdueMs = (): number => {
  const t = !app.isPackaged ? Number(process.env.CW_TEST_DELIVERY_OVERDUE_MS) : NaN
  return Number.isFinite(t) && t > 0 ? t : OVERDUE_MINUTES * 60_000
}

/** The run a delivery made for a launch is offered into until that launch has started (launchWith). */
const LAUNCHING = 'launching'

/**
 * What Combwork says of a delivery (agent text, HI-2437): why it may repeat when it is offered once more (#649, said to its
 * agent with the doorbell), why it ended or went back (its `detail`, which its sender reads), and why one isn't made.
 */
const T = {
  carried: agentMsg({
    id: 'inbox.carried.notice',
    text: 'Your earlier conversation read {n, plural, one {a message} other {# messages}} it never acked ({ids}). cw_inbox shows {n, plural, one {it} other {them}} again now: act on {n, plural, one {it} other {them}}, then ack {n, plural, one {it} other {them}}.',
    note: 'HI-2463: a conversation from before the rename started fresh; what the earlier one had received and not acked is shown again in the new one. After "[CW] ". n: how many; ids: their delivery ids ("m3, m7").'
  }),
  againRestart: agentMsg({ id: 'inbox.again.restart', text: 'Combwork restarted while offering it', note: 'Why a delivery may repeat (#649), after the doorbell (inbox.offer.again): Combwork stopped while it was being offered.' }),
  againLaunch: agentMsg({ id: 'inbox.again.launch', text: 'its session ended or restarted before it was read', note: 'Why a delivery may repeat (#649), after the doorbell (inbox.offer.again), and in why it is uncertain (inbox.ended.uncertain).' }),
  uncertainRestart: agentMsg({ id: 'inbox.ended.uncertainRestart', text: 'may not have reached it: Combwork stopped while offering it', note: "Why a delivery is uncertain (#649), as its sender reads it: Combwork stopped while it was being offered; it is offered once more." }),
  uncertain: agentMsg({ id: 'inbox.ended.uncertain', text: 'may not have reached it: {why}', note: 'Why a delivery is uncertain (#649), as its sender reads it; it is offered once more. why: inbox.again.launch.' }),
  notAcked: agentMsg({ id: 'inbox.ended.notAcked', text: 'received, never acked', note: 'Why a delivery expired, as its sender reads it: its agent read it and never acked it.' }),
  replaced: agentMsg({ id: 'inbox.ended.replaced', text: 'replaced by a newer one', note: "Why a delivery was cancelled, as its sender reads it: an action's newer delivery replaced it." }),
  cancelledBy: agentMsg({ id: 'inbox.ended.cancelledBy', text: 'cancelled by {by}', note: 'Why a delivery was cancelled, as its sender reads it. by: who cancelled it (the user, an agent by name).' }),
  tooLongAgain: agentMsg({ id: 'inbox.ended.tooLong', text: 'cancelled: made again, it was too long to keep', note: 'Why a delivery was cancelled, as its sender reads it: made again from its source just before it was given, it was too long (#649).' }),
  notWanted: agentMsg({ id: 'inbox.ended.notWanted', text: 'cancelled: no longer wanted', note: 'Why a delivery was cancelled, as its sender reads it: what made it (its producer) no longer wants it given (#649).' }),
  doorbellLost: agentMsg({ id: 'inbox.ended.doorbellLost', text: 'its doorbell was lost before its CLI took it', note: 'Why a delivery waits again, as its sender reads it: the line typed into its agent was lost before its CLI took it; it rings once more.' }),
  controlDown: agentMsg({ id: 'inbox.refused.controlDown', text: 'the user turned Settings → Assistant → Control down', note: "Why a delivery the Assistant left was refused, as its sender reads it: Control no longer lets it message agents." }),
  assistantEnded: agentMsg({ id: 'inbox.refused.assistantEnded', text: "the Assistant's session that left it ended", note: 'Why a delivery the Assistant left was refused, as its sender reads it.' }),
  noInbox: agentMsg({ id: 'inbox.refused.noInbox', text: '{name} has no inbox: turn on the Agent API', note: "Why an agent that can't read an inbox is given no delivery (#650's decision), as its sender sees it. name: the agent's name." }),
  independent: agentMsg({ id: 'inbox.refused.independent', text: '{name} is Independent: Combwork gives it nothing, and the user works with it in its pane', note: "Why an Independent agent (HI-2670) is given no delivery, as its sender sees it: it takes no part in the workflow. name: the agent's name." }),
  plain: agentMsg({ id: 'inbox.refused.plain', text: "{name} runs as if started from a terminal, without Combwork's tools or typing, so it has no inbox until it restarts", note: "Why an agent is given no delivery (HI-2670), as its sender sees it: its running session launched without Combwork's tools or without Combwork typing into it (its connection's launch settings). name: the agent's name." }),
  late: agentMsg({ id: 'inbox.expired.late', text: 'not received in time', note: 'Why a delivery expired, as its sender reads it: not read before its expiry.' }),
  runEnded: agentMsg({ id: 'inbox.expired.sessionEnded', text: 'the session it was for has ended', note: 'Why a delivery for one launch of its agent expired, as its sender reads it.' }),
  otherConversation: agentMsg({ id: 'inbox.expired.otherConversation', text: 'its agent is in another conversation now', note: "Why a delivery for one conversation of its agent expired, as its sender reads it." }),
  staleGone: agentMsg({ id: 'inbox.stale.gone', text: '{card} is gone', note: "Why a delivery tied to a card's round is stale (#652), as its sender reads it. card: the card (HI-12)." }),
  staleArchived: agentMsg({ id: 'inbox.stale.archived', text: '{card} was archived', note: "Why a delivery tied to a card's round is stale (#652). card: the card (HI-12)." }),
  stalePassed: agentMsg({ id: 'inbox.stale.passed', text: '{card} passed review', note: "Why a delivery tied to a card's round is stale (#652). card: the card (HI-12)." }),
  staleDone: agentMsg({ id: 'inbox.stale.done', text: '{card} is done', note: "Why a delivery tied to a card's round is stale (#652). card: the card (HI-12)." }),
  staleLeft: agentMsg({ id: 'inbox.stale.left', text: '{card} left Doing and Review', note: "Why a delivery tied to a card's round is stale (#652). card: the card (HI-12)." }),
  staleRound: agentMsg({ id: 'inbox.stale.round', text: '{card} is in round {round} now', note: "Why a delivery tied to a card's round is stale (#652): the card has moved to a later round. card: the card (HI-12); round: its round now." }),
  roundUnread: agentMsg({ id: 'inbox.round.unreadable', text: "Combwork couldn't read {card} now.", note: "Why a message tied to a card's round (#652) isn't made: the card can't be read now (its workspace closed). card: the card (HI-12)." }),
  roundNoCard: agentMsg({ id: 'inbox.round.noCard', text: 'There is no card {card}.', note: "Why a message tied to a card's round (#652) isn't made. card: the card asked for (HI-12)." }),
  roundStale: agentMsg({ id: 'inbox.round.notInRound', text: '{why}: a message tied to its round needs it in Doing or Review.', note: "Why a message tied to a card's round (#652) isn't made. why: why the card has no round under way (inbox.stale.*)." }),
  notSent: agentMsg({ id: 'inbox.create.notSent', text: 'Not sent: {why}.', note: 'Why a delivery the Assistant left is refused when it is made. why: inbox.refused.controlDown or .assistantEnded.' }),
  tooLong: agentMsg({ id: 'inbox.create.tooLong', text: 'It is too long to give an agent ({length} characters, at most {max}).', note: "Why a delivery isn't made: its text is too long. length: its length; max: the most a delivery holds." }),
  badKey: agentMsg({ id: 'inbox.create.badKey', text: 'Not a delivery Combwork can keep: its source or key is too long.', note: "Why a delivery isn't made: what names its producer is too long to keep." }),
  projectFull: agentMsg({ id: 'inbox.create.projectFull', text: 'This project already has {max} deliveries waiting or not acked, the most Combwork keeps.', note: "Why a delivery isn't made: its project has as many live deliveries as Combwork keeps. max: that many." }),
  full: agentMsg({ id: 'inbox.create.full', text: "This project's deliveries are full (what waits for its agents and isn't acked): wait until they are received and acked, or cancel some.", note: "Why a delivery isn't made: its project's deliveries are full (the file's budget)." }),
  notSaved: agentMsg({ id: 'inbox.save.failed', text: "Combwork couldn't save the deliveries ({error}): nothing changed.", note: 'Why a change to deliveries (a message, a read, an ack, a cancel) failed. error: why the save failed (inbox.save.tooMany, .dbReplaced, or a system error).' }),
  tooMany: agentMsg({ id: 'inbox.save.tooMany', text: 'too many deliveries to keep in this project', note: "Why the deliveries couldn't be saved, in inbox.save.failed." }),
  dbReplaced: agentMsg({ id: 'inbox.save.dbReplaced', text: "the workspace's database was replaced since these deliveries were read", note: "Why the deliveries couldn't be saved, in inbox.save.failed: an upgrade or a restore replaced the database." }),
  readFailed: agentMsg({ id: 'inbox.load.failed', text: 'Could not read the deliveries ({error})', note: "Why a project's deliveries couldn't be read, from its file from before #1018. error: the system's error." }),
  changed: agentMsg({ id: 'inbox.given.changed', text: 'what it was for changed meanwhile', note: "Why a delivery wanted now (a task, a handover's step) wasn't given: its caller no longer wants it." }),
  notTyped: agentMsg({ id: 'inbox.given.notTyped', text: 'Combwork could not type it', note: "Why a delivery wanted now (a task, a handover's step) wasn't given, when nothing more is known." })
}

/** A delivery wanted now that wasn't given: its detail's opening, which deliverNow takes off again to say why. */
// agent-protocol: a fixed opening deliverNow strips from the detail (NotGiven says only why)
const NOT_GIVEN = 'not given: '

interface Store {
  host: string
  /**
   * Where its deliveries are kept (#1018): its workspace's database, under its host's scope (hostPlace); `key` its
   * workspace's real location (`placeKey`), recorded as its load entered, before anything was awaited (#1395): what every
   * decision about which workspace it is matches by, never the spelling resolved again.
   */
  place: HostPlace
  /** What is published: saved, and what every read sees. Never changed in place: a transaction replaces it. */
  records: readonly DeliveryRecord[]
  next: number
  /** Saved entries that aren't deliveries (a hand edit, a newer build's): kept aside in the file as they were, not used. */
  invalid: readonly unknown[]
  /** Transactions, one after another. */
  lock: Promise<unknown>
  /** The ids a line being typed now offers: cancelled meanwhile, its typing stops. */
  offering: Set<string>
  /**
   * The ids a typed doorbell offers, by the launch and its prompt count just before the line's Enter: taken once the count
   * rises in that launch (rung once more if its agent is idle again without reading it). Kept until it leaves offered.
   */
  confirming: Map<string, { runId: string; count: number }>
  /** Deliveries whose doorbell has rung a second time (#650): never a third. In memory: a restart offers once more anyway. */
  rungAgain: Set<string>
  /** Deliveries launched into a run whose saving may have failed (launchWith): the run they went into, by id. */
  launches: Map<string, string>
  /**
   * What the producer of a delivery gave with it (#649, in memory only: one that can't outlive its launch, such as a lock's
   * go-ahead): its own check, asked with offerHolds, and what to do once it is received or ends without that.
   */
  hooks: Map<string, DeliveryHooks>
  /** The workspace database's generation it was read from (#1207 round 2): from an older one, it is stale and never saved. */
  gen: number
  /**
   * Each delivery's row as this store last read or wrote it (#1266): a save changes only what its transaction changed,
   * and only from these, so another Combwork's receipt, ack or cancel since is never overwritten (saveDeliveryChanges).
   */
  base: Map<string, string>
}

/** A transaction's working copy: planned on, saved, then published. */
interface Draft {
  records: DeliveryRecord[]
  next: number
  invalid: unknown[]
  dirty: boolean
  /** What to do once it is published (log lines, the Assistant's activity list, sources told): nothing for a plan that isn't. */
  after: (() => void)[]
  /**
   * A revocable caller's authority (HI-2420, the Assistant's guard), set by the plan: checked again in the save's own
   * transaction, after every await of the save, so one revoked meanwhile saves nothing.
   */
  commit?: () => void
  /** What `commit` threw in the save: given to the caller as it is (the Assistant's refusal), never as NotSaved. */
  refused?: unknown
  /**
   * A producer's receipt for the delivery this plan makes (HI-2618, createDeliveryOnce): checked and written in the save's
   * own transaction, so a delivery with that key is made once, whatever happened to its row since.
   */
  once?: { key: string; at: string }
}

/** A delivery receipt's key in `store_meta` (HI-2618): `once:` and the producer's key. */
const ONCE = 'once:'
/** How long a receipt is kept (HI-2618): its producer never retries an obligation older than this (ONCE_RETRY_MS). */
export const ONCE_KEEP_MS = 30 * 24 * 60 * 60_000
/** A save finding its plan's receipt already written (HI-2618): that delivery was made, so nothing is saved. */
class OnceTaken extends Error {}

const stores = new Map<string, Store>()
const loading = new Map<string, Promise<Store>>()
/** Each load under way's workspace place, recorded as it entered (Store.place.key's, before its store exists). */
const loadingKeys = new Map<string, string>()
/**
 * A host's identity, resolved once as it entered (#1395): `host` the host's folder where it really was then (every read,
 * write and file of its deliveries goes there, never through the spelling it came by, which a junction removed or pointed
 * elsewhere since would send to another folder), `workspace` its workspace folder from that, `key` that folder's real
 * location (what decisions match by), `scope` its scope there.
 */
type HostPlace = { host: string; workspace: string; scope: string; key: string }
const keyOf = (host: string): string => host.toLowerCase()
/** A host's deliveries file before #1018: moved into its workspace's database the first time, then kept as a backup. */
const fileOf = (host: string): string => join(host, CW_DIR, 'deliveries.json')

/**
 * Where a host's deliveries are kept (#1018): its workspace's database (a project's workspace is its parent folder; the
 * Assistant's home is the workspace's `.combwork/assistant`), under the project's stable id (#508), so they follow a rename
 * as its folder's file did; the Assistant's under `assistant`, and a folder with no id yet under its name.
 */
async function hostPlace(host: string): Promise<{ workspace: string; scope: string }> {
  const h = resolve(host)
  const parent = dirname(h)
  if (basename(h).toLowerCase() === 'assistant' && basename(parent).toLowerCase() === CW_DIR) return { workspace: dirname(parent), scope: 'assistant' }
  const ws = workspaceFor(h)
  const known = ws ? (await ws.projectIds().catch(() => null))?.byPath.get(h.toLowerCase()) : undefined
  const saved = known ?? (await readJson<{ id?: unknown } | null>(join(h, CW_DIR, 'project.json'), null))?.id
  return { workspace: parent, scope: typeof saved === 'string' && saved ? saved : `folder:${basename(h).toLowerCase()}` }
}
/** The workspace a host's deliveries are kept in (hostPlace's, without its scope). */
function hostWorkspace(host: string): string {
  const h = resolve(host)
  const parent = dirname(h)
  return basename(h).toLowerCase() === 'assistant' && basename(parent).toLowerCase() === CW_DIR ? dirname(parent) : parent
}
/** A host's workspace's real location, as the host's path enters here (recorded by what it starts: #1395). */
const workspaceKeyOf = (host: string): string => placeKey(hostWorkspace(host))
/**
 * Why a host's deliveries aren't kept (#1395: no window holds its workspace, closed or never opened); null while one does.
 * A loaded host is judged by the place its store recorded, else by its path as it enters now.
 */
const hostFenced = (host: string): Error | null => (isAdmitted(stores.get(keyOf(host))?.place.key ?? workspaceKeyOf(host)) ? null : refusedOpen())
const hostClosed = (host: string): boolean => !!hostFenced(host)
const nowIso = (): string => new Date().toISOString()

/** Combwork couldn't save a change, so it wasn't made. */
export class NotSaved extends Error {}
/** A delivery refused because too many of its kind wait already for its agent (NewDelivery.maxWaiting). */
export class TooManyWaiting extends Error {}
/** A delivery refused because its project's deliveries are full (MAX_LIVE_PER_HOST, or the file's budget). */
export class DeliveriesFull extends Error {}
/** A delivery wanted now (deliverNow) that couldn't be given: why. It was cancelled. */
export class NotGiven extends Error {}

/** How a delivery is given out: typed as an offer, or handed out by a read (cw_inbox; the notices counting what it would give). */
export type HandOut = 'offer' | 'read'

/**
 * A producer's part in its deliveries (#649), registered once by name (`source` on the delivery): made again just before
 * it is offered or handed out (`refresh`: the line from things as they are now, with what its receipt will need, `meta`,
 * saved on the delivery as that version; or cancelled when it is no longer due); checked before each piece and Enter of
 * its line (`holds`, by an offer, or as it is handed out by a read: `by`, HandOut); told when it is received (`received`:
 * its cursor moves on, from the received version's own `meta`, never from what a later refresh prepared) or ends without
 * that (`ended`). Called outside the host's lock. `holds` is pure: the notices ask it to count (countable).
 */
export interface DeliverySource {
  refresh?: (r: DeliveryRecord, host: string) => Promise<Fresh | null>
  holds?: (r: DeliveryRecord, host: string, by: HandOut) => boolean
  received?: (r: DeliveryRecord, host: string) => void
  ended?: (r: DeliveryRecord, host: string) => void
  /** HI-2915: its agent acked it (dealt with it), once, as saved; `ended` stays for one that ended unread. */
  acked?: (r: DeliveryRecord, host: string) => void
}
const sources = new Map<string, DeliverySource>()
/** What a source says of a delivery made again: its text and context as they are now (one version), or why it is cancelled. */
type Fresh = { body: string; meta?: Record<string, string | number | boolean> } | { cancel: string }

/** A producer's own part in one delivery, given when it is made (in memory only): see Store.hooks. */
export interface DeliveryHooks {
  holds?: () => boolean
  received?: () => void
  ended?: () => void
}
/** Registers a producer's part (once per name; again replaces it). */
export function registerSource(name: string, s: DeliverySource): void {
  sources.set(name, s)
}

/** Told of the agents whose deliveries a transaction changed (HI-1706: a lane's end looking again), once it is saved. */
const changeListeners = new Set<(host: string, agents: ReadonlySet<string>) => void>()
/**
 * Listens for saved changes to deliveries: the host and the agents whose deliveries changed, after the transaction is
 * saved and published, outside the host's lock (a rolled-back plan tells nothing). Returns the unsubscribe.
 */
export function onDeliveriesChanged(fn: (host: string, agents: ReadonlySet<string>) => void): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}
function tellChanged(host: string, agents: ReadonlySet<string>): void {
  for (const fn of [...changeListeners]) {
    try {
      fn(host, agents)
    } catch (e) {
      log.warn('telling of changed deliveries', e)
    }
  }
}

/**
 * The deliveries still to reach an agent's run (HI-1706: its lane's end waits for them): queued, offered or uncertain,
 * not expired, for its conversation (or none) and for that run (or any), whether or not the gate gives them yet.
 */
export async function waitingForRun(host: string, agentId: string, run: string, conversation: string | null): Promise<DeliveryRecord[]> {
  await load(host)
  return waitingForRunNow(host, agentId, run, conversation)
}

/** waitingForRun from what this Combwork has read now, with nothing awaited (the host's deliveries loaded, else none). */
export function waitingForRunNow(host: string, agentId: string, run: string, conversation: string | null): DeliveryRecord[] {
  const now = clock()
  return (stores.get(keyOf(host))?.records ?? []).filter((r) => r.agentId === agentId && (r.state === 'queued' || r.state === 'offered' || r.state === 'uncertain') && Date.parse(r.expires) > now && (!r.conversation || !conversation || r.conversation === conversation) && (!r.forRun || r.forRun === run))
}

/** Runs fn after the host's transactions before it (and before later ones). */
function locked<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const run = store.lock.then(fn)
  store.lock = run.catch(() => undefined)
  return run
}

/**
 * A transaction (see the top): `plan` checks and changes a copy of what is published (synchronously, under the host's
 * lock); a copy it changed is saved (`save`: one atomic write) and then published, and `plan`'s result returned. A plan
 * that throws, or a save that fails (NotSaved), leaves the deliveries file and what is published as they were.
 */
function transact<T>(store: Store, plan: (d: Draft) => T): Promise<T> {
  return transactAfter(store, async () => undefined, (d) => plan(d))
}

/**
 * A transaction whose plan needs something read first, under the host's lock (#652: the cards that deliveries tied to a
 * round are for): `read` runs once the lock is held, so from what is published then (a delivery made while it waited
 * included), and again while `again` says what it read was overtaken (at most READS times). `again` is asked last with
 * nothing awaited between it and the plan, so the plan knows whether what it was given is still current (it says so
 * itself, from the same check).
 */
function transactAfter<P, T>(store: Store, read: () => Promise<P>, plan: (d: Draft, got: P) => T, again?: (got: P) => boolean): Promise<T> {
  running++
  return locked(store, async () => {
    let got = await read()
    await beforePlan?.()
    for (let i = 1; i < READS; i++) {
      if (!again?.(got)) break
      got = await read()
      await beforePlan?.()
    }
    for (let tries = 1; ; tries++) {
      // From here to the save, nothing is awaited: the plan is made from `got` as `again` last judged it.
      const d: Draft = { records: [...store.records], next: store.next, invalid: [...store.invalid], dirty: false, after: [] }
      const planned = plan(d, got)
      if (!d.dirty) return planned
      try {
        await save(store, d)
      } catch (e) {
        // Another Combwork changed a row this plan changed, since this store read it (#1266): nothing was saved. The host's
        // deliveries are read again and the plan made again on them (its receipt, ack or cancel kept), a few times at most.
        if (e instanceof StaleDeliveries && tries < STALE_TRIES) {
          await reread(store)
          continue
        }
        // The caller's authority refused it (HI-2420): its own refusal, nothing saved.
        if (d.refused !== undefined) throw d.refused
        throw new NotSaved(say(T.notSaved, { error: (e as Error).message }), { cause: e })
      }
      const was = new Set(store.records)
      store.records = d.records
      store.next = d.next
      store.invalid = d.invalid
      for (const f of d.after) f()
      if (changeListeners.size) {
        const agents = new Set(d.records.filter((r) => !was.has(r)).map((r) => r.agentId))
        if (agents.size) queueMicrotask(() => tellChanged(store.host, agents))
      }
      return planned
    }
  }).finally(() => running--)
}

/** How many times a transaction is planned and saved, at most, while another Combwork keeps changing what it changes. */
const STALE_TRIES = 4

/** A host's deliveries read again from its workspace's database (another Combwork saved since): what the store has is replaced. */
async function reread(store: Store): Promise<void> {
  const read = await readSaved(store.place)
  store.records = read.records
  store.next = read.next
  store.invalid = read.invalid
  store.base = read.base
}

/** How many times a transaction's read is made, at most, when what it read keeps being overtaken (transactAfter). */
const READS = 5
/** For tests: run after a transaction's read, before it is judged current and planned (to change the board between them). */
let beforePlan: (() => Promise<void> | void) | null = null
export const setBeforePlanForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforePlan = fn
}
/** For tests: awaited as a host's load begins, before anything is read (a read held up, as a slow disk would). */
let beforeRead: (() => Promise<void> | void) | null = null
export const setBeforeReadForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeRead = fn
}

/** Transactions not finished yet (also those nothing waits for): what settled() waits for. */
let running = 0
/** Whether the service has a change in flight (watches' and loop wakes' settled() wait for it, #570). */
export const inFlightNow = (): boolean => running > 0 || trying.size > 0
/** Resolves once no change or offer is in flight, and what sources were told of them has run. */
export async function settled(): Promise<void> {
  while (inFlightNow()) {
    await Promise.allSettled([...stores.values()].map((s) => s.lock))
    await Promise.allSettled([...trying.values()])
    await new Promise((r) => setImmediate(r))
  }
}

/** A transaction nothing waits for (one that follows what happened); a failure is logged. */
function transactSoon(store: Store, what: string, plan: (d: Draft) => unknown): void {
  transact(store, plan)
    .then(() => showAll(store))
    .catch((e) => log.warn(what, e))
}

/**
 * A host's deliveries, loaded once and restored: each one not received yet checked again (refused, expired), and one
 * offered when Combwork stopped uncertain (it may not have reached its agent: offered once more, #649).
 */
export function load(host: string): Promise<Store> {
  const k = keyOf(host)
  const had = stores.get(k)
  if (had) return isAdmitted(had.place.key) ? Promise.resolve(had) : Promise.reject(refusedOpen())
  const going = loading.get(k)
  if (going) return going
  // The host where it really is, and its workspace's place, resolved now, before anything is awaited (#1395): what the
  // load reads and its store keeps reading and writing, whatever the spelling points at later. A closed workspace's
  // deliveries aren't read (#1391): restored when a window opens it again.
  const real = realPath(host)
  const key = workspaceKeyOf(real)
  if (!isAdmitted(key)) return Promise.reject(refusedOpen())
  const p = (async () => {
    await beforeRead?.()
    const place: HostPlace = { ...(await hostPlace(real)), host: real, key }
    for (let tries = 1; ; tries++) {
      const gen = dbGenerationAt(key)
      const read = await readSaved(place)
      if (stores.has(k)) return stores.get(k)!
      const store: Store = { host, place, records: read.records, next: read.next, invalid: read.invalid, lock: Promise.resolve(), offering: new Set(), confirming: new Map(), rungAgain: new Set(), launches: new Map(), hooks: new Map(), gen, base: read.base }
      // Restored before anything else sees it (a second load waits for this one).
      await transact(store, (d) => {
        for (const r of [...d.records]) if (r.state === 'offered') set(store, d, r, 'uncertain', say(T.uncertainRestart), undefined, { again: inDialectOf({ projectPath: store.host, agentId: r.agentId }, () => say(T.againRestart)) })
        recheck(store, d)
      }).catch((e) => log.warn('restoring deliveries', e))
      if (stores.has(k)) return stores.get(k)!
      if (gen !== dbGenerationAt(key)) {
        // The database replaced meanwhile (the upgrade to 1.0, a restore): read again, from the file as it is now, while
        // its workspace is still open; closed meanwhile, the stale read is kept by nobody (its saves are refused anyway).
        if (!workspaceFor(host)) return store
        if (tries < 3) continue
      }
      // Its workspace closed while it was read (#1391): kept by nobody, so no tick works on it.
      if (!isAdmitted(key)) return store
      stores.set(k, store)
      showAll(store)
      // A card that moved on while Combwork was closed: what was tied to its round is stale now (#652).
      if (store.records.some((r) => r.round && isUnread(r))) sweepStale()
      return store
    }
  })().finally(() => {
    if (loading.get(k) !== p) return
    loading.delete(k)
    loadingKeys.delete(k)
  })
  loading.set(k, p)
  loadingKeys.set(k, key)
  return p
}

/**
 * A host's deliveries as saved in its workspace's database (#1018), moved in from its deliveries.json the first time:
 * each checked as it is read back; one that isn't valid is kept aside, not used.
 */
async function readSaved(place: HostPlace): Promise<{ records: DeliveryRecord[]; next: number; invalid: unknown[]; base: Map<string, string> }> {
  const file = fileOf(place.host)
  let raw: unknown[]
  let value: (key: string) => string | null
  // The rows' texts as read (none while the upgrade waits: nothing is saved then).
  let base = new Map<string, string>()
  if (upgradeWaiting(place.workspace)) {
    // The workspace's upgrade to 1.0 waits (#1207): its file is 0.9's, its deliveries rows of store_rows; nothing is moved in.
    const data = readStore(place.workspace, 'deliveries', place.scope)
    raw = data.rows.map((r) => JSON.parse(r.doc) as unknown)
    value = (key) => data.meta.get(key) ?? null
  } else {
    // In their own table since 1.0 (#1211), deliveries.json moved in the first time (its next id and entries kept aside with it).
    await openTable(place.workspace, 'deliveries', place.scope, file, () => readFileOf(place.host), DELIVERIES_TABLE)
    // The rows, their bases and the values beside them, read in one read transaction (one snapshot, #1266 round 3): a
    // record and its base are the same row's, never two reads another Combwork committed between.
    const db = workspaceDb(place.workspace).reader
    db.exec('BEGIN')
    try {
      ;({ raw, base, value } = readRows(db, place.scope))
    } finally {
      db.exec('COMMIT')
    }
  }
  return parsedRows({ raw, base, value })
}

/** A host's delivery rows, their bases and the values beside them, on the connection given (in the caller's transaction). */
function readRows(db: Parameters<typeof readDeliveriesWithBases>[0], scope: string): { raw: unknown[]; base: Map<string, string>; value: (key: string) => string | null } {
  const read = readDeliveriesWithBases(db, scope)
  const values = new Map<string, string | null>()
  for (const key of ['invalid', 'next']) values.set(key, storeValue(db, 'deliveries', scope, key))
  return { raw: read.records, base: read.bases, value: (key) => values.get(key) ?? null }
}

/** Saved delivery rows as records, each checked as it is read back (one that isn't valid kept aside), and the next id. */
function parsedRows({ raw, base, value }: { raw: unknown[]; base: Map<string, string>; value: (key: string) => string | null }): { records: DeliveryRecord[]; next: number; invalid: unknown[]; base: Map<string, string> } {
  const kept = value('invalid')
  const savedNext = value('next') !== null ? (JSON.parse(value('next')!) as unknown) : undefined
  const records: DeliveryRecord[] = []
  const invalid: unknown[] = kept ? [...(JSON.parse(kept) as unknown[])] : []
  for (const v of raw) {
    const r = readDelivery(v)
    if (r && !records.some((x) => x.id === r.id)) records.push(r)
    else invalid.push(v)
  }
  if (records.length < raw.length) log.warn(`${raw.length - records.length} saved deliver${raw.length - records.length === 1 ? 'y is' : 'ies are'} not valid: kept aside, not used`)
  const top = records.reduce((m, r) => Math.max(m, r.seq), 0)
  const next = Number.isInteger(savedNext) && (savedNext as number) > top ? (savedNext as number) : top + 1
  return { records, next, invalid, base }
}

/** The deliveries' side of a move in (openTable): how many a host has, and a file's written beside them. */
const DELIVERIES_TABLE = {
  count: (db: ReturnType<typeof workspaceDb>['writer'], scope: string) => countDeliveries(db, scope),
  put: (db: ReturnType<typeof workspaceDb>['writer'], scope: string, got: { deliveries: unknown[]; next: unknown; invalid: unknown[] }) => addDeliveriesFile(db, scope, got)
}

/**
 * A host's deliveries.json from before #1018, read to move it in: null when there is none. One too big to be Combwork's, or
 * damaged, is set aside (renamed, never overwritten) and nothing is moved in.
 */
async function readFileOf(host: string): Promise<{ deliveries: unknown[]; next: unknown; invalid: unknown[] } | null> {
  const file = fileOf(host)
  let got: { data: Buffer; more: boolean }
  try {
    got = await readCapped(file, MAX_FILE_BYTES)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw saidError(T.readFailed, { error: (e as Error).message }, { cause: e })
  }
  let data: { next?: unknown; deliveries?: unknown; invalid?: unknown } | null = null
  try {
    if (!got.more) data = JSON.parse(got.data.toString('utf8'))
  } catch {
    data = null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    // Not Combwork's (too big, or damaged): set aside, never overwritten, and started again.
    const to = `${file}.${got.more ? 'too-big' : 'damaged'}-${Date.now()}`
    await renameRetrying(file, to)
    log.warn(`The deliveries file was ${got.more ? 'too big' : 'damaged'}: set aside as ${userText(to)}`)
    return { deliveries: [], next: undefined, invalid: [] }
  }
  return { deliveries: Array.isArray(data.deliveries) ? data.deliveries : [], next: data.next, invalid: Array.isArray(data.invalid) ? [...data.invalid] : [] }
}

/** The file's text for a draft. */
const fileText = (d: Pick<Draft, 'records' | 'next' | 'invalid'>): string => JSON.stringify({ version: 1, next: d.next, deliveries: d.records, ...(d.invalid.length ? { invalid: d.invalid } : {}) }, null, 2) + '\n'

/**
 * Whether a draft fits the file's budget, with room for each live delivery to grow to its end (times, a reason): what
 * Combwork writes stays well under what it reads back (MAX_FILE_BYTES), so a file it wrote is never set aside as too big.
 */
const fits = (d: Draft): boolean => Buffer.byteLength(fileText(d)) + d.records.filter(isLive).length * GROWTH_PER_LIVE <= fileBudget

/** Makes room in the budget by dropping the oldest ended deliveries (their history), if need be. False if it still doesn't fit. */
function makeRoom(d: Draft): boolean {
  while (!fits(d)) {
    const oldest = d.records.filter((r) => !isLive(r)).sort((a, b) => a.seq - b.seq)[0]
    if (!oldest) return false
    d.records = d.records.filter((r) => r !== oldest)
    d.dirty = true
  }
  return true
}

/** For tests: run before each save (to fail it, or hold it). */
let beforeSave: (() => Promise<void> | void) | null = null
export const setBeforeSaveForTests = (fn: (() => Promise<void> | void) | null): void => {
  beforeSave = fn
}

/**
 * Saves a draft as the host's deliveries: one transaction in its workspace's database (#1018), writing the deliveries
 * that changed, so a failure leaves them as they were. Its size is still bounded as the file's was.
 */
async function save(store: Store, d: Draft): Promise<void> {
  await beforeSave?.()
  prune(store, d)
  const file = fileOf(store.place.host)
  // Entries kept aside that would push it over: moved to a file of their own (never lost), not kept in this one.
  if (!makeRoom(d) && d.invalid.length) {
    const aside = `${file}.kept-aside-${Date.now()}-${randomBytes(3).toString('hex')}`
    await writeFile(aside, JSON.stringify({ version: 1, invalid: d.invalid }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    d.after.push(() => log.warn(`Saved deliveries that aren't valid moved to ${userText(aside)}, to keep the file small enough`))
    d.invalid = []
  }
  // What is written is what reads back (#649): one check, readDelivery's, for saving and restoring alike; a record it
  // wouldn't read back fails the save (nothing changes), never a delivery lost on the next start.
  // agent-protocol: a mistake in Combwork's code (a record it made that doesn't read back), for the log and its bug report
  for (const r of d.records) if (!readDelivery(JSON.parse(JSON.stringify(r)))) throw new Error(`delivery ${r.id} isn't one Combwork could read back`)
  const text = fileText(d)
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw saidError(T.tooMany)
  // Read from a database since replaced (the upgrade to 1.0, a restore): never saved over what the file has now.
  const guard = (): void => {
    if (store.gen !== dbGenerationAt(store.place.key)) throw saidError(T.dbReplaced)
    try {
      d.commit?.()
    } catch (e) {
      d.refused = e
      throw e
    }
  }
  // Only what this transaction changed (#1211's rows), the next id and the entries kept aside beside them, in one
  // transaction, against the rows as they are committed (#1266): a row another Combwork changed since this store read it
  // fails the save (StaleDeliveries: planned again on the rows as they are), its rows saved since are never touched, and
  // a new delivery whose id it took takes the next free one (made here, before it is published).
  const was = new Map(store.records.map((r) => [r.id, r]))
  const now = new Set(d.records.map((r) => r.id))
  const changed = d.records.filter((r) => was.get(r.id) !== r) as unknown as Record<string, unknown>[]
  const removed = [...was.keys()].filter((id) => !now.has(id))
  let saved: ReturnType<typeof saveDeliveryChanges> = { written: new Map(), renamed: new Map() }
  const once = d.once
  await saveTable(
    store.place.workspace,
    'deliveries',
    store.place.scope,
    (db) => {
      // Its receipt (HI-2618), read in this transaction against what is committed: one there means its delivery was made
      // (by another pass, another Combwork, or before a restart), and nothing of this plan is saved.
      if (once && storeValue(db, 'deliveries', store.place.scope, ONCE + once.key) !== null) throw new OnceTaken(once.key)
      saved = saveDeliveryChanges(db, store.place.scope, { put: changed, removed, base: store.base })
      // Receipts past their keeping go (their producers no longer retry them).
      db.prepare("DELETE FROM store_meta WHERE store = 'deliveries' AND scope = ? AND substr(key, 1, 5) = ? AND json_extract(value, '$.at') < ?").run(store.place.scope, ONCE, new Date(Date.now() - ONCE_KEEP_MS).toISOString()) // agent-protocol: SQL
    },
    { next: JSON.stringify(d.next), invalid: d.invalid.length ? JSON.stringify(d.invalid) : null, ...(once ? { [ONCE + once.key]: JSON.stringify({ at: once.at }) } : {}) },
    guard
  )
  for (const r of d.records) {
    const to = saved.renamed.get(r.id)
    if (!to) continue
    // The same record (what the transaction returns is it): its id is the one saved.
    Object.assign(r, to)
    d.next = Math.max(d.next, to.seq + 1)
  }
  // What this store now last wrote: the rows it saves next are changed only from these.
  const base = new Map(store.base)
  for (const id of removed) base.delete(id)
  for (const [id, row] of saved.written) base.set(id, row)
  store.base = base
}

/** Ended deliveries beyond what is kept (per agent, by age) go; received ones never acked expire after a week. */
function prune(store: Store, d: Draft): void {
  const now = Date.now()
  for (const r of [...d.records]) if (r.state === 'received' && needsAck(r.kind) && now - Date.parse(r.received ?? r.created) > KEEP_RECEIVED_MS) set(store, d, r, 'expired', say(T.notAcked))
  const ended = new Map<string, DeliveryRecord[]>()
  for (const r of d.records) if (!isLive(r)) ended.set(r.agentId, [...(ended.get(r.agentId) ?? []), r])
  const drop = new Set<DeliveryRecord>()
  for (const list of ended.values()) {
    list.sort((a, b) => b.seq - a.seq)
    list.forEach((r, i) => {
      if (i >= KEEP_ENDED || now - Date.parse(r.ended ?? r.acked ?? r.received ?? r.created) > KEEP_ENDED_MS) drop.add(r)
    })
  }
  if (drop.size) d.records = d.records.filter((r) => !drop.has(r))
}

/** Replaces a record in a draft. */
function put(d: Draft, from: DeliveryRecord, to: DeliveryRecord): void {
  const i = d.records.indexOf(from)
  if (i < 0) return
  d.records[i] = to
  d.dirty = true
}

/** Tells a delivery's source what became of it, once published and outside the lock. */
function tell(store: Store, d: Draft, r: DeliveryRecord, what: 'received' | 'ended' | 'acked'): void {
  const fn = r.source ? sources.get(r.source)?.[what] : undefined
  const hook = what === 'acked' ? undefined : store.hooks.get(r.id)?.[what]
  if (!fn && !hook) return
  d.after.push(() =>
    queueMicrotask(() => {
      try {
        fn?.(r, store.host)
        hook?.()
      } catch (e) {
        log.warn(`telling ${r.source ?? 'its producer'} that ${r.id} was ${what}`, e)
      }
    })
  )
}

/** Moves a delivery in a draft (with `extra` fields); false when that move isn't allowed. */
function set(store: Store, d: Draft, r: DeliveryRecord, to: DeliveryState, detail?: string, via?: 'inbox' | 'typed', extra: Partial<DeliveryRecord> = {}): boolean {
  if (!d.records.includes(r)) return false
  const next = moved(r, to, nowIso(), detail)
  if (!next) return false
  if (via && (to === 'received' || (to === 'acked' && !r.received))) next.receivedVia = via
  const out = { ...next, ...extra }
  put(d, r, out)
  if ((to === 'refused' || to === 'stale') && r.from.kind === 'assistant') {
    const ws = r.from.workspace
    // agent-protocol: the Assistant's activity list in its panel (the window's, in English), not text for an agent
    d.after.push(() => assistant.record(ws, { kind: 'message-agent', project: basename(store.host), agent: { id: r.agentId, name: r.agentName ?? r.agentId }, ...(r.card ? { card: r.card } : {}) }, `A message for ${r.agentName ?? r.agentId} (${r.id}) was ${to === 'stale' ? 'dropped as stale' : 'refused'}`, detail ?? 'its sender may no longer send it', { reason: to === 'stale' ? 'Dropped as stale' : 'Refused' }))
  }
  if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'uncertain' || to === 'stale') d.after.push(() => log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${detail ? `: ${userText(detail)}` : ''}`))
  // Its receipt and ack (HI-2036: only "queued" was logged, so a message read through cw_inbox at once read as queued
  // for hours): once each, as saved (a move not allowed, a read or ack again, returned above; one not saved never runs
  // its `after`), with how it was received. Never its text.
  if (to === 'received' || to === 'acked') d.after.push(() => log.info(`Delivery ${r.id} for ${userText(r.agentName ?? r.agentId)} ${to}${out.receivedVia && (to === 'received' || !r.received) ? ` (${out.receivedVia})` : ''}`))
  if ((to === 'received' || to === 'acked') && !r.received) tell(store, d, out, 'received')
  // HI-2854: a start task that carried the whole card, received: what it gave of the card is the agent's to have read.
  if ((to === 'received' || to === 'acked') && !r.received && r.kind === 'task' && r.card && typeof r.meta?.seenDecisions === 'number' && typeof r.meta?.seenComments === 'number') {
    const seen = { decisions: r.meta.seenDecisions, comments: r.meta.seenComments, at: typeof r.meta.seenAt === 'number' ? r.meta.seenAt : Date.now() }
    const card = r.card
    d.after.push(() => cardTaskReceived(store.host, r.agentId, card, seen))
  }
  // Read after the line that rang for it was marked not taken (#1514: Codex took it as queued input, late): that line was
  // taken, so its mark goes, in the launch it was offered into; a mark of another line's stays (round 1 finding).
  if ((to === 'received' || to === 'acked') && r.state === 'offered' && r.offerRun) {
    const run = r.offerRun
    d.after.push(() => sessions.lineTaken(store.host, r.agentId, run, r.id, `${r.id}, which it rang for, was read`)) // agent-protocol: for the log
  }
  else if (to === 'refused' || to === 'expired' || to === 'cancelled' || to === 'stale') tell(store, d, out, 'ended')
  if (to === 'acked') tell(store, d, out, 'acked')
  return true
}

const byId = (records: readonly DeliveryRecord[], id: string): DeliveryRecord | undefined => records.find((r) => r.id === id)

/** The time expiry is measured against (Date.now; a test's own clock). */
let clock = (): number => Date.now()
/** For tests: the clock expiry is measured against (null: Date.now). */
export const setClockForTests = (fn: (() => number) | null): void => {
  clock = fn ?? (() => Date.now())
}

/** Why this sender may no longer send what it left (null: it may). Asked at every step: before it is offered, before each piece and Enter. */
let senderRefusal = (from: DeliverySender): string | null => {
  if (from.kind !== 'assistant') return null
  if (!assistant.allows('agents')) return say(T.controlDown)
  if (sessions.liveFor(assistant.assistantHome(from.workspace), ASSISTANT_AGENT_ID)?.runId !== from.launch) return say(T.assistantEnded)
  return null
}
/**
 * Whether an agent can read its inbox (#650): the Assistant always (its own tools); a project agent through its Combwork
 * tools, which it has only while the Agent API and the built-in combwork server are on.
 */
let readsInbox = (_host: string, agentId: string): boolean => agentId === ASSISTANT_AGENT_ID || (config.settings.agentApi.enabled && config.settings.agentApi.provideCombworkMcp)
export const agentReadsInbox = (host: string, agentId: string): boolean => readsInbox(host, agentId)

/**
 * Whether one of the carrying-on switches is on for a host's agents (#1432, shared/inboxSwitches.ts): its project's own
 * over Settings → Advanced's, both read at each use (project.json as it is now, as loop wakes read it); the Assistant's
 * home has no project, so it follows Settings'.
 */
export async function inboxSwitch(host: string, which: InboxSwitch): Promise<boolean> {
  return inboxSwitchOn(which, (await inboxProject(host)).own, advanced.get<boolean>(INBOX_SWITCH_ID[which]))
}

/**
 * The host's project config, for its own switches (own null: none, as the Assistant's home, or it can't be read), and
 * whether Combwork has written it since (`changed`, asked as a line is typed: a project.json changed by hand isn't seen).
 */
export interface InboxProject {
  own: Partial<ProjectConfig> | null
  changed: () => boolean
}
let inboxProject = async (host: string): Promise<InboxProject> => {
  const ws = workspaceFor(host)
  if (!ws || ws.isAssistantHome(host) || !ws.isProjectPath(host)) return { own: null, changed: () => false }
  // Counted before it is read: a write in between counts as a change.
  const at = ws.projectConfigWrites(host)
  const own = await ws.projectConfig(host).catch(() => null)
  return { own, changed: () => ws.projectConfigWrites(host) !== at }
}
const ownProject = inboxProject
export const setInboxProjectForTests = (fn: ((host: string) => Promise<InboxProject>) | null): void => {
  inboxProject = fn ?? ownProject
}
/** Why an agent that can't read an inbox is given no delivery (#650's decision), as its sender sees it. */
const noInbox = (name: string): string => say(T.noInbox, { name })
/** Why Combwork gives an agent nothing (HI-2670: sessions.keepsOut), as its sender sees it; null when it may. */
function keptOut(host: string, agentId: string, name: string): string | null {
  const why = sessions.keepsOut(host, agentId)
  return why ? say(why === 'independent' ? T.independent : T.plain, { name }) : null
}
/** A delivery refused because its agent can't read an inbox: the message says so, and what to do. */
export class NoInbox extends Error {}
/** For tests: whether agents can read their inbox (null: as the settings say). */
export const setReadsInboxForTests = (fn: ((host: string, agentId: string) => boolean) | null): void => {
  readsInbox = fn ?? ((_host, agentId) => agentId === ASSISTANT_AGENT_ID || (config.settings.agentApi.enabled && config.settings.agentApi.provideCombworkMcp))
}
/** For tests: how a sender's permission is worked out. */
export const setSenderCheckForTests = (fn: (from: DeliverySender) => string | null): void => {
  senderRefusal = fn
}

/** Why a delivery not received yet may no longer be given to its agent (null: it may), and what it becomes then. */
function whyNot(store: Store, r: DeliveryRecord): { to: 'refused' | 'expired'; why: string } | null {
  const why = senderRefusal(r.from)
  if (why) return { to: 'refused', why }
  // Its agent can't read an inbox (the Agent API turned off since it was made): refused, never typed instead.
  if (!readsInbox(store.host, r.agentId)) return { to: 'refused', why: noInbox(r.agentName ?? r.agentId) }
  // Independent now, or running without Combwork's tools or typing (HI-2670): refused, its sender told why.
  const out = keptOut(store.host, r.agentId, r.agentName ?? r.agentId)
  if (out) return { to: 'refused', why: out }
  // Held by its team's pause (HI-2081): its time stands still while it is held, and is moved on at the resume.
  if (Date.parse(r.expires) <= clock() && !pauseHeld(store, r)) return { to: 'expired', why: say(T.late) }
  const live = sessions.liveFor(store.host, r.agentId)
  if (r.forRun && live?.runId !== r.forRun) return { to: 'expired', why: say(T.runEnded) }
  if (r.conversation && live?.sessionId && live.sessionId !== r.conversation) return { to: 'expired', why: say(T.otherConversation) }
  return null
}

/**
 * Follows, in a draft, what happened to deliveries not received yet: one that may no longer be given to its agent ends;
 * one whose doorbell its CLI took, with its agent idle again since without reading it, waits to ring once more (#650);
 * one offered into a launch that has ended (or another one) before it was read is uncertain, and offered once more.
 */
function recheck(store: Store, d: Draft, agentId?: string): void {
  for (const r of [...d.records]) {
    if (!isUnread(r) || (agentId && r.agentId !== agentId)) continue
    if (r.state === 'offered' && !store.offering.has(r.id)) {
      const base = store.confirming.get(r.id)
      const now = sessions.promptsTaken(store.host, r.agentId)
      // The launch it went into: as saved, or (a launch's save that failed) as followed in memory.
      const run = store.launches.get(r.id) ?? r.offerRun
      if (base && now && now.runId === base.runId && run === base.runId && now.count > base.count) {
        // Its doorbell was taken: received only once it is read (cw_inbox), or ended now if it may no longer be given
        // (#652: the doorbell isn't withdrawn, so this is where it ends). Its agent idle again without reading it (its
        // turn ended, the Stop drain's notice let pass), it rings once more.
        const no = whyNot(store, r)
        if (no) {
          set(store, d, r, no.to, no.why)
          continue
        }
        if (!store.rungAgain.has(r.id) && readyFor(sessions.liveFor(store.host, r.agentId), r.need ?? 'idle') && set(store, d, r, 'queued')) store.rungAgain.add(r.id)
        continue
      }
      // A launch still starting (its run not attached yet) is in progress, never a run that has gone: only a restart
      // (load) finds one left like that, and makes it uncertain.
      if (run === LAUNCHING) continue
      if (run && sessions.liveFor(store.host, r.agentId)?.runId !== run) {
        set(store, d, r, 'uncertain', say(T.uncertain, { why: say(T.againLaunch) }), undefined, { again: inDialectOf({ projectPath: store.host, agentId: r.agentId }, () => say(T.againLaunch)) })
        continue
      }
    }
    const no = whyNot(store, r)
    if (no) set(store, d, r, no.to, no.why)
  }
  // What has left offered keeps no check of its line's receipt.
  for (const id of [...store.confirming.keys()]) if (byId(d.records, id)?.state !== 'offered') store.confirming.delete(id)
  for (const id of [...store.launches.keys()]) if (byId(d.records, id)?.state !== 'offered') store.launches.delete(id)
  for (const id of [...store.rungAgain]) if (!isUnread(byId(d.records, id) ?? { state: 'cancelled' })) store.rungAgain.delete(id)
  for (const id of [...store.hooks.keys()]) if (!isUnread(byId(d.records, id) ?? { state: 'cancelled' })) store.hooks.delete(id)
}

/** Shows an agent's unread and overdue deliveries in its pane (only while it runs). */
function show(store: Store, agentId: string): void {
  sessions.setInbox(store.host, agentId, inboxSummary(store.records.filter((r) => r.agentId === agentId), Date.now(), overdueMs()))
}
function showAll(store: Store): void {
  for (const id of new Set(store.records.map((r) => r.agentId))) show(store, id)
}

export interface NewDelivery {
  agentId: string
  agentName?: string
  conversation?: string | null
  kind: DeliveryKind
  from: DeliverySender
  card?: number
  /** With `card`: the card's round it is for (#652, roundOf), stale once the card has moved on. */
  round?: number
  body: string
  /** How long it may wait to be received (default DELIVERY_EXPIRY_HOURS). */
  expiresMs?: number
  /** At most this many of its kind waiting for the agent (counted with it, when it is made): more is refused. */
  maxWaiting?: number
  /** What made it (a registered source) and its key there: one waiting with the same is that one (`replace`: made again from this). */
  source?: string
  ref?: string
  replace?: boolean
  meta?: Record<string, string | number | boolean>
  /** What its agent must be doing to be offered it (default idle). */
  need?: DeliveryNeed
  /** Only for this launch of its agent (a mode notice, a lock's go-ahead): it expires when that launch ends. */
  forRun?: string
  /** Why it may repeat (one Combwork may have given before: a watch read back from before #649 being typed). */
  again?: string
  /** Offered by a launch about to start (launchWith only). */
  launching?: true
  /**
   * The durable action making it (SPEC §16.4.5): one delivery per action. One this action already made is returned as it
   * is; one of the same source and ref still waiting is cancelled as replaced, never rewritten (it keeps its own action).
   */
  action?: number
}

/**
 * Whether a durable action has made its delivery (SPEC §16.4.5): one of a host's loaded here, or a row of its workspace's
 * database with the action's id (another Combwork's, or one from before a restart). That row (unique per action) is the
 * record that it was delivered: an action run again finds it and makes nothing.
 */
export function actionDelivered(host: string, action: number): boolean {
  const ws = workspaceFor(host)
  if (!ws?.path) return false
  // Action ids are a workspace database's own: only its hosts' deliveries count.
  const mine = (s: Store): boolean => s.place.workspace.toLowerCase() === resolve(ws.path!).toLowerCase()
  if ([...stores.values()].some((s) => mine(s) && s.records.some((r) => r.action === action))) return true
  try {
    return !!workspaceDb(ws.path).reader.prepare('SELECT 1 FROM deliveries WHERE action = ?').get(action) // agent-protocol: SQL
  } catch {
    // A board waiting for its upgrade has no deliveries table: none made.
    return false
  }
}

/** How many of an agent's deliveries of a kind wait to be offered. */
export const waitingCount = (host: string, agentId: string, kind: DeliveryKind): number => stores.get(keyOf(host))?.records.filter((r) => r.agentId === agentId && r.kind === kind && isWaiting(r)).length ?? 0

/**
 * Makes a delivery for an agent of a host, saved before this returns. Refused (an Error) when its sender may not send it.
 * One already waiting with the same source and ref is returned instead (made again from this one with `replace`).
 */
export async function createDelivery(host: string, nd: NewDelivery, hooks?: DeliveryHooks): Promise<DeliveryRecord> {
  const { meta, agentName } = checkedNew(host, nd)
  const store = await load(host)
  const r = await transact(store, (d) => {
    const why = senderRefusal(nd.from)
    if (why) throw saidError(T.notSent, { why })
    // An action's delivery already made (two runs of it at once here): that one.
    const made = nd.action ? d.records.find((x) => x.action === nd.action) : undefined
    if (made) return made
    let had = nd.source && nd.ref !== undefined ? d.records.find((x) => x.source === nd.source && x.ref === nd.ref && x.agentId === nd.agentId && isWaiting(x)) : undefined
    // An action's own delivery: the one waiting is replaced by a new one (each action keeps its own row).
    if (had && nd.action && nd.replace) {
      set(store, d, had, 'cancelled', say(T.replaced))
      had = undefined
    }
    if (had) {
      if (!nd.replace) return had
      const again: DeliveryRecord = { ...had, body: nd.body, ...(nd.card ? { card: nd.card } : {}), ...(meta ? { meta } : {}), ...(nd.forRun ? { forRun: nd.forRun } : {}), expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString() }
      put(d, had, again)
      return again
    }
    const rec = addNew(d, nd, meta, agentName)
    d.after.push(() => log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} queued`))
    return rec
  })
  // Its producer's own part (also for one made again from this: the newest producer's).
  if (hooks && isUnread(r)) store.hooks.set(r.id, hooks)
  show(store, nd.agentId)
  return r
}

/**
 * Makes a delivery at most once for a producer's key (HI-2618), saved before this returns: its receipt (`once`) is
 * written in the same transaction as its row, and a receipt already there makes nothing, however that delivery has fared
 * since (received, acked, pruned). One of the same source and ref still live is that one (a retry after a crash between
 * its making and its producer's own record of it). `made`: whether this call made it; `record`: it, the live one, or
 * null when it was made earlier and isn't live now. Its other checks and refusals are createDelivery's.
 */
export async function createDeliveryOnce(host: string, nd: NewDelivery & { once: string }): Promise<{ record: DeliveryRecord | null; made: boolean }> {
  if (nd.once.length > 300) throw saidError(T.badKey, undefined, { kind: 'invalid' })
  const { meta, agentName } = checkedNew(host, nd)
  const store = await load(host)
  try {
    const out = await transact(store, (d) => {
      const why = senderRefusal(nd.from)
      if (why) throw saidError(T.notSent, { why })
      const live = nd.source && nd.ref !== undefined ? d.records.find((x) => x.source === nd.source && x.ref === nd.ref && x.agentId === nd.agentId && isLive(x)) : undefined
      if (live) return { record: live, made: false }
      const rec = addNew(d, nd, meta, agentName)
      d.once = { key: nd.once, at: nowIso() }
      d.after.push(() => log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} queued, once (${userText(nd.once)})`))
      return { record: rec as DeliveryRecord | null, made: true }
    })
    show(store, nd.agentId)
    return out
  } catch (e) {
    if (e instanceof NotSaved && e.cause instanceof OnceTaken) return { record: null, made: false }
    throw e
  }
}

/**
 * Drops a host's delivery receipts whose key starts with `prefix` (HI-2618), all but `keep`: its producer can no longer
 * retry them (an episode its lane has left). Saved before this returns.
 */
export async function dropDeliveryReceipts(host: string, prefix: string, keep?: string): Promise<void> {
  const store = await load(host)
  await locked(store, () =>
    saveTable(store.place.workspace, 'deliveries', store.place.scope, (db) => {
      db.prepare("DELETE FROM store_meta WHERE store = 'deliveries' AND scope = ? AND substr(key, 1, ?) = ? AND key <> ?").run(store.place.scope, ONCE.length + prefix.length, ONCE + prefix, ONCE + (keep ?? '')) // agent-protocol: SQL
    })
  )
}

/** Whether a host's delivery receipt for `key` is saved (HI-2618), read from its workspace's database. For tests. */
export async function deliveryReceiptForTests(host: string, key: string): Promise<boolean> {
  const store = await load(host)
  return storeValue(workspaceDb(store.place.workspace).reader, 'deliveries', store.place.scope, ONCE + key) !== null
}

/** A new delivery's checks before anything is read: refused (an Error) as createDelivery says; its meta and name as kept. */
function checkedNew(host: string, nd: NewDelivery): { meta: DeliveryRecord['meta']; agentName: string | undefined } {
  // Only what reads back is saved (readDelivery's limits): a longer text is refused here, never lost on a restart.
  if (nd.body.length > DELIVERY_BODY_MAX_CHARS) throw saidError(T.tooLong, { length: String(nd.body.length), max: String(DELIVERY_BODY_MAX_CHARS) }, { kind: 'invalid' })
  if ((nd.ref?.length ?? 0) > 300 || (nd.source?.length ?? 0) > 40) throw saidError(T.badKey, undefined, { kind: 'invalid' })
  const meta = nd.meta && Object.fromEntries(Object.entries(nd.meta).slice(0, 20).map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 500) : v]))
  const agentName = nd.agentName?.slice(0, 300)
  // An agent that can't read an inbox is given none (#650's decision): refused now, with the reason its sender sees.
  if (!readsInbox(host, nd.agentId)) throw new NoInbox(noInbox(agentName ?? nd.agentId))
  // Nor one Combwork keeps out of (HI-2670): an Independent agent, or a session without Combwork's tools or typing.
  const out = keptOut(host, nd.agentId, agentName ?? nd.agentId)
  if (out) throw new NoInbox(out)
  return { meta, agentName }
}

/** A new delivery added to a draft, within its limits (how many wait, how many are live, the file's budget), or refused. */
function addNew(d: Draft, nd: NewDelivery, meta: DeliveryRecord['meta'], agentName: string | undefined): DeliveryRecord {
  // agent-protocol: for the log; its caller says it in its own words (agentMessages.ts)
  if (nd.maxWaiting !== undefined && d.records.filter((x) => x.agentId === nd.agentId && x.kind === nd.kind && isWaiting(x)).length >= nd.maxWaiting) throw new TooManyWaiting(`${nd.maxWaiting} already wait`)
  if (d.records.filter(isLive).length >= MAX_LIVE_PER_HOST) throw new DeliveriesFull(say(T.projectFull, { max: String(MAX_LIVE_PER_HOST) }))
  const seq = d.next++
  const rec: DeliveryRecord = {
    id: `m${seq}`,
    seq,
    agentId: nd.agentId,
    ...(agentName ? { agentName } : {}),
    conversation: nd.conversation || null,
    kind: nd.kind,
    from: nd.from,
    ...(nd.card ? { card: nd.card, ...(nd.round ? { round: nd.round } : {}) } : {}),
    body: nd.body,
    state: 'queued',
    created: nowIso(),
    expires: new Date(Date.now() + (nd.expiresMs ?? DELIVERY_EXPIRY_HOURS * 60 * 60_000)).toISOString(),
    ...(nd.source ? { source: nd.source, ...(nd.ref !== undefined ? { ref: nd.ref } : {}) } : {}),
    ...(meta ? { meta } : {}),
    ...(nd.need && nd.need !== 'idle' ? { need: nd.need } : {}),
    ...(nd.forRun ? { forRun: nd.forRun } : {}),
    ...(nd.again ? { again: nd.again } : {}),
    ...(nd.action ? { action: nd.action } : {}),
    // Made offered, into a launch about to start (launchWith): saved before the launch, never offered by the scheduler.
    ...(nd.launching ? { state: 'offered' as const, offered: nowIso(), offers: 1, offerRun: LAUNCHING } : {})
  }
  d.records.push(rec)
  d.dirty = true
  // Within the file's budget (ended ones' history makes room first), or not made at all.
  if (!makeRoom(d)) throw new DeliveriesFull(say(T.full))
  return rec
}

/** For tests: run inside leaveDelivery's lease, before it reads (to fail it, or to open the workspace meanwhile). */
let inLeave: (() => Promise<void> | void) | null = null
export const setInLeaveForTests = (fn: (() => Promise<void> | void) | null): void => {
  inLeave = fn
}

/**
 * A delivery left for an agent of a host whose workspace no window may hold now (#1395: the Assistant told of an
 * unexpected close Combwork finds as it starts, for each workspace of the last run): made as createDelivery makes one while
 * a window holds it. Else one read and one write, in one transaction, on a lease's connection under the board's lock (the
 * deliveries moved in first, as a load does, on that connection), with the saves' row checks: published nowhere and kept
 * by nobody (no store, no load under way), so its workspace's next open loads it. The workspace isn't admitted for it.
 * A window that opened it and loaded the host meanwhile read the host before this write: its store is read again once the
 * write has landed (loaded: reconcileLeft), so the delivery is offered from it as any other. Only a new delivery (no
 * replace, action, launch or hooks). Null: nothing saved, the workspace's upgrade to 1.0 waiting.
 */
export async function leaveDelivery(host: string, nd: NewDelivery): Promise<DeliveryRecord | null> {
  if (nd.replace || nd.action || nd.launching) throw new Error('A delivery left this way is a new one only') // agent-protocol: a mistake in Combwork's code, never shown
  // The host where it really is now, and its workspace's place, recorded as it enters, before anything is awaited: a
  // junction removed or pointed elsewhere meanwhile redirects neither the write nor its reconciliation (#1395).
  const real = realPath(host)
  const key = workspaceKeyOf(real)
  if (isAdmitted(key)) return createDelivery(host, nd)
  const { meta, agentName } = checkedNew(host, nd)
  const place: HostPlace = { ...(await hostPlace(real)), host: real, key }
  const rec = await leftOnLease(real, place, nd, meta, agentName)
  if (rec) await reconcileLeft(place)
  return rec
}

/**
 * The host whose deliveries a lease's write left, loaded meanwhile (HR6's #1395 rounds 1 and 2: a window opened its
 * workspace, by whatever spelling, and loaded it). A host's deliveries are one (workspace place, scope): its real
 * location and its scope, never the spelling a store is kept under. Each load under way of that workspace is awaited (its
 * scope known once it resolves; one starting after the write reads it anyway), then every store of that identity read
 * again from what is committed, under its lock (after its transactions before, as a save that found another Combwork's change
 * does: reread; what it holds in memory alone, offers and confirmations, is kept), and its agents shown what waits. A
 * store of another scope, or another workspace, isn't touched.
 */
async function reconcileLeft(place: HostPlace): Promise<void> {
  await Promise.allSettled([...loading].filter(([k]) => loadingKeys.get(k) === place.key).map(([, p]) => p))
  for (const store of [...stores.values()]) {
    if (store.place.scope !== place.scope || store.place.key !== place.key) continue
    try {
      await locked(store, () => reread(store))
      showAll(store)
    } catch (e) {
      log.warn('reading the deliveries again after one was left for them', e)
    }
  }
}

/** leaveDelivery's write: one transaction on a lease's connection, under the board's lock. */
function leftOnLease(host: string, place: HostPlace, nd: NewDelivery, meta: DeliveryRecord['meta'], agentName: string | undefined): Promise<DeliveryRecord | null> {
  return withLeasedDb(place.workspace, async (db) => {
    await inLeave?.()
    if (db.pending) return null
    await openTable(place.workspace, 'deliveries', place.scope, fileOf(place.host), () => readFileOf(place.host), DELIVERIES_TABLE, { db })
    return withFileLock(boardLock(place.workspace), async () =>
      transaction(db.writer, () => {
        const w = db.writer
        const read = parsedRows(readRows(w, place.scope))
        const d: Draft = { records: [...read.records], next: read.next, invalid: [...read.invalid], dirty: false, after: [] }
        const rec = addNew(d, nd, meta, agentName)
        const now = new Set(d.records.map((r) => r.id))
        const saved = saveDeliveryChanges(w, place.scope, { put: [rec as unknown as Record<string, unknown>], removed: read.records.filter((r) => !now.has(r.id)).map((r) => r.id), base: read.base })
        const to = saved.renamed.get(rec.id)
        if (to) Object.assign(rec, to)
        const value = w.prepare("INSERT INTO store_meta (store, scope, key, value) VALUES ('deliveries', ?, ?, ?) ON CONFLICT(store, scope, key) DO UPDATE SET value = excluded.value") // agent-protocol: SQL
        value.run(place.scope, 'next', JSON.stringify(Math.max(d.next, rec.seq + 1)))
        log.info(`Delivery ${rec.id} (${rec.kind}) for ${userText(nd.agentName ?? nd.agentId)} left for when its workspace opens`)
        return rec
      })
    )
  })
}

/** A delivery as it is now (null when it is gone, or its host isn't loaded). */
export const deliveryNow = (host: string, id: string): DeliveryRecord | null => byId(stores.get(keyOf(host))?.records ?? [], id) ?? null

/** An agent's deliveries, oldest first (loaded if need be). */
export async function deliveriesOf(host: string, agentId: string): Promise<DeliveryRecord[]> {
  const store = await load(host)
  return store.records.filter((r) => r.agentId === agentId).sort((a, b) => a.seq - b.seq)
}

/** A host's deliveries from a source, oldest first (only what is loaded). */
export const fromSource = (host: string, source: string): DeliveryRecord[] => (stores.get(keyOf(host))?.records ?? []).filter((r) => r.source === source).sort((a, b) => a.seq - b.seq)
/** Every loaded host's deliveries from a source, with their hosts. */
export const everyFromSource = (source: string): { host: string; r: DeliveryRecord }[] => [...stores.values()].flatMap((s) => s.records.filter((r) => r.source === source).map((r) => ({ host: s.host, r })))

/** An agent's deliveries as the Agent API shows them: unread and overdue counts, and the rows (the newest `limit`). */
export async function deliveryView(host: string, agentId: string, limit: number, textChars = 80): Promise<{ unread: number; overdue: number; deliveries: DeliveryRow[]; more?: number }> {
  const list = await deliveriesOf(host, agentId)
  const now = Date.now()
  const rows = list.map((r) => deliveryRow(r, now, textChars, overdueMs()))
  const shown = rows.slice(-limit)
  return { unread: list.filter(isUnread).length, overdue: rows.filter((r) => r.overdue).length, deliveries: shown, ...(rows.length > shown.length ? { more: rows.length - shown.length } : {}) }
}

/**
 * Whether a delivery can still be cancelled: not read yet (#650: a doorbell names it without its text, so until the agent
 * reads it, it can be taken back; one being typed stops, and cw_inbox no longer gives it).
 */
const cancellable = (r: DeliveryRecord): boolean => isUnread(r)

/** Whether an offered delivery's line has been taken by its CLI (its prompt count rose in that launch after the line's Enter). */
function taken(store: Store, r: DeliveryRecord): boolean {
  const c = store.confirming.get(r.id)
  const now = c && sessions.promptsTaken(store.host, r.agentId)
  return !!c && !!now && now.runId === c.runId && r.offerRun === c.runId && now.count > c.count
}

/**
 * Cancels an agent's deliveries not read yet (one being typed now stops; its cw_inbox no longer lists them), all of
 * them or those of `kinds` (or those `match` picks); by: who cancelled. How many.
 */
export async function cancelDeliveries(host: string, agentId: string, by: string, kinds?: readonly DeliveryKind[], match?: (r: DeliveryRecord) => boolean, commit?: () => void): Promise<number> {
  const store = await load(host)
  const n = await transact(store, (d) => {
    // A revocable caller's authority (HI-2420, the Assistant's guard): checked in the plan, and again in the save's own
    // transaction after its awaits (Draft.commit; set again on a stale save's new plan), so a refusal cancels nothing.
    commit?.()
    d.commit = commit
    let count = 0
    for (const r of [...d.records]) {
      if (r.agentId !== agentId || (kinds && !kinds.includes(r.kind)) || (match && !match(r))) continue
      if (cancellable(r) && set(store, d, r, 'cancelled', say(T.cancelledBy, { by }))) count++
    }
    return count
  })
  show(store, agentId)
  return n
}

/** Cancels a host's deliveries from a source (`ref`: only that one) not received yet, as cancelDeliveries does (`why`: the reason given). How many. */
export async function cancelFromSource(host: string, source: string, ref: string | null, why: string): Promise<number> {
  const store = stores.get(keyOf(host)) ?? (await load(host))
  const agents = new Set<string>()
  const n = await transact(store, (d) => {
    let count = 0
    for (const r of [...d.records]) {
      if (r.source !== source || (ref !== null && r.ref !== ref) || !cancellable(r)) continue
      if (set(store, d, r, 'cancelled', why)) {
        count++
        agents.add(r.agentId)
      }
    }
    return count
  })
  for (const a of agents) show(store, a)
  return n
}

/**
 * cw_inbox for an agent: its deliveries not received yet (a card's events coalesced), now received; and those received
 * before and not acked (of the kinds it acks). What may no longer be given out is refused or expired instead, checked in
 * the same transaction.
 */
export async function readInbox(host: string, agentId: string): Promise<{ items: InboxItem[]; unacked: string[] }> {
  const store = await load(host)
  const given: DeliveryRecord[] = []
  let unacked: string[] | null = null
  // The conversation reading (what a carried delivery is shown again to once: replayedTo), or its launch while its CLI
  // hasn't named the conversation yet.
  const live = sessions.liveFor(host, agentId)
  // agent-protocol: a key stored with a delivery, never shown
  const reader = live?.sessionId || (live?.runId ? `run:${live.runId}` : 'none')
  // An offered one its agent was rung for that this read didn't give (what it was made from changed again while it was
  // made again for the read: a loop wake's roles, a decision line's board) is tried again, a few times at most (#650);
  // so is one made again for this read that its source no longer held at the hand-out (HI-1687: its card changed meanwhile).
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: { give: DeliveryRecord[]; before: string[]; missed: boolean }
    try {
      // Through the one gate (#649), as a read: a reply the user no longer lets be told, a watch that has ended, a wake
      // that is someone else's now, isn't handed out.
      const gate = await mayGive(store, store.records.filter((x) => x.agentId === agentId && isUnread(x)), 'read')
      // Relevance (#652) is read under the lock, so a card that moved on while this read waited for it is seen.
      r = await transactAfter(
        store,
        () => relevanceNow(store, agentId),
        (d, rel) => {
          const held = applyRelevance(store, d, rel, agentId)
          recheck(store, d, agentId)
          const may = gate(d)
          const mine = d.records.filter((x) => x.agentId === agentId)
          const give = mine.filter((x) => may(x) && !held.has(x.id))
          // HI-2463: what the agent's earlier conversation received and didn't ack, shown again once to each conversation
          // that reads it since (still received, never acked for it), while its source still holds it: keyed to the
          // reading conversation (the Assistant's shape, HR1's round 2), so each later fresh one is shown it by itself.
          const replay = mine.filter((x) => x.state === 'received' && x.carriedFrom !== undefined && x.replayedTo !== reader && sourceHolds(store, x, 'read'))
          const before = mine.filter((x) => x.state === 'received' && needsAck(x.kind) && !replay.includes(x)).map((x) => x.id)
          for (const x of give) set(store, d, x, 'received', undefined, 'inbox')
          for (const x of replay) put(d, x, { ...x, replayedTo: reader })
          const refused = (x: DeliveryRecord): boolean => isUnread(x) && !give.includes(x) && !held.has(x.id) && !sourceHolds(store, x, 'read')
          return { give: [...give, ...replay], before, missed: mine.some((x) => (x.state === 'offered' && !give.includes(x)) || refused(x)) }
        },
        overtaken
      )
    } catch (e) {
      // Nothing received yet: the read fails, and gave nothing. A retry failing keeps what the attempts before it
      // received (saved as received): this read returns them, and what it missed waits for the next.
      if (!attempt) throw e
      log.warn(`${userText(agentId)}'s inbox read gave what it had: trying again failed`, e)
      break
    }
    given.push(...r.give)
    unacked ??= r.before
    if (!r.missed) break
  }
  show(store, agentId)
  return { items: inDialectOf({ projectPath: host, agentId }, () => inboxItems(given)), unacked: unacked ?? [] }
}

/**
 * cw_inbox ack: marks an agent's deliveries acked, once it has read them (#650: a doorbell names them by id, so an id
 * alone is no sign of reading; one not read yet is `unread`, nothing changes, and the agent reads it first). Ids that
 * aren't its own, or don't exist, are unknown (nothing said of them). Acked again: still acked.
 */
export async function ackDeliveries(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[]; unread: string[] }> {
  const store = await load(host)
  const r = await transact(store, (d) => {
    recheck(store, d, agentId)
    const acked: string[] = []
    const unknown: string[] = []
    const unread: string[] = []
    for (const id of [...new Set(ids)]) {
      const x = byId(d.records, id)
      if (!x || x.agentId !== agentId) unknown.push(id)
      else if (x.state === 'acked') acked.push(id)
      // Not read yet: read it first (never acked, nor its source told it was received, from its id alone).
      else if (isUnread(x)) unread.push(id)
      else if (x.state === 'received' && set(store, d, x, 'acked')) acked.push(id)
      // Ended without being received (cancelled, refused, expired): not for it to act on.
      else unknown.push(id)
    }
    return { acked, unknown, unread }
  })
  show(store, agentId)
  return { acked: r.acked, unknown: r.unknown, unread: r.unread }
}

/**
 * cw_inbox's combined form (#1531, opt-in: ack with read): the ack first, by ackDeliveries' own rules (an id not read
 * yet is `unread` and stays as it is; another agent's is `unknown`), then the read. What the read gives is received, never
 * acked: nothing is acked by being read, so an item listed here is acked by a later call, after acting on it.
 */
/**
 * HI-2854: the task a card was started with (`meta.cardTask`, its work cycle in `meta.cycle`), acked by its builder's
 * successful cw_start_card or cw_submit of that card: only that agent's, for that card and that cycle, and only once it
 * was received (read with cw_inbox). Everything else, a later task about the card included, stays as it is. Recorded as
 * acked like any ack, with how. The ids it acked.
 */
export async function ackCardTask(host: string, agentId: string, card: Pick<TaskCard, 'number' | 'history'>): Promise<string[]> {
  const store = await load(host)
  const cycle = workStartedAt(card)
  if (!cycle) return []
  const acked = await transact(store, (d) => {
    const out: string[] = []
    for (const x of [...d.records]) {
      if (x.agentId !== agentId || x.kind !== 'task' || x.card !== card.number || x.state !== 'received' || x.meta?.cardTask !== true || x.meta?.cycle !== cycle) continue
      // agent-protocol: how it was acked, kept with the delivery for the log and its row
      if (set(store, d, x, 'acked', 'by its start or submit of the card')) out.push(x.id)
    }
    return out
  })
  if (acked.length) show(store, agentId)
  return acked
}

/**
 * HI-2854: a card's start task that carried the whole card (`meta.seenDecisions`, `meta.seenComments`: the generations it
 * was made at) counts as the agent reading it, once received: main/servers.ts records its receipt.
 */
let cardTaskReceived: (host: string, agentId: string, card: number, seen: { decisions: number; comments: number; at: number }) => void = () => undefined
export function onCardTaskReceived(fn: typeof cardTaskReceived): void {
  cardTaskReceived = fn
}

export async function ackThenRead(host: string, agentId: string, ids: readonly string[]): Promise<{ acked: string[]; unknown: string[]; unread: string[]; items: InboxItem[]; unacked: string[] }> {
  const acked = await ackDeliveries(host, agentId, ids)
  return { ...acked, ...(await readInbox(host, agentId)) }
}

/**
 * Applies, in a draft, what sources said as their deliveries were made again: cancelled, or their text and context as
 * they are now (that version, saved with it). One already offered keeps the version it was offered as while that still
 * holds; one that no longer does is made again (#650: its doorbell named it by id, never its text, so it can be, rather
 * than never given at all). Its receipt, in the same transaction as the read, covers exactly the version read.
 */
function applyFresh(store: Store, d: Draft, fresh: Map<string, Fresh>, by: HandOut): void {
  for (const [id, f] of fresh) {
    const r = byId(d.records, id)
    if (!r || !isUnread(r)) continue
    if ('cancel' in f) set(store, d, r, 'cancelled', f.cancel)
    else if (r.state === 'offered' && eligible(store, r, by)) continue
    else if (f.body.length > DELIVERY_BODY_MAX_CHARS) set(store, d, r, 'cancelled', say(T.tooLongAgain))
    else if (f.body !== r.body || (f.meta && JSON.stringify(f.meta) !== JSON.stringify(r.meta))) put(d, r, { ...r, body: f.body, ...(f.meta ? { meta: f.meta } : {}) })
  }
}

/**
 * Whether a delivery may be given to its agent now, as far as it goes (#649): its sender may still send it, it hasn't
 * expired, it is for the agent's conversation (and launch), and its source and producer still hold it. The one check
 * the gate (mayGive) and the writer before each key (offerHolds) both ask.
 */
const eligible = (store: Store, r: DeliveryRecord, by: HandOut = 'offer'): boolean => !whyNot(store, r) && sourceHolds(store, r, by) && producerHolds(store, r) && !pauseHeld(store, r)

/**
 * The team's pause admission (HI-2081, HR1's s10 check): one of Combwork's own wakes or hand-outs (`pauseHolds`: a loop or
 * watch wake, a pool review; never the user's answer) for a project agent whose workspace is paused. Apart from its
 * validity (whyNot, its source's refresh and holds, which still end what is stale): held, it stays as it is, unread, and
 * isn't offered, typed (each key and Enter: whyOfferFails), read, counted for a notice or acked until the team resumes.
 * The Assistant's own wakes aren't held (it follows the pause).
 */
function pauseHeld(store: Store, r: DeliveryRecord): boolean {
  if (!pauseHolds(r) || workspaceFor(store.host)?.isAssistantHome(store.host)) return false
  return !!pausedFor(store.host)
}

/** Whether a delivery's source still holds it (its `holds`), for this way of giving it out; one with no source does. */
const sourceHolds = (store: Store, r: DeliveryRecord, by: HandOut): boolean => (r.source ? sources.get(r.source)?.holds?.(r, store.host, by) : undefined) !== false

/**
 * Whether a delivery's producer still wants it given (its DeliveryHooks.holds: a task while its agent is free, the
 * carry-on while the agent is stopped by its sign-in), asked before it is offered and as its line is typed. Once its
 * doorbell has been taken (#650), the agent is reading what it was rung for, at work by then: not asked again.
 */
const producerHolds = (store: Store, r: DeliveryRecord): boolean => (r.state === 'offered' && taken(store, r)) || store.hooks.get(r.id)?.holds?.() !== false

/**
 * The one gate every hand-out goes through (#649): an offer (and so the typing), cw_inbox's read and an ack of something
 * unread all ask it, so typing and pulling never disagree. Each delivery is made again from its source first (`refresh`:
 * its text as it is now, or cancelled when no longer due; what its source keeps for its receipt prepared), and one its
 * producer no longer wants is cancelled. Applied in the caller's transaction, it says of each whether it may be given out
 * (unread and eligible). Already received ones aren't its business: they can still be acked.
 */
async function mayGive(store: Store, records: readonly DeliveryRecord[], by: HandOut = 'offer'): Promise<(d: Draft) => (r: DeliveryRecord) => boolean> {
  const fresh = await refreshAll(store, records)
  for (const r of records) if (!fresh.has(r.id) && !producerHolds(store, r)) fresh.set(r.id, { cancel: say(T.notWanted) })
  return (d) => {
    applyFresh(store, d, fresh, by)
    return (r) => isUnread(r) && eligible(store, r, by)
  }
}

/**
 * What an agent has unread that a read would give it now (HI-1687), for the notices that name it (inboxNotices.ts): the
 * gate's own check (`eligible`, as a read asks it) on what is already made, with nothing made again, so counting changes
 * nothing (no source's `refresh`, no version, no wake for another agent). A delivery its source holds back until it is
 * made again (a loop wake nothing has made yet, or one whose card changed since) isn't named: the doorbell offers it.
 */
export async function countable(host: string, agentId: string): Promise<DeliveryRecord[]> {
  const store = await load(host)
  return store.records.filter((r) => r.agentId === agentId && isUnread(r) && eligible(store, r, 'read'))
}

/** A card's round under way (#652): its failed reviews plus one (the fix after a failed review is the next round). */
export const roundOf = (card: TaskCard): number => reviewRounds(card).failures + 1

/**
 * Why a delivery tied to card n's round `round` is stale (#652), from the card as it is now (null: it is gone); null when
 * it is still relevant: the card in Doing or Review, in that round.
 */
export function staleWhy(card: TaskCard | null, n: number, round: number): string | null {
  if (!card) return say(T.staleGone, { card: cardRef(n) })
  if (card.archived) return say(T.staleArchived, { card: cardRef(n) })
  if (card.column === 'passed') return say(T.stalePassed, { card: cardRef(n) })
  if (card.column === 'done') return say(T.staleDone, { card: cardRef(n) })
  if (card.column !== 'doing' && card.column !== 'review') return say(T.staleLeft, { card: cardRef(n) })
  const now = roundOf(card)
  return now > round ? say(T.staleRound, { card: cardRef(n), round: String(now) }) : null
}

/** A card as the board has it now (null: it is gone; undefined: Combwork can't tell, its workspace closed or the card unreadable). */
async function boardCard(host: string, n: number): Promise<TaskCard | null | undefined> {
  const ws = workspaceFor(host)
  if (!ws?.path) return undefined
  // Kept until it changes (HI-1780: every board change checks each unread delivery tied to a round).
  return (await cardsNow(ws, [n])).get(n)
}
let cardNow = boardCard
/** For tests: how a card is read (null: as the board has it). */
export const setCardReaderForTests = (fn: ((host: string, n: number) => Promise<TaskCard | null | undefined>) | null): void => {
  cardNow = fn ?? boardCard
}

/**
 * The round of card n a delivery made now would be tied to (#652): its round under way. Refused (an Error) when the card
 * is gone, can't be read, or isn't in Doing or Review in a round (nothing for a re-brief to be relevant to).
 */
export async function roundNow(host: string, n: number): Promise<number> {
  const card = await cardNow(host, n)
  if (card === undefined) throw saidError(T.roundUnread, { card: cardRef(n) })
  if (!card) throw saidError(T.roundNoCard, { card: cardRef(n) })
  const round = roundOf(card)
  const why = staleWhy(card, n, round)
  if (why) throw saidError(T.roundStale, { why })
  return round
}

/** Of these deliveries, those tied to a card's round that are stale now, with why (each card read once). */
async function staleOf(host: string, records: readonly DeliveryRecord[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const cards = new Map<number, TaskCard | null | undefined>()
  for (const r of records) {
    if (!r.card || !r.round || !isUnread(r)) continue
    if (!cards.has(r.card)) cards.set(r.card, await cardNow(host, r.card).catch(() => undefined))
    const card = cards.get(r.card)
    // Not known now (its workspace closed, the card unreadable): not stale on that account.
    if (card === undefined) continue
    const why = withCardNames(workspaceFor(host), () => staleWhy(card, r.card!, r.round!), scopeOfHost(host))
    if (why) out.set(r.id, why)
  }
  return out
}

/** Board changes seen (tasks-changed): a relevance read one has overtaken is read again, or not acted on (Relevance). */
let boardChanges = 0
onCombworkEvent((e) => {
  if (e.type === 'tasks-changed') boardChanges++
})

/** A relevance read (#652): which deliveries tied to a card's round are stale, and the board's changes when it began. */
interface Relevance {
  stale: Map<string, string>
  board: number
}

/**
 * A host's deliveries (an agent's, or all) tied to a card's round that are stale, read under its lock (a transactAfter's
 * `read`, with `overtaken` as its `again`): from the records published then.
 */
async function relevanceNow(store: Store, agentId?: string): Promise<Relevance> {
  const board = boardChanges
  return { stale: await staleOf(store.host, store.records.filter((r) => !agentId || r.agentId === agentId)), board }
}
/** Whether the board has changed since a relevance read began: what it found may be out of date. */
const overtaken = (rel: Relevance): boolean => rel.board !== boardChanges

/**
 * Applies a relevance read in a draft, as the plan is made (nothing awaited since transactAfter last judged it): if the
 * board is as it was read, what it found stale ends as stale; if not (overtaken READS times running), nothing is ended
 * from it, and the deliveries tied to a round (an agent's, or all) are held back: returned, to be neither given nor
 * offered by this operation, left unread for a later one.
 */
function applyRelevance(store: Store, d: Draft, rel: Relevance, agentId?: string): Set<string> {
  if (!overtaken(rel)) {
    for (const [id, why] of rel.stale) {
      const r = byId(d.records, id)
      if (r && isUnread(r)) set(store, d, r, 'stale', why)
    }
    return new Set()
  }
  const held = d.records.filter((r) => r.round && isUnread(r) && (!agentId || r.agentId === agentId)).map((r) => r.id)
  if (held.length) d.after.push(() => log.info(`Deliveries ${held.join(', ')} held back: the board kept changing while their cards were read`))
  return new Set(held)
}

/** Ends what has become stale in each loaded host (#652), as the board changes: one sweep at a time, again if asked meanwhile. */
let sweeping: Promise<void> | null = null
let sweepAgain = false
function sweepStale(): void {
  if (sweeping) {
    sweepAgain = true
    return
  }
  sweeping = (async () => {
    do {
      sweepAgain = false
      for (const store of [...stores.values()]) {
        if (!store.records.some((r) => r.round && isUnread(r))) continue
        await transactAfter(store, () => relevanceNow(store), (d, rel) => void applyRelevance(store, d, rel), overtaken).catch((e) => log.warn('ending stale deliveries', e))
        showAll(store)
      }
    } while (sweepAgain)
  })().finally(() => {
    sweeping = null
  })
}
/** For tests: ends what has become stale now, awaited. */
export async function sweepStaleForTests(): Promise<void> {
  sweepStale()
  for (let s = sweeping; s; s = sweeping) await s
}

/** An offer: its deliveries (as they were before it, to put back), the line, the launch and conversation it is for. */
interface Offer {
  ids: string[]
  was: Map<string, DeliveryRecord>
  line: string
  runId: string
  sessionId: string
  need: DeliveryNeed
}

/** What an agent must be doing to be offered these together: the one they share, else free (which every need takes). */
const needOf = (items: readonly DeliveryRecord[]): DeliveryNeed => {
  const needs = new Set(items.map((r) => r.need ?? 'idle'))
  return needs.size === 1 ? [...needs][0] : 'free'
}

/**
 * Which of an agent's waiting deliveries go in its next line (those that may still be given out and that it can take,
 * as it is now): `only` that one; else a task or handover alone (the oldest), or all the others together.
 */
function pickOffer(store: Store, records: readonly DeliveryRecord[], agentId: string, only?: string): DeliveryRecord[] {
  const live = sessions.liveFor(store.host, agentId)
  const can = records.filter((r) => r.agentId === agentId && isWaiting(r) && !whyNot(store, r) && readyFor(live, r.need ?? 'idle')).sort((a, b) => a.seq - b.seq)
  if (only) return can.filter((r) => r.id === only)
  const alone = can.find((r) => goesAlone(r.kind))
  return alone ? [alone] : can.filter((r) => !goesAlone(r.kind))
}

/**
 * Plans an offer of an agent's waiting deliveries (`items`, as picked) in a draft: offered, into this launch
 * (`offerRun`), with the line that will be typed. Null when none of them still waits.
 */
function planOffer(store: Store, d: Draft, items: readonly DeliveryRecord[], target: { runId: string; sessionId: string }, label: string | null): Offer | null {
  const now = items.map((r) => byId(d.records, r.id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r) && !whyNot(store, r))
  if (!now.length) return null
  // A watching agent is told its watch carries on, unless the line is its own watch's wake (whose receipt ends it).
  const line = withCardNames(workspaceFor(store.host), () => inDialectOf({ projectPath: store.host, agentId: now[0].agentId }, () => offerLine(now, now.some((r) => r.source === 'watch') ? null : label)), scopeOfHost(store.host))
  const was = new Map(now.map((r) => [r.id, r]))
  for (const r of now) set(store, d, r, 'offered', undefined, undefined, { offerRun: target.runId })
  return { ids: now.map((r) => r.id), was, line, runId: target.runId, sessionId: target.sessionId, need: needOf(now) }
}

/**
 * Whether an offer still holds: each still offered by it, allowed and still wanted by its source (and by its caller), and
 * its agent in the same launch and conversation.
 */
function offerHolds(store: Store, o: Offer, records: readonly DeliveryRecord[] = store.records): boolean {
  const live = sessions.liveFor(store.host, o.ids.length ? byId(records, o.ids[0])!.agentId : '')
  if (!live || live.runId !== o.runId || (o.sessionId && live.sessionId && live.sessionId !== o.sessionId)) return false
  return o.ids.every((id) => {
    const r = byId(records, id)
    return r?.state === 'offered' && r.offerRun === o.runId && eligible(store, r)
  })
}

/**
 * Why an offer no longer holds (offerHolds false), for the log (#1504): its agent's launch or conversation changed, a
 * delivery no longer offered by it, ended or no longer to be given out, or no longer wanted by its source or producer.
 * Null when it holds.
 */
function whyOfferFails(store: Store, o: Offer): string | null {
  const live = sessions.liveFor(store.host, o.ids.length ? (byId(store.records, o.ids[0])?.agentId ?? '') : '')
  if (!live || live.runId !== o.runId) return 'its launch changed' // agent-protocol: for the log (#1504: why an offer was put off)
  if (o.sessionId && live.sessionId && live.sessionId !== o.sessionId) return 'its conversation changed' // agent-protocol: for the log (#1504: why an offer was put off)
  for (const id of o.ids) {
    const r = byId(store.records, id)
    if (r?.state !== 'offered' || r.offerRun !== o.runId) return `${id} is no longer offered by it (${r?.state ?? 'gone'})` // agent-protocol: for the log (#1504: why an offer was put off)
    const not = whyNot(store, r)
    if (not) return `${id} may no longer be given out (${not})` // agent-protocol: for the log (#1504: why an offer was put off)
    if (!sourceHolds(store, r, 'offer')) return `${id} is no longer wanted by its source (${r.source})` // agent-protocol: for the log (#1504: why an offer was put off)
    if (!producerHolds(store, r)) return `${id} is no longer wanted by its producer` // agent-protocol: for the log (#1504: why an offer was put off)
    if (pauseHeld(store, r)) return `${id} is held while the team is paused` // agent-protocol: for the log (#1504: why an offer was put off)
  }
  return null
}

/** Puts an offer's deliveries back as they were (the line wasn't typed), those it still has as offered. */
function unoffer(store: Store, o: Offer): Promise<void> {
  for (const id of o.ids) store.offering.delete(id)
  return transact(store, (d) => {
    for (const id of o.ids) {
      const r = byId(d.records, id)
      const was = o.was.get(id)
      if (r?.state === 'offered' && r.offerRun === o.runId && was) put(d, r, was)
    }
    // One that may no longer be given out is ended now, not at the next try.
    recheck(store, d, byId(d.records, o.ids[0])?.agentId)
  })
    .then(() => showAll(store))
    .catch((e) => log.warn('putting deliveries back', e))
}

/** The launch the line was typed into ended (or another began) before its CLI took it: what it carried is uncertain now. */
function lost(store: Store): void {
  transactSoon(store, 'checking deliveries', (d) => recheck(store, d)) // agent-protocol: for the log
}

/** While the confirmation checks its CLI took the line: until then a cancel can still end it (and no Enter comes). */
function confirming(store: Store, o: Offer, before: { runId: string; count: number }): void {
  for (const id of o.ids) store.confirming.set(id, before)
}

/** Each source's line made again for what is about to be offered (from things as they are now): its body, or why it is cancelled. */
async function refreshAll(store: Store, items: readonly DeliveryRecord[]): Promise<Map<string, Fresh>> {
  const out = new Map<string, Fresh>()
  for (const r of items) {
    const fn = r.source ? sources.get(r.source)?.refresh : undefined
    if (!fn) continue
    try {
      // Its line names cards by key, its host's workspace's (#1219).
      // Said in the dialect of the agent it is for (HI-2437).
      const got = await inDialectOf({ projectPath: store.host, agentId: r.agentId }, () => withCardNames(workspaceFor(store.host), () => fn(r, store.host), scopeOfHost(store.host)))
      if (got) out.set(r.id, got)
    } catch (e) {
      log.warn(`making delivery ${r.id} again`, e)
    }
  }
  return out
}

const trying = new Map<string, Promise<boolean>>()

/**
 * Offers an agent's waiting deliveries now if it can take a line (one try at a time per agent); `only`: that one alone.
 * With idle wakes off (#1432) nothing waiting is offered but a task given now (`only`, deliverNow's) or what the user
 * asks for with Deliver now (`asked`). Whether a line was typed.
 */
export function offerNow(host: string, agentId: string, only?: string, asked = false): Promise<boolean> {
  // Its workspace closed: nothing is offered there until a window opens it again (#1391).
  if (hostClosed(host)) return Promise.resolve(false)
  const k = `${keyOf(host)}#${agentId}`
  const going = trying.get(k)
  // Another try under way (the tick's, which with idle wakes off types nothing): Deliver Now is the user's own, so it
  // waits for that one and then makes its own, rather than being lost.
  if (going) return going.then((typed) => (asked && !typed ? offerNow(host, agentId, only, asked) : false))
  const run = offerOnce(host, agentId, only, 1, asked).finally(() => trying.delete(k))
  trying.set(k, run)
  return run
}

/** How many moments Deliver Now waits for another line of Combwork's that has its agent (RETRY_MS each). */
const ASKED_TRIES = 10

/** How many times an offer overtaken before its first key (what it was made from changed as it was planned) is made again at once. */
const OVERTAKEN_TRIES = 3

async function offerOnce(host: string, agentId: string, only?: string, tries = 1, asked = false): Promise<boolean> {
  const store = await load(host)
  const st = sessions.liveFor(host, agentId)
  if (!st) return false
  // What may no longer be given out (its sender's permission gone, too old, another conversation) ends now, not later.
  if (store.records.some((r) => r.agentId === agentId && isUnread(r) && whyNot(store, r))) await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  // Idle wakes off (#1432): no doorbell for what waits, of any kind; it stays in the inbox, unread, for cw_inbox, the
  // agent's hooks (if their switches are on) or Deliver now. A task given now isn't a wake.
  if (!only && !asked && !(await inboxSwitch(host, 'idleWakes'))) return false
  let items = pickOffer(store, store.records, agentId, only)
  if (!items.length) return false
  if (!canTypeLine(host, agentId, needOf(items))) {
    // Deliver Now (#1432) while another line of Combwork's has the agent (being typed, or a watch's being made): it waits
    // for that one, a moment at a time, rather than being lost; anything else that stops it is logged.
    if (asked && lineBusy(host, agentId) && tries < ASKED_TRIES) {
      await new Promise((r) => setTimeout(r, RETRY_MS))
      return offerOnce(host, agentId, only, tries + 1, asked)
    }
    if (asked) log.info(`Deliver Now for ${userText(agentId)} not typed: ${whyNoLine(host, agentId, needOf(items)) ?? 'nothing to type'}`)
    // The user may still be writing there: nothing says when they stop, so it is tried again in a moment.
    if (sessions.userMayBeTyping(host, agentId)) retrySoon(host, agentId)
    return false
  }
  // Through the one gate (as cw_inbox is): each made again from things as they are now; what may not be given out
  // isn't offered.
  const gate = await mayGive(store, items)
  const label = st.status === 'watching' && st.watch ? st.watch.label : null
  // Saved as offered before the first key (checked as it is planned), and checked again before each key: if Combwork stops
  // in between it is uncertain, never "delivered". Not saved, or no longer to be given out: nothing is typed.
  let offer: Offer | null
  try {
    offer = await transactAfter(
      store,
      () => relevanceNow(store, agentId),
      (d, rel) => {
        const held = applyRelevance(store, d, rel, agentId)
        const may = gate(d)
        items = pickOffer(store, d.records, agentId, only).filter((r) => items.some((x) => x.id === r.id) && may(r) && !held.has(r.id))
        return planOffer(store, d, items, { runId: st.runId, sessionId: st.sessionId }, label)
      },
      overtaken
    )
  } catch (e) {
    log.warn(`Deliveries for ${userText(agentId)} not offered: ${(e as Error).message}`)
    show(store, agentId)
    return false
  }
  show(store, agentId)
  if (!offer || !offerHolds(store, offer)) {
    if (!offer) return false
    await unoffer(store, offer)
    // Overtaken as it was saved (#1036: the board changed after its line was made, by another agent or, seen by the
    // board's poll, another process): made again from things as they are now, at once; still overtaken, tried in a
    // moment, never left for the tick.
    if (tries < OVERTAKEN_TRIES) return offerOnce(host, agentId, only, tries + 1, asked)
    retrySoon(host, agentId)
    return false
  }
  const o = offer
  // Idle wakes turned off while it was made (#1432 round 1: a refresh, the relevance read and the save all wait): read
  // again once it is ready to type (Settings' and the project's own, read now), and before each key as it is typed
  // (Settings' as it is then; the project's own as read here, unless Combwork has written it since). Not typed: put back,
  // still unread.
  const wake = !only && !asked
  const project = wake ? await inboxProject(host) : null
  // The project's own changed since it was read: not typed now (made again at the retry, from the config as it is then).
  const wakesOn = (): boolean => !project?.changed() && inboxSwitchOn('idleWakes', project?.own ?? null, advanced.get<boolean>(INBOX_SWITCH_ID.idleWakes))
  if (wake && !wakesOn()) {
    await unoffer(store, o)
    show(store, agentId)
    return false
  }
  for (const id of o.ids) store.offering.add(id)
  let typed = false
  // Why the line was put off as it was typed, when the offer stopped holding (#1504: Deliver Now gave up silently).
  let putOff: string | null = null
  const wanted = (): boolean => {
    const why = whyOfferFails(store, o) ?? (o.ids.every((id) => store.offering.has(id)) ? null : 'its offer was ended') ?? (!wake || wakesOn() ? null : 'idle wakes were turned off') // agent-protocol: for the log (#1504: why an offer was put off)
    if (why) putOff ??= why
    return !why
  }
  try {
    typed = await typeLine(host, agentId, o.line, wanted, {
      need: o.need,
      // A line the user typed into before its CLI took it is theirs (#652 round 1 finding 2): what it named waits again.
      follow: {
        confirming: (before) => confirming(store, o, before),
        lost: () => lost(store),
        left: () => void unoffer(store, o),
        // Read since (#1514): its CLI took the line, whether or not it told of a prompt (Codex's queued input).
        read: () => o.ids.some((id) => {
          const r = byId(store.records, id)
          return r?.state === 'received' || r?.state === 'acked'
        }),
        // Kept with a mark that it wasn't taken: only these deliveries' read clears it (#1514 round 1 finding).
        ids: o.ids
      }
    })
  } finally {
    for (const id of o.ids) store.offering.delete(id)
    // Not typed: put back (and ended, if it may no longer be given out) before this returns, so a reply says so; what
    // its source no longer has due (what it was made from changed as it was typed) ends now too, not at the next try.
    if (typed) log.info(`Deliveries ${o.ids.join(', ')} for ${userText(agentId)} offered`)
    else {
      if (asked) log.info(`Deliver Now for ${userText(agentId)} put off as it was typed: ${putOff ?? 'its line was not taken'}`)
      await unoffer(store, o)
      await dropUndue(store, o.ids)
    }
    show(store, agentId)
  }
  // Deliver Now put off part-way because what its line was made from changed as it was typed (#1504: a loop wake's
  // board and lanes changed, as the card's own arrival in Review updates its lane): made again at once from things as
  // they are now, as an offer overtaken before its first key is. With idle wakes off the retry below types nothing, so
  // the user's ask would be lost. Never over the user's own typing.
  if (!typed && asked && putOff && tries < OVERTAKEN_TRIES && !sessions.userMayBeTyping(host, agentId)) return offerOnce(host, agentId, only, tries + 1, asked)
  // Put off part-way (the user began typing there, what it was made from changed): tried again by itself, soon.
  if (!typed) retrySoon(host, agentId)
  return typed
}

/**
 * Ends, of these deliveries still waiting, those their source no longer has due (a producer's own check, given with one,
 * is its caller's to answer: deliverNow says why it wasn't given; the next offer ends what its check no longer wants).
 */
async function dropUndue(store: Store, ids: readonly string[]): Promise<void> {
  const waiting = ids.map((id) => byId(store.records, id)).filter((r): r is DeliveryRecord => !!r && isWaiting(r))
  const fresh = await refreshAll(store, waiting)
  const ends = [...fresh].filter(([, f]) => 'cancel' in f) as [string, { cancel: string }][]
  if (!ends.length) return
  await transact(store, (d) => {
    for (const [id, f] of ends) {
      const r = byId(d.records, id)
      if (r && isWaiting(r)) set(store, d, r, 'cancelled', f.cancel)
    }
  }).catch((e) => log.warn('ending deliveries no longer due', e))
}

/** Agents whose line was put off part-way, tried again in a moment (one timer each; the tick and statuses try too). */
const retrying = new Map<string, ReturnType<typeof setTimeout>>()
const RETRY_MS = 1000
function retrySoon(host: string, agentId: string): void {
  const k = `${keyOf(host)}#${agentId}`
  if (retrying.has(k)) return
  const t = setTimeout(() => {
    retrying.delete(k)
    void offerNow(host, agentId).catch((e) => log.warn('offering deliveries', e))
  }, RETRY_MS)
  t.unref?.()
  retrying.set(k, t)
}

/**
 * Makes a delivery its caller wants given now, or not at all (#649: a task, a handover's step, which are never queued):
 * offered at once, alone; else cancelled, and NotGiven says why. `holds`: the caller's own check, asked with each key.
 */
export async function deliverNow(host: string, nd: NewDelivery, holds?: () => boolean, hooks: Omit<DeliveryHooks, 'holds'> = {}): Promise<DeliveryRecord | null> {
  /**
   * Waits while the agent's folder is being changed (#646 round 1: a Git switch or pull there): held, not refused, and
   * tried again once it is done (whether git succeeded or not). Whether it waited.
   */
  const heldByFolder = async (): Promise<boolean> => {
    const cwd = sessions.liveFor(host, nd.agentId)?.cwd
    if (!folderChanging(cwd)) return false
    await folderSteady(cwd)
    return true
  }
  // The user's own task for an agent that can't read an inbox (#650's decision): typed as their input, no delivery.
  if (!readsInbox(host, nd.agentId) && nd.from.kind === 'user') {
    for (;;) {
      if (await heldByFolder()) continue
      if (await typeLine(host, nd.agentId, nd.body, () => !holds || holds(), { need: nd.need ?? 'idle' })) return null
      // Put off because its folder began changing meanwhile: held until that is done, then typed.
      if (!(await heldByFolder())) break
    }
    throw new NotGiven(whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? (holds && !holds() ? say(T.changed) : say(T.notTyped)))
  }
  /**
   * Waits while the agent's Combwork tools are connecting (#865 round 3: a task given in the second after it became ready):
   * held, not refused, until they connect or the bound passes (sessions.combworkToolsSettled). Whether it waited.
   */
  const heldByTools = async (): Promise<boolean> => {
    if (!sessions.combworkToolsWaiting(host, nd.agentId) || !readyFor(sessions.liveFor(host, nd.agentId), nd.need ?? 'idle')) return false
    await sessions.combworkToolsSettled(host, nd.agentId)
    return true
  }
  const rec = await createDelivery(host, nd, { ...hooks, ...(holds ? { holds } : {}) })
  const store = await load(host)
  let why: string | null = null
  try {
    // Another try for the agent may be running (the tick's): once it is done, this one's own. A wait for its folder
    // (#646) or its Combwork tools (#865) is no try: given at once after it, or cancelled as before if it can't be then.
    for (let i = 0; i < 3; ) {
      const now = deliveryNow(host, rec.id)
      if (!now || !isWaiting(now)) break
      if ((await heldByFolder()) || (await heldByTools())) continue
      why = whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? (holds && !holds() ? say(T.changed) : null)
      if (why) break
      if (await offerNow(host, nd.agentId, rec.id)) break
      if (await heldByFolder()) continue
      i++
    }
  } finally {
    const now = deliveryNow(host, rec.id)
    if (now && isWaiting(now)) {
      why ??= whyNoLine(host, nd.agentId, nd.need ?? 'idle') ?? say(T.notTyped)
      await transact(store, (d) => {
        const r = byId(d.records, rec.id)
        if (r && isWaiting(r)) set(store, d, r, 'cancelled', NOT_GIVEN + why)
      }).catch(() => undefined)
      show(store, nd.agentId)
    }
  }
  const out = deliveryNow(host, rec.id) ?? rec
  if (out.state === 'cancelled' || out.state === 'refused' || out.state === 'expired') {
    store.hooks.delete(rec.id)
    throw new NotGiven((out.detail?.startsWith(NOT_GIVEN) ? out.detail.slice(NOT_GIVEN.length) : out.detail) ?? why ?? out.state)
  }
  return out
}

/**
 * Makes a delivery that a launch carries (#649: the task an agent is started with, its prompt on the command line):
 * `start` launches the agent with its doorbell (#650: its id, never its text), and it is offered into that launch,
 * received once the agent reads it with cw_inbox. `start` failing cancels it, and the error stands.
 */
export async function launchWith<T extends { runId: string }>(host: string, nd: NewDelivery, start: (line: string) => Promise<T>, hooks?: DeliveryHooks): Promise<{ record: DeliveryRecord | null; launched: T }> {
  // The user's own task for an agent that can't read an inbox (#650's decision): its launch's prompt, as their input,
  // no delivery. Anyone else's is refused (createDelivery, below) before anything is launched.
  if (!readsInbox(host, nd.agentId) && nd.from.kind === 'user') return { record: null, launched: await start(nd.body) }
  // Saved as offered before anything is launched (persist before the effect, #647): not saved, nothing starts. From
  // here a crash leaves it offered, so it is uncertain after the restart, never queued and typed again as if new. The
  // scheduler never offers it (it isn't waiting), and the checks leave it alone while the launch starts.
  const rec = await createDelivery(host, { ...nd, launching: true }, hooks)
  const store = await load(host)
  store.offering.add(rec.id)
  let run: T
  try {
    run = await start(withCardNames(workspaceFor(store.host), () => inDialectOf({ projectPath: store.host, agentId: nd.agentId }, () => offerLine([rec], null)), scopeOfHost(store.host)))
  } catch (e) {
    store.offering.delete(rec.id)
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING) set(store, d, r, 'cancelled', NOT_GIVEN + (e as Error).message)
    }).catch((err) => log.warn("cancelling a launch's task", err))
    show(store, nd.agentId)
    throw e
  }
  // The launch it went into, in memory at once (what the checks follow if saving it fails), and on disk.
  if (run?.runId) {
    store.launches.set(rec.id, run.runId)
    store.confirming.set(rec.id, { runId: run.runId, count: 0 })
  }
  try {
    await transact(store, (d) => {
      const r = byId(d.records, rec.id)
      if (r?.state === 'offered' && r.offerRun === LAUNCHING && run?.runId) put(d, r, { ...r, offerRun: run.runId })
    })
  } catch (e) {
    // Launched with it: still offered into that launch (followed in memory); a restart finds it uncertain.
    log.warn("saving the launch a task went into (it is followed in memory; a restart finds it uncertain)", e)
  } finally {
    store.offering.delete(rec.id)
  }
  show(store, nd.agentId)
  return { record: deliveryNow(host, rec.id) ?? rec, launched: run }
}

/**
 * For a producer about to start from what an agent was told (a new watch, #649): what became of its offered deliveries
 * (rung again, uncertain, ended) is followed now, and their sources told, before this returns.
 */
export async function followAgent(host: string, agentId: string): Promise<void> {
  const store = stores.get(keyOf(host))
  if (!store?.records.some((r) => r.agentId === agentId && r.state === 'offered')) return
  await transact(store, (d) => recheck(store, d, agentId)).catch((e) => log.warn('checking deliveries', e))
  // Its sources are told in microtasks queued as it was published: they have run once this has.
  await new Promise((r) => setImmediate(r))
  show(store, agentId)
}

/** Follows each loaded host's deliveries (received, uncertain, ended), offers what waits, and refreshes the panes (overdue). */
function tick(): void {
  for (const store of stores.values()) {
    if (store.records.some((r) => isUnread(r) && (whyNot(store, r) || r.state === 'offered'))) transactSoon(store, 'checking deliveries', (d) => recheck(store, d)) // agent-protocol: for the log
    const agents = new Set(store.records.filter(isLive).map((r) => r.agentId))
    for (const a of agents) {
      show(store, a)
      if (store.records.some((r) => r.agentId === a && isWaiting(r))) void offerNow(store.host, a).catch((e) => log.warn('offering deliveries', e))
    }
  }
}

/**
 * A doorbell its CLI never took, lost from its input since (HI-1959: a screen of the CLI's took it): what it rang for,
 * still offered in that launch and unread, is queued again and offered now, so it rings once more. One read meanwhile,
 * or offered again already, is left as it is.
 */
async function ringLostLine(host: string, agentId: string, runId: string, ids: readonly string[]): Promise<void> {
  const store = await load(host)
  await transact(store, (d) => {
    for (const id of ids) {
      const r = byId(d.records, id)
      const run = r ? (store.launches.get(r.id) ?? r.offerRun) : null
      if (r && r.agentId === agentId && r.state === 'offered' && !store.offering.has(r.id) && run === runId) set(store, d, r, 'queued', say(T.doorbellLost))
    }
  })
  show(store, agentId)
  await offerNow(host, agentId)
}

let started = false
/** Wires the service in (once, at start): statuses and a tick offer and follow deliveries, workspaces restore them. */
export function initDeliveries(): void {
  if (started) return
  started = true
  followWorkspaceCloses()
  sessions.lineLost = (host, agentId, runId, ids) => void ringLostLine(host, agentId, runId, ids).catch((e) => log.warn('ringing a lost line again', e))
  onCombworkEvent((e) => {
    if (e.type === 'workspace-changed') {
      // Restored as a workspace opens: its projects' and its Assistant's (refusals shown, panes filled in).
      const hosts = [...(e.workspace?.projects ?? []).map((p) => p.path), ...(e.workspace?.assistant ? [e.workspace.assistant.path] : [])]
      for (const h of hosts) void load(h).catch((err) => log.warn('restoring deliveries', err))
      return
    }
    // A card moved or reviewed: what was tied to its round may be stale now (#652).
    if (e.type === 'tasks-changed') {
      sweepStale()
      return
    }
    if (e.type !== 'session-status') return
    const { projectPath, agentId, status } = e.state
    // A session ending as its workspace closes: its deliveries wait in the database for the next opening (#1391).
    if (hostClosed(projectPath)) return
    void load(projectPath)
      .then((store) => {
        // A doorbell let pass, a launch ended: what was offered rings once more, or is uncertain.
        if (store.records.some((r) => r.agentId === agentId && r.state === 'offered')) transactSoon(store, 'checking deliveries', (d) => recheck(store, d, agentId)) // agent-protocol: for the log
        show(store, agentId)
        // Idle for a message or a card event (watching, or its turn over while its own background tasks run, #726) too.
        if (readyFor(e.state, 'stalled') || readyFor(e.state) || status === 'watching') setTimeout(() => void offerNow(projectPath, agentId).catch((err) => log.warn('offering deliveries', err)), 500).unref?.()
      })
      .catch((err) => log.warn('loading deliveries', err))
  })
  // A team resuming (HI-2081): what its pause held has its time moved on by how long it was held (never expired for the
  // pause: a weekend's still resumes), then each source's refresh decides from things as they are now, and it is offered.
  onCombworkEvent((e) => {
    if (e.type === 'team-pause-changed' && !e.pause && e.was) void rebaseHeld(e.workspacePath, e.was.since).catch((err) => log.warn('offering what the team pause held', err))
  })
  // The user's pause after typing, a line taken, overdue: nothing tells of those, so they are looked at now and then.
  const timer = setInterval(tick, 5000)
  timer.unref?.()
  // A folder changed under its agents is steady again (#646): what waited for it is offered now, not at the next tick.
  onFolderSteady((folder) => {
    for (const st of sessions.liveStates()) if (st.cwd && inFolder(st.cwd, folder) && !folderChanging(st.cwd)) void offerNow(st.projectPath, st.agentId).catch((err) => log.warn('offering deliveries', err))
  })
}

/**
 * The deliveries a team's pause held in a workspace (HI-2081): unread, and of a held kind, each with its expiry moved on
 * by how long the pause lasted, then offered (made again from its source first, so what is no longer due is cancelled).
 */
export async function rebaseHeld(workspacePath: string, since: string): Promise<void> {
  const held = Math.max(0, Date.now() - (Date.parse(since) || Date.now()))
  for (const store of [...stores.values()]) {
    if (!inFolder(store.host, workspacePath) || workspaceFor(store.host)?.isAssistantHome(store.host)) continue
    const agents = new Set<string>()
    await transact(store, (d) => {
      for (const r of [...d.records]) {
        if (!isUnread(r) || !pauseHolds(r)) continue
        put(d, r, { ...r, expires: new Date(Date.parse(r.expires) + held).toISOString() })
        agents.add(r.agentId)
      }
    })
    showAll(store)
    for (const a of agents) void offerNow(store.host, a).catch((err) => log.warn('offering deliveries', err))
  }
}

/**
 * An agent's conversation carried on in a new one (HI-2463: one launched before the rename starts fresh): what is still
 * for it there (live, for that conversation) is for whichever conversation it has next, so nothing waiting expires as
 * "another conversation". How many.
 */
export async function carryConversation(host: string, agentId: string, from: string): Promise<number> {
  const store = await load(host)
  const { n, replay, name } = await transact(store, (d) => {
    let count = 0
    const ids: string[] = []
    let agentName: string | undefined
    for (const r of [...d.records]) {
      if (r.agentId !== agentId || !isLive(r)) continue
      // Received, not acked (HR1's round 1): the old conversation read it, the new one never did. Whatever conversation it
      // was bound to (an agent runs one at a time, so the one it left received it), it is shown again on the new one's
      // next inbox read, its receipt kept (carriedFrom; never acked for it).
      if (r.state === 'received') {
        // Shown once to each conversation that reads it (`replayedTo`, read in readInbox): a later fresh one (the old
        // conversation resumed again) is shown it again by itself, so the marker isn't touched here.
        put(d, r, { ...r, conversation: null, carriedFrom: from })
        ids.push(r.id)
        agentName ??= r.agentName
        count++
      } else if (r.conversation === from) {
        put(d, r, { ...r, conversation: null })
        count++
      }
    }
    return { n: count, replay: ids, name: agentName }
  })
  if (n) show(store, agentId)
  // The doorbell rings for what is unread: a notice of its own says what is shown again, so the new conversation reads it.
  if (replay.length)
    await createDelivery(host, { agentId, ...(name ? { agentName: name } : {}), conversation: null, kind: 'control', from: CARRIED_SENDER, body: `${NOTICE_PREFIX}${say(T.carried, { n: replay.length, ids: replay.join(', ') })}`, source: 'carried', ref: from }).catch((e) => log.warn(`Could not tell ${userText(agentId)} of the messages its earlier conversation hadn't acked`, e))
  return n
}

/** Who tells a fresh conversation what its earlier one received and didn't ack: Combwork itself. */
// agent-protocol: the product's name, as a delivery's sender
const CARRIED_SENDER = { kind: 'combwork', name: 'Combwork' } as const // i18n-ignore: the product's name, as a delivery's sender

// The workspace's database replaced (#1207 round 2: the upgrade to 1.0, a restore): its hosts' deliveries, read from the
// file before, go from memory (a save begun from them is refused by their generation). The next use of a host (an agent's
// status, the workspace opening) reads it again from the file as it is then, with what another Combwork saved meanwhile;
// nothing reads it for a workspace closed meanwhile, which would open its database again (#1207 round 3). While the upgrade
// waited no agent could start, so none waits for an offer.
onDbReplaced((_path, place) => {
  for (const [k, store] of stores) if (store.place.key === place) stores.delete(k)
})

// A window closes its workspace (#1391): its hosts' deliveries go from memory, so the tick no longer rechecks them, which
// leased its closed combwork.db at each change. They stay in the database and are restored when a window opens it again. A
// save already under way holds its store and lease, and finishes. By real location (`placeKey`), as the fence tells
// workspaces apart: a host loaded through a junction or an 8.3 name to the folder is the same workspace's. Followed from
// initDeliveries (once).
let followingCloses = false
export function followWorkspaceCloses(): void {
  if (followingCloses) return
  followingCloses = true
  WorkspaceService.closingListeners.add((_path, place) => {
    // By the place the window recorded and each store's own (#1395); a retry's host by its store's, else as it enters.
    for (const [k, t] of retrying) {
      const host = k.slice(0, k.lastIndexOf('#'))
      if ((stores.get(host)?.place.key ?? workspaceKeyOf(host)) !== place) continue
      clearTimeout(t)
      retrying.delete(k)
    }
    for (const [k, store] of stores) if (store.place.key === place) stores.delete(k)
  })
}

// Sessions give their own lines through the service (#649: a lock's go-ahead, the carry-on after a sign-in, a handover's
// steps): it is set as this loads.
sessions.deliveries = {
  give: async (host, nd, hooks) => {
    const r = await createDelivery(host, nd, hooks)
    await offerNow(host, nd.agentId)
    return r
  },
  now: (host, nd, holds) => deliverNow(host, nd, holds),
  launch: (host, nd, start) => launchWith(host, nd, start),
  cancel: cancelFromSource,
  carry: carryConversation
}

/** For tests: every loaded host's agents offered now (what the tick does), awaited. */
export async function offerAllForTests(): Promise<void> {
  const runs: Promise<boolean>[] = []
  for (const store of stores.values()) for (const a of new Set(store.records.filter(isWaiting).map((r) => r.agentId))) runs.push(offerNow(store.host, a))
  await Promise.all(runs)
}
/** For tests: what the tick follows (received, uncertain, ended), now, awaited. */
export async function followAllForTests(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => transact(store, (d) => recheck(store, d)).then(() => showAll(store))))
}
/** For tests: transactions still running finish. */
export async function settledForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.all([...stores.values()].map((s) => s.lock))
}
/** For tests: every host's load under way has finished (those started while waiting too), however long its reads take. */
export async function loadsForTests(): Promise<void> {
  while (loading.size) await Promise.allSettled([...loading.values()])
}
/** For tests: forgets every host in memory, as a restart of Combwork does (transactions finish first); what is on disk stays. */
/** For tests: a host's deliveries as saved (#1018: its workspace's database), with what is kept beside them. */
export async function savedForTests(host: string): Promise<{ next: number | undefined; deliveries: DeliveryRecord[]; invalid?: unknown[] }> {
  const place = await hostPlace(host)
  // In their table since 1.0 (#1211, store_rows gone); 0.9's rows while the workspace's upgrade waits.
  const waiting = upgradeWaiting(place.workspace)
  const old = waiting ? readStore(place.workspace, 'deliveries', place.scope) : null
  const db = workspaceDb(place.workspace).reader
  const value = (key: string): string | null => (old ? (old.meta.get(key) ?? null) : storeValue(db, 'deliveries', place.scope, key))
  const deliveries = old ? old.rows.map((r) => JSON.parse(r.doc) as DeliveryRecord) : (readDeliveryRows(db, place.scope) as unknown as DeliveryRecord[])
  const next = value('next')
  const invalid = value('invalid')
  return { next: next !== null ? (JSON.parse(next) as number) : undefined, deliveries, ...(invalid ? { invalid: JSON.parse(invalid) as unknown[] } : {}) }
}

export async function forgetDeliveriesForTests(): Promise<void> {
  await settledForTests()
  for (const t of retrying.values()) clearTimeout(t)
  retrying.clear()
  stores.clear()
  trying.clear()
}
