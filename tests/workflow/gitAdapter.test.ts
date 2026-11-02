// The Git adapter's answers on real repositories (#1118, SPEC §16.3.2): fixed endpoints, sameness by replay with the
// candidate key only as a first test, containment of a merge, a fast-forward and a squash.
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { commit, gitRepo, sh } from './harness'
import * as G from '../../src/main/platform/git'
import { isUnknown } from '../../src/main/platform/types'
import { gitTestHooks } from '../../src/main/git'

let repo = ''
afterEach(() => {
  repo = ''
  gitTestHooks.started = undefined
})

/** The git commands `fn` starts, each as its words. */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; ran: string[] }> {
  const ran: string[] = []
  gitTestHooks.started = (_cwd, args) => {
    ran.push(args.join(' '))
  }
  try {
    return { value: await fn(), ran }
  } finally {
    gitTestHooks.started = undefined
  }
}

/** A change on a branch from main's head: [base, revision]. */
function branchWith(name: string, files: Record<string, string>): [string, string] {
  sh(repo, 'checkout', '-q', '-b', name, 'main')
  const base = sh(repo, 'rev-parse', 'main')
  const rev = commit(repo, files, name)
  sh(repo, 'checkout', '-q', 'main')
  return [base, rev]
}

describe('Git adapter', () => {
  it('a clean rebase onto a target that changed other files is the same change (S30)', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [b1, r1] = branchWith('card', { 'src/a.txt': 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' })
    // The target moves: another file, and a line within three lines of the card's (the patch's context).
    const b2 = commit(repo, { 'other.txt': 'x\n', 'src/a.txt': 'one\ntwo\nthree\nfour\nFIVE\nsix\nseven\neight\nnine\nten\n' }, 'target moves')
    sh(repo, 'checkout', '-q', 'card')
    sh(repo, 'rebase', '-q', 'main')
    const r2 = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', 'main')
    expect(r2).not.toBe(r1)
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: r2 })).toBe(true)
    // Why the key is taken with no context lines: with git's default three, the target's change beside the card's
    // gives the clean rebase another patch-id, and a first test that rules changes out would call it another change.
    const withContext = (a: string, b: string) => execFileSync('git', ['patch-id', '--stable'], { cwd: repo, input: sh(repo, 'diff', a, b) + '\n', encoding: 'utf8' }).split(' ')[0]
    expect(withContext(b1, r1)).not.toBe(withContext(b2, r2))
    expect(await G.candidateKey(repo, b1, r1)).toBe(await G.candidateKey(repo, b2, r2))
  })

  it('whitespace, a file mode, a binary and a moved edit are not the same change, though patch-id may say so (S30)', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    commit(repo, { 'p.py': 'def f():\n    return 1\n\ndef g():\n    return 1\n', 'bin.dat': Buffer.from([0, 1, 2]).toString('latin1') }, 'setup')
    const base = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', '-b', 'card')
    const r1 = commit(repo, { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 1\n', 'add.py': 'if x:\n    y = 1\n' }, 'card')
    // Whitespace only in an added line: patch-id is equal (it ignores whitespace), the replay's tree differs.
    sh(repo, 'checkout', '-q', '-b', 'ws', base)
    const ws = commit(repo, { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 1\n', 'add.py': 'if x:\n  y = 1\n' }, 'card')
    expect(await G.candidateKey(repo, base, ws)).toBe(await G.candidateKey(repo, base, r1))
    expect(await G.sameChange(repo, { base, revision: r1 }, { base, revision: ws })).toBe(false)
    // The edit moved from the first of two identical blocks to the second.
    sh(repo, 'checkout', '-q', '-b', 'moved', base)
    const mv = commit(repo, { 'p.py': 'def f():\n    return 1\n\ndef g():\n    return 2\n', 'add.py': 'if x:\n    y = 1\n' }, 'card')
    expect(await G.sameChange(repo, { base, revision: r1 }, { base, revision: mv })).toBe(false)
    // A file mode change on top.
    sh(repo, 'checkout', '-q', 'card')
    sh(repo, 'update-index', '--chmod=+x', 'add.py')
    sh(repo, 'commit', '-q', '-m', 'mode')
    const mode = sh(repo, 'rev-parse', 'HEAD')
    expect(await G.sameChange(repo, { base, revision: r1 }, { base, revision: mode })).toBe(false)
    // A binary file changed.
    sh(repo, 'checkout', '-q', '-b', 'bin', r1)
    const bin = commit(repo, { 'bin.dat': Buffer.from([0, 1, 3]).toString('latin1') }, 'binary')
    expect(await G.sameChange(repo, { base, revision: r1 }, { base, revision: bin })).toBe(false)
  })

  it('on a new base with an equal key, the replay decides: whitespace and a moved edit are other changes; a hunk split with other content differs by key (S30)', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    commit(repo, { 'p.py': 'def f():\n    return 1\n\ndef g():\n    return 1\n' }, 'setup')
    const b1 = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'checkout', '-q', '-b', 'card')
    const r1 = commit(repo, { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 1\n', 'add.py': 'if x:\n    y = 1\n' }, 'card')
    sh(repo, 'checkout', '-q', 'main')
    const b2 = commit(repo, { 'other.txt': 'target moved\n' }, 'target')
    const on = (name: string, files: Record<string, string>) => {
      sh(repo, 'checkout', '-q', '-b', name, b2)
      const r = commit(repo, files, name)
      sh(repo, 'checkout', '-q', 'main')
      return r
    }
    // The clean rebase: same change.
    const clean = on('clean', { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 1\n', 'add.py': 'if x:\n    y = 1\n' })
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: clean })).toBe(true)
    // Whitespace in the added line: an equal key, a different replay.
    const ws = on('ws', { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 1\n', 'add.py': 'if x:\n  y = 1\n' })
    expect(await G.candidateKey(repo, b2, ws)).toBe(await G.candidateKey(repo, b1, r1))
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: ws })).toBe(false)
    // The edit moved to the second identical block: an equal key, a different replay.
    const moved = on('moved', { 'p.py': 'def f():\n    return 1\n\ndef g():\n    return 2\n', 'add.py': 'if x:\n    y = 1\n' })
    expect(await G.candidateKey(repo, b2, moved)).toBe(await G.candidateKey(repo, b1, r1))
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: moved })).toBe(false)
    // Hunks split differently, with other content: another key, ruled out at once.
    const split = on('split', { 'p.py': 'def f():\n    return 2\n\ndef g():\n    return 3\n', 'add.py': 'if x:\n    y = 1\n' })
    expect(await G.candidateKey(repo, b2, split)).not.toBe(await G.candidateKey(repo, b1, r1))
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: split })).toBe(false)
  })

  it('a conflicted rebase whose resolution differs is another change; one resolving to the replay is the same (S10)', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [b1, r1] = branchWith('card', { 'src/a.txt': 'one\nCARD\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' })
    // The target changes the line next to the card's: git's merge conflicts.
    const b2 = commit(repo, { 'src/a.txt': 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'target')
    expect(await G.replayTree(repo, b1, b2, r1)).toBeNull()
    // Resolved by hand with something else.
    sh(repo, 'checkout', '-q', '-b', 'resolved', b2)
    const other = commit(repo, { 'src/a.txt': 'one\nCARD!\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'resolved')
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: other })).toBe(false)
    // A resolution that gives exactly what a replay would (here the replay conflicts, so nothing can: not the same).
    const exact = commit(repo, { 'src/a.txt': 'one\nCARD\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n' }, 'resolved exactly')
    expect(await G.sameChange(repo, { base: b1, revision: r1 }, { base: b2, revision: exact })).toBe(false)
  })

  it('containment finds a merge, a fast-forward and a squash, and an empty answer for a change not there', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [b1, r1] = branchWith('one', { 'one.txt': '1\n' })
    const [b2, r2] = branchWith('two', { 'two.txt': '2\n' })
    const [b3, r3] = branchWith('three', { 'three.txt': '3\n' })
    expect(await G.contains(repo, 'main', { base: b1, revision: r1 })).toBeNull()
    sh(repo, 'merge', '-q', '--ff-only', 'one')
    expect(await G.contains(repo, 'main', { base: b1, revision: r1 })).toEqual({ method: 'fastForward' })
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'merge two', 'two')
    expect(await G.contains(repo, 'main', { base: b2, revision: r2 })).toEqual({ method: 'merge' })
    sh(repo, 'merge', '-q', '--squash', 'three')
    sh(repo, 'commit', '-q', '-m', 'squash three')
    sh(repo, 'branch', '-q', '-D', 'three')
    expect(await G.contains(repo, 'main', { base: b3, revision: r3 })).toMatchObject({ method: 'squash' })
  })

  it("containment asked at a head already read looks there, not again at the target; an empty change's key lists no commits (#1376)", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [b1, r1] = branchWith('one', { 'one.txt': '1\n' })
    const before = sh(repo, 'rev-parse', 'main')
    sh(repo, 'merge', '-q', '--squash', 'one')
    sh(repo, 'commit', '-q', '-m', 'squash one')
    const after = sh(repo, 'rev-parse', 'main')
    // At main's earlier head the squash isn't there yet, though main has it now; no git reads main itself.
    const at = await counted(() => G.contains(repo, 'main', { base: b1, revision: r1 }, before))
    expect(at.value).toBeNull()
    expect(at.ran.filter((c) => c.includes('main'))).toEqual([])
    expect(await G.contains(repo, 'main', { base: b1, revision: r1 }, after)).toMatchObject({ method: 'squash' })
    // With no key (an empty change), no target commit can have it: the squash search isn't run, the whole target still is.
    const none = await counted(() => G.contains(repo, 'main', { base: b1, revision: r1, key: null }, after))
    expect(none.value).toEqual({ method: 'sameTree' })
    expect(none.ran.filter((c) => c.startsWith('log ') || c.startsWith('patch-id '))).toEqual([])
  })

  it("heads answers the branch, head and a line's head in one git, as branch, head and lineHead do; each on its own where it can't (#1376)", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [, side] = branchWith('side', { 's.txt': 's\n' })
    const main = sh(repo, 'rev-parse', 'main')
    const one = await counted(() => G.heads(repo, 'side'))
    expect(one.value).toEqual({ line: 'main', head: main, target: side })
    expect(one.ran).toHaveLength(1)
    // Detached: no branch.
    sh(repo, 'checkout', '-q', '--detach', 'side')
    expect(await G.heads(repo, 'main')).toEqual({ line: null, head: side, target: main })
    sh(repo, 'checkout', '-q', 'main')
    // No such line: asked on its own, null as lineHead says.
    expect(await G.heads(repo, 'gone')).toEqual({ line: 'main', head: main, target: null })
    // A branch with a slash, in a linked worktree (its lines are the project's).
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'hive/card', wt, 'side')
    expect(await G.heads(wt, 'main')).toEqual({ line: 'hive/card', head: side, target: main })
    // No commit yet: head unknown, as head() says.
    const empty = join(tempDir('git-'), 'e')
    execFileSync('git', ['init', '-q', '-b', 'main', empty])
    const e = await G.heads(empty, 'main')
    expect(e.line).toBe('main')
    expect(e.target).toBeNull()
    expect(isUnknown(e.head)).toBe(true)
  })

  it('an answer about fixed commits is asked once in a step (#1376) and kept after it (HI-2115); refs are read again; names and unknowns always asked', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [base, rev] = branchWith('one', { 'one.txt': '1\n' })
    const ancestors = (ran: string[]) => ran.filter((c) => c.startsWith('merge-base --is-ancestor')).length
    const twice = async () => [await G.isAncestor(repo, base, rev), await G.isAncestor(repo, base, rev), await G.mergeBase(repo, base, rev), await G.mergeBase(repo, base, rev), await G.lineHead(repo, 'one'), await G.lineHead(repo, 'one')]
    // Outside a step: kept once asked, for as long as Hive runs (HI-2115: its own tests are gitStarts.test.ts).
    const outside = await counted(twice)
    expect(ancestors(outside.ran)).toBe(1)
    G.forgetKeptAnswers()
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'one')
    let leaked: (() => Promise<unknown>) | null = null
    const inside = await counted(() =>
      G.gitStep(async () => {
        leaked = () => G.isAncestor(repo, base, rev)
        // A linked worktree of the project asks about the same commits (in a step inside the step): the same answer.
        return [...(await twice()), await G.gitStep(() => G.isAncestor(wt, base, rev))]
      })
    )
    expect(inside.value).toEqual([...outside.value, true])
    expect(ancestors(inside.ran)).toBe(1)
    // A subfolder, whose repository its own `.git` doesn't say: asked each time.
    const sub = await counted(() => G.gitStep(async () => [await G.isAncestor(join(repo, 'src'), base, rev), await G.isAncestor(join(repo, 'src'), base, rev)]))
    expect(sub.value).toEqual([true, true])
    expect(ancestors(sub.ran)).toBe(2)
    expect(inside.ran.filter((c) => c === `merge-base ${base} ${rev}`)).toHaveLength(1)
    // A line's head is read from its ref file each time, with no git (#1491): its own test below.
    expect(inside.ran.filter((c) => c.startsWith('rev-parse --verify'))).toHaveLength(0)
    // Something the step set off, asking once it has ended: the answer kept (HI-2115), no git.
    expect(ancestors((await counted(() => leaked!())).ran)).toBe(0)
    // Names, not ids, are never kept; nor an unknown answer.
    const names = await counted(() => G.gitStep(async () => [await G.isAncestor(repo, 'main', 'one'), await G.isAncestor(repo, 'main', 'one')]))
    expect(ancestors(names.ran)).toBe(2)
    const missing = 'f'.repeat(40)
    const unknowns = await counted(() => G.gitStep(async () => [await G.isAncestor(repo, missing, rev), await G.isAncestor(repo, missing, rev)]))
    expect(unknowns.value.every((v) => isUnknown(v))).toBe(true)
    expect(ancestors(unknowns.ran)).toBe(2)
  })

  it("a line's head is read from the ref files, again each time, with no git; git where they can't say (#1491)", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [, rev] = branchWith('one', { 'one.txt': '1\n' })
    const main = sh(repo, 'rev-parse', 'main')
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'hive/card', wt, 'one')
    const read = await counted(() => G.gitStep(async () => [await G.lineHead(repo, 'main'), await G.lineHead(wt, 'main'), await G.lineHead(wt, 'hive/card')]))
    expect(read.value).toEqual([main, main, rev])
    expect(read.ran).toEqual([])
    // Moved inside the step: the new head, as git would say (a ref is never kept).
    const moved = await G.gitStep(async () => {
      const before = await G.lineHead(repo, 'one')
      sh(repo, 'branch', '-q', '-f', 'one', 'main')
      return [before, await G.lineHead(repo, 'one')]
    })
    expect(moved).toEqual([rev, main])
    // Packed (no loose file): from packed-refs; a loose ref written after packing wins, as in git.
    sh(repo, 'pack-refs', '--all')
    const packed = await counted(() => G.lineHead(wt, 'hive/card'))
    expect(packed).toEqual({ value: rev, ran: [] })
    sh(repo, 'update-ref', 'refs/heads/hive/card', main)
    expect(await G.lineHead(wt, 'hive/card')).toBe(main)
    expect(await G.lineHead(repo, 'hive/card')).toBe(sh(repo, 'rev-parse', 'refs/heads/hive/card'))
    // No such line (nor a folder named as a ref's prefix): git says, null.
    const gone = await counted(async () => [await G.lineHead(repo, 'gone'), await G.lineHead(repo, 'hive')])
    expect(gone.value).toEqual([null, null])
    expect(gone.ran).toHaveLength(2)
    // A ref file that doesn't name a commit: git's answer, not the file's.
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'broken'), 'not a commit\n')
    const broken = await counted(() => G.lineHead(repo, 'broken'))
    expect(broken.ran).toHaveLength(1)
    expect(broken.value === null || isUnknown(broken.value)).toBe(true)
    // A subfolder, whose repository its `.git` doesn't name: git.
    const sub = await counted(() => G.lineHead(join(repo, 'src'), 'main'))
    expect(sub).toEqual({ value: main, ran: [`rev-parse --verify -q refs/heads/main`] })
  })

  it("a name that isn't a plain branch, or a symbolic ref, is git's to answer, never a file read as a path (HR6's #1491 round 1)", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [, rev] = branchWith('one', { 'one.txt': '1\n' })
    const main = sh(repo, 'rev-parse', 'main')
    /** Git's own answer in `cwd`, as lineHead asks it: the commit, or null. */
    const gitSays = (cwd: string, line: string): string | null => {
      try {
        return execFileSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${line}`], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
      } catch {
        return null
      }
    }
    // Files a path would find: a tag, a ref under another name, a lock file holding an id.
    sh(repo, 'tag', 'v1', rev)
    sh(repo, 'update-ref', 'refs/heads/a/b', rev)
    const heads = join(repo, '.git', 'refs', 'heads')
    writeFileSync(join(heads, 'x.lock'), `${rev}\n`)
    writeFileSync(join(heads, '.hidden'), `${rev}\n`)
    for (const line of ['../tags/v1', 'a\\b', 'a/./b', 'a//b', './one', 'one/', 'x.lock', '.hidden', 'one.', '-one', 'con', 'aux.txt', 'with space', 'one:x', 'one~1', 'one^', '@', 'a/../one', '']) {
      const r = await counted(() => G.lineHead(repo, line))
      expect(r.ran, line).toEqual([`rev-parse --verify -q refs/heads/${line}`])
      expect(r.value, line).toBe(gitSays(repo, line))
    }
    // A symbolic ref naming a linked worktree's own HEAD: git, in that worktree, says its head, not the project's.
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'hive/card', wt, 'one')
    sh(wt, 'symbolic-ref', 'refs/heads/alias', 'HEAD')
    const alias = await counted(() => G.lineHead(wt, 'alias'))
    expect(alias.ran).toHaveLength(1)
    expect(alias.value).toBe(rev)
    expect(alias.value).toBe(gitSays(wt, 'alias'))
    // To a branch: git too (never followed from the files), the same answer.
    sh(repo, 'symbolic-ref', 'refs/heads/also', 'refs/heads/main')
    expect(await counted(() => G.lineHead(wt, 'also'))).toEqual({ value: main, ran: ['rev-parse --verify -q refs/heads/also'] })
  })

  it("a step's answers are its repository's: another repository, without those commits, is asked and answers unknown (HR2's #1376 round 1)", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const [base, rev] = branchWith('one', { 'one.txt': '1\n' })
    // Another repository with the same base commit (a clone of main) but not the card's.
    const other = join(repo, '..', 'other')
    execFileSync('git', ['clone', '-q', '--no-local', '--single-branch', '-b', 'main', repo, other])
    expect(isUnknown(await G.isAncestor(other, base, rev))).toBe(true)
    const answers = await G.gitStep(async () => {
      const here = [await G.isAncestor(repo, base, rev), await G.mergeBase(repo, base, rev)]
      // A step inside the step (another workspace's work it set off), on the other repository: its own answers.
      const there = await G.gitStep(async () => [await G.isAncestor(other, base, rev), await G.mergeBase(other, base, rev)])
      return { here, there }
    })
    expect(answers.here).toEqual([true, base])
    expect(answers.there.every((v) => isUnknown(v))).toBe(true)
  })

  it('dirty lists tracked and untracked changes and a merge under way, only the paths asked for', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    expect(await G.dirty(repo)).toEqual([])
    commit(repo, { 'b.txt': 'b\n' }, 'b')
    writeFileSync(join(repo, 'b.txt'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    expect((await G.dirty(repo)) as string[]).toEqual(expect.arrayContaining(['b.txt', 'new.txt']))
    expect(await G.dirty(repo, ['new.txt'])).toEqual(['new.txt'])
  })

  it('dirty marks a merge or a rebase under way, in a linked worktree too, whatever the paths asked for', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    commit(repo, { 'b.txt': 'b\n' }, 'b')
    const [, other] = branchWith('other', { 'b.txt': 'theirs\n' })
    commit(repo, { 'b.txt': 'ours\n' }, 'ours')
    // A conflicted merge: MERGE_HEAD in the repository's git folder.
    expect(() => sh(repo, 'merge', '-q', 'other')).toThrow()
    expect((await G.dirty(repo)) as string[]).toContain('(MERGE_HEAD)')
    expect(await G.dirty(repo, ['elsewhere.txt'])).toEqual(['(MERGE_HEAD)'])
    sh(repo, 'merge', '--abort')
    expect(await G.dirty(repo)).toEqual([])
    // A linked worktree's markers are in its own git folder, outside the folder itself.
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', wt, other)
    expect(() => sh(wt, 'rebase', '-q', 'main')).toThrow()
    expect((await G.dirty(wt)) as string[]).toContain('(rebase-merge)')
    expect((await G.dirty(repo)) as string[]).not.toContain('(rebase-merge)')
  })
})

describe('identity in one git, as `git config <key>` answers each (HI-2050)', () => {
  /** What `git config <key>` says (null: not set, exit 1). */
  const key = (folder: string, k: string): string | null => {
    try {
      return execFileSync('git', ['config', k], { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  /** identity, and what the two `git config` reads it replaces would make of the same repository. */
  async function same(folder: string): Promise<void> {
    const r = await counted(() => G.identity(folder))
    const n = key(folder, 'user.name')
    const e = key(folder, 'user.email')
    expect(r.value).toEqual(n && e ? { name: n, email: e } : null)
    expect(r.ran).toHaveLength(1)
  }
  const configFile = (folder: string): string => join(sh(folder, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'config')

  it('set, repeated (the last), one or both missing, empty, a key with no value, a value with a newline', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    await same(repo)
    expect(await G.identity(repo)).toEqual({ name: 'Hive Test', email: 'test@hive.invalid' })
    sh(repo, 'config', '--add', 'user.name', 'Second Name')
    await same(repo)
    expect(await G.identity(repo)).toMatchObject({ name: 'Second Name' })
    sh(repo, 'config', '--unset-all', 'user.name')
    await same(repo)
    sh(repo, 'config', '--unset-all', 'user.email')
    await same(repo)
    sh(repo, 'config', 'user.name', '')
    sh(repo, 'config', 'user.email', 'e@hive.invalid')
    await same(repo)
    // A key with no value, then a value with a newline in it (the config file's own escape).
    const file = configFile(repo)
    sh(repo, 'config', '--unset-all', 'user.name')
    writeFileSync(file, `${readFileSync(file, 'utf8')}[user]\n\tname\n`)
    await same(repo)
    sh(repo, 'config', '--unset-all', 'user.name')
    writeFileSync(file, `${readFileSync(file, 'utf8')}[user]\n\tname = "Two\\nLines"\n`)
    await same(repo)
    expect(await G.identity(repo)).toMatchObject({ name: 'Two\nLines' })
  })

  it("an include, and a worktree's own config, as git reads them; a config git can't read is unknown, never no identity", async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    const inc = join(tempDir('git-'), 'identity.inc')
    writeFileSync(inc, '[user]\n\tname = Included\n')
    sh(repo, 'config', 'include.path', inc.replace(/\\/g, '/'))
    await same(repo)
    expect(await G.identity(repo)).toMatchObject({ name: 'Included' })
    const wt = join(repo, '..', 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', wt, 'main')
    sh(repo, 'config', 'extensions.worktreeConfig', 'true')
    sh(wt, 'config', '--worktree', 'user.name', 'Its Own')
    await same(wt)
    expect(await G.identity(wt)).toMatchObject({ name: 'Its Own' })
    await same(repo)
    const file = configFile(repo)
    writeFileSync(file, `${readFileSync(file, 'utf8')}[user\n`)
    const broken = await counted(() => G.identity(repo))
    expect(isUnknown(broken.value)).toBe(true)
    expect(broken.ran).toHaveLength(1)
  })
})
