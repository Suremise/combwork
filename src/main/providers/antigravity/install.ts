import { join } from 'path'
import { existsSync } from 'original-fs'
import { msg } from '../../../shared/i18n'
import type { AgentInstallInfo, ReadinessIssue } from '../../../shared/types'
import { ANTIGRAVITY, ANTIGRAVITY_DESCRIPTOR } from '../../../shared/antigravity'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { createLogger, userText } from '../../logger'
import { EDITOR_EXTENSION_PATH, installText, notInstalledIssue, run, signedOutIssue, toSpawnable } from '../common'
import type { CommandSpec } from '../types'
import { antigravityEnv } from './home'
import { parseModels, type CatalogModel } from './models'

// The Antigravity CLI's installation and sign-in, for Provider Setup (HI-2544, against 1.5.0). The adapter delegates
// locate, readiness and the install, update and sign-in tasks here. Combwork never drives agy's sign-in: the user runs agy.

const log = createLogger('providers')
const ID = ANTIGRAVITY
const NAME = ANTIGRAVITY_DESCRIPTOR.name

/**
 * Copies of Antigravity's agent that belong to an editor (the Antigravity IDE's own, VS Code-style extension folders):
 * never used, as for the other CLIs (SPEC §11). The standalone CLI installs in %LOCALAPPDATA%\agy\bin.
 */
const EDITOR_COPY = /[\\/](resources[\\/]app|Programs[\\/]Antigravity(?: IDE)?)[\\/]/i

/** Where agy may be: the path set in Settings, PATH, and the installer's own folder (%LOCALAPPDATA%\agy\bin). */
async function candidates(env: Record<string, string>): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = []
  const custom = providerSettings(config.settings, ID).executablePath.trim()
  if (custom) out.push({ path: custom, source: 'settings' })
  const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['agy'], 5000, env)
  for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
  }
  // A Combwork started before the install doesn't have the new PATH yet.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'), source: 'installer' })
  return out
}

/** Whether a path is an editor's copy, never used. */
export const isEditorCopy = (path: string): boolean => EDITOR_EXTENSION_PATH.test(path) || EDITOR_COPY.test(path)

/** `agy --version` prints the version alone ("1.5.0"). */
export function parseAntigravityVersion(text: string): string | null {
  return /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)\s*$/m.exec(text)?.[1] ?? null
}

/** The environment agy is checked in: its sessions' (antigravityEnv), so the sign-in shown is the one they use. */
export const antigravityCheckEnv = (): Record<string, string> => antigravityEnv(process.env as Record<string, string>)

/**
 * What `agy models` says of the sign-in (s17's classification): `ok` with the account's models; `signIn` only when its text
 * matches the recorded sign-in-needed pattern (`signInNeeded`); anything else is an `error` with agy's own text (a network,
 * service, timeout or parse failure, or the executable's), never taken as signed out.
 */
export type ModelsCheck = { kind: 'ok'; models: CatalogModel[] } | { kind: 'signIn'; text: string } | { kind: 'error'; text: string }

export function classifyModels(r: { stdout: string; stderr: string; code: number; ended?: true }, signInNeeded: RegExp | null): ModelsCheck {
  const text = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code === 0 && !r.ended) {
    const models = parseModels(r.stdout)
    if (models.length) return { kind: 'ok', models }
    return { kind: 'error', text: text || 'agy models listed no models' } // i18n-ignore: diagnostic, shown with agy's own words
  }
  if (signInNeeded && signInNeeded.source && signInNeeded.source !== '(?:)' && signInNeeded.test(text)) return { kind: 'signIn', text }
  return { kind: 'error', text: r.ended ? `agy models didn't finish: ${text}` : text } // i18n-ignore: diagnostic, shown with agy's own words
}

export async function checkModels(executable: string, env: Record<string, string>, signInNeeded: RegExp | null, timeoutMs = 20000): Promise<ModelsCheck> {
  return classifyModels(await run(executable, ['models'], timeoutMs, env), signInNeeded)
}

export async function locateAntigravity(signInNeeded: RegExp | null): Promise<AgentInstallInfo> {
  const info: AgentInstallInfo = { provider: ID, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [] }
  const env = antigravityCheckEnv()
  for (const c of await candidates(env)) {
    if (!existsSync(c.path)) continue
    if (isEditorCopy(c.path)) {
      info.rejected!.push(c.path)
      continue
    }
    const r = await run(c.path, ['--version'], 15000, env)
    const version = parseAntigravityVersion(r.stdout)
    if (!version) {
      // The path and what the CLI printed are the user's: left out of Copy Diagnostics.
      log.warn(`Candidate ${userText(c.path)} did not report a version: ${userText(r.stderr.slice(0, 200))}`)
      continue
    }
    Object.assign(info, { found: true, path: c.path, version, source: c.source })
    break
  }
  if (!info.path) return info
  const check = await checkModels(info.path, env, signInNeeded)
  info.loggedIn = check.kind === 'ok' ? true : check.kind === 'signIn' ? false : null
  info.authMethod = check.kind === 'ok' ? 'Antigravity sign-in' : null // i18n-ignore: how the CLI signed in, as the CLI names it
  if (check.kind === 'error') {
    info.notes = [installText({ m: CHECK_FAILED, values: { provider: NAME, text: check.text.slice(0, 400) } })]
    log.warn(`${NAME}'s sign-in couldn't be checked: ${userText(check.text.slice(0, 300))}`)
  }
  return info
}

const CHECK_FAILED = msg({ id: 'providers.antigravity.checkFailed', defaultMessage: "Couldn't check {provider}'s sign-in: {text}. Choose Check again; if you haven't signed in yet, run agy in a terminal.", description: "Provider Setup, under Antigravity CLI, when listing its models failed for a reason other than a known sign-in error (a network or service error, a timeout). {provider} is its name, {text} the CLI's own words (not translated). agy is a command: keep it; Check again is a button." })

export function antigravityReadiness(info: AgentInstallInfo): ReadinessIssue[] {
  if (!info.found) return [notInstalledIssue(NAME)]
  if (info.loggedIn !== false) return []
  return [
    signedOutIssue(NAME, [
      msg({ id: 'providers.antigravity.signIn.runs', defaultMessage: '**Sign in** runs `agy` in a terminal: sign in there. Combwork never signs in for you.', description: "Provider Setup, under Antigravity CLI's Sign in: what it does. **…** marks bold text and `…` a command: keep the marks and the command." }),
      msg({ id: 'providers.antigravity.signIn.shared', defaultMessage: 'The sign-in is this PC’s: every workspace’s Antigravity agents use it, and signing out signs them all out.', description: "Provider Setup, under Antigravity CLI's Sign in: its sign-in is shared by every workspace on this PC." })
    ])
  ]
}

/** Google's installer (PowerShell): it installs agy in %LOCALAPPDATA%\agy\bin. Run in a terminal the user watches. */
export function antigravityInstallCommand(): CommandSpec {
  return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'] } // i18n-ignore: a command run in a terminal
}

/** agy's own update (1.5.0's `agy update`), on purpose: the only time Combwork lets it update. */
export function antigravityUpdateCommand(executable: string): CommandSpec {
  return toSpawnable(executable, ['update'])
}

/** `agy` in a terminal the user signs in with (Combwork types nothing into it). */
export function antigravityLoginCommand(executable: string): CommandSpec {
  return toSpawnable(executable, [])
}
