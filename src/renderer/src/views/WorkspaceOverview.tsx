import { Children, useCallback, useEffect, useMemo, useRef } from 'react'
import type { ProjectInfo, SessionListItem } from '@shared/types'
import { PROVIDERS, isProviderEnabled } from '@shared/providers'
import { usesOwnPrices } from '@shared/prices'
import { PERIODS, activeIn, costText, periodFrom, stackedDaily, sumUsage, totalTokens, type DayTotal, type UsageGroup } from '@shared/usageTotals'
import { call, errorMessage } from '../api'
import { oneAtATime, withinTime } from '@shared/coalesce'
import { selectProject } from '../actions'
import { get, revealAgent, set, setAssistantOpen, setProjectTab, showView, useLanguage, useStore } from '../store'
import { cx, formatNumber, formatTokens, timeAgo } from '../util'
import { useNow } from '../usage'
import { Icon, IconButton, InfoTip, LoadFailed, StaleNote, Tooltip } from '../components/ui'
import { AssistantMark } from '../components/AssistantMark'
import { ProviderIcon } from '../components/ProviderIcon'
import { TaskStrip } from '../components/Board'
import { DataTable, type DataColumn } from '../components/DataTable'
import { PlanLimits, RunningAgent } from './ProjectTabs'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { formatDayLabel } from '@shared/dates'

/** Live updates come at most this often (the usage history has running sessions about every minute, #1106). */
const LIVE_REFRESH_MS = 15_000
/** A load with no answer by then shows as failed, with Retry (#1646). */
const LOAD_LIMIT_MS = 60_000

/** A running agent's project in its label (HI-1679): dropped first in a narrow row, so the agent's name stays whole. */
const projectPart = (c: React.ReactNode[]): React.ReactNode => <span className="running-project">{c}</span>

const M = {
  noAnswer: msg({ id: 'workspace.overview.noAnswer', defaultMessage: 'no answer after {seconds, number} s', description: "Why the workspace's usage could not be loaded: Hive read it for this long without finishing. Shown as {error} in \"Could not load {what}: {error}\", with Retry." }),
  costTip: msg({ id: 'workspace.overview.costTip', defaultMessage: 'What this work would have cost at API prices: reported by the provider where it does (Claude Code), else estimated by Combwork from token counts and the prices in Settings → the provider. On a subscription you are not charged this; it shows how heavy the work was.', description: "The Workspace Overview: tooltip on API-equivalent cost." }),
  assistant: msg({ id: 'workspace.overview.assistant', defaultMessage: 'Assistant', description: "The Workspace Overview: the Hive Assistant's row and series (beside the projects)." }),
  chartLabel: msg({ id: 'workspace.overview.chartLabel', defaultMessage: 'Tokens per day by project', description: "The Workspace Overview's chart, for screen readers." }),
  dayTip: msg({ id: 'workspace.overview.dayTip', defaultMessage: '<b>{day}</b>: {tokens} tokens · {cost} · {prompts, plural, one {# prompt} other {# prompts}}', description: 'Tooltip on a day of the chart: {tokens} like 1.2M; {cost} a cost. <b> is bold.' }),
  today: msg({ id: 'workspace.overview.today', defaultMessage: 'Today', description: "The end of the chart's day axis." }),
  project: msg({ id: 'workspace.overview.colProject', defaultMessage: 'Project', description: "The Workspace Overview's table by project: a column." }),
  sessions: msg({ id: 'workspace.overview.colSessions', defaultMessage: 'Sessions', description: "The Workspace Overview's table by project: a column; and a figure's title." }),
  tokens: msg({ id: 'workspace.overview.colTokens', defaultMessage: 'Tokens', description: "The Workspace Overview's table by project: a column; and a figure's title." }),
  cost: msg({ id: 'workspace.overview.colCost', defaultMessage: 'Cost', description: "The Workspace Overview's table by project: a column (at API prices)." }),
  share: msg({ id: 'workspace.overview.colShare', defaultMessage: 'Share', description: "The Workspace Overview's table by project: a column (its share of the tokens)." }),
  lastActive: msg({ id: 'workspace.overview.colLastActive', defaultMessage: 'Last active', description: "The Workspace Overview's table by project: a column." }),
  shareSmall: msg({ id: 'workspace.overview.shareSmall', defaultMessage: '< {share, number, ::percent}', description: "The table's Share when it is under 1% (\"< 1%\")." }),
  noWorkspace: msg({ id: 'workspace.overview.noWorkspace', defaultMessage: 'Open a workspace to see its overview.', description: 'The Workspace Overview with no workspace open.' }),
  loadTarget: msg({ id: 'workspace.overview.loadTarget', defaultMessage: "the workspace's usage", description: 'What could not be loaded: shown in "Could not load {what}: {error}", with Retry.' }),
  refreshTarget: msg({ id: 'workspace.overview.refreshTarget', defaultMessage: 'the usage', description: 'What could not be refreshed while the figures shown stay on screen: shown in "Could not refresh {what}; last updated …", with Retry.' }),
  loading: msg({ id: 'workspace.overview.loading', defaultMessage: 'Loading…', description: "The Workspace Overview while it reads the projects' usage." }),
  title: msg({ id: 'workspace.overview.title', defaultMessage: 'Workspace Overview', description: "The Workspace Overview's heading, and its sidebar's." }),
  subtitle: msg({ id: 'workspace.overview.subtitle', defaultMessage: 'What every project and the Assistant used, what runs now, and the board at a glance.', description: "The Workspace Overview, under its heading." }),
  summary: msg({ id: 'workspace.overview.summary', defaultMessage: 'Summary', description: "The Workspace Overview: the heading over the period's figures." }),
  updated: msg({ id: 'workspace.overview.updated', defaultMessage: 'Updated {when}. How often it updates: Settings → Sessions → Overview updates.', description: 'Tooltip on Refresh ({when}: "4 minutes ago"). Keep the setting\'s path as Settings shows it.' }),
  refresh: msg({ id: 'workspace.overview.refresh', defaultMessage: 'Refresh', description: 'The Workspace Overview: reads the usage again.' }),
  period: msg({ id: 'workspace.overview.period', defaultMessage: 'Period', description: 'The period buttons (Today, 7 days…), for screen readers.' }),
  byDay: msg({ id: 'workspace.overview.byDay', defaultMessage: 'Every project and the Assistant, by calendar day: a session that ran over several days counts only its part in the period.', description: "The Workspace Overview, under Summary." }),
  tokensSub: msg({ id: 'workspace.overview.tokensSub', defaultMessage: '{input} in · {cached} cached · {output} out', description: 'Under Tokens: new input (with cache writes), read from cache, and output (like 1.2M).' }),
  tokensTip: msg({ id: 'workspace.overview.tokensTip', defaultMessage: 'All tokens: new input, cache writes, input read from cache, and output.', description: 'Tooltip on Tokens.' }),
  apiCost: msg({ id: 'workspace.overview.apiCost', defaultMessage: 'API-equivalent cost', description: "A figure's title: what the work would have cost at API prices." }),
  withoutPrice: msg({ id: 'workspace.overview.withoutPrice', defaultMessage: '{count, plural, one {# session without a price} other {# sessions without a price}}', description: 'Under API-equivalent cost: sessions whose model has no known price.' }),
  partlyEstimated: msg({ id: 'workspace.overview.partlyEstimated', defaultMessage: 'partly estimated', description: 'Under API-equivalent cost. Lower case.' }),
  asReported: msg({ id: 'workspace.overview.asReported', defaultMessage: 'as reported', description: 'Under API-equivalent cost: the provider reported it. Lower case.' }),
  estimated: msg({ id: 'workspace.overview.estimated', defaultMessage: 'estimated', description: 'Under API-equivalent cost: Hive worked it out from prices. Lower case.' }),
  runningNow: msg({ id: 'workspace.overview.runningNowSub', defaultMessage: '{count} running now', description: 'Under Sessions: agents running now.' }),
  prompts: msg({ id: 'workspace.overview.prompts', defaultMessage: 'Prompts', description: "A figure's title: prompts sent." }),
  compactions: msg({ id: 'workspace.overview.compactions', defaultMessage: '{count, plural, one {# compaction} other {# compactions}}', description: 'Under Prompts: how many times sessions were compacted.' }),
  runningHeading: msg({ id: 'workspace.overview.runningHeading', defaultMessage: 'Running now', description: "The Workspace Overview: the heading over the agents running now." }),
  agentLabel: msg({ id: 'workspace.overview.agentLabel', defaultMessage: '<in>{project} · </in>{agent}', description: 'A running agent in the Workspace Overview: its project and name. <in>…</in> holds the project part (keep the tags around it, with its separator): in a narrow row it is dropped first, so the agent’s name stays whole.' }),
  byProject: msg({ id: 'workspace.overview.byProject', defaultMessage: 'By project', description: "The Workspace Overview: the heading over the table by project." }),
  openAssistant: msg({ id: 'workspace.overview.openAssistant', defaultMessage: 'Open the Assistant view', description: "The table by project: the Assistant's row, for screen readers." }),
  openProject: msg({ id: 'workspace.overview.openProject', defaultMessage: "Open {project}'s Overview", description: "The table by project: a project's row, for screen readers." }),
  nothingUsed: msg({ id: 'workspace.overview.nothingUsed', defaultMessage: 'Nothing used in this period.', description: 'The table by project when nothing was used.' }),
  hidden: msg({ id: 'workspace.overview.hidden', defaultMessage: "{count, plural, one {# hidden or removed project isn't counted} other {# hidden or removed projects aren't counted}} (Settings → Workspace).", description: 'Under the table by project.' }),
  turnedOff: msg({ id: 'workspace.overview.turnedOff', defaultMessage: '— turned off', description: "Beside a coding agent's heading when it is turned off in Settings (its past use still shows)." }),
  outputSub: msg({ id: 'workspace.overview.outputSub', defaultMessage: '{tokens} output', description: "Under a coding agent's Tokens (like 1.2M)." }),
  withoutPriceShort: msg({ id: 'workspace.overview.withoutPriceShort', defaultMessage: '{count, number} without a price', description: "Under a coding agent's API-equivalent cost: sessions whose model has no known price." }),
  promptsSub: msg({ id: 'workspace.overview.promptsSub', defaultMessage: '{count, plural, one {# prompt} other {# prompts}}', description: "Under a coding agent's Sessions: prompts sent." }),
  panelTip: msg({ id: 'workspace.overview.panelTip', defaultMessage: 'What each project used in the period chosen in the overview. Click one for its own Overview.', description: "The Workspace Overview's sidebar: tooltip on its heading." }),
  importing: msg({ id: 'workspace.overview.importing', defaultMessage: 'Importing the usage history: {done, number} of {total, plural, one {# session} other {# sessions}}. The figures are partial until it is done.', description: "The Workspace Overview while Hive records, once, what the workspace's existing sessions used ({done} of {total} so far)." }),
  importingStart: msg({ id: 'workspace.overview.importingStart', defaultMessage: 'Importing the usage history. The figures are partial until it is done.', description: "The Workspace Overview while Hive starts recording, once, what the workspace's existing sessions used (before it has counted them)." }),
  rowTip: msg({ id: 'workspace.overview.rowTip', defaultMessage: '{tokens} tokens · {sessions, plural, one {# session} other {# sessions}}{running, plural, =0 {} other { · # running}}', description: "The Workspace Overview's sidebar: tooltip on a project ({tokens} like 1.2M)." })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

/**
 * Loads the workspace's usage into the store while the Workspace Overview is shown. Updates follow Settings →
 * Sessions → Overview updates, like the project Overview: live (as sessions change, at most every 15 s), every
 * minute, or only on Refresh. Main reads each project's session records and their usage history (#1106): no transcript.
 */
function useWorkspaceUsage(): () => void {
  const mode = useStore((s) => s.settings?.sessions.overviewRefresh ?? 'live')
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  // A string, so the selector returns nothing new while nothing changed. The usage history's import going on (#1106)
  // counts as a change: its figures fill in.
  const liveKey = useStore(
    (s) =>
      `${Object.values(s.usageVersion).join(',')}|${[...(s.workspace?.projects ?? []), ...(s.workspace?.assistant ? [s.workspace.assistant] : [])]
        .flatMap((p) => p.agents.map((a) => `${a.live?.sessionId ?? ''}:${a.live?.status ?? ''}`))
        .join(',')}|${s.workspaceUsage?.history.done ?? ''}`
  )
  const last = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One load at a time (#1646): one slower than the updates asking for it is still shown.
  const serial = useRef(oneAtATime())
  const latest = useRef<() => void>(() => undefined)
  const load = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    last.current = Date.now()
    const asked = get().workspace?.path ?? ''
    serial.current.run(
      asked,
      () =>
        withinTime(call('workspace:usage'), LOAD_LIMIT_MS, () => tr(M.noAnswer, { seconds: LOAD_LIMIT_MS / 1000 }))
          .then((u) => {
            // Another workspace in this window meanwhile: not this one's to show.
            if (u.workspacePath !== get().workspace?.path) return
            set({ workspaceUsage: u, workspaceUsageAt: Date.now(), workspaceUsageError: null })
          })
          // Said in the view (in place of the figures, or over the last ones), not a toast on every live refresh.
          .catch((e) => asked === get().workspace?.path && set({ workspaceUsageError: { workspacePath: asked, error: errorMessage(e) } })),
      () => latest.current()
    )
  }, [])
  latest.current = load
  useEffect(() => {
    load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [load, wsPath])
  useEffect(() => {
    if (mode !== 'live' || !last.current) return
    const wait = last.current + LIVE_REFRESH_MS - Date.now()
    if (wait <= 0) load()
    else if (!timer.current) timer.current = setTimeout(load, wait)
  }, [liveKey, mode, load])
  // The usage history's import ending (#1106): the figures, complete now, whatever the update setting.
  const importing = useStore((s) => s.workspaceUsage?.history.importing ?? false)
  const wasImporting = useRef(false)
  useEffect(() => {
    if (wasImporting.current && !importing) load()
    wasImporting.current = importing
  }, [importing, load])
  useEffect(() => {
    if (mode !== 'minute') return
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [mode, load])
  return load
}

/** The groups the overview adds up: each project, then the Assistant. */
function usageGroups(): UsageGroup[] {
  const u = get().workspaceUsage
  if (!u) return []
  return [...u.projects.map((p) => ({ key: p.path, label: p.name, items: p.items })), ...(u.assistant.length ? [{ key: 'assistant', label: tr(M.assistant), items: u.assistant }] : [])]
}

function openProjectOverview(path: string): void {
  if (path === 'assistant') return showView('assistant')
  selectProject(path)
  setProjectTab(path, 'overview')
}

/** The workspace's last activity in a group's sessions. */
const lastActive = (items: SessionListItem[]): string | null => items.reduce<string | null>((m, s) => (s.lastActivity && (!m || s.lastActivity > m) ? s.lastActivity : m), null)

export function Card({ title, value, sub, tip, accent }: { title: string; value: React.ReactNode; sub?: React.ReactNode; tip?: string; accent?: boolean }) {
  return (
    <div className={cx('card', accent && 'accent')}>
      <h3>
        {title} {tip && <InfoTip text={tip} />}
      </h3>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}


/** Tokens per day, stacked by project (the top six, the rest as Other); hover a day for its numbers. */
function StackedChart({ series, days }: { series: { key: string; label: string }[]; days: (DayTotal & { parts: number[] })[] }) {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const label = (day: string): string => formatDayLabel(`${day}T12:00:00`)
  const colour = (i: number): string => (series[i].key ? `var(--series-${i + 1})` : 'var(--series-other)')
  return (
    <div className="daily-chart">
      <div className="daily-bars" role="img" aria-label={tr(M.chartLabel)}>
        {days.map((d) => (
          <Tooltip
            key={d.day}
            content={
              <div className="stack-tip">
                <div>{Children.toArray(tRich<React.ReactNode>(M.dayTip, { day: label(d.day), tokens: formatTokens(d.tokens), cost: costText(d), prompts: d.prompts, b: bold }))}</div>
                {series.map((s, i) =>
                  d.parts[i] ? (
                    <div key={s.key || 'other'} className="stack-tip-row">
                      <span className="swatch" style={{ background: colour(i) }} /> {s.label}: {formatTokens(d.parts[i])}
                    </div>
                  ) : null
                )}
              </div>
            }
          >
            <div className="daily-col">
              <div className="stack-bar" style={{ height: `${d.tokens ? Math.max(3, (d.tokens / max) * 100) : 0}%` }}>
                {d.parts.map((v, i) => (v ? <div key={i} className="stack-part" style={{ flexGrow: v, background: colour(i) }} /> : null))}
              </div>
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="daily-axis">
        <span>{label(days[0].day)}</span>
        <span>{tr(M.today)}</span>
      </div>
      <div className="stack-legend">
        {series.map((s, i) => (
          <span key={s.key || 'other'}>
            <span className="swatch" style={{ background: colour(i) }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/** A row of the table by project: a project (or the Assistant) and what it used in the period. */
interface ProjectRow {
  g: UsageGroup
  t: ReturnType<typeof sumUsage>
  tokens: number
  last: string | null
}
const BIGGEST_FIRST = { key: 'tokens', desc: true }

/** The table by project's columns; `all` is every project's tokens, for each one's share. */
function projectColumns(all: number): DataColumn<ProjectRow>[] {
  return [
    { key: 'name', header: tr(M.project), cell: (r) => (r.g.key === 'assistant' ? <span className="muted overview-assistant"><AssistantMark /> {tr(M.assistant)}</span> : r.g.label), sortValue: (r) => r.g.label.toLowerCase(), filter: { kind: 'text', value: (r) => r.g.label } },
    { key: 'sessions', header: tr(M.sessions), num: true, descFirst: true, cell: (r) => r.t.sessions, sortValue: (r) => r.t.sessions },
    { key: 'tokens', header: tr(M.tokens), num: true, descFirst: true, cell: (r) => formatTokens(r.tokens), sortValue: (r) => r.tokens },
    { key: 'cost', header: tr(M.cost), num: true, descFirst: true, cell: (r) => (r.t.sessions ? costText(r.t) : '—'), sortValue: (r) => (r.t.sessions ? r.t.cost : null) },
    {
      key: 'share',
      header: tr(M.share),
      num: true,
      cell: (r) => {
        const share = all ? (r.tokens / all) * 100 : 0
        return (
          <>
            <span className="share">
              <span className="share-bar" style={{ width: `${share}%` }} />
            </span>
            {r.tokens ? (share < 1 ? tr(M.shareSmall, { share: 0.01 }) : fmt.number(Math.round(share) / 100, { style: 'percent' })) : '—'}
          </>
        )
      }
    },
    { key: 'last', header: tr(M.lastActive), num: true, descFirst: true, className: 'faint', cell: (r) => (r.last ? timeAgo(r.last) : '—'), sortValue: (r) => r.last }
  ]
}

/** The Workspace Overview (activity bar): the whole workspace's usage for a period, what runs now, each project and provider. */
export function WorkspaceOverviewView() {
  const reload = useWorkspaceUsage()
  const usage = useStore((s) => s.workspaceUsage)
  const loadedAt = useStore((s) => s.workspaceUsageAt)
  const failed = useStore((s) => (s.workspaceUsageError && s.workspaceUsageError.workspacePath === s.workspace?.path ? s.workspaceUsageError.error : null))
  const period = useStore((s) => s.overviewPeriod)
  const workspace = useStore((s) => s.workspace)
  const settings = useStore((s) => s.settings)
  const now = useNow(60000)
  // The groups' labels are worded here (the Assistant's): made again when the language changes, as when the usage does.
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => (usage ? usageGroups() : []), [usage, language])
  if (!workspace) return <div className="empty-state">{tr(M.noWorkspace)}</div>
  if (!usage || usage.workspacePath !== workspace.path) {
    if (failed) return <LoadFailed what={tr(M.loadTarget)} error={failed} onRetry={reload} />
    return (
      <div className="empty-state">
        <Icon name="loading" spin />
        {tr(M.loading)}
      </div>
    )
  }

  const from = periodFrom(period, now)
  const all = groups.flatMap((g) => g.items)
  const inPeriod = activeIn(all, from)
  const total = sumUsage(inPeriod, from)
  const hosts: ProjectInfo[] = [...workspace.projects, ...(workspace.assistant ? [workspace.assistant] : [])]
  const running = hosts.flatMap((p) => p.agents.filter((a) => a.live && !a.live.settingUp).map((a) => ({ p, a })))
  const used = new Set([...inPeriod.map((i) => i.provider), ...running.map((r) => r.a.live!.provider)])
  const providers = PROVIDERS.filter((p) => used.has(p.id) || isProviderEnabled(settings, p.id))
  const all$ = totalTokens(total)

  // By name first, so projects that used the same keep that order whichever column sorts them.
  const rows: ProjectRow[] = groups
    .map((g) => {
      const t = sumUsage(g.items, from)
      return { g, t, tokens: totalTokens(t), last: lastActive(g.items) }
    })
    .sort((a, b) => a.g.label.localeCompare(b.g.label))
  const stack = from && period !== 'today' ? stackedDaily(groups, from, now) : null

  return (
    <div className="scroll-page overview-page">
      <div className="page-narrow">
        <div className="board-header">
          <h1>{tr(M.title)}</h1>
          <span className="faint">{tr(M.subtitle)}</span>
        </div>
        <TaskStrip project={null} />
        <div className="overview-head">
          <h2 className="section">{tr(M.summary)}</h2>
          <Tooltip content={tr(M.updated, { when: timeAgo(new Date(loadedAt).toISOString()) })}>
            <span>
              <IconButton icon="refresh" title={tr(M.refresh)} onClick={reload} />
            </span>
          </Tooltip>
          <div className="grow" />
          <div className="segmented" role="group" aria-label={tr(M.period)}>
            {PERIODS.map((p) => (
              <button key={p.value} className={cx(period === p.value && 'active')} onClick={() => set({ overviewPeriod: p.value })}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {failed && <StaleNote what={tr(M.refreshTarget)} error={failed} at={loadedAt} onRetry={reload} />}
        <p className="hint">{tr(M.byDay)}</p>
        {usage.history.importing && (
          <p className="hint overview-importing" role="status">
            <Icon name="loading" spin /> {usage.history.total ? tr(M.importing, { done: usage.history.done, total: usage.history.total }) : tr(M.importingStart)}
          </p>
        )}
        <div className="cards">
          <Card accent title={tr(M.tokens)} value={formatTokens(all$)} sub={tr(M.tokensSub, { input: formatTokens(total.input + total.cacheWrite), cached: formatTokens(total.cached), output: formatTokens(total.output) })} tip={tr(M.tokensTip)} />
          <Card title={tr(M.apiCost)} value={costText(total)} sub={total.unpriced ? tr(M.withoutPrice, { count: total.unpriced }) : tr(total.estimated ? M.partlyEstimated : M.asReported)} tip={tr(M.costTip)} />
          <Card title={tr(M.sessions)} value={formatNumber(total.sessions)} sub={tr(M.runningNow, { count: running.length })} />
          <Card title={tr(M.prompts)} value={formatNumber(total.prompts)} sub={tr(M.compactions, { count: total.compactions })} />
        </div>
        {stack && stack.series.length > 0 && <StackedChart series={stack.series} days={stack.days} />}

        {running.length > 0 && (
          <>
            <h2 className="section">{tr(M.runningHeading)}</h2>
            <div className="running-list">
              {running.map(({ p, a }) => {
                const isAssistant = p.path === workspace.assistant?.path
                return (
                  <RunningAgent
                    key={`${p.path}#${a.id}`}
                    project={p}
                    a={a}
                    label={isAssistant ? tr(M.assistant) : Children.toArray(tRich<React.ReactNode>(M.agentLabel, { project: p.name, agent: a.name, in: projectPart }))}
                    assistant={isAssistant}
                    onOpen={() => {
                      if (isAssistant) return setAssistantOpen(true)
                      selectProject(p.path)
                      revealAgent(p, a.id)
                    }}
                  />
                )
              })}
            </div>
          </>
        )}

        <h2 className="section">{tr(M.byProject)}</h2>
        <DataTable
          id="ws-projects"
          className="ws-projects"
          rows={rows}
          columns={projectColumns(all$)}
          rowKey={(r) => r.g.key}
          defaultSort={BIGGEST_FIRST}
          filterFrom={10}
          onRowClick={(r) => openProjectOverview(r.g.key)}
          rowLabel={(r) => (r.g.key === 'assistant' ? tr(M.openAssistant) : tr(M.openProject, { project: r.g.label }))}
          empty={tr(M.nothingUsed)}
        />
        {usage.hidden > 0 && <p className="hint">{tr(M.hidden, { count: usage.hidden })}</p>}

        {providers.map((p) => {
          const t = sumUsage(inPeriod.filter((i) => i.provider === p.id), from)
          return (
            <div key={p.id}>
              <h2 className="section">
                <ProviderIcon provider={p.id} /> {p.name}
                {!isProviderEnabled(settings, p.id) && <span className="muted" style={{ fontWeight: 400 }}> {tr(M.turnedOff)}</span>}
              </h2>
              <div className="cards">
                <Card title={tr(M.tokens)} value={formatTokens(totalTokens(t))} sub={tr(M.outputSub, { tokens: formatTokens(t.output) })} />
                <Card title={tr(M.apiCost)} value={costText(t)} sub={t.unpriced ? tr(M.withoutPriceShort, { count: t.unpriced }) : tr(!t.estimated ? M.asReported : p.capabilities.reportsCost && !usesOwnPrices(p.id, settings) ? M.partlyEstimated : M.estimated)} tip={tr(M.costTip)} />
                <Card title={tr(M.sessions)} value={formatNumber(t.sessions)} sub={tr(M.promptsSub, { count: t.prompts })} />
              </div>
              <PlanLimits provider={p.id} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The Workspace Overview's sidebar: each project with what it used in the period; click opens its Overview. */
export function WorkspaceOverviewPanel() {
  const usage = useStore((s) => s.workspaceUsage)
  const period = useStore((s) => s.overviewPeriod)
  const workspace = useStore((s) => s.workspace)
  const now = useNow(60000)
  const from = periodFrom(period, now)
  // Another workspace's figures (opened in this window before) aren't this one's: none until this one's load.
  const mine = !!usage && usage.workspacePath === workspace?.path
  // As the overview's: the Assistant's label follows a change of language.
  const language = useLanguage()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => (mine && usage ? usageGroups() : []), [usage, mine, language])
  const live = (key: string): number => [...(workspace?.projects ?? []), ...(workspace?.assistant ? [workspace.assistant] : [])].find((p) => (key === 'assistant' ? p.path === workspace?.assistant?.path : p.path === key))?.agents.filter((a) => a.live).length ?? 0
  return (
    <>
      <div className="pane-header">
        {tr(M.title)}
        <InfoTip text={tr(M.panelTip)} />
      </div>
      <div className="pane-body">
        <div className="section-header">{PERIODS.find((p) => p.value === period)?.label}</div>
        {groups.map((g) => {
          const t = sumUsage(g.items, from)
          const n = live(g.key)
          return (
            <Tooltip key={g.key} block content={tr(M.rowTip, { tokens: formatTokens(totalTokens(t)), sessions: t.sessions, running: n })}>
              <div className="row" style={{ flex: 1 }} onClick={() => openProjectOverview(g.key)}>
                {g.key === 'assistant' ? <AssistantMark /> : <Icon name="folder" />} <span className="label">{g.label}</span>
                {n > 0 && <span className="dot working" />}
                <span className="count">{t.sessions ? costText(t) : ''}</span>
              </div>
            </Tooltip>
          )
        })}
        {!usage && <div className="pane-empty faint">{tr(M.loading)}</div>}
      </div>
    </>
  )
}
