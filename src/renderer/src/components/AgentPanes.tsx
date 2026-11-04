import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CardChip, useAgentCards, useAgentReviews } from './CardChip'
import { StateMark } from './StateMark'
import { AGENT_STATE_LABEL, AGENT_STATES, agentState, allStopped, mostUrgent as mostUrgentState, projectAgentStates, projectStateSummary } from '@shared/agentState'
import { agentDoingCards } from '@shared/tasks'
import { cardsText } from '@shared/agentTable'
import { cardLabel } from '@shared/projectKeys'
import { modelCaps, serverModelLabel } from '@shared/models'
import { serverDefaultModel, serverModelOf } from '@shared/serverConnection'
import { launchedName } from '@shared/connectionLabel'
import { agentChoosesMcp, agentMcpText } from '@shared/agentMcp'
import { SESSION_LAYOUTS, agentLimitText, agentsPerPage, compactThreshold, contextPercent, agentModelShown, effortLabel, footerChoices, isCompacting, layoutPanes, mergeBlocked, mostUrgent, projectLayout, sessionInAgentFolder, transcriptWarnLimit, unmergedWork } from '@shared/defaults'
import { cellPage, cellPageCount, neighbourCell, pageCells, pageIds, type CellDirection } from '@shared/paneCells'
import { agentLimit, inboxSwitchNow, useAgentLimit } from '../advanced'
import type { AgentInfo, LiveSessionState, PageLayout, ProjectInfo, SessionLayout, SessionListItem, SessionUsage, SessionView } from '@shared/types'
import { shownProblem, templateAgentNames, type TemplateEntry, type TemplateScope } from '@shared/templates'
import { templateTitle } from '@shared/templateDefaults'
import { WORKFLOW_ROLE_TEXT } from '@shared/workflow/roles'
import type { StartFailure } from '@shared/startFailure'
import type { AgentLeftovers } from '@shared/agentProcesses'
import { fmt, msg, tr, tRich } from '@shared/i18n'
import { watchText } from '@shared/agentWatch'
import { formatDateTime, formatTime, formatWhen } from '@shared/dates'
import * as actions from '../actions'
import { freshShort, freshTip } from '../freshResume'
import { HAND_OVER_TEXT, handOverNow, onRunningLane } from '@shared/handOver'
import { call } from '../api'
import { templateList, templatesStillHere } from '../templateList'
import { NO_IDS, NO_PROJECTS, agentPage, get, agentProviderOf, clearStartFailure, closeTile, focusAgent, focusedAgentId, isAssistantPath, notify, openActivity, openInSessionsTab, paneAssignment, paneCells, projectKey, prompt, revealAgent, seenAgents, set, setProjectTab, showAgent, openVersionControl, showAttachments, showInOverview, showPage, shownLayout, startingKey, startingLabel, useLanguage, useStarting, useStore } from '../store'
import { useLiveUsage, useLiveUsageState } from '../usage'
import { commandKeybinding } from '../commands'
import { cx, formatKeybinding, formatTokens, sessionLabel, timeAgo } from '../util'
import { formatSize } from '@shared/units'
import { FREE_LOCAL, moneyLabel } from '@shared/usageTotals'
import { TerminalView } from './TerminalView'
import { stoppedLabel, stoppedLine, useStoppedEnd } from '../stopped'
import { focusTileAfter, TilePager } from './AgentTiles'
import { offerTip } from '../tips'
import { chooseFocus } from '../deferredFocus'
import { onStripMenu, takeStripMenu, type StripMenu } from '../stripMenus'
import { ModeBadge } from './PermissionMode'
import { contextLines, providerDescriptor, providerName } from '@shared/providers'
import { safeguardText } from '@shared/safeguards'
import { unpricedModel, unpricedText } from '@shared/prices'
import { hooksMissingNote, hooksMissingText, retryWaitText, unknownStateText } from '@shared/runtime'
import { retryWaitsView } from '@shared/toolReplies'
import { Icon, IconButton, ReviewMark, SafeguardMark, signInNote, statusText, Tooltip, useContextMenu, useFolds, type MenuEntry } from './ui'
import { useConnections } from './ConnectionChoice'
import { startBlockedReason, useStartBlocked } from './BoardUpgrade'
import { awayFromProject, legacyOf, placeText, placeTip } from '../agentPlace'
import { legacySetupPending } from '@shared/agentFolders'

/** Height of an agent pane's header (who it is, its controls) and footer (its session's details). */
export const PANE_HEADER = 26
export const PANE_FOOTER = 24

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function paneRect(count: number, i: number): Rect {
  if (count === 4) return { x: (i % 2) * 50, y: Math.floor(i / 2) * 50, w: 50, h: 50 }
  if (count === 6) return { x: ((i % 3) * 100) / 3, y: Math.floor(i / 3) * 50, w: 100 / 3, h: 50 }
  const w = 100 / count
  return { x: i * w, y: 0, w, h: 100 }
}

function rectStyle(r: Rect): CSSProperties {
  return { left: `${r.x}%`, top: `calc(${r.y}% + ${PANE_HEADER}px)`, width: `${r.w}%`, height: `calc(${r.h}% - ${PANE_HEADER + PANE_FOOTER}px)`, right: 'auto', bottom: 'auto' }
}

/** Which agent each pane of the selected project shows. */
export function usePanes(project: ProjectInfo | null): (string | null)[] {
  const focused = useStore((s) => (project ? s.focusedAgent[project.path] : undefined))
  // Fewer columns while they don't fit (#1037).
  useStore((s) => s.paneColumns)
  if (!project) return []
  return paneAssignment(project, focused && project.agents.some((a) => a.id === focused) ? focused : focusedAgentId(project))
}

/**
 * Terminals for every agent that has had a session in this run, in every project. Kept mounted so
 * switching projects is instant; the selected project's are placed in their panes.
 */
export function TerminalLayer({ visibleFor, panes }: { visibleFor: string | null; panes: (string | null)[] }) {
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const epochs = useStore((s) => s.sessionEpoch)
  // A stopped agent's terminal is dimmed (HI-1881): not while it starts again (from the accepted click), nor after a
  // failed start (its failed bar says why).
  const starting = useStore((s) => s.starting)
  const failures = useStore((s) => s.startFailures)
  return (
    <>
      {projects.flatMap((p) =>
        p.agents.map((a) => {
          const key = projectKey(p.path, a.id)
          if (!a.live && epochs[key] === undefined) return null
          const i = visibleFor === p.path ? panes.indexOf(a.id) : -1
          return (
            <TerminalView
              key={`${key}:${epochs[key] ?? 0}`}
              ptyKey={key}
              visible={i >= 0}
              style={i >= 0 ? rectStyle(paneRect(panes.length, i)) : undefined}
              projectPath={p.path}
              agentId={a.id}
              provider={agentProviderOf(a)}
              autoFocus={i >= 0 && (panes.length === 1 || useStore.getState().focusedAgent[p.path] === a.id)}
              onFocus={() => focusAgent(p.path, a.id)}
              dimmed={!a.live && !starting[startingKey(p.path, a.id)] && !failures[key]}
            />
          )
        })
      )}
    </>
  )
}

function LayoutGlyph({ layout }: { layout: SessionLayout }) {
  const n = layoutPanes(layout)
  return (
    <span className={cx('layout-glyph', (layout === 'grid' || layout === 'grid6') && layout)}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Resuming: this agent's last session, or one picked from the list
// ---------------------------------------------------------------------------

const PICKER_MAX = 10

/** The picker's entries: sessions from the agent's folder, newest first; ones open in another agent are greyed and show that agent. */
function sessionPickerItems(project: ProjectInfo, a: AgentInfo, list: SessionListItem[]): MenuEntry[] {
  const holders = new Map(project.agents.filter((x) => x.live).map((x) => [x.live!.sessionId, x]))
  const many = project.agents.length > 1
  // Conversations only: a sub-session (a Codex guardian review, say) is never resumed.
  const all = list.filter((s) => s.source === 'hive' && !s.archived && !s.sub && sessionInAgentFolder(project.path, a, s))
  const items: MenuEntry[] = [
    {
      header: true,
      label: many
        ? tr(msg({ id: 'panes.resume.headerIn', defaultMessage: 'Resume in {agent}', description: "Heading of the session picker (an agent's Resume ▾): the sessions listed resume in this agent ({agent}: its name)." }), { agent: a.name })
        : tr(msg({ id: 'panes.resume.header', defaultMessage: 'Resume a session', description: "Heading of the session picker (an agent's Resume ▾) in a project with one agent." }))
    }
  ]
  if (!all.length) items.push({ label: tr(msg({ id: 'panes.resume.none', defaultMessage: 'No sessions to resume here yet', description: 'The session picker when the agent has no session to resume.' })), disabled: true })
  for (const s of all.slice(0, PICKER_MAX)) {
    const holder = holders.get(s.id)
    const ranBy = project.agents.find((x) => x.id === s.agentId)
    const bits = [timeAgo(s.lastActivity)]
    if (holder) bits.push(tr(msg({ id: 'panes.resume.openIn', defaultMessage: 'open in {agent} — click to show it', description: "A session in the session picker that another agent has open ({agent}: its name). Lower case: it follows how long ago it ran." }), { agent: holder.name }))
    else {
      if (many && !legacyOf(a) && ranBy && ranBy.id !== a.id) bits.push(tr(msg({ id: 'panes.resume.lastRunBy', defaultMessage: 'last run by {agent}', description: 'A session in the session picker that another agent ({agent}: its name) ran last. Lower case.' }), { agent: ranBy.name }))
      if (s.fresh) bits.push(freshShort())
      else if (s.recache && !s.recache.warm && s.recache.tokens > 20000) bits.push(tr(msg({ id: 'panes.resume.recache', defaultMessage: 'cache expired, ~{tokens} to re-cache', description: "A session in the session picker whose prompt cache has expired: resuming it re-reads about {tokens} tokens (\"120K\"). Lower case." }), { tokens: formatTokens(s.recache.tokens) }))
    }
    items.push({
      label: sessionLabel(s, project.name, tr),
      detail: bits.join(' · '),
      icon: holder ? 'circle-filled' : s.id === a.resume?.id ? 'debug-continue' : 'history',
      muted: !!holder,
      onClick: () => (holder ? revealAgent(project, holder.id) : void actions.resumeSession(project.path, s, a.id))
    })
  }
  items.push(
    { separator: true },
    {
      label: all.length > PICKER_MAX ? tr(msg({ id: 'panes.resume.allSessions', defaultMessage: 'All {n, number} Sessions…', description: 'Last item of the session picker when it lists only the newest: opens the Sessions tab with all {n}.' }), { n: all.length }) : tr(msg({ id: 'panes.resume.sessionsTab', defaultMessage: 'Sessions Tab…', description: "Last item of the session picker: opens the project's Sessions tab." })),
      icon: 'history',
      onClick: () => setProjectTab(project.path, 'sessions')
    }
  )
  return items
}

/** A menu listing the sessions an agent can resume. */
function useSessionPicker() {
  const menu = useContextMenu()
  const openAt = async (project: ProjectInfo, a: AgentInfo, x: number, y: number): Promise<void> => {
    const list = await actions.attempt(tr(msg({ id: 'panes.resume.listFailed', defaultMessage: 'Could not list sessions', description: "An error's title: the session picker couldn't read the sessions." })), () => call('session:list', project.path))
    if (list) menu.openAt(x, y, sessionPickerItems(project, a, list))
  }
  const openBelow = (el: Element, project: ProjectInfo, a: AgentInfo): void => {
    const r = el.getBoundingClientRect()
    void openAt(project, a, r.left, r.bottom + 2)
  }
  return { openAt, openBelow, element: menu.element }
}

function resumeTip(project: ProjectInfo, a: AgentInfo): string {
  // HI-2540: its conversation can't continue, so Resume starts a new one: said before it is pressed.
  if (a.resume?.fresh) return freshTip(a.resume.fresh, sessionLabel(a.resume, project.name))
  if (a.resume) return tr(msg({ id: 'panes.resume.tip', defaultMessage: 'Resume "{session}", last active {when}', description: "Tooltip of an agent's Resume button: the session it resumes ({session}: its name) and when it was last active ({when}: \"5 min ago\")." }), { session: sessionLabel(a.resume, project.name), when: timeAgo(a.resume.lastActiveAt) })
  if (project.agents.length > 1) return tr(msg({ id: 'panes.resume.noneOfAgent', defaultMessage: '{agent} has no session of its own to resume. Choose one with ▾, or start a new one.', description: "Tooltip of an agent's Resume button when the agent ({agent}: its name) has no session to resume. ▾ is the button beside it." }), { agent: a.name })
  return tr(msg({ id: 'panes.resume.noneOwn', defaultMessage: 'There is no session of its own to resume. Choose one with ▾, or start a new one.', description: "Tooltip of the Resume button when the project's agent has no session to resume. ▾ is the button beside it." }))
}

/** The colour every secondary Resume button wears (agent panes, the project header, the Assistant's panel): Resume's (#344). */
export const RESUME_TINT = 'act-resume'

const RESUME = msg({ id: 'panes.resume.button', defaultMessage: 'Resume', description: "Button (an agent's pane, its menu): resumes the agent's last session. Keep it short." })
const NEW_SESSION = msg({ id: 'panes.session.new', defaultMessage: 'New Session', description: 'Button and menu item (an agent\'s pane): starts the agent in a new conversation. Keep it short.' })
const RESUME_SESSION = msg({ id: 'panes.resume.pick', defaultMessage: 'Resume a Session…', description: "Menu item (an agent's pane): opens the session picker to resume one of its sessions." })
const MERGE = msg({ id: 'panes.agent.merge', defaultMessage: 'Merge…', description: "Button and menu item (a worktree agent's pane): opens the merge dialog for its branch." })
const HOOKS = msg({ id: 'panes.menu.hooks', defaultMessage: 'Hooks…', description: "Menu item (an agent's menu): opens its Hooks dialog: the hooks its session has, and what Hive received from them. The … says it opens a dialog: keep it." })
const AGENT_SETTINGS = msg({ id: 'panes.agent.settings', defaultMessage: 'Agent Settings…', description: "Menu item and button (an agent's pane): opens the agent's settings." })
const STOP = msg({ id: 'panes.agent.stop', defaultMessage: 'Stop', description: "Button and menu item (an agent's pane): stops the agent's session (the conversation is kept). Keep it short." })

/** Resume split button: the main part resumes the agent's last session, ▾ picks another. */
export function ResumeButton({ project, a, className, label }: { project: ProjectInfo; a: AgentInfo; className?: string; label?: string }) {
  useLanguage()
  const picker = useSessionPicker()
  // Its workspace's 1.0 upgrade waits (#1230): no session can start.
  const blocked = useStartBlocked()
  // From the click until the session runs (#1177).
  const starting = useStarting(project.path, a.id)
  const resuming = starting?.kind === 'resume'
  const choose = tr(msg({ id: 'panes.resume.choose', defaultMessage: 'Choose a session to resume', description: "Tooltip and accessible name of the ▾ beside an agent's Resume button: opens the session picker." }))
  return (
    <span className="split-btn">
      <Tooltip content={blocked ?? resumeTip(project, a)}>
        {/* Its label can fold away in a very narrow bar (#890): the name stays for screen readers. */}
        <button className={cx('btn', className)} disabled={!a.resume || !!blocked || !!starting} aria-busy={resuming || undefined} onClick={() => void actions.resumeLast(project.path, a.id)} aria-label={resuming ? startingLabel(starting) : (label ?? tr(RESUME))}>
          <Icon name={resuming ? 'loading' : 'debug-continue'} spin={resuming} /> <span className="btn-label">{resuming ? startingLabel(starting) : (label ?? tr(RESUME))}</span>
        </button>
      </Tooltip>
      <Tooltip content={blocked ?? choose}>
        <button className={cx('btn', 'split-caret', className)} disabled={!!blocked || !!starting} onClick={(e) => picker.openBelow(e.currentTarget, project, a)} aria-label={choose}>
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      {picker.element}
    </span>
  )
}

/**
 * A running session's name (see sessionLabel): the latest rename, else its title, else when the conversation began (its
 * record's time, as in the Sessions tab: a resumed one's isn't this launch's).
 */
function liveSessionLabel(project: ProjectInfo, live: LiveSessionState, usage: SessionUsage | null | undefined): string {
  return sessionLabel({ id: live.sessionId, name: live.sessionName, title: usage?.title, customTitle: usage?.customTitle, titleAtRename: live.titleAtRename, startedAt: live.sessionCreatedAt || live.startedAt }, project.name, tr)
}

async function renameSession(project: ProjectInfo, sessionId: string, current: string): Promise<void> {
  const name = (await prompt({ title: tr(msg({ id: 'panes.session.renameTitle', defaultMessage: 'Rename session', description: "Title of the dialog renaming an agent's session (from its footer)." })), initial: current, confirmLabel: tr(msg({ id: 'panes.session.renameButton', defaultMessage: 'Rename', description: 'Button of the dialog renaming a session.' })) }))?.trim()
  if (!name || name === current) return
  await actions.attempt(tr(msg({ id: 'panes.session.renameFailed', defaultMessage: 'Could not rename', description: "An error's title: renaming a session failed." })), () => call('session:rename', project.path, sessionId, name))
}

/**
 * The session an agent is running, in its menu (#978: an icon in its footer before): Open in Sessions Tab, with the
 * session's name and when it started as its detail, Show Session's Attachments (HI-1841) and Rename Session….
 */
function sessionItems(project: ProjectInfo, live: LiveSessionState | null | undefined, usage: SessionUsage | null | undefined): MenuEntry[] {
  if (!live || live.settingUp || !live.sessionId) return []
  const label = liveSessionLabel(project, live, usage)
  const id = live.sessionId
  return [
    { label: tr(msg({ id: 'panes.session.openInTab', defaultMessage: 'Open in Sessions Tab', description: "Menu item (an agent's menu): reads its running session in the Sessions tab; the session's name and start are its detail." })), icon: 'comment-discussion', detail: tr(msg({ id: 'panes.session.detail', defaultMessage: '{session} · since {since}', description: "The detail of Open in Sessions Tab in an agent's menu: the running session's name and when it started ({since}: a date and time)." }), { session: label, since: formatDateTime(live.startedAt) }), onClick: () => openInSessionsTab(project.path, id) },
    // Its own session's files in the project's Attachments tab (HI-1841); the Assistant's are in its own view.
    ...(isAssistantPath(project.path) ? [] : [{ label: tr(msg({ id: 'panes.session.showAttachments', defaultMessage: "Show Session's Attachments", description: "Menu item (an agent's menu, HI-1841): opens the project's Attachments tab on Pane attachments, at the files pasted or dropped into this running session." })), icon: 'attach', onClick: () => showAttachments(project.path, { session: id }) }]),
    { label: tr(msg({ id: 'panes.session.renameItem', defaultMessage: 'Rename Session…', description: "Menu item (an agent's menu): renames its running session." })), icon: 'tag', onClick: () => void renameSession(project, id, label) }
  ]
}

// Dragging an agent (its pane header, or its tile in the Tiles view, #993) changes the project's order, which the panes
// and tiles follow (#135): dropped on another agent's pane or tile the two swap, on an empty pane to the end, on a page
// button to the end of that page (held over one, that page shows).
const AGENT_DRAG = 'application/x-hive-agent'

export function agentDragProps(project: ProjectInfo, a: AgentInfo) {
  // A lone agent too, in panes side by side: it can go to any cell (#762).
  if (isAssistantPath(project.path) || (project.agents.length < 2 && !actions.panesPlaced(project))) return {}
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(AGENT_DRAG, a.id)
      e.dataTransfer.setData('text/plain', a.name)
      // After the browser has taken its drag image: drop targets appear over the panes.
      setTimeout(() => set({ agentDrag: { project: project.path, id: a.id } }), 0)
    },
    onDragEnd: () => set({ agentDrag: null })
  }
}

/** The agent being dragged in this project, if any. */
export function useAgentDrag(project: ProjectInfo): string | null {
  return useStore((s) => (s.agentDrag?.project === project.path ? s.agentDrag.id : null))
}

export function dropAgent(project: ProjectInfo, index: number): void {
  const id = useStore.getState().agentDrag?.id
  set({ agentDrag: null })
  if (id) void actions.moveAgent(project.path, id, index)
}

/** A dragged agent dropped on a cell of the panes (#762): it moves there, swapping with the agent there if any. */
export function placeDrop(project: ProjectInfo, cell: number): void {
  const id = useStore.getState().agentDrag?.id
  set({ agentDrag: null })
  if (id) actions.placeAgent(project.path, id, cell)
}

/** A dragged agent dropped on another's pane or tile: they swap places (#135, #993). */
export function swapDrop(project: ProjectInfo, otherId: string): void {
  const id = useStore.getState().agentDrag?.id
  set({ agentDrag: null })
  if (id && id !== otherId) void actions.swapAgents(project.path, id, otherId)
}

/** Up to this many agent pages show a button each; more show the compact pager (#562): 12 agents in two columns are six. */
const PAGE_BUTTONS_MAX = 6
/** How long a dragged agent hovers over a page button before that page shows, so it can be dropped on one of its panes. */
export const PAGE_HOVER_MS = 600

/** Shown over another agent's pane or tile while an agent is dragged onto it. */
export const SWAP_WITH = msg({ id: 'panes.drop.swap', defaultMessage: 'Swap with {agent}', description: "Shown over another agent's pane (or its tile in the Tiles view) while an agent is dragged onto it: dropping swaps the two ({agent}: the other agent's name)." })

/**
 * Ends a drag Hive is tracking when the browser's own end of it can't reach its source: a pane header dragged to another
 * page is no longer on screen to get `dragend` (Escape, or a drop outside any target). Ended at once by Escape (its
 * keyup: the browser's drag takes the keydown), the button's release with no drop to take it, a dragleave that nothing
 * follows, any drop or drag end in the window, or the mouse moving with no button down.
 */
function useDragCleanup(): void {
  const dragging = useStore((s) => !!s.agentDrag)
  useEffect(() => {
    if (!dragging) return
    const clear = (): void => {
      if (useStore.getState().agentDrag) set({ agentDrag: null })
    }
    // Over: after the drop's own handlers.
    const end = (): void => void setTimeout(clear, 0)
    const move = (e: MouseEvent): void => {
      if (e.buttons === 0) end()
    }
    // Escape cancels at once (#135). The browser's own drag takes its keydown; the page gets the keyup.
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clear()
    }
    // The button let go with no drop to take it (a cancelled drag): over, after any drop's own handlers.
    const up = (): void => void setTimeout(clear, 0)
    // A cancelled drag (Escape in the browser's own drag, a release outside the window) ends with a dragleave at the
    // element under the pointer and nothing after it; moving between elements sends the next one's dragenter just
    // before the dragleave. So a dragleave with no dragenter just before it, and no drag event after it, ends the drag.
    let entered = 0
    let pending: ReturnType<typeof setTimeout> | undefined
    const enter = (): void => {
      entered = Date.now()
      clearTimeout(pending)
    }
    const over = (): void => clearTimeout(pending)
    const leave = (): void => {
      if (Date.now() - entered < 50) return
      clearTimeout(pending)
      pending = setTimeout(clear, 100)
    }
    document.addEventListener('drop', end)
    document.addEventListener('dragend', end, true)
    document.addEventListener('mousemove', move)
    document.addEventListener('keydown', key, true)
    document.addEventListener('keyup', key, true)
    document.addEventListener('mouseup', up, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('dragenter', enter, true)
    document.addEventListener('dragover', over, true)
    document.addEventListener('dragleave', leave, true)
    return () => {
      clearTimeout(pending)
      document.removeEventListener('drop', end)
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('keyup', key, true)
      document.removeEventListener('mouseup', up, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('dragenter', enter, true)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('dragleave', leave, true)
    }
  }, [dragging])
}


const REMOVE_AGENT = msg({ id: 'panes.menu.remove', defaultMessage: 'Remove Agent…', description: "Menu item (an agent's menu): removes the agent from the project (asks first)." })
const CANCEL_WATCH_FAILED = msg({ id: 'panes.watchCancel.failed', defaultMessage: 'Could not cancel the watch', description: "An error's title: ending an agent's watch failed." })
const FROM_TEMPLATE = msg({ id: 'panes.add.fromTemplate', defaultMessage: 'Add Agent from Template', description: "Menu item (+ Add ▾ in the session toolbar, and the Add Agent button's ▾): adds one agent of a saved template." })
const CONFIGURE_AGENT = msg({ id: 'panes.add.configure', defaultMessage: 'Configure Agent and Add…', description: 'Menu item (+ Add ▾ in the session toolbar, and the Add Agent button\'s ▾): opens the Add Agent dialog (provider, where it works, settings).' })

const MOVE_LEFT = msg({ id: 'panes.menu.moveLeft', defaultMessage: 'Move Left', description: "Menu item (an agent's menu): moves the agent one place left among the project's agents (its pane one cell left, panes side by side)." })
const MOVE_RIGHT = msg({ id: 'panes.menu.moveRight', defaultMessage: 'Move Right', description: "Menu item (an agent's menu): moves the agent one place right among the project's agents (its pane one cell right, panes side by side)." })

/**
 * Move Left / Move Right, for a project with several agents (they cross pages at the edges). `nudge`: how it moves (the
 * Tiles view's follows the tile to its page).
 */
export function moveItems(project: ProjectInfo, a: AgentInfo, nudge?: (delta: -1 | 1) => void): MenuEntry[] {
  if (isAssistantPath(project.path)) return []
  const i = project.agents.findIndex((x) => x.id === a.id)
  const kb = (id: string): string | undefined => {
    const k = commandKeybinding(id)
    return k ? formatKeybinding(k) : undefined
  }
  // Panes side by side (#762): to the next cell, left, right and, in a grid, up and down; unavailable at an edge.
  if (!nudge && actions.panesPlaced(project)) {
    const layout = shownLayout(project)
    const cells = paneCells(project)
    const k = cells.indexOf(a.id)
    const item = (dir: CellDirection, label: string, icon: string, command: string): MenuEntry => ({ label, icon, disabled: k < 0 || neighbourCell(k, dir, layout, cells.length) === null, keybinding: kb(command), onClick: () => actions.moveAgentPane(dir, project.path, a.id) })
    const grid = layout === 'grid' || layout === 'grid6'
    if (k < 0) return []
    return [
      { separator: true },
      item('left', tr(MOVE_LEFT), 'arrow-left', 'agent.moveLeft'),
      item('right', tr(MOVE_RIGHT), 'arrow-right', 'agent.moveRight'),
      ...(grid ? [item('up', tr(msg({ id: 'panes.menu.moveUp', defaultMessage: 'Move Up', description: "Menu item (an agent's menu, a grid layout): moves the agent's pane one cell up." })), 'arrow-up', 'agent.moveUp'), item('down', tr(msg({ id: 'panes.menu.moveDown', defaultMessage: 'Move Down', description: "Menu item (an agent's menu, a grid layout): moves the agent's pane one cell down." })), 'arrow-down', 'agent.moveDown')] : [])
    ]
  }
  if (project.agents.length < 2) return []
  const move = nudge ?? ((delta: -1 | 1): void => actions.nudgeAgent(delta, project.path, a.id))
  return [
    { separator: true },
    { label: tr(MOVE_LEFT), icon: 'arrow-left', disabled: i <= 0, keybinding: kb('agent.moveLeft'), onClick: () => move(-1) },
    { label: tr(MOVE_RIGHT), icon: 'arrow-right', disabled: i >= project.agents.length - 1, keybinding: kb('agent.moveRight'), onClick: () => move(1) }
  ]
}

/**
 * Compact…'s detail in an agent's menu: why it is unavailable, or that it is recommended (the pane's header had these as
 * its Compact button's tooltip before #977). `usage`: the pane's, when known (the tab's menu goes without).
 */
function compactDetail(live: LiveSessionState, usage?: { empty: boolean; suggested: boolean }): string | undefined {
  const idle = live.status === 'ready' || live.status === 'finished' || live.status === 'watching'
  if (isCompacting(live)) return tr(msg({ id: 'panes.compact.running', defaultMessage: 'Compacting the conversation…', description: "The detail of Compact… in an agent's menu while the agent compacts its conversation." }))
  if (!idle)
    return live.status === 'waiting'
      ? tr(msg({ id: 'panes.compact.waiting', defaultMessage: 'The agent is waiting for your answer. Compact after it has finished.', description: "The detail of Compact… (disabled) in an agent's menu while the agent waits for the user." }))
      : tr(msg({ id: 'panes.compact.busy', defaultMessage: 'Available once the agent has finished.', description: "The detail of Compact… (disabled) in an agent's menu while the agent works." }))
  if (usage?.empty) return tr(msg({ id: 'panes.compact.empty', defaultMessage: 'Nothing to compact yet: the conversation has no messages.', description: "The detail of Compact… (disabled) in an agent's menu when the conversation has no messages." }))
  if (usage?.suggested) return tr(msg({ id: 'panes.compact.suggested', defaultMessage: 'Recommended: the context is over your threshold.', description: "The detail of Compact… in an agent's menu once the context passes the user's Suggest compacting above threshold." }))
  return undefined
}

/**
 * An agent's menu: its pane's ⋯ (after the pane's own items), its tab's and its pane header's right-click. `usage`: what
 * the pane knows of its conversation, for Compact… (unavailable while it is empty, recommended past the threshold).
 */
function agentMenu(project: ProjectInfo, a: AgentInfo, pick: () => void, usage?: { empty: boolean; suggested: boolean; session?: SessionUsage | null }): MenuEntry[] {
  // Its 0.9 worktree, while it still works there (#1442): Review Changes, Merge and Discard act on it.
  const own = legacyOf(a)
  const worktree = !!own
  const archiveItem = { label: tr(msg({ id: 'panes.menu.archiveStartNew', defaultMessage: 'Archive and Start New…', description: "Menu item (an agent's menu): archives the agent's conversation and starts a new one." })), icon: 'archive', action: 'archive-start' as const, onClick: () => void actions.archiveCurrent(project.path, a.id) }
  // What is left to merge, under Merge… (its count was the header's Merge button's before #977).
  const unmerged = worktree ? unmergedWork(useStore.getState().branchStatus[projectKey(project.path, a.id)], tr) : null
  const blocked = mergeBlocked(a.name, a.live?.status, tr)
  // Its workspace's 1.0 upgrade waits (#1230): no session can start, said under each way to start one.
  const startBlocked = startBlockedReason(get().boardState?.readOnly)
  // Starting or resuming already (#1177): said under each way to start it.
  const starting = get().starting[startingKey(project.path, a.id)]
  const noStart = startBlocked ? { disabled: true, detail: startBlocked } : starting ? { disabled: true, detail: startingLabel(starting) } : {}
  return [
    ...(a.live
      ? [
          { label: tr(STOP), icon: 'debug-stop', action: 'stop' as const, onClick: () => void actions.stopSession(project.path, a.id) },
          { label: tr(msg({ id: 'panes.menu.compact', defaultMessage: 'Compact…', description: "Menu item (an agent's menu): summarises its conversation to shrink its context (asks first)." })), icon: 'fold', disabled: !(a.live.status === 'ready' || a.live.status === 'finished' || a.live.status === 'watching') || isCompacting(a.live) || !!usage?.empty, detail: compactDetail(a.live, usage), onClick: () => set({ compactFor: { project: project.path, agentId: a.id } }) },
          archiveItem
        ]
      : [
          { label: tr(RESUME), icon: 'debug-continue', action: 'resume' as const, disabled: !a.resume, ...noStart, onClick: () => void actions.resumeLast(project.path, a.id) },
          { label: tr(RESUME_SESSION), icon: 'history', action: 'resume' as const, ...noStart, onClick: pick },
          { label: tr(NEW_SESSION), icon: 'add', action: 'start' as const, ...noStart, onClick: () => void actions.newSession(project.path, a.id) }
        ]),
    ...(a.live?.status === 'watching'
      ? [{ label: tr(msg({ id: 'panes.menu.cancelWatch', defaultMessage: 'Cancel Card Watch', description: "Menu item (a watching agent's menu): ends its watch, so nothing wakes it." })), icon: 'eye-closed', onClick: () => void call('watch:cancel', project.path, a.id).catch((e) => notify('error', tr(CANCEL_WATCH_FAILED), String((e as Error).message ?? e))) }]
      : []),
    ...sessionItems(project, a.live, usage?.session),
    // Its work in the project's Activity tab (#1254); the Assistant has none.
    ...(isAssistantPath(project.path) ? [] : [{ label: tr(msg({ id: 'panes.menu.activity', defaultMessage: 'Activity', description: "Menu item (an agent's menu): opens the project's Activity tab showing this agent's work: its sessions, turns, tool calls and processes." })), icon: 'type-hierarchy', onClick: () => openActivity(project.path, { agentId: a.id }) }]),
    // Its hooks (HI-982): what its session has and what Hive received; while it runs.
    { label: tr(HOOKS), icon: 'plug', disabled: !a.live, onClick: () => set({ hooksFor: { project: project.path, agentId: a.id } }) },
    { label: tr(msg({ id: 'panes.menu.handOver', defaultMessage: 'Hand Over to…', description: "Menu item (an agent's menu): hands its work over to another agent or a new conversation." })), icon: 'arrow-swap', onClick: () => set({ handOverFor: { project: project.path, agentId: a.id } }) },
    ...moveItems(project, a),
    // A slot its ended run still holds (#1506): the same item, for the user's explicit recovery; a carried slot's after it.
    ...(a.heldSlot ? [{ label: tr(msg({ id: 'panes.menu.releaseHeld', defaultMessage: 'Release Slot…', description: "Menu item (an agent's menu): a slot the agent's last session there still holds (it ended, but Hive doesn't know everything it started has) is freed for other work (asks first, showing what Hive knows)." })), icon: 'unlock', detail: a.heldSlot, onClick: () => void actions.releaseHeldSlot(project.path, a.heldSlot!) }] : []),
    ...(a.carriedSlot && a.carriedSlot !== a.heldSlot ? [{ label: tr(msg({ id: 'panes.menu.releaseSlot', defaultMessage: 'Release Slot…', description: "Menu item (an agent's menu): its own worktree from before 1.0, kept for it as a slot since the upgrade, stops being kept for it (asks first)." })), icon: 'unlock', detail: a.carriedSlot, onClick: () => void actions.releaseCarriedSlot(project.path, a.id) }] : []),
    { separator: true },
    { label: tr(AGENT_SETTINGS), icon: 'settings', onClick: () => set({ agentSettingsFor: { project: project.path, agentId: a.id } }) },
    ...(own
      ? // Its branch under Review Changes (the pane's header showed it as a mark before #977).
        [
          { label: tr(msg({ id: 'panes.menu.reviewChanges', defaultMessage: 'Review Changes', description: "Menu item (a worktree agent's menu): shows its changes in the Git tab." })), icon: 'git-compare', detail: own.branch, onClick: () => reviewChanges(project, a) },
          { label: tr(MERGE), icon: 'git-merge', disabled: !!blocked, detail: blocked ?? (unmerged?.badge ? unmerged.text : undefined), onClick: () => set({ mergeFor: { project: project.path, agentId: a.id } }) },
          { separator: true },
          { label: tr(REMOVE_AGENT), icon: 'close', action: 'remove' as const, onClick: () => void actions.removeAgent(project.path, a.id) },
          { label: tr(msg({ id: 'panes.menu.discard', defaultMessage: 'Discard Worktree and Branch…', description: "Menu item (a worktree agent's menu): removes the agent and deletes its worktree and branch (asks first)." })), icon: 'trash', danger: true, onClick: () => void actions.discardAgent(project.path, a.id) }
        ]
      : [{ separator: true }, { label: tr(REMOVE_AGENT), icon: 'close', action: 'remove' as const, onClick: () => void actions.removeAgent(project.path, a.id) }])
  ]
}

/**
 * Add Agent split button (#286), where a project or a pane has no agent yet: the main part is Configure Agent and Add…
 * (the Add Agent dialog: provider, where it works, settings); ▾ offers it too and, for a project, Add Agent from Template
 * (one agent of a template). The quick add with default settings is the palette's Add Agent (Ctrl+Alt+Shift+N), and the
 * session toolbar's + Add ▾ has them all (#975).
 */
const ADD_AGENT = msg({ id: 'panes.add.button', defaultMessage: 'Add Agent', description: 'Button (an empty project or pane), and an item of the session toolbar\'s + Add ▾ (a quick add with the default provider and settings): adds an agent to the project. Keep it short.' })

export function AddAgentButton({ project, className, label, iconOnly }: { project: ProjectInfo; className?: string; label?: string; iconOnly?: boolean }) {
  useLanguage()
  const menu = useContextMenu()
  const caret = useRef<HTMLButtonElement>(null)
  const limit = useAgentLimit(project)
  const full = project.agents.length >= limit
  const templates = !isAssistantPath(project.path)
  const configure = (): void => set({ addAgentFor: project.path })
  const tip = full ? agentLimitText(tr, limit) : tr(msg({ id: 'panes.add.tip', defaultMessage: 'Configure Agent and Add…: choose its provider, where it works and its settings', description: 'Tooltip of the Add Agent button (an empty project or pane). "Configure Agent and Add…" names the dialog it opens: use its translation.' }))
  const fromTemplate = async (keyboard: boolean): Promise<void> => {
    const at = caret.current && below(caret.current)
    const all = await templatesStillHere(project.path)
    if (at && all) menu.openAt(...at, addFromTemplateItems(project, all), keyboard)
  }
  const open = (keyboard: boolean): void => {
    if (!caret.current) return
    menu.openAt(
      ...below(caret.current),
      [
        { label: tr(CONFIGURE_AGENT), icon: 'settings-gear', disabled: full, onClick: configure },
        ...(templates ? [{ label: tr(FROM_TEMPLATE), icon: 'library', more: true, disabled: full, onClick: (k: boolean) => void fromTemplate(k) }] : [])
      ],
      keyboard
    )
  }
  return (
    <span className="split-btn">
      <Tooltip content={tip}>
        {/* Its icon only in a strip short of room (#886): the name stays for screen readers. */}
        <button className={cx('btn', className, iconOnly && 'icon-only')} disabled={full} onClick={configure} aria-label={iconOnly ? (label ?? tr(ADD_AGENT)) : undefined}>
          <Icon name="add" />
          {!iconOnly && ` ${label ?? tr(ADD_AGENT)}`}
        </button>
      </Tooltip>
      <Tooltip content={templates ? tr(msg({ id: 'panes.add.caretTip', defaultMessage: 'Configure Agent and Add…, or Add Agent from Template', description: 'Tooltip of the ▾ beside Add Agent: its two menu items (use their translations).' })) : tr(msg({ id: 'panes.add.caretTipNoTemplates', defaultMessage: 'Configure Agent and Add… (choose the provider, where it works and its settings)', description: 'Tooltip of the ▾ beside Add Agent where templates are not offered (the Assistant). "Configure Agent and Add…" is its menu item.' }))}>
        <button ref={caret} className={cx('btn', 'split-caret', className)} disabled={full} onClick={(e) => open(e.detail === 0)} aria-label={tr(msg({ id: 'panes.add.caretLabel', defaultMessage: 'Add Agent…', description: 'Accessible name of the ▾ beside the Add Agent button: opens its menu.' }))} aria-haspopup="menu">
          <Icon name="chevron-down" />
        </button>
      </Tooltip>
      {menu.element}
    </span>
  )
}

function reviewChanges(project: ProjectInfo, a: AgentInfo): void {
  set((s) => ({ changesRoot: { ...s.changesRoot, [project.path]: a.id } }))
  openVersionControl(project.path, 'changes')
}

/** A worktree agent's work not merged into the project folder yet (null: not a worktree agent, or not checked yet). */
function useUnmerged(project: ProjectInfo, a: AgentInfo): ReturnType<typeof unmergedWork> {
  const own = !!legacyOf(a)
  const st = useStore((s) => (own ? s.branchStatus[projectKey(project.path, a.id)] : undefined))
  return own ? unmergedWork(st, tr) : null
}

const TO_MERGE = msg({ id: 'panes.worktree.toMerge', defaultMessage: 'To merge: {work}', description: "In a worktree agent's hover: what is left to merge ({work}: \"2 commits not merged into main\")." })

/** "…and 5 more", the last line of a list cut short. */
const MORE_LINES = msg({ id: 'panes.list.more', defaultMessage: '…and {n, number} more', description: 'The last line of a list in a hover cut short (files, processes): how many more ({n}).' })

/** Above the files an agent is editing (its pane's ⋯). */
const LOCKS_TITLE = msg({ id: 'panes.locks.title', defaultMessage: 'Files it is editing this turn:', description: "Above the files an agent is editing (a worktree agent), in its pane's ⋯ menu." })
const LOCKS_TITLE_SHARED = msg({ id: 'panes.locks.titleShared', defaultMessage: 'Files it is editing this turn. Other agents in this folder wait until it finishes with them:', description: "Above the files an agent is editing (an agent sharing the project's folder), in its pane's ⋯ menu." })

/**
 * What the pane's ⋯ shows above the agent's menu (#977: these were marks on its header), and what its badge says:
 * - processes its stopped launches left running (#507), such as a preview server: how many, the first few, and End or
 *   Keep Running (then no longer listed); gone once they end by themselves;
 * - what was left for it and isn't received yet (#530, #647: its deliveries), and Cancel for those still waiting; how
 *   many weren't acked in time;
 * - the files it is editing this turn;
 * - Mark Idle (beside the status too while the header has room) when Hive doesn't know its state (#648);
 * - `narrow` (the header too narrow for its inline marks): what its safety classifier did (#606), from its shield.
 * `sub` opens a menu in the ⋯ menu's place. `alert`: the badge's lines; `warn` when one of them is a warning.
 */
function paneItems(project: ProjectInfo, a: AgentInfo, left: AgentLeftovers | undefined, sub: (items: MenuEntry[], keyboard: boolean) => void, narrow = false): { items: MenuEntry[]; alert: string[]; warn: boolean } {
  const items: MenuEntry[] = []
  const alert: string[] = []
  let warn = false
  const note = a.live?.safeguard
  if (narrow && note) {
    const text = safeguardText(note, providerDescriptor(a.live?.provider).modelLabel, tr)
    items.push({ label: text, icon: 'shield', disabled: true })
    alert.push(text)
    if (note.switched || note.prompt || note.idle) warn = true
  }
  if (left) {
    const n = left.processes.length + left.more
    const settle = (how: 'end' | 'keep') => () =>
      void actions.attempt(
        how === 'end' ? tr(msg({ id: 'panes.leftovers.endFailed', defaultMessage: 'Could not end the processes', description: "An error's title: ending the processes an agent left running failed." })) : tr(msg({ id: 'panes.leftovers.keepFailed', defaultMessage: 'Could not keep the processes', description: "An error's title: keeping the processes an agent left running (and no longer listing them) failed." })),
        () => call('session:settleLeftovers', project.path, a.id, how)
      )
    const label = tr(msg({ id: 'panes.leftovers.count', defaultMessage: '{n, plural, one {# left running} other {# left running}}', description: "An item of a pane's ⋯ menu, and a line of its badge's hover: how many processes the agent left running ({n}). Keep it short." }), { n })
    const labels = left.processes.slice(0, 3).map((p) => p.label)
    items.push({
      label,
      icon: 'warning',
      detail: [...labels, ...(n > labels.length ? [tr(MORE_LINES, { n: n - labels.length })] : [])].join(', '),
      more: true,
      onClick: (k) =>
        sub(
          [
            { header: true, label: tr(msg({ id: 'panes.leftovers.tip', defaultMessage: "{n, plural, one {# process this agent started is still running after it stopped. It may hold the project's folder or ports:} other {# processes this agent started are still running after it stopped. They may hold the project's folder or ports:}}", description: "The heading of the menu of an agent's left-running processes, above the processes listed: how many ({n}) its stopped launches left running." }), { n }) },
            ...left.processes.slice(0, 15).map((p) => ({ label: p.label, disabled: true })),
            ...(n > 15 ? [{ label: tr(MORE_LINES, { n: n - 15 }), disabled: true }] : []),
            { separator: true },
            { label: tr(msg({ id: 'panes.leftovers.end', defaultMessage: '{n, plural, one {End It} other {End All #}}', description: 'Menu item on the processes an agent left running: ends it or all {n} of them.' }), { n }), icon: 'stop-circle', onClick: settle('end') },
            { label: tr(msg({ id: 'panes.leftovers.keep', defaultMessage: 'Keep Running (Stop Listing)', description: 'Menu item on the processes an agent left running: keeps them running and stops listing them.' })), icon: 'check', onClick: settle('keep') }
          ],
          k
        )
    })
    alert.push(label)
    warn = true
  }
  const inbox = a.live?.inbox
  if (inbox && (inbox.unread.length || inbox.overdue)) {
    const n = inbox.unread.length
    const waiting = inbox.unread.filter((m) => m.state === 'queued' || m.state === 'uncertain').length
    const label = [
      n ? tr(msg({ id: 'panes.messages.unread', defaultMessage: '{n, plural, one {# unread} other {# unread}}', description: "An item of a pane's ⋯ menu, and a line of its badge's hover: how many messages left for the agent it hasn't fetched or acked yet. Keep it short." }), { n }) : '',
      inbox.overdue ? tr(msg({ id: 'panes.messages.overdue', defaultMessage: '{n, plural, one {# overdue} other {# overdue}}', description: "An item of a pane's ⋯ menu, and a line of its badge's hover: how many deliveries the agent didn't ack in time. Keep it short." }), { n: inbox.overdue }) : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const overdue = inbox.overdue ? tr(msg({ id: 'panes.messages.overdueTip', defaultMessage: "{n, plural, one {One delivery was not acked in time: the agent hasn't said it acted on it.} other {# deliveries were not acked in time: the agent hasn't said it acted on them.}}", description: "In the menu of an agent's unread messages: how many deliveries ({n}) it didn't ack in time." }), { n: inbox.overdue }) : null
    const cancel = () => void actions.attempt(tr(msg({ id: 'panes.messages.cancelFailed', defaultMessage: 'Could not cancel the messages', description: "An error's title: cancelling messages left for an agent failed." })), () => call('session:cancelMessages', project.path, a.id))
    // Idle wakes off (#1432): nothing waiting is typed by itself; Deliver Now types its line once.
    const wakes = inboxSwitchNow('idleWakes', project.config)
    const deliver = () =>
      void actions.attempt(tr(msg({ id: 'panes.messages.deliverFailed', defaultMessage: 'Could not deliver the messages', description: "An error's title: typing the line that tells an agent of its waiting messages (Deliver Now) failed." })), async () => {
        if (!(await call('session:deliverNow', project.path, a.id))) notify('info', tr(msg({ id: 'panes.messages.notDelivered', defaultMessage: "{agent} wasn't told now", description: "A notice's title: Deliver Now couldn't type the line into the agent's terminal now. {agent} is its name." }), { agent: a.name }), tr(msg({ id: 'panes.messages.notDeliveredDetail', defaultMessage: "It isn't idle, or you are typing in its terminal. Its messages stay in its inbox: try again once it's idle.", description: 'The detail of the notice that Deliver Now could not type the line into an agent now.' })))
      })
    items.push({
      label,
      icon: 'mail',
      more: true,
      onClick: (k) =>
        sub(
          [
            ...(n ? [{ header: true, label: wakes ? tr(msg({ id: 'panes.messages.tip', defaultMessage: "{n, plural, one {A message} other {# messages}} for {agent} that it hasn't fetched or acked yet: offered as its next line once it is idle, or read with cw_inbox.", description: "The heading of the menu of an agent's unread messages, above the list of them: how many ({n}) for the agent ({agent}: its name). cw_inbox is a tool's name: keep it." }), { n, agent: a.name }) : tr(msg({ id: 'panes.messages.tipNoWakes', defaultMessage: "{n, plural, one {A message} other {# messages}} for {agent} that it hasn't fetched or acked yet", description: "The heading of the menu of an agent's unread messages when the setting Wake an idle agent is off (a hint line under it says so): how many ({n}) for the agent ({agent}: its name)." }), { n, agent: a.name }) }] : []),
            ...(n && !wakes ? [{ label: tr(msg({ id: 'panes.messages.noWakesHint', defaultMessage: 'Wake an idle agent is off, so nothing is typed by itself. Deliver Now types the line once.', description: "A hint line under the heading of an agent's unread messages menu, when the setting Wake an idle agent is off. Wake an idle agent names a setting and Deliver Now a menu item below: use their names as Hive shows them." })), disabled: true }] : []),
            ...inbox.unread.map((m) => ({ label: tr(msg({ id: 'panes.messages.line', defaultMessage: '{id} from {from} ({state, select, queued {waiting} offered {typed, not fetched or acked yet} other {its offer not confirmed}}): {text}', description: "A message left for an agent, in the menu of its unread messages: its id, who from ({from}), its state (waiting; typed into the agent but not fetched or acked; or offered but not confirmed), and the start of its text ({text}, the sender's own words)." }), { id: m.id, from: m.from, state: m.state, text: m.text }), disabled: true })),
            ...(overdue ? [{ label: overdue, disabled: true }] : []),
            ...(waiting && !wakes && a.live ? [{ separator: true }, { label: tr(msg({ id: 'panes.messages.deliverNow', defaultMessage: 'Deliver Now', description: "Menu item on an agent's unread messages, shown while the setting Wake an idle agent is off: types the line telling the agent of them into its terminal, once." })), icon: 'send', onClick: deliver }] : []),
            ...(waiting ? [{ separator: true }, { label: tr(msg({ id: 'panes.messages.cancel', defaultMessage: '{n, plural, one {Cancel the Message} other {Cancel the # Messages}}', description: "Menu item on an agent's unread messages: cancels the {n} still waiting to be delivered." }), { n: waiting }), icon: 'close', onClick: cancel }] : [])
          ],
          k
        )
    })
    alert.push(label)
    if (inbox.overdue) warn = true
  }
  const files = a.live?.lockedFiles
  if (files?.length) {
    // A worktree has one agent, so nobody waits for its files; in a shared folder the lock is what matters.
    items.push({
      label: tr(msg({ id: 'panes.locks.item', defaultMessage: '{n, plural, one {Editing # file} other {Editing # files}}', description: "An item of a pane's ⋯ menu: how many files ({n}) the agent is editing this turn; its menu lists them." }), { n: files.length }),
      icon: 'lock',
      more: true,
      onClick: (k) =>
        sub(
          [
            { header: true, label: awayFromProject(a) ? tr(LOCKS_TITLE) : tr(LOCKS_TITLE_SHARED) },
            ...files.slice(0, 20).map((f) => ({ label: f, disabled: true })),
            ...(files.length > 20 ? [{ label: tr(MORE_LINES, { n: files.length - 20 }), disabled: true }] : [])
          ],
          k
        )
    })
  }
  if (unknownStateText(a.live, Date.now(), tr)) {
    items.push({ label: tr(MARK_IDLE), icon: 'check', onClick: () => markIdle(project, a) })
    // Without its button beside the status, ⋯ says it needs a look.
    if (narrow) alert.push(unknownStateText(a.live, Date.now(), tr)!)
  }
  // Its input taking no keys (HI-2191): Try again here too, the only way back after a dialog put off with no hook.
  const blocked = a.live?.inputBlocked
  if (blocked) {
    items.push({ label: tr(TRY_INPUT), icon: 'refresh', onClick: () => retryInput(project, a, blocked.since) })
    if (narrow) alert.push(tr(INPUT_BLOCKED))
  }
  return { items: items.length ? [...items, { separator: true }] : items, alert, warn }
}

const markIdle = (project: ProjectInfo, a: AgentInfo): void => void call('session:markIdle', project.path, a.id).catch((e) => notify('error', tr(msg({ id: 'panes.header.markIdleFailed', defaultMessage: 'Could not mark the agent idle', description: "An error's title: Mark idle failed." })), String((e as Error).message ?? e)))

/** Try again on a blocked input (HI-2191): told only when it is still blocked. */
const retryInput = (project: ProjectInfo, a: AgentInfo, since: string): void =>
  void call('session:retryInput', project.path, a.id, since)
    .then((r) => {
      if (r === 'blocked') notify('info', tr(msg({ id: 'panes.header.inputStillBlocked', defaultMessage: 'Its input still takes no keys', description: "A notice's title: Try again found the agent's input still taking no keys." })), tr(msg({ id: 'panes.header.inputStillBlockedBody', defaultMessage: 'Answer what its terminal shows, such as a question of its CLI\'s own, then try again.', description: "A notice's body: Try again found the agent's input still taking no keys; the user answers what its terminal shows first." })))
    })
    .catch((e) => notify('error', tr(msg({ id: 'panes.header.inputRetryFailed', defaultMessage: 'Could not try the input again', description: "An error's title: Try again on an agent's blocked input failed." })), String((e as Error).message ?? e)))

/** Where a menu opens under a button. */
const below = (el: Element): [number, number] => {
  const r = el.getBoundingClientRect()
  return [r.left, r.bottom + 2]
}

/** A template's layout in a menu item's detail: "automatic layout", "two columns". */
const layoutName = (l: PageLayout): string =>
  tr(msg({ id: 'panes.template.layout', defaultMessage: '{layout, select, auto {automatic layout} single {one at a time} columns2 {two columns} columns3 {three columns} grid {grid of four} grid6 {grid of six} other {{layout}}}', description: "A template's layout, after how many agents it has (+ Add ▾ → Templates): its pane layout, lower case." }), { layout: l })

/** Add Agent from Template: each usable template's agents, under its name and scope (#126). */
function addFromTemplateItems(project: ProjectInfo, list: TemplateEntry[]): MenuEntry[] {
  const all = list.filter((t) => !t.problem)
  const full = project.agents.length >= agentLimit(project)
  return all.length
    ? all.flatMap((t) => [
        { header: true, label: tr(msg({ id: 'panes.template.heading', defaultMessage: '{template} · {scope, select, hive {Combwork} workspace {workspace} other {this project}}', description: "A heading in Add Agent from Template: the template's name ({template}) and where it is kept (lower case; Hive: one of Hive's own templates, #1436)." }), { template: templateTitle(t), scope: t.scope }) },
        ...t.agents.map((a, i) => ({
          // Their names as this project's, as main made them with its key (HI-1948: Hive's own are patterns of it, HI-B1);
          // none from main, `{key}` stays.
          label: t.agentNames?.[i] ?? templateAgentNames(t.agents, '{key}')[i],
          icon: 'person-add',
          detail: [tr(WORKFLOW_ROLE_TEXT[a.role].name), a.note ?? '', providerName(a.provider)].filter(Boolean).join(' · '),
          disabled: full,
          onClick: () => void actions.addAgentFromTemplate(project.path, t, i)
        }))
      ])
    : [{ label: tr(msg({ id: 'panes.template.noneYet', defaultMessage: 'No templates yet: + Add ▾ → Templates → Save Template… first', description: 'Add Agent from Template with no template: how to save one first. "+ Add ▾" is the session toolbar\'s button, "Templates" its menu item and "Save Template…" the item of that menu: use their translations.' })), disabled: true }]
}

/** + Add ▾ → Templates: Save Template…, then the templates to load, by scope (loading replaces the agents, after saying who goes and who comes). */
function templateMenuItems(project: ProjectInfo, all: TemplateEntry[]): MenuEntry[] {
  const load: MenuEntry[] = all.length
    ? (['hive', 'workspace', 'project'] satisfies TemplateScope[]).flatMap((scope) => {
        const here = all.filter((t) => t.scope === scope)
        return here.length
          ? [
              { header: true, label: tr(msg({ id: 'panes.template.scopeHeading', defaultMessage: "{scope, select, hive {Combwork's templates} workspace {Workspace templates} other {This project's templates}}", description: "A heading in + Add ▾ → Templates above Hive's own templates (#1436), those kept in the workspace, or in this project." }), { scope }) },
              ...here.map((t) => ({ label: templateTitle(t), icon: 'library', detail: shownProblem(t) ?? tr(msg({ id: 'panes.template.detail', defaultMessage: '{n, plural, one {# agent} other {# agents}} · {layout}', description: "A template's detail in + Add ▾ → Templates: how many agents it has and its layout ({layout}: \"two columns\")." }), { n: t.agents.length, layout: layoutName(t.layout) }), disabled: !!t.problem, onClick: () => void actions.loadTemplate(project.path, t) }))
            ]
          : []
      })
    : [{ label: tr(msg({ id: 'panes.template.noneSaved', defaultMessage: 'No templates saved yet', description: '+ Add ▾ → Templates with no template saved.' })), disabled: true }]
  return [{ label: tr(msg({ id: 'panes.template.save', defaultMessage: 'Save Template…', description: "Menu item (+ Add ▾ → Templates): saves this project's agents and layout as a template." })), icon: 'save', disabled: !project.agents.length, onClick: () => void actions.saveTemplate(project.path) }, { separator: true }, ...load]
}

/** Opens a strip menu the palette asked for, now or once this strip shows (`project` null: not the strip's). */
function useStripMenu(project: string | null, which: StripMenu, open: () => void, agent?: string): void {
  const run = useRef(open)
  run.current = open
  useEffect(() => {
    if (!project) return
    const check = (): void => void (takeStripMenu(project, which, agent) && run.current())
    check()
    return onStripMenu(check)
  }, [project, which, agent])
}

/**
 * What a pane's retry status means (HI-1972): its CLI waits to retry its model request, and why; under a rate limit
 * with a large conversation (past the compact suggestion's threshold, `large`), that a new conversation sends less.
 */
function RetryTip({ live, large }: { live: LiveSessionState; large: boolean }) {
  const w = live.retryWait
  if (!w) return null
  const why = w.network ? 'network' : w.status === 429 ? 'limited' : 'other' // i18n-ignore: select keys, never shown
  return (
    <>
      <div>
        {tr(
          msg({
            id: 'panes.header.retryTip',
            defaultMessage: '{provider} is waiting to send its model request again: {why, select, limited {its service refused it as too many requests (rate-limited).} network {it couldn\'t reach its service.} other {the request failed.}} It tries again by itself{when, select, at { at {time}} other {}}; nothing is needed from you.',
            description: "Tooltip of a pane's status while its coding agent ({provider}, a product name) waits to retry its model request. why: rate-limited, the service unreachable, or failed otherwise. {time} is when it tries again (a clock time)."
          }),
          { provider: providerDescriptor(live.provider).name, why, when: w.retryAt ? 'at' : 'other', time: w.retryAt ? formatTime(w.retryAt) : '' } // i18n-ignore: select keys, never shown
        )}
      </div>
      {large && w.status === 429 && (
        <div className="faint">
          {tr(msg({ id: 'panes.header.retryLarge', defaultMessage: 'This conversation is large, and each request sends all of it. A new conversation (a handover, then a fresh session) sends less, which can help under a rate limit.', description: "Tooltip of a pane's status while its coding agent is rate-limited and its conversation is large: a suggestion, not something Hive does." }))}
        </div>
      )}
      {/* How long it has been at it (HI-1973): since this wait's first try, when that was before the latest. */}
      {w.since !== w.at && (
        <div className="faint" data-retry-since>
          {tr(msg({ id: 'panes.header.retrySince', defaultMessage: 'Retrying since {time}.', description: "Tooltip of a pane's status while its coding agent waits to retry its model request: when its first try in this run of failures was ({time}, a clock time)." }), { time: formatTime(w.since) })}
        </div>
      )}
    </>
  )
}

/** The pane header's status, with what to do when a refused sign-in stopped the agent (#309). */
function SignInTip({ live, children }: { live: LiveSessionState | null; children: ReactNode }) {
  const note = signInNote(live)
  return note ? <Tooltip content={<span style={{ whiteSpace: 'pre-line' }}>{note}</span>}>{children}</Tooltip> : <>{children}</>
}

/** An agent whose last launch failed, in its name's hover and the summary chip's list: "failed to start: <why>". */
export const FAILED_TO_START = msg({ id: 'panes.tab.failed', defaultMessage: 'failed to start: {why}', description: "An agent's state after its name (its name's hover on its pane, the summary chip's list): its last launch failed ({why}: the error's first line). Lower case." })

function AgentTabTip({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const usage = useLiveUsage(project, a.live ? a.id : undefined)
  const cards = useAgentCards(project, a.id)
  const reviewing = useAgentReviews(project, a.id)
  const unmerged = useUnmerged(project, a)
  const live = a.live
  const failure = useStartFailure(project, a)
  const state = live
    ? statusText(live)
    : failure
      ? tr(FAILED_TO_START, { why: failure.reason.split('\n')[0] })
      : tr(msg({ id: 'panes.tab.notRunning', defaultMessage: 'not running', description: "An agent's state in its tab's hover, after its name: its session isn't running. Lower case." }))
  const lines = [tr(msg({ id: 'panes.tab.title', defaultMessage: '{agent} ({provider}): {state}', description: "The first line of an agent tab's hover: its name, its provider (\"Claude Code\") and its state." }), { agent: a.name, provider: providerName(agentProviderOf(a)), state })]
  const signIn = signInNote(live)
  if (signIn) lines.push(signIn)
  if (live?.safeguard) lines.push(safeguardText(live.safeguard, providerDescriptor(live.provider).modelLabel, tr))
  if (a.role) lines.push(tr(msg({ id: 'panes.tab.role', defaultMessage: 'Role: {role}', description: "A line of an agent tab's hover: its role (the user's own words)." }), { role: a.role }))
  // Only shown when it has a choice of its own (#537): the default, all of the project's servers, goes without saying.
  if (agentChoosesMcp(a)) lines.push(tr(msg({ id: 'panes.tab.mcp', defaultMessage: 'MCP servers: {servers}', description: "A line of an agent tab's hover: the MCP servers it has on ({servers})." }), { servers: agentMcpText(a) }))
  for (const c of cards) lines.push(tr(msg({ id: 'panes.tab.workingOn', defaultMessage: 'Working on {card} {title}', description: "A line of an agent tab's hover: a card it works on (its name (its key, such as AM-12, or #12 for a card with none) and title, the user's own words)." }), { card: cardLabel(c), title: c.title }))
  for (const c of reviewing) lines.push(tr(msg({ id: 'panes.tab.reviewing', defaultMessage: 'Reviewing {card} {title}', description: "A line of an agent tab's hover: a card it reviews (its name (its key, such as AM-12, or #12 for a card with none) and title, the user's own words)." }), { card: cardLabel(c), title: c.title }))
  if (live) lines.push(tr(msg({ id: 'panes.tab.session', defaultMessage: 'Session: {session}', description: "A line of an agent tab's hover: the session it runs ({session}: its name)." }), { session: liveSessionLabel(project, live, usage) }))
  else if (a.resume) lines.push(tr(msg({ id: 'panes.tab.resumeOpens', defaultMessage: 'Resume opens: {session} ({when})', description: "A line of a stopped agent tab's hover: the session Resume opens ({session}: its name) and when it was last active ({when}: \"5 min ago\")." }), { session: sessionLabel(a.resume, project.name), when: timeAgo(a.resume.lastActiveAt) }))
  // Where it works (#1442): its 0.9 worktree with its branches, else a slot, carried slot or home with its folder.
  const own = legacyOf(a)
  if (own) lines.push(tr(msg({ id: 'panes.tab.worktree', defaultMessage: 'Worktree {path} on {branch}, branched from {base}', description: "A line of a worktree agent tab's hover: its folder, its branch and the branch it was made from." }), { path: own.path, branch: own.branch, base: own.base }))
  else if (awayFromProject(a)) lines.push(placeTip(a.place))
  if (unmerged?.badge) lines.push(tr(TO_MERGE, { work: unmerged.text }))
  return <span style={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</span>
}

/** A layout's name, for its button in the session toolbar: "Two columns". */
const layoutLabel = (l: SessionLayout): string => tr(msg({ id: 'panes.layout.name', defaultMessage: '{layout, select, single {One at a time} columns2 {Two columns} columns3 {Three columns} grid {Grid of four} other {Grid of six}}', description: "A pane layout's name: its button's tooltip and accessible name in the session toolbar." }), { layout: l })

/** The chosen layout's tooltip while fewer columns are shown, the panes being too narrow for a terminal each (#1037). */
const NARROWED = msg({ id: 'panes.layout.narrowed', defaultMessage: '{layout}: shown as {shown} until there is room for a terminal in each pane', description: "Tooltip of the chosen layout's button (the session toolbar) while the window is too narrow for its columns: {layout} is its name (\"Two columns\"), {shown} the layout shown meanwhile, lower case (\"one at a time\")." })
const shownName = (l: SessionLayout): string => tr(msg({ id: 'panes.layout.shownName', defaultMessage: '{layout, select, single {one at a time} columns2 {two columns} columns3 {three columns} grid {a grid of four} other {a grid of six}}', description: "A pane layout's name in a sentence, lower case: the layout shown while the chosen one doesn't fit (panes.layout.narrowed's {shown})." }), { layout: l })

/**
 * How far the toolbar's controls fold when short of room (#886): the layouts become one button with a menu; then the page
 * buttons become the compact pager (‹ 3 / 6 ▾ ›); then the pager is only its menu, and the menus drop their ▾; then
 * + Add is only its + (#1046); then Panes | Tiles are their icons. Past that, the summary chip's counts are cut, down to
 * its mark.
 */
const TOOLBAR_FOLDS = 5

/** The width the session toolbar needs: its controls on one row, the summary chip whole (`useFolds`, #886). */
function toolbarNeed(el: HTMLElement): number | null {
  const items = [...el.children].filter((c) => !c.classList.contains('grow') && !c.classList.contains('menu') && !c.classList.contains('visually-hidden')) as HTMLElement[]
  if (!items.length) return null
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0
  const chip = el.querySelector<HTMLElement>('.summary-chip-text')
  const chipShort = chip ? chip.scrollWidth - chip.clientWidth : 0
  return Math.ceil(items.reduce((n, c) => n + c.getBoundingClientRect().width, 0) + gap * Math.max(0, items.length - 1) + chipShort)
}

/** The Session tab's views, in the toggle's order. */
const SESSION_VIEWS: readonly SessionView[] = ['panes', 'tiles']
/** Each view's icon on the toggle, folded to icons (#1046). */
const VIEW_ICON: Record<SessionView, string> = { panes: 'terminal', tiles: 'table' }

const VIEW_NAME = msg({ id: 'panes.view.name', defaultMessage: '{view, select, tiles {Tiles} other {Panes}}', description: "The Session tab's two views, on its Panes | Tiles toggle: Panes shows the agents' terminals, Tiles a small tile per agent. Keep them short." })
const ADD = msg({ id: 'panes.add.menu', defaultMessage: 'Add', description: "The session toolbar's + Add ▾ button: adds agents (the dialog, a quick add, from a template) and saves or loads templates. Keep it short." })

/**
 * The Session tab's toolbar (#975, replacing the agent strip): the Panes | Tiles toggle, the summary chip ("1 waiting ·
 * 2 working · 3 idle", whose ▾ lists every agent to jump to), and on the right, for Panes, the pages and the layouts, then
 * + Add ▾ (Add Agent…, Add Agent, Add Agent from Template ▸, Templates ▸). Each agent's own controls are on its pane.
 */
export function SessionToolbar({ project, view }: { project: ProjectInfo; view: SessionView }) {
  const [widthRef, width] = useWidth<HTMLDivElement>()
  const bar = useRef<HTMLDivElement | null>(null)
  const barRef = useCallback(
    (el: HTMLDivElement | null) => {
      bar.current = el
      widthRef(el)
    },
    [widthRef]
  )
  const language = useLanguage()
  // A second agent: the tip about layouts and file locks, the first time.
  const several = project.agents.length >= 2
  useEffect(() => void (several && offerTip('second-agent')), [several])
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  const menu = useContextMenu()
  const chipMenu = useContextMenu()
  const addMenu = useContextMenu()
  const chip = useRef<HTMLButtonElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  const viewButtons = useRef<(HTMLButtonElement | null)[]>([])
  // The view last chosen (#975 round 3), shown at once while it saves: choices made faster than a save (arrow keys on a
  // slow disk) go from it, not from the last saved view. Saves go one at a time per project, each sending the latest
  // choice, so the last one wins; once they are done the saved view shows (a failed save's view, its notice said why).
  const [chosen, setChosen] = useState<{ path: string; view: SessionView } | null>(null)
  const saving = useRef(new Map<string, { want: SessionView; keyboard: boolean }>())
  const shownView = chosen?.path === project.path ? chosen.view : view
  const chooseView = (v: SessionView, keyboard: boolean): void => {
    const path = project.path
    setChosen({ path, view: v })
    const running = saving.current.get(path)
    if (running) {
      running.want = v
      running.keyboard ||= keyboard
      return
    }
    const s = { want: v, keyboard }
    saving.current.set(path, s)
    void (async () => {
      let sent: SessionView | null = null
      while (sent !== s.want) {
        sent = s.want
        await actions.setSessionView(path, sent)
      }
      saving.current.delete(path)
      setChosen((c) => (c?.path === path ? null : c))
    })()
  }
  // The focus, when on the toggle, stays on the view shown: a failed save takes the choice back to the saved view.
  useEffect(() => {
    const el = viewButtons.current[SESSION_VIEWS.indexOf(shownView)]
    if (el && document.activeElement !== el && viewButtons.current.includes(document.activeElement as HTMLButtonElement)) el.focus()
  }, [shownView])
  // A view chosen from the keyboard keeps the focus on its radio: the panes shown again would focus their terminal (a
  // deferred focus, asked for in its effect); after this commit's effects, the choice counts as newer than that.
  useEffect(() => {
    if (saving.current.get(project.path)?.keyboard) queueMicrotask(chooseFocus)
  }, [view, project.path])
  const page = agentPage(project, focused ?? null)
  const panesView = view === 'panes'
  // One layout for the project; a page holds as many agents as it has panes (#134). With too little room for its columns,
  // fewer are shown (#1037): the buttons keep the one chosen, and its pages are those of the layout shown.
  const layout = projectLayout(project.config)
  const shown = useStore((s) => shownLayout(project, s))
  const perPage = agentsPerPage(shown)
  // Where the user put the panes in the layout shown (#762), else the agents in order.
  const cells = paneCells(project)
  const pages = cellPageCount(cells, perPage)
  const onPageOf = (k: number): AgentInfo[] => pageIds(cells, k, perPage).flatMap((id) => project.agents.find((a) => a.id === id) ?? [])
  const said = useStore((s) => s.paneSaid)
  const many = project.agents.length > 1
  const pageKb = commandKeybinding('agent.nextPage')
  const fresh = useStore((s) => s.newAgents[project.path] ?? NO_IDS)
  // Agents the Assistant added on the page shown are seen.
  useEffect(() => {
    if (!panesView) return
    const here = pageIds(paneCells(project), page, perPage).filter((id) => fresh.includes(id))
    if (here.length) seenAgents(project.path, here)
  }, [fresh, page, perPage, project, panesView])
  const dragging = useAgentDrag(project)
  const removing = useStore((s) => s.running)
  const tasks = useStore((s) => s.tasks)
  const limit = useAgentLimit(project)
  const full = project.agents.length >= limit
  const assistant = isAssistantPath(project.path)
  const [dropPage, setDropPage] = useState<number | null>(null)
  // A page button being held over while dragging: its page shows after PAGE_HOVER_MS.
  const pageHover = useRef<{ page: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  useDragCleanup()
  useEffect(() => {
    if (!dragging) {
      setDropPage(null)
      if (pageHover.current) clearTimeout(pageHover.current.timer)
      pageHover.current = null
    }
  }, [dragging])
  const folds = useFolds(bar, width, [language, project.agents.length, pages, layout, many, view, assistant].join('|'), TOOLBAR_FOLDS, toolbarNeed)
  // Each agent's state (#973), with what the board says of it (a card blocked on you, a Doing card while it isn't running).
  const startFailures = useStore((s) => s.startFailures)
  const failure = (id: string): StartFailure | undefined => startFailures[projectKey(project.path, id)]
  const states = projectAgentStates(project, tasks, (id) => !!failure(id))
  // The chip's list: every agent, most urgent first, the project's order within a state.
  const agentList = (): MenuEntry[] =>
    project.agents
      .map((a, i) => ({ a, i, state: states[i] }))
      .sort((x, y) => AGENT_STATES.indexOf(x.state) - AGENT_STATES.indexOf(y.state) || x.i - y.i)
      .map(({ a, state }) => {
        const busy = !!removing[`removeAgent:${project.path}#${a.id}`]
        const cards = assistant ? [] : agentDoingCards(tasks, project.name, a.id)
        const failed = a.live ? undefined : failure(a.id)
        const status = a.live ? statusText(a.live) : failed ? tr(FAILED_TO_START, { why: failed.reason.split('\n')[0] }) : tr(msg({ id: 'panes.chip.notRunning', defaultMessage: 'Not running', description: "An agent's status in the summary chip's list of agents: its session isn't running." }))
        return {
          ...(busy ? { icon: 'loading' } : { state }),
          label: a.name,
          // Its state in words (the mark is decorative), unless its status already starts with them ("Working…").
          detail: [busy ? tr(msg({ id: 'panes.chip.removing', defaultMessage: 'Removing…', description: "An agent's status in the summary chip's list while it is being removed." })) : tr(AGENT_STATE_LABEL[state]), status, cardsText(cards)]
            .filter((part, k, all) => !!part && !(k === 1 && part.toLowerCase().startsWith(all[0].toLowerCase())))
            .join(' · '),
          onClick: () => showAgent(project, a.id)
        }
      })
  const openChip = (keyboard: boolean): void => {
    if (chip.current) chipMenu.openAt(...below(chip.current), agentList(), keyboard)
  }
  // + Add ▾: the dialog, the quick add, one agent of a template, and the templates themselves.
  const fromTemplate = async (keyboard: boolean): Promise<void> => {
    const at = add.current && below(add.current)
    const all = await templatesStillHere(project.path)
    if (at && all) addMenu.openAt(...at, addFromTemplateItems(project, all), keyboard)
  }
  const templates = async (keyboard: boolean): Promise<void> => {
    const at = add.current && below(add.current)
    const all = await templateList(project.path)
    if (at && all) addMenu.openAt(...at, templateMenuItems(project, all), keyboard)
  }
  const quickKey = commandKeybinding('agent.add')
  const openAdd = (keyboard: boolean): void => {
    if (!add.current) return
    addMenu.openAt(
      ...below(add.current),
      [
        { label: tr(CONFIGURE_AGENT), icon: 'settings-gear', disabled: full, detail: full ? agentLimitText(tr, limit) : undefined, onClick: () => set({ addAgentFor: project.path }) },
        { label: tr(ADD_AGENT), icon: 'add', disabled: full, keybinding: quickKey ? formatKeybinding(quickKey) : undefined, detail: tr(msg({ id: 'panes.add.quickDetail', defaultMessage: 'At once, with your defaults', description: "The detail of + Add ▾'s Add Agent: it adds an agent at once, with the default provider and settings, working in the project folder. Keep it short." })), onClick: () => void actions.quickAddAgent(project.path) },
        ...(assistant
          ? []
          : [
              { label: tr(FROM_TEMPLATE), icon: 'library', more: true, disabled: full, onClick: (k: boolean) => void fromTemplate(k) },
              { separator: true as const },
              { label: tr(msg({ id: 'panes.add.templates', defaultMessage: 'Templates', description: "Menu item (+ Add ▾): opens the templates menu (save this project's agents and layout as a template, or load one)." })), icon: 'library', more: true, onClick: (k: boolean) => void templates(k) }
            ])
      ],
      keyboard
    )
  }
  // The palette's Add Agent from Template… and Load Template… open their menus here.
  useStripMenu(assistant ? null : project.path, 'addFromTemplate', () => void fromTemplate(true))
  useStripMenu(assistant ? null : project.path, 'loadTemplate', () => void templates(true))
  /**
   * The button that shows page i (#134): a mark for its most urgent agent, or a dot for one the Assistant added there; a
   * drop target while an agent is dragged (#135, #238). `as`: the compact pager's ‹ and › (more than PAGE_BUTTONS_MAX
   * pages, #562).
   */
  const pageButton = (i: number, as?: { label: string; name: string }): ReactNode => {
    const onPage = onPageOf(i)
    // Another page's most urgent agent shows on its button, or one the Assistant added there.
    const state = page === i ? null : mostUrgent(onPage.map((a) => a.live))
    const added = page !== i && onPage.some((a) => fresh.includes(a.id))
    // A drop here moves the agent to this page's first empty cell (#762): not a target for an agent already on it (#238)
    // or a page with no empty cell. Held over, the button still shows its page, to drop on a pane there.
    const empty = pageCells(cells, i, perPage).indexOf(null)
    const moves = !!dragging && empty >= 0 && cellPage(cells, dragging, perPage) !== i
    return (
      <Tooltip
        key={as ? as.name : i}
        content={tr(
          msg({
            id: 'panes.pages.agentsTip',
            defaultMessage: '{button, select, none {Page {page}} other {{button} (page {page})}}: {agents}{added, select, yes {, with an agent the Assistant added} other {}}{key, select, none {} other { ({key} for the next page)}}',
            description: "Tooltip of a page button in the session toolbar: which page ({page}), or the ‹ › button's name ({button}; none for a numbered button), the names of the agents on it ({agents}: \"B1, B2 and R1\"), whether the Assistant added one there, and the shortcut for the next page ({key}: \"Ctrl+Alt+PageDown\"; none: leave that branch empty)."
          }),
          { button: as ? as.name : 'none', page: i + 1, agents: fmt.list(onPage.map((a) => a.name)), added: added ? 'yes' : 'no', key: pageKb ? formatKeybinding(pageKb) : 'none' }
        )}
      >
        <button
          className={cx(!as && page === i && 'active', moves && dropPage === i && 'drop-target')}
          onClick={() => showPage(project, i)}
          aria-label={as ? as.name : tr(msg({ id: 'panes.pages.button', defaultMessage: 'Agent page {page}', description: 'Accessible name of a numbered page button in the session toolbar.' }), { page: i + 1 })}
          onDragOver={(e) => {
            if (!dragging) return
            if (moves) e.preventDefault()
            setDropPage(moves ? i : null)
            // Held over another page's button for a moment, that page shows, to drop on one of its panes (#135).
            if (i !== page && pageHover.current?.page !== i) {
              if (pageHover.current) clearTimeout(pageHover.current.timer)
              pageHover.current = { page: i, timer: setTimeout(() => showPage(project, i), PAGE_HOVER_MS) }
            }
          }}
          onDragLeave={() => {
            setDropPage(null)
            if (pageHover.current?.page === i) {
              clearTimeout(pageHover.current.timer)
              pageHover.current = null
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (pageHover.current) clearTimeout(pageHover.current.timer)
            pageHover.current = null
            if (moves) placeDrop(project, i * perPage + empty)
          }}
        >
          {as ? as.label : i + 1}
          {state ? <span className={cx('dot', state.status, state.unseen && 'unseen')} /> : added && <span className="dot added" />}
        </button>
      </Tooltip>
    )
  }
  // The compact pager for more pages than buttons, or (folded, #886) for any pages in a toolbar short of room.
  const compactPager = pages > PAGE_BUTTONS_MAX || (pages > 1 && folds >= 2)
  const bare = folds >= 3
  // Shorter still (#1046): + Add is only its +, then Panes | Tiles their icons.
  const addIcon = folds >= 4
  const viewIcons = folds >= 5
  // Every other page's most urgent agent, for the compact pager's menu button.
  const elsewhere = compactPager ? mostUrgent(project.agents.filter((a) => cellPage(cells, a.id, perPage) !== page).map((a) => a.live)) : null
  const pageMenu = (el: Element, keyboard: boolean): void => {
    const r = el.getBoundingClientRect()
    menu.openAt(
      r.left,
      r.bottom + 2,
      Array.from({ length: pages }, (_, k) => ({
        label: tr(msg({ id: 'panes.pages.item', defaultMessage: 'Page {page}', description: "An item of the session toolbar's page menu (many pages); its detail lists the page's agents." }), { page: k + 1 }),
        icon: k === page ? 'check' : undefined,
        detail: fmt.list(onPageOf(k).map((a) => a.name)),
        onClick: () => showPage(project, k)
      })),
      keyboard
    )
  }
  const urgent = mostUrgentState(states)
  return (
    <div className="session-toolbar" ref={barRef} data-folded={folds > 0 || undefined}>
      {/* Where a pane moved from the keyboard went (#762), for screen readers. */}
      <span className="visually-hidden" role="status">
        {/* Every other one ends in a no-break space: the same words twice in a row are still a change, and said again. */}
        {said && `${said.text}${said.n % 2 ? ' ' : ''}`}
      </span>
      {/* Panes | Tiles (#975), remembered per project; the hook for the Tiles view is AgentTiles (#976). */}
      {/* A radio group (#975): one tab stop, on the chosen view; the arrow keys (round, Home, End) move to the other and choose it. */}
      <div
        className={cx('segmented', 'view-switch', viewIcons && 'icons')}
        role="radiogroup"
        // Busy while the choice saves (it shows meanwhile; a failed save goes back to the saved view).
        aria-busy={chosen?.path === project.path || undefined}
        aria-label={tr(msg({ id: 'panes.view.label', defaultMessage: 'Session view', description: "Accessible name of the Session tab's Panes | Tiles toggle." }))}
        onKeyDown={(e) => {
          const at = SESSION_VIEWS.indexOf(shownView)
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? SESSION_VIEWS.length - 1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % SESSION_VIEWS.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + SESSION_VIEWS.length) % SESSION_VIEWS.length : -1
          if (next < 0) return
          e.preventDefault()
          viewButtons.current[next]?.focus()
          if (SESSION_VIEWS[next] !== shownView) chooseView(SESSION_VIEWS[next], true)
        }}
      >
        {SESSION_VIEWS.map((v, i) => (
          // Folded to its icon (#1046): its name on hover and for screen readers.
          <Tooltip key={v} content={viewIcons ? tr(VIEW_NAME, { view: v }) : null}>
            <button
              ref={(el) => void (viewButtons.current[i] = el)}
              role="radio"
              aria-checked={shownView === v}
              tabIndex={shownView === v ? 0 : -1}
              className={cx(shownView === v && 'active')}
              data-view={v}
              // Tiles again, from an agent's focus view (#976): back to the grid.
              onClick={() => (shownView !== v ? chooseView(v, false) : v === 'tiles' && focusTileAfter(closeTile(project)))}
              aria-label={viewIcons ? tr(VIEW_NAME, { view: v }) : undefined}
            >
              {viewIcons ? <Icon name={VIEW_ICON[v]} /> : tr(VIEW_NAME, { view: v })}
            </button>
          </Tooltip>
        ))}
      </div>
      {project.agents.length > 0 && (
        <Tooltip content={tr(msg({ id: 'panes.chip.tip', defaultMessage: "The project's agents by state: choose one to go to it", description: "Tooltip of the session toolbar's summary chip (\"1 waiting · 2 working\"), which opens a list of the agents." }))}>
          <button ref={chip} className={cx('summary-chip', urgent)} aria-haspopup="menu" aria-expanded={chipMenu.shown} onClick={(e) => openChip(e.detail === 0)}>
            {/* Its count as the project header's (HI-1908): the agents with no session running are stopped, not idle. */}
            <StateMark state={urgent} decorative className={allStopped(project.agents, states) ? 'stopped' : undefined} />
            <span className="summary-chip-text">{projectStateSummary(project.agents, states)}</span>
            {!bare && <Icon name="chevron-down" />}
          </button>
        </Tooltip>
      )}
      <div className="grow" />
      {/* On the right, for Tiles: its pages (#976). */}
      {!panesView && <TilePager project={project} />}
      {/* On the right, for Panes: the pages beside the layouts they follow from (#292), then + Add ▾. */}
      {panesView && pages > 1 && !compactPager && <div className="segmented page-switch">{Array.from({ length: pages }, (_, i) => pageButton(i))}</div>}
      {/* More pages than fit as buttons (up to 24 agents, #562), or a toolbar short of room (#886): ‹, which page of how
          many (a menu of them all), ›; shortest, only the menu. */}
      {panesView && compactPager && (
        <div className="segmented page-switch compact">
          {!bare && pageButton((page - 1 + pages) % pages, { label: '‹', name: tr(msg({ id: 'panes.pages.previous', defaultMessage: 'Previous agent page', description: "The ‹ button of the session toolbar's compact pager (many pages): shows the previous page of agents." })) })}
          <Tooltip content={tr(msg({ id: 'panes.pages.menuTip', defaultMessage: 'Page {page} of {pages}: choose a page{key, select, none {} other { ({key} for the next page)}}', description: "Tooltip of the session toolbar's page menu (many pages): the page shown of how many, and the shortcut for the next page ({key}; none: leave that branch empty)." }), { page: page + 1, pages, key: pageKb ? formatKeybinding(pageKb) : 'none' })}>
            <button className="page-menu" aria-label={tr(msg({ id: 'panes.pages.menu', defaultMessage: 'Agent pages', description: "Accessible name of the session toolbar's page menu (many pages)." }))} aria-haspopup="menu" onClick={(e) => pageMenu(e.currentTarget, e.detail === 0)}>
              {page + 1} / {pages}
              {!bare && <Icon name="chevron-down" />}
              {elsewhere && <span className={cx('dot', elsewhere.status, elsewhere.unseen && 'unseen')} />}
            </button>
          </Tooltip>
          {!bare && pageButton((page + 1) % pages, { label: '›', name: tr(msg({ id: 'panes.pages.next', defaultMessage: 'Next agent page', description: "The › button of the session toolbar's compact pager (many pages): shows the next page of agents." })) })}
        </div>
      )}
      {panesView && (many || layout !== 'single') && folds >= 1 && (
        <div className="segmented layout-switch">
          <Tooltip content={shown !== layout ? tr(NARROWED, { layout: layoutLabel(layout), shown: shownName(shown) }) : layoutLabel(layout)}>
            <button
              className="layout-menu"
              aria-label={layoutLabel(layout)}
              aria-haspopup="menu"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                menu.openAt(r.left, r.bottom + 2, SESSION_LAYOUTS.map((l) => ({ label: layoutLabel(l.value), icon: layout === l.value ? 'check' : undefined, onClick: () => void actions.setLayout(project.path, l.value) })), e.detail === 0)
              }}
            >
              <LayoutGlyph layout={layout} />
              {!bare && <Icon name="chevron-down" />}
            </button>
          </Tooltip>
        </div>
      )}
      {panesView && (many || layout !== 'single') && folds < 1 && (
        <div className="segmented layout-switch">
          {SESSION_LAYOUTS.map((l) => (
            <Tooltip key={l.value} content={l.value === layout && shown !== layout ? tr(NARROWED, { layout: layoutLabel(layout), shown: shownName(shown) }) : l.panes > 2 ? tr(msg({ id: 'panes.layout.wide', defaultMessage: '{layout} (works best on a wide window, or with the sidebar hidden: Ctrl+B)', description: "Tooltip of a layout button with three or more panes (the session toolbar): its name ({layout}) and a hint. Ctrl+B hides the sidebar." }), { layout: layoutLabel(l.value) }) : layoutLabel(l.value)}>
              <button className={cx(layout === l.value && 'active')} onClick={() => void actions.setLayout(project.path, l.value)} aria-label={layoutLabel(l.value)}>
                <LayoutGlyph layout={l.value} />
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      <Tooltip content={full ? agentLimitText(tr, limit) : tr(msg({ id: 'panes.add.menuTip', defaultMessage: 'Add an agent (Add Agent…: choose its provider, where it works and its settings), or save and load templates', description: "Tooltip of the session toolbar's + Add ▾ button. \"Add Agent…\" is its first menu item: use its translation." }))}>
        <button ref={add} className="btn subtle small add-menu" aria-haspopup="menu" aria-expanded={addMenu.shown} aria-label={addIcon ? tr(ADD) : undefined} onClick={(e) => openAdd(e.detail === 0)}>
          <Icon name="add" />
          {!addIcon && ` ${tr(ADD)}`}
          {!bare && <Icon name="chevron-down" />}
        </button>
      </Tooltip>
      {menu.element}
      {chipMenu.element}
      {addMenu.element}
    </div>
  )
}

/** An element's width, kept up to date as it resizes (a callback ref, so it works for an element that mounts later). */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    observer.current = ro
    setW(el.clientWidth)
  }, [])
  return [ref, w]
}

const INPUT_BLOCKED = msg({ id: 'panes.header.inputBlocked', defaultMessage: 'Its input takes no keys', description: "A pane's status: keys Hive typed into the agent's input didn't reach it (something on its screen takes them). Keep it short." })
const TRY_INPUT = msg({ id: 'panes.header.inputRetry', defaultMessage: 'Try again', description: "Button beside a pane's status when the agent's input takes no keys: Hive checks once that its input takes keys again (after the user answered what took them). Keep it short." })
const MARK_IDLE = msg({ id: 'panes.header.markIdle', defaultMessage: 'Mark idle', description: "Button beside a pane's unknown state, and an item of its ⋯ menu: tells Hive the agent is idle (its terminal shows it at its prompt). Keep it short." })

/** The header's width from which its card shows (tests/e2e/paneheader.cjs measures every width). */
const CARD_FROM = 200
/** From which Mark idle shows beside an unknown state (else only in ⋯), and below which ⋯ has the safeguard's note too. */
const MARKS_FROM = 300

const MORE = msg({ id: 'panes.header.more', defaultMessage: 'More', description: "Tooltip of the ⋯ button on a pane's header: the agent's menu." })

/**
 * A pane's header (#977): the agent's state mark, its name, its status and its card, then Stop (Resume, or New Session
 * when there is nothing to resume, while it isn't running) and ⋯, which has everything else: what needs a look (processes
 * left running, unread messages, the files it is editing; its badge says so), then the agent's menu (Compact, Hand Over,
 * worktree and Merge, settings, Remove). The status gives way first, then the name; Stop and ⋯ never shrink.
 */
function PaneHeader({ project, a, focused }: { project: ProjectInfo; a: AgentInfo; focused: boolean }) {
  useLanguage()
  const menu = useContextMenu()
  const picker = useSessionPicker()
  const left = useStore((s) => s.leftovers[projectKey(project.path, a.id)])
  const more = useRef<HTMLButtonElement>(null)
  const [ref, width] = useWidth<HTMLDivElement>()
  const live = a.live
  const failure = useStartFailure(project, a)
  const removing = useStore((s) => !!s.running[`removeAgent:${project.path}#${a.id}`])
  const startBlocked = useStartBlocked()
  const starting = useStarting(project.path, a.id)
  // Its stopped run, as its pane's bar and its tile say it (HI-1881).
  const end = useStoppedEnd(project.path, a)
  const cards = useAgentCards(project, a.id)
  const state = agentState(live, { blocked: cards.some((c) => !!c.blocked) })
  // For Compact… in ⋯: unavailable while the conversation is empty, recommended once its context passes the threshold.
  const settings = useStore((s) => s.settings)
  const usage = useLiveUsage(project, a.id)
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const tokens = usage?.contextTokens ?? 0
  const empty = !usage || usage.userMessages === 0 || tokens === 0
  const suggested = threshold > 0 && tokens >= threshold
  const narrow = !!width && width < MARKS_FROM
  const openMenu = (x: number, y: number, keyboard: boolean): void => {
    const { items } = paneItems(project, a, left, (sub, k) => menu.openAt(x, y, sub, k), narrow)
    menu.openAt(x, y, [...items, ...agentMenu(project, a, () => void picker.openAt(project, a, x, y), { empty, suggested, session: usage })], keyboard)
  }
  const openBelow = (keyboard: boolean): void => {
    const r = more.current?.getBoundingClientRect()
    if (r) openMenu(r.left, r.bottom + 2, keyboard)
  }
  // The palette's Agent Menu… for this agent.
  useStripMenu(project.path, 'agentMenu', () => openBelow(true), a.id)
  const { alert, warn } = paneItems(project, a, left, () => {}, narrow)
  /** Stop's place: an icon with a tooltip, in its action's colour. */
  const btn = (icon: string, label: string, onClick: () => void, tone: string, tip: string, disabled?: boolean, busy?: boolean) => (
    <Tooltip content={tip}>
      <button type="button" className={cx('btn', 'small', 'pane-btn', 'icon-only', tone)} disabled={disabled || busy} aria-busy={busy || undefined} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick() }}>
        <Icon name={busy ? 'loading' : icon} spin={busy} />
      </button>
    </Tooltip>
  )
  return (
    <div
      ref={ref}
      className={cx('pane-header-bar', focused && 'focused')}
      {...agentDragProps(project, a)}
      onMouseDown={() => focusAgent(project.path, a.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        openMenu(e.clientX, e.clientY, false)
      }}
    >
      {/* Its state mark (#973): a launch that failed is stalled; a card of its blocked on you is waiting for you. While
          Remove or Remove All removes it, a spinner (#975: its tab in the agent strip had it). */}
      {removing ? (
        <Icon name="loading" spin title={tr(msg({ id: 'panes.tab.removing', defaultMessage: 'Removing…', description: "Tooltip of the spinner on an agent's pane header while it is being removed." }))} />
      ) : !live && failure ? (
        <Tooltip content={tr(msg({ id: 'panes.header.failedTip', defaultMessage: 'Failed to start: {why}', description: "Tooltip of a pane's state mark (stalled): the agent's last launch failed ({why}: the error)." }), { why: failure.reason })}>
          <StateMark state="stalled" label={tr(msg({ id: 'panes.header.failed', defaultMessage: 'Failed to start', description: "A pane's status: the agent's last launch failed." }))} />
        </Tooltip>
      ) : (
        // A stopped agent's own mark is grey (HI-1881), from the same end as its status: its state is still idle.
        <Tooltip content={end ? stoppedLine(end) : tr(AGENT_STATE_LABEL[state])}>
          <StateMark state={state} className={end ? 'stopped' : undefined} label={end ? stoppedLabel(end) : undefined} />
        </Tooltip>
      )}
      {/* Its provider is in the name's tooltip (the header showed its icon before #977), with everything its tab in the
          agent strip said (#975: role, cards, session, worktree and what is left to merge). */}
      <Tooltip content={<AgentTabTip project={project} a={a} />}>
        <span className="agent-name">{a.name}</span>
      </Tooltip>
      {!narrow && <PlaceMark project={project} a={a} />}
      {live?.hooksMissing ? (
        // Its hooks aren't reaching Hive (#1336): its status may be wrong, so it says unknown; the project's banner over
        // the panes has the whole note and Restart session for the focused agent.
        <Tooltip content={hooksMissingNote(live, tr)}>
          <span className="faint pane-status asks hooks-missing">{hooksMissingText(live, tr)}</span>
        </Tooltip>
      ) : live?.inputBlocked ? (
        // Something on its screen takes its keys (HI-2191): the user answers it there; Try again checks its input takes keys.
        <span className="pane-status input-blocked">
          <Tooltip content={tr(msg({ id: 'panes.header.inputBlockedTip', defaultMessage: "Keys Combwork typed into this agent's input didn't reach it: something on its screen, such as a question of its CLI's own, is taking them. Combwork types nothing more into it and gives it nothing until it takes keys again. Answer it in its terminal, then press Try again.", description: "Tooltip of a pane's status when the agent's input takes no keys. Try again is the button beside it: keep its name as it is translated there." }))}>
            <span className="faint pane-status asks">{tr(INPUT_BLOCKED)}</span>
          </Tooltip>
          {!narrow && (
            <button className="btn small subtle mark-idle" aria-label={tr(TRY_INPUT)} onClick={() => retryInput(project, a, live.inputBlocked!.since)}>
              {tr(TRY_INPUT)}
            </button>
          )}
        </span>
      ) : live?.untakenLine ? (
        // A line Hive typed that its CLI didn't take (#430): the user sees to it, nothing more is typed meanwhile.
        <Tooltip content={tr(msg({ id: 'panes.header.untakenTip', defaultMessage: "Combwork typed this, but its CLI hasn't taken it (it wasn't reading its input): \"{line}\". Click its terminal and press Enter. Combwork types nothing more into it until its CLI takes it.", description: "Tooltip of a pane's status when a line Hive typed into the agent's CLI wasn't taken ({line}: the line)." }), { line: live.untakenLine.text })}>
          <span className="faint pane-status asks">{tr(msg({ id: 'panes.header.untaken', defaultMessage: "A line Combwork typed wasn't taken", description: "A pane's status: a line Hive typed into the agent's CLI wasn't taken." }))}</span>
        </Tooltip>
      ) : retryWaitText(live, Date.now(), tr) ? (
        // Its CLI waits to retry its model request (HI-1972): what it waits on and until when, rather than "Working…".
        <Tooltip content={<RetryTip live={live!} large={suggested} />}>
          <span className="faint pane-status retrying">{retryWaitText(live, Date.now(), tr)}</span>
        </Tooltip>
      ) : unknownStateText(live, Date.now(), tr) ? (
        // A running turn Hive has heard nothing of, with no sign of its end (#648): not idle, so nothing is typed into it.
        // Mark idle stays beside it (and in ⋯): the agent is stuck until someone looks.
        <span className="pane-status unknown-state">
          <Tooltip content={tr(msg({ id: 'panes.header.unknownTip', defaultMessage: "Combwork has heard nothing of this agent's turn for a while and sees no sign that it ended: no Stop from its CLI, nothing in its CLI's records, no idle prompt on its screen. Until it hears more, the agent counts as busy and nothing is typed into it. If its terminal shows it waiting at its prompt, mark it idle.", description: "Tooltip of a pane's status when the agent's state is unknown. Stop is the CLI's event: keep it. \"mark it idle\" refers to the Mark idle button beside it." }))}>
            <span className="faint pane-status asks">{unknownStateText(live, Date.now(), tr)}</span>
          </Tooltip>
          {!narrow && (
            <button className="btn small subtle mark-idle" aria-label={tr(MARK_IDLE)} onClick={() => markIdle(project, a)}>
              {tr(MARK_IDLE)}
            </button>
          )}
        </span>
      ) : live?.question ? (
        <Tooltip content={live.question.text ? tr(msg({ id: 'panes.header.asks', defaultMessage: 'Asks: {question}', description: "Tooltip of a pane's status: the agent's question to the user ({question}, the agent's own words)." }), { question: live.question.text }) : tr(msg({ id: 'panes.header.asksSomething', defaultMessage: 'Asks you something', description: "Tooltip of a pane's status: the agent has asked the user something." }))}>
          <span className="faint pane-status asks">{statusText(live)}</span>
        </Tooltip>
      ) : live?.status === 'watching' && live.watch ? (
        // Waiting on cards (a watch): what for and until when; Cancel is in ⋯ (it takes no other work while it waits).
        <Tooltip
          content={tr(
            msg({
              id: 'panes.header.watchTip',
              defaultMessage: '{watch}: Combwork types a line into it when {kind, select, agent {{n, plural, one {it finishes} other {one of them finishes}}, waits for you or stops} lane {a review fails, a card is blocked or stalled, or a lane is due to merge or ends} other {{n, plural, one {the card changes} other {one of them changes}}}}, or at {limit} if nothing does. Nothing runs meanwhile, and it takes no other work.',
              description: "Tooltip of a watching agent's status: what it waits for ({watch}: \"Waiting for #12 → Review\"), what wakes it (an agent watch: the agents finishing; a lane watch: lane events; a card watch: its cards changing; {n} is how many agents or cards), and when it is woken anyway ({limit}: a time)."
            }),
            { watch: watchText(live.watch, tr, (l) => fmt.list(l, 'unit')), kind: live.watch.lanes ? 'lane' : live.watch.agents ? 'agent' : 'card', n: live.watch.agents && !live.watch.lanes ? live.watch.agents.length : live.watch.cards.length, limit: formatWhen(live.watch.limitAt) }
          )}
        >
          <span className="faint pane-status watching">
            <Icon name="eye" /> {watchText(live.watch, tr, (l) => fmt.list(l, 'unit'))}
          </span>
        </Tooltip>
      ) : !live && !failure && a.start && 'waiting' in a.start ? (
        // Its start waits for its slot (HI-2304): what holds it, in English as Hive says it.
        <Tooltip content={a.start.waiting}>
          <span className="faint pane-status asks slot-held">{tr(msg({ id: 'panes.header.slotHeld', defaultMessage: 'Waiting for its slot', description: "A pane's status (HI-2304): Hive will start or resume the agent in its slot (a worktree Hive lends it) once the processes another run left running there have ended. The tooltip says what holds it." }))}</span>
        </Tooltip>
      ) : (
        <SignInTip live={live}>
          <span className={cx('faint', 'pane-status', !live && failure && 'failed', live?.status === 'signin' && 'signin', !live && !failure && end && 'stopped')} {...(!live && !failure && end ? { 'data-stopped': end.why, title: stoppedLine(end) } : {})}>{live ? statusText(live) : failure ? tr(msg({ id: 'panes.header.failed', defaultMessage: 'Failed to start', description: "A pane's status: the agent's last launch failed." })) : end ? stoppedLabel(end) : tr(msg({ id: 'panes.header.notRunning', defaultMessage: 'Not running', description: "A pane's status: the agent's session isn't running." }))}</span>
        </SignInTip>
      )}
      {/* Short of room they give way with the status (app.css); under MARKS_FROM the safeguard's note is in ⋯ too. */}
      <ReviewMark live={live} />
      <SafeguardMark live={live} />
      <div className="grow" />
      {/* Narrowest, the card goes first: Stop and ⋯ stay. */}
      {(!width || width >= CARD_FROM) && <CardChip project={project} a={a} short />}
      {live
        ? btn('stop-circle', tr(STOP), () => void actions.stopSession(project.path, a.id), 'act-stop', tr(msg({ id: 'panes.header.stopTip', defaultMessage: 'Stop this agent (the conversation is kept; resume it any time)', description: "Tooltip of a pane's Stop button." })))
        : a.resume
          ? btn('debug-continue', starting ? startingLabel(starting) : tr(RESUME), () => void actions.resumeLast(project.path, a.id), 'act-resume', startBlocked ?? (starting ? startingLabel(starting) : resumeTip(project, a)), !!startBlocked, !!starting)
          : btn('add', starting ? startingLabel(starting) : tr(NEW_SESSION), () => void actions.newSession(project.path, a.id), 'act-start', startBlocked ?? (starting ? startingLabel(starting) : tr(NEW_SESSION)), !!startBlocked, !!starting)}
      <Tooltip content={alert.length ? <span style={{ whiteSpace: 'pre-line' }}>{[tr(MORE), ...alert].join('\n')}</span> : tr(MORE)}>
        <button
          ref={more}
          type="button"
          className="icon-btn pane-more"
          aria-label={tr(MORE)}
          aria-description={alert.length ? fmt.list(alert, 'unit') : undefined}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation()
            openBelow(e.detail === 0)
          }}
        >
          <Icon name="ellipsis" />
          {alert.length > 0 && <span className={cx('pane-more-badge', warn && 'warn')} />}
        </button>
      </Tooltip>
      {menu.element}
      {picker.element}
    </div>
  )
}

/** What a click on the footer's cost does, as its tooltip says. */
const RETRY_WAITED = msg({
  id: 'panes.footer.retryWaited',
  defaultMessage: 'This session has waited {minutes, plural, =0 {under a minute} one {# minute} other {# minutes}} in all for {provider} to retry rate-limited or failed requests ({waits, plural, one {# wait} other {# waits}}, the latest from {time}{ongoing, select, yes {, still waiting} other {}}): time not spent on its work.',
  description: "Added to the hover of the model in a pane's footer, after a blank line: how long this session of the agent has spent waiting for its coding agent ({provider}, a product name) to try a model request again after the service refused it (rate-limited) or it failed, so slow work can be told from waiting. {minutes} is the total in minutes, {waits} how many separate waits, {time} the clock time the latest wait began; ongoing yes adds that it is still waiting now."
})
const COST_CLICK = msg({ id: 'panes.footer.costClick', defaultMessage: "Click to see this session's details in the Overview", description: "The last line of the hover of a pane footer's cost: what clicking does (the project's Overview tab)." })

/** The footer's context: "ctx 42%", or its tokens while the context window's size isn't known ("ctx 120K", "ctx –"). */
const CTX = msg({ id: 'panes.footer.ctxValue', defaultMessage: 'ctx {value}', description: "A pane footer's context used: the percentage of the context window (\"42%\"), or its tokens while the window isn't known (\"120K\"; – before it is read). ctx is short for context: keep it short." })

/** Between a warning's icon and its text (.fit-text's margin in app.css). */
const FIT_TEXT_GAP = 4

/**
 * How much of the footer's right side gives way to make room (#978, #1013; `data-give` on the texts): 0 none, 1 the
 * transcript's size while it isn't a warning (it is in the context's hover too), 2 the background tasks' text, 3 a long
 * transcript's (their icons stay). Worked out from what every item would take in full, so a level never flips back and
 * forth. Past that the permission mode's label shortens, then the model's, and only then is the line cut off at the
 * right (CSS).
 */
function useFooterFit(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState(0)
  const measure = useCallback(() => {
    const el = ref.current
    if (!el || !el.clientWidth) return
    const cs = getComputedStyle(el)
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const gap = parseFloat(cs.columnGap) || 0
    const kids = [...el.children] as HTMLElement[]
    // The row as it is: every item (not the space between the two sides, which takes what is left) with its margins
    // and the gaps between them...
    let row = gap * Math.max(0, kids.length - 1)
    for (const k of kids) {
      if (k.classList.contains('grow')) continue
      const ks = getComputedStyle(k)
      row += k.offsetWidth + parseFloat(ks.marginLeft) + parseFloat(ks.marginRight)
    }
    // ...with any text the layout has cut short in full (the model, the mode's label).
    for (const c of el.querySelectorAll<HTMLElement>('.fit-clip')) row += Math.max(0, c.scrollWidth - c.clientWidth)
    // The texts that give way, in full whatever is shown now, by the order they give way in: a warning's beside its
    // icon, the plain size with its gap (the item takes back the gap once its text has gone, app.css).
    const texts = [...el.querySelectorAll<HTMLElement>('.fit-text')].map((t) => ({ give: Number(t.dataset.give), w: t.scrollWidth + (t.classList.contains('plain') ? gap : FIT_TEXT_GAP) }))
    const most = Math.max(0, ...texts.map((t) => t.give))
    const shown = (l: number): number => texts.reduce((sum, t) => sum + (t.give > l ? t.w : 0), 0)
    const base = row - shown(level)
    let next = 0
    while (next < most && base + shown(next) > avail + 0.5) next++
    // Back to more text only with room to spare: widths read at different levels round differently (at 125%, say),
    // and without this a footer on the edge would flip between two levels.
    while (next < level && base + shown(next) > avail - 2) next++
    // The mode chip never shrinks past its icon and caret.
    const chip = el.querySelector<HTMLElement>('.mode-chip')
    const label = chip?.querySelector<HTMLElement>('.mode-label')
    if (chip && label) el.style.setProperty('--mode-chip-min', `${chip.offsetWidth - label.offsetWidth}px`)
    if (next !== level) setLevel(next)
  }, [level])
  // After every render (the texts may have changed), and when the pane or anything in the row changes size or text.
  useLayoutEffect(measure)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = new ResizeObserver(() => measure())
    resize.observe(el)
    const mutate = new MutationObserver(() => measure())
    mutate.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      resize.disconnect()
      mutate.disconnect()
    }
  }, [measure])
  return [ref, level]
}

/**
 * The agent's session details in one quiet line (#978): model · effort and the permission mode on the left; the
 * transcript's size, the context used and the cost on the right (#1013); the context's tokens and the session's cost
 * detail on hover. Warnings only when they matter, in the warning colour: the context past the Compact threshold, the
 * size past the transcript's warn size, background tasks running (just left of the size). Clicking the model opens the agent's settings (or `onSettings`), the context its session in the
 * project's Overview (or `onContext`), the transcript warning Hand Over to… (or `onTranscript`, with `transcriptAdvice`
 * in its tooltip).
 */
export function PaneFooter({
  project,
  a,
  onSettings,
  onContext,
  onTranscript,
  transcriptAdvice,
  settingsName
}: {
  project: ProjectInfo
  a: AgentInfo
  onSettings?: () => void
  onContext?: () => void
  onTranscript?: () => void
  transcriptAdvice?: string
  settingsName?: string
}) {
  useLanguage()
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const { usage, pending } = useLiveUsageState(project, a.id)
  const provider = agentProviderOf(a)
  const live = a.live
  // Who the connection it runs on is signed in as (HI-1756), for its hover.
  const connections = useConnections()
  const signedInAs = live?.launchedConnection && connections?.connections.find((c) => c.id === live.launchedConnection!.id)
  const email = signedInAs ? (signedInAs.observed?.email ?? signedInAs.accepted?.email) : undefined
  // What runs (#248): the session's reported model while it runs (status line, else its transcript), else what the choice
  // resolves to; the choice itself in the tooltip when it reads differently (an alias).
  // A running session's from its own launch (HI-1996), never the settings as they are now; a new session's from them.
  const chose = footerChoices(a, live)
  const shown = agentModelShown(provider, chose.model, chose.modelGlobal, providers[provider], live ? live.modelId || usage?.model || null : null)
  // On a server connection (HI-1772): the server's real model, with the Claude names it stands in for, and no effort.
  const onServer = live?.launchedConnection?.server
  const serverModel = onServer ? serverModelOf(onServer.models, live?.modelId || usage?.model || (live?.launchedWith ? live.launchedWith.model : a.model) || serverDefaultModel(onServer.models) || '') : null
  const model = serverModel?.id ? serverModelLabel(serverModel.id, serverModel.as, tr, serverModel.remote) : shown.label
  // With no effort set or reported, the model's own default when the CLI said what it is ("Medium (default)", #125).
  const runModel = (chose.model && chose.model !== 'inherit' ? chose.model : chose.modelGlobal) || providers[provider]?.defaultModel || null
  // This launch's time waiting for its CLI to retry a request (HI-1996), told apart from a slow model in the hover.
  const waited = live ? retryWaitsView(live) : undefined
  const effort = onServer ? null : effortLabel(provider, live?.effort, chose.effort, chose.effortGlobal, modelCaps(provider, runModel, providers[provider], settings).defaultEffort, settings)
  const threshold = compactThreshold(project.config, settings?.sessions.compactSuggestTokens ?? 0)
  const ctx = usage?.contextTokens ?? 0
  const pct = contextPercent(ctx, usage?.contextWindow)
  const over = threshold > 0 && ctx >= threshold
  const cost = live?.costUsd ?? usage?.costUsd ?? null
  const estimated = live?.costUsd !== undefined ? !!live.costEstimated : !!usage?.costEstimated
  const bytes = live?.transcriptBytes
  const sizeLimit = transcriptWarnLimit(project.config, settings?.sessions.transcriptWarnMB ?? 0)
  const long = bytes !== undefined && sizeLimit > 0 && bytes >= sizeLimit * 1024 * 1024
  const tasks = live?.backgroundTasks ?? 0
  // What a click on the size does, as the notice offers (#1057): Hand Over to… while it may hand over now (checked again
  // when clicked), else nothing but its hover saying it can when it has finished.
  const inLane = useStore((s) => onRunningLane(s.lanes, project.name, a.id))
  const now = handOverNow(live, inLane)
  // The first time either turns amber: the tip about what to do.
  useEffect(() => void (long && offerTip('transcript-long')), [long])
  useEffect(() => void (over && offerTip('compact-suggested')), [over])
  // The cost opens the session's details in the Overview (an agent's: the Assistant's footer has nowhere to go).
  const costClick = onContext ? undefined : (): void => showInOverview(project.path, a.id, 'session')
  const [footerRef, fit] = useFooterFit()
  const transcriptTip = (size: number): string =>
    tr(
      msg({
        id: 'panes.footer.transcriptTip',
        defaultMessage: "Transcript: {size}{limit, select, none {} other { (flagged over {limit} MB: Settings → Sessions)}}. A long conversation slows down the CLI and Combwork, and compacting doesn't shrink the file: it keeps the whole history.{advice, select, none {} other { {advice}}}",
        description: "Hover of a pane footer's transcript warning, and a line of its context's hover ({size}: \"12 MB\"): the size it is flagged over ({limit} MB, set in Settings → Sessions; none: leave that branch empty), why a long one matters, and when it is long what to do ({advice}; none: leave it empty)."
      }),
      {
        size: formatSize(size),
        limit: sizeLimit > 0 ? String(sizeLimit) : 'none',
        advice: long ? (transcriptAdvice ?? tr(HAND_OVER_TEXT.advice, { when: now ? 'now' : 'other' })) : 'none'
      }
    )
  // A dot between items, for the eye only.
  const sep = (key: string) => (
    <span key={key} className="foot-sep" aria-hidden="true">
      ·
    </span>
  )
  // The right side, in order (#1013): the background tasks' warning, the transcript's size, the context, the cost.
  const right: { key: string; node: ReactNode }[] = []
  if (tasks > 0)
    right.push({
      key: 'tasks',
      node: (
        <Tooltip key="tasks" content={tr(msg({ id: 'panes.footer.tasksTip', defaultMessage: '{n, plural, one {A background task it started is still running.} other {# background tasks it started are still running.}} Its status says whether its turn waits for them.', description: "Hover of a pane footer's background-task warning: how many background tasks ({n}) the agent started are still running." }), { n: tasks })}>
          <span className="pane-foot-item warn foot-tasks">
            <Icon name="warning" />
            <span className="fit-text tasks-text" data-give="2">
              {tr(msg({ id: 'panes.footer.tasks', defaultMessage: '{n, plural, one {# background task} other {# background tasks}}', description: "A pane footer's warning: how many background tasks ({n}) the agent started are still running. Keep it short." }), { n: tasks })}
            </span>
          </span>
        </Tooltip>
      )
    })
  if (long)
    right.push({
      key: 'transcript',
      node: (
        <Tooltip key="transcript" content={transcriptTip(bytes)}>
          <span className="pane-foot-item warn foot-transcript" onClick={() => (onTranscript ? onTranscript() : now ? void actions.handOverLongConversation(project.path, a.id) : undefined)}>
            <Icon name="warning" />
            <span className="fit-text size-text" data-give="3">
              {formatSize(bytes)}
            </span>
          </span>
        </Tooltip>
      )
    })
  else if (bytes !== undefined)
    // Not a warning: the first to give way, taking its dot with it (the context's hover has the size too).
    right.push({ key: 'size', node: null })
  if (usage)
    right.push({
      key: 'ctx',
      node: (
        <Tooltip
          key="ctx"
          content={
            // A click opens the session in the Overview, with its compaction history (the Assistant's footer opens nothing).
            <span className="ctx-tip" style={{ whiteSpace: 'pre-line' }}>
              {[
                ...contextLines(usage, live?.autoCompact, tr),
                tr(msg({ id: 'panes.footer.compactions', defaultMessage: '{n, plural, one {# compaction so far} other {# compactions so far}}{over, select, yes { — consider compacting} other {}}', description: "A line of the hover of a pane footer's context: how many times the conversation was compacted, and (over the user's threshold) a suggestion to compact." }), { n: usage.compactions.length, over: over ? 'yes' : 'no' }),
                ...(bytes !== undefined && !long ? [tr(msg({ id: 'panes.footer.transcriptLine', defaultMessage: 'Transcript: {size}', description: "A line of the hover of a pane footer's context: the size of the conversation's transcript ({size}: \"12 MB\")." }), { size: formatSize(bytes) })] : []),
                ...(usage.stale ? [tr(msg({ id: 'panes.footer.stale', defaultMessage: 'Couldn’t read it again just now: this may be behind.', description: "A line of the hover of a pane footer's context: Hive couldn't read the usage again, so the numbers may be old." }))] : []),
                ...(onContext ? [] : ['', tr(msg({ id: 'panes.footer.compactionHistory', defaultMessage: 'Click to view compaction history', description: "The last line of the hover of a pane footer's context: clicking shows the session's compactions in the Overview." }))])
              ].join('\n')}
            </span>
          }
        >
          <span className={cx('pane-foot-item', 'foot-ctx', over && 'warn', usage.stale && 'stale')} onClick={() => (onContext ? onContext() : showInOverview(project.path, a.id))}>
            {over && <Icon name="warning" />}
            <span className="ctx-text">{tr(CTX, { value: pct === null ? formatTokens(ctx) : fmt.percent(pct / 100) })}</span>
          </span>
        </Tooltip>
      )
    })
  else if (pending)
    // A new or other conversation: its own numbers aren't read yet (the previous one's never show).
    right.push({
      key: 'ctx',
      node: (
        <Tooltip key="ctx" content={tr(msg({ id: 'panes.footer.reading', defaultMessage: "Reading this conversation's usage…", description: "Hover of a pane footer's context before its numbers are read." }))}>
          <span className="pane-foot-item faint usage-pending">{tr(CTX, { value: '–' })}</span>
        </Tooltip>
      )
    })
  // Free (HI-1772, Darren 27 Oct): its conversation ran only on servers on this PC.
  if (live?.costFree)
    right.push({
      key: 'cost',
      node: (
        <Tooltip key="cost" content={tr(msg({ id: 'panes.footer.costFreeTip', defaultMessage: "This conversation runs only on a server on this PC, so it costs nothing. Its tokens are still counted.", description: "Hover of a pane footer's \"free (local)\" cost: the agent's connection is a model server on the user's own computer (Ollama, for example)." }))}>
          <span className="pane-foot-item foot-cost" data-cost="free">
            {tr(FREE_LOCAL)}
          </span>
        </Tooltip>
      )
    })
  else if (cost !== null && cost > 0)
    right.push({
      key: 'cost',
      node: (
        <Tooltip
          key="cost"
          content={
            <span style={{ whiteSpace: 'pre-line' }}>
              {`${estimated ? tr(msg({ id: 'panes.footer.costEstimated', defaultMessage: 'API-equivalent cost of this session, estimated by Combwork from its tokens', description: "Hover of a pane footer's cost (≈): Hive estimated it from the session's tokens at API prices." })) : tr(msg({ id: 'panes.footer.costReported', defaultMessage: 'API-equivalent cost of this session, as the provider reports it', description: "Hover of a pane footer's cost: the provider reported it, at API prices." }))}${costClick ? `\n\n${tr(COST_CLICK)}` : ''}`}
            </span>
          }
        >
          <span className="pane-foot-item foot-cost" onClick={costClick}>
            {estimated ? '≈' : ''}
            {moneyLabel(cost)}
          </span>
        </Tooltip>
      )
    })
  else if (cost === null && usage && unpricedModel(usage.provider, usage.model, settings))
    right.push({
      key: 'cost',
      node: (
        <Tooltip key="cost" content={<span style={{ whiteSpace: 'pre-line' }}>{`${unpricedText(usage.model!, providerName(usage.provider))}${costClick ? `\n\n${tr(COST_CLICK)}` : ''}`}</span>}>
          <span className="pane-foot-item foot-cost" onClick={costClick}>
            $?
          </span>
        </Tooltip>
      )
    })
  const sizeAt = right.findIndex((r) => r.key === 'size')
  if (sizeAt >= 0 && bytes !== undefined)
    right[sizeAt].node = (
      <Tooltip key="size" content={transcriptTip(bytes)}>
        <span className="pane-foot-item foot-size">
          <span className="fit-text plain size-text" data-give="1">
            {formatSize(bytes)}
            {sizeAt < right.length - 1 && (
              <span className="foot-sep" aria-hidden="true">
                ·
              </span>
            )}
          </span>
        </span>
      </Tooltip>
    )
  return (
    <div ref={footerRef} className="pane-footer-bar" data-fit={fit} onMouseDown={() => focusAgent(project.path, a.id)}>
      <Tooltip
        content={<span style={{ whiteSpace: 'pre-line' }}>{`${tr(
          msg({
            id: 'panes.footer.modelTip',
            defaultMessage: '{chosenAs, select, none {} other {{model} · chosen as {chosenAs}. }}{provider} {effort, select, yes {model and effort} other {model}} {live, select, yes {of this session} other {for new sessions}}{reported, select, yes { (effort as the session reports it)} other {}}. Change them in {where}.',
            description: "Hover of the model in a pane's footer: the model shown and the name it was chosen by ({chosenAs}; none: leave that branch empty), the provider (\"Claude Code\"), whether effort is shown too, whether it is the running session's or new sessions', and where to change them ({where}: \"Agent Settings or Project Settings\")."
          }),
          { chosenAs: shown.chosenAs || 'none', model, provider: providerName(provider), effort: effort ? 'yes' : 'no', live: live ? 'yes' : 'no', reported: live?.effort ? 'yes' : 'no', where: settingsName ?? tr(msg({ id: 'panes.footer.settingsName', defaultMessage: 'Agent Settings or Project Settings', description: "Where an agent's model and effort are changed, ending the footer model's hover (\"Change them in …\"): the two dialogs' names." })) }
        )}${waited ? `\n\n${tr(RETRY_WAITED, { minutes: Math.floor(waited.seconds / 60), waits: waited.waits, provider: providerName(provider), time: formatTime(waited.latest.since), ongoing: waited.latest.ongoing ? 'yes' : 'no' })}` : ''}`}</span>}
      >
        <span className="pane-foot-item foot-model fit-clip" onClick={() => (onSettings ? onSettings() : set({ agentSettingsFor: { project: project.path, agentId: a.id } }))}>
          {model}
          {effort && <span className="faint"> · {effort}</span>}
        </span>
      </Tooltip>
      {live?.launchedConnection && (
        <>
          {sep('s0')}
          <Tooltip content={connectionTip(live.launchedConnection, !!live.switchPending, email)}>
            <span className="pane-foot-item foot-connection fit-clip" data-connection={live.launchedConnection.id} onClick={() => (onSettings ? onSettings() : set({ agentSettingsFor: { project: project.path, agentId: a.id } }))}>
              {live.launchedConnection.note && <Icon name="warning" />} {launchedName(live.launchedConnection).name}
              {live.switchPending && <span className="faint"> · {tr(CONNECTION_TEXT.switching)}</span>}
            </span>
          </Tooltip>
        </>
      )}
      {sep('s1')}
      <ModeBadge project={project} a={a} variant="pane" />
      {/* The right side (#1013): warnings beside it, then the transcript's size, the context and the cost. */}
      <div className="grow" />
      {right.flatMap((item, i) => (i > 0 && right[i - 1].key !== 'size' ? [sep(`s-${item.key}`), item.node] : [item.node]))}
    </div>
  )
}

const CONNECTION_TEXT = {
  email: msg({ id: 'panes.footer.connectionEmail', defaultMessage: 'Signed in as {email}.', description: "Added to the hover of a pane footer's connection (HI-1756): the login the connection is signed in as ({email}: its email address)." }),
  tip: msg({ id: 'panes.footer.connectionTip', defaultMessage: 'Runs on the connection {name}.', description: "Hover of the connection in a pane's footer (HI-1755): the connection this session launched on ({name})." }),
  offFallback: msg({ id: 'panes.footer.connectionOffHere', defaultMessage: "The connection chosen for it is on an account that's off in this workspace, so it runs on its CLI's first usable connection.", description: "Added to the hover of a pane footer's connection (HI-2108): the agent's own connection is on an account turned off in this workspace, so its CLI's first usable connection runs it." }),
  missing: msg({ id: 'panes.footer.connectionRemoved', defaultMessage: "The connection chosen for it was removed, so it runs on its CLI's first usable connection. Choose another in its Agent Settings.", description: "Added to the hover of a pane footer's connection (HI-2108): the agent's connection was removed, so its CLI's first usable connection runs it. Agent Settings names a dialog." }),
  unknownLogin: msg({ id: 'panes.footer.connectionUnknown', defaultMessage: "Combwork couldn't check who this connection is signed in as when it started.", description: "Added to the hover of a pane footer's connection: the connection's sign-in couldn't be checked at launch (not the same as signed out)." }),
  loginChanged: msg({ id: 'panes.footer.connectionChanged', defaultMessage: 'Its login changed since it was added: see Settings → Accounts & Connections.', description: "Added to the hover of a pane footer's connection: its account is signed in as another login than the one it was added with. Settings → Accounts & Connections names a section." }),
  switching: msg({ id: 'panes.footer.connectionSwitching', defaultMessage: 'switches once its turn is over', description: "After the connection in a pane's footer (lower case): the agent moves to another connection once its turn is over, then carries on." }),
  switchingTip: msg({ id: 'panes.footer.connectionSwitchingTip', defaultMessage: 'Once its turn is over, it ends and carries on, on the connection chosen for it now.', description: "Added to the hover of a pane footer's connection while a switch waits for the agent's turn to be over." })
}

/**
 * The hover of a pane footer's connection: which one it runs on and who it is signed in as (HI-1756), and why it isn't
 * the one chosen, or what its check said.
 */
function connectionTip(c: NonNullable<AgentInfo['live']>['launchedConnection'], switching: boolean, email?: string): string {
  if (!c) return ''
  const parts = [tr(CONNECTION_TEXT.tip, { name: launchedName(c).name })]
  if (email) parts.push(tr(CONNECTION_TEXT.email, { email }))
  if (c.note) parts.push(tr(CONNECTION_TEXT[c.note]))
  if (switching) parts.push(tr(CONNECTION_TEXT.switchingTip))
  return parts.join(' ')
}

/** Why an agent's CLI exited before its session started, if it did (until its next launch or ✕). */
function useStartFailure(project: ProjectInfo, a: AgentInfo | null): StartFailure | undefined {
  return useStore((s) => (a ? s.startFailures[projectKey(project.path, a.id)] : undefined))
}

/** In place of "Session ended": why the CLI didn't start, what to do about it, Retry. The terminal above keeps the full output. */
function StartFailedBar({ project, a, failure, single }: { project: ProjectInfo; a: AgentInfo; failure: StartFailure; single: boolean }) {
  useLanguage()
  const retry = (): void => void (failure.resumed ? actions.resumeLast(project.path, a.id) : actions.newSession(project.path, a.id))
  const starting = useStarting(project.path, a.id)
  return (
    <div className={cx('session-ended', 'start-failed', !single && 'compact')} role="alert">
      <Icon name="error" />
      <div className="grow start-failed-text">
        <div className="start-failed-reason">
          <strong>{tr(msg({ id: 'panes.failed.title', defaultMessage: "Couldn't start:", description: "In place of a pane's \"Session ended\" bar: the agent's CLI exited before its session started; the reason follows." }))}</strong> {failure.reason}
        </div>
        {failure.hint && <div className="start-failed-hint">{failure.hint}</div>}
      </div>
      <div className="start-failed-actions">
        <button className={cx('btn', 'small', 'solid', failure.resumed ? 'act-resume' : 'act-start')} disabled={!!starting} aria-busy={!!starting || undefined} onClick={retry}>
          <Icon name={starting ? 'loading' : 'refresh'} spin={!!starting} /> {starting ? startingLabel(starting) : tr(msg({ id: 'panes.failed.retry', defaultMessage: 'Retry', description: 'Button on the bar of an agent that failed to start: tries the launch again. Keep it short.' }))}
        </button>
        {failure.fix === 'agent-setup' ? (
          <button className="btn small subtle" onClick={() => set({ setupOpen: agentProviderOf(a) })}>
            {tr(msg({ id: 'panes.failed.setup', defaultMessage: 'Provider Setup…', description: "Button on the bar of an agent that failed to start: opens Provider Setup (installing or signing in to its CLI)." }))}
          </button>
        ) : (
          <button className="btn small subtle" onClick={() => set({ agentSettingsFor: { project: project.path, agentId: a.id } })}>
            {tr(AGENT_SETTINGS)}
          </button>
        )}
        <IconButton icon="close" title={tr(msg({ id: 'panes.failed.dismiss', defaultMessage: 'Dismiss (the terminal keeps the output)', description: 'Tooltip of the ✕ on the bar of an agent that failed to start.' }))} onClick={() => clearStartFailure(project.path, a.id)} />
      </div>
    </div>
  )
}

/**
 * Where the agent works, beside its name (#1442): "in slot-b", a link to Version Control's Branches & remotes, while it
 * builds in a slot; "carried: hb2", "home: hr4" or "0.9 worktree: hb1" as text; nothing in the project folder.
 */
function PlaceMark({ project, a }: { project: ProjectInfo; a: AgentInfo }) {
  const text = placeText(a.place)
  if (!text) return null
  return (
    <Tooltip content={placeTip(a.place)}>
      {a.place.is === 'slot' ? (
        <button type="button" className="link agent-place" data-place={a.place.is} onClick={(e) => { e.stopPropagation(); openVersionControl(project.path, 'branches') }}>
          {text}
        </button>
      ) : (
        <span className="faint agent-place" data-place={a.place.is}>
          {text}
        </span>
      )}
    </Tooltip>
  )
}

/** "<b>B1</b> is not running.", the agent's name in bold. */
const notRunningText = (agent: string): ReactNode[] => tRich<ReactNode>(msg({ id: 'panes.body.notRunning', defaultMessage: '<b>{agent}</b> is not running.', description: "A pane of an agent that isn't running ({agent}: its name, in bold; keep the <b> tags around it)." }), { agent, b: (chunks) => <strong key="b">{chunks}</strong> })

/** "Works in its own worktree on <code>hive/b1</code>." */
const ownWorktreeText = (branch: string): ReactNode[] => tRich<ReactNode>(msg({ id: 'panes.body.worktree', defaultMessage: 'Works in its own worktree on <code>{branch}</code>.', description: "A stopped worktree agent's pane: its branch ({branch}, shown as code; keep the <code> tags around it)." }), { branch, code: (chunks) => <code key="code">{chunks}</code> })

const code = (chunks: ReactNode[]): ReactNode => <code key="code">{chunks}</code>

/**
 * Where a stopped agent works (#1552, after #1441's migration): its 0.9 worktree while not migrated, its slot or the slot
 * kept for it; in the project folder, that its last conversation resumes in its retired home when it does. Null: nothing
 * to say (the project folder).
 */
function placeLine(a: AgentInfo): ReactNode[] | null {
  const own = legacyOf(a)
  if (own) return ownWorktreeText(own.branch)
  const p = a.place
  if (p.is === 'slot' && p.name) return tRich<ReactNode>(msg({ id: 'panes.body.inSlot', defaultMessage: 'Works in <code>{name}</code>.', description: "A stopped agent's pane: the slot it works in ({name}: its name, such as slot-b, shown as code; keep the <code> tags around it). Glossary: slot." }), { name: p.name, code })
  if (p.is === 'carried' && p.name) return tRich<ReactNode>(msg({ id: 'panes.body.inCarried', defaultMessage: 'Works in <code>{name}</code>, the slot kept for it.', description: "A stopped agent's pane: its carried slot ({name}: its name, such as hb2, shown as code; keep the <code> tags around it), its own worktree from before 1.0, kept for it as a slot. Glossary: slot." }), { name: p.name, code })
  if (a.resume?.home) return tRich<ReactNode>(msg({ id: 'panes.body.resumesInHome', defaultMessage: 'A new conversation starts in the project folder; Resume opens its last one in its old folder, <code>{name}</code>.', description: "A stopped agent's pane, for a reviewer whose own worktree from before 1.0 was kept as its retired home: new conversations start in the project folder, and Resume reopens its last conversation in that old folder ({name}: the folder's name, shown as code; keep the <code> tags around it)." }), { name: a.resume.home, code })
  return null
}

/**
 * An empty cell of the panes (#762): a quiet placeholder to drop an agent on, Move Agent Here ▾ to bring one from another
 * page (moving one on this page leaves its own cell empty, so only other pages' are offered), and Add Agent.
 */
function EmptyCell({ project, cell, canAdd }: { project: ProjectInfo; cell: number; canAdd: boolean }) {
  useLanguage()
  const menu = useContextMenu()
  const perPage = layoutPanes(useStore((s) => shownLayout(project, s)))
  const cells = paneCells(project)
  const page = Math.floor(cell / perPage)
  const others = project.agents.filter((a) => cellPage(cells, a.id, perPage) !== page)
  const placed = actions.panesPlaced(project)
  const label = tr(msg({ id: 'panes.empty.moveHere', defaultMessage: 'Move Agent Here', description: "Button on an empty pane (#762): opens a list of the agents on other pages, to move one into this pane." }))
  return (
    <div className="pane-placeholder empty-cell">
      <p className="faint">{placed && project.agents.length > 0 ? tr(msg({ id: 'panes.empty.drop', defaultMessage: 'Drop an agent here', description: "An empty pane (#762): the user can drag an agent's pane header onto it to move the agent there." })) : tr(msg({ id: 'panes.body.empty', defaultMessage: 'Empty pane', description: 'A pane with no agent in it (the layout has more panes than the page has agents).' }))}</p>
      <div className="btns">
        {placed && others.length > 0 && (
          <button
            className="btn subtle small"
            aria-haspopup="menu"
            aria-expanded={menu.shown}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              menu.openAt(r.left, r.bottom + 2, others.map((a) => ({ label: a.name, detail: tr(msg({ id: 'panes.empty.onPage', defaultMessage: 'Page {page}', description: "The detail of an agent in an empty pane's Move Agent Here list: the page it is on now." }), { page: cellPage(cells, a.id, perPage) + 1 }), onClick: () => void actions.placeAgent(project.path, a.id, cell) })), e.detail === 0)
            }}
          >
            <Icon name="arrow-swap" /> {label} <Icon name="chevron-down" />
          </button>
        )}
        {canAdd && <AddAgentButton project={project} className="subtle small" />}
      </div>
      {menu.element}
    </div>
  )
}

/** What a pane shows when its agent has no terminal yet, or when the pane is empty. */
function PaneBody({ project, a, hasTerminal, single, cell }: { project: ProjectInfo; a: AgentInfo | null; hasTerminal: boolean; single: boolean; cell: number }) {
  useLanguage()
  const failure = useStartFailure(project, a)
  const limit = useAgentLimit(project)
  const startBlocked = useStartBlocked()
  // From the click until the session runs (#1177).
  const starting = useStarting(project.path, a?.id ?? null)
  const startingNew = starting?.kind === 'start'
  // Retry Setup and Start Without Setup: the one clicked shows it.
  const settingUp = startingNew && !starting.skipSetup
  const skippingSetup = startingNew && !!starting.skipSetup
  // Why and when it stopped (HI-1881), while it shows as stopped (not running, starting or failed to start).
  const end = useStoppedEnd(project.path, a)
  if (!a) {
    // A single empty pane is a project without agents: its "No agents yet" (SessionEmpty) shows, not covered (#227).
    if (single) return null
    return <EmptyCell project={project} cell={cell} canAdd={project.agents.length < limit} />
  }
  const own = legacyOf(a)
  const setupPending = !!own && legacySetupPending(a) && !!project.config.worktreeSetup.trim()
  if (a.live) return null
  if (hasTerminal && failure && !setupPending) return <StartFailedBar project={project} a={a} failure={failure} single={single} />
  if (hasTerminal) {
    // The session ended: its output stays visible above this bar, dimmed (HI-1881), with why and when it stopped. From
    // the accepted start of the next one, the bar says it starts and is no longer the stopped bar.
    return (
      <div className={cx('session-ended', !single && 'compact', !starting && !setupPending && 'stopped')} data-stopped={end?.why ?? (starting ? undefined : '')}>
        <Icon name={starting ? 'loading' : 'debug-disconnect'} spin={!!starting} />
        <span className="grow">
          {setupPending
            ? tr(msg({ id: 'panes.body.setupFailed', defaultMessage: 'Setup did not finish.', description: "The bar under a worktree agent's ended session: its worktree setup command didn't finish." }))
            : starting
              ? startingLabel(starting)
            : end
              ? stoppedLine(end)
            : single
              ? tr(msg({ id: 'panes.body.endedLong', defaultMessage: 'The session has ended. Resume it, or start a new one.', description: "The bar under an agent's ended session (one pane)." }))
              : tr(msg({ id: 'panes.body.ended', defaultMessage: 'Session ended.', description: "The bar under an agent's ended session (several panes: short)." }))}
        </span>
        {setupPending ? (
          <>
            <button className="btn small act-start solid" disabled={!!starting} aria-busy={settingUp || undefined} onClick={() => void actions.newSession(project.path, a.id)}>
              <Icon name={settingUp ? 'loading' : 'refresh'} spin={settingUp} /> {settingUp ? startingLabel(starting) : tr(msg({ id: 'panes.body.retrySetup', defaultMessage: 'Retry Setup', description: "Button under a worktree agent's ended session: runs its setup command again, then starts it." }))}
            </button>
            <button className="btn small act-start" disabled={!!starting} aria-busy={skippingSetup || undefined} onClick={() => void actions.newSession(project.path, a.id, { skipSetup: true })}>
              {skippingSetup && <Icon name="loading" spin />} {skippingSetup ? startingLabel(starting) : tr(msg({ id: 'panes.body.skipSetup', defaultMessage: 'Start Without Setup', description: "Button under a worktree agent's ended session: starts it without its setup command." }))}
            </button>
          </>
        ) : (
          // Together, so in a narrow pane they wrap under the text as one row (#890).
          <span className="session-ended-actions">
            <ResumeButton project={project} a={a} className={cx('act-resume', 'solid', !single && 'small')} />
            <Tooltip content={startBlocked ?? tr(NEW_SESSION)}>
              <button className={cx('btn', 'act-start', !single && 'small')} disabled={!!startBlocked || !!starting} aria-busy={startingNew || undefined} onClick={() => void actions.newSession(project.path, a.id)} aria-label={startingNew ? startingLabel(starting) : tr(NEW_SESSION)}>
                <Icon name={startingNew ? 'loading' : 'add'} spin={startingNew} /> <span className="btn-label">{startingNew ? startingLabel(starting) : tr(NEW_SESSION)}</span>
              </button>
            </Tooltip>
          </span>
        )}
      </div>
    )
  }
  if (single) return null
  const where = placeLine(a)
  return (
    <div className="pane-placeholder">
      <p>{notRunningText(a.name)}</p>
      {where && <p className="faint">{where}</p>}
      {setupPending && <p className="faint">{tr(msg({ id: 'panes.body.setupFirst', defaultMessage: 'Its setup command runs first.', description: "A stopped worktree agent's pane: its worktree setup command runs before its next session." }))}</p>}
      <div className="btns">
        <Tooltip content={startBlocked}>
          <button className="btn act-start solid small" disabled={!!startBlocked || !!starting} aria-busy={startingNew || undefined} onClick={() => void actions.newSession(project.path, a.id)}>
            <Icon name={startingNew ? 'loading' : 'add'} spin={startingNew} /> {startingNew ? startingLabel(starting) : tr(NEW_SESSION)}
          </button>
        </Tooltip>
        <ResumeButton project={project} a={a} className={cx(RESUME_TINT, 'small')} />
      </div>
    </div>
  )
}

/** Pane frames (headers, borders, placeholders) over the terminals of the selected project. */
export function PaneChrome({ project, panes }: { project: ProjectInfo; panes: (string | null)[] }) {
  useLanguage()
  const epochs = useStore((s) => s.sessionEpoch)
  const focused = useStore((s) => s.focusedAgent[project.path]) ?? project.agents[0]?.id
  // A pane something just asked to show (a run's agent in the Progress panel): highlighted for a moment.
  const flash = useStore((s) => s.paneFlash)
  const single = panes.length === 1
  const dragging = useAgentDrag(project)
  const [over, setOver] = useState<string | null>(null)
  useEffect(() => setOver(null), [dragging])
  // The page shown's first cell (#762): a pane's cell is this plus its place on the page.
  const first = single ? 0 : agentPage(project, focused ?? null) * panes.length
  return (
    <>
      {panes.map((id, i) => {
        const a = project.agents.find((x) => x.id === id) ?? null
        const r = paneRect(panes.length, i)
        const hasTerminal = !!a && (!!a.live || epochs[projectKey(project.path, a.id)] !== undefined)
        return (
          <div
            key={`${i}:${id ?? ''}`}
            className={cx('agent-pane', !single && 'framed', !single && focused === id && 'focused', r.x > 0 && 'left-border', r.y > 0 && 'top-border', !!a && flash?.key === projectKey(project.path, a.id) && 'flash')}
            style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
          >
            {/* One agent or several: every agent pane has the same header and footer. */}
            {a && <PaneHeader project={project} a={a} focused={!single && focused === a.id} />}
            <div className="agent-pane-body" style={{ top: a ? PANE_HEADER : 0, bottom: a ? PANE_FOOTER : 0 }}>
              <PaneBody project={project} a={a} hasTerminal={hasTerminal} single={single} cell={first + i} />
            </div>
            {a && <PaneFooter project={project} a={a} />}
            {/*
              While an agent is dragged (#135): drop it on another agent's pane to swap their places, or on an empty cell
              to move it there (#762). Not on its own pane, where it would do nothing.
            */}
            {dragging && !single && a?.id !== dragging && (
              <div
                className={cx('pane-drop', over === (a?.id ?? `empty:${i}`) && 'over')}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setOver(a?.id ?? `empty:${i}`)
                }}
                onDragLeave={() => setOver((o) => (o === (a?.id ?? `empty:${i}`) ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  placeDrop(project, first + i)
                }}
              >
                <span>
                  <Icon name="arrow-swap" /> {a ? tr(SWAP_WITH, { agent: a.name }) : tr(msg({ id: 'panes.drop.move', defaultMessage: 'Move here', description: 'Shown over an empty pane while an agent is dragged onto it: dropping moves it there.' }))}
                </span>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
