import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { RUNS_KEEP_PX, laneCardTime, laneWaitTime, draggedLaneRows, droppedLaneOrder, fitSegments, frozenSegment, keyedLaneRows, laneCards, laneOldRulesNote, laneRowsNow, laneRunning, laneSummary, mergedLaneOrder, nudgedLaneOrder, pulseLanes, foldedMarks, laneWaitText, queuedChange, queuedChangeText, segmentMarks, segmentName, segmentsThatFit, laneSegmentWork, type FoldedMarks, type LaneSegment, type SegmentMarks } from '@shared/laneBar'
import { laneLegend, legendSources, segmentStage, type LegendGroup } from '@shared/laneStages'
import { revisionShort } from '@shared/platform/descriptors'
import type { WorkBadge } from '@shared/workflow/workView'
import type { LaneCard, LaneEdit, LaneInfo, LaneStatus, ProgressRun, ProjectStages, TaskCard } from '@shared/types'
import { addedPlace, droppedPlace, nudgedPlace, QueueFocus, queueRows, type BoardCard, type QueueRow } from '@shared/laneQueueEdit'
import { dayBounds, dayKey } from '@shared/laneDay'
import { NO_RUNS_FILTER, latestRunOf, slotRunsKey } from '@shared/progressTabs'
import { formatDateTime } from '@shared/dates'
import { useWorkBadges } from '../cardWork'
import { useProjectStages } from '../projectStages'
import { OVERRIDE_NAMES } from './CardWork'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, activityAgentKey, cardLabelOf, confirm, get, notify, openVersionControl, openWorkspaceActivity, set, useLanguage, useStore } from '../store'
import { SHOW_IN_ACTIVITY } from '../views/WorkspaceActivity'
import { openLaneStart } from './LaneStartDialog'
import { lanesOf, saveLaneOrder, useLaneOf, useLaneOrder, type Lane } from '../laneSource'
import { CARD_DRAG, editLaneInTurn, undoLaneEdit, type EditOutcome } from '../laneEdits'
import { useNow } from '../usage'
import { cx } from '../util'
import { useAdvancedValue } from '../advanced'
import { cardStalled } from './Board'
import { usePanelFold } from './ProgressMerge'
import { Icon, IconButton, SearchInput, Tooltip, useContextMenu } from './ui'
import { durationText } from '@shared/tasks'
import { LaneCostTip, useLaneCost } from './CardCost'
import { TeamPauseBand, TeamPauseButton } from './TeamPause'

/**
 * The bottom of the Progress panel (#484): the lanes (a builder and its reviewer working through cards in order), one
 * row each, pinned to the bottom and growing upward, running ones first; up to four show (Settings → Advanced, #367),
 * then the list scrolls (#569).
 * The section's top edge is a handle: drag it (or focus it and press Up and Down) for more or fewer, in whole lanes,
 * double-click for the default; the choice is kept per workspace, and a panel too short for it shows the whole lanes
 * that fit while the runs keep their room (measured as the panel changes: a resize, zoom, a merge card). A row is a header (the pair, the lane, the card being
 * worked, finished/total) and a segmented bar, one segment per card coloured and patterned by where it is. An ended or
 * abandoned lane shows its cards as it left them, muted and still (#512), never the board's now. Hover a segment for the
 * card and its round, and what a red underline (a failed review) or hatching (blocked, On Hold) means (#706); a click
 * opens the card. A running lane with a stalled card (#521: its reviewer watching but not
 * reviewing, its agent not watching) says so in its header. The section folds down to its header bar (remembered per
 * workspace, keeping the chosen height), and isn't there at all without lanes.
 * Running lanes can be put in the user's own order (#568): dragged (a line shows where it goes; held near the list's top
 * or bottom edge, it scrolls), or focused and moved with Alt+Up and Alt+Down (or from its context menu), said to screen
 * readers; kept per workspace. A lane started since goes on top, and a lane that finishes drops to the bottom, after
 * those that finished before it.
 */

const foldKey = (ws: string): string => `progress-lanes-fold:${ws.toLowerCase()}`
const rowsKey = (ws: string): string => `progress-lanes-rows:${ws.toLowerCase()}`

/** The room a bar has inside the panel: the panel's width less the row's margins and padding. */
const BAR_INSET_PX = 38
/** A lane's height with its margin, until one is measured. */
export const PITCH_PX = 61

/** A lane's state in a word, in its header: none while it runs. */
const stateWord = (state: Lane['state']): string | null =>
  state === 'active' ? null : tr(msg({ id: 'board.lanes.state', defaultMessage: '{state, select, paused {paused} ended {merged} other {abandoned}}', description: "A lane's state in its header in the Progress panel, lower case (a lane: a builder and its reviewer working through cards in turn): paused, merged (it ended: its cards were merged) or abandoned." }), { state })

/** A lane's builder and reviewer: "B1 / R1", "B1 / pool" (#1443), or the builder alone. */
export const lanePair = (l: Lane): string => (l.reviewer ? `${l.builder.name} / ${l.reviewer.name}` : l.pool ? tr(POOL_PAIR, { builder: l.builder.name }) : l.builder.name)
const POOL_PAIR = msg({ id: 'board.lanes.poolPair', defaultMessage: '{builder} / pool', description: "A lane's agents in its header in the Progress panel when its cards are reviewed by the project's reviewer pool (#1443): its builder's name ({builder}), then the pool, short (the header is narrow). Glossary: pool (of reviewers)." })

/** Waits for the user's answer (#1279): counted in the Lanes bar. */
const waitsForYou = (l: Lane): boolean => laneRunning(l.state) && (l.status?.reason === 'you' || l.status?.reason === 'roundLimit')

/** `lanes`: the lanes shown (the panel's filter applied); `all`: the workspace's, in the same order, to keep a move's order whole. */
/**
 * `runs`: the runs shown, for the dot on each lane's row (its current card's latest run, #1309). `full`: the Lanes tab's
 * (#1309): every lane at its full height, with no fold bar or edge (Pulse's lanes have them).
 */
export function LanesSection({ lanes: given, all, width, runs = [], full = false }: { lanes: Lane[]; all: Lane[]; width: number; runs?: ProgressRun[]; full?: boolean }) {
  useLanguage()
  const ws = useStore((s) => s.workspace?.path ?? null)
  // What each live card's facts say (#1225), once for every lane: read again whenever the board is.
  const badges = useWorkBadges()
  // Each project's stages and names (#1421): a segment says its card's stage, and the legend the stages of the lanes' projects.
  const stages = useProjectStages()
  // Today's ended lanes (HI-2898), at the top of the Lanes tab, and there only.
  const endedToday = useEndedToday(full)
  // Pulse leaves out a Solo project's lanes unless one runs (#1421); the Lanes tab shows every lane, today's ended ones
  // under Ended today.
  const lanes = full ? (endedToday.length ? given.filter((l) => !endedToday.some((e) => e.id === l.id)) : given) : pulseLanes(given, (p) => stages.get(p.toLowerCase())?.preset)
  // Off, an old rules mark still shows (it is a fact) and says the rules aren't enforced (#1421).
  const enforced = useAdvancedValue<boolean>('cw.workflow.enforce')
  const [foldedKept, toggle] = usePanelFold(ws ? foldKey(ws) : null)
  const folded = foldedKept && !full
  const key = ws ? rowsKey(ws) : null
  const kept = useStore((s) => (key ? s.panes[key] : undefined))
  // The lanes shown until the edge is dragged: Settings → Advanced's, or the workspace's own (#367).
  const fallback = useAdvancedValue<number>('cw.progress.lanesShown')
  const list = useRef<HTMLDivElement>(null)
  // Measured as the panel changes (a resize, zoom, a merge card, lanes coming and going): a lane's height with its
  // margin, so the list shows whole lanes, and the room the lanes could have: the list and the runs above share the
  // panel's height, less what the runs keep. That sum doesn't change as the lanes shown do, so it settles at once.
  const [pitch, setPitch] = useState(PITCH_PX)
  const [room, setRoom] = useState<number | null>(null)
  const open = lanes.length > 0 && !folded
  // Reordering (#568): the running lanes' ids as shown, the lane being dragged and where it would go (undefined: nowhere
  // that moves it), what the last move said to screen readers, and the lane to focus again once it has moved.
  const running = lanes.filter((l) => laneRunning(l.state)).map((l) => l.id)
  const custom = useLaneOrder().length > 0
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const [said, setSaid] = useState('')
  // The Lanes tab's lanes opened to their cards (HI-1926): held while the tab shows, its workspace's.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setExpanded(new Set()), [ws])
  const expand = (id: string): void => setExpanded((e) => (e.has(id) ? new Set([...e].filter((x) => x !== id)) : new Set([...e, id])))
  const refocus = useRef<string | null>(null)
  const menu = useContextMenu()
  useLayoutEffect(() => {
    const id = refocus.current
    if (!id) return
    refocus.current = null
    const row = list.current?.querySelector<HTMLElement>(`.progress-lane[data-lane="${CSS.escape(id)}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }, [lanes])
  const moved = (next: string[] | null, l: Lane, keyboard: boolean): void => {
    if (!next) return
    if (keyboard) refocus.current = l.id
    // Filtered to a project or an agent, the lanes not shown keep their places.
    saveLaneOrder(mergedLaneOrder(all.filter((x) => laneRunning(x.state)).map((x) => x.id), next))
    const at = next.indexOf(l.id) + 1
    const lane = l.name ? `${lanePair(l)} (${l.name})` : lanePair(l)
    setSaid(tr(msg({ id: 'board.lanes.moved', defaultMessage: '{lane} moved: {at} of {n, plural, one {# running lane} other {# running lanes}}', description: 'Said to screen readers after a lane is moved in the Progress panel: the lane (its builder / reviewer, and its name in brackets), and its place now ({at}) among the {n} running lanes.' }), { lane, at, n: next.length }))
  }
  const usual = (): void => {
    saveLaneOrder(null)
    setSaid(tr(msg({ id: 'board.lanes.usualOrderSaid', defaultMessage: 'Lanes back in the usual order', description: "Said to screen readers after the Progress panel's lanes go back to their usual order (Usual Order, in a lane's menu)." })))
  }
  const laneMenu = (e: React.MouseEvent, l: Lane): void => {
    const i = running.indexOf(l.id)
    menu.open(e, [
      { label: tr(msg({ id: 'board.lanes.moveUp', defaultMessage: 'Move Up', description: "A lane's context menu item in the Progress panel: moves it up among the running lanes." })), icon: 'arrow-up', keybinding: 'Alt+Up', disabled: i <= 0, onClick: () => moved(nudgedLaneOrder(running, l.id, -1), l, true) },
      { label: tr(msg({ id: 'board.lanes.moveDown', defaultMessage: 'Move Down', description: "A lane's context menu item in the Progress panel: moves it down among the running lanes." })), icon: 'arrow-down', keybinding: 'Alt+Down', disabled: i >= running.length - 1, onClick: () => moved(nudgedLaneOrder(running, l.id, 1), l, true) },
      { separator: true },
      // What its builder and reviewer run now (HI-1664): Activity's workspace level on them.
      { label: tr(SHOW_IN_ACTIVITY), icon: 'type-hierarchy', onClick: () => openWorkspaceActivity({ agents: [l.builder, ...(l.reviewer ? [l.reviewer] : [])].map((a) => activityAgentKey(l.project, a.agentId)) }) },
      { separator: true },
      { label: tr(msg({ id: 'board.lanes.usualOrder', defaultMessage: 'Usual Order', description: "A lane's context menu item in the Progress panel: puts the lanes back in their usual order, undoing the user's own." })), icon: 'list-ordered', detail: tr(msg({ id: 'board.lanes.usualOrderDetail', defaultMessage: 'Running lanes newest first, paused ones after them', description: 'Under Usual Order in a lane\'s context menu (Progress panel): what the usual order is.' })), disabled: !custom, onClick: usual },
      // Ending one needs no tool (#1280, SPEC §16.11.3): End Lane, and Abandon Lane after asking. Its new conversation
      // no more tried tried again first (HI-2034).
      { separator: true },
      ...(freshBlocked(l) ? [{ label: tr(RETRY_FRESH), icon: 'refresh', onClick: () => void retryFresh(l) }] : []),
      { label: tr(msg({ id: 'board.lanes.end', defaultMessage: 'End Lane', description: "A lane's context menu item in the Progress panel: ends the lane (its agents' card loop is over; the cards stay as they are). Glossary: lane." })), icon: 'flag', onClick: () => void endLane(l, false) },
      { label: tr(msg({ id: 'board.lanes.abandon', defaultMessage: 'Abandon Lane…', description: "A lane's context menu item in the Progress panel: gives the lane up unmerged, after asking. Glossary: lane." })), icon: 'close', danger: true, onClick: () => void endLane(l, true) },
      { separator: true },
      { label: tr(START_LANE), icon: 'add', onClick: () => openLaneStart(l.project) }
    ])
  }
  /**
   * Where the dragged lane would go with the pointer at (x, y), from the lane under it now: over a running lane, before
   * it (its top half) or the next running one (null after the last); over anything else, or where it would stay, nowhere.
   * Called on every dragover, and after each step of the list's scrolling, so the line follows what comes under the pointer.
   */
  const place = (x: number, y: number): void => {
    if (!dragging) return
    const row = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.progress-lane')
    const id = row && list.current?.contains(row) ? row.dataset.lane : undefined
    const i = id ? running.indexOf(id) : -1
    if (!row || !id || i < 0) return setDropBefore(undefined)
    const box = row.getBoundingClientRect()
    const before = y < box.top + box.height / 2 ? id : (running[i + 1] ?? null)
    setDropBefore(droppedLaneOrder(running, dragging, before) ? before : undefined)
  }
  const placeNow = useRef(place)
  placeNow.current = place
  // While a lane is dragged: near the list's top or bottom edge it scrolls, every frame, as the board's columns do (so
  // it keeps going with the pointer held still: dragover doesn't come at a steady rate, or at all without a move). Stops
  // when the drag ends, is dropped or cancelled, or the pointer leaves the list.
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const isDragging = !!dragging
  useEffect(() => {
    if (!isDragging) return
    const over = (e: DragEvent): void => {
      pointer.current = list.current?.contains(e.target as Node) ? { x: e.clientX, y: e.clientY } : null
    }
    const stop = (): void => {
      pointer.current = null
    }
    document.addEventListener('dragover', over, true)
    document.addEventListener('drop', stop, true)
    let frame = 0
    let last = performance.now()
    const step = (now: number): void => {
      const ms = now - last
      last = now
      const p = pointer.current
      const el = list.current
      if (p && el && el.scrollHeight > el.clientHeight) {
        const r = el.getBoundingClientRect()
        const top = el.scrollTop
        el.scrollTop = clampScroll(top, frameStep(edgeSpeed(p.y, r.top, r.bottom), ms), el.scrollHeight - el.clientHeight)
        if (el.scrollTop !== top) placeNow.current(p.x, p.y)
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('dragover', over, true)
      document.removeEventListener('drop', stop, true)
      pointer.current = null
    }
  }, [isDragging])
  const reorder = (l: Lane): LaneReorder | null => {
    if (!laneRunning(l.state)) return null
    const i = running.indexOf(l.id)
    return {
      movable: running.length > 1,
      dragging: dragging === l.id,
      dropBefore: !!dragging && dropBefore === l.id,
      dropAfter: !!dragging && dropBefore === null && i === running.length - 1,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(LANE_DRAG, l.id)
        e.dataTransfer.setData('text/plain', lanePair(l))
        // After the browser has taken its drag image.
        setTimeout(() => setDragging(l.id), 0)
      },
      onDragEnd: () => {
        setDragging(null)
        setDropBefore(undefined)
      },
      onDragOver: (e) => {
        if (!dragging) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        place(e.clientX, e.clientY)
      },
      onDrop: (e) => {
        e.preventDefault()
        const lane = lanes.find((x) => x.id === dragging)
        const next = dragging && dropBefore !== undefined ? droppedLaneOrder(running, dragging, dropBefore) : null
        setDragging(null)
        setDropBefore(undefined)
        if (lane) moved(next, lane, false)
      },
      onKeyDown: (e) => {
        // The lane's own row only (HI-2970): a key pressed inside its opened cards (a card's link or ×, Add Card…'s
        // search) is theirs, never a move of the lane.
        if (e.target !== e.currentTarget) return
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        e.stopPropagation()
        const next = nudgedLaneOrder(running, l.id, e.key === 'ArrowUp' ? -1 : 1)
        if (next) moved(next, l, true)
        else setSaid(tr(msg({ id: 'board.lanes.alreadyEnd', defaultMessage: '{where, select, first {{lane} is already the first running lane} other {{lane} is already the last running lane}}', description: 'Said to screen readers when a lane (its builder / reviewer: {lane}) is moved with Alt+Up or Alt+Down but is already first or last among the running lanes.' }), { lane: lanePair(l), where: e.key === 'ArrowUp' ? 'first' : 'last' }))
      },
      onContextMenu: (e) => laneMenu(e, l)
    }
  }
  // Over no running lane (a finished one, the list's padding): nowhere to drop, so no line.
  const overList = (e: React.DragEvent<HTMLDivElement>): void => {
    if (dragging && !e.isDefaultPrevented()) setDropBefore(undefined)
  }
  useLayoutEffect(() => {
    const el = list.current
    const tab = el?.closest<HTMLElement>('.progress-tab-body')
    const body = tab?.querySelector<HTMLElement>('.progress-body')
    const section = el?.closest<HTMLElement>('.progress-lanes')
    if (full || !open || !el || !body || !tab || !section) return
    const row = el.querySelector<HTMLElement>('.progress-lane')
    // The lanes sit at the bottom of the panel (#484, HI-1673): the room they could have is the list's height and what
    // the runs above can give up, keeping RUNS_KEEP_PX. That sum doesn't change as the lanes shown do, so it settles at
    // once; less whatever of the lanes runs past the panel's bottom (they don't shrink, #1620), which a short panel has
    // until the lanes shown come down to what fits.
    const measure = (): void => {
      if (row) {
        const h = row.getBoundingClientRect().height + parseFloat(getComputedStyle(row).marginBottom || '0')
        if (h > 0) setPitch((was) => (Math.abs(was - h) < 0.1 ? was : h))
      }
      const over = Math.max(0, section.getBoundingClientRect().bottom - tab.getBoundingClientRect().bottom)
      // The runs give up their height but for their padding, which no squeeze takes.
      const style = getComputedStyle(body)
      const padding = parseFloat(style.paddingTop || '0') + parseFloat(style.paddingBottom || '0')
      const r = el.clientHeight + body.getBoundingClientRect().height - padding - over - RUNS_KEEP_PX
      setRoom((was) => (was !== null && Math.abs(was - r) < 1 ? was : r))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    watch.observe(body)
    watch.observe(tab)
    if (row) watch.observe(row)
    return () => watch.disconnect()
  }, [open, lanes, width, full])
  // No lanes: the paused team's band still shows (HI-2095: Show Its Window brings forward a workspace with none, to End It there).
  if (!lanes.length && !endedToday.length)
    return full ? (
      <div className="pane-empty progress-empty">
        <TeamPauseBand />
        <p>{tr(msg({ id: 'board.lanes.none', defaultMessage: 'No lanes. When a builder and a reviewer work through cards in turn (a card loop), their lane shows here with each card.', description: "The Progress panel's Lanes tab when there are no lanes. Glossary: lane." }))}</p>
        <button type="button" className="btn small progress-lanes-start" onClick={() => openLaneStart(null)}>
          <Icon name="add" /> {tr(START_LANE)}
        </button>
      </div>
    ) : (
      <TeamPauseBand />
    )
  const { chosen, shown, min, max } = laneRowsNow(kept, lanes.length, room, pitch, fallback)
  // The legend (#1421): the stages the lanes shown have (old rules' too), by category, on the Lanes bar's hover and focus.
  const legend = laneLegend(legendSources(lanes, (p) => stages.get(p.toLowerCase()), badges), tr)
  const foldTip = folded ? tr(msg({ id: 'board.lanes.show', defaultMessage: 'Show the lanes', description: "Tooltip of the Progress panel's Lanes bar when the lanes are folded away." })) : tr(msg({ id: 'board.lanes.fold', defaultMessage: 'Fold the lanes', description: "Tooltip of the Progress panel's Lanes bar: folds the lanes down to the bar." }))
  const legendId = `lanes-legend-${full ? 'tab' : 'pulse'}`
  return (
    <div
      className={cx('progress-lanes', folded && 'folded', full && 'full')}
      role="region"
      aria-label={tr(LANES)}
      // Ctrl+Z in the Lanes tab (HI-2898): undoes the last change of a lane's cards made in this window.
      onKeyDown={
        full
          ? (e) => {
              if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || typing(e.target)) return
              e.preventDefault()
              void undoLaneEdit()
            }
          : undefined
      }
    >
      {!folded && !full && key && <LanesEdge rowsKey={key} chosen={chosen} shown={shown} min={min} max={max} count={lanes.length} pitch={pitch} fallback={fallback} />}
      {!full && (
        <Tooltip block focus className="lanes-legend-tip" content={<LaneLegend groups={legend} more={foldTip} />}>
          <button type="button" className="progress-lanes-bar" aria-expanded={!folded} aria-describedby={legendId} onClick={toggle}>
            <Icon name={folded ? 'chevron-up' : 'chevron-down'} />
            <span>{tr(LANES)}</span>
            <span className="progress-lanes-count">{lanes.length}</span>
            {lanes.some(waitsForYou) && <span className="progress-lanes-you">{tr(msg({ id: 'board.lanes.waitingForYou', defaultMessage: '{n, plural, one {# waiting for you} other {# waiting for you}}', description: "In the Progress panel's Lanes bar, after how many lanes there are: how many of them wait for the user's answer (an approval, a decision, a round limit). Glossary: lane." }), { n: lanes.filter(waitsForYou).length })}</span>}
          </button>
        </Tooltip>
      )}
      {full && (
        <div className="progress-lanes-actions">
          <Tooltip focus className="lanes-legend-tip" content={<LaneLegend groups={legend} />}>
            <button type="button" className="btn small subtle progress-lanes-legend" aria-describedby={legendId}>
              <Icon name="info" /> {tr(msg({ id: 'board.lanes.legendButton', defaultMessage: 'Legend', description: "A button in the Progress panel's Lanes tab: its hover and focus show what a lane's colours and patterns mean (the board's stages, by category)." }))}
            </button>
          </Tooltip>
          <button type="button" className="btn small subtle progress-lanes-start" onClick={() => openLaneStart(null)}>
            <Icon name="add" /> {tr(START_LANE)}
          </button>
          <TeamPauseButton className="btn small subtle progress-lanes-team" />
        </div>
      )}
      {/* The team paused (HI-2081): what still runs, or All parked with Install Now. */}
      {!folded && <TeamPauseBand />}
      {/* The legend for screen readers: the bar's (or the tab's Legend button's) description. */}
      <span id={legendId} className="visually-hidden">
        {legendText(legend)}
      </span>
      {full && <EndedToday lanes={endedToday} badges={badges} />}
      {!folded && (
        // Whole lanes, the next one's top at the bottom edge; all of them, with the list's padding, when they fit.
        <div className="progress-lanes-list" ref={list} style={!full && shown < lanes.length ? { maxHeight: shown * pitch } : undefined} onDragOver={overList}>
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} max={segmentsThatFit(width - BAR_INSET_PX)} reorder={reorder(l)} badges={badges} runs={runs} stages={stages.get(l.project.toLowerCase())} enforced={enforced} {...(full ? { expanded: expanded.has(l.id), onExpand: () => expand(l.id), all } : {})} />
          ))}
        </div>
      )}
      <div className="progress-lanes-said" role="status">
        {said}
      </div>
      {menu.element}
    </div>
  )
}

/**
 * The lanes' top edge (#569): the shared dock edge (DockEdge) in whole lanes, from what shows; its maximum the most that
 * fit (the runs above keep RUNS_KEEP_PX), not the choice kept.
 */
function LanesEdge({ rowsKey: key, chosen, shown, min, max, count, pitch, fallback }: { rowsKey: string; chosen: number; shown: number; min: number; max: number; count: number; pitch: number; fallback: number }) {
  return (
    <DockEdge
      paneKey={key}
      chosen={chosen}
      shown={shown}
      min={min}
      max={max}
      pitch={pitch}
      snap
      label={tr(msg({ id: 'board.lanes.edge', defaultMessage: 'Lanes shown', description: "Accessible name of the handle on the top edge of the Progress panel's lanes: drag it for more or fewer lanes." }))}
      valueText={tr(msg({ id: 'board.lanes.edgeValue', defaultMessage: '{shown} of {count, plural, one {# lane} other {# lanes}} shown', description: "The value of the handle on the top edge of the Progress panel's lanes, for screen readers: {shown} of the {count} lanes show." }), { shown, count })}
      tip={tr(msg({ id: 'board.lanes.edgeTip', defaultMessage: 'Drag to show more or fewer lanes; double-click for {lanes}', description: "Tooltip of the handle on the top edge of the Progress panel's lanes. {lanes} is the default number of lanes shown." }), { lanes: fallback })}
    />
  )
}

/**
 * The top edge of a section docked at the bottom of a Progress panel tab (#569; HI-1925: Pulse's lanes and Runs'
 * finished runs share it): a window splitter (WAI-ARIA) whose value is the height shown now, in lane rows (`pitch` px
 * each), and whose maximum is the most that fits, not the choice kept. `snap`: whole rows (the lanes); else it follows
 * the pointer (Runs' dock: they aren't lanes). A double-click goes back to the default; focused, Up and Down change it
 * by a row, Home and End to the least and the most that fit. A drag or key sets the choice, kept per workspace under
 * `paneKey`, to what it shows, also where a short panel had shown less than chosen.
 */
export function DockEdge({ paneKey: key, chosen, shown, min, max, pitch, snap = false, label, valueText, tip }: { paneKey: string; chosen: number; shown: number; min: number; max: number; pitch: number; snap?: boolean; label: string; valueText: string; tip: string }) {
  const [dragging, setDragging] = useState(false)
  const put = (rows: number | null): void => {
    set((s) => {
      const panes = { ...s.panes }
      if (rows === null) delete panes[key]
      else panes[key] = rows
      return { panes }
    })
  }
  const save = (): void => void call('ui:setPane', key, get().panes[key] ?? null)
  // Unsnapped, to a hundredth of a row: the same height for the same place, and nothing kept finer than a pixel.
  const rowsAt = (dyPx: number): number => (snap ? draggedLaneRows(shown, dyPx, pitch, max, min) : Math.max(min, Math.min(max, Math.round((shown - dyPx / pitch) * 100) / 100)))
  const start = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startY = e.clientY
    let last = chosen
    setDragging(true)
    document.body.classList.add('pane-resizing-v')
    const move = (ev: PointerEvent): void => {
      const rows = rowsAt(ev.clientY - startY)
      if (rows === last) return
      last = rows
      put(rows)
    }
    const up = (): void => {
      setDragging(false)
      document.body.classList.remove('pane-resizing-v')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const reset = (): void => {
    put(null)
    save()
  }
  // Said as shown: to a tenth of a row.
  const round = (n: number): number => Math.round(n * 10) / 10
  return (
    <div
      className={cx('progress-lanes-edge', dragging && 'dragging')}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuemin={round(min)}
      aria-valuemax={round(max)}
      aria-valuenow={round(shown)}
      aria-valuetext={valueText}
      tabIndex={0}
      title={tip}
      onPointerDown={start}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const rows = keyedLaneRows(shown, e.key, max, min)
        if (rows === null) return
        e.preventDefault()
        // Against the choice kept: on a short panel showing less than chosen, End keeps what fits.
        if (rows === chosen) return
        put(rows)
        save()
      }}
    />
  )
}

const LANE_DRAG = 'application/x-combwork-lane'

const START_LANE = msg({ id: 'board.lanes.start', defaultMessage: 'Start Lane…', description: "A button in the Progress panel's Lanes tab and an item of a lane's menu: opens Start Lane (a builder and a reviewer agent work through cards in turn). Glossary: lane." })

const RETRY_FRESH = msg({ id: 'board.lanes.retryFresh', defaultMessage: 'Retry New Conversation', description: "A button in a lane's header (Progress panel) and an item of its menu (HI-2034): one of the lane's agents was owed a new conversation, and Combwork stopped trying to start it (it wasn't free in time, Combwork closed while starting it, or its start failed); this tries again, once the agent is free. Glossary: lane, conversation." })

const RETRY_FRESH_SHORT = msg({ id: 'board.lanes.retryFreshShort', defaultMessage: 'Retry {agent}', description: "A lane's header in the Progress panel (HI-2034), after a refresh icon: a button that tries again to start the lane's agent {agent} (an agent's name) in a new conversation, which Combwork stopped trying. Short: the panel is narrow; its tooltip says why in full." })

/** Whether a lane's agent is owed its new conversation and no more is tried (HI-2034): the row offers Retry. */
const freshBlocked = (l: Lane): boolean => l.status?.reason === 'startWait' && l.status.why === 'fresh' && !!l.status.freshBlocked && !l.frozen

/** Retries a lane's new conversations no more tried (HI-2034); a failure says why. */
async function retryFresh(l: Lane): Promise<void> {
  try {
    await call('lanes:retryFresh', l.id)
  } catch (e) {
    notify('error', tr(msg({ id: 'board.lanes.retryFreshFailed', defaultMessage: "Couldn't retry {lane}'s new conversation", description: "A toast's title (HI-2034): Retry New Conversation on a lane's row failed ({lane}: its builder / reviewer). The reason follows." }), { lane: lanePair(l) }), errorMessage(e))
  }
}

/** Ends a lane from its row (#1280): at once, or abandoned after asking; a failure says why. */
async function endLane(l: Lane, abandoned: boolean): Promise<void> {
  const pair = lanePair(l)
  const lane = l.name ? `${pair} (${l.name})` : pair
  if (abandoned) {
    await confirm({
      title: tr(msg({ id: 'board.lanes.abandonTitle', defaultMessage: 'Abandon {lane}?', description: "Title of the question before abandoning a lane from the Progress panel: the lane's builder / reviewer and its name ({lane}). Glossary: lane." }), { lane }),
      message: tr(msg({ id: 'board.lanes.abandonMessage', defaultMessage: 'The lane stops here, unmerged: its cards stay where they are, and its agents are told no more. Start a new lane to carry on.', description: 'The question before abandoning a lane (Progress panel): what abandoning does. Glossary: lane.' })),
      confirmLabel: tr(msg({ id: 'board.lanes.abandonConfirm', defaultMessage: 'Abandon Lane', description: 'The confirm button of the question before abandoning a lane (Progress panel).' })),
      danger: true,
      run: () => call('lanes:end', l.id, true)
    })
    return
  }
  try {
    await call('lanes:end', l.id, false)
  } catch (e) {
    notify('error', tr(msg({ id: 'board.lanes.endFailed', defaultMessage: "Couldn't end {lane}", description: "A toast's title: ending a lane from the Progress panel failed ({lane}: its builder / reviewer and name). The reason follows." }), { lane }), errorMessage(e))
  }
}

const LANES = msg({ id: 'board.lanes.title', defaultMessage: 'Lanes', description: "The Progress panel's section of lanes (a builder and its reviewer working through cards in turn): its bar's label and accessible name." })

const LEGEND = {
  title: msg({ id: 'board.lanes.legendTitle', defaultMessage: 'Each colour is a category, with the stages in it', description: "The heading of the lanes' legend (Progress panel, on the Lanes bar's hover): what each colour and pattern of a lane's card segments means, by the board's categories and the stages in them. Glossary: stage, category." }),
  hold: msg({ id: 'board.lanes.legendHold', defaultMessage: '{category} or blocked', description: "A line of the lanes' legend (Progress panel): the red hatching is a card On Hold ({category}: that category's name) or blocked." }),
  line: msg({ id: 'board.lanes.legendLine', defaultMessage: '{category}: {stages}', description: "A line of the lanes' legend for screen readers (Progress panel): a category ({category}: its name, such as Approved) and the stages in it ({stages}: their names, a list, such as \"Approved and Merging\"). Glossary: stage, category." })
}

const LANE_TARGET = msg({ id: 'board.lanes.target', defaultMessage: 'into {branch}', description: 'HI-2556: a lane’s mark in its header (Progress panel), lower case: its cards merge into {branch} (a branch name), not the project’s Work merges into.' })
const LANE_TARGET_TIP = msg({ id: 'board.lanes.targetTip', defaultMessage: 'This lane’s cards are made from {branch} and merge into it, not the project’s Work merges into, until the lane ends.', description: 'HI-2556: tooltip and accessible name of a lane header’s Merges into mark (Progress panel). {branch} is a branch name.' })
const LANE_WAITING = msg({ id: 'board.lanes.waiting', defaultMessage: 'waiting', description: "HI-2915: a lane's mark in its header (Progress panel), lower case: one of its cards in Active is marked as waiting on purpose (for the Assistant's answer, a quiet window), so Combwork doesn't report it as stalled; its tooltip says what for." })
const LANE_WAITING_TIP = msg({ id: 'board.lanes.waitingTip', defaultMessage: '{assistant, select, yes {{card} waits for the Assistant’s answer to its request: {reason}} other {{card} waits: {reason}}}', description: "HI-2915: tooltip and accessible name of a lane header's waiting mark (Progress panel). {card} is the card's key (HI-12); assistant is yes when its agent asked the Combwork Assistant and waits for its answer; {reason} is why, in the agent's or the user's own words (for the Assistant, the request). Keep the select keys." })
const OLD_RULES = msg({ id: 'board.lanes.oldRules', defaultMessage: 'old rules', description: "A lane's mark in its header (Progress panel), lower case: the project's workflow options changed while the lane ran, and it keeps the ones it started with until it ends; its tooltip says so. Glossary: workflow options." })

const PROJECT_LINK = msg({ id: 'board.lanes.projectLink', defaultMessage: '{project}: open its workflow in Version Control', description: "Accessible name and tooltip of the project's name in a lane's header (Progress panel): opens that project's Version Control tab (a tab's name) at its Workflow section. {project} is the project's name." })

const legendName = (g: LegendGroup): string => (g.category === 'hold' ? tr(LEGEND.hold, { category: g.name }) : g.name)

/** The legend as one text, for screen readers (the Lanes bar's description). */
const legendText = (groups: LegendGroup[]): string => [tr(LEGEND.title), ...groups.map((g) => (g.stages.length ? tr(LEGEND.line, { category: legendName(g), stages: fmt.list(g.stages) }) : legendName(g)))].join('. ')

/**
 * The lanes' legend (#1421): each category's swatch (its segment's colour and pattern), its name and the stages in it of
 * the projects shown, by name; `more`: a last line (what clicking the bar does).
 */
function LaneLegend({ groups, more }: { groups: LegendGroup[]; more?: string }) {
  return (
    <div className="lanes-legend" data-legend="">
      <div className="lanes-legend-title">{tr(LEGEND.title)}</div>
      {groups.map((g) => (
        <div key={g.category} className="lanes-legend-row" data-category={g.category}>
          <span className={cx('lane-seg', 'lanes-legend-swatch', g.state)} aria-hidden="true" />
          <span className="lanes-legend-name">{legendName(g)}</span>
          {g.stages.length > 0 && (
            <span className="lanes-legend-stages faint">
              {g.stages.map((s, i) => (
                <span key={s} className="lanes-legend-stage">
                  {i > 0 && <span className="lane-stage-divider" aria-hidden="true" />}
                  {s}
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
      {more && <div className="lanes-legend-more faint">{more}</div>}
    </div>
  )
}

/** What a running lane's row needs to be moved (#568); a finished lane has none. */
interface LaneReorder {
  /** There is another running lane to move it past. */
  movable: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void
}

const SLOT_LINK = msg({ id: 'board.lanes.slotLink', defaultMessage: 'Show {slot} in Branches & remotes', description: "Tooltip and accessible name of a lane's slot in its header (Progress panel, #1446): opens the project's Version Control tab at Branches & remotes, where its slots are listed. {slot} is the slot's name (slot-b): keep it as it is. Branches & remotes is a section of the tab: use its name as shown there." })
const WAITS_LINK = msg({ id: 'board.lanes.waitsLink', defaultMessage: 'Click to show it.', description: "Tooltip of why a lane waits, in its header (Progress panel, #1446), when a click shows what it waits for: its slot or the slots in use (Branches & remotes), or the runs it waits on (the Runs tab). It follows the reason, on a line of its own (\"waiting for a slot\")." })

/** Whether a lane's wait has something to show (#1446): the slots it waits for, or the runs preparing its slot or a copy. */
const waitsOn = (s: LaneStatus | null): boolean => !!s && (s.reason === 'slot' || s.reason === 'preparing' || s.reason === 'checkCopy')

/** Shows what a lane waits for (#1446): the project's slots (Branches & remotes), its slot's warming runs, or its own runs. */
function showWaitedOn(l: Lane, projectPath: string): void {
  if (l.status?.reason === 'slot') return openVersionControl(projectPath, 'branches')
  if (l.status?.reason === 'preparing' && l.status.slot) return set({ runsShow: { ...NO_RUNS_FILTER, agent: slotRunsKey(l.status.slot) } })
  set({ runsShow: { ...NO_RUNS_FILTER, lane: l.id } })
}

/**
 * A lane's slot in its hover (#1446): its name, ready or being prepared, since when it was lent (or, a carried slot,
 * kept by its builder), and the current card's line there.
 */
function LaneSlotTip({ lane: l }: { lane: Lane }) {
  if (!l.slot || l.frozen) return null
  const s = l.slot
  return (
    <div className="lane-slot-tip" data-testid="lane-slot">
      <div>
        <strong>{s.name}</strong>{' '}
        {tr(msg({ id: 'board.lanes.slotTip', defaultMessage: '{state, select, preparing {being prepared} other {ready}} · {carried, select, yes {its builder’s own since {since}} other {lent to the lane since {since}}}', description: "A lane's slot in its hover (Progress panel, #1446), after the slot's name (slot-b): whether it is ready or being prepared (its setup or a dependency install), then since when it was lent to the lane, or, for a builder's own worktree kept from before 1.0 (carried), since when it has had it. {since} is a date and time. Keep the select keys." }), { state: s.state, carried: s.carried ? 'yes' : 'no', since: formatDateTime(s.since) })}
      </div>
      {s.line && <div className="faint">{tr(msg({ id: 'board.lanes.slotLine', defaultMessage: 'On {line}', description: "A lane's slot in its hover (Progress panel, #1446): the branch its current card is built on there follows ({line}, such as cw/HI/HI-12-fix-login: keep it as it is)." }), { line: s.line })}</div>}
    </div>
  )
}

/** A pool lane's reviewers in its hover (#1446): who gave its current card's last verdict, and who reviews it now. */
function LanePoolTip({ lane: l }: { lane: Lane }) {
  if (!l.pool || l.frozen || !l.poolReview) return null
  const p = l.poolReview
  return (
    <div className="lane-pool-tip" data-testid="lane-pool">
      <div>{tr(msg({ id: 'board.lanes.poolReviewing', defaultMessage: '{reviewing, select, none {Reviewed by the pool: nobody on the card yet} other {Reviewed by the pool: {name} now}}', description: "A lane's hover in the Progress panel when its cards are reviewed by the project's reviewer pool (#1446): who reviews its current card now ({name}, an agent's name), or nobody yet (it waits for a free reviewer). Keep the select keys." }), { reviewing: p.reviewing ? 'some' : 'none', name: p.reviewing ?? '' })}</div>
      {p.lastVerdict && <div className="faint">{tr(msg({ id: 'board.lanes.poolLastVerdict', defaultMessage: 'Last verdict: {name}, {pass, select, yes {passed} other {failed}}', description: "A pool lane's hover in the Progress panel (#1446): who gave the current card's last verdict ({name}, an agent's name) and whether it passed or failed. Keep the select keys. Glossary: verdict, pass / fail." }), { name: p.lastVerdict.name, pass: p.lastVerdict.pass ? 'yes' : 'no' })}</div>}
    </div>
  )
}

/**
 * `stages`: its project's stages and names (#1421), so its segments say their cards' stages; `enforced`: whether workflow
 * rules are enforced now, for what its old rules marks say.
 */
function LaneRow({ lane: l, max, reorder: r, badges, runs, stages, enforced, expanded, onExpand, all }: { lane: Lane; max: number; reorder: LaneReorder | null; badges: Map<number, WorkBadge>; runs: ProgressRun[]; stages: ProjectStages | undefined; enforced: boolean; expanded?: boolean; onExpand?: () => void; all?: Lane[] }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // Read again each minute: a card waiting in Review becomes stalled with time (#521).
  useNow(60_000)
  const laneOf = useLaneOf()
  const cards = l.frozen ? l.frozen.map((c) => frozenSegment(c, tr, cardLabelOf({ tasks }, c.number))) : laneCards(l.cards, tasks, tr, (c) => segmentStage(c, badges.get(c.number), stages, tr, l.stages))
  // Its project, named in its header: a link to its Version Control tab's Workflow section (#1421).
  const project = projects.find((p) => p.path.toLowerCase() === l.project.toLowerCase())
  const oldRules = l.oldRules ? laneOldRulesNote(enforced, tr) : null
  let stalled: { n: number; why: string } | null = null
  for (const n of l.frozen ? [] : l.cards) {
    const c = tasks.find((t) => t.number === n)
    const why = c ? cardStalled(projects, c, laneOf(c)) : null
    if (why) {
      stalled = { n, why }
      break
    }
  }
  // HI-2915: a card of its waiting on purpose (HI-2618), said in its header with what for, while none is stalled.
  const waitingCard = stalled || l.frozen ? undefined : l.cards.map((n) => tasks.find((t) => t.number === n)).find((c) => c?.column === 'doing' && c.waitingFor)
  const waitingTip = waitingCard?.waitingFor ? tr(LANE_WAITING_TIP, { card: cardLabelOf({ tasks }, waitingCard.number), assistant: waitingCard.waitingFor.ask ? 'yes' : 'no', reason: waitingCard.waitingFor.reason }) : null
  const { finished, total, current } = laneSummary(cards)
  // A lane that ended without a record of its cards doesn't know how many were finished (#512).
  const unknown = cards.some((c) => c.state === 'unrecorded')
  const segments = fitSegments(cards, max, tr, fmt.list)
  const pair = lanePair(l)
  // Why it waits (#1279, from #1270's status): said in its header instead of just "paused", and in its accessible name.
  const why = l.status && !l.frozen ? laneWaitText(l.status, (n) => cardLabelOf({ tasks }, n), tr, (items) => fmt.list(items)) : null
  // Its queued list change (HI-2151), under its cards in the Lanes tab (`all`: every lane, to say where a card moves).
  const change = all ? queuedChange(l, all) : null
  const queued = change ? queuedChangeText(change, (n) => cardLabelOf({ tasks }, n), tr, fmt.list) : null
  const word = stateWord(l.state)
  // How long it has waited (HI-1926: since main saw the wait begin), marked past its bound (Settings → Advanced).
  const youMin = useAdvancedValue<number>('cw.lanes.waitYouMinutes')
  const reviewerMin = useAdvancedValue<number>('cw.lanes.waitReviewerMinutes')
  const wait = why ? laneWaitTime(l.status, Date.now(), youMin, reviewerMin) : null
  const waited = wait ? (l.status?.atLeast ? tr(WAITED_AT_LEAST, { time: durationText(wait.ms, tr) }) : durationText(wait.ms, tr)) : null
  // Its cost on the hover of its top line (#602), read when the hover first shows.
  const cost = useLaneCost(l.id)
  // A card's revisions as its project's platform shows them (its descriptor, never a switch on its id).
  const shortFor = (n: number) => {
    const owner = tasks.find((t) => t.number === n)?.project
    const platform = projects.find((p) => p.name === owner)?.platform?.id
    return (id: string): string => (platform ? revisionShort(platform, id) : id.slice(0, 7))
  }
  // Its queue edited in the Lanes tab (HI-2898): a running lane's, with a refusal shown under it.
  const { editing, refusal, dismiss } = useQueueEditing(l, all)
  // A card dragged from the board onto its row: added last (into its open queue, where it's dropped).
  const [cardOver, setCardOver] = useState(false)
  const cardDrop = editing
    ? {
        onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
          if (!e.dataTransfer.types.includes(CARD_DRAG)) return r?.onDragOver(e)
          if (e.isDefaultPrevented()) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setCardOver(true)
        },
        onDragLeave: (e: React.DragEvent<HTMLDivElement>) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setCardOver(false),
        onDrop: (e: React.DragEvent<HTMLDivElement>) => {
          if (!e.dataTransfer.types.includes(CARD_DRAG)) return r?.onDrop(e)
          e.preventDefault()
          setCardOver(false)
          const n = Number(e.dataTransfer.getData(CARD_DRAG))
          if (Number.isInteger(n) && n > 0) editing.add(n)
        }
      }
    : {}
  return (
    <div
      className={cx('progress-lane', l.state, r?.movable && 'movable', r?.dragging && 'dragging', r?.dropBefore && 'drop-before', r?.dropAfter && 'drop-after', cardOver && 'card-over')}
      data-lane={l.id}
      // A running lane is focusable, to move it with Alt+Up and Alt+Down (#568).
      {...(r
        ? {
            role: 'group',
            'aria-label': [`${pair}${l.name ? `, ${l.name}` : ''}`, project?.name, word, why, oldRules && tr(OLD_RULES), l.target && tr(LANE_TARGET, { branch: l.target })].filter(Boolean).join(', '),
            'aria-keyshortcuts': r.movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
            tabIndex: 0,
            draggable: r.movable,
            onDragStart: r.onDragStart,
            onDragEnd: r.onDragEnd,
            onDragOver: r.onDragOver,
            onDrop: r.onDrop,
            onKeyDown: r.onKeyDown,
            onContextMenu: r.onContextMenu,
            ...cardDrop
          }
        : {})}
    >
      <Tooltip
        block
        content={
          <>
            <LaneSlotTip lane={l} />
            <LanePoolTip lane={l} />
            <LaneCostTip cost={cost.cost} />
          </>
        }
      >
        <div className="progress-lane-top" onMouseEnter={cost.load}>
          {onExpand && (
            <IconButton
              icon={expanded ? 'chevron-down' : 'chevron-right'}
              className="progress-lane-expand"
              title={tr(msg({ id: 'board.lanes.expand', defaultMessage: '{open, select, yes {Hide the cards of {lane}} other {Show the cards of {lane}}}', description: "Tooltip of the chevron before a lane's name in the Progress panel's Lanes tab: shows or hides its cards in order ({lane}: its builder / reviewer). Keep the select keys." }), { open: expanded ? 'yes' : 'no', lane: pair })} // i18n-ignore: a select's key, never shown
              expanded={expanded}
              onClick={(e) => {
                e.stopPropagation()
                onExpand()
              }}
            />
          )}
          <span className="progress-lane-pair">{pair}</span>
          {/* Its slot (#1446): "· slot-b", or its builder's carried slot ("· hb2"), linking to the slots in Branches & remotes. */}
          {/* Its slot steps aside while an agent's new conversation waits for the user's Retry (HI-2034): the row's hover still names it. */}
          {l.slot && !l.frozen && project && !freshBlocked(l) && (
            <button
              type="button"
              className="link progress-lane-slot faint"
              data-action="lane-slot"
              aria-label={tr(SLOT_LINK, { slot: l.slot.name })}
              onClick={(e) => {
                e.stopPropagation()
                openVersionControl(project.path, 'branches')
              }}
            >
              · {l.slot.name}
            </button>
          )}
          {project && (
            <button
              type="button"
              className="link progress-lane-project faint"
              data-action="lane-project"
              aria-label={tr(PROJECT_LINK, { project: project.name })}
              title={tr(PROJECT_LINK, { project: project.name })}
              onClick={(e) => {
                e.stopPropagation()
                openVersionControl(project.path, 'workflow')
              }}
            >
              {project.name}
            </button>
          )}
          {/* Why it waits (#1279) takes the name's room (every lane keeps one height: the list shows whole lanes),
              cut short with its whole text in its title; a paused lane's in the paused colour, another's faint. */}
          {/* An agent's new conversation no more tried (HI-2034): its reason is the Retry itself, short enough for a narrow
              panel ("⟳ Retry B1"), the whole reason its tooltip and accessible name (and Retry New Conversation in the menu). */}
          {why && freshBlocked(l) ? (
            <button
              type="button"
              className="link progress-lane-why paused progress-lane-retry"
              data-action="lane-retry-fresh"
              title={`${why}\n${tr(RETRY_FRESH)}`}
              aria-label={`${why}. ${tr(RETRY_FRESH)}`}
              onClick={(e) => {
                e.stopPropagation()
                void retryFresh(l)
              }}
            >
              <Icon name="refresh" /> {tr(RETRY_FRESH_SHORT, { agent: l.status?.agent ?? '' })}
            </button>
          ) : why && waitsOn(l.status) && project ? (
            // What it waits for, a click away (#1446): the slots in Branches & remotes, or the runs it waits on.
            <button
              type="button"
              className={cx('link', 'progress-lane-why', l.state === 'paused' && 'paused')}
              data-action="lane-waits"
              title={`${why}\n${tr(WAITS_LINK)}`}
              onClick={(e) => {
                e.stopPropagation()
                showWaitedOn(l, project.path)
              }}
            >
              {why}
            </button>
          ) : why ? (
            <span className={cx('progress-lane-why', l.state === 'paused' && 'paused')} title={why}>
              {why}
            </span>
          ) : (
            <>
              {l.name && <span className="progress-lane-name faint">· {l.name}</span>}
              <div className="grow" />
              {word && <span className={cx('progress-lane-state', l.state)}>{word}</span>}
            </>
          )}
          {waited && (
            <span className={cx('faint', 'progress-lane-waited', wait!.long && 'long')} data-action="lane-waited" title={l.status?.atLeast ? tr(WAITED_AT_LEAST_TIP) : undefined}>
              {waited}
            </span>
          )}
          {stalled && (
            <Tooltip content={`${cardLabelOf({ tasks }, stalled.n)}: ${stalled.why}`}>
              <span className="progress-lane-state stalled">{tr(msg({ id: 'board.lanes.stalled', defaultMessage: 'stalled', description: "A lane's mark in its header (Progress panel), lower case: one of its cards is stalled (nobody is working on it); its tooltip says why." }))}</span>
            </Tooltip>
          )}
          {waitingTip && (
            <Tooltip content={waitingTip} focus>
              <span className="progress-lane-state waiting" data-mark="waiting" tabIndex={0} role="note" aria-label={waitingTip}>
                {tr(LANE_WAITING)}
              </span>
            </Tooltip>
          )}
          {oldRules && (
            <Tooltip content={oldRules} focus>
              <span className="progress-lane-state old-rules" data-mark="old-rules" tabIndex={0} role="note" aria-label={oldRules}>
                {tr(OLD_RULES)}
              </span>
            </Tooltip>
          )}
          {l.target && (
            <Tooltip content={tr(LANE_TARGET_TIP, { branch: l.target })} focus>
              <span className="progress-lane-state lane-target" data-lane-target={l.target} tabIndex={0} role="note" aria-label={tr(LANE_TARGET_TIP, { branch: l.target })}>
                {tr(LANE_TARGET, { branch: l.target })}
              </span>
            </Tooltip>
          )}
          {current !== null && !l.frozen && <span className="progress-lane-current">{cardLabelOf({ tasks }, current)}</span>}
          {current !== null && !l.frozen && <RunDot run={latestRunOf(runs, current)} card={cardLabelOf({ tasks }, current)} />}
          <span className="progress-lane-count faint">
            {unknown ? '–' : finished}/{total}
          </span>
        </div>
      </Tooltip>
      <div className="lane-bar" role="list" aria-label={unknown ? tr(msg({ id: 'board.lanes.barUnrecorded', defaultMessage: '{pair}: {total, plural, one {# card} other {# cards}}, not recorded', description: "Accessible name of a lane's bar (Progress panel) when the lane ended before Combwork recorded where its cards were: the builder / reviewer ({pair}) and how many cards." }), { pair, total }) : tr(msg({ id: 'board.lanes.bar', defaultMessage: '{pair}: {finished} of {total, plural, one {# card} other {# cards}} finished', description: "Accessible name of a lane's bar (Progress panel): the builder / reviewer ({pair}), and how many of its cards are finished (passed or done)." }), { pair, finished, total })}>
        {segments.map((s) => (
          <Segment key={s.kind === 'card' ? s.number : `${s.kind}-${s.numbers[0]}`} segment={s} work={s.kind === 'card' ? laneSegmentWork(l, badges.get(s.number), s, shortFor(s.number), tr, OVERRIDE_NAMES) : []} marks={s.kind === 'card' ? segmentMarks(l, badges.get(s.number), s, shortFor(s.number), tr, OVERRIDE_NAMES, enforced) : {}} folded={s.kind === 'card' ? null : foldedMarks(l, badges, cards, s.numbers, shortFor, tr, OVERRIDE_NAMES, enforced)} />
        ))}
      </div>
      {queued && (
        <div className="progress-lane-queued faint" data-queued="" title={queued}>
          <Icon name="history" /> <span className="progress-lane-queued-text">{queued}</span>
          {/* Cancel Change (HI-2898): drops the queued change, bound to the list shown. */}
          {editing && (
            <button type="button" className="link progress-lane-cancel-change" data-action="lane-cancel-change" onClick={() => void editing.run((now, _rows, rev) => ({ op: 'cancel', lane: now.id, rev: rev(now.id) }))}>
              {tr(EDIT.cancel)}
            </button>
          )}
        </div>
      )}
      {refusal && editing && <RefusalLine refusal={refusal} onMoveHere={(m) => void editing.run((now, rows, rev) => ({ op: 'transfer', card: m.card, from: { lane: m.from.id, rev: rev(m.from.id) }, to: { lane: now.id, rev: rev(now.id) }, ...addedPlace(rows, m.before) }), { [m.from.id]: m.from.listRev })} onDismiss={dismiss} />}
      {expanded && <LaneQueue lane={l} badges={badges} {...(editing ? { edit: editing } : {})} />}
    </div>
  )
}

/**
 * A lane's card's state in its queue (HI-1926): as it sits now, or as the lane left it; waiting for you when held up
 * (blocked, On Hold, at its round limit) or, in a running lane, with a request open in For you (`forYou`: its work
 * badge's open requests; an ended lane's cards stay as it left them).
 */
type QueueState = 'done' | 'doing' | 'review' | 'todo' | 'waiting' | 'gone' | 'unrecorded'
const queueState = (c: LaneCard, forYou = 0): QueueState =>
  c.column === 'gone' || c.column === 'unrecorded' ? c.column : c.column !== 'done' && (c.blocked || c.roundLimit || c.column === 'hold' || forYou > 0) ? 'waiting' : c.column === 'done' ? 'done' : c.column === 'review' || c.column === 'passed' ? 'review' : c.column === 'doing' ? 'doing' : 'todo'
const QUEUE_ICON: Record<QueueState, string> = { done: 'pass', doing: 'circle-filled', review: 'eye', todo: 'circle-large-outline', waiting: 'debug-pause', gone: 'circle-slash', unrecorded: 'question' }

/** A lane's card dragged within its queue (HI-2898): its number. */
const QUEUE_DRAG = 'application/x-combwork-lane-card'

/**
 * Editing a running lane's queue in the Lanes tab (HI-2898): asks main for an edit, and adds a card where it goes. Each
 * edit is asked in turn (HI-2932, editLaneInTurn) and made when its turn comes, from the lane as it is then (`now`, its
 * rows) and the revision `rev` gives; null: nothing left to do. `also`: another lane it changes, with its revision shown.
 */
interface QueueEditing {
  run: (make: QueueEditMaker, also?: Readonly<Record<string, number>>) => Promise<EditOutcome>
  /** A card added before another (its number), or last (null or none): placed when its turn comes. */
  add: (card: number, before?: number | null) => void
  all: Lane[]
}
type QueueEditMaker = (now: Lane, rows: QueueRow[], rev: (lane: string) => number) => LaneEdit | null

/** A lane as the store has it now (HI-2932: an edit asked in turn is made from it), or null once it's gone. */
function laneNow(id: string): Lane | null {
  const s = get()
  return lanesOf(s.lanes ?? [], s.workspace?.projects ?? []).find((x) => x.id === id) ?? null
}

/** The board's cards as the queue reads them (queueRows). */
const boardCards = (tasks: readonly TaskCard[]): Map<number, BoardCard> => new Map(tasks.map((t) => [t.number, { number: t.number, title: t.title, column: t.column, agent: t.agent }]))

/** A lane's queue rows as the store has them now. */
const rowsNow = (l: Lane): QueueRow[] => queueRows(l, boardCards(get().tasks), l.builder.agentId)

/** Taking a card off when its turn comes; nothing to do once it is no longer waiting there (a second Delete on it). */
const removing =
  (card: number): QueueEditMaker =>
  (now, rows, rev) =>
    rows.some((r) => r.card.number === card && r.queued) ? { op: 'remove', lane: now.id, rev: rev(now.id), card } : null

const EDIT = {
  handle: msg({ id: 'board.laneEdit.handle', defaultMessage: 'Drag to move {card}, or press Alt+Up and Alt+Down; Delete takes it off', description: "HI-2898: tooltip and accessible description of a card waiting its turn in a lane's cards (Progress → Lanes): it can be dragged to another place, moved with Alt+Up and Alt+Down, or taken off with Delete. {card} is its key." }),
  remove: msg({ id: 'board.laneEdit.remove', defaultMessage: 'Take {card} off the lane (it goes back to the board)', description: "HI-2898: tooltip of the × on a card waiting its turn in a lane's cards (Progress → Lanes): takes it off the lane; the card stays on the board, in To do. {card} is its key." }),
  lastCard: msg({ id: 'board.laneEdit.lastCard', defaultMessage: '{card} is the lane’s last card to do, and a lane keeps at least one: to stop the lane, end it (End Lane or Abandon Lane… in its menu)', description: "HI-3066: tooltip of the × (turned off) on a lane's last card not Done (Progress → Lanes): it can't be taken off, as a lane always keeps one. {card} is its key. End Lane and Abandon Lane… are the lane's menu items: as they're translated there." }),
  locked: msg({ id: 'board.laneEdit.locked', defaultMessage: '{card} is under way: it keeps its place', description: "HI-2898: tooltip of the lock on a lane's card in progress (Progress → Lanes): it can't be moved. {card} is its key." }),
  add: msg({ id: 'board.laneEdit.add', defaultMessage: 'Add Card…', description: "HI-2898: a button at the end of a lane's cards (Progress → Lanes): opens a search to add a card of the project to the lane. The … says more follows: keep it." }),
  search: msg({ id: 'board.laneEdit.search', defaultMessage: 'Find a card by key or title', description: "HI-2898: placeholder and accessible name of the search box that adds a card to a lane (Progress → Lanes, Add Card…)." }),
  none: msg({ id: 'board.laneEdit.noMatch', defaultMessage: 'No card in To do matches.', description: "HI-2898: under the search box that adds a card to a lane (Progress → Lanes), when no card of the project in To do (not started) matches what was typed. To do is the board's column, as the board names it." }),
  onOther: msg({ id: 'board.laneEdit.onOther', defaultMessage: 'on the lane of {builder}', description: "HI-2898: after a card in the search that adds a card to a lane (Progress → Lanes): another running lane (of the builder agent {builder}) has it." }),
  moveHere: msg({ id: 'board.laneEdit.moveHere', defaultMessage: 'Move Here', description: "HI-2898: a button beside the refusal to add a card that another lane has (Progress → Lanes): takes it off that lane and adds it to this one, in one change." }),
  dismiss: msg({ id: 'board.laneEdit.dismiss', defaultMessage: 'Dismiss', description: "HI-2898: tooltip of the × that closes a refused change's message under a lane (Progress → Lanes)." }),
  cancel: msg({ id: 'board.laneEdit.cancelChange', defaultMessage: 'Cancel Change', description: "HI-2898: a button after a lane's queued change (Progress → Lanes: a change of its cards that waits for its card in progress to be Done): drops that change, keeping the cards as they are." }),
  moved: msg({ id: 'board.laneEdit.said', defaultMessage: '{card}: {at} of {n, plural, one {# card} other {# cards}}', description: "HI-2898: said to screen readers after a card is moved in a lane's cards with Alt+Up or Alt+Down (Progress → Lanes): the card ({card}, its key) and its place now ({at}) among the lane's cards ({n})." }),
  stuck: msg({ id: 'board.laneEdit.stuck', defaultMessage: '{card} can’t move further that way', description: "HI-2898: said to screen readers when a card in a lane's cards (Progress → Lanes) is moved with Alt+Up or Alt+Down but is already first among the cards that can move, or last." }),
  cards: msg({ id: 'board.laneEdit.cards', defaultMessage: 'Cards to add', description: "HI-2898: accessible name of the list of matching cards under the search box that adds a card to a lane (Progress → Lanes)." })
}

/** Copies a merge commit, saying so. */
const copyCommit = (commit: string): void =>
  void navigator.clipboard.writeText(commit).then(() => notify('success', tr(msg({ id: 'board.lanes.mergeCopied', defaultMessage: 'Merge commit copied', description: "A notification after copying a Done card's merge commit from a lane's cards (Progress panel → Lanes)." }))))

const COPY_MERGE = msg({ id: 'board.lanes.copyMerge', defaultMessage: 'Copy the merge commit {commit}', description: "Tooltip of a Done card's merge commit in a lane's cards (Progress panel → Lanes): copies its whole id ({commit})." })

/** Whether a key press is typing in a field (Delete and Ctrl+Z belong to it there). */
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

/**
 * A lane opened to its cards (HI-1926, the Lanes tab): in its order, each with its state (as the lane left it, for an
 * ended one), its key (it opens the card) and title, its round, how long it took or has taken so far, and a Done card's
 * merge commit, copied with a click. Only what its cycle's facts say: nothing for a card gone, not recorded or unknown.
 * A running lane's (`edit`, HI-2898) can be changed: its working list (its queued one when it has one) shows, its cards
 * waiting their turn dragged to another place (or Alt+Up and Alt+Down), taken off (× or Delete), a card added at its end
 * (Add Card…) or dropped from the board where it goes; the card in progress shows a lock, and the cards before it and
 * it keep their places.
 */
function LaneQueue({ lane: l, badges, edit }: { lane: Lane; badges: Map<number, WorkBadge>; edit?: QueueEditing }) {
  const tasks = useStore((s) => s.tasks)
  const now = Date.now()
  const board = useMemo(() => boardCards(tasks), [tasks])
  const rows: QueueRow[] = edit ? queueRows(l, board, l.builder.agentId) : l.info.map((card) => ({ card, queued: false }))
  const list = rows.map((r) => r.card.number)
  const [dragCard, setDragCard] = useState<number | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [said, setSaid] = useState('')
  const ref = useRef<HTMLOListElement>(null)
  /**
   * Where the focus goes after an edit asked from a row (HI-3068): only for that edit, once the lane is drawn showing it
   * (QueueFocus: a row taken off in that same render, HI-3020; a move only once made), never for anyone else's change.
   */
  const focus = useRef<QueueFocus | null>(null)
  focus.current ??= new QueueFocus()
  const focusOn = (n: number | 'lane' | null): void => {
    if (n === null) return
    const to = n === 'lane' ? ref.current?.closest<HTMLElement>('.progress-lane') : ref.current?.querySelector<HTMLElement>(`.progress-lane-queue-row[data-card="${n}"]`)
    to?.focus({ preventScroll: true })
  }
  const shown = list.join()
  useLayoutEffect(() => {
    focusOn(focus.current!.due(shown ? shown.split(',').map(Number) : []))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusOn reads only refs
  }, [l, shown])
  const reset = (): void => {
    setDragCard(null)
    setDropBefore(undefined)
  }
  /** Where a drop with the pointer at `y` over row `n` (none: under the rows) would go, shown by a line; undefined: nowhere. */
  const over = (e: React.DragEvent<HTMLElement>, n: number | null): void => {
    if (!edit || e.isDefaultPrevented()) return
    const own = e.dataTransfer.types.includes(QUEUE_DRAG)
    if (!own && !e.dataTransfer.types.includes(CARD_DRAG)) return
    let before: number | null = null
    if (n !== null) {
      const box = e.currentTarget.getBoundingClientRect()
      before = e.clientY < box.top + box.height / 2 ? n : (list[list.indexOf(n) + 1] ?? null)
    }
    // A card dragged from the board isn't known until the drop: placed as a new one.
    if (droppedPlace(rows, own ? dragCard : null, before) === null) {
      // Nowhere to drop over a row that keeps its place (HI-2969): stopped here, or the list and the lane's row would
      // take it as "after the last row" and the card would go last, the opposite end from where it was dropped.
      e.stopPropagation()
      return setDropBefore(undefined)
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropBefore(before)
  }
  const drop = (e: React.DragEvent<HTMLElement>): void => {
    if (!edit || dropBefore === undefined) return
    e.preventDefault()
    e.stopPropagation()
    const own = e.dataTransfer.types.includes(QUEUE_DRAG)
    const n = own ? dragCard : Number(e.dataTransfer.getData(CARD_DRAG))
    const before = dropBefore
    reset()
    if (!n || !Number.isInteger(n) || n <= 0) return
    // A card of this lane dragged from the board is a move too.
    if (list.includes(n)) {
      if (droppedPlace(rows, n, before) === null) return
      // Placed by the rows as they are when its turn comes (HI-2932): before the same card.
      void edit.run((cur, r, rev) => {
        const to = droppedPlace(r, n, before)
        return to === null ? null : { op: 'move', lane: cur.id, rev: rev(cur.id), card: n, to }
      })
      return
    }
    // Placed by the card it goes before, when its turn comes (HR1's round 1: two quick drops keep their order).
    edit.add(n, before)
  }
  /**
   * Takes a card off from its row (Delete or ×). Its row goes, and the focus with it to the page's body, where Ctrl+Z
   * (the Lanes tab's) no longer hears it (HI-3020): so the focus moves to the next card's row, or the lane's own row when
   * none comes after it. Only once the lane shows it made (HI-3068): moved before, a second Delete (or a held one) took
   * the next card off too, and a refused one left the focus on a card it never asked about.
   */
  const takeOff = (n: number, row: HTMLElement | null): void => {
    if (!edit) return
    let next = row?.nextElementSibling ?? null
    while (next && !next.matches('.progress-lane-queue-row.movable')) next = next.nextElementSibling
    const to = next instanceof HTMLElement && next.dataset.card ? Number(next.dataset.card) : 'lane'
    const id = focus.current!.ask('off', n, to)
    void edit.run(removing(n)).then((o) => focus.current!.settled(id, o === 'made'))
  }
  const nudge = (n: number, by: -1 | 1): void => {
    const label = cardLabelOf({ tasks }, n)
    if (!edit || nudgedPlace(rows, n, by) === null) return setSaid(tr(EDIT.stuck, { card: label }))
    const id = focus.current!.ask('move', n)
    // One place on from where it is when its turn comes (HI-2932: two quick presses, two places), and said once made:
    // a refused move is never announced as made.
    void edit
      .run((cur, r, rev) => {
        const to = nudgedPlace(r, n, by)
        if (to !== null) focus.current!.aim(id, to)
        return to === null ? null : { op: 'move', lane: cur.id, rev: rev(cur.id), card: n, to }
      })
      .then((o) => {
        focusOn(focus.current!.settled(id, o === 'made'))
        if (o === 'skipped') return setSaid(tr(EDIT.stuck, { card: label }))
        if (o !== 'made') return
        const after = laneNow(l.id)
        const r = after ? rowsNow(after) : []
        const at = r.findIndex((x) => x.card.number === n)
        if (at >= 0) setSaid(tr(EDIT.moved, { card: label, at: at + 1, n: r.length }))
      })
  }
  return (
    <>
      <ol
        ref={ref}
        className={cx('progress-lane-queue', !!edit && 'editable')}
        aria-label={tr(msg({ id: 'board.lanes.queue', defaultMessage: 'Cards of {lane}', description: "Accessible name of a lane's cards in order, opened under it in the Progress panel's Lanes tab ({lane}: its builder / reviewer)." }), { lane: lanePair(l) })}
        onDragOver={(e) => over(e, null)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropBefore(undefined)}
        onDrop={drop}
      >
        {rows.map(({ card: c, queued }, i) => {
          const state = queueState(c, l.frozen ? 0 : (badges.get(c.number)?.forYou ?? 0))
          const known = state !== 'gone' && state !== 'unrecorded'
          const time = known ? laneCardTime(c.column, badges.get(c.number), l.frozen ? l.endedAt : null, now) : null
          const label = cardLabelOf({ tasks }, c.number)
          const stateText = tr(msg({ id: 'board.lanes.queueState', defaultMessage: '{state, select, done {Done} doing {Active} review {In review} todo {To do} waiting {Waiting for you} gone {Gone} other {Not recorded}}', description: "A card's state in a lane's cards, opened in the Progress panel's Lanes tab (its icon's name): done, being worked on, in review, not started, waiting for the user (blocked, on hold or at its round limit), gone from the board, or not recorded by the lane. Keep the select keys." }), { state }) // i18n-ignore: a select's key, never shown
          const movable = !!edit && queued
          // A lane keeps a card to do (HI-3066): its last one not Done can't be taken off (main refuses it too).
          const lastToDo = movable && !rows.some((r) => r.card.number !== c.number && r.card.column !== 'done')
          const underWay = !!edit && !queued && (c.column === 'doing' || c.column === 'review' || c.column === 'passed')
          return (
            <li
              key={c.number}
              className={cx('progress-lane-queue-row', state, movable && 'movable', dragCard === c.number && 'dragging', dropBefore === c.number && 'drop-before', dropBefore === null && i === rows.length - 1 && 'drop-after')}
              data-card={c.number}
              data-state={state}
              {...(movable
                ? {
                    tabIndex: 0,
                    draggable: true,
                    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Delete',
                    'aria-description': tr(EDIT.handle, { card: label }),
                    onDragStart: (e: React.DragEvent<HTMLLIElement>) => {
                      e.stopPropagation()
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData(QUEUE_DRAG, String(c.number))
                      e.dataTransfer.setData('text/plain', label)
                      setTimeout(() => setDragCard(c.number), 0)
                    },
                    onDragEnd: reset,
                    onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => {
                      if (typing(e.target)) return
                      // Alt+Up and Alt+Down from the row's own link or × move its card too (HI-2970), as the row says;
                      // Delete only from the row itself (on a button it is the button's).
                      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                        e.preventDefault()
                        e.stopPropagation()
                        nudge(c.number, e.key === 'ArrowUp' ? -1 : 1)
                      } else if (e.target === e.currentTarget && e.key === 'Delete' && !e.altKey && !e.ctrlKey && !e.metaKey) {
                        e.preventDefault()
                        e.stopPropagation()
                        // Held down, one card (HI-3068): the key's repeats take nothing more off.
                        if (!e.repeat) takeOff(c.number, e.currentTarget)
                      }
                    }
                  }
                : {})}
              onDragOver={(e) => over(e, c.number)}
              onDrop={drop}
            >
              {movable && <Icon name="gripper" className="progress-lane-queue-grip" title={tr(EDIT.handle, { card: label })} aria-hidden="true" />}
              {underWay && <Icon name="lock" className="progress-lane-queue-lock" title={tr(EDIT.locked, { card: label })} aria-label={tr(EDIT.locked, { card: label })} />}
              <Icon name={QUEUE_ICON[state]} className="progress-lane-queue-icon" aria-label={stateText} title={stateText} />
              <button type="button" className="link progress-lane-queue-key" onClick={() => set({ taskOpen: c.number })}>
                {label}
              </button>
              <span className="progress-lane-queue-title" title={c.title}>
                {c.title}
              </span>
              {known && <span className="faint progress-lane-queue-round">{tr(msg({ id: 'board.lanes.round', defaultMessage: 'r{round}', description: "A card's round in a lane's cards (Progress panel → Lanes), short: r1 for its first, r3 after two failed reviews." }), { round: c.round })}</span>}
              {time?.soFar !== undefined && <span className="faint progress-lane-queue-time">{tr(msg({ id: 'board.lanes.soFar', defaultMessage: '{time} so far', description: "How long a lane's card has been worked on so far, in its cards (Progress panel → Lanes). {time}: 4 min, 1 h 5 min." }), { time: durationText(time.soFar, tr) })}</span>}
              {time?.took !== undefined && <span className="faint progress-lane-queue-time">{tr(msg({ id: 'board.lanes.took', defaultMessage: 'took {time}', description: "How long a lane's Done card took, from its start to its merge, in its cards (Progress panel → Lanes). {time}: 4 min, 1 h 5 min." }), { time: durationText(time.took, tr) })}</span>}
              {time?.merged && (
                <button type="button" className="link progress-lane-queue-commit" title={tr(COPY_MERGE, { commit: time.merged })} onClick={() => copyCommit(time.merged!)}>
                  {time.merged.slice(0, 7)}
                </button>
              )}
              {movable && <IconButton icon="close" className="progress-lane-queue-remove" title={lastToDo ? tr(EDIT.lastCard, { card: label }) : tr(EDIT.remove, { card: label })} disabled={lastToDo} onClick={(e) => takeOff(c.number, e.currentTarget.closest('li'))} />}
            </li>
          )
        })}
      </ol>
      {edit && (
        <div className="progress-lane-queue-add">
          {picking ? (
            <CardPicker lane={l} all={edit.all} taken={list} onPick={(n) => edit.add(n)} onClose={() => setPicking(false)} />
          ) : (
            <button type="button" className="btn small subtle" data-action="lane-add-card" onClick={() => setPicking(true)}>
              <Icon name="add" /> {tr(EDIT.add)}
            </button>
          )}
        </div>
      )}
      {edit && (
        <div className="visually-hidden" role="status">
          {said}
        </div>
      )}
    </>
  )
}

/** A project's folder name, as cards name their project. */
const folderOf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? ''

/**
 * Add Card… (HI-2898): a search of the lane's project's cards in To do that it hasn't, by key or title; one on another
 * lane says whose (adding it is refused there, with Move here). Enter adds the first, Escape closes.
 */
function CardPicker({ lane: l, all, taken, onPick, onClose }: { lane: Lane; all: Lane[]; taken: number[]; onPick: (n: number) => void; onClose: () => void }) {
  const tasks = useStore((s) => s.tasks)
  const [q, setQ] = useState('')
  const project = folderOf(l.project)
  const query = q.trim().toLowerCase()
  const found = tasks
    .filter((t) => !t.archived && t.column === 'todo' && t.project.toLowerCase() === project && !taken.includes(t.number))
    .filter((t) => !query || cardLabelOf({ tasks }, t.number).toLowerCase().includes(query) || t.title.toLowerCase().includes(query))
    .slice(0, 20)
  const laneOf = (n: number): Lane | undefined => all.find((x) => x.id !== l.id && laneRunning(x.state) && (x.cards.includes(n) || !!x.queued?.includes(n)))
  const pick = (n: number): void => {
    onPick(n)
    onClose()
  }
  return (
    <div className="progress-lane-picker" data-picker="">
      <SearchInput
        className="small"
        autoFocus
        value={q}
        placeholder={tr(EDIT.search)}
        aria-label={tr(EDIT.search)}
        onChange={setQ}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter' && found[0]) {
            e.preventDefault()
            pick(found[0].number)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            e.currentTarget.closest('.progress-lane-picker')?.querySelector<HTMLElement>('.progress-lane-picker-card')?.focus()
          }
        }}
      />
      <IconButton icon="close" title={tr(EDIT.dismiss)} onClick={onClose} />
      {found.length ? (
        <ul className="progress-lane-picker-list" aria-label={tr(EDIT.cards)}>
          {found.map((t) => {
            const other = laneOf(t.number)
            return (
              <li key={t.number}>
                <button
                  type="button"
                  className="progress-lane-picker-card"
                  data-card={t.number}
                  onClick={() => pick(t.number)}
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowDown' ? 'nextElementSibling' : e.key === 'ArrowUp' ? 'previousElementSibling' : null
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      onClose()
                    }
                    if (!step) return
                    e.preventDefault()
                    const li = e.currentTarget.parentElement?.[step] as HTMLElement | null | undefined
                    li?.querySelector<HTMLElement>('button')?.focus()
                  }}
                >
                  <span className="progress-lane-queue-key">{cardLabelOf({ tasks }, t.number)}</span>
                  <span className="progress-lane-queue-title">{t.title}</span>
                  {other && <span className="faint">{tr(EDIT.onOther, { builder: other.builder.name })}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="faint progress-lane-picker-none">{tr(EDIT.none)}</p>
      )}
    </div>
  )
}

/** A refused edit, shown under its lane (HI-2898): main's reason, and Move here for a card another lane has. */
interface Refusal {
  text: string
  moveHere: { card: number; from: Lane; before?: number | null } | null
}

/**
 * How a running lane's row edits its queue (HI-2898): each edit asked of main, a refusal kept to show under the lane
 * (cleared by the next edit or dismissed); a card another lane has is offered Move here.
 */
function useQueueEditing(l: Lane, all: Lane[] | undefined): { editing: QueueEditing | null; refusal: Refusal | null; dismiss: () => void } {
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  if (!all || !laneRunning(l.state) || l.frozen) return { editing: null, refusal: null, dismiss: () => undefined }
  // The revision as shown now, when the user asks (HI-2932): the edit, made in its turn, names the lane's then only when
  // nothing but this window's own edits came between.
  const run = (make: QueueEditMaker, also: Readonly<Record<string, number>> = {}, add?: { card: number; before?: number | null }): Promise<EditOutcome> => {
    setRefusal(null)
    return editLaneInTurn({ ...also, [l.id]: l.listRev }, (rev) => {
      const now = laneNow(l.id)
      if (!now || !laneRunning(now.state) || now.frozen) return null
      const e = make(now, rowsNow(now), rev)
      return e && { edit: e, names: { lane: lanePair(now) } }
    }).then((o) => {
      if (typeof o === 'object') {
        const others = lanesOf(get().lanes ?? [], get().workspace?.projects ?? [])
        const from = add ? others.find((x) => x.id !== l.id && laneRunning(x.state) && (x.cards.includes(add.card) || !!x.queued?.includes(add.card))) : undefined
        setRefusal({ text: o.refused, moveHere: from && add ? { card: add.card, from, ...(add.before !== undefined ? { before: add.before } : {}) } : null })
      }
      return o
    })
  }
  return {
    editing: {
      run: (make, also) => run(make, also),
      add: (card, before) => void run((now, rows, rev) => ({ op: 'add', lane: now.id, rev: rev(now.id), card, ...addedPlace(rows, before) }), {}, { card, ...(before !== undefined ? { before } : {}) }),
      all
    },
    refusal,
    dismiss: () => setRefusal(null)
  }
}

/** The refusal of an edit, in place under its lane (HI-2898), with Move here when another lane has the card. */
function RefusalLine({ refusal: r, onMoveHere, onDismiss }: { refusal: Refusal; onMoveHere: (m: NonNullable<Refusal['moveHere']>) => void; onDismiss: () => void }) {
  return (
    <div className="progress-lane-refusal" role="alert" data-refusal="">
      <Icon name="warning" />
      <span className="progress-lane-refusal-text">{r.text}</span>
      {r.moveHere && (
        <button type="button" className="btn small" data-action="lane-move-here" onClick={() => onMoveHere(r.moveHere!)}>
          {tr(EDIT.moveHere)}
        </button>
      )}
      <IconButton icon="close" title={tr(EDIT.dismiss)} onClick={onDismiss} />
    </div>
  )
}

const ENDED = {
  title: msg({ id: 'board.lanes.endedToday', defaultMessage: 'Ended today ({n, number})', description: "HI-2898: a collapsed row at the top of Progress → Lanes: the lanes (a builder and a reviewer working through cards in turn) that ended today, local time ({n}: how many); it opens to them." }),
  took: msg({ id: 'board.lanes.endedTook', defaultMessage: '{time} in all', description: "HI-2898: how long a lane that ended today ran, from its start to its end, in Ended today (Progress → Lanes). {time}: 4 min, 1 h 5 min." }),
  cards: msg({ id: 'board.lanes.endedCards', defaultMessage: '{n, plural, one {# card} other {# cards}}', description: "HI-2898: how many cards a lane that ended today had, in Ended today (Progress → Lanes)." })
}

/**
 * Today's ended lanes (HI-2898, Darren's decision: the local calendar day): the lanes that ended since local midnight,
 * read again as the lanes change, at midnight (and on a change of the date, clock or time zone, seen on focus and each
 * minute). Only while the Lanes tab shows (`on`).
 */
function useEndedToday(on: boolean): Lane[] {
  const ws = useStore((s) => s.workspace?.path ?? null)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  const raw = useStore((s) => s.lanes)
  const [day, setDay] = useState(() => dayKey(new Date()))
  const [ended, setEnded] = useState<LaneInfo[]>(NO_ENDED)
  useEffect(() => {
    if (!on) return
    const check = (): void => setDay(dayKey(new Date()))
    const atMidnight = setTimeout(check, Math.max(1000, dayBounds(new Date()).end.getTime() - Date.now() + 1000))
    const each = setInterval(check, 60_000)
    window.addEventListener('focus', check)
    return () => {
      clearTimeout(atMidnight)
      clearInterval(each)
      window.removeEventListener('focus', check)
    }
  }, [on, day])
  useEffect(() => {
    if (!on || !ws) return setEnded(NO_ENDED)
    let current = true
    void call('lanes:endedSince', dayBounds(new Date()).start.toISOString()).then(
      (r) => current && setEnded(r.length ? r : NO_ENDED),
      () => undefined
    )
    return () => {
      current = false
    }
  }, [on, ws, day, raw])
  return useMemo(() => lanesOf(ended, projects), [ended, projects])
}
const NO_ENDED: LaneInfo[] = []

/**
 * Ended today (HI-2898), collapsed at the top of the Lanes tab, hidden with none: each lane's builder and reviewer, its
 * name, merged or abandoned, its cards and how long it ran, with its merge commit (copied with a click); each opens to
 * its cards as it left them, read only.
 */
function EndedToday({ lanes, badges }: { lanes: Lane[]; badges: Map<number, WorkBadge> }) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set())
  if (!lanes.length) return null
  const toggle = (id: string): void => setShown((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])))
  return (
    <div className="progress-lanes-ended" data-ended-today="">
      <button type="button" className="progress-lanes-ended-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} /> {tr(ENDED.title, { n: lanes.length })}
      </button>
      {open &&
        lanes.map((l) => {
          const pair = lanePair(l)
          const took = l.endedAt ? Date.parse(l.endedAt) - Date.parse(l.startedAt) : null
          const word = stateWord(l.state)
          return (
            <div key={l.id} className={cx('progress-lane', 'progress-lane-ended', l.state)} data-lane={l.id}>
              <div className="progress-lane-top">
                <IconButton
                  icon={shown.has(l.id) ? 'chevron-down' : 'chevron-right'}
                  className="progress-lane-expand"
                  title={tr(msg({ id: 'board.lanes.expand', defaultMessage: '{open, select, yes {Hide the cards of {lane}} other {Show the cards of {lane}}}', description: "Tooltip of the chevron before a lane's name in the Progress panel's Lanes tab: shows or hides its cards in order ({lane}: its builder / reviewer). Keep the select keys." }), { open: shown.has(l.id) ? 'yes' : 'no', lane: pair })} // i18n-ignore: a select's key, never shown
                  expanded={shown.has(l.id)}
                  onClick={() => toggle(l.id)}
                />
                <span className="progress-lane-pair">{pair}</span>
                {l.name && <span className="progress-lane-name faint">· {l.name}</span>}
                <div className="grow" />
                {word && <span className={cx('progress-lane-state', l.state)}>{word}</span>}
                <span className="faint">{tr(ENDED.cards, { n: l.cards.length })}</span>
                {took !== null && took >= 0 && <span className="faint progress-lane-ended-took">{tr(ENDED.took, { time: durationText(took, tr) })}</span>}
                {l.mergeCommit && (
                  <button type="button" className="link progress-lane-queue-commit" title={tr(COPY_MERGE, { commit: l.mergeCommit })} onClick={() => copyCommit(l.mergeCommit!)}>
                    {l.mergeCommit.slice(0, 7)}
                  </button>
                )}
              </div>
              {shown.has(l.id) && <LaneQueue lane={l} badges={badges} />}
            </div>
          )
        })}
    </div>
  )
}

const WAITED_AT_LEAST = msg({ id: 'board.lanes.waitedAtLeast', defaultMessage: '{time}+', description: "How long a lane has waited, in its header (Progress panel), when Combwork didn't see its wait begin (it was already waiting when Combwork started): at least {time} (4 min, 1 h 5 min)." })
const WAITED_AT_LEAST_TIP = msg({ id: 'board.lanes.waitedAtLeastTip', defaultMessage: 'It was already waiting when Combwork first saw it: it has waited at least this long.', description: "Tooltip of a lane's wait time with a + in its header (Progress panel): Combwork didn't see the wait begin." })

/**
 * One segment: a card (a click opens it), or the finished cards folded together, or the rest of a long lane. `work`:
 * what its facts say (#1225), a few lines in its hover after its label and notes, with a click for the rest.
 */
function Segment({ segment: s, work, marks, folded }: { segment: LaneSegment; work: string[]; marks: SegmentMarks; folded: FoldedMarks | null }) {
  if (s.kind !== 'card') {
    // The marks of the cards folded into it (HR6's #1279 round 1): each kind once on it, a line per card under its label.
    const lines = folded ? [...folded.refused, ...folded.stale, ...folded.override, ...folded.oldRules] : []
    return (
      <Tooltip
        content={
          lines.length ? (
            <div className="lane-seg-tip">
              <div>{s.label}</div>
              {lines.map((n) => (
                <div key={n} className="lane-seg-note">
                  {n}
                </div>
              ))}
            </div>
          ) : (
            s.label
          )
        }
        focus
      >
        <span role="listitem" tabIndex={0} className={cx('lane-seg', s.kind, !!folded?.stale.length && 'stale')} aria-label={[s.label, ...lines].join('. ')}>
          {s.kind === 'finished' ? `✓ ${s.numbers.length}` : `+${s.numbers.length}`}
          {!!folded?.refused.length && <span className="lane-seg-mark refused" aria-hidden="true" />}
          {!!folded?.override.length && <span className="lane-seg-mark override" aria-hidden="true" />}
          {!!folded?.oldRules.length && <span className="lane-seg-mark old-rules" aria-hidden="true" />}
        </span>
      </Tooltip>
    )
  }
  // What its red underline or hatching means (#706), a line each under the card's own; its category's stages when it has
  // more than one (#1421: Approved | Merging, the card's own marked); old rules.
  const tip =
    s.notes.length || work.length || s.stages || marks.oldRules ? (
      <div className="lane-seg-tip">
        <div>{s.label}</div>
        {s.stages && (
          <div className="lane-seg-stages" data-stages="">
            {s.stages.map((x, i) => (
              <span key={x.id} className={cx('lane-seg-stage', x.own && 'own')} data-stage={x.id} aria-current={x.own || undefined}>
                {i > 0 && <span className="lane-stage-divider" aria-hidden="true" />}
                {x.name}
              </span>
            ))}
          </div>
        )}
        {marks.oldRules && <div className="lane-seg-note">{marks.oldRules}</div>}
        {s.notes.map((n) => (
          <div key={n} className="lane-seg-note">
            {n}
          </div>
        ))}
        {work.map((w) => (
          <div key={w} className="lane-seg-work">
            {w}
          </div>
        ))}
        {work.length > 0 && <div className="lane-seg-more faint">{tr(msg({ id: 'board.lane.openForMore', defaultMessage: 'Click to open the card for the rest', description: "The last line of a lane segment's hover (Progress panel), under what its facts say: clicking the segment opens the card, which shows everything." }))}</div>}
      </div>
    ) : (
      s.label
    )
  return (
    <Tooltip content={tip} focus>
      <button type="button" role="listitem" className={cx('lane-seg', s.state, s.failed && 'failed', marks.stale && 'stale')} data-card={s.number} data-old-rules={marks.oldRules ? '' : undefined} aria-label={[segmentName(s), marks.refused, marks.stale, marks.override, marks.oldRules].filter(Boolean).join('. ')} onClick={() => set({ taskOpen: s.number })}>
        {/* Its facts' marks (#1279), each a shape of its own: a refused request's notch, an override's corner, old rules' bar (#1421). */}
        {marks.refused && <span className="lane-seg-mark refused" aria-hidden="true" />}
        {marks.override && <span className="lane-seg-mark override" aria-hidden="true" />}
        {marks.oldRules && <span className="lane-seg-mark old-rules" aria-hidden="true" />}
      </button>
    </Tooltip>
  )
}

/**
 * The latest run of a lane's current card (#1309), a dot after its name in the lane's header: by colour and shape,
 * running (a ring), passed (filled), failed (a cross), stopped or stale (a dash); its title says which run and how.
 */
function RunDot({ run: r, card }: { run: ProgressRun | null; card: string }) {
  if (!r) return null
  const state = r.state === 'running' ? 'running' : r.state === 'passed' ? 'passed' : r.state === 'failed' ? 'failed' : 'other'
  const text = tr(msg({ id: 'board.lanes.latestRun', defaultMessage: "{card}'s latest run: {run}, {state, select, running {running} passed {passed} failed {failed} other {stopped}}", description: "Tooltip and accessible name of the dot after a lane's current card (Progress panel): that card's latest run ({run}: its title) and how it is going or went. Keep the select keys." }), { card, run: r.title, state }) // i18n-ignore: select keys, never shown
  return (
    <Tooltip content={text}>
      <span className={cx('lane-run-dot', state)} role="img" aria-label={text} data-run={r.id} />
    </Tooltip>
  )
}
