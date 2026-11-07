// `npm run test:waits`'s e2e ready waits (HI-2688, scripts/readyWaits.mjs): a wait for an agent's `status === 'ready'`
// is found, with whether a comment says why (before any turn `ready` is right); a branch's new one with no comment fails.
// The samples build the word so this file isn't one.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: a plain .mjs module without types
import { findReadyWaits } from '../scripts/readyWaits.mjs'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
const R = ['rea', 'dy'].join('')
const lines = (...l: string[]): string => l.join('\r\n')

describe('e2e ready waits (HI-2688)', () => {
  it("finds a wait for an agent's ready status, in the forms the suites use, and where", () => {
    const found = findReadyWaits(
      lines(
        '  await lib.sendPrompt(inv, key, "go", { submitted })',
        `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`,
        `  await lib.until(async () => (await inv('session:live')).some((s) => s.agentId === a.id && s.status === "${R}"), 15000)`,
        `  const bReady = () => lib.until(async () => (await live(b.id))?.status === '${R}', HUNG_MS)`
      )
    )
    expect(found.map((w: { line: number; commented: boolean }) => [w.line, w.commented])).toEqual([
      [2, false],
      [3, false],
      [4, false]
    ])
  })

  it('takes a comment on its line or the line above as its reason; a check of another status, or a commented-out wait, is none', () => {
    const found = findReadyWaits(
      lines(
        `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS) // before its first turn`,
        '  // Before any turn: the fake is ready.',
        `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`,
        `  await until(async () => (await live(id))?.status === 'working', HUNG_MS)`,
        `  // await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`,
        `  check('ready', (await live(id))?.status === '${R}')`
      )
    )
    expect(found.map((w: { line: number; commented: boolean }) => [w.line, w.commented])).toEqual([
      [1, true],
      [3, true]
    ])
  })

  it("fails on a branch's new ready wait with no comment, not on one already in the base, and says what to use", () => {
    const repo = tempDir('combwork-readywaits-')
    mkdirSync(join(repo, 'scripts'))
    mkdirSync(join(repo, 'tests', 'e2e'), { recursive: true })
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'readyWaits.mjs'), join(repo, 'scripts', 'readyWaits.mjs'))
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', env: ctx.baseEnv() })
    const suite = join(repo, 'tests', 'e2e', 'sample.cjs')
    const old = `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`
    writeFileSync(suite, lines('// a suite', old, ''))
    expect(git('init', '-q', '-b', 'main').status).toBe(0)
    expect(git('add', '.').status).toBe(0)
    expect(git('commit', '-q', '-m', 'base').status).toBe(0)
    const run = () => spawnSync(process.execPath, [join(repo, 'scripts', 'readyWaits.mjs')], { cwd: repo, encoding: 'utf8', env: ctx.baseEnv() })
    // The base's own wait isn't the branch's.
    expect(run().status).toBe(0)
    writeFileSync(suite, lines('// a suite', old, '  await lib.sendPrompt(inv, key, "go", { submitted })', `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`, ''))
    const bad = run()
    expect(bad.status).toBe(1)
    expect(bad.stdout).toContain('tests/e2e/sample.cjs:4')
    expect(bad.stdout).not.toContain('sample.cjs:2')
    expect(bad.stdout).toContain('lib.agentIdle')
    // With a comment saying why, it passes.
    writeFileSync(suite, lines('// a suite', old, '  // Before its first turn: ready is right.', `  await until(async () => (await live(id))?.status === '${R}', HUNG_MS)`, ''))
    expect(run().status).toBe(0)
  })
})
