// A jj project's repository watch (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3), on the real jj in both Git-backed
// modes, through a test's watch (counted and driven): three subscriptions whatever the repository holds; a slot-only
// commit (no bookmark moved) reported as a new operation; a bookmark move as its line; a change under a retained bundle's
// pins as that bundle's invalidation; refs gone and back re-armed, every bundle marked due; disposal leaves nothing.
// HI-2977: where the repository is, asked again at each tick until jj answers, and a changed store followed.
// Skipped without the fetched jj (npm run jj:fetch).
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ObserveEvent } from '../src/main/platform/history'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { jjRepoWatch, type WatchFn, type Where } from '../src/main/platform/jjRepoWatch'
import { TESTED_JJ } from '../src/shared/jjTool'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

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

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15_000
/** Polls a condition until it holds, failing past `ms`. */
async function until(ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Settles what a tick started (its detection or store check, a test's own promise). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('where the repository is, asked again until jj answers, and its store followed (HI-2977)', () => {
  /** A repository's folders as the watch opens them (op heads, the store's refs), no jj needed. */
  function folders(name: string) {
    const top = tempDir(`jjrw-${name}-`)
    const jjRepo = join(top, '.jj', 'repo')
    const store = join(jjRepo, 'store', 'git')
    mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
    writeFileSync(join(jjRepo, 'op_heads', 'heads', 'a'.repeat(128)), '')
    mkdirSync(join(store, 'refs', 'heads'), { recursive: true })
    return { top, jjRepo, store }
  }

  it('unknown at the start: each tick asks again, and the watches open once it answers (the probe’s sequence)', async () => {
    const r = folders('late')
    const f = fakeWatch()
    const events: ObserveEvent[] = []
    let asked = 0
    let answer: Where | null = null
    const rw = jjRepoWatch(r.top, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, locate: async () => (asked++, answer), storeAt: async () => ({ jjRepo: r.jjRepo, store: r.store }) })
    await settle()
    expect([asked, rw.open()]).toEqual([1, 0])
    for (let i = 0; i < 3; i++) {
      rw.tick()
      await settle()
    }
    expect([asked, rw.open()]).toEqual([4, 0])
    // A new operation head meanwhile, then jj answers: armed at the next tick, every retained bundle marked due.
    writeFileSync(join(r.jjRepo, 'op_heads', 'heads', 'b'.repeat(128)), '')
    answer = { jjRepo: r.jjRepo, store: r.store, root: r.top }
    events.length = 0
    rw.tick()
    await settle()
    expect([asked, rw.open()]).toEqual([5, 3])
    expect(events).toContainEqual({ kind: 'invalidated', project: r.top, what: 'retained:*' })
    // Known now: never asked again; an operation reported.
    rw.tick()
    await settle()
    expect(asked).toBe(5)
    rmSync(join(r.jjRepo, 'op_heads', 'heads', 'a'.repeat(128)))
    f.fire(join('op_heads', 'heads'), null)
    expect(events.some((e) => e.kind === 'folderMoved')).toBe(true)
    rw.dispose()
    expect(f.live()).toEqual([])
  })

  it('a detection that throws, or still running at the next tick, is asked once at a time; a dispose meanwhile arms nothing', async () => {
    const r = folders('slow')
    const f = fakeWatch()
    let asked = 0
    let release!: (w: Where | null) => void
    const rw = jjRepoWatch(r.top, () => undefined, {
      watch: f.watch,
      intervalMs: 0,
      locate: () => {
        asked++
        if (asked === 1) return Promise.reject(new Error('jj vanished'))
        return new Promise<Where | null>((res) => (release = res))
      }
    })
    await settle()
    rw.tick()
    rw.tick()
    rw.tick()
    await settle()
    expect(asked).toBe(2)
    rw.dispose()
    release({ jjRepo: r.jjRepo, store: r.store, root: r.top })
    await settle()
    expect(rw.open()).toBe(0)
    expect(f.live()).toEqual([])
  })

  it('a store that changed (colocation enabled): the refs watches move to it, the operation heads’ stays', async () => {
    const r = folders('moved')
    const newStore = join(r.top, '.git')
    mkdirSync(join(newStore, 'refs', 'heads'), { recursive: true })
    const f = fakeWatch()
    const events: ObserveEvent[] = []
    let store = r.store
    const rw = jjRepoWatch(r.top, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, where: { jjRepo: r.jjRepo, store: r.store, root: r.top }, storeAt: async () => ({ jjRepo: r.jjRepo, store }) })
    expect(rw.open()).toBe(3)
    const opsSub = f.live().find(([d]) => d.endsWith(join('op_heads', 'heads')))![1]
    rw.tick()
    await settle()
    expect(f.live().map(([d]) => d).sort()).toEqual([join(r.jjRepo, 'op_heads', 'heads'), join(r.store, 'refs'), r.store].sort())
    store = newStore
    events.length = 0
    rw.tick()
    await settle()
    expect(f.live().map(([d]) => d).sort()).toEqual([join(r.jjRepo, 'op_heads', 'heads'), join(newStore, 'refs'), newStore].sort())
    expect(opsSub.closed).toBe(false)
    expect(events).toContainEqual({ kind: 'invalidated', project: r.top, what: 'retained:*' })
    // A ref change on the new store is seen.
    events.length = 0
    f.fire(join('.git', 'refs'), join('heads', 'main'))
    expect(events).toContainEqual({ kind: 'invalidated', project: r.top, what: 'refs' })
    rw.dispose()
  })
})

describe.skipIf(!jjExe)(`the watch on the real jj (jj ${TESTED_JJ.version}), HI-2977`, () => {
  it('jj unknown at the start, then readable: armed; then `jj git colocation enable`: its refs watches follow the store', async () => {
    const h = harness()
    const { repo } = h.repo('late', false)
    let ready = false
    const locate = async (p: string): Promise<Where | null> => {
      if (!ready) return null
      const d = await jjContextOf(p, h.runner)
      return 'jj' in d ? { jjRepo: d.jj.jjRepo, store: d.jj.store, root: d.jj.root } : null
    }
    const f = fakeWatch()
    const events: ObserveEvent[] = []
    const rw = jjRepoWatch(repo, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, locate })
    await settle()
    expect(rw.open()).toBe(0)
    ready = true
    rw.tick()
    await until(() => rw.open() === 3, HUNG_MS)
    const before = f.live().map(([d]) => d)
    expect(before.some((d) => d.toLowerCase().includes(join('.jj', 'repo', 'store').toLowerCase()))).toBe(true)
    // Colocated now: Git's store at the project's .git.
    h.jj(repo, 'git', 'colocation', 'enable')
    const d = await jjContextOf(repo, h.runner)
    if (!('jj' in d)) throw new Error(JSON.stringify(d))
    rw.tick()
    await until(() => f.live().some(([dir]) => dir.toLowerCase() === join(d.jj.store, 'refs').toLowerCase()), HUNG_MS)
    expect(rw.open()).toBe(3)
    // A bookmark moved by jj: its ref change on the new store reported.
    events.length = 0
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@', '--allow-backwards')
    f.fire('refs', join('heads', 'main'))
    expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'refs' })
    rw.dispose()
  })
})
