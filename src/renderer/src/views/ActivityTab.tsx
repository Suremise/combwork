import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ACTIVITY_HOURS, ACTIVITY_LEVELS, activityLevel, activityTabs, buildActivityTree, filetimeMs, goneKeys, keepGone, keysAtLevel, newOrder, pruneGone, stableRows, type ActivityAgent, type ActivityCard, type ActivityDetail, type ActivityInput, type ActivityLevel, type ActivityNode, type ActivityNow, type ActivityRow, type ActivityState, type ActivityTabInfo, type ActivityTurns } from '@shared/activity'
import { agentState, type AgentState } from '@shared/agentState'
import { cardLabel } from '@shared/projectKeys'
import { durationText } from '@shared/tasks'
import type { ProjectInfo, SessionListItem } from '@shared/types'
import { call, errorMessage } from '../api'
import * as actions from '../actions'
import { confirm, notify, openInSessionsTab, revealAgent, set, useStore } from '../store'
import { Icon, IconButton, statusText, useContextMenu, type MenuEntry } from '../components/ui'
import { StateMark } from '../components/StateMark'
import { loadActivityView, saveActivityView, zoomStep, ZOOM_MAX, ZOOM_MIN, type ActivityView } from '../activityView'
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
/** The tree's padding inside its scrolling box (both sides), left out when it is fitted. */
const TREE_PAD = 28
/** Live, how long what ended takes to fade out before it leaves (HI-1743); the CSS fade is as long. */
const FADE_MS = 1500

/** Each project's session list as last read here: the tab opens on it at once and draws the fresh one when it comes. */
const lastLists = new Map<string, SessionListItem[]>()
const NO_NOW: ActivityNow = { launches: [], tasks: [] }

/**
 * Render times of the tab (ms, from its render to its layout effect), the latest last: the Activity tab's measurement
 * (#1254, a live update under one frame) reads them from a test copy's window.
 */
const renders: number[] = []
;(window as unknown as { __hiveActivityRenders?: number[] }).__hiveActivityRenders = renders

/** What the tree is drawn from: held as it was while the tab is frozen (HI-1743). */
interface Reads {
  agents: ActivityAgent[]
  cards: ActivityCard[]
  list: SessionListItem[] | null
  turns: ReadonlyMap<string, ActivityTurns>
  now: ActivityNow
}

/** An activity state as an agent state mark: failed is stalled, done idle. */
const markOf = (s: ActivityState): AgentState => (s === 'failed' ? 'stalled' : s === 'done' ? 'idle' : s)

/**
 * A project's Activity tab (#1254, HI-1743): what runs now, a tab per running agent, each its current work (its card in
 * progress, else its session) as a tree running left to right: the latest turn and tool call, the background tasks,
 * subagents and processes. Nothing past: the card is the history. It opens frozen, a snapshot taken then: Refresh takes a
 * new one, Play goes live (what ended fades out, then leaves), Pause freezes again, and the reads since are counted in
 * the pill. Nothing is read or drawn while it is hidden; live changes are taken in about once a second.
 */
export function ActivityTab({ project }: { project: ProjectInfo }) {
  const renderStart = performance.now()
  useLayoutEffect(() => {
    if (renders.push(performance.now() - renderStart) > 200) renders.shift()
  })
  const shown = useStore((s) => s.activity === 'projects' && s.selectedProject === project.path)
  const visible = usePageVisible()
  const active = shown && visible
  // The view (filters, tab, zoom): the store's, else as this window last left it.
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
  // The first read of what runs now since the tab opened: the snapshot is taken once it is in.
  const [nowRead, setNowRead] = useState(false)
  const [turns, setTurns] = useState<ReadonlyMap<string, ActivityTurns>>(new Map())
  // Nodes opened or closed against their default, the node whose details show.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  // Expand All and Collapse All set every node's default.
  const [mode, setMode] = useState<OpenMode>('default')
  // Levels ▾ (HI-1678): a level folded or opened at once, before each of its nodes' own folds.
  const [levels, setLevels] = useState<ReadonlyMap<ActivityLevel, boolean>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  // Live (HI-1743): a choice, never the default; each opening is frozen.
  const [live, setLive] = useState(false)
  // The agents as last taken in: live state changes often, the tree follows once a tick, and only when it changed.
  const [tick, setTick] = useState(0)
  const agentsRef = useRef(project.agents)
  agentsRef.current = project.agents
  // Sessions in the tree, as last drawn: their turns are read, a running one's again each tick.
  const treeSessionsRef = useRef<{ id: string; live: boolean }[]>([])
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  // Turns read a few sessions at a time, the session list's newest read only; both for while the tab is shown (#1254
  // round 3): hidden or gone, what waits is dropped and what still runs applies nothing.
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
          setNowRead(true)
          const key = JSON.stringify(n)
          if (stop || key === lastNow) return
          lastNow = key
          setNow(n)
        })
        .catch(() => undefined)
      const liveNow = agentsRef.current.map((a) => (a.live ? `${a.id}:${a.live.sessionId}:${a.live.status}:${statusText(a.live)}` : a.id)).join('|')
      const changed = liveNow !== lastLive
      if (changed) {
        lastLive = liveNow
        setTick((t) => t + 1)
      }
      // The session list again when an agent started or stopped, and every few seconds (a session renamed, a subagent).
      if ((changed && ticks > 0) || ++ticks % LIST_EVERY === 0) readList()
      // Running sessions in the tree: their turns again, only when their transcript changed (null back otherwise).
      readTurns(treeSessionsRef.current.filter((x) => x.live).map((x) => x.id))
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
        const l = a.live
        if (!l) return { id: a.id, name: a.name, live: null }
        const state = agentState(l)
        return { id: a.id, name: a.name, live: { sessionId: l.sessionId, sessionName: l.sessionName, startedAt: l.startedAt, status: l.status, text: statusText(l), working: state === 'working', waiting: state === 'waiting', failed: state === 'stalled' } }
      }),
    // Taken in at a tick that saw them change, and when an agent is added or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, project.agents.length]
  )
  const cards = useMemo<ActivityCard[]>(
    () =>
      tasks
        .filter((c) => !c.archived && c.project.toLowerCase() === project.name.toLowerCase())
        .map((c) => ({ number: c.number, label: cardLabel(c), title: c.title, column: c.column, builder: c.agent, reviewer: c.review?.agent ?? null })),
    [tasks, project.name]
  )
  const reads = useMemo<Reads>(() => ({ agents, cards, list, turns, now }), [agents, cards, list, turns, now])

  // --- Frozen or live (HI-1743): a snapshot taken when the tab opens; Refresh takes another; Play goes live.
  const [held, setHeld] = useState<Reads | null>(null)
  const [pending, setPending] = useState(0)
  // Bumped by a new snapshot or another tab: the tree is drawn afresh (what ended dropped, compact again).
  const [fresh, setFresh] = useState(0)
  const ready = !!list && nowRead
  // Each opening (the tab shown, or opened from an agent or a card) takes a new snapshot, frozen.
  const opening = `${active}:${view.opened ?? 0}`
  const lastOpening = useRef('')
  useEffect(() => {
    if (!active || lastOpening.current === opening) return
    lastOpening.current = opening
    setLive(false)
    setHeld(null)
    setPending(0)
    setNowRead(false)
    setFresh((n) => n + 1)
  }, [active, opening])
  useEffect(() => {
    if (!live && !held && ready) setHeld(reads)
    if (live && held) {
      setHeld(null)
      setPending(0)
    }
    // Only going live or frozen (or the first whole read since the opening): newer reads while frozen are counted below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, ready, held])
  const refresh = useCallback((): void => {
    setHeld((h) => (h ? reads : null))
    setPending(0)
    setFresh((n) => n + 1)
  }, [reads])
  // Another tab, or a filter changed, is the user's own doing: the tree is drawn afresh for it.
  const filterKey = JSON.stringify([view.agents ?? [], view.cards ?? [], view.hideFinished !== false, view.tab ?? ''])
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
    // A session's turns read for the first time aren't an update to hold: they complete the snapshot.
    const onlyFirstTurns = was.agents === reads.agents && was.cards === reads.cards && was.list === reads.list && was.now === reads.now && [...reads.turns].every(([id, t]) => was.turns.get(id) === t || !held.turns.has(id))
    if (!onlyFirstTurns) setPending((n) => n + 1)
  }, [reads, held])
  const drawn = useMemo<Reads>(() => {
    if (!held) return reads
    const extra = [...reads.turns].filter(([id]) => !held.turns.has(id))
    return extra.length ? { ...held, turns: new Map([...held.turns, ...extra]) } : held
  }, [held, reads])

  const input = useMemo<ActivityInput>(() => ({ agents: drawn.agents, cards: drawn.cards, sessions: drawn.list ?? [], turns: drawn.turns, now: drawn.now, at: Date.now() }), [drawn])
  const tabs = useMemo(() => activityTabs(input, view, view.tab), [input, view])
  const tab: ActivityTabInfo | null = tabs.find((t) => t.agentId === view.tab) ?? tabs[0] ?? null
  const tree = useMemo(() => (tab ? buildActivityTree(input, tab.agentId) : []), [input, tab])

  // Live, what ended fades out where it was, then leaves (HI-1743); frozen, the snapshot doesn't change.
  const goneAt = useRef(new Map<string, number>())
  const [prune, setPrune] = useState(0)
  const keptRef = useRef<{ fresh: number; tree: ActivityNode[] }>({ fresh: -1, tree: [] })
  const kept = useMemo(() => {
    if (keptRef.current.fresh !== fresh) goneAt.current.clear()
    const at = Date.now()
    const merged = keepGone(keptRef.current.fresh === fresh ? keptRef.current.tree : [], tree)
    const t = pruneGone(merged, (n) => {
      const since = goneAt.current.get(n.key) ?? at
      goneAt.current.set(n.key, since)
      return at - since < FADE_MS
    })
    const still = new Set(goneKeys(t))
    for (const k of [...goneAt.current.keys()]) if (!still.has(k)) goneAt.current.delete(k)
    keptRef.current = { fresh, tree: t }
    return t
    // `prune` takes the faded ones out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, fresh, prune])
  const fading = goneKeys(kept).length > 0
  useEffect(() => {
    if (!fading) return
    const t = setTimeout(() => setPrune((n) => n + 1), FADE_MS)
    return () => clearTimeout(t)
  }, [fading, kept])
  // When each node was first drawn, since the tree was last drawn afresh: nothing drawn moves as work comes and goes.
  const order = useRef({ fresh, order: newOrder() })
  if (order.current.fresh !== fresh) order.current = { fresh, order: newOrder() }

  const isOpen = useCallback(
    (n: ActivityNode): boolean => {
      const level = activityLevel(n)
      const asked = level ? levels.get(level) : undefined
      return toggled.has(n.key) !== (asked === undefined ? openIn(mode, n) : asked && expandable(n))
    },
    [toggled, mode, levels]
  )
  const rows = useMemo(() => stableRows(kept, isOpen, order.current.order), [kept, isOpen])

  // The turns of each session in the tree: read once there (the tick reads running ones again).
  const treeSessions = useMemo(() => {
    const out: { id: string; live: boolean }[] = []
    const walk = (ns: readonly ActivityNode[]): void => ns.forEach((n) => (n.kind === 'session' && !n.gone && out.push({ id: n.session.id, live: n.live }), walk(n.children)))
    walk(tree)
    return out
  }, [tree])
  treeSessionsRef.current = treeSessions
  const unread = treeSessions.filter((x) => !turns.has(x.id)).map((x) => x.id).join(',')
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

  // Zoom (HI-1678): kept with the view; Fit scales the tree as shown to the tab, never above actual size.
  const zoom = view.zoom ?? 1
  const treeApi = useRef<TreeApi | null>(null)
  const setZoom = useCallback((z: number) => setView({ zoom: Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100 }), [setView])
  const fit = useCallback(() => {
    const box = treeApi.current?.box()
    if (!box) return
    const depth = rows.reduce((m, r) => Math.max(m, r.depth), 0)
    setZoom(Math.min(1, box.width / ((depth + 1) * COL), box.height / Math.max(1, rows.length * ROW)))
  }, [rows, setZoom])
  // Jump to selected: the selected node.
  const jump = useCallback(() => {
    const i = selected ? rows.findIndex((r) => r.node.key === selected) : -1
    if (i >= 0) treeApi.current?.scrollToRow(i, rows[i].depth)
  }, [rows, selected])
  const onKey = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'f') fit()
      else if (k === '+' || k === '=') setZoom(zoomStep(zoom, 1))
      else if (k === '-') setZoom(zoomStep(zoom, -1))
      else if (k === '0') setZoom(1)
      else if (k === 'j') jump()
      else return
      e.preventDefault()
    },
    [fit, setZoom, zoom, jump]
  )
  const setLevel = (level: ActivityLevel, open: boolean): void => {
    setLevels((m) => new Map(m).set(level, open))
    // Its nodes' own folds go: the whole level is as asked.
    const atLevel = keysAtLevel(kept, level)
    setToggled((t) => new Set([...t].filter((k) => !atLevel.has(k))))
  }
  const openLevels = (e: React.MouseEvent<HTMLElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const show = (): void =>
      menu.openAt(
        r.left,
        r.bottom + 2,
        ACTIVITY_LEVELS.map((level): MenuEntry => {
          const folded = levelsRef.current.get(level) === false
          return { label: tr(folded ? M.levelExpand : M.levelCollapse, { level }), icon: folded ? 'expand-all' : 'collapse-all', onClick: () => (setLevel(level, folded), queueMicrotask(show)) }
        })
      )
    show()
  }
  const levelsRef = useRef(levels)
  levelsRef.current = levels

  const byKey = useMemo(() => new Map(rows.map((r) => [r.node.key, r.node])), [rows])
  const chosen = selected ? (byKey.get(selected) ?? null) : null
  const filtered = !!view.agents?.length || !!view.cards?.length

  // The Agents ▾ and Cards ▾ menus: several can be ticked; a click ticks one and the menu stays open.
  const menu = useContextMenu()
  const agentChoices = useMemo(() => project.agents.map((a) => [a.id, a.name] as [string, string]), [project.agents])
  const openPick = (e: React.MouseEvent<HTMLElement>, what: 'agents' | 'cards'): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const show = (picked: readonly (string | number)[]): void => {
      const choices: [string | number, string][] = what === 'agents' ? agentChoices : cards.filter((c) => c.column === 'doing' || c.column === 'review').map((c) => [c.number, `${c.label} ${c.title}`])
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

  // Until the session list comes (the first open of a project), the tree has the running agents' sessions.
  const reading = !list && !listError
  return (
    <div className="activity-tab">
      <div className="activity-main">
        <div className="activity-head">
          <span className="pane-header-title">{tr(M.heading)}</span>
          <button className={cx('btn small subtle activity-pick', !!view.agents?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'agents')}>
            {tr(M.agents, { n: view.agents?.length ?? 0 })} <Icon name="chevron-down" />
          </button>
          <button className={cx('btn small subtle activity-pick', !!view.cards?.length && 'on') /* i18n-ignore: class names */} aria-haspopup="menu" onClick={(e) => openPick(e, 'cards')}>
            {tr(M.cards, { n: view.cards?.length ?? 0 })} <Icon name="chevron-down" />
          </button>
          <label className="flex muted activity-hide">
            <input type="checkbox" className="checkbox" checked={view.hideFinished !== false} onChange={(e) => setView({ hideFinished: e.target.checked })} /> {tr(M.hideFinished)}
          </label>
          {reading && <span className="faint">{tr(M.reading)}</span>}
          {!list && listError && <span className="error-text">{tr(M.loadFailed, { error: listError })}</span>}
          <div className="actions">
            {!live && pending > 0 && (
              <button className="chip activity-pill" onClick={refresh} title={tr(M.pillTip)}>
                <Icon name="refresh" /> {tr(M.pill, { n: pending })}
              </button>
            )}
            <button className={cx('btn small subtle activity-live', live && 'on') /* i18n-ignore: class names */} aria-pressed={live} title={tr(live ? M.pauseTip : M.liveTip)} onClick={() => setLive((v) => !v)}>
              <Icon name={live ? 'debug-pause' : 'play'} /> {tr(live ? M.pause : M.live)}
            </button>
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={refresh} />
            <button className="btn small subtle activity-levels" aria-haspopup="menu" onClick={openLevels}>
              {tr(M.levels)} <Icon name="chevron-down" />
            </button>
            <IconButton icon="target" title={tr(M.jump)} onClick={jump} />
            <span className="activity-zoom" role="group" aria-label={tr(M.zoomLabel)}>
              <IconButton icon="zoom-out" title={tr(M.zoomOut)} onClick={() => setZoom(zoomStep(zoom, -1))} disabled={zoom <= ZOOM_MIN} />
              <button className="btn small subtle activity-zoom-value" title={tr(M.zoomReset)} onClick={() => setZoom(1)}>
                {fmt.number(zoom, { style: 'percent' })}
              </button>
              <IconButton icon="zoom-in" title={tr(M.zoomIn)} onClick={() => setZoom(zoomStep(zoom, 1))} disabled={zoom >= ZOOM_MAX} />
              <IconButton icon="screen-normal" title={tr(M.fit)} onClick={fit} />
            </span>
            <IconButton
              icon="expand-all"
              title={tr(M.expandAll)}
              onClick={() => {
                setMode('all')
                setLevels(new Map())
                setToggled(new Set())
              }}
            />
            <IconButton
              icon="collapse-all"
              title={tr(M.collapseAll)}
              onClick={() => {
                setMode('none')
                setLevels(new Map())
                setToggled(new Set())
              }}
            />
          </div>
        </div>
        {tabs.length > 0 && (
          <div className="activity-tabs" role="tablist" aria-label={tr(M.tabsLabel)}>
            {tabs.map((t) => (
              <button
                key={t.agentId}
                role="tab"
                className={cx('activity-agent-tab', t.agentId === tab?.agentId && 'active')}
                aria-selected={t.agentId === tab?.agentId}
                data-agent={t.agentId}
                title={t.card ? `${t.name} · ${t.card.label} ${t.card.title}` : t.name}
                onClick={() => {
                  setSelected(null)
                  setView({ tab: t.agentId })
                }}
              >
                <StateMark state={markOf(t.state)} />
                <span className="activity-agent-tab-name">{t.name}</span>
                {t.card && <span className="faint activity-agent-tab-card">{t.card.label}</span>}
              </button>
            ))}
          </div>
        )}
        {kept.length === 0 ? (
          <div className="pane-empty">{reading ? null : tr(filtered ? M.emptyFiltered : M.empty)}</div>
        ) : (
          <TreeView rows={rows} selected={selected} isOpen={isOpen} zoom={zoom} api={treeApi} onKey={onKey} onSelect={setSelected} onToggle={toggle} />
        )}
      </div>
      {chosen && <Details project={project} node={chosen} onClose={() => setSelected(null)} />}
      {menu.element}
    </div>
  )
}

/** Whether a node can open: it has children, or it is a session whose turns can be read (not read yet). */
const expandable = (n: ActivityNode): boolean => n.children.length > 0 || (n.kind === 'session' && !n.turnsLoaded && (!!n.session.hasTranscript || !!n.session.hasBackup))

/** The tree's open state before a node's own toggle: as it starts (all open: it holds only what runs now), or all closed (Collapse All). */
type OpenMode = 'default' | 'all' | 'none'
const openIn = (mode: OpenMode, n: ActivityNode): boolean => (mode === 'none' ? false : expandable(n))

/** The tree drawn: rows in view (and a few more) as nodes, each joined to its parent by an elbow. */
/** What the tab asks of its tree's scrolling box (HI-1678): its size, and a row scrolled into the middle of it. */
interface TreeApi {
  box: () => { width: number; height: number }
  scrollToRow: (row: number, depth: number) => void
}

function TreeView({ rows, selected, isOpen, zoom, api, onKey, onSelect, onToggle }: { rows: ActivityRow[]; selected: string | null; isOpen: (n: ActivityNode) => boolean; zoom: number; api: React.Ref<TreeApi>; onKey: (e: React.KeyboardEvent) => void; onSelect: (key: string) => void; onToggle: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(
    api,
    () => ({
      box: () => ({ width: (ref.current?.clientWidth ?? 0) - TREE_PAD, height: (ref.current?.clientHeight ?? 0) - TREE_PAD }),
      scrollToRow: (row, depth) => {
        const el = ref.current
        if (!el) return
        el.scrollTo({ top: Math.max(0, row * ROW * zoom - (el.clientHeight - NODE_H * zoom) / 2), left: Math.max(0, depth * COL * zoom - (el.clientWidth - NODE_W * zoom) / 2) })
      }
    }),
    [zoom]
  )
  const [view, setView] = useState({ top: 0, height: 800 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setView({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])
  // The rows in view, at the zoom.
  const first = Math.max(0, Math.floor(view.top / (ROW * zoom)) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / (ROW * zoom)) + OVERSCAN)
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
    <div className="activity-tree" ref={ref} role="tree" onKeyDown={onKey}>
      <div className="activity-scaled" style={{ width: width * zoom, height: height * zoom }}>
      <div className="activity-canvas" style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
        <svg className="activity-lines" width={width} height={height} aria-hidden>
          <path d={lines.join('')} />
        </svg>
        {rows.slice(first, last).map((r, i) => (
          <NodeBox key={r.node.key} node={r.node} parent={r.parent >= 0 ? rows[r.parent].node.key : undefined} x={r.depth * COL} y={(first + i) * ROW} open={isOpen(r.node)} selected={selected === r.node.key} onSelect={onSelect} onToggle={onToggle} />
        ))}
      </div>
      </div>
    </div>
  )
}

const NodeBox = memo(function NodeBox({ node, parent, x, y, open, selected, onSelect, onToggle }: { node: ActivityNode; parent?: string; x: number; y: number; open: boolean; selected: boolean; onSelect: (key: string) => void; onToggle: (key: string) => void }) {
  const { icon, title, sub: line, state } = describe(node)
  const sub = node.gone ? tr(M.endedNode) : line
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
      onClick={() => onSelect(node.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(node.key)
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
      {/* Working is a steady pulse, never a spinner (HI-1743): nothing here is loading. */}
      {state === 'working' && !node.gone && <StateMark state="working" decorative className="activity-pulse" />}
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
    case 'turn':
      return { icon: 'comment', title: n.turn.prompt || tr(M.noPrompt), sub: tr(M.tools, { n: n.turn.tools.length }), state: n.state }
    case 'tool': {
      // The call under way says how long it has run (HI-1743).
      const since = n.state === 'working' && n.tool.at ? Date.parse(n.tool.at) : NaN
      return { icon: 'tools', title: n.tool.name, sub: Number.isFinite(since) ? tr(M.toolFor, { summary: n.tool.summary, time: durationText(Date.now() - since, tr) }) : n.tool.summary, state: n.state }
    }
    case 'task':
      // A plain icon and its name: no pulse, nothing that looks like loading (HI-1743).
      return { icon: 'run-all', title: n.task.description || tr(M.task, { type: n.task.type ?? 'other' }), sub: tr(M.task, { type: n.task.type ?? 'other' }), state: null }
    case 'process': {
      const started = filetimeMs(n.process.created)
      return { icon: n.cli ? 'terminal' : 'server-process', title: n.process.run ?? n.process.label, sub: n.cli ? tr(M.cliProcess, { pid: n.process.pid }) : started ? tr(M.processFor, { pid: n.process.pid, time: durationText(Date.now() - started, tr) }) : tr(M.process, { pid: n.process.pid }), state: null }
    }
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
  heading: msg({ id: 'activity.heading', defaultMessage: 'Activity', description: "The Activity tab's heading: what the project's agents are running now, a tab per agent." }),
  loading: msg({ id: 'activity.loading', defaultMessage: 'Loading…', description: 'The Activity tab, or a detail in it, while it loads.' }),
  reading: msg({ id: 'activity.reading', defaultMessage: 'Reading the sessions…', description: "Beside the Activity tab's heading while the project's sessions are read (the tree shows running agents meanwhile)." }),
  loadFailed: msg({ id: 'activity.loadFailed', defaultMessage: 'Could not load the activity: {error}', description: "The Activity tab when the project's sessions couldn't be read. {error} is the reason." }),
  empty: msg({ id: 'activity.empty', defaultMessage: 'Nothing is running. Start an agent to see what it runs here.', description: 'The Activity tab when no agent of the project runs anything (with Hide finished on, idle agents have no tab).' }),
  emptyFiltered: msg({ id: 'activity.emptyFiltered', defaultMessage: 'Nothing is running for this filter.', description: 'The Activity tab, filtered to agents or cards, when none of them runs anything.' }),
  tabsLabel: msg({ id: 'activity.tabsLabel', defaultMessage: 'Agents', description: "The Activity tab's row of agent tabs (one per running agent), for screen readers." }),
  levels: msg({ id: 'activity.levels', defaultMessage: 'Levels', description: 'A menu button above the Activity tree: collapses or expands every node at one level at once (all turns, all tool calls…).' }),
  levelCollapse: msg({ id: 'activity.levelCollapse', defaultMessage: '{level, select, agent {Collapse all agents} session {Collapse all sessions} subagent {Collapse all subagents} turn {Collapse all turns} tool {Collapse all tool calls} other {Collapse all processes}}', description: "An entry of the Activity tab's Levels menu: closes every node at that level." }),
  levelExpand: msg({ id: 'activity.levelExpand', defaultMessage: '{level, select, agent {Expand all agents} session {Expand all sessions} subagent {Expand all subagents} turn {Expand all turns} tool {Expand all tool calls} other {Expand all processes}}', description: "An entry of the Activity tab's Levels menu: opens every node at that level again." }),
  jump: msg({ id: 'activity.jump', defaultMessage: 'Jump to Selected (J)', description: "Tooltip of the Activity tab's button that scrolls the selected node into view. J is its key; keep it." }),
  zoomLabel: msg({ id: 'activity.zoomLabel', defaultMessage: 'Zoom', description: "The Activity tab's zoom buttons, for screen readers." }),
  zoomIn: msg({ id: 'activity.zoomIn', defaultMessage: 'Zoom In (+)', description: "Tooltip of the Activity tab's zoom in button. + is its key; keep it." }),
  zoomOut: msg({ id: 'activity.zoomOut', defaultMessage: 'Zoom Out (−)', description: "Tooltip of the Activity tab's zoom out button. − is its key; keep it." }),
  zoomReset: msg({ id: 'activity.zoomReset', defaultMessage: 'Actual Size (0)', description: "Tooltip of the Activity tab's zoom level (a percentage): clicking it goes back to 100%. 0 is its key; keep it." }),
  fit: msg({ id: 'activity.fit', defaultMessage: 'Zoom to Fit (F)', description: "Tooltip of the Activity tab's button that scales the tree to fit the tab. F is its key; keep it." }),
  agents: msg({ id: 'activity.agents', defaultMessage: '{n, plural, =0 {All agents} one {# agent} other {# agents}}', description: "A menu button above the Activity tab's agent tabs: which agents have a tab (several can be ticked); with none ticked, all." }),
  cards: msg({ id: 'activity.cards', defaultMessage: '{n, plural, =0 {All cards} one {# card} other {# cards}}', description: 'A menu button above the Activity tab: only the agents working on these cards in progress have a tab (several can be ticked); with none ticked, all.' }),
  all: msg({ id: 'activity.all', defaultMessage: 'All', description: "The first entry of the Activity tab's Agents and Cards menus: no filter, everything." }),
  hideFinished: msg({ id: 'activity.hideFinished', defaultMessage: 'Hide finished', description: 'A checkbox above the Activity tab (on by default): agents with nothing running (not running, or idle with no process or background task) have no tab.' }),
  pause: msg({ id: 'activity.pause', defaultMessage: 'Pause', description: 'A button above the Activity tab while it is live: freezes it as it is (updates wait, counted in the pill).' }),
  live: msg({ id: 'activity.live', defaultMessage: 'Play', description: 'A button above the Activity tab while it is frozen (as it always opens): goes live, showing updates as they come.' }),
  pauseTip: msg({ id: 'activity.pauseTip', defaultMessage: 'Freeze it as it is: updates wait until you refresh or play.', description: "Tooltip of the Activity tab's Pause button (shown while live)." }),
  liveTip: msg({ id: 'activity.liveTip', defaultMessage: 'Go live: show what runs as it changes. The tab opens frozen, a snapshot of when you opened it.', description: "Tooltip of the Activity tab's Play button (shown while frozen)." }),
  pill: msg({ id: 'activity.pill', defaultMessage: '{n, plural, one {# update · Refresh} other {# updates · Refresh}}', description: 'A pill above the Activity tab while it is frozen: how many updates came since its snapshot; clicking it takes a new one. Keep "Refresh" as the action.' }),
  pillTip: msg({ id: 'activity.pillTip', defaultMessage: 'Take a new snapshot with what came since. It stays frozen.', description: "Tooltip of the Activity tab's updates pill." }),
  refresh: msg({ id: 'activity.refresh', defaultMessage: 'Refresh', description: "Tooltip of the Activity tab's refresh button: takes a new snapshot of what runs now." }),
  endedNode: msg({ id: 'activity.endedNode', defaultMessage: 'Ended', description: "A node's second line in the Activity tab, live, once its process or session ended: it fades out, then leaves." }),
  expandAll: msg({ id: 'activity.expandAll', defaultMessage: 'Expand All', description: "Tooltip of the Activity tab's button that opens every node." }),
  collapseAll: msg({ id: 'activity.collapseAll', defaultMessage: 'Collapse All', description: "Tooltip of the Activity tab's button that closes every node." }),
  expand: msg({ id: 'activity.expand', defaultMessage: 'Expand', description: "A node's open button in the Activity tree (screen readers)." }),
  collapse: msg({ id: 'activity.collapse', defaultMessage: 'Collapse', description: "A node's close button in the Activity tree (screen readers)." }),
  column: msg({ id: 'activity.column', defaultMessage: '{column, select, hold {On Hold} todo {Todo} doing {Doing} review {Review} passed {Passed} done {Done} other {{column}}}', description: "A card node's second line in the Activity tree: its board column. Use the board's column names." }),
  state: msg({ id: 'activity.state', defaultMessage: '{state, select, working {Working} waiting {Waiting for you} failed {Failed or stalled} done {Done} other {Idle}}', description: 'A node\'s state in the Activity tree: working, waiting for you, failed (or stalled), done, idle.' }),
  turns: msg({ id: 'activity.turns', defaultMessage: '{n, plural, one {# turn} other {# turns}}', description: "A session node's second line in the Activity tree: how many turns (a prompt and what followed) it has." }),
  tools: msg({ id: 'activity.tools', defaultMessage: '{n, plural, =0 {No tool calls} one {# tool call} other {# tool calls}}', description: "A turn node's second line in the Activity tree: how many tool calls it made." }),
  noPrompt: msg({ id: 'activity.noPrompt', defaultMessage: '(no prompt text)', description: 'A turn node in the Activity tree whose prompt has no text (only images, say).' }),
  task: msg({ id: 'activity.task', defaultMessage: '{type, select, subagent {Background subagent} command {Background command} monitor {Monitor} workflow {Workflow} other {Background task}}', description: 'A background task node in the Activity tree: what kind it is.' }),
  process: msg({ id: 'activity.process', defaultMessage: 'Process {pid}', description: 'A process node\'s second line in the Activity tree. {pid} is its process id.' }),
  processFor: msg({ id: 'activity.processFor', defaultMessage: 'Process {pid} · running {time}', description: 'A process node\'s second line in the Activity tab: its process id ({pid}) and how long it has run ({time}: "4 min", "1 h 5 min").' }),
  toolFor: msg({ id: 'activity.toolFor', defaultMessage: '{summary} · {time}', description: 'A tool call node\'s second line in the Activity tab while it runs: what it does ({summary}, from the agent, such as a command) and how long it has run so far ({time}: "40 s", "4 min").' }),
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
