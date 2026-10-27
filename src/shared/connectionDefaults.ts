import type { AgentDef, AppSettings, AssistantProviderSettings, ConnectionDefaults, ConnectionsMoved, MovedField, ProjectConfig, ProviderId } from './types'
import { projectAgents } from './defaults'
import { projectProviderConfig, providerDescriptor, providerSettings } from './providers'

/**
 * Model, effort and context belong to the connection (HI-1770, Darren's 26 Oct ~23:10 and ~23:25 (2)): what a new
 * connection's defaults are copied from, and the one-time move of a project's own model, effort and context onto its
 * agents. Pure, for main and the tests.
 */

/** One value moved onto an agent that its connection can't use now (HI-1770): shown once, until dismissed. */
export interface MovedNotice {
  /** `<project path in lower case>|<moved entry's id>`: stable across opens and runs, for its dismissal. */
  key: string
  project: string
  agent: string
  field: MovedField
  value: string | boolean
}

/** The CLI's per-CLI defaults as a connection's (Settings → the CLI): copied onto a connection whose defaults aren't set yet. */
export function cliDefaults(settings: Pick<AppSettings, 'providers'>, provider: ProviderId): ConnectionDefaults {
  const g = providerSettings(settings, provider)
  return {
    ...(g.defaultModel ? { model: g.defaultModel } : {}),
    ...(g.defaultEffort ? { effort: g.defaultEffort } : {}),
    ...(providerDescriptor(provider).capabilities.contextLimit && g.use200kContext ? { use200kContext: true } : {})
  }
}

/**
 * The Assistant's own model, effort and context with connections: its agent's (the Assistant's dialog), else Settings →
 * Assistant's for its CLI (its own settings, not a project's); its connection's defaults come after.
 */
export function assistantOwn<A extends Pick<AgentDef, 'model' | 'effort' | 'use200kContext'>>(agent: A | null | undefined, s: Partial<AssistantProviderSettings> | undefined): A | null | undefined {
  if (!s) return agent
  const context = agent?.use200kContext ?? (s.use200kContext === 'on' ? true : s.use200kContext === 'off' ? false : undefined)
  return { ...(agent ?? ({} as A)), model: agent?.model || s.model || undefined, effort: agent?.effort || s.effort || undefined, use200kContext: context }
}

/** A project's own model, effort and context for a CLI, where it set one (not inherit): what moves onto its agents. */
export function projectOverrides(cfg: Pick<ProjectConfig, 'providers'>, provider: ProviderId): Partial<Record<MovedField, string | boolean>> {
  const pc = projectProviderConfig(cfg, provider)
  return {
    ...(pc.model && pc.model !== 'inherit' ? { model: pc.model } : {}),
    ...(pc.effort && pc.effort !== 'inherit' ? { effort: pc.effort } : {}),
    ...(providerDescriptor(provider).capabilities.contextLimit && (pc.use200kContext === 'on' || pc.use200kContext === 'off') ? { use200kContext: pc.use200kContext === 'on' } : {})
  }
}

/** Whether an agent has its own value for a field: a model or effort chosen, a context on or off (an explicit off counts). */
const hasOwn = (a: AgentDef, f: MovedField): boolean => (f === 'use200kContext' ? typeof a.use200kContext === 'boolean' : !!a[f])

/**
 * A CLI's project overrides moved onto the project's agents of that CLI (`providerOf`), each only where the agent has
 * none of its own (an explicit value is never overwritten, and nothing is given where the project set nothing), with
 * the record of it (`migrations.connections1[provider]`), as one patch for the write that holds the project's lock.
 * Null when it was done already: once per project and CLI, so a later CLI with connections moves its own.
 */
export function moveProjectOverrides(cfg: ProjectConfig, provider: ProviderId, providerOf: (a: AgentDef) => ProviderId, at: string): Pick<ProjectConfig, 'agents' | 'migrations'> | null {
  if (cfg.migrations?.connections1?.[provider]) return null
  const values = projectOverrides(cfg, provider)
  const moved: ConnectionsMoved['moved'] = []
  const agents = projectAgents(cfg).map((a) => {
    if (providerOf(a) !== provider) return a
    const next: AgentDef = { ...a }
    for (const [f, v] of Object.entries(values) as [MovedField, string | boolean][]) {
      if (hasOwn(a, f)) continue
      ;(next as Record<MovedField, unknown>)[f] = v
      moved.push({ id: `${provider}:${a.id}:${f}`, agent: a.id, field: f, value: v })
    }
    return next
  })
  return { agents, migrations: { ...cfg.migrations, connections1: { ...cfg.migrations?.connections1, [provider]: { at, moved } } } }
}
