// HI-3388: lib.cjs's readiness waits (settled, themeSettled, noDialog) are bounded and observable. A renderer that never
// answers (no frame drawn, an evaluate that never returns) or a condition that stays false makes them throw within their
// bound, never pass and never hang; a page that is ready passes.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

type FakePage = { evaluate: (fn: unknown) => Promise<unknown>; locator: (sel: string) => { count: () => Promise<number> } }
const lib = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  settled: (page: FakePage, ms?: number) => Promise<boolean>
  themeSettled: (page: FakePage, theme: string, ms?: number) => Promise<boolean>
  noDialog: (page: FakePage, ms?: number) => Promise<boolean>
}

const never = () => new Promise<never>(() => {})
const page = (evaluate: () => Promise<unknown>, dialogs: () => Promise<number> = async () => 0): FakePage => ({ evaluate, locator: () => ({ count: dialogs }) })
/** How long a call took to settle (resolve or reject), and how. */
const timed = async (p: Promise<unknown>) => {
  const t = Date.now()
  const r = await p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e }))
  return { ...r, ms: Date.now() - t }
}
const BOUND = 300
/** Its bound, a look's poll interval and some slack on a loaded machine: well under a look's read time (1 s) twice over. */
const WITHIN = BOUND + 1500

describe('lib.settled', () => {
  it('passes when frames are drawn and no animation runs', async () => {
    expect(await lib.settled(page(async () => true), BOUND)).toBe(true)
  })
  it('throws within its bound when the page never answers (no frame drawn): never pending, never a pass', async () => {
    const r = await timed(lib.settled(page(never), BOUND))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.e.message).toMatch(/not settled/)
    expect(r.ms).toBeLessThan(WITHIN)
  })
  it('throws when an animation keeps running (its look stays false)', async () => {
    const r = await timed(lib.settled(page(async () => false), BOUND))
    expect(r.ok).toBe(false)
    expect(r.ms).toBeLessThan(WITHIN)
  })
  it('a failing evaluate is a look that came back false, then a pass once the page answers', async () => {
    let n = 0
    expect(await lib.settled(page(async () => (++n < 3 ? Promise.reject(new Error('navigating')) : true)), 5000)).toBe(true)
    expect(n).toBe(3)
  })
})

describe('lib.themeSettled', () => {
  it('passes once the theme shows and the page settles', async () => {
    let n = 0
    // The theme read first (a string), then the frames (true).
    expect(await lib.themeSettled(page(async () => (++n === 1 ? 'light' : true)), 'light', BOUND)).toBe(true)
  })
  it('throws within its bound when the theme never shows', async () => {
    const r = await timed(lib.themeSettled(page(async () => 'dark'), 'light', BOUND))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.e.message).toMatch(/light theme/)
    expect(r.ms).toBeLessThan(WITHIN)
  })
  it('one bound for both: a theme that shows, then frames that never come, still ends within it', async () => {
    let n = 0
    const r = await timed(lib.themeSettled(page(() => (++n === 1 ? Promise.resolve('light') : never())), 'light', BOUND))
    expect(r.ok).toBe(false)
    expect(r.ms).toBeLessThan(WITHIN)
  })
})

describe('lib.noDialog', () => {
  it('passes when no dialog is open', async () => {
    expect(await lib.noDialog(page(async () => true, async () => 0), BOUND)).toBe(true)
  })
  it('throws within its bound when a dialog stays open, or the page never answers', async () => {
    for (const dialogs of [async () => 1, never]) {
      const r = await timed(lib.noDialog(page(async () => true, dialogs), BOUND))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.e.message).toMatch(/without a dialog/)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
})
