// The integration port's import rule, its candidate half (SPEC §16.3.6 port 4, HI-2790's R7; npm run check:repo): the
// merge queue builds its candidate only through the port (src/main/platform/integrationPorts.ts): none of Git's
// candidate commands (the queue's worktree made or reused, the test merge, a squash's commit, strict's update, the
// rebase, the conflicts read and the cleanup, the queue's pins) are in mergeQueue.ts any more, and the port's contract
// imports no platform's code. The advance, journal, recovery and publish half is R8's, and the queue's remaining Git
// reads are listed against R8 and R9 in SPEC's type map. The commands, traced against those before the port, are
// tests/workflow/queueTraces.test.ts.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe("the merge queue's candidate through the integration port", () => {
  const root = join(__dirname, '..')
  const read = (file: string): string => readFileSync(join(root, file), 'utf8')
  /** A file's imports (static, dynamic and re-exports), as repo paths without an extension. */
  const importsOf = (file: string): string[] => {
    const specs = [...read(file).matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]).filter((s) => s.startsWith('.'))
    return specs.map((s) => relative(root, resolve(root, file, '..', s)).replace(/\\/g, '/').replace(/\.(ts|js)$/, ''))
  }

  it("mergeQueue.ts runs none of Git's candidate commands itself", () => {
    const text = read('src/main/workflow/mergeQueue.ts')
    const commands: [string, RegExp][] = [
      ['the worktree list or add', /'worktree',\s*'(?:list|add)'/],
      ['a checkout, clean or reset of the queue\'s worktree', /\['(?:checkout|clean|reset)',\s*'-/],
      ['a merge, squash or its abort', /'merge',\s*'(?:--no-ff|--squash|--abort)'|'--squash'|squash \? '--squash'/],
      ['a rebase', /'rebase',\s*'--/],
      ["a squash's commit", /'commit',\s*'-q'/],
      ['the conflicts read', /'--diff-filter=U'|readConflicts/],
      ['whether it signs', /commit\.gpgsign/],
      ['a queue pin', /`refs\/cw\/queue\/\$\{refSafe/],
      ['the merge base', /'merge-base',\s*a,\s*b/]
    ]
    expect(commands.filter(([, re]) => re.test(text)).map(([what]) => what)).toEqual([])
    expect(importsOf('src/main/workflow/mergeQueue.ts')).not.toContain('src/main/platform/gitIntegration')
    expect(importsOf('src/main/workflow/mergeQueue.ts')).not.toContain('src/main/workflow/conflictRead')
  })

  it("HI-2791: the advance, recovery, push and clean-up run none of Git's commands in the queue's own modules", () => {
    const found: string[] = []
    const rules: [string, string, RegExp][] = [
      ['src/main/workflow/mergeQueue.ts', 'the swap', /'update-ref',\s*`refs\/heads\//],
      ['src/main/workflow/mergeQueue.ts', 'read-tree', /'read-tree'/],
      ['src/main/workflow/mergeQueue.ts', "the folder's status or index", /'status',\s*'--porcelain'|'diff',\s*'--cached'|'--name-only'/],
      ['src/main/workflow/mergeQueue.ts', 'the push or its destination', /'push',\s*'--'|'config',\s*'--get'|\['remote'\]/],
      ['src/main/workflow/mergeQueue.ts', "the platform's reads of the advance", /G\.(?:checkouts|heads|branch|lineHead|isAncestor)\(/],
      ['src/main/workflow/queueHost.ts', 'the pins', /'for-each-ref'|'update-ref',\s*'-d'/],
      ['src/main/workflow/queueRunner.ts', "the workspace's removal", /'worktree',\s*'(?:remove|prune)'/],
      ['src/main/workflow/queueControls.ts', "a paused condition's reads", /'diff',\s*'--cached',\s*'--quiet'|'--untracked-files=all'|G\.checkouts\(/]
    ]
    for (const [file, what, re] of rules) if (re.test(read(file))) found.push(`${file}: ${what}`)
    expect(found).toEqual([])
    for (const file of ['src/main/workflow/queueHost.ts', 'src/main/workflow/queueRunner.ts', 'src/main/workflow/queueControls.ts']) expect(importsOf(file), file).not.toContain('src/main/platform/gitIntegration')
  })

  it("the port's contract imports no platform's code, only types", () => {
    const text = read('src/main/platform/integration.ts')
    expect(importsOf('src/main/platform/integration.ts').sort()).toEqual(['src/main/platform/types', 'src/shared/workflow/conflicts', 'src/shared/workflow/queue'])
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
    expect(files.filter((f) => importsOf(f).includes('src/main/platform/gitIntegration'))).toEqual(['src/main/platform/integrationPorts.ts'])
  })
})
