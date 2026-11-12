// Combwork's gate over the files a jj write replaces (HI-2918, src/main/platform/jjFileGate.ts): readers together,
// writers alone and first, all of a request's keys at once, a queued request leaving on abort, idle keys forgotten, a
// write's recheck reading through its ticket only while it runs (its reads drained before it is done), the sync
// reader, and the keys of paths (aliases meet; a folder not made yet has the key it will have). Deterministic: no
// timers; each step waits on a promise the test controls.
import { mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { GateRefused, JjFileGate, pathKey, pathKeySync, type Grant } from '../src/main/platform/jjFileGate'
import { tempDir } from './tempDir'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Lets settled promises' continuations run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A request's grant, recorded when it comes. */
function track(p: Promise<Grant>) {
  const t: { grant: Grant | null; error: unknown } = { grant: null, error: null }
  p.then(
    (g) => (t.grant = g),
    (e) => (t.error = e)
  )
  return t
}

describe("the gate over jj's replaced files (HI-2918)", () => {
  it('lets readers in together; a writer waits only for the readers granted before it, and readers after it wait', async () => {
    const g = new JjFileGate()
    const r1 = track(g.acquire(['root:a'], 'shared'))
    const r2 = track(g.acquire(['root:a'], 'shared'))
    await flush()
    expect([!!r1.grant, !!r2.grant]).toEqual([true, true])
    const w = track(g.acquire(['root:a'], 'exclusive'))
    const r3 = track(g.acquire(['root:a'], 'shared'))
    await flush()
    expect([!!w.grant, !!r3.grant]).toEqual([false, false])
    expect(g.writing('root:a')).toBe(true)
    r1.grant!.release()
    await flush()
    expect(w.grant).toBeNull()
    r2.grant!.release()
    await flush()
    expect([!!w.grant, !!r3.grant]).toEqual([true, false])
    w.grant!.release()
    await flush()
    expect(!!r3.grant).toBe(true)
    r3.grant!.release()
    expect(g.size).toBe(0)
  })

  for (const order of ['ab then bc', 'bc then ab'] as const) {
    it(`grants all of a request's keys at once or none: overlapping writes never deadlock (${order})`, async () => {
      const g = new JjFileGate()
      const first = order === 'ab then bc' ? ['root:a', 'store:b'] : ['store:b', 'root:c']
      const second = order === 'ab then bc' ? ['store:b', 'root:c'] : ['root:a', 'store:b']
      const w1 = track(g.acquire(first, 'exclusive'))
      const w2 = track(g.acquire(second, 'exclusive'))
      await flush()
      expect([!!w1.grant, !!w2.grant]).toEqual([true, false])
      // The waiting write holds none of its keys meanwhile (no partial grant): its free key is only waited on.
      const free = second.find((k) => !first.includes(k))!
      const reader = track(g.acquire([free], 'shared'))
      await flush()
      expect(reader.grant).toBeNull()
      w1.grant!.release()
      await flush()
      expect(!!w2.grant).toBe(true)
      w2.grant!.release()
      await flush()
      expect(!!reader.grant).toBe(true)
      reader.grant!.release()
      expect(g.size).toBe(0)
    })
  }

  it('a queued request leaves when its signal aborts: rejected, never granted, and readers behind an aborted writer get in', async () => {
    const g = new JjFileGate()
    const r1 = track(g.acquire(['root:a'], 'shared'))
    await flush()
    const ac = new AbortController()
    const w = track(g.acquire(['root:a'], 'exclusive', ac.signal))
    const r2 = track(g.acquire(['root:a'], 'shared'))
    await flush()
    expect(r2.grant).toBeNull()
    ac.abort()
    await flush()
    expect(w.error).toBeInstanceOf(GateRefused)
    expect(!!r2.grant).toBe(true)
    r1.grant!.release()
    r2.grant!.release()
    await flush()
    expect(w.grant).toBeNull()
    expect(g.size).toBe(0)
    await expect(g.acquire(['root:a'], 'shared', AbortSignal.abort())).rejects.toBeInstanceOf(GateRefused)
    expect(g.size).toBe(0)
  })

  it('a grant is released once: a second release changes nothing', async () => {
    const g = new JjFileGate()
    const w = await g.acquire(['root:a'], 'exclusive')
    const r = track(g.acquire(['root:a'], 'shared'))
    w.release()
    w.release()
    await flush()
    expect(!!r.grant).toBe(true)
    const w2 = track(g.acquire(['root:a'], 'exclusive'))
    await flush()
    expect(w2.grant).toBeNull()
    r.grant!.release()
    await flush()
    expect(!!w2.grant).toBe(true)
    w2.grant!.release()
    expect(g.size).toBe(0)
  })

  it("a write's recheck reads through its ticket (no wait behind itself), and waits for those reads before it is done", async () => {
    const g = new JjFileGate()
    const w = await g.acquire(['root:a', 'store:s'], 'exclusive')
    const held = deferred<string>()
    let recheckDone = false
    const done = g
      .recheck(w, async () => {
        // A fresh read inside: borrowed at once. A second, still in flight when the recheck's own function returns.
        const now = await g.read(['root:a'], async () => 'read')
        void g.read(['store:s'], () => held.promise)
        return now
      })
      .then((v) => ((recheckDone = true), v))
    await flush()
    expect(recheckDone).toBe(false)
    held.resolve('late')
    expect(await done).toBe('read')
    // A key it doesn't hold isn't covered: that read takes the gate (free here) as any other.
    expect(await g.recheck(w, () => g.read(['root:other'], async () => 'other'))).toBe('other')
    w.release()
    expect(g.size).toBe(0)
  })

  it('after the recheck, its ticket is revoked: a read begun later from the same async context waits for the write', async () => {
    const g = new JjFileGate()
    const w = await g.acquire(['root:a'], 'exclusive')
    const later = deferred()
    let read: Promise<string> | null = null
    await g.recheck(w, () => {
      // Fire and forget: runs after the recheck has settled, still in its async context.
      void later.promise.then(() => (read = g.read(['root:a'], async () => 'after')))
      return null
    })
    later.resolve()
    await flush()
    expect(read).not.toBeNull()
    let got = ''
    void read!.then((v) => (got = v))
    await flush()
    expect(got).toBe('')
    w.release()
    await flush()
    expect(got).toBe('after')
    expect(g.size).toBe(0)
  })

  it("a read in a live recheck of a key its write doesn't hold: granted at once when free, refused (never waited for) when a write holds or waits on it (HR2's round 1)", async () => {
    const g = new JjFileGate()
    const w = await g.acquire(['root:a'], 'exclusive')
    expect(await g.recheck(w, () => g.read(['root:b'], async () => 'b'))).toBe('b')
    // A writer waiting on b (and on a, which this write holds): this recheck's read of b would wait behind it forever.
    const reader = await g.acquire(['root:b'], 'shared')
    const w2 = track(g.acquire(['root:b', 'root:a'], 'exclusive'))
    await flush()
    expect(g.queued).toBe(1)
    await expect(g.recheck(w, () => g.read(['root:b'], async () => 'b'))).rejects.toBeInstanceOf(GateRefused)
    w.release()
    reader.release()
    await flush()
    expect(!!w2.grant).toBe(true)
    w2.grant!.release()
    expect(g.size).toBe(0)
  })

  it('a recheck needs an exclusive grant', async () => {
    const g = new JjFileGate()
    const r = await g.acquire(['root:a'], 'shared')
    await expect(g.recheck(r, () => null)).rejects.toThrow(/exclusive/)
    r.release()
  })

  it('a sync reader reads at once, or gets its fallback while a write holds or waits; through a live ticket it reads', async () => {
    const g = new JjFileGate()
    expect(g.readSync(['root:a'], () => 'x', null)).toBe('x')
    const r = await g.acquire(['root:a'], 'shared')
    const w = track(g.acquire(['root:a'], 'exclusive'))
    await flush()
    expect(g.readSync(['root:a'], () => 'x', null)).toBeNull()
    r.release()
    await flush()
    expect(g.readSync(['root:a'], () => 'x', null)).toBeNull()
    expect(await g.recheck(w.grant!, () => g.readSync(['root:a'], () => 'x', null))).toBe('x')
    w.grant!.release()
    expect(g.readSync(['root:a'], () => 'x', null)).toBe('x')
  })

  it('keys a path by its real path: an alias (a junction) meets it, and a folder not made yet has the key it will have', async () => {
    const top = tempDir('jj-gate-keys-')
    const real = join(top, 'Real')
    mkdirSync(real)
    const alias = join(top, 'alias')
    symlinkSync(real, alias, 'junction')
    expect(await pathKey(alias)).toBe(await pathKey(real))
    expect(pathKeySync(alias)).toBe(await pathKey(real))
    const dest = join(real, 'slot-a')
    const before = await pathKey(dest)
    expect(await pathKey(join(alias, 'slot-a'))).toBe(before)
    mkdirSync(dest)
    expect(await pathKey(dest)).toBe(before)
    expect(pathKeySync(dest)).toBe(before)
  })
})
