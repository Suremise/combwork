// HI-2322: one change to a repository's worktrees at a time (src/main/git.ts, oneWorktreeChange). Git reads every
// worktree's entry as it adds one and fails on one another add has made but not yet written ("fatal: failed to read
// .git/worktrees/copy-1/commondir"), so two review copies made at once failed now and then (reviewCopies.test.ts, "two
// reviews at once"). The queue's rules with changes held open by the test, then git() putting real worktree changes
// in it; conditions, never time. HI-2349: a git this process can't queue (another Combwork, an agent's or the user's own)
// leaves such an entry for a moment: git() runs the change again once it's written.
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { changesWorktrees, git, gitErrorLine, gitTestHooks, halfMadeEntry, oneWorktreeChange, worktreeChangesPending, worktreeQueueKey, worktreeRetry } from '../src/main/git'
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
  gitTestHooks.ended = undefined
})

/** Watches git's worktree changes from their git's start to its end: each one that started while another ran. */
function overlapping(): string[] {
  let running = 0
  const overlaps: string[] = []
  gitTestHooks.started = (_cwd, args) => {
    if (!changesWorktrees(args)) return
    if (running > 0) overlaps.push(args.join(' '))
    running++
  }
  gitTestHooks.ended = (_cwd, args) => {
    if (changesWorktrees(args)) running--
  }
  return overlaps
}

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
    const overlaps = overlapping()
    const change = (args: string[]) => git(repo, args)
    const made = await Promise.all([1, 2, 3, 4].flatMap((n) => [change(['worktree', 'prune']), change(['worktree', 'add', '--detach', join(copies, `copy-${n}`), rev])]))
    expect(overlaps).toEqual([])
    expect(made.map((r) => r.ok)).toEqual(Array(8).fill(true))
    expect(sh(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(5)
    expect(worktreeChangesPending()).toBe(0)
  })
})

describe("the queue's repository: a checkout and its linked worktrees are one (HI-2322, HR1's round 1)", () => {
  /** A repository, a linked worktree of it, a junction to it, and another repository. */
  function repos(): { main: string; linked: string; alias: string; other: string } {
    const dir = tempDir('worktree-repos-')
    const main = gitRepo(join(dir, 'main'))
    commit(main, { 'a.ts': 'export const a = 1\n' }, 'first')
    const linked = join(dir, 'linked')
    sh(main, 'worktree', 'add', '-q', '--detach', linked)
    const alias = join(dir, 'alias')
    symlinkSync(main, alias, 'junction')
    const other = gitRepo(join(dir, 'other'))
    return { main, linked, alias, other }
  }

  it("one key for the checkout, its linked worktree and a junction to it, as git's common dir; another repository's differs", async () => {
    const r = repos()
    const key = await worktreeQueueKey(r.main)
    expect(key).toBe(realpathSync.native(sh(r.main, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toLowerCase())
    expect(await worktreeQueueKey(r.linked)).toBe(key)
    expect(await worktreeQueueKey(r.alias)).toBe(key)
    expect(await worktreeQueueKey(`${r.linked.toUpperCase()}\\`)).toBe(key)
    expect(await worktreeQueueKey(r.other)).not.toBe(key)
  })

  it("a change held in the checkout holds the linked worktree's; another repository's runs alongside; the queue goes after a failure", async () => {
    const r = repos()
    const log: string[] = []
    const inMain = held(log, 'main')
    const inLinked = held(log, 'linked')
    const inOther = held(log, 'other')
    const pm = oneWorktreeChange(await worktreeQueueKey(r.main), inMain.fn)
    const pl = oneWorktreeChange(await worktreeQueueKey(r.linked), inLinked.fn)
    const po = oneWorktreeChange(await worktreeQueueKey(r.other), inOther.fn)
    await settled()
    expect([inMain.started(), inLinked.started(), inOther.started()]).toEqual([true, false, true])
    inMain.fail()
    await expect(pm).rejects.toThrow('main failed')
    await settled()
    expect(inLinked.started()).toBe(true)
    inLinked.end()
    inOther.end()
    expect(await Promise.all([pl, po])).toEqual(['linked', 'other'])
    await settled()
    expect(worktreeChangesPending()).toBe(0)
  })

  it("git()'s worktree changes from the checkout and its linked worktree queue together, and are all made", async () => {
    const r = repos()
    const rev = sh(r.main, 'rev-parse', 'HEAD')
    const overlaps = overlapping()
    const change = (cwd: string, args: string[]) => git(cwd, args)
    const copies = join(r.main, '..', 'copies')
    const made = await Promise.all([1, 2, 3, 4].flatMap((n) => {
      const from = n % 2 ? r.main : r.linked
      return [change(from, ['worktree', 'prune']), change(from, ['worktree', 'add', '--detach', join(copies, `copy-${n}`), rev])]
    }))
    expect(overlaps).toEqual([])
    expect(made.map((m) => m.ok)).toEqual(Array(8).fill(true))
    expect(sh(r.main, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(6)
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

describe("another git's half-made entry: the change runs again once it's written (HI-2349)", () => {
  const defaults = { ...worktreeRetry }
  afterEach(() => Object.assign(worktreeRetry, defaults))

  /** A repository with a half-made entry in it, as another git's `worktree add` leaves it for a moment: commondir created, empty. */
  function withHalfEntry(): { repo: string; rev: string; entry: string; dir: string } {
    const dir = tempDir('worktree-half-')
    const repo = gitRepo(join(dir, 'project'))
    const rev = commit(repo, { 'a.ts': 'export const a = 1\n' }, 'first')
    const entry = join(repo, '.git', 'worktrees', 'other')
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'gitdir'), `${join(dir, 'other', '.git').replace(/\\/g, '/')}\n`)
    writeFileSync(join(entry, 'locked'), 'initializing\n')
    writeFileSync(join(entry, 'commondir'), '')
    return { repo, rev, entry, dir }
  }

  /** The worktree commands git ran, and `then` run once after the first of them ends (the other git finishing its entry). */
  function tries(then: () => void): string[][] {
    const ran: string[][] = []
    gitTestHooks.started = (_cwd, args) => changesWorktrees(args) && ran.push([...args])
    gitTestHooks.ended = (_cwd, args) => changesWorktrees(args) && ran.length === 1 && then()
    return ran
  }

  it("names the entry git failed on, as git wrote its path; nothing for any other failure", () => {
    expect(halfMadeEntry('Preparing worktree (detached HEAD 2c30cd0)\nfatal: failed to read .git/worktrees/copy-1/commondir: No error\n')).toBe('.git/worktrees/copy-1/commondir')
    expect(halfMadeEntry('fatal: failed to read D:/Work/My Repo/.git/worktrees/slot-a/commondir: No error')).toBe('D:/Work/My Repo/.git/worktrees/slot-a/commondir')
    expect(halfMadeEntry("fatal: 'D:/x' is a missing but already registered worktree")).toBeNull()
    expect(halfMadeEntry('fatal: failed to read object 2c30cd0: Invalid argument')).toBeNull()
  })

  it('it fails on the entry, so git() runs it again once the other git has written it, and the worktree is made', async () => {
    const h = withHalfEntry()
    expect(sh(h.repo, 'rev-parse', 'HEAD')).toBe(h.rev)
    const ran = tries(() => writeFileSync(join(h.entry, 'commondir'), '../..\n'))
    const folder = join(h.dir, 'copy-1')
    const r = await git(h.repo, ['worktree', 'add', '--detach', folder, h.rev])
    expect(r.ok, r.err).toBe(true)
    expect(ran).toHaveLength(2)
    expect(sh(folder, 'rev-parse', 'HEAD')).toBe(h.rev)
  })

  it("an add -b runs again as an add of the branch its first try made, and that branch is the worktree's, at its base", async () => {
    const h = withHalfEntry()
    const ran = tries(() => rmSync(h.entry, { recursive: true }))
    const folder = join(h.dir, 'wt')
    const r = await git(h.repo, ['worktree', 'add', '-b', 'hive/feature', folder, h.rev])
    expect(r.ok, r.err).toBe(true)
    expect(ran).toEqual([['worktree', 'add', '-b', 'hive/feature', folder, h.rev], ['worktree', 'add', folder, 'hive/feature']])
    expect(sh(folder, 'symbolic-ref', 'HEAD')).toBe('refs/heads/hive/feature')
    expect(sh(folder, 'rev-parse', 'HEAD')).toBe(h.rev)
  })

  it('a remove too: it changed nothing on its first try, and removes the worktree on its second', async () => {
    const h = withHalfEntry()
    const folder = join(h.dir, 'gone')
    writeFileSync(join(h.entry, 'commondir'), '../..\n')
    sh(h.repo, 'worktree', 'add', '-q', '--detach', folder)
    writeFileSync(join(h.entry, 'commondir'), '')
    const ran = tries(() => rmSync(h.entry, { recursive: true }))
    const r = await git(h.repo, ['worktree', 'remove', folder])
    expect(r.ok, r.err).toBe(true)
    expect(ran).toHaveLength(2)
    expect(existsSync(folder)).toBe(false)
  })

  it("an entry still empty after the wait (a crashed git's) isn't waited for again: git's failure is the answer", async () => {
    const h = withHalfEntry()
    worktreeRetry.waitMs = 50
    const ran = tries(() => undefined)
    const r = await git(h.repo, ['worktree', 'add', '--detach', join(h.dir, 'copy-1'), h.rev])
    expect(r.ok).toBe(false)
    expect(gitErrorLine(r.err)).toMatch(/^fatal: failed to read .*worktrees[\\/]other[\\/]commondir/)
    expect(ran).toHaveLength(1)
    expect(worktreeChangesPending()).toBe(0)
  })

  it('at most worktreeRetry.times more tries, however many half-made entries come', async () => {
    const h = withHalfEntry()
    worktreeRetry.times = 2
    // Each try meets a new half-made entry, which the other git then writes.
    const ran: string[][] = []
    gitTestHooks.started = (_cwd, args) => changesWorktrees(args) && ran.push([...args])
    gitTestHooks.ended = (_cwd, args) => {
      if (!changesWorktrees(args)) return
      writeFileSync(join(h.entry, 'commondir'), '../..\n')
      const next = join(h.repo, '.git', 'worktrees', `other-${ran.length}`)
      mkdirSync(next, { recursive: true })
      writeFileSync(join(next, 'gitdir'), `${join(h.dir, `other-${ran.length}`, '.git').replace(/\\/g, '/')}\n`)
      writeFileSync(join(next, 'commondir'), '')
      h.entry = next
    }
    const r = await git(h.repo, ['worktree', 'add', '--detach', join(h.dir, 'copy-1'), h.rev])
    expect(r.ok).toBe(false)
    expect(ran).toHaveLength(3)
  })
})
