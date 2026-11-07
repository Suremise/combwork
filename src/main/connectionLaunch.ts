/**
 * Connections' launch settings in main (HI-2670, SPEC §5.6; the policy itself is shared/launchPolicy.ts): their one-time
 * copy from the app-wide switches they replaced, how an agent's connection makes it Independent, and changing them.
 *
 * A change that turns a connection's Combwork tools off makes its agents Independent at once (their saved roles kept for
 * the tools' return). Where that takes an agent off a running lane, or from a card in Doing or Review, in an open
 * workspace, the change is refused unless it names that exact set (its fingerprint, from launchImpact): worked out again
 * as it is saved, so a confirmation never approves work that became affected after it was given. The lanes pause by
 * themselves (their `independent` status), here and in a workspace opened later; the cards stay for the user.
 */
import { join } from 'path'
import { overrideId } from '../shared/advanced'
import { cleanLaunch, copyAppSwitches, launchesWithoutTools, launchPolicy, type AffectedAgent, type LaunchImpact } from '../shared/launchPolicy'
import { running } from '../shared/lanes'
import { msg } from '../shared/i18n'
import { agentWorkflowRole, inWorkflow, readToolsOffWith } from '../shared/workflow/roles'
import type { AgentDef, Connection, ConnectionLaunch, ProjectConfig, ProviderId } from '../shared/types'
import { CW_DIR } from '../shared/defaults'
import { accountById, allAccounts, allConnections, getConnection, NO_CONNECTION } from './accounts'
import { readOwnRunOverridesWith } from './advancedValues'
import { advanced } from './advanced'
import { config } from './config'
import { combworkError } from './combworkError'
import { emit } from './events'
import { hashText, readKeptJson, withFileLock } from './fsutil'
import { rawLanes } from './lanes'
import { createLogger } from './logger'
import { agentCards } from './tasks'
import { openWorkspaces, type WorkspaceService } from './workspace'

const log = createLogger('connections')

/**
 * How agentWorkflowRole tells an agent's connection launches without Combwork's tools: a window's AgentInfo says so
 * (`toolsOff`); an AgentDef names its connection by id. Installed once, as main starts.
 */
export function readRolesFromConnections(): void {
  readToolsOffWith((a) => {
    const x = a as { toolsOff?: boolean; connection?: string }
    return x.toolsOff === true || launchesWithoutTools(getConnection(x.connection))
  })
  readOwnRunOverridesWith(ownRunOverride)
}

/**
 * An override as Combwork's own runs of a CLI read it (HI-2670: Copilot's sign-in check and model catalogue, which are no
 * session's): on unless every connection of that CLI has it off; its default with none. Just after the one-time copy,
 * what the app-wide switch said.
 */
export function ownRunOverride(cli: ProviderId, what: string): boolean {
  const accounts = new Map(allAccounts().map((a) => [a.id, a.provider]))
  const on = allConnections().filter((c) => accounts.get(c.account) === cli).map((c) => launchPolicy(c, cli).overrides[overrideId(cli, what)])
  return on.length ? on.some((v) => v !== false) : launchPolicy(null, cli).overrides[overrideId(cli, what)] !== false
}

/**
 * The one-time copy (HI-2670): each app-wide switch that was off (Combwork's guidance, a CLI's override) onto every
 * connection of its CLI (guidance onto all), recorded with what it copied. Not while advanced.json can't be read: its
 * values would be taken for defaults, so it is tried again at the next start.
 */
export function migrateLaunchPolicy(): void {
  if (config.get().migrations?.launch1) return
  if (advanced.state(null).fileError) {
    log.warn('launch settings: advanced.json can\'t be read, so its switches are copied onto the connections at a later start') // i18n-ignore: for the log
    return
  }
  const values = advanced.overrides()
  let copied: string[] = []
  config.update((c) => {
    if (c.migrations?.launch1) return
    const accounts = new Map((c.accounts ?? []).map((a) => [a.id, a.provider]))
    const r = copyAppSwitches(c.connections ?? [], (id) => accounts.get(id), values)
    c.connections = r.connections
    copied = r.copied
    c.migrations = { ...c.migrations, launch1: { at: new Date().toISOString(), copied } }
  })
  if (copied.length) {
    log.info(`launch settings: ${copied.length} app-wide switches copied onto the connections (HI-2670)`) // i18n-ignore: for the log
    emit({ type: 'connections-changed' })
  }
}

/** The lanes and held cards of one agent of an open workspace. */
async function partsOf(ws: WorkspaceService, project: string, projectPath: string, a: Pick<AgentDef, 'id' | 'name'>): Promise<AffectedAgent | null> {
  const lanes = (await rawLanes(ws).catch(() => [])).filter((l) => running(l) && l.project.toLowerCase() === project.toLowerCase() && (l.builder.id === a.id || l.reviewer?.id === a.id)).map((l) => l.id)
  const cards = (await agentCards(project, a.id, ws).catch(() => [])).filter((c) => c.column === 'doing' || c.column === 'review').map((c) => ({ number: c.number, ...(c.key ? { key: c.key } : {}), column: c.column }))
  if (!lanes.length && !cards.length) return null
  return { workspace: ws.path ?? '', project, projectPath, agentId: a.id, agent: a.name, lanes: lanes.sort(), cards: cards.sort((x, y) => x.number - y.number) }
}

function impactOf(agents: AffectedAgent[]): LaunchImpact {
  const sorted = [...agents].sort((x, y) => `${x.workspace}|${x.project}|${x.agentId}`.localeCompare(`${y.workspace}|${y.project}|${y.agentId}`))
  const key = sorted.map((a) => `${a.workspace.toLowerCase()}|${a.project.toLowerCase()}|${a.agentId}|${a.lanes.join(',')}|${a.cards.map((c) => `${c.number}:${c.column}`).join(',')}`).join('\n')
  return { agents: sorted, fingerprint: hashText(key) }
}

/**
 * The agents of the open workspaces on a connection (their project.json as saved, read under its lock) that are in the
 * workflow now and on a running lane or holding a card in Doing or Review.
 */
async function connectionImpact(id: string): Promise<LaunchImpact> {
  const out: AffectedAgent[] = []
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    for (const p of ws.info()?.projects ?? []) {
      const file = join(p.path, CW_DIR, 'project.json')
      const cfg = await withFileLock(file, () => readKeptJson<Partial<ProjectConfig>>(file, {})).catch(() => ({}) as Partial<ProjectConfig>)
      for (const a of cfg.agents ?? []) {
        // Already out of the workflow by its own role: the change takes nothing from it.
        if (a.connection !== id || (a.workflowRole === 'independent')) continue
        const parts = await partsOf(ws, p.name, p.path, a)
        if (parts) out.push(parts)
      }
    }
  }
  return impactOf(out)
}

/** Whether a launch change turns a connection's Combwork tools off. */
const turnsToolsOff = (was: ConnectionLaunch | undefined, next: ConnectionLaunch | undefined): boolean => was?.tools !== false && next?.tools === false

const CHANGED = msg({ id: 'main.connections.launch.impactChanged', defaultMessage: 'What this change takes out of the workflow has changed since you were asked: {agents}. Look at it again (confirm: {fingerprint}).', description: "An error saving a connection's launch settings or an agent's connection (HI-2670): the agents, lanes or cards it would take out of the workflow ({agents}: each agent with its lanes and cards) changed after the user confirmed, so nothing was saved. {fingerprint} is a code a script sends back to confirm: keep it and the word confirm." })
const CONFIRM = msg({ id: 'main.connections.launch.confirm', defaultMessage: 'This makes agents Independent while they are on lanes or hold cards: {agents}. Their lanes pause and their cards stay. Confirm it first (confirm: {fingerprint}).', description: "An error saving a connection's launch settings or an agent's connection (HI-2670), from a caller that didn't confirm (the Agent API, the Assistant): it would make agents on lanes or holding cards Independent. {agents}: each agent with its lanes and cards; {fingerprint} is a code to send back as confirm: keep it and the word confirm." })

/** The agents a change takes out of the workflow, each with its lanes and cards, for a refusal. */
const impactText = (impact: LaunchImpact): string => impact.agents.map((a) => `${a.agent} (${[...a.lanes, ...a.cards.map((c) => `${c.key ?? c.number} ${c.column}`)].join(', ')})`).join('; ')

/** Refused unless `confirmed` names exactly what the change takes out of the workflow now. */
function assertConfirmed(impact: LaunchImpact, confirmed: string | null | undefined): void {
  if (!impact.agents.length) return
  const values = { agents: impactText(impact), fingerprint: impact.fingerprint }
  if (!confirmed) throw combworkError(CONFIRM, values, { kind: 'conflict' })
  if (confirmed !== impact.fingerprint) throw combworkError(CHANGED, values, { kind: 'conflict' })
}

/** What saving these launch settings on a connection would take out of the workflow (null: nothing to confirm). */
export async function launchImpact(id: string, raw: unknown): Promise<LaunchImpact | null> {
  const c = getConnection(id)
  const cli = accountById(c?.account)?.provider
  if (!c || !cli) return null
  if (!turnsToolsOff(c.launch, cleanLaunch(raw, cli))) return null
  const impact = await connectionImpact(id)
  return impact.agents.length ? impact : null
}

/**
 * Saves a connection's launch settings (HI-2670: Settings, the Agent API and the Assistant's changes). Turning its tools
 * off where that takes agents out of lanes or cards needs `confirmed` (launchImpact's fingerprint), checked against the
 * set as it is when saved. Running sessions keep what they launched with until they restart (offered, as for any change
 * of a connection); their role and deliveries change at once.
 */
export async function setConnectionLaunch(id: string, raw: unknown, confirmed?: string | null): Promise<Connection> {
  const c = getConnection(id)
  const cli: ProviderId | undefined = accountById(c?.account)?.provider
  if (!c || !cli) throw combworkError(NO_CONNECTION, undefined, { kind: 'notFound' })
  const next = cleanLaunch(raw, cli)
  // Worked out as it is saved: from here to the write nothing awaits.
  if (turnsToolsOff(c.launch, next)) assertConfirmed(await connectionImpact(id), confirmed)
  let saved: Connection | undefined
  config.update((cfg) => {
    cfg.connections = (cfg.connections ?? []).map((x) => {
      if (x.id !== id) return x
      const { launch: _was, ...rest } = x
      saved = next ? { ...rest, launch: next } : rest
      return saved
    })
  })
  if (!saved) throw combworkError(NO_CONNECTION, undefined, { kind: 'notFound' })
  emit({ type: 'connections-changed' })
  for (const w of openWorkspaces()) void w.refresh().catch(() => undefined)
  log.info(`connection ${id}: launch settings ${next ? JSON.stringify(next) : 'all on'}`) // i18n-ignore: for the log
  return saved
}

/**
 * What a change of one agent would take out of the workflow (HI-2670): moving it onto a connection without Combwork's
 * tools, or choosing Independent for it, while it is on a running lane or holds a card in Doing or Review. Null: nothing.
 */
export async function agentImpact(ws: WorkspaceService, projectPath: string, project: string, before: AgentDef | undefined, after: Pick<AgentDef, 'name' | 'role' | 'workflowRole' | 'connection'>): Promise<LaunchImpact | null> {
  if (!before || !inWorkflow(agentWorkflowRole(before)) || inWorkflow(agentWorkflowRole(after))) return null
  const parts = await partsOf(ws, project, projectPath, before)
  return parts ? impactOf([parts]) : null
}

/** Refused unless `confirmed` names exactly what this agent's change takes out of the workflow now (agentImpact). */
export async function assertAgentChangeConfirmed(ws: WorkspaceService, projectPath: string, project: string, before: AgentDef | undefined, after: Pick<AgentDef, 'name' | 'role' | 'workflowRole' | 'connection'>, confirmed: string | null | undefined): Promise<void> {
  const impact = await agentImpact(ws, projectPath, project, before, after)
  if (impact) assertConfirmed(impact, confirmed)
}
