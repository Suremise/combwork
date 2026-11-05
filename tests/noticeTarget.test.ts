// A click on a notice with a target (HI-1961: cw_notify's): an agent's pane or a card's dialog in the window that has
// it, a short notice when it is gone by then, and a project another window has handed to that window (notice:action).
// The real renderer store, main's IPC recorded.
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToastTarget, WorkspaceInfo } from '../src/shared/types'

/** What the window asked main for, in order. */
const calls: { channel: string; args: unknown[] }[] = []
;(globalThis as unknown as { window: unknown }).window = {
  combwork: {
    invoke: (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      return Promise.resolve(null)
    },
    on: () => () => {}
  },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} })
}
// The renderer's modules, typed here by what the test uses: the main process's typecheck doesn't follow renderer code.
interface RendererStore {
  set: (u: Record<string, unknown>) => void
  get: () => { taskOpen: unknown; toasts: { title: string }[]; selectedProject: string | null }
}
const rendererStore = '../src/renderer/src/store'
const rendererTarget = '../src/renderer/src/noticeTarget'
const store = (await import(/* @vite-ignore */ rendererStore)) as RendererStore
const { openNoticeTarget, showNoticeTarget } = (await import(/* @vite-ignore */ rendererTarget)) as { openNoticeTarget: (t: ToastTarget) => void; showNoticeTarget: (t: ToastTarget) => void }

const ALPHA = 'C:/ws/alpha'
const ws = { path: 'C:/ws', projects: [{ path: ALPHA, name: 'alpha', agents: [{ id: 'a-1', name: 'HB4' }], config: { agents: [{ id: 'a-1', name: 'HB4' }] } }] } as unknown as WorkspaceInfo
const agent = (agentId: string, projectPath = ALPHA): ToastTarget => ({ kind: 'agent', projectPath, agentId, name: 'HB4', project: 'alpha' })
const card = (number: number, workspacePath = 'C:/ws', projectPath: string | null = ALPHA): ToastTarget => ({ kind: 'card', number, label: `AL-${number}`, projectPath, workspacePath })
/** Another workspace, whose board has a card 12 of its own. */
const other = { path: 'C:/ws-b', projects: [{ path: 'C:/ws-b/beta', name: 'beta', agents: [], config: { agents: [] } }] } as unknown as WorkspaceInfo

beforeEach(() => {
  calls.length = 0
  store.set({ workspace: ws, tasks: [{ number: 12, project: 'alpha', column: 'doing' }], taskOpen: null, toasts: [], notifications: [], selectedProject: null })
})

describe("a notice's target (HI-1961)", () => {
  it('an agent: its project shown, and its pane', () => {
    openNoticeTarget(agent('a-1'))
    expect(store.get().selectedProject).toBe(ALPHA)
    expect(store.get().toasts).toEqual([])
  })

  it('an agent removed since: says so, nothing opened', () => {
    openNoticeTarget(agent('a-gone'))
    expect(store.get().toasts.map((t) => t.title)).toEqual(["HB4 isn't in alpha any more"])
    expect(store.get().selectedProject).toBeNull()
  })

  it('a card: its dialog', () => {
    openNoticeTarget(card(12))
    expect(store.get().taskOpen).toBe(12)
  })

  it('a card deleted since: says so, no dialog', () => {
    openNoticeTarget(card(99))
    expect(store.get().taskOpen).toBeNull()
    expect(store.get().toasts.map((t) => t.title)).toEqual(["AL-99 isn't on the board any more"])
  })

  it("a project this window doesn't have: handed to the window that has it", () => {
    const elsewhere = agent('a-1', 'C:/other/beta')
    openNoticeTarget(elsewhere)
    expect(calls.filter((c) => c.channel.startsWith('notice:'))).toEqual([{ channel: 'notice:target', args: [elsewhere] }])
    expect(store.get().toasts).toEqual([])
  })

  // HR6 round 1, finding 1: a card's number is its workspace's alone. A notice kept from workspace C:/ws, clicked after
  // this window moved to C:/ws-b (which has a card 12 of its own), never opens C:/ws-b's card 12, with a project or without.
  for (const [what, projectPath] of [['a project card', ALPHA], ['a workspace card (no project)', null]] as const) {
    it(`${what} of another workspace with the same number: handed on by its workspace, never this board's card`, () => {
      store.set({ workspace: other, tasks: [{ number: 12, project: 'beta', column: 'doing' }] })
      const old = card(12, 'C:/ws', projectPath)
      openNoticeTarget(old)
      expect(store.get().taskOpen).toBeNull()
      expect(calls.filter((c) => c.channel.startsWith('notice:'))).toEqual([{ channel: 'notice:target', args: [old] }])
      // No window has C:/ws: main hands it back to this one (notice.openTarget), which says so.
      showNoticeTarget(old)
      expect(store.get().taskOpen).toBeNull()
      expect(store.get().toasts.map((t) => t.title)).toEqual(["AL-12 is on ws's board, which isn't open"])
    })
  }

  it('a card of this workspace, named by another case of its path: its dialog', () => {
    openNoticeTarget(card(12, 'c:/WS'))
    expect(store.get().taskOpen).toBe(12)
  })
})
