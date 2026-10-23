import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { RUNS_KEEP_PX, draggedLaneRows, droppedLaneOrder, fitSegments, frozenSegment, keyedLaneRows, laneCards, laneOldRulesNote, laneRowsNow, laneRunning, laneSummary, mergedLaneOrder, nudgedLaneOrder, pulseLanes, foldedMarks, laneWaitText, segmentMarks, segmentName, segmentsThatFit, laneSegmentWork, type FoldedMarks, type LaneSegment, type SegmentMarks } from '@shared/laneBar'
import { laneLegend, legendSources, segmentStage, type LegendGroup } from '@shared/laneStages'
import { revisionShort } from '@shared/platform/descriptors'
import type { WorkBadge } from '@shared/workflow/workView'
import type { LaneStatus, ProgressRun, ProjectStages } from '@shared/types'
import { NO_RUNS_FILTER, latestRunOf, slotRunsKey } from '@shared/progressTabs'
import { formatDateTime } from '@shared/dates'
import { useWorkBadges } from '../cardWork'
import { useProjectStages } from '../projectStages'
import { OVERRIDE_NAMES } from './CardWork'
import { fmt, msg, tr } from '@shared/i18n'
import { call, errorMessage } from '../api'
import { NO_PROJECTS, cardLabelOf, confirm, get, notify, openVersionControl, set, useLanguage, useStore } from '../store'
import { openLaneStart } from './LaneStartDialog'
import { saveLaneOrder, useLaneOf, useLaneOrder, type Lane } from '../laneSource'
import { useNow } from '../usage'
import { cx } from '../util'
import { useAdvancedValue } from '../advanced'
import { cardStalled } from './Board'
import { usePanelFold } from './ProgressMerge'
import { Icon, Tooltip, useContextMenu } from './ui'
import { LaneCostTip, useLaneCost } from './CardCost'

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
const PITCH_PX = 61

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
  // Pulse leaves out a Solo project's lanes unless one runs (#1421); the Lanes tab shows every lane.
  const lanes = full ? given : pulseLanes(given, (p) => stages.get(p.toLowerCase())?.preset)
  // Off, an old rules mark still shows (it is a fact) and says the rules aren't enforced (#1421).
  const enforced = useAdvancedValue<boolean>('hive.workflow.enforce')
  const [foldedKept, toggle] = usePanelFold(ws ? foldKey(ws) : null)
  const folded = foldedKept && !full
  const key = ws ? rowsKey(ws) : null
  const kept = useStore((s) => (key ? s.panes[key] : undefined))
  // The lanes shown until the edge is dragged: Settings → Advanced's, or the workspace's own (#367).
  const fallback = useAdvancedValue<number>('hive.progress.lanesShown')
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
      { label: tr(msg({ id: 'board.lanes.usualOrder', defaultMessage: 'Usual Order', description: "A lane's context menu item in the Progress panel: puts the lanes back in their usual order, undoing the user's own." })), icon: 'list-ordered', detail: tr(msg({ id: 'board.lanes.usualOrderDetail', defaultMessage: 'Running lanes newest first, paused ones after them', description: 'Under Usual Order in a lane\'s context menu (Progress panel): what the usual order is.' })), disabled: !custom, onClick: usual },
      // Ending one needs no tool (#1280, SPEC §16.11.3): End Lane, and Abandon Lane after asking.
      { separator: true },
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
    const panel = el?.closest<HTMLElement>('.progress-panel')
    const body = panel?.querySelector<HTMLElement>('.progress-body')
    const section = el?.closest<HTMLElement>('.progress-lanes')
    if (full || !open || !el || !body || !panel || !section) return
    const row = el.querySelector<HTMLElement>('.progress-lane')
    const measure = (): void => {
      if (row) {
        const h = row.getBoundingClientRect().height + parseFloat(getComputedStyle(row).marginBottom || '0')
        if (h > 0) setPitch((was) => (Math.abs(was - h) < 0.1 ? was : h))
      }
      // The lanes follow the runs (#1309: not pinned to the bottom), so the room left below them is theirs too.
      const below = Math.max(0, panel.getBoundingClientRect().bottom - section.getBoundingClientRect().bottom)
      const r = el.clientHeight + body.getBoundingClientRect().height + below - RUNS_KEEP_PX
      setRoom((was) => (was !== null && Math.abs(was - r) < 1 ? was : r))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    watch.observe(body)
    watch.observe(panel)
    if (row) watch.observe(row)
    return () => watch.disconnect()
  }, [open, lanes, width, full])
  if (!lanes.length)
    return full ? (
      <div className="pane-empty progress-empty">
        <p>{tr(msg({ id: 'board.lanes.none', defaultMessage: 'No lanes. When a builder and a reviewer work through cards in turn (a card loop), their lane shows here with each card.', description: "The Progress panel's Lanes tab when there are no lanes. Glossary: lane." }))}</p>
        <button type="button" className="btn small progress-lanes-start" onClick={() => openLaneStart(null)}>
          <Icon name="add" /> {tr(START_LANE)}
        </button>
      </div>
    ) : null
  const { chosen, shown, max } = laneRowsNow(kept, lanes.length, room, pitch, fallback)
  // The legend (#1421): the stages the lanes shown have (old rules' too), by category, on the Lanes bar's hover and focus.
  const legend = laneLegend(legendSources(lanes, (p) => stages.get(p.toLowerCase()), badges), tr)
  const foldTip = folded ? tr(msg({ id: 'board.lanes.show', defaultMessage: 'Show the lanes', description: "Tooltip of the Progress panel's Lanes bar when the lanes are folded away." })) : tr(msg({ id: 'board.lanes.fold', defaultMessage: 'Fold the lanes', description: "Tooltip of the Progress panel's Lanes bar: folds the lanes down to the bar." }))
  const legendId = `lanes-legend-${full ? 'tab' : 'pulse'}`
  return (
    <div className={cx('progress-lanes', folded && 'folded', full && 'full')} role="region" aria-label={tr(LANES)}>
      {!folded && !full && key && <LanesEdge rowsKey={key} chosen={chosen} shown={shown} max={max} count={lanes.length} pitch={pitch} fallback={fallback} />}
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
        </div>
      )}
      {/* The legend for screen readers: the bar's (or the tab's Legend button's) description. */}
      <span id={legendId} className="visually-hidden">
        {legendText(legend)}
      </span>
      {!folded && (
        // Whole lanes, the next one's top at the bottom edge; all of them, with the list's padding, when they fit.
        <div className="progress-lanes-list" ref={list} style={!full && shown < lanes.length ? { maxHeight: shown * pitch } : undefined} onDragOver={overList}>
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} max={segmentsThatFit(width - BAR_INSET_PX)} reorder={reorder(l)} badges={badges} runs={runs} stages={stages.get(l.project.toLowerCase())} enforced={enforced} />
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
 * The section's top edge (#569): a window splitter (WAI-ARIA) whose value is the lanes shown now and whose maximum is
 * the most that fit (the runs above keep RUNS_KEEP_PX), not the choice kept. Dragging snaps to whole lanes from what
 * shows; a double-click goes back to the default; focused, Up and Down change it by a lane, Home and End to one and to
 * all that fit. A drag or key sets the choice to what it shows, also where a short panel had shown fewer than chosen.
 */
function LanesEdge({ rowsKey: key, chosen, shown, max, count, pitch, fallback }: { rowsKey: string; chosen: number; shown: number; max: number; count: number; pitch: number; fallback: number }) {
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
      const rows = draggedLaneRows(shown, ev.clientY - startY, pitch, max)
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
  return (
    <div
      className={cx('progress-lanes-edge', dragging && 'dragging')}
      role="separator"
      aria-orientation="horizontal"
      aria-label={tr(msg({ id: 'board.lanes.edge', defaultMessage: 'Lanes shown', description: "Accessible name of the handle on the top edge of the Progress panel's lanes: drag it for more or fewer lanes." }))}
      aria-valuemin={1}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={tr(msg({ id: 'board.lanes.edgeValue', defaultMessage: '{shown} of {count, plural, one {# lane} other {# lanes}} shown', description: "The value of the handle on the top edge of the Progress panel's lanes, for screen readers: {shown} of the {count} lanes show." }), { shown, count })}
      tabIndex={0}
      title={tr(msg({ id: 'board.lanes.edgeTip', defaultMessage: 'Drag to show more or fewer lanes; double-click for {lanes}', description: "Tooltip of the handle on the top edge of the Progress panel's lanes. {lanes} is the default number of lanes shown." }), { lanes: fallback })}
      onPointerDown={start}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const rows = keyedLaneRows(shown, e.key, max)
        if (rows === null) return
        e.preventDefault()
        // Against the choice kept: on a short panel showing fewer than chosen, End keeps what fits.
        if (rows === chosen) return
        put(rows)
        save()
      }}
    />
  )
}

const LANE_DRAG = 'application/x-hive-lane'

const START_LANE = msg({ id: 'board.lanes.start', defaultMessage: 'Start Lane…', description: "A button in the Progress panel's Lanes tab and an item of a lane's menu: opens Start Lane (a builder and a reviewer agent work through cards in turn). Glossary: lane." })

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
const WAITS_LINK = msg({ id: 'board.lanes.waitsLink', defaultMessage: '{why}. Click to show it.', description: "Tooltip of why a lane waits, in its header (Progress panel, #1446), when a click shows what it waits for: its slot or the slots in use (Branches & remotes), or the runs it waits on (the Runs tab). {why} is the reason as the header says it (\"waiting for a slot\")." })

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
      {s.line && <div className="faint">{tr(msg({ id: 'board.lanes.slotLine', defaultMessage: 'On {line}', description: "A lane's slot in its hover (Progress panel, #1446): the branch its current card is built on there follows ({line}, such as hive/HI/HI-12-fix-login: keep it as it is)." }), { line: s.line })}</div>}
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
function LaneRow({ lane: l, max, reorder: r, badges, runs, stages, enforced }: { lane: Lane; max: number; reorder: LaneReorder | null; badges: Map<number, WorkBadge>; runs: ProgressRun[]; stages: ProjectStages | undefined; enforced: boolean }) {
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
  const { finished, total, current } = laneSummary(cards)
  // A lane that ended without a record of its cards doesn't know how many were finished (#512).
  const unknown = cards.some((c) => c.state === 'unrecorded')
  const segments = fitSegments(cards, max, tr, fmt.list)
  const pair = lanePair(l)
  // Why it waits (#1279, from #1270's status): said in its header instead of just "paused", and in its accessible name.
  const why = l.status && !l.frozen ? laneWaitText(l.status, (n) => cardLabelOf({ tasks }, n), tr) : null
  const word = stateWord(l.state)
  // Its cost on the hover of its top line (#602), read when the hover first shows.
  const cost = useLaneCost(l.id)
  // A card's revisions as its project's platform shows them (its descriptor, never a switch on its id).
  const shortFor = (n: number) => {
    const owner = tasks.find((t) => t.number === n)?.project
    const platform = projects.find((p) => p.name === owner)?.platform?.id
    return (id: string): string => (platform ? revisionShort(platform, id) : id.slice(0, 7))
  }
  return (
    <div
      className={cx('progress-lane', l.state, r?.movable && 'movable', r?.dragging && 'dragging', r?.dropBefore && 'drop-before', r?.dropAfter && 'drop-after')}
      data-lane={l.id}
      // A running lane is focusable, to move it with Alt+Up and Alt+Down (#568).
      {...(r
        ? {
            role: 'group',
            'aria-label': [`${pair}${l.name ? `, ${l.name}` : ''}`, project?.name, word, why, oldRules && tr(OLD_RULES)].filter(Boolean).join(', '),
            'aria-keyshortcuts': r.movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
            tabIndex: 0,
            draggable: r.movable,
            onDragStart: r.onDragStart,
            onDragEnd: r.onDragEnd,
            onDragOver: r.onDragOver,
            onDrop: r.onDrop,
            onKeyDown: r.onKeyDown,
            onContextMenu: r.onContextMenu
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
          <span className="progress-lane-pair">{pair}</span>
          {/* Its slot (#1446): "· slot-b", or its builder's carried slot ("· hb2"), linking to the slots in Branches & remotes. */}
          {l.slot && !l.frozen && project && (
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
          {why && waitsOn(l.status) && project ? (
            // What it waits for, a click away (#1446): the slots in Branches & remotes, or the runs it waits on.
            <button
              type="button"
              className={cx('link', 'progress-lane-why', l.state === 'paused' && 'paused')}
              data-action="lane-waits"
              title={tr(WAITS_LINK, { why })}
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
          {stalled && (
            <Tooltip content={`${cardLabelOf({ tasks }, stalled.n)}: ${stalled.why}`}>
              <span className="progress-lane-state stalled">{tr(msg({ id: 'board.lanes.stalled', defaultMessage: 'stalled', description: "A lane's mark in its header (Progress panel), lower case: one of its cards is stalled (nobody is working on it); its tooltip says why." }))}</span>
            </Tooltip>
          )}
          {oldRules && (
            <Tooltip content={oldRules} focus>
              <span className="progress-lane-state old-rules" data-mark="old-rules" tabIndex={0} role="note" aria-label={oldRules}>
                {tr(OLD_RULES)}
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
      <div className="lane-bar" role="list" aria-label={unknown ? tr(msg({ id: 'board.lanes.barUnrecorded', defaultMessage: '{pair}: {total, plural, one {# card} other {# cards}}, not recorded', description: "Accessible name of a lane's bar (Progress panel) when the lane ended before Hive recorded where its cards were: the builder / reviewer ({pair}) and how many cards." }), { pair, total }) : tr(msg({ id: 'board.lanes.bar', defaultMessage: '{pair}: {finished} of {total, plural, one {# card} other {# cards}} finished', description: "Accessible name of a lane's bar (Progress panel): the builder / reviewer ({pair}), and how many of its cards are finished (passed or done)." }), { pair, finished, total })}>
        {segments.map((s) => (
          <Segment key={s.kind === 'card' ? s.number : `${s.kind}-${s.numbers[0]}`} segment={s} work={s.kind === 'card' ? laneSegmentWork(l, badges.get(s.number), s, shortFor(s.number), tr, OVERRIDE_NAMES) : []} marks={s.kind === 'card' ? segmentMarks(l, badges.get(s.number), s, shortFor(s.number), tr, OVERRIDE_NAMES, enforced) : {}} folded={s.kind === 'card' ? null : foldedMarks(l, badges, cards, s.numbers, shortFor, tr, OVERRIDE_NAMES, enforced)} />
        ))}
      </div>
    </div>
  )
}

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
