// Moving a project's agents: where a move, a drop or a page drop puts an agent, and the saved order in project.json
// (under its lock, keeping each agent's settings and anything changed meanwhile).
import { AsyncLocalStorage } from 'async_hooks'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { dropIndex, moveAgentTo, pageAgents, pageEndIndex, projectAgents, swapAgentsIn } from '../src/shared/defaults'
import type { HiveEvent, ProjectConfig } from '../src/shared/types'
import { tempDir } from './tempDir'

const base = tempDir('hive-order-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const ids = (list: { id: string }[]): string => list.map((a) => a.id).join('')
const abc = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))

describe('agent order', () => {
  it('moves an agent to its new position, others shifting along', () => {
    expect(ids(moveAgentTo(abc, 'a', 2))).toBe('bcade')
    expect(ids(moveAgentTo(abc, 'e', 0))).toBe('eabcd')
    expect(ids(moveAgentTo(abc, 'c', 99))).toBe('abdec')
    expect(ids(moveAgentTo(abc, 'c', -3))).toBe('cabde')
    expect(ids(moveAgentTo(abc, 'nope', 1))).toBe('abcde')
  })

  it('puts a dropped agent before the one it was dropped on, or at the end', () => {
    const order = abc.map((a) => a.id)
    expect(ids(moveAgentTo(abc, 'a', dropIndex(order, 'a', 'd')))).toBe('bcade')
    expect(ids(moveAgentTo(abc, 'e', dropIndex(order, 'e', 'b')))).toBe('aebcd')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', null)))).toBe('acdeb')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', 'b')))).toBe('abcde')
    expect(ids(moveAgentTo(abc, 'b', dropIndex(order, 'b', 'c')))).toBe('abcde')
  })

  it("drops on a page button at that page's last place", () => {
    const eight = 'abcdefgh'.split('').map((id) => ({ id }))
    // To page 2 from page 1: the end of the list (page 2 has room).
    expect(ids(moveAgentTo(eight, 'a', pageEndIndex(8, 1, 6)))).toBe('bcdefgha')
    // To a full page 1 from page 2: its last place; the agent there moves on to page 2.
    expect(ids(moveAgentTo(eight, 'h', pageEndIndex(8, 0, 6)))).toBe('abcdehfg')
    expect(pageEndIndex(3, 0, 6)).toBe(2)
  })
})

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { moveAgent, swapAgents } = await import('../src/main/projectAgents')
const { onHiveEvent } = await import('../src/main/events')

// The longest a test waits for what it is waiting on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10000

describe('saving the order', () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const file = join(alpha, '.combwork', 'project.json')
  beforeAll(async () => {
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    const agents = [
      { id: 'a1', name: 'Agent 1', model: 'opus' },
      { id: 'a2', name: 'Agent 2' },
      { id: 'a3', name: 'Agent 3', worktree: { path: join(base, 'wt'), branch: 'hive/three', base: 'main' } }
    ]
    writeFileSync(file, JSON.stringify({ version: 2, agents, worktreeSetup: 'npm ci' }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterAll(async () => disposeWorkspaceService(w))
  const saved = () => JSON.parse(readFileSync(file, 'utf8'))

  it('saves the new order in project.json, keeping each agent and the other settings', async () => {
    expect(await inWorkspace(w, () => moveAgent(alpha, 'a3', 0))).toEqual(['a3', 'a1', 'a2'])
    const cfg = saved()
    expect(cfg.agents.map((a: { id: string }) => a.id)).toEqual(['a3', 'a1', 'a2'])
    expect(cfg.agents[0].worktree.branch).toBe('hive/three')
    expect(cfg.agents[1]).toMatchObject({ name: 'Agent 1', model: 'opus' })
    expect(cfg.worktreeSetup).toBe('npm ci')
  })

  it('moves and changes at the same time both land', async () => {
    await Promise.all([inWorkspace(w, () => moveAgent(alpha, 'a2', 0)), w.updateAgent(alpha, 'a1', { model: 'sonnet' })])
    const cfg = saved()
    expect(cfg.agents.map((a: { id: string }) => a.id)).toEqual(['a2', 'a3', 'a1'])
    expect(cfg.agents[2].model).toBe('sonnet')
  })

  it("refuses an agent that isn't there", async () => {
    await expect(inWorkspace(w, () => moveAgent(alpha, 'gone', 0))).rejects.toThrow(/no longer exists/)
  })

  it('swaps two agents under the lock, keeping each agent, also with a change at the same time (#135)', async () => {
    const before = saved().agents.map((a: { id: string }) => a.id)
    await Promise.all([inWorkspace(w, () => swapAgents(alpha, before[0], before[2])), w.updateAgent(alpha, before[1], { model: 'haiku' })])
    const cfg = saved()
    expect(cfg.agents.map((a: { id: string }) => a.id)).toEqual([before[2], before[1], before[0]])
    expect(cfg.agents[1].model).toBe('haiku')
    expect(cfg.agents.find((a: { id: string }) => a.id === 'a3').worktree.branch).toBe('hive/three')
    await expect(inWorkspace(w, () => swapAgents(alpha, 'a1', 'gone'))).rejects.toThrow(/no longer exists/)
  })

  it('quick moves: a refresh that read the order before a later move never reports it (#999: the panes flickered)', async () => {
    // One refresh of each move is held once it has read the project, as refreshes slowed by running agents were, and let
    // go in turn after all three moves have saved. Only one a move: the refresh its save schedules (250 ms on) runs in the
    // move's context too, and on a loaded machine it fires before the next move (#1052: five held, not three); it and any
    // refresh after the first run free, and must report the order saved as well.
    const mine = new AsyncLocalStorage<{ taken: boolean }>()
    const held: (() => void)[] = []
    const live = (hold: boolean) => async (p: string, cfg: ProjectConfig) => {
      const move = mine.getStore()
      if (hold && p === alpha && move && !move.taken) {
        move.taken = true
        await new Promise<void>((r) => held.push(r))
      }
      return { live: null, restartNeeded: false, agents: projectAgents(cfg).map((a) => ({ ...a, live: null, restartNeeded: false, resume: null, place: { folder: p, is: 'project' as const, name: null, branch: null } })) }
    }
    // Each order reported, and whether every move had saved by then. While the moves are made, a report may be a move
    // behind project.json (#1229: a refresh that read it just before a move's file landed, as Combwork records that save, is
    // what Combwork knew), never further back than one before it; once all have saved, only the last order.
    const reported: { order: string; settled: boolean }[] = []
    let settled = false
    const off = onHiveEvent((e: HiveEvent) => {
      const p = e.type === 'workspace-changed' ? e.workspace?.projects.find((x) => x.path === alpha) : undefined
      if (p) reported.push({ order: p.agents.map((a) => a.id).join(','), settled })
    })
    w.setLiveProvider(live(true))
    try {
      const order = () => saved().agents.map((a: { id: string }) => a.id).join(',')
      // The orders saved, oldest first: each move's is on disk once its refresh is held.
      const history = [order()]
      const [x, y, z] = history[0].split(',')
      const move = (fn: () => Promise<string[]>) => mine.run({ taken: false }, () => inWorkspace(w, fn))
      const moves = [move(() => swapAgents(alpha, x, z))]
      await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: HUNG_MS })
      history.push(order())
      moves.push(move(() => moveAgent(alpha, z, 1)))
      await vi.waitFor(() => expect(held).toHaveLength(2), { timeout: HUNG_MS })
      history.push(order())
      moves.push(move(() => moveAgent(alpha, y, 2)))
      await vi.waitFor(() => expect(held).toHaveLength(3), { timeout: HUNG_MS })
      const last = order()
      history.push(last)
      expect(last).toBe([z, x, y].join(','))
      settled = true
      // Let go oldest first, each ending before the next: the first two read the order from before a later move.
      for (let i = 0; i < 3; i++) {
        held[i]()
        await moves[i]
      }
      expect(reported.length).toBeGreaterThan(0)
      const at = reported.map((r) => history.indexOf(r.order))
      for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
      for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThanOrEqual(at[i - 1])
      for (const r of reported) if (r.settled) expect(r.order).toBe(last)
      expect(reported.at(-1)?.order).toBe(last)
      expect(w.info()?.projects.find((p) => p.path === alpha)?.agents.map((a) => a.id).join(',')).toBe(last)
    } finally {
      for (const r of held) r()
      w.setLiveProvider(live(false))
      off()
    }
  })
})

describe('dropping agents (#135): the panes follow the order', () => {
  const four = 'abcd'.split('').map((id) => ({ id }))
  /** The panes of each page, as the Session tab shows them: a page's agents in order, `per` to a page. */
  const screen = (list: { id: string }[], per: number) => [0, 1, 2].map((p) => ids(pageAgents(list, p, per))).filter(Boolean).join('|')

  it('a drop on a pane swaps the two, on the same page or across pages; dropping on itself does nothing', () => {
    // Four agents in three columns: abc | d.
    expect(screen(four, 3)).toBe('abc|d')
    expect(screen(swapAgentsIn(four, 'a', 'c'), 3)).toBe('cba|d')
    // Across pages: d dragged to page 1, dropped on b's pane; b goes to d's old place on page 2.
    expect(screen(swapAgentsIn(four, 'd', 'b'), 3)).toBe('adc|b')
    expect(ids(swapAgentsIn(four, 'a', 'a'))).toBe('abcd')
    expect(ids(swapAgentsIn(four, 'a', 'zz'))).toBe('abcd')
  })

  it('a drop on an empty pane (the last page) moves the agent there; the strip inserts, like browser tabs', () => {
    // Empty panes are the last page's spare ones: the agent goes to the end.
    expect(screen(moveAgentTo(four, 'a', four.length - 1), 3)).toBe('bcd|a')
    // The strip: before c, and after the last.
    const order = ids(four).split('')
    expect(ids(moveAgentTo(four, 'a', dropIndex(order, 'a', 'c')))).toBe('bacd')
    expect(ids(moveAgentTo(four, 'b', dropIndex(order, 'b', null)))).toBe('acdb')
  })
})
