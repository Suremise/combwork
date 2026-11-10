// A jj project's repository watch (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3), on the real jj in both Git-backed
// modes, through a test's watch (counted and driven): three subscriptions whatever the repository holds; a slot-only
// commit (no bookmark moved) reported as a new operation; a bookmark move as its line; a change under a retained bundle's
// pins as that bundle's invalidation; refs gone and back re-armed, every bundle marked due; disposal leaves nothing.
// Skipped without the fetched jj (npm run jj:fetch).
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ObserveEvent } from '../src/main/platform/history'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { jjRepoWatch, type WatchFn } from '../src/main/platform/jjRepoWatch'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'

/** A test's watch: each subscription by folder, its callback and its close/error handlers. */
function fakeWatch() {
  const subs = new Map<string, { fn: (f: string | null) => void; closed: boolean; lost: (() => void)[] }>()
  const watch: WatchFn = (dir, _o, fn) => {
    const s = { fn, closed: false, lost: [] as (() => void)[] }
    subs.set(dir, s)
    return {
      close: () => void (s.closed = true),
      on: (_e: string, f: () => void) => s.lost.push(f)
    }
  }
  const live = () => [...subs.entries()].filter(([, s]) => !s.closed)
  return { watch, subs, live, fire: (dirEnd: string, file: string | null) => live().find(([d]) => d.endsWith(dirEnd))?.[1].fn(file) }
}

describe.skipIf(!jjExe)(`a jj project's repository watch (jj ${TESTED_JJ.version}), HI-2882`, () => {
  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it('three subscriptions; operations, bookmarks and retained pins reported; refs re-armed; disposed', async () => {
      const h = harness()
      const { repo, root } = h.repo(`watch${colocated ? 'c' : 'n'}`, colocated)
      const d = await jjContextOf(repo, h.runner)
      if (!('jj' in d)) throw new Error('no jj context')
      const where = { jjRepo: d.jj.jjRepo, store: d.jj.store }
      const f = fakeWatch()
      const events: ObserveEvent[] = []
      const rw = jjRepoWatch(repo, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, where })
      expect(rw.open()).toBe(3)
      // Attached: every retained bundle marked due once (a pin deleted while Combwork was closed is checked, HR1's round 1).
      expect(events).toEqual([{ kind: 'invalidated', project: repo, what: 'retained:*' }])
      events.length = 0
      // A slot-only commit: a new operation, no bookmark moved.
      const slot = join(root, 'slot-x')
      h.jj(repo, 'workspace', 'add', '--name', 'slot-x', slot)
      writeFileSync(join(slot, 'x.txt'), 'x\n')
      h.jj(slot, 'commit', '-m', 'x')
      f.fire(join('op_heads', 'heads'), null)
      expect(events.some((e) => e.kind === 'folderMoved')).toBe(true)
      expect(events.some((e) => e.kind === 'lineMoved')).toBe(false)
      // The bookmark moved by the user: an operation; a branch ref's change (colocated: its Git ref) asks for a run, with
      // nothing read on main (no line: jj's reconciliation needs none).
      events.length = 0
      h.jj(repo, 'bookmark', 'set', 'main', '-r', h.id(slot, 'slot-x@-'))
      rw.tick()
      expect(events.some((e) => e.kind === 'folderMoved')).toBe(true)
      f.fire('refs', join('heads', 'main'))
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'refs' })
      expect(events.some((e) => e.kind === 'lineMoved')).toBe(false)
      // A change under a retained bundle's pins: that bundle due. 500 bundles: still three subscriptions.
      events.length = 0
      const head = h.id(repo, 'main')
      for (let i = 0; i < 500; i++) {
        const p = join(where.store, 'refs', 'cw', 'jj-integrated', 'AM-1', '1', `b1-x${i}`)
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'revision'), `${head}\n`)
      }
      f.fire('refs', join('cw', 'jj-integrated', 'AM-1', '1', 'b1-x7', 'revision'))
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'retained:AM-1:1:b1-x7' })
      expect(rw.open()).toBe(3)
      // The refs watch lost (its folder deleted, then back): re-armed by the tick, every bundle marked due.
      events.length = 0
      const refsSub = f.live().find(([dir]) => dir.endsWith('refs'))![1]
      refsSub.closed = true
      for (const l of refsSub.lost) l()
      expect(rw.open()).toBe(2)
      rw.tick()
      expect(rw.open()).toBe(3)
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'retained:*' })
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'tick' })
      rw.dispose()
      expect(rw.open()).toBe(0)
      expect(f.live()).toEqual([])
      rmSync(join(where.store, 'refs', 'cw'), { recursive: true, force: true })
      void execFileSync
    })
  })
})
