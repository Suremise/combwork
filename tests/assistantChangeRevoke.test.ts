// The Assistant's other changes revoked while they wait (HI-2420, after HI-2415's card additions and comments): admitted
// while Control allowed them, then held behind another board or lanes write, the user turns Control down or the
// Assistant's session ends. Each change's `commit` check (assistantChange's guard) runs again just before its write, so
// nothing is saved: a column's order, a card's intent (its facts and the card), a card's start (taken, typed or
// launched), a lane's start, join and end, and a lane's fresh-start retry. Cancelling messages is in agentMessages.test.ts.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-assistrevoke2-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const { advanced } = await import('../src/main/advanced')
const { FactStore } = await import('../src/main/workflow/factStore')
const { runCardIntent } = await import('../src/main/cardIntents')
const { startTask } = await import('../src/main/taskStart')
const { sessions } = await import('../src/main/sessions')
const { deliveriesOf, setSenderCheckForTests } = await import('../src/main/deliveries')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
// The Assistant's task deliveries allowed as sent (its launch isn't running here): what these tests revoke is the guard.
setSenderCheckForTests(() => null)
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const builder = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with project p and its agents a1 and a2; `options`: its workflow, on a git repository with a1's worktree. */
async function workspace(options?: object): Promise<WS> {
  const root = join(base, `ws-${++n}`)
  const repo = join(root, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  let agents: object[] = [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }]
  if (options) {
    const wt = join(root, 'p-card')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
    agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, ...(options ? { workflow: { platform: 'git', preset: null, options } } : {}) }))
  const w = createWorkspaceService()
  await w.open(root)
  opened.push(w)
  return w
}

/** A guard as assistantChange gives it: fine until revoked, then it throws (ChangeRefused's message). */
function authority() {
  let revoked = false
  return {
    revoke: () => (revoked = true),
    guard: () => {
      if (revoked) throw new Error('Control was turned down meanwhile')
    }
  }
}

/** Holds a lock (another write under way) until released: the board's, or the lanes'. */
function hold(take: (held: Promise<void>) => Promise<unknown>): { release: () => void; done: Promise<unknown> } {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  return { release, done: take(held) }
}
const holdBoard = (w: WS) => hold((held) => inWorkspace(w, () => tasks.boardLock(w, () => held)))
const holdLanes = (w: WS) => hold((held) => lanes.mutateLanes(w, () => held as unknown as void))

/** Runs `change` while the lock `held` holds it, revokes its authority, then lets it go: what the change did. */
async function revokedWhileHeld<T>(lock: { release: () => void; done: Promise<unknown> }, a: ReturnType<typeof authority>, change: Promise<T>): Promise<T> {
  // Revoked while the lock is held: whether the change has reached it yet or not, its check is at its write, after the lock.
  a.revoke()
  lock.release()
  await lock.done
  return change
}

describe("the Assistant's other changes, revoked before they're written (HI-2420)", () => {
  it("a column's order: none of the cards moves or gets a line", async () => {
    const w = await workspace()
    const [c1, c2] = await inWorkspace(w, async () => [await tasks.createTask({ title: 'One', project: 'p' }, user), await tasks.createTask({ title: 'Two', project: 'p' }, user)])
    const before = await inWorkspace(w, () => Promise.all([c1, c2].map((c) => tasks.getTask(c.number, w))))
    const a = authority()
    const lock = holdBoard(w)
    const op = inWorkspace(w, () => tasks.reorderTasks('todo', [c2.number, c1.number], assistant, { commit: a.guard }))
    await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
    const after = await inWorkspace(w, () => Promise.all([c1, c2].map((c) => tasks.getTask(c.number, w))))
    expect(after.map((c) => [c.order, c.history.length])).toEqual(before.map((c) => [c.order, c.history.length]))
    // Not revoked: the same call puts them in order.
    await inWorkspace(w, () => tasks.reorderTasks('todo', [c2.number, c1.number], assistant, { commit: authority().guard }))
    const done = await inWorkspace(w, () => Promise.all([c1, c2].map((c) => tasks.getTask(c.number, w))))
    expect(done[1].order).toBeLessThan(done[0].order)
  })

  it("a card's intent: neither its facts nor the card are written", async () => {
    const w = await workspace({ ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' })
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    await inWorkspace(w, () => runCardIntent({ n: card, plain: false }, builder, { kind: 'start' }))
    const facts = () => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card).length
    const had = facts()
    const a = authority()
    const lock = holdBoard(w)
    const op = inWorkspace(w, () => runCardIntent({ n: card, plain: false }, builder, { kind: 'putBack', why: 'Not now' }, { commit: a.guard }))
    await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
    expect(facts()).toBe(had)
    const now = await inWorkspace(w, () => tasks.getTask(card, w))
    expect([now.column, now.agent, now.comments.length]).toEqual(['doing', 'a1', 0])
    // Not revoked: it goes back to Todo.
    await inWorkspace(w, () => runCardIntent({ n: card, plain: false }, builder, { kind: 'putBack', why: 'Not now' }, { commit: authority().guard }))
    expect((await inWorkspace(w, () => tasks.getTask(card, w))).column).toBe('todo')
  })

  describe("a card's start", () => {
    const launched: string[] = []
    const mockLaunch = () => {
      launched.length = 0
      vi.spyOn(sessions, 'start').mockImplementation(async (_p: string, o: { prompt?: string; allowed?: () => void }) => {
        o.allowed?.()
        launched.push(String(o.prompt ?? ''))
        return { runId: `run-${launched.length}` } as never
      })
    }

    it('revoked while it waits to take the card: the card stays where it was, nothing launched or delivered', async () => {
      const w = await workspace()
      mockLaunch()
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Start me', project: 'p' }, user))
      const a = authority()
      const lock = holdBoard(w)
      const op = inWorkspace(w, () => startTask(c.number, { kind: 'agent', agentId: 'a1' }, assistant, undefined, undefined, undefined, a.guard))
      await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
      const now = await inWorkspace(w, () => tasks.getTask(c.number, w))
      expect([now.column, now.agent]).toEqual(['todo', null])
      expect(launched).toEqual([])
      expect(await deliveriesOf(join(w.path!, 'p'), 'a1')).toEqual([])
    })

    it('revoked once the card is taken, before its agent is launched: the start is undone', async () => {
      const w = await workspace()
      mockLaunch()
      const c = await inWorkspace(w, () => tasks.createTask({ title: 'Start me', project: 'p' }, user))
      // Allowed as the card is taken (its first check), revoked from then on.
      let checks = 0
      const guard = () => {
        if (++checks > 1) throw new Error('The Assistant was restarted meanwhile')
      }
      await expect(inWorkspace(w, () => startTask(c.number, { kind: 'agent', agentId: 'a1' }, assistant, undefined, undefined, undefined, guard))).rejects.toThrow(/restarted/)
      expect(checks).toBeGreaterThan(1)
      const now = await inWorkspace(w, () => tasks.getTask(c.number, w))
      expect([now.column, now.agent]).toEqual(['todo', null])
      expect(launched).toEqual([])
      // Not revoked: it starts, its agent launched with the card.
      await inWorkspace(w, () => startTask(c.number, { kind: 'agent', agentId: 'a1' }, assistant, undefined, undefined, undefined, authority().guard))
      expect(launched).toHaveLength(1)
      expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).column).toBe('doing')
    })
  })

  it("a lane's start, join and end: the lanes stay as they were", async () => {
    const w = await workspace()
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Laned', project: 'p' }, user))
    const ids = async () => (await lanes.listLanes(w)).map((l) => `${l.id} ${l.state} ${l.reviewer?.id ?? '-'}`)
    // Start.
    let a = authority()
    let lock = holdLanes(w)
    let op: Promise<unknown> = lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: null, cards: [c.number], by: 'the Assistant', commit: a.guard })
    await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
    expect(await ids()).toEqual([])
    const started = await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: null, cards: [c.number], by: 'the Assistant', commit: authority().guard })
    const listed = await ids()
    // Join.
    a = authority()
    lock = holdLanes(w)
    op = lanes.joinLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [c.number], by: 'the Assistant', commit: a.guard })
    await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
    expect(await ids()).toEqual(listed)
    // End.
    a = authority()
    lock = holdLanes(w)
    op = lanes.endLane(w, started.lane.id, { abandoned: true, commit: a.guard })
    await expect(revokedWhileHeld(lock, a, op)).rejects.toThrow(/turned down/)
    expect(await ids()).toEqual(listed)
    await lanes.endLane(w, started.lane.id, { abandoned: true, commit: authority().guard })
    expect(await ids()).toEqual([`${started.lane.id} abandoned -`])
  })
})
