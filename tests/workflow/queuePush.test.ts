// G18 (#1179): the merge queue pushes its target after each merge, when the project's options say so. On real
// temporary repositories, each with a bare repository of its own as the remote: never a real remote.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { B1, commit, moved, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { formShows, preset } from '../../src/shared/workflow/options'
import { ruleOptions } from '../../src/shared/workflow/compile'
import { MergeQueue, pushOwedKey, pushOwedOf, type QueueGitOptions, type QueueGitResult } from '../../src/main/workflow/mergeQueue'
import { FactStore } from '../../src/main/workflow/factStore'
import { pushLogKey, pushLogOf, pushPendingKey, pushPendingOf } from '../../src/main/workflow/queueLogs'
import { Workflow } from '../../src/main/workflow/runtime'
import { git } from '../../src/main/git'
import * as G from '../../src/main/platform/git'

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})

/**
 * Pair (Hive merges), with the target `main` checked out nowhere, and a bare remote `origin` that main tracks. No review:
 * a submitted card goes straight into the queue, as the push is all these tests are about (HI-1930: a reviewer's start,
 * review copy and verdict per card made them slow enough to reach the time limit on a loaded machine).
 */
function pushing(on = true): { e: Env; bare: string } {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], pushTarget: on }))
  sh(e.project, 'checkout', '-q', '--detach')
  const bare = join(tempDir('remote-'), 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  sh(e.project, 'remote', 'add', 'origin', bare)
  // Pushed and tracked in one git (HI-2423: each git started counts on a loaded machine).
  sh(e.project, 'push', '-q', '-u', 'origin', 'main')
  return { e, bare }
}

async function queued(e: Env, title: string, file: string) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

const remoteMain = (bare: string): string => sh(bare, 'rev-parse', 'main')
const localMain = (e: Env): string => sh(e.project, 'rev-parse', 'main')
const owed = (e: Env) => pushOwedOf(e.store.meta(pushOwedKey('main')))
const pending = (e: Env) => pushPendingOf(e.store.meta(pushPendingKey('main')))
const settled = (e: Env) => pushLogOf(e.store.meta(pushLogKey('main')))
/** A card's latest queue entry. */
const entryOf = (e: Env, card: { id: number }): string => (e.store.facts(card.id).findLast((f) => f.kind === 'IntegrationRequested')!.data as { entry: string }).entry

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

  /** The remote with a commit main lacks (someone else pushed first). */
  function theirs(bare: string): void {
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    commit(other, { 'theirs.txt': 'theirs\n' }, 'theirs')
    sh(other, 'push', '-q', 'origin', 'main')
  }

  // Refused, then pulled and resumed: two tests (HI-1930), each about half the work of the one they were, so neither
  // nears the time limit on a loaded machine. Resume then going on to the next card is the "can't be read" tests'.
  it('refused (the remote has commits main lacks): paused, the card Done, the next card waits', async () => {
    const { e, bare } = pushing()
    theirs(bare)
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const out = await e.queue().drain('main')
    expect(out.map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushRejected', card: a.key })
    expect(e.wf.state(a).stage).toBe('done')
    expect(e.wf.state(b).stage).toBe('merging')
    expect(owed(e)).toMatchObject({ card: a.key })
    expect(await e.queue().runOnce('main')).toBeNull()
  })

  it('refused, then pulled: Resume pushes the owed merge, and nothing stays owed or paused', async () => {
    const { e, bare } = pushing()
    theirs(bare)
    const a = await queued(e, 'A', 'a.txt')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushRejected', card: a.key })
    // The user pulls their commits into main, then resumes.
    sh(e.project, 'fetch', '-q', 'origin')
    sh(e.project, 'checkout', '-q', 'main')
    sh(e.project, 'merge', '-q', '--no-edit', 'origin/main')
    sh(e.project, 'checkout', '-q', '--detach')
    e.queue().resume('main')
    await e.queue().drain('main')
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

  for (const read of ['lineHead', 'isAncestor'] as const) {
    it(`owed, and ${read === 'lineHead' ? 'the target' : 'whether the target has the merge'} can't be read: paused, the next card waits; Resume pushes and goes on (HR2 r1 f1)`, async () => {
      const { e, bare } = pushing()
      await queued(e, 'A', 'a.txt')
      await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
      const b = await queued(e, 'B', 'b.txt')
      const spy = vi.spyOn(G, read).mockResolvedValueOnce({ unknown: true, what: 'a read that failed for now' })
      try {
        expect(await e.queue().runOnce('main')).toMatchObject({ outcome: 'paused', reason: 'pushUnreadable' })
      } finally {
        spy.mockRestore()
      }
      expect(e.wf.state(b).stage).toBe('merging')
      expect(owed(e)).not.toBeNull()
      // Said in Hive's own words, a message the window translates (HR2's round 2): no English stored with it.
      expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushUnreadable' })
      expect(e.store.queuePause('main')?.message).toBeFalsy()
      e.queue().resume('main')
      expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
      expect(e.wf.state(b).stage).toBe('done')
      expect(remoteMain(bare)).toBe(localMain(e))
    })
  }

  // HI-2054: where to push, read by git, is taken only from git's own answer (a value, or exit 1: not set). A git that
  // couldn't answer (never started, ended by a signal, ended at a bound whatever its code and partial output, or git's
  // own error) is unreadable: paused in Hive's own words, still owed, nothing pushed; never "no remote", nor a guessed ref.
  // One card each (HI-2077: twelve cases of two cards each reached the time limit on a loaded machine): that the next card
  // waits behind a pushUnreadable pause is the lineHead and isAncestor reads' tests above.
  const notAnswers: [string, Partial<QueueGitResult>][] = [
    ['never started', { code: -1, notRun: 'EAGAIN', err: 'spawn git EAGAIN' }],
    ["git's own error", { code: 128, err: 'fatal: bad config line 3 in file .git/config' }],
    ['ended by a signal', { code: -1, signal: 'SIGTERM', err: 'git was ended by a signal (SIGTERM)' }],
    ['ended at a bound, its code 1, part of an answer out', { code: 1, timedOut: true, out: 'refs/heads/elsewhere\n' }]
  ]
  const reads: [string, (args: string[]) => boolean, boolean][] = [
    ['its upstream remote', (a) => a[0] === 'config' && a.includes('branch.main.remote'), true],
    ['its upstream branch, after its remote was read', (a) => a[0] === 'config' && a.includes('branch.main.merge'), true],
    ['the remotes (no upstream)', (a) => a.length === 1 && a[0] === 'remote', false]
  ]
  for (const [read, matches, upstream] of reads)
    for (const [how, failed] of notAnswers)
      it(`HI-2054: owed, and ${read} read by a git that ${how}: paused pushUnreadable, still owed, nothing pushed; Resume pushes`, async () => {
        const { e, bare } = pushing()
        if (!upstream) sh(e.project, 'branch', '-q', '--unset-upstream', 'main')
        const before = remoteMain(bare)
        const a = await queued(e, 'A', 'a.txt')
        let pushed = false
        let asked = 0
        const git1 = withPush(async (run) => {
          pushed = true
          return run()
        })
        await e
          .queue({
            git: async (cwd, args, opts) => {
              if (!matches(args)) return git1(cwd, args, opts)
              asked++
              return { ok: false, out: '', err: '', ...failed } as QueueGitResult
            }
          })
          .drain('main')
        expect(asked).toBe(1)
        expect(pushed).toBe(false)
        expect(remoteMain(bare)).toBe(before)
        expect(e.wf.state(a).stage).toBe('done')
        expect(owed(e)).not.toBeNull()
        expect(pending(e).map((p) => p.entry)).toEqual([entryOf(e, a)])
        // In Hive's own words, as the other unreadable reads: no English stored with it.
        expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushUnreadable', card: a.key })
        expect(e.store.queuePause('main')?.message).toBeFalsy()
        e.queue().resume('main')
        await e.queue().drain('main')
        expect(remoteMain(bare)).toBe(localMain(e))
        expect(owed(e)).toBeNull()
        expect(e.store.queuePause('main')).toBeNull()
      })

  it('turned off while the push is being prepared (its remote read): no push begins, and the queue carries on (HR2 r1 f2)', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    await queued(e, 'A', 'a.txt')
    let switched = false
    let pushed = false
    const git1 = withPush(async (run) => {
      pushed = true
      return run()
    })
    await e
      .queue({
        git: async (cwd, args, opts) => {
          const r = await git1(cwd, args, opts)
          if (args[0] === 'config' && args.includes('branch.main.remote')) {
            e.options.pushTarget = false
            switched = true
          }
          return r
        }
      })
      .drain('main')
    expect(switched).toBe(true)
    expect(pushed).toBe(false)
    expect(remoteMain(bare)).toBe(before)
    expect(owed(e)).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('each push is recorded for the history (HI-1924): owed while it waits, pushed once it went, by entry', async () => {
    const { e } = pushing()
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    await e.queue().drain('main')
    expect(pending(e)).toEqual([])
    expect(settled(e).map((p) => [p.entry, p.state])).toEqual([
      [entryOf(e, b), 'pushed'],
      [entryOf(e, a), 'pushed']
    ])
  })

  it('a failed push leaves its merge pending; the next push that goes settles it, with a merge it carries from before (HI-1924)', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    sh(e.project, 'remote', 'set-url', 'origin', join(e.home, 'no-such-remote.git'))
    const a = await queued(e, 'A', 'a.txt')
    await e.queue().drain('main')
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'pushFailed' })
    expect(pending(e).map((p) => p.entry)).toEqual([entryOf(e, a)])
    expect(settled(e)).toEqual([])
    // An earlier merge also pending (one owed before a crash, say): main has it, so the same push carries it.
    e.store.setMeta(pushPendingKey('main'), JSON.stringify([{ entry: 'X/e1', result: before }, ...pending(e)]))
    sh(e.project, 'remote', 'set-url', 'origin', bare)
    e.queue().resume('main')
    await e.queue().drain('main')
    expect(remoteMain(bare)).toBe(localMain(e))
    expect(pending(e)).toEqual([])
    expect(settled(e).map((p) => [p.entry, p.state])).toEqual([
      [entryOf(e, a), 'pushed'],
      ['X/e1', 'pushed']
    ])
  })

  it('the option turned off, or the target reset, with merges pending: settled as not pushed, never as pushed (HI-1924)', async () => {
    const { e, bare } = pushing()
    const before = remoteMain(bare)
    const a = await queued(e, 'A', 'a.txt')
    await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
    e.options.pushTarget = false
    await restarted(e).drain('main')
    expect(settled(e).map((p) => [p.entry, p.state])).toEqual([[entryOf(e, a), 'off']])
    e.options.pushTarget = true
    const b = await queued(e, 'B', 'b.txt')
    await expect(e.queue({ git: withPush(() => Promise.reject(new Error('crash'))) }).drain('main')).rejects.toThrow('crash')
    sh(e.project, 'branch', '-q', '-f', 'main', before)
    await restarted(e).drain('main')
    expect(remoteMain(bare)).toBe(before)
    expect(pending(e)).toEqual([])
    expect(settled(e).map((p) => [p.entry, p.state])[0]).toEqual([entryOf(e, b), 'reset'])
  })

  it('the push goes by the commit read before it, so what is marked pushed is what went (HI-1924)', async () => {
    const { e } = pushing()
    const pushedArgs: string[][] = []
    const b = await queued(e, 'B', 'b.txt')
    await e
      .queue({
        git: async (cwd, args, opts) => {
          if (args[0] === 'push') pushedArgs.push(args)
          return withPush((run) => run())(cwd, args, opts)
        }
      })
      .drain('main')
    expect(pushedArgs).toEqual([['push', '--', 'origin', `${localMain(e)}:refs/heads/main`]])
    expect(settled(e)[0]).toMatchObject({ entry: entryOf(e, b), state: 'pushed' })
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
