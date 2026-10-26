// G18 (#1179): the merge queue pushes its target after each merge, when the project's options say so. On real
// temporary repositories, each with a bare repository of its own as the remote: never a real remote.
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { formShows, preset } from '../../src/shared/workflow/options'
import { ruleOptions } from '../../src/shared/workflow/compile'
import { MergeQueue, pushOwedKey, pushOwedOf, type QueueGitOptions, type QueueGitResult } from '../../src/main/workflow/mergeQueue'
import { FactStore } from '../../src/main/workflow/factStore'
import { Workflow } from '../../src/main/workflow/runtime'
import { git } from '../../src/main/git'

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})

/** Pair (Hive merges), with the target `main` checked out nowhere, and a bare remote `origin` that main tracks. */
function pushing(on = true): { e: Env; bare: string } {
  const e = (env = setup({ ...preset('git', 'pair'), preChecks: [], mergeChecks: [], pushTarget: on }))
  sh(e.project, 'checkout', '-q', '--detach')
  const bare = join(tempDir('remote-'), 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  sh(e.project, 'remote', 'add', 'origin', bare)
  sh(e.project, 'push', '-q', 'origin', 'main')
  sh(e.project, 'branch', '-q', '--set-upstream-to=origin/main', 'main')
  return { e, bare }
}

async function queued(e: Env, title: string, file: string) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

const remoteMain = (bare: string): string => sh(bare, 'rev-parse', 'main')
const localMain = (e: Env): string => sh(e.project, 'rev-parse', 'main')
const owed = (e: Env) => pushOwedOf(e.store.meta(pushOwedKey('main')))

/** The queue's git, with `around` run in place of each push (it calls `run` for the real one). */
const withPush = (around: (run: () => Promise<QueueGitResult>) => Promise<QueueGitResult>) => async (cwd: string, args: string[], opts?: QueueGitOptions): Promise<QueueGitResult> => {
  const run = async (): Promise<QueueGitResult> => {
    const r = await git(cwd, args, undefined, undefined, opts?.env ? { env: opts.env } : undefined)
    return { ok: r.ok, out: r.out, err: r.err, code: r.code }
  }
  return args[0] === 'push' ? around(run) : run()
}

/** Another Hive (a restart): its own store connection, Workflow and queue on the same files. */
function restarted(e: Env): MergeQueue {
  const store = e.reopen()
  extra.push(store)
  return new MergeQueue(new Workflow({ ...e.wf.cfg, store }), { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }) })
}

describe('the merge queue pushes its target after merging (G18, #1179)', () => {
  it('on: each merge is pushed to the remote main tracks, and nothing stays owed', async () => {
    const { e, bare } = pushing()
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated', 'integrated'])
    expect(e.wf.state(a).stage).toBe('done')
    expect(e.wf.state(b).stage).toBe('done')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).toBeNull()
  })

  it('off (the default): nothing is pushed, and the option is never part of a ruleset', async () => {
    const { e, bare } = pushing(false)
    const before = remoteMain(bare)
    await queued(e, 'A', 'a.txt')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(remoteMain(bare)).toBe(before)
    for (const p of ['solo', 'pairAgent', 'pair', 'team'] as const) expect(preset('git', p).pushTarget, p).toBe(false)
    expect('pushTarget' in ruleOptions({ ...preset('git', 'pair'), pushTarget: true })).toBe(false)
    // Its row shows only where Hive merges.
    expect(formShows('pushTarget', preset('git', 'pair'))).toBe(true)
    expect(formShows('pushTarget', preset('git', 'pairAgent'))).toBe(false)
  })

  it('refused (the remote has commits main lacks): paused, the card Done, the next card waits; after a pull, Resume pushes and the queue goes on', async () => {
    const { e, bare } = pushing()
    // Someone else pushes to the remote first.
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    commit(other, { 'theirs.txt': 'theirs\n' }, 'theirs')
    sh(other, 'push', '-q', 'origin', 'main')
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const out = await e.queue().drain('main')
    expect(out.map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushRejected', card: a.key })
    expect(e.wf.state(a).stage).toBe('done')
    expect(e.wf.state(b).stage).toBe('merging')
    expect(owed(e)).toMatchObject({ card: a.key })
    expect(await e.queue().runOnce('main')).toBeNull()
    // The user pulls their commits into main, then resumes.
    sh(e.project, 'fetch', '-q', 'origin')
    sh(e.project, 'checkout', '-q', 'main')
    sh(e.project, 'merge', '-q', '--no-edit', 'origin/main')
    sh(e.project, 'checkout', '-q', '--detach')
    e.queue().resume('main')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(b).stage).toBe('done')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('no remote to push to: paused with that reason, and turning the option off then Resume carries on merging locally', async () => {
    const { e } = pushing()
    sh(e.project, 'branch', '-q', '--unset-upstream', 'main')
    sh(e.project, 'remote', 'remove', 'origin')
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    await e.queue().drain('main')
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushNoRemote', card: a.key })
    expect(e.wf.state(b).stage).toBe('merging')
    e.options.pushTarget = false
    e.queue().resume('main')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(b).stage).toBe('done')
    expect(owed(e)).toBeNull()
  })

  it('a failure other than a refusal (git cannot reach the remote): paused pushFailed with git\'s message', async () => {
    const { e } = pushing()
    sh(e.project, 'remote', 'set-url', 'origin', join(e.home, 'no-such-remote.git'))
    const a = await queued(e, 'A', 'a.txt')
    await e.queue().drain('main')
    const p = e.store.queuePause('main')
    expect(p).toMatchObject({ reason: 'pushFailed', card: a.key })
    expect(p?.message).toBeTruthy()
  })

  it('the push is owed in the same write as the merge: a crash before the push, and a restart pushes it before the next card', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
    expect(e.wf.state(a).stage).toBe('done')
    expect(owed(e)).toMatchObject({ card: a.key, result: localMain(e) })
    expect(remoteMain(bare)).toBe(before)
    const b = await queued(e, 'B', 'b.txt')
    const q = restarted(e)
    expect((await q.drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(b).stage).toBe('done')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).toBeNull()
  })

  it('a crash after Integrated was written by recovery owes the push too (the advance done, Hive stopped before Integrated)', async () => {
    const { e, bare } = pushing()
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ hooks: { afterAdvance: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    const q = restarted(e)
    expect((await q.recover()).map((o) => o.outcome)).toEqual(['integrated'])
    expect(owed(e)).toMatchObject({ card: a.key })
    await q.drain('main')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).toBeNull()
  })

  it('a crash after a successful push, before its clear: the retry is harmless (up to date) and later cards merge', async () => {
    const { e, bare } = pushing()
    await queued(e, 'A', 'a.txt')
    await expect(
      e.queue({
        git: withPush(async (run) => {
          await run()
          throw new Error('crash')
        })
      }).drain('main')
    ).rejects.toThrow('crash')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).not.toBeNull()
    const b = await queued(e, 'B', 'b.txt')
    expect((await restarted(e).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(b).stage).toBe('done')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(owed(e)).toBeNull()
  })

  it('owed and the option turned off since: no push on the restart, and the queue carries on', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    await queued(e, 'A', 'a.txt')
    await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
    e.options.pushTarget = false
    const b = await queued(e, 'B', 'b.txt')
    expect((await restarted(e).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(b).stage).toBe('done')
    expect(remoteMain(bare)).toBe(before)
    expect(owed(e)).toBeNull()
  })

  it('the target reset since the merge: the owed push is dropped, nothing pushed', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    await queued(e, 'A', 'a.txt')
    await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
    sh(e.project, 'branch', '-q', '-f', 'main', before)
    await restarted(e).drain('main')
    expect(remoteMain(bare)).toBe(before)
    expect(owed(e)).toBeNull()
  })

  it("a newer merge's owed push is never cleared by an older push's clear", async () => {
    const { e } = pushing()
    await queued(e, 'A', 'a.txt')
    const newer = JSON.stringify({ result: 'f'.repeat(40), card: 'AM-9', entry: 'AM-9/e1' })
    // While A's push runs, another merge's push becomes owed.
    await e.queue({
      git: withPush(async (run) => {
        const r = await run()
        e.store.setMeta(pushOwedKey('main'), newer)
        return r
      })
    }).drain('main')
    expect(e.store.meta(pushOwedKey('main'))).toBe(newer)
  })
})
