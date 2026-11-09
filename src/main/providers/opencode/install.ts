import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, writeFileSync } from 'original-fs'
import { mkdir } from 'original-fs/promises'
import { msg } from '../../../shared/i18n'
import type { AgentInstallInfo, ReadinessIssue } from '../../../shared/types'
import { OPENCODE, OPENCODE_DESCRIPTOR } from '../../../shared/opencode'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { advanced } from '../../advanced'
import { createLogger, userText } from '../../logger'
import { plainHttpsJson } from '../../plainHttpsJson'
import { compareVersions, EDITOR_EXTENSION_PATH, installText, notInstalledIssue, run, toSpawnable } from '../common'
import type { CommandSpec } from '../types'
import { localDataRoot } from '../antigravity/home'
import { ambientIntegrations, noAutoUpdate, opencodeEnv, stripCredentials } from './home'
import { app } from 'electron'
import { checkConfig, loginConfig, parseAuthList, testProviderOf, withTestProvider, writeConfigDir, type SavedCredentials, type TestProvider } from './config'
import { parseOpencodeModels } from './models'
import type { CatalogModel } from '../../../shared/types'

// OpenCode's installation, readiness and checks, for Provider Setup and accounts (HI-2759, against 2.2.6). Combwork never
// drives OpenCode's sign-in: the user answers `opencode auth login` in a terminal.

const log = createLogger('providers')
const NAME = OPENCODE_DESCRIPTOR.name

/** Where Combwork's install puts OpenCode (the official standalone Windows asset, unpacked). */
export const installFolder = (): string => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'OpenCode')

/** OpenCode 1 installed through npm (`opencode-ai`) shares the executable's name: never used (HI-2756). */
const V1_PACKAGE = /[\\/]node_modules[\\/]opencode-ai[\\/]/i

/** Where opencode may be: the path set in Settings, PATH, Combwork's install folder, and the official script's (~\.opencode\bin). */
async function candidates(env: Record<string, string>): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = []
  const custom = providerSettings(config.settings, OPENCODE).executablePath.trim()
  if (custom) out.push({ path: custom, source: 'settings' })
  const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode'], 5000, env)
  for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
  }
  if (process.platform === 'win32') {
    out.push({ path: join(installFolder(), 'opencode.exe'), source: 'installer' })
    out.push({ path: join(homedir(), '.opencode', 'bin', 'opencode.exe'), source: 'installer' })
  }
  return out
}

/** Whether a path is an editor's copy or OpenCode 1's npm package: never used. */
export const isRejectedPath = (path: string): boolean => EDITOR_EXTENSION_PATH.test(path) || V1_PACKAGE.test(path)

/** `opencode --version` (2.2.6: "opencode v2.2.6"), by the advanced pattern opencode.version (the version its first group). */
export function parseOpencodeVersion(text: string, pattern: RegExp = advanced.pattern('opencode.version')): string | null {
  return new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(text)?.[1] ?? null
}

/** OpenCode 2 or later: V1 and the archived project (0.x) share the executable's name and aren't supported. */
export const isSupportedVersion = (version: string): boolean => (Number(/^(\d+)\./.exec(version)?.[1]) || 0) >= 2

/** A test copy's local provider (CW_TEST_OPENCODE_PROVIDER: unpackaged builds only, config.ts testProviderOf), or none. */
export const testProvider = (): TestProvider | null => testProviderOf(process.env.CW_TEST_OPENCODE_PROVIDER, app.isPackaged)

/** Combwork's own roots for checks outside an account (the version, Provider Setup's models): never the user's. */
export const checkHome = (): string => join(localDataRoot(), 'opencode', 'check')

/** The config folder of an account's (or the check root's) checks, inside it: Combwork's own file, rewritten each check. */
export const checkConfigDir = (home: string): string => join(home, 'combwork-check')
/** The config folder of an account's sign-in, inside it. */
export const loginConfigDir = (home: string): string => join(home, 'combwork-login')

/** The environment for a check on a root: the account's roots, its check config, never a password or blockers' exception. */
export function checkEnvFor(home: string, base: Record<string, string> = inherited()): Record<string, string> {
  return opencodeEnv({ base, home, configDir: checkConfigDir(home), ambientDir: join(home, 'combwork-ambient') })
}

/** The inherited environment, as Combwork's children get it (without Electron's own variables). */
function inherited(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'CHROME_CRASHPAD_PIPE_NAME') out[k] = v
  return out
}

/** Runs opencode outside an agent's launch, standalone (never the machine-wide service), on `home`'s roots. */
export async function runOpencode(executable: string, args: string[], home: string, timeoutMs: number, saved: SavedCredentials | null = null, base?: Record<string, string>): ReturnType<typeof run> {
  await mkdir(home, { recursive: true })
  await writeConfigDir(checkConfigDir(home), withTestProvider(checkConfig(ambientIntegrations(), saved, stripCredentials(), noAutoUpdate()), testProvider(), false))
  const s = toSpawnable(executable, [...args, '--standalone'])
  return run(s.file, s.args, timeoutMs, checkEnvFor(home, base))
}

/**
 * The command for opencode outside an agent's launch, as runOpencode runs it (standalone, its check config written, the
 * account's roots), for a caller that runs it itself: the OpenCode history's worker exports a session with it (HI-2762).
 */
export async function opencodeCommand(executable: string, args: string[], home: string): Promise<{ file: string; args: string[]; line?: string; env: Record<string, string> }> {
  await mkdir(home, { recursive: true })
  await writeConfigDir(checkConfigDir(home), withTestProvider(checkConfig(ambientIntegrations(), null, stripCredentials(), noAutoUpdate()), testProvider(), false))
  const s = toSpawnable(executable, [...args, '--standalone'])
  return { file: s.file, args: s.args, ...(s.line !== undefined ? { line: s.line } : {}), env: checkEnvFor(home) }
}

/** An account's saved credentials (`opencode auth list --format json`), null when the listing failed. */
export async function savedCredentials(executable: string, home: string, base?: Record<string, string>): Promise<{ saved: SavedCredentials; integrations: { id: string; name: string; saved: number; env: string[] }[] } | null> {
  const r = await runOpencode(executable, ['auth', 'list', '--format', 'json'], home, 20000, null, base)
  if (r.code !== 0 || r.ended) {
    log.warn(`${NAME}'s saved credentials couldn't be listed: ${userText(`${r.stderr}`.slice(0, 300))}`)
    return null
  }
  return parseAuthList(r.stdout)
}

/** An account's models, standalone on its roots (with its saved credentials' policies): null when they couldn't be listed. */
export async function accountModels(executable: string, home: string, base?: Record<string, string>): Promise<CatalogModel[] | null> {
  const saved = await savedCredentials(executable, home, base)
  const r = await runOpencode(executable, ['models'], home, 30000, saved?.saved ?? null, base)
  if (r.code !== 0 || r.ended) return null
  return parseOpencodeModels(r.stdout)
}

export async function locateOpencode(): Promise<AgentInstallInfo> {
  const info: AgentInstallInfo = { provider: OPENCODE, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [] }
  const home = checkHome()
  await mkdir(home, { recursive: true })
  const env = checkEnvFor(home)
  for (const c of await candidates(env)) {
    if (!existsSync(c.path)) continue
    if (isRejectedPath(c.path)) {
      info.rejected!.push(c.path)
      continue
    }
    const s = toSpawnable(c.path, ['--version'])
    const r = await run(s.file, s.args, 15000, env)
    const version = parseOpencodeVersion(`${r.stdout}\n${r.stderr}`)
    if (!version || !isSupportedVersion(version)) {
      // The path and what it printed are the user's: left out of Copy Diagnostics.
      log.warn(`Candidate ${userText(c.path)} isn't OpenCode 2 (${userText(`${r.stdout}`.trim().slice(0, 80))})`)
      info.rejected!.push(c.path)
      continue
    }
    Object.assign(info, { found: true, path: c.path, version, source: c.source })
    break
  }
  // OpenCode runs local and built-in models with no sign-in (decision 2): its accounts say what each has connected.
  if (info.found) info.loggedIn = true
  return info
}

const V1_FOUND = msg({ id: 'providers.opencode.v1Found', defaultMessage: '{count, plural, one {The opencode found is} other {The opencode copies found are}} not OpenCode 2: OpenCode 1 (opencode-ai), the archived opencode project or an editor’s copy. Combwork needs OpenCode 2: Install puts it in its own folder, and your other copy keeps working.', description: "Provider Setup → OpenCode, when only copies Combwork doesn't support were found. opencode and opencode-ai are names: keep them; Install is a button." })

export function opencodeReadiness(info: AgentInstallInfo): ReadinessIssue[] {
  if (!info.found) {
    const issue = notInstalledIssue(NAME)
    return info.rejected?.length ? [{ ...issue, detail: [installText({ m: V1_FOUND, values: { count: info.rejected.length } })] }] : [issue]
  }
  return []
}

/** The newest OpenCode 2 release (GitHub labels a V1 release "Latest", so the list, never /latest), or null. */
export async function latestOpencode(): Promise<string | null> {
  try {
    const reply = await plainHttpsJson('https://api.github.com/repos/anomalyco/opencode/releases?per_page=40', { timeoutMs: 6000, headers: { Accept: 'application/vnd.github+json' } })
    return newestV2(Array.isArray(reply) ? reply : [])
  } catch {
    return null
  }
}

/** The highest non-draft, non-prerelease v2.x tag in a releases listing. */
export function newestV2(releases: unknown[]): string | null {
  let best: string | null = null
  for (const r of releases) {
    if (!r || typeof r !== 'object') continue
    const { tag_name: tag, draft, prerelease } = r as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
    const v = typeof tag === 'string' ? /^v?(2\.\d+\.\d+)$/.exec(tag)?.[1] : undefined
    if (!v || draft || prerelease) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}

/**
 * The official standalone Windows asset, installed into `folder` (PowerShell, in a terminal the user watches): the newest
 * v2 release from GitHub's list, its zip for this PC's architecture, checked against the release's SHA256SUMS, unpacked.
 */
export function installScript(folder: string): string {
  const q = folder.replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$h = @{ 'User-Agent' = 'Combwork'; 'Accept' = 'application/vnd.github+json' }",
    "$rel = Invoke-RestMethod -Headers $h 'https://api.github.com/repos/anomalyco/opencode/releases?per_page=40'",
    "$v2 = $rel | Where-Object { -not $_.draft -and -not $_.prerelease -and $_.tag_name -match '^v2\\.\\d+\\.\\d+$' } | Sort-Object { [version]($_.tag_name.TrimStart('v')) } -Descending | Select-Object -First 1",
    "if (-not $v2) { throw 'No OpenCode 2 release found on GitHub.' }",
    "$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }",
    "$name = \"opencode-windows-$arch.zip\"",
    "$zip = $v2.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1",
    "$sums = $v2.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1",
    "if (-not $zip -or -not $sums) { throw \"Release $($v2.tag_name) has no $name or SHA256SUMS.\" }",
    "$tmp = Join-Path ([IO.Path]::GetTempPath()) (\"combwork-opencode-\" + [guid]::NewGuid())",
    "New-Item -ItemType Directory -Path $tmp | Out-Null",
    "try {",
    "  Write-Host \"Downloading OpenCode $($v2.tag_name) ($name)...\"",
    "  Invoke-WebRequest -Headers $h -Uri $zip.browser_download_url -OutFile (Join-Path $tmp $name)",
    "  Invoke-WebRequest -Headers $h -Uri $sums.browser_download_url -OutFile (Join-Path $tmp 'SHA256SUMS')",
    "  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match \"\\s\\*?$([regex]::Escape($name))$\" } | Select-Object -First 1)",
    "  if (-not $want) { throw \"SHA256SUMS doesn't list $name.\" }",
    "  $want = ($want -split '\\s+')[0].ToLower()",
    "  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLower()",
    "  if ($got -ne $want) { throw \"$name doesn't match SHA256SUMS ($got, expected $want).\" }",
    "  Write-Host \"SHA-256 matches SHA256SUMS: $got\"",
    "  Expand-Archive -Path (Join-Path $tmp $name) -DestinationPath (Join-Path $tmp 'x') -Force",
    "  $exe = Get-ChildItem -Path (Join-Path $tmp 'x') -Recurse -Filter 'opencode.exe' | Select-Object -First 1",
    "  if (-not $exe) { throw \"$name has no opencode.exe.\" }",
    `  New-Item -ItemType Directory -Force -Path '${q}' | Out-Null`,
    `  Copy-Item -Force $exe.FullName (Join-Path '${q}' 'opencode.exe')`,
    `  Write-Host "OpenCode $($v2.tag_name) installed in ${q.replace(/"/g, '`"')}."`,
    '} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }'
  ].join('\n')
}

const powershell = (script: string): CommandSpec => ({ file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script] }) // i18n-ignore: a command run in a terminal

export const opencodeInstallCommand = (): CommandSpec => powershell(installScript(installFolder()))

/**
 * An update, on purpose (the only time Combwork lets OpenCode change): an npm `@opencode/cli` through npm; a standalone
 * opencode.exe by the same verified download into its own folder.
 */
export function opencodeUpdateCommand(executable: string): CommandSpec {
  if (/\.(cmd|bat)$/i.test(executable) || /[\\/]node_modules[\\/]/i.test(executable)) return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'npm install -g @opencode/cli@latest'] } // i18n-ignore: a command run in a terminal
  return powershell(installScript(basename(executable).toLowerCase() === 'opencode.exe' ? dirname(executable) : installFolder()))
}

/** `opencode auth login` on an account's roots, in a terminal the user answers (Combwork types nothing into it). */
export function opencodeLoginCommand(executable: string, home: string): CommandSpec {
  // Two small files, as the user asks for the sign-in (a click): its config folder, rewritten each time.
  const dir = loginConfigDir(home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify(withTestProvider(loginConfig(noAutoUpdate()), testProvider(), false), null, 2))
  writeFileSync(join(dir, 'service.json'), JSON.stringify({ disabled: true }))
  const s = toSpawnable(executable, ['auth', 'login', '--standalone'])
  // A sign-in is the user's deliberate act: no ambient blockers (an AWS profile chosen there is read from ~\.aws).
  return { ...s, env: opencodeEnv({ base: inherited(), home, configDir: dir }) }
}
