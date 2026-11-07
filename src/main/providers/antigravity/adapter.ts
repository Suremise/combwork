import { createHash } from 'crypto'
import { join, resolve } from 'path'
import { existsSync } from 'original-fs'
import { cp, mkdir, readdir, stat } from 'original-fs/promises'
import type { AgentInstallInfo, McpServerDef, MemorySource, PathDataCopy, PermissionMode, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { ANTIGRAVITY, ANTIGRAVITY_DESCRIPTOR, antigravityModeFlags } from '../../../shared/antigravity'
import { ASSISTANT_AGENT_ID } from '../../../shared/assistant'
import { TOOLS_SERVER } from '../../../shared/assistantTools'
import { isProviderEnabled } from '../../../shared/providers'
import { fmt, msg } from '../../../shared/i18n'
import { overrideId } from '../../../shared/advanced'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { config } from '../../config'
import { combworkError } from '../../combworkError'
import { writeJsonAtomic } from '../../fsutil'
import { compareVersions, hookForwardCommand, syncAgentsSkills, toSpawnable, AGENTS_SKILLS } from '../common'
import type { Ask, CatalogRead, CommandSpec, ConversationParserLike, ExternalSession, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { antigravityEnv, brainDir, inProfile, profilesRoot } from './home'
import { antigravityInstallCommand, antigravityLoginCommand, antigravityReadiness, antigravityUpdateCommand, checkModels, locateAntigravity } from './install'
import { UnreadableConfig, workspaceServers, type WorkspaceServer } from './projectConfig'
import { addUserStep, agyHooks, agyLockReply, agyNoticeReply, agyStartContextReply, agyStatusAsk, agyStatusDetails, agyStopContinues, isConversationId, normalizeAgyHook, UserSteps } from './hooks'

// Google's Antigravity CLI (agy) as a Combwork provider (HI-2544, against 1.5.0; the runtime facts are HI-2543's).
// Each agent runs in a private agy profile of its own (USERPROFILE: agy reads its home from it alone), kept between launches
// because agy keeps its conversations there (brain\<id>), with HOME left the user's. Each launch rewrites the profile's
// MCP servers (Combwork's, with the launch's token). A workspace folder's own MCP servers the agent wasn't given refuse the
// launch (profileConfig: agy can't be kept from starting them). The user's own global agy customizations (~\.gemini) are
// never read (Darren, 7 Nov: hidden for now).
// Hooks, transcripts and usage are HI-2545's and HI-2546's: until they land those parts return nothing.

const NAME = ANTIGRAVITY_DESCRIPTOR.name

const REFUSED = {
  unreadable: msg({ id: 'providers.antigravity.unreadableConfig', defaultMessage: "{provider} didn't start: Combwork couldn't read {file} ({why}), which it would load. Fix or remove the file, then start the agent again.", description: "Why an Antigravity CLI agent didn't start (its pane): a config file in the project (an MCP server or hook list) couldn't be read, so Combwork couldn't keep what it holds out of the agent. {provider} is the CLI's name, {file} a path, {why} the error's own words." }),
  notOwn: msg({ id: 'providers.antigravity.notOwnConversation', defaultMessage: "{provider} didn't resume {conversation}: it isn't in this agent's own conversations (it may have been removed, or be another agent's). Start a new session instead.", description: "Why an Antigravity CLI agent didn't resume a conversation (its pane): the conversation isn't among this agent's own. {provider} is the CLI's name, {conversation} the conversation's id." }),
  projectServers: msg({ id: 'providers.antigravity.projectServers', defaultMessage: "{provider} didn't start: {count, plural, one {{files} defines} other {{files} define}} MCP servers this agent wasn't given ({servers}), and {provider} would start them in its session. Combwork can't keep them out, so it doesn't start {provider} here. Remove them from that file, or give them to the agent in Combwork's MCP servers.", description: "Why an Antigravity CLI agent didn't start (its pane): a project or added folder's .agents config defines MCP servers the agent wasn't given, which Antigravity can't be kept from starting. {provider} is the CLI's name, {files} the config files' paths joined as a list, {count} how many files, {servers} the servers' names joined as a list. MCP servers is a place in Combwork." })
}

/** An agent's private profile: kept per agent; the Assistant's (the same id in every workspace) per workspace too. */
export function profileFolder(agentId: string, workspacePath: string): string {
  const key = agentId === ASSISTANT_AGENT_ID ? `${ASSISTANT_AGENT_ID}-${createHash('sha256').update(resolve(workspacePath).toLowerCase()).digest('hex').slice(0, 16)}` : agentId
  return join(profilesRoot(), key)
}

export { isConversationId }

/** An MCP server as agy's mcp_config.json has it (1.5.0: stdio command/args/env, or Streamable HTTP url/headers). */
export function agyServer(def: McpServerDef): Record<string, unknown> | null {
  if (typeof def.url === 'string' && def.url) return { url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
  if (typeof def.command === 'string' && def.command) return { command: def.command, ...(def.args?.length ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) }
  return null
}

/**
 * The private profile's mcp_config.json for a launch: Combwork's servers, each with the launch's own token in its env. A
 * workspace server the agent wasn't given (one not defined in the profile under its name) refuses the launch: `refused`,
 * with the file each comes from. agy 1.5.0 can't be kept from starting it: a same-name private definition replaces it only
 * while that one runs (agy falls back to the project's when it ends, HI-2544's sentinel runs), and `disabled` still starts
 * it, so nothing short of not launching keeps it out (HR1, 02:27: fail closed).
 */
export function profileConfig(given: Record<string, McpServerDef>, workspace: Map<string, WorkspaceServer[]>): { mcp: Record<string, unknown>; refused?: Map<string, string> } {
  // Null-prototype, own keys only: a server named __proto__, constructor or toString is an entry like any other, and
  // nothing inherited ever counts as one the agent was given.
  const servers: Record<string, unknown> = Object.create(null)
  for (const [name, def] of Object.entries(given)) {
    const s = agyServer(def)
    if (s) servers[name] = s
  }
  // Given under its name counts only as the very same server, every definition of that name agy could load: were
  // Combwork's to end, agy's fallback would then start nothing the agent wasn't given.
  const refused = new Map<string, string>()
  for (const [name, defs] of workspace) {
    const bad = Object.hasOwn(servers, name) ? defs.find((w) => !sameServer(servers[name], w.def)) : defs[0]
    if (bad) refused.set(name, bad.file)
  }
  return { mcp: { mcpServers: servers }, ...(refused.size ? { refused } : {}) }
}

/**
 * A server definition in a canonical form, every field kept (its command, arguments, environment, URL, headers and any
 * other), keys sorted; an empty `args`, `env` or `headers` is the same as none. Null for what isn't a server.
 */
function canonicalServer(d: unknown): string | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v && typeof v === 'object') return Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])
    return v
  }
  const empty = (k: string, v: unknown): boolean => ['args', 'env', 'headers'].includes(k) && ((Array.isArray(v) && !v.length) || (!!v && typeof v === 'object' && !Object.keys(v).length))
  const o = d as Record<string, unknown>
  // What runs nothing (no command, no URL) is never the same server as anything.
  if (!(typeof o.command === 'string' && o.command) && !(typeof o.url === 'string' && o.url)) return null
  return JSON.stringify(Object.keys(o).sort().filter((k) => !empty(k, o[k])).map((k) => [k, sorted(o[k])]))
}

/**
 * Whether two MCP server definitions are the same server: equal in every field (command, arguments, environment, URL,
 * headers and anything else), so neither runs other code, another account or another transport. Any difference, or a
 * field only one has, is not the same.
 */
export function sameServer(a: unknown, b: unknown): boolean {
  const x = canonicalServer(a)
  return x !== null && x === canonicalServer(b)
}

/**
 * agy's settings for one launch only (--settings, never saved): the status line that tells Combwork the conversation's id
 * and the session's state (Combwork's own command, posting to the hook server with the launch's token; shown under agy's
 * own line, as Combwork's reply is empty), and Combwork's own tools allowed (agy's rule form, its permissions docs:
 * `mcp(<server>/<tool>)`, or `mcp(<server>/*)` for all of a server's).
 */
export function launchSettings(ctx: Pick<LaunchContext, 'hookUrl' | 'hookAuthFile' | 'mcpServers' | 'trustedCombworkTools'>, preApprove: boolean): Record<string, unknown> {
  const allow = !Object.hasOwn(ctx.mcpServers, TOOLS_SERVER) || !preApprove ? [] : ctx.trustedCombworkTools ? ctx.trustedCombworkTools.map((t) => `mcp(${TOOLS_SERVER}/${t})`) : [`mcp(${TOOLS_SERVER}/*)`]
  return {
    statusLine: { type: 'command', command: hookForwardCommand(`${ctx.hookUrl}&statusline`, ctx.hookAuthFile), stack_with_default: true },
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
    let workspace: Map<string, WorkspaceServer[]>
    try {
      workspace = await workspaceServers([ctx.cwd, ...(ctx.extraDirs ?? [])])
    } catch (e) {
      if (e instanceof UnreadableConfig) throw combworkError(REFUSED.unreadable, { provider: NAME, file: e.file, why: e.why })
      throw e
    }
    const made = profileConfig(ctx.mcpServers, workspace)
    if (made.refused) {
      const files = [...new Set(made.refused.values())]
      throw combworkError(REFUSED.projectServers, { provider: NAME, servers: fmt.list([...made.refused.keys()]), count: files.length, files: fmt.list(files) })
    }
    const profile = profileFolder(ctx.agentId, ctx.workspacePath)
    await mkdir(join(profile, '.gemini', 'config'), { recursive: true })
    // The servers' env (and the launch's token) stays in the profile, under Combwork's own data: never the project.
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'mcp_config.json'), made.mcp)
    // Combwork's hooks, for this launch (its URL and token file): agy reads the profile's hooks.json, never the project's.
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'hooks.json'), agyHooks(ctx.hookUrl, ctx.hookAuthFile, advanced.get<boolean>('antigravity.hooks.toolHooks')))
    await writeJsonAtomic(join(ctx.privateDir, 'agy-settings.json'), launchSettings(ctx, launchOverrides(ctx.overrides, ANTIGRAVITY, 'preApproveCombworkTools')))
    return delivered
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const s = toSpawnable(executable, antigravityArgs(ctx, join(ctx.privateDir, 'agy-settings.json')))
    const env = inProfile(antigravityEnv(ctx.env, launchOverrides(ctx.overrides, ANTIGRAVITY, 'noAutoUpdate'), launchOverrides(ctx.overrides, ANTIGRAVITY, 'stripAccountVars')), profileFolder(ctx.agentId, ctx.workspacePath))
    return { file: s.file, args: s.args, env }
  }

  /** Its status line (Combwork's own command): the model and context window (agyStatusDetails). Usage and cost are HI-2546's. */
  statusLine(body: Record<string, any>): LiveDetails {
    return agyStatusDetails(body)
  }

  /** A permission prompt only its status line tells of (agy sends no hook for one). */
  statusLineAsk(body: Record<string, any>): Ask | null {
    return agyStatusAsk(body)
  }

  /** The conversation the status line names (statusLineConversation), for Combwork to learn a new launch's id. */
  statusLineSession(body: Record<string, any>): string | null {
    return statusLineConversation(body)
  }

  // ---- Hooks (HI-2545, hooks.ts).
  /** The user's prompts taken, per conversation (a step seen again is no new prompt). */
  private readonly userSteps = new UserSteps()

  /** The user's prompt that began an execution, read from this agent's own transcript (agy's hooks carry none). */
  prepareHook(body: Record<string, any>, launch: { agentId: string; workspacePath: string; sessionId: string | null }): Promise<void> {
    return addUserStep(body, profileFolder(launch.agentId, launch.workspacePath), launch.sessionId, this.userSteps)
  }

  normalizeHook(body: Record<string, any>): NormalizedHook {
    return normalizeAgyHook(body)
  }

  lockReply(d: LockDecision): Record<string, unknown> {
    return agyLockReply(d)
  }

  noticeReply(event: string, text: string): Record<string, unknown> | null {
    return agyNoticeReply(event, text)
  }

  startContextReply(text: string): Record<string, unknown> {
    return agyStartContextReply(text)
  }

  stopContinues(reply: Record<string, any>): boolean {
    return agyStopContinues(reply)
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
      const servers = await workspaceServers([projectPath])
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
