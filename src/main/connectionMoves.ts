import { basename, join } from 'path'
import { existsSync } from 'original-fs'
import type { Account, AgentDef, AppSettings, Connection, LaunchValues, MovedField, ProjectConfig, ProviderId } from '../shared/types'
import { baseConnection, launchValues, valuesOf } from '../shared/accounts'
import { COPILOT_ACCOUNT, type LegacyInputs, type MovedNotice, type AccountStore, migrateAssistant, migrateProject, migrateWorkspaceFile, placeUnplaced, waitsForConnection } from '../shared/connectionDefaults'
import { autoProviderPending, providerDescriptor } from '../shared/providers'
import { HIVE_DIR, projectAgents } from '../shared/defaults'
import { msg, tr } from '../shared/i18n'
import { config } from './config'
import { onHiveEvent, toast } from './events'
import { createLogger, userText } from './logger'
import { accountById, accountHere, allConnections, assertEffortTaken, connectionWith, effortUsable, firstUsableAccount, getConnection, newConnectionId } from './accounts'
import { testHomeSeam } from './connectionSeam'
import { providerService } from './providerService'
import { openWorkspaces, workspaceOf, type WorkspaceService } from './workspace'

/**
 * The accounts migration's runs (HI-2106; config.json's own is config.ts's, at start): each project's and the Assistant's
 * home's files when their workspace opens (and before anything launches there), under their locks, every agent pointed at
 * the connection it launched with (shared/connectionDefaults.ts), the connections made in config.json and saved first;
 * then the workspace's own old fields. Agents kept without one (their CLI had no account) get one once it has. And
 * HI-1770's notice of moved values a connection can't use, which the migration keeps.
 */

const log = createLogger('connections')

/** What a workspace's old data is read with (LegacyInputs): the global settings, its file as kept, the old connections. */
function inputsFor(ws: WorkspaceService): LegacyInputs {
  return {
    settings: config.settings,
    ws: ws.config,
    legacy: config.get().migrations?.accounts1?.legacy ?? [],
    seam: (cli) => {
      const caps = providerDescriptor(cli).capabilities.connections
      return !!caps && testHomeSeam(caps.homeEnv)
    }
  }
}

/** Saves config.json now, refusing what would name a connection it couldn't save (HR1's round 1 on HI-2106). */
export async function saveConnections(): Promise<void> {
  if (!(await config.saveNow())) throw new Error("config.json couldn't be saved") // i18n-ignore: logged, and shown in English in the notice's detail
}

/**
 * Writes a project under its lock (`write`) only with every connection it names already saved in config.json: config.json
 * is saved first (connections made by an earlier run, and its own migration's), then `plan` runs on the accounts as they
 * are, inside the write; when it has to make a connection (an agent changed meanwhile), that write writes nothing (`plan`
 * returns false), the connection is saved and the whole is run again. So a project never names a connection config.json
 * lost, and its old fields are never removed before what replaces them is on disk.
 */
async function withConnections(write: (plan: (fn: (store: AccountStore) => void) => boolean) => Promise<void>): Promise<void> {
  for (let tries = 0; tries < 5; tries++) {
    await saveConnections()
    let grew = false
    await write((fn) => {
      const c = config.get()
      const store: AccountStore = { accounts: [...(c.accounts ?? [])], connections: [...(c.connections ?? [])], newId: newConnectionId }
      fn(store)
      grew = store.connections.length !== (c.connections ?? []).length || store.accounts.length !== (c.accounts ?? []).length
      if (grew)
        config.update((x) => {
          x.accounts = store.accounts
          x.connections = store.connections
        })
      return !grew
    })
    if (!grew) return
  }
  throw new Error('its agents kept changing') // i18n-ignore: logged, and shown in English in the notice's detail
}

/**
 * A project's migration (or the Assistant's home's), then its agents without a connection placed where they can be: in
 * one write each, under the project's lock, and only with their connections saved first (withConnections).
 */
async function migrateOne(ws: WorkspaceService, projectPath: string): Promise<void> {
  const assistant = ws.isAssistantHome(projectPath)
  // A project without its project.json yet has nothing to migrate (its first write is a new one's).
  if (!assistant && !existsSync(join(projectPath, HIVE_DIR, 'project.json'))) return
  const read = await ws.projectConfig(projectPath)
  if (!read.migrations?.accounts1) {
    // Automatic's pick (an agent from before 0.2, the Assistant following Settings) is only known once detection answered.
    if (projectAgents(read).some((a) => !a.provider) && autoProviderPending(config.settings)) await providerService.settle()
    const at = new Date().toISOString()
    await withConnections(async (plan) => {
      let made = false
      let next: ProjectConfig | null = null
      await ws.mutateProjectConfig(projectPath, (cfg) => {
        const saved = plan((store) => {
          next = assistant ? migrateAssistant(cfg, inputsFor(ws), store, at) : migrateProject(cfg, inputsFor(ws), store, at)
        })
        // Connections made in this run: saved first, then the whole again.
        if (!saved || !next) return {}
        made = true
        // Removed in this write: the project's own launch settings (its agents' connections hold them now).
        return { ...(next as ProjectConfig), providers: undefined, defaultProvider: undefined } as unknown as Partial<ProjectConfig>
      })
      if (!made) return
      writes++
      log.info(`${userText(basename(projectPath))}: agents pointed at their connections (HI-2106)`)
    })
  }
  await placeLeft(ws, projectPath)
}

/** A project's agents kept without a connection, each given one once its CLI has an account (placeUnplaced). */
async function placeLeft(ws: WorkspaceService, projectPath: string): Promise<void> {
  const assistant = ws.isAssistantHome(projectPath)
  if (!placeable(await ws.projectConfig(projectPath), ws)) return
  await withConnections(async (plan) => {
    await ws.mutateProjectConfig(projectPath, (cfg) => {
      let r: ReturnType<typeof placeUnplaced> = null
      const saved = plan((store) => {
        r = placeUnplaced(cfg, (cli) => accountHere(cli, ws.config)?.id ?? null, store, assistant ? 'Assistant' : undefined) // i18n-ignore: a connection's name, the user's data once made
      })
      if (!saved || !r) return {}
      writes++
      const { cfg: next, placed } = r as NonNullable<ReturnType<typeof placeUnplaced>>
      // The Assistant's record of its connection per CLI takes in the one it got.
      if (assistant) {
        const rec = next.migrations!.accounts1!
        for (const c of Object.values(placed)) {
          const cli = accountById(c.account)?.provider
          if (cli) rec.assistant = { ...rec.assistant, [cli]: c.id }
        }
      }
      return { agents: next.agents, migrations: next.migrations }
    })
  })
}

/**
 * Whether a project has migrating left to do (HI-2106): not migrated yet, or an agent kept without a connection whose CLI
 * has an account here now. Read without its lock, so a launch (inside a refresh too) only waits for a write there is.
 */
export function migrationDue(cfg: ProjectConfig, ws: WorkspaceService): boolean {
  return !cfg.migrations?.accounts1 || placeable(cfg, ws)
}

/** Whether an agent kept without a connection could get one now: its CLI has an account here. */
function placeable(cfg: ProjectConfig, ws: WorkspaceService): boolean {
  return !!cfg.migrations?.accounts1 && projectAgents(cfg).some((a) => waitsForConnection(a, cfg) && !!a.provider && !!accountHere(a.provider, ws.config))
}

/** Writes the migration made (a project migrated, agents placed): a workspace looked at again is refreshed only after one. */
let writes = 0

/** Migrations under way, by project: a launch, an open and a new account at once share one. */
const running = new Map<string, Promise<void>>()

/**
 * Makes sure a project (or the Assistant's home) is migrated (HI-2106) and its agents placed where they can be, before
 * anything reads its agents' connections: a launch awaits it. Done already: a read, nothing written.
 */
export function ensureMigrated(projectPath: string): Promise<void> {
  const ws = workspaceOf(projectPath)
  const key = projectPath.toLowerCase()
  let run = running.get(key)
  if (!run) {
    run = migrateOne(ws, projectPath).finally(() => running.delete(key))
    running.set(key, run)
  }
  return run
}

/**
 * A workspace's migration: the Assistant's home first (it reads the workspace's old choices), then workspace.json's own
 * old fields go in one write recording it, then each project. A failure is logged and said once, and tried again at the
 * next open or launch.
 */
async function migrateWorkspace(ws: WorkspaceService): Promise<void> {
  if (!ws.path) return
  const at = new Date().toISOString()
  const before = writes
  try {
    await ensureMigrated(ws.assistantHome)
    if (!ws.config.migrations?.accounts1) {
      await ws.saveWorkspaceConfigWith((c) => {
        const next = migrateWorkspaceFile(c, at)
        if (!next) return {}
        writes++
        return { assistantConnection: undefined, ...(next.connections ? { connections: next.connections } : {}), migrations: next.migrations }
      })
    }
  } catch (e) {
    log.warn("the Assistant's launch settings couldn't be moved to its connections", e)
  }
  for (const projectPath of await ws.listProjectPaths().catch(() => [])) {
    await ensureMigrated(projectPath).catch((e) => {
      log.warn(`moving ${userText(basename(projectPath))}'s agents to their connections failed`, e)
      toast('error', tr(MOVE_FAILED, { project: basename(projectPath) }), String(e?.message ?? e), undefined, projectPath)
    })
  }
  if (writes !== before) await ws.refresh().catch(() => undefined)
}

export { effortUsable } from './accounts'

/**
 * The values moved onto agents by HI-1770 that their connection can't use now, in one workspace's projects only (the
 * asking window's: never another's), from each project's record of that move: a value its connection no longer has
 * (changed since) isn't listed; nor a dismissed one. Kept by the accounts migration (HI-2106): it says the value is now
 * in the agent's connection.
 */
export async function movedNotice(ws: WorkspaceService): Promise<MovedNotice[]> {
  if (!ws.path) return []
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
        const values = a && launchOf(a, cfg)
        if (dismissed.has(key) || !a || !values || values[m.field] !== m.value || a.provider !== cli) continue
        if (!unusable(a, values, cli, m.field)) continue
        out.push({ key, project: basename(projectPath), agent: a.name, field: m.field, value: m.value })
      }
    }
  }
  return out
}

/** An agent's launch values: its connection's once its project is migrated, else its own (as before HI-2106). */
function launchOf(a: AgentDef, cfg: ProjectConfig): LaunchValues | null {
  if (!cfg.migrations?.accounts1) return a
  return getConnection(a.connection) ?? null
}

/** Whether a value moved onto an agent is one its connection can't use (an effort its model doesn't take; context where the CLI has none). */
function unusable(a: AgentDef, values: LaunchValues, cli: ProviderId, field: MovedField): boolean {
  if (field === 'use200kContext') return !providerDescriptor(cli).capabilities.contextLimit
  if (field !== 'effort' || !values.effort) return false
  const account = accountById((getConnection(a.connection) as Connection | undefined)?.account) ?? null
  return !effortUsable(cli, values.model || null, account, values.effort)
}

/** Dismisses the notice's entries the asking window showed (only those listed now: one of another workspace, or a later CLI's, stays). */
export async function dismissMovedNotice(ws: WorkspaceService, keys: string[]): Promise<void> {
  const shown = new Set((await movedNotice(ws)).map((n) => n.key))
  const add = keys.filter((k) => shown.has(k))
  if (!add.length) return
  config.update((c) => void (c.ui.connectionsNoticeDismissed = [...new Set([...(c.ui.connectionsNoticeDismissed ?? []), ...add])]))
}

const MOVE_FAILED = msg({ id: 'main.connections.moveFailed', defaultMessage: "Hive couldn't move {project}'s model settings to its agents", description: "A notice's title (HI-1770): moving a project's own model, effort and context settings onto its agents (connections now hold the defaults) failed; it is tried again at the next start. {project} is the project's name." })

// ---------------------------------------------------------------------------
// The Assistant through today's screens (the adapter until HI-2108).
// ---------------------------------------------------------------------------

/**
 * Points a workspace's Assistant, for a CLI, at the connection on `account` (or its CLI's first usable here) with the
 * values its connection for that CLI has, as `values` changes them (a value emptied: the account's base connection's):
 * its agent's when it runs that CLI, else the one its record keeps for when it does. `cli` given as its CLI: it moves to it.
 */
export function pointAssistant(ws: WorkspaceService, cli: ProviderId, opts: { account?: string | null; values?: Partial<Record<keyof LaunchValues, unknown>>; become?: boolean }): Promise<void> {
  if (!ws.path) return Promise.resolve()
  // One change of a workspace's Assistant at a time, each from what the one before it left (HR1's round 1: two edits at
  // once kept only one of them).
  return serially(`assistant\n${ws.path.toLowerCase()}`, () => pointAssistantNow(ws, cli, opts))
}

/** Changes of the Assistant under way, by workspace: each starts once the one before it has ended. */
const assistantChanges = new Map<string, Promise<void>>()

function serially(key: string, fn: () => Promise<void>): Promise<void> {
  const run = (assistantChanges.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => undefined)
  assistantChanges.set(key, tail)
  void tail.then(() => assistantChanges.get(key) === tail && assistantChanges.delete(key))
  return run
}

/** The connection the Assistant's home names for a CLI: its agent's when it runs that CLI, else its record's. */
const assistantConnectionOf = (cfg: ProjectConfig, cli: ProviderId): string | undefined => {
  const agent = projectAgents(cfg)[0]
  return agent?.provider === cli ? agent.connection : cfg.migrations?.accounts1?.assistant?.[cli]
}

async function pointAssistantNow(ws: WorkspaceService, cli: ProviderId, opts: { account?: string | null; values?: Partial<Record<keyof LaunchValues, unknown>>; become?: boolean }): Promise<void> {
  const home = ws.assistantHome
  await ensureMigrated(home)
  // Worked out from its connection as saved; changed by something else (its dialog) before this write: worked out again.
  for (let tries = 0; tries < 3; tries++) {
    const cfg = await ws.projectConfig(home)
    const was = assistantConnectionOf(cfg, cli)
    const current = getConnection(was)
    const account = accountById(opts.account ?? (current && accountById(current.account)?.provider === cli ? current.account : undefined)) ?? accountHere(cli, ws.config)
    if (!account) return
    const base = baseConnection(account.id, allConnections())
    const values: LaunchValues = { ...valuesOf(current ?? base ?? {}) }
    for (const [k, v] of Object.entries(opts.values ?? {}) as [keyof LaunchValues, unknown][]) (values as Record<string, unknown>)[k] = v === '' || v === null || v === undefined ? base?.[k] : v
    // Decision E: a model and effort it was given that don't go together are refused, nothing changed.
    if (values.effort && opts.values && ('effort' in opts.values || 'model' in opts.values)) assertEffortTaken(cli, values.model ?? null, account, values.effort)
    const c = connectionWith(account.id, values, 'Assistant') // i18n-ignore: a connection's name, the user's data once made
    await saveConnections()
    let stale = false
    await ws.mutateProjectConfig(home, (now) => {
      if (assistantConnectionOf(now, cli) !== was) {
        stale = true
        return {}
      }
      const a = projectAgents(now)[0]
      const rec = now.migrations?.accounts1 ?? { at: new Date().toISOString() }
      const runs = !!a && (a.provider === cli || !!opts.become)
      return { ...(runs ? { agents: [{ ...a, provider: cli, connection: c.id }] } : {}), migrations: { ...now.migrations, accounts1: { ...rec, assistant: { ...rec.assistant, [cli]: c.id } } } }
    })
    if (stale) continue
    await ws.refresh().catch(() => undefined)
    return
  }
  throw new Error("the Assistant's connection kept changing") // i18n-ignore: logged
}

/** The Assistant's account for a CLI in the asking window's workspace (Settings → Assistant; null: its CLI's first usable here). */
export async function setAssistantAccount(ws: WorkspaceService, cli: ProviderId, account: string | null): Promise<void> {
  if (account && accountById(account)?.provider !== cli) throw new Error('not an account of that CLI') // i18n-ignore: the window offers only its CLI's
  await pointAssistant(ws, cli, { account })
}

/** Settings → Assistant changed (the adapter until HI-2108): every open workspace's Assistant follows its CLI and its values for it. */
async function followAssistantSettings(s: AppSettings, prev: AppSettings): Promise<void> {
  const now = s.assistant
  const was = prev.assistant
  for (const ws of openWorkspaces()) {
    if (!ws.path) continue
    try {
      for (const p of Object.keys(now?.providers ?? {}) as ProviderId[]) {
        const a = now.providers[p]
        const b = was?.providers?.[p]
        if (!a || JSON.stringify(a) === JSON.stringify(b)) continue
        const changed: Partial<Record<keyof LaunchValues, unknown>> = {}
        if (a.model !== b?.model) changed.model = a.model
        if (a.effort !== b?.effort) changed.effort = a.effort
        if (a.permissionMode !== b?.permissionMode) changed.permissionMode = a.permissionMode
        if (a.extraArgs !== b?.extraArgs) changed.extraArgs = a.extraArgs
        if (a.use200kContext !== b?.use200kContext) changed.use200kContext = a.use200kContext === 'on' ? true : a.use200kContext === 'off' ? false : ''
        if (Object.keys(changed).length) await pointAssistant(ws, p, { values: changed })
      }
      if (now?.provider !== was?.provider) {
        const cli = now.provider || firstUsableAccount(ws.config)?.provider
        if (cli) await pointAssistant(ws, cli, { become: true })
      }
    } catch (e) {
      log.warn("the Assistant couldn't follow Settings → Assistant", e)
    }
  }
}

/**
 * Decision E for Settings → Assistant and Settings → GitHub Copilot (the adapter until HI-2107 and HI-2108), checked
 * before a change of settings is saved (config.onSettingsCheck): a change of a model or effort that, merged with the
 * connection it goes to (the effort or model it keeps from it included), makes a pair the model doesn't take is refused
 * whole, its caller told, settings and connections unchanged. For each open workspace's Assistant, its connection for
 * that CLI (its agent's, or its record's); for Copilot, its account's base connection. What the migration carried over,
 * or a later catalogue left, isn't checked: only a change.
 */
export function checkLaunchSettings(next: AppSettings, prev: AppSettings): void {
  for (const p of Object.keys(next.assistant?.providers ?? {}) as ProviderId[]) {
    const a = next.assistant.providers[p]
    const b = prev.assistant?.providers?.[p]
    if (!a || (a.model === b?.model && a.effort === b?.effort)) continue
    for (const ws of openWorkspaces()) {
      const home = ws.path ? ws.info()?.assistant : null
      if (!home) continue
      const agent = home.agents[0]
      const current = getConnection(agent?.provider === p ? (agent.connectionId ?? agent.connection) : home.config.migrations?.accounts1?.assistant?.[p])
      const account = accountById(current?.account) ?? accountHere(p, ws.config)
      if (!account) continue
      checkPair(p, account, current ?? baseConnection(account.id, allConnections()), { model: a.model, effort: a.effort }, { model: b?.model, effort: b?.effort })
    }
  }
  const c = next.providers?.copilot
  const d = prev.providers?.copilot
  const copilot = accountById(COPILOT_ACCOUNT)
  if (c && copilot && (c.defaultModel !== d?.defaultModel || c.defaultEffort !== d?.defaultEffort)) checkPair('copilot', copilot, baseConnection(copilot.id, allConnections()), { model: c.defaultModel, effort: c.defaultEffort }, { model: d?.defaultModel, effort: d?.defaultEffort })
}

/** The pair a change makes with the connection it goes to (each value changed, else the connection's), refused when the model doesn't take the effort. */
function checkPair(cli: ProviderId, account: Account, conn: Connection | undefined, now: { model?: string; effort?: string }, was: { model?: string; effort?: string }): void {
  const base = baseConnection(account.id, allConnections())
  const model = now.model !== was.model ? now.model || base?.model : conn?.model
  const effort = now.effort !== was.effort ? now.effort || base?.effort : conn?.effort
  if (effort) assertEffortTaken(cli, model ?? null, account, effort)
}

/**
 * Settings → GitHub Copilot's model, effort, mode and extra arguments changed (the adapter until HI-2107): its account's
 * base connection takes the change, as its agents without settings of their own ran with them before.
 */
function followCopilotSettings(s: AppSettings, prev: AppSettings): void {
  const now = s.providers?.copilot
  const was = prev.providers?.copilot
  if (!now || !was) return
  const changed: Partial<LaunchValues> = {}
  if (now.defaultModel !== was.defaultModel) changed.model = now.defaultModel || undefined
  if (now.defaultEffort !== was.defaultEffort) changed.effort = now.defaultEffort || undefined
  if (now.defaultPermissionMode !== was.defaultPermissionMode) changed.permissionMode = now.defaultPermissionMode
  if (now.extraArgs !== was.extraArgs) changed.extraArgs = now.extraArgs || undefined
  if (!Object.keys(changed).length) return
  const account = accountById(COPILOT_ACCOUNT)
  if (!account) return
  const base = baseConnection(account.id, allConnections())
  const next = launchValues({ ...valuesOf(base ?? {}), ...changed }, 'copilot')
  // Decision E: a model and effort that don't go together aren't applied (the setting was saved: logged, kept as it was).
  if (next.effort && !effortUsable('copilot', next.model ?? null, account, next.effort)) {
    log.warn(`Settings → GitHub Copilot: ${userText(next.model ?? 'its default model')} doesn't take ${next.effort} effort; its connection is kept as it was`)
    return
  }
  config.update((c) => {
    const first = baseConnection(account.id, c.connections ?? [])
    c.connections = (c.connections ?? []).map((x) => (x.id === first?.id ? { id: x.id, account: x.account, name: x.name, ...launchValues({ ...valuesOf(x), ...changed }, 'copilot') } : x))
  })
}

/** Workspaces migrated since Hive started; an account added or turned on looks at them again (agents waiting for one). */
const looked = new Set<string>()

/** The migration's part of Hive's start (index.ts): at each workspace's open, and when accounts change (agents waiting for one). */
export function initConnectionMoves(): void {
  const look = (): void => {
    for (const ws of openWorkspaces()) {
      if (!ws.path || looked.has(ws.path.toLowerCase())) continue
      looked.add(ws.path.toLowerCase())
      void migrateWorkspace(ws)
    }
  }
  config.onSettingsCheck(checkLaunchSettings)
  config.onSettingsChanged((s, prev) => {
    if (JSON.stringify(s.assistant) !== JSON.stringify(prev.assistant)) void followAssistantSettings(s, prev)
    followCopilotSettings(s, prev)
  })
  onHiveEvent((e) => {
    if (e.type === 'connections-changed' || e.type === 'settings-changed') looked.clear()
    if (e.type === 'workspace-changed' || e.type === 'connections-changed' || e.type === 'settings-changed') look()
  })
}
