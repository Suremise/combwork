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
  projectShown: (page: FakePage, ms?: number) => Promise<boolean>
  sizesGiven: (pairs: { term: { cols: number; rows: number } | null; given?: { cols: number; rows: number } }[]) => boolean
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

// HI-3386 (HR2's round 1): the project's view shown after a click, bounded like the others; and what it and termsize's
// sizes wait for is the producer's work done: held, they stay pending (or false), never pass on what was there before.
describe('lib.projectShown', () => {
  it('passes once the session toolbar shows', async () => {
    expect(await lib.projectShown(page(async () => true, async () => 1), BOUND)).toBe(true)
  })
  it('throws within its bound when the toolbar never shows, or the page never answers: never pending, never a pass', async () => {
    for (const toolbars of [async () => 0, never]) {
      const r = await timed(lib.projectShown(page(async () => true, toolbars), BOUND))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.e.message).toMatch(/project's view shown/)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
  it('a view held from showing keeps it waiting; released, it passes', async () => {
    let shown = false
    let done = false
    const waiting = lib.projectShown(page(async () => true, async () => (shown ? 1 : 0)), WITHIN * 2).then((v) => ((done = true), v))
    await new Promise((r) => setTimeout(r, BOUND))
    expect(done).toBe(false)
    shown = true
    expect(await waiting).toBe(true)
  })
})

describe('lib.sizesGiven', () => {
  const t = (cols: number, rows: number) => ({ cols, rows })
  it("true once every CLI's last size is its terminal's", () => {
    expect(lib.sizesGiven([{ term: t(80, 24), given: t(80, 24) }, { term: t(60, 20), given: t(60, 20) }])).toBe(true)
  })
  it("false while a resize is still on its way: a CLI's size behind its terminal's, or none yet, or a terminal not drawn", () => {
    expect(lib.sizesGiven([{ term: t(80, 24), given: t(80, 24) }, { term: t(60, 20), given: t(72, 20) }])).toBe(false)
    expect(lib.sizesGiven([{ term: t(80, 24), given: undefined }])).toBe(false)
    expect(lib.sizesGiven([{ term: null, given: t(80, 24) }])).toBe(false)
    expect(lib.sizesGiven([])).toBe(false)
  })
})
