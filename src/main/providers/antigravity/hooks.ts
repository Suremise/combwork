import { join, resolve } from 'path'
import { open, stat } from 'original-fs/promises'
import { advanced } from '../../advanced'
import { hookForwardCommand, keepBounded } from '../common'
import type { Ask, HookEvent, LiveDetails, LockDecision, NormalizedHook } from '../types'
import { brainDir } from './home'

// The Antigravity CLI's hooks and status line (HI-2545, against agy 1.5.0: its own hooks.md and status-line docs, and the
// payloads HI-2543's and HI-2545's runs recorded, tests/fixtures/advanced/*-antigravity-1.5.0.*).
// agy sends no prompt hook: PreInvocation is a model invocation (one per model call, `invocationNum` counting them in an
// execution), never a turn. A turn is a USER_INPUT step in the conversation's transcript, which prepareHook reads at the
// first invocation of an execution: its step index is the turn's identity, so a repeated prompt is a new turn and a hook's
// continuation (a Stop carried on, a forced continuation) or a later invocation is none.

/** A conversation id agy made: a UUID, safe as a folder name (never a path). */
export const isConversationId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** agy's hook events (hooks.md): Combwork's handler for each, in the profile's hooks.json. */
export const AGY_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const // i18n-ignore: a CLI's hook event names
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse'])

/** The field prepareHook adds to a hook: the user's prompt that began this execution, from the transcript. */
export const USER_STEP = 'combworkUserStep'
export type UserStep = { index: number; text: string }

/**
 * Combwork's named hook for the profile's hooks.json (hooks.md's format: SessionStart, Pre/PostInvocation and Stop flat,
 * the tool events grouped under a matcher). Each handler forwards its payload to Combwork's hook server with the launch's
 * token (hookForwardCommand: agy runs it through `cmd /c`), naming its event in the URL, as agy's payloads don't.
 * `toolHooks`: whether the tool events are installed (their reply's meaning without a decision, HI-2545's open fact 1).
 */
export function agyHooks(hookUrl: string, authFile: string, toolHooks: boolean): Record<string, unknown> {
  const handler = (event: string): Record<string, unknown> => {
    const seconds = advanced.number(event === 'PreToolUse' ? 'antigravity.hooks.preToolUseTimeoutSeconds' : 'antigravity.hooks.timeoutSeconds')
    // agy's own limit a little past curl's, so curl's ends first and agy never kills it mid-reply.
    return { type: 'command', command: hookForwardCommand(`${hookUrl}&event=${event}`, authFile, seconds), timeout: seconds + 2 }
  }
  const hook: Record<string, unknown> = {}
  for (const event of AGY_EVENTS) {
    if (TOOL_EVENTS.has(event) && !toolHooks) continue
    hook[event] = TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler(event)] }] : [handler(event)]
  }
  return { combwork: hook }
}

/** The text of a user's prompt in its transcript step (agy wraps it with metadata: the advanced pattern takes it out). */
export function userRequestText(content: unknown, pattern: RegExp | null = advanced.pattern('antigravity.transcript.userRequest')): string {
  if (typeof content !== 'string') return ''
  const m = pattern?.exec(content)
  return (m?.[1] ?? content).trim()
}

/**
 * The newest user prompt among a transcript's steps before `before` (PreInvocation's `initialNumSteps`): a USER_INPUT step
 * the user (or Combwork, typing for them) wrote, `source: USER_EXPLICIT`. Null when none is there (not written yet).
 */
export function newestUserStep(transcript: string, before: number): UserStep | null {
  let best: UserStep | null = null
  for (const line of transcript.split('\n')) {
    if (!line.includes('USER_INPUT')) continue
    let s: Record<string, unknown>
    try {
      s = JSON.parse(line)
    } catch {
      continue
    }
    const index = Number(s.step_index)
    if (s.type !== 'USER_INPUT' || s.source !== 'USER_EXPLICIT' || !Number.isInteger(index) || index < 0 || index >= before) continue
    if (!best || index > best.index) best = { index, text: userRequestText(s.content) }
  }
  return best
}

/** The transcript of `conversation` in an agent's own profile (never a path a hook names elsewhere). */
export function profileTranscript(profile: string, conversation: string): string | null {
  if (!isConversationId(conversation)) return null
  return join(brainDir(profile), conversation, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/** Whether `path` is that transcript (its full or its plain form), as a hook named it. */
export function isProfileTranscript(path: unknown, profile: string, conversation: string): boolean {
  const own = profileTranscript(profile, conversation)
  if (!own || typeof path !== 'string' || !path) return false
  const p = resolve(path).toLowerCase()
  return p === resolve(own).toLowerCase() || p === resolve(own.replace(/transcript_full\.jsonl$/, 'transcript.jsonl')).toLowerCase()
}

/** The last `max` bytes of a file, from its last whole line (a transcript can be long: only its end is read). */
export async function readTail(file: string, max = 4 << 20): Promise<string> {
  const size = (await stat(file)).size
  const start = Math.max(0, size - max)
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/** A hook's own ids: its tool call (the conversation's step), and the turn its prompt began (prepareHook's user step). */
function ids(body: Record<string, any>, conversation: string | null): NormalizedHook['ids'] {
  const step = Number(body.stepIdx)
  const user = body[USER_STEP] as UserStep | undefined
  return {
    turn: conversation && user ? `${conversation}:u${user.index}` : null,
    call: conversation && Number.isInteger(step) ? `${conversation}:${step}` : null,
    sub: null,
    continued: false
  }
}

/** What a terminationReason says of the turn's end (hooks.md's list). */
function stopEvent(body: Record<string, any>): HookEvent {
  const why = typeof body.terminationReason === 'string' ? body.terminationReason : ''
  if (why === 'USER_CANCELED') return { kind: 'interrupt' }
  const error = typeof body.error === 'string' ? body.error : ''
  if (why === 'ERROR' || why.startsWith('MAX_') || error) return { kind: 'stop', lastMessage: error || why || null, failed: true }
  return { kind: 'stop', lastMessage: null }
}

/** agy's hook, as the CLI sent it (its event name from the URL, servers.ts) and prepareHook added to it. */
export function normalizeAgyHook(body: Record<string, any>): NormalizedHook {
  const conversation = isConversationId(body.conversationId) ? body.conversationId : null
  const transcriptPath = typeof body.transcriptPath === 'string' && body.transcriptPath ? body.transcriptPath : null
  const base = { sessionId: conversation, transcriptPath, mode: null, editedPaths: [] as string[], ids: ids(body, conversation) }
  switch (body.hook_event_name) {
    case 'SessionStart':
      return { ...base, event: { kind: 'start', source: null } }
    case 'PreToolUse':
      return { ...base, event: { kind: 'toolStart' } }
    case 'PostToolUse':
      return { ...base, event: { kind: 'toolEnd', ...(base.ids.call ? { call: base.ids.call } : {}) } }
    case 'PreInvocation': {
      // Never a turn by itself: only the user's step prepareHook found for this execution's first invocation.
      const user = body[USER_STEP] as UserStep | undefined
      return { ...base, event: user ? { kind: 'prompt', text: user.text } : { kind: 'ignore' } }
    }
    case 'Stop':
      return { ...base, event: stopEvent(body) }
    default:
      return { ...base, event: { kind: 'ignore' } }
  }
}

/**
 * The user's prompts already taken, per conversation (the newest step index): a step seen again (the same execution's
 * later invocation, a continuation) is no new prompt. Bounded: a conversation not seen lately starts again from its file.
 */
export class UserSteps {
  private seen = new Map<string, number>()

  /** The step if it is one not taken yet in `conversation`, marking it taken; else null. */
  take(conversation: string, step: UserStep): UserStep | null {
    const last = this.seen.get(conversation)
    if (last !== undefined && step.index <= last) return null
    keepBounded(this.seen, conversation, step.index)
    return step
  }
}

/**
 * Reads the user's prompt for a PreInvocation that begins an execution (`invocationNum` 0) from this agent's own
 * transcript, adding it to the hook (USER_STEP) when it is new. The step may not be on disk yet: read again a few times
 * within `waitMs`, then nothing (never a guessed turn). A hook of another conversation (a sub-agent's, while the launch
 * has one) gets none: only the launch's conversation's prompts are the user's.
 */
export async function addUserStep(body: Record<string, any>, profile: string, sessionId: string | null, taken: UserSteps, waitMs = 2000): Promise<void> {
  if (body.hook_event_name !== 'PreInvocation' || Number(body.invocationNum) !== 0) return
  const conversation = body.conversationId
  if (!isConversationId(conversation) || (sessionId && sessionId !== conversation)) return
  const file = profileTranscript(profile, conversation)
  if (!file || (body.transcriptPath && !isProfileTranscript(body.transcriptPath, profile, conversation))) return
  const before = Number(body.initialNumSteps)
  if (!Number.isInteger(before) || before < 1) return
  const until = Date.now() + waitMs
  for (;;) {
    const text = await readTail(file).catch(() => '')
    const step = newestUserStep(text, before)
    // The newest user step before this invocation: written once agy took the prompt (the step `before - 1`, or earlier
    // when agy put its own steps after it).
    if (step) {
      const fresh = taken.take(conversation, step)
      if (fresh) body[USER_STEP] = fresh
      return
    }
    if (Date.now() >= until) return
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** The reply to PreToolUse for a locked file (hooks.md: `decision`, `reason`). A warning has no place there: none. */
export function agyLockReply(d: LockDecision): Record<string, unknown> {
  if (d.kind === 'deny') return { decision: 'deny', reason: d.reason }
  // Always asked, even where the person allowed the tool before (force_ask ignores agy's remembered approvals).
  if (d.kind === 'ask') return { decision: 'force_ask', reason: d.reason }
  return {}
}

/**
 * A notice's reply at this event (#650): before the model's next call (PreInvocation, an ephemeral message dropped after
 * the turn), or carrying the turn on at its Stop (a `continue`, its reason put before the model). PostToolUse takes no
 * context in agy (hooks.md: `{}`): none there.
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
 * A permission prompt the status line says agy shows (`tool_confirmation_pending`, as its status-line docs name it): agy
 * sends no hook for one. Blocking; agy doesn't say what it asks (its screen does).
 * TODO(HI-2545, open fact 3): an advanced field once a status line at a prompt is recorded (its sample).
 */
export function agyStatusAsk(body: Record<string, any>): Ask | null {
  return body?.tool_confirmation_pending === true ? { kind: 'permission', blocking: true, message: '' } : null
}

/**
 * What the status line says of the session (the status-line docs): the model by its name (its `id` is a display name too,
 * HI-2544: never matched as an id), its effort and the context window. Its usage and estimated cost are HI-2546's.
 */
export function agyStatusDetails(body: Record<string, any>): LiveDetails {
  const d: LiveDetails = {}
  const model = body?.model
  if (model && typeof model === 'object') {
    if (typeof model.display_name === 'string' && model.display_name) d.modelName = model.display_name
    if (typeof model.effort === 'string' && model.effort) d.effort = model.effort
  }
  const size = Number(body?.context_window?.context_window_size)
  if (Number.isFinite(size) && size > 0) d.contextWindow = size
  return d
}
