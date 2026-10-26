// A window's workspace operations, one at a time (HI-1694, HR2's round 1 finding): an open, close or upgrade claims the
// window, checked and taken at once; another is refused while it holds it, saying why; only the claim's own operation
// moves its steps on or lets it go, so a stale one can't clear a newer one's view.
import { describe, expect, it } from 'vitest'

const { assertNotOpening, claimWindow, openProgress, openStep, releaseWindow, windowClaim } = await import('../src/main/openProgress')
type WS = Parameters<typeof claimWindow>[0]

/** A window's workspace service, as far as the claims see it (no window to tell). */
const service = (): WS => ({ window: null }) as unknown as WS

describe("a window's claim (HI-1694)", () => {
  it('refuses a second operation while one holds the window, naming the workspace; free again once let go', () => {
    const ws = service()
    const open = claimWindow(ws, 'D:\\Work\\Tools', 'projects')
    expect(() => claimWindow(ws, 'D:\\Work\\Other', 'projects')).toThrow('Tools is still opening')
    expect(() => assertNotOpening(ws)).toThrow('Tools is still opening')
    releaseWindow(ws, open)
    expect(() => assertNotOpening(ws)).not.toThrow()
    // A close holds it too, shown as no step, and said as closing.
    const close = claimWindow(ws, 'D:\\Work\\Tools', null)
    expect(openProgress(ws)).toBeNull()
    expect(() => claimWindow(ws, 'D:\\Work\\Other', 'projects')).toThrow('Tools is still closing')
    releaseWindow(ws, close)
    // Each window its own.
    const other = service()
    const a = claimWindow(ws, 'D:\\Work\\Tools', 'projects')
    expect(() => claimWindow(other, 'D:\\Work\\Other', 'projects')).not.toThrow()
    releaseWindow(ws, a)
  })

  it("only the claim's own operation moves its steps or lets it go: a stale one changes nothing", () => {
    const ws = service()
    const first = claimWindow(ws, 'D:\\Work\\Tools', 'projects')
    releaseWindow(ws, first)
    const second = claimWindow(ws, 'D:\\Work\\Other', 'projects')
    // The first operation, finishing late, neither lets the second's claim go nor moves its steps.
    releaseWindow(ws, first)
    openStep(ws, 'skills', { done: 1, total: 20 }, { token: first })
    openStep(ws, 'skills', { done: 1, total: 20 }, { path: 'D:\\Work\\Tools' })
    expect(openProgress(ws)).toEqual({ path: 'D:\\Work\\Other', name: 'Other', step: 'projects' })
    // Its own do.
    openStep(ws, 'skills', { done: 3, total: 20 }, { path: 'D:\\Work\\Other' })
    expect(openProgress(ws)).toEqual({ path: 'D:\\Work\\Other', name: 'Other', step: 'skills', done: 3, total: 20 })
    expect(windowClaim(ws)).toBe(second)
    releaseWindow(ws, second)
    expect(openProgress(ws)).toBeNull()
    expect(windowClaim(ws)).toBeNull()
  })

  it('a step with no operation under way (a workspace opened another way) shows nothing', () => {
    const ws = service()
    openStep(ws, 'skills', { done: 1, total: 2 })
    expect(openProgress(ws)).toBeNull()
  })
})
