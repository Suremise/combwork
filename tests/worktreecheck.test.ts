// Whether a worktree can be deleted without losing work (#291 Remove All, shared with #289 templates), and deleting it
// only then: git lists it, its branch is fully merged into the repository's main branch (a squash merge counts; never
// whatever branch the project folder has checked out) and nothing is uncommitted. Anything else keeps it, with the
// reason. The deletion is guarded against anything since the check: a file written or a commit made afterwards, or the
// main branch changing, keeps the work.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktree, deleteCheckedBranch, mergeWorktree, primaryBranch, removeCheckedWorktree, worktreeCheck } from '../src/main/worktrees'
import { placeKey, samePlace } from '../src/main/fsutil'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

type Tree = { path: string; branch: string; base: string }

async function makeProject(main = 'main'): Promise<{ project: string; tree: (name: string) => Promise<Tree> }> {
  root = tempDir('cw-wtcheck-')
  const project = join(root, 'project')
  run(root, 'init', '-q', '-b', main, project)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(project, 'config', k, v)
  writeFileSync(join(project, 'a.txt'), 'a\n')
  run(project, 'add', '-A')
  run(project, 'commit', '-qm', 'base')
  return {
    project,
    tree: async (name) => {
      const wt = { path: join(root, 'wt', name), branch: `cw/${name}`, base: main }
      await createWorktree(project, wt.path, wt.branch, main)
      return wt
    }
  }
}

const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  run(cwd, 'add', '-A')
  run(cwd, 'commit', '-qm', file)
}
const hasBranch = (project: string, b: string): boolean => run(project, 'branch', '--format=%(refname:short)').split(/\r?\n/).includes(b)

describe('worktreeCheck', () => {
  it('a fresh worktree with nothing on it is removable, against main', async () => {
    const { project: p, tree } = await makeProject()
    const c = await worktreeCheck(p, await tree('fresh'))
    expect(c).toMatchObject({ removable: true, into: 'main' })
    expect(c.tip).toMatch(/^[0-9a-f]{40}$/)
  })

  it('a branch merged into main, by a merge commit or a squash, is removable', async () => {
    const { project: p, tree } = await makeProject()
    const merged = await tree('merged')
    commit(merged.path, 'm.txt')
    expect(await mergeWorktree(p, merged, { squash: false, message: 'merge' })).toMatchObject({ ok: true })
    expect((await worktreeCheck(p, merged)).removable).toBe(true)
    const squashed = await tree('squashed')
    commit(squashed.path, 's.txt')
    expect(await mergeWorktree(p, squashed, { squash: true, message: 'squash' })).toMatchObject({ ok: true })
    expect((await worktreeCheck(p, squashed)).removable).toBe(true)
  })

  it('unmerged commits or uncommitted files keep it, saying which', async () => {
    const { project: p, tree } = await makeProject()
    const ahead = await tree('ahead')
    commit(ahead.path, 'x.txt')
    commit(ahead.path, 'y.txt')
    expect(await worktreeCheck(p, ahead)).toMatchObject({ removable: false, into: 'main', reason: '2 commits not merged into main' })
    const dirty = await tree('dirty')
    writeFileSync(join(dirty.path, 'new.txt'), 'new\n')
    expect(await worktreeCheck(p, dirty)).toMatchObject({ removable: false, into: 'main', reason: '1 uncommitted file' })
    writeFileSync(join(ahead.path, 'a.txt'), 'changed\n')
    expect((await worktreeCheck(p, ahead)).reason).toBe('2 commits not merged into main and 1 uncommitted file')
  })

  it('merged into the branch the project folder has checked out is not enough: main is what counts', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('feature')
    commit(wt.path, 'f.txt')
    run(p, 'checkout', '-q', '-b', 'feature-target')
    run(p, 'merge', '-q', '--no-edit', wt.branch)
    expect(await worktreeCheck(p, wt)).toMatchObject({ removable: false, into: 'main', reason: '1 commit not merged into main' })
    // A detached project folder doesn't matter either.
    run(p, 'checkout', '-q', '--detach')
    expect((await worktreeCheck(p, wt)).into).toBe('main')
  })

  it('main is the branch origin/HEAD names, else main, else master; none of them keeps every worktree', async () => {
    const m = await makeProject('master')
    expect(await primaryBranch(m.project)).toBe('master')
    run(m.project, 'branch', 'trunk')
    run(m.project, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    run(m.project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    expect(await primaryBranch(m.project)).toBe('trunk')
    // A tag named as origin's branch: still origin's default, by its whole ref (git's short name is remotes/origin/trunk, HI-2426).
    run(m.project, 'tag', 'origin/trunk')
    expect(await primaryBranch(m.project)).toBe('trunk')
    // …and a tag named as a local branch: still that branch (refname:short lists it as heads/trunk).
    run(m.project, 'tag', 'trunk')
    expect(await primaryBranch(m.project)).toBe('trunk')
    run(m.project, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD')
    run(m.project, 'tag', 'master')
    expect(await primaryBranch(m.project)).toBe('master')
    rmSync(root, { recursive: true, force: true })
    const n = await makeProject('develop')
    const wt = await n.tree('x')
    expect(await worktreeCheck(n.project, wt)).toMatchObject({ removable: false, into: null })
  })

  it('only worktrees git lists on their branch: not the project folder, a plain folder or a wrong branch', async () => {
    const { project: p, tree } = await makeProject()
    expect((await worktreeCheck(p, { path: p, branch: 'main', base: 'main' })).removable).toBe(false)
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await worktreeCheck(p, { path: plain, branch: 'cw/plain', base: 'main' })).toMatchObject({ removable: false, reason: "git doesn't list it as a worktree on cw/plain" })
    const wt = await tree('other')
    expect((await worktreeCheck(p, { ...wt, branch: 'cw/elsewhere' })).removable).toBe(false)
  })
})

describe('removeCheckedWorktree', () => {
  it('deletes a checked, merged, clean worktree and its branch', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('done')
    expect(await removeCheckedWorktree(p, wt, await worktreeCheck(p, wt), 'main')).toEqual({ deleted: true })
    expect(existsSync(wt.path)).toBe(false)
    expect(hasBranch(p, wt.branch)).toBe(false)
  })

  it('keeps one written to after the check (git refuses without --force)', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('late')
    const check = await worktreeCheck(p, wt)
    expect(check.removable).toBe(true)
    writeFileSync(join(wt.path, 'late-work.txt'), 'not committed\n')
    const r = await removeCheckedWorktree(p, wt, check, 'main')
    expect(r.deleted).toBe(false)
    expect(r.reason).toMatch(/^git kept it/)
    expect(existsSync(join(wt.path, 'late-work.txt'))).toBe(true)
    expect(hasBranch(p, wt.branch)).toBe(true)
  })

  it('keeps one whose branch moved after the check (a new commit)', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('moved')
    const check = await worktreeCheck(p, wt)
    commit(wt.path, 'new.txt')
    expect(await removeCheckedWorktree(p, wt, check, 'main')).toEqual({ deleted: false, reason: 'cw/moved changed since it was checked' })
    expect(existsSync(join(wt.path, 'new.txt'))).toBe(true)
    expect(hasBranch(p, wt.branch)).toBe(true)
  })

  it('keeps it when main is no longer the branch checked or shown, or no longer has its commit', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('shown')
    commit(wt.path, 's.txt')
    expect(await mergeWorktree(p, wt, { squash: false, message: 'merge' })).toMatchObject({ ok: true })
    const check = await worktreeCheck(p, wt)
    expect(check.removable).toBe(true)
    // The user was shown another branch.
    expect((await removeCheckedWorktree(p, wt, check, 'master')).deleted).toBe(false)
    // main was reset past the merge meanwhile.
    run(p, 'reset', '-q', '--hard', 'HEAD~1')
    expect(await removeCheckedWorktree(p, wt, check, 'main')).toEqual({ deleted: false, reason: 'main changed since it was checked' })
    // main renamed meanwhile.
    run(p, 'branch', '-m', 'main', 'trunk')
    expect((await removeCheckedWorktree(p, wt, check, 'main')).deleted).toBe(false)
    expect(existsSync(wt.path) && hasBranch(p, wt.branch)).toBe(true)
  })

  it('at the last step, a main branch moved after everything else was checked keeps the branch (one ref transaction)', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('race')
    commit(wt.path, 'unique-work.txt')
    expect(await mergeWorktree(p, wt, { squash: false, message: 'merge' })).toMatchObject({ ok: true })
    const check = await worktreeCheck(p, wt)
    expect(check).toMatchObject({ removable: true, into: 'main' })
    // Between the worktree's removal and the branch's: main reset to before the merge, so the commit is unmerged again.
    run(p, 'reset', '-q', '--hard', 'HEAD~1')
    expect(await deleteCheckedBranch(p, wt, 'main', check.tip!, check.intoTip!)).toBe('main changed since it was checked')
    expect(hasBranch(p, wt.branch)).toBe(true)
    expect(run(p, 'rev-parse', wt.branch).trim()).toBe(check.tip)
    // Main moved forward (still holding the commit) counts as moved too: the branch is kept rather than re-checked.
    run(p, 'reset', '-q', '--hard', check.intoTip!)
    commit(p, 'later.txt')
    expect(await deleteCheckedBranch(p, wt, 'main', check.tip!, check.intoTip!)).toBe('main changed since it was checked')
    // The branch moved instead.
    run(p, 'reset', '-q', '--hard', check.intoTip!)
    commit(wt.path, 'more.txt')
    expect(await deleteCheckedBranch(p, wt, 'main', check.tip!, check.intoTip!)).toBe('cw/race changed since it was checked')
    expect(hasBranch(p, wt.branch)).toBe(true)
  })

  it('refuses before touching anything when main moved after the check, even still holding the commit', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('late-main')
    const check = await worktreeCheck(p, wt)
    // main gets a commit after the check: refused before the worktree or the branch is touched.
    commit(p, 'moved.txt')
    expect(await removeCheckedWorktree(p, wt, check, 'main')).toEqual({ deleted: false, reason: 'main changed since it was checked' })
    expect(existsSync(wt.path) && hasBranch(p, wt.branch)).toBe(true)
  })

  it('does nothing for one the check did not find removable', async () => {
    const { project: p, tree } = await makeProject()
    const wt = await tree('busy')
    commit(wt.path, 'b.txt')
    expect(await removeCheckedWorktree(p, wt, await worktreeCheck(p, wt), 'main')).toEqual({ deleted: false, reason: '1 commit not merged into main' })
    expect(existsSync(wt.path)).toBe(true)
  })
})

// Paths Combwork was given by another name than git's (#389): GitHub's runner has its temp folder at C:\Users\RUNNER~1\…, and
// git lists worktrees by their real, long names. Compared by real paths, they are the same worktree; anything else still
// isn't one.
describe('paths by another name: an 8.3 short name or a junction (#389)', () => {
  const aliases: [string, (p: string) => string | null][] = [
    ['an 8.3 short name', (p) => shortPath(p)],
    ['a junction', (p) => junction(p, `${p}-junction`)]
  ]
  for (const [kind, alias] of aliases) {
    it(`a worktree and project given by ${kind} are checked and removed as git lists them`, async (ctx) => {
      const { project: p, tree } = await makeProject()
      const wt = await tree('aliased')
      const wts = alias(join(root, 'wt'))
      const proj = alias(p)
      if (!wts || !proj) return ctx.skip('this volume makes no 8.3 names')
      expect(wts.toLowerCase()).not.toBe(join(root, 'wt').toLowerCase())
      const named = { ...wt, path: join(wts, 'aliased') }
      expect(samePlace(named.path, wt.path)).toBe(true)
      expect(await worktreeCheck(proj, named)).toMatchObject({ removable: true, into: 'main' })
      // Still only what git lists, on its branch: not the project folder by its other name, a plain folder or a wrong branch.
      expect((await worktreeCheck(p, { path: proj, branch: 'main', base: 'main' })).removable).toBe(false)
      mkdirSync(join(root, 'wt', 'plain'))
      expect(await worktreeCheck(proj, { path: join(wts, 'plain'), branch: 'cw/plain', base: 'main' })).toMatchObject({ removable: false, reason: "git doesn't list it as a worktree on cw/plain" })
      expect((await worktreeCheck(proj, { ...named, branch: 'cw/elsewhere' })).removable).toBe(false)
      // Unmerged work still keeps it.
      commit(wt.path, 'w.txt')
      expect(await worktreeCheck(proj, named)).toMatchObject({ removable: false, reason: '1 commit not merged into main' })
      run(p, 'merge', '-q', '--no-edit', wt.branch)
      expect(await removeCheckedWorktree(proj, named, await worktreeCheck(proj, named), 'main')).toEqual({ deleted: true })
      expect(existsSync(wt.path)).toBe(false)
      expect(hasBranch(p, wt.branch)).toBe(false)
    })
  }

  it('placeKey: one key for every name of a place, a missing path by its nearest folder, one that resolves nowhere as written', async () => {
    const { project: p } = await makeProject()
    const short = shortPath(p)
    if (short) expect(placeKey(short)).toBe(placeKey(p))
    const j = junction(p, join(root, 'via'))
    expect(placeKey(j)).toBe(placeKey(p))
    expect(placeKey(join(j, 'not-yet', 'x'))).toBe(placeKey(join(p, 'not-yet', 'x')))
    expect(samePlace(j, join(root, 'other'))).toBe(false)
    expect(placeKey('Q:\\No\\Such\\Folder')).toBe('q:\\no\\such\\folder')
  })
})
