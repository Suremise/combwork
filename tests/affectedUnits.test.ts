// Which e2e suites a change to a shared file needs by the parts of it that changed (HI-2659, tests/e2e/affectedUnits.mjs):
// each rule on small two-revision fixtures (a placer standing in for affected.mjs's areas), then the selections of
// three real changes, HI-2652, HI-2653 and HI-2654, from this repository's history (CI checks out all of it).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SPLIT, lineDiff, memoryRevision, typeOnlyChange, unitSelection, unitsOf } from './e2e/affectedUnits.mjs'
// @ts-expect-error: plain .mjs modules without types
import { EVERYTHING, REAL_TIER, affectedSuites, splitSelections, under } from './e2e/affected.mjs'
// @ts-expect-error: plain .mjs modules without types
import { SUITES } from './e2e/suites.mjs'
// @ts-expect-error: plain .mjs modules without types
import { isRealCli } from './e2e/runner.mjs'
import { tempDir } from './tempDir'

const runContext = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const root = join(__dirname, '..')
type Selection = { all: string | null; suites: string[]; why: string[] }
type Files = Record<string, string>

// Where a file naming a changed unit is placed: as affected.mjs would, for these fixtures' files.
const PLACES: Record<string, { suites: string[] } | { all: string } | null> = {
  'src/renderer/src/views/A.tsx': { suites: ['a'] },
  'src/renderer/src/views/B.tsx': { suites: ['b'] },
  'src/renderer/src/views/C.tsx': { suites: ['c'] },
  'src/renderer/src/views/VA.tsx': { suites: ['va'] },
  'src/renderer/src/views/VB.tsx': { suites: ['vb'] },
  'src/renderer/src/views/VB3.tsx': { suites: ['vb3'] },
  'src/renderer/src/components/Side.tsx': { suites: ['side'] },
  'src/renderer/src/components/Other.tsx': { suites: ['oth'] },
  'src/main/settingsTools.ts': { suites: ['settings'] },
  'src/main/other.ts': { suites: ['other'] },
  'src/renderer/src/store.ts': { all: 'shared by every part of Combwork' },
  'tests/e2e/holdsuite.cjs': { suites: ['holdsuite'] },
  'tests/e2e/failsuite.cjs': { suites: ['failsuite'] },
  'tests/e2e/asuite.cjs': { suites: ['asuite'] },
  'tests/e2e/csuite.cjs': { suites: ['csuite'] },
  'tests/actions.test.ts': null
}
const place = (f: string) => (f in PLACES ? PLACES[f] : { all: 'which no area names' })

const select = (file: string, base: Files, head: Files): Selection => {
  const r = unitSelection({ file, base: memoryRevision(base, 'base'), head: memoryRevision(head, 'head'), lines: lineDiff(base[file] ?? '', head[file] ?? ''), place, areaSuites: () => [] }) as Selection
  return { ...r, suites: [...r.suites].sort() }
}
const suitesOf = (file: string, base: Files, head: Files): string[] => {
  const r = select(file, base, head)
  expect(r.all, r.all ?? '').toBeNull()
  return r.suites
}
const allOf = (file: string, base: Files, head: Files): string => {
  const r = select(file, base, head)
  expect(r.all, `expected every suite, got ${r.suites.join(', ')}`).toBeTruthy()
  return r.all!
}

// --- Fixtures: small versions of the SPLIT files and their callers.
const IPC = 'src/main/ipc.ts'
const ipc = ({ one = '1', win = '1', access = "'Not allowed'", hold = '20', extra = '' } = {}): string => `import { withX } from './workspace'
// The window's calls.
export function registerIpc(): void {
  const win = (): number => ${win}
  const impl = {
    'a:one': () => ${one},
    'a:two': () => win(),
    'x:set': (v: number) => withX(v)
  }
  type TestCalls = { from: string }
  const holding = (channel: string): boolean => !app.isPackaged && (process.env.CW_TEST_HOLD_IPC ?? '') === channel
  const hold = async (channel: string): Promise<void> => {
    while (holding(channel)) await new Promise((r) => setTimeout(r, ${hold}))
  }
  for (const [channel, fn] of Object.entries(impl)) {
    ipcMain.handle(channel, async (e: { sender: unknown }, ...args: unknown[]) => {
      if (!e.sender) throw new Error(${access})
${extra}      if (holding(channel)) await hold(channel)
      return (fn as (...a: unknown[]) => unknown)(...args)
    })
  }
}
`
const WS = 'src/main/workspace.ts'
// Its class's members and instance select every suite (HI-2659, C3); its top-level functions are traced.
const workspaceTs = ({ member = '1', check = '1', y = 'getZ()', unused = '', spare = '', spareExport = '' } = {}): string => `export class WorkspaceService {
  setX(v: number): number {
    return v + ${member}
  }
}
export const workspace = new WorkspaceService()
export function withX(v: number): number {
  return check(v)
}
function check(v: number): number {
  return v + ${check}
}
export function getY(): number {
  return ${y}
}
export function getZ(): number {
  return getY()
}
export function unused(): void {${unused}}
${spareExport}function spare(): void {${spare}}
`
const ACTIONS = 'src/renderer/src/actions.ts'
const actionsTs = ({ f1 = 'f1', one = "'a:one'", f2 = "  await call('a:two')", f3 = true, exp = '2', head = "import { call } from './api'" } = {}): string => `${head}
/** Does one thing. */
export async function ${f1}(): Promise<void> {
  await call(${one})
}
export async function f2(): Promise<void> {
${f2}
}
${f3 ? 'export async function f3(): Promise<void> {\n  await call(\'a:three\')\n}\n' : ''}export const unusedExport = (): number => ${exp}
`
const COMMANDS = 'src/renderer/src/commands.ts'
const commandsTs = (other = '1'): string => `import { f2 as second } from './actions'
const COMMAND_DEFS = [
  { id: 'p.second', run: () => second() },
  { id: 'p.other', run: () => ${other} }
]
export function runCommand(id: string): void {
  COMMAND_DEFS.find((c) => c.id === id)?.run()
}
`
const RUNNER = 'tests/e2e/runner.mjs'
const runnerMjs = (dev = "'CW_TEST_A', 'CW_TEST_B'"): string => `export const DEV_SEAMS = [${dev}]
export const PACKAGED_SEAMS = ['CW_TEST_P']
export function selectSuites() {
  return 1
}
`
const callers: Files = {
  'src/renderer/src/views/A.tsx': "import { call } from '../api'\nexport const A = () => call('a:one')\n",
  'src/renderer/src/views/B.tsx': "import { call } from '../api'\nexport const B = () => call('a:two')\n",
  'src/renderer/src/views/C.tsx': "import { call } from '../api'\nexport const C = () => call('x:set', 1)\n",
  'src/main/settingsTools.ts': "import { withX } from './workspace'\nexport const set = () => withX(2)\n",
  'src/main/other.ts': "import { getZ } from './workspace'\nexport const z = () => getZ()\n",
  'src/renderer/src/views/VA.tsx': "import * as actions from '../actions'\nexport const VA = () => <button onClick={actions.f1}>One</button>\n",
  'src/renderer/src/views/VB.tsx': "import { f2 } from '../actions'\nexport const handlers = { f2 }\n",
  'src/renderer/src/components/Side.tsx': "import { runCommand } from '../commands'\nexport const S = () => runCommand('p.second')\n",
  'src/renderer/src/components/Other.tsx': "import { runCommand } from '../commands'\nexport const O = () => runCommand('p.other')\n",
  'tests/e2e/holdsuite.cjs': "process.env.CW_TEST_HOLD_IPC = 'a:one'\n",
  'tests/e2e/failsuite.cjs': "const env = { CW_TEST_FAIL_IPC: 'a:two*1' }\n",
  'tests/e2e/asuite.cjs': "const env = { CW_TEST_A: '1' }\n",
  'tests/e2e/csuite.cjs': "const env = { CW_TEST_C: '1' }\n",
  'tests/actions.test.ts': "import { unusedExport } from '../src/renderer/src/actions'\n"
}
const repo = (over: Files = {}): Files => ({ ...callers, [IPC]: ipc(), [WS]: workspaceTs(), [ACTIONS]: actionsTs(), [COMMANDS]: commandsTs(), [RUNNER]: runnerMjs(), ...over })

describe('the units of a shared file', () => {
  it('are its IPC handlers, class methods, functions and commands one by one, not the object, class or array holding them', () => {
    const ids = (file: string, text: string): string[] => (unitsOf(text, file).units as { id: string }[]).map((u) => u.id)
    expect(ids(IPC, ipc())).toEqual(expect.arrayContaining(["'a:one'", "'a:two'", "'x:set'", 'registerIpc.win', 'registerIpc']))
    expect(ids(WS, workspaceTs())).toEqual(expect.arrayContaining(['WorkspaceService.setX', 'workspace', 'withX', 'check', 'getY']))
    expect(ids(ACTIONS, actionsTs())).toEqual(expect.arrayContaining(['f1', 'f2', 'f3', 'unusedExport']))
    expect(ids(COMMANDS, commandsTs())).toEqual(expect.arrayContaining(["command 'p.second'", "command 'p.other'", 'runCommand']))
    // The real files too: each handler, method and action its own unit.
    const read = (f: string): string => execFileSync('git', ['show', `HEAD:${f}`], { cwd: root, encoding: 'utf8', env: runContext.baseEnv() })
    const real = (f: string) => unitsOf(read(f), f).units as { id: string; kind: string; keyKind?: string }[]
    expect(real(IPC).filter((u) => u.keyKind === 'channel').length).toBeGreaterThan(400)
    expect(real('src/shared/api.ts').filter((u) => u.keyKind === 'channel').length).toBeGreaterThan(400)
    expect(real(WS).filter((u) => u.id.startsWith('WorkspaceService.')).length).toBeGreaterThan(50)
    expect(real(ACTIONS).map((u) => u.id)).toEqual(expect.arrayContaining(['createProject', 'openWorkspace']))
    expect(real(COMMANDS).map((u) => u.id)).toContain("command 'project.new'")
  })

  it('every SPLIT file is also in EVERYTHING (so a caller without its units selects every suite) and none in the real tier', () => {
    for (const s of SPLIT as { file: string }[]) {
      expect(under(s.file, EVERYTHING), s.file).toBe(true)
      expect(under(s.file, REAL_TIER), s.file).toBe(false)
    }
    const names = (SUITES as { name: string }[]).map((s) => s.name)
    expect(affectedSuites(['src/main/ipc.ts'], names).all).toBe(true)
  })
})

describe('a change to a shared file selects by the parts it changed', () => {
  it('an IPC handler: the files that call its channel, not the other channels', () => {
    // A suite holding the channel (CW_TEST_HOLD_IPC='a:one') names it too, and so does f1, an action calling it.
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ one: '2' }) }))).toEqual(['a', 'holdsuite', 'va'])
  })

  it("a helper of the dispatch: the handlers that use it, and their channels' callers", () => {
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ win: '2' }) }))).toEqual(['b', 'failsuite', 'side', 'vb'])
  })

  it("a channel's type in api.ts: its callers (the handler in ipc.ts, a registry, is no caller)", () => {
    const api = (t: string): string => `export interface CombworkRequests {\n  'a:one': () => void\n  'a:two': () => ${t}\n}\n`
    expect(suitesOf('src/shared/api.ts', repo({ 'src/shared/api.ts': api('number') }), repo({ 'src/shared/api.ts': api('string') }))).toEqual(['b', 'failsuite', 'side', 'vb'])
  })

  it('a local function: followed through the exported one calling it, then an IPC handler calling that, to its callers', () => {
    expect(suitesOf(WS, repo(), repo({ [WS]: workspaceTs({ check: '2' }) }))).toEqual(['c', 'settings'])
  })

  it('functions calling each other end, with the callers outside', () => {
    expect(suitesOf(WS, repo(), repo({ [WS]: workspaceTs({ y: 'getZ() + 1' }) }))).toEqual(['other'])
  })

  it('an action: what names it, a callback and a property shorthand included', () => {
    expect(suitesOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs({ one: "'a:one' as const" }) }))).toEqual(['va'])
    // f2 is imported by commands.ts as `second`: the command that runs it, and the file naming the command.
    expect(suitesOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs({ f2: "  await call('a:two', 1)" }) }))).toEqual(['side', 'vb'])
  })

  it('commands one by one: the files naming that id', () => {
    expect(suitesOf(COMMANDS, repo(), repo({ [COMMANDS]: commandsTs('2') }))).toEqual(['oth'])
  })

  it('a removed or renamed unit: followed by its name in both revisions', () => {
    const base = repo({ 'src/renderer/src/views/VB3.tsx': "import * as actions from '../actions'\nexport const go = () => actions.f3()\n" })
    expect(suitesOf(ACTIONS, base, repo({ [ACTIONS]: actionsTs({ f3: false }) }))).toEqual(['vb3'])
    const renamed = repo({ [ACTIONS]: actionsTs({ f1: 'f1b' }), 'src/renderer/src/views/VA.tsx': "import * as actions from '../actions'\nexport const VA = () => <button onClick={actions.f1b}>One</button>\n" })
    expect(suitesOf(ACTIONS, repo(), renamed)).toEqual(['va'])
  })

  it('a change of comments alone selects nothing; text in a template literal that looks like one is code', () => {
    expect(select(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs().replace('/** Does one thing. */', '/** Does one thing, said again. */') }))).toEqual({ all: null, suites: [], why: [] })
    const tpl = (c: string): string => actionsTs({ f2: `  await call('a:two', \`\n  // ${c}\n  \`)` })
    expect(suitesOf(ACTIONS, repo({ [ACTIONS]: tpl('one') }), repo({ [ACTIONS]: tpl('two') }))).toEqual(['side', 'vb'])
  })

  it('comment delimiters added or removed around unchanged code change what runs (HR3 on round 1)', () => {
    const plain = actionsTs({ f2: "  await call('a:two')\n  return" })
    const commented = actionsTs({ f2: "  await call('a:two')\n  /*\n  return\n  */" })
    // Added: f2 no longer returns early; removed: it does again. Both select f2's callers.
    expect(suitesOf(ACTIONS, repo({ [ACTIONS]: plain }), repo({ [ACTIONS]: commented }))).toEqual(['side', 'vb'])
    expect(suitesOf(ACTIONS, repo({ [ACTIONS]: commented }), repo({ [ACTIONS]: plain }))).toEqual(['side', 'vb'])
    // Around a whole function: the delimiters are in no unit (module code), so every suite.
    const gone = actionsTs().replace('export async function f2', '/*\nexport async function f2').replace('export async function f3', '*/\nexport async function f3')
    expect(allOf(ACTIONS, repo(), repo({ [ACTIONS]: gone }))).toMatch(/in no function, method or entry/)
  })

  it("the dispatch's reviewed seam branches select the suites that set their seam", () => {
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ hold: '30' }) }))).toEqual(['holdsuite'])
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ extra: "      if (take(failing, channel)) throw new Error('failed')\n" }) }))).toEqual(['failsuite'])
  })

  it('the seam tables: the suites naming a seam added or removed; reordered, none', () => {
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_A', 'CW_TEST_B', 'CW_TEST_C'") }))).toEqual(['csuite'])
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_B'") }))).toEqual(['asuite'])
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_B', 'CW_TEST_A'") }))).toEqual([])
  })

  it('an unused local function selects nothing', () => {
    const r = select(WS, repo(), repo({ [WS]: workspaceTs({ spare: ' return' }) }))
    expect(r.all).toBeNull()
    expect(r.suites).toEqual([])
    expect(r.why.join('\n')).toMatch(/local, and nothing that runs it names it/)
  })
})

describe('whatever it cannot follow selects every suite, saying why', () => {
  it("the dispatch outside its seam branches (its access check)", () => {
    expect(allOf(IPC, repo(), repo({ [IPC]: ipc({ access: "'No'" }) }))).toMatch(/dispatch outside its reviewed test-seam branches/)
  })

  it('a seam table that is not a list of names', () => {
    expect(allOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("...OTHER, 'CW_TEST_B'") }))).toMatch(/isn't a list of seam names/)
  })

  it('a line in no unit: an import, module code', () => {
    expect(allOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs({ head: "import { call } from './api'\nimport { x } from './x'" }) }))).toMatch(/in no function, method or entry/)
  })

  it('a file that names the unit and is shared by everything (store.ts), or in no area', () => {
    expect(allOf(IPC, repo({ 'src/renderer/src/store.ts': "export const s = () => call('a:one')\n" }), repo({ [IPC]: ipc({ one: '2' }), 'src/renderer/src/store.ts': "export const s = () => call('a:one')\n" }))).toMatch(/store\.ts, shared by every part/)
    expect(allOf(IPC, repo(), repo({ [IPC]: ipc({ one: '2' }), 'src/renderer/src/Unplaced.tsx': "call('a:one')\n" }))).toMatch(/Unplaced\.tsx, which no area names/)
  })

  it('a public unit nothing in its scope names (it may be reached some other way, or by unit tests alone)', () => {
    expect(allOf(WS, repo(), repo({ [WS]: workspaceTs({ unused: ' return' }) }))).toMatch(/nothing that runs unused was found, though it is public/)
    expect(allOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs({ exp: '3' }) }))).toMatch(/nothing that runs unusedExport was found/)
  })

  it('public units that only name each other (a cycle, no caller outside it) reach nothing that runs them (HR3 on round 1)', () => {
    const cyc = (n: string): string => `export function foo(): number {\n  return bar() + ${n}\n}\nexport function bar(): number {\n  return foo()\n}\n`
    expect(allOf(ACTIONS, repo({ [ACTIONS]: actionsTs() + cyc('1') }), repo({ [ACTIONS]: actionsTs() + cyc('2') }))).toMatch(/nothing that runs foo was found, though it is public/)
  })

  it("a unit's visibility changed: public in either revision counts (local → exported, and back)", () => {
    const caller = { 'src/renderer/src/views/VA.tsx': "import { foo } from '../actions'\nexport const VA = () => foo()\n" }
    const fn = (exp: string, n: string): string => `${exp}function foo(): number {\n  return ${n}\n}\n`
    expect(suitesOf(ACTIONS, repo({ ...caller, [ACTIONS]: fn('', '1') }), repo({ ...caller, [ACTIONS]: fn('export ', '2') }))).toEqual(['va'])
    expect(suitesOf(ACTIONS, repo({ ...caller, [ACTIONS]: fn('export ', '1') }), repo({ ...caller, [ACTIONS]: fn('', '2') }))).toEqual(['va'])
    const other = { 'src/main/other.ts': "import { spare } from './workspace'\nexport const z = () => spare()\n" }
    expect(suitesOf(WS, repo({ ...other, [WS]: workspaceTs() }), repo({ ...other, [WS]: workspaceTs({ spareExport: 'export ' }) }))).toEqual(['other'])
  })

  it("WorkspaceService's members and its instance select every suite: its instances flow where the tracer can't follow (C3)", () => {
    expect(allOf(WS, repo(), repo({ [WS]: workspaceTs({ member: '2' }) }))).toMatch(/WorkspaceService\.setX: WorkspaceService's instances flow where the tracer can't follow them/)
    // Whatever reaches them, a literal bracket access or an instance of an imported class among them.
    for (const text of ["import { workspace } from './workspace'\nexport const b = () => workspace['setX'](1)\n", "import { WorkspaceService } from './workspace'\nexport const b = (name: 'setX') => new WorkspaceService()[name](1)\n"]) {
      const dyn = { 'src/main/other.ts': text, 'src/main/settingsTools.ts': "import { workspace } from './workspace'\nexport const set = () => workspace.setX(2)\n" }
      expect(allOf(WS, repo(dyn), repo({ ...dyn, [WS]: workspaceTs({ member: '2' }) }))).toMatch(/WorkspaceService's instances/)
    }
  })

  it('a namespace import indexed, or the module re-exported whole', () => {
    const indexed = { 'src/renderer/src/views/X.tsx': "import * as acts from '../actions'\nexport const go = (n: string) => (acts as Record<string, () => void>)[n]()\n" }
    expect(allOf(ACTIONS, repo(indexed), repo({ ...indexed, [ACTIONS]: actionsTs({ one: "'a:one' as const" }) }))).toMatch(/uses acts \(line 2\) as a computed key/)
    const all = { 'src/renderer/src/views/Y.ts': "export * from '../actions'\n" }
    expect(allOf(ACTIONS, repo(all), repo({ ...all, [ACTIONS]: actionsTs({ one: "'a:one' as const" }) }))).toMatch(/re-exports it all/)
  })

  // What a file does with the module's values (HR3 on rounds 1 and 2, design s42/s46), each beside a caller that names
  // the changed action statically (VB.tsx's f2), so the "nothing names it" fallback can't be what catches it.
  const f2Changed = { [ACTIONS]: actionsTs({ f2: "  await call('a:two', 1)" }) }
  const using = (text: string): Selection => select(ACTIONS, repo({ 'src/renderer/src/views/X.tsx': text }), repo({ 'src/renderer/src/views/X.tsx': text, ...f2Changed }))

  it('a literal bracket access names the unit: a reference, its file placed (A)', () => {
    PLACES['src/renderer/src/views/X.tsx'] = { suites: ['x'] }
    try {
      expect(using("import * as actions from '../actions'\nexport const go = () => actions['f2']()\n").suites).toEqual(['side', 'vb', 'x'])
    } finally {
      delete PLACES['src/renderer/src/views/X.tsx']
    }
  })

  it('any use of the module outside the safe list selects every suite, whatever its form (round 3: safe by construction)', () => {
    const cases: [string, RegExp][] = [
      ["import * as actions from '../actions'\nexport const go = (k: string) => (actions as Record<string, () => void>)[k]()\n", /uses actions \(line 2\) as a computed key/],
      ["import * as actions from '../actions'\nexport const keys = () => Object.keys(actions)\n", /uses actions \(line 2\) as an argument to Object\.keys/],
      ["import * as actions from '../actions'\nexport const all = () => ({ ...actions })\n", /uses actions \(line 2\) as a SpreadElement/],
      ["import * as actions from '../actions'\nimport { foreignLookup } from './lookup'\nexport const go = (k: string) => foreignLookup(actions)[k]()\n", /uses actions \(line 3\) as an argument to foreignLookup/],
      ["import * as actions from '../actions'\nexport const box = { actions }\n", /uses actions \(line 2\) as a ObjectProperty/],
      // An alias, however long its chain or wherever its assignments go round: not followed, so every suite.
      ["import * as actions from '../actions'\nlet a: unknown = {}\na = actions\nexport const go = (k: string) => (a as Record<string, () => void>)[k]()\n", /uses actions \(line 3\) as a AssignmentExpression/],
      [`import * as actions from '../actions'\n${['actions', ...Array.from({ length: 10 }, (_, i) => `a${i}`)].slice(1).map((n, i, all) => `const ${n} = ${i ? all[i - 1] : 'actions'}`).join('\n')}\nexport const go = (k: string) => (a9 as Record<string, () => void>)[k]()\n`, /uses actions \(line 2\) as a VariableDeclarator/],
      ["import * as actions from '../actions'\nlet a: unknown = actions\nlet b: unknown = a\na = b\nb = a\nexport const go = (k: string) => (a as Record<string, () => void>)[k]()\n", /uses actions \(line 2\) as a VariableDeclarator/],
      // HR3's round-3 probes: a computed destructuring of the namespace, and a tagged template handing it to a function.
      ["import * as actions from '../actions'\nexport function run(key: string) {\n  const { [key]: f } = actions as Record<string, () => void>\n  return f()\n}\n", /uses actions \(line 3\) as a VariableDeclarator/],
      ["import * as actions from '../actions'\nimport { forward } from './other'\nexport const go = (key: string) => forward`${actions}`[key]()\n", /uses actions \(line 3\) as a TemplateLiteral/],
      // HR3's round-4 probe: a parameter property's initializer is a value, though a TypeScript node holds it.
      ["import * as actions from '../actions'\nexport class Runner {\n  constructor(private api = actions) {}\n  run(key: keyof typeof actions) {\n    return this.api[key]()\n  }\n}\n", /uses actions \(line 3\) as a AssignmentPattern/]
    ]
    for (const [text, why] of cases) expect(using(text).all, text).toMatch(why)
  })

  it('the safe uses: another unit by name, the unit called or read by name, a function handed off by its name, a type', () => {
    PLACES['src/renderer/src/views/X.tsx'] = { suites: ['x'] }
    try {
      for (const text of [
        "import * as actions from '../actions'\nexport const a = () => actions.f1()\nexport const b = () => actions.f2()\n",
        "import * as actions from '../actions'\nexport const cb = [actions.f2, actions.f1]\nexport type T = typeof actions\nexport const k = (key: keyof typeof actions, t: actions.Thing) => [key, t]\n",
        "import { f2 } from '../actions'\nexport const later = () => setTimeout(f2)\n",
        "import * as actions from '../actions'\nexport const n = () => actions['f1']()\n"
      ]) expect(using(text).all, text).toBeNull()
    } finally {
      delete PLACES['src/renderer/src/views/X.tsx']
    }
    // A unit that isn't a function: called or read by name, safe; passed on, not.
    const holder = (use: string): Files => ({ [ACTIONS]: actionsTs() + 'export const TABLE = { a: 1 }\n', 'src/renderer/src/views/X.tsx': `import * as actions from '../actions'\n${use}\n` })
    const tableChange = (use: string): Selection => select(ACTIONS, repo(holder(use)), repo({ ...holder(use), [ACTIONS]: actionsTs() + 'export const TABLE = { a: 2 }\n' }))
    PLACES['src/renderer/src/views/X.tsx'] = { suites: ['x'] }
    try {
      expect(tableChange('export const v = () => actions.TABLE.a').suites).toEqual(['x'])
      expect(tableChange('export const v = () => JSON.stringify(actions.TABLE)').all).toMatch(/uses actions\.TABLE \(line 2\) as an argument to JSON\.stringify/)
    } finally {
      delete PLACES['src/renderer/src/views/X.tsx']
    }
  })

  it('a value not from the module is no fallback: a local record, a cycle of locals, a parameter, a counter', () => {
    for (const text of [
      "import * as actions from '../actions'\nexport const a = () => actions.f2()\nexport const b = (k: string) => {\n  const o: Record<string, number> = {}\n  return o[k]\n}\n",
      "import * as actions from '../actions'\nexport const a = () => actions.f2()\nexport const b = (k: string) => {\n  let x: Record<string, number> = {}\n  let y = x\n  x = y\n  return x[k]\n}\n",
      "import * as actions from '../actions'\nexport const a = () => actions.f2()\nexport const b = (o: Record<string, number>, k: string) => o[k]\n",
      // A number made from a counter, handed on: its `++` makes a number, not the module.
      "import * as actions from '../actions'\nexport const a = () => {\n  let n = 1\n  n++\n  return String(n) + actions.f2.name\n}\n"
    ]) {
      PLACES['src/renderer/src/views/X.tsx'] = { suites: ['x'] }
      try {
        expect(using(text).all, text).toBeNull()
      } finally {
        delete PLACES['src/renderer/src/views/X.tsx']
      }
    }
  })

  it('a channel built at run time', () => {
    const dyn = { 'src/renderer/src/views/D.tsx': "import { call } from '../api'\nexport const d = (x: string) => call(`a:${x}`)\n" }
    expect(allOf(IPC, repo(dyn), repo({ ...dyn, [IPC]: ipc({ one: '2' }) }))).toMatch(/builds a channel starting a: at run time/)
  })

  it("a file that doesn't parse, or isn't there in one revision", () => {
    expect(allOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs() + 'export function (\n' }))).toMatch(/doesn't parse in head/)
    const gone = repo()
    delete gone[ACTIONS]
    expect(allOf(ACTIONS, repo(), gone)).toMatch(/added, deleted or unreadable in head/)
  })
})

describe('a change of types only selects nothing, proved node by node (HI-2690, D1)', () => {
  const typeOnly = (file: string, base: string, head: string, more: Files = {}): string | null =>
    typeOnlyChange({ file, base: memoryRevision({ ...more, [file]: base }, 'base'), head: memoryRevision({ ...more, [file]: head }, 'head'), lines: lineDiff(base, head) }) as string | null
  const T = 'export interface A {\n  a: string\n}\nexport type B = number\nexport const c = 1\n'
  it('an interface, a type alias, a type-only import or export, a declared value with none: no suite, saying why', () => {
    expect(typeOnly('src/shared/x.ts', T, T.replace('a: string', 'a: number'))).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', T, T.replace('= number', '= string'))).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', `import type { Y } from './y'\n${T}`, `import type { Y, Z } from './y'\n${T}`)).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', `${T}export type { A as AA }\n`, `${T}export type { A as AA, B as BB }\n`)).toMatch(/types only/)
    expect(typeOnly('src/main/raw.d.ts', 'declare const x: number\n', 'declare const x: string\n')).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', T, T.replace('export interface A', '/** A thing. */\nexport interface A'))).toMatch(/comments only/)
  })
  it("an overload's signature is erased, its implementation isn't", () => {
    const f = 'export function f(a: string): void\nexport function f(a: number): void\nexport function f(a: unknown): void {\n  void a\n}\n'
    expect(typeOnly('src/shared/x.ts', f, f.replace('f(a: string): void', 'f(a: boolean): void'))).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', f, f.replace('void a', 'void [a]'))).toBeNull()
  })
  it('an enum of any kind is not: a const enum in a .d.ts, an ambient one, one in a declare block', () => {
    expect(typeOnly('src/shared/e.d.ts', 'export declare const enum E {\n  A = 1\n}\n', 'export declare const enum E {\n  A = 2\n}\n')).toBeNull()
    expect(typeOnly('src/shared/x.ts', 'export enum E {\n  A = 1\n}\n', 'export enum E {\n  A = 2\n}\n')).toBeNull()
    const g = (body: string) => `export {}\ndeclare global {\n${body}\n}\n`
    expect(typeOnly('src/shared/x.ts', g('  interface W {\n    a: string\n  }'), g('  interface W {\n    a: number\n  }'))).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', g('  const enum K {\n    A = 1\n  }'), g('  const enum K {\n    A = 2\n  }'))).toBeNull()
    const ns = (v: string) => `declare namespace N {\n  namespace M {\n    interface I {\n      a: ${v}\n    }\n  }\n}\n`
    expect(typeOnly('src/shared/x.ts', ns('string'), ns('number'))).toMatch(/types only/)
    expect(typeOnly('src/shared/x.ts', 'namespace N {\n  export const a = 1\n}\n', 'namespace N {\n  export const a = 2\n}\n')).toBeNull()
  })
  it('a value, a mixed line, a class field, a parse error, an added file: as usual', () => {
    expect(typeOnly('src/shared/x.ts', T, T.replace('c = 1', 'c = 2'))).toBeNull()
    expect(typeOnly('src/shared/x.ts', 'export type T = number; export const v = 1\n', 'export type T = string; export const v = 1\n')).toBeNull()
    expect(typeOnly('src/shared/x.ts', 'export class C {\n  a: string = ""\n}\n', 'export class C {\n  a: number | string = ""\n}\n')).toBeNull()
    expect(typeOnly('src/shared/x.ts', T, `${T}export interface (\n`)).toBeNull()
    expect(typeOnlyChange({ file: 'src/shared/x.ts', base: memoryRevision({}, 'base'), head: memoryRevision({ 'src/shared/x.ts': T }, 'head'), lines: lineDiff('', T) })).toBeNull()
  })
  it('a file read as source data keeps its selection: named in a suite, a scenario or a script', () => {
    const reader = { 'tests/e2e/tipwindows.cjs': "const src = fs.readFileSync(path.join(lib.ROOT, 'src', 'shared', 'tips.ts'), 'utf8')\n" }
    expect(typeOnly('src/shared/tips.ts', T, T.replace('a: string', 'a: number'), reader)).toBeNull()
    // Selection's own tooling names files only to select them.
    expect(typeOnly('src/shared/tips.ts', T, T.replace('a: string', 'a: number'), { 'tests/e2e/affected.mjs': "'src/shared/tips.ts'\n" })).toMatch(/types only/)
  })
})

describe('real changes: before every suite, now the suites their parts need (git history)', () => {
  // HI-2690 (the RC4 rounds, HI-2661's table): the suite counts stay (each still has a shared file's every-suite
  // reason), but the reasons D1 and D3 cleared are gone: RC4 3's types.ts, values/*.d.ts and tests/sandbox files.
  it('RC4 and HI-2654: every suite still, by the reasons left (App.tsx, servers.ts, workspace.ts members)', () => {
    const names = SUITES.map((s: { name: string }) => s.name)
    const real = SUITES.filter(isRealCli).map((s: { name: string }) => s.name)
    const ranges: [string, string, string, string[]][] = [
      ['RC4 1', 'dc539d923', '893a666a5', ['src/renderer/src/App.tsx']],
      ['RC4 2', '893a666a5', 'ee2d45a66', ['src/main/servers.ts']],
      ['RC4 3', 'ee2d45a66', 'a7a7816df', ['src/main/workspace.ts']],
      ['RC4 4', 'a7a7816df', 'ac8e5773a', ['src/main/workspace.ts']]
    ]
    for (const [label, base, head, left] of ranges) {
      const files = execFileSync('git', ['diff', '--name-only', '--no-renames', base, head], { cwd: root, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)
      const units = splitSelections(files, { cwd: root, base, head, suiteNames: names })
      expect(affectedSuites(files, names, real, units).all, label).toBe(true)
      expect(files.filter((f: string) => affectedSuites([f], names, real, units).all), label).toEqual(left)
      if (label === 'RC4 3') {
        for (const f of ['src/shared/types.ts', 'src/shared/i18n/values/main.d.ts']) expect(units[f]?.typeOnly, f).toBeTruthy()
        expect(affectedSuites(files.filter((f: string) => f.startsWith('tests/sandbox/')), names, real, units).suites).toEqual([])
      }
    }
  }, 120_000)

  const names = (SUITES as { name: string }[]).map((s) => s.name)
  const realNames = (SUITES as { name: string; needs?: string[] }[]).filter(isRealCli).map((s) => s.name)
  // Each card's merge into its branch: its changes are the merge's against its first parent.
  const changes = [
    { card: 'HI-2652', commit: 'dba04a0f7c73d8515ded18f5e0a59ec93c4b242b', needs: ['activityworkspace'] },
    { card: 'HI-2653', commit: '475897343681d7b3570ca04d5fdb97b6862aee42', needs: ['keysui', 'startbusy', 'agents-ui', 'keys'] },
  ]
  // HI-2654 changed WorkspaceService.setAdvanced: a member, so still every suite (C3), saying why.
  it('HI-2654: still every suite, its change being a WorkspaceService member', () => {
    const commit = '22fd88db7a58f978d7059d3f21298d89a6fc2667'
    const files = execFileSync('git', ['diff', '--name-only', `${commit}^1`, commit], { cwd: root, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)
    const after = affectedSuites(files, names, realNames, splitSelections(files, { cwd: root, base: `${commit}^1`, head: commit, suiteNames: names }))
    expect(after.all).toBe(true)
    expect(after.why[0]).toMatch(/WorkspaceService\.setAdvanced: WorkspaceService's instances flow where the tracer can't follow them/)
  })
  for (const c of changes) {
    it(`${c.card}: a named handful, with ${c.needs.join(', ')}`, () => {
      const base = `${c.commit}^1`
      const files = execFileSync('git', ['diff', '--name-only', base, c.commit], { cwd: root, encoding: 'utf8', env: runContext.baseEnv() }).split(/\r?\n/).filter(Boolean)
      expect(affectedSuites(files, names, realNames).all).toBe(true)
      const units = splitSelections(files, { cwd: root, base, head: c.commit, suiteNames: names })
      const after = affectedSuites(files, names, realNames, units)
      expect(after.all, after.why?.[0]).toBeFalsy()
      expect(after.suites).toEqual(expect.arrayContaining(c.needs))
      expect(after.suites.length).toBeLessThan(names.length / 5)
    })
  }
})

describe('the working tree against a commit (what --affected and the picker read)', () => {
  it('reads uncommitted and untracked files, and places what names a changed unit by the real areas', () => {
    const dir = tempDir('cw-affected-units-')
    const git = (...args: string[]): string => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, env: runContext.baseEnv(), encoding: 'utf8' })
    const write = (f: string, text: string): void => {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      writeFileSync(join(dir, f), text)
    }
    git('init', '-q', '-b', 'main')
    write(ACTIONS, actionsTs())
    write('src/renderer/src/views/ProjectView.tsx', "import * as actions from '../actions'\nexport const P = () => actions.f1()\n")
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    write(ACTIONS, actionsTs({ one: "'a:one' as const" }))
    const names = (SUITES as { name: string }[]).map((s) => s.name)
    const units = splitSelections([ACTIONS], { cwd: dir, base: 'HEAD', head: null, suiteNames: names }) as Record<string, Selection>
    expect(units[ACTIONS].all).toBeNull()
    // ProjectView.tsx's area, and actions.ts's own (startbusy).
    expect(units[ACTIONS].suites).toEqual(expect.arrayContaining(['agents-ui', 'startbusy']))
    // An untracked caller in no area: every suite.
    write('src/renderer/src/views/Untracked.tsx', "import * as actions from '../actions'\nexport const U = () => actions.f1()\n")
    expect((splitSelections([ACTIONS], { cwd: dir, base: 'HEAD', head: null, suiteNames: names }) as Record<string, Selection>)[ACTIONS].all).toMatch(/Untracked\.tsx, which no area names/)
  })
})
