// The window's stall check reads who asked the user what (HI-2080: askedByNow) only from For you as a view accepted it
// for the workspace open now (HR1's round 1): a reply that finishes after a newer read, or for another workspace, never
// counts (scopedLoads drops it, as useScopedLoad does), so an answered question doesn't come back, and a workspace's
// questions don't carry into another. useForYou runs here with React's hooks stood in for and the real scopedLoads.
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ws: 'A',
  reads: 1,
  scoped: { scope: '', data: null as unknown, error: null as string | null, at: 0 },
  loader: null as null | ((asked: string, loader: () => Promise<unknown>) => void),
  replies: [] as { resolve: (x: unknown) => void; promise: Promise<unknown> }[]
}))

vi.mock('react', () => ({ useEffect: (fn: () => unknown) => void fn(), useMemo: (fn: () => unknown) => fn() }))
vi.mock('../src/renderer/src/store', () => {
  const now = () => ({ workspace: { path: state.ws }, boardReads: state.reads })
  return { useStore: Object.assign((select: (s: unknown) => unknown) => select(now()), { getState: now }) }
})
vi.mock('../src/renderer/src/scopedLoad', async () => {
  const { scopedLoads } = await import('../src/shared/scoped')
  return {
    useScopedLoad: (scope: string) => {
      state.loader ??= scopedLoads((next) => void (state.scoped = next(state.scoped as never) as never), () => state.ws) as never
      return { data: state.scoped.scope === scope ? state.scoped.data : null, load: state.loader }
    }
  }
})
vi.stubGlobal('window', {
  hive: {
    invoke: () => {
      let resolve!: (x: unknown) => void
      const promise = new Promise((r) => (resolve = r))
      state.replies.push({ resolve, promise })
      return promise
    }
  }
})

// Through a variable, as the other window modules' tests import them: the node typecheck can't follow the window's aliases.
const forYouModule = '../src/renderer/src/forYou'
const { askedByNow, useForYou } = (await import(/* @vite-ignore */ forYouModule)) as { askedByNow: (card: number, agentId: string) => boolean; useForYou: () => unknown }
const asked = (card: number, asker: string) => ({ items: [{ card, asker, request: `r${card}` }], count: 1 })
const none = { items: [], count: 0 }
/** Lets each reply's handlers run (scopedLoads settles on the promise's then). */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe("the window's stall check reads For you as accepted (HI-2080)", () => {
  it('an older reply finishing after the answer never brings the question back; another workspace never sees it', async () => {
    useForYou()
    state.reads++
    useForYou()
    const [old, fresh] = state.replies
    // The read after the answer finishes first: nothing open.
    fresh.resolve(none)
    await settle()
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(false)
    // The read from before the answer finishes late: dropped, so still nothing open.
    old.resolve(asked(1, 'r1'))
    await settle()
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(false)

    // A new question, accepted: open.
    state.reads++
    useForYou()
    state.replies.at(-1)!.resolve(asked(1, 'r1'))
    await settle()
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(true)
    expect(askedByNow(1, 'b1')).toBe(false)

    // Another workspace opened, its read not in yet: A's questions aren't its.
    state.ws = 'B'
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(false)
    // A's reply for a read started before the switch lands late: dropped for B too.
    state.replies.at(-2)?.resolve(asked(1, 'r1'))
    await settle()
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(false)
    state.replies.at(-1)!.resolve(none)
    await settle()
    useForYou()
    expect(askedByNow(1, 'r1')).toBe(false)
  })
})
