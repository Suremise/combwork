// When Combwork's process tracker fails (#507, Darren's decision B): agents start all the same, untracked, and Combwork says so
// once, with Diagnostics saying why. A helper that starts but never says it is ready is given up on in bounded time;
// one that dies after starting loses its jobs: said at once, kept for Diagnostics, nothing ended, and what was listed as
// left running stays listed by pid and start time (#614), for the next helper to end exactly that. The real helper
// (PowerShell); each test with the module fresh.
import { createRequire } from 'module'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
// What the test started that is still running: stopped by its command line (it names the test's folder) and start,
// never by a pid remembered from earlier, which Windows may have given another process since: under load that could
// be a concurrent run's Vitest worker (#547: a likely cause of one exiting with code 1, not reproduced).
const { stopProcessesIn } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as { stopProcessesIn: (folder: string, since?: number) => number }

const events: { type: string; leftovers?: { processes: unknown[] } }[] = []
const toasts: { title: string; message?: string }[] = []
vi.mock('../src/main/events', () => ({
  emit: (e: { type: string }) => events.push(e),
  toast: (_level: string, title: string, message?: string) => toasts.push({ title, message }),
  onCombworkEvent: () => () => undefined
}))
// Combwork's profile, where what is listed is kept (#614): this file's own, never the shared test root.
const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => profile.dir } }
})
profile.dir = tempDir('cw-tracker-profile-')

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 100))
  return fn()
}

describe.runIf(process.platform === 'win32')("when the process tracker fails", () => {
  const dir = tempDir('cw-tracker-')
  const since = Date.now()
  const children: ChildProcess[] = []
  let mod: typeof import('../src/main/agentProcesses') | null = null
  beforeEach(() => {
    vi.resetModules()
    events.length = 0
    toasts.length = 0
  })
  afterEach(async () => {
    await mod?.closeProcessTracking()
    delete process.env.CW_TEST_PROCESS_TRACKER
    delete process.env.CW_TEST_TRACKER_WAIT_MS
    delete process.env.CW_TEST_TRACKER_HEARD
  })
  afterAll(() => {
    // Its own children, through their handles (not a pid Windows may have reused).
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
    stopProcessesIn(dir, since)
  })

  it("gives up on a helper that never says it is ready, in bounded time, and says why", async () => {
    process.env.CW_TEST_PROCESS_TRACKER = 'silent'
    process.env.CW_TEST_TRACKER_WAIT_MS = '3000'
    mod = await import('../src/main/agentProcesses')
    const t = Date.now()
    expect(await mod.trackingReady()).toBe(false)
    expect(Date.now() - t).toBeLessThan(10_000)
    expect(mod.trackingProblem()).toMatch(/didn't start within 3 s/)
    // From then on, launches aren't held for it: they start untracked at once.
    expect(await mod.trackingReady()).toBe(false)
    mod.noteUntracked(mod.trackingProblem())
    mod.noteUntracked(mod.trackingProblem())
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toMatch(/didn't start within 3 s/)
  }, 30_000)

  it('has its helper gone once closing resolves, and starts no other after (#1020)', async () => {
    mod = await import('../src/main/agentProcesses')
    const next = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(next)
    expect(await mod.trackLaunch({ runId: 'closed1', projectPath: dir, agentId: 'a3', agentName: 'Closed' }, next.pid!)).toEqual({ tracked: true })
    const helper = mod.trackerPid()!
    // Its PowerShell works in the temp folder: gone when the close resolves, so a run's clean-up finds nothing held.
    await mod.closeProcessTracking()
    expect(alive(helper)).toBe(false)
    // A later request (a refresh's next look) starts no helper in the folder.
    expect(await mod.trackLaunch({ runId: 'closed2', projectPath: dir, agentId: 'a3', agentName: 'Closed' }, next.pid!)).toMatchObject({ tracked: false })
    expect(await mod.trackingReady()).toBe(false)
    expect(mod.trackerPid()).toBeNull()
  }, 30_000)

  it('answers a request on its way when closing, at once, and its next look starts no helper (#1020)', async () => {
    // A helper that is ready but never answers: a request stays on its way for as long as the test needs, and its own
    // reply wait (60 s) is longer than the test's limit, so only the close can answer it.
    process.env.CW_TEST_PROCESS_TRACKER = 'mute'
    process.env.CW_TEST_TRACKER_WAIT_MS = '60000'
    const heard = join(dir, 'heard.txt')
    process.env.CW_TEST_TRACKER_HEARD = heard
    mod = await import('../src/main/agentProcesses')
    const next = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(next)
    expect(await mod.trackingReady()).toBe(true)
    const helper = mod.trackerPid()!
    const pending = mod.trackLaunch({ runId: 'held1', projectPath: dir, agentId: 'a4', agentName: 'Held' }, next.pid!)
    // The helper has read it, and won't answer.
    expect(await until(() => existsSync(heard) && readFileSync(heard, 'utf8').includes(' add held1 '), 10_000)).toBe(true)
    const closed = mod.closeProcessTracking()
    // Answered by the close (nothing else will within the test's limit): no answer, not tracked.
    expect(await pending).toMatchObject({ tracked: false })
    await closed
    expect(alive(helper)).toBe(false)
    // The caller's next look, as a refresh's after its unanswered one: no helper starts.
    expect(await mod.trackLaunch({ runId: 'held2', projectPath: dir, agentId: 'a4', agentName: 'Held' }, next.pid!)).toMatchObject({ tracked: false })
    expect(mod.trackerPid()).toBeNull()
    expect(readFileSync(heard, 'utf8')).not.toContain('held2')
  }, 30_000)

  it('ends a helper not yet ready when closing, and the close waits for it', async () => {
    process.env.CW_TEST_PROCESS_TRACKER = 'silent'
    process.env.CW_TEST_TRACKER_WAIT_MS = '60000'
    mod = await import('../src/main/agentProcesses')
    const ready = mod.trackingReady()
    expect(await until(() => mod!.trackerPid() !== null, 10_000)).toBe(true)
    const helper = mod.trackerPid()!
    // It never reads its input: ended rather than waited for, and whoever waited for it to start hears it won't.
    await mod.closeProcessTracking()
    expect(alive(helper)).toBe(false)
    expect(await ready).toBe(false)
  }, 30_000)

  it('starts its helper early when warmed (#1155): the first launch finds it running, and quitting meanwhile ends it', async () => {
    mod = await import('../src/main/agentProcesses')
    expect(mod.trackerPid()).toBeNull()
    mod.warmProcessTracking()
    expect(await until(() => mod!.trackerPid() !== null, 10_000)).toBe(true)
    const helper = mod.trackerPid()!
    expect(await mod.trackingReady()).toBe(true)
    const next = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(next)
    expect(await mod.trackLaunch({ runId: 'warm1', projectPath: dir, agentId: 'a5', agentName: 'Warm' }, next.pid!)).toEqual({ tracked: true })
    // The same helper, warmed again as more workspace changes come: no second one.
    mod.warmProcessTracking()
    expect(mod.trackerPid()).toBe(helper)
    expect(toasts).toEqual([])
    await mod.closeProcessTracking()
    expect(alive(helper)).toBe(false)

    // Quitting while a warmed helper is still starting: it is ended, and none starts after.
    vi.resetModules()
    process.env.CW_TEST_PROCESS_TRACKER = 'silent'
    process.env.CW_TEST_TRACKER_WAIT_MS = '60000'
    mod = await import('../src/main/agentProcesses')
    mod.warmProcessTracking()
    expect(await until(() => mod!.trackerPid() !== null, 10_000)).toBe(true)
    const starting = mod.trackerPid()!
    await mod.closeProcessTracking()
    expect(alive(starting)).toBe(false)
    mod.warmProcessTracking()
    expect(mod.trackerPid()).toBeNull()
    expect(toasts).toEqual([])
  }, 30_000)

  it('says nothing when a warmed helper that holds nothing dies, and the next launch starts another (#1155)', async () => {
    mod = await import('../src/main/agentProcesses')
    mod.warmProcessTracking()
    expect(await mod.trackingReady()).toBe(true)
    const helper = mod.trackerPid()!
    process.kill(helper) // its handle is held (the module's helper, running): the pid can't be another's
    expect(await until(() => mod!.trackerPid() === null, 10_000)).toBe(true)
    expect(toasts).toEqual([])
    expect(mod.trackingLost()).toBeNull()
    const next = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(next)
    expect(await mod.trackLaunch({ runId: 'warm2', projectPath: dir, agentId: 'a6', agentName: 'After' }, next.pid!)).toEqual({ tracked: true })
    expect(mod.trackerPid()).not.toBe(helper)
    expect(mod.trackingProblem()).toBeNull()
  }, 30_000)

  it('says at once when a running helper dies, keeps it for Diagnostics, ends nothing, and keeps what was listed by identity', async () => {
    mod = await import('../src/main/agentProcesses')
    // A launch that leaves a detached server running, tracked from before it starts it.
    const cli = join(dir, 'cli.cjs')
    const out = join(dir, 'server.txt')
    writeFileSync(cli, `process.stdin.once('data', () => { require('child_process').spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)", ${JSON.stringify(out)}], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); setTimeout(() => process.exit(0), 500) })`)
    const proc = spawn(process.execPath, [cli], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    expect(await mod.trackLaunch({ runId: 'lost1', projectPath: dir, agentId: 'a1', agentName: 'Website' }, proc.pid!)).toEqual({ tracked: true })
    proc.stdin!.write('go\n')
    await new Promise((r) => proc.once('exit', r))
    expect(await until(() => existsSync(out), 10_000)).toBe(true)
    const server = Number(readFileSync(out, 'utf8'))
    expect((await mod.launchEnded('lost1'))?.processes.map((p) => p.pid)).toEqual([server])
    expect(mod.trackingLost()).toBeNull()

    // The helper dies (as a crash would): what was listed stays listed, and kept, by pid and start time (#614).
    process.kill(mod.trackerPid()!) // its handle is held (the module's helper, running): the pid can't be another's
    expect(await until(() => toasts.length === 1, 10_000)).toBe(true)
    expect(toasts[0].message).toMatch(/process tracker stopped/)
    expect(toasts[0].message).not.toMatch(/listed as left running/)
    expect(mod.trackingLost()).toMatch(/process tracker stopped .*0 listed process\(es\) were no longer tracked/)
    expect(mod.leftoversOf(dir, 'a1').processes.map((p) => p.pid)).toEqual([server])
    expect(events.at(-1)).toMatchObject({ type: 'agent-leftovers', leftovers: { processes: [{ pid: server }] } })
    await mod.leftoversSaved()
    const kept = JSON.parse(readFileSync(join(profile.dir, 'leftovers.json'), 'utf8'))
    expect(kept.launches.map((l: { processes: { pid: number }[] }) => l.processes.map((x) => x.pid))).toEqual([[server]])
    expect(alive(server)).toBe(true)

    // A new helper tracks later launches; Diagnostics still says what was lost.
    const next = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(next)
    expect(await mod.trackLaunch({ runId: 'lost2', projectPath: dir, agentId: 'a2', agentName: 'Next' }, next.pid!)).toEqual({ tracked: true })
    expect(mod.trackingProblem()).toBeNull()
    expect(mod.trackingLost()).toMatch(/process tracker stopped/)
    // The new helper ends exactly the server that was listed, by its identity.
    expect(await mod.settleLeftovers(dir, 'a1', 'end')).toBe(1)
    expect(await until(() => !alive(server), 5000)).toBe(true)
    expect(mod.leftoversOf(dir, 'a1').processes).toHaveLength(0)
  }, 60_000)
})
