// A launch's outcome (#1434 round 4; agentProcesses.ts), on which a slot's writer is released: `ended` only once its
// job's whole membership is seen empty (a member not described is still a member, at its CLI's exit and at each later
// look), never on a kill's acceptance alone (the job is kept and looked at until empty, `unknown` after a bound); `kept`
// for leftovers kept running; `unknown` for an untracked launch or a job that can't be listed. The job host is a
// stand-in answering each request as the test sets it; its timers are the service's own, driven with fake timers.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { tempDir } from './tempDir'

type Listing = { total: number; adopted: number; processes: { pid: number; name: string; cmd: string; created: string }[] } | null
const host = vi.hoisted(() => ({ listing: new Map<string, unknown>(), killed: [] as string[], forgotten: [] as string[] }))
vi.mock('../src/main/processSupervisor', () => ({
  MAX_LISTED: 100,
  HOST_SOURCE: '',
  JobHost: class {
    usable = true
    pid = 1
    instance = 1
    async ensure() {
      return true
    }
    async request(cmd: string, runId?: string) {
      if (cmd === 'list') return host.listing.has(runId!) ? host.listing.get(runId!) : null
      if (cmd === 'kill') {
        host.killed.push(runId!)
        return true
      }
      if (cmd === 'forget') host.forgotten.push(runId!)
      return 'ok'
    }
  }
}))

const { launchEnded, runOutcome, settleLeftovers, trackLaunch } = await import('../src/main/agentProcesses')

const child = (pid: number) => ({ pid, name: 'node.exe', cmd: 'node serve.js', created: '133000000000000000' })
const list = (runId: string, l: Listing): void => void host.listing.set(runId, l)
/** A launch tracked and its CLI exited (launchEnded, after the service's own settling moment). */
async function exited(runId: string, agentId: string): Promise<void> {
  await trackLaunch({ runId, projectPath: 'C:\\p', agentId, agentName: agentId }, 4000)
  const ended = launchEnded(runId)
  await vi.advanceTimersByTimeAsync(5000)
  await ended
}
/** One of the service's looks at what launches left (its poll). */
const poll = () => vi.advanceTimersByTimeAsync(10_000)

beforeAll(() => {
  const profile = join(tempDir('runoutcomes-'), 'profile')
  mkdirSync(profile, { recursive: true })
  ;(app as unknown as { getPath: () => string }).getPath = () => profile
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("a launch's outcome: ended only on its whole job seen empty", () => {
  it('empty at its exit: ended; a job that can\'t be listed, or a launch never tracked: unknown', async () => {
    vi.useFakeTimers()
    list('r-empty', { total: 0, adopted: 0, processes: [] })
    await exited('r-empty', 'a1')
    expect(runOutcome('r-empty')).toBe('ended')
    list('r-unlisted', null)
    await exited('r-unlisted', 'a2')
    expect(runOutcome('r-unlisted')).toBe('unknown')
    await launchEnded('r-never-tracked')
    expect(runOutcome('r-never-tracked')).toBe('unknown')
  })

  it('a member not described (the total says one remains) is still a member: not ended, at the exit nor at a later look, until the total is 0', async () => {
    vi.useFakeTimers()
    list('r-partial', { total: 1, adopted: 0, processes: [] })
    await exited('r-partial', 'a3')
    expect(runOutcome('r-partial')).toBeNull()
    await poll()
    expect(runOutcome('r-partial')).toBeNull()
    list('r-partial', { total: 0, adopted: 0, processes: [] })
    await poll()
    expect(runOutcome('r-partial')).toBe('ended')
  })

  it("an End accepted while its child still runs isn't ended: its job is kept and looked at, ended once seen empty", async () => {
    vi.useFakeTimers()
    list('r-kill', { total: 1, adopted: 0, processes: [child(5001)] })
    await exited('r-kill', 'a4')
    expect(runOutcome('r-kill')).toBeNull()
    await settleLeftovers('C:\\p', 'a4', 'end')
    expect(host.killed).toContain('r-kill')
    // Accepted, the child still a member: not ended, its job not forgotten.
    expect(runOutcome('r-kill')).toBeNull()
    await poll()
    expect(runOutcome('r-kill')).toBeNull()
    expect(host.forgotten).not.toContain('r-kill')
    // It ends: seen at the next look.
    list('r-kill', { total: 0, adopted: 0, processes: [] })
    await poll()
    expect(runOutcome('r-kill')).toBe('ended')
    expect(host.forgotten).toContain('r-kill')
  })

  it('an End accepted whose child is never seen gone: unknown after the bound, never ended', async () => {
    vi.useFakeTimers()
    list('r-stuck', { total: 1, adopted: 0, processes: [child(5002)] })
    await exited('r-stuck', 'a5')
    await settleLeftovers('C:\\p', 'a5', 'end')
    for (let i = 0; i < 29; i++) await poll()
    expect(runOutcome('r-stuck')).toBeNull()
    await poll()
    expect(runOutcome('r-stuck')).toBe('unknown')
  })

  it('leftovers kept running: kept', async () => {
    vi.useFakeTimers()
    list('r-keep', { total: 1, adopted: 0, processes: [child(5003)] })
    await exited('r-keep', 'a6')
    await settleLeftovers('C:\\p', 'a6', 'keep')
    expect(runOutcome('r-keep')).toBe('kept')
  })
})
