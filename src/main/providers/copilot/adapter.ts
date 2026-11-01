import { homedir } from 'os'
import { msg, tr } from '../../../shared/i18n'
import { basename, join, resolve } from 'path'
import { mkdir, writeFile } from 'original-fs/promises'
import { existsSync, readFileSync, statSync } from 'original-fs'
import type { AgentInstallInfo, McpServerDef, MemorySource, ReadinessIssue, SessionUsage, SubSession } from '../../../shared/types'
import { assertSessionId } from '../../../shared/defaults'
import type { StartHint } from '../../../shared/startFailure'
import { COPILOT, COPILOT_DESCRIPTOR, COPILOT_FOOTER_MODES, copilotCanApproveEdits, copilotCanSwitchLive, copilotFooterMode, copilotModeFlags } from '../../../shared/copilot'
import { isProviderEnabled } from '../../../shared/providers'
import { config } from '../../config'
import { writeJsonAtomic } from '../../fsutil'
import { createLogger, userText } from '../../logger'
import { AGENTS_SKILLS, agentsSkillCopyPath, compareVersions, exportSubtitleText, hookIds, promptArg, runsThroughCmd, syncAgentsSkills, toSpawnable, userMemoryLabel } from '../common'
import { rowsOfHooksTable } from '../../hookListing'
import type { CatalogRead, CommandSpec, ConversationParserLike, ExternalSession, LaunchContext, LaunchHooks, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, TranscriptTurn, UsageParser } from '../types'
import { copilotEnv, copilotHome, noAutoUpdateArgs } from './home'
import { launchOverrides } from '../../advancedValues'
import { overrideId } from '../../../shared/advanced'
import { copilotTranscriptTurns } from './turns'
import { CopilotConversationParser, CopilotUsageParser, copilotDetailsMemo, copilotEventsPath, copilotImageData, eventsDetails, listCopilotSessions, parseEvents, workspaceInfo, type CopilotDetailsMemo } from './events'
import { readCopilotModels } from './models'
import { copilotInstallCommand, copilotLatestVersion, copilotLoginCommand, copilotReadiness, copilotUpdateCommand, copilotUpdateRetry, locateCopilot } from './install'
import { advanced } from '../../advanced'

const log = createLogger('copilot')

/**
 * The hooks Hive gives Copilot, by their PascalCase names: with those, Copilot sends Claude Code-style payloads
 * (hook_event_name, session_id, tool_name, tool_input), which Hive's hook server reads as they are. Each is an HTTP hook
 * to Hive's hook server (Copilot allows plain http to localhost with COPILOT_HOOK_ALLOW_LOCALHOST=1), so no shell or
 * curl is involved. Not PermissionRequest: Copilot sends it also when it approves a call itself (Allow all), so it says
 * nothing about a person being asked; Notification (permission_prompt, elicitation_dialog) does. Checked with 1.0.93.
 */
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'ErrorOccurred', 'PreCompact', 'SessionEnd'] as const // i18n-ignore: Copilot's hook event names

/**
 * The line Copilot's sessions get about the hive tools' names (#1346 item 7): Copilot names an MCP server's tools
 * "<server>-<tool>", so a model told hive_inbox searched for it 18 times. Only Copilot's custom instructions carry it.
 */
export const HIVE_TOOL_NAMES = 'This CLI names the hive tools "hive-<tool>": where Hive says hive_inbox, call hive-hive_inbox.' // i18n-ignore: agent-facing guidance

/** Copilot's file tools, as its hooks name them (Edit: path, old_str, new_str; Write: path, file_text; 1.0.93). */
const EDIT_TOOL = /^(edit|write|create|str_replace\w*|multi_?edit)$/i

/** The hooks.json of the launch's plugin: Hive's hook server for every event, with the launch's token. */
export function copilotHooks(hookUrl: string, token: string): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {}
  for (const ev of HOOK_EVENTS) {
    // PreToolUse answers with a file-lock decision, so it gets longer; if Hive doesn't answer in time, the call goes ahead.
    // Both are advanced settings (#367).
    hooks[ev] = [{ type: 'http', url: hookUrl, headers: { Authorization: `Bearer ${token}` }, timeoutSec: advanced.number(ev === 'PreToolUse' ? 'copilot.hooks.preToolUseTimeoutSeconds' : 'copilot.hooks.timeoutSeconds') }] // i18n-ignore: an HTTP header Copilot sends
  }
  return { version: 1, hooks }
}

/**
 * Why a Copilot model call it tries again failed, from its message (HI-1973, `copilot.retry.message`'s named groups): the
 * HTTP status (a valid one only, 100–599), or 429 for a rate limit's words (Copilot 1.0.105's hook gives the service's
 * own error body, with no status: "Rate limit reached for requests"), and whether its service couldn't be reached.
 * None: a failure Hive can't name.
 */
export function copilotRetryOf(message: string): { status: number | null; network: boolean } {
  const m = advanced.pattern('copilot.retry.message').exec(message)
  const status = Number(m?.groups?.status)
  return { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : m?.groups?.limited ? 429 : null, network: !!m?.groups?.network }
}

/** A workspace MCP server (Claude Code's JSON format, as Hive keeps them) in Copilot's mcp-config format. */
export function copilotMcpServer(def: McpServerDef): Record<string, unknown> | null {
  if (typeof def.url === 'string' && def.url) {
    return { type: def.type === 'sse' ? 'sse' : 'http', url: def.url, ...(def.headers ? { headers: def.headers } : {}), tools: ['*'] }
  }
  if (typeof def.command !== 'string' || !def.command) return null
  return { type: 'local', command: def.command, args: (def.args ?? []).map(String), ...(def.env ? { env: def.env } : {}), ...(typeof def.cwd === 'string' ? { cwd: def.cwd } : {}), tools: ['*'] }
}

/** JSON with comments (Copilot's settings.json): `//` and block comments outside strings removed; {} when unreadable. */
function readJsonc(path: string): Record<string, any> {
  try {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '')
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '"') {
        const end = /"(?:[^"\\]|\\.)*"/y
        end.lastIndex = i
        const m = end.exec(text)
        if (m) {
          out += m[0]
          i += m[0].length - 1
          continue
        }
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        out += '\n'
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2)
        i = close < 0 ? text.length : close + 1
        continue
      }
      out += c
    }
    const v = JSON.parse(out)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** MCP servers in one of Copilot's config files ({ mcpServers } or VS Code's { servers }), as Hive's definitions. */
function mcpServersIn(file: string): Record<string, McpServerDef> {
  const j = readJsonc(file)
  const servers = j.mcpServers ?? j.servers
  if (!servers || typeof servers !== 'object') return {}
  const out: Record<string, McpServerDef> = {}
  for (const [name, s] of Object.entries(servers as Record<string, any>)) if (s && typeof s === 'object') out[name] = s as McpServerDef
  return out
}

export class CopilotAdapter implements ProviderAdapter {
  readonly id = COPILOT
  readonly descriptor = COPILOT_DESCRIPTOR
  /**
   * The question an ask_user call asks, per Copilot session, from its PreToolUse until the call ends (HI-1945): from
   * 1.0.104 its elicitation_dialog Notification says only "Information requested", so the question comes from here.
   */
  private readonly questions = new Map<string, string>()
  /**
   * A parent Copilot session's identity, when Hive runs inside one: none known. The sign-in tokens Copilot would use are
   * taken out of Copilot's own environment instead (home.ts COPILOT_ENV_STRIP): this list applies to every child.
   */
  readonly envToStrip: string[] = []
  /** Copilot is checked in its sessions' environment (copilotEnv), which these switches change. */
  readonly locateSettings = [overrideId(COPILOT, 'stripGitHubTokens'), overrideId(COPILOT, 'noAutoUpdate')]
  readonly compactFailure = null
  // SessionStart only comes with the first prompt: its footer ("… · / commands · …") means it is up. Both patterns are
  // advanced settings (#367).
  get readyOutput(): RegExp {
    return advanced.pattern('copilot.ready.footer')
  }
  // In a folder it doesn't trust yet: "Confirm folder trust … Do you trust the files in this folder?".
  get startupQuestion(): RegExp {
    return advanced.pattern('copilot.trust.prompt')
  }
  // Copilot writes a session's token totals (session.shutdown) only as it exits by itself (#465). Ctrl+C cancels what
  // runs (a turn, a dialog), and twice in a row exits ("ctrl+c again to exit"); three cover a turn or dialog first, at a
  // lane's end (quit), where its turn is over. Stop types them on conditions instead (HI-2272, exitKeys.ts): a key that
  // arrived as a cancelled turn wound down was lost under load, and with it the exit. It took 1.7-2.4 s from the first
  // key to exit under load (#716), so the kill waits 10 s by default: only for one that hangs. The grace and the hint
  // are advanced settings (#727), read at each stop.
  get exitKeys(): { keys: string[]; gapMs: number; graceMs: number; armed: RegExp } {
    return { keys: ['\x03', '\x03', '\x03'], gapMs: 400, graceMs: advanced.number('copilot.exit.graceSeconds') * 1000, armed: advanced.pattern('copilot.exit.armed') }
  }

  // Installation, readiness and the install, update and sign-in tasks (#452).
  locate(): Promise<AgentInstallInfo> {
    return locateCopilot()
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    return copilotReadiness(info)
  }

  latestVersion(): Promise<string | null> {
    return copilotLatestVersion()
  }

  installCommand(): CommandSpec {
    return copilotInstallCommand()
  }

  updateCommand(executable: string): CommandSpec {
    return copilotUpdateCommand(executable)
  }

  updateRetry(executable: string, exitCode: number): ReturnType<typeof copilotUpdateRetry> {
    return copilotUpdateRetry(executable, exitCode)
  }

  /** Copilot's own sign-in, run in a terminal for the user to complete (never typed into by Hive). */
  loginCommand(executable: string): CommandSpec {
    return copilotLoginCommand(executable)
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  configHome(): string {
    return copilotHome()
  }

  /**
   * The account's models, from an ACP session of the installed CLI (models.ts): no prompt, no cost. Only while Copilot
   * is turned on in Settings: the ACP session it opens leaves a folder in Copilot's session store for a moment.
   */
  listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    return isProviderEnabled(config.settings, this.id) ? readCopilotModels(executable, env) : Promise.resolve(null)
  }

  /** The model in Copilot's own settings.json (or COPILOT_MODEL), which it runs unless Hive passes one. */
  configuredDefaultModel(): string | null {
    const m = process.env.COPILOT_MODEL || readJsonc(join(copilotHome(), 'settings.json')).model
    return typeof m === 'string' && m.trim() ? m.trim() : null
  }

  /** Copilot runs several vendors' models, under its own ids (dots in versions: claude-sonnet-5.5). */
  ownsModel(model: string): boolean {
    return /^(auto|claude-|gpt-|gemini-|grok-|kimi-|mai-|o\d)/i.test(model)
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  /** Copilot reads Hive's copies in the project's .agents/skills, shared with Codex (syncAgentsSkills). */
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return agentsSkillCopyPath(ctx.cwd, skill)
  }

  /** The launch's plugin (its hooks), in the launch's private folder: the hook token is in it (#345). */
  private pluginDir(ctx: LaunchContext): string {
    return join(ctx.privateDir, 'plugin')
  }

  /** Where Copilot finds this launch's instructions (COPILOT_CUSTOM_INSTRUCTIONS_DIRS reads .github/instructions there). */
  private instructionsDir(ctx: LaunchContext): string {
    return join(ctx.privateDir, 'instructions')
  }

  /**
   * This launch's custom instructions: the Hive Assistant's role and mode, and Hive's guidance when Copilot won't show
   * the hive server's instructions (their switch off, #1167: without --allow-all-mcp-server-instructions it leaves them
   * out, whatever the server is called), then the Workspace notes note (#1433).
   */
  private customInstructions(ctx: LaunchContext): string {
    const names = ctx.mcpServers.hive ? HIVE_TOOL_NAMES : ''
    return [launchOverrides(ctx.overrides, COPILOT, 'allMcpInstructions') ? '' : ctx.mcpServers.hive ? ctx.guidance : '', names, ctx.instructions ?? '', ctx.notes ?? ''].map((t) => t.trim()).filter(Boolean).join('\n\n')
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    const delivered = await syncAgentsSkills(ctx, this.descriptor.name)
    const plugin = this.pluginDir(ctx)
    await mkdir(plugin, { recursive: true })
    await writeJsonAtomic(join(plugin, 'plugin.json'), { name: 'hive-launch', version: '1.0.0', description: "Hive's hooks for this session. Regenerated by Hive on every launch — do not edit." }) // i18n-ignore: a plugin manifest Copilot reads
    await writeJsonAtomic(join(plugin, 'hooks.json'), copilotHooks(ctx.hookUrl, ctx.env.HIVE_HOOK_TOKEN ?? ''))
    const servers: Record<string, unknown> = {}
    for (const [name, def] of Object.entries(ctx.mcpServers)) {
      const s = copilotMcpServer(def)
      if (s) servers[name] = s
      else log.warn(`MCP server ${userText(name)} has neither a command nor a URL; Copilot agents don't get it`)
    }
    // The servers' own env and headers may hold secrets: the launch's private folder, never the project (#345).
    await writeJsonAtomic(join(ctx.privateDir, 'mcp.json'), { mcpServers: servers })
    // The Hive Assistant's role and mode. Hive's guidance itself comes with the hive MCP server's instructions, which
    // Copilot shows with --allow-all-mcp-server-instructions; with that switched off, here too (customInstructions).
    const custom = this.customInstructions(ctx)
    if (custom) {
      const dir = join(this.instructionsDir(ctx), '.github', 'instructions')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'hive.instructions.md'), `---\napplyTo: '**'\n---\n${custom}\n`)
    }
    return delivered
  }

  /** MCP servers Copilot would load besides Hive's: the user's own, the project's, and its built-in GitHub ones. */
  private otherMcpServers(cwd: string): string[] {
    const names = new Set<string>()
    for (const f of [join(copilotHome(), 'mcp-config.json'), join(cwd, '.mcp.json'), join(cwd, '.github', 'mcp.json')]) for (const n of Object.keys(mcpServersIn(f))) names.add(n)
    return [...names]
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const args: string[] = []
    if (ctx.resume) args.push('--resume', assertSessionId(ctx.sessionId))
    else {
      args.push('--session-id', assertSessionId(ctx.sessionId))
      // Through cmd.exe (a launcher Hive can't start directly), its special characters can't be passed safely.
      if (ctx.name) args.push('--name', runsThroughCmd(executable) ? ctx.name.replace(/["%^&|<>!]/g, ' ').replace(/\s+/g, ' ').trim() : ctx.name)
    }
    args.push('--plugin-dir', this.pluginDir(ctx))
    args.push('--additional-mcp-config', `@${join(ctx.privateDir, 'mcp.json')}`)
    // Hive's guidance is the hive MCP server's instructions: Copilot includes only allowlisted servers' without this.
    if (launchOverrides(ctx.overrides, COPILOT, 'allMcpInstructions')) args.push('--allow-all-mcp-server-instructions')
    // Only the workspace's MCP servers, as for the other CLIs: Copilot's built-in GitHub servers and the user's and the
    // project's own are turned off for Hive's sessions (never by editing their config). Switched off (#1281), they load
    // too: the --additional-mcp-config servers win over Copilot's own of the same name (1.0.100), hive included, and are
    // never disabled by name (--disable-mcp-server <name> would turn Hive's off with the user's).
    if (launchOverrides(ctx.overrides, COPILOT, 'mcpIsolation')) {
      args.push('--disable-builtin-mcps')
      for (const name of this.otherMcpServers(ctx.cwd)) if (!ctx.mcpServers[name]) args.push('--disable-mcp-server', name)
    }
    // Hive's own tools run without asking in every mode, as for the other CLIs: the Agent API decides what an agent may
    // do with them. The Assistant only the ones its Control settings let it use without asking (trustedHiveTools).
    // Copilot's patterns: <server> for all its tools, <server>(<tool>) for one (#468).
    // Switched off (#1281), none: Copilot asks per its own mode.
    if (ctx.mcpServers.hive && launchOverrides(ctx.overrides, COPILOT, 'preApproveHiveTools')) {
      if (ctx.trustedHiveTools) for (const t of ctx.trustedHiveTools) args.push(`--allow-tool=hive(${t})`)
      else args.push('--allow-tool=hive')
    }
    if (ctx.model) args.push('--model', ctx.model)
    if (ctx.effort) args.push('--reasoning-effort', ctx.effort)
    const mode = ctx.permissionMode || COPILOT_DESCRIPTOR.defaultPermissionMode
    args.push(...copilotModeFlags(mode, ctx.cwd))
    // Folders it may also work in (#1439: a reviewer's review copies), its edits there approved as in its own folder.
    for (const d of ctx.extraDirs ?? []) {
      args.push('--add-dir', d)
      if (mode === 'accept-edits') args.push(...copilotModeFlags(mode, d))
    }
    args.push(...noAutoUpdateArgs(launchOverrides(ctx.overrides, COPILOT, 'noAutoUpdate')))
    // Never --mouse or --no-mouse (#737): Copilot saves either into the user's own settings (~/.copilot/settings.json),
    // changing their Copilot outside Hive. It keeps its own mouse handling: Shift+drag makes the terminal's selection.
    args.push(...ctx.extraArgs)
    // A first task: Copilot starts interactive and runs it (after the folder-trust question, if it asks one).
    if (ctx.initialPrompt) args.push('-i', promptArg(executable, ctx.initialPrompt))
    const s = toSpawnable(executable, args)
    const env = copilotEnv(ctx.env, launchOverrides(ctx.overrides, COPILOT, 'noAutoUpdate'), launchOverrides(ctx.overrides, COPILOT, 'stripGitHubTokens'))
    // Hive's hook server is plain http on 127.0.0.1, which Copilot allows for hooks only with this.
    env.COPILOT_HOOK_ALLOW_LOCALHOST = '1'
    if (this.customInstructions(ctx)) {
      const own = this.instructionsDir(ctx)
      const theirs = Object.entries(env).find(([k]) => k.toUpperCase() === 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS')
      if (theirs) delete env[theirs[0]]
      env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = theirs?.[1] ? `${theirs[1]},${own}` : own
    }
    return { file: s.file, args: s.args, env }
  }

  /** Accept edits in a folder whose path has parentheses approves no edits (copilotCanApproveEdits): the user is told. */
  launchNotice(ctx: LaunchContext): { title: string; message: string } | null {
    if ((ctx.permissionMode || COPILOT_DESCRIPTOR.defaultPermissionMode) !== 'accept-edits' || copilotCanApproveEdits(ctx.cwd)) return null
    return {
      title: tr(msg({ id: 'providers.copilot.parens.title', defaultMessage: 'Copilot will ask before each edit', description: 'A notice as a GitHub Copilot agent starts in Accept edits, in a folder whose path has parentheses.' })),
      message: tr(msg({ id: 'providers.copilot.parens.message', defaultMessage: "Copilot can't approve edits in a folder whose path has parentheses, so this agent asks before each edit, as in Ask. Rename the folder to give it Accept edits.", description: 'The notice that a GitHub Copilot agent asks before each edit. Ask and Accept edits are permission modes as Hive names them: use their names as shown.' }))
    }
  }

  startHint(text: string): StartHint | null {
    if (/Failed to read MCP config file/i.test(text)) return { hint: tr(msg({ id: 'providers.copilot.hint.mcp', defaultMessage: "Copilot couldn't read the MCP configuration Hive gave it: start it again.", description: "Why GitHub Copilot didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'terminal' }
    if (/\bmodel\b/i.test(text) && /not found|invalid|unknown|not available|not supported|does not exist/i.test(text)) return { hint: tr(msg({ id: 'providers.copilot.hint.model', defaultMessage: "Copilot doesn't offer this model to this account (Copilot Free runs Auto only): choose another in Agent Settings.", description: "Why GitHub Copilot didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    if (/unexpected argument|unrecognized|invalid value|for more information, try '--help'|error: the argument/i.test(text)) return { hint: tr(msg({ id: 'providers.copilot.hint.args', defaultMessage: 'Copilot refused an argument: check Extra arguments in Agent Settings and Settings → GitHub Copilot.', description: "Why GitHub Copilot didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    if (/\/login|copilot login|not (logged|signed) in|unauthorized|bad credentials|401/i.test(text)) return { hint: tr(msg({ id: 'providers.copilot.hint.signIn', defaultMessage: "Copilot isn't signed in: sign in as Provider Setup shows, then start it again.", description: "Why GitHub Copilot didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-setup' }
    if (/is not recognized|ENOENT|cannot find/i.test(text)) return { hint: tr(msg({ id: 'providers.copilot.hint.broken', defaultMessage: 'Copilot looks broken or missing: check it in Provider Setup.', description: "Why GitHub Copilot didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-setup' }
    return null
  }

  // -------------------------------------------------------------------------
  // Hooks and live details
  // -------------------------------------------------------------------------

  normalizeHook(body: Record<string, any>): NormalizedHook {
    const event = String(body.hook_event_name ?? '')
    const out: NormalizedHook = {
      event: { kind: 'ignore' },
      sessionId: typeof body.session_id === 'string' ? body.session_id : typeof body.sessionId === 'string' ? body.sessionId : null,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : null,
      // The footer says the mode (footerMode); the hooks don't.
      mode: null,
      editedPaths: [],
      // Its hooks seen so far name no turn (1.0.95): the turn ledger then goes by the order they come in (#648).
      ids: hookIds(body, { turn: 'turn_id', call: 'tool_use_id' })
    }
    const tool = String(body.tool_name ?? '')
    const input = body.tool_input && typeof body.tool_input === 'object' ? body.tool_input : {}
    const session = out.sessionId ?? ''
    switch (event) {
      case 'SessionStart':
        out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
        break
      case 'UserPromptSubmit':
        out.event = { kind: 'prompt', text: typeof body.prompt === 'string' ? body.prompt : null }
        break
      case 'PreToolUse': {
        out.event = { kind: 'toolStart' }
        const file: unknown = input.path ?? input.file_path
        if (EDIT_TOOL.test(tool) && typeof file === 'string' && file) out.editedPaths = [file]
        // ask_user, which its hooks name AskUserQuestion (1.0.105): its question in tool_input.message. Both advanced settings.
        const question: unknown = input[advanced.get<string>('copilot.question.field')]
        if (advanced.pattern('copilot.question.tool').test(tool) && typeof question === 'string' && question) {
          // At most a few sessions ask at once: one never answered (a CLI killed mid-question) mustn't grow it for ever.
          if (this.questions.size >= 50) this.questions.delete(this.questions.keys().next().value!)
          this.questions.set(session, question)
        }
        break
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (advanced.pattern('copilot.question.tool').test(tool)) this.questions.delete(session)
        out.event = { kind: 'toolEnd' }
        break
      case 'Notification': {
        // A person is asked: a permission dialog, or ask_user's question. Others (agent_idle, shell_completed…) say nothing new.
        const kind = String(body.notification_type ?? '')
        const message = typeof body.message === 'string' ? body.message : ''
        if (kind === 'permission_prompt') out.event = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: message || 'Copilot asks for permission' } } // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
        else if (kind === 'elicitation_dialog') out.event = { kind: 'ask', ask: { kind: 'question', blocking: true, message: this.questions.get(session) || message || 'Copilot asks a question' } } // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
        break
      }
      case 'Stop':
        this.questions.delete(session)
        out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
        break
      case 'ErrorOccurred': {
        // A model call refused for the sign-in ends the turn as signed out; another error that ends it, as a failed turn.
        const err = body.error && typeof body.error === 'object' ? body.error : {}
        const message = typeof err.message === 'string' ? err.message : typeof body.error === 'string' ? body.error : null
        const recoverable = body.recoverable ?? body.is_recoverable
        if (message && advanced.pattern('copilot.signIn.hookMessage').test(message)) out.event = { kind: 'signIn', message }
        else if (recoverable === false) out.event = { kind: 'stop', lastMessage: message, failed: true }
        // A model call it tries again (HI-1973): the turn goes on, waiting to retry; why, from its message.
        else if (recoverable === true && advanced.pattern('copilot.retry.context').test(String(body.error_context ?? ''))) out.event = { kind: 'retry', ...copilotRetryOf(message ?? '') }
        break
      }
      case 'PreCompact':
        out.event = { kind: 'compactStart', trigger: String(body.trigger ?? 'auto') }
        break
      case 'SessionEnd':
        this.questions.delete(session)
        out.event = { kind: 'end' }
        break
    }
    return out
  }

  /**
   * The launch's hooks (HI-982): Hive's, as its launch plugin passes them (copilotHooks). Copilot may load others too
   * (the folder's, its own plugins'), which Hive doesn't read: said so, never listed as none.
   */
  launchHooks(ctx: LaunchContext): LaunchHooks {
    const token = ctx.env.HIVE_HOOK_TOKEN ?? ''
    const hive = rowsOfHooksTable(copilotHooks(ctx.hookUrl, token).hooks, { source: 'plugin', status: 'passed', observed: true }, [token])
    const rows = hive.rows.map((r) => ({ ...r, source: 'hive' as const }))
    return { listing: { basis: 'launch', rows, notes: [{ kind: 'othersUnread' }] }, receivers: Object.fromEntries(rows.map((r) => [r.event, r.type])) }
  }

  /** Claude Code's reply format, which Copilot honours for PascalCase PreToolUse (deny, and ask: its own dialog). */
  lockReply(d: LockDecision): Record<string, unknown> {
    if (d.kind === 'warn') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context } }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.kind, permissionDecisionReason: d.reason } }
  }

  /**
   * Notices (1.0.95, offline against a stand-in model, #650): after a tool call as top-level additionalContext, which
   * Copilot adds to the tool's result ("Additional guidance from postToolUse hooks"; its hookSpecificOutput form doesn't
   * reach the model); at Stop as a block, whose reason it takes as a new prompt (drainIsPrompt).
   */
  noticeReply(event: string, text: string): Record<string, unknown> | null {
    if (!text) return null
    if (event === 'PostToolUse') return { additionalContext: text }
    if (event === 'Stop') return { decision: 'block', reason: text }
    return null
  }

  /**
   * Start context (1.0.98 offline, #1065's probe: tests/fixtures/copilot/sessionstart-1.0.98.json): top-level
   * additionalContext reaches the model from SessionStart (source new or resume) and from a prompt hook (as a
   * system_reminder in the prompt); the hookSpecificOutput form doesn't. No SessionStart follows a compaction, only
   * PreCompact, so the view goes with the next prompt then.
   */
  startContextReply(text: string): Record<string, unknown> {
    return { additionalContext: text }
  }

  readonly startContextAfterCompaction = 'prompt' as const

  /** A Stop's continuation comes back as a new prompt hook, with the reason as its prompt (1.0.95, #650). */
  readonly drainIsPrompt = true

  /** A Stop blocked carries the turn on (Copilot's hooks reference; not tried yet, #645). */
  stopContinues(reply: Record<string, any>): boolean {
    return reply.decision === 'block'
  }

  footerMode(screen: string, launched?: string | null): string | null {
    return copilotFooterMode(screen, launched, COPILOT_FOOTER_MODES.map((d) => [d.mode, advanced.pattern(`copilot.footer.${d.key}`)] as const))
  }

  canSwitchLive(target: string, current: string | undefined, launched: string | null | undefined): boolean {
    return copilotCanSwitchLive(target, current, launched)
  }

  /** Model, cost (AI credits) and interrupts from what Copilot appended to the session's events (events.ts). */
  transcriptDetails(appended: string, memo: Record<string, unknown>): LiveDetails {
    return eventsDetails(appended, (memo.copilot ??= copilotDetailsMemo()) as CopilotDetailsMemo)
  }

  /** Turns by interaction (its hooks carry no turn id: joined by time), #1371. */
  transcriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
    return copilotTranscriptTurns(appended, memo)
  }

  readonly turnsJoin = 'time'

  // -------------------------------------------------------------------------
  // Transcripts: COPILOT_HOME/session-state/<id>/events.jsonl, with workspace.yaml beside it
  // -------------------------------------------------------------------------

  private sessionDir(sessionId: string): string {
    return join(copilotHome(), 'session-state', assertSessionId(sessionId))
  }

  async transcriptPath(_folder: string, sessionId: string, recorded?: string): Promise<string | null> {
    if (recorded && existsSync(recorded)) return recorded
    const p = copilotEventsPath(copilotHome(), assertSessionId(sessionId))
    return existsSync(p) ? p : null
  }

  /** Copilot finds a session by its id, in its own folder. */
  restorePath(_folder: string, sessionId: string): string | null {
    return copilotEventsPath(copilotHome(), assertSessionId(sessionId))
  }

  /** The sessions Copilot keeps for this folder (their workspace.yaml's cwd), with a conversation in them (events.ts). */
  listSessions(folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]> {
    return listCopilotSessions(copilotHome(), folder, skip)
  }

  async subSessionOf(): Promise<SubSession | null> {
    return null
  }

  /** The session's name from its workspace.yaml (the user's /rename, or Copilot's own). */
  usageTitle(sessionId: string): string | null {
    return this.title(sessionId)
  }

  private title(sessionId: string): string | null {
    try {
      const yaml = join(this.sessionDir(sessionId), 'workspace.yaml')
      if (!statSync(yaml).isFile()) return null
      return workspaceInfo(readFileSync(yaml, 'utf8'))?.name ?? null
    } catch {
      return null
    }
  }

  parseUsage(text: string, sessionId: string): SessionUsage {
    return parseEvents(text, sessionId, this.title(sessionId))
  }

  usageParser(sessionId: string): UsageParser {
    const p = new CopilotUsageParser(sessionId)
    return { feed: (text) => p.feed(text), result: () => p.result(this.title(sessionId)) }
  }

  conversationParser(projectPath: string): ConversationParserLike {
    return new CopilotConversationParser(projectPath)
  }

  imageData = copilotImageData

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
  }

  // -------------------------------------------------------------------------
  // Project files
  // -------------------------------------------------------------------------

  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const p = this.id
    const sources: MemorySource[] = [
      { provider: p, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'project-github', label: '.github/copilot-instructions.md', path: join(projectPath, '.github', 'copilot-instructions.md'), kind: 'claude-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'user', label: userMemoryLabel('copilot-instructions.md'), path: join(copilotHome(), 'copilot-instructions.md'), kind: 'claude-md', exists: false }
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    return sources
  }

  /** In Copilot's folder, only the user's copilot-instructions.md (editable) and skills (read-only). Never its sign-in or config. */
  fileAllowed(path: string, write: boolean): boolean {
    const home = resolve(copilotHome()).toLowerCase()
    const abs = resolve(path).toLowerCase()
    if (!abs.startsWith(home + '\\') && !abs.startsWith(home + '/')) return false
    const rel = abs.slice(home.length + 1).replace(/\\/g, '/')
    if (rel === 'copilot-instructions.md') return true
    return !write && rel.startsWith('skills/') && basename(rel) === 'skill.md'
  }

  /**
   * Copilot reads skills from its own folder and ~/.agents/skills, and in a project from .github/skills, .agents/skills
   * (where Hive's copies are, shared with Codex) and .claude/skills: first found by name wins.
   */
  skillRoots(): SkillRoots {
    return { machine: [join(copilotHome(), 'skills'), join(homedir(), '.agents', 'skills')], plugins: join(copilotHome(), 'installed-plugins'), local: [join('.github', 'skills'), AGENTS_SKILLS, join('.claude', 'skills')], hiveCopyPrefix: 'hive-' }
  }

  /** Servers in the project's .github/mcp.json, which Hive leaves off until copied to the workspace. */
  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    return mcpServersIn(join(projectPath, '.github', 'mcp.json'))
  }
}

export const copilot = new CopilotAdapter()
