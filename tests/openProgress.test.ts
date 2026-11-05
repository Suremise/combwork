// A window's workspace operations, one at a time (HI-1694, HR2's round 1 finding): an open, close or upgrade claims the
// window, checked and taken at once; another is refused while it holds it, saying why; only the claim's own operation
// moves its steps on or lets it go, so a stale one can't clear a newer one's view.
import { describe, expect, it, vi } from 'vitest'

const { AfterOpen, assertNotOpening, claimWindow, openProgress, openStep, releaseWindow, windowClaim } = await import('../src/main/openProgress')
type WS = Parameters<typeof claimWindow>[0]
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

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
    openStep(ws, 'adoption', { token: first })
    openStep(ws, 'adoption', { path: 'D:\\Work\\Tools' })
    expect(openProgress(ws)).toEqual({ path: 'D:\\Work\\Other', name: 'Other', step: 'projects' })
    // Its own do.
    openStep(ws, 'adoption', { path: 'D:\\Work\\Other' })
    expect(openProgress(ws)).toEqual({ path: 'D:\\Work\\Other', name: 'Other', step: 'adoption' })
    expect(windowClaim(ws)).toBe(second)
    releaseWindow(ws, second)
    expect(openProgress(ws)).toBeNull()
    expect(windowClaim(ws)).toBeNull()
  })

  it('a step with no operation under way (a workspace opened another way) shows nothing', () => {
    const ws = service()
    openStep(ws, 'adoption')
    expect(openProgress(ws)).toBeNull()
  })
})

describe("what an open starts in the background, in one line (HI-1705)", () => {
  /** A step the test ends when it says: its promise, and how to settle it. */
  const step = () => {
    let end!: (fail?: boolean) => void
    const p = new Promise<void>((ok, no) => (end = (fail) => (fail ? no(new Error('failed')) : ok())))
    return { p, end }
  }

  it('says each part, failed ones too, once all have ended and nothing more is to come; one that never ran is left out', async () => {
    // What Combwork logs (to the console in an unpackaged build, as the tests are).
    const logged: string[] = []
    const keep = (...a: unknown[]): void => void logged.push(a.map(String).join(' '))
    const spies = [vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'error').mockImplementation(keep)]
    const said = (): string[] => logged.filter((l) => l.includes('after opening'))
    try {
      const after = new AfterOpen('Tools')
      const a = step()
      const b = step()
      after.track('the board', a.p)
      after.track('the slots', b.p).catch(() => undefined)
      after.track('the skills', Promise.resolve(), () => 0)
      a.end()
      await a.p
      after.seal()
      // One still running: nothing said yet.
      await new Promise((r) => setImmediate(r))
      expect(said()).toEqual([])
      b.end(true)
      await vi.waitFor(() => expect(said()).toHaveLength(1), { timeout: HUNG_MS })
      expect(said()[0]).toMatch(/after opening .*Tools.*: the board \d+ ms, the slots \d+ ms; \d+ ms in all/)
      expect(said()[0]).not.toContain('the skills')
      // Said once, whatever comes after.
      after.seal()
      await new Promise((r) => setImmediate(r))
      expect(said()).toHaveLength(1)
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })
})
