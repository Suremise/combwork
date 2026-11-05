/**
 * Builds recorded as facts (#1534, #1062): `npm run dist` and `npm run release` (scripts/buildFact.mjs) tell Hive of each
 * successful build, through the Agent API (`POST /v1/builds`) while Hive is running, else by a marker file in the
 * workspace's `.combwork/builds` that Hive picks up when the workspace next opens. Hive writes it into the journal as its own
 * fact. Agent-facing English (the journal is the Assistant's).
 */

/** What a build was: a beta, the baseline installed for daily use, a release candidate, or a release (RELEASING.md). */
export const BUILD_KINDS = ['beta', 'baseline', 'rc', 'release'] as const
export type BuildKind = (typeof BUILD_KINDS)[number]

/** Where a build's marker waits for Hive, under the workspace's `.combwork` folder. */
export const BUILD_MARKERS_DIR = 'builds'

/** A successful build, as the scripts send it. */
export interface BuildFact {
  kind: BuildKind
  version: string
  commit: string
  branch: string | null
  installer: string
  /** When it was built (ISO). */
  builtAt: string
  /** The script that made it: dist (local) or release (uploaded as a draft). */
  by: 'dist' | 'release'
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null)

/** A build fact from what was sent or left (a marker), checked; or why it isn't one. */
export function buildFactOf(v: unknown): BuildFact | { error: string } {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  if (!BUILD_KINDS.includes(o.kind as BuildKind)) return { error: `kind is one of: ${BUILD_KINDS.join(', ')}.` }
  const version = text(o.version, 100)
  if (!version) return { error: 'version is required (at most 100 characters).' }
  const commit = typeof o.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(o.commit) ? o.commit.toLowerCase() : null
  if (!commit) return { error: 'commit is a commit id (7 to 64 hex characters).' }
  const installer = text(o.installer, 1000)
  if (!installer) return { error: "installer is the installer's path (at most 1,000 characters)." }
  const builtAt = typeof o.builtAt === 'string' && !Number.isNaN(Date.parse(o.builtAt)) ? new Date(o.builtAt).toISOString() : null
  if (!builtAt) return { error: 'builtAt is a date and time (ISO).' }
  if (o.by !== 'dist' && o.by !== 'release') return { error: 'by is dist or release.' }
  return { kind: o.kind as BuildKind, version, commit, branch: o.branch === null || o.branch === undefined ? null : text(o.branch, 200), installer, builtAt, by: o.by }
}

const KIND_WORDS: Record<BuildKind, string> = { beta: 'beta', baseline: 'baseline', rc: 'release candidate', release: 'release' }

/** The journal entry's one line: "Built Combwork 1.1.0-rc.1 (baseline) from 1fef5341 on 1.1.0". */
export function buildFactSummary(f: BuildFact): string {
  const what = f.by === 'release' ? 'Uploaded a draft of' : 'Built'
  return `${what} Combwork ${f.version} (${KIND_WORDS[f.kind]}) from ${f.commit.slice(0, 8)}${f.branch ? ` on ${f.branch}` : ''}`
}

/** A build fact's one line read back (the window shows it in the user's language, #1534 round 1), or null for another line. */
export function parseBuildSummary(summary: string): { by: BuildFact['by']; version: string; kind: BuildKind; commit: string; branch: string | null } | null {
  const m = /^(Built|Uploaded a draft of) Combwork (\S+) \((beta|baseline|release candidate|release)\) from ([0-9a-f]{7,64})(?: on (.+))?$/.exec(summary)
  if (!m) return null
  const kind = (Object.keys(KIND_WORDS) as BuildKind[]).find((k) => KIND_WORDS[k] === m[3])!
  return { by: m[1] === 'Built' ? 'dist' : 'release', version: m[2], kind, commit: m[4], branch: m[5] ?? null }
}

/** The detail Hive writes for a build fact. */
export function buildFactDetail(f: Pick<BuildFact, 'installer' | 'builtAt' | 'by'>): string {
  return `Installer: ${f.installer}\nBuilt: ${f.builtAt}${f.by === 'release' ? '\nUploaded to a draft GitHub release (npm run release).' : ''}`
}

/** A build fact's detail read back, or null for another detail. */
export function parseBuildDetail(detail: string): { installer: string; builtAt: string; uploaded: boolean } | null {
  const m = /^Installer: (.+)\r?\nBuilt: (\S+)(\r?\nUploaded to a draft GitHub release \(npm run release\)\.)?$/.exec(detail)
  return m && !Number.isNaN(Date.parse(m[2])) ? { installer: m[1], builtAt: m[2], uploaded: !!m[3] } : null
}
