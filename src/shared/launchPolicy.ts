/**
 * A connection's launch policy (HI-2670, SPEC §5.6): what of Combwork's its sessions get. Its owner for every reader: a
 * launch (sessions.ts and the adapters), its hooks and deliveries, the Agent API and project status, and Settings.
 *
 * Each switch is the connection's: Combwork's guidance, Combwork's tools, Combwork typing into the agent, and each of its
 * CLI's overrides (the `<cli>.override.<key>` advanced settings, which moved here; their old app-wide values are copied
 * onto every connection of their CLI once, by main's launchPolicyMigration). Absent: on, as before. "Launch as from a
 * terminal" turns them all off: the session gets what `claude`, `codex` or `copilot` started in a terminal in that
 * folder would, while Combwork still shows its pane, status, transcript and usage (status hooks stay: they add nothing
 * to the model's context).
 *
 * The Assistant always gets Combwork's guidance, tools and typing (its role, its instructions and its wakes): a launch
 * on its home reads them as on whatever its connection says (`assistant`). Its overrides follow the connection.
 *
 * Pure data and helpers: no Node, no React.
 */
import { ADVANCED_DEFS, CW_GUIDANCE, overrideId } from './advanced'
import { agentMsg, say } from './agentText'
import type { Connection, ConnectionLaunch, ProviderId } from './types'

/** The switches a connection has besides its CLI's overrides. */
export type LaunchSwitch = 'guidance' | 'tools' | 'typing'
export const LAUNCH_SWITCHES: readonly LaunchSwitch[] = ['guidance', 'tools', 'typing']

/** The switches the Assistant always launches with on, whatever its connection says. */
export const ASSISTANT_KEEPS: readonly LaunchSwitch[] = ['guidance', 'tools', 'typing']

/** The override that keeps a session to the workspace's MCP servers: listed on its own in Settings (HI-2670). */
export const MCP_ISOLATION = 'mcpIsolation'

/** A CLI's override keys (`<cli>.override.<key>`), in the catalogue's order. */
export function overrideKeys(cli: ProviderId): string[] {
  const prefix = overrideId(cli, '')
  return ADVANCED_DEFS.filter((d) => d.override && d.group === cli && d.id.startsWith(prefix)).map((d) => d.id.slice(prefix.length))
}

/** An override's default (on, for every override today). */
function overrideDefault(cli: ProviderId, key: string): boolean {
  const def = ADVANCED_DEFS.find((d) => d.id === overrideId(cli, key))
  return def ? def.default !== false : true
}

/** What a launch on a connection gets (HI-2670): each switch, and each of its CLI's overrides by its advanced id. */
export interface LaunchPolicy {
  guidance: boolean
  tools: boolean
  typing: boolean
  /** Each of the CLI's overrides by id (`<cli>.override.<key>`), as LaunchContext.overrides takes them. */
  overrides: Record<string, boolean>
}

/** A launch's policy on a connection (none: everything, as before); `assistant`, the Assistant's home's launch. */
export function launchPolicy(conn: Pick<Connection, 'launch'> | null | undefined, cli: ProviderId, opts: { assistant?: boolean } = {}): LaunchPolicy {
  const l = conn?.launch
  const on = (s: LaunchSwitch): boolean => (opts.assistant && ASSISTANT_KEEPS.includes(s)) || l?.[s] !== false
  return {
    guidance: on('guidance'),
    tools: on('tools'),
    typing: on('typing'),
    overrides: Object.fromEntries(overrideKeys(cli).map((k) => [overrideId(cli, k), l?.overrides?.[k] ?? overrideDefault(cli, k)]))
  }
}

/** The "Launch as from a terminal" preset for a CLI's connection: every switch and override off. */
export function terminalPreset(cli: ProviderId): ConnectionLaunch {
  const overrides = Object.fromEntries(overrideKeys(cli).map((k) => [k, false]))
  return { guidance: false, tools: false, typing: false, ...(Object.keys(overrides).length ? { overrides } : {}) }
}

/** How plain a connection launches: `full`, the whole preset; `partial`, something off; null, everything on. */
export type Plainness = 'full' | 'partial' | null

export function plainness(conn: Pick<Connection, 'launch'> | null | undefined, cli: ProviderId): Plainness {
  const p = launchPolicy(conn, cli)
  const values = [p.guidance, p.tools, p.typing, ...Object.values(p.overrides)]
  if (values.every((v) => !v)) return 'full'
  return values.some((v) => !v) ? 'partial' : null
}

/** Whether a connection launches without Combwork's tools, which makes its agents Independent (HI-2670). */
export const launchesWithoutTools = (conn: Pick<Connection, 'launch'> | null | undefined): boolean => conn?.launch?.tools === false

/**
 * A connection's launch switches as saved, from what was given (Settings, the Agent API): each switch off only when
 * given `false`; each override only its CLI's keys, kept only when not its default. Nothing left: undefined (none saved).
 */
export function cleanLaunch(raw: unknown, cli: ProviderId): ConnectionLaunch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: ConnectionLaunch = {}
  for (const s of LAUNCH_SWITCHES) if (r[s] === false) out[s] = false
  const given = r.overrides && typeof r.overrides === 'object' ? (r.overrides as Record<string, unknown>) : {}
  const overrides: Record<string, boolean> = {}
  for (const k of overrideKeys(cli)) if (typeof given[k] === 'boolean' && given[k] !== overrideDefault(cli, k)) overrides[k] = given[k] as boolean
  if (Object.keys(overrides).length) out.overrides = overrides
  return Object.keys(out).length ? out : undefined
}

/** The words of a policy in short (agent-facing: the Agent API and project status). */
const S = {
  plain: agentMsg({ id: 'launch.summary.plain', text: 'plain: launched as from a terminal', note: "An agent's or connection's launch settings in short (HI-2670), in project status and the Agent API: none of Combwork's additions." }),
  partly: agentMsg({ id: 'launch.summary.partly', text: 'partly plain: {off} off', note: "An agent's or connection's launch settings in short (HI-2670): {off} lists what is turned off (guidance, tools, typing, an override's key)." }),
  all: agentMsg({ id: 'launch.summary.all', text: 'everything on', note: "A connection's launch settings in short (HI-2670), when nothing is turned off." })
}

/**
 * A connection's policy in short, for the Agent API and project status (English, agent-facing): "plain: …", "partly
 * plain: guidance, typing, statusLine off", or null when it launches with everything (`all`: "everything on" instead).
 */
export function policySummary(conn: Pick<Connection, 'launch'> | null | undefined, cli: ProviderId, all = false): string | null {
  const how = plainness(conn, cli)
  if (!how) return all ? say(S.all) : null
  if (how === 'full') return say(S.plain)
  const p = launchPolicy(conn, cli)
  const off = [...LAUNCH_SWITCHES.filter((s) => !p[s]), ...overrideKeys(cli).filter((k) => !p.overrides[overrideId(cli, k)])]
  return say(S.partly, { off: off.join(', ') })
}

/** One agent a change would take out of the workflow (HI-2670), with what it is part of now. */
export interface AffectedAgent {
  workspace: string
  project: string
  projectPath: string
  agentId: string
  agent: string
  /** Its running lanes (as builder or reviewer), by id. */
  lanes: string[]
  /** Its cards in Doing or Review. */
  cards: { number: number; key?: string; column: string }[]
}

/** What a change would take out of the workflow (main's connectionLaunch.ts), and its fingerprint, which a confirmation names. */
export interface LaunchImpact {
  agents: AffectedAgent[]
  fingerprint: string
}

/**
 * The one-time copy (HI-2670): each app-wide switch that was set in advanced.json (`values`: Combwork's guidance off, a
 * CLI's override either way) onto every connection of its CLI (guidance onto all), each value kept as it was, so a mix
 * of them survives. What it copied, by advanced id.
 */
export function copyAppSwitches(connections: readonly Connection[], cliOf: (accountId: string) => ProviderId | undefined, values: Readonly<Record<string, unknown>>): { connections: Connection[]; copied: string[] } {
  const copied = new Set<string>()
  const out = connections.map((conn) => {
    const cli = cliOf(conn.account)
    if (!cli) return conn
    const raw: Record<string, unknown> = { ...conn.launch, overrides: { ...conn.launch?.overrides } }
    if (values[CW_GUIDANCE] === false) {
      raw.guidance = false
      copied.add(CW_GUIDANCE)
    }
    for (const k of overrideKeys(cli)) {
      const v = values[overrideId(cli, k)]
      if (typeof v !== 'boolean') continue
      ;(raw.overrides as Record<string, boolean>)[k] = v
      copied.add(overrideId(cli, k))
    }
    const launch = cleanLaunch(raw, cli)
    const { launch: _was, ...rest } = conn
    return launch ? { ...rest, launch } : rest
  })
  return { connections: out, copied: [...copied].sort() }
}
