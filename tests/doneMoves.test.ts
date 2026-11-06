// A move to Done always goes through the card's workflow (HI-1674), on the real board (a temp combwork.db) and a temp Git
// repository. On rc.1 the Assistant moved two code cards with no change from Doing to Done: the column moved, the
// stage stayed Active and their agents' questions stayed For you. The cause: cards from before 1.0 started by an
// intent kept their 1.0 mark (`pre_workflow`), so the board's moves of them took P3's path, around their rules. Now a
// started card loses the mark, the move goes through the rules (refused without an override, recorded with one, its
// questions closed), and a card the board already has in Done while its stage isn't is repaired when its workspace opens.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-donemoves-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { forYou } = await import('../src/main/workflow/cardWork')
const { advanced } = await import('../src/main/advanced')
const { workflowFor } = await import('../src/main/workflow/service')
const { repairStages, stageRepairTestHooks } = await import('../src/main/workflow/stageRepair')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  stageRepairTestHooks.beforeRepair = null
  stageRepairTestHooks.beforeNote = null
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with Git project `p` (its builder a1, its reviewer a2): an agent reviews, the agent merges, in slots. */
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
  const options = { ...allOff('git'), review: 'agent', noSelfReview: true, finish: 'agentMerges' }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
const facts = (w: WS, card: number) => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card)
const row = (w: WS, card: number) => store.workspaceDb(w.path!).reader.prepare('SELECT col, stage, pre_workflow FROM cards WHERE number = ?').get(card) as { col: string; stage: string; pre_workflow: number }
/** Sets the card's row as a test's stand-in for what an older Combwork left (rc.1's), under the board's lock. */
const setRow = (w: WS, card: number, sql: string) => inWorkspace(w, () => store.boardWrite(w, async () => store.boardWriteOp(w, (db) => db.prepare(`UPDATE cards SET ${sql} WHERE number = ?`).run(card))))

/**
 * HI-1151's start on rc.1: a card from before 1.0 (marked `pre_workflow`), started by its builder's cw_start_card (an
 * intent, so the runtime's write, not P3's recorder), then its builder's question (no change, how to close it?).
 */
async function startedOld(w: WS): Promise<{ card: number; request: string }> {
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title: 'Flaky, gone', project: 'p', agent: 'a1' }, user)).number)
  await setRow(w, card, 'pre_workflow = 1')
  const wf = (await workflowFor(w, join(w.path!, 'p')))!
  // By `#n`: this test's project has no key of 2–4 letters.
  await inWorkspace(w, () => wf.start(`#${card}`, 'agent:a1'))
  await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'approve', text: 'It no longer reproduces and needs no code change: may it go to Done?' }))
  const request = forYou(w).items.find((i) => i.card === card)!.request
  return { card, request }
}

describe('a move to Done goes through the workflow (HI-1674)', () => {
  it("a card from before 1.0 started by an intent loses its mark: the Assistant's move to Done is the workflow's, recorded with its stage, its question closed", async () => {
    const w = await workspace()
    const { card, request } = await startedOld(w)
    // The start cleared the mark (setStage): before HI-1674 it stayed, and the move below took P3's path.
    expect(row(w, card)).toMatchObject({ col: 'doing', stage: 'active', pre_workflow: 0 })
    // The Assistant's move to Done goes through the card's rules (this project's let it, with no submission to merge):
    // recorded in the workflow, the stage with the column, its builder's question closed. Before HI-1674 it took P3's
    // path: the column Done, the stage Active, no Moved fact, the question still For you.
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, assistant))
    expect(row(w, card)).toMatchObject({ col: 'done', stage: 'done' })
    const f = facts(w, card)
    expect(f.findLast((x) => x.kind === 'Moved')?.data).toMatchObject({ from: 'active', to: 'done' })
    expect(f.find((x) => x.kind === 'RequestClosed')?.data).toEqual({ request, why: 'done' })
    expect(forYou(w).items.filter((i) => i.card === card)).toEqual([])
  })

  it('a card the board has in Done while its stage is Active (what rc.1 left) is repaired when its workspace opens: Moved to done, its question closed, a line in its history', async () => {
    const w = await workspace()
    const { card, request } = await startedOld(w)
    // rc.1's state: the column moved by P3's path, the stage and the mark as they were.
    await setRow(w, card, "col = 'done', pre_workflow = 1")
    expect(forYou(w).items.some((i) => i.card === card)).toBe(true)
    const r = await inWorkspace(w, () => repairStages(w))
    expect(r).toEqual({ unmarked: 1, repaired: [card], failed: 0 })
    expect(row(w, card)).toEqual({ col: 'done', stage: 'done', pre_workflow: 0 })
    const f = facts(w, card)
    expect(f.findLast((x) => x.kind === 'Moved')?.data).toMatchObject({ from: 'active', to: 'done', cause: 'repair' })
    expect(f.find((x) => x.kind === 'RequestClosed')?.data).toEqual({ request, why: 'done' })
    expect(forYou(w).items.filter((i) => i.card === card)).toEqual([])
    const history = (await inWorkspace(w, () => tasks.getTask(card))).history
    expect(history.at(-1)?.what).toBe('Recorded as Done, as the board had it: its workflow still had it in Active')
    // Nothing more to do the next time.
    expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [], failed: 0 })
  })

  it("a card moved since the repair picked it (the user's move back to Doing) is left as it is now: checked in the repair's own change", async () => {
    const w = await workspace()
    const { card } = await startedOld(w)
    await setRow(w, card, "col = 'done'")
    // The newer move comes between the repair's pick and its write.
    stageRepairTestHooks.beforeRepair = async (id) => {
      if (id === card) await setRow(w, card, "col = 'doing'")
    }
    expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [], failed: 0 })
    expect(row(w, card)).toEqual({ col: 'doing', stage: 'active', pre_workflow: 0 })
    expect(facts(w, card).some((x) => x.kind === 'Moved' && (x.data as { cause: string }).cause === 'repair')).toBe(false)
    expect(forYou(w).items.some((i) => i.card === card)).toBe(true)
  })

  it('a switch to another workspace stops the repair: the board it began on is left for its next open', async () => {
    const w = await workspace()
    const first = w.path!
    const { card } = await startedOld(w)
    await setRow(w, card, "col = 'done'")
    const other = join(base, `other-${n}`)
    mkdirSync(other, { recursive: true })
    stageRepairTestHooks.beforeRepair = async () => {
      await w.open(other)
    }
    expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [], failed: 0 })
    await w.open(first)
    expect(row(w, card)).toEqual({ col: 'done', stage: 'active', pre_workflow: 0 })
    expect(facts(w, card).some((x) => x.kind === 'Moved' && (x.data as { cause: string }).cause === 'repair')).toBe(false)
  })

  it('a repair whose history line fails is undone whole (no Moved, its question still For you) and made at the next open', async () => {
    const w = await workspace()
    const { card, request } = await startedOld(w)
    await setRow(w, card, "col = 'done'")
    const before = facts(w, card).length
    const lines = (await inWorkspace(w, () => tasks.getTask(card))).history.length
    stageRepairTestHooks.beforeNote = async () => {
      throw new Error('the history line failed')
    }
    expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [], failed: 1 })
    expect(row(w, card)).toEqual({ col: 'done', stage: 'active', pre_workflow: 0 })
    expect(facts(w, card)).toHaveLength(before)
    expect((await inWorkspace(w, () => tasks.getTask(card))).history).toHaveLength(lines)
    expect(forYou(w).items.some((i) => i.card === card)).toBe(true)
    // The next open makes it.
    stageRepairTestHooks.beforeNote = null
    expect(await inWorkspace(w, () => repairStages(w))).toEqual({ unmarked: 0, repaired: [card], failed: 0 })
    expect(row(w, card)).toEqual({ col: 'done', stage: 'done', pre_workflow: 0 })
    expect(facts(w, card).find((x) => x.kind === 'RequestClosed')?.data).toEqual({ request, why: 'done' })
    expect((await inWorkspace(w, () => tasks.getTask(card))).history.at(-1)?.what).toBe('Recorded as Done, as the board had it: its workflow still had it in Active')
  })
})
