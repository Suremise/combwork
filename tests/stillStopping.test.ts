// HI-3376: the window waits up to a minute for an agent to stop, and when it is still stopping it says so and does
// nothing more: no remove, no new session, against a run still ending. The real renderer actions, with the window's
// IPC faked (an agent that never stops) and every question answered yes; time is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { channel: string; args: unknown[] }[] = []
let live: { projectPath: string; agentId: string }[] = []
;(globalThis as unknown as { window: unknown }).window = {
  combwork: {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      if (channel === 'session:live') return live
      if (channel === 'agents:remove') return { worktree: null }
      return null
    },
    on: () => () => {}
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}

// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
const rendererActions = '../src/renderer/src/actions'
const rendererStore = '../src/renderer/src/store'
const actions = (await import(/* @vite-ignore */ rendererActions)) as {
  removeAgent: (path: string, agentId: string) => Promise<void>
  removeAllAgents: (path: string) => Promise<void>
  STOP_WAIT_MS: number
}
type Dialog = { kind: string; resolve: (v: unknown) => void; choices?: { value: string }[] } | null
const store = (await import(/* @vite-ignore */ rendererStore)) as {
  useStore: { setState: (s: Record<string, unknown>) => void; getState: () => { dialog: Dialog; toasts?: { title: string; level: string }[] }; subscribe: (fn: (s: { dialog: Dialog }) => void) => () => void }
  closeDialog: () => void
}

const PATH = 'D:\\ws\\proj'
const agents = [
  { id: 'a-1', name: 'B1', place: { is: 'project', folder: PATH }, live: { sessionId: 's1' } },
  { id: 'a-2', name: 'B2', place: { is: 'project', folder: PATH }, live: { sessionId: 's2' } }
]

let unsubscribe = (): void => undefined
beforeEach(() => {
  calls.length = 0
  live = agents.map((a) => ({ projectPath: PATH, agentId: a.id }))
  store.useStore.setState({ workspace: { path: 'D:\\ws', projects: [{ path: PATH, name: 'proj', agents }] }, tasks: [], dialog: null })
  // Every question answered yes (a confirm), or with its first choice.
  unsubscribe = store.useStore.subscribe((s) => {
    const d = s.dialog
    if (!d) return
    queueMicrotask(() => {
      store.closeDialog()
      d.resolve(d.kind === 'confirm' ? true : (d.choices?.[0]?.value ?? null))
    })
  })
  vi.useFakeTimers()
})
afterEach(() => {
  unsubscribe()
  vi.useRealTimers()
})

const removes = (): number => calls.filter((c) => c.channel === 'agents:remove').length
const toastTitles = (): string[] => ((store.useStore.getState() as { toasts?: { title: string }[] }).toasts ?? []).map((t) => t.title)

describe('still stopping after a minute: nothing more is done (HI-3376)', () => {
  it('one agent: Remove stops it, waits a minute, says it is still stopping, and removes nothing', async () => {
    let done = false
    void actions.removeAgent(PATH, 'a-1').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(actions.STOP_WAIT_MS - 1000)
    expect(done).toBe(false)
    expect(calls.some((c) => c.channel === 'session:stop')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(done).toBe(true)
    expect(removes()).toBe(0)
    expect(toastTitles().some((t) => /B1 is still stopping/.test(t))).toBe(true)
  })

  it('Remove All: one agent still stopping, so none is removed', async () => {
    // a-1 stops; a-2 never does.
    live = [{ projectPath: PATH, agentId: 'a-2' }]
    let done = false
    void actions.removeAllAgents(PATH).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(actions.STOP_WAIT_MS + 10_000)
    expect(done).toBe(true)
    expect(removes()).toBe(0)
    expect(toastTitles().some((t) => /B2 is still stopping/.test(t))).toBe(true)
  })

  it('a session:live that never answers counts as still running, and the wait still ends at its bound', async () => {
    const real = (globalThis as unknown as { window: { combwork: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } } }).window.combwork
    const invoke = real.invoke
    real.invoke = (channel: string, ...args: unknown[]) => (channel === 'session:live' && calls.some((c) => c.channel === 'session:stop') ? new Promise(() => undefined) : invoke(channel, ...args))
    try {
      let done = false
      void actions.removeAgent(PATH, 'a-1').then(() => (done = true))
      await vi.advanceTimersByTimeAsync(actions.STOP_WAIT_MS + 10_000)
      expect(done).toBe(true)
      expect(removes()).toBe(0)
    } finally {
      real.invoke = invoke
    }
  })

  it('an agent that stops in time is removed, as before', async () => {
    let done = false
    void actions.removeAgent(PATH, 'a-1').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2000)
    live = []
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(true)
    expect(removes()).toBe(1)
  })
})
