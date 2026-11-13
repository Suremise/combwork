// HI-3121, settled: whether a jj builder's own check (`cw-progress --check`, JjPlatform.checkRun's bracket) counts when its
// command writes a file the repository ignores. The production bracket (jjCheckStart, jjCheckEnd, jjCredit) on real jj,
// in a slot as the app makes one (a second jj workspace beside the project's), the production Observer following the
// project as the app does. A slot is no Git worktree, so the Observer keeps no write record for it: the credit rests on
// the stat snapshot of the revision's files and of their folders, the workspace's root included. What that does:
// - a write inside a folder that is already there (an `out/` an earlier build made) changes none of those: credited;
// - a run that makes (or removes) an entry in the root or in a folder holding a tracked file changes that folder's time:
//   not credited (`changed`), whether jj ignores the entry or not. A first build's new `out/`, a `__pycache__/` beside a
//   tracked `.py`: the run after it is credited. A build that deletes its output folder and makes it again each time never is.
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
    it(`${colocate ? 'colocated' : 'not colocated'}: credited for writes into an existing folder; not for a run that makes a new entry where the revision has files`, async () => {
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
      // A first build: out/ is new in the root. Not credited; the next one, writing into it, is.
      const first = await run(() => {
        mkdirSync(join(root, 'out'))
        writeFileSync(join(root, 'out', 'bundle.js'), 'built\n')
      })
      expect(first).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
      expect(credited(await run(() => writeFileSync(join(root, 'out', 'bundle.js'), 'built again\n')))).toBe(true)
      expect(credited(await run(() => writeFileSync(join(root, 'out', 'chunk.js'), 'more\n')))).toBe(true)
      // A build that removes its output folder and makes it again each time: never credited.
      for (let i = 0; i < 2; i++) {
        const clean = await run(() => {
          rmSync(join(root, 'out'), { recursive: true, force: true })
          mkdirSync(join(root, 'out'))
          writeFileSync(join(root, 'out', 'bundle.js'), `clean ${i}\n`)
        })
        expect(clean).toMatchObject({ whyNot: 'changed', why: 'end:stats' })
      }
      // A new ignored file in the root, and a new ignored folder beside a tracked file: not credited; once there, credited.
      expect(await run(() => writeFileSync(join(root, 'cache.tmp'), 'x\n'))).toMatchObject({ whyNot: 'changed' })
      expect(credited(await run(() => writeFileSync(join(root, 'cache.tmp'), 'y\n')))).toBe(true)
      expect(
        await run(() => {
          mkdirSync(join(root, 'src', '__pycache__'))
          writeFileSync(join(root, 'src', '__pycache__', 'a.pyc'), 'x\n')
        })
      ).toMatchObject({ whyNot: 'changed' })
      expect(credited(await run(() => writeFileSync(join(root, 'src', '__pycache__', 'a.pyc'), 'y\n')))).toBe(true)
    })
  }
})
