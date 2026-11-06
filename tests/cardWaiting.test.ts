// A card in Doing waiting on purpose (HI-2618). On 5 Nov HB3 held HI-2590 for a quiet window, waiting for the Assistant's
// go, and Combwork reported it stalled four times (HI-2285's "only watches it, and nothing waits on it") until the
// Assistant explained it each time. Now its own agent, the user or the Assistant can mark it waiting, with why: nothing
// calls it stalled meanwhile, nothing is stopped, another agent can't mark or clear it, and it is cleared however the
// card leaves Doing. On the real board (a temp combwork.db and repository).
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-cardwaiting-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const { allOff } = await import('../src/shared/workflow/options')
const { idleOwnWatchOf } = await import('../src/main/idleWatch')
const { cardStall } = await import('../src/main/cardStall')
const { idleWatchReason, nothingWaitsOn, IDLE_WATCH_STALL_MS } = await import('../src/shared/idleWatch')
const { taskRow, taskRowText } = await import('../src/shared/toolReplies')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
let w: WS
afterAll(async () => {
  advanced.stop()
  await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const hb3 = { kind: 'agent', name: 'HB3 (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const other = { kind: 'agent', name: 'HB4 (p)', self: { project: 'p', agentId: 'a3' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const get = (n: number) => run(() => tasks.getTask(n, w))

describe('a card waiting on purpose (HI-2618)', () => {
  it("HI-2590's case: its builder only watching it is a stall without the mark, none with it; cleared, a stall again", async () => {
    const ws = join(base, 'ws')
    const repo = join(ws, 'p')
    const wt = join(ws, 'p-card')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    const agents = [{ id: 'a1', name: 'HB3', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'HR1' }, { id: 'a3', name: 'HB4' }]
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: { ...allOff('git'), review: 'agent', noSelfReview: true } } }))
    w = createWorkspaceService()
    await w.open(ws)
    const card = (await run(() => tasks.createTask({ title: 'Internal names E: test home path', project: 'p' }, user))).number
    const next = (await run(() => tasks.createTask({ title: 'Next', project: 'p' }, user))).number
    await run(() => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    const lane = (await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card, next], rounds: 3, by: 'HB3 (p)' })).lane
    // HB3 only watching its card, nothing waiting on it: the card watch's nudge, and the lane's stall after 5 minutes.
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBe(card)
    const view = (await lanes.getLane(w, lane.id))!
    const watcher = { name: 'HB3', agentId: 'a1', project: 'p', cards: [card], watchSince: new Date(Date.now() - IDLE_WATCH_STALL_MS - 60_000).toISOString(), watchesMore: false, status: 'watching' }
    const order = { builder: 'a1', reviewer: 'a2', state: view.state, cards: view.cards.map((c) => ({ number: c.number, column: c.column })) }
    expect(idleWatchReason(await get(card), order, watcher, Date.now() + IDLE_WATCH_STALL_MS)).toMatch(/only watches .* and nothing waits on it/)
    // Marked waiting by HB3 itself: said on the card, and nothing calls it stalled.
    await run(() => tasks.updateTask(card, { waitingFor: '  Held for a quiet window: the test area moves once no lane runs.  ' }, hb3))
    const held = await get(card)
    expect(held.waitingFor).toMatchObject({ reason: 'Held for a quiet window: the test area moves once no lane runs.', by: 'HB3 (p)' })
    expect(held.column).toBe('doing')
    expect(held.agent).toBe('a1')
    expect(held.history.at(-1)?.what).toBe('Waiting: Held for a quiet window: the test area moves once no lane runs.')
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBeNull()
    // Its lane's stall reads it only where nothing waits on it (cardStall's idleWatch): something does now.
    expect(nothingWaitsOn(held, 'a1', false)).toBe(false)
    expect(nothingWaitsOn({ ...held, waitingFor: undefined }, 'a1', false)).toBe(true)
    // Every reason, not only that one: its agent not running is no stall either while it waits.
    expect(cardStall({ ...held, waitingFor: undefined }, { name: 'HB3', running: false }, w.path)).not.toBeNull()
    expect(cardStall(held, { name: 'HB3', running: false }, w.path)).toBeNull()
    // Its row for agents says so.
    expect(taskRowText(taskRow({ ...held, stalled: null, agent: { name: 'HB3', status: 'watching', backgroundTasks: 0 } } as never))).toContain('waiting: Held for a quiet window')
    // Cleared ('' as the tool sends it): a stall again.
    await run(() => tasks.updateTask(card, { waitingFor: '' }, hb3))
    const cleared = await get(card)
    expect(cleared.waitingFor).toBeUndefined()
    expect(cleared.history.at(-1)?.what).toBe('No longer waiting')
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBe(card)
    await lanes.endLane(w, lane.id, { abandoned: true })
  })

  it('only its own agent, the user or the Assistant marks or clears it; only in Doing', async () => {
    const card = (await run(() => tasks.createTask({ title: 'Held', project: 'p' }, user))).number
    await run(() => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    // Another agent of the project can't silence it.
    await expect(run(() => tasks.updateTask(card, { waitingFor: 'Not mine to hold' }, other))).rejects.toThrow(/Only .*'s own agent, the user or the Assistant can mark it waiting/)
    expect((await get(card)).waitingFor).toBeUndefined()
    await run(() => tasks.updateTask(card, { waitingFor: 'Waiting for the Assistant' }, assistant))
    expect((await get(card)).waitingFor?.by).toMatch(/Assistant/)
    await expect(run(() => tasks.updateTask(card, { waitingFor: null }, other))).rejects.toThrow(/Only/)
    await run(() => tasks.updateTask(card, { waitingFor: 'Waiting for Darren' }, user))
    expect((await get(card)).waitingFor?.reason).toBe('Waiting for Darren')
    await run(() => tasks.updateTask(card, { waitingFor: null }, user))
    expect((await get(card)).waitingFor).toBeUndefined()
    // Too long, or a card not in Doing: refused, nothing written.
    await expect(run(() => tasks.updateTask(card, { waitingFor: 'x'.repeat(501) }, user))).rejects.toThrow(/too long/)
    const todo = (await run(() => tasks.createTask({ title: 'Not started', project: 'p' }, user))).number
    await expect(run(() => tasks.updateTask(todo, { waitingFor: 'Later' }, user))).rejects.toThrow(/only a card in .* can be marked waiting/)
    expect((await get(todo)).waitingFor).toBeUndefined()
  })

  it('it goes however the card leaves Doing: back to Todo, straight to Done, On Hold; it never outlives Doing', async () => {
    // Every move, an intent's (submit, put back, a verdict) or the board's, is written by updateTaskAs: one place.
    for (const to of ['todo', 'done', 'hold'] as const) {
      const card = (await run(() => tasks.createTask({ title: `Leaves for ${to}`, project: 'p' }, user))).number
      await run(() => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
      await run(() => tasks.updateTask(card, { waitingFor: 'Held' }, hb3))
      await run(() => tasks.updateTask(card, { column: to }, user))
      const moved = await get(card)
      expect(moved.column, to).toBe(to)
      expect(moved.waitingFor, to).toBeUndefined()
      expect(moved.history.map((h) => h.what), to).toContain('No longer waiting')
    }
    // Set and moved out in one change: refused for a card not in Doing as it ends, nothing kept.
    const card = (await run(() => tasks.createTask({ title: 'Both at once', project: 'p' }, user))).number
    await run(() => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    await expect(run(() => tasks.updateTask(card, { column: 'todo', waitingFor: 'Held' }, user))).rejects.toThrow(/can be marked waiting/)
    expect((await get(card)).column).toBe('doing')
  })
})
