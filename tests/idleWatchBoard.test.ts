// HI-2285 on the real board (a temp hive.db and repository): the card a lane's builder watches alone, where nothing on it
// waits on anyone, is the one cw_wait_for_tasks's reply nudges about (idleOwnWatchOf); a question open for the user,
// the card in Review, a watch on more than it, or an agent that isn't the lane's builder: none.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-idlewatch-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const lanes = await import('../src/main/lanes')
const store = await import('../src/main/boardStore')
const { forYou } = await import('../src/main/workflow/cardWork')
const { advanced } = await import('../src/main/advanced')
const { workflowFor } = await import('../src/main/workflow/service')
const { allOff } = await import('../src/shared/workflow/options')
const { idleOwnWatchOf } = await import('../src/main/idleWatch')

advanced.load(join(base, 'profile'))
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const b1 = { kind: 'agent', name: 'Builder (p)', self: { project: 'p', agentId: 'a1' }, scope: 'p' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()

/** A workspace with Git project `p` (its builder a1 in a worktree on `card`, its reviewer a2), reviewed by an agent. */
async function workspace(): Promise<{ w: WS; wt: string }> {
  const ws = join(base, 'ws')
  const repo = join(ws, 'p')
  const wt = join(ws, 'p-card')
  mkdirSync(join(repo, '.hive'), { recursive: true })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.hive/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'worktree', 'add', '-q', '-b', 'card', wt, 'main')
  const agents = [{ id: 'a1', name: 'Builder', worktree: { path: wt, branch: 'card', base: 'main' } }, { id: 'a2', name: 'Reviewer' }]
  writeFileSync(join(repo, '.hive', 'project.json'), JSON.stringify({ version: 2, agents, workflow: { platform: 'git', preset: null, options: { ...allOff('git'), review: 'agent', noSelfReview: true } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, wt }
}

describe("the card watch's nudge on the board (HI-2285)", () => {
  it("its own lane card in Doing with nothing waiting: nudged; a question open, Review, more cards or another agent: not", async () => {
    const { w, wt } = await workspace()
    const create = async (): Promise<number> => inWorkspace(w, async () => (await tasks.createTask({ title: 'Work', project: 'p' }, user)).number)
    const card = await create()
    const other = await create()
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'doing', agent: 'a1' }, user))
    // Outside a lane: nothing said.
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBeNull()
    await lanes.startLane(w, { project: 'p', builder: 'a1', reviewer: 'a2', cards: [card, other], rounds: 3, by: 'Builder (p)' })
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBe(card)
    // Its reviewer, more than the card, or a card in Todo: none.
    expect(await idleOwnWatchOf(w, 'a2', [card])).toBeNull()
    expect(await idleOwnWatchOf(w, 'a1', [card, other])).toBeNull()
    expect(await idleOwnWatchOf(w, 'a1', [other])).toBeNull()
    // A question open for the user: it waits on them.
    const wf = (await workflowFor(w, join(w.path!, 'p')))!
    await inWorkspace(w, () => wf.askTheUser(`#${card}`, 'agent:a1', { kind: 'decide', text: 'Which broker?' }))
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBeNull()
    // Answered: nothing waits again.
    await inWorkspace(w, () => tasks.answerTask(card, forYou(w).items[0].request, { outcome: 'answered', reply: 'The local one' }))
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBe(card)
    // Submitted (in Review): it waits on the reviewer.
    writeFileSync(join(wt, 'b.txt'), 'b\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'b')
    await inWorkspace(w, () => tasks.updateTask(card, { column: 'review' }, b1))
    expect(await idleOwnWatchOf(w, 'a1', [card])).toBeNull()
  })
})
