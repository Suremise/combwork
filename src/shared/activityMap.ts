// The Activity map (HI-2903): what the Activity tab already reads, drawn as a honeycomb. The agent in the centre, six
// stations around it, a pulse out to a station for each new tool call and back when its result lands, a feed of the
// last calls and a context ring. Nothing new is collected: the stations come from the turns the tab reads (each call's
// tool name), the agents' live state, their processes and background tasks, and the pane footer's context number.
// Names only, never content (mapLabel): a summary is shown only where it is recognised as a path or a URL's host.
import type { ActivityState, ActivityTurns } from './activity'
import type { BackgroundTaskType } from './types'

export type MapStation = 'you' | 'read' | 'edit' | 'shell' | 'agents' | 'tools'
/** The stations, clockwise from the top: the order the map draws them in. */
export const MAP_STATIONS: readonly MapStation[] = ['you', 'read', 'edit', 'shell', 'agents', 'tools']
/** What a call to the Tools station is: the web, a skill, Combwork's own tools, another MCP server's, or anything else. */
export type ToolGroup = 'web' | 'skill' | 'combwork' | 'mcp' | 'other'

/** At most this many agents' sessions are read for the shared map (HI-2903 design s16: a bounded cost). */
export const MAP_AGENTS = 8
/** At most this many calls of an agent count on the map (its latest): one turn can hold any number (HR2's s16 OK). */
export const MAP_CALLS = 400
/** The feed's length. */
export const FEED_LENGTH = 8
/** Pulses in flight at once, the oldest dropped. */
export const MAX_PULSES = 24
/** A spoke's heat counts the calls of the last ten minutes (from the turns read: a sample, never the whole history). */
export const HEAT_MS = 10 * 60_000
/** The context ring turns amber here, and red here (the card's thresholds). */
export const CONTEXT_AMBER = 70
export const CONTEXT_RED = 90

const lower = (s: string): string => s.trim().toLowerCase()

// The tool names each provider's parser gives (recorded fixtures: tests/activityMap.test.ts), by station. The parsers
// already give Claude Code's names where they do the same (Copilot's TOOL_NAMES, Codex's Shell and Edit); Antigravity and
// OpenCode keep their own.
const BY_NAME: Record<string, MapStation> = {}
const add = (station: MapStation, names: string[]): void => names.forEach((n) => (BY_NAME[n] = station))
add('you', ['question', 'askuserquestion', 'ask_user', 'exitplanmode', 'request_user_input'])
add('read', ['read', 'grep', 'glob', 'ls', 'view', 'notebookread', 'read_file', 'view_file', 'list_dir', 'list_directory', 'find_by_name', 'grep_search', 'codebase_search', 'file_search', 'view_image', 'list', 'find'])
add('edit', ['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'edit_file', 'write_file', 'create', 'create_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'])
add('shell', ['bash', 'powershell', 'shell', 'run_command', 'exec_command', 'local_shell', 'bashoutput', 'killshell', 'killbash', 'command_status', 'send_command_input', 'write_stdin'])
add('agents', ['agent', 'task', 'subagent', 'invoke_subagent', 'manage_subagents', 'send_message', 'spawn_agent'])
const WEB = new Set(['webfetch', 'websearch', 'web_fetch', 'web_search', 'read_url_content', 'search_web', 'fetch'])
/** Tools that take a path as their summary (their parsers give it shortened): the only ones a path label is taken from. */
const PATH_TOOLS = new Set(['read', 'view', 'read_file', 'view_file', 'view_image', 'notebookread', 'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'edit_file', 'write_file', 'create', 'create_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content'])
/** Combwork's tool server, as an MCP tool's server is named (its own name and its CLI's). */
const COMBWORK_SERVERS = new Set(['combwork', 'cw'])

/**
 * An MCP tool's server and tool, however the parser wrote it: `mcp__server__tool` (raw), `server · tool` (Claude Code's,
 * Codex's, Antigravity's, quoted or not) or `server.tool` (an OpenCode script's call). Null for anything else.
 */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const raw = /^mcp__(.+?)__(.+)$/.exec(name)
  if (raw) return { server: raw[1], tool: raw[2] }
  const dot = /^\s*"?([^"·]+?)"?\s+·\s+"?([^"·]+?)"?\s*$/.exec(name)
  if (dot) return { server: dot[1], tool: dot[2] }
  const js = /^([A-Za-z][\w-]*)\.([A-Za-z_][\w-]*)$/.exec(name)
  if (js) return { server: js[1], tool: js[2] }
  return null
}

/** Which station a tool call goes to, by its name; Tools for anything not recognised, with its group. */
export function stationOf(name: string): { station: MapStation; group?: ToolGroup } {
  const n = lower(name)
  const known = BY_NAME[n]
  if (known) return { station: known }
  if (WEB.has(n)) return { station: 'tools', group: 'web' }
  if (n === 'skill') return { station: 'tools', group: 'skill' }
  const mcp = mcpParts(name)
  if (mcp) return { station: 'tools', group: COMBWORK_SERVERS.has(lower(mcp.server)) ? 'combwork' : 'mcp' }
  return { station: 'tools', group: 'other' }
}

/** A path's last two segments, when the whole text is one path (no spaces, quotes or shell characters); else null. */
export function pathLabel(text: string): string | null {
  const t = text.trim()
  if (!t || t.length > 260 || !/^[^\s"'`<>|?*;&$(){}[\]]+$/.test(t)) return null
  const parts = t.split(/[\\/]+/).filter(Boolean)
  // A path has a folder or an extension: a bare word (a pattern, a query) isn't one.
  if (parts.length < 2 && !/\.[A-Za-z0-9]{1,8}$/.test(t)) return null
  return parts.slice(-2).join('/')
}

/** A web address's host, only for an http(s) URL; userinfo, port, path and query are never shown. */
export function hostLabel(text: string): string | null {
  const t = text.trim()
  if (!/^https?:\/\/\S+$/i.test(t)) return null
  try {
    return new URL(t).hostname || null
  } catch {
    return null
  }
}

/** A tool's name as the map shows it: an MCP tool by its tool's name, anything else as named. */
export function toolDisplayName(name: string): string {
  const mcp = mcpParts(name)
  return (mcp ? mcp.tool : name).trim()
}

/**
 * A call's label on the map, the feed, a title and an accessibility name (HR2's s11 gap 3): fail-closed, a recognised
 * name or the tool's own. A path tool's whole summary when it is one path (several, Codex's patch: the first and "+n"),
 * a web fetch's host; otherwise only the tool's name. Never any other summary text: it may be prose, a query or a script.
 */
export function mapLabel(tool: { name: string; summary: string }): string {
  const n = lower(tool.name)
  const name = toolDisplayName(tool.name)
  if (PATH_TOOLS.has(n)) {
    const list = tool.summary.split(/,\s*/).filter(Boolean)
    const first = list.length ? pathLabel(list[0]) : null
    if (first && list.slice(1).every((p) => pathLabel(p))) return list.length > 1 ? `${first} +${list.length - 1}` : first
    return name
  }
  if (n === 'webfetch' || n === 'web_fetch' || n === 'read_url_content' || n === 'fetch') return hostLabel(tool.summary) ?? name
  return name
}

/** How full an agent's context is: its tokens, its window, and the share; null when the number isn't known. */
export interface MapContext {
  tokens: number
  window: number | null
  pct: number | null
}

/** A ring's level by its share: none (no window known), ok, amber, red. */
export function contextLevel(pct: number | null | undefined): 'none' | 'ok' | 'amber' | 'red' {
  if (pct === null || pct === undefined) return 'none'
  return pct >= CONTEXT_RED ? 'red' : pct >= CONTEXT_AMBER ? 'amber' : 'ok'
}

/**
 * An agent as the map takes it, from the same reads the Activity list draws from (frozen or live). `key` is unique
 * across hosts (the workspace level qualifies it with the host's path).
 */
export interface MapAgentInput {
  key: string
  name: string
  state: ActivityState
  waiting: boolean
  doing: 'tool' | 'thinking' | 'writing' | null
  /** Its card and its role on it, already a label ("HI-2903 · builder"); none: no card. */
  card: string | null
  /** Its context (contextShown, held with the snapshot); null: not known. */
  context: MapContext | null
  /** Its running session's key in the reads (host-qualified) and its turns: undefined, not read yet. */
  sessionKey: string | null
  turns: ActivityTurns | undefined
  /** Past the shared map's bound: shown in the strip, its calls not read. */
  notLoaded?: boolean
  /** Its subagent sessions in this turn, background tasks and the processes it runs (not its own plumbing): by name. */
  subagents: number
  tasks: { type?: BackgroundTaskType }[]
  processes: string[]
  /** Its edits Combwork's file lock blocks now (HI-982). */
  blocks: number
  /** The stations its provider reports (its descriptor's activityStations); none given: all. */
  reported?: readonly MapStation[]
}

/** A call on the map: its identity across reads (host, session, item), its agent and station, and its safe label. */
export interface MapCall {
  key: string
  /** Its session's key (host-qualified): a session first seen is a baseline, never a burst of pulses. */
  sessionKey: string
  agentKey: string
  station: MapStation
  group?: ToolGroup
  label: string
  at: string | null
  failed: boolean
  done: boolean
}

/** What a station shows: unsupported (no shown agent's provider reports it), loading (nothing read yet), or counted. */
export interface MapStationView {
  station: MapStation
  status: 'notReported' | 'loading' | 'ok'
  /** Calls this turn (each agent's latest turn), and in the last HEAT_MS of the turns read. */
  count: number
  heat: number
  /** Its newest call's label, or a running process's name for Shell; empty: none. */
  last: string
  failed: boolean
  /** Agents with a call here open now (their keys), or waiting (You). */
  here: string[]
  /** The counts are from a sample: some agent's calls were past MAP_CALLS, or an agent is past the shared map's bound. */
  partial: boolean
  /** Tools: its calls this turn by group. */
  groups?: Partial<Record<ToolGroup, number>>
}

export interface MapAgentView {
  key: string
  name: string
  state: ActivityState
  waiting: boolean
  doing: MapAgentInput['doing']
  card: string | null
  context: MapContext | null
  load: 'loaded' | 'loading' | 'notLoaded'
  /** Its calls were more than MAP_CALLS: the latest counted. */
  capped: boolean
}

export interface MapModel {
  agents: MapAgentView[]
  stations: Record<MapStation, MapStationView>
  /** The newest calls first, at most FEED_LENGTH. */
  feed: MapCall[]
  /** Every call counted, for the pulses' diff (at most MAP_CALLS an agent). */
  calls: MapCall[]
  /** The sessions whose turns are in (their keys): a call in one of them is new once it wasn't in the last read. */
  sessions: string[]
}

/** An agent's calls in the turns read, its latest MAP_CALLS (each a tool call, or each call a script made). */
export function agentCalls(a: MapAgentInput): { calls: MapCall[]; capped: boolean; lastTurn: Set<string> } {
  const out: MapCall[] = []
  const lastTurn = new Set<string>()
  const turns = a.turns?.turns ?? []
  const lastIdx = turns.length - 1
  turns.forEach((turn, ti) => {
    for (const tool of turn.tools) {
      const made = tool.calls?.length ? tool.calls.map((name, i) => ({ name, summary: '', key: `${a.sessionKey}\n${tool.itemId}.${i}` })) : [{ name: tool.name, summary: tool.summary, key: `${a.sessionKey}\n${tool.itemId}` }]
      for (const m of made) {
        const st = stationOf(m.name)
        out.push({ key: m.key, sessionKey: a.sessionKey ?? '', agentKey: a.key, station: st.station, ...(st.group ? { group: st.group } : {}), label: mapLabel(m), at: tool.at, failed: tool.failed, done: tool.done })
        if (ti === lastIdx) lastTurn.add(m.key)
      }
    }
  })
  const capped = out.length > MAP_CALLS
  return { calls: capped ? out.slice(-MAP_CALLS) : out, capped, lastTurn }
}

/** The map's model: each station's counts, heat, last label and failure, the feed, and the agents' rings. Pure. */
export function buildMapModel(agents: readonly MapAgentInput[], at: number): MapModel {
  const stations = Object.fromEntries(MAP_STATIONS.map((s) => [s, { station: s, status: 'ok', count: 0, heat: 0, last: '', failed: false, here: [], partial: false }])) as unknown as Record<MapStation, MapStationView>
  const all: MapCall[] = []
  const views: MapAgentView[] = []
  const loaded = agents.filter((a) => !a.notLoaded)
  for (const a of agents) {
    const load: MapAgentView['load'] = a.notLoaded ? 'notLoaded' : a.turns ? 'loaded' : 'loading'
    const { calls, capped, lastTurn } = a.notLoaded ? { calls: [], capped: false, lastTurn: new Set<string>() } : agentCalls(a)
    views.push({ key: a.key, name: a.name, state: a.state, waiting: a.waiting, doing: a.doing, card: a.card, context: a.context, load, capped })
    for (const c of calls) {
      const s = stations[c.station]
      if (lastTurn.has(c.key)) {
        s.count++
        if (c.station === 'tools' && c.group) s.groups = { ...s.groups, [c.group]: (s.groups?.[c.group] ?? 0) + 1 }
        if (c.failed) s.failed = true
        if (!c.done && !s.here.includes(a.key)) s.here.push(a.key)
      }
      if (c.at && at - Date.parse(c.at) <= HEAT_MS) s.heat++
      all.push(c)
    }
    if (capped || a.notLoaded) for (const s of MAP_STATIONS) stations[s].partial = true
    if (a.waiting && !stations.you.here.includes(a.key)) stations.you.here.push(a.key)
    if (a.blocks > 0) stations.edit.failed = true
    if (a.subagents + a.tasks.length > 0 && !a.notLoaded) {
      stations.agents.count += a.subagents + a.tasks.length
      if (!stations.agents.here.includes(a.key)) stations.agents.here.push(a.key)
    }
    if (a.processes.length && !a.notLoaded) {
      stations.shell.last = a.processes[a.processes.length - 1]
      if (!stations.shell.here.includes(a.key)) stations.shell.here.push(a.key)
    }
  }
  // Each station's last label: its newest call's (Shell keeps a running process's name).
  const sorted = all.slice().sort((x, y) => (Date.parse(y.at ?? '') || 0) - (Date.parse(x.at ?? '') || 0))
  for (const c of sorted) if (!stations[c.station].last) stations[c.station].last = c.label
  for (const s of MAP_STATIONS) {
    const st = stations[s]
    // Unsupported only when no shown agent's provider reports it; loading while no shown agent's turns are in.
    if (loaded.length && loaded.every((a) => a.reported && !a.reported.includes(s))) st.status = 'notReported'
    else if (loaded.length && loaded.every((a) => !a.turns)) st.status = 'loading'
  }
  const sessions = agents.flatMap((a) => (!a.notLoaded && a.turns && a.sessionKey ? [a.sessionKey] : []))
  return { agents: views, stations, feed: sorted.slice(0, FEED_LENGTH), calls: all, sessions }
}

/** A pulse: a call going out to its station (started), or coming back (its result landed). */
export interface MapPulse {
  id: string
  callKey: string
  agentKey: string
  station: MapStation
  back: boolean
  failed: boolean
}

/**
 * The pulses a new read sends (HR2's s11 gap 2): only calls not seen before go out, and a call seen running that is now
 * done comes back once. `seen` null is a new scope's baseline (an opening, Refresh, a filter change, going live, shown
 * again): every call is recorded and nothing pulses. A session whose turns weren't in the last read (read late, after the
 * scope began, or a new session after a restart) is a baseline of its own. `loaded` is this read's sessions with their
 * turns in (MapModel.sessions; none given: those with a call), returned for the next read. `seen` holds only this read's calls.
 */
export function diffPulses(seen: ReadonlyMap<string, boolean> | null, calls: readonly MapCall[], next: () => string, sessions?: ReadonlySet<string>, loaded?: readonly string[]): { pulses: MapPulse[]; seen: Map<string, boolean>; sessions: Set<string> } {
  const now = new Map<string, boolean>()
  const nowSessions = new Set<string>(loaded ?? [])
  const pulses: MapPulse[] = []
  for (const c of calls) {
    now.set(c.key, c.done)
    if (!loaded) nowSessions.add(c.sessionKey)
    if (!seen || !sessions?.has(c.sessionKey)) continue
    const was = seen.get(c.key)
    if (was === undefined) {
      pulses.push({ id: next(), callKey: c.key, agentKey: c.agentKey, station: c.station, back: false, failed: c.failed })
      if (c.done) pulses.push({ id: next(), callKey: c.key, agentKey: c.agentKey, station: c.station, back: true, failed: c.failed })
    } else if (!was && c.done) pulses.push({ id: next(), callKey: c.key, agentKey: c.agentKey, station: c.station, back: true, failed: c.failed })
  }
  return { pulses: pulses.slice(-MAX_PULSES), seen: now, sessions: nowSessions }
}

/** Pulses in flight with new ones added, the oldest dropped past MAX_PULSES. */
export function addPulses(flying: readonly MapPulse[], fresh: readonly MapPulse[]): MapPulse[] {
  return [...flying, ...fresh].slice(-MAX_PULSES)
}

/** The shared map's agents: the first MAP_AGENTS read, the rest marked not loaded (shown in the strip only). */
export function boundAgents<T extends { notLoaded?: boolean }>(agents: readonly T[]): T[] {
  return agents.map((a, i) => (i < MAP_AGENTS ? a : { ...a, notLoaded: true }))
}

/** One agent's map or the shared map: exactly one agent in the filter shows that agent's; none or several, the shared. */
export function mapMode(filterAgents: readonly string[] | undefined): 'single' | 'shared' {
  return filterAgents?.length === 1 ? 'single' : 'shared'
}

/** An agent's colour on the shared map: a fixed palette in pane order (cycled). */
export const AGENT_COLOURS = 8
export const agentColour = (index: number): number => ((index % AGENT_COLOURS) + AGENT_COLOURS) % AGENT_COLOURS
