// G21 (HI-1183, SPEC §16.9.4): the merge queue's target follows its remote. On real temporary repositories, each with
// a bare repository of its own as the remote (never a real remote): the fetch before each test merge, the publication as
// an exact compare-and-swap at the remote, the sealed transport, unknown publications, and the local target's catch-up.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import { execFileSync } from 'child_process'
import { B1, commit, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { formShows, preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { ruleOptions } from '../../src/shared/workflow/compile'
import { catchUpKey, catchUpOf, gitTree, MergeQueue, type QueueConfig, type QueueGitOptions, type QueueGitResult } from '../../src/main/workflow/mergeQueue'
import { FactStore } from '../../src/main/workflow/factStore'
import { pushLogKey, pushLogOf } from '../../src/main/workflow/queueLogs'
import { Workflow } from '../../src/main/workflow/runtime'
import { memoryTransportStore } from '../../src/main/workflow/transportSnapshots'
import { queueLine, queueOrder, queueStateOf } from '../../src/main/workflow/queueState'
import { QUEUE_ADVANCE_GATE, QUEUE_PUBLISH_GATE, QUEUE_STUCK_GATE } from '../../src/shared/workflow/facts'

let env: Env | null = null
const extra: FactStore[] = []
afterEach(() => {
  for (const s of extra.splice(0)) s.close()
  env?.close()
  env = null
})

const slash = (p: string): string => p.replace(/\\/g, '/')

/** A bare remote with `main`, made from nothing. */
function bareRepo(name = 'origin.git'): string {
  const bare = slash(join(tempDir('remote-'), name))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  return bare
}

/**
 * Pair (Combwork merges) following its remote, no review, `main` checked out nowhere (unless `checkedOut`), tracking a
 * bare `origin`, and a store in memory for the snapshots.
 */
function following(o: Partial<WorkflowOptions> = {}, opts: { checkedOut?: boolean } = {}) {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], followRemote: true, ...o }))
  if (!opts.checkedOut) sh(e.project, 'checkout', '-q', '--detach')
  const bare = bareRepo()
  sh(e.project, 'remote', 'add', 'origin', bare)
  sh(e.project, 'push', '-q', '-u', 'origin', 'main')
  const transport = memoryTransportStore()
  const queue = (cfg: Partial<QueueConfig> = {}): MergeQueue => e.queue({ transport, ...cfg })
  return { e, bare, transport, queue }
}

async function queued(e: Env, title: string, file: string, text = `${title}\n`, more: Record<string, string> = {}) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: text, ...more }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

const head = (repo: string, ref = 'main'): string => sh(repo, 'rev-parse', ref)
/** Whether the card's last answer wrote the `enqueue` the app runs its queue on (queueHost's onAction). */
const answerEnqueues = (e: Env, card: number): boolean => e.store.hasAction(card, 'enqueue', e.store.facts(card).filter((f) => f.kind === 'Approval').at(-1)!.seq)
const refsOf = (repo: string): string => sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)')

/** Another clone pushes a commit to the remote (someone else published first). */
function theirs(bare: string, file = 'theirs.txt'): string {
  const other = join(tempDir('other-'), 'clone')
  execFileSync('git', ['clone', '-q', bare, other])
  sh(other, 'config', 'user.email', 'other@example.com')
  sh(other, 'config', 'user.name', 'Other')
  commit(other, { [file]: `${file}\n` }, file)
  sh(other, 'push', '-q', 'origin', 'main')
  return head(other)
}

/** The queue's git (with its environment and bound, as the app's runner), `around` given each command first. */
const gitWith = (around: (args: string[], run: () => Promise<QueueGitResult>) => Promise<QueueGitResult>) => (cwd: string, args: string[], opts?: QueueGitOptions): Promise<QueueGitResult> => around(args, () => gitTree(cwd, args, opts ?? {}))

/** Another Combwork (a restart): its own store connection, Workflow and queue on the same files and snapshot store. */
function restarted(e: Env, transport: ReturnType<typeof memoryTransportStore>, cfg: Partial<QueueConfig> = {}): MergeQueue {
  const store = e.reopen()
  extra.push(store)
  return new MergeQueue(new Workflow({ ...e.wf.cfg, store }), { folder: join(e.home, 'queue'), runCheck: async () => ({ ok: true, output: '' }), transport, ...cfg })
}

describe('the target follows its remote (G21, HI-1183)', () => {
  it('is off by default, never a rule, and shown only where Combwork merges', () => {
    for (const p of ['solo', 'pairAgent', 'pair', 'team'] as const) expect(preset('git', p).followRemote, p).toBe(false)
    expect('followRemote' in ruleOptions({ ...preset('git', 'pair'), followRemote: true })).toBe(false)
    expect(formShows('followRemote', preset('git', 'pair'))).toBe(true)
    expect(formShows('followRemote', preset('git', 'pairAgent'))).toBe(false)
  })

  it('a merge is tested on the remote head, published there, the local target caught up and the push logged', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const out = await queue().drain('main')
    expect(out.map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(pushLogOf(e.store.meta(pushLogKey('main'))).map((p) => p.state)).toEqual(['pushed'])
    // The snapshot is gone with the outcome, and the fact names no URL with credentials, only its record.
    expect(transport.raw.size).toBe(0)
    const started = e.store.facts(a.id).find((f) => f.kind === 'IntegrationStarted')!.data as { publish?: { endpoint: string; remote: string; ref: string } }
    expect(started.publish).toMatchObject({ remote: 'origin', ref: 'refs/heads/main', endpoint: bare })
  })

  it('the snapshot store unreadable at the save (HI-2993): nothing published or begun, tried again as a failed read, then merged', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport } = following()
    const a = await queued(e, 'A', 'a.txt')
    let fails = 1
    const saves: string[] = []
    const flaky = { ...transport, save: async (...args: Parameters<typeof transport.save>) => {
      saves.push(fails > 0 ? 'refused' : 'kept')
      if (fails-- > 0) throw new Error("the transport store couldn't be read: EBUSY")
      return transport.save(...args)
    } }
    const before = head(bare)
    const out = await e.queue({ transport: flaky }).drain('main')
    expect(saves).toEqual(['refused', 'kept'])
    expect(out.map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).not.toBe(before)
    // One begun publication only: the refused save began nothing.
    expect(e.store.facts(a.id).filter((f) => f.kind === 'IntegrationStarted')).toHaveLength(1)
  })

  it('a local target behind its remote: tested on the remote head, which the merge contains, and the local one fast-forwarded', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const theirsHead = theirs(bare)
    await queued(e, 'A', 'a.txt')
    expect((await queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(sh(e.project, 'merge-base', '--is-ancestor', theirsHead, 'main')).toBe('')
    expect(head(bare)).toBe(head(e.project))
  })

  it('someone pushes between the fetch and the publication: refused by the lease, tested again, then merged', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    await queued(e, 'A', 'a.txt')
    let races = 0
    const out = await queue({ hooks: { beforePublish: () => void (races++ === 0 && theirs(bare)) } }).drain('main')
    expect(out).toEqual([expect.objectContaining({ outcome: 'integrated', retests: 1 })])
    expect(head(bare)).toBe(head(e.project))
    expect(existsSync(join(e.project, 'theirs.txt')) || sh(e.project, 'ls-tree', '--name-only', 'main').includes('theirs.txt')).toBe(true)
  })

  it('a remote that keeps moving pauses the queue (the three-retests limit), nothing published', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    let n = 0
    const out = await queue({ hooks: { beforePublish: () => void theirs(bare, `t${n++}.txt`) } }).drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'targetMovesFast' })
    expect(e.wf.state(a).stage).toBe('merging')
    expect(sh(bare, 'log', '--format=%s', 'main')).not.toContain('A')
  })

  it('a local target with commits its remote lacks pauses (remoteDiverged): nothing forced, nothing merged silently', async () => {
    const { e, bare, queue } = following()
    const before = head(bare)
    sh(e.project, 'checkout', '-q', 'main')
    commit(e.project, { 'local.txt': 'local\n' }, 'local only')
    sh(e.project, 'checkout', '-q', '--detach')
    await queued(e, 'A', 'a.txt')
    const out = await queue().drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'remoteDiverged' })
    expect(head(bare)).toBe(before)
  })

  it('a fetch that fails pauses with git’s words; a target tracking nothing pauses noUpstream; two push URLs pause remoteAmbiguous', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, queue } = following()
    await queued(e, 'A', 'a.txt')
    sh(e.project, 'remote', 'set-url', 'origin', slash(join(tempDir('gone-'), 'nothing.git')))
    const failed = await queue().drain('main')
    expect(failed.at(-1)).toMatchObject({ outcome: 'paused', reason: 'fetchFailed' })
    expect((failed.at(-1) as { message?: string }).message).toBeTruthy()
    e.store.setQueuePause('main', null)
    sh(e.project, 'remote', 'set-url', 'origin', bareRepo('one.git'))
    sh(e.project, 'remote', 'set-url', '--add', '--push', 'origin', bareRepo('a.git'))
    sh(e.project, 'remote', 'set-url', '--add', '--push', 'origin', bareRepo('b.git'))
    expect((await queue().drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'remoteAmbiguous' })
    e.store.setQueuePause('main', null)
    sh(e.project, 'branch', '--unset-upstream', 'main')
    expect((await queue().drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'noUpstream' })
  })

  it('a remote that refuses (its pre-receive hook) pauses publishRefused with its own words; nothing published, the card queued again', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "main is a protected branch: changes need a pull request" >&2\nexit 1\n')
    const before = head(bare)
    const a = await queued(e, 'A', 'a.txt')
    const out = await queue().drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishRefused' })
    expect(e.store.queuePause('main')?.message).toContain('protected branch')
    expect(head(bare)).toBe(before)
    expect(e.wf.state(a).stage).toBe('merging')
  })

  it('the project’s pre-push hook runs once, in the project, with git’s own arguments and update line; one that refuses publishes nothing', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const log = slash(join(tempDir('hook-'), 'log.txt'))
    writeFileSync(join(e.project, 'marker.txt'), 'in the project\n')
    writeFileSync(join(e.project, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n{ echo "args $1 $2"; cat; echo "top $(git rev-parse --show-toplevel)"; cat marker.txt; } >> "${log}"\nexit 0\n`)
    await queued(e, 'A', 'a.txt')
    const onto = head(bare)
    expect((await queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const result = head(bare)
    const lines = readFileSync(log, 'utf8').trim().split(/\r?\n/)
    expect(lines).toEqual([`args origin ${bare}`, `${result} ${result} refs/heads/main ${onto}`, `top ${slash(e.project)}`, 'in the project'])
    writeFileSync(join(e.project, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho "not today" >&2\nexit 1\n')
    await queued(e, 'B', 'b.txt')
    const out = await queue().drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishRefused' })
    expect(e.store.queuePause('main')?.message).toContain('not today')
    expect(head(bare)).toBe(result)
  })

  it('a target tracking a remote branch of another name: tested on, published to and hooked with that branch’s full ref (HR2’s s20 note)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    sh(e.project, 'push', '-q', 'origin', 'main:trunk')
    sh(e.project, 'branch', '--set-upstream-to=origin/trunk', 'main')
    const log = slash(join(tempDir('hook-'), 'log.txt'))
    writeFileSync(join(e.project, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n{ echo "args $1 $2"; cat; } >> "${log}"\n`)
    const mainBefore = head(bare, 'main')
    const onto = head(bare, 'trunk')
    await queued(e, 'A', 'a.txt')
    expect((await queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const result = head(bare, 'trunk')
    expect(result).not.toBe(onto)
    expect(head(bare, 'main')).toBe(mainBefore)
    expect(head(e.project, 'main')).toBe(result)
    expect(readFileSync(log, 'utf8').trim().split(/\r?\n/)).toEqual([`args origin ${bare}`, `${result} ${result} refs/heads/trunk ${onto}`])
  })

  it('a relative remote path keeps the project’s meaning in the sealed context and recovery (HR2’s round 1)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    sh(e.project, 'remote', 'set-url', 'origin', slash(relative(e.project, bare)))
    const a = await queued(e, 'A', 'a.txt')
    expect((await queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
  })

  it('a card someone else published to the remote while the local target is behind: Done from the fetched head, the local one caught up, the queue goes on (HR2’s round 1)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const revA = (e.store.facts(a.id).findLast((f) => f.kind === 'Submitted')!.data as { revision: string }).revision
    sh(e.project, 'push', '-q', bare, `${revA}:refs/heads/main`)
    const out = await queue().drain('main')
    expect(out.map((o) => o.outcome)).toEqual(['integratedOutside', 'integrated'])
    expect(e.wf.state(a).stage).toBe('done')
    expect(e.wf.state(b).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
  })

  it('a publication whose reply is lost is verified at the remote: shown there, Done, and never pushed twice', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    let pushes = 0
    const git = gitWith(async (args, run) => {
      if (args[0] !== 'push') return run()
      pushes++
      const r = await run()
      return { ...r, ok: false, code: -1, timedOut: true }
    })
    expect((await queue({ git }).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(pushes).toBe(1)
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
  })

  it('a reply lost and the remote reset before it is verified: unknown, paused and asked; no second push, no retest, until the user answers', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const onto = head(bare)
    let pushes = 0
    const git = gitWith(async (args, run) => {
      if (args[0] !== 'push') return run()
      pushes++
      const r = await run()
      // Someone removes it again before Combwork looks.
      sh(bare, 'update-ref', 'refs/heads/main', onto)
      return { ...r, ok: false, code: -1, signal: 'SIGTERM' }
    })
    const out = await queue({ git }).drain('main')
    expect(out.at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishUnknown' })
    expect(e.wf.state(a).requests.some((r) => r.gate === QUEUE_PUBLISH_GATE)).toBe(true)
    // A restart and a Resume look again, and still don't push or retest.
    const again = restarted(e, transport, { git })
    again.resume('main')
    expect((await again.drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishUnknown' })
    expect(pushes).toBe(1)
    expect(e.wf.state(a).stage).toBe('merging')
    expect(head(bare)).toBe(onto)
    // The user says it was published: Done, without a push.
    const req = e.wf.state(a).requests.find((r) => r.gate === QUEUE_PUBLISH_GATE)!
    moved(await e.wf.answer(a.key, req.request, 'approved'))
    // HI-3088: the answer itself has the app run the queue (its enqueue), as the advance's answer does.
    expect(answerEnqueues(e, a.id)).toBe(true)
    expect((await queue({ git }).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(pushes).toBe(1)
    expect(e.wf.state(a).stage).toBe('done')
  })

  it('HI-3091: a push that never reached the remote (gone between the fetch and the push) pauses publishFailed with git’s words, never asked as unknown; back, Resume publishes it', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, transport, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const onto = head(bare)
    const away = `${bare}.away`
    const out = await queue({ hooks: { beforePublish: () => renameSync(bare, away) } }).drain('main')
    expect(out.at(-1)).toMatchObject({ card: a.key, outcome: 'paused', reason: 'publishFailed' })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'publishFailed', card: a.key, message: expect.stringMatching(/does not appear to be a git repository|Could not read from remote repository/) })
    expect(e.wf.state(a).requests.some((r) => r.gate === QUEUE_PUBLISH_GATE)).toBe(false)
    expect(e.wf.state(a).stage).not.toBe('done')
    renameSync(away, bare)
    expect(head(bare)).toBe(onto)
    const q = restarted(e, transport)
    q.resume('main')
    expect((await q.drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).not.toBe(onto)
  })

  it('HI-3091: what agents are told of an unknown publication: the card paused (not "moving main now"), and once answered, the one behind it says so', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const b = await queued(e, 'B', 'b.txt')
    const onto = head(bare)
    let lose = true
    const git = gitWith(async (args, run) => {
      if (args[0] !== 'push' || !lose) return run()
      lose = false
      const r = await run()
      sh(bare, 'update-ref', 'refs/heads/main', onto)
      return { ...r, ok: false, code: -1, timedOut: true }
    })
    expect((await queue({ git }).drain('main')).at(-1)).toMatchObject({ card: a.key, reason: 'publishUnknown' })
    const line = (id: number) => queueLine(queueStateOf(e.wf, e.store.card(id))!)
    expect(queueOrder(e.wf, 'main').testing).toBeNull()
    expect(queueStateOf(e.wf, e.store.card(a.id))).toMatchObject({ state: 'paused', reason: 'publishUnknown', card: a.key })
    expect(line(a.id)).not.toMatch(/moving main to its merge/)
    expect(line(a.id)).toMatch(/whether its push reached the remote \(their answer in For you\)/)
    expect(line(b.id)).toMatch(/whether its push reached the remote \(their answer in For you\)/)
    const req = e.wf.state(a).requests.find((r) => r.gate === QUEUE_PUBLISH_GATE)!
    moved(await e.wf.answer(a.key, req.request, 'approved'))
    // Answered, the queue not run yet: nobody is told it waits for an answer already given.
    expect(line(b.id)).toMatch(/the user has answered whether its push reached the remote/)
  })

  it('declined (it wasn’t published): the card is tested and published again', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    const onto = head(bare)
    let lose = true
    const git = gitWith(async (args, run) => {
      if (args[0] !== 'push' || !lose) return run()
      lose = false
      const r = await run()
      sh(bare, 'update-ref', 'refs/heads/main', onto)
      return { ...r, ok: false, code: -1, timedOut: true }
    })
    expect((await queue({ git }).drain('main')).at(-1)).toMatchObject({ reason: 'publishUnknown' })
    const req = e.wf.state(a).requests.find((r) => r.gate === QUEUE_PUBLISH_GATE)!
    moved(await e.wf.answer(a.key, req.request, 'declined'))
    expect(answerEnqueues(e, a.id)).toBe(true)
    expect((await queue({ git }).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
  })

  it('a crash after the publication: the restart verifies it at the endpoint it captured (a rewrite since doesn’t move it), Done', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, queue } = following()
    // origin is reached through a rewrite at capture.
    sh(e.project, 'config', `url.${bare}.insteadOf`, 'alias:')
    sh(e.project, 'remote', 'set-url', 'origin', 'alias:')
    const a = await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { afterPublish: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    // The rewrite goes, and another one points elsewhere: recovery uses the captured endpoint.
    const wrong = bareRepo('wrong.git')
    sh(e.project, 'config', '--unset', `url.${bare}.insteadOf`)
    sh(e.project, 'config', `url.${wrong}.insteadOf`, 'alias:')
    expect((await restarted(e, transport).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(e.wf.state(a).stage).toBe('done')
    expect(refsOf(wrong)).toBe('')
  })

  it('a crash in phase push before anything was sent is unknown too (the transport may have begun): asked, never guessed', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, transport, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { beforePublish: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect((await restarted(e, transport).drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishUnknown' })
    expect(e.wf.state(a).stage).toBe('merging')
  })

  it('another target’s clean-up between a save and its IntegrationStarted never takes the snapshot: the restart verifies and merges (HR2’s round 2)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, queue } = following()
    const a = await queued(e, 'A', 'a.txt')
    // Another target's queue host finishing and cleaning up at the worst moment, and its own target's too, after the save.
    const other = queue()
    const racing = { ...transport, save: async (p: string, t: string, s: Parameters<typeof transport.save>[2]) => {
      const kept = await transport.save(p, t, s)
      await other.pruneSnapshots('release')
      return kept
    } }
    await expect(queue({ transport: racing, hooks: { afterPublish: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(transport.raw.size).toBe(1)
    expect((await restarted(e, transport).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(head(e.project))
    // Its own target's clean-up then drops what no begun publication needs.
    await restarted(e, transport).pruneSnapshots('main')
    expect(transport.raw.size).toBe(0)
  })

  it('a snapshot gone (or changed) at recovery is unknown: never rebuilt from the configuration as it is now', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, transport, queue } = following()
    await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { afterPublish: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    transport.raw.clear()
    expect((await restarted(e, transport).drain('main')).at(-1)).toMatchObject({ outcome: 'paused', reason: 'publishUnknown' })
  })

  it('rewrites added at the child boundary (insteadOf, pushInsteadOf, an include) never redirect the sealed transport', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    // A wrong endpoint holding the same history.
    const wrong = bareRepo('wrong.git')
    sh(e.project, 'push', '-q', wrong, 'main')
    const wrongRefs = refsOf(wrong)
    const include = slash(join(tempDir('include-'), 'rewrite.cfg'))
    writeFileSync(include, `[url "${wrong}"]\n\tpushInsteadOf = ${bare}\n`)
    const git = gitWith(async (args, run) => {
      if (args[0] === 'fetch' || args[0] === 'push') {
        sh(e.project, 'config', `url.${wrong}.insteadOf`, bare)
        sh(e.project, 'config', `url.${wrong}.pushInsteadOf`, bare)
        sh(e.project, 'config', 'include.path', include)
      }
      return run()
    })
    await queued(e, 'A', 'a.txt')
    expect((await queue({ git }).drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    expect(refsOf(wrong)).toBe(wrongRefs)
    expect(head(bare)).toBe(head(e.project))
  })

  it('credentials in the carried settings stay out of facts and pause messages', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following()
    sh(e.project, 'config', 'http.extraHeader', 'Authorization: Bearer SECRET-BEARER-123')
    sh(e.project, 'config', 'credential.helper', '!f() { echo password=SECRET-HELPER-456; }; f')
    writeFileSync(join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "refused, header was SECRET-BEARER-123" >&2\nexit 1\n')
    const a = await queued(e, 'A', 'a.txt')
    expect((await queue().drain('main')).at(-1)).toMatchObject({ reason: 'publishRefused' })
    const kept = JSON.stringify(e.store.facts(a.id)) + JSON.stringify(e.store.queuePause('main'))
    expect(kept).not.toContain('SECRET-BEARER-123')
    expect(kept).not.toContain('SECRET-HELPER-456')
    expect(kept).toContain('***')
  })

  it('Ask each time, the target checked out: the Approve, taken by a new queue as the host makes one per run, publishes the result approved (HI-2986)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following({}, { checkedOut: true })
    const ask: Partial<QueueConfig> = { checkedOutTarget: () => 'ask' }
    const a = await queued(e, 'A', 'a.txt')
    const request = () => e.wf.state(e.store.card(a.id)).requests.find((r) => r.gate === QUEUE_ADVANCE_GATE)
    expect(await queue(ask).drain('main')).toMatchObject([{ card: a.key, outcome: 'paused', reason: 'approval' }])
    const asked = request()!
    expect(asked).toBeDefined()
    const approved = asked.result
    moved(await e.wf.answer(a.key, asked.request, 'approved'))
    // The next run: another MergeQueue, which never tested it. It publishes what the user approved, not a new test merge.
    expect(await queue(ask).drain('main')).toMatchObject([{ card: a.key, outcome: 'integrated' }])
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).toBe(approved)
    expect(request()).toBeUndefined()
    expect(head(e.project)).toBe(head(bare))
  })

  it('a checked-out target is caught up in its folder after the publication; an edit in its way pauses, naming the published card', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue } = following({}, { checkedOut: true })
    const a = await queued(e, 'A', 'a.txt')
    // The user has a.txt of their own, untracked, where the merge adds it.
    writeFileSync(join(e.project, 'a.txt'), 'mine\n')
    const out = await queue().drain('main')
    expect(out.map((o) => o.outcome)).toContain('integrated')
    expect(e.wf.state(a).stage).toBe('done')
    expect(head(bare)).not.toBe(head(e.project))
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'unstagedChanges', card: a.key })
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('mine\n')
    // Moved out of the way, then Resume: caught up.
    execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'del', join(e.project, 'a.txt')] : [join(e.project, 'a.txt')])
    queue().resume('main')
    await queue().drain('main')
    expect(head(e.project)).toBe(head(bare))
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
  })

  it('a catch-up stopped between its files and its ref is finished by its journal after a restart (recovery first)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, queue } = following({}, { checkedOut: true })
    const a = await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { beforeCatchUpRef: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(e.wf.state(a).stage).toBe('done')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))?.phase).toBe('ref')
    await restarted(e, transport).drain('main')
    expect(head(e.project)).toBe(head(bare))
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
  })
})

describe('a published card’s owed catch-up (HI-2988)', () => {
  const contains = (repo: string, commitId: string, ref = 'main'): boolean => {
    try {
      sh(repo, 'merge-base', '--is-ancestor', commitId, ref)
      return true
    } catch {
      return false
    }
  }
  const del = (file: string): void => void execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'del', file] : [file])

  /** A published, Done; its catch-up into the checked-out main paused on the user's own a.txt. */
  async function caughtOnAFile() {
    const f = following({}, { checkedOut: true })
    const a = await queued(f.e, 'A', 'a.txt')
    writeFileSync(join(f.e.project, 'a.txt'), 'mine\n')
    await f.queue().drain('main')
    expect(f.e.wf.state(a).stage).toBe('done')
    expect(f.e.store.queuePause('main')).toMatchObject({ reason: 'unstagedChanges', card: a.key })
    expect(catchUpOf(f.e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    return { ...f, a }
  }

  it('a commit on the local target meanwhile (the user’s, by hand): the catch-up stays owed and pauses remoteDiverged naming the card; put right, it catches up', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    // What Commit did before HI-2988 (commitPaths' git), by hand now.
    sh(e.project, 'add', '--intent-to-add', '--', ':(top,literal)a.txt')
    sh(e.project, 'commit', '--only', '--quiet', '-m', 'mine', '--', ':(top,literal)a.txt')
    queue().resume('main')
    expect(await queue().drain('main')).toMatchObject([{ card: a.key, outcome: 'paused', reason: 'remoteDiverged', files: ['main'] }])
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    // Not dropped silently: resumed with the commit still there, still A's pause.
    queue().resume('main')
    expect(await queue().drain('main')).toMatchObject([{ card: a.key, outcome: 'paused', reason: 'remoteDiverged' }])
    // The user takes their commit off main again: A's catch-up goes on.
    sh(e.project, 'reset', '-q', '--hard', 'HEAD~1')
    queue().resume('main')
    await queue().drain('main')
    expect(contains(e.project, e.wf.state(a).integrated!.result)).toBe(true)
    expect(head(e.project)).toBe(head(bare))
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('set aside instead: caught up, local main holding the published merge, and the next card merged', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    sh(e.project, 'stash', 'push', '-q', '-u', '-m', 'set aside', '--', 'a.txt')
    queue().resume('main')
    await queue().drain('main')
    expect(head(e.project)).toBe(head(bare))
    expect(contains(e.project, e.wf.state(a).integrated!.result)).toBe(true)
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    const b = await queued(e, 'B', 'b.txt')
    await queue().drain('main')
    expect(e.wf.state(b).stage).toBe('done')
  })

  it('reconciling the published card while its catch-up waits, or while main is merely behind it: never LeftTarget', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
    del(join(e.project, 'a.txt'))
    queue().resume('main')
    await queue().drain('main')
    expect(head(e.project)).toBe(head(bare))
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
    // main moved back behind the published result (nothing owed now): behind, not left.
    const before = sh(e.project, 'rev-parse', `${e.wf.state(a).integrated!.result}^1`)
    sh(e.project, 'reset', '-q', '--hard', before)
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
    expect(e.store.facts(a.id).some((f) => f.kind === 'LeftTarget')).toBe(false)
  })

  it('HI-3041: the published merge taken off the remote while its catch-up is owed: ended once the local target is in line, the card marked as having left, the next card merged', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    const before = sh(e.project, 'rev-parse', `${e.wf.state(a).integrated!.result}^1`)
    // A teammate force-pushes main without the merge (another commit in its place).
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    sh(other, 'config', 'user.email', 'other@example.com')
    sh(other, 'config', 'user.name', 'Other')
    sh(other, 'reset', '-q', '--hard', before)
    commit(other, { 'rewrite.txt': 'rewrite\n' }, 'rewrite')
    sh(other, 'push', '-q', '-f', 'origin', 'main')
    // The user brings the local main in line with its remote, as the pause asks.
    del(join(e.project, 'a.txt'))
    sh(e.project, 'fetch', '-q', 'origin')
    sh(e.project, 'reset', '-q', '--hard', 'origin/main')
    expect(head(e.project)).toBe(head(bare))
    const b = await queued(e, 'B', 'b.txt')
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
    expect(e.wf.state(b).stage).toBe('done')
    expect(contains(bare, e.wf.state(b).integrated!.result)).toBe(true)
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toMatchObject({ target: 'main' })
  })

  it('HI-3041 (HR1): the published merge taken off the remote while the local target is still behind it, its catch-up owed: never brought in locally; ended, marked left, the next card merged', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    const result = e.wf.state(a).integrated!.result
    const before = sh(e.project, 'rev-parse', `${result}^1`)
    expect(head(e.project)).toBe(before)
    // The remote reset to the merge's parent (the published merge dropped); the local main still behind the result.
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    sh(other, 'reset', '-q', '--hard', before)
    sh(other, 'push', '-q', '-f', 'origin', 'main')
    del(join(e.project, 'a.txt'))
    const b = await queued(e, 'B', 'b.txt')
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(contains(e.project, result)).toBe(false)
    expect(existsSync(join(e.project, 'a.txt'))).toBe(false)
    expect(e.store.queuePause('main')).toBeNull()
    expect(e.wf.state(b).stage).toBe('done')
    expect(contains(bare, e.wf.state(b).integrated!.result)).toBe(true)
    expect(contains(e.project, e.wf.state(b).integrated!.result)).toBe(true)
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toMatchObject({ target: 'main' })
  })

  it('HI-3041 (HR2): stopped after its files moved, before its ref; the remote then drops the result: the files rolled back, never swapped in; ended, marked left, the next card merged', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, transport, queue } = following({}, { checkedOut: true })
    const a = await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { beforeCatchUpRef: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))?.phase).toBe('ref')
    const result = e.wf.state(a).integrated!.result
    const before = sh(e.project, 'rev-parse', `${result}^1`)
    expect(head(e.project)).toBe(before)
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    sh(other, 'reset', '-q', '--hard', before)
    sh(other, 'push', '-q', '-f', 'origin', 'main')
    const b = await queued(e, 'B', 'b.txt')
    await restarted(e, transport).drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(contains(e.project, result)).toBe(false)
    expect(existsSync(join(e.project, 'a.txt'))).toBe(false)
    expect(e.store.queuePause('main')).toBeNull()
    expect(e.wf.state(b).stage).toBe('done')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toMatchObject({ target: 'main' })
  })

  it('HI-3041 (HR2): an owed catch-up behind the result whose remote can’t be read: nothing moved, still owed; read again, gone: ended, never brought in', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    const result = e.wf.state(a).integrated!.result
    const before = sh(e.project, 'rev-parse', `${result}^1`)
    const other = join(tempDir('other-'), 'clone')
    execFileSync('git', ['clone', '-q', bare, other])
    sh(other, 'reset', '-q', '--hard', before)
    sh(other, 'push', '-q', '-f', 'origin', 'main')
    del(join(e.project, 'a.txt'))
    // The remote unreachable for a while (its address points nowhere).
    sh(e.project, 'remote', 'set-url', 'origin', slash(join(tempDir('gone-'), 'nowhere.git')))
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    expect(head(e.project)).toBe(before)
    expect(existsSync(join(e.project, 'a.txt'))).toBe(false)
    // Reachable again: the result is gone from it, so the catch-up ends with nothing brought in.
    sh(e.project, 'remote', 'set-url', 'origin', bare)
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(contains(e.project, result)).toBe(false)
    expect(existsSync(join(e.project, 'a.txt'))).toBe(false)
  })

  it('HI-3055: a journalled catch-up (phase ref) whose remote read fails holds the next card, its journal kept and paused fetchFailed; read again, finished, then the next card', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, transport, queue } = following({}, { checkedOut: true })
    const a = await queued(e, 'A', 'a.txt')
    await expect(queue({ hooks: { beforeCatchUpRef: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    const journal = catchUpOf(e.store.meta(catchUpKey('main')))
    expect(journal?.phase).toBe('ref')
    const b = await queued(e, 'B', 'b.txt')
    let first = true
    const git = gitWith(async (args, run) => {
      if (first && args[0] === 'fetch') {
        first = false
        return { ok: false, code: 128, out: '', err: 'temporary remote read failure' }
      }
      return run()
    })
    const out = await restarted(e, transport, { git }).drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toEqual(journal)
    expect(out.at(-1)).toMatchObject({ card: a.key, outcome: 'paused', reason: 'fetchFailed' })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'fetchFailed', card: a.key, message: expect.stringContaining('temporary remote read failure') })
    expect(e.wf.state(b).stage).not.toBe('done')
    expect(head(bare)).toBe(e.wf.state(a).integrated!.result)
    // Resumed, the remote read: A's journal finishes its ref, then B is merged and caught up.
    queue().resume('main')
    await queue().drain('main')
    expect(e.wf.state(b).stage).toBe('done')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(head(e.project)).toBe(head(bare))
    expect(contains(e.project, e.wf.state(a).integrated!.result)).toBe(true)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  /** A published, Done; Combwork stopped inside its catch-up into the checked-out main at `at` (journalled). */
  async function stoppedIn(at: 'beforeCatchUpRef' | 'beforeCatchUpFiles', more: Record<string, string> = {}) {
    const f = following({}, { checkedOut: true })
    const a = await queued(f.e, 'A', 'a.txt', 'A\n', more)
    await expect(f.queue({ hooks: { [at]: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(f.e.wf.state(a).stage).toBe('done')
    expect(catchUpOf(f.e.store.meta(catchUpKey('main')))?.phase).toBe(at === 'beforeCatchUpRef' ? 'ref' : 'files')
    return { ...f, a }
  }

  for (const [how, tidy] of [
    ['git reset --hard', (p: string) => void sh(p, 'reset', '-q', '--hard')],
    ['git stash -u', (p: string) => void sh(p, 'stash', 'push', '-q', '-u')]
  ] as const) {
    it(`HI-3090: stopped between its files and its ref, the user tidies the folder (${how}): run again, caught up, never stuck`, { timeout: GIT_HEAVY_MS * 2 }, async () => {
      const { e, bare, transport, a } = await stoppedIn('beforeCatchUpRef')
      expect(sh(e.project, 'status', '--porcelain')).toBe('A  a.txt')
      tidy(e.project)
      expect(sh(e.project, 'status', '--porcelain')).toBe('')
      await restarted(e, transport).drain('main')
      expect(e.store.queuePause('main')).toBeNull()
      expect(e.wf.state(e.store.card(a.id)).requests.some((r) => r.gate === QUEUE_STUCK_GATE)).toBe(false)
      expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
      expect(head(e.project)).toBe(head(bare))
      expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
      expect(sh(e.project, 'status', '--porcelain')).toBe('')
    })
  }

  it('HI-3090: stopped before its files moved, the user switches the folder to another branch: run again, main brought there (not checked out), the folder untouched', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, transport } = await stoppedIn('beforeCatchUpFiles')
    sh(e.project, 'switch', '-q', '-c', 'mine')
    await restarted(e, transport).drain('main')
    expect(e.store.queuePause('main')).toBeNull()
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(head(e.project)).toBe(head(bare))
    expect(sh(e.project, 'branch', '--show-current')).toBe('mine')
    expect(existsSync(join(e.project, 'a.txt'))).toBe(false)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('HI-3090: stopped between its files and its ref, the user commits what it staged: never rolled back under that commit; still owed, paused remoteDiverged', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, transport, a } = await stoppedIn('beforeCatchUpRef')
    sh(e.project, 'commit', '-q', '-m', 'whatever this was')
    const mine = head(e.project)
    await restarted(e, transport).drain('main')
    expect(head(e.project)).toBe(mine)
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'remoteDiverged', card: a.key })
    const owed = catchUpOf(e.store.meta(catchUpKey('main')))
    expect(owed).toMatchObject({ card: a.key })
    expect(owed?.phase).toBeUndefined()
  })

  it('HI-3090 (HR2): a published merge that changes no file, stopped inside its catch-up, the folder then switched to another branch: run again, main brought there, never stuck', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    // A result that changes no file in the local target (a forward merge after a release, say) journals `files: []`. A
    // card can't be published with no change of its own here (its submission is refused, and one already on the target
    // is integrated outside), so the stop is a real one before its files moved, and its journal is the one Combwork
    // writes for such a result: its list empty.
    const { e, bare, transport } = await stoppedIn('beforeCatchUpFiles')
    const journal = catchUpOf(e.store.meta(catchUpKey('main')))!
    e.store.setMeta(catchUpKey('main'), JSON.stringify({ ...journal, files: [] }))
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ phase: 'files', files: [] })
    sh(e.project, 'switch', '-q', '-c', 'mine')
    await restarted(e, transport).drain('main')
    expect(e.store.queuePause('main')).toBeNull()
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(head(e.project)).toBe(head(bare))
    expect(sh(e.project, 'branch', '--show-current')).toBe('mine')
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
  })

  it('HI-3090 (HR1): stopped between its files and its ref, the user commits only one of the two files it staged: the committed one never rolled back; the other kept staged; paused remoteDiverged', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, transport, a } = await stoppedIn('beforeCatchUpRef', { 'b.txt': 'B\n' })
    expect(sh(e.project, 'status', '--porcelain')).toBe('A  a.txt\nA  b.txt')
    sh(e.project, 'commit', '-q', '--only', '-m', 'mine', '--', 'a.txt')
    const mine = head(e.project)
    expect(sh(e.project, 'status', '--porcelain')).toBe('A  b.txt')
    await restarted(e, transport).drain('main')
    expect(head(e.project)).toBe(mine)
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(e.project, 'b.txt'), 'utf8')).toBe('B\n')
    // No staged deletion of the user's committed a.txt; b.txt left staged at the result, as it was.
    expect(sh(e.project, 'status', '--porcelain')).toBe('A  b.txt')
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'remoteDiverged', card: a.key })
    expect(catchUpOf(e.store.meta(catchUpKey('main')))?.phase).toBeUndefined()
  })

  it('HI-3089: Resume of a catch-up whose remote can’t be read, nothing else queued: still paused (fetchFailed, git’s words), never cleared silently; read again, caught up', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    del(join(e.project, 'a.txt'))
    sh(e.project, 'remote', 'set-url', 'origin', slash(join(tempDir('gone-'), 'nowhere.git')))
    queue().resume('main')
    expect((await queue().drain('main')).at(-1)).toMatchObject({ card: a.key, outcome: 'paused', reason: 'fetchFailed' })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'fetchFailed', card: a.key, message: expect.stringMatching(/nowhere\.git/) })
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    expect(head(e.project)).not.toBe(head(bare))
    sh(e.project, 'remote', 'set-url', 'origin', bare)
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
    expect(head(e.project)).toBe(head(bare))
  })

  it('HI-3055: an owed catch-up behind the result whose remote can’t be read holds the next card (fetchFailed); read again, caught up, then the next card', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { e, bare, queue, a } = await caughtOnAFile()
    del(join(e.project, 'a.txt'))
    const b = await queued(e, 'B', 'b.txt')
    sh(e.project, 'remote', 'set-url', 'origin', slash(join(tempDir('gone-'), 'nowhere.git')))
    queue().resume('main')
    await queue().drain('main')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'fetchFailed', card: a.key })
    expect(e.wf.state(b).stage).not.toBe('done')
    sh(e.project, 'remote', 'set-url', 'origin', bare)
    queue().resume('main')
    await queue().drain('main')
    expect(e.wf.state(b).stage).toBe('done')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(head(e.project)).toBe(head(bare))
    expect(contains(e.project, e.wf.state(a).integrated!.result)).toBe(true)
  })

  it('HI-3041 (2b): a published merge undone on the remote and locally is marked as having left, as with a push; on the remote still, behind is not left', { timeout: GIT_HEAVY_MS * 2 }, async () => {
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    const marks: Record<string, unknown> = {}
    for (const follow of [true, false]) {
      env?.close()
      env = null
      const { e, bare, queue } = following({ followRemote: follow, pushTarget: !follow })
      const a = await queued(e, 'A', 'a.txt')
      expect((await queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
      expect(head(bare)).toBe(head(e.project))
      const before = sh(e.project, 'rev-parse', `${e.wf.state(a).integrated!.result}^1`)
      // Behind locally only: the remote still has it, so not left (HI-2988).
      sh(e.project, 'update-ref', 'refs/heads/main', before)
      await reconcile(e.wf, e.store.card(a.id))
      if (follow) expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
      // Undone on the remote too.
      const other = join(tempDir('other-'), 'clone')
      execFileSync('git', ['clone', '-q', bare, other])
      sh(other, 'reset', '-q', '--hard', before)
      sh(other, 'push', '-q', '-f', 'origin', 'main')
      // A pass over a minute later (the remote's head is kept a minute per repository and target): only Date is faked.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 61_000)
        await reconcile(e.wf, e.store.card(a.id))
      } finally {
        vi.useRealTimers()
      }
      marks[follow ? 'follow' : 'push'] = e.wf.state(a).marks.leftTarget ?? null
    }
    expect(marks.push).toMatchObject({ target: 'main' })
    expect(marks.follow).toMatchObject({ target: 'main' })
  })

  it('HI-3041 (3a): left its target, then merged back by hand (a new merge of its revision): the mark cleared', { timeout: GIT_HEAVY_MS }, async () => {
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [] }))
    sh(e.project, 'checkout', '-q', '--detach')
    const before = head(e.project)
    const a = await queued(e, 'A', 'a.txt')
    expect((await e.queue().drain('main')).map((o) => o.outcome)).toEqual(['integrated'])
    const i = e.wf.state(a).integrated!
    sh(e.project, 'update-ref', 'refs/heads/main', before)
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeDefined()
    sh(e.project, 'checkout', '-q', 'main')
    sh(e.project, 'merge', '-q', '--no-ff', '--no-edit', i.revision)
    sh(e.project, 'checkout', '-q', '--detach')
    expect(contains(e.project, i.result)).toBe(false)
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
    expect(e.kinds(a.id).filter((k) => k === 'LeftTarget' || k === 'BackInTarget')).toEqual(['LeftTarget', 'BackInTarget'])
    // Again: a second pass writes nothing more.
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.kinds(a.id).filter((k) => k === 'BackInTarget')).toHaveLength(1)
  })

  it('HI-3041: while the remote still has the result, a local commit of the user’s still pauses remoteDiverged (the remote looked at, not trusted away)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, queue, a } = await caughtOnAFile()
    del(join(e.project, 'a.txt'))
    commit(e.project, { 'mine.txt': 'mine\n' }, 'mine')
    queue().resume('main')
    expect(await queue().drain('main')).toMatchObject([{ card: a.key, outcome: 'paused', reason: 'remoteDiverged' }])
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
  })

  /** A published, Done; Combwork stopped (a crash, a lost lease) after journalling its catch-up's plan, before moving files. */
  async function stoppedBeforeItsFiles() {
    const f = following({}, { checkedOut: true })
    const a = await queued(f.e, 'A', 'a.txt')
    await expect(f.queue({ hooks: { beforeCatchUpFiles: () => Promise.reject(new Error('crash')) } }).drain('main')).rejects.toThrow('crash')
    expect(f.e.wf.state(a).stage).toBe('done')
    expect(catchUpOf(f.e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key, phase: 'files' })
    return { ...f, a, result: f.e.wf.state(a).integrated!.result }
  }

  it('HI-3039: a journalled catch-up after the user pulled past it: settled, the clean folder left as it is', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, bare, transport, result } = await stoppedBeforeItsFiles()
    // A teammate pushes on top of the published merge; the user pulls it (a fast-forward).
    const top = theirs(bare)
    sh(e.project, 'pull', '-q', '--ff-only', 'origin', 'main')
    expect(head(e.project)).toBe(top)
    expect(contains(e.project, result)).toBe(true)
    expect(await restarted(e, transport).drain('main')).toEqual([])
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
    expect(head(e.project)).toBe(top)
    expect(readFileSync(join(e.project, 'a.txt'), 'utf8')).toBe('A\n')
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
    expect(e.store.queuePause('main')).toBeNull()
  })

  it('HI-3039: a journalled catch-up after the user committed on the local target: still owed, paused remoteDiverged, never LeftTarget', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, transport, a, result } = await stoppedBeforeItsFiles()
    commit(e.project, { 'mine.txt': 'mine\n' }, 'mine')
    const q = restarted(e, transport)
    expect(await q.drain('main')).toMatchObject([{ card: a.key, outcome: 'paused', reason: 'remoteDiverged', files: ['main'] }])
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toMatchObject({ card: a.key })
    expect(catchUpOf(e.store.meta(catchUpKey('main')))?.phase).toBeUndefined()
    expect(contains(e.project, result)).toBe(false)
    expect(sh(e.project, 'status', '--porcelain')).toBe('')
    const { reconcile } = await import('../../src/main/workflow/reconcile')
    await reconcile(e.wf, e.store.card(a.id))
    expect(e.wf.state(a).marks.leftTarget).toBeUndefined()
    // Put right (the user's commit taken off): caught up.
    sh(e.project, 'reset', '-q', '--hard', 'HEAD~1')
    q.resume('main')
    await q.drain('main')
    expect(contains(e.project, result)).toBe(true)
    expect(catchUpOf(e.store.meta(catchUpKey('main')))).toBeNull()
  })
})
