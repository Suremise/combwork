import { join } from 'path'
import { MUSE } from '../../../shared/providers/muse'
import { overrides } from '../../advancedValues'
import { testHomeSeam } from '../../connectionSeam'
import { localDataRoot } from '../localData'

// Muse Code's environment (HI-3202, checked against 1.4.20): an account's two roots, and the variables that would stand in
// for the account's own sign-in. Muse reads its settings, trust, auth.json and personal skills from <XDG_CONFIG_HOME>\muse
// and keeps its sessions, plugins and bundled skills in <XDG_DATA_HOME>\muse (the offline probes' homes); both are set
// for every run on an account, last, so nothing inherited repoints them. The user's own ~\.config\muse and
// ~\.local\share\muse are never used.

/** The variable Muse's data root is in (its sessions): an account's folder (capabilities.connections.homeEnv). */
export const DATA_ENV = 'XDG_DATA_HOME'

/** An account's roots: its folder is Muse's data root, its config root a folder of its own inside it. */
export function museRoots(home: string): Record<string, string> {
  return { XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, 'xdg-config') }
}

/** Where Muse keeps an account's settings, trust, sign-in (auth.json) and personal skills. */
export const museConfigDir = (home: string): string => join(home, 'xdg-config', 'muse')

/** Where Muse keeps an account's sessions: sessions\YYYY\MM\DD\<id>\session.jsonl beneath it. */
export const museDataDir = (home: string): string => join(home, 'muse')

/**
 * The data root a launch or check runs on: its account's folder; a test copy's Muse test home (the seam,
 * connectionSeam.ts) where it has none; else Combwork's own root. Never the user's own.
 */
export function museHome(connectionHome: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string {
  if (connectionHome) return connectionHome
  if (testHomeSeam(DATA_ENV, env) && env[DATA_ENV]) return env[DATA_ENV]!
  return join(localDataRoot(), 'muse', 'default')
}

/** Combwork keeps META_API_KEY and MUSE_CUSTOM_HEADERS away from Muse, unless its switch is off. */
export const stripAccountVars = (): boolean => overrides(MUSE, 'stripAccountVars')

/**
 * The variables that stand in for an account's own sign-in (1.4.20: META_API_KEY "always takes priority over the account
 * login"; MUSE_CUSTOM_HEADERS are sent with each provider request, so they can carry a credential).
 */
export const ACCOUNT_VARS: readonly string[] = ['META_API_KEY', 'MUSE_CUSTOM_HEADERS']

/** Never inherited, whatever the switches: Muse's roots are Combwork's to set. */
const ROOTS = /^XDG_(DATA|CONFIG)_HOME$/i

/**
 * Muse's environment for a run on `home`: what it inherited, without its roots (and, with `strip`, without the account
 * variables), then the account's roots last. Combwork's own CW_ variables are kept.
 */
export function museEnv(base: Record<string, string>, home: string, strip = stripAccountVars()): Record<string, string> {
  const drop = new Set(ACCOUNT_VARS.map((v) => v.toUpperCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (ROOTS.test(k)) continue
    if (strip && drop.has(k.toUpperCase())) continue
    out[k] = v
  }
  return Object.assign(out, museRoots(home))
}
