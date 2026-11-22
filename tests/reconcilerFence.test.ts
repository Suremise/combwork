// A reconcile asked for from inside a merge queue's fenced work (HI-3292): its run starts outside that fence. A commit's
// listeners and the queue's own target moves run in the queue's async context, and the reconciler's timer carried its
// fence into the run, so once the queue's runner let its lease go every write the run made threw LeaseLost ("the merge
// queue for <target> is run by another Combwork now"). The workspace, the workflow and the per-card reconcile are stood
// in for; the reconciler, the store and its fence are real.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const { FactStore, withWriteFence } = await import('../src/main/workflow/factStore')
const store = FactStore.open(join(tempDir('cw-reconciler-fence-'), 'board.db'), { project: 'shop', key: 'SH' })
const results: string[] = []
vi.mock('../src/main/workflow/reconcile', () => ({
  reconcile: async (_wf: unknown, card: { id: number }) => {
    try {
      store.setMeta(`reconciled:${card.id}`, 'yes')
      results.push('wrote')
    } catch (e) {
      results.push(`refused: ${(e as Error).message}`)
    }
  }
}))
const card = { id: 1, key: 'SH-1', stage: 'approved' }
vi.mock('../src/main/workflow/service', () => ({
  workflowFor: async () => ({ store: { cards: () => [card], meta: () => null }, state: () => ({ started: { target: 'main' } }), platform: () => ({}), cfg: { options: () => ({}) } })
}))
vi.mock('../src/main/platform/historyPorts', () => ({ historyOf: () => null, observePort: { subscribe: () => ({ dispose: () => undefined }) } }))
vi.mock('../src/main/boardStore', async (actual) => ({ ...(await actual<object>()), boardReadOnly: () => false }))
vi.mock('../src/main/events', () => ({ onCombworkEvent: () => () => undefined }))
const ws = { path: 'C:\\w', lifetime: { aborted: false }, repairingMove: false, info: () => ({ projects: [{ path: 'C:\\w\\shop', name: 'shop', platform: { id: 'git' } }] }) }
vi.mock('../src/main/workspace', () => ({ openWorkspaces: () => [ws], WorkspaceService: { closingListeners: new Set() } }))

const { reconcileCard, reconcileWorkspace, reconcilerTestHooks, startReconciling, stopReconciling } = await import('../src/main/workflow/reconciler')

/** A queue's fence once its runner has let the target go. */
const lost = (): void => {
  throw new Error('the merge queue for main is run by another Combwork now')
}

/** The next run's end. Real timers: fake ones don't carry an async context through setTimeout, as Node's do (the bug). */
const ran = (): Promise<void> =>
  new Promise((resolve) => {
    reconcilerTestHooks.ran = () => {
      reconcilerTestHooks.ran = null
      resolve()
    }
  })

describe("a reconcile asked for inside a queue's write fence (HI-3292)", () => {
  beforeEach(() => {
    results.length = 0
    startReconciling()
  })
  afterEach(() => {
    reconcilerTestHooks.ran = null
    stopReconciling()
  })

  it("a card's reconcile asked for there runs outside the fence: its writes are made", async () => {
    const done = ran()
    await withWriteFence(lost, async () => reconcileCard(ws as never, 1, 'shop'))
    await done
    expect(results).toEqual(['wrote'])
    expect(store.meta('reconciled:1')).toBe('yes')
  })

  it("a whole project's run asked for there writes too", async () => {
    const done = ran()
    await withWriteFence(lost, async () => reconcileWorkspace(ws as never))
    await done
    expect(results).toEqual(['wrote'])
  })

  it('the fence still refuses a write made inside it (the test sees the fence)', async () => {
    await withWriteFence(lost, async () => {
      expect(() => store.setMeta('inside', 'x')).toThrow(/run by another Combwork now/)
    })
  })
})
