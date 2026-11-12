// A jj project's repository watch (HI-2882's J9b2, design HI-2882/s7 §3, s13 §3), on the real jj in both Git-backed
// modes, through a test's watch (counted and driven): two subscriptions whatever the repository holds; a slot-only
// commit (no bookmark moved) reported as a new operation; a bookmark move as its line; a change under a retained bundle's
// pins as that bundle's invalidation; refs gone and back re-armed, every bundle marked due; disposal leaves nothing.
// HI-2977: where the repository is, asked again at each tick until jj answers, and a changed store followed.
// HI-3033: with the real watch, `jj git colocation enable` and `disable` go through while the project is watched.
// Skipped without the fetched jj (npm run jj:fetch).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
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
    it('two subscriptions; operations, bookmarks and retained pins reported; the store re-armed; disposed', async () => {
      const h = harness()
      const { repo, root } = h.repo(`watch${colocated ? 'c' : 'n'}`, colocated)
      const d = await jjContextOf(repo, h.runner)
      if (!('jj' in d)) throw new Error('no jj context')
      const where = { jjRepo: d.jj.jjRepo, store: d.jj.store }
      const f = fakeWatch()
      const events: ObserveEvent[] = []
      const rw = jjRepoWatch(repo, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, where })
      expect(rw.open()).toBe(2)
      // Nothing watched below the store (HI-3033): its folder itself, and the operation heads'.
      expect(f.live().map(([d]) => d).sort()).toEqual([join(where.jjRepo, 'op_heads', 'heads'), where.store].sort())
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
      f.fire(where.store, join('refs', 'heads', 'main'))
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'refs' })
      expect(events.some((e) => e.kind === 'lineMoved')).toBe(false)
      // What else the store holds says nothing.
      events.length = 0
      for (const file of [join('objects', 'ab', 'cdef'), 'index', join('logs', 'HEAD'), join('refs', 'tags', 'v1')]) f.fire(where.store, file)
      expect(events).toEqual([])
      // A change under a retained bundle's pins: that bundle due. 500 bundles: still three subscriptions.
      events.length = 0
      const head = h.id(repo, 'main')
      for (let i = 0; i < 500; i++) {
        const p = join(where.store, 'refs', 'cw', 'jj-integrated', 'AM-1', '1', `b1-x${i}`)
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, 'revision'), `${head}\n`)
      }
      f.fire(where.store, join('refs', 'cw', 'jj-integrated', 'AM-1', '1', 'b1-x7', 'revision'))
      expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'retained:AM-1:1:b1-x7' })
      expect(rw.open()).toBe(2)
      // packed-refs, or refs itself gone and back: every bundle due and a run.
      for (const file of ['packed-refs', 'refs']) {
        events.length = 0
        f.fire(where.store, file)
        expect(events).toEqual([{ kind: 'invalidated', project: repo, what: 'retained:*' }, { kind: 'invalidated', project: repo, what: 'refs' }])
      }
      // The store's watch lost: re-armed by the tick, every bundle marked due.
      events.length = 0
      const storeSub = f.live().find(([dir]) => dir === where.store)![1]
      storeSub.closed = true
      for (const l of storeSub.lost) l()
      expect(rw.open()).toBe(1)
      rw.tick()
      expect(rw.open()).toBe(2)
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
    expect([asked, rw.open()]).toEqual([5, 2])
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

  it('a store that changed (colocation enabled): the store’s watch moves to it, the operation heads’ stays', async () => {
    const r = folders('moved')
    const newStore = join(r.top, '.git')
    mkdirSync(join(newStore, 'refs', 'heads'), { recursive: true })
    const f = fakeWatch()
    const events: ObserveEvent[] = []
    let store = r.store
    const rw = jjRepoWatch(r.top, (e) => void events.push(e), { watch: f.watch, intervalMs: 0, where: { jjRepo: r.jjRepo, store: r.store, root: r.top }, storeAt: async () => ({ jjRepo: r.jjRepo, store }) })
    expect(rw.open()).toBe(2)
    const opsSub = f.live().find(([d]) => d.endsWith(join('op_heads', 'heads')))![1]
    rw.tick()
    await settle()
    expect(f.live().map(([d]) => d).sort()).toEqual([join(r.jjRepo, 'op_heads', 'heads'), r.store].sort())
    store = newStore
    events.length = 0
    rw.tick()
    await settle()
    expect(f.live().map(([d]) => d).sort()).toEqual([join(r.jjRepo, 'op_heads', 'heads'), newStore].sort())
    expect(opsSub.closed).toBe(false)
    expect(events).toContainEqual({ kind: 'invalidated', project: r.top, what: 'retained:*' })
    // A ref change on the new store is seen.
    events.length = 0
    f.fire(newStore, join('refs', 'heads', 'main'))
    expect(events).toContainEqual({ kind: 'invalidated', project: r.top, what: 'refs' })
    rw.dispose()
  })
})

describe.skipIf(!jjExe)(`the watch on the real jj (jj ${TESTED_JJ.version}), HI-2977`, () => {
  it('jj unknown at the start, then readable: armed; then `jj git colocation enable`: its store’s watch follows the store', async () => {
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
    await until(() => rw.open() === 2, HUNG_MS)
    const before = f.live().map(([d]) => d)
    expect(before.some((d) => d.toLowerCase().includes(join('.jj', 'repo', 'store').toLowerCase()))).toBe(true)
    // Colocated now: Git's store at the project's .git.
    h.jj(repo, 'git', 'colocation', 'enable')
    const d = await jjContextOf(repo, h.runner)
    if (!('jj' in d)) throw new Error(JSON.stringify(d))
    rw.tick()
    await until(() => f.live().some(([dir]) => dir.toLowerCase() === d.jj.store.toLowerCase()), HUNG_MS)
    expect(rw.open()).toBe(2)
    // A bookmark moved by jj: its ref change on the new store reported.
    events.length = 0
    h.jj(repo, 'bookmark', 'set', 'main', '-r', '@', '--allow-backwards')
    f.fire(d.jj.store, join('refs', 'heads', 'main'))
    expect(events).toContainEqual({ kind: 'invalidated', project: repo, what: 'refs' })
    rw.dispose()
  })
})

describe.skipIf(!jjExe)(`colocation changed while the real watch holds the repository (jj ${TESTED_JJ.version}), HI-3033`, () => {
  // Windows refuses to move a folder with a handle open beneath it: the store's own watch must let jj move the store.
  it.each([false, true] as const)('colocated at the start: %s. Changed and changed back, the watch following each time', async (colocated) => {
    const h = harness()
    const { repo } = h.repo(`move${colocated ? 'c' : 'n'}`, colocated)
    const d = await jjContextOf(repo, h.runner)
    if (!('jj' in d)) throw new Error(JSON.stringify(d))
    const events: ObserveEvent[] = []
    const rw = jjRepoWatch(repo, (e) => void events.push(e), { intervalMs: 0, where: { jjRepo: d.jj.jjRepo, store: d.jj.store, root: d.jj.root } })
    try {
      expect(rw.open()).toBe(2)
      let store = d.jj.store
      for (const cmd of colocated ? ['disable', 'enable'] : ['enable', 'disable']) {
        // jj's own command, run as the user would: it fails (Access is denied) while a handle is held below the store.
        h.jj(repo, 'git', 'colocation', cmd)
        expect(existsSync(join(repo, '.git'))).toBe(cmd === 'enable')
        const now = await jjContextOf(repo, h.runner)
        if (!('jj' in now)) throw new Error(JSON.stringify(now))
        expect(now.jj.store.toLowerCase()).not.toBe(store.toLowerCase())
        store = now.jj.store
        // The next tick follows the store (re-armed on it: every retained bundle due).
        events.length = 0
        rw.tick()
        await until(() => events.some((e) => e.kind === 'invalidated' && e.what === 'retained:*'), HUNG_MS)
        expect(rw.open()).toBe(2)
        // Colocated, a bookmark moved by jj writes its Git ref, which reaches the watch on the store's new folder (not
        // colocated, jj 0.47 writes no Git ref for a bookmark: nothing to see there).
        if (cmd === 'enable') {
          events.length = 0
          h.jj(repo, 'bookmark', 'set', 'main', '-r', '@', '--allow-backwards')
          await until(() => events.some((e) => e.kind === 'invalidated' && e.what === 'refs'), HUNG_MS)
        }
      }
    } finally {
      rw.dispose()
    }
  })
})
