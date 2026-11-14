import { join } from 'path'
import { existsSync } from 'original-fs'
import { mkdir, stat, writeFile } from 'original-fs/promises'
import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { MUSE, MUSE_DESCRIPTOR } from '../../../shared/providers/muse'
import { fmt, msg, tr } from '../../../shared/i18n'
import { overrideId } from '../../../shared/advanced'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { config } from '../../config'
import { combworkError } from '../../combworkError'
import { agentsSkillCopyPath, compareVersions, exportSubtitleText, keepBounded, syncAgentsSkills, toSpawnable, AGENTS_SKILLS } from '../common'
import type { CommandSpec, ConnectionStatus, ConversationParserLike, ExternalSession, LaunchContext, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { localDataRoot } from '../localData'
import { ACCOUNT_VARS, DATA_ENV, museConfigDir, museEnv, museHome } from './home'
import { checkHome, checkSandbox, locateMuse, museLoginCommand, museReadiness, museSandboxSetupCommand, type SandboxState } from './install'
import { guidancePaths, hookPath, launchGuidance, launchServers, museArgs, museHooks, startContext, windowsShortName } from './launch'
import { museLockReply, normalizeMuseHook, type EditTools } from './hooks'
import { judgeProject, projectConfig, UnreadableConfig, type ProjectConfig } from './projectConfig'
import { launchNames, type MuseNames } from './names'
import { MuseConversationParser, MuseUsageParser, isMuseSessionId, museSessionFile, parseMuseTranscript } from './transcript'

// Meta's Muse Code as a Combwork provider (HI-3202, against 1.4.20; the spike HI-2895). Each launch runs on its account's
// roots (home.ts: XDG_DATA_HOME the account's folder, XDG_CONFIG_HOME beside it), never the user's own Muse. Everything
// Combwork gives it is for that run only, on its command line (launch.ts): its hooks, its MCP servers, the trust its tools
// need. Trust also loads the project's own .mcp.json servers and .muse hooks, which Muse can't be told to leave out, so a
// launch they would add to is refused (projectConfig.ts), unless the user turns that off. Combwork's skills are copies in
// the working folder's .agents\skills (Muse's project skills), shared and locked as Codex's are.

const NAME = MUSE_DESCRIPTOR.name

const REFUSED = {
  unreadable: msg({ id: 'providers.muse.unreadableConfig', defaultMessage: "{provider} didn't start: Combwork couldn't read {file} ({why}), which {provider} would load. Fix or remove the file, then start the agent again.", description: "Why a Muse Code agent didn't start (its pane): a config file in the project (an MCP server or hook list) couldn't be read, so Combwork couldn't keep what it holds out of the agent. {provider} is the CLI's name, {file} a path, {why} the error's own words." }),
  projectServers: msg({ id: 'providers.muse.projectServers', defaultMessage: "{provider} didn't start: {count, plural, one {{files} defines} other {{files} define}} MCP servers this agent wasn't given ({servers}), and {provider} starts a project's servers along with Combwork's tools. Combwork can't keep them out, so it doesn't start {provider} here. Remove them from that file, or give them to the agent in Combwork's MCP servers.", description: "Why a Muse Code agent didn't start (its pane): the project's own .mcp.json (or Muse settings) defines MCP servers the agent wasn't given, which Muse can't be kept from starting. {provider} is the CLI's name, {files} the config files' paths joined as a list, {count} how many files, {servers} the servers' names joined as a list. MCP servers is a place in Combwork." }),
  projectHooks: msg({ id: 'providers.muse.projectHooks', defaultMessage: "{provider} didn't start: {count, plural, one {{files} defines} other {{files} define}} hooks of the project's own, which {provider} runs along with Combwork's tools. Combwork can't keep them out, so it doesn't start {provider} here. Remove them from that file, then start the agent again.", description: "Why a Muse Code agent didn't start (its pane): the project's own Muse hooks file defines hooks, which Muse can't be kept from running. {provider} is the CLI's name, {files} the files' paths joined as a list, {count} how many files." }),
  otherAccount: msg({ id: 'providers.muse.otherAccount', defaultMessage: "{provider} didn't resume {session}: it is in another Muse Code account's sessions, not the account this agent runs on now. Start a new session, or move the agent back to that account.", description: "Why a Muse Code agent didn't resume a session (its pane): each Muse Code account keeps its own sessions, and this one isn't in the account the agent runs on. {provider} is the CLI's name, {session} the session's id." }),
  hookPath: msg({ id: 'providers.muse.hookPath', defaultMessage: "{provider} didn't start: its hook commands can't name Combwork's files in {folder}, because that path has a space or a character Windows' command prompt reads, and Windows has no short name for it. Muse runs its hooks in a way that can't quote a path. Turn on 8.3 short names for that drive, or move Combwork's data to a path without spaces.", description: "Why a Muse Code agent didn't start (its pane): Muse runs hook commands through cmd without being able to quote a path, and the folder of Combwork's launch files has a space or a special character and no 8.3 short name. {provider} is the CLI's name, {folder} a path. 8.3 short names is a Windows feature's name." }),
  pointerTooLong: msg({ id: 'providers.muse.guidanceTooLong', defaultMessage: "{provider} didn't start: Combwork's guidance is over {provider}'s start limit of {max, number} bytes, and even the pointer to the file that holds it doesn't fit. Raise \"Guidance: most Muse takes at start\" in Settings → Advanced.", description: "Why a Muse Code agent didn't start (its pane): its guidance, and the short pointer that replaces it, are both over Muse's start limit. {provider} is the CLI's name, {max} a size in bytes. The quoted text is an advanced setting's title: use that setting's translated title. Settings → Advanced is a place in Combwork." })
}

const NOTICE = {
  title: msg({ id: 'providers.muse.notice.title', defaultMessage: 'Muse can’t use everything this agent was given', description: "A notice as a Muse Code agent starts: something it was given can't apply (an MCP server it can't be passed, its sandbox)." }),
  servers: msg({ id: 'providers.muse.notice.servers', defaultMessage: "{count, plural, one {The MCP server {servers} isn’t} other {The MCP servers {servers} aren’t}} passed to Muse: a literal secret in one (use an environment variable reference such as $'{TOKEN}'), a reference to a variable that isn’t set, text mixed with a variable, or a name with characters other than letters, digits, - and _ keeps it out.", description: "Part of a notice as a Muse Code agent starts: MCP servers it was given are left out, and why they can be. {servers}: their names joined as a list; {count}: how many. $'{TOKEN}' is ICU-quoted and shows as ${TOKEN}, an example of a reference: keep it exactly, quotes included." }),
  sandbox: msg({ id: 'providers.muse.notice.sandbox', defaultMessage: "Muse's Windows sandbox isn't set up, so this agent shows Muse's setup screen in its pane and waits there: answer it there yourself, or once for every agent with Set up in Provider Setup. Combwork never answers it.", description: "Part of a notice as a Muse Code agent starts before Muse's Windows sandbox was set up. Set up and Provider Setup are Combwork's names: keep them." }),
  projectOff: msg({ id: 'providers.muse.notice.projectOff', defaultMessage: "{count, plural, one {{files} is} other {{files} are}} the project's own Muse config, which this agent loads along with Combwork's tools, because \"Keep the project's own Muse MCP servers and hooks out\" is off in Settings → Advanced.", description: "Part of a notice as a Muse Code agent starts with the project's own Muse config loaded, because the user turned off Combwork's switch. {files}: paths joined as a list; {count}: how many. The quoted text is an advanced setting's title: use that setting's translated title." })
}

/** A launch's facts from prepareLaunch for buildCommand and launchNotice. */
interface Prepared {
  home: string
  servers: Record<string, Record<string, unknown>>
  /** The servers' values, in Muse's environment (launchServers): their -c values name them. */
  vars: Record<string, string>
  skipped: string[]
  /** The launch's guidance file and auth file as its hook commands name them (hookPath). */
  guidanceFile: string | null
  authFile: string
  projectFiles: string[]
}

export class MuseAdapter implements ProviderAdapter {
  readonly id = MUSE
  readonly descriptor = MUSE_DESCRIPTOR
  /**
   * `pinned`: a launch's own names (forLaunch), which its hooks were given and are read back by to its end; absent (the
   * registry's instance), the names as they are now.
   */
  constructor(private readonly pinned: MuseNames | null = null) {}
  /** Its copy for a launch (HI-3202): Muse's names (muse.names.*) taken now and kept until it ends. */
  forLaunch(): ProviderAdapter {
    return new MuseAdapter(launchNames())
  }
  private get names(): MuseNames {
    return this.pinned ?? launchNames()
  }
  // Its capability parts (ProviderAdapter), each implemented by this class's own members.
  get install(): this {
    return this
  }
  get launch(): this {
    return this
  }
  get hooks(): this {
    return this
  }
  get modes(): this {
    return this
  }
  get transcript(): this {
    return this
  }
  get usage(): this {
    return this
  }
  get accounts(): this {
    return this
  }
  get models(): this {
    return this
  }
  get compaction(): this {
    return this
  }
  get projectFiles(): this {
    return this
  }
  /** Its account variables are handled in its own environment (museEnv, accountEnvDrop): nothing for every child. */
  readonly envToStrip: string[] = []
  /** Muse is checked in its sessions' environment, which this switch changes. */
  readonly locateSettings = [overrideId(MUSE, 'stripAccountVars')]
  readonly compactFailure = null
  /** 1.4.20's `muse resume <id>` takes no prompt ("unknown argument", observed): a resume's first prompt is typed. */
  readonly resumePromptTyped = true

  /** Muse's sandbox, as the last check found it (null before one). */
  private sandbox: SandboxState | null = null
  private prepared = new Map<string, Prepared>()
  /** Sessions' logs found, by session id (museSessionFile walks day folders). */
  private files = new Map<string, string>()

  // ---- Install.
  async locate(): Promise<AgentInstallInfo> {
    const info = await locateMuse()
    this.sandbox = info.found && info.path ? await checkSandbox(info.path).catch(() => 'unknown' as const) : null
    return info
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    return museReadiness(info, this.sandbox)
  }

  /** `muse sandbox windows setup` in a terminal the user answers (its elevation is Windows' and the user's, never Combwork's). */
  setupCommand(executable: string): CommandSpec {
    return museSandboxSetupCommand(executable)
  }

  /** No release feed Combwork reads, and 1.4.20 has no update command: Meta's installer updates it. */
  latestVersion(): Promise<string | null> {
    return Promise.resolve(null)
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  /** Combwork's own root, outside any account (Provider Setup's checks). */
  configHome(): string {
    return checkHome()
  }

  // ---- Accounts (connections: an account per folder of Combwork's, XDG_DATA_HOME).
  /** Outside an account: Combwork's own root, never the user's. */
  loginCommand(executable: string): CommandSpec {
    return museLoginCommand(executable, museHome(null))
  }

  accountLoginCommand(executable: string, home?: string): CommandSpec {
    return museLoginCommand(executable, home || museHome(null))
  }

  /** An account's Set Up is its sign-in, on its own roots: never the raw CLI with only its data root (which would read the user's config). */
  accountSetUpCommand(executable: string, home: string): CommandSpec {
    return museLoginCommand(executable, home)
  }

  /**
   * Signed in when the account's config root has Muse's auth.json (1.4.20 keeps its saved credential there; `muse login`
   * says "Credential saved to …"). The file is never read: only that it is there.
   */
  async accountStatus(_executable: string, env: NodeJS.ProcessEnv): Promise<ConnectionStatus> {
    const home = env[DATA_ENV]
    if (!home) return { ok: false, error: 'no account folder' } // i18n-ignore: an internal state, shown in English as an error's detail
    try {
      return { ok: true, loggedIn: (await stat(join(museConfigDir(home), 'auth.json'))).isFile() }
    } catch {
      return { ok: true, loggedIn: false }
    }
  }

  /** No account folder is shared with another (capabilities.connections.shared is empty). */
  accountSharedTarget(name: string): string {
    return join(museHome(null), name)
  }

  /** Its sign-in is in the config root inside the folder, not at its top: no top-level file is watched as a login. */
  accountLoginFile(): boolean {
    return false
  }

  accountEnvDrop(): readonly string[] {
    return launchOverrides(undefined, MUSE, 'stripAccountVars') ? ACCOUNT_VARS : []
  }

  // ---- Models.
  /** Its accounts start empty, with no model of the user's own: Muse's default applies. */
  configuredDefaultModel(): string | null {
    return null
  }

  ownsModel(model: string): boolean {
    return /^[a-z0-9][a-z0-9._:/-]*$/i.test(model.trim())
  }

  // ---- Launch.
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return agentsSkillCopyPath(ctx.cwd, skill)
  }

  private editTools(): EditTools {
    return { names: advanced.pattern('muse.hooks.editTools'), pathField: advanced.get<string>('muse.hooks.pathField') }
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    this.prepared.delete(ctx.runId)
    const home = museHome(ctx.connectionHome)
    await mkdir(join(home, 'xdg-config'), { recursive: true })
    // Each account keeps its own sessions: one made on another account isn't there to resume.
    if (ctx.resume && !(await museSessionFile([home], ctx.sessionId))) throw combworkError(REFUSED.otherAccount, { provider: NAME, session: ctx.sessionId })
    // The project's own config a trusted launch would load, read now (late, just before the launch), never run.
    const keepOut = launchOverrides(ctx.overrides, MUSE, 'keepProjectConfigOut')
    let project: ProjectConfig
    try {
      project = await projectConfig(ctx.cwd)
    } catch (e) {
      if (keepOut && e instanceof UnreadableConfig) throw combworkError(REFUSED.unreadable, { provider: NAME, file: e.file, why: e.why })
      if (keepOut) throw e
      project = { servers: new Map(), hookFiles: [] }
    }
    // The agent's servers as it was given them, every field, against the project's.
    const verdict = judgeProject(ctx.mcpServers, project)
    if (keepOut && verdict.refused.size) {
      const files = [...new Set(verdict.refused.values())]
      throw combworkError(REFUSED.projectServers, { provider: NAME, servers: fmt.list([...verdict.refused.keys()]), count: files.length, files: fmt.list(files) })
    }
    if (keepOut && verdict.hookFiles.length) throw combworkError(REFUSED.projectHooks, { provider: NAME, count: verdict.hookFiles.length, files: fmt.list(verdict.hookFiles) })
    const { pass, vars, skipped } = launchServers(ctx.mcpServers, verdict.fromProject, ctx.env, this.names.config)
    // The guidance, whole where it fits Muse's start limit, else a pointer to the file holding it (startContext).
    const paths = guidancePaths(ctx.privateDir)
    const max = advanced.number('muse.guidance.maxBytes')
    const guidance = launchGuidance(ctx)
    const start = startContext(guidance, max, paths.full)
    if (start.tooLong) throw combworkError(REFUSED.pointerTooLong, { provider: NAME, max })
    await mkdir(ctx.privateDir, { recursive: true })
    if (start.full !== null) await writeFile(paths.full, start.full)
    if (start.printed) await writeFile(paths.start, start.printed)
    // Its hook commands name these files with no quote (hookPath): a path cmd can't read unquoted refuses the launch.
    const authFile = await hookPath(ctx.hookAuthFile, windowsShortName)
    const guidanceFile = start.printed ? await hookPath(paths.start, windowsShortName) : null
    if (!authFile || (start.printed && !guidanceFile)) throw combworkError(REFUSED.hookPath, { provider: NAME, folder: ctx.privateDir })
    const delivered = await syncAgentsSkills(ctx, NAME)
    const projectFiles = keepOut ? [] : [...new Set([...project.servers.values()].flat().map((s) => s.file).concat(project.hookFiles))]
    this.prepared.set(ctx.runId, { home, servers: pass, vars, skipped: [...skipped.keys()], guidanceFile, authFile, projectFiles })
    return delivered
  }

  /** What the user is told as an agent starts: servers left out, the sandbox not set up, the project's own config loaded. */
  launchNotice(ctx: LaunchContext): { title: string; message: string } | null {
    const p = this.prepared.get(ctx.runId)
    const parts: string[] = []
    if (p?.skipped.length) parts.push(tr(NOTICE.servers, { servers: fmt.list(p.skipped), count: p.skipped.length }))
    if (p?.projectFiles.length) parts.push(tr(NOTICE.projectOff, { files: fmt.list(p.projectFiles), count: p.projectFiles.length }))
    if (this.sandbox === 'setup') parts.push(tr(NOTICE.sandbox))
    return parts.length ? { title: tr(NOTICE.title), message: parts.join(' ') } : null
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const p = this.prepared.get(ctx.runId)
    if (!p) throw new Error('a Muse launch was built before it was prepared') // i18n-ignore: an internal check, never shown
    keepBounded(this.prepared, ctx.runId, p)
    const names = this.names
    const hooks = museHooks(ctx.hookUrl, p.authFile, p.guidanceFile, advanced.number('muse.hooks.timeoutSeconds'), names.events)
    const args = museArgs({ ctx: { ...ctx, executable }, hooks, servers: p.servers, keepPersonalOut: launchOverrides(ctx.overrides, MUSE, 'keepPersonalOut'), config: names.config })
    const env = { ...museEnv(ctx.env, p.home, launchOverrides(ctx.overrides, MUSE, 'stripAccountVars')), ...p.vars }
    return { ...toSpawnable(executable, args), env }
  }

  /** Muse's sandbox setup screen, never answered by Combwork: the agent waits for the user there. */
  // A resumed 1.4.20 runs its SessionStart hook only with its first prompt (the Sandbox check, 14 Nov): its input box on
  // screen means it is up, and its typed first prompt (resumePromptTyped) follows from that (an advanced value, #367).
  get readyOutput(): RegExp | undefined {
    try {
      return advanced.pattern('muse.ready.input')
    } catch {
      return undefined
    }
  }
  get startupQuestion(): RegExp | undefined {
    try {
      return advanced.pattern('muse.sandbox.setupScreen')
    } catch {
      return undefined
    }
  }

  // ---- Hooks.
  normalizeHook(body: Record<string, any>): NormalizedHook {
    return normalizeMuseHook(body, this.editTools(), this.names)
  }

  lockReply(d: LockDecision): Record<string, unknown> {
    return museLockReply(d, this.names.fields)
  }

  /** None: Muse's reply forms for a notice aren't recorded (only PreToolUse's reply reaches it: launch.ts). */
  noticeReply(): Record<string, unknown> | null {
    return null
  }

  stopContinues(): boolean {
    return false
  }

  canSwitchLive(target: PermissionMode, current: PermissionMode | undefined, launched: PermissionMode | null | undefined): boolean {
    return MUSE_DESCRIPTOR.canSwitchLive(target, current, launched)
  }

  // ---- Transcripts: <XDG_DATA_HOME>\muse\sessions\YYYY\MM\DD\<id>\session.jsonl, in an account's folder (transcript.ts).
  /** The data roots a session may be in: each Muse account's folder, a test copy's seam home, Combwork's own. */
  private dataHomes(): string[] {
    const ids = (config.get().accounts ?? []).filter((a) => a.provider === MUSE && !a.home && a.kind !== 'server').map((a) => a.id)
    const homes = ids.map((id) => join(localDataRoot(), 'accounts', id))
    for (const h of [museHome(null)]) if (!homes.includes(h)) homes.push(h)
    return homes.filter((h) => existsSync(h))
  }

  async transcriptPath(_folder: string, sessionId: string): Promise<string | null> {
    if (!isMuseSessionId(sessionId)) return null
    const known = this.files.get(sessionId)
    if (known && existsSync(known)) return known
    const found = await museSessionFile(this.dataHomes(), sessionId)
    if (found) keepBounded(this.files, sessionId, found)
    return found
  }

  /** None: Muse resumes from its own session store, which a transcript put back wouldn't make. */
  restorePath(): string | null {
    return null
  }

  /** Sessions made outside Combwork aren't offered: each account's sessions are Combwork's own. */
  async listSessions(): Promise<ExternalSession[]> {
    return []
  }

  async subSessionOf(): Promise<SubSession | null> {
    return null
  }

  conversationParser(projectPath: string): ConversationParserLike {
    return new MuseConversationParser(projectPath)
  }

  imageData(): string | null {
    return null
  }

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
  }

  // ---- Usage (tokens only: Muse records no price, and none is invented).
  parseUsage(text: string, sessionId: string): SessionUsage {
    return parseMuseTranscript(text, sessionId)
  }

  usageParser(sessionId: string): UsageParser {
    const p = new MuseUsageParser(sessionId)
    return { feed: (text) => p.feed(text), result: () => p.result() }
  }

  // ---- Project files.
  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const s: MemorySource = { provider: this.id, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false } // i18n-ignore: a file's name
    s.exists = existsSync(s.path)
    return [s]
  }

  /** Nothing of Muse's own folders: its accounts are Combwork's, and the user's own Muse folders are never shown. */
  fileAllowed(): boolean {
    return false
  }

  skillRoots(): SkillRoots {
    return { machine: [], plugins: null, local: [AGENTS_SKILLS], combworkCopyPrefix: 'cw-' }
  }

  /** The project's own .mcp.json servers: never given to its agents unless added to the workspace (and they refuse a launch). */
  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    try {
      const { servers } = await projectConfig(projectPath)
      return Object.fromEntries([...servers.keys()].map((n) => [n, {} as McpServerDef]))
    } catch {
      return {}
    }
  }
}

export const muse = new MuseAdapter()

/** The adapter, as the registry finds it (src/main/providers/index.ts, HI-3201). */
export default muse
