import type { HookEvent, HookIds, NormalizedHook } from '../types'

// OpenCode's turns, from its private server's event stream (HI-2760, design s7 to s22; the recordings of 2.2.6 in
// tests/fixtures/opencode/real-2.2.6). The launcher (launcher.ts) only carries data: the events it projects and settled
// snapshots, posted to Combwork's hook server in order. This tracker, one per launch in its hook memo, decides what they
// are, in the launch's hook order, and gives normalized hooks for the turn ledger and the status rules:
// - a turn is one OpenCode execution, named by its first user message's id (= the inbox id that submitted it);
// - a prompt submitted while one runs (a steer) is a prompt in that turn;
// - an event belongs to an execution by its durable seq (live) or by its assistant message (permissions, retries);
// - a settled snapshot (taken at one durable watermark W) is the truth at W: events at or below W are in it, and those
//   after follow it; a stale generation's body (one in flight when a newer snapshot was taken) is ignored;
// - nothing is invented: a gap the snapshot can't fill (history out of its bounds) stays unknown for Combwork's own
//   silence path.

/** An event as the launcher projects it: only what status and identity need. */
export interface OcEvent {
  type: string
  /** Its durable seq, for events that have one (every session event; not permissions). */
  seq?: number
  inboxID?: string
  itemType?: string
  text?: string
  callID?: string
  toolName?: string
  /** permission.asked: its request id, and the assistant message and tool call it is about. */
  requestID?: string
  messageID?: string
  action?: string
  resources?: string
  reply?: string
  assistantMessageID?: string
  error?: { type?: string; message?: string; status?: number }
  reason?: string
}

/** The event types the launcher subscribes to (`/api/event?types=`): everything else never leaves the server. */
export const STREAM_TYPES = ['session.inbox.enqueued', 'session.step.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed', 'permission.asked', 'permission.replied', 'session.retry.scheduled', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'] as const

/** Text cut to what status needs (a prompt's words, a resource, an error), as the launcher cuts it. */
export const cut = (s: unknown, max: number): string | undefined => (typeof s === 'string' ? (s.length > max ? s.slice(0, max) : s) : undefined)

/**
 * An event of 2.2.6's stream as the launcher projects it (its C# does the same, LAUNCHER_SOURCE's Project): only the
 * fields status and identity need, text cut. Null for one of another session, or of a type not streamed.
 */
export function projectEvent(raw: Record<string, any>, sessionID: string): OcEvent | null {
  const type = raw?.type
  const d = raw?.data ?? {}
  if (!(STREAM_TYPES as readonly string[]).includes(type) || d.sessionID !== sessionID) return null
  const e: OcEvent = { type }
  if (typeof raw.durable?.seq === 'number') e.seq = raw.durable.seq
  if (type === 'session.inbox.enqueued') Object.assign(e, { inboxID: d.inboxID, itemType: d.item?.type, text: cut(d.item?.payload?.text, 2000) })
  if (type === 'session.step.started' || type === 'session.retry.scheduled') e.assistantMessageID = d.assistantMessageID
  if (type.startsWith('session.tool.')) Object.assign(e, { callID: d.id, ...(d.name ? { toolName: cut(d.name, 200) } : {}) })
  if (type === 'permission.asked') Object.assign(e, { requestID: d.id, messageID: d.source?.messageID, callID: d.source?.id, action: cut(d.action, 200), resources: cut(Array.isArray(d.resources) ? d.resources.join(' ') : undefined, 500) })
  if (type === 'permission.replied') Object.assign(e, { requestID: d.requestID, reply: d.reply })
  if (d.error) e.error = { type: cut(d.error.type, 200), message: cut(d.error.message, 500), ...(typeof d.error.status === 'number' ? { status: d.error.status } : {}) }
  if (typeof d.reason === 'string') e.reason = cut(d.reason, 200)
  for (const k of Object.keys(e) as (keyof OcEvent)[]) if (e[k] === undefined) delete e[k]
  return e
}

/** A message as the launcher projects it (oldest first in a snapshot). */
export interface OcMessage {
  id: string
  type: string
  outcome?: string
  error?: { type?: string; message?: string }
  text?: string
}

export interface OcPermission {
  id: string
  action?: string
  resources?: string
  messageID?: string
  callID?: string
}

/** A settled snapshot: the session at durable watermark `w`, its pending permissions, its messages since the boundary. */
export interface OcSnapshot {
  w: number
  /** The launch's first (its baseline): `intent` says whether the session was new or resumed. */
  baseline?: boolean
  intent?: 'new' | 'resume'
  session: { busy?: number; idle?: number; outcome?: string; error?: { type?: string; message?: string } }
  permissions: OcPermission[]
  messages: OcMessage[]
  /** Where the messages start: a user message already known, the session's start, or bounded out (partial). */
  boundary: 'known' | 'start' | 'partial'
}

const MAX_KEPT = 1000

/** The tracker's state, kept in the launch's hook memo. */
export interface OcTracker {
  gen: number
  /** The durable watermark of the snapshot applied last: live durable events at or below it are already in it. */
  cut: number
  /** The open execution's turn id. */
  open: string | null
  submitted: Set<string>
  ended: Set<string>
  /** Assistant message → its execution's turn. */
  msgTurn: Map<string, string>
  /** Pending permission request → its call and turn. */
  asks: Map<string, { call: string | null; turn: string }>
  /** What each pending request asks, to ask it again when another is answered. */
  askText: Map<string, string>
  answered: Set<string>
  baselined: boolean
}

export function newTracker(): OcTracker {
  return { gen: 0, cut: -1, open: null, submitted: new Set(), ended: new Set(), msgTurn: new Map(), asks: new Map(), askText: new Map(), answered: new Set(), baselined: false }
}

/** A launch's tracker, in its hook memo. */
export const trackerOf = (memo: Record<string, unknown>): OcTracker => (memo.opencode ??= newTracker()) as OcTracker

function remember<K>(set: Set<K>, key: K): void {
  set.add(key)
  if (set.size > MAX_KEPT) set.delete(set.values().next().value as K)
}
function rememberIn<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_KEPT) map.delete(map.keys().next().value as K)
}

const ids = (turn: string | null, call: string | null = null): HookIds => ({ turn, call, sub: null, continued: false })
const hook = (event: HookEvent, turn: string | null, call: string | null = null): Normalized => ({ event, ids: ids(turn, call) })

/** A normalized hook: what normalizeHook gives for one of the bodies a raw one expands into. */
export interface Normalized {
  event: HookEvent
  ids: HookIds
}

/** An execution's end, as OpenCode recorded its outcome (an execution.* event, or an idle marker in a snapshot). */
function endOf(outcome: string | undefined, error: { type?: string; message?: string } | undefined, turn: string): Normalized {
  if (outcome === 'interrupted') return hook({ kind: 'interrupt' }, turn)
  if (outcome === 'failed') return error?.type === 'provider.auth' ? hook({ kind: 'signIn', message: error.message ?? null }, turn) : hook({ kind: 'stop', lastMessage: error?.message ?? null, failed: true }, turn)
  return hook({ kind: 'stop', lastMessage: null }, turn)
}

/** The open execution ends (its turn remembered as ended). */
function close(t: OcTracker, out: Normalized[], outcome: string | undefined, error?: { type?: string; message?: string }): void {
  if (!t.open) return
  const turn = t.open
  t.open = null
  remember(t.ended, turn)
  for (const [req, a] of t.asks) if (a.turn === turn) {
    t.asks.delete(req)
    t.askText.delete(req)
  }
  out.push(endOf(outcome, error, turn))
}

/** A submission: it opens an execution, or is a prompt in the one running; never counted twice. */
function submit(t: OcTracker, out: Normalized[], id: string, text: string | undefined): void {
  if (t.submitted.has(id)) return
  remember(t.submitted, id)
  if (!t.open) {
    if (t.ended.has(id)) return
    t.open = id
  }
  out.push(hook({ kind: 'prompt', text: text ?? null }, t.open))
}

/** A permission request raised, if it is the open execution's and not answered already. */
function raise(t: OcTracker, out: Normalized[], p: { id: string; messageID?: string; callID?: string; action?: string; resources?: string }): void {
  if (t.answered.has(p.id) || t.asks.has(p.id)) return
  const turn = p.messageID ? t.msgTurn.get(p.messageID) : undefined
  if (!turn || turn !== t.open) return
  const a = { call: p.callID ?? null, turn }
  t.asks.set(p.id, a)
  const message = [p.action, p.resources].filter(Boolean).join(': ')
  rememberIn(t.askText, p.id, message)
  out.push(askOf(p.id, a, message))
}

/** A permission answered (or gone): its call's end answers the wait on it. */
function answer(t: OcTracker, out: Normalized[], requestID: string): void {
  remember(t.answered, requestID)
  const a = t.asks.get(requestID)
  if (!a) return
  t.asks.delete(requestID)
  t.askText.delete(requestID)
  if (a.turn !== t.open) return
  out.push(hook({ kind: 'toolEnd', ...(a.call ? { call: a.call } : {}) }, a.turn, a.call))
  // Its answer ends the wait (the status rules: any call's end does, with hook attention); another still pending of the
  // same execution is asked again, so the agent still needs you for it.
  for (const [req, other] of t.asks) if (other.turn === a.turn) out.push(askOf(req, other, t.askText.get(req) ?? ''))
}

function askOf(_req: string, a: { call: string | null; turn: string }, message: string): Normalized {
  return hook({ kind: 'ask', ask: { kind: 'permission', blocking: true, message, ...(a.call ? { call: a.call } : {}) } }, a.turn, a.call)
}

/** A live event, as the launcher forwarded it: zero or more normalized hooks. */
export function applyEvent(t: OcTracker, gen: number, e: OcEvent): Normalized[] {
  if (gen < t.gen) return []
  // A durable event the snapshot applied last already has.
  if (typeof e.seq === 'number' && e.seq <= t.cut) return []
  const out: Normalized[] = []
  const turn = t.open
  switch (e.type) {
    case 'session.inbox.enqueued':
      if (e.inboxID && (e.itemType ?? 'user') === 'user') submit(t, out, e.inboxID, e.text)
      break
    case 'session.step.started':
      if (turn && e.assistantMessageID) rememberIn(t.msgTurn, e.assistantMessageID, turn)
      break
    case 'session.tool.called':
      if (turn) out.push(hook({ kind: 'toolStart' }, turn, e.callID ?? null))
      break
    case 'session.tool.success':
    case 'session.tool.failed':
      if (turn) out.push(hook({ kind: 'toolEnd', ...(e.callID ? { call: e.callID } : {}) }, turn, e.callID ?? null))
      break
    case 'permission.asked':
      if (e.requestID) raise(t, out, { id: e.requestID, messageID: e.messageID, callID: e.callID, action: e.action, resources: e.resources })
      break
    case 'permission.replied':
      if (e.requestID) answer(t, out, e.requestID)
      break
    case 'session.retry.scheduled': {
      const of = e.assistantMessageID ? t.msgTurn.get(e.assistantMessageID) : undefined
      if (of && of === turn) out.push(hook({ kind: 'retry', status: typeof e.error?.status === 'number' ? e.error.status : null, network: e.error?.type === 'provider.transport' }, turn))
      break
    }
    case 'session.execution.succeeded':
      close(t, out, 'succeeded')
      break
    case 'session.execution.failed':
      close(t, out, 'failed', e.error)
      break
    case 'session.execution.interrupted':
      close(t, out, 'interrupted')
      break
  }
  return out
}

/** One execution as a snapshot's messages show it: its submissions, its assistant messages, its end if it has one. */
interface Execution {
  turn: string | null
  users: OcMessage[]
  assistants: string[]
  closed: OcMessage | null
}

/** A snapshot's messages (oldest first) split into executions; the first may have begun before the window (turn null). */
export function executionsOf(messages: readonly OcMessage[]): Execution[] {
  const out: Execution[] = []
  let cur: Execution | null = null
  for (const m of messages) {
    if (m.type === 'user') {
      if (!cur) {
        cur = { turn: m.id, users: [], assistants: [], closed: null }
        out.push(cur)
      }
      cur.users.push(m)
    } else if (m.type === 'idle') {
      if (!cur) out.push({ turn: null, users: [], assistants: [], closed: m })
      else cur.closed = m
      cur = null
    } else {
      if (!cur) {
        cur = { turn: null, users: [], assistants: [], closed: null }
        out.push(cur)
      }
      cur.assistants.push(m.id)
    }
  }
  return out
}

/** A settled snapshot, applied: what it shows that Combwork hasn't had, in order; zero or more normalized hooks. */
export function applySnapshot(t: OcTracker, gen: number, s: OcSnapshot): Normalized[] {
  if (gen < t.gen) return []
  t.gen = gen
  t.cut = s.w
  const out: Normalized[] = []
  const execs = executionsOf(s.messages)
  // The launch's first snapshot of a resumed session: what closed before it is history, counted nothing.
  const history = s.baseline && s.intent === 'resume' && !t.baselined
  if (s.baseline) t.baselined = true
  for (const x of execs) {
    // The execution the window begins inside (its submission before the boundary): the open one, if it is known.
    const turn = x.turn ?? (s.boundary === 'known' ? t.open : null)
    if (history && x.closed) {
      if (x.turn) remember(t.ended, x.turn)
      for (const u of x.users) remember(t.submitted, u.id)
      continue
    }
    if (!turn) continue
    for (const u of x.users) submit(t, out, u.id, u.text)
    if (t.open !== turn) continue
    for (const a of x.assistants) rememberIn(t.msgTurn, a, turn)
    if (x.closed) close(t, out, x.closed.outcome, x.closed.error)
  }
  // What the session itself says, where the messages couldn't (bounded out): idle ends the open execution by its outcome.
  const idle = typeof s.session.idle === 'number' && typeof s.session.busy === 'number' && s.session.idle >= s.session.busy && !!s.session.outcome
  if (idle && t.open) close(t, out, s.session.outcome, s.session.error)
  // Permissions: the pending ones of the open execution raised; those gone since (answered meanwhile) answered.
  const pending = new Set(s.permissions.map((p) => p.id))
  for (const req of [...t.asks.keys()]) if (!pending.has(req)) answer(t, out, req)
  for (const p of s.permissions) raise(t, out, p)
  return out
}

/** A raw body from the launcher, turned into the bodies it stands for (each carrying one normalized hook). */
export function expandOpencodeHook(memo: Record<string, unknown>, body: Record<string, any>): Record<string, unknown>[] | null {
  const t = trackerOf(memo)
  const gen = typeof body.gen === 'number' ? body.gen : 0
  let got: Normalized[]
  if (body.hook_event_name === 'OpencodeEvent' && body.event && typeof body.event === 'object') got = applyEvent(t, gen, body.event as OcEvent)
  else if (body.hook_event_name === 'OpencodeSnapshot' && body.snapshot && typeof body.snapshot === 'object') got = applySnapshot(t, gen, body.snapshot as OcSnapshot)
  else return null
  return got.map((normalized) => ({ hook_event_name: 'OpencodeNormalized', session_id: body.session_id ?? null, normalized }))
}

/** A normalized body (expandOpencodeHook's) as Combwork's hook; anything else is ignored. */
export function normalizeOpencodeHook(body: Record<string, any>): NormalizedHook {
  const n = body?.hook_event_name === 'OpencodeNormalized' ? (body.normalized as Normalized | undefined) : undefined
  const sessionId = typeof body?.session_id === 'string' ? body.session_id : null
  return { event: n?.event ?? { kind: 'ignore' }, sessionId, transcriptPath: null, mode: null, editedPaths: [], ids: n?.ids ?? ids(null) }
}
