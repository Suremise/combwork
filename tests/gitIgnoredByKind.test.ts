// HI-3173: a Git folder's record paths are ignored only as every kind each may have had (gitIgnoredByKind.ts), on a
// real repository: `out/`, `build/` and `__pycache__/` ignored folder-only, a tracked file under `build/`.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { gitIgnoredByKind, type EntryKind, type RecordedKinds } from '../src/main/platform/gitIgnoredByKind'
import { tempDir } from './tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

describe('a Git record path is ignored by every kind it had', () => {
  let p: string
  beforeAll(() => {
    p = tempDir('cw-ignored-kind-')
    run(p, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
    writeFileSync(join(p, '.gitignore'), 'out/\nbuild/\n')
    mkdirSync(join(p, 'src'))
    writeFileSync(join(p, 'src', '.gitignore'), '__pycache__/\n')
    mkdirSync(join(p, 'out'))
    mkdirSync(join(p, 'build'))
    writeFileSync(join(p, 'build', 'kept.js'), 'k\n')
    run(p, 'add', '-A')
    run(p, 'add', '-f', 'build/kept.js')
    run(p, 'commit', '-q', '-m', 'one')
  })

  const read = (...kinds: EntryKind[]): RecordedKinds => ({ kinds: new Set(kinds), unread: false })
  const ask = (record: Record<string, RecordedKinds>) => gitIgnoredByKind(p, Object.keys(record), (x) => record[x])

  it('a deleted folder (paths under it in the record) and a nested one are ignored; a file that was there too is not', async () => {
    expect(await ask({ out: read(), 'out/a.js': read(), 'src/__pycache__': read(), 'src/__pycache__/m.pyc': read() })).toEqual(new Set(['out', 'out/a.js', 'src/__pycache__', 'src/__pycache__/m.pyc']))
    expect(await ask({ out: read('f', 'd'), 'out/a.js': read('f') })).toEqual(new Set(['out/a.js']))
  })

  it("an entry not read is asked as a file too, whatever is on disk now; one that couldn't be read counts", async () => {
    // `out` is a folder on disk: unread, it may have been a file during the run.
    expect(await ask({ out: { kinds: new Set(), unread: true } })).toEqual(new Set())
    expect(await ask({ out: read('?', 'd') })).toEqual(new Set())
  })

  it('a tracked file under an ignored folder counts', async () => {
    expect(await ask({ 'build/kept.js': read('f'), 'build/new.js': read('f') })).toEqual(new Set(['build/new.js']))
  })
})
