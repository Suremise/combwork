// G21 (HI-1183, SPEC §16.9.4): the merge queue's target follows its remote. On real temporary repositories, each with
// a bare repository of its own as the remote (never a real remote): the fetch before each test merge, the publication as
// an exact compare-and-swap at the remote, the sealed transport, unknown publications, and the local target's catch-up.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
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
import { QUEUE_PUBLISH_GATE } from '../../src/shared/workflow/facts'

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

async function queued(e: Env, title: string, file: string, text = `${title}\n`) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: text }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

const head = (repo: string, ref = 'main'): string => sh(repo, 'rev-parse', ref)
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
    expect((await queue({ git }).drain('main')).map((o) => o.outcome)).toContain('integrated')
    expect(pushes).toBe(1)
    expect(e.wf.state(a).stage).toBe('done')
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
