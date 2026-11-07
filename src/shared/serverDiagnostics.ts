/**
 * A local server's diagnostics (HI-2683, design s7 and s11, OK'd by HR3): what its replies say about a model's context and
 * tool support, and the judgement of a small structured tool-call test. Pure functions over replies already read
 * (main/serverDiagnostics.ts reads them); codes only, never the server's own text: the window says each in its words.
 *
 * Everything here is evidence, not a guess: a field a server doesn't send is "not reported", never 0; a failure is named
 * only from what was seen, else it is `unexpected`, with what was seen (a status, a stop reason, the kinds of blocks).
 */

/** What a server is, by how it answers (never by its name): llama.cpp's `/props`, Ollama's `/api/ps`, else generic. */
export type ServerKind = 'llamacpp' | 'ollama' | 'generic'

/** Where a context value came from. */
export type ContextSource = 'ollama.ps' | 'ollama.show' | 'ollama.numCtx' | 'llamacpp.props' | 'llamacpp.models'

export interface ContextValue {
  tokens: number
  source: ContextSource
  /** When it was read (ms since the epoch). */
  readAt: number
}

/**
 * A model's context as its server reports it: the most it was trained for, what is configured for it, and what is
 * allocated now. Each optional (a server reports what it does); `loaded`: whether Ollama has it loaded (it allocates on
 * first use), absent where that isn't known.
 */
export interface ServerContext {
  kind: ServerKind
  trained?: ContextValue
  configured?: ContextValue
  allocated?: ContextValue
  loaded?: boolean
  /** llama.cpp's chat template's tool support, from `/props` (never from `chat_format`). */
  templateTools?: TemplateTools
  /** Read from the server's root, which a base URL with a path (a gateway) doesn't reach: nothing was asked. */
  prefixed?: true
}

/**
 * What llama.cpp's chat template says of tools (`chat_template_caps`): both flags true, both false (or one false and
 * the other missing), not there, or the two disagreeing. A capability, not a flag: whether llama-server was started with
 * `--jinja` isn't observable, so that is only ever offered as a possible remedy.
 */
export type TemplateTools = 'supported' | 'unsupported' | 'notReported' | 'inconsistent'

/** The most a context can sensibly be: larger numbers are taken as not reported. */
export const CONTEXT_MAX = 16 * 1024 * 1024

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
/** A context size, if `v` is one (a positive whole number within CONTEXT_MAX). */
export const tokensOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= CONTEXT_MAX ? v : null)

/** llama.cpp's `/props` reply: its allocated context and its template's tool support; null when it isn't one. */
export function llamaProps(reply: unknown): { nCtx: number | null; templateTools: TemplateTools } | null {
  const r = obj(reply)
  const gen = obj(r?.default_generation_settings)
  if (!r || !gen) return null
  const caps = obj(r.chat_template_caps)
  const flags = [caps?.supports_tools, caps?.supports_tool_calls].filter((x): x is boolean => typeof x === 'boolean')
  const templateTools: TemplateTools = !flags.length ? 'notReported' : flags.every(Boolean) ? 'supported' : flags.every((x) => !x) ? 'unsupported' : 'inconsistent'
  // n_ctx is in default_generation_settings (b11608), or its params in some builds.
  return { nCtx: tokensOf(gen.n_ctx) ?? tokensOf(obj(gen.params)?.n_ctx), templateTools }
}

/** llama.cpp's `/v1/models` reply: the trained context of `model` (`meta.n_ctx_train`), where it says. */
export function llamaTrained(reply: unknown, model: string): number | null {
  const data = obj(reply)?.data
  if (!Array.isArray(data)) return null
  const entry = data.map(obj).find((m) => m?.id === model) ?? (data.length === 1 ? obj(data[0]) : null)
  return tokensOf(obj(entry?.meta)?.n_ctx_train)
}

/** Ollama's `/api/ps` reply: whether `model` is loaded and its allocated context; null when it isn't that shape. */
export function ollamaPs(reply: unknown, model: string): { loaded: boolean; contextLength: number | null } | null {
  const models = obj(reply)?.models
  if (!Array.isArray(models)) return null
  const want = model.toLowerCase()
  const m = models.map(obj).find((x) => typeof x?.name === 'string' && (x.name.toLowerCase() === want || (typeof x.model === 'string' && x.model.toLowerCase() === want)))
  return m ? { loaded: true, contextLength: tokensOf(m.context_length) } : { loaded: false, contextLength: null }
}

/**
 * Ollama's `/api/show` reply: the trained context (`model_info["<arch>.context_length"]`) and a Modelfile's `num_ctx`
 * (its `parameters` text), each where it says; null when it isn't that shape.
 */
export function ollamaShow(reply: unknown): { trained: number | null; numCtx: number | null } | null {
  const r = obj(reply)
  if (!r || (!obj(r.model_info) && typeof r.parameters !== 'string' && !obj(r.details))) return null
  const info = obj(r.model_info) ?? {}
  const arch = typeof info['general.architecture'] === 'string' ? (info['general.architecture'] as string) : null
  const trained = (arch ? tokensOf(info[`${arch}.context_length`]) : null) ?? tokensOf(Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1])
  const line = typeof r.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(r.parameters) : null
  return { trained, numCtx: line ? tokensOf(Number(line[1])) : null }
}

// ---------------------------------------------------------------------------
// The tool-call test: one tool, a request that needs it, then its result, which the answer must use.
// ---------------------------------------------------------------------------

export const TEST_TOOL = 'get_weather'
export const TEST_CITY = 'Reykjavik'
/** The test's tool, as the Anthropic Messages API takes it. */
const TOOL = {
  name: TEST_TOOL,
  description: 'Get the current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string', description: 'The city name.' } }, required: ['city'] }
}
const PROMPT = `What is the weather in ${TEST_CITY} right now? Use the ${TEST_TOOL} tool, then tell me exactly what it returned, including its station code.`
/** The test's output budget: enough for a call or a short answer, with thinking off. */
export const TEST_MAX_TOKENS = 1024

/** Step 1's request body. */
export function step1Body(model: string): Record<string, unknown> {
  return { model, max_tokens: TEST_MAX_TOKENS, tools: [TOOL], messages: [{ role: 'user', content: PROMPT }] }
}

/**
 * A synthetic result whose code appears nowhere in the prompt (s11: an answer that contains it used the result).
 * `random` is injectable for tests.
 */
export function testResult(random: () => number = Math.random): { text: string; code: string } {
  const code = String(10000 + Math.floor(random() * 89999))
  return { text: `-7.3 °C, light snow, station code ${code}`, code }
}

/** Step 2's request body: step 1's call and its synthetic result. */
export function step2Body(model: string, toolUse: { id: string; input: Record<string, unknown> }, result: string): Record<string, unknown> {
  return {
    model,
    max_tokens: TEST_MAX_TOKENS,
    tools: [TOOL],
    messages: [
      { role: 'user', content: PROMPT },
      { role: 'assistant', content: [{ type: 'tool_use', id: toolUse.id, name: TEST_TOOL, input: toolUse.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result }] }
    ]
  }
}

/**
 * Why a step failed, each from its own evidence:
 * - endpoint: no messages API at that URL (404, 405); protocol: a reply that isn't the Messages API's shape;
 * - refused, forbidden: the key (401, 403);
 * - modelRejected: the server's error says the model isn't there;
 * - promptTooLarge: its error says the prompt exceeds the context;
 * - toolsUnsupported: its error says tools aren't supported;
 * - toolText: no tool call, but tool-call-shaped text (the tool's name or a call's syntax) in a text block;
 * - noToolCall: an answer without a tool call or such text;
 * - wrongTool, extraCalls: a call to another tool, or more than one call;
 * - invalidArguments: arguments not valid for the tool's schema; wrongArgument: valid, but not the city asked about;
 * - thinkingBudget: the output budget ran out with only thinking written;
 * - resultIgnored: the answer after the result doesn't contain its code, or calls a tool again;
 * - incomplete: the answer stopped before its end (`max_tokens` with text);
 * - unexpected: anything else, with what was seen.
 */
export type ToolTestFailure =
  | 'endpoint'
  | 'protocol'
  | 'refused'
  | 'forbidden'
  | 'modelRejected'
  | 'promptTooLarge'
  | 'toolsUnsupported'
  | 'toolText'
  | 'noToolCall'
  | 'wrongTool'
  | 'extraCalls'
  | 'invalidArguments'
  | 'wrongArgument'
  | 'thinkingBudget'
  | 'resultIgnored'
  | 'incomplete'
  | 'unexpected'

/** What was seen of a reply, as data (never its text): its status, stop reason and blocks' kinds. */
export interface ReplySeen {
  status: number
  stopReason?: string
  blocks?: string[]
}

export type StepJudgement = { ok: true; toolUse?: { id: string; input: Record<string, unknown> } } | { ok: false; why: ToolTestFailure; seen: ReplySeen }

/** A reply as main read it: its status, and its 2xx body or the start of its error's (errorText), never shown. */
export interface StepReply {
  status: number
  text?: string
  errorText?: string
}

/** A server's error, as evidence: the start of its body, matched (never shown or logged). */
function errorWhy(status: number, error: string): ToolTestFailure | null {
  if (status === 401) return 'refused'
  if (status === 403) return 'forbidden'
  if (status === 404 && !/model/i.test(error)) return 'endpoint'
  if (status === 405) return 'endpoint'
  if (/\bmodel\b/i.test(error) && /not found|does not exist|doesn['’]t exist|unknown|no such|not available|is not loaded|pull/i.test(error)) return 'modelRejected'
  if (status === 413 || /context (?:length|size|window)|too (?:long|large|many tokens)|exceeds?|n_ctx|maximum (?:context|prompt)|prompt is too long/i.test(error)) return 'promptTooLarge'
  if (/tool/i.test(error) && /not supported|unsupported|does not support|doesn['’]t support|jinja/i.test(error)) return 'toolsUnsupported'
  return null
}

/** A Messages reply's blocks and stop reason, or null when it isn't one. */
function messageOf(text: string | undefined): { blocks: Record<string, unknown>[]; stopReason?: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text ?? '')
  } catch {
    return null
  }
  const r = obj(parsed)
  if (!r || !Array.isArray(r.content)) return null
  return { blocks: r.content.map(obj).filter((b): b is Record<string, unknown> => !!b), ...(typeof r.stop_reason === 'string' ? { stopReason: r.stop_reason } : {}) }
}

/** A reply that isn't a 2xx Messages reply: its failure (null: none of these, go on). */
function failed(reply: StepReply): StepJudgement | null {
  const seen: ReplySeen = { status: reply.status }
  if (reply.status < 200 || reply.status >= 300) return { ok: false, why: errorWhy(reply.status, reply.errorText ?? '') ?? 'unexpected', seen }
  return null
}

const TOOL_SHAPED = [new RegExp(`\\b${TEST_TOOL}\\b`), /\{\s*"name"\s*:/, /<tool_call>/i, /\[TOOL_CALLS\]/, /<\|tool_call/i, /"tool_calls"\s*:/]

/** Text that looks like a tool call written out rather than made. */
export const toolShaped = (text: string): boolean => TOOL_SHAPED.some((re) => re.test(text))

const textOf = (blocks: Record<string, unknown>[]): string => blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
const kinds = (blocks: Record<string, unknown>[]): string[] => blocks.map((b) => (typeof b.type === 'string' ? b.type : '?'))
const onlyThinking = (blocks: Record<string, unknown>[]): boolean => blocks.length > 0 && blocks.every((b) => b.type === 'thinking' || b.type === 'redacted_thinking' || (b.type === 'text' && !String(b.text ?? '').trim()))

/** Step 1: exactly one call, of the offered tool, its arguments valid and naming the city asked about. */
export function judgeStep1(reply: StepReply): StepJudgement {
  const bad = failed(reply)
  if (bad) return bad
  const m = messageOf(reply.text)
  if (!m) return { ok: false, why: 'protocol', seen: { status: reply.status } }
  const seen: ReplySeen = { status: reply.status, ...(m.stopReason ? { stopReason: m.stopReason } : {}), blocks: kinds(m.blocks) }
  const calls = m.blocks.filter((b) => b.type === 'tool_use')
  if (!calls.length) {
    if (m.stopReason === 'max_tokens' && onlyThinking(m.blocks)) return { ok: false, why: 'thinkingBudget', seen }
    if (toolShaped(textOf(m.blocks))) return { ok: false, why: 'toolText', seen }
    if (textOf(m.blocks).trim()) return { ok: false, why: 'noToolCall', seen }
    return { ok: false, why: 'unexpected', seen }
  }
  if (calls.length > 1) return { ok: false, why: 'extraCalls', seen }
  const call = calls[0]
  if (call.name !== TEST_TOOL) return { ok: false, why: 'wrongTool', seen }
  const input = obj(call.input)
  if (!input || typeof input.city !== 'string' || !input.city.trim() || typeof call.id !== 'string' || !call.id) return { ok: false, why: 'invalidArguments', seen }
  // The city as asked for, whatever its case, accents or a country after it ("reykjavík, Iceland").
  const asked = input.city.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z]/g, '')
  if (!asked.startsWith(TEST_CITY.toLowerCase())) return { ok: false, why: 'wrongArgument', seen }
  return { ok: true, toolUse: { id: call.id, input } }
}

/** Step 2: a finished answer (`end_turn`) that used the result: it contains the result's code, and calls no tool again. */
export function judgeStep2(reply: StepReply, code: string): StepJudgement {
  const bad = failed(reply)
  if (bad) return bad
  const m = messageOf(reply.text)
  if (!m) return { ok: false, why: 'protocol', seen: { status: reply.status } }
  const seen: ReplySeen = { status: reply.status, ...(m.stopReason ? { stopReason: m.stopReason } : {}), blocks: kinds(m.blocks) }
  if (m.blocks.some((b) => b.type === 'tool_use')) return { ok: false, why: 'resultIgnored', seen }
  if (m.stopReason === 'max_tokens') return { ok: false, why: onlyThinking(m.blocks) ? 'thinkingBudget' : 'incomplete', seen }
  // A completed round trip ends its turn (HR3 on s11): any other stop isn't one, whatever its text holds.
  if (m.stopReason !== 'end_turn') return { ok: false, why: 'unexpected', seen }
  if (!textOf(m.blocks).includes(code)) return { ok: false, why: 'resultIgnored', seen }
  return { ok: true }
}

/** Why a check gave no result: the server couldn't be reached, a newer check or a change replaced it, or too many ran. */
export type CheckProblem = 'unreachable' | 'stale' | 'busy'

export type ContextCheck = { ok: true; context: ServerContext; at: number } | { ok: false; why: CheckProblem }
export type ToolTest = { ok: true; at: number } | { ok: false; why: ToolTestFailure | CheckProblem; step?: 1 | 2; seen?: ReplySeen; at?: number }

/** The last of each, a connection and model's. */
export interface LastCheck {
  context?: Extract<ContextCheck, { ok: true }>
  tools?: ToolTest & { at: number }
}
