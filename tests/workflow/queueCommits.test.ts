// Hive's queue commits (#1350, SPEC §16.9.1 step 4, S47): the project's identity (else a pause naming the folder), the
// repository's hooks (one that fails returns the card with its output), signing that never waits on a prompt (a signer
// waiting is ended within the bound and the queue pauses, the worktree clean), any other git failure a pause with git's
// message, and the trailers in a squash's commit. Pauses are never failures: only a hook returns the card.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { git } from '../../src/main/git'
import { commitFailed, readCommitTrace, type QueueGitResult } from '../../src/main/workflow/mergeQueue'
import { tempDir } from '../tempDir'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (o: Partial<WorkflowOptions> = {}): Env => (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], okBefore: { mode: 'never', labels: [] }, ...o }))

/** A card approved and queued for main, checked out nowhere (the project folder detached). */
async function queued(e: Env, title = 'Change') {
  sh(e.project, 'checkout', '-q', '--detach')
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { 'src/c.txt': `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return card
}

const head = (e: Env): string => sh(e.project, 'rev-parse', 'main')
const queueFolder = (e: Env): string => join(e.home, 'queue')
/** A shell script (git runs hooks and a `gpg.program` script with its sh), LF only. */
const script = (file: string, body: string): string => (writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }), file)
const hook = (e: Env, name: string, body: string): string => script(join(e.project, '.git', 'hooks', name), body)
/** The queue's worktree clean, at the target's head: nothing of a failed merge left (no MERGE_HEAD, no index.lock). */
function cleanAt(e: Env, rev: string): void {
  const f = queueFolder(e)
  expect(sh(f, 'status', '--porcelain', '--untracked-files=all')).toBe('')
  expect(sh(f, 'rev-parse', 'HEAD')).toBe(rev)
  expect(existsSync(sh(f, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'))).toBe(false)
  expect(existsSync(sh(f, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'))).toBe(false)
}
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("Hive's queue commits (#1350)", () => {
  it('no commit identity for the repository: paused identity, naming the folder; not returned, nothing merged', async () => {
    const e = team()
    const card = await queued(e)
    sh(e.project, 'config', '--unset', 'user.name')
    sh(e.project, 'config', '--unset', 'user.email')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'paused', reason: 'identity', files: [e.project] }])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'identity', files: [e.project] })
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
    expect(e.wf.state(card).stage).toBe('merging')
  })

  it("G12's identity when on: Hive's merge is authored and committed with it", async () => {
    const e = team()
    await queued(e)
    // Turned on once the card is approved (its own commits are checked against G12 at submit: not this test's).
    e.options.identity = { name: 'Project Bot', email: 'bot@hive.invalid' }
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(sh(e.project, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', 'main')).toBe('Project Bot <bot@hive.invalid> / Project Bot <bot@hive.invalid>')
  })

  it("a commit-msg hook exiting 1 returns the card with the hook's output (IntegrationFailed, hook); the hooks ran", async () => {
    const e = team()
    const card = await queued(e)
    hook(e, 'commit-msg', 'echo "message rejected by policy" >&2\nexit 1')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'returned', reason: 'hook', transient: false }])
    const failed = e.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').at(-1)!
    expect(failed.data).toMatchObject({ reason: 'hook', log: expect.stringContaining('message rejected by policy') })
    expect(e.wf.state(card).stage).toBe('active')
    expect(head(e)).toBe(before)
    expect(e.store.queuePause('main')).toBeNull()
    cleanAt(e, before)
  })

  it('HR4 r1: a hook is told by git\'s trace, not its words — signed, a commit-msg hook saying "passphrase" returns the card', async () => {
    const e = team()
    const card = await queued(e)
    sh(e.project, 'config', 'commit.gpgsign', 'true')
    sh(e.project, 'config', 'gpg.program', script(join(e.home, 'gpg-fails.sh'), 'exit 2').replace(/\\/g, '/'))
    hook(e, 'commit-msg', 'echo "passphrase policy rejected this message" >&2\nexit 1')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'returned', reason: 'hook' }])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').at(-1)!.data).toMatchObject({ reason: 'hook', log: expect.stringContaining('passphrase policy rejected this message') })
    expect(e.store.queuePause('main')).toBeNull()
    cleanAt(e, before)
  })

  it('HR4 r1: squash, a pre-commit hook printing a "fatal:" line of its own returns the card', async () => {
    const e = team({ style: 'squash' })
    const card = await queued(e)
    hook(e, 'pre-commit', 'echo "fatal: policy rejected src/c.txt" >&2\nexit 1')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'returned', reason: 'hook' }])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').at(-1)!.data).toMatchObject({ log: expect.stringContaining('fatal: policy rejected src/c.txt') })
    expect(e.store.queuePause('main')).toBeNull()
    cleanAt(e, before)
  })

  it('signed, a hook still running at the bound: ended with the tree, paused hookTimedOut (not signing), the worktree clean', async () => {
    const e = team()
    const card = await queued(e)
    const pidFile = join(e.home, 'hook.pid')
    const waiter = join(e.home, 'hook-wait.js')
    writeFileSync(waiter, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
    sh(e.project, 'config', 'commit.gpgsign', 'true')
    hook(e, 'pre-merge-commit', `exec node "${waiter.replace(/\\/g, '/')}"`)
    const before = head(e)
    expect(await e.queue({ signTimeoutMs: 3000 }).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'hookTimedOut' }])
    expect(running(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
    expect(head(e)).toBe(before)
    cleanAt(e, before)
  })

  it("squash: a pre-commit hook that fails returns the card with its output; one that passes, and the trailers are in the squash's commit", async () => {
    const e = team({ style: 'squash' })
    const card = await queued(e, 'Squashed')
    hook(e, 'pre-commit', 'echo "lint failed in src/c.txt"\nexit 1')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'returned', reason: 'hook' }])
    expect(e.store.facts(card.id).filter((f) => f.kind === 'IntegrationFailed').at(-1)!.data).toMatchObject({ log: expect.stringContaining('lint failed in src/c.txt') })
    cleanAt(e, before)

    // Another card, the hook passing: one squashed commit, its trailers in it.
    hook(e, 'pre-commit', 'exit 0')
    const next = await queued(e, 'Squashed again')
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(sh(e.project, 'rev-list', '--parents', '-1', 'main').split(' ')).toEqual([expect.any(String), before])
    const body = sh(e.project, 'log', '-1', '--format=%B', 'main')
    expect(body).toContain(`${next.key}: Squashed again`)
    expect(body).toContain(`Hive-Card: ${next.key}`)
    expect(body).toMatch(/^Hive-Revision: [0-9a-f]{40}$/m)
    expect(body).toContain('Hive-Reviewed-By: ')
  })

  it('signing that waits for a passphrase: ended within the bound, paused "signing waits for you", the worktree clean, the target unchanged', async () => {
    const e = team()
    const card = await queued(e)
    // A stand-in signer that waits as a pinentry would: a Node process (its Windows pid recorded) that never answers.
    const pidFile = join(e.home, 'signer.pid')
    const waiter = join(e.home, 'wait.js')
    writeFileSync(waiter, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`)
    const gpg = script(join(e.home, 'gpg-waits.sh'), `exec node "${waiter.replace(/\\/g, '/')}"`)
    sh(e.project, 'config', 'commit.gpgsign', 'true')
    sh(e.project, 'config', 'gpg.program', gpg.replace(/\\/g, '/'))
    const before = head(e)
    const t0 = Date.now()
    const [o] = await e.queue({ signTimeoutMs: 3000 }).drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'signingWaits' })
    // Within the bound (and what ending the tree takes), not the test's.
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'signingWaits', card: card.key })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(running(pid)).toBe(false)
    expect(head(e)).toBe(before)
    expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
    cleanAt(e, before)
  })

  it("a signer that fails pauses with git's message; one saying it needs a passphrase pauses signing waits", async () => {
    const e = team()
    const card = await queued(e)
    sh(e.project, 'config', 'commit.gpgsign', 'true')
    sh(e.project, 'config', 'gpg.program', script(join(e.home, 'gpg-fails.sh'), 'echo "gpg: signing failed: No secret key" >&2\nexit 2').replace(/\\/g, '/'))
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'paused', reason: 'signing', message: expect.stringContaining('No secret key') }])
    expect(e.store.queuePause('main')).toMatchObject({ reason: 'signing', message: expect.stringContaining('gpg failed to sign the data') })
    expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
    cleanAt(e, before)

    e.store.setQueuePause('main', null)
    sh(e.project, 'config', 'gpg.program', script(join(e.home, 'gpg-pass.sh'), 'echo "gpg: signing failed: Inappropriate ioctl for device" >&2\nexit 2').replace(/\\/g, '/'))
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'paused', reason: 'signingWaits' }])
    expect(head(e)).toBe(before)
  })

  it("an index lock while the merge commits: paused needsYou with git's message, not returned as a hook", async () => {
    const e = team()
    const card = await queued(e)
    const before = head(e)
    let lock = ''
    const q = e.queue({
      git: async (cwd, args, opts) => {
        // Just before the test merge, another git holds the queue worktree's index.
        if (args.includes('merge') && !args.includes('--abort') && !lock) {
          lock = sh(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock')
          writeFileSync(lock, '')
        } else if (args.includes('--abort') && lock) {
          // The other git finished: its lock gone, so the queue's clean-up can run.
          ;(await import('fs')).rmSync(lock)
        }
        return git(cwd, args, undefined, undefined, opts)
      }
    })
    const [o] = await q.drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'needsYou', message: expect.stringMatching(/index/i) })
    expect(e.kinds(card.id)).not.toContain('IntegrationFailed')
    expect(e.wf.state(card).stage).toBe('merging')
    expect(head(e)).toBe(before)
    cleanAt(e, before)
  })
})

describe("a commit's trace (#1350)", () => {
  it("counts only the top git's children: a git a hook ran, whose own hook failed, isn't the commit's hook", () => {
    const file = join(tempDir('trace-'), 'trace.json')
    const ev = (o: object): string => JSON.stringify(o)
    writeFileSync(
      file,
      [
        ev({ event: 'version', sid: 'T1' }),
        ev({ event: 'child_start', sid: 'T1', child_id: 0, child_class: 'hook', hook_name: 'pre-commit', argv: ['.git/hooks/pre-commit'] }),
        ev({ event: 'child_start', sid: 'T1/N1', child_id: 0, child_class: 'hook', hook_name: 'commit-msg', argv: ['x'] }),
        ev({ event: 'child_exit', sid: 'T1/N1', child_id: 0, code: 1 }),
        ev({ event: 'child_exit', sid: 'T1', child_id: 0, code: 0 }),
        ev({ event: 'child_start', sid: 'T1', child_id: 1, child_class: '?', argv: ['gpg', '--status-fd=2', '-bsau', 'me'] }),
        ev({ event: 'child_exit', sid: 'T1', child_id: 1, code: 2 }),
        'not json'
      ].join('\n')
    )
    expect(readCommitTrace(file)).toEqual({ signerFailed: true, signerRunning: false })
    expect(readCommitTrace(join(tempDir('trace-'), 'none.json'))).toBeNull()
  })

  it('classifies by the child that failed: a hook over its words, a signer, a hook or signer at the bound, and git itself', () => {
    const r = (err: string, more: Partial<QueueGitResult> = {}): QueueGitResult => ({ ok: false, out: '', err, code: 1, ...more })
    const none = { signerFailed: false, signerRunning: false }
    expect(commitFailed(r('fatal: passphrase needed'), { ...none, hookFailed: 'pre-commit' }, true)).toMatchObject({ fail: 'hook' })
    expect(commitFailed(r('gpg: signing failed: No pinentry'), { ...none, signerFailed: true }, true)).toMatchObject({ pause: 'signingWaits' })
    expect(commitFailed(r('gpg: signing failed: No secret key'), { ...none, signerFailed: true }, true)).toMatchObject({ pause: 'signing' })
    expect(commitFailed(r('', { timedOut: true }), { ...none, hookRunning: 'pre-commit' }, true)).toMatchObject({ pause: 'hookTimedOut' })
    expect(commitFailed(r('', { timedOut: true }), { ...none, signerRunning: true }, true)).toMatchObject({ pause: 'signingWaits' })
    expect(commitFailed(r('passphrase policy: Not committing merge; nope'), none, true)).toMatchObject({ pause: 'needsYou' })
    expect(commitFailed(r("Not committing merge; use 'git commit' to complete the merge."), null, false)).toMatchObject({ fail: 'hook' })
  })
})
