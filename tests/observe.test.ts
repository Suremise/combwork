// The platform watcher (#1214, SPEC §16.3.2 Observe, §16.13): on real temporary repositories, each change is seen
// within the debounce (a commit, a reset to the same commit, a checkout and back, an edit undone, a worktree's commit, a
// packed-refs rewrite), a write in an ignored folder doesn't count, a folder gone and back (#964) leaves its record
// unknown rather than empty, and the watches close when their workspace does.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { Observer, observer, type ObserveEvent } from '../src/main/platform/observe'
import { isUnknown } from '../src/main/platform/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-observe-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { startObserving, stopObserving } = await import('../src/main/platform/watching')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A repository on main with one commit (a.txt), `out/` ignored. */
function repo(): string {
  const p = tempDir('hive-observe-repo-')
  run(p, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  writeFileSync(join(p, '.gitignore'), 'out/\n')
  run(p, 'add', '-A')
  run(p, 'commit', '-q', '-m', 'one')
  return p
}

/** Once a folder's watch is armed: its record is complete from now on. */
const armed = (o: Observer, folder: string) => vi.waitFor(async () => expect(isUnknown(await o.changedBetween(folder, Date.now(), Date.now()))).toBe(false), { timeout: HUNG_MS })

const commit = (p: string, file: string, text: string): string => {
  writeFileSync(join(p, file), text)
  run(p, 'add', '-A')
  run(p, 'commit', '-q', '-m', text.trim())
  return run(p, 'rev-parse', 'HEAD')
}

describe('the watcher on a Git repository', () => {
  let o: Observer
  let p: string
  const events: ObserveEvent[] = []
  const seen = (want: Partial<ObserveEvent>) => vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining(want)), { timeout: HUNG_MS })
  /** What the write log says of a stretch: what counted, or unknown. */
  const between = async (t0: number, t1 = Date.now()) => {
    const r = await o.changedBetween(p, t0, t1)
    if (isUnknown(r)) throw new Error(`unknown: ${r.what}`)
    return r
  }

  beforeEach(async () => {
    p = repo()
    events.length = 0
    o = new Observer()
    o.follow([{ path: p, platform: 'git', root: p }])
    o.subscribe(p, (e) => events.push(e))
    await armed(o, p)
  })
  afterEach(() => o.dispose())

  it('a commit moves its line and the folder, and is in the write log', async () => {
    const t0 = Date.now()
    const before = run(p, 'rev-parse', 'HEAD')
    const after = commit(p, 'b.txt', 'b\n')
    await seen({ kind: 'lineMoved', line: 'main', from: before, to: after })
    await seen({ kind: 'folderMoved', folder: p, from: before, to: after })
    expect((await between(t0)).paths).toEqual(expect.arrayContaining([':reflog', 'b.txt']))
  })

  it('nothing done: nothing changed', async () => {
    const t0 = Date.now()
    expect(await between(t0)).toEqual({ changed: false, paths: [] })
  })

  it('a reset to the same commit moves nothing, but its reflog entry counts', async () => {
    const t0 = Date.now()
    run(p, 'reset', '-q', '--hard', 'HEAD')
    expect((await between(t0)).paths).toContain(':reflog')
    expect(events.filter((e) => e.kind !== 'written')).toEqual([])
  })

  it('a checkout and back counts', async () => {
    const t0 = Date.now()
    run(p, 'checkout', '-q', '-b', 'side')
    run(p, 'checkout', '-q', 'main')
    expect((await between(t0)).paths).toContain(':reflog')
  })

  it('an edit undone counts', async () => {
    const t0 = Date.now()
    writeFileSync(join(p, 'a.txt'), 'changed\n')
    writeFileSync(join(p, 'a.txt'), 'a\n')
    expect(run(p, 'status', '--porcelain')).toBe('')
    expect(await between(t0)).toEqual({ changed: true, paths: ['a.txt'] })
  })

  it('a write in an ignored folder (out/, node_modules) does not count', async () => {
    mkdirSync(join(p, 'out'))
    mkdirSync(join(p, 'node_modules'))
    const t0 = Date.now()
    writeFileSync(join(p, 'out', 'bundle.js'), 'x')
    writeFileSync(join(p, 'node_modules', 'x.js'), 'x')
    expect(await between(t0)).toEqual({ changed: false, paths: [] })
    // A tracked file beside them still does.
    writeFileSync(join(p, 'a.txt'), 'b\n')
    expect((await between(t0)).paths).toEqual(['a.txt'])
  })

  it("an agent's edit hook counts in its folder", async () => {
    const t0 = Date.now()
    o.markEdits([join(p, 'src', 'x.ts')])
    o.markEdits([join(tempDir('hive-observe-elsewhere-'), 'y.ts')])
    expect((await between(t0)).paths).toEqual([':edit'])
  })

  it("a worktree's commit moves its line and its folder; its writes are its own", async () => {
    const wt = join(tempDir('hive-observe-wt-'), 'wt')
    run(p, 'worktree', 'add', '-q', '-b', 'feature', wt)
    await vi.waitFor(() => expect(o.size.folders).toBe(2), { timeout: HUNG_MS })
    // Adding it can cost the main folder's watch an unnamed event (Windows lost track): its record restarts.
    await armed(o, wt)
    await armed(o, p)
    const t0 = Date.now()
    const from = run(wt, 'rev-parse', 'HEAD')
    const to = commit(wt, 'w.txt', 'w\n')
    await seen({ kind: 'lineMoved', line: 'feature', from, to })
    await seen({ kind: 'folderMoved', folder: wt, from, to })
    const inWt = await o.changedBetween(wt, t0, Date.now())
    expect(isUnknown(inWt) ? inWt : inWt.paths).toEqual(expect.arrayContaining([':reflog', 'w.txt']))
    // The main folder saw neither.
    expect(await between(t0)).toEqual({ changed: false, paths: [] })
    expect(events.some((e) => e.kind === 'folderMoved' && e.folder === p)).toBe(false)
  })

  it('a line moved only in packed-refs is seen', async () => {
    const first = run(p, 'rev-parse', 'HEAD')
    run(p, 'branch', 'side')
    const second = commit(p, 'b.txt', 'b\n')
    await seen({ kind: 'lineMoved', line: 'side', to: first })
    await seen({ kind: 'lineMoved', line: 'main', to: second })
    run(p, 'pack-refs', '--all')
    events.length = 0
    const packed = join(p, '.git', 'packed-refs')
    const text = readFileSync(packed, 'utf8')
    writeFileSync(packed, text.replace(`${first} refs/heads/side`, `${second} refs/heads/side`))
    await seen({ kind: 'lineMoved', line: 'side', from: first, to: second })
  })

  it('a line deleted is said, moving to nothing', async () => {
    run(p, 'branch', 'gone')
    const at = run(p, 'rev-parse', 'gone')
    await seen({ kind: 'lineMoved', line: 'gone', to: at })
    run(p, 'branch', '-q', '-D', 'gone')
    await seen({ kind: 'lineMoved', line: 'gone', from: at, to: null })
  })

  it('a time before the watch started, or a folder not watched, is unknown', async () => {
    expect(isUnknown(await o.changedBetween(p, Date.now() - 60_000, Date.now()))).toBe(true)
    // Just started: not armed yet.
    const fresh = new Observer()
    const q = repo()
    fresh.follow([{ path: q, platform: 'git', root: q }])
    expect(isUnknown(await fresh.changedBetween(q, Date.now() - 1, Date.now()))).toBe(true)
    fresh.dispose()
    expect(isUnknown(await o.changedBetween(tempDir('hive-observe-not-'), Date.now(), Date.now()))).toBe(true)
  })
})

describe('the watcher on a None folder', () => {
  let o: Observer
  afterEach(() => o.dispose())

  it('says what was written, for the hash cache', async () => {
    const p = tempDir('hive-observe-none-')
    o = new Observer()
    o.follow([{ path: p, platform: 'none' }])
    const written: string[] = []
    o.subscribe(p, (e) => void (e.kind === 'written' && written.push(...e.paths)))
    await armed(o, p)
    const t0 = Date.now()
    // A folder made: written before its own watch is armed, its files may not be seen, so the folder itself is.
    mkdirSync(join(p, 'docs'))
    writeFileSync(join(p, 'docs', 'a.md'), 'a')
    await vi.waitFor(() => expect(written).toContain('docs'), { timeout: HUNG_MS })
    // Once watched, each file written in it is.
    await vi.waitFor(
      () => {
        writeFileSync(join(p, 'docs', 'b.md'), String(Date.now()))
        expect(written).toContain('docs/b.md')
      },
      { timeout: HUNG_MS }
    )
    const r = await o.changedBetween(p, t0, Date.now(), (paths) => paths.filter((f) => f === 'docs' || f.startsWith('docs/')))
    expect(isUnknown(r) ? r : r.paths).toEqual(expect.arrayContaining(['docs', 'docs/b.md']))
  })

  it('a folder gone and back (#964): its watch ends, starts again, and the time between is unknown', async () => {
    const parent = tempDir('hive-observe-gone-')
    const p = join(parent, 'project')
    mkdirSync(p)
    o = new Observer()
    o.follow([{ path: p, platform: 'none' }])
    await armed(o, p)
    const t0 = Date.now()
    renameSync(p, join(parent, 'away'))
    mkdirSync(p)
    // Back, and watched again: writes from now on are recorded.
    await vi.waitFor(
      async () => {
        const t1 = Date.now()
        writeFileSync(join(p, 'x.txt'), String(t1))
        const r = await o.changedBetween(p, t1, Date.now())
        expect(isUnknown(r) ? null : r.paths).toEqual(['x.txt'])
      },
      { timeout: HUNG_MS }
    )
    // Across the gap: never "nothing changed".
    expect(isUnknown(await o.changedBetween(p, t0, Date.now()))).toBe(true)
  })
})

describe("the app's watcher follows the open workspaces", () => {
  afterEach(() => stopObserving())

  it('watches their repositories and folders, and closes them when the workspace closes', async () => {
    const ws = tempDir('hive-observe-ws-')
    const git = join(ws, 'gitty')
    mkdirSync(git)
    run(git, 'init', '-q', '-b', 'main')
    mkdirSync(join(ws, 'plain'))
    const w = createWorkspaceService()
    startObserving()
    try {
      await w.open(ws)
      await vi.waitFor(() => expect(observer.size).toEqual({ repos: 1, folders: 2 }), { timeout: HUNG_MS })
      await w.close()
      expect(observer.size).toEqual({ repos: 0, folders: 0 })
    } finally {
      await disposeWorkspaceService(w)
    }
  })

  it('a folder being deleted or removed is let go meanwhile, and watched again after', async () => {
    const o = new Observer()
    const p = repo()
    const wt = join(tempDir('hive-observe-sus-'), 'wt')
    run(p, 'worktree', 'add', '-q', '-b', 'feature', wt)
    o.follow([{ path: p, platform: 'git', root: p }])
    expect(o.size).toEqual({ repos: 1, folders: 2 })
    // A worktree being removed: only its write log goes.
    const resume = o.suspend([wt])
    expect(o.size).toEqual({ repos: 1, folders: 1 })
    run(p, 'worktree', 'remove', '--force', wt)
    resume()
    expect(o.size).toEqual({ repos: 1, folders: 1 })
    // The project being deleted: everything in it goes, until resumed.
    const again = o.suspend([p])
    expect(o.size).toEqual({ repos: 0, folders: 0 })
    again()
    again()
    expect(o.size).toEqual({ repos: 1, folders: 1 })
    await armed(o, p)
    o.dispose()
  })

  it("a Git project whose repository is gone watches nothing, never a repository above it", () => {
    const o = new Observer()
    const outer = repo()
    const p = join(outer, 'inner')
    mkdirSync(p)
    o.follow([{ path: p, platform: 'git' }])
    expect(o.size).toEqual({ repos: 0, folders: 0 })
    o.dispose()
  })

  it('follow() closes what it no longer needs; dispose closes everything', () => {
    const o = new Observer()
    const p = repo()
    const n = tempDir('hive-observe-n-')
    o.follow([
      { path: p, platform: 'git', root: p },
      { path: n, platform: 'none' }
    ])
    expect(o.size).toEqual({ repos: 1, folders: 2 })
    o.follow([{ path: n, platform: 'none' }])
    expect(o.size).toEqual({ repos: 0, folders: 1 })
    o.dispose()
    expect(o.size).toEqual({ repos: 0, folders: 0 })
  })
})
