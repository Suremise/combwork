import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ACTIVITY_HOURS, ACTIVITY_RANGES, buildActivityTree, filetimeMs, keepGone, newOrder, stableRows, type ActivityAgent, type ActivityCard, type ActivityDetail, type ActivityNode, type ActivityNow, type ActivityRow, type ActivityState, type ActivityTurns } from '@shared/activity'
import { agentState } from '@shared/agentState'
import { cardLabel } from '@shared/projectKeys'
import type { ProjectInfo, SessionListItem } from '@shared/types'
import { call, errorMessage } from '../api'
import * as actions from '../actions'
import { confirm, notify, openInSessionsTab, revealAgent, set, useStore } from '../store'
import { Icon, IconButton, statusText, useContextMenu, type MenuEntry } from '../components/ui'
import { loadActivityView, saveActivityView, type ActivityView } from '../activityView'
import { cx } from '../util'
import { boundedQueue, latestOnly } from '@shared/coalesce'
import { fmt, msg, tr } from '@shared/i18n'

/** How often what runs now is read, and live changes are drawn, while the tab is shown (#1254: batched, about once a second). */
const TICK_MS = 1000
/** The session list read again every this many ticks (and when an agent starts or stops). */
const LIST_EVERY = 5
/** Sessions whose turns are read at once. */
const TURNS_AT_ONCE = 4
/** The tree's geometry: a column per depth, a row per node shown. */
const COL = 256
const NODE_W = 224
const ROW = 46
const NODE_H = 36
/** Rows drawn beyond the visible ones, so scrolling doesn't show gaps. */
const OVERSCAN = 12

/** Each project's session list as last read here: the tab opens on it at once and draws the fresh one when it comes. */
const lastLists = new Map<string, SessionListItem[]>()
const NO_NOW: ActivityNow = { launches: [], tasks: [] }
/** How long after the pointer leaves the tree, or a scroll ends, it goes live again (HI-1677). */
const RESUME_MS = 1500

/**
 * Render times of the tab (ms, from its render to its layout effect), the latest last: the Activity tab's measurement
 * (#1254, a live update under one frame) reads them from a test copy's window.
 */
const renders: number[] = []
;(window as unknown as { __hiveActivityRenders?: number[] }).__hiveActivityRenders = renders

/** What the tree is drawn from: held as it was while the tab is paused (HI-1677). */
interface Reads {
  agents: ActivityAgent[]
  cards: ActivityCard[]
  list: SessionListItem[] | null
  turns: ReadonlyMap<string, ActivityTurns>
  now: ActivityNow
}

/**
 * A project's Activity tab (#1254): its live work as a tree running left to right, card → agent → session → turn → tool
 * call, with subagents and processes. Nothing drawn moves (HI-1677): new work comes after it, finished work dims where
 * it is, and what ended stays dimmed until a refresh. It pauses while the pointer is over the tree, while it scrolls
 * and while a node is selected, or by hand, keeping what comes meanwhile for the pill. Nothing is read or drawn while it
 * is hidden; live changes are taken in about once a second.
 */
export function ActivityTab({ project }: { project: ProjectInfo }) {
  const renderStart = performance.now()
  useLayoutEffect(() => {
    if (renders.push(performance.now() - renderStart) > 200) renders.shift()
  })
  const shown = useStore((s) => s.activity === 'projects' && s.selectedProject === project.path)
  const visible = usePageVisible()
  const active = shown && visible
  // The view (range, filters, paused by hand): the store's, else as this window last left it.
  const stored = useStore((s) => s.activityFilters[project.path])
  const [loaded] = useState(() => stored ?? loadActivityView(project.path))
  const view = stored ?? loaded
  const setView = useCallback(
    (patch: Partial<ActivityView>): void =>
      set((s) => {
        const next = { ...(s.activityFilters[project.path] ?? loaded), ...patch }
        saveActivityView(project.path, next)
        return { activityFilters: { ...s.activityFilters, [project.path]: next } }
      }),
    [project.path, loaded]
  )
  const [list, setList] = useState<SessionListItem[] | null>(() => lastLists.get(project.path) ?? null)
  const [listError, setListError] = useState<string | null>(null)
  const tasks = useStore((s) => s.tasks)
  const [now, setNow] = useState<ActivityNow>(NO_NOW)
  // The first read of what runs now is in: the tree is whole enough to hold (a tab opened paused holds only then).
  const [nowRead, setNowRead] = useState(false)
  const [turns, setTurns] = useState<ReadonlyMap<string, ActivityTurns>>(new Map())
  // Nodes opened or closed against their default, sessions' groups showing all, the node whose details show.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  // Expand All and Collapse All set every node's default, those that come later (a session's turns read once open) too.
  const [mode, setMode] = useState<OpenMode>('default')
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  // The agents as last taken in: live state changes often, the tree follows once a tick, and only when it changed.
  const [tick, setTick] = useState(0)
  const agentsRef = useRef(project.agents)
  agentsRef.current = project.agents
  // Sessions shown open, as last drawn: the tick reads the running ones' turns again.
  const openRef = useRef<{ id: string; live: boolean }[]>([])
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  // Turns read a few sessions at a time (Expand All can open many), the session list's newest read only; both for while
  // the tab is shown (#1254 round 3): hidden or gone, what waits is dropped and what still runs applies nothing.
  const turnReads = useRef(boundedQueue(TURNS_AT_ONCE))
  const listReads = useRef(latestOnly())
  const readTurns = useCallback(
    (ids: string[]): void => {
      for (const id of ids)
        turnReads.current.add(
          id,
          () => call('activity:turns', project.path, id, turnsRef.current.get(id)?.version).catch(() => null),
          (t) => t && setTurns((m) => new Map(m).set(id, t))
        )
    },
    [project.path]
  )
  const readList = useCallback(() => {
    listReads.current.run(
      call('activity:sessions', project.path, ACTIVITY_HOURS),
      (l) => {
        lastLists.set(project.path, l)
        setList(l)
        setListError(null)
      },
      (e) => setListError(errorMessage(e))
    )
  }, [project.path])

  useEffect(() => {
    if (!active) return
    let stop = false
    const turnQueue = turnReads.current
    const listQueue = listReads.current
    let lastNow = ''
    let lastLive = ''
    let ticks = 0
    readList()
    const read = (): void => {
      void call('activity:now', project.path)
        .then((n) => {
          const key = JSON.stringify(n)
          if (stop || key === lastNow) return
          lastNow = key
          setNow(n)
          setNowRead(true)
        })
        .catch(() => undefined)
      const live = agentsRef.current.map((a) => (a.live ? `${a.id}:${a.live.sessionId}:${a.live.status}:${statusText(a.live)}` : a.id)).join('|')
      const changed = live !== lastLive
      if (changed) {
        lastLive = live
        setTick((t) => t + 1)
      }
      // The session list again when an agent started or stopped, and every few seconds (a card moved, a session renamed).
      if ((changed && ticks > 0) || ++ticks % LIST_EVERY === 0) readList()
      // Running sessions shown open: their turns again, only when their transcript changed (null back otherwise).
      readTurns(openRef.current.filter((x) => x.live).map((x) => x.id))
    }
    read()
    const t = setInterval(read, TICK_MS)
    return () => {
      stop = true
      clearInterval(t)
      // Hidden, gone or another project: nothing more is read for this showing, and nothing read late is applied.
      turnQueue.cancel()
      listQueue.cancel()
    }
  }, [active, project.path, readTurns, readList])

  const agents = useMemo<ActivityAgent[]>(
    () =>
      agentsRef.current.map((a) => {
        const live = a.live
        if (!live) return { id: a.id, name: a.name, live: null }
        const state = agentState(live)
        return { id: a.id, name: a.name, live: { sessionId: live.sessionId, sessionName: live.sessionName, startedAt: live.startedAt, status: live.status, text: statusText(live), working: state === 'working', waiting: state === 'waiting', failed: state === 'stalled' } }
      }),
    // Taken in at a tick that saw them change, and when an agent is added or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, project.agents.length]
  )
  const cards = useMemo<ActivityCard[]>(
    () =>
      tasks
        .filter((c) => !c.archived && c.project.toLowerCase() === project.name.toLowerCase())
        .map((c) => ({ number: c.number, label: cardLabel(c), title: c.title, column: c.column, agents: [c.agent, c.review?.agent].filter((x): x is string => !!x) })),
    [tasks, project.name]
  )
  const reads = useMemo<Reads>(() => ({ agents, cards, list, turns, now }), [agents, cards, list, turns, now])

  // --- Pause (HI-1677): by hand, or while the pointer is over the tree, while it scrolls, while a node is selected.
  const [hovering, setHovering] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const pausedBy = view.paused ? 'hand' : hovering || scrolling || selected ? 'auto' : null
  // What the tree is drawn from while paused, and how many reads came since (each one an update the pill applies).
  const [held, setHeld] = useState<Reads | null>(null)
  const [pending, setPending] = useState(0)
  // When the range is measured from: the last refresh, so nothing ages out while it is looked at.
  const [asOf, setAsOf] = useState(() => Date.now())
  // Bumped by a refresh: what ended is dropped then.
  const [fresh, setFresh] = useState(0)
  const refresh = useCallback((): void => {
    setHeld((h) => (h ? reads : null))
    setPending(0)
    setAsOf(Date.now())
    setFresh((n) => n + 1)
  }, [reads])
  const ready = !!list && nowRead
  useEffect(() => {
    if (pausedBy && !held && ready) setHeld(reads)
    if (!pausedBy && held) {
      setHeld(null)
      setPending(0)
    }
    // Only a pause or resume (or the first whole read, opened paused): newer reads while paused are counted below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausedBy, ready])
  // A filter changed is the user's own doing: the tree is drawn afresh for it, not with what it hides kept as ended.
  const filterKey = JSON.stringify([view.agents ?? [], view.cards ?? [], !!view.hideFinished])
  const lastFilter = useRef(filterKey)
  useEffect(() => {
    if (lastFilter.current === filterKey) return
    lastFilter.current = filterKey
    setFresh((n) => n + 1)
  }, [filterKey])
  const lastReads = useRef(reads)
  useEffect(() => {
    const was = lastReads.current
    lastReads.current = reads
    if (!held || was === reads) return
    // A session opened while paused shows its turns (asked for): their first read isn't an update to hold.
    const onlyFirstTurns = was.agents === reads.agents && was.cards === reads.cards && was.list === reads.list && was.now === reads.now && [...reads.turns].every(([id, t]) => was.turns.get(id) === t || !held.turns.has(id))
    if (!onlyFirstTurns) setPending((n) => n + 1)
  }, [reads, held])
  const drawn = useMemo<Reads>(() => {
    if (!held) return reads
    const extra = [...reads.turns].filter(([id]) => !held.turns.has(id))
    return extra.length ? { ...held, turns: new Map([...held.turns, ...extra]) } : held
  }, [held, reads])

  const tree = useMemo(() => buildActivityTree({ agents: drawn.agents, cards: drawn.cards, sessions: drawn.list ?? [], turns: drawn.turns, now: drawn.now, at: Date.now(), rangeFrom: asOf, filter: view, showAll }), [drawn, asOf, view, showAll])
  // What ended stays dimmed where it was until a refresh; the rows go by when each node was first drawn.
  const keptRef = useRef<{ fresh: number; tree: ActivityNode[] }>({ fresh: -1, tree: [] })
  const kept = useMemo(() => {
    const t = keepGone(keptRef.current.fresh === fresh ? keptRef.current.tree : [], tree)
    keptRef.current = { fresh, tree: t }
    return t
  }, [tree, fresh])
  // When each node was first drawn, since the last refresh: a refresh draws the tree compact again, children back under
  // their parents, so the long elbows from new work under older parents last only while it is live.
  const order = useRef({ fresh, order: newOrder() })
  if (order.current.fresh !== fresh) order.current = { fresh, order: newOrder() }

  const isOpen = useCallback((n: ActivityNode): boolean => toggled.has(n.key) !== openIn(mode, n), [toggled, mode])
  const rows = useMemo(() => stableRows(kept, isOpen, order.current.order), [kept, isOpen])

  // The turns of each session shown open: read when it opens (the tick reads running ones again).
  const openSessions = useMemo(() => rows.flatMap((r) => (r.node.kind === 'session' && !r.node.gone && isOpen(r.node) ? [{ id: r.node.session.id, live: r.node.live }] : [])), [rows, isOpen])
  openRef.current = openSessions
  const unread = openSessions.filter((x) => !turns.has(x.id)).map((x) => x.id).join(',')
  useEffect(() => {
    if (active && unread) readTurns(unread.split(','))
  }, [active, unread, readTurns])

  const toggle = (key: string): void =>
    setToggled((t) => {
      const next = new Set(t)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // The pointer over the tree pauses it; leaving, it goes live again a moment later. So does a scroll.
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current)
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
    },
    []
  )
  const onEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setHovering(true)
  }, [])
  const onLeave = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setHovering(false), RESUME_MS)
  }, [])
  const onScroll = useCallback(() => {
    setScrolling(true)
    if (scrollTimer.current) clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => setScrolling(false), RESUME_MS)
  }, [])

  const byKey = useMemo(() => new Map(rows.map((r) => [r.node.key, r.node])), [rows])
  const chosen = selected ? (byKey.get(selected) ?? null) : null
  const filtered = !!view.agents?.length || !!view.cards?.length || !!view.hideFinished
  const range = view.range ?? '24h'

  // The Agents ▾ and Cards ▾ menus: several can be ticked; a click ticks one and the menu stays open.
  const menu = useContextMenu()
  const agentChoices = useMemo(() => [...new Map([...project.agents.map((a) => [a.id, a.name] as const), ...(list ?? []).flatMap((s) => (s.agentId ? [[s.agentId, s.agentName ?? s.agentId] as const] : []))]).entries()], [project.agents, list])
  const openPick = (e: React.MouseEvent<HTMLElement>, what: 'agents' | 'cards'): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const show = (picked: readonly (string | number)[]): void => {
      const choices: [string | number, string][] = what === 'agents' ? agentChoices : cards.map((c) => [c.number, `${c.label} ${c.title}`])
      const items: MenuEntry[] = [
        { label: tr(M.all), icon: picked.length ? undefined : 'check', onClick: () => pick([]) },
        { separator: true },
        ...choices.map(([id, label]): MenuEntry => ({ label, icon: picked.includes(id) ? 'check' : undefined, onClick: () => pick(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) }))
      ]
      menu.openAt(r.left, r.bottom + 2, items)
    }
    const pick = (next: readonly (string | number)[]): void => {
      setView(what === 'agents' ? { agents: next as string[] } : { cards: next as number[] })
      show(next)
    }
    show(what === 'agents' ? (view.agents ?? []) : (view.cards ?? []))
  }

  // Until the session list comes (the first open of a project), the tree has the running agents' sessions and the cards.
  const reading = !list && !listError
  return (
    <div className="activity-tab">
      <div className="activity-main">
        <div className="activity-head">
          <span className="pane-header-title">{tr(M.heading)}</span>
          <div className="segmented activity-range" role="group" aria-label={tr(M.rangeLabel)}>
            {ACTIVITY_RANGES.map((r) => (
              <button
                key={r}
                className={cx(r === range && 'active')}
                aria-pressed={r === range}
                onClick={() => {
                  setView({ range: r })
                  refresh()
                }}
              >
                {tr(M.range, { range: r })}
              </button>
            ))}
          </div>
          <button className={cx('btn small subtle activity-pick', !!view.agents?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'agents')}>
            {tr(M.agents, { n: view.agents?.length ?? 0 })} <Icon name="chevron-down" />
          </button>
          <button className={cx('btn small subtle activity-pick', !!view.cards?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'cards')}>
            {tr(M.cards, { n: view.cards?.length ?? 0 })} <Icon name="chevron-down" />
          </button>
          <label className="flex muted activity-hide">
            <input type="checkbox" className="checkbox" checked={!!view.hideFinished} onChange={(e) => setView({ hideFinished: e.target.checked })} /> {tr(M.hideFinished)}
          </label>
          {reading && (
            <span className="faint">
              <Icon name="loading" spin /> {tr(M.reading)}
            </span>
          )}
          {!list && listError && <span className="error-text">{tr(M.loadFailed, { error: listError })}</span>}
          <div className="actions">
            {pausedBy && pending > 0 && (
              <button className="chip activity-pill" onClick={refresh} title={tr(M.pillTip)}>
                <Icon name="refresh" /> {tr(M.pill, { n: pending })}
              </button>
            )}
            {pausedBy === 'auto' && !pending && <span className="faint activity-paused">{tr(M.pausedAuto)}</span>}
            <button className={cx('btn small subtle activity-live', pausedBy === 'hand' && 'on') /* i18n-ignore: class names */} aria-pressed={pausedBy === 'hand'} title={tr(view.paused ? M.liveTip : M.pauseTip)} onClick={() => setView({ paused: !view.paused })}>
              <Icon name={view.paused ? 'debug-continue' : 'debug-pause'} /> {tr(view.paused ? M.live : M.pause)}
            </button>
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={refresh} />
            <IconButton
              icon="expand-all"
              title={tr(M.expandAll)}
              onClick={() => {
                setMode('all')
                setToggled(new Set())
              }}
            />
            <IconButton
              icon="collapse-all"
              title={tr(M.collapseAll)}
              onClick={() => {
                setMode('none')
                setToggled(new Set())
              }}
            />
          </div>
        </div>
        {kept.length === 0 && !reading ? (
          <div className="pane-empty">{tr(filtered || range !== '24h' ? M.emptyFiltered : M.empty)}</div>
        ) : (
          <TreeView rows={rows} selected={selected} isOpen={isOpen} onSelect={setSelected} onToggle={toggle} onMore={(key) => setShowAll((s) => new Set(s).add(key.replace(/^more:/, '')))} onEnter={onEnter} onLeave={onLeave} onScroll={onScroll} />
        )}
      </div>
      {chosen && <Details project={project} node={chosen} onClose={() => setSelected(null)} />}
      {menu.element}
    </div>
  )
}

/** Whether a node can open: it has children, or it is a session whose turns can be read (not read yet). */
const expandable = (n: ActivityNode): boolean => n.children.length > 0 || (n.kind === 'session' && !n.turnsLoaded && (!!n.session.hasTranscript || !!n.session.hasBackup))

/** The tree's open state before a node's own toggle: as it starts, all open (Expand All), or all closed (Collapse All). */
type OpenMode = 'default' | 'all' | 'none'
const openIn = (mode: OpenMode, n: ActivityNode): boolean => (mode === 'all' ? expandable(n) : mode === 'none' ? false : openByDefault(n))

/** Whether a node starts open: cards and agents, and running sessions; turns, tool calls and the rest start closed. */
function openByDefault(n: ActivityNode): boolean {
  if (n.kind === 'card' || n.kind === 'agent') return true
  if (n.kind === 'session') return n.live
  return false
}

/** The tree drawn: rows in view (and a few more) as nodes, each joined to its parent by an elbow. */
function TreeView({ rows, selected, isOpen, onSelect, onToggle, onMore, onEnter, onLeave, onScroll }: { rows: ActivityRow[]; selected: string | null; isOpen: (n: ActivityNode) => boolean; onSelect: (key: string) => void; onToggle: (key: string) => void; onMore: (key: string) => void; onEnter: () => void; onLeave: () => void; onScroll: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 800 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setView({ top: el.scrollTop, height: el.clientHeight })
    const scrolled = (): void => {
      update()
      onScroll()
    }
    update()
    el.addEventListener('scroll', scrolled, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', scrolled)
      ro.disconnect()
    }
  }, [onScroll])
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN)
  const depth = rows.reduce((m, r) => Math.max(m, r.depth), 0)
  const width = (depth + 1) * COL
  const height = rows.length * ROW
  const lines: string[] = []
  for (let i = first; i < last; i++) {
    const r = rows[i]
    if (r.parent < 0) continue
    const x0 = rows[r.parent].depth * COL + NODE_W
    const y0 = r.parent * ROW + NODE_H / 2
    const x1 = r.depth * COL
    const y1 = i * ROW + NODE_H / 2
    const mid = x0 + (x1 - x0) / 2
    lines.push(`M${x0} ${y0}H${mid}V${y1}H${x1}`) // i18n-ignore: an SVG path's commands
  }
  // A parent above the drawn rows still joins its first drawn child: its line is drawn from where it is.
  return (
    <div className="activity-tree" ref={ref} role="tree" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="activity-canvas" style={{ width, height }}>
        <svg className="activity-lines" width={width} height={height} aria-hidden>
          <path d={lines.join('')} />
        </svg>
        {rows.slice(first, last).map((r, i) => (
          <NodeBox key={r.node.key} node={r.node} parent={r.parent >= 0 ? rows[r.parent].node.key : undefined} x={r.depth * COL} y={(first + i) * ROW} open={isOpen(r.node)} selected={selected === r.node.key} onSelect={onSelect} onToggle={onToggle} onMore={onMore} />
        ))}
      </div>
    </div>
  )
}

const NodeBox = memo(function NodeBox({ node, parent, x, y, open, selected, onSelect, onToggle, onMore }: { node: ActivityNode; parent?: string; x: number; y: number; open: boolean; selected: boolean; onSelect: (key: string) => void; onToggle: (key: string) => void; onMore: (key: string) => void }) {
  const { icon, title, sub: line, state } = describe(node)
  const sub = node.gone ? tr(M.endedNode) : line
  const more = node.kind === 'more'
  return (
    <div
      className={cx('activity-node', `act-${node.kind}`, state && `act-${state}`, node.gone && 'act-gone', selected && 'selected')}
      style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
      role="treeitem"
      aria-expanded={expandable(node) ? open : undefined}
      aria-selected={selected}
      tabIndex={0}
      data-key={node.key}
      data-parent={parent}
      // Focused where it is: the browser's own focus would scroll the tree sideways to show all of a deep node.
      onMouseDown={(e) => {
        e.preventDefault()
        e.currentTarget.focus({ preventScroll: true })
      }}
      onClick={() => (more ? onMore(node.key) : onSelect(node.key))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (more) onMore(node.key)
          else onSelect(node.key)
        } else if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
          if (expandable(node)) onToggle(node.key)
        }
      }}
    >
      {expandable(node) ? (
        <button
          className="activity-twisty"
          aria-label={tr(open ? M.collapse : M.expand)}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(node.key)
          }}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
      ) : (
        <span className="activity-twisty" />
      )}
      <Icon name={icon} />
      <div className="activity-node-text">
        <div className="activity-node-title">{title}</div>
        {sub && <div className="activity-node-sub faint">{sub}</div>}
      </div>
      {state === 'working' && <Icon name="loading" spin className="activity-spin" />}
    </div>
  )
})

/** A node's icon, title, second line and state, as drawn. */
function describe(n: ActivityNode): { icon: string; title: string; sub: string; state: ActivityState | null } {
  switch (n.kind) {
    case 'card':
      return { icon: 'project', title: `${n.label} ${n.title}`, sub: tr(M.column, { column: n.column }), state: null }
    case 'agent':
      return { icon: 'person', title: n.name, sub: n.line || tr(M.state, { state: n.state }), state: n.state }
    case 'session':
      return { icon: n.session.sub ? 'type-hierarchy-sub' : 'comment-discussion', title: n.session.title || n.session.name || n.session.id.slice(0, 8), sub: n.turnsLoaded ? tr(M.turns, { n: n.turnCount }) : fmtWhen(n.session.lastActivity ?? n.session.lastActiveAt), state: n.state }
    case 'more':
      return { icon: 'ellipsis', title: tr(M.more, { n: n.count }), sub: '', state: null }
    case 'turn':
      return { icon: 'comment', title: n.turn.prompt || tr(M.noPrompt), sub: tr(M.tools, { n: n.turn.tools.length }), state: n.state }
    case 'tool':
      return { icon: 'tools', title: n.tool.name, sub: n.tool.summary, state: n.state }
    case 'task':
      return { icon: 'run-all', title: n.task.description || tr(M.task, { type: n.task.type ?? 'other' }), sub: tr(M.task, { type: n.task.type ?? 'other' }), state: 'working' }
    case 'process':
      return { icon: n.cli ? 'terminal' : 'server-process', title: n.process.run ?? n.process.label, sub: tr(n.cli ? M.cliProcess : M.process, { pid: n.process.pid }), state: null }
  }
}

const fmtWhen = (iso: string | undefined | null): string => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? fmt.relative(t - Date.now()) : ''
}

/** The selected node's details: its status, its input exactly (masked like the log), its last action, and what can be done. */
function Details({ project, node, onClose }: { project: ProjectInfo; node: ActivityNode; onClose: () => void }) {
  const { title, state } = describe(node)
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A prompt's or a tool call's whole input, as written, masked: read for the node shown.
  const item = node.kind === 'tool' ? { sessionId: node.sessionId, itemId: node.tool.itemId } : node.kind === 'turn' ? { sessionId: node.sessionId, itemId: node.turn.itemId } : null
  const itemKey = item ? `${item.sessionId}:${item.itemId}` : null
  useEffect(() => {
    setDetail(null)
    setError(null)
    if (!item) return
    let stop = false
    call('activity:detail', project.path, item.sessionId, item.itemId)
      .then((d) => !stop && setDetail(d))
      .catch((e) => !stop && setError(errorMessage(e)))
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey, project.path])
  const rows: [string, string][] = []
  if (state) rows.push([tr(M.statusLabel), tr(M.state, { state })])
  let input: string | null = null
  let last: string | null = null
  const buttons: React.ReactNode[] = []
  switch (node.kind) {
    case 'card':
      rows.push([tr(M.columnLabel), node.column])
      buttons.push(
        <button key="open" className="btn small" onClick={() => set({ taskOpen: node.number })}>
          {tr(M.openCard)}
        </button>
      )
      break
    case 'agent':
      if (node.line) last = node.line
      buttons.push(
        <button key="show" className="btn small" onClick={() => revealAgent(project, node.agentId)}>
          {tr(M.showAgent)}
        </button>
      )
      break
    case 'session':
      rows.push([tr(M.lastActive), fmtWhen(node.session.lastActivity ?? node.session.lastActiveAt)])
      if (node.session.cards?.length) rows.push([tr(M.cardsLabel), fmt.list(node.session.cards.map((c) => `#${c.number}`))])
      buttons.push(
        <button key="open" className="btn small" onClick={() => openInSessionsTab(project.path, node.session.id)}>
          {tr(M.openSession)}
        </button>
      )
      break
    case 'turn':
      if (node.turn.at) rows.push([tr(M.started), fmtWhen(node.turn.at)])
      input = detail?.input ?? null
      last = node.turn.reply || node.turn.tools.at(-1)?.summary || null
      break
    case 'tool':
      if (node.tool.at) rows.push([tr(M.started), fmtWhen(node.tool.at)])
      input = detail?.input ?? null
      last = detail?.result ?? null
      break
    case 'task':
      rows.push([tr(M.started), fmt.relative(node.task.at - Date.now())])
      input = node.task.description ?? null
      break
    case 'process': {
      const started = filetimeMs(node.process.created)
      rows.push([tr(M.pidLabel), String(node.process.pid)])
      if (node.process.parent) rows.push([tr(M.parentLabel), String(node.process.parent)])
      if (started) rows.push([tr(M.started), fmt.relative(started - Date.now())])
      input = node.process.command ?? node.process.label
      if (!node.cli && node.process.created) buttons.push(<EndProcessButton key="end" project={project} agentId={node.agentId} pid={node.process.pid} created={node.process.created} label={node.process.label} />)
      break
    }
  }
  return (
    <aside className="activity-details" aria-label={tr(M.details)}>
      <div className="activity-details-head">
        <span className="activity-details-title">{title}</span>
        <div className="actions">
          <IconButton icon="close" title={tr(M.closeDetails)} onClick={onClose} />
        </div>
      </div>
      <div className="activity-details-body">
        <dl className="activity-facts">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {(input !== null || item) && (
          <>
            <div className="agent-dialog-h">{tr(M.input)}</div>
            {error ? <p className="error-text">{error}</p> : <pre className="activity-pre">{input ?? tr(M.loading)}</pre>}
          </>
        )}
        {last && (
          <>
            <div className="agent-dialog-h">{tr(M.lastAction)}</div>
            <pre className="activity-pre">{last}</pre>
          </>
        )}
        {buttons.length > 0 && <div className="activity-buttons">{buttons}</div>}
      </div>
    </aside>
  )
}

/** Ends one of the agent's own processes, after a confirmation; main checks it is still that agent's, that process. */
function EndProcessButton({ project, agentId, pid, created, label }: { project: ProjectInfo; agentId: string; pid: number; created: string; label: string }) {
  const end = async (): Promise<void> => {
    const ok = await confirm({ title: tr(M.endTitle), message: tr(M.endMessage, { label, pid }), detail: tr(M.endDetail), confirmLabel: tr(M.endButton), danger: true })
    if (!ok) return
    const r = await actions.attempt(tr(M.endFailed), () => call('activity:endProcess', project.path, agentId, pid, created))
    if (!r) return
    if (r === 'ended') notify('success', tr(M.ended, { label }))
    else notify('warning', tr(M.notEnded, { label, why: r }))
  }
  return (
    <button className="btn small danger" onClick={() => void end()}>
      {tr(M.endButton)}
    </button>
  )
}

/** Whether the window is shown (not minimised or hidden). */
function usePageVisible(): boolean {
  const [v, setV] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setV(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return v
}

const M = {
  heading: msg({ id: 'activity.heading', defaultMessage: 'Activity', description: "The Activity tab's heading: the project's live work as a tree." }),
  loading: msg({ id: 'activity.loading', defaultMessage: 'Loading…', description: 'The Activity tab, or a detail in it, while it loads.' }),
  reading: msg({ id: 'activity.reading', defaultMessage: 'Reading the sessions…', description: "Beside the Activity tab's heading while the project's sessions are read (the tree shows running agents meanwhile)." }),
  loadFailed: msg({ id: 'activity.loadFailed', defaultMessage: 'Could not load the activity: {error}', description: "The Activity tab when the project's sessions couldn't be read. {error} is the reason." }),
  empty: msg({ id: 'activity.empty', defaultMessage: 'Nothing ran in the last 24 hours. Start an agent to see its work here.', description: 'The Activity tab when no agent runs and no session was active in the last 24 hours.' }),
  emptyFiltered: msg({ id: 'activity.emptyFiltered', defaultMessage: 'Nothing for this filter in the last 24 hours.', description: 'The Activity tab, filtered to an agent or a card, when it has nothing to show.' }),
  rangeLabel: msg({ id: 'activity.rangeLabel', defaultMessage: 'Time range', description: "The Activity tab's time range buttons, for screen readers." }),
  range: msg({ id: 'activity.range', defaultMessage: '{range, select, live {Live} 15m {15 min} 1h {1 h} 6h {6 h} other {24 h}}', description: "A time range button above the Activity tree: Live (running work only), or what was active in the last 15 minutes, 1, 6 or 24 hours. Keep them short." }),
  agents: msg({ id: 'activity.agents', defaultMessage: '{n, plural, =0 {All agents} one {# agent} other {# agents}}', description: 'A menu button above the Activity tree: which agents it shows (several can be ticked); with none ticked, all.' }),
  cards: msg({ id: 'activity.cards', defaultMessage: '{n, plural, =0 {All cards} one {# card} other {# cards}}', description: 'A menu button above the Activity tree: which cards it shows (several can be ticked); with none ticked, all.' }),
  all: msg({ id: 'activity.all', defaultMessage: 'All', description: "The first entry of the Activity tab's Agents and Cards menus: no filter, everything." }),
  hideFinished: msg({ id: 'activity.hideFinished', defaultMessage: 'Hide finished', description: 'A checkbox above the Activity tree: shows only running work.' }),
  pause: msg({ id: 'activity.pause', defaultMessage: 'Pause', description: "A button above the Activity tree: holds it as it is (updates wait, counted in the pill) until Live." }),
  live: msg({ id: 'activity.live', defaultMessage: 'Live', description: 'A button above the Activity tree while it is paused by hand: shows updates as they come again.' }),
  pauseTip: msg({ id: 'activity.pauseTip', defaultMessage: 'Hold the tree as it is: updates wait until you refresh or go live. It also holds by itself while the pointer is over it, while it scrolls and while a node is selected.', description: "Tooltip of the Activity tab's Pause button." }),
  liveTip: msg({ id: 'activity.liveTip', defaultMessage: 'Show updates as they come again.', description: "Tooltip of the Activity tab's Live button (shown while paused by hand)." }),
  pill: msg({ id: 'activity.pill', defaultMessage: '{n, plural, one {# update · Refresh} other {# updates · Refresh}}', description: 'A pill above the Activity tree while it is paused: how many updates are waiting; clicking it shows them. Keep "Refresh" as the action.' }),
  pillTip: msg({ id: 'activity.pillTip', defaultMessage: 'Show the updates that came while it was paused. It stays paused if you paused it.', description: "Tooltip of the Activity tab's updates pill." }),
  pausedAuto: msg({ id: 'activity.pausedAuto', defaultMessage: 'Held while you look', description: 'Above the Activity tree while it holds by itself (the pointer over it, a scroll, a node selected) and no update is waiting yet.' }),
  refresh: msg({ id: 'activity.refresh', defaultMessage: 'Refresh', description: "Tooltip of the Activity tab's refresh button: shows what came since, drops what ended, and measures the time range from now." }),
  endedNode: msg({ id: 'activity.endedNode', defaultMessage: 'Ended · gone at the next refresh', description: "A node's second line in the Activity tree once its work ended or left the range: it stays in place, dimmed, until a refresh." }),
  expandAll: msg({ id: 'activity.expandAll', defaultMessage: 'Expand All', description: "Tooltip of the Activity tab's button that opens every node." }),
  collapseAll: msg({ id: 'activity.collapseAll', defaultMessage: 'Collapse All', description: "Tooltip of the Activity tab's button that closes every node." }),
  expand: msg({ id: 'activity.expand', defaultMessage: 'Expand', description: "A node's open button in the Activity tree (screen readers)." }),
  collapse: msg({ id: 'activity.collapse', defaultMessage: 'Collapse', description: "A node's close button in the Activity tree (screen readers)." }),
  column: msg({ id: 'activity.column', defaultMessage: '{column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A card node's second line in the Activity tree: its board column. Use the board's column names." }),
  state: msg({ id: 'activity.state', defaultMessage: '{state, select, working {Working} waiting {Waiting for you} failed {Failed or stalled} done {Done} other {Idle}}', description: 'A node\'s state in the Activity tree: working, waiting for you, failed (or stalled), done, idle.' }),
  turns: msg({ id: 'activity.turns', defaultMessage: '{n, plural, one {# turn} other {# turns}}', description: "A session node's second line in the Activity tree: how many turns (a prompt and what followed) it has." }),
  tools: msg({ id: 'activity.tools', defaultMessage: '{n, plural, =0 {No tool calls} one {# tool call} other {# tool calls}}', description: "A turn node's second line in the Activity tree: how many tool calls it made." }),
  noPrompt: msg({ id: 'activity.noPrompt', defaultMessage: '(no prompt text)', description: 'A turn node in the Activity tree whose prompt has no text (only images, say).' }),
  more: msg({ id: 'activity.more', defaultMessage: '{n, plural, one {# more session} other {# more sessions}}', description: 'A node in the Activity tree standing for older sessions not shown; clicking it shows them.' }),
  task: msg({ id: 'activity.task', defaultMessage: '{type, select, subagent {Background subagent} command {Background command} monitor {Monitor} workflow {Workflow} other {Background task}}', description: 'A background task node in the Activity tree: what kind it is.' }),
  process: msg({ id: 'activity.process', defaultMessage: 'Process {pid}', description: 'A process node\'s second line in the Activity tree. {pid} is its process id.' }),
  cliProcess: msg({ id: 'activity.cliProcess', defaultMessage: "The agent's CLI · process {pid}", description: "A process node in the Activity tree that is the agent's own CLI (or its terminal). {pid} is its process id." }),
  details: msg({ id: 'activity.details', defaultMessage: 'Details', description: "The Activity tab's details panel, for screen readers." }),
  closeDetails: msg({ id: 'activity.closeDetails', defaultMessage: 'Close details', description: "Tooltip of the button closing the Activity tab's details panel." }),
  statusLabel: msg({ id: 'activity.statusLabel', defaultMessage: 'Status', description: "A label in the Activity tab's details: the node's state." }),
  columnLabel: msg({ id: 'activity.columnLabel', defaultMessage: 'Column', description: "A label in the Activity tab's details: a card's board column." }),
  lastActive: msg({ id: 'activity.lastActive', defaultMessage: 'Last active', description: "A label in the Activity tab's details: when a session was last active." }),
  cardsLabel: msg({ id: 'activity.cardsLabel', defaultMessage: 'Cards', description: "A label in the Activity tab's details: the cards a session worked on." }),
  started: msg({ id: 'activity.started', defaultMessage: 'Started', description: "A label in the Activity tab's details: when a turn, tool call, task or process started." }),
  pidLabel: msg({ id: 'activity.pidLabel', defaultMessage: 'Process id', description: "A label in the Activity tab's details: a process's id." }),
  parentLabel: msg({ id: 'activity.parentLabel', defaultMessage: 'Started by process', description: "A label in the Activity tab's details: the id of the process that started this one." }),
  input: msg({ id: 'activity.input', defaultMessage: 'Input', description: "A heading in the Activity tab's details: the node's input exactly (a prompt, a tool call's input, a command line), with secrets masked." }),
  lastAction: msg({ id: 'activity.lastAction', defaultMessage: 'Last action', description: "A heading in the Activity tab's details: what the node did last (a reply, a tool call's result, an agent's status)." }),
  openCard: msg({ id: 'activity.openCard', defaultMessage: 'Open Card', description: "A button in the Activity tab's details: opens the card." }),
  showAgent: msg({ id: 'activity.showAgent', defaultMessage: 'Show Agent', description: "A button in the Activity tab's details: shows the agent's terminal." }),
  openSession: msg({ id: 'activity.openSession', defaultMessage: 'Open in Sessions Tab', description: "A button in the Activity tab's details: opens the session's transcript in the Sessions tab." }),
  endButton: msg({ id: 'activity.endButton', defaultMessage: 'End Process…', description: "A button in the Activity tab's details: ends this one process of the agent's, after a confirmation (…)." }),
  endTitle: msg({ id: 'activity.endTitle', defaultMessage: 'End this process?', description: 'Title of the confirmation before ending one of an agent\'s processes from the Activity tab.' }),
  endMessage: msg({ id: 'activity.endMessage', defaultMessage: 'End {label} (process {pid})?', description: 'The confirmation before ending one of an agent\'s processes. {label} is what it runs, {pid} its id.' }),
  endDetail: msg({ id: 'activity.endDetail', defaultMessage: 'Only this process ends, and only while it is still the one listed here. What it started keeps running, and the agent may see its command fail.', description: 'Detail of the confirmation before ending one of an agent\'s processes from the Activity tab.' }),
  endFailed: msg({ id: 'activity.endFailed', defaultMessage: 'Could not end the process', description: "An error's title: ending a process from the Activity tab failed." }),
  ended: msg({ id: 'activity.ended', defaultMessage: 'Ended {label}', description: 'A notification: the process ({label}: what it ran) was ended from the Activity tab.' }),
  notEnded: msg({ id: 'activity.notEnded', defaultMessage: '{why, select, notOwn {{label} is no longer one of this agent\'s processes: nothing was ended.} cli {{label} is the agent\'s CLI: use Stop to end it.} other {{label} could not be ended: it may still run.}}', description: "A notification after End Process in the Activity tab when it didn't end it: it had ended or isn't the agent's (notOwn), it is the agent's CLI (cli), or ending it failed. {label} is what it runs." })
}
