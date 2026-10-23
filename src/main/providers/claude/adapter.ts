import { homedir } from 'os'
import { msg, tr } from '../../../shared/i18n'
import { join, basename } from 'path'
import { mkdir, open, readdir, stat, writeFile } from 'original-fs/promises'
import { existsSync, readFileSync, realpathSync } from 'original-fs'
import type { AgentInstallInfo, AutoCompactSetting, McpServerDef, MemorySource, PathDataCopy, PlanLimit, PlanUsage, ReadinessIssue, SubSession } from '../../../shared/types'
import { HIVE_DIR, assertSessionId, isSessionId } from '../../../shared/defaults'
import { isCliOwnMode } from '../../../shared/cliOwnMode'
import { CLAUDE_CODE, CLAUDE_DESCRIPTOR, CLAUDE_FOOTER_MODES, baseModel, canSwitchLive, footerMode, hookMode } from '../../../shared/claude'
import { providerSettings } from '../../../shared/providers'
import { samePath } from '../../../shared/movePaths'
import { config } from '../../config'
import { claudeFileAllowed, contentHash, ContentTooLarge, copyMissing, copySkillTree, sourceProblem, tooBigToDeliver, isDir, linksNotCopied, placeMatcher, readJson, realPath, removePath, writeJsonAtomic, type PlannedCopies } from '../../fsutil'
import { createLogger, userText } from '../../logger'
import { EDITOR_EXTENSION_PATH, EDITOR_ROOTS, compareVersions, hookForwardCommand, exportSubtitleText, hookIds, notInstalledIssue, readFirstLine, run, runsThroughCmd, signedOutIssue, taskArgs, toSpawnable, updateIssue, userMemoryLabel } from '../common'
import type { StartHint } from '../../../shared/startFailure'
import type { Ask, BackgroundTaskEvent, CatalogRead, CommandSpec, ExternalSession, LaunchContext, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, TranscriptTurn } from '../types'
import { autoCompactOf, settingsScopes } from './autoCompact'
import { hiveStatusLine, mergeLaunchSettings, ownStatusLine, userSettings, withoutSettingsArgs } from './launchSettings'
import { claudeBackgroundTasks } from './background'
import { claudeSafeguards } from './safeguards'
import { claudeTranscriptTurns } from './turns'
import type { SafeguardEvent } from '../../../shared/safeguards'
import { ConversationParser, claudeImageData } from './conversation'
import { readClaudeModels } from './models'
import { ClaudeUsageParser, encodeProjectPath, parseTranscript, transcriptSubSession } from './usage'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'

const log = createLogger('claude-code')
/** Transcripts whose sub-agent check is remembered (by path and mtime). */
const SUB_CACHE = 2000
/**
 * How many of the screen's last written lines a safeguard prompt is looked for in: its dialog is drawn last, at the
 * bottom, its choices within about a dozen lines of the end (more when a narrow pane wraps their descriptions).
 */
const SAFEGUARD_PROMPT_LINES = 24
/** A ~/.claude/projects folder name that may hold an 8.3 short name: `~1` is encoded `-1`. */
const MAY_BE_SHORT = /-\d+(-|$)/
/** How much of a transcript is read for the cwd it records (its first lines carry none). */
const CWD_HEAD = 64 * 1024

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'SessionEnd'] as const // i18n-ignore: Claude Code's hook event names

/** Tools that edit files: PreToolUse checks them against other agents' file locks. */
export const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit' // i18n-ignore: Claude Code's tool names, matched
const EDIT_TOOL = new RegExp(`^(?:${EDIT_TOOLS})$`)

/**
 * Since 2.1.267 Claude Code records a conversation's system prompt on its first request and sends that record on every
 * resume, whatever a later launch appends, until it compacts; `--system-prompt-snapshot off` renders it fresh (#334).
 */
const PROMPT_SNAPSHOT_SINCE = '2.1.267'

/** The version whose screens claudeTurnScreen was checked against (#648, screens recorded in #645's spike and in Hive). */
const TURN_SCREEN_SINCE = '2.1.296'

/**
 * What Claude Code's screen shows of its turn (2.1.296), from the status line above its input line ("❯", or ">" as it
 * draws it in Hive's terminals): 'idle' when it says the last turn is done ("✻ Worked for 12s · done 16:52", the
 * spinner's past tense) and nothing below offers to interrupt; 'working' while its spinner runs ("✢ Embellishing…", or
 * "esc to interrupt"); else null (a dialog, a recap, no input line: not sure). Earlier turns' lines above are history.
 */
export function claudeTurnScreen(screen: string): 'idle' | 'working' | null {
  const lines = screen.split('\n').map((l) => l.trim())
  const input = lines.findLastIndex((l) => l.startsWith('❯') || l.startsWith('>'))
  if (input < 0) return null
  const status = lines.slice(0, input).findLastIndex((l) => /^[✻✶✳✢✽·*]\s+\S/.test(l))
  if (status < 0) return null
  if (lines.slice(status).some((l) => /esc to interrupt/i.test(l))) return 'working'
  // Its past tense (an advanced setting, #685).
  if (advanced.pattern('claude-code.turnScreen.done').test(lines[status])) return 'idle'
  return /^\S+\s+\S+…/.test(lines[status]) ? 'working' : null
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * How Claude Code spells a folder it was started in, for its transcripts' folder name (#493): Node's realpath (the JS
 * one, not `.native`), which follows junctions and symlinks but keeps 8.3 short names (checked with 2.1.296). A folder
 * that can't be resolved is spelt as given.
 */
export function claudeSpelling(folder: string): string {
  try {
    return realpathSync(folder)
  } catch {
    return folder
  }
}

/** The cwd a Claude Code transcript records (in the first of its lines that has one), or null. */
async function headCwd(path: string): Promise<string | null> {
  try {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(CWD_HEAD)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead))
      return m ? (JSON.parse(m[1]) as string) : null
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

/**
 * Subscription limits from Claude Code's status line (rate_limits.five_hour / seven_day); null for API-key accounts. The
 * field names are advanced settings (#367).
 */
export function parseClaudePlanUsage(payload: Record<string, unknown>, now = new Date()): PlanUsage | null {
  const rl = payload[advanced.get<string>('claude-code.statusLine.rateLimits')] as Record<string, unknown> | undefined
  if (!rl || typeof rl !== 'object') return null
  const limits: PlanLimit[] = []
  const add = (raw: unknown, id: string, label: string, windowMinutes: number): void => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    const pct = Number(r[advanced.get<string>('claude-code.statusLine.usedPercent')])
    if (!Number.isFinite(pct)) return
    limits.push({ id, label, windowMinutes, usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: toIso(r.resets_at) })
  }
  add(rl[advanced.get<string>('claude-code.statusLine.fiveHour')], 'five_hour', '5-hour', 300)
  add(rl[advanced.get<string>('claude-code.statusLine.weekly')], 'seven_day', 'weekly', 10080)
  return limits.length ? { provider: CLAUDE_CODE, plan: null, limits, updatedAt: now.toISOString() } : null
}

/** resets_at arrives as epoch seconds (or ms, or an ISO string); normalise to ISO. */
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return null
}

/** What a launch appends to Claude Code's system prompt: the Assistant's role and mode, then the Workspace notes note (#1433). */
export function appendedInstructions(ctx: LaunchContext): string {
  return [ctx.instructions ?? '', ctx.notes ?? ''].map((t) => t.trim()).filter(Boolean).join('\n\n')
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = CLAUDE_CODE
  readonly descriptor = CLAUDE_DESCRIPTOR
  /** If Hive itself was started from inside a Claude Code session, don't leak that session's identity. User configuration such as CLAUDE_CODE_GIT_BASH_PATH is kept. */
  readonly envToStrip = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'MCP_CONNECTION_NONBLOCKING']
  readonly compactFailure = /not enough messages to compact|error during compaction|compaction failed/i
  // Before a folder's first session: "Is this a project you created or one you trust? … trust this folder" (#367: an
  // advanced setting, so a changed question can be fixed without a release).
  get startupQuestion(): RegExp {
    return advanced.pattern('claude-code.trust.prompt')
  }

  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = providerSettings(config.settings, this.id).executablePath.trim()
    if (custom) out.push({ path: custom, source: 'settings' })

    const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], 5000)
    for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      // Prefer real executables over extension-less shims that node-pty cannot start on Windows.
      if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
    }
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
    out.push({ path: join(homedir(), '.local', 'bin', exe), source: 'native install' }) // i18n-ignore: an install's source as Hive names it, in diagnostics and the Agent API's status
    if (process.platform === 'win32' && process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'claude.cmd'), source: 'npm' })
    return out
  }

  /** True if an editor extension (VS Code, Cursor…) ships its own Claude Code — used only to explain why it isn't used. */
  private async editorExtensionPresent(): Promise<boolean> {
    for (const root of EDITOR_ROOTS) {
      try {
        if ((await readdir(join(homedir(), root, 'extensions'))).some((d) => d.startsWith('anthropic.claude-code-'))) return true
      } catch {
        // Editor not installed.
      }
    }
    return false
  }

  async locate(): Promise<AgentInstallInfo> {
    const info: AgentInstallInfo = {
      provider: this.id,
      found: false,
      path: null,
      version: null,
      source: null,
      latestVersion: null,
      updateAvailable: false,
      loggedIn: null,
      authMethod: null,
      rejected: []
    }
    for (const c of await this.candidates()) {
      if (!existsSync(c.path)) continue
      // Hive requires the standalone CLI. Editor extensions bundle their own copy that moves on every
      // extension update and can't be updated with `claude update`, so it is never used — even if set manually.
      if (EDITOR_EXTENSION_PATH.test(c.path)) {
        info.rejected!.push(c.path)
        continue
      }
      const r = await run(c.path, ['--version'])
      const m = r.stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)
      if (!m) {
        log.warn(`Candidate ${userText(c.path)} did not report a version: ${userText(r.stderr.slice(0, 200))}`)
        continue
      }
      info.found = true
      info.path = c.path
      info.version = m[1]
      info.source = c.source
      break
    }
    if (!info.found) info.editorExtensionOnly = await this.editorExtensionPresent()
    if (info.path) {
      const auth = await run(info.path, ['auth', 'status', '--json'], 10000)
      try {
        const j = JSON.parse(auth.stdout)
        info.loggedIn = !!j.loggedIn
        info.authMethod = j.authMethod ?? null
      } catch {
        info.loggedIn = null
      }
    }
    return info
  }

  configHome(): string {
    return claudeHome()
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    const name = this.descriptor.name
    if (!info.found) return [notInstalledIssue(name)]
    const out: ReadinessIssue[] = []
    if (info.loggedIn === false) out.push(signedOutIssue(name))
    if (info.updateAvailable) out.push(updateIssue(name, info.latestVersion))
    return out
  }

  async latestVersion(): Promise<string | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 6000)
      const res = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return null
      return ((await res.json()) as { version?: string }).version ?? null
    } catch {
      return null
    }
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  installCommand(): CommandSpec {
    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] // i18n-ignore: a command run in a terminal
      }
    }
    return { file: '/bin/bash', args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'] } // i18n-ignore: a command run in a terminal
  }

  updateCommand(executable: string): CommandSpec {
    return { file: executable, args: ['update'] }
  }

  loginCommand(executable: string): CommandSpec {
    return { file: executable, args: ['auth', 'login'] }
  }

  /** Claude Code's own default: "model" in ~/.claude/settings.json. */
  configuredDefaultModel(): string | null {
    try {
      const m = JSON.parse(readFileSync(join(claudeHome(), 'settings.json'), 'utf8')).model
      if (typeof m === 'string' && m.trim()) return m.trim()
    } catch {
      // no settings file, or no model in it
    }
    return null
  }

  ownsModel(model: string): boolean {
    return /^claude-/i.test(model)
  }

  /** Claude Code's models from its initialize reply (models.ts), in the sessions' environment. */
  listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    return readClaudeModels(executable, env)
  }

  /**
   * Generated skills, MCP config and hooks for a launch. Each agent has its own folder, because a launch
   * replaces the folder while the project's other agents may still be reading theirs.
   */
  launchDir(projectPath: string, agentId: string): string {
    return join(projectPath, HIVE_DIR, `launch-${agentId}`)
  }

  /** Rebuilds the agent's launch folder with exactly the session's Hive skills, MCP servers and Hive's hooks. */
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return join(this.launchDir(ctx.projectPath, ctx.agentId), 'plugin', 'skills', skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    // A --settings of the user's is read first: one Hive can't read stops the launch before anything changes (#330).
    const theirs = await userSettings(ctx.extraArgs, ctx.cwd)
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    await removePath(dir)
    const pluginDir = join(dir, 'plugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeJsonAtomic(join(pluginDir, '.claude-plugin', 'plugin.json'), {
      name: 'hive',
      version: '1.0.0',
      description: "The workspace's Hive skills for this session. Regenerated by Hive on every launch — do not edit." // i18n-ignore: a plugin manifest Claude Code reads
    })
    const hashes: Record<string, string> = {}
    // Each agent's own copies: what it gets is what was copied here (its revision read back from the copy).
    const delivered: Record<string, SkillDelivery> = {}
    for (const skill of ctx.skills) {
      const dest = join(pluginDir, 'skills', skill.name)
      // A skill over the hashing limits isn't copied (the launch folder starts empty, so the session has no copy of it).
      // Checked on the source first, which reads no more than the limits, and on the copy, which may have grown since.
      // One skill's failure is its own: the launch folder started empty, so a skill not copied is one the session
      // doesn't have (revision null, and why).
      const fail = async (e: unknown): Promise<void> => {
        await removePath(dest).catch(() => undefined)
        delivered[skill.name] = e instanceof ContentTooLarge ? { revision: null, problem: tooBigToDeliver(e), lasting: true } : { revision: null, problem: sourceProblem(e, skill.sourcePath) }
      }
      try {
        hashes[`skill:${skill.name}`] = await contentHash(skill.sourcePath)
      } catch (e) {
        await fail(e)
        continue
      }
      // Links stay links, to the same place, so the copy is the same content as the workspace's skill. A link it can't
      // make (Windows needs a privilege for a link to a file) is left out, with every other file of the skill copied.
      // The copy keeps the limits as it reads the source (which may have changed since it was hashed), and what the
      // session gets is the copy's own revision.
      let skipped: string[]
      let revision: string
      try {
        skipped = await copySkillTree(skill.sourcePath, dest)
        revision = await contentHash(dest)
      } catch (e) {
        await fail(e)
        continue
      }
      delivered[skill.name] = skipped.length ? { revision, problem: linksNotCopied(skipped), lasting: true } : { revision }
    }
    // The MCP config and settings may hold secrets (servers' own env and headers, a user's --settings): they go in the
    // launch's private folder, outside the project (#345).
    await writeJsonAtomic(join(ctx.privateDir, 'mcp.json'), { mcpServers: ctx.mcpServers })

    // Their timeouts are advanced settings (#367).
    const timeout = advanced.number('claude-code.hooks.timeoutSeconds')
    const hook = {
      type: 'http',
      url: ctx.hookUrl,
      timeout,
      headers: { Authorization: 'Bearer $HIVE_HOOK_TOKEN' }, // i18n-ignore: an HTTP header Claude Code sends
      allowedEnvVars: ['HIVE_HOOK_TOKEN']
    }
    const hooks: Record<string, unknown[]> = {}
    for (const ev of HOOK_EVENTS) {
      // SessionStart only supports command hooks (not http), so it forwards its JSON with curl.
      if (ev === 'SessionStart') {
        hooks[ev] = [{ hooks: [{ type: 'command', command: hookForwardCommand(ctx.hookUrl, ctx.hookAuthFile, timeout), timeout }] }]
        continue
      }
      // Every tool's start and end, so the turn ledger sees each call begin (#648: a tool after a turn's Stop carries it on,
      // a tool end with no start since is late news). PreToolUse answers an edit with a lock decision, so it gets a longer
      // timeout; if Hive doesn't answer, the edit goes ahead. Any other tool is answered at once.
      if (ev === 'PreToolUse') hooks[ev] = [{ matcher: '*', hooks: [{ ...hook, timeout: advanced.number('claude-code.hooks.preToolUseTimeoutSeconds') }] }]
      else hooks[ev] = [ev === 'PostToolUse' ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }]
    }
    // The status line forwards Claude Code's status JSON (model, effort, cost, plan limits) to Hive and
    // prints nothing, so no line is added to the terminal. Switched off (#1285), the user's own runs after it, given the
    // same JSON, and shows its output: Hive still reads the status.
    const own = launchOverrides(ctx.overrides, CLAUDE_CODE, 'statusLine') ? null : ownStatusLine(settingsScopes(ctx.cwd, ctx.env.CLAUDE_CONFIG_DIR || claudeHome(), ctx.extraArgs))
    const statusLine = hiveStatusLine((echo) => hookForwardCommand(`${ctx.hookUrl}&statusline${echo ? '&echo' : ''}`, ctx.hookAuthFile, timeout), own)
    // The user's --settings merged in: Hive passes only this file (#330).
    await writeJsonAtomic(join(ctx.privateDir, 'settings.json'), mergeLaunchSettings({ hooks, statusLine }, theirs, { url: ctx.hookUrl, envVar: 'HIVE_HOOK_TOKEN' }))
    await writeJsonAtomic(join(dir, 'sync.json'), { launchedAt: new Date().toISOString(), hashes })
    // Instructions for this launch (the Hive Assistant's, and the Workspace notes note, #1433) are appended to Claude Code's
    // system prompt from a file.
    const appended = appendedInstructions(ctx)
    if (appended) await writeFile(join(dir, 'instructions.md'), appended)
    await writeFile(
      join(dir, 'README.txt'),
      'This folder is generated by Hive each time a session starts. Edits here are overwritten.\n'
    )
    return delivered
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const dir = this.launchDir(ctx.projectPath, ctx.agentId)
    const args: string[] = []
    if (ctx.resume) args.push('--resume', ctx.sessionId)
    else args.push('--session-id', ctx.sessionId)
    if (ctx.name) args.push('--name', runsThroughCmd(executable) ? ctx.name.replace(/["%^&|<>!]/g, ' ').replace(/\s+/g, ' ').trim() : ctx.name)
    args.push('--plugin-dir', join(dir, 'plugin'))
    // Folders it may also work in (#1439: a reviewer's review copies), within its permission mode. --add-dir takes several
    // (2.1.309), so an option always follows it here, never the first prompt.
    for (const d of ctx.extraDirs ?? []) args.push('--add-dir', d)
    // Only the workspace's servers; switched off (#1281), Claude Code's own load too, and the --mcp-config ones still win
    // over its own of the same name, hive included (2.1.305: the user's and the project's are never started).
    args.push('--mcp-config', join(ctx.privateDir, 'mcp.json'))
    if (launchOverrides(ctx.overrides, CLAUDE_CODE, 'mcpIsolation')) args.push('--strict-mcp-config')
    args.push('--settings', join(ctx.privateDir, 'settings.json'))
    const appended = !!appendedInstructions(ctx)
    if (appended) args.push('--append-system-prompt-file', join(dir, 'instructions.md'))
    // A resumed conversation gets this launch's instructions (the Assistant's current mode, the notes as they are now), not
    // the ones it started with: a newer Claude Code would keep sending those. So does one Hive appended to at an earlier
    // launch, by any agent, and appends nothing to now (the notes switched off or emptied, #1433: SessionRecord.promptAdded):
    // it gets none. Not where the user's own arguments choose, nor with the switch off (#1167).
    const refresh = appended || ctx.promptAddedBefore === true
    if (refresh && ctx.resume && launchOverrides(ctx.overrides, CLAUDE_CODE, 'promptSnapshotOff') && ctx.cliVersion && compareVersions(ctx.cliVersion, PROMPT_SNAPSHOT_SINCE) >= 0 && !ctx.extraArgs.some((a) => /^--system-prompt-snapshot(=|$)/.test(a))) args.push('--system-prompt-snapshot', 'off')
    if (ctx.trustedHiveTools?.length && ctx.mcpServers.hive && launchOverrides(ctx.overrides, CLAUDE_CODE, 'preApproveHiveTools')) args.push('--allowedTools', ctx.trustedHiveTools.map((t) => `mcp__hive__${t}`).join(','))
    // With 1M turned off, Claude Code rejects a "[1m]" model as unrecognised (2.1.287): run the base model.
    if (ctx.model) args.push('--model', ctx.use200kContext ? baseModel(ctx.model) : ctx.model)
    if (ctx.effort) args.push('--effort', ctx.effort)
    // The CLI's own setting (#1284): no flag, so Claude Code's own settings (defaultMode) decide.
    if (ctx.permissionMode && !isCliOwnMode(ctx.permissionMode)) args.push('--permission-mode', ctx.permissionMode)
    args.push(...withoutSettingsArgs(ctx.extraArgs))
    // Claude Code takes a first message as its last argument and starts on it.
    if (ctx.initialPrompt) args.push(...taskArgs(executable, ctx.initialPrompt))
    const s = toSpawnable(executable, args)
    // Agent view (← on an empty prompt) moves the session into Claude Code's background service, out of Hive's
    // reach: Stop would only close the terminal and the session would keep running. Off unless the user allows it.
    const env = { ...ctx.env }
    if (!ctx.allowBackgroundSessions) env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1'
    if (ctx.use200kContext) env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    return { file: s.file, args: s.args, env }
  }

  autoCompact(ctx: LaunchContext, cmd: CommandSpec, models: string[]): AutoCompactSetting {
    const env = cmd.env ?? ctx.env
    // The user's own arguments (Hive passes no --autocompact; cmd.args may be wrapped for cmd).
    return autoCompactOf(ctx.extraArgs, env, settingsScopes(ctx.cwd, env.CLAUDE_CONFIG_DIR || claudeHome(), ctx.extraArgs), models)
  }

  /**
   * The settings that turn Claude Code's hooks off (#1336): the first scope, highest first, that sets disableAllHooks,
   * if it sets it on; or managed settings allowing only their own hooks (allowManagedHooksOnly), which Hive's aren't.
   */
  hooksOffIn(ctx: LaunchContext): string | null {
    const scopes = settingsScopes(ctx.cwd, ctx.env.CLAUDE_CONFIG_DIR || claudeHome(), ctx.extraArgs)
    const obj = (j: unknown): Record<string, unknown> | null => (j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null)
    if (obj(scopes[0]?.json)?.allowManagedHooksOnly === true) return scopes[0].label
    const deciding = scopes.find((s) => typeof obj(s.json)?.disableAllHooks === 'boolean')
    return deciding && obj(deciding.json)!.disableAllHooks === true ? deciding.label : null
  }

  backgroundTasks(appended: string): BackgroundTaskEvent[] {
    return claudeBackgroundTasks(appended)
  }

  safeguards(appended: string, memo: Record<string, unknown>): SafeguardEvent[] {
    return claudeSafeguards(appended, memo)
  }

  /** Turns by prompt id (prompt_id in its hooks), #1371. */
  transcriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
    return claudeTranscriptTurns(appended, memo)
  }

  readonly turnsJoin = 'id'

  /**
   * Claude Code's prompt after a safeguard stop (whether to switch models, a question it puts through its permission
   * check) is a Notification with no tool named (a tool's permission prompt says "…permission to use Bash"). Its open
   * dialog is told on the screen, in the lines written last, by the advanced setting claude-code.safeguard.prompt (its
   * numbered choices), never by the words "safeguards" or "safety classifier" in other text.
   */
  safeguardAsk(ask: Ask, screen: string): boolean {
    if (/\bto use\b/i.test(ask.message)) return false
    // The lines written last: on a screen cleared for the prompt it is at the top, with blank rows below.
    const bottom = screen.trimEnd().split('\n').slice(-SAFEGUARD_PROMPT_LINES).join('\n')
    return advanced.pattern('claude-code.safeguard.prompt').test(bottom)
  }

  startHint(text: string): StartHint | null {
    if (/\bmodel\b/i.test(text) && /not found|invalid|unknown|not available|does not exist|isn't available/i.test(text)) return { hint: tr(msg({ id: 'providers.claude.hint.model', defaultMessage: "Claude Code doesn't know this model: choose another in Agent Settings.", description: "Why Claude Code didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Agent Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    // Its argument parser: "error: unknown option '--x'", "error: option '--effort <level>' argument 'x' is invalid".
    if (/unknown option|unknown command|error: option|too many arguments|missing required argument|is invalid\. Allowed choices/i.test(text)) return { hint: tr(msg({ id: 'providers.claude.hint.args', defaultMessage: 'Claude Code refused an argument: check Extra arguments in Agent Settings and Settings → Claude Code.', description: "Why Claude Code didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Agent Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    if (/not logged in|please (run )?\/?login|invalid api key|authentication|OAuth/i.test(text)) return { hint: tr(msg({ id: 'providers.claude.hint.signIn', defaultMessage: "Claude Code isn't signed in: start it again and sign in in its terminal.", description: "Why Claude Code didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Agent Setup and Settings → … are Hive's names: use them as shown." })), fix: 'terminal' }
    if (/is not recognized|ENOENT|cannot find module|MODULE_NOT_FOUND/i.test(text)) return { hint: tr(msg({ id: 'providers.claude.hint.broken', defaultMessage: 'Claude Code looks broken or missing: reinstall or update it in Agent Setup.', description: "Why Claude Code didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Agent Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-setup' }
    return null
  }

  backgroundJobIn(output: string): string | null {
    // Claude Code names the job to attach to: "… running in the background … claude attach <id>".
    const text = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, ' ')
    return /background/i.test(text) ? (/\bclaude attach ([A-Za-z0-9-]{4,64})\b/.exec(text)?.[1] ?? null) : null
  }

  async stopBackgroundJob(executable: string, jobId: string): Promise<void> {
    const r = await run(executable, ['stop', jobId], 20000)
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `claude stop ${jobId} failed`) // i18n-ignore: a CLI command's name, when it said nothing itself
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  normalizeHook(body: Record<string, any>): NormalizedHook {
    const event = String(body.hook_event_name ?? '')
    const out: NormalizedHook = {
      event: { kind: 'ignore' },
      sessionId: typeof body.session_id === 'string' ? body.session_id : null,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : null,
      mode: hookMode(body.permission_mode),
      editedPaths: [],
      // Its turn is the prompt's (prompt_id, kept through a Stop hook's continuation); a sub-agent's hooks name it (agent_id).
      ids: hookIds(body, { turn: 'prompt_id', call: 'tool_use_id', sub: 'agent_id' }) // i18n-ignore: a hook field Claude Code sends
    }
    switch (event) {
      case 'SessionStart':
        out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
        break
      case 'UserPromptSubmit':
        out.event = { kind: 'prompt', text: typeof body.prompt === 'string' ? body.prompt : null }
        break
      case 'PreToolUse': {
        out.event = { kind: 'toolStart' }
        const input = body.tool_input ?? {}
        const file: unknown = input.file_path ?? input.notebook_path
        // Only the tools that edit files are checked against the locks (a Read names a file too).
        if (typeof file === 'string' && file && EDIT_TOOL.test(String(body.tool_name ?? ''))) out.editedPaths = [file]
        break
      }
      case 'PostToolUse':
        out.event = { kind: 'toolEnd' }
        break
      case 'Notification': {
        const kind: string = body.notification_type ?? body.type ?? ''
        const message: string = body.message ?? ''
        // "Claude is waiting for your input" (idle_prompt): sent once, a minute after a turn ends, only while no turn
        // runs and no dialog is open (2.1.296): the CLI is idle at its prompt.
        if (kind === 'idle_prompt') out.event = { kind: 'idle' }
        else if (kind === 'permission_prompt' || /permission|approve|waiting for your input/i.test(message)) {
          // Claude Code sends this when it shows the user a prompt, so none of its modes is `reviewed`.
          out.event = { kind: 'ask', ask: { kind: kind === 'permission_prompt' ? 'permission' : 'question', blocking: true, message: message || 'Waiting for your input' } } // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
        }
        break
      }
      case 'Stop':
        out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
        break
      case 'StopFailure': {
        // The turn ended on an API error instead of Stop. `authentication_failed` is the sign-in: expired, revoked or an
        // invalid key ("Login expired · Please run /login", 2.1.291). Any other error (a rate limit, the server) ends
        // the turn as Stop does, with the CLI's message, marked failed: it doesn't show the sign-in works.
        const message = typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null
        out.event = body.error === advanced.get<string>('claude-code.signIn.stopError') ? { kind: 'signIn', message } : { kind: 'stop', lastMessage: message, failed: true }
        break
      }
      case 'PreCompact':
        out.event = { kind: 'compactStart', trigger: String(body.trigger ?? 'auto') }
        break
      case 'PostCompact':
        out.event = { kind: 'compactEnd' }
        break
      case 'SessionEnd':
        out.event = { kind: 'end' }
        break
    }
    return out
  }

  lockReply(d: LockDecision): Record<string, unknown> {
    if (d.kind === 'warn') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context } }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.kind, permissionDecisionReason: d.reason } }
  }

  /**
   * Notices as context (2.1.296, #645's spike: each reaches the model as a user-role reminder): after a tool call
   * (PostToolUse; PreToolUse's lands at the same point, so it stays for locks), and at Stop, which carries the turn on.
   * Stop is given context, not a block, which the user would see as "Stop hook error".
   */
  noticeReply(event: string, text: string): Record<string, unknown> | null {
    if (!text || (event !== 'PostToolUse' && event !== 'Stop')) return null
    return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
  }

  /**
   * SessionStart's context (Claude Code's hooks reference: a command hook's JSON on stdout, which the forwarding curl
   * prints): fires at a start, a resume, a /clear and after each compaction (source compact).
   */
  startContextReply(text: string): Record<string, unknown> {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }
  }

  /** A Stop blocked, or given context, carries the turn on (2.1.296, #645's spike: both reach the model and it goes on). */
  stopContinues(reply: Record<string, any>): boolean {
    return reply.decision === 'block' || !!reply.hookSpecificOutput?.additionalContext
  }

  /** What Claude Code's screen shows of its turn (claudeTurnScreen), for the versions it was checked with (#648). */
  turnScreen(version: string | null): ((screen: string) => 'idle' | 'working' | null) | null {
    if (!version || compareVersions(version, TURN_SCREEN_SINCE) < 0) return null
    return claudeTurnScreen
  }

  /** Claude Code's status-line JSON: the session's model, effort, cost and context window, and the plan's limits. */
  statusLine(body: Record<string, any>): LiveDetails {
    const effort = typeof body.effort === 'string' ? body.effort : typeof body.effort?.level === 'string' ? body.effort.level : undefined
    const modelName = typeof body.model?.display_name === 'string' ? body.model.display_name : undefined
    const modelId = typeof body.model?.id === 'string' ? body.model.id : undefined
    const cost = Number(body.cost?.total_cost_usd)
    const window = Number(body.context_window?.context_window_size)
    return { effort, modelName, modelId, costUsd: Number.isFinite(cost) ? cost : undefined, contextWindow: window > 0 ? window : undefined, planUsage: parseClaudePlanUsage(body) }
  }

  footerMode(screen: string): string | null {
    return footerMode(screen, CLAUDE_FOOTER_MODES.map((d) => [d.mode, advanced.pattern(`claude-code.footer.${d.key}`)] as const))
  }

  canSwitchLive(target: string, current: string | undefined, launched: string | null | undefined): boolean {
    return canSwitchLive(target, current, launched)
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  /**
   * The folders of ~/.claude/projects holding a folder's transcripts, where Claude Code files them first (#493): it
   * names the folder by Node's realpath of its cwd (`claudeSpelling`), so a session started through a junction is under
   * the real path's name; then Hive's spelling and the real, long path (one started by another name, or an older CLI's).
   * Last, those named by an 8.3 short spelling of the folder, which no other spelling of it gives: found by the cwd
   * their transcripts record (`shortNamed`).
   */
  private async transcriptDirs(folder: string): Promise<string[]> {
    const root = join(claudeHome(), 'projects')
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      return []
    }
    const byName = new Map(names.map((d) => [d.toLowerCase(), d]))
    const wanted = new Set([claudeSpelling(folder), folder, realPath(folder)].map((p) => encodeProjectPath(p).toLowerCase()))
    const exact = [...wanted].flatMap((w) => (byName.has(w) ? [join(root, byName.get(w)!)] : []))
    return [...exact, ...(await this.shortNamed(root, names.filter((n) => !wanted.has(n.toLowerCase())), folder))]
  }

  /**
   * Of `names` (folders of ~/.claude/projects), those whose transcripts record an 8.3 short spelling of `folder` as their
   * cwd. Only names that may hold one (on the folder's drive, with an encoded `~n`) are looked in, and each one's cwd is
   * read once while the folder is unchanged.
   */
  private async shortNamed(root: string, names: string[], folder: string): Promise<string[]> {
    const drive = encodeProjectPath(realPath(folder)).slice(0, 3).toLowerCase()
    const here = placeMatcher(folder)
    const out: string[] = []
    for (const n of names) {
      if (!n.toLowerCase().startsWith(drive) || !MAY_BE_SHORT.test(n)) continue
      const cwd = await this.recordedCwd(join(root, n))
      if (cwd?.includes('~') && here(cwd)) out.push(join(root, n))
    }
    return out
  }

  /**
   * The cwd the transcripts in a folder of ~/.claude/projects record (the first found). One found is kept: the folder is
   * named after it. None found is kept only while the transcripts looked in are the same (names, sizes and times): a
   * transcript's first lines carry no cwd, and a line added to it doesn't change the folder's time.
   */
  private cwds = new Map<string, { cwd: string } | { files: string }>()
  private async recordedCwd(dir: string): Promise<string | null> {
    const c = this.cwds.get(dir)
    if (c && 'cwd' in c) return c.cwd
    const names = (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith('.jsonl')).slice(0, 3)
    const stats = await Promise.all(names.map((f) => stat(join(dir, f)).catch(() => null)))
    const files = names.map((f, i) => `${f}:${stats[i]?.size}:${stats[i]?.mtimeMs}`).join('|')
    if (c && c.files === files) return null
    let cwd: string | null = null
    for (const f of names) if ((cwd = await headCwd(join(dir, f)))) break
    this.cwds.delete(dir)
    this.cwds.set(dir, cwd ? { cwd } : { files })
    if (this.cwds.size > SUB_CACHE) this.cwds.delete(this.cwds.keys().next().value!)
    return cwd
  }

  async transcriptDir(folder: string): Promise<string | null> {
    return (await this.transcriptDirs(folder))[0] ?? null
  }

  async transcriptPath(folder: string, sessionId: string): Promise<string | null> {
    const file = `${assertSessionId(sessionId)}.jsonl`
    for (const dir of await this.transcriptDirs(folder)) if (existsSync(join(dir, file))) return join(dir, file)
    return null
  }

  /** Where a transcript would be written for a folder that has none yet: where Claude Code looks for it on resume. */
  restorePath(folder: string, sessionId: string): string {
    return join(claudeHome(), 'projects', encodeProjectPath(claudeSpelling(folder)), `${assertSessionId(sessionId)}.jsonl`)
  }

  /**
   * A moved folder's transcripts and auto memory (memory/), copied to the folder named for its new path (#146): from
   * each folder they are kept under (`transcriptDirs`, #493), in that order, so what the first has wins and a file of a
   * later one that differs is kept and listed, without apply too.
   */
  async copyPathData(from: string, to: string, apply: boolean): Promise<PathDataCopy[]> {
    const dest = (await this.transcriptDir(to)) ?? join(claudeHome(), 'projects', encodeProjectPath(claudeSpelling(to)))
    const planned: PlannedCopies = new Map()
    const out: PathDataCopy[] = []
    for (const src of await this.transcriptDirs(from)) {
      if (samePath(src, dest)) continue
      const r = await copyMissing(src, dest, apply, planned)
      out.push({ provider: this.id, from: src, to: dest, copy: r.copy, kept: r.kept, ...(r.failed.length ? { failed: r.failed } : {}) })
    }
    return out
  }

  async listSessions(folder: string): Promise<ExternalSession[]> {
    const out: ExternalSession[] = []
    const seen = new Set<string>()
    for (const dir of await this.transcriptDirs(folder)) for (const f of await readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl') || !isSessionId(basename(f, '.jsonl'))) continue
      const p = join(dir, f)
      try {
        const s = await stat(p)
        const id = basename(f, '.jsonl')
        if (!s.isFile() || s.size === 0 || seen.has(id.toLowerCase())) continue
        seen.add(id.toLowerCase())
        const sub = await this.subSession(p, id, s.mtimeMs)
        out.push({ id, transcriptPath: p, modified: s.mtime.toISOString(), ...(sub ? { sub } : {}) })
      } catch {
        // Removed between readdir and stat.
      }
    }
    return out
  }

  async subSessionOf(path: string, sessionId: string): Promise<SubSession | null> {
    const s = await stat(path).catch(() => null)
    return s ? this.subSession(path, sessionId, s.mtimeMs) : null
  }

  /** Each transcript's sub-agent check (its first line), by file and mtime; the oldest go past SUB_CACHE entries. */
  private subs = new Map<string, { mtime: number; sub: SubSession | null }>()
  private async subSession(path: string, id: string, mtime: number): Promise<SubSession | null> {
    const c = this.subs.get(path)
    if (c && c.mtime === mtime) return c.sub
    const sub = transcriptSubSession(await readFirstLine(path, 256 * 1024).catch(() => ''), id)
    this.subs.delete(path)
    this.subs.set(path, { mtime, sub })
    if (this.subs.size > SUB_CACHE) this.subs.delete(this.subs.keys().next().value!)
    return sub
  }

  parseUsage(text: string, sessionId: string) {
    return parseTranscript(text, sessionId)
  }

  usageParser(sessionId: string): ClaudeUsageParser {
    return new ClaudeUsageParser(sessionId)
  }

  conversationParser(projectPath: string): ConversationParser {
    return new ConversationParser(projectPath)
  }

  imageData = claudeImageData

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
  }

  // -------------------------------------------------------------------------
  // Project files
  // -------------------------------------------------------------------------

  async memorySources(projectPath: string): Promise<MemorySource[]> {
    const p = this.id
    const sources: MemorySource[] = [
      { provider: p, id: 'project', label: 'CLAUDE.md', path: join(projectPath, 'CLAUDE.md'), kind: 'claude-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'project-dot', label: '.claude/CLAUDE.md', path: join(projectPath, '.claude', 'CLAUDE.md'), kind: 'claude-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'local', label: 'CLAUDE.local.md', path: join(projectPath, 'CLAUDE.local.md'), kind: 'local-md', exists: false }, // i18n-ignore: a file's name
      { provider: p, id: 'user', label: userMemoryLabel('CLAUDE.md'), path: join(claudeHome(), 'CLAUDE.md'), kind: 'claude-md', exists: false }
    ]
    for (const s of sources) s.exists = existsSync(s.path)
    const dir = await this.transcriptDir(projectPath)
    const memDir = dir ? join(dir, 'memory') : null
    if (memDir && (await isDir(memDir))) {
      const files = (await readdir(memDir)).filter((f) => f.endsWith('.md')).sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      for (const f of files) {
        sources.push({ provider: p, id: `auto:${f}`, label: f, path: join(memDir, f), kind: 'auto-memory', exists: true })
      }
    }
    return sources
  }

  fileAllowed(path: string, write: boolean): boolean {
    return claudeFileAllowed(path, write, claudeHome())
  }

  skillRoots(): SkillRoots {
    return { machine: [join(claudeHome(), 'skills')], plugins: join(claudeHome(), 'plugins'), local: [join('.claude', 'skills')], hiveCopyPrefix: null }
  }

  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    const j = await readJson<{ mcpServers?: Record<string, McpServerDef> }>(join(projectPath, '.mcp.json'), {})
    return j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {}
  }
}

export const claudeCode = new ClaudeCodeAdapter()
