// The presence-check rule (HI-2617, after HI-2612): in the one-way upgrade's code and the test area's, only an absence
// (ENOENT or ENOTDIR: src/main/fsPresence.ts, and the test area's own absent()) answers "not there", and an I/O
// failure is never taken for a result. Read from each file's syntax tree, not its text:
//
// - existsSync, by any name (imported under another, `fs.existsSync`, `fs['existsSync']`): it answers false for access
//   denied or a held file as it does for an absence. Use fsPresence's present()/lstatOrNull(), or the error's code.
// - A handler that swallows: a `catch` clause, or the function given to `.catch(f)` or as `.then(ok, f)`'s second, with
//   any way out of it that passes the failure on. Each way out is followed (if and else, return, continue, the end):
//   - the absence's own branch (`if (e.code === 'ENOENT')`, `!== 'ENOENT'`'s else, `['ENOENT', 'ENOTDIR'].includes`)
//     may answer anything: that is the one failure meaning "not there". A helper (`if (absent(e))`) counts only when
//     its definition is read and is such a test: the file's own, or one APPROVED_ABSENCE names in its module (whose
//     definition is checked too). Never by its name;
//   - every other way out must throw, end the process, return the error as a value (`return { ok: false, error: e }`,
//     `new Unreadable(e)`; not `!!e`, `e ? a : b` or `(log(e), true)`) or Promise.reject, or come after the error was
//     recorded for the caller: pushed, added or set into a list or map, posted to the one waiting, or set on a record,
//     with the error itself in what is recorded (a `stats.push(1)` beside it records nothing), directly or through a
//     function of the same file whose first statements record the argument it is given. A record or an exit counts
//     only where it happens whatever runs: never under `&&`, `||`, `??` or `? :`, or a helper's `if`;
//   - fsPresence's ifAbsent() passes, and a same-file function given by name (`.catch(noMarker)`) is read as the handler.
//   Logging the error and answering a success swallows it.
//   - Parse-only: a try whose only calls are JSON.parse, decodeURIComponent or new URL, with string methods inside
//     their arguments, does no I/O. One that reads and parses (`JSON.parse(readFileSync(f))`) is not parse-only.
//   - Queue bookkeeping: `p.catch(() => undefined)` where p is a const its function returns at every return, and that
//     function ends with that return, so its caller gets the failure from p itself.
//   - Anything else is an exception in tests/presenceAllow.json: the file, the function it is in and the finding's
//     whole text (whitespace as one space), with why. Each excepts one finding, and one that excepts none fails as
//     stale, so the list only shrinks.
// SCOPE names a file, or `file#function` for one function of a file whose other code the rule doesn't hold to.
import { parse } from '@babel/parser'

/** What the rule holds to: the upgrade's steps and their presence helpers, and the test area's code. */
export const SCOPE = [
  'src/main/boardFileMove.ts',
  'src/main/combworkFolder.ts',
  'src/main/combworkMove.ts',
  'src/main/combworkMoveWorker.ts',
  'src/main/fsPresence.ts',
  // fsutil's swap helpers the upgrade retires old copies with (HI-2611, HI-2612): only these functions of it.
  'src/main/fsutil.ts#cleanSwaps',
  'src/main/fsutil.ts#exists',
  'src/main/fsutil.ts#hashChecked',
  'src/main/fsutil.ts#keepAsConflict',
  'src/main/fsutil.ts#swapOut',
  'src/main/logger.ts#moveOldLogs',
  'src/main/nameUpgrade.ts',
  'src/main/nameUpgradeFiles.ts',
  'src/main/nameUpgradeProfile.ts',
  'src/main/nameUpgradeProjects.ts',
  'src/main/nameUpgradeValues.ts',
  'src/main/profileFolders.ts',
  'src/main/storedNames.ts',
  'src/shared/combworkFolderMove.ts',
  'tests/moveTestArea.mjs',
  'tests/testArea.cjs'
]

/** SCOPE's files, once each. */
export const SCOPE_FILES = [...new Set(SCOPE.map((s) => s.split('#')[0]))]

export const ALLOW_FILE = 'tests/presenceAllow.json'

/** Calls a try may hold and still be parse-only: none of them does I/O. */
const PARSE_ONLY = new Set(['JSON.parse', 'decodeURIComponent', 'URL'])
/** String methods allowed inside a parse-only call's arguments. */
const STRING_METHODS = new Set(['replace', 'replaceAll', 'trim', 'trimStart', 'trimEnd', 'slice', 'toString'])
/** fsPresence's helper whose handler passes on anything but an absence. */
const PASSES_ABSENCE = new Set(['ifAbsent'])
/** Calls that record what they are given for the caller: into a list, set or map, a message to the one waiting, a rejection. */
const RECORDS = new Set(['push', 'unshift', 'add', 'set', 'postMessage', 'reject'])
/**
 * Absence helpers another file of SCOPE may import, by module and name: each one's definition must be an absence test
 * (checkPresence reads it), so an import of one is trusted as it is.
 */
export const APPROVED_ABSENCE = { 'tests/testArea.cjs': ['absent'] }
/** The error codes that mean "not there". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** Each node's children (babel's nodes are plain objects). */
function children(node) {
  const out = []
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue
    if (Array.isArray(v)) out.push(...v.filter((c) => c && typeof c.type === 'string'))
    else if (v && typeof v.type === 'string') out.push(v)
  }
  return out
}

const isFunction = (n) => !!n && /^(ArrowFunctionExpression|FunctionExpression|FunctionDeclaration|ObjectMethod|ClassMethod|ClassPrivateMethod)$/.test(n.type)
const isCall = (n) => n.type === 'CallExpression' || n.type === 'OptionalCallExpression' || n.type === 'NewExpression'
const isMember = (n) => n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression'
/** An expression without its TypeScript wrapping and parentheses (`(e as X)`, `e!`). */
const bare = (n) => (n && /^(TSAsExpression|TSNonNullExpression|TSSatisfiesExpression|TSTypeAssertion|ParenthesizedExpression)$/.test(n.type) ? bare(n.expression) : n)

/** Walks `node`, calling `visit(n, parents)`; `into(n)` false skips a node's children. */
function walk(node, visit, parents = [], into = () => true) {
  visit(node, parents)
  if (!into(node)) return
  const next = [...parents, node]
  for (const c of children(node)) walk(c, visit, next, into)
}

/** The nodes in `node` (itself included) that `pred` picks, outside the functions nested in it. */
function own(node, pred) {
  const out = []
  walk(node, (n) => pred(n) && out.push(n), [], (n) => n === node || !isFunction(n))
  return out
}

/** A callee's name: `f`, `a.b`, `new URL`'s `URL`. */
function calleeName(c) {
  c = bare(c)
  if (!c) return ''
  if (c.type === 'Identifier') return c.name
  if (isMember(c)) return `${calleeName(c.object)}.${c.computed ? (c.property.type === 'StringLiteral' ? c.property.value : '?') : c.property.name}`
  if (isCall(c)) return `${calleeName(c.callee)}()`
  return '?'
}
const lastName = (c) => calleeName(c).split('.').at(-1)

/**
 * Whether `v` is the error as a value: the error itself, a property of it (`e.code`, `e.message`), a const holding its
 * code, String(e) or e.toString(), a `new X(…)` given it, or an object, array or template holding one; `x ?? y` or `x || y` when x is, `c ? x : y` when
 * both are. Not a value made from it: `!!e`, `e instanceof X`, `e ? a : b`, `log(e)`'s result.
 */
function carries(v, err) {
  v = bare(v)
  if (!v || !err) return false
  const names = new Set([err.name, ...(codes.get(err) ?? [])])
  if (v.type === 'Identifier') return names.has(v.name)
  if (isMember(v)) {
    let o = v
    while (isMember(bare(o))) o = bare(o).object
    return bare(o)?.type === 'Identifier' && bare(o).name === err.name
  }
  if (v.type === 'ObjectExpression') return v.properties.some((p) => (p.type === 'ObjectProperty' ? carries(p.value, err) : p.type === 'SpreadElement' && carries(p.argument, err)))
  if (v.type === 'ArrayExpression') return v.elements.some((x) => x && carries(x.type === 'SpreadElement' ? x.argument : x, err))
  if (v.type === 'TemplateLiteral') return v.expressions.some((x) => carries(x, err))
  // `e.code ?? 'error'`, `e.code || e.message`: the error's when its left side is (the right only stands in for it).
  if (v.type === 'LogicalExpression' && (v.operator === '??' || v.operator === '||')) return carries(v.left, err)
  if (v.type === 'ConditionalExpression') return carries(v.consequent, err) && carries(v.alternate, err)
  if (v.type === 'CallExpression' && calleeName(v.callee) === 'String' && v.arguments.length === 1) return carries(v.arguments[0], err)
  // The error wrapped in a value of its own: `new Unreadable(e)`, `new Error(why, { cause: e })`.
  if (v.type === 'NewExpression') return v.arguments.some((a) => carries(a, err))
  if (v.type === 'CallExpression' && isMember(v.callee) && lastName(v.callee) === 'toString' && !v.arguments.length) return carries(v.callee.object, err)
  return false
}

/**
 * The calls an expression makes whatever happens: the expression itself, or each of a sequence, under await or void,
 * or an assignment's right side. Never one under `&&`, `||`, `??` or `? :`, an argument, or a nested function.
 */
function sureCalls(expr) {
  expr = bare(expr)
  if (!expr) return []
  if (isCall(expr)) return [expr]
  if (expr.type === 'AwaitExpression') return sureCalls(expr.argument)
  if (expr.type === 'UnaryExpression' && expr.operator === 'void') return sureCalls(expr.argument)
  if (expr.type === 'SequenceExpression') return expr.expressions.flatMap(sureCalls)
  if (expr.type === 'AssignmentExpression') return sureCalls(expr.right)
  return []
}

/** The ways the file's own functions are known, by name. */
function localFunctions(program) {
  const local = new Map()
  walk(program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) local.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFunction(n.init)) local.set(n.id.name, n.init)
  })
  return local
}

/** Whether a function records its `i`th parameter: a RECORDS call with it in what is recorded. */
function recordsParam(f, i) {
  const p = f.params[i]
  const name = p?.type === 'Identifier' ? p.name : p?.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : null
  if (!name) return false
  const param = { name }
  const recordsIt = (x) => sureCalls(x).some((c) => RECORDS.has(lastName(c.callee)) && c.arguments.some((a) => carries(a, param)))
  if (f.body.type !== 'BlockStatement') return recordsIt(f.body)
  // Its statements in order, up to the first that may leave: one of them records it, whatever its other code does.
  for (const st of f.body.body) {
    if (st.type === 'ExpressionStatement' && recordsIt(st.expression)) return true
    if (st.type === 'ReturnStatement') return !!st.argument && recordsIt(st.argument)
    if (st.type !== 'ExpressionStatement' && st.type !== 'VariableDeclaration') return false
  }
  return false
}

/** Whether `expr` records the error for the caller (see the header), directly or through a function of the file. */
function records(expr, err, local) {
  if (!err) return false
  for (const c of sureCalls(expr)) {
    if (RECORDS.has(lastName(c.callee)) && c.arguments.some((a) => carries(a, err))) return true
    const f = bare(c.callee)?.type === 'Identifier' ? local.get(bare(c.callee).name) : null
    if (f && c.arguments.some((a, i) => carries(a, err) && recordsParam(f, i))) return true
  }
  // `result.error = e`, as a statement (not under && or ? :).
  const x = bare(expr)
  return x?.type === 'AssignmentExpression' && x.operator === '=' && isMember(x.left) && carries(x.right, err)
}

/** Whether `expr` ends the process whatever happens: process.exit, not under && or ? :. */
const ends = (expr) => sureCalls(expr).some((c) => calleeName(c.callee) === 'process.exit')

/** The error's names in a handler: its binding, and the consts holding its code (`const code = (e as X).code`). */
const codes = new WeakMap()
/** `x.code` (through `?.`, casts and `?? ''`) with x the error, or a const holding it. */
const isCodeOf = (n, err) => {
  n = bare(n)
  if (n?.type === 'LogicalExpression' && n.operator === '??' && n.right.type === 'StringLiteral') n = bare(n.left)
  if (n?.type === 'Identifier') return codes.get(err)?.has(n.name) ?? false
  return !!n && isMember(n) && !n.computed && n.property.name === 'code' && bare(n.object)?.type === 'Identifier' && bare(n.object).name === err.name
}
/** A handler's error: its binding's name and the absence helpers trusted there, as an object the consts holding its code are kept by. */
const errName = (name, trusted = new Set()) => (name ? { name, trusted } : null)

/**
 * Whether a condition tests for the absence: 'then' when its true branch is the absence's, 'else' when its false one
 * is, null when it isn't such a test (or tests something beside it).
 */
function absenceTest(t, err) {
  t = bare(t)
  if (!t || !err) return null
  if (t.type === 'UnaryExpression' && t.operator === '!') {
    const inner = absenceTest(t.argument, err)
    return inner === 'then' ? 'else' : inner === 'else' ? 'then' : null
  }
  // A helper only when its definition was read and found to be an absence test (absenceHelpers), never by its name.
  if (isCall(t) && bare(t.callee)?.type === 'Identifier' && err.trusted?.has(bare(t.callee).name) && t.arguments.length === 1 && bare(t.arguments[0])?.type === 'Identifier' && bare(t.arguments[0]).name === err.name) return 'then'
  // ['ENOENT', 'ENOTDIR'].includes(e.code ?? '')
  if (isCall(t) && isMember(t.callee) && lastName(t.callee) === 'includes' && bare(t.callee.object)?.type === 'ArrayExpression' && t.arguments.length === 1 && isCodeOf(t.arguments[0], err)) {
    const els = bare(t.callee.object).elements
    if (els.length && els.every((x) => x?.type === 'StringLiteral' && ABSENT_CODES.has(x.value))) return 'then'
  }
  if (t.type === 'BinaryExpression' && /^[!=]==?$/.test(t.operator)) {
    const [a, b] = isCodeOf(t.left, err) ? [t.left, t.right] : [t.right, t.left]
    if (isCodeOf(a, err) && b.type === 'StringLiteral' && ABSENT_CODES.has(b.value)) return t.operator.startsWith('=') ? 'then' : 'else'
  }
  if (t.type === 'LogicalExpression' && t.operator === '||' && absenceTest(t.left, err) === 'then' && absenceTest(t.right, err) === 'then') return 'then'
  if (t.type === 'LogicalExpression' && t.operator === '&&' && absenceTest(t.left, err) === 'else' && absenceTest(t.right, err) === 'else') return 'else'
  return null
}

/** Whether a value given back passes the failure on: the error in it, or Promise.reject. */
function passingValue(v, err, rec, local) {
  v = bare(v)
  if (!v) return rec
  if (v.type === 'AwaitExpression') return passingValue(v.argument, err, rec, local)
  if (isCall(v) && calleeName(v.callee) === 'Promise.reject') return true
  if (v.type === 'SequenceExpression') {
    const r = rec || v.expressions.slice(0, -1).some((x) => records(x, err, local)) || v.expressions.slice(0, -1).some(ends)
    return passingValue(v.expressions.at(-1), err, r, local)
  }
  if (v.type === 'ConditionalExpression') {
    const a = absenceTest(v.test, err)
    return (a === 'then' || passingValue(v.consequent, err, rec, local)) && (a === 'else' || passingValue(v.alternate, err, rec, local))
  }
  if (v.type === 'UnaryExpression' && v.operator === 'void') return rec || records(v.argument, err, local) || ends(v.argument)
  if (isCall(v)) return rec || records(v, err, local) || ends(v) || carries(v, err)
  return rec || carries(v, err)
}

/**
 * The ways out of a statement: { ok } no way out swallows, { falls } it may go on to the next, { rec } the error is
 * recorded on every way that goes on.
 */
function flow(s, err, rec, local) {
  if (!s) return { ok: true, falls: true, rec }
  switch (s.type) {
    case 'BlockStatement': {
      let st = { ok: true, falls: true, rec }
      for (const x of s.body) {
        if (!st.falls) break
        const r = flow(x, err, st.rec, local)
        st = { ok: st.ok && r.ok, falls: r.falls, rec: r.rec }
      }
      return st
    }
    case 'ThrowStatement':
      return { ok: true, falls: false, rec }
    case 'ReturnStatement':
      return { ok: passingValue(s.argument, err, rec, local), falls: false, rec }
    case 'ContinueStatement':
    case 'BreakStatement':
      return { ok: rec, falls: false, rec }
    case 'ExpressionStatement':
      if (ends(s.expression)) return { ok: true, falls: false, rec }
      return { ok: true, falls: true, rec: rec || records(s.expression, err, local) }
    case 'VariableDeclaration':
      if (err && s.kind === 'const') for (const d of s.declarations) if (d.id.type === 'Identifier' && d.init && isCodeOf(d.init, err)) codes.set(err, new Set([...(codes.get(err) ?? []), d.id.name]))
      return { ok: true, falls: true, rec: rec || s.declarations.some((d) => d.init && records(d.init, err, local)) }
    case 'EmptyStatement':
      return { ok: true, falls: true, rec }
    case 'IfStatement': {
      const a = absenceTest(s.test, err)
      const absent = { ok: true, falls: false, rec }
      const t = a === 'then' ? absent : flow(s.consequent, err, rec, local)
      const e = a === 'else' ? absent : s.alternate ? flow(s.alternate, err, rec, local) : { ok: true, falls: true, rec }
      return { ok: t.ok && e.ok, falls: t.falls || e.falls, rec: (!t.falls || t.rec) && (!e.falls || e.rec) }
    }
    case 'TryStatement': {
      // Its own catch is a finding of its own; what it records holds only if its block and its catch both go on recorded.
      const b = flow(s.block, err, rec, local)
      const h = s.handler ? flow(s.handler.body, err, rec, local) : { ok: true, falls: false, rec }
      const f = s.finalizer ? flow(s.finalizer, err, rec, local) : { ok: true, falls: true, rec }
      return { ok: b.ok && h.ok && f.ok, falls: (b.falls || h.falls) && f.falls, rec: ((!b.falls || b.rec) && (!h.falls || h.rec)) || f.rec }
    }
    default:
      // A loop, a switch, a label: not followed here, so not taken to pass anything on.
      return { ok: false, falls: true, rec }
  }
}

/** Whether a handler (a function, or a catch clause's body and binding) passes the failure on by every way out. */
function handles(body, name, local, trusted) {
  const err = errName(name, trusted)
  if (body.type !== 'BlockStatement') return passingValue(body, err, false, local)
  const r = flow(body, err, false, local)
  return r.ok && (!r.falls || r.rec)
}

/** Whether a function is an absence test of its first parameter: `(e) => e?.code === 'ENOENT' || …`, or consts of its code then one such return. */
function isAbsenceTest(f) {
  const p = f.params[0]
  if (f.params.length !== 1 || p?.type !== 'Identifier') return false
  const e = errName(p.name)
  if (f.body.type !== 'BlockStatement') return absenceTest(f.body, e) === 'then'
  const body = f.body.body
  for (const st of body.slice(0, -1)) {
    if (st.type !== 'VariableDeclaration' || st.kind !== 'const') return false
    for (const d of st.declarations) {
      if (d.id.type !== 'Identifier' || !d.init || !isCodeOf(d.init, e)) return false
      codes.set(e, new Set([...(codes.get(e) ?? []), d.id.name]))
    }
  }
  const last = body.at(-1)
  return last?.type === 'ReturnStatement' && absenceTest(last.argument, e) === 'then'
}

/**
 * The absence helpers trusted in a file: its own functions whose definition is an absence test, and those it imports by
 * name from a module APPROVED_ABSENCE names (whose definition checkPresence reads too). Never one by its name alone.
 */
function absenceHelpers(file, program, local) {
  const trusted = new Set([...local].filter(([, f]) => isAbsenceTest(f)).map(([n]) => n))
  const dir = file.split('/').slice(0, -1)
  const resolve = (spec) => {
    if (typeof spec !== 'string' || !spec.startsWith('.')) return null
    const parts = [...dir]
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    }
    return parts.join('/')
  }
  const approve = (from, imported, as) => {
    if ((APPROVED_ABSENCE[resolve(from)] ?? []).includes(imported)) trusted.add(as)
  }
  walk(program, (n) => {
    if (n.type === 'ImportDeclaration') for (const sp of n.specifiers) if (sp.type === 'ImportSpecifier') approve(n.source.value, sp.imported.name ?? sp.imported.value, sp.local.name)
    const init = bare(n.type === 'VariableDeclarator' ? n.init : null)
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && init && isCall(init) && calleeName(init.callee) === 'require' && init.arguments[0]?.type === 'StringLiteral') {
      for (const pr of n.id.properties) if (pr.type === 'ObjectProperty' && pr.key.type === 'Identifier' && pr.value.type === 'Identifier') approve(init.arguments[0].value, pr.key.name, pr.value.name)
    }
  })
  return trusted
}

/** Whether a try's block is parse-only: each call in it JSON.parse and the like, or a string method inside one's arguments. */
function parseOnly(block) {
  const calls = own(block, isCall)
  if (!calls.length) return false
  const inside = new Set()
  for (const c of calls) if (PARSE_ONLY.has(calleeName(c.callee))) for (const a of c.arguments) for (const n of own(a, isCall)) inside.add(n)
  return calls.every((c) => PARSE_ONLY.has(calleeName(c.callee)) || (inside.has(c) && isMember(c.callee) && STRING_METHODS.has(lastName(c.callee))))
}

/** Queue bookkeeping (see the header): `call` is `p.catch(…)` with p a const its function returns at every return, ending with it. */
function bookkeeping(call, parents) {
  const p = bare(call.callee.object)
  const outer = [...parents].reverse().find(isFunction)
  if (p?.type !== 'Identifier' || !outer || outer.body.type !== 'BlockStatement') return false
  const constP = own(outer.body, (n) => n.type === 'VariableDeclaration' && n.kind === 'const' && n.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === p.name)).length === 1
  const returns = own(outer.body, (n) => n.type === 'ReturnStatement')
  const last = outer.body.body.at(-1)
  return constP && returns.length > 0 && returns.every((r) => bare(r.argument)?.type === 'Identifier' && bare(r.argument).name === p.name) && last?.type === 'ReturnStatement'
}

/** The name of the function a node is in (the innermost named one), or '(top)'. */
function functionOf(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const n = parents[i]
    if (n.type === 'FunctionDeclaration' && n.id) return n.id.name
    if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod' || n.type === 'ClassPrivateMethod') && n.key) return n.key.name ?? n.key.id?.name ?? '?'
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFunction(n.init)) return n.id.name
  }
  return '(top)'
}

/** The names of every function a node is in, outermost first. */
function functionsOf(parents) {
  const out = []
  for (let i = 0; i < parents.length; i++) {
    const n = parents[i]
    if (n.type === 'FunctionDeclaration' && n.id) out.push(n.id.name)
    else if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod') && n.key?.name) out.push(n.key.name)
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFunction(n.init)) out.push(n.id.name)
  }
  return out
}

/** A finding: { file, line, rule, fn, text, full }: `full` the node's source on one line (after `head`), `text` shortened. */
function finding(file, src, node, parents, rule, head = '') {
  const full = `${head}${src.slice(node.start, node.end)}${head ? ')' : ''}`.replace(/\s+/g, ' ')
  return { file, line: node.loc.start.line, at: node.start, rule, fn: functionOf(parents), within: functionsOf(parents), text: full.length > 160 ? `${full.slice(0, 159)}…` : full, full }
}

/** The rule over one file's source: its findings, in source order. */
export function presenceFindings(file, src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['typescript'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  const out = []
  const named = new Set()
  const local = localFunctions(ast.program)
  const trusted = absenceHelpers(file, ast.program, local)
  const handler = (arg, call, parents, kind) => {
    let fn = bare(arg)
    if (isCall(fn) && PASSES_ABSENCE.has(calleeName(fn.callee))) return
    if (fn.type === 'Identifier' && local.has(fn.name)) fn = local.get(fn.name)
    const head = `${calleeName(call.callee.object)}${kind}(`
    if (!isFunction(fn)) {
      out.push(finding(file, src, arg, parents, `${kind}: a handler this rule can't read`, head))
      return
    }
    const err = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null
    if (handles(fn.body, err, local, trusted)) return
    if (kind === '.catch' && bookkeeping(call, parents)) return
    out.push(finding(file, src, arg, parents, `${kind}: swallows the error`, head))
  }
  walk(ast.program, (n, parents) => {
    // Once a place: an import's specifier holds the name twice (imported and local), at the same place.
    if (((n.type === 'Identifier' && n.name === 'existsSync') || (n.type === 'StringLiteral' && n.value === 'existsSync')) && !named.has(n.start)) {
      named.add(n.start)
      out.push(finding(file, src, n, parents, 'existsSync'))
    }
    if (n.type === 'TryStatement' && n.handler && !parseOnly(n.block)) {
      const err = n.handler.param?.type === 'Identifier' ? n.handler.param.name : null
      if (!handles(n.handler.body, err, local, trusted)) out.push(finding(file, src, n.handler, [...parents, n], 'catch: swallows the error'))
    }
    if (isCall(n) && isMember(n.callee) && !n.callee.computed) {
      const m = n.callee.property.name
      if (m === 'catch' && n.arguments[0]) handler(n.arguments[0], n, parents, '.catch')
      if (m === 'then' && n.arguments[1]) handler(n.arguments[1], n, parents, '.then')
    }
  })
  return out.sort((x, y) => x.at - y.at)
}

/**
 * The rule over SCOPE-like entries: { findings, problems }. `read(file)` gives a file's text (null when it isn't there).
 * `exceptions` are { file, in, node, why }: each excepts one finding of that file, in that function, whose whole text
 * is `node`; one that excepts none is a problem (stale).
 */
export function checkPresence({ scope, read, exceptions, approved = APPROVED_ABSENCE }) {
  const findings = []
  const used = new Set()
  const files = new Map()
  for (const s of scope) {
    const [file, fn] = s.split('#')
    if (!files.has(file)) files.set(file, [])
    files.get(file).push(fn ?? null)
  }
  for (const [file, fns] of files) {
    const src = read(file)
    if (src === null) {
      findings.push({ file, line: 0, rule: 'scope', fn: '(top)', text: "isn't there: SCOPE names it" })
      continue
    }
    const found = presenceFindings(file, src)
    // A function SCOPE names must be there, or the entry holds nothing.
    for (const fn of fns) if (fn && !new RegExp(`\\bfunction ${fn}\\b|\\b(?:const|let) ${fn}\\b`).test(src)) findings.push({ file, line: 0, rule: 'scope', fn, text: `has no function ${fn}: SCOPE names it` })
    for (const f of found) {
      if (!fns.includes(null) && !fns.some((fn) => f.within.includes(fn))) continue
      const i = exceptions.findIndex((e, k) => !used.has(k) && e.file === file && e.in === f.fn && e.node === f.full)
      if (i >= 0) used.add(i)
      else findings.push({ file: f.file, line: f.line, rule: f.rule, fn: f.fn, text: f.text })
    }
  }
  const problems = exceptions.flatMap((e, i) => (used.has(i) ? [] : [`exception ${i} (${e.file}, ${e.in}) excepts nothing: remove it`]))
  for (const [file, names] of Object.entries(approved)) {
    const src = read(file)
    const local = src === null ? new Map() : localFunctions(parse(src, { sourceType: 'unambiguous', plugins: ['typescript'] }).program)
    for (const n of names) if (!local.has(n) || !isAbsenceTest(local.get(n))) problems.push(`${file}: ${n}, an approved absence helper, isn't an absence test (ENOENT or ENOTDIR only)`)
  }
  return { findings, problems }
}
