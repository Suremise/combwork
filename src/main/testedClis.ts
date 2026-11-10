import { app } from 'electron'
import { appendFile, readFile } from 'original-fs/promises'
import { join } from 'path'
import type { AgentInstallInfo, ProviderId, TestedCli } from '../shared/types'
import { createLogger } from './logger'
import { resourcesDir } from './paths'

const log = createLogger('providers')

/** A version this release was tested with, and when. */
export interface TestedVersion {
  version: string
  testedAt: string
  /**
   * Other versions tested at the same commit (HI-2780: Copilot 1.0.106 beside 1.0.107, while WinGet offered only 1.0.106),
   * each from its own passing real-tier record (`npm run tested-clis -- --also <cli>`): an installed one of them is tested too.
   */
  also?: { version: string; testedAt: string }[]
}

/**
 * The CLI versions this Combwork release was tested with (#365): resources/tested-clis.json, made from the real tier's run
 * record before a release (`npm run tested-clis`, RELEASING.md), never by hand. Keyed by provider id: `{ "<id>":
 * { "version", "testedAt", "record", "also"? } }`. Unpackaged builds can be given another file (CW_TEST_TESTED_CLIS) for
 * tests. Read on every provider refresh (Check again), since it is small.
 */
export async function testedVersion(id: ProviderId): Promise<TestedVersion | null> {
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
  const { version, testedAt, also } = entry as Record<string, unknown>
  if (typeof version !== 'string' || !version) return null
  const others = (Array.isArray(also) ? also : []).flatMap((a) => (a && typeof a === 'object' && typeof (a as Record<string, unknown>).version === 'string' && (a as Record<string, unknown>).version ? [{ version: (a as { version: string }).version, testedAt: typeof (a as Record<string, unknown>).testedAt === 'string' ? ((a as { testedAt: string }).testedAt) : '' }] : []))
  return { version, testedAt: typeof testedAt === 'string' ? testedAt : '', ...(others.length ? { also: others } : {}) }
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

/**
 * How the installed version compares with the tested one, by the provider's own version order (`isNewer`). An installed
 * version that is one of the others tested (`also`, HI-2780) is the tested version: it is named as the one tested, so the
 * line reads "Tested with 1.0.106 · installed 1.0.106". Any other is compared with the newest tested.
 */
export function compareTested(tested: TestedVersion, installed: string | null, isNewer: (a: string, b: string) => boolean): TestedCli {
  const same = (v: string): boolean => !!installed && !isNewer(installed, v) && !isNewer(v, installed)
  const other = tested.also?.find((a) => same(a.version))
  if (other) return { version: other.version, testedAt: other.testedAt, installed: 'same' }
  const order: TestedCli['installed'] = !installed ? 'unknown' : isNewer(installed, tested.version) ? 'newer' : isNewer(tested.version, installed) ? 'older' : 'same'
  return { version: tested.version, testedAt: tested.testedAt, installed: order }
}
