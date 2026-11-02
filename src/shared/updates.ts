/**
 * Which update Hive takes, and when it installs one (#1647). On 23 Oct a published 0.9.3, downloaded by a running 0.9.2,
 * was installed when that Hive quit, and the user's local build of 0.9.3 (with fixes the release didn't have) didn't
 * end up installed. A build says what it is (`BuildIdentity`: `npm run dist` marks it local, the release workflow not),
 * versions are compared by semver with prereleases (1.0.0-rc.2 < 1.0.0), a local build is never replaced by a release of
 * its own version (that release is offered, never installed by itself), and a downloaded update is installed only when it
 * is newer than the copy installed on disk as read then, never when that copy can't be read.
 */

/** What a build is: its version, the commit it was built from (null: not known), and whether it was built locally. */
export interface BuildIdentity {
  version: string
  commit: string | null
  local: boolean
}

/**
 * The copy of Hive installed on disk, as read when an update would be installed: `known` (`legacy`: from before builds
 * said what they are, so a release), or `unreadable` (missing, malformed or inconsistent: changing under the read, say).
 */
export type InstalledCopy = { kind: 'known'; identity: BuildIdentity; legacy?: true } | { kind: 'unreadable'; why: string }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** A version's parts, or null when it isn't semver. */
function parse(v: string): { core: [number, number, number]; pre: string[] } | null {
  const m = SEMVER.exec(v.trim())
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/**
 * Semver precedence (semver.org §11): below 0, a is older; 0, the same; above 0, newer. A prerelease is older than its
 * release (1.0.0-rc.2 < 1.0.0), its identifiers compared in turn (numbers as numbers, below text). Null when either isn't
 * a version: never compared as text.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/**
 * What a check does with the release it found: `update` (newer: downloaded and installed as the settings say), `offer`
 * (the running build is local and the release is its own version: offered, never downloaded or installed by itself), or
 * `none` (older, the same release, or not a version).
 */
export function updateDecision(running: BuildIdentity, published: string): 'update' | 'offer' | 'none' {
  const c = compareVersions(published, running.version)
  if (c === null) return 'none'
  if (c > 0) return 'update'
  return c === 0 && running.local ? 'offer' : 'none'
}

/**
 * Whether a downloaded update (`pending`, its version) is installed over the copy on disk: only when that copy was read
 * and the update is newer by semver. A copy that couldn't be read never lets it install (it may be a newer local build,
 * installed meanwhile), and neither does one of its own version or newer.
 */
export function installDecision(installed: InstalledCopy, pending: string): { install: true } | { install: false; why: 'unreadable' | 'notNewer' } {
  if (installed.kind === 'unreadable') return { install: false, why: 'unreadable' } // i18n-ignore: an internal value
  const c = compareVersions(pending, installed.identity.version)
  return c !== null && c > 0 ? { install: true } : { install: false, why: 'notNewer' } // i18n-ignore: an internal value
}

/** A build identity file's content (build-identity.json), checked; null when it isn't one. */
export function readBuildIdentity(v: unknown): BuildIdentity | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.version !== 'string' || !parse(o.version) || typeof o.local !== 'boolean') return null
  if (o.commit !== null && o.commit !== undefined && (typeof o.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(o.commit))) return null
  return { version: o.version, commit: typeof o.commit === 'string' ? o.commit : null, local: o.local }
}
