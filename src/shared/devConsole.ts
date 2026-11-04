/**
 * The developer console's capture (#366, #636): what each CLI sends Hive, next to what Hive made of it, kept in a
 * bounded ring per source while someone watches. Pure (no Node, no Electron), so the main process, the window and the
 * hive MCP server share it and it is unit tested.
 *
 * Redacted at capture: a payload is copied field by field, never passed through. Strings stay only where they are
 * identifiers or paths (a hook's name, a session id, a tool's name, a file path); text (prompts, messages, replies,
 * commands, titles, anything with spaces) becomes "<text: N chars>"; a field named like a secret is masked whatever it
 * holds, and anything kept that looks like a token or key is masked too (redact.ts). Including text is an opt-in of a
 * subscriber (the user's own recording, #638), never of an agent; secrets are masked even then.
 */
import type { ProviderId } from './types'
import { maskSecrets, maskText } from './redact'

/** Who sends the events: one agent's session (the Assistant's too), or Hive itself in a workspace. */
export type ConsoleSourceKind = 'session' | 'assistant' | 'hive'

/**
 * What an event is: a CLI's hook, status line, transcript records or terminal markers; a line Hive typed into it; its
 * launch and exit; Hive's own work (Agent API calls, the hook server, watches, the merge slot, Progress); or a trigger
 * of the flight recorder firing (#698).
 */
export const CONSOLE_KINDS = ['hook', 'statusline', 'transcript', 'terminal', 'input', 'launch', 'exit', 'api', 'hook-server', 'watch', 'merge-slot', 'progress', 'trigger'] as const
export type ConsoleKind = (typeof CONSOLE_KINDS)[number]

export interface ConsoleSource {
  /** Stable for an agent across its launches: `session:<project path, lower case>#<agent id>`; `hive:<workspace path, lower case>`. */
  id: string
  kind: ConsoleSourceKind
  /** "hive · HB6", "Assistant", "Combwork". */
  label: string
  workspacePath: string
  projectPath?: string
  project?: string
  agentId?: string
  agent?: string
  provider?: ProviderId
  /** Whether it is being captured now (someone watches it), and how many events its ring holds. */
  capturing: boolean
  events: number
}

/** One captured event: the raw payload (redacted) and what Hive made of it, in Hive's own words and fields. */
export interface ConsoleEvent {
  /** Increases across every source, so `since` works across sources and after a ring is dropped and made again. */
  seq: number
  at: string
  source: string
  kind: ConsoleKind
  /** The event's own name: a hook's ("PreToolUse"), an API route ("GET /v1/tasks"), a terminal marker ("title"). */
  name: string
  provider?: ProviderId
  /** One line: what came in and what Hive did ("PreToolUse (Edit) → toolStart; working"). Hive's words only. */
  summary: string
  raw?: unknown
  made?: unknown
  /** The event's size as JSON, which the ring's byte bound counts. */
  bytes: number
  /** The payload was too large and was cut down to its outline. */
  truncated?: true
}

/** A recording of one source to a file (#638): one going on in a window, or the newest in Hive's recordings folder. */
export interface ConsoleRecordingInfo {
  /** The file's name in the recordings folder ("console-20261012-091503-session.jsonl"). */
  name: string
  file: string
  /** The source's label ("alpha · B1"), kind and provider. */
  label: string
  kind: string
  provider?: string
  /** Prompt and reply text kept: the user's opt-in for this recording. */
  includeText: boolean
  startedAt: string
  endedAt?: string
  events: number
  bytes: number
  /** Events the recording lost (a burst past its queue). */
  dropped: number
  /** Still being written. */
  recording: boolean
  reason?: 'stopped' | 'closed' | 'workspace' | 'limit' | 'failed' | 'captured'
  /** A flight recorder capture (#698): the trigger that fired and what it saw, in English. */
  capture?: { trigger: string; what: string; whatText?: { id: string; values: Record<string, string | number> } }
  /** Why a failed recording failed (its file is kept as it was written). */
  error?: string
}

/** What a capture point gives: the rest is filled in as it is kept. */
export interface CapturedEvent {
  kind: ConsoleKind
  name: string
  summary: string
  provider?: ProviderId
  raw?: unknown
  made?: unknown
  /** Where in `raw` and `made` a string may be kept (a field path from the payload's root): every other string is hidden. */
  safe?: { raw?: SafeFields; made?: SafeFields }
}

/**
 * The fields of a payload whose strings may be kept, as a tree from its root: `true` keeps that field's string (or a list
 * of strings), an object descends into it (and into each item of a list there), and `'*'` stands for any field name at
 * that level. A string is kept only where its whole path is listed, so a name, id or model under an unlisted field (a
 * tool's input, an unknown record) stays hidden.
 */
export interface SafeFields {
  [key: string]: true | SafeFields
}

/** A ring's bounds: by count and by bytes, whichever is reached first; the oldest events go. */
export const RING_MAX_EVENTS = 500
export const RING_MAX_BYTES = 1024 * 1024
/** One event at most: past this its payloads are cut to their outline. */
export const EVENT_MAX_BYTES = 32 * 1024

const sessionPrefix = 'session:'
const hivePrefix = 'hive:'
export const sessionSourceId = (projectPath: string, agentId: string): string => `${sessionPrefix}${projectPath.toLowerCase()}#${agentId}`
export const hiveSourceId = (workspacePath: string): string => `${hivePrefix}${workspacePath.toLowerCase()}`
export function parseSourceId(id: string): { kind: 'session'; projectPath: string; agentId: string } | { kind: 'hive'; workspacePath: string } | null {
  if (id.startsWith(hivePrefix) && id.length > hivePrefix.length) return { kind: 'hive', workspacePath: id.slice(hivePrefix.length) }
  if (!id.startsWith(sessionPrefix)) return null
  const at = id.lastIndexOf('#')
  if (at <= sessionPrefix.length || at === id.length - 1) return null
  return { kind: 'session', projectPath: id.slice(sessionPrefix.length, at), agentId: id.slice(at + 1) }
}

/**
 * Who reads the console through the Agent API (#366 decision 6): a project agent its own sessions only (by its own
 * token, never what a request says); the Assistant its workspace's sessions (its own included) and Hive's events there;
 * the workspace token and viewers any open workspace's. The window is the user's and reads every source of its own.
 */
export type ConsoleReader = { kind: 'agent'; projectPath: string; agentId: string } | { kind: 'assistant'; workspace: string } | { kind: 'all' }

const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Whether a reader may read a source. `workspaceOfProject` says which open workspace a session's folder is in (null: none). */
export function mayRead(reader: ConsoleReader, source: string, workspaceOfProject: (projectPath: string) => string | null): boolean {
  const s = parseSourceId(source)
  if (!s) return false
  if (reader.kind === 'all') return true
  if (reader.kind === 'agent') return s.kind === 'session' && samePath(s.projectPath, reader.projectPath) && s.agentId === reader.agentId
  if (s.kind === 'hive') return samePath(s.workspacePath, reader.workspace)
  const ws = workspaceOfProject(s.projectPath)
  return !!ws && samePath(ws, reader.workspace)
}

/** A source's ring: the newest events within its bounds (one larger than the whole ring isn't kept). */
export class ConsoleRing {
  private list: ConsoleEvent[] = []
  private size = 0
  constructor(
    readonly maxEvents = RING_MAX_EVENTS,
    readonly maxBytes = RING_MAX_BYTES
  ) {}
  push(e: ConsoleEvent): void {
    this.list.push(e)
    this.size += e.bytes
    while (this.list.length > this.maxEvents || (this.size > this.maxBytes && this.list.length > 0)) this.size -= this.list.shift()!.bytes
  }
  get count(): number {
    return this.list.length
  }
  get bytes(): number {
    return this.size
  }
  /** Events after `since` (a seq), oldest first, at most `limit` of the newest ones. */
  since(since = 0, limit = Infinity): ConsoleEvent[] {
    const after = this.list.filter((e) => e.seq > since)
    return limit < after.length ? after.slice(after.length - limit) : after
  }
  find(seq: number): ConsoleEvent | undefined {
    return this.list.find((e) => e.seq === seq)
  }
  all(): ConsoleEvent[] {
    return [...this.list]
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** A field name's words, lower case: `idToken`, `id_token`, `ID-Token` and `idtoken`'s parts are all [id, token]. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Words that make a field a secret or a sign-in, alone or (the pairs) side by side, or as the whole name run together. */
const SECRET_WORDS = new Set(['token', 'secret', 'secrets', 'password', 'passwd', 'passphrase', 'apikey', 'credential', 'credentials', 'cookie', 'cookies', 'authorization', 'auth', 'oauth', 'login', 'signin', 'bearer', 'otp', 'jwt', 'idtoken', 'accesstoken', 'refreshtoken', 'devicecode', 'usercode', 'privatekey', 'sessionkey', 'accesskey'])
const SECRET_PAIRS = new Set(['api key', 'access key', 'private key', 'session key', 'secret key', 'device code', 'user code', 'verification uri', 'sign in', 'log in', 'client secret', 'code verifier']) // i18n-ignore: field-name words the redaction matches payload keys against, never shown
/** Words that make a field text someone wrote (a person, the model, a CLI, a tool's arguments). */
const TEXT_WORDS = new Set(['prompt', 'prompts', 'message', 'messages', 'text', 'content', 'reason', 'title', 'summary', 'response', 'result', 'results', 'output', 'stdout', 'stderr', 'error', 'errors', 'description', 'question', 'answer', 'body', 'line', 'lines', 'screen', 'command', 'commands', 'query', 'instructions', 'todos', 'value', 'subject', 'string', 'pattern', 'url', 'args', 'arguments', 'ask', 'asks', 'thinking', 'comment', 'note', 'notes'])

export function isSecretKey(key: string): boolean {
  const w = wordsOf(key)
  if (w.some((x) => SECRET_WORDS.has(x)) || SECRET_WORDS.has(w.join(''))) return true
  for (let i = 0; i + 1 < w.length; i++) if (SECRET_PAIRS.has(`${w[i]} ${w[i + 1]}`)) return true
  return false
}
export const isTextKey = (key: string): boolean => wordsOf(key).some((x) => TEXT_WORDS.has(x))

/** A string kept in a safe field: an identifier, a version, a model id, an enum (no spaces). */
const IDENTIFIER = /^[\w.:@/+#=-]{1,120}$/
/** An absolute path on one line (folders are the user's own machine's: the console is local; recordings say more, #638). */
const PATH = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^\r\n]{0,400}$/
const ISO_TIME = /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?$/

export interface RedactOptions {
  /** Keep text (cut to TEXT_MAX); secrets and sign-ins are still masked. Off by default. */
  includeText?: boolean
}
const TEXT_MAX = 2000
const MAX_DEPTH = 6
const MAX_ITEMS = 40
const MAX_KEYS = 60
/** A field's name, at most: a longer one is cut (a payload's keys are bounded like its values). */
const KEY_MAX = 64

const hidden = (s: string): string => `<text: ${s.length} chars>`
const keyOf = (k: string): string => (k.length > KEY_MAX ? `${k.slice(0, KEY_MAX)}…` : k)

/**
 * Where a value sits. `secret`: under a secret or sign-in field, masked whole. `text`: under text someone wrote, where no
 * string is kept, whatever the safe fields say. `plain`: a string is kept only where the safe fields list its path.
 */
type Context = 'secret' | 'text' | 'plain'

/**
 * A redacted, bounded copy of a payload (see the top of this file). `safe` lists the fields whose strings may be kept;
 * without it, no string is. Never throws: what it can't copy it describes.
 */
export function redactPayload(value: unknown, opts: RedactOptions = {}, safe?: SafeFields): unknown {
  return copy(value, '', 'plain', safe, true, 0, opts)
}

function copy(v: unknown, key: string, ctx: Context, safe: SafeFields | true | undefined, exact: boolean, depth: number, opts: RedactOptions): unknown {
  // A field's context follows everything under it: a secret's or a prompt's children are the secret's or the prompt's.
  if (ctx !== 'secret' && key && isSecretKey(key)) ctx = 'secret'
  // A text field holds no kept string, unless the safe fields name it as an envelope (a transcript record's message: its
  // model and role, never its text). Listing a text field itself as safe, or reaching it through '*', keeps nothing.
  else if (ctx === 'plain' && key && isTextKey(key) && !(exact && typeof safe === 'object')) ctx = 'text'
  if (v === undefined) return undefined
  if (ctx === 'secret') return v === null || v === '' ? v : '<redacted>'
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'string') return redactString(v, ctx === 'plain' && safe === true, opts)
  if (typeof v !== 'object') return `<${typeof v}>`
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? `<${v.length} items>` : '<object>'
  if (Array.isArray(v)) {
    // A list's items are judged as the field that holds them: its safe fields apply to each.
    const items = v.slice(0, MAX_ITEMS).map((x) => copy(x, key, ctx, safe, exact, depth + 1, opts))
    if (v.length > MAX_ITEMS) items.push(`<${v.length - MAX_ITEMS} more>`)
    return items
  }
  const out: Record<string, unknown> = {}
  const entries = Object.entries(v as Record<string, unknown>)
  const under = typeof safe === 'object' ? safe : undefined
  for (const [k, x] of entries.slice(0, MAX_KEYS)) {
    const named = !!under && Object.hasOwn(under, k)
    const c = copy(x, k, ctx, under && (named ? under[k] : under['*']), named, depth + 1, opts)
    if (c !== undefined) out[keyOf(k)] = c
  }
  if (entries.length > MAX_KEYS) out['<more>'] = `${entries.length - MAX_KEYS} more fields` // i18n-ignore: a redaction placeholder in the developer console's event data, recorded like a log, stays English (#1104)
  return out
}

function redactString(s: string, safe: boolean, opts: RedactOptions): string {
  if (!s) return s
  if (opts.includeText) {
    if (s.length <= TEXT_MAX) return maskText(s)
    // Cut to the cap first, so masking never reads more than it (the Assistant's rule, #699 round 6): what is past the cap
    // is dropped, so nothing can leak from it. A word the cut goes through is dropped whole, so no part of a secret too
    // short to be recognised is kept.
    let end = TEXT_MAX
    if (!/\s/.test(s[TEXT_MAX])) while (end > 0 && !/\s/.test(s[end - 1])) end--
    return `${maskText(s.slice(0, end))}…`
  }
  if (safe && (IDENTIFIER.test(s) || PATH.test(s) || ISO_TIME.test(s))) return maskSecrets(s)
  return hidden(s)
}

/** A word for an event's name or a summary: kept when it is an identifier (a hook's or a tool's name), else said to be text. Never more than `max`. */
export function safeWord(v: unknown, max = 64): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v !== 'string' || !v) return ''
  return v.length <= max && IDENTIFIER.test(v) ? maskSecrets(v) : hidden(v)
}

/** A name of Hive's own (an agent's, a project's) for display: cut and on one line; secrets masked. */
export const hiveName = (v: unknown, max = 40): string => (typeof v === 'string' ? maskSecrets(v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max)) : '')

/** An event's name and summary at most (characters). */
const NAME_MAX = 80
const SUMMARY_MAX = 300

/**
 * Every string and field name of a payload as redacted, masked as free text (`maskText`, redact.ts): whatever field a
 * secret sits in, and whatever the text setting kept. Bounded as the payload is (redactPayload's depth, items, keys).
 */
function maskAll(v: unknown): unknown {
  if (typeof v === 'string') return maskText(v)
  if (!v || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(maskAll)
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [maskText(k), maskAll(x)]))
}

/**
 * An event as kept: its payloads redacted and bounded, its size counted, never over EVENT_MAX_BYTES. The last step
 * before its size is bounded (which only cuts) is secret masking over every string the console shows, records or gives
 * an agent: name, summary, every payload string and field name, text kept or not (#699). Its source is Hive's own key
 * (a project's folder and an agent's id, never a CLI's), compared, never shown.
 */
export function makeEvent(seq: number, at: string, source: string, c: CapturedEvent, opts: RedactOptions = {}): ConsoleEvent {
  const e: ConsoleEvent = { seq, at, source: source.slice(0, 600), kind: c.kind, name: maskText(hiveName(c.name, NAME_MAX)), summary: maskText(hiveName(c.summary, SUMMARY_MAX)), bytes: 0 }
  if (c.provider) e.provider = c.provider
  if (c.raw !== undefined) e.raw = maskAll(redactPayload(c.raw, opts, c.safe?.raw))
  if (c.made !== undefined) e.made = maskAll(redactPayload(c.made, opts, c.safe?.made))
  e.bytes = jsonBytes(e)
  if (e.bytes > EVENT_MAX_BYTES) {
    if (e.raw !== undefined) e.raw = outline(e.raw)
    if (e.made !== undefined) e.made = outline(e.made)
    e.truncated = true
    e.bytes = 0
    e.bytes = jsonBytes(e)
  }
  // Still too large (its outline's field names): only that it was cut is kept.
  if (e.bytes > EVENT_MAX_BYTES) {
    if (e.raw !== undefined) e.raw = '<cut>'
    if (e.made !== undefined) e.made = '<cut>'
    e.bytes = 0
    e.bytes = jsonBytes(e)
  }
  return e
}

/** What a payload too large to keep was: its fields' names (bounded), or its length. */
function outline(v: unknown): unknown {
  if (Array.isArray(v)) return `<${v.length} items>`
  if (v && typeof v === 'object') return { '<cut>': `${jsonBytes(v)} bytes`, fields: Object.keys(v).slice(0, MAX_KEYS).map(keyOf) }
  return typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}…` : v
}

/** A value's size as JSON in UTF-8 bytes, without Buffer (the window has none): code points over 0x7f take 2–4. */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? ''
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0x7f) n += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1
  }
  return n
}

// ---------------------------------------------------------------------------
// The safe fields of each kind of payload (where a string may be kept)
// ---------------------------------------------------------------------------

/** A hook as the CLIs send it (Claude Code's snake_case, Copilot's camelCase): its envelope, and a tool input's file path only. */
export const HOOK_FIELDS: SafeFields = {
  hook_event_name: true, hookEventName: true, session_id: true, sessionId: true, transcript_path: true, transcriptPath: true, cwd: true, permission_mode: true, permissionMode: true,
  tool_name: true, toolName: true, tool_use_id: true, toolUseId: true, source: true, trigger: true, matcher: true, notification_type: true, model: true, agent_type: true, turn_id: true, timestamp: true,
  tool_input: { file_path: true, notebook_path: true, path: true }
}
/** What Hive made of a hook: the event's kind, the status, its actions, and a PreToolUse reply's decision. */
export const HOOK_MADE_FIELDS: SafeFields = { event: { kind: true, source: true, trigger: true, call: true }, status: true, actions: true, reply: { hookSpecificOutput: { hookEventName: true, permissionDecision: true } } }
/** Claude Code's status line. */
export const STATUSLINE_FIELDS: SafeFields = { session_id: true, transcript_path: true, cwd: true, version: true, model: { id: true, display_name: true }, workspace: { current_dir: true, project_dir: true }, output_style: { name: true }, rate_limits: { '*': { resets_at: true } } }
/** The details Hive read from a status line or transcript (never the sign-in's message). */
export const DETAILS_FIELDS: SafeFields = { modelName: true, modelId: true, effort: true, permissionMode: true, signInAt: true, interruptedAt: true, planUsage: { provider: true, plan: true, updatedAt: true, limits: { id: true, label: true, resetsAt: true } } }
/** A transcript read: each record's envelope (Claude Code's and Codex's), never its content's text or a tool's input. */
export const TRANSCRIPT_FIELDS: SafeFields = {
  newest: {
    type: true, subtype: true, timestamp: true, sessionId: true, session_id: true, cwd: true, version: true, uuid: true, parentUuid: true, requestId: true,
    message: { id: true, model: true, role: true, type: true, stop_reason: true, content: { type: true, name: true, id: true, tool_use_id: true } },
    payload: { type: true, model: true, effort: true, approval_policy: true, cwd: true, call_id: true, name: true, id: true, status: true, sandbox_policy: { mode: true, type: true }, rate_limits: { plan_type: true, '*': { resets_at: true } } }
  }
}
