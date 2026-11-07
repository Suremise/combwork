// Which of the unit tests Vitest relates to a change it needs (HI-2677, tests/e2e/relatedTests.mjs): the import graph,
// each rule on small two-revision fixtures (a test reaching a changed unit in a way a name alone wouldn't show stays,
// beside an unrelated lookup that is left out), the picker's working-tree entry on a scratch repository, and HI-2654
// from this repository's history (CI checks out all of it).
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { gitChangedLines, gitRevision, lineDiff, memoryRevision } from './e2e/affectedUnits.mjs'
// @ts-expect-error: plain .mjs modules without types
import { importGraph, narrowChange, narrowRelated, narrowRelatedInTree, resolveSpecifier, setupFilesOf, workerEntriesOf } from './e2e/relatedTests.mjs'
import { tempDir } from './tempDir'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')
type Files = Record<string, string>
type Change = { all?: string; needles?: { name: string; key: boolean }[]; why?: string }
type Narrowed = { keep: string[]; dropped: string[]; why: string[] }

const change = (file: string, base: Files, head: Files): Change => narrowChange({ file, base: memoryRevision(base, 'base'), head: memoryRevision(head, 'head'), lines: lineDiff(base[file] ?? '', head[file] ?? '') }) as Change
const allOf = (file: string, base: Files, head: Files): string => {
  const c = change(file, base, head)
  expect(c.all, `expected every test, got ${JSON.stringify(c.needles)}`).toBeTruthy()
  return c.all!
}
const needlesOf = (file: string, base: Files, head: Files): string[] => {
  const c = change(file, base, head)
  expect(c.all ?? null, c.all ?? '').toBeNull()
  return c.needles!.map((n) => n.name).sort()
}
// The tests among head's that Vitest would relate (their imports reach a changed file), narrowed.
const narrow = (base: Files, head: Files, opts: { related?: string[]; setupFiles?: string[] } = {}): Narrowed => {
  const files = Object.keys(head)
  const graph = importGraph(files, (f: string) => head[f] ?? null)
  const changed = [...new Set([...Object.keys(base), ...files])].filter((f) => base[f] !== head[f])
  const related = opts.related ?? files.filter((f) => f.endsWith('.test.ts') && changed.some((c) => graph.closure(f).has(c)))
  const changes = Object.fromEntries(changed.map((f) => [f, change(f, base, head)]))
  return narrowRelated({ related, changes, graph, read: (f: string) => head[f] ?? null, setupFiles: opts.setupFiles ?? [] }) as Narrowed
}

// --- Fixtures: a module of functions and a table, a class with a factory, and the tests reaching them.
const LIB = `import type { T } from './types'
export function fa(): number {
  return 1
}
export function fb(): number {
  return 2
}
export function wrap(): number {
  return fa()
}
export const TABLE = { a: fa, b: fb }
`
const LIB_FA = LIB.replace('return 1', 'return 10')
const SVC = `export class Svc {
  count = 0
  m(): number {
    return 1
  }
}
export function createSvc(): Svc {
  return new Svc()
}
export function helper(): number {
  return 3
}
`
const SVC_M = SVC.replace('return 1', 'return 10')
const t = (name: string, body: string): Files => ({ [`tests/${name}.test.ts`]: body })
const FILES: Files = {
  'src/main/types.ts': 'export type T = number\n',
  'src/main/lib.ts': LIB,
  'src/main/svc.ts': SVC,
  'src/main/useA.ts': "import { fa } from './lib'\nexport const useA = () => fa()\n",
  'src/main/useB.ts': "import { fb } from './lib'\nexport const useB = () => fb()\n",
  // A lookup by a built key, unrelated to anything changed: it reaches nothing of lib's.
  'src/main/lookups.ts': "import { fb } from './lib'\nconst hashes: Record<string, number> = {}\nexport const skill = (x: string) => hashes[`skill:${x}`] ?? fb()\n",
  'src/main/barrel.ts': "export { fa as alpha } from './lib'\n",
  'src/main/everything.ts': "export * from './lib'\n",
  'src/main/useSvc.ts': "import { createSvc } from './svc'\nexport const call = (k: string) => (createSvc() as unknown as Record<string, () => number>)[`${k}`]()\n",
  'src/main/useHelper.ts': "import { helper } from './svc'\nexport const h = () => helper()\n",
  ...t('a', "import { useA } from '../src/main/useA'\nit('a', () => useA())\n"),
  ...t('b', "import { useB } from '../src/main/useB'\nit('b', () => useB())\n"),
  ...t('wrap', "import { wrap } from '../src/main/lib'\nit('w', () => wrap())\n"),
  ...t('lookups', "import { skill } from '../src/main/lookups'\nit('l', () => skill('x'))\n"),
  // A table's entry by a key read from a fixture, by Object.keys, and by for-in: none names fa.
  ...t('fixtureKey', "import { readFileSync } from 'fs'\nimport { TABLE } from '../src/main/lib'\nit('k', () => (TABLE as Record<string, () => number>)[readFileSync('k.txt', 'utf8')]())\n"),
  ...t('keys', "import { TABLE } from '../src/main/lib'\nit('k', () => Object.values(TABLE).map((f) => f()))\n"),
  ...t('forIn', "import { TABLE } from '../src/main/lib'\nit('k', () => { for (const k in TABLE) (TABLE as Record<string, () => number>)[k]() })\n"),
  ...t('alias', "import { alpha } from '../src/main/barrel'\nit('al', () => alpha())\n"),
  ...t('star', "import * as all from '../src/main/everything'\nit('st', () => all.fb())\n"),
  ...t('nsComputed', "import * as lib from '../src/main/lib'\nit('ns', () => (lib as unknown as Record<string, () => number>)[process.env.K!]())\n"),
  ...t('nsByName', "import * as lib from '../src/main/lib'\nit('ns', () => lib.fb())\n"),
  ...t('dynDestructured', "it('d', async () => { const { fb } = await import('../src/main/lib'); fb() })\n"),
  ...t('dynWhole', "it('d', async () => { const m = await import('../src/main/lib'); (m as unknown as Record<string, () => number>)[process.env.K!]() })\n"),
  ...t('requireWhole', "const lib = require('../src/main/lib')\nit('r', () => lib[process.env.K!]())\n"),
  ...t('mockOriginal', "import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\nvi.mock('../src/main/lib', async (importOriginal) => ({ ...(await importOriginal<object>()) }))\nit('m', () => fb())\n"),
  ...t('actual', "import { vi } from 'vitest'\nimport { useB } from '../src/main/useB'\nit('m', async () => { await vi.importActual('../src/main/lib'); useB() })\n"),
  ...t('reflection', "import { useB } from '../src/main/useB'\nit('r', () => Object.getOwnPropertyNames(Object.getPrototypeOf(useB)))\n"),
  ...t('svcComputed', "import { call } from '../src/main/useSvc'\nit('s', () => call(process.env.K!))\n"),
  ...t('svcHelper', "import { h } from '../src/main/useHelper'\nit('h', () => h())\n")
}
const withLib = (lib: string): Files => ({ ...FILES, 'src/main/lib.ts': lib })

describe('the import graph', () => {
  const known = new Map(['src/main/a.ts', 'src/main/dir/index.ts', 'src/shared/x.ts', 'src/main/w.ts', 'src/main/data.json'].map((f) => [f.toLowerCase(), f]))
  it('resolves relative paths, .js for .ts, index files, the @shared alias and queries; packages (electron too) are none', () => {
    expect(resolveSpecifier('src/main/b.ts', './a', known)).toBe('src/main/a.ts')
    expect(resolveSpecifier('src/main/b.ts', './a.js', known)).toBe('src/main/a.ts')
    expect(resolveSpecifier('src/main/b.ts', './dir', known)).toBe('src/main/dir/index.ts')
    expect(resolveSpecifier('src/renderer/src/c.ts', '@shared/x', known)).toBe('src/shared/x.ts')
    expect(resolveSpecifier('src/main/b.ts', 'electron', known)).toBeNull()
    expect(resolveSpecifier('src/main/b.ts', './w?worker', known)).toBe('src/main/w.ts')
    expect(resolveSpecifier('src/main/b.ts', './data.json', known)).toBe('src/main/data.json')
    expect(resolveSpecifier('src/main/b.ts', 'react', known)).toBeNull()
    expect(resolveSpecifier('src/main/b.ts', 'original-fs', known)).toBeNull()
  })
  it("follows imports, re-exports, import(), require() and vi.mock's paths to every file they reach", () => {
    const files: Files = { 'tests/x.test.ts': "import { a } from '../src/a'\nvi.mock('../src/m')\n", 'src/a.ts': "export * from './b'\nconst c = () => import('./c')\n", 'src/b.ts': "const d = require('./d')\n", 'src/c.ts': '', 'src/d.ts': '', 'src/m.ts': '', 'src/other.ts': '' }
    const g = importGraph(Object.keys(files), (f: string) => files[f])
    expect([...g.closure('tests/x.test.ts')].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/m.ts', 'tests/x.test.ts'])
  })
  it("reads vitest.config.ts's setup files, and nothing when the list isn't plain strings", () => {
    expect(setupFilesOf("test: { setupFiles: ['tests/a.ts', 'tests/b.ts'], x: 1 }")).toEqual(['tests/a.ts', 'tests/b.ts'])
    expect(setupFilesOf('test: { setupFiles: [...SETUP] }')).toBeNull()
    expect(setupFilesOf('test: {}')).toBeNull()
    expect(setupFilesOf(readFileSync(join(root, 'vitest.config.ts'), 'utf8'))).toContain('tests/cleanGitEnv.ts')
  })
})

describe("a changed file's units, and what is searched for them", () => {
  it('a function: its name, and those in its file naming it (a wrapper, a table) until none is added', () => {
    expect(needlesOf('src/main/lib.ts', FILES, withLib(LIB_FA))).toEqual(['TABLE', 'fa', 'wrap'])
  })
  it("a table's entry: the table too", () => {
    expect(needlesOf('src/main/lib.ts', FILES, withLib(LIB.replace('b: fb }', 'b: fb, c: fa }')))).toEqual(['TABLE'])
  })
  it("a class's member: its class, and what in its file names that (a factory)", () => {
    expect(needlesOf('src/main/svc.ts', FILES, { ...FILES, 'src/main/svc.ts': SVC_M })).toEqual(['Svc', 'createSvc', 'm'])
  })
  it('an alias it exports under: both names', () => {
    const base = { 'src/main/x.ts': 'function f(): number {\n  return 1\n}\nexport { f as g }\n' }
    expect(needlesOf('src/main/x.ts', base, { 'src/main/x.ts': base['src/main/x.ts'].replace('return 1', 'return 2') })).toEqual(['f', 'g'])
  })
  it('a type-only import, or comments alone: nothing', () => {
    expect(needlesOf('src/main/lib.ts', FILES, withLib(LIB.replace("import type { T } from './types'", "import type { T, U } from './types'")))).toEqual([])
    expect(needlesOf('src/main/lib.ts', FILES, withLib(LIB.replace('export function fb', '// fb: two\nexport function fb')))).toEqual([])
  })
  it("every test that loads it, saying why, whenever a change can't be split by name", () => {
    expect(allOf('src/main/lib.ts', FILES, withLib(LIB.replace("import type { T } from './types'", "import { T } from './types'")))).toMatch(/line 1 .* in no function/)
    expect(allOf('src/main/lib.ts', FILES, withLib(`${LIB}console.log('loaded')\n`))).toMatch(/in no function/)
    expect(allOf('src/main/lib.ts', withLib(`${LIB}register(fa)\n`), withLib(`${LIB_FA}register(fa)\n`))).toMatch(/module code names fa .* runs as it loads/)
    expect(allOf('src/main/svc.ts', FILES, { ...FILES, 'src/main/svc.ts': SVC.replace('count = 0', 'count = 1') })).toMatch(/Svc\.count, a field/)
    expect(allOf('src/main/svc.ts', FILES, { ...FILES, 'src/main/svc.ts': SVC.replace('  count = 0\n', '  count = 0\n  constructor() {\n    void 0\n  }\n') })).toMatch(/in no function/)
    expect(allOf('src/main/new.ts', FILES, { ...FILES, 'src/main/new.ts': 'export const n = 1\n' })).toMatch(/added, deleted or unreadable in base/)
    expect(allOf('src/main/lib.ts', FILES, withLib(`${LIB}export function (\n`))).toMatch(/doesn't parse in head/)
    expect(allOf('src/main/data.json', { 'src/main/data.json': '{}' }, { 'src/main/data.json': '{"a":1}' })).toMatch(/isn't code/)
  })
})

describe('the related tests a change keeps', () => {
  const fa = narrow(FILES, withLib(LIB_FA))
  it('keeps the tests whose loaded files name a changed unit, or what holds it', () => {
    for (const k of ['a', 'wrap', 'fixtureKey', 'keys', 'forIn', 'alias']) expect(fa.keep, k).toContain(`tests/${k}.test.ts`)
  })
  it('keeps those using the changed module whole, whatever they name', () => {
    for (const k of ['star', 'nsComputed', 'dynWhole', 'requireWhole', 'mockOriginal', 'actual']) expect(fa.keep, k).toContain(`tests/${k}.test.ts`)
    expect(fa.why.join('\n')).toMatch(/re-exports all of src\/main\/lib\.ts/)
  })
  it('keeps one loading a file that lists keys by reflection', () => {
    expect(fa.keep).toContain('tests/reflection.test.ts')
  })
  it('leaves out those reaching the module only for other units, by name, the unrelated built-key lookup among them', () => {
    expect(fa.dropped).toEqual(['tests/b.test.ts', 'tests/dynDestructured.test.ts', 'tests/lookups.test.ts', 'tests/nsByName.test.ts'])
  })
  it("a class's member: kept where an instance can be had (its factory named), left out where only another unit is used", () => {
    const m = narrow(FILES, { ...FILES, 'src/main/svc.ts': SVC_M })
    expect(m.keep).toEqual(['tests/svcComputed.test.ts'])
    expect(m.dropped).toEqual(['tests/svcHelper.test.ts'])
  })
  it("a file it can't split keeps every test loading it: another changed file's narrowing doesn't mask it", () => {
    const head = { ...withLib(LIB_FA), 'src/main/useB.ts': "import { fb } from './lib'\nconsole.log('b')\nexport const useB = () => fb()\n" }
    const r = narrow(FILES, head)
    expect(r.keep).toContain('tests/b.test.ts')
    expect(r.keep).toContain('tests/a.test.ts')
    expect(r.dropped).toEqual(['tests/dynDestructured.test.ts', 'tests/lookups.test.ts', 'tests/nsByName.test.ts'])
  })
  it("keeps a related test the graph read here doesn't connect to a change (Vitest followed a way this doesn't)", () => {
    const r = narrow(FILES, withLib(LIB_FA), { related: ['tests/b.test.ts', 'tests/svcHelper.test.ts'] })
    expect(r.keep).toEqual(['tests/svcHelper.test.ts'])
    expect(r.why.join('\n')).toMatch(/1 related test files kept: the imports read here don't reach a changed file/)
  })
  it('counts the setup files as every test loads them', () => {
    const head = { ...withLib(LIB_FA), 'tests/setup.ts': "import { fa } from '../src/main/lib'\nfa()\n" }
    expect(narrow(FILES, head, { setupFiles: ['tests/setup.ts'] }).dropped).toEqual([])
  })
  it('no related tests: nothing kept, nothing left out', () => {
    expect(narrow(FILES, withLib(LIB_FA), { related: [] })).toMatchObject({ keep: [], dropped: [] })
  })
})

describe('a module the graph resolves, or loads it cannot know (HR3, round 1)', () => {
  const SERVICE = 'export function fa(): number {\n  return 1\n}\nexport function fb(): number {\n  return 2\n}\n'
  const base: Files = {
    'src/service/index.ts': SERVICE,
    'src/main/types.ts': FILES['src/main/types.ts'],
    'src/main/lib.ts': LIB,
    'src/main/useB.ts': FILES['src/main/useB.ts'],
    'src/main/data/a.json': '{}',
    ...t('svcDir', "import * as svc from '../src/service'\nit('s', () => (svc as unknown as Record<string, () => number>)[process.env.KEY!]())\n"),
    ...t('svcDirByName', "import * as svc from '../src/service'\nit('s', () => svc.fb())\n"),
    ...t('libJs', "import * as lib from '../src/main/lib.js'\nit('l', () => (lib as unknown as Record<string, () => number>)[process.env.KEY!]())\n"),
    ...t('otherComputed', "import * as u from '../src/main/useB'\nit('o', () => (u as unknown as Record<string, () => number>)[process.env.KEY!]())\n"),
    ...t('mixed', "import { fb } from '../src/main/lib'\nit('m', async () => { const p = '../src/main/' + 'lib'; const ns = await import(p); ns[process.env.KEY!](); fb() })\n"),
    ...t('literalLookup', "import { fb } from '../src/main/lib'\nit('m', async () => { const { fb: b } = await import('../src/main/lib'); const t: Record<string, number> = {}; void t[`x:${b()}`]; fb() })\n"),
    ...t('missing', "import { fb } from '../src/main/lib'\nimport { gone } from '../src/main/gone'\nit('m', () => fb() + gone())\n"),
    ...t('created', "import { createRequire } from 'module'\nconst req = createRequire(import.meta.url)\nit('c', () => req('../src/main/lib').fb())\n"),
    ...t('createdComputed', "import { createRequire } from 'module'\nimport { fb } from '../src/main/lib'\nconst req = createRequire(import.meta.url)\nit('c', () => req(process.env.P!) && fb())\n"),
    ...t('globbed', "import { fb } from '../src/main/lib'\nconst DATA = import.meta.glob('../src/main/data/*.json', { eager: true })\nit('g', () => fb() + Object.keys(DATA).length)\n"),
    ...t('globComputed', "import { fb } from '../src/main/lib'\nconst DATA = import.meta.glob(process.env.G!)\nit('g', () => fb() + Object.keys(DATA).length)\n")
  }
  it('a directory or .js import of the changed module, used whole, keeps the test; by name, or another module whole, leaves it out', () => {
    const svc = narrow(base, { ...base, 'src/service/index.ts': SERVICE.replace('return 1', 'return 10') })
    expect(svc.keep).toEqual(['tests/svcDir.test.ts'])
    expect(svc.dropped).toEqual(['tests/svcDirByName.test.ts'])
    expect(svc.why.join('\n')).toMatch(/tests\/svcDir\.test\.ts uses src\/service\/index\.ts whole as svc/)
    const lib = narrow(base, { ...base, 'src/main/lib.ts': LIB_FA })
    expect(lib.keep).toContain('tests/libJs.test.ts')
    expect(lib.dropped).toContain('tests/otherComputed.test.ts')
  })
  it('a module loaded by a path worked out at run time, or not in the repository, keeps the test, though another import reaches the change', () => {
    const lib = narrow(base, { ...base, 'src/main/lib.ts': LIB_FA })
    for (const k of ['mixed', 'missing', 'createdComputed', 'globComputed']) expect(lib.keep, k).toContain(`tests/${k}.test.ts`)
    const why = lib.why.join('\n')
    expect(why).toMatch(/tests\/mixed\.test\.ts may load code by import\(\)/)
    expect(why).toMatch(/tests\/missing\.test\.ts loads \.\.\/src\/main\/gone \(line 2\), which isn't in the repository/)
    expect(why).toMatch(/tests\/globComputed\.test\.ts may load code by import\.meta/)
    // A literal import() taken apart by name, and an unrelated built-key lookup, leave it out.
    expect(lib.dropped).toContain('tests/literalLookup.test.ts')
  })
  it("createRequire's and import.meta.glob's literal paths are edges", () => {
    const g = importGraph(Object.keys(base), (f: string) => base[f])
    expect([...g.closure('tests/created.test.ts')]).toContain('src/main/lib.ts')
    expect([...g.closure('tests/globbed.test.ts')]).toContain('src/main/data/a.json')
    expect(g.unknownOf('tests/created.test.ts')).toBeNull()
    expect(g.unknownOf('tests/globbed.test.ts')).toBeNull()
    // So a change to the data a glob loads reaches the test (and, not code, keeps it), whatever else it imports.
    expect(narrow(base, { ...base, 'src/main/data/a.json': '{"a":1}' }).keep).toContain('tests/globbed.test.ts')
  })
  it("a file it loads that can't be read keeps the test", () => {
    const head: Files = { ...base, 'src/main/lib.ts': LIB_FA }
    const graph = importGraph([...Object.keys(head), 'src/main/useB.ts'], (f: string) => (f === 'src/main/useB.ts' ? null : head[f] ?? null))
    expect(graph.unknownOf('src/main/useB.ts')).toMatch(/couldn't be read/)
    const r = narrowRelated({ related: ['tests/otherComputed.test.ts'], changes: { 'src/main/lib.ts': change('src/main/lib.ts', base, head) }, graph, read: (f: string) => head[f] ?? null }) as Narrowed
    expect(r.keep).toEqual(['tests/otherComputed.test.ts'])
  })
  it('a comment or a string that only looks like a computed import is nothing', () => {
    const files: Files = { 'src/a.ts': "// import (#1106): a note\nconst s = 'require(x)'\nexport const a = 1\n" }
    expect(importGraph(Object.keys(files), (f: string) => files[f]).unknownOf('src/a.ts')).toBeNull()
  })
})

describe('loaders the graph must see, computed or whole (HR1, round 2)', () => {
  const base: Files = {
    'src/main/types.ts': FILES['src/main/types.ts'],
    'src/main/lib.ts': LIB,
    'src/main/useB.ts': FILES['src/main/useB.ts'],
    ...t('viComputed', "import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\nit('v', async () => { const p = '../src/main/' + 'lib'; const ns = await vi.importActual<Record<string, () => number>>(p); ns[process.env.KEY!](); fb() })\n"),
    ...t('viAliased', "import { vi as v } from 'vitest'\nimport { fb } from '../src/main/lib'\nit('v', async () => { await v.importActual(process.env.P!); fb() })\n"),
    ...t('requireWhole', "import { createRequire } from 'module'\nconst req = createRequire(import.meta.url)\nit('r', () => { const ns = req('../src/main/lib'); ns[process.env.KEY!]() })\n"),
    ...t('requireByName', "import { createRequire } from 'module'\nconst req = createRequire(import.meta.url)\nit('r', () => req('../src/main/lib').fb())\n"),
    ...t('requireHanded', "import { createRequire } from 'module'\nimport { fb } from '../src/main/lib'\nconst req = createRequire(import.meta.url)\nit('r', () => [req].map((r) => r(process.env.P!)) && fb())\n"),
    ...t('globWhole', "import { fb } from '../src/main/lib'\nconst modules = import.meta.glob('../src/main/*.ts', { eager: true })\nit('g', () => { for (const ns of Object.values(modules)) (ns as Record<string, () => number>)[process.env.KEY!](); fb() })\n"),
    ...t('literalLookup', "import { fb } from '../src/main/lib'\nit('m', async () => { const { fb: b } = await import('../src/main/lib'); const t: Record<string, number> = {}; void t[`x:${b()}`]; fb() })\n")
  }
  const lib = narrow(base, { ...base, 'src/main/lib.ts': LIB_FA })
  it('a computed vi.importActual (vi imported under any name) is a path worked out at run time: kept, beside a literal import() by name, left out', () => {
    for (const k of ['viComputed', 'viAliased']) expect(lib.keep, k).toContain(`tests/${k}.test.ts`)
    expect(lib.why.join('\n')).toMatch(/viComputed\.test\.ts uses vi other than for its calls that load nothing/)
    expect(lib.dropped).toContain('tests/literalLookup.test.ts')
  })
  it("a createRequire require used whole, or handed on, keeps the test; one taken apart by name doesn't", () => {
    expect(lib.keep).toContain('tests/requireWhole.test.ts')
    expect(lib.keep).toContain('tests/requireHanded.test.ts')
    expect(lib.dropped).toContain('tests/requireByName.test.ts')
    expect(lib.why.join('\n')).toMatch(/requireHanded\.test\.ts may load code by createRequire/)
  })
  it("import.meta.glob of code is a use of each module it matches, whole", () => {
    expect(lib.keep).toContain('tests/globWhole.test.ts')
    expect(lib.why.join('\n')).toMatch(/globs src\/main\/lib\.ts with others, whole/)
  })
})

describe('the allowlist and the gate (the Assistant\'s design after round 3; HR2, round 3)', () => {
  const computed = "const p = '../src/main/' + 'lib'"
  const base: Files = {
    'src/main/types.ts': FILES['src/main/types.ts'],
    'src/main/lib.ts': LIB,
    'src/main/useB.ts': FILES['src/main/useB.ts'],
    // HR2's probes: each loads lib by a computed path beside a named fb edge, so only the gate can keep it.
    ...t('localRequire', `import { createRequire } from 'module'\nimport { fb } from '../src/main/lib'\nconst require = createRequire(import.meta.url)\nit('r', () => { ${computed}; const ns = require(p); ns[process.env.KEY!](); fb() })\n`),
    ...t('viComputedKey', `import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\nit('v', async () => { ${computed}; const ns = await vi['importActual']<Record<string, () => number>>(p); ns[process.env.KEY!](); fb() })\n`),
    ...t('vitestExport', `import { vitest } from 'vitest'\nimport { fb } from '../src/main/lib'\nit('v', async () => { ${computed}; const ns = await vitest.importActual<Record<string, () => number>>(p); ns[process.env.KEY!](); fb() })\n`),
    ...t('importMock', `import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\nit('v', async () => { ${computed}; await vi.importMock(p); fb() })\n`),
    ...t('mockComputed', `import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\n${computed}\nvi.mock(p)\nit('v', () => fb())\n`),
    ...t('doMockComputed', `import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\n${computed}\nit('v', () => { vi.doMock(p); fb() })\n`),
    ...t('viHanded', "import { vi } from 'vitest'\nimport { fb } from '../src/main/lib'\nconst v = vi\nit('v', () => { void v; fb() })\n"),
    // HR2's round-4 probes: the global object handed on, and a loader taken from it by a literal key.
    ...t('globalHanded', "import { fb } from '../src/main/lib'\nit('g', () => { const g = globalThis; const k = process.env.LOADER!; const f = (g as unknown as Record<string, (s: string) => void>)[k]; f(process.env.SCRIPT!); fb() })\n"),
    // HR2's round-5 probes: the code constructor taken as a value, by itself and as a global's member.
    ...t('functionValue', "import { fb } from '../src/main/lib'\nit('f', () => { const F = Function; F(process.env.SCRIPT!)(); fb() })\n"),
    ...t('globalFunction', "import { fb } from '../src/main/lib'\nit('f', () => { const F = globalThis.Function; F(process.env.SCRIPT!)(); fb() })\n"),
    // Safe: a local binding that happens to be a member called like one, and `typeof … === 'function'`.
    ...t('localCall', "import { fb } from '../src/main/lib'\nit('f', () => { const o = { run: (s: string) => s.length }; o.run('x'); void (typeof fb === 'function'); fb() })\n"),
    ...t('globalLiteralKey',"import { fb } from '../src/main/lib'\nit('g', () => { const e = globalThis['eval']; e(process.env.SCRIPT!); fb() })\n"),
    // Safe: a named member of the global object, through a cast too.
    ...t('globalByName', "import { fb } from '../src/main/lib'\nit('g', () => { globalThis.crypto.getRandomValues(new Uint8Array(1)); void (globalThis as { x?: number }).x; fb() })\n"),
    // Allowed: each a literal form, so they narrow.
    ...t('literalForms', "import { vi } from 'vitest'\nimport { createRequire } from 'module'\nimport { fb } from '../src/main/lib'\nconst require = createRequire(import.meta.url)\nvi.mock('../src/main/useB', () => ({ useB: () => 0 }))\nit('v', async () => { const { useB } = await import('../src/main/useB'); require('../src/main/useB').useB(); createRequire(import.meta.url)('../src/main/useB').useB(); vi.fn(); vi.spyOn(console, 'log'); useB(); fb() })\n")
  }
  const lib = narrow(base, { ...base, 'src/main/lib.ts': LIB_FA })
  it("keeps each of HR2's probes: a createRequire require named require, vi['importActual'], vitest's own export, and the other Vitest loaders computed", () => {
    for (const k of ['localRequire', 'viComputedKey', 'vitestExport', 'importMock', 'mockComputed', 'doMockComputed', 'viHanded', 'globalHanded', 'globalLiteralKey', 'functionValue', 'globalFunction']) expect(lib.keep, k).toContain(`tests/${k}.test.ts`)  })
  it('leaves out a file whose loads are all literal allowed forms, naming nothing changed', () => {
    expect(lib.dropped).toEqual(['tests/globalByName.test.ts', 'tests/literalForms.test.ts', 'tests/localCall.test.ts'])
  })
  it('a worker or a process running JavaScript (the Assistant\'s option 4): in src, it counts only when the change is in what a build entry loads', () => {
    const w: Files = {
      'src/main/types.ts': FILES['src/main/types.ts'],
      'src/main/lib.ts': LIB,
      'src/main/logWriter.ts': "import { fb } from './lib'\nfb()\n",
      'src/main/other.ts': 'export function fo(): number {\n  return 1\n}\n',
      'src/main/logger.ts': "import { Worker } from 'worker_threads'\nimport { fb } from './lib'\nimport { fo } from './other'\nexport const log = (script: string) => new Worker(script) && fb() + fo()\n",
      ...t('logger', "import { log } from '../src/main/logger'\nit('l', () => log('x'))\n"),
      ...t('spawns', "import { spawnSync } from 'child_process'\nimport { fo } from '../src/main/other'\nit('s', () => spawnSync(process.execPath, []) && fo())\n"),
      ...t('script', "import { log } from '../src/main/logger'\nit('s', () => log('fixture-worker.cjs'))\n")
    }
    const other = (workers: string[] | null): Narrowed => {
      const head: Files = { ...w, 'src/main/other.ts': w['src/main/other.ts'].replace('return 1', 'return 2') }
      const graph = importGraph(Object.keys(head), (f: string) => head[f] ?? null)
      return narrowRelated({ related: ['tests/logger.test.ts', 'tests/spawns.test.ts', 'tests/script.test.ts'], changes: { 'src/main/other.ts': change('src/main/other.ts', w, head) }, graph, read: (f: string) => head[f] ?? null, workers }) as Narrowed
    }
    // other.ts is in no entry's closure: logger.ts's worker doesn't matter, and the tests narrow by name (fo is named).
    expect(other(['src/main/logWriter.ts']).keep).toContain('tests/logger.test.ts')
    expect(other(['src/main/logWriter.ts']).why.join('\n')).not.toMatch(/logger\.ts starts a worker/)
    // A test starting node itself, or naming a script, is unknown whatever the entries are.
    expect(other(['src/main/logWriter.ts']).why.join('\n')).toMatch(/spawns\.test\.ts starts a worker or a process running JavaScript: a script it names/)
    expect(other(['src/main/logWriter.ts']).why.join('\n')).toMatch(/script\.test\.ts names a script, fixture-worker\.cjs/)
    // lib.ts is in logWriter's closure: a change to it keeps every test reaching a starter; unreadable entries do too.
    const libChange = (workers: string[] | null): string => {
      const head: Files = { ...w, 'src/main/lib.ts': LIB_FA }
      const graph = importGraph(Object.keys(head), (f: string) => head[f] ?? null)
      return narrowRelated({ related: ['tests/logger.test.ts'], changes: { 'src/main/lib.ts': change('src/main/lib.ts', w, head) }, graph, read: (f: string) => head[f] ?? null, workers }).why.join('\n')
    }
    expect(libChange(['src/main/logWriter.ts'])).toMatch(/src\/main\/logger\.ts starts a worker or a process running JavaScript, and a change is in what one of the build’s workers or scripts loads/)
    expect(libChange(null)).toMatch(/the build's worker entries couldn't be read/)
  })
  it("an unknown file in a worker entry's closure makes what the entries may run unknown: the starter counts (HR2, round 4)", () => {
    const w: Files = {
      'src/main/types.ts': FILES['src/main/types.ts'],
      'src/main/lib.ts': LIB,
      'src/main/starter.ts': "import { Worker } from 'worker_threads'\nimport { fb } from './lib'\nexport function start(p: string): number {\n  void new Worker(p)\n  return fb()\n}\n",
      'src/main/worker.ts': 'void import(process.env.TARGET!).then((m) => m[process.env.KEY!]())\n',
      ...t('worker', "import { start } from '../src/main/starter'\nit('w', () => start('worker'))\n")
    }
    const head: Files = { ...w, 'src/main/lib.ts': LIB_FA }
    const graph = importGraph(Object.keys(head), (f: string) => head[f] ?? null)
    const r = narrowRelated({ related: ['tests/worker.test.ts'], changes: { 'src/main/lib.ts': change('src/main/lib.ts', w, head) }, graph, read: (f: string) => head[f] ?? null, workers: ['src/main/worker.ts'] }) as Narrowed
    expect(r.keep).toEqual(['tests/worker.test.ts'])
    expect(r.why.join('\n')).toMatch(/starter\.ts starts a worker .* what the build's workers and scripts load isn't all known \(src\/main\/worker\.ts may load code by import\(\)\)/)
  })
  it("electron.vite.config.ts's worker and script entries, the app's own index aside; null when an entry isn't in the known form", () => {
    expect(workerEntriesOf("input: {\n  index: resolve(__dirname, 'src/main/index.ts'),\n  // a worker\n  'git-worker': resolve(__dirname, 'src/main/gitWorker.ts'),\n}")).toEqual(['src/main/gitWorker.ts'])
    expect(workerEntriesOf("input: {\n  w: resolve(__dirname, WORKER),\n}")).toBeNull()
    expect(workerEntriesOf('build: {}')).toBeNull()
    expect(workerEntriesOf(readFileSync(join(root, 'electron.vite.config.ts'), 'utf8'))).toContain('src/main/logWriter.ts')
  })
  it('a node script from text is read as a file of its own: a fixed one loading nothing of the repository is allowed', () => {
    const unknown = (text: string): string | null => importGraph(['src/x.ts'], () => text).unknownOf('src/x.ts')
    expect(unknown("import { spawn } from 'child_process'\nconst S = `const c = require('child_process'); c.spawn('git')`\nspawn(process.execPath, ['-e', S])\n")).toBeNull()
    expect(unknown("import { spawn } from 'child_process'\nconst S = `require('./lib')`\nspawn(process.execPath, ['-e', S])\n")).toMatch(/script made from text/)
    expect(unknown("import { spawn } from 'child_process'\nconst S = `require(${JSON.stringify(p)})`\nspawn(process.execPath, ['-e', S])\n")).toMatch(/script made from text/)
    // `-p` is git's patch flag where nothing starts node.
    expect(unknown("export const args = ['log', '-p', '-U0']\n")).toBeNull()
    // HI-2697: a fixed script that itself starts a process (the queue's launcher) is its src file's starter, under the
    // build entries' rule; outside src a starter is unknown whatever its script.
    const starting = "import { spawn } from 'child_process'\nconst S = `process.env.ELECTRON_RUN_AS_NODE = '1'; require('child_process').spawn(process.env.CMD)`\nspawn(process.execPath, ['-e', S, '129'])\n"
    const graph = (f: string) => importGraph([f], () => starting)
    expect(graph('src/main/x.ts').unknownOf('src/main/x.ts')).toBeNull()
    expect(graph('src/main/x.ts').startsOf('src/main/x.ts')).toMatch(/starts a worker/)
    expect(graph('tests/x.ts').unknownOf('tests/x.ts')).toBeTruthy()
  })
  it("the merge queue's node scripts, cw-mcp and the renderer's window uses stay known (HI-2697)", () => {
    const hubs = ['src/main/workflow/launcher.ts', 'src/main/workflow/gitHost.ts', 'src/main/mcp/cw-mcp.ts', 'src/renderer/src/commitLoop.tsx', 'src/renderer/src/commitWatch.ts', 'src/renderer/src/windowHealth.ts']
    const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)
    const g = importGraph(files, (f: string) => {
      try {
        return readFileSync(join(root, f), 'utf8')
      } catch {
        return null
      }
    })
    for (const f of hubs) expect(g.unknownOf(f), f).toBeNull()
  })
  it("the gate's tokens, each on what an allowed form leaves behind; comments, strings and types are nothing", () => {
    const unknown = (text: string): string | null => importGraph(['src/x.ts'], () => text).unknownOf('src/x.ts')
    for (const [text, what] of [
      ['const f = require', 'require'],
      ['void import(p)', 'import\\(\\)'],
      ['void import.meta.glob(g)', 'import\\.meta'],
      ["import Module from 'module'\nvoid Module", 'createRequire or the module module'],
      ['eval(s)', 'eval'],
      ['new Function(s)', 'eval'],
      ['vi.unmock(p)', 'uses vi other than'],
      ['x.importActual(p)', 'Vitest module loader'],
      ['globalThis[k]()', 'global object other than by a member'],
      ["globalThis['eval'](s)", 'global object other than by a member|eval or a Function'],
      ['const F = Function', 'eval or a Function'],
      ["const C = x['constructor']", 'eval or a Function'],
      ['const { constructor: c } = x', 'eval or a Function'],
      ['const g = globalThis', 'global object other than by a member']
    ] as const) expect(unknown(text), text).toMatch(new RegExp(what))
    for (const text of ["// require(x), import(p), eval\nexport const a = 1\n", "const s = 'require(x) eval(y) import(z)'\n", "type T = typeof import('./y')\nconst u: import('./y').U = 1\n", 'const k = import.meta.url\n', "import { syncBuiltinESMExports } from 'module'\nsyncBuiltinESMExports()\n", "const global = { a: 1 }\nvoid global[k]\n", 'export class A {\n  constructor(private n: number) {}\n  get(): number {\n    return this.n\n  }\n}\n']) expect(unknown(text), text).toBeNull()
  })
})

describe('using a module whole', () => {
  const use = (text: string): string | null => {
    const files: Files = { 'tests/x.test.ts': text, 'src/main/lib.ts': LIB, 'src/main/types.ts': '', 'src/main/other.ts': '' }
    return importGraph(Object.keys(files), (f: string) => files[f]).wholeOf('tests/x.test.ts', 'src/main/lib.ts')
  }
  it('safe: by name, in types, taken apart at once, or not this module', () => {
    expect(use("import * as lib from '../src/main/lib'\nlib.fa(); lib['fb']()\ntype L = typeof lib\n")).toBeNull()
    expect(use("const { fa } = await import('../src/main/lib')\nconst b = (await import('../src/main/lib')).fb\nconst { fb } = require('../src/main/lib')\n")).toBeNull()
    expect(use("import * as other from '../src/main/other'\nother[k]()\n")).toBeNull()
    expect(use("vi.mock('../src/main/lib', () => ({ fa: () => 0 }))\n")).toBeNull()
  })
  it('unsafe: a computed key, a hand-off, a spread, export *, a whole import() or require()', () => {
    expect(use("import * as lib from '../src/main/lib'\nlib[k]()\n")).toMatch(/uses .* whole as lib/)
    expect(use("import lib from '../src/main/lib'\nrun(lib)\n")).toMatch(/whole as lib/)
    expect(use("import * as lib from '../src/main/lib'\nconst c = { ...lib }\n")).toMatch(/whole as lib/)
    expect(use("export * from '../src/main/lib'\n")).toMatch(/re-exports all/)
    expect(use("import('../src/main/lib').then((m) => m.fa())\n")).toMatch(/imports .* whole/)
    expect(use("const lib = require('../src/main/lib')\n")).toMatch(/requires .* whole/)
    expect(use("const { fa, ...rest } = require('../src/main/lib')\n")).toMatch(/requires .* whole/)
  })
})

describe("the picker's entry: the working tree against a commit", () => {
  it('narrows the related tests it is given, keeping every one when the config is unreadable', () => {
    const dir = tempDir('related-tests-')
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, env: runContext.baseEnv(), encoding: 'utf8' })
    const put = (files: Files): void => {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, f)), { recursive: true })
        writeFileSync(join(dir, f), text)
      }
    }
    put({ ...FILES, 'vitest.config.ts': "export default { test: { setupFiles: ['tests/setup.ts'] } }\n", 'tests/setup.ts': '' })
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    const base = git('rev-parse', 'HEAD').trim()
    put({ 'src/main/lib.ts': LIB_FA })
    const related = ['tests/a.test.ts', 'tests/b.test.ts']
    expect(narrowRelatedInTree({ cwd: dir, base, paths: ['src/main/lib.ts'], related })).toMatchObject({ keep: ['tests/a.test.ts'], dropped: ['tests/b.test.ts'] })
    put({ 'vitest.config.ts': 'export default { test: { setupFiles: SETUP } }\n' })
    const r = narrowRelatedInTree({ cwd: dir, base, paths: ['src/main/lib.ts'], related })
    expect(r).toMatchObject({ keep: related, dropped: [] })
    expect(r.why.join('\n')).toMatch(/setupFiles couldn't be read/)
    expect(narrowRelatedInTree({ cwd: dir, base: 'no-such-commit', paths: ['src/main/lib.ts'], related })).toMatchObject({ keep: related, dropped: [] })
  })
})

describe('HI-2654 (git history): a WorkspaceService member, so every related test until HI-2678', () => {
  it('keeps every test its change relates, the two that must run among them, saying why', () => {
    const commit = '22fd88db7a58f978d7059d3f21298d89a6fc2667'
    const out = (...a: string[]): string[] => execFileSync('git', a, { cwd: root, encoding: 'utf8', env: runContext.baseEnv(), maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean)
    const revs = { base: gitRevision(root, `${commit}^1`), head: gitRevision(root, commit) }
    const files = out('ls-tree', '-r', '--name-only', commit)
    const graph = importGraph(files, (f: string) => revs.head.read(f), revs.head.prefetch)
    const changed = out('diff', '--name-only', `${commit}^1`, commit)
    // Related by this graph (356; Vitest's own list at the time was HI-2627's 275).
    const related = files.filter((f) => /^tests\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(f) && !f.startsWith('tests/e2e/') && changed.some((c) => graph.closure(f).has(c)))
    const changes = Object.fromEntries(changed.map((f) => [f, narrowChange({ file: f, base: revs.base, head: revs.head, lines: gitChangedLines(root, `${commit}^1`, commit, f) })]))
    const r = narrowRelated({ related, changes, graph, read: (f: string) => revs.head.read(f), setupFiles: setupFilesOf(revs.head.read('vitest.config.ts')) }) as Narrowed
    expect(related.length).toBeGreaterThan(300)
    expect(r.dropped).toEqual([])
    for (const f of ['tests/settingsWorkspace.test.ts', 'tests/settingsReadFirst.test.ts']) expect(r.keep).toContain(f)
    expect(changes['src/main/settingsTools.ts'].needles.map((n: { name: string }) => n.name)).toEqual(['applySetting'])
    // Its class, and from it what in workspace.ts names that (the factories, the `workspace` instance), named by nearly
    // every test of main: HI-2678 narrows them by which receivers can be a WorkspaceService.
    expect(r.why.join('\n')).toMatch(/src\/main\/workspace\.ts: WorkspaceService\.setAdvanced, class WorkspaceService, .* and \d+ more/)
    expect(r.why.join('\n').length).toBeLessThan(3000)
    // It parses every code file the repository's tests reach (about 2,000: 17 s alone, more under a full run's load).
  }, 120_000)
})
