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
// changed unit (run as it loads), or a unit with no name. For a test: the import graph read here reaching no changed
// file from it (Vitest followed a way this doesn't), or a file it loads listing keys by reflection
// (Object.getOwnPropertyNames, Reflect.ownKeys, Object.getOwnPropertyDescriptors: a method by no name). A changed
// `import type` counts for nothing: it is erased before a test runs, and typecheck checks it. Changed test files and
// UNIT_SCANS' picks are affected.mjs's, whatever this leaves out. tests/relatedTests.test.ts checks each rule.
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { codeLines, gitChangedLines, gitRevision, unitsOf } from './affectedUnits.mjs'

const traverse = traverseModule.default ?? traverseModule
const runContext = createRequire(import.meta.url)('./runContext.cjs')

/** The files a code file can import (resolve's targets): a module, JSON, or a worker. */
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
const IMPORTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i
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

/**
 * The import graph of a revision's code files: { known, closure(file) }. files: the repo's paths (only those IMPORTABLE
 * count); read(file): its text or null; prefetch(files): reads them ahead (gitRevision's), optional. closure(f): f and
 * every file its imports reach. Imports are found by text (comments too: an edge too many only keeps a test).
 */
export function importGraph(files, read, prefetch) {
  const known = new Map(files.map(slashes).filter((f) => IMPORTABLE.test(f)).map((f) => [lower(f), f]))
  prefetch?.([...known.values()].filter((f) => CODE.test(f)))
  const imports = new Map()
  const edges = (f) => {
    if (!imports.has(f)) {
      const text = CODE.test(f) ? read(f) ?? '' : ''
      imports.set(f, new Set(specifiersOf(text).map((s) => resolveSpecifier(f, s, known)).filter(Boolean)))
    }
    return imports.get(f)
  }
  const closures = new Map()
  const closure = (start) => {
    if (closures.has(start)) return closures.get(start)
    const seen = new Set([start])
    const queue = [start]
    while (queue.length) {
      for (const g of edges(queue.shift())) {
        if (seen.has(g)) continue
        seen.add(g)
        queue.push(g)
      }
    }
    closures.set(start, seen)
    return seen
  }
  return { known, closure }
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
 * How a file loads a module (repo path) in a way a name search can't follow: why, or null. `export *` of it; an
 * `import * as` or default import of it used other than as `mod.name` (or a literal key) or in a type; `require` or
 * `import()` of it not taken apart at once (`const { a } = …`, `(…).a`).
 */
export function wholeUse(text, file, module) {
  const stem = esc(module.replace(/^.*\//, '').replace(/\.[^.]+$/, ''))
  const src = new RegExp(`(^|/)${stem}(\\.[a-z]+)?$`, 'i')
  const named = new RegExp(`['"\`][^'"\`\\n]*/${stem}(\\.[a-z]+)?['"\`]`, 'i')
  if (!named.test(text)) return null
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
    if (!whole.has(k)) whole.set(k, CODE.test(f) ? wholeUse(textOf(f), f, module) : null)
    return whole.get(k)
  }
  const setup = setupFiles.flatMap((s) => [...graph.closure(s)])
  const reasons = { all: new Map(), graph: 0, whole: new Map(), reflection: new Map(), named: 0 }
  for (const test of [...new Set(related.map(slashes))]) {
    const files = new Set([...graph.closure(graph.known.get(lower(test)) ?? test), ...setup])
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
  for (const kind of ['all', 'whole', 'reflection']) for (const [r, n] of reasons[kind]) why.push(`${n} related test files kept: ${r}`)
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
