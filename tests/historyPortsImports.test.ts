// The evidence and history port's import rule (SPEC §16.3.6 port 3, HI-2787's R6; npm run check:repo): a caller moved to
// the port reaches Git's history reads, its runner and the watcher only through it (src/main/platform/historyPorts.ts),
// and the port's contract imports no platform's code. The callers SPEC's type map leaves to R9 aren't held here yet; R9's
// audit holds the rest. The port's behaviour, traced against the code it replaces, is tests/historyPorts.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('callers moved to the evidence and history port', () => {
  const root = join(__dirname, '..')
  /** Git's history reads and runner, the watcher's module, and the port's Git implementation. */
  const GIT_SEAMS = ['src/main/git', 'src/main/gitWorker', 'src/main/platform/git', 'src/main/platform/repoRefs', 'src/main/platform/observe', 'src/main/platform/gitHistory']
  /** The callers moved (HI-2787): each reads history and the write record through historyPorts.ts. */
  const MOVED = ['src/main/workflow/reconcile.ts', 'src/main/workflow/reconciler.ts', 'src/main/workflow/recorder.ts', 'src/main/workflow/targets.ts', 'src/main/workflow/retarget.ts', 'src/main/workflow/runChecks.ts', 'src/main/workflow/focusedRun.ts', 'src/main/workflow/queueChecks.ts']

  /** A file's imports (static, dynamic and re-exports), as repo paths without an extension. */
  const importsOf = (file: string): string[] => {
    const text = readFileSync(join(root, file), 'utf8')
    const specs = [...text.matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]).filter((s) => s.startsWith('.'))
    return specs.map((s) => relative(root, resolve(root, file, '..', s)).replace(/\\/g, '/').replace(/\.(ts|js)$/, ''))
  }

  it("the moved callers import none of Git's history, runner or watcher modules", () => {
    expect(MOVED.flatMap((f) => importsOf(f).filter((i) => GIT_SEAMS.includes(i)).map((i) => `${f} imports ${i}`))).toEqual([])
  })

  it('the moved callers never switch on a platform id', () => {
    const switches = /\b(?:platform|platformId|\.id)\s*[!=]==\s*'(?:git|none)'|'(?:git|none)'\s*[!=]==/
    expect(MOVED.filter((f) => switches.test(readFileSync(join(root, f), 'utf8')))).toEqual([])
  })

  it("the port's contract imports no platform's code, only types", () => {
    const text = readFileSync(join(root, 'src/main/platform/history.ts'), 'utf8')
    expect(importsOf('src/main/platform/history.ts').sort()).toEqual(['src/main/platform/types', 'src/shared/workflow/facts'])
    expect([...text.matchAll(/^import .*$/gm)].every((m) => m[0].startsWith('import type '))).toBe(true)
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
    expect(files.filter((f) => importsOf(f).includes('src/main/platform/gitHistory'))).toEqual(['src/main/platform/historyPorts.ts'])
  })
})
