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
import { chosenAmbient, launchConfig, projectDecidesMcp, withTestProvider, writeConfigDir, type SavedCredentials } from './config'
import { copyOpencodeSkills, opencodeSkillsDir } from './skills'
import { accountModels, checkHome, testProvider, latestOpencode, locateOpencode, opencodeInstallCommand, opencodeLoginCommand, opencodeReadiness, opencodeUpdateCommand, savedCredentials } from './install'
import { expandOpencodeHook, normalizeOpencodeHook } from './events'
import { LAUNCHER_ARGS, LAUNCHER_SOURCE, launcherEnv, launcherSourcePath, ownerToken, sessionMark, sessionMarks } from './launcher'
import { OpencodeConversationParser, OpencodeUsageParser, parseMirrorUsage } from './mirror'
import { opencodeHistory } from './history'

// OpenCode 2 as a Combwork provider (HI-2759, against 2.2.6; the runtime facts are HI-2758's). Each launch runs its own
// private server, owned by the launcher (launcher.ts), on its account's roots (home.ts) with a private config folder
// (config.ts). Status from the server's events is HI-2760's; history and usage HI-2762's (history.ts: a mirror of each
// session read from its server, mirror.ts); Combwork's tools, guidance and skills HI-2761's.

const NAME = OPENCODE_DESCRIPTOR.name

const REFUSED = {
  claudeAgent: msg({ id: 'providers.opencode.claudeAgentModel', defaultMessage: "{provider} didn't start: {model} is a model of OpenCode's Claude Agent provider, which Combwork doesn't run through OpenCode. Run Claude Code as its own provider instead, or choose another model.", description: "Why an OpenCode agent didn't start (its pane): its model belongs to OpenCode's nested Claude Agent provider, which Combwork never allows. {provider} is OpenCode, {model} the model's id. Claude Agent and Claude Code are product names: keep them." }),
  protectedArg: msg({ id: 'providers.opencode.protectedArg', defaultMessage: "{provider} didn't start: the agent's extra arguments include {arg}, which Combwork sets itself for every OpenCode launch. Remove it from the agent's extra arguments (Agent Settings).", description: "Why an OpenCode agent didn't start (its pane): its extra command-line arguments include one Combwork controls (its server, its session, its mode). {provider} is OpenCode, {arg} the argument as typed. Agent Settings is a place in Combwork." }),
  otherAccount: msg({ id: 'providers.opencode.otherAccount', defaultMessage: "{provider} didn't resume {session}: it is in another OpenCode account's data, not the account this agent runs on now. Start a new session, or move the agent back to that account.", description: "Why an OpenCode agent didn't resume a session (its pane): each OpenCode account keeps its own sessions, and this one was made on another account. {provider} is OpenCode, {session} the session's id." }),
  historyBusy: msg({ id: 'providers.opencode.historyBusy', defaultMessage: "{provider} didn't start: Combwork's reader of OpenCode sessions didn't answer in time, so it couldn't take this session over from an earlier run. Start the agent again.", description: "Why an OpenCode agent didn't start (its pane): Combwork's background reader of OpenCode session histories didn't confirm in time that it let go of the session's earlier run. {provider} is OpenCode." }),
  noModel: msg({ id: 'providers.opencode.noModel', defaultMessage: "{provider} didn't start: Combwork keeps OpenCode to the provider in the connection's model, and this connection names none, so OpenCode would choose one itself, perhaps one of its free cloud models. Choose the connection's model (a provider and model, such as ollama/qwen3:8b) in Agent Settings, or turn off \"Keep OpenCode to the connection's own provider\" in Settings → Advanced.", description: "Why an OpenCode agent didn't start (its pane): Combwork only allows the provider of the connection's model, and no model (or no valid provider/model id) is set. {provider} is OpenCode. ollama/qwen3:8b is a model id: keep it. Agent Settings and Settings → Advanced are places in Combwork; the quoted text is an advanced setting's title: use that setting's translated title." }),
  effortNeedsModel: msg({ id: 'providers.opencode.effortNeedsModel', defaultMessage: "{provider} didn't start: the connection's effort is {effort}, which OpenCode sets as a variant of the model, and the connection names no model. Choose its model (a provider and model, such as ollama/qwen3:8b) or the default effort in Agent Settings.", description: "Why an OpenCode agent didn't start (its pane): an effort level is chosen, but OpenCode sets effort as a variant of a model and no model is chosen. {provider} is OpenCode, {effort} the effort as chosen (e.g. high). ollama/qwen3:8b is a model id: keep it. Agent Settings is a place in Combwork." }),
  effortNotListed: msg({ id: 'providers.opencode.effortNotListed', defaultMessage: "{provider} didn't start: the connection's effort is {effort}, and OpenCode doesn't list {effort} as a variant of {model} on this account, so Combwork can't set it. Choose one of the model's efforts, or the default, in Agent Settings. If OpenCode's models couldn't be read just now, start the agent again.", description: "Why an OpenCode agent didn't start (its pane): the chosen effort level isn't one of the variants OpenCode lists for the chosen model on this account (or the list couldn't be read). {provider} is OpenCode, {effort} the effort as chosen (e.g. high), {model} the model's id. Agent Settings is a place in Combwork." }),
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
  /** The session's model (provider/model) and its variant to set at the start (HI-2767), or none. */
  model: string | null
  variant: string | null
}

/** The folder an account's (or the check root's) data is in, as accounts give it (capabilities.connections.homeEnv). */
const homeOf = (env: NodeJS.ProcessEnv): string | undefined => env[DATA_ENV] || undefined

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
    return join(opencodeSkillsDir(join(ctx.privateDir, 'opencode-config')), skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    this.prepared.delete(ctx.runId)
    if (isClaudeAgentModel(ctx.model)) throw combworkError(REFUSED.claudeAgent, { provider: NAME, model: ctx.model ?? '' })
    const arg = protectedArg(ctx.extraArgs)
    if (arg) throw combworkError(REFUSED.protectedArg, { provider: NAME, arg })
    if (!isSessionId(ctx.sessionId)) throw new Error(`not an OpenCode session id: ${ctx.sessionId}`) // i18n-ignore: an internal check, never shown
    // The connection's own provider only (HI-2769): the provider part of its model, which it must name (with none, 2.2.6
    // chooses from its catalogue, its free cloud models included: HI-2768). A real-tier run's test provider is its model.
    const ownOnly = launchOverrides(ctx.overrides, OPENCODE, 'ownProviderOnly')
    const tp = testProvider()
    const model = tp ? `${tp.id}/${tp.model}` : (ctx.model?.trim() ?? '')
    if (ownOnly && !isOpencodeModelId(model)) throw combworkError(REFUSED.noModel, { provider: NAME })
    const ownProvider = ownOnly ? model.slice(0, model.indexOf('/')) : null
    const owner = await ownerToken()
    if (!owner && process.platform === 'win32') throw combworkError(REFUSED.noOwner, { provider: NAME })
    const home = opencodeHome(ctx.connectionHome)
    await mkdir(home, { recursive: true })
    // The session's model and effort, set at each start and resume before its TUI opens (HI-2767): the connection's model,
    // and its effort as that model's variant, only one this account's OpenCode lists for exactly that model (an unknown
    // variant 2.2.6 takes silently). No effort chosen: no variant, which sets the model's own default.
    const sessionModel = isOpencodeModelId(model) ? model : null
    const effort = ctx.effort && ctx.effort !== 'inherit' ? ctx.effort : null
    if (effort && !sessionModel) throw combworkError(REFUSED.effortNeedsModel, { provider: NAME, effort })
    if (effort && sessionModel) {
      const listed = (await accountModels(ctx.executable, home, ctx.env).catch(() => null))?.find((m) => m.value === sessionModel)
      if (!listed?.efforts?.includes(effort)) throw combworkError(REFUSED.effortNotListed, { provider: NAME, effort, model: sessionModel })
    }
    const variant = effort
    // Each account keeps its own sessions: one made on another account's data isn't there to resume (design s7, s10).
    if (ctx.resume && !existsSync(sessionMark(home, ctx.sessionId))) throw combworkError(REFUSED.otherAccount, { provider: NAME, session: ctx.sessionId })
    // The session's history is this run's to read from now (design s13 §2): no older run's read publishes after this.
    await opencodeHistory.begin(home, ctx.sessionId, ctx.runId).catch((e) => {
      throw combworkError(REFUSED.historyBusy, { provider: NAME }, { cause: e })
    })
    const strip = launchOverrides(ctx.overrides, OPENCODE, 'stripCredentials')
    const noUpdate = launchOverrides(ctx.overrides, OPENCODE, 'noAutoUpdate')
    // The account's saved credentials decide which ambient chains it chose (null: none could be read, so none).
    const listed = strip ? await savedCredentials(ctx.executable, home, ctx.env).catch(() => null) : null
    const saved: SavedCredentials | null = listed?.saved ?? null
    const configDir = join(ctx.privateDir, 'opencode-config')
    const ambientDir = join(ctx.privateDir, 'opencode-ambient')
    const mode = ctx.permissionMode || OPENCODE_DESCRIPTOR.defaultPermissionMode
    const agentsMd = join(ctx.cwd, 'AGENTS.md')
    const keepOut = launchOverrides(ctx.overrides, OPENCODE, 'keepProjectConfigOut')
    const cfg = launchConfig({
      model: ctx.model,
      agent: opencodeAgentOf(mode),
      mcpServers: ctx.mcpServers,
      instructions: existsSync(agentsMd) ? [agentsMd] : [],
      ambient: ambientIntegrations(),
      saved,
      strip,
      noUpdate,
      ownProvider,
      projectDecidesMcp: projectDecidesMcp({ asFromTerminal: ctx.asFromTerminal === true, servers: Object.keys(ctx.mcpServers).length, keepOut })
    })
    await writeConfigDir(configDir, withTestProvider(cfg, testProvider(), true), launchGuidance(ctx))
    // Combwork's skills in the config folder's own skills folder, the one 2.2.6 reads with the switches on (R0b, HI-2761).
    const delivered = await copyOpencodeSkills(opencodeSkillsDir(configDir), ctx.skills)
    await mkdir(ambientDir, { recursive: true })
    for (const f of AMBIENT_FILES) await writeFile(join(ambientDir, f), '')
    for (const d of AMBIENT_DIRS) await mkdir(join(ambientDir, d), { recursive: true })
    await writeFile(launcherSourcePath(ctx.privateDir), LAUNCHER_SOURCE)
    this.prepared.set(ctx.runId, { home, marks: sessionMarks(home), configDir, ambientDir, password: randomBytes(24).toString('hex'), owner, chosen: strip ? chosenAmbient(saved) : new Set(), model: sessionModel, variant })
    return delivered
  }

  buildCommand(_executable: string, ctx: LaunchContext): CommandSpec {
    const p = this.prepared.get(ctx.runId)
    if (!p) throw new Error('an OpenCode launch was built before it was prepared') // i18n-ignore: an internal check, never shown
    this.prepared.delete(ctx.runId)
    // Its history is read from its server, with its password, kept only here (history.ts).
    opencodeHistory.track(ctx.runId, ctx.privateDir, p.password)
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
      // The launch's first task (a Combwork start, the Assistant's) as 2.2.6's TUI takes one: --prompt, submitted as it opens.
      // The launcher's argument list is joined with U+001F, so none stays in it.
      tuiArgs: [...opencodeModeFlags(mode), ...(ctx.initialPrompt ? ['--prompt', ctx.initialPrompt.replace(/\u001f/g, ' ')] : []), ...ctx.extraArgs.flatMap((a) => a.split(/\s+/)).filter(Boolean)],
      dirs: [ctx.cwd, ctx.projectPath],
      model: p.model,
      variant: p.variant,
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
  async prepareHook(body: Record<string, any>, launch: { memo: Record<string, unknown>; sessionId?: string | null }): Promise<void> {
    const expanded = expandOpencodeHook(launch.memo, body)
    if (expanded) body.combworkExpanded = expanded
    // The history (HI-2762): a turn's end or a resync reads the session now; OpenCode's running usage is its live cost.
    const sid = launch.sessionId
    if (!sid) return
    const type = typeof body.event?.type === 'string' ? body.event.type : ''
    if (body.hook_event_name === 'OpencodeSnapshot') opencodeHistory.nudge(sid, { kind: 'resync' })
    else if (body.hook_event_name === 'OpencodeEvent' && type.startsWith('session.execution.')) opencodeHistory.nudge(sid, { kind: 'turnEnd' })
    else if (body.hook_event_name === 'OpencodeEvent' && type === 'session.usage.updated' && typeof body.event.cost === 'number') opencodeHistory.nudge(sid, { kind: 'usage', cost: body.event.cost, at: typeof body.event.created === 'number' ? body.event.created : Date.now() })
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

  // ---- Transcripts and usage (HI-2762): each session Combwork made has a mirror of its history (history.ts, mirror.ts),
  // read from its run's server while it runs and exported after, in the account's data beside the session's mark.
  /**
   * The session's mirror, once Combwork made the session (the launcher's mark, in the account's data it was made on): its
   * path from the first answer on (a placeholder until a read completes), so the history and usage readers follow it as it
   * fills. None (null) without a mark: the session was never made, so a restart takes the id as new, never a resume.
   */
  async transcriptPath(_folder: string, sessionId: string): Promise<string | null> {
    if (!isSessionId(sessionId)) return null
    for (const home of this.allHomes()) if (existsSync(sessionMark(home, sessionId))) return opencodeHistory.mirrorFor(home, sessionId)
    return null
  }

  /** Every root sessions may have been made on: each OpenCode account's, a test copy's seam home, Combwork's own. */
  allHomes(): string[] {
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

  parseUsage(text: string, sessionId: string): SessionUsage {
    return parseMirrorUsage(text, sessionId)
  }

  usageParser(sessionId: string): UsageParser {
    const p = new OpencodeUsageParser(sessionId)
    return { feed: (t) => p.feed(t), result: () => p.result() }
  }

  conversationParser(projectPath: string): ConversationParserLike {
    return new OpencodeConversationParser(projectPath)
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
