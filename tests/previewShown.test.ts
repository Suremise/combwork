// Where a preview's guarded page is shown (HI-3615 round 1, previewShown.ts): a show records its intent before it awaits,
// and a hide, the window closing or the preview's close meanwhile makes it attach and load nothing; a close is shared,
// waits for a guard still opening, and its entry stays until it is over. Controlled promises, fake windows and guards.
import { describe, expect, it } from 'vitest'
import { PreviewShows, type ShownGuard, type ShownWindow } from '../src/main/previewShown'

/** A promise the test settles. */
function gate<T>(): { promise: Promise<T>; open: (v: T) => void; fail: (e: unknown) => void } {
  let open!: (v: T) => void
  let fail!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => ((open = a), (fail = b)))
  return { promise, open, fail }
}

/** Lets every promise already settled run on (no time passes). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

class Win implements ShownWindow {
  destroyed = false
  private closed: (() => void)[] = []
  constructor(readonly name: string) {}
  isDestroyed = (): boolean => this.destroyed
  once = (_e: 'closed', fn: () => void): void => void this.closed.push(fn)
  close(): void {
    this.destroyed = true
    for (const fn of this.closed.splice(0)) fn()
  }
}

function world(o: { owned?: boolean } = {}) {
  const log: string[] = []
  const opening = gate<ShownGuard>()
  const closing = gate<boolean>()
  let opens = 0
  const guard: ShownGuard = {
    view: {},
    load: async (url) => void log.push(`load ${url}`),
    close: () => (log.push('guard close'), closing.promise)
  }
  const shows = new PreviewShows<Win, ShownGuard>({
    open: () => (opens++, opening.promise),
    attach: (w) => void log.push(`attach ${w.name}`),
    detach: (w) => void log.push(`detach ${w.name}`),
    place: (w) => void log.push(`place ${w.name}`),
    owned: async () => o.owned ?? true
  })
  return { shows, log, opening, closing, guard, opens: () => opens }
}

describe("a preview's shown page (HI-3615 round 1)", () => {
  it('a hide while its guard opens cancels the show: nothing attached or loaded, until a fresh show', async () => {
    const { shows, log, opening, guard, opens } = world()
    const a = new Win('a')
    const shown = shows.show('pv-1', a, {}, 'http://127.0.0.1:46000/')
    await shows.hide('pv-1', a)
    opening.open(guard)
    expect(await shown).toBe('cancelled')
    await settle()
    expect(log).toEqual([])
    // Shown again: the guard opened once already, attached and loaded now.
    expect(await shows.show('pv-1', a, {}, 'http://127.0.0.1:46000/')).toBe('shown')
    expect(log).toEqual(['attach a', 'place a', 'load http://127.0.0.1:46000/'])
    expect(opens()).toBe(1)
  })

  it('leaving for another window (a later show) or the window closing cancels the earlier show', async () => {
    const { shows, log, opening, guard } = world()
    const a = new Win('a')
    const b = new Win('b')
    const first = shows.show('pv-1', a, {}, 'u')
    const second = shows.show('pv-1', b, {}, 'u')
    opening.open(guard)
    expect([await first, await second]).toEqual(['cancelled', 'shown'])
    expect(log).toEqual(['attach b', 'place b', 'load u'])
    log.length = 0
    // A show in window a, then a closes before it is attached: nothing attached to a destroyed window.
    const c = new Win('c')
    const pending = shows.show('pv-1', c, {}, 'u')
    c.close()
    expect(await pending).toBe('cancelled')
    expect(log).toEqual([])
  })

  it("loads nothing when its ports' owners aren't its own", async () => {
    const { shows, log, opening, guard } = world({ owned: false })
    opening.open(guard)
    expect(await shows.show('pv-1', new Win('a'), {}, 'u')).toBe('notOwned')
    expect(log.some((l) => l.startsWith('load'))).toBe(false)
  })

  it("a close while its guard still opens waits for it, cancels the show, and is one operation for every caller, its entry kept until it's over", async () => {
    const { shows, log, opening, closing, guard } = world()
    const a = new Win('a')
    const shown = shows.show('pv-1', a, {}, 'u')
    const c1 = shows.close('pv-1')
    const c2 = shows.close('pv-1')
    expect(c2).toBe(c1)
    await settle()
    // Nothing closed yet: the guard is still opening.
    expect(log).toEqual([])
    expect(shows.has('pv-1')).toBe(true)
    opening.open(guard)
    expect(await shown).toBe('cancelled')
    await settle()
    expect(log).toEqual(['guard close'])
    // Still closing (its proxy not yet proved gone): the entry stays, and no new show can use it.
    expect(shows.has('pv-1')).toBe(true)
    expect(await shows.show('pv-1', a, {}, 'u')).toBe('cancelled')
    closing.open(true)
    expect(await c1).toBe(true)
    expect(shows.has('pv-1')).toBe(false)
    expect(log).toEqual(['guard close'])
  })

  it('a close of a shown page takes its view out of its window before closing its guard', async () => {
    const { shows, log, opening, closing, guard } = world()
    opening.open(guard)
    const a = new Win('a')
    await shows.show('pv-1', a, {}, 'u')
    log.length = 0
    closing.open(false)
    expect(await shows.close('pv-1')).toBe(false)
    expect(log).toEqual(['detach a', 'guard close'])
  })

  it("keeps a close whose guard's end isn't proved, never shows it again, and tries the guard again at the next close (round 2)", async () => {
    const log: string[] = []
    const answers = [false, false, true]
    let closes = 0
    const guard: ShownGuard = { view: {}, load: async () => undefined, close: async () => answers[closes++] }
    const shows = new PreviewShows<Win, ShownGuard>({ open: async () => guard, attach: (w) => void log.push(`attach ${w.name}`), detach: () => undefined, place: () => undefined, owned: async () => true })
    const a = new Win('a')
    expect(await shows.show('pv-1', a, {}, 'u')).toBe('shown')
    expect(await shows.close('pv-1')).toBe(false)
    expect(shows.has('pv-1')).toBe(true)
    expect(await shows.show('pv-1', a, {}, 'u')).toBe('cancelled')
    expect(await shows.close('pv-1')).toBe(false)
    expect(shows.has('pv-1')).toBe(true)
    expect(await shows.close('pv-1')).toBe(true)
    expect(shows.has('pv-1')).toBe(false)
    expect(closes).toBe(3)
    expect(log).toEqual(['attach a'])
  })
})
