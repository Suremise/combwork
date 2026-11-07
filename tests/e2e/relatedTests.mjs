// Which of the unit test files Vitest relates to a change the change needs (HI-2677): the focused picker's unit half
// (affected.mjs, pickTests), by the parts of each changed file the change touches rather than by the file. Vitest's
// `list --changed` takes every test whose imports reach a changed file, however far. A related test stays when, among
// the files its imports reach (itself and vitest.config.ts's setup files included, the changed file aside), one names a
// changed unit or what holds it, or uses the changed file in a way a name search can't follow; else it is left out.
//
// Why a name is enough, with no residual (HI-2677/s11): a test runs only what the files it loads run, and a unit runs
// without being named only through an object holding it, reached by a key a search can't see (`x[\`set${k}\`]()`, a key
// read from a fixture, Object.keys, for-in). That object is one of three, and each is named where it is obtained:
// - the module's namespace: a file using it other than as `mod.name` keeps the test (wholeUse: `import * as` or a
//   default import used otherwise, `export *`, `require` or `import()` not taken apart by name at once,
//   vi.importActual, vi.mock with the original);
// - a unit holding it (a channel's or a command's table, a const listing it): the units enclosing a changed line are
//   searched too, and so, in the changed file, every unit naming one of those, until none is added (a function
//   returning the table, a method calling another by `this.x`, `on('x', fn)` in a function);
// - an instance of its class: a member adds its class, and with it whatever in the file names the class (a factory, an
//   instance such as `workspace`). So WorkspaceService's members keep nearly every test of main (HI-2678 narrows those
//   by which receivers can be one).
// Names are searched as whole words in each file's text, comments and strings too (a string is how a key or a spied
// method is named), in the revision tested; a key (a channel, a command id) by its key's boundaries.
//
// Whatever it can't tell keeps every related test, with a reason. For a changed file (narrowChange's `all`): not code,
// added or deleted, unparseable in either revision, a changed line outside every unit (module code, an import that
// isn't type-only, a constructor) or in a class's field (set as an instance is made), its own module code naming a
// changed unit (run as it loads), or a unit with no name. For a test: a file it loads whose own imports can't all be
// known (importGraph's unknownOf: a path worked out at run time, one not in the repository, a file unreadable or
// unparseable), whatever else of it reaches the change; the import graph read here reaching no changed file from it
// (Vitest followed a way this doesn't); or a file it loads listing keys by reflection (Object.getOwnPropertyNames,
// Reflect.ownKeys, Object.getOwnPropertyDescriptors: a method by no name). Whether a file uses the changed module whole
// is by the graph's resolution of its specifiers (a directory's index, `.js` for `.ts`), not by a file name. A changed
// `import type` counts for nothing: it is erased before a test runs, and typecheck checks it. Changed test files and
// UNIT_SCANS' picks are affected.mjs's, whatever this leaves out. tests/relatedTests.test.ts checks each rule.
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { codeLines, gitChangedLines, gitRevision, unitsOf } from './affectedUnits.mjs'

const traverse = traverseModule.default ?? traverseModule
const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** The files whose imports are read: code. Any file can be imported (JSON, a stylesheet, `?raw` text). */
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']
/**
 * vitest.config.ts's aliases: a bare specifier to a repo path, or null (a package). Electron's stub imports none of
 * Combwork's code, so it is left out: a test reaching a change only through it is one the graph doesn't connect, kept.
 */
const ALIASES = { '@shared': 'src/shared' }

const slashes = (p) => p.replace(/\\/g, '/')
const lower = (p) => slashes(p).toLowerCase()
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A list for a diagnostic line, bounded (the picker's diagnostics are kept to a few KB). */
const few = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '))
const keyName = (k) => (k?.type === 'Identifier' ? k.name : k?.type === 'StringLiteral' ? k.value : null)

/** The specifiers a file names as imports, by text (import, export from, import(), require(), vi.mock and its kin). */
export function specifiersOf(text) {
  const out = new Set()
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*)(['"`])([^'"`\n]+)\1/g
  for (const m of text.matchAll(re)) out.add(m[2])
  return [...out]
}

/** A specifier, from a file, as a repo path among files (a Set of lower-cased paths → their path), or null (a package). */
export function resolveSpecifier(from, spec, known) {
  let s = spec.replace(/[?#].*$/, '')
  let base
  const alias = Object.keys(ALIASES).find((a) => s === a || s.startsWith(`${a}/`))
  if (alias) {
    base = ALIASES[alias] + s.slice(alias.length)
  } else if (s.startsWith('.')) {
    const dir = slashes(from).replace(/\/?[^/]*$/, '')
    const parts = dir ? dir.split('/') : []
    for (const seg of s.split('/')) {
      if (seg === '.' || seg === '') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    base = parts.join('/')
  } else return null
  for (const ext of EXTENSIONS) {
    const hit = known.get(lower(base + ext))
    if (hit) return hit
  }
  // A `.js` specifier for its TypeScript source (`./x.js` → x.ts).
  const ts = base.replace(/\.(m|c)?js$/i, (_, k) => `.${k ?? ''}ts`)
  if (ts !== base) return known.get(lower(ts)) ?? null
  return null
}

/** A path a specifier may name in the repository: relative, or by an alias (a package's isn't). */
const repoPath = (s) => s.startsWith('.') || Object.keys(ALIASES).some((a) => s === a || s.startsWith(`${a}/`))
/** Text that may load a module by a path the text search can't read: parsed to tell (a comment or a string is nothing). */
const MAYBE_COMPUTED = /\b(?:import|require)\s*\(\s*[^\s'"]|import\.meta\.glob|createRequire/

/** A glob of import.meta.glob, from a file, as a RegExp over repo paths (lower case); a negated one is none. */
function globRegex(from, glob) {
  if (glob.startsWith('!')) return null
  const dir = slashes(from).replace(/\/?[^/]*$/, '')
  const parts = dir ? dir.split('/') : []
  for (const seg of glob.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  let re = ''
  const g = lower(parts.join('/'))
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') re += '('
    else if (c === '}') re += ')'
    else if (c === ',') re += '|'
    else re += esc(c)
  }
  return new RegExp(`^${re}$`)
}

/**
 * The modules a file loads that its text alone doesn't show, by parsing it: { edges, unknown } (unknown: why the file's
 * imports can't all be known: a path worked out at run time, one not in the repository, a glob that isn't a literal,
 * or the file not parsing). import.meta.glob's literal globs are edges to the files they match (a negated one is
 * ignored: more edges, never fewer).
 */
function parsedPaths(text, file, known) {
  const edges = new Set()
  let unknown = null
  const unsure = (why) => {
    unknown ??= why
  }
  let ast
  try {
    ast = parse(text, { sourceType: 'unambiguous', plugins: [...(/\.(ts|tsx|mts|cts)$/i.test(file) ? [['typescript', { dts: /\.d\.ts$/i.test(file) }]] : []), ...(/\.(tsx|jsx|js|mjs|cjs)$/i.test(file) ? ['jsx'] : [])], errorRecovery: false, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true })
  } catch (e) {
    return { edges, unknown: `doesn't parse (${e.message}), so what it loads isn't known` }
  }
  const literal = (n) => (n?.type === 'StringLiteral' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null)
  const to = (spec, node) => {
    const t = resolveSpecifier(file, spec, known)
    if (t) edges.add(t)
    else if (repoPath(spec)) unsure(`loads ${spec} (line ${node.loc?.start.line ?? '?'}), which isn't in the repository`)
  }
  const load = (arg, node) => {
    const spec = literal(arg)
    if (spec == null) unsure(`loads a module by a path worked out at run time (line ${node.loc?.start.line ?? '?'})`)
    else to(spec, node)
  }
  const requires = new Set(['require'])
  const isCreateRequire = (n) => n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'createRequire'
  traverse(ast, {
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier' && isCreateRequire(p.node.init)) requires.add(p.node.id.name)
    }
  })
  traverse(ast, {
    'ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration'(p) {
      if (p.node.source) to(p.node.source.value, p.node)
    },
    ImportExpression(p) {
      load(p.node.source, p.node)
    },
    CallExpression(p) {
      const n = p.node
      const c = n.callee
      const vi = c.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'vi' && !c.computed && ['mock', 'doMock', 'importActual', 'importMock'].includes(c.property.name)
      const glob = c.type === 'MemberExpression' && !c.computed && c.property.name === 'glob' && c.object?.type === 'MetaProperty'
      if (c.type === 'Import' || (c.type === 'Identifier' && requires.has(c.name)) || isCreateRequire(c) || vi) load(n.arguments[0], n)
      else if (glob) {
        const arg = n.arguments[0]
        const globs = arg?.type === 'ArrayExpression' ? arg.elements.map(literal) : [literal(arg)]
        if (globs.some((g) => g == null)) unsure(`globs modules by a pattern worked out at run time (line ${n.loc?.start.line ?? '?'})`)
        else {
          for (const g of globs) {
            const re = globRegex(file, g)
            if (re) for (const [k, f] of known) if (re.test(k)) edges.add(f)
          }
        }
      }
    }
  })
  return { edges, unknown }
}

/**
 * The import graph of a revision's files: { known, closure(file), edgesOf(file), unknownOf(file) }. files: the repo's
 * paths; read(file): its text or null; prefetch(files): reads them ahead (gitRevision's), optional. closure(f): f and
 * every file its imports reach. Imports are found by text (comments too: an edge too many only keeps a test), and by
 * parsing a file whose text may load modules otherwise (a computed import() or require(), createRequire,
 * import.meta.glob) or names a path the text search can't resolve. unknownOf(f): why f's imports can't all be known (a
 * path worked out at run time, one not in the repository, its text unreadable or unparseable), or null.
 */
export function importGraph(files, read, prefetch) {
  const known = new Map(files.map(slashes).map((f) => [lower(f), f]))
  prefetch?.([...known.values()].filter((f) => CODE.test(f)))
  const info = new Map()
  const infoOf = (f) => {
    if (info.has(f)) return info.get(f)
    const r = { edges: new Set(), unknown: null }
    info.set(f, r)
    if (!CODE.test(f)) return r
    const text = read(f)
    if (text == null) {
      r.unknown = `${f} couldn't be read, so what it loads isn't known`
      return r
    }
    const specs = specifiersOf(text)
    let unresolved = false
    for (const s of specs) {
      const t = resolveSpecifier(f, s, known)
      if (t) r.edges.add(t)
      else if (repoPath(s)) unresolved = true
    }
    if (unresolved || MAYBE_COMPUTED.test(text)) {
      const p = parsedPaths(text, f, known)
      for (const e of p.edges) r.edges.add(e)
      if (p.unknown) r.unknown = `${f} ${p.unknown}`
    }
    return r
  }
  const closures = new Map()
  const closure = (start) => {
    if (closures.has(start)) return closures.get(start)
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      for (const g of infoOf(queue.shift()).edges) {
        if (seen.has(g)) continue
        seen.add(g)
        queue.push(g)
      }
    }
    closures.set(start, seen)
    return seen
  }
  return { known, closure, edgesOf: (f) => infoOf(f).edges, unknownOf: (f) => infoOf(f).unknown }
}

/** Whether a file's text names a word: an identifier's boundaries, so `setAdvanced` isn't found in `setAdvancedAll`. */
const wordIn = (needle) => new RegExp(`(^|[^\\w$])${esc(needle)}($|[^\\w$])`)
/** A key's boundaries (a channel `git:status`, a command id): not part of a longer key (affectedUnits.mjs's keyIn). */
const keyIn = (needle) => new RegExp(`(^|[^\\w.:-])${esc(needle)}($|[^\\w.:-])`)

/** Reflection that lists an object's keys, methods included: it reaches a unit by no name. */
const REFLECTION = /\b(?:Object\.getOwnPropertyNames|Reflect\.ownKeys|Object\.getOwnPropertyDescriptors)\b/

const isTypeImport = (s) => s.type === 'ImportDeclaration' && (s.importKind === 'type' || (s.specifiers.length > 0 && s.specifiers.every((sp) => sp.importKind === 'type')))

/**
 * What a change to one file selects among the tests that load it: { all: why } (every one), or { needles: [{ name,
 * key }], why } (key: a channel or command, searched as a key). file: its repo path; base, head: revisions
 * (affectedUnits.mjs's gitRevision, memoryRevision); lines: { added, removed } (diffLineNumbers).
 */
export function narrowChange({ file, base, head, lines }) {
  const every = (why) => ({ all: `${file}: ${why}, so every test that loads it` })
  if (!CODE.test(file)) return every("isn't code a name search can split")
  const revs = [base, head]
  const texts = revs.map((r) => r.read(file))
  if (texts.some((t) => t == null)) return every(`added, deleted or unreadable in ${texts[0] == null ? base.name : head.name}`)
  const sides = []
  for (const [i, t] of texts.entries()) {
    try {
      sides.push(unitsOf(t, file))
    } catch (e) {
      return every(`doesn't parse in ${revs[i].name} (${e.message})`)
    }
  }
  // The changed units, with those enclosing them (by line), by id; a type-only import changed counts for nothing.
  const ids = new Set()
  for (const { side: i, line, unit } of codeLines(sides, lines)) {
    const s = sides[i]
    if (!unit) {
      const imp = s.imports.find((st) => st.loc.start.line <= line && line <= st.loc.end.line)
      if (imp && isTypeImport(imp)) continue
      return every(`line ${line} (${revs[i].name}) is in no function, method or entry`)
    }
    if (unit.member && unit.node.type.endsWith('Property')) return every(`line ${line} (${revs[i].name}) is ${unit.id}, a field, set as an instance is made`)
    for (const u of s.units) if (u.startLine <= line && line <= u.endLine) ids.add(u.id)
  }
  if (!ids.size) return { needles: [], why: `${file}: only comments or type-only imports changed` }
  // A class's member is reached through an instance, by a key a name search may not see: its class, and whatever in
  // the file names that (a factory, an instance), are what a test must name to have one.
  const classOf = (unit) => {
    if (!unit.member) return
    const cls = unit.id.slice(0, unit.id.lastIndexOf('.'))
    for (const side of sides) if (!side.units.some((u) => u.id === `class ${cls}`)) side.units.push({ id: `class ${cls}`, name: cls, kind: 'named', needle: cls, startLine: -1, endLine: -1 })
    return `class ${cls}`
  }
  // In the file itself, the units naming one of them, both revisions, until none is added; module code naming one runs
  // as the file loads, so every test that loads it. Not module code: a class's own name where it is declared, and an
  // export list (`export { f as g }`: its names are aliases, searched).
  const declared = sides.map((s) => {
    const offs = new Set()
    const ranges = []
    for (const st of s.ast.program.body) {
      const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st
      if (d?.type === 'ClassDeclaration' && d.id) offs.add(d.id.start)
      if (st.type === 'ExportNamedDeclaration' && !st.declaration && !st.source) ranges.push([st.start, st.end])
    }
    return (off) => offs.has(off) || ranges.some(([a, b]) => off >= a && off < b)
  })
  const queue = [...ids]
  const add = (id) => {
    if (ids.has(id)) return
    ids.add(id)
    queue.push(id)
  }
  while (queue.length) {
    const id = queue.shift()
    for (const s of sides) {
      for (const unit of s.units.filter((u) => u.id === id)) {
        const cls = classOf(unit)
        if (cls) add(cls)
        if (!unit.needle) return every(`${unit.id} has no name to search`)
        for (const off of namesOf(s, unit)) {
          if (s.imports.some((st) => off >= st.start && off < st.end) || declared[sides.indexOf(s)](off)) continue
          const at = s.unitAt(s.lineOf(off))
          if (!at) return every(`its module code names ${unit.name} (line ${s.lineOf(off)}, ${revs[sides.indexOf(s)].name}), which runs as it loads`)
          add(at.id)
        }
      }
    }
  }
  const needles = new Map()
  for (const s of sides) {
    for (const u of s.units) {
      if (!ids.has(u.id)) continue
      if (!u.needle) return every(`${u.id} has no name to search`)
      needles.set(`${u.kind}\0${u.needle}`, { name: u.needle, key: u.kind === 'key' })
      if (u.alias) needles.set(`named\0${u.alias}`, { name: u.alias, key: false })
    }
  }
  return { needles: [...needles.values()], why: `${file}: ${few([...ids])}` }
}

/** Where a file names a unit, by offset (affectedUnits.mjs's occurrences): identifier tokens and strings of its name, or a key's strings. */
function namesOf(parsed, unit) {
  const re = unit.kind === 'key' ? keyIn(unit.needle) : null
  return parsed.tokens
    .filter((t) => {
      const str = (t.type?.label === 'string' || t.type?.label === 'template') && typeof t.value === 'string'
      if (re) return str && re.test(t.value)
      return ((t.type?.label === 'name' || t.type?.label === 'jsxName') && t.value === unit.needle) || (str && t.value === unit.needle)
    })
    .map((t) => t.start)
}

/**
 * How a file loads a module in a way a name search can't follow: why, or null. module: its repo path, for the reasons;
 * isModule(spec): whether a specifier in the file is that module, as the import graph resolves it (`../src/service` for
 * src/service/index.ts, `./x.js` for x.ts). `export *` of it; an `import * as` or default import of it used other than as
 * `mod.name` (or a literal key) or in a type; `require` or `import()` of it not taken apart at once (`const { a } = …`,
 * `(…).a`); vi.importActual or vi.importMock of it; vi.mock of it from its original.
 */
export function wholeUse(text, file, module, isModule) {
  const src = { test: (spec) => typeof spec === 'string' && isModule(spec) }
  let ast
  try {
    ast = parse(text, { sourceType: 'unambiguous', plugins: [...(/\.(ts|tsx|mts|cts)$/i.test(file) ? [['typescript', { dts: /\.d\.ts$/i.test(file) }]] : []), ...(/\.(tsx|jsx|js|mjs|cjs)$/i.test(file) ? ['jsx'] : [])], errorRecovery: false, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true })
  } catch (e) {
    return `doesn't parse (${e.message})`
  }
  let hit = null
  const unsafe = (node, what) => {
    hit ??= `${what} (line ${node.loc?.start.line ?? '?'})`
  }
  const up = (p) => {
    let q = p
    while (q.parentPath && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'AwaitExpression'].includes(q.parentPath.node.type)) q = q.parentPath
    return q
  }
  const byName = (q) => {
    const par = q.parentPath?.node
    // `.then` (`import(m).then((ns) => …)`) hands the namespace on whole.
    if ((par?.type === 'MemberExpression' || par?.type === 'OptionalMemberExpression') && par.object === q.node) return (!par.computed || par.property.type === 'StringLiteral') && !['then', 'catch', 'finally'].includes(keyName(par.property))
    if (par?.type === 'VariableDeclarator' && par.init === q.node && par.id.type === 'ObjectPattern') return par.id.properties.every((p) => p.type === 'ObjectProperty' && !p.computed)
    return false
  }
  traverse(ast, {
    ExportAllDeclaration(p) {
      if (src.test(p.node.source.value)) unsafe(p.node, `re-exports all of ${module}`)
    },
    ImportDeclaration(p) {
      if (!src.test(p.node.source.value) || p.node.importKind === 'type') return
      for (const sp of p.node.specifiers) {
        if (sp.type === 'ImportSpecifier') continue
        const b = p.scope.getBinding(sp.local.name)
        for (const ref of b?.referencePaths ?? []) {
          if (ref.findParent((a) => a.isTSTypeQuery() || a.isTSTypeReference())) continue
          if (!byName(up(ref))) unsafe(ref.node, `uses ${module} whole as ${sp.local.name}`)
        }
      }
    },
    'CallExpression|ImportExpression'(p) {
      const n = p.node
      const isImport = n.type === 'ImportExpression' || n.callee?.type === 'Import'
      const isRequire = n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require'
      // vi.importActual(m), vi.importMock(m), and vi.mock(m, (importOriginal) => …): the module's namespace, whole.
      const viCall = n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'vi' && !n.callee.computed ? n.callee.property.name : null
      const isActual = viCall === 'importActual' || viCall === 'importMock'
      const isMock = (viCall === 'mock' || viCall === 'doMock') && n.arguments.some((a, i) => i > 0 && /Function/.test(a.type) && a.params.length > 0)
      if (!isImport && !isRequire && !isActual && !isMock) return
      const arg = n.type === 'ImportExpression' ? n.source : n.arguments[0]
      const spec = arg?.type === 'StringLiteral' ? arg.value : arg?.type === 'TemplateLiteral' && !arg.expressions.length ? arg.quasis[0].value.cooked : null
      if (spec == null || !src.test(spec)) return
      if (isMock) unsafe(n, `mocks ${module} from its original, whole`)
      else if (isActual || !byName(up(p))) unsafe(n, `${isImport ? 'imports' : isRequire ? 'requires' : 'imports the actual'} ${module} whole`)
    }
  })
  return hit
}

/**
 * The related tests a change needs: { keep: [tests], dropped: [tests], why: [lines] }. related: Vitest's (repo paths);
 * changes: { file: narrowChange's result } for each changed file; graph: importGraph of the revision tested; read: its
 * texts; setupFiles: those every test loads (vitest.config.ts).
 */
export function narrowRelated({ related, changes, graph, read, setupFiles = [] }) {
  const keep = []
  const dropped = []
  const why = []
  const changed = new Map(Object.entries(changes).map(([f, c]) => [lower(f), { file: f, ...c }]))
  const texts = new Map()
  const textOf = (f) => {
    if (!texts.has(f)) texts.set(f, read(f) ?? '')
    return texts.get(f)
  }
  const regexes = new Map()
  const reOf = (n) => {
    const k = `${n.key ? 'k' : 'w'}\0${n.name}`
    if (!regexes.has(k)) regexes.set(k, n.key ? keyIn(n.name) : wordIn(n.name))
    return regexes.get(k)
  }
  const whole = new Map()
  const wholeOf = (f, module) => {
    const k = `${f}\0${module}`
    // Only a file importing it directly can use it whole (a barrel re-exporting it whole is one, and checked as such).
    if (!whole.has(k)) whole.set(k, CODE.test(f) && graph.edgesOf(f).has(module) ? wholeUse(textOf(f), f, module, (spec) => resolveSpecifier(f, spec, graph.known) === module) : null)
    return whole.get(k)
  }
  const setup = setupFiles.flatMap((s) => [...graph.closure(s)])
  const reasons = { all: new Map(), graph: 0, unknown: new Map(), whole: new Map(), reflection: new Map(), named: 0 }
  for (const test of [...new Set(related.map(slashes))]) {
    const files = new Set([...graph.closure(graph.known.get(lower(test)) ?? test), ...setup])
    // A file it loads whose own imports aren't all known may load the change: its closure isn't the whole of it.
    const unsure = [...files].map((f) => graph.unknownOf(f)).find(Boolean)
    if (unsure) {
      keep.push(test)
      reasons.unknown.set(unsure, (reasons.unknown.get(unsure) ?? 0) + 1)
      continue
    }
    const reached = [...files].map((f) => changed.get(lower(f))).filter(Boolean)
    if (!reached.length) {
      keep.push(test)
      reasons.graph++
      continue
    }
    let reason = null
    for (const c of reached) {
      if (c.all) {
        reason = ['all', c.all]
        break
      }
      for (const f of files) {
        if (lower(f) === lower(c.file)) continue
        const t = textOf(f)
        if (c.needles.some((n) => reOf(n).test(t))) {
          reason = ['named']
          break
        }
        const w = wholeOf(f, c.file)
        if (w) {
          reason = ['whole', `${f} ${w}`]
          break
        }
        if (c.needles.length && REFLECTION.test(t)) {
          reason = ['reflection', `${f} lists keys by reflection`]
          break
        }
      }
      if (reason) break
    }
    if (!reason) {
      dropped.push(test)
      continue
    }
    keep.push(test)
    if (reason[0] === 'named') reasons.named++
    else reasons[reason[0]].set(reason[1], (reasons[reason[0]].get(reason[1]) ?? 0) + 1)
  }
  for (const c of changed.values()) why.push(c.all ?? `${c.why}${c.needles.length ? ` (searched: ${few(c.needles.map((n) => n.name))})` : ''}`)
  if (reasons.named) why.push(`${reasons.named} related test files load a file naming what changed`)
  if (reasons.graph) why.push(`${reasons.graph} related test files kept: the imports read here don't reach a changed file from them`)
  // Bounded: a reason a line, at most a few of each kind (the picker's diagnostics are kept to a few KB).
  for (const kind of ['all', 'unknown', 'whole', 'reflection']) {
    const rows = [...reasons[kind]]
    for (const [r, n] of rows.slice(0, 8)) why.push(`${n} related test files kept: ${r}`)
    if (rows.length > 8) why.push(`${rows.slice(8).reduce((a, [, n]) => a + n, 0)} more related test files kept for ${rows.length - 8} more such reasons`)
  }
  if (dropped.length) why.push(`${dropped.length} related test files left out: nothing they load names what changed`)
  return { keep: keep.sort(), dropped: dropped.sort(), why }
}

/** vitest.config.ts's setupFiles (every test loads them), from its text: null when it can't be read there. */
export function setupFilesOf(configText) {
  const m = /\bsetupFiles\s*:\s*\[([^\]]*)\]/.exec(configText ?? '')
  if (!m) return null
  const files = [...m[1].matchAll(/(['"])([^'"]+)\1/g)].map((x) => x[2])
  return /^[\s,]*$/.test(m[1].replace(/(['"])[^'"]+\1/g, '')) ? files : null
}

/**
 * narrowRelated for the picker (affected.mjs's CLI): the working tree in cwd against base (a commit), paths the changed
 * files, related Vitest's list. Never throws: anything it can't work out keeps every related test, saying why.
 */
export function narrowRelatedInTree({ cwd, base, paths, related }) {
  try {
    const revs = { base: gitRevision(cwd, base), head: gitRevision(cwd, null) }
    const git = (args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 512 * 1024 * 1024 })
    const files = [...new Set([...git(['ls-files', '-z']).split('\0'), ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')].filter(Boolean))]
    const setupFiles = setupFilesOf(revs.head.read('vitest.config.ts'))
    if (!setupFiles) return { keep: [...related], dropped: [], why: ["vitest.config.ts's setupFiles couldn't be read, so every related unit test"] }
    const changes = {}
    for (const file of paths) {
      try {
        changes[file] = narrowChange({ file, base: revs.base, head: revs.head, lines: gitChangedLines(cwd, base, null, file) })
      } catch (e) {
        changes[file] = { all: `${file}: its changed parts couldn't be worked out (${e.message}), so every test that loads it` }
      }
    }
    return narrowRelated({ related, changes, graph: importGraph(files, (f) => revs.head.read(f)), read: (f) => revs.head.read(f), setupFiles })
  } catch (e) {
    return { keep: [...related], dropped: [], why: [`the related unit tests couldn't be narrowed (${e.message}), so every one`] }
  }
}
