// HI-3623, HR1's round 1: lib.chooseTab's click probe. It always ends (its listeners and observer gone) through the page,
// whatever failed, the error keeping its own message with what the click saw; and a burst of page changes while the
// tab is pressed never crowds the release and the click out of what it reports. The page is stood in for here: its
// window's listeners, a MutationObserver fed by hand, and a tab whose box can move.
import { createRequire } from 'module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { timing } from './timing.cjs'

type Click = { events: string[]; changes: string[]; droppedEvents: number; droppedChanges: number } | null
const { chooseTab, tabClickProbe, tabClickEnd, tabClickNearMiss } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
  chooseTab: (tab: unknown, what: string, ms?: number) => Promise<void>
  tabClickProbe: (el: unknown) => void
  tabClickEnd: () => Click
  tabClickNearMiss: (click: Click) => boolean
}

type Listener = (e: unknown) => void
const g = globalThis as Record<string, unknown>
let listeners: Map<string, Set<Listener>>
let observers: { fire: (records: unknown[]) => void; connected: boolean }[]

/** An element stood in for: a tag, a class, a box. */
const node = (tag: string, cls: string, extra: Record<string, unknown> = {}) => ({ tagName: tag.toUpperCase(), className: cls, getAttribute: (a: string) => (a === 'data-tab' ? ((extra.tab as string) ?? null) : null), contains: (n: unknown) => n === extra.child, closest: () => null, ...extra })
const tabEl = (box = { x: 342, y: 189 }) => ({ ...node('button', 'cw-tab', { tab: 'workflow' }), isConnected: true, box, getBoundingClientRect() { return { x: this.box.x, y: this.box.y, width: 88, height: 30 } } })
const fire = (type: string, target: unknown) => {
  for (const l of listeners.get(type) ?? []) l({ type, target, clientX: 386, clientY: 204 })
}
const registered = () => [...listeners.values()].reduce((n, s) => n + s.size, 0)

beforeEach(() => {
  listeners = new Map()
  observers = []
  g.window = {
    addEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(l)),
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l)
  }
  g.document = { body: {} }
  g.MutationObserver = class {
    me: { fire: (records: unknown[]) => void; connected: boolean }
    constructor(cb: (records: unknown[]) => void) {
      this.me = { fire: cb, connected: false }
      observers.push(this.me)
    }
    observe() {
      this.me.connected = true
    }
    disconnect() {
      this.me.connected = false
    }
  }
})
afterEach(() => {
  delete g.window
  delete g.document
  delete g.MutationObserver
})

describe("chooseTab's click probe (HI-3623)", () => {
  it('a rejected click ends the probe through the page and keeps its own error, with what the click saw', async () => {
    const el = tabEl()
    const page = { evaluate: async (fn: () => unknown) => fn() }
    const tab = {
      page: () => page,
      getAttribute: async () => 'false',
      evaluate: async (fn: (el: unknown) => unknown) => fn(el),
      click: async () => {
        fire('pointerdown', el)
        throw new Error('locator.click: Target closed')
      }
    }
    const err = await chooseTab(tab, 'The Version Control section workflow', timing('hang.ui')).then(
      () => null,
      (e: Error) => e
    )
    expect(err?.message).toMatch(/^locator\.click: Target closed \(HI-3623, The Version Control section workflow: its click saw /)
    expect(err?.message).toContain('pointerdown at 386,204 on button[workflow].cw-tab')
    expect(registered()).toBe(0)
    expect(observers.every((o) => !o.connected)).toBe(true)
    expect((g.window as Record<string, unknown>).__cwTabClick).toBeUndefined()
  })

  it('a tab gone after its click (its read failing) still ends the probe, never needing the tab', async () => {
    const el = tabEl()
    const page = { evaluate: async (fn: () => unknown) => fn() }
    let clicked = false
    const tab = {
      page: () => page,
      getAttribute: async () => {
        if (clicked) throw new Error('locator.getAttribute: element was detached')
        return 'false'
      },
      evaluate: async (fn: (el: unknown) => unknown) => {
        if (clicked) throw new Error('the tab is gone')
        return fn(el)
      },
      click: async () => {
        fire('pointerdown', el)
        fire('mouseup', el)
        fire('click', el)
        clicked = true
      }
    }
    await expect(chooseTab(tab, 'The tab', timing('hang.ui'))).rejects.toThrow(/^locator\.getAttribute: element was detached \(HI-3623, The tab: its click saw .*click at 386,204/)
    expect(registered()).toBe(0)
    expect(observers.every((o) => !o.connected)).toBe(true)
  })

  it('a burst of changes while pressed is bounded and counted; the release and the click are still reported', () => {
    const el = tabEl()
    tabClickProbe(el)
    fire('pointerdown', el)
    fire('mousedown', el)
    const header = node('div', 'vc-header')
    observers[0].fire(Array.from({ length: 60 }, () => ({ type: 'childList', target: header, addedNodes: [node('div', 'banner')], removedNodes: [] })))
    // Where the release lands after the page moved under the press: another element, and the tab moved down.
    el.box = { x: 342, y: 231 }
    fire('pointerup', header)
    fire('mouseup', header)
    const click = tabClickEnd()
    expect(click?.changes).toHaveLength(20)
    expect(click?.droppedChanges).toBe(40)
    expect(click?.events.some((l) => l.includes('mouseup at 386,204 on div.vc-header, tab at 342,231'))).toBe(true)
    expect(click?.events.some((l) => l.includes('pointerup'))).toBe(true)
    expect(tabClickNearMiss(click)).toBe(true)
    expect(registered()).toBe(0)
  })

  it('a node removed around the tab is kept with its events, never dropped as one more change', () => {
    const el = tabEl()
    tabClickProbe(el)
    fire('pointerdown', el)
    const header = node('div', 'vc-header')
    observers[0].fire(Array.from({ length: 30 }, () => ({ type: 'attributes', attributeName: 'class', target: header, addedNodes: [], removedNodes: [] })))
    const row = node('div', 'cw-tabs-row', { child: el })
    observers[0].fire([{ type: 'childList', target: node('div', 'git-head'), addedNodes: [], removedNodes: [row] }])
    fire('mouseup', el)
    const click = tabClickEnd()
    expect(click?.events.some((l) => l.startsWith('removed around the tab: ') && l.includes('-div.cw-tabs-row'))).toBe(true)
    expect(click?.events.at(-1)).toMatch(/mouseup at 386,204 on button\[workflow\]/)
  })

  it('a clean click is no near miss; a probe ended twice gives nothing the second time', () => {
    const el = tabEl()
    tabClickProbe(el)
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(type, el)
    const click = tabClickEnd()
    expect(click?.events).toHaveLength(5)
    expect(tabClickNearMiss(click)).toBe(false)
    expect(tabClickEnd()).toBeNull()
  })
})
