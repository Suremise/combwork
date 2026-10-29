import { createHash } from 'crypto'
import { msg, tr } from '../../../shared/i18n'
import { spawn } from 'child_process'
import { codexCheckHeld, ownedAppServerRequest, type CheckAnswer } from '../../codexChecks'
import { homedir, tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { readdir, readFile, stat } from 'original-fs/promises'
import { existsSync, mkdirSync, readFileSync, statSync } from 'original-fs'
import { parse as parseToml } from 'smol-toml'
import type { AgentInstallInfo, McpServerDef, MemorySource, PermissionMode, ReadinessIssue, RetryWait, SubSession } from '../../../shared/types'
import { assertSessionId, isSessionId } from '../../../shared/defaults'
import type { StartHint } from '../../../shared/startFailure'
import { CODEX, CODEX_DESCRIPTOR, CODEX_MODE_FLAGS, CODEX_PERMISSION_MODES } from '../../../shared/codex'
import { providerSettings } from '../../../shared/providers'
import type { TypedNewline } from '../../../shared/terminalInput'
import { HIVE_TOOLS } from '../../../shared/assistantTools'
import { config } from '../../config'
import { isFile, placeMatcher } from '../../fsutil'
import { createLogger, userText } from '../../logger'
import { hiveError } from '../../hiveError'
import { plainHttpsJson } from '../../plainHttpsJson'
import { findSecretWarnings } from '../../mcpSecrets'
import { AGENTS_SKILLS, EDITOR_EXTENSION_PATH, EDITOR_ROOTS, agentsSkillCopyPath, compareVersions, connectionMemoryLabel, hookForwardCommand, exportSubtitleText, hookIds, installText, keepBounded, notInstalledIssue, readFirstLine, run, signedOutIssue, syncAgentsSkills, taskArgs, toSpawnable, updateIssue, userMemoryLabel } from '../common'
import { storePwshFirst, storePwshIssue } from './storePwsh'
import type { BackgroundTaskEvent, CatalogRead, CommandSpec, ConnectionStatus, TrustReading, TrustTarget, ExternalSession, KeySteps, LaunchContext, LaunchHooks, LiveDetails, LockDecision, NormalizedHook, ProviderAdapter, SkillDelivery, SkillRoots, TranscriptTurn, UsageParser } from '../types'
import { codexBackgroundMemo, codexBackgroundTasks, type CodexBackgroundMemo } from './background'
import { codexSafeguards } from './safeguards'
import { codexTranscriptTurns } from './turns'
import { codexRetryWait } from './retryLog'
import type { SafeguardEvent } from '../../../shared/safeguards'
import { CodexConversationParser, CodexUsageParser, codexImageData, parseRollout, patchPaths, rolloutDetails, rolloutSubSession } from './rollout'
import { parseCodexModels } from './models'
import { atMost } from '../../../shared/atMost'
import { permissionsMenuLabel, permissionsMenuNumber } from './permissionsMenu'
import { strayCodexWarning } from './strayFolder'
import { advanced } from '../../advanced'
import { launchOverrides } from '../../advancedValues'
import { codexListedHooks } from '../../hookListing'
import type { HookListing, HookRow } from '../../../shared/hooks'
import { withoutHiveAuth } from '../../../shared/hooks'

const log = createLogger('codex')
/** Rollouts stat'd at once while listing a folder's sessions (HI-1681). */
const LIST_AT_ONCE = 8
/** A rollout's session, from its session_meta. */
type RolloutSession = { id: string; cwd: string; path: string; sub: SubSession | null }

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * A TOML file as an object; empty when missing or unreadable. Read each time and parsed again only when its text
 * changed: two writes in one tick of the clock share a modification time, and can share a size (HI-2051).
 */
const tomlCache = new Map<string, { text: string; data: Record<string, any> }>()
function readToml(path: string): Record<string, any> {
  try {
    const text = readFileSync(path, 'utf8')
    const c = tomlCache.get(path)
    if (c && c.text === text) return c.data
    const data = parseToml(text) as Record<string, any>
    tomlCache.set(path, { text, data })
    return data
  } catch {
    return {}
  }
}

const userConfig = (): Record<string, any> => readToml(join(codexHome(), 'config.toml'))
/** A home's config.toml: a connection's (HI-1757), or Codex's own. */
const configOf = (home?: string): Record<string, any> => (home ? readToml(join(home, 'config.toml')) : userConfig())

/** Provider Setup's explanation of the two choices Codex's sandbox setup offers, for someone working in Hive. */
const SANDBOX_CHOICE = [
  msg({ id: 'providers.codex.sandbox.setUp', defaultMessage: "**Set up** opens Codex's sandbox setup, which offers two choices. With either, Codex agents in **Ask for approval** or **Approve for me** can edit files in their own folder (the project, or the agent's worktree) and run commands there without asking, and ask before going online or writing anywhere else. Hive's own features (status, file locks, handovers, shared notes) work the same with both.", description: "Provider Setup, under Codex's sandbox setup (Windows): what Set up does. **…** marks bold text: keep the marks. Set up is the button; Ask for approval and Approve for me are Codex's permission modes as Hive names them: use their names as shown." }),
  msg({ id: 'providers.codex.sandbox.default', defaultMessage: '**Set up default sandbox** (recommended): commands run under two local Windows accounts Codex creates for them (`CodexSandboxOffline` and `CodexSandboxOnline`), with a firewall rule that keeps them offline unless you allow it. It isolates commands best. Windows asks for Administrator permission once.', description: "Provider Setup, under Codex's sandbox setup (Windows): its first choice. **Set up default sandbox** is the choice as Codex names it (in English); `…` marks account names: keep them." }),
  msg({ id: 'providers.codex.sandbox.nonAdmin', defaultMessage: '**Use non-admin sandbox**: needs no Administrator permission. Commands run under your own account with restricted rights. It protects your files and blocks internet access in most cases, but Codex warns it carries more risk if the agent is tricked by instructions hidden in a file or web page it reads (prompt injection). You can upgrade to the default sandbox from here later.', description: "Provider Setup, under Codex's sandbox setup (Windows): its second choice. **Use non-admin sandbox** is the choice as Codex names it (in English)." })
]

/** A value as TOML, for -c overrides: strings, numbers, booleans, arrays and inline tables. */
export function toToml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(toToml).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined && x !== null)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toToml(x)}`)
      .join(',')}}`
  }
  return '""'
}

/** Keys used in hook trust records for hooks passed with -c (Codex's synthetic "session flags" layer). */
const SESSION_FLAGS = process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml'

/**
 * Which tool call a hook is about, the same in its PermissionRequest and PostToolUse (Codex sends no call id, and
 * adds a `description` to the request's input): the tool and its command, patch or questions.
 */
function toolCall(tool: string, input: Record<string, unknown>): string {
  return `${tool}\n${typeof input.command === 'string' ? input.command : JSON.stringify(input.questions ?? input.patch ?? '')}`
}

/** The first Codex version seen to title its terminal "Action Required" while a person must act (titleAttention). */
const ACTION_REQUIRED_SINCE = '0.160.0'
/** The version whose screens codexTurnScreen was checked against (#648, recorded in #645's spike). */
const TURN_SCREEN_SINCE = '0.162.1'
/**
 * What Codex's screen shows of its turn (0.162.1, #648): 'working' while its Working line says so ("• Working (5s • esc
 * to interrupt)", only drawn while a turn runs); 'idle' when its input, the last line it marks with "›", is empty, showing
 * its placeholder ("Ask Codex to do anything"), with nothing queued; else null (a draft, a dialog, a menu: not sure).
 */
export function codexTurnScreen(screen: string): 'idle' | 'working' | null {
  if (advanced.pattern('codex.turnScreen.working').test(screen)) return 'working'
  if (codexHoldsInput(screen)) return null
  const input = screen
    .split('\n')
    .map((l) => l.trim())
    .findLast((l) => l.startsWith('›'))
  // Its placeholder alone (an advanced setting, #367).
  return input && input.replace(/^›\s*/, '') === advanced.get<string>('codex.ready.placeholder').trim() ? 'idle' : null
}
/**
 * Codex has loaded: its session header names the folder (`~\…`, `C:\…`, `\\server\…`) where it said "loading". The
 * setup task's keys wait for it: its prompt ("› Ask Codex to do anything") is drawn while it is still loading, and its
 * startup spinner only comes after (#235). Matched positively, so no part of "loading" (output can end anywhere) counts.
 */
export const CODEX_LOADED = /OpenAI Codex\s+\(v[^)]*\)[\s│]+(?:~|[A-Za-z]:|[\\/])/
/**
 * Whether Codex is busy and holding what was typed (#363): its hint "tab to queue message" on the last line it draws,
 * under its input, while it works. It can show before the title's spinner does, so keys typed then wait for it to go
 * too. Only there: the same words in the conversation above (someone writing about the hint) aren't Codex busy.
 */
export function codexHoldsInput(screen: string): boolean {
  const last = screen
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  return last !== undefined && advanced.pattern('codex.queue.hint').test(last)
}
/**
 * Whether Codex's input still holds `command`, unrun (#363): the input is the last line Codex marks with "›", and holds
 * just the command (a menu's selected row, or an input that is empty or holds anything else, isn't it). Run, or queued
 * by Codex to run when it is free, the command leaves the input.
 */
export function inputHolds(screen: string, command: string): boolean {
  const input = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /^\s*›/.test(l))
    .at(-1)
  return input !== undefined && input.replace(/^\s*›\s*/, '') === command
}
/**
 * Codex's own terminal title items, set for Hive's sessions and its sandbox setup so a user's [tui].terminal_title
 * can't hide "Action Required" or the busy spinner.
 */
const titleItems = (): string[] => advanced.get<string[]>('codex.title.items')

type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'PermissionRequest' | 'Stop' | 'Interrupt' | 'PreCompact' | 'PostCompact' | 'SessionEnd'
/** A hook's timeout: the hooks' (5 s), PreToolUse's (10 s), or at most 3 s (#367: advanced settings). */
type HookWait = 'hook' | 'preToolUse' | 'short'
const HOOKS: { event: HookEvent; label: string; matcher?: string; wait: HookWait }[] = [
  { event: 'SessionStart', label: 'session_start', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'UserPromptSubmit', label: 'user_prompt_submit', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  // PreToolUse answers with a file-lock decision; request_user_input also comes through here.
  { event: 'PreToolUse', label: 'pre_tool_use', matcher: '*', wait: 'preToolUse' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'PostToolUse', label: 'post_tool_use', matcher: '*', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'PermissionRequest', label: 'permission_request', matcher: '*', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'Stop', label: 'stop', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  // Codex clamps these two to 3 seconds (and warns in the terminal about anything longer).
  { event: 'Interrupt', label: 'interrupt', wait: 'short' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'PreCompact', label: 'pre_compact', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'PostCompact', label: 'post_compact', wait: 'hook' }, // i18n-ignore: Codex's hook event names, as its config writes them
  { event: 'SessionEnd', label: 'session_end', wait: 'short' } // i18n-ignore: Codex's hook event names, as its config writes them
]

/** A hook's timeout in seconds, from Settings → Advanced (#367); part of its trust hash. */
function hookTimeout(wait: HookWait): number {
  const hook = advanced.number('codex.hooks.timeoutSeconds')
  return wait === 'preToolUse' ? advanced.number('codex.hooks.preToolUseTimeoutSeconds') : wait === 'short' ? Math.min(3, hook) : hook
}

/**
 * Codex runs hook commands with PowerShell on Windows, where a quoted program path is an expression and
 * a bare @- is splatting: hookForwardCommand's form (curl.exe unquoted, "@-" quoted) works there. The header comes from
 * the launch's auth file, so the -c arguments (seen in process listings) carry no token (#345).
 */
function hookCommand(url: string, authFile: string): string {
  return hookForwardCommand(url, authFile, advanced.number('codex.hooks.timeoutSeconds'))
}

const sortDeep = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v

/**
 * The trust hash Codex gives a hook: SHA-256 of the sorted JSON of its normalised definition
 * (codex-rs/hooks discovery.rs, version_for_toml). Checked against Codex itself once per version.
 */
export function hookHash(label: string, matcher: string | undefined, command: string, timeout: number): string {
  const id: Record<string, unknown> = { event_name: label, hooks: [{ type: 'command', command, timeout, async: false }] }
  if (matcher) id.matcher = matcher
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sortDeep(id))).digest('hex')
}

/**
 * The config overrides of a launch's arguments (`-c k=v`, `--config k=v`), for asking its app server what the launch has
 * (HI-982): only those, since its other arguments (-s, -a, resume) aren't the app server's; without the developer
 * instructions and MCP servers, which say nothing of hooks.
 */
export function hookQueryArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const v = a === '-c' || a === '--config' ? args[++i] : a.startsWith('--config=') ? a.slice('--config='.length) : null
    if (typeof v !== 'string' || /^(developer_instructions\s*=|mcp_servers[.=])/.test(v)) continue
    out.push('-c', v)
  }
  return out
}

/** -c overrides for Hive's hooks, with the trust records that let them run without a review prompt. */
function hookOverrides(url: string, authFile: string, hashes?: Record<string, string>): string[] {
  const command = hookCommand(url, authFile)
  const args: string[] = []
  const state: Record<string, { trusted_hash: string }> = {}
  for (const h of HOOKS) {
    const timeout = hookTimeout(h.wait)
    const handler = { type: 'command', command, timeout }
    args.push('-c', `hooks.${h.event}=${toToml([h.matcher ? { matcher: h.matcher, hooks: [handler] } : { hooks: [handler] }])}`)
    const key = `${SESSION_FLAGS}:${h.label}:0:0`
    state[key] = { trusted_hash: hashes?.[key] ?? hookHash(h.label, h.matcher, command, timeout) }
  }
  args.push('-c', `hooks.state=${toToml(state)}`)
  return args
}

/** Asks Codex (its app server) for the keys and hashes of the given hooks. */
async function hooksFromCodex(executable: string, hookArgs: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<Record<string, string> | null> {
  const result = await askAppServer(executable, hookArgs, cwd, advanced.get<string>('codex.hooks.listMethod'), { cwds: [cwd] }, env, advanced.number('codex.hooks.listSeconds') * 1000)
  const out: Record<string, string> = {}
  for (const entry of result?.data ?? []) for (const h of entry.hooks ?? []) if (h.key && h.currentHash) out[h.key] = h.currentHash
  return Object.keys(out).length ? out : null
}

/** Whether a file in a Codex home may be opened in Hive: its AGENTS.md (editable) and its skills' SKILL.md (read-only). */
function codexFileAllowed(path: string, write: boolean, homeDir: string): boolean {
  const home = resolve(homeDir).toLowerCase()
  const abs = resolve(path).toLowerCase()
  if (!abs.startsWith(home + '\\') && !abs.startsWith(home + '/')) return false
  const rel = abs.slice(home.length + 1).replace(/\\/g, '/')
  if (rel === 'agents.md') return true
  return !write && rel.startsWith('skills/') && basename(rel) === 'skill.md'
}

/** The fields of Codex's sign-in answer Hive reads (Settings → Advanced, codex.accounts.*). */
export interface CodexAccountFields {
  account: string
  email: string
  plan: string
}

/**
 * Who a CODEX_HOME is signed in as, from its app server's account answer (HI-1757: `account/read`; the type, email and
 * plan, never a token or the account's id): signed out when its account is null. `ok: false` when there was no answer
 * or Hive can't read it, which isn't signed out.
 */
export function codexAccountStatus(answer: { ok: true; result: any } | { ok: false; error: string }, f: CodexAccountFields): ConnectionStatus {
  if (!answer.ok) return { ok: false, error: answer.error }
  const r = answer.result
  if (!r || typeof r !== 'object' || !(f.account in r)) return { ok: false, error: `its answer had no "${f.account}"` } // i18n-ignore: for the log
  const a = r[f.account]
  if (a === null) return { ok: true, loggedIn: false }
  if (typeof a !== 'object') return { ok: false, error: `its "${f.account}" was not an object` } // i18n-ignore: for the log
  const str = (k: string): string | undefined => (typeof a[k] === 'string' && a[k] ? (a[k] as string) : undefined)
  return { ok: true, loggedIn: true, email: str(f.email), plan: str(f.plan) ?? null }
}

/** Settings → Advanced's key for a typed prompt's line breaks (HI-1327). */
const NEWLINE_KEY = 'codex.prompt.newlineKey'
/**
 * The Codex versions its default typed newline (Alt+Enter) was tried on, in real Codex (HI-1327: the real-tier suite
 * codex-newline, Alt+Enter and Ctrl+J each arriving as written in one prompt; 28 Oct 2026). Add a version once the
 * suite passes on it.
 */
export const NEWLINE_TRIED: readonly string[] = ['0.164.0']

/** The store Codex keeps a connection's login in (HI-1757): its own folder, whatever Codex's default store is. */
export const CONNECTION_STORE = ['-c', 'cli_auth_credentials_store="file"']

/**
 * The overrides every Codex a launch on a connection runs takes (HI-1757): the session and its preflights alike (its
 * hook check, its prompt render), each also in the launch's own environment. None on Codex's own home.
 */
export function launchConnectionArgs(ctx: Pick<LaunchContext, 'connectionHome'>): string[] {
  if (!ctx.connectionHome) return []
  return [...CONNECTION_STORE, ...connectionSandboxArgs(ctx.connectionHome)]
}

/**
 * The Windows sandbox a connection's Codex runs in, passed with -c and never written: none when its own config.toml
 * names one (it keeps its own); Codex's non-admin one when Advanced turns it on for connections (HI-1893); else this
 * PC's, from ~/.codex's config. None off Windows.
 */
function connectionSandboxArgs(home: string): string[] {
  if (process.platform !== 'win32' || configOf(home).windows?.sandbox) return []
  const mode = advanced.get<boolean>('codex.accounts.unelevatedSandbox') ? 'unelevated' : userConfig().windows?.sandbox
  return typeof mode === 'string' && /^[\w-]{1,24}$/.test(mode) ? ['-c', `windows.sandbox=${toToml(mode)}`] : []
}

/**
 * The developer_instructions Codex itself would give a session started with `args` (the agent's Extra arguments) in
 * `cwd` (#1285, the Assistant's design on it): Hive parses no profile and ranks no layer, Codex does. Its offline prompt
 * inspector (`debug prompt-input`, no model call or sign-in) renders the session's prompt twice, as it is and with
 * developer_instructions cleared (`-c developer_instructions=""`, which overrides every layer, profile and project
 * alike): what the first's developer message has in front of the second's is the value, and the same renders mean none
 * (missing, empty or blank). Its app server can't do this: it can't select a profile (0.163.0). Null when Codex couldn't
 * render it or the two renders differ otherwise: Hive then gives its guidance alone, as before #1285.
 */
async function developerInstructionsFromCodex(executable: string, cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  const [as, cleared] = await Promise.all([promptDeveloper(executable, cwd, [...args], env), promptDeveloper(executable, cwd, [...args, '-c', 'developer_instructions=""'], env)])
  return developerInstructionsOf(as, cleared)
}

/**
 * The developer_instructions in a session's rendered prompt (`as`, its developer messages' texts), given the same prompt
 * with them cleared (`cleared`): one text more, the rest the same and in the same order, is the value (in front in
 * 0.163.0; first in the second developer message, after Codex's own base instructions, in 0.164.0); the same texts, none
 * (''). Null for anything else (a render missing, or renders Hive can't tell apart).
 */
export function developerInstructionsOf(as: readonly string[] | null, cleared: readonly string[] | null): string | null {
  if (!as || !cleared) return null
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])
  if (same(as, cleared)) return ''
  if (as.length !== cleared.length + 1) return null
  const k = as.findIndex((t, i) => t !== cleared[i])
  return same([...as.slice(0, k), ...as.slice(k + 1)], cleared) ? as[k].trim() : null
}

/** The texts of the developer message in Codex's rendering of a session's prompt (`codex <args> debug prompt-input`), or null. */
function promptDeveloper(executable: string, cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string[] | null> {
  return new Promise((resolveP) => {
    const s = toSpawnable(executable, [...args, 'debug', 'prompt-input'])
    const p = spawn(s.file, s.args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env } : {}) })
    let out = ''
    const timer = setTimeout(() => (p.kill(), resolveP(null)), advanced.number('codex.promptInput.timeoutSeconds') * 1000)
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => (clearTimeout(timer), resolveP(null)))
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return resolveP(null)
      try {
        resolveP(developerTexts(JSON.parse(out)))
      } catch {
        resolveP(null)
      }
    })
  })
}

/**
 * The texts of the developer messages in Codex's rendered prompt items (`debug prompt-input`'s JSON), in order: every
 * item with the developer role that is a message. 0.164.0 renders its tools first as an item with the developer role too
 * (`additional_tools`, no content), then its base instructions as a developer message of their own, and the
 * developer_instructions in the next: read from the first developer item alone, every session's read as none, so Hive's
 * guidance would have replaced the user's (#1514's real tier, codexownhooks).
 */
export function developerTexts(items: unknown): string[] | null {
  if (!Array.isArray(items)) return null
  const devs = (items as { type?: unknown; role?: unknown; content?: unknown }[]).filter((x) => x?.role === 'developer' && (x.type === undefined || x.type === 'message') && Array.isArray(x.content))
  return devs.flatMap((dev) => (dev.content as { text?: unknown }[]).map((c) => (typeof c?.text === 'string' ? c.text : '')))
}

/** One request to Codex's app server (started for it, in `cwd`, with `args`): its result, or null on an error or after 20 s. */
function askAppServer(executable: string, args: string[], cwd: string, method: string, params: unknown, env?: NodeJS.ProcessEnv, timeoutMs = 20000): Promise<any> {
  return appServerAnswer(executable, args, cwd, method, params, env, timeoutMs).then((a) => (a.ok ? a.result : null))
}

/**
 * One request's answer from Codex's app server: its result, its error (`ok: false`, `error` its message), or none
 * (`error` says why). Run through Hive's process ownership (codexChecks.ts, HI-1757): owned before it runs and confirmed
 * gone before the answer is given; an end not confirmed is a failed answer, its connection held until it is.
 */
function appServerAnswer(executable: string, args: string[], cwd: string, method: string, params: unknown, env: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<CheckAnswer> {
  const s = toSpawnable(executable, ['app-server', ...args])
  return ownedAppServerRequest({ command: s.file, args: s.args, cwd, env: env ?? process.env, method, params, timeoutMs })
}

/**
 * Only Hive's own server's tools run without Codex asking (#1166), as with Claude Code and Copilot; every other server's
 * follow Codex's approval policy for the agent's mode. ("hive" is reserved: no workspace server has that name.) The
 * Assistant's only the ones its Control settings let it use without asking (`trusted`, #1174: Codex 0.163 takes a
 * per-tool `tools.<tool>.approval_mode`); none with the switch off (#1281). Hive's server is always on (`enabled`): a
 * native server named hive merges into Hive's table key by key, and could turn it off.
 */
function hiveTable(name: string, hive: HiveServerOptions): Record<string, unknown> {
  if (name !== 'hive') return {}
  if (!hive.preApprove) return { enabled: true }
  if (hive.trusted) return { enabled: true, tools: Object.fromEntries(hive.trusted.map((t) => [t, { approval_mode: 'approve' }])) }
  return { enabled: true, default_tools_approval_mode: 'approve' }
}

/** How Hive's own server is given to this launch: its tools pre-approved (all, or the Assistant's `trusted`), or not. */
export interface HiveServerOptions {
  preApprove: boolean
  trusted?: readonly string[]
}

/** An MCP server definition (Claude Code's JSON format) as a Codex mcp_servers table; null if it can't be passed safely. */
export function codexMcpServer(name: string, def: McpServerDef, hive: HiveServerOptions = { preApprove: true }): { table: Record<string, unknown> | null; warning?: string } {
  const approval = (n: string): Record<string, unknown> => hiveTable(n, hive)
  const ref = (v: unknown): string | null => {
    const m = typeof v === 'string' ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.trim()) : null
    return m ? (m[1] ?? m[2]) : null
  }
  // Secrets must be environment references: literal ones would appear on Codex's command line.
  if (findSecretWarnings(def).length) return { table: null, warning: `MCP server "${name}" has a literal secret, so Codex agents don't get it. Use an environment variable reference such as \${TOKEN}.` } // i18n-ignore: logged only
  if (def.url) {
    const table: Record<string, unknown> = { url: def.url, ...approval(name) }
    const plain: Record<string, string> = {}
    const fromEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(def.headers ?? {})) {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(v))
      if (/^authorization$/i.test(k) && bearer && ref(bearer[1])) table.bearer_token_env_var = ref(bearer[1])
      else if (ref(v)) fromEnv[k] = ref(v)!
      else if (typeof v === 'string' && v.includes('${')) return { table: null, warning: `MCP server "${name}": header ${k} mixes text and a variable, which Codex can't pass on. Codex agents don't get this server.` } // i18n-ignore: logged only
      else plain[k] = String(v)
    }
    if (Object.keys(plain).length) table.http_headers = plain
    if (Object.keys(fromEnv).length) table.env_http_headers = fromEnv
    return { table }
  }
  if (!def.command) return { table: null }
  const table: Record<string, unknown> = { command: def.command, ...approval(name) }
  // Hive's own tools can wait minutes (for agents to finish, or for the user to answer the Assistant).
  if (name === 'hive') table.tool_timeout_sec = advanced.number('codex.mcp.toolTimeoutSeconds')
  if (def.args?.length) table.args = def.args.map(String)
  if (typeof def.cwd === 'string') table.cwd = def.cwd
  const env: Record<string, string> = {}
  const passThrough: string[] = []
  for (const [k, v] of Object.entries(def.env ?? {})) {
    const r = ref(v)
    if (r === k) passThrough.push(k)
    else if (r || (typeof v === 'string' && v.includes('${'))) return { table: null, warning: `MCP server "${name}": env ${k} takes its value from another variable, which Codex can't pass on. Name the variable ${k} itself.` } // i18n-ignore: logged only
    else env[k] = String(v)
  }
  if (Object.keys(env).length) table.env = env
  if (passThrough.length) table.env_vars = passThrough
  return { table }
}

/** A native hive server's keys for an HTTP server, which can't be taken out of Hive's stdio one (Codex refuses the mix). */
const HTTP_KEYS = ['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'http_headers_helper', 'auth', 'oauth', 'oauth_resource', 'scopes', 'experimental_environment']

/** Why a Codex agent can't start beside a native HTTP server named hive (outrankNativeHive). */
const NATIVE_HIVE = msg({
  id: 'providers.codex.nativeHive',
  defaultMessage: 'Your Codex config has an MCP server named hive, reached over HTTP ({file}). Codex merges it into Hive’s own hive server, and can’t start with both. Rename yours there to start Codex agents.',
  description: "Why a Codex agent didn't start: the user's own Codex config has an MCP server named hive. {file} is that config file's path. hive is the name of Hive's MCP server: keep it."
})

/**
 * Hive's own hive server over a native one of that name (the user's own [mcp_servers.hive] in these config files, #1281):
 * Codex merges Hive's `-c mcp_servers.hive={…}` into it key by key (0.163.0, probed: a whole table, an empty value or
 * another transport can't take a key out), so Hive's table gives every key the native one sets Hive's value, and Hive's
 * server wins whatever the isolation switch says:
 * - its tools: all of them shown (`enabled_tools`, `disabled_tools`; `enabled` is always set, hiveTable);
 * - their approval: the server default and each native per-tool mode as this launch approves them (`approved`: every
 *   tool, the Assistant's trusted ones, or none), "auto" (Codex's own policy) for the rest;
 * - how it starts: the session's folder for its `cwd`, Hive's startup timeout (`codex.mcp.startupTimeoutSeconds`, Codex's
 *   own default), not `required`, and the native
 *   `env` and `env_vars` emptied (an environment variable Hive doesn't set is set empty: Codex can't remove one).
 * An HTTP one (`url` and its kin, HTTP_KEYS) can't be taken out of a stdio server: the launch is refused with what to do
 * (NATIVE_HIVE; Codex itself would refuse to start).
 */
export function outrankNativeHive(files: string[], table: Record<string, unknown>, approved: 'all' | readonly string[], cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const mode = (tool: string): string => (approved === 'all' || approved.includes(tool) ? 'approve' : 'auto')
  for (const file of files) {
    const servers = readToml(file).mcp_servers
    const native = servers && typeof servers === 'object' ? (servers as Record<string, unknown>).hive : undefined
    if (!native || typeof native !== 'object') continue
    const n = native as Record<string, unknown>
    const http = Object.keys(n).filter((k) => HTTP_KEYS.includes(k))
    if (http.length) {
      log.warn(`Codex has an HTTP MCP server named hive in ${userText(file)} (${http.join(', ')}): Codex agents can't start beside Hive's own.`)
      throw hiveError(NATIVE_HIVE, { file })
    }
    if ('enabled_tools' in n) out.enabled_tools = [...HIVE_TOOLS]
    if ('disabled_tools' in n) out.disabled_tools = []
    if ('default_tools_approval_mode' in n && !('default_tools_approval_mode' in table)) out.default_tools_approval_mode = approved === 'all' ? 'approve' : 'auto'
    const tools = n.tools && typeof n.tools === 'object' ? Object.keys(n.tools as Record<string, unknown>) : []
    if (tools.length) {
      const own = (table.tools ?? {}) as Record<string, unknown>
      const merged = { ...((out.tools ?? {}) as Record<string, unknown>) }
      for (const t of tools) if (!(t in own)) merged[t] = { approval_mode: mode(t) }
      out.tools = { ...own, ...merged }
    }
    if ('cwd' in n && !('cwd' in table)) out.cwd = cwd
    // Settings → Advanced (default Codex's own documented 10 s), over the native one's.
    const startup = advanced.number('codex.mcp.startupTimeoutSeconds')
    if ('startup_timeout_sec' in n) out.startup_timeout_sec = startup
    if ('startup_timeout_ms' in n) out.startup_timeout_ms = startup * 1000
    if ('required' in n) out.required = false
    const env = n.env && typeof n.env === 'object' ? Object.keys(n.env as Record<string, unknown>) : []
    const ownEnv = (table.env ?? {}) as Record<string, string>
    if (env.some((k) => !(k in ownEnv))) out.env = { ...((out.env ?? {}) as Record<string, string>), ...Object.fromEntries(env.filter((k) => !(k in ownEnv)).map((k) => [k, ''])), ...ownEnv }
    if ('env_vars' in n && !('env_vars' in table)) out.env_vars = []
    log.warn(`Codex has an MCP server named hive in ${userText(file)}: Hive's own hive server is used instead, its keys over those of the same name (${Object.keys(n).join(', ')}).`)
  }
  return out
}

/** Codex's MCP servers in one config file ([mcp_servers.<name>]), as Hive's definitions. */
function mcpServersIn(file: string): Record<string, McpServerDef> {
  const servers = readToml(file).mcp_servers
  if (!servers || typeof servers !== 'object') return {}
  const out: Record<string, McpServerDef> = {}
  for (const [name, s] of Object.entries(servers as Record<string, any>)) {
    if (!s || typeof s !== 'object') continue
    const def: McpServerDef = {}
    if (typeof s.command === 'string') def.command = s.command
    if (Array.isArray(s.args)) def.args = s.args.map(String)
    if (s.env && typeof s.env === 'object') def.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)]))
    for (const k of Array.isArray(s.env_vars) ? s.env_vars : []) def.env = { ...def.env, [k]: `\${${k}}` }
    if (typeof s.url === 'string') def.url = s.url
    if (s.http_headers && typeof s.http_headers === 'object') def.headers = Object.fromEntries(Object.entries(s.http_headers).map(([k, v]) => [k, String(v)]))
    if (typeof s.bearer_token_env_var === 'string') def.headers = { ...def.headers, Authorization: `Bearer \${${s.bearer_token_env_var}}` }
    if (typeof s.cwd === 'string') def.cwd = s.cwd
    out[name] = def
  }
  return out
}

/** Session id from a rollout file name (rollout-<local time>-<uuid>.jsonl). */
const idFromFile = (f: string): string | null => /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f)?.[1] ?? null

export class CodexAdapter implements ProviderAdapter {
  readonly id = CODEX
  readonly descriptor = CODEX_DESCRIPTOR
  /** A parent Codex session's identity, when Hive runs inside one. User configuration (CODEX_HOME…) is kept. */
  readonly envToStrip = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI']
  readonly compactFailure = null
  // SessionStart only comes with the first prompt; the composer's placeholder means Codex is up. Both texts are
  // advanced settings (#367).
  get readyOutput(): RegExp {
    return advanced.pattern('codex.ready.placeholder')
  }
  // Before a folder's first session (in a Git repository): "Trust this folder? Codex can read, edit, and run files here…".
  get startupQuestion(): RegExp {
    return advanced.pattern('codex.trust.prompt')
  }
  // Ended as a person ends it at a lane's end (HI-1706): /quit, which 0.164.0 took and exited 0 on in 1.4 s.
  get quitLine(): { line: string; graceMs: number } {
    return { line: advanced.get<string>('codex.exit.command'), graceMs: advanced.number('codex.exit.graceSeconds') * 1000 }
  }
  readonly planToggleKey = '\x1b[Z'
  busyScreen(screen: string): boolean {
    return codexHoldsInput(screen)
  }

  startHint(text: string): StartHint | null {
    if (/\bmodel\b/i.test(text) && /not found|invalid|unknown|not supported|does not exist/i.test(text)) return { hint: tr(msg({ id: 'providers.codex.hint.model', defaultMessage: "Codex doesn't know this model: choose another in Agent Settings.", description: "Why Codex didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    // Hive's -c overrides and the user's own config.toml.
    if (/error loading config|config\.toml|error parsing -c|invalid value for|unknown variant|unexpected argument|unrecognized|for more information, try '--help'/i.test(text)) return { hint: tr(msg({ id: 'providers.codex.hint.settings', defaultMessage: 'Codex refused its settings: check Extra arguments in Agent Settings and Settings → Codex, and your config.toml.', description: "Why Codex didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-settings' }
    if (/not logged in|codex login|please (sign|log) in|unauthorized|401/i.test(text)) return { hint: tr(msg({ id: 'providers.codex.hint.signIn', defaultMessage: "Codex isn't signed in: sign in in Provider Setup, then start it again.", description: "Why Codex didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-setup' }
    if (/is not recognized|ENOENT|cannot find|sandbox/i.test(text)) return { hint: tr(msg({ id: 'providers.codex.hint.broken', defaultMessage: 'Codex looks broken or not set up: check it in Provider Setup.', description: "Why Codex didn't start, in the agent's pane, with a button that goes where it says. Agent Settings, Provider Setup and Settings → … are Hive's names: use them as shown." })), fix: 'agent-setup' }
    return null
  }
  /** Codex versions whose hook hashes Hive has checked against Codex itself: true = Hive's own hash matches. */
  private hashCheck = new Map<string, boolean>()
  /** Versions whose app server didn't answer this run (not asked again until Hive restarts). */
  private unreachable = new Set<string>()
  /** Rollout files by session id, and each file's session_meta (id, cwd, and whose sub-session it is), by file mtime. */
  private paths = new Map<string, string>()
  private metas = new Map<string, { id: string; cwd: string; sub: SubSession | null; mtime: number }>()
  private titles: { mtime: number; map: Map<string, string> } | null = null

  private async candidates(): Promise<{ path: string; source: string }[]> {
    const out: { path: string; source: string }[] = []
    const custom = providerSettings(config.settings, this.id).executablePath.trim()
    if (custom) out.push({ path: custom, source: 'settings' })
    const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], 5000)
    for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
    }
    if (process.platform === 'win32') {
      // The standalone installer adds this to the user PATH, which a Hive started before the install doesn't have yet.
      if (process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), source: 'standalone install' }) // i18n-ignore: an install's source as Hive names it, in diagnostics and the Agent API's status
      if (process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'codex.cmd'), source: 'npm' })
    } else out.push({ path: join(homedir(), '.local', 'bin', 'codex'), source: 'standalone install' }) // i18n-ignore: an install's source as Hive names it, in diagnostics and the Agent API's status
    return out
  }

  private async editorExtensionPresent(): Promise<boolean> {
    for (const root of EDITOR_ROOTS) {
      try {
        if ((await readdir(join(homedir(), root, 'extensions'))).some((d) => d.startsWith('openai.chatgpt-'))) return true
      } catch {
        // Editor not installed.
      }
    }
    return false
  }

  async locate(): Promise<AgentInstallInfo> {
    const info: AgentInstallInfo = { provider: this.id, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, rejected: [] }
    for (const c of await this.candidates()) {
      if (!existsSync(c.path)) continue
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
      Object.assign(info, { found: true, path: c.path, version: m[1], source: c.source })
      break
    }
    if (!info.found) info.editorExtensionOnly = await this.editorExtensionPresent()
    if (info.path) {
      const s = await run(info.path, ['login', 'status'], 10000)
      const text = `${s.stdout}\n${s.stderr}`
      if (/not logged in|logged out/i.test(text)) info.loggedIn = false
      else if (/logged in/i.test(text)) {
        info.loggedIn = true
        info.authMethod = /using (.+)/i.exec(text)?.[1]?.trim() ?? null
      }
    }
    return info
  }

  /**
   * The key for a line break in a prompt Hive types (HI-1327): Settings → Advanced's choice, if Codex takes it as one.
   * Automatic (the default): Alt+Enter on a Codex version it was tried on (NEWLINE_TRIED: the real-tier suite
   * codex-newline), a space on another or one not known, as before. A key chosen goes to any version.
   */
  typedNewline(version: string | null): TypedNewline | null {
    const chosen = advanced.get<string>(NEWLINE_KEY)
    const key = chosen === 'auto' ? (version && NEWLINE_TRIED.includes(version) ? 'alt-enter' : null) : chosen
    return this.descriptor.capabilities.typedNewlines?.find((k) => k === key) ?? null
  }

  /** Codex's Windows sandbox is set up once (windows.sandbox in its config); without it every command needs approval. */
  sandboxReady(): boolean {
    return !!this.sandboxKind()
  }

  /** Which Windows sandbox Codex has: its default (admin) one, the non-admin one ('unelevated'), or none. */
  private sandboxKind(): string | null {
    if (process.platform !== 'win32') return 'n/a'
    const w = userConfig().windows
    return typeof w?.sandbox === 'string' && w.sandbox ? w.sandbox : null
  }

  diagnostics(): string[] {
    const kind = this.sandboxKind()
    const named: Record<string, string> = { elevated: 'default (admin)', unelevated: 'non-admin', 'n/a': 'not used on this system' } // i18n-ignore: Copy Diagnostics' report (the design keeps diagnostics content English)
    return [`Windows sandbox: ${kind === null ? 'not set up' : (named[kind] ?? (/^[\w-]{1,24}$/.test(kind) ? kind : 'unknown'))}`] // i18n-ignore: Copy Diagnostics' report (the design keeps diagnostics content English)
  }

  configHome(): string {
    return codexHome()
  }

  readiness(info: AgentInstallInfo): ReadinessIssue[] {
    const name = this.descriptor.name
    if (!info.found) return [notInstalledIssue(name)]
    const out: ReadinessIssue[] = []
    const sandbox = this.sandboxKind()
    if (info.loggedIn === false) out.push(signedOutIssue(name))
    else if (!sandbox)
      out.push({
        id: 'sandbox',
        level: 'warning',
        message: installText(msg({ id: 'providers.codex.sandbox.needed', defaultMessage: 'Codex needs a one-time setup of its Windows sandbox; until then it asks before every command.', description: "Provider Setup and Settings → Providers: Codex's Windows sandbox isn't set up yet." })),
        action: { label: installText(msg({ id: 'providers.codex.sandbox.setUpAction', defaultMessage: 'Set up', description: "Provider Setup's button: opens Codex's sandbox setup in a terminal." })), task: 'setup' },
        detail: SANDBOX_CHOICE.map(installText)
      })
    else if (sandbox === 'unelevated') {
      out.push({
        id: 'sandbox-upgrade',
        level: 'info',
        message: installText(msg({ id: 'providers.codex.sandbox.nonAdminUsed', defaultMessage: 'Codex uses its non-admin sandbox.', description: 'Provider Setup and Settings → Providers: Codex runs commands in its non-admin sandbox (Windows), which can be upgraded.' })),
        action: { label: installText(msg({ id: 'providers.codex.sandbox.upgradeAction', defaultMessage: 'Upgrade', description: "Provider Setup's button: switches Codex to its default sandbox." })), task: 'setup' },
        detail: [installText(msg({ id: 'providers.codex.sandbox.upgrade', defaultMessage: '**Upgrade** switches Codex to its default sandbox, which runs commands under separate Windows accounts instead of your own. Windows asks for Administrator permission once. Codex agents that are running keep their sandbox until they restart.', description: "Provider Setup, under Codex's sandbox setup (Windows): what Upgrade does. **…** marks bold text: keep the marks." }))]
      })
    }
    // The Store's PowerShell 7 first on PATH, with the sandbox on: its commands fail while one is open (#585). Like the
    // sandbox's own items, once Codex is signed in.
    if (info.loggedIn !== false && sandbox && storePwshFirst()) out.push(storePwshIssue())
    if (info.updateAvailable) out.push(updateIssue(name, info.latestVersion))
    return out
  }

  async latestVersion(): Promise<string | null> {
    try {
      const reply = await plainHttpsJson('https://api.github.com/repos/openai/codex/releases/latest', { timeoutMs: 6000, headers: { Accept: 'application/vnd.github+json' } })
      const tag = (reply as { tag_name?: string }).tag_name ?? ''
      return /(\d+\.\d+\.\d+)/.exec(tag)?.[1] ?? null
    } catch {
      return null
    }
  }

  isNewer(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0
  }

  installCommand(): CommandSpec {
    if (process.platform === 'win32') {
      return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://chatgpt.com/codex/install.ps1 | iex'] } // i18n-ignore: a command run in a terminal
    }
    return { file: '/bin/bash', args: ['-lc', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'] } // i18n-ignore: a command run in a terminal
  }

  updateCommand(executable: string): CommandSpec {
    return { ...toSpawnable(executable, ['update']) }
  }

  loginCommand(executable: string): CommandSpec {
    return { ...toSpawnable(executable, ['login']) }
  }

  /** A connection's sign-in (HI-1757): Codex's own login, kept in the connection's folder. */
  accountLoginCommand(executable: string): CommandSpec {
    return { ...toSpawnable(executable, ['login', ...CONNECTION_STORE]) }
  }

  /** Who a connection's CODEX_HOME (in `env`) is signed in as: its app server's account answer, never a token. */
  async accountStatus(executable: string, env: NodeJS.ProcessEnv): Promise<ConnectionStatus> {
    const answer = await appServerAnswer(executable, launchConnectionArgs({ connectionHome: env.CODEX_HOME }), homedir(), advanced.get<string>('codex.accounts.readMethod'), {}, env, advanced.number('codex.accounts.statusSeconds') * 1000)
    return codexAccountStatus(answer, { account: advanced.get<string>('codex.accounts.accountField'), email: advanced.get<string>('codex.accounts.emailField'), plan: advanced.get<string>('codex.accounts.planField') })
  }

  /**
   * Its Windows sandbox set up for the folder (HI-1870), as its launches have it: the folder's own `windows.sandbox`,
   * or else the one launches pass on (launchConnectionArgs: this PC's, or the non-admin one). Nothing to set up off Windows.
   */
  async connectionSetUp(home: string): Promise<boolean | null> {
    if (process.platform !== 'win32') return true
    const own = configOf(home).windows?.sandbox
    return (typeof own === 'string' && !!own) || connectionSandboxArgs(home).length > 0
  }

  /** Its Set Up runs Codex as the connection's launches do (HI-1893): its login store and its sandbox. */
  connectionSetUpArgs(home: string): string[] {
    return launchConnectionArgs({ connectionHome: home })
  }

  /**
   * Its trust of each folder in the folder's config.toml (HI-1870), as Codex 0.164.0 looks it up: a `[projects.'<path>']`
   * with `trust_level = "trusted"` for the main repository root's real path, in any letter case (8.3 paths it expands).
   * It asks only in a Git repository, so a folder without Git needs none. Its own file only: launches pass no trust.
   */
  async connectionTrusts(home: string, targets: readonly TrustTarget[]): Promise<TrustReading[]> {
    // Each launch trusts its own folder (HI-1871: the Advanced switch, on by default): none of Hive's folders asks.
    if (advanced.get<boolean>('codex.trust.perLaunch')) return targets.map(() => true)
    let projects: Record<string, unknown>
    try {
      const t = parseToml(await readFile(join(home, 'config.toml'), 'utf8')) as Record<string, unknown>
      projects = t.projects && typeof t.projects === 'object' ? (t.projects as Record<string, unknown>) : {}
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return targets.map(() => null)
      projects = {}
    }
    const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    // Each entry's trust level, by its path as Codex compares it (get_active_project: the cwd's entry, then the main
    // root's; source pinned at 6aaac69).
    const levels = new Map(Object.entries(projects).map(([k, v]) => [norm(k), (v as Record<string, unknown> | null)?.trust_level]))
    return targets.map((t): TrustReading => {
      if (!t.git) return true
      // The project's own folder's entry first (a worktree project's own, say): it decides, and is where to ask.
      if (t.folder && levels.has(norm(t.folder))) return levels.get(norm(t.folder)) === 'trusted' ? true : { at: t.folder }
      return t.root ? levels.get(norm(t.root)) === 'trusted' : null
    })
  }

  accountSharedTarget(name: string): string {
    return join(codexHome(), name)
  }

  accountLoginFile(name: string): boolean {
    return advanced.pattern('codex.accounts.loginFiles').test(name)
  }

  /** What Codex reads as a login from its environment (HI-1757: CODEX_ACCESS_TOKEN): left out on a connection. */
  accountEnvDrop(): readonly string[] {
    return advanced.get<string[]>('codex.accounts.dropEnv')
  }

  /** Whether a connection's folder is held by a check of Codex not yet confirmed ended (codexChecks.ts). */
  accountHeld(home: string): boolean {
    return codexCheckHeld(home)
  }

  /**
   * The Windows sandbox setup is Codex's own prompt (the admin sandbox, or the non-admin one). Hive opens
   * Codex read-only in a folder of its own, trusted for this run only. With no sandbox yet, choosing "Ask for
   * approval" in /permissions brings up the prompt; /setup-default-sandbox only exists once the non-admin
   * sandbox is on (it upgrades that to the admin one).
   */
  setupCommand(executable: string): CommandSpec {
    const dir = join(tmpdir(), 'hive-codex-setup')
    mkdirSync(dir, { recursive: true })
    // The title items are pinned as for sessions: the busy wait below reads the spinner a user's own [tui].terminal_title could drop.
    const s = toSpawnable(executable, ['--no-daemon', '-C', dir, '-c', `projects=${toToml({ [dir]: { trust_level: 'trusted' } })}`, '-c', `tui.terminal_title=${toToml(titleItems())}`, ...CODEX_MODE_FLAGS['read-only']])
    const before = this.sandboxKind()
    const keys = before === 'unelevated'
      ? [{ keys: '/setup-default-sandbox', waitMs: 300 }, { keys: '\r', heldOn: (screen: string) => inputHolds(screen, '/setup-default-sandbox') }]
      : this.modeMenuKeys('ask')
    // Codex stays open once the sandbox is set up: the task is done when its config names a new sandbox.
    const done = (): boolean => {
      const now = this.sandboxKind()
      return !!now && now !== before
    }
    // Codex puts a spinner in its window title while it works (also as it starts up, once it has loaded).
    return { ...s, keys, readyPattern: CODEX_LOADED, busyTitle: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, busyScreen: codexHoldsInput, done }
  }

  /** Codex's model catalog (codex debug models, models.ts): the listed models in Codex's order, with their efforts. */
  async listModels(executable: string, env: Record<string, string>): Promise<CatalogRead | null> {
    const r = await run(executable, ['debug', 'models'], 30000, env)
    return r.code === 0 ? parseCodexModels(r.stdout) : null
  }

  /** "model" in Codex's own config.toml (~/.codex's, or a connection's: HI-1757). */
  configuredDefaultModel(home?: string): string | null {
    const m = configOf(home).model
    return typeof m === 'string' && m.trim() ? m.trim() : null
  }

  /** model_reasoning_effort in Codex's own config.toml, which every model then uses unless Hive passes one. */
  configuredDefaultEffort(): string | null {
    const e = userConfig().model_reasoning_effort
    return typeof e === 'string' && e.trim() ? e.trim() : null
  }

  ownsModel(model: string): boolean {
    return /^(gpt-|o\d|codex)/i.test(model)
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  /** Hook hashes to trust for this launch: Hive's own, unless this Codex version hashes differently (then Codex's). */
  private hashesByRun = new Map<string, Record<string, string> | undefined>()

  /** Codex has no per-launch skills folder: Hive's copies go in the project's .agents/skills (syncAgentsSkills). */
  skillCopyPath(ctx: LaunchContext, skill: string): string {
    return agentsSkillCopyPath(ctx.cwd, skill)
  }

  async prepareLaunch(ctx: LaunchContext): Promise<Record<string, SkillDelivery>> {
    const delivered = await syncAgentsSkills(ctx, this.descriptor.name)
    await this.checkHookHashes(ctx)
    // The developer_instructions Codex would give this session, for Hive's guidance to follow (#1285): asked at each
    // launch Hive adds some to, with its own arguments, folder and environment (no cache: only Codex knows what they
    // depend on). Unreadable, buildCommand never puts anything in their place (developerOverride).
    if ([ctx.guidance, ctx.instructions, ctx.notes].some((t) => t && t.trim())) {
      const theirs = await developerInstructionsFromCodex(ctx.executable, ctx.cwd, [...launchConnectionArgs(ctx), ...ctx.extraArgs], ctx.env)
      if (theirs === null) log.warn("Codex couldn't render the session's prompt to say which developer_instructions apply; Hive leaves them as they are")
      keepBounded(this.developerByRun, ctx.runId, theirs)
    }
    return delivered
  }

  /**
   * What Codex said each launch's developer_instructions are (prepareLaunch): the text, or null when it couldn't say;
   * taken by buildCommand. A launch stopped before its command is built leaves its entry, so only the latest few are kept.
   */
  private developerByRun = new Map<string, string | null>()

  /** Launches whose developer_instructions Codex couldn't say (buildCommand), for their notice (launchNotice). */
  private developerUnread = new Map<string, 'agent' | 'assistant'>()

  /**
   * The launch's developer_instructions, or null for none of Hive's (#1285, #966 row 13; the Assistant's decisions on
   * it): Hive's guidance and the Assistant's role after those Codex gives the session (prepareLaunch), never in their
   * place, then the Workspace notes note (#1433). Codex unable to say: an agent's left as they are, with no guidance or
   * notes of Hive's, and the Assistant's role alone with its notes (without it there is no Assistant), each told once
   * (launchNotice). Hive never writes Codex's config.
   */
  private developerOverride(ctx: LaunchContext): string | null {
    const guidance = ctx.guidance?.trim() ?? ''
    const role = ctx.instructions?.trim() ?? ''
    const notes = ctx.notes?.trim() ?? ''
    const theirs = this.developerByRun.get(ctx.runId)
    this.developerByRun.delete(ctx.runId)
    if (!guidance && !role && !notes) return null
    if (typeof theirs === 'string') return [theirs, guidance, role, notes].filter(Boolean).join('\n\n')
    keepBounded(this.developerUnread, ctx.runId, role ? 'assistant' : 'agent')
    return role ? [role, notes].filter(Boolean).join('\n\n') : null
  }

  launchNotice(ctx: LaunchContext): { title: string; message: string } | null {
    const unread = this.developerUnread.get(ctx.runId)
    this.developerUnread.delete(ctx.runId)
    if (unread === 'assistant')
      return {
        title: tr(msg({ id: 'providers.codex.developerUnread.assistantTitle', defaultMessage: 'The Assistant started with its role only', description: "A notice as the Hive Assistant starts on Codex: Hive couldn't tell which of the user's own Codex instructions apply, so it gives the Assistant only its role." })),
        message: tr(msg({ id: 'providers.codex.developerUnread.assistantMessage', defaultMessage: "Codex couldn't say which developer_instructions this session gets, so Hive gives the Assistant its role alone this time, without them or Hive's guidance. Restart the Assistant to try again.", description: 'The notice that the Hive Assistant on Codex got only its role. developer_instructions is a Codex setting: keep it.' }))
      }
    if (unread === 'agent')
      return {
        title: tr(msg({ id: 'providers.codex.developerUnread.agentTitle', defaultMessage: "Hive's guidance is missing for this agent", description: "A notice as a Codex agent starts: Hive couldn't tell which of the user's own Codex instructions apply, so it added none of its guidance." })),
        message: tr(msg({ id: 'providers.codex.developerUnread.agentMessage', defaultMessage: "Codex couldn't say which developer_instructions this session gets, so Hive leaves yours as they are and adds none of its guidance this time: the agent has Hive's tools without it. Restart the agent to try again.", description: "The notice that a Codex agent started without Hive's guidance. developer_instructions is a Codex setting: keep it." }))
      }
    return null
  }

  /** Which hook hashes to trust for this launch (hashesByRun): Hive's own, unless this Codex version hashes differently. */
  private async checkHookHashes(ctx: LaunchContext): Promise<void> {
    // In the launch's own environment, with its connection's overrides (HI-1757 round 1): its CODEX_HOME, never Hive's.
    const version = (await run(ctx.executable, ['--version'], 10000, ctx.env)).stdout.match(/(\d+\.\d+\.\d+[\w.-]*)/)?.[1] ?? 'unknown'
    // Hooks only (without the trust records), to ask Codex what it calls and hashes them.
    const hooksOnly = [...launchConnectionArgs(ctx), ...hookOverrides(ctx.hookUrl, ctx.hookAuthFile).slice(0, -2)]
    const known = this.hashCheck.get(version)
    if (known === true) return
    if (this.unreachable.has(version)) return
    const theirs = await hooksFromCodex(ctx.executable, hooksOnly, ctx.cwd, ctx.env)
    // Codex couldn't be asked: Hive's own hashes are the best guess. Don't wait for it again this run.
    if (!theirs) {
      this.unreachable.add(version)
      log.warn(`Codex ${version}: couldn't check hook hashes with its app server; using Hive's`)
      return
    }
    if (known === undefined) {
      const command = hookCommand(ctx.hookUrl, ctx.hookAuthFile)
      const same = HOOKS.every((h) => theirs[`${SESSION_FLAGS}:${h.label}:0:0`] === hookHash(h.label, h.matcher, command, hookTimeout(h.wait)))
      this.hashCheck.set(version, same)
      if (same) return
      log.warn(`Codex ${version} hashes hooks differently from Hive; Hive asks Codex for the hashes on each launch`)
    }
    this.hashesByRun.set(ctx.runId, theirs)
  }

  folderWarning(folder: string): { title: string; message: string } | null {
    return strayCodexWarning(folder)
  }

  buildCommand(executable: string, ctx: LaunchContext): CommandSpec {
    const args: string[] = []
    if (ctx.resume && ctx.sessionId) args.push('resume', ctx.sessionId)
    // Options come after "resume <id>": before it, Codex ignores them.
    args.push('--no-daemon')
    args.push(...hookOverrides(ctx.hookUrl, ctx.hookAuthFile, this.hashesByRun.get(ctx.runId)))
    this.hashesByRun.delete(ctx.runId)
    // Switched off (#1167), the user's own [tui].terminal_title applies, and titleAttention reads nothing from it.
    if (launchOverrides(ctx.overrides, CODEX, 'terminalTitle')) args.push('-c', `tui.terminal_title=${toToml(titleItems())}`)
    if (ctx.model) args.push('-m', ctx.model)
    if (ctx.effort) args.push('-c', `model_reasoning_effort=${toToml(ctx.effort)}`)
    args.push(...(CODEX_MODE_FLAGS[ctx.permissionMode ?? ''] ?? CODEX_MODE_FLAGS[CODEX_DESCRIPTOR.defaultPermissionMode]))
    // Folders it may also write in (#1439: a reviewer's review copies). --add-dir adds them to the writable roots of the
    // user's own config; a -c sandbox_workspace_write.writable_roots would replace those (0.163.0: the fixture
    // writable-roots-codex-0.163.0.json in tests/fixtures/advanced).
    for (const d of ctx.extraDirs ?? []) args.push('--add-dir', d)
    // On a connection (HI-1757): its login kept in its own folder, and the Windows sandbox this PC has (set up once, in
    // ~/.codex's config: its accounts are the machine's), unless the connection's own config names one.
    args.push(...launchConnectionArgs(ctx))
    // Its own folder trusted for this launch (HI-1871, Darren 27 Oct: on by default, an Advanced off switch): Codex
    // looks its cwd up first, so it never asks in Hive's folders. The table merges into the home's own for this launch
    // (config overrides.rs, merge.rs at 6aaac69) and nothing is written.
    if (advanced.get<boolean>('codex.trust.perLaunch')) args.push('-c', `projects=${toToml({ [ctx.cwd]: { trust_level: 'trusted' } })}`)
    const files = [join(ctx.connectionHome ?? codexHome(), 'config.toml'), join(ctx.cwd, '.codex', 'config.toml')]
    const developer = this.developerOverride(ctx)
    const hive = { preApprove: launchOverrides(ctx.overrides, CODEX, 'preApproveHiveTools'), trusted: ctx.trustedHiveTools }
    for (const [name, def] of Object.entries(ctx.mcpServers)) {
      const { table, warning } = codexMcpServer(name, def, hive)
      if (warning) log.warn(warning)
      if (!table) continue
      if (name === 'hive') Object.assign(table, outrankNativeHive(files, table, hive.preApprove ? (hive.trusted ?? 'all') : [], ctx.cwd))
      args.push('-c', `mcp_servers.${name}=${toToml(table)}`)
    }
    // Only the workspace's MCP servers: the user's own (and a project's own) are turned off, as for Claude Code; with the
    // switch off (#1281), they load beside Hive's (one of the workspace's name still merges into the workspace's).
    if (launchOverrides(ctx.overrides, CODEX, 'mcpIsolation')) {
      const own = new Set(Object.keys(ctx.mcpServers))
      const theirs = new Set(files.flatMap((f) => Object.keys(mcpServersIn(f))))
      for (const name of theirs) {
        if (own.has(name)) continue
        if (/^[A-Za-z0-9_-]+$/.test(name)) args.push('-c', `mcp_servers.${name}.enabled=false`)
        else log.warn(`Codex MCP server ${userText(name)} can't be turned off for Hive sessions (its name needs quoting).`)
      }
    }
    args.push(...ctx.extraArgs)
    // After the user's own arguments, so it is the one Codex keeps: their own -c developer_instructions is already in it.
    if (developer !== null) args.push('-c', `developer_instructions=${toToml(developer)}`)
    // Its config overrides, for asking Codex which hooks the launch has (HI-982: launchHooks).
    keepBounded(this.configByRun, ctx.runId, hookQueryArgs(args))
    // Codex takes a first prompt as its last argument (after "resume <id>" too) and starts on it.
    if (ctx.initialPrompt) args.push(...taskArgs(executable, ctx.initialPrompt))
    const s = toSpawnable(executable, args)
    return { file: s.file, args: s.args, env: ctx.env }
  }

  /** Each launch's config overrides as buildCommand gave them (HI-982), until launchHooks takes them. */
  private configByRun = new Map<string, string[]>()

  /**
   * The launch's hooks (HI-982): Hive's as passed (the -c hooks.<event> of hookOverrides), and every hook Codex itself
   * lists for the launch, asked when the dialog opens (its app server's hooks/list, in the launch's environment and
   * folder, with the launch's config overrides only: never its other arguments), each with Codex's trust. Hive's are
   * those of the session flags running exactly Hive's command, with Codex's trust; Codex unable to say, they are as
   * passed and the rest unknown.
   */
  launchHooks(ctx: LaunchContext): LaunchHooks {
    const overrides = this.configByRun.get(ctx.runId) ?? []
    this.configByRun.delete(ctx.runId)
    const command = hookCommand(ctx.hookUrl, ctx.hookAuthFile)
    const secrets = [ctx.hookAuthFile, ctx.env.HIVE_HOOK_TOKEN ?? '']
    const hive: HookRow[] = HOOKS.map((h) => ({ event: h.event, source: 'hive', type: 'command', command: withoutHiveAuth(command, secrets), ...(h.matcher ? { matcher: h.matcher } : {}), status: 'passed', observed: true }))
    const listing: HookListing = { basis: 'cli', rows: hive, notes: [] }
    return {
      listing,
      receivers: Object.fromEntries(HOOKS.map((h) => [h.event, 'command'])),
      now: async () => {
        const answer = await appServerAnswer(ctx.executable, overrides, ctx.cwd, advanced.get<string>('codex.hooks.listMethod'), { cwds: [ctx.cwd] }, ctx.env, advanced.number('codex.hooks.listSeconds') * 1000)
        if (!answer.ok) return { ...listing, notes: [{ kind: 'cliUnknown', why: answer.error.slice(0, 300) }] }
        const all = ((answer.result as { data?: { hooks?: unknown[] }[] } | null)?.data ?? []).flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []))
        const got = codexListedHooks(all as never[], { command, flagsFile: SESSION_FLAGS }, secrets)
        // Hive's as passed while Codex trusts them; else as Codex has them, or unknown where it doesn't list them (a later
        // -c of the user's own for that event replaced Hive's).
        const rows = hive.map((r): HookRow => {
          const trust = got.hiveTrust.get(r.event) ?? 'unknown'
          return { ...r, status: trust === 'trusted' ? 'passed' : trust }
        })
        return { basis: 'cli', rows: [...rows, ...got.rows], notes: got.more ? [{ kind: 'more', source: 'other', count: got.more }] : [] }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hooks and live details
  // -------------------------------------------------------------------------

  normalizeHook(body: Record<string, any>): NormalizedHook {
    const event = String(body.hook_event_name ?? '')
    const out: NormalizedHook = {
      event: { kind: 'ignore' },
      sessionId: typeof body.session_id === 'string' ? body.session_id : null,
      transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : null,
      // Codex's permission_mode doesn't follow its presets or Plan mode; the rollout says (transcriptDetails).
      mode: null,
      editedPaths: [],
      // Its turn (turn_id, kept through a Stop hook's continuation) and the call (tool_use_id), as 0.162.1 sends them.
      ids: hookIds(body, { turn: 'turn_id', call: 'tool_use_id' })
    }
    const tool = String(body.tool_name ?? '')
    const input = body.tool_input ?? {}
    switch (event) {
      case 'SessionStart':
        out.event = { kind: 'start', source: typeof body.source === 'string' ? body.source : null }
        break
      case 'UserPromptSubmit':
        // An answer to its question (request_user_input) comes as a prompt with a tag before it: the answer is the text.
        out.event = { kind: 'prompt', text: typeof body.prompt === 'string' ? body.prompt.replace(/^<send_user_message_question_reply>/, '') : null }
        break
      case 'PreToolUse':
        if (tool === 'request_user_input' || tool === 'request_user_input_async') {
          // The async one returns at once and Codex carries on; the answer comes later as a prompt.
          const q = Array.isArray(input.questions) ? input.questions[0] : null
          out.event = { kind: 'ask', ask: { kind: 'question', blocking: tool === 'request_user_input', message: String(q?.question ?? q?.title ?? ''), call: toolCall(tool, input) } }
        } else {
          out.event = { kind: 'toolStart' }
          if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') out.editedPaths = patchPaths(String(input.command ?? input.patch ?? ''))
        }
        break
      case 'PostToolUse':
        out.event = { kind: 'toolEnd', call: toolCall(tool, input) }
        break
      case 'PermissionRequest': {
        const line = String(input.command ?? '').split('\n')[0]
        const what = tool === 'apply_patch' ? `edit ${patchPaths(String(input.command ?? '')).join(', ')}` : tool === 'Bash' ? `run ${line.length > 120 ? `${line.slice(0, 119)}…` : line}` : tool ? `use ${tool}` : 'continue' // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
        // Sent before anyone answers it: in Approve for me, Codex's auto-reviewer does (ModeOption.reviewed).
        out.event = { kind: 'ask', ask: { kind: 'permission', blocking: true, message: `Codex asks to ${what}`, call: toolCall(tool, input) } } // i18n-ignore: a status message in the CLI's place, which agents read (GET /v1/projects)
        break
      }
      case 'Stop':
        out.event = { kind: 'stop', lastMessage: typeof body.last_assistant_message === 'string' ? body.last_assistant_message : null }
        break
      case 'Interrupt':
        out.event = { kind: 'interrupt' }
        break
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
   * Notices (0.162.1, #645's live rerun): after a tool call as context, which reaches the model as a developer message;
   * at Stop as a block, whose reason carries the same turn on as a user-role hook prompt. Fixed text only: developer
   * messages are trusted.
   */
  noticeReply(event: string, text: string): Record<string, unknown> | null {
    if (!text) return null
    if (event === 'PostToolUse') return { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
    if (event === 'Stop') return { decision: 'block', reason: text }
    return null
  }

  /**
   * SessionStart's context (0.163.0, #1065's probe: tests/fixtures/sessionstart-codex-0.163.0.json): reaches the model
   * whole (8 KB tried) at the first prompt (source startup), on resuming and after each compaction (source compact).
   */
  startContextReply(text: string): Record<string, unknown> {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }
  }

  /** A Stop blocked carries the turn on, its reason as a new prompt (Codex's hooks reference; 0.162.1, #645's spike). */
  stopContinues(reply: Record<string, any>): boolean {
    return reply.decision === 'block'
  }

  /** What Codex's screen shows of its turn (codexTurnScreen), for the versions it was checked with (#648). */
  turnScreen(version: string | null): ((screen: string) => 'idle' | 'working' | null) | null {
    if (!version || compareVersions(version, TURN_SCREEN_SINCE) < 0) return null
    return codexTurnScreen
  }

  /** Codex waiting to retry its model request (HI-1972): its log database's newest record of it (retryLog.ts). */
  retryWait(q: { sessionId: string; env: NodeJS.ProcessEnv; since: number }): Promise<RetryWait | null> {
    return codexRetryWait(q)
  }

  retryLookAfterMs(): number {
    return advanced.number('codex.retry.checkAfterSeconds') * 1000
  }

  /**
   * Codex titles its terminal "[ ! ] Action Required | <project>" (blinking with "[ . ]") exactly while a person
   * must act (an approval prompt, a question), and not while its auto-reviewer decides. Older versions than the one
   * Hive was tested with go by the hooks, as do sessions whose title Hive leaves to the user's config (#1167).
   */
  titleAttention(version: string | null, ctx?: Pick<LaunchContext, 'overrides'>): ((title: string) => boolean) | null {
    if (!version || compareVersions(version, ACTION_REQUIRED_SINCE) < 0 || !launchOverrides(ctx?.overrides, CODEX, 'terminalTitle')) return null
    return (title) => /^\[ [!.] \] Action Required\b/.test(title)
  }

  transcriptDetails(appended: string): LiveDetails {
    return rolloutDetails(appended)
  }

  backgroundTasks(appended: string, memo: Record<string, unknown>): BackgroundTaskEvent[] {
    return codexBackgroundTasks(appended, (memo.codex ??= codexBackgroundMemo()) as CodexBackgroundMemo)
  }

  safeguards(appended: string, memo: Record<string, unknown>): SafeguardEvent[] {
    return codexSafeguards(appended, memo)
  }

  /** Turns by turn_id (as its hooks carry it), #1371. */
  transcriptTurns(appended: string, memo: Record<string, unknown>): TranscriptTurn[] {
    return codexTranscriptTurns(appended, memo)
  }

  readonly turnsJoin = 'id'

  /**
   * Codex's /permissions menu numbers its presets, and typing a number picks one (arrow keys wrap around, so counting
   * presses is unreliable). Which number is read from the menu Codex draws, by the preset's label: Codex 0.161 reordered
   * the menu (#396, permissionsMenu.ts), and a label it doesn't show fails the pick rather than choosing another preset.
   * Hive confirms the result from the rollout's thread_settings_applied, which Codex writes at once.
   */
  modeMenuKeys(target: PermissionMode): KeySteps {
    return [
      { keys: '\x15', waitMs: 150 },
      { keys: '/permissions', waitMs: 200 },
      // Enter again while Codex's input still holds the command, once it is free (#363); never a second /permissions.
      { keys: '\r', waitMs: 200, heldOn: (screen) => inputHolds(screen, '/permissions') },
      { pick: (screen) => permissionsMenuNumber(screen, target), what: `"${permissionsMenuLabel(target) ?? target}" in Codex's /permissions menu`, waitMs: 300 } // i18n-ignore: the CLI's menu item, quoted in callers' messages (PickNotFound's `what`)
    ]
  }

  /** Codex prints "Permission selection requested: <preset>" as soon as a preset is picked. */
  modeFromOutput(tail: string): PermissionMode | null {
    const m = [...tail.matchAll(/Permission selection requested: (Read Only|Ask for approval|Approve for me|Full Access)/gi)].pop()
    if (!m) return null
    const said = m[1].toLowerCase()
    return CODEX_PERMISSION_MODES.find((x) => x.label.toLowerCase() === said || (said === 'full access' && x.value === 'full-access') || (said === 'read only' && x.value === 'read-only'))?.value ?? null
  }

  /** Codex's warning before Full Access ("Enable full access?"), unless its config hides it: the user answers it. */
  modeConfirmScreen(screen: string): boolean {
    return advanced.pattern('codex.fullAccess.warning').test(screen)
  }

  modeConfirmWait(): { appearMs: number; answerMs: number } {
    return { appearMs: advanced.get<number>('codex.fullAccess.warningAfterSeconds') * 1000, answerMs: advanced.get<number>('codex.fullAccess.answerSeconds') * 1000 }
  }

  canSwitchLive(): boolean {
    return true
  }

  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------

  /** The rollout list, reused for a few seconds: a session list asks for it once per project and session. */
  private rolloutList: { at: number; home: string; list: Promise<string[]> } | null = null
  /** Sessions looked for and not found, so a deleted rollout doesn't mean walking every rollout again each time. */
  private misses = new Map<string, number>()

  private rollouts(): Promise<string[]> {
    const home = codexHome()
    if (this.rolloutList && this.rolloutList.home === home && Date.now() - this.rolloutList.at < 10_000) return this.rolloutList.list
    const list = this.walkRollouts()
    this.rolloutList = { at: Date.now(), home, list }
    return list
  }

  private async walkRollouts(): Promise<string[]> {
    const root = join(codexHome(), 'sessions')
    const out: string[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: import('original-fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p)
      }
    }
    await walk(root, 0)
    return out
  }

  /** The session_meta of a rollout (id, cwd), cached by path and modification time. */
  private async meta(path: string): Promise<{ id: string; cwd: string; sub: SubSession | null } | null> {
    try {
      const s = await stat(path)
      const c = this.metas.get(path)
      if (c && c.mtime === s.mtimeMs) return c
      const r = JSON.parse(await readFirstLine(path))
      const p = r?.payload ?? {}
      if (r?.type !== 'session_meta' || typeof p.cwd !== 'string') return null
      const m = { id: String(p.id ?? p.session_id ?? idFromFile(path) ?? ''), cwd: p.cwd, sub: rolloutSubSession(p), mtime: s.mtimeMs }
      this.metas.set(path, m)
      return m
    } catch {
      return null
    }
  }

  async transcriptPath(_folder: string, sessionId: string, recorded?: string): Promise<string | null> {
    assertSessionId(sessionId)
    // Checked off main's thread: a session list asks for each of a project's hundreds of sessions (#1649).
    if (recorded && (await isFile(recorded))) return recorded
    const cached = this.paths.get(sessionId)
    if (cached && (await isFile(cached))) return cached
    if (Date.now() - (this.misses.get(sessionId) ?? 0) < 60_000) return null
    for (const p of await this.rollouts()) {
      const id = idFromFile(p)
      if (id) this.paths.set(id, p)
    }
    const found = this.paths.get(sessionId)
    if (found && existsSync(found)) {
      this.misses.delete(sessionId)
      return found
    }
    this.misses.set(sessionId, Date.now())
    return null
  }

  /** Codex finds a session by the path it first wrote it to, so a backup only restores there. */
  restorePath(_folder: string, _sessionId: string, recorded?: string): string | null {
    return recorded ?? null
  }

  /** The rollouts' sessions (each one's session_meta), read once per rollout list: see rolloutSessions(). */
  private rolloutSessionList: { list: Promise<string[]>; sessions: Promise<RolloutSession[]> } | null = null

  /**
   * Every rollout's session, read once per rollout list (#1646): a session list asks for each folder a project's
   * sessions ran in (its slots and worktrees), and looking at every rollout once per folder took a second on 1,100
   * rollouts and eight folders. A rollout's session_meta (its first line) never changes once written, so one read before
   * isn't looked at again (HI-1681): only a new rollout is opened, and none is stat'd here.
   */
  private rolloutSessions(): Promise<RolloutSession[]> {
    const list = this.rollouts()
    if (this.rolloutSessionList?.list === list) return this.rolloutSessionList.sessions
    const sessions = (async () => {
      const out: RolloutSession[] = []
      for (const p of await list) {
        const m = this.metas.get(p) ?? (await this.meta(p))
        if (m && isSessionId(m.id)) out.push({ id: m.id, cwd: m.cwd, path: p, sub: m.sub })
      }
      return out
    })()
    this.rolloutSessionList = { list, sessions }
    return sessions
  }

  async listSessions(folder: string, skip?: (id: string) => boolean): Promise<ExternalSession[]> {
    // Codex records the cwd as it was given; Hive may spell the folder another way now (a junction, an 8.3 name, #493).
    const here = placeMatcher(folder)
    const mine = (await this.rolloutSessions()).filter((s) => here(s.cwd) && !skip?.(s.id))
    // Only the folder's sessions the caller doesn't have are stat'd (HI-1681), a few at once.
    const found = await atMost(LIST_AT_ONCE, mine, async (s): Promise<ExternalSession | null> => {
      const st = await stat(s.path).catch(() => null)
      return st && st.size > 0 ? { id: s.id, transcriptPath: s.path, modified: st.mtime.toISOString(), bytes: st.size, mtimeMs: st.mtimeMs, ...(s.sub ? { sub: s.sub } : {}) } : null
    })
    return found.filter((x): x is ExternalSession => !!x)
  }

  async subSessionOf(path: string): Promise<SubSession | null> {
    // Its session_meta never changes once written (HI-1681): one read before is the answer.
    return (this.metas.get(path) ?? (await this.meta(path)))?.sub ?? null
  }

  /** Session names from Codex's session_index.jsonl ({id, thread_name}). */
  usageTitle(sessionId: string): string | null {
    return this.title(sessionId)
  }

  private title(sessionId: string): string | null {
    const file = join(codexHome(), 'session_index.jsonl')
    try {
      const m = statSync(file).mtimeMs
      if (!this.titles || this.titles.mtime !== m) {
        const map = new Map<string, string>()
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          try {
            const r = JSON.parse(line)
            if (typeof r.id === 'string' && typeof r.thread_name === 'string') map.set(r.id, r.thread_name)
          } catch {
            // skip
          }
        }
        this.titles = { mtime: m, map }
      }
      return this.titles.map.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  parseUsage(text: string, sessionId: string) {
    return parseRollout(text, sessionId, this.title(sessionId))
  }

  usageParser(sessionId: string): UsageParser {
    const p = new CodexUsageParser(sessionId)
    // The title is Codex's own (its session index), which can change as the rollout grows.
    return { feed: (text) => p.feed(text), result: () => p.result(this.title(sessionId)) }
  }

  conversationParser(projectPath: string): CodexConversationParser {
    return new CodexConversationParser(projectPath)
  }

  imageData = codexImageData

  exportSubtitle(sessionId: string, project: string): string {
    return exportSubtitleText(this.descriptor.name, sessionId, project)
  }

  // -------------------------------------------------------------------------
  // Project files
  // -------------------------------------------------------------------------

  async memorySources(projectPath: string, homes?: readonly { id: string; name: string; home: string }[]): Promise<MemorySource[]> {
    const p = this.id
    // The user's own file: each connection's on in the workspace (HI-1757: each is its own home), else ~/.codex's.
    const users: MemorySource[] = homes
      ? homes.map((h) => ({ provider: p, id: `user:${h.id}`, label: connectionMemoryLabel('AGENTS.md', h.name), path: join(h.home, 'AGENTS.md'), kind: 'claude-md', exists: false })) // i18n-ignore: a file's name
      : [{ provider: p, id: 'user', label: userMemoryLabel('AGENTS.md'), path: join(codexHome(), 'AGENTS.md'), kind: 'claude-md', exists: false }] // i18n-ignore: a file's name
    const sources: MemorySource[] = [{ provider: p, id: 'project', label: 'AGENTS.md', path: join(projectPath, 'AGENTS.md'), kind: 'claude-md', exists: false }, ...users] // i18n-ignore: a file's name
    for (const s of sources) s.exists = existsSync(s.path)
    return sources
  }

  /** In Codex's folder (or a connection's), only the user AGENTS.md (editable) and skills (read-only). Never credentials or config. */
  fileAllowed(path: string, write: boolean, homes?: readonly string[]): boolean {
    return (homes ?? [codexHome()]).some((h) => codexFileAllowed(path, write, h))
  }

  skillRoots(home = codexHome()): SkillRoots {
    return { machine: [join(home, 'skills')], plugins: null, local: [AGENTS_SKILLS], hiveCopyPrefix: 'hive-' }
  }

  async projectMcpServers(projectPath: string): Promise<Record<string, McpServerDef>> {
    return mcpServersIn(join(projectPath, '.codex', 'config.toml'))
  }
}

export const codex = new CodexAdapter()
