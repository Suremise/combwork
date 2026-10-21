// The Git adapter's answers on real repositories (#1118, SPEC §16.3.2): fixed endpoints, sameness by replay with the
// candidate key only as a first test, containment of a merge, a fast-forward and a squash.
import { execFileSync } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { tempDir } from '../tempDir'
import { commit, gitRepo, sh } from './harness'
import * as G from '../../src/main/platform/git'

let repo = ''
afterEach(() => {
  repo = ''
})

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

  it('dirty lists tracked and untracked changes and a merge under way, only the paths asked for', async () => {
    repo = gitRepo(join(tempDir('git-'), 'r'))
    expect(await G.dirty(repo)).toEqual([])
    commit(repo, { 'b.txt': 'b\n' }, 'b')
    const { writeFileSync } = await import('fs')
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
