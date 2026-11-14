// HI-3009: the blocking endTree (two spawnSync PowerShell runs, about 2.4 s of the thread it runs on) stays out of
// Combwork's main process: in src/main only cw-progress's own process (its wrapper) uses it, and every other caller ends a
// tree through treeEnding or endTreeAsync (processTree.ts). Source only, so check:repo runs it; the callers' behaviour (no
// spawnSync, the thread ticking, the outcome after the tree) is tests/treeEndingOffThread.test.ts's.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', 'src', 'main')

describe('the blocking endTree stays out of main (HI-3009)', () => {
  it("in src/main only cw-progress's wrapper, its own process, uses it; every other caller ends a tree through treeEnding or endTreeAsync", () => {
    const files: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n)) files.push(p)
      }
    }
    walk(root)
    // An import or call of `endTree` itself (not endTreeAsync, nor a `deps.endTree` seam), outside its own module.
    const uses = files
      .map((f) => relative(root, f).replace(/\\/g, '/'))
      .filter((f) => f !== 'processTree.ts')
      .filter((f) => /(?<![.\w])endTree\b(?!Async)(?!\s*:)/.test(readFileSync(join(root, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
    expect(uses).toEqual(['progressReporters/wrapper.ts'])
  })
})
