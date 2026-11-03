import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectInfo } from '@shared/types'
import { agentLaunchSettings, isProviderEnabled, modeOption, providerName } from '@shared/providers'
import { cliReadyOf, connectionCli, firstReadyConnection } from '@shared/connectionLabel'
import { modeInEffect } from '@shared/cliOwnMode'
import { agentsToResume, stalledOnSignIn } from '@shared/resumeAll'
import { batchCounts } from '@shared/startAll'
import { hooksMissingNote } from '@shared/runtime'
import { MAIN_TABS, MORE_TABS, tabCommand } from '@shared/projectTabs'
import { allStopped, mostUrgent, projectAgentStates, projectStateShort, projectStateSummary } from '@shared/agentState'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import hexUrl from '../assets/icon.svg'
import * as actions from '../actions'
import { call, errorMessage } from '../api'
import { needsConnection, NoConnectionBanner, offeredConnections, useConnections } from '../components/ConnectionChoice'
import { commandKeybinding, runCommand } from '../commands'
import { AddAgentButton, PANE_FOOTER, PANE_HEADER, PaneChrome, RESUME_TINT, ResumeButton, SessionToolbar, TerminalLayer, usePanes, useWidth } from '../components/AgentPanes'
import { terminalMinWidth } from '../components/TerminalView'
import { AgentTiles, TILE_STRIP, useTileStripWidth } from '../components/AgentTiles'
import { paneColumnsFor, projectSessionView, tileStripRoom } from '@shared/defaults'
import { Icon, IconButton, Switch, Tooltip, useContextMenu, useFolds, type MenuEntry } from '../components/ui'
import { StateMark } from '../components/StateMark'
import { ProjectAgentsTable, useAgentsText } from '../components/AgentsTable'
import { agentProviderOf, notify, projectKey, set, setProjectTab, tileFocusOf, useFocusedAgent, useLanguage, useProjectStarting, useStarting, useStore, startingLabel, type ProjectTab } from '../store'
import { carriesFiles, cx, formatKeybinding } from '../util'
import { AttachmentsTab, FilesTab } from './FilesTab'
import { VersionControl } from './VersionControl'
import { MemoryTab, OverviewTab, ProjectMcpTab, ProjectSettingsTab, ProjectSkillsTab } from './ProjectTabs'
import { ProjectTemplatesTab } from '../components/Templates'
import { PerformanceTab } from './Performance'
import { ActivityTab } from './ActivityTab'
import { SessionsTab } from './SessionsTab'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ProjectTasksTab } from '../components/Board'
import { useStartBlocked } from '../components/BoardUpgrade'
import { RemovedDataBanner } from '../components/ProjectRemoval'

// The tabs the strip shows, in order, then More ▾ with the others (#1043): the title bar's Project menu has them all,
// and Settings (#974).
const TABS = MAIN_TABS

const M = {
  moreTabs: msg({ id: 'project.tabs.more', defaultMessage: 'More', description: "The last of a project's tabs: opens a menu of its other tabs (Memory, Skills, Templates, MCP). When one of them is open, the button shows its name instead. Keep it short." }),
  moreSettings: msg({ id: 'project.tabs.moreSettings', defaultMessage: 'Project Settings…', description: "The last item of the project tabs' More ▾ menu, after a separator (HI-1840): opens the project's settings. Keep the …." }),
  moreTip: msg({ id: 'project.tabs.moreTip', defaultMessage: "The project's {tabs}", description: "Tooltip on the project tabs' More ▾ button. {tabs} lists the tabs in its menu, such as Memory, Skills, Templates and MCP." }),
  tabTip: msg({ id: 'project.tabs.tip', defaultMessage: '{tab} ({key})', description: "A project tab's tooltip with its keyboard shortcut. {tab} is the tab's name, {key} the shortcut, such as Alt+4." }),
  noAccount: msg({ id: 'project.empty.noAccount', defaultMessage: 'No account is on in this workspace — Settings → Accounts & Connections', description: "Warning on the Session tab of a project with no agents (HI-2108): no account (a sign-in or server a coding agent CLI uses) is on in this workspace, so a new agent has no connection to run on. Settings → Accounts & Connections: name it as Settings does." }),
  noCli: msg({ id: 'project.empty.noCli', defaultMessage: 'No account on here has its coding agent CLI installed — Help → Provider Setup', description: "Warning on the Session tab of a project with no agents (HI-2132): accounts are on in this workspace, but none of their CLIs (Claude Code, Codex…) is installed, so a new agent can't run. Help → Provider Setup is the menu item." }),
  providerOff: msg({ id: 'project.empty.providerOff', defaultMessage: '{provider} is turned off — Settings → Providers', description: "Warning on the Session tab when the agent's provider is turned off. Settings → Providers: name it as Settings does." }),
  providerMissing: msg({ id: 'project.empty.providerMissing', defaultMessage: '{provider} is required — Help → Provider Setup', description: "Warning on the Session tab when the agent's CLI isn't installed. Help → Provider Setup is the menu item." }),
  sessionEnded: msg({ id: 'project.session.ended', defaultMessage: 'The session has ended. Resume it, or start a new one.', description: "Over an agent's terminal when its session has ended." }),
  resume: msg({ id: 'project.session.resume', defaultMessage: 'Resume', description: 'Button: resumes the last session.' }),
  newSession: msg({ id: 'project.session.new', defaultMessage: 'New Session', description: 'Button: starts a new session (adding an agent first when there is none).' }),
  noAgents: msg({ id: 'project.empty.noAgents', defaultMessage: 'No agents yet', description: 'Heading of the Session tab of a project with no agents, and the tooltip of its status badge.' }),
  notActive: msg({ id: 'project.empty.notActive', defaultMessage: '{project} is not active', description: 'Heading of the Session tab of a project not marked as one you are working on.' }),
  notRunning: msg({ id: 'project.empty.notRunning', defaultMessage: '{agent} is not running', description: "Heading of the Session tab when the focused agent (of several) has no session running. {agent} is its name." }),
  noSessionRunning: msg({ id: 'project.empty.noSession', defaultMessage: 'No session running', description: 'Heading of the Session tab when its one agent has no session running.' }),
  addAnAgent: msg({ id: 'project.empty.addAgent', defaultMessage: 'Add an agent to work on {project}: Add Agent adds a {provider} agent with its default settings (▾ to choose another provider, a worktree or settings). New Session adds one and starts it.', description: 'The Session tab of a project with no agents. Add Agent and New Session are its buttons; ▾ is the arrow beside Add Agent.' }),
  startOrResume: msg({ id: 'project.empty.startOrResume', defaultMessage: 'Start a new {provider} session, or resume a previous one. Sessions keep running when you switch to other projects.', description: 'The Session tab when its agent has no session running. {provider} is Claude Code, Codex…' }),
  markActive: msg({ id: 'project.empty.markActive', defaultMessage: 'Mark this project as one you are working on to run sessions and see its status. You can also start a session directly.', description: 'The Session tab of a project not marked as one you are working on.' }),
  resumeLast: msg({ id: 'project.empty.resumeLast', defaultMessage: 'Resume Last', description: "Button on the Session tab: resumes the agent's last session." }),
  allSessions: msg({ id: 'project.empty.allSessions', defaultMessage: 'All Sessions', description: 'Button on the Session tab: opens the Sessions tab.' }),
  markWorking: msg({ id: 'project.empty.markWorking', defaultMessage: 'Mark as working on', description: 'Button: marks the project as one you are working on.' }),
  selectProject: msg({ id: 'project.none.select', defaultMessage: 'Select a project from the sidebar.', description: 'Shown when the workspace has projects but none is selected.' }),
  createFirst: msg({ id: 'project.none.createFirst', defaultMessage: 'Create your first project to get started.', description: 'Shown when the workspace has no projects.' }),
  newProject: msg({ id: 'project.none.newProject', defaultMessage: 'New Project', description: 'Button: creates a project.' }),
  resumeAgent: msg({ id: 'project.header.resumeAgent', defaultMessage: 'Resume Agent', description: "The project header's button when one agent can be resumed." }),
  resumeShort: msg({ id: 'project.header.resumeShort', defaultMessage: 'Resume ({count})', description: "The project header's button: resumes every stopped agent. {count} is how many. Keep it short: its tooltip says it in full." }),
  resuming: msg({ id: 'project.header.resuming', defaultMessage: 'Resuming…', description: "The project header's Resume button while it runs." }),
  carryOn: msg({ id: 'project.header.carryOnTip', defaultMessage: 'Carry on {agent}: its turn stopped when its sign-in expired', description: 'Tooltip on Resume Agent when its turn stopped because the CLI sign-in expired.' }),
  resumeOne: msg({ id: 'project.header.resumeOneTip', defaultMessage: "Resume {agent}'s last session", description: 'Tooltip on Resume Agent.' }),
  carryOnMany: msg({ id: 'project.header.carryOnManyTip', defaultMessage: '{stopped, plural, =0 {Carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)} one {Resume the stopped agent and carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)} other {Resume the # stopped agents and carry on {stalled, plural, one {the agent} other {the # agents}} a refused sign-in stopped (other running ones are left alone)}}', description: 'Tooltip on Resume All Agents when some agents stopped because a sign-in expired. {stopped} is how many are stopped; {stalled} how many stopped mid-turn on a refused sign-in.' }),
  resumeMany: msg({ id: 'project.header.resumeAllTip', defaultMessage: '{count, plural, other {Resume all # stopped agents}}', description: "Tooltip and accessible name of the project header's Resume ({count}) button, with several stopped agents." }),
  stopAgent: msg({ id: 'project.header.stopAgent', defaultMessage: 'Stop Agent', description: "The project header's button when one agent is running." }),
  stopMany: msg({ id: 'project.header.stopMany', defaultMessage: 'Stop ({count})', description: "The project header's button: stops every running agent. {count} is how many." }),
  stopTip: msg({ id: 'project.header.stopAllTip', defaultMessage: '{count, plural, one {Stop the running agent} other {Stop all # running agents}}', description: "Tooltip and accessible name of the project header's Stop ({count}) button." }),
  startFreshIdle: msg({ id: 'project.header.startFreshIdle', defaultMessage: 'Start Fresh (Idle Agents)…', description: "The project header's Agents ▾ menu (#1437): gives each idle running agent a new conversation, after one question listing who will and who won't. The … says it asks first: keep it." }),
  startNew: msg({ id: 'project.header.startNew', defaultMessage: '{many, select, yes {Start New ({count})} other {Start New}}', description: "The project header's Agents ▾ menu: starts a fresh session for each agent. {count} is how many (shown with several agents)." }),
  archiveNew: msg({ id: 'project.header.archiveNew', defaultMessage: '{many, select, yes {Archive and Start New ({count})} other {Archive and Start New}}', description: "The project header's Agents ▾ menu: archives each agent's session and starts a fresh one." }),
  removeAllMenu: msg({ id: 'project.header.removeAllMenu', defaultMessage: '{many, select, yes {Remove All ({count})…} other {Remove Agent…}}', description: "The project header's Agents ▾ menu (or its ⋯ menu when narrow): removes every agent (it asks first)." }),
  dangerousMode: msg({ id: 'project.banner.dangerousMode', defaultMessage: '{agent}: {mode}', description: 'One agent and its permission mode, in the banner about modes that run without asking.' }),
  agentsMenu: msg({ id: 'project.header.agentsMenu', defaultMessage: 'Agents', description: "The project header's button that opens a menu of actions on all its agents (Start New, Archive and Start New, Remove All). Keep it short." }),
  agentsMenuTip: msg({ id: 'project.header.agentsMenuTip', defaultMessage: "Actions on all the project's agents: start new sessions, archive and start new, or remove them", description: "Tooltip on the project header's Agents ▾ button." }),
  workingOn: msg({ id: 'project.header.workingOn', defaultMessage: 'You are working on this project', description: "Tooltip on the project header's Active switch, on." }),
  notWorkingOn: msg({ id: 'project.header.notWorkingOn', defaultMessage: 'Not working on this project', description: "Tooltip on the project header's Active switch, off." }),
  active: msg({ id: 'project.header.active', defaultMessage: 'Active', description: "Label of the project header's switch: you are working on this project." }),
  more: msg({ id: 'project.header.more', defaultMessage: 'More actions', description: "Tooltip on the project header's ⋯ button." }),
  explorer: msg({ id: 'project.menu.explorer', defaultMessage: 'Explorer', description: "The project header's ⋯ menu: opens the project folder in File Explorer." }),
  terminal: msg({ id: 'project.menu.terminal', defaultMessage: 'Terminal', description: "The project header's ⋯ menu: opens a terminal in the project folder." }),
  projectSettings: msg({ id: 'project.menu.settings', defaultMessage: 'Project Settings', description: "The project header's ⋯ menu." }),
  removeProject: msg({ id: 'project.menu.remove', defaultMessage: 'Remove Project…', description: "The project header's ⋯ menu: removes the project from the workspace (asks first)." }),
  restartWhenDone: msg({ id: 'project.banner.restartWhenDone', defaultMessage: 'Restart When Its Turn Is Over', description: "Button on the restart banner of an agent running on another connection than the one chosen now (HI-1755): it ends once its turn is over and carries on, on the new connection." }),
  switchFailed: msg({ id: 'project.banner.switchFailed', defaultMessage: "Couldn't arrange the restart", description: "An error's title: Restart When Its Turn Is Over failed." }),
  restartNeeded: msg({ id: 'project.banner.restartNeeded', defaultMessage: "Skills, MCP servers, dialects or settings changed since {many, select, yes {{agent}'s} other {this}} session started. Restart the session to apply them — the conversation continues.", description: "Banner over a running session whose skills, MCP servers, dialect files (HI-2444) or settings changed. {agent} is the focused agent's name (when there are several)." }),
  restart: msg({ id: 'project.banner.restart', defaultMessage: 'Restart session', description: 'Button in that banner.' }),
  unmanagedMcp: msg({ id: 'project.banner.unmanagedMcp', defaultMessage: 'This project defines MCP servers that are not in the workspace: <b>{names}</b>. They stay disabled until copied to the workspace.', description: 'Banner of a project with MCP servers of its own. {names} is their names. <b> is bold.' }),
  copyToWorkspace: msg({ id: 'project.banner.copyToWorkspace', defaultMessage: 'Copy to workspace', description: "Button: copies the project's own MCP servers to the workspace." }),
  dangerous: msg({ id: 'project.banner.dangerous', defaultMessage: '{modes} {count, plural, one {is} other {are}} on in this project: the agent runs every command and edit without asking.', description: 'Banner when an agent of the project runs in a permission mode that never asks. {modes} names the modes (with the agents when there are several).' }),
  change: msg({ id: 'project.banner.change', defaultMessage: 'Change', description: 'Button in that banner: opens Project Settings.' })
}

const bold = (c: React.ReactNode[]): React.ReactNode => <strong>{c}</strong>

/** Where a menu opens under a button. */
const menuBelow = (el: Element): [number, number] => {
  const r = el.getBoundingClientRect()
  return [r.left, r.bottom + 2]
}

/** A tab's tooltip, with its shortcut (they can be changed, and Tasks has none by default). */
function tabTip(id: ProjectTab, label: string): string {
  const kb = commandKeybinding(tabCommand(id))
  return kb ? tr(M.tabTip, { tab: label, key: formatKeybinding(kb) }) : label
}

/** The More ▾ button's place among the strip's measured items: after the tabs (#1043). */
const MORE_AT = TABS.length

/** How the tab strip fits: every tab labelled; icons, with the active tab's label; or icons only, scrolling if even they don't. */
type TabFit = 'labels' | 'icons' | 'all-icons'
const TAB_FITS: TabFit[] = ['labels', 'icons', 'all-icons']
/** Room a roomier fit needs to spare before the strip goes back to it, so it doesn't flicker at the switching point. */
const TAB_FIT_SPARE = 12

/** The least of the project's name the header keeps beside its status before its actions fold further (#886). */
const TITLE_MIN = 96
/** How far past the width a terminal needs the panes give back a column, or the focus view its strip (#1037). */
const FIT_MARGIN = 24
/** How far the header's actions can fold: every label; Resume, Stop, Active and Agents ▾ as icons; Agents ▾'s actions in ⋯. */
const HEADER_FOLDS = 5

/**
 * The width the project header's title (its least room) and actions (all of them, on one row) need side by side, for
 * `useFolds` (#886): 0 shows every label; 1 shows Resume, Stop, Active and Agents ▾ as icons; 2 moves Agents ▾'s
 * actions into ⋯; at the narrowest (#1051, the header one row whatever its width) 3 moves Active into ⋯, 4 shortens the
 * status to its most urgent count, and 5 moves Resume and Stop into ⋯ too, leaving the name, the status and ⋯.
 */
function headerNeed(el: HTMLElement): number | null {
  const title = el.querySelector<HTMLElement>('.project-title')
  const name = title?.querySelector<HTMLElement>('h1')
  // The state line, while the project has agents.
  const badge = title?.querySelector<HTMLElement>('.badge')
  const buttons = el.querySelector<HTMLElement>(':scope > .actions')
  if (!title || !name || !buttons) return null
  const gap = (e: HTMLElement): number => parseFloat(getComputedStyle(e).columnGap) || 0
  // Each part's whole width, even while it is cut short (scrollWidth: the name and status are cut with "…").
  const items = [...buttons.children] as HTMLElement[]
  const actionsNeed = items.reduce((n, c) => n + c.scrollWidth, 0) + gap(buttons) * Math.max(0, items.length - 1)
  const status = badge?.querySelector<HTMLElement>('.badge-text')
  const badgeNeed = badge ? badge.offsetWidth + (status ? status.scrollWidth - status.clientWidth : 0) + gap(title) : 0
  const titleNeed = Math.min(name.scrollWidth, TITLE_MIN) + badgeNeed
  return Math.ceil(titleNeed + gap(el) + actionsNeed)
}

/**
 * The project's tabs. When their labels don't fit, they shrink to icons, the active tab keeping its label while that fits;
 * narrower still, all are icons, and the strip scrolls with the active tab in view. Every tab's width with and without its
 * label is measured off screen (`.tabs-measure`), so the fit follows the strip's width (window, sidebar, panels) both ways
 * without trying each fit on screen. Icon-only tabs keep their label for screen readers and their name in the tooltip.
 * More ▾ is last, one more item to fit (#1043): it opens a menu of the other tabs and, while one of them is open, is the
 * active item, with its name and icon.
 */
function ProjectTabStrip({ project, tab, live }: { project: ProjectInfo; tab: ProjectTab; live: boolean }) {
  const [widthRef, width] = useWidth<HTMLDivElement>()
  const strip = useRef<HTMLDivElement | null>(null)
  const stripRef = useCallback(
    (el: HTMLDivElement | null) => {
      strip.current = el
      widthRef(el)
    },
    [widthRef]
  )
  const measureRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLElement | null>(null)
  // The active item, a tab or More ▾.
  const activeEl = (el: HTMLElement | null): void => {
    activeRef.current = el
  }
  const [widths, setWidths] = useState<{ labelled: number[]; icon: number[] } | null>(null)
  useLayoutEffect(() => {
    const el = measureRef.current
    if (!el) return
    const measure = (): void => {
      const w = [...el.children].map((c) => c.getBoundingClientRect().width)
      // Nothing to measure while the project isn't shown: keep the last widths.
      if (w.every((x) => x === 0)) return
      setWidths({ labelled: w.filter((_, i) => i % 2 === 0), icon: w.filter((_, i) => i % 2 === 1) })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])
  const moreMenu = useContextMenu()
  const moreTab = MORE_TABS.find((t) => t.id === tab)
  const moreLabel = moreTab ? tr(moreTab.label) : tr(M.moreTabs)
  const moreIcon = moreTab?.icon ?? 'ellipsis'
  const moreItems = (): MenuEntry[] => {
    const settingsKb = commandKeybinding('project.tab.settings')
    return [
      ...MORE_TABS.map((t) => {
        const kb = commandKeybinding(tabCommand(t.id))
        return { label: tr(t.label), icon: t.icon, keybinding: kb ? formatKeybinding(kb) : undefined, onClick: () => setProjectTab(project.path, t.id) }
      }),
      // Then Project Settings (HI-1840): an action, its command's, never one of More ▾'s tabs (so never its label).
      { separator: true },
      { label: tr(M.moreSettings), icon: 'settings', keybinding: settingsKb ? formatKeybinding(settingsKb) : undefined, onClick: () => runCommand('project.tab.settings') }
    ]
  }
  const fitRef = useRef<TabFit>('labels')
  let fit = fitRef.current
  if (widths && width > 0 && widths.labelled.length === MORE_AT + 1) {
    const at = TABS.findIndex((t) => t.id === tab)
    const active = moreTab ? MORE_AT : Math.max(0, at)
    const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0)
    const need: Record<TabFit, number> = { labels: sum(widths.labelled), icons: sum(widths.icon) - widths.icon[active] + widths.labelled[active], 'all-icons': 0 }
    const now = TAB_FITS.indexOf(fitRef.current)
    fit = TAB_FITS.find((f, i) => Math.ceil(need[f]) + (i < now ? TAB_FIT_SPARE : 0) <= width) ?? 'all-icons'
  }
  fitRef.current = fit
  // The active tab stays in view when the strip has to scroll.
  useEffect(() => {
    const s = strip.current
    const a = activeRef.current
    if (!s || !a) return
    const sr = s.getBoundingClientRect()
    const ar = a.getBoundingClientRect()
    if (ar.left < sr.left) s.scrollLeft -= sr.left - ar.left
    else if (ar.right > sr.right) s.scrollLeft += ar.right - sr.right
  }, [fit, tab, width])
  return (
    <div className="tabs-row">
      <div className="tabs" ref={stripRef} data-fit={fit}>
        {TABS.map((t) => (
          <Tooltip key={t.id} content={tabTip(t.id, tr(t.label))}>
            <div
              ref={tab === t.id ? activeEl : undefined}
              className={cx('tab', tab === t.id && 'active', (fit === 'all-icons' || (fit === 'icons' && tab !== t.id)) && 'icon-only')}
              onClick={() => setProjectTab(project.path, t.id)}
              // Dragging files over the Session tab switches to it, so they can be dropped on the terminal.
              onDragOver={t.id === 'session' ? (e) => carriesFiles(e.dataTransfer) && live && tab !== 'session' && setProjectTab(project.path, 'session') : undefined}
            >
              <Icon name={t.icon} /> <span className="tab-label">{tr(t.label)}</span>
            </div>
          </Tooltip>
        ))}
        <Tooltip content={tr(M.moreTip, { tabs: fmt.list(MORE_TABS.map((t) => tr(t.label)), 'conjunction') })}>
          <button
            ref={moreTab ? activeEl : undefined}
            className={cx('tab', 'tab-more', moreTab && 'active', (fit === 'all-icons' || (fit === 'icons' && !moreTab)) && 'icon-only')}
            aria-haspopup="menu"
            aria-expanded={moreMenu.shown}
            onClick={(e) => moreMenu.openAt(...menuBelow(e.currentTarget), moreItems(), e.detail === 0)}
          >
            <Icon name={moreIcon} /> <span className="tab-label">{moreLabel}</span>
            <Icon name="chevron-down" className="tab-chevron" />
          </button>
        </Tooltip>
      </div>
      {/* Each tab labelled, then icon only, for measuring; the labels are CSS content, so no text here repeats a tab's. */}
      <div className="tabs-measure" ref={measureRef} aria-hidden>
        {TABS.flatMap((t) => [
          <div key={`${t.id}-label`} className="tab-m" data-label={tr(t.label)}>
            <Icon name={t.icon} />
          </div>,
          <div key={`${t.id}-icon`} className="tab-m icon-only">
            <Icon name={t.icon} />
          </div>
        ])}
        <div className="tab-m tab-more" data-label={moreLabel}>
          <Icon name={moreIcon} />
          <Icon name="chevron-down" className="tab-chevron" />
        </div>
        <div className="tab-m tab-more icon-only">
          <Icon name={moreIcon} />
          <Icon name="chevron-down" className="tab-chevron" />
        </div>
      </div>
      {moreMenu.element}
    </div>
  )
}

function SessionEmpty({ project, framed }: { project: ProjectInfo; framed: boolean }) {
  const focused = useFocusedAgent(project)
  // Unbound in Keyboard Shortcuts: no key to show.
  const newKey = commandKeybinding('session.new')
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const view = useConnections()
  const offered = !focused && view ? offeredConnections(view, settings) : []
  // With no agent, the connection a new one gets (decision A: the first usable, its CLI installed); none while Hive is
  // still looking for a CLI before it.
  const ready = offered.length ? firstReadyConnection(view, settings, cliReadyOf(providers)) : null
  // The focused agent's provider, else the new agent's (its connection's CLI; Automatic's pick where none is usable),
  // and what Hive found of its CLI.
  const provider = (!focused && connectionCli(view, ready?.id)) || agentProviderOf(focused)
  const info = providers[provider]
  const on = isProviderEnabled(settings, provider)
  // No agent and no account on here (HI-2108): a new agent has no connection to run on. Not for a test copy on a CLI test home.
  const noAccount = !focused && !!view && !offered.length && !view.testHome.length
  // Accounts on here but none on an installed CLI: a new agent can't run.
  const noCli = !!ready && !ready.id && !ready.checking
  // An agent's own provider by name; with none, what a new agent's connection needs.
  const warning = noAccount
    ? tr(M.noAccount)
    : focused
    ? !on
      ? tr(M.providerOff, { provider: providerName(provider) })
      : info && !info.checking && !info.found
        ? tr(M.providerMissing, { provider: providerName(provider) })
        : null
    : noCli
      ? tr(M.noCli)
      : null
  const epoch = useStore((s) => (focused ? s.sessionEpoch[projectKey(project.path, focused.id)] : undefined))
  const ended = epoch !== undefined
  // Its workspace's 1.0 upgrade waits (#1230): no session can start.
  const startBlocked = useStartBlocked()
  // From the click until the session runs (#1177): the focused agent's, or with no agent, the one being added.
  const agentStarting = useStarting(project.path, focused?.id ?? null)
  const addingStarting = useProjectStarting(project.path)
  const starting = focused ? agentStarting : addingStarting
  const resuming = starting?.kind === 'resume'
  const startingNew = starting?.kind === 'start'
  // An ended session keeps its terminal; the pane shows the Resume bar over it.
  if (ended) return null
  const many = project.agents.length > 1
  return (
    <div className={ended ? 'session-ended' : 'session-empty'} style={framed ? { top: PANE_HEADER, bottom: PANE_FOOTER } : undefined}>
      {ended ? (
        <>
          <Icon name="debug-disconnect" />
          <span className="grow">{tr(M.sessionEnded)}</span>
          <button className="btn act-resume solid" disabled={!!startBlocked || !!starting} aria-busy={resuming || undefined} title={startBlocked ?? undefined} onClick={() => void actions.resumeLast(project.path)}>
            <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} /> {resuming ? startingLabel(starting) : tr(M.resume)}
          </button>
          <button className="btn act-start" disabled={!!startBlocked || !!starting} aria-busy={startingNew || undefined} title={startBlocked ?? undefined} onClick={() => void actions.newSession(project.path)}>
            <Icon name={startingNew ? 'loading' : 'add'} spin={startingNew} /> {startingNew ? startingLabel(starting) : tr(M.newSession)}
          </button>
        </>
      ) : (
        <div className="session-empty-card">
          <img src={hexUrl} className="hex-mark" alt="" />
          <h2>{!focused ? tr(M.noAgents) : !project.active ? tr(M.notActive, { project: project.name }) : many ? tr(M.notRunning, { agent: focused.name }) : tr(M.noSessionRunning)}</h2>
          <p>
            {!focused
              ? tr(M.addAnAgent, { project: project.name, provider: providerName(provider) })
              : project.active
                ? tr(M.startOrResume, { provider: providerName(provider) })
                : tr(M.markActive)}
          </p>
          {warning && (
            <p>
              <span className="badge warn" data-provider-warning="">
                <Icon name="warning" /> {warning}
              </span>
            </p>
          )}
          <div className="btns">
            <button className="btn act-start solid" disabled={!!startBlocked || !!starting} aria-busy={startingNew || undefined} title={startBlocked ?? undefined} onClick={() => void actions.newSession(project.path)}>
              <Icon name={startingNew ? 'loading' : 'add'} spin={startingNew} /> {startingNew ? startingLabel(starting) : tr(M.newSession)} {newKey && <kbd style={{ marginLeft: 6 }}>{formatKeybinding(newKey)}</kbd>}
            </button>
            {focused ? <ResumeButton project={project} a={focused} className={RESUME_TINT} label={tr(M.resumeLast)} /> : <AddAgentButton project={project} className="tint-amber" />}
            <button className="btn subtle" onClick={() => setProjectTab(project.path, 'sessions')}>
              <Icon name="history" /> {tr(M.allSessions)}
            </button>
          </div>
          {!project.active && (
            <div className="btns">
              <button className="btn subtle small" onClick={() => void actions.setProjectActive(project.path, true)}>
                <Icon name="pass" /> {tr(M.markWorking)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ProjectView({ visible }: { visible: boolean }) {
  const workspace = useStore((s) => s.workspace)
  const selected = useStore((s) => s.selectedProject)
  const tabs = useStore((s) => s.projectTabs)
  const settings = useStore((s) => s.settings)
  const runningActions = useStore((s) => s.running)
  const menu = useContextMenu()
  const agentsMenu = useContextMenu()
  const project = workspace?.projects.find((p) => p.path === selected) ?? null
  const tab = (project && tabs[project.path]) || 'session'
  // The Session tab's view (#975): Panes shows the terminals; Tiles hides them (they keep running) for a tile each (#976).
  const view = project ? projectSessionView(project.config, settings) : 'panes'
  // A tile's focus view (#976): that agent's pane, beside the strip of the others.
  const tileFocus = useStore((s) => (view === 'tiles' ? tileFocusOf(project, s) : null))
  const panesShown = view === 'panes' || !!tileFocus
  // The focus view's pane beside its strip, as wide as the user made it (#1021).
  const stripWidth = useTileStripWidth()
  const terminalVisibleFor = visible && project && tab === 'session' && panesShown ? project.path : null
  // How many panes fit side by side, each wide enough for a terminal (#1037): the layout shows fewer while they don't.
  const [bodyRef, bodyWidth] = useWidth<HTMLDivElement>()
  const appearance = useStore((s) => s.settings?.appearance)
  useEffect(() => {
    // Hidden (another view shown), it measures nothing: the last width stands.
    if (bodyWidth <= 0) return
    // Each a little past the boundary before it gives back what it gave way (FIT_MARGIN), so a pixel either way at it
    // doesn't flip the layout or the focus view's strip.
    const min = terminalMinWidth()
    const was = useStore.getState()
    const paneColumns = paneColumnsFor(bodyWidth, min, was.paneColumns, FIT_MARGIN)
    const stripRoom = tileStripRoom(bodyWidth, min, TILE_STRIP.min, was.tileStripRoom, FIT_MARGIN)
    if (was.paneColumns !== paneColumns || was.tileStripRoom !== stripRoom) set({ paneColumns, tileStripRoom: stripRoom })
  }, [bodyWidth, appearance?.terminalFontSize, appearance?.terminalFontFamily])
  const layoutShows = usePanes(project)
  const panes = tileFocus ? [tileFocus] : layoutShows
  const focusedAgent = useFocusedAgent(project)
  // A narrow header shows Resume, Stop, Active and Agents ▾ as icons; tighter still
  // (both panels open beside the narrowest window), Agents ▾'s actions move into ⋯. The title gives way to the actions
  // down to its least room (#216, #291); how far they fold is measured, so a longer language folds sooner (#886).
  const [headerWidthRef, headerWidth] = useWidth<HTMLDivElement>()
  const header = useRef<HTMLDivElement | null>(null)
  const headerRef = useCallback(
    (el: HTMLDivElement | null) => {
      header.current = el
      headerWidthRef(el)
    },
    [headerWidthRef]
  )
  const language = useLanguage()
  const headerContent = project
    ? [language, project.name, project.agents.map((a) => `${a.live?.status ?? '-'}`).join(), ...['resumeAll', 'startNewAll', 'archiveAll', 'removeAll'].map((k) => !!runningActions[`${k}:${project.path}`])].join('|')
    : ''
  const folds = useFolds(header, headerWidth, headerContent, HEADER_FOLDS, headerNeed)
  const tight = folds >= 1
  const cramped = folds >= 2
  const activeInMenu = folds >= 3
  const shortState = folds >= 4
  const runInMenu = folds >= 5
  // The status badge's table as text, for its accessible description (#529).
  const agentsDescription = useAgentsText(project)
  const cards = useStore((s) => s.tasks)
  const startFailures = useStore((s) => s.startFailures)
  // An agent starting or resuming (#1177): what would start it again waits.
  const anyStarting = !!useProjectStarting(project?.path ?? '')

  if (!workspace) return null

  if (!project) {
    return (
      <div className="tab-body" style={{ display: visible ? undefined : 'none' }}>
        <TerminalLayer visibleFor={null} panes={[]} />
        <div className="empty-state" style={{ paddingTop: '20vh' }}>
          <Icon name="files" />
          {tr(workspace.projects.length ? M.selectProject : M.createFirst)}
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => void actions.createProject()}>
              <Icon name="new-folder" /> {tr(M.newProject)}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // The header is about the project: its status speaks for all its agents. Each agent's details and
  // controls are in its pane's header and footer.
  const live = focusedAgent?.live ?? null
  const many = project.agents.length > 1
  // Its agents' states in one line, with the most urgent's mark (#974): idle ones too, the stopped apart (#1035), so
  // Stop's and Resume's counts read beside it: "3 working · 7 idle · 2 stopped".
  const states = projectAgentStates(project, cards, (id) => !!startFailures[projectKey(project.path, id)])
  const running = project.agents.filter((a) => a.live)
  const resumable = agentsToResume(project.agents)
  const resuming = !!runningActions[`resumeAll:${project.path}`]
  const startingAll = !!runningActions[`startNewAll:${project.path}`]
  const archivingAll = !!runningActions[`archiveAll:${project.path}`]
  const removingAll = !!runningActions[`removeAll:${project.path}`]
  // How many agents each batch action acts on, as its confirmation lists them (#275): shown in its label.
  const counts = batchCounts(project.agents)
  // Short labels, the full wording in the tooltip and the accessible name (#1035).
  const resumeLabel = resumable.length === 1 ? tr(M.resumeAgent) : tr(M.resumeShort, { count: resumable.length })
  // Running agents a refused sign-in stopped are carried on, the stopped ones resumed (#309).
  const stalled = resumable.filter((a) => stalledOnSignIn(a.live)).length
  const stoppedCount = resumable.length - stalled
  const resumeTip =
    resumable.length === 1
      ? tr(stalled ? M.carryOn : M.resumeOne, { agent: resumable[0].name })
      : stalled
        ? tr(M.carryOnMany, { stopped: stoppedCount, stalled })
        : tr(M.resumeMany, { count: resumable.length })
  const stopLabel = running.length === 1 ? tr(M.stopAgent) : tr(M.stopMany, { count: running.length })
  const stopTip = tr(M.stopTip, { count: running.length })
  const yes = many ? 'yes' : 'no'
  // Agents ▾ (#974): every agent at once, after one confirmation (#216), Remove All last after a line (#291); with one
  // agent, no count. In ⋯ when cramped.
  const batch: MenuEntry[] = [
    ...(counts.startNew ? [{ label: tr(M.startNew, { many: yes, count: counts.startNew }), icon: 'add', action: 'start' as const, disabled: startingAll || anyStarting, onClick: () => void actions.startNewAll(project.path) }] : []),
    // Start Fresh (Idle Agents) (#1437): only the idle running ones, after one question saying who and why not.
    ...(running.length ? [{ label: tr(M.startFreshIdle), icon: 'refresh', action: 'start' as const, disabled: !!runningActions[`startFreshIdle:${project.path}`] || anyStarting, onClick: () => void actions.startFreshIdle(project.path) }] : []),
    ...(counts.archive ? [{ label: tr(M.archiveNew, { many: yes, count: counts.archive }), icon: 'archive', action: 'archive-start' as const, disabled: archivingAll || anyStarting, onClick: () => void actions.startNewAll(project.path, true) }] : []),
    ...(project.agents.length
      ? [...(counts.startNew || counts.archive ? [{ separator: true as const }] : []), { label: tr(M.removeAllMenu, { many: yes, count: project.agents.length }), icon: 'trash', action: 'remove' as const, disabled: removingAll, onClick: () => void actions.removeAllAgents(project.path) }]
      : [])
  ]
  const dangerous = settings
    ? project.agents.flatMap((a) => {
        const l = agentLaunchSettings(agentProviderOf(a), a, settings)
        // The mode in effect: on the CLI's own setting, the one its CLI showed (#1284).
        const m = modeOption(l.provider, (a.live ? modeInEffect(a.live) : undefined) ?? l.permissionMode)
        return m?.danger ? [many ? tr(M.dangerousMode, { agent: a.name, mode: m.label }) : m.label] : []
      })
    : []
  const bypass = dangerous.length > 0

  const restart = async (): Promise<void> => {
    if (!live) return
    // Read the name first: a session that never got a message is dropped from the list when it stops.
    const item = (await call('session:list', project.path)).find((s) => s.id === live.sessionId)
    await call('session:stop', project.path, live.agentId)
    const start = Date.now()
    while (Date.now() - start < 8000 && (await call('session:live')).some((l) => l.projectPath === project.path && l.agentId === live.agentId)) await new Promise((r) => setTimeout(r, 150))
    await actions.resumeSession(project.path, { id: live.sessionId, recache: null, title: null, name: item?.name, agentId: live.agentId, cwd: item?.cwd }, live.agentId)
  }

  return (
    <div style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="project-header" ref={headerRef}>
        <div className="flex project-title">
          <h1 title={project.name}>{project.name}</h1>
          {/* With no agents, nothing: the Session tab says so (#974). */}
          {states.length > 0 && (
            <Tooltip content={<ProjectAgentsTable project={project} />} className="agents-tip" focus>
              <span tabIndex={0} aria-description={agentsDescription || undefined} className="badge project-state">
                {/* Every agent stopped: the stopped mark, grey (HI-1908), as the session toolbar's chip has it. */}
                <StateMark state={mostUrgent(states)} decorative className={allStopped(project.agents, states) ? 'stopped' : undefined} />
                <span className="badge-text">{shortState ? projectStateShort(project.agents, states) : projectStateSummary(project.agents, states)}</span>
              </span>
            </Tooltip>
          )}
        </div>
        <div className="actions">
          {!activeInMenu && (
            <Tooltip content={tr(project.active ? M.workingOn : M.notWorkingOn)}>
              <label className="flex muted" style={{ cursor: 'pointer', marginRight: tight ? 0 : 6 }} aria-label={tight ? tr(M.active) : undefined}>
                <Switch checked={project.active} onChange={(v) => void actions.setProjectActive(project.path, v)} />
                {!tight && ` ${tr(M.active)}`}
              </label>
            </Tooltip>
          )}
          {resumable.length > 0 && !runInMenu && (
            <Tooltip content={resumeTip}>
              <button className="btn act-resume quiet" disabled={resuming || anyStarting} aria-busy={resuming || undefined} aria-label={resumeTip} onClick={() => void actions.resumeAllAgents(project.path)}>
                <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} />
                {!tight && ` ${resuming ? tr(M.resuming) : resumeLabel}`}
                {tight && resumable.length > 1 && <span className="btn-count">{resumable.length}</span>}
              </button>
            </Tooltip>
          )}
          {running.length > 0 && !runInMenu && (
            <Tooltip content={stopTip}>
              <button className="btn act-stop quiet" aria-label={stopTip} onClick={() => void actions.stopAllAgents(project.path)}>
                <Icon name="stop-circle" />
                {!tight && ` ${stopLabel}`}
                {tight && running.length > 1 && <span className="btn-count">{running.length}</span>}
              </button>
            </Tooltip>
          )}
          {/* Every agent at once, after one confirmation (#216): in Agents ▾ (#974), in ⋯ when even its icon doesn't fit. */}
          {batch.length > 0 && !cramped && (
            <Tooltip content={tr(M.agentsMenuTip)}>
              <button className="btn agents-menu" aria-haspopup="menu" aria-expanded={agentsMenu.shown} aria-label={tight ? tr(M.agentsMenu) : undefined} onClick={(e) => agentsMenu.openAt(...menuBelow(e.currentTarget), batch, e.detail === 0)}>
                <Icon name="organization" />
                {!tight && ` ${tr(M.agentsMenu)}`}
                <Icon name="chevron-down" />
              </button>
            </Tooltip>
          )}
          <IconButton
            icon="ellipsis"
            title={tr(M.more)}
            action="project-menu"
            onClick={(e) =>
              menu.open(e, [
                // At the narrowest (#1051), what folded away, in the header's order: Active, Resume, Stop, Agents ▾'s.
                ...(activeInMenu ? [{ label: tr(M.active), icon: project.active ? 'check' : undefined, detail: tr(project.active ? M.workingOn : M.notWorkingOn), onClick: () => void actions.setProjectActive(project.path, !project.active) }] : []),
                ...(runInMenu && resumable.length ? [{ label: resumeTip, icon: 'debug-continue', action: 'resume' as const, disabled: resuming || anyStarting, onClick: () => void actions.resumeAllAgents(project.path) }] : []),
                ...(runInMenu && running.length ? [{ label: stopTip, icon: 'stop-circle', action: 'stop' as const, onClick: () => void actions.stopAllAgents(project.path) }] : []),
                ...(activeInMenu ? [{ separator: true as const }] : []),
                ...(cramped && batch.length ? [...batch, { separator: true as const }] : []),
                { label: tr(M.explorer), icon: 'folder-opened', onClick: () => void call('project:openInExplorer', project.path) },
                { label: tr(M.terminal), icon: 'terminal', onClick: () => void call('project:openTerminal', project.path) },
                { separator: true },
                { label: tr(M.projectSettings), icon: 'settings', onClick: () => setProjectTab(project.path, 'settings') },
                { separator: true },
                { label: tr(M.removeProject), icon: 'trash', onClick: () => set({ removeProjectFor: project.path }) }
              ])
            }
          />
        </div>
      </div>

      {/* Its hooks aren't reaching Hive (#1336): its status may be wrong; a restart with working hooks clears it. */}
      {live?.hooksMissing && (
        <div className="banner warn hooks-missing">
          <Icon name="warning" /> {hooksMissingNote(live, tr)}
          <button className="btn small primary" onClick={() => void restart()}>
            {tr(M.restart)}
          </button>
        </div>
      )}
      {focusedAgent?.restartNeeded && live && (
        <div className="banner warn">
          <Icon name="refresh" /> {tr(M.restartNeeded, { many: yes, agent: focusedAgent.name })}
          <button className="btn small primary" onClick={() => void restart()}>
            {tr(M.restart)}
          </button>
          {/* A connection to switch to (HI-1755): once its turn is over, never mid-turn. */}
          {live.launchedConnection && !live.switchPending && (
            <button className="btn small" onClick={() => void call('session:switchConnection', project.path, focusedAgent.id).catch((e) => notify('error', tr(M.switchFailed), errorMessage(e)))}>
              {tr(M.restartWhenDone)}
            </button>
          )}
        </div>
      )}
      <ConnectionSetupBanner project={project} />
      <RemovedDataBanner project={project} />
      {project.unmanagedMcp.length > 0 && (
        <div className="banner warn">
          <Icon name="plug" /> {Children.toArray(tRich<React.ReactNode>(M.unmanagedMcp, { names: fmt.list(project.unmanagedMcp, 'unit'), b: bold }))}
          <button className="btn small" onClick={() => void actions.importProjectMcp(project.path, project.unmanagedMcp)}>
            {tr(M.copyToWorkspace)}
          </button>
        </div>
      )}
      {bypass && (
        <div className="banner danger">
          <Icon name="warning" /> {tr(M.dangerous, { modes: fmt.list(dangerous, 'unit'), count: dangerous.length })}
          <button className="btn small" onClick={() => setProjectTab(project.path, 'settings')}>
            {tr(M.change)}
          </button>
        </div>
      )}

      <ProjectTabStrip project={project} tab={tab} live={!!live} />

      <div className="tab-body" ref={bodyRef}>
        {tab === 'session' && <SessionToolbar project={project} view={view} />}
        <div className={cx('agents-area', tab === 'session' && panesShown ? 'shown' : 'hidden', !!tileFocus && 'tile-focus')} style={tileFocus ? { left: stripWidth } : undefined}>
          <TerminalLayer visibleFor={terminalVisibleFor} panes={panes} />
          {tab === 'session' && panesShown && <PaneChrome project={project} panes={panes} />}
          {tab === 'session' && view === 'panes' && panes.length === 1 && !live && <SessionEmpty project={project} framed={!!focusedAgent} />}
        </div>
        {tab === 'session' && view === 'tiles' && <AgentTiles project={project} />}
        <ErrorBoundary view="tab" resetKey={`${project.path}|${tab}`}>
          {tab === 'overview' && <OverviewTab project={project} />}
          {tab === 'performance' && <PerformanceTab project={project} />}
          {tab === 'tasks' && <ProjectTasksTab project={project} />}
          {tab === 'sessions' && <SessionsTab project={project} />}
          {tab === 'files' && <FilesTab project={project} />}
          {tab === 'images' && <AttachmentsTab project={project} />}
          {tab === 'changes' && <VersionControl project={project} />}
          {tab === 'activity' && <ActivityTab key={project.path} project={project} />}
          {tab === 'memory' && <MemoryTab project={project} />}
          {tab === 'skills' && <ProjectSkillsTab project={project} />}
          {tab === 'templates' && <ProjectTemplatesTab project={project} />}
          {tab === 'mcp' && <ProjectMcpTab project={project} />}
          {tab === 'settings' && <ProjectSettingsTab project={project} />}
        </ErrorBoundary>
      </div>
      {menu.element}
      {agentsMenu.element}
    </div>
  )
}

/**
 * Asks for a connection (HI-1755, Darren's 1a): in a project whose agents' CLI has connections but none is on in its
 * workspace, nothing of that CLI starts (it never falls back to the CLI's own login): Add a Connection opens Settings →
 * Connections. Not asked for a test copy on its CLI test home.
 */
function ConnectionSetupBanner({ project }: { project: ProjectInfo }) {
  useLanguage()
  const view = useConnections()
  const settings = useStore((s) => s.settings)
  const cli = [...new Set(project.agents.map((a) => agentProviderOf(a)))].find((p) => needsConnection(view, p))
  if (!cli || !settings) return null
  return <NoConnectionBanner cli={cli} />
}
