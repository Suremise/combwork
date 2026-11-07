// The WorkspaceService rule (HI-2678, Darren's R2): a WorkspaceService, a view of one or a value whose type holds one
// never goes where its type is lost (any, unknown, an index signature, a cast, a slot that drops it), and is never
// reached by a key the code doesn't spell (a computed key, a spread, for-in). With the rule holding, every use of one
// of its members spells the member's name somewhere in the program, so test selection finds a member's consumers by
// name (affectedUnits.mjs, relatedTests.mjs): a name search can only over-select.
//
// The census reads a revision's whole tsconfig.node.json program with TypeScript 5.9's in-process checker
// (`typescript-classic`: TypeScript 7's API runs out of process and its types weren't reliable for this, HI-2678/s38).
// What it can't prove fails closed: a program error anywhere, a file of the rule's scope missing from the program, a
// type walk past its budget, a compiler that throws.
//   - In the rule's scope (src/main, preload, shared) an escape breaks the rule, but for the `workspace` Proxy's own
//     (its handlers forward by the name its caller spelled; bound to its reviewed tokens, PROXY_HASH) and those of the
//     exact audited trees in AUDITED.
//   - Elsewhere in the program (tests, their helpers, configs) an escape doesn't break it: it pins that file, and every
//     unit test reaching it is kept for any change to a member (relatedTests.mjs).
// check:repo runs it (workspaceRuleCheck.mjs) on the working tree when a change touches one of its inputs (ruleInput).
// tests/workspaceRule.test.ts checks each rule.
import { parse } from '@babel/parser'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { importGraph } from './relatedTests.mjs'

const require = createRequire(import.meta.url)
const runContext = require('./runContext.cjs')

export const CLASS_FILE = 'src/main/workspace.ts'
export const CLASS_NAME = 'WorkspaceService'
export const PROXY_NAME = 'workspace'
/** Where an escape breaks the rule: what runs in the app. */
export const RULE_SCOPE = ['src/main/', 'src/preload/', 'src/shared/']
/** The program censused: the one typecheck builds for main, preload, shared and the tests. */
export const TSCONFIG = 'tsconfig.node.json'
/** The `workspace` Proxy's initializer as reviewed (proxyOf's hash): any edit to it fails the rule until reviewed. */
export const PROXY_HASH = '4f6c377e9b498404'
/** Type visits a revision's census may make before it gives up (fail closed): about ten times this tree's (15.7M, 7 Nov). */
export const WORK_BUDGET = 160_000_000
/** Members reached without their name being spelled (by the language or a library): WorkspaceService declares none. */
const PROTOCOL_NAMES = new Set(['then', 'toJSON', 'toString', 'valueOf', 'constructor', 'inspect', 'catch', 'finally'])

/**
 * Trees audited by hand (workspaceRule.audited.json), each bound to its exact git tree and to the rule's identity
 * (ruleIdentity: this file, the loaded compiler, the node types): their escapes and program errors as listed, each with
 * why it can't hide a member's use, read along its whole flow. Any other tree with an escape or an error fails the rule.
 */
export const AUDITED = JSON.parse(readFileSync(new URL('./workspaceRule.audited.json', import.meta.url), 'utf8'))

const slashes = (p) => p.replace(/\\/g, '/')
const inScope = (file) => RULE_SCOPE.some((s) => file.startsWith(s))

/** The `workspace` const's initializer in workspace.ts's text: { start, end, hash } (Babel's tokens, comments aside), or null. */
export function proxyOf(text) {
  let ast
  try {
    ast = parse(text, { sourceType: 'module', plugins: ['typescript'], tokens: true })
  } catch {
    return null
  }
  for (const st of ast.program.body) {
    const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st
    if (decl?.type !== 'VariableDeclaration') continue
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== PROXY_NAME || !d.init) continue
      // Babel's tokens hold its comments too, typed by a string: those aren't the code's.
      const tokens = ast.tokens.filter((t) => t.start >= d.init.start && t.end <= d.init.end && t.type !== 'CommentLine' && t.type !== 'CommentBlock')
      const h = createHash('sha256')
      for (const t of tokens) h.update(`${t.type?.label ?? t.type}\u0000${JSON.stringify(t.value ?? null)}\u0001`)
      return { start: d.init.start, end: d.init.end, hash: h.digest('hex').slice(0, 16) }
    }
  }
  return null
}

/**
 * The rule's own identity, which an audit is bound to beside its tree: this file's text, the compiler as loaded (its
 * version and its code) and the node types the program resolves.
 */
export function ruleIdentity() {
  const sha = (path) => createHash('sha1').update(readFileSync(path)).digest('hex')
  return {
    // Its text with LF endings: a Windows checkout has CRLF, git and CI LF.
    rule: createHash('sha1').update(readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
    compiler: `${require('typescript-classic/package.json').version} ${sha(require.resolve('typescript-classic'))}`,
    types: require('@types/node/package.json').version
  }
}

/**
 * Whether a changed file is one of the rule's inputs: the program's code and configs, the dependencies (the compiler,
 * @types, resolution), and the rule's own files and wiring. A change to none of them can't change its result.
 */
export function ruleInput(file) {
  const f = slashes(file)
  if (/\.(ts|tsx|mts|cts)$/i.test(f)) return true
  if (/(^|\/)tsconfig[^/]*\.json$/i.test(f) || /(^|\/)jsconfig[^/]*\.json$/i.test(f)) return true
  if (f === 'package.json' || f === 'package-lock.json') return true
  return ['tests/e2e/workspaceRule.mjs', 'tests/e2e/workspaceRuleCheck.mjs', 'tests/e2e/workspaceRule.audited.json', 'tests/e2e/affectedUnits.mjs', 'tests/e2e/relatedTests.mjs', 'tests/e2e/runContext.cjs'].includes(f)
}

const censuses = new Map()

/**
 * The census of one revision (affectedUnits.mjs's gitRevision or memoryRevision, with list()): { all: why } when it
 * can't be proved, else { broken: why | null, escapes, exempt, pinned: [files outside the rule's scope with an
 * escape], errors, ms }. root: the checkout, whose node_modules the program resolves. scope: 'all' (the whole program:
 * pins too) or 'src' (the rule's scope alone); budget: the type visits allowed. Memoized per revision (a commit's).
 */
const censusKey = (rev, root, scope) => `${resolve(root)}\0${rev.commit ?? rev.name}\0${scope}`
// The whole program's census answers for the rule's scope too.
const censusDone = (rev, root, scope) => censuses.get(censusKey(rev, root, scope)) ?? (scope === 'src' ? censuses.get(censusKey(rev, root, 'all')) : undefined)

export function census(rev, root, { scope = 'all', budget = WORK_BUDGET } = {}) {
  const key = (sc) => censusKey(rev, root, sc)
  if (rev.commit !== undefined) {
    const done = censusDone(rev, root, scope)
    if (done) return done
  }
  let result
  try {
    // A repository's revision (a commit, or the working tree) is censused in a process of its own: the whole program's
    // types take about 4 GB, a default heap's limit, beside whatever the caller holds. A revision in memory (a fixture)
    // is small, censused here.
    result = rev.commit !== undefined && rev.root ? censusApart(rev, scope, budget) : censusHere(rev, root, { scope, budget })
  } catch (e) {
    result = { all: `the WorkspaceService census of ${rev.name} failed (${String(e?.message ?? e).split('\n')[0]})` }
  }
  if (rev.commit !== undefined) censuses.set(key(scope), result)
  return result
}

/** The census in this process (workspaceRuleCheck.mjs's --census runs it for census()). */
export function censusHere(rev, root, { scope = 'all', budget = WORK_BUDGET } = {}) {
  return censusIn(rev, resolve(root), scope, budget)
}

/** Heap for a census apart: the whole program takes about 4 GB (7 Nov). */
export const CENSUS_HEAP_MB = 8192

/** Several revisions of one checkout, each censused in a process of its own, at the same time. */
function censusesApart(revs, scope) {
  const script = fileURLToPath(new URL('./workspaceRuleCheck.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [script, '--censuses', scope, ...revs.map((r) => r.commit ?? '')], { cwd: revs[0].root, env: runContext.baseEnv(), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)
}

function censusApart(rev, scope, budget) {
  const script = fileURLToPath(new URL('./workspaceRuleCheck.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [`--max-old-space-size=${CENSUS_HEAP_MB}`, script, '--census', rev.commit ?? '', '--scope', scope, '--budget', String(budget)], { cwd: rev.root, env: runContext.baseEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)
}

function censusIn(rev, root, scope, budget) {
  const t0 = Date.now()
  const ts = require('typescript-classic')
  const every = (why) => ({ all: `${why} (${rev.name})` })
  const R = slashes(root).replace(/\/$/, '') + '/'
  const listed = rev.list()
  const known = new Set(listed)
  const dirs = new Set([''])
  for (const f of listed) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  // The revision's own files are read from it; node_modules (and the compiler's libs) from the checkout's disk.
  const repoPath = (p) => {
    const x = slashes(p).replace(/\/$/, '') + '/'
    if (!x.toLowerCase().startsWith(R.toLowerCase())) return null
    const r = x.slice(R.length).replace(/\/$/, '')
    return r === 'node_modules' || r.startsWith('node_modules/') ? null : r
  }
  const readFile = (p) => {
    const r = repoPath(p)
    return r == null ? ts.sys.readFile(p) : known.has(r) ? (rev.read(r) ?? undefined) : undefined
  }
  const fileExists = (p) => {
    const r = repoPath(p)
    return r == null ? ts.sys.fileExists(p) : known.has(r)
  }
  const directoryExists = (p) => {
    const r = repoPath(p)
    return r == null ? ts.sys.directoryExists(p) : dirs.has(r.replace(/\/$/, ''))
  }
  const entries = (p) => {
    const r = repoPath(p)
    if (r == null) return { files: [], directories: [] }
    const at = r.replace(/\/$/, '')
    const pre = at ? `${at}/` : ''
    const files = new Set()
    const directories = new Set()
    for (const f of listed) {
      if (!f.startsWith(pre)) continue
      const rest = f.slice(pre.length)
      const i = rest.indexOf('/')
      if (i < 0) files.add(rest)
      else if (!(at === '' && rest.slice(0, i) === 'node_modules')) directories.add(rest.slice(0, i))
    }
    return { files: [...files], directories: [...directories] }
  }
  const sys = {
    ...ts.sys,
    readFile,
    fileExists,
    directoryExists,
    readDirectory: (path, extensions, excludes, includes, depth) => ts.matchFiles(path, extensions, excludes, includes, false, R, depth, entries, (p) => p)
  }
  const configText = rev.read(TSCONFIG)
  if (configText == null) return every(`${TSCONFIG} can't be read`)
  const json = ts.parseConfigFileTextToJson(R + TSCONFIG, configText)
  if (json.error) return every(`${TSCONFIG} doesn't parse`)
  const parsed = ts.parseJsonConfigFileContent(json.config, sys, R, undefined, R + TSCONFIG)
  if (parsed.errors.some((d) => d.category === ts.DiagnosticCategory.Error)) return every(`${TSCONFIG} has an error (${ts.flattenDiagnosticMessageText(parsed.errors[0].messageText, ' ')})`)
  // Code outside the program that may load the class, before the program is built: the import graph and the program
  // together don't fit in a default heap. Its root files are what the program holds for certain.
  const rootFiles = new Set(parsed.fileNames.map((f) => slashes(f).slice(R.length)))
  const outside = outsideLoader(rev, rootFiles)
  const host = ts.createCompilerHost(parsed.options, true)
  Object.assign(host, { readFile, fileExists, directoryExists, getCurrentDirectory: () => R, getDirectories: (p) => entries(p).directories })
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
  const checker = program.getTypeChecker()
  const rel = (f) => {
    const x = slashes(f)
    return x.toLowerCase().startsWith(R.toLowerCase()) ? x.slice(R.length) : null
  }
  const sources = program.getSourceFiles().filter((sf) => {
    const r = rel(sf.fileName)
    return r != null && !r.startsWith('node_modules/')
  })
  const inProgram = new Set(sources.map((sf) => rel(sf.fileName)))
  for (const f of listed) if (inScope(f) && /\.(ts|tsx|mts|cts)$/i.test(f) && !/\.d\.ts$/i.test(f) && !inProgram.has(f)) return every(`${f} isn't in ${TSCONFIG}'s program, so the census can't see it`)

  // Program errors: a broken import or type can hide a holder (an error type reads as none), so any error fails.
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error).map((d) => ({ file: d.file ? rel(d.file.fileName) : null, code: d.code, text: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 200) }))

  const classFile = sources.find((sf) => rel(sf.fileName) === CLASS_FILE)
  if (!classFile) return every(`${CLASS_FILE} isn't in the program`)
  let classDecl = null
  classFile.forEachChild((n) => {
    if (ts.isClassDeclaration(n) && n.name?.text === CLASS_NAME) classDecl = n
  })
  if (!classDecl) return every(`${CLASS_NAME} isn't declared in ${CLASS_FILE}`)
  const protocol = classDecl.members.find((m) => m.name && ((ts.isIdentifier(m.name) && PROTOCOL_NAMES.has(m.name.text) && !ts.isConstructorDeclaration(m)) || ts.isComputedPropertyName(m.name)))
  const F = ts.TypeFlags
  const K = ts.SyntaxKind
  const WS = checker.getTypeAtLocation(classDecl.name)
  const tracked = new Set([WS])
  const proxy = proxyOf(classFile.text)

  let work = 0
  const isLib = (t) => {
    const d = t.getSymbol()?.declarations ?? []
    return d.length > 0 && d.every((x) => {
      const r = rel(x.getSourceFile().fileName)
      return r == null || r.startsWith('node_modules/')
    })
  }
  const PLAIN = F.StringLike | F.NumberLike | F.BooleanLike | F.BigIntLike | F.ESSymbolLike | F.Void | F.Undefined | F.Null | F.Never | F.Any | F.Unknown
  let version = 0
  const memo = new Map()
  class OutOfWork extends Error {}
  // Whether a type holds a tracked one: itself, a union or intersection member, a type argument, a signature's parameter
  // or return (a library's callbacks too), and for the repository's own types a property or an index signature.
  const holds = (t, seen = null) => {
    if (!t) return false
    if (++work > budget) throw new OutOfWork()
    if (tracked.has(t)) return true
    if (t.flags & PLAIN) return false
    const m = memo.get(t)
    if (m && m.v === version) return m.hit
    const top = !seen
    seen ??= new Set()
    if (seen.has(t)) return false
    seen.add(t)
    let hit = false
    if (t.flags & F.UnionOrIntersection) hit = t.types.some((u) => holds(u, seen))
    else if (t.flags & F.Object) {
      const args = t.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(t) : (t.aliasTypeArguments ?? [])
      hit = args.some((u) => holds(u, seen))
      for (const sig of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
        if (hit) break
        hit = holds(sig.getReturnType(), seen) || sig.getParameters().some((p) => holds(checker.getTypeOfSymbol(p), seen))
      }
      if (!hit && !isLib(t)) {
        hit = t.getProperties().some((p) => holds(checker.getTypeOfSymbol(p), seen))
        if (!hit) hit = checker.getIndexInfosOfType(t).some((ix) => holds(ix.type, seen))
      }
    } else if (t.flags & (F.TypeParameter | F.Index | F.IndexedAccess | F.Conditional | F.Substitution)) {
      const c = checker.getBaseConstraintOfType(t)
      hit = !!c && c !== t && holds(c, seen)
    }
    // A cycle cut short says no only for this walk: remembered when the walk started here, or said yes.
    if (hit || top) memo.set(t, { v: version, hit })
    return hit
  }
  const erases = (t) => {
    if (!t) return 'no type'
    if (t.flags & (F.Any | F.Unknown | F.TypeParameter | F.NonPrimitive | F.Index | F.IndexedAccess | F.Conditional | F.Substitution)) return checker.typeToString(t)
    if (t.flags & F.Union) return t.types.map(erases).find(Boolean) ?? null
    if (t.flags & F.Object) {
      for (const ix of checker.getIndexInfosOfType(t)) if (erases(ix.type)) return checker.typeToString(t)
      if (!t.getProperties().length && !t.getCallSignatures().length && !t.getConstructSignatures().length && !checker.getIndexInfosOfType(t).length) return checker.typeToString(t)
    }
    return null
  }
  const objectPart = (t) => !!t && (t.flags & F.Object || (t.flags & F.Union && t.types.some((u) => u.flags & F.Object)))
  // A tracked object itself, not a container of one.
  const direct = (t) => !!t && (tracked.has(t) || (t.flags & F.Union && t.types.some((u) => tracked.has(u))))
  const short = (t) => checker.typeToString(t).slice(0, 60)
  // Where a value goes: null (its type is kept), { view } (a WorkspaceService put into another object type: tracked
  // too), or why it escapes.
  const slot = (n) => {
    const ctx = checker.getContextualType(n)
    if (!ctx) return null
    const e = erases(ctx)
    if (e) return `goes into a ${e} slot`
    if (holds(ctx)) return null
    if (direct(checker.getTypeAtLocation(n)) && objectPart(ctx)) return { view: ctx }
    return `goes into a ${short(ctx)} slot, which drops it`
  }
  const position = (n) => {
    let q = n
    for (;;) {
      const p = q.parent
      if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p)) {
        q = p
        continue
      }
      if ((ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) && p.expression === q) {
        const t = checker.getTypeAtLocation(p)
        const e = erases(t)
        if (e) return `is cast to ${e}`
        if (!holds(t)) return objectPart(t) && direct(checker.getTypeAtLocation(q)) ? { view: t } : `is cast to ${short(t)}, which drops it`
        q = p
        continue
      }
      break
    }
    const p = q.parent
    const t = checker.getTypeAtLocation(q)
    if (ts.isPropertyAccessExpression(p)) return null
    if (ts.isElementAccessExpression(p)) {
      if (p.argumentExpression === q) return 'is used as a key'
      return ts.isStringLiteralLike(p.argumentExpression) || !direct(t) ? null : 'is read by a computed key'
    }
    if (ts.isSpreadAssignment(p)) return direct(t) ? 'is spread into an object' : null
    if (ts.isSpreadElement(p)) return null
    if (ts.isForInStatement(p)) return p.expression === q ? 'is iterated by for-in' : null
    if (ts.isForOfStatement(p)) return null
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      // A destructuring assignment's source is no slot: its pattern is checked as destructurings are.
      if (op === K.EqualsToken) return p.right === q && !ts.isObjectLiteralExpression(p.left) && !ts.isArrayLiteralExpression(p.left) ? slot(q) : null
      if ([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken].includes(op)) return null
      // Either side of instanceof: the class on its right is read for its prototype alone.
      if (op === K.InstanceOfKeyword) return null
      if ([K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken, K.CommaToken].includes(op)) return null
      if (op === K.InKeyword) return p.right === q && direct(t) ? 'is the right of in' : null
      if ([K.QuestionQuestionEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken].includes(op)) return p.right === q ? slot(q) : null
      return `is an operand of ${ts.tokenToString(op)}`
    }
    if (ts.isConditionalExpression(p)) return null
    if (ts.isPrefixUnaryExpression(p)) return p.operator === K.ExclamationToken ? null : 'is an operand'
    if (ts.isTypeOfExpression(p) || ts.isVoidExpression(p) || ts.isAwaitExpression(p) || ts.isExpressionStatement(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isDeleteExpression(p) || ts.isCaseClause(p) || ts.isSwitchStatement(p)) return null
    if (ts.isVariableDeclaration(p)) return p.initializer === q && p.type ? slot(q) : null
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) return p.expression === q ? null : slot(q)
    if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isArrayLiteralExpression(p) || ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p) || ts.isYieldExpression(p) || ts.isBindingElement(p) || ts.isJsxExpression(p) || ts.isExportAssignment(p)) return slot(q)
    if (ts.isTemplateSpan(p) || ts.isTaggedTemplateExpression(p)) return 'is put into a template'
    if (ts.isThrowStatement(p)) return 'is thrown'
    return `is in a ${K[p.kind]}`
  }
  // Every value: an expression, not a name a declaration, member access or property gives, nor in a type.
  const nodes = []
  // Object destructurings: binding patterns (declarations, parameters, for-of) and assignment targets.
  const patterns = []
  const assignedTo = (n) => {
    const p = n.parent
    if (!p) return false
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === n) return true
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return true
    if ((ts.isPropertyAssignment(p) && p.initializer === n) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) return assignedTo(p.parent)
    if (ts.isArrayLiteralExpression(p) || ts.isParenthesizedExpression(p)) return assignedTo(p)
    if (ts.isSpreadElement(p)) return assignedTo(p.parent)
    return false
  }
  // The rule's scope alone ('src', for e2e selection: no pins), or the whole program ('all').
  for (const sf of sources) {
    const file = rel(sf.fileName)
    if (scope === 'src' && !inScope(file)) continue
    sf.forEachChild(function walk(n) {
      if (ts.isTypeNode(n) || ts.isExpressionWithTypeArguments(n) || ts.isPropertySignature(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isHeritageClause(n) || ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportDeclaration(n)) return
      const name = ts.isIdentifier(n) && ((ts.isDeclaration(n.parent) && n.parent.name === n) || (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n) || ts.isQualifiedName(n.parent) || ts.isJsxAttribute(n.parent))
      if (ts.isExpression(n) && !name) nodes.push({ file, sf, n })
      if (ts.isObjectBindingPattern(n) || (ts.isObjectLiteralExpression(n) && assignedTo(n))) patterns.push({ file, sf, n })
      n.forEachChild(walk)
    })
  }
  let escapes = []
  try {
    const types = nodes.map(({ n }) => checker.getTypeAtLocation(n))
    for (let round = 0; ; round++) {
      if (round > 50) return every('the types a WorkspaceService is put into reached no fixpoint')
      let grew = false
      escapes = []
      for (const [i, { file, sf, n }] of nodes.entries()) {
        if (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent)) continue
        if (!holds(types[i])) continue
        const pos = position(n)
        if (!pos) continue
        if (typeof pos === 'object') {
          for (const v of pos.view.flags & F.Union ? pos.view.types.filter((u) => u.flags & F.Object) : [pos.view]) {
            if (!tracked.has(v)) {
              tracked.add(v)
              grew = true
            }
          }
          version++
          continue
        }
        const at = n.getStart(sf)
        const inProxy = file === CLASS_FILE && proxy && at >= proxy.start && at < proxy.end
        escapes.push({ file, line: sf.getLineAndCharacterOfPosition(at).line + 1, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80), why: `${short(types[i])} ${pos}`, inProxy })
      }
      if (!grew) break
    }
    // Destructuring a tracked object by a key the code doesn't spell (`const { [k]: f } = ws`, a parameter's
    // `{ [key()]: f }: WorkspaceService`, an assignment's `({ [k]: f } = ws)`), or into a rest that copies its members.
    for (const { file, sf, n } of patterns) {
      const by = ts.isObjectBindingPattern(n)
        ? n.elements.some((el) => el.dotDotDotToken) ? 'a rest' : n.elements.some((el) => el.propertyName && ts.isComputedPropertyName(el.propertyName) && !ts.isStringLiteralLike(el.propertyName.expression)) ? 'a computed key' : null
        : n.properties.some((p) => ts.isSpreadAssignment(p)) ? 'a rest' : n.properties.some((p) => p.name && ts.isComputedPropertyName(p.name) && !ts.isStringLiteralLike(p.name.expression)) ? 'a computed key' : null
      if (!by) continue
      // An assignment's pattern has the type of what is assigned to it, a declaration's the pattern's own.
      const t = ts.isObjectLiteralExpression(n) ? checker.getTypeOfAssignmentPattern(n) : checker.getTypeAtLocation(n)
      if (!direct(t) && !(t.flags & F.TypeParameter && direct(checker.getBaseConstraintOfType(t)))) continue
      const at = n.getStart(sf)
      escapes.push({ file, line: sf.getLineAndCharacterOfPosition(at).line + 1, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 80), why: `${short(t)} is destructured by ${by}`, inProxy: file === CLASS_FILE && proxy && at >= proxy.start && at < proxy.end })
    }
  } catch (e) {
    if (e instanceof OutOfWork) return every(`the census's type walk ran out of its budget (${budget} visits)`)
    throw e
  }
  const ms = Date.now() - t0
  const pinned = [...new Set(escapes.filter((e) => !inScope(e.file)).map((e) => e.file))].sort()
  let inside = escapes.filter((e) => inScope(e.file))
  // The Proxy's own: exempt while it is its reviewed text (its handlers forward by the name its caller spelled).
  const proxyEdited = inside.some((e) => e.inProxy) && proxy?.hash !== PROXY_HASH
  const exempt = proxyEdited ? [] : inside.filter((e) => e.inProxy)
  inside = inside.filter((e) => !exempt.includes(e))
  // An audited tree: its escapes and errors, exactly, in exactly that tree under exactly this rule and compiler.
  let audited = null
  if ((inside.length || errors.length) && rev.tree) {
    const tree = rev.tree()
    const id = ruleIdentity()
    audited = AUDITED.find((a) => a.tree === tree && a.rule === id.rule && a.compiler === id.compiler && a.types === id.types) ?? null
  }
  const sig = (e) => `${e.file}\0${e.text}\0${e.why}`
  const auditedEscapes = audited ? new Set(audited.escapes.map(sig)) : new Set()
  const auditedErrors = audited ? new Set(audited.errors.map((e) => `${e.file}\0${e.code}\0${e.text}`)) : new Set()
  const liveEscapes = inside.filter((e) => !auditedEscapes.has(sig(e)))
  const liveErrors = errors.filter((e) => !auditedErrors.has(`${e.file}\0${e.code}\0${e.text}`))
  const first = liveEscapes[0]
  // What no audit covers: code the census can't see, a member reached without its name, the Proxy edited.
  const structural = outside
    ? outside
    : protocol
      ? `${CLASS_NAME} declares ${protocol.name.getText(classFile)}, which is reached without its name being spelled`
      : proxyEdited
        ? `the workspace Proxy in ${CLASS_FILE} isn't its reviewed text (its hash ${proxy?.hash}): review it, then update PROXY_HASH in tests/e2e/workspaceRule.mjs`
        : null
  const broken = structural
    ? structural
    : liveErrors.length
        ? `${liveErrors[0].file ?? 'the program'} has a type error (TS${liveErrors[0].code}: ${liveErrors[0].text})${liveErrors.length > 1 ? `, and ${liveErrors.length - 1} more` : ''}, so its types can't be trusted`
        : first
          ? `${first.file}:${first.line}: ${first.text} (${first.why})${liveEscapes.length > 1 ? `, and ${liveEscapes.length - 1} more` : ''}`
          : null
  return { broken: broken ? `${broken} (${rev.name})` : null, structural, escapes: liveEscapes, exempt, audited: audited ? audited.tree : null, pinned: scope === 'all' ? pinned : null, errors: liveErrors, ms, files: sources.length, work, scope }
}

/** Selection's own tooling: it reads workspace.ts as text, to select by it, and never runs it. */
const TOOLING = ['tests/e2e/affected.mjs', 'tests/e2e/affectedUnits.mjs', 'tests/e2e/relatedTests.mjs', 'tests/e2e/workspaceRule.mjs', 'tests/e2e/workspaceRuleCheck.mjs']
/** A path to workspace.ts as code spells it to load it (`./workspace`, `../src/main/workspace.ts`…). */
const SPELLS_CLASS_FILE = /(?:^|[/'"`])(?:src\/)?main\/workspace(?:\.[cm]?[jt]s)?['"`]|['"`]\.{1,2}\/(?:[\w.-]+\/)*workspace(?:\.[cm]?[jt]s)?['"`]/

/**
 * Code outside the census's program that may load workspace.ts, which the census can't see (a script, an e2e
 * suite, a .mjs helper): one whose imports reach it (relatedTests' graph), or one reaching a loader the graph can't
 * read in a file that spells its path. A path built from pieces is a hidden loader, the review's boundary.
 * Why the rule doesn't hold, or null.
 */
function outsideLoader(rev, inProgram) {
  const files = rev.list().filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(f) && !f.startsWith('node_modules/') && !TOOLING.includes(f))
  const outside = files.filter((f) => !inProgram.has(f))
  if (!outside.length) return null
  const graph = importGraph(rev.list(), (f) => rev.read(f), rev.prefetch)
  // What reaches each start, by the imports reversed (no closure is kept per file: there are hundreds outside).
  const into = new Map()
  for (const f of files) for (const g of graph.edgesOf(f)) into.set(g, [...(into.get(g) ?? []), f])
  const reaching = (starts) => {
    const seen = new Map(starts.map((s) => [s, s]))
    const queue = [...starts]
    while (queue.length) {
      const g = queue.shift()
      for (const f of into.get(g) ?? []) {
        if (seen.has(f)) continue
        seen.set(f, seen.get(g))
        queue.push(f)
      }
    }
    return seen
  }
  const toClass = reaching([CLASS_FILE])
  const toUnknown = reaching(files.filter((f) => graph.unknownOf(f)))
  const toSpelling = reaching(files.filter((f) => SPELLS_CLASS_FILE.test(rev.read(f) ?? '')))
  for (const f of outside) {
    if (toClass.has(f)) return `${f}, outside ${TSCONFIG}'s program, loads ${CLASS_FILE}: the census can't see how it uses a ${CLASS_NAME}`
    if (toUnknown.has(f) && toSpelling.has(f)) return `${f}, outside ${TSCONFIG}'s program, reaches a loader the graph can't read (${graph.unknownOf(toUnknown.get(f))}) beside a path to ${CLASS_FILE} (in ${toSpelling.get(f)}): the census can't see what it loads`
  }
  return null
}

/**
 * The rule on both revisions, for selection: { all: why } when it doesn't hold (or can't be proved) in either, else {
 * pinned: [files] (scope 'all'; null for 'src'), ms }. root: the checkout.
 */
export function ruleOn(revs, root, { scope = 'all' } = {}) {
  const pinned = new Set()
  let ms = 0
  // A repository's revisions not censused yet, at once: each a process of its own (about a minute each).
  const apart = revs.filter((rev) => rev.commit !== undefined && rev.root && !censusDone(rev, root, scope))
  if (apart.length > 1) {
    try {
      for (const [i, c] of censusesApart(apart, scope).entries()) censuses.set(censusKey(apart[i], root, scope), c)
    } catch {
      // Then each in turn, through census(), which says why one fails.
    }
  }
  for (const rev of revs) {
    const c = census(rev, root, { scope })
    if (c.all) return { all: c.all }
    if (c.broken) return { all: `the WorkspaceService rule doesn't hold: ${c.broken}` }
    for (const f of c.pinned ?? []) pinned.add(f)
    ms += c.ms
  }
  return { pinned: scope === 'all' ? [...pinned].sort() : null, ms }
}
