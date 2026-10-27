import { basename } from 'path'
import type { AgentDef, Connection, MovedField, ProviderId } from '../shared/types'
import { moveProjectOverrides, type MovedNotice } from '../shared/connectionDefaults'
import { agentLaunchSettings, agentProvider, isProviderEnabled, providerDescriptor, PROVIDERS } from '../shared/providers'
import { projectAgents } from '../shared/defaults'
import { resolveConnection } from '../shared/accounts'
import { modelCaps } from '../shared/models'
import { msg, tr } from '../shared/i18n'
import { config } from './config'
import { onHiveEvent, toast } from './events'
import { createLogger, userText } from './logger'
import { connectionsOn } from './connectionSeam'
import { accountFolder, getAccount, seedConnectionDefaults } from './accounts'
import { provider as providerAdapter } from './providers'
import { providerService } from './providerService'
import { openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'

/**
 * Model, effort and context belong to the connection (HI-1770): a project's own model, effort and context for a CLI with
 * connections move onto its agents once (Darren's 26 Oct ~23:25 (2)), before anything launches there reading them; what
 * moved that the agent's connection can't use is listed once, from the project's own record of the move.
 */

const log = createLogger('connections')

/** Whether a CLI's model, effort and context come from connections now: Connections on (the preview, until S8) and a CLI with them. */
export const connectionLayerFor = (cli: ProviderId): boolean => !!providerDescriptor(cli).capabilities.connections && connectionsOn()

/** Moves under way, by project and CLI: a start, an open and a toggle at once share one. */
const moving = new Map<string, Promise<void>>()

/**
 * Makes sure a project's own model, effort and context for a CLI were moved onto its agents (moveProjectOverrides), in
 * one write under the project's lock, which reads the agents and the project as they are then; done already (its
 * record), nothing is written. A launch awaits it before it reads the project, so none starts with the project's
 * values unread and not yet its agents'. Never for the Assistant's home (its layer is Settings → Assistant).
 */
export function ensureMoved(projectPath: string, cli: ProviderId): Promise<void> {
  const ws = workspaceOf(projectPath)
  if (ws.isAssistantHome(projectPath)) return Promise.resolve()
  const key = `${projectPath.toLowerCase()}\n${cli}`
  let run = moving.get(key)
  if (!run) {
    run = ws
      .mutateProjectConfig(projectPath, (cfg) => {
        const patch = moveProjectOverrides(cfg, cli, (a) => agentProvider(a, cfg, config.settings), new Date().toISOString())
        if (!patch) return {}
        const moved = patch.migrations?.connections1?.[cli]?.moved.length ?? 0
        log.info(`${userText(basename(projectPath))}: ${providerDescriptor(cli).name}'s project model, effort and context moved onto its agents (${moved} values)`)
        return patch
      })
      .then(() => undefined)
      .finally(() => moving.delete(key))
    moving.set(key, run)
  }
  return run
}

/** Whether a project still has a CLI's move to make (no record of it yet). */
export async function moveNeeded(projectPath: string, cli: ProviderId): Promise<boolean> {
  const ws = workspaceOf(projectPath)
  return !ws.isAssistantHome(projectPath) && !(await ws.projectConfig(projectPath)).migrations?.connections1?.[cli]
}

/**
 * The model that would run for a choice on a connection (`model`: the agent's or the connection's default; else the CLI's
 * own default in the connection's home, else its catalogue's), and whether an effort is one that model takes (only
 * where its efforts are known): an effort it doesn't take is kept but not used.
 */
export function effortUsable(cli: ProviderId, model: string | null, conn: Pick<Connection, 'id'> | null, effort: string): boolean {
  const info = providerService.info(cli)
  const runs = model || (conn ? providerAdapter(cli).configuredDefaultModel(accountFolder(conn.id)) : null) || info.defaultModel || null
  const caps = modelCaps(cli, runs, info, config.settings)
  return !caps.perModel || caps.efforts.some((e) => e.value === effort)
}

/**
 * The moved values that their agent's connection can't use now, in one workspace's projects only (the asking window's:
 * never another's), worked out from each project's record of its move, so nothing is lost if Hive stopped after the move
 * and before anything else was written. A value the agent no longer has (changed since) isn't listed; nor a dismissed one.
 */
export async function movedNotice(ws: WorkspaceService): Promise<MovedNotice[]> {
  if (!connectionsOn() || !ws.path) return []
  const dismissed = new Set(config.get().ui.connectionsNoticeDismissed ?? [])
  const out: MovedNotice[] = []
  for (const projectPath of await ws.listProjectPaths()) {
    const cfg = await ws.projectConfig(projectPath).catch(() => null)
    const journal = cfg?.migrations?.connections1
    if (!cfg || !journal) continue
    const agents = projectAgents(cfg)
    for (const [cli, record] of Object.entries(journal) as [ProviderId, NonNullable<(typeof journal)[ProviderId]>][]) {
      for (const m of record.moved) {
        const key = `${projectPath.toLowerCase()}|${m.id}`
        const a = agents.find((x) => x.id === m.agent)
        if (dismissed.has(key) || !a || a[m.field] !== m.value || agentProvider(a, cfg, config.settings) !== cli) continue
        if (!unusable(a, cfg, cli, m.field, ws)) continue
        out.push({ key, project: basename(projectPath), agent: a.name, field: m.field, value: m.value })
      }
    }
  }
  return out
}

/** Whether a value moved onto an agent is one its connection can't use (an effort its model doesn't take; context where the CLI has none). */
function unusable(a: AgentDef, cfg: Parameters<typeof agentLaunchSettings>[1], cli: ProviderId, field: MovedField, ws: WorkspaceService): boolean {
  if (field === 'use200kContext') return !providerDescriptor(cli).capabilities.contextLimit
  if (field !== 'effort' || !a.effort) return false
  const choice = resolveConnection(ws.config, cli, a.connection, config.get().connections ?? [])
  const conn = choice.ok ? (getAccount(choice.id) ?? null) : null
  const l = agentLaunchSettings(a, cfg, config.settings, { kind: 'connection', conn })
  return !effortUsable(cli, l.model, conn, a.effort)
}

/** Dismisses the notice's entries the asking window showed (only those listed now: one of another workspace, or a later CLI's, stays). */
export async function dismissMovedNotice(ws: WorkspaceService, keys: string[]): Promise<void> {
  const shown = new Set((await movedNotice(ws)).map((n) => n.key))
  const add = keys.filter((k) => shown.has(k))
  if (!add.length) return
  config.update((c) => void (c.ui.connectionsNoticeDismissed = [...new Set([...(c.ui.connectionsNoticeDismissed ?? []), ...add])]))
}

const MOVE_FAILED = msg({ id: 'main.connections.moveFailed', defaultMessage: "Hive couldn't move {project}'s model settings to its agents", description: "A notice's title (HI-1770): moving a project's own model, effort and context settings onto its agents (connections now hold the defaults) failed; it is tried again at the next start. {project} is the project's name." })

/**
 * Every open workspace's projects moved, for each CLI with connections that is on (at an open, and when Connections are
 * turned on): a failure is logged and said once, and tried again at the next start, open or toggle. Connections made
 * before they had defaults get the CLI's first.
 */
async function moveOpenProjects(): Promise<void> {
  if (!connectionsOn()) return
  seedConnectionDefaults()
  const clis = PROVIDERS.filter((p) => p.capabilities.connections && isProviderEnabled(config.settings, p.id)).map((p) => p.id)
  for (const ws of openWorkspaces()) {
    // Once per workspace opened (a workspace's refreshes say it changed too); again after a toggle.
    if (!ws.path || looked.has(ws.path.toLowerCase())) continue
    looked.add(ws.path.toLowerCase())
    for (const projectPath of await ws.listProjectPaths().catch(() => [])) {
      for (const cli of clis) {
        if (!(await moveNeeded(projectPath, cli).catch(() => false))) continue
        await ensureMoved(projectPath, cli).catch((e) => {
          log.warn(`moving ${userText(basename(projectPath))}'s model settings to its agents failed`, e)
          toast('error', tr(MOVE_FAILED, { project: basename(projectPath) }), String(e?.message ?? e), undefined, projectPath)
        })
      }
    }
  }
}

/** Workspaces whose projects were looked at since Hive started or Connections were last turned on or off. */
const looked = new Set<string>()

/** The moves' part of Hive's start (index.ts): at each workspace's open, and when Connections (preview) is turned on. */
export function initConnectionMoves(): void {
  onHiveEvent((e) => {
    if (e.type === 'advanced-changed') looked.clear()
    if (e.type === 'workspace-changed' || e.type === 'advanced-changed') void moveOpenProjects()
  })
}
