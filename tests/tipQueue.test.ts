// HI-2320 (HR2's round 1, finding 6): a tip waiting for a quiet moment stays waiting behind a group of finishes. The
// group is told before main says no finish is pending any more (FinishBatcher), so the window sees the finish's pop-up
// first and the tip waits for it to close; then it shows. The real FinishBatcher, store and tips logic, the window's
// IPC stood in for.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', {
  combwork: { invoke: async () => undefined, onEvent: () => () => undefined, send: () => undefined },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
  matchMedia: () => ({ matches: false, addEventListener: () => undefined })
})

// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface Store {
  get: () => { tipShown: string | null; tips: { moments: string[] } }
  set: (u: Record<string, unknown>) => void
  pushToast: (t: Record<string, unknown>) => void
  dismissToast: (id: string) => void
}
interface Tips {
  offerTip: (moment: string) => void
  tryQueuedTip: () => void
  queuedTip: () => { moment?: string } | null
}
const STORE = '../src/renderer/src/store'
const TIPS = '../src/renderer/src/tips'

describe('a queued tip behind a group of finishes', () => {
  it('is not used up as the group is told: it shows only once the finish pop-up has gone', async () => {
    const { FinishBatcher } = await import('../src/shared/bursts')
    const store = (await import(/* @vite-ignore */ STORE)) as Store
    const tips = (await import(/* @vite-ignore */ TIPS)) as Tips
    const { DEFAULT_SETTINGS } = await import('../src/shared/defaults')
    store.set({ settings: { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, showTips: true } }, windowFocused: true, finishesPending: 1 })
    // A moment's tip while finishes are being collected: it waits.
    tips.offerTip('second-agent')
    expect(tips.queuedTip()?.moment).toBe('second-agent')
    expect(store.get().tipShown).toBe(null)
    // Main tells the group, then says none is pending: the window hears them in that order (one channel).
    vi.useFakeTimers()
    const order: string[] = []
    const batch = new FinishBatcher(
      () => {
        order.push('told')
        store.pushToast({ id: 'f1', kind: 'finished', level: 'success', title: 'alpha finished', timestamp: new Date().toISOString() })
      },
      Date.now,
      (n) => {
        order.push(`pending ${n}`)
        store.set({ finishesPending: n })
        tips.tryQueuedTip()
      }
    )
    batch.add({ projectPath: 'C:\\w\\alpha', project: 'alpha', agent: 'One', title: 'alpha finished', body: '' })
    vi.advanceTimersByTime(3000)
    vi.useRealTimers()
    expect(order).toEqual(['pending 1', 'told', 'pending 0'])
    expect(store.get().tipShown).toBe(null)
    expect(tips.queuedTip()?.moment).toBe('second-agent')
    expect(store.get().tips.moments).not.toContain('second-agent')
    // The finish pop-up closes: now it is quiet, and the tip shows.
    store.dismissToast('f1')
    tips.tryQueuedTip()
    expect(store.get().tipShown).toBe('agent-layouts')
    expect(tips.queuedTip()).toBe(null)
  })
})

// HI-2424: with agent pop-ups set to None, a "needs you" comes quietly (bell only). It still closes a tip showing, and
// stays out of the pop-ups.
describe('a quiet entry arriving', () => {
  it('closes a tip showing and goes only to the bell', async () => {
    const store = (await import(/* @vite-ignore */ STORE)) as Store
    store.set({ tipShown: 'agent-layouts', toasts: [] })
    store.pushToast({ id: 'n1', kind: 'needsYou', level: 'info', title: 'alpha · One needs you', quiet: true, timestamp: new Date().toISOString() })
    const s = store.get() as unknown as { tipShown: string | null; toasts: { id: string }[]; notifications: { id: string }[] }
    expect(s.tipShown).toBe(null)
    expect(s.toasts.map((x) => x.id)).not.toContain('n1')
    expect(s.notifications.map((x) => x.id)).toContain('n1')
  })
})
