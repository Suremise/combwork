// The Changes tab's comparison of two branches (gitCompare.ts, HI-1824): an integration line against main in a fixture
// repository, read with git only, nothing changed. What can be compared (the local branches, main, the project's
// integration line), how many commits each side has that the other hasn't and a page of them, the files the branch
// changes since it left the other, one file's diff, and a branch that isn't one refused. The repository's refs, index
// and working tree are the same before and after.
import { execFileSync } from 'child_process'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import { compareBranches, compareDiff, compareLines } from '../src/main/gitCompare'
import { COMPARE_COMMITS } from '../src/shared/gitRepo'

/** main with one commit of its own after 1.0.0 left it; 1.0.0 with `n` commits, changing, adding and deleting a file. */
function fixture(n: number): string {
  const repo = gitRepo(join(tempDir('gitcompare-'), 'repo'))
  sh(repo, 'branch', '1.0.0')
  commit(repo, { 'main-only.txt': 'main\n' }, 'on main')
  sh(repo, 'checkout', '-q', '1.0.0')
  commit(repo, { 'src/a.txt': 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n', 'new.txt': 'new\n' }, 'change a, add new')
  sh(repo, 'rm', '-q', 'README.md')
  sh(repo, 'commit', '-q', '-m', 'drop readme')
  // Back on main, with something uncommitted: the comparison neither reads nor touches it.
  sh(repo, 'checkout', '-q', 'main')
  // The rest of 1.0.0's commits in one git fast-import (HI-1936: a long branch's 58 commits made one at a time were over
  // a hundred git processes, slow enough under load to reach the time limit), each a second after the one before, so
  // newest first is their order.
  if (n > 2) {
    const t = Math.floor(Date.now() / 1000) + 1
    const commits = Array.from({ length: n - 2 }, (_, k) => {
      const msg = `commit ${k + 2}`
      const file = `${k + 2}\n`
      const when = `<test@hive.invalid> ${t + k} +0000`
      return ['commit refs/heads/1.0.0', `author Hive Test ${when}`, `committer Hive Test ${when}`, `data ${Buffer.byteLength(msg)}`, msg, ...(k === 0 ? [`from ${sh(repo, 'rev-parse', '1.0.0')}`] : []), 'M 100644 inline count.txt', `data ${Buffer.byteLength(file)}`, file].join('\n')
    })
    execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: `${commits.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  writeFileSync(join(repo, 'src', 'a.txt'), 'edited, not committed\n')
  return repo
}

/** What the comparison must leave as it was: every ref, the index (its bytes and time), the status. */
function state(repo: string): { refs: string; index: string; mtime: number; status: string } {
  const index = join(repo, '.git', 'index')
  return { refs: sh(repo, 'for-each-ref'), index: readFileSync(index).toString('base64'), mtime: statSync(index).mtimeMs, status: sh(repo, '--no-optional-locks', 'status', '--porcelain') }
}

describe('compareLines: what the Changes tab can compare', () => {
  it('every local branch, main, and the integration line when it is a local branch other than main', async () => {
    const repo = fixture(3)
    sh(repo, 'worktree', 'add', '-q', join(repo, '..', 'slot-a'), '-b', 'cw/card')
    const lines = await compareLines(repo, '1.0.0')
    expect(lines.isRepo).toBe(true)
    expect(lines.main).toBe('main')
    expect(lines.integration).toBe('1.0.0')
    expect(lines.branches.map((b) => b.name)).toEqual(['1.0.0', 'cw/card', 'main'])
    // The folder a branch is checked out in, as git says it (a slot's, the project's).
    expect(lines.branches.find((b) => b.name === 'cw/card')?.folder?.toLowerCase()).toBe(join(repo, '..', 'slot-a').replace(/\\/g, '/').toLowerCase())
    // No integration line: the target is main itself, isn't set, or isn't a branch here.
    expect((await compareLines(repo, 'main')).integration).toBeNull()
    expect((await compareLines(repo, null)).integration).toBeNull()
    expect((await compareLines(repo, 'gone')).integration).toBeNull()
  })

  it("each slot whose folder has a branch, with its lease's card (a blocked card's slot, a free one), never one without", async () => {
    const repo = fixture(3)
    const slot = (name: string) => join(repo, '..', name)
    sh(repo, 'worktree', 'add', '-q', slot('slot-a'), '-b', 'cw/HI/HI-1-a')
    sh(repo, 'worktree', 'add', '-q', slot('slot-c'), '-b', 'cw/HI/HI-1758-blocked')
    sh(repo, 'worktree', 'add', '-q', '--detach', slot('slot-d'))
    const records = [
      { name: 'slot-a', folder: slot('slot-a'), card: null, agent: null, target: null },
      // slot-c's case (HI-1823): lent to a card that is blocked, its agent elsewhere.
      { name: 'slot-c', folder: slot('slot-c'), card: 1758, agent: 'a-hb3', target: '1.0.0' },
      { name: 'slot-d', folder: slot('slot-d'), card: null, agent: null, target: null },
      { name: 'slot-e', folder: slot('slot-e'), card: null, agent: null, target: null }
    ]
    const lines = await compareLines(repo, '1.0.0', records)
    expect(lines.slots).toEqual([
      { name: 'slot-a', folder: slot('slot-a'), branch: 'cw/HI/HI-1-a', card: null, agent: null, target: null },
      { name: 'slot-c', folder: slot('slot-c'), branch: 'cw/HI/HI-1758-blocked', card: 1758, agent: 'a-hb3', target: '1.0.0' }
    ])
  })

  it('a folder that is no repository says so', async () => {
    const lines = await compareLines(tempDir('gitcompare-none-'), '1.0.0')
    expect(lines).toMatchObject({ isRepo: false, branches: [], main: null, integration: null })
  })
})

describe('compareBranches and compareDiff: 1.0.0 against main', () => {
  it('ahead and behind, each side its commits, the files 1.0.0 changes since it left main, and a diff, with nothing changed', async () => {
    const repo = fixture(4)
    const before = state(repo)
    const c = await compareBranches(repo, 'main', '1.0.0')
    expect(c).toMatchObject({ base: 'main', head: '1.0.0', ahead: 4, behind: 1, page: 1, pages: 1, filesTotal: 4 })
    expect(c.mergeBase).toBe(sh(repo, 'merge-base', 'main', '1.0.0'))
    expect(c.aheadCommits.map((x) => x.subject)).toEqual(['commit 3', 'commit 2', 'drop readme', 'change a, add new'])
    expect(c.behindCommits.map((x) => x.subject)).toEqual(['on main'])
    // Since it left main: not main's own file.
    expect(c.files).toEqual([
      { path: 'README.md', status: 'D' },
      { path: 'count.txt', status: 'A' },
      { path: 'new.txt', status: 'A' },
      { path: 'src/a.txt', status: 'M' }
    ])
    // A file as it was where 1.0.0 left main, against 1.0.0's: the committed change, never the working tree's edit.
    const d = await compareDiff(repo, 'main', '1.0.0', 'src/a.txt')
    expect(d.binary).toBe(false)
    expect(d.original).toContain('\ntwo\n')
    expect(d.modified).toContain('\nTWO\n')
    expect(await compareDiff(repo, 'main', '1.0.0', 'new.txt')).toMatchObject({ original: '', modified: 'new\n' })
    expect(await compareDiff(repo, 'main', '1.0.0', 'README.md')).toMatchObject({ original: 'hello\n', modified: '' })
    // The other way round: main's one commit and file.
    const back = await compareBranches(repo, '1.0.0', 'main')
    expect(back).toMatchObject({ ahead: 1, behind: 4, files: [{ path: 'main-only.txt', status: 'A' }] })
    expect(state(repo)).toEqual(before)
  })

  it('a long branch: its commits a page at a time, the counts whole', async () => {
    const repo = fixture(COMPARE_COMMITS + 10)
    const first = await compareBranches(repo, 'main', '1.0.0')
    expect(first).toMatchObject({ ahead: COMPARE_COMMITS + 10, page: 1, pages: 2 })
    expect(first.aheadCommits).toHaveLength(COMPARE_COMMITS)
    const second = await compareBranches(repo, 'main', '1.0.0', 2)
    // Newest first: commit 59 to commit 10 on the first page, the rest on the second.
    expect(second.aheadCommits.map((x) => x.subject)).toEqual(['commit 9', 'commit 8', 'commit 7', 'commit 6', 'commit 5', 'commit 4', 'commit 3', 'commit 2', 'drop readme', 'change a, add new'])
    // Past the last page: the last.
    expect((await compareBranches(repo, 'main', '1.0.0', 99)).page).toBe(2)
    // 1.0.0 moves on: the next page of the first comparison (its commits pinned) is still of that state.
    const other = join(repo, '..', 'other')
    sh(repo, 'worktree', 'add', '-q', other, '1.0.0')
    commit(other, { 'later.txt': 'later\n' }, 'later')
    const pinned = await compareBranches(repo, 'main', '1.0.0', 2, { base: first.baseCommit, head: first.headCommit })
    expect(pinned).toMatchObject({ ahead: COMPARE_COMMITS + 10, headCommit: first.headCommit, filesTotal: first.filesTotal })
    expect(pinned.aheadCommits.map((x) => x.subject)).toEqual(second.aheadCommits.map((x) => x.subject))
    // Unpinned (a refresh): the branch as it is now.
    expect((await compareBranches(repo, 'main', '1.0.0', 2)).ahead).toBe(COMPARE_COMMITS + 11)
  })

  it("a file's diff is of the comparison's own commits, though the branch has moved since", async () => {
    const repo = fixture(3)
    const c = await compareBranches(repo, 'main', '1.0.0')
    expect(c.headCommit).toBe(sh(repo, 'rev-parse', '1.0.0'))
    expect(c.baseCommit).toBe(sh(repo, 'rev-parse', 'main'))
    // 1.0.0 moves on in a folder of its own: new.txt changes there.
    const other = join(repo, '..', 'other')
    sh(repo, 'worktree', 'add', '-q', other, '1.0.0')
    commit(other, { 'new.txt': 'moved on\n' }, 'later')
    const pinned = { base: c.baseCommit, head: c.headCommit }
    expect(await compareDiff(repo, 'main', '1.0.0', 'new.txt', pinned)).toMatchObject({ original: '', modified: 'new\n' })
    // Without its commits (or with ids that aren't commits here): the branches as they are now.
    expect(await compareDiff(repo, 'main', '1.0.0', 'new.txt')).toMatchObject({ modified: 'moved on\n' })
    expect(await compareDiff(repo, 'main', '1.0.0', 'new.txt', { base: '0'.repeat(40), head: 'HEAD' })).toMatchObject({ modified: 'moved on\n' })
  })

  it("refuses a branch that isn't one, and never takes a name as an option", async () => {
    const repo = fixture(3)
    const before = state(repo)
    await expect(compareBranches(repo, 'main', 'nope')).rejects.toThrow(/no branch nope/)
    await expect(compareBranches(repo, '--output=x', '1.0.0')).rejects.toThrow(/no branch --output=x/)
    await expect(compareDiff(repo, 'main', 'HEAD~1', 'src/a.txt')).rejects.toThrow(/no branch HEAD~1/)
    expect(state(repo)).toEqual(before)
  })
})
