// The Git/None cutover audit's import rule (SPEC §16.3.6, HI-2792's R9; npm run check:repo): every import of a Git
// module from outside Git's implementation is a classified edge in tests/gitAudit.mjs, taking only the names it lists,
// and every "platform with lines" seam is counted per caller. A new edge, a new name across a constrained one, a new seam
// call in a listed file, or a listed edge that is gone fails here, naming it. scripts/gitInventory.mjs prints the audit.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types, shared with scripts/gitInventory.mjs
import { audit, EDGES, SEAMS } from './gitAudit.mjs'

type Edge = { file: string; module: string; class: string; names?: string[]; op?: string; card?: string; why: string }
type Audit = { found: unknown[]; unlisted: string[]; stale: string[]; extraNames: string[]; seams: string[] }
const root = join(__dirname, '..')
const run = (over: Record<string, string> = {}): Audit => audit(root, over)
const text = (file: string): string => readFileSync(join(root, file), 'utf8')

describe('the Git/None cutover audit', () => {
  it('classifies every Git import outside Git\'s implementation, and counts every seam', () => {
    const a = run()
    expect({ unlisted: a.unlisted, stale: a.stale, extraNames: a.extraNames, seams: a.seams }).toEqual({ unlisted: [], stale: [], extraNames: [], seams: [] })
  })

  it('gives each edge a class and a reason; a historic one its legacy operation, a defect its card', () => {
    const edges = EDGES as Edge[]
    expect(edges.filter((e) => !['impl', 'registry', 'gitUi', 'historic', 'defect', 'common'].includes(e.class) || !e.why).map((e) => `${e.file} -> ${e.module}`)).toEqual([])
    expect(edges.filter((e) => e.class === 'historic' && !e.op).map((e) => e.file)).toEqual([])
    expect(edges.filter((e) => e.class === 'defect' && !e.card).map((e) => e.file)).toEqual([])
    // Only Git-facing UI may take any name: every other edge lists what it takes.
    expect(edges.filter((e) => e.class !== 'gitUi' && !e.names).map((e) => `${e.file} -> ${e.module}`)).toEqual([])
    expect(Object.entries(SEAMS as Record<string, { calls: Record<string, number>; why: string }>).filter(([, s]) => !s.why).map(([f]) => f)).toEqual([])
  })

  it('fails a new Git import in a file whose listed edge is to another module (sessions.ts: the fence, not git)', () => {
    const file = 'src/main/sessions.ts'
    expect(run({ [file]: `import { git } from './git'\n${text(file)}` }).unlisted).toEqual(['src/main/sessions -> src/main/git'])
    expect(run({ [file]: `import * as G from './platform/git'\nG.head('x')\n${text(file)}` }).unlisted).toEqual(['src/main/sessions -> src/main/platform/git'])
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

  it('fails a new seam call in a listed file, and one in a file with none', () => {
    const slots = 'src/main/slots.ts'
    expect(run({ [slots]: `${text(slots)}\nconst x = () => lineHistory()\n` }).seams).toEqual(['src/main/slots: lineHistory() ×4, listed ×3'])
    const tasks = 'src/main/tasks.ts'
    expect(run({ [tasks]: `${text(tasks)}\nconst y = () => queueIntegration()\n` }).seams).toEqual(['src/main/tasks: queueIntegration() ×1, listed ×0'])
  })
})
