// Tests' temp folders (#448): every test makes them with tempDir() (tests/tempDir.ts), by their long, real paths, never
// under os.tmpdir() itself, whose path is the 8.3 short form on GitHub's runner (C:\Users\RUNNER~1\…). A test that wants
// another name for a folder makes one on purpose (tests/pathAliases.ts): checked here on this machine.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { basename, dirname, join, relative, sep } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { junction, shortPath } from './pathAliases'
import { endRunTemp, pruneRunTemps, removeTempDirs, tempArea, tempDir, tempRoot } from './tempDir'

const here = __dirname
const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const dir = (prefix: string): string => {
  const d = tempDir(prefix)
  made.push(d)
  return d
}
const same = (a: string, b: string): boolean => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase()

/** The tests' code files (unit tests, helpers, e2e suites and runners, scenarios), not their fixtures. */
function code(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (['fixtures', 'node_modules'].includes(e.name) ? [] : code(join(d, e.name))) : /\.(ts|mts|cts|js|cjs|mjs)$/.test(e.name) ? [join(d, e.name)] : []
  )
}

/**
 * The only lines outside the helper (and this, its guard) that may name the temp folder itself, each in its own file,
 * exactly as written: anywhere else, the same text is refused.
 */
const ALLOWED: Record<string, string[]> = {
  // The hive-test root is %LOCALAPPDATA%\hive-test, in the temp folder only where LOCALAPPDATA is unset.
  // and the temp folder's variables a child gets from the run (the run's own folder, HI-2102).
  'e2e/runContext.cjs': ['const LOCAL = process.env.LOCALAPPDATA || os.tmpdir()', "'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'OS',"],
  'e2e/build.mjs': ["import { tmpdir } from 'os'", "export const BUILD_LOCKS = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'build-locks')"],
  'progressReport.mts': ["import { tmpdir } from 'node:os'", "const timings = (): string => process.env.CW_TEST_PROGRESS_TIMINGS || join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'progress-timings.json')"],
  // npm run e2e -- --clear-dir: a folder the user names may be in the temp folder (one nothing here made).
  // The focused tests' picker's check (HI-1367) reads a binding naming the temp folder as not the repository's.
  'focusedPick.test.ts': ['if (bound.has(name) || !exprs.every((e) => !/tempDir|tmpdir|mkdtemp/.test(e) && names(e))) continue'],
  'e2e/evidence.cjs': ['function clearDir(target, { board = {}, temp = os.tmpdir(), testRoot = runContext.TEST_ROOT, homes = [runContext.CODEX_HOME, runContext.CLAUDE_TEST_HOME] } = {}) {']
}
const OWN = ['tempDir.ts', 'runTemp.mts', 'tempDir.test.ts']
// Files whose subject is the temp variables Combwork gives agents (HI-2496: Agents' temp folder): TEMP, TMP and TMPDIR are
// the data they check, never where they put files (those come from tempDir() and lib.WORK).
const DATA = ['agentTemp.test.ts', 'e2e/agenttemp.cjs']

/** Where these files name the temp folder themselves (os.tmpdir, TEMP or TMP), other than ALLOWED: `file:line` each. */
function rawTempUses(files: { name: string; text: string }[]): string[] {
  const found: string[] = []
  for (const { name, text } of files) {
    if (OWN.includes(name) || DATA.includes(name)) continue
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (!/\btmpdir\b|\benv\s*(\.\s*(TEMP|TMP)\b|\[\s*['"`](TEMP|TMP)['"`])/i.test(line)) return
      if (ALLOWED[name]?.includes(line.trim())) return
      found.push(`${name}:${i + 1}`)
    })
  }
  return found
}

describe('temp folders for tests (#448)', () => {
  it('no test uses os.tmpdir() itself: tempDir() and tempRoot() give the long, real path', () => {
    const files = code(here).map((f) => ({ name: relative(here, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }))
    expect(files.length).toBeGreaterThan(150)
    expect(rawTempUses(files)).toEqual([])
    // Each allowance is still there: one that isn't goes from the list.
    for (const [name, lines] of Object.entries(ALLOWED)) {
      const text = files.find((f) => f.name === name)?.text ?? ''
      for (const l of lines) expect(text.split(/\r?\n/).map((x) => x.trim()), `${name}: ${l}`).toContain(l)
    }
  })

  it('the guard refuses each way of reaching the temp folder, and an allowed line anywhere but its own file', () => {
    const fallback = ALLOWED['e2e/runContext.cjs'][0]
    const refused = [
      "const d = mkdtempSync(join(tmpdir(), 'x-'))",
      "const d = mkdtempSync(join(process.env.LOCALAPPDATA || os.tmpdir(), 'hive-bypass-'))",
      "const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'x-'))",
      "import { tmpdir } from 'os'",
      'const { tmpdir } = await import(\'os\')',
      'const t = os.tmpdir',
      "const d = join(process.env.TEMP ?? 'C:\\\\t', 'x')",
      "const d = join(process.env['TMP']!, 'x')",
      fallback
    ]
    const files = refused.map((text, i) => ({ name: i === refused.length - 1 ? 'raw.test.ts' : `raw${i}.test.ts`, text }))
    expect(rawTempUses(files)).toEqual(files.map((f) => `${f.name}:1`))
    // In its own file, only the line as allowed: another use there is refused.
    expect(rawTempUses([{ name: 'e2e/runContext.cjs', text: `${fallback}\nconst x = os.tmpdir()\n// os.tmpdir() in a comment` }])).toEqual(['e2e/runContext.cjs:2'])
  })

  it("tempDir makes a new, empty folder by its real path; tempRoot is the run's own folder in hive-test\\tmp (#992, #995)", () => {
    const a = dir('hive-tempdir-')
    const b = dir('hive-tempdir-')
    expect(a).not.toBe(b)
    expect(readdirSync(a)).toEqual([])
    expect(realpathSync.native(a)).toBe(a)
    expect(a.startsWith(tempRoot() + sep)).toBe(true)
    // In the test area, which Combwork's Antivirus scanning setting covers, not in %TEMP%; the temp folder only off Windows.
    const area = join(process.env.LOCALAPPDATA || tmpdir(), 'hive-test', 'tmp')
    expect(tempArea).toBe(area)
    expect(dirname(tempRoot())).toBe(realpathSync.native(area))
    expect(basename(tempRoot())).toMatch(/^run-/)
    expect(realpathSync.native(tempRoot())).toBe(tempRoot())
    // vitest.config.ts makes it the run's temp folder too, so what Vitest, Combwork's code and git put in %TEMP% goes there.
    if (process.env.LOCALAPPDATA) expect(tmpdir()).toBe(tempRoot())
  })
})

describe('other names for a folder (tests/pathAliases.ts)', () => {
  it('shortPath gives the 8.3 name of a long one, the same folder (skipped where the volume makes no short names)', (ctx) => {
    const long = dir('hive-short-path-with-a-long-name-')
    const short = shortPath(long)
    if (short === null) return ctx.skip()
    expect(short).toMatch(/~\d/)
    expect(short.toLowerCase()).not.toBe(long.toLowerCase())
    expect(same(short, long)).toBe(true)
  })

  it('shortPath gives null where there is no other name: every part already short, or no such path', () => {
    expect(shortPath(process.env.SystemRoot ?? 'C:\\Windows')).toBeNull()
    expect(shortPath(join(tempRoot(), 'hive-no-such-folder-448', 'x'))).toBeNull()
  })

  it('shortPath gives null for a missing path under a folder that has a short name (#485: RUNNER~1 on the runner; skipped where the volume makes no short names)', (ctx) => {
    const long = dir('hive-short-path-parent-with-a-long-name-')
    if (shortPath(long) === null) return ctx.skip()
    expect(shortPath(join(long, 'hive-no-such-folder-485'))).toBeNull()
    expect(shortPath(join(long, 'no-such', 'x'))).toBeNull()
  })

  it('junction gives another name for a folder on any machine: a different path, the same folder', () => {
    const d = dir('hive-junction-')
    const target = dir('hive-junction-target-')
    const via = junction(target, join(d, 'via'))
    expect(via.toLowerCase()).not.toBe(target.toLowerCase())
    expect(existsSync(via)).toBe(true)
    expect(same(via, target)).toBe(true)
  })
})

describe('git as on the runner (tests/noGlobalGit.ts)', () => {
  const git = (cwd: string, ...a: string[]): { status: number | null; out: string } => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8' })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it('no global config: none read, none can be written, so a commit needs its repository to say who', () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    const d = dir('hive-no-global-git-')
    expect(git(d, 'config', '--global', '--list')).toMatchObject({ status: 0, out: '' })
    // Nothing a test or an earlier run writes stays for the next.
    expect(git(d, 'config', '--global', 'user.name', 'Left behind').status).not.toBe(0)
    expect(git(d, 'config', '--global', '--get', 'user.name')).toMatchObject({ status: 1, out: '' })
    expect(git(d, 'init', '-q').status).toBe(0)
    const anon = git(d, 'commit', '-q', '--allow-empty', '-m', 'x')
    expect(anon.status).not.toBe(0)
    expect(anon.out).toMatch(/Author identity unknown|Committer identity unknown|unable to auto-detect email address/)
    git(d, 'config', 'user.name', 'Test')
    git(d, 'config', 'user.email', 'test@example.com')
    expect(git(d, 'commit', '-q', '--allow-empty', '-m', 'x').status).toBe(0)
  })
})

describe("the run's own temp folder goes when the run ends (#995)", () => {
  const as = (folder: string, owner: string, fn: () => void): void => {
    const was = { dir: process.env.CW_TEST_RUN_TMP, owner: process.env.CW_TEST_RUN_TMP_OWNER }
    process.env.CW_TEST_RUN_TMP = folder
    process.env.CW_TEST_RUN_TMP_OWNER = owner
    try {
      fn()
    } finally {
      process.env.CW_TEST_RUN_TMP = was.dir
      process.env.CW_TEST_RUN_TMP_OWNER = was.owner
    }
  }

  it('is removed, with what is in it, by the process that made it', () => {
    const run = realpathSync.native(mkdtempSync(join(tempArea, 'run-')))
    mkdirSync(join(run, 'late', 'profile'), { recursive: true })
    writeFileSync(join(run, 'late', 'profile', 'config.json'), '{}')
    try {
      as(run, String(process.pid), () => expect(endRunTemp()).toBeUndefined())
      expect(existsSync(run)).toBe(false)
    } finally {
      rmSync(run, { recursive: true, force: true })
    }
  })

  it("is left alone by a run started inside it (another process), and nothing but a run's folder is ever removed", () => {
    // This worker is one: the run's folder is its parent's.
    expect(process.env.CW_TEST_RUN_TMP_OWNER).not.toBe(String(process.pid))
    expect(endRunTemp()).toBeUndefined()
    expect(existsSync(tempRoot())).toBe(true)
    const notARun = dir('hive-not-a-run-')
    as(notARun, String(process.pid), () => expect(endRunTemp()).toMatch(/^not a run's folder/))
    expect(existsSync(notARun)).toBe(true)
  })
})

describe("a stopped run's temp folder goes at a later run's start, and every runner has one (HI-2102)", () => {
  const DAY = 24 * 60 * 60_000
  const now = Date.now()
  const at = (area: string, name: string, ageMs: number): string => {
    const d = join(area, name)
    mkdirSync(join(d, 'playwright-artifacts-x'), { recursive: true })
    utimesSync(d, new Date(now - ageMs), new Date(now - ageMs))
    return d
  }

  // The board's rules as the runners give them (tests/e2e/evidence.cjs), over cards given here (their text as the board
  // gives it: pathText).
  const { evidence, pathText } = createRequire(__filename)('./e2e/evidence.cjs')
  const nobody = evidence({ cards: [] })

  it("removes runs' folders older than a day whose run has ended, and nothing else", () => {
    const area = dir('hive-run-area-')
    const ended = at(area, 'run-4001-abcdef', DAY + 60_000)
    const live = at(area, 'run-4002-abcdef', 2 * DAY)
    const recent = at(area, 'run-4003-abcdef', DAY - 60_000)
    const beforePids = at(area, 'run-Xy12Zq', 2 * DAY)
    const other = at(area, 'hive-gitrepo-abcdef', 2 * DAY)
    const removed = pruneRunTemps((p) => nobody.protects(p), { now, area, isAlive: (pid) => pid === 4002 })
    expect(removed.sort()).toEqual([beforePids, ended].sort())
    expect([ended, live, recent, beforePids, other].map((d) => existsSync(d))).toEqual([false, true, true, false, true])
  })

  it('keeps an old run whose files an open card cites, and removes an uncited one beside it', () => {
    const area = dir('hive-run-area-')
    const cited = at(area, 'run-4011-abcdef', 2 * DAY)
    writeFileSync(join(cited, 'failure.txt'), 'x')
    utimesSync(cited, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    const uncited = at(area, 'run-4012-abcdef', 2 * DAY)
    const ev = evidence({ cards: [{ number: 2102, text: pathText(`The failure is in ${join(cited, 'failure.txt')}`) }] })
    expect(ev.protects(cited)).toBe('cited by #2102')
    expect(pruneRunTemps((p) => ev.protects(p), { now, area, isAlive: () => false })).toEqual([uncited])
    expect(existsSync(join(cited, 'failure.txt'))).toBe(true)
    expect(existsSync(uncited)).toBe(false)
  })

  it("removes nothing while the board can't be read, or with no board found", () => {
    const area = dir('hive-run-area-')
    const old = at(area, 'run-4021-abcdef', 2 * DAY)
    for (const ev of [evidence({ tasksDir: join(area, 'no-such-board') }), evidence({})]) {
      expect(ev.ok).toBe(false)
      expect(pruneRunTemps((p) => ev.protects(p), { now, area, isAlive: () => false })).toEqual([])
    }
    expect(existsSync(old)).toBe(true)
  })

  it('asks the board just before each removal: a card citing a run after the listing keeps it', () => {
    const area = dir('hive-run-area-')
    const run = at(area, 'run-4031-abcdef', 2 * DAY)
    const cards: { number: number; text: string }[] = []
    const ev = evidence({ cards })
    // Its owner is looked up after the listing, before the removal: a card cites the run meanwhile.
    const isAlive = (): boolean => {
      cards.push({ number: 2103, text: pathText(`See ${run}`) })
      return false
    }
    expect(pruneRunTemps((p) => ev.protects(p), { now, area, isAlive })).toEqual([])
    expect(existsSync(run)).toBe(true)
  })

  it('gives nothing for an area that is not there', () => {
    expect(pruneRunTemps((p) => nobody.protects(p), { now, area: join(dir('hive-run-area-'), 'none') })).toEqual([])
  })

  it("the run's folder is the temp folder of what it starts (TEMP, TMP, TMPDIR), in the e2e and scenario runners too", () => {
    if (process.env.LOCALAPPDATA) expect([process.env.TEMP, process.env.TMP, process.env.TMPDIR]).toEqual([tempRoot(), tempRoot(), tempRoot()])
    expect(basename(tempRoot())).toMatch(/^run-\d+-/)
    // The runners make theirs before they start anything, and remove it as they exit; their children get it (ALLOW).
    for (const runner of ['e2e/run.mjs', 'scenarios/run.mjs']) {
      const text = readFileSync(join(here, runner), 'utf8')
      expect(text, runner).toMatch(/^import \{ endRunTemp, startRunTemp \} from '\.\.\/runTemp\.mts'$/m)
      // With the board's rules, once the runner has found the board readable (it doesn't start otherwise).
      const start = text.search(/startRunTemp\((\(p\) => evidence\.protects\(p\)|spare)\)/)
      expect(start, runner).toBeGreaterThan(text.indexOf('if (!evidence.ok)'))
      expect(start, runner).toBeLessThan(text.search(/\bspawn(Sync)?\(|require\('\.\/harness\.cjs'\)/))
      expect(text, runner).toMatch(/process\.on\('exit'[^]*?endRunTemp\(\)/)
    }
    // Playwright takes the temp folder as it loads (its playwright-artifacts-* folders): the scenario harness runs it in
    // the runner's process, so the runner's folder comes before lib.cjs loads it; the e2e runner runs it only in suites.
    const scenarios = readFileSync(join(here, 'scenarios/run.mjs'), 'utf8')
    expect(scenarios.indexOf('startRunTemp(spare)')).toBeLessThan(scenarios.indexOf("require('../e2e/lib.cjs')"))
    expect(readFileSync(join(here, 'e2e/run.mjs'), 'utf8')).not.toMatch(/_electron|\blib\.launch\(/)
    expect(createRequire(__filename)('./e2e/runContext.cjs').ALLOW).toEqual(expect.arrayContaining(['TEMP', 'TMP', 'TMPDIR']))
  })
})

// Last in the file: removeTempDirs() takes every folder this file has made.
describe("each test file's temp folders go when it ends (#995)", () => {
  it('removes every folder tempDir() made, with what was in it, and only those', () => {
    const a = tempDir('hive-made-')
    const b = tempDir('hive-made-')
    mkdirSync(join(b, 'deep', 'er'), { recursive: true })
    writeFileSync(join(b, 'deep', 'er', 'f.txt'), 'x')
    const other = mkdtempSync(join(tempRoot(), 'hive-not-made-'))
    try {
      expect(removeTempDirs()).toEqual([])
      expect([existsSync(a), existsSync(b), existsSync(other)]).toEqual([false, false, true])
      // Once removed, a folder isn't removed again, and the helper carries on making them.
      expect(removeTempDirs()).toEqual([])
      expect(existsSync(tempDir('hive-made-'))).toBe(true)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('runs after every test file (vitest.config.ts setupFiles)', () => {
    expect(readFileSync(join(here, '..', 'vitest.config.ts'), 'utf8')).toMatch(/setupFiles: \[[^\]]*'tests\/tempCleanup\.ts'/)
  })
})
