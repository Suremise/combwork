import { randomBytes } from 'crypto'
import { join } from 'path'
import { existsSync } from 'original-fs'
import { mkdir, writeFile } from 'original-fs/promises'
import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { OPENCODE, OPENCODE_DESCRIPTOR, isClaudeAgentModel, isOpencodeModelId, opencodeAgentOf, opencodeModeFlags } from '../../../shared/opencode'
import { TOOLS_SERVER } from '../../../shared/assistantTools'
import { isProviderEnabled } from '../../../shared/providers'
import { msg } from '../../../shared/i18n'
import { overrideId } from '../../../shared/advanced'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { config } from '../../config'
import { combworkError } from '../../combworkError'
import { POWERSHELL } from '../../launchGate'
import { compareVersions, exportSubtitleText, toSpawnable } from '../common'
import type { CatalogRead, CommandSpec, ConnectionStatus, ConversationParserLike, ExternalSession, ImageLocation, LaunchContext, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { localDataRoot } from '../antigravity/home'
import { AMBIENT_DIRS, AMBIENT_FILES, DATA_ENV, ambientIntegrations, opencodeEnv, opencodeHome } from './home'
import { chosenAmbient, launchConfig, withTestProvider, writeConfigDir, type SavedCredentials } from './config'
import { accountModels, checkHome, testProvider, latestOpencode, locateOpencode, opencodeInstallCommand, opencodeLoginCommand, opencodeReadiness, opencodeUpdateCommand, savedCredentials } from './install'
import { expandOpencodeHook, normalizeOpencodeHook } from './events'
import { LAUNCHER_ARGS, LAUNCHER_SOURCE, launcherEnv, launcherSourcePath, ownerToken, sessionMark, sessionMarks } from './launcher'

// OpenCode 2 as a Combwork provider (HI-2759, against 2.2.6; the runtime facts are HI-2758's). Each launch runs its own
// private server, owned by the launcher (launcher.ts), on its account's roots (home.ts) with a private config folder
// (config.ts). Status from the server's events is HI-2760's; history and usage HI-2762's; Combwork's tools, guidance and
// skills HI-2761's: until then a launch gets the MCP servers and guidance it was given, as they are.

const NAME = OPENCODE_DESCRIPTOR.name

const REFUSED = {
  claudeAgent: msg({ id: 'providers.opencode.claudeAgentModel', defaultMessage: "{provider} didn't start: {model} is a model of OpenCode's Claude Agent provider, which Combwork doesn't run through OpenCode. Run Claude Code as its own provider instead, or choose another model.", description: "Why an OpenCode agent didn't start (its pane): its model belongs to OpenCode's nested Claude Agent provider, which Combwork never allows. {provider} is OpenCode, {model} the model's id. Claude Agent and Claude Code are product names: keep them." }),
  protectedArg: msg({ id: 'providers.opencode.protectedArg', defaultMessage: "{provider} didn't start: the agent's extra arguments include {arg}, which Combwork sets itself for every OpenCode launch. Remove it from the agent's extra arguments (Agent Settings).", description: "Why an OpenCode agent didn't start (its pane): its extra command-line arguments include one Combwork controls (its server, its session, its mode). {provider} is OpenCode, {arg} the argument as typed. Agent Settings is a place in Combwork." }),
  otherAccount: msg({ id: 'providers.opencode.otherAccount', defaultMessage: "{provider} didn't resume {session}: it is in another OpenCode account's data, not the account this agent runs on now. Start a new session, or move the agent back to that account.", description: "Why an OpenCode agent didn't resume a session (its pane): each OpenCode account keeps its own sessions, and this one was made on another account. {provider} is OpenCode, {session} the session's id." }),
  noOwner: msg({ id: 'providers.opencode.noOwner', defaultMessage: "{provider} didn't start: Combwork couldn't read its own process's identity, which the agent's private OpenCode server is tied to so that it ends with Combwork. Windows PowerShell may be blocked on this PC.", description: "Why an OpenCode agent didn't start (its pane): Combwork couldn't get the identity it ties the agent's server's lifetime to. {provider} is OpenCode. Windows PowerShell is a program's name: keep it." })
}

/** The TUI flags Combwork sets itself (its server, session, mode): refused in an agent's extra arguments. */
const PROTECTED_ARGS = /^(--server|--standalone|--session|-s|--continue|-c|--auto|--prompt)(=|$)/

/** A session id Combwork picks for a new OpenCode session: `ses_` and 26 base62 characters (2.2.6 takes any `ses…` id). */
export function newSessionId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(26)
  let s = 'ses_'
  for (const b of bytes) s += alphabet[b % 62]
  return s
}

/** Whether a session id is one OpenCode's API takes (Session.ID: `^ses`), safe in a URL path and a command line. */
export const isSessionId = (id: string): boolean => /^ses_?[A-Za-z0-9]{8,64}$/.test(id)

/** An agent's extra argument Combwork sets itself, if any. */
export const protectedArg = (args: readonly string[]): string | null => args.flatMap((a) => a.split(/\s+/)).find((a) => PROTECTED_ARGS.test(a)) ?? null

/** What prepareLaunch decided, for buildCommand (which can't wait): by run id, taken once. */
interface Prepared {
  home: string
  marks: string
  configDir: string
  ambientDir: string
  password: string
  owner: string
  chosen: Set<string>
}

/** The folder an account's (or the check root's) data is in, as accounts give it (capabilities.connections.homeEnv). */
const homeOf = (env: NodeJS.ProcessEnv): string | undefined => env[DATA_ENV] || undefined

/** The usage of a session Combwork can't read yet (HI-2762 reads OpenCode's sessions). */
function noUsage(sessionId: string): SessionUsage {
  return { provider: OPENCODE, sessionId, title: null, model: null, cliVersion: null, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: 0, reasoningTokens: 0, contextTokens: 0, contextWindow: null, compactions: [], cacheTtlSeconds: 0, firstActivity: null, lastActivity: null, userMessages: 0, lastPrompt: null, costUsd: null, costEstimated: false }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly id = OPENCODE
  readonly descriptor = OPENCODE_DESCRIPTOR
  /** OpenCode's environment is built whole by the adapter (home.ts): nothing for every child. */
  readonly envToStrip: string[] = []
  /** Its checks run with these switches (the update hold, the credentials), which change what they see. */
  readonly locateSettings = [overrideId(OPENCODE, 'noAutoUpdate'), overrideId(OPENCODE, 'stripCredentials')]
  readonly compactFailure = null
  private prepared = new Map<string, Prepared>()

  locate(): Promise<AgentInstallInfo> {
    return locateOpencode()
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    return opencodeReadiness(info)
  }

  latestVersion(): Promise<string | null> {
    return latestOpencode()
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  installCommand(): CommandSpec {
    return opencodeInstallCommand()
  }

  updateCommand(executable: string): CommandSpec {
    return opencodeUpdateCommand(executable)
  }

  /** Outside an account (Provider Setup): Combwork's own root, never the user's. */
  loginCommand(executable: string): CommandSpec {
    return opencodeLoginCommand(executable, opencodeHome(null))
  }

  /** An account's sign-in: `opencode auth login` on its own roots. */
  accountLoginCommand(executable: string, home?: string): CommandSpec {
    return opencodeLoginCommand(executable, home || opencodeHome(null))
  }

  /**
   * An account's Set Up is its sign-in, with the same protected preparation (HR1 on HI-2759): never the raw CLI with only
   * its data root, which would read the user's own config and start the machine-wide service.
   */
  accountSetUpCommand(executable: string, home: string): CommandSpec {
    return opencodeLoginCommand(executable, home)
  }

  /**
   * An account's providers, from `opencode auth list` on its roots: never signed out (OpenCode runs local and built-in
   * models with no sign-in, decision 2); its plan names the integrations it saved credentials for.
   */
  async accountStatus(executable: string, env: NodeJS.ProcessEnv): Promise<ConnectionStatus> {
    const home = homeOf(env)
    if (!home) return { ok: false, error: 'no account folder' } // i18n-ignore: an internal state, shown in English as an error's detail
    const list = await savedCredentials(executable, home)
    if (!list) return { ok: false, error: `${NAME} couldn't list the account's providers` } // i18n-ignore: an error's detail, English as the CLI's own
    const names = list.integrations.filter((i) => i.saved > 0).map((i) => i.name)
    return { ok: true, loggedIn: true, plan: names.length ? names.join(', ') : null }
  }

  /** The root OpenCode runs on outside an account (Combwork's own: opencodeHome), never the user's own data. */
  configHome(): string {
    return opencodeHome(null)
  }

  /** No account folder is shared with another (capabilities.connections.shared is empty): a name maps into the home only. */
  accountSharedTarget(name: string): string {
    return join(opencodeHome(null), name)
  }

  /**
   * No file at an account folder's top tells a sign-in apart: OpenCode keeps its credentials in its database, which every
   * check and session writes (its WAL, its logs, Combwork's check config), so none is watched as a login.
   */
  accountLoginFile(): boolean {
    return false
  }

  /** The account's own roots are set by the adapter whole: none of them may be dropped as a login variable. */
  accountEnvDrop(): readonly string[] {
    return []
  }

  /**
   * Its models: `opencode models` on each OpenCode account's roots (its own sign-ins and policies), together; on Combwork's
   * check root when there are none. Never a session or a prompt.
   */
  async listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    if (!isProviderEnabled(config.settings, this.id)) return null
    const homes = this.accountHomes(env)
    const seen = new Map<string, CatalogRead['models'][number]>()
    let any = false
    for (const home of homes) {
      const models = await accountModels(executable, home, env).catch(() => null)
      if (!models) continue
      any = true
      for (const m of models) if (!seen.has(m.value)) seen.set(m.value, m)
    }
    return any ? { models: [...seen.values()] } : null
  }

  /** The roots models are listed on: each OpenCode account's folder (and a test copy's seam home), else the check root. */
  private accountHomes(env: Record<string, string>): string[] {
    const ids = (config.get().accounts ?? []).filter((a) => a.provider === OPENCODE && !a.home && a.kind !== 'server').map((a) => a.id)
    const homes = ids.map((id) => join(localDataRoot(), 'accounts', id)).filter((h) => existsSync(h))
    const seam = opencodeHome(null, env)
    if (seam !== join(localDataRoot(), 'opencode', 'default') && !homes.includes(seam)) homes.push(seam)
    return homes.length ? homes : [checkHome()]
  }

  configuredDefaultModel(): string | null {
    return null
  }

  ownsModel(model: string): boolean {
    return isOpencodeModelId(model)
  }

  newSessionId(): string {
    return newSessionId()
  }

  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(ctx.privateDir, 'opencode-config', 'skills', skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    this.prepared.delete(ctx.runId)
    if (isClaudeAgentModel(ctx.model)) throw combworkError(REFUSED.claudeAgent, { provider: NAME, model: ctx.model ?? '' })
    const arg = protectedArg(ctx.extraArgs)
    if (arg) throw combworkError(REFUSED.protectedArg, { provider: NAME, arg })
    if (!isSessionId(ctx.sessionId)) throw new Error(`not an OpenCode session id: ${ctx.sessionId}`) // i18n-ignore: an internal check, never shown
    const owner = await ownerToken()
    if (!owner && process.platform === 'win32') throw combworkError(REFUSED.noOwner, { provider: NAME })
    const home = opencodeHome(ctx.connectionHome)
    await mkdir(home, { recursive: true })
    // Each account keeps its own sessions: one made on another account's data isn't there to resume (design s7, s10).
    if (ctx.resume && !existsSync(sessionMark(home, ctx.sessionId))) throw combworkError(REFUSED.otherAccount, { provider: NAME, session: ctx.sessionId })
    const strip = launchOverrides(ctx.overrides, OPENCODE, 'stripCredentials')
    const noUpdate = launchOverrides(ctx.overrides, OPENCODE, 'noAutoUpdate')
    // The account's saved credentials decide which ambient chains it chose (null: none could be read, so none).
    const listed = strip ? await savedCredentials(ctx.executable, home, ctx.env).catch(() => null) : null
    const saved: SavedCredentials | null = listed?.saved ?? null
    const configDir = join(ctx.privateDir, 'opencode-config')
    const ambientDir = join(ctx.privateDir, 'opencode-ambient')
    const mode = ctx.permissionMode || OPENCODE_DESCRIPTOR.defaultPermissionMode
    const agentsMd = join(ctx.cwd, 'AGENTS.md')
    const cfg = launchConfig({
      model: ctx.model,
      agent: opencodeAgentOf(mode),
      mcpServers: ctx.mcpServers,
      instructions: existsSync(agentsMd) ? [agentsMd] : [],
      ambient: ambientIntegrations(),
      saved,
      strip,
      noUpdate
    })
    await writeConfigDir(configDir, withTestProvider(cfg, testProvider(), true), launchGuidance(ctx))
    await mkdir(ambientDir, { recursive: true })
    for (const f of AMBIENT_FILES) await writeFile(join(ambientDir, f), '')
    for (const d of AMBIENT_DIRS) await mkdir(join(ambientDir, d), { recursive: true })
    await writeFile(launcherSourcePath(ctx.privateDir), LAUNCHER_SOURCE)
    this.prepared.set(ctx.runId, { home, marks: sessionMarks(home), configDir, ambientDir, password: randomBytes(24).toString('hex'), owner, chosen: strip ? chosenAmbient(saved) : new Set() })
    return {}
  }

  buildCommand(_executable: string, ctx: LaunchContext): CommandSpec {
    const p = this.prepared.get(ctx.runId)
    if (!p) throw new Error('an OpenCode launch was built before it was prepared') // i18n-ignore: an internal check, never shown
    this.prepared.delete(ctx.runId)
    const mode = ctx.permissionMode || OPENCODE_DESCRIPTOR.defaultPermissionMode
    const env = opencodeEnv({
      base: ctx.env,
      home: p.home,
      configDir: p.configDir,
      password: p.password,
      ambientDir: p.ambientDir,
      chosen: p.chosen,
      strip: launchOverrides(ctx.overrides, OPENCODE, 'stripCredentials'),
      noUpdate: launchOverrides(ctx.overrides, OPENCODE, 'noAutoUpdate'),
      keepOut: launchOverrides(ctx.overrides, OPENCODE, 'keepProjectConfigOut')
    })
    // A Node CLI's launcher runs as its node and script; any other .cmd/.bat through cmd.exe, escaped for it (launcher.ts).
    const run = toSpawnable(ctx.executable, [])
    const launcher = launcherEnv({
      executable: run.line === undefined ? run.file : ctx.executable,
      prefix: run.line === undefined ? run.args : [],
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      intent: ctx.resume ? 'resume' : 'new',
      tuiArgs: [...opencodeModeFlags(mode), ...ctx.extraArgs.flatMap((a) => a.split(/\s+/)).filter(Boolean)],
      dirs: [ctx.cwd, ctx.projectPath],
      privateDir: ctx.privateDir,
      owner: p.owner,
      marks: p.marks,
      hookUrl: ctx.hookUrl,
      readyMs: advanced.number('opencode.server.readySeconds') * 1000
    })
    return { file: POWERSHELL, args: LAUNCHER_ARGS, env: { ...env, ...launcher } }
  }

  // ---- Hooks (HI-2760): the launcher posts its server's events and settled snapshots; the tracker (events.ts), in the
  // launch's hook order, turns each into the hooks it stands for.
  async prepareHook(body: Record<string, any>, launch: { memo: Record<string, unknown> }): Promise<void> {
    const expanded = expandOpencodeHook(launch.memo, body)
    if (expanded) body.combworkExpanded = expanded
  }

  normalizeHook(body: Record<string, any>): NormalizedHook {
    return normalizeOpencodeHook(body)
  }

  lockReply(_d: LockDecision): Record<string, unknown> {
    return {}
  }

  noticeReply(): Record<string, unknown> | null {
    return null
  }

  stopContinues(): boolean {
    return false
  }

  canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
    return OPENCODE_DESCRIPTOR.canSwitchLive(target, current, launched)
  }

  // ---- Transcripts and usage: HI-2762 reads OpenCode's sessions from its server. Until then none are listed.
  /**
   * Combwork's record of the session in the account's data it was made on (the launcher writes it as it creates the
   * session), in place of a transcript (HI-2762's): a restart resumes the session when there is one, rather than taking
   * the same id as new. None: the session was never made.
   */
  async transcriptPath(_folder: string, sessionId: string): Promise<string | null> {
    if (!isSessionId(sessionId)) return null
    for (const home of this.allHomes()) {
      const mark = sessionMark(home, sessionId)
      if (existsSync(mark)) return mark
    }
    return null
  }

  /** Every root sessions may have been made on: each OpenCode account's, a test copy's seam home, Combwork's own. */
  private allHomes(): string[] {
    const ids = (config.get().accounts ?? []).filter((a) => a.provider === OPENCODE && !a.home && a.kind !== 'server').map((a) => a.id)
    const homes = ids.map((id) => join(localDataRoot(), 'accounts', id))
    for (const h of [opencodeHome(null), join(localDataRoot(), 'opencode', 'default')]) if (!homes.includes(h)) homes.push(h)
    return homes
  }

  restorePath(): string | null {
    return null
  }

  async listSessions(): Promise<ExternalSession[]> {
    return []
  }

  async subSessionOf(): Promise<SubSession | null> {
    return null
  }

  parseUsage(_text: string, sessionId: string): SessionUsage {
    return noUsage(sessionId)
  }

  usageParser(sessionId: string): UsageParser {
    return { feed: () => undefined, result: () => noUsage(sessionId) }
  }

  conversationParser(): ConversationParserLike {
    return { items: [], images: [], offset: 0, feed: () => 0 }
  }

  imageData(_line: Record<string, any>, _loc: ImageLocation): string | null {
    return null
  }

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
  }

  // ---- Project files.
  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const s: MemorySource = { provider: this.id, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false } // i18n-ignore: a file's name
    s.exists = existsSync(s.path)
    return [s]
  }

  /** Nothing of OpenCode's own folders: its accounts are Combwork's, and the user's own OpenCode folders are never shown. */
  fileAllowed(): boolean {
    return false
  }

  skillRoots(): SkillRoots {
    return { machine: [], plugins: null, local: [], combworkCopyPrefix: null }
  }

  /** The project's own OpenCode config never loads (the discovery switches), so none of its servers are offered. */
  async projectMcpServers(): Promise<Record<string, McpServerDef>> {
    return {}
  }
}

/** What a launch puts in its private config's AGENTS.md: Combwork's guidance (with its tools), the launch's instructions, the notes. */
export function launchGuidance(ctx: Pick<LaunchContext, 'guidance' | 'instructions' | 'notes' | 'mcpServers'>): string {
  const parts = [Object.hasOwn(ctx.mcpServers, TOOLS_SERVER) ? ctx.guidance : '', ctx.instructions ?? '', ctx.notes ?? ''].map((t) => t.trim()).filter(Boolean)
  return parts.length ? parts.join('\n\n') + '\n' : ''
}

export const opencode = new OpencodeAdapter()
