import { app } from 'electron'
import { appendFile, readFile } from 'original-fs/promises'
import { join } from 'path'
import type { AgentInstallInfo, ProviderId, TestedCli } from '../shared/types'
import { createLogger } from './logger'
import { resourcesDir } from './paths'

const log = createLogger('providers')

/**
 * The CLI versions this Combwork release was tested with (#365): resources/tested-clis.json, made from the real tier's run
 * record before a release (`npm run tested-clis`, RELEASING.md), never by hand. Keyed by provider id: `{ "<id>":
 * { "version", "testedAt", "record" } }`. Unpackaged builds can be given another file (CW_TEST_TESTED_CLIS) for tests.
 * Read on every provider refresh (Check again), since it is small.
 */
export async function testedVersion(id: ProviderId): Promise<{ version: string; testedAt: string } | null> {
  const file = (!app.isPackaged && process.env.CW_TEST_TESTED_CLIS) || join(resourcesDir(), 'tested-clis.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    // Missing in a build made without one: nothing to compare with.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn("Couldn't read the tested CLI versions", e)
    return null
  }
  const entry = manifest && typeof manifest === 'object' ? (manifest as Record<string, unknown>)[id] : null
  if (!entry || typeof entry !== 'object') return null
  const { version, testedAt } = entry as Record<string, unknown>
  return typeof version === 'string' && version ? { version, testedAt: typeof testedAt === 'string' ? testedAt : '' } : null
}

/**
 * A test copy of Combwork (unpackaged, with a test profile) notes the CLI it selected, a JSON line per check, in
 * CW_TEST_CLI_LOG (the e2e runner gives each suite one): the run record's real CLIs are what Combwork itself chose, the
 * standalone CLI its detection accepted, never a copy it rejected (#365), and the home it runs in (its sign-in and
 * config, #368: the record names each real suite's). Never in an installed Combwork.
 */
export async function noteSelectedCli(info: AgentInstallInfo, home: string | null = null): Promise<void> {
  const file = !app.isPackaged && process.env.CW_USER_DATA ? process.env.CW_TEST_CLI_LOG : undefined
  if (!file || !info.found || !info.version) return
  await appendFile(file, `${JSON.stringify({ provider: info.provider, version: info.version, path: info.path, home })}\n`).catch((e) => log.warn("Couldn't note the selected CLI", e))
}

/** How the installed version compares with the tested one, by the provider's own version order (`isNewer`). */
export function compareTested(tested: { version: string; testedAt: string }, installed: string | null, isNewer: (a: string, b: string) => boolean): TestedCli {
  const order: TestedCli['installed'] = !installed ? 'unknown' : isNewer(installed, tested.version) ? 'newer' : isNewer(tested.version, installed) ? 'older' : 'same'
  return { ...tested, installed: order }
}
