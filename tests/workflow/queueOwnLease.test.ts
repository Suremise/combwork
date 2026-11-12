// HI-3120: a merge queue lease naming this Combwork's own process is held only while a runner here owns it. A runner
// whose start or release couldn't write the board (its workspace closed under it) leaves a stale row: the workspace
// opened again in the same Combwork takes it over and runs its queue. From hunt 7's probes (HI-3058, round 2).
// Stand-ins, as queueHost.test.ts: the workflow service (the harness's Workflow), boardWrite (its closed-workspace
// refusal only), the checks and the repository lock.
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, gitRepo, moved, R1, setup, type Env } from './harness'
import { tempDir } from '../tempDir'
import { admitted } from '../admitted'
import { preset } from '../../src/shared/workflow/options'
import { boardFile, closeBoard, workspaceDb } from '../../src/main/boardStore'
import { FactStore } from '../../src/main/workflow/factStore'
import { kickQueue, setHolderWatch, stopQueueHosts } from '../../src/main/workflow/queueHost'
import { QueueRunner, queueRunners, releaseQueueRunners } from '../../src/main/workflow/queueRunner'
import type { Workflow } from '../../src/main/workflow/runtime'
import type { WorkspaceService } from '../../src/main/workspace'

const ctx = vi.hoisted(() => ({
  wf: null as Workflow | null,
  writes: 0,
  gateAt: 0,
  reached: null as (() => void) | null,
  gate: null as Promise<void> | null
}))
vi.mock('../../src/main/workflow/service', () => ({ workflowFor: async () => ctx.wf, workflowEnforced: () => true }))
const { mockFactory } = await vi.hoisted(() => import('../keepType'))
vi.mock('../../src/main/boardStore', mockFactory<typeof import('../../src/main/boardStore')>(async (original) => ({
  ...(await original()),
  boardReadOnly: () => false,
  // boardWriteLocked's refusal of a change whose workspace closed meanwhile; else the change, as it is.
  boardWrite: (async (_ws: WorkspaceService, fn: () => Promise<unknown>, opts: { alive?: () => boolean } = {}) => {
    const n = ++ctx.writes
    if (n === ctx.gateAt) {
      ctx.reached?.()
      await ctx.gate
    }
    if (opts.alive && !opts.alive()) throw new Error('This workspace has closed')
    return fn()
  }) as never
})))
vi.mock('../../src/main/workspace', mockFactory<typeof import('../../src/main/workspace')>(async (original) => ({ ...(await original()), openWorkspaces: () => [] })))
vi.mock('../../src/main/agentProcesses', () => ({ processSupervisor: () => undefined, setCombworkIdentity: () => undefined }))
vi.mock('../../src/main/workflow/queueChecksApp', () => ({ appQueueChecks: () => ({ runCheck: async () => ({ ok: true, output: '' }) }) }))
vi.mock('../../src/main/repoLock', () => ({ withRepoLock: async (_p: string, fn: () => Promise<unknown>) => fn() }))

let env: Env | null = null
let done: (() => void) | null = null
afterEach(() => {
  stopQueueHosts()
  setHolderWatch(null)
  env?.close()
  env = null
  done?.()
  done = null
  ctx.gateAt = 0
})

const wsOf = (home: string, life: AbortController): WorkspaceService =>
  ({ path: home, lifetime: life.signal, worktreesRoot: `${home}/worktrees`, emit: () => undefined, projectConfig: async () => ({}) }) as unknown as WorkspaceService

describe("HI-3120: this Combwork's own stale queue lease", { timeout: 120_000 }, () => {
  it('a workspace closed while its runner is acquired, then opened again, runs its queue', async () => {
    const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } }))
    const card = e.wf.createCard({ title: 'Queued' })
    const s = await e.wf.start(card.key, B1)
    moved(s)
    commit(s.data!.folder as string, { 'src/new.txt': 'new\n' }, `${card.key}: Queued`)
    moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
    moved(await e.wf.startReview(card.key, R1))
    moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
    ctx.wf = e.wf
    const life1 = new AbortController()

    // The acquire's second board write is startJob's (the first took the lease): held there across the close.
    let letGo!: () => void
    ctx.gate = new Promise<void>((res) => (letGo = res))
    const reached = new Promise<void>((res) => (ctx.reached = res))
    ctx.gateAt = ctx.writes + 2
    const run1 = kickQueue(wsOf(e.home, life1), e.project, 'main')
    await reached
    const lease = e.store.queueLease('main')
    expect(lease?.pid).toBe(process.pid)
    expect(queueRunners()).toHaveLength(0)

    // The workspace closes (queueHost's closing task, then its lifetime aborted): every write after it is refused.
    await releaseQueueRunners((r) => !!r.cfg.workspace && r.cfg.workspace.toLowerCase() === e.home.toLowerCase())
    life1.abort()
    letGo()
    await run1
    // Its row stays (the drop was refused too), naming this process, with no runner here.
    expect(e.store.queueLease('main')?.lease).toBe(lease?.lease)
    expect(queueRunners()).toHaveLength(0)

    // Opened again in the same Combwork: its queue takes the stale lease over and merges the card.
    const life2 = new AbortController()
    await kickQueue(wsOf(e.home, life2), e.project, 'main')
    expect(e.wf.state(card).stage).not.toBe('merging')
    expect(e.kinds(card.id)).toContain('Integrated')
    expect(e.store.queueLease('main')).toBeNull()
  })

  it("a release whose write was refused leaves a row the next acquire here takes over; a live runner's lease is never taken", async () => {
    const ws = join(tempDir('cw-ownlease-'), 'ws')
    const project = gitRepo(join(ws, 'project'))
    const dismiss = admitted(ws)
    workspaceDb(ws)
    const store = FactStore.open(boardFile(ws), { project: 'project', key: 'AM' })
    done = () => {
      store.close()
      closeBoard(ws)
      dismiss()
    }
    let open = true
    // queueHost's `locked`: boardWrite with the host's `alive`, which throws once the workspace has closed.
    const locked = async <T>(fn: () => T): Promise<T> => {
      if (!open) throw new Error('This workspace has closed')
      return fn()
    }
    const cfg = { store, workspace: ws, project, target: 'main', root: join(`${ws}.worktrees`, 'project'), profile: 'A', locked }
    const a = await QueueRunner.acquire(cfg)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    // A live runner's own lease: never taken from itself.
    const held = await QueueRunner.acquire(cfg)
    expect(held.ok).toBe(false)
    if (!held.ok) expect(held.heldBy?.pid).toBe(process.pid)

    open = false
    await expect(a.runner.release()).rejects.toThrow(/closed/)
    const stale = store.queueLease('main')
    expect(stale?.pid).toBe(process.pid)

    open = true
    const again = await QueueRunner.acquire(cfg)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(store.queueLease('main')?.lease).not.toBe(stale?.lease)
    expect(again.runner.holds()).toBe(true)
    await again.runner.release()
    expect(store.queueLease('main')).toBeNull()
  })

  // The first write takes the lease (HR3's round 1 finding: a close while it waits); the second is startJob's.
  it.each([
    ['the lease is taken', 1],
    ['its job is made', 2]
  ])('a runner asked to release while %s gives its lease up and never goes live', async (_at, at) => {
    const ws = join(tempDir('cw-ownlease-'), 'ws')
    const project = gitRepo(join(ws, 'project'))
    const dismiss = admitted(ws)
    workspaceDb(ws)
    const store = FactStore.open(boardFile(ws), { project: 'project', key: 'AM' })
    done = () => {
      store.close()
      closeBoard(ws)
      dismiss()
    }
    // That write held until the close has asked for the release.
    let n = 0
    let letGo!: () => void
    const gate = new Promise<void>((res) => (letGo = res))
    let reach!: () => void
    const reached = new Promise<void>((res) => (reach = res))
    const locked = async <T>(fn: () => T): Promise<T> => {
      if (++n === at) {
        reach()
        await gate
      }
      return fn()
    }
    const cfg = { store, workspace: ws, project, target: 'main', root: join(`${ws}.worktrees`, 'project'), profile: 'A', locked }
    const acquiring = QueueRunner.acquire(cfg)
    await reached
    await releaseQueueRunners((r) => r.cfg.workspace === ws)
    letGo()
    const got = await acquiring
    if (got.ok) await got.runner.release()
    expect(got.ok).toBe(false)
    expect(queueRunners()).toHaveLength(0)
    expect(store.queueLease('main')).toBeNull()
  })
})
