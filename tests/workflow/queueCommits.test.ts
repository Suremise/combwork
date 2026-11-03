// Hive's queue commits (#1350, SPEC §16.9.1 step 4, S47): the project's identity (else a pause naming the folder), the
// repository's hooks (one that fails returns the card with its output), signing that never waits on a prompt (a signer
// waiting is ended within the bound and the queue pauses, the worktree clean), any other git failure a pause with git's
// message, and the trailers in a squash's commit. Pauses are never failures: only a hook returns the card.
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { git } from '../../src/main/git'
import { commitFailed, readCommitStream, type QueueGitResult } from '../../src/main/workflow/mergeQueue'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (o: Partial<WorkflowOptions> = {}): Env => (env = setup({ ...preset('git', 'team', { quick: [], tests: [] }), preChecks: [], mergeChecks: [], commitMessage: 'hive', okBefore: { mode: 'never', labels: [] }, ...o }))

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

  it("HI-2266: G12 on, git config changed after it was turned on: Hive's merge is authored and committed as git's identity now, never G12's saved copy", async () => {
    const e = team()
    await queued(e)
    // Turned on once the card is approved (its own commits are checked against G12 at submit: not this test's), saving
    // the identity of then; the Git tab (or git config) then corrects it.
    e.options.identity = { name: 'Old Typo', email: 'typo@hive.invalid' }
    sh(e.project, 'config', 'user.name', 'Project Bot')
    sh(e.project, 'config', 'user.email', 'bot@hive.invalid')
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'integrated' }])
    expect(sh(e.project, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', 'main')).toBe('Project Bot <bot@hive.invalid> / Project Bot <bot@hive.invalid>')
  })

  it('HI-2266: G12 on with a saved copy, git with no identity: paused identity, the saved copy never used', async () => {
    const e = team()
    const card = await queued(e)
    e.options.identity = { name: 'Old Typo', email: 'typo@hive.invalid' }
    sh(e.project, 'config', '--unset', 'user.name')
    sh(e.project, 'config', '--unset', 'user.email')
    const before = head(e)
    expect(await e.queue().drain('main')).toMatchObject([{ outcome: 'paused', reason: 'identity', files: [e.project] }])
    expect(head(e)).toBe(before)
    expect(e.wf.state(card).stage).toBe('merging')
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

  it('HR4 r2: a commit-msg hook that passes saying "passphrase", then a signer with no secret key: paused signing, not signing waits', async () => {
    const e = team()
    await queued(e)
    sh(e.project, 'config', 'commit.gpgsign', 'true')
    sh(e.project, 'config', 'gpg.program', script(join(e.home, 'gpg-nokey.sh'), 'echo "gpg: signing failed: No secret key" >&2\nexit 2').replace(/\\/g, '/'))
    hook(e, 'commit-msg', 'echo "passphrase policy validation passed" >&2\nexit 0')
    const before = head(e)
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ outcome: 'paused', reason: 'signing', message: expect.stringContaining('No secret key') })
    expect(o.outcome === 'paused' && o.message).not.toContain('passphrase policy')
    expect(o.outcome === 'paused' && o.message).not.toContain('{"event"')
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

  // GIT_HEAVY_MS: a squash merge through the queue twice (the hook failing, then passing), 92 git processes; past 20 s in
  // HI-2025's run beside three other full runs, and on HI-2001's loaded runs.
  it("squash: a pre-commit hook that fails returns the card with its output; one that passes, and the trailers are in the squash's commit", { timeout: GIT_HEAVY_MS }, async () => {
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

describe("a commit's stream, git's trace in it (#1350)", () => {
  // Real git 2.45 stderr (GIT_TRACE2_EVENT=2) of a failing merge commit, recorded with its paths replaced
  // (tests/fixtures/queueCommits: how each was made is in its README).
  // git wrote them with LF; a checkout may give them CRLF (core.autocrlf).
  const stream = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'queueCommits', `${name}.txt`), 'utf8').replace(/\r\n/g, '\n')
  const failed = (err: string, more: Partial<QueueGitResult> = {}): QueueGitResult => ({ ok: false, out: '', err, code: 128, ...more })
  const noEvents = (s: string): boolean => !/\{"event":"/.test(s)

  it("HR4 r2: a hook that passed saying \"passphrase\" never changes the signer's diagnosis: signing, with the signer's own words", () => {
    const s = readCommitStream(stream('passing-hook-then-signer'))
    expect(s.traced).toBe(true)
    expect(s.children.filter((c) => c.kind !== 'other')).toEqual([
      { kind: 'hook', name: 'commit-msg', code: 0, text: 'passphrase policy validation passed\n', after: '' },
      { kind: 'signer', code: 2, text: 'gpg: signing failed: No secret key\n', after: 'error: gpg failed to sign the data\nfatal: failed to write commit object\n' }
    ])
    expect(s.git).toContain('error: gpg failed to sign the data')
    const o = commitFailed(failed(stream('passing-hook-then-signer')), true)
    expect(o).toMatchObject({ pause: 'signing' })
    expect('message' in o && o.message).toBe('gpg: signing failed: No secret key\nerror: gpg failed to sign the data\nfatal: failed to write commit object')
  })

  it("HI-2399: a newer git reprints the signer's text after it exits (`gpg failed to sign the data:`): read as the signer's, never a hook's", () => {
    // As a newer git (Git for Windows 2.56) writes it (gpg-interface.c sign_buffer_gpg): the signer run with --status-fd=2, its stderr captured,
    // nothing of it written while it runs, then git's error with it once it has exited.
    const ev = ({ event, ...rest }: { event: string } & Record<string, unknown>): string => JSON.stringify({ event, sid: 'T', time: 't', ...rest })
    const newer = (hookSays: string, gpgSays: string): string =>
      [
        ev({ event: 'version' }),
        ev({ event: 'child_start', child_id: 1, child_class: 'hook', hook_name: 'commit-msg', argv: ['.git/hooks/commit-msg'] }),
        hookSays,
        ev({ event: 'child_exit', child_id: 1, code: 0 }),
        ev({ event: 'child_start', child_id: 2, argv: ['gpg', '--status-fd=2', '-bsau', 'me'] }),
        ev({ event: 'child_exit', child_id: 2, code: 2 }),
        `error: gpg failed to sign the data:\n${gpgSays}`,
        'fatal: failed to write commit object'
      ].join('\n') + '\n'
    const waits = newer('No secret key needed for this message', 'gpg: signing failed: Inappropriate ioctl for device')
    const signer = readCommitStream(waits).children.find((c) => c.kind === 'signer')
    expect(signer).toMatchObject({ code: 2, text: '', after: 'error: gpg failed to sign the data:\ngpg: signing failed: Inappropriate ioctl for device\nfatal: failed to write commit object\n' })
    expect(commitFailed(failed(waits), true)).toMatchObject({ pause: 'signingWaits', message: expect.stringContaining('Inappropriate ioctl for device') })
    // A hook that passed saying "passphrase" never makes a signer with no secret key wait.
    const fails = newer('passphrase policy validation passed', 'gpg: signing failed: No secret key')
    const o = commitFailed(failed(fails), true)
    expect(o).toMatchObject({ pause: 'signing' })
    expect('message' in o && o.message).toBe('error: gpg failed to sign the data:\ngpg: signing failed: No secret key\nfatal: failed to write commit object')
    // git's text after a hook that passed, before the signer starts, is never the signer's.
    const before = [ev({ event: 'version' }), ev({ event: 'child_start', child_id: 1, child_class: 'hook', hook_name: 'commit-msg', argv: ['h'] }), ev({ event: 'child_exit', child_id: 1, code: 0 }), 'hint: pinentry'].join('\n') + '\n'
    const after = [ev({ event: 'child_start', child_id: 2, argv: ['gpg', '--status-fd=2', '-bsau', 'me'] }), ev({ event: 'child_exit', child_id: 2, code: 2 }), 'error: gpg failed to sign the data:\ngpg: signing failed: No secret key'].join('\n') + '\n'
    expect(commitFailed(failed(before + after), true)).toMatchObject({ pause: 'signing' })
  })

  it('the reverse: a hook that passed saying "No secret key", and a signer that needs a terminal → signing waits', () => {
    expect(commitFailed(failed(stream('passing-hook-then-signer-waits')), true)).toMatchObject({ pause: 'signingWaits', message: expect.stringContaining('Inappropriate ioctl for device') })
  })

  it('HI-2399: recorded with git 2.56, where git reprints the signer\'s text after it exits: the same diagnoses as 2.45\'s', () => {
    const s = readCommitStream(stream('passing-hook-then-signer-2.56'))
    expect(s.children.filter((c) => c.kind !== 'other')).toEqual([
      { kind: 'hook', name: 'commit-msg', code: 0, text: 'passphrase policy validation passed\n', after: '' },
      { kind: 'signer', code: 2, text: '', after: 'error: gpg failed to sign the data:\ngpg: signing failed: No secret key\n\nfatal: failed to write commit object\n' }
    ])
    const o = commitFailed(failed(stream('passing-hook-then-signer-2.56')), true)
    expect(o).toMatchObject({ pause: 'signing' })
    expect('message' in o && o.message).toBe('error: gpg failed to sign the data:\ngpg: signing failed: No secret key\n\nfatal: failed to write commit object')
    expect(commitFailed(failed(stream('passing-hook-then-signer-waits-2.56')), true)).toMatchObject({ pause: 'signingWaits', message: expect.stringContaining('Inappropriate ioctl for device') })
  })

  it("a failing hook whose last line has no newline, an event-looking fragment before git's own event: returned with its text intact, no event in it", () => {
    const err = stream('failing-hook-no-newline')
    const s = readCommitStream(err)
    const failing = s.children.find((c) => c.kind === 'hook')!
    expect(failing).toMatchObject({ name: 'commit-msg', code: 1 })
    expect(failing.text).toBe('message rejected: passphrase in it\n{"event": not one\n')
    const o = commitFailed(failed(err, { code: 1 }), false)
    expect(o).toMatchObject({ fail: 'hook' })
    expect('log' in o && o.log).toContain('{"event": not one')
    expect('log' in o && noEvents(o.log)).toBe(true)
  })

  it("a git a hook runs, whose own hook fails, isn't a source: the top git's hook passed and its signer decides", () => {
    const s = readCommitStream(stream('nested-git-hook'))
    expect(s.children.filter((c) => c.kind === 'hook')).toEqual([expect.objectContaining({ name: 'pre-merge-commit', code: 0 })])
    expect(commitFailed(failed(stream('nested-git-hook')), true)).toMatchObject({ pause: 'signing' })
  })

  it("#1397: a hook's own structured log, with a session of its own, stays in its text; the top git's and a nested git's records stay out", () => {
    const lines = stream('failing-hook-no-newline').split('\n')
    const top = (JSON.parse(lines[0]) as { sid: string }).sid
    const diag = '{"event":"validation","sid":"build-123","time":"2026-10-22T00:00:00Z","message":"policy rejected the change"}'
    // Not descendants either: a session named like the top git's but longer, and one under another root.
    const near = `{"event":"validation","sid":"${top}x/1","time":"t"}`
    const other = '{"event":"child_exit","sid":"build-123/7","time":"t","child_id":1,"code":0}'
    // The rejecting hook's lines: after its child_start (line 86, 0-based 85), before its child_exit.
    lines.splice(86, 0, diag, near, other)
    const err = lines.join('\n')
    const rejecting = readCommitStream(err).children.find((c) => c.kind === 'hook')!
    expect(rejecting).toMatchObject({ name: 'commit-msg', code: 1 })
    expect(rejecting.text).toBe(`${diag}\n${near}\n${other}\nmessage rejected: passphrase in it\n{"event": not one\n`)
    const o = commitFailed(failed(err, { code: 1 }), false)
    expect(o).toMatchObject({ fail: 'hook' })
    const log = 'log' in o ? o.log : ''
    expect(log).toContain('policy rejected the change')
    // git's own records, the top's and the nested git's (its sid `<top>/…`), none in the log.
    expect(log).not.toContain(`"sid":"${top}"`)
    expect(log).not.toContain(`"sid":"${top}/`)
  })

  it("#1397: with no trace (an old git), a hook's structured log is text, never taken for git's session", () => {
    // git's session starts with its `version` record; a hook's other records, with no parent's prefix, don't start one.
    const err = ['{"event":"start","sid":"hook-run","time":"t"}', '{"event":"child_start","sid":"hook-run","time":"t","child_id":1,"argv":["x"]}', "Not committing merge; use 'git commit' to complete the merge."].join('\n')
    const s = readCommitStream(err)
    expect(s.traced).toBe(false)
    expect(s.text).toBe(err)
    expect(commitFailed(failed(err), false)).toMatchObject({ fail: 'hook' })
  })

  it('only a complete record with its fields is an event: JSON-looking text a hook prints stays text', () => {
    const s = readCommitStream(['{"event":"child_exit","child_id":1}', '{"event":"start","sid":"S"', '{"event":"x","sid":"S","time":"t"}{"event":"y"}', 'plain'].join('\n'))
    expect(s.traced).toBe(false)
    expect(s.text).toBe('{"event":"child_exit","child_id":1}\n{"event":"start","sid":"S"\n{"event":"x","sid":"S","time":"t"}{"event":"y"}\nplain')
  })

  it('HR4 r2: ended at the bound, it is a pause decided by what ran then, even when ending it made the hook exit non-zero', () => {
    // As git writes them: `event` first.
    const ev = ({ event, ...rest }: { event: string } & Record<string, unknown>): string => JSON.stringify({ event, sid: 'T', time: 't', ...rest })
    const atTimeout = [ev({ event: 'version' }), ev({ event: 'child_start', child_id: 1, child_class: 'hook', hook_name: 'pre-merge-commit', argv: ['h'] }), 'linting…'].join('\n') + '\n'
    // What came after: the ended hook's non-zero exit, written by git before it was ended too.
    const err = atTimeout + ev({ event: 'child_exit', child_id: 1, code: 1 }) + '\n'
    expect(readCommitStream(err).children[0]).toMatchObject({ kind: 'hook', code: 1 })
    expect(commitFailed(failed(err, { timedOut: true, errAtTimeout: atTimeout }), true)).toMatchObject({ pause: 'hookTimedOut' })
    // The signer running then: signing waits, whatever followed.
    const signing = [ev({ event: 'version' }), ev({ event: 'child_start', child_id: 2, argv: ['gpg', '--status-fd=2', '-bsau', 'me'] })].join('\n') + '\n'
    expect(commitFailed(failed(signing + ev({ event: 'child_exit', child_id: 2, code: 1 }), { timedOut: true, errAtTimeout: signing }), false)).toMatchObject({ pause: 'signingWaits' })
    // Nothing known running then: signing waits in a repository that signs, else needs you; never a return.
    expect(commitFailed(failed('', { timedOut: true, errAtTimeout: '' }), true)).toMatchObject({ pause: 'signingWaits' })
    expect(commitFailed(failed('', { timedOut: true, errAtTimeout: '' }), false)).toMatchObject({ pause: 'needsYou' })
  })

  it("no trace (an old git): only git's own \"Not committing merge\" is a hook; anything else needs you, signing never read from text", () => {
    expect(commitFailed(failed("Not committing merge; use 'git commit' to complete the merge."), false)).toMatchObject({ fail: 'hook' })
    expect(commitFailed(failed('gpg: signing failed: No pinentry\nerror: gpg failed to sign the data'), true)).toMatchObject({ pause: 'needsYou' })
  })
})
