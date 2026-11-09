// The repository reads port's import rule (SPEC §16.3.6 port 5, HI-2785's R2; npm run check:repo): the window's reads
// reach Git's code only through the port (src/main/platform/repoReadsPorts.ts), and the port's contract imports no
// platform's code. ipc.ts keeps importing gitRepo.ts' and branchMerge.ts' mutations until R3 (HI-2788) moves them; what
// it may no longer import is any read. The port's behaviour, traced against the code it delegates to, is
// tests/repoReadTraces.test.ts.
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

/** The names a file imports from a repo module (`src/main/gitRepo`), however its specifier is written. */
const namesFrom = (file: string, mod: string): string[] =>
  [...read(file).matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)]
    .filter((m) => m[2].startsWith('.') && relative(root, resolve(root, file, '..', m[2])).replace(/\\/g, '/').replace(/\.(ts|js)$/, '') === mod)
    .flatMap((m) => m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean))

/** The reads, by the module that holds their Git implementation: what a moved caller takes from the port instead. */
const READS: Record<string, readonly string[]> = {
  'src/main/gitRepo': ['repoSummary', 'repoInfo', 'leftoverInfo', 'repoHistory', 'workTargetOf', 'branchDrops', 'branchUpdatePlan', 'remoteTracking', 'startPoints', 'resolveStart', 'checkBranchName', 'missingBranches'],
  'src/main/gitCompare': ['compareLines', 'compareBranches', 'compareDiff'],
  'src/main/branchWatch': ['lineStatus'],
  'src/main/branchMerge': ['mergeBranches', 'branchMergeStatus']
}

/** The callers moved: the window's IPC, and Start the next version's reads (HI-2807). */
const MOVED = ['src/main/ipc.ts', 'src/main/workflow/nextVersion.ts']

describe('callers moved to the repository reads port (HI-2785)', () => {
  it('import none of the reads from Git’s modules', () => {
    const found = MOVED.flatMap((f) => Object.entries(READS).flatMap(([mod, names]) => namesFrom(f, mod).filter((n) => names.includes(n)).map((n) => `${f} imports ${n} from ${mod}`)))
    expect(found).toEqual([])
    // Nor the comparison module at all: all of it is reads.
    expect(MOVED.filter((f) => importsOf(f).includes('src/main/gitCompare'))).toEqual([])
  })

  it("the port's contract imports no platform's code, only shared types", () => {
    const text = read('src/main/platform/repoReads.ts')
    expect(importsOf('src/main/platform/repoReads.ts').every((i) => i.startsWith('src/shared/'))).toBe(true)
    expect([...text.matchAll(/^import\s+(?!type\b)/gm)]).toHaveLength(0)
  })

  it("only the port's registry imports Git's implementation of it", () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(root, dir))) {
        const p = `${dir}/${e}`
        if (statSync(join(root, p)).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e)) files.push(p)
      }
    }
    walk('src')
    expect(files.filter((f) => importsOf(f).includes('src/main/platform/gitRepoReads'))).toEqual(['src/main/platform/repoReadsPorts.ts'])
  })
})
