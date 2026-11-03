// The dialect-only release path (HI-2442, scripts/dialectRelease.mjs; RELEASING.md, A dialect-only release): refused
// unless only the shipped dialect files changed since the last release, with the version (a patch) and its notes.
// Never by running `npm run release`: the rules over fake git answers, and over a temporary repository's real ones.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { DIALECT_CHECKS, dialectCheckArgs, dialectReleaseProblem, lastReleaseTag } from '../scripts/dialectRelease.mjs'
import { tempDir } from './tempDir'

type Files = Record<string, string>
const pkg = (version: string, extra: object = {}) => JSON.stringify({ name: 'hive-desktop', version, ...extra }, null, 2)
const lock = (version: string, dep = '1.0.0') => JSON.stringify({ name: 'hive-desktop', version, packages: { '': { name: 'hive-desktop', version }, 'node_modules/x': { version: dep } } }, null, 2)
const history = (dialects: object, skills: object = { s: ['a'] }) => JSON.stringify({ skills, modes: { m: ['b'] }, dialects })

/** The rules over two fake trees: the tag's and HEAD's, with what changed between them worked out from both. */
function problem(version: string, before: Files, after: Files, tag: string | null = 'v1.0.0'): string | null {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f])
  const read = (rev: string, path: string) => (rev === 'HEAD' ? after : before)[path] ?? null
  return dialectReleaseProblem({ version, tag, changed, read })
}
const BEFORE: Files = {
  'package.json': pkg('1.0.0'),
  'package-lock.json': lock('1.0.0'),
  'CHANGELOG.md': '# Changelog\n',
  'src/main/bundledHistory.json': history({ 'codex/GPT-6.1 Sol': ['h1'] }),
  'resources/dialects/codex/GPT-6.1 Sol.json': '{"name":"GPT-6.1 Sol","model":"gpt-6.1-sol","texts":{}}',
  'src/main/sessions.ts': 'code',
  'resources/tested-clis.json': '{}'
}
/** A dialect patch as it should be: a dialect file changed, its history recorded, the version and notes. */
const PATCH: Files = {
  ...BEFORE,
  'package.json': pkg('1.0.1'),
  'package-lock.json': lock('1.0.1'),
  'CHANGELOG.md': '# Changelog\n\n## 1.0.1\n',
  'src/main/bundledHistory.json': history({ 'codex/GPT-6.1 Sol': ['h1', 'h2'] }),
  'resources/dialects/codex/GPT-6.1 Sol.json': '{"name":"GPT-6.1 Sol","model":"gpt-6.1-sol","texts":{"x":{"text":"X","why":"HI-2282"}}}'
}

describe('a dialect-only release (scripts/dialectRelease.mjs)', () => {
  it('goes ahead when only dialect files, their history, the version and the notes changed', () => {
    expect(problem('1.0.1', BEFORE, PATCH)).toBeNull()
    // A new dialect file, and nothing but it beside the version.
    expect(problem('1.0.1', BEFORE, { ...BEFORE, 'package.json': pkg('1.0.1'), 'resources/dialects/claude-code/Opus 5.5.json': '{}' })).toBeNull()
  })

  it('is refused when code, a test or the manifest changed', () => {
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'src/main/sessions.ts': 'changed' })).toMatch(/more changed than the dialect files \(src\/main\/sessions\.ts\)/)
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'resources/tested-clis.json': '{"x":1}' })).toMatch(/resources\/tested-clis\.json/)
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'tests/new.test.ts': 'x' })).toMatch(/tests\/new\.test\.ts/)
    // A deleted file is a change too.
    const { 'src/main/sessions.ts': _gone, ...without } = PATCH
    expect(problem('1.0.1', BEFORE, without)).toMatch(/src\/main\/sessions\.ts/)
  })

  it('is refused when the package files changed more than their version', () => {
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'package.json': pkg('1.0.1', { dependencies: { x: '2' } }) })).toMatch(/package\.json changed more than its version/)
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'package-lock.json': lock('1.0.1', '2.0.0') })).toMatch(/package-lock\.json changed more than its version/)
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'package.json': 'not json' })).toMatch(/package\.json changed more than its version/)
  })

  it('is refused when the bundled history records a skill or a mode', () => {
    expect(problem('1.0.1', BEFORE, { ...PATCH, 'src/main/bundledHistory.json': history({ 'codex/GPT-6.1 Sol': ['h1', 'h2'] }, { s: ['a', 'c'] }) })).toMatch(/a skill or a mode changed/)
  })

  it('is a patch of the last release: the version must be its next patch or later, never a pre-release', () => {
    expect(problem('1.0.0', BEFORE, { ...PATCH, 'package.json': pkg('1.0.0'), 'package-lock.json': lock('1.0.0') })).toMatch(/set the version to 1\.0\.1 \(it is 1\.0\.0\)/)
    expect(problem('1.1.0', BEFORE, { ...PATCH, 'package.json': pkg('1.1.0'), 'package-lock.json': lock('1.1.0') })).toMatch(/patch of v1\.0\.0/)
    expect(problem('1.0.1-beta.1', BEFORE, { ...PATCH, 'package.json': pkg('1.0.1-beta.1'), 'package-lock.json': lock('1.0.1-beta.1') })).toMatch(/patch of v1\.0\.0/)
    expect(problem('1.0.2', BEFORE, { ...PATCH, 'package.json': pkg('1.0.2'), 'package-lock.json': lock('1.0.2') })).toBeNull()
  })

  it('is refused with no release before it, or no dialect file changed', () => {
    expect(problem('1.0.1', BEFORE, PATCH, null)).toMatch(/No release tag/)
    expect(problem('1.0.1', BEFORE, { ...BEFORE, 'package.json': pkg('1.0.1'), 'package-lock.json': lock('1.0.1') })).toMatch(/No dialect file changed since v1\.0\.0/)
  })

  it('takes the newest release tag, never a pre-release', () => {
    expect(lastReleaseTag(['v0.9.3', 'v1.0.0-rc.19', 'v1.0.0', 'v0.10.0', 'other', ''])).toBe('v1.0.0')
    expect(lastReleaseTag(['v1.0.10', 'v1.0.9', 'v1.1.0-beta.2'])).toBe('v1.0.10')
    expect(lastReleaseTag(['v1.1.0-beta.1'])).toBeNull()
  })

  it('runs dialect checks that exist, the shipped files’ among them', () => {
    expect(DIALECT_CHECKS).toContain('tests/dialectsShipped.test.ts')
    for (const f of DIALECT_CHECKS as string[]) expect(existsSync(join(__dirname, '..', f)), f).toBe(true)
    // Never from Vitest's module cache: it would keep an old schema's glob (HI-2442 r1).
    expect(dialectCheckArgs()).toEqual(['vitest', 'run', '--fsModuleCache=false', ...DIALECT_CHECKS])
  })
})

describe('a dialect-only release over a real repository (what release.mjs asks git)', () => {
  const dir = tempDir('hive-dialect-release-')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: dir, encoding: 'utf8' })
  const put = (files: Files) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true })
      writeFileSync(join(dir, f), text)
    }
    git('add', '-A')
    git('commit', '-qm', 'c')
  }
  /** As release.mjs works them out: the tag from the tags HEAD contains, what changed since, each file at a revision. */
  const fromGit = () => {
    const tag = lastReleaseTag(git('tag', '--merged', 'HEAD', '--list', 'v*').split(/\r?\n/))
    const changed = git('diff', '--name-only', '--no-renames', tag, 'HEAD').split(/\r?\n/).filter(Boolean)
    const read = (rev: string, path: string) => {
      try {
        return execFileSync('git', ['show', `${rev}:${path}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return null
      }
    }
    return dialectReleaseProblem({ version: JSON.parse(read('HEAD', 'package.json')!).version, tag, changed, read })
  }

  it('finds the last release, and tells a dialect patch from one that changed code', () => {
    git('init', '-q', '-b', 'main')
    put(BEFORE)
    git('tag', 'v1.0.0')
    put({ 'src/main/sessions.ts': 'a fix' })
    git('tag', 'v1.0.1-rc.1')
    put({ 'src/main/sessions.ts': 'a fix, released' })
    git('tag', 'v1.0.1')
    put({ ...PATCH, 'src/main/sessions.ts': 'a fix, released', 'package.json': pkg('1.0.2'), 'package-lock.json': lock('1.0.2') })
    expect(fromGit()).toBeNull()
    // A renamed dialect file is both a deletion and an addition, still only dialect files.
    git('mv', 'resources/dialects/codex/GPT-6.1 Sol.json', 'resources/dialects/codex/Sol.json')
    git('commit', '-qm', 'rename')
    expect(fromGit()).toBeNull()
    put({ 'scripts/release.mjs': 'changed' })
    expect(fromGit()).toMatch(/since v1\.0\.1, more changed than the dialect files \(scripts\/release\.mjs\)/)
  })
})
