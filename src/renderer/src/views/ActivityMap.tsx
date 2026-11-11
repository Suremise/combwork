// The Activity map (HI-2903): the Activity tab's reads drawn as a honeycomb (shared/activityMap.ts has the model). One
// agent in the filter shows its map; none or several, one shared map, each agent its own colour. It draws from the same
// reads as the list (frozen or live), animates only while shown, live and on, and reads nothing of its own while hidden.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activityTabs, buildActivityView, type ActivityFilter, type ActivityInput, type ActivityTabInfo } from '@shared/activity'
import { MAP_AGENTS, MAP_STATIONS, addPulses, agentColour, buildMapModel, contextLevel, diffPulses, mapContextKey, type MapAgentInput, type MapContext, type MapModel, type MapPulse, type MapStation, type MapStationView } from '@shared/activityMap'
import { ACTIVITY_MAP_MOTION } from '@shared/advanced'
import { boundedQueue } from '@shared/coalesce'
import { formatTime } from '@shared/dates'
import { contextShown } from '@shared/defaults'
import { msg, tr } from '@shared/i18n'
import { providerDescriptor } from '@shared/providers'
import type { ProjectInfo } from '@shared/types'
import { call } from '../api'
import { useAdvancedValue } from '../advanced'
import { useStore } from '../store'
import { cx } from '../util'
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

/** A session's key in the map: its host's path (lower-cased) and its id, as the workspace level keys its reads. */
const sessionKey = (path: string, id: string): string => `${path.toLowerCase()}\n${id}`
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
      tasks: part ? part.subagents.flatMap((n) => (n.kind === 'task' ? [{ type: n.task.type }] : [])) : [],
      processes: part ? part.processes.flatMap((n) => (n.kind === 'process' && !n.gone ? [n.process.name] : [])) : [],
      blocks: part?.blocks.length ?? 0,
      ...(provider && providerDescriptor(provider).capabilities.activityStations ? { reported: providerDescriptor(provider).capabilities.activityStations } : {})
    }
  })
}

/**
 * Each shown agent's context, as its pane footer has it (contextShown over session:usage), read again when the project's
 * usage changes (usageVersion): only while the map and its context are shown, two at a time, the first MAP_AGENTS agents.
 * Null for one not known (no usage yet): never a zero.
 */
export function useMapContexts(on: boolean, entries: readonly MapEntry[]): ReadonlyMap<string, MapContext | null> {
  const versions = useStore((s) => s.usageVersion)
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
export function useActivityMap(o: { active: boolean; animate: boolean; scope: string; entries: readonly MapEntry[]; contexts: ReadonlyMap<string, MapContext | null>; mode: 'single' | 'shared'; at: number }): { model: MapModel; pulses: MapPulse[]; endPulse: (id: string) => void } {
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
  return { model, pulses, endPulse }
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
const short = (s: string, n = 24): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

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
  /** The shared map: show only this agent (the strip's click). */
  onPick?: (key: string) => void
}

/** The map: stations, spokes, pulses, the centre, the feed and (shared) the agents' context rings. */
export const ActivityMap = memo(function ActivityMap({ mode, title, model, pulses, endPulse, show, onPick }: ActivityMapProps) {
  const motion = useMotion()
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
  return (
    <div className={cx('activity-map', mode === 'shared' && 'shared')} data-mode={mode}>
      <div className="activity-map-board">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr(M.mapLabel)} className="activity-map-svg">
          <g className="activity-map-comb" aria-hidden="true">
            {COMB.map((p, i) => (
              <polygon key={i} points={p} />
            ))}
          </g>
          {MAP_STATIONS.map((s) => {
            const st = model.stations[s]
            const p = POS[s]
            return <line key={s} className={cx('activity-map-spoke', st.failed && 'failed', st.status === 'notReported' && 'na')} x1={CX} y1={CY} x2={p.x} y2={p.y} strokeWidth={1.5 + Math.min(5, st.heat / 3)} data-heat={st.heat} />
          })}
          {/* Pulses under the hexes: out of the centre and into the station, or back. */}
          {motion &&
            pulses.map((pl) => {
              const p = POS[pl.station]
              return (
                <g key={pl.id} transform={`translate(${CX} ${CY})`}>
                  <circle
                    className={cx('activity-map-pulse', pl.back && 'back', pl.failed && 'failed')}
                    r={6}
                    data-station={pl.station}
                    style={{ '--dx': `${(p.x - CX).toFixed(1)}px`, '--dy': `${(p.y - CY).toFixed(1)}px`, fill: pl.failed ? 'var(--error)' : colourOf(colours.get(pl.agentKey)) } as React.CSSProperties}
                    onAnimationEnd={() => endPulse(pl.id)}
                  />
                </g>
              )
            })}
          {MAP_STATIONS.map((s) => (
            <Station key={s} view={model.stations[s]} name={stationName(s)} colours={colours} />
          ))}
          {!motion &&
            pulses.map((pl) => {
              const p = POS[pl.station]
              return <polygon key={pl.id} className={cx('activity-map-flash', pl.failed && 'failed')} data-station={pl.station} points={hexPoints(p.x, p.y, STATION_R)} onAnimationEnd={() => endPulse(pl.id)} />
            })}
          {one ? <Centre agent={one} showContext={show.context} /> : <SharedCentre title={title} agents={model.agents.length} working={working} waiting={waiting} />}
        </svg>
        {mode === 'shared' && show.context && model.agents.length > 0 && (
          <div className="activity-map-strip" role="list" aria-label={tr(M.stripLabel)}>
            {model.agents.map((a, i) => (
              <button key={a.key} role="listitem" className="activity-map-ring" data-agent={a.key} data-load={a.load} title={tr(M.ringTip, { name: a.name, pct: a.context?.pct ?? 0, known: a.context?.pct != null ? 'yes' : 'no', load: a.load })} onClick={() => onPick?.(a.key)}>
                <Ring pct={a.context?.pct ?? null} colour={colourOf(i)} hatched={a.load !== 'loaded'} />
                <span className="activity-map-ring-name">{a.name}</span>
                <span className="faint">{a.load === 'notLoaded' ? tr(M.notLoaded) : a.context?.pct != null ? tr(M.pct, { pct: a.context.pct }) : '—'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {show.feed && (
        <div className="activity-map-feed" aria-label={tr(M.feedHeading)}>
          <h4>{tr(M.feedHeading)}</h4>
          {model.feed.length === 0 ? (
            <div className="faint">{model.agents.some((a) => a.load === 'loading') ? tr(M.loading) : tr(M.noCalls)}</div>
          ) : (
            model.feed.map((c) => (
              <div key={c.key} className={cx('activity-map-feed-row', c.failed && 'failed')} data-station={c.station}>
                <span className="activity-map-feed-time">{c.at ? formatTime(c.at) : ''}</span>
                {mode === 'shared' && <span className="activity-map-dot" style={{ background: colourOf(colours.get(c.agentKey)) }} />}
                <span className="activity-map-feed-station">{stationName(c.station)}</span>
                <span className="activity-map-feed-name" title={c.kind === 'prompt' ? tr(M.prompt) : c.label}>
                  {c.kind === 'prompt' ? tr(M.prompt) : c.label}
                </span>
              </div>
            ))
          )}
          {Object.values(model.stations).some((s) => s.partial) && <div className="faint activity-map-partial">{tr(M.partial)}</div>}
        </div>
      )}
    </div>
  )
})

function Station({ view: st, name, colours }: { view: MapStationView; name: string; colours: ReadonlyMap<string, number | undefined> }) {
  const p = POS[st.station]
  const active = st.here.length > 0
  const waitingHere = st.station === 'you' && active
  const sub = st.status === 'notReported' ? tr(M.notReported) : st.status === 'loading' ? tr(M.loading) : tr(M.count, { n: st.count })
  const last = st.lastKind === 'prompt' ? tr(M.prompt) : st.last
  const title = st.status === 'ok' ? tr(M.stationTip, { station: name, n: st.count, heat: st.heat, last: last || 'none' }) : `${name}: ${sub}`
  return (
    <g className={cx('activity-map-station', active && 'active', (st.failed || waitingHere) && 'failed', st.status !== 'ok' && st.status)} data-station={st.station} data-count={st.count} data-status={st.status} data-failed={st.failed ? 'yes' : 'no'}>
      <title>{title}</title>
      <polygon points={hexPoints(p.x, p.y, STATION_R)} />
      <text x={p.x} y={p.y - 12} className="activity-map-station-name">
        {name}
      </text>
      <text x={p.x} y={p.y + 4} className="activity-map-station-sub">
        {waitingHere ? tr(M.needsYou) : sub}
      </text>
      {last && st.status === 'ok' && (
        <text x={p.x} y={p.y + 20} className="activity-map-station-last">
          {short(last)}
        </text>
      )}
      {colours.size > 1 &&
        st.here.slice(0, 6).map((k, i, all) => <circle key={k} cx={p.x - (all.length - 1) * 6 + i * 12} cy={p.y + 34} r={4} style={{ fill: colourOf(colours.get(k)) }} />)}
    </g>
  )
}

function Centre({ agent: a, showContext }: { agent: MapModel['agents'][number]; showContext: boolean }) {
  const level = contextLevel(a.context?.pct)
  const doing = a.waiting ? tr(M.needsYou) : a.doing ? tr(M.doing, { doing: a.doing }) : tr(M.state, { state: a.state })
  return (
    <g className={cx('activity-map-centre', a.waiting && 'waiting')} data-agent={a.key}>
      <polygon points={hexPoints(CX, CY, CENTRE_R)} />
      {showContext && (
        <g className={cx('activity-map-context', level)} data-level={level} data-pct={a.context?.pct ?? ''}>
          <path d={hexPath(CX, CY, CENTRE_R + 8)} className="track" />
          {a.context?.pct != null && <path d={hexPath(CX, CY, CENTRE_R + 8)} className="fill" pathLength={100} strokeDasharray={`${a.context.pct} 100`} />}
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

function SharedCentre({ title, agents, working, waiting }: { title: string; agents: number; working: number; waiting: number }) {
  return (
    <g className={cx('activity-map-centre', waiting > 0 && 'waiting')}>
      <polygon points={hexPoints(CX, CY, CENTRE_R - 6)} />
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
      {pct !== null && <path d={hexPath(13, 13, 10)} className="fill" pathLength={100} strokeDasharray={`${pct} 100`} />}
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
  ringTip: msg({ id: 'activity.map.ringTip', defaultMessage: '{name}: {load, select, notLoaded {past the eight agents the map reads, so its calls aren’t shown} loading {its calls are being read} other {{known, select, no {context not known} other {context {pct, number}%}}}}. Click to show only this agent.', description: "Hover of an agent's ring on the Activity map's shared view. {name} is the agent; {pct} its context in percent; known no: its context isn't known. Keep the select keys." }),
  stripLabel: msg({ id: 'activity.map.stripLabel', defaultMessage: "Agents' context", description: "The Activity map's strip of the agents' context rings, for screen readers." }),
  feedHeading: msg({ id: 'activity.map.feedHeading', defaultMessage: 'Last actions', description: "The heading of the Activity map's feed: the agents' latest tool calls." }),
  noCalls: msg({ id: 'activity.map.noCalls', defaultMessage: 'No tool calls yet.', description: "The Activity map's feed when the agents shown have made no tool call in the turns read." }),
  partial: msg({ id: 'activity.map.partial', defaultMessage: 'From the latest calls read: not the whole history.', description: "Under the Activity map's feed when its counts are a sample (an agent made more calls than the map counts, or more agents run than it reads)." }),
  stationTip: msg({ id: 'activity.map.stationTip', defaultMessage: '{station}: {n, plural, one {# call} other {# calls}} this turn, {heat, plural, one {# call} other {# calls}} in the last ten minutes of the turns read. Last: {last, select, none {none} other {{last}}}', description: "Hover of a station on the Activity map. {station} is its name, {n} and {heat} counts, {last} the last call's name (a file, a host or a tool), none when there is none. Keep the select keys." }),
  prompt: msg({ id: 'activity.map.prompt', defaultMessage: 'Prompt', description: "On the Activity map and its feed: a prompt the agent was given (at the You station), named by this word only, never its text." }),
  show: msg({ id: 'activity.map.show', defaultMessage: 'Show', description: "Before the Activity tab's toggles for its map: Map, Feed, Context." }),
  toggleMap: msg({ id: 'activity.map.toggleMap', defaultMessage: 'Map', description: "A toggle above the Activity tab: show its map (a honeycomb of what agents do)." }),
  toggleFeed: msg({ id: 'activity.map.toggleFeed', defaultMessage: 'Feed', description: "A toggle above the Activity tab: show the map's feed of the last actions." }),
  toggleContext: msg({ id: 'activity.map.toggleContext', defaultMessage: 'Context', description: "A toggle above the Activity tab: show the agents' context rings on the map." })
}
