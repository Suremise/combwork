// HI-2014: a finish's handler (finishPath.ts) in a real workspace. An override's Done tells each card waiting on it that
// it starts without that card's work, by one comment however often the finish runs (a retry after a crash finds it by
// its id); a finish that isn't an override's tells nobody; its steps are recorded once, and a finish that is over (the
// card back out of Done) does nothing but say so.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-finish-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { FactStore } = await import('../src/main/workflow/factStore')
const { advanced } = await import('../src/main/advanced')
const { ENFORCE, workflowFor } = await import('../src/main/workflow/service')
const { dependentNoteId, runFinish } = await import('../src/main/finishPath')
const { HISTORY, storedText } = await import('../src/shared/taskHistory')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
advanced.load(join(base, 'profile'))
await advanced.set(ENFORCE, false)
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0

async function workspace(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

const facts = (w: WS) => FactStore.forBoard(w, { project: 'p', key: 'P' })

/** A card with one waiting on it, moved to Done on the board, then recorded as an override's finish (as the runtime would). */
async function overridden(w: WS): Promise<{ parent: number; dependent: number; finish: number }> {
  const parent = (await inWorkspace(w, () => tasks.createTask({ title: 'Parent', project: 'p' }, user))).number
  const dependent = (await inWorkspace(w, () => tasks.createTask({ title: 'Needs the parent', project: 'p', blockedBy: [parent] }, user))).number
  await inWorkspace(w, () => tasks.updateTask(parent, { column: 'done' }, user))
  // On a connection of its own, as the runtime writes (never inside the board's change).
  const s = FactStore.open(store.boardFile(w.path!), { project: 'p', key: 'P' })
  try {
    const finish = s.tx((tx) => tx.append(parent, { kind: 'Finished', actor: 'user', source: 'recorded', data: { how: 'override', verified: null, by: 'user', reason: 'merged elsewhere' } }).seq)
    return { parent, dependent, finish }
  } finally {
    s.close()
  }
}

describe("a finish's handler (HI-2014)", () => {
  it("an override's Done: each dependent told once, however often it runs; its steps recorded once", async () => {
    const { w, repo } = await workspace()
    const wf = (await workflowFor(w, repo))!
    const { parent, dependent, finish } = await overridden(w)
    await runFinish(w, wf, repo, parent, finish)
    await runFinish(w, wf, repo, parent, finish)
    const card = await inWorkspace(w, () => tasks.getTask(dependent))
    const notes = card.comments.filter((c) => c.appText?.id === 'tasks.history.startsWithout')
    expect(notes).toHaveLength(1)
    expect(notes[0].appText).toMatchObject({ id: 'tasks.history.startsWithout', values: { reason: 'merged elsewhere' } })
    const steps = facts(w).facts(parent).filter((f) => f.kind === 'FinishStep').map((f) => (f.data as { step: string }).step)
    expect(steps.sort()).toEqual(['dependents', 'journal', 'lane', 'requests', 'wake'])
  })

  // HR2's round 1: an effect made and Combwork ending before its step is recorded. Each effect is found where it was made
  // (the comment by its id, the wake by its move's action), so the run after the restart makes none again.
  it("a crash after the dependent's comment and the builder's wake, before their steps were recorded: run again, each once", async () => {
    const { w, repo } = await workspace()
    const wf = (await workflowFor(w, repo))!
    const { parent, dependent, finish } = await overridden(w)
    // The effects as the first run made them, then the crash: no FinishStep written.
    const key = wf.store.cardByKey(`#${parent}`)!.key
    await inWorkspace(w, () => tasks.commentAsCombwork(dependent, storedText(HISTORY.startsWithout, { card: key, reason: 'merged elsewhere' }), w, () => true, dependentNoteId(key, finish)))
    expect(facts(w).facts(parent).some((f) => f.kind === 'FinishStep')).toBe(false)
    await runFinish(w, wf, repo, parent, finish)
    const notes = (await inWorkspace(w, () => tasks.getTask(dependent))).comments.filter((c) => c.appText?.id === 'tasks.history.startsWithout')
    expect(notes).toHaveLength(1)
    // Run once more (a second restart): still one, every step recorded once.
    await runFinish(w, wf, repo, parent, finish)
    expect((await inWorkspace(w, () => tasks.getTask(dependent))).comments.filter((c) => c.appText?.id === 'tasks.history.startsWithout')).toHaveLength(1)
    const steps = facts(w).facts(parent).filter((f) => f.kind === 'FinishStep').map((f) => (f.data as { step: string }).step)
    expect(steps.sort()).toEqual(['dependents', 'journal', 'lane', 'requests', 'wake'])
  })

  it('a board move into Done tells no dependent', async () => {
    const { w, repo } = await workspace()
    const wf = (await workflowFor(w, repo))!
    const parent = (await inWorkspace(w, () => tasks.createTask({ title: 'Parent', project: 'p' }, user))).number
    const dependent = (await inWorkspace(w, () => tasks.createTask({ title: 'Needs it', project: 'p', blockedBy: [parent] }, user))).number
    await inWorkspace(w, () => tasks.updateTask(parent, { column: 'done' }, user))
    const finish = facts(w).facts(parent).findLast((f) => f.kind === 'Finished')!.seq
    await runFinish(w, wf, repo, parent, finish)
    expect((await inWorkspace(w, () => tasks.getTask(dependent))).comments.filter((c) => c.appText?.id === 'tasks.history.startsWithout')).toEqual([])
  })

  it('a finish that is over (the card back out of Done) tells nobody, and its steps say they were superseded', async () => {
    const { w, repo } = await workspace()
    const wf = (await workflowFor(w, repo))!
    const { parent, dependent, finish } = await overridden(w)
    await inWorkspace(w, () => tasks.updateTask(parent, { column: 'todo' }, user))
    await runFinish(w, wf, repo, parent, finish)
    expect((await inWorkspace(w, () => tasks.getTask(dependent))).comments.filter((c) => c.appText?.id === 'tasks.history.startsWithout')).toEqual([])
    const outcomes = facts(w).facts(parent).filter((f) => f.kind === 'FinishStep').map((f) => (f.data as { outcome: string }).outcome)
    expect(outcomes.length).toBeGreaterThan(0)
    expect(new Set(outcomes)).toEqual(new Set(['superseded']))
  })
})
