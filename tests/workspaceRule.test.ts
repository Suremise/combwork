// The WorkspaceService rule (HI-2678, tests/e2e/workspaceRule.mjs): each escape on a small TypeScript project read from
// memory (the census's own program, TypeScript 5.9 in-process), what keeps its type, what pins a test file instead of
// breaking the rule, the reviewed Proxy, the failures that fail closed, audits bound to a tree, and the rule's inputs.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { memoryRevision } from './e2e/affectedUnits.mjs'
// @ts-expect-error: plain .mjs modules without types
import { AUDITED, PROXY_HASH, census, proxyOf, ruleIdentity, ruleInput, ruleOn } from './e2e/workspaceRule.mjs'

const root = join(__dirname, '..')
type Files = Record<string, string>
type Escape = { file: string; line: number; text: string; why: string }
type Census = { all?: string; broken: string | null; escapes: Escape[]; exempt: Escape[]; pinned: string[] | null; errors: { file: string; code: number }[] }

const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2023', lib: ['ES2023'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*', 'tests/**/*'] })
const CLASS = `export class WorkspaceService {
  path: string | null = null
  setAdvanced(key: string, value: string): void {
    void key
    void value
  }
  isAllowedPath(p: string, extra?: string[]): boolean {
    return !!p && !extra
  }
}
`
const project = (files: Files): Files => ({ 'tsconfig.node.json': TSCONFIG, 'src/main/workspace.ts': CLASS, ...files })
const run = (files: Files, opts: { scope?: string; budget?: number } = {}): Census => census(memoryRevision(project(files), 'fixture'), root, opts) as Census
const use = (body: string, imports = "import { WorkspaceService } from './workspace'\n"): Files => ({ 'src/main/use.ts': `${imports}${body}` })
const brokenBy = (files: Files): string => {
  const c = run(files)
  expect(c.all ?? null, c.all).toBeNull()
  expect(c.broken, JSON.stringify(c.escapes)).toBeTruthy()
  return c.broken!
}
const holds = (files: Files): Census => {
  const c = run(files)
  expect(c.all ?? null, c.all).toBeNull()
  expect(c.broken, JSON.stringify(c.escapes)).toBeNull()
  return c
}

describe('what keeps its type: the rule holds', () => {
  it('typed parameters, containers, callbacks, views by name, members by name or a literal key', () => {
    const c = holds(
      use(`const byPath = new Map<string, WorkspaceService>()
export function keep(ws: WorkspaceService): string | null {
  byPath.set('a', ws)
  const list = [...byPath.values()].filter((w) => !!w.path)
  const view: Pick<WorkspaceService, 'setAdvanced'> = ws
  view.setAdvanced('a', 'b')
  ws['setAdvanced']('a', 'b')
  const { path } = ws
  const later = (): WorkspaceService => ws
  for (const w of list) if (w === later() && w instanceof WorkspaceService) return path
  return ws.path ?? null
}
`)
    )
    expect(c.escapes).toEqual([])
  })
  it('a same-named member of another class, its value erased: not a WorkspaceService, so nothing', () => {
    holds(use(`class Other {
  setAdvanced(): void {}
}
export const lost: unknown = new Other()
export const other = (o: Other): unknown => o
`))
  })
})

describe('each escape breaks the rule, naming where', () => {
  const cases: [string, string][] = [
    ['a cast to any', 'export const f = (ws: WorkspaceService): void => void (ws as any).path\n'],
    ['an unknown slot', 'const take = (v: unknown): void => void v\nexport const f = (ws: WorkspaceService): void => take(ws)\n'],
    ['a view into unknown', "export const f = (ws: WorkspaceService): unknown => {\n  const v: Pick<WorkspaceService, 'setAdvanced'> = ws\n  const lost: unknown = v\n  return lost\n}\n"],
    ['a container into unknown', 'export const f = (ws: WorkspaceService): unknown => {\n  const m = new Map<string, WorkspaceService>([["a", ws]])\n  return m as unknown\n}\n'],
    ['a callback returning one into a () => unknown slot', 'const later = (f: () => unknown): unknown => f()\nexport const g = (ws: WorkspaceService): unknown => later(() => ws)\n'],
    ['a holder passed as a narrower object', 'const name = (p: { path: string }): string => p.path\nexport const f = (ws: WorkspaceService): string => {\n  const holder = { path: "a", ws }\n  return name(holder)\n}\n'],
    ['a promise of a holder into Promise<unknown>', 'const background = (p: Promise<unknown>): void => void p\nexport const f = (ws: WorkspaceService): void => background(Promise.resolve({ ws }))\n'],
    ['a computed key', 'export const f = (ws: WorkspaceService, k: string): unknown => (ws as unknown as Record<string, unknown>)[k]\n'],
    ['a computed key on the class type itself', "export const f = (ws: WorkspaceService, k: 'setAdvanced' | 'isAllowedPath'): unknown => ws[k]\n"],
    ['a spread', 'export const f = (ws: WorkspaceService): object => ({ ...ws })\n'],
    ['for-in', 'export const f = (ws: WorkspaceService): string[] => {\n  const out: string[] = []\n  for (const k in ws) out.push(k)\n  return out\n}\n'],
    ['an index signature that erases', 'export const f = (ws: WorkspaceService): Record<string, unknown> => ({ ws })\n']
  ]
  for (const [what, body] of cases) {
    it(what, () => {
      expect(brokenBy(use(body))).toMatch(/^src\/main\/use\.ts:\d+: /)
    })
  }
  it('the class handing itself on as an object: this, into an object slot', () => {
    const own = CLASS.replace('  path: string | null = null\n', '  path: string | null = null\n  hold(): void {\n    keep({ holder: this })\n  }\n')
    expect(brokenBy({ 'src/main/workspace.ts': `const keep = (o: { holder?: object }): void => void o\n${own}` })).toMatch(/workspace\.ts:\d+: .*this/)
  })
  it('a member the language or a library reaches without its name: toJSON', () => {
    expect(brokenBy({ 'src/main/workspace.ts': CLASS.replace('  path: string | null = null\n', '  path: string | null = null\n  toJSON(): string {\n    return ""\n  }\n') })).toMatch(/declares toJSON/)
  })
})

describe('outside the app: an escape pins its file instead', () => {
  it("a test's fake through unknown, and a helper erasing one: pinned, the rule holding", () => {
    const c = holds({
      'tests/fake.test.ts': "import { WorkspaceService } from '../src/main/workspace'\nexport const fake = {} as unknown as WorkspaceService\nexport const lost: unknown = fake\n",
      'tests/helper.ts': "import { WorkspaceService } from '../src/main/workspace'\nexport const erased = (): any => new WorkspaceService() as any\n",
      'tests/clean.test.ts': "import { WorkspaceService } from '../src/main/workspace'\nexport const ok = (ws: WorkspaceService): string | null => ws.path\n"
    })
    expect(c.pinned).toEqual(['tests/fake.test.ts', 'tests/helper.ts'])
  })
  it("the rule's scope alone ('src', for e2e selection) reports no pins", () => {
    expect(run({ 'tests/fake.test.ts': "import { WorkspaceService } from '../src/main/workspace'\nexport const lost: unknown = new WorkspaceService()\n" }, { scope: 'src' }).pinned).toBeNull()
  })
})

describe('the workspace Proxy: exempt only as reviewed', () => {
  // The real initializer, with what it names declared around it.
  const real = readFileSync(join(root, 'src/main/workspace.ts'), 'utf8').replace(/\r\n/g, '\n')
  const p = proxyOf(real)!
  const init = real.slice(p.start, p.end)
  const AROUND = `const BY_PATH = new Set<string>(['assertProject'])
const services = new Set<WorkspaceService>()
const currentWorkspace = (): WorkspaceService => [...services][0]
const workspaceFor = (p: string): WorkspaceService | null => (p ? null : null)
`
  const proxied = (initializer: string): Files => ({ 'src/main/workspace.ts': `${CLASS}${AROUND}export const workspace: WorkspaceService = ${initializer}\n` })
  it("is this tree's reviewed text (PROXY_HASH): an edit to it needs a review and a new hash", () => {
    expect(p.hash).toBe(PROXY_HASH)
  })
  it('unchanged, its escapes are exempt; comments and spacing are not its tokens', () => {
    const c = holds(proxied(init))
    expect(c.exempt.length).toBeGreaterThanOrEqual(4)
    expect(holds(proxied(init.replace('get(_t, key: string) {', 'get(_t,   key: string) { // reformatted'))).exempt.length).toBe(c.exempt.length)
  })
  it('altered, even with its escapes the same, it breaks the rule until reviewed', () => {
    const altered = init.replace("if (key === 'isAllowedPath')", "if (key === 'isAllowedPath' || key === 'path')")
    expect(altered).not.toBe(init)
    expect(brokenBy(proxied(altered))).toMatch(/workspace Proxy .* isn't its reviewed text/)
  })
})

describe("what it can't prove fails closed", () => {
  it('a type error anywhere in the program, an unresolved import of the class among them', () => {
    expect(brokenBy(use('export const n: number = "text"\n'))).toMatch(/type error \(TS2322/)
    expect(brokenBy(use('export const f = (ws: WorkspaceService): unknown => ws\n', "import { WorkspaceService } from './no-such-module'\n"))).toMatch(/TS2307/)
  })
  it("a file of the rule's scope outside the program", () => {
    const files = { ...project(use('export const a = 1\n')), 'tsconfig.node.json': TSCONFIG.replace('"src/**/*"', '"src/main/workspace.ts"') }
    expect((census(memoryRevision(files, 'fixture'), root) as Census).all).toMatch(/src\/main\/use\.ts isn't in tsconfig\.node\.json's program/)
  })
  it('no tsconfig, no class, a type walk past its budget, a revision that throws', () => {
    expect((census(memoryRevision({ 'src/main/workspace.ts': CLASS }, 'fixture'), root) as Census).all).toMatch(/tsconfig\.node\.json can't be read/)
    expect(run({ 'src/main/workspace.ts': 'export const x = 1\n' }).all).toMatch(/WorkspaceService isn't declared/)
    expect(run(use('export const f = (ws: WorkspaceService): string | null => ws.path\n'), { budget: 5 }).all).toMatch(/ran out of its budget/)
    const throwing = { ...memoryRevision(project({}), 'fixture'), list: () => { throw new Error('disk gone') } }
    expect((census(throwing, root) as Census).all).toMatch(/census of fixture failed \(disk gone\)/)
  })
})

describe('both revisions, and audits bound to an exact tree', () => {
  const escaping = project(use('export const f = (ws: WorkspaceService): unknown => ws as unknown\n'))
  const clean = project(use('export const f = (ws: WorkspaceService): string | null => ws.path\n'))
  it("an escape only in base, removed at head: the rule doesn't hold", () => {
    expect(ruleOn([memoryRevision(escaping, 'base'), memoryRevision(clean, 'head')], root).all).toMatch(/doesn't hold: src\/main\/use\.ts:2: .*\(base\)/)
    expect(ruleOn([memoryRevision(clean, 'base'), memoryRevision(clean, 'head')], root)).toMatchObject({ pinned: [] })
  })
  it("a tree's audit covers exactly that tree, under exactly this rule", () => {
    const at = (tree: string) => ({ ...memoryRevision(escaping, 'audited'), tree: () => tree })
    const found = (census(at('t1'), root) as Census).escapes
    expect(found).toHaveLength(1)
    const record = { tree: 't1', ...ruleIdentity(), escapes: found.map(({ file, text, why }) => ({ file, text, why, safe: 'read along its flow' })), errors: [] }
    AUDITED.push(record)
    try {
      expect((census(at('t1'), root) as Census).broken).toBeNull()
      // Another tree, its downstream consumer changed, the exempt line itself the same: not covered.
      expect((census({ ...memoryRevision({ ...escaping, 'src/main/consumer.ts': 'export const c = 1\n' }, 'other'), tree: () => 't2' }, root) as Census).broken).toMatch(/use\.ts:2/)
      // The same tree under another rule or compiler: not covered either.
      AUDITED[AUDITED.length - 1] = { ...record, compiler: 'another' }
      expect((census(at('t1'), root) as Census).broken).toMatch(/use\.ts:2/)
    } finally {
      AUDITED.pop()
    }
  })
})

describe("the rule's inputs: a change to none of them can't change its result", () => {
  it('code, configs, dependencies and its own files are; docs and suites are not', () => {
    for (const f of ['src/main/x.ts', 'tests/x.test.ts', 'src/renderer/src/A.tsx', 'tsconfig.node.json', 'tsconfig.web.json', 'package.json', 'package-lock.json', 'tests/e2e/workspaceRule.mjs', 'tests/e2e/workspaceRuleCheck.mjs', 'tests/e2e/workspaceRule.audited.json', 'tests/e2e/affectedUnits.mjs']) expect(ruleInput(f), f).toBe(true)
    for (const f of ['docs/SPEC.md', 'CHANGELOG.md', 'tests/e2e/board.cjs', 'locales/de/main.json', 'scripts/release.mjs']) expect(ruleInput(f), f).toBe(false)
  })
})
