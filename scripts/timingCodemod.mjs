// HI-3382: the e2e suites' and scenarios' waits moved to names from tests/timing.json, mechanically, where that is safe:
// a hang bound (a `*_HUNG*_MS` constant, `until`'s bound, a Playwright or child-process `timeout:`) becomes the name its
// work and value call for, never shorter than it was (hang.ui is 30 s, hang.step 120 s, hang.slow 300 s). What isn't
// plainly a hang bound is left as it is and reported, for a person: a negative wait (that nothing happens within the
// time), a timeout's expected rejection, a short action budget, a zero, a value past every hang name, a *_MS constant that
// isn't a hang bound. `until` calls that leave the bound out (its default, now required: lib.cjs) get one written in.
//
//   node scripts/timingCodemod.mjs [--write] [files…]   (default: tests/e2e/*.cjs and tests/scenarios/*.cjs; a dry run
//                                                        prints what it would change and what it leaves, by file)
//
// Read with @babel/parser, edited by the syntax tree's offsets: a string, a comment or a regular expression that looks
// like a wait is never one. Not shipped; kept for review and for a rerun after a merge.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The hang names, longest bound last, and what each holds (tests/timing.json). */
export const HANG = [
  { name: 'hang.ui', ms: 30_000 },
  { name: 'hang.step', ms: 120_000 },
  { name: 'hang.slow', ms: 300_000 }
]
/** A wait on Combwork's own work (a start, a merge, a turn, a slot…): at least hang.step, whatever it was written as. */
const STEP_WORK = /\b(start(?:s|ed|ing)?|merg(?:e|ed|es|ing)|lanes?|queue[ds]?|slots?|install(?:ed|s)?|build|commit(?:s|ted)?|push(?:ed)?|pull(?:ed)?|rebase|checkout|worktrees?|resum(?:e|ed|es)|restart(?:ed|s)?|relaunch|launch(?:ed|es)?|turns?|placed|lease[ds]?|advance[ds]?|integrat\w*|upgrad\w*|backups?|restor\w*|clone|fetch(?:ed)?|BuilderPlaced|SlotPrepared|agentQuiet|inboxQuiet|session(?:s)?)\b|status\s*===\s*'(?:ready|finished|working|watching)'/i
/** Playwright's methods whose `timeout:` bounds a wait for the page. */
const PW = new Set(['waitFor', 'waitForSelector', 'waitForFunction', 'waitForEvent', 'waitForURL', 'waitForLoadState', 'click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'hover', 'check', 'uncheck', 'focus', 'innerText', 'textContent', 'innerHTML', 'inputValue', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'getAttribute', 'screenshot', 'selectOption', 'setInputFiles', 'scrollIntoViewIfNeeded', 'boundingBox', 'dispatchEvent', 'tap', 'dragTo', 'evaluate', 'firstWindow', 'waitForPage', 'newPage', 'goto'])
/** Child processes whose `timeout:` bounds a run: spawn.hang. */
const CHILD = new Set(['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn', 'fork'])
/** A Playwright timeout under this is an action budget (a click given 300 ms to land), never moved by this. */
const SHORT_MS = 5000

/** The hang name for a bound of `ms` on work described by `text`: the shortest that is no shorter than `ms`; null past every one. */
export function hangName(ms, text = '') {
  const floor = STEP_WORK.test(text) ? 1 : 0
  for (let i = floor; i < HANG.length; i++) if (ms <= HANG[i].ms) return HANG[i].name
  return null
}

const isNum = (n) => !!n && n.type === 'NumericLiteral'
const isCall = (n) => !!n && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')
const isMember = (n) => !!n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
const unwrap = (e) => {
  while (e && (e.type === 'ParenthesizedExpression' || e.type === 'TSNonNullExpression' || e.type === 'TSAsExpression')) e = e.expression
  return e
}
const propName = (m) => (m.computed ? (m.property.type === 'StringLiteral' ? m.property.value : null) : m.property.name)

function* children(node) {
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'range' || key.endsWith('Comments')) continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x.type === 'string') yield x
    } else if (v && typeof v.type === 'string') yield v
  }
}

/**
 * The names `until` goes by in a file: `until` itself (lib's, a local wrapper, a destructured one), and any name bound to
 * `lib.until` or destructured from lib under another name (`const { until: waitFor } = lib`).
 */
function untilNames(ast) {
  const names = new Set(['until'])
  const stack = [ast.program]
  while (stack.length) {
    const n = stack.pop()
    if (n.type === 'VariableDeclarator') {
      const init = unwrap(n.init)
      if (n.id.type === 'Identifier' && isMember(init) && propName(init) === 'until') names.add(n.id.name)
      if (n.id.type === 'ObjectPattern') for (const p of n.id.properties) if (p.type === 'ObjectProperty' && p.key.type === 'Identifier' && p.key.name === 'until' && p.value.type === 'Identifier') names.add(p.value.name)
    }
    for (const c of children(n)) stack.push(c)
  }
  return names
}

/** The name a call is made by: `until` for until(…) and lib.until(…); a method's own name; null otherwise. */
function calleeName(callee) {
  const e = unwrap(callee)
  if (!e) return null
  if (e.type === 'Identifier') return e.name
  if (isMember(e)) return propName(e)
  return null
}

/**
 * Whether the call at the end of `path` (its ancestors, nearest last) is a negative wait: its result read as "it didn't
 * happen" (`!(await until(…))`, `expect(…).toBe(false)`, `=== false`, `?? false` compared), or a timeout whose rejection is
 * expected (`.catch(…)` on it).
 */
function negative(path, src) {
  for (let i = path.length - 1, steps = 0; i >= 0 && steps < 4; i--, steps++) {
    const p = path[i]
    if (p.type === 'UnaryExpression' && p.operator === '!') {
      // `!!x` reads x as true (a success asserted): count the `!`s in a row; an odd number is a negation.
      let bangs = 0
      while (i >= 0 && path[i].type === 'UnaryExpression' && path[i].operator === '!') {
        bangs++
        i--
      }
      if (bangs % 2 === 1) return true
      i++
      continue
    }
    if (p.type === 'BinaryExpression' && /^[!=]==?$/.test(p.operator) && /\b(false|null|undefined)\b/.test(src.slice(p.start, p.end))) return true
    if (isMember(p) && /^(catch|toBe|toBeFalsy|toBeNull|toBeUndefined|toEqual)$/.test(propName(p) ?? '')) {
      const after = src.slice(p.end, p.end + 20)
      if (propName(p) === 'catch' || /^\(\s*(false|null|undefined)?\s*\)/.test(after)) return true
    }
    if (p.type === 'ExpressionStatement' || p.type === 'VariableDeclarator' || p.type === 'ReturnStatement') break
  }
  return false
}

/**
 * What the codemod changes in `src` (a file's text) and what it leaves for a person: { out, changed: [{ line, from, to }],
 * left: [{ line, why, text }] }. `fileName` decides how `timing` is reached (lib.cjs's own, lib.timing, or a require).
 */
export function migrate(src, fileName = 'x.cjs') {
  const ast = parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, errorRecovery: false })
  const names = untilNames(ast)
  const lineOf = (at) => src.slice(0, at).split('\n').length
  const textAt = (at) => src.split('\n')[lineOf(at) - 1].trim().slice(0, 160)
  const isLib = /(^|[\\/])lib\.cjs$/.test(fileName)
  const hasLib = /\bconst\s+lib\s*=\s*require\(\s*['"]\.\/lib\.cjs['"]\s*\)/.test(src)
  const definesTiming = /\b(?:const|let|var)\s*\{[^}]*\btiming\b[^}]*\}\s*=\s*require\(/.test(src)
  const ref = isLib || definesTiming ? 'timing' : hasLib ? 'lib.timing' : 'timing'
  const needsRequire = !isLib && !definesTiming && !hasLib
  const edits = []
  const changed = []
  const left = []
  const name = (n) => `${ref}('${n}')`
  const replace = (node, to) => {
    edits.push({ start: node.start, end: node.end, text: to })
    changed.push({ line: lineOf(node.start), from: src.slice(node.start, node.end), to })
  }
  const leave = (node, why) => left.push({ line: lineOf(node.start), why, text: textAt(node.start) })

  // Walk with the path of ancestors, to read a call's context (its check's label, a negative use).
  const walk = (node, path) => {
    if (isCall(node)) {
      const callee = calleeName(node.callee)
      const args = node.arguments
      const isUntil = names.has(callee) && (unwrap(node.callee).type === 'Identifier' || (isMember(unwrap(node.callee)) && propName(unwrap(node.callee)) === 'until'))
      if (isUntil && args.length >= 1 && args[0].type !== 'SpreadElement') {
        // The work waited for: the predicate's text and the label of a check(…) it is inside.
        const label = path.slice().reverse().find((p) => isCall(p) && calleeName(p.callee) === 'check' && p.arguments[0]?.type === 'StringLiteral')
        const about = src.slice(args[0].start, args[0].end) + ' ' + (label ? label.arguments[0].value : '')
        const neg = negative(path, src)
        if (args.length === 1) {
          if (neg) leave(node, 'a negative wait with no bound: name its window by hand (quiet.*)')
          else {
            const n = hangName(HANG[0].ms, about)
            edits.push({ start: args[0].end, end: args[0].end, text: `, ${name(n)}` })
            changed.push({ line: lineOf(node.start), from: '(no bound)', to: name(n) })
          }
        } else if (isNum(args[1])) {
          const ms = args[1].value
          if (neg) leave(args[1], 'a negative wait (that nothing happens within it): name its window by hand (quiet.*)')
          else if (ms <= 0) leave(args[1], 'a bound of 0: by hand')
          else {
            const n = hangName(ms, about)
            if (n) replace(args[1], name(n))
            else leave(args[1], `a bound past every hang name (${ms} ms): by hand`)
          }
        }
      }
    } else if ((node.type === 'ObjectProperty' || node.type === 'Property') && !node.computed && isNum(node.value)) {
      const key = node.key.type === 'Identifier' ? node.key.name : node.key.type === 'StringLiteral' ? node.key.value : null
      if (key === 'timeout' || key === 'timeoutMs') {
        const obj = path[path.length - 1]
        const call = path[path.length - 2]
        const method = isCall(call) && call.arguments.includes(obj) ? calleeName(call.callee) : null
        const ms = node.value.value
        const neg = negative(path.slice(0, -1), src)
        if (ms <= 0) leave(node.value, 'a timeout of 0 (none): by hand')
        else if (neg) leave(node.value, 'a timeout whose rejection is expected (.catch, a false result): by hand')
        else if (method && PW.has(method)) {
          if (ms < SHORT_MS) leave(node.value, `a short action budget (${ms} ms on ${method}): by hand`)
          else {
            const n = hangName(ms)
            if (n) replace(node.value, name(n))
            else leave(node.value, `a timeout past every hang name (${ms} ms): by hand`)
          }
        } else if (method && CHILD.has(method)) {
          if (ms < SHORT_MS) leave(node.value, `a short child-process limit (${ms} ms): by hand`)
          else replace(node.value, name('spawn.hang'))
        } else leave(node.value, `a timeout: on ${method ?? 'an option object'}: by hand (not plainly a page's or a child's hang bound)`)
      }
    } else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z][A-Z0-9_]*_MS$/.test(node.id.name) && isNum(node.init)) {
      if (/HUNG/.test(node.id.name)) {
        const n = hangName(node.init.value)
        if (n) replace(node.init, name(n))
        else leave(node.init, `${node.id.name} past every hang name: by hand`)
      } else leave(node.init, `${node.id.name} isn't a hang bound by its name: by hand (a budget, a quiet or a pace?)`)
    }
    path.push(node)
    for (const c of children(node)) walk(c, path)
    path.pop()
  }
  walk(ast.program, [])

  // A local `until` wrapper's literal default bound goes once every call names its own (just done above).
  const stack = [ast.program]
  while (stack.length) {
    const n = stack.pop()
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && names.has(n.id.name) && n.init && /Function/.test(n.init.type)) {
      for (const p of n.init.params) if (p.type === 'AssignmentPattern' && isNum(p.right)) {
        edits.push({ start: p.left.end, end: p.right.end, text: '' })
        changed.push({ line: lineOf(p.start), from: src.slice(p.start, p.end), to: src.slice(p.left.start, p.left.end) })
      }
    }
    for (const c of children(n)) stack.push(c)
  }

  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  if (edits.length && needsRequire && !/\btiming\s*\(/.test(src.replace(/\/\/.*$/gm, ''))) {
    // The reader, after the file's first require (or at the top).
    const eol = src.includes('\r\n') ? '\r\n' : '\n'
    const req = `const { timing } = require('${fileName.replace(/\\/g, '/').includes('/scenarios/') ? '../timing.cjs' : '../timing.cjs'}')`
    const m = /^.*require\(.*$/m.exec(out)
    out = m ? out.slice(0, m.index + m[0].length) + eol + req + out.slice(m.index + m[0].length) : req + eol + out
  }
  return { out, changed, left }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const given = args.filter((a) => !a.startsWith('--'))
  const files = given.length ? given.map((f) => resolve(f)) : ['tests/e2e', 'tests/scenarios'].flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => /\.cjs$/.test(f)).map((f) => join(ROOT, d, f)))
  let nChanged = 0
  let nLeft = 0
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    let r
    try {
      r = migrate(src, file)
    } catch (e) {
      console.log(`${relative(ROOT, file)}: not parsed (${e.message}): left whole`)
      continue
    }
    nChanged += r.changed.length
    nLeft += r.left.length
    if (write && r.out !== src) writeFileSync(file, r.out)
    for (const l of r.left) console.log(`LEFT ${relative(ROOT, file)}:${l.line}  ${l.why}  | ${l.text}`)
  }
  console.log(`${write ? 'changed' : 'would change'} ${nChanged}; left ${nLeft} for a person`)
}
