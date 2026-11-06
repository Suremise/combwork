// A window's startup (#295): it listens for events, then loads its snapshot (ui:get), which can be older than a change
// another window made meanwhile. The tips and project preferences that arrive before the snapshot is applied are handled
// again after it, so the older snapshot doesn't undo them. Here in the order App.tsx does it, with the tips' own rules.
import { describe, expect, it } from 'vitest'
import { startupReplay } from '../src/renderer/src/startupReplay'
import { applyTipsChange, EMPTY_TIPS_STATE, type TipsState } from '../src/shared/tips'
import type { CombworkEvent } from '../src/shared/types'

/** A window's store, as App.tsx's handleEvent and its startup set it. */
function windowStore() {
  const store = { tips: EMPTY_TIPS_STATE as TipsState, panes: {} as Record<string, unknown>, settings: 'old' }
  const handle = (e: CombworkEvent): void => {
    if (e.type === 'tips-changed') store.tips = e.tips
    else if (e.type === 'ui-pref-changed') store[e.pref as 'panes'] = { ...store[e.pref as 'panes'], [e.project]: e.value }
    else if (e.type === 'settings-changed') store.settings = 'new'
  }
  return { store, handle }
}

describe('a window starting while another changes things', () => {
  const old: TipsState = { ...EMPTY_TIPS_STATE, shownOn: '2000-01-01' }
  const today = applyTipsChange(old, { shownOn: '2026-10-06' })

  it("keeps a tips change that arrived before the older snapshot (the day's tip isn't shown again)", () => {
    const { store, handle } = windowStore()
    const early = startupReplay(handle)
    const event = { type: 'tips-changed', tips: today } as CombworkEvent
    handle(event)
    early.note(event)
    expect(store.tips.shownOn).toBe('2026-10-06')
    // The snapshot, read before that change, applied after it.
    store.tips = old
    early.settle()
    expect(store.tips.shownOn).toBe('2026-10-06')
  })

  it("keeps a project preference that arrived before the snapshot, with the snapshot's others", () => {
    const { store, handle } = windowStore()
    const early = startupReplay(handle)
    const event = { type: 'ui-pref-changed', pref: 'panes', project: 'alpha', value: { layout: 'columns' } } as unknown as CombworkEvent
    handle(event)
    early.note(event)
    store.panes = { beta: { layout: 'single' } }
    early.settle()
    expect(store.panes).toEqual({ beta: { layout: 'single' }, alpha: { layout: 'columns' } })
  })

  it('replays in order, only those events, only once, and nothing after the snapshot', () => {
    const { store, handle } = windowStore()
    const seen: string[] = []
    const early = startupReplay<CombworkEvent>((e) => {
      seen.push(e.type)
      handle(e)
    })
    const first = { type: 'tips-changed', tips: old } as CombworkEvent
    const second = { type: 'tips-changed', tips: today } as CombworkEvent
    for (const e of [first, { type: 'settings-changed' } as CombworkEvent, second]) early.note(e)
    early.settle()
    expect(seen).toEqual(['tips-changed', 'tips-changed'])
    expect(store.tips.shownOn).toBe('2026-10-06')
    early.note(first)
    early.settle()
    expect(seen).toHaveLength(2)
    expect(store.settings).toBe('old')
  })
})

describe('a startup run twice (StrictMode in development: setup, cleanup, setup) (#337)', () => {
  const old: TipsState = { ...EMPTY_TIPS_STATE, shownOn: '2000-01-01' }
  const today = applyTipsChange(old, { shownOn: '2026-10-06' })

  /** App.tsx's startup effect: listen, load the snapshot, apply it unless cleaned up meanwhile, then replay. */
  function effect(bus: Set<(e: CombworkEvent) => void>, w: ReturnType<typeof windowStore>, snapshot: Promise<{ tips: TipsState; panes: Record<string, unknown> }>) {
    const early = startupReplay(w.handle)
    const listener = (e: CombworkEvent): void => {
      w.handle(e)
      early.note(e)
    }
    bus.add(listener)
    const done = (async () => {
      const s = await snapshot
      if (!early.active()) return
      w.store.tips = s.tips
      w.store.panes = s.panes
      early.settle()
    })()
    return {
      done,
      cleanup: () => {
        bus.delete(listener)
        early.stop()
      }
    }
  }

  it("the first run finishing last doesn't apply its older snapshot over the second's and a change only the second heard", async () => {
    const bus = new Set<(e: CombworkEvent) => void>()
    const w = windowStore()
    let first!: (s: { tips: TipsState; panes: Record<string, unknown> }) => void
    const one = effect(bus, w, new Promise((r) => (first = r)))
    one.cleanup()
    let second!: (s: { tips: TipsState; panes: Record<string, unknown> }) => void
    const two = effect(bus, w, new Promise((r) => (second = r)))
    // Another window shows the day's tip and changes a layout: only the second run listens.
    for (const l of bus) {
      l({ type: 'tips-changed', tips: today } as CombworkEvent)
      l({ type: 'ui-pref-changed', pref: 'panes', project: 'alpha', value: { layout: 'columns' } } as unknown as CombworkEvent)
    }
    second({ tips: old, panes: { beta: { layout: 'single' } } })
    await two.done
    expect(w.store.tips.shownOn).toBe('2026-10-06')
    expect(w.store.panes).toEqual({ beta: { layout: 'single' }, alpha: { layout: 'columns' } })
    // The first run's slow snapshot, read before both changes, arrives last.
    first({ tips: old, panes: {} })
    await one.done
    expect(w.store.tips.shownOn).toBe('2026-10-06')
    expect(w.store.panes).toEqual({ beta: { layout: 'single' }, alpha: { layout: 'columns' } })
  })

  it('a stopped run keeps and replays nothing', () => {
    const w = windowStore()
    const seen: string[] = []
    const early = startupReplay<CombworkEvent>((e) => seen.push(e.type))
    early.note({ type: 'tips-changed', tips: today } as CombworkEvent)
    expect(early.active()).toBe(true)
    early.stop()
    early.note({ type: 'tips-changed', tips: today } as CombworkEvent)
    early.settle()
    expect(early.active()).toBe(false)
    expect(seen).toEqual([])
    expect(w.store.tips).toBe(EMPTY_TIPS_STATE)
  })
})
