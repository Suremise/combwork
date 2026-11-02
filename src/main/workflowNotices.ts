import { join } from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { shownText, withValues, type Text, type TextPart } from '../shared/advanced'
import { gist } from '../shared/gist'
import { msg } from '../shared/i18n'
import { laneHits, newLaneBase, type LaneCardMark, type LaneEvent, type LaneMark } from '../shared/laneWatch'
import { cardLabel } from '../shared/projectKeys'
import type { TaskColumn } from '../shared/types'
import { workflowLine } from '../shared/workflow/texts'
import { boardRead, boardReadOnly, boardRevision, boardWrite, boardWriteOp } from './boardStore'
import { coalesced } from './coalesce'
import { onHiveEvent } from './events'
import { listLanes } from './lanes'
import { createLogger } from './logger'
import { wakesOn } from './loopWakes'
import { sessions } from './sessions'
import { HISTORY } from '../shared/taskHistory'
import type { StoredText } from '../shared/types'
import { allTasks, commentAsHive, getTask, noteOnCard } from './tasks'
import { lanesNowIn } from './watches'
import { onAction, type ActionHandler } from './workflow/actionWorker'
import type { ActionRow } from './workflow/factStore'
import { openWorkspaces, type WorkspaceService } from './workspace'

/**
 * What Hive tells the user of the work itself (#1266, SPEC §16.11.4), with or without the Assistant: a card's request for
 * the user (the runtime's `notify` action: For you, a "couldn't within the rules"), and what the Assistant's lane watch
 * reports of each running lane (a failed review, a card blocked or stalled, every card passed so the merge is due, the
 * merge stalled). Each is a notice, a pop-up in the window the user is using or a Windows notification, as the user's
 * notification settings say (Settings → Notifications); a quiet test copy records it to HIVE_TEST_NOTIFY_LOG. A lane's
 * events found together are one notice, per lane. Like the loop's wakes, none for a project whose Project Settings →
 * Card loops → Wake reviewers and builders is off (`loopWakes`).
 *
 * Both are durable actions (`notify`, `laneNotice`), repeatable (actionWorker.ts), and what they tell always shows in the
 * window too (the card's request, the lane in the Progress panel): that record is the guarantee, and the banner or
 * Windows notification is best effort (shown once its dispatch is counted under a lease that holds; never done without
 * it when that lease expired; repeated at most once after a run that ended uncertainly; SPEC §16.4.5). A lane's events are found by comparing it with what was last told of
 * it, kept with the board (`lane_notice_lanes`, `lane_notice_cards`): in one board change, the marks move on and each
 * lane's notice is written as an action, so a restart tells what it hadn't yet, and two Hives on one workspace tell each
 * event once (the second finds the marks moved on). A lane running when Hive first followed lanes on the board (its
 * `since`) starts from then; one started later is told from its start.
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
  notMerged: msg({ id: 'service.workflowNotice.notMerged', defaultMessage: '{card} passed review: the lane waits for it to be merged', description: "A line of a lane's notification: the lane takes one card at a time, and its card (its key, e.g. HI-12) passed review but isn't merged yet, so the next card can't start." }),
  merging: msg({ id: 'service.workflowNotice.merging', defaultMessage: '{card} is being merged: the lane waits for it', description: "A line of a lane's notification: the lane takes one card at a time, and its card (its key, e.g. HI-12) is in the merge queue, so the next card can't start." }),
  mergeStalled: msg({ id: 'service.workflowNotice.mergeStalled', defaultMessage: 'Its merge has stalled', description: "A line of a lane's notification: every card passed review, but nobody has started merging the work for a while (its builder is idle or stopped)." })
}

/** The events Hive tells the user of, as the Assistant's lane watch does by default (§16.11.4), less what it says itself. */
const EVENTS: LaneEvent[] = ['failed', 'blocked', 'stalled', 'merge-due', 'paused-merge']

/** How often running lanes are looked at with no change (a stall comes with time), as lane watches are. */
const TICK_MS = 30_000

/** board_meta's key for when Hive first followed this board's lanes (ISO): lanes running then start from then. */
const SINCE = 'lane_notices_since'

/** A notice about a project's work, as the user's notification settings say. */
function tell(projectPath: string, title: Text, lines: TextPart[], about?: { kind: 'needsYou' | 'work'; card: { number: number; label: string }; workspacePath: string }): void {
  // Its link is its card (HI-2320); a card that needs you is told as an agent waiting for you is.
  const extra = about ? { kind: about.kind, target: { kind: 'card' as const, number: about.card.number, label: about.card.label, projectPath, workspacePath: about.workspacePath } } : undefined
  sessions.notice(projectPath, title, lines.length === 1 ? lines[0] : { lines }, undefined, extra)
}

/** A card's project folder and the card, while it is on the board and its project lets loops wake (and tell) anyone. */
async function cardIn(ws: WorkspaceService, n: number): Promise<{ projectPath: string; card: Awaited<ReturnType<typeof getTask>> } | null> {
  if (!ws.path) return null
  const card = await getTask(n, ws).catch(() => null)
  if (!card?.project || card.archived) return null
  const projectPath = join(ws.path, card.project)
  return (await wakesOn(ws, projectPath)) ? { projectPath, card } : null
}

/**
 * A `notify` action: the card's request for the user. Its text in the language Hive shows when the runtime kept its
 * message (`shown`, #1264: Hive's own requests), else as written (an agent's own words), and in English for the Agent API.
 */
async function notifyFromAction(a: ActionRow, ws: WorkspaceService, ctx: Parameters<ActionHandler>[2]): Promise<void> {
  const at = await cardIn(ws, a.card)
  if (!at) return
  const text = typeof a.payload.text === 'string' ? a.payload.text : ''
  const shown = a.payload.shown ? workflowLine(a.payload.shown, (m, values) => shownText(values ? withValues(m, values) : m)) : null
  // An agent's own words are Markdown (#1637): the notice (a banner, a Windows notification: plain text) has their gist,
  // the Agent API them whole; the card's For you shows them rendered.
  const body: TextPart[] = shown ? [{ shown, english: text || shown }] : text ? [{ shown: gist(text, NOTICE_GIST), english: text }] : []
  // Shown once its dispatch is counted under a lease that holds (uncertain until the action is marked).
  await ctx.dispatch(() => tell(at.projectPath, withValues(M.forYou, { card: cardLabel(at.card) }), body, ws.path ? { kind: 'needsYou', card: { number: at.card.number, label: cardLabel(at.card) }, workspacePath: ws.path } : undefined))
}

/**
 * A `comment` action (HI-2087: the merge queue's return): Hive's comment on the card, its English for whoever reads the
 * card and its message for the window, written once (its id the action's).
 */
async function commentFromAction(a: ActionRow, ws: WorkspaceService): Promise<void> {
  const text = typeof a.payload.text === 'string' ? a.payload.text : ''
  const shown = a.payload.shown as StoredText | undefined
  if (!ws.path || !text) return
  // A card archived or gone since: nothing to say it on (done). A write that fails throws (HR3's round 1 finding 3):
  // the worker records the action failed, never done without its comment; one stopped by its workspace closing waits
  // for the next run there, which writes it (or finds it written: its id is the action's).
  if (noticeTestHooks.commentFails) throw new Error('the board refused the change (a test)') // i18n-ignore: a test's error, logged
  await commentAsHive(a.card, shown ? { text, shown } : text, ws, undefined, `action-${a.id}`)
}

/** How much of an agent's question a request's notice shows (its first sentence or two). */
const NOTICE_GIST = 200

/** A lane notice's event as its action keeps it: what happened, to which card (none: the lane's merge), and why. */
interface Told {
  event: LaneEvent
  card: number | null
  detail?: string
}

/** A `laneNotice` action: a lane's events, one notice, each card named as the window names it (#1221). */
async function laneNoticeFromAction(a: ActionRow, ws: WorkspaceService, ctx: Parameters<ActionHandler>[2]): Promise<void> {
  const at = await cardIn(ws, a.card)
  if (!at || !ws.path) return
  const events = (Array.isArray(a.payload.events) ? a.payload.events : []) as Told[]
  const numbers = events.flatMap((e) => (typeof e.card === 'number' ? [e.card] : []))
  const labels = new Map(numbers.length ? (await allTasks(ws, { numbers })).map((c) => [c.number, cardLabel(c)]) : [])
  const lines = events.map((e): TextPart => {
    const card = e.card !== null ? (labels.get(e.card) ?? `#${e.card}`) : ''
    if (e.event === 'failed') return withValues(M.failed, { card })
    if (e.event === 'blocked') return e.detail ? withValues(M.blocked, { card, reason: e.detail }) : withValues(M.blockedNoReason, { card })
    if (e.event === 'stalled') return e.card === null ? M.mergeStalled : withValues(M.stalled, { card })
    // `paused`: an action kept before HI-1991 split it.
    if (e.event === 'paused-merge' || (e.event as string) === 'paused') return withValues(e.detail === 'merging' ? M.merging : M.notMerged, { card })
    return M.mergeDue
  })
  const workspacePath = ws.path
  if (lines.length) await ctx.dispatch(() => tell(at.projectPath, withValues(M.lane, { lane: String(a.payload.lane ?? '') }), lines, { kind: 'work', card: { number: at.card.number, label: cardLabel(at.card) }, workspacePath }))
}

// --- What lane notices last told, with the board.

type MarkRow = { lane: string; state: string; merge_due: number; merge_stalled: number }
type CardRow = { lane: string; card: number; col: string; blocked: number; stalled: number; failed: string; passed: string }

/** Each lane as its notices last told it. */
function readMarks(db: DatabaseSync): Record<string, LaneMark> {
  const out: Record<string, LaneMark> = {}
  for (const r of db.prepare('SELECT lane, state, merge_due, merge_stalled FROM lane_notice_lanes').all() as MarkRow[]) out[r.lane] = { state: r.state as LaneMark['state'], mergeDue: r.merge_due === 1, ...(r.merge_stalled ? { ms: true } : {}), cards: {} } // i18n-ignore: SQL
  for (const c of db.prepare('SELECT lane, card, col, blocked, stalled, failed, passed FROM lane_notice_cards').all() as CardRow[]) { // i18n-ignore: SQL
    const m = out[c.lane]
    if (m) m.cards[c.card] = { c: c.col as TaskColumn | 'gone', b: c.blocked === 1, s: c.stalled === 1, f: c.failed, p: c.passed } satisfies LaneCardMark
  }
  return out
}

/** Keeps a lane's mark as told (replacing what was), or drops it (null: a lane no longer followed). */
function writeMark(db: DatabaseSync, lane: string, m: LaneMark | null): void {
  db.prepare('DELETE FROM lane_notice_lanes WHERE lane = ?').run(lane) // i18n-ignore: SQL
  if (!m) return
  db.prepare('INSERT INTO lane_notice_lanes (lane, state, merge_due, merge_stalled) VALUES (?, ?, ?, ?)').run(lane, m.state, m.mergeDue ? 1 : 0, m.ms ? 1 : 0) // i18n-ignore: SQL
  const ins = db.prepare('INSERT INTO lane_notice_cards (lane, card, col, blocked, stalled, failed, passed) VALUES (?, ?, ?, ?, ?, ?, ?)') // i18n-ignore: SQL
  for (const [n, c] of Object.entries(m.cards)) ins.run(lane, Number(n), c.c, c.b ? 1 : 0, c.s ? 1 : 0, c.f, c.p)
}

const metaOf = (db: DatabaseSync, key: string): string | null => (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null // i18n-ignore: SQL

/** board_meta's count of the marks' writes: a look's stamp includes it, so another look written since makes it stale. */
const SEQ = 'lane_notices_seq'

/**
 * What a look reads, as of now (#1266 round 3): the board's revision (boardRevision: its cards' and lanes' changes, this
 * process's counted as they commit, another's by `data_version`, a replaced file by its generation: never a clock) and
 * the marks' writes. The same stamp at the write as at the read: nothing a look reads changed between (a session's stall
 * aside, which no write marks).
 */
function stampOf(ws: WorkspaceService, db: DatabaseSync): string {
  return `${boardRevision(ws)}|${metaOf(db, SEQ) ?? '0'}`
}

/** How many times a look is made again, at most, while the board keeps changing under it (the next change or tick looks then). */
const LOOKS = 4

/**
 * Looks at a workspace's running lanes now: each one's events since it was last told, as a `laneNotice` action (one per
 * lane), and its mark moved on, in one board change. What it read (the marks, the lanes and their cards) is the board's
 * as it is at that change, or nothing is written (#1266 round 2): its stamp, taken before the read, is checked again
 * under the board's lock, and a look the board changed under is made again. So marks never move back to an older read,
 * and another Hive's look in between is never told again.
 */
async function check(ws: WorkspaceService): Promise<void> {
  for (let i = 0; i < LOOKS; i++) if (await look(ws)) return
}

/** One look (check): true once it is done (written, or nothing to do), false when the board changed under it. */
async function look(ws: WorkspaceService): Promise<boolean> {
  const path = ws.path
  if (!path || boardReadOnly(ws)) return true
  const life = ws.lifetime
  const alive = (): boolean => !life.aborted && ws.lifetime === life && ws.path === path && openWorkspaces().includes(ws)
  let told: { marks: Record<string, LaneMark>; since: string; stamp: string }
  try {
    told = boardRead(ws, (db) => ({ marks: readMarks(db), since: metaOf(db, SINCE) ?? new Date().toISOString(), stamp: stampOf(ws, db) }))
  } catch {
    // A board without the lane notices' tables (not upgraded): nothing to follow.
    return true
  }
  const lanes = new Map((await listLanes(ws, { all: true })).map((l) => [l.id, l]))
  const nows = await lanesNowIn(ws, told.marks, told.since)
  // Whose loops tell anyone: a project with loop wakes off gets no notices, its lanes' marks still moving on.
  const quiet = new Set<string>()
  for (const p of new Set([...lanes.values()].map((l) => l.project))) if (!(await wakesOn(ws, join(path, p)))) quiet.add(p.toLowerCase())
  if (!alive()) return true
  const written = await boardWrite(
    ws,
    async () => {
      const planned = boardWriteOp(ws, (db): Note[] | false => {
        // Written since the read (another look, a change, another Hive): the read is stale, and nothing is written.
        if (stampOf(ws, db) !== told.stamp) return false
        const notes: Note[] = []
        const since = metaOf(db, SINCE) ?? told.since
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING').run(SINCE, since) // i18n-ignore: SQL
        // As the marks are now: what another Hive told since this one read them isn't told again.
        const marks = readMarks(db)
        for (const now of nows) {
          const lane = lanes.get(now.id)
          const running = now.mark.state === 'active' || now.mark.state === 'paused'
          // A lane first seen: one started since Hive began following starts empty (what it came with is told), else from
          // now; one first seen already ended or abandoned is only marked (#1631: Hive told its round again on every look).
          const base = marks[now.id] ?? (running && lane && Date.parse(lane.startedAt) > Date.parse(since) ? newLaneBase(now, since) : null)
          const hit = laneHits(base, now, EVENTS, since)
          // Its mark kept once it ends too (#1631): a lane started since with no mark is new to lanesNowIn, and told again.
          writeMark(db, now.id, now.mark)
          if (!hit || !lane || quiet.has(lane.project.toLowerCase())) continue
          const exists = (n: number): boolean => !!db.prepare('SELECT 1 FROM cards WHERE number = ?').get(n) // i18n-ignore: SQL
          // The lane's current card (its first not yet merged, else its last): where a lane's own event is noted.
          const laneCards = now.cards.map((c) => c.number).filter(exists)
          const current = laneCards.find((n) => now.mark.cards[n]?.c !== 'done') ?? laneCards.at(-1)
          // On a card of the lane still on the board (the action's card), the first it names.
          const on = [...hit.parts.flatMap((p) => (p.n !== null ? [p.n] : [])), ...laneCards].find(exists)
          if (on === undefined) continue
          const events: Told[] = hit.parts.map((p) => ({ event: p.event, card: p.n, ...(p.detail ? { detail: p.detail } : {}) }))
          db.prepare("INSERT INTO card_actions (card, kind, payload, fact) VALUES (?, 'laneNotice', ?, NULL)").run(on, JSON.stringify({ lane: hit.label, events })) // i18n-ignore: SQL
          for (const e of events) {
            const card = e.card !== null && exists(e.card) ? e.card : current
            if (card !== undefined) notes.push({ card, event: noteEvent(e), lane: hit.label, ...(e.detail ? { why: e.detail } : {}) })
          }
        }
        // Lanes gone from the board are followed no more; an ended or abandoned one keeps its mark (lanesNowIn leaves it out).
        for (const id of Object.keys(marks)) if (!lanes.has(id)) writeMark(db, id, null)
        db.prepare("INSERT INTO board_meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").run(SEQ) // i18n-ignore: SQL
        return notes
      })
      if (planned === false) return false
      // The durable notice (SPEC §16.4.5): each event a line in its card's history, in this same change.
      for (const n of planned) await noteOnCard(n.card, noticeLine(n), ws)
      return true
    },
    { alive }
  )
  // Its workspace closed or switched meanwhile: nothing more to look at.
  return written !== false
}

/**
 * A notice's line in a card's history (HISTORY.notified): which event, the lane's label, and what the notification said
 * (`why`: why it is blocked or stalled, as written; a request's question, as the runtime kept it: its message, shown in
 * the window's language, or someone's own words).
 */
interface Note {
  card: number
  event: 'failed' | 'blocked' | 'stalled' | 'mergeDue' | 'mergeStalled' | 'request'
  lane: string
  why?: string | StoredText
}
/** A notice's history line (its `why` a value of its own: text, or a message nested within it). */
function noticeLine(n: Note): StoredText {
  return { id: HISTORY.notified.id, values: { event: n.event, lane: n.lane, hasWhy: n.why ? 'yes' : 'no', why: n.why ?? '' } as Record<string, string | number> }
}
function noteEvent(e: Told): Note['event'] {
  if (e.event === 'failed' || e.event === 'blocked') return e.event
  if (e.event === 'stalled') return e.card === null ? 'mergeStalled' : 'stalled'
  return 'mergeDue'
}

/**
 * The durable notice of the runtime's requests for the user (#1266, SPEC §16.4.5): a line in each card's history for
 * each `notify` action written after `after` (an action id), in the board change that wrote them (service.ts' `locked`,
 * which calls this before the change commits).
 */
export async function noteRequestsSince(ws: WorkspaceService, after: number): Promise<void> {
  const rows = boardRead(ws, (db) => db.prepare("SELECT card, payload FROM card_actions WHERE kind = 'notify' AND id > ? ORDER BY id").all(after) as { card: number; payload: string }[]) // i18n-ignore: SQL
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { text?: unknown; shown?: unknown }
    // Its question as the runtime kept it: its own message (shown in the window's language), else its words as written.
    const shown = p.shown && typeof p.shown === 'object' && typeof (p.shown as StoredText).id === 'string' ? (p.shown as StoredText) : null
    const why = shown ?? (typeof p.text === 'string' && p.text ? p.text : undefined)
    await noteOnCard(r.card, noticeLine({ card: r.card, event: 'request', lane: '', ...(why ? { why } : {}) }), ws)
  }
}

/** The newest action's id now (0: none), for noteRequestsSince. */
export const lastActionId = (ws: WorkspaceService): number => {
  try {
    return (boardRead(ws, (db) => db.prepare('SELECT max(id) AS id FROM card_actions').get()) as { id: number | null }).id ?? 0 // i18n-ignore: SQL
  } catch {
    // A board without the facts' tables: none.
    return 0
  }
}

/**
 * For tests: `hold` keeps the lanes from being looked at on a change or the tick (a restart before the look, say).
 * `commentFails` (HI-2087): a queue return's comment whose write fails (a board that refuses the change).
 */
export const noticeTestHooks: { hold: boolean; commentFails?: boolean } = { hold: false }

/** A workspace's lanes looked at soon: one look at a time, a change during it looked at again after. */
function checkSoon(ws: WorkspaceService): void {
  if (!ws.path || noticeTestHooks.hold) return
  void coalesced(`lane-notices:${ws.path.toLowerCase()}`, () => check(ws)).catch((e) => log.warn('lane notices', e))
}

let started = false
/** Wires Hive's own notices of the work (once, at start): its actions, and lanes looked at on every change and tick. */
export function initWorkflowNotices(): void {
  if (started) return
  started = true
  // A notice leaves nothing to find once shown: repeatable (never lost, repeated at most once).
  onAction('notify', notifyFromAction, 'repeatable')
  onAction('laneNotice', laneNoticeFromAction, 'repeatable')
  // The comment, its id the action's, is the record that it was made: a run again finds it and writes nothing.
  onAction('comment', commentFromAction, 'delivered')
  onHiveEvent((e) => {
    if (e.type !== 'tasks-changed' && e.type !== 'lanes-changed') return
    const ws = openWorkspaces().find((w) => w.path?.toLowerCase() === e.workspacePath.toLowerCase())
    if (ws) checkSoon(ws)
  })
  setInterval(() => {
    for (const ws of openWorkspaces()) checkSoon(ws)
  }, TICK_MS).unref?.()
}

/** For tests: looks at a workspace's lanes now (what a change or the tick does). */
export const checkLanesNow = (ws: WorkspaceService): Promise<void> => check(ws)
