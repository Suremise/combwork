// Which e2e suites a change to a shared file needs by the parts of it that changed (HI-2659, tests/e2e/affectedUnits.mjs):
// each rule on small two-revision fixtures (a placer standing in for affected.mjs's areas), then the selections of
// three real changes, HI-2652, HI-2653 and HI-2654, from this repository's history (CI checks out all of it).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain .mjs modules without types
import { SPLIT, lineDiff, memoryRevision, unitSelection, unitsOf } from './e2e/affectedUnits.mjs'
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
const ipc = ({ one = '1', win = '1', access = "'Not allowed'", hold = '20', extra = '' } = {}): string => `import { workspace } from './workspace'
// The window's calls.
export function registerIpc(): void {
  const win = (): number => ${win}
  const impl = {
    'a:one': () => ${one},
    'a:two': () => win(),
    'x:set': (v: number) => workspace.setX(v)
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
const workspaceTs = ({ check = '1', y = 'this.getZ()', unused = '', spare = '' } = {}): string => `export class WorkspaceService {
  setX(v: number): number {
    return this.check(v)
  }
  private check(v: number): number {
    return v + ${check}
  }
  getY(): number {
    return ${y}
  }
  getZ(): number {
    return this.getY()
  }
  unused(): void {${unused}}
  private spare(): void {${spare}}
}
export const workspace = new WorkspaceService()
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
  'src/main/settingsTools.ts': "import { workspace } from './workspace'\nexport const set = () => workspace.setX(2)\n",
  'src/main/other.ts': "import { workspace } from './workspace'\nexport const z = () => workspace.getZ()\n",
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
    expect(ids(WS, workspaceTs())).toEqual(expect.arrayContaining(['WorkspaceService.setX', 'WorkspaceService.check', 'WorkspaceService.getY', 'workspace']))
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

  it('a private method: followed through the methods calling it, then an IPC handler calling that, to its callers', () => {
    expect(suitesOf(WS, repo(), repo({ [WS]: workspaceTs({ check: '2' }) }))).toEqual(['c', 'settings'])
  })

  it('methods calling each other end, with the callers outside', () => {
    expect(suitesOf(WS, repo(), repo({ [WS]: workspaceTs({ y: 'this.getZ() + 1' }) }))).toEqual(['other'])
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

  it("the dispatch's reviewed seam branches select the suites that set their seam", () => {
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ hold: '30' }) }))).toEqual(['holdsuite'])
    expect(suitesOf(IPC, repo(), repo({ [IPC]: ipc({ extra: "      if (take(failing, channel)) throw new Error('failed')\n" }) }))).toEqual(['failsuite'])
  })

  it('the seam tables: the suites naming a seam added or removed; reordered, none', () => {
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_A', 'CW_TEST_B', 'CW_TEST_C'") }))).toEqual(['csuite'])
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_B'") }))).toEqual(['asuite'])
    expect(suitesOf(RUNNER, repo(), repo({ [RUNNER]: runnerMjs("'CW_TEST_B', 'CW_TEST_A'") }))).toEqual([])
  })

  it('an unused private method selects nothing', () => {
    const r = select(WS, repo(), repo({ [WS]: workspaceTs({ spare: ' return' }) }))
    expect(r.all).toBeNull()
    expect(r.suites).toEqual([])
    expect(r.why.join('\n')).toMatch(/local, and nothing names it/)
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
    expect(allOf(WS, repo(), repo({ [WS]: workspaceTs({ unused: ' return' }) }))).toMatch(/nothing names WorkspaceService\.unused, though it is public/)
    expect(allOf(ACTIONS, repo(), repo({ [ACTIONS]: actionsTs({ exp: '3' }) }))).toMatch(/nothing names unusedExport/)
  })

  it('a namespace import indexed, or the module re-exported whole', () => {
    const indexed = { 'src/renderer/src/views/X.tsx': "import * as acts from '../actions'\nexport const go = (n: string) => (acts as Record<string, () => void>)[n]()\n" }
    expect(allOf(ACTIONS, repo(indexed), repo({ ...indexed, [ACTIONS]: actionsTs({ one: "'a:one' as const" }) }))).toMatch(/indexes its namespace import acts/)
    const all = { 'src/renderer/src/views/Y.ts': "export * from '../actions'\n" }
    expect(allOf(ACTIONS, repo(all), repo({ ...all, [ACTIONS]: actionsTs({ one: "'a:one' as const" }) }))).toMatch(/re-exports it all/)
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

describe('real changes: before every suite, now the suites their parts need (git history)', () => {
  const names = (SUITES as { name: string }[]).map((s) => s.name)
  const realNames = (SUITES as { name: string; needs?: string[] }[]).filter(isRealCli).map((s) => s.name)
  // Each card's merge into its branch: its changes are the merge's against its first parent.
  const changes = [
    { card: 'HI-2652', commit: 'dba04a0f7c73d8515ded18f5e0a59ec93c4b242b', needs: ['activityworkspace'] },
    { card: 'HI-2653', commit: '475897343681d7b3570ca04d5fdb97b6862aee42', needs: ['keysui', 'startbusy', 'agents-ui', 'keys'] },
    { card: 'HI-2654', commit: '22fd88db7a58f978d7059d3f21298d89a6fc2667', needs: ['advanced', 'assistantsettings', 'consoletext', 'p7settings'] }
  ]
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
