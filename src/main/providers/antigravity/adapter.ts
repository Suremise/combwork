import { createHash } from 'crypto'
import { join, resolve } from 'path'
import { existsSync } from 'original-fs'
import { cp, mkdir, readdir, stat } from 'original-fs/promises'
import type { AgentInstallInfo, McpServerDef, MemorySource, PathDataCopy, PermissionMode, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { ANTIGRAVITY, ANTIGRAVITY_DESCRIPTOR, antigravityModeFlags } from '../../../shared/antigravity'
import { ASSISTANT_AGENT_ID } from '../../../shared/assistant'
import { TOOLS_SERVER } from '../../../shared/assistantTools'
import { isProviderEnabled } from '../../../shared/providers'
import { msg } from '../../../shared/i18n'
import { overrideId } from '../../../shared/advanced'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { config } from '../../config'
import { combworkError } from '../../combworkError'
import { writeJsonAtomic } from '../../fsutil'
import { compareVersions, hookForwardCommand, syncAgentsSkills, toSpawnable, AGENTS_SKILLS } from '../common'
import type { CatalogRead, CommandSpec, ConversationParserLike, ExternalSession, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { antigravityEnv, brainDir, inProfile, profilesRoot } from './home'
import { antigravityInstallCommand, antigravityLoginCommand, antigravityReadiness, antigravityUpdateCommand, checkModels, locateAntigravity } from './install'
import { UnreadableConfig, workspaceCustomizations } from './projectConfig'

// Google's Antigravity CLI (agy) as a Combwork provider (HI-2544, against 1.5.0; the runtime facts are HI-2543's).
// Each agent runs in a private agy profile of its own (USERPROFILE: agy reads its home from it alone), kept between launches
// because agy keeps its conversations there (brain\<id>), with HOME left the user's. Each launch rewrites the profile's
// MCP servers (Combwork's, with the launch's token) and the overrides that keep out what the agent wasn't given: a project's
// own MCP servers are replaced by Combwork's inert server of the same name (a private definition replaces the project's,
// and agy falls back to the project's only if the private one ends: HI-2544's sentinel runs), and its named hooks are
// switched off. The user's own global agy customizations (~\.gemini) are never read (Darren, 7 Nov: hidden for now).
// Hooks, transcripts and usage are HI-2545's and HI-2546's: until they land those parts return nothing.

const NAME = ANTIGRAVITY_DESCRIPTOR.name

const REFUSED = {
  unreadable: msg({ id: 'providers.antigravity.unreadableConfig', defaultMessage: "{provider} didn't start: Combwork couldn't read {file} ({why}), which it would load. Fix or remove the file, then start the agent again.", description: "Why an Antigravity CLI agent didn't start (its pane): a config file in the project (an MCP server or hook list) couldn't be read, so Combwork couldn't keep what it holds out of the agent. {provider} is the CLI's name, {file} a path, {why} the error's own words." }),
  notOwn: msg({ id: 'providers.antigravity.notOwnConversation', defaultMessage: "{provider} didn't resume {conversation}: it isn't in this agent's own conversations (it may have been removed, or be another agent's). Start a new session instead.", description: "Why an Antigravity CLI agent didn't resume a conversation (its pane): the conversation isn't among this agent's own. {provider} is the CLI's name, {conversation} the conversation's id." }),
  noInert: msg({ id: 'providers.antigravity.noInert', defaultMessage: "{provider} didn't start: the project has its own MCP servers ({servers}), and Combwork can't keep them out of the agent without its own MCP server. Turn Combwork's tools on for this agent, or remove the servers from the project's .agents folder.", description: "Why an Antigravity CLI agent didn't start (its pane): the project defines MCP servers the agent wasn't given, and Combwork's own MCP server (needed to stand in for them) isn't available. {provider} is the CLI's name, {servers} their names. .agents is a folder's name: keep it." })
}

/** An agent's private profile: kept per agent; the Assistant's (the same id in every workspace) per workspace too. */
export function profileFolder(agentId: string, workspacePath: string): string {
  const key = agentId === ASSISTANT_AGENT_ID ? `${ASSISTANT_AGENT_ID}-${createHash('sha256').update(resolve(workspacePath).toLowerCase()).digest('hex').slice(0, 16)}` : agentId
  return join(profilesRoot(), key)
}

/** A conversation id agy made: a UUID, safe as a folder name (never a path). */
export const isConversationId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

/** An MCP server as agy's mcp_config.json has it (1.5.0: stdio command/args/env, or Streamable HTTP url/headers). */
export function agyServer(def: McpServerDef): Record<string, unknown> | null {
  if (typeof def.url === 'string' && def.url) return { url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
  if (typeof def.command === 'string' && def.command) return { command: def.command, ...(def.args?.length ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) }
  return null
}

/**
 * Combwork's inert MCP server, standing in for a project server of the same name the agent wasn't given: cw-mcp.js run as
 * Combwork's own server is (`tools`: its definition) with CW_MCP_INERT=1, which answers the handshake, offers no tools
 * and stays up. Only the variable that makes Combwork's executable run it as Node is kept, never the launch's token.
 */
export function inertServer(tools: McpServerDef): Record<string, unknown> | null {
  if (typeof tools.command !== 'string' || !tools.command) return null
  const keep = Object.fromEntries(Object.entries(tools.env ?? {}).filter(([k]) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE'))
  return { command: tools.command, ...(tools.args?.length ? { args: tools.args } : {}), env: { ...keep, CW_MCP_INERT: '1' } }
}

/**
 * The private profile's mcp_config.json and hooks.json for a launch: Combwork's servers (each with the launch's own token
 * in its env), Combwork's inert server in place of each workspace server not given, and each workspace hook switched off.
 */
export function profileConfig(given: Record<string, McpServerDef>, workspace: { servers: Map<string, string>; hooks: Map<string, string> }): { mcp: Record<string, unknown>; hooks: Record<string, unknown>; refused?: string[] } {
  const servers: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(given)) {
    const s = agyServer(def)
    if (s) servers[name] = s
  }
  const inert = given[TOOLS_SERVER] ? inertServer(given[TOOLS_SERVER]) : null
  const missing: string[] = []
  for (const name of workspace.servers.keys()) {
    if (servers[name]) continue
    if (inert) servers[name] = inert
    else missing.push(name)
  }
  const hooks: Record<string, unknown> = {}
  for (const name of workspace.hooks.keys()) hooks[name] = { enabled: false }
  return { mcp: { mcpServers: servers }, hooks, ...(missing.length ? { refused: missing } : {}) }
}

/**
 * agy's settings for one launch only (--settings, never saved): the status line that tells Combwork the conversation's id
 * (Combwork's own command, posting to the hook server with the launch's token), and Combwork's own tools allowed.
 */
export function launchSettings(ctx: Pick<LaunchContext, 'hookUrl' | 'hookAuthFile' | 'mcpServers' | 'trustedCombworkTools'>, preApprove: boolean): Record<string, unknown> {
  const allow = !ctx.mcpServers[TOOLS_SERVER] || !preApprove ? [] : ctx.trustedCombworkTools ? ctx.trustedCombworkTools.map((t) => `mcp(${TOOLS_SERVER}:${t})`) : [`mcp(${TOOLS_SERVER})`]
  return {
    statusLine: { type: 'command', command: hookForwardCommand(`${ctx.hookUrl}&statusline`, ctx.hookAuthFile) },
    ...(allow.length ? { permissions: { allow } } : {})
  }
}

/** The launch command's arguments (1.5.0's --help). */
export function antigravityArgs(ctx: Pick<LaunchContext, 'resume' | 'sessionId' | 'model' | 'effort' | 'permissionMode' | 'extraDirs' | 'extraArgs' | 'initialPrompt'>, settingsFile: string): string[] {
  const args: string[] = []
  if (ctx.resume) {
    if (!isConversationId(ctx.sessionId)) throw new Error(`not an Antigravity conversation id: ${ctx.sessionId}`) // i18n-ignore: an internal check, never shown
    args.push('--conversation', ctx.sessionId)
  }
  args.push('--settings', settingsFile)
  if (ctx.model) args.push('--model', ctx.model)
  if (ctx.effort) args.push('--effort', ctx.effort)
  args.push(...antigravityModeFlags(ctx.permissionMode || ANTIGRAVITY_DESCRIPTOR.defaultPermissionMode))
  for (const d of ctx.extraDirs ?? []) args.push('--add-dir', d)
  args.push(...ctx.extraArgs)
  if (ctx.initialPrompt) args.push('-i', ctx.initialPrompt)
  return args
}

/** The status line's conversation id (agy 1.5.0: `conversation_id`, also `session_id`), when it is a valid one. */
export function statusLineConversation(body: Record<string, any>): string | null {
  const id = body?.conversation_id ?? body?.session_id
  return isConversationId(id) ? id : null
}

const emptyUsage = (sessionId: string): SessionUsage => ({
  provider: ANTIGRAVITY,
  sessionId,
  title: null,
  model: null,
  cliVersion: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
  reasoningTokens: 0,
  contextTokens: 0,
  contextWindow: null,
  compactions: [],
  cacheTtlSeconds: 0,
  firstActivity: null,
  lastActivity: null,
  userMessages: 0,
  lastPrompt: null,
  costUsd: null,
  costEstimated: false
})

export class AntigravityAdapter implements ProviderAdapter {
  readonly id = ANTIGRAVITY
  readonly descriptor = ANTIGRAVITY_DESCRIPTOR
  /** agy's account and updater variables are handled in its own environment (antigravityEnv): nothing for every child. */
  readonly envToStrip: string[] = []
  /** agy is checked in its sessions' environment (antigravityEnv), which these switches change. */
  readonly locateSettings = [overrideId(ANTIGRAVITY, 'stripAccountVars'), overrideId(ANTIGRAVITY, 'noAutoUpdate')]
  readonly compactFailure = null

  private signInPattern(): RegExp | null {
    try {
      return advanced.pattern('antigravity.signIn.needed')
    } catch {
      return null
    }
  }

  locate(): Promise<AgentInstallInfo> {
    return locateAntigravity(this.signInPattern())
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    return antigravityReadiness(info)
  }

  /** No published release feed Combwork reads: agy's own `update` says. */
  latestVersion(): Promise<string | null> {
    return Promise.resolve(null)
  }

  installCommand(): CommandSpec {
    return antigravityInstallCommand()
  }

  updateCommand(executable: string): CommandSpec {
    return antigravityUpdateCommand(executable)
  }

  loginCommand(executable: string): CommandSpec {
    return antigravityLoginCommand(executable)
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  /** The account's models, read in the launch's environment (no model turn). */
  async listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    if (!isProviderEnabled(config.settings, this.id)) return null
    const r = await checkModels(executable, antigravityEnv(env), this.signInPattern())
    return r.kind === 'ok' ? { models: r.models } : null
  }

  /** Its profiles start empty, with no model of the user's own: agy's own default applies. */
  configuredDefaultModel(): string | null {
    return null
  }

  ownsModel(model: string): boolean {
    return /^[a-z0-9][a-z0-9._:/-]*$/i.test(model.trim())
  }

  /** Skills go in the agent's working folder's .agents\skills, as for Codex and Copilot (marked as Combwork's copies). */
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(ctx.cwd, AGENTS_SKILLS, skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    // A resume reopens only one of this agent's own conversations (in its profile), never another's or a missing one.
    if (ctx.resume && !(await this.ownsConversation(ctx.agentId, ctx.workspacePath, ctx.sessionId))) throw combworkError(REFUSED.notOwn, { provider: NAME, conversation: ctx.sessionId })
    const delivered = await syncAgentsSkills(ctx, NAME)
    let workspace: Awaited<ReturnType<typeof workspaceCustomizations>>
    try {
      workspace = await workspaceCustomizations([ctx.cwd, ...(ctx.extraDirs ?? [])])
    } catch (e) {
      if (e instanceof UnreadableConfig) throw combworkError(REFUSED.unreadable, { provider: NAME, file: e.file, why: e.why })
      throw e
    }
    const made = profileConfig(ctx.mcpServers, workspace)
    if (made.refused) throw combworkError(REFUSED.noInert, { provider: NAME, servers: made.refused.join(', ') })
    const profile = profileFolder(ctx.agentId, ctx.workspacePath)
    await mkdir(join(profile, '.gemini', 'config'), { recursive: true })
    // The servers' env (and the launch's token) stays in the profile, under Combwork's own data: never the project.
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'mcp_config.json'), made.mcp)
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'hooks.json'), made.hooks)
    await writeJsonAtomic(join(ctx.privateDir, 'agy-settings.json'), launchSettings(ctx, launchOverrides(ctx.overrides, ANTIGRAVITY, 'preApproveCombworkTools')))
    return delivered
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const s = toSpawnable(executable, antigravityArgs(ctx, join(ctx.privateDir, 'agy-settings.json')))
    const env = inProfile(antigravityEnv(ctx.env, launchOverrides(ctx.overrides, ANTIGRAVITY, 'noAutoUpdate'), launchOverrides(ctx.overrides, ANTIGRAVITY, 'stripAccountVars')), profileFolder(ctx.agentId, ctx.workspacePath))
    return { file: s.file, args: s.args, env }
  }

  /** Its status line (Combwork's own command): the conversation's id, from the launch it belongs to. Its model and cost come with HI-2546. */
  statusLine(body: Record<string, any>): LiveDetails {
    void body
    return {}
  }

  /** The conversation the status line names (statusLineConversation), for Combwork to learn a new launch's id. */
  statusLineSession(body: Record<string, any>): string | null {
    return statusLineConversation(body)
  }

  // ---- Hooks (HI-2545): none yet.
  normalizeHook(): NormalizedHook {
    return { event: { kind: 'ignore' }, sessionId: null, transcriptPath: null, mode: null, editedPaths: [], ids: { turn: null, call: null, sub: null, continued: false } }
  }

  lockReply(d: LockDecision): Record<string, unknown> {
    void d
    return {}
  }

  noticeReply(): Record<string, unknown> | null {
    return null
  }

  stopContinues(): boolean {
    return false
  }

  canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
    return ANTIGRAVITY_DESCRIPTOR.canSwitchLive(target, current, launched)
  }

  // ---- Transcripts (HI-2546 reads them): where a conversation is, for resume.
  /** Its transcript: in the profile of the agent it belongs to (`recorded`: the path its hooks or status line gave). */
  async transcriptPath(_folder: string, sessionId: string, recorded?: string): Promise<string | null> {
    if (recorded && existsSync(recorded)) return recorded
    if (!isConversationId(sessionId)) return null
    const root = profilesRoot()
    let keys: string[] = []
    try {
      keys = await readdir(root)
    } catch {
      return null
    }
    for (const k of keys) {
      const p = join(brainDir(join(root, k)), sessionId, '.system_generated', 'logs', 'transcript.jsonl')
      if (existsSync(p)) return p
    }
    return null
  }

  restorePath(): string | null {
    return null
  }

  listSessions(): Promise<ExternalSession[]> {
    return Promise.resolve([])
  }

  subSessionOf(): Promise<SubSession | null> {
    return Promise.resolve(null)
  }

  /**
   * Whether `sessionId` is a conversation in this agent's own profile (resume only reopens its own: s17's check). An id
   * from another agent's profile, gone or moved, isn't.
   */
  async ownsConversation(agentId: string, workspacePath: string, sessionId: string): Promise<boolean> {
    if (!isConversationId(sessionId)) return false
    try {
      return (await stat(join(brainDir(profileFolder(agentId, workspacePath)), sessionId))).isDirectory()
    } catch {
      return false
    }
  }

  // ---- Usage (HI-2546): none read yet.
  parseUsage(_text: string, sessionId: string): SessionUsage {
    return emptyUsage(sessionId)
  }

  usageParser(sessionId: string): UsageParser {
    return { feed: () => undefined, result: () => emptyUsage(sessionId) }
  }

  conversationParser(): ConversationParserLike {
    return { items: [], images: [], offset: 0, feed: () => 0 }
  }

  imageData(): string | null {
    return null
  }

  exportSubtitle(sessionId: string): string {
    return `${NAME} conversation ${sessionId}` // i18n-ignore: an export's heading, as the other providers word it
  }

  // ---- Project files.
  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const p = this.id
    const sources: MemorySource[] = [
      { provider: p, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'project-gemini', label: 'GEMINI.md', path: join(projectPath, 'GEMINI.md'), kind: 'claude-md', exists: false } // i18n-ignore: a file's name
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    return sources
  }

  /** Nothing of agy's own folders: its agents' profiles are Combwork's, and the user's ~\.gemini is never shown or changed. */
  fileAllowed(): boolean {
    return false
  }

  skillRoots(): SkillRoots {
    return { machine: [], plugins: null, local: [AGENTS_SKILLS], combworkCopyPrefix: 'cw-' }
  }

  /** The project's own MCP servers (.agents\mcp_config.json): never given to its agents unless added to the workspace. */
  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    try {
      const { servers } = await workspaceCustomizations([projectPath])
      return Object.fromEntries([...servers.keys()].map((n) => [n, {} as McpServerDef]))
    } catch {
      return {}
    }
  }

  /** The Assistant's profile is kept by its workspace's path: a moved workspace's is copied to the new path's (never moved or deleted). */
  async copyPathData(from: string, to: string, apply: boolean): Promise<PathDataCopy[]> {
    const src = profileFolder(ASSISTANT_AGENT_ID, from)
    if (!existsSync(src)) return []
    const dst = profileFolder(ASSISTANT_AGENT_ID, to)
    if (apply && !existsSync(dst)) await cp(src, dst, { recursive: true, errorOnExist: false, force: false })
    return [{ provider: ANTIGRAVITY, from: src, to: dst, copy: existsSync(dst) && !apply ? 0 : 1, kept: [], failed: [] }]
  }
}

export const antigravity = new AntigravityAdapter()
