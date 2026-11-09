import { join } from 'path'
import { OPENCODE } from '../../../shared/opencode'
import { overrides } from '../../advancedValues'
import { advanced } from '../../advanced'
import { testHomeSeam } from '../../connectionSeam'
import { localDataRoot } from '../antigravity/home'

// OpenCode's environment (HI-2759; HI-2758's recipe, checked against 2.2.6): an account's private roots, the variables
// that would hand OpenCode a credential nobody chose for it, the ambient credential files those chains would read, and
// Combwork's own protected values, set last so nothing inherited or chosen can repoint them.

/** The variable OpenCode's data root is in (its database, credentials and sessions): an account's folder (capabilities.connections). */
export const DATA_ENV = 'XDG_DATA_HOME'

/** An account's roots: its folder is OpenCode's data root, its config, state and cache roots in folders of their own beside it. */
export function opencodeRoots(home: string): Record<string, string> {
  return {
    XDG_DATA_HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
    XDG_STATE_HOME: join(home, 'xdg-state'),
    XDG_CACHE_HOME: join(home, 'xdg-cache')
  }
}

/**
 * The data root a launch or check runs on: its account's folder; a test copy's OpenCode test home (the seam,
 * connectionSeam.ts) where it has none; else Combwork's own root. Never the user's own (~\.local\share\opencode), its
 * database, its migration or its machine-wide service.
 */
export function opencodeHome(connectionHome: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string {
  if (connectionHome) return connectionHome
  if (testHomeSeam(DATA_ENV, env) && env[DATA_ENV]) return env[DATA_ENV]!
  return join(localDataRoot(), 'opencode', 'default')
}

/** Combwork keeps OpenCode from updating itself (update: "disable" and OPENCODE_DISABLE_AUTOUPDATE=1), unless its switch is off. */
export const noAutoUpdate = (): boolean => overrides(OPENCODE, 'noAutoUpdate')
/** Combwork keeps the project's own OpenCode config and Claude Code's folders out (the two discovery switches), unless its switch is off. */
export const keepProjectConfigOut = (): boolean => overrides(OPENCODE, 'keepProjectConfigOut')
/** Combwork leaves provider credentials out of OpenCode's environment and blocks ambient credential chains, unless its switch is off. */
export const stripCredentials = (): boolean => overrides(OPENCODE, 'stripCredentials')

/** The variables OpenCode could read as a provider's credential or root (its integrations' env names, the clouds' families). */
export function credentialPattern(): RegExp {
  try {
    return advanced.pattern('opencode.env.credentials')
  } catch {
    return FALLBACK_CREDENTIALS
  }
}
const FALLBACK_CREDENTIALS = /^(AWS_|AZURE_|AZD_|GOOGLE_|GCLOUD|CLOUDSDK_|VERTEX|OPENCODE_|XDG_)|_(API_?KEY|TOKEN|PAT|KEY|SECRET)$/i

/** The integrations whose credential chains read what the PC already has (2.2.6's `external` methods, and azure's `az`). */
export function ambientIntegrations(): string[] {
  try {
    return advanced.get<string[]>('opencode.ambient.integrations')
  } catch {
    return ['amazon-bedrock', 'google-vertex', 'azure']
  }
}

/**
 * The variables that point the ambient credential chains at nothing (defence in depth: the policy denying those
 * integrations is what keeps them from running, HI-2759 design s13). `ambient`: a folder of the launch's own, holding the
 * empty files and folders. An integration the account chose an ambient method for keeps its chain (`chosen`).
 */
export function ambientBlockers(ambient: string, chosen: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {}
  if (!chosen.has('amazon-bedrock')) {
    out.AWS_SHARED_CREDENTIALS_FILE = join(ambient, 'aws-credentials')
    out.AWS_CONFIG_FILE = join(ambient, 'aws-config')
    out.AWS_EC2_METADATA_DISABLED = 'true'
  }
  if (!chosen.has('google-vertex')) {
    out.CLOUDSDK_CONFIG = join(ambient, 'gcloud')
    out.METADATA_SERVER_DETECTION = 'none'
    out.NO_GCE_CHECK = 'true'
  }
  if (!chosen.has('azure')) {
    out.AZURE_CONFIG_DIR = join(ambient, 'azure')
    out.AZD_CONFIG_DIR = join(ambient, 'azd')
  }
  return out
}

/** The files and folders ambientBlockers points at, to make empty in its folder. */
export const AMBIENT_FILES = ['aws-credentials', 'aws-config'] as const
export const AMBIENT_DIRS = ['gcloud', 'azure', 'azd'] as const

export interface OpencodeEnvInput {
  /** The environment as the launch or check was given it (inherited, plus Combwork's own CW_ variables). */
  base: Record<string, string>
  /** The account's data root (opencodeHome). */
  home: string
  /** The private config folder (OPENCODE_CONFIG_DIR). */
  configDir: string
  /** The server's per-launch password; absent for a check (a standalone command makes its own). */
  password?: string
  /** The folder ambientBlockers points into; absent: no blockers (a sign-in, which the user drives on purpose). */
  ambientDir?: string
  /** Integrations the account chose an ambient method for (their blockers left out). */
  chosen?: ReadonlySet<string>
  noUpdate?: boolean
  keepOut?: boolean
  strip?: boolean
}

/**
 * OpenCode's environment, in a fixed order (HI-2759 design s10):
 * 1. what it inherited, without the variables it could read as a credential or a root (unless `strip` is off; its roots
 *    and Combwork's own values are never inherited either way);
 * 2. the ambient blockers (with `strip`);
 * 3. Combwork's protected values last: the account's roots, the private config folder, the server's password, the
 *    discovery switches and the update hold, so nothing inherited or chosen repoints them.
 * Combwork's own CW_ variables are kept.
 */
export function opencodeEnv(i: OpencodeEnvInput): Record<string, string> {
  const strip = i.strip ?? stripCredentials()
  const pattern = credentialPattern()
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.base)) {
    const name = k.toUpperCase()
    if (name.startsWith('CW_')) {
      out[k] = v
      continue
    }
    if (PROTECTED_FAMILY.test(name)) continue
    if (strip && pattern.test(name)) continue
    out[k] = v
  }
  if (strip && i.ambientDir) Object.assign(out, ambientBlockers(i.ambientDir, i.chosen))
  Object.assign(out, opencodeRoots(i.home), { OPENCODE_CONFIG_DIR: i.configDir })
  if (i.password) out.OPENCODE_PASSWORD = i.password
  if (i.keepOut ?? keepProjectConfigOut()) {
    out.OPENCODE_DISABLE_PROJECT_CONFIG = '1'
    out.OPENCODE_DISABLE_CLAUDE_CODE = '1'
  }
  if (i.noUpdate ?? noAutoUpdate()) out.OPENCODE_DISABLE_AUTOUPDATE = '1'
  return out
}

/** Never inherited, whatever the switches: OpenCode's own variables and roots are Combwork's to set. */
const PROTECTED_FAMILY = /^(OPENCODE_|XDG_(DATA|CONFIG|STATE|CACHE)_HOME$)/
