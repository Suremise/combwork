import { deserialize, serialize } from 'v8'
import { brotliCompressSync, brotliDecompressSync, constants } from 'zlib'
import type { ProviderId, SessionUsage } from '../shared/types'
import { CLAUDE_CODE } from '../shared/claude'
import { CODEX } from '../shared/codex'
import { COPILOT } from '../shared/copilot'
import { ANTIGRAVITY } from '../shared/antigravity'
import { ClaudeUsageParser } from './providers/claude/usage'
import { CodexUsageParser } from './providers/codex/rollout'
import { CopilotUsageParser } from './providers/copilot/events'
import { AntigravityUsageParser } from './providers/antigravity/transcript'

/**
 * The CLIs' usage parsers without their adapters (#1106), for the usage worker, which can't load Electron: a parser
 * reads a transcript's whole lines and gives the usage so far (`result`, without the title an adapter adds from the CLI's
 * own index). Its state can be saved and taken up again, so a transcript is read from where it was left, also after a
 * restart: its fields as they are (v8's serializer keeps Maps, Sets and plain objects), compressed, put back into a new
 * parser.
 */
export interface RawUsageParser {
  feed(text: string): void
  result(): SessionUsage
}

const PARSERS: Partial<Record<ProviderId, new (sessionId: string) => { feed(text: string): void; result(title?: string | null): SessionUsage }>> = {
  [CLAUDE_CODE]: ClaudeUsageParser,
  [CODEX]: CodexUsageParser,
  [COPILOT]: CopilotUsageParser,
  [ANTIGRAVITY]: AntigravityUsageParser
}

/** A provider's parser for a session, or null for one this Combwork can't read. */
export function newUsageParser(provider: ProviderId, sessionId: string): RawUsageParser | null {
  const P = PARSERS[provider]
  if (!P) return null
  const p = new P(sessionId)
  return { feed: (text) => p.feed(text), result: () => p.result(null), [STATE]: p } as RawUsageParser
}

const STATE = Symbol('parser')
const own = (p: RawUsageParser): Record<string, unknown> => (p as unknown as Record<symbol, Record<string, unknown>>)[STATE]

/**
 * What a saved state must match to be taken up: the parser's field names and those of the objects in it made by a class
 * (the timeline's builder), so a state saved by a parser of another shape is read afresh rather than misread. With Combwork's
 * version beside it (usageDb: a state is kept only for the version that saved it), a parser changed between versions
 * never takes one up.
 */
export function parserShape(p: RawUsageParser): string {
  const o = own(p)
  return `${STATE_FORMAT};` + Object.keys(o)
    .sort()
    .map((k) => {
      const v = o[k]
      return isClassInstance(v) ? `${k}{${Object.keys(v as object).sort().join(',')}}` : k
    })
    .join(',')
}

const isClassInstance = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null

/**
 * How a state is saved, in its shape: v8's serializer, brotli-compressed (HI-1912: a tenth of the size, in a few ms for
 * the largest). A state saved another way has another shape, so it is read afresh.
 */
const STATE_FORMAT = 'br'
/** Quick rather than smallest: a running session's state is saved every few minutes. */
const STATE_QUALITY = 4

/** A parser's state, to take up later with `restoreParser`. */
export function saveParser(p: RawUsageParser): Buffer {
  const data = serialize(own(p))
  return brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: STATE_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } })
}

/**
 * A new parser for the session with a saved state put back: its fields as saved, those made by a class (the timeline's
 * builder) filled in place so they keep their methods. Null when the state can't be read or isn't this parser's shape.
 */
export function restoreParser(provider: ProviderId, sessionId: string, state: Uint8Array, shape: string): RawUsageParser | null {
  const p = newUsageParser(provider, sessionId)
  if (!p || parserShape(p) !== shape) return null
  let saved: Record<string, unknown>
  try {
    saved = deserialize(brotliDecompressSync(state)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!saved || typeof saved !== 'object') return null
  const o = own(p)
  for (const k of Object.keys(o)) {
    if (!(k in saved)) return null
    if (isClassInstance(o[k])) Object.assign(o[k] as object, saved[k])
    else o[k] = saved[k]
  }
  return p
}
