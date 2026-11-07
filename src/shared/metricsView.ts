/**
 * What the Performance view (activity bar) and a project's Performance tab show, from a MetricsReport (metrics.ts):
 * the query the filters make (the report, its trend and an export are all made with it, so they agree), the parts and
 * series of the report, and their totals. Pure, so both entries share it and tests can check it. A project scope's
 * report holds only that project's part: nothing here can widen it.
 */
import { LATENCY_BOUNDS_MS, emptyTimed, failureKind, mergeTimed, percentile, type ApiSeries, type CatalogSeries, type GuidanceSeries, type McpSeries, type MetricOutcome, type MetricsPart, type MetricsQuery, type MetricsReport, type MetricsScope, type ProviderUsageSummary, type SafeguardCount, type Timed, type ToolOutcome } from './metrics'
import { PROVIDERS } from './providers'

export type PerfRange = '24h' | '7d' | '30d'
export const PERF_RANGES: { value: PerfRange; label: string; ms: number }[] = [
  { value: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 3_600_000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 3_600_000 }
]

/** Who did the work: project agents, the Assistant, scripts (the workspace token), or everyone. */
export type PerfRole = 'all' | 'agent' | 'assistant' | 'api' | 'viewer'

export interface PerfFilters {
  range: PerfRange
  /**
   * Provider id, or '' for all (applies to launches and provider usage: the rest isn't per provider). The page applies
   * it to those sections itself (`select()`): its query, export and kept views have none (`pageQuery()`).
   */
  provider: string
  role: PerfRole
  /**
   * The workspace view only: '' all of it, WORKSPACE_OWN the workspace's own work (the Assistant, scripts, shared), or
   * a project's name (queried as that project's scope, so nothing else comes with it).
   */
  project: string
  /** Now (the current metrics) or Compare (a baseline against a run, Performance → Compare). */
  view: 'now' | 'compare'
}

/** The workspace view's filter for work of no project (the Assistant, scripts, Combwork's own). */
export const WORKSPACE_OWN = '\0workspace'

export const DEFAULT_PERF_FILTERS: PerfFilters = { range: '24h', provider: '', role: 'all', project: '', view: 'now' }

/**
 * The query for a scope and the page's filters, as of `now`: the range, role, provider and own work go to Combwork, which
 * narrows every part, the trend and the provider usage alike (the export uses the same query).
 */
export function queryFor(scope: MetricsScope, f: PerfFilters, now: number): MetricsQuery {
  const range = PERF_RANGES.find((r) => r.value === f.range) ?? PERF_RANGES[0]
  return {
    scope,
    from: new Date(now - range.ms).toISOString(),
    to: new Date(now).toISOString(),
    trend: true,
    ...(f.role !== 'all' ? { role: f.role } : {}),
    ...(f.provider ? { provider: f.provider } : {}),
    ...(scope.kind === 'workspace' && f.project === WORKSPACE_OWN ? { own: true } : {})
  }
}

/**
 * The Performance page's query: its scope, range, role and own work, every provider's. The provider filter narrows
 * only the page's per-provider sections (`select()`), which list the provider in each row, so what the page loads,
 * exports and keeps is the same report: the cards, trend and totals agree whatever provider is picked (#270).
 */
export function pageQuery(scope: MetricsScope, f: PerfFilters, now: number): MetricsQuery {
  return queryFor(scope, { ...f, provider: '' }, now)
}

/** The parts a report's scope and the project filter keep: a project's, the workspace's own, or all of them. */
export function partsOf(r: MetricsReport, project: string): MetricsPart[] {
  if (r.scope.kind === 'project') return Object.values(r.projects)
  if (project === WORKSPACE_OWN) return r.workspace ? [r.workspace] : []
  if (project) {
    const want = project.toLowerCase()
    return Object.entries(r.projects)
      .filter(([name]) => name.toLowerCase() === want)
      .map(([, part]) => part)
  }
  return [...Object.values(r.projects), ...(r.workspace ? [r.workspace] : [])]
}

const roleOk = (role: PerfRole, seriesRole: string): boolean => role === 'all' || role === seriesRole

export interface PerfSelection {
  api: ApiSeries[]
  mcp: McpSeries[]
  guidance: GuidanceSeries[]
  catalog: CatalogSeries[]
  providers: ProviderUsageSummary[]
  /** Safeguard stops per agent and model (#606), by provider and role as the providers' usage is. */
  safeguards: SafeguardCount[]
}

/** The series the filters keep. Provider applies where there is one (launches, provider usage); role everywhere it is known. */
export function select(r: MetricsReport, f: PerfFilters): PerfSelection {
  const parts = partsOf(r, f.project)
  return {
    api: parts.flatMap((p) => p.api).filter((s) => roleOk(f.role, s.role)),
    mcp: parts.flatMap((p) => p.mcp).filter((s) => roleOk(f.role, s.role)),
    guidance: parts.flatMap((p) => p.guidance).filter((s) => roleOk(f.role, s.role) && (!f.provider || s.provider === f.provider)),
    // Per provider from HI-2553; a start recorded before it (`unknown`) is in no provider's.
    catalog: parts.flatMap((p) => p.catalog).filter((s) => roleOk(f.role, s.role) && (!f.provider || s.provider === f.provider)),
    // Provider usage is per provider and whose sessions (agents' or the Assistant's); scripts have none.
    providers: r.providers.filter((p) => (!f.provider || p.provider === f.provider) && (f.role === 'all' || p.role === f.role)),
    safeguards: (r.safeguards ?? []).filter((g) => (!f.provider || g.provider === f.provider) && (f.role === 'all' || g.role === f.role))
  }
}

/** Failures by kind (HI-2553): refused by a rule, wrong calls, real errors, and those recorded before their kind was. */
export interface FailureCounts {
  refused: number
  invalid: number
  error: number
  unknown: number
}
export const noFailures = (): FailureCounts => ({ refused: 0, invalid: 0, error: 0, unknown: 0 })
/** Adds `n` of an outcome to failure counts (nothing for one that didn't fail). */
function countFailure(to: FailureCounts, outcome: MetricOutcome | ToolOutcome, n: number): void {
  const k = failureKind(outcome)
  if (k) to[k] += n
}

export interface PerfTotals {
  requests: number
  failed: number
  cancelled: number
  denied: number
  /** Failed requests other than cancelled ones (errors and refusals). */
  errors: number
  /** Requests' failures by kind (HI-2553; denied among the refused). */
  apiFailures: FailureCounts
  /** Tool calls' failures by kind (HI-2553). */
  toolFailures: FailureCounts
  /**
   * Per tool list start, on average: its bytes, and what the CLIs were given at the start (loadedAtStart: of the starts
   * where that is known; null where none is).
   */
  avgToolListBytes: number
  avgToolListUpfrontBytes: number | null
  toolListStarts: number
  /** Replies that said to ask again (an isolated check waiting for a check copy, HI-1831): counted, never failed. */
  waits: number
  requestBytes: number
  responseBytes: number
  latency: Timed
  p50: number | null
  p95: number | null
  toolCalls: number
  toolErrors: number
  toolChars: number
  toolBytes: number
  detailCalls: number
  launches: number
  /** Per launch, on average: core contract, project additions, the Assistant's role and mode (modeBytes), the skills' catalog and bytes. */
  avgGuidanceBytes: number
  avgCustomBytes: number
  avgRoleBytes: number
  avgModeBytes: number
  avgSkillCatalogBytes: number
  avgSkillBytes: number
  avgSkills: number
  skillsNotDelivered: number
  skillsUnmeasured: number
}

/** Totals of a selection. Latency percentiles are the upper bounds of their histogram buckets. */
export function totals(s: PerfSelection): PerfTotals {
  const latency = emptyTimed()
  let failed = 0
  let cancelled = 0
  let denied = 0
  let waits = 0
  const apiFailures = noFailures()
  const toolFailures = noFailures()
  for (const a of s.api) {
    mergeTimed(latency, a)
    if (a.outcome === 'waiting') waits += a.count
    else if (a.outcome !== 'ok') failed += a.count
    if (a.outcome === 'cancelled') cancelled += a.count
    if (a.outcome === 'denied') denied += a.count
    countFailure(apiFailures, a.outcome, a.count)
  }
  for (const m of s.mcp) countFailure(toolFailures, m.outcome, m.count)
  const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((n, x) => n + f(x), 0)
  const launches = sum(s.guidance, (g) => g.launches)
  const per = (n: number): number => (launches ? n / launches : 0)
  const toolListStarts = sum(s.catalog, (c) => c.starts)
  const loaded = s.catalog.map(loadedAtStart).filter((x): x is { starts: number; bytes: number } => !!x)
  const loadedStarts = sum(loaded, (x) => x.starts)
  return {
    requests: latency.count,
    failed,
    cancelled,
    denied,
    errors: failed - cancelled,
    apiFailures,
    toolFailures,
    avgToolListBytes: toolListStarts ? sum(s.catalog, (c) => c.toolsBytes) / toolListStarts : 0,
    avgToolListUpfrontBytes: loadedStarts ? sum(loaded, (x) => x.bytes) / loadedStarts : null,
    toolListStarts,
    waits,
    requestBytes: sum(s.api, (a) => a.requestBytes),
    responseBytes: sum(s.api, (a) => a.responseBytes),
    latency,
    p50: percentile(latency, 0.5),
    p95: percentile(latency, 0.95),
    toolCalls: sum(s.mcp, (m) => m.count),
    toolErrors: sum(s.mcp.filter((m) => m.outcome !== 'ok'), (m) => m.count),
    toolChars: sum(s.mcp, (m) => m.chars),
    toolBytes: sum(s.mcp, (m) => m.bytes),
    detailCalls: sum(s.mcp.filter((m) => m.mode === 'detail'), (m) => m.count),
    launches,
    avgGuidanceBytes: per(sum(s.guidance, (g) => g.guidanceBytes)),
    avgCustomBytes: per(sum(s.guidance, (g) => g.customBytes)),
    avgRoleBytes: per(sum(s.guidance, (g) => g.roleBytes)),
    avgModeBytes: per(sum(s.guidance, (g) => g.modeBytes)),
    avgSkillCatalogBytes: per(sum(s.guidance, (g) => g.skillCatalogBytes)),
    avgSkillBytes: per(sum(s.guidance, (g) => g.skillBytes)),
    avgSkills: per(sum(s.guidance, (g) => g.skills)),
    skillsNotDelivered: sum(s.guidance, (g) => g.skillsNotDelivered ?? 0),
    skillsUnmeasured: sum(s.guidance, (g) => g.skillsUnmeasured ?? 0)
  }
}

/**
 * What a catalog series' CLI was given at its starts (HI-2553), in all: a CLI that defers tools, the up-front part its
 * starts reported (null for starts that reported none); one that doesn't, the whole list; a provider not known, null.
 */
export function loadedAtStart(c: CatalogSeries): { starts: number; bytes: number } | null {
  const p = PROVIDERS.find((x) => x.id === c.provider)
  if (!p) return null
  if (!p.capabilities.defersMcpTools) return { starts: c.starts, bytes: c.toolsBytes }
  return c.upfrontStarts ? { starts: c.upfrontStarts, bytes: c.upfrontBytes } : null
}

export interface RouteRow {
  key: string
  route: string
  method: string
  requests: number
  failed: number
  cancelled: number
  waits: number
  /** Its failures by kind (HI-2553). */
  failures: FailureCounts
  p50: number | null
  p95: number | null
  requestBytes: number
  responseBytes: number
}

/** API series grouped by method and route (roles and outcomes together), most requests first. */
export function byRoute(api: ApiSeries[]): RouteRow[] {
  const rows = new Map<string, RouteRow & { t: Timed }>()
  for (const a of api) {
    const key = `${a.method} ${a.route}`
    const r = rows.get(key) ?? { key, route: a.route, method: a.method, requests: 0, failed: 0, cancelled: 0, waits: 0, failures: noFailures(), p50: null, p95: null, requestBytes: 0, responseBytes: 0, t: emptyTimed() }
    rows.set(key, r)
    mergeTimed(r.t, a)
    if (a.outcome === 'waiting') r.waits += a.count
    else if (a.outcome !== 'ok') r.failed += a.count
    if (a.outcome === 'cancelled') r.cancelled += a.count
    countFailure(r.failures, a.outcome, a.count)
    r.requestBytes += a.requestBytes
    r.responseBytes += a.responseBytes
  }
  return [...rows.values()]
    .map(({ t, ...r }) => ({ ...r, requests: t.count, p50: percentile(t, 0.5), p95: percentile(t, 0.95) }))
    .sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
}

export interface ToolRow {
  tool: string
  calls: number
  errors: number
  /** Its failures by kind (HI-2553). */
  failures: FailureCounts
  detail: number
  chars: number
  bytes: number
  avgChars: number
  p95: number | null
}

/** Tool calls grouped by tool (modes, roles and outcomes together), most characters first: what they cost a context. */
export function byTool(mcp: McpSeries[]): ToolRow[] {
  const rows = new Map<string, ToolRow & { t: Timed }>()
  for (const m of mcp) {
    const r = rows.get(m.tool) ?? { tool: m.tool, calls: 0, errors: 0, failures: noFailures(), detail: 0, chars: 0, bytes: 0, avgChars: 0, p95: null, t: emptyTimed() }
    rows.set(m.tool, r)
    mergeTimed(r.t, m)
    if (m.outcome !== 'ok') r.errors += m.count
    countFailure(r.failures, m.outcome, m.count)
    if (m.mode === 'detail') r.detail += m.count
    r.chars += m.chars
    r.bytes += m.bytes
  }
  return [...rows.values()]
    .map(({ t, ...r }) => ({ ...r, calls: t.count, avgChars: t.count ? r.chars / t.count : 0, p95: percentile(t, 0.95) }))
    .sort((a, b) => b.chars - a.chars || a.tool.localeCompare(b.tool))
}

/**
 * The providers in a report (launches and usage), for the provider filter: those with data, and `chosen` (the filter's
 * current choice) even without any, so it can always be seen and changed. The page asks Combwork for every provider's
 * (the filter narrows its own sections only), so picking one never hides the others (#270).
 */
/**
 * The Combwork tool list a start, per role and workflow role (HI-2063): its series merged across projects. Each average is
 * over the starts that measured it (tools and bytes: every start; characters: those of a bridge from HI-2049 on; parts:
 * from HI-2063 on), null where none did (unknown, never zero). `schemaChars` is the rest of the parts' characters: the
 * schemas and the list's structure (names, types, keys, punctuation, escapes).
 */
/** A route's refusals or wrong calls for one reason (HI-2553): the reason's label (REASON_LABEL) and how many. */
export interface ReasonRow {
  key: string
  route: string
  method: string
  kind: 'refused' | 'invalid'
  reason: string
  count: number
}

/** Refusals and wrong calls by route and reason, most first, at most `max` (the series' reasons, merged). */
export function reasonRows(api: ApiSeries[], max = 20): ReasonRow[] {
  const rows = new Map<string, ReasonRow>()
  for (const a of api) {
    if (a.outcome !== 'refused' && a.outcome !== 'invalid') continue
    for (const [reason, n] of Object.entries(a.reasons ?? {})) {
      const key = `${a.method} ${a.route} ${a.outcome} ${reason}`
      const r = rows.get(key) ?? { key, route: a.route, method: a.method, kind: a.outcome, reason, count: 0 }
      r.count += n
      rows.set(key, r)
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, max)
}

export interface ToolListRow {
  /** The CLI the list went to (HI-2553); `unknown` for starts recorded before it. */
  provider: string
  role: CatalogSeries['role']
  workflow: CatalogSeries['workflow']
  starts: number
  tools: number
  bytes: number
  /** What the CLI was given at the start, per start (loadedAtStart); null where that isn't known. */
  upfront: number | null
  chars: number | null
  descriptionChars: number | null
  paramChars: number | null
  schemaChars: number | null
}

export function toolListRows(catalog: CatalogSeries[]): ToolListRow[] {
  const by = new Map<string, CatalogSeries>()
  for (const c of catalog) {
    const provider = c.provider ?? 'unknown'
    const key = `${provider} ${c.role} ${c.workflow ?? 'unknown'}`
    const t = by.get(key) ?? { provider, role: c.role, workflow: c.workflow ?? 'unknown', starts: 0, tools: 0, toolsBytes: 0, toolsChars: 0, charStarts: 0, partStarts: 0, partToolsChars: 0, descriptionChars: 0, paramChars: 0, upfrontStarts: 0, upfrontBytes: 0 }
    for (const k of ['starts', 'tools', 'toolsBytes', 'toolsChars', 'charStarts', 'partStarts', 'partToolsChars', 'descriptionChars', 'paramChars', 'upfrontStarts', 'upfrontBytes'] as const) t[k] += c[k] ?? 0
    by.set(key, t)
  }
  const per = (n: number, of: number): number | null => (of ? n / of : null)
  return [...by.values()].map((t) => {
    const loaded = loadedAtStart(t)
    return {
    provider: t.provider,
    role: t.role,
    workflow: t.workflow,
    starts: t.starts,
    tools: per(t.tools, t.starts) ?? 0,
    bytes: per(t.toolsBytes, t.starts) ?? 0,
    upfront: loaded ? per(loaded.bytes, loaded.starts) : null,
    chars: per(t.toolsChars, t.charStarts),
    descriptionChars: per(t.descriptionChars, t.partStarts),
    paramChars: per(t.paramChars, t.partStarts),
    schemaChars: per(t.partToolsChars - t.descriptionChars - t.paramChars, t.partStarts)
    }
  })
}

export function providersIn(r: MetricsReport, chosen = ''): string[] {
  const ids = new Set<string>()
  for (const p of r.providers) ids.add(p.provider)
  for (const part of partsOf(r, '')) for (const g of part.guidance) ids.add(g.provider)
  if (chosen) ids.add(chosen)
  return [...ids].filter((p) => p !== '(other)').sort()
}

/**
 * A latency percentile as a table sorts it (#305): the percentile, or, when it is past the histogram's last bound
 * (percentile() gives null although there were measurements: shown as "> 10 s"), just past that bound, so it sorts as
 * the slowest; null only with no measurements, which sort last either way.
 */
export function latencyOrder(value: number | null, count: number): number | null {
  if (value !== null) return value
  return count > 0 ? LATENCY_BOUNDS_MS.at(-1)! + 1 : null
}

/** Whether there is anything to show for the selection (else the page says nothing was recorded). */
export function isEmpty(s: PerfSelection): boolean {
  return !s.api.length && !s.mcp.length && !s.guidance.length && !s.catalog.length && !s.providers.length
}
