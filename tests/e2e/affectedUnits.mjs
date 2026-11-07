// Which e2e suites a change to one of Combwork's shared files needs, by the parts of it the change touches (HI-2659):
// affected.mjs's selection for the files in SPLIT below, which every part of Combwork goes through (so a change to one
// selected every suite) but whose parts each have their own callers. A changed line belongs to a unit: an IPC
// channel's handler or type, a command, a function, a class's method, a top-level const or type. Each changed unit is
// followed to what names it (its callers, and theirs while they are in SPLIT files too), and a file that names it is
// placed as affected.mjs places a changed file (its own suite, its area's suites; a shared or unplaced one: every suite).
//
// It errs towards more: whatever it can't follow selects every suite, with a reason (unitSelection's `all`): a file it
// can't read or parse in either revision, one added or deleted, a changed line outside any unit (imports, module
// code), a public unit (public in either revision) whose trail reaches no file that runs it (it may be reached in a
// way a name search can't see; a cycle of public units naming only each other too), a re-export of a SPLIT module, a
// channel named only at run time, and any use of an import of one that isn't on moduleUse's short list of safe forms
// (`mod.name`, the unit called or read by name, a function handed off by its name, a type): every reference to such
// an import, by Babel's scope bindings, is checked, so an unlisted form is every suite by construction. A name spelled
// in a string (`x['setX']`) is a reference like the identifier. WorkspaceService's members and instance aren't
// narrowed at all: its instances flow where this can't follow (SPLIT's `conservative`). Lines whose text is all comment
// count for nothing, unless a comment they're in covers code in one revision and not the other.
// tests/affectedUnits.test.ts checks each rule, and the selections of HI-2652, HI-2653 and HI-2654.
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { ruleOn } from './workspaceRule.mjs'

const runContext = createRequire(import.meta.url)('./runContext.cjs')
const traverse = traverseModule.default ?? traverseModule

/** Where a channel or a command is named by its callers: the window, main, the preload and the suites. */
const KEY_SCOPE = ['src/', 'tests/e2e/']

/**
 * The CW_TEST_ seams of the IPC dispatch (ipc.ts's registerIpc, outside its handlers), by the names its parts use:
 * a reviewed mapping, one per branch, so a change to one selects the suites that set its seam. Each of these runs only
 * with its seam set (never in a packaged build): `testCalls` reads the variable named, `take` counts a seam's calls.
 * Any other line of the dispatch (the access check, the work mark, the error path, the loop) selects every suite.
 */
const IPC_SEAM_NAMES = {
  TestCalls: ['CW_TEST_SLOW_IPC', 'CW_TEST_FAIL_IPC', 'CW_TEST_BLOCK_IPC'],
  testCalls: ['CW_TEST_SLOW_IPC', 'CW_TEST_FAIL_IPC', 'CW_TEST_BLOCK_IPC'],
  take: ['CW_TEST_SLOW_IPC', 'CW_TEST_FAIL_IPC', 'CW_TEST_BLOCK_IPC'],
  slow: ['CW_TEST_SLOW_IPC'],
  delay: ['CW_TEST_SLOW_IPC'],
  failing: ['CW_TEST_FAIL_IPC'],
  blocking: ['CW_TEST_BLOCK_IPC'],
  block: ['CW_TEST_BLOCK_IPC'],
  holding: ['CW_TEST_HOLD_IPC'],
  hold: ['CW_TEST_HOLD_IPC'],
  heldIpc: ['CW_TEST_HOLD_IPC']
}
/** The dispatch's `if` tests that guard one seam's branch (whitespace aside). */
const IPC_SEAM_TESTS = {
  'delay?.ms': ['CW_TEST_SLOW_IPC'],
  'holding(channel)': ['CW_TEST_HOLD_IPC'],
  'take(failing, channel)': ['CW_TEST_FAIL_IPC'],
  'block?.ms': ['CW_TEST_BLOCK_IPC']
}
/** What an `if (!app.isPackaged)` of the dispatch may name besides seam names, for its body to be a seam's. */
const IPC_SEAM_GLOBALS = ['globalThis', '__cwHeldIpc', 'Record', 'string', 'number']

/**
 * The shared files selected by their units. file: the repo path; scope: the folders whose files can call its named
 * units (by import, or a method on the object it exports); keyed: the variables or interfaces whose entries are units
 * named by a string (`channel`: an IPC channel, followed through every file naming it but the channel registries;
 * `command`: an array of commands, each keyed by its `id`); dispatch: a function whose lines outside its entries map only
 * by IPC_SEAM_*; seamTables: arrays of seam names, a change to which selects the suites naming the names added or removed.
 */
export const SPLIT = [
  { file: 'src/main/ipc.ts', scope: ['src/main/', 'src/preload/'], keyed: { impl: 'channel' }, dispatch: 'registerIpc' },
  { file: 'src/shared/api.ts', scope: ['src/'], keyed: { CombworkRequests: 'channel' } },
  { file: 'src/renderer/src/actions.ts', scope: ['src/renderer/'] },
  { file: 'src/renderer/src/commands.ts', scope: ['src/renderer/'], keyed: { COMMAND_DEFS: 'command' } },
  // WorkspaceService's members are followed by name, like any class's, because the WorkspaceService rule holds
  // (workspaceRule.mjs, HI-2678): no value holding one goes where its type is lost or is read by a key the code doesn't
  // spell, so every use of a member spells its name in the program. `rule`: the rule is checked on both revisions
  // before a member is followed, and where it doesn't hold, every suite. The `workspace` Proxy const stays every suite.
  { file: 'src/main/workspace.ts', scope: ['src/main/', 'src/preload/', 'src/shared/'], rule: true, conservative: { test: (u) => u.id === 'workspace', why: "the workspace instance is a Proxy every window's calls go through (HI-2659's design, C3)" } },
  { file: 'tests/e2e/runner.mjs', scope: ['tests/e2e/', 'scripts/'], seamTables: ['DEV_SEAMS', 'PACKAGED_SEAMS'] }
]

const lower = (p) => p.replace(/\\/g, '/').toLowerCase()
export const splitOf = (file) => SPLIT.find((s) => lower(s.file) === lower(file))
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function parseFile(text, file) {
  const ts = /\.(ts|tsx|mts|cts)$/i.test(file)
  const jsx = /\.(tsx|jsx)$/i.test(file)
  const plugins = [...(ts ? [['typescript', { dts: /\.d\.ts$/i.test(file) }]] : []), ...(jsx || !ts ? ['jsx'] : [])]
  return parse(text, { sourceType: 'unambiguous', plugins, tokens: true, errorRecovery: false, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true })
}

const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string'
function children(node) {
  const out = []
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments' || k === 'extra') continue
    if (Array.isArray(v)) out.push(...v.filter(isNode))
    else if (isNode(v)) out.push(v)
  }
  return out
}
function walk(node, fn, parents = []) {
  if (fn(node, parents) === false) return
  const next = [...parents, node]
  for (const c of children(node)) walk(c, fn, next)
}
const unwrap = (n) => (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression') ? unwrap(n.expression) : n)
const keyName = (k) => (k?.type === 'Identifier' ? k.name : k?.type === 'StringLiteral' ? k.value : k?.type === 'PrivateName' ? `#${k.id.name}` : null)

/**
 * A file's units and what else selection needs of it: { units, unitAt(line), unitAtOffset(offset), commentOnly(line),
 * text, ast, tokens, imports (ranges) }. Units: { id, name, kind ('named' | 'key'), keyKind, needle, exported, local,
 * startLine, endLine, start, end, dispatch, seamTable }. Throws when the file doesn't parse.
 */
export function unitsOf(text, file, cfg = splitOf(file) ?? {}) {
  const ast = parseFile(text, file)
  const units = []
  const add = (u) => units.push({ ...u, startLine: u.node.loc.start.line, endLine: u.node.loc.end.line, start: u.node.start, end: u.node.end })
  const keyed = cfg.keyed ?? {}
  // A keyed container's entries, wherever it is declared.
  const entries = (container, kind, node) => {
    const v = unwrap(node)
    if (kind === 'channel' && v?.type === 'ObjectExpression') {
      for (const p of v.properties) {
        const k = p.type === 'SpreadElement' || p.computed ? null : keyName(p.key)
        add({ id: k ? `'${k}'` : `${container}@${p.loc.start.line}`, name: k, kind: 'key', keyKind: 'channel', needle: k, node: p })
      }
    } else if (kind === 'channel' && (v?.type === 'TSInterfaceBody' || v?.type === 'TSTypeLiteral')) {
      for (const m of v.body ?? v.members) {
        const k = m.computed ? null : keyName(m.key)
        add({ id: k ? `'${k}'` : `${container}@${m.loc.start.line}`, name: k, kind: 'key', keyKind: 'channel', needle: k, node: m })
      }
    } else if (kind === 'command' && v?.type === 'ArrayExpression') {
      for (const el of v.elements) {
        if (!el) continue
        const o = unwrap(el)
        const idProp = o?.type === 'ObjectExpression' ? o.properties.find((p) => p.type === 'ObjectProperty' && !p.computed && keyName(p.key) === 'id') : null
        const id = idProp && unwrap(idProp.value)?.type === 'StringLiteral' ? unwrap(idProp.value).value : null
        // A command made by a call or spread has no id here: its lines are no unit's, so every suite.
        if (id) add({ id: `command '${id}'`, name: id, kind: 'key', keyKind: 'command', needle: id, container, node: el })
      }
    }
  }
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && keyed[n.id.name]) entries(n.id.name, keyed[n.id.name], n.init)
    if (n.type === 'TSInterfaceDeclaration' && keyed[n.id.name]) entries(n.id.name, keyed[n.id.name], n.body)
    if (n.type === 'TSTypeAliasDeclaration' && keyed[n.id.name]) entries(n.id.name, keyed[n.id.name], n.typeAnnotation)
  })
  const imports = []
  for (const stmt of ast.program.body) {
    if (stmt.type === 'ImportDeclaration' || stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && stmt.source)) {
      imports.push(stmt)
      continue
    }
    const exported = stmt.type === 'ExportNamedDeclaration' && !!stmt.declaration
    const decl = exported ? stmt.declaration : stmt
    const named = (name, node, extra = {}) => add({ id: name, name, kind: 'named', needle: name, exported, local: !exported, node, ...extra })
    switch (decl.type) {
      case 'FunctionDeclaration':
        if (decl.id && cfg.dispatch === decl.id.name) {
          // The dispatch's own helpers (consts of its body, not its entries nor its seams' parts): units its handlers name.
          for (const s of decl.body.body) {
            if (s.type !== 'VariableDeclaration') continue
            for (const d of s.declarations) {
              if (d.id.type !== 'Identifier' || keyed[d.id.name] || IPC_SEAM_NAMES[d.id.name]) continue
              add({ id: `${decl.id.name}.${d.id.name}`, name: d.id.name, kind: 'named', needle: d.id.name, exported: false, local: true, node: s.declarations.length === 1 ? s : d })
            }
          }
        }
      // fallthrough
      case 'TSDeclareFunction':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        if (decl.id) named(decl.id.name, stmt, { dispatch: cfg.dispatch === decl.id.name, isFunction: decl.type === 'FunctionDeclaration' || decl.type === 'TSDeclareFunction' })
        break
      case 'VariableDeclaration':
        for (const d of decl.declarations) {
          if (d.id.type !== 'Identifier') continue
          named(d.id.name, decl.declarations.length === 1 ? stmt : d, { seamTable: (cfg.seamTables ?? []).includes(d.id.name) ? d : undefined, isFunction: ['ArrowFunctionExpression', 'FunctionExpression'].includes(unwrap(d.init)?.type) })
        }
        break
      case 'ClassDeclaration':
        for (const m of decl.body.body) {
          const k = m.computed ? null : keyName(m.key)
          if (!k || m.kind === 'constructor' || m.type === 'StaticBlock') continue
          // A class's member is public unless it is private (TypeScript's or #): its callers can be anywhere in scope.
          const priv = m.accessibility === 'private' || k.startsWith('#')
          add({ id: `${decl.id?.name ?? 'class'}.${k}`, name: k.replace(/^#/, ''), kind: 'named', needle: k.replace(/^#/, ''), exported: !priv, local: priv, member: true, node: m })
        }
        break
      default:
        // Module code (an expression, a re-export list, a default export): no unit.
        break
    }
  }
  // `export { a, b as c }`: those units are public after all (under both names).
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.declaration || stmt.source) continue
    for (const sp of stmt.specifiers) {
      for (const u of units.filter((v) => v.kind === 'named' && !v.member && v.name === sp.local.name)) Object.assign(u, { exported: true, local: false, alias: keyName(sp.exported) })
    }
  }
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const comments = (ast.comments ?? []).map((c) => [c.start, c.end])
  const inComment = (off) => comments.some(([s, e]) => off >= s && off < e)
  const unitAt = (line) => {
    let best = null
    for (const u of units) if (u.startLine <= line && line <= u.endLine && (!best || u.endLine - u.startLine < best.endLine - best.startLine || (u.kind === 'key' && best.kind !== 'key' && u.endLine - u.startLine === best.endLine - best.startLine))) best = u
    return best
  }
  const lineOf = (off) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  const commentOnly = (line) => {
    const s = lineStarts[line - 1]
    if (s === undefined) return true
    const e = line < lineStarts.length ? lineStarts[line] : text.length
    for (let i = s; i < e; i++) if (!/\s/.test(text[i]) && !inComment(i)) return false
    return true
  }
  // The comments a line is in, by their first and last lines.
  const commentLines = (ast.comments ?? []).map((c) => [c.loc.start.line, c.loc.end.line])
  const commentsAt = (line) => commentLines.filter(([s, e]) => s <= line && line <= e)
  return { units, unitAt, lineOf, commentOnly, commentsAt, lineCount: lineStarts.length, text, ast, tokens: ast.tokens ?? [], imports }
}

/** A key's boundaries in a string: not part of a longer channel or command id. */
const keyIn = (needle) => new RegExp(`(^|[^\\w.:-])${esc(needle)}($|[^\\w.:-])`)

/** Where a file names a unit, by offset: identifier tokens for a named one, strings and template text for a key. */
function occurrences(parsed, unit) {
  if (unit.kind === 'key') {
    const re = keyIn(unit.needle)
    return parsed.tokens.filter((t) => (t.type?.label === 'string' || t.type?.label === 'template') && typeof t.value === 'string' && re.test(t.value)).map((t) => t.start)
  }
  // Its name as an identifier, or spelled out in a string (`x['setX']`, `'setX' in x`): either reaches it by name.
  return parsed.tokens.filter((t) => (((t.type?.label === 'name' || t.type?.label === 'jsxName') && t.value === unit.needle) || ((t.type?.label === 'string' || t.type?.label === 'template') && t.value === unit.needle))).map((t) => t.start)
}

/** The local names an import gives a unit (its own, or an alias), and whether a re-export passes it on. */
function importNames(parsed, name) {
  const locals = new Set()
  let reexport = false
  for (const s of parsed.imports) {
    if (s.type === 'ExportAllDeclaration') continue
    for (const sp of s.specifiers ?? []) {
      const imported = keyName(sp.imported ?? sp.local)
      if (imported !== name) continue
      if (s.type === 'ImportDeclaration') locals.add(sp.local.name)
      else reexport = true
    }
  }
  return { locals: [...locals], reexport }
}
const inImport = (parsed, off) => parsed.imports.some((s) => off >= s.start && off < s.end)

/** Whether a file imports a module by a specifier ending in its file name (without the extension). */
function importsModule(text, file) {
  const base = file.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  return new RegExp(`(from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"][^'"]*/${esc(base)}(\\.[a-z]+)?['"]`).test(text)
}
/**
 * Whether a file's uses of a SPLIT module, for one of its units, are all ones a name search follows (moduleUse): null,
 * or why not (every suite). `export * from` it, and any use of an import of it outside a short list of safe forms.
 */
export function untraceable(text, file, parsed, functions, unitName) {
  const base = esc(file.replace(/^.*\//, '').replace(/\.[^.]+$/, ''))
  if (new RegExp(`export\\s*\\*\\s*(as\\s+\\w+\\s*)?from\\s*['"][^'"]*/${base}(\\.[a-z]+)?['"]`).test(text)) return 're-exports it all'
  if (!parsed || parsed.error) return null
  return moduleUse(parsed, new RegExp(`/${base}(\\.[a-z]+)?$`), functions, unitName)
}

const TS_WRAPPERS = ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression']

/**
 * Every reference to an import of the module that can hold the unit (the namespace, the default, the unit by its own
 * name), each checked against the uses a name search follows (HI-2659's round-3 contract, safe by construction):
 * - `mod.other` (by name, or a literal key) for another unit: a use of that one, not of this;
 * - for a function the module exports: `mod.fn` or `fn` anywhere (a call, or a hand-off by name, which places the
 *   file naming it);
 * - for any other unit: called (`mod.u(…)`, `u(…)`), or read by name (`mod.u.x`, `u.x`);
 * - in a type (`typeof mod`, `mod.T`).
 * Any other use (a computed key, an alias, destructuring, an argument, a spread, a template, a property, a return, an
 * export, an operator…) is one the tracer doesn't follow: its description, so every suite. Null when all are safe.
 */
function moduleUse(parsed, source, functions, unitName) {
  const unitIsFunction = functions.has(unitName)
  let hit = null
  const unsafe = (p, name, what) => {
    hit ??= `uses ${name} (line ${p.node.loc?.start.line ?? '?'}) as ${what}, which a name search doesn't follow`
  }
  // Up through casts and parentheses, which don't change the value.
  const outer = (p) => {
    let q = p
    while (q.parentPath && TS_WRAPPERS.includes(q.parentPath.node.type)) q = q.parentPath
    return q
  }
  // Type-only, by a positive list: inside a type query (`typeof mod`) or a type reference (`mod.T`, `Foo<typeof mod>`).
  // Any other TypeScript node (a parameter property's initializer, a decorator, a cast, an interface's heritage…) is a
  // value use, checked like any other.
  const inType = (p) => !!p.findParent((a) => a.isTSTypeQuery() || a.isTSTypeReference())
  const describe = (q) => {
    const par = q.parentPath?.node
    if (!par) return 'module code'
    if ((par.type === 'CallExpression' || par.type === 'NewExpression' || par.type === 'OptionalCallExpression') && par.arguments.includes(q.node)) return `an argument to ${parsed.text.slice(par.callee.start, par.callee.end).slice(0, 40)}`
    if ((par.type === 'MemberExpression' || par.type === 'OptionalMemberExpression') && par.computed && par.object === q.node) return 'a computed key'
    return `a ${par.type}`
  }
  // A use of the unit's value itself (an import of it by name, or mod.unit): safe when called or read by name.
  const unitValueUse = (p, name) => {
    if (unitIsFunction) return
    const q = outer(p)
    const par = q.parentPath?.node
    if ((par?.type === 'CallExpression' || par?.type === 'OptionalCallExpression' || par?.type === 'NewExpression') && par.callee === q.node) return
    if ((par?.type === 'MemberExpression' || par?.type === 'OptionalMemberExpression') && par.object === q.node && !par.computed) return
    unsafe(q, name, describe(q))
  }
  traverse(parsed.ast, {
    Program(program) {
      for (const b of Object.values(program.scope.getAllBindings())) {
        const decl = b.path.parentPath?.node
        if (decl?.type !== 'ImportDeclaration' || !source.test(decl.source?.value ?? '')) continue
        const spec = b.path.node
        const whole = spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier'
        const own = spec.type === 'ImportSpecifier' && keyName(spec.imported) === unitName
        if (!whole && !own) continue
        for (const ref of b.referencePaths) {
          if (hit) return
          if (inType(ref)) continue
          if (own) {
            unitValueUse(ref, ref.node.name)
            continue
          }
          // The namespace or default: only `mod.name` (or a literal key) is followed.
          const q = outer(ref)
          const par = q.parentPath?.node
          const member = (par?.type === 'MemberExpression' || par?.type === 'OptionalMemberExpression') && par.object === q.node
          const key = member ? (par.computed ? (unwrap(par.property)?.type === 'StringLiteral' ? unwrap(par.property).value : null) : keyName(par.property)) : null
          if (key == null) {
            unsafe(q, ref.node.name, describe(q))
            continue
          }
          if (key === unitName) unitValueUse(q.parentPath, `${ref.node.name}.${key}`)
        }
      }
    }
  })
  return hit
}
/** A channel built at run time (`invoke(\`git:${x}\`)`, `call('git:' + x)`): the static prefixes, any of which a channel may start with. */
const DYNAMIC_CALL = /\b(?:invoke|call|callShared)\s*\(\s*(?:`([^`$]*)\$\{|(['"])([^'"]*)\2\s*\+)/g
/** The same as extended regular expressions, for git grep to find the lines. */
const DYNAMIC_CALL_ERE = ['(invoke|call|callShared)[[:space:]]*\\([[:space:]]*`[^`$]*\\$\\{', "(invoke|call|callShared)[[:space:]]*\\([[:space:]]*'[^']*'[[:space:]]*\\+", '(invoke|call|callShared)[[:space:]]*\\([[:space:]]*"[^"]*"[[:space:]]*\\+']

/**
 * A revision of the repository for reading: read(path) its text or null, grep(needle, scopes, word) the files under
 * scopes whose text has it (word: as a whole word). gitRevision reads one from git (rev: a commit, or null: the working
 * tree, untracked files too); memoryRevision from { path: text }, for tests.
 */
export function gitRevision(cwd, rev) {
  const git = (args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const cache = new Map()
  const grep = (args) => {
    try {
      return git(['grep', '-I', ...(rev ? [] : ['--untracked']), ...args])
        .split(/\r?\n/)
        .filter(Boolean)
    } catch (e) {
      if (e.status === 1) return []
      throw e
    }
  }
  const unprefix = (l) => (rev && l.startsWith(`${rev}:`) ? l.slice(rev.length + 1) : l)
  // A commit's files, read in one git process for those not read yet (git cat-file --batch).
  const prefetch = (paths) => {
    const want = [...new Set(paths)].filter((p) => !cache.has(p))
    if (!rev || !want.length) return
    const out = execFileSync('git', ['cat-file', '--batch'], { cwd, input: want.map((p) => `${rev}:${p}`).join('\n') + '\n', env: runContext.baseEnv(), maxBuffer: 1024 * 1024 * 1024 })
    let at = 0
    for (const p of want) {
      const nl = out.indexOf(10, at)
      const head = out.subarray(at, nl).toString('utf8')
      const size = /^\S+ blob (\d+)$/.exec(head)
      if (!size) {
        cache.set(p, null)
        at = nl + 1
        continue
      }
      cache.set(p, out.subarray(nl + 1, nl + 1 + Number(size[1])).toString('utf8'))
      at = nl + 1 + Number(size[1]) + 1
    }
  }
  let listed = null
  return {
    name: rev ?? 'the working tree',
    /** The checkout it's read in (the census resolves node_modules there). */
    root: cwd,
    /** The commit (null: the working tree). */
    commit: rev,
    /** Its files: a commit's, or the working tree's (tracked and untracked, not ignored). */
    list() {
      // The working tree's: a tracked file deleted but not yet staged isn't there.
      listed ??= rev ? git(['ls-tree', '-r', '-z', '--name-only', rev]).split('\0').filter(Boolean) : [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].filter((p) => existsSync(join(cwd, p)))
      if (rev) prefetch(listed.filter((p) => /\.(ts|tsx|mts|cts|json)$/i.test(p)))
      return listed
    },
    /** Its whole tree's id, which fixes every file (null: the working tree, which no id fixes). */
    tree: () => (rev ? git(['rev-parse', `${rev}^{tree}`]).trim() : null),
    /** Reads these files of a commit in one git process, ahead of read() (the working tree: nothing to do). */
    prefetch,
    read(path) {
      if (!cache.has(path)) {
        if (rev) prefetch([path])
        else {
          let text = null
          try {
            text = readFileSync(join(cwd, path), 'utf8')
          } catch {
            text = null
          }
          cache.set(path, text)
        }
      }
      return cache.get(path)
    },
    grep(needle, scopes, word) {
      const files = grep(['-l', '-F', ...(word ? ['-w'] : []), '-e', needle, ...(rev ? [rev] : []), '--', ...scopes]).map(unprefix)
      prefetch(files)
      return files
    },
    grepLines(eres, scopes) {
      return grep(['-E', ...eres.flatMap((e) => ['-e', e]), ...(rev ? [rev] : []), '--', ...scopes]).map((l) => {
        const rest = unprefix(l)
        const i = rest.indexOf(':')
        return { file: rest.slice(0, i), line: rest.slice(i + 1) }
      })
    }
  }
}
export function memoryRevision(files, name = 'memory') {
  return {
    name,
    list: () => Object.keys(files),
    read: (path) => files[path] ?? null,
    grep(needle, scopes, word) {
      const re = word ? new RegExp(`(^|[^\\w$])${esc(needle)}($|[^\\w$])`) : null
      return Object.keys(files).filter((p) => scopes.some((s) => (s.endsWith('/') ? p.startsWith(s) : p === s)) && (re ? re.test(files[p]) : files[p].includes(needle)))
    },
    grepLines(eres, scopes) {
      const res = eres.map((e) => new RegExp(e.replace(/\[\[:space:\]\]/g, '\\s')))
      return Object.keys(files)
        .filter((p) => scopes.some((s) => (s.endsWith('/') ? p.startsWith(s) : p === s)))
        .flatMap((p) => files[p].split(/\r?\n/).filter((l) => res.some((re) => re.test(l))).map((line) => ({ file: p, line })))
    }
  }
}

/** The lines a -U0 diff of one file changes: { added: new revision's line numbers, removed: the base's }. */
export function diffLineNumbers(diff) {
  const added = []
  const removed = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [o, oc, n, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
    for (let i = 0; i < oc; i++) removed.push(o + i)
    for (let i = 0; i < nc; i++) added.push(n + i)
  }
  return { added, removed }
}
/** diffLineNumbers from git: base against head (a commit) or, head null, the working tree. */
export function gitChangedLines(cwd, base, head, file) {
  const diff = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', '--no-renames', '-U0', base, ...(head ? [head] : []), '--', file], { cwd, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 512 * 1024 * 1024 })
  return diffLineNumbers(diff)
}
/** The same from two texts (a line diff by longest common subsequence), for tests' small files. */
export function lineDiff(a, b) {
  const x = a.split(/\r?\n/)
  const y = b.split(/\r?\n/)
  const L = Array.from({ length: x.length + 1 }, () => Array.from({ length: y.length + 1 }, () => 0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const added = []
  const removed = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++
      j++
    } else if (j < y.length && (i >= x.length || L[i][j + 1] >= L[i + 1][j])) added.push(++j)
    else removed.push(++i)
  }
  return { added, removed }
}

/** The names in a seam table (an array of string literals), or null when it is anything else. */
function seamNames(declarator) {
  const v = unwrap(declarator?.init)
  if (v?.type !== 'ArrayExpression') return null
  const names = []
  for (const el of v.elements) {
    if (unwrap(el)?.type !== 'StringLiteral') return null
    names.push(unwrap(el).value)
  }
  return names
}

/** The seams a changed line of the IPC dispatch belongs to (IPC_SEAM_*), or null: not a reviewed seam branch. */
function dispatchSeams(parsed, unit, line) {
  const chain = []
  // The statements holding the line, outermost first.
  walk(unit.node, (n) => {
    if (n.loc.start.line > line || n.loc.end.line < line) return false
    if (/Statement$|Declaration$/.test(n.type) && n !== unit.node) chain.push(n)
  })
  const src = (n) => parsed.text.slice(n.start, n.end).replace(/\s+/g, ' ').trim()
  const idents = (n) => {
    const out = new Set()
    walk(n, (m) => {
      if (m.type === 'Identifier') out.add(m.name)
    })
    return out
  }
  for (const s of chain.reverse()) {
    if (s.type === 'VariableDeclaration' && s.declarations.every((d) => d.id.type === 'Identifier' && IPC_SEAM_NAMES[d.id.name])) return s.declarations.flatMap((d) => IPC_SEAM_NAMES[d.id.name])
    if (s.type === 'TSTypeAliasDeclaration' && IPC_SEAM_NAMES[s.id.name]) return IPC_SEAM_NAMES[s.id.name]
    if (s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' && s.expression.left.type === 'Identifier' && IPC_SEAM_NAMES[s.expression.left.name]) return IPC_SEAM_NAMES[s.expression.left.name]
    if (s.type === 'IfStatement' && IPC_SEAM_TESTS[src(s.test)] && !s.alternate) return IPC_SEAM_TESTS[src(s.test)]
    if (s.type === 'IfStatement' && src(s.test) === '!app.isPackaged' && !s.alternate) {
      const names = [...idents(s.consequent)]
      if (names.length && names.every((n) => IPC_SEAM_NAMES[n] || IPC_SEAM_GLOBALS.includes(n)) && names.some((n) => IPC_SEAM_NAMES[n])) return names.flatMap((n) => IPC_SEAM_NAMES[n] ?? [])
    }
  }
  return null
}

/**
 * The changed lines of a file that change code, each with the unit holding it: [{ side (0: base, 1: head), line,
 * comment (all comment, but it moves code), unit (unitsOf's, or null: in none) }]. sides: unitsOf of the file in each
 * revision; lines: { added, removed } (diffLineNumbers). A line of comment alone changes no code unless a comment it is
 * in now covers, or no longer covers, code: an unchanged line inside that comment that isn't all comment in the other
 * revision (`/*` and `*\/` added around code).
 */
/**
 * Whether a TypeScript statement is erased before anything runs (HI-2690, D1), node by node, never by a file's
 * extension: an interface, a type alias, an overload signature (TSDeclareFunction), a type-only import or export, a
 * `declare` variable with no value, and a `declare` module, namespace or global block holding only such statements. An
 * enum of any kind (a const enum's values are inlined where it is used, a `.d.ts`'s or an ambient one too) and
 * everything else (a class, a function, a value) is not.
 */
export function erasedStatement(st) {
  const s = st.type === 'ExportNamedDeclaration' && st.declaration ? st.declaration : st
  switch (s.type) {
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSDeclareFunction':
      return true
    case 'ImportDeclaration':
      return s.importKind === 'type' || (s.specifiers.length > 0 && s.specifiers.every((sp) => sp.importKind === 'type'))
    case 'ExportNamedDeclaration':
      return !s.declaration && (s.exportKind === 'type' || (s.specifiers.length > 0 && s.specifiers.every((sp) => sp.exportKind === 'type')))
    case 'ExportAllDeclaration':
      return s.exportKind === 'type'
    case 'VariableDeclaration':
      return !!s.declare && s.declarations.every((d) => !d.init)
    case 'TSModuleDeclaration': {
      if (!s.declare && !s.global && s.kind !== 'global') return false
      const body = s.body?.type === 'TSModuleBlock' ? s.body.body : s.body ? [s.body] : []
      return body.every((b) => (b.type === 'TSModuleDeclaration' ? erasedStatement({ ...b, declare: true }) : erasedStatement(b)))
    }
    default:
      return false
  }
}

/**
 * A change to a TypeScript file that only types can see (HI-2690, D1): its reason, or null (selected as usual). Every
 * changed line that changes code (codeLines), in both revisions, lies in a statement erasedStatement allows, and shares
 * its line with no other statement. Never for a file that doesn't parse, an added or deleted one, or one read as source
 * data: its repo path or its name named in a test's or a script's code (tests/e2e, tests/scenarios, scripts: tipwindows
 * reads tips.ts, viewer servers.ts), selection's own tooling aside. base, head: revisions (gitRevision, memoryRevision);
 * lines: { added, removed } (diffLineNumbers).
 */
export function typeOnlyChange({ file, base, head, lines }) {
  if (!/\.(ts|tsx|mts|cts)$/i.test(file)) return null
  const texts = [base.read(file), head.read(file)]
  if (texts.some((t) => t == null)) return null
  const name = file.replace(/^.*\//, '')
  for (const rev of [base, head]) {
    for (const f of rev.grep(name, ['tests/e2e/', 'tests/scenarios/', 'scripts/'], false)) {
      if (!/\.(c|m)?[jt]s$/i.test(f) || /^tests\/e2e\/(affected|affectedUnits|relatedTests|typeProvenance)\.mjs$/i.test(f)) continue
      return null
    }
  }
  const sides = []
  const stmts = []
  for (const t of texts) {
    let parsed
    try {
      parsed = unitsOf(t, file, {})
    } catch {
      return null
    }
    sides.push(parsed)
    // Each statement's lines, with whether it is erased (export wrappers count as their declaration).
    stmts.push(parsed.ast.program.body.map((st) => ({ from: st.loc.start.line, to: st.loc.end.line, erased: erasedStatement(st) })))
  }
  const changed = codeLines(sides, lines)
  // Comments alone, none of them now covering code or no longer covering it (codeLines' rule, HI-2659's).
  if (!changed.length) return (lines.added.length || lines.removed.length) ? `${file}: comments only, so no suite` : null
  for (const { side, line } of changed) {
    const on = stmts[side].filter((s) => s.from <= line && line <= s.to)
    if (!on.length || !on.every((s) => s.erased)) return null
  }
  return `${file}: types only (erased before anything runs; typecheck checks them), so no suite`
}

export function codeLines(sides, lines) {
  // Unchanged lines paired across the revisions (base's line → head's, and back), from the diff.
  const changedOn = [new Set(lines.removed), new Set(lines.added)]
  const pairs = [[], []]
  for (let i = 1, j = 1; i <= sides[0].lineCount && j <= sides[1].lineCount; ) {
    if (changedOn[0].has(i)) i++
    else if (changedOn[1].has(j)) j++
    else {
      pairs[0][i] = j
      pairs[1][j] = i
      i++
      j++
    }
  }
  const movesCode = (i, n) => sides[i].commentsAt(n).some(([s, e]) => {
    for (let l = s; l <= e; l++) if (!changedOn[i].has(l) && pairs[i][l] && !sides[1 - i].commentOnly(pairs[i][l])) return true
    return false
  })
  const out = []
  for (const [i, nums] of [lines.removed, lines.added].entries()) {
    for (const n of nums) {
      const comment = sides[i].commentOnly(n)
      if (comment && !movesCode(i, n)) continue
      out.push({ side: i, line: n, comment, unit: sides[i].unitAt(n) })
    }
  }
  return out
}

/**
 * The suites a change to a SPLIT file needs, by its units: { all: why | null, suites: [...], why: [lines] }.
 * file: its repo path; base, head: revisions (gitRevision, memoryRevision); lines: { added, removed } (diffLineNumbers);
 * place(file): how affected.mjs places a file that names a unit ({ suites, why } | { all: why } | null: no suite);
 * areaSuites(file): the suites AREAS names for a file.
 */
export function unitSelection({ file, base, head, lines, place, areaSuites }) {
  const suites = new Set()
  const why = []
  let all = null
  const every = (reason) => {
    all ??= `${file}: ${reason}, so every suite`
  }
  const result = () => ({ all, suites: all ? [] : [...suites], why: all ? [] : [...new Set(why)] })
  const revs = [base, head]
  const texts = revs.map((r) => r.read(file))
  if (texts.some((t) => t == null)) {
    every(`added, deleted or unreadable in ${texts[0] == null ? base.name : head.name}`)
    return result()
  }
  const parsedCache = new Map()
  const parsedIn = (rev, f) => {
    const k = `${rev.name}\0${f}`
    if (!parsedCache.has(k)) {
      const text = rev.read(f)
      let p = null
      if (text != null) {
        try {
          p = unitsOf(text, f)
        } catch (e) {
          p = { error: e.message }
        }
      }
      parsedCache.set(k, p)
    }
    return parsedCache.get(k)
  }
  const sides = revs.map((r) => parsedIn(r, file))
  for (const [i, s] of sides.entries()) if (s.error) every(`doesn't parse in ${revs[i].name} (${s.error})`)
  if (all) return result()

  // The changed units, from both revisions.
  const changed = []
  const seams = new Set()
  for (const { side: i, line: n, comment, unit: u } of codeLines(sides, lines)) {
    if (!u) {
      every(`line ${n} (${revs[i].name}) is in no function, method or entry`)
      continue
    }
    if (u.dispatch) {
      const s = comment ? null : dispatchSeams(sides[i], u, n)
      if (!s) every(`line ${n} (${revs[i].name}) is ${u.name}'s dispatch outside its reviewed test-seam branches`)
      else for (const x of s) seams.add(x)
      continue
    }
    if (u.seamTable) {
      const other = sides[1 - i].units.find((v) => v.id === u.id)
      const a = seamNames(u.seamTable)
      const b = other ? seamNames(other.seamTable) : null
      if (!a || !b) every(`${u.name} isn't a list of seam names in both revisions`)
      else for (const x of [...a.filter((v) => !b.includes(v)), ...b.filter((v) => !a.includes(v))]) seams.add(x)
      continue
    }
    if (!changed.some((c) => c.file === file && c.id === u.id)) changed.push({ file, id: u.id })
  }
  if (all) return result()
  // Its areas' suites, as for any file changed (a change of comments alone needs none).
  if (changed.length || seams.size) for (const s of areaSuites(file)) suites.add(s)

  // A seam's suites: the suites (and harness files) that name it, outside the seam tables and the dispatch.
  for (const seam of seams) {
    const users = new Set(revs.flatMap((r) => r.grep(seam, ['tests/e2e/'], true)))
    for (const f of users) {
      if (/^tests\/e2e\/(runner\.mjs|README\.md)$/i.test(f)) continue
      const p = place(f)
      if (p?.all) every(`the seam ${seam} is set by ${f}, ${p.all}`)
      else if (p) for (const s of p.suites) suites.add(s)
    }
    why.push(`${file}: the seam ${seam}: the suites that set it`)
  }
  if (all) return result()

  // A unit as both revisions have it: public if it is public in either (so a change of visibility can't hide callers).
  const unitIn = (f, id) => {
    const found = revs.flatMap((r) => {
      const p = parsedIn(r, f)
      return p && !p.error ? p.units.filter((u) => u.id === id) : []
    })
    if (!found.length) return null
    return { ...found[0], local: found.every((u) => u.local), exported: found.some((u) => u.exported), alias: found.map((u) => u.alias).find((a) => a && a !== found[0].name) }
  }

  const channelRegistries = SPLIT.filter((s) => Object.values(s.keyed ?? {}).includes('channel')).map((s) => s.file)
  const dynamic = new Map()
  const untraced = new Map()
  const dynamicPrefixes = (rev) => {
    if (!dynamic.has(rev.name)) {
      const prefixes = []
      for (const { file: f, line } of rev.grepLines(DYNAMIC_CALL_ERE, KEY_SCOPE)) for (const m of line.matchAll(DYNAMIC_CALL)) prefixes.push({ f, prefix: m[1] ?? m[3] })
      dynamic.set(rev.name, prefixes)
    }
    return dynamic.get(rev.name)
  }
  // What uses a module, for one of its units, in a way a name search can't follow (moduleUse), in its scope's files:
  // why, or null.
  const untracedIn = (rev, uf, unitName) => {
    const k = `${rev.name}\0${uf}\0${unitName}`
    if (!untraced.has(k)) {
      const stem = uf.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
      // The functions it exports, in either revision: handing one off by its name is a reference.
      const functions = new Set(revs.flatMap((r) => {
        const p = parsedIn(r, uf)
        return p && !p.error ? p.units.filter((u) => u.isFunction && u.exported).map((u) => u.name) : []
      }))
      let hit = null
      for (const f of rev.grep(`/${stem}`, splitOf(uf).scope, false)) {
        if (lower(f) === lower(uf)) continue
        const u = untraceable(rev.read(f) ?? '', uf, parsedIn(rev, f), functions, unitName)
        if (u) {
          hit = `${f} ${u} (${rev.name})`
          break
        }
      }
      untraced.set(k, hit)
    }
    return untraced.get(k)
  }

  // What names a unit, once each: the units it is followed to (in SPLIT files) and the files that place it.
  const edgesCache = new Map()
  const edgesOf = (uf, unit) => {
    const key = `${uf}#${unit.id}`
    if (edgesCache.has(key)) return edgesCache.get(key)
    const edges = { follows: [], placed: [], all: null }
    edgesCache.set(key, edges)
    const stop = (reason) => {
      edges.all ??= reason
    }
    const follow = (f, id) => {
      if (!edges.follows.some((x) => x.file === f && x.id === id)) edges.follows.push({ file: f, id })
    }
    if (!unit.needle) return stop(`${uf}'s ${unit.id} has no name to follow`), edges
    if (unit.alias) return stop(`${uf} exports ${unit.name} as ${unit.alias}`), edges
    const conservative = splitOf(uf).conservative
    if (conservative?.test(unit)) return stop(`${uf}'s ${unit.id}: ${conservative.why}`), edges
    if (splitOf(uf).rule && unit.member) {
      const r = ruleOn(revs, revs[0].root ?? process.cwd(), { scope: 'src' })
      if (r.all) return stop(`${uf}'s ${unit.id} can't be followed by name: ${r.all}`), edges
    }
    if (unit.kind === 'named' && !unit.local) for (const rev of revs) stop(untracedIn(rev, uf, unit.name) ?? undefined)
    // A command is also reached through the list holding it, by its generic dispatch (the palette, the menus, the
    // shortcuts, App.tsx's keys): a boundary mapped to commands.ts's own areas' suites (keys, i18nlive…), which drive
    // that dispatch, and which every reach of a command adds (areaSuites of the file holding it).
    if (unit.keyKind === 'command') for (const s of areaSuites(uf)) edges.placed.push({ file: uf, suites: [s], area: true })
    if (edges.all) return edges
    for (const rev of revs) {
      // In its own file: the units naming it (a key's own file only defines it: not its caller).
      const own = parsedIn(rev, uf)
      if (own && !own.error && unit.kind === 'named') {
        for (const off of occurrences(own, unit)) {
          const at = own.unitAt(own.lineOf(off))
          if (at?.id === unit.id || inImport(own, off)) continue
          if (!at) return stop(`${uf} names ${unit.name} in its module code (line ${own.lineOf(off)}, ${rev.name})`), edges
          follow(uf, at.id)
        }
      }
      // Elsewhere: the files in scope that name it (a local unit, its file's alone, has none).
      const scope = unit.kind === 'key' ? KEY_SCOPE : splitOf(uf).scope
      for (const f of unit.local ? [] : rev.grep(unit.needle, scope, unit.kind === 'named')) {
        if (lower(f) === lower(uf) || (unit.keyKind === 'channel' && channelRegistries.some((r) => lower(r) === lower(f)))) continue
        const text = rev.read(f) ?? ''
        const p = parsedIn(rev, f)
        if (unit.kind === 'named' && !unit.member && !importsModule(text, uf)) continue
        // A file that doesn't parse: its mention counts.
        const offs = p && !p.error ? occurrences(p, unit) : [0]
        if (!offs.length) continue
        if (splitOf(f) && p && !p.error) {
          // A SPLIT file naming it: the units that do (and those naming an alias it imports it as).
          if (unit.kind === 'named') {
            const { locals, reexport } = importNames(p, unit.name)
            if (reexport) return stop(`${f} re-exports ${unit.name} (${rev.name})`), edges
            for (const alias of locals.filter((l) => l !== unit.name)) for (const off of occurrences(p, { kind: 'named', needle: alias })) if (!inImport(p, off)) offs.push(off)
          }
          for (const off of offs) {
            if (inImport(p, off)) continue
            const at = p.unitAt(p.lineOf(off))
            if (!at || at.dispatch) return stop(`${f} names ${unit.name} ${at ? `in ${at.name}'s dispatch` : 'in its module code'} (line ${p.lineOf(off)}, ${rev.name})`), edges
            follow(f, at.id)
          }
          for (const s of areaSuites(f)) edges.placed.push({ file: f, suites: [s], area: true })
          continue
        }
        const placed = place(f)
        if (placed?.all) return stop(`${unit.kind === 'key' ? `${unit.keyKind} ${unit.needle}` : unit.name} is named in ${f}, ${placed.all}`), edges
        // Docs and unit tests name it, but run no suite: no consumer of it here.
        if (placed) edges.placed.push({ file: f, suites: placed.suites })
      }
      if (unit.keyKind === 'channel') {
        const d = dynamicPrefixes(rev).find((x) => x.prefix && unit.needle.startsWith(x.prefix))
        if (d) return stop(`${d.f} builds a channel starting ${d.prefix} at run time (${rev.name}), which ${unit.needle} may be`), edges
      }
    }
    return edges
  }

  // Each changed unit, from itself through what names it. A public unit has callers a name search may miss, so its
  // traversal must reach a file that runs it (a suite, an area); one that reaches none (nothing names it, or only
  // units that are themselves reached by nothing, a cycle of them included) selects every suite. Only a traversal of
  // local units alone may end with none: then nothing can run them.
  for (const root of changed) {
    const seen = new Set()
    const queue = [root]
    let reached = 0
    let publicUnit = null
    while (queue.length) {
      if (all) break
      const { file: uf, id } = queue.shift()
      const key = `${uf}#${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const unit = unitIn(uf, id)
      if (!unit) {
        every(`${uf}'s ${id} isn't in either revision`)
        break
      }
      if (!unit.local) publicUnit ??= `${uf === file ? '' : `${uf}'s `}${unit.kind === 'key' ? `${unit.keyKind} ${unit.needle}` : unit.id}`
      const edges = edgesOf(uf, unit)
      if (edges.all) {
        every(edges.all)
        break
      }
      for (const p of edges.placed) {
        reached++
        for (const s of p.suites) suites.add(s)
        if (!p.area) why.push(`${uf}: ${unit.id} → ${p.file}: ${p.suites.join(', ') || 'no suite'}`)
      }
      queue.push(...edges.follows)
    }
    if (all) break
    if (!reached) {
      if (publicUnit) every(`nothing that runs ${publicUnit} was found, though it is public: it may be reached in a way a name can't show`)
      else why.push(`${file}: ${root.id}: local, and nothing that runs it names it: no suite`)
    }
  }
  return result()
}
