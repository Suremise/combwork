import { join } from 'path'
import { readdir, stat } from 'original-fs/promises'
import type { CompactionEvent, DayUsage, ProviderId, SessionUsage, TranscriptItem, UsageTokens } from '../../../shared/types'
import { emptyDay, localDay } from '../../../shared/usageDays'
import { TimelineBuilder } from '../../../shared/usageTimeline'
import type { NewItem } from '../conversation'
import type { ConversationParserLike, ImageLocation } from '../types'
import type { MuseLog } from '../../../shared/providers/muse/names'
import { logNames } from './names'

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

/** The log's names, as one reader reads them throughout (muse.names.sessionLog, logNames). */
export type LogNames = Readonly<Record<MuseLog, string>>

/** A compaction's event kinds: a guess, as no 1.4.20 record has one (the echo provider never compacts). */
const COMPACTION = /compact/i
const COMPACTION_DONE = /complet|finish|done|end/i

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
/** A record's own field (never one through its prototype): a name is data, a dotted one a single name. */
const own = (r: unknown, k: string): unknown => (isObj(r) && Object.hasOwn(r, k) ? r[k] : undefined)
const ownObj = (r: unknown, k: string): Rec | null => {
  const v = own(r, k)
  return isObj(v) ? v : null
}
const ownText = (r: unknown, k: string): string | null => {
  const v = own(r, k)
  return typeof v === 'string' ? v : null
}

/** A line's records: itself, or a wrapper's children; none for a line that isn't one. */
export function museRecords(line: string, n: LogNames): Rec[] {
  if (!line.trim()) return []
  let r: unknown
  try {
    r = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObj(r)) return []
  if (Object.hasOwn(r, n.wrapper)) {
    const children = own(r, n.children)
    return (Array.isArray(children) ? children : []).flatMap((c: unknown) => {
      const json = ownText(c, n.recordJson)
      if (json === null) return []
      try {
        const inner = JSON.parse(json)
        return isObj(inner) ? [inner] : []
      } catch {
        return []
      }
    })
  }
  return [r]
}

/** A record's time as ISO 8601 (its `recorded_at`, microseconds since the epoch), or undefined. */
export function recordTime(r: Rec, n: LogNames): string | undefined {
  const us = own(r, n.recordedAt)
  if (typeof us !== 'number' || !Number.isFinite(us) || us <= 0) return undefined
  const d = new Date(Math.floor(us / 1000))
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** A run event of a record (`runtime.session`, `payload.kind: run`), or null. */
export function runEvent(r: Rec, n: LogNames): Rec | null {
  const payload = ownObj(r, n.payload)
  if (own(r, n.payloadType) !== n.session || !payload || own(payload, n.payloadKind) !== n.run) return null
  return ownObj(payload, n.event)
}

/** The build a session's metadata record names (`payload.record.build.semver`), or null. */
function buildOf(r: Rec, n: LogNames): string | null {
  if (own(r, n.payloadType) !== n.metadata) return null
  return ownText(ownObj(ownObj(ownObj(r, n.payload), n.record), n.build), n.semver)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A model id a run event names (`model`, else `model_id`), when it is a plain one. */
const modelOf = (e: Rec, n: LogNames): string | null => {
  const v = ownText(e, n.model) ?? ownText(e, n.modelId)
  return v && v.trim() && v !== 'unknown' ? v.trim() : null
}

/** Records already read, by their id: a line for one again is left out. */
const recordId = (r: Rec, n: LogNames): string | null => ownText(r, n.id) || null

/** A run event's kind. */
const kindOf = (e: Rec, n: LogNames): string | null => ownText(e, n.eventKind)

/**
 * Muse's session log in the conversation view: each turn's prompt, its reply, and its compactions. Tool calls aren't
 * shown (none recorded yet: see above).
 */
export class MuseConversationParser implements ConversationParserLike {
  readonly items: TranscriptItem[] = []
  readonly images: ImageLocation[] = []
  offset = 0
  private seen = new Set<string>()

  /** `projectPath`: the project whose session it is (kept for paths in tool calls, once they are read). */
  constructor(
    readonly projectPath: string | null = null,
    private readonly n: LogNames = logNames()
  ) {}

  feed(buf: Buffer): number {
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
      for (const r of museRecords(buf.toString('utf8', start, nl), this.n)) this.record(r)
      start = nl + 1
    }
    this.offset += start
    return start
  }

  private push(item: NewItem): void {
    this.items.push({ ...item, id: this.items.length } as TranscriptItem)
  }

  private record(r: Rec): void {
    const n = this.n
    const id = recordId(r, n)
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    const e = runEvent(r, n)
    if (!e) return
    const ts = recordTime(r, n) ?? null
    const kind = kindOf(e, n)
    const prompt = ownText(e, n.prompt)
    if (kind === n.started && prompt?.trim()) {
      this.push({ kind: 'user', timestamp: ts, text: prompt, images: [] })
      return
    }
    const reply = ownText(e, n.text)
    if (kind === n.reply && reply?.trim()) {
      this.push({ kind: 'assistant', timestamp: ts, text: reply })
      return
    }
    if (kind && COMPACTION.test(kind) && COMPACTION_DONE.test(kind)) {
      const summary = ownText(e, 'summary')
      this.push({ kind: 'compaction', timestamp: ts, trigger: 'auto', preTokens: 0, postTokens: 0, nextRequestTokens: null, summary: summary?.trim() ? summary : null })
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

  constructor(
    sessionId: string,
    private readonly n: LogNames = logNames()
  ) {
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
    for (const line of text.split('\n')) for (const r of museRecords(line, this.n)) this.record(r)
  }

  private record(r: Rec): void {
    const usage = this.usage
    const n = this.n
    const id = recordId(r, n)
    if (id) {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    const ts = recordTime(r, n)
    const build = buildOf(r, n)
    if (build) usage.cliVersion = build
    const e = runEvent(r, n)
    if (!e) return
    if (ts) {
      if (!usage.firstActivity || ts < usage.firstActivity) usage.firstActivity = ts
      if (!usage.lastActivity || ts > usage.lastActivity) usage.lastActivity = ts
    }
    const model = modelOf(e, n)
    if (model) usage.model = model
    const kind = kindOf(e, n)
    const prompt = ownText(e, n.prompt)
    if (kind === n.started && prompt !== null) {
      const said = prompt.trim()
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
    if (kind === n.request) {
      const u = ownObj(e, n.usage) ?? {}
      const fresh = num(own(u, n.inputTokens))
      const cache = num(own(u, n.cachedTokens))
      const output = num(own(u, n.outputTokens))
      const reasoning = num(own(u, n.reasoningTokens))
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
    if (kind && COMPACTION.test(kind) && COMPACTION_DONE.test(kind)) {
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
export function parseMuseTranscript(text: string, sessionId: string, title: string | null = null, n: LogNames = logNames()): SessionUsage {
  const p = new MuseUsageParser(sessionId, n)
  p.feed(text)
  return p.result(title)
}
