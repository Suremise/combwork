// What running agents had started, after Combwork closed unexpectedly (#987): while a launch runs, runningProcesses() gives
// its job's processes, each by id and start time (for the running marker). At the next start (the module fresh, the old
// helper gone as after a crash), stillRunningOf() keeps those still running as the same processes: not the CLI that
// ended, not a record whose pid names another process by now (a stranger's, with another start time), and not one
// already listed as left running (#614: restored from leftovers.json and offered on its own). endProcessesExactly()
// ends exactly those, and the stranger keeps running. The real helper (PowerShell).
import { createRequire } from 'module'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
// What the test started that is still running: stopped by its command line (it names the test's folder) and start,
// never by a pid remembered from earlier (#547).
const { stopProcessesIn, identify, endExactly } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as {
  stopProcessesIn: (folder: string, since?: number) => number
  identify: (pids: number[]) => { pid: number; started: number }[]
  endExactly: (targets: { pid: number; started: number }[]) => number
}
// The tracker's helper ended as a crash ends it (HI-2263): by its identity (pid and start time) read while it runs, never
// a bare pid (#603).
const endHelper = (pid: number | null): number => (pid ? endExactly(identify([pid])) : 0)
// Every child gets the run context's allowlisted environment, never the shell's (a NODE_OPTIONS preload, a GIT_DIR).
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }

vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: () => undefined, onCombworkEvent: () => () => undefined }))
// Combwork's profile, where leftovers.json is kept: this file's own.
const profile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', async (importOriginal) => {
  const stub = await importOriginal<typeof import('./electron-stub')>()
  return { ...stub, app: { ...stub.app, getPath: () => profile.dir } }
})
profile.dir = tempDir('cw-running-profile-')

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

describe.runIf(process.platform === 'win32')('what running agents had started, after an unexpected close (#987)', () => {
  const dir = tempDir('cw-running-')
  const since = Date.now()
  const children: ChildProcess[] = []
  afterAll(() => {
    // Its own children, through their handles (not a pid Windows may have reused).
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
    stopProcessesIn(dir, since)
  })

  it('lists them by identity while they run, and at the next start keeps, and ends, exactly those still running', async () => {
    // A CLI that starts two detached servers and keeps running, tracked from before it starts them.
    const cli = join(dir, 'cli.cjs')
    const outs = [join(dir, 'a.txt'), join(dir, 'b.txt')]
    const server = (out: string): string => `require('child_process').spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)", ${JSON.stringify(out)}], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();`
    writeFileSync(cli, `process.stdin.once('data', () => { ${outs.map(server).join(' ')} }); setTimeout(() => {}, 120000)`)
    // Its servers get the CLI's own environment, explicitly: the allowlisted one it was given.
    const proc = spawn(process.execPath, [cli], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: baseEnv() })
    children.push(proc)
    let mod = await import('../src/main/agentProcesses')
    expect(await mod.runningProcesses()).toEqual([])
    expect(await mod.trackLaunch({ runId: 'r1', projectPath: dir, agentId: 'a1', agentName: 'Website' }, proc.pid!)).toEqual({ tracked: true })
    proc.stdin!.write('go\n')
    expect(await until(() => outs.every((o) => existsSync(o) && readFileSync(o, 'utf8').length > 0), 10_000)).toBe(true)
    const [a, b] = outs.map((o) => Number(readFileSync(o, 'utf8')))

    const launches = await mod.runningProcesses()
    expect(launches.map((l) => [l.projectPath, l.agentId, l.agentName])).toEqual([[dir, 'a1', 'Website']])
    const listed = launches[0].processes
    expect(listed.map((p) => p.pid).sort()).toEqual([proc.pid!, a, b].sort())
    expect(listed.every((p) => /^\d+$/.test(p.created ?? ''))).toBe(true)

    // Combwork ends without quitting: its helper goes (its jobs close, ending nothing), and the CLI with its terminal.
    await mod.closeProcessTracking()
    proc.kill()
    await new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once('exit', r)))
    expect(alive(a) && alive(b)).toBe(true)

    // Someone else's process, which a record names with another start time: as if its pid had been reused.
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', dir], { stdio: 'ignore', windowsHide: true, env: baseEnv() })
    children.push(stranger)
    const strangerRecord = { pid: stranger.pid!, name: 'node.exe', label: 'node old-server.js', created: '116444736000000000' }
    // b was also kept as left running (leftovers.json, #614): restored and offered on its own, so not listed here.
    const bRow = listed.find((p) => p.pid === b)!
    writeFileSync(join(profile.dir, 'leftovers.json'), JSON.stringify({ version: 1, launches: [{ runId: 'r0', projectPath: dir, agentId: 'a1', agentName: 'Website', since: new Date().toISOString(), processes: [bRow] }] }))

    // The next start: a fresh module and helper.
    vi.resetModules()
    mod = await import('../src/main/agentProcesses')
    try {
      expect((await mod.restoreLeftovers()).flatMap((l) => l.processes.map((p) => p.pid))).toEqual([b])
      const still = await mod.stillRunningOf([...listed, strangerRecord])
      expect(still?.map((p) => p.pid)).toEqual([a])
      expect(await mod.endProcessesExactly([...(still ?? []), strangerRecord])).toBe(true)
      expect(await until(() => !alive(a), 5000)).toBe(true)
      expect(alive(stranger.pid!)).toBe(true)
      expect(await mod.stillRunningOf(listed)).toEqual([])
      // b stays listed as left running, to end there.
      expect(await mod.settleLeftovers(dir, 'a1', 'end')).toBe(1)
      expect(await until(() => !alive(b), 5000)).toBe(true)
    } finally {
      await mod.closeProcessTracking()
    }
  }, 60_000)

  // HI-2263: the tracker (its helper) lost while a launch runs. Its jobs go with it, so nothing can be listed any more,
  // but what the launch had started is still running: the marker keeps it, as last listed, until the launch ends.
  it('keeps a running launch’s processes, as last listed, once the tracker is lost, until the launch ends', async () => {
    const out = join(dir, 'lost.txt')
    const cli = join(dir, 'lost-cli.cjs')
    writeFileSync(cli, `process.stdin.once('data', () => { require('child_process').spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)", ${JSON.stringify(out)}], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref() }); setTimeout(() => {}, 120000)`)
    const proc = spawn(process.execPath, [cli], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: baseEnv() })
    children.push(proc)
    vi.resetModules()
    const mod = await import('../src/main/agentProcesses')
    try {
      expect(await mod.trackLaunch({ runId: 'r2', projectPath: dir, agentId: 'a2', agentName: 'Docs' }, proc.pid!)).toEqual({ tracked: true })
      proc.stdin!.write('go\n')
      expect(await until(() => existsSync(out) && readFileSync(out, 'utf8').length > 0, 10_000)).toBe(true)
      const server = Number(readFileSync(out, 'utf8'))
      const before = await mod.runningProcesses()
      expect(before.flatMap((l) => l.processes.map((p) => p.pid)).sort()).toEqual([proc.pid!, server].sort())

      // The helper ends unexpectedly (this test's own): the launch is no longer tracked.
      const lost = new Promise<string>((resolve) => mod.onRunOutcome((runId, outcome) => runId === 'r2' && resolve(outcome)))
      expect(endHelper(mod.processSupervisor().pid)).toBe(1)
      expect(await lost).toBe('unknown')
      // The marker still lists them, by the same identities, though no job can be listed now.
      expect(await mod.runningProcesses()).toEqual(before)
      expect(alive(server)).toBe(true)

      // The launch ends: they are no longer the running marker's.
      expect(await mod.launchEnded('r2')).toBeNull()
      expect(await mod.runningProcesses()).toEqual([])
    } finally {
      await mod.closeProcessTracking()
    }
  }, 60_000)

  // HR1's round 1 on HI-2263: the tracker lost while an ended launch settles (its CLI exited; launchEnded waits a moment
  // before listing what it left). That launch isn't running any more: nothing of it is kept in the marker, then or after.
  // The wait's timer is faked, so the loss always lands inside it.
  it('keeps nothing of a launch whose CLI exited, when the tracker is lost as it settles', async () => {
    const out = join(dir, 'settling.txt')
    const cli = join(dir, 'settling-cli.cjs')
    writeFileSync(cli, `process.stdin.once('data', () => { require('child_process').spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)", ${JSON.stringify(out)}], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref() }); setTimeout(() => {}, 120000)`)
    const proc = spawn(process.execPath, [cli], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: baseEnv() })
    children.push(proc)
    vi.resetModules()
    const mod = await import('../src/main/agentProcesses')
    try {
      expect(await mod.trackLaunch({ runId: 'r3', projectPath: dir, agentId: 'a3', agentName: 'Site' }, proc.pid!)).toEqual({ tracked: true })
      proc.stdin!.write('go\n')
      expect(await until(() => existsSync(out) && readFileSync(out, 'utf8').length > 0, 10_000)).toBe(true)
      expect((await mod.runningProcesses()).map((l) => l.runId)).toEqual(['r3'])

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // Its CLI has exited: it settles (the faked wait), and the helper ends meanwhile.
      const settled = mod.launchEnded('r3')
      const lost = new Promise<string>((resolve) => mod.onRunOutcome((runId, outcome) => runId === 'r3' && resolve(outcome)))
      expect(endHelper(mod.processSupervisor().pid)).toBe(1)
      expect(await lost).toBe('unknown')
      expect(await mod.runningProcesses()).toEqual([])
      // The wait ends; it is looked at (no job any more) and forgotten.
      await vi.advanceTimersByTimeAsync(2000)
      vi.useRealTimers()
      expect(await settled).toBeNull()
      expect(await mod.runningProcesses()).toEqual([])
    } finally {
      vi.useRealTimers()
      await mod.closeProcessTracking()
    }
  }, 60_000)
})
