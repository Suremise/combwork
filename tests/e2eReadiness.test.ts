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

// HI-3396 (HR1's round 1): its own readiness helpers, the same contract: bounded calls, a throw on expiry, and the check
// after a wait that ran out never runs.
type FakeApp = { evaluate: (fn: unknown, arg?: unknown) => Promise<unknown> }
const more = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  framesDrawn: (page: FakePage, ms?: number) => Promise<boolean>
  answersDrawn: (inv: (ch: string) => Promise<unknown>, page: FakePage, ms?: number) => Promise<boolean>
  zoomTo: (app: FakeApp, page: FakePage, z: number, ms?: number) => Promise<boolean>
  viewportIs: (page: FakePage, width: number, ms?: number) => Promise<boolean>
  ipcAnswered: (app: FakeApp, channel: string, n: number, ms?: number) => Promise<boolean>
}
/** Runs `wait`, then the check after it: whether that check ran, and how the wait ended. */
const thenCheck = async (wait: Promise<unknown>) => {
  let checked = false
  const r = await timed(wait.then(() => (checked = true)))
  return { ...r, checked }
}

describe('lib.framesDrawn', () => {
  it('passes once two frames are drawn', async () => {
    expect(await more.framesDrawn(page(async () => true), BOUND)).toBe(true)
  })
  it('throws within its bound when no frame is drawn, and the check after it never runs', async () => {
    const r = await thenCheck(more.framesDrawn(page(never), BOUND))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.e.message).toMatch(/two frames drawn/)
    expect(r.checked).toBe(false)
    expect(r.ms).toBeLessThan(WITHIN)
  })
})

describe('lib.answersDrawn', () => {
  it('passes once main answers after its earlier answers and two frames are drawn', async () => {
    expect(await more.answersDrawn(async () => ({}), page(async () => true), BOUND)).toBe(true)
  })
  it('throws within its bound when main never answers, or no frame is drawn; the check after never runs', async () => {
    for (const [inv, evaluate] of [[never, async () => true], [async () => ({}), never]] as const) {
      const r = await thenCheck(more.answersDrawn(inv, page(evaluate), BOUND))
      expect(r.ok).toBe(false)
      expect(r.checked).toBe(false)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
})

describe('lib.zoomTo', () => {
  const app = (scale: () => Promise<unknown>): FakeApp => ({ evaluate: scale })
  it('passes once the page draws at the zoom and settles', async () => {
    expect(await more.zoomTo(app(async () => 1.5), page(async () => true), 1.25, BOUND)).toBe(true)
  })
  it('throws within its bound when the zoom never shows, main never answers, or no frame comes; the check after never runs', async () => {
    for (const [scale, evaluate] of [[async () => 1.5, async () => false], [never, async () => true], [async () => 1.5, never]] as const) {
      const r = await thenCheck(more.zoomTo(app(scale), page(evaluate), 1.25, BOUND))
      expect(r.ok).toBe(false)
      expect(r.checked).toBe(false)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
})

describe('lib.viewportIs', () => {
  it('passes once the viewport is that wide and settled', async () => {
    expect(await more.viewportIs(page(async () => true), 720, BOUND)).toBe(true)
  })
  it('throws within its bound when the width never comes, or the page never answers; the check after never runs', async () => {
    for (const evaluate of [async () => false, never]) {
      const r = await thenCheck(more.viewportIs(page(evaluate), 720, BOUND))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.e.message).toMatch(/720 px wide/)
      expect(r.checked).toBe(false)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
})

describe('lib.ipcAnswered (a delayed save: the check waits for the last answer)', () => {
  it('passes only once main has answered n calls: a second save answered late is waited for', async () => {
    let answered = 1
    const app: FakeApp = { evaluate: async () => answered }
    // The second save is answered later (a slowed first save, then the one queued after it).
    setTimeout(() => (answered = 2), 200)
    const r = await thenCheck(more.ipcAnswered(app, 'settings:update', 2, 5000))
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(true)
    expect(answered).toBe(2)
    expect(r.ms).toBeGreaterThanOrEqual(150)
  })
  it('throws within its bound when the last answer never comes, or main never answers; the check after never runs', async () => {
    for (const evaluate of [async () => 1, never]) {
      const r = await thenCheck(more.ipcAnswered({ evaluate }, 'settings:update', 2, BOUND))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.e.message).toMatch(/2 settings:update answer/)
      expect(r.checked).toBe(false)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
})

// HI-3399: themeShown (HI-3385's, used by progresslanes and removeall) is themeSettled: bounded reads, a throw on expiry.
describe('lib.themeShown', () => {
  const shown = createRequire(import.meta.url)('./e2e/lib.cjs') as { themeShown: (page: FakePage, theme: string, ms?: number) => Promise<boolean> }
  it('passes once the theme shows and the page settles', async () => {
    let n = 0
    expect(await shown.themeShown(page(async () => (++n === 1 ? 'dark' : true)), 'dark', BOUND)).toBe(true)
  })
  it('throws within its bound when the page never answers, or the theme never shows; the check after never runs', async () => {
    for (const evaluate of [never, async () => 'light']) {
      const r = await thenCheck(shown.themeShown(page(evaluate), 'dark', BOUND))
      expect(r.ok).toBe(false)
      expect(!r.ok && r.e.message).toMatch(/dark theme/)
      expect(r.checked).toBe(false)
      expect(r.ms).toBeLessThan(WITHIN)
    }
  })
  it('throws when the theme shows but the page never settles (a frame that never comes)', async () => {
    let n = 0
    const r = await thenCheck(shown.themeShown(page(() => (++n === 1 ? Promise.resolve('dark') : never())), 'dark', BOUND))
    expect(r.ok).toBe(false)
    expect(r.checked).toBe(false)
    expect(r.ms).toBeLessThan(WITHIN)
  })
})
