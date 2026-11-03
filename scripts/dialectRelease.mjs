// The dialect-only release path (HI-2442, decided 1 Nov on HI-2065; plans/2026-11-03-dialects-design.md, section 7):
// `npm run release -- --dialects` is a patch release whose only change since the last release is Hive's shipped dialect
// files (resources/dialects), with the version and its notes. It has lighter checks than a full release (RELEASING.md,
// A dialect-only release), so it must prove that nothing else changed: no code, no test, no manifest. These are the
// rules, pure over what git says (release.mjs asks git; tests/dialectRelease.test.ts gives them fakes).

/** Where the shipped dialect files are. */
export const DIALECTS_DIR = 'resources/dialects/'

/**
 * Files a dialect-only release may change beside the dialect files, each checked for what it may change: the release
 * notes, the version (package.json and package-lock.json, nothing else in them), and the bundled history (the new
 * dialect versions `npm run bundled-history` records, nothing of the skills or modes).
 */
export const DIALECT_RELEASE_ALSO = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'src/main/bundledHistory.json']

/** The unit tests a dialect-only release runs before it builds: the shipped files, the service that loads them, the bundled sync. */
export const DIALECT_CHECKS = ['tests/dialectsShipped.test.ts', 'tests/dialects.test.ts', 'tests/bundled.test.ts']

const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/

/** The newest release tag (`v1.0.0`, never a pre-release's) of those given (the tags HEAD contains), or null. */
export function lastReleaseTag(tags) {
  const parsed = tags
    .map((t) => ({ t, m: RELEASE.exec(t.trim()) }))
    .filter((x) => x.m)
    .map(({ t, m }) => ({ t: t.trim(), v: m.slice(1).map(Number) }))
  parsed.sort((a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2])
  return parsed.at(-1)?.t ?? null
}

const parse = (text) => {
  try {
    return text == null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

/** A package file without the fields a version change sets: its version, and package-lock's own entry's. */
function withoutVersion(file, lock) {
  const out = structuredClone(file)
  delete out.version
  if (lock && out.packages?.['']) delete out.packages[''].version
  return JSON.stringify(out)
}

/**
 * Why HEAD can't be released as a dialect-only patch, or null when it can.
 * - `version`: package.json's version at HEAD;
 * - `tag`: the last release's tag (lastReleaseTag), or null;
 * - `changed`: the paths changed between the tag and HEAD (renames as both paths);
 * - `read(rev, path)`: a file's text at `rev` (the tag, or 'HEAD'), or null when it isn't there.
 */
export function dialectReleaseProblem({ version, tag, changed, read }) {
  if (!tag) return 'No release tag (v<major>.<minor>.<patch>) comes before this commit: a dialect-only release is a patch of a release. Fetch the tags (git fetch --tags), or make a full release.'
  const [maj, min, patch] = RELEASE.exec(tag).slice(1).map(Number)
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  if (!v || Number(v[1]) !== maj || Number(v[2]) !== min || Number(v[3]) <= patch)
    return `A dialect-only release is a patch of ${tag}: set the version to ${maj}.${min}.${patch + 1} (it is ${version}).`
  const others = changed.filter((f) => !f.startsWith(DIALECTS_DIR) && !DIALECT_RELEASE_ALSO.includes(f))
  if (others.length) return `Not a dialect-only release: since ${tag}, more changed than the dialect files (${others.join(', ')}). Make a full release (RELEASING.md, Steps).`
  if (!changed.some((f) => f.startsWith(DIALECTS_DIR))) return `No dialect file changed since ${tag}: there is nothing for a dialect-only release to ship.`
  for (const [file, lock] of [['package.json', false], ['package-lock.json', true]]) {
    if (!changed.includes(file)) continue
    const before = parse(read(tag, file))
    const after = parse(read('HEAD', file))
    if (!before || !after || withoutVersion(before, lock) !== withoutVersion(after, lock))
      return `Not a dialect-only release: ${file} changed more than its version since ${tag}. Make a full release (RELEASING.md, Steps).`
  }
  const history = 'src/main/bundledHistory.json'
  if (changed.includes(history)) {
    const before = parse(read(tag, history))
    const after = parse(read('HEAD', history))
    const same = (k) => JSON.stringify(before?.[k] ?? {}) === JSON.stringify(after?.[k] ?? {})
    if (!before || !after || !same('skills') || !same('modes'))
      return `Not a dialect-only release: ${history} records more than dialect files since ${tag} (a skill or a mode changed). Make a full release (RELEASING.md, Steps).`
  }
  return null
}
