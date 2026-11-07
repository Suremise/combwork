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
import { accountById, allAccounts, allConnections, getConnection, NO_CONNECTION, updateConnection } from './accounts'
import { boardRevision } from './boardStore'
import type { ConnectionPatch } from '../shared/accounts'
import { readOwnRunOverridesWith } from './advancedValues'
import { advanced } from './advanced'
import { config } from './config'
import { combworkError } from './combworkError'
import { emit } from './events'
import { readFile } from 'original-fs/promises'
import { hashText, withFileLock } from './fsutil'
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
  const lanes = (await rawLanes(ws)).filter((l) => running(l) && l.project.toLowerCase() === project.toLowerCase() && (l.builder.id === a.id || l.reviewer?.id === a.id)).map((l) => l.id)
  const cards = (await agentCards(project, a.id, ws)).filter((c) => c.column === 'doing' || c.column === 'review').map((c) => ({ number: c.number, ...(c.key ? { key: c.key } : {}), column: c.column }))
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
    const info = ws.info()
    // Its projects not known (still opening): nothing can be said to be unaffected.
    if (!info) throw combworkError(PROJECTS_UNREAD, { workspace: ws.path })
    for (const p of info.projects) {
      const file = join(p.path, CW_DIR, 'project.json')
      const cfg = await withFileLock(file, () => projectFileAsIs(file))
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

const PROJECTS_UNREAD = msg({ id: 'main.connections.launch.projectsUnread', defaultMessage: "the projects of {workspace} aren't read yet", description: "Why Combwork couldn't read what a change of a connection's launch settings affects (HI-2670), put into a longer error in place of {error}: an open workspace's projects ({workspace}: its folder) haven't been read yet. Lower case, no full stop." })

/**
 * A project's project.json exactly as it is (HR3 on s46), for what a change affects: never a kept file's stand-in (its
 * .bak while it is being saved, or the default for one damaged), which would read agents that are there as gone. None
 * there: no agents. One that can't be read or doesn't parse throws, and the change is refused.
 */
async function projectFileAsIs(file: string): Promise<Partial<ProjectConfig>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  return JSON.parse(text) as Partial<ProjectConfig>
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

/**
 * A token for everything an impact is read from (HI-2670, HR1 on s44): each open workspace's board (cards and lanes, its
 * revision moving as a write commits) and each project's project.json (Combwork's write stamp). The same token twice:
 * nothing an impact reads was written between.
 */
export function impactToken(): string {
  return JSON.stringify(
    openWorkspaces()
      .filter((ws) => !!ws.path)
      .map((ws) => [ws.path, boardRevision(ws), ...(ws.info()?.projects ?? []).map((p) => ws.projectConfigWrites(p.path))])
  )
}

/** How many times an impact is read again when what it reads changed while it was read. */
const STABLE_TRIES = 5
const BUSY = msg({ id: 'main.connections.launch.busy', defaultMessage: 'The board kept changing while Combwork worked out what this change affects. Try again.', description: "An error saving a connection's launch settings or an agent's role or connection (HI-2670): cards, lanes or agents changed every time Combwork read which of them the change would take out of the workflow, so nothing was saved." })

/**
 * An impact read as one consistent snapshot (HR1 on s44): read again while anything it reads was written during the
 * read, so the set returned, with its token, is what all of it was at one moment.
 */
async function stableImpact(read: () => Promise<LaunchImpact>): Promise<{ impact: LaunchImpact; token: string }> {
  // Anything that can't be read (a card, a lane, a project's file, the board's revision) refuses the change (HR3 on
  // s45): only a read that worked may say nobody is affected.
  try {
    for (let i = 0; i < STABLE_TRIES; i++) {
      const token = impactToken()
      const impact = await read()
      if (impactToken() === token) return { impact, token }
    }
  } catch (e) {
    throw combworkError(UNREADABLE, { error: e instanceof Error ? e.message : String(e) }, { kind: 'conflict' })
  }
  throw combworkError(BUSY, undefined, { kind: 'conflict' })
}
const UNREADABLE = msg({ id: 'main.connections.launch.unreadable', defaultMessage: "Combwork couldn't read which agents, lanes and cards this change affects ({error}), so nothing was saved. Try again.", description: "An error saving a connection's launch settings or an agent's role or connection (HI-2670): reading the board, the lanes or a project's agents failed, so Combwork can't tell whether the change takes agents out of the workflow, and saves nothing. {error} is why, as the system said it." })

/** What saving these launch settings on a connection would take out of the workflow (null: nothing to confirm). */
export async function launchImpact(id: string, raw: unknown): Promise<LaunchImpact | null> {
  const c = getConnection(id)
  const cli = accountById(c?.account)?.provider
  if (!c || !cli) return null
  if (!turnsToolsOff(c.launch, cleanLaunch(raw, cli))) return null
  const { impact } = await stableImpact(() => connectionImpact(id))
  return impact.agents.length ? impact : null
}

const CHANGED_MEANWHILE = msg({ id: 'main.connections.launch.changedMeanwhile', defaultMessage: "{name}'s launch settings were changed meanwhile: nothing was saved. Look at them again.", description: "An error saving a connection's launch settings (HI-2670): something else changed them while this change was being checked, so nothing was saved. {name} is the connection's name." })

/** A connection change (HI-2670): its values (ConnectionPatch, as updateConnection takes them) and its launch settings. */
export interface ConnectionChange {
  values?: ConnectionPatch
  /** Its launch settings as given (cleanLaunch); undefined: unchanged. */
  launch?: unknown
  /** launchImpact's fingerprint, when the change makes agents Independent. */
  confirmed?: string | null
  /**
   * Asked at the write itself, after every await (HR1 on s44): the caller's checks that must still hold then (the
   * Assistant's Control and session: servers.ts's atTheChange). Throws to refuse.
   */
  atWrite?: () => void
}

/**
 * Changes a connection's values and launch settings together (HI-2670: Settings, the Agent API and the Assistant's
 * changes). Turning its tools off where that takes agents out of lanes or cards needs `confirmed`, launchImpact's
 * fingerprint. What it affects is read as one snapshot (stableImpact); then, with nothing awaited from there to the
 * write, the caller's checks (`atWrite`), the snapshot still current, the launch settings not changed meanwhile and the
 * fingerprint are checked and both parts saved, or nothing is: a refusal leaves every field as it was. Running sessions
 * keep what they launched with until they restart (offered, as for any change of a connection); their role and
 * deliveries change at once.
 */
export async function changeConnection(id: string, ch: ConnectionChange): Promise<Connection> {
  const c = getConnection(id)
  const cli: ProviderId | undefined = accountById(c?.account)?.provider
  if (!c || !cli) throw combworkError(NO_CONNECTION, undefined, { kind: 'notFound' })
  const was = JSON.stringify(c.launch ?? null)
  const next = ch.launch === undefined ? c.launch : cleanLaunch(ch.launch, cli)
  const read = ch.launch !== undefined && turnsToolsOff(c.launch, next) ? await stableImpact(() => connectionImpact(id)) : null
  // From here to the write nothing awaits.
  ch.atWrite?.()
  const now = getConnection(id)
  if (!now) throw combworkError(NO_CONNECTION, undefined, { kind: 'notFound' })
  if (JSON.stringify(now.launch ?? null) !== was) throw combworkError(CHANGED_MEANWHILE, { name: now.name }, { kind: 'conflict' })
  if (read) {
    if (impactToken() !== read.token) throw combworkError(BUSY, undefined, { kind: 'conflict' })
    assertConfirmed(read.impact, ch.confirmed)
  }
  // Its values first (updateConnection checks them, and refuses before writing anything), then its launch settings.
  if (ch.values && Object.keys(ch.values).length) updateConnection(id, ch.values)
  if (ch.launch === undefined) return getConnection(id)!
  let saved: Connection | undefined
  config.update((cfg) => {
    cfg.connections = (cfg.connections ?? []).map((x) => {
      if (x.id !== id) return x
      const { launch: _old, ...rest } = x
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

/** Saves a connection's launch settings alone (Settings' Launch Settings dialog): changeConnection. */
export function setConnectionLaunch(id: string, raw: unknown, confirmed?: string | null): Promise<Connection> {
  return changeConnection(id, { launch: raw ?? {}, confirmed })
}

/**
 * What a change of one agent would take out of the workflow (HI-2670): moving it onto a connection without Combwork's
 * tools, or choosing Independent for it, while it is on a running lane or holds a card in Doing or Review. Null: nothing.
 */
export async function agentImpact(ws: WorkspaceService, projectPath: string, project: string, before: AgentDef | undefined, after: Pick<AgentDef, 'name' | 'role' | 'workflowRole' | 'connection'>): Promise<LaunchImpact | null> {
  if (!before || !inWorkflow(agentWorkflowRole(before)) || inWorkflow(agentWorkflowRole(after))) return null
  const { impact } = await stableImpact(async () => {
    const parts = await partsOf(ws, project, projectPath, before)
    return impactOf(parts ? [parts] : [])
  })
  return impact.agents.length ? impact : null
}

/**
 * The check an agent's change of role or connection makes under its project's lock, with nothing awaited before it (HR1
 * on s44, HR3 on s45), read first as one snapshot: the agent as saved still as it was read (its role and connection), so
 * whether the change makes it Independent is still what was worked out (an agent made a builder meanwhile is refused,
 * however the change looked when asked); where it does, `confirmed` naming exactly what that takes out of the workflow,
 * and nothing it reads written since. The caller holds the board's lock from the read through its file's save
 * (projectAgents.ts), so no card or lane is given to it between.
 */
export async function agentChangeCheck(ws: WorkspaceService, projectPath: string, project: string, before: AgentDef, change: Partial<Pick<AgentDef, 'workflowRole' | 'connection'>>, confirmed: string | null | undefined): Promise<(current: AgentDef) => void> {
  const becomes = (a: AgentDef): boolean => inWorkflow(agentWorkflowRole(a)) && !inWorkflow(agentWorkflowRole({ ...a, ...change }))
  const transition = becomes(before)
  const read = transition
    ? await stableImpact(async () => {
        const parts = await partsOf(ws, project, projectPath, before)
        return impactOf(parts ? [parts] : [])
      })
    : null
  // Checked now too, so a caller that didn't confirm is told at once, with the set and its fingerprint.
  if (read) assertConfirmed(read.impact, confirmed)
  return (current) => {
    // Its role or connection changed meanwhile, or its connection's tools since (what the change makes of it now isn't
    // what was worked out): refused, to be asked again.
    if (current.workflowRole !== before.workflowRole || current.connection !== before.connection || becomes(current) !== transition) throw combworkError(AGENT_CHANGED, { agent: current.name }, { kind: 'conflict' })
    if (!read) return
    // Anything it reads written since (a card given to it meanwhile, too): worked out again by the caller (ImpactMoved).
    if (impactToken() !== read.token) throw new ImpactMoved()
    assertConfirmed(read.impact, confirmed)
  }
}

/**
 * Thrown by agentChangeCheck's check when the board or a project changed between the read and the write: the caller reads
 * it again and tries once more (a few times), and a fingerprint confirmed before still holds only if the set is the same.
 */
export class ImpactMoved extends Error {
  constructor() {
    super('what the change affects was written to since it was read') // i18n-ignore: internal, caught and retried (never shown)
  }
}

/** Refused after the tries: the board kept changing between reading what a change affects and saving it. */
export const impactBusy = (): Error => combworkError(BUSY, undefined, { kind: 'conflict' })
const AGENT_CHANGED = msg({ id: 'main.connections.launch.agentChanged', defaultMessage: "{agent}'s role or connection was changed meanwhile: nothing was saved. Try again.", description: "An error saving an agent's settings (HI-2670): its role or connection was changed by something else while this change of its role or connection was being checked, so nothing was saved. {agent} is its name." })

