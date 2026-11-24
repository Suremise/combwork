import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ACTIVITY_HOURS, buildActivityView, commandText, filetimeMs, keepGoneList, type ActivityAgent, type ActivityCard, type ActivityDetail, type ActivityInput, type ActivityNode, type ActivityNow, type ActivityPart, type ActivityState, type ActivityTabInfo, type ActivityTurns } from '@shared/activity'
import { agentState, type AgentState } from '@shared/agentState'
import { modelIdName } from '@shared/models'
import { cardLabel } from '@shared/projectKeys'
import { durationText } from '@shared/tasks'
import type { ProjectInfo, SessionListItem } from '@shared/types'
import { call, errorMessage } from '../api'
import * as actions from '../actions'
import { confirm, isAssistantPath, notify, openInSessionsTab, revealAgent, set, setAssistantOpen, useStore } from '../store'
import { Icon, IconButton, statusText, useContextMenu, type MenuEntry } from '../components/ui'
import { StateMark } from '../components/StateMark'
import { loadActivityView, loadMapShow, saveActivityView, saveMapShow, type ActivityView, type MapShow } from '../activityView'
import { ActivityMap, AgentStrip, MapToggles, mapSessions, openMapFile, showMapCall, usePickedCall, mapStrip, mapTabs, noteMapTurns, useActivityMap, useMapContexts, type MapEntry } from './ActivityMap'
import { mapContextEntries, mapMode, mapReadOrder, pickedAgent, type MapCallRef, type MapContext, type MapPick } from '@shared/activityMap'
import { cx } from '../util'
import { boundedQueue, latestOnly } from '@shared/coalesce'
import { fmt, msg, tr } from '@shared/i18n'

/** How often what runs now is read, and live changes are drawn, while the tab is shown (#1254: batched, about once a second). */
export const TICK_MS = 1000
/** The session list read again every this many ticks (and when an agent starts or stops). */
export const LIST_EVERY = 5
/** Sessions whose turns are read at once. */
export const TURNS_AT_ONCE = 4
/** Live, how long what ended takes to fade out before it leaves (HI-1743); the CSS fade is as long. */
export const FADE_MS = 1500

/** Each project's session list as last read here: the tab opens on it at once and draws the fresh one when it comes. */
const lastLists = new Map<string, SessionListItem[]>()
export const NO_NOW: ActivityNow = { launches: [], tasks: [] }
const NO_ENTRIES: MapEntry[] = []

/**
 * Render times of the tab (ms, from its render to its layout effect), the latest last: the Activity tab's measurement
 * (#1254, a live update under one frame) reads them from a test copy's window.
 */
const renders: number[] = []
;(window as unknown as { __cwActivityRenders?: number[] }).__cwActivityRenders = renders

/** What the tab is drawn from: held as it was while the tab is frozen (HI-1743). */
interface Reads {
  agents: ActivityAgent[]
  cards: ActivityCard[]
  list: SessionListItem[] | null
  turns: ReadonlyMap<string, ActivityTurns>
  now: ActivityNow
  /** The map's agents' context (HI-2903), by agent: held with the rest, so a frozen ring doesn't move. */
  contexts: ReadonlyMap<string, MapContext | null>
}

/** An activity state as an agent state mark: failed is stalled, done idle. */
export const markOf = (s: ActivityState): AgentState => (s === 'failed' ? 'stalled' : s === 'done' ? 'idle' : s)

/**
 * A project's Activity tab (#1254, HI-1743): what runs now. The agents' strip picks one (HI-3568): its map and its current
 * work as a list; with none picked, the shared map and each agent's Now in a row. An agent's work is a list:
 * its card in progress as a header, then the turn now (its prompt, the tool call under way, or thinking or writing), its
 * subagents and background tasks, and the processes it started (its own CLI and Combwork's tool server only when asked).
 * Nothing past: the card is the history. It opens frozen, a snapshot taken then: Refresh takes a new one, Play goes live
 * (what ended fades out, then leaves), Pause freezes again, and the reads since are counted in the pill. Nothing is read
 * or drawn while it is hidden; live changes are taken in about once a second.
 */
export function ActivityTab({ project }: { project: ProjectInfo }) {
  const renderStart = performance.now()
  useLayoutEffect(() => {
    if (renders.push(performance.now() - renderStart) > 200) renders.shift()
  })
  const shown = useStore((s) => s.activity === 'projects' && s.selectedProject === project.path)
  const visible = usePageVisible()
  const active = shown && visible
  // The view (filters, tab, own processes): the store's, else as this window last left it.
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
  const [selected, setSelected] = useState<string | null>(null)
  // A call the map showed (HI-3499): what finds it, kept while it is the one selected; its node is found again in each
  // drawing's reads (HI-3508: pickNode, below).
  const [mapPick, setMapPick] = useState<MapPick | null>(null)
  useEffect(() => {
    if (mapPick && selected !== mapPick.key) setMapPick(null)
  }, [selected, mapPick])
  // Escape clears a call the map showed (HI-3499, HR1's round 1): its From the map row and its Details, after an open
  // station panel and before the agent shown alone (the map's own Escape asks first); from the list or Details too.
  const pickNow = useRef(mapPick)
  pickNow.current = mapPick
  const clearPick = useCallback((): boolean => {
    if (!pickNow.current) return false
    setSelected(null)
    return true
  }, [])
  const clearSelected = useCallback(() => setSelected(null), [])
  // Live (HI-1743): a choice, never the default; each opening is frozen.
  const [live, setLive] = useState(false)
  // The agents as last taken in: live state changes often, the tab follows once a tick, and only when it changed.
  const [tick, setTick] = useState(0)
  const agentsRef = useRef(project.agents)
  agentsRef.current = project.agents
  // Sessions shown, as last drawn: their turns are read, a live one's again each tick.
  const shownSessionsRef = useRef<{ id: string; live: boolean }[]>([])
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  // Turns read a few sessions at a time, the session list's newest read only; both for while the tab is shown (#1254
  // round 3): hidden or gone, what waits is dropped and what still runs applies nothing.
  const turnReads = useRef(boundedQueue(TURNS_AT_ONCE))
  const listReads = useRef(latestOnly())
  // A session's turns are read and taken in only while the list or the map shows it (HR2's HI-2903 round 1): checked when
  // its read starts and when it answers, so a read the map no longer wants (a filter changed, the map off) neither runs
  // nor fills the cache again after its session was dropped.
  const wantedTurns = (id: string): boolean => shownSessionsRef.current.some((x) => x.id === id)
  const mapOnlyRef = useRef(new Set<string>())
  const readTurns = useCallback(
    (ids: string[]): void => {
      for (const id of ids)
        turnReads.current.add(
          id,
          () => {
            if (!wantedTurns(id)) return Promise.resolve(null)
            if (mapOnlyRef.current.has(id)) noteMapTurns('read')
            return call('activity:turns', project.path, id, turnsRef.current.get(id)?.version).catch(() => null)
          },
          (t) => {
            if (!t || !wantedTurns(id)) return
            if (mapOnlyRef.current.has(id)) noteMapTurns('applied')
            setTurns((m) => new Map(m).set(id, t))
          }
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
      // Live sessions shown (the agents' and their running subagents'): their turns again, only when their transcript
      // changed (null back otherwise).
      readTurns(shownSessionsRef.current.filter((x) => x.live).map((x) => x.id))
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
        return { id: a.id, name: a.name, live: { sessionId: l.sessionId, sessionName: l.sessionName, startedAt: l.startedAt, status: l.status, text: statusText(l), working: state === 'working', waiting: state === 'waiting', failed: state === 'stalled', ...(l.modelSwitch ? { modelSwitch: { launched: l.modelSwitch.launched, running: l.modelSwitch.running, provider: l.provider } } : {}) } }
      }),
    // Taken in at a tick that saw them change, and when an agent is added or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick, project.agents.length]
  )
  const cards = useMemo<ActivityCard[]>(
    () =>
      tasks
        .filter((c) => !c.archived && c.project.toLowerCase() === project.name.toLowerCase())
        .map((c) => ({ number: c.number, label: cardLabel(c), title: c.title, column: c.column, builder: c.agent, reviewer: c.review?.agent ?? null, ...(c.column === 'doing' && c.waitingFor ? { waiting: { reason: c.waitingFor.reason, assistant: !!c.waitingFor.ask } } : {}) })),
    [tasks, project.name]
  )
  // The map (HI-2903): its toggles (one for every view), and its agents' context, read only while it shows them.
  const [mapShow, setMapShowState] = useState<MapShow>(loadMapShow)
  const setMapShow = useCallback((m: MapShow): void => {
    saveMapShow(m)
    setMapShowState(m)
  }, [])
  const [mapEntries, setMapEntries] = useState<MapEntry[]>(NO_ENTRIES)
  const contexts = useMapContexts(active && mapShow.map && mapShow.context, mapEntries)
  const reads = useMemo<Reads>(() => ({ agents, cards, list, turns, now, contexts }), [agents, cards, list, turns, now, contexts])

  // --- Frozen or live (HI-1743): a snapshot taken when the tab opens; Refresh takes another; Play goes live.
  const [held, setHeld] = useState<Reads | null>(null)
  const [pending, setPending] = useState(0)
  // Bumped by a new snapshot or another tab: what is shown is drawn afresh (what ended dropped).
  const [fresh, setFresh] = useState(0)
  const ready = !!list && nowRead
  // Each opening takes a new snapshot, frozen: the tab shown again (from another view, the window restored: HR6's round
  // 1, it stayed live), or opened from an agent or a card.
  const opening = `${view.opened ?? 0}`
  const lastOpening = useRef<string | null>(null)
  useEffect(() => {
    if (!active) {
      lastOpening.current = null
      return
    }
    if (lastOpening.current === opening) return
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
  // Another tab, or a filter changed, is the user's own doing: drawn afresh for it.
  const filterKey = JSON.stringify([view.agents ?? [], view.cards ?? [], view.hideFinished !== false, view.tab ?? '', !!view.showOwn])
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
    const onlyFirstTurns = was.agents === reads.agents && was.cards === reads.cards && was.list === reads.list && was.now === reads.now && [...reads.turns].every(([id, t]) => was.turns.get(id) === t || !held.turns.has(id)) && [...reads.contexts].every(([k, c]) => was.contexts.get(k) === c || !held.contexts.has(k))
    if (!onlyFirstTurns) setPending((n) => n + 1)
  }, [reads, held])
  const drawn = useMemo<Reads>(() => {
    if (!held) return reads
    const extra = [...reads.turns].filter(([id]) => !held.turns.has(id))
    // A context read for the first time completes the snapshot too (an agent's ring, once its usage is in).
    const extraCtx = [...reads.contexts].filter(([k]) => !held.contexts.has(k))
    return extra.length || extraCtx.length ? { ...held, turns: new Map([...held.turns, ...extra]), contexts: new Map([...held.contexts, ...extraCtx]) } : held
  }, [held, reads])

  const input = useMemo<ActivityInput>(() => ({ agents: drawn.agents, cards: drawn.cards, sessions: drawn.list ?? [], turns: drawn.turns, now: drawn.now, at: Date.now() }), [drawn])
  // --- The map (HI-2903) and the strip (HI-3568): exactly one agent in the filter, its map; else the shared map of the
  // agents the filters show, or the one picked in the strip.
  const mode = mapMode(view.agents)
  // Its agents: by the list's filters (Agents, Cards, Hide finished, the pick kept), so a filter changed on a frozen
  // snapshot changes the map as it changes the list (HR2's round 2).
  const entries = useMemo<MapEntry[]>(
    () => mapTabs(input, view, mode, view.tab).map((t) => ({ key: t.agentId, path: project.path, agentId: t.agentId, name: t.name, tab: t, input, live: project.agents.find((a) => a.id === t.agentId)?.live ?? null })),
    // The live state is the project's now (its provider and session): taken in with the drawn reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, view.agents, view.cards, view.hideFinished, view.tab, input]
  )
  // One selection for the map and the panel (HI-3568): the agent picked in the strip, or none (the shared view).
  const picked = pickedAgent(mode, entries, view.tab)
  const content = useMemo(() => (picked ? buildActivityView(input, picked, { showOwn: !!view.showOwn }) : { card: null, parts: [] }), [input, picked, view.showOwn])
  // The shared view with no pick (HI-3568): each agent's Now in a row.
  const nowRows = useMemo(() => (picked ? [] : entries.map((x) => nowRow(x.input, x.tab, x.key))), [picked, entries])

  // Live, what ended fades out where it was, then leaves (HI-1743); frozen, the snapshot doesn't change.
  const goneAt = useRef(new Map<string, number>())
  const keptRef = useRef<{ fresh: number; lists: Map<string, ActivityNode[]> }>({ fresh: -1, lists: new Map() })
  const [prune, setPrune] = useState(0)
  const parts = useMemo(() => {
    if (keptRef.current.fresh !== fresh) {
      keptRef.current = { fresh, lists: new Map() }
      goneAt.current.clear()
    }
    const at = Date.now()
    const still = new Set<string>()
    const keep = (key: string, next: ActivityNode[]): ActivityNode[] => {
      const out = keepGoneList(keptRef.current.lists.get(key) ?? [], next).filter((n) => {
        if (!n.gone) return true
        const since = goneAt.current.get(n.key) ?? at
        goneAt.current.set(n.key, since)
        if (at - since >= FADE_MS) return false
        still.add(n.key)
        return true
      })
      keptRef.current.lists.set(key, out)
      return out
    }
    const out = content.parts.map((p) => ({ ...p, subagents: keep(`${p.agentId}:subagents`, p.subagents), processes: keep(`${p.agentId}:processes`, p.processes) }))
    for (const k of [...goneAt.current.keys()]) if (!still.has(k)) goneAt.current.delete(k)
    return out
    // `prune` takes the faded ones out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, fresh, prune])
  const fading = parts.some((p) => [...p.subagents, ...p.processes].some((n) => n.gone))
  useEffect(() => {
    if (!fading) return
    const t = setTimeout(() => setPrune((n) => n + 1), FADE_MS)
    return () => clearTimeout(t)
  }, [fading, parts])

  // The picked agent drawn alone (HI-3180, HI-3568); the strip still lists the selection.
  const drawnMode = picked ? 'single' : mode
  const drawnEntries = useMemo(() => (picked ? entries.filter((x) => x.key === picked) : entries), [entries, picked])
  // What the map reads turns and contexts for: the one picked first (HR1's round 1: the ninth of ten is read, as a
  // filter to it was), then the rest of the selection.
  const readEntries = useMemo(() => mapReadOrder(entries, picked), [entries, picked])
  // The context reads take each agent's live state as the project has it now (HI-2929: a setup ending, local limits set
  // after the launch, under the same session id).
  const forContexts = mapContextEntries(readEntries, (e) => project.agents.find((a) => a.id === e.agentId)?.live ?? null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setMapEntries(forContexts.entries), [forContexts.key])
  const mapOn = mapShow.map
  // A panel's file opened in Files (HI-3498): stable, so the map (memo) draws nothing more for it.
  const entriesNow = useRef(entries)
  entriesNow.current = entries
  const openFile = useCallback((key: string, path: string) => openMapFile(entriesNow.current, key, path), [])
  // A call shown in the list (HI-3499): its agent's tab, the call selected there (its own row, or one from the map).
  const showCall = useCallback(
    (c: MapCallRef) =>
      showMapCall(entriesNow.current, c, (found) => {
        setView({ tab: found.entryKey })
        setMapPick({ entryKey: found.entryKey, path: found.path, agentId: found.agentId, key: found.node.key, call: c })
        setSelected(found.node.key)
      }),
    [setView]
  )
  // Animated once live and the snapshot released (HI-2939): its first pulses' baseline is then the live reads, never the
  // held ones (from those, what came while frozen was sent as a burst).
  const map = useActivityMap({ active, animate: active && live && !held && mapOn, scope: `${fresh}|${drawnMode}|${filterKey}`, entries: mapOn ? drawnEntries : NO_ENTRIES, contexts: drawn.contexts, mode: drawnMode, at: input.at })
  const strip = useMemo(() => mapStrip(entries, drawn.contexts, readEntries), [entries, drawn.contexts, readEntries])
  // The sessions the map reads beyond the list's (the shared map's agents' running sessions): none with the map off.
  const mapRead = useMemo(() => (mapOn ? mapSessions(readEntries, mode) : []), [mapOn, readEntries, mode])
  // With no pick, the rows' (HI-3568: each agent's Now): the list's own, read as it shows them, the map off too.
  const rowsRead = useMemo(() => (picked ? [] : mapSessions(readEntries, mode)), [picked, readEntries, mode])
  // The strip's, a dot's or a row's pick (HI-3568): that agent, its map and its details; null, the shared view.
  const pick = useCallback(
    (key: string | null) => {
      setSelected(null)
      setView({ tab: key ?? undefined })
    },
    [setView]
  )

  // The turns of each session shown: read once there (the tick reads live ones again: HR6's round 1, a running
  // subagent's too), and the map's.
  const shownSessions = useMemo(() => {
    const listed = [...parts.flatMap((p) => [...(p.session ? [{ id: p.session.session.id, live: true }] : []), ...p.subagents.flatMap((n) => (n.kind === 'session' && !n.gone ? [{ id: n.session.id, live: n.live }] : []))]), ...rowsRead.map((x) => ({ id: x.id, live: x.live }))]
    const have = new Set(listed.map((x) => x.id))
    return [...listed, ...mapRead.filter((x) => !have.has(x.id)).map((x) => ({ id: x.id, live: x.live }))]
  }, [parts, rowsRead, mapRead])
  shownSessionsRef.current = shownSessions
  // Turns read only for the map, dropped once neither it nor the list shows their session (a filter changed, the map off).
  // Which those are is known as it renders, so a read starting or answering after this render is checked against it.
  const listedIds = new Set([...parts.flatMap((p) => [...(p.session ? [p.session.session.id] : []), ...p.subagents.flatMap((n) => (n.kind === 'session' ? [n.session.id] : []))]), ...rowsRead.map((x) => x.id)])
  const mapOnlyNow = new Set(mapRead.map((x) => x.id).filter((id) => !listedIds.has(id)))
  const droppable = useRef(new Set<string>())
  mapOnlyRef.current = mapOnlyNow
  const mapOnlyKey = [...mapOnlyNow].join(',')
  useEffect(() => {
    const drop = [...droppable.current].filter((id) => !mapOnlyRef.current.has(id) && !shownSessionsRef.current.some((x) => x.id === id))
    droppable.current = new Set(mapOnlyRef.current)
    if (drop.length) setTurns((m) => new Map([...m].filter(([id]) => !drop.includes(id))))
  }, [mapOnlyKey])
  const unread = shownSessions.filter((x) => !turns.has(x.id)).map((x) => x.id).join(',')
  useEffect(() => {
    if (active && unread) readTurns(unread.split(','))
  }, [active, unread, readTurns])

  // The map's call as the reads have it now (HI-3508): done or failed once it ends; gone, said and unselected.
  const pickNode = usePickedCall(mapPick, input, clearSelected)
  const byKey = useMemo(() => {
    const m = new Map<string, ActivityNode>()
    for (const p of parts) for (const n of [p.session, p.turn, p.doing?.kind === 'tool' ? p.doing.tool : null, ...p.subagents, ...p.processes]) if (n) m.set(n.key, n)
    if (mapPick && pickNode && !m.has(pickNode.key) && parts.some((p) => p.agentId === mapPick.agentId)) m.set(pickNode.key, pickNode)
    return m
  }, [parts, mapPick, pickNode])
  const chosen = selected ? (byKey.get(selected) ?? null) : null
  const filtered = !!view.agents?.length || !!view.cards?.length

  // The Agents ▾ and Cards ▾ menus: several can be ticked; a click ticks one and the menu stays open.
  const menu = useContextMenu()
  const agentChoices = useMemo(() => project.agents.map((a) => [a.id, a.name] as [string, string]), [project.agents])
  const openPick = (e: React.MouseEvent<HTMLElement>, what: 'agents' | 'cards'): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const show = (ticked: readonly (string | number)[]): void => {
      const choices: [string | number, string][] = what === 'agents' ? agentChoices : cards.filter((c) => c.column === 'doing' || c.column === 'review').map((c) => [c.number, `${c.label} ${c.title}`])
      const items: MenuEntry[] = [
        { label: tr(M.all), icon: ticked.length ? undefined : 'check', onClick: () => choose([]) },
        { separator: true },
        ...choices.map(([id, label]): MenuEntry => ({ label, icon: ticked.includes(id) ? 'check' : undefined, onClick: () => choose(ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]) }))
      ]
      menu.openAt(r.left, r.bottom + 2, items)
    }
    const choose = (next: readonly (string | number)[]): void => {
      // The selection chosen again (Agents ▾, even the same): every agent of it shown again (HI-3180), no pick (HI-3568).
      setView(what === 'agents' ? { agents: next as string[], tab: undefined } : { cards: next as number[] })
      show(next)
    }
    show(what === 'agents' ? (view.agents ?? []) : (view.cards ?? []))
  }

  const reading = !list && !listError
  const card = content.card
  const solo = parts[0]?.session?.session
  return (
    <div
      className="activity-tab"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // A call the map showed first, then the pick (HI-3568: the shared view again), the map off too.
        if (clearPick() || (picked && mode === 'shared' && (pick(null), true))) e.stopPropagation()
      }}
    >
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
            <MapToggles show={mapShow} onChange={setMapShow} />
            {!live && pending > 0 && (
              <button className="chip activity-pill" onClick={refresh} title={tr(M.pillTip)}>
                <Icon name="refresh" /> {tr(M.pill, { n: pending })}
              </button>
            )}
            <button className={cx('btn small subtle activity-live', live && 'on') /* i18n-ignore: class names */} aria-pressed={live} title={tr(live ? M.pauseTip : M.liveTip)} onClick={() => setLive((v) => !v)}>
              <Icon name={live ? 'debug-pause' : 'play'} /> {tr(live ? M.pause : M.live)}
            </button>
            <IconButton icon="refresh" title={tr(M.refresh)} onClick={refresh} />
          </div>
        </div>
        {/* The strip, the one picker (HI-3568): above the list with the map off, under the map otherwise. */}
        {!mapOn && strip.length > 0 && (
          <div className="activity-strip-bar">
            <AgentStrip agents={strip} picked={picked} single={mode === 'single'} onPick={pick} showContext={false} live={false} />
          </div>
        )}
        <div className={cx('activity-body', mapOn && entries.length > 0 && 'with-map')}>
          {mapOn && entries.length > 0 && <ActivityMap mode={drawnMode} title={project.name} model={map.model} pulses={map.pulses} endPulse={map.endPulse} show={mapShow} onPick={pick} strip={strip} picked={picked} single={mode === 'single'} onOpenFile={openFile} onShowCall={showCall} onEscape={clearPick} live={map.animate} />}
        {nowRows.length > 0 ? (
          <div className="activity-list">
            <NowRows rows={nowRows} onPick={pick} />
          </div>
        ) : !parts.length ? (
          <div className="pane-empty">{reading ? null : tr(filtered ? M.emptyFiltered : M.empty)}</div>
        ) : (
          <div className="activity-list">
            {/* What the tab is about, in one line (HI-1743): its card, a link to it, else its session. */}
            {card ? (
              <div className="activity-card-head">
                <button className="link activity-card-key" title={tr(M.openCard)} onClick={() => set({ taskOpen: card.number })}>
                  {card.label}
                </button>
                <span className="activity-card-title" title={card.title}>
                  {card.title}
                </span>
                <span className="faint activity-card-column">· {tr(M.column, { column: card.column })}</span>
              </div>
            ) : null}
            {/* Waiting on purpose (HI-2915, HI-2618): what for, under its card's line, cut short with the whole in its title. */}
            {card?.waiting && (
              <div className="activity-card-waiting faint" data-mark="waiting" title={tr(M.waiting, { assistant: card.waiting.assistant ? 'yes' : 'no', reason: card.waiting.reason })}>
                {tr(M.waiting, { assistant: card.waiting.assistant ? 'yes' : 'no', reason: card.waiting.reason })}
              </div>
            )}
            {card ? null : solo ? (
              <div className="activity-card-head">
                <span className="activity-card-title" title={solo.title || solo.name || solo.id.slice(0, 8)}>
                  {solo.title || solo.name || solo.id.slice(0, 8)}
                </span>
              </div>
            ) : null}
            {parts.map((p) => (
              <PartView key={p.agentId} project={project} part={p} many={parts.length > 1} selected={selected} onSelect={setSelected} showOwn={!!view.showOwn} onShowOwn={(v) => setView({ showOwn: v })} picked={mapPick?.agentId === p.agentId ? pickNode : null} />
            ))}
          </div>
        )}
        </div>
      </div>
      {chosen && <Details project={project} node={chosen} onClose={() => setSelected(null)} />}
      {menu.element}
    </div>
  )
}

/** An agent's Now as a row of the shared view (HI-3568): its tab (name, state, card) and its part (what it does now). */
export interface NowRowInfo {
  key: string
  tab: ActivityTabInfo
  part: ActivityPart | null
}

/** An agent's Now as a row (HI-3568), from the drawn reads: `key` is what picks it (the workspace's is host-qualified). */
export function nowRow(input: ActivityInput, tab: ActivityTabInfo, key: string): NowRowInfo {
  return { key, tab, part: buildActivityView(input, tab.agentId).parts.find((p) => p.agentId === tab.agentId) ?? null }
}

/** An agent's current step in a few words (HI-3568): the tool call under way, thinking or writing, else its status line. */
const stepText = (p: ActivityPart | null): string => {
  if (!p) return tr(M.notRunning)
  if (p.doing?.kind === 'tool') return `${p.doing.tool.tool.name} ${p.doing.tool.tool.summary}`.trim()
  if (p.doing) return tr(p.doing.kind === 'writing' ? M.writing : M.thinking)
  return p.session ? p.line || tr(M.state, { state: p.state }) : tr(M.notRunning)
}

/**
 * The shared view's panel with no agent picked (HI-3568): each agent's Now in a short row (its state, name, card and
 * current step), a click picking that agent, as its ring does. `nameOf` names a row's agent (the workspace level's, with
 * its project).
 */
export function NowRows({ rows, onPick, nameOf }: { rows: readonly NowRowInfo[]; onPick: (key: string) => void; nameOf?: (key: string, agent: string) => string }) {
  return (
    <section className="activity-now-rows" data-part="all">
      <h3 className="activity-group" data-group="now">
        {tr(M.nowHeading)}
      </h3>
      {rows.map(({ key, tab: t, part }) => {
        const name = nameOf ? nameOf(key, t.name) : t.name
        const step = stepText(part)
        return (
          <button key={key} className="activity-now-row" data-agent={t.agentId} data-key={key} title={tr(M.nowRowTip, { name })} onClick={() => onPick(key)}>
            <StateMark state={markOf(t.state)} />
            <span className="activity-now-row-name">{name}</span>
            {t.card && (
              <span className="faint activity-now-row-card" title={t.card.title}>
                {t.card.label}
              </span>
            )}
            <span className="activity-now-row-step" title={step}>
              {step}
            </span>
          </button>
        )
      })}
    </section>
  )
}

/** One agent's work (HI-1743): Now (its prompt, then what it does), its subagents and background tasks, its processes. */
export function PartView({ project, part: p, many, selected, onSelect, showOwn, onShowOwn, picked = null }: { project: ProjectInfo; part: ActivityPart; many: boolean; selected: string | null; onSelect: (key: string) => void; showOwn: boolean; onShowOwn: (v: boolean) => void; picked?: ActivityNode | null }) {
  const row = (n: ActivityNode) => <Row key={n.key} node={n} selected={selected === n.key} onSelect={onSelect} />
  // A call the map showed (HI-3499) that isn't a row here already (the latest prompt, the tool under way): its own row.
  const fromMap = picked && picked.key !== p.turn?.key && picked.key !== (p.doing?.kind === 'tool' ? p.doing.tool.key : null) ? picked : null
  return (
    <section className="activity-part" data-part={p.agentId}>
      {many && (
        <div className="activity-part-head">
          <StateMark state={markOf(p.state)} />
          <button className="link" onClick={() => showActivityAgent(project, p.agentId)}>
            {p.name}
          </button>
          {p.role && <span className="faint">{tr(M.role, { role: p.role })}</span>}
        </div>
      )}
      <h3 className="activity-group" data-group="now">
        {tr(M.nowHeading)}
      </h3>
      {p.turn && row(p.turn)}
      {p.doing?.kind === 'tool' ? (
        row(p.doing.tool)
      ) : p.doing ? (
        <div className="activity-row act-working" data-doing={p.doing.kind}>
          <Icon name={p.doing.kind === 'writing' ? 'edit' : 'lightbulb'} />
          <div className="activity-row-text">
            <div className="activity-row-title">{tr(p.doing.kind === 'writing' ? M.writing : M.thinking)}</div>
          </div>
          <StateMark state="working" decorative className="activity-pulse" />
        </div>
      ) : (
        <div className="activity-row activity-row-plain" data-doing="none">
          <StateMark state={markOf(p.state)} decorative />
          <div className="activity-row-text">
            <div className="activity-row-title">{p.session ? p.line || tr(M.state, { state: p.state }) : tr(M.notRunning)}</div>
          </div>
        </div>
      )}
      {fromMap && (
        <>
          <h3 className="activity-group" data-group="fromMap">
            {tr(M.fromMapHeading)}
          </h3>
          {row(fromMap)}
        </>
      )}
      {p.blocks.map((b) => (
        // A lock block standing now (HI-982): live only, gone once its decision ends; the Hooks dialog keeps the history.
        <div key={b.key} className="activity-row act-waiting" data-block={b.kind} title={tr(M.blockTip)}>
          <Icon name="lock" />
          <div className="activity-row-text">
            <div className="activity-row-title">{tr(b.kind === 'asked' ? M.blockAsked : M.blockBlocked, { file: b.file, holder: b.holder ?? '', other: b.holder === null ? 'yes' : 'no' })}</div>
            <div className="activity-row-sub faint">{tr(M.blockFor, { time: ranFor(b.at) })}</div>
          </div>
        </div>
      ))}
      {p.modelSwitch && (
        // Another model than it was launched with (HI-2609), while that lasts: its footer marks it too.
        <div className="activity-row act-waiting" data-model-switch="yes" title={tr(M.modelSwitchTip)}>
          <Icon name="warning" />
          <div className="activity-row-text">
            <div className="activity-row-title">{tr(M.modelSwitch, { launched: modelIdName(p.modelSwitch.provider, p.modelSwitch.launched, null), running: modelIdName(p.modelSwitch.provider, p.modelSwitch.running, null) })}</div>
          </div>
        </div>
      )}
      {p.subagents.length > 0 && (
        <>
          <h3 className="activity-group" data-group="subagents">
            {tr(M.subagentsHeading)}
          </h3>
          {p.subagents.map(row)}
        </>
      )}
      {(p.processes.length > 0 || p.ownHidden > 0 || showOwn) && (
        <>
          <h3 className="activity-group" data-group="processes">
            {tr(M.processesHeading)}
            {(p.ownHidden > 0 || showOwn) && (
              <label className="flex muted activity-own">
                <input type="checkbox" className="checkbox" checked={showOwn} onChange={(e) => onShowOwn(e.target.checked)} /> {tr(M.showOwn, { n: p.ownHidden })}
              </label>
            )}
          </h3>
          {p.processes.map(row)}
        </>
      )}
    </section>
  )
}

/** Shows an agent of a session host: a project's pane, or the Assistant's panel (HI-1664: the workspace level has it). */
function showActivityAgent(project: ProjectInfo, agentId: string): void {
  if (isAssistantPath(project.path)) setAssistantOpen(true)
  else revealAgent(project, agentId)
}

/** An item as a row: its icon, what it is, a line about it, and a pulse while it works. */
function Row({ node, selected, onSelect }: { node: ActivityNode; selected: boolean; onSelect: (key: string) => void }) {
  const { icon, title, sub: line, state } = describe(node)
  const sub = node.gone ? tr(M.endedNode) : line
  // Selected from elsewhere (HI-3499: the map shows a call here), it comes into view; a click on it moves nothing.
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) el.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  return (
    <div
      ref={el}
      className={cx('activity-row', `act-${node.kind}`, state && `act-${state}`, node.kind === 'process' && node.process.orphan && 'act-orphan', node.gone && 'act-gone', selected && 'selected')}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-key={node.key}
      onClick={() => onSelect(node.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(node.key)
        }
      }}
    >
      <Icon name={icon} />
      <div className="activity-row-text">
        <div className="activity-row-title">{title}</div>
        {sub && <div className="activity-row-sub faint">{sub}</div>}
      </div>
      {/* Working is a steady pulse, never a spinner (HI-1743): nothing here is loading. */}
      {state === 'working' && !node.gone && <StateMark state="working" decorative className="activity-pulse" />}
    </div>
  )
}

/** How long something has run, from an ISO time or Unix ms; '' when it isn't known. */
const ranFor = (from: string | number | null | undefined): string => {
  const t = typeof from === 'number' ? from : Date.parse(from ?? '')
  return Number.isFinite(t) ? durationText(Date.now() - t, tr) : ''
}

/** A row's icon, title, second line and state, as drawn. */
function describe(n: ActivityNode): { icon: string; title: string; sub: string; state: ActivityState | null } {
  switch (n.kind) {
    case 'session': {
      // A subagent, by its own transcript (HR6's round 2): the tool call under way in it, else thinking while it works;
      // done once it replied; not read yet, nothing said.
      const open = n.last?.tools.at(-1)
      const doing = n.state !== 'working' ? (n.turnsLoaded ? tr(M.state, { state: n.state }) : '') : open && !open.done && n.last?.lastKind === 'tool' ? tr(M.toolFor, { summary: `${open.name} ${open.summary}`.trim(), time: ranFor(open.at) }) : tr(M.thinking)
      return { icon: 'type-hierarchy-sub', title: n.session.title || n.session.name || n.session.id.slice(0, 8), sub: doing, state: n.state }
    }
    case 'turn':
      return { icon: 'comment', title: n.turn.prompt || tr(M.noPrompt), sub: n.turn.at ? tr(M.promptFor, { time: ranFor(n.turn.at) }) : '', state: null }
    case 'tool': {
      // The call under way says how long it has run (HI-1743).
      const time = n.state === 'working' ? ranFor(n.tool.at) : ''
      return { icon: 'tools', title: n.tool.name, sub: time ? tr(M.toolFor, { summary: n.tool.summary, time }) : n.tool.summary, state: n.state }
    }
    case 'task':
      // A plain icon and its name: no pulse, nothing that looks like loading (HI-1743).
      return { icon: 'run-all', title: n.task.description || tr(M.task, { type: n.task.type ?? 'other' }), sub: tr(M.task, { type: n.task.type ?? 'other' }), state: null }
    case 'process': {
      const started = filetimeMs(n.process.created)
      // The command as given (HI-1743: a cmd /c wrapper as what it runs); a cw-progress run by its title.
      const title = n.process.run ?? commandText(n.process)
      // Left running by its command, its shell gone (HI-2111): said, with how long and its CPU time.
      if (n.process.orphan) return { icon: 'warning', title, sub: tr(M.orphanFor, { pid: n.process.pid, time: ranFor(started), cpu: durationText(n.process.orphan.cpuMs, tr) }), state: null }
      return { icon: n.own ? 'terminal' : 'server-process', title, sub: started ? tr(M.processFor, { pid: n.process.pid, time: ranFor(started) }) : tr(M.process, { pid: n.process.pid }), state: null }
    }
  }
}

const fmtWhen = (iso: string | undefined | null): string => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? fmt.relative(t - Date.now()) : ''
}

/** The selected node's details: its status, its input exactly (masked like the log), its last action, and what can be done. */
export function Details({ project, node, onClose }: { project: ProjectInfo; node: ActivityNode; onClose: () => void }) {
  const { title, state } = describe(node)
  const [detail, setDetail] = useState<ActivityDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A prompt's or a tool call's whole input, as written, masked: read for the node shown.
  const item = node.kind === 'tool' ? { sessionId: node.sessionId, itemId: node.tool.itemId } : node.kind === 'turn' ? { sessionId: node.sessionId, itemId: node.turn.itemId } : null
  const itemKey = item ? `${item.sessionId}:${item.itemId}` : null
  // Read again as a call ends (HI-3508: one the map showed stays selected), so its result comes in.
  const ended = node.kind === 'tool' && node.state !== 'working'
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
  }, [itemKey, ended, project.path])
  const rows: [string, string][] = []
  if (state) rows.push([tr(M.statusLabel), tr(M.state, { state })])
  let input: string | null = null
  let last: string | null = null
  const buttons: React.ReactNode[] = []
  switch (node.kind) {
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
      if (node.process.orphan) rows.push([tr(M.orphanLabel), node.process.orphan.host ? tr(M.orphanHost) : node.process.orphan.run !== undefined ? tr(M.orphanHeld, { run: node.process.orphan.run }) : tr(M.orphanFact)], [tr(M.cpuLabel), durationText(node.process.orphan.cpuMs, tr)])
      if (node.process.parent) rows.push([tr(M.parentLabel), String(node.process.parent)])
      if (started) rows.push([tr(M.started), fmt.relative(started - Date.now())])
      input = node.process.command ?? node.process.label
      if (!node.own && node.process.created) buttons.push(<EndProcessButton key="end" project={project} agentId={node.agentId} pid={node.process.pid} created={node.process.created} label={node.process.label} orphan={!!node.process.orphan} />)
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
function EndProcessButton({ project, agentId, pid, created, label, orphan }: { project: ProjectInfo; agentId: string; pid: number; created: string; label: string; orphan?: boolean }) {
  const end = async (): Promise<void> => {
    // Left running (HI-2111): End It, behind the same question.
    const ok = await confirm({ title: tr(M.endTitle), message: tr(M.endMessage, { label, pid }), detail: tr(M.endDetail), confirmLabel: orphan ? tr(M.endIt).replace(/…$/, '') : tr(M.endButton), danger: true })
    if (!ok) return
    const r = await actions.attempt(tr(M.endFailed), () => call('activity:endProcess', project.path, agentId, pid, created))
    if (!r) return
    if (r === 'ended') notify('success', tr(M.ended, { label }))
    else notify('warning', tr(M.notEnded, { label, why: r }))
  }
  return (
    <button className="btn small danger" onClick={() => void end()}>
      {tr(orphan ? M.endIt : M.endButton)}
    </button>
  )
}

/** Whether the window is shown (not minimised or hidden). */
export function usePageVisible(): boolean {
  const [v, setV] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setV(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return v
}

const M = {
  heading: msg({ id: 'activity.heading', defaultMessage: 'Activity', description: "The Activity tab's heading: what the project's agents are running now." }),
  loading: msg({ id: 'activity.loading', defaultMessage: 'Loading…', description: 'The Activity tab, or a detail in it, while it loads.' }),
  reading: msg({ id: 'activity.reading', defaultMessage: 'Reading the sessions…', description: "Beside the Activity tab's heading while the project's sessions are read (the tree shows running agents meanwhile)." }),
  loadFailed: msg({ id: 'activity.loadFailed', defaultMessage: 'Could not load the activity: {error}', description: "The Activity tab when the project's sessions couldn't be read. {error} is the reason." }),
  empty: msg({ id: 'activity.empty', defaultMessage: 'Nothing is running. Start an agent to see what it runs here.', description: 'The Activity tab when no agent of the project runs anything (with Hide finished on, idle agents have no tab).' }),
  emptyFiltered: msg({ id: 'activity.emptyFiltered', defaultMessage: 'Nothing is running for this filter.', description: 'The Activity tab, filtered to agents or cards, when none of them runs anything.' }),
  nowRowTip: msg({ id: 'activity.nowRowTip', defaultMessage: 'Show {name}: its map and what it does now', description: "Hover of an agent's row in the Activity panel's shared view (HI-3568: no agent picked, each agent's current step in a row): a click picks that agent, as its ring in the strip does. {name} is the agent (on the workspace level, with its project)." }),
  fromMapHeading: msg({ id: 'activity.fromMapHeading', defaultMessage: 'From the map', description: "A heading in the Activity tab (HI-3499) over a call chosen on the Activity map's feed or a station's panel that isn't among the rows above (an earlier turn's): it shows that call, selected, with its details." }),
  nowHeading: msg({ id: 'activity.nowHeading', defaultMessage: 'Now', description: "A heading in the Activity tab, over what an agent is doing in its turn now: its prompt, then the tool call under way (or thinking, or writing)." }),
  subagentsHeading: msg({ id: 'activity.subagentsHeading', defaultMessage: 'Subagents and background tasks', description: "A heading in the Activity tab, over an agent's subagents and the background tasks it left running (a command, a monitor)." }),
  processesHeading: msg({ id: 'activity.processesHeading', defaultMessage: 'Processes', description: "A heading in the Activity tab, over the processes an agent started (test runs, servers, scripts)." }),
  showOwn: msg({ id: 'activity.showOwn', defaultMessage: '{n, plural, =0 {Show the agent’s own processes} one {Show the agent’s own process (#)} other {Show the agent’s own processes (#)}}', description: "A checkbox beside the Activity tab's Processes heading: also shows the agent's own processes (its CLI, the terminal hosting it, Combwork's tool server for it), hidden by default. {n}: how many are hidden." }),
  thinking: msg({ id: 'activity.thinking', defaultMessage: 'Thinking…', description: 'In the Activity tab, what an agent is doing when it works with no tool call under way and nothing written yet in its turn.' }),
  writing: msg({ id: 'activity.writing', defaultMessage: 'Writing…', description: 'In the Activity tab, what an agent is doing when it works with no tool call under way, after it started writing its reply.' }),
  blockBlocked: msg({ id: 'activity.block.blocked', defaultMessage: '{other, select, yes {Edit blocked: {file} is locked by an agent of another project} other {Edit blocked: {file} is locked by agent {holder}}}', description: "In the Activity tab, under Now: Combwork's file lock blocked the agent's edit of a file another agent is editing, while that stands. {file} is the file's path; {holder} the agent editing it." }),
  blockAsked: msg({ id: 'activity.block.asked', defaultMessage: '{other, select, yes {Edit waiting for your OK: {file} is locked by an agent of another project} other {Edit waiting for your OK: {file} is locked by agent {holder}}}', description: "In the Activity tab, under Now: Combwork's file lock (Ask me) holds the agent's edit of a file another agent is editing until the user allows it. {file} is the file's path; {holder} the agent editing it." }),
  modelSwitch: msg({ id: 'activity.modelSwitch', defaultMessage: 'Model changed: {launched} → {running}', description: 'In the Activity tab, under Now (HI-2609): the agent runs another model ({running}) than Combwork started it with ({launched}), its connection\'s. Both are model names ("GPT-6 Astra"); keep the arrow.' }),
  modelSwitchTip: msg({ id: 'activity.modelSwitch.tip', defaultMessage: "Its coding agent changed model by itself or at a prompt of its own. Shown while it runs the other model; restart the agent to go back to its connection's.", description: 'Tooltip on the "Model changed" row in the Activity tab (HI-2609). Its connection is the account Combwork started the agent on.' }),
  blockFor: msg({ id: 'activity.block.for', defaultMessage: "Combwork's file lock · {time}", description: 'The second line of a lock block in the Activity tab: what blocked the edit, and for how long it has stood ({time}, such as "2 min").' }),
  blockTip: msg({ id: 'activity.block.tip', defaultMessage: "Shown while the lock stands: it goes once the other agent finishes, the agent tries again or moves on, or its turn ends. Its history is in the agent's ⋯ → Hooks…", description: 'Tooltip on a lock block in the Activity tab. ⋯ → Hooks… is the agent menu item: keep the arrow and the dots.' }),
  notRunning: msg({ id: 'activity.notRunning', defaultMessage: 'Not running', description: "In the Activity tab, under Now, for an agent that isn't running." }),
  role: msg({ id: 'activity.role', defaultMessage: '{role, select, builder {builder} other {reviewer}}', description: "Beside an agent's name in the Activity tab when a card's builder and reviewer are both shown: its role on the card. Lower case." }),
  promptFor: msg({ id: 'activity.promptFor', defaultMessage: 'Prompt · {time} ago', description: "The line under an agent's prompt in the Activity tab: when it was given, as a duration ({time}: \"4 min\")." }),
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
  waiting: msg({ id: 'activity.waiting', defaultMessage: '{assistant, select, yes {Waiting for the Assistant’s answer: {reason}} other {Waiting: {reason}}}', description: "A line under the card an agent works on in the Activity tab (HI-2915): the card, in Active, is marked as waiting on purpose, so Combwork doesn't report it as stalled. assistant is yes when its agent asked the Combwork Assistant for something and waits for its answer; {reason} is why, in the agent's or the user's own words (for the Assistant, the request). Keep the select keys." }),
  column: msg({ id: 'activity.column', defaultMessage: '{column, select, hold {On Hold} todo {Todo} doing {Active} review {Review} passed {Approved} done {Done} other {{column}}}', description: "A card node's second line in the Activity tree: its board column. Use the board's column names." }),
  state: msg({ id: 'activity.state', defaultMessage: '{state, select, working {Working} waiting {Waiting for you} failed {Failed or stalled} done {Done} other {Idle}}', description: 'A node\'s state in the Activity tree: working, waiting for you, failed (or stalled), done, idle.' }),
  noPrompt: msg({ id: 'activity.noPrompt', defaultMessage: '(no prompt text)', description: 'A turn node in the Activity tree whose prompt has no text (only images, say).' }),
  task: msg({ id: 'activity.task', defaultMessage: '{type, select, subagent {Background subagent} command {Background command} monitor {Monitor} workflow {Workflow} other {Background task}}', description: 'A background task node in the Activity tree: what kind it is.' }),
  process: msg({ id: 'activity.process', defaultMessage: 'Process {pid}', description: 'A process node\'s second line in the Activity tree. {pid} is its process id.' }),
  processFor: msg({ id: 'activity.processFor', defaultMessage: 'Process {pid} · running {time}', description: 'A process node\'s second line in the Activity tab: its process id ({pid}) and how long it has run ({time}: "4 min", "1 h 5 min").' }),
  toolFor: msg({ id: 'activity.toolFor', defaultMessage: '{summary} · {time}', description: 'A tool call node\'s second line in the Activity tab while it runs: what it does ({summary}, from the agent, such as a command) and how long it has run so far ({time}: "40 s", "4 min").' }),
  details: msg({ id: 'activity.details', defaultMessage: 'Details', description: "The Activity tab's details panel, for screen readers." }),
  closeDetails: msg({ id: 'activity.closeDetails', defaultMessage: 'Close details', description: "Tooltip of the button closing the Activity tab's details panel." }),
  statusLabel: msg({ id: 'activity.statusLabel', defaultMessage: 'Status', description: "A label in the Activity tab's details: the node's state." }),
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
  orphanFor: msg({ id: 'activity.orphanFor', defaultMessage: 'Left running · process {pid} · running {time} · CPU {cpu}', description: "A process node's second line in the Activity tab when the agent's command left it running, the shell that started it gone (HI-2111): its process id ({pid}), how long it has run ({time}: \"12 min\") and the processor time it has used ({cpu}: \"3 min\")." }),
  orphanLabel: msg({ id: 'activity.orphanLabel', defaultMessage: 'Left running', description: "A label in the Activity tab's details (HI-2111): the process was left running by the agent's command." }),
  orphanFact: msg({ id: 'activity.orphanFact', defaultMessage: 'The process that started it has exited, and it has run for longer than Settings → Advanced allows. The agent is told; Combwork doesn’t end it.', description: "The value beside Left running in the Activity tab's details (HI-2111): why this process counts as left running (its wait is an advanced setting, “Processes left running: minutes before telling”)." }),
  orphanHeld: msg({ id: 'activity.orphanHeld', defaultMessage: 'The process that started it has exited, but it belongs to the cw-progress run “{run}”, which is still running: nobody is told unless it outlives the run.', description: "The value beside Left running in the Activity tab's details (HI-3206): the process is part of a cw-progress run ({run}, its title) that is still running, so no notice goes out yet. Keep cw-progress as it is (a command)." }),
  orphanHost: msg({ id: 'activity.orphanHost', defaultMessage: 'The process that started it has exited, but it is a known host that keeps running on purpose (Settings → Advanced): nobody is told.', description: "The value beside Left running in the Activity tab's details (HI-3206): the process is a known long-lived host (the Windows Sandbox guest's, an advanced setting), so no notice goes out for it." }),
  cpuLabel: msg({ id: 'activity.cpuLabel', defaultMessage: 'CPU time', description: "A label in the Activity tab's details (HI-2111): the processor time a process has used." }),
  endIt: msg({ id: 'activity.endIt', defaultMessage: 'End It…', description: "A button in the Activity tab's details for a process the agent's command left running (HI-2111): ends it, after a confirmation (…)." }),
  endButton: msg({ id: 'activity.endButton', defaultMessage: 'End Process…', description: "A button in the Activity tab's details: ends this one process of the agent's, after a confirmation (…)." }),
  endTitle: msg({ id: 'activity.endTitle', defaultMessage: 'End this process?', description: 'Title of the confirmation before ending one of an agent\'s processes from the Activity tab.' }),
  endMessage: msg({ id: 'activity.endMessage', defaultMessage: 'End {label} (process {pid})?', description: 'The confirmation before ending one of an agent\'s processes. {label} is what it runs, {pid} its id.' }),
  endDetail: msg({ id: 'activity.endDetail', defaultMessage: 'Only this process ends, and only while it is still the one listed here. What it started keeps running, and the agent may see its command fail.', description: 'Detail of the confirmation before ending one of an agent\'s processes from the Activity tab.' }),
  endFailed: msg({ id: 'activity.endFailed', defaultMessage: 'Could not end the process', description: "An error's title: ending a process from the Activity tab failed." }),
  ended: msg({ id: 'activity.ended', defaultMessage: 'Ended {label}', description: 'A notification: the process ({label}: what it ran) was ended from the Activity tab.' }),
  notEnded: msg({ id: 'activity.notEnded', defaultMessage: '{why, select, notOwn {{label} is no longer one of this agent\'s processes: nothing was ended.} cli {{label} is the agent\'s CLI: use Stop to end it.} other {{label} could not be ended: it may still run.}}', description: "A notification after End Process in the Activity tab when it didn't end it: it had ended or isn't the agent's (notOwn), it is the agent's CLI (cli), or ending it failed. {label} is what it runs." })
}

/** The tab's messages, for the workspace level's (HI-1664) same rows and details. */
export const ACTIVITY_M = M
