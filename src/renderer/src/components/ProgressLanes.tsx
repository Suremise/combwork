import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampScroll, edgeSpeed, frameStep } from '@shared/edgeScroll'
import { RUNS_KEEP_PX, draggedLaneRows, droppedLaneOrder, fitSegments, frozenSegment, keyedLaneRows, laneCards, laneRowsNow, laneRunning, laneSummary, mergedLaneOrder, nudgedLaneOrder, segmentName, segmentsThatFit, laneSegmentWork, type LaneSegment } from '@shared/laneBar'
import { revisionShort } from '@shared/platform/descriptors'
import type { WorkBadge } from '@shared/workflow/workView'
import { useWorkBadges } from '../cardWork'
import { fmt, msg, tr } from '@shared/i18n'
import { call } from '../api'
import { NO_PROJECTS, cardLabelOf, get, set, useLanguage, useStore } from '../store'
import { saveLaneOrder, useLaneOrder, type Lane } from '../laneSource'
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

const lanePair = (l: Lane): string => (l.reviewer ? `${l.builder.name} / ${l.reviewer.name}` : l.builder.name)

/** `lanes`: the lanes shown (the panel's filter applied); `all`: the workspace's, in the same order, to keep a move's order whole. */
export function LanesSection({ lanes, all, width }: { lanes: Lane[]; all: Lane[]; width: number }) {
  useLanguage()
  const ws = useStore((s) => s.workspace?.path ?? null)
  // What each live card's facts say (#1225), once for every lane: read again whenever the board is.
  const badges = useWorkBadges()
  const [folded, toggle] = usePanelFold(ws ? foldKey(ws) : null)
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
      { label: tr(msg({ id: 'board.lanes.usualOrder', defaultMessage: 'Usual Order', description: "A lane's context menu item in the Progress panel: puts the lanes back in their usual order, undoing the user's own." })), icon: 'list-ordered', detail: tr(msg({ id: 'board.lanes.usualOrderDetail', defaultMessage: 'Running lanes newest first, paused ones after them', description: 'Under Usual Order in a lane\'s context menu (Progress panel): what the usual order is.' })), disabled: !custom, onClick: usual }
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
    const body = el?.closest('.progress-panel')?.querySelector<HTMLElement>('.progress-body')
    if (!open || !el || !body) return
    const row = el.querySelector<HTMLElement>('.progress-lane')
    const measure = (): void => {
      if (row) {
        const h = row.getBoundingClientRect().height + parseFloat(getComputedStyle(row).marginBottom || '0')
        if (h > 0) setPitch((was) => (Math.abs(was - h) < 0.1 ? was : h))
      }
      const r = el.clientHeight + body.getBoundingClientRect().height - RUNS_KEEP_PX
      setRoom((was) => (was !== null && Math.abs(was - r) < 1 ? was : r))
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    watch.observe(body)
    if (row) watch.observe(row)
    return () => watch.disconnect()
  }, [open, lanes, width])
  if (!lanes.length) return null
  const { chosen, shown, max } = laneRowsNow(kept, lanes.length, room, pitch, fallback)
  return (
    <div className={cx('progress-lanes', folded && 'folded')} role="region" aria-label={tr(LANES)}>
      {!folded && key && <LanesEdge rowsKey={key} chosen={chosen} shown={shown} max={max} count={lanes.length} pitch={pitch} fallback={fallback} />}
      <button type="button" className="progress-lanes-bar" aria-expanded={!folded} onClick={toggle} title={folded ? tr(msg({ id: 'board.lanes.show', defaultMessage: 'Show the lanes', description: "Tooltip of the Progress panel's Lanes bar when the lanes are folded away." })) : tr(msg({ id: 'board.lanes.fold', defaultMessage: 'Fold the lanes', description: "Tooltip of the Progress panel's Lanes bar: folds the lanes down to the bar." }))}>
        <Icon name={folded ? 'chevron-up' : 'chevron-down'} />
        <span>{tr(LANES)}</span>
        <span className="progress-lanes-count">{lanes.length}</span>
      </button>
      {!folded && (
        // Whole lanes, the next one's top at the bottom edge; all of them, with the list's padding, when they fit.
        <div className="progress-lanes-list" ref={list} style={shown < lanes.length ? { maxHeight: shown * pitch } : undefined} onDragOver={overList}>
          {lanes.map((l) => (
            <LaneRow key={l.id} lane={l} max={segmentsThatFit(width - BAR_INSET_PX)} reorder={reorder(l)} badges={badges} />
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

const LANES = msg({ id: 'board.lanes.title', defaultMessage: 'Lanes', description: "The Progress panel's section of lanes (a builder and its reviewer working through cards in turn): its bar's label and accessible name." })

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

function LaneRow({ lane: l, max, reorder: r, badges }: { lane: Lane; max: number; reorder: LaneReorder | null; badges: Map<number, WorkBadge> }) {
  const tasks = useStore((s) => s.tasks)
  const projects = useStore((s) => s.workspace?.projects ?? NO_PROJECTS)
  // Read again each minute: a card waiting in Review becomes stalled with time (#521).
  useNow(60_000)
  const cards = l.frozen ? l.frozen.map((c) => frozenSegment(c, tr, cardLabelOf({ tasks }, c.number))) : laneCards(l.cards, tasks, tr)
  let stalled: { n: number; why: string } | null = null
  for (const n of l.frozen ? [] : l.cards) {
    const c = tasks.find((t) => t.number === n)
    const why = c ? cardStalled(projects, c) : null
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
  const word = stateWord(l.state)
  // Its cost on the hover of its top line (#602), read when the hover first shows.
  const cost = useLaneCost(l.id)
  // A card's revisions as its project's platform shows them (its descriptor, never a switch on its id).
  const shortFor = (n: number) => {
    const project = tasks.find((t) => t.number === n)?.project
    const platform = projects.find((p) => p.name === project)?.platform?.id
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
            'aria-label': `${pair}${l.name ? `, ${l.name}` : ''}`,
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
      <Tooltip block content={<LaneCostTip cost={cost.cost} />}>
        <div className="progress-lane-top" onMouseEnter={cost.load}>
          <span className="progress-lane-pair">{pair}</span>
          {l.name && <span className="progress-lane-name faint">· {l.name}</span>}
          <div className="grow" />
          {word && <span className={cx('progress-lane-state', l.state)}>{word}</span>}
          {stalled && (
            <Tooltip content={`${cardLabelOf({ tasks }, stalled.n)}: ${stalled.why}`}>
              <span className="progress-lane-state stalled">{tr(msg({ id: 'board.lanes.stalled', defaultMessage: 'stalled', description: "A lane's mark in its header (Progress panel), lower case: one of its cards is stalled (nobody is working on it); its tooltip says why." }))}</span>
            </Tooltip>
          )}
          {current !== null && !l.frozen && <span className="progress-lane-current">{cardLabelOf({ tasks }, current)}</span>}
          <span className="progress-lane-count faint">
            {unknown ? '–' : finished}/{total}
          </span>
        </div>
      </Tooltip>
      <div className="lane-bar" role="list" aria-label={unknown ? tr(msg({ id: 'board.lanes.barUnrecorded', defaultMessage: '{pair}: {total, plural, one {# card} other {# cards}}, not recorded', description: "Accessible name of a lane's bar (Progress panel) when the lane ended before Hive recorded where its cards were: the builder / reviewer ({pair}) and how many cards." }), { pair, total }) : tr(msg({ id: 'board.lanes.bar', defaultMessage: '{pair}: {finished} of {total, plural, one {# card} other {# cards}} finished', description: "Accessible name of a lane's bar (Progress panel): the builder / reviewer ({pair}), and how many of its cards are finished (passed or done)." }), { pair, finished, total })}>
        {segments.map((s) => (
          <Segment key={s.kind === 'card' ? s.number : `${s.kind}-${s.numbers[0]}`} segment={s} work={s.kind === 'card' ? laneSegmentWork(l, badges.get(s.number), s, shortFor(s.number), tr) : []} />
        ))}
      </div>
    </div>
  )
}

/**
 * One segment: a card (a click opens it), or the finished cards folded together, or the rest of a long lane. `work`:
 * what its facts say (#1225), a few lines in its hover after its label and notes, with a click for the rest.
 */
function Segment({ segment: s, work }: { segment: LaneSegment; work: string[] }) {
  if (s.kind !== 'card')
    return (
      <Tooltip content={s.label} focus>
        <span role="listitem" tabIndex={0} className={cx('lane-seg', s.kind)} aria-label={s.label}>
          {s.kind === 'finished' ? `✓ ${s.numbers.length}` : `+${s.numbers.length}`}
        </span>
      </Tooltip>
    )
  // What its red underline or hatching means (#706), a line each under the card's own.
  const tip =
    s.notes.length || work.length ? (
      <div className="lane-seg-tip">
        <div>{s.label}</div>
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
      <button type="button" role="listitem" className={cx('lane-seg', s.state, s.failed && 'failed')} data-card={s.number} aria-label={segmentName(s)} onClick={() => set({ taskOpen: s.number })} />
    </Tooltip>
  )
}
