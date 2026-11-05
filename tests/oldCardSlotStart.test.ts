// The board's Start of a card from before 1.0 in a project that builds in slots (HI-1966), on the real board (a temp
// combwork.db), a temp Git repository and the card's runtime, the slot lending stood in for (setSlotStarts, the seam
// slotCards.ts fills). On rc.9 the Assistant started HI-1612 (a 0.9 card, marked `pre_workflow`) with cw_start_task:
// its move took P3's recorded path, which lends no slot and recorded HB2's old 0.9 worktree, and HB2 was launched in the
// main checkout. Now that start is the runtime's (its slot lent, the card a 1.0 card, its decisions kept as facts), and a
// Start whose card still got no slot there is undone rather than launch its agent in the project folder.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-oldslotstart-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { setSlotStarts, workflowFor } = await import('../src/main/workflow/service')
const { sessions } = await import('../src/main/sessions')
const { startTask } = await import('../src/main/taskStart')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []

/** The slot a start is lent (null: none, as where no slot applies), and the starts that asked. */
const lending = { slot: true, asked: 0 }
setSlotStarts({
  leaseFor: async () => (lending.asked++, lending.slot ? { slot: 'slot-a', folder: join(base, 'slot-a'), lease: 'l-1', fresh: false } : null),
  unused: async () => undefined
})
afterAll(async () => {
  setSlotStarts(null)
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
beforeEach(() => Object.assign(lending, { slot: true, asked: 0 }))

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with Git project `p` (its builder a1, its reviewer a2), its cards built in slots. */
async function workspace(): Promise<WS> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const agents = [{ id: 'a1', name: 'Builder' }, { id: 'a2', name: 'Reviewer' }]
  const options = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges', folder: 'slots' }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const row = (w: WS, card: number) => store.workspaceDb(w.path!).reader.prepare('SELECT col, stage, pre_workflow FROM cards WHERE number = ?').get(card) as { col: string; stage: string; pre_workflow: number }

/** A Todo card as 0.9 left it: a decision of the user's, no facts, marked `pre_workflow` (the upgrade's mark). */
async function oldCard(w: WS): Promise<number> {
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Resume after an outage', project: 'p' }, user)).number)
  await inWorkspace(w, () => tasks.updateTask(card, { decision: 'Off by default: users opt in.' }, user))
  await inWorkspace(w, () => store.boardWrite(w, async () => store.boardWriteOp(w, (db) => {
    db.prepare('DELETE FROM card_facts WHERE card = ?').run(card)
    db.prepare("UPDATE cards SET pre_workflow = 1, stage = 'todo' WHERE number = ?").run(card)
  })))
  expect(row(w, card).pre_workflow).toBe(1)
  return card
}

describe("a card from before 1.0 started by the board, in a project that builds in slots (HI-1966)", () => {
  it("the Assistant's move to Doing is the runtime's start: its slot lent, the card a 1.0 card, its decision a fact", async () => {
    const w = await workspace()
    const card = await oldCard(w)
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, assistant))
    // Before HI-1966: P3's recorded start, with no slot asked for (folder `project`, or the agent's 0.9 worktree).
    expect(lending.asked).toBe(1)
    const started = facts(w, card).filter((f) => f.kind === 'Started')
    expect(started).toHaveLength(1)
    expect(started[0].data).toMatchObject({ slot: 'slot-a', lease: 'l-1', folder: join(base, 'slot-a'), builder: 'a1' })
    expect(row(w, card)).toEqual({ col: 'doing', stage: 'active', pre_workflow: 0 })
    // What the user decided before it became a 1.0 card is kept as a fact, as P3's start kept it (receipts match it).
    expect(facts(w, card).filter((f) => f.kind === 'Decision').map((f) => (f.data as { text: string }).text)).toEqual(['Off by default: users opt in.'])
  })

  it("its builder's own move to Doing (an old move, translated) is the runtime's start too", async () => {
    const w = await workspace()
    const card = await oldCard(w)
    const builder = { kind: 'agent', name: 'Builder', self: { project: 'p', agentId: 'a1' } } as const
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing' }, builder))
    expect(facts(w, card).find((f) => f.kind === 'Started')?.data).toMatchObject({ slot: 'slot-a', lease: 'l-1' })
    expect(row(w, card).pre_workflow).toBe(0)
  })

  it("its other moves keep P3's path until it starts: moved to Review from Todo, nothing is started or lent", async () => {
    const w = await workspace()
    const card = await oldCard(w)
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, user))
    expect(lending.asked).toBe(0)
    expect(facts(w, card)).toEqual([])
    expect(row(w, card).pre_workflow).toBe(1)
  })

  it("a Start that still got no slot there is undone, the card back in Todo, its agent never launched in the project folder", async () => {
    const w = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'No slot for it', project: 'p' }, user)).number)
    lending.slot = false
    await expect(inWorkspace(w, () => startTask(card, { kind: 'agent', agentId: 'a1' }, assistant))).rejects.toThrow(/wasn't started: its project builds each card in a slot/)
    expect(lending.asked).toBe(1)
    const now = await inWorkspace(w, () => tasks.getTask(card))
    expect([now.column, now.agent]).toEqual(['todo', null])
  })

  // HI-2395: a no-code card takes no slot (HI-2335), so its start, a direct one (the window's Start, with no reason, as
  // the Assistant's cw_start_task) as a lane's, is never taken for one that got none: it starts where its agent is
  // (here the project folder), the agent launched.
  for (const [who, actor] of [["the window's Start", user], ['a lane', tasks.HIVE_LANE_START]] as const) {
    it(`a no-code card started by ${who} takes no slot and starts, its agent launched where it is (HI-2395)`, async () => {
      const w = await workspace()
      const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'A decision to write up', project: 'p' }, user)).number)
      await store.boardWrite(w, async () => void FactStore.forBoard(w, { project: 'p', key: 'p' }).updateCard(card, { kind: 'no-code' }))
      const s = sessions as unknown as { start: (p: string, o: { agentId: string }) => Promise<unknown> }
      const original = s.start
      const launched: string[] = []
      s.start = async (p, o) => void launched.push(`${p}|${o.agentId}`)
      try {
        await inWorkspace(w, () => startTask(card, { kind: 'agent', agentId: 'a1' }, actor))
      } finally {
        s.start = original
      }
      expect(lending.asked).toBe(0)
      expect(launched).toEqual([`${join(w.path!, 'p')}|a1`])
      expect(facts(w, card).find((f) => f.kind === 'Started')?.data).toMatchObject({ folder: 'project', builder: 'a1' })
      expect(facts(w, card).find((f) => f.kind === 'Started')?.data).not.toHaveProperty('lease')
      const now = await inWorkspace(w, () => tasks.getTask(card))
      expect([now.column, now.agent]).toEqual(['doing', 'a1'])
    })
  }

  it("a Start of a card already Active with no slot (a start from before the fix) is refused, its builder never launched (HR2's round 1)", async () => {
    const w = await workspace()
    const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Started with none', project: 'p' }, user)).number)
    // Its start as rc.9 left it: Active for a1, with no lease (where the agent was).
    lending.slot = false
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.start(`#${card}`, 'agent:a1'))
    expect(facts(w, card).find((f) => f.kind === 'Started')?.data).toMatchObject({ folder: 'project', builder: 'a1' })
    const s = sessions as unknown as { start: (p: string, o: { agentId: string }) => Promise<unknown> }
    const original = s.start
    const launched: string[] = []
    s.start = async (p) => void launched.push(p)
    try {
      await expect(inWorkspace(w, () => startTask(card, { kind: 'agent', agentId: 'a1' }, assistant))).rejects.toThrow(/its start has none.*Put it back to Todo/)
    } finally {
      s.start = original
    }
    expect(launched).toEqual([])
    // Left as it was: Active, its agent as before the Start (the runtime's start alone gave it none on the board).
    const now = await inWorkspace(w, () => tasks.getTask(card))
    expect([now.column, now.agent]).toEqual(['doing', null])
  })
})
