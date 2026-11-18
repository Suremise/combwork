// HI-3370 (bug hunt, 18 Nov): the Assistant's churn-simplify delivery is checked against its question at each look. Made
// when the simplify check was asked, it used to be given however long after: the user answered it under For you meanwhile,
// and the Assistant was still told to answer it itself (its cw_answer_simplify then refused). The source's refresh (before
// it is given) and holds (at hand-out) now give it only while its question is open, and cancel it otherwise. The
// Assistant's permission and the project's runtime are stand-ins; the rule itself on a real board is churn.test.ts'.
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ canAct: true, open: new Set<string>(), runtime: true }))
const ws = { info: () => ({ projects: [{ name: 'p', path: 'D:\\ws\\p' }] }) }
const wf = {
  store: { card: (n: number) => ({ id: n }) },
  state: (c: { id: number }) => ({ requests: [...state.open].filter((k) => k.startsWith(`${c.id}/`)).map((k) => ({ request: k.slice(k.indexOf('/') + 1) })) })
}
vi.mock('../src/main/answerRelay', () => ({ assistantCanAct: () => state.canAct }))
vi.mock('../src/main/workspace', async (orig) => ({ ...(await orig<object>()), workspaceFor: () => ws }))
vi.mock('../src/main/workflow/service', () => ({ workflowFor: async () => (state.runtime ? wf : null), workflowNow: () => (state.runtime ? wf : null) }))

const { churnSimplifySource } = await import('../src/main/churnAssistant')
const told = { id: 'm1', ref: '#7/AM-7/r40', meta: { card: 7, project: 'p' } } as never

describe("the Assistant's simplify-check delivery (HI-3370)", () => {
  it('given while its question is open; cancelled once the user answered it (refresh), and not handed out (holds)', async () => {
    state.canAct = true
    state.runtime = true
    state.open = new Set(['7/AM-7/r40'])
    expect(await churnSimplifySource.refresh(told, 'D:\\ws\\.combwork\\assistant')).toBeNull()
    expect(churnSimplifySource.holds(told, 'D:\\ws\\.combwork\\assistant')).toBe(true)
    // The user answers it under For you.
    state.open.clear()
    expect(await churnSimplifySource.refresh(told, 'D:\\ws\\.combwork\\assistant')).toEqual({ cancel: expect.stringMatching(/answered or retired/) })
    expect(churnSimplifySource.holds(told, 'D:\\ws\\.combwork\\assistant')).toBe(false)
  })

  it("the Assistant no longer allowed to act: cancelled, as before; its runtime not read yet: given as before (can't be told)", async () => {
    state.open = new Set(['7/AM-7/r40'])
    state.canAct = false
    expect(await churnSimplifySource.refresh(told, 'host')).toEqual({ cancel: expect.stringMatching(/may not act/) })
    expect(churnSimplifySource.holds(told, 'host')).toBe(false)
    state.canAct = true
    state.runtime = false
    state.open.clear()
    expect(await churnSimplifySource.refresh(told, 'host')).toBeNull()
    expect(churnSimplifySource.holds(told, 'host')).toBe(true)
  })
})
