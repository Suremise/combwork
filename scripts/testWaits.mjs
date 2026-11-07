// Tests wait for conditions, never for time (tests/README.md, #524): finds fixed sleeps in the tests that a check follows
// within a few lines, with no comment saying why the sleep is meant (on its line or the line above); and waits that
// state no bound of their own (#570): a `vi.waitFor`, `expect.poll` or `until` left to its default (Vitest's 1 s,
// until's 10 s), or bounded by a number under 5 s, which is a time budget, not a bound for a hung run.
//   npm run test:waits             the sleeps this branch adds or changes since main (uncommitted and new files too),
//                                  and waits added or changed with no bound; exits 1 when there is one
//   npm run test:waits -- --all    every such sleep in the tests, the backlog #524's audit ranks, and the waits with no
//                                  bound (lists only, exits 0)
//   --base <ref>                   compare with another ref than main
// It exits 2 when it can't compare (no such ref, git fails): nothing was checked. What it can't see: a single read
// with no sleep before it, a sleep more than three lines before its check, and a wait under another helper's name.
// A comment beside or above a sleep, or a short bound, counts as its reason; the reviewer judges the reason
// (tests/README.md).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
/** A fake's sleep is a slow CLI, and fixtures aren't tests. */
const SKIP = /[\\/](node_modules|fixtures|fake-[^\\/]*)[\\/]/
const TEST_FILE = /\.(test\.ts|cjs|mjs)$/
const SLEEP = /\b(?:lib\.)?sleep\(\s*[^)\s]|\bwaitForTimeout\(|new Promise\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(\s*\w+\s*,/
const CHECK = /\b(?:check|expect|assert(?:\.\w+)?)\s*\(/
const WAITS = /\buntil\(|\bwaitFor\b|\.poll\(|\.toPass\(/
const NEAR = 3

/** The line with its string literals emptied, so a test's text that names a sleep or a check isn't one. */
const code = (line) => line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '$1$1')

/** A loop condition that only counts or times (`true`, `i < 3`, `Date.now() < end`): it repeats, it waits for nothing. */
const BLIND = /^\s*(?:true|1|\w+\s*[<>]=?\s*[\w.]+|(?:Date|performance)\.now\(\)\s*[<>]=?\s*[\w.]+|[\w.]+\s*[<>]=?\s*(?:Date|performance)\.now\(\))?\s*$/
/** A loop's condition: a `while`'s, or a counted `for`'s middle part; null for anything else (a `for…of` walks a list). */
const loopCondition = (head) => {
  const w = /\bwhile\s*\((.*)\)\s*$/.exec(head)
  if (w) return w[1]
  const f = /\bfor\s*\(([^;]*);([^;]*);[^)]*\)\s*$/.exec(head)
  return f ? f[2] : null
}

/**
 * Whether the sleep at line i is a polling loop's pause, the way such a loop waits for its condition: the loop polls
 * observable state (its condition isn't only a count or a time, or its body leaves on an `if` with `break`/`return`), and
 * the check the sleep is for (at line `checkAt`) comes after the loop, not in its body. A loop that only repeats
 * actions, counted or timed, is no poll: a sleep in it before a check is reported like any other.
 */
function inPoll(lines, i, checkAt) {
  const bare = code(lines[i])
  const before = bare.slice(0, bare.search(SLEEP)).replace(/\s*(?:\{\s*)?(?:await\s*)?$/, '')
  // A loop on the sleep's own line: `while (!done()) await sleep(20)`.
  const own = loopCondition(before)
  if (own != null) return !BLIND.test(own) && checkAt !== i
  // The block the sleep is in, and the loop that opens it.
  let open = null
  let depth = 0
  for (let j = i - 1; j >= Math.max(0, i - 20) && !open; j--) {
    const l = code(lines[j])
    for (let k = l.length - 1; k >= 0; k--) {
      if (l[k] === '}') depth++
      else if (l[k] === '{' && depth-- === 0) {
        open = { line: j, at: k, head: l.slice(0, k) }
        break
      }
    }
  }
  if (!open) return false
  const isDo = /\bdo\s*$/.test(open.head)
  if (!isDo && loopCondition(open.head) == null) return false
  // Its body, to the matching brace (and a `do`'s `while (…)` after it).
  let body = ''
  let close = null
  depth = 0
  for (let j = open.line; j < Math.min(lines.length, open.line + 60) && !close; j++) {
    const l = code(lines[j])
    for (let k = j === open.line ? open.at + 1 : 0; k < l.length; k++) {
      if (l[k] === '{') depth++
      else if (l[k] === '}' && depth-- === 0) {
        close = { line: j, tail: l.slice(k + 1) }
        break
      }
      body += l[k]
    }
    body += '\n'
  }
  if (!close || (checkAt != null && checkAt <= close.line)) return false
  const condition = isDo ? (/^\s*while\s*\((.*)\)/.exec(close.tail)?.[1] ?? null) : loopCondition(open.head)
  const leaves = /\bif\s*\(/.test(body) && /\b(?:break|return)\b/.test(body)
  return leaves || (condition != null && !BLIND.test(condition))
}

/** A comment on the line, or a comment line just above it: why the sleep is meant. */
const commented = (lines, i) => /\/\/|\/\*/.test(lines[i]) || /^\s*(\/\/|\*|\/\*)/.test(lines[i - 1] ?? '')

/**
 * The one accepted reason for a fixed sleep (HI-2689), for this script and tests/e2esuites.test.ts's long sleeps alike:
 * a comment on its line or the line above saying why it is meant, or the sleep being a race's timeout
 * (`Promise.race([…, sleep(n)])`, in code). The reviewer judges what the comment says (tests/README.md).
 */
export const sleepExplained = (lines, i) => commented(lines, i) || /Promise\.race\(/.test(code(lines[i]))

/** The sleeps in a file's text that a check follows within NEAR lines: { line (1-based), code, commented }. */
export function findWaits(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  lines.forEach((line, i) => {
    const bare = code(line)
    if (!SLEEP.test(bare) || /^\s*(\/\/|\*)/.test(line) || /function sleep|sleep\s*=/.test(bare)) return
    // The first check after it is the one the sleep is for. Only when that check itself waits for its condition
    // (until, waitFor, poll) is the sleep merely redundant: a wait in a later check doesn't cover an earlier one.
    const rest = bare.slice(bare.search(SLEEP)).replace(SLEEP, '')
    const near = [rest, ...lines.slice(i + 1, i + 1 + NEAR).map(code)]
    const at = near.findIndex((l) => CHECK.test(l))
    if (at < 0 || WAITS.test(near[at])) return
    // A pause inside a polling loop is how the loop waits for its condition, not a wait before a check.
    if (inPoll(lines, i, i + at)) return
    out.push({ line: i + 1, code: line.trim(), commented: sleepExplained(lines, i) })
  })
  return out
}

/** A bound under this (ms) is a time budget, not a bound for a hung run: it needs a comment saying why it is short. */
export const MIN_BOUND_MS = 5000

/** Whether a slash after `before` (the code so far) starts a regex literal: after an operator, bracket or keyword. */
function regexAllowed(before) {
  const t = before.replace(/\s+$/, '')
  return !t || /[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(t)
}

/**
 * The text with its comments, strings and regex literals blanked (newlines kept): code only. A template literal's text
 * is blanked and its `${…}` expressions kept, since they are code (round 1 finding: a wait inside one was missed).
 */
export function codeOnly(text) {
  const n = text.length
  const out = []
  const blankTo = (from, to) => {
    for (let k = from; k < to; k++) out.push(text[k] === '\n' ? '\n' : ' ')
  }
  /** Code from i; inside a template's `${`, up to its closing brace (returned, not consumed). */
  const scan = (i, inExpression) => {
    let depth = 0
    while (i < n) {
      const c = text[i]
      const d = text[i + 1]
      if (c === '/' && (d === '/' || d === '*')) {
        const e = d === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2)
        const end = e < 0 ? n : d === '/' ? e : e + 2
        blankTo(i, end)
        i = end
      } else if (c === '/' && regexAllowed(out.slice(-40).join(''))) {
        let j = i + 1
        for (let cls = false; j < n && text[j] !== '\n'; j++) {
          if (text[j] === '\\') j++
          else if (text[j] === '[') cls = true
          else if (text[j] === ']') cls = false
          else if (text[j] === '/' && !cls) break
        }
        out.push('/')
        blankTo(i + 1, Math.min(j, n))
        if (j < n) out.push('/')
        i = j + 1
      } else if (c === "'" || c === '"') {
        let j = i + 1
        for (; j < n && text[j] !== c && text[j] !== '\n'; j++) if (text[j] === '\\') j++
        out.push(c)
        blankTo(i + 1, Math.min(j, n))
        if (j < n && text[j] === c) {
          out.push(c)
          j++
        }
        i = j
      } else if (c === '`') {
        out.push('`')
        i++
        while (i < n && text[i] !== '`') {
          if (text[i] === '\\') {
            blankTo(i, Math.min(i + 2, n))
            i += 2
          } else if (text[i] === '$' && text[i + 1] === '{') {
            out.push('$', '{')
            i = scan(i + 2, true)
            if (i < n) out.push('}')
            i++
          } else {
            blankTo(i, i + 1)
            i++
          }
        }
        if (i < n) out.push('`')
        i++
      } else if (inExpression && c === '}' && depth === 0) {
        return i
      } else {
        if (c === '{') depth++
        else if (c === '}') depth--
        out.push(c)
        i++
      }
    }
    return i
  }
  scan(0, false)
  return out.join('')
}

const WAIT_CALL = /(?<![\w.$])(?:lib\.)?until\s*\(|\bvi\.waitFor\s*\(|\bexpect\.poll\s*\(/g

/**
 * The waits in a file's text that state no bound of their own (#570): `until(fn)` with no ms, `vi.waitFor(fn)` and
 * `expect.poll(fn)` with no options or options with no timeout, and any of them bounded by a number under
 * MIN_BOUND_MS: { line (1-based), code, commented }. A bound given by a name (HUNG_MS, a constant) counts as stated.
 * The arguments are read as code: a timeout only in a comment or a string isn't one. Only a short bound can have a
 * reason (`commented`: a retry's pace, a quiet period); a wait with no bound never has one, so it is never commented.
 */
export function findUnbounded(text, changed = null) {
  const src = codeOnly(text)
  const lines = text.split(/\r?\n/)
  const out = []
  for (const m of src.matchAll(WAIT_CALL)) {
    // A helper's own definition (`function until(fn, ms)`, `until = async (fn, ms = 10000) => {`) isn't a wait.
    if (/function\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue
    const args = []
    let depth = 0
    let start = m.index + m[0].length
    let j = start
    for (; j < src.length; j++) {
      const c = src[j]
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) {
        args.push(src.slice(start, j).trim())
        start = j + 1
      }
    }
    args.push(src.slice(start, j).trim())
    // A definition's arrow, body or return type follows its parameters; a wait awaited, returned or in an expression is a
    // call whatever follows it (#1400: `x ? await until(fn) : null`'s `:` is the ternary's).
    const called = /(?:\bawait|\breturn|\bvoid|[=(,?:!&|+])\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))
    if (!called && /^\s*(=>|\{|:)/.test(src.slice(j + 1, j + 10))) continue
    const bound = args.filter(Boolean)[1]
    const number = (v) => /^[\d_]+$/.test(v)
    const short = (v) => number(v) && Number(v.replace(/_/g, '')) < MIN_BOUND_MS
    let given = !!bound
    let tooShort = false
    if (bound && !/until\s*\($/.test(m[0]) && bound.startsWith('{')) {
      const t = /(?:^|[{,\s])timeout\s*:\s*([^,}\s]+)/.exec(bound)
      given = !!t
      tooShort = !!t && short(t[1])
    } else if (bound) tooShort = short(bound)
    if (given && !tooShort) continue
    const i = src.slice(0, m.index).split('\n').length - 1
    // A change anywhere in the call counts, including removing a multiline timeout. A short bound also depends on
    // its preceding reason comment. With no changed-line set this remains the full audit.
    const end = src.slice(0, j).split('\n').length
    if (changed && ![...changed].some((n) => n >= i + (tooShort ? 0 : 1) && n <= end)) continue
    out.push({ line: i + 1, code: lines[i].trim(), commented: given && commented(lines, i) })
  }
  return out
}

/** The line numbers each test file has added since `base` (working tree included), and the new untracked files. */
function changedLines(base) {
  // No GIT_DIR or other GIT_* from the shell: this checkout's own repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)))
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const from = git('merge-base', 'HEAD', base).trim()
  const changed = new Map()
  let file = null
  for (const l of git('diff', '--unified=0', '--no-color', '--no-ext-diff', from, '--', 'tests').split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6)
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l)
    if (file && hunk) {
      const set = changed.get(file) ?? new Set()
      for (let n = +hunk[1]; n < +hunk[1] + +(hunk[2] ?? 1); n++) set.add(n)
      // A deletion-only hunk touches the gap after this line: keep both sides so removing a bound or reason counts.
      if (hunk[2] === '0') {
        set.add(+hunk[1])
        set.add(+hunk[1] + 1)
      }
      changed.set(file, set)
    }
  }
  for (const f of git('ls-files', '--others', '--exclude-standard', '--', 'tests').split('\n').filter(Boolean)) changed.set(f, 'all')
  return changed
}

function allFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (SKIP.test(p + '/')) return []
    return statSync(p).isDirectory() ? allFiles(p) : TEST_FILE.test(n) ? [p] : []
  })
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main'
  let found = 0
  let unbounded = 0
  const reportUnbounded = () => {
    if (unbounded) console.log(`\n${unbounded} wait(s) with no bound of their own, or one under ${MIN_BOUND_MS / 1000} s with no comment saying why: give each a named bound for a hung run (HUNG_MS, 10–30 s; tests/README.md).\n`)
  }
  if (all) {
    for (const f of allFiles(join(ROOT, 'tests'))) {
      for (const w of findUnbounded(readFileSync(f, 'utf8')).filter((x) => !x.commented)) {
        unbounded++
        console.log(`${relative(ROOT, f)}:${w.line}  ${w.code.slice(0, 140)}`)
      }
    }
    reportUnbounded()
    for (const f of allFiles(join(ROOT, 'tests'))) {
      for (const w of findWaits(readFileSync(f, 'utf8')).filter((x) => !x.commented)) {
        found++
        console.log(`${relative(ROOT, f)}:${w.line}  ${w.code.slice(0, 140)}`)
      }
    }
    console.log(`\n${found} sleep(s) followed by a check, with no comment saying why (the backlog: tests/README.md).`)
    process.exit(0)
  }
  let changed
  try {
    changed = changedLines(base)
  } catch (e) {
    // Nothing was checked, so it hasn't passed.
    console.error(`Can't compare with ${base} (${String(e.message).split('\n')[0]}): nothing checked.`)
    process.exit(2)
  }
  for (const [f, lines] of changed) {
    const p = join(ROOT, f)
    if (SKIP.test(p + '/') || !TEST_FILE.test(f) || !existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const w of findUnbounded(text, lines === 'all' ? null : lines).filter((x) => !x.commented)) {
      unbounded++
      console.log(`${f}:${w.line}  ${w.code.slice(0, 140)}`)
    }
    for (const w of findWaits(text)) {
      if (w.commented || (lines !== 'all' && !lines.has(w.line))) continue
      found++
      console.log(`${f}:${w.line}  ${w.code.slice(0, 140)}`)
    }
  }
  console.log(found ? `\n${found} new or changed sleep(s) followed by a check: wait for the condition instead, or say in a comment why the sleep is meant (tests/README.md).` : `No new sleep followed by a check since ${base}.`)
  reportUnbounded()
  if (!unbounded) console.log(`Every new or changed wait states its bound since ${base}.`)
  process.exit(found || unbounded ? 1 : 0)
}
