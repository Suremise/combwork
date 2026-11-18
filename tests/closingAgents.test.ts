// HI-3376: closing a workspace, switching it or quitting waits for its agents to have really closed (runs, starts, slot
// writers), says so in the closing windows past a second, says they are still closing past the deadline their CLIs' exit
// graces give and keeps waiting, until they have or the user's Don't wait; only a quit with no window goes on by itself.
// Fake windows and fake time: no Electron.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosingAgentsState } from '../src/shared/types'

const { waitForAgentsClosed, closingAgentsDontWait, closingAgentsState, closingLimits } = await import('../src/main/closingAgents')
const { stopWaitMs, CLOSE_WRITERS_MS, KILL_EXIT_MS } = await import('../src/main/sessions')
type Win = Parameters<typeof closingAgentsState>[0]

let nextId = 1
function fakeWindow(visible = true) {
  const listeners = new Set<() => void>()
  const w = {
    webContents: { id: nextId++ },
    destroyed: false,
    visible,
    shownInactive: 0,
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    showInactive: () => void ((w.visible = true), w.shownInactive++),
    once: (_e: 'closed', fn: () => void) => void listeners.add(fn),
    removeListener: (_e: 'closed', fn: () => void) => void listeners.delete(fn),
    listeners,
    close: () => {
      w.destroyed = true
      for (const fn of [...listeners]) fn()
      listeners.clear()
    }
  }
  return w
}

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

/** A wait on `pending` (changed by the test), in `wins`, its panel states recorded per window. */
function start(pending: { running: number; starting: number; writers: number }, deadlineMs: number, wins: () => Win[]) {
  const sent: { win: number; state: ClosingAgentsState | null }[] = []
  let how: string | null = null
  void waitForAgentsClosed({ pending: () => ({ ...pending }), deadlineMs, windows: wins, send: (w, state) => sent.push({ win: w.webContents.id, state }), quiet: false }).then((h) => (how = h))
  return { sent, how: () => how }
}

describe('the deadline from the CLIs\' exit graces (HI-3376)', () => {
  it('the default grace (30 s) gives 65 s before "still closing"; a saved 300 s grace gives 335 s; none, the writers\' 30 s', () => {
    expect(KILL_EXIT_MS).toBe(5000)
    expect(stopWaitMs(0, [30_000]) + CLOSE_WRITERS_MS).toBe(65_000)
    expect(stopWaitMs(0, [30_000, 300_000]) + CLOSE_WRITERS_MS).toBe(335_000)
    expect(stopWaitMs(0, []) + CLOSE_WRITERS_MS).toBe(30_000)
  })
})

describe('waiting for agents to close (HI-3376)', () => {
  it('closed within a second: settled, nothing shown', async () => {
    const p = { running: 1, starting: 0, writers: 0 }
    const w = fakeWindow()
    const r = start(p, 65_000, () => [w])
    await vi.advanceTimersByTimeAsync(500)
    p.running = 0
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(r.how()).toBe('settled')
    expect(r.sent).toEqual([])
  })

  it('past a second: shown with what is left (runs, starts, writers), updated as they close, taken down once all have; listeners let go', async () => {
    const p = { running: 2, starting: 1, writers: 0 }
    const w = fakeWindow()
    const r = start(p, 65_000, () => [w])
    await vi.advanceTimersByTimeAsync(closingLimits.showAfterMs)
    expect(r.sent.at(-1)?.state).toMatchObject({ running: 2, starting: 1, writers: 0, late: false })
    expect(closingAgentsState(w)).toMatchObject({ running: 2 })
    p.running = 0
    p.starting = 0
    p.writers = 1
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    // Never "0 left" while blocked: the writer still counts.
    expect(r.sent.at(-1)?.state).toMatchObject({ running: 0, starting: 0, writers: 1 })
    p.writers = 0
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(r.how()).toBe('settled')
    expect(r.sent.at(-1)).toEqual({ win: w.webContents.id, state: null })
    expect(closingAgentsState(w)).toBeNull()
    expect(w.listeners.size).toBe(0)
    // Nothing more is looked at or sent after.
    const n = r.sent.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.sent.length).toBe(n)
  })

  it('past the deadline: said as still closing, and still waited for (never taken as closed)', async () => {
    const p = { running: 1, starting: 0, writers: 0 }
    const w = fakeWindow()
    const r = start(p, 65_000, () => [w])
    await vi.advanceTimersByTimeAsync(65_000)
    expect(r.sent.at(-1)?.state).toMatchObject({ late: true, running: 1 })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(r.how()).toBeNull()
    p.running = 0
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(r.how()).toBe('settled')
  })

  it("Don't wait: skipped, the panel taken down; another wait's id does nothing", async () => {
    const p = { running: 1, starting: 0, writers: 0 }
    const w = fakeWindow()
    const r = start(p, 65_000, () => [w])
    await vi.advanceTimersByTimeAsync(2000)
    const id = closingAgentsState(w)!.id
    closingAgentsDontWait(w, 'closing-other')
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(r.how()).toBeNull()
    closingAgentsDontWait(w, id)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.how()).toBe('skipped')
    expect(r.sent.at(-1)?.state).toBeNull()
    expect(w.listeners.size).toBe(0)
  })

  it("two windows, two waits: each window shows its own, and one's Don't wait ends only its own", async () => {
    const a = fakeWindow()
    const b = fakeWindow()
    const pa = { running: 1, starting: 0, writers: 0 }
    const pb = { running: 1, starting: 0, writers: 0 }
    const ra = start(pa, 65_000, () => [a])
    const rb = start(pb, 65_000, () => [b])
    await vi.advanceTimersByTimeAsync(2000)
    const idA = closingAgentsState(a)!.id
    expect(closingAgentsState(b)!.id).not.toBe(idA)
    // A's id pressed in B does nothing.
    closingAgentsDontWait(b, idA)
    closingAgentsDontWait(a, idA)
    await vi.advanceTimersByTimeAsync(0)
    expect(ra.how()).toBe('skipped')
    expect(rb.how()).toBeNull()
    expect(closingAgentsState(b)).not.toBeNull()
    pb.running = 0
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(rb.how()).toBe('settled')
  })

  it('a hidden window (closed to the tray) is shown, without the focus, so the wait can be seen', async () => {
    const w = fakeWindow(false)
    start({ running: 1, starting: 0, writers: 0 }, 65_000, () => [w])
    await vi.advanceTimersByTimeAsync(2000)
    expect(w.shownInactive).toBe(1)
  })

  it('no window at all (a quit with none): goes on at the deadline, unattended; its window closed meanwhile, the same', async () => {
    const r1 = start({ running: 1, starting: 0, writers: 0 }, 65_000, () => [])
    await vi.advanceTimersByTimeAsync(65_000 - closingLimits.lookMs)
    expect(r1.how()).toBeNull()
    await vi.advanceTimersByTimeAsync(closingLimits.lookMs)
    expect(r1.how()).toBe('unattended')
    const w = fakeWindow()
    const r2 = start({ running: 1, starting: 0, writers: 0 }, 65_000, () => (w.destroyed ? [] : [w]))
    await vi.advanceTimersByTimeAsync(2000)
    w.close()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(r2.how()).toBe('unattended')
  })
})
