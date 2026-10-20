import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ALL_PROJECTS, RECENT_RUNS, SHOW_ALL, activeFilter, agentChoices, ProgressSync, barLook, cardRefText, shortRevision, filterChoices, filterMergeSlots, filterRuns, fractionDone, inStrip, isListed, isOpenRun, isRecent, runDetails, runAgentName, runDetailsText, runStateWord, runStatusLine, stripRuns, stripSummary, unseenTrouble } from '@shared/progress'
import { durationText } from '@shared/tasks'
import type { MergeSlotInfo, ProgressRun, ProgressTelling } from '@shared/types'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import { attempt, selectProject } from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { findProject, flashPane, get, notify, projectKey, revealAgent, set, setAssistantOpen, setProgressFilter, setProgressOpen, useDateStyle, useLanguage, useProgressFilter, useProgressOpen, useStore } from '../store'
import { useNow } from '../usage'
import { cx, formatKeybinding } from '../util'
import { AssistantMark } from './AssistantMark'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { useMergeSlots } from './MergeSlots'
import { LanesSection } from './ProgressLanes'
import { MergeCards } from './ProgressMerge'
import { useLanes } from '../laneSource'
import { ShowAllList } from './ShowAllList'
import { Icon, IconButton, Tooltip } from './ui'

/**
 * The Progress panel: long runs agents report (tests, builds), each with its agent, how far along and the time left.
 * On the right, beside the Assistant's panel; folded, a strip with a small bar per run. It never opens by itself.
 * A run listed there, or under Recent, opens its details; its agent's name shows that agent. Above the runs, a card per
 * merge going on (ProgressMerge); pinned to the bottom, the lanes working through cards (ProgressLanes, #484).
 */

const NO_RUNS: ProgressRun[] = []

const SHOW_THE_AGENT: Msg = msg({ id: 'board.progress.showTheAgent', defaultMessage: 'Show the agent', description: 'Button and tooltip on a Progress panel run: shows the agent that ran it.' })
const WAITING: Msg = msg({ id: 'board.progress.waiting', defaultMessage: 'waiting', description: "A run's state on its bar (accessible value) and in a list of runs (build (waiting)), lower case: it waits (for a test slot, say)." })

/** A tooltip with the command's shortcut after it, in brackets, when it has one. */
const withKey = (text: string, kb: string | undefined): string => (kb ? `${text} (${formatKeybinding(kb)})` : text)

type StoreState = Parameters<typeof findProject>[0]

/** Why a run's agent can't be shown, or null when it can: the Assistant, or a project agent that is still there. */
function whyNotShown(s: StoreState, r: ProgressRun): string | null {
  if (r.source === 'assistant') return s.workspace?.assistant ? null : tr(msg({ id: 'board.progress.noAssistant', defaultMessage: 'The Assistant is not in this workspace.', description: "Why a Progress panel run's agent can't be shown: the run is the Hive Assistant's, and this workspace has none." }))
  if (r.source === 'api') return tr(msg({ id: 'board.progress.scriptRun', defaultMessage: 'A script reported it, not an agent: there is no agent to show.', description: "Why a Progress panel run's agent can't be shown: a script reported the run." }))
  const p = r.projectPath ? findProject(s, r.projectPath) : null
  if (!p) return tr(msg({ id: 'board.progress.projectGone', defaultMessage: 'Its project is no longer in this workspace.', description: "Why a Progress panel run's agent can't be shown: its project was removed from the workspace." }))
  if (!r.agentId || !p.agents.some((a) => a.id === r.agentId)) return tr(msg({ id: 'board.progress.agentGone', defaultMessage: '{agent} has been removed from {project}.', description: "Why a Progress panel run's agent can't be shown: the agent ({agent}) was removed from its project ({project})." }), { agent: runAgentName(r, tr), project: p.name })
  return null
}

/**
 * Shows the agent that reported a run (the Assistant's panel for the Assistant), and says so: its pane is highlighted
 * for a moment and takes the keyboard, so showing an agent that was already on screen visibly does something.
 */
function showRunAgent(r: ProgressRun): void {
  const s = get()
  const why = whyNotShown(s, r)
  if (why) return void notify('info', tr(msg({ id: 'board.progress.cantShow', defaultMessage: "Can't show {agent}", description: "A notification's title: the agent ({agent}) that ran a Progress panel run can't be shown. Its message says why." }), { agent: runAgentName(r, tr) }), why)
  if (r.source === 'assistant') {
    setAssistantOpen(true)
    return flashPane(projectKey(s.workspace!.assistant!.path, 'assistant'))
  }
  const p = findProject(s, r.projectPath!)!
  selectProject(p.path)
  revealAgent(p, r.agentId!)
  flashPane(projectKey(p.path, r.agentId!))
}

/** What showing a run's agent is called, for its button. */
const showLabel = (r: ProgressRun): string =>
  r.source === 'assistant'
    ? tr(msg({ id: 'board.progress.showAssistant', defaultMessage: 'Show the Assistant, which ran {run}', description: "Accessible name of the button showing the Hive Assistant, which ran a Progress panel run ({run}: the run's title)." }), { run: r.title })
    : tr(msg({ id: 'board.progress.showAgent', defaultMessage: 'Show {agent}, which ran {run}', description: "Accessible name of the button showing the agent ({agent}) that ran a Progress panel run ({run}: the run's title)." }), { agent: runAgentName(r, tr), run: r.title })

/** This window's runs, kept in step with main's tellings (#1108): the others stay the same objects. */
const progressSync = new ProgressSync({
  workspace: () => get().workspace?.path ?? null,
  runs: () => get().progressRuns,
  set: (runs) => set({ progressRuns: runs }),
  load: () => call('progress:snapshot')
})

/** A telling of this window's runs (`progress-runs`). */
export function progressRunsChanged(e: ProgressTelling): void {
  progressSync.told(e)
}

/** This window's runs, read when its workspace changes (tellings keep them current). */
function useProgressRuns(): ProgressRun[] {
  const ws = useStore((s) => s.workspace?.path)
  const on = useStore((s) => s.settings?.general.progressPanel !== false)
  useEffect(() => {
    if (ws && on) progressSync.reload()
  }, [ws, on])
  return useStore((s) => s.progressRuns ?? NO_RUNS)
}

export function ProgressPanel() {
  useLanguage()
  const on = useStore((s) => s.settings?.general.progressPanel !== false)
  const open = useProgressOpen()
  const runs = useProgressRuns()
  const slots = useMergeSlots()
  const lanes = useLanes()
  const chosen = useProgressFilter()
  const workspace = useStore((s) => s.workspace)
  const focused = useStore((s) => s.windowFocused)
  const width = usePaneSize('progress', 280)
  // The run whose details are open.
  const [detail, setDetail] = useState<string | null>(null)
  // The same function every time, so a row whose run didn't change isn't drawn again (#1108).
  const toggle = useCallback((id: string): void => setDetail((d) => (d === id ? null : id)), [])
  const anyOpen = runs.some(isOpenRun)
  // Once a second while something runs or is about to fold into Recent (a passed run, a failure just seen), else now
  // and then.
  const folding = runs.some((r) => !r.dismissed && (r.state === 'passed' || r.state === 'stopped' || r.seenAt !== null))
  const now = useNow(anyOpen || folding ? 1000 : 30000)
  const unseen = runs.some(unseenTrouble)
  // Looking at the open panel counts as seeing what failed or went stale: the taskbar's and the strip's red clear,
  // and those runs fold into Recent a few seconds later.
  useEffect(() => {
    if (on && open && focused && unseen) void call('progress:seen')
  }, [on, open, focused, unseen, runs])
  if (!on) return null
  // The filter (#251): one project's runs (and one agent's), or all; offered when the runs span more than one project.
  const nameOf = (p: string): string => workspace?.projects.find((x) => x.path.toLowerCase() === p.toLowerCase())?.name ?? p.split(/[\\/]/).pop() ?? p
  const choices = filterChoices(runs, nameOf, tr)
  const filter = activeFilter(runs, chosen)
  const shown = filterRuns(runs, filter)
  const filterName = filter === SHOW_ALL ? null : `${choices.find((c) => c.value === filter.project)?.label ?? ''}${filter.agent ? ` · ${(shown[0] ? runAgentName(shown[0], tr) : '')}` : ''}`
  if (!open) return <ProgressRail runs={shown.filter((r) => inStrip(r, now))} filtered={filterName ? { name: filterName, all: runs.filter((r) => inStrip(r, now)).length } : null} />
  const listed = shown.filter((r) => isListed(r, now))
  // The merges and lanes of the project (and agent) the runs are filtered to, or of every project (#810).
  const merging = filterMergeSlots(slots, filter)
  const shownLanes = filter.project === ALL_PROJECTS ? lanes : lanes.filter((l) => l.project.toLowerCase() === filter.project && (!filter.agent || l.builder.agentId === filter.agent || l.reviewer?.agentId === filter.agent))
  // The holder's current step: its newest run still going, in its project.
  const stepOf = (s: MergeSlotInfo): string | null => {
    const h = s.holder
    const r = h?.agentId ? runs.find((x) => isOpenRun(x) && x.agentId === h.agentId && x.projectPath?.toLowerCase() === s.project.toLowerCase()) : undefined
    if (!r) return null
    const step = stepLine(r)
    return step ? `${r.title} · ${step}` : r.title
  }
  // Recent: the newest few, and Show all for the rest Hive keeps (#352).
  const recent = shown.filter((r) => isRecent(r, now))
  const agents = filter.project !== ALL_PROJECTS ? agentChoices(runs, filter.project, tr) : []
  const kb = commandKeybinding('progress.toggle')

  return (
    <div
      className="progress-panel"
      style={{ width }}
      role="region"
      aria-label={tr(msg({ id: 'board.progress.region', defaultMessage: 'Progress', description: 'Accessible name of the Progress panel (long runs agents report: tests, builds).' }))}
      onKeyDown={(e) => {
        // Escape closes a run's details (and goes no further).
        if (e.key === 'Escape' && detail) {
          e.stopPropagation()
          const id = detail
          setDetail(null)
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`.progress-panel [data-run="${id}"] .progress-details-toggle`)?.focus())
        }
      }}
    >
      <PaneResizer paneKey="progress" edge="left" min={220} max={640} keep={300} />
      <div className="progress-header">
        <Icon name="pulse" /> {tr(msg({ id: 'board.progress.title', defaultMessage: 'Progress', description: "The Progress panel's title, in its header (long runs agents report: tests, builds)." }))}
        <div className="grow" />
        <IconButton icon="chevron-right" title={withKey(tr(msg({ id: 'board.progress.fold', defaultMessage: 'Fold the Progress panel', description: "Tooltip of the button folding the Progress panel to a strip at the window's edge. A shortcut may follow in brackets." })), kb)} onClick={() => setProgressOpen(false)} />
      </div>
      {choices.length > 1 && (
        <div className="progress-filter">
          <select className="select" aria-label={tr(msg({ id: 'board.progress.filterProject', defaultMessage: 'Show the runs of', description: "Accessible name of the Progress panel's project filter (a list of projects follows; the agent filter's name continues the sentence: …and of the agent)." }))} value={filter.project} onChange={(e) => setProgressFilter({ project: e.target.value })}>
            <option value={ALL_PROJECTS}>{tr(msg({ id: 'board.progress.allProjects', defaultMessage: 'All projects', description: "A choice of the Progress panel's project filter: every project's runs." }))}</option>
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {agents.length > 1 && (
            <select className="select" aria-label={tr(msg({ id: 'board.progress.filterAgent', defaultMessage: '…and of the agent', description: "Accessible name of the Progress panel's agent filter, continuing the project filter's (Show the runs of): a list of the project's agents follows." }))} value={filter.agent ?? ''} onChange={(e) => setProgressFilter({ project: filter.project, ...(e.target.value ? { agent: e.target.value } : {}) })}>
              <option value="">{tr(msg({ id: 'board.progress.allAgents', defaultMessage: 'All agents', description: "A choice of the Progress panel's agent filter: the runs of every agent of the chosen project." }))}</option>
              {agents.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <MergeCards slots={merging} projectName={nameOf} showProject={(workspace?.projects.length ?? 0) > 1} stepOf={stepOf} now={now} />
      {merging.length > 0 && <div className="progress-divider" role="separator" />}
      <div className="progress-body">
        {listed.length === 0 && !merging.length && (
          <div className="pane-empty progress-empty">
            {tr(msg({ id: 'board.progress.empty', defaultMessage: 'Nothing is running. When an agent runs tests or a build with progress reporting, it shows here with how far along it is and the time left.', description: 'The Progress panel when it has no runs.' }))}
          </div>
        )}
        {listed.map((r) => (
          <RunRow key={r.id} run={r} now={now} open={detail === r.id} onToggle={toggle} />
        ))}
        {recent.length > 0 && (
          <>
            <div className="progress-section">{tr(msg({ id: 'board.progress.recent', defaultMessage: 'Recent', description: 'A section heading in the Progress panel: runs that finished a while ago.' }))}</div>
            <ShowAllList
              items={recent}
              few={RECENT_RUNS}
              keyOf={(r) => r.id}
              renderItem={(r) => <RecentRow run={r} now={detail === r.id ? now : 0} open={detail === r.id} onToggle={toggle} />}
              label={tr(msg({ id: 'board.progress.recentRuns', defaultMessage: 'Recent runs', description: "What the Progress panel's Recent list holds, for its Show all button and accessible name." }))}
              foldKey={workspace ? `progress-recent-all:${workspace.path.toLowerCase()}` : undefined}
              className="progress-recent-list"
            />
          </>
        )}
      </div>
      <LanesSection lanes={shownLanes} all={lanes} width={width} />
    </div>
  )
}

/** Its steps: "4 of 12: carddialog", or the step's name alone; while it waits, what for (#549). */
function stepLine(r: ProgressRun): string | null {
  if (r.state === 'running' && r.waiting) return r.waiting
  if (r.total === null) return r.stepName
  const values = { step: Math.min((r.step ?? 0) + (r.state === 'running' && r.stepName ? 1 : 0), r.total), total: r.total }
  if (!r.stepName) return tr(msg({ id: 'board.progress.stepOf', defaultMessage: '{step, number} of {total, number}', description: "A run's step in the Progress panel, under its bar: step {step} of {total}." }), values)
  return tr(msg({ id: 'board.progress.stepOfNamed', defaultMessage: '{step, number} of {total, number}: {name}', description: "A run's step in the Progress panel, under its bar: step {step} of {total}, and the step's name ({name}, as its reporter named it)." }), { ...values, name: r.stepName })
}

/**
 * One run: who, what, a bar, the step, elapsed time and time left; a failed or stale one can be dismissed. A click on it
 * opens its details (and closes them); its agent's name shows the agent.
 */
const RunRow = memo(function RunRow({ run: r, now, open, onToggle }: { run: ProgressRun; now: number; open: boolean; onToggle: (id: string) => void }) {
  // Its own: a memo'd row isn't drawn with its parent, so it follows the language itself.
  useLanguage()
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const showable = useStore((s) => whyNotShown(s, r) === null)
  const fraction = fractionDone(r)
  const look = barLook(r)
  const step = stepLine(r)
  return (
    <div
      className={cx('progress-run', r.state, look === 'waiting' && 'waiting', open && 'open')}
      data-run={r.id}
      onClick={() => {
        // Not when the click ended a text selection (copying a failure's summary).
        if (!window.getSelection()?.toString()) onToggle(r.id)
      }}
    >
      <div className="progress-run-top">
        {showable ? (
          <button
            type="button"
            className="progress-run-show"
            title={tr(SHOW_THE_AGENT)}
            aria-label={showLabel(r)}
            onClick={(e) => {
              e.stopPropagation()
              showRunAgent(r)
            }}
          >
            <RunWho run={r} project={project} />
          </button>
        ) : (
          <span className="progress-run-show">
            <RunWho run={r} project={project} />
          </span>
        )}
        <div className="grow" />
        {r.state === 'passed' && <Icon name="pass" className="progress-ok" />}
        {r.state === 'failed' && <Icon name="error" className="progress-fail" />}
        {r.state === 'stale' && <Icon name="warning" className="progress-stale" />}
        {r.state === 'stopped' && <Icon name="circle-slash" className="progress-stopped" />}
        {look === 'waiting' && <Icon name="clock" className="progress-waiting-icon" />}
        <DetailsToggle run={r} open={open} onToggle={onToggle} />
        {(r.state === 'failed' || r.state === 'stale') && (
          <IconButton
            icon="close"
            title={tr(msg({ id: 'board.progress.dismiss', defaultMessage: 'Dismiss (it stays under Recent)', description: "Tooltip of the button dismissing a failed or stale run in the Progress panel. Recent is the panel's section of older runs." }))}
            onClick={(e) => {
              e.stopPropagation()
              void call('progress:dismiss', r.id)
            }}
          />
        )}
      </div>
      {(r.card || r.revision) && <RunFor run={r} />}
      <Tooltip block content={r.command ?? r.title}>
        <div className="progress-title">{r.title}</div>
      </Tooltip>
      {/* Waiting (#549): a still, hatched bar across, no fill and no value: nothing has started. */}
      <div
        className={cx('progress-bar', look === 'moving' && 'indeterminate', look === 'waiting' && 'waiting')}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={look === 'steps' ? Math.round(fraction! * 100) : undefined}
        aria-valuetext={look === 'waiting' ? tr(WAITING) : undefined}
        aria-label={r.title}
      >
        <div style={{ width: `${look === 'steps' ? Math.round(fraction! * 100) : look === 'moving' ? 30 : 100}%` }} />
      </div>
      {step && <div className="progress-step faint">{step}</div>}
      <div className="progress-status faint">{runStatusLine(r, now, tr)}</div>
      {r.summary && r.state === 'failed' && <div className="progress-summary">{r.summary}</div>}
      {open && <RunDetails run={r} now={now} />}
    </div>
  )
})

/**
 * What a run ran for (#1220), under its agent: "#1061 · a3f2c1d". The card opens it; the revision copies the whole
 * commit id.
 */
function RunFor({ run: r }: { run: ProgressRun }) {
  const card = r.card ? cardRefText(r.card) : null
  return (
    <div className="progress-run-for faint">
      {card && (
        <button
          type="button"
          className="progress-run-card"
          title={tr(msg({ id: 'board.progress.openCard', defaultMessage: 'Open {card}', description: "Tooltip of a run's card in the Progress panel (under its agent): opens the card. {card} is the card's reference (#1061)." }), { card })}
          onClick={(e) => {
            e.stopPropagation()
            set({ taskOpen: r.card! })
          }}
        >
          {card}
        </button>
      )}
      {card && r.revision && <span aria-hidden="true"> · </span>}
      {r.revision && (
        <button
          type="button"
          className="progress-run-revision"
          title={tr(msg({ id: 'board.progress.copyRevision', defaultMessage: 'Copy revision {revision}', description: "Tooltip of a run's revision in the Progress panel (under its agent): copies the whole commit id. {revision} is its short form (a3f2c1d)." }), { revision: shortRevision(r.revision) })}
          onClick={(e) => {
            e.stopPropagation()
            const id = r.revision!
            void navigator.clipboard.writeText(id).then(
              () => notify('success', tr(msg({ id: 'board.progress.revisionCopied', defaultMessage: 'Revision {revision} copied', description: "A notification after copying a run's revision (a commit id) from the Progress panel. {revision} is its short form (a3f2c1d)." }), { revision: shortRevision(id) })),
              () => notify('error', tr(msg({ id: 'board.progress.revisionCopyFailed', defaultMessage: 'Could not copy the revision', description: "A notification: copying a run's revision (a commit id) from the Progress panel failed." })))
            )
          }}
        >
          <code>{shortRevision(r.revision)}</code>
        </button>
      )}
    </div>
  )
}

/** The button opening or closing a run's details (the row's click does the same; this is it for the keyboard). */
function DetailsToggle({ run: r, open, onToggle }: { run: ProgressRun; open: boolean; onToggle: (id: string) => void }) {
  return (
    <IconButton
      icon={open ? 'chevron-up' : 'chevron-down'}
      className="progress-details-toggle"
      title={
        open
          ? tr(msg({ id: 'board.progress.hideDetails', defaultMessage: 'Hide details for {run}', description: "Tooltip of the button closing a run's details in the Progress panel ({run}: the run's title)." }), { run: r.title })
          : tr(msg({ id: 'board.progress.showDetails', defaultMessage: 'Show details for {run}', description: "Tooltip of the button opening a run's details in the Progress panel ({run}: the run's title)." }), { run: r.title })
      }
      expanded={open}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(r.id)
      }}
    />
  )
}

/** Who ran it: the provider's icon (the Assistant's mark for its runs, #399), the agent and its project. */
function RunWho({ run: r, project }: { run: ProgressRun; project: string | null }) {
  return (
    <>
      {r.source === 'assistant' ? <AssistantMark /> : r.provider ? <ProviderIcon provider={r.provider} /> : <Icon name="terminal" />}
      <span className="progress-agent">{runAgentName(r, tr)}</span>
      {project && <span className="faint progress-project">{project}</span>}
    </>
  )
}

/**
 * A finished run under Recent: one line, red when it failed, with how long it took and a chevron after it (#251); a
 * click on the line, or the chevron (the keyboard's way), opens its details.
 */
// A closed one's `now` is 0: nothing in it shows the time, so a second passing doesn't draw it again.
const RecentRow = memo(function RecentRow({ run: r, now, open, onToggle }: { run: ProgressRun; now: number; open: boolean; onToggle: (id: string) => void }) {
  useLanguage()
  const item = useRef<HTMLDivElement>(null)
  // Opened in the scrolling box of all of them, its details scroll into view.
  useEffect(() => {
    if (open) item.current?.querySelector('.progress-details')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  const took = r.finishedAt !== null ? durationText(r.finishedAt - r.startedAt, tr) : ''
  const icon = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'error' : r.state === 'stopped' ? 'circle-slash' : 'warning'
  const values = { agent: runAgentName(r, tr), run: r.title, state: runStateWord(r, tr) }
  const hover = took
    ? tr(msg({ id: 'board.progress.recentHoverTook', defaultMessage: '{agent}: {run} {state} ({took})', description: "Tooltip of a run under the Progress panel's Recent: its agent, its title ({run}), its state in a few words ({state}: failed, stopped reporting…) and how long it took ({took}: 4 min)." }), { ...values, took })
    : tr(msg({ id: 'board.progress.recentHover', defaultMessage: '{agent}: {run} {state}', description: "Tooltip of a run under the Progress panel's Recent: its agent, its title ({run}) and its state in a few words ({state}: failed, stopped reporting…)." }), values)
  return (
    <div ref={item} className={cx('progress-recent-item', r.state, open && 'open')} data-run={r.id}>
      <div
        className={cx('progress-recent', r.state)}
        onClick={() => {
          if (!window.getSelection()?.toString()) onToggle(r.id)
        }}
      >
        <Tooltip block content={`${hover}${r.summary ? `\n${r.summary}` : ''}`}>
          <Icon name={icon} /> <span className="progress-recent-text">{runAgentName(r, tr)} · {r.title}</span>
          <span className="faint progress-recent-took">{took}</span>
        </Tooltip>
        <DetailsToggle run={r} open={open} onToggle={onToggle} />
      </div>
      {open && <RunDetails run={r} now={now} />}
    </div>
  )
})

/** Copies a run's command or its details, saying so. */
function copy(what: 'command' | 'details', text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => notify('success', tr(msg({ id: 'board.progress.copied', defaultMessage: '{what, select, command {Command copied} other {Details copied}}', description: "A notification after copying a run's command or its details from the Progress panel." }), { what })),
    () => notify('error', tr(msg({ id: 'board.progress.copyFailed', defaultMessage: '{what, select, command {Could not copy the command} other {Could not copy the details}}', description: "A notification: copying a run's command or its details from the Progress panel failed." }), { what }))
  )
}

/**
 * Everything Hive has for a run (`runDetails`): what ran (the command, copyable), who, when, how long, its steps, state,
 * exit code and the log the reporter named, which opens or shows in its folder (#251); the failure's summary; all of it
 * copyable at once (Copy details, to paste to the Assistant); and its agent, to show.
 */
function RunDetails({ run: r, now }: { run: ProgressRun; now: number }) {
  useDateStyle()
  const project = useStore((s) => (r.projectPath ? (findProject(s, r.projectPath)?.name ?? null) : null))
  const why = useStore((s) => whyNotShown(s, r))
  const rows = runDetails(r, project, now, tr)
  return (
    <div className="progress-details" role="region" aria-label={tr(msg({ id: 'board.progress.detailsOf', defaultMessage: 'Details of {run}', description: "Accessible name of a run's details in the Progress panel ({run}: the run's title)." }), { run: r.title })} onClick={(e) => e.stopPropagation()}>
      <dl>
        {rows.map((d) => (
          <div key={d.label} className="progress-detail-row">
            <dt>{d.label}</dt>
            <dd>{d.code ? <code>{d.text}</code> : d.text}</dd>
          </div>
        ))}
      </dl>
      {r.summary && <div className={cx('progress-summary', r.state !== 'failed' && 'plain')}>{r.summary}</div>}
      <div className="progress-detail-actions">
        {why === null ? (
          <button type="button" className="btn small" onClick={() => showRunAgent(r)} aria-label={showLabel(r)}>
            <Icon name="eye" /> {tr(SHOW_THE_AGENT)}
          </button>
        ) : (
          <span className="progress-detail-why">{why}</span>
        )}
        {r.command && (
          <button type="button" className="btn small subtle" onClick={() => copy('command', r.command!)}>
            <Icon name="copy" /> {tr(msg({ id: 'board.progress.copyCommand', defaultMessage: 'Copy command', description: "Button in a run's details (Progress panel): copies the command it ran." }))}
          </button>
        )}
        <button type="button" className="btn small subtle" onClick={() => copy('details', runDetailsText(r, project, now, tr))}>
          <Icon name="copy" /> {tr(msg({ id: 'board.progress.copyDetails', defaultMessage: 'Copy details', description: "Button in a run's details (Progress panel): copies all of them as text, to paste elsewhere." }))}
        </button>
        {r.logPath && (
          <>
            <button type="button" className="btn small subtle" onClick={() => void attempt(tr(msg({ id: 'board.progress.openLogFailed', defaultMessage: "Couldn't open the log", description: "An error's title: opening a run's log file (Progress panel) failed." })), () => call('progress:openLog', r.id))}>
              <Icon name="go-to-file" /> {tr(msg({ id: 'board.progress.openLog', defaultMessage: 'Open log', description: "Button in a run's details (Progress panel): opens the log file its reporter named." }))}
            </button>
            <button type="button" className="btn small subtle" onClick={() => void attempt(tr(msg({ id: 'board.progress.showLogFailed', defaultMessage: "Couldn't show the log", description: "An error's title: showing a run's log file in its folder (Progress panel) failed." })), () => call('progress:showLog', r.id))}>
              <Icon name="folder-opened" /> {tr(msg({ id: 'board.progress.showLog', defaultMessage: 'Show in folder', description: "Button in a run's details (Progress panel): shows its log file in File Explorer." }))}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** At most this many of the runs past the strip's bars are listed in its "+N" tooltip. */
const MORE_LISTED = 12

/**
 * The folded panel: a strip down the right edge, with a small bar per run (the newest few) while anything runs, and
 * "+N" for the rest, listed on hover and coloured for a failed or stale one among them. Its name counts every run.
 */
function ProgressRail({ runs, filtered }: { runs: ProgressRun[]; filtered: { name: string; all: number } | null }) {
  const kb = commandKeybinding('progress.toggle')
  const open = (): void => setProgressOpen(true)
  const { bars, more, moreState, counts } = stripRuns(runs)
  const summary = stripSummary(counts, tr, (items) => fmt.list(items, 'unit'))
  // Filtered (#251): it shows and counts that project's runs, and says how many there are in all.
  const what = filtered
    ? summary
      ? tr(msg({ id: 'board.progress.railFiltered', defaultMessage: '{name} only: {summary}; {all, number} in all', description: "The folded Progress strip's name when the panel is filtered: the project (or project · agent) shown ({name}), its runs in words ({summary}: 3 runs: 2 running, 1 failed), and how many runs there are in all ({all})." }), { name: filtered.name, summary, all: filtered.all })
      : tr(msg({ id: 'board.progress.railFilteredNone', defaultMessage: '{name} only: no runs; {all, number} in all', description: "The folded Progress strip's name when the panel is filtered and the project (or project · agent) shown ({name}) has no runs: how many runs there are in all ({all})." }), { name: filtered.name, all: filtered.all })
    : summary
  const show = tr(msg({ id: 'board.progress.show', defaultMessage: 'Show the Progress panel', description: "Tooltip and accessible name of the folded Progress strip at the window's edge: opens the panel. Its runs in words, or a shortcut, may follow in brackets." }))
  return (
    <div
      className={cx('progress-rail', filtered && 'filtered')}
      role="button"
      tabIndex={0}
      aria-label={what ? `${show} (${what})` : show}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <Tooltip content={withKey(show, kb)}>
        <span className="rail-btn">
          <Icon name="chevron-left" />
        </span>
      </Tooltip>
      {filtered && (
        <Tooltip content={tr(msg({ id: 'board.progress.railShowing', defaultMessage: 'Showing {name} only ({shown, number} of {all, number})', description: "Tooltip of the filter mark on the folded Progress strip: only one project's (or agent's) runs ({name}) show, {shown} of {all} runs." }), { name: filtered.name, shown: runs.length, all: filtered.all })}>
          <span className="progress-rail-filter">
            <Icon name="filter" />
          </span>
        </Tooltip>
      )}
      {bars.map((r) => {
        const f = fractionDone(r)
        const look = barLook(r)
        return (
          <Tooltip key={r.id} content={look === 'waiting' ? tr(msg({ id: 'board.progress.miniWaiting', defaultMessage: '{agent}: {run} (waiting)', description: "Tooltip of a run's small bar on the folded Progress strip: its agent, its title ({run}), and that it is waiting (for a test slot, say)." }), { agent: runAgentName(r, tr), run: r.title }) : f !== null ? `${runAgentName(r, tr)}: ${r.title} (${fmt.number(Math.round(f * 100) / 100, { style: 'percent' })})` : `${runAgentName(r, tr)}: ${r.title}`}>
            <span className={cx('progress-mini', r.state, look === 'moving' && 'indeterminate', look === 'waiting' && 'waiting')} data-run={r.id}>
              <span style={{ height: `${look === 'steps' ? Math.max(4, Math.round(f! * 100)) : look === 'moving' ? 40 : 100}%` }} />
            </span>
          </Tooltip>
        )
      })}
      {more.length > 0 && (
        <Tooltip
          content={
            <>
              <div>{tr(msg({ id: 'board.progress.moreRuns', defaultMessage: '{n, number} more:', description: "Heading of the folded Progress strip's +N tooltip: the runs without a bar of their own ({n} of them) are listed under it." }), { n: more.length })}</div>
              {more.slice(0, MORE_LISTED).map((r) => (
                <div key={r.id}>
                  {runAgentName(r, tr)}: {r.title} ({r.waiting && r.state === 'running' ? tr(WAITING) : runStateWord(r, tr)})
                </div>
              ))}
              {more.length > MORE_LISTED && <div className="faint">{tr(msg({ id: 'board.progress.moreOthers', defaultMessage: 'and {n, number} others: open the panel to see them', description: "The last line of the folded Progress strip's +N tooltip, after the runs it lists: how many more there are ({n})." }), { n: more.length - MORE_LISTED })}</div>}
            </>
          }
        >
          <span className={cx('progress-more', moreState)} data-more={more.length}>
            +{more.length}
          </span>
        </Tooltip>
      )}
      <span className="progress-rail-label">{tr(msg({ id: 'board.progress.railLabel', defaultMessage: 'Progress', description: "The folded Progress panel's label, written down the strip at the window's edge. Keep it short." }))}</span>
    </div>
  )
}
