// HI-3557: a card the merge queue moves to Done has the move in its history, written in the move's own board change, so
// the lane's stall check counts from it. On 24 Nov HI-3551, HI-3553 and HI-3559 went Done as the queue advanced 1.7.0
// (their Integrated, Moved and Finished within a second of the ref), but no "Moved to Done" line was written: the lane's
// next card was reported stalled at once, counted from its "Moved to Passed" 37 to 85 min before. A move an intent makes
// keeps its one line (the intent's own), and a move within a column (Approved to Merging) writes none.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-queuedone-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { workflowFor } = await import('../src/main/workflow/service')
const { laneNextWaitReason, LANE_NEXT_STALL_MS } = await import('../src/main/cardStall')
const { columnSince } = await import('../src/shared/tasks')
const { allOff } = await import('../src/shared/workflow/options')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

/** A workspace with Git project `p` (its builder a1, its reviewer a2): an agent reviews, the agent merges. */
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

const moves = (lines: { what: string }[]): string[] => lines.map((h) => h.what).filter((x) => /^Moved to\b/.test(x))
const doneAt = (w: WS, card: number): string => FactStore.forBoard(w, { project: 'p', key: 'p' }).facts(card).findLast((f) => f.kind === 'Moved' && (f.data as { to: string }).to === 'done')!.at

/** A card the user moves to Doing on the board (an intent through its rules: its own "Moved to Doing" line). */
async function started(w: WS, title: string): Promise<number> {
  const card = await inWorkspace(w, async () => (await tasks.createTask({ title, project: 'p', agent: 'a1' }, user)).number)
  await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing' }, user))
  return card
}

describe("the queue's Done in the card's history (HI-3557)", () => {
  it('a move no intent wrote (the queue\'s Done): "Moved to Done" by Combwork, at the move, and the stall check counts from it', async () => {
    const w = await workspace()
    const card = await started(w, 'Merged by the queue')
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    // As the queue's `integrated` writes it: Combwork's write, outside any intent, moving the card into Done.
    await inWorkspace(w, () => wf.write(wf.store.cardByKey(`#${card}`)!, null, 'combwork', (x) => x.move('done', 'derived')))
    const t = await inWorkspace(w, () => tasks.getTask(card))
    expect(t.column).toBe('done')
    expect(moves(t.history)).toEqual(['Moved to Doing', 'Moved to Done'])
    const line = t.history.findLast((h) => h.what === 'Moved to Done')!
    expect(line.by).toBe('Combwork')
    // Its line's time is the move's (the same board change), so the lane's clock starts there.
    expect(Date.parse(line.at)).toBeGreaterThanOrEqual(Date.parse(doneAt(w, card)))
    expect(Date.parse(line.at) - Date.parse(doneAt(w, card))).toBeLessThan(LANE_NEXT_STALL_MS)
    expect(columnSince(t)).toBe(line.at)
    // The lane's next card, its builder only watching: not stalled as the Done lands, stalled once it has waited.
    const now = Date.parse(line.at)
    const lane = { state: 'running', cards: [{ number: card, column: 'done', movedAt: columnSince(t) }, { number: card + 1, column: 'todo', movedAt: null }] } as unknown as Parameters<typeof laneNextWaitReason>[1]
    const next = { number: card + 1, column: 'todo', archived: false, blocked: null }
    const builder = { name: 'Builder', status: 'watching' }
    expect(laneNextWaitReason(next, lane, builder, now + 1000)).toBeNull()
    expect(laneNextWaitReason(next, lane, builder, now + LANE_NEXT_STALL_MS + 60_000)).toMatch(/went Done 16 min ago/)
  })

  it('a move an intent makes keeps its one line: no second "Moved to Done" from the runtime', async () => {
    const w = await workspace()
    const card = await started(w, 'Moved by the Assistant')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'done' }, assistant))
    const t = await inWorkspace(w, () => tasks.getTask(card))
    expect(t.column).toBe('done')
    expect(moves(t.history)).toEqual(['Moved to Doing', 'Moved to Done'])
  })

  it('a stage within one column (Approved to Merging) writes no line', async () => {
    const w = await workspace()
    const card = await started(w, 'Within a column')
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    const rec = (): ReturnType<typeof wf.store.cardByKey> => wf.store.cardByKey(`#${card}`)
    await inWorkspace(w, () => wf.write(rec()!, null, 'combwork', (x) => x.move('approved', 'derived')))
    await inWorkspace(w, () => wf.write(rec()!, null, 'combwork', (x) => x.move('merging', 'derived')))
    const t = await inWorkspace(w, () => tasks.getTask(card))
    expect(moves(t.history)).toEqual(['Moved to Doing', 'Moved to Passed'])
  })
})
