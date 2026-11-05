// The window's messages agents also read (dialects, HI-2065, card 5b HI-2440; plans/2026-11-03-dialects-design.md,
// section 2, decision 13): a `msg()` descriptor is the window's text, but where Combwork renders it for an agent (a CombworkError
// the Agent API answers with, a history line, a refusal, `agentText`), agents read it too. Each keeps its one descriptor
// and its UI id; the agent-text catalogue lists it with `audience: "both"` so a dialect can override it, and the schema
// checks that override's placeholders.
//
// This module finds them by following Combwork's code, as the design's scan did:
//   - **the rendering points:** `agentText`, `englishText` (Default English stored once and said again when read; a log
//     line marked `// log` or the window's own `// window: <why>` aside), `storedText`, `workflowText` and
//     `new CombworkError(…)`; a CombworkError subclass's `super(…)`;
//   - **wrappers:** any function that passes a parameter of its own straight on to one of these (or to another wrapper),
//     found to a fixed point across files, so `combworkError(M.x)`, `columnError(M.y, …)` and `new LaneError(M.z)` are
//     rendering calls too;
//   - **the argument of each**, followed back to its descriptors: an inline `msg({…})`, a const (in the file or
//     imported), a table's entry (`ERR.archived`; with a key computed at run time, the whole table), text built from them
//     (`withValues`, `listOf`, `linesOf`, `capitalised`, `forAgents`' agent branch, `{ m, values }` and its kin), a
//     ternary's branches, and a function's return values with its parameters bound to the call's arguments.
// What it can't follow (a method's result, a field of a value, a callback's parameter, an object built in place) is an
// **unresolved call**: the guard (agentTextGuard.mjs) fails it unless its line carries
//   - `// agent-text: <name>[, <name>…]`: the table, descriptor or function (its return values) whose messages it passes,
//     which this module then follows like any argument (a name that leads to no message fails); or
//   - `// agent-protocol: <why>`: a name, a path or text already said, not wording.
// The settings catalogue (src/shared/settingsCatalog.ts) is scanned too since card 5c (HI-2441): its rows' messages are
// found through the marks on agentSetting, settingPath and settingOptions.
import { existsSync, readFileSync, statSync } from 'fs'
import { join, posix } from 'path'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { ROOT, sourceFiles } from './i18nExtract.mjs'

const traverse = traverseModule.default ?? traverseModule

/** The rendering points by name: the arguments (by index) whose text an agent reads. */
const POINTS = { agentText: [0], englishText: [0], storedText: [0], workflowText: [0] }
/** Where each point is defined: a function of the same name elsewhere (toolReplies.ts's own agentText) isn't one. */
const POINT_FILES = { agentText: 'src/shared/advanced.ts', englishText: 'src/shared/advanced.ts', storedText: 'src/shared/taskHistory.ts', workflowText: 'src/shared/workflow/texts.ts' }
/** The class whose text agents read, and the argument its constructor takes it as. */
const ERROR_CLASS = 'CombworkError'
/** Text built from parts (shared/advanced.ts): the arguments that are text of their own. */
const BUILDERS = { withValues: [0, 1], listOf: [0], linesOf: [0], capitalised: [0], forAgents: [1] }
/** Calls whose result is no message to follow: an agent message (catalogued on its own), an error's own text (found where it was thrown). */
/** Functions that say text kept as data (its messages found where it was made, at the call that formatted it). */
const OWN_DATA = new Set(['agentField', 'storedForAgents', 'agentInstallInfo', 'installInfoIn'])
/** Calls that run a callback in a scope and give back what it returns. */
const SCOPED = new Set(['withCardNames', 'inDefaultDialect', 'inDialectOf', 'inWorkspace'])
const NOTHING = new Set(['saidText', 'agentMsg', 'errorText', 'say', 'String', 'cardRef', 'basename', 'userText'])

/** English formatted for any reader (the Default's, whatever dialect reads it): only the agent-text module may, and the log. */
const ONE_WAY = { englishText: 'src/shared/advanced.ts', englishError: 'src/main/combworkError.ts', workflowEnglish: 'src/shared/workflow/texts.ts', problemEnglish: 'src/main/workflow/optionsForm.ts', agentEnglish: 'src/main/tasks.ts' }
/** Where they are defined, and the formatting itself lives. */
const ONE_WAY_FREE = [/^src\/shared\/advanced\.ts$/, /^src\/main\/combworkError\.ts$/, /^src\/shared\/agentText\//]
/** A call inside a log line (`log.warn(…)`): the log's English. */
const inLogCall = (p) => !!p.findParent((q) => q.isCallExpression() && q.node.callee.type === 'MemberExpression' && q.node.callee.object.type === 'Identifier' && /^(log|logger|console)$/.test(q.node.callee.object.name))

/** Files left out: the window's. */
const LEFT_OUT = [/^src\/renderer\//, /^src\/preload\//, /^src\/main\/ipc\.ts$/]
export const isScanned = (rel) => /^src\/(main|shared)\//.test(rel) && !LEFT_OUT.some((re) => re.test(rel)) && !/\.test\.tsx?$/.test(rel)

const calleeName = (c) => (c?.type === 'Identifier' ? c.name : (c?.type === 'MemberExpression' || c?.type === 'OptionalMemberExpression') && !c.computed && c.property.type === 'Identifier' ? c.property.name : '')
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The text of a literal: a string, a template with no substitutions, or those joined with +; undefined otherwise. */
function literalText(n) {
  if (!n) return undefined
  if (n.type === 'StringLiteral') return n.value
  if (n.type === 'TemplateLiteral' && !n.expressions.length) return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const [a, b] = [literalText(n.left), literalText(n.right)]
    return a === undefined || b === undefined ? undefined : a + b
  }
  if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'ParenthesizedExpression') return literalText(n.expression)
  return undefined
}

/** A `msg({ id, defaultMessage, description })` call's descriptor; null when it isn't one, or isn't literal. */
function descriptorOf(node, rel) {
  if (node?.type !== 'CallExpression' || calleeName(node.callee) !== 'msg') return null
  const arg = node.arguments[0]
  if (arg?.type !== 'ObjectExpression') return null
  const field = (key) => arg.properties.find((x) => x.type === 'ObjectProperty' && ((x.key.type === 'Identifier' && x.key.name === key) || (x.key.type === 'StringLiteral' && x.key.value === key)))?.value
  const id = literalText(field('id'))
  const text = literalText(field('defaultMessage'))
  const note = field('description') ? literalText(field('description')) : undefined
  if (id === undefined || text === undefined) return null
  return { id, text, ...(note === undefined ? {} : { note }), at: `${rel}:${node.loc?.start.line}` }
}

const unwrap = (p) => {
  while (p && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSTypeAssertion'].includes(p.node?.type)) p = p.get('expression')
  return p
}

/** A comment's lines and, when it has its line to itself, the next one. */
function commentLines(c, lines) {
  const out = []
  for (let l = c.loc.start.line; l <= c.loc.end.line; l++) out.push(l)
  if (!(lines[c.loc.start.line - 1] ?? '').slice(0, c.loc.start.column).trim()) out.push(c.loc.end.line + 1)
  return out
}

/** Marks a line carries: `agent-text` names, `agent-protocol`, `log`, `window`. */
export function marksOf(ast, code) {
  const lines = code.split(/\r?\n/)
  const byLine = new Map()
  const at = (l) => {
    if (!byLine.has(l)) byLine.set(l, { names: [], protocol: false, log: false, window: false, stored: null, later: null, markLine: l })
    return byLine.get(l)
  }
  for (const c of ast.comments ?? []) {
    const v = c.value
    let m
    if ((m = /^[\s*]*agent-text:\s*([\s\S]+)$/.exec(v))) {
      // Names first, joined by commas; anything after them (a note in parentheses) is for the reader.
      const names = (/^\s*([\w.$]+(?:\s*,\s*[\w.$]+)*)/.exec(m[1])?.[1] ?? '').split(/\s*,\s*/).filter(Boolean)
      for (const l of commentLines(c, lines)) {
        at(l).names.push(...names)
        at(l).markLine = c.loc.start.line
      }
    } else if (/^[\s*]*agent-protocol:\s*\S/.test(v)) for (const l of commentLines(c, lines)) at(l).protocol = true
    else if (/^\s*log\b/.test(v)) for (const l of commentLines(c, lines)) at(l).log = true
    else if (/^\s*window:\s*\S/.test(v)) for (const l of commentLines(c, lines)) at(l).window = true
    else if ((m = /^\s*agent-stored:\s*([\s\S]*)$/.exec(v))) for (const l of commentLines(c, lines)) at(l).stored = m[1].trim()
    else if ((m = /^\s*agent-later:\s*([\s\S]*)$/.exec(v))) for (const l of commentLines(c, lines)) at(l).later = m[1].trim()
  }
  return byLine
}

/**
 * Follows Combwork's code to the window's messages agents read. Returns `messages` (id → { text, note, at }), `unresolved`
 * (each call it couldn't follow and no mark covers: { file, line, site }), and `problems` (a mark that leads nowhere).
 */
export function analyzeBoth(root = ROOT, files = sourceFiles(root).filter(isScanned)) {
  // Once per process for the same files as they are (the guard and the extractor's check, a test's several reads).
  const signature = [root, ...files.map((f) => {
    const st = statSync(join(root, f))
    return `${f}:${st.size}:${st.mtimeMs}`
  })].join('|')
  if (lastRun?.signature === signature) return lastRun.result
  const result = analyzeFiles(root, files)
  lastRun = { signature, result }
  return result
}
let lastRun = null

function analyzeFiles(root, files) {
  const mods = new Map()
  const progToMod = new Map()
  const load = (rel) => {
    if (mods.has(rel)) return mods.get(rel)
    let mod = null
    const abs = join(root, rel)
    if (existsSync(abs)) {
      const code = readFileSync(abs, 'utf8')
      try {
        const ast = parse(code, { sourceType: 'module', plugins: ['typescript', ...(rel.endsWith('x') ? ['jsx'] : [])] })
        mod = { rel, code, ast, program: null, marks: marksOf(ast, code), calls: [], classes: [] }
        progToMod.set(ast.program, mod)
        traverse(ast, {
          Program(p) {
            mod.program = p
          },
          ClassDeclaration(p) {
            if (p.node.superClass) mod.classes.push(p)
          },
          'CallExpression|NewExpression'(p) {
            // Only calls that can read text: by a name, a method of this class, a class (new) or a parent's constructor.
            const c = p.node.callee
            const namespaced = c.type === 'MemberExpression' && c.object.type === 'Identifier' && !!p.scope.getBinding(c.object.name)?.path.isImportNamespaceSpecifier()
            if (c.type === 'Identifier' || c.type === 'Super' || namespaced || (c.type === 'MemberExpression' && c.object.type === 'ThisExpression')) mod.calls.push(p)
          }
        })
      } catch {
        mod = null
      }
    }
    mods.set(rel, mod)
    return mod
  }

  /** An import's module, as a path relative to root. */
  const resolveImport = (fromRel, spec) => {
    if (!spec.startsWith('.')) return null
    const base = posix.normalize(posix.join(posix.dirname(fromRel), spec)).replace(/\.(ts|tsx|mts)$/, '')
    for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (existsSync(join(root, c))) return c
    return null
  }

  /** An exported name of a module: the path of what it is (a declarator's init, a function), or null. */
  const exported = (rel, name, depth = 0) => {
    const mod = load(rel)
    if (!mod || depth > 5) return null
    for (const st of mod.program.get('body')) {
      const n = st.node
      if (n.type === 'ExportNamedDeclaration') {
        if (n.declaration) {
          const d = st.get('declaration')
          if (d.node.type === 'VariableDeclaration') for (const v of d.get('declarations')) if (v.node.id.type === 'Identifier' && v.node.id.name === name) return v
          if ((d.node.type === 'FunctionDeclaration' || d.node.type === 'ClassDeclaration') && d.node.id?.name === name) return d
        }
        for (const s of n.specifiers ?? []) {
          const exp = s.exported.type === 'Identifier' ? s.exported.name : s.exported.value
          if (exp !== name) continue
          const local = s.local?.name ?? exp
          if (n.source) {
            const to = resolveImport(rel, n.source.value)
            return to ? exported(to, local, depth + 1) : null
          }
          const b = mod.program.scope.getBinding(local)
          return b ? b.path : null
        }
      }
      if (n.type === 'ExportAllDeclaration' && n.source) {
        const to = resolveImport(rel, n.source.value)
        const hit = to ? exported(to, name, depth + 1) : null
        if (hit) return hit
      }
    }
    return null
  }

  /** What a name refers to: the declaring path (a declarator, a function, a class, a param), across imports. */
  const defMemo = new Map()
  const definition = (p, name) => {
    const b = p.scope.getBinding(name)
    if (!b) return null
    if (defMemo.has(b)) return defMemo.get(b)
    const d = definitionOf(p, b)
    defMemo.set(b, d)
    return d
  }
  const definitionOf = (p, b) => {
    if (!b) return null
    if (b.kind === 'module') {
      const spec = b.path.node
      const decl = b.path.parentPath.node
      const to = resolveImport(fileOf(p), decl.source.value)
      if (!to) return null
      const imported = spec.type === 'ImportSpecifier' ? (spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value) : 'default'
      return exported(to, imported)
    }
    return b.path
  }
  /** The module a path is in. */
  const modOf = (p) => progToMod.get((p.findParent((x) => x.isProgram()) ?? p).node) ?? null
  const fileOf = (p) => modOf(p)?.rel ?? ''

  const messages = new Map()
  const addDesc = (d) => {
    if (!messages.has(d.id)) messages.set(d.id, d)
  }

  /** Every descriptor inside a node: a table's, deep. */
  const descsIn = (p, rel, out) => {
    p.traverse({
      CallExpression(q) {
        const d = descriptorOf(q.node, rel)
        if (d) out.push(d)
      }
    })
    const d = descriptorOf(p.node, rel)
    if (d) out.push(d)
    return out
  }

  /** The function a param belongs to, and its index; null for one in a pattern. */
  const paramOf = (path) => {
    const fn = path.parentPath
    if (!fn || !fn.isFunction()) return null
    const i = fn.node.params.indexOf(path.node)
    if (i >= 0) return { fn: fn.node, i }
    // A default value: `(m = X)`.
    if (path.parentPath.isAssignmentPattern()) {
      const f = path.parentPath.parentPath
      if (f?.isFunction()) return { fn: f.node, i: f.node.params.indexOf(path.parentPath.node) }
    }
    return null
  }

  /** A table's object (an ObjectExpression path), from an expression naming it; null when it isn't one. */
  const tableOf = (p, seen) => {
    p = unwrap(p)
    if (!p?.node) return null
    if (p.isObjectExpression()) return p
    if (p.isIdentifier()) {
      const d = definition(p, p.node.name)
      if (d?.isVariableDeclarator() && d.node.init && !seen.has(d.node)) {
        seen.add(d.node)
        return tableOf(d.get('init'), seen)
      }
      return null
    }
    if (p.isMemberExpression() && !p.node.computed && p.node.property.type === 'Identifier') {
      const t = tableOf(p.get('object'), seen)
      const prop = t?.get('properties').find((x) => x.isObjectProperty() && ((x.node.key.type === 'Identifier' && x.node.key.name === p.node.property.name) || (x.node.key.type === 'StringLiteral' && x.node.key.value === p.node.property.name)))
      return prop ? tableOf(prop.get('value'), seen) : null
    }
    return null
  }

  /**
   * Follows an expression to its descriptors. r: { descs, params: [{ fn, i }], unresolved: [why] }. `bind`: a call's
   * arguments for the params of the function whose return value this is (fn node → arg paths).
   */
  const follow = (p, r, seen = new Set(), bind = new Map(), valuesOnly = false) => {
    p = unwrap(p)
    if (!p?.node || seen.size > 400) return r
    const n = p.node
    const rel = modOf(p)?.rel ?? ''
    const fail = (why) => {
      if (!valuesOnly) r.unresolved.push(why)
      return r
    }
    switch (n.type) {
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'TemplateLiteral':
      case 'NullLiteral':
      case 'BooleanLiteral':
      case 'BinaryExpression':
        return r
      case 'Identifier': {
        if (n.name === 'undefined') return r
        const b = p.scope.getBinding(n.name)
        if (b?.kind === 'param') {
          const at = paramOf(b.path)
          if (!at) return fail('a value bound by destructuring')
          const bound = bind.get(at.fn)
          if (bound) return bound[at.i] ? follow(bound[at.i], r, seen, bind, valuesOnly) : r
          r.params.push({ ...at, values: valuesOnly })
          return r
        }
        const d = definition(p, n.name)
        if (!d) return fail('a name it can\'t find')
        if (seen.has(d.node)) return r
        seen.add(d.node)
        if (d.isVariableDeclarator()) {
          if (d.node.id.type !== 'Identifier') return fail('a value bound by destructuring')
          const kind = d.parentPath.node.kind
          if (kind !== 'const' || !d.node.init) return fail('a variable')
          return follow(d.get('init'), r, seen, bind, valuesOnly)
        }
        return fail('a name that isn\'t text')
      }
      case 'CallExpression': {
        const name = calleeName(n.callee)
        const d = descriptorOf(n, rel)
        if (d) {
          r.descs.push(d)
          return r
        }
        if (NOTHING.has(name)) return r
        // A scope's helper (withCardNames, inDefaultDialect, inDialectOf): the text its callback returns.
        if (SCOPED.has(name)) {
          const cb = p.get('arguments').find((a) => a.isFunction())
          if (cb) {
            const body = cb.get('body')
            if (!body.isBlockStatement()) return follow(body, r, seen, bind, valuesOnly)
          }
        }
        if (Object.hasOwn(BUILDERS, name) && n.callee.type === 'Identifier') {
          for (const i of BUILDERS[name]) if (p.get('arguments')[i]) follow(p.get('arguments')[i], r, seen, bind, valuesOnly || (name === 'withValues' && i === 1))
          return r
        }
        if (n.callee.type === 'Identifier') {
          const f = definition(p, n.callee.name)
          const fnPath = f?.isVariableDeclarator() ? unwrap(f.get('init')) : f
          if (fnPath?.isFunction() && !seen.has(fnPath.node)) {
            seen.add(fnPath.node)
            const inner = new Map(bind)
            inner.set(fnPath.node, p.get('arguments'))
            const body = fnPath.get('body')
            if (!body.isBlockStatement()) return follow(body, r, seen, inner, valuesOnly)
            body.traverse({
              Function(q) {
                q.skip()
              },
              ReturnStatement(q) {
                if (q.node.argument) follow(q.get('argument'), r, seen, inner, valuesOnly)
              }
            })
            return r
          }
        }
        return fail(n.callee.type === 'MemberExpression' ? 'a method\'s result' : 'a call it can\'t follow')
      }
      case 'ConditionalExpression':
        follow(p.get('consequent'), r, seen, bind, valuesOnly)
        return follow(p.get('alternate'), r, seen, bind, valuesOnly)
      case 'LogicalExpression':
        follow(p.get('left'), r, seen, bind, valuesOnly)
        return follow(p.get('right'), r, seen, bind, valuesOnly)
      case 'ArrayExpression':
        for (const e of p.get('elements')) if (e.node) follow(e.isSpreadElement() ? e.get('argument') : e, r, seen, bind, valuesOnly)
        return r
      case 'ObjectExpression': {
        const keys = n.properties.map((x) => (x.type === 'ObjectProperty' && x.key.type === 'Identifier' ? x.key.name : x.type === 'ObjectProperty' && x.key.type === 'StringLiteral' ? x.key.value : null))
        const value = (k) => p.get('properties').find((x) => x.isObjectProperty() && (x.node.key.name === k || x.node.key.value === k))?.get('value')
        const has = (...ks) => ks.every((k) => keys.includes(k))
        if (has('m')) {
          follow(value('m'), r, seen, bind, valuesOnly)
          if (value('values')) follow(value('values'), r, seen, bind, true)
          return r
        }
        if (has('said')) return r
        if (has('shown', 'agent')) return follow(value('agent'), r, seen, bind, valuesOnly)
        if (has('list')) return follow(value('list'), r, seen, bind, valuesOnly)
        if (has('lines')) return follow(value('lines'), r, seen, bind, valuesOnly)
        if (has('cap')) return follow(value('cap'), r, seen, bind, valuesOnly)
        if (valuesOnly) {
          for (const x of p.get('properties')) if (x.isObjectProperty()) follow(x.get('value'), r, seen, bind, true)
          return r
        }
        return fail('an object built in place')
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        if (n.computed && n.property.type !== 'StringLiteral' && n.property.type !== 'NumericLiteral') {
          // A table by a key known at run time: the whole table.
          const t = tableOf(p.get('object'), new Set())
          if (t) {
            for (const d of descsIn(t, rel, [])) r.descs.push(d)
            return r
          }
          return fail('a field of a value')
        }
        const key = n.computed ? String(n.property.value) : n.property.name
        const t = tableOf(p.get('object'), new Set())
        if (t) {
          const prop = t.get('properties').find((x) => x.isObjectProperty() && ((x.node.key.type === 'Identifier' && x.node.key.name === key) || (x.node.key.type === 'StringLiteral' && x.node.key.value === key)))
          if (prop) return follow(prop.get('value'), r, seen, bind, valuesOnly)
        }
        return fail('a field of a value')
      }
      default:
        return fail(n.type === 'NewExpression' ? 'an object built in place' : 'a computed value')
    }
  }

  /** An argument followed (once: what it leads to doesn't change as wrappers are found). */
  const followMemo = new Map()
  const followed = (arg, vals) => {
    const key = vals ? 'v' : 't'
    let m = followMemo.get(arg.node)
    if (!m) followMemo.set(arg.node, (m = {}))
    return (m[key] ??= follow(arg, { descs: [], params: [], unresolved: [] }, new Set(), new Map(), vals))
  }

  /**
   * What a mark's name leads to: { descs, agent } — the window's messages it holds (a table's, a descriptor, those a
   * function's body names or returns) and how many agent messages (`agentMsg`, said with `say()`: text already in the
   * catalogue). Both empty: the name leads nowhere.
   */
  const markDescs = (p, name, depth = 0) => {
    const out = { descs: [], agent: 0 }
    const parts = name.split('.')
    let at = definition(p, parts[0])
    if (!at) {
      // A method of a class in the file (`this.fileText()`'s).
      const mod = modOf(p)
      mod?.program.traverse({
        ClassMethod(q) {
          if (!at && q.node.key.type === 'Identifier' && q.node.key.name === parts[0]) at = q
        }
      })
    }
    if (!at) return out
    if (at.isVariableDeclarator()) at = unwrap(at.get('init'))
    for (const k of parts.slice(1)) {
      const t = at?.isObjectExpression() ? at : null
      const prop = t?.get('properties').find((x) => x.isObjectProperty() && ((x.node.key.type === 'Identifier' && x.node.key.name === k) || (x.node.key.type === 'StringLiteral' && x.node.key.value === k)))
      at = prop ? unwrap(prop.get('value')) : null
    }
    if (!at?.node) return out
    const rel = modOf(at)?.rel ?? ''
    // Agent messages: declared (agentMsg) or said (say, text already in the catalogue).
    // Hard-coded English (a sentence the prose ratchet holds, agent-text/allow/) counts too: it is agents' text already.
    const prose = (n) => (n?.type === 'StringLiteral' && /[A-Za-z]+ [A-Za-z]+/.test(n.value)) || (n?.type === 'TemplateLiteral' && n.quasis.some((q) => /[A-Za-z]+ [A-Za-z]+/.test(q.value.raw)))
    const isAgent = (n) => (n?.type === 'CallExpression' && (calleeName(n.callee) === 'agentMsg' || calleeName(n.callee) === 'say')) || prose(n)
    const countAgent = (q) => {
      if (isAgent(q.node)) out.agent++
      q.traverse({
        'CallExpression|StringLiteral|TemplateLiteral'(c) {
          if (isAgent(c.node)) out.agent++
        }
      })
    }
    if (at.isFunction() || at.isClassMethod() || at.isClassDeclaration()) {
      descsIn(at, rel, out.descs)
      countAgent(at)
      // The tables its body names (`t(M.x)`), and what it returns.
      const r = { descs: [], params: [], unresolved: [] }
      at.traverse({
        MemberExpression(q) {
          if (tableOf(q.get('object'), new Set())) follow(q, r, new Set(), new Map(), true)
        },
        ReturnStatement(q) {
          if (q.node.argument) follow(q.get('argument'), r, new Set(), new Map(), true)
        }
      })
      if (at.isArrowFunctionExpression() && !at.get('body').isBlockStatement()) follow(at.get('body'), r, new Set(), new Map(), true)
      out.descs.push(...r.descs)
      // Its own marks (a function returning a value kept elsewhere names where its messages are).
      const mod = modOf(at)
      const { start, end } = (at.parentPath?.isVariableDeclarator() ? at.parentPath.parentPath : at).node.loc ?? at.node.loc
      if (mod && depth < 3)
        for (const [l, mk] of mod.marks)
          if (l >= start.line - 1 && l <= end.line)
            for (const nm of mk.names) {
              const more = markDescs(at, nm, depth + 1)
              out.descs.push(...more.descs)
              out.agent += more.agent
            }
      return out
    }
    descsIn(at, rel, out.descs)
    countAgent(at)
    return out
  }

  for (const rel of files) load(rel)

  // The CombworkError subclasses, by class node, and what each constructor passes to its parent: the wrappers' seed.
  const wrappers = new Map()
  const errorClasses = new Set()
  /** The class a `new X(…)` makes, when it is CombworkError or one of its subclasses: its node, or the name CombworkError. */
  const errorClassOf = (p) => {
    const c = p.node.callee
    if (c.type !== 'Identifier') return null
    if (c.name === ERROR_CLASS) return ERROR_CLASS
    const d = definition(p, c.name)
    if (d?.isClassDeclaration() && d.node.id?.name === ERROR_CLASS && fileOf(d) === 'src/main/combworkError.ts') return ERROR_CLASS
    return d?.isClassDeclaration() && errorClasses.has(d.node) ? d.node : null
  }
  // Subclasses to a fixed point (a subclass of a subclass).
  for (let grew = true; grew; ) {
    grew = false
    for (const mod of mods.values()) {
      if (!mod) continue
      for (const p of mod.classes) {
        const s = p.node.superClass
        if (!s || s.type !== 'Identifier' || errorClasses.has(p.node)) continue
        const d = s.name === ERROR_CLASS ? ERROR_CLASS : definition(p, s.name)
        const isBase = d !== ERROR_CLASS && d?.isClassDeclaration?.() && d.node.id?.name === ERROR_CLASS && fileOf(d) === 'src/main/combworkError.ts'
        if (d === ERROR_CLASS || isBase || (d?.isClassDeclaration?.() && errorClasses.has(d.node))) {
          errorClasses.add(p.node)
          grew = true
        }
      }
    }
  }

  /**
   * What a call's callee is, whatever it is called here: its definition (through an import's alias, a re-export or a
   * namespace import), the name it is declared with, and the file it is declared in. Null for one it can't follow.
   */
  const identity = (p) => {
    const c = p.node.callee
    let d = null
    if (c.type === 'Identifier') d = definition(p, c.name)
    else if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.type === 'Identifier') {
      const b = p.scope.getBinding(c.object.name)
      if (b?.path.isImportNamespaceSpecifier()) {
        const to = resolveImport(fileOf(p), b.path.parentPath.node.source.value)
        d = to ? exported(to, c.property.name) : null
      }
    }
    if (!d?.node) return null
    const name = d.isVariableDeclarator() ? (d.node.id.type === 'Identifier' ? d.node.id.name : '') : (d.node.id?.name ?? '')
    return { def: d, name, file: fileOf(d) }
  }

  /** The argument indexes of a call agents read text through: a rendering point, a wrapper, a CombworkError's class. */
  const readsAt = (p) => {
    const n = p.node
    // Text as data said for an agent (agentField and its kin): its messages are found where the data was made.
    const id = p.isNewExpression() || n.callee.type === 'Super' ? null : identity(p)
    if (OWN_DATA.has(id?.name ?? calleeName(n.callee))) return null
    if (p.isNewExpression()) {
      const cls = errorClassOf(p)
      if (cls === ERROR_CLASS) return [[0, false]]
      if (!cls) return null
      const ctor = cls.body.body.find((m) => m.type === 'ClassMethod' && m.kind === 'constructor')
      if (!ctor) {
        // No constructor of its own: its parent's arguments.
        let parent = cls
        for (let i = 0; i < 5 && parent; i++) {
          const s = parent.superClass
          if (s?.name === ERROR_CLASS) return [[0, false]]
          const d = s ? definition(p, s.name) : null
          if (d?.isClassDeclaration() && d.node.id?.name === ERROR_CLASS && fileOf(d) === 'src/main/combworkError.ts') return [[0, false]]
          parent = d?.isClassDeclaration() ? d.node : null
          const pc = parent?.body.body.find((m) => m.type === 'ClassMethod' && m.kind === 'constructor')
          if (pc) return [...(wrappers.get(pc) ?? [])]
        }
        return [[0, false]]
      }
      return wrappers.has(ctor) ? [...wrappers.get(ctor)] : []
    }
    if (n.callee.type === 'Super') {
      const cls = p.findParent((x) => x.isClassDeclaration())
      return cls && errorClasses.has(cls.node) ? [[0, false]] : null
    }
    const name = calleeName(n.callee)
    // A rendering point by what it is, not what it is called here (an import's alias, a namespace's member).
    if (id && Object.hasOwn(POINTS, id.name) && id.file === POINT_FILES[id.name]) return POINTS[id.name].map((i) => [i, false])
    let fn = null
    if (id) fn = id.def.isVariableDeclarator() ? unwrap(id.def.get('init'))?.node : id.def.node
    else if (n.callee.type === 'MemberExpression' && n.callee.object.type === 'ThisExpression' && name) {
      const cls = p.findParent((x) => x.isClassBody())
      fn = cls?.node.body.find((m) => (m.type === 'ClassMethod' || m.type === 'ClassProperty') && m.key.name === name)
      if (fn?.type === 'ClassProperty') fn = fn.value
    }
    return fn && wrappers.has(fn) ? [...wrappers.get(fn)] : null
  }

  // Wrappers to a fixed point: a function passing a parameter of its own to a call that reads text.
  const owner = (p) => {
    const f = p.getFunctionParent()
    return f?.node ?? null
  }
  for (let grew = true, round = 0; grew && round < 12; round++) {
    grew = false
    for (const mod of mods.values()) {
      if (!mod) continue
      for (const p of mod.calls) {
        const at = readsAt(p)
        if (!at?.length) continue
        const line = mod.marks.get(p.node.loc?.start.line)
        if (line?.log || line?.window) continue
        for (const [i, vals] of at) {
          const arg = p.get('arguments')[i]
          if (!arg?.node) continue
          const r = followed(arg, vals)
          const f = owner(p)
          for (const q of r.params) {
            if (q.fn !== f && !p.findParent((x) => x.node === q.fn)) continue
            const m = wrappers.get(q.fn) ?? new Map()
            // A parameter that is text anywhere is text; one that only ever goes into values is values.
            const was = m.get(q.i)
            const now = was === undefined ? q.values : was && q.values
            if (was !== now) {
              m.set(q.i, now)
              wrappers.set(q.fn, m)
              grew = true
            }
          }
        }
      }
    }
  }

  // An agent-later mark names the card that takes it on: one that names none is reported once per line.
  const laterSeen = new Set()
  const laterProblem = (rel, lineNo) => {
    if (laterSeen.has(`${rel}:${lineNo}`)) return
    laterSeen.add(`${rel}:${lineNo}`)
    problems.push(`LATER WITHOUT A CARD ${rel}:${lineNo}  agent-later: <card key> <what it does>: name the card that takes it on`)
  }
  // The calls, once more: each one's messages, or what it couldn't follow.
  const unresolved = []
  const problems = []
  for (const rel of files) {
    const mod = load(rel)
    if (!mod) continue
    for (const p of mod.calls) {
      const at = readsAt(p)
      if (!at?.length) continue
      const lineNo = p.node.loc?.start.line
      const line = mod.marks.get(lineNo)
      if (line?.log || line?.window) continue
      const named = line?.names ?? []
      const whys = []
      for (const [i, vals] of at) {
        const arg = p.get('arguments')[i]
        if (!arg?.node) continue
        const r = followed(arg, vals)
        for (const d of r.descs) addDesc(d)
        whys.push(...r.unresolved)
      }
      for (const name of named) {
        const { descs, agent } = markDescs(p, name)
        if (!descs.length && !agent) problems.push(`MARK LEADS NOWHERE ${rel}:${line.markLine}  agent-text: ${name} names no table, message or function of messages here`)
        for (const d of descs) addDesc(d)
      }
      if (line?.later !== null && line?.later !== undefined && !/^[A-Z]+-\d+\b/.test(line.later)) laterProblem(rel, lineNo)
      if (whys.length && !named.length && !line?.protocol && !line?.later) {
        const callee = p.node.callee.type === 'Super' ? 'super' : calleeName(p.node.callee) || '?'
        const args = at.map(([i]) => p.node.arguments[i]).filter(Boolean).map((a) => clip(norm(mod.code.slice(a.start, a.end))))
        unresolved.push({ file: rel, line: lineNo, site: `unresolved|${callee}|${args.join(' , ')}`, why: [...new Set(whys)].join('; ') })
      }
    }
  }
  // Marks on lines with no call that reads text (a caller of a method the scan can't follow): their messages too.
  for (const rel of files) {
    const mod = load(rel)
    if (!mod) continue
    const done = new Set(mod.calls.filter((p) => readsAt(p)?.length).map((p) => p.node.loc?.start.line))
    const covered = new Set([...mod.marks].filter(([l, m]) => m.names.length && done.has(l)).map(([, m]) => m.markLine))
    const seenMarks = new Set()
    for (const [, m] of mod.marks) {
      if (!m.names.length || covered.has(m.markLine) || seenMarks.has(m.markLine)) continue
      seenMarks.add(m.markLine)
      for (const name of [...new Set(m.names)]) {
        const { descs, agent } = markDescs(mod.program, name)
        if (!descs.length && !agent) problems.push(`MARK LEADS NOWHERE ${rel}:${m.markLine}  agent-text: ${name} names no table, message or function of messages here`)
        for (const d of descs) addDesc(d)
      }
    }
  }
  // One way out: English formatted outside the agent-text module, which no reader's dialect reaches.
  const oneway = []
  const declared = new Set()
  for (const mod of mods.values()) {
    if (!mod) continue
    for (const m of mod.code.matchAll(/(?:function\s*\*?\s*|(?:const|let|var)\s+|^\s*(?:export\s+)?(?:async\s+)?(?:private\s+|public\s+)?)([A-Za-z_$][\w$]*)\s*(?:=|\(|<)/gm)) declared.add(m[1])
  }
  for (const rel of files) {
    const mod = load(rel)
    if (!mod || ONE_WAY_FREE.some((re) => re.test(rel))) continue
    for (const p of mod.calls) {
      // The formatter by what it is: an import's alias or a namespace's member is the same function.
      const id = identity(p)
      if (!id || !Object.hasOwn(ONE_WAY, id.name) || id.file !== ONE_WAY[id.name]) continue
      const name = id.name
      const lineNo = p.node.loc?.start.line
      const mk = mod.marks.get(lineNo)
      if (mk?.later !== null && mk?.later !== undefined) {
        if (!/^[A-Z]+-\d+\b/.test(mk.later)) laterProblem(rel, lineNo)
        continue
      }
      if (mk?.log || mk?.window || mk?.protocol || inLogCall(p)) continue
      if (mk?.stored !== null && mk?.stored !== undefined) {
        const renderer = /^[A-Za-z_$][\w$]*/.exec(mk.stored)?.[0]
        if (!renderer || !declared.has(renderer)) problems.push(`STORED WITHOUT A RENDERER ${rel}:${lineNo}  agent-stored: <renderer> names the function that says it again for each reader; ${renderer ?? 'none'} isn't one`)
        continue
      }
      const args = p.node.arguments.map((a) => clip(norm(mod.code.slice(a.start, a.end)))).join(' , ')
      oneway.push({ file: rel, line: lineNo, site: `oneway|${name}|${args}` })
    }
  }
  return { oneway, messages: Object.fromEntries([...messages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, d]) => [id, d])), unresolved, problems }
}
