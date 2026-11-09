// The merge queue's advance, recovery and publish, traced (HI-2791, R8 of the 1.4.0 Git refactor; SPEC §16.3.6's rule 1 and
// port 4, R4.1–R4.6): the compare-and-swap into a target checked out nowhere (and the swap that loses), the journaled
// advance into a checked-out target (its rollback, a read-tree that refuses), a lease lost before the swap, a restart's
// recovery after a crash at each phase, and the push of a captured head (pushed, rejected, nowhere to push, off), run the
// same git commands (folder, argv, order: the queue's own and the platform's reads) as the code before the port. The
// expected traces were recorded at the revision before the port (9c0d9cfaa) with
// `CW_RECORD_QUEUE_TRACES=1 npx vitest run tests/workflow/queueAdvanceTraces.test.ts`, into
// tests/fixtures/queueAdvanceTraces.json; a trace that differs is a behaviour change, which an R card never makes.
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { gitTree, MergeQueue, type QueueConfig } from '../../src/main/workflow/mergeQueue'
import { Workflow } from '../../src/main/workflow/runtime'
import type { FactStore } from '../../src/main/workflow/factStore'
import { git, gitTestHooks } from '../../src/main/git'

const FIXTURE = join(__dirname, '..', 'fixtures', 'queueAdvanceTraces.json')
const RECORD = process.env.CW_RECORD_QUEUE_TRACES === '1'
const recorded: Record<string, string[]> = {}
const expected = (): Record<string, string[]> => (existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>) : {})

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  gitTestHooks.started = undefined
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})
afterAll(() => {
  if (RECORD) writeFileSync(FIXTURE, `${JSON.stringify({ ...expected(), ...recorded }, null, 2)}\n`)
})

/** Pair (Combwork merges); `main` checked out in the project folder unless `detached`. */
function pair(o: Partial<WorkflowOptions> = {}, detached = false): Env {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], ...o }))
  if (detached) sh(e.project, 'checkout', '-q', '--detach')
  return e
}

/** A card submitted (no review: it goes straight into the queue). */
async function queued(e: Env, file = 'a.txt'): Promise<void> {
  const card = e.wf.createCard({ title: 'Change' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: 'card\n' }, `${card.key}: change`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
}

/** main moved outside Combwork, its files untouched (a commit on its tree, the ref swapped). */
const moveMain = (e: Env): void => {
  const head = sh(e.project, 'rev-parse', 'refs/heads/main')
  const made = sh(e.project, '-c', 'user.name=Race', '-c', 'user.email=race@example.invalid', 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'race')
  sh(e.project, 'update-ref', 'refs/heads/main', made, head)
}

/** The trace's recorder: each git command in order, the queue's own (`q`) and the platform's reads (`r`), made stable. */
function tracer(e: Env, more: string[] = []) {
  const ran: string[] = []
  const roots = [e.home, ...more].map((p) => resolve(p).toLowerCase().replace(/\\/g, '/'))
  const stable = (s: string): string => {
    let t = s.replace(/\\/g, '/').toLowerCase()
    roots.forEach((r, i) => (t = t.split(r).join(i ? `<p${i}>` : '<home>')))
    return t.replace(/\b[0-9a-f]{40}\b/g, '<id>').replace(/\b[a-z]{2,}-\d+\b/g, '<card>')
  }
  const own: string[] = []
  const line = (cwd: string, args: readonly string[]): string => stable(`${resolve(cwd)} :: ${args.join(' ')}`)
  gitTestHooks.started = (cwd, args) => {
    const l = line(cwd, args)
    const i = own.indexOf(l)
    if (i >= 0) own.splice(i, 1)
    else ran.push(`r ${l}`)
  }
  const cfg: Partial<QueueConfig> = {
    git: (cwd, args, opts) => {
      const l = line(cwd, args)
      ran.push(`q ${l}`)
      if (!opts) own.push(l)
      return opts ? gitTree(cwd, args, opts) : git(cwd, args)
    }
  }
  return { ran, cfg }
}

/** Another Combwork (a restart) on the same files, its queue traced by `cfg`. */
function restarted(e: Env, cfg: Partial<QueueConfig>): MergeQueue {
  const store = e.reopen()
  extra.push(store)
  const wf = new Workflow({ ...e.wf.cfg, store })
  return new MergeQueue(wf, { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }), ...cfg })
}

/** Checks (or, recording, keeps) a trace. */
function same(step: string, trace: string[]): void {
  if (RECORD) recorded[step] = [...trace]
  else expect(trace, step).toEqual(expected()[step])
}

const outcomes = (o: { outcome: string }[]): string[] => o.map((x) => x.outcome)

describe("the merge queue's advance, recovery and publish through the integration port (HI-2791)", { timeout: GIT_HEAVY_MS }, () => {
  it('the compare-and-swap into a target checked out nowhere', async () => {
    const e = pair({}, true)
    await queued(e)
    const t = tracer(e)
    expect(outcomes(await e.queue(t.cfg).drain('main'))).toEqual(['integrated'])
    same('cas', t.ran)
  })

  it('the swap that loses the race after IntegrationStarted: failed, queued again, merged', async () => {
    const e = pair({}, true)
    await queued(e)
    const t = tracer(e)
    let raced = false
    const hooks = { afterStarted: () => void (raced || ((raced = true), moveMain(e))) }
    expect(outcomes(await e.queue({ ...t.cfg, hooks }).drain('main'))).toEqual(['integrated'])
    same('cas moved', t.ran)
  })

  it('the journaled advance into a checked-out target', async () => {
    const e = pair()
    await queued(e)
    const t = tracer(e)
    expect(outcomes(await e.queue(t.cfg).drain('main'))).toEqual(['integrated'])
    same('checked out', t.ran)
  })

  it('checked out, the ref moved before the swap: the files rolled back, tested again, merged', async () => {
    const e = pair()
    await queued(e)
    const t = tracer(e)
    let raced = false
    const hooks = { beforeRef: () => void (raced || ((raced = true), moveMain(e))) }
    expect(outcomes(await e.queue({ ...t.cfg, hooks }).drain('main'))).toEqual(['integrated'])
    same('rollback', t.ran)
  })

  it('checked out, a listed file made in the folder before the files phase: read-tree refuses, paused naming it', async () => {
    const e = pair()
    await queued(e)
    const t = tracer(e)
    const hooks = { beforeFiles: () => void writeFileSync(join(e.project, 'a.txt'), 'the user\'s\n') }
    expect(outcomes(await e.queue({ ...t.cfg, hooks }).drain('main'))).toEqual(['paused'])
    same('files refused', t.ran)
  })

  it('the lease lost before the swap: nothing touched, nothing written', async () => {
    const e = pair({}, true)
    await queued(e)
    const t = tracer(e)
    let holds = true
    const hooks = { afterStarted: () => void (holds = false) }
    expect(await e.queue({ ...t.cfg, hooks, holds: () => holds }).drain('main')).toEqual([])
    same('lease lost', t.ran)
  })

  for (const [name, hook, detached, before] of [
    ['recover: not checked out, crashed after IntegrationStarted', 'afterStarted', true, null],
    ['recover: not checked out, crashed after IntegrationStarted, the target moved', 'afterStarted', true, 'move'],
    ['recover: not checked out, crashed after the swap', 'afterAdvance', true, null],
    ['recover: checked out, crashed after IntegrationStarted', 'afterStarted', false, null],
    ['recover: checked out, crashed after the files phase', 'afterFiles', false, null],
    ['recover: checked out, crashed before the swap (phase ref)', 'beforeRef', false, null],
    ['recover: checked out, crashed after the swap', 'afterAdvance', false, null],
    ['recover: checked out, crashed after the files phase, the ref moved', 'afterFiles', false, 'move'],
    ['recover: checked out, crashed in the rollback', 'inRollback', false, 'race']
  ] as const) {
    it(name, async () => {
      const e = pair({}, detached)
      await queued(e)
      let raced = false
      const crash = { [hook]: () => Promise.reject(new Error('crash')), ...(before === 'race' ? { beforeRef: () => void (raced || ((raced = true), moveMain(e))) } : {}) }
      await expect(e.queue({ hooks: crash }).drain('main')).rejects.toThrow('crash')
      if (before === 'move') moveMain(e)
      const t = tracer(e)
      const q = restarted(e, t.cfg)
      const rec = await q.recover()
      const after = await q.drain('main')
      t.ran.push(`= ${rec.map((x) => x.outcome).join(',')} / ${outcomes(after).join(',')}`)
      same(name, t.ran)
    })
  }

  describe('the push of a captured head (G18, R4.6)', () => {
    const pushing = (on = true, remote = true): { e: Env; bare: string } => {
      const e = pair({ pushTarget: on }, true)
      const bare = join(tempDir('remote-'), 'origin.git')
      if (remote) {
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
        sh(e.project, 'remote', 'add', 'origin', bare)
        sh(e.project, 'push', '-q', '-u', 'origin', 'main')
      }
      return { e, bare }
    }

    it('pushed to the remote main tracks', async () => {
      const { e, bare } = pushing()
      await queued(e)
      const t = tracer(e, [bare])
      expect(outcomes(await e.queue(t.cfg).drain('main'))).toEqual(['integrated'])
      same('push', t.ran)
    })

    it('rejected (the remote moved on), then the target reset: cleared, nothing pushed', async () => {
      const { e, bare } = pushing()
      const start = sh(e.project, 'rev-parse', 'main')
      const other = sh(e.project, '-c', 'user.name=X', '-c', 'user.email=x@example.invalid', 'commit-tree', `${start}^{tree}`, '-p', start, '-m', 'remote ahead')
      sh(e.project, 'push', '-q', 'origin', `${other}:refs/heads/main`)
      await queued(e)
      const t = tracer(e, [bare])
      const q = e.queue(t.cfg)
      expect(outcomes(await q.drain('main'))).toEqual(['integrated'])
      expect(e.store.queuePause('main')?.reason).toBe('pushRejected')
      sh(e.project, 'update-ref', 'refs/heads/main', start)
      q.resume('main')
      await q.drain('main')
      same('push rejected then reset', t.ran)
    })

    it('nowhere to push', async () => {
      const { e } = pushing(true, false)
      await queued(e)
      const t = tracer(e)
      expect(outcomes(await e.queue(t.cfg).drain('main'))).toEqual(['integrated'])
      expect(e.store.queuePause('main')?.reason).toBe('pushNoRemote')
      same('push no remote', t.ran)
    })

    it('off: nothing pushed', async () => {
      const { e, bare } = pushing(false)
      await queued(e)
      const t = tracer(e, [bare])
      expect(outcomes(await e.queue(t.cfg).drain('main'))).toEqual(['integrated'])
      same('push off', t.ran)
    })
  })

  it('a restart with a push owed: pushed then', async () => {
    const e = pair({ pushTarget: true }, true)
    const bare = join(tempDir('remote-'), 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    sh(e.project, 'remote', 'add', 'origin', bare)
    sh(e.project, 'push', '-q', '-u', 'origin', 'main')
    await queued(e)
    await expect(e.queue({ hooks: { afterAdvance: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    const t = tracer(e, [bare])
    const q = restarted(e, t.cfg)
    const rec = await q.recover()
    const after = await q.drain('main')
    t.ran.push(`= ${rec.map((x) => x.outcome).join(',')} / ${outcomes(after).join(',')}`)
    same('push after restart', t.ran)
    void R1
  })
})
