// HI-3366: a card into Done reconciles each project it blocks a card of. A jj card held for a blocker (HI-3265) has no
// merge-queue entry for kickDependents to run again: its only wake is a reconciliation of its own project. Before, a
// blocker's Done asked only for its own project's, so a dependent in another project waited for a jj operation there, a
// window's focus or the minute tick. Git projects here: the hook is the platform's neither way.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'
import { waitOptions } from './waits'

const base = tempDir('cw-done-dependents-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const { advanced } = await import('../src/main/advanced')
const { allOff } = await import('../src/shared/workflow/options')
const { reconcileNow, reconcilePending, stopReconciling } = await import('../src/main/workflow/reconciler')

advanced.load(join(base, 'profile'))
const opened: ReturnType<typeof createWorkspaceService>[] = []
afterAll(async () => {
  stopReconciling()
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const

function project(ws: string, name: string): string {
  const repo = gitRepo(join(ws, name))
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  commit(repo, {}, 'ignore .combwork')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], workflow: { platform: 'git', preset: null, options: allOff('git') } }))
  return repo
}

describe('a card into Done reconciles the projects of the cards it blocks (HI-3366)', () => {
  it('a blocker in another project reaching Done asks for the dependent’s project’s reconciliation', async () => {
    const ws = join(base, 'ws')
    const p = project(ws, 'p')
    const q = project(ws, 'q')
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    const b = await inWorkspace(w, () => tasks.createTask({ title: 'Blocker', project: 'q' }, user))
    const a = await inWorkspace(w, () => tasks.createTask({ title: 'Held', project: 'p', blockedBy: [b.number] }, user))
    expect(a.blockedBy).toEqual([b.number])
    // Whatever the creations asked for, run now: nothing pending in either project before the move.
    await reconcileNow(w, p)
    await reconcileNow(w, q)
    expect(reconcilePending(p)).toBe(false)
    await inWorkspace(w, () => tasks.updateTask(b.number, { column: 'done' }, user))
    await vi.waitFor(() => expect(reconcilePending(q), 'the blocker’s own project').toBe(true), waitOptions())
    await vi.waitFor(() => expect(reconcilePending(p), 'the dependent’s project').toBe(true), waitOptions())
    await reconcileNow(w, p)
    await reconcileNow(w, q)
  })
})
