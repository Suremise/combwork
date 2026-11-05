// The test area's name and its one-way move (HI-2590): %LOCALAPPDATA%\combwork-test, moved once from hive-test by
// npm run test:move-area (tests/moveTestArea.mjs), and the guard that refuses a test run until it is done
// (tests/testArea.cjs). The repository names the old folder only where the move needs it.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { moveArea, moveState, rewriteText, REWRITES } from './moveTestArea.mjs'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { MARKER, NAME, OLD_NAME, areas, notReady } = require('./testArea.cjs') as {
  MARKER: string
  NAME: string
  OLD_NAME: string
  areas: (env?: NodeJS.ProcessEnv) => { area: string; old: string }
  notReady: (dirs?: { area: string; old: string }) => string | null
}
const { baseEnv } = require('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')

/** An old test area in a folder of its own, with the three files that name it, as the real one's do. */
function oldArea(): { local: string; from: string; to: string } {
  const local = tempDir('move-area-')
  const from = join(local, OLD_NAME)
  const to = join(local, NAME)
  const j = (p: string): string => JSON.stringify(p).slice(1, -1)
  const files: Record<string, string> = {
    'claude/.claude.json': JSON.stringify({ projects: { [`${from.replace(/\\/g, '/')}/scratch/x`]: { hasTrustDialogAccepted: true }, 'D:/elsewhere': {} } }),
    'claude/plugins/known_marketplaces.json': `{"official":{"installLocation":"${j(join(from, 'claude', 'plugins', 'marketplaces', 'official'))}"}}`,
    'codex/config.toml': `[projects.'${join(from, 'e2e', 'cx-ws', 'demo')}']\ntrust_level = "trusted"\n\n[projects.'${join(from, 'scenarios').toLowerCase()}']\ntrust_level = "trusted"\n`,
    'claude/.credentials.json': '{"claudeAiOauth":{"accessToken":"t"}}',
    'scenarios/baselines/rel-110-rc2-fake.json': '{"runs":[]}'
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(from, rel, '..'), { recursive: true })
    writeFileSync(join(from, rel), text)
  }
  return { local, from, to }
}
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), 'utf8')

describe("the test area's move (HI-2590)", () => {
  it('rewrites a path under the old folder in each spelling and case, and nothing else; again, it changes nothing', () => {
    const from = 'C:\\Users\\X\\AppData\\Local\\hive-test'
    const to = 'C:\\Users\\X\\AppData\\Local\\combwork-test'
    const text = [
      '"C:\\\\Users\\\\X\\\\AppData\\\\Local\\\\hive-test\\\\claude\\\\plugins"',
      "[projects.'c:\\users\\x\\appdata\\local\\hive-test\\e2e\\demo']",
      '"C:/Users/X/AppData/Local/hive-test/scratch/a": {}',
      'C:\\Users\\X\\AppData\\Local\\hive-test',
      'C:\\Users\\X\\AppData\\Local\\hive-test-updater and C:\\Users\\X\\AppData\\Local\\hive-tests'
    ].join('\n')
    const once = rewriteText(text, [from], to)
    expect(once.count).toBe(4)
    expect(once.text.split('\n')).toEqual([
      '"C:\\\\Users\\\\X\\\\AppData\\\\Local\\\\combwork-test\\\\claude\\\\plugins"',
      "[projects.'C:\\Users\\X\\AppData\\Local\\combwork-test\\e2e\\demo']",
      '"C:/Users/X/AppData/Local/combwork-test/scratch/a": {}',
      'C:\\Users\\X\\AppData\\Local\\combwork-test',
      'C:\\Users\\X\\AppData\\Local\\hive-test-updater and C:\\Users\\X\\AppData\\Local\\hive-tests'
    ])
    expect(rewriteText(once.text, [from], to)).toEqual({ text: once.text, count: 0 })
  })

  it('moves the folder, rewrites the three files that name it (a backup first), leaves the sign-in and the baselines as they were', () => {
    const { from, to } = oldArea()
    const before = { cred: read(from, 'claude/.credentials.json'), base: read(from, 'scenarios/baselines/rel-110-rc2-fake.json') }
    const r = moveArea(from, to)
    expect(r).toMatchObject({ state: 'fresh', moved: true })
    expect(r.rewrites.map((w: { count: number }) => w.count)).toEqual([1, 1, 2])
    expect(existsSync(from)).toBe(false)
    expect(existsSync(join(to, MARKER))).toBe(false)
    for (const rel of REWRITES) {
      expect(read(to, rel), rel).not.toMatch(/hive-test/i)
      expect(read(to, rel), rel).toMatch(/combwork-test/)
    }
    expect(read(to, 'claude/.credentials.json')).toBe(before.cred)
    expect(read(to, 'scenarios/baselines/rel-110-rc2-fake.json')).toBe(before.base)
    expect(JSON.parse(read(to, 'claude/.claude.json')).projects).toHaveProperty('D:/elsewhere')
    expect(moveState(from, to).state).toBe('done')
  })

  it('stopped part way through the rewrites, the next run resumes them, keeping the first backups; the one after has nothing to do', () => {
    const { local, from, to } = oldArea()
    const original = read(from, 'claude/.claude.json')
    expect(() => moveArea(from, to, { failAfter: 1 })).toThrow(/stopped after 1/)
    expect(existsSync(join(to, MARKER))).toBe(true)
    expect(read(to, REWRITES[0])).not.toMatch(/hive-test/i)
    expect(read(to, REWRITES[2])).toMatch(/hive-test/i)
    expect(notReady({ area: to, old: join(local, OLD_NAME) })).toMatch(/unfinished/)
    expect(moveState(from, to).state).toBe('resume')
    const r = moveArea(from, to)
    expect(r).toMatchObject({ state: 'resume', moved: true })
    expect(r.rewrites.map((w: { count: number }) => w.count)).toEqual([0, 1, 2])
    for (const rel of REWRITES) expect(read(to, rel), rel).not.toMatch(/hive-test/i)
    const backups = readdirSync(to).filter((n) => n.startsWith('move-backup-'))
    expect(backups).toHaveLength(1)
    expect(read(join(to, backups[0]), 'claude/.claude.json')).toBe(original)
    expect(existsSync(join(to, MARKER))).toBe(false)
    expect(notReady({ area: to, old: join(local, OLD_NAME) })).toBeNull()
    expect(moveArea(from, to)).toMatchObject({ state: 'done', moved: false })
  })

  it("a marker left in the old folder (the rename never happened) is a fresh start; the rename failing leaves no marker", () => {
    const { from, to } = oldArea()
    writeFileSync(join(from, MARKER), JSON.stringify({ from, to, startedAt: 'x' }))
    expect(moveState(from, to).state).toBe('restart')
    expect(moveArea(from, to)).toMatchObject({ state: 'restart', moved: true })
    expect(existsSync(join(to, MARKER))).toBe(false)
  })

  it('refuses while tests use the old folder, when both folders are there, and when the new one holds another move', () => {
    const { from, to } = oldArea()
    mkdirSync(join(from, 'heavy-slots'))
    writeFileSync(join(from, 'heavy-slots', 'slot-1.json'), JSON.stringify({ pid: 4242, at: Date.now(), what: 'e2e board' }))
    expect(() => moveArea(from, to, { alive: (pid: number) => pid === 4242 })).toThrow(/tests are using[\s\S]*slot-1\.json \(process 4242, e2e board\)/)
    expect(() => moveArea(from, to, { running: [{ pid: 7, commandLine: `node x ${from}\\e2e` }] })).toThrow(/process 7: node x/)
    expect(existsSync(from) && !existsSync(to)).toBe(true)
    mkdirSync(to)
    expect(() => moveArea(from, to)).toThrow(/both .* are there/)
    writeFileSync(join(to, MARKER), JSON.stringify({ from: 'C:\\other', to }))
    expect(() => moveArea(from, to)).toThrow(/marker for other folders/)
  })

  it('a dry run says what it would do and changes nothing', () => {
    const { from, to } = oldArea()
    const lines: string[] = []
    expect(moveArea(from, to, { dryRun: true, say: (l: string) => lines.push(l) })).toMatchObject({ moved: false })
    expect(lines.join('\n')).toMatch(/Would move/)
    expect(existsSync(from) && !existsSync(to) && !existsSync(join(from, MARKER))).toBe(true)
  })
})

describe('the guard a test run passes first (tests/testArea.cjs)', () => {
  it('refuses while only the old folder is there, or the move is unfinished; passes once moved, or where neither is', () => {
    const local = tempDir('area-guard-')
    const dirs = areas({ LOCALAPPDATA: local })
    expect(dirs).toEqual({ area: join(local, 'combwork-test'), old: join(local, 'hive-test') })
    expect(notReady(dirs)).toBeNull()
    mkdirSync(dirs.old)
    expect(notReady(dirs)).toMatch(/still at .*npm run test:move-area/)
    mkdirSync(dirs.area)
    expect(notReady(dirs)).toBeNull()
    writeFileSync(join(dirs.area, MARKER), '{}')
    expect(notReady(dirs)).toMatch(/unfinished/)
  })
})

describe("the old name's places (HI-2590)", () => {
  it('nothing names hive-test but the move, its guard and test, and recorded fixtures; a line elsewhere says why (HI-2590 or test:move-area)', () => {
    const OWN = new Set(['tests/testArea.cjs', 'tests/moveTestArea.mjs', 'tests/testArea.test.ts'])
    const out = execFileSync('git', ['grep', '-I', '-n', '-i', '--untracked', '-e', 'hive-test'], { cwd: root, env: baseEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean)
    const stray = out.filter((l) => {
      const file = l.slice(0, l.indexOf(':'))
      return !OWN.has(file) && !file.startsWith('tests/fixtures/') && file !== 'CHANGELOG.md' && !/HI-2590|test:move-area/.test(l)
    })
    expect(stray).toEqual([])
  })
})
