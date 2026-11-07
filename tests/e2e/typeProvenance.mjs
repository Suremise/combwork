// WORK IN PROGRESS (HI-2678, waiting on Darren's R1/R2/R3, HI-2678/r21): not imported by anything yet. As built to
// design s13 it is sound but too slow for the picker (190 s a revision) and its depth bound counts 1,532 values as
// escaping; kept as the census R2 would run at merge.
//
// Where WorkspaceService's members are used, by TypeScript's types (HI-2678, design HI-2678/s13, approved by HR2): the
// consumers of a changed member, for affectedUnits.mjs's tracer and relatedTests.mjs, which otherwise keep its members
// every suite (HI-2659's C3: its instances flow where a name tracer can't follow them).
//
// The invariant, as in HI-2677: anything not proved known propagates as unknown (`all`, with a reason).
// - Tracked types, to a fixpoint: WorkspaceService, and every object type a value of a tracked type is put into (a view,
//   `Pick<WorkspaceService, 'config'>`, an interface it satisfies). A type mentions a tracked type when it is one or holds
//   one: a union or intersection member, a type argument (Map<string, WS>, WS[], Promise<WS>), a property's type, a
//   signature's parameter or return (a callback), an index signature's value; a walk past its depth bound mentions.
// - The census: every value whose type mentions a tracked type is in an allowed position (POSITIONS): the object of a
//   named member access; a slot whose contextual type mentions a tracked type too (an argument, an initializer, an
//   assignment, a return, an element or property of a literal); an untyped variable's initializer (its type is the
//   value's); a comparison, logical or conditional operand, `!`, typeof, void, await, a condition; through parentheses,
//   `!` and a cast keeping it. The slots that erase a type (any, unknown, object, {}, a type parameter, an index
//   signature) are escapes before anything else, and so is any other position (a spread, a computed key, a template,
//   iteration, `in`, delete…).
// - The one exemption: workspace.ts's `workspace` Proxy, which forwards the key accessed on a WorkspaceService-typed
//   value (`workspace.m` is the consumer), by its reviewed text: its initializer's tokens must hash to PROXY_HASH, else
//   every suite (tests/affectedUnits.test.ts fails until the hash is updated, a reviewed change).
// - Consumers of member m: `x.m`, `x?.m`, `x['m']` whose receiver's type is, or has in its union, a tracked type
//   declaring m. With the census clean, a receiver of any other type can't hold a WorkspaceService: proved foreign.
// - The program: tsconfig.node.json's (main, preload, shared and the tests; the renderer's project can't import main),
//   for each revision, read from that revision (a commit through a virtual file system over git, the working tree from
//   disk). Missing compiler support, a program that can't be built, an unreadable class, or an error in a file holding
//   a tracked value or changed: all. No cache: each selection works it out afresh.
import { parse } from '@babel/parser'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'
import { join } from 'path'

const slashes = (p) => p.replace(/\\/g, '/')

/** The `workspace` Proxy's initializer, as reviewed (its tokens' kinds and values, hashed: whitespace and comments aside). */
export const PROXY_HASH = 'PENDING'
export const CLASS_FILE = 'src/main/workspace.ts'
export const CLASS_NAME = 'WorkspaceService'
export const PROXY_NAME = 'workspace'
/** The code the analysis covers: what runs in the app. */
export const SCOPE = ['src/main/', 'src/preload/', 'src/shared/']

/** The `workspace` const's initializer in workspace.ts's text: { start, end, hash } (Babel's tokens), or null. */
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
      const tokens = ast.tokens.filter((t) => t.start >= d.init.start && t.end <= d.init.end && t.type?.label !== 'CommentLine' && t.type?.label !== 'CommentBlock')
      const h = createHash('sha256')
      for (const t of tokens) h.update(`${t.type?.label ?? t.type}\u0000${JSON.stringify(t.value ?? null)}\u0001`)
      return { start: d.init.start, end: d.init.end, hash: h.digest('hex').slice(0, 16) }
    }
  }
  return null
}

let tsApi = null
async function loadApi(root) {
  if (tsApi) return tsApi
  const dist = join(root, 'node_modules', 'typescript', 'dist')
  const api = await import(pathToFileURL(join(dist, 'api', 'sync', 'api.js')).href)
  const { SyntaxKind } = await import(pathToFileURL(join(dist, 'enums', 'syntaxKind.js')).href)
  tsApi = { ...api, SyntaxKind }
  return tsApi
}

/**
 * A virtual file system over a revision of the repository (affectedUnits.mjs's gitRevision or memoryRevision, with
 * `files`: its paths), for TypeScript's API: the revision's own files, and the real disk outside them (node_modules).
 */
function revisionFs(root, rev, files) {
  const r = slashes(root).replace(/\/$/, '').toLowerCase() + '/'
  const rel = (p) => {
    const s = slashes(p)
    return s.toLowerCase().startsWith(r) ? s.slice(r.length) : null
  }
  const inRepo = (p) => {
    const x = rel(p)
    return x != null && !x.startsWith('node_modules/') && x !== 'node_modules'
  }
  const set = new Set(files)
  const dirs = new Set([''])
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  return {
    readFile: (p) => (inRepo(p) ? (set.has(rel(p)) ? rev.read(rel(p)) ?? null : null) : undefined),
    fileExists: (p) => (inRepo(p) ? set.has(rel(p)) : undefined),
    directoryExists: (p) => (inRepo(p) ? dirs.has(rel(p).replace(/\/$/, '')) : undefined),
    getAccessibleEntries: (p) => {
      if (!inRepo(p) && rel(p) !== '') return undefined
      const d = (rel(p) ?? '').replace(/\/$/, '')
      const pre = d ? `${d}/` : ''
      const out = { files: [], directories: [] }
      for (const f of set) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) out.files.push(f.slice(pre.length))
      for (const x of dirs) if (x && x.startsWith(pre) && !x.slice(pre.length).includes('/')) out.directories.push(x.slice(pre.length))
      if (!d) out.directories.push('node_modules')
      return out
    }
  }
}

/**
 * One revision's analysis: { all: why } or { consumers(member) → [{ file, line }], escapes: [{ file, line, why }] }.
 * root: the checkout (its node_modules has TypeScript); rev: the revision (gitRevision, memoryRevision) or null for the
 * working tree; files: the revision's paths (with rev); changed: the changed paths (errors there count).
 */
export async function analyseRevision({ root, rev = null, files = null, changed = [], tsconfig = 'tsconfig.node.json', scope = SCOPE }) {
  const where = rev?.name ?? 'the working tree'
  let api
  try {
    const ts = await loadApi(root)
    api = new ts.API({ cwd: root, ...(rev ? { fs: revisionFs(root, rev, files) } : {}) })
    return analyseIn(ts, api, { root, rev, changed, tsconfig, where, scope })
  } catch (e) {
    return { all: `WorkspaceService's uses couldn't be worked out in ${where} (${e.message})` }
  } finally {
    try {
      api?.close()
    } catch {
      // closing a failed session: nothing to keep
    }
  }
}

function analyseIn(ts, api, { root, rev, changed, tsconfig, where, scope }) {
  const { SyntaxKind: K, TypeFlags: F } = ts
  const every = (why) => ({ all: `${why} (${where}), so WorkspaceService's members can't be followed by type` })
  const snap = api.updateSnapshot({ openProjects: [join(root, tsconfig)] })
  const project = snap.getProjects()[0]
  if (!project) return every(`${tsconfig} gave no project`)
  const program = project.program
  const checker = project.checker
  const r = slashes(root).replace(/\/$/, '').toLowerCase() + '/'
  const relOf = (f) => (slashes(f).toLowerCase().startsWith(r) ? slashes(f).slice(r.length) : null)
  // What runs in the app (the e2e suites' code): main, preload and shared. The renderer's project can't import main.
  const files = program.getSourceFileNames().filter((f) => {
    const x = relOf(f)
    return x && scope.some((s) => x.startsWith(s))
  })
  const classPath = files.find((f) => relOf(f) === CLASS_FILE)
  if (!classPath) return every(`${CLASS_FILE} isn't in the program`)
  for (const c of changed) if (/\.(ts|tsx|mts|cts)$/.test(c) && scope.some((s) => c.startsWith(s)) && !files.some((f) => relOf(f) === c)) return every(`${c} changed but isn't in ${tsconfig}'s program`)
  const classFile = program.getSourceFile(classPath)
  let classId = null
  classFile.forEachChild(function find(n) {
    if (classId) return
    if (n.kind === K.ClassDeclaration && n.name?.text === CLASS_NAME) classId = n.name
    else n.forEachChild(find)
  })
  if (!classId) return every(`${CLASS_NAME} isn't declared in ${CLASS_FILE}`)
  const WS = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(classId))
  const proxyText = rev ? rev.read(CLASS_FILE) : classFile.text
  const proxy = proxyText ? proxyOf(proxyText) : null

  // Every value node and every named member access of each file, with types.
  const VALUE = new Set([K.Identifier, K.PropertyAccessExpression, K.ElementAccessExpression, K.CallExpression, K.NewExpression, K.ThisKeyword, K.AwaitExpression, K.ParenthesizedExpression, K.NonNullExpression, K.AsExpression, K.SatisfiesExpression, K.TypeAssertionExpression, K.ConditionalExpression, K.BinaryExpression])
  const perFile = []
  const UNTYPED = { id: -1, flags: 0, untyped: true }
  let untyped = 0
  for (const f of files) {
    const sf = program.getSourceFile(f)
    if (!sf) return every(`${relOf(f)} couldn't be read`)
    const nodes = []
    sf.forEachChild(function walk(n) {
      // A value: not a name a declaration, a member access or a property gives (`interface I { a: T }`, `x.a`, `{ a: 1 }`).
      if (VALUE.has(n.kind) && !(n.kind === K.Identifier && n.parent?.name === n && n.parent.kind !== K.ShorthandPropertyAssignment) && !isTypePosition(n)) nodes.push(n)
      n.forEachChild(walk)
    })
    perFile.push({ file: relOf(f), sf, nodes, types: typesOf(nodes) })
  }
  // TypeScript 7's API fails on some types (a tuple's, 7.0.2): a batch that fails is typed node by node, and a node it
  // can't type is UNTYPED: it may hold a tracked type, so it is checked as one (an escape unless its position is safe).
  function typesOf(nodes) {
    if (!nodes.length) return []
    try {
      return checker.getTypeAtLocation(nodes)
    } catch {
      // Halves until the failing nodes are alone: a few requests per failure, not one per node.
      if (nodes.length === 1) {
        untyped++
        return [UNTYPED]
      }
      const mid = nodes.length >> 1
      return [...typesOf(nodes.slice(0, mid)), ...typesOf(nodes.slice(mid))]
    }
  }
  function isTypePosition(n) {
    for (let p = n.parent; p; p = p.parent) {
      if (p.kind >= K.FirstTypeNode && p.kind <= K.LastTypeNode) return true
      if (p.kind === K.ExpressionWithTypeArguments || p.kind === K.HeritageClause || p.kind === K.InterfaceDeclaration || p.kind === K.TypeAliasDeclaration || p.kind === K.ImportDeclaration || p.kind === K.ExportDeclaration) return true
      if (p.kind === K.Block || p.kind === K.SourceFile) return false
    }
    return false
  }
  const lineOf = (sf, n) => {
    let at = n.pos
    const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(sf.text.slice(at))
    at += m ? m[0].length : 0
    return sf.text.slice(0, at).split('\n').length
  }
  const startOf = (sf, n) => {
    const m = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(sf.text.slice(n.pos))
    return n.pos + (m ? m[0].length : 0)
  }

  // Tracked types and what mentions them.
  const tracked = new Map([[WS.id, WS]])
  let version = 0
  const memo = new Map()
  const memoTrue = new Set()
  // Types that can't hold an object: never ours.
  const PLAIN = F.String | F.Number | F.Boolean | F.BigInt | F.StringLiteral | F.NumberLiteral | F.BooleanLiteral | F.BigIntLiteral | F.EnumLiteral | F.Enum | F.Void | F.Undefined | F.Null | F.Never | F.ESSymbol | F.UniqueESSymbol | F.TemplateLiteral | F.StringMapping
  const ERASE = F.Any | F.Unknown | F.TypeParameter | F.NonPrimitive | F.Index | F.IndexedAccess | F.Conditional | F.Substitution
  const erases = (t) => {
    if (!t) return null
    if (t.flags & ERASE) return checker.typeToString(t)
    if (t.flags & F.Object) {
      if (checker.getIndexInfosOfType(t).length) return checker.typeToString(t)
      if (!checker.getPropertiesOfType(t).length && !checker.getSignaturesOfType(t, 0).length && !checker.getSignaturesOfType(t, 1).length) return checker.typeToString(t)
    }
    return null
  }
  const mentions = (t, depth = 0, seen = new Set()) => {
    if (!t) return false
    if (t.untyped) return true
    if (tracked.has(t.id) || memoTrue.has(t.id)) return true
    if (t.flags & PLAIN) return false
    const key = `${version}:${t.id}`
    if (memo.has(key)) return memo.get(key)
    if (depth > 6) return true
    if (seen.has(t.id)) return false
    seen.add(t.id)
    let hit = false
    if (t.flags & (F.Union | F.Intersection)) hit = (t.types ?? []).some((u) => mentions(u, depth + 1, seen))
    else if (t.flags & F.Object) {
      const args = (() => {
        try {
          return checker.getTypeArguments(t) ?? []
        } catch {
          return []
        }
      })()
      hit = args.some((u) => mentions(u, depth + 1, seen))
      // A library's type (lib.d.ts, node_modules) holds ours only through its type arguments: its own members are its.
      if (!hit && isLibrary(t)) {
        if (depth === 0) memo.set(key, false)
        return false
      }
      if (!hit) {
        for (const kind of [0, 1]) {
          for (const sig of checker.getSignaturesOfType(t, kind)) {
            if (hit) break
            if (mentions(checker.getReturnTypeOfSignature(sig), depth + 1, seen)) hit = true
            else for (let i = 0; i < sig.getParameters().length && !hit; i++) if (mentions(checker.getParameterType(sig, i), depth + 1, seen)) hit = true
          }
        }
      }
      if (!hit) {
        const props = checker.getPropertiesOfType(t)
        const pts = props.length ? checker.getTypeOfSymbol(props) : []
        hit = pts.some((u) => mentions(u, depth + 1, seen))
      }
      if (!hit) for (const ix of checker.getIndexInfosOfType(t)) if (mentions(ix.type, depth + 1, seen)) hit = true
    }
    // True is always so (tracked types only grow); false only from a whole walk, not one a cycle cut short.
    if (hit) memoTrue.add(t.id)
    else if (depth === 0) memo.set(key, false)
    return hit
  }
  function isLibrary(t) {
    const s = t.getSymbol?.()
    const d = s?.declarations ?? []
    return d.length > 0 && d.every((h) => {
      const p = slashes(String(h.path)).toLowerCase()
      return p.includes('/node_modules/') || /\/lib\.[^/]*\.d\.ts$/.test(p) || !p.startsWith(r)
    })
  }
  const holdsTracked = (t) => !!t && (tracked.has(t.id) || ((t.flags & F.Union) && (t.types ?? []).some((u) => tracked.has(u.id))))

  // The census, to a fixpoint over tracked types.
  const escapes = []
  const contextual = (n) => {
    try {
      return checker.getContextualType(n)
    } catch {
      return undefined
    }
  }
  const OPERATORS = new Set([K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken, K.EqualsEqualsToken, K.ExclamationEqualsToken, K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken, K.InstanceOfKeyword])
  const position = (n, sf) => {
    // Through wrappers that keep the value: the wrapper's position is the value's.
    let q = n
    for (;;) {
      const p = q.parent
      if (!p) return 'module code'
      if (p.kind === K.ParenthesizedExpression || p.kind === K.NonNullExpression) {
        q = p
        continue
      }
      if ((p.kind === K.AsExpression || p.kind === K.SatisfiesExpression || p.kind === K.TypeAssertionExpression) && p.expression === q) {
        const t = checker.getTypeAtLocation(p)
        const e = erases(t)
        if (e) return `a cast to ${e}`
        if (!mentions(t)) {
          if (t?.flags & F.Object) return { view: t }
          return `a cast to ${checker.typeToString(t)}`
        }
        q = p
        continue
      }
      break
    }
    const p = q.parent
    switch (p.kind) {
      case K.PropertyAccessExpression:
        return p.expression === q ? null : 'a property name'
      case K.ElementAccessExpression:
        return p.expression === q && (p.argumentExpression?.kind === K.StringLiteral || p.argumentExpression?.kind === K.NoSubstitutionTemplateLiteral) ? null : 'a computed key'
      case K.ExpressionStatement:
      case K.IfStatement:
      case K.WhileStatement:
      case K.DoStatement:
      case K.TypeOfExpression:
      case K.VoidExpression:
      case K.AwaitExpression:
        return null
      case K.PrefixUnaryExpression:
        return p.operator === K.ExclamationToken ? null : 'an operator'
      case K.BinaryExpression:
        if (OPERATORS.has(p.operatorToken.kind) && !(p.operatorToken.kind === K.InstanceOfKeyword && p.right === q)) return p.operatorToken.kind === K.AmpersandAmpersandToken || p.operatorToken.kind === K.BarBarToken || p.operatorToken.kind === K.QuestionQuestionToken ? slot(q) : null
        if (p.operatorToken.kind === K.EqualsToken && p.right === q) return slot(q)
        if (p.operatorToken.kind === K.CommaToken) return p.left === q ? null : slot(q)
        return 'an operator'
      case K.ConditionalExpression:
        return p.condition === q ? null : slot(q)
      case K.VariableDeclaration:
        if (p.initializer === q) return p.type ? slot(q) : p.name.kind === K.Identifier ? null : 'a destructuring'
        return 'a declaration'
      case K.CallExpression:
      case K.NewExpression:
        if (p.expression === q) return null
        return slot(q)
      case K.ReturnStatement:
      case K.ArrowFunction:
      case K.ArrayLiteralExpression:
      case K.PropertyAssignment:
      case K.ShorthandPropertyAssignment:
      case K.PropertyDeclaration:
      case K.Parameter:
      case K.YieldExpression:
        return slot(q)
      default:
        return `a ${K[p.kind]}`
    }
  }
  function slot(n) {
    const ctx = contextual(n)
    if (!ctx) return 'a slot with no type of its own'
    const e = erases(ctx)
    if (e) return `a ${e} slot`
    if (mentions(ctx)) return null
    if (ctx.flags & F.Object) return { view: ctx }
    return `a ${checker.typeToString(ctx)} slot`
  }
  let changedSet = true
  let rounds = 0
  while (changedSet && rounds++ < 20) {
    changedSet = false
    escapes.length = 0
    for (const { file, sf, nodes, types } of perFile) {
      for (const [i, n] of nodes.entries()) {
        if (!mentions(types[i])) continue
        // Only the outermost of a wrapped value is checked (its wrappers are in `position`).
        if (n.parent && [K.ParenthesizedExpression, K.NonNullExpression].includes(n.parent.kind)) continue
        const pos = position(n, sf)
        if (pos == null) continue
        if (typeof pos === 'object') {
          if (!tracked.has(pos.view.id)) {
            tracked.set(pos.view.id, pos.view)
            version++
            changedSet = true
          }
          continue
        }
        const at = startOf(sf, n)
        const exempt = file === CLASS_FILE && proxy && at >= proxy.start && at < proxy.end
        escapes.push({ file, line: lineOf(sf, n), why: `${checker.typeToString(types[i]).slice(0, 60)} as ${pos}`, exempt })
      }
    }
  }
  if (changedSet) return every('the types WorkspaceService is put into reached no fixpoint')
  const live = escapes.filter((e) => !e.exempt || proxy?.hash !== PROXY_HASH)
  if (live.length) {
    const e = live[0]
    const proxyEdited = e.exempt && proxy?.hash !== PROXY_HASH
    return every(proxyEdited ? `the workspace Proxy in ${CLASS_FILE} isn't its reviewed text (its hash ${proxy?.hash}): review it and update PROXY_HASH in tests/e2e/typeProvenance.mjs` : `${e.file}:${e.line} uses a ${e.why}${live.length > 1 ? `, and ${live.length - 1} more` : ''}`)
  }

  // Errors in a file holding a tracked value, or changed: the types there can't be trusted.
  const holding = new Set(perFile.filter(({ nodes, types }) => types.some((t) => mentions(t))).map(({ file }) => file))
  for (const c of changed) holding.add(c)
  for (const { file, sf } of perFile) {
    if (!holding.has(file)) continue
    const errors = [...program.getSyntacticDiagnostics(sf.fileName), ...program.getSemanticDiagnostics(sf.fileName)].filter((d) => d.category === 1)
    if (errors.length) return every(`${file} has a type error (TS${errors[0].code}: ${String(errors[0].text ?? '').slice(0, 80)})`)
  }

  // Consumers: member accesses by name whose receiver is a tracked type declaring the member.
  const accesses = []
  for (const { file, sf, nodes } of perFile) {
    for (const n of nodes) {
      if (n.kind === K.PropertyAccessExpression) accesses.push({ file, sf, n, name: n.name.text, recv: n.expression })
      else if (n.kind === K.ElementAccessExpression && (n.argumentExpression?.kind === K.StringLiteral || n.argumentExpression?.kind === K.NoSubstitutionTemplateLiteral)) accesses.push({ file, sf, n, name: n.argumentExpression.text, recv: n.expression })
    }
  }
  const byName = new Map()
  for (const a of accesses) {
    if (!byName.has(a.name)) byName.set(a.name, [])
    byName.get(a.name).push(a)
  }
  const consumers = (member) => {
    const list = byName.get(member) ?? []
    if (!list.length) return []
    const recvTypes = checker.getTypeAtLocation(list.map((a) => a.recv))
    const out = []
    for (const [i, a] of list.entries()) {
      const t = recvTypes[i]
      const parts = t && t.flags & F.Union ? t.types : [t]
      if (parts.some((u) => u && tracked.has(u.id) && checker.getPropertyOfType(u, member))) out.push({ file: a.file, line: lineOf(a.sf, a.n), rev: rev?.name ?? null })
    }
    return out
  }
  return { consumers, escapes: escapes.filter((e) => e.exempt), tracked: [...tracked.values()].map((t) => checker.typeToString(t)) }
}

/**
 * Both revisions: { all: why } or { consumers(member) → [{ file, line, rev }] } (base's and head's, unioned). base, head:
 * revisions (gitRevision; head null: the working tree), with their files (head's: null for the working tree's).
 */
export async function provenance({ root, base, baseFiles, head = null, headFiles = null, changed = [] }) {
  const a = await analyseRevision({ root, rev: base, files: baseFiles, changed })
  if (a.all) return { all: a.all }
  const b = await analyseRevision({ root, rev: head, files: headFiles, changed })
  if (b.all) return { all: b.all }
  return { consumers: (m) => [...a.consumers(m).map((s) => ({ ...s, side: 0 })), ...b.consumers(m).map((s) => ({ ...s, side: 1 }))], tracked: [...new Set([...a.tracked, ...b.tracked])] }
}
