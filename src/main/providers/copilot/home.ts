import { homedir } from 'os'
import { join } from 'path'
import { COPILOT } from '../../../shared/copilot'
import { overrides } from '../../advancedValues'

/** Copilot's own folder (its config, sessions and logs): COPILOT_HOME, else ~/.copilot. */
export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot')
}

/**
 * Tokens Copilot would sign in with ahead of its own login, set by other tools (GH_TOKEN, GITHUB_TOKEN): taken out of
 * Copilot's environment alone, so a token another tool left in the user's environment never signs Copilot agents in to
 * another account. COPILOT_GITHUB_TOKEN stays: a user sets it on purpose, for Copilot (Darren's decision on #450).
 * Claude Code and Codex agents keep them all (provider envToStrip applies to every child). Readiness (install.ts)
 * reports the sign-in from the same environment.
 */
export const COPILOT_ENV_STRIP = ['GH_TOKEN', 'GITHUB_TOKEN']

/**
 * Whether Hive keeps Copilot from updating itself (#1167): `--no-auto-update` and COPILOT_AUTO_UPDATE=false on every
 * run, unless its switch is off.
 */
export const noAutoUpdate = (): boolean => overrides(COPILOT, 'noAutoUpdate')

/** `--no-auto-update` for a Copilot run, unless its switch is off (`on`: as a launch read it). */
export const noAutoUpdateArgs = (on = noAutoUpdate()): string[] => (on ? ['--no-auto-update'] : [])

/** Whether Hive leaves COPILOT_ENV_STRIP out of Copilot's environment (#1281, #966 row 8), unless its switch is off. */
export const stripsTokens = (): boolean => overrides(COPILOT, 'stripGitHubTokens')

/**
 * A child environment for Copilot: without COPILOT_ENV_STRIP (stripsTokens), and never updating itself while Hive runs
 * it (noAutoUpdate). Every Copilot child gets it (sessions, the sign-in check, the catalogue), so the account Hive shows
 * is the one its sessions sign in with; a launch passes the switches as it read them.
 */
export function copilotEnv(env: Record<string, string>, noUpdate = noAutoUpdate(), strip = stripsTokens()): Record<string, string> {
  const out = { ...env }
  if (strip) for (const k of Object.keys(out)) if (COPILOT_ENV_STRIP.includes(k.toUpperCase())) delete out[k]
  // A downloaded update applies at the next launch, between a session's restarts; Hive's Update does it on purpose.
  // Switched off, the user's own COPILOT_AUTO_UPDATE (if any) is left as it is.
  if (noUpdate) out.COPILOT_AUTO_UPDATE = 'false'
  return out
}
