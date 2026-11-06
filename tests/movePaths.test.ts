// A moved workspace (#146): stored paths rewritten only under the old folder, as Windows compares them; where a worktree
// may be now; Claude Code's folder name for a path; and the copy of a CLI's per-path data that never overwrites.
import { describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { moveHasWork, rebase, rebaseAny, samePath, worktreeCandidates } from '../src/shared/movePaths'
import type { MovePlan, PathDataCopy } from '../src/shared/types'
import { encodeProjectPath } from '../src/main/providers/claude/usage'
import { copyMissing } from '../src/main/fsutil'
import { tempDir } from './tempDir'

describe('rebase', () => {
  it('moves a path under the old folder, keeping the case of the rest', () => {
    expect(rebase('D:\\Dev\\ACME\\alpha\\Src', 'D:\\Dev\\ACME', 'E:\\Work\\ACME')).toBe('E:\\Work\\ACME\\alpha\\Src')
    expect(rebase('D:\\Dev\\ACME', 'D:\\Dev\\ACME', 'E:\\Work\\ACME')).toBe('E:\\Work\\ACME')
  })
  it('compares without case and with either separator, as Windows does', () => {
    expect(rebase('d:\\dev\\acme\\alpha', 'D:\\Dev\\ACME', 'E:\\ACME')).toBe('E:\\ACME\\alpha')
    expect(rebase('D:/Dev/ACME/alpha', 'D:\\Dev\\ACME\\', 'E:\\ACME')).toBe('E:\\ACME\\alpha')
  })
  it('only at a folder boundary, and only under the old folder', () => {
    expect(rebase('D:\\Dev\\ACME2\\alpha', 'D:\\Dev\\ACME', 'E:\\ACME')).toBeNull()
    expect(rebase('D:\\Dev\\ACM', 'D:\\Dev\\ACME', 'E:\\ACME')).toBeNull()
    expect(rebase('C:\\Other\\alpha', 'D:\\Dev\\ACME', 'E:\\ACME')).toBeNull()
    expect(rebase('D:\\Dev\\ACME\\alpha', '', 'E:\\ACME')).toBeNull()
  })
  it('the deepest move that contains a path wins', () => {
    const moves = [
      { from: 'D:\\Dev\\ACME', to: 'E:\\ACME' },
      { from: 'D:\\Dev\\ACME\\alpha', to: 'E:\\Renamed' }
    ]
    expect(rebaseAny('D:\\Dev\\ACME\\alpha\\x', moves)).toBe('E:\\Renamed\\x')
    expect(rebaseAny('D:\\Dev\\ACME\\beta', moves)).toBe('E:\\ACME\\beta')
    expect(rebaseAny('F:\\elsewhere', moves)).toBeNull()
  })
  it('samePath', () => {
    expect(samePath('D:\\Dev\\ACME\\', 'd:/dev/acme')).toBe(true)
    expect(samePath('D:\\Dev\\ACME', 'D:\\Dev\\ACME2')).toBe(false)
  })
})

describe('worktreeCandidates', () => {
  const ws = { from: 'D:\\Dev\\ACME', to: 'E:\\ACME' }
  const project = { from: 'D:\\Dev\\ACME\\acme', to: 'E:\\ACME\\acme' }
  it("in Combwork's worktrees folder beside the workspace: moved along with it, else where it was", () => {
    expect(worktreeCandidates('D:\\Dev\\ACME.worktrees\\acme\\claudio', ws, project)).toEqual(['E:\\ACME.worktrees\\acme\\claudio', 'D:\\Dev\\ACME.worktrees\\acme\\claudio'])
  })
  it('inside the project or the workspace: moved along with it first', () => {
    expect(worktreeCandidates('D:\\Dev\\ACME\\acme\\wt', ws, project)).toEqual(['E:\\ACME\\acme\\wt', 'D:\\Dev\\ACME\\acme\\wt'])
    expect(worktreeCandidates('D:\\Dev\\ACME\\trees\\wt', ws, project)).toEqual(['E:\\ACME\\trees\\wt', 'D:\\Dev\\ACME\\trees\\wt'])
  })
  it('anywhere else: only where it was', () => {
    expect(worktreeCandidates('C:\\trees\\wt\\', ws, project)).toEqual(['C:\\trees\\wt'])
  })
})

describe('moveHasWork', () => {
  const plan = (folders: Partial<PathDataCopy>[], more: Partial<MovePlan> = {}): MovePlan => ({
    from: 'D:\\ACME',
    to: 'E:\\ACME',
    projects: ['alpha'],
    pending: [],
    running: [],
    recent: false,
    working: [],
    hosts: [{ path: 'E:\\ACME\\alpha', name: 'alpha', from: 'D:\\ACME\\alpha', folder: 'E:\\ACME\\alpha', worktrees: [], sessions: 0, folders: folders.map((f) => ({ provider: 'claude-code', from: 'a', to: 'b', copy: 0, kept: [], ...f })) }],
    ...more
  })
  it('nothing left: no worktree, session, file, Recent or Working on', () => {
    expect(moveHasWork(plan([{}]))).toBe(false)
    expect(moveHasWork(plan([]))).toBe(false)
  })
  it('files to copy, Open Recent, Working on', () => {
    expect(moveHasWork(plan([{ copy: 2 }]))).toBe(true)
    expect(moveHasWork(plan([], { recent: true }))).toBe(true)
    expect(moveHasWork(plan([], { working: ['alpha'] }))).toBe(true)
  })
  it("a folder that couldn't be read stays pending: never taken for nothing to repair", () => {
    expect(moveHasWork(plan([{ copy: 0, failed: ['access denied'] }]))).toBe(true)
  })
  it('files already there with other content are shown, not skipped silently', () => {
    expect(moveHasWork(plan([{ copy: 0, kept: ['memory/MEMORY.md'] }]))).toBe(true)
  })
})

describe("Claude Code's folder for a path", () => {
  it('turns backslashes, colons and dots into dashes', () => {
    expect(encodeProjectPath('D:\\Projects\\ACME.worktrees\\acme\\claude')).toBe('D--Projects-ACME-worktrees-acme-claude')
    expect(encodeProjectPath('E:\\My Work\\v1.2\\app')).toBe('E--My-Work-v1-2-app')
  })
})

describe('copyMissing', () => {
  const setup = async (): Promise<{ src: string; dest: string }> => {
    const root = tempDir('cw-copymissing-')
    const src = join(root, 'old')
    const dest = join(root, 'new')
    await mkdir(join(src, 'memory'), { recursive: true })
    await writeFile(join(src, 'a.jsonl'), 'one')
    await writeFile(join(src, 'memory', 'MEMORY.md'), '- [Fact](fact.md)')
    return { src, dest }
  }
  it('counts without copying, then copies with the times kept, and a second run copies nothing', async () => {
    const { src, dest } = await setup()
    expect(await copyMissing(src, dest, false)).toEqual({ copy: 2, kept: [], failed: [] })
    await expect(stat(dest)).rejects.toThrow()
    expect(await copyMissing(src, dest, true)).toEqual({ copy: 2, kept: [], failed: [] })
    expect(await readFile(join(dest, 'memory', 'MEMORY.md'), 'utf8')).toBe('- [Fact](fact.md)')
    expect(Math.abs((await stat(join(dest, 'a.jsonl'))).mtimeMs - (await stat(join(src, 'a.jsonl'))).mtimeMs)).toBeLessThan(2)
    expect(await copyMissing(src, dest, true)).toEqual({ copy: 0, kept: [], failed: [] })
    expect(await readFile(join(src, 'a.jsonl'), 'utf8')).toBe('one')
  })
  it("a source that can't be read is listed as failed, not taken for nothing to copy", async () => {
    const { src, dest } = await setup()
    expect(await copyMissing(join(src, 'gone'), dest, false)).toEqual({ copy: 0, kept: [], failed: ['.'] })
  })
  it('never overwrites a file that is already there with other content: it is listed as kept', async () => {
    const { src, dest } = await setup()
    await mkdir(dest, { recursive: true })
    await writeFile(join(dest, 'a.jsonl'), 'newer conversation')
    await utimes(join(dest, 'a.jsonl'), new Date(), new Date(Date.now() + 60_000))
    expect(await copyMissing(src, dest, true)).toEqual({ copy: 1, kept: ['a.jsonl'], failed: [] })
    expect(await readFile(join(dest, 'a.jsonl'), 'utf8')).toBe('newer conversation')
  })
})
