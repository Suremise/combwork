// The merge queue's host (#1348, queueHost.ts): each run's queue recovers its target's begun entries itself (an entry
// recovered while the rules were off is still found once they are on again), and the test merge's ref goes once
// recovery gives its entry an outcome. The runner, the checks and the repository lock are stand-ins; the queue is real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { kickQueue } from '../../src/main/workflow/queueHost'
import type { Workflow } from '../../src/main/workflow/runtime'
import type { WorkspaceService } from '../../src/main/workspace'

const ctx = vi.hoisted(() => ({ wf: null as Workflow | null, folder: '', enforced: true }))
vi.mock('../../src/main/workflow/service', () => ({ workflowFor: async () => ctx.wf, workflowEnforced: () => ctx.enforced }))
vi.mock('../../src/main/agentProcesses', () => ({ processSupervisor: () => ({}) }))
vi.mock('../../src/main/workflow/queueChecksApp', () => ({ appQueueChecks: () => ({ runCheck: async () => ({ ok: true, output: '' }) }) }))
vi.mock('../../src/main/repoLock', () => ({ withRepoLock: async (_p: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('../../src/main/workflow/queueRunner', () => ({
  LeaseLost: class LeaseLost extends Error {},
  queueFolderNeeded: () => true,
  releaseQueueRunners: async () => undefined,
  QueueRunner: {
    acquire: async () => ({
      ok: true,
      runner: {
        folder: () => ctx.folder,
        holds: () => true,
        git: async (cwd: string, args: string[]) => (await import('../../src/main/git')).git(cwd, args),
        release: async () => undefined,
        spawnNow: () => {
          throw new Error('no checks run here')
        }
      }
    })
  }
}))


let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
  ctx.wf = null
  ctx.enforced = true
})

/** A card approved and queued for main (checked out nowhere), whose advance began and Hive crashed at `hook`. */
async function begun(hook: 'afterStarted' | 'afterAdvance') {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } }))
  sh(e.project, 'checkout', '-q', '--detach')
  const card = e.wf.createCard({ title: 'Recovered' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/new.txt': 'new\n' }, `${card.key}: Recovered`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  const crash = (): never => {
    throw new Error('crash')
  }
  await expect(e.queue({ hooks: { [hook]: crash } }).drain('main')).rejects.toThrow('crash')
  ctx.wf = e.wf
  ctx.folder = `${e.home}/queue`
  const ws = { path: e.home, lifetime: new AbortController().signal, worktreesRoot: `${e.home}/worktrees`, emit: () => undefined } as unknown as WorkspaceService
  return { e, card, ws }
}

const queueRefs = (e: Env): string[] => sh(e.project, 'for-each-ref', '--format=%(refname)', 'refs/hive/queue/').split(/\r?\n/).filter(Boolean)

describe('the merge queue host (#1348)', () => {
  it('an entry recovered to run again while the rules were off: paused rulesOff, and merged once they are on again', async () => {
    const { e, card, ws } = await begun('afterStarted')
    ctx.enforced = false
    await kickQueue(ws, e.project, 'main')
    expect(e.store.queuePause('main')?.reason).toBe('rulesOff')
    expect(e.wf.state(card).stage).toBe('merging')
    // The rules on again (the host lifts the pause, then kicks): a new queue recovers the entry itself and merges it.
    ctx.enforced = true
    e.store.setQueuePause('main', null)
    await kickQueue(ws, e.project, 'main')
    expect(e.wf.state(card).stage).toBe('done')
    expect(queueRefs(e)).toEqual([])
  })

  it('the target moved before Hive ended (S33c): recovery records Integrated and drops the test merge\'s ref', async () => {
    const { e, card, ws } = await begun('afterAdvance')
    expect(queueRefs(e)).toHaveLength(1)
    await kickQueue(ws, e.project, 'main')
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.kinds(card.id).filter((k) => k === 'Integrated')).toHaveLength(1)
    expect(queueRefs(e)).toEqual([])
  })
})
