// The Git/None cutover audit's import rule (SPEC §16.3.6, HI-2792's R9; npm run check:repo): every import of a Git
// module from outside Git's implementation is a classified edge in tests/gitAudit.mjs, taking only the names it lists,
// and every "platform with lines" seam is counted per caller. A new edge, a new name across a constrained one, a new seam
// call in a listed file, or a listed edge that is gone fails here, naming it; so does a switch on a platform's id
// (`platform === 'git'`) outside the descriptors, adapters and registry that SWITCHES doesn't justify (HI-2822), and an
// import of a platform's folder (src/main/platform/<vc>/) from outside it that isn't a registry's (HI-3489).
// scripts/gitInventory.mjs prints the audit.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error: a plain .mjs module without types, shared with scripts/gitInventory.mjs
import { audit, EDGES, modeDeclarations, NOT_PLATFORM, platformFolders, platformIdsIn, REGISTRIES, sealBreaks, SEAMS, sources, SWITCHES } from './gitAudit.mjs'
import { timing } from './timing.cjs'

// A bound for a hung test (HI-3349): each audit reads the whole source tree, and a full unit run on a loaded machine
// took one 14.5 s of Vitest's 20 s default.
vi.setConfig({ testTimeout: timing('test.hang') })

type Edge = { file: string; module: string; class: string; names?: string[]; op?: string; card?: string; why: string }
type Audit = { found: unknown[]; unlisted: string[]; stale: string[]; extraNames: string[]; seams: string[]; switches: string[]; sealed: string[] }
const root = join(__dirname, '..')
const run = (over: Record<string, string> = {}): Audit => audit(root, over)
const text = (file: string): string => readFileSync(join(root, file), 'utf8')

describe('the Git/None cutover audit', () => {
  it('classifies every Git import outside Git\'s implementation, and counts every seam', () => {
    const a = run()
    expect({ unlisted: a.unlisted, stale: a.stale, extraNames: a.extraNames, seams: a.seams, switches: a.switches, sealed: a.sealed }).toEqual({ unlisted: [], stale: [], extraNames: [], seams: [], switches: [], sealed: [] })
  })

  // HI-3489: each version control's folder (src/main/platform/<vc>/) is imported only from inside it and by the registries.
  it("seals each platform's folder: only the registries import it from outside, and tests aren't read", () => {
    const sealed = (over: Record<string, string>): string[] => sealBreaks(root, over)
    expect(platformFolders(root)).toEqual(['git', 'none'])
    expect(REGISTRIES).toContain('src/main/platform/adapters')
    const sessions = 'src/main/sessions.ts'
    // An outside file, however it imports: a named import, a type, a re-export, a dynamic import, a require.
    for (const line of ["import { NoneAdapter } from './platform/none/none'", "import type { NoneAdapter } from './platform/none/none'", "export { NoneAdapter } from './platform/none/none'", "const n = () => import('./platform/none/none')", "const n = require('./platform/none/none')", "type N = import('./platform/none/none').NoneAdapter", 'import "./platform/none/none.ts"'])
      expect(sealed({ [sessions]: `${line}\n${text(sessions)}` }), line).toEqual(['src/main/sessions -> src/main/platform/none/none'])
    expect(sealed({ [sessions]: `import { gitHistory } from './platform/git/gitHistory'\n${text(sessions)}` })).toEqual(['src/main/sessions -> src/main/platform/git/gitHistory'])
    // A computed specifier outside the folders could load one.
    expect(sealed({ [sessions]: `${text(sessions)}\nconst m = './platform/no' + 'ne/none'\nconst later = () => import(m)\n` })).toEqual(['src/main/sessions -> (computed specifier)'])
    // The seam beside the folders is outside them too, and so is another platform's folder.
    const seam = 'src/main/platform/workspacePort.ts'
    expect(sealed({ [seam]: `import { NonePlatform } from './none/nonePlatform'\n${text(seam)}` })).toEqual(['src/main/platform/workspacePort -> src/main/platform/none/nonePlatform'])
    const gitFile = 'src/main/platform/git/gitPlatform.ts'
    const nonePlatformFile = 'src/main/platform/none/nonePlatform.ts'
    expect(sealed({ [gitFile]: `import { NoneAdapter } from '../none/none'\n${text(gitFile)}` })).toEqual(['src/main/platform/git/gitPlatform -> src/main/platform/none/none'])
    // A computed specifier inside a platform's folder can't be proved to stay there (HI-3489 round 1: one in git/ loading
    // ../none/none, spelled by char codes, went unseen).
    const charCodes = 'const target = String.fromCharCode(46,46,47,110,111,110,101,47,110,111,110,101)\nvoid import(target)\n'
    expect(sealed({ [gitFile]: `${text(gitFile)}\n${charCodes}` })).toEqual(['src/main/platform/git/gitPlatform -> (computed specifier)'])
    expect(sealed({ [nonePlatformFile]: `${text(nonePlatformFile)}\nconst m = './no' + 'ne'\nconst later = () => require(m)\n` })).toEqual(['src/main/platform/none/nonePlatform -> (computed specifier)'])
    // A registry may: the adapters' map names every platform's adapter. A folder's own files import each other.
    const adapters = 'src/main/platform/adapters.ts'
    expect(sealed({ [adapters]: `import { NoneAdapter } from './none/none'\n${text(adapters)}` })).toEqual([])
    const nonePlatform = 'src/main/platform/none/nonePlatform.ts'
    expect(sealed({ [nonePlatform]: `import { NONE_MAX_FILES } from './none'\n${text(nonePlatform)}` })).toEqual([])
    // A test imports a platform's files directly: not read.
    expect(sealed({ 'tests/sealProbe.test.ts': "import { NoneAdapter } from '../src/main/platform/none/none'\n" })).toEqual([])
    // A new platform's folder is sealed as soon as it is there.
    expect(sealed({ 'src/main/platform/hg/hgPlatform.ts': 'export const hg = 1\n', [sessions]: `import { hg } from './platform/hg/hgPlatform'\n${text(sessions)}` })).toEqual(['src/main/sessions -> src/main/platform/hg/hgPlatform'])
    // And the audit reports it.
    expect(run({ [sessions]: `import { NoneAdapter } from './platform/none/none'\n${text(sessions)}` }).sealed).toEqual(['src/main/sessions -> src/main/platform/none/none'])
  })

  // HI-3506: the prefilter passed a computed specifier that starts with a literal, so its file was never parsed. The probe
  // is a new file naming neither folder as a word (`/git`, `/none`), as such a line passes wherever that holds.
  it('fails a computed specifier that starts with a string literal, wherever it is', () => {
    const probe = 'src/main/sealProbe.ts'
    const sealed = (body: string): string[] => sealBreaks(root, { [probe]: body })
    const computed = {
      'a literal and a variable': "export const f = (id: string) => import('./platform/' + id + '/nonePlatform')\n",
      'a template with a substitution': 'export const f = (d: string) => require(`./platform/${d}/gitPlatform`)\n',
      'joined pieces': "export const f = () => require('./platform/' + ['no', 'ne'].join('') + '/noneBaseline')\n",
      'a space before the parenthesis': "export const f = (id: string) => import ('./platform/' + id)\n"
    }
    for (const [form, body] of Object.entries(computed)) {
      expect(sealed(body), form).toEqual(['src/main/sealProbe -> (computed specifier)'])
      // The Git audit's prefilter had the same hole for import().
      expect(run({ [probe]: body }).unlisted, form).toEqual(['src/main/sealProbe -> (computed specifier)'])
    }
    // A whole literal, with options or without, a plain template among them, is read as the module it names.
    for (const body of ["export const f = () => import('./sessions')\n", 'export const f = () => import("./sessions", { with: {} })\n', 'export const f = () => require(`./sessions`)\n'])
      expect(sealed(body), body).toEqual([])
  })

  // HI-3512: only `import(…)` and a call of `require` itself were read as loaders, so `require` under another name,
  // `module.require` and `createRequire` loaded a platform's file (or a Git module) unseen.
  it('fails require handed on, module.require and createRequire, wherever they are', () => {
    const probe = 'src/main/sealProbe.ts'
    const loaders = (spec: string): Record<string, string> => ({
      'require handed on': `const r = require\nexport const f = () => r('${spec}')\n`,
      'require in an object': `const o = { require }\nexport const f = () => o.require('${spec}')\n`,
      'module.require': `export const f = () => module.require('${spec}')\n`,
      "module['require']": `export const f = () => module['require']('${spec}')\n`,
      'createRequire called at once': `import { createRequire } from 'node:module'\nexport const f = () => createRequire(import.meta.url)('${spec}')\n`,
      'createRequire kept under another name': `import { createRequire as cr } from 'module'\nconst load = cr(import.meta.url)\nexport const f = () => load('${spec}')\n`,
      'createRequire through a namespace': `import * as m from 'node:module'\nexport const f = () => m.createRequire(import.meta.url)('${spec}')\n`
    })
    for (const [form, body] of Object.entries(loaders('./platform/none/none'))) expect(sealBreaks(root, { [probe]: body }), form).toEqual(['src/main/sealProbe -> (computed specifier)'])
    // The Git audit can't see the module either: the loader is its unlisted edge.
    for (const [form, body] of Object.entries(loaders('./git'))) expect(run({ [probe]: body }).unlisted, form).toEqual(['src/main/sealProbe -> (computed specifier)'])
    // A name that only looks like one loads nothing: typeof, a key, a member named so, a direct literal require.
    for (const body of ["export const has = typeof require === 'function'\n", 'export const o = { require: 1 }\nexport type T = { require: number }\n', "export const s = require('./sessions')\n"])
      expect(sealBreaks(root, { [probe]: body }), body).toEqual([])
    // A registry's exported ImportEquals passes the platform's file on, as a re-export does.
    const adapters = 'src/main/platform/adapters.ts'
    expect(sealBreaks(root, { [adapters]: `export import NoneMod = require('./none/none')\n${text(adapters)}` })).toEqual(['src/main/platform/adapters -> src/main/platform/none/none (re-exported)'])
    expect(sealBreaks(root, { [adapters]: `import NoneMod = require('./none/none')\n${text(adapters)}` })).toEqual([])
  })

  // HI-3521: a registry's export of a load wasn't a re-export, and only a literal 'require' member was read.
  it("fails a registry exporting what it loads, and a member of module by a built name", () => {
    const adapters = 'src/main/platform/adapters.ts'
    const passedOn = ['src/main/platform/adapters -> src/main/platform/none/none (re-exported)']
    // `export =` and `export default` each stand alone (a file holds one), so each replaces the registry's text.
    for (const body of ["export = require('./none/none')\n", "export default require('./none/none')\n", "export default (await import('./none/none'))\n"]) expect(sealBreaks(root, { [adapters]: body }), body).toEqual(passedOn)
    for (const line of ["export const none = require('./none/none')", "export const { NoneAdapter } = await import('./none/none')", "export const none = require('./none/none') as unknown"])
      expect(sealBreaks(root, { [adapters]: `${line}\n${text(adapters)}` }), line).toEqual(passedOn)
    // Loading it unexported is a registry's to do.
    expect(sealBreaks(root, { [adapters]: `const none = require('./none/none')\n${text(adapters)}` })).toEqual([])
    // A member of module by a built name could be require: outside the folders, and in a registry.
    const probe = 'src/main/sealProbe.ts'
    const built = (spec: string): string => `const k = 'req' + 'uire'\nexport const f = () => module[k]('${spec}')\nexport const g = () => module['req' + 'uire']\n`
    expect(sealBreaks(root, { [probe]: built('./platform/none/none') })).toEqual(['src/main/sealProbe -> (computed specifier)'])
    expect(run({ [probe]: built('./git') }).unlisted).toEqual(['src/main/sealProbe -> (computed specifier)'])
    expect(sealBreaks(root, { [adapters]: `${text(adapters)}\nexport const later = () => module['req' + 'uire']('./no' + 'ne/none')\n` })).toEqual(['src/main/platform/adapters -> (computed specifier)'])
    // Another object's built member is no loader of its own; module's literal ones other than require aren't either.
    expect(sealBreaks(root, { [probe]: "const k = 'a' + 'b'\nexport const f = (o: Record<string, number>) => o[k]\nexport const id = module['id']\n" })).toEqual([])
  })

  it('reads .mts sources, the renderer\'s @root alias, and a registry passing a platform\'s files on', () => {
    expect(sources(root)).toContain('src/main/progressReporters/report.mts')
    expect(sealBreaks(root, { 'src/main/sealProbe.mts': "import { NoneAdapter } from './platform/none/none'\n" })).toEqual(['src/main/sealProbe -> src/main/platform/none/none'])
    expect(sealBreaks(root, { 'src/renderer/src/sealProbe.ts': "import type { NoneAdapter } from '@root/src/main/platform/none/none'\n" })).toEqual(['src/renderer/src/sealProbe -> src/main/platform/none/none'])
    // A registry imports a platform's files, but a re-export would hand them to everyone importing the registry.
    const adapters = 'src/main/platform/adapters.ts'
    for (const line of ["export * from './none/none'", "export * as none from './none/none'", "export { NoneAdapter } from './none/none'"])
      expect(sealBreaks(root, { [adapters]: `${line}\n${text(adapters)}` }), line).toEqual(['src/main/platform/adapters -> src/main/platform/none/none (re-exported)'])
    expect(sealBreaks(root, { [adapters]: `${text(adapters)}\nconst m = './no' + 'ne/none'\nconst later = () => import(m)\n` })).toEqual(['src/main/platform/adapters -> (computed specifier)'])
  })

  it('gives each edge a class and a reason; a historic one its legacy operation, a defect its card', () => {
    const edges = EDGES as Edge[]
    expect(edges.filter((e) => !['impl', 'registry', 'gitUi', 'historic', 'defect', 'common'].includes(e.class) || !e.why).map((e) => `${e.file} -> ${e.module}`)).toEqual([])
    expect(edges.filter((e) => e.class === 'historic' && !e.op).map((e) => e.file)).toEqual([])
    expect(edges.filter((e) => e.class === 'defect' && !e.card).map((e) => e.file)).toEqual([])
    // Only Git-facing UI may take any name: every other edge lists what it takes.
    expect(edges.filter((e) => e.class !== 'gitUi' && !e.names).map((e) => `${e.file} -> ${e.module}`)).toEqual([])
    expect(Object.entries(SEAMS as Record<string, { calls: Record<string, number>; why: string }>).filter(([, s]) => !s.why).map(([f]) => f)).toEqual([])
    expect(Object.entries(SWITCHES as Record<string, { n: number; why: string }>).filter(([, s]) => !s.why || !(s.n > 0)).map(([f]) => f)).toEqual([])
  })

  it('fails a new Git import in a file whose listed edge is to another module (sessions.ts: the fence, not git)', () => {
    const file = 'src/main/sessions.ts'
    expect(run({ [file]: `import { git } from './git'\n${text(file)}` }).unlisted).toEqual(['src/main/sessions -> src/main/git'])
    expect(run({ [file]: `import * as G from './gitCommands'\nG.head('x')\n${text(file)}` }).unlisted).toEqual(['src/main/sessions -> src/main/gitCommands'])
  })

  it('fails a new Git import however it is written: double quotes, indented, a side effect, a re-export, a require (HR1, round 1)', () => {
    const file = 'src/main/sessions.ts'
    const git = ['src/main/sessions -> src/main/git']
    for (const line of [
      'import { git } from "./git";',
      "  import { git } from './git'",
      "import './git'",
      'import "./git"',
      "export { git } from './git'",
      "export * from './git'",
      "import type { GitResult } from './git'",
      "import G = require('./git')",
      "const g = require('./git')",
      'const later = () => import("./git")',
      'const { git: run } = await import("./git")'
    ]) {
      expect(run({ [file]: `${line}\n${text(file)}` }).unlisted, line).toEqual(git)
    }
  })

  it('fails an import whose specifier is built from pieces (it could load a Git module)', () => {
    const file = 'src/main/sessions.ts'
    expect(run({ [file]: `${text(file)}\nconst m = './gi' + 't'\nconst later = () => import(m)\n` }).unlisted).toEqual(['src/main/sessions -> (computed specifier)'])
  })

  it('takes the names of a double-quoted dynamic import destructured, and fails one beyond the edge', () => {
    const file = 'src/main/projectFolders.ts'
    const t = text(file)
    expect(t).toContain("await import('./unusedWorktrees')")
    expect(run({ [file]: t.replace("await import('./unusedWorktrees')", 'await import("./unusedWorktrees")') }).extraNames).toEqual([])
    expect(run({ [file]: t.replace("const { keptText } = await import('./unusedWorktrees')", 'const { keptText, unusedWorktrees } = await import("./unusedWorktrees")') }).extraNames).toEqual(['src/main/projectFolders -> src/main/unusedWorktrees: unusedWorktrees'])
  })

  it('fails a new Git import in a file with none, a dynamic one included', () => {
    const file = 'src/main/diagnostics.ts'
    expect(run({ [file]: `${text(file)}\nconst t = async () => (await import('./gitTool')).gitTool()\n` }).unlisted).toEqual(['src/main/diagnostics -> src/main/gitTool'])
  })

  it('fails a name taken across a constrained edge beyond its list, by name or through a namespace', () => {
    const file = 'src/main/agentWorktree.ts'
    const added = text(file).replace("import { GIT_FAILED, uniqueFolder } from './worktrees'", "import { GIT_FAILED, createWorktree, uniqueFolder } from './worktrees'")
    expect(run({ [file]: added }).extraNames).toEqual(['src/main/agentWorktree -> src/main/worktrees: createWorktree'])
    const ns = text(file).replace("import { GIT_FAILED, uniqueFolder } from './worktrees'", "import * as wt from './worktrees'\nconst f = wt.uniqueFolder\nconst g = wt.createWorktree")
    expect(run({ [file]: ns }).extraNames).toEqual(['src/main/agentWorktree -> src/main/worktrees: createWorktree'])
  })

  it("doesn't let a generic function in a mixed file inherit a historic edge's names", () => {
    const file = 'src/main/nameUpgradeProjects.ts'
    const added = text(file).replace("import { git } from './git'", "import { git, gitReading } from './git'")
    expect(run({ [file]: added }).extraNames).toEqual(['src/main/nameUpgradeProjects -> src/main/git: gitReading'])
  })

  it('fails a listed edge that is gone (stale)', () => {
    const file = 'src/main/antivirus.ts'
    const gone = text(file).replace(/^import \{ worktreesRoot \} from '\.\/worktrees'\r?\n/m, "const worktreesRoot = (s: string): string => s\n")
    expect(run({ [file]: gone }).stale).toEqual(['src/main/antivirus -> src/main/worktrees'])
  })

  it("finds a platform's integration modes declared only in its descriptor: a second list anywhere else fails (HI-2840)", () => {
    expect(modeDeclarations(root)).toEqual([])
    // A list beside the workflow's, the window's, or the platform layer's own adapters: each is a second declaration. A
    // field of that name holding no mode (a count, another word) is not one.
    const runtime = 'src/main/workflow/runtime.ts'
    const form = 'src/renderer/src/components/WorkflowOptions.tsx'
    const adapter = 'src/main/platform/git/gitPlatform.ts'
    const over: Record<string, string> = {
      [runtime]: `${text(runtime)}
const modes = { finishes: ['committed'] as const }
`,
      [form]: `${text(form)}
const told = { finishes: 3, defaultFinish: 'later' }
const row = { defaultFinish: ('notChecked' satisfies string) }
`,
      [adapter]: `${text(adapter)}
class Modes { 'finishes' = ['agentMerges'] }
`
    }
    const lines = (f: string): number => over[f].split(/\n/).length - 1
    expect(modeDeclarations(root, over)).toEqual([`src/main/platform/git/gitPlatform.ts:${lines(adapter)} finishes`, `src/main/workflow/runtime.ts:${lines(runtime)} finishes`, `src/renderer/src/components/WorkflowOptions.tsx:${lines(form)} defaultFinish`])
  })

  it("fails a switch on a platform's id outside the descriptors, adapters and registry, and one more in a justified file (HI-2822)", () => {
    const options = 'src/shared/workflow/options.ts'
    expect(run({ [options]: `${text(options)}
const g = (o: { platform: string }) => o.platform === 'git'
` }).switches).toEqual(["src/shared/workflow/options: 1 switches on a platform's id, listed 0"])
    const header = 'src/renderer/src/views/VersionControlHeader.tsx'
    expect(run({ [header]: `${text(header)}
const n = (platform: string) => platform !== 'none'
` }).switches).toEqual(["src/renderer/src/views/VersionControlHeader: 2 switches on a platform's id, listed 1"])
    // Its home is free to switch: the registry picks between the platforms.
    const registry = 'src/main/platform/registry.ts'
    expect(run({ [registry]: `${text(registry)}
const r = (platform: string) => platform === 'none'
` }).switches).toEqual([])
  })

  it("fails every platform id's switch however it is written, and leaves descriptor, registration and presentation data alone (HI-3140)", () => {
    const options = 'src/shared/workflow/options.ts'
    const added = (code: string): string[] => run({ [options]: `${text(options)}\n${code}\n` }).switches
    const one = ["src/shared/workflow/options: 1 switches on a platform's id, listed 0"]
    for (const code of [
      "const a = (p: { platform: string }) => p.platform === 'git'",
      "const b = (p: string) => 'git' !== p",
      'const c = (to: string) => to === "none"',
      "const d = (id: string) => id === 'none'",
      'const e = (to: string) => to == `none`',
      "const f = (p: string) => { switch (p) { case 'git': return 1 } return 0 }",
      "const g = (d: object) => 'git' in d",
      "const h = (x: string) => revisionShort('git', x)",
      "const i = PLATFORMS['git'].name",
      'const j = PLATFORMS.none.name'
    ])
      expect(added(code), code).toEqual(one)
    // Allowed: another enum's `none` by its field's name, a comparison of two variables, prose and other strings, a
    // registration by id (not a descriptor helper), and data keyed by the platform.
    for (const code of [
      "const k = (o: { review: string }) => o.review === 'none'",
      'const l = (a: string, b: string) => a === b',
      "// a comment saying platform === 'git'\nconst m = 'git is a platform'",
      "const n = () => registerWorkspacePort('git', port)",
      'const o2: Record<string, number> = { git: 2, none: 3 }',
      "const q = (b: object) => 'none' in b"
    ])
      expect(added(code), code).toEqual([])
  })

  it("fails a switch in a new file with nothing else naming a platform, and one wrapped in parentheses or a cast (HR1's round 1)", () => {
    const fresh = 'src/shared/newPlatformUse.ts'
    const one = ["src/shared/newPlatformUse: 1 switches on a platform's id, listed 0"]
    for (const code of ['export const x = PLATFORMS.git.name', "export const y = (p: string) => p === ('git')", "export const z = (p: string) => p === ('none' as const)", "export const w = (p: string) => ('git' satisfies string) !== p", "export const v = (d: object) => ('git') in d"])
      expect(run({ [fresh]: `${code}\n` }).switches, code).toEqual(one)
    // Controls: a plain string and a parenthesized one compared to another enum, in a file of their own.
    for (const code of ["export const u = (o: { review: string }) => o.review === ('none')", "export const t = 'none' + 'git'"]) expect(run({ [fresh]: `${code}\n` }).switches, code).toEqual([])
  })

  it("reads every platform id from PlatformId's union however it is written, and fails when it can't (HR1's round 1)", () => {
    const desc = 'src/shared/platform/descriptors.ts'
    const t = text(desc)
    const was = /export type PlatformId = [^\r\n]+/.exec(t)![0]
    expect(platformIdsIn(desc, t)).toEqual(['none', 'git'])
    for (const union of ['export type PlatformId = "git" | "none" | "hg"', "export type PlatformId =\n  | 'none'\n  | \"git\"\n  | 'hg'"]) {
      const four = t.replace(was, union)
      expect(platformIdsIn(desc, four).sort(), union).toEqual(['git', 'hg', 'none'])
      // The new id is scanned for at once: a switch on it in shared code fails.
      expect(run({ [desc]: four, 'src/shared/hgUse.ts': "export const h = (p: string) => p === 'hg'\n" }).switches).toEqual(["src/shared/hgUse: 1 switches on a platform's id, listed 0"])
    }
    expect(() => platformIdsIn(desc, t.replace(was, 'export type PlatformId = string'))).toThrow(/PlatformId/)
    expect(() => platformIdsIn(desc, t.replace(was, 'export type Platform = "git"'))).toThrow(/PlatformId/)
  })

  it('exempts a composition only by its data: a switch elsewhere in slotsApp fails (HI-3140)', () => {
    const app = 'src/main/slotsApp.ts'
    expect(run({ [app]: `${text(app)}\nconst x = (p: string) => p === 'git'\n` }).switches).toEqual(["src/main/slotsApp: 1 switches on a platform's id, listed 0"])
  })

  it('fails an exemption nothing uses any more: a NOT_PLATFORM name, a listed switch (HI-3140)', () => {
    const tiles = 'src/renderer/src/components/AgentTiles.tsx'
    expect(run({ [tiles]: text(tiles).replace("x !== 'none'", "x !== 'auto'") }).switches).toEqual(["src/renderer/src/components/AgentTiles: 0 switches on a platform's id, listed 1"])
    const scan = 'src/renderer/src/components/Antivirus.tsx'
    const noScan = text(scan).replace(/status\.scan === 'none'/g, 'status.scan === null').replace(/case 'none':/g, "case 'off':")
    expect(run({ [scan]: noScan }).switches).toEqual(['NOT_PLATFORM scan: no comparison uses it (stale)'])
    expect(Object.values(SWITCHES as Record<string, { class?: string }>).filter((s) => !['data', 'historic', 'gitUi', 'schema'].includes(s.class ?? '')).length).toBe(0)
    expect(Object.values(NOT_PLATFORM as Record<string, string>).every((why) => !!why)).toBe(true)
  })

  it('fails a new seam call in a listed file, and one in a file with none', () => {
    const slots = 'src/main/slots.ts'
    expect(run({ [slots]: `${text(slots)}\nconst x = () => lineHistory()\n` }).seams).toEqual(['src/main/slots: lineHistory() ×4, listed ×3'])
    const tasks = 'src/main/tasks.ts'
    expect(run({ [tasks]: `${text(tasks)}\nconst y = () => queueIntegration()\n` }).seams).toEqual(['src/main/tasks: queueIntegration() ×1, listed ×0'])
  })
})
