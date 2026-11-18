import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// HI-3387: the e2e readiness helpers lib.themeShown and lib.animationsDone wait for their condition, and throw at their
// bound, saying what they saw: what a suite does after them (a screenshot, a box read) never runs on an unready window.
// Driven here with stand-ins for Playwright's page and locator, each look's answer scripted.
const req = createRequire(import.meta.url)
const lib = req('./e2e/lib.cjs') as {
  themeShown: (page: unknown, theme: string, ms?: number) => Promise<true>
  animationsDone: (locator: unknown, ms?: number) => Promise<true>
}
const { timing } = req('./timing.cjs') as { timing: (name: string) => number }
const SHORT = timing('quiet.briefMs')

type Drawn = { theme: string | null; fading: string[] }
/** A page whose looks answer `looks` in turn, the last one from then on. */
const pageAnswering = (looks: Drawn[]) => {
  let n = 0
  return { evaluate: async () => looks[Math.min(n++, looks.length - 1)], looks: () => n }
}
/** A locator whose looks answer `looks` in turn (the running animations' names, or an Error: not found), recording each look's options. */
const locatorAnswering = (looks: (string[] | Error)[]) => {
  let n = 0
  const options: { timeout?: number }[] = []
  return {
    evaluate: async (_fn: unknown, _arg: unknown, opts: { timeout?: number }) => {
      options.push(opts)
      const a = looks[Math.min(n++, looks.length - 1)]
      if (a instanceof Error) throw a
      return a
    },
    toString: () => "locator('.tip-card')",
    options
  }
}

/** A suite's step after a helper: it runs only if the helper resolved. */
async function thenShot(wait: Promise<unknown>): Promise<{ shot: boolean; error: string | null }> {
  let shot = false
  try {
    await wait
    shot = true
  } catch (e) {
    return { shot, error: (e as Error).message }
  }
  return { shot, error: null }
}

describe('lib.themeShown', () => {
  it('waits for the theme set and no transition running, then lets the screenshot run', async () => {
    const page = pageAnswering([
      { theme: 'dark', fading: [] },
      { theme: 'light', fading: ['background-color'] },
      { theme: 'light', fading: [] }
    ])
    expect(await thenShot(lib.themeShown(page, 'light', timing('hang.ui')))).toEqual({ shot: true, error: null })
    expect(page.looks()).toBe(3)
  })

  it('a theme that never comes throws at its bound, naming what it saw: no screenshot', async () => {
    const r = await thenShot(lib.themeShown(pageAnswering([{ theme: 'dark', fading: [] }]), 'light', SHORT))
    expect(r.shot).toBe(false)
    expect(r.error).toMatch(/wasn't drawn in the light theme within \d+ ms/)
    expect(r.error).toContain('"theme":"dark"')
  })

  it('a transition that keeps running throws too, naming it', async () => {
    const r = await thenShot(lib.themeShown(pageAnswering([{ theme: 'light', fading: ['background-color'] }]), 'light', SHORT))
    expect(r.shot).toBe(false)
    expect(r.error).toContain('background-color')
  })
})

describe('lib.animationsDone', () => {
  it('waits for the running animations to end, then lets the box be read', async () => {
    const loc = locatorAnswering([['slide-in'], ['slide-in'], []])
    expect(await thenShot(lib.animationsDone(loc, timing('hang.ui')))).toEqual({ shot: true, error: null })
  })

  it('an animation that never settles throws at its bound, naming it: no box read', async () => {
    const r = await thenShot(lib.animationsDone(locatorAnswering([['pulse']]), SHORT))
    expect(r.shot).toBe(false)
    expect(r.error).toMatch(/locator\('\.tip-card'\) still animating, or not there, after \d+ ms/)
    expect(r.error).toContain('pulse')
  })

  it("each look finds the element within a short bound, never Playwright's longer default; one not there throws", async () => {
    const loc = locatorAnswering([new Error('Timeout exceeded waiting for locator')])
    const r = await thenShot(lib.animationsDone(loc, SHORT))
    expect(r.shot).toBe(false)
    expect(r.error).toContain('Timeout exceeded')
    expect(loc.options.length).toBeGreaterThan(0)
    expect(loc.options.every((o) => typeof o.timeout === 'number' && o.timeout <= SHORT)).toBe(true)
  })
})
