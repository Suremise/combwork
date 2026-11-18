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
// Each file is parsed (@babel/parser: its syntax tree, never its text), so a call written over several lines, with a
// trailing comma, a regular expression or a comment inside, counts as the call it is, and text that only looks like a
// wait (in a string, a template, a regular expression or a comment) is none. Simulated time (vi.advanceTimersByTime and its kin) matches no kind. A number
// that is no wait (a value under test, a child's own life) says `timing-ok: <why>` on its line or the line above.
//
// The backlog (HI-3381, HI-3382 migrate it): tests/timingAllow.json, each file's existing literals by occurrence (its kind
// and its line's text, whitespace folded), as many of each as there are. A literal not covered by that baseline fails,
// in a listed file too: one added, or one changed (its line's text no longer the baseline's). A baseline entry with no
// literal left fails as well, until `--literals --shrink` writes the baseline without it: that update only ever removes
// entries, so the baseline can't grow by the tool, and one grown by hand shows in review as an addition to that file.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
// @babel/parser (a dev dependency: TypeScript 7 has no JavaScript compiler API), for each file's syntax tree.
const { parse } = createRequire(import.meta.url)('@babel/parser')

const ROOT = join(import.meta.dirname, '..')
const TESTS = join(ROOT, 'tests')
export const ALLOW_FILE = join(TESTS, 'timingAllow.json')
/** A fake is a CLI, a fixture is data; the timing files are where the numbers belong. */
const SKIP = /[\\/](node_modules|fixtures|fake-[^\\/]*)[\\/]|[\\/]tests[\\/]timing(\.ci)?\.(json|cjs|d\.cts)$/
const FILE = /\.(ts|mts|cts|cjs|mjs|js)$/
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
  clockAssert: 'a bound on a clock reading',
  unparsed: "a file the guard can't parse, so its waits can't be checked"
}

/** A numeric literal written in place (`5000`, `60_000`), never a name or an expression. */
const isNum = (n) => !!n && n.type === 'NumericLiteral'
const TEST_CALLS = new Set(['it', 'test', 'describe', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'suite', 'bench'])
const CLOCK = /Date\.now|performance\.now|elapsed|took|\bms\b|\w+Ms\b/i
/** Wrappers that change nothing of an expression (a cast, a `!`, parentheses). */
const unwrap = (e) => {
  while (e && (e.type === 'TSNonNullExpression' || e.type === 'TSAsExpression' || e.type === 'TSSatisfiesExpression' || e.type === 'ParenthesizedExpression' || e.type === 'TypeCastExpression')) e = e.expression
  return e
}
const isCall = (n) => !!n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')
const isMember = (n) => !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
const propName = (m) => (m.computed ? (m.property.type === 'StringLiteral' ? m.property.value : null) : m.property.name)

/** The identifier a chain starts from (`it` in it.each(…)(…), `lib` in lib.until). */
function rootName(expr) {
  let e = unwrap(expr)
  for (;;) {
    if (!e) return null
    if (e.type === 'Identifier') return e.name
    if (isMember(e)) e = unwrap(e.object)
    else if (isCall(e)) e = unwrap(e.callee)
    else if (e.type === 'TaggedTemplateExpression') e = unwrap(e.tag)
    else return null
  }
}

/** The name a call is made by: `it` for it(…), it.only(…), it.each([…])(…); `until` for until(…), lib.until(…). */
function calleeName(callee) {
  const e = unwrap(callee)
  if (!e) return null
  if (e.type === 'Identifier') return e.name
  if (isMember(e)) {
    // A method's own name (page.waitForTimeout, lib.until), unless its chain starts at a test function (it.only, it.each).
    const root = rootName(e.object)
    return TEST_CALLS.has(root) ? root : propName(e)
  }
  // it.each([…])(…), test.each`…`(…): the call is made by what it.each returns.
  return (isCall(e) || e.type === 'TaggedTemplateExpression') && TEST_CALLS.has(rootName(e)) ? rootName(e) : null
}

/** Each child node of a node (its fields that hold nodes), never its position data or comments. */
function* children(node) {
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'range' || key.endsWith('Comments')) continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x.type === 'string') yield x
    } else if (v && typeof v.type === 'string') yield v
  }
}

/** Every finding in a file: { kind, at } (its number's position), read from its syntax tree (@babel/parser). */
function findings(src, fileName) {
  let ast
  try {
    ast = parse(src, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true, plugins: /\.(ts|mts|cts)$/.test(fileName) ? ['typescript'] : ['jsx'] })
  } catch {
    // Not parseable: its waits can't be checked, which is a finding of its own (never a pass by silence).
    return [{ kind: 'unparsed', at: 0 }]
  }
  const out = []
  const add = (kind, node) => node && out.push({ kind, at: node.start })
  const textOf = (n) => src.slice(n.start, n.end)
  const stack = [ast.program]
  while (stack.length) {
    const node = stack.pop()
    if (isCall(node)) {
      const name = calleeName(node.callee)
      const args = node.arguments
      const last = args[args.length - 1]
      if (name && TEST_CALLS.has(name) && args.length >= 2 && isNum(last)) add('testTimeout', last)
      else if (name === 'until' && isNum(args[1])) add('until', args[1])
      else if ((name === 'sleep' || name === 'waitForTimeout') && args.length === 1 && isNum(args[0])) add('sleep', args[0])
      else if (name === 'setTimeout' && args.length === 2 && unwrap(args[0])?.type === 'Identifier' && isNum(args[1])) add('promiseSleep', args[1])
      else if ((name === 'toBeLessThan' || name === 'toBeLessThanOrEqual') && args.length === 1 && isNum(args[0])) {
        // A bound on a clock reading: the expect(…) this matcher ends reads a clock or an elapsed time.
        let e = unwrap(node.callee)
        while (e && !(isCall(e) && unwrap(e.callee)?.type === 'Identifier' && unwrap(e.callee).name === 'expect')) e = isMember(e) ? unwrap(e.object) : isCall(e) ? unwrap(e.callee) : null
        if (e && e.arguments[0] && CLOCK.test(textOf(e.arguments[0]))) add('clockAssert', args[0])
      }
    } else if ((node.type === 'ObjectProperty' || node.type === 'Property') && !node.computed && isNum(node.value)) {
      const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'StringLiteral' ? node.key.value : null
      if (key === 'testTimeout' || key === 'hookTimeout' || key === 'teardownTimeout') add('setConfig', node.value)
      else if (key === 'timeout' || key === 'timeoutMs') add('timeout', node.value)
    } else if (node.type === 'BinaryExpression' && (node.operator === '<' || node.operator === '<=') && isNum(node.right)) {
      // `Date.now() - t < N`: a loop's limit on a clock.
      const l = unwrap(node.left)
      if (l.type === 'BinaryExpression' && l.operator === '-' && /^(?:Date|performance)\.now\(\)$/.test(textOf(unwrap(l.left)).replace(/\s+/g, ''))) add('clockLoop', node.right)
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z][A-Z0-9_]*_MS$/.test(node.id.name) && isNum(node.init)) add('msConstant', node.init)
    for (const c of children(node)) stack.push(c)
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A line's text as a baseline keys it: whitespace folded. */
const fold = (s) => s.trim().replace(/\s+/g, ' ')

/** A file's literal waits: { line, kind, what, text, key }, in order; `key` is its kind and line, as the baseline holds it. */
export function literalsIn(src, fileName = 'test.ts') {
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
  for (const f of findings(src, fileName)) {
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
    const lits = literalsIn(read(f), f)
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
