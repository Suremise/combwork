// HI-3372 (timing-margins audit, 18 Nov: the user's own git and jj work): the settings that bound a commit or set aside,
// a fetch, pull or push, the merge queue's network steps and a jj command, their defaults and ranges; main's wiring of
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
const { advancedDef, GIT_COMMIT_MINUTES, GIT_NETWORK_MINUTES, JJ_COMMAND_SECONDS, QUEUE_CHECK_MINUTES, QUEUE_NETWORK_MINUTES, QUEUE_SIGN_SECONDS } = await import('../src/shared/advanced')
const { applyAdvancedLimits } = await import('../src/main/limitsApp')
const { platformLimits } = await import('../src/main/platform/limits')
const { gitIntegration } = await import('../src/main/platform/gitIntegration')
const { SIGN_CHECK_MS } = await import('../src/main/platform/gitSigning')
const { cancelGitRun, dropGitRuns, gitRunsNow, withGitCancel } = await import('../src/main/gitCancel')

advanced.load(join(base, 'profile'))
afterAll(() => advanced.stop())

describe('the git and jj limits’ settings (HI-3372)', () => {
  it('four new settings, each its default and range; the signed merge commit’s default 300 s; the sign check 15 s', () => {
    expect(advancedDef(GIT_COMMIT_MINUTES)).toMatchObject({ id: 'cw.git.commitMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(GIT_NETWORK_MINUTES)).toMatchObject({ id: 'cw.git.networkMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(QUEUE_NETWORK_MINUTES)).toMatchObject({ id: 'cw.queue.networkMinutes', group: 'cw', kind: 'number', default: 30, min: 1, max: 240, unit: 'min' })
    expect(advancedDef(JJ_COMMAND_SECONDS)).toMatchObject({ id: 'cw.jj.commandSeconds', group: 'cw', kind: 'number', default: 300, min: 30, max: 3600, unit: 's' })
    expect(advancedDef(QUEUE_SIGN_SECONDS)).toMatchObject({ default: 300, min: 5, max: 3600 })
    expect(SIGN_CHECK_MS).toBe(15_000)
  })

  it('the ports’ getters before main sets them: each setting’s own default', () => {
    expect([platformLimits.gitCommitMs(), platformLimits.gitNetworkMs(), platformLimits.queueNetworkMs(), platformLimits.queueCheckMs(), platformLimits.jjCommandMs()]).toEqual([30 * 60_000, 30 * 60_000, 30 * 60_000, 90 * 60_000, 300_000])
  })

  it('main’s wiring: each getter reads its setting now, in its unit, a change applying to the next command', async () => {
    const was = { ...platformLimits }
    try {
      applyAdvancedLimits()
      expect(platformLimits.gitCommitMs()).toBe(30 * 60_000)
      for (const [id, v] of [[GIT_COMMIT_MINUTES, 7], [GIT_NETWORK_MINUTES, 11], [QUEUE_NETWORK_MINUTES, 13], [QUEUE_CHECK_MINUTES, 17], [JJ_COMMAND_SECONDS, 45]] as const) await advanced.set(id, v)
      expect([platformLimits.gitCommitMs(), platformLimits.gitNetworkMs(), platformLimits.queueNetworkMs(), platformLimits.queueCheckMs(), platformLimits.jjCommandMs()]).toEqual([7 * 60_000, 11 * 60_000, 13 * 60_000, 17 * 60_000, 45_000])
    } finally {
      for (const id of [GIT_COMMIT_MINUTES, GIT_NETWORK_MINUTES, QUEUE_NETWORK_MINUTES, QUEUE_CHECK_MINUTES, JJ_COMMAND_SECONDS]) await advanced.set(id, null)
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
  const ws1 = {} as WorkspaceService
  const ws2 = {} as WorkspaceService
  const owner = { sender: 1, ws: ws1, project: 'C:\\work\\p' }
  /** A run that waits until its signal is aborted (or `end` is called), then says which. */
  const waiting = () => {
    let end!: () => void
    const ended = new Promise<void>((r) => (end = r))
    return { end, run: (signal: AbortSignal | undefined) => new Promise<string>((res) => (signal?.addEventListener('abort', () => res('cancelled'), { once: true }), void ended.then(() => res('done')))) }
  }

  it('another window, workspace or project, an unknown id: nothing; its owner (the project in any letter case): cancelled', async () => {
    const w = waiting()
    const going = withGitCancel('op-1', owner, w.run)
    expect(gitRunsNow()).toBe(1)
    cancelGitRun('op-1', { ...owner, sender: 2 })
    cancelGitRun('op-1', { ...owner, ws: ws2 })
    cancelGitRun('op-1', { ...owner, project: 'C:\\work\\other' })
    cancelGitRun('op-unknown', owner)
    cancelGitRun(undefined, owner)
    cancelGitRun('op-1', { ...owner, project: 'c:\\WORK\\p' })
    expect(await going).toBe('cancelled')
    expect(gitRunsNow()).toBe(0)
  })

  it('a duplicate id while it runs is refused, nothing started; a Cancel after it ended, nothing (a later run of that id untouched)', async () => {
    const a = waiting()
    const first = withGitCancel('op-2', owner, a.run)
    let ran = false
    await expect(withGitCancel('op-2', owner, async () => void (ran = true))).rejects.toThrow('That action is already running.')
    expect(ran).toBe(false)
    a.end()
    expect(await first).toBe('done')
    cancelGitRun('op-2', owner)
    const b = waiting()
    const second = withGitCancel('op-2', owner, b.run)
    b.end()
    expect(await second).toBe('done')
  })

  it('no id: no Cancel, run as before; a run that throws leaves the list too', async () => {
    expect(await withGitCancel(undefined, owner, async (signal) => signal)).toBeUndefined()
    await expect(withGitCancel('op-3', owner, async () => Promise.reject(new Error('failed start')))).rejects.toThrow('failed start')
    expect(gitRunsNow()).toBe(0)
  })

  it('its window or workspace closing takes its runs off the list: they run to their end, uncancelled', async () => {
    const w = waiting()
    const going = withGitCancel('op-4', owner, w.run)
    dropGitRuns({ sender: 1 })
    expect(gitRunsNow()).toBe(0)
    cancelGitRun('op-4', owner)
    w.end()
    expect(await going).toBe('done')
    const v = waiting()
    const other = withGitCancel('op-5', owner, v.run)
    dropGitRuns({ ws: ws1 })
    cancelGitRun('op-5', owner)
    v.end()
    expect(await other).toBe('done')
  })
})
