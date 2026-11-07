import { createHash } from 'crypto'
import { dirname, join, resolve } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'original-fs'
import { cp, mkdir, stat, writeFile } from 'original-fs/promises'
import type { AgentInstallInfo, McpServerDef, MemorySource, PathDataCopy, PermissionMode, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { ANTIGRAVITY, ANTIGRAVITY_DESCRIPTOR, antigravityModeFlags } from '../../../shared/antigravity'
import { ASSISTANT_AGENT_ID } from '../../../shared/assistant'
import { TOOLS_SERVER } from '../../../shared/assistantTools'
import { isProviderEnabled } from '../../../shared/providers'
import { fmt, msg, tr } from '../../../shared/i18n'
import { release as osRelease } from 'os'
import { execFile } from 'child_process'
import { overrideId } from '../../../shared/advanced'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { config } from '../../config'
import { combworkError } from '../../combworkError'
import { writeJsonAtomic } from '../../fsutil'
import { compareVersions, exportSubtitleText, hookForwardCommand, installText, syncAgentsSkills, toSpawnable, AGENTS_SKILLS } from '../common'
import type { Ask, CatalogRead, CommandSpec, ConversationParserLike, ExternalSession, ImageLocation, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, UsageParser } from '../types'
import { antigravityEnv, brainDir, checkEnv, checkProfile, inProfile, inUserProfile, profilesRoot } from './home'
import { antigravityCheckEnv, antigravityInstallCommand, antigravityLoginCommand, antigravityReadiness, antigravityUpdateCommand, checkModels, locateAntigravity } from './install'
import { copyOnboarding, onboarded, onboardedNow } from './onboarding'
import { UnreadableConfig, workspaceServers, type WorkspaceServer } from './projectConfig'
import { agyStatusDetails } from './status'
import { AntigravityConversationParser, AntigravityUsageParser, parseAgyTranscript } from './transcript'
import { isConversationId, knownTitle, learnTitle, listConversations, mediaData, profileOf, subOf, trustedTranscript } from './conversations'
import { AGY_ALLOW, agyHooks, agyLockReply, agyNoticeGiven, agyNoticeReply, agyNoticeWanted, agyStartContextReply, agyStatusAsk, agyStatusIdle, agyStopContinues, normalizeAgyHook, prepareAgyHook } from './hooks'

// Google's Antigravity CLI (agy) as a Combwork provider (HI-2544, against 1.5.0; the runtime facts are HI-2543's).
// Each agent runs in a private agy profile of its own (USERPROFILE: agy reads its home from it alone), kept between launches
// because agy keeps its conversations there (brain\<id>), with HOME left the user's. Each launch rewrites the profile's
// MCP servers (Combwork's, with the launch's token). A workspace folder's own MCP servers the agent wasn't given refuse the
// launch (profileConfig: agy can't be kept from starting them). The user's own global agy customizations (~\.gemini) are
// never read (Darren, 7 Nov: hidden for now).
// Hooks are HI-2545's (hooks.ts). Transcripts and usage are HI-2546's (transcript.ts, conversations.ts).

const NAME = ANTIGRAVITY_DESCRIPTOR.name

const NOTICE = {
  title: msg({ id: 'providers.antigravity.notice.title', defaultMessage: 'Antigravity can’t use everything this agent was given', description: "A notice as an Antigravity CLI agent starts: something it was given can't apply (an MCP server's transport, a permission mode on this Windows)." }),
  sse: msg({ id: 'providers.antigravity.notice.sse', defaultMessage: '{count, plural, one {The MCP server {servers} uses} other {The MCP servers {servers} use}} the legacy HTTP+SSE transport, which Antigravity doesn’t support, so this agent runs without {count, plural, one {it} other {them}}. Change {count, plural, one {it} other {them}} to Streamable HTTP in MCP servers to use {count, plural, one {it} other {them}} here.', description: "Part of a notice as an Antigravity CLI agent starts: MCP servers it was given use a transport Antigravity can't use, so they're left out. {servers}: their names joined as a list; {count}: how many. HTTP+SSE and Streamable HTTP are transports' names, MCP servers a place in Combwork: keep them." }),
  setup: msg({ id: 'providers.antigravity.notice.setup', defaultMessage: 'Antigravity isn’t set up yet, so this agent shows its first-run screens (a colour scheme, its terms) in its pane: complete them there, or once for every agent with Set up in Provider Setup.', description: "Part of a notice as an Antigravity CLI agent starts before the user completed Antigravity's first-run screens in Provider Setup. Set up and Provider Setup are Combwork's names: keep them." }),
  auto: msg({ id: 'providers.antigravity.notice.auto', defaultMessage: 'Auto runs commands inside Antigravity’s own sandbox, which needs Windows 11 24H2 or later with the August 2026 update or later. This PC runs Windows build {version}, so Antigravity may refuse Auto or ask before commands. Choose another mode in Agent Settings, or update Windows.', description: "Part of a notice as an Antigravity CLI agent starts in Auto mode on a Windows that can't run its sandbox (older than 11 24H2 with the August 2026 update). {version}: the Windows build and revision, such as 26100.8000. Auto is a permission mode, Agent Settings a place in Combwork: keep them; Windows 11 24H2 is a version." }),
  autoUnknown: msg({ id: 'providers.antigravity.notice.autoUnknown', defaultMessage: 'Auto runs commands inside Antigravity’s own sandbox, which needs Windows 11 24H2 or later with the August 2026 update or later. Combwork couldn’t read this PC’s Windows version, so it can’t tell whether Auto applies here: if Antigravity refuses Auto or asks before commands, choose another mode in Agent Settings, or update Windows.', description: "Part of a notice as an Antigravity CLI agent starts in Auto mode where Combwork couldn't read the Windows version, so it can't tell whether Antigravity's sandbox applies. Auto is a permission mode, Agent Settings a place in Combwork: keep them; Windows 11 24H2 is a version." })
}

/** Provider Setup's first-run step (HI-2547, Darren's (a)). */
const SETUP = {
  needed: msg({ id: 'providers.antigravity.setup.needed', defaultMessage: 'Antigravity needs a one-time setup: its first-run screens. Until then each new agent shows them in its pane.', description: "Provider Setup and Settings → Providers: Antigravity CLI's first-run screens (a colour scheme, its terms of service) aren't done yet." }),
  action: msg({ id: 'providers.antigravity.setup.action', defaultMessage: 'Set up', description: "Provider Setup's button: opens Antigravity CLI's first-run screens in a terminal." }),
  runs: msg({ id: 'providers.antigravity.setup.runs', defaultMessage: '**Set up** runs `agy` in a terminal: choose a colour scheme and read and accept its terms there, its data-use choice yours. Combwork types nothing into it, and closes it once you are done.', description: "Provider Setup, under Antigravity CLI's Set up: what it does. **…** marks bold text and `…` a command: keep the marks and the command." }),
  copied: msg({ id: 'providers.antigravity.setup.copied', defaultMessage: 'Each Antigravity agent then starts past those screens: Combwork copies only that they are done into its private profile, never your own Antigravity settings.', description: "Provider Setup, under Antigravity CLI's Set up: what Combwork does with it." })
}

const REFUSED = {
  unreadable: msg({ id: 'providers.antigravity.unreadableConfig', defaultMessage: "{provider} didn't start: Combwork couldn't read {file} ({why}), which it would load. Fix or remove the file, then start the agent again.", description: "Why an Antigravity CLI agent didn't start (its pane): a config file in the project (an MCP server or hook list) couldn't be read, so Combwork couldn't keep what it holds out of the agent. {provider} is the CLI's name, {file} a path, {why} the error's own words." }),
  gone: msg({ id: 'providers.antigravity.conversationGone', defaultMessage: "{provider} didn't resume {conversation}: {provider} no longer has that conversation (it keeps it apart from its transcript, in the agent's profile, and it was removed). Start a new session instead.", description: "Why an Antigravity CLI agent didn't resume a conversation (its pane): the conversation's own store in the agent's profile is gone, though its transcript may be left. {provider} is the CLI's name, {conversation} the conversation's id." }),
  notOwn: msg({ id: 'providers.antigravity.notOwnConversation', defaultMessage: "{provider} didn't resume {conversation}: it isn't in this agent's own conversations (it may have been removed, or be another agent's). Start a new session instead.", description: "Why an Antigravity CLI agent didn't resume a conversation (its pane): the conversation isn't among this agent's own. {provider} is the CLI's name, {conversation} the conversation's id." }),
  projectServers: msg({ id: 'providers.antigravity.projectServers', defaultMessage: "{provider} didn't start: {count, plural, one {{files} defines} other {{files} define}} MCP servers this agent wasn't given ({servers}), and {provider} would start them in its session. Combwork can't keep them out, so it doesn't start {provider} here. Remove them from that file, or give them to the agent in Combwork's MCP servers.", description: "Why an Antigravity CLI agent didn't start (its pane): a project or added folder's .agents config defines MCP servers the agent wasn't given, which Antigravity can't be kept from starting. {provider} is the CLI's name, {files} the config files' paths joined as a list, {count} how many files, {servers} the servers' names joined as a list. MCP servers is a place in Combwork." }),
  tooLong: msg({ id: 'providers.antigravity.guidanceTooLong', defaultMessage: "{provider} didn't start: Combwork's guidance, this agent's instructions and the Workspace notes come to {size, number} bytes, and {provider} reads at most {max, number} bytes of its rules file, cutting off the rest. Shorten the agent's instructions (Agent Settings) or the Workspace notes, then start the agent again.", description: "Why an Antigravity CLI agent didn't start (its pane): what Combwork gives it as its rules file is over Antigravity's size limit, which would cut it off. {provider} is the CLI's name, {size} and {max} sizes in bytes. Agent Settings and Workspace notes are places in Combwork: keep them." })
}

/** An agent's private profile: kept per agent; the Assistant's (the same id in every workspace) per workspace too. */
export function profileFolder(agentId: string, workspacePath: string): string {
  const key = agentId === ASSISTANT_AGENT_ID ? `${ASSISTANT_AGENT_ID}-${createHash('sha256').update(resolve(workspacePath).toLowerCase()).digest('hex').slice(0, 16)}` : agentId
  return join(profilesRoot(), key)
}

/** A conversation id agy made: a UUID, safe as a folder name (never a path). */
export { isConversationId }

/** An MCP server as agy's mcp_config.json has it (1.5.0: stdio command/args/env, or Streamable HTTP url/headers). */
export function agyServer(def: McpServerDef): Record<string, unknown> | null {
  // The legacy HTTP+SSE transport: agy 1.5.0's url servers are Streamable HTTP only (its mcp_servers.md), so none.
  if (isLegacySse(def)) return null
  if (typeof def.url === 'string' && def.url) return { url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
  if (typeof def.command === 'string' && def.command) return { command: def.command, ...(def.args?.length ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) }
  return null
}

/** A server on the legacy HTTP+SSE transport (its type `sse`), which agy can't use. */
export const isLegacySse = (def: McpServerDef): boolean => typeof def.type === 'string' && def.type.toLowerCase() === 'sse'

/** The agent's servers agy can't use (legacy HTTP+SSE): left out of its profile, and the user told why (launchNotice). */
export const legacySseServers = (given: Record<string, McpServerDef>): string[] => Object.entries(given).filter(([, d]) => isLegacySse(d)).map(([n]) => n)

/** The rules file agy auto-loads from its home (HI-2547: `/context` lists ~\.gemini\GEMINI.md as a system file). */
export const GUIDANCE_FILE = join('.gemini', 'GEMINI.md')

/** What a launch puts in its profile's GEMINI.md: Combwork's guidance (with its tools), the launch's instructions, the notes. */
export function launchGuidance(ctx: Pick<LaunchContext, 'guidance' | 'instructions' | 'notes' | 'mcpServers'>): string {
  const parts = [Object.hasOwn(ctx.mcpServers, TOOLS_SERVER) ? ctx.guidance : '', ctx.instructions ?? '', ctx.notes ?? ''].map((t) => t.trim()).filter(Boolean)
  return parts.length ? parts.join('\n\n') + '\n' : ''
}

/**
 * The most a rules file of agy's may hold: Google's rules docs (Size limits and token budgets) say a rule file over 24,000
 * UTF-8 bytes is truncated, so a launch whose GEMINI.md would be larger is refused rather than silently cut (HR1, HI-2547).
 */
export const RULES_MAX_BYTES = 24000

/** The UTF-8 size of a launch's GEMINI.md (launchGuidance), as agy's limit counts it. */
export const guidanceBytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/**
 * What Antigravity's sandbox needs for Auto (Google's sandbox docs, the CLI tab): "Windows 11 24H2 or later with the August
 * 2026 update or later". 24H2 (26100) and 25H2 (26200) share their updates; August 2026's (KB5121003, 11 Aug) is revision
 * 9168 of both. A later feature update (above 26200) comes after it.
 */
export const AUTO_MIN_BUILD = 26100
export const AUTO_SHARED_SERVICING = 26200
export const AUTO_MIN_REVISION = 9168

/** This PC's Windows version: its build and update revision (UBR), each null when it can't be read. */
export interface WindowsVersion {
  build: number | null
  revision: number | null
}

/** Whether Auto's sandbox can apply on this Windows: `ok`, `old` (it can't), or `unknown` (Combwork couldn't tell). */
export function autoSandbox(v: WindowsVersion): 'ok' | 'old' | 'unknown' {
  if (v.build === null) return 'unknown'
  if (v.build < AUTO_MIN_BUILD) return 'old'
  if (v.build > AUTO_SHARED_SERVICING) return 'ok'
  if (v.revision === null) return 'unknown'
  return v.revision < AUTO_MIN_REVISION ? 'old' : 'ok'
}

/** A whole number from reg.exe's output for a value (REG_SZ decimal, or REG_DWORD hex), else null. */
export function regNumber(out: string | null): number | null {
  const v = out ? /REG_\w+\s+(\S+)\s*$/m.exec(out)?.[1] : undefined
  if (!v) return null
  const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? Number(v) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

const CURRENT_VERSION = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' // i18n-ignore: a registry key

function regQuery(name: string): Promise<string | null> {
  return new Promise((done) => {
    execFile('reg', ['query', CURRENT_VERSION, '/v', name], { timeout: 5000, windowsHide: true }, (e, out) => done(e ? null : String(out)))
  })
}

const autoMode = (ctx: Pick<LaunchContext, 'permissionMode'>): boolean => (ctx.permissionMode || ANTIGRAVITY_DESCRIPTOR.defaultPermissionMode) === 'auto'

let windowsVersionRead: Promise<WindowsVersion> | null = null

/** This PC's Windows version, read once (asynchronously, off main's thread) from the registry; os.release's build if not. */
export function windowsVersion(): Promise<WindowsVersion> {
  if (process.platform !== 'win32') return Promise.resolve({ build: null, revision: null })
  windowsVersionRead ??= Promise.all([regQuery('CurrentBuildNumber'), regQuery('UBR')]).then(([b, r]) => {
    const fromRelease = Number(osRelease().split('.')[2])
    const build = regNumber(b) ?? (Number.isSafeInteger(fromRelease) && fromRelease > 0 ? fromRelease : null)
    return { build, revision: regNumber(r) }
  })
  return windowsVersionRead
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
export function launchSettings(ctx: Pick<LaunchContext, 'hookUrl' | 'hookAuthFile' | 'mcpServers' | 'trustedCombworkTools'> & Partial<Pick<LaunchContext, 'cwd' | 'extraDirs'>>, preApprove: boolean): Record<string, unknown> {
  const allow = !Object.hasOwn(ctx.mcpServers, TOOLS_SERVER) || !preApprove ? [] : ctx.trustedCombworkTools ? ctx.trustedCombworkTools.map((t) => `mcp(${TOOLS_SERVER}/${t})`) : [`mcp(${TOOLS_SERVER}/*)`]
  // The folders it works in (its own, and those it was given: a slot, a review copy), trusted for this launch only, so
  // agy doesn't stop at its trust question in each (HI-2547; settings.json's trustedWorkspaces, never saved).
  const trusted = [ctx.cwd, ...(ctx.extraDirs ?? [])].filter((d): d is string => !!d)
  return {
    statusLine: { type: 'command', command: hookForwardCommand(`${ctx.hookUrl}&statusline`, ctx.hookAuthFile), stack_with_default: true },
    ...(allow.length ? { permissions: { allow } } : {}),
    ...(trusted.length ? { trustedWorkspaces: trusted } : {})
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

  /** Whether agy's first-run screens are done in the check profile (Provider Setup's Set up), as the last check found. */
  private setUp: boolean | null = null
  /** This PC's Windows version, read for a launch in Auto (launchNotice). */
  private windows: WindowsVersion | null = null

  async locate(): Promise<AgentInstallInfo> {
    const info = await locateAntigravity(this.signInPattern())
    this.setUp = info.found ? await onboarded(checkProfile()) : null
    return info
  }

  /** Its install and sign-in, then (HI-2547) its first-run screens, which the user completes once in Set up. */
  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    const issues = antigravityReadiness(info)
    if (!info.found || info.loggedIn === false || this.setUp !== false) return issues
    return [
      ...issues,
      {
        id: 'onboarding',
        level: 'warning',
        message: installText(SETUP.needed),
        action: { label: installText(SETUP.action), task: 'setup' },
        detail: [installText(SETUP.runs), installText(SETUP.copied)]
      }
    ]
  }

  /**
   * agy's first-run screens, completed by the user in a terminal they watch (Combwork types nothing into it): agy in the
   * check profile, in a folder of its own there, trusted for this run. Combwork closes it once they are done, and copies
   * that into each agent's profile as it starts (copyOnboarding).
   */
  setupCommand(executable: string): CommandSpec {
    const dir = join(checkProfile(), 'setup')
    mkdirSync(dir, { recursive: true })
    const settings = join(dir, 'agy-settings.json')
    writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [dir] }))
    const s = toSpawnable(executable, ['--settings', settings])
    return { ...s, env: antigravityCheckEnv(), cwd: dir, keys: [], done: () => onboardedNow(checkProfile()) }
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
    // In the check profile (HI-2698): never the user's own, nor an agent's.
    const r = await checkModels(executable, checkEnv(env), this.signInPattern())
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
    // Its transcript alone (the brain folder) isn't the conversation: agy resumes from its store, conversations\<id>.db.
    if (ctx.resume && !(await this.hasConversationStore(ctx.agentId, ctx.workspacePath, ctx.sessionId))) throw combworkError(REFUSED.gone, { provider: NAME, conversation: ctx.sessionId })
    // The whole rules file within agy's limit, or no launch: agy would cut it off silently (HR1, HI-2547).
    const guidance = launchGuidance(ctx)
    const size = guidanceBytes(guidance)
    if (size > RULES_MAX_BYTES) throw combworkError(REFUSED.tooLong, { provider: NAME, size, max: RULES_MAX_BYTES })
    if (autoMode(ctx)) this.windows = await windowsVersion()
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
    // agy's first-run screens, done once by the user in Set up: this profile starts past them (HI-2547).
    await copyOnboarding(checkProfile(), profile)
    // Combwork's guidance, the launch's instructions and the Workspace notes, in the profile's own ~\.gemini\GEMINI.md: the
    // one rules file agy 1.5.0 auto-loads (HI-2547's listing check), private to this agent, never in the user's projects.
    await writeFile(join(profile, GUIDANCE_FILE), guidance)
    // The servers' env (and the launch's token) stays in the profile, under Combwork's own data: never the project.
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'mcp_config.json'), made.mcp)
    // Combwork's hooks, for this launch (its URL and token file): agy reads the profile's hooks.json, never the project's.
    await writeJsonAtomic(join(profile, '.gemini', 'config', 'hooks.json'), agyHooks(ctx.hookUrl, ctx.hookAuthFile, advanced.get<boolean>('antigravity.hooks.toolHooks')))
    await writeJsonAtomic(join(ctx.privateDir, 'agy-settings.json'), launchSettings(ctx, launchOverrides(ctx.overrides, ANTIGRAVITY, 'preApproveCombworkTools')))
    return delivered
  }

  /**
   * What the user is told as an agent starts (HI-2547), said plainly rather than switched silently: the MCP servers left
   * out (legacy HTTP+SSE), and Auto on a Windows whose build can't run Antigravity's sandbox.
   */
  launchNotice(ctx: LaunchContext): { title: string; message: string } | null {
    const parts: string[] = []
    const sse = legacySseServers(ctx.mcpServers)
    if (sse.length) parts.push(tr(NOTICE.sse, { servers: fmt.list(sse), count: sse.length }))
    if (autoMode(ctx)) {
      const v = this.windows ?? { build: null, revision: null }
      const can = autoSandbox(v)
      if (can === 'old') parts.push(tr(NOTICE.auto, { version: v.revision === null ? String(v.build) : `${v.build}.${v.revision}` }))
      if (can === 'unknown') parts.push(tr(NOTICE.autoUnknown))
    }
    if (this.setUp === false) parts.push(tr(NOTICE.setup))
    return parts.length ? { title: tr(NOTICE.title), message: parts.join(' ') } : null
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const s = toSpawnable(executable, antigravityArgs(ctx, join(ctx.privateDir, 'agy-settings.json')))
    const env = inProfile(antigravityEnv(ctx.env, launchOverrides(ctx.overrides, ANTIGRAVITY, 'noAutoUpdate'), launchOverrides(ctx.overrides, ANTIGRAVITY, 'stripAccountVars')), profileFolder(ctx.agentId, ctx.workspacePath))
    // An agent runs in its own profile, never the user's (HI-2698): a bug if it would, so refused.
    if (inUserProfile(env)) throw new Error("an Antigravity agent would run in the user's own profile: refused") // i18n-ignore: an internal check, never shown
    return { ...s, env }
  }

  /** Its status line (Combwork's own command): the model, its effort and the context window (agyStatusDetails). */
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

  /** Whether its status line says agy is idle with no prompt pending (a cancelled prompt sends no hook: idleGrace). */
  statusLineIdle(body: Record<string, any>): boolean {
    return agyStatusIdle(body)
  }

  /** How long an idle status line waits for a hook to end the turn before the turn is taken as interrupted. */
  idleGraceMs(): number {
    return advanced.number('antigravity.statusLine.idleGraceSeconds') * 1000
  }

  // ---- Hooks (HI-2545, hooks.ts).
  /** What each hook is, decided once in the launch's order from its raw fields and this agent's own transcript (s56). */
  prepareHook(body: Record<string, any>, launch: { agentId: string; workspacePath: string; sessionId: string | null; memo: Record<string, unknown>; alive: () => boolean }): Promise<void> {
    return prepareAgyHook(body, { profile: profileFolder(launch.agentId, launch.workspacePath), root: profilesRoot(), sessionId: launch.sessionId, memo: launch.memo, alive: launch.alive })
  }

  /** The events whose reply can carry a notice (recorded: PreInvocation's ephemeral message, Stop's continue). */
  readonly noticeEvents = ['PreInvocation', 'Stop'] as const // i18n-ignore: a CLI's hook event names

  /** Whether a PreInvocation may carry a checkpoint (prepared as one, not given one at its position yet). */
  noticeWanted(body: Record<string, any>, memo: Record<string, unknown>): boolean {
    return body.hook_event_name !== 'PreInvocation' || agyNoticeWanted(body, memo)
  }

  noticeGiven(body: Record<string, any>, memo: Record<string, unknown>): void {
    agyNoticeGiven(body, memo)
  }

  /** How long agy waits for a hook's reply: a notice decided after it never counts as given (it never reached agy). */
  noticeDeadlineMs(event: string): number | null {
    return event === 'PreInvocation' || event === 'Stop' ? advanced.number('antigravity.hooks.timeoutSeconds') * 1000 : null
  }

  /** A tool Combwork doesn't refuse runs under agy's own permission check: `allow` (no answer denies it in 1.5.0). */
  preToolUseDefault(): Record<string, unknown> {
    return { ...AGY_ALLOW }
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

  // ---- Transcripts (HI-2546, conversations.ts and transcript.ts).
  /**
   * Its transcript: in the profile of the agent it belongs to. `recorded` (the path its hooks gave) only when it is that
   * conversation's transcript in one of Combwork's profiles (profileTranscript): agy's word never points Combwork elsewhere.
   */
  async transcriptPath(_folder: string, sessionId: string, recorded?: string): Promise<string | null> {
    if (!isConversationId(sessionId)) return null
    const root = profilesRoot()
    const found = await profileOf(root, sessionId)
    if (!found) return null
    // Its title, for a usage asked for without waiting (usageTitle).
    await learnTitle(root, found.profile, sessionId)
    const reported = recorded ? await trustedTranscript(recorded, root, sessionId) : null
    return reported ?? found.transcript
  }

  /**
   * None: agy resumes a conversation from its own store (conversations\<id>.db in the profile), not its transcript, so a
   * transcript put back from Combwork's backup wouldn't bring a deleted conversation back. Such a session starts afresh.
   */
  restorePath(): string | null {
    return null
  }

  /** The conversations in the profiles of the agents that ran in `folder` (listConversations). */
  listSessions(folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]> {
    return listConversations(profilesRoot(), folder, skip)
  }

  /** A subagent's conversation, from its first step (subOf); a transcript of Combwork's profiles only. */
  subSessionOf(path: string, _sessionId: string, mtimeMs?: number): Promise<SubSession | null> {
    return subOf(path, mtimeMs)
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

  /** Whether agy's own store of the conversation (conversations\<id>.db in the agent's profile), which a resume reads, is there. */
  async hasConversationStore(agentId: string, workspacePath: string, sessionId: string): Promise<boolean> {
    if (!isConversationId(sessionId)) return false
    try {
      return (await stat(join(dirname(brainDir(profileFolder(agentId, workspacePath))), 'conversations', `${sessionId}.db`))).isFile()
    } catch {
      return false
    }
  }

  // ---- Usage (HI-2546): from the transcript (transcript.ts).
  /** The conversation's title agy made (its annotations), from the profile that has it. */
  usageTitle(sessionId: string): string | null {
    const known = knownTitle(sessionId)
    // Never read here, on the caller's thread: one not read yet is looked up meanwhile, for the next ask.
    if (known === undefined && isConversationId(sessionId)) {
      const root = profilesRoot()
      void profileOf(root, sessionId)
        .then((f) => (f ? learnTitle(root, f.profile, sessionId) : null))
        .catch(() => null)
    }
    return known ?? null
  }

  parseUsage(text: string, sessionId: string): SessionUsage {
    return parseAgyTranscript(text, sessionId, this.usageTitle(sessionId))
  }

  usageParser(sessionId: string): UsageParser {
    const p = new AntigravityUsageParser(sessionId)
    return { feed: (text) => p.feed(text), result: () => p.result(this.usageTitle(sessionId)) }
  }

  conversationParser(projectPath: string): ConversationParserLike {
    return new AntigravityConversationParser(projectPath)
  }

  /** An image a tool read (its result step's `media`, a file in the conversation's logs\media): mediaData. */
  imageData(line: Record<string, any>, loc: ImageLocation, transcriptPath: string): Promise<string | null> {
    let v: any = line
    for (const k of loc.path) v = v?.[k]
    return mediaData(v, transcriptPath, profilesRoot())
  }

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
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
