// The hive project's focused-test runner (HI-1367): scripts/focusedTests.mjs, which Combwork's merge queue runs as the
// project's focused.run. Its pure parts: which ids it takes, and each test's result from Vitest's JSON report and the
// e2e run record; and, on the command line, a list it can't use or ids it can't run (neither starts Vitest or a suite).
import { spawnSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { exitCode, parseJobs, recordPathFrom, resultRecords, sortIds, suiteResults, unitResults, withExit } from '../scripts/focusedTests.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
import { tempDir } from './tempDir'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')
const suiteNames = (SUITES as { name: string }[]).map((s) => s.name)
type Result = { result: string; why?: string }

describe('the ids the runner takes', () => {
  it('a unit test file in the checkout, or a suite; anything else is failed with why, and the rest still run', () => {
    const r = sortIds(['tests/tips.test.ts', 'board', 'tests/i18n/numbers.test.ts', 'tests/nope.test.ts', '../x.test.ts', 'tests/../package.json', 'tests/e2e/lib.cjs', 'tests/sub/../tips.test.ts', 'boards'], { cwd: root, suiteNames })
    expect(r.problem).toBeNull()
    expect(r.unit).toEqual(['tests/tips.test.ts', 'tests/i18n/numbers.test.ts'])
    expect(r.suites).toEqual(['board'])
    expect([...r.invalid.keys()]).toEqual(['tests/nope.test.ts', '../x.test.ts', 'tests/../package.json', 'tests/e2e/lib.cjs', 'tests/sub/../tips.test.ts', 'boards'])
    expect(r.invalid.get('tests/nope.test.ts')).toMatch(/no such test file/)
  })

  it('a list that is not an array of distinct non-empty strings runs nothing', () => {
    expect(sortIds({ test: 'board' }, { cwd: root, suiteNames }).problem).toMatch(/not a JSON array/)
    expect(sortIds(['board', 3], { cwd: root, suiteNames }).problem).toMatch(/not non-empty strings/)
    expect(sortIds(['board', ''], { cwd: root, suiteNames }).problem).toMatch(/not non-empty strings/)
    expect(sortIds(['board', 'tests/tips.test.ts', 'board'], { cwd: root, suiteNames }).problem).toMatch(/names board more than once/)
    expect(sortIds([], { cwd: root, suiteNames })).toMatchObject({ unit: [], suites: [], problem: null })
  })

  it('CW_FOCUSED_JOBS: a whole number of 1 or more, 2 when unset', () => {
    expect(parseJobs(undefined)).toBe(2)
    expect(parseJobs('')).toBe(2)
    expect(parseJobs('3')).toBe(3)
    expect(parseJobs(' 1 ')).toBe(1)
    for (const bad of ['0', '-1', '1.5', 'two', '2x']) expect(parseJobs(bad), bad).toBeNull()
  })
})

describe("each test's result", () => {
  const at = (f: string) => `${root.replace(/\\/g, '/')}/${f}`
  const file = (name: string, status: string, tests: [string, string][]) => ({ name: at(name), status, message: status === 'failed' && !tests.length ? 'Error: Cannot find module x\n  at y' : '', assertionResults: tests.map(([title, s]) => ({ title, fullName: `d ${title}`, status: s })) })

  it("a unit test file's from Vitest's report: passed, failed (with which), all skipped, or missing", () => {
    const report = {
      success: false,
      testResults: [
        file('tests/a.test.ts', 'passed', [['one', 'passed'], ['two', 'skipped']]),
        file('tests/b.test.ts', 'failed', [['one', 'passed'], ['two', 'failed'], ['three', 'failed']]),
        file('tests/c.test.ts', 'skipped', [['one', 'skipped']]),
        file('tests/d.test.ts', 'failed', [])
      ]
    }
    const r = unitResults(report, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts', 'tests/e.test.ts'], root) as Map<string, Result>
    expect(Object.fromEntries(r)).toEqual({
      'tests/a.test.ts': { result: 'passed' },
      'tests/b.test.ts': { result: 'failed', why: 'failed: d two; d three' },
      'tests/c.test.ts': { result: 'skipped', why: 'every test in it was skipped' },
      'tests/d.test.ts': { result: 'failed', why: 'Error: Cannot find module x' },
      'tests/e.test.ts': { result: 'failed', why: 'not in Vitest’s report: it did not run' }
    })
  })

  it('no report fails every file; a failure outside the files fails those that passed', () => {
    expect([...(unitResults(null, ['tests/a.test.ts'], root) as Map<string, Result>).values()]).toEqual([{ result: 'failed', why: 'Vitest wrote no report (see its output)' }])
    const r = unitResults({ success: false, testResults: [file('tests/a.test.ts', 'passed', [['one', 'passed']])] }, ['tests/a.test.ts'], root) as Map<string, Result>
    expect(r.get('tests/a.test.ts')).toMatchObject({ result: 'failed', why: expect.stringMatching(/outside the tests/) })
  })

  it("a suite's from the run record: passed, failed, skipped for the environment, not run, or missing", () => {
    const out = 'board            pass 12s\n(Saved as C:\\combwork-test\\e2e\\logs\\run-20261028-101500\\run-record.md)\n'
    expect(recordPathFrom(out)).toBe(join('C:\\combwork-test\\e2e\\logs\\run-20261028-101500', 'run-record.json'))
    expect(recordPathFrom('No suite to run.')).toBeNull()
    const record = {
      valid: true,
      problems: [],
      results: [
        { name: 'board', ok: true, skipped: null, environment: false },
        { name: 'files', ok: false, skipped: null, environment: false, windows: ['exit 0xC0000142'] },
        { name: 'claude-real', ok: false, skipped: 'environment: usage limit reached', environment: true },
        { name: 'packaged', ok: false, skipped: null, environment: false, notRun: 'it needs CW_TEST_SLOW_IPC' },
        { name: 'queuecard', ok: true, skipped: null, environment: false, partsNotRun: ['S7 crash'] }
      ]
    }
    const r = suiteResults(record, ['board', 'files', 'claude-real', 'packaged', 'queuecard', 'about']) as Map<string, Result>
    expect(Object.fromEntries(r)).toEqual({
      board: { result: 'passed' },
      files: { result: 'failed', why: 'failed (exit 0xC0000142)' },
      'claude-real': { result: 'skipped', why: 'environment: usage limit reached' },
      packaged: { result: 'skipped', why: 'not run: it needs CW_TEST_SLOW_IPC' },
      queuecard: { result: 'passed', why: 'parts not run: S7 crash' },
      about: { result: 'failed', why: 'not in the run record: it did not run' }
    })
  })

  it("a record that isn't valid vouches for no pass; no record fails every suite", () => {
    const r = suiteResults({ valid: false, problems: ['the code changed while the suites ran'], results: [{ name: 'board', ok: true }, { name: 'files', skipped: 'environment: network' }] }, ['board', 'files']) as Map<string, Result>
    expect(r.get('board')).toEqual({ result: 'failed', why: 'the run record is not valid: the code changed while the suites ran' })
    expect(r.get('files')).toEqual({ result: 'skipped', why: 'environment: network' })
    expect([...(suiteResults(null, ['board'], 'no run record: exited with 2') as Map<string, Result>).values()]).toEqual([{ result: 'failed', why: 'no run record: exited with 2' }])
  })

  it("a process that didn't exit 0 fails what it ran when its report shows no failure (HR4's round 1 finding 6)", () => {
    const passed = new Map([['a', { result: 'passed' }], ['b', { result: 'skipped', why: 'usage limit' }]])
    expect([...withExit(passed, 7, 'Vitest').values()]).toEqual([{ result: 'failed', why: 'Vitest exited with 7, though its report has no failure' }, { result: 'failed', why: 'Vitest exited with 7, though its report has no failure' }])
    expect(withExit(passed, 0, 'Vitest')).toBe(passed)
    const failing = new Map([['a', { result: 'failed', why: 'x' }], ['b', { result: 'passed' }]])
    expect(withExit(failing, 1, 'Vitest')).toBe(failing)
  })

  it('writes exactly one record per id, in order, a missing one failed; exits 0 only when none failed', () => {
    const records = resultRecords(['b', 'a', 'c'], new Map([['a', { result: 'passed' }], ['b', { result: 'skipped', why: 'environment: sign-in' }]]))
    expect(records).toEqual([
      { test: 'b', result: 'skipped', why: 'environment: sign-in' },
      { test: 'a', result: 'passed' },
      { test: 'c', result: 'failed', why: 'no result was recorded for it' }
    ])
    expect(exitCode(records)).toBe(1)
    expect(exitCode(records.slice(0, 2))).toBe(0)
    expect(exitCode([])).toBe(0)
  })
})

describe('the runner on the command line (focused.run)', () => {
  const run = (ids: unknown, jobs?: string) => {
    const dir = tempDir('cw-focused-run-')
    const tests = join(dir, 'tests.json')
    const results = join(dir, 'out', 'results.json')
    writeFileSync(tests, typeof ids === 'string' ? ids : JSON.stringify(ids))
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'focusedTests.mjs')], { cwd: root, encoding: 'utf8', env: { ...runContext.baseEnv(), CW_FOCUSED_TESTS: tests, CW_FOCUSED_RESULTS: results, ...(jobs ? { CW_FOCUSED_JOBS: jobs } : {}) } })
    return { status: r.status, stderr: r.stderr, records: JSON.parse(readFileSync(results, 'utf8')) as { test: string; result: string; why?: string }[] }
  }

  it('ids it cannot run are failed with why, one record each, and it exits 1 (starting neither Vitest nor a suite)', () => {
    const r = run(['tests/nope.test.ts', 'no-such-suite'])
    expect(r.status, r.stderr).toBe(1)
    expect(r.records).toEqual([
      { test: 'tests/nope.test.ts', result: 'failed', why: 'no such test file in the checkout' },
      { test: 'no-such-suite', result: 'failed', why: expect.stringMatching(/neither a unit test file/) }
    ])
  })

  it('a list it cannot use, or a bad CW_FOCUSED_JOBS, runs nothing and exits 2', () => {
    const twice = run(['board', 'board'])
    expect(twice.status).toBe(2)
    expect(twice.records).toEqual([{ test: 'board', result: 'failed', why: expect.stringMatching(/^nothing run: the test list names board more than once/) }])
    const jobs = run(['board'], '0')
    expect(jobs.status).toBe(2)
    expect(jobs.records).toEqual([{ test: 'board', result: 'failed', why: expect.stringMatching(/CW_FOCUSED_JOBS/) }])
    const broken = run('{')
    expect(broken.status).toBe(2)
    expect(broken.records).toEqual([])
  })

  it('an empty list runs nothing and passes', () => {
    const r = run([])
    expect(r.status, r.stderr).toBe(0)
    expect(r.records).toEqual([])
  })
})
