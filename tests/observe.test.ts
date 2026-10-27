// The platform watcher (#1214, SPEC §16.3.2 Observe, §16.13): on real temporary repositories, each change is seen
// within the debounce (a commit, a reset to the same commit, a checkout and back, an edit undone, a worktree's commit, a
// packed-refs rewrite), a write in an ignored folder doesn't count, a folder gone and back (#964) leaves its record
// unknown rather than empty, and the watches close when their workspace does.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { FILE_TIME_SLACK_MS, Observer, observer, type ObserveEvent } from '../src/main/platform/observe'
import { isUnknown } from '../src/main/platform/types'
import { tempDir } from './tempDir'

// A file's metadata as the write log reads it (HI-1767), changed for one path at a time: `fail` makes lstat and stat of
// it reject with that code; `link` makes it a link: lstat reports the link's own times, stat its target's.
const meta = vi.hoisted(() => ({ fail: new Map<string, string>(), link: new Map<string, { own: number; target: number }>() }))
vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  const key = (p: unknown): string => String(p).toLowerCase()
  const failing = (p: unknown): void => {
    const code = meta.fail.get(key(p))
    if (code) throw Object.assign(new Error(`${code}: stubbed, ${String(p)}`), { code })
  }
  const read = (which: 'stat' | 'lstat') =>
    (async (p: string, ...rest: unknown[]) => {
      failing(p)
      const s = await (real[which] as (...a: unknown[]) => Promise<import('fs').Stats>)(p, ...rest)
      const l = meta.link.get(key(p))
      if (!l) return s
      const at = which === 'lstat' ? l.own : l.target
      return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { mtimeMs: at, ctimeMs: at, isSymbolicLink: () => which === 'lstat' })
    }) as typeof real.stat
  const stat = read('stat')
  const lstat = read('lstat') as typeof real.lstat
  return { ...real, default: { ...real, stat, lstat }, stat, lstat }
})

const base = tempDir('hive-observe-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { startObserving, stopObserving } = await import('../src/main/platform/watching')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A repository on main with one commit (a.txt), `out/` and `node_modules/` ignored. */
function repo(): string {
  const p = tempDir('hive-observe-repo-')
  run(p, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  writeFileSync(join(p, '.gitignore'), 'out/\nnode_modules/\n')
  run(p, 'add', '-A')
  run(p, 'commit', '-q', '-m', 'one')
  return p
}

/**
 * Main's thread busy for a while, as under load (HI-1767): nothing else runs, so a watch's events wait. Not a wait for
 * a condition: what the test then checks is the write log's answer.
 */
const busy = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

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

  it("a write or a deletion just before the start, its event coming after it, doesn't count (HI-1767)", async () => {
    mkdirSync(join(p, 'sub'))
    commit(p, 'sub/c.txt', 'c\n')
    await seen({ kind: 'lineMoved', line: 'main' })
    await armed(o, p)
    // Written (as a check copy's reset or a merge writes), then main's thread busy past the write's times: the watch's
    // events can only come in after the start is taken.
    writeFileSync(join(p, 'a.txt'), 'late\n')
    rmSync(join(p, 'sub', 'c.txt'))
    busy(FILE_TIME_SLACK_MS + 50)
    const t0 = Date.now()
    expect(await between(t0)).toEqual({ changed: false, paths: [] })
    // Their events did come in, after the start: the write log has them, and the check left them out.
    await seen({ kind: 'written', folder: p, paths: ['a.txt'] })
    // A write after it still counts, however soon.
    const t1 = Date.now()
    writeFileSync(join(p, 'a.txt'), 'a\n')
    expect((await between(t1)).paths).toEqual(['a.txt'])
  })

  it("an edit undone during the run still counts when its file can't be read: never judged by its folder's age (HI-1767, HR2's round 1)", async () => {
    // The folder's own times well before the run: only the file's can say it was written meanwhile.
    busy(FILE_TIME_SLACK_MS + 50)
    const t0 = Date.now()
    writeFileSync(join(p, 'a.txt'), 'changed\n')
    writeFileSync(join(p, 'a.txt'), 'a\n')
    expect(run(p, 'status', '--porcelain')).toBe('')
    await seen({ kind: 'written', folder: p, paths: ['a.txt'] })
    try {
      for (const code of ['EACCES', 'EPERM', 'EIO']) {
        meta.fail.set(join(p, 'a.txt').toLowerCase(), code)
        expect(await between(t0)).toEqual({ changed: true, paths: ['a.txt'] })
      }
    } finally {
      meta.fail.clear()
    }
  })

  it("a link counts by its own times and its target's, the later: replaced meanwhile, or its target written through it (HI-1767)", async () => {
    busy(FILE_TIME_SLACK_MS + 50)
    const t0 = Date.now()
    writeFileSync(join(p, 'a.txt'), 'through the link\n')
    await seen({ kind: 'written', folder: p, paths: ['a.txt'] })
    const link = join(p, 'a.txt').toLowerCase()
    const old = t0 - 3_600_000
    try {
      // The link replaced during the run, pointing at a target last written an hour ago (stat alone reads the target).
      meta.link.set(link, { own: t0 + 10, target: old })
      expect(await between(t0)).toEqual({ changed: true, paths: ['a.txt'] })
      // Its target written through it during the run, the link itself an hour old.
      meta.link.set(link, { own: old, target: t0 + 10 })
      expect(await between(t0)).toEqual({ changed: true, paths: ['a.txt'] })
      // Both an hour old: the write was before the run, its event late.
      meta.link.set(link, { own: old, target: old })
      expect(await between(t0)).toEqual({ changed: false, paths: [] })
    } finally {
      meta.link.clear()
    }
  })

  it("a write in an ignored folder (out/, node_modules) does not count, an install's burst included", async () => {
    mkdirSync(join(p, 'out'))
    mkdirSync(join(p, 'node_modules', 'pkg'), { recursive: true })
    const t0 = Date.now()
    writeFileSync(join(p, 'out', 'bundle.js'), 'x')
    writeFileSync(join(p, 'node_modules', 'pkg', 'x.js'), 'x')
    expect(await between(t0)).toEqual({ changed: false, paths: [] })
    // A burst (an install) may overflow Windows' buffer: then unknown (the check uses its snapshot), never a change.
    await armed(o, p)
    const t1 = Date.now()
    for (let i = 0; i < 300; i++) writeFileSync(join(p, 'node_modules', 'pkg', `f${i}.js`), 'x')
    const burst = await o.changedBetween(p, t1, Date.now())
    expect(isUnknown(burst) ? null : burst).toEqual(isUnknown(burst) ? null : { changed: false, paths: [] })
    // A tracked file beside them still does.
    await armed(o, p)
    const t2 = Date.now()
    writeFileSync(join(p, 'a.txt'), 'b\n')
    expect((await between(t2)).paths).toEqual(['a.txt'])
  })

  it('a tracked file in node_modules counts, its edit undone too', async () => {
    mkdirSync(join(p, 'node_modules'))
    writeFileSync(join(p, 'node_modules', 'vendored.js'), 'v\n')
    run(p, 'add', '-f', 'node_modules/vendored.js')
    run(p, 'commit', '-q', '-m', 'vendored')
    await seen({ kind: 'lineMoved', line: 'main' })
    await armed(o, p)
    const t0 = Date.now()
    writeFileSync(join(p, 'node_modules', 'vendored.js'), 'changed\n')
    writeFileSync(join(p, 'node_modules', 'vendored.js'), 'v\n')
    expect(run(p, 'status', '--porcelain')).toBe('')
    expect(await between(t0)).toEqual({ changed: true, paths: ['node_modules/vendored.js'] })
  })

  it("a move made just before a refresh's follow is still said (the line's and the folder's)", async () => {
    const wt = join(tempDir('hive-observe-follow-'), 'wt')
    run(p, 'worktree', 'add', '-q', '-b', 'feature', wt)
    const a = run(p, 'rev-parse', 'HEAD')
    run(p, 'branch', 'side')
    await seen({ kind: 'lineMoved', line: 'side', to: a })
    await vi.waitFor(() => expect(o.size.folders).toBe(2), { timeout: HUNG_MS })
    const b = commit(wt, 'w.txt', 'w\n')
    await seen({ kind: 'lineMoved', line: 'feature', to: b })
    await seen({ kind: 'folderMoved', folder: wt, to: b })
    events.length = 0
    // Moved outside Hive, and a refresh follows the same projects at once, before the watch's own read.
    run(p, 'update-ref', 'refs/heads/side', b)
    run(wt, 'checkout', '-q', '--detach', a)
    o.follow([{ path: p, platform: 'git', root: p }])
    await seen({ kind: 'lineMoved', line: 'side', from: a, to: b })
    await seen({ kind: 'folderMoved', folder: wt, from: b, to: a })
    // Said once each, whatever reads follow.
    o.rescan()
    expect(events.filter((e) => e.kind === 'lineMoved' && e.line === 'side')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'folderMoved' && e.folder === wt)).toHaveLength(1)
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
    // The main folder saw neither: nothing changed, or unknown (its watch, which holds the shared .git, may overflow on
    // the objects the commit wrote there), never a change.
    const main = await o.changedBetween(p, t0, Date.now())
    expect(isUnknown(main) ? null : main).toEqual(isUnknown(main) ? null : { changed: false, paths: [] })
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

  it('never stops the project folder being renamed (no watch inside it holds a handle)', async () => {
    mkdirSync(join(p, 'src', 'deep'), { recursive: true })
    writeFileSync(join(p, 'src', 'deep', 'x.ts'), 'x')
    commit(p, 'src/y.ts', 'y\n')
    await seen({ kind: 'lineMoved', line: 'main' })
    const moved = `${p}-renamed`
    renameSync(p, moved)
    renameSync(moved, p)
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
