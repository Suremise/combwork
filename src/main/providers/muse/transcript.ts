import { join } from 'path'
import { readdir, stat } from 'original-fs/promises'
import type { CompactionEvent, DayUsage, ProviderId, SessionUsage, TranscriptItem, UsageTokens } from '../../../shared/types'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import type { NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation } from '../types'

/**
 * Muse Code's session log (HI-3202, read from 1.4.20's: tests/fixtures/muse/session-1.4.20-echo.jsonl, an offline echo
 * session): `<XDG_DATA_HOME>/muse/sessions/YYYY/MM/DD/<session id>/session.jsonl`, found by the session id (Muse's hooks
 * give `transcript_path: null`). One event record a line: {schema_version, id, stream, sequence, recorded_at (µs since
 * the epoch), record_type, payload_type, payload}. What is read:
 * - `runtime.session.metadata`: the build (`build.semver`) the session ran;
 * - `runtime.session` run events (`payload.kind: run`, `payload.event.kind`):
 *   - `started` (`prompt`): a turn the user (or Combwork, for the user) began;
 *   - `assistant_message_committed` (`text`): the reply;
 *   - `model_completed` (`usage`: input, output, cached and reasoning tokens): one model request;
 *   - `terminal` (`terminal`: completed, failed…): the turn's end;
 *   - a compaction's events, by a kind naming one (`compaction`), as far as a record shows one.
 * A record can be wrapped (`retained_frame`, its `children[].record_json` each a record as a JSON string): unwrapped.
 * Everything else (tasks, context blocks, hooks' runs) is left out, as is any line that isn't JSON. The format isn't
 * documented: what isn't recognised is left out, never guessed at.
 *
 * Tool calls aren't read: no 1.4.20 session with one was recorded (the echo provider makes none), so their event kinds and
 * fields aren't known; a session's tool calls don't show in its conversation view until one is recorded.
 */

const MUSE: ProviderId = 'muse'

/** The field and kind names read (1.4.20's), in one place: what a later Muse renames is changed here. */
export const MUSE_LOG = {
  wrapper: 'retained_frame',
  wrapperChildren: 'children',
  wrapperRecord: 'record_json',
  recordedAt: 'recorded_at',
  metadata: 'runtime.session.metadata',
  session: 'runtime.session',
  run: 'run',
  started: 'started',
  prompt: 'prompt',
  reply: 'assistant_message_committed',
  replyText: 'text',
  request: 'model_completed',
  usage: 'usage',
  terminal: 'terminal',
  compaction: /compact/i
} as const

/** A Muse session id: a UUID (its hex groups, any version), never a path. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isMuseSessionId = (id: unknown): id is string => typeof id === 'string' && SESSION_ID.test(id)

const YEAR = /^\d{4}$/
const PART = /^\d{2}$/
/** The most day folders looked in under one data home: a bound on a walk over an unexpectedly large store. */
const MAX_DAYS = 5000

const dirs = async (dir: string, name: RegExp): Promise<string[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && name.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/**
 * A session's log in any of `dataHomes` (each an XDG_DATA_HOME: an account's folder, a test home, Combwork's default),
 * newest days first; null when none has it. Only YYYY\MM\DD folders are walked, at most MAX_DAYS each.
 */
export async function museSessionFile(dataHomes: readonly string[], sessionId: string): Promise<string | null> {
  if (!isMuseSessionId(sessionId)) return null
  for (const home of dataHomes) {
    const root = join(home, 'muse', 'sessions')
    let days = 0
    for (const y of await dirs(root, YEAR)) {
      for (const m of await dirs(join(root, y), PART)) {
        for (const d of await dirs(join(root, y, m), PART)) {
          if (++days > MAX_DAYS) break
          const file = join(root, y, m, d, sessionId, 'session.jsonl')
          try {
            if ((await stat(file)).isFile()) return file
          } catch {
            // Not this day's.
          }
        }
      }
    }
  }
  return null
}

type Rec = Record<string, any>

const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** A line's records: itself, or a wrapper's children; none for a line that isn't one. */
export function museRecords(line: string): Rec[] {
  if (!line.trim()) return []
  let r: unknown
  try {
    r = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObj(r)) return []
  if (MUSE_LOG.wrapper in r) {
    const children = Array.isArray(r[MUSE_LOG.wrapperChildren]) ? r[MUSE_LOG.wrapperChildren] : []
    return children.flatMap((c: unknown) => {
      if (!isObj(c) || typeof c[MUSE_LOG.wrapperRecord] !== 'string') return []
      try {
        const inner = JSON.parse(c[MUSE_LOG.wrapperRecord])
        return isObj(inner) ? [inner] : []
      } catch {
        return []
      }
    })
  }
  return [r]
}

/** A record's time as ISO 8601 (its `recorded_at`, microseconds since the epoch), or undefined. */
export function recordTime(r: Rec): string | undefined {
  const us = r[MUSE_LOG.recordedAt]
  if (typeof us !== 'number' || !Number.isFinite(us) || us <= 0) return undefined
  const d = new Date(Math.floor(us / 1000))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** A run event of a record (`runtime.session`, `payload.kind: run`), or null. */
export function runEvent(r: Rec): Rec | null {
  if (r.payload_type !== MUSE_LOG.session || !isObj(r.payload) || r.payload.kind !== MUSE_LOG.run) return null
  return isObj(r.payload.event) ? r.payload.event : null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A model id a run event names (`model`, else `model_id`), when it is a plain one. */
const modelOf = (e: Rec): string | null => {
  const v = typeof e.model === 'string' ? e.model : typeof e.model_id === 'string' ? e.model_id : null
  return v && v.trim() && v !== 'unknown' ? v.trim() : null
}

/** Records already read, by their id: a line for one again is left out. */
const recordId = (r: Rec): string | null => (typeof r.id === 'string' && r.id ? r.id : null)

/**
 * Muse's session log in the conversation view: each turn's prompt, its reply, and its compactions. Tool calls aren't
 * shown (none recorded yet: see above).
 */
export class MuseConversationParser implements ConversationParserLike {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  offset = 0
  private seen = new Set<string>()

  /** The project whose session it is (kept for paths in tool calls, once they are read). */
  constructor(readonly projectPath: string | null = null) {}

  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      for (const r of museRecords(buf.toString('utf8', start, nl))) this.record(r)
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  private record(r: Rec): void {
    const id = recordId(r)
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    const e = runEvent(r)
    if (!e) return
    const ts = recordTime(r) ?? null
    if (e.kind === MUSE_LOG.started && typeof e[MUSE_LOG.prompt] === 'string' && e[MUSE_LOG.prompt].trim()) {
      this.push({ kind: 'user', timestamp: ts, text: e[MUSE_LOG.prompt], images: [] })
      return
    }
    if (e.kind === MUSE_LOG.reply && typeof e[MUSE_LOG.replyText] === 'string' && e[MUSE_LOG.replyText].trim()) {
      this.push({ kind: 'assistant', timestamp: ts, text: e[MUSE_LOG.replyText] })
      return
    }
    if (typeof e.kind === 'string' && MUSE_LOG.compaction.test(e.kind) && /complet|finish|done|end/i.test(e.kind)) {
      this.push({ kind: 'compaction', timestamp: ts, trigger: 'auto', preTokens: 0, postTokens: 0, nextRequestTokens: null, summary: typeof e.summary === 'string' && e.summary.trim() ? e.summary : null })
    }
  }
}

/**
 * Usage from Muse's session log: each `model_completed` is a request, with its input, cached, output and reasoning tokens
 * (its input counted without its cached part when that is all it reports: Muse gives `cached_tokens` beside
 * `input_tokens`; the two are taken as separate, the cached part the cache read). Muse publishes no per-token prices that
 * Combwork ships, so the usage carries no cost of its own (costUsd null): prices the user adds apply as for any provider.
 */
export class MuseUsageParser {
  private usage: SessionUsage
  private days: Record<string, DayUsage> = {}
  private timeline = new TimelineBuilder()
  private seen = new Set<string>()
  private compactAsked = false

  constructor(sessionId: string) {
    this.usage = {
      provider: MUSE,
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
    for (const line of text.split('\n')) for (const r of museRecords(line)) this.record(r)
  }

  private record(r: Rec): void {
    const usage = this.usage
    const id = recordId(r)
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    const ts = recordTime(r)
    if (r.payload_type === MUSE_LOG.metadata && isObj(r.payload?.record?.build) && typeof r.payload.record.build.semver === 'string') usage.cliVersion = r.payload.record.build.semver
    const e = runEvent(r)
    if (!e) return
    if (ts) {
      if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
      if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
    }
    const model = modelOf(e)
    if (model) usage.model = model
    if (e.kind === MUSE_LOG.started && typeof e[MUSE_LOG.prompt] === 'string') {
      const said = e[MUSE_LOG.prompt].trim()
      if (said === '/compact') {
        this.compactAsked = true
        return
      }
      usage.userMessages++
      const d = this.day(ts)
      if (d) d.prompts++
      if (said) usage.lastPrompt = said
      return
    }
    if (e.kind === MUSE_LOG.request) {
      const u = isObj(e[MUSE_LOG.usage]) ? e[MUSE_LOG.usage] : {}
      const fresh = num(u.input_tokens)
      const cache = num(u.cached_tokens)
      const output = num(u.output_tokens)
      const reasoning = num(u.reasoning_tokens)
      usage.requests++
      usage.inputTokens += fresh
      usage.cacheReadTokens += cache
      usage.outputTokens += output
      usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoning
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
      const step: Partial<UsageTokens> = { inputTokens: fresh, cacheReadTokens: cache, outputTokens: output }
      this.timeline.add(ts || usage.lastActivity, step, 1, -1, 0, usage.model)
      return
    }
    if (typeof e.kind === 'string' && MUSE_LOG.compaction.test(e.kind) && /complet|finish|done|end/i.test(e.kind)) {
      const c: CompactionEvent = { timestamp: ts ?? '', trigger: this.compactAsked ? 'manual' : 'auto', preTokens: usage.contextTokens, postTokens: 0 }
      usage.compactions.push(c)
      this.compactAsked = false
      const d = this.day(ts)
      if (d) d.compactions++
    }
  }

  /** The usage so far: a new object each time. */
  result(title: string | null = null): SessionUsage {
    const days: Record<string, DayUsage> = {}
    for (const [k, d] of Object.entries(this.days)) days[k] = { ...d }
    return { ...this.usage, title, compactions: this.usage.compactions.map((c) => ({ ...c })), days, timeline: this.timeline.timeline() }
  }
}

/** Usage for a whole session log. */
export function parseMuseTranscript(text: string, sessionId: string, title: string | null = null): SessionUsage {
  const p = new MuseUsageParser(sessionId)
  p.feed(text)
  return p.result(title)
}
