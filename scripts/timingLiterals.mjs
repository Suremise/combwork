// HI-3378: no literal waits in the tests. Every test wait and timeout reads a name from the tests' one timing file
// (tests/timing.json, timing(name)), so a run tightens or loosens them in one place. This finds a number written in place
// where a wait's bound or a timeout belongs, in tests/** (fakes, fixtures, node_modules and the timing files apart):
//   - a test's or hook's timeout (a number as its last argument), vi.setConfig's testTimeout/hookTimeout/teardownTimeout;
//   - a `timeout:` value (vi.waitFor, expect.poll, .toPass, Playwright, a child process's option);
//   - the bound of until(fn, N);
//   - the argument of sleep(N) or waitForTimeout(N), or a Promise around setTimeout(resolve, N);
//   - the limit of a `Date.now() - t < N` loop;
//   - the value of a `*_MS` constant;
//   - toBeLessThan(N) on a clock reading (a line naming Date.now, performance.now, elapsed or ms).
// Simulated time (vi.advanceTimersByTime, setSystemTime and their kin) is never one. A line (or the line above) that says
// `timing-ok: <why>` is a number that is no wait (a value under test, a child's own life). tests/timingAllow.json lists the
// files not migrated yet (HI-3381, HI-3382): they are the backlog, never checked, and the list only shrinks: a file on it
// with none left fails too, so it comes off.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TESTS = join(ROOT, 'tests')
export const ALLOW_FILE = join(TESTS, 'timingAllow.json')
/** A fake is a CLI, a fixture is data; the timing files are where the numbers belong. */
const SKIP = /[\\/](node_modules|fixtures|fake-[^\\/]*)[\\/]|[\\/]tests[\\/]timing(\.ci)?\.(json|cjs|d\.cts)$/
const FILE = /\.(ts|mts|cts|cjs|mjs|js)$/
const NUM = String.raw`\d[\d_]*(?:\.\d+)?(?:e\d+)?`

/** Each kind: a test on the line (strings emptied), and what the message calls it. */
export const KINDS = [
  { id: 'testTimeout', re: new RegExp(String.raw`\b(?:it|test|describe|beforeAll|afterAll|beforeEach|afterEach)(?:\.\w+)*\(.*,\s*${NUM}\s*\)\s*;?\s*$`), what: "a test's or hook's timeout" },
  { id: 'setConfig', re: new RegExp(String.raw`\b(?:testTimeout|hookTimeout|teardownTimeout)\s*:\s*${NUM}`), what: 'a test limit' },
  { id: 'timeout', re: new RegExp(String.raw`\btimeout(?:Ms)?\s*:\s*${NUM}`), what: 'a timeout: value' },
  { id: 'until', re: new RegExp(String.raw`\buntil\(.*,\s*${NUM}\s*[,)]`), what: "until's bound" },
  { id: 'sleep', re: new RegExp(String.raw`\b(?:sleep|waitForTimeout)\(\s*${NUM}\s*\)`), what: 'a sleep' },
  { id: 'promiseSleep', re: new RegExp(String.raw`new Promise\(.*setTimeout\(\s*\w+\s*,\s*${NUM}\s*\)`), what: 'a sleep' },
  { id: 'clockLoop', re: new RegExp(String.raw`(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*<=?\s*${NUM}`), what: "a loop's time limit" },
  { id: 'msConstant', re: new RegExp(String.raw`\b(?:const|let|var)\s+[A-Z][A-Z0-9_]*_MS\s*=\s*${NUM}\b`), what: 'a *_MS constant' },
  { id: 'clockAssert', re: new RegExp(String.raw`toBeLessThan(?:OrEqual)?\(\s*${NUM}\s*\)`), what: 'a bound on a clock reading', also: /Date\.now|performance\.now|elapsed|\bms\b|took/i }
]
/** Simulated time: never a real wait. */
const SIMULATED = /advanceTimersByTime|advanceTimersToNextTimer|runAllTimers|runOnlyPendingTimers|setSystemTime|useFakeTimers/
const OPT_OUT = /timing-ok:/

/** The line with its string literals and its trailing comment emptied, so a test's text or a note isn't one. */
const code = (line) => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '$1$1').replace(/\/\/.*$/, '')

/** A file's literal waits: { line, kind, text }, in order. */
export function literalsIn(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (OPT_OUT.test(raw) || (i > 0 && OPT_OUT.test(lines[i - 1]))) continue
    const c = code(raw)
    if (SIMULATED.test(c)) continue
    for (const k of KINDS) {
      if (!k.re.test(c) || (k.also && !k.also.test(raw))) continue
      out.push({ line: i + 1, kind: k.id, what: k.what, text: raw.trim().slice(0, 160) })
      break
    }
  }
  return out
}

/** Every test file the guard reads, repo-relative with forward slashes. */
export function testFiles(dir = TESTS) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (SKIP.test(p + (statSync(p).isDirectory() ? '/' : ''))) continue
      if (statSync(p).isDirectory()) walk(p)
      else if (FILE.test(name)) out.push(relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(dir)
  return out.sort()
}

/** The allow list (the backlog's files), or none. */
export function readAllow(file = ALLOW_FILE) {
  if (!existsSync(file)) return []
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return Array.isArray(raw.files) ? raw.files : []
}

/**
 * The guard's verdict on the tree: `found`, literals in files not on the allow list (each a failure); `cleared`, files on
 * the list with none left (each a failure: take it off); `backlog`, the listed files' counts.
 */
export function checkTree(files = testFiles(), allow = readAllow(), read = (f) => readFileSync(join(ROOT, f), 'utf8')) {
  const listed = new Set(allow)
  const found = []
  const cleared = []
  const backlog = []
  for (const f of files) {
    const lits = literalsIn(read(f))
    if (listed.has(f)) {
      if (lits.length) backlog.push({ file: f, count: lits.length })
      else cleared.push(f)
    } else for (const l of lits) found.push({ file: f, ...l })
  }
  for (const f of allow) if (!files.includes(f)) cleared.push(f)
  return { found, cleared, backlog }
}
