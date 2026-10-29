// The keeper (HI-2055): once its Hive has gone (its input ended), the helper stays while an agent's launch job it holds
// still has a process, and writes each job's state to keeper-<job>.json: "live" with its members while it has any,
// "ended" once it sees it empty (its whole membership: the job's and what it follows, by its own sweeps), then exits.
// Driven here through the helper's C# (HOST_SOURCE) in a PowerShell of the test's own, with processes of the test's
// own (node sleepers), each ended by the test; the keeper is what its Hive's end would leave running.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_SOURCE } from '../src/main/processSupervisor'
import { tempDir } from './tempDir'

/** A hung run's bound: every step here waits for a condition, never for time. */
const HUNG_MS = 30_000
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const dir = tempDir('hive-keeper-')
const src = join(dir, 'host.cs')
writeFileSync(src, HOST_SOURCE)
/**
 * The helper as its Hive leaves it: configured as a keeper for Hive "100:5", its jobs as given ("add <job> <pid>", or
 * "follow <job> <pid>" for a process it follows outside the job), then, once told "keep", what its input's end does.
 */
const script = join(dir, 'keeper.ps1')
writeFileSync(
  script,
  `param($src, $dir)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -TypeDefinition (Get-Content -Raw $src)
[Console]::Out.WriteLine('self ' + [HiveJobs]::Keeper('100:5', $dir))
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Split(' ')
  if ($a[0] -eq 'keep') { break }
  if ($a[0] -eq 'add') { [Console]::Out.WriteLine('added ' + [HiveJobs]::Add($a[1], [int]$a[2])) }
  if ($a[0] -eq 'follow') { [Console]::Out.WriteLine('followed ' + [HiveJobs]::Follow($a[1], [int]$a[2], 0x0001 -bor 0x100000)) }
}
[HiveJobs]::Keep()
`
)

/** What a test started: ended after it, its own only. */
const started: ChildProcess[] = []
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill()
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A process that waits, the test's own. */
function sleeper(): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true })
  started.push(c)
  return c
}

/** A keeper of the test's own, its states written to a folder of its own. */
function keeper(name: string): { proc: ChildProcessWithoutNullStreams; out: string[]; states: string; state: (job: string) => Record<string, unknown> | null; say: (line: string) => void } {
  const states = join(dir, name)
  const proc = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, src, states], { windowsHide: true, stdio: 'pipe' })
  started.push(proc)
  const out: string[] = []
  let buf = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    buf += d
    const lines = buf.split(/\r?\n/)
    buf = lines.pop()!
    out.push(...lines.filter(Boolean))
  })
  const state = (job: string): Record<string, unknown> | null => {
    const f = join(states, `keeper-${job}.json`)
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null
  }
  return { proc, out, states, state, say: (line) => proc.stdin.write(`${line}\n`) }
}

const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { timeout: HUNG_MS, interval: 100 })
const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())))

describe.runIf(process.platform === 'win32')('the keeper (HI-2055)', () => {
  it('a job already empty when its input ends: "ended" at once, from this helper for its Hive, and it exits', async () => {
    const k = keeper('empty')
    const s = sleeper()
    await waitFor(() => expect(k.out.find((l) => l.startsWith('self '))).toBeTruthy())
    const self = k.out.find((l) => l.startsWith('self '))!.slice(5)
    k.say(`add j1 ${s.pid}`)
    await waitFor(() => expect(k.out).toContain('added ok'))
    s.kill()
    await exited(s)
    k.say('keep')
    await exited(k.proc)
    expect(k.state('j1')).toMatchObject({ v: 1, run: 'j1', helper: self, hive: '100:5', state: 'ended', observed: 'complete', total: 0, members: [] })
  }, 60_000)

  it('a job with a process: says keeping, "live" with it, then "ended" once it ends, and exits', async () => {
    const k = keeper('live')
    const s = sleeper()
    k.say(`add j2 ${s.pid}`)
    await waitFor(() => expect(k.out).toContain('added ok'))
    k.say('keep')
    await waitFor(() => expect(k.out).toContain('keeping'))
    // Its console's host is a member too (counted, ended with it).
    await waitFor(() => expect(k.state('j2')).toMatchObject({ state: 'live', members: expect.arrayContaining([expect.objectContaining({ pid: s.pid, name: 'node' })]) }))
    expect(k.proc.exitCode).toBeNull()
    s.kill()
    await exited(k.proc)
    expect(k.state('j2')).toMatchObject({ state: 'ended', total: 0, members: [] })
  }, 60_000)

  it('a process it follows outside the job keeps it "live" after the job itself is empty, until it ends', async () => {
    const k = keeper('followed')
    const inJob = sleeper()
    const outside = sleeper()
    k.say(`add j3 ${inJob.pid}`)
    await waitFor(() => expect(k.out).toContain('added ok'))
    k.say(`follow j3 ${outside.pid}`)
    await waitFor(() => expect(k.out).toContain('followed True'))
    inJob.kill()
    await exited(inJob)
    k.say('keep')
    await waitFor(() => expect(k.state('j3')).toMatchObject({ state: 'live', members: expect.arrayContaining([expect.objectContaining({ pid: outside.pid })]) }))
    expect((k.state('j3')!.members as { pid: number }[]).some((m) => m.pid === inJob.pid)).toBe(false)
    outside.kill()
    await exited(k.proc)
    expect(k.state('j3')).toMatchObject({ state: 'ended', total: 0 })
  }, 60_000)

  it('a grandchild started through a process that has exited keeps it "live" (no record could hold it), until it ends', async () => {
    const k = keeper('grandchild')
    const pidFile = join(dir, 'grandchild.pid')
    // The middle process starts a detached child once it is in the job, says its id, and exits.
    const middle = spawn(process.execPath, ['-e', `process.stdin.once('data', () => { const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', windowsHide: true }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); process.exit(0) })`], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    started.push(middle)
    k.say(`add j4 ${middle.pid}`)
    await waitFor(() => expect(k.out).toContain('added ok'))
    middle.stdin!.write('go\n')
    await exited(middle)
    await waitFor(() => expect(existsSync(pidFile)).toBe(true))
    const grandchild = Number(readFileSync(pidFile, 'utf8'))
    try {
      k.say('keep')
      await waitFor(() => expect(k.state('j4')).toMatchObject({ state: 'live', members: expect.arrayContaining([expect.objectContaining({ pid: grandchild })]) }))
      expect(k.proc.exitCode).toBeNull()
    } finally {
      if (alive(grandchild)) process.kill(grandchild)
    }
    await exited(k.proc)
    expect(k.state('j4')).toMatchObject({ state: 'ended', total: 0 })
  }, 60_000)

  it('a keeper ended before its job empties leaves "live", never "ended"', async () => {
    const k = keeper('killed')
    const s = sleeper()
    k.say(`add j5 ${s.pid}`)
    await waitFor(() => expect(k.out).toContain('added ok'))
    k.say('keep')
    await waitFor(() => expect(k.state('j5')).toMatchObject({ state: 'live' }))
    k.proc.kill()
    await exited(k.proc)
    s.kill()
    await exited(s)
    expect(k.state('j5')).toMatchObject({ state: 'live', members: expect.arrayContaining([expect.objectContaining({ pid: s.pid })]) })
  }, 60_000)

  it('not configured (no folder), or holding no job: it exits at the end of its input, writing nothing', async () => {
    const k = keeper('nothing')
    k.say('keep')
    await exited(k.proc)
    expect(k.out).not.toContain('keeping')
    expect(existsSync(k.states)).toBe(false)
  }, 60_000)
})
