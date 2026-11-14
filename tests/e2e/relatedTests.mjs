// Which of the unit test files Vitest relates to a change the change needs (HI-2677): the focused picker's unit half
// (affected.mjs, pickTests), by the parts of each changed file the change touches rather than by the file. Vitest's
// `list --changed` takes every test whose imports reach a changed file, however far. A related test stays when, among
// the files its imports reach (itself and vitest.config.ts's setup files included, the changed file aside), one names a
// changed unit or what holds it, or uses the changed file in a way a name search can't follow; else it is left out.
//
// Why a name is enough, with no residual (HI-2677/s11): a test runs only what the files it loads run, and a unit runs
// without being named only through an object holding it, reached by a key a search can't see (`x[\`set${k}\`]()`, a key
// read from a fixture, Object.keys, for-in). That object is one of three, and each is named where it is obtained:
// - the module's namespace: a file using it other than as `mod.name` keeps the test (fileLoads' whole uses: `import *
//   as` or a default import used otherwise, `export *`, `require`, a createRequire require or `import()` not taken apart
//   by name at once, vi.importActual, vi.mock with the original, import.meta.glob of it);
// - a unit holding it (a channel's or a command's table, a const listing it): the units enclosing a changed line are
//   searched too, and so, in the changed file, every unit naming one of those, until none is added (a function
//   returning the table, a method calling another by `this.x`, `on('x', fn)` in a function);
// - an instance of its class: a member adds its class, and with it whatever in the file names the class (a factory, an
//   instance such as `workspace`). So WorkspaceService's members keep nearly every test of main (HI-2678 narrows those
//   by which receivers can be one).
// Names are searched as whole words in each file's text, comments and strings too (a string is how a key or a spied
// method is named), in the revision tested; a key (a channel, a command id) by its key's boundaries.
//
// What a file loads is an allowlist, not a list of loader spellings (the Assistant's design after round 3): every code
// file reached is parsed, a closed set of literal loading forms is taken (fileLoads: static imports, `import('<x>')`,
// `require('<x>')`, a createRequire require, Vitest's mock and importActual with a literal path, a literal
// import.meta.glob) and blanked with the comments, the types and the strings, and the gate (LOADS_CODE, VI_SAFE) reads
// what is left: any token of another way to load or run code (require, import(, import.meta, a Vitest loader, the module
// module, eval, vitest's own export, `vi` other than for its calls that load nothing, a global by a computed key) makes
// the file unknown. So a form not on the allowlist needs no rule of its own. A worker or a process running JavaScript
// (STARTS) is unknown outside src (it runs a script it names; a string naming a script there is too); in src it runs a
// build entry (electron.vite.config.ts's main input but the app's index), so it keeps the tests reaching it only when a
// change is in an entry's closure, or the entries can't be read (the Assistant's option 4); a node script from text
// is read as a file of its own, and is unknown unless fixed text loading nothing of the repository. External programs
// (git, the CLIs) are the boundary: what they run isn't JavaScript a change here is in.
//
// The invariant: anything not proved known propagates as unknown. A file is known only when every way it can load or
// run code is on the allowlist; a test's closure only when every file in it is known; a worker entry's closure, the
// same (else every starter counts); the global object only as `G.name`.
//
// The review bar (Darren, 7 Nov, HI-2677/r96: "(a)"): the gate covers the ways this repository's code and tests load
// modules, or would plausibly write. A loader deliberately hidden (eval or Function reached through globals or built
// keys, a loader or its path chosen through an environment variable, code assembled from strings to evade a token) is
// the documented boundary, not a gap to close here: the gate still catches the forms it names (any eval, Function or
// constructor reference among them), and a guard can refuse such code in tests if it ever appears.
//
// Whatever it can't tell keeps every related test, with a reason. For a changed file (narrowChange's `all`): not code,
// added or deleted, unparseable in either revision, a changed line outside every unit (module code, an import that
// isn't type-only, a constructor) or in a class's field (set as an instance is made), its own module code naming a
// changed unit (run as it loads), or a unit with no name. For a test: a file it loads that is unknown (the gate, a
// repository path not there, a file unreadable or unparseable), whatever else of it reaches the change; the import graph
// read here reaching no changed file from it (Vitest followed a way this doesn't); or a file it loads listing keys by
// reflection (Object.getOwnPropertyNames, Reflect.ownKeys, Object.getOwnPropertyDescriptors: a method by no name).
// Paths are resolved as the graph resolves them (a directory's index, `.js` for `.ts`), not by a file name. A changed
// `import type` counts for nothing: it is erased before a test runs, and typecheck checks it. Changed test files and
// UNIT_SCANS' picks are affected.mjs's, whatever this leaves out. tests/relatedTests.test.ts checks each rule.
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { codeLines, gitChangedLines, gitRevision, unitsOf } from './affectedUnits.mjs'
import { CLASS_FILE, CLASS_NAME, ruleOn } from './workspaceRule.mjs'

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

/** A code file's syntax tree (Babel's), or throws. */
export function parseCode(text, file) {
  return parse(text, { sourceType: 'unambiguous', plugins: [...(/\.(ts|tsx|mts|cts)$/i.test(file) ? [['typescript', { dts: /\.d\.ts$/i.test(file) }]] : []), ...(/\.(tsx|jsx|js|mjs|cjs)$/i.test(file) ? ['jsx'] : [])], errorRecovery: false, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true })
}

/**
 * The gate (the Assistant's design on HI-2677, after round 3: an allowlist, not a list of loader spellings). What is
 * left of a file's code once its comments, its type-only imports and the allowed loading forms (fileLoads) are blanked
 * out is read for these: a hit means it may load or run code some other way, so the file is unknown, which keeps every
 * related test loading it. Strings are read too (one can be code). A form not on the allowlist needs no rule of its
 * own: it leaves one of these behind. A false hit only keeps a test.
 */
export const LOADS_CODE = [
  ['require', /\brequire\b/],
  ['import()', /\bimport\s*\(/],
  ['import.meta', /\bimport\s*\.\s*meta\b(?!\s*\.\s*(?:url|dirname|filename|env)\b)/],
  ['a Vitest module loader', /importActual|importMock|doMock|unmock|\bmock\s*\(/],
  ['createRequire or the module module', /createRequire|(['"`])(?:node:)?module\1|\b_load\b|mainModule/],
  // Any reference to eval, Function or constructor, called or not, a global's member or not (`const F = Function`,
  // `globalThis.Function`, `x['constructor']`, the string kept): handed on, each can run text. A class's own
  // `constructor() {}` is blanked, being no reference.
  ['eval or a Function made from text', /\beval\b|\bFunction\b|\bconstructor\b|process\s*\.\s*(?:binding|dlopen)/],
  ['vitest other than by a named import', /\bvitest\b(?![/'"`.-])|(['"`])vitest\1/]
]
/**
 * A worker or a process running JavaScript. In src, what it runs is one of the build's entries (electron.vite.config.ts's
 * main input, the app's own `index` aside: the workers and the scripts run as Node), an external program, or a script
 * made from text (LOADS_CODE's, unknown): so it matters only when a change reaches an entry's closure (narrowRelated's
 * `workers`). Anywhere else (tests, scripts) it runs a script it names, so the file is unknown.
 */
/** Strings the gate keeps (all others are blanked): the ones that make a process run JavaScript. */
const KEPT_STRING = /^node(?:\.exe)?(?:\s|$)|ELECTRON_RUN_AS_NODE|^(?:eval|Function|constructor)$/i
export const STARTS =/process\s*\.\s*execPath|ELECTRON_RUN_AS_NODE|\bfork\s*\(|\bWorker\s*\(|utilityProcess|(['"`])node(?:\.exe)?(?![\w:.-])/
/** Vitest's `vi` calls that load no module: any other use of `vi` (another member, `vi[…]`, `vi` handed on, an alias) is the gate's. */
export const VI_SAFE = ['fn', 'spyOn', 'hoisted', 'resetModules', 'useFakeTimers', 'useRealTimers', 'isFakeTimers', 'advanceTimersByTime', 'advanceTimersByTimeAsync', 'advanceTimersToNextTimer', 'advanceTimersToNextTimerAsync', 'runAllTimers', 'runAllTimersAsync', 'runOnlyPendingTimers', 'runOnlyPendingTimersAsync', 'runAllTicks', 'clearAllTimers', 'getTimerCount', 'setSystemTime', 'getMockedSystemTime', 'getRealSystemTime', 'clearAllMocks', 'resetAllMocks', 'restoreAllMocks', 'isMockFunction', 'mocked', 'waitFor', 'waitUntil', 'stubEnv', 'unstubAllEnvs', 'stubGlobal', 'unstubAllGlobals', 'setConfig', 'resetConfig']
const VI_USE = new RegExp(`\\bvi\\b(?!\\s*\\.\\s*(?:${VI_SAFE.join('|')})\\b)`)

/** Why what is left of a file's code may load code other than by the allowed forms (the gate), or null. */
export function loadsCode(rest) {
  if (VI_USE.test(rest)) return 'uses vi other than for its calls that load nothing'
  for (const [what, re] of LOADS_CODE) if (re.test(rest)) return `may load code by ${what}`
  return null
}

/** The static forms' specifiers: `… from '<x>'` and `import '<x>'`. */
const STATIC = /(?:\bfrom|\bimport)\s*(['"])([^'"\n]+)\1/g
/** `export * from '<x>'`: whole. */
const EXPORT_ALL = /\bexport\s*(?:type\s*)?\*\s*(?:as\s+[\w$]+\s*)?from\s*(['"])([^'"\n]+)\1/g

/**
 * What a code file loads: { edges: Set of repo paths, unknown: why what it loads can't all be known (the gate's reason, a
 * repository path not there, or the file not parsing), or null, whole: Map(repo path → how it uses that module whole) }.
 * The allowlist, each literal: the static forms (`import … from`, `import '…'`, `export … from`; `export *` is whole),
 * and, recognised by its syntax and then blanked so the gate doesn't see it:
 * - `import('<x>')` and `require('<x>')` (an unbound require), whole unless taken apart by name at once (`const { a } =`,
 *   `(…).a`);
 * - `const r = createRequire(import.meta.url | __filename)` with createRequire imported by its name from module, and
 *   every use of r a call `r('<x>')` (as above);
 * - `vi.mock('<x>', …)`, `vi.doMock`, `vi.unmock`, `vi.doUnmock` (whole with a factory taking the original),
 *   `vi.importActual('<x>')` and `vi.importMock` (whole), `vi` imported by its name from vitest;
 * - `import.meta.glob('<g>' | ['<g>', …], { literal options })`: its files are edges, its code files used whole;
 * - a type-only `import('<x>')` (erased).
 * An `import * as` or default import used other than as `ns.name`, `ns['literal']` or in a type is whole. Anything else
 * that may load code leaves a gate token: a form not taken in full (a computed path, a require handed on, an alias of vi
 * or createRequire, a glob's computed option) is never blanked.
 */
export function fileLoads(text, file, known) {
  const edges = new Set()
  const whole = new Map()
  let ast
  try {
    ast = parseCode(text, file)
  } catch (e) {
    return { edges, unknown: `doesn't parse (${e.message}), so what it loads isn't known`, whole }
  }
  const blank = (ast.comments ?? []).map((c) => [c.start, c.end])
  const line = (n) => n?.loc?.start.line ?? '?'
  const literal = (n) => (n?.type === 'StringLiteral' ? n.value : n?.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null)
  let missing = null
  let computedGlobal = null
  // Node's script-from-text flags met (ArrayExpression): unknown only in a file that starts node.
  const flags = []
  // A starter in an inline node script it accepted (ArrayExpression): the file's, once the script's text is blanked.
  let scriptStarts = null
  // Outside src, a string naming a script (`worker.cjs`, `x.mjs`) may be handed to a worker or a process anywhere (a
  // src starter's test override): the file is unknown.
  let named = null
  const scriptName = (value, node) => {
    // A path an allowed form has loaded (blanked before its strings are visited) is an edge, not a script handed on.
    if (blank.some(([s, e]) => node.start >= s && node.end <= e)) return
    if (!file.startsWith('src/') && /\.(?:c|m)?[jt]sx?$/i.test(value.trim())) named ??=`names a script, ${value.trim().slice(-60)} (line ${line(node)}), which a worker or a process may run`
  }
  const to = (spec, node) => {
    const t = resolveSpecifier(file, spec, known)
    if (t) edges.add(t)
    else if (repoPath(spec)) missing ??= `loads ${spec} (line ${line(node)}), which isn't in the repository`
    return t
  }
  const wholly = (t, why) => {
    if (t && CODE.test(t) && !whole.has(t)) whole.set(t, why)
  }
  const up = (p) => {
    let q = p
    while (q.parentPath && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'AwaitExpression'].includes(q.parentPath.node.type)) q = q.parentPath
    return q
  }
  const byName = (q) => {
    const par = q.parentPath?.node
    if ((par?.type === 'MemberExpression' || par?.type === 'OptionalMemberExpression') && par.object === q.node) return (!par.computed || par.property.type === 'StringLiteral') && !['then', 'catch', 'finally'].includes(keyName(par.property))
    if (par?.type === 'VariableDeclarator' && par.init === q.node && par.id.type === 'ObjectPattern') return par.id.properties.every((p) => p.type === 'ObjectProperty' && !p.computed)
    return false
  }
  // A call loading a literal path, taken in full: its edge, whole unless taken apart by name, and blanked.
  const loadCall = (p, what) => {
    const spec = literal(p.node.arguments?.[0] ?? p.node.source)
    if (spec == null || (p.node.arguments && p.node.arguments.length !== 1)) return false
    const t = to(spec, p.node)
    if (!byName(up(p))) wholly(t, `${what} ${t} whole (line ${line(p.node)})`)
    blank.push([p.node.start, p.node.end])
    return true
  }
  const plainOptions = (n) => !n || (n.type === 'ObjectExpression' && n.properties.every((q) => q.type === 'ObjectProperty' && !q.computed && ['BooleanLiteral', 'StringLiteral'].includes(q.value.type)))
  // createRequire imported by its own name from module, and the requires made from it: [binding, declarator].
  const crImport = ast.program.body.find((st) => st.type === 'ImportDeclaration' && /^(node:)?module$/.test(st.source.value) && st.specifiers.length === 1 && st.specifiers[0].type === 'ImportSpecifier' && keyName(st.specifiers[0].imported) === 'createRequire' && st.specifiers[0].local.name === 'createRequire')
  const viImport = ast.program.body.filter((st) => st.type === 'ImportDeclaration' && st.source.value === 'vitest' && st.importKind !== 'type')
  const viOk = viImport.every((st) => st.specifiers.every((sp) => sp.type === 'ImportSpecifier' && keyName(sp.imported) === sp.local.name))
  // `vi` here is Vitest's: imported from vitest by that name, or the global (no binding of its own).
  const isVitestVi = (p) => {
    const b = p.scope.getBinding('vi')
    return !b || (b.kind === 'module' && b.path.parentPath?.node.source?.value === 'vitest')
  }
  traverse(ast, {
    Program(prog) {
      // vitest's named imports (no alias), blanked: what they name is read where it is used.
      if (viOk) for (const st of viImport) blank.push([st.start, st.end])
      // From module, only names that load nothing (unaliased) are allowed text; createRequire is taken below.
      for (const st of ast.program.body) {
        if (st.type !== 'ImportDeclaration' || st === crImport || !/^(node:)?module$/.test(st.source.value)) continue
        if (st.specifiers.length && st.specifiers.every((sp) => sp.type === 'ImportSpecifier' && ['syncBuiltinESMExports', 'builtinModules', 'isBuiltin'].includes(keyName(sp.imported)) && keyName(sp.imported) === sp.local.name)) blank.push([st.start, st.end])
      }
      if (!crImport) return
      const cr = prog.scope.getBinding('createRequire')
      const requires = []
      let all = true
      for (const ref of cr?.referencePaths ?? []) {
        const call = ref.parentPath
        const decl = call.parentPath
        const arg = call.node.arguments?.[0]
        const base = arg && call.node.arguments.length === 1 && ((arg.type === 'Identifier' && arg.name === '__filename' && !call.scope.getBinding('__filename')) || (arg.type === 'MemberExpression' && arg.object.type === 'MetaProperty' && keyName(arg.property) === 'url'))
        // `createRequire(import.meta.url)('<x>')`, called at once.
        if (call.isCallExpression() && call.node.callee === ref.node && base && decl.isCallExpression() && decl.node.callee === call.node) {
          if (!loadCall(decl, 'requires')) all = false
          continue
        }
        if (!(call.isCallExpression() && call.node.callee === ref.node && base && decl.isVariableDeclarator() && decl.node.id.type === 'Identifier')) {
          all = false
          continue
        }
        const b = decl.scope.getBinding(decl.node.id.name)
        if (!b || !b.constant) {
          all = false
          continue
        }
        requires.push([b, decl])
      }
      for (const [b, decl] of requires) {
        let ok = true
        for (const ref of b.referencePaths) {
          const call = ref.parentPath
          if (!(call.isCallExpression() && call.node.callee === ref.node && loadCall(call, 'requires'))) ok = false
        }
        if (ok) blank.push([decl.node.start, decl.node.end])
        else all = false
      }
      if (all) blank.push([crImport.start, crImport.end])
    },
    TSImportType(p) {
      blank.push([p.node.start, p.node.end])
    },
    // A class's own constructor is a declaration, not a reference to one (its body is still read).
    ClassMethod(p) {
      if (p.node.kind === 'constructor' && !p.node.computed) blank.push([p.node.key.start, p.node.key.end])
    },
    // A node flag running a script from text (`-e`, `--eval`, `-p`, `--print`), in a file that starts node (STARTS): the
    // script must be the next element, a constant literal of the file, read as a file of its own, loading no repository
    // file and leaving no gate token; else the file is unknown. (Outside such a file, `-p` is git's or a CLI's flag.) A
    // script that itself starts a process (the queue's launcher runs the command it's handed) is its src file's starter,
    // under the build entries' rule as the file's own is (HI-2697); outside src, a starter is unknown anyway.
    ArrayExpression(p) {
      const els = p.node.elements
      for (let i = 0; i < els.length; i++) {
        if (els[i]?.type !== 'StringLiteral' || !/^-(?:e|p|-eval|-print)$/.test(els[i].value)) continue
        const next = els[i + 1]
        const b = next?.type === 'Identifier' ? p.scope.getBinding(next.name) : null
        const init = b?.constant && b.path.isVariableDeclarator() ? b.path.node.init : next
        const script = literal(init)
        const sub = script == null ? null : fileLoads(script, file.replace(/[^/]*$/, 'inline-script.js'), known)
        if (sub && !sub.unknown && !sub.edges.size && (!sub.starts || file.startsWith('src/'))) {
          blank.push([init.start, init.end])
          // Its starter is the file's, whether or not the file has a starter token of its own (HR1, HI-2697 round 1).
          if (sub.starts) scriptStarts ??= `${sub.starts} (its node script, line ${line(els[i])})`
        }
        else flags.push(`may run a script made from text it can't read (${els[i].value}, line ${line(els[i])})`)
      }
    },
    // The global object (unbound globalThis, global, window, self) only as `G.name`, so a loader taken from it is a
    // token the gate reads (`globalThis.eval`); used any other way (a key, even a literal one, whose string is blanked;
    // handed on, destructured) it may give any global, a loader too: the file is unknown.
    Identifier(p) {
      if (!['globalThis', 'global', 'window', 'self'].includes(p.node.name) || !p.isReferencedIdentifier() || p.scope.getBinding(p.node.name)) return
      if (p.parentPath.isTSModuleDeclaration()) return
      // Through casts and parentheses (`(globalThis as T).x`), which don't change the value.
      let q = p
      while (q.parentPath && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'].includes(q.parentPath.node.type)) q = q.parentPath
      const par = q.parentPath.node
      if ((par.type === 'MemberExpression' || par.type === 'OptionalMemberExpression') && par.object === q.node && !par.computed) return
      if (p.findParent((a) => a.isTSTypeQuery() || a.isTSTypeReference())) return
      computedGlobal ??= `uses the global object other than by a member's name (line ${line(p.node)})`
    },
    // Types are erased before a test runs; a string is code only through a sink the gate reads (eval, Function, a
    // worker, a process: identifiers, or a string naming node to run, which stays).
    'TSTypeAnnotation|TSTypeAliasDeclaration|TSInterfaceDeclaration|TSTypeParameterInstantiation|TSDeclareFunction'(p) {
      blank.push([p.node.start, p.node.end])
      p.skip()
    },
    StringLiteral(p) {
      if (p.parentPath.isImportDeclaration() || p.parentPath.isExportDeclaration()) return
      scriptName(p.node.value, p.node)
      if (!KEPT_STRING.test(p.node.value)) blank.push([p.node.start, p.node.end])
    },
    TemplateElement(p) {
      scriptName(p.node.value.raw, p.node)
      if (!/(?:^|\s)node(?:\.exe)?(?:\s|$)|ELECTRON_RUN_AS_NODE/i.test(p.node.value.raw)) blank.push([p.node.start, p.node.end])
    },
    ImportExpression(p) {
      loadCall(p, 'imports')
    },
    CallExpression(p) {
      const n = p.node
      const c = n.callee
      if (c.type === 'Import') return void loadCall(p, 'imports')
      if (c.type === 'Identifier' && c.name === 'require' && !p.scope.getBinding('require')) return void loadCall(p, 'requires')
      const member = c.type === 'MemberExpression' && !c.computed ? keyName(c.property) : null
      if (member && viOk && c.object.type === 'Identifier' && c.object.name === 'vi' && isVitestVi(p)) {
        const spec = literal(n.arguments[0])
        if (spec == null) return
        if (['importActual', 'importMock'].includes(member) && n.arguments.length === 1) {
          wholly(to(spec, n), `imports the actual ${resolveSpecifier(file, spec, known)} whole (line ${line(n)})`)
          blank.push([c.start, n.arguments[0].end])
        } else if (['mock', 'doMock', 'unmock', 'doUnmock'].includes(member)) {
          const t = to(spec, n)
          if (n.arguments.slice(1).some((a) => !/Function/.test(a.type) || a.params.length > 0)) wholly(t, `mocks ${t} from its original, whole (line ${line(n)})`)
          blank.push([c.start, n.arguments[0].end])
        }
        return
      }
      if (member === 'glob' && c.object.type === 'MetaProperty' && n.arguments.length <= 2 && plainOptions(n.arguments[1])) {
        const arg = n.arguments[0]
        const globs = arg?.type === 'ArrayExpression' ? arg.elements.map(literal) : [literal(arg)]
        if (!globs.length || globs.some((g) => g == null)) return
        for (const g of globs) {
          const re = globRegex(file, g)
          if (!re) continue
          for (const [k, f] of known) {
            if (!re.test(k)) continue
            edges.add(f)
            wholly(f, `globs ${f} with others, whole (line ${line(n)})`)
          }
        }
        blank.push([n.start, n.end])
      }
    },
    'ExportAllDeclaration|ExportNamedDeclaration'(p) {
      if (p.node.source) to(p.node.source.value, p.node)
    },
    ImportDeclaration(p) {
      // Its edge (and a path not in the repository, by its line); a type-only one too: the graph is a superset.
      const t = to(p.node.source.value, p.node)
      if (p.node.importKind === 'type') return
      for (const sp of p.node.specifiers) {
        if (sp.type === 'ImportSpecifier') continue
        for (const ref of p.scope.getBinding(sp.local.name)?.referencePaths ?? []) {
          if (ref.findParent((a) => a.isTSTypeQuery() || a.isTSTypeReference())) continue
          const q = ref.parentPath?.node
          if (!((q?.type === 'MemberExpression' || q?.type === 'OptionalMemberExpression') && q.object === ref.node && (!q.computed || q.property.type === 'StringLiteral'))) wholly(t, `uses ${t} whole as ${sp.local.name} (line ${line(ref.node)})`)
        }
      }
    }
  })
  // What is left for the gate, and the static forms' edges from it.
  blank.sort((a, b) => a[0] - b[0])
  let code = ''
  let at = 0
  for (const [s, e] of blank) {
    if (e <= at) continue
    code += text.slice(at, Math.max(at, s)) + ' '
    at = e
  }
  code += text.slice(at)
  for (const m of code.matchAll(STATIC)) to(m[2], null)
  for (const m of code.matchAll(EXPORT_ALL)) {
    const t = resolveSpecifier(file, m[2], known)
    wholly(t, `re-exports all of ${t}`)
  }
  const starts = STARTS.test(code) ? `starts a worker or a process running JavaScript` : scriptStarts
  const unknown = loadsCode(code) ?? computedGlobal ?? missing ?? named ?? (starts && flags.length ? flags[0] : null) ?? (starts && !file.startsWith('src/') ? `${starts}: a script it names` : null)
  return { edges, unknown, whole, starts }
}

/**
 * The import graph of a revision's files: { known, closure(file), edgesOf(file), unknownOf(file), wholeOf(file,
 * module) }. files: the repo's paths; read(file): its text or null; prefetch(files): reads them ahead (gitRevision's),
 * optional. Every code file it reaches is parsed (fileLoads), once. closure(f): f and every file its loads reach;
 * unknownOf(f): why what f loads can't all be known (fileLoads', or its text unreadable or unparseable), or null;
 * wholeOf(f, m): how f uses module m whole, or null.
 */
export function importGraph(files, read, prefetch) {
  const known = new Map(files.map(slashes).map((f) => [lower(f), f]))
  prefetch?.([...known.values()].filter((f) => CODE.test(f)))
  const info = new Map()
  const infoOf = (f) => {
    if (info.has(f)) return info.get(f)
    let r = { edges: new Set(), unknown: null, whole: new Map(), starts: null }
    info.set(f, r)
    if (!CODE.test(f)) return r
    const text = read(f)
    if (text == null) {
      r.unknown = `${f} couldn't be read, so what it loads isn't known`
      return r
    }
    r = fileLoads(text, f, known)
    if (r.unknown) r.unknown = `${f} ${r.unknown}`
    info.set(f, r)
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
  return { known, closure, edgesOf: (f) => infoOf(f).edges, unknownOf: (f) => infoOf(f).unknown, wholeOf: (f, m) => infoOf(f).whole.get(m) ?? null, startsOf: (f) => infoOf(f).starts ?? null }
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
  // the file names that (a factory, an instance), are what a test must name to have one. But for WorkspaceService's,
  // while its rule holds in both revisions (workspaceRule.mjs, HI-2678): every use of one spells its name, so the
  // member's own name is the needle, and the files the rule pins (an escape outside the app) keep the tests reaching them.
  let rule = null
  const ruled = (unit) => {
    if (!unit.member || slashes(file) !== CLASS_FILE || !unit.id.startsWith(`${CLASS_NAME}.`)) return false
    rule ??= ruleOn([base, head], base.root ?? head.root ?? process.cwd(), { scope: 'all' })
    return !rule.all
  }
  const classOf = (unit) => {
    if (!unit.member || ruled(unit)) return
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
  const byRule = rule ? (rule.all ? ` (${CLASS_NAME}'s members by its class: ${rule.all})` : `, ${CLASS_NAME}'s members by their names (its rule holds; ${rule.pinned.length} files pinned)`) : ''
  return { needles: [...needles.values()], why: `${file}: ${few([...ids])}${byRule}`, ...(rule && !rule.all ? { pins: rule.pinned } : {}) }
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
 * The related tests a change needs: { keep: [tests], dropped: [tests], why: [lines] }. related: Vitest's (repo paths);
 * changes: { file: narrowChange's result } for each changed file; graph: importGraph of the revision tested; read: its
 * texts; setupFiles: those every test loads (vitest.config.ts); workers: the build's worker and script entries (paths,
 * workerEntriesOf), or null when they can't be read. A src file starting a worker or a process running JavaScript
 * (STARTS) keeps the tests that load it when a changed file is in an entry's closure, or when the entries are null.
 */
export function narrowRelated({ related, changes, graph, read, setupFiles = [], workers = null }) {
  // Whether a change reaches what a src worker or process may run: then, and when that can't be read, a starter counts.
  // The entries' closure is what they may run only when it is all known: an unknown file in it may run anything, a change too.
  const entryClosure = workers ? workers.flatMap((w) => [...graph.closure(w)]) : null
  const entryUnknown = entryClosure ? entryClosure.map((f) => graph.unknownOf(f)).find(Boolean) : null
  const entryFiles = entryClosure && !entryUnknown ? new Set(entryClosure.map(lower)) : null
  const changeRuns = !entryFiles || Object.keys(changes).some((f) => entryFiles.has(lower(f)))
  const runsWhy = !workers ? "the build's worker entries couldn't be read" : entryUnknown ? `what the build's workers and scripts load isn't all known (${entryUnknown})` : 'a change is in what one of the build’s workers or scripts loads'
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
  const setup = setupFiles.flatMap((s) => [...graph.closure(s)])
  const reasons = { all: new Map(), graph: 0, unknown: new Map(), whole: new Map(), reflection: new Map(), pinned: new Map(), named: 0 }
  for (const test of [...new Set(related.map(slashes))]) {
    const files = new Set([...graph.closure(graph.known.get(lower(test)) ?? test), ...setup])
    // A file it loads whose own imports aren't all known may load the change: its closure isn't the whole of it.
    const starter = changeRuns ? [...files].find((f) => graph.startsOf(f)) : null
    const unsure = [...files].map((f) => graph.unknownOf(f)).find(Boolean) ?? (starter ? `${starter} ${graph.startsOf(starter)}, and ${runsWhy}` : null)
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
      // A file the WorkspaceService rule pins (an escape outside the app, HI-2678) that it loads: kept for any member.
      const pin = c.pins?.find((p) => files.has(p) || [...files].some((f) => lower(f) === lower(p)))
      if (pin) {
        reason = ['pinned', "a file it loads loses a WorkspaceService's type, so the WorkspaceService rule pins it"]
        break
      }
      for (const f of files) {
        if (lower(f) === lower(c.file)) continue
        const t = textOf(f)
        if (c.needles.some((n) => reOf(n).test(t))) {
          reason = ['named']
          break
        }
        const w = graph.wholeOf(f, c.file)
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
  for (const kind of ['all', 'unknown', 'whole', 'reflection', 'pinned']) {
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
 * The build's worker and script entries, from electron.vite.config.ts's text: the main build's rollup input, each
 * `name: resolve(__dirname, '<path>')`, the app's own `index` aside (no starter in src starts the app). Null when the
 * input isn't in that form, entry for entry (a line it can't read): then every starter counts (narrowRelated).
 */
export function workerEntriesOf(configText) {
  const m = /\binput\s*:\s*\{([^{}]*)\}/.exec(configText ?? '')
  if (!m) return null
  const entries = []
  for (const raw of m[1].split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, '').trim()
    if (!l) continue
    const e = /^(['"]?)([\w-]+)\1\s*:\s*resolve\(\s*__dirname\s*,\s*(['"])([^'"]+)\3\s*\)\s*,?$/.exec(l)
    if (!e) return null
    if (e[2] !== 'index') entries.push(e[4].replace(/^\.\//, ''))
  }
  return entries.length ? entries : null
}

/**
 * narrowRelated for the picker (affected.mjs's CLI): the working tree in cwd against base (a commit), paths the changed
 * files, related Vitest's list. Never throws: anything it can't work out keeps every related test, saying why.
 */
export function narrowRelatedInTree({ cwd, base, paths, related }) {
  // Nothing related, nothing to narrow (HI-3002): the whole tree's import graph isn't read for none.
  if (!related.length) return { keep: [], dropped: [], why: [] }
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
    return narrowRelated({ related, changes, graph: importGraph(files, (f) => revs.head.read(f)), read: (f) => revs.head.read(f), setupFiles, workers: workerEntriesOf(revs.head.read('electron.vite.config.ts')) })
  } catch (e) {
    return { keep: [...related], dropped: [], why: [`the related unit tests couldn't be narrowed (${e.message}), so every one`] }
  }
}
