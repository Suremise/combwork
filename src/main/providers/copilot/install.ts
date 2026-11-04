import { homedir } from 'os'
import { msg } from '../../../shared/i18n'
import { join } from 'path'
import { existsSync } from 'original-fs'
import { readFile } from 'original-fs/promises'
import type { AgentInstallInfo, ReadinessIssue } from '../../../shared/types'
import { COPILOT, COPILOT_DESCRIPTOR } from '../../../shared/copilot'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { createLogger, userText } from '../../logger'
import { plainHttpsJson } from '../../plainHttpsJson'
import { listOf } from '../../../shared/advanced'
import { EDITOR_EXTENSION_PATH, installText, notInstalledIssue, run, signedOutIssue, toSpawnable, updateIssue } from '../common'
import type { CommandSpec, UpdateRetry } from '../types'
import { COPILOT_ENV_STRIP, copilotEnv, copilotHome, stripsTokens } from './home'

// The GitHub Copilot CLI's installation and sign-in, for Provider Setup (#452, from the #403 spike on CLI 1.0.93). The
// adapter delegates locate, readiness and the install, update and sign-in tasks here.

const log = createLogger('providers')
const ID = COPILOT
const NAME = COPILOT_DESCRIPTOR.name
/** The WinGet package, which puts copilot.exe in WinGet's Links folder. */
const WINGET_ID = 'GitHub.Copilot'
const NPM_PACKAGE = '@github/copilot'
/** The CLI can't say which plan an account has, so Provider Setup always says it. */
export const COPILOT_PLAN_NOTE = msg({ id: 'providers.copilot.planNote', defaultMessage: 'Copilot Free uses Auto only; choosing a model needs a paid plan.', description: "A note in Provider Setup under GitHub Copilot. Copilot Free is the plan's name; Auto is Copilot's model choice: keep both names." })

/** How Copilot agents are signed in: a token in their environment, Copilot's own login, or the GitHub CLI's (gh). */
export type CopilotSignInSource = 'token' | 'stored' | 'gh'

export interface CopilotSignIn {
  loggedIn: boolean | null
  source: CopilotSignInSource | null
  /** The GitHub account, when known (a token's isn't: Hive never reads one). */
  account: string | null
  /** The token variable in use (source 'token'). */
  variable: string | null
}

/** What `gh auth status --json hosts` says of the active github.com account (the fields Hive reads; it never asks for the token). */
export interface GhStatus {
  login: string | null
  ok: boolean
}

/**
 * Which sign-in Copilot agents get, in the CLI's own order (`copilot login --help`, 1.0.93): a token in the
 * environment (COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN), else a stored login (`loggedInUsers` in its config.json),
 * else the GitHub CLI's login, which it asks `gh auth token` for. `env` is the environment agents get (Hive leaves
 * GH_TOKEN and GITHUB_TOKEN out, which other tools set); a token is only checked for being set, never read. `gh` is null when gh isn't installed.
 */
export function copilotSignIn(env: Record<string, string | undefined>, cliConfig: unknown, gh: GhStatus | null): CopilotSignIn {
  const variable = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].find((k) => !!env[k]?.trim())
  if (variable) return { loggedIn: true, source: 'token', account: null, variable }
  const stored = storedLogin(cliConfig)
  if (stored !== null) return { loggedIn: true, source: 'stored', account: stored || null, variable: null }
  if (gh?.ok) return { loggedIn: true, source: 'gh', account: gh.login, variable: null }
  return { loggedIn: false, source: null, account: null, variable: null }
}

/**
 * The account of the CLI's stored login (`lastLoggedInUser` when it is one of `loggedInUsers`, else the first), '' when
 * one is stored without a login name, null when none is. A host other than github.com is named after the login.
 */
export function storedLogin(cliConfig: unknown): string | null {
  const c = cliConfig && typeof cliConfig === 'object' ? (cliConfig as Record<string, unknown>) : {}
  const users = (Array.isArray(c.loggedInUsers) ? c.loggedInUsers : []).filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
  if (!users.length) return null
  const last = c.lastLoggedInUser && typeof c.lastLoggedInUser === 'object' ? (c.lastLoggedInUser as Record<string, unknown>) : null
  const user = users.find((u) => last && u.login === last.login && u.host === last.host) ?? users[0]
  const login = typeof user.login === 'string' ? user.login : ''
  const host = typeof user.host === 'string' ? user.host.replace(/^https?:\/\//, '').replace(/\/+$/, '') : ''
  return login && host && host !== 'github.com' ? `${login} (${host})` : login
}

/** The CLI's config.json: JSON after a `//` comment line ("User settings belong in settings.json."). */
export function parseCopilotConfig(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return null
  }
}

/** The active github.com account from `gh auth status --active --hostname github.com --json hosts`. */
export function parseGhStatus(stdout: string): GhStatus | null {
  try {
    const hosts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> }).hosts
    const list = hosts?.['github.com']
    const a = (Array.isArray(list) ? list : []).find((x) => x && typeof x === 'object' && (x as { active?: unknown }).active !== false) as Record<string, unknown> | undefined
    if (!a) return { login: null, ok: false }
    return { login: typeof a.login === 'string' ? a.login : null, ok: a.state === 'success' }
  } catch {
    return null
  }
}

/**
 * The environment Copilot agents get, for checking their sign-in: Hive's, without the token variables its launches
 * leave out (COPILOT_ENV_STRIP) and without auto-update (agents run the installed version, which --version reports).
 */
export function copilotCheckEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CHROME_CRASHPAD_PIPE_NAME' && !k.startsWith('HIVE_') && !k.startsWith('CW_')) env[k] = v
  return copilotEnv(env)
}

/** The token variables set in Hive's own environment that Copilot agents don't get (none are read). */
export function ignoredTokens(base: NodeJS.ProcessEnv = process.env): string[] {
  return stripsTokens() ? COPILOT_ENV_STRIP.filter((k) => !!base[k]?.trim()) : []
}

/** Where the CLI may be: the path set in Settings, PATH, WinGet's Links folder, npm's global folder. */
async function candidates(env: Record<string, string>): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = []
  const custom = providerSettings(config.settings, ID).executablePath.trim()
  if (custom) out.push({ path: custom, source: 'settings' })
  const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['copilot'], 5000, env)
  for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
  }
  if (process.platform === 'win32') {
    // A Hive started before the install doesn't have the new PATH yet.
    if (process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'), source: 'WinGet' })
    if (process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'copilot.cmd'), source: 'npm' })
  } else out.push({ path: join(homedir(), '.local', 'bin', 'copilot'), source: 'PATH' })
  return out
}

/** How it was installed, from its path: an update goes through the same installer. */
export function installKind(path: string): 'winget' | 'npm' | 'other' {
  if (/[\\/]Microsoft[\\/]WinGet[\\/](Links|Packages)[\\/]/i.test(path)) return 'winget'
  if (/\.(cmd|bat)$/i.test(path) || /[\\/]node_modules[\\/]/i.test(path)) return 'npm'
  return 'other'
}

/** "GitHub Copilot CLI 1.0.93." → 1.0.93 (the sentence's full stop isn't part of it). */
export function parseCopilotVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/.exec(text)?.[1] ?? null
}

export async function locateCopilot(): Promise<AgentInstallInfo> {
  const info: AgentInstallInfo = { provider: ID, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [] }
  const env = copilotCheckEnv()
  for (const c of await candidates(env)) {
    if (!existsSync(c.path)) continue
    if (EDITOR_EXTENSION_PATH.test(c.path)) {
      info.rejected!.push(c.path)
      continue
    }
    const r = await run(c.path, ['--version'], 15000, env)
    const version = parseCopilotVersion(r.stdout)
    if (!version) {
      // The path and what the CLI printed are the user's (folder names, profile names): left out of Copy Diagnostics.
      log.warn(`Candidate ${userText(c.path)} did not report a version: ${userText(r.stderr.slice(0, 200))}`)
      continue
    }
    Object.assign(info, { found: true, path: c.path, version, source: c.source })
    break
  }
  if (!info.path) return info
  info.notes = [installText(COPILOT_PLAN_NOTE)]
  const signIn = await checkSignIn(env)
  info.loggedIn = signIn.loggedIn
  info.authMethod = signIn.source === 'token' ? signIn.variable : signIn.source === 'stored' ? 'Copilot login' : signIn.source === 'gh' ? 'GitHub CLI' : null // i18n-ignore: how the CLI signed in, as the CLIs name it (their own words), matched by tests (data-signin)
  info.account = signIn.account
  return info
}

/** Reads only the login names in the CLI's config.json, and the gh account's name and state (never a token). */
async function checkSignIn(env: Record<string, string>): Promise<CopilotSignIn> {
  const first = copilotSignIn(env, null, null)
  if (first.loggedIn) return first
  let cliConfig: unknown = null
  try {
    cliConfig = parseCopilotConfig(await readFile(join(copilotHome(), 'config.json'), 'utf8'))
  } catch {
    // Never signed in (or never run): no config yet.
  }
  if (storedLogin(cliConfig) !== null) return copilotSignIn(env, cliConfig, null)
  const gh = await run('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'], 10000, env)
  return copilotSignIn(env, cliConfig, gh.stdout.trim() ? parseGhStatus(gh.stdout) : null)
}

export function copilotReadiness(info: AgentInstallInfo, hiveEnv: NodeJS.ProcessEnv = process.env): ReadinessIssue[] {
  if (!info.found) return [notInstalledIssue(NAME)]
  const out: ReadinessIssue[] = []
  if (info.loggedIn === false) {
    const ignored = ignoredTokens(hiveEnv)
    out.push(
      signedOutIssue(NAME, [
        msg({ id: 'providers.copilot.signIn.runs', defaultMessage: '**Sign in** runs `copilot login` in a terminal: it opens GitHub in your browser to authorise Copilot. Combwork never signs in for you.', description: "Provider Setup, under GitHub Copilot's Sign in: what it does. **…** marks bold text and `…` a command: keep the marks and the command." }),
        msg({ id: 'providers.copilot.signIn.deviceCode', defaultMessage: 'For a code to enter on GitHub instead, run `copilot login --device-code` in a terminal.', description: "Provider Setup, under GitHub Copilot's Sign in: another way to sign in. `…` marks a command: keep it." }),
        msg({ id: 'providers.copilot.signIn.gh', defaultMessage: 'With no login of its own, Copilot uses the GitHub CLI’s (`gh auth login`).', description: "Provider Setup, under GitHub Copilot's Sign in: Copilot falls back to the GitHub CLI's sign-in. `…` marks a command: keep it." }),
        ...(ignored.length ? [{ m: msg({ id: 'providers.copilot.signIn.ignored', defaultMessage: '{n, plural, one {Copilot agents don’t get {variables} from Combwork’s environment, so it doesn’t sign them in. For a token of Copilot’s own, set `COPILOT_GITHUB_TOKEN`.} other {Copilot agents don’t get {variables} from Combwork’s environment, so they don’t sign them in. For a token of Copilot’s own, set `COPILOT_GITHUB_TOKEN`.}}', description: "Provider Setup, under GitHub Copilot's Sign in: environment variables with a GitHub token that Hive keeps from Copilot agents. {variables} lists them (joined with “or”), {n} is how many. `…` marks a variable name: keep it." }), values: { variables: listOf(ignored.map((k) => `\`${k}\``), 'disjunction'), n: ignored.length } }] : [])
      ])
    )
  }
  if (info.updateAvailable) {
    // Use the installer that owns this executable, keeping its package record consistent.
    const updatable = !!info.path && installKind(info.path) !== 'other'
    out.push(updateIssue(NAME, info.latestVersion, updatable ? undefined : [{ m: msg({ id: 'providers.copilot.updateManual', defaultMessage: 'Update {provider} the way you installed it, then choose Check again.', description: "Provider Setup, under a newer GitHub Copilot that Hive can't update itself. {provider} is its name. Check again is the button in Provider Setup." }), values: { provider: NAME } }]))
  }
  return out
}

/** The newest release on npm (the WinGet package follows it). */
export async function copilotLatestVersion(): Promise<string | null> {
  try {
    return ((await plainHttpsJson(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, { timeoutMs: 6000 })) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

export function copilotInstallCommand(): CommandSpec {
  if (process.platform === 'win32') return { file: 'winget.exe', args: ['install', '--id', WINGET_ID, '--exact', '--source', 'winget'] }
  return { file: '/bin/bash', args: ['-lc', `npm install -g ${NPM_PACKAGE}`] } // i18n-ignore: a command run in a terminal
}

/**
 * Through its installer, so its package record stays consistent. Copilot's self-update can replace a WinGet
 * executable without updating WinGet's record (#1101). Readiness offers no Update for other installs.
 */
export function copilotUpdateCommand(executable: string): CommandSpec {
  if (installKind(executable) === 'winget') return { file: 'winget.exe', args: ['upgrade', '--id', WINGET_ID, '--exact', '--source', 'winget'] }
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm', 'install', '-g', `${NPM_PACKAGE}@latest`] }
  return { file: '/bin/bash', args: ['-lc', `npm install -g ${NPM_PACKAGE}@latest`] } // i18n-ignore: a command run in a terminal
}

/** WinGet's portable uninstall failure (signed or unsigned HRESULT), before replacing the old package (#1101). */
export function copilotUpdateRetry(executable: string, exitCode: number): UpdateRetry | null {
  if (installKind(executable) !== 'winget' || (exitCode >>> 0) !== 0x8a150057) return null
  const command = copilotUpdateCommand(executable)
  return {
    command: { ...command, args: [...command.args, '--force'] },
    notice: {
      message: installText(msg({ id: 'providers.copilot.updateModified', defaultMessage: 'WinGet could not remove the old Copilot package. Its installed files may have changed since WinGet installed them, often because Copilot updated itself. Update anyway asks WinGet to replace them with --force. Stop Copilot agents first.', description: 'Provider Setup after WinGet portable removal failed. The exit code can also mean other removal failures, so the cause is tentative. Update anyway is the adjacent button; keep WinGet, Copilot and --force unchanged.' })),
      label: installText(msg({ id: 'providers.copilot.updateAnyway', defaultMessage: 'Update anyway', description: 'Provider Setup button: explicitly retry a failed WinGet Copilot update with --force, replacing the old package despite changed files.' }))
    }
  }
}

/** `copilot login` in a terminal the user signs in with (Hive types nothing into it). */
export function copilotLoginCommand(executable: string): CommandSpec {
  return toSpawnable(executable, ['login'])
}
