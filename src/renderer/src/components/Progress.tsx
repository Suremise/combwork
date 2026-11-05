import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ALL_PROJECTS, PASSED_SHOWN_MS, SHOW_ALL, activeFilter, onPulse, agentChoices, ProgressSync, barLook, shortRevision, filterChoices, filterMergeSlots, filterRuns, fractionDone, inStrip, isOpenRun, runDetails, runAgentName, runDetailsText, runStateWord, runStatusLine, stripRuns, stripSummary, unseenTrouble } from '@shared/progress'
import { durationText } from '@shared/tasks'
import type { MergeSlotInfo, ProgressRun, ProgressTelling } from '@shared/types'
import type { QueueView } from '@shared/workflow/queue'
import { fmt, msg, tr, type Msg } from '@shared/i18n'
import { attempt, selectProject } from '../actions'
import { call } from '../api'
import { commandKeybinding } from '../commands'
import { SHOW_IN_ACTIVITY } from '../views/WorkspaceActivity'
import { activityAgentKey, cardLabelOf, findProject, flashPane, get, notify, openWorkspaceActivity, projectKey, projectNames, revealAgent, set, setAssistantOpen, setProgressFilter, setProgressOpen, useDateStyle, useLanguage, useProgressFilter, useProgressOpen, useStore } from '../store'
import { useNow } from '../usage'
import { useShallow } from 'zustand/react/shallow'
import { cx, formatKeybinding, timeAgo } from '../util'
import { AssistantMark } from './AssistantMark'
import { ProviderIcon } from './ProviderIcon'
import { PaneResizer, usePaneSize } from './Resizer'
import { useMergeSlots } from './MergeSlots'
import { DockEdge, LanesSection, PITCH_PX, lanePair } from './ProgressLanes'
import { MergeCards } from './ProgressMerge'
import { MergesList, QueueAnnouncer, QueueLines } from './ProgressQueue'
import { useLanes } from '../laneSource'
import { keepShown, useQueuesKept } from '../queueSource'
import { allProjectsQueues, justMerged, onPulseLine, queuedCount, shownQueues, shownReturns, unseenReturns } from '@shared/progressQueue'
import { cardLook, cardRunsSummary, groupLook, NO_RUNS_FILTER, PROGRESS_TABS, queueChecksLabel, runAgentKey, runDayLabel, runDays, runGroupLabel, runMatches, runsByCard, tabAt, tabBadges, unresolvedFailures, runTitleIn, type CardRuns, type ProgressTab, type RunDay, type RunGroup, type RunsFilter, type RunsLook } from '@shared/progressTabs'
import { formatDateTime, formatTime } from '@shared/dates'
import { RUNS_KEEP_PX } from '@shared/laneBar'
import type { Lane } from '../laneSource'
import { Icon, IconButton, SearchInput, Tooltip } from './ui'

/**
 * The Progress panel: long runs agents report (tests, builds), each with its agent, how far along and the time left.
 * On the right, beside the Assistant's panel; folded, a strip with a small bar per run. It never opens by itself.
 * Four tabs (#1309): Pulse (today's mix: a card per merge going on, ProgressMerge; the runs going on; a line when runs
 * failed and nothing passed since; then the lanes working through cards, ProgressLanes, #484, right after them),
 * Merges, Runs (what runs, then every run kept, by day, retries folded, filtered and searched) and Lanes (all of them).
 * A run opens its details; its agent's name shows that agent.
 */

const NO_RUNS: ProgressRun[] = []

const SHOW_THE_AGENT: Msg = msg({ id: 'board.progress.showTheAgent', defaultMessage: 'Show the agent', description: 'Button and tooltip on a Progress panel run: shows the agent that ran it.' })
const WAITING: Msg = msg({ id: 'board.progress.waiting', defaultMessage: 'waiting', description: "A run's state on its bar (accessible value) and in a list of runs (build (waiting)), lower case: it waits (for a test slot, say)." })

const IN_COPY: Msg = msg({ id: 'board.progress.inCopy', defaultMessage: 'in {copy}', description: "Under a run's agent in the Progress panel, after its card and revision (\"AM-12 · a3f2c1d · in copy-2\"): the run ran in that review or check copy (a folder Combwork keeps at exactly the card's revision). {copy} is its name, such as copy-2: keep it as it is." })

const OPEN_CARD: Msg = msg({ id: 'board.progress.openCard', defaultMessage: 'Open {card}', description: "Tooltip of a run's card in the Progress panel (under its agent): opens the card. {card} is the card's reference (#1061)." })

/** A tooltip with the command's shortcut after it, in brackets, when it has one. */
const withKey = (text: string, kb: string | undefined): string => (kb ? `${text} (${formatKeybinding(kb)})` : text)

type StoreState = Parameters<typeof findProject>[0]

/** Why a run's agent can't be shown, or null when it can: the Assistant, or a project agent that is still there. */
function whyNotShown(s: StoreState, r: ProgressRun): string | null {
  if (r.source === 'assistant') return s.workspace?.assistant ? null : tr(msg({ id: 'board.progress.noAssistant', defaultMessage: 'The Assistant is not in this workspace.', description: "Why a Progress panel run's agent can't be shown: the run is the Combwork Assistant's, and this workspace has none." }))
  if (r.source === 'api') return tr(msg({ id: 'board.progress.scriptRun', defaultMessage: 'A script reported it, not an agent: there is no agent to show.', description: "Why a Progress panel run's agent can't be shown: a script reported the run." }))
  // Hive's setup run in a review copy names the agent whose lease held it (HI-1710): shown as that agent's.
  if (r.source === 'combwork' && !r.agentId) return tr(msg({ id: 'board.progress.combworkRun', defaultMessage: 'Combwork’s merge queue ran it, not an agent: there is no agent to show.', description: "Why a Progress panel run's agent can't be shown: Combwork's merge queue ran the run itself (a merge check on a card's merged result; glossary 2.5: merge queue)." }))
  const p = r.projectPath ? findProject(s, r.projectPath) : null
  if (!p) return tr(msg({ id: 'board.progress.projectGone', defaultMessage: 'Its project is no longer in this workspace.', description: "Why a Progress panel run's agent can't be shown: its project was removed from the workspace." }))
  if (!r.agentId || !p.agents.some((a) => a.id === r.agentId)) return tr(msg({ id: 'board.progress.agentGone', defaultMessage: '{agent} has been removed from {project}.', description: "Why a Progress panel run's agent can't be shown: the agent ({agent}) was removed from its project ({project})." }), { agent: runAgentName(r, tr), project: p.name })
  return null
}

/** Opens Activity's workspace level on the agent that reported a run (HI-1664): what it runs now, the Assistant's too. */
function showRunActivity(r: ProgressRun): void {
  const s = get()
  if (whyNotShown(s, r)) return
  const path = r.source === 'assistant' ? s.workspace!.assistant!.path : findProject(s, r.projectPath!)!.path
  openWorkspaceActivity({ agents: [activityAgentKey(path, r.source === 'assistant' ? 'assistant' : r.agentId!)] })
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
    ? tr(msg({ id: 'board.progress.showAssistant', defaultMessage: 'Show the Assistant, which ran {run}', description: "Accessible name of the button showing the Combwork Assistant, which ran a Progress panel run ({run}: the run's title)." }), { run: r.title })
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
  const queues = useQueuesKept()
  const lanes = useLanes()
  const chosen = useProgressFilter()
  // Its path and its projects' names (HI-1806): the workspace's every change (an agent's state) would render the panel again.
  const wsPath = useStore((s) => s.workspace?.path ?? null)
  const names = useStore(useShallow((s) => projectNames(s.workspace?.projects)))
  // The projects being worked on (the sidebar's Working on), as one string so it changes only when they do.
  const activeKey = useStore((s) => (s.workspace?.projects ?? []).filter((p) => p.active).map((p) => p.path.toLowerCase()).join('\n'))
  const activePaths = useMemo(() => new Set(activeKey ? activeKey.split('\n') : []), [activeKey])
  const focused = useStore((s) => s.windowFocused)
  // The tab shown (#1309), kept per workspace; Pulse unless the user chose another.
  const tabKey = wsPath ? `progress-tab:${wsPath.toLowerCase()}` : null
  const tab = tabAt(useStore((s) => (tabKey ? s.panes[tabKey] : undefined)))
  const setTab = (next: ProgressTab): void => {
    if (!tabKey) return
    const i = PROGRESS_TABS.indexOf(next)
    set((s) => ({ panes: { ...s.panes, [tabKey]: i } }))
    void call('ui:setPane', tabKey, i ? i : null)
  }
  const [runsFilter, setRunsFilter] = useState<RunsFilter>(NO_RUNS_FILTER)
  // Another workspace: its own filters, from none.
  useEffect(() => setRunsFilter(NO_RUNS_FILTER), [wsPath])
  // The Runs tab asked for with a filter (#1446: what a lane waits for, from its row): shown, and the ask cleared.
  const runsShow = useStore((s) => s.runsShow)
  useEffect(() => {
    if (!runsShow) return
    setRunsFilter(runsShow)
    setTab('runs')
    set({ runsShow: null })
    // setTab is made each render; the ask alone decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsShow])
  const width = usePaneSize('progress', 280)
  // The run whose details are open.
  const [detail, setDetail] = useState<string | null>(null)
  // The same function every time, so a row whose run didn't change isn't drawn again (#1108).
  const toggle = useCallback((id: string): void => setDetail((d) => (d === id ? null : id)), [])
  const anyOpen = runs.some(isOpenRun)
  // Once a second while something runs or is about to fold into Recent (a passed run, a failure just seen), else now
  // and then.
  const folding = runs.some((r) => !r.dismissed && (r.state === 'passed' || r.state === 'stopped' || r.seenAt !== null || (r.finishedAt !== null && Date.now() - r.finishedAt < PASSED_SHOWN_MS)))
  // A queue testing (its time so far), a merge shown for a few seconds, a return seen and about to leave (#1356).
  const queueTicking = queues.some((v) => !!v.testing || justMerged(v, Date.now()).length > 0 || shownReturns(v, Date.now()).some((r) => !!r.seen))
  const now = useNow(anyOpen || folding || queueTicking ? 1000 : 30000)
  const unseen = runs.some(unseenTrouble)
  // Looking at the open panel counts as seeing what failed or went stale: the taskbar's and the strip's red clear,
  // and those runs fold into Recent a few seconds later.
  useEffect(() => {
    if (on && open && focused && unseen) void call('progress:seen')
  }, [on, open, focused, unseen, runs])
  // The merge queues that show (#1356 item 0: by their state), of the filtered project; their projects are choices too.
  const allQueues = shownQueues(queues, now)
  const queueProjects = allQueues.map((v) => v.projectPath)
  // All projects leaves out an inactive project's idle queue (HI-2165); the filter is then offered, even for one
  // project, so choosing it there shows its queue.
  const allProjects = allProjectsQueues(allQueues, activePaths, now)
  const someHidden = allProjects.length < allQueues.length
  const filter = activeFilter(runs, chosen, queueProjects, someHidden)
  // The filter (#251): one project's runs (and one agent's), or all; offered when the runs span more than one project.
  const nameOf = (p: string): string => names[p.toLowerCase()] ?? p.split(/[\\/]/).pop() ?? p
  const choices = filterChoices(runs, nameOf, tr, queueProjects)
  const filterOffered = choices.length > 1 || someHidden
  const shownQueue = filter.project === ALL_PROJECTS ? allProjects : allQueues.filter((v) => v.projectPath.toLowerCase() === filter.project)
  // Looking at the Merges tab counts as seeing the returns it shows (#1356; HR3's round 1 finding 1): the filtered
  // project's only, and not while a dialog covers the panel. Each leaves its queue's card a few seconds later.
  const covered = useStore((s) => s.dialog !== null || s.taskOpen !== null)
  const toSee = on && open && focused && !covered && tab === 'merges' ? shownQueue.flatMap((v) => unseenReturns(v, now).map((r) => ({ v, entry: r.entry, row: r }))) : []
  const seeKey = toSee.map((x) => x.entry).join('\n')
  useEffect(() => {
    const by = new Map<string, { v: QueueView; entries: string[] }>()
    for (const x of toSee) {
      const k = `${x.v.projectPath.toLowerCase()}\n${x.v.target}`
      by.set(k, { v: x.v, entries: [...(by.get(k)?.entries ?? []), x.entry] })
    }
    // Kept here for their own 10 s, whatever main's list says meanwhile (another window's marks), then marked in main.
    keepShown(toSee)
    for (const { v, entries } of by.values()) void call('queue:seen', v.projectPath, v.target, entries).catch(() => undefined)
    // seeKey names what toSee holds: the same returns aren't asked for again on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seeKey])
  if (!on) return null
  const announcer = <QueueAnnouncer views={queues} runs={runs} />
  const shown = filterRuns(runs, filter)
  const filterName = filter === SHOW_ALL ? null : `${choices.find((c) => c.value === filter.project)?.label ?? ''}${filter.agent ? ` · ${(shown[0] ? runAgentName(shown[0], tr) : '')}` : ''}`
  if (!open)
    return (
      <>
        {announcer}
        <ProgressRail runs={shown.filter((r) => inStrip(r, now))} filtered={filterName ? { name: filterName, all: runs.filter((r) => inStrip(r, now)).length } : null} />
      </>
    )
  // Pulse holds the runs in progress, and one just ended for a few seconds (#1309): finished runs live in Runs.
  const listed = shown.filter((r) => onPulse(r, now))
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
  const agents = filter.project !== ALL_PROJECTS ? agentChoices(runs, filter.project, tr) : []
  const kb = commandKeybinding('progress.toggle')
  const badges = tabBadges(merging, shown, shownLanes.length, queuedCount(shownQueue))
  const failures = unresolvedFailures(shown)
  const multi = Object.keys(names).length > 1
  const pulseQueues = shownQueue.filter(onPulseLine)

  return (
    <>
    {announcer}
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
        <span className="progress-title-text">{tr(msg({ id: 'board.progress.title', defaultMessage: 'Progress', description: "The Progress panel's title, in its header (long runs agents report: tests, builds)." }))}</span>
        <ProgressTabs tab={tab} badges={badges} onChange={setTab} />
        <div className="grow" />
        <IconButton icon="chevron-right" title={withKey(tr(msg({ id: 'board.progress.fold', defaultMessage: 'Fold the Progress panel', description: "Tooltip of the button folding the Progress panel to a strip at the window's edge. A shortcut may follow in brackets." })), kb)} onClick={() => setProgressOpen(false)} />
      </div>
      {filterOffered && (
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
      <div className={cx('progress-tab-body', `progress-tab-${tab}`)} role="tabpanel" id={`progress-tabpanel-${tab}`} aria-labelledby={`progress-tab-${tab}`}>
        {tab === 'pulse' && (
          <>
            <MergeCards slots={merging} projectName={nameOf} showProject={multi} stepOf={stepOf} now={now} />
            <QueueLines views={pulseQueues} showProject={multi} onOpen={() => setTab('merges')} />
            {(merging.length > 0 || pulseQueues.length > 0) && <div className="progress-divider" role="separator" />}
            {/* Needs attention (#1309): failures nothing has passed since, a line that shows them in Runs. Above the runs, out of their scrolling list, so however many there are it stays in sight (HI-1923). */}
            {failures.length > 0 && (
              <button
                type="button"
                className="progress-attention"
                onClick={() => {
                  setRunsFilter({ ...NO_RUNS_FILTER, failedOnly: true })
                  setTab('runs')
                }}
              >
                <Icon name="error" />
                <span>{tr(msg({ id: 'board.progress.attention', defaultMessage: '{n, plural, one {# run failed} other {# runs failed}}', description: "A line in the Progress panel's Pulse tab: runs failed and no later run of the same thing passed since; a click shows them in the Runs tab." }), { n: failures.length })}</span>
                <Icon name="arrow-right" />
              </button>
            )}
            <div className="progress-body">
              {listed.length === 0 && !merging.length && !pulseQueues.length && !failures.length && (
                <div className="pane-empty progress-empty">
                  {tr(msg({ id: 'board.progress.empty', defaultMessage: 'Nothing is running. When an agent runs tests or a build with progress reporting, it shows here with how far along it is and the time left.', description: 'The Progress panel when it has no runs.' }))}
                </div>
              )}
              {listed.map((r) => (
                <RunRow key={r.id} run={r} now={now} open={detail === r.id} onToggle={toggle} />
              ))}
            </div>
            <LanesSection lanes={shownLanes} all={lanes} width={width} runs={shown} />
          </>
        )}
        {tab === 'merges' &&
          (merging.length || shownQueue.length ? (
            <MergesList queues={shownQueue} slots={merging} runs={runs} now={now} projectName={nameOf} showProject={multi} stepOf={stepOf} agent={filter.agent ?? null} />
          ) : (
            <div className="pane-empty progress-empty">{tr(msg({ id: 'board.progress.noMerges', defaultMessage: "No merge is going on. While Combwork's merge queue merges a card, or an agent merges its branch, it shows here with its cards, its checks and what waits.", description: "The Progress panel's Merges tab when nothing is merging: no merge queue shows, and no agent holds the merge slot. Glossary 2.5: merge queue." }))}</div>
          ))}
        {tab === 'runs' && <RunsTab runs={shown} lanes={shownLanes} now={now} detail={detail} toggle={toggle} filter={runsFilter} setFilter={setRunsFilter} />}
        {tab === 'lanes' && <LanesSection lanes={shownLanes} all={lanes} width={width} runs={shown} full />}
      </div>
    </div>
    </>
  )
}

/**
 * The panel's tabs (#1309): a segmented control, a word and an icon each (the words go below about 360 px: a container
 * query on the panel), each with its badge: merges waiting, unresolved failures (red), lanes. A tablist: arrow keys,
 * Home and End move between them, choosing as they go.
 */
function ProgressTabs({ tab, badges, onChange }: { tab: ProgressTab; badges: Record<ProgressTab, number>; onChange: (t: ProgressTab) => void }) {
  const icon: Record<ProgressTab, string> = { pulse: 'pulse', merges: 'git-merge', runs: 'play', lanes: 'list-ordered' }
  const name = (t: ProgressTab): string => tr(msg({ id: 'board.progress.tab', defaultMessage: '{tab, select, pulse {Pulse} merges {Merges} runs {Runs} other {Lanes}}', description: 'A tab of the Progress panel: Pulse (an overview of what is going on now), Merges, Runs (tests, builds and checks agents ran) or Lanes (card loops). Keep "Runs" as the panel says it everywhere. Keep the select keys.' }), { tab: t }) // i18n-ignore: select keys, never shown
  const badge = (t: ProgressTab): string | null => {
    const n = badges[t]
    if (!n) return null
    if (t === 'merges') return tr(msg({ id: 'board.progress.badgeMerges', defaultMessage: '{n, plural, one {# merge waiting} other {# merges waiting}}', description: "What the badge on the Progress panel's Merges tab means: how many cards wait in the merge queues and agents wait for the merge slot." }), { n })
    if (t === 'runs') return tr(msg({ id: 'board.progress.badgeRuns', defaultMessage: '{n, plural, one {# failure nothing has passed since} other {# failures nothing has passed since}}', description: "What the red badge on the Progress panel's Runs tab means: runs that failed with no later run of the same thing passing." }), { n })
    return tr(msg({ id: 'board.progress.badgeLanes', defaultMessage: '{n, plural, one {# lane} other {# lanes}}', description: "What the badge on the Progress panel's Lanes tab means: how many lanes there are." }), { n })
  }
  const move = (e: React.KeyboardEvent, from: ProgressTab): void => {
    const i = PROGRESS_TABS.indexOf(from)
    const last = PROGRESS_TABS.length - 1
    const to = e.key === 'ArrowRight' ? (i + 1) % PROGRESS_TABS.length : e.key === 'ArrowLeft' ? (i + last) % PROGRESS_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (to < 0) return
    e.preventDefault()
    onChange(PROGRESS_TABS[to])
    requestAnimationFrame(() => document.getElementById(`progress-tab-${PROGRESS_TABS[to]}`)?.focus())
  }
  return (
    <div className="segmented progress-tabs" role="tablist" aria-label={tr(msg({ id: 'board.progress.tabs', defaultMessage: 'Progress panel views', description: "Accessible name of the Progress panel's tabs (Pulse, Merges, Runs, Lanes)." }))}>
      {PROGRESS_TABS.map((t) => {
        const b = badge(t)
        return (
          <Tooltip key={t} content={b ? `${name(t)}: ${b}` : name(t)}>
            <button type="button" role="tab" id={`progress-tab-${t}`} aria-controls={`progress-tabpanel-${t}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} aria-label={b ? `${name(t)}, ${b}` : name(t)} className={cx('progress-tab', tab === t && 'active')} data-tab={t} onClick={() => onChange(t)} onKeyDown={(e) => move(e, t)}>
              <Icon name={icon[t]} />
              <span className="progress-tab-label">{name(t)}</span>
              {badges[t] > 0 && <span className={cx('progress-tab-badge', t === 'runs' && 'failed')}>{fmt.number(badges[t])}</span>}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

const FIND_RUNS = msg({ id: 'board.runs.search', defaultMessage: 'Find runs', description: "Placeholder and accessible name of the search box in the Progress panel's Runs tab: finds runs by title, command, agent or card." })

/**
 * The Runs tab (#1309): its filters (failures only, a lane, an agent, words to find), what is running now, then every
 * run Hive keeps that ended, by day, each day by card (HI-1701), a run and its retries the same day folded into one line
 * that opens to each.
 */
function RunsTab({ runs, lanes, now, detail, toggle, filter, setFilter }: { runs: ProgressRun[]; lanes: Lane[]; now: number; detail: string | null; toggle: (id: string) => void; filter: RunsFilter; setFilter: (f: RunsFilter) => void }) {
  const cardName = (n: number): string => cardLabelOf(get(), n)
  const words = (r: ProgressRun): string => [runAgentName(r, tr), r.title, r.command ?? '', r.card ? cardName(r.card) : ''].join('\n')
  // The lane chosen, as it is now (its cards change between cards, #1270); one no longer shown leaves the filter.
  const lane = filter.lane ? lanes.find((l) => l.id === filter.lane) : undefined
  // Agents by their runs' names; Hive's own runs as "Hive (merge queue)" (#1356 item 5).
  const agents = [...new Map(runs.filter((r) => runAgentKey(r)).map((r) => [runAgentKey(r)!, runAgentName(r, tr)])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const goneLane = !!filter.lane && !lane
  const goneAgent = !!filter.agent && !agents.some(([id]) => id === filter.agent)
  useEffect(() => {
    if (goneLane || goneAgent) setFilter({ ...filter, ...(goneLane ? { lane: null } : {}), ...(goneAgent ? { agent: null } : {}) })
  }, [goneLane, goneAgent, filter, setFilter])
  const matched = runs.filter((r) => runMatches(r, filter, words, lane?.cards ?? null))
  const running = matched.filter(isOpenRun)
  const runningCards = new Set(running.flatMap((r) => (r.card ? [r.card] : [])))
  const days = runDays(
    matched.filter((r) => !isOpenRun(r)),
    now
  )
  const filtered = filter.failedOnly || !!lane || !!filter.agent || !!filter.query.trim()
  // The finished runs' details opened, several at once (HI-1925): only while Runs is on screen, and its workspace.
  const ws = useStore((s) => s.workspace?.path ?? null)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setOpened(new Set()), [ws])
  const flip = useCallback((id: string): void => setOpened((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id]))), [])
  return (
    <>
      <div className="progress-runs-filters">
        <SearchInput className="progress-runs-search" placeholder={tr(FIND_RUNS)} aria-label={tr(FIND_RUNS)} value={filter.query} onChange={(query) => setFilter({ ...filter, query })} />
        <div className="progress-runs-choices">
          <button type="button" className={cx('btn', 'small', 'subtle', 'progress-runs-failed', filter.failedOnly && 'active')} aria-pressed={filter.failedOnly} onClick={() => setFilter({ ...filter, failedOnly: !filter.failedOnly })}>
            <Icon name="error" /> {tr(msg({ id: 'board.runs.failedOnly', defaultMessage: 'Failed', description: "A toggle in the Progress panel's Runs tab: shows only the runs that failed." }))}
          </button>
          {lanes.length > 0 && (
            <select className="select" aria-label={tr(msg({ id: 'board.runs.lane', defaultMessage: 'Lane', description: "Accessible name of the Progress panel's Runs tab filter by lane: only the runs for a lane's cards." }))} value={lane?.id ?? ''} onChange={(e) => setFilter({ ...filter, lane: e.target.value || null })}>
              <option value="">{tr(msg({ id: 'board.runs.anyLane', defaultMessage: 'Any lane', description: "A choice of the Progress panel's Runs tab filter by lane: runs of any card." }))}</option>
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {lanePair(l)}
                  {l.name ? ` · ${l.name}` : ''}
                </option>
              ))}
            </select>
          )}
          {agents.length > 1 && (
            <select className="select" aria-label={tr(msg({ id: 'board.runs.agent', defaultMessage: 'Agent', description: "Accessible name of the Progress panel's Runs tab filter by agent: only the runs one agent ran." }))} value={filter.agent ?? ''} onChange={(e) => setFilter({ ...filter, agent: e.target.value || null })}>
              <option value="">{tr(msg({ id: 'board.runs.anyAgent', defaultMessage: 'Any agent', description: "A choice of the Progress panel's Runs tab filter by agent: runs of every agent." }))}</option>
              {agents.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          )}
          {filtered && (
            <button type="button" className="btn small subtle progress-runs-clear" onClick={() => setFilter(NO_RUNS_FILTER)}>
              {tr(msg({ id: 'board.runs.clear', defaultMessage: 'Clear', description: "A button in the Progress panel's Runs tab: clears its filters and search." }))}
            </button>
          )}
        </div>
      </div>
      {/* What runs or waits now, scrolling in the room the dock leaves (HI-1925). */}
      <div className="progress-body progress-runs-body">
        {!running.length && !days.length && !filtered && <div className="pane-empty progress-empty">{tr(msg({ id: 'board.runs.none', defaultMessage: 'No runs yet. When an agent runs tests or a build with progress reporting, every run shows here, kept by day.', description: "The Progress panel's Runs tab when Combwork has no runs." }))}</div>}
        {running.map((r) => (
          <RunRow key={r.id} run={r} now={now} open={detail === r.id} onToggle={toggle} />
        ))}
      </div>
      <RunsDock days={days} running={running.length > 0} filtered={filtered} runningCards={runningCards} now={now} opened={opened} flip={flip} />
    </>
  )
}

/** Where a workspace's finished runs' dock keeps its height (HI-1925), as the lanes' rows are kept. */
const dockKey = (ws: string): string => `progress-runs-today:${ws.toLowerCase()}`
/** The dock's height in lane rows (HI-1925, Darren: about 6–7 lanes, up to 10 as Pulse's): its default, its least and most. */
const DOCK_ROWS = 6.5
const DOCK_MIN_ROWS = 1
const DOCK_MAX_ROWS = 10

/**
 * Runs' finished runs, docked at the bottom behind the shared edge (HI-1925): Today first, then the older days, each run
 * a line by card, its details opened on a click (several at once); scrolling in its own height. Its height is in lane
 * rows, unsnapped, kept per workspace; on a short panel it shows what fits while the runs going on keep RUNS_KEEP_PX
 * (nothing going on: they give it all), and comes back to its height as the panel grows. Today always heads it: "No
 * runs today" when nothing ended today, "No runs match." when a filter matches only older ones, and "No finished runs"
 * alone when there are none.
 */
function RunsDock({ days, running, filtered, runningCards, now, opened, flip }: { days: RunDay[]; running: boolean; filtered: boolean; runningCards: ReadonlySet<number>; now: number; opened: ReadonlySet<string>; flip: (id: string) => void }) {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const key = ws ? dockKey(ws) : null
  const kept = useStore((s) => (key ? s.panes[key] : undefined))
  const dock = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = dock.current
    const list = el?.querySelector<HTMLElement>('.progress-runs-dock-list')
    const tab = el?.closest<HTMLElement>('.progress-tab-body')
    const top = tab?.querySelector<HTMLElement>('.progress-runs-body')
    if (!el || !list || !tab || !top) return
    // As the lanes' (#484, HI-1673): the list's height and what the runs above can give up, keeping RUNS_KEEP_PX while
    // something runs; less whatever of the dock runs past the panel's bottom.
    const measure = (): void => {
      const over = Math.max(0, el.getBoundingClientRect().bottom - tab.getBoundingClientRect().bottom)
      const style = getComputedStyle(top)
      const padding = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0')
      const r = list.getBoundingClientRect().height + top.getBoundingClientRect().height - padding - over - (running ? RUNS_KEEP_PX : 0)
      setRoom((was) => (was !== null && Math.abs(was - r) < 1 ? was : r))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(list)
    watch.observe(top)
    watch.observe(tab)
    return () => watch.disconnect()
  }, [running])
  const chosen = typeof kept === 'number' && Number.isFinite(kept) ? Math.max(DOCK_MIN_ROWS, Math.min(DOCK_MAX_ROWS, kept)) : DOCK_ROWS
  // What fits now, in rows: the most it can be, and its least (under a row on a panel shorter than that).
  const fits = room === null ? DOCK_MAX_ROWS : Math.max(0, room / PITCH_PX)
  const max = Math.min(DOCK_MAX_ROWS, fits)
  const min = Math.min(DOCK_MIN_ROWS, max)
  const shown = Math.max(min, Math.min(chosen, max))
  const today = days[0]?.day === 0 ? days[0] : null
  const older = today ? days.slice(1) : days
  const todayLabel = runDayLabel({ day: 0, at: now, groups: [] }, now, tr)
  const rows = (d: RunDay) =>
    runsByCard(d).map((c) => <CardGroup key={c.key} group={c} running={d.day === 0 && c.card !== null && runningCards.has(c.card)} now={now} opened={opened} flip={flip} />)
  return (
    <div className="progress-runs-dock" ref={dock} role="region" aria-label={tr(FINISHED_RUNS)}>
      {key && (
        <DockEdge
          paneKey={key}
          chosen={chosen}
          shown={shown}
          min={min}
          max={max}
          pitch={PITCH_PX}
          label={tr(msg({ id: 'board.runs.dockEdge', defaultMessage: 'Finished runs’ height', description: "Accessible name of the handle on the top edge of the Progress panel's Runs tab's finished runs (docked at the bottom): drag it to make them taller or shorter." }))}
          valueText={tr(msg({ id: 'board.runs.dockEdgeValue', defaultMessage: '{rows, plural, one {# lane row high} other {# lane rows high}}', description: "The value of the handle on the top edge of the Progress panel's Runs tab's finished runs, for screen readers: how tall they are, in the height of the Pulse tab's lane rows ({rows}, may be a fraction such as 6.5)." }), { rows: Math.round(shown * 10) / 10 })}
          tip={tr(msg({ id: 'board.runs.dockEdgeTip', defaultMessage: 'Drag to make the finished runs taller or shorter; double-click for {rows, plural, one {# lane row} other {# lane rows}}', description: "Tooltip of the handle on the top edge of the Progress panel's Runs tab's finished runs. {rows} is their default height in the Pulse tab's lane rows (6.5)." }), { rows: DOCK_ROWS })}
        />
      )}
      <div className="progress-runs-dock-list" style={{ height: shown * PITCH_PX }}>
        {!days.length && !filtered ? (
          <div className="faint progress-runs-none">{tr(msg({ id: 'board.runs.noFinished', defaultMessage: 'No finished runs', description: "The Progress panel's Runs tab's finished runs (docked at the bottom) when Combwork has none." }))}</div>
        ) : (
          <>
            <section className="progress-runs-day" data-day={0} aria-label={todayLabel}>
              <div className="progress-section">{todayLabel}</div>
              {today ? rows(today) : <div className="faint progress-runs-none">{filtered ? tr(NONE_MATCH) : tr(msg({ id: 'board.runs.noneToday', defaultMessage: 'No runs today', description: "Under Today in the Progress panel's Runs tab's finished runs: no run ended today (older days follow)." }))}</div>}
            </section>
            {older.map((d) => (
              <section key={d.day} className="progress-runs-day" data-day={d.day} aria-label={runDayLabel(d, now, tr)}>
                <div className="progress-section">{runDayLabel(d, now, tr)}</div>
                {rows(d)}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

const FINISHED_RUNS = msg({ id: 'board.runs.finished', defaultMessage: 'Finished runs', description: "Accessible name of the Progress panel's Runs tab's finished runs, docked at the bottom (Today, then older days)." })
const NONE_MATCH = msg({ id: 'board.runs.noneMatch', defaultMessage: 'No runs match.', description: "The Progress panel's Runs tab when no run matches its filters or search." })

/** A group's icon by how its runs went (HI-1701): a failure shows, a failure before a pass shows as a warning. */
const LOOK_ICON: Record<RunsLook, string> = { failed: 'error', retried: 'warning', passed: 'pass', stale: 'warning', stopped: 'circle-slash' }

/**
 * A card's runs on a day (HI-1701): a heading with its key (it opens the card), title, how many runs and how they went,
 * and when the last ended; under it a line per run, always (HI-1925: every run its own line, only its details folded).
 * Other holds the runs for no card.
 */
function CardGroup({ group: c, running, now, opened, flip }: { group: CardRuns; running: boolean; now: number; opened: ReadonlySet<string>; flip: (id: string) => void }) {
  const key = useStore((s) => (c.card ? cardLabelOf(s, c.card) : null))
  const title = useStore((s) => (c.card ? (s.tasks.find((t) => t.number === c.card)?.title ?? null) : null))
  const look = cardLook(c)
  const name = key ?? tr(msg({ id: 'board.runs.other', defaultMessage: 'Other', description: "The heading of a group in the Progress panel's Runs tab, where runs are grouped by card: the runs for no card (Combwork's own, the user's scripts) follow." }))
  const at = c.last.finishedAt ?? c.last.updatedAt
  return (
    <section className={cx('progress-card-runs', look, 'open')} data-card-runs={c.card ?? 'other'} aria-label={name}>
      <div className="progress-card-head">
        <Icon name={LOOK_ICON[look]} className="progress-card-icon" />
        {c.card ? (
          <button
            type="button"
            className="progress-card-key"
            title={tr(OPEN_CARD, { card: name })}
            onClick={(e) => {
              e.stopPropagation()
              set({ taskOpen: c.card! })
            }}
          >
            {name}
          </button>
        ) : (
          <span className="progress-card-key">{name}</span>
        )}
        <span className="progress-card-title" title={title ?? undefined}>
          {title}
        </span>
        <span className="faint progress-card-summary">{cardRunsSummary(c, running, tr)}</span>
        <span className="faint progress-card-when" title={formatDateTime(at)}>
          {timeAgo(new Date(at).toISOString())}
        </span>
      </div>
      <div className="progress-card-items">
        {c.items.map((g) => (g.runs.length === 1 && !g.queue ? <RecentRow key={g.key} run={g.last} cardKey={key} now={opened.has(g.last.id) ? now : 0} open={opened.has(g.last.id)} onToggle={flip} /> : <GroupRow key={g.key} group={g} cardKey={key} now={now} opened={opened} flip={flip} />))}
      </div>
    </section>
  )
}

/**
 * A run tried several times the same day (#1309), or the merge queue's checks of a card (HI-1701): one line, as a run's,
 * "B1 cardwork ×4 · 2 failed, then passed" or "Hive (merge queue) lint, typecheck"; opened, each run.
 */
function GroupRow({ group: g, cardKey, now, opened, flip }: { group: RunGroup; cardKey: string | null; now: number; opened: ReadonlySet<string>; flip: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const what = g.queue ? queueChecksLabel(g, (items) => fmt.list(items, 'unit'), tr, (r) => runTitleIn(r, cardKey)) : runGroupLabel(g, null, tr, runTitleIn(g.last, cardKey))
  const who = runAgentName(g.last, tr)
  const look = groupLook(g)
  const took = g.last.finishedAt !== null ? durationText(g.last.finishedAt - g.last.startedAt, tr) : ''
  return (
    <div className={cx('progress-run-group', look, open && 'open')} data-group={g.key}>
      {/* Its whole line in its title too: a narrow panel cuts it short. */}
      <button type="button" className={cx('progress-recent', 'progress-group-head', look)} aria-expanded={open} title={`${who} · ${what}`} /* i18n-ignore: its agent's name before its line, both the window's */ onClick={() => setOpen(!open)}>
        <span className="progress-recent-line">
          <Icon name={LOOK_ICON[look]} /> <span className="progress-recent-who">{who}</span>
          <span className="progress-recent-text">{what}</span>
          <span className="faint progress-recent-took">{took}</span>
          {/* When its latest try ended (HI-1925: each line says when). */}
          <span className="faint progress-recent-at">{formatTime(g.last.finishedAt ?? g.last.updatedAt)}</span>
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="progress-group-chevron" />
      </button>
      {open && (
        <div className="progress-group-runs">
          {[...g.runs].reverse().map((r) => (
            <RecentRow key={r.id} run={r} cardKey={cardKey} now={opened.has(r.id) ? now : 0} open={opened.has(r.id)} onToggle={flip} />
          ))}
        </div>
      )}
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
        {/* An isolated check (#1435): its processes are its copy's, so Hive can end them all. */}
        {r.copy && r.source === 'agent' && isOpenRun(r) && (
          <IconButton
            icon="debug-stop"
            title={tr(msg({ id: 'board.progress.stopIsolated', defaultMessage: 'Stop this check and everything it started', description: "Tooltip of the button stopping an isolated check (a check an agent runs in a copy of its own) in the Progress panel: Combwork ends its command and every process it started." }))}
            onClick={(e) => {
              e.stopPropagation()
              void call('progress:stop', r.id)
            }}
          />
        )}
        {(r.state === 'failed' || r.state === 'stale') && (
          <IconButton
            icon="close"
            title={tr(msg({ id: 'board.progress.dismiss', defaultMessage: 'Dismiss (it stays in the Runs tab)', description: "Tooltip of the button dismissing a failed or stale run in the Progress panel's Pulse tab. Runs is the panel's tab of every run (keep it as the panel names it)." }))}
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
      {r.state === 'failed' && r.card && r.counts?.blocks && <RunBlocks run={r} />}
      {open && <RunDetails run={r} now={now} />}
    </div>
  )
})

/**
 * A failed run that was its card's check required before Review (#1279): "Blocks review for HI-12", shown while the
 * failed run is (until it is seen, as failures are).
 */
function RunBlocks({ run: r }: { run: ProgressRun }) {
  const card = useStore((s) => cardLabelOf(s, r.card!))
  return <div className="progress-run-blocks">{tr(msg({ id: 'board.progress.blocksReview', defaultMessage: 'Blocks review for {card}', description: "Under a failed run in the Progress panel: the run was a check the card's rules require before it can go to Review, so the card can't until it passes. {card} is the card's name (its key, such as HI-12). Glossary: check, rule." }), { card })}</div>
}

/**
 * What a run ran for (#1220), under its agent: "#1061 · a3f2c1d". The card opens it; the revision copies the whole
 * commit id.
 */
function RunFor({ run: r }: { run: ProgressRun }) {
  const card = useStore((s) => (r.card ? cardLabelOf(s, r.card) : null))
  return (
    <div className="progress-run-for faint">
      {card && (
        <button
          type="button"
          className="progress-run-card"
          title={tr(OPEN_CARD, { card })}
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
      {/* A review or check copy's run (#1435, #1446): a check of that revision, in the copy, never the builder's slot. */}
      {r.copy && (
        <span className="progress-run-copy">
          {(card || r.revision) && <span aria-hidden="true"> · </span>}
          {tr(IN_COPY, { copy: r.copy })}
        </span>
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
      {r.source === 'assistant' ? <AssistantMark /> : r.source === 'combwork' ? <Icon name="git-merge" /> : r.provider ? <ProviderIcon provider={r.provider} /> : <Icon name="terminal" />}
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
const RecentRow = memo(function RecentRow({ run: r, cardKey, now, open, onToggle }: { run: ProgressRun; cardKey: string | null; now: number; open: boolean; onToggle: (id: string) => void }) {
  useLanguage()
  const card = useStore((s) => (r.card ? cardLabelOf(s, r.card) : null))
  const item = useRef<HTMLDivElement>(null)
  // Opened in the scrolling box of all of them, its details scroll into view.
  useEffect(() => {
    if (open) item.current?.querySelector('.progress-details')?.scrollIntoView({ block: 'nearest' })
  }, [open])
  const took = r.finishedAt !== null ? durationText(r.finishedAt - r.startedAt, tr) : ''
  const icon = r.state === 'passed' ? 'pass' : r.state === 'failed' ? 'error' : r.state === 'stopped' ? 'circle-slash' : 'warning'
  const values = { agent: runAgentName(r, tr), run: r.title, state: runStateWord(r, tr) }
  const hover = took
    ? tr(msg({ id: 'board.progress.recentHoverTook', defaultMessage: '{agent}: {run} {state} ({took})', description: "Tooltip of a run in the Progress panel's Runs tab: its agent, its title ({run}), its state in a few words ({state}: failed, stopped reporting…) and how long it took ({took}: 4 min)." }), { ...values, took })
    : tr(msg({ id: 'board.progress.recentHover', defaultMessage: '{agent}: {run} {state}', description: "Tooltip of a run in the Progress panel's Runs tab: its agent, its title ({run}) and its state in a few words ({state}: failed, stopped reporting…)." }), values)
  // What it ran for and where, in its hover (HI-1701: one line each, the details have the rest): "AM-12 · a3f2c1d · in copy-2", and its command.
  const ranFor = [card, r.revision ? shortRevision(r.revision) : null, r.copy ? tr(IN_COPY, { copy: r.copy }) : null].filter(Boolean).join(' · ') // i18n-ignore: a list of names and ids, each the window's
  const tip = [hover, ranFor, r.command, r.summary].filter(Boolean).join('\n')
  return (
    <div ref={item} className={cx('progress-recent-item', r.state, open && 'open')} data-run={r.id}>
      <div
        className={cx('progress-recent', r.state)}
        onClick={() => {
          if (!window.getSelection()?.toString()) onToggle(r.id)
        }}
      >
        <Tooltip block content={tip}>
          <Icon name={icon} /> <span className="progress-recent-who">{runAgentName(r, tr)}</span>
          <span className="progress-recent-text">{runTitleIn(r, cardKey)}</span>
          <span className="faint progress-recent-took">{took}</span>
          <span className="faint progress-recent-at">{formatTime(r.finishedAt ?? r.updatedAt)}</span>
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
  const rows = runDetails(r, project, now, tr, (n) => cardLabelOf(get(), n))
  return (
    <div className="progress-details" role="region" aria-label={tr(msg({ id: 'board.progress.detailsOf', defaultMessage: 'Details of {run}', description: "Accessible name of a run's details in the Progress panel ({run}: the run's title)." }), { run: r.title })} onClick={(e) => e.stopPropagation()}>
      <dl>
        {rows.map((d) => (
          <div key={d.label} className="progress-detail-row">
            <dt>{d.label}</dt>
            {/* A time relative, the date and time in full on hover, as the card's Work section shows them (#1309). */}
            <dd title={d.at !== undefined ? d.text : undefined}>{d.code ? <code>{d.text}</code> : d.at !== undefined ? timeAgo(new Date(d.at).toISOString()) : d.text}</dd>
          </div>
        ))}
      </dl>
      {r.summary && <div className={cx('progress-summary', r.state !== 'failed' && 'plain')}>{r.summary}</div>}
      <div className="progress-detail-actions">
        {why === null ? (
          <>
            <button type="button" className="btn small" onClick={() => showRunAgent(r)} aria-label={showLabel(r)}>
              <Icon name="eye" /> {tr(SHOW_THE_AGENT)}
            </button>
            <button type="button" className="btn small subtle" onClick={() => showRunActivity(r)}>
              <Icon name="type-hierarchy" /> {tr(SHOW_IN_ACTIVITY)}
            </button>
          </>
        ) : (
          <span className="progress-detail-why">{why}</span>
        )}
        {r.command && (
          <button type="button" className="btn small subtle" onClick={() => copy('command', r.command!)}>
            <Icon name="copy" /> {tr(msg({ id: 'board.progress.copyCommand', defaultMessage: 'Copy command', description: "Button in a run's details (Progress panel): copies the command it ran." }))}
          </button>
        )}
        <button type="button" className="btn small subtle" onClick={() => copy('details', runDetailsText(r, project, now, tr, (n) => cardLabelOf(get(), n)))}>
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
