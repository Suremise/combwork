// HI-3407: the trusted entry the scenario harness (and lib.openWorkspace, HI-3342) writes in a fake Claude Code home, so
// Combwork grants a reviewer its review copies (HI-3337): the workspace's worktrees folder by its real path with forward
// slashes, as Claude Code writes it (tests/fixtures/advanced/trust-entry-*), the rest of .claude.json kept, the folder
// itself not made (HI-3395).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'

const req = createRequire(import.meta.url)
const lib = req('./e2e/lib.cjs') as { trustWorktrees: (home: string, ws: string) => string }

const made: string[] = []
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true })
})
const setUp = () => {
  const root = tempDir('cw-trust-worktrees-')
  made.push(root)
  const home = join(root, 'claude-home')
  const ws = join(root, 'ws')
  mkdirSync(home, { recursive: true })
  mkdirSync(ws, { recursive: true })
  return { home, ws, expected: `${realpathSync.native(root)}\\ws.worktrees`.replace(/\\/g, '/') }
}
const read = (home: string) => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))

describe('lib.trustWorktrees', () => {
  it('trusts the worktrees folder by its real path, forward slashes, without making it', () => {
    const { home, ws, expected } = setUp()
    expect(lib.trustWorktrees(home, ws)).toBe(expected)
    expect(read(home)).toEqual({ projects: { [expected]: { hasTrustDialogAccepted: true } } })
    expect(existsSync(`${ws}.worktrees`)).toBe(false)
  })

  it("keeps what the home's .claude.json already has", () => {
    const { home, ws, expected } = setUp()
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, projects: { 'C:/other': { hasTrustDialogAccepted: true }, [expected]: { allowedTools: [] } } }))
    lib.trustWorktrees(home, ws)
    expect(read(home)).toEqual({ hasCompletedOnboarding: true, projects: { 'C:/other': { hasTrustDialogAccepted: true }, [expected]: { allowedTools: [], hasTrustDialogAccepted: true } } })
  })

  it("throws on a .claude.json that isn't JSON rather than write it afresh", () => {
    const { home, ws } = setUp()
    writeFileSync(join(home, '.claude.json'), '{ not json')
    expect(() => lib.trustWorktrees(home, ws)).toThrow()
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ not json')
  })
})
