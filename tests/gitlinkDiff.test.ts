// A moved submodule in Combwork's diffs (HI-2864, design HI-2864/s10). The pure part (shared/gitlink.ts: raw rows,
// sides, git's patch line) and, with real git, the three reads that carry it: the Changes tab's diff (gitDiff, a ref
// against the working tree), its comparison of two branches (compareDiff) and a submission's files (filesChanged, the
// Work section). A gitlink is told by its mode, never by a read that failed: a fixture keeps the submodule's commits in
// the parent's store too. A side that is a file or a link keeps its content, and a gitlink whose commit can't be read is
// an error, never an empty diff. The submodule is a local file:// one at a path with brackets and a space.
import { execFileSync } from 'child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { commit, freshGitRepo, sh } from './workflow/harness'
import { gitDiff } from '../src/main/git'
import { compareDiff } from '../src/main/gitCompare'
import { filesChanged, treeSide } from '../src/main/platform/git'
import { isUnknown } from '../src/main/platform/types'
import { gitlinkOf, parseRawRows, parseSubprojectPatch, sideOf, subprojectLine, unresolved } from '../src/shared/gitlink'

const SUB = 'lib/[x] sub'
const Z = '0'.repeat(40)

/** git with the file protocol allowed, for making the fixture's submodule (Combwork's reads never need it). */
const gf = (cwd: string, ...args: string[]): string => sh(cwd, '-c', 'protocol.file.allow=always', ...args)

/** A gitlink, file or link put straight into the index (no checkout needed): mode, id, path. */
function stage(repo: string, mode: string, id: string, path: string): void {
  sh(repo, 'update-index', '--add', '--cacheinfo', `${mode},${id},${path}`)
}
function blob(repo: string, content: string): string {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim()
}

/** Writes these files and commits them with what is staged (never `add -A`: index-only entries have no folder). */
function only(repo: string, files: Record<string, string>, message: string): void {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(repo, f, '..'), { recursive: true })
    writeFileSync(join(repo, f), c)
  }
  sh(repo, 'add', '--', ...Object.keys(files))
  sh(repo, 'commit', '-q', '-m', message)
}

/**
 * A submodule repository with three commits (A, B, C), and a project whose main has it at A in `lib/[x] sub` (a real
 * checkout), and index-only entries for the type changes; branch `card` moves the submodule to B and changes the rest:
 * a gitlink replaced by a file and by a link, a file replaced by a gitlink, a gitlink added and one removed, a file edited.
 */
function fixture(): { project: string; sub: string; A: string; B: string; C: string } {
  const root = tempDir('gitlink-')
  const sub = freshGitRepo(join(root, 'sub'))
  const A = commit(sub, { 's.txt': 'a\n' }, 'A')
  const B = commit(sub, { 's.txt': 'b\n' }, 'B')
  const C = commit(sub, { 's.txt': 'c\n' }, 'C')
  const project = freshGitRepo(join(root, 'project'))
  gf(project, 'submodule', 'add', '-q', pathToFileURL(sub).href, SUB)
  gf(join(project, SUB), 'checkout', '-q', A)
  sh(project, 'add', '--', SUB)
  stage(project, '160000', A, 'swap/toFile')
  stage(project, '160000', A, 'swap/toLink')
  stage(project, '160000', A, 'old/sub')
  // The index-only gitlinks have no folder: empty ones make them unpopulated (unchanged), as git leaves them.
  for (const p of ['swap/toFile', 'swap/toLink', 'old/sub']) mkdirSync(join(project, p), { recursive: true })
  only(project, { 'swap/fromFile': 'text\n', 'a.txt': 'one\n' }, 'main')
  sh(project, 'checkout', '-q', '-b', 'card')
  gf(join(project, SUB), 'checkout', '-q', B)
  sh(project, 'add', '--', SUB)
  sh(project, 'rm', '-q', '--cached', 'swap/toFile', 'swap/toLink', 'old/sub', 'swap/fromFile')
  stage(project, '100644', blob(project, 'now a file\n'), 'swap/toFile')
  stage(project, '120000', blob(project, '../target'), 'swap/toLink')
  stage(project, '160000', B, 'swap/fromFile')
  stage(project, '160000', B, 'new/sub')
  only(project, { 'a.txt': 'two\n' }, 'card')
  // What card left in the working tree: the old folders and file go, as a checkout of card would have them.
  rmSync(join(project, 'swap'), { recursive: true })
  rmSync(join(project, 'old'), { recursive: true })
  return { project, sub, A, B, C }
}

describe('shared/gitlink: raw rows and git’s patch line', () => {
  it('reads raw rows exactly, zeros kept, and refuses anything else whole', () => {
    const out = `:160000 160000 ${'a'.repeat(40)} ${Z} M\0lib/[x] sub\0:100644 100644 ${'b'.repeat(40)} ${'c'.repeat(40)} M\0a.txt\0`
    const rows = parseRawRows(out)!
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ oldMode: '160000', newMode: '160000', oldId: 'a'.repeat(40), newId: Z, status: 'M', path: 'lib/[x] sub' })
    expect(gitlinkOf(rows[1])).toBeNull()
    expect(unresolved(gitlinkOf(rows[0])!.to)).toBe(true)
    expect(parseRawRows('')).toEqual([])
    // A short id (--abbrev), a missing path, a stray piece: never a partial list.
    expect(parseRawRows(`:160000 160000 abc1234 def5678 M\0x\0`)).toBeNull()
    expect(parseRawRows(`:160000 160000 ${'a'.repeat(40)} ${Z} M\0`)).toBeNull()
    expect(parseRawRows(`${out}junk\0`)).toBeNull()
  })

  it('names a gitlink side by its commit, and never a file’s or link’s id', () => {
    expect(sideOf('160000', 'a'.repeat(40))).toEqual({ kind: 'gitlink', commit: 'a'.repeat(40) })
    expect(sideOf('100644', 'b'.repeat(40))).toEqual({ kind: 'file' })
    expect(sideOf('100755', 'b'.repeat(40))).toEqual({ kind: 'file' })
    expect(sideOf('120000', 'b'.repeat(40))).toEqual({ kind: 'link' })
    expect(sideOf('000000', Z)).toEqual({ kind: 'none' })
    expect(sideOf('040000', 'b'.repeat(40))).toEqual({ kind: 'none' })
  })

  it("reads the working tree's commit from the gitlink section only, and nothing doubtful", () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const moved = `diff --git a/s b/s\nindex aaaaaaa..bbbbbbb 160000\n--- a/s\n+++ b/s\n@@ -1 +1 @@\n-Subproject commit ${a}\n+Subproject commit ${b}\n`
    expect(parseSubprojectPatch(moved)).toEqual({ commit: b, dirty: false })
    expect(parseSubprojectPatch(moved.replace(`${b}\n`, `${b}-dirty\n`))).toEqual({ commit: b, dirty: true })
    expect(parseSubprojectPatch(moved.replace(/\n/g, '\r\n'))).toEqual({ commit: b, dirty: false })
    // A file made a gitlink: two sections; the file's `+` lines are never read as a commit.
    const typeChange = `diff --git a/s b/s\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/s\n+++ /dev/null\n@@ -1 +0,0 @@\n-Subproject commit ${a}\ndiff --git a/s b/s\nnew file mode 160000\nindex 0000000..bbbbbbb\n--- /dev/null\n+++ b/s\n@@ -0,0 +1 @@\n+Subproject commit ${b}\n`
    expect(parseSubprojectPatch(typeChange)).toEqual({ commit: b, dirty: false })
    // A file whose text looks like git's line is not a gitlink section.
    expect(parseSubprojectPatch(`diff --git a/s b/s\nindex 1234567..89abcde 100644\n+Subproject commit ${b}\n`)).toBeNull()
    expect(parseSubprojectPatch('')).toBeNull()
    expect(parseSubprojectPatch(`${moved}${moved}`)).toBeNull()
    expect(subprojectLine(b, true)).toBe(`Subproject commit ${b}-dirty\n`)
  })
})

describe('compareDiff (Changes → Compare): sides by mode', () => {
  it('a moved, added and removed gitlink, and type changes keeping the file’s or link’s content', async () => {
    const { project, A, B } = fixture()
    const d = (p: string) => compareDiff(project, 'main', 'card', p)
    const moved = await d(SUB)
    expect(moved.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } })
    expect([moved.original, moved.modified]).toEqual([subprojectLine(A), subprojectLine(B)])
    expect((await d('new/sub')).gitlink).toEqual({ from: { kind: 'none' }, to: { kind: 'gitlink', commit: B } })
    const gone = await d('old/sub')
    expect(gone.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'none' } })
    expect([gone.original, gone.modified]).toEqual([subprojectLine(A), ''])
    const toFile = await d('swap/toFile')
    expect(toFile.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'file' } })
    expect([toFile.original, toFile.modified]).toEqual([subprojectLine(A), 'now a file\n'])
    const toLink = await d('swap/toLink')
    expect(toLink.gitlink?.to).toEqual({ kind: 'link' })
    expect(toLink.modified).toBe('../target')
    const fromFile = await d('swap/fromFile')
    expect(fromFile.gitlink).toEqual({ from: { kind: 'file' }, to: { kind: 'gitlink', commit: B } })
    expect([fromFile.original, fromFile.modified]).toEqual(['text\n', subprojectLine(B)])
    const plain = await d('a.txt')
    expect(plain).toEqual({ path: 'a.txt', original: 'one\n', modified: 'two\n', binary: false })
  })

  it('a gitlink whose commit is in the parent’s store is still a gitlink, never that commit read as a file', async () => {
    const { project, sub, A, B } = fixture()
    gf(project, 'fetch', '-q', pathToFileURL(sub).href, 'main')
    // The read that failed before succeeds now: cat-file finds the commit.
    expect(sh(project, 'cat-file', '-t', `main:${SUB}`)).toBe('commit')
    const moved = await compareDiff(project, 'main', 'card', SUB)
    expect(moved.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } })
    expect(moved.original).toBe(subprojectLine(A))
  })
})

describe('filesChanged (the Work section): raw rows, the same list, gitlink sides kept', () => {
  it('the same paths and letters as --name-status, with each gitlink’s sides', async () => {
    const { project, A, B } = fixture()
    const base = sh(project, 'rev-parse', 'main')
    const head = sh(project, 'rev-parse', 'card')
    const files = await filesChanged(project, base, head)
    if (isUnknown(files)) throw new Error('unread')
    const names = sh(project, 'diff', '--name-status', '--no-renames', base, head).split(/\r?\n/).map((l) => l.split('\t'))
    expect(files.map((f) => [f.status, f.path])).toEqual(names)
    const by = (p: string) => files.find((f) => f.path === p)
    expect(by('a.txt')).toEqual({ status: 'M', path: 'a.txt' })
    expect(by(SUB)?.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } })
    expect(by('swap/toFile')?.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'file' } })
    expect(by('swap/fromFile')?.gitlink).toEqual({ from: { kind: 'file' }, to: { kind: 'gitlink', commit: B } })
    expect(by('new/sub')?.gitlink?.from).toEqual({ kind: 'none' })
    expect(by('old/sub')?.gitlink?.to).toEqual({ kind: 'none' })
  })

  it('treeSide (a shared folder’s commits combined): a path’s side at a commit, by its mode', async () => {
    const { project, A, B } = fixture()
    expect(await treeSide(project, 'main', SUB)).toEqual({ kind: 'gitlink', commit: A })
    expect(await treeSide(project, 'card', SUB)).toEqual({ kind: 'gitlink', commit: B })
    expect(await treeSide(project, 'card', 'swap/toFile')).toEqual({ kind: 'file' })
    expect(await treeSide(project, 'card', 'swap/toLink')).toEqual({ kind: 'link' })
    expect(await treeSide(project, 'main', 'new/sub')).toEqual({ kind: 'none' })
    // A folder at the path has nothing at the path itself (a gitlink replaced by files under it).
    expect(await treeSide(project, 'card', 'lib')).toEqual({ kind: 'none' })
    expect(isUnknown(await treeSide(project, 'f'.repeat(40), SUB))).toBe(true)
  })

  it('a revision git can’t diff is unknown, never an empty list', async () => {
    const { project } = fixture()
    expect(isUnknown(await filesChanged(project, 'f'.repeat(40), 'card'))).toBe(true)
  })
})

describe('gitDiff (the Changes tab): a ref against the working tree', () => {
  it('a committed move, then the checkout moved further, dirty, unpopulated, deleted and replaced by a file', async () => {
    const { project, A, B, C } = fixture()
    const d = () => gitDiff(project, SUB, 'main')
    const committed = await d()
    expect(committed.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } })
    expect([committed.original, committed.modified]).toEqual([subprojectLine(A), subprojectLine(B)])
    // Moved, not committed: raw gives zeros; git's own patch line says C.
    gf(join(project, SUB), 'checkout', '-q', C)
    expect((await d()).gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: C } })
    // A tracked file changed inside: dirty.
    writeFileSync(join(project, SUB, 's.txt'), 'edited\n')
    const dirty = await d()
    expect(dirty.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: C }, dirty: true })
    expect(dirty.modified).toBe(subprojectLine(C, true))
    gf(join(project, SUB), 'checkout', '-q', '--', 's.txt')
    // Unpopulated (an empty folder): the index's commit, never an empty diff.
    const aside = join(project, '..', 'aside')
    renameSync(join(project, SUB), aside)
    mkdirSync(join(project, SUB))
    expect((await d()).gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'gitlink', commit: B } })
    // The folder deleted: removed.
    rmSync(join(project, SUB), { recursive: true })
    const gone = await d()
    expect(gone.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'none' } })
    expect([gone.original, gone.modified]).toEqual([subprojectLine(A), ''])
    // A file in its place: the file's content, never a commit.
    writeFileSync(join(project, SUB), 'a file now\n')
    const file = await d()
    expect(file.gitlink).toEqual({ from: { kind: 'gitlink', commit: A }, to: { kind: 'file' } })
    expect(file.modified).toBe('a file now\n')
    rmSync(join(project, SUB))
    renameSync(aside, join(project, SUB))
  })

  it('a file made a gitlink keeps the file’s side; an ordinary file is read as before', async () => {
    const { project, B } = fixture()
    // swap/fromFile is a gitlink at B on card, with no folder: an empty one makes it unpopulated.
    mkdirSync(join(project, 'swap', 'fromFile'), { recursive: true })
    const fromFile = await gitDiff(project, 'swap/fromFile', 'main')
    expect(fromFile.gitlink).toEqual({ from: { kind: 'file' }, to: { kind: 'gitlink', commit: B } })
    expect([fromFile.original, fromFile.modified]).toEqual(['text\n', subprojectLine(B)])
    writeFileSync(join(project, 'a.txt'), 'three\n')
    expect(await gitDiff(project, 'a.txt', 'main')).toEqual({ path: 'a.txt', original: 'one\n', modified: 'three\n', binary: false })
  })

  it('a gitlink whose commit is in the parent’s store: its line, not the commit shown', async () => {
    const { project, sub, A } = fixture()
    gf(project, 'fetch', '-q', pathToFileURL(sub).href, 'main')
    const moved = await gitDiff(project, SUB, 'main')
    expect(moved.gitlink?.from).toEqual({ kind: 'gitlink', commit: A })
    expect(moved.original).toBe(subprojectLine(A))
  })

  it('a repository with no commit yet reads a staged file as before', async () => {
    const repo = join(tempDir('gitlink-unborn-'), 'repo')
    mkdirSync(repo, { recursive: true })
    sh(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'n.txt'), 'new\n')
    sh(repo, 'add', 'n.txt')
    expect(await gitDiff(repo, 'n.txt')).toEqual({ path: 'n.txt', original: '', modified: 'new\n', binary: false })
  })
})
