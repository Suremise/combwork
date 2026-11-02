// HI-2322: one change to a repository's worktrees at a time (src/main/git.ts, oneWorktreeChange). Git reads every
// worktree's entry as it adds one and fails on one another add has made but not yet written ("fatal: failed to read
// .git/worktrees/copy-1/commondir"), so two review copies made at once failed now and then (reviewCopies.test.ts, "two
// reviews at once"). The queue's rules with changes held open by the test, then git() putting real worktree changes
// in it; conditions, never time.
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { changesWorktrees, git, gitErrorLine, gitTestHooks, oneWorktreeChange, worktreeChangesPending } from '../src/main/git'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

/** A change the test ends: `started` once it runs, `end` (or `fail`) to settle it. */
function held(log: string[], name: string): { fn: () => Promise<string>; started: () => boolean; end: () => void; fail: () => void } {
  let ran = false
  let settle: { ok: (v: string) => void; no: (e: Error) => void } | undefined
  const fn = (): Promise<string> => {
    ran = true
    log.push(`start ${name}`)
    return new Promise<string>((ok, no) => (settle = { ok, no })).finally(() => log.push(`end ${name}`))
  }
  return { fn, started: () => ran, end: () => settle!.ok(name), fail: () => settle!.no(new Error(`${name} failed`)) }
}

/** Lets every queued step run: a change that could start has started. */
const settled = (): Promise<void> => new Promise((r) => setImmediate(r))

afterEach(() => {
  gitTestHooks.started = undefined
})

describe('one worktree change at a time per repository (HI-2322)', () => {
  it('the next change starts only once the one before it has ended, ended well or not', async () => {
    const log: string[] = []
    const a = held(log, 'a')
    const b = held(log, 'b')
    const c = held(log, 'c')
    const pa = oneWorktreeChange('D:\\Repo', a.fn)
    const pb = oneWorktreeChange('D:\\Repo', b.fn)
    const pc = oneWorktreeChange('D:\\Repo', c.fn)
    await settled()
    expect([a.started(), b.started(), c.started()]).toEqual([true, false, false])
    a.fail()
    await expect(pa).rejects.toThrow('a failed')
    await settled()
    expect([b.started(), c.started()]).toEqual([true, false])
    b.end()
    expect(await pb).toBe('b')
    await settled()
    expect(c.started()).toBe(true)
    c.end()
    expect(await pc).toBe('c')
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    await settled()
    expect(worktreeChangesPending()).toBe(0)
  })

  it('the same repository however its folder is written; another repository runs alongside', async () => {
    const log: string[] = []
    const a = held(log, 'a')
    const same = held(log, 'same')
    const other = held(log, 'other')
    void oneWorktreeChange('D:\\Work\\Repo', a.fn)
    void oneWorktreeChange('d:/work/repo/', same.fn)
    void oneWorktreeChange('D:\\Work\\Other', other.fn)
    await settled()
    expect([a.started(), same.started(), other.started()]).toEqual([true, false, true])
    a.end()
    other.end()
    await settled()
    expect(same.started()).toBe(true)
    same.end()
    await settled()
    expect(worktreeChangesPending()).toBe(0)
  })

  it('what counts as a change: add, remove, prune, move, repair; never list or any other command', () => {
    for (const sub of ['add', 'remove', 'prune', 'move', 'repair', 'lock', 'unlock']) expect(changesWorktrees(['worktree', sub]), sub).toBe(true)
    expect(changesWorktrees(['worktree', 'list', '--porcelain'])).toBe(false)
    expect(changesWorktrees(['worktree'])).toBe(false)
    expect(changesWorktrees(['status', 'worktree'])).toBe(false)
  })

  it("git()'s worktree changes in a repository queue: none starts before the one before it has ended, and all are made", async () => {
    const repo = gitRepo(join(tempDir('worktree-changes-'), 'project'))
    const rev = commit(repo, { 'a.ts': 'export const a = 1\n' }, 'first')
    const copies = join(repo, '..', 'copies')
    // A change is running from its git's start (the hook) until its call has ended; one starting while another runs overlaps.
    let running = 0
    const overlaps: string[] = []
    gitTestHooks.started = (_cwd, args) => {
      if (!changesWorktrees(args)) return
      if (running > 0) overlaps.push(args.join(' '))
      running++
    }
    const change = (args: string[]) => git(repo, args).finally(() => running--)
    const made = await Promise.all([1, 2, 3, 4].flatMap((n) => [change(['worktree', 'prune']), change(['worktree', 'add', '--detach', join(copies, `copy-${n}`), rev])]))
    expect(overlaps).toEqual([])
    expect(made.map((r) => r.ok)).toEqual(Array(8).fill(true))
    expect(sh(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(5)
    expect(worktreeChangesPending()).toBe(0)
  })
})

describe("git's reason for a failure (HI-2322)", () => {
  it('its fatal or error line, not the progress line before it; else its first line', () => {
    expect(gitErrorLine('Preparing worktree (detached HEAD 2c30cd0)\nfatal: failed to read .git/worktrees/copy-1/commondir: No error\n')).toBe('fatal: failed to read .git/worktrees/copy-1/commondir: No error')
    expect(gitErrorLine('error: pathspec x did not match\nhint: try y')).toBe('error: pathspec x did not match')
    expect(gitErrorLine('something went wrong\nsecond line')).toBe('something went wrong')
    expect(gitErrorLine('')).toBe('')
  })
})
