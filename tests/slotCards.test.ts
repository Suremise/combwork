// Cards on slots, the app's side (#1438, HR1's round 1): a Done card's merged line deleted by the card (its board number,
// never a number read from the line's name), only with the rules on and the switch on, only once its target contains
// it, never one checked out, and a checkout coming in between the worktree list and the ref's removal keeps both the
// branch and the checkout. And a card's cycle read from its facts: what its start was owed, and what was done since.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, setup, sh, type Env } from './workflow/harness'
import { tempDir } from './tempDir'
import { join } from 'path'
import { lineName } from '../src/main/workflow/runtime'
import type { Fact } from '../src/shared/workflow/facts'

const state = vi.hoisted(() => ({ enforced: true, afterList: null as null | (() => void) }))

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => state.enforced }))
vi.mock('../src/main/worktrees', async (orig) => {
  const actual = await orig<typeof import('../src/main/worktrees')>()
  return {
    ...actual,
    listWorktreesOrNull: async (cwd: string) => {
      const r = await actual.listWorktreesOrNull(cwd)
      const hook = state.afterList
      state.afterList = null
      hook?.()
      return r
    }
  }
})

const { cycleIn, deleteMergedLine } = await import('../src/main/slotCards')

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
  state.enforced = true
  state.afterList = null
})

/** A card started in a slot (a worktree on its line, under lease l-1), its change merged into main and reported: Done. */
async function doneInSlot(title: string): Promise<{ e: Env; n: number; line: string; slot: string }> {
  const e = (env = setup({ platform: 'git', review: 'none', finish: 'agentMerges', folder: 'slots', target: 'main' }, { autoRun: false }))
  const card = e.wf.createCard({ title })
  const line = lineName('AM', card)
  const slot = join(tempDir('slot-'), 'slot-a')
  sh(e.project, 'worktree', 'add', '-q', '-b', line, slot, 'main')
  e.wf.cfg.slotFor = async () => ({ slot: 'slot-a', folder: slot, lease: 'l-1', fresh: true })
  moved(await e.wf.start(card.key, B1))
  commit(slot, { 'work.txt': `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'done' }))
  sh(e.project, 'merge', '-q', '--no-ff', '-m', `Merge ${line}`, line)
  moved(await e.wf.reportMerge(card.key, B1))
  expect(e.wf.state(card).stage).toBe('done')
  return { e, n: card.id, line, slot }
}

const hasLine = (e: Env, line: string): boolean => {
  try {
    sh(e.project, 'rev-parse', '--verify', '-q', `refs/heads/${line}`)
    return true
  } catch {
    return false
  }
}

describe("a Done card's merged line (#1438)", { timeout: 60_000 }, () => {
  it('is kept while its slot has it checked out, deleted once nothing does, and noted on the card', async () => {
    const { e, n, line, slot } = await doneInSlot('Merged work')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
    sh(slot, 'switch', '-q', '--detach')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(true)
    expect(hasLine(e, line)).toBe(false)
    expect(e.kinds(n)).toContain('LineDeleted')
    // Once deleted, never again.
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
  })

  it('a checkout coming in after the worktrees were read keeps both: its branch put back at the same head', async () => {
    const { e, n, line, slot } = await doneInSlot('Raced')
    sh(slot, 'switch', '-q', '--detach')
    const head = sh(e.project, 'rev-parse', line)
    // Another worktree takes the branch right after the first look, before the ref goes.
    const other = join(tempDir('other-'), 'wt')
    state.afterList = () => void sh(e.project, 'worktree', 'add', '-q', other, line)
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(sh(e.project, 'rev-parse', line)).toBe(head)
    expect(sh(other, 'branch', '--show-current')).toBe(line)
    expect(e.kinds(n)).not.toContain('LineDeleted')
  })

  it('never with the rules off, and never a line with work its target lacks', async () => {
    const { e, n, line, slot } = await doneInSlot('Off')
    sh(slot, 'switch', '-q', '--detach')
    state.enforced = false
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
    state.enforced = true
    // A commit after the merge: not in main, so the line stays.
    sh(slot, 'switch', '-q', line)
    commit(slot, { 'later.txt': 'later\n' }, 'after the merge')
    sh(slot, 'switch', '-q', '--detach')
    expect(await deleteMergedLine({} as never, e.project, e.wf, n)).toBe(false)
    expect(hasLine(e, line)).toBe(true)
  })
})

describe("a card's cycle in a slot (#1438)", () => {
  const f = (seq: number, kind: string, data: object): Fact => ({ seq, card: 1, kind, at: '', actor: 'hive', source: 'recorded', data }) as unknown as Fact
  const started = (seq: number, lease: string) => f(seq, 'Started', { folder: 'F', line: 'hive/AM/AM-1-x', base: 'b', target: 'main', builder: 'B1', cardKind: 'code', slot: 'slot-a', lease })

  it("is its last start's, with what was done for it since; a start outside slots has none", () => {
    expect(cycleIn([f(1, 'Started', { folder: 'project', line: 'main', base: 'b', target: 'main', builder: 'B1', cardKind: 'code' })])).toBeNull()
    const facts = [started(1, 'l-1'), f(2, 'SlotPrepared', { lease: 'l-1', line: 'hive/AM/AM-1-x', revision: 'r' }), f(3, 'PlacementClaimed', { lease: 'l-1', pid: 5, started: 6 }), f(4, 'BuilderPlaced', { lease: 'l-1', delivery: 'm1', how: 'typed' })]
    expect(cycleIn(facts)).toMatchObject({ seq: 1, prepared: { revision: 'r' }, claimed: { pid: 5, seq: 3 }, placed: true, deleted: false })
    // Put back and started again (the same lease, or another): a new cycle owes all of it again.
    expect(cycleIn([...facts, started(5, 'l-1')])).toMatchObject({ seq: 5, prepared: null, claimed: null, placed: false })
    // What another lease's facts say isn't this cycle's.
    expect(cycleIn([started(1, 'l-2'), f(2, 'SlotPrepared', { lease: 'l-1', line: 'x', revision: 'r' })])).toMatchObject({ prepared: null })
  })
})
