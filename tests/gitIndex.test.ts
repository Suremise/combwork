// Git's index read with no process (#1206), for the evidence fingerprint: every version git writes, SHA-1 and SHA-256,
// entries as `git ls-files --stage` lists them; a split index unreadable (null), so the caller falls back to its stat.
import { execFileSync } from 'child_process'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readIndex, statMatches } from '../src/main/platform/gitIndex'
import { tempDir } from './tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()

/** A repository with nested, long and non-ASCII paths, committed. */
function repo(format: 'sha1' | 'sha256' = 'sha1'): string {
  const p = tempDir('hive-gitindex-')
  run(p, 'init', '-q', '-b', 'main', `--object-format=${format}`)
  run(p, 'config', 'core.autocrlf', 'false')
  for (const f of ['a.txt', 'src/b.ts', 'src/deep/folder/with/a/long/name/c.md', 'src/deep/folder/with/a/long/name/d.md', 'ünïcode/é.txt']) {
    mkdirSync(join(p, f, '..'), { recursive: true })
    writeFileSync(join(p, f), `${f}\n`)
  }
  run(p, 'add', '-A')
  run(p, 'commit', '-q', '-m', 'one')
  return p
}

/** What git says the index holds: mode, object id, stage and path. */
function staged(p: string): string[] {
  return run(p, '-c', 'core.quotepath=off', 'ls-files', '--stage')
    .split('\n')
    .map((l) => l.replace('\t', ' '))
}

const read = (p: string, oid: 20 | 32 = 20) => {
  const file = join(p, '.git', 'index')
  return readIndex(file, oid, statSync(file).mtimeMs)
}

const asStaged = (p: string, oid: 20 | 32 = 20) => read(p, oid)!.entries.map((e) => `${e.mode.toString(8)} ${e.oid} ${e.stage} ${e.path}`)

describe("git's index", () => {
  for (const version of [2, 3, 4]) {
    it(`version ${version}: every entry as git lists it`, () => {
      const p = repo()
      run(p, 'update-index', '--index-version', String(version))
      expect(asStaged(p)).toEqual(staged(p))
    })
  }

  it('SHA-256 object ids', () => {
    const p = repo('sha256')
    expect(asStaged(p, 32)).toEqual(staged(p))
  })

  it('a conflict: each stage', () => {
    const p = repo()
    run(p, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(p, 'a.txt'), 'side\n')
    run(p, 'commit', '-q', '-am', 'side')
    run(p, 'checkout', '-q', 'main')
    writeFileSync(join(p, 'a.txt'), 'main\n')
    run(p, 'commit', '-q', '-am', 'main')
    try {
      run(p, 'merge', '-q', 'side')
    } catch {
      // The conflict is the point.
    }
    expect(asStaged(p)).toEqual(staged(p))
    expect(read(p)!.entries.filter((e) => e.path === 'a.txt').map((e) => e.stage)).toEqual([1, 2, 3])
  })

  it('a split index is not read (null): the caller uses its stat', () => {
    const p = repo()
    run(p, 'update-index', '--split-index')
    expect(read(p)).toBeNull()
  })

  it('anything else is null', () => {
    const p = tempDir('hive-gitindex-not-')
    writeFileSync(join(p, 'index'), 'not an index')
    expect(readIndex(join(p, 'index'), 20, Date.now())).toBeNull()
    expect(readIndex(join(p, 'missing'), 20, Date.now())).toBeNull()
  })

  it("a file's stat shows the index's content when its size and time match and the entry isn't racy", () => {
    const p = repo()
    // Written a second later, so no entry is racy.
    const file = join(p, '.git', 'index')
    const later = new Date(Date.now() + 2000)
    const idx = readIndex(file, 20, later.getTime())!
    const e = idx.entries.find((x) => x.path === 'a.txt')!
    const st = statSync(join(p, 'a.txt'))
    expect(statMatches(e, st.size, st.mtimeMs, idx.writtenMs)).toBe(true)
    expect(statMatches(e, st.size + 1, st.mtimeMs, idx.writtenMs)).toBe(false)
    expect(statMatches(e, st.size, st.mtimeMs + 5000, idx.writtenMs)).toBe(false)
    // Racy: the index written in the second the file was.
    expect(statMatches(e, st.size, st.mtimeMs, e.mtimeMs)).toBe(false)
  })
})
