// The presence-check rule (HI-2617, after HI-2612): in the one-way upgrade's code and the test area's, only an absence
// answers "not there", and an I/O failure is never taken for a result. It catches honest mistakes in ordinary code
// (Darren's decision, 6 Nov): a bare existsSync, a catch or promise handler added without thought. It doesn't try to
// defeat code written to evade it, and doesn't judge whether a handler passes the failure on: that is proved by the
// I/O-failure tests (tests/upgradeIoFailures.test.ts) and by review. It is closed: in SCOPE, each of these must be one
// of three things, or it fails.
//
// - existsSync, by any name (imported under another, `fs.existsSync`, `fs['existsSync']`): it answers false for access
//   denied or a held file as for an absence. Use fsPresence's present()/lstatOrNull().
// - Each `catch` clause, and the function given to `.catch(f)` or as `.then(ok, f)`'s second (dotted, optional or in
//   brackets: `p['catch'](f)`; a method named only at run time, `p[name](f)`, is a finding of its own):
//   1. a rethrow: its body (a block) ends in `throw`, with no return, continue or break anywhere in it;
//   2. for `.catch`/`.then`, a call of fsPresence's ifAbsent(): its callee resolved by the parser's scopes to the import
//      from src/main/fsPresence (a parameter, local, named function expression, class or catch binding of that name
//      where it is called, or one from another module, isn't it);
//   3. an exception in tests/presenceAllow.json: the file, the function it is in and the finding's whole text (whitespace
//      as one space), with why. Each excepts one finding, and one that excepts none fails as stale, so the list only
//      shrinks. Whether such a handler really passes the failure on is for its reviewer and the I/O-failure tests
//      (tests/upgradeIoFailures.test.ts), not this rule.
// SCOPE names a file, or `file#function` for one function of a file whose other code the rule doesn't hold to.
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'

const traverse = traverseModule.default ?? traverseModule

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

/** The module whose ifAbsent is the one handler factory the rule takes as it is. */
const FS_PRESENCE = 'src/main/fsPresence'

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

/** A callee's name: `f`, `a.b`, `f()` for a call's. */
function calleeName(c) {
  c = bare(c)
  if (!c) return ''
  if (c.type === 'Identifier') return c.name
  if (isMember(c)) return `${calleeName(c.object)}.${memberName(c) ?? '?'}`
  if (isCall(c)) return `${calleeName(c.callee)}()`
  return '?'
}

/** A member's property name: `p.catch`, `p?.catch`, `p['catch']`, ``p[`catch`]``; null when it is known only at run time. */
function memberName(m) {
  if (!m.computed) return m.property.name ?? null
  const k = bare(m.property)
  if (k.type === 'StringLiteral') return k.value
  if (k.type === 'TemplateLiteral' && !k.expressions.length) return k.quasis[0].value.cooked
  return null
}

/** Whether a block is a rethrow: it ends in `throw`, and nothing in it returns, continues or breaks. */
function rethrows(body) {
  if (body?.type !== 'BlockStatement' || body.body.at(-1)?.type !== 'ThrowStatement') return false
  return own(body, (n) => n.type === 'ReturnStatement' || n.type === 'ContinueStatement' || n.type === 'BreakStatement').length === 0
}

/**
 * The calls of fsPresence's ifAbsent in a file: each `ifAbsent(…)` whose callee, as the parser's own scopes resolve it
 * (@babel/traverse), is bound by an import of `ifAbsent` from FS_PRESENCE (resolved from the file's folder, under any
 * alias). Any other binding of that name where the call is (a parameter, a local, a named function expression, a
 * class, a catch binding, a require) is a different function, and its call isn't one of these.
 */
function ifAbsentCalls(file, ast) {
  const dir = file.split('/').slice(0, -1)
  const resolve = (spec) => {
    if (typeof spec !== 'string' || !spec.startsWith('.')) return null
    const parts = [...dir]
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    }
    return parts.join('/').replace(/\.[cm]?[jt]s$/, '')
  }
  const calls = new Set()
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee
      if (callee.type !== 'Identifier') return
      const binding = path.scope.getBinding(callee.name)
      const spec = binding?.path
      if (binding?.kind !== 'module' || !spec?.isImportSpecifier()) return
      const imported = spec.node.imported
      if ((imported.name ?? imported.value) !== 'ifAbsent' || resolve(spec.parent.source.value) !== FS_PRESENCE) return
      calls.add(path.node)
    }
  })
  return calls
}

/** The names of every named function a node is in, outermost first. */
function functionsOf(parents) {
  const out = []
  for (const n of parents) {
    if (n.type === 'FunctionDeclaration' && n.id) out.push(n.id.name)
    else if ((n.type === 'ClassMethod' || n.type === 'ObjectMethod' || n.type === 'ClassPrivateMethod') && n.key) out.push(n.key.name ?? n.key.id?.name ?? '?')
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFunction(n.init)) out.push(n.id.name)
  }
  return out
}

/** A finding: { file, line, rule, fn, within, text, full }: `full` the node's source on one line (after `head`), `text` shortened. */
function finding(file, src, node, parents, rule, head = '') {
  const full = `${head}${src.slice(node.start, node.end)}${head ? ')' : ''}`.replace(/\s+/g, ' ')
  const within = functionsOf(parents)
  return { file, line: node.loc.start.line, at: node.start, rule, fn: within.at(-1) ?? '(top)', within, text: full.length > 160 ? `${full.slice(0, 159)}…` : full, full }
}

/** The rule over one file's source: its findings, in source order. */
export function presenceFindings(file, src) {
  const ast = parse(src, { sourceType: 'unambiguous', plugins: ['typescript'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  const out = []
  const named = new Set()
  const ifAbsent = ifAbsentCalls(file, ast)
  const handler = (arg, call, parents, kind) => {
    const fn = bare(arg)
    if (ifAbsent.has(fn)) return
    if (isFunction(fn) && rethrows(fn.body)) return
    out.push(finding(file, src, arg, parents, `${kind}: not a rethrow or fsPresence's ifAbsent`, `${calleeName(call.callee.object)}${kind}(`))
  }
  walk(ast.program, (n, parents) => {
    // Once a place: an import's specifier holds the name twice (imported and local), at the same place.
    if (((n.type === 'Identifier' && n.name === 'existsSync') || (n.type === 'StringLiteral' && n.value === 'existsSync')) && !named.has(n.start)) {
      named.add(n.start)
      out.push(finding(file, src, n, parents, 'existsSync'))
    }
    if (n.type === 'CatchClause' && !rethrows(n.body)) out.push(finding(file, src, n, parents, 'catch: not a rethrow'))
    if (isCall(n) && isMember(n.callee)) {
      const m = memberName(n.callee)
      if (m === 'catch' && n.arguments[0]) handler(n.arguments[0], n, parents, '.catch')
      if (m === 'then' && n.arguments[1]) handler(n.arguments[1], n, parents, '.then')
      // A method named only at run time (`p[name](f)`) could be either: a finding, like any handler the rule can't name.
      if (m === null && n.arguments.length) out.push(finding(file, src, n, parents, 'a call by a computed name'))
    }
  })
  return out.sort((x, y) => x.at - y.at)
}

/**
 * The rule over SCOPE-like entries: { findings, problems }. `read(file)` gives a file's text (null when it isn't there).
 * `exceptions` are { file, in, node, why }: each excepts one finding of that file, in that function, whose whole text
 * is `node`; one that excepts none is a problem (stale).
 */
export function checkPresence({ scope, read, exceptions }) {
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
  return { findings, problems }
}
