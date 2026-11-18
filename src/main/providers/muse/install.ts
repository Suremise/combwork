import { join } from 'path'
import { existsSync } from 'original-fs'
import { mkdir } from 'original-fs/promises'
import { msg } from '../../../shared/i18n'
import type { AgentInstallInfo, ReadinessIssue } from '../../../shared/types'
import { MUSE, MUSE_DESCRIPTOR } from '../../../shared/providers/muse'
import { providerSettings } from '../../../shared/providers'
import { config } from '../../config'
import { advanced } from '../../advanced'
import { createLogger, userText } from '../../logger'
import { EDITOR_EXTENSION_PATH, installText, notInstalledIssue, run, toSpawnable, WHERE_MS, cliProbeMs } from '../common'
import type { CommandSpec } from '../types'
import { museEnv, museHome } from './home'

// Muse Code's installation, for Provider Setup (HI-3202, against 1.4.20). Its sign-in is each account's (accounts.ts's
// connections, `muse login` on the account's roots), never the PC's. Combwork never installs, updates or signs Muse in by
// itself: Meta's installer and `muse login` are the user's to run; 1.4.20 has no update command or self-update.

const log = createLogger('providers')
const NAME = MUSE_DESCRIPTOR.name

/** Where muse may be: the path set in Settings, PATH, and the installer's own folder (%LOCALAPPDATA%\Programs\muse). */
async function candidates(env: Record<string, string>): Promise<{ path: string; source: string }[]> {
  const out: { path: string; source: string }[] = []
  const custom = providerSettings(config.settings, MUSE).executablePath.trim()
  if (custom) out.push({ path: custom, source: 'settings' })
  const where = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['muse'], WHERE_MS, env)
  for (const line of where.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    if (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(line)) out.push({ path: line, source: 'PATH' })
  }
  // A Combwork started before the install doesn't have the new PATH yet.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, 'Programs', 'muse', 'muse.exe'), source: 'installer' })
  return out
}

/** `muse --version`: "Muse Code 1.4.20 (1.4.20-R8619.1)". */
export function parseMuseVersion(text: string): string | null {
  return /^\s*Muse Code\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)\b/m.exec(text)?.[1] ?? null
}

/** The root Muse is checked on (its version, its sandbox): Combwork's own, never the user's or an account's. */
export const checkHome = (): string => museHome(null)

/** The environment Muse is checked in: its sessions' (museEnv) on Combwork's check root. */
export const museCheckEnv = (): Record<string, string> => museEnv(process.env as Record<string, string>, checkHome())

/** What `muse sandbox windows check` says: `ready`, `setup` (its Windows sandbox needs setting up), or `unknown`. */
export type SandboxState = 'ready' | 'setup' | 'unknown'

export function classifySandbox(r: { stdout: string; stderr: string; code: number; ended?: true }, setupRequired: RegExp | null): SandboxState {
  const text = `${r.stdout}\n${r.stderr}`
  if (r.ended) return 'unknown'
  if (setupRequired && setupRequired.source !== '(?:)' && setupRequired.test(text)) return 'setup'
  return r.code === 0 && /^status=ready\s*$/m.test(text) ? 'ready' : 'unknown'
}

/** `muse sandbox windows check` (read only: it creates nothing, asks nothing), on Combwork's check root. */
export async function checkSandbox(executable: string): Promise<SandboxState> {
  if (process.platform !== 'win32') return 'unknown'
  let pattern: RegExp | null = null
  try {
    pattern = advanced.pattern('muse.sandbox.setupRequired')
  } catch {
    pattern = null
  }
  await mkdir(checkHome(), { recursive: true })
  const s = toSpawnable(executable, ['sandbox', 'windows', 'check'])
  return classifySandbox(await run(s.file, s.args, 20000, museCheckEnv()), pattern)
}

export async function locateMuse(): Promise<AgentInstallInfo> {
  const info: AgentInstallInfo = { provider: MUSE, found: false, path: null, version: null, source: null, latestVersion: null, updateAvailable: false, loggedIn: null, authMethod: null, account: null, rejected: [] }
  await mkdir(checkHome(), { recursive: true })
  const env = museCheckEnv()
  for (const c of await candidates(env)) {
    if (!existsSync(c.path)) continue
    if (EDITOR_EXTENSION_PATH.test(c.path)) {
      info.rejected!.push(c.path)
      continue
    }
    const s = toSpawnable(c.path, ['--version'])
    const r = await run(s.file, s.args, cliProbeMs(), env)
    const version = parseMuseVersion(`${r.stdout}\n${r.stderr}`)
    if (!version) {
      // The path and what it printed are the user's: left out of Copy Diagnostics.
      log.warn(`Candidate ${userText(c.path)} did not report a Muse Code version: ${userText(`${r.stdout}${r.stderr}`.trim().slice(0, 200))}`)
      continue
    }
    Object.assign(info, { found: true, path: c.path, version, source: c.source })
    break
  }
  return info
}

const SANDBOX = {
  needed: msg({ id: 'providers.muse.sandbox.needed', defaultMessage: "Muse's Windows sandbox isn't set up. Until it is, each new Muse agent shows Muse's setup screen in its pane, and waits there for you.", description: "Provider Setup and Settings → Providers: Muse Code's own Windows sandbox (where it runs an agent's commands) isn't set up on this PC." }),
  action: msg({ id: 'providers.muse.sandbox.action', defaultMessage: 'Set up', description: "Provider Setup's button: opens Muse Code's sandbox setup in a terminal." }),
  runs: msg({ id: 'providers.muse.sandbox.runs', defaultMessage: '**Set up** runs `muse sandbox windows setup` in a terminal. Muse asks for administrator permission there to create two local Windows accounts and a group for its sandbox: Windows asks you, and the choice is yours. Combwork types nothing into it.', description: "Provider Setup, under Muse Code's sandbox Set up: what it does. **…** marks bold text and `…` a command: keep the marks and the command." }),
  meanwhile: msg({ id: 'providers.muse.sandbox.meanwhile', defaultMessage: 'Combwork never answers that screen for an agent. Run Set up here once instead, or answer it in an agent’s pane yourself.', description: "Provider Setup, under Muse Code's sandbox Set up: Combwork doesn't answer Muse's sandbox screen by itself." })
}

/** Its install, then (HI-3202) its sandbox, as the last check found it. Its sign-in is each account's: none here. */
export function museReadiness(info: AgentInstallInfo, sandbox: SandboxState | null): ReadinessIssue[] {
  if (!info.found) return [notInstalledIssue(NAME)]
  if (sandbox !== 'setup') return []
  return [{ id: 'sandbox', level: 'warning', message: installText(SANDBOX.needed), action: { label: installText(SANDBOX.action), task: 'setup' }, detail: [installText(SANDBOX.runs), installText(SANDBOX.meanwhile)] }]
}

/** `muse sandbox windows setup` in a terminal the user watches and answers (Combwork types nothing into it). */
export function museSandboxSetupCommand(executable: string): CommandSpec {
  return { ...toSpawnable(executable, ['sandbox', 'windows', 'setup']), env: museCheckEnv(), keys: [] }
}

/** `muse login` on an account's roots (1.4.20: "approve a code in your browser"), in a terminal the user watches. */
export function museLoginCommand(executable: string, home: string): CommandSpec {
  return { ...toSpawnable(executable, ['login']), env: museEnv(process.env as Record<string, string>, home) }
}
