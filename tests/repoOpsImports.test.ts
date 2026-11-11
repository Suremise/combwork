// The repository operations port's import rule (SPEC §16.3.6 port 5, HI-2788's R3; npm run check:repo): the window's
// and the Assistant's repository mutations reach Git's code only through the port (src/main/platform/repoOpsPorts.ts,
// gated by each operation; the IPC handlers in src/main/repoOpsIpc.ts), and the port's contract imports no platform's
// code. The gate itself, at each entry point, is tests/repoOpsBoundary.test.ts; the delegation, traced against the code
// before the port, tests/repoOpTraces.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

/** A file's relative imports (static, dynamic and re-exports), as repo paths without an extension. */
const importsOf = (file: string): string[] => {
  const specs = [...read(file).matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]).filter((s) => s.startsWith('.'))
  return specs.map((s) => relative(root, resolve(root, file, '..', s)).replace(/\\/g, '/').replace(/\.(ts|js)$/, ''))
}

/** The names a file imports from a repo module, however its specifier is written. */
const namesFrom = (file: string, mod: string): string[] =>
  [...read(file).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)]
    .filter((m) => m[2].startsWith('.') && relative(root, resolve(root, file, '..', m[2])).replace(/\\/g, '/').replace(/\.(ts|js)$/, '') === mod)
    .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean))

/** The mutations, by the module holding their Git implementation: what a moved caller takes from the port instead. */
const MUTATIONS: Record<string, readonly string[]> = {
  'src/main/gitRepo': ['switchBranch', 'createBranch', 'deleteBranches', 'deleteRemoteBranches', 'updateBranch', 'makeBranchAt', 'removeMadeBranch', 'addRemote', 'renameRemote', 'setRemoteUrl', 'removeRemote', 'fetchAll', 'pull', 'push', 'pushToRemote', 'setUpstream', 'createTag', 'setIdentity'],
  'src/main/gitInit': ['initCheck', 'initRepo'],
  'src/main/branchMerge': ['mergeBranch'],
  'src/main/worktrees': ['mergeWorktree'],
  'src/main/filesGit': ['gitExclude', 'gitUntrack', 'gitInclude']
}

/** The callers moved: the IPC (and its handlers), the Assistant's branch route, Start the next version, the branch undo, the 0.9 worktree merge. */
const MOVED = ['src/main/ipc.ts', 'src/main/repoOpsIpc.ts', 'src/main/servers.ts', 'src/main/workflow/nextVersion.ts', 'src/main/assistantUndo.ts', 'src/main/projectAgents.ts']

describe('callers moved to the repository operations port (HI-2788)', () => {
  it('import none of the mutations from Git’s modules, and call none through a namespace', () => {
    const found = MOVED.flatMap((f) => Object.entries(MUTATIONS).flatMap(([mod, names]) => namesFrom(f, mod).filter((x) => names.includes(x)).map((x) => `${f} imports ${x} from ${mod}`)))
    expect(found).toEqual([])
    // ipc.ts reads filesGit.ts through a namespace (its reads stay there), projectAgents.ts worktrees.ts: never a mutation.
    expect(read('src/main/ipc.ts')).not.toMatch(/filesGit\.(gitExclude|gitUntrack|gitInclude)\b/)
    expect(read('src/main/projectAgents.ts')).not.toMatch(/\bwt\.mergeWorktree\b/)
  })

  it("the port's contract imports no platform's code, only shared types", () => {
    const text = read('src/main/platform/repoOps.ts')
    expect(importsOf('src/main/platform/repoOps.ts').every((i) => i.startsWith('src/shared/'))).toBe(true)
    expect([...text.matchAll(/^import\s+(?!type\b)/gm)]).toHaveLength(0)
  })

  it("only the port's registry imports Git's implementation of it, and the registry is the only way to it", () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(root, dir))) {
        const p = `${dir}/${e}`
        if (statSync(join(root, p)).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e)) files.push(p)
      }
    }
    walk('src')
    expect(files.filter((f) => importsOf(f).includes('src/main/platform/gitRepoOps'))).toEqual(['src/main/platform/repoOpsPorts.ts'])
    // The registry exports only the gated lookups: no ungated way to the port.
    expect([...read('src/main/platform/repoOpsPorts.ts').matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(['lineRepoOps', 'repoOpsFor'])
  })
})
