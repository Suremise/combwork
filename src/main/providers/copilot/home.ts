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

/** `--no-auto-update` for a Copilot run, unless its switch is off. */
export const noAutoUpdateArgs = (): string[] => (noAutoUpdate() ? ['--no-auto-update'] : [])

/** A child environment for Copilot: without COPILOT_ENV_STRIP, and never updating itself while Hive runs it (noAutoUpdate). */
export function copilotEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const k of Object.keys(out)) if (COPILOT_ENV_STRIP.includes(k.toUpperCase())) delete out[k]
  // A downloaded update applies at the next launch, between a session's restarts; Hive's Update does it on purpose.
  // Switched off, the user's own COPILOT_AUTO_UPDATE (if any) is left as it is.
  if (noAutoUpdate()) out.COPILOT_AUTO_UPDATE = 'false'
  return out
}
