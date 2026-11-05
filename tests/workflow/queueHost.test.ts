// The merge queue's host (#1348, queueHost.ts): each run's queue recovers its target's begun entries itself (an entry
// recovered while the rules were off is still found once they are on again), and the test merge's ref goes once
// recovery gives its entry an outcome. The runner, the checks and the repository lock are stand-ins; the queue is real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { endHolderWatches, holderWatchState, kickQueue, setHolderWatch, startQueueHosts, stopQueueHosts } from '../../src/main/workflow/queueHost'
import { emit } from '../../src/main/events'
import type { Workflow } from '../../src/main/workflow/runtime'
import type { WorkspaceService } from '../../src/main/workspace'

const ctx = vi.hoisted(() => ({
  wf: null as Workflow | null,
  folder: '',
  enforced: true,
  heldBy: null as { profile: string; pid: number; renewedAt: string } | null,
  acquired: 0,
  // The board's side (#1621): whether it takes no writes (a 0.9 board waiting for its upgrade), and the upgrade's listeners.
  readOnly: false,
  upgraded: new Set<(ws: WorkspaceService) => void>(),
  open: [] as WorkspaceService[],
  workflowsAsked: 0,
  // HI-2079: how many runners (in order) their git host fails at their first git, and what the runners did, in order.
  hostFails: 0,
  events: [] as string[],
  // HI-2078: git() calls routed to the runner in the queue's run.
  routed: 0
}))
vi.mock('../../src/main/workflow/service', () => ({ workflowFor: async () => (ctx.workflowsAsked++, ctx.wf), workflowEnforced: () => ctx.enforced }))
vi.mock('../../src/main/boardStore', async (original) => ({
  ...(await original<typeof import('../../src/main/boardStore')>()),
  boardReadOnly: () => ctx.readOnly,
  onBoardUpgraded: (fn: (ws: WorkspaceService) => void) => (ctx.upgraded.add(fn), () => ctx.upgraded.delete(fn))
}))
vi.mock('../../src/main/workspace', async (original) => ({ ...(await original<typeof import('../../src/main/workspace')>()), openWorkspaces: () => ctx.open }))
vi.mock('../../src/main/agentProcesses', () => ({ processSupervisor: () => ({}), setHiveIdentity: () => undefined }))
vi.mock('../../src/main/workflow/queueChecksApp', () => ({ appQueueChecks: () => ({ runCheck: async () => ({ ok: true, output: '' }) }) }))
vi.mock('../../src/main/repoLock', () => ({ withRepoLock: async (_p: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('../../src/main/workflow/queueRunner', () => {
  class LeaseLost extends Error {}
  return {
    LeaseLost,
    queueFolderNeeded: () => true,
    releaseQueueRunners: async () => undefined,
    QueueRunner: {
      // Held by another Combwork while ctx.heldBy says so (#1455); else this Combwork's. HI-2079: the first ctx.hostFails runners
      // fail at their first git, as a runner whose git host went does (failed, its writes refused: LeaseLost).
      acquire: async () => {
        const n = ++ctx.acquired
        if (ctx.heldBy) return { ok: false, heldBy: ctx.heldBy }
        ctx.events.push(`acquire ${n}`)
        let failed = false
        const breaks = n <= ctx.hostFails
        return {
          ok: true,
          runner: {
            folder: () => ctx.folder,
            holds: () => !failed,
            get failed() {
              return failed
            },
            git: async (cwd: string, args: string[]) => {
              if (failed || breaks) {
                if (!failed) ctx.events.push(`fail ${n}`)
                failed = true
                throw new LeaseLost()
              }
              return (await import('../../src/main/git')).git(cwd, args)
            },
            // HI-2078: the queue's reads, routed here as to the runner's git host: run as the worker runs them, while it holds.
            gitOutcome: async (m: Parameters<typeof import('../../src/main/gitWorker').runGit>[0]) => {
              ctx.routed++
              if (failed) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), error: { code: 'leaseLost', killed: false, signal: null }, cwdExists: true }
              return (await import('../../src/main/gitWorker')).runGit(m)
            },
            // Its release is awaited (its job ended, seen empty) before the next lease is taken.
            release: async () => {
              await new Promise((res) => setImmediate(res))
              ctx.events.push(`released ${n}`)
            },
            pauseForHost: async () => {
              ctx.events.push(`pause ${n}`)
              ctx.wf!.store.setQueuePause('main', { reason: 'needsYou', card: '' })
            },
            spawnNow: () => {
              throw new Error('no checks run here')
            }
          }
        }
      }
    }
  }
})


let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
  ctx.wf = null
  ctx.enforced = true
  ctx.heldBy = null
  ctx.acquired = 0
  ctx.readOnly = false
  ctx.open = []
  ctx.workflowsAsked = 0
  ctx.hostFails = 0
  ctx.events = []
  ctx.routed = 0
  stopQueueHosts()
  setHolderWatch(null)
})

/** A card approved and queued for main (checked out nowhere), whose advance began and Combwork crashed at `hook`. */
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
  const ws = { path: e.home, lifetime: new AbortController().signal, worktreesRoot: `${e.home}/worktrees`, emit: () => undefined, projectConfig: async () => ({}) } as unknown as WorkspaceService
  return { e, card, ws }
}

const queueRefs = (e: Env): string[] => sh(e.project, 'for-each-ref', '--format=%(refname)', 'refs/cw/queue/').split(/\r?\n/).filter(Boolean)

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

  it('the target moved before Combwork ended (S33c): recovery records Integrated and drops the test merge\'s ref', async () => {
    const { e, card, ws } = await begun('afterAdvance')
    expect(queueRefs(e)).toHaveLength(1)
    await kickQueue(ws, e.project, 'main')
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.kinds(card.id).filter((k) => k === 'Integrated')).toHaveLength(1)
    expect(queueRefs(e)).toEqual([])
  })
})

describe("a runner its git host failed (HI-2079)", () => {
  it('released and awaited, then a new lease, whose queue recovers the begun entry and merges it', async () => {
    const { e, card, ws } = await begun('afterStarted')
    ctx.hostFails = 1
    await kickQueue(ws, e.project, 'main')
    expect(ctx.events).toEqual(['acquire 1', 'fail 1', 'released 1', 'acquire 2', 'released 2'])
    expect(e.wf.state(card).stage).toBe('done')
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('a second in a row: the queue paused (needs you) by a third lease, nothing more run, and no run again by itself', async () => {
    const { e, card, ws } = await begun('afterStarted')
    ctx.hostFails = 5
    // A kick while it runs would run it again once it ends: not after this pause.
    const run = kickQueue(ws, e.project, 'main')
    void kickQueue(ws, e.project, 'main')
    await run
    // A bound for a hung run only: its last release comes as its run ends.
    await vi.waitFor(() => expect(ctx.events.at(-1)).toBe('released 3'), { timeout: 10_000 })
    expect(ctx.events).toEqual(['acquire 1', 'fail 1', 'released 1', 'acquire 2', 'fail 2', 'released 2', 'acquire 3', 'pause 3', 'released 3'])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'needsYou', card: '' })
    expect(e.wf.state(card).stage).toBe('merging')
    expect(ctx.acquired).toBe(3)
  })
})

/**
 * A card approved and queued for main (checked out nowhere) while Combwork A's runner holds the lease (#1455): A's lease (a
 * process that is there, this test's own), the host's acquire answering "held by Combwork-A" until `ctx.heldBy` is null,
 * and a probe whose answers the test gives (`answer`: true for A living, false for gone, or a promise it settles).
 */
async function heldByA() {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } }))
  sh(e.project, 'checkout', '-q', '--detach')
  const card = e.wf.createCard({ title: 'Held' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/held.txt': 'held\n' }, `${card.key}: Held`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  ctx.wf = e.wf
  ctx.folder = `${e.home}/queue`
  /** A workspace object for e.home, as one opening of it: its own lifetime (abort it to close it). */
  const open = () => {
    const life = new AbortController()
    return { life, ws: { path: e.home, lifetime: life.signal, worktreesRoot: `${e.home}/worktrees`, emit: () => undefined, projectConfig: async () => ({}) } as unknown as WorkspaceService }
  }
  const at = new Date().toISOString()
  e.store.takeQueueLease({ target: 'main', lease: 'la', token: 'ta', profile: 'Combwork-A', pid: process.pid, started: 1, takenAt: at, renewedAt: at }, null)
  ctx.heldBy = { profile: 'Combwork-A', pid: process.pid, renewedAt: at }
  const probe = { looks: 0, answer: (): boolean | Promise<boolean> => true }
  const watch = (ms: number) => setHolderWatch({ ms, probe: { self: async () => ({ pid: 0, started: 0 }), alive: async () => (probe.looks++, probe.answer()), list: async () => null, end: async () => [] } })
  /** A's process gone: acquire takes the lease here from now on. */
  const aGone = () => {
    probe.answer = () => false
    ctx.heldBy = null
  }
  return { e, card, open, probe, watch, aGone }
}

/** A promise the test settles. */
function deferred<T>() {
  let settle!: (v: T) => void
  const p = new Promise<T>((r) => (settle = r))
  return { p, settle }
}

// Bounds for a hung run only (#570): each wait waits for what it says. Under the test's own limit (testTimeout, 20 s in
// vitest.config.ts) with room for its setup's git, so a run too slow or hung fails naming the wait and its last state,
// not as a bare "Test timed out" (HI-2292: a 30 s bound could never report, and the failure's check was unknown).
const HUNG = { timeout: 15_000, interval: 20 }

describe("another Combwork's runner, watched (#1455, S50; HR4's #1358 round 1)", () => {
  it('watched while it lives, never run here; once its process is gone, this Combwork runs the queue and merges', async () => {
    const { e, card, open, probe, watch, aGone } = await heldByA()
    watch(20)
    await kickQueue(open().ws, e.project, 'main')
    // A lives: looked at again and again, never run here.
    await vi.waitFor(() => expect(probe.looks).toBeGreaterThanOrEqual(3), HUNG)
    expect(ctx.acquired).toBe(1)
    expect(e.wf.state(card).stage).toBe('merging')
    // A's process gone (its lease left as it was): this Combwork runs the queue, with no other kick, and merges the card.
    aGone()
    await vi.waitFor(() => expect(e.wf.state(card).stage).toBe('done'), HUNG)
    expect(ctx.acquired).toBe(2)
    expect(e.kinds(card.id).filter((k) => k === 'Integrated')).toHaveLength(1)
    expect(holderWatchState()).toEqual({ watched: 0, timers: 0 })
  })

  it("the workspace reopened before the old host's look: the new host owns a fresh watch, and takes over once A is gone", async () => {
    const { e, card, open, aGone, watch } = await heldByA()
    // The first opening's watch looks only in an hour: its timer would still hold the target's key at the reopen.
    watch(3_600_000)
    const first = open()
    await kickQueue(first.ws, e.project, 'main')
    expect(holderWatchState()).toEqual({ watched: 1, timers: 1 })
    first.life.abort()
    watch(20)
    const second = open()
    await kickQueue(second.ws, e.project, 'main')
    // One watch, the new host's (the old one's timer cleared): it looks every 20 ms.
    expect(holderWatchState()).toEqual({ watched: 1, timers: 1 })
    aGone()
    await vi.waitFor(() => expect(e.wf.state(card).stage).toBe('done'), HUNG)
    expect(ctx.acquired).toBe(3)
    expect(holderWatchState()).toEqual({ watched: 0, timers: 0 })
  })

  it('the workspace closing ends its watch (endHolderWatches, as its close does); reopened, a new watch takes over once A is gone', async () => {
    const { e, card, open, aGone, watch } = await heldByA()
    watch(20)
    const first = open()
    await kickQueue(first.ws, e.project, 'main')
    expect(holderWatchState().watched).toBe(1)
    endHolderWatches(e.home)
    first.life.abort()
    expect(holderWatchState()).toEqual({ watched: 0, timers: 0 })
    await kickQueue(open().ws, e.project, 'main')
    expect(holderWatchState().watched).toBe(1)
    aGone()
    await vi.waitFor(() => expect(e.wf.state(card).stage).toBe('done'), HUNG)
  })

  it('a run finding the lease held while a look awaits its probe keeps the one watch; settled, still one look waiting', async () => {
    const { e, open, probe, watch } = await heldByA()
    const pending = deferred<boolean>()
    probe.answer = () => pending.p
    watch(20)
    const { ws } = open()
    await kickQueue(ws, e.project, 'main')
    await vi.waitFor(() => expect(probe.looks).toBe(1), HUNG)
    // The look awaits A's probe: registered, no timer of its own meanwhile. A second run finds the lease held too.
    expect(holderWatchState()).toEqual({ watched: 1, timers: 0 })
    await kickQueue(ws, e.project, 'main')
    expect(ctx.acquired).toBe(2)
    expect(holderWatchState()).toEqual({ watched: 1, timers: 0 })
    // A still lives: the one watch looks again later, one timer.
    probe.answer = () => true
    pending.settle(true)
    await vi.waitFor(() => expect(holderWatchState()).toEqual({ watched: 1, timers: 1 }), HUNG)
    await vi.waitFor(() => expect(probe.looks).toBeGreaterThanOrEqual(3), HUNG)
    expect(holderWatchState()).toEqual({ watched: 1, timers: 1 })
    expect(ctx.acquired).toBe(2)
  })

  it('the workspace closing while a look awaits its probe: the probe answering "gone" afterwards kicks nothing', async () => {
    const { e, card, open, probe, watch, aGone } = await heldByA()
    const pending = deferred<boolean>()
    probe.answer = () => pending.p
    watch(20)
    const first = open()
    await kickQueue(first.ws, e.project, 'main')
    await vi.waitFor(() => expect(probe.looks).toBe(1), HUNG)
    endHolderWatches(e.home)
    first.life.abort()
    aGone()
    pending.settle(false)
    // The ended look sees it is no longer the target's watch: no run, no new watch.
    await vi.waitFor(() => expect(holderWatchState()).toEqual({ watched: 0, timers: 0 }), HUNG)
    expect(ctx.acquired).toBe(1)
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it('the entries gone (the card removed from the queue): the watch ends, and A going later kicks nothing', async () => {
    const { e, card, open, probe, watch, aGone } = await heldByA()
    watch(20)
    await kickQueue(open().ws, e.project, 'main')
    await vi.waitFor(() => expect(probe.looks).toBeGreaterThanOrEqual(1), HUNG)
    moved(await e.wf.removeFromQueue(card.key, 'not now'))
    await vi.waitFor(() => expect(holderWatchState()).toEqual({ watched: 0, timers: 0 }), HUNG)
    aGone()
    expect(ctx.acquired).toBe(1)
    expect(e.kinds(card.id)).not.toContain('Integrated')
  })
})

/** A card approved under Team and queued for main (its IntegrationRequested written; no queue has run it yet). */
async function approved() {
  const e = (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] } }))
  sh(e.project, 'checkout', '-q', '--detach')
  const card = e.wf.createCard({ title: 'Approved' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/approved.txt': 'approved\n' }, `${card.key}: Approved`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  ctx.wf = e.wf
  ctx.folder = `${e.home}/queue`
  const ws = { path: e.home, lifetime: new AbortController().signal, worktreesRoot: `${e.home}/worktrees`, emit: () => undefined, projectConfig: async () => ({}), info: () => ({ projects: [{ path: e.project, name: 'project', platform: 'git' }] }) } as unknown as WorkspaceService
  return { e, card, ws }
}

describe("a workspace's merge queues start as it opens, or once its board is upgraded (#1621)", () => {
  it('opened with its board waiting for the upgrade: nothing read or run (no "no such table"); upgraded, the queue merges the approved card with no restart', async () => {
    const { e, card, ws } = await approved()
    ctx.readOnly = true
    ctx.open = [ws]
    startQueueHosts()
    emit({ type: 'workspace-changed', workspace: null })
    // startOpen looks at the board before its first wait: had it gone on, it would have asked for the project's workflow
    // (and read the board's facts, which a 0.9 board hasn't got) by now.
    expect(ctx.workflowsAsked).toBe(0)
    expect(ctx.acquired).toBe(0)
    expect(e.kinds(card.id)).not.toContain('Integrated')
    // The user says Upgrade: the board takes writes, and the upgrade's listeners run.
    ctx.readOnly = false
    expect(ctx.upgraded.size).toBe(1)
    for (const fn of ctx.upgraded) fn(ws)
    await vi.waitFor(() => expect(e.wf.state(card).stage).toBe('done'), HUNG)
    expect(e.kinds(card.id).filter((k) => k === 'Integrated')).toHaveLength(1)
  })

  it('opened with its board upgraded already: the queue starts as it opens, as before', async () => {
    const { e, card, ws } = await approved()
    ctx.open = [ws]
    startQueueHosts()
    emit({ type: 'workspace-changed', workspace: null })
    await vi.waitFor(() => expect(e.wf.state(card).stage).toBe('done'), HUNG)
  })

  it('stopping the hosts stops following upgrades', () => {
    startQueueHosts()
    expect(ctx.upgraded.size).toBe(1)
    stopQueueHosts()
    expect(ctx.upgraded.size).toBe(0)
  })
})
