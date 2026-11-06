// The presence-check rule (HI-2617, after HI-2612): in the one-way upgrade's code and the test area's, only an absence
// (ENOENT: src/main/fsPresence.ts, and the test area's own absent()) answers "not there", and an I/O failure is never
// taken for a result. Read from each file's syntax tree, not its text:
//
// - existsSync, by any name (imported under another, `fs.existsSync`, `fs['existsSync']`): it answers false for access
//   denied or a held file as it does for an absence. Use fsPresence's present()/lstatOrNull(), or the error's code.
// - A handler that swallows: a `catch` clause, or the function given to `.catch(f)` or as `.then(ok, f)`'s second, that
//   passes nothing on. It passes the failure on when it (or a function of the same file it calls) throws, calls
//   Promise.reject or reject(), ends the process, records it (push, add or set into a list or map, postMessage to
//   the one waiting), puts the error in what it returns (`(e) => ({ ok: false, error: e })`), or sets it on a record; or
//   when it is fsPresence's ifAbsent(). Logging the error and returning a success swallows it: `(e) => (log(e), true)`.
//   - Parse-only: a try whose only calls are JSON.parse, decodeURIComponent or new URL, with string methods inside
//     their arguments, does no I/O. One that reads and parses (`JSON.parse(readFileSync(f))`) is not parse-only.
//   - Queue bookkeeping: `p.catch(() => undefined)` on a promise its function returns, so its caller gets the failure
//     from `p` itself.
//   - A function of the same file given by name (`.catch(noMarker)`) is read as the handler.
//   - Anything else is an exception in tests/presenceAllow.json, by file and its exact text, with why; an exception that
//     excepts nothing fails as stale, so the list only shrinks.
import { parse } from '@babel/parser'

/** The files the rule holds to: the upgrade's steps and their presence helpers, and the test area's code. */
export const SCOPE = [
  'src/main/boardFileMove.ts',
  'src/main/combworkFolder.ts',
  'src/main/combworkMove.ts',
  'src/main/combworkMoveWorker.ts',
  'src/main/fsPresence.ts',
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

export const ALLOW_FILE = 'tests/presenceAllow.json'

/** Calls a try may hold and still be parse-only: none of them does I/O. */
const PARSE_ONLY = new Set(['JSON.parse', 'decodeURIComponent', 'URL'])
/** String methods allowed inside a parse-only call's arguments. */
const STRING_METHODS = new Set(['replace', 'replaceAll', 'trim', 'trimStart', 'trimEnd', 'slice', 'toString'])
/** fsPresence's helper whose handler passes on anything but an absence. */
const PASSES_ABSENCE = new Set(['ifAbsent'])
/** Calls that record a failure for the caller: into a list, set or map, or a message to the one waiting. */
const RECORDS = new Set(['push', 'unshift', 'add', 'set', 'postMessage'])
/** Calls that pass a failure on or end the run. */
const ENDS = new Set(['Promise.reject', 'reject', 'process.exit'])

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
  if (!c) return ''
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') return `${calleeName(c.object)}.${c.computed ? (c.property.type === 'StringLiteral' ? c.property.value : '?') : c.property.name}`
  if (c.type === 'TSNonNullExpression' || c.type === 'TSAsExpression' || c.type === 'TSSatisfiesExpression') return calleeName(c.expression)
  return '?'
}
const lastName = (c) => calleeName(c).split('.').at(-1)

/** Whether the identifier `name` is used in `node`. */
const uses = (node, name) => !!name && own(node, (n) => n.type === 'Identifier' && n.name === name).length > 0

/** Whether a function's body (its error's binding `err`) passes the failure on; `local` is the file's functions by name. */
function passesOn(body, err, local, seen = new Set()) {
  if (own(body, (n) => n.type === 'ThrowStatement').length) return true
  const calls = own(body, isCall)
  if (calls.some((c) => ENDS.has(calleeName(c.callee)) || RECORDS.has(lastName(c.callee)))) return true
  // A function of this file it calls, read the same way.
  for (const c of calls) {
    const f = c.callee.type === 'Identifier' ? local.get(c.callee.name) : null
    if (f && !seen.has(f) && (seen.add(f), passesOn(f.body, f.params[0]?.name, local, seen))) return true
  }
  if (!err) return false
  // The error in the value it gives back: not only beside it (`(log(e), true)` gives true).
  const value = (v) => {
    if (!v) return false
    if (v.type === 'SequenceExpression') return value(v.expressions.at(-1))
    if (v.type === 'ConditionalExpression') return value(v.consequent) || value(v.alternate)
    if (v.type === 'AwaitExpression') return value(v.argument)
    if (isCall(v)) return false
    return uses(v, err)
  }
  if (body.type !== 'BlockStatement') return value(body)
  if (own(body, (n) => n.type === 'ReturnStatement').some((r) => value(r.argument))) return true
  return own(body, (n) => n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && uses(n.right, err)).length > 0
}

/** Whether a try's block is parse-only: each call in it JSON.parse and the like, or a string method inside one's arguments. */
function parseOnly(block) {
  const calls = own(block, isCall)
  if (!calls.length) return false
  const inside = new Set()
  for (const c of calls) if (PARSE_ONLY.has(calleeName(c.callee))) for (const a of c.arguments) for (const n of own(a, isCall)) inside.add(n)
  return calls.every((c) => PARSE_ONLY.has(calleeName(c.callee)) || (inside.has(c) && c.callee.type === 'MemberExpression' && STRING_METHODS.has(lastName(c.callee))))
}

/** A finding: { file, line, rule, text, full }: the node's own source on one line (`text` shortened), after `head`. */
function finding(file, src, node, rule, head = '') {
  const full = `${head}${src.slice(node.start, node.end)}${head ? ')' : ''}`.replace(/\s+/g, ' ')
  return { file, line: node.loc.start.line, at: node.start, rule, text: full.length > 160 ? `${full.slice(0, 159)}…` : full, full }
}

/** The rule over one file's source: its findings. */
export function presenceFindings(file, src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['typescript'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  const out = []
  const named = new Set()
  const local = new Map()
  walk(ast.program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) local.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFunction(n.init)) local.set(n.id.name, n.init)
  })
  const handler = (arg, call, parents, kind) => {
    let fn = arg
    if (isCall(fn) && PASSES_ABSENCE.has(calleeName(fn.callee))) return
    if (fn.type === 'Identifier' && local.has(fn.name)) fn = local.get(fn.name)
    if (!isFunction(fn)) {
      out.push(finding(file, src, arg, `${kind}: a handler this rule can't read`))
      return
    }
    const err = fn.params[0]?.type === 'Identifier' ? fn.params[0].name : null
    if (passesOn(fn.body, err, local)) return
    // Queue bookkeeping: the receiver is a promise its function returns, so the caller gets the failure from it.
    const receiver = call.callee.object
    const outer = [...parents].reverse().find(isFunction)
    if (kind === '.catch' && receiver?.type === 'Identifier' && outer && own(outer.body, (n) => n.type === 'ReturnStatement').some((r) => r.argument?.type === 'Identifier' && r.argument.name === receiver.name)) return
    out.push(finding(file, src, arg, `${kind}: swallows the error`, `${calleeName(receiver)}${kind}(`))
  }
  walk(ast.program, (n, parents) => {
    // Once a place: an import's specifier holds the name twice (imported and local), at the same place.
    if (((n.type === 'Identifier' && n.name === 'existsSync') || (n.type === 'StringLiteral' && n.value === 'existsSync')) && !named.has(n.start)) {
      named.add(n.start)
      out.push(finding(file, src, n, 'existsSync'))
    }
    if (n.type === 'TryStatement' && n.handler && !parseOnly(n.block)) {
      const err = n.handler.param?.type === 'Identifier' ? n.handler.param.name : null
      if (!passesOn(n.handler.body, err, local)) out.push(finding(file, src, n.handler, 'catch: swallows the error'))
    }
    if (isCall(n) && (n.callee.type === 'MemberExpression' || n.callee.type === 'OptionalMemberExpression') && !n.callee.computed) {
      const m = n.callee.property.name
      if (m === 'catch' && n.arguments[0]) handler(n.arguments[0], n, parents, '.catch')
      if (m === 'then' && n.arguments[1]) handler(n.arguments[1], n, parents, '.then')
    }
  })
  return out.sort((x, y) => x.at - y.at)
}

/**
 * The rule over the files: { findings, problems }. `read(file)` gives a file's text (null when it isn't there).
 * `exceptions` are { file, text, why }: a finding of that file whose text holds `text` is excepted; an exception that
 * excepts nothing is a problem (stale).
 */
export function checkPresence({ files, read, exceptions }) {
  const findings = []
  const used = new Set()
  for (const file of files) {
    const src = read(file)
    if (src === null) {
      findings.push({ file, line: 0, rule: 'scope', text: "isn't there: SCOPE names it" })
      continue
    }
    for (const f of presenceFindings(file, src)) {
      const i = exceptions.findIndex((e) => e.file === file && f.full.includes(e.text))
      if (i >= 0) used.add(i)
      else findings.push({ file: f.file, line: f.line, rule: f.rule, text: f.text })
    }
  }
  const problems = exceptions.flatMap((e, i) => (used.has(i) ? [] : [`exception ${i} (${e.file}: ${e.text}) excepts nothing: remove it`]))
  return { findings, problems }
}
