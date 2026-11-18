// HI-3378: no literal waits in the tests. Every test wait and timeout reads a name from the tests' one timing file
// (tests/timing.json, timing(name)), so a run tightens or loosens them in one place. This finds a number written in place
// where a wait's bound or a timeout belongs, in tests/** (fakes, fixtures, node_modules and the timing files apart):
//   - a test's or hook's timeout (a number as its last argument), vi.setConfig's testTimeout/hookTimeout/teardownTimeout;
//   - a `timeout:` value (vi.waitFor, expect.poll, .toPass, Playwright, a child process's option);
//   - the bound of until(fn, N);
//   - the argument of sleep(N) or waitForTimeout(N), or setTimeout(resolve, N) (a Promise's sleep);
//   - the limit of a `Date.now() - t < N` loop;
//   - the value of a `*_MS` constant;
//   - toBeLessThan(N) on a clock reading (its statement naming Date.now, performance.now, elapsed, took or ms).
// Each file is read whole, its comments and strings blanked (newlines kept), calls matched by their parentheses, so a call
// written over several lines counts as one. Simulated time (vi.advanceTimersByTime and its kin) matches no kind. A number
// that is no wait (a value under test, a child's own life) says `timing-ok: <why>` on its line or the line above.
//
// The backlog (HI-3381, HI-3382 migrate it): tests/timingAllow.json, each file's existing literals by occurrence (its kind
// and its line's text, whitespace folded), as many of each as there are. A literal not covered by that baseline fails,
// in a listed file too: one added, or one changed (its line's text no longer the baseline's). A baseline entry with no
// literal left fails as well, until `--literals --shrink` writes the baseline without it: that update only ever removes
// entries, so the baseline can't grow by the tool, and one grown by hand shows in review as an addition to that file.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const TESTS = join(ROOT, 'tests')
export const ALLOW_FILE = join(TESTS, 'timingAllow.json')
/** A fake is a CLI, a fixture is data; the timing files are where the numbers belong. */
const SKIP = /[\\/](node_modules|fixtures|fake-[^\\/]*)[\\/]|[\\/]tests[\\/]timing(\.ci)?\.(json|cjs|d\.cts)$/
const FILE = /\.(ts|mts|cts|cjs|mjs|js)$/
const NUM = String.raw`\d[\d_]*(?:\.\d+)?(?:e\d+)?`
const IS_NUM = new RegExp(`^${NUM}$`)
const OPT_OUT = /timing-ok:/

export const WHAT = {
  testTimeout: "a test's or hook's timeout",
  setConfig: 'a test limit',
  timeout: 'a timeout: value',
  until: "until's bound",
  sleep: 'a sleep',
  promiseSleep: 'a sleep',
  clockLoop: "a loop's time limit",
  msConstant: 'a *_MS constant',
  clockAssert: 'a bound on a clock reading'
}

/**
 * The file's code with its comments and its string and template literals blanked to spaces (newlines kept, positions
 * unchanged), so a test's text or a note never matches, and a template's `${…}` code still does.
 */
export function blank(src) {
  const out = src.split('')
  const n = src.length
  const fill = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  const tpl = [] // a template's ${ depth, when inside its code
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i)
      const end = e < 0 ? n : e
      fill(i, end)
      i = end
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e < 0 ? n : e + 2
      fill(i, end)
      i = end
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      fill(i + 1, j)
      i = j + 1
    } else if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === 0)) {
      // A template's text, from its start (or the end of a ${…}) to its end or its next ${.
      if (c === '}') tpl.pop()
      let j = i + 1
      while (j < n && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1
      fill(i + 1, j)
      if (src[j] === '$') {
        tpl.push(0)
        i = j + 2
      } else i = j + 1
    } else {
      if (tpl.length && c === '{') tpl[tpl.length - 1]++
      else if (tpl.length && c === '}') tpl[tpl.length - 1]--
      i++
    }
  }
  return out.join('')
}

/** A call's arguments from the position just after its `(`: each top-level argument's text and start, and where it ends. */
function callArgs(code, open) {
  const args = []
  let depth = 0
  let start = open
  for (let k = open; k < code.length; k++) {
    const c = code[k]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        args.push({ text: code.slice(start, k), at: start })
        return { args, end: k }
      }
      depth--
    } else if (c === ',' && depth === 0) {
      args.push({ text: code.slice(start, k), at: start })
      start = k + 1
    }
  }
  return null
}

/** The position of a numeric argument's number (its text trimmed is a number), else -1. */
const numberAt = (arg) => {
  if (!arg) return -1
  const t = arg.text.trim()
  return IS_NUM.test(t) ? arg.at + arg.text.indexOf(t) : -1
}

/** Every finding in a file: { kind, at } (the number's position). */
function findings(code) {
  const out = []
  const add = (kind, at) => at >= 0 && out.push({ kind, at })
  // Calls whose last or second argument is the bound.
  const CALLS = [
    { re: /\b(?:it|test|describe|beforeAll|afterAll|beforeEach|afterEach)(?:\.\w+)*\s*\(/g, kind: 'testTimeout', arg: (a) => (a.length >= 2 ? a[a.length - 1] : null) },
    { re: /(?<![\w$.])(?:lib\.)?until\s*\(/g, kind: 'until', arg: (a) => a[1] },
    { re: /\b(?:sleep|waitForTimeout)\s*\(/g, kind: 'sleep', arg: (a) => (a.length === 1 ? a[0] : null) },
    { re: /\bsetTimeout\s*\(/g, kind: 'promiseSleep', arg: (a) => (a.length === 2 && /^\s*[A-Za-z_$][\w$]*\s*$/.test(a[0].text) ? a[1] : null) }
  ]
  for (const c of CALLS) {
    for (const m of code.matchAll(c.re)) {
      const r = callArgs(code, m.index + m[0].length)
      if (r) add(c.kind, numberAt(c.arg(r.args)))
    }
  }
  const PATTERNS = [
    { re: new RegExp(String.raw`\b(?:testTimeout|hookTimeout|teardownTimeout)\s*:\s*(${NUM})\b`, 'g'), kind: 'setConfig' },
    { re: new RegExp(String.raw`\btimeout(?:Ms)?\s*:\s*(${NUM})\b`, 'g'), kind: 'timeout' },
    { re: new RegExp(String.raw`(?:Date|performance)\.now\(\)\s*-\s*[\w.]+\s*<=?\s*(${NUM})\b`, 'g'), kind: 'clockLoop' },
    { re: new RegExp(String.raw`\b(?:const|let|var)\s+[A-Z][A-Z0-9_]*_MS\s*=\s*(${NUM})\b`, 'g'), kind: 'msConstant' }
  ]
  for (const p of PATTERNS) for (const m of code.matchAll(p.re)) add(p.kind, m.index + m[0].lastIndexOf(m[1]))
  // A bound on a clock reading: toBeLessThan(N) whose statement (back to its expect) reads a clock or an elapsed time.
  for (const m of code.matchAll(new RegExp(String.raw`toBeLessThan(?:OrEqual)?\(\s*(${NUM})\s*\)`, 'g'))) {
    const stmt = code.slice(Math.max(0, code.lastIndexOf('expect', m.index)), m.index)
    if (/Date\.now|performance\.now|elapsed|took|\bms\b|\w+Ms\b/i.test(stmt)) add('clockAssert', m.index + m[0].lastIndexOf(m[1]))
  }
  // One finding per number (a setTimeout's bound inside a matched sleep counts once).
  const seen = new Set()
  return out.filter((f) => (seen.has(f.at) ? false : (seen.add(f.at), true))).sort((a, b) => a.at - b.at)
}

/** A line's text as a baseline keys it: whitespace folded. */
const fold = (s) => s.trim().replace(/\s+/g, ' ')

/** A file's literal waits: { line, kind, what, text, key }, in order; `key` is its kind and line, as the baseline holds it. */
export function literalsIn(src) {
  const lines = src.split(/\r?\n/)
  const starts = []
  for (let i = 0, p = 0; i < lines.length; i++) {
    starts.push(p)
    p += lines[i].length + (src[p + lines[i].length] === '\r' ? 2 : 1)
  }
  const lineOf = (at) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= at) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const out = []
  for (const f of findings(blank(src))) {
    const i = lineOf(f.at)
    if (OPT_OUT.test(lines[i]) || (i > 0 && OPT_OUT.test(lines[i - 1]))) continue
    out.push({ line: i + 1, kind: f.kind, what: WHAT[f.kind], text: lines[i].trim().slice(0, 160), key: `${f.kind} ${fold(lines[i])}` })
  }
  return out
}

/** Every test file the guard reads, repo-relative with forward slashes. */
export function testFiles(dir = TESTS) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const isDir = statSync(p).isDirectory()
      if (SKIP.test(p + (isDir ? '/' : ''))) continue
      if (isDir) walk(p)
      else if (FILE.test(name)) out.push(relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(dir)
  return out.sort()
}

/** The baseline: each listed file's literal keys, an entry per occurrence. */
export function readBaseline(file = ALLOW_FILE) {
  if (!existsSync(file)) return {}
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const files = raw.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {}
  const out = Object.create(null)
  for (const [f, keys] of Object.entries(files)) out[f] = Array.isArray(keys) ? keys.map(String) : []
  return out
}

/**
 * The guard's verdict: `found`, literals no baseline entry covers (each a failure, in a listed file too: added or
 * changed); `stale`, baseline entries with no literal left (each a failure, until --shrink drops them); `backlog`, each
 * listed file's covered count; `shrunk`, the baseline with its stale entries dropped (never one added).
 */
export function checkTree(files = testFiles(), baseline = readBaseline(), read = (f) => readFileSync(join(ROOT, f), 'utf8')) {
  const found = []
  const stale = []
  const backlog = []
  const shrunk = Object.create(null)
  for (const f of files) {
    const lits = literalsIn(read(f))
    const left = new Map()
    for (const k of baseline[f] ?? []) left.set(k, (left.get(k) ?? 0) + 1)
    const kept = []
    for (const l of lits) {
      const n = left.get(l.key) ?? 0
      if (n > 0) {
        left.set(l.key, n - 1)
        kept.push(l.key)
      } else found.push({ file: f, ...l })
    }
    for (const [k, n] of left) for (let j = 0; j < n; j++) stale.push({ file: f, key: k })
    if (kept.length) {
      backlog.push({ file: f, count: kept.length })
      shrunk[f] = kept
    }
  }
  for (const f of Object.keys(baseline)) if (!files.includes(f)) for (const k of baseline[f]) stale.push({ file: f, key: k })
  return { found, stale, backlog, shrunk }
}

const COMMENT = "HI-3378: the test files' waits and timeouts that still write numbers in place, by occurrence (each its kind and its line's text, whitespace folded): the backlog HI-3381 (unit) and HI-3382 (e2e, scenarios) migrate to names from tests/timing.json (scripts/timingLiterals.mjs). check:repo fails a literal no entry here covers (added, or changed), and an entry with no literal left; `node scripts/testWaits.mjs --literals --shrink` drops those, and never adds one. Never add an entry by hand."

/** Writes the baseline: `files`, each file's keys sorted, its line endings CRLF as the working tree has them. */
export function writeBaseline(files, file = ALLOW_FILE) {
  const sorted = Object.fromEntries(Object.keys(files).sort().map((f) => [f, [...files[f]].sort()]))
  writeFileSync(file, JSON.stringify({ $comment: COMMENT, files: sorted }, null, 2).replace(/\n/g, '\r\n') + '\r\n')
}
