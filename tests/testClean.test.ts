// Test housekeeping (#253, tests/e2e/clean.mjs and evidence.cjs): what goes from %LOCALAPPDATA%\combwork-test and what
// always stays, whichever deletes it: the clean-up, the e2e runner (suite folders, log pruning) or the scenario runner.
import { createRequire } from 'module'
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { clean, codexPlan, holdLane, plan } from './e2e/clean.mjs'
// @ts-expect-error: plain .mjs modules without types
import { acquireCodexHome } from './e2e/codexHomeLock.mjs'
// @ts-expect-error: plain .mjs modules without types
import { claimLane } from './e2e/lanes.mjs'
// @ts-expect-error: plain .mjs modules without types
import { finishRunDirs, keepSuiteFiles, newRunDir, omittedLine, pruneRunDirs, pruneRunDirsReleasing } from './e2e/logs.mjs'
import { tempDir } from './tempDir'
import { decomposeCard, writeCardRows } from '../src/main/schema/cardRows'
import { CARDS_STEP } from '../src/main/schema/v1_0'

const require = createRequire(import.meta.url)
const { citedBy, findBoard, readCards, evidence, freshFolder, clearDir, finishSuiteDir, recordKept, releaseKept, claimedByRuns, MAX_COPIES } = require('./e2e/evidence.cjs')
const { probeDir } = require('./e2e/lib.cjs')
const { pruneResults, saveBaseline } = require('./scenarios/benchmark.cjs')

type Card = { number: number; text: string }
type Ev = { ok: boolean; why: string | null; protects: (p: string) => string | null }

const temps: string[] = []
const temp = (prefix: string): string => {
  const d = tempDir(prefix)
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const DAY = 24 * 60 * 60_000
const card = (number: number, text: string): Card => ({ number, text: text.toLowerCase().replace(/\\+/g, '/') })
/** The evidence rules for a combwork-test at root, with these cards (or none readable: null). */
const rules = (root: string, cards: Card[] | null): Ev => (cards ? evidence({ cards, testRoot: root }) : evidence({ tasksDir: null, testRoot: root }))

/** Makes each path (a folder when it ends in /, else a file) and dates everything under root `days` old. */
function tree(root: string, paths: Record<string, number>): void {
  for (const p of Object.keys(paths)) {
    const full = join(root, p)
    if (p.endsWith('/')) mkdirSync(full, { recursive: true })
    else {
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, 'x'.repeat(100))
    }
  }
  // Each folder on the way as old as the newest thing in it; deepest first, so dating a child doesn't make its folder
  // new again.
  const ages = new Map<string, number>()
  for (const [p, days] of Object.entries(paths)) {
    const parts = p.split('/').filter(Boolean)
    for (let k = 1; k <= parts.length; k++) {
      const at = parts.slice(0, k).join('/')
      ages.set(at, Math.min(ages.get(at) ?? Infinity, days))
    }
  }
  for (const [p, days] of [...ages].sort(([a], [b]) => b.split('/').length - a.split('/').length)) {
    const t = new Date(Date.now() - days * DAY)
    utimesSync(join(root, p), t, t)
  }
}

describe('what cards cite (they keep it)', () => {
  it('a path ending with its folder and name cites it, in either slash and any case, a full stop after it too', () => {
    expect(citedBy('e2e/review158-live-left-dark.png', [card(227, 'See `e2e\\review158-live-left-dark.png`.')])).toBe(227)
    expect(citedBy('e2e/lanes/0/board', [card(9, 'C:\\Users\\X\\AppData\\Local\\combwork-test\\e2e\\lanes\\0\\board\\board.png')])).toBe(9)
    expect(citedBy('evidence', [card(3, 'In %LOCALAPPDATA%\\combwork-test\\evidence.')])).toBe(3)
  })

  it('a path inside a folder keeps the folder', () => {
    expect(citedBy('evidence', [card(246, 'evidence\\246-before.png')], ['246-before.png', 'other.png'])).toBe(246)
    expect(citedBy('evidence', [card(246, 'evidence\\gone.png')], ['246-before.png'])).toBe(null)
  })

  it('a folder cited as a whole keeps everything in it: a suite folder, a scenario folder', () => {
    expect(citedBy('e2e/lanes/0/board/board-ws', [card(7, 'see lanes\\0\\board\\ for the run')])).toBe(7)
    expect(citedBy('e2e/lanes/0/board/board-ws', [card(7, '%LOCALAPPDATA%\\combwork-test\\e2e\\lanes\\0\\board')])).toBe(7)
    expect(citedBy('scenarios/lanes/2/review-card-fake/ws', [card(8, 'scenarios\\lanes\\2\\review-card-fake: kept with --keep')])).toBe(8)
  })

  it('…but a lane is a place, not evidence: naming one keeps nothing in it (#285)', () => {
    // #285's own description named lane 0, as #253's comments did: every folder every later run made there was kept.
    const lane0 = [card(285, '`e2e\\lanes\\0` = 23 GB, 2,078 entries'), card(7, 'everything in combwork-test\\e2e\\lanes\\0 is the evidence')]
    for (const rel of ['e2e/lanes/0/board', 'e2e/lanes/0/about-10', 'e2e/lanes/0/codex-setup-14/codex-setup-ws']) expect(citedBy(rel, lane0), rel).toBe(null)
    expect(citedBy('scenarios/lanes/2/review-card-fake', [card(8, '%LOCALAPPDATA%\\combwork-test\\scenarios\\lanes\\2')])).toBe(null)
    // A suite folder or a file in it named in the same text still is.
    expect(citedBy('e2e/lanes/0/board', [card(9, 'lanes\\0 has it: e2e\\lanes\\0\\board\\board.png')])).toBe(9)
  })

  it("…nor the unit tests' temp folder: naming combwork-test\\tmp keeps nothing in it (#992's own text did)", () => {
    const tmp = [card(992, 'make the root a folder in the test area (for example `%LOCALAPPDATA%\\combwork-test\\tmp\\<run or worker>`)')]
    for (const rel of ['tmp/hive-git-x1y2z3', 'tmp/bfWnGRfHtqeLL_lF45dTU', 'tmp/config.json']) expect(citedBy(rel, tmp), rel).toBe(null)
    expect(citedBy('tmp/hive-git-x1y2z3', [card(10, 'the repo it left: combwork-test\\tmp\\hive-git-x1y2z3')])).toBe(10)
  })

  it('…but a path through a folder keeps only what it names, and a name only with its boundary', () => {
    // lanes\0\board\board.png keeps the board suite's folder, not the rest of lane 0.
    expect(citedBy('e2e/lanes/0/about', [card(9, 'lanes\\0\\board\\board.png')])).toBe(null)
    // lanes\0 doesn't keep lanes\01.
    expect(citedBy('e2e/lanes/01/board', [card(9, 'combwork-test\\e2e\\lanes\\0')])).toBe(null)
    expect(citedBy('e2e/lanes/0/board', [card(9, 'combwork-test\\e2e\\lanes\\01')])).toBe(null)
    // The areas themselves, named when cards talk about the tests, keep nothing.
    expect(citedBy('e2e/review12-probe', [card(9, 'Everything goes in %LOCALAPPDATA%\\combwork-test\\e2e.')])).toBe(null)
    expect(citedBy('scratch/claudio-2026-10-01', [card(9, 'probes go in combwork-test\\scratch\\<agent>-<date>')])).toBe(null)
  })

  it("a name alone isn't a citation, nor a longer name, nor the same word in another path", () => {
    expect(citedBy('charts-132', [card(253, 'One-off folders (`charts-132`, `evidence`) to remove')], ['a.png'])).toBe(null)
    expect(citedBy('scripts', [card(185, 'the renderer libraries in `scripts/licenses.mjs`')], ['probe.cjs'])).toBe(null)
    expect(citedBy('e2e/review1', [card(5, 'e2e\\review158-dark.png')])).toBe(null)
    expect(citedBy('e2e/view.png', [card(5, 'e2e\\preview.png')])).toBe(null)
  })

  it("reads the cards that aren't Done or archived; a card it can't read means nothing may go", () => {
    const dir = temp('cw-clean-board-')
    const write = (n: number, c: object) => writeFileSync(join(dir, `${n}.json`), JSON.stringify({ number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    write(1, { description: 'combwork-test\\e2e\\a.png' })
    write(2, { column: 'done', description: 'combwork-test\\e2e\\b.png' })
    write(3, { archived: true, description: 'combwork-test\\e2e\\c.png' })
    write(4, { column: 'passed', comments: [{ text: 'e2e\\D.png' }] })
    writeFileSync(join(dir, 'board.json'), '{"next":6}')
    const read = readCards(dir)
    expect(read.ok).toBe(true)
    expect(read.cards.map((c: Card) => c.number).sort()).toEqual([1, 4])
    expect(citedBy('e2e/d.png', read.cards)).toBe(4)
    expect(citedBy('e2e/b.png', read.cards)).toBe(null)
    writeFileSync(join(dir, '5.json'), '{ damaged')
    const damaged = readCards(dir)
    expect(damaged.ok).toBe(false)
    expect(damaged.why).toMatch(/card 5\.json .* can't be read/)
    const ev = evidence({ tasksDir: dir, testRoot: 'C:\\combwork-test' })
    expect(ev.protects('C:\\combwork-test\\e2e\\anything')).toMatch(/can't be read/)
  })

  it("reads a board in its database (#1017) as it reads card files; one it can't open means nothing may go", () => {
    const dir = temp('cw-clean-db-')
    const file = join(dir, 'combwork.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE cards (number INTEGER PRIMARY KEY, doc TEXT NOT NULL)')
    const put = db.prepare('INSERT INTO cards (number, doc) VALUES (?, ?)')
    const add = (n: number, c: object): void => void put.run(n, JSON.stringify({ number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    add(1, { description: 'combwork-test\\e2e\\a.png' })
    add(2, { column: 'done', description: 'combwork-test\\e2e\\b.png' })
    add(3, { archived: true, description: 'combwork-test\\e2e\\c.png' })
    add(4, { column: 'passed', comments: [{ text: 'e2e\\D.png' }] })
    db.close()
    const read = readCards(file)
    expect(read.ok).toBe(true)
    expect(read.cards.map((c: Card) => c.number).sort()).toEqual([1, 4])
    expect(citedBy('e2e/d.png', read.cards)).toBe(4)
    const missing = readCards(join(dir, 'gone.db'))
    expect(missing.ok).toBe(false)
    expect(evidence({ tasksDir: join(dir, 'gone.db'), testRoot: 'C:\\combwork-test' }).protects('C:\\combwork-test\\e2e\\anything')).toMatch(/can't be read/)
  })

  it("reads a 1.0 board's cards from its tables (#1209) as it reads a 0.9 board's documents", () => {
    const dir = temp('cw-clean-db10-')
    const file = join(dir, 'combwork.db')
    const db = new DatabaseSync(file)
    for (const sql of CARDS_STEP.ddl) db.exec(sql)
    const add = (n: number, c: object): void => writeCardRows(db, decomposeCard(n, { number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    add(1, { description: 'combwork-test\\e2e\\a.png' })
    add(2, { column: 'done', description: 'combwork-test\\e2e\\b.png' })
    add(3, { archived: true, description: 'combwork-test\\e2e\\c.png' })
    add(4, { column: 'passed', comments: [{ at: '2026-10-20T00:00:00.000Z', by: 'You', text: 'e2e\\D.png' }] })
    // Only the cards that may cite are read, and of their rows only the comments (HI-2364): a card's history cites nothing.
    add(5, { column: 'review', history: [{ at: '2026-10-20T00:00:00.000Z', from: 'doing', to: 'review', note: 'combwork-test\\e2e\\e.png' }] })
    db.close()
    const read = readCards(file)
    expect(read.ok).toBe(true)
    expect(read.cards.map((c: Card) => c.number).sort()).toEqual([1, 4, 5])
    expect(citedBy('e2e/d.png', read.cards)).toBe(4)
    expect(citedBy('e2e/a.png', read.cards)).toBe(1)
    expect(citedBy('e2e/e.png', read.cards)).toBe(null)
  })

  it('finds the database before the stub folder an older Combwork reads (#1017): a moved board never reads as empty', () => {
    const ws = temp('cw-clean-find-')
    mkdirSync(join(ws, '.combwork', 'tasks'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'tasks', 'board.json'), '{"next":9}')
    expect(findBoard(ws)).toBe(join(ws, '.combwork', 'tasks'))
    writeFileSync(join(ws, '.combwork', 'combwork.db'), '')
    expect(findBoard(ws)).toBe(join(ws, '.combwork', 'combwork.db'))
  })
})

describe('the clean-up (clean.mjs)', () => {
  /** A combwork-test with something of each kind; lane 1 held by a runner (pid 4242). */
  function machine() {
    const root = temp('cw-clean-root-')
    const lanesDir = join(root, 'e2e-lanes')
    tree(root, {
      'codex/auth.json': 30,
      'codex/packages/': 30,
      'claude/.credentials.json': 30,
      'scenarios/results/run1/results.json': 30,
      'scenarios/lanes/0/old-scenario/': 10,
      'scenarios/lanes/0/new-scenario/': 0,
      'scenarios/lanes/0/new-scenario-3/': 0,
      'scenarios/lanes/2/kept-scenario/ws/': 10,
      'e2e/logs/run-20260101-000000/board.log': 30,
      'e2e/lanes/0/board-profile/Cache/data': 0,
      'e2e/lanes/0/board.png': 0,
      'e2e/lanes/0/board/board.png': 0,
      'e2e/lanes/0/about/about-profile/x': 10,
      'e2e/lanes/0/about-2/about-profile/x': 10,
      'e2e/lanes/0/about-7/about-profile/x': 0,
      'e2e/lanes/1/board-profile/x': 0,
      'e2e/lanes/1/about/': 10,
      'e2e/lanes/3/board-profile/x': 10,
      'e2e/lanes/3/about/': 10,
      'e2e/lanes/3/plan/plan.png': 10,
      'e2e/review12-probe/': 10,
      'e2e/review13-cited/shot.png': 10,
      'e2e/review14-done/': 10,
      'e2e/board-profile/': 1,
      'charts-132/': 10,
      'evidence/246-before.png': 10,
      'short tmp/': 0,
      'checks.txt': 10,
      'scratch/claudio-2026-10-01/': 10,
      'scratch/claudio-2026-10-06/': 0,
      'tmp/hive-git-old-x/repo/a.txt': 2,
      'tmp/hive-git-new-y/repo/a.txt': 0,
      'progress-timings.json': 30,
      'config.json': 30,
      'heavy-slots/': 30,
      'build-locks/': 30
    })
    mkdirSync(lanesDir, { recursive: true })
    writeFileSync(join(lanesDir, 'lane-1.json'), JSON.stringify({ pid: 4242, at: Date.now() }))
    // A failed run in the logs keeps its suite's folder (about-2) until KEEP_RUNS prunes the run (#285).
    writeFileSync(join(root, 'e2e', 'logs', 'run-20260101-000000', '.kept-folders.json'), JSON.stringify([join(root, 'e2e', 'lanes', '0', 'about-2')]))
    const cards = [
      card(300, 'kept: combwork-test\\e2e\\review13-cited\\shot.png'),
      card(301, 'see evidence\\246-before.png'),
      card(302, 'the whole lane: %LOCALAPPDATA%\\combwork-test\\e2e\\lanes\\3'),
      card(303, 'kept with --keep: combwork-test\\scenarios\\lanes\\2\\kept-scenario'),
      card(304, 'the failure: e2e\\lanes\\3\\plan\\plan.png')
    ]
    const alive = (pid: number) => pid === 4242
    return { root, lanesDir, cards, alive }
  }
  const run = (m: ReturnType<typeof machine>, o: { cards?: Card[] | null; [k: string]: unknown } = {}) => {
    const { cards = m.cards, ...rest } = o
    return clean({ root: m.root, lanesDir: m.lanesDir, ev: rules(m.root, cards), alive: m.alive, owner: 777, ...rest })
  }
  const there = (root: string, p: string) => existsSync(join(root, p))

  it('removes stale leftovers and keeps sign-ins, results, logs, held lanes, new things and what open cards cite', async () => {
    const m = machine()
    const r = await run(m)
    const gone = r.removed.map((x: { rel: string }) => x.rel).sort()
    expect(gone).toEqual(['charts-132', 'checks.txt', 'e2e/lanes/0/about', 'e2e/lanes/0/about-7', 'e2e/lanes/0/board', 'e2e/lanes/0/board-profile', 'e2e/lanes/0/board.png', 'e2e/lanes/3/about', 'e2e/lanes/3/board-profile', 'e2e/review12-probe', 'e2e/review14-done', 'scenarios/lanes/0/new-scenario-3', 'scenarios/lanes/0/old-scenario', 'scratch/claudio-2026-10-01', 'tmp/hive-git-old-x'])
    // Never the test homes' sign-ins, scenario results, logs, the claims, the timings and the machine's test settings.
    for (const p of ['codex/auth.json', 'codex/packages', 'claude/.credentials.json', 'scenarios/results/run1/results.json', 'e2e/logs/run-20260101-000000/board.log', 'progress-timings.json', 'config.json', 'heavy-slots', 'build-locks'])
      expect(there(m.root, p), p).toBe(true)
    // A lane a runner holds: nothing in it, legacy or old.
    expect(there(m.root, 'e2e/lanes/1/board-profile/x')).toBe(true)
    expect(there(m.root, 'e2e/lanes/1/about')).toBe(true)
    // An idle lane: any suite folder no run keeps goes, however new (#285); a failed run's stays with its logs. Scenario
    // lanes: what --keep left by age, numbered copies at once.
    expect(there(m.root, 'e2e/lanes/0/about-2/about-profile/x')).toBe(true)
    expect(r.items.find((i: { rel: string }) => i.rel === 'e2e/lanes/0/about-2').why).toMatch(/its failed run keeps it/)
    expect(there(m.root, 'scenarios/lanes/0/new-scenario')).toBe(true)
    // Cited by an open card: kept, and said so; a scenario folder or suite folder cited keeps what is in it, a whole lane
    // named keeps nothing (#285).
    expect(there(m.root, 'e2e/review13-cited/shot.png')).toBe(true)
    expect(there(m.root, 'evidence/246-before.png')).toBe(true)
    expect(r.items.find((i: { rel: string }) => i.rel === 'evidence').why).toBe('cited by #301')
    expect(there(m.root, 'e2e/lanes/3/plan/plan.png')).toBe(true)
    expect(r.items.find((i: { rel: string }) => i.rel === 'e2e/lanes/3/plan').why).toBe('cited by #304')
    expect(there(m.root, 'scenarios/lanes/2/kept-scenario/ws')).toBe(true)
    // New things stay.
    for (const p of ['short tmp', 'e2e/board-profile', 'scratch/claudio-2026-10-06', 'tmp/hive-git-new-y']) expect(there(m.root, p), p).toBe(true)
    expect(r.freed).toBeGreaterThan(0)
    // The lane it cleaned is free again; the runner's claim is untouched.
    expect(readdirSync(m.lanesDir).sort()).toEqual(['lane-1.json'])
  })

  it('a dry run removes nothing', async () => {
    const m = machine()
    const dry = await run(m, { dryRun: true })
    expect(dry.removed).toEqual([])
    expect(dry.items.filter((i: { remove: boolean }) => i.remove).length).toBe(15)
    expect(there(m.root, 'charts-132')).toBe(true)
  })

  it("while the board can't be read, nothing at all goes (lanes too), and it says why", async () => {
    const m = machine()
    const blind = await run(m, { cards: null })
    expect(blind.removed).toEqual([])
    expect(blind.blocked).toMatch(/no board was found/)
    expect(blind.items.every((i: { remove: boolean }) => !i.remove)).toBe(true)
    for (const p of ['charts-132', 'e2e/lanes/0/board-profile', 'e2e/lanes/0/about', 'scenarios/lanes/0/old-scenario']) expect(there(m.root, p), p).toBe(true)
  })

  it('--days 0 removes everything else, but still keeps what is held, cited and claimed', async () => {
    const m = machine()
    await run(m, { days: 0 })
    expect(readdirSync(join(m.root, 'e2e', 'lanes', '0'))).toEqual(['about-2'])
    expect(there(m.root, 'e2e/lanes/1/board-profile/x')).toBe(true)
    expect(readdirSync(join(m.root, 'e2e', 'lanes', '3'))).toEqual(['plan'])
    expect(there(m.root, 'e2e/review13-cited')).toBe(true)
    expect(there(m.root, 'codex/auth.json')).toBe(true)
    // The machine's test settings stay too (#589: else the slot count would quietly go back to two); stale output goes.
    expect(there(m.root, 'config.json')).toBe(true)
    expect(there(m.root, 'charts-132')).toBe(false)
    expect(there(m.root, 'short tmp')).toBe(false)
    expect(readdirSync(join(m.root, 'tmp'))).toEqual([])
  })

  it("never follows a link out (a worktree's node_modules junction)", async () => {
    const m = machine()
    const outside = temp('cw-clean-outside-')
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    symlinkSync(outside, join(m.root, 'charts-132', 'node_modules'), 'junction')
    const r = await run(m, { days: 0 })
    expect(r.failed).toEqual([])
    expect(there(m.root, 'charts-132')).toBe(false)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
  })

  it('a lane being cleaned is claimed: a runner takes another; a held lane is not cleaned', async () => {
    const dir = temp('cw-clean-lanes-')
    const release = await holdLane(dir, 0, { owner: 10, alive: () => true })
    expect(release).toBeTypeOf('function')
    const runner = await claimLane(dir, { owner: 11, alive: () => true, free: async () => true })
    expect(runner.lane).toBe(1)
    expect(await holdLane(dir, 1, { owner: 12, alive: () => true })).toBe(null)
    release()
    expect(existsSync(join(dir, 'lane-0.json'))).toBe(false)
    expect(existsSync(join(dir, 'lane-1.json'))).toBe(true)
  })

  it('plan says why for each thing it looked at', () => {
    const m = machine()
    const items = plan({ root: m.root, ev: rules(m.root, m.cards), held: (k: number) => k === 1 })
    const why = (rel: string) => items.find((i: { rel: string }) => i.rel === rel)?.why
    expect(why('e2e/lanes/1')).toBe('a runner holds the lane')
    expect(why('e2e/lanes/0/board-profile')).toMatch(/before suites had folders of their own/)
    expect(why('e2e/lanes/0/about-2')).toMatch(/its failed run keeps it/)
    expect(why('e2e/lanes/0/about-7')).toBe('no run keeps it')
    expect(why('scenarios/lanes/0/new-scenario-3')).toBe('a copy an earlier run left')
    expect(why('charts-132')).toMatch(/days old/)
    expect(why('short tmp')).toBe('newer than 3 days')
    // The unit tests' temp folders (tests/tempDir.ts, #992) go after a day; the folder itself stays.
    expect(why('tmp/hive-git-old-x')).toMatch(/^2\.\d days old$/)
    expect(why('tmp/hive-git-new-y')).toBe('newer than 1 day')
    expect(why('tmp')).toBe(undefined)
    expect(why('codex')).toBe(undefined)
  })
})

describe('the Codex test home (#404): old rollouts, package copies and unfinished downloads go, never its sign-in or sandbox', () => {
  /** A Codex test home with something of each kind, as Codex 0.162 leaves it. */
  function codexMachine() {
    const root = temp('cw-clean-codex-')
    tree(root, {
      'codex/auth.json': 30,
      'codex/config.toml': 30,
      'codex/cap_sid': 30,
      'codex/.sandbox/setup.json': 30,
      'codex/.sandbox-bin/codex.exe': 30,
      'codex/logs_2.sqlite': 30,
      'codex/state_5.sqlite': 30,
      'codex/session_index.jsonl': 30,
      'codex/history.jsonl': 30,
      'codex/plugins/cache/p.json': 30,
      'codex/skills/s/SKILL.md': 30,
      'codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-a.jsonl': 40,
      'codex/sessions/2026/09/02/rollout-2026-09-02T00-00-00-b.jsonl': 39,
      'codex/sessions/2026/10/05/rollout-2026-10-05T00-00-00-c.jsonl': 6,
      'codex/sessions/2026/10/10/rollout-2026-10-10T00-00-00-d.jsonl': 5,
      'codex/sessions/2026/10/10/rollout-2026-10-10T09-00-00-e.jsonl': 0,
      'codex/sessions/2026/10/11/rollout-2026-10-11T00-00-00-f.jsonl': 0,
      'codex/packages/app-server-daemon/auto-update-version': 10,
      'codex/packages/app-server-daemon/releases/0.159.0-x86_64-pc-windows-msvc/codex.exe': 20,
      'codex/packages/app-server-daemon/releases/0.160.0-x86_64-pc-windows-msvc/codex.exe': 10,
      'codex/packages/app-server-daemon/releases/0.160.1-x86_64-pc-windows-msvc/codex.exe': 10,
      'codex/packages/unknown/releases/1.0/x': 30,
      'codex/cache/remote_plugin_catalog/6216f936f7b7ca60.json': 0,
      'codex/cache/remote_plugin_catalog/.tmpOld': 10,
      'codex/cache/remote_plugin_catalog/.tmpNew': 0
    })
    const pkg = join(root, 'codex', 'packages', 'app-server-daemon')
    writeFileSync(join(pkg, 'auto-update-version'), '0.160.1-x86_64-pc-windows-msvc')
    // Codex's `current` link names the copy it runs; the version file names the one it updates to.
    symlinkSync(join(pkg, 'releases', '0.160.0-x86_64-pc-windows-msvc'), join(pkg, 'current'), 'junction')
    return { root, lanesDir: join(root, 'e2e-lanes') }
  }
  const run = (m: { root: string; lanesDir: string }, o: Record<string, unknown> = {}) => clean({ root: m.root, lanesDir: m.lanesDir, ev: rules(m.root, []), alive: () => true, owner: 777, ...o })
  const there = (root: string, p: string) => existsSync(join(root, 'codex', p))

  it('removes only rollouts older than the age, package copies Codex no longer runs and old unfinished downloads', async () => {
    const m = codexMachine()
    const r = await run(m)
    expect(r.removed.map((x: { rel: string }) => x.rel).sort()).toEqual([
      'codex/cache/remote_plugin_catalog/.tmpOld',
      'codex/packages/app-server-daemon/releases/0.159.0-x86_64-pc-windows-msvc',
      'codex/sessions/2026/09',
      'codex/sessions/2026/10/05',
      'codex/sessions/2026/10/10/rollout-2026-10-10T00-00-00-d.jsonl'
    ])
    // The sign-in, config, sandbox setup, databases, plugins, skills and history stay, and so do new rollouts, the copy
    // Codex runs and the one it updates to, a package with neither named, and the cache itself.
    for (const p of ['auth.json', 'config.toml', 'cap_sid', '.sandbox/setup.json', '.sandbox-bin/codex.exe', 'logs_2.sqlite', 'state_5.sqlite', 'session_index.jsonl', 'history.jsonl', 'plugins/cache/p.json', 'skills/s/SKILL.md', 'sessions/2026/10/10/rollout-2026-10-10T09-00-00-e.jsonl', 'sessions/2026/10/11', 'packages/app-server-daemon/current/codex.exe', 'packages/app-server-daemon/releases/0.160.1-x86_64-pc-windows-msvc', 'packages/unknown/releases/1.0/x', 'cache/remote_plugin_catalog/6216f936f7b7ca60.json', 'cache/remote_plugin_catalog/.tmpNew'])
      expect(there(m.root, p), p).toBe(true)
    // The lease it took is let go.
    expect(readdirSync(join(m.root, 'codex-home-locks')).flatMap((d) => readdirSync(join(m.root, 'codex-home-locks', d)))).toEqual([])
  })

  it('a dry run lists them, saying why, and removes nothing', async () => {
    const m = codexMachine()
    const r = await run(m, { dryRun: true })
    const why = (rel: string) => r.items.find((i: { rel: string }) => i.rel === rel)?.why
    expect(why('codex/sessions/2026/09')).toBe('rollouts all older than 3 days')
    expect(why('codex/packages/app-server-daemon/releases/0.159.0-x86_64-pc-windows-msvc')).toMatch(/no longer runs \(it runs 0\.160\.0-x86_64-pc-windows-msvc, 0\.160\.1-x86_64-pc-windows-msvc\)/)
    expect(why('codex/cache/remote_plugin_catalog/.tmpOld')).toMatch(/unfinished download/)
    expect(r.removed).toEqual([])
    expect(there(m.root, 'sessions/2026/09/01')).toBe(true)
  })

  it('removes nothing in it while a run holds the Codex test home, and keeps what a card cites', async () => {
    const m = codexMachine()
    // A real Codex suite's lease on the home (codexHomeLock.mjs), held by a live process.
    const lease = await acquireCodexHome(join(m.root, 'codex'), { poolRoot: join(m.root, 'codex-home-locks'), wait: false, owner: 4242, alive: () => true })
    expect(lease.release).toBeTypeOf('function')
    const held = await run(m)
    expect(held.removed).toEqual([])
    expect(held.failed.map((f: { error: string }) => f.error)).toEqual(Array(5).fill('a run is using the Codex test home'))
    lease.release()
    // A card naming the home and its folders, as cards about Codex do, keeps nothing (they're places, like a lane);
    // one citing a rollout keeps it.
    const cards = [
      card(404, 'the rollout: combwork-test\\codex\\sessions\\2026\\10\\05\\rollout-2026-10-05T00-00-00-c.jsonl'),
      card(405, 'the home %LOCALAPPDATA%\\combwork-test\\codex, its codex\\sessions and codex\\sessions\\2026, codex\\packages\\app-server-daemon\\releases and codex\\cache\\remote_plugin_catalog')
    ]
    const cited = await run(m, { ev: rules(m.root, cards) })
    expect(there(m.root, 'sessions/2026/10/05/rollout-2026-10-05T00-00-00-c.jsonl')).toBe(true)
    expect(cited.items.find((i: { rel: string }) => i.rel === 'codex/sessions/2026/10/05').why).toBe('cited by #404')
    for (const p of ['sessions/2026/09', 'packages/app-server-daemon/releases/0.159.0-x86_64-pc-windows-msvc', 'cache/remote_plugin_catalog/.tmpOld']) expect(there(m.root, p), p).toBe(false)
  })

  const PKG = 'codex/packages/app-server-daemon'
  const OLD = '0.159.0-x86_64-pc-windows-msvc'
  const removedRels = (r: { removed: { rel: string }[] }) => r.removed.map((x) => x.rel).sort()

  it('never deletes through a link: a package, cache or sessions folder that is a junction into the sandbox, config or outside', async () => {
    const m = codexMachine()
    const outside = temp('cw-clean-codex-outside-')
    tree(outside, { 'cache/.tmpOutside': 30, 'sessions/2026/01/01/rollout-2026-01-01T00-00-00-z.jsonl': 30 })
    // releases → .sandbox-bin, with the marker naming another release: its codex.exe would look like an unused one.
    tree(m.root, { 'codex/packages/linked/auto-update-version': 30, 'codex/.sandbox-bin/1.0/': 30 })
    writeFileSync(join(m.root, 'codex/packages/linked/auto-update-version'), '1.0')
    symlinkSync(join(m.root, 'codex', '.sandbox-bin'), join(m.root, 'codex/packages/linked/releases'), 'junction')
    // A cache folder and a year of sessions that are links out of the home.
    symlinkSync(join(outside, 'cache'), join(m.root, 'codex/cache/linked'), 'junction')
    symlinkSync(join(outside, 'sessions', '2026'), join(m.root, 'codex/sessions/2025'), 'junction')
    const r = await run(m)
    expect(removedRels(r)).toEqual(['codex/cache/remote_plugin_catalog/.tmpOld', `${PKG}/releases/${OLD}`, 'codex/sessions/2026/09', 'codex/sessions/2026/10/05', 'codex/sessions/2026/10/10/rollout-2026-10-10T00-00-00-d.jsonl'])
    expect(there(m.root, '.sandbox-bin/codex.exe')).toBe(true)
    expect(existsSync(join(outside, 'cache/.tmpOutside'))).toBe(true)
    expect(existsSync(join(outside, 'sessions/2026/01/01/rollout-2026-01-01T00-00-00-z.jsonl'))).toBe(true)
  })

  it('an item a link appears on the way to after the plan stays (its check says so)', () => {
    const m = codexMachine()
    const item = codexPlan({ root: m.root, ev: rules(m.root, []) }).find((i: { rel: string }) => i.rel === `${PKG}/releases/${OLD}`)
    expect(item.check()).toBe(null)
    // The releases folder swapped for a junction to a copy of it elsewhere: the same path now leads somewhere else.
    const elsewhere = temp('cw-clean-codex-swap-')
    cpSync(join(m.root, PKG, 'releases'), elsewhere, { recursive: true })
    renameSync(join(m.root, PKG, 'releases'), join(m.root, PKG, 'releases-moved'))
    symlinkSync(elsewhere, join(m.root, PKG, 'releases'), 'junction')
    expect(item.check()).toBe('a link is on its way')
  })

  it('plans the home again under its lease: a release Codex took up, or rollouts refreshed, before the lease stay', async () => {
    const m = codexMachine()
    const rollout = join(m.root, 'codex/sessions/2026/10/05/rollout-2026-10-05T00-00-00-c.jsonl')
    // Between the first look and the lease: Codex updates to the old release, and appends to an old rollout.
    const acquire = (...a: unknown[]) => {
      writeFileSync(join(m.root, PKG, 'auto-update-version'), OLD)
      appendFileSync(rollout, 'more')
      return acquireCodexHome(...a)
    }
    const first = plan({ root: m.root, ev: rules(m.root, []) })
    expect(first.filter((i: { remove: boolean }) => i.remove).map((i: { rel: string }) => i.rel)).toContain(`${PKG}/releases/${OLD}`)
    const r = await run(m, { acquire })
    // 0.160.1, which the marker named before, is the one no longer in use now.
    expect(removedRels(r)).toEqual(['codex/cache/remote_plugin_catalog/.tmpOld', `${PKG}/releases/0.160.1-x86_64-pc-windows-msvc`, 'codex/sessions/2026/09', 'codex/sessions/2026/10/10/rollout-2026-10-10T00-00-00-d.jsonl'])
    expect(there(m.root, `packages/app-server-daemon/releases/${OLD}`)).toBe(true)
    expect(existsSync(rollout)).toBe(true)
  })

  it('each item is checked again just before it goes: a release now in use, a refreshed rollout or download stays', () => {
    const m = codexMachine()
    const items = codexPlan({ root: m.root, ev: rules(m.root, []) })
    const item = (rel: string) => items.find((i: { rel: string }) => i.rel === rel)
    for (const i of items) expect(i.check(), i.rel).toBe(null)
    writeFileSync(join(m.root, PKG, 'auto-update-version'), OLD)
    expect(item(`${PKG}/releases/${OLD}`).check()).toMatch(/runs it now/)
    const t = new Date()
    utimesSync(join(m.root, 'codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-a.jsonl'), t, t)
    expect(item('codex/sessions/2026/09').check()).toBe('it changed since the plan')
    utimesSync(join(m.root, 'codex/cache/remote_plugin_catalog/.tmpOld'), t, t)
    expect(item('codex/cache/remote_plugin_catalog/.tmpOld').check()).toBe('it changed since the plan')
  })

  it("keeps every release of a package when which it runs can't be told: a blank, malformed or missing marker or link", () => {
    const cases: [string, (pkg: string) => void][] = [
      ['a blank marker, no link', (pkg) => writeFileSync(join(pkg, 'auto-update-version'), '  \n')],
      ['a malformed marker', (pkg) => writeFileSync(join(pkg, 'auto-update-version'), '..\\..\\.sandbox-bin')],
      ['a marker naming no release there', (pkg) => writeFileSync(join(pkg, 'auto-update-version'), '9.9.9')],
      ['a good marker but a link out of releases', (pkg) => {
        writeFileSync(join(pkg, 'auto-update-version'), '2.0')
        symlinkSync(join(pkg, '..', '..', '.sandbox-bin'), join(pkg, 'current'), 'junction')
      }],
      ['a good link but a blank marker', (pkg) => {
        writeFileSync(join(pkg, 'auto-update-version'), '')
        symlinkSync(join(pkg, 'releases', '2.0'), join(pkg, 'current'), 'junction')
      }]
    ]
    for (const [what, make] of cases) {
      const root = temp('cw-clean-codex-markers-')
      tree(root, { 'codex/auth.json': 30, 'codex/.sandbox-bin/codex.exe': 30, 'codex/packages/p/releases/1.0/x': 30, 'codex/packages/p/releases/2.0/x': 30 })
      make(join(root, 'codex/packages/p'))
      expect(codexPlan({ root, ev: rules(root, []) }), what).toEqual([])
    }
    // Both told and agreeing with what is there: the others go.
    const root = temp('cw-clean-codex-markers-')
    tree(root, { 'codex/packages/p/releases/1.0/x': 30, 'codex/packages/p/releases/2.0/x': 30, 'codex/packages/p/releases/3.0/x': 30 })
    writeFileSync(join(root, 'codex/packages/p/auto-update-version'), '3.0')
    symlinkSync(join(root, 'codex/packages/p/releases/2.0'), join(root, 'codex/packages/p/current'), 'junction')
    expect(codexPlan({ root, ev: rules(root, []) }).map((i: { rel: string }) => i.rel)).toEqual(['codex/packages/p/releases/1.0'])
  })

  it("never looks in a user's own ~/.codex", () => {
    const home = join(process.env.USERPROFILE ?? '', '.codex')
    expect(codexPlan({ root: join(home, '..'), home, days: 0, ev: rules(temp('cw-clean-codex-user-'), []) })).toEqual([])
  })
})

describe("the runners' own deletions keep evidence too", () => {
  it("a suite's folder: reused when nothing in it is cited, else the next free one; never another run's evidence", () => {
    const root = temp('cw-clean-suite-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'board/board.png': 0, 'board/board-profile/x': 0, 'about/about.png': 0, 'about/about-ws/a.ts': 0 })
    const ev = rules(root, [card(400, 'failed: combwork-test\\e2e\\lanes\\0\\board\\board.png')])
    // Cited: kept as it was, the run gets board-2.
    expect(freshFolder(join(lane, 'board'), ev)).toBe(join(lane, 'board-2'))
    expect(readFileSync(join(lane, 'board', 'board.png'), 'utf8')).toHaveLength(100)
    expect(readdirSync(join(lane, 'board-2'))).toEqual([])
    // Not cited: emptied and reused.
    expect(freshFolder(join(lane, 'about'), ev)).toBe(join(lane, 'about'))
    expect(readdirSync(join(lane, 'about'))).toEqual([])
  })

  it("…and while the board can't be read, an earlier folder is never emptied", () => {
    const root = temp('cw-clean-suite-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'about/about.png': 0 })
    expect(freshFolder(join(lane, 'about'), rules(root, null))).toBe(join(lane, 'about-2'))
    expect(existsSync(join(lane, 'about', 'about.png'))).toBe(true)
  })

  it("after a pass the suite's whole folder goes; a failed one's, or one a card cites something in, stays (#285)", () => {
    const root = temp('cw-clean-suite-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'board/board-profile/Cache/x': 0, 'board/evidence/shot.png': 0, 'board/board.png': 0, 'about/about-ws/a.ts': 0, 'about/about.png': 0, 'plan/plan-ws/a.ts': 0 })
    // A card naming the whole lane keeps nothing; one naming a file in board keeps board.
    const ev = rules(root, [card(285, '`e2e\\lanes\\0` = 23 GB'), card(401, 'lanes\\0\\board\\evidence\\shot.png')])
    expect(finishSuiteDir(join(lane, 'about'), ev, true)).toEqual({ removed: true, kept: null })
    expect(existsSync(join(lane, 'about'))).toBe(false)
    expect(finishSuiteDir(join(lane, 'board'), ev, true)).toEqual({ removed: false, kept: 'cited by #401' })
    expect(lstatSync(join(lane, 'board', 'evidence', 'shot.png')).isFile()).toBe(true)
    expect(finishSuiteDir(join(lane, 'plan'), ev, false)).toEqual({ removed: false, kept: 'it failed' })
    expect(readdirSync(lane).sort()).toEqual(['board', 'plan'])
  })

  it('suite folders never pile up: a failed one goes with its run (KEEP_RUNS), a passed one at once (#285)', async () => {
    const root = temp('cw-clean-runs-')
    const lane = join(root, 'e2e', 'lanes', '0')
    const logs = join(root, 'e2e', 'logs')
    // The runner holds lane 0 (this process), as it does while it prunes its runs.
    const lanesDir = join(root, 'e2e-lanes')
    mkdirSync(lanesDir, { recursive: true })
    writeFileSync(join(lanesDir, 'lane-0.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
    const hold = (k: number) => holdLane(lanesDir, k)
    // Cards naming the lane as a place (as #253's and #285's did) change nothing.
    const ev = rules(root, [card(285, 'e2e\\lanes\\0 holds 23 GB'), card(253, '`e2e\\lanes\\0–9`')])
    const suites = ['about', 'board', 'plan']
    const keep = 1
    /** One run: each suite in a fresh folder of its own, a file written in it, failed ones kept with the run. */
    const runOnce = async (sec: number, failing: string[]) => {
      const runDir = newRunDir(logs, new Date(2026, 9, 6, 12, 0, sec))
      const claimed = claimedByRuns([logs])
      for (const s of suites) {
        const dir = freshFolder(join(lane, s), ev, { claimed: (d: string) => claimed.has(resolve(d).toLowerCase()) })
        writeFileSync(join(dir, `${s}.png`), 'x'.repeat(1000))
        mkdirSync(join(dir, `${s}-profile`))
        const end = finishSuiteDir(dir, ev, !failing.includes(s))
        if (end.kept) recordKept(runDir, [dir])
      }
      finishRunDirs([runDir])
      await pruneRunDirsReleasing(logs, keep, [runDir], () => false, (p: string) => ev.protects(p), { release: (d: string) => releaseKept(d, ev, { hold, testRoot: root }) })
      return readdirSync(lane).sort()
    }
    // Run 1: about fails, kept with run 1.
    expect(await runOnce(1, ['about'])).toEqual(['about'])
    // Run 2: about (run 1 still keeps the old one: about-2) and board fail; run 1's logs go, and its about with them.
    expect(await runOnce(2, ['about', 'board'])).toEqual(['about-2', 'board'])
    // Run 3: all pass; run 2's logs go with its folders. Nothing is left.
    expect(await runOnce(3, [])).toEqual([])
    // Its own lane's claim is still its own.
    expect(JSON.parse(readFileSync(join(lanesDir, 'lane-0.json'), 'utf8')).pid).toBe(process.pid)
    // Many runs, failing in turns: the lane never holds more than the suites' failed folders of the kept runs.
    for (let i = 0; i < 12; i++) expect((await runOnce(10 + i, [suites[i % 3]])).length, `run ${i}`).toBeLessThanOrEqual(suites.length * (keep + 1))
  })

  it("a run's kept folders in a lane another runner holds are left for the clean-up, never removed under it", async () => {
    const root = temp('cw-clean-held-')
    const lanesDir = join(root, 'e2e-lanes')
    tree(root, { 'e2e/lanes/0/about/about.png': 0, 'e2e/lanes/2/board/board.png': 0, 'e2e/logs/run-20261006-120000/about.log': 0 })
    const run = join(root, 'e2e', 'logs', 'run-20261006-120000')
    recordKept(run, [join(root, 'e2e', 'lanes', '0', 'about'), join(root, 'e2e', 'lanes', '2', 'board')])
    mkdirSync(lanesDir, { recursive: true })
    // Lane 0: another runner (alive) holds it. Lane 2: idle, but a runner takes it just as the release looks.
    writeFileSync(join(lanesDir, 'lane-0.json'), JSON.stringify({ pid: 4242, at: Date.now() }))
    const alive = (pid: number) => pid === 4242 || pid === 4343
    const hold = async (k: number) => {
      if (k === 2) writeFileSync(join(lanesDir, 'lane-2.json'), JSON.stringify({ pid: 4343, at: Date.now() }))
      return holdLane(lanesDir, k, { owner: 1, alive })
    }
    const ev = rules(root, [])
    expect(await releaseKept(run, ev, { hold, testRoot: root })).toEqual({ removed: 0, deferred: 2, refused: null })
    expect(existsSync(join(root, 'e2e', 'lanes', '0', 'about', 'about.png'))).toBe(true)
    expect(existsSync(join(root, 'e2e', 'lanes', '2', 'board', 'board.png'))).toBe(true)
    // The run's logs go; once the lanes are idle, the clean-up finds the folders no run claims and removes them.
    rmSync(run, { recursive: true, force: true })
    for (const k of [0, 2]) rmSync(join(lanesDir, `lane-${k}.json`))
    const r = await clean({ root, lanesDir, ev, alive, owner: 1 })
    expect(r.removed.map((x: { rel: string }) => x.rel).sort()).toEqual(['e2e/lanes/0/about', 'e2e/lanes/2/board'])
  })

  it('a kept-folders manifest authorises nothing unless every entry is a suite folder in a lane', async () => {
    const root = temp('cw-clean-manifest-')
    const outside = temp('cw-clean-outside-')
    tree(root, {
      'codex/auth.json': 0,
      'claude/.credentials.json': 0,
      'scenarios/results/kept-run/results.json': 0,
      'e2e/lanes/0/about/about.png': 0,
      'e2e/lanes/0/board/nested/plan/plan.png': 0,
      'e2e/logs/run-1/a.log': 0
    })
    symlinkSync(outside, join(root, 'e2e', 'lanes', '0', 'linked'), 'junction')
    const run = join(root, 'e2e', 'logs', 'run-1')
    const ev = rules(root, [])
    const hold = async () => () => {}
    const write = (entries: unknown) => writeFileSync(join(run, '.kept-folders.json'), JSON.stringify(entries))
    const at = (...p: string[]) => join(root, ...p)
    const bad = [
      at('codex', 'auth.json'),
      at('claude', '.credentials.json'),
      at('codex'),
      at('scenarios', 'results', 'kept-run'),
      at('e2e', 'lanes', '0'),
      at('e2e', 'lanes'),
      root,
      `${at('e2e', 'lanes', '0', 'about')}\\..\\..\\..\\..\\codex`,
      'e2e\\lanes\\0\\about',
      at('e2e', 'lanes', '0', 'linked'),
      42
    ]
    for (const entry of bad) {
      // Alone, or beside a valid entry: nothing at all is removed.
      for (const entries of [[entry], [at('e2e', 'lanes', '0', 'about'), entry]]) {
        write(entries)
        const r = await releaseKept(run, ev, { hold, testRoot: root })
        expect(r.removed, JSON.stringify(entry)).toBe(0)
        expect(r.refused, JSON.stringify(entry)).toMatch(/not a suite folder in a lane/)
      }
    }
    write({ not: 'a list' })
    expect((await releaseKept(run, ev, { hold, testRoot: root })).refused).toMatch(/isn't a list/)
    for (const p of ['codex/auth.json', 'claude/.credentials.json', 'scenarios/results/kept-run/results.json', 'e2e/lanes/0/about/about.png']) expect(existsSync(join(root, p)), p).toBe(true)
    expect(readdirSync(outside)).toEqual([])
    // A valid manifest: a suite folder, and a nested run's inside one.
    write([at('e2e', 'lanes', '0', 'about'), at('e2e', 'lanes', '0', 'board', 'nested', 'plan')])
    expect(await releaseKept(run, ev, { hold, testRoot: root })).toEqual({ removed: 2, deferred: 0, refused: null })
    expect(existsSync(at('e2e', 'lanes', '0', 'about'))).toBe(false)
    expect(existsSync(at('e2e', 'lanes', '0', 'board', 'nested', 'plan'))).toBe(false)
    expect(existsSync(at('e2e', 'lanes', '0', 'board'))).toBe(true)
  })

  it('nothing is deleted through a link on the way: a linked lane, a linked parent of a nested run, one linked meanwhile', async () => {
    const root = temp('cw-clean-linked-')
    const outside = temp('cw-clean-outside-')
    tree(outside, { 'about/precious.txt': 0, 'plan/precious.txt': 0, 'swap/plan/precious.txt': 0 })
    tree(root, { 'e2e/lanes/0/about/about.png': 0, 'e2e/lanes/0/board/board.png': 0, 'e2e/logs/run-1/a.log': 0 })
    // Lane 1 is a junction to the outside folder; board's nested/ in lane 0 too.
    symlinkSync(outside, join(root, 'e2e', 'lanes', '1'), 'junction')
    symlinkSync(outside, join(root, 'e2e', 'lanes', '0', 'board', 'nested'), 'junction')
    const run = join(root, 'e2e', 'logs', 'run-1')
    const ev = rules(root, [])
    const hold = async () => () => {}
    const write = (entries: string[]) => writeFileSync(join(run, '.kept-folders.json'), JSON.stringify(entries))
    const valid = join(root, 'e2e', 'lanes', '0', 'about')
    for (const linked of [join(root, 'e2e', 'lanes', '1', 'about'), join(root, 'e2e', 'lanes', '0', 'board', 'nested', 'plan')]) {
      write([valid, linked])
      const r = await releaseKept(run, ev, { hold, testRoot: root })
      expect(r.removed, linked).toBe(0)
      expect(r.refused, linked).toMatch(/not a suite folder in a lane/)
    }
    expect(existsSync(join(outside, 'about', 'precious.txt'))).toBe(true)
    expect(existsSync(join(outside, 'plan', 'precious.txt'))).toBe(true)
    expect(existsSync(join(valid, 'about.png'))).toBe(true)
    // The rule every deletion asks says so too.
    expect(ev.protects(join(root, 'e2e', 'lanes', '1', 'about'))).toMatch(/reached through a link/)
    // A folder on the way turned into a link while the release waited for the lane: checked again, nothing goes.
    tree(root, { 'e2e/lanes/2/board/nested/plan/plan.png': 0 })
    write([join(root, 'e2e', 'lanes', '2', 'board', 'nested', 'plan')])
    const swap = async () => {
      rmSync(join(root, 'e2e', 'lanes', '2', 'board', 'nested'), { recursive: true, force: true })
      symlinkSync(join(outside, 'swap'), join(root, 'e2e', 'lanes', '2', 'board', 'nested'), 'junction')
      return () => {}
    }
    const late = await releaseKept(run, ev, { hold: swap, testRoot: root })
    expect(late.removed).toBe(0)
    expect(late.refused).toMatch(/no longer a suite folder reached through no link/)
    expect(existsSync(join(outside, 'swap', 'plan', 'precious.txt'))).toBe(true)
    // The clean-up doesn't delete through a linked lane either.
    const cleaned = await clean({ root, lanesDir: join(root, 'e2e-lanes'), ev, owner: 779, days: 0 })
    expect(cleaned.removed.map((x: { rel: string }) => x.rel)).not.toContain('e2e/lanes/1/about')
    for (const f of ['about/precious.txt', 'plan/precious.txt', 'swap/plan/precious.txt']) expect(existsSync(join(outside, f)), f).toBe(true)
  })

  it('the copies of a folder are capped: past MAX_COPIES the suite is refused, saying what keeps them', () => {
    const root = temp('cw-clean-cap-')
    const lane = join(root, 'e2e', 'lanes', '0')
    tree(lane, { 'about/x': 0, 'about-2/x': 0, 'about-3/x': 0 })
    const all = () => 'cited by #9'
    expect(() => freshFolder(join(lane, 'about'), { protects: all }, { max: 3 })).toThrow(/3 copies of about are kept .* \(cited by #9\)/)
    expect(MAX_COPIES).toBeGreaterThanOrEqual(30)
  })

  /** A real board folder: cards written as Combwork writes them, so a test can change one between two looks. */
  function board(root: string) {
    const dir = join(root, 'board')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'board.json'), '{"next":500}')
    const write = (n: number, c: object) => writeFileSync(join(dir, `${n}.json`), JSON.stringify({ number: n, title: 't', description: '', comments: [], column: 'todo', ...c }))
    write(1, { description: 'nothing cited' })
    return { dir, write }
  }

  it('a card that cites a folder after an earlier look still keeps it: every deletion reads the board afresh', () => {
    const root = temp('cw-clean-live-')
    const b = board(root)
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    const dir = join(root, 'e2e', 'lanes', '0', 'board')
    const profile = join(dir, 'board-profile')
    tree(dir, { 'board-profile/evidence.txt': 0, 'board-ws/a.ts': 0 })
    // Looked at while nothing cited it…
    expect(ev.protects(profile)).toBe(null)
    // …then a card in Review cites a file in it, and the suite passes at once.
    b.write(2, { column: 'review', comments: [{ text: 'see combwork-test/e2e/lanes/0/board/board-profile/evidence.txt' }] })
    expect(finishSuiteDir(dir, ev, true)).toEqual({ removed: false, kept: 'cited by #2' })
    expect(readFileSync(join(profile, 'evidence.txt'), 'utf8')).toHaveLength(100)
    // The same for a folder the next run would take over, and for the clean-up's removals.
    expect(freshFolder(dir, ev)).toBe(`${dir}-2`)
    expect(existsSync(join(profile, 'evidence.txt'))).toBe(true)
  })

  it("a fresh folder cited during the run, then the board unreadable at its clean-up: nothing goes, and it says why", () => {
    const root = temp('cw-clean-live-')
    const b = board(root)
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    const lane = join(root, 'e2e', 'lanes', '0')
    const dir = freshFolder(join(lane, 'about'), ev)
    expect(dir).toBe(join(lane, 'about'))
    tree(dir, { 'evidence/shot.png': 0, 'about-profile/x': 0, 'about.png': 0 })
    b.write(3, { description: 'combwork-test\\e2e\\lanes\\0\\about\\evidence\\shot.png' })
    // A card being saved badly (or the board gone) when the suite passes: everything stays.
    writeFileSync(join(b.dir, '4.json'), '{ half-written')
    const r = finishSuiteDir(dir, ev, true)
    expect(r.removed).toBe(false)
    expect(r.kept).toMatch(/card 4\.json .* can't be read/)
    expect(readdirSync(dir).sort()).toEqual(['about-profile', 'about.png', 'evidence'])
    // Readable again: it still stays (a card cites something in it); an uncited one goes.
    b.write(4, { description: 'fixed' })
    expect(finishSuiteDir(dir, ev, true)).toEqual({ removed: false, kept: 'cited by #3' })
    const other = freshFolder(join(lane, 'board'), ev)
    expect(finishSuiteDir(other, ev, true)).toEqual({ removed: true, kept: null })
  })

  it("the clean-up checks each removal against the board as it is then, not as it was when it listed them", async () => {
    const root = temp('cw-clean-live-')
    const b = board(root)
    tree(root, { 'charts-132/a.png': 10, 'evidence-old/b.png': 10 })
    const ev = evidence({ tasksDir: b.dir, testRoot: root })
    // The listing sees both as stale; a card cites one between the listing and its removal.
    const real = ev.snapshot
    ev.snapshot = () => {
      const s = real()
      b.write(5, { description: 'combwork-test\\evidence-old\\b.png' })
      return s
    }
    const r = await clean({ root, lanesDir: join(root, 'e2e-lanes'), ev, owner: 778 })
    expect(r.removed.map((x: { rel: string }) => x.rel)).toEqual(['charts-132'])
    expect(r.failed).toEqual([{ rel: 'evidence-old', error: 'cited by #5' }])
    expect(existsSync(join(root, 'evidence-old', 'b.png'))).toBe(true)
  })

  it('log pruning keeps a run a card cites (beyond KEEP_RUNS), and every run while the board is unreadable', () => {
    const root = temp('cw-clean-logs-')
    const logs = join(root, 'e2e', 'logs')
    const names = Array.from({ length: 6 }, (_, k) => `run-20261005-23000${k}`)
    for (const n of names) tree(logs, { [`${n}/board.log`]: 0 })
    const ev = rules(root, [card(256, 'C:\\Users\\X\\AppData\\Local\\combwork-test\\e2e\\logs\\run-20261005-230000 has the failure')])
    const gone = pruneRunDirs(logs, 2, [], () => false, (p: string) => ev.protects(p))
    expect(gone).toEqual(names.slice(1, 4))
    expect(readdirSync(logs).sort()).toEqual([names[0], names[4], names[5]])
    expect(pruneRunDirs(logs, 0, [], () => false, (p: string) => rules(root, null).protects(p))).toEqual([])
  })

  it("the runner's prune lists with one look at the board, and asks afresh only for each run about to go (HI-2364)", async () => {
    const root = temp('cw-clean-look-')
    const logs = join(root, 'e2e', 'logs')
    const names = Array.from({ length: 8 }, (_, k) => `run-20261005-23000${k}`)
    for (const n of names) tree(logs, { [`${n}/board.log`]: 0 })
    // The list's look: no card cites anything. Since then, a card cites the second oldest run.
    const listed: string[] = []
    const asked: string[] = []
    const fresh = rules(root, [card(2364, `combwork-test\\e2e\\logs\\${names[1]} kept it alive`)])
    const released: string[] = []
    const gone = await pruneRunDirsReleasing(logs, 2, [], () => false, (p: string) => (asked.push(basename(p)), fresh.protects(p)), {
      listSpare: (p: string) => (listed.push(basename(p)), null),
      release: async (d: string) => void released.push(basename(d))
    })
    // Every run folder listed once; the board asked again only for the six that were to go (before and after each release).
    expect(listed.sort()).toEqual(names)
    expect([...new Set(asked)]).toEqual(names.slice(0, 6))
    // The run cited since the list stays, never released; the rest go.
    expect(gone).toEqual(names.slice(0, 6).filter((n) => n !== names[1]))
    expect(released).toEqual(gone)
    expect(readdirSync(logs).sort()).toEqual([names[1], names[6], names[7]])
  })

  it('…and a run a card cites while its release waits (for a lane) keeps its logs (HI-2364 review)', async () => {
    const root = temp('cw-clean-release-')
    const logs = join(root, 'e2e', 'logs')
    const names = Array.from({ length: 4 }, (_, k) => `run-20261005-23000${k}`)
    for (const n of names) tree(logs, { [`${n}/board.log`]: 0 })
    let cards: Card[] = []
    const spare = (p: string) => rules(root, cards).protects(p)
    const released: string[] = []
    const gone = await pruneRunDirsReleasing(logs, 2, [], () => false, spare, {
      listSpare: () => null,
      release: async (d: string) => {
        released.push(basename(d))
        // While the first run's release waits, a card cites it.
        if (basename(d) === names[0]) cards = [card(2364, `combwork-test\\e2e\\logs\\${names[0]}`)]
      }
    })
    expect(released).toEqual(names.slice(0, 2))
    expect(gone).toEqual([names[1]])
    expect(existsSync(join(logs, names[0]))).toBe(true)
    // The board unreadable while a release waits: nothing goes either.
    const later = await pruneRunDirsReleasing(logs, 0, [], () => false, (p: string) => (cards === null ? rules(root, null).protects(p) : null), {
      listSpare: () => null,
      release: async () => void (cards = null as unknown as Card[])
    })
    expect(later).toEqual([])
    expect(readdirSync(logs).sort()).toEqual([names[0], names[2], names[3]])
  })

  it('scenario results and older baselines a card cites stay', () => {
    const root = temp('cw-clean-sc-')
    const results = join(root, 'scenarios', 'results')
    for (const n of ['2026-10-01T00-00-00-fake', '2026-10-02T00-00-00-fake', '2026-10-03T00-00-00-fake']) tree(results, { [`${n}/results.json`]: 0 })
    const ev = rules(root, [card(272, 'combwork-test/scenarios/results/2026-10-01T00-00-00-fake/summary.md')])
    pruneResults(results, 1, (p: string) => ev.protects(p))
    expect(readdirSync(results).sort()).toEqual(['2026-10-01T00-00-00-fake', '2026-10-03T00-00-00-fake'])
    // Older copies of a baseline: one cited stays when the newest few are kept.
    const baselines = join(root, 'scenarios', 'baselines')
    const file = join(root, 'b.json')
    const cited = rules(root, [card(272, 'combwork-test\\scenarios\\baselines\\x.2026-01-01T00-00-00.json')])
    mkdirSync(baselines, { recursive: true })
    for (let k = 0; k < 7; k++) {
      writeFileSync(file, JSON.stringify({ createdAt: `2026-01-0${k + 1}T00:00:00.000Z` }))
      saveBaseline(baselines, 'x', file, (p: string) => cited.protects(p))
    }
    expect(readdirSync(baselines)).toContain('x.2026-01-01T00-00-00.json')
  })
})

describe('no shell deletes before a rerun (#304): a new folder each run, or clearDir from Node', () => {
  /** A temp folder and a combwork-test of their own, with a scratchpad, a CLI test home and some evidence. */
  function roots() {
    const top = temp('cw-cleardir-')
    const tmp = join(top, 'Temp')
    const testRoot = join(top, 'combwork-test')
    const pad = join(tmp, 'claude', 'D--proj', 'session', 'scratchpad')
    tree(top, {
      'Temp/claude/D--proj/session/scratchpad/shots/a.png': 0,
      'Temp/claude/D--proj/session/scratchpad/kept/b.png': 0,
      'Temp/cw-r2-291-x/c.png': 0,
      'Temp/hive-r2-291-x/c.png': 0,
      'Temp/other-app/d.txt': 0,
      'combwork-test/scratch/probe-1/e.png': 0,
      'combwork-test/e2e/startall-ws/f.ts': 0,
      'combwork-test/e2e/lanes/0/board/g.png': 0,
      'combwork-test/e2e/logs/run-1/h.log': 0,
      'combwork-test/codex/auth.json': 0,
      'combwork-test/claude/.credentials.json': 0
    })
    const homes = [join(testRoot, 'codex'), join(testRoot, 'claude')]
    const board = { cards: [card(401, `evidence: ${join(pad, 'kept', 'b.png')}`)] }
    const clear = (p: string, b: object = board) => clearDir(p, { board: b, temp: tmp, testRoot, homes })
    return { top, tmp, testRoot, pad, homes, clear }
  }

  it('empties (or makes) a probe’s folder in a scratchpad, a cw… temp folder, combwork-test\\scratch or a suite’s own e2e folder', () => {
    const { tmp, testRoot, pad, clear } = roots()
    for (const p of [join(pad, 'shots'), join(tmp, 'cw-r2-291-x'), join(testRoot, 'scratch', 'probe-1'), join(testRoot, 'e2e', 'startall-ws')]) {
      expect(clear(p)).toBe(p)
      expect(readdirSync(p)).toEqual([])
    }
    // Not there yet: made.
    expect(readdirSync(clear(join(pad, 'new', 'deeper')))).toEqual([])
  })

  it('refuses anything outside the temp folder and combwork-test, the areas themselves and other apps’ temp folders', () => {
    const { top, tmp, testRoot, pad, clear } = roots()
    const refused = [
      // Holding the test homes: refused for that first.
      [top, /CLI test home/],
      [testRoot, /CLI test home/],
      [tmp, /outside the temp folder and combwork-test/],
      [join(top, 'elsewhere'), /outside the temp folder and combwork-test/],
      [join(tmp, 'other-app'), /isn't a probe's folder/],
      // One-way rename (HI-2600): a hive… temp folder is no longer a probe's.
      [join(tmp, 'hive-r2-291-x'), /isn't a probe's folder: .*cw… folders/],
      [join(tmp, 'claude'), /isn't a probe's folder/],
      [join(tmp, 'claude', 'D--proj', 'session'), /isn't a probe's folder/],
      [pad, /isn't a probe's folder/],
      [join(testRoot, 'scratch'), /isn't a probe's or a suite's own folder/],
      [join(testRoot, 'e2e'), /isn't a probe's or a suite's own folder/],
      [join(testRoot, 'e2e', 'lanes', '0', 'board'), /isn't a probe's or a suite's own folder/],
      [join(testRoot, 'e2e', 'logs', 'run-1'), /isn't a probe's or a suite's own folder/],
      [join(testRoot, 'scenarios', 'results'), /isn't a probe's or a suite's own folder/],
      ['', /Name the folder/]
    ] as const
    for (const [p, why] of refused) expect(() => clear(p), p).toThrow(why)
    expect(readFileSync(join(tmp, 'other-app', 'd.txt'), 'utf8')).toHaveLength(100)
    expect(readdirSync(join(tmp, 'hive-r2-291-x'))).toEqual(['c.png'])
    expect(readFileSync(join(testRoot, 'e2e', 'lanes', '0', 'board', 'g.png'), 'utf8')).toHaveLength(100)
  })

  it('never a CLI test home, in one or holding one, whatever the area', () => {
    const { testRoot, homes } = roots()
    const tmp2 = temp('cw-cleardir-home-')
    // A test home inside the scratch area (CW_TEST_CODEX_HOME pointed there): still refused, and its parent too.
    const home = join(testRoot, 'scratch', 'my-codex')
    tree(testRoot, { 'scratch/my-codex/auth.json': 0 })
    for (const p of [...homes, join(homes[0], 'sessions'), home, join(home, 'x')]) expect(() => clearDir(p, { board: { cards: [] }, temp: tmp2, testRoot, homes: [...homes, home] }), p).toThrow(/CLI test home/)
    expect(existsSync(join(home, 'auth.json')) && existsSync(join(homes[0], 'auth.json'))).toBe(true)
  })

  it('never through a link or a link itself, nor a file', () => {
    const { tmp, pad, clear } = roots()
    const outside = temp('cw-cleardir-outside-')
    tree(outside, { 'precious.txt': 0 })
    symlinkSync(outside, join(pad, 'linked'), 'junction')
    expect(() => clear(join(pad, 'linked'))).toThrow(/is a link/)
    expect(() => clear(join(pad, 'linked', 'sub'))).toThrow(/reached through a link/)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    writeFileSync(join(tmp, 'cw-file'), 'x')
    expect(() => clear(join(tmp, 'cw-file'))).toThrow(/is a file/)
  })

  it('never when an allowed root, or a folder above it, is a link: the delete would land outside (round 2)', () => {
    const top = temp('cw-cleardir-rootlink-')
    const outside = join(top, 'outside')
    tree(top, { 'outside/scratch/probe/sentinel.txt': 0, 'outside/scratch/probe/auth.json': 0, 'outside/Temp/cw-x/sentinel.txt': 0, 'realtmp/cw-y/keep.txt': 0 })
    // combwork-test itself is a junction to the outside folder; and the configured home is that outside place.
    const testRoot = join(top, 'combwork-test')
    symlinkSync(outside, testRoot, 'junction')
    const home = join(outside, 'scratch', 'probe')
    expect(() => clearDir(join(testRoot, 'scratch', 'probe'), { board: { cards: [] }, temp: join(top, 'realtmp'), testRoot, homes: [home] })).toThrow(/reached through a link/)
    expect(() => clearDir(join(testRoot, 'scratch', 'probe'), { board: { cards: [] }, temp: join(top, 'realtmp'), testRoot, homes: [] })).toThrow(/reached through a link/)
    // A folder above the temp root is a junction.
    const above = join(top, 'linkedparent')
    symlinkSync(outside, above, 'junction')
    expect(() => clearDir(join(above, 'Temp', 'cw-x'), { board: { cards: [] }, temp: join(above, 'Temp'), testRoot: join(top, 'nowhere'), homes: [] })).toThrow(/reached through a link/)
    // Everything is where it was.
    for (const f of ['scratch/probe/sentinel.txt', 'scratch/probe/auth.json', 'Temp/cw-x/sentinel.txt']) expect(existsSync(join(outside, f)), f).toBe(true)
  })

  it('a test home is recognised as it really is: one reached through a link elsewhere still protects its folder', () => {
    const top = temp('cw-cleardir-homelink-')
    tree(top, { 'combwork-test/scratch/probe/auth.json': 0, 'Temp/x.txt': 0 })
    const real = join(top, 'combwork-test', 'scratch', 'probe')
    const alias = join(top, 'codex-home-link')
    symlinkSync(real, alias, 'junction')
    expect(() => clearDir(real, { board: { cards: [] }, temp: join(top, 'Temp'), testRoot: join(top, 'combwork-test'), homes: [alias] })).toThrow(/CLI test home/)
    expect(existsSync(join(real, 'auth.json'))).toBe(true)
  })

  it('keeps evidence: a folder a card cites (or something in it), and everything when the board can’t be read', () => {
    const { tmp, pad, clear } = roots()
    expect(() => clear(join(pad, 'kept'))).toThrow(/must stay: cited by #401/)
    expect(readdirSync(join(pad, 'kept'))).toEqual(['b.png'])
    expect(() => clear(join(tmp, 'cw-r2-291-x'), { tasksDir: null })).toThrow(/must stay: no board was found/)
    // Paths in the temp folder are matched as `Temp\\…`: a card naming combwork-test's own claude home doesn't keep a
    // scratchpad under `Temp\\claude` (it did, read as `combwork-test\\claude`); nor does one naming the scratchpads' folders
    // as a pattern (areas, like combwork-test's lanes).
    const others = {
      cards: [
        card(186, 'the Claude test home is C:\\Users\\X\\AppData\\Local\\combwork-test\\claude, beside combwork-test\\codex'),
        card(304, 'only inside a Claude Code scratchpad (`Temp\\claude\\…\\scratchpad\\<x>`)'),
        card(305, `the session's folder ${join(pad, '..')}\\…`)
      ]
    }
    expect(clear(join(pad, 'shots'), others)).toBe(join(pad, 'shots'))
    // …while the temp path itself, as a card writes it, does.
    const cited = { cards: [card(402, 'see C:\\Users\\X\\AppData\\Local\\Temp\\cw-r2-291-x\\c.png')] }
    expect(() => clear(join(tmp, 'cw-r2-291-x'), cited)).toThrow(/cited by #402/)
    expect(readdirSync(join(tmp, 'cw-r2-291-x'))).toEqual(['c.png'])
  })

  it('probeDir gives a new folder every call, in combwork-test\\scratch, named for the probe', () => {
    const root = temp('cw-probedir-')
    const a = probeDir('R2 #291 probe!', root)
    const b = probeDir('R2 #291 probe!', root)
    expect(a).not.toBe(b)
    for (const d of [a, b]) {
      expect(lstatSync(d).isDirectory()).toBe(true)
      expect(resolve(d, '..')).toBe(join(root, 'scratch'))
      expect(d.split(/[\\/]/).pop()).toMatch(/^r2-291-probe-\d{8}-\d{6}-/)
    }
    expect(probeDir('', root).split(/[\\/]/).pop()).toMatch(/^probe-/)
  })
})

describe("a suite's kept files include its screenshot folders (#284)", () => {
  it('copies the top-level files and the *shots / reports folders at any depth; never profiles, workspaces or through links; survives the suite folder being reused', () => {
    const root = temp('cw-keep-')
    const lane = join(root, 'e2e', 'lanes', '0')
    const suite = join(lane, 'restart')
    const outside = temp('cw-keep-outside-')
    tree(root, {
      'e2e/lanes/0/restart/restart-1.png': 0,
      'e2e/lanes/0/restart/notify.log': 0,
      'e2e/lanes/0/restart/restart-shots/3-restart-failed.png': 0,
      'e2e/lanes/0/restart/restart-shots/round-2/4-again.png': 0,
      'e2e/lanes/0/restart/pshots/5-session.png': 0,
      'e2e/lanes/0/restart/reports/summary.json': 0,
      'e2e/lanes/0/restart/restart-profile/Cache/data': 0,
      'e2e/lanes/0/restart/restart-ws/demo/a.ts': 0,
      'e2e/lanes/0/restart/restart-claude-home/.credentials.json': 0
    })
    tree(outside, { 'precious.png': 0, 'deep/secret.png': 0 })
    // Links: in a screenshot folder, at the top, and a screenshot folder that is itself a link.
    symlinkSync(outside, join(suite, 'restart-shots', 'linked'), 'junction')
    symlinkSync(outside, join(suite, 'linked-top'), 'junction')
    symlinkSync(outside, join(suite, 'cshots'), 'junction')
    const logs = join(root, 'e2e', 'logs')
    const run = newRunDir(logs, new Date(2026, 9, 6, 22, 0, 0))
    const kept = keepSuiteFiles(suite, run, 'restart')
    const got = (readdirSync(join(run, 'restart'), { recursive: true }) as string[]).map((f) => f.split(/[\\/]/).join('/')).sort()
    expect(got).toEqual(['notify.log', 'pshots', 'pshots/5-session.png', 'reports', 'reports/summary.json', 'restart-1.png', 'restart-shots', 'restart-shots/3-restart-failed.png', 'restart-shots/round-2', 'restart-shots/round-2/4-again.png'])
    expect(kept.copied).toBe(6)
    expect(kept.omitted.map((o: { path: string }) => o.path.split(/[\\/]/).join('/')).sort()).toEqual(['cshots', 'linked-top', 'restart-shots/linked'])
    expect(kept.omitted.every((o: { why: string }) => /a link/.test(o.why))).toBe(true)
    expect(omittedLine(kept.omitted)).toMatch(/\(a link \(not followed\)\)/)
    // The links' targets are untouched, and nothing of them was copied.
    expect(existsSync(join(outside, 'precious.png')) && existsSync(join(outside, 'deep', 'secret.png'))).toBe(true)
    // The lane's folder reused by the next run (emptied): the run's copies stay.
    expect(freshFolder(suite, rules(root, []))).toBe(suite)
    expect(readdirSync(suite)).toEqual([])
    expect(readFileSync(join(run, 'restart', 'restart-shots', '3-restart-failed.png'), 'utf8')).toHaveLength(100)
    expect(readFileSync(join(run, 'restart', 'restart-shots', 'round-2', '4-again.png'), 'utf8')).toHaveLength(100)
  })

  it('never a profile, workspace, CLI home or sign-in file, even inside a screenshot folder (round 2)', () => {
    const root = temp('cw-keep-nested-')
    const suite = join(root, 'e2e', 'lanes', '0', 'restart')
    tree(root, {
      'e2e/lanes/0/restart/shots/good.png': 0,
      'e2e/lanes/0/restart/shots/deeper/also-good.png': 0,
      'e2e/lanes/0/restart/shots/restart-profile/Cache/private.txt': 0,
      'e2e/lanes/0/restart/shots/restart-ws/project/source.ts': 0,
      'e2e/lanes/0/restart/shots/ws2/x.ts': 0,
      'e2e/lanes/0/restart/shots/restart-claude-home/.credentials.json': 0,
      'e2e/lanes/0/restart/shots/codex/auth.json': 0,
      'e2e/lanes/0/restart/shots/deeper/auth.json': 0,
      'e2e/lanes/0/restart/.credentials.json': 0,
      'e2e/lanes/0/restart/reports/node_modules/x/index.js': 0
    })
    const run = newRunDir(join(root, 'e2e', 'logs'), new Date(2026, 9, 6, 23, 0, 0))
    const kept = keepSuiteFiles(suite, run, 'restart')
    const got = (readdirSync(join(run, 'restart'), { recursive: true }) as string[]).map((f) => f.split(/[\\/]/).join('/')).sort()
    expect(got).toEqual(['shots', 'shots/deeper', 'shots/deeper/also-good.png', 'shots/good.png'])
    const omitted = Object.fromEntries(kept.omitted.map((o: { path: string; why: string }) => [o.path.split(/[\\/]/).join('/'), o.why]))
    expect(omitted).toEqual({
      'shots/restart-profile': 'a profile, workspace or CLI home',
      'shots/restart-ws': 'a profile, workspace or CLI home',
      'shots/ws2': 'a profile, workspace or CLI home',
      'shots/restart-claude-home': 'a profile, workspace or CLI home',
      'shots/codex': 'a profile, workspace or CLI home',
      'shots/deeper/auth.json': 'a sign-in file',
      '.credentials.json': 'a sign-in file',
      'reports/node_modules': 'a profile, workspace or CLI home'
    })
    // Reused for the next run: only the screenshots were kept.
    freshFolder(suite, rules(root, []))
    expect(readFileSync(join(run, 'restart', 'shots', 'deeper', 'also-good.png'), 'utf8')).toHaveLength(100)
  })

  it("keeps how a fake Claude Code's launches ended from its home, and nothing else of it (#1146)", () => {
    const root = temp('cw-keep-exits-')
    const suite = join(root, 'e2e', 'lanes', '0', 'board')
    tree(root, {
      'e2e/lanes/0/board/board-start.png': 0,
      'e2e/lanes/0/board/board-claude-home/fake-exits.jsonl': 0,
      'e2e/lanes/0/board/board-claude-home/fake-launches.jsonl': 0,
      'e2e/lanes/0/board/board-claude-home/.credentials.json': 0,
      'e2e/lanes/0/board/board-claude-home/projects/x/s.jsonl': 0,
      'e2e/lanes/0/board/board-profile/fake-exits.jsonl': 0,
      'e2e/lanes/0/board/shots/other-claude-home/fake-exits.jsonl': 0
    })
    const run = newRunDir(join(root, 'e2e', 'logs'), new Date(2026, 9, 26, 2, 0, 0))
    const kept = keepSuiteFiles(suite, run, 'board')
    const got = (readdirSync(join(run, 'board'), { recursive: true }) as string[]).map((f) => f.split(/[\\/]/).join('/')).sort()
    // At the top of the suite's folder only; a profile's file of that name and a home inside a screenshot folder aren't.
    expect(got).toEqual(['board-claude-home.fake-exits.jsonl', 'board-start.png'])
    expect(kept.copied).toBe(2)
    expect(readFileSync(join(run, 'board', 'board-claude-home.fake-exits.jsonl'), 'utf8')).toHaveLength(100)
  })

  it('never through a link to the suite folder or a folder above it', () => {
    const root = temp('cw-keep-rootlink-')
    const outside = temp('cw-keep-rootlink-outside-')
    tree(outside, { 'outside-secret.png': 0, 'restart/inside-secret.png': 0 })
    tree(root, { 'logs/.keep': 0 })
    // The suite folder itself a junction; and a junction above it.
    symlinkSync(outside, join(root, 'suite-alias'), 'junction')
    symlinkSync(outside, join(root, 'lane-alias'), 'junction')
    for (const [dir, name] of [[join(root, 'suite-alias'), 'alias'], [join(root, 'lane-alias', 'restart'), 'nested']]) {
      const run = join(root, 'logs', name)
      const kept = keepSuiteFiles(dir, run, 'restart')
      expect(kept.copied, dir).toBe(0)
      expect(kept.omitted, dir).toEqual([{ path: '.', why: expect.stringMatching(/^reached through a link .*: not read$/) }])
      expect(existsSync(join(run, 'restart')), dir).toBe(false)
    }
    expect(existsSync(join(outside, 'outside-secret.png')) && existsSync(join(outside, 'restart', 'inside-secret.png'))).toBe(true)
  })

  it('keeps within its limits, saying what it left out', () => {
    const root = temp('cw-keep-limits-')
    tree(root, { 'suite/a.png': 0, 'suite/b.png': 0, 'suite/shots/c.png': 0, 'suite/shots/d.png': 0 })
    writeFileSync(join(root, 'suite', 'huge.png'), 'x'.repeat(5000))
    const files = keepSuiteFiles(join(root, 'suite'), join(root, 'run1'), 's', { maxBytes: 1000, maxFiles: 3 })
    expect(files.copied).toBe(3)
    expect(files.omitted).toEqual(expect.arrayContaining([{ path: 'huge.png', why: 'over 1 KB' }]))
    expect(files.omitted.filter((o: { why: string }) => o.why === 'past 3 files')).toHaveLength(1)
    const total = keepSuiteFiles(join(root, 'suite'), join(root, 'run2'), 's', { maxTotal: 250 })
    expect(total.copied).toBe(2)
    expect(total.omitted.filter((o: { why: string }) => /past 0 KB in all/.test(o.why))).toHaveLength(3)
    expect(omittedLine([{ path: 'a', why: 'x' }, { path: 'b', why: 'y' }], 1)).toBe('a (x) and 1 more')
  })
})
