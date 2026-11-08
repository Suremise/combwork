import type { CompactionEvent, DayUsage, SessionUsage, TranscriptImageRef, TranscriptItem, TranscriptTool, UsageTokens } from '../../../shared/types'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import { ANTIGRAVITY } from '../../../shared/antigravity'
import { formatToolInput } from '../claude/conversation'
import { firstLine, shortPath, type NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation } from '../types'
import { advancedValues as advanced } from '../../advancedValues'

/**
 * The Antigravity CLI's transcript of a conversation (HI-2546, read from 1.5.0's: tests/fixtures/antigravity): brain\
 * <conversation id>\.system_generated\logs\transcript_full.jsonl in the agent's profile (what its hooks name), one step a
 * line: {step_index, source, type, status, created_at, …}. Types seen:
 * - USER_INPUT (source USER_EXPLICIT): the user's prompt inside what agy adds (a slash command, `/compact`, among them);
 * - PLANNER_RESPONSE: a model request, its text in `content`, its `tool_calls` [{name, args}] and its tokens;
 * - the result of each of those calls, one step each, in order (GENERIC; an image a tool read in its `media`, a file
 *   under logs\media);
 * - SYSTEM_MESSAGE (source SYSTEM): a message from agy ("sender=system") or another conversation (a subagent's answer,
 *   or, as a subagent's first step, its parent's task);
 * - CHECKPOINT (source SYSTEM): a compaction, its summary in `content`, its own request's tokens.
 * transcript.jsonl beside it, each argument JSON-encoded again, isn't read: only this one has them as agy gave them. A
 * subagent is a conversation of its own. The format isn't documented as stable: anything unrecognised is left out (an
 * unknown step never takes a call's result), as is a line whose step index isn't a whole number or was read already. agy
 * may write the file again in place, so its readers read it again from the start when what they read changed
 * (`rewritten`: transcripts.ts, usageParsers' rereadsWhole).
 */

export type AgyStep = {
  step_index?: number
  source?: string
  type?: string
  status?: string
  created_at?: string
  content?: string
  error?: string
  input_tokens?: number
  cache_read_tokens?: number
  output_tokens?: number
  thinking?: string
  tool_calls?: { name?: string; args?: Record<string, unknown> }[]
  media?: { mime_type?: string; uri?: string }[]
}

export function parseStep(line: string): AgyStep | null {
  if (!line.trim()) return null
  try {
    const r = JSON.parse(line)
    return r && typeof r === 'object' && !Array.isArray(r) ? (r as AgyStep) : null
  } catch {
    return null
  }
}

const pattern = (id: string): RegExp | null => {
  try {
    return advanced.pattern(id)
  } catch {
    return null
  }
}

/** The user's own words in a USER_INPUT step's content (antigravity.transcript.userRequest), else the content as it is. */
export function userRequestText(content: unknown): string {
  if (typeof content !== 'string') return ''
  const m = pattern('antigravity.transcript.userRequest')?.exec(content)
  return (m?.[1] ?? content).trim()
}

/** A tool's output in its result step, without the times agy puts first (antigravity.transcript.stepHeader). */
export function stepOutput(content: unknown): string {
  if (typeof content !== 'string') return ''
  const re = pattern('antigravity.transcript.stepHeader')
  return (re ? content.replace(re, '') : content).trim()
}

/** The model a USER_INPUT step says the user picked (antigravity.transcript.modelChange): its display name. */
export function modelChange(content: unknown): string | null {
  if (typeof content !== 'string') return null
  return pattern('antigravity.transcript.modelChange')?.exec(content)?.[1]?.trim() || null
}

/** A SYSTEM_MESSAGE's sender ("system", or another conversation's id) and what it says (antigravity.transcript.systemMessage). */
export function systemMessage(content: unknown): { sender: string; text: string } | null {
  if (typeof content !== 'string') return null
  const m = pattern('antigravity.transcript.systemMessage')?.exec(content)
  return m ? { sender: m[1], text: m[2].trim() } : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A subagent's parent, from its transcript's first step: a SYSTEM_MESSAGE whose sender is a conversation. */
export function parentOf(first: string): string | null {
  const s = parseStep(first)
  if (!s || s.type !== 'SYSTEM_MESSAGE' || stepIndex(s) !== 0) return null
  const m = systemMessage(s.content)
  return m && UUID.test(m.sender) ? m.sender : null
}

/** A prompt that is a slash command (`/compact`): its name and arguments, or null. */
export function slashCommand(text: string): { name: string; args: string } | null {
  const m = /^(\/[A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null
}

/** A user's prompt: USER_INPUT from the user (not one agy made itself). */
export const isUserPrompt = (s: AgyStep): boolean => s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT'

/** A model request: PLANNER_RESPONSE. */
export const isModelRequest = (s: AgyStep): boolean => s.type === 'PLANNER_RESPONSE'

/** A compaction: CHECKPOINT. */
export const isCompaction = (s: AgyStep): boolean => s.type === 'CHECKPOINT'

/** A step's index: a whole number from 0, else null (the line isn't read). */
export const stepIndex = (s: AgyStep): number | null => (Number.isSafeInteger(s.step_index) && (s.step_index as number) >= 0 ? (s.step_index as number) : null)

const optString = (v: unknown): boolean => v === undefined || typeof v === 'string'
const tokensOk = (s: AgyStep): boolean => [s.input_tokens, s.cache_read_tokens, s.output_tokens].every((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)))

/**
 * Whether a step is one this parser reads, in the shape agy 1.5.0 wrote it (HI-2546's fixtures): an unknown type, or a
 * known one in another shape, is left out whole: it takes no call's result and leaves its index unread, so a valid step
 * there later is still read.
 */
export function knownStep(s: AgyStep): boolean {
  switch (s.type) {
    case 'USER_INPUT':
    case 'SYSTEM_MESSAGE':
      return typeof s.content === 'string'
    case 'PLANNER_RESPONSE':
      return optString(s.content) && optString(s.thinking) && (s.tool_calls === undefined || Array.isArray(s.tool_calls)) && tokensOk(s)
    case 'CHECKPOINT':
      return optString(s.content) && tokensOk(s)
    case 'GENERIC':
      // A tool's result: done or failed, with its output, its error or its images.
      return (s.status === 'DONE' || s.status === 'ERROR') && optString(s.content) && optString(s.error) && (s.media === undefined || Array.isArray(s.media)) && (typeof s.content === 'string' || typeof s.error === 'string' || Array.isArray(s.media))
    default:
      return false
  }
}

/** A tool call's result: GENERIC in its shape (knownStep), the only result step agy 1.5.0 wrote. */
export const isToolResult = (s: AgyStep): boolean => s.type === 'GENERIC' && knownStep(s)

/** A call's arguments as transcript_full.jsonl has them (an object), else none. */
const argsOf = (args: unknown): Record<string, unknown> => (args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The arguments that say what a call is about, by agy's argument names (1.5.0: read_file and edit_file's Path, run_command's
 * CommandLine and its own toolSummary, invoke_subagent's Prompt), first found first.
 */
const SUMMARY_KEYS = ['toolSummary', 'CommandLine', 'Command', 'AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'DirectoryPath', 'SearchPath', 'Url', 'Query', 'Pattern', 'Prompt', 'Message', 'Task'] // i18n-ignore: agy's argument names
const PATH_KEYS = new Set(['AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'DirectoryPath', 'SearchPath']) // i18n-ignore: agy's argument names

/** A tool call as the viewer shows it: an MCP server's tool as "<server> · <tool>" (as Copilot's are), else agy's name. */
export function agyTool(name: string, args: Record<string, unknown>, root: string | null): { name: string; summary: string; input: string } {
  if (name === 'call_mcp_tool' && typeof args.ServerName === 'string' && typeof args.ToolName === 'string') {
    const a = args.Arguments && typeof args.Arguments === 'object' ? (args.Arguments as Record<string, unknown>) : {}
    const shown = `${args.ServerName} · ${args.ToolName}`
    return { name: shown, summary: firstLine(Object.values(a).find((v) => typeof v === 'string' && v.trim())).slice(0, 200), input: formatToolInput(shown, a) }
  }
  const key = SUMMARY_KEYS.find((k) => typeof args[k] === 'string' && (args[k] as string).trim())
  const summary = key ? (PATH_KEYS.has(key) ? shortPath(args[key], root) : firstLine(args[key])) : firstLine(Object.values(args).find((v) => typeof v === 'string' && v.trim()))
  const { toolSummary: _summary, ...input } = args
  return { name, summary: summary.slice(0, 200), input: formatToolInput(name, input) }
}

/** agy's transcript parser: the user's prompts, the model's text and its tool calls with their results and images. */
export class AntigravityConversationParser implements ConversationParserLike {
  /** agy may write a transcript again in place: the viewer checks what was read is unchanged (transcripts.ts). */
  readonly rewritten = true
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  offset = 0
  private root: string | null
  /** The calls of the last request still waiting for their result steps, in order. */
  private waiting: TranscriptTool[] = []
  /** The steps read: a line for one again is left out. */
  private seen = new Set<number>()
  /** The context before a compaction (the last request's input and output), and whether a /compact asked for it. */
  private context = 0
  private compactAsked = false

  constructor(projectPath: string | null = null) {
    this.root = projectPath
  }

  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      this.line(buf.toString('utf8', start, nl), this.offset + start, nl - start)
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  /** The images a step names (its `media`): each read from the file it names when shown (imageData). */
  private media(s: AgyStep, offset: number, length: number): TranscriptImageRef[] {
    const out: TranscriptImageRef[] = []
    ;(Array.isArray(s.media) ? s.media : []).forEach((m, i) => {
      if (!m || typeof m.uri !== 'string' || !String(m.mime_type ?? '').startsWith('image/')) return
      this.images.push({ offset, length, path: ['media', i] })
      out.push({ id: this.images.length - 1, path: null })
    })
    return out
  }

  private line(text: string, offset: number, length: number): void {
    const s = parseStep(text)
    const index = s ? stepIndex(s) : null
    if (!s || index === null || !knownStep(s) || this.seen.has(index)) return
    this.seen.add(index)
    const ts = typeof s.created_at === 'string' ? s.created_at : null
    if (s.type === 'USER_INPUT') {
      this.waiting = []
      const said = userRequestText(s.content)
      if (!isUserPrompt(s) || !said) return
      const cmd = slashCommand(said)
      if (cmd) {
        this.compactAsked = cmd.name === '/compact'
        this.push({ kind: 'command', timestamp: ts, name: cmd.name, args: cmd.args, output: '' })
      } else this.push({ kind: 'user', timestamp: ts, text: said, images: [] })
      return
    }
    if (isModelRequest(s)) {
      this.waiting = []
      this.context = num(s.input_tokens) + num(s.cache_read_tokens) + num(s.output_tokens) || this.context
      if (typeof s.thinking === 'string' && s.thinking.trim()) this.push({ kind: 'thinking', timestamp: ts, text: s.thinking })
      if (typeof s.content === 'string' && s.content.trim()) this.push({ kind: 'assistant', timestamp: ts, text: s.content })
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : []
      calls.forEach((c, i) => {
        if (!c || typeof c !== 'object') return
        const shown = agyTool(String(c.name ?? 'tool'), argsOf(c.args), this.root)
        // The call's id: the step its result will be (agy's hooks name a call by it, stepIdx), as far as known now.
        const tool: TranscriptTool = { toolUseId: `${index + 1 + i}`, ...shown, result: null, isError: false, images: [] }
        this.waiting.push(tool)
        this.push({ kind: 'tool', timestamp: ts, tool })
      })
      return
    }
    if (s.type === 'SYSTEM_MESSAGE') {
      const m = systemMessage(s.content)
      if (!m || !m.text) return
      // A subagent's first step is its parent's task: its prompt. Another conversation's message later is a subagent's answer.
      if (index === 0 && UUID.test(m.sender)) this.push({ kind: 'user', timestamp: ts, text: m.text, images: [] })
      else this.push({ kind: 'notice', timestamp: ts, text: m.text, level: 'info', ...(UUID.test(m.sender) ? { from: 'task' as const } : {}) })
      return
    }
    if (isCompaction(s)) {
      this.waiting = []
      const summary = typeof s.content === 'string' && s.content.trim() ? s.content : null
      this.push({ kind: 'compaction', timestamp: ts, trigger: this.compactAsked ? 'manual' : 'auto', preTokens: this.context, postTokens: num(s.output_tokens), nextRequestTokens: null, summary })
      this.compactAsked = false
      return
    }
    // Only a result step: the next waiting call's result, else agy's own note (an error shown as one). Any other is left out.
    if (!isToolResult(s)) return
    const tool = this.waiting.shift()
    const failed = s.status === 'ERROR'
    const error = typeof s.error === 'string' ? s.error.trim() : ''
    if (tool) {
      tool.toolUseId = `${index}`
      tool.isError = failed
      tool.result = failed && error ? error : stepOutput(s.content)
      tool.images = this.media(s, offset, length)
      return
    }
    if (failed && (error || stepOutput(s.content))) this.push({ kind: 'notice', timestamp: ts, text: error || stepOutput(s.content), level: 'error' })
  }
}

/**
 * Usage from agy's transcript: each PLANNER_RESPONSE is a request, and each CHECKPOINT (a compaction's summary), with its
 * input (without its cache read, unless antigravity.usage.inputIncludesCache is on), cache read and output tokens. agy
 * publishes no per-token prices (prices.ts), so it has no cost. A subagent's requests are in its own conversation.
 */
export class AntigravityUsageParser {
  /** agy may write a transcript again in place: read whole whenever it changes (usageParsers' rereadsWhole). */
  static readonly rewritten = true
  private usage: SessionUsage
  private days: Record<string, DayUsage> = {}
  private timeline = new TimelineBuilder()
  /** The steps read: a line for one again is left out. */
  private seen = new Set<number>()
  private compactAsked = false
  /** The compaction whose context after it the next request gives. */
  private pending: CompactionEvent | null = null

  constructor(sessionId: string) {
    this.usage = {
      provider: ANTIGRAVITY,
      sessionId,
      title: null,
      model: null,
      cliVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
      reasoningTokens: 0,
      contextTokens: 0,
      contextWindow: null,
      compactions: [],
      cacheTtlSeconds: 0,
      firstActivity: null,
      lastActivity: null,
      userMessages: 0,
      lastPrompt: null,
      costUsd: null,
      costEstimated: false
    }
  }

  private day(ts: string | undefined): DayUsage | null {
    const d = localDay(ts) || localDay(this.usage.lastActivity)
    return d ? (this.days[d] ??= emptyDay()) : null
  }

  /** A request's tokens counted: the session's, its day's and the timeline's. Its fresh input, cache read and output. */
  private request(s: AgyStep, ts: string | undefined, inclusive: boolean): { fresh: number; cache: number; output: number } | null {
    const input = num(s.input_tokens)
    const cache = num(s.cache_read_tokens)
    const output = num(s.output_tokens)
    if (input + cache + output === 0) return null
    const fresh = inclusive ? Math.max(0, input - cache) : input
    const usage = this.usage
    usage.inputTokens += fresh
    usage.cacheReadTokens += cache
    usage.outputTokens += output
    usage.requests++
    const d = this.day(ts)
    if (d) {
      d.inputTokens += fresh
      d.cacheReadTokens += cache
      d.outputTokens += output
      d.requests++
    }
    const step: Partial<UsageTokens> = { inputTokens: fresh, cacheReadTokens: cache, outputTokens: output }
    this.timeline.add(ts || usage.lastActivity, step, 1, -1, 0, usage.model)
    return { fresh, cache, output }
  }

  feed(text: string): void {
    const usage = this.usage
    const inclusive = advanced.get<boolean>('antigravity.usage.inputIncludesCache') === true
    for (const line of text.split('\n')) {
      const s = parseStep(line)
      const index = s ? stepIndex(s) : null
      if (!s || index === null || !knownStep(s) || this.seen.has(index)) continue
      this.seen.add(index)
      const ts = typeof s.created_at === 'string' ? s.created_at : undefined
      if (ts) {
        if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
        if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
      }
      if (s.type === 'USER_INPUT') {
        const picked = modelChange(s.content)
        if (picked) usage.model = picked
        if (!isUserPrompt(s)) continue
        const said = userRequestText(s.content)
        const cmd = said ? slashCommand(said) : null
        // A slash command isn't a prompt (/compact asks for a compaction).
        if (cmd) {
          this.compactAsked = cmd.name === '/compact'
          continue
        }
        usage.userMessages++
        const d = this.day(ts)
        if (d) d.prompts++
        if (said) usage.lastPrompt = said
      } else if (isModelRequest(s)) {
        const r = this.request(s, ts, inclusive)
        if (!r) continue
        usage.contextInputTokens = r.fresh + r.cache
        usage.lastOutputTokens = r.output
        usage.contextTokens = r.fresh + r.cache + r.output
        if (this.pending) {
          this.pending.postTokens = usage.contextInputTokens
          this.pending = null
        }
      } else if (isCompaction(s)) {
        const before = usage.contextTokens
        const r = this.request(s, ts, inclusive)
        // Until the next request says, what it left is its summary.
        this.pending = { timestamp: ts ?? '', trigger: this.compactAsked ? 'manual' : 'auto', preTokens: before, postTokens: r?.output ?? 0, ...(usage.contextInputTokens !== undefined ? { lastInputTokens: usage.contextInputTokens, lastOutputTokens: usage.lastOutputTokens ?? 0 } : {}) }
        usage.compactions.push(this.pending)
        if (r) usage.contextTokens = r.output
        this.compactAsked = false
        const d = this.day(ts)
        if (d) d.compactions++
      }
    }
  }

  /** The usage so far: a new object each time. */
  result(title: string | null = null): SessionUsage {
    const days: Record<string, DayUsage> = {}
    for (const [k, d] of Object.entries(this.days)) days[k] = { ...d }
    return { ...this.usage, title, compactions: this.usage.compactions.map((c) => ({ ...c })), days, timeline: this.timeline.timeline() }
  }
}

/** Usage for a whole transcript. */
export function parseAgyTranscript(text: string, sessionId: string, title: string | null = null): SessionUsage {
  const p = new AntigravityUsageParser(sessionId)
  p.feed(text)
  return p.result(title)
}

/** A conversation's title in agy's annotations\<id>.pbtxt (`title:"…"`, protobuf text), or null. */
export function annotationTitle(text: string): string | null {
  const m = /^\s*title\s*:\s*"((?:[^"\\]|\\.)*)"/m.exec(text)
  if (!m) return null
  const t = m[1].replace(/\\(["\\'])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim()
  return t || null
}
