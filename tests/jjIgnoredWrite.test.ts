// HI-3121, settled: whether a jj builder's own check (`cw-progress --check`, JjPlatform.checkRun's bracket) counts when its
// command writes a file the repository ignores. The production bracket (jjCheckStart, jjCheckEnd, jjCredit) on real jj,
// in a slot as the app makes one (a second jj workspace beside the project's), the production Observer following the
// project as the app does. A slot is no Git worktree, so the Observer keeps no write record for it: the credit rests on
// the stat snapshot of the revision's files and of their folders, the workspace's root included. What that does:
// - a write inside a folder that is already there (an `out/` an earlier build made) changes none of those: credited;
// - a run that makes (or removes) an entry in the root or in a folder holding a tracked file changes that folder's time.
//   HI-3158: where every entry that came, went or was made again is one jj ignores (a first build's new `out/`, a
//   `__pycache__/` beside a tracked `.py`, a build that deletes its output folder and makes it again each time), the run
//   is credited; a new entry jj doesn't ignore still makes it `changed`.
// Colocated and not, the same: the slot's own folder is never watched either way.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { Observer } from '../src/main/platform/observe'
import { readRepoRefs } from '../src/main/platform/repoRefs'
import { isUnknown } from '../src/main/platform/types'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { jjCheckEnd, jjCheckStart, jjCounts, jjCredit, type JjCheckFor } from '../src/main/platform/jjChecks'
import { entriesChanged, ignoredOnly, jjEntries, RunWatch } from '../src/main/platform/jjIgnoredEntries'
import type { ViewOf } from '../src/main/platform/jjView'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

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
      // the Git worktrees its repository lists (repoRefs' foldersOf: the main folder and .git/worktrees/*): never the slot.
      expect(existsSync(join(slot, '.git'))).toBe(colocate)
      if (colocate) {
        const listed = readRepoRefs(join(resolve(realpathSync.native(project)), '.git'), 100).folders.map((f) => resolve(f.folder).toLowerCase())
        // jj registers it in .git/worktrees with a relative gitdir; foldersOf resolves that against the process's own
        // folder, not the git dir, so the folder it watches isn't the slot (HI-3121's finding, carded): the slot's own
        // folder has no write record, and the stat snapshot decides, as below.
        const common = join(resolve(realpathSync.native(project)), '.git')
        const gitdir = readFileSync(join(common, 'worktrees', 'slot-a', 'gitdir'), 'utf8').trim()
        console.log('slot .git is a', statSync(join(slot, '.git')).isDirectory() ? 'folder' : 'file', '; worktrees/slot-a/gitdir:', gitdir, '; the repository lists', listed)
        expect(isAbsolute(gitdir)).toBe(false)
        expect(listed).toContain(resolve(realpathSync.native(project)).toLowerCase())
        expect(listed).not.toContain(resolve(realpathSync.native(slot)).toLowerCase())
      }
      const root = resolve(realpathSync.native(slot))
      const d = await jjContextOf(root, h.runner)
      if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
      const view: ViewOf = { jjRepo: d.jj.jjRepo, workspace: d.jj.workspace, root: d.jj.root, store: d.jj.store, colocated: d.jj.colocated }
      // The Observer follows the project as the app does; the slot has no write record of its own.
      const pr = resolve(realpathSync.native(project))
      o.follow([{ path: pr, platform: 'jj' as never, root: pr }])
      expect(isUnknown(await o.changedBetween(root, Date.now(), Date.now(), jjCounts))).toBe(true)

      // A builder's check: the repository's scope (no `scope`), as JjPlatform.checkRun brackets it.
      const run = async (write: (() => void) | null) => {
        const f: JjCheckFor = { view, folder: root, revision: R, owner: { still: () => true }, lock: (fn) => fn() }
        const start = await jjCheckStart(f, o, { runner: h.runner })
        write?.()
        return jjCredit(await jjCheckEnd(f, start, o, { runner: h.runner }))
      }
      const credited = (c: { whyNot?: string; tested: string }) => !c.whyNot && c.tested === R
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
      ).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
      expect(
        await run(() => {
          pyc()
          writeFileSync(join(root, 'src', 'gen.py'), 'x\n')
          rmSync(join(root, 'src', 'gen.py'))
        })
      ).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
      rmSync(join(root, 'src', '__pycache__'), { recursive: true })
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

describe('HI-3158: a moved folder explained only by names jj ignores', () => {
  const root = tempDir('jjign-unit-')
  const before = new Map([['.', new Map([['out', 'd:1'], ['k.txt', 'f:2']])]])
  const ev = (names: string[] | null) => ({ files: ['k.txt'], before, watched: new Map([['.', names ? new Set(names) : null]]) })
  it('fails closed: a folder unwatched or watched incompletely, no names to explain the move, or a change the watch missed', async () => {
    // The listing at the end: `k.txt` only (out/ gone). No Git store here: nothing is ignored either way.
    writeFileSync(join(root, 'k.txt'), 'k\n')
    expect(await ignoredOnly(root, ['.'], ev(null))).toBeNull()
    expect(await ignoredOnly(root, ['.'], { ...ev([]), watched: null })).toBeNull()
    expect(await ignoredOnly(root, ['.'], ev([]))).toBeNull()
    expect(await ignoredOnly(root, ['.'], ev(['k.txt']))).toBeNull()
    expect(await ignoredOnly(root, ['.'], { ...ev(['out']), before: null })).toBeNull()
    expect(await ignoredOnly(root, ['.'], ev(['out']))).toBeNull()
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
