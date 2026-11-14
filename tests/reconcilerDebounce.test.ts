// The reconciler's debounce (HI-2914): a run asked for again and again (Waiting read every 200 ms, each read asking for a
// run of a card with no observation; a burst of watch events) still starts within the debounce of the first ask. Each
// ask used to restart the wait, so while the asks went on nothing ran (jjlane's Waiting stayed "not checked yet" for its
// whole minute). The workspace, the workflow and the per-card reconcile are stood in for; the reconciler is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconciled: number[] = []
vi.mock('../src/main/workflow/reconcile', () => ({ reconcile: async (_wf: unknown, card: { id: number }) => void reconciled.push(card.id) }))
const card = { id: 1, key: 'SH-1', stage: 'approved' }
vi.mock('../src/main/workflow/service', () => ({
  workflowFor: async () => ({ store: { cards: () => [card], meta: () => null }, state: () => ({ started: { target: 'main' } }), platform: () => ({}), cfg: { options: () => ({}) } })
}))
vi.mock('../src/main/platform/historyPorts', () => ({ historyOf: () => null, observePort: { subscribe: () => ({ dispose: () => undefined }) }, repoWatchOf: () => null }))
vi.mock('../src/main/boardStore', () => ({ boardReadOnly: () => false }))
vi.mock('../src/main/events', () => ({ onCombworkEvent: () => () => undefined }))
const ws = { path: 'C:\\w', lifetime: { aborted: false }, repairingMove: false, info: () => ({ projects: [{ path: 'C:\\w\\shop', name: 'shop', platform: { id: 'jj' } }] }) }
vi.mock('../src/main/workspace', () => ({ openWorkspaces: () => [ws], WorkspaceService: { closingListeners: new Set() } }))

const { RECONCILE_DEBOUNCE_MS, reconcileCard, startReconciling, stopReconciling } = await import('../src/main/workflow/reconciler')

describe("the reconciler's debounce (HI-2914)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reconciled.length = 0
    startReconciling()
  })
  afterEach(() => {
    stopReconciling()
    vi.useRealTimers()
  })

  it('asks every 200 ms never put the run off: it starts within the debounce of the first', async () => {
    reconcileCard(ws as never, 1, 'shop')
    for (let t = 200; t <= RECONCILE_DEBOUNCE_MS + 200; t += 200) {
      await vi.advanceTimersByTimeAsync(200)
      reconcileCard(ws as never, 1, 'shop')
    }
    expect(reconciled.length).toBeGreaterThan(0)
  })

  it('a burst of asks within the debounce is one run', async () => {
    for (let i = 0; i < 5; i++) {
      reconcileCard(ws as never, 1, 'shop')
      await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS / 10)
    }
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS * 2)
    expect(reconciled).toEqual([1])
  })
})
