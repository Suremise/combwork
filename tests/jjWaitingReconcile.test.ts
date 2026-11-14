// The window's Waiting for you to integrate asks for a reconciliation of each card it lists with no observation yet
// (HI-2896): an approval changes no jj operation or ref, so in a repository not colocated with Git nothing else would
// write that card's containment record until the next jj command (the panel stayed "Not checked yet"). A card with its
// observation isn't asked again. The workflow and the reconciler are stood in for; waitingOf's own reading is real.
import { describe, expect, it, vi } from 'vitest'

const asked: [unknown, number, string][] = []
vi.mock('../src/main/workflow/reconciler', () => ({ reconcileCard: (ws: unknown, n: number, project: string) => void asked.push([ws, n, project]) }))
// The service holding the project, as the reconciler follows it (the IPC hands over the window's proxy).
vi.mock('../src/main/workspace', async (original) => ({ ...(await original<typeof import('../src/main/workspace')>()), workspaceOf: () => 'the holder' }))

const C = (c: string): string => c.repeat(40)
const card = (id: number, key: string) => ({ id, key, stage: 'approved' })
const state = { cycle: 1, approved: { revision: C('a'), base: C('b') }, latest: { id: 7, key: null, platform: { jj: { commitId: C('a'), changeId: 'z'.repeat(32) } } }, started: { target: 'main' } }
const cards = [card(1, 'SH-1'), card(2, 'SH-2')]
const { containedKey } = await import('../src/main/workflow/reconcile')
const meta = new Map<string, string>([[containedKey('p1', 'SH-2', 1), JSON.stringify({ submission: 7, revision: C('a'), base: C('b'), key: null, commit: C('a'), target: 'main', state: 'notYet', at: 1 })]])
vi.mock('../src/main/workflow/service', () => ({
  workflowFor: async () => ({ store: { cards: () => cards, boardMeta: (k: string) => meta.get(k) ?? null }, state: () => state })
}))
const { jjWaiting } = await import('../src/main/jjWindow')

describe('Waiting for you to integrate asks for a reconciliation of a card with no observation (HI-2896)', () => {
  it('the card with none is asked for, the one with its observation is not', async () => {
    const ws = { info: () => ({ projects: [{ path: 'C:\\w\\shop', name: 'shop' }] }), projectIdsNow: () => ({ byPath: new Map([['c:\\w\\shop', 'p1']]) }) }
    const rows = await jjWaiting(ws as never, 'C:\\w\\shop')
    expect(rows.map((r) => [r.card, r.contained?.state ?? null])).toEqual([
      [1, null],
      [2, 'notYet']
    ])
    expect(asked).toEqual([['the holder', 1, 'shop']])
  })
})
