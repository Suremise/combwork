// HI-3121, settled: whether a jj builder's own check (`cw-progress --check`, JjPlatform.checkRun's bracket) counts when its
// command writes a file the repository ignores. The production bracket (jjCheckStart, jjCheckEnd, jjCredit) on real jj,
// in a slot as the app makes one (a second jj workspace beside the project's), the production Observer following the
// project as the app does. A slot not colocated is no Git worktree, so the Observer keeps no write record for it: the credit rests on
// the stat snapshot of the revision's files and of their folders, the workspace's root included. What that does:
// - a write inside a folder that is already there (an `out/` an earlier build made) changes none of those: credited;
// - a run that makes (or removes) an entry in the root or in a folder holding a tracked file changes that folder's time.
//   HI-3158: where every entry that came, went or was made again is one jj ignores (a first build's new `out/`, a
//   `__pycache__/` beside a tracked `.py`, a build that deletes its output folder and makes it again each time), the run
//   is credited; a new entry jj doesn't ignore still makes it `changed`.
// Colocated, the slot is also a Git worktree, whose write record the Observer keeps (HI-3160): that record, less what jj
// ignores, decides instead of the stat snapshot, with the same outcomes.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { Observer } from '../src/main/platform/observe'
import { readRepoRefs } from '../src/main/platform/repoRefs'
import { isUnknown } from '../src/main/platform/types'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { jjCheckEnd, jjCheckStart, jjCounts, jjCredit, type JjCheckFor, type JjCheckStart } from '../src/main/platform/jjChecks'
import { entriesChanged, ignoredOnly, jjEntries, RUN_NAMES_MAX, RUN_READS_AT_ONCE, RUN_READS_QUEUED, RunWatch, type Kind, type WatchedNames } from '../src/main/platform/jjIgnoredEntries'
import type { ViewOf } from '../src/main/platform/jjView'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

/** A bound for a hung run's waits (tests/README.md). */
const HUNG_MS = 15_000

const profile = tempDir('cw-jjignored-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(profile, 'profile')

describe.skipIf(!jjExe)('HI-3121: a jj builder’s check in its slot that writes ignored files', { timeout: 180_000 }, () => {
  const h = harness()
  const o = new Observer()
  afterAll(() => o.dispose())

  for (const colocate of [true, false]) {
    it(`${colocate ? 'colocated' : 'not colocated'}: credited for writes jj ignores, a new or remade output folder included; not for a new file it doesn't ignore`, async () => {
      const parent = tempDir('jjign-')
      const project = join(parent, 'project')
      mkdirSync(project)
      h.jj(project, 'git', 'init', colocate ? '--colocate' : '--no-colocate')
      writeFileSync(join(project, '.gitignore'), 'out/\n*.tmp\n__pycache__/\n')
      mkdirSync(join(project, 'src'))
      writeFileSync(join(project, 'src', 'a.py'), 'print(1)\n')
      h.jj(project, 'commit', '-m', 'base')
      writeFileSync(join(project, 'k.txt'), 'card K\n')
      h.jj(project, 'commit', '-m', 'K')
      // The slot: a jj workspace of its own, at the card's revision (an empty @ on it), as the pool makes one.
      const slot = join(parent, 'slot-a')
      const R = h.jj(project, '--ignore-working-copy', 'log', '--no-graph', '-r', '@-', '-T', 'commit_id').trim()
      // As the pool's add (jjWorkspacePort.ts): colocation as the project's (HR1's round 1), full sparse patterns.
      h.jj(project, 'workspace', 'add', slot, '--name', 'slot-a', '-r', R, '--sparse-patterns', 'full', colocate ? '--colocate' : '--no-colocate')
      // HR1's round 1: what the slot is to Git. Colocated, jj gives it a .git of its own; the Observer's write records are
      // the Git worktrees its repository lists (repoRefs' foldersOf: the main folder and .git/worktrees/*).
      expect(existsSync(join(slot, '.git'))).toBe(colocate)
      if (colocate) {
        const listed = readRepoRefs(join(resolve(realpathSync.native(project)), '.git'), 100).folders.map((f) => resolve(f.folder).toLowerCase())
        // jj registers it in .git/worktrees with a relative gitdir, which foldersOf resolves against that entry, as Git
        // does (HI-3160): the slot is listed.
        const common = join(resolve(realpathSync.native(project)), '.git')
        const gitdir = readFileSync(join(common, 'worktrees', 'slot-a', 'gitdir'), 'utf8').trim()
        console.log('slot .git is a', statSync(join(slot, '.git')).isDirectory() ? 'folder' : 'file', '; worktrees/slot-a/gitdir:', gitdir, '; the repository lists', listed)
        expect(isAbsolute(gitdir)).toBe(false)
        expect(listed).toContain(resolve(realpathSync.native(project)).toLowerCase())
        expect(listed).toContain(resolve(realpathSync.native(slot)).toLowerCase())
      }
      const root = resolve(realpathSync.native(slot))
      const d = await jjContextOf(root, h.runner)
      if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
      const view: ViewOf = { jjRepo: d.jj.jjRepo, workspace: d.jj.workspace, root: d.jj.root, store: d.jj.store, colocated: d.jj.colocated }
      // The Observer follows the project as the app does; a slot not colocated has no write record of its own.
      const pr = resolve(realpathSync.native(project))
      o.follow([{ path: pr, platform: 'jj' as never, root: pr }])
      if (!colocate) expect(isUnknown(await o.changedBetween(root, Date.now(), Date.now(), jjCounts))).toBe(true)

      // A builder's check: the repository's scope (no `scope`), as JjPlatform.checkRun brackets it.
      const run = async (write: ((start: JjCheckStart) => void | Promise<void>) | null) => {
        const f: JjCheckFor = { view, folder: root, revision: R, owner: { still: () => true }, lock: (fn) => fn() }
        const start = await jjCheckStart(f, o, { runner: h.runner })
        await write?.(start)
        return jjCredit(await jjCheckEnd(f, start, o, { runner: h.runner }))
      }
      const credited = (c: { whyNot?: string; tested: string }) => !c.whyNot && c.tested === R
      // What decides a run that isn't credited: the slot's write record, colocated (HI-3160); else the stat snapshot.
      const decides = colocate ? 'end:written' : 'end:stats'
      expect(credited(await run(null))).toBe(true)
      // A first build: out/ is new in the root, and ignored: credited, as the next one, writing into it, is.
      const first = await run(() => {
        mkdirSync(join(root, 'out'))
        writeFileSync(join(root, 'out', 'bundle.js'), 'built\n')
      })
      expect(credited(first)).toBe(true)
      expect(credited(await run(() => writeFileSync(join(root, 'out', 'bundle.js'), 'built again\n')))).toBe(true)
      expect(credited(await run(() => writeFileSync(join(root, 'out', 'chunk.js'), 'more\n')))).toBe(true)
      // HI-3158: a build that removes its output folder and makes it again each time: credited every time.
      for (let i = 0; i < 2; i++) {
        const clean = await run(() => {
          rmSync(join(root, 'out'), { recursive: true, force: true })
          mkdirSync(join(root, 'out'))
          writeFileSync(join(root, 'out', 'bundle.js'), `clean ${i}\n`)
        })
        expect(credited(clean)).toBe(true)
      }
      // A new ignored file in the root, a new ignored folder beside a tracked file, and either removed: credited.
      expect(credited(await run(() => writeFileSync(join(root, 'cache.tmp'), 'x\n')))).toBe(true)
      expect(credited(await run(() => writeFileSync(join(root, 'cache.tmp'), 'y\n')))).toBe(true)
      expect(credited(await run(() => rmSync(join(root, 'cache.tmp'))))).toBe(true)
      const pyc = (): void => {
        mkdirSync(join(root, 'src', '__pycache__'))
        writeFileSync(join(root, 'src', '__pycache__', 'a.pyc'), 'x\n')
      }
      expect(credited(await run(pyc))).toBe(true)
      expect(credited(await run(() => writeFileSync(join(root, 'src', '__pycache__', 'a.pyc'), 'y\n')))).toBe(true)
      expect(credited(await run(() => rmSync(join(root, 'src', '__pycache__'), { recursive: true })))).toBe(true)
      // A new file jj doesn't ignore, in the root or beside a tracked file, alone or with ignored ones: not credited. jj's
      // end boundary records it in @; once it is deleted, the next start records that (`dirty`), and @ is empty again.
      const resync = async (): Promise<void> => {
        expect(await run(null)).toMatchObject({ whyNot: 'dirty' })
        expect(credited(await run(null))).toBe(true)
      }
      expect(await run(() => writeFileSync(join(root, 'new.txt'), 'x\n'))).toMatchObject({ whyNot: 'changed' })
      rmSync(join(root, 'new.txt'))
      await resync()
      expect(
        await run(() => {
          writeFileSync(join(root, 'src', 'b.py'), 'x\n')
          pyc()
        })
      ).toMatchObject({ whyNot: 'changed' })
      rmSync(join(root, 'src', 'b.py'))
      rmSync(join(root, 'src', '__pycache__'), { recursive: true })
      await resync()
      expect(
        await run(() => {
          rmSync(join(root, 'out'), { recursive: true, force: true })
          mkdirSync(join(root, 'out'))
          writeFileSync(join(root, 'stray.txt'), 'x\n')
        })
      ).toMatchObject({ whyNot: 'changed' })
      rmSync(join(root, 'stray.txt'))
      await resync()
      // HR1's round 1: a file jj doesn't ignore made and deleted during the run, beside a new ignored folder: neither
      // listing has it, and jj's end boundary finds nothing, but the run's watch saw it.
      expect(
        await run(() => {
          rmSync(join(root, 'out'), { recursive: true, force: true })
          mkdirSync(join(root, 'out'))
          writeFileSync(join(root, 'stray.txt'), 'read by the check\n')
          rmSync(join(root, 'stray.txt'))
        })
      ).toMatchObject({ whyNot: 'changed', why: decides })
      expect(
        await run(() => {
          pyc()
          writeFileSync(join(root, 'src', 'gen.py'), 'x\n')
          rmSync(join(root, 'src', 'gen.py'))
        })
      ).toMatchObject({ whyNot: 'changed', why: decides })
      rmSync(join(root, 'src', '__pycache__'), { recursive: true })
      // HR2's round 2: a file named `out` (the rule is `out/`, folders only) made where out/ was, read as a file by the
      // watch before it's deleted and out/ made again. (Gone before it's read: the residual, Darren's r36.)
      expect(
        await run(async (start) => {
          rmSync(join(root, 'out'), { recursive: true, force: true })
          writeFileSync(join(root, 'out'), 'read by the check\n')
          await vi.waitFor(() => expect(start.watch?.seen().get('.')?.get('out')?.has('f')).toBe(true), { timeout: HUNG_MS })
          rmSync(join(root, 'out'))
          mkdirSync(join(root, 'out'))
        })
      ).toMatchObject({ whyNot: 'changed', why: decides })
      expect(credited(await run(() => rmSync(join(root, 'out'), { recursive: true })))).toBe(true)

      // The same, asked directly, for a file jj doesn't track (`snapshot.auto-track` narrowed: HI-3096), which no end
      // boundary would record.
      const files = ['.gitignore', 'k.txt', 'src/a.py']
      const watched = async (change: () => void) => {
        const before = await jjEntries(root, ['.', 'src'])
        const w = RunWatch.start(root, ['.', 'src'])!
        await w.armed()
        change()
        return ignoredOnly(root, ['.'], { files, before, watched: await w.settle() })
      }
      expect(await watched(() => writeFileSync(join(root, 'cache2.tmp'), 'x\n'))).toEqual(['.'])
      expect(await watched(() => writeFileSync(join(root, 'untracked.txt'), 'x\n'))).toBeNull()
      rmSync(join(root, 'untracked.txt'))
      // A write to a tracked file named by the watch is its own line's to decide.
      const tracked = (): void => {
        writeFileSync(join(root, 'k.txt'), 'card K\n')
        rmSync(join(root, 'cache2.tmp'))
      }
      expect(await watched(tracked)).toEqual(['.'])
    })
  }
})

describe('HI-3158: a moved folder explained only by names jj ignores, by every kind each had', () => {
  /** A jj workspace's root as ignoredOnly reads it: a Git-backed store (no jj, no git run to make it) and `.gitignore`. */
  const workspace = (store: boolean): string => {
    const root = tempDir('jjign-unit-')
    if (store) {
      const s = join(root, '.jj', 'repo', 'store')
      mkdirSync(join(s, 'git', 'objects'), { recursive: true })
      mkdirSync(join(s, 'git', 'refs'))
      writeFileSync(join(s, 'git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(s, 'type'), 'git\n')
      writeFileSync(join(s, 'git_target'), 'git\n')
    }
    writeFileSync(join(root, '.gitignore'), 'out/\n*.tmp\n')
    writeFileSync(join(root, 'k.txt'), 'k\n')
    return root
  }
  type Saw = Record<string, Kind[]> | null
  const kinds = (saw: Saw): WatchedNames => new Map([['.', saw ? new Map(Object.entries(saw).map(([n, k]) => [n, new Set(k)])) : null]])
  const dir = (r: string, n: string) => mkdirSync(join(r, n))
  const file = (r: string, n: string) => writeFileSync(join(r, n), 'x\n')
  const rm = (r: string, n: string) => rmSync(join(r, n), { recursive: true })
  const rows: { case: string; setup?: (r: string) => void; change: (r: string) => void; saw: Saw; store?: false; credited: boolean }[] = [
    { case: 'a first build: a new ignored folder', change: (r) => dir(r, 'out'), saw: { out: ['d'] }, credited: true },
    { case: 'a clean build: the ignored folder made again', setup: (r) => dir(r, 'out'), change: (r) => (rm(r, 'out'), dir(r, 'out')), saw: { out: ['d'] }, credited: true },
    { case: 'an ignored file made and deleted', change: () => undefined, saw: { 'x.tmp': ['f'] }, credited: true },
    { case: 'an ignored file deleted (gone when read)', setup: (r) => file(r, 'x.tmp'), change: (r) => rm(r, 'x.tmp'), saw: { 'x.tmp': [] }, credited: true },
    { case: 'HR1: a file not ignored made and deleted beside a new ignored folder', change: (r) => dir(r, 'out'), saw: { out: ['d'], 'stray.txt': [] }, credited: false },
    { case: 'HR2: a file named as the folder-only `out/` read while it was there', setup: (r) => dir(r, 'out'), change: (r) => (rm(r, 'out'), dir(r, 'out')), saw: { out: ['f', 'd'] }, credited: false },
    { case: 'r36’s residual: that file gone before it was read', setup: (r) => dir(r, 'out'), change: (r) => (rm(r, 'out'), dir(r, 'out')), saw: { out: ['d'] }, credited: true },
    { case: 'a file named as the folder, left there', setup: (r) => dir(r, 'out'), change: (r) => (rm(r, 'out'), file(r, 'out')), saw: { out: ['d'] }, credited: false },
    { case: 'a new file not ignored', change: (r) => file(r, 'new.txt'), saw: { 'new.txt': ['f'] }, credited: false },
    { case: 'an entry that couldn’t be read', change: (r) => dir(r, 'out'), saw: { out: ['?'] }, credited: false },
    { case: 'the watch lost events', change: (r) => dir(r, 'out'), saw: null, credited: false },
    { case: 'a change the watch didn’t name', change: (r) => (dir(r, 'out'), file(r, 'y.tmp')), saw: { out: ['d'] }, credited: false },
    { case: 'nothing named but the revision’s own file (its line decides)', change: () => undefined, saw: { 'k.txt': ['f'] }, credited: false },
    { case: 'no Git store to ask', change: (r) => dir(r, 'out'), saw: { out: ['d'] }, store: false, credited: false }
  ]
  it.each(rows)('$case: credited $credited', async (row) => {
    const root = workspace(row.store !== false)
    row.setup?.(root)
    const before = await jjEntries(root, ['.'])
    row.change(root)
    const got = await ignoredOnly(root, ['.'], { files: ['.gitignore', 'k.txt'], before, watched: kinds(row.saw) })
    expect(got).toEqual(row.credited ? ['.'] : null)
  })
})

describe('HI-3158, HR2’s round 3: a run watch’s kind reads are bounded', () => {
  /** A watch whose events the test sends, and a stat that answers only when the test lets it. */
  const fakes = () => {
    const emit = new Map<string, (name: string | null) => void>()
    const pending: (() => void)[] = []
    const seams = {
      watch: (path: string, onEvent: (name: string | null) => void) => {
        emit.set(path, onEvent)
        return { on: () => undefined, close: () => undefined } as never
      },
      lstat: () => new Promise<{ isDirectory(): boolean }>((r) => pending.push(() => r({ isDirectory: () => false })))
    }
    return { emit, pending, seams, release: () => pending.splice(0).forEach((p) => p()) }
  }
  it('reads a few at a time, a name once however many its events; past the queue its folder is incomplete and nothing more of it is read', async () => {
    const root = tempDir('jjign-burst-')
    const f = fakes()
    const w = RunWatch.start(root, ['.', 'src'], f.seams)!
    const send = f.emit.get(join(root, '.'))!
    for (let i = 0; i < 1000; i++) send('same.tmp')
    expect([w.reads, f.pending.length]).toEqual([1, 1])
    // Seven more read at once (eight with same.tmp), and a full queue behind them.
    for (let i = 0; i < RUN_READS_AT_ONCE - 1 + RUN_READS_QUEUED; i++) send(`n${i}.tmp`)
    expect(w.reads).toBe(RUN_READS_AT_ONCE)
    expect(w.seen().get('.')).not.toBeNull()
    // One more waiting than the queue holds: the root's watch can't be complete.
    send('one-too-many.tmp')
    expect(w.seen().get('.')).toBeNull()
    expect(f.pending.length).toBe(RUN_READS_AT_ONCE)
    send('after.tmp')
    expect(f.pending.length).toBe(RUN_READS_AT_ONCE)
    // Another folder's watch is still whole, and its reads wait for room.
    f.emit.get(join(root, 'src'))!('gen.tmp')
    for (let i = 0; i < 5 && f.pending.length; i++) {
      f.release()
      await new Promise<void>((r) => setImmediate(r))
    }
    const seen = await w.settle()
    expect(seen.get('.')).toBeNull()
    expect([...(seen.get('src')?.get('gen.tmp') ?? [])]).toEqual(['f'])
  })
  it('a folder past its names limit is incomplete', async () => {
    const root = tempDir('jjign-names-')
    const f = fakes()
    const w = RunWatch.start(root, ['.'], { ...f.seams, lstat: () => Promise.resolve({ isDirectory: () => false }) })!
    const send = f.emit.get(join(root, '.'))!
    // In batches the queue holds, each read before the next.
    for (let i = 0; i < RUN_NAMES_MAX; i += RUN_READS_QUEUED) {
      for (let j = i; j < Math.min(i + RUN_READS_QUEUED, RUN_NAMES_MAX); j++) send(`n${j}`)
      await vi.waitFor(() => expect(w.reads).toBe(0), { timeout: HUNG_MS })
    }
    expect(w.seen().get('.')).not.toBeNull()
    send('one-more')
    expect(w.seen().get('.')).toBeNull()
    w.close()
  })
})

describe('HI-3158: the entries that came, went or were made again in a folder', () => {
  const was = new Map([
    ['out', 'd:1'],
    ['a.txt', 'f:2'],
    ['.jj', 'd:3']
  ])
  it('names each, jj’s own folders left out of the root', () => {
    expect(entriesChanged('.', was, new Map([['a.txt', 'f:2'], ['out', 'd:9'], ['x.tmp', 'f:5']]))).toEqual(['out', 'x.tmp'])
    expect(entriesChanged('src', new Map([['p', 'd:1']]), new Map([['p', 'f:2']]))).toEqual(['p'])
    expect(entriesChanged('.', was, new Map([['a.txt', 'f:2'], ['out', 'd:1']]))).toEqual([])
    expect(entriesChanged('.', was, new Map(was))).toEqual([])
  })
  it('can’t say for an unreadable listing or entry', () => {
    expect(entriesChanged('.', null, was)).toBeNull()
    expect(entriesChanged('.', was, null)).toBeNull()
    expect(entriesChanged('.', was, new Map([...was, ['new', '?']]))).toBeNull()
    expect(entriesChanged('.', new Map([...was, ['b', '?']]), new Map([...was, ['b', '?']]))).toBeNull()
  })
})
