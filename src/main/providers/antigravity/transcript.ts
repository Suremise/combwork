import type { DayUsage, SessionUsage, TranscriptItem, TranscriptTool, UsageTokens } from '../../../shared/types'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import { ANTIGRAVITY } from '../../../shared/antigravity'
import { formatToolInput } from '../claude/conversation'
import { firstLine, shortPath, type NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation } from '../types'
import { advancedValues as advanced } from '../../advancedValues'

/**
 * The Antigravity CLI's transcript of a conversation (HI-2546, read from 1.5.0's): brain\<conversation id>\.system_generated\
 * logs\transcript_full.jsonl in the agent's profile (what its hooks name), one step per line: {step_index, source, type,
 * status, created_at, …}. Types seen: USER_INPUT (source USER_EXPLICIT: the user's prompt, wrapped in what agy adds),
 * PLANNER_RESPONSE (the model's request: its text in `content`, its `tool_calls` [{name, args}] and its tokens) and
 * GENERIC (a tool call's result or error, one step per call, in the order the request made them). transcript.jsonl beside
 * it is the same with each argument JSON-encoded again. The format isn't documented as stable, so anything unrecognised
 * is left out, and a line that goes back to a step already read (agy writing the file again from the start, as a rewind
 * may) is left out too: the reader reads a file that shrank again from its start.
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

/** A user's prompt: USER_INPUT from the user (not one agy made itself, a continuation's). */
export const isUserPrompt = (s: AgyStep): boolean => s.type === 'USER_INPUT' && s.source === 'USER_EXPLICIT'

/** A model request: PLANNER_RESPONSE. */
export const isModelRequest = (s: AgyStep): boolean => s.type === 'PLANNER_RESPONSE'

/** transcript.jsonl encodes each argument as JSON again ("\"probe-A\""): decoded, as transcript_full.jsonl has them. */
export function plainArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && /^\s*["{[]/.test(v)) {
      try {
        out[k] = JSON.parse(v)
        continue
      } catch {
        // as it is
      }
    }
    out[k] = v
  }
  return out
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The arguments that say what a call is about, by agy's argument names, first found first. */
const SUMMARY_KEYS = ['CommandLine', 'Command', 'AbsolutePath', 'TargetFile', 'FilePath', 'Path', 'DirectoryPath', 'SearchPath', 'Url', 'Query', 'Pattern', 'Prompt', 'Task'] // i18n-ignore: agy's argument names
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
  return { name, summary: summary.slice(0, 200), input: formatToolInput(name, args) }
}

/** agy's transcript parser: the user's prompts, the model's text and its tool calls with their results. */
export class AntigravityConversationParser implements ConversationParserLike {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  offset = 0
  private root: string | null
  /** The calls of the last request still waiting for their result steps, in order. */
  private waiting: TranscriptTool[] = []
  /** The last step read: a line for one before it is agy writing the file again (left out). */
  private last = -1

  constructor(projectPath: string | null = null) {
    this.root = projectPath
  }

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
    const s = parseStep(text)
    if (!s) return
    if (typeof s.step_index === 'number') {
      if (s.step_index <= this.last) return
      this.last = s.step_index
    }
    const ts = typeof s.created_at === 'string' ? s.created_at : null
    if (s.type === 'USER_INPUT') {
      this.waiting = []
      const said = userRequestText(s.content)
      if (isUserPrompt(s) && said) this.push({ kind: 'user', timestamp: ts, text: said, images: [] })
      return
    }
    if (isModelRequest(s)) {
      this.waiting = []
      if (typeof s.thinking === 'string' && s.thinking.trim()) this.push({ kind: 'thinking', timestamp: ts, text: s.thinking })
      if (typeof s.content === 'string' && s.content.trim()) this.push({ kind: 'assistant', timestamp: ts, text: s.content })
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : []
      calls.forEach((c, i) => {
        if (!c || typeof c !== 'object') return
        const args = plainArgs(c.args)
        const shown = agyTool(String(c.name ?? 'tool'), args, this.root)
        // The call's id: the step its result will be (agy's hooks name a call by it, stepIdx), as far as known now.
        const tool: TranscriptTool = { toolUseId: `${(s.step_index ?? 0) + 1 + i}`, ...shown, result: null, isError: false, images: [] }
        this.waiting.push(tool)
        this.push({ kind: 'tool', timestamp: ts, tool })
      })
      return
    }
    // Any other step: the next waiting call's result, else agy's own note (an error shown as one).
    const tool = this.waiting.shift()
    const failed = s.status === 'ERROR'
    const error = typeof s.error === 'string' ? s.error.trim() : ''
    if (tool) {
      if (typeof s.step_index === 'number') tool.toolUseId = `${s.step_index}`
      tool.isError = failed
      tool.result = failed && error ? error : stepOutput(s.content)
      return
    }
    if (failed && (error || stepOutput(s.content))) this.push({ kind: 'notice', timestamp: ts, text: error || stepOutput(s.content), level: 'error' })
  }
}

/**
 * Usage from agy's transcript: each PLANNER_RESPONSE is a request, with its input (the whole prompt, the cache read
 * included unless antigravity.usage.inputIncludesCache is off), cache read and output tokens. agy publishes no per-token
 * prices (prices.ts), so it has no cost.
 */
export class AntigravityUsageParser {
  private usage: SessionUsage
  private days: Record<string, DayUsage> = {}
  private timeline = new TimelineBuilder()
  private last = -1

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

  feed(text: string): void {
    const usage = this.usage
    const inclusive = advanced.get<boolean>('antigravity.usage.inputIncludesCache') !== false
    for (const line of text.split('\n')) {
      const s = parseStep(line)
      if (!s) continue
      if (typeof s.step_index === 'number') {
        if (s.step_index <= this.last) continue
        this.last = s.step_index
      }
      const ts = typeof s.created_at === 'string' ? s.created_at : undefined
      if (ts) {
        if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
        if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
      }
      if (s.type === 'USER_INPUT') {
        const picked = modelChange(s.content)
        if (picked) usage.model = picked
        if (!isUserPrompt(s)) continue
        usage.userMessages++
        const d = this.day(ts)
        if (d) d.prompts++
        const said = userRequestText(s.content)
        if (said) usage.lastPrompt = said
      } else if (isModelRequest(s)) {
        const input = num(s.input_tokens)
        const cache = num(s.cache_read_tokens)
        const output = num(s.output_tokens)
        if (input + cache + output === 0) continue
        const fresh = inclusive ? Math.max(0, input - cache) : input
        const step: Partial<UsageTokens> = { inputTokens: fresh, cacheReadTokens: cache, outputTokens: output }
        usage.inputTokens += fresh
        usage.cacheReadTokens += cache
        usage.outputTokens += output
        usage.requests++
        usage.contextInputTokens = fresh + cache
        usage.lastOutputTokens = output
        usage.contextTokens = fresh + cache + output
        const d = this.day(ts)
        if (d) {
          d.inputTokens += fresh
          d.cacheReadTokens += cache
          d.outputTokens += output
          d.requests++
        }
        this.timeline.add(ts || usage.lastActivity, step, 1, -1, 0, usage.model)
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
