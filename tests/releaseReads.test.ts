// HI-3148: whether a line is released, through the release reads port, on real Git and the pinned real jj. Released: a tag
// named exactly v<line> or <line>, in the line's history, and the line merged into the default line (main, master or
// trunk). An annotated tag's date is its own; a lightweight tag has none. Anything unreadable is unknown.
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { releaseReadsOf } from '../src/main/platform/releaseReadsPorts'
import { jjReleaseReadsWith } from '../src/main/platform/jjReleaseReads'
import { isUnknown } from '../src/main/platform/types'
import { harness, jjExe } from './jjWorkspaceHarness'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
const commitIn = (cwd: string, f: string) => {
  writeFileSync(join(cwd, f), `${f}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', f)
}

/** main, and 1.4.0 a commit ahead of it (not merged yet). */
function repo(): string {
  const r = join(tempDir('cw-release-'), 'p')
  execFileSync('git', ['init', '-q', '-b', 'main', r])
  commitIn(r, 'a.txt')
  git(r, 'checkout', '-q', '-b', '1.4.0')
  commitIn(r, 'release.txt')
  git(r, 'checkout', '-q', 'main')
  return r
}
const reads = releaseReadsOf('git')!

describe('Git: whether a line is released (HI-3148)', () => {
  it('tagged and merged: released, with an annotated tag’s own date; lightweight: no date', async () => {
    const r = repo()
    git(r, 'tag', '-a', 'v1.4.0', '-m', 'release', '1.4.0')
    expect(await reads.released(r, '1.4.0')).toBeNull() // tagged, not merged into main yet
    git(r, 'merge', '-q', '--no-ff', '-m', 'release 1.4.0', '1.4.0')
    const got = await reads.released(r, '1.4.0')
    expect(got).toMatchObject({ tag: 'v1.4.0', into: 'main' })
    expect(isUnknown(got) || got === null ? null : got.date).toMatch(/^\d{4}-\d\d-\d\dT/)
    const light = repo()
    git(light, 'tag', '1.4.0-light', '1.4.0')
    git(light, 'tag', '1.4.0', '1.4.0^{commit}')
    git(light, 'merge', '-q', '--no-ff', '-m', 'release', '1.4.0')
    // `1.4.0` is a branch and a tag: the tag ref is read exactly (refs/tags/1.4.0).
    expect(await reads.released(light, '1.4.0')).toEqual({ tag: '1.4.0', into: 'main', date: null })
  })

  it('not released: untagged, a tag that only starts with the name, a tag on another line, the main line itself, no such line', async () => {
    const r = repo()
    git(r, 'merge', '-q', '--no-ff', '-m', 'merged, untagged', '1.4.0')
    expect(await reads.released(r, '1.4.0')).toBeNull()
    git(r, 'tag', 'v1.4.0-rc1', '1.4.0')
    git(r, 'tag', 'v1.4', '1.4.0')
    expect(await reads.released(r, '1.4.0')).toBeNull()
    // v1.4.0 on a commit 1.4.0 doesn't have.
    git(r, 'checkout', '-q', '-b', 'other')
    commitIn(r, 'other.txt')
    git(r, 'tag', 'v1.4.0')
    git(r, 'checkout', '-q', 'main')
    expect(await reads.released(r, '1.4.0')).toBeNull()
    expect(await reads.released(r, 'main')).toBeNull()
    expect(await reads.released(r, 'nosuch')).toBeNull()
  })

  it('watch (HR2’s round 1): its answer moves with a tag made, the line or main moved; not with an unrelated tag', async () => {
    const r = repo()
    const check = (await reads.watch(r, '1.4.0'))!
    const first = check()
    expect(first).toBeTruthy()
    git(r, 'tag', 'unrelated', 'main')
    expect(check()).toBe(first)
    git(r, 'tag', '-a', 'v1.4.0', '-m', 'release', '1.4.0')
    const tagged = check()
    expect(tagged).not.toBe(first)
    git(r, 'merge', '-q', '--no-ff', '-m', 'release 1.4.0', '1.4.0')
    expect(check()).not.toBe(tagged)
    // Packed (git gc): the same refs, the same answer.
    const before = check()
    git(r, 'pack-refs', '--all')
    expect(check()).toBe(before)
  })

  it('a repository it can’t read: unknown, never "not released"', async () => {
    const r = repo()
    writeFileSync(join(r, '.git', 'HEAD'), 'garbage\n')
    expect(isUnknown(await reads.released(r, '1.4.0'))).toBe(true)
  })
})

describe.skipIf(!jjExe)('jj: whether a line is released, pinned to one operation (HI-3148)', () => {
  it('tagged and merged into main: released (no date); a conflicted tag: unknown; no such bookmark: not released', async () => {
    const h = harness()
    const { repo: d } = h.repo('release', true)
    // 1.4.0: a commit past main; tagged v1.4.0; then main moved onto it (merged).
    writeFileSync(join(d, 'r.txt'), 'r\n')
    h.jj(d, 'commit', '-m', 'release work')
    h.jj(d, 'bookmark', 'create', '1.4.0', '-r', '@-')
    const jjReads = jjReleaseReadsWith(h.runner)
    expect(await jjReads.released(d, '1.4.0')).toBeNull()
    h.jj(d, 'tag', 'set', 'v1.4.0', '-r', '1.4.0')
    expect(await jjReads.released(d, '1.4.0')).toBeNull() // tagged, not in main yet
    h.jj(d, 'bookmark', 'set', 'main', '-r', '1.4.0')
    expect(await jjReads.released(d, '1.4.0')).toEqual({ tag: 'v1.4.0', into: 'main', date: null })
    expect(await jjReads.released(d, 'nosuch')).toBeNull()
    // watch (HR2's round 1): the operation head, moved by any jj operation (a tag set).
    const check = (await jjReads.watch(d, '1.4.0'))!
    const first = check()
    expect(first).toBeTruthy()
    expect(check()).toBe(first)
    h.jj(d, '--ignore-working-copy', 'tag', 'set', 'v9', '-r', 'main')
    expect(check()).not.toBe(first)
    // The tag made conflicted: two operations from the same one each set it elsewhere; jj merges their heads, and the
    // tag then names two commits. Unknown, never one picked.
    const op = h.jj(d, '--ignore-working-copy', 'op', 'log', '-n', '1', '--no-graph', '-T', 'id').trim()
    h.jj(d, '--at-op', op, '--ignore-working-copy', 'tag', 'set', '--allow-move', 'v1.4.0', '-r', 'main-')
    h.jj(d, '--at-op', op, '--ignore-working-copy', 'tag', 'set', '--allow-move', 'v1.4.0', '-r', '@')
    h.jj(d, 'log', '--no-graph', '-r', '@', '-T', 'commit_id')
    expect(h.jj(d, '--ignore-working-copy', 'tag', 'list')).toMatch(/conflict/i)
    expect(isUnknown(await jjReads.released(d, '1.4.0'))).toBe(true)
  })
})
