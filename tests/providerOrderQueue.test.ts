// The window's queue of provider moves (HI-1965, HR2's rounds 1 and 2): one move in flight at a time, so main takes them
// in the order they were made; the order shown is the store's, which only main's settings-changed writes (a move's reply
// is an acknowledgement); while moves are under way, or an acknowledged one isn't in the store yet, the list shows the
// order they make, and goes back to the store's once its revision is at or past the last acknowledged one, a newer
// order from elsewhere included. The store never takes an older order back. The real renderer store and queue, with the
// IPC call answered when each test says.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'

type Ack = { providerOrder: string[]; revision: number }
type Pending = { id: string; toIndex: number; answer: (a: Ack) => void; fail: (e: Error) => void }
const sent: Pending[] = []
;(globalThis as unknown as { window: unknown }).window = {
  hive: {
    invoke: (channel: string, id: string, toIndex: number) =>
      channel === 'settings:moveProvider' ? new Promise<Ack>((answer, fail) => sent.push({ id, toIndex, answer, fail })) : Promise.resolve(null),
    on: () => () => {}
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  get: () => { settings: AppSettings | null }
  set: (u: Record<string, unknown>) => void
}
interface Queue {
  moveProvider: (id: string, toIndex: number) => void
  providerMovesForTests: () => number
  resetProviderOrderForTests: () => void
}
const rendererStore = '../src/renderer/src/store'
const rendererQueue = '../src/renderer/src/providerOrder'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore
const queue = (await import(/* @vite-ignore */ rendererQueue)) as Queue

// The queue's order to show (null: the store's), and the order the list shows.
let queueShown: () => string[] | null = () => null
const shownNow = async (): Promise<string[]> => (queueShown() ?? store.get().settings!.providerOrder) as string[]

const HIVE = ['claude-code', 'codex', 'copilot']
/** Each test's revisions count from its own base, above every earlier one: the store never takes an older order back. */
let base = 0
/** main's settings-changed: the whole settings with this order and revision (from the test's base). */
const event = (order: string[], revision: number): void => store.set({ settings: { ...structuredClone(DEFAULT_SETTINGS), providerOrder: order, providerOrderRevision: base + revision } })
/** A move's acknowledgement, its revision from the test's base. */
const ack = (providerOrder: string[], revision: number): Ack => ({ providerOrder, revision: base + revision })

beforeEach(async () => {
  queue.resetProviderOrderForTests()
  sent.length = 0
  base = (store.get().settings?.providerOrderRevision ?? 0) + 100
  event(HIVE, 0)
  // The hook's snapshot, without React.
  queueShown = ((await import(/* @vite-ignore */ rendererQueue)) as { pendingProviderOrderForTests: () => string[] | null }).pendingProviderOrderForTests
})

describe("the window's provider moves (HI-1965)", () => {
  it('two moves while the first is slow: shown at once, sent one after the other', async () => {
    queue.moveProvider('copilot', 1)
    queue.moveProvider('copilot', 0)
    expect(await shownNow()).toEqual(['copilot', 'claude-code', 'codex'])
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({ id: 'copilot', toIndex: 1 })
    sent[0].answer(ack(['claude-code', 'copilot', 'codex'], 1))
    // Only once the first has settled is the second sent.
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ id: 'copilot', toIndex: 0 })
    event(['claude-code', 'copilot', 'codex'], 1)
    expect(await shownNow()).toEqual(['copilot', 'claude-code', 'codex'])
    sent[1].answer(ack(['copilot', 'claude-code', 'codex'], 2))
    event(['copilot', 'claude-code', 'codex'], 2)
    await vi.waitFor(() => expect(queueShown()).toBeNull())
    expect(store.get().settings!.providerOrder).toEqual(['copilot', 'claude-code', 'codex'])
  })

  it("A's event, then B's (another writer), then A's acknowledgement: the list shows B, the newer", async () => {
    queue.moveProvider('codex', 0)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    event(['codex', 'claude-code', 'copilot'], 1)
    event(['copilot', 'codex', 'claude-code'], 2)
    sent[0].answer(ack(['codex', 'claude-code', 'copilot'], 1))
    await vi.waitFor(() => expect(queueShown()).toBeNull())
    expect(await shownNow()).toEqual(['copilot', 'codex', 'claude-code'])
  })

  it("an acknowledgement before its event: the acknowledged order shows until the store has it", async () => {
    queue.moveProvider('codex', 0)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0].answer(ack(['codex', 'claude-code', 'copilot'], 1))
    // Its acknowledgement taken (the queue empty), the store still behind: the acknowledged order shows.
    await vi.waitFor(() => expect(queue.providerMovesForTests()).toBe(0))
    expect(queueShown()).toEqual(['codex', 'claude-code', 'copilot'])
    event(['codex', 'claude-code', 'copilot'], 1)
    expect(queueShown()).toBeNull()
  })

  it('a failed move with a newer one queued: the failed one drops out, the newer is kept', async () => {
    queue.moveProvider('copilot', 0)
    queue.moveProvider('codex', 0)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0].fail(new Error('disk full'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    // Without the failed move: Codex first over the store's order.
    expect(await shownNow()).toEqual(['codex', 'claude-code', 'copilot'])
    sent[1].answer(ack(['codex', 'claude-code', 'copilot'], 1))
    event(['codex', 'claude-code', 'copilot'], 1)
    await vi.waitFor(() => expect(queueShown()).toBeNull())
  })

  it('a success acknowledged before its event, then a failed move: the success still shows until the store has it', async () => {
    queue.moveProvider('codex', 0)
    queue.moveProvider('copilot', 0)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0].answer(ack(['codex', 'claude-code', 'copilot'], 1))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    sent[1].fail(new Error('disk full'))
    await vi.waitFor(() => expect(queue.providerMovesForTests()).toBe(0))
    expect(queueShown()).toEqual(['codex', 'claude-code', 'copilot'])
    event(['codex', 'claude-code', 'copilot'], 1)
    expect(queueShown()).toBeNull()
  })

  it('the store never takes an older order back from a late reply', () => {
    event(['copilot', 'codex', 'claude-code'], 3)
    // A settings:get or settings:update answered late, from before revision 3.
    store.set({ settings: { ...structuredClone(DEFAULT_SETTINGS), providerOrder: HIVE, providerOrderRevision: base + 2, defaultProvider: 'codex' } })
    expect(store.get().settings!.providerOrder).toEqual(['copilot', 'codex', 'claude-code'])
    expect(store.get().settings!.providerOrderRevision).toBe(base + 3)
    // The rest of it is taken.
    expect(store.get().settings!.defaultProvider).toBe('codex')
  })
})
