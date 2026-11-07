import { homedir } from 'os'
import { app } from 'electron'
import { profileFolder } from '../../../shared/appName'
import { localProfileInUse } from '../../profileFolders'
import { join } from 'path'
import { ANTIGRAVITY } from '../../../shared/antigravity'
import { overrides } from '../../advancedValues'

// The Antigravity CLI's environment and its agents' private profiles (HI-2544, from HI-2543's runs on 1.5.0).

/**
 * Variables that would switch agy to another account or provider unasked (HI-2448: GEMINI_API_KEY is read when its
 * modelProvider is "gemini"; AGY_ADC_AUTH turns on Application Default Credentials; AGY_ACCOUNT, among 1.5.0's own
 * variables, picks an account): taken out of agy's environment alone, unless its switch is off. A connection's own values
 * (set on purpose) are put back after (antigravityEnv's `own`).
 */
export const ANTIGRAVITY_ENV_STRIP = ['GEMINI_API_KEY', 'AGY_ADC_AUTH', 'AGY_ACCOUNT']

/** Whether Combwork keeps agy from updating itself (AGY_CLI_DISABLE_AUTO_UPDATE=true on every run), unless its switch is off. */
export const noAutoUpdate = (): boolean => overrides(ANTIGRAVITY, 'noAutoUpdate')

/** Whether Combwork leaves ANTIGRAVITY_ENV_STRIP out of agy's environment, unless its switch is off. */
export const stripsAccountVars = (): boolean => overrides(ANTIGRAVITY, 'stripAccountVars')

/**
 * A child environment for agy: without ANTIGRAVITY_ENV_STRIP (unless `strip` is off; `own` puts back what a connection
 * sets on purpose), and never updating itself while Combwork runs it (unless `noUpdate` is off: the user's own value is
 * then left as it is). Every agy child gets it: sessions, the readiness check and the catalog.
 */
export function antigravityEnv(env: Record<string, string>, noUpdate = noAutoUpdate(), strip = stripsAccountVars(), own: Record<string, string> = {}): Record<string, string> {
  const out = { ...env }
  if (strip) for (const k of Object.keys(out)) if (ANTIGRAVITY_ENV_STRIP.includes(k.toUpperCase())) delete out[k]
  for (const [k, v] of Object.entries(own)) out[k] = v
  if (noUpdate) out.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return out
}

/**
 * agy in an agent's private profile: agy reads its home (~\.gemini) from USERPROFILE alone, never HOME (checked with 1.5.0:
 * with both set to different folders, `agy mcp list` read the USERPROFILE one). So USERPROFILE is the profile, and HOME
 * is the user's real one (unless their environment sets it already), for git, Git Bash and ssh in the agent's own tools.
 */
export function inProfile(env: Record<string, string>, profile: string, realHome: string = homedir()): Record<string, string> {
  const out = { ...env }
  const home = Object.keys(out).find((k) => k.toUpperCase() === 'HOME')
  if (!home || !out[home]) out.HOME = realHome
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'USERPROFILE') delete out[k]
  out.USERPROFILE = profile
  return out
}

/**
 * Combwork's local data folder (%LOCALAPPDATA%\Combwork, or a test copy's), as accounts.ts's accountsRoot finds it, whose
 * `accounts` sits beside the profiles: computed here, since accounts.ts reaches the providers (an import cycle).
 */
export function localDataRoot(): string {
  const inUse = localProfileInUse()
  if (inUse) return inUse
  if (process.env.CW_USER_DATA) return process.env.CW_USER_DATA
  const local = process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local')
  return join(local, profileFolder(app.isPackaged))
}

/**
 * The folder of every agent's private profile, under Combwork's local data. A profile is keyed by the agent's own id
 * (random, so a moved project or workspace finds it unchanged; the Assistant's key adds its workspace), and kept between
 * launches: agy keeps the agent's conversations in it.
 */
export const profilesRoot = (): string => join(localDataRoot(), 'antigravity', 'profiles')

/** Where agy keeps an agent's conversations in its profile: brain\<conversation id>. */
export const brainDir = (profile: string): string => join(profile, '.gemini', 'antigravity-cli', 'brain')
