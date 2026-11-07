import { join } from 'path'
import { open, stat } from 'original-fs/promises'
import { advanced } from '../../advanced'
import { hookForwardCommand, readFirstLine } from '../common'
import type { Ask, HookEvent, LockDecision, NormalizedHook } from '../types'
import { TRANSCRIPT_FILE, isConversationId, logsDir, trustedTranscript } from './conversations'
import { knownStep, parentOf, parseStep, userRequestText, type AgyStep } from './transcript'

// The Antigravity CLI's hooks and status line (HI-2545, design s56; agy 1.5.0's hooks.md and the payloads its recorded
// runs gave: tests/fixtures/advanced/*-antigravity-1.5.0.*, and the card's "real-agy facts").
//
// agy sends no prompt hook. A turn begins at a PreInvocation with `invocationNum` 0 (a model call that no earlier call of
// the turn made: a Stop continuation doesn't reset the count), and what began it is the step `initialNumSteps - 1`, on disk
// by then: the user's USER_INPUT, or a step agy wrote itself (a subagent's answer). Each such invocation zero is a turn
// `<conversation>:i<initialNumSteps>`, admitted once per launch. Every later event of the conversation belongs to the
// latest invocation zero at or before its position (PreInvocation's and PostInvocation's `initialNumSteps`, a tool hook's
// `stepIdx`: steps only grow), and a Stop, which carries no position, to the conversation's latest: agy 1.5.0 waits for
// each hook's reply before it goes on and never sends one again, so a turn's Stop reaches Combwork before the next turn's
// invocation zero. Each hook is prepared once, in the launch's order (prepareHook: what it is, decided from its raw fields
// and the transcript), and normalizeHook only reads that decision.

/** agy's hook events (hooks.md): Combwork's handler for each, in the profile's hooks.json. */
export const AGY_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const // i18n-ignore: a CLI's hook event names
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse'])

/** The reply that lets a tool run under agy's own permission check (1.5.0: `allow` defers to it; `{}` denies the tool). */
export const AGY_ALLOW = { decision: 'allow' } as const

/**
 * Combwork's named hook for the profile's hooks.json (hooks.md's format: SessionStart, Pre/PostInvocation and Stop flat,
 * the tool events under a matcher). Each forwards its payload to Combwork's hook server with the launch's token
 * (hookForwardCommand, run by agy through `cmd /c`), naming its event in the URL, as agy's payloads don't. PreToolUse's
 * answers allow when Combwork can't be reached (agy takes no answer as a denial: a closed Combwork would stop every tool).
 * `toolHooks` off: no tool events (no file locks).
 */
export function agyHooks(hookUrl: string, authFile: string, toolHooks: boolean): Record<string, unknown> {
  const handler = (event: string): Record<string, unknown> => {
    const seconds = advanced.number(event === 'PreToolUse' ? 'antigravity.hooks.preToolUseTimeoutSeconds' : 'antigravity.hooks.timeoutSeconds')
    const forward = hookForwardCommand(`${hookUrl}&event=${event}`, authFile, seconds)
    // agy's own limit a little past curl's, so curl's ends first and agy never kills it mid-reply.
    return { type: 'command', command: event === 'PreToolUse' ? `${forward} || echo ${JSON.stringify(AGY_ALLOW)}` : forward, timeout: seconds + 2 } // i18n-ignore: a hook command the CLI runs
  }
  const hook: Record<string, unknown> = {}
  for (const event of AGY_EVENTS) {
    if (TOOL_EVENTS.has(event) && !toolHooks) continue
    hook[event] = TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler(event)] }] : [handler(event)]
  }
  return { combwork: hook }
}

/** A whole number from `min`, else null. */
const whole = (v: unknown, min: number): number | null => (Number.isSafeInteger(v) && (v as number) >= min ? (v as number) : null)

/** The argument naming the file a tool edits, for agy's edit tools (antigravity.hooks.editTools, editPathField: 1.5.0's edit_file Path). */
function editField(tool: unknown): string | null {
  if (typeof tool !== 'string') return null
  try {
    return (advanced.get<string[]>('antigravity.hooks.editTools') ?? []).includes(tool) ? advanced.get<string>('antigravity.hooks.editPathField') || null : null
  } catch {
    return null
  }
}

/** The files a tool call edits, by its arguments (an unknown tool: none). */
export function editedPaths(toolCall: unknown): string[] {
  const c = toolCall as { name?: unknown; args?: Record<string, unknown> } | null
  const field = editField(c?.name)
  const p = field && c?.args && typeof c.args === 'object' ? c.args[field] : undefined
  return typeof p === 'string' && p ? [p] : []
}

/** What prepareHook decided a hook is (on the body, once): normalizeHook reads it as it is. */
export const PREPARED = 'combworkPrepared'
export type Prepared = {
  event: HookEvent
  sessionId: string | null
  transcriptPath: string | null
  editedPaths: string[]
  turn: string | null
  call: string | null
  sub: string | null
  continued: boolean
  /** A PreInvocation after the first of its turn, which may carry a checkpoint: its conversation and position. */
  checkpoint?: { conversation: string; at: number }
}

const IGNORE = (sub: string | null = null): Prepared => ({ event: { kind: 'ignore' }, sessionId: null, transcriptPath: null, editedPaths: [], turn: null, call: null, sub, continued: false })

/** What a terminationReason says of the turn's end (hooks.md's list). */
function stopEvent(body: Record<string, any>): HookEvent {
  const why = typeof body.terminationReason === 'string' ? body.terminationReason : ''
  if (why === 'USER_CANCELED') return { kind: 'interrupt' }
  const error = typeof body.error === 'string' ? body.error : ''
  if (why === 'ERROR' || why.startsWith('MAX_') || error) return { kind: 'stop', lastMessage: error || why || null, failed: true }
  return { kind: 'stop', lastMessage: null }
}

/**
 * agy's hook as Combwork handles it: prepareHook's decision when it made one, else (not prepared: the lock check and the
 * reply's, which run before it, or one whose preparation failed) only what its raw fields say for sure. A tool's start
 * with the files it edits (file locks never depend on whose conversation it is) and a tool's end; anything else is left
 * out, never a guessed turn or session.
 */
export function normalizeAgyHook(body: Record<string, any>): NormalizedHook {
  const p = body[PREPARED] as Prepared | undefined
  if (p) return { event: p.event, sessionId: p.sessionId, transcriptPath: p.transcriptPath, mode: null, editedPaths: p.editedPaths, ids: { turn: p.turn, call: p.call, sub: p.sub, continued: p.continued } }
  const conv = isConversationId(body.conversationId) ? body.conversationId : null
  const step = whole(body.stepIdx, 0)
  const call = conv && step !== null ? `${conv}:${step}` : null
  const base = { sessionId: null, transcriptPath: null, mode: null, ids: { turn: null, call, sub: null, continued: false } }
  if (body.hook_event_name === 'PreToolUse') return { ...base, editedPaths: editedPaths(body.toolCall), event: { kind: 'toolStart' } }
  if (body.hook_event_name === 'PostToolUse') return { ...base, editedPaths: [], event: call ? { kind: 'toolEnd', call } : { kind: 'toolEnd' } }
  return { ...base, editedPaths: [], event: { kind: 'ignore' } }
}

/** How many of a conversation's turn starts a launch keeps (older positions then belong to no known turn: left out). */
const STARTS_KEPT = 256
/** How many conversations a launch keeps turn starts and roles for (the newest; its own conversation is always the newest). */
const CONVERSATIONS_KEPT = 64
/** How many conversations' highest turn start a launch keeps (numbers only): a duplicate of an old one stays old news. */
const HIGHEST_KEPT = 4096

const keep = <V>(map: Map<string, V>, key: string, value: V, max: number): void => {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value!)
}

/**
 * One launch's memory of agy's turns (kept by sessions on the launch, dropped at its end): each conversation's turn starts
 * (invocation zeros, by `initialNumSteps`), its highest one, its role, and the latest position that got a checkpoint.
 */
export class AgyLaunchMemo {
  private starts = new Map<string, number[]>()
  private highest = new Map<string, number>()
  private roles = new Map<string, 'child' | 'own'>()
  private checkpointed = new Map<string, number>()

  /** Whether an invocation zero at `n` is a new turn: past every start this launch saw in the conversation. */
  isNewStart(conv: string, n: number): boolean {
    const h = this.highest.get(conv)
    return h === undefined || n > h
  }

  /** Records an admitted turn start. */
  addStart(conv: string, n: number): void {
    const list = [...(this.starts.get(conv) ?? []), n].slice(-STARTS_KEPT)
    keep(this.starts, conv, list, CONVERSATIONS_KEPT)
    keep(this.highest, conv, n, HIGHEST_KEPT)
  }

  /** The turn an event at position `at` belongs to: the latest start at or before it; none before the oldest kept. */
  turnAt(conv: string, at: number): string | null {
    const list = this.starts.get(conv)
    if (!list?.length) return null
    for (let i = list.length - 1; i >= 0; i--) if (list[i] <= at) return `${conv}:i${list[i]}`
    return null
  }

  /** The conversation's latest turn (a Stop's, by agy's blocking order). */
  latest(conv: string): string | null {
    const list = this.starts.get(conv)
    return list?.length ? `${conv}:i${list[list.length - 1]}` : null
  }

  role(conv: string): 'child' | 'own' | undefined {
    return this.roles.get(conv)
  }

  setRole(conv: string, role: 'child' | 'own'): void {
    keep(this.roles, conv, role, CONVERSATIONS_KEPT)
  }

  /** Whether a PreInvocation at `at` may still carry a checkpoint: past the last one given in the conversation. */
  mayCheckpoint(conv: string, at: number): boolean {
    const last = this.checkpointed.get(conv)
    return last === undefined || at > last
  }

  /** A checkpoint given at `at` (only once a reply carries it). */
  checkpointGiven(conv: string, at: number): void {
    keep(this.checkpointed, conv, Math.max(at, this.checkpointed.get(conv) ?? -1), CONVERSATIONS_KEPT)
  }
}

/** The launch's memo, kept in the record sessions gives each launch. */
export function memoOf(record: Record<string, unknown>): AgyLaunchMemo {
  const m = record.antigravity
  if (m instanceof AgyLaunchMemo) return m
  const made = new AgyLaunchMemo()
  record.antigravity = made
  return made
}

/** The most of a transcript's end read for one step (the step wanted is its last). */
const TAIL_BYTES = 1 << 20

/**
 * Step `index` of a transcript, from its end: the step (in a shape agy writes), or 'missing' while the transcript hasn't
 * reached it, or 'uncertain' when it can't be told (it has gone past it without it, the step is in another shape, or no
 * whole line at or after it fits the window). A line still being written (no newline yet) isn't read.
 */
export async function stepAt(file: string, index: number): Promise<AgyStep | 'missing' | 'uncertain'> {
  const size = (await stat(file)).size
  const start = Math.max(0, size - TAIL_BYTES)
  const fh = await open(file, 'r')
  let text: string
  try {
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    text = buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
  const lines = text.split('\n')
  lines.pop() // the part after the last newline: not a whole line yet
  if (start > 0) lines.shift() // the first: cut by the window
  let highest = -1
  for (const line of lines) {
    const s = parseStep(line)
    const i = s ? whole(s.step_index, 0) : null
    if (s === null || i === null) continue
    highest = Math.max(highest, i)
    if (i === index) return knownStep(s) ? s : 'uncertain'
  }
  if (highest > index || (start > 0 && highest === -1)) return 'uncertain'
  return 'missing'
}

/** The launch a hook is prepared for: whose profile, its conversation now, its memo, and whether it is still running. */
export type HookLaunch = { profile: string; root: string; sessionId: string | null; memo: Record<string, unknown>; alive: () => boolean; waitMs?: number }

/** A conversation's transcript in this launch's own profile, checked by its real path; null when not there. */
const ownTranscript = (l: HookLaunch, conv: string): Promise<string | null> => trustedTranscript(join(logsDir(l.profile, conv), TRANSCRIPT_FILE), l.root, conv)

/**
 * A conversation's role in the launch: its own (`primary`, the one it runs now, or another the user started or opened:
 * step 0 is the user's prompt), a subagent's (`child`: step 0 is its parent's task), or `unknown` (unreadable now).
 */
async function roleOf(l: HookLaunch, m: AgyLaunchMemo, conv: string): Promise<'primary' | 'own' | 'child' | 'unknown'> {
  if (!l.sessionId || l.sessionId.toLowerCase() === conv.toLowerCase()) return 'primary'
  const known = m.role(conv)
  if (known) return known
  const file = await ownTranscript(l, conv)
  if (!file) return 'unknown'
  const first = await readFirstLine(file).catch(() => '')
  if (parentOf(first)) {
    m.setRole(conv, 'child')
    return 'child'
  }
  const s = parseStep(first)
  if (s && knownStep(s) && s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT') {
    m.setRole(conv, 'own')
    return 'own'
  }
  return 'unknown'
}

/**
 * Decides once, in the launch's hook order, what an agy hook is (PREPARED on the body). Nothing is decided when the launch
 * ends meanwhile or a read fails: the hook is then normalized from its raw fields alone (normalizeAgyHook), and no turn
 * start is taken, so the same hook delivered again is decided afresh.
 */
export async function prepareAgyHook(body: Record<string, any>, l: HookLaunch): Promise<void> {
  if (body[PREPARED]) return
  const m = memoOf(l.memo)
  const event = body.hook_event_name
  const conv = isConversationId(body.conversationId) ? body.conversationId : null
  if (!conv) return void (body[PREPARED] = IGNORE())
  const role = await roleOf(l, m, conv)
  if (!l.alive()) return
  const sub = role === 'child' ? conv : null
  const mine = role === 'primary'
  const transcript = mine ? await ownTranscript(l, conv) : null
  const of = (p: Partial<Prepared>): Prepared => ({ ...IGNORE(sub), ...(mine ? { sessionId: conv, transcriptPath: transcript } : {}), ...p })

  if (event === 'SessionStart') return void (body[PREPARED] = mine ? of({ event: { kind: 'start', source: null } }) : IGNORE(sub))
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    if (role === 'unknown' || role === 'own') return void (body[PREPARED] = IGNORE())
    const at = whole(body.stepIdx, 0)
    const call = at === null ? null : `${conv}:${at}`
    const turn = at === null ? null : m.turnAt(conv, at)
    const ev: HookEvent = event === 'PreToolUse' ? { kind: 'toolStart' } : call ? { kind: 'toolEnd', call } : { kind: 'toolEnd' }
    return void (body[PREPARED] = of({ event: ev, editedPaths: event === 'PreToolUse' ? editedPaths(body.toolCall) : [], turn: sub ? null : turn, call }))
  }
  if (event === 'Stop') {
    if (!mine) return void (body[PREPARED] = IGNORE(sub))
    const execution = whole(body.executionNum, 0)
    return void (body[PREPARED] = of({ event: stopEvent(body), turn: m.latest(conv), continued: execution === null || execution > 0 }))
  }
  if (event !== 'PreInvocation' && event !== 'PostInvocation') return void (body[PREPARED] = IGNORE(sub))
  const invocation = whole(body.invocationNum, 0)
  const at = whole(body.initialNumSteps, 1)
  if (invocation === null || at === null || role === 'child' || role === 'unknown') return void (body[PREPARED] = IGNORE(sub))
  if (event === 'PostInvocation' || invocation > 0) {
    if (!mine) return void (body[PREPARED] = IGNORE())
    const turn = m.turnAt(conv, at)
    return void (body[PREPARED] = of({ turn, ...(event === 'PreInvocation' && turn ? { checkpoint: { conversation: conv, at } } : {}) }))
  }
  // An invocation zero: a turn, once. A duplicate or an older one is old news.
  if (!m.isNewStart(conv, at)) return void (body[PREPARED] = IGNORE())
  const file = transcript ?? (await ownTranscript(l, conv))
  let step: AgyStep | 'missing' | 'uncertain' = 'uncertain'
  if (file) {
    const until = Date.now() + (l.waitMs ?? advanced.number('antigravity.hooks.userStepWaitSeconds') * 1000)
    for (;;) {
      step = await stepAt(file, at - 1).catch(() => 'uncertain' as const)
      if (!l.alive()) return
      if (step !== 'missing' || Date.now() >= until) break
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  if (!l.alive()) return
  const user = typeof step === 'object' && step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT'
  const ev: HookEvent = user ? { kind: 'prompt', text: userRequestText((step as AgyStep).content) } : { kind: 'prompt', cli: true }
  m.addStart(conv, at)
  // The user's prompt in another of its own conversations (/new, /rewind, /resume): it carries that conversation, which
  // the launch follows (switchSession).
  body[PREPARED] = { ...IGNORE(), event: ev, sessionId: conv, transcriptPath: file, turn: `${conv}:i${at}` } satisfies Prepared
}

/** Whether a prepared PreInvocation may carry a checkpoint (not given one at its position or later yet). */
export function agyNoticeWanted(body: Record<string, any>, record: Record<string, unknown>): boolean {
  const c = (body[PREPARED] as Prepared | undefined)?.checkpoint
  return !!c && memoOf(record).mayCheckpoint(c.conversation, c.at)
}

/** A checkpoint carried by this PreInvocation's reply: its position won't carry another. */
export function agyNoticeGiven(body: Record<string, any>, record: Record<string, unknown>): void {
  const c = (body[PREPARED] as Prepared | undefined)?.checkpoint
  if (c) memoOf(record).checkpointGiven(c.conversation, c.at)
}

/**
 * The reply to PreToolUse for a file another agent holds (1.5.0: only `deny` blocks; `ask` and `force_ask` let the tool run
 * as `allow` does, so a lock that would ask is a denial saying to ask first). A warning has no place in agy's reply: the
 * tool runs (`allow`).
 */
export function agyLockReply(d: LockDecision): Record<string, unknown> {
  if (d.kind === 'deny' || d.kind === 'ask') return { decision: 'deny', reason: d.reason }
  return { ...AGY_ALLOW }
}

/**
 * A notice's reply at this event (#650, recorded with 1.5.0): before a model call (PreInvocation, an ephemeral message
 * dropped after the turn), or carrying the turn on at its Stop (a `continue`, its reason put before the model).
 */
export function agyNoticeReply(event: string, text: string): Record<string, unknown> | null {
  if (event === 'PreInvocation') return { injectSteps: [{ ephemeralMessage: text }] }
  if (event === 'Stop') return { decision: 'continue', reason: text }
  return null
}

/** Context at a session's start (SessionStart's injectSteps: a system message that stays in the conversation). */
export const agyStartContextReply = (text: string): Record<string, unknown> => ({ injectSteps: [{ systemMessage: { systemMessage: text } }] })

/** Whether a reply to Stop carries the turn on (hooks.md: `decision: "continue"`; anything else lets it stop). */
export const agyStopContinues = (reply: Record<string, any>): boolean => reply?.decision === 'continue'

/**
 * A permission prompt the status line says agy shows (recorded: `tool_confirmation_pending` true, `agent_state` tool_use,
 * while it is up; the field antigravity.statusLine.confirmField): agy sends no hook for one. Blocking; agy doesn't say
 * what it asks (its screen does).
 */
export function agyStatusAsk(body: Record<string, any>): Ask | null {
  let field = 'tool_confirmation_pending'
  try {
    field = advanced.get<string>('antigravity.statusLine.confirmField') || field
  } catch {
    // the recorded field
  }
  return body?.[field] === true ? { kind: 'permission', blocking: true, message: '' } : null
}

/** Whether the status line says agy is idle (recorded: `agent_state` idle), with no prompt pending. */
export const agyStatusIdle = (body: Record<string, any>): boolean => body?.agent_state === 'idle' && !agyStatusAsk(body)
