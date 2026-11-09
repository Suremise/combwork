import { homedir } from 'os'
import { msg } from '../../../shared/i18n'
import { join } from 'path'
import { existsSync } from 'original-fs'
import type { AgentInstallInfo, HostCheck, ModelCatalog, ReadinessIssue } from '../../../shared/types'
import { COPILOT, COPILOT_DESCRIPTOR } from '../../../shared/copilot'
import { isProviderEnabled, providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { createLogger, userText } from '../../logger'
import { plainHttpsJson } from '../../plainHttpsJson'
import { listOf } from '../../../shared/advanced'
import { EDITOR_EXTENSION_PATH, installText, notInstalledIssue, run, signedOutIssue, toSpawnable, updateIssue } from '../common'
import type { CommandSpec, UpdateRetry } from '../types'
import { COPILOT_ENV_STRIP, copilotEnv, stripsTokens } from './home'
import { GITHUB_COM } from '../../../shared/githubHost'
import { askCopilotModels } from './models'
import { checkRoutes, hostEvidence, loggedInOf, parseGhStatus as parseHostGh, readCliConfig, routeContext, routeListing, routeOf, routesInUse, type CopilotRoute, type GhHostStatus, type HostCheckDeps } from './hosts'
import type { ResolvedGithubHosts } from '../../../shared/githubHost'
import type { CatalogRead } from '../types'
import { isWingetPath, wingetUpgradeCommand, wingetUpToDate, wingetVersion } from '../winget'

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

/** How Copilot agents are signed in: a token in their environment, Copilot's own login, the GitHub CLI's (gh), or none needed (a local model). */
export type CopilotSignInSource = 'token' | 'stored' | 'gh' | 'local'

export interface CopilotSignIn {
  loggedIn: boolean | null
  source: CopilotSignInSource | null
  /** The GitHub account, when known (a token's isn't: Combwork never reads one). */
  account: string | null
  /** The token variable in use (source 'token'). */
  variable: string | null
}

/** What `gh auth status --json hosts` says of a host (hosts.ts: the fields Combwork reads; it never asks for the token). */
export type GhStatus = GhHostStatus

/**
 * Which sign-in Copilot agents get on `host` (github.com unless given), in the CLI's own order (`copilot login --help`):
 * hosts.ts hostEvidence, as signed in yes, no or unknown. `env` is the environment agents get (Combwork leaves GH_TOKEN
 * and GITHUB_TOKEN out, which other tools set); a token is only checked for being set, never read. `gh` is null when gh
 * isn't installed.
 */
export function copilotSignIn(env: Record<string, string | undefined>, cliConfig: unknown, gh: GhStatus | null, host = GITHUB_COM): CopilotSignIn {
  const e = hostEvidence(env, cliConfig, gh, host)
  return { loggedIn: loggedInOf(e.state), source: e.source, account: e.account, variable: e.variable }
}

/** The CLI's config.json: JSON after a `//` comment line ("User settings belong in settings.json."). */
export function parseCopilotConfig(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return null
  }
}

/** The active account on `host` (github.com unless given) from `gh auth status --active --hostname <host> --json hosts`. */
export function parseGhStatus(stdout: string, host = GITHUB_COM): GhStatus | null {
  return parseHostGh(stdout, host)
}

/**
 * The environment Copilot agents get, for checking their sign-in: Combwork's, without the token variables its launches
 * leave out (COPILOT_ENV_STRIP) and without auto-update (agents run the installed version, which --version reports).
 */
export function copilotCheckEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CHROME_CRASHPAD_PIPE_NAME' && !k.startsWith('CW_')) env[k] = v
  return copilotEnv(env)
}

/** The token variables set in Combwork's own environment that Copilot agents don't get (none are read). */
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
    // A Combwork started before the install doesn't have the new PATH yet.
    if (process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'), source: 'WinGet' })
    if (process.env.APPDATA) out.push({ path: join(process.env.APPDATA, 'npm', 'copilot.cmd'), source: 'npm' })
  } else out.push({ path: join(homedir(), '.local', 'bin', 'copilot'), source: 'PATH' })
  return out
}

/** How it was installed, from its path: an update goes through the same installer. */
export function installKind(path: string): 'winget' | 'npm' | 'other' {
  if (isWingetPath(path)) return 'winget'
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
  const routes = await routesInUse(env)
  const checks = await checkRoutes(routes, hostDeps(info.path, info.version))
  // A newer check started meanwhile (a host or switch changed): it reports instead, and this one's answers are dropped.
  if (!checks) return { ...info, checking: true }
  lastRoutes = routes
  info.hostChecks = checks
  // Each host's own catalogue, from its listing of this generation (HI-2779), and which host each folder resolves to: a
  // project's pickers take its host's, never another host's.
  Object.assign(info, hostCatalogsOf(routes, info.version))
  // Existing callers (diagnostics, Automatic) read the first host's sign-in: the environment's, else the first workspace's.
  const first = checks[0]
  info.loggedIn = loggedInOf(first.state)
  info.authMethod = first.state === 'installed' || first.state === 'chooseHost' || first.state === 'proxyUnsupported' ? null : first.source
  info.account = first.account
  return info
}

/**
 * Each route's catalogue from its listing of this generation (none for a route without one), and which route each folder
 * resolves to, lower-cased (HI-2779): what infoAt gives a project's or a workspace's pickers.
 */
export function hostCatalogsOf(routes: readonly CopilotRoute[], version: string | null, at = new Date().toISOString()): Pick<AgentInstallInfo, 'hostCatalogs' | 'hostRouteOf'> {
  const hostCatalogs: Record<string, ModelCatalog> = {}
  const hostRouteOf: Record<string, string> = {}
  for (const r of routes) {
    const o = routeListing(r.key)
    const context = routeContext(r.key)
    if (o?.kind === 'ok' && context) hostCatalogs[r.key] = { source: 'cli', version, models: o.read.models, ...(o.read.defaultModel ? { defaultModel: o.read.defaultModel } : {}), at, context }
    for (const path of r.paths) hostRouteOf[path.toLowerCase()] = r.key
  }
  return { hostCatalogs, hostRouteOf }
}

/** The routes the latest check found (Sign in on a host takes its environment from here). */
let lastRoutes: CopilotRoute[] = []

/**
 * The catalogue Provider Setup keeps (where no folder says its host: the first route's, the environment's else the first
 * open workspace's): only this generation's listing of that route, taken by its check. Nothing is asked here, so nothing
 * can come back from an older generation; none (no sign-in there, or a check after a change) is no catalogue, never another
 * host's or account's.
 */
export function primaryModels(routes: readonly CopilotRoute[] = lastRoutes): CatalogRead | null {
  const route = routes[0]
  const o = route ? routeListing(route.key) : null
  return o?.kind === 'ok' ? o.read : null
}

/** The context the primary catalogue was read in (its cache key: no secret), null when this generation has none. */
export function primaryContext(routes: readonly CopilotRoute[] = lastRoutes): string | null {
  const route = routes[0]
  return route ? routeContext(route.key) : null
}

/** The resolved hosts' route for a launch (prepareLaunch): its environment written the same as its checks'. */
export function launchRoute(resolved: ResolvedGithubHosts, baseEnv: Record<string, string>): { env: Record<string, string>; key: string } {
  const r = routeOf(resolved, baseEnv)
  return { env: r.env, key: r.key }
}

/** The real CLIs behind a check (tests give fakes): gh's status per host and the listing, in the route's environment. */
export function hostDeps(executable: string, version: string | null): HostCheckDeps {
  return {
    executable,
    version,
    ghStatus: (host, env) => ghHostStatus(host, env),
    cliConfig: readCliConfig,
    // Only while Copilot is turned on in Settings: the ACP session it opens leaves a folder in Copilot's session store for a moment.
    models: (env) => (isProviderEnabled(config.settings, ID) ? askCopilotModels(executable, env) : Promise.resolve(null))
  }
}

/** `gh auth status --active --hostname <host> --json hosts` in the route's environment: never `gh auth token`. */
export async function ghHostStatus(host: string, env: Record<string, string>, runGh: typeof run = run): Promise<GhHostStatus | null> {
  const r = await runGh('gh', ['auth', 'status', '--active', '--hostname', host, '--json', 'hosts'], 10000, env)
  if (r.timedOut) return { state: 'timeout', login: null, error: null }
  return r.stdout.trim() ? parseHostGh(r.stdout, host) : null
}

/** The words of each host's state that isn't ready, under GitHub Copilot in Provider Setup (HI-2779). */
export const COPILOT_HOST_TEXT = {
  signedOut: msg({ id: 'providers.copilot.host.signedOut', defaultMessage: 'Copilot isn’t signed in on {host}.', description: 'Provider Setup, GitHub Copilot (HI-2779): no sign-in found for a GitHub host Combwork’s projects use. {host} is the host (github.com, yourcompany.ghe.com).' }),
  signInHost: msg({ id: 'providers.copilot.host.signInRuns', defaultMessage: '**Sign in** runs `copilot login --host {host}` in a terminal: it opens {host} in your browser to authorise Copilot. Combwork never signs in for you.', description: "Provider Setup, under GitHub Copilot's Sign in for a GitHub host other than github.com (HI-2779): what it does. {host} is the host. **…** marks bold text and `…` a command: keep the marks and the command." }),
  deviceCodeHost: msg({ id: 'providers.copilot.host.deviceCode', defaultMessage: 'For a code to enter instead, run `copilot login --host {host} --device-code` in a terminal.', description: 'Provider Setup, under GitHub Copilot’s Sign in for a GitHub host (HI-2779): another way to sign in. {host} is the host. `…` marks a command: keep it.' }),
  ghHost: msg({ id: 'providers.copilot.host.gh', defaultMessage: 'With no login of its own there, Copilot uses the GitHub CLI’s login on {host} (`gh auth login --hostname {host}`), never one on another host.', description: 'Provider Setup, under GitHub Copilot’s Sign in for a GitHub host (HI-2779): Copilot falls back to the GitHub CLI’s sign-in on the same host only. {host} is the host. `…` marks a command: keep it.' }),
  chooseHost: msg({ id: 'providers.copilot.host.choose', defaultMessage: '{repoHost} is a GitHub Enterprise Server host: choose where Copilot signs in (github.com or your GHE.com host) in Version Control → GitHub. Its Copilot agents don’t start until you do.', description: 'Provider Setup, GitHub Copilot (HI-2779): a project’s repositories are on a GitHub Enterprise Server host ({repoHost}), where cloud Copilot can’t sign in, and no Copilot host was chosen. Version Control → GitHub names the setting’s place. GHE.com is GitHub’s product name.' }),
  proxy: msg({ id: 'providers.copilot.host.proxy', defaultMessage: 'GitHub Enterprise Server’s Copilot proxy is a preview Combwork doesn’t support yet: choose github.com or your GHE.com host in Version Control → GitHub. Its Copilot agents don’t start until you do.', description: 'Provider Setup, GitHub Copilot (HI-2779): the Copilot sign-in setting chose GitHub Enterprise Server’s Copilot proxy (a GitHub preview), not supported yet. Version Control → GitHub names the setting’s place. GHE.com is GitHub’s product name.' })
}

/** Sign in's words for a host: github.com's as before, another host's with `--host`. */
function signInDetail(host: string, combworkEnv: NodeJS.ProcessEnv): Parameters<typeof signedOutIssue>[1] {
  const ignored = ignoredTokens(combworkEnv)
  const own = host === GITHUB_COM
  return [
    own ? msg({ id: 'providers.copilot.signIn.runs', defaultMessage: '**Sign in** runs `copilot login` in a terminal: it opens GitHub in your browser to authorise Copilot. Combwork never signs in for you.', description: "Provider Setup, under GitHub Copilot's Sign in: what it does. **…** marks bold text and `…` a command: keep the marks and the command." }) : { m: COPILOT_HOST_TEXT.signInHost, values: { host } },
    own ? msg({ id: 'providers.copilot.signIn.deviceCode', defaultMessage: 'For a code to enter on GitHub instead, run `copilot login --device-code` in a terminal.', description: "Provider Setup, under GitHub Copilot's Sign in: another way to sign in. `…` marks a command: keep it." }) : { m: COPILOT_HOST_TEXT.deviceCodeHost, values: { host } },
    own ? msg({ id: 'providers.copilot.signIn.gh', defaultMessage: 'With no login of its own, Copilot uses the GitHub CLI’s (`gh auth login`).', description: "Provider Setup, under GitHub Copilot's Sign in: Copilot falls back to the GitHub CLI's sign-in. `…` marks a command: keep it." }) : { m: COPILOT_HOST_TEXT.ghHost, values: { host } },
    ...(ignored.length ? [{ m: msg({ id: 'providers.copilot.signIn.ignored', defaultMessage: '{n, plural, one {Copilot agents don’t get {variables} from Combwork’s environment, so it doesn’t sign them in. For a token of Copilot’s own, set `COPILOT_GITHUB_TOKEN`.} other {Copilot agents don’t get {variables} from Combwork’s environment, so they don’t sign them in. For a token of Copilot’s own, set `COPILOT_GITHUB_TOKEN`.}}', description: "Provider Setup, under GitHub Copilot's Sign in: environment variables with a GitHub token that Combwork keeps from Copilot agents. {variables} lists them (joined with “or”), {n} is how many. `…` marks a variable name: keep it." }), values: { variables: listOf(ignored.map((k) => `\`${k}\``), 'disjunction'), n: ignored.length } }, { m: SWITCH_NOTE, values: {} }] : [])
  ]
}

/** Where the token switch is, said with the tokens it keeps out (HI-2779: shown, never rebuilt). */
const SWITCH_NOTE = msg({ id: 'providers.copilot.signIn.switch', defaultMessage: 'Settings → Advanced → GitHub Copilot → **Keep GH_TOKEN and GITHUB_TOKEN from Copilot** decides this, for every workspace.', description: 'Provider Setup, under GitHub Copilot’s Sign in, after the tokens Combwork keeps from Copilot (HI-2779): where that switch is. The path and the switch’s name are as Settings shows them (keep them as translated there); **…** marks bold text: keep the marks.' })

/** Each host check's issue: Sign in for a host with none, and the hosts Copilot can't sign in on yet. */
function hostIssues(checks: HostCheck[], combworkEnv: NodeJS.ProcessEnv): ReadinessIssue[] {
  const out: ReadinessIssue[] = []
  checks.forEach((c, i) => {
    if (c.state === 'installed' && c.host) {
      const base = signedOutIssue(NAME, signInDetail(c.host, combworkEnv))
      // The first host keeps the issue's usual id and words (github.com's, as before HI-2779); others name their host.
      out.push(i === 0 && c.host === GITHUB_COM ? { ...base, action: { ...base.action!, host: c.host } } : { ...base, id: `signed-out:${c.key}`, message: installText({ m: COPILOT_HOST_TEXT.signedOut, values: { host: c.host } }), action: { ...base.action!, host: c.host } })
    } else if (c.state === 'chooseHost') out.push({ id: `copilot-host:${c.key}`, level: 'error', message: installText({ m: COPILOT_HOST_TEXT.chooseHost, values: { repoHost: c.repoHost } }) })
    else if (c.state === 'proxyUnsupported') out.push({ id: `copilot-host:${c.key}`, level: 'error', message: installText(COPILOT_HOST_TEXT.proxy) })
  })
  return out
}

export function copilotReadiness(info: AgentInstallInfo, combworkEnv: NodeJS.ProcessEnv = process.env): ReadinessIssue[] {
  if (!info.found) return [notInstalledIssue(NAME)]
  const out: ReadinessIssue[] = info.hostChecks?.length ? hostIssues(info.hostChecks, combworkEnv) : info.loggedIn === false ? [signedOutIssue(NAME, signInDetail(GITHUB_COM, combworkEnv))] : []
  if (info.updateAvailable) {
    // Use the installer that owns this executable, keeping its package record consistent.
    const updatable = !!info.path && installKind(info.path) !== 'other'
    out.push(updateIssue(NAME, info.latestVersion, updatable ? undefined : [{ m: msg({ id: 'providers.copilot.updateManual', defaultMessage: 'Update {provider} the way you installed it, then choose Check again.', description: "Provider Setup, under a newer GitHub Copilot that Combwork can't update itself. {provider} is its name. Check again is the button in Provider Setup." }), values: { provider: NAME } }]))
  }
  return out
}

/**
 * The newest release its installer can deliver: a WinGet install's from the WinGet source, which follows npm days later
 * (HI-2729: npm's would offer an Update that WinGet can't make yet), any other from npm.
 */
export async function copilotLatestVersion(executable?: string | null, fromWinget: typeof wingetVersion = wingetVersion): Promise<string | null> {
  if (executable && installKind(executable) === 'winget') return fromWinget(WINGET_ID)
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
  if (installKind(executable) === 'winget') return wingetUpgradeCommand(WINGET_ID)
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

/** WinGet saying its source has nothing newer (0x8A15002B): the install is as new as WinGet can make it, not a failure. */
export function copilotUpdateUpToDate(executable: string, exitCode: number): boolean {
  return installKind(executable) === 'winget' && wingetUpToDate(exitCode)
}

/**
 * `copilot login` in a terminal the user signs in with (Combwork types nothing into it). On a host other than
 * github.com (HI-2779), `copilot login --host <host>`, in that host's route's environment (its GH_HOST and
 * COPILOT_GH_HOST, as its checks and sessions get them).
 */
export function copilotLoginCommand(executable: string, host?: string, routes: readonly CopilotRoute[] = lastRoutes): CommandSpec {
  if (!host || host === GITHUB_COM) {
    const route = host ? routes.find((r) => r.resolved.copilot.host === host) : undefined
    return { ...toSpawnable(executable, ['login']), ...(route ? { env: route.env } : {}) }
  }
  const route = routes.find((r) => r.resolved.copilot.host === host)
  return { ...toSpawnable(executable, ['login', '--host', host]), ...(route ? { env: route.env } : {}) }
}
