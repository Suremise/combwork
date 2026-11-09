import type { CompactionEvent, DayUsage, PlanLimit, PlanUsage, SessionUsage, TranscriptItem, TranscriptTool, UsageTokens } from '../../../shared/types'
import { OPENCODE } from '../../../shared/opencode'
import { isoTime } from '../../../shared/planLimits'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import { withValues, type Text } from '../../../shared/advanced'
import { msg } from '../../../shared/i18n'
import { formatToolInput } from '../claude/conversation'
import { NOTICE_TEXT, firstLine, noticeOf, shortPath, type NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation } from '../types'

// The transcript mirror Combwork keeps of an OpenCode session (HI-2762, design s7/s10/s13): OpenCode 2 keeps its history in
// its server's database, behind its API, so Combwork writes what the API (or `opencode session export`) gives into a file
// of its own, `<account root>\combwork-sessions\<id>.jsonl`, which its history and usage readers read as any transcript.
// Pure: no Electron, no files (the worker writes, the readers read), so the usage worker and unit tests load it too.
//
// One JSON object a line:
// 1. `{"type":"combwork.mirror","state":"placeholder"}`: made when Combwork first gives the path, before any read; or
//    `{"type":"combwork.mirror","state":"complete","w":…,"epoch":…,"source":"api"|"export","at":…,"updated":…}`: a
//    settled read's (or an export's), published whole. Only this line says a read completed; the file existing doesn't.
//    A subagent's session's (HI-2773) also has `"parent"` (the session that started it) and `"directory"` (its folder),
//    so the Sessions tab finds it under its parent from this line alone, and `"settled"` (whether it had ended when read).
// 2. `{"type":"combwork.session","info":{…}}`: the session as `GET /api/session/{id}` gives it (title, tokens, cost, times).
// 3. `{"type":"combwork.message","message":{…}}` per message, oldest first, as `GET /api/session/{id}/message` gives them.
// 4. At most one `{"type":"combwork.status","problem":…,"detail":…,"at":…}` last: the newest read failed (the content
//    before it is the last good one, unchanged). The history shows a notice for it; a good read rewrites the file without.
// Messages are as 2.2.6 recorded them (tests/fixtures/opencode/real-2.2.6): user, assistant (reasoning, text and tool
// parts, its tokens and cost), idle (a turn's outcome), compaction. Anything else is left out, never guessed at.

export const MIRROR = 'combwork.mirror'
export const SESSION_LINE = 'combwork.session'
export const MESSAGE_LINE = 'combwork.message'
export const STATUS_LINE = 'combwork.status'

/** Why the newest read didn't publish (the status line's `problem`). */
export type MirrorProblem = 'timeout' | 'exit' | 'size' | 'parse'
export const MIRROR_PROBLEMS: readonly MirrorProblem[] = ['timeout', 'exit', 'size', 'parse']

export interface MirrorHeader {
  type: typeof MIRROR
  state: 'placeholder' | 'complete'
  /** The durable watermark the read was settled at (-1: an export, which has none). */
  w?: number
  /** The session's ownership epoch the read was made under (historyCore). */
  epoch?: number
  source?: 'api' | 'export'
  /** When it was read (ISO). */
  at?: string
  /** The session's `time.updated` as read (ms). */
  updated?: number
  /** A subagent's session (HI-2773): the session that started it (its info's `parentID`), and the folder it ran in. */
  parent?: string
  directory?: string
  /** A subagent's: whether its info said nothing ran in it then (an unsettled one needs a final read after its run). */
  settled?: boolean
}

/** A session id as OpenCode gives one (`ses_` and letters and digits). */
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/

/**
 * The sessions a session's subagents ran in (HI-2773; 2.2.6's `subagent` tool, messages/subagent-parent.json): each tool
 * part whose `state.metadata.sessionID` names another session, with when it last started there (its `time.ran`, else its
 * creation's): a subagent resumed later starts there again. Read from the parts, never from the tool's name.
 */
export function subagentSessions(sessionId: string, messages: readonly Obj[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of messages) {
    if (m?.type !== 'assistant' || !Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (!isObj(p) || p.type !== 'tool' || !isObj(p.state) || !isObj(p.state.metadata)) continue
      const id = p.state.metadata.sessionID
      if (typeof id !== 'string' || id === sessionId || !SESSION_ID.test(id)) continue
      const at = num(p.time?.ran) || num(p.time?.created) || num(m.time?.created)
      out.set(id, Math.max(out.get(id) ?? 0, at))
    }
  }
  return out
}

/** Whether a session's info says it has nothing running (its `time.idle` at or after its `time.busy`). */
export const sessionSettled = (info: Obj): boolean => typeof info?.time?.idle === 'number' && (typeof info.time.busy !== 'number' || info.time.idle >= info.time.busy)

/**
 * What a published session's header says of it as a subagent's (its info's `parentID`, folder, and whether it had ended:
 * kept in the file, so a later worker knows an unfinished mirror needs a final read), or nothing.
 */
export function subagentHeader(info: Obj): Pick<MirrorHeader, 'parent' | 'directory' | 'settled'> {
  if (typeof info.parentID !== 'string' || !SESSION_ID.test(info.parentID)) return {}
  const dir = isObj(info.location) && typeof info.location.directory === 'string' ? info.location.directory : typeof info.directory === 'string' ? info.directory : null
  return { parent: info.parentID, ...(dir ? { directory: dir } : {}), settled: sessionSettled(info) }
}

export interface MirrorStatus {
  type: typeof STATUS_LINE
  problem: MirrorProblem
  /** OpenCode's or the CLI's own words, as they came (bounded). */
  detail: string
  at: string
}

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const iso = (ms: unknown): string | null => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null)

export const placeholderMirror = (): string => JSON.stringify({ type: MIRROR, state: 'placeholder' }) + '\n'

/** A complete mirror: its header, the session, its messages oldest first. */
export function buildMirror(header: Omit<MirrorHeader, 'type' | 'state' | 'parent' | 'directory' | 'settled'>, info: Obj, messages: readonly Obj[]): string {
  const lines = [JSON.stringify({ type: MIRROR, state: 'complete', ...header, ...subagentHeader(info) }), JSON.stringify({ type: SESSION_LINE, info })]
  for (const m of messages) lines.push(JSON.stringify({ type: MESSAGE_LINE, message: m }))
  return lines.join('\n') + '\n'
}

/** The mirror's content with no status line (the last good content). */
export function withoutStatus(text: string): string {
  const lines = text.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  if (lines.length && kindOf(lines[lines.length - 1]) === STATUS_LINE) lines.pop()
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** The last good content with one status line after it: the history then says the newest read failed. */
export function withStatus(text: string, problem: MirrorProblem, detail: string, at: string): string {
  const base = withoutStatus(text) || placeholderMirror()
  return base + JSON.stringify({ type: STATUS_LINE, problem, detail: detail.slice(0, 500), at } satisfies MirrorStatus) + '\n'
}

function kindOf(line: string): string | null {
  try {
    const o = JSON.parse(line)
    return isObj(o) && typeof o.type === 'string' ? o.type : null
  } catch {
    return null
  }
}

/** What a mirror's text says of itself: its header (null: not a mirror), its status line, its newest message's time. */
export function mirrorState(text: string): { header: MirrorHeader | null; status: MirrorStatus | null } {
  const lines = text.split('\n').filter((l) => l.trim())
  let header: MirrorHeader | null = null
  try {
    const h = JSON.parse(lines[0] ?? '')
    if (isObj(h) && h.type === MIRROR && (h.state === 'placeholder' || h.state === 'complete')) header = h as MirrorHeader
  } catch {
    header = null
  }
  let status: MirrorStatus | null = null
  try {
    const s = JSON.parse(lines[lines.length - 1] ?? '')
    if (lines.length > 1 && isObj(s) && s.type === STATUS_LINE && MIRROR_PROBLEMS.includes(s.problem)) status = s as MirrorStatus
  } catch {
    status = null
  }
  return { header, status }
}

/**
 * `opencode session export <id>`'s output (2.2.6: `{info, messages}`, messages oldest first; cli/session-export.txt), or
 * null when it isn't that shape: nothing is published from it.
 */
export function parseExport(text: string): { info: Obj; messages: Obj[] } | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(o) || !isObj(o.info) || typeof o.info.id !== 'string' || !Array.isArray(o.messages) || !o.messages.every(isObj)) return null
  return { info: o.info, messages: o.messages as Obj[] }
}

/** The newest `time.created` among messages (ms; 0 for none): an export older than the mirror isn't published. */
export const newestMessage = (messages: readonly Obj[]): number => messages.reduce((n, m) => Math.max(n, num(m?.time?.created)), 0)

/** A mirror's lines, parsed: the session's info and its messages (oldest first), and its status. */
function parseLines(lines: Iterable<string>): { header: MirrorHeader | null; info: Obj | null; messages: Obj[]; status: MirrorStatus | null } {
  let header: MirrorHeader | null = null
  let info: Obj | null = null
  let status: MirrorStatus | null = null
  const messages: Obj[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(o)) continue
    if (o.type === MIRROR) header = o as MirrorHeader
    else if (o.type === SESSION_LINE && isObj(o.info)) info = o.info
    else if (o.type === MESSAGE_LINE && isObj(o.message)) messages.push(o.message)
    else if (o.type === STATUS_LINE && MIRROR_PROBLEMS.includes(o.problem)) status = o as MirrorStatus
  }
  return { header, info, messages, status }
}

// ---- Usage

/** OpenCode's token counts (TokenUsage.Info): input without the cache, output, reasoning beside it, the cache's read and write. */
const tokensOf = (t: unknown): UsageTokens & { reasoning: number } => {
  const o = isObj(t) ? t : {}
  const cache = isObj(o.cache) ? o.cache : {}
  const reasoning = num(o.reasoning)
  // Combwork counts reasoning inside output (SessionUsage.reasoningTokens says how much of it).
  return { inputTokens: num(o.input), outputTokens: num(o.output) + reasoning, cacheReadTokens: num(cache.read), cacheWriteTokens: num(cache.write), reasoning }
}
const hasTokens = (t: unknown): boolean => isObj(t) && ['input', 'output', 'reasoning'].some((k) => typeof t[k] === 'number')

const KINDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/**
 * Usage from a mirror (HI-2762 design s13 §3). Each assistant message with tokens is a request, and each completed
 * compaction (a model request of its own): their tokens, cost and day. The session's totals are its info's, which also
 * count requests no message shows (its title's): the remainder per kind (info minus the messages) is
 * - every one ≥ 0: in the totals, and on the day of the last activity in `days` (an attribution convention, not when it
 *   ran: OpenCode doesn't say), never in the timeline, which keeps to the messages (cost per card);
 * - any < 0 (an inconsistent breakdown): the totals stay info's, and `days` and the timeline are left out, as for a
 *   session with no breakdown (usageLedger's fallback: the whole session on its last activity's day; no cost per card).
 * Without an info line (a placeholder), the messages' sums. Cost is as OpenCode reports it (`cost`), never estimated: a
 * reported 0 stays 0 (a subscription or local model can use allowance at no reported price). The mirror is rewritten
 * whole, so it is read whole each time (`rewritten`): nothing accumulates across reads.
 */
export class OpencodeUsageParser {
  static readonly rewritten = true
  private lines: string[] = []
  private partial = ''

  constructor(private readonly sessionId: string) {}

  feed(text: string): void {
    const all = this.partial + text
    const parts = all.split('\n')
    this.partial = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) this.lines.push(p)
  }

  result(title: string | null = null): SessionUsage {
    const { info, messages } = parseLines(this.partial.trim() ? [...this.lines, this.partial] : this.lines)
    return opencodeUsage(this.sessionId, info, messages, title)
  }
}

/** The inconsistent breakdowns read (for the log): the session and the kinds whose messages add up to more than its info. */
export const inconsistentBreakdowns: { sessionId: string; kinds: string[] }[] = []

export function opencodeUsage(sessionId: string, info: Obj | null, messages: readonly Obj[], title: string | null = null): SessionUsage {
  const usage: SessionUsage = { provider: OPENCODE, sessionId, title: (typeof info?.title === 'string' && info.title) || title, model: null, cliVersion: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, reasoningTokens: 0, contextTokens: 0, contextWindow: null, compactions: [], cacheTtlSeconds: 0, firstActivity: null, lastActivity: null, userMessages: 0, lastPrompt: null, costUsd: null, costEstimated: false }
  const days: Record<string, DayUsage> = {}
  const dayCost: Record<string, number> = {}
  const timeline = new TimelineBuilder()
  const reports: number[] = []
  let costSeen = false
  let cost = 0
  let pending: CompactionEvent | null = null
  const sums = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoning: 0 }
  const dayOf = (ts: string | null): DayUsage | null => {
    const d = localDay(ts)
    return d ? (days[d] ??= emptyDay()) : null
  }
  const request = (m: Obj, ts: string | null, model: string | null): (UsageTokens & { reasoning: number }) | null => {
    if (!hasTokens(m.tokens)) return null
    const t = tokensOf(m.tokens)
    const c = typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost >= 0 ? m.cost : null
    for (const k of KINDS) sums[k] += t[k]
    sums.reasoning += t.reasoning
    usage.requests++
    if (c !== null) {
      costSeen = true
      cost += c
    }
    const d = dayOf(ts)
    if (d) {
      for (const k of KINDS) d[k] += t[k]
      d.requests++
      const key = localDay(ts)
      dayCost[key] = (dayCost[key] ?? 0) + (c ?? 0)
    }
    reports.push(c ?? 0)
    timeline.add(ts, t, 1, reports.length - 1, 0, model)
    return t
  }
  for (const m of messages) {
    const ts = iso(m?.time?.created)
    if (ts) {
      if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
      if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
    }
    if (m.type === 'user' && typeof m.text === 'string') {
      usage.userMessages++
      usage.lastPrompt = m.text
      const d = dayOf(ts)
      if (d) d.prompts++
    } else if (m.type === 'assistant') {
      const model = modelOf(m.model)
      if (model) usage.model = model
      const t = request(m, ts, model)
      if (!t) continue
      usage.contextInputTokens = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
      usage.lastOutputTokens = t.outputTokens
      usage.contextTokens = usage.contextInputTokens + t.outputTokens
      if (pending) {
        pending.postTokens = usage.contextInputTokens
        pending = null
      }
    } else if (m.type === 'compaction' && m.status === 'completed') {
      const before = usage.contextTokens
      const t = request(m, ts, modelOf(m.model) ?? usage.model)
      // Until the next request says, what it left is its summary.
      pending = { timestamp: ts ?? '', trigger: typeof m.reason === 'string' ? m.reason : 'auto', preTokens: before, postTokens: t?.outputTokens ?? 0, ...(usage.contextInputTokens !== undefined ? { lastInputTokens: usage.contextInputTokens, lastOutputTokens: usage.lastOutputTokens ?? 0 } : {}) }
      usage.compactions.push(pending)
      if (t) usage.contextTokens = t.outputTokens
      const d = dayOf(ts)
      if (d) d.compactions++
    }
  }
  const infoTokens = info && hasTokens(info.tokens) ? tokensOf(info.tokens) : null
  const infoCost = info && typeof info.cost === 'number' && Number.isFinite(info.cost) && info.cost >= 0 ? info.cost : null
  const rem = infoTokens ? { inputTokens: infoTokens.inputTokens - sums.inputTokens, outputTokens: infoTokens.outputTokens - sums.outputTokens, cacheReadTokens: infoTokens.cacheReadTokens - sums.cacheReadTokens, cacheWriteTokens: infoTokens.cacheWriteTokens - sums.cacheWriteTokens } : null
  const costRem = infoCost !== null ? infoCost - cost : 0
  const bad = [...(rem ? KINDS.filter((k) => rem[k] < 0) : []), ...(costRem < -1e-9 ? ['cost'] : [])]
  for (const k of KINDS) usage[k] = infoTokens ? infoTokens[k] : sums[k]
  usage.reasoningTokens = infoTokens ? infoTokens.reasoning : sums.reasoning
  usage.costUsd = infoCost ?? (costSeen ? cost : null)
  if (bad.length) {
    // An inconsistent breakdown: info's totals, no days, no timeline, no cost reports.
    inconsistentBreakdowns.push({ sessionId, kinds: bad })
    if (inconsistentBreakdowns.length > 20) inconsistentBreakdowns.shift()
    return usage
  }
  const last = localDay(usage.lastActivity)
  if (rem && last && KINDS.some((k) => rem[k] > 0)) {
    const d = (days[last] ??= emptyDay())
    for (const k of KINDS) d[k] += rem[k]
  }
  if (costRem > 1e-9 && last) {
    days[last] ??= emptyDay()
    dayCost[last] = (dayCost[last] ?? 0) + costRem
  }
  usage.days = days
  if (usage.costUsd !== null) {
    usage.costReports = Object.entries(days).map(([day, d]) => ({ costUsd: dayCost[day] ?? 0, days: { [day]: { inputTokens: d.inputTokens, outputTokens: d.outputTokens, cacheReadTokens: d.cacheReadTokens, cacheWriteTokens: d.cacheWriteTokens } } }))
  }
  usage.timeline = timeline.timeline(usage.costUsd !== null ? reports : [])
  return usage
}

/** A message's model as Combwork names OpenCode's: `<provider>/<model>`. */
function modelOf(m: unknown): string | null {
  if (!isObj(m) || typeof m.id !== 'string' || !m.id) return null
  return typeof m.providerID === 'string' && m.providerID ? `${m.providerID}/${m.id}` : m.id
}

/** Usage for a whole mirror. */
export function parseMirrorUsage(text: string, sessionId: string, title: string | null = null): SessionUsage {
  const p = new OpencodeUsageParser(sessionId)
  p.feed(text)
  return p.result(title)
}

// ---- The conversation

export const HISTORY_TEXT = {
  incomplete: msg({ id: 'providers.transcript.opencodeIncomplete', defaultMessage: "Combwork couldn't read the end of this session from {provider}: {problem}. What's shown is what it had read before.", description: "A notice at the end of an OpenCode session's history (the Sessions tab's transcript viewer): Combwork's newest read of the session from OpenCode failed, so the end may be missing. {provider} is OpenCode; {problem} says why, one of the providers.transcript.opencodeProblem.* messages." }),
  problem: {
    timeout: msg({ id: 'providers.transcript.opencodeProblem.timeout', defaultMessage: 'it took too long', description: "Why Combwork couldn't read an OpenCode session's end ({problem} in providers.transcript.opencodeIncomplete): OpenCode didn't answer in time." }),
    exit: msg({ id: 'providers.transcript.opencodeProblem.exit', defaultMessage: 'OpenCode ended with an error', description: "Why Combwork couldn't read an OpenCode session's end ({problem} in providers.transcript.opencodeIncomplete): the opencode command exited with an error. OpenCode is a product's name." }),
    size: msg({ id: 'providers.transcript.opencodeProblem.size', defaultMessage: 'the session is larger than Combwork reads', description: "Why Combwork couldn't read an OpenCode session's end ({problem} in providers.transcript.opencodeIncomplete): it is over Combwork's size limit." }),
    parse: msg({ id: 'providers.transcript.opencodeProblem.parse', defaultMessage: "what OpenCode gave couldn't be read", description: "Why Combwork couldn't read an OpenCode session's end ({problem} in providers.transcript.opencodeIncomplete): OpenCode's answer wasn't in a shape Combwork knows. OpenCode is a product's name." })
  } satisfies Record<MirrorProblem, ReturnType<typeof msg>>
}

/** The notice for a status line: Combwork's words, translated where shown, with OpenCode's own after them where it gave some. */
export function statusNotice(s: Pick<MirrorStatus, 'problem'>): Text {
  return withValues(HISTORY_TEXT.incomplete, { provider: 'OpenCode', problem: HISTORY_TEXT.problem[s.problem] }) // i18n-ignore: a product name
}

/** The text of a tool's content parts (Tool.Content: `{type: 'text', text}`; others named by their type). */
function contentText(c: unknown): string {
  if (!Array.isArray(c)) return ''
  return c
    .map((p) => (isObj(p) ? (typeof p.text === 'string' ? p.text : typeof p.type === 'string' ? `[${p.type}]` : '') : ''))
    .filter(Boolean)
    .join('\n')
}

const errorText = (e: unknown): string => (isObj(e) && typeof e.message === 'string' ? e.message : '')

/** OpenCode's shell tool, formatted as Claude Code's (formatToolInput shows its command as it is). */
// agent-protocol: a tool's name, not wording
const SHELL_AS = 'Bash' // i18n-ignore: a tool's name

/** A tool part as the viewer shows it: its input, its result once it has one, and its exit where it ran a command. */
export function opencodeTool(part: Obj, root: string | null): TranscriptTool {
  const name = typeof part.name === 'string' && part.name ? part.name : 'tool'
  const state = isObj(part.state) ? part.state : {}
  const input = isObj(state.input) ? state.input : {}
  const summary = typeof input.command === 'string' ? firstLine(input.command) : typeof input.description === 'string' ? firstLine(input.description) : shortPath(input.filePath ?? input.path ?? input.file, root) || firstLine(typeof input.code === 'string' ? input.code : '')
  const done = state.status === 'completed' || state.status === 'error'
  const isError = state.status === 'error'
  const result = done ? (isError ? errorText(state.error) || contentText(state.content) : contentText(state.content)) : null
  const exit = isObj(state.metadata) && typeof state.metadata.exit === 'number' ? state.metadata.exit : undefined
  const id = typeof part.id === 'string' ? part.id : ''
  const calls = codeModeCalls(id, state, result)
  return { toolUseId: id, name, summary, input: formatToolInput(name === 'shell' ? SHELL_AS : name, input), result, isError, images: [], ...(exit !== undefined ? { exitCode: exit } : {}), ...(calls ? { calls, script: true as const } : {}) }
}

/**
 * The tools a Code Mode `execute` called (2.2.6 offers MCP tools to the model only through it: HI-2763's R0), as its
 * metadata records them (`toolCalls`: `{tool: "<server>.<tool>", status, input}`, messages/mcp-through-execute.json),
 * each a tool of its own in the order called, as a Codex script's calls are (HI-2240). 2.2.6 records no result of its
 * own for a call: a script's one call has the script's result, any other none. Null for a tool that records none.
 */
function codeModeCalls(id: string, state: Obj, result: string | null): TranscriptTool[] | null {
  const recorded = isObj(state.metadata) && Array.isArray(state.metadata.toolCalls) ? state.metadata.toolCalls.filter(isObj) : null
  if (!recorded || !recorded.length) return null
  return recorded.map((c, i) => {
    const name = typeof c.tool === 'string' && c.tool ? c.tool : 'tool'
    const input = isObj(c.input) ? c.input : {}
    const ended = c.status === 'completed' || c.status === 'error'
    return { toolUseId: `${id}#${i}`, name, summary: firstLine(formatToolInput(name, input)), input: formatToolInput(name, input), result: ended && recorded.length === 1 ? result : null, isError: c.status === 'error', images: [] }
  })
}

/** A message's items, in order. */
export function messageItems(m: Obj, root: string | null): NewItem[] {
  const ts = iso(m?.time?.created)
  const out: NewItem[] = []
  if (m.type === 'user' && typeof m.text === 'string') out.push({ kind: 'user', timestamp: ts, text: m.text, images: [] })
  else if (m.type === 'assistant') {
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (!isObj(p)) continue
      if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) out.push({ kind: 'thinking', timestamp: ts, text: p.text })
      else if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) out.push({ kind: 'assistant', timestamp: ts, text: p.text })
      else if (p.type === 'tool') out.push({ kind: 'tool', timestamp: ts, tool: opencodeTool(p, root) })
    }
    // A request that failed says why (its error, OpenCode's words); an interrupt is the idle marker's to say.
    const why = errorText(m.error)
    if (m.finish === 'error' && why && m.error?.type !== 'aborted') out.push({ kind: 'notice', timestamp: ts, text: why, level: 'error' })
  } else if (m.type === 'idle') {
    if (m.outcome === 'interrupted') out.push({ ...noticeOf(NOTICE_TEXT.interrupted, 'info'), timestamp: ts })
    else if (m.outcome === 'failed') out.push(errorText(m.error) ? { kind: 'notice', timestamp: ts, text: errorText(m.error), level: 'error' } : { ...noticeOf(NOTICE_TEXT.apiError, 'error'), timestamp: ts })
  } else if (m.type === 'compaction') {
    if (m.status === 'completed') out.push({ kind: 'compaction', timestamp: ts, trigger: typeof m.reason === 'string' ? m.reason : 'auto', preTokens: 0, postTokens: hasTokens(m.tokens) ? tokensOf(m.tokens).outputTokens : 0, nextRequestTokens: null, summary: typeof m.summary === 'string' && m.summary.trim() ? m.summary : null })
    else if (m.status === 'failed') out.push(errorText(m.error) ? { kind: 'notice', timestamp: ts, text: errorText(m.error), level: 'error' } : { ...noticeOf(NOTICE_TEXT.aborted, 'error'), timestamp: ts })
  }
  return out
}

/**
 * The conversation in a mirror, for the transcript viewer: read whole again whenever the mirror changes (`rewritten`),
 * as it is rewritten whole. A compaction's context before it is the last request's; its status line, last, a notice.
 */
export class OpencodeConversationParser implements ConversationParserLike {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  readonly rewritten = true
  offset = 0
  private context = 0

  constructor(private readonly root: string | null) {}

  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      this.line(buf.toString('utf8', start, nl))
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  private line(text: string): void {
    if (!text.trim()) return
    let o: unknown
    try {
      o = JSON.parse(text)
    } catch {
      return
    }
    if (!isObj(o)) return
    if (o.type === STATUS_LINE && MIRROR_PROBLEMS.includes(o.problem)) {
      const detail = typeof o.detail === 'string' && o.detail.trim() ? o.detail.trim() : ''
      this.push({ ...noticeOf(statusNotice(o as MirrorStatus), 'error'), timestamp: typeof o.at === 'string' ? o.at : null })
      if (detail) this.push({ kind: 'notice', timestamp: typeof o.at === 'string' ? o.at : null, text: detail, level: 'error' })
      return
    }
    if (o.type !== MESSAGE_LINE || !isObj(o.message)) return
    const m = o.message
    for (const item of messageItems(m, this.root)) {
      if (item.kind === 'compaction') item.preTokens = this.context
      this.push(item)
    }
    if (m.type === 'assistant' && hasTokens(m.tokens)) {
      const t = tokensOf(m.tokens)
      this.context = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens || this.context
    }
  }
}

// ---- Plan limits

/** What a usage/limits answer says (HI-2762 design s13 §4). */
export type LimitsReading = { kind: 'none' } | { kind: 'report'; usage: PlanUsage } | { kind: 'unsupported' }

const percentOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null)

/**
 * `GET /api/experimental/usage/limits` (2.2.6: `{location, data}`, wire/usage-limits-signed-out.json for `data: null`)
 * as Combwork's plan limits, failing closed. `data: null` (no OpenCode Console sign-in): none. Otherwise its
 * UsageLimits.Info, from 2.2.6's openapi.json and never observed with a sign-in (no account was used): OpenCode Go's
 * `rolling`, `weekly` and `monthly` meters (`percent` 0..100, `limited`, `resetsAt` epoch ms) and the workspace's
 * budgets (`limit` and `spent` in USD, `resetsAt`). A meter or budget with a missing, negative or non-finite field is left
 * out alone; a budget of 0 is one the plan doesn't include; a shape that isn't Info, or one with nothing valid, is
 * unsupported. Each names what it covers (OpenCode Go, or the budget's models): never another provider's own limits.
 */
export function opencodePlanUsage(body: unknown, at: string): LimitsReading {
  if (!isObj(body) || !('data' in body)) return { kind: 'unsupported' }
  const data = body.data
  if (data === null) return { kind: 'none' }
  if (!isObj(data) || !isObj(data.workspace) || !Array.isArray(data.budgets)) return { kind: 'unsupported' }
  const limits: PlanLimit[] = []
  const go = isObj(data.go) ? data.go : null
  const WINDOWS: Record<string, number | null> = { rolling: null, weekly: 7 * 24 * 60, monthly: null }
  for (const key of Object.keys(WINDOWS)) {
    const m = go?.[key]
    if (!isObj(m)) continue
    const p = percentOf(m.percent)
    const resetsAt = isoTime(m.resetsAt)
    if (p === null || typeof m.limited !== 'boolean' || !resetsAt) continue
    limits.push({ id: `go.${key}`, label: `OpenCode Go ${key}`, windowMinutes: WINDOWS[key], usedPercent: m.limited ? Math.max(100, p) : p, resetsAt, models: `OpenCode Go (${key})` }) // i18n-ignore: OpenCode's own names for its meters
  }
  for (const b of data.budgets) {
    if (!isObj(b) || typeof b.id !== 'string' || !b.id) continue
    const limit = b.limit
    const spent = b.spent
    const resetsAt = isoTime(b.resetsAt)
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0 || typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0 || !resetsAt) continue
    const names = Array.isArray(b.models) ? b.models.filter(isObj).map((x) => (typeof x.name === 'string' && x.name) || (typeof x.modelID === 'string' && x.modelID) || '').filter(Boolean) : []
    const vendors = Array.isArray(b.vendors) ? b.vendors.filter((v: unknown): v is string => typeof v === 'string' && !!v) : []
    const covers = b.coverage === 'all' ? 'all models' : names.length ? names.join(', ') : vendors.length ? vendors.join(', ') : 'some models' // i18n-ignore: the budget's own models, in OpenCode's names
    const base = { id: `budget.${b.id}`, label: `OpenCode Console budget (${covers})`, windowMinutes: null, resetsAt, models: `Console budget: ${covers}` } // i18n-ignore: OpenCode's own names
    if (limit === 0) limits.push({ ...base, usedPercent: 0, notIncluded: true })
    else limits.push({ ...base, usedPercent: Math.round((spent / limit) * 1000) / 10 })
  }
  if (!limits.length) return { kind: 'unsupported' }
  const plan = typeof data.workspace.name === 'string' && data.workspace.name ? data.workspace.name : null
  return { kind: 'report', usage: { provider: OPENCODE, plan, limits, updatedAt: at } }
}
