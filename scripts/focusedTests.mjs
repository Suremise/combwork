// This repository's focused-test runner (HI-1367): Combwork's merge queue runs it as the project's focused.run, in the
// checkout to test (cwd), after its focused.pick (tests/e2e/affected.mjs --pick) chose the tests.
//   CW_FOCUSED_TESTS    a JSON file: the test ids, an array of strings. A unit test is its repo path
//                         (tests/x.test.ts), an e2e suite its name (board).
//   CW_FOCUSED_RESULTS  where it writes the results: one { test, result: passed|failed|skipped, why? } per id given.
//   CW_FOCUSED_JOBS     at most this many workers at once (a whole number of 1 or more; 2 when unset).
// The unit tests run in one Vitest run of those files (its JSON report gives each file's result); the suites in one
// e2e run, `tests/e2e/run.mjs <suites> --build --record` (its run record gives each suite's: one skipped for the
// environment, such as a real CLI's usage limit, is skipped, with why). Never the full set or the real tier as such:
// only the ids given. An id that isn't a unit test file or a suite, or whose result can't be read, is failed, with why.
// It exits 0 when no test failed (a skip is reported, with why, but isn't a failure), 1 when one did, 2 when the list
// itself can't be used (nothing run).
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, relative, resolve, isAbsolute } from 'path'
import { pathToFileURL } from 'url'

const runContext = createRequire(import.meta.url)('../tests/e2e/runContext.cjs')

/** A unit test's id: a test file under tests/, outside tests/e2e (tests/x.test.ts, tests/i18n/y.test.ts). */
const UNIT_ID = /^tests\/(?:[^/]+\/)*[^/]+\.test\.ts$/

/** CW_FOCUSED_JOBS: a whole number of 1 or more (2 when unset), or null when it is something else. */
export function parseJobs(value) {
  if (value === undefined || value === '') return 2
  return /^[1-9]\d*$/.test(String(value).trim()) ? Number(String(value).trim()) : null
}

/**
 * The ids sorted into unit tests and suites: { unit, suites, invalid: Map id → why, problem } (problem: the list as a
 * whole can't be used: not an array of strings, or an id twice). A unit id must be an existing test file under tests/
 * inside cwd; a suite id one of suiteNames.
 */
export function sortIds(ids, { cwd, suiteNames, isFile = (p) => existsSync(p) && statSync(p).isFile() }) {
  if (!Array.isArray(ids)) return { unit: [], suites: [], invalid: new Map(), problem: 'the test list is not a JSON array' }
  const bad = ids.filter((id) => typeof id !== 'string' || !id)
  if (bad.length) return { unit: [], suites: [], invalid: new Map(), problem: `the test list has ${bad.length} id(s) that are not non-empty strings` }
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (twice.length) return { unit: [], suites: [], invalid: new Map(), problem: `the test list names ${[...new Set(twice)].join(', ')} more than once` }
  const unit = []
  const suites = []
  const invalid = new Map()
  for (const id of ids) {
    if (suiteNames.includes(id)) suites.push(id)
    else if (UNIT_ID.test(id) && !id.startsWith('tests/e2e/') && !id.split('/').includes('..')) {
      const full = resolve(cwd, id)
      const rel = relative(resolve(cwd), full)
      if (rel.startsWith('..') || isAbsolute(rel)) invalid.set(id, 'not inside the checkout')
      else if (!isFile(full)) invalid.set(id, 'no such test file in the checkout')
      else unit.push(id)
    } else invalid.set(id, 'neither a unit test file (tests/….test.ts) nor an e2e suite (tests/e2e/suites.mjs)')
  }
  return { unit, suites, invalid, problem: null }
}

const slashes = (p) => p.replace(/\\/g, '/')

/**
 * Each unit test file's result from Vitest's JSON report (null: there is none): a Map id → { result, why? }. A file the
 * report doesn't name is failed; one whose every test was skipped is skipped; a run Vitest says failed outside any file
 * (an unhandled error) fails the files that passed, as it can't say which caused it.
 */
export function unitResults(report, ids, cwd) {
  const out = new Map()
  if (!report || !Array.isArray(report.testResults)) {
    for (const id of ids) out.set(id, { result: 'failed', why: 'Vitest wrote no report (see its output)' })
    return out
  }
  const base = slashes(resolve(cwd)).toLowerCase() + '/'
  const idOf = (name) => {
    const f = slashes(name ?? '').toLowerCase()
    return f.startsWith(base) ? f.slice(base.length) : f
  }
  const byId = new Map(report.testResults.map((t) => [idOf(t.name), t]))
  for (const id of ids) {
    const t = byId.get(id.toLowerCase())
    if (!t) out.set(id, { result: 'failed', why: 'not in Vitest’s report: it did not run' })
    else if (t.status === 'failed') {
      const failed = (t.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => a.fullName ?? a.title)
      out.set(id, { result: 'failed', why: failed.length ? `failed: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}` : (t.message || 'failed').split('\n')[0] })
    } else if (t.status === 'passed' && (t.assertionResults ?? []).some((a) => a.status === 'passed')) out.set(id, { result: 'passed' })
    else out.set(id, { result: 'skipped', why: 'every test in it was skipped' })
  }
  if (report.success === false && ![...out.values()].some((r) => r.result === 'failed')) {
    for (const [id, r] of out) if (r.result === 'passed') out.set(id, { result: 'failed', why: 'Vitest reported a failure outside the tests (an unhandled error: see its output)' })
  }
  return out
}

/** Where run.mjs saved its run record (the JSON beside the Markdown it names), from its output; null when it saved none. */
export function recordPathFrom(output) {
  const m = [...output.matchAll(/\(Saved as (.+run-record\.md)\)/g)].at(-1)
  return m ? join(dirname(m[1].trim()), 'run-record.json') : null
}

/**
 * Each suite's result from an e2e run record (record.mjs recordJson; null: there is none): a Map id → { result, why? }.
 * Skipped by itself (a real CLI's usage limit, sign-in or network: `environment: …`; a CLI not installed) or not run on
 * a packaged build: skipped, with why. A record that isn't valid (the code changed while it ran, a stale build) can't
 * vouch for a pass: those are failed, with its problems.
 */
export function suiteResults(record, ids, why = 'no run record') {
  const out = new Map()
  if (!record || !Array.isArray(record.results)) {
    for (const id of ids) out.set(id, { result: 'failed', why })
    return out
  }
  const invalid = record.valid === false ? `the run record is not valid: ${(record.problems ?? []).join('; ') || 'no reason given'}` : null
  for (const id of ids) {
    const r = record.results.find((x) => x.name === id)
    if (!r) out.set(id, { result: 'failed', why: 'not in the run record: it did not run' })
    else if (r.notRun) out.set(id, { result: 'skipped', why: `not run: ${r.notRun}` })
    else if (r.skipped) out.set(id, { result: 'skipped', why: r.skipped })
    else if (r.ok && invalid) out.set(id, { result: 'failed', why: invalid })
    else if (r.ok) out.set(id, r.partsNotRun?.length ? { result: 'passed', why: `parts not run: ${r.partsNotRun.join('; ')}` } : { result: 'passed' })
    else out.set(id, { result: 'failed', why: r.windows?.length ? `failed (${r.windows.join('; ')})` : 'failed (see its log)' })
  }
  return out
}

/** The results file's records: exactly one per id, in the ids' order; an id with none is failed. */
export function resultRecords(ids, results) {
  return ids.map((test) => {
    const r = results.get(test) ?? { result: 'failed', why: 'no result was recorded for it' }
    return { test, result: r.result, ...(r.why ? { why: r.why } : {}) }
  })
}

/**
 * A run's results against how its process ended (HR4's HI-1367 round 1 finding 6): a process that didn't exit 0 with no
 * failure in its report to explain it failed every test it ran, whatever the report says. Exported for its unit test.
 */
export function withExit(results, code, what) {
  if (code === 0 || [...results.values()].some((r) => r.result === 'failed')) return results
  const why = `${what} exited with ${code}, though its report has no failure`
  return new Map([...results].map(([id]) => [id, { result: 'failed', why }]))
}

/** Runs a child to its end, its output shown (and stdout kept when asked): { code, out }. */
function run(command, args, { cwd, env, keep = false }) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', keep ? 'pipe' : 'inherit', 'inherit'], windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
      process.stdout.write(d)
    })
    child.on('error', (e) => done({ code: null, out: `${out}\n${e.message}` }))
    child.on('close', (code) => done({ code, out }))
  })
}

/** The unit tests: one Vitest run of their files, results from its JSON report. */
async function runUnit(cwd, ids, jobs) {
  const vitest = join(cwd, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitest)) return unitResults(null, ids, cwd)
  mkdirSync(join(runContext.TEST_ROOT, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(runContext.TEST_ROOT, 'tmp', 'focused-run-'))
  try {
    const report = join(dir, 'vitest.json')
    // Node runs Vitest's own script (no npx, no shell); the environment is the run context's allowlist, as a test's child.
    const r = await run(process.execPath, [vitest, 'run', `--maxWorkers=${jobs}`, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...ids], { cwd, env: runContext.baseEnv() })
    let parsed = null
    try {
      parsed = JSON.parse(readFileSync(report, 'utf8'))
    } catch {
      parsed = null
    }
    return withExit(unitResults(parsed, ids, cwd), r.code, 'Vitest')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The e2e suites: one run of them, built and recorded, results from its run record. */
async function runSuites(cwd, ids, jobs) {
  // Started as `npm run e2e` would be: the runner takes what it needs from its environment itself (the run context's
  // allowlist for each suite, the shell's Combwork variables for its Progress steps), less the queue's own variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CW_FOCUSED_/i.test(k)))
  const r = await run(process.execPath, [join(cwd, 'tests', 'e2e', 'run.mjs'), ...ids, '--build', '--record', '--jobs', String(jobs)], { cwd, env, keep: true })
  const path = recordPathFrom(r.out)
  let record = null
  try {
    record = path ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    record = null
  }
  return withExit(suiteResults(record, ids, `no run record: tests/e2e/run.mjs exited with ${r.code} (see its output)`), r.code, 'tests/e2e/run.mjs')
}

async function main() {
  const cwd = process.cwd()
  const testsFile = process.env.CW_FOCUSED_TESTS
  const resultsFile = process.env.CW_FOCUSED_RESULTS
  if (!testsFile || !resultsFile) {
    console.error('CW_FOCUSED_TESTS and CW_FOCUSED_RESULTS must both be set')
    return 2
  }
  const write = (records) => {
    mkdirSync(dirname(resultsFile), { recursive: true })
    writeFileSync(resultsFile, `${JSON.stringify(records, null, 2)}\n`)
  }
  let ids
  try {
    ids = JSON.parse(readFileSync(testsFile, 'utf8'))
  } catch (e) {
    console.error(`Can't read the test list ${testsFile}: ${e.message}`)
    write([])
    return 2
  }
  const { SUITES } = await import(pathToFileURL(join(cwd, 'tests', 'e2e', 'suites.mjs')).href)
  const sorted = sortIds(ids, { cwd, suiteNames: SUITES.map((s) => s.name) })
  const jobs = parseJobs(process.env.CW_FOCUSED_JOBS)
  const refuse = sorted.problem ?? (jobs === null ? `CW_FOCUSED_JOBS is ${JSON.stringify(process.env.CW_FOCUSED_JOBS)}, not a whole number of 1 or more` : null)
  if (refuse) {
    console.error(`Nothing run: ${refuse}.`)
    const named = Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && id))] : []
    write(named.map((test) => ({ test, result: 'failed', why: `nothing run: ${refuse}` })))
    return 2
  }
  const results = new Map([...sorted.invalid].map(([id, why]) => [id, { result: 'failed', why }]))
  for (const [id, why] of sorted.invalid) console.error(`${id}: ${why}`)
  if (sorted.unit.length) for (const [id, r] of await runUnit(cwd, sorted.unit, jobs)) results.set(id, r)
  if (sorted.suites.length) for (const [id, r] of await runSuites(cwd, sorted.suites, jobs)) results.set(id, r)
  const records = resultRecords(ids, results)
  write(records)
  const count = (k) => records.filter((r) => r.result === k).length
  console.log(`Focused tests: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped.`)
  return exitCode(records)
}

/** 0 when no test failed (a skip, reported with why, isn't the runner's failure: a real suite skipped for the
 * environment doesn't block a merge), 1 otherwise. */
export const exitCode = (records) => (records.some((r) => r.result !== 'passed' && r.result !== 'skipped') ? 1 : 0)

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`The focused tests failed to run: ${e.stack ?? e.message}`)
      process.exit(2)
    }
  )
}
