// The Activity map (HI-2903): the Activity tab's reads drawn as a honeycomb (shared/activityMap.ts has the model). One
// agent in the filter shows its map; none or several, one shared map, each agent its own colour. It draws from the same
// reads as the list (frozen or live), animates only while shown, live and on, and reads nothing of its own while hidden.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activityTabs, buildActivityView, filetimeMs, type ActivityFilter, type ActivityInput, type ActivityTabInfo } from '@shared/activity'
import { MAP_AGENTS, MAP_STATIONS, addPulses, agentColour, buildMapModel, contextLevel, diffPulses, mapContextKey, mapReadKeys, stationLastShown, stationLoad, stationPanel, stationTitle, mapCallNode, mapSessionKey, type MapCallRef, type MapPanelRow, type TextFits, type MapAgentInput, type MapContext, type MapModel, type MapPulse, type MapStation, type MapStationView } from '@shared/activityMap'
import { ACTIVITY_MAP_MOTION } from '@shared/advanced'
import { boundedQueue } from '@shared/coalesce'
import { formatTime } from '@shared/dates'
import { durationText } from '@shared/tasks'
import { contextShown } from '@shared/defaults'
import { msg, tr } from '@shared/i18n'
import { providerDescriptor } from '@shared/providers'
import type { ProjectInfo } from '@shared/types'
import { call } from '../api'
import { useAdvancedValue } from '../advanced'
import { notify, useStore } from '../store'
import { openPathInFiles } from '../fileLinks'
import { cx } from '../util'
import { PaneResizer, usePaneSize } from '../components/Resizer'
import type { MapShow } from '../activityView'

/**
 * What the map read, drew and animated, counted (HI-2903): its e2e suite reads them from a test copy's window to prove
 * it costs nothing while hidden (no reads, renders or pulses), and that Map off and frozen stop its own work.
 */
const mapCounts = { renders: 0, pulses: 0, flying: 0, reads: 0, turnReads: 0, turnsApplied: 0, active: false }
;(window as unknown as { __cwActivityMap?: typeof mapCounts }).__cwActivityMap = mapCounts

/** An agent the map shows: its key (the filter's value: an agent id, or at the workspace level its host's and id), its host and its tab. */
export interface MapEntry {
  key: string
  path: string
  agentId: string
  name: string
  tab: ActivityTabInfo
  input: ActivityInput
  /** Its live state as the project has it now (its provider, session and local limits). */
  live: ProjectInfo['agents'][number]['live'] | null
}

/**
 * Opens a file a station's panel lists in its project's Files tab (HI-3498): from where its agent works; a file not
 * there now (moved, deleted, outside the projects) is said, never a blank tab.
 */
export function openMapFile(entries: readonly MapEntry[], key: string, path: string): void {
  const e = entries.find((x) => x.key === key)
  if (!e) return
  void openPathInFiles(e.path, e.agentId, path).then((ok) => {
    if (!ok) notify('warning', tr(M.panelNoFile, { path }))
  })
}

/**
 * Shows a call the map shows in the list (HI-3499): its node from the turns read, or a notice where it isn't there now
 * (its session restarted, its item no longer read), never another row. `show` gets the node to select.
 */
export function showMapCall(entries: readonly MapEntry[], ref: MapCallRef, show: (found: NonNullable<ReturnType<typeof mapCallNode>>) => void): void {
  const found = mapCallNode(entries, ref)
  if (found) show(found)
  else notify('info', tr(M.callGone))
}

/** A session's key in the map: its host's path (lower-cased) and its id, as the workspace level keys its reads. */
const sessionKey = mapSessionKey
const NO_TURNS = { sessionId: '', version: '', total: 0, turns: [] }

/**
 * The agents the map shows: the list's own tabs, by the same filters (Agents, Cards, Hide finished; HR2's round 1), in pane
 * order; one agent's map, the first. None: no map (the list says nothing runs).
 */
export function mapTabs(input: ActivityInput, filter: ActivityFilter, mode: 'single' | 'shared', keep?: string | null): ActivityTabInfo[] {
  const tabs = activityTabs(input, filter, keep)
  return mode === 'single' ? tabs.slice(0, 1) : tabs
}

/**
 * The map's own turn reads (HR2's round 1), counted for its cost measure: a read started for a session only the map
 * shows, and an answer applied for one. The views check each such read when it starts and when it answers.
 */
export function noteMapTurns(what: 'read' | 'applied'): void {
  if (what === 'read') mapCounts.turnReads++
  else mapCounts.turnsApplied++
}

/** The sessions the shared map reads turns for (s16: each shown agent's running session, its first MAP_AGENTS only). */
export function mapSessions(entries: readonly MapEntry[], mode: 'single' | 'shared'): { path: string; id: string; live: boolean }[] {
  const out: { path: string; id: string; live: boolean }[] = []
  for (const e of mode === 'single' ? entries.slice(0, 1) : entries.slice(0, MAP_AGENTS)) {
    const a = e.input.agents.find((x) => x.id === e.agentId)
    if (a?.live) out.push({ path: e.path, id: a.live.sessionId, live: a.live.working })
  }
  return out
}

/** The map's agents from the drawn reads (and the contexts held with them). */
function mapInputs(entries: readonly MapEntry[], contexts: ReadonlyMap<string, MapContext | null>, mode: 'single' | 'shared'): MapAgentInput[] {
  return entries.map((e, i): MapAgentInput => {
    const a = e.input.agents.find((x) => x.id === e.agentId)
    const sid = a?.live?.sessionId ?? null
    const notLoaded = mode === 'shared' && i >= MAP_AGENTS
    const part = notLoaded ? null : (buildActivityView(e.input, e.agentId).parts[0] ?? null)
    const role = e.tab.card ? (e.tab.card.builder === e.agentId ? 'builder' : e.tab.card.reviewer === e.agentId ? 'reviewer' : null) : null
    const provider = e.live?.provider
    return {
      key: e.key,
      name: e.name,
      state: e.tab.state,
      waiting: !!a?.live?.waiting,
      doing: part?.doing?.kind ?? null,
      card: e.tab.card ? (role ? tr(M.cardRole, { card: e.tab.card.label, role }) : e.tab.card.label) : null,
      context: contexts.get(e.key) ?? null,
      sessionKey: sid ? sessionKey(e.path, sid) : null,
      // Not running: nothing to read, an observed nothing (never loading).
      turns: sid ? e.input.turns.get(sid) : NO_TURNS,
      notLoaded,
      subagents: part ? part.subagents.filter((n) => n.kind === 'session' && !n.gone).length : 0,
      subagentStates: part ? part.subagents.flatMap((n) => (n.kind === 'session' && !n.gone ? [n.state] : [])) : [],
      tasks: part ? part.subagents.flatMap((n) => (n.kind === 'task' ? [{ type: n.task.type, since: n.task.at }] : [])) : [],
      // By its executable's name only, never its command line (names, never content).
      processes: part ? part.processes.flatMap((n) => (n.kind === 'process' && !n.gone ? [{ name: n.process.name, pid: n.process.pid, since: filetimeMs(n.process.created) }] : [])) : [],
      blocks: part?.blocks.length ?? 0,
      ...(provider && providerDescriptor(provider).capabilities.session?.activityStations ? { reported: providerDescriptor(provider).capabilities.session?.activityStations } : {})
    }
  })
}

/**
 * Each shown agent's context, as its pane footer has it (contextShown over session:usage), read again when the project's
 * usage changes (usageVersion): only while the map and its context are shown, two at a time, the first MAP_AGENTS agents.
 * Null for one not known (no usage yet): never a zero.
 */
export function useMapContexts(on: boolean, entries: readonly MapEntry[]): ReadonlyMap<string, MapContext | null> {
  // Taken in only while on: hidden (or the context off), a project's usage changing draws nothing (HI-3182), and it is
  // read again as it comes on.
  const kept = useRef<Record<string, number> | null>(null)
  const versions = useStore((s) => (on || !kept.current ? s.usageVersion : kept.current))
  kept.current = versions
  const [got, setGot] = useState<ReadonlyMap<string, { at: string; ctx: MapContext | null }>>(new Map())
  const queue = useRef(boundedQueue(2))
  const wanted = entries.slice(0, MAP_AGENTS).flatMap((e) => (e.live && !e.live.settingUp ? [{ key: e.key, path: e.path, live: e.live, at: `${mapContextKey(e.live)}:${versions[e.path] ?? 0}` }] : []))
  const wantKey = wanted.map((w) => `${w.key}=${w.at}`).join('|')
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  useEffect(() => {
    if (!on) return
    const q = queue.current
    for (const w of wantedRef.current) {
      if (got.get(w.key)?.at === w.at) continue
      q.add(`${w.key}=${w.at}`, () => (mapCounts.reads++, call('session:usage', w.path, w.live.sessionId).catch(() => null)), (usage) => {
        const shown = contextShown(usage, w.live)
        setGot((m) => new Map(m).set(w.key, { at: w.at, ctx: shown.tokens === null ? null : { tokens: shown.tokens, window: shown.window, pct: shown.pct } }))
      })
    }
    return () => q.cancel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, wantKey])
  // Agents no longer shown: dropped (bounded by the shown ones).
  useEffect(() => {
    const keep = new Set(wanted.map((w) => w.key))
    if ([...got.keys()].some((k) => !keep.has(k))) setGot((m) => new Map([...m].filter(([k]) => keep.has(k))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantKey])
  return useMemo(() => new Map([...got].map(([k, v]) => [k, v.ctx])), [got])
}

/** Whether pulses travel: the Advanced setting, and for "As Windows says" Windows' Show animations (reduced motion). */
function useMotion(): boolean {
  const setting = useAdvancedValue<string>(ACTIVITY_MAP_MOTION)
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return setting === 'on' || (setting !== 'off' && !reduced)
}

/**
 * The map's model and its pulses. Pulses only while `animate` (shown, live and the map on): each new scope (an opening,
 * Refresh, a filter change, going live, shown again) starts from a baseline that sends none (diffPulses).
 */
export function useActivityMap(o: { active: boolean; animate: boolean; scope: string; entries: readonly MapEntry[]; contexts: ReadonlyMap<string, MapContext | null>; mode: 'single' | 'shared'; at: number }): { model: MapModel; pulses: MapPulse[]; endPulse: (id: string) => void; animate: boolean } {
  // Hidden, the model is held as it was: nothing of the store's changes is built or drawn meanwhile.
  const held = useRef<MapModel | null>(null)
  const model = useMemo(() => (o.active || !held.current ? buildMapModel(mapInputs(o.entries, o.contexts, o.mode), o.at) : held.current), [o.active, o.entries, o.contexts, o.mode, o.at])
  held.current = model
  useLayoutEffect(() => {
    mapCounts.active = o.active
  }, [o.active])
  const [pulses, setPulses] = useState<MapPulse[]>([])
  const base = useRef<{ scope: string; seen: Map<string, boolean> | null; sessions: Set<string> }>({ scope: '', seen: null, sessions: new Set() })
  const ids = useRef(0)
  useEffect(() => {
    if (!o.animate) {
      base.current = { scope: '', seen: null, sessions: new Set() }
      setPulses((p) => (p.length ? [] : p))
      return
    }
    if (base.current.scope !== o.scope) {
      base.current = { scope: o.scope, seen: null, sessions: new Set() }
      setPulses((p) => (p.length ? [] : p))
    }
    const r = diffPulses(base.current.seen, model.calls, () => `p${++ids.current}`, base.current.sessions, model.sessions)
    base.current = { scope: o.scope, seen: r.seen, sessions: r.sessions }
    if (r.pulses.length) {
      mapCounts.pulses += r.pulses.length
      setPulses((p) => addPulses(p, r.pulses))
    }
  }, [o.animate, o.scope, model.calls, model.sessions])
  const endPulse = useCallback((id: string) => setPulses((p) => p.filter((x) => x.id !== id)), [])
  return { model, pulses, endPulse, animate: o.animate }
}

// --- Drawing: a 480 × 500 board, the agent's hex in the centre and the six stations around it, clockwise from the top.
const W = 480
const H = 500
const CX = 240
const CY = 250
const SPOKE = 180
const STATION_R = 52
const CENTRE_R = 78
const pos = (i: number): { x: number; y: number } => {
  const a = (Math.PI / 180) * (60 * i - 90)
  return { x: CX + SPOKE * Math.cos(a), y: CY + SPOKE * Math.sin(a) }
}
const POS = Object.fromEntries(MAP_STATIONS.map((s, i) => [s, pos(i)])) as Record<MapStation, { x: number; y: number }>
const hexPoints = (x0: number, y0: number, r: number): string =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 90)
    return `${(x0 + r * Math.cos(a)).toFixed(1)},${(y0 + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')
const hexPath = (x0: number, y0: number, r: number): string => `M${hexPoints(x0, y0, r).split(' ').join('L')}Z`

/**
 * Each station's spoke (HI-3479): a curve from the centre's edge to the station's, bent a little clockwise, the path its
 * pulses travel (CSS offset-path) as well as the line drawn.
 */
const SPOKE_BEND = 0.2
const spokePath = (i: number): string => {
  const a = (Math.PI / 180) * (60 * i - 90)
  const at = (r: number) => ({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) })
  const from = at(CENTRE_R + 6)
  const to = at(SPOKE - STATION_R + 2)
  const c = { x: (from.x + to.x) / 2 - (to.y - from.y) * SPOKE_BEND, y: (from.y + to.y) / 2 + (to.x - from.x) * SPOKE_BEND }
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`
}
const SPOKES = Object.fromEntries(MAP_STATIONS.map((s, i) => [s, spokePath(i)])) as Record<MapStation, string>
/** A pulse's tail (HI-3479): dots following its head along the spoke, each a little later and fainter. */
const TAIL = [0, 1, 2, 3]
/** The honey's wavy surface (HI-3479), drawn across a hex at its centre's height and moved down to the station's level. */
const honeyPath = (x: number, y: number, r: number): string => {
  const w = r / 2
  return `M${x - r * 1.2},${y} q${w / 2},-4 ${w},0 t${w},0 t${w},0 t${w},0 t${w},0 V${y + r * 2} H${x - r * 1.2} Z` // i18n-ignore: an SVG path, never shown
}
/** The running pips' place (HI-3479): just outside a station's hex, on its spoke's line. */
const PIP_R = 6
const pipAt = (i: number, j: number, n: number): { x: number; y: number } => {
  const a = (Math.PI / 180) * (60 * i - 90)
  const r = SPOKE + STATION_R + 10
  const t = { x: -Math.sin(a), y: Math.cos(a) }
  const off = (j - (n - 1) / 2) * (PIP_R * 2.4)
  return { x: CX + r * Math.cos(a) + t.x * off, y: CY + r * Math.sin(a) + t.y * off }
}
/** At most this many pips a station (the rest are in its count). */
const MAX_PIPS = 5
const short = (s: string, n = 24): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The map's width beside the list (HI-3179), the split between them: dragged, kept as the app's other splits are
 * (`ui:setPane`), double-click for the default; the list keeps `keep` pixels. Under the list (a narrow view) it has none.
 */
const MAP_PANE = { key: 'activityMap', width: 560, min: 320, max: 1400, keep: 280 }

/**
 * The width a station's last call has (HI-3179, HR1's rounds 1 and 2): the hex's inner width at that line
 * (STATION_R × √3 ≈ 90 units, its sides upright there) less a margin each side. In the SVG's own units, as its font
 * size (the CSS's 10.5px) is.
 */
const LAST_WIDTH = 78
const LAST_FONT_PX = 10.5
let measurer: CanvasRenderingContext2D | null | undefined

/**
 * Whether a text fits a station's hex by its drawn width (HR1's HI-3179 round 2: counting characters missed glyphs a
 * fallback font draws wider): measured in the station's own font, a canvas drawing as the SVG does (its fallback fonts
 * too). Null where nothing can measure: stationLastShown's columns bound then.
 */
function lastFits(): TextFits | null {
  if (measurer === undefined) measurer = document.createElement('canvas').getContext('2d')
  if (!measurer) return null
  const ctx = measurer
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
  ctx.font = `${LAST_FONT_PX}px ${family}`
  return (t) => ctx.measureText(t).width <= LAST_WIDTH
}

/** The faint comb behind the map: drawn once. */
const COMB = (() => {
  const r = 22
  const dx = r * Math.sqrt(3)
  const out: string[] = []
  for (let y = 0, j = 0; y < H + r; y += r * 1.5, j++) for (let x = j % 2 ? dx / 2 : 0; x < W + r; x += dx) out.push(hexPoints(x, y, r - 1.5))
  return out
})()

/** An agent's colour as a CSS value: the accent on one agent's map, else its place in the palette. */
const colourOf = (index: number | undefined): string => (index === undefined ? 'var(--accent)' : `var(--map-agent-${agentColour(index)})`)

export interface ActivityMapProps {
  mode: 'single' | 'shared'
  /** The shared map's centre: the project's or the workspace's name. */
  title: string
  model: MapModel
  pulses: MapPulse[]
  endPulse: (id: string) => void
  show: MapShow
  /** The strip's click: show this agent's map, the others still listed (HI-3180), or all again for the one shown. */
  onPick?: (key: string) => void
  /**
   * The agents of the selection while one of them is shown alone (HI-3180): the strip keeps listing
   * them, that one marked (`picked`), so a click switches to another. Without it, the strip lists the shared map's.
   */
  strip?: readonly MapStripAgent[]
  picked?: string | null
  /** A file a Read or Edit panel lists, opened in Files (HI-3498): its agent's key and its path as the agent named it. */
  onOpenFile?: (agentKey: string, path: string) => void
  /** A feed row's or a panel row's call, shown in the list (HI-3499). */
  onShowCall?: (call: MapCallRef) => void
  /** Escape, once no panel is open: true when the view cleared a call the map showed (HI-3499), before un-picking. */
  onEscape?: () => boolean
  /** Animating (shown, live and on: `useActivityMap`'s): agents arriving and leaving are eased only then (HI-3499). */
  live?: boolean
}

/** An agent in the strip: its ring, its name and its context. */
export type MapStripAgent = Pick<MapModel['agents'][number], 'key' | 'name' | 'context' | 'load'>

/**
 * The strip's agents for the selection (HI-3180) while one of them is shown alone, in the selection's order: those the
 * map reads (`read`, its read order: the one shown first, HR1's round 1) read or still loading, the rest not shown.
 */
export function mapStrip(entries: readonly MapEntry[], contexts: ReadonlyMap<string, MapContext | null>, read: readonly MapEntry[]): MapStripAgent[] {
  const reads = mapReadKeys(read)
  return entries.map((e) => {
    const sid = e.input.agents.find((x) => x.id === e.agentId)?.live?.sessionId ?? null
    const load: MapStripAgent['load'] = !reads.has(e.key) ? 'notLoaded' : !sid || e.input.turns.get(sid) ? 'loaded' : 'loading'
    return { key: e.key, name: e.name, context: contexts.get(e.key) ?? null, load }
  })
}

/** The map: stations, spokes, pulses, the centre, the feed and (shared) the agents' context rings. */
export const ActivityMap = memo(function ActivityMap({ mode, title, model, pulses, endPulse, show, onPick, strip, picked = null, onOpenFile, onShowCall, onEscape, live = false }: ActivityMapProps) {
  const motion = useMotion()
  const ids = useMapIds()
  // The station whose panel is open (HI-3498): docked over the feed; its station again, its ✕ or Escape closes it.
  const [panel, setPanel] = useState<MapStation | null>(null)
  const togglePanel = useCallback((s: MapStation) => setPanel((p) => (p === s ? null : s)), [])
  // Each drawing counted as it lands (a layout effect: no write during render), and the pulses then in flight.
  useLayoutEffect(() => {
    mapCounts.renders++
    mapCounts.flying = pulses.length
  })
  const colours = useMemo(() => new Map(model.agents.map((a, i) => [a.key, mode === 'single' ? undefined : i])), [model.agents, mode])
  const one = mode === 'single' ? (model.agents[0] ?? null) : null
  const working = model.agents.filter((a) => a.state === 'working').length
  const waiting = model.agents.filter((a) => a.waiting).length
  const stationName = (s: MapStation): string => tr(M.station, { station: s })
  // Beside the list (a wide view), its width is the user's (HI-3179): a split dragged as the app's others, kept.
  const width = usePaneSize(MAP_PANE.key, MAP_PANE.width)
  // The strip: the selection's agents while one is shown alone (HI-3180), else the shared map's.
  const ringAgents: readonly MapStripAgent[] = strip ?? (mode === 'shared' ? model.agents : [])
  // Agents arriving in the strip and leaving it (HI-3499), eased only while the map moves.
  const comings = useComings(ringAgents, live && motion)
  // The agents' dots arriving at stations (HI-3499, HR1's round 1): eased only as they come while the map moves, never
  // on a frozen map's opening or redrawing, nor all at once as it goes live.
  const dots = useMemo(() => MAP_STATIONS.flatMap((s) => model.stations[s].here.map((k) => ({ key: dotKey(s, k) }))), [model.stations])
  const dotComings = useComings(dots, live && motion, false)
  const names = useMemo(() => new Map(model.agents.map((a) => [a.key, a.name])), [model.agents])
  return (
    <div
      className={cx('activity-map', mode === 'shared' && 'shared', !motion && 'still')}
      data-mode={mode}
      data-picked={picked ?? undefined}
      style={{ '--activity-map-width': `${width}px` } as React.CSSProperties}
      // Escape: an open panel closes first (HI-3498), then a call shown in the list (HI-3499), then back to every agent
      // of the selection (HI-3180).
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        const done = panel ? (setPanel(null), true) : !!onEscape?.() || (!!picked && (onPick?.(picked), true))
        if (done) e.stopPropagation()
      }}
    >
      <PaneResizer paneKey={MAP_PANE.key} min={MAP_PANE.min} max={MAP_PANE.max} keep={MAP_PANE.keep} />
      <div className="activity-map-board">
        {/* One agent's map of an agent with no running session (HI-3186): a plain line, never another agent's graph. */}
        {one && !one.running ? (
          <div className="pane-empty activity-map-idle" data-agent={one.key}>
            {tr(M.notRunning, { name: one.name })}
          </div>
        ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr(M.mapLabel)} className="activity-map-svg">
          <Defs ids={ids} />
          <g className="activity-map-comb" aria-hidden="true">
            {COMB.map((p, i) => (
              <polygon key={i} points={p} />
            ))}
          </g>
          {/* The warmth behind the centre (HI-3479): a warm light, stronger while an agent works. */}
          <circle className={cx('activity-map-halo', working > 0 && 'on')} cx={CX} cy={CY} r={SPOKE + 20} fill={`url(#${ids.halo})`} aria-hidden="true" />
          {MAP_STATIONS.map((s) => {
            const st = model.stations[s]
            // Its track, and over it its heat: wider and brighter with the calls of the last ten minutes (HI-3479).
            return (
              <g key={s} className={cx('activity-map-spoke', st.failed && 'failed', st.status === 'notReported' && 'na')} data-station={s} data-heat={st.heat}>
                <path d={SPOKES[s]} className="track" />
                <path d={SPOKES[s]} className="heat" filter={`url(#${ids.soft})`} style={{ strokeWidth: 1 + Math.min(5, st.heat / 3), opacity: st.heat ? 0.25 + Math.min(0.55, st.heat / 30) : 0 }} />
              </g>
            )
          })}
          {/* Pulses under the hexes: a comet along the spoke, out of the centre and into the station, or back (HI-3479). */}
          {motion &&
            pulses.map((pl) => {
              const fill = pl.failed ? 'var(--error)' : colourOf(colours.get(pl.agentKey))
              return (
                <g
                  key={pl.id}
                  className={cx('activity-map-pulse', pl.back && 'back', pl.failed && 'failed')}
                  data-station={pl.station}
                  style={{ '--spoke': `path('${SPOKES[pl.station]}')`, '--pulse': fill, ...(pl.follows ? { '--after': 'var(--activity-map-pulse-ms)' } : {}) } as React.CSSProperties}
                  // Done when its last dot lands (each dot's own end bubbles here).
                  onAnimationEnd={(e) => {
                    if ((e.target as Element).getAttribute('data-last') === 'yes') endPulse(pl.id)
                  }}
                >
                  {TAIL.map((t) => (
                    <circle key={t} className="tail" r={4.5 - t * 0.8} style={{ animationDelay: `calc(var(--after, 0ms) + ${t * 70}ms)`, fillOpacity: 0.6 - t * 0.13 }} data-last={t === TAIL.length - 1 ? 'yes' : undefined} />
                  ))}
                  <circle className="glow" r={13} style={{ fill: `url(#${ids.spark})` }} />
                  <circle className="head" r={5} />
                </g>
              )
            })}
          {MAP_STATIONS.map((s, i) => (
            <Station key={s} index={i} view={model.stations[s]} name={stationName(s)} colours={colours} ids={ids} open={panel === s} onToggle={togglePanel} names={names} onPick={onPick} arriving={dotComings.arriving} />
          ))}
          {!motion &&
            pulses.map((pl) => {
              const p = POS[pl.station]
              return <polygon key={pl.id} className={cx('activity-map-flash', pl.failed && 'failed')} data-station={pl.station} points={hexPoints(p.x, p.y, STATION_R)} onAnimationEnd={() => endPulse(pl.id)} />
            })}
          {one ? <Centre agent={one} showContext={show.context} ids={ids} /> : <SharedCentre title={title} agents={model.agents.length} working={working} waiting={waiting} ids={ids} />}
        </svg>
        )}
        {show.context && ringAgents.length > 0 && (
          <div className="activity-map-strip" role="list" aria-label={tr(M.stripLabel)}>
            {ringAgents.map((a, i) => (
              <button
                key={a.key}
                role="listitem"
                className={cx('activity-map-ring', a.key === picked && 'picked', comings.arriving.has(a.key) && 'arriving')}
                data-agent={a.key}
                data-load={a.load}
                aria-current={a.key === picked ? 'true' : undefined}
                title={tr(M.ringTip, { name: a.name, pct: a.context?.pct ?? 0, known: a.context?.pct != null ? 'yes' : 'no', load: a.load, shown: a.key === picked ? 'yes' : 'no' })} // i18n-ignore: a select's key, never shown
                onClick={() => onPick?.(a.key)}
              >
                <Ring pct={a.context?.pct ?? null} colour={colourOf(i)} hatched={a.load !== 'loaded'} />
                <span className="activity-map-ring-name">{a.name}</span>
                <span className="faint">{a.load === 'notLoaded' ? tr(M.notLoaded) : a.context?.pct != null ? tr(M.pct, { pct: a.context.pct }) : '—'}</span>
              </button>
            ))}
            {/* An agent that left (HI-3499): its ring fades out where the strip ends, then goes. */}
            {comings.leaving.map(({ item: a, index }) => (
              <span key={`leaving:${a.key}`} className="activity-map-ring leaving" data-agent={a.key} aria-hidden="true" onAnimationEnd={() => comings.gone(a.key)}>
                <Ring pct={a.context?.pct ?? null} colour={colourOf(index)} hatched={a.load !== 'loaded'} />
                <span className="activity-map-ring-name">{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {panel && <StationPanel station={panel} view={model.stations[panel]} model={model} name={stationName(panel)} colourOf={mode === 'shared' ? (k) => colourOf(colours.get(k)) : null} onClose={() => setPanel(null)} onOpenFile={onOpenFile} onShowCall={onShowCall} />}
      {show.feed && !panel && (
        <div className="activity-map-feed" aria-label={tr(M.feedHeading)}>
          <h4>{tr(M.feedHeading)}</h4>
          {model.feed.length === 0 ? (
            <div className="faint">{model.agents.some((a) => a.load === 'loading') ? tr(M.loading) : tr(M.noCalls)}</div>
          ) : (
            model.feed.map((c) => {
              const body = (
                <>
                  <span className="activity-map-feed-time">{c.at ? formatTime(c.at) : ''}</span>
                  {mode === 'shared' && <span className="activity-map-dot" style={{ background: colourOf(colours.get(c.agentKey)) }} />}
                  <span className="activity-map-feed-station">{stationName(c.station)}</span>
                  <span className="activity-map-feed-name">{c.kind === 'prompt' ? tr(M.prompt) : c.label}</span>
                </>
              )
              // A click shows the call in the list (HI-3499).
              return onShowCall && c.ref ? (
                <button key={c.key} className={cx('activity-map-feed-row', c.failed && 'failed')} data-station={c.station} title={tr(M.showInList)} onClick={() => onShowCall({ agentKey: c.agentKey, sessionKey: c.sessionKey, ref: c.ref, ...(c.kind ? { kind: c.kind } : {}) })}>
                  {body}
                </button>
              ) : (
                <div key={c.key} className={cx('activity-map-feed-row', c.failed && 'failed')} data-station={c.station} title={c.kind === 'prompt' ? tr(M.prompt) : c.label}>
                  {body}
                </div>
              )
            })
          )}
          {Object.values(model.stations).some((s) => s.partial) && <div className="faint activity-map-partial">{tr(M.partial)}</div>}
        </div>
      )}
    </div>
  )
})

/**
 * Agents arriving in a list and leaving it (HI-3499): those new since the last change, and those gone with their place,
 * kept until their fade-out ends (`gone`). Only while `moving` (shown, live, motion on): otherwise, and on the next
 * change, what was kept is dropped at once, so nothing waits on an animation that never ends (hidden, frozen). Bounded:
 * the last change's, at most MAP_AGENTS.
 */
function useComings<T extends { key: string }>(items: readonly T[], moving: boolean, keepLeaving = true): { arriving: ReadonlySet<string>; leaving: { item: T; index: number }[]; gone: (key: string) => void } {
  const prev = useRef<readonly T[] | null>(null)
  const [state, setState] = useState<{ arriving: ReadonlySet<string>; leaving: { item: T; index: number }[] }>(NO_COMINGS)
  useLayoutEffect(() => {
    const was = prev.current
    prev.current = items
    if (!moving || !was) {
      setState((s) => (s.arriving.size || s.leaving.length ? NO_COMINGS : s))
      return
    }
    const now = new Set(items.map((i) => i.key))
    const before = new Set(was.map((i) => i.key))
    const arriving = new Set(items.filter((i) => !before.has(i.key)).map((i) => i.key))
    const leaving = keepLeaving ? was.flatMap((item, index) => (now.has(item.key) ? [] : [{ item, index }])).slice(0, MAP_AGENTS) : []
    if (arriving.size || leaving.length) setState({ arriving, leaving })
  }, [items, moving, keepLeaving])
  const gone = useCallback((key: string) => setState((s) => ({ ...s, leaving: s.leaving.filter((x) => x.item.key !== key) })), [])
  return { ...(state as { arriving: ReadonlySet<string>; leaving: { item: T; index: number }[] }), gone }
}
const NO_COMINGS = { arriving: new Set<string>(), leaving: [] }
/** A station's agent dot, as `useComings` knows it. */
const dotKey = (station: MapStation, agentKey: string): string => `${station}:${agentKey}`

/** The ids of one map's gradients, filters and clips (HI-3479): unique, as a window can show more than one map. */
type MapIds = ReturnType<typeof useMapIds>
function useMapIds() {
  const base = useId().replace(/[^A-Za-z0-9_-]/g, '')
  return useMemo(
    () => ({
      glow: `${base}-glow`,
      soft: `${base}-soft`,
      cell: `${base}-cell`,
      honey: `${base}-honey`,
      halo: `${base}-halo`,
      spark: `${base}-spark`,
      ring: `${base}-ring`,
      clip: (s: MapStation) => `${base}-clip-${s}`
    }),
    [base]
  )
}

/** The map's gradients and filters (HI-3479): drawn in the theme's colours, so both themes have them. */
function Defs({ ids }: { ids: MapIds }) {
  return (
    <defs>
      <filter id={ids.glow} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="5" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id={ids.soft} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.5" />
      </filter>
      <linearGradient id={ids.cell} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" className="activity-map-stop-cell-top" />
        <stop offset="1" className="activity-map-stop-cell-bottom" />
      </linearGradient>
      <linearGradient id={ids.honey} x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" className="activity-map-stop-honey-deep" />
        <stop offset="1" className="activity-map-stop-honey-light" />
      </linearGradient>
      <radialGradient id={ids.halo}>
        <stop offset="0" className="activity-map-stop-halo" />
        <stop offset="1" className="activity-map-stop-clear" />
      </radialGradient>
      <radialGradient id={ids.spark}>
        <stop offset="0" className="activity-map-stop-spark" />
        <stop offset="1" className="activity-map-stop-clear" />
      </radialGradient>
      <linearGradient id={ids.ring} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" className="activity-map-stop-ring-light" />
        <stop offset="1" className="activity-map-stop-ring-deep" />
      </linearGradient>
    </defs>
  )
}

/**
 * A station's panel (HI-3498), docked where the feed is: what is behind it, from the map's own model (`stationPanel`),
 * names only. Read and Edit's files open in Files; how long something has run is said as of this drawing (no timer).
 */
function StationPanel({ station, view, model, name, colourOf: dot, onClose, onOpenFile, onShowCall }: { station: MapStation; view: MapStationView; model: MapModel; name: string; colourOf: ((agentKey: string) => string) | null; onClose: () => void; onOpenFile?: (agentKey: string, path: string) => void; onShowCall?: (call: MapCallRef) => void }) {
  const panel = useMemo(() => stationPanel(model, station), [model, station])
  const now = Date.now()
  const time = (r: MapPanelRow): string => {
    if (r.running) return r.running.since ? durationText(Math.max(0, now - r.running.since), tr) : ''
    const t = Date.parse(r.at ?? '')
    return Number.isFinite(t) ? formatTime(r.at!) : ''
  }
  const label = (r: MapPanelRow): string => {
    if (r.prompt) return tr(M.prompt)
    if (r.running && r.running.kind !== 'process') return tr(M.runningKind, { kind: r.running.kind, type: r.running.type ?? 'other' })
    return r.path ?? r.label
  }
  const detail = (r: MapPanelRow): string => {
    if (r.running?.kind === 'process' && r.running.pid !== undefined) return tr(M.panelPid, { pid: r.running.pid })
    if (r.running?.kind === 'subagent' && r.running.state) return tr(M.state, { state: r.running.state })
    if (r.count && r.count > 1) return tr(M.panelCalls, { n: r.count })
    return ''
  }
  return (
    <div className="activity-map-panel" data-station={station} role="region" aria-label={name}>
      <div className="activity-map-panel-head">
        <span className="activity-map-panel-name">{name}</span>
        <span className="faint">{view.status === 'ok' ? tr(M.panelSummary, { n: view.count, heat: view.heat }) : tr(M.loading)}</span>
        <button className="activity-map-panel-close" aria-label={tr(M.panelClose)} title={tr(M.panelClose)} onClick={onClose}>
          ✕
        </button>
      </div>
      {panel.sections.length === 0 ? (
        <div className="faint">{tr(M.panelEmpty)}</div>
      ) : (
        panel.sections.map((sec) => (
          <div key={sec.id} className="activity-map-panel-section" data-section={sec.id}>
            <h5>{tr(M.panelSection, { section: sec.id })}</h5>
            {sec.rows.map((r) => {
              const opens = !!(r.path && onOpenFile)
              const shows = !!(onShowCall && r.call?.ref)
              const body = (
                <>
                  {dot && <span className="activity-map-dot" style={{ background: dot(r.agentKey) }} />}
                  {r.running && <span className={cx('activity-map-panel-live', r.running.kind)} aria-hidden="true" />}
                  {r.open && !r.running && <span className="activity-map-panel-live" aria-hidden="true" />}
                  <span className="activity-map-panel-label" title={r.path ?? (r.prompt ? undefined : r.label)}>
                    {label(r)}
                  </span>
                  {r.tools && r.tools.length > 0 && (
                    <span className="activity-map-panel-tools">
                      {r.tools.slice(0, 4).map((t) => (
                        <span key={t} className="activity-map-panel-tool">
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="faint activity-map-panel-detail">{detail(r)}</span>
                  {!(shows && opens) && <span className="activity-map-panel-time">{time(r)}</span>}
                  {opens && <span className="activity-map-panel-open">{tr(M.panelOpen)}</span>}
                </>
              )
              // A file: the row opens it in Files, its time shows its newest call in the list (HI-3499).
              if (opens)
                return (
                  <div key={r.key} className={cx('activity-map-panel-row', 'activity-map-panel-file', r.failed && 'failed')} data-kind={r.kind}>
                    <button className="activity-map-panel-main" title={tr(M.panelOpenTip, { path: r.path! })} onClick={() => onOpenFile!(r.agentKey, r.path!)}>
                      {body}
                    </button>
                    {shows && (
                      <button className="activity-map-panel-time link" title={tr(M.showInList)} onClick={() => onShowCall!(r.call!)}>
                        {time(r)}
                      </button>
                    )}
                  </div>
                )
              // A call: the row shows it in the list (HI-3499).
              return shows ? (
                <button key={r.key} className={cx('activity-map-panel-row', r.failed && 'failed')} data-kind={r.kind} title={tr(M.showInList)} onClick={() => onShowCall!(r.call!)}>
                  {body}
                </button>
              ) : (
                <div key={r.key} className={cx('activity-map-panel-row', r.failed && 'failed')} data-kind={r.kind}>
                  {body}
                </div>
              )
            })}
            {sec.more > 0 && <div className="faint activity-map-panel-more">{tr(M.panelMore, { n: sec.more })}</div>}
          </div>
        ))
      )}
    </div>
  )
}

function Station({ index, view: st, name, colours, ids, open, onToggle, names, onPick, arriving }: { index: number; view: MapStationView; name: string; colours: ReadonlyMap<string, number | undefined>; ids: MapIds; open: boolean; onToggle: (s: MapStation) => void; names: ReadonlyMap<string, string>; onPick?: (key: string) => void; arriving: ReadonlySet<string> }) {
  const p = POS[st.station]
  const active = st.here.length > 0
  const waitingHere = st.station === 'you' && active
  const sub = st.status === 'notReported' ? tr(M.notReported) : st.status === 'loading' ? tr(M.loading) : tr(M.count, { n: st.count })
  const last = st.lastKind === 'prompt' ? tr(M.prompt) : st.last
  const title = stationTitle(st, name, last)
  const load = stationLoad(st)
  const pips = Math.min(MAX_PIPS, st.running)
  return (
    <g
      className={cx('activity-map-station', active && 'active', (st.failed || waitingHere) && 'failed', st.status !== 'ok' && st.status, open && 'open')}
      data-station={st.station}
      data-count={st.count}
      data-status={st.status}
      data-failed={st.failed ? 'yes' : 'no'}
      data-load={load.toFixed(2)}
      data-running={st.running}
      // A click (or Enter, Space) opens its panel, and closes it again (HI-3498).
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={title}
      onClick={() => onToggle(st.station)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onToggle(st.station)
      }}
    >
      <title>{title}</title>
      {/* Its outline first: the e2e measures each text against it. */}
      <polygon className="activity-map-cell" points={hexPoints(p.x, p.y, STATION_R)} fill={`url(#${ids.cell})`} />
      {/* The honey (HI-3479): its load, filling the hex from its base, rising and settling smoothly. */}
      <clipPath id={ids.clip(st.station)}>
        <polygon points={hexPoints(p.x, p.y, STATION_R - 1.5)} />
      </clipPath>
      <g clipPath={`url(#${ids.clip(st.station)})`} aria-hidden="true">
        <path className="activity-map-honey" d={honeyPath(p.x, p.y, STATION_R)} fill={`url(#${ids.honey})`} style={{ transform: `translateY(${(STATION_R * (1 - 2 * load) + (load ? 0 : 4)).toFixed(1)}px)` }} />
      </g>
      <polygon className="activity-map-bevel" points={hexPoints(p.x, p.y, STATION_R - 4)} aria-hidden="true" />
      {/* Lit while a call is open there, settling slowly once it ends. */}
      <polygon className="activity-map-lit" points={hexPoints(p.x, p.y, STATION_R + 1)} filter={`url(#${ids.glow})`} aria-hidden="true" />
      <text x={p.x} y={p.y - 12} className="activity-map-station-name">
        {name}
      </text>
      <text x={p.x} y={p.y + 4} className="activity-map-station-sub">
        {waitingHere ? tr(M.needsYou) : sub}
      </text>
      {last && st.status === 'ok' && (
        <text x={p.x} y={p.y + 20} className="activity-map-station-last">
          {stationLastShown(last, st.station, lastFits() ?? undefined)}
        </text>
      )}
      {/* The agents with a call open here (shared map): a click shows that agent's map alone (HI-3499), as its ring does. */}
      {colours.size > 1 &&
        st.here.slice(0, 6).map((k, i, all) => {
          const label = tr(M.focusAgent, { name: names.get(k) ?? k })
          const pick = (e: React.SyntheticEvent): void => {
            e.stopPropagation()
            onPick?.(k)
          }
          return (
            <circle
              key={k}
              className={cx('activity-map-here', arriving.has(dotKey(st.station, k)) && 'arriving')}
              data-agent={k}
              cx={p.x - (all.length - 1) * 6 + i * 12}
              cy={p.y + 34}
              r={4}
              style={{ fill: colourOf(colours.get(k)) }}
              {...(onPick
                ? {
                    role: 'button',
                    tabIndex: 0,
                    'aria-label': label,
                    onClick: pick,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      pick(e)
                    }
                  }
                : {})}
            >
              {onPick && <title>{label}</title>}
            </circle>
          )
        })}
      {/* What runs there now (HI-3479): a small lit cell each, outside the hex (its count and hover say how many). */}
      {pips > 0 && (
        <g className="activity-map-pips" aria-hidden="true">
          {Array.from({ length: pips }, (_, j) => {
            const c = pipAt(index, j, pips)
            return <polygon key={j} points={hexPoints(c.x, c.y, PIP_R)} filter={`url(#${ids.glow})`} />
          })}
        </g>
      )}
    </g>
  )
}

function Centre({ agent: a, showContext, ids }: { agent: MapModel['agents'][number]; showContext: boolean; ids: MapIds }) {
  const level = contextLevel(a.context?.pct)
  const doing = a.waiting ? tr(M.needsYou) : a.doing ? tr(M.doing, { doing: a.doing }) : tr(M.state, { state: a.state })
  return (
    <g className={cx('activity-map-centre', a.waiting && 'waiting', a.state === 'working' && 'working')} data-agent={a.key}>
      <polygon className="activity-map-cell" points={hexPoints(CX, CY, CENTRE_R)} fill={`url(#${ids.cell})`} />
      <polygon className="activity-map-bevel" points={hexPoints(CX, CY, CENTRE_R - 5)} aria-hidden="true" />
      {showContext && (
        <g className={cx('activity-map-context', level)} data-level={level} data-pct={a.context?.pct ?? ''}>
          <path d={hexPath(CX, CY, CENTRE_R + 8)} className="track" />
          {/* Filling smoothly as it changes (HI-3479), glowing; the theme's honey while it is fine, amber and red as they were. */}
          {/* None at 0 %: a round cap would draw a dot. */}
          {!!a.context?.pct && (
            <path d={hexPath(CX, CY, CENTRE_R + 8)} className="fill" pathLength={100} filter={`url(#${ids.glow})`} style={{ strokeDasharray: `${a.context.pct} 100`, ...(level === 'ok' ? { stroke: `url(#${ids.ring})` } : {}) }} />
          )}
        </g>
      )}
      <text x={CX} y={CY - 22} className="activity-map-centre-name">
        {short(a.name, 16)}
      </text>
      <text x={CX} y={CY} className="activity-map-centre-doing">
        {doing}
      </text>
      {a.card && (
        <text x={CX} y={CY + 18} className="activity-map-centre-card">
          {short(a.card, 26)}
        </text>
      )}
      {showContext && (
        <text x={CX} y={CY + 38} className={cx('activity-map-centre-context', level)}>
          {a.context?.pct != null ? tr(M.context, { pct: a.context.pct }) : tr(M.contextUnknown)}
        </text>
      )}
    </g>
  )
}

function SharedCentre({ title, agents, working, waiting, ids }: { title: string; agents: number; working: number; waiting: number; ids: MapIds }) {
  return (
    <g className={cx('activity-map-centre', waiting > 0 && 'waiting', working > 0 && 'working')}>
      <polygon className="activity-map-cell" points={hexPoints(CX, CY, CENTRE_R - 6)} fill={`url(#${ids.cell})`} />
      <polygon className="activity-map-bevel" points={hexPoints(CX, CY, CENTRE_R - 11)} aria-hidden="true" />
      <text x={CX} y={CY - 14} className="activity-map-centre-name">
        {short(title, 16)}
      </text>
      <text x={CX} y={CY + 6} className="activity-map-centre-doing">
        {tr(M.agentsWorking, { agents, working })}
      </text>
      {waiting > 0 && (
        <text x={CX} y={CY + 24} className="activity-map-centre-card waiting">
          {tr(M.needYou, { n: waiting })}
        </text>
      )}
    </g>
  )
}

function Ring({ pct, colour, hatched }: { pct: number | null; colour: string; hatched: boolean }) {
  const level = contextLevel(pct)
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden="true" className={cx('activity-map-ring-mark', level, hatched && 'hatched')}>
      <path d={hexPath(13, 13, 10)} className="track" />
      {!!pct && <path d={hexPath(13, 13, 10)} className="fill" pathLength={100} style={{ strokeDasharray: `${pct} 100` }} />}
      <circle cx={13} cy={13} r={3.5} style={{ fill: colour }} />
    </svg>
  )
}

/** The Show toggles above the Activity list: the map, its feed and its context rings. */
export function MapToggles({ show, onChange }: { show: MapShow; onChange: (s: MapShow) => void }) {
  const button = (k: keyof MapShow, label: string, disabled = false) => (
    <button className={cx('activity-map-toggle', show[k] && 'on') /* i18n-ignore: class names */} aria-pressed={show[k]} disabled={disabled} data-toggle={k} onClick={() => onChange({ ...show, [k]: !show[k] })}>
      {label}
    </button>
  )
  return (
    <span className="activity-map-toggles" role="group" aria-label={tr(M.show)}>
      <span className="faint">{tr(M.show)}</span>
      <span className="activity-map-seg">
        {button('map', tr(M.toggleMap))}
        {button('feed', tr(M.toggleFeed), !show.map)}
        {button('context', tr(M.toggleContext), !show.map)}
      </span>
    </span>
  )
}

const M = {
  mapLabel: msg({ id: 'activity.map.label', defaultMessage: 'Activity map', description: "The Activity tab's map (a honeycomb of what agents do), for screen readers." }),
  station: msg({ id: 'activity.map.station', defaultMessage: '{station, select, you {You} read {Read} edit {Edit} shell {Shell} agents {Agents} other {Tools}}', description: "A station on the Activity map: where an agent's tool calls go. You: its prompts and questions to you; Read: reading and searching files; Edit: changing files; Shell: commands; Agents: subagents and background tasks; Tools: everything else (the web, skills, Combwork's tools, other tools). Keep each one short." }),
  count: msg({ id: 'activity.map.count', defaultMessage: '{n, number} this turn', description: "Under a station's name on the Activity map: how many of the agent's tool calls in its current turn went there." }),
  notReported: msg({ id: 'activity.map.notReported', defaultMessage: 'not reported', description: "Under a station's name on the Activity map when the agent's CLI doesn't report that kind of call (not an observed zero). Lower case." }),
  loading: msg({ id: 'activity.map.loading', defaultMessage: 'loading…', description: "Under a station's name on the Activity map, and in its feed, while the agent's calls haven't been read yet. Lower case." }),
  needsYou: msg({ id: 'activity.map.needsYou', defaultMessage: 'Needs you', description: 'On the Activity map: the agent waits for you (a question or a permission prompt).' }),
  needYou: msg({ id: 'activity.map.needYou', defaultMessage: '{n, plural, one {# needs you} other {# need you}}', description: "In the centre of the Activity map's shared view: how many agents wait for you." }),
  agentsWorking: msg({ id: 'activity.map.agentsWorking', defaultMessage: '{agents, plural, one {# agent} other {# agents}} · {working, number} working', description: "In the centre of the Activity map's shared view: how many agents it shows, and how many of them work." }),
  doing: msg({ id: 'activity.map.doing', defaultMessage: '{doing, select, tool {Using a tool} writing {Writing} other {Thinking}}', description: "In the centre of the Activity map: what the agent does now." }),
  state: msg({ id: 'activity.map.state', defaultMessage: '{state, select, working {Working} waiting {Waiting for you} failed {Failed or stalled} done {Done} other {Idle}}', description: "In the centre of the Activity map: the agent's state when it isn't working." }),
  cardRole: msg({ id: 'activity.map.cardRole', defaultMessage: '{card} · {role, select, builder {builder} other {reviewer}}', description: "In the centre of the Activity map: the agent's card ({card}, its key) and its role on it. Lower case role." }),
  context: msg({ id: 'activity.map.context', defaultMessage: 'Context {pct, number}%', description: "In the centre of the Activity map: how full the agent's context window is, in percent (as its pane footer shows)." }),
  contextUnknown: msg({ id: 'activity.map.contextUnknown', defaultMessage: 'Context —', description: "In the centre of the Activity map when the agent's context isn't known (no usage yet, or no window reported)." }),
  pct: msg({ id: 'activity.map.pct', defaultMessage: '{pct, number}%', description: "Beside an agent's ring on the Activity map's shared view: how full its context is, in percent." }),
  notLoaded: msg({ id: 'activity.map.notLoaded', defaultMessage: 'not shown', description: "Beside an agent's ring on the Activity map's shared view when it is past the agents the map reads (eight): its calls aren't on the map. Lower case." }),
  ringTip: msg({ id: 'activity.map.ringTipShown', defaultMessage: '{name}: {load, select, notLoaded {past the eight agents the map reads, so its calls aren’t shown} loading {its calls are being read} other {{known, select, no {context not known} other {context {pct, number}%}}}}. {shown, select, yes {Shown on the map: click to show every agent again (or press Escape).} other {Click to show its map; the others stay listed here.}}', description: "Hover of an agent's ring in the Activity map's strip of the agents selected (HI-3180). {name} is the agent; {pct} its context in percent; known no: its context isn't known; shown yes: the map shows this agent alone now (a click shows all of them again), else it shows them all or another one. Keep the select keys." }),
  notRunning: msg({ id: 'activity.map.notRunning', defaultMessage: '{name} isn’t running, so there’s nothing to show on the map.', description: "The Activity map in place of one agent's graph when that agent has no running session (HI-3186): never started since Combwork opened, or stopped. {name} is the agent. The strip of the other agents stays below it." }),
  stripLabel: msg({ id: 'activity.map.stripLabel', defaultMessage: "Agents' context", description: "The Activity map's strip of the agents' context rings, for screen readers." }),
  feedHeading: msg({ id: 'activity.map.feedHeading', defaultMessage: 'Last actions', description: "The heading of the Activity map's feed: the agents' latest tool calls." }),
  noCalls: msg({ id: 'activity.map.noCalls', defaultMessage: 'No tool calls yet.', description: "The Activity map's feed when the agents shown have made no tool call in the turns read." }),
  partial: msg({ id: 'activity.map.partial', defaultMessage: 'From the latest calls read: not the whole history.', description: "Under the Activity map's feed when its counts are a sample (an agent made more calls than the map counts, or more agents run than it reads)." }),
  prompt: msg({ id: 'activity.map.prompt', defaultMessage: 'Prompt', description: "On the Activity map and its feed: a prompt the agent was given (at the You station), named by this word only, never its text." }),
  show: msg({ id: 'activity.map.show', defaultMessage: 'Show', description: "Before the Activity tab's toggles for its map: Map, Feed, Context." }),
  toggleMap: msg({ id: 'activity.map.toggleMap', defaultMessage: 'Map', description: "A toggle above the Activity tab: show its map (a honeycomb of what agents do)." }),
  toggleFeed: msg({ id: 'activity.map.toggleFeed', defaultMessage: 'Feed', description: "A toggle above the Activity tab: show the map's feed of the last actions." }),
  runningKind: msg({ id: 'activity.map.runningKind', defaultMessage: '{kind, select, subagent {Subagent} other {{type, select, command {Command} monitor {Monitor} subagent {Subagent task} workflow {Workflow} other {Background task}}}}', description: "A row in a station's panel on the Activity map (HI-3498): something running that has no name of its own, by its kind: a subagent session, or a background task by its type (a command, a monitor, a subagent's task, a workflow). Keep the select keys." }),
  panelPid: msg({ id: 'activity.map.panelPid', defaultMessage: 'process {pid}', description: "Beside a running program in the Shell panel of the Activity map (HI-3498): its process id. Lower case." }),
  panelCalls: msg({ id: 'activity.map.panelCalls', defaultMessage: '{n, plural, one {# call} other {# calls}}', description: "Beside a file, server, site or tool in a station's panel on the Activity map (HI-3498): how many of the calls read went to it." }),
  panelSummary: msg({ id: 'activity.map.panelSummary', defaultMessage: '{n, plural, one {# call} other {# calls}} this turn · {heat, plural, one {# call} other {# calls}} in the last ten minutes', description: "Under a station's name at the top of its panel on the Activity map (HI-3498): its calls in the agent's current turn, and in the last ten minutes of the turns read." }),
  panelClose: msg({ id: 'activity.map.panelClose', defaultMessage: 'Close (Esc)', description: "The close button of a station's panel on the Activity map (HI-3498), for its hover and screen readers. Esc is the Escape key." }),
  panelEmpty: msg({ id: 'activity.map.panelEmpty', defaultMessage: 'Nothing here in the turns read.', description: "A station's panel on the Activity map (HI-3498) when nothing ran or was called there in the agent's turns that were read." }),
  panelSection: msg({ id: 'activity.map.panelSection', defaultMessage: '{section, select, running {Running now} thisTurn {This turn} files {Files} subagents {Subagents} tasks {Background tasks} servers {MCP servers} web {Web} skills {Skills} other {Other tools}}', description: "A heading in a station's panel on the Activity map (HI-3498): what runs now, this turn's calls, the files read or changed, subagents, background tasks, MCP servers (with their tools), web sites, skills, and other tools. Keep the select keys." }),
  panelMore: msg({ id: 'activity.map.panelMore', defaultMessage: '{n, plural, one {and # more} other {and # more}}', description: "Under a section of a station's panel on the Activity map (HI-3498) when it lists only the first ten: how many more there are." }),
  panelOpen: msg({ id: 'activity.map.panelOpen', defaultMessage: 'Open', description: "At the end of a file's row in the Read or Edit panel of the Activity map (HI-3498): opens the file in the Files tab." }),
  panelOpenTip: msg({ id: 'activity.map.panelOpenTip', defaultMessage: 'Open {path} in Files', description: "Hover of a file's row in the Read or Edit panel of the Activity map (HI-3498). {path} is the file's path; Files is the tab's name: use it as the tab is named." }),
  panelNoFile: msg({ id: 'activity.map.panelNoFile', defaultMessage: '{path} isn’t a file in the project now', description: "A notice when a file chosen in the Activity map's Read or Edit panel (HI-3498) can't be opened in Files: it was moved or deleted since, or is outside the workspace's projects. {path} is its path as the agent named it." }),
  showInList: msg({ id: 'activity.map.showInList', defaultMessage: 'Show in the list', description: "Hover of a call in the Activity map's feed or a station's panel (HI-3499): a click shows that call in the Activity list beside the map, selected, with its details." }),
  callGone: msg({ id: 'activity.map.callGone', defaultMessage: 'That call isn’t in what Activity has read now', description: "A notice when a call chosen on the Activity map (HI-3499) can't be shown in the list: its agent's session restarted since, or its turn is no longer among those read." }),
  focusAgent: msg({ id: 'activity.map.focusAgent', defaultMessage: 'Show {name}’s map alone', description: "Hover and screen-reader name of an agent's coloured dot on a station of the Activity map's shared view (HI-3499): a click shows that agent's map alone. {name} is the agent." }),
  toggleContext: msg({ id: 'activity.map.toggleContext', defaultMessage: 'Context', description: "A toggle above the Activity tab: show the agents' context rings on the map." })
}
