import { join } from 'path'
import { mkdir, writeFile } from 'original-fs/promises'
import type { McpServerDef } from '../../../shared/types'
import { CLAUDE_AGENT_PROVIDER } from '../../../shared/opencode'
import { writeJsonAtomic } from '../../fsutil'

// OpenCode's private config folder (OPENCODE_CONFIG_DIR, HI-2759; HI-2758's Q2 and Q3, checked against 2.2.6): the
// config a launch or a check runs with. A launch's is in its private folder (removed when it ends: the MCP servers'
// tokens never sit in an account or a project); an account's checks' is in the account's folder.

/** A V2 policy rule (2.2.6's `policies`: last match wins, global before project). */
export interface Policy {
  action: 'provider.use' | 'mcp.use'
  resource: string
  effect: 'allow' | 'deny'
}

/** What an account has saved, by integration (`opencode auth list --format json`): each saved credential's method. */
export type SavedCredentials = Map<string, string[]>

/** The external (ambient) method each ambient integration has, as 2.2.6's integration listing names it. */
export const EXTERNAL_METHOD: Record<string, string> = { 'amazon-bedrock': 'aws-profile', 'google-vertex': 'google-adc' }

/**
 * The provider policies (HI-2759 design s10, s13): Claude Agent always denied; each ambient integration denied unless the
 * account saved a credential for it on purpose (`saved`, null when the listing failed: every one denied). With `strip`
 * off (the Advanced switch), the ambient ones are allowed: the user's explicit exception. Claude Agent never is.
 */
export function providerPolicies(ambient: readonly string[], saved: SavedCredentials | null, strip: boolean): Policy[] {
  const out: Policy[] = [{ action: 'provider.use', resource: CLAUDE_AGENT_PROVIDER, effect: 'deny' }]
  if (!strip) return out
  for (const id of ambient) if (!saved?.get(id)?.length) out.push({ action: 'provider.use', resource: id, effect: 'deny' })
  return out
}

/**
 * The ambient integrations whose chain the account chose (a saved credential with that integration's external method,
 * EXTERNAL_METHOD): their blockers are left out. A saved key for one keeps its blockers; azure has no external method.
 */
export function chosenAmbient(saved: SavedCredentials | null): Set<string> {
  const out = new Set<string>()
  for (const [id, method] of Object.entries(EXTERNAL_METHOD)) if (saved?.get(id)?.includes(method)) out.add(id)
  return out
}

/** A test copy's own local provider (CW_TEST_OPENCODE_PROVIDER, HI-2763's real tier): its id, its server and its model. */
export interface TestProvider {
  id: string
  baseURL: string
  model: string
}

/**
 * CW_TEST_OPENCODE_PROVIDER, JSON `{"id","baseURL","model"}`, honoured by unpackaged builds only (a DEV_SEAM): a real-tier
 * run's local provider, so it makes no cloud call. Anything malformed, a packaged build, or a base URL that isn't
 * loopback: none.
 */
export function testProviderOf(raw: string | undefined, packaged: boolean): TestProvider | null {
  if (packaged || !raw) return null
  try {
    const v = JSON.parse(raw) as Partial<TestProvider>
    const ok = typeof v.id === 'string' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(v.id) && typeof v.model === 'string' && !!v.model && typeof v.baseURL === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(v.baseURL)
    return ok ? { id: v.id!, baseURL: v.baseURL!, model: v.model! } : null
  } catch {
    return null
  }
}

/**
 * A config with the test provider in it (none: the config unchanged, the production recipe): the provider (2.2.6's V2
 * shape), every provider denied but it in place of the production provider policies (the MCP policies kept), and on a
 * launch its model.
 */
export function withTestProvider(cfg: Record<string, unknown>, tp: TestProvider | null, launch: boolean): Record<string, unknown> {
  if (!tp) return cfg
  const mcp = ((cfg.policies as Policy[] | undefined) ?? []).filter((p) => p.action === 'mcp.use')
  return {
    ...cfg,
    providers: { [tp.id]: { name: 'Combwork test', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: tp.baseURL }, models: { [tp.model]: { name: tp.model } } } }, // i18n-ignore: a test provider's name in a CLI's config, never shown
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: tp.id, effect: 'allow' }, ...mcp],
    ...(launch ? { model: `${tp.id}/${tp.model}` } : {})
  }
}

/** MCP servers allowed: every one denied, then each given allowed by name (2.2.6's mcp.use). */
export function mcpPolicies(servers: readonly string[]): Policy[] {
  return [{ action: 'mcp.use', resource: '*', effect: 'deny' }, ...servers.map((n): Policy => ({ action: 'mcp.use', resource: n, effect: 'allow' }))]
}

/** An MCP server as 2.2.6's `mcp.servers` has it: a local command (its command line and environment), or a remote URL. */
export function opencodeServer(def: McpServerDef): Record<string, unknown> | null {
  if (typeof def.url === 'string' && def.url) return { type: 'remote', url: def.url, ...(def.headers && Object.keys(def.headers).length ? { headers: def.headers } : {}) }
  if (typeof def.command === 'string' && def.command) return { type: 'local', command: [def.command, ...(def.args ?? [])], ...(def.env && Object.keys(def.env).length ? { environment: def.env } : {}) }
  return null
}

export interface LaunchConfigInput {
  model: string | null
  /** The OpenCode agent to start as (opencodeAgentOf), or none. */
  agent: 'build' | 'plan' | null
  mcpServers: Record<string, McpServerDef>
  /** Instructions files given explicitly (the project's AGENTS.md: the discovery switches drop it, decision 4). */
  instructions: string[]
  ambient: readonly string[]
  saved: SavedCredentials | null
  strip: boolean
  noUpdate: boolean
}

/** A launch's opencode.json. Own keys only: a server named __proto__ is an entry like any other. */
export function launchConfig(i: LaunchConfigInput): Record<string, unknown> {
  const servers: Record<string, unknown> = Object.create(null)
  for (const [name, def] of Object.entries(i.mcpServers)) {
    const s = opencodeServer(def)
    if (s) servers[name] = s
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(i.noUpdate ? { update: 'disable' } : {}),
    ...(i.model ? { model: i.model } : {}),
    ...(i.agent ? { default_agent: i.agent } : {}),
    mcp: { servers },
    policies: [...providerPolicies(i.ambient, i.saved, i.strip), ...mcpPolicies(Object.keys(servers))],
    ...(i.instructions.length ? { instructions: i.instructions } : {})
  }
}

/** An account's checks' config (its version, models, sign-ins): no MCP servers at all, the same provider policies. */
export function checkConfig(ambient: readonly string[], saved: SavedCredentials | null, strip: boolean, noUpdate: boolean): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(noUpdate ? { update: 'disable' } : {}),
    mcp: { servers: {} },
    policies: [...providerPolicies(ambient, saved, strip), ...mcpPolicies([])]
  }
}

/** A sign-in's config: Claude Agent denied, nothing else (the user connects what they choose, on purpose). */
export function loginConfig(noUpdate: boolean): Record<string, unknown> {
  return { $schema: 'https://opencode.ai/config.json', ...(noUpdate ? { update: 'disable' } : {}), mcp: { servers: {} }, policies: [{ action: 'provider.use', resource: CLAUDE_AGENT_PROVIDER, effect: 'deny' }, ...mcpPolicies([])] }
}

/** The machine-wide background service off for everything run with this config folder (HI-2758 Q2). */
export const SERVICE_OFF = { disabled: true }

/** Writes a config folder: opencode.json, service.json, and (when given) the global AGENTS.md OpenCode loads from it. */
export async function writeConfigDir(dir: string, config: Record<string, unknown>, guidance?: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, 'opencode.json'), config)
  await writeJsonAtomic(join(dir, 'service.json'), SERVICE_OFF)
  if (guidance !== undefined) await writeFile(join(dir, 'AGENTS.md'), guidance)
}

/** `opencode auth list --format json` (2.2.6): [{id, name, connections: [{type: 'credential', method, …} | {type: 'env', name}]}]. */
export function parseAuthList(text: string): { saved: SavedCredentials; integrations: { id: string; name: string; saved: number; env: string[] }[] } | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const saved: SavedCredentials = new Map()
  const integrations: { id: string; name: string; saved: number; env: string[] }[] = []
  for (const row of data) {
    if (!row || typeof row !== 'object' || typeof (row as any).id !== 'string') continue
    const id = (row as any).id as string
    const conns = Array.isArray((row as any).connections) ? ((row as any).connections as unknown[]) : []
    const methods = conns.filter((c: any) => c && c.type === 'credential').map((c: any) => (typeof c.method === 'string' ? c.method : ''))
    const env = conns.filter((c: any) => c && c.type === 'env' && typeof c.name === 'string').map((c: any) => c.name as string)
    if (methods.length) saved.set(id, methods)
    integrations.push({ id, name: typeof (row as any).name === 'string' ? (row as any).name : id, saved: methods.length, env })
  }
  return { saved, integrations }
}
