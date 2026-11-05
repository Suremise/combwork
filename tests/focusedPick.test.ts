// The hive project's focused-test picker (HI-1367): `node tests/e2e/affected.mjs --pick`, which Combwork's merge queue runs
// as the project's focused.pick. Which unit tests and e2e suites a change needs: the e2e suites are affectedSuites'
// (tests/e2esuites.test.ts checks those), the unit tests a changed test, Vitest's import graph, and UNIT_SCANS for the
// tests that read the repository rather than import it. These check the table can't drift from the tests, and replay
// changes that broke such a test once (from their commits' file lists, so no history is needed).
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { isRealCli } from './e2e/runner.mjs'
// @ts-expect-error: plain .mjs modules without types
import { UNIT_SCANS, diffLinesOf, isUnitTestFile, needsLines, pickLines, pickTests, scanSelects, unitPicks, under } from './e2e/affected.mjs'
import { tempDir } from './tempDir'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')

type Suite = { name: string; needs?: string[] }
type Scan = { test: string; paths?: string[]; adds?: boolean; lines?: string[] }
type Picked = { every?: true; tests?: { test: string; needs: string[] }[]; why: string[] }
const scans = UNIT_SCANS as Scan[]
const suites = (SUITES as Suite[]).map((s) => s.name)
const realNames = (SUITES as Suite[]).filter(isRealCli).map((s) => s.name)
const packagedNames = (SUITES as Suite[]).filter((s) => (s.needs ?? []).includes('packaged')).map((s) => s.name)
const pick = (input: { paths: string[]; added?: string[]; deleted?: string[]; diffLines?: Record<string, string[]>; vitestRelated?: string[] }): Picked => pickTests({ ...input, suites, realNames, packagedNames })
const units = (input: { paths: string[]; added?: string[]; deleted?: string[]; diffLines?: Record<string, string[]>; vitestRelated?: string[] }): string[] => [...(unitPicks(input) as Map<string, string>).keys()]

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a test file reads the repository by `git ls-files` or a folder scan (readdirSync, readdir, globSync, glob),
 * and so must be in UNIT_SCANS. Repository paths are the names bound (const or let, every binding of the name) to an
 * expression naming __dirname or another such name, and no temp folder. A file scans the repository when it names
 * `ls-files` and binds such a name, or calls a scan with an argument naming one, or calls (or maps over a repository
 * name with) a function of its own whose scan takes that function's parameter.
 */
function scansRepository(src: string): string | null {
  const bindings = new Map<string, string[]>()
  for (const m of src.matchAll(/\b(?:const|let)\s+(\w+)(?:\s*:[^=\n]+)?\s*=\s*([^\n]*)/g)) bindings.set(m[1], [...(bindings.get(m[1]) ?? []), m[2]])
  const bound = new Set<string>()
  const names = (text: string): boolean => /__dirname|import\.meta\.dirname/.test(text) || [...bound].some((n) => new RegExp(`\\b${esc(n)}\\b`).test(text))
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, exprs] of bindings) {
      if (bound.has(name) || !exprs.every((e) => !/tempDir|tmpdir|mkdtemp/.test(e) && names(e))) continue
      bound.add(name)
      grew = true
    }
  }
  if (/['"]ls-files['"]/.test(src) && bound.size) return 'git ls-files'
  const fns = [...src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)|\b(?:const|let)\s+(\w+)\s*=\s*\(([^)]*)\)\s*(?::[^=\n]*)?=>/g)].map((m) => ({
    at: m.index,
    name: m[1] ?? m[3],
    params: (m[2] ?? m[4])
      .split(',')
      .map((p) => p.trim().split(/[\s:=?]/)[0])
      .filter(Boolean)
  }))
  const scanners = new Set<string>()
  for (const c of src.matchAll(/\b(readdirSync|readdir|globSync|glob)\(([^)]*)/g)) {
    if (names(c[2])) return `${c[1]}(${c[2]}`
    const fn = fns.filter((f) => f.at < c.index).at(-1)
    if (fn && fn.params.some((p) => new RegExp(`\\b${esc(p)}\\b`).test(c[2]))) scanners.add(fn.name)
  }
  for (const f of scanners) {
    for (const m of src.matchAll(new RegExp(`\\b${esc(f)}\\(([^)]*)`, 'g'))) if (names(m[1])) return `${f}(${m[1]}`
    for (const m of src.matchAll(new RegExp(`(\\w+)\\.(?:flatMap|map)\\(${esc(f)}\\)`, 'g'))) if (names(m[1])) return `${m[1]}.map(${f})`
  }
  return null
}

describe('UNIT_SCANS: the unit tests that read the repository', () => {
  const testFiles = globSync('tests/**/*.test.ts', { cwd: root }).map((f) => f.replace(/\\/g, '/'))

  it('lists every test file that scans the repository (git ls-files or a folder scan)', () => {
    expect(testFiles.length).toBeGreaterThan(300)
    const listed = new Set(scans.map((e) => e.test))
    const scanning = testFiles.map((f) => ({ f, how: scansRepository(readFileSync(join(root, f), 'utf8')) })).filter((x) => x.how)
    // The heuristic still finds the known kinds: ls-files, a direct scan, and a scan through a helper of the file's own.
    expect(scanning.map((x) => x.f)).toEqual(expect.arrayContaining(['tests/e2esuites.test.ts', 'tests/lineEndings.test.ts', 'tests/i18n.test.ts', 'tests/searchBoxes.test.ts', 'tests/networkDecoding.test.ts']))
    expect(scanning.filter((x) => !listed.has(x.f)).map((x) => `${x.f}: ${x.how}`), 'add it to UNIT_SCANS (tests/e2e/affected.mjs) with the changes that can break it').toEqual([])
  })

  it('finds a scan by each way a test makes one, and not a temp folder or another repository', () => {
    expect(scansRepository("const root = join(__dirname, '..')\nexecFileSync('git', ['ls-files'], { cwd: root })")).toBe('git ls-files')
    expect(scansRepository("const SKILLS = join(__dirname, '..', 'resources', 'skills')\nfor (const n of readdirSync(SKILLS)) {}")).toMatch(/^readdirSync/)
    expect(scansRepository("const ROOT = resolve(__dirname, '..')\nconst SRC = join(ROOT, 'src')\nconst files = (dir: string): string[] => readdirSync(dir).map((f) => f)\nfiles(SRC)")).toMatch(/^files\(SRC/)
    expect(scansRepository("const SRC = join(__dirname, 'src')\nconst ROOTS = ['a'].map((d) => join(SRC, d))\nfunction sources(dir: string) { return readdirSync(dir) }\nROOTS.flatMap(sources)")).toMatch(/ROOTS\.map\(sources\)/)
    expect(scansRepository("const dir = tempDir('x-')\nconst here = __dirname\nexpect(readdirSync(dir)).toEqual([])")).toBeNull()
    expect(scansRepository("const git = (p: string, ...a: string[]) => execFileSync('git', a, { cwd: p })\ngit(p, 'ls-files')")).toBeNull()
  })

  it('names test files that exist, paths that exist, and patterns that compile', () => {
    for (const e of scans) {
      expect(existsSync(join(root, e.test)), e.test).toBe(true)
      expect(isUnitTestFile(e.test), e.test).toBe(true)
      for (const p of e.paths ?? []) expect(existsSync(join(root, p.replace(/\/$/, ''))), `${e.test}: ${p}`).toBe(true)
      for (const l of e.lines ?? []) expect(() => new RegExp(l, 'i'), `${e.test}: ${l}`).not.toThrow()
    }
  })

  it('an entry selects by its paths, then an added or removed file (adds), a line it checks (lines), or any change', () => {
    const e = { test: 'tests/x.test.ts', paths: ['src/'], lines: ['CW_TEST_'] }
    expect(scanSelects(e, 'src/main/a.ts', { lines: ['  const day = Number(process.env.CW_TEST_DAY_MS)'] })).toBe(true)
    expect(scanSelects(e, 'src/main/a.ts', { lines: ['  const day = 86_400_000'] })).toBe(false)
    expect(scanSelects(e, 'tests/a.ts', { lines: ['CW_TEST_X'] })).toBe(false)
    expect(scanSelects({ test: 'tests/x.test.ts', adds: true }, 'docs/new.md', { moved: true })).toBe(true)
    expect(scanSelects({ test: 'tests/x.test.ts', adds: true }, 'docs/old.md', { moved: false })).toBe(false)
    expect(scanSelects({ test: 'tests/x.test.ts', paths: ['docs/USER_GUIDE.md'] }, 'docs/USER_GUIDE.md')).toBe(true)
    // Every file's lines: controlCharacters checks them all.
    expect(needsLines('src/main/trash.ts')).toBe(true)
    expect(needsLines('docs/SPEC.md')).toBe(true)
    // Any change at all selects lineEndings (every text file), and a guide's change the tests that read it.
    expect(units({ paths: ['CONTRIBUTING.md'] })).toEqual(['tests/lineEndings.test.ts'])
    expect(units({ paths: ['README.md'] })).toEqual(['tests/lineEndings.test.ts', 'tests/userGuide.test.ts'])
  })
})

describe('the tests a change needs (pickTests)', () => {
  it('HI-1880 (531f9a519): worker scripts added and suites.mjs changed select tests/e2esuites.test.ts', () => {
    const paths = ['src/main/diagnostics.ts', 'src/main/fsutil.ts', 'src/main/git.ts', 'src/main/logger.ts', 'src/main/mainStalls.ts', 'src/main/places.ts', 'src/main/providers/conversation.ts', 'src/main/providers/copilot/events.ts', 'src/main/repoLock.ts', 'src/main/usageHistory.ts', 'src/main/walCheckpoint.ts', 'src/main/workerThreads.ts', 'tests/e2e/packaged-workers.cjs', 'tests/e2e/suites.mjs', 'tests/workerImports.test.ts']
    const added = ['src/main/places.ts', 'src/main/workerThreads.ts', 'tests/e2e/packaged-workers.cjs', 'tests/workerImports.test.ts']
    expect(units({ paths, added })).toEqual(expect.arrayContaining(['tests/e2esuites.test.ts', 'tests/workerImports.test.ts']))
    // Its fsutil.ts and logger.ts are shared by every part of Combwork: the whole change needs every test.
    expect(pick({ paths, added })).toMatchObject({ every: true })
  })

  it('HI-1866 (fd860b662): a new src/main file and a changed suite select tests/e2esuites.test.ts', () => {
    const paths = ['CHANGELOG.md', 'docs/USER_GUIDE.md', 'locales/de/service.json', 'locales/en/service.json', 'resources/skills/card-loop/SKILL.md', 'src/main/assistantAsk.ts', 'src/main/bundledHistory.json', 'src/main/index.ts', 'src/main/mcp/cw-mcp.ts', 'src/shared/toolReplies.ts', 'tests/assistantAsk.test.ts', 'tests/e2e/intents.cjs', 'tests/e2e/replysize.cjs', 'tests/laneWatch.test.ts', 'tests/scenarios/scenarios.cjs']
    const added = ['src/main/assistantAsk.ts', 'tests/assistantAsk.test.ts']
    expect(units({ paths, added })).toEqual(expect.arrayContaining(['tests/e2esuites.test.ts', 'tests/assistantAsk.test.ts', 'tests/laneWatch.test.ts', 'tests/guidance.test.ts', 'tests/tips.test.ts', 'tests/userGuide.test.ts', 'tests/i18n.test.ts', 'tests/bundled.test.ts']))
    // A new file alone, no suite file changed, still selects it (every AREAS path, every tracked file placed).
    expect(units({ paths: ['src/main/assistantAsk.ts'], added: ['src/main/assistantAsk.ts'] })).toContain('tests/e2esuites.test.ts')
  })

  it('HI-1842 (c17ae27a2): a src/main file deleted selects tests/e2esuites.test.ts', () => {
    const paths = ['.oxlintrc.json', 'docs/ARCHITECTURE.md', 'docs/SPEC.md', 'electron.vite.config.ts', 'src/main/cardAttachmentCleanup.ts', 'src/main/cardCleanupFs.ts', 'src/main/cardCleanupWorker.ts', 'src/main/tasks.ts', 'src/main/workerThreads.ts', 'tests/cardCleanup.test.ts']
    const deleted = ['src/main/cardCleanupWorker.ts']
    expect(units({ paths, deleted })).toEqual(expect.arrayContaining(['tests/e2esuites.test.ts', 'tests/cardCleanup.test.ts']))
    expect(units({ paths: ['src/main/cardCleanupWorker.ts'], deleted })).toContain('tests/e2esuites.test.ts')
    expect(units({ paths: ['src/main/cardCleanupWorker.ts'] })).not.toContain('tests/e2esuites.test.ts')
  })

  it('HI-1870 (2ff56ac20): src/shared/advanced.ts selects settingsWorkspace and advanced; codexConnections comes from the import graph', () => {
    const paths = ['src/main/accounts.ts', 'src/main/serverConnections.ts', 'src/shared/accounts.ts', 'src/shared/advanced.ts', 'src/shared/codex.ts', 'tests/accounts.test.ts', 'tests/codex.test.ts', 'tests/fixtures/advanced/onboarding-claude-2.1.311.jsonl']
    const added = ['tests/fixtures/advanced/onboarding-claude-2.1.311.jsonl']
    expect(units({ paths, added })).toEqual(expect.arrayContaining(['tests/settingsWorkspace.test.ts', 'tests/advanced.test.ts', 'tests/accounts.test.ts', 'tests/codex.test.ts']))
    // tests/codexConnections.test.ts imports src/shared/codex.ts and accounts.ts: `vitest list --changed` (the CLI's
    // vitestRelated) names it, and the picker takes what it names.
    expect(units({ paths, added, vitestRelated: ['tests/codexConnections.test.ts', 'tests/e2e/lib.cjs'] })).toEqual(expect.arrayContaining(['tests/codexConnections.test.ts']))
    expect(units({ paths, added, vitestRelated: ['tests/codexConnections.test.ts', 'tests/e2e/lib.cjs'] })).not.toContain('tests/e2e/lib.cjs')
  })

  it('a CW_TEST_ seam read added to an existing src/main file selects tests/e2esuites.test.ts (git diff -U0 of a real change)', () => {
    const repo = tempDir('cw-focused-pick-')
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Hive Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, env: runContext.baseEnv(), encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    const file = 'src/main/usageHistory.ts'
    const write = (text: string): void => {
      mkdirSync(join(repo, 'src', 'main'), { recursive: true })
      writeFileSync(join(repo, file), text)
    }
    write('export const DAY_MS = 86_400_000\n')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD').trim()
    write("export const DAY_MS = Number(process.env.CW_TEST_DAY_MS) || 86_400_000\n")
    const diffLines = diffLinesOf(git('diff', '--no-ext-diff', '--no-color', '--no-renames', '-U0', base, '--')) as Record<string, string[]>
    expect(diffLines[file]).toEqual(['export const DAY_MS = 86_400_000', "export const DAY_MS = Number(process.env.CW_TEST_DAY_MS) || 86_400_000"])
    expect(units({ paths: [file], diffLines })).toContain('tests/e2esuites.test.ts')
    // The same file changed without a seam doesn't.
    expect(units({ paths: [file], diffLines: { [file]: ['export const DAY_MS = 86_400_001'] } })).not.toContain('tests/e2esuites.test.ts')
  })

  it("reads a diff's added and removed lines per file, a deleted and a new file included, not its headers", () => {
    const diff = ['diff --git a/a.ts b/a.ts', 'index 1..2 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', 'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-was here', 'diff --git a/n.ts b/n.ts', 'new file mode 100644', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1 @@', '+--- not a header'].join('\r\n')
    expect(diffLinesOf(diff)).toEqual({ 'a.ts': ['old', 'new'], 'gone.ts': ['was here'], 'n.ts': ['--- not a header'] })
  })

  it('a change that needs every suite prints only {"every":true}; an empty one prints nothing', () => {
    const every = pick({ paths: ['src/main/ipc.ts', 'tests/tips.test.ts'] })
    expect(pickLines(every)).toEqual(['{"every":true}'])
    expect(pickLines(pick({ paths: [] }))).toEqual([])
    expect(pickLines(pick({ paths: ['', '  '.trim()] }))).toEqual([])
  })

  it('picks unit tests (sorted) then suites, each id once and none empty, with what each needs', () => {
    const picked = pick({ paths: ['tests/tips.test.ts', 'docs/USER_GUIDE.md', 'src/main/installDir.ts', 'src/main/agentProcesses.ts', 'scripts/dist.mjs', 'tests/gone.test.ts'], deleted: ['tests/gone.test.ts'], vitestRelated: ['tests/tips.test.ts', 'tests/installDir.test.ts'] })
    const ids = picked.tests!.map((t) => t.test)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    const unit = picked.tests!.filter((t) => t.needs[0] === 'unit').map((t) => t.test)
    expect(unit).toEqual([...unit].sort())
    expect(unit).toEqual(expect.arrayContaining(['tests/tips.test.ts', 'tests/userGuide.test.ts', 'tests/installDir.test.ts']))
    expect(unit).not.toContain('tests/gone.test.ts')
    expect(ids.slice(0, unit.length)).toEqual(unit)
    const needs = Object.fromEntries(picked.tests!.map((t) => [t.test, t.needs]))
    expect(needs.installdir).toEqual(['fake'])
    expect(needs['leftovers-claude']).toEqual(['real'])
    expect(needs.packaged).toEqual(['packaged'])
    for (const t of picked.tests!) expect(t.needs).toHaveLength(1)
  })
})

describe('the picker on the command line (focused.pick)', () => {
  const run = (input: string, base = 'HEAD') => spawnSync(process.execPath, [join(root, 'tests', 'e2e', 'affected.mjs'), '--pick'], { cwd: root, input, encoding: 'utf8', env: { ...runContext.baseEnv(), CW_FOCUSED_BASE: base } })

  it('prints {"every":true} alone for a shared file, nothing for no change, and fails for a base that is no commit', () => {
    const every = run('src/main/ipc.ts\r\n')
    expect(every.status, every.stderr).toBe(0)
    expect(every.stdout.trim()).toBe('{"every":true}')
    const none = run('')
    expect(none.status, none.stderr).toBe(0)
    expect(none.stdout).toBe('')
    const bad = run('README.md\n', 'no-such-commit-HI-1367')
    expect(bad.status).not.toBe(0)
    expect(bad.stdout).toBe('')
  })

  it('does nothing when imported', () => {
    // This file imported it above: it printed nothing and read no stdin (vitest would have hung on it).
    expect(typeof pickTests).toBe('function')
    expect(under('src/main/a.ts', ['src/'])).toBe(true)
  })
})
