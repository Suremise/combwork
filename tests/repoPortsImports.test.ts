// The repository context port's import rule (SPEC §16.3.6, HI-2784's R1; npm run check:repo): a caller moved to the port
// reaches Git's runner, tool check and locks only through it (src/main/platform/repoPorts.ts), and the port's contract
// imports no platform's code. Each R card adds the callers it moves; R9's audit holds the rest. The port's behaviour,
// traced against the code it delegates to, is tests/repoPorts.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('callers moved to the repository context port', () => {
  const root = join(__dirname, '..')
  /** R1's Git modules: the runner, its worker and tool check, the queue's host, the locks, the fence and ref holds. */
  const GIT_SEAMS = ['src/main/git', 'src/main/gitTool', 'src/main/gitWorker', 'src/main/workflow/gitHost', 'src/main/repoLock', 'src/main/repoLockCore', 'src/main/repoLockWorker', 'src/main/folderFence', 'src/main/platform/refHold', 'src/main/platform/gitRepoPorts']
  /** The callers moved (HI-2784): each takes repository locks through repoPorts.ts. */
  const MOVED = ['src/main/settingsTools.ts', 'src/main/workflow/levels.ts', 'src/main/workflow/optionsForm.ts', 'src/main/workflow/platformSwitch.ts']

  /** A file's imports (static, dynamic and re-exports), as repo paths without an extension. */
  const importsOf = (file: string): string[] => {
    const text = readFileSync(join(root, file), 'utf8')
    const specs = [...text.matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]).filter((s) => s.startsWith('.'))
    return specs.map((s) => relative(root, resolve(root, file, '..', s)).replace(/\\/g, '/').replace(/\.(ts|js)$/, ''))
  }

  it('the moved callers import none of Git\'s runner, tool, lock, fence or ref hold modules', () => {
    expect(MOVED.flatMap((f) => importsOf(f).filter((i) => GIT_SEAMS.includes(i)).map((i) => `${f} imports ${i}`))).toEqual([])
  })

  it("the port's contract imports no platform's code, only types", () => {
    const text = readFileSync(join(root, 'src/main/platform/repoContext.ts'), 'utf8')
    expect(importsOf('src/main/platform/repoContext.ts')).toEqual(['src/shared/platform/descriptors'])
    expect(text).toMatch(/import type \{[^}]+\} from '\.\.\/\.\.\/shared\/platform\/descriptors'/)
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
    expect(files.filter((f) => importsOf(f).includes('src/main/platform/gitRepoPorts'))).toEqual(['src/main/platform/repoPorts.ts'])
  })
})
