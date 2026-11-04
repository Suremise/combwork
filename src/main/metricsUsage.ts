import { basename } from 'path'
import type { MetricsQuery, MetricsReport, MetricsRole, ProviderUsageSummary, SafeguardCount } from '../shared/metrics'
import { queryMetrics } from './metrics'
import { METRICS_EXPORT_SCHEMA } from '../shared/benchmark'
import type { SessionListItem } from '../shared/types'
import { sessions } from './sessions'
import { inWorkspace, type WorkspaceService } from './workspace'
import { englishText, type Text } from '../shared/advanced'
import { msg } from '../shared/i18n'

/** Why a report has no provider usage: the window's text; the Agent API's report and its export get the English (#1104). */
const NOTE = {
  scripts: msg({ id: 'performance.providersNote.scripts', defaultMessage: 'Scripts start no sessions, so they have no provider usage.', description: "Performance, under Provider usage with Scripts chosen as whose work: why the table is empty (scripts call Hive's API and run no coding agents)." }),
  assistant: msg({ id: 'performance.providersNote.assistant', defaultMessage: 'The Assistant’s sessions are the workspace’s, not a project’s.', description: "Performance, under Provider usage for a project with the Hive Assistant chosen as whose work: why the table is empty (the Assistant isn't any project's)." })
}

/** Which sessions' usage a report is about: a project's, or the workspace's (all, or its own only), and whose. */
export interface UsageFilter {
  project: string | null
  own?: boolean
  role?: MetricsRole
  provider?: string
}

/**
 * The providers' own reported usage for a metrics report: the sessions active in the range (the Overview's usage, from
 * the usage history, #1106), summed per provider and whose sessions they were (project agents' or the Assistant's). Each
 * session's usage is its cumulative total as the provider reported it, so it is labelled as such; a session with none
 * reported counts as unknown (usage and cost), not zero. A project scope reads that project only; the workspace scope
 * reads every project and the Assistant once each (its own work: the Assistant only), so nothing is counted twice.
 * Scripts have no sessions: their usage is none, and the note says so.
 */
export async function providerUsage(w: WorkspaceService, f: UsageFilter, from: number, to: number): Promise<{ providers: ProviderUsageSummary[]; safeguards?: SafeguardCount[]; note?: Text; unreadable?: number; hosts?: number }> {
  if (f.role === 'api') return { providers: [], note: NOTE.scripts }
  if (f.project && f.role === 'assistant') return { providers: [], note: NOTE.assistant }
  // The workspace as it is now: if it closes (or its window opens another) while this reads, the answer is refused
  // rather than mixing two workspaces' sessions.
  const lifetime = w.lifetime
  const still = (): void => {
    if (lifetime.aborted) throw new Error('The workspace was closed while its metrics were read') // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
  }
  return inWorkspace(w, async () => {
    const all = await w.listProjectPaths()
    still()
    const hosts: { path: string; role: 'agent' | 'assistant' }[] = f.project
      ? all.filter((p) => basename(p).toLowerCase() === f.project!.toLowerCase()).map((path) => ({ path, role: 'agent' as const }))
      : [...(f.own || f.role === 'assistant' ? [] : all.map((path) => ({ path, role: 'agent' as const }))), ...(f.role === 'agent' ? [] : [{ path: w.assistantHome, role: 'assistant' as const }])]
    const by = new Map<string, ProviderUsageSummary & { contextSum: number }>()
    // Safeguard stops per agent and model (#606): whose, by the names the sessions recorded.
    const guards = new Map<string, SafeguardCount>()
    // Hosts whose history couldn't be read: counted (never named), so the totals say they are partial.
    let unreadable = 0
    for (const { path, role } of hosts) {
      const items: SessionListItem[] | null = await sessions.usageItems(path).catch(() => null)
      still()
      if (!items) {
        unreadable++
        continue
      }
      const running = new Set(sessions.projectStates(path).map((st) => st.sessionId).filter(Boolean))
      for (const it of items) {
        if (f.provider && it.provider !== f.provider) continue
        const at = it.usage?.lastActivity ?? it.lastActivity
        const t = at ? Date.parse(at) : NaN
        if (!Number.isFinite(t) || t < from || t >= to) continue
        const key = `${it.provider} ${role}`
        const s = by.get(key) ?? { provider: it.provider, role, sessions: 0, running: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, unknown: 0, requests: 0, compactions: 0, safeguardStops: 0, costUsd: 0, costEstimated: 0, costUnknown: 0, costFree: 0, contextSessions: 0, contextAvgTokens: 0, contextMaxTokens: 0, contextWindow: null, contextSum: 0 }
        by.set(key, s)
        s.sessions++
        if (running.has(it.id)) s.running++
        const u = it.usage
        if (!u) {
          // Nothing reported: its usage and its cost are unknown, not zero.
          s.unknown++
          s.costUnknown++
          continue
        }
        s.inputTokens += u.inputTokens
        s.outputTokens += u.outputTokens
        s.cacheReadTokens += u.cacheReadTokens
        s.cacheWriteTokens += u.cacheWriteTokens
        s.reasoningTokens += u.reasoningTokens
        s.requests += u.requests
        s.compactions += u.compactions.length
        for (const [model, stops] of Object.entries(u.safeguards ?? {})) {
          if (!(stops > 0)) continue
          s.safeguardStops += stops
          // agent-protocol: a name in the metrics report and its export (the Assistant's row)
          const project = role === 'assistant' ? 'Assistant' : basename(path) // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
          const agent = role === 'assistant' ? 'Assistant' : (it.agentName ?? it.agentId ?? 'unknown agent') // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
          const k = JSON.stringify([project, agent, it.provider, model])
          const g = guards.get(k) ?? { project, agent, provider: it.provider, role, model, stops: 0 }
          g.stops += stops
          guards.set(k, g)
        }
        // Free (HI-1772): $0 known, counted apart.
        if (u.costFree) s.costFree = (s.costFree ?? 0) + 1
        else if (u.costUsd === null) s.costUnknown++
        else {
          s.costUsd += u.costUsd
          if (u.costEstimated) s.costEstimated++
        }
        if (u.contextTokens > 0) {
          s.contextSessions++
          s.contextSum += u.contextTokens
          s.contextMaxTokens = Math.max(s.contextMaxTokens, u.contextTokens)
        }
        if (u.contextWindow) s.contextWindow = Math.max(s.contextWindow ?? 0, u.contextWindow)
      }
    }
    const safeguards = [...guards.values()].sort((a, b) => b.stops - a.stops || a.project.localeCompare(b.project) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model))
    return { providers: [...by.values()].map(({ contextSum, ...s }) => ({ ...s, contextAvgTokens: s.contextSessions ? Math.round(contextSum / s.contextSessions) : 0 })), ...(safeguards.length ? { safeguards } : {}), ...(unreadable ? { unreadable, hosts: hosts.length } : {}) }
  })
}

/** A metrics report (metrics.ts) with the providers' reported usage added (sessions active in its range, filtered as it is). */
export async function metricsReport(w: WorkspaceService, q: MetricsQuery): Promise<MetricsReport> {
  const r = queryMetrics(w, q)
  const usage = await providerUsage(w, { project: r.scope.kind === 'project' ? r.scope.project : null, own: r.filters.own, role: r.filters.role, provider: r.filters.provider }, Date.parse(r.from), Date.parse(r.to))
  // agent-stored: metricsForAgents says the note for the agent reading the report (servers.ts)
  return { ...r, providers: usage.providers, ...(usage.safeguards ? { safeguards: usage.safeguards } : {}), ...(usage.note ? { providersNote: englishText(usage.note), providersNoteText: usage.note } : {}), ...(usage.unreadable ? { providersUnreadable: usage.unreadable, providersHosts: usage.hosts } : {}) } // agent-text: providerUsage
}

/** Safeguard counts with their project and agent names replaced (an export's sanitize). */
function sanitizeAgents(rows: SafeguardCount[], project: (name: string) => string): SafeguardCount[] {
  const agents = new Map<string, string>()
  const agent = (name: string): string => {
    const k = name.toLowerCase()
    if (!agents.has(k)) agents.set(k, `agent-${agents.size + 1}`)
    return agents.get(k)!
  }
  return rows.map((g) => ({ ...g, project: g.role === 'assistant' ? g.project : project(g.project), agent: g.role === 'assistant' ? g.agent : agent(g.agent) }))
}

/** The export's format (shared/benchmark.ts reads it back): a version a reader can check. */
export { METRICS_EXPORT_SCHEMA }

/**
 * A report as an export file (Performance → Export): the report itself, made with the page's filters, with what a
 * reader needs to read it: schema, Hive's version, units, and (also in the report) the filters, what they couldn't
 * narrow, the coverage (when Hive was recording) and what isn't measured. `sanitize`: project names become project-1,
 * project-2… (the same name the same number) and the workspace's path is left out.
 */
export function metricsExport(r: MetricsReport, appVersion: string, sanitize: boolean): Record<string, unknown> {
  const units = {
    bytes: 'UTF-8 bytes',
    chars: 'characters as UTF-16 code units (JavaScript string length)', // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
    ms: 'milliseconds, monotonic clock', // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
    // agent-protocol: the metrics export's fixed definition of a unit, read by scripts
    tokens: 'as the provider reported them; Combwork estimates none', // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
    costUsd: 'API-equivalent cost in US dollars, reported or estimated (not a bill)' // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
  }
  let report: MetricsReport = r
  if (sanitize) {
    const names = new Map<string, string>()
    const alias = (name: string): string => {
      const k = name.toLowerCase()
      if (!names.has(k)) names.set(k, `project-${names.size + 1}`)
      return names.get(k)!
    }
    report = {
      ...r,
      workspacePath: '',
      scope: r.scope.kind === 'project' ? { kind: 'project', project: alias(r.scope.project) } : r.scope,
      projects: Object.fromEntries(Object.entries(r.projects).map(([name, part]) => [alias(name), part])),
      // Agents' names are the user's too: agent-1, agent-2… (the same name the same number).
      ...(r.safeguards ? { safeguards: sanitizeAgents(r.safeguards, alias) } : {})
    }
  }
  // agent-protocol: the app's name in the metrics export (HI-2463)
  return { schema: METRICS_EXPORT_SCHEMA, app: { name: 'Combwork', version: appVersion }, exportedAt: new Date().toISOString(), sanitized: sanitize, units, range: { from: r.from, to: r.to }, filters: r.filters, coverage: r.coverage, report } // i18n-ignore: the Agent API's metrics report and its export, in English (mixed audience: the Performance view gets messages with E10a's pattern)
}
