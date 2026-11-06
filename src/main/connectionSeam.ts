import { join, resolve } from 'path'
import { app } from 'electron'
import { realpathSync } from 'original-fs'
import type { ProviderId } from '../shared/types'
import { PROVIDERS, providerDescriptor } from '../shared/providers'

/**
 * Whether a provider's sign-in is Combwork's connections' (HI-1755), and the test seam that keeps a test copy on its CLI
 * test home instead. Its own module, so the provider service and adapters can ask without importing the connections
 * themselves.
 */

/**
 * The test seam (DEV_SEAMS: CW_TEST_CLI_HOME_CONNECTION=1): a test copy (unpackaged, with a test profile) given an
 * explicit CLI test home under the provider's home variable (never the user's own: compared by real path, so a junction
 * or 8.3 name of ~/.claude is the user's too) launches as before connections where its workspace has none on: on that
 * test home, with the CLI's own sign-in handling. Never in a packaged Combwork, never on a missing home. The user's home is
 * the CLI's whose home variable it is (HI-1757: ~/.codex for CODEX_HOME).
 */
export function testHomeSeam(homeEnv: string, env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged, userHome = join(app.getPath('home'), userHomeOf(homeEnv))): boolean {
  if (packaged || !env.CW_USER_DATA || env.CW_TEST_CLI_HOME_CONNECTION !== '1') return false
  const home = env[homeEnv]
  if (!home) return false
  const real = (p: string): string => {
    try {
      return realpathSync.native(p).toLowerCase()
    } catch {
      return resolve(p).toLowerCase()
    }
  }
  return real(home) !== real(userHome)
}

/** The folder in the user's own folder of the CLI with this home variable (`.claude` for CLAUDE_CONFIG_DIR). */
function userHomeOf(homeEnv: string): string {
  return PROVIDERS.find((p) => p.capabilities.connections?.homeEnv === homeEnv)?.capabilities.connections?.userHome ?? '.claude'
}

/**
 * Whether the provider's sign-in belongs to its connections (it has them, and the test seam isn't on; since S8, HI-1774,
 * for everyone): its CLI's own home is then never checked or signed in by Combwork, and its settings aren't read for its
 * agents. Copilot has none: its own machine-wide login, as before (HI-1758).
 */
export function connectionsManaged(id: ProviderId, env: NodeJS.ProcessEnv = process.env): boolean {
  const caps = providerDescriptor(id).capabilities.connections
  return !!caps && !testHomeSeam(caps.homeEnv, env)
}
