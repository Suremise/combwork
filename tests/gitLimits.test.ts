// HI-3372 (timing-margins audit, 18 Nov: the user's own git work): the settings that bound a commit or set aside,
// a fetch, pull or push, and the merge queue's network steps, their defaults and ranges; main's wiring of
// them into the ports' getters, each in its unit (a value of the test's own, not the default); the merge queue's own push
// reading it; the signer's bounds; and the user's Cancel's owner: only the window, workspace and project that started a
// run can cancel it, a duplicate id is refused, a run leaves the list however it ends.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { CandidateHost } from '../src/main/platform/integration'
import type { WorkspaceService } from '../src/main/workspace'

const base = tempDir('cw-gitlimits-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { advanced } = await import('../src/main/advanced')
const { advancedDef, GIT_COMMIT_MINUTES, GIT_NETWORK_MINUTES, QUEUE_CHECK_MINUTES, QUEUE_NETWORK_MINUTES, QUEUE_SIGN_SECONDS } = await import('../src/shared/advanced')
const { applyAdvancedLimits } = await import('../src/main/limitsApp')
const { platformLimits } = await import('../src/main/platform/limits')
const { gitIntegration } = await import('../src/main/platform/gitIntegration')
const { SIGN_CHECK_MS } = await import('../src/main/platform/gitSigning')
const { cancelGitRun, cancelOwnerOf, gitRunsNow, withGitCancel } = await import('../src/main/gitCancel')

advanced.load(join(base, 'profile'))
afterAll(() => advanced.stop())

describe('the git limits’ settings (HI-3372)', () => {
  it('three new settings, each its default and range; the signed merge commit’s default 300 s; the sign check 15 s', () => {
    expect(advancedDef(GIT_COMMIT_MINUTES)).toMatchObject({ id: 'cw.git.commitMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(GIT_NETWORK_MINUTES)).toMatchObject({ id: 'cw.git.networkMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(QUEUE_NETWORK_MINUTES)).toMatchObject({ id: 'cw.queue.networkMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(QUEUE_SIGN_SECONDS)).toMatchObject({ default: 300, min: 5, max: 3600 })
    expect(SIGN_CHECK_MS).toBe(15_000)
  })

  it('the ports’ getters before main sets them: each setting’s own default', () => {
    expect([platformLimits.gitCommitMs(), platformLimits.gitNetworkMs(), platformLimits.queueNetworkMs(), platformLimits.queueCheckMs()]).toEqual([30 * 60_000, 30 * 60_000, 30 * 60_000, 90 * 60_000])
  })

  it('main’s wiring: each getter reads its setting now, in its unit, a change applying to the next command', async () => {
    const was = { ...platformLimits }
    try {
      applyAdvancedLimits()
      expect(platformLimits.gitCommitMs()).toBe(30 * 60_000)
      for (const [id, v] of [[GIT_COMMIT_MINUTES, 7], [GIT_NETWORK_MINUTES, 11], [QUEUE_NETWORK_MINUTES, 13], [QUEUE_CHECK_MINUTES, 17]] as const) await advanced.set(id, v)
      expect([platformLimits.gitCommitMs(), platformLimits.gitNetworkMs(), platformLimits.queueNetworkMs(), platformLimits.queueCheckMs()]).toEqual([7 * 60_000, 11 * 60_000, 13 * 60_000, 17 * 60_000])
    } finally {
      for (const id of [GIT_COMMIT_MINUTES, GIT_NETWORK_MINUTES, QUEUE_NETWORK_MINUTES, QUEUE_CHECK_MINUTES]) await advanced.set(id, null)
      Object.assign(platformLimits, was)
    }
  })

  it('the merge queue’s push of a merged target takes cw.queue.networkMinutes', async () => {
    const given: (number | undefined)[] = []
    const host = { project: 'p', folder: 'p', signTimeoutMs: 0, identity: async () => null, reads: {}, run: async (_cwd: string, _args: string[], opts?: { timeoutMs?: number }) => (given.push(opts?.timeoutMs), { ok: true, out: '', err: '', code: 0 }) } as unknown as CandidateHost
    const was = platformLimits.queueNetworkMs
    platformLimits.queueNetworkMs = () => 3_333_000
    try {
      expect(await gitIntegration.push!(host, { remote: 'origin', ref: 'refs/heads/main' }, 'a'.repeat(40))).toBe('pushed')
    } finally {
      platformLimits.queueNetworkMs = was
    }
    expect(given).toEqual([3_333_000])
  })
})

describe('the user’s Cancel of their git run: its owner alone (HI-3372)', () => {
  /** A window as Electron gives one (its id, its end), the test ending it. */
  const window = (id: number) => {
    let end = (): void => undefined
    return { wc: { id, once: (_e: 'destroyed', fn: () => void) => void (end = fn) }, close: () => end() }
  }
  /** A workspace service reused across opens, as Combwork's is: each open with a lifetime of its own (HR2's round 1). */
  const service = () => {
    let life = new AbortController()
    const ws = { get lifetime() { return life.signal } } as unknown as WorkspaceService
    return { ws, close: () => life.abort(), reopen: () => void (life = new AbortController()) }
  }
  const P = 'C:\\work\\p'
  /** A run that waits until its signal is aborted (or `end` is called), then says which. */
  const waiting = () => {
    let end!: () => void
    const ended = new Promise<void>((r) => (end = r))
    return { end, run: (signal: AbortSignal | undefined) => new Promise<string>((res) => (signal?.addEventListener('abort', () => res('cancelled'), { once: true }), void ended.then(() => res('done')))) }
  }

  it('another window, workspace or project, an unknown id: nothing; its owner (the project in any letter case): cancelled', async () => {
    const w1 = window(1)
    const w2 = window(2)
    const a = service()
    const b = service()
    const w = waiting()
    const going = withGitCancel('op-1', cancelOwnerOf(w1.wc, a.ws, P), w.run)
    expect(gitRunsNow()).toBe(1)
    cancelGitRun('op-1', cancelOwnerOf(w2.wc, a.ws, P))
    cancelGitRun('op-1', cancelOwnerOf(w1.wc, b.ws, P))
    cancelGitRun('op-1', cancelOwnerOf(w1.wc, a.ws, 'C:\\work\\other'))
    cancelGitRun('op-unknown', cancelOwnerOf(w1.wc, a.ws, P))
    cancelGitRun(undefined, cancelOwnerOf(w1.wc, a.ws, P))
    cancelGitRun('op-1', cancelOwnerOf(w1.wc, a.ws, 'c:\\WORK\\p'))
    expect(await going).toBe('cancelled')
    expect(gitRunsNow()).toBe(0)
  })

  it('a duplicate id while it runs is refused, nothing started; a Cancel after it ended, nothing (a later run of that id untouched)', async () => {
    const w1 = window(1)
    const a = service()
    const owner = () => cancelOwnerOf(w1.wc, a.ws, P)
    const x = waiting()
    const first = withGitCancel('op-2', owner(), x.run)
    let ran = false
    await expect(withGitCancel('op-2', owner(), async () => void (ran = true))).rejects.toThrow('That action is already running.')
    expect(ran).toBe(false)
    x.end()
    expect(await first).toBe('done')
    cancelGitRun('op-2', owner())
    const y = waiting()
    const second = withGitCancel('op-2', owner(), y.run)
    y.end()
    expect(await second).toBe('done')
  })

  it('no id: no Cancel, run as before; a run that throws leaves the list too', async () => {
    const owner = cancelOwnerOf(window(1).wc, service().ws, P)
    expect(await withGitCancel(undefined, owner, async (signal) => signal)).toBeUndefined()
    await expect(withGitCancel('op-3', owner, async () => Promise.reject(new Error('failed start')))).rejects.toThrow('failed start')
    expect(gitRunsNow()).toBe(0)
  })

  it('its window closing takes its runs off the list: they run to their end, uncancelled', async () => {
    const w1 = window(1)
    const a = service()
    const w = waiting()
    const going = withGitCancel('op-4', cancelOwnerOf(w1.wc, a.ws, P), w.run)
    w1.close()
    expect(gitRunsNow()).toBe(0)
    cancelGitRun('op-4', cancelOwnerOf(w1.wc, a.ws, P))
    w.end()
    expect(await going).toBe('done')
  })

  it('open, close, reopen, close: each open’s runs leave with it, never cancelled; a later open’s caller never matches an earlier open’s run', async () => {
    const w1 = window(1)
    const a = service()
    // First open: its run, then the workspace closes: off the list, running on.
    const first = waiting()
    const one = withGitCancel('op-5', cancelOwnerOf(w1.wc, a.ws, P), first.run)
    a.close()
    expect(gitRunsNow()).toBe(0)
    // Reopened: the same window, service and project, a new open, can't cancel the first open's run.
    a.reopen()
    cancelGitRun('op-5', cancelOwnerOf(w1.wc, a.ws, P))
    first.end()
    expect(await one).toBe('done')
    // The second open's own run: cancellable by its owner; then closed again, off the list, running on.
    const second = waiting()
    const two = withGitCancel('op-6', cancelOwnerOf(w1.wc, a.ws, P), second.run)
    const third = waiting()
    const three = withGitCancel('op-7', cancelOwnerOf(w1.wc, a.ws, P), third.run)
    cancelGitRun('op-6', cancelOwnerOf(w1.wc, a.ws, P))
    expect(await two).toBe('cancelled')
    a.close()
    expect(gitRunsNow()).toBe(0)
    a.reopen()
    cancelGitRun('op-7', cancelOwnerOf(w1.wc, a.ws, P))
    third.end()
    expect(await three).toBe('done')
  })
})
