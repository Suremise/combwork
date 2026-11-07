import type { PlanLimit, PlanUsage, ProviderId, TaskCard, WorkspaceInfo } from '@shared/types'
import { useNow } from '../usage'
import { runCommand } from '../commands'
import { setActivity, set, setProgressOpen, useStore, type Activity } from '../store'
import { useTeamPaused } from './TeamPause'
import { useTeamPause } from '../teamPause'
import { enabledProviders, installSourceText, providerDescriptor } from '@shared/providers'
import { ProviderIcon } from './ProviderIcon'
import { cx, formatKeybinding, resetsIn, timeAgo } from '../util'
import { commandKeybinding } from '../commands'
import { AssistantMark } from './AssistantMark'
import { Icon, Tooltip } from './ui'
import { UpdateStatusItem } from './Updates'
import { asksYou } from '@shared/inbox'
import { InboxStatusItem } from './Inbox'
import { keepAwakeText } from '@shared/keepAwake'
import { GIT_MIN, gitFixText, gitProblemText } from '@shared/gitTool'
import { useInbox } from '../inbox'
import { useForYou } from '../forYou'
import { GitStatusBarItem } from '../views/GitTab'
import { AGENT_LIMIT_MAX } from '@shared/defaults'
import { AgentRowsTable, CARD_COLUMN, PROJECT_COLUMN, STATE_COLUMN, WAITING_COLUMN, agentRow, tableText, type AgentTableData, type AgentTableRow } from './AgentsTable'
import { limitName, limitWindow } from '@shared/planLimits'
import { useConnections, useProviderWarnings } from './ConnectionChoice'
import { connectionsApply, planUsageItems } from '@shared/accounts'
import { useConnectionsInUse } from '../connectionUsage'
import { fmt, msg, tr, type Msg } from '@shared/i18n'

const M = {
  projects: msg({ id: 'workspace.activity.projects', defaultMessage: 'Projects', description: 'The activity bar (left edge): the Projects view.' }),
  overview: msg({ id: 'workspace.activity.overview', defaultMessage: 'Workspace Overview', description: 'The activity bar (left edge): the Workspace Overview.' }),
  activity: msg({ id: 'workspace.activity.activity', defaultMessage: 'Activity', description: "The activity bar (left edge): the Activity view (what every project's agents run now, HI-1664)." }),
  performance: msg({ id: 'workspace.activity.performance', defaultMessage: 'Performance', description: "The activity bar (left edge): the Performance view (how agents' turns perform)." }),
  board: msg({ id: 'workspace.activity.board', defaultMessage: 'Task Board', description: 'The activity bar (left edge): the task board.' }),
  notes: msg({ id: 'workspace.activity.notes', defaultMessage: 'Shared Notes', description: 'The activity bar (left edge): the workspace\'s shared notes.' }),
  skills: msg({ id: 'workspace.activity.skills', defaultMessage: 'Skills', description: "The activity bar (left edge): the workspace's Combwork skills." }),
  dialects: msg({ id: 'workspace.activity.dialects', defaultMessage: 'Dialects', description: "The activity bar (left edge): the Dialects view (HI-2444), where the wording Combwork gives agents is tuned per model and CLI. Glossary: dialect." }),
  templates: msg({ id: 'workspace.activity.templates', defaultMessage: 'Templates', description: "The activity bar (left edge): agent templates." }),
  mcp: msg({ id: 'workspace.activity.mcp', defaultMessage: 'MCP Servers', description: "The activity bar (left edge): the workspace's MCP servers." }),
  assistant: msg({ id: 'workspace.activity.assistant', defaultMessage: 'Assistant', description: "The activity bar (left edge): the Combwork Assistant's view. Combwork's name stays as it is." }),
  docs: msg({ id: 'workspace.activity.docs', defaultMessage: 'Documentation', description: "The activity bar (left edge): Combwork's documentation." }),
  settings: msg({ id: 'workspace.activity.settings', defaultMessage: 'Settings', description: "The activity bar (left edge): Combwork's settings." }),
  withKey: msg({ id: 'workspace.activity.withKey', defaultMessage: '{label} ({key})', description: 'Tooltip on an activity bar button: its name and its shortcut ({key}: "Ctrl+Shift+E").' }),
  notifications: msg({ id: 'workspace.activity.notifications', defaultMessage: 'Notifications', description: 'The activity bar: the button that shows the notifications.' }),
  notificationsTip: msg({ id: 'workspace.activity.notificationsTip', defaultMessage: '{unread, plural, =0 {Notifications} other {Notifications (# unread)}}', description: 'Tooltip on the notifications button.' }),
  forYouBadge: msg({ id: 'workspace.activity.forYou', defaultMessage: '{n, plural, one {# card waits for you} other {# cards wait for you}}', description: "Accessible name and tooltip line of the count on the activity bar's Task Board icon: how many cards wait for the user (an approval, a decision, a question: For you). Glossary: For you." }),
  unread: msg({ id: 'workspace.activity.unread', defaultMessage: '{count, plural, other {# unread}}', description: 'The notifications button, for screen readers: how many notifications are unread.' }),
  more: msg({ id: 'workspace.statusBar.more', defaultMessage: 'and {count} more', description: "Under the running agents' table in the status bar's tooltip: agents not listed." }),
  openWorkspace: msg({ id: 'workspace.statusBar.openWorkspace', defaultMessage: 'Open a workspace', description: 'The status bar with no workspace open: opens one.' }),
  running: msg({ id: 'workspace.statusBar.running', defaultMessage: '{count, plural, other {# running session(s)}}: {working} working, {background, plural, =0 {} other {# waiting on background tasks, }}{waiting} waiting for you', description: "The status bar's running sessions (English keeps session(s); use your language's plural forms): how many, working, waiting on background tasks (only when some are) and waiting for you." }),
  workspace: msg({ id: 'workspace.statusBar.workspace', defaultMessage: 'Workspace: {path}', description: "Tooltip on the status bar's workspace." }),
  apiOn: msg({ id: 'workspace.statusBar.apiOn', defaultMessage: 'Agent API listening on {url}', description: "Tooltip on the status bar's API: Combwork's Agent API is on ({url}: its address)." }),
  apiError: msg({ id: 'workspace.statusBar.apiError', defaultMessage: 'Agent API: {error}', description: "Tooltip on the status bar's API: it couldn't start; {error} says why." }),
  apiOff: msg({ id: 'workspace.statusBar.apiOff', defaultMessage: 'Agent API is off', description: "Tooltip on the status bar's API." }),
  api: msg({ id: 'workspace.statusBar.api', defaultMessage: 'API', description: "The status bar's item for Combwork's Agent API. Keep it short." }),
  awakeTip: msg({ id: 'workspace.statusBar.awakeTip', defaultMessage: "Windows won't sleep until the agents finish (the screen may still turn off). Settings → General → Keep the PC awake while agents work.", description: "Tooltip on the status bar's keep-awake note. Keep the setting's path as Settings shows it." }),
  shortLimit: msg({ id: 'workspace.statusBar.shortLimit', defaultMessage: '{window, select, fiveHour {5h} weekly {Week} other {{label}}}', description: "The status bar's plan limits, before each one's percent: the 5-hour window, the weekly one, or the provider's own name for another. Keep it very short." }),
  connectionLine: msg({ id: 'workspace.statusBar.connectionLine', defaultMessage: '{name} ({provider}{hasPlan, select, yes {, {plan} plan} other {}})', description: "The first line of a connection's plan limits tooltip in the status bar (HI-1756): the connection's name the user gave it ({name}: \"Max 1\"), its coding agent ({provider}: Claude Code) and its plan's name ({plan}: max, pro…)." }),
  planLine: msg({ id: 'workspace.statusBar.planLine', defaultMessage: '{provider}{hasPlan, select, yes { ({plan} plan)} other {}}', description: "The first line of the status bar's plan limits tooltip (GitHub issue #1): the coding agent ({provider}: Claude Code) and its plan's name ({plan}: max, pro…)." }),
  limitLine: msg({ id: 'workspace.statusBar.limitLine', defaultMessage: '{window, select, fiveHour {5-hour limit} weekly {Weekly limit} other {{label} limit}}: {used, number, ::percent} used{hasReset, select, yes {, resets {when}} other {}}', description: 'A line of the status bar\'s plan limits tooltip (GitHub issue #1): a rolling usage window, how much of it is used, and when it resets ({when}: "in 2 h 5 min", or a weekday and time).' }),
  reportedBy: msg({ id: 'workspace.statusBar.reportedBy', defaultMessage: 'Reported by {agent}, {when}', description: 'Under a line of the status bar\'s plan limits tooltip (#383): which agent\'s session reported the figure of the limit above ({agent}: its name) and when ({when}: "4 minutes ago").' }),
  shortModels: msg({ id: 'workspace.statusBar.shortModels', defaultMessage: '{models, select, gemini {Gemini} otherModels {Other} premium {Premium} chat {Chat} completions {Completions} other {{models}}}{window, select, weekly { wk} other {}}', description: "The status bar's plan limits (HI-2734), before the percent of a limit that covers part of a plan: which models or requests (Antigravity's Gemini models or its other providers' models; Copilot's premium requests, chat messages or code completions; else the provider's own word, {models}), and \"wk\" for a weekly one. Keep it very short." }),
  unlimitedShort: msg({ id: 'workspace.statusBar.unlimitedShort', defaultMessage: 'unlimited', description: "The status bar's plan limits (HI-2734), after a limit's short name, in place of its percent, when the plan has no limit on it. Keep it short." }),
  unlimitedLine: msg({ id: 'workspace.statusBar.unlimitedLine', defaultMessage: '{label} limit: unlimited{hasReset, select, yes {, its period resets {when}} other {}}', description: "A line of the status bar's plan limits tooltip (HI-2734) for a limit the plan has no cap on: its name ({label}: \"Premium requests\"), and when its period resets ({when})." }),
  asOf: msg({ id: 'workspace.statusBar.asOf', defaultMessage: 'As of {when}. Updates while a session is running.', description: 'The last line of the status bar\'s plan limits tooltip (GitHub issue #1): when the limits were reported ({when}: "4 minutes ago").' }),
  notInstalledUnused: msg({ id: 'workspace.statusBar.notInstalledUnused', defaultMessage: "{provider} isn't installed. Nothing uses it: new agents use another provider.", description: "Tooltip on a coding agent's status bar item: it is turned on but not installed, and nothing needs it." }),
  notInstalled: msg({ id: 'workspace.statusBar.notInstalled', defaultMessage: 'not installed', description: "A coding agent's status bar item, after its icon: it isn't installed. Lower case; keep it short." }),
  notInstalledTip: msg({ id: 'workspace.statusBar.notInstalledTip', defaultMessage: '{provider} is not installed.', description: "Tooltip on a coding agent's status bar warning." }),
  providerTip: msg({ id: 'workspace.statusBar.providerTip', defaultMessage: '{provider} {version} ({source}){hasWarning, select, yes { — {warning}} other {}}{hasUpdate, select, yes { — {latest} available} other {}}', description: "Tooltip on a coding agent's status bar item: its version, where it was found ({source}), a warning, and a newer version when there is one." }),
  gitOld: msg({ id: 'workspace.statusBar.gitOld', defaultMessage: "Git {version} is older than {min}: some git features don't work.", description: "Tooltip on the status bar's Git warning." }),
  gitProblem: msg({ id: 'workspace.statusBar.gitProblem', defaultMessage: '{problem}. {fix}', description: "Tooltip on the status bar's Git warning: what is wrong with git and how to fix it." }),
  git: msg({ id: 'workspace.statusBar.git', defaultMessage: '{hasVersion, select, yes {Git {version}} other {Git}}', description: "The status bar's Git warning. Usually kept as Git." })
}

/** The activity bar's icon for the Assistant: its own mark rather than a codicon. */
const ASSISTANT_ICON = 'cw-assistant'

const ACTIVITIES: { id: Activity; icon: string; label: Msg; command: string }[] = [
  { id: 'projects', icon: 'files', label: M.projects, command: 'view.projects' },
  { id: 'overview', icon: 'dashboard', label: M.overview, command: 'view.overview' },
  { id: 'activity', icon: 'type-hierarchy', label: M.activity, command: 'view.activity' },
  { id: 'performance', icon: 'pulse', label: M.performance, command: 'view.performance' },
  { id: 'board', icon: 'project', label: M.board, command: 'view.board' },
  { id: 'notes', icon: 'notebook', label: M.notes, command: 'view.notes' },
  { id: 'skills', icon: 'sparkle', label: M.skills, command: 'view.skills' },
  { id: 'dialects', icon: 'symbol-string', label: M.dialects, command: 'view.dialects' },
  { id: 'templates', icon: 'library', label: M.templates, command: 'view.templates' },
  { id: 'mcp', icon: 'plug', label: M.mcp, command: 'view.mcp' },
  // The Assistant's own mark (#979: the queen's crown on a honeycomb cell, not a robot), drawn by AssistantMark.
  { id: 'assistant', icon: ASSISTANT_ICON, label: M.assistant, command: 'view.assistant' }
]

export function ActivityBar() {
  const activity = useStore((s) => s.activity)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const unread = useStore((s) => s.unread)
  // Agents that need you (the inbox's count).
  const attention = useInbox().needYou.length
  // Cards waiting for the user (#1276, For you: an approval, a decision, a question); Review's count stays in the board
  // sidebar's Waiting for review.
  const forYou = new Set(useForYou().summary.items.map((i) => i.card)).size

  const button = (id: Activity, icon: string, labelMsg: Msg, command: string, badge?: number, badgeLabel?: string) => {
    const kb = commandKeybinding(command)
    const label = tr(labelMsg)
    const said = badge && badgeLabel ? `${label} · ${badgeLabel}` : label
    return (
      <Tooltip key={id} content={kb ? tr(M.withKey, { label: said, key: formatKeybinding(kb) }) : said}>
        <button className={cx('activity-btn', activity === id && (sidebarVisible || id === 'docs' || id === 'settings') && 'active')} onClick={() => setActivity(id)} aria-label={label} aria-description={badge && badgeLabel ? badgeLabel : undefined}>
          {icon === ASSISTANT_ICON ? <AssistantMark className="activity-mark" /> : <Icon name={icon} />}
          {!!badge && (
            <span className="activity-badge" aria-label={badgeLabel} data-badge={id}>
              {badge}
            </span>
          )}
        </button>
      </Tooltip>
    )
  }

  return (
    <div className="activitybar">
      {ACTIVITIES.map((a) => button(a.id, a.icon, a.label, a.command, a.id === 'projects' ? attention : a.id === 'board' ? forYou : undefined, a.id === 'board' ? tr(M.forYouBadge, { n: forYou }) : undefined))}
      <div className="activity-spacer" />
      <Tooltip content={tr(M.notificationsTip, { unread })}>
        <button
          className={cx('activity-btn', unread > 0 && 'unread')}
          onClick={() => set((s) => ({ showNotifications: !s.showNotifications, unread: 0 }))}
          aria-label={tr(M.notifications)}
          aria-description={unread ? tr(M.unread, { count: unread }) : undefined}
        >
          <Icon name={unread ? 'bell-dot' : 'bell'} />
        </button>
      </Tooltip>
      {button('docs', 'book', M.docs, 'help.docs')}
      {button('settings', 'settings-gear', M.settings, 'settings.open')}
    </div>
  )
}

/** The most agents the running sessions' table lists (a screenful): more say "and n more". */
const RUNNING_ROWS_MAX = AGENT_LIMIT_MAX

/**
 * The workspace's running agents (#572): Agent · Project · State · Card · Waiting for (only when one waits), project by
 * project in the sidebar's order; `max` rows at most.
 */
function runningAgentsData(workspace: WorkspaceInfo, tasks: readonly TaskCard[], max = Infinity): AgentTableData {
  const shown = workspace.projects.flatMap((p) => p.agents.filter((a) => a.live).map((a) => ({ p, a, ...agentRow(p, a, tasks) }))).slice(0, max)
  const waits = shown.some((r) => r.waits)
  return {
    columns: [PROJECT_COLUMN, STATE_COLUMN, CARD_COLUMN, ...(waits ? [WAITING_COLUMN] : [])],
    rows: shown.map(({ p, a, state, card, waits: w }): AgentTableRow => ({ key: `${p.path}:${a.id}`, name: a.name, dot: a.live!.status, cells: [{ text: p.name }, { text: state }, { text: card }, ...(waits ? [{ text: w }] : [])] }))
  }
}

/** The running sessions' tooltip (#572): the counts, then the running agents as a table, at most a screenful ("and n more"). */
function RunningAgentsTip({ workspace, summary, count }: { workspace: WorkspaceInfo; summary: string; count: number }) {
  const tasks = useStore((s) => s.tasks)
  const data = runningAgentsData(workspace, tasks, RUNNING_ROWS_MAX)
  return (
    <div className="rail-tip">
      <strong>{summary}</strong>
      <AgentRowsTable {...data} />
      {count > data.rows.length && <div className="faint">{tr(M.more, { count: count - data.rows.length })}</div>}
    </div>
  )
}

export function StatusBar() {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const api = useStore((s) => s.api)
  const project = workspace?.projects.find((p) => p.path === selected)
  const tasks = useStore((s) => s.tasks)

  if (!workspace) {
    return (
      <div className="statusbar no-workspace">
        <div className="status-item" onClick={() => runCommand('workspace.open')}>
          <Icon name="folder-opened" /> {tr(M.openWorkspace)}
        </div>
        <div className="status-spacer" />
        <ProviderStatusItems />
        <UpdateStatusItem />
      </div>
    )
  }

  const live = workspace.projects.flatMap((p) => p.agents.map((a) => a.live).filter((l) => !!l))
  const working = live.filter((l) => l!.status === 'working').length
  const waiting = live.filter((l) => asksYou(l)).length
  const background = live.filter((l) => l!.status === 'background').length
  const summary = tr(M.running, { count: live.length, working, background, waiting })
  // The table's plain text, every agent, for screen readers (#572).
  const agentLines = live.length ? tableText(runningAgentsData(workspace, tasks)) : ''

  return (
    <div className="statusbar">
      <Tooltip content={tr(M.workspace, { path: workspace.path })}>
        <div className="status-item" onClick={() => runCommand('view.projects')}>
          <Icon name="root-folder" /> {workspace.name}
        </div>
      </Tooltip>
      {project && <GitStatusBarItem project={project} />}
      <Tooltip content={live.length ? <RunningAgentsTip workspace={workspace} summary={summary} count={live.length} /> : summary} className={live.length ? 'agents-tip' : undefined}>
        <div className="status-item running-sessions" onClick={() => runCommand('view.projects')} aria-label={summary} aria-description={agentLines || undefined}>
          <Icon name="pulse" /> {live.length}
        </div>
      </Tooltip>
      <InboxStatusItem />
      <TeamPausedStatusItem />
      <div className="status-spacer" />
      <KeepAwakeStatusItem />
      {/* App-wide items only: each agent's model, effort, mode and context are in its pane's footer. */}
      <PlanUsageStatus />
      <Tooltip content={api?.running ? tr(M.apiOn, { url: api.url ?? '' }) : api?.error ? tr(M.apiError, { error: api.error }) : tr(M.apiOff)}>
        <div className="status-item" onClick={() => {
            set({ settingsSection: 'agentApi' })
            setActivity('settings')
          }}>
          <Icon name={api?.running ? 'broadcast' : 'circle-slash'} /> {tr(M.api)}
        </div>
      </Tooltip>
      <ProviderStatusItems />
      <UpdateStatusItem />
    </div>
  )
}

/** While the team is paused (HI-2081): a quiet item that opens the Progress panel, where its Lanes say what still runs. */
function TeamPausedStatusItem() {
  const paused = useTeamPaused()
  const parked = useTeamPause((s) => !!s.state?.allParked)
  if (!paused) return null
  const text = parked ? tr(TEAM_STATUS.parked) : tr(TEAM_STATUS.paused)
  return (
    <Tooltip content={tr(TEAM_STATUS.tip)}>
      <div className="status-item team-paused" role="button" tabIndex={0} aria-label={text} onClick={() => setProgressOpen(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setProgressOpen(true)}>
        <Icon name="debug-pause" /> {text}
      </div>
    </Tooltip>
  )
}

const TEAM_STATUS = {
  paused: msg({ id: 'shell.status.teamPaused', defaultMessage: 'Team paused', description: "A status bar item while the team is paused before an update (HI-2081): Combwork starts no lane card and wakes no agent until it resumes. Click: opens the Progress panel." }),
  parked: msg({ id: 'shell.status.teamParked', defaultMessage: 'Team parked', description: 'The status bar item (HI-2081) once the paused team has parked: nothing runs, so an update can be installed.' }),
  tip: msg({ id: 'shell.status.teamPausedTip', defaultMessage: "The team is paused: no lane starts a card and no agent is woken until you resume it. The Progress panel's Lanes says what still runs.", description: 'Tooltip of the status bar item while the team is paused (HI-2081).' })
}

/** While working agents keep the PC from sleeping (Settings → General). */
function KeepAwakeStatusItem() {
  const working = useStore((s) => s.keepAwake)
  if (!working) return null
  return (
    <Tooltip content={tr(M.awakeTip)}>
      <div className="status-item keep-awake" onClick={() => {
          set({ settingsSection: 'general' })
          setActivity('settings')
        }}>
        <Icon name="coffee" /> {keepAwakeText(working)}
      </div>
    </Tooltip>
  )
}

/** "5h" / "Week" for the status bar; a limit of part of a plan by its models (HI-2734: "Gemini wk"); others by their label. */
function shortLimit(l: PlanLimit): string {
  if (l.models) return tr(M.shortModels, { models: l.models, window: l.windowMinutes === 7 * 24 * 60 ? 'weekly' : 'other' })
  return tr(M.shortLimit, { window: limitWindow(l), label: l.label })
}

/**
 * Each enabled provider's plan limits, as Combwork keeps them from its sessions' reports (the highest in each reset period,
 * #383): one item per provider. A limit whose reset has passed with no new report is left out, not shown as it was.
 * A CLI with accounts (HI-1756; HI-2107) shows one item per account a session of this window's workspace runs on, by its
 * name now, all of them in the one order of accounts across every CLI (HI-2119), each that login's own limits; its
 * CLI-wide item (sessions not on one) goes. CLIs without accounts here follow, each with its CLI-wide item.
 */
function PlanUsageStatus() {
  const all = useStore((s) => s.planUsage)
  const byConnection = useStore((s) => s.connectionPlanUsage)
  const settings = useStore((s) => s.settings)
  const view = useConnections()
  const inUse = useConnectionsInUse()
  const now = useNow(60000)
  const byConnections = new Set((view?.providers ?? []).filter((p) => connectionsApply(view, p)))
  // Accounts in the one order, each by its name now (renamed since its session launched: the new one), then CLI-wide items.
  const items = planUsageItems(enabledProviders(settings).map((p) => p.id), byConnections, inUse, view?.order ?? [], (id) => view?.connections.find((a) => a.id === id)?.name)
  return (
    <>
      {items.map((it) => {
        const p = providerDescriptor(it.provider)
        return it.kind === 'account' ? (
          <PlanItem key={it.id} provider={p.id} kept={byConnection[it.id]} now={now} label={it.name} first={tr(M.connectionLine, { name: it.name, provider: p.name, hasPlan: byConnection[it.id]?.plan ? 'yes' : 'no', plan: byConnection[it.id]?.plan ?? '' })} data={{ 'data-plan': p.id, 'data-plan-connection': it.id }} />
        ) : (
          <PlanItem key={p.id} provider={p.id} kept={all[p.id]} now={now} first={tr(M.planLine, { provider: p.name, hasPlan: all[p.id]?.plan ? 'yes' : 'no', plan: all[p.id]?.plan ?? '' })} data={{ 'data-plan': p.id }} />
        )
      })}
    </>
  )
}

/** One item of the status bar's plan limits: a CLI's, or (`label`, its name) a connection's. Nothing while none is current. */
function PlanItem({ provider, kept, now, label, first, data }: { provider: ProviderId; kept: PlanUsage | undefined; now: number; label?: string; first: string; data: Record<string, string> }) {
  const limits = (kept?.limits ?? []).filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now)
  if (!kept || !limits.length) return null
  const usage = { ...kept, limits }
  const worst = Math.max(...usage.limits.map((l) => (l.unlimited ? 0 : l.usedPercent)))
  // GitHub issue #1: every part in the window's language (the window's name, the percent, when it resets, how long ago).
  const lines = usage.limits.flatMap((l) => [
    l.unlimited
      ? tr(M.unlimitedLine, { label: limitName(l), hasReset: l.resetsAt ? 'yes' : 'no', when: l.resetsAt ? resetsIn(l.resetsAt) : '' })
      : tr(M.limitLine, { window: limitWindow(l), label: limitName(l), used: Math.round(l.usedPercent) / 100, hasReset: l.resetsAt ? 'yes' : 'no', when: l.resetsAt ? resetsIn(l.resetsAt) : '' }),
    ...(l.reportedBy && l.reportedAt ? [tr(M.reportedBy, { agent: l.reportedBy, when: timeAgo(l.reportedAt) })] : [])
  ])
  const tip = [first, ...lines, tr(M.asOf, { when: timeAgo(usage.updatedAt) })].join('\n')
  return (
    <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
      <div className={cx('status-item', worst >= 95 ? 'warn' : worst >= 80 && 'caution')} {...data} onClick={() => runCommand('project.tab.overview')}>
        <ProviderIcon provider={provider} mono />
        {label !== undefined && (
          <span className="plan-connection">
            {label}
            <span className="status-sep">·</span>
          </span>
        )}
        {usage.limits.map((l, i) => (
          <span key={l.id}>
            {i > 0 && <span className="status-sep">·</span>}
            {shortLimit(l)} {l.unlimited ? tr(M.unlimitedShort) : fmt.percent(l.usedPercent / 100)}
          </span>
        ))}
      </div>
    </Tooltip>
  )
}

/**
 * One item per enabled provider: its CLI version, or what it still needs (install, sign-in, setup), as a warning when
 * something uses it or nothing is installed (#474); a provider only turned on that isn't installed is shown plainly.
 */
function ProviderStatusItems() {
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const warn = useProviderWarnings()
  return (
    <>
      {enabledProviders(settings).map((p) => {
        const info = providers[p.id]
        if (!info || info.checking) {
          return (
            <div key={p.id} className="status-item">
              <Icon name="loading" spin /> {p.name}
            </div>
          )
        }
        const blocking = info.readiness?.find((r) => r.level === 'error')
        const warned = warn.noneInstalled || warn.providers.includes(p)
        if (!info.found && !warned) {
          return (
            <Tooltip key={p.id} content={tr(M.notInstalledUnused, { provider: p.name })}>
              <div className="status-item faint" data-unused-provider={p.id} onClick={() => set({ setupOpen: p.id })}>
                <ProviderIcon provider={p.id} mono /> {tr(M.notInstalled)}
              </div>
            </Tooltip>
          )
        }
        if (!info.found || (blocking && warned)) {
          return (
            <Tooltip key={p.id} content={blocking?.message ?? tr(M.notInstalledTip, { provider: p.name })}>
              <div className="status-item warn" onClick={() => set({ setupOpen: p.id })}>
                <Icon name="warning" /> {p.name}
              </div>
            </Tooltip>
          )
        }
        const warning = info.readiness?.find((r) => r.level === 'warning')
        const tip = tr(M.providerTip, { provider: p.name, version: info.version ?? '', source: installSourceText(info.source, tr), hasWarning: warning ? 'yes' : 'no', warning: warning?.message ?? '', hasUpdate: info.updateAvailable ? 'yes' : 'no', latest: info.latestVersion ?? '' })
        return (
          <Tooltip key={p.id} content={tip}>
            <div className={cx('status-item', warning && 'caution')} onClick={() => set({ setupOpen: p.id })}>
              <ProviderIcon provider={p.id} mono /> {info.version}
              {(info.updateAvailable || warning) && <Icon name={warning ? 'warning' : 'cloud-download'} />}
            </div>
          </Tooltip>
        )
      })}
      <GitStatusItem />
    </>
  )
}

/** Git, only when it can't run or is older than Combwork needs (#346): every worktree, merge and Changes view depends on it. */
function GitStatusItem() {
  const git = useStore((s) => s.gitTool)
  if (!git || git.state === 'ok' || git.state === 'unknown') return null
  const problem = gitProblemText(git)
  return (
    <Tooltip content={problem ? tr(M.gitProblem, { problem, fix: gitFixText(git) }) : tr(M.gitOld, { version: git.version ?? '', min: GIT_MIN })}>
      <div className={cx('status-item', problem ? 'warn' : 'caution')} onClick={() => set({ setupOpen: true })}>
        <Icon name="warning" /> {tr(M.git, { hasVersion: problem ? 'no' : 'yes', version: git.version ?? '' })}
      </div>
    </Tooltip>
  )
}

export { formatKeybinding }
