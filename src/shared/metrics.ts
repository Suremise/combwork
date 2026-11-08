/**
 * Combwork's performance metrics (#115): what the Agent API, the combwork MCP bridge, Combwork's launch guidance and its skill
 * service cost, counted locally per workspace. Units are exact where Combwork can measure them (UTF-8 bytes, characters as
 * UTF-16 code units, i.e. JavaScript string length, milliseconds on a monotonic clock); provider token usage is what the
 * provider reported. Combwork estimates no tokens. Nothing here holds a prompt, a body, a token, a URL or a path.
 */
import type { Text } from './advanced'
import type { LaunchWorkflow } from './workflow/roles'

/** Latency histogram bounds (ms, inclusive upper bounds); a last bucket counts everything above the highest. */
export const LATENCY_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000] as const

/** A count of something timed: how many, total and largest time, and a histogram over LATENCY_BOUNDS_MS (+1 overflow). */
export interface Timed {
  count: number
  totalMs: number
  maxMs: number
  /** LATENCY_BOUNDS_MS.length + 1 counts. */
  histogram: number[]
}

/**
 * How a request ended. `waiting` (HI-1831): a reply that says to ask again (an isolated check's resolve while no check
 * copy is free): an expected wait, not a failure. Before HI-1831 those were recorded as `client-error`.
 *
 * A failed request's kind (HI-2553): `refused` (409: a workflow rule or a guard said no, and what to do instead), `invalid`
 * (a wrong call: a bad argument, an unknown card, a missing file; 4xx but 401, 403 and 409), `denied` (401, 403) and
 * `server-error` (5xx: a real error). `client-error` is a 4xx recorded before HI-2553, its kind not known.
 */
export type MetricOutcome = 'ok' | 'refused' | 'invalid' | 'client-error' | 'denied' | 'server-error' | 'cancelled' | 'waiting'

/**
 * How a tool call ended (HI-2553): `refused` and `invalid` as MetricOutcome's, from the Agent API's status, or the bridge's
 * own check of the arguments (`invalid`); `failed`, a real error (5xx, a thrown exception, a timeout or no connection).
 * `error` is a failed call recorded before HI-2553, its kind not known.
 */
export type ToolOutcome = 'ok' | 'refused' | 'invalid' | 'failed' | 'error'

/** What a failure was (HI-2553), as the Performance view sorts it; `unknown` for one recorded before its kind was. */
export type FailureKind = 'refused' | 'invalid' | 'error' | 'unknown'

/** A request's or a tool call's failure kind; null when it didn't fail (ok, a wait, cancelled by the caller). */
export function failureKind(outcome: MetricOutcome | ToolOutcome): FailureKind | null {
  switch (outcome) {
    case 'refused':
    case 'denied':
      return 'refused'
    case 'invalid':
      return 'invalid'
    case 'server-error':
    case 'failed':
      return 'error'
    case 'client-error':
    case 'error':
      return 'unknown'
    default:
      return null
  }
}

/**
 * A reason Combwork gave for a refusal or a wrong call (HI-2553): a workflow rule's id (`rule:<id>`) or its message's id
 * (`msg:<id>`; an agent message's, `agent:<id>`: HI-2681), never its text; `other` when it had neither, or past
 * REASONS_MAX in a series.
 */
export const REASON_LABEL = /^(?:(?:rule|msg|agent):[A-Za-z0-9_.-]{1,96}|other)$/

/** At most this many reasons a series keeps; the rest are counted as `other`. */
export const REASONS_MAX = 12

/** Adds `n` of a reason to a series' reasons, within REASONS_MAX (past it, or a label that isn't one, as `other`). */
export function addReason(to: Record<string, number>, reason: string, n: number): void {
  const label = REASON_LABEL.test(reason) ? reason : 'other'
  const named = Object.keys(to).filter((k) => k !== 'other').length
  const key = label in to || label === 'other' || named < REASONS_MAX ? label : 'other'
  to[key] = (to[key] ?? 0) + n
}

/** Agent API requests, by route template, method, caller role and outcome. */
export interface ApiSeries extends Timed {
  route: string
  method: string
  role: 'agent' | 'assistant' | 'api' | 'viewer' | 'unknown'
  outcome: MetricOutcome
  /** Request body and response body, UTF-8 bytes (JSON as sent; headers and transport not included). */
  requestBytes: number
  responseBytes: number
  /** A refused or wrong call's series (HI-2553): how many of its requests each reason had (REASON_LABEL), at most REASONS_MAX and `other`. */
  reasons?: Record<string, number>
}

/** Combwork tool calls as the MCP bridge answered them: the final text the model gets. */
export interface McpSeries extends Timed {
  tool: string
  role: 'agent' | 'assistant'
  /** The caller asked for the full form (detail, details, full card) or took the default compact one. */
  mode: 'compact' | 'detail'
  outcome: ToolOutcome
  /** The reply's text: characters (UTF-16 code units) and UTF-8 bytes. */
  chars: number
  bytes: number
}

/** What a launch gave a session from Combwork (by provider and role), exact sizes of each part. */
export interface GuidanceSeries {
  provider: string
  role: 'agent' | 'assistant'
  /** The launch's side of the workflow (HI-2049); `unknown`: recorded before Combwork counted it. */
  workflow: LaunchWorkflow | 'unknown'
  /** The hash of the dialect chain its launches spoke (HI-2443), where one overrides text; absent: the Default. */
  dialect?: string
  launches: number
  /**
   * Each part of what Combwork tells the session at launch, counted once a launch whichever way the provider gets it (the
   * combwork MCP server's instructions, Codex's developer_instructions, the Assistant's prompt):
   * - core: Combwork's session contract, the same text for every session of a role;
   * - custom: what Combwork adds for this project or workspace (the latest handover's pointer);
   * - role: the Assistant's role (who it is, the workspace, what Control lets it do), none for project agents;
   * - mode: the Assistant's mode, as the workspace has it, none for project agents.
   */
  guidanceBytes: number
  guidanceChars: number
  customBytes: number
  customChars: number
  roleBytes: number
  roleChars: number
  modeBytes: number
  modeChars: number
  /**
   * Skills the session got, measured on the copies it reads (not their sources): how many, the bytes of their names
   * and descriptions (the catalog a CLI shows), and their bytes on disk. A model reads a skill's body only when it uses
   * it, which isn't observable.
   */
  skills: number
  skillCatalogBytes: number
  skillBytes: number
  /** Skills asked for that the session didn't get (too big, a link that can't be made, a failed copy, a broken header). */
  skillsNotDelivered: number
  /**
   * Skills the session got whose copy couldn't be measured (gone or unreadable when Combwork looked): counted in `skills`,
   * left out of `skillCatalogBytes` and `skillBytes`, which are the measured skills' only. Unknown, not zero.
   */
  skillsUnmeasured: number
}

/**
 * The combwork MCP bridge's tool list as one session start sent it to its CLI (tools/list: names, descriptions, schemas).
 * Its instructions aren't counted here: they are Combwork's session contract, counted once per launch in GuidanceSeries.
 */
export interface CatalogSeries {
  /** The CLI of the launch whose bridge sent it (HI-2553); `unknown`: recorded before Combwork counted it, or not known. */
  provider: string
  role: 'agent' | 'assistant'
  /** The side of the workflow of the launch whose bridge sent it (HI-2049); `unknown`: recorded before Combwork counted it. */
  workflow: LaunchWorkflow | 'unknown'
  starts: number
  tools: number
  toolsBytes: number
  /**
   * What a CLI that defers MCP tools (Claude Code) is given at the start (HI-2553), of the starts that reported it
   * (`upfrontStarts`): the tools Combwork marks to be sent in full, as the JSON has them, and the other tools' names (a
   * JSON list of them). The CLI's own wording of that isn't observable; a CLI that doesn't defer gets `toolsBytes`.
   */
  upfrontStarts: number
  upfrontBytes: number
  /**
   * The same list's characters (its JSON's UTF-16 code units), and of how many of the starts: a bridge from before
   * HI-2049 sent bytes only, so its starts are in `starts` and not here.
   */
  toolsChars: number
  charStarts: number
  /**
   * Its parts (HI-2063), of the starts that reported them (`partStarts`, a bridge from before HI-2063 reported none):
   * those starts' characters in all (`partToolsChars`), the tools' descriptions and the parameters' descriptions, each
   * as the JSON has them. The rest of those characters is the schemas and the list's structure (names, types, keys,
   * punctuation, escapes): `partToolsChars - descriptionChars - paramChars`.
   */
  partStarts: number
  partToolsChars: number
  descriptionChars: number
  paramChars: number
}

/** The skill service (revisions.ts): scans, what they read and what the inventory saved. */
export interface SkillServiceSeries {
  scans: Timed
  /** Callers that shared a scan running for someone else. */
  sharedScans: number
  hits: number
  misses: number
  /** Kept revisions found changed (a file written, added, removed). */
  invalidations: number
  tooLarge: number
  files: number
  bytes: number
  headerBytes: number
  entries: number
}

/** The event stream (/v1/events): connections, events and bytes sent, and how long streams stayed open. */
export interface StreamSeries {
  connections: number
  events: number
  bytes: number
  openMs: number
}

/** Safeguard stops (#606) of one agent's sessions on one model: whose (project and agent, as named then), and how many. */
export interface SafeguardCount {
  project: string
  agent: string
  provider: string
  role: 'agent' | 'assistant'
  /** The model the stopped responses were on ('' when the CLI didn't say). */
  model: string
  stops: number
}

/**
 * Provider-reported usage (from the session transcripts' usage, as the Overview shows it), per provider and whose
 * sessions they were: project agents' or the Assistant's. Scripts have no sessions, so no usage.
 */
export interface ProviderUsageSummary {
  provider: string
  role: 'agent' | 'assistant'
  /** Sessions with activity in the range. Their usage is each session's cumulative total, not only the range's part. */
  sessions: number
  /** Of them, running now (the rest have ended). */
  running: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Sessions with no usage reported (unknown, not zero): left out of every total here, and counted in `costUnknown`. */
  unknown: number
  /** Provider requests, and compactions, the sessions reported. */
  requests: number
  compactions: number
  /** Responses the CLIs' safety classifiers stopped (#606), where Combwork can detect them (not Copilot). */
  safeguardStops: number
  /** API-equivalent cost (USD) of the sessions with one: reported by the provider, or Combwork's estimate (`costEstimated` of them). Not a bill: a subscription isn't charged per request. */
  costUsd: number
  costEstimated: number
  /** Sessions whose cost isn't known (no price for the model, or no usage reported). */
  costUnknown: number
  /** Sessions run only on servers on this PC (HI-1772): free, $0 known (in neither costEstimated nor costUnknown). */
  costFree?: number
  /**
   * Context is a snapshot (each session's last request), not a sum: of the sessions that reported one, how many, their
   * average and largest, and the largest context window reported (null: none was).
   */
  contextSessions: number
  contextAvgTokens: number
  contextMaxTokens: number
  contextWindow: number | null
}

/** One point of a report's trend: its scope's totals in an hour (a range of up to 2 days) or a day. */
export interface TrendPoint {
  /** Where the hour or day starts (ISO). */
  start: string
  /**
   * How much of the slot Combwork was recording for this workspace (open, recording on, not since reset), ms. Zero: not
   * observed, so its zeros mean nothing was seen, not that nothing happened.
   */
  observedMs: number
  requests: number
  /** Requests that didn't succeed (client or server error, refused, cancelled); `cancelled` of them, by the client. */
  failed: number
  cancelled: number
  /** Of `failed`, the real errors (5xx, HI-2553): shown apart from refusals and wrong calls. Absent before HI-2553. */
  errors?: number
  /** Replies that said to ask again (HI-1831), not among `failed`. */
  waits: number
  requestBytes: number
  responseBytes: number
  toolCalls: number
  toolChars: number
  launches: number
  guidanceBytes: number
}

/** What a query is about: the whole workspace (with an optional project filter) or one project only. */
export type MetricsScope = { kind: 'workspace' } | { kind: 'project'; project: string }

/** Who did the work: project agents, the Assistant, scripts (the workspace token), or viewer apps (viewer tokens). */
export type MetricsRole = 'agent' | 'assistant' | 'api' | 'viewer'

export interface MetricsQuery {
  scope: MetricsScope
  /** Only this role's work (scripts have no launches or provider sessions). */
  role?: MetricsRole
  /** Only this provider's: applies to launches and provider usage; API requests and tool calls aren't per provider. */
  provider?: string
  /** A workspace scope only: just the workspace's own work (the Assistant, scripts, shared), no project's. */
  own?: boolean
  /** Also the scope's totals hour by hour (up to 2 days) or day by day (`trend`), at most 200 points. */
  trend?: boolean
  /** Range, as ISO times (default: the last 24 hours). Buckets are hourly for 7 days, daily to 30 days. */
  from?: string
  to?: string
}

/** A part of the totals: one project's, or the workspace's own (the Assistant, scripts, shared work). */
export interface MetricsPart {
  api: ApiSeries[]
  mcp: McpSeries[]
  guidance: GuidanceSeries[]
  catalog: CatalogSeries[]
}

/** The filters a report was made with, and what they couldn't apply to (said, rather than implied). */
export interface MetricsFilters {
  role?: MetricsRole
  provider?: string
  own?: true
  /** Parts of the report a filter doesn't narrow, each with why (e.g. API requests aren't recorded per provider). */
  notFiltered: string[]
  /** `notFiltered` as the window shows it (#845): the same items, in order; `notFiltered` is their English. */
  notFilteredText?: Text[]
}

/**
 * When Combwork was recording for this workspace in the range: open in Combwork, recording on, since the last reset (to within
 * a few minutes). Outside it, nothing was seen: no data is not the same as zero.
 */
export interface MetricsCoverage {
  rangeMs: number
  observedMs: number
  /** The earliest observed moment in the range (null: none). */
  observedSince: string | null
  /** Separate stretches of observation in the range (more than one: there were gaps). */
  stretches: number
  /**
   * History removed to keep the metrics under their size limit (not by age), through this time (ISO), when that is in
   * the range: nothing before it is available, so it isn't counted as observed either.
   */
  evictedThrough?: string
}

export interface MetricsReport {
  scope: MetricsScope
  workspacePath: string
  from: string
  to: string
  recording: boolean
  filters: MetricsFilters
  coverage: MetricsCoverage
  /**
   * The parts. A project scope has only that project's; a workspace scope has each project's and `workspace` (work not
   * of any project: the Assistant, scripts, Combwork's own). The totals are their sum, each counted once.
   */
  projects: Record<string, MetricsPart>
  workspace?: MetricsPart
  /** Skill service health (workspace scope only: it is shared, not any project's). */
  skills?: SkillServiceSeries
  /** Process-wide, not this workspace's: requests refused before Combwork knew whose they were, and event streams. */
  app?: { unauthenticated: number; streams: StreamSeries; inFlight: number }
  providers: ProviderUsageSummary[]
  /** Why provider usage is empty or partial for these filters, when it is (e.g. scripts have no sessions). */
  providersNote?: string
  /** `providersNote` as the window shows it (#1104); `providersNote` is its English. */
  providersNoteText?: Text
  /**
   * Session hosts in the scope whose history couldn't be read (projects, the Assistant): a count only, never which. When
   * set, `providers` is partial (or, if it is every host, unknown), not complete.
   */
  providersUnreadable?: number
  /** How many session hosts the scope has (projects, the Assistant), to say how partial. */
  providersHosts?: number
  /** Safeguard stops in the sessions active in the range, per agent and model (#606), most first; absent when none. */
  safeguards?: SafeguardCount[]
  /** With `trend` asked for: the scope's totals per hour or day, oldest first, every slot of the range present. */
  trend?: TrendPoint[]
  trendStep?: 'hour' | 'day'
  /** What isn't measured: said, rather than shown as zero. */
  notMeasured: string[]
  /** `notMeasured` as the window shows it (#845): the same items, in order; `notMeasured` is their English. */
  notMeasuredText?: Text[]
  /**
   * Measurements dropped because a cap was full, so totals may be low: the scope's own (a project scope: that project's
   * only).
   */
  dropped: number
  /** A workspace scope only: of `dropped`, those whose project wasn't tracked (the bookkeeping's own cap was full). */
  droppedUntracked?: number
  /**
   * A project scope only: some losses in the range couldn't be attributed to a project, so this project's may be more
   * than `dropped` (how many isn't known; the count is the workspace's).
   */
  lossesUnattributed?: true
}

export const emptyTimed = (): Timed => ({ count: 0, totalMs: 0, maxMs: 0, histogram: Array.from({ length: LATENCY_BOUNDS_MS.length + 1 }, () => 0) })

/** Adds one timing to a Timed. */
export function addTiming(t: Timed, ms: number): void {
  const v = Number.isFinite(ms) && ms >= 0 ? ms : 0
  t.count++
  t.totalMs += v
  if (v > t.maxMs) t.maxMs = v
  let i = LATENCY_BOUNDS_MS.findIndex((b) => v <= b)
  if (i < 0) i = LATENCY_BOUNDS_MS.length
  t.histogram[i]++
}

/** Adds b into a. */
export function mergeTimed(a: Timed, b: Timed): void {
  a.count += b.count
  a.totalMs += b.totalMs
  a.maxMs = Math.max(a.maxMs, b.maxMs)
  for (let i = 0; i < a.histogram.length; i++) a.histogram[i] += b.histogram[i] ?? 0
}

/** A latency percentile from a histogram: the upper bound of the bucket it falls in (null with no data or past the last bound). */
export function percentile(t: Timed, p: number): number | null {
  if (!t.count) return null
  let seen = 0
  const want = Math.ceil(t.count * p)
  for (let i = 0; i < t.histogram.length; i++) {
    seen += t.histogram[i]
    if (seen >= want) return i < LATENCY_BOUNDS_MS.length ? LATENCY_BOUNDS_MS[i] : null
  }
  return null
}

/** UTF-8 bytes of a string, without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
