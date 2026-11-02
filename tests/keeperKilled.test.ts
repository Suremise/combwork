// The keeper outlives a Hive killed from outside (HI-2314). Node (libuv) puts each child it starts in one job that ends
// them all once their parent ends, so a helper that was Hive's own child died with it, quit or crash, and never kept
// anything (HI-2055). Here a "Hive" (tests/keeperHost.ts: the real JobHost, started as Hive starts it) holds a launch
// job with a process of the test's own in it, and its main process is ended from outside, nothing else: its helper
// stays, writes "live" with that process, then "ended" once the test ends it, and exits.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import type { Writable } from 'stream'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { helperLaunch, JobHost } from '../src/main/processSupervisor'
import { tempDir } from './tempDir'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
// The helper is no child of the test's: it is checked and, if a test fails, ended by its identity, never by a pid (#603).
type Identity = { pid: number; started: number }
const { identify, stillSame, endExactly } = req('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Identity[]; stillSame: (ids: Identity[]) => number[]; endExactly: (targets: Identity[]) => number }

/** A hung run's bound: every step here waits for a condition, never for time. */
const HUNG_MS = 30_000
const dir = tempDir('hive-keeper-killed-')
let bundle = ''
const started: ChildProcess[] = []
const helpers: Identity[] = []

beforeAll(() => {
  bundle = join(dir, 'host.cjs')
  buildSync({ entryPoints: [join(__dirname, 'keeperHost.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'error' })
})

afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill()
  // Its job emptied, a keeper exits by itself; one still running here (a failed test) is ended.
  endExactly(helpers.splice(0).filter((h) => stillSame([h]).length))
})

const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once('exit', () => r())))
const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { timeout: HUNG_MS, interval: 100 })

describe.runIf(process.platform === 'win32')('the keeper, its Hive killed from outside (HI-2314)', () => {
  it('hands the helper only its pipes to its Hive, never what the Hive itself could hand down (a test’s pipes to it)', async () => {
    // A Hive (Electron's main process, no window) whose own output is the test's pipe: Electron, unlike Node, leaves its
    // standard handles inheritable. It starts the helper's launcher, with a script that stays a minute after its input
    // ends, and quits once it is ready. The test's pipe closes as Electron exits: the helper, still running, holds none
    // of it (started through cmd, which hands down all it can, the pipe stayed open while the helper ran).
    const parent = join(dir, 'inherit-main.cjs')
    const { file, args } = helperLaunch("[Console]::Out.WriteLine('pid ' + $PID); $null = [Console]::In.ReadLine(); [Console]::Out.WriteLine('ready'); while ($null -ne [Console]::In.ReadLine()) {}; Start-Sleep -Seconds 60")
    writeFileSync(join(dir, 'inherit.json'), JSON.stringify({ file, args }))
    writeFileSync(
      parent,
      `const { app } = require('electron')
const { file, args } = require(${JSON.stringify(join(dir, 'inherit.json'))})
app.whenReady().then(() => {
  const p = require('child_process').spawn(file, args, { windowsHide: true, stdio: 'pipe' })
  p.stdin.write('x\\n')
  let out = ''
  p.stdout.on('data', (d) => { out += d; const m = /pid (\\d+)[\\s\\S]*ready/.exec(out); if (m) { console.log('helper ' + m[1]); app.quit() } })
})
app.on('window-all-closed', () => undefined)
`
    )
    const electron = req('electron') as string
    const hive = spawn(electron, [parent, `--user-data-dir=${join(dir, 'electron-profile')}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: baseEnv(), cwd: dir })
    started.push(hive)
    let out = ''
    hive.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    let closed = false
    hive.once('close', () => (closed = true))
    const pid = await vi.waitFor(() => {
      const m = /helper (\d+)/.exec(out)
      if (!m) throw new Error(`not ready: ${out}`)
      return Number(m[1])
    }, { timeout: HUNG_MS, interval: 100 })
    const helper = identify([pid])
    helpers.push(...helper)
    await exited(hive)
    // Its pipe closed while the helper (outside the parent's job) still runs.
    await waitFor(() => expect(closed, 'the test’s pipe to the Hive still open: the helper holds it').toBe(true))
    expect(stillSame(helper)).toEqual([pid])
  }, 60_000)

  it('outlives its Hive’s main process ended from outside: "live" with the launch’s process, then "ended" once it ends', async () => {
    const keepDir = join(dir, 'keeper')
    const member = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true, env: baseEnv() })
    started.push(member)
    const hive = spawn(process.execPath, [bundle, '100:5', keepDir, 'killed-run', String(member.pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: baseEnv(), cwd: dir })
    started.push(hive)
    let out = ''
    hive.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    hive.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
    const ready = await vi.waitFor(() => {
      const m = /ready (\d+) (\d+:\d+)/.exec(out)
      if (!m) throw new Error(`not ready: ${out}`)
      return { pid: Number(m[1]), self: m[2] }
    }, { timeout: HUNG_MS, interval: 100 })
    // Its own id (its "pid" line), not its launcher's: the identity it writes its receipts as.
    expect(ready.self.startsWith(`${ready.pid}:`)).toBe(true)
    const helper = identify([ready.pid])
    expect(helper).toHaveLength(1)
    helpers.push(...helper)

    // Ended as a crash ends it: its main process only (TerminateProcess), nothing it started.
    hive.kill()
    await exited(hive)
    const receipt = (): Record<string, unknown> | null => {
      const f = join(keepDir, 'keeper-killed-run.json')
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>) : null
    }
    await waitFor(() => expect(receipt()).toMatchObject({ v: 1, run: 'killed-run', helper: ready.self, hive: '100:5', state: 'live', members: expect.arrayContaining([expect.objectContaining({ pid: member.pid, name: 'node' })]) }))
    expect(stillSame(helper)).toEqual([ready.pid])

    // Its launch's last process ends: "ended", and the keeper exits.
    member.kill()
    await exited(member)
    await waitFor(() => expect(receipt()).toMatchObject({ state: 'ended', helper: ready.self, total: 0 }))
    await waitFor(() => expect(stillSame(helper)).toEqual([]))
  }, 60_000)

  /** A launcher started as Hive starts it, on a script of the test's own: the launcher and its helper's identity. */
  async function launched(script: string): Promise<{ launcher: ChildProcessWithoutNullStreams; helper: Identity[]; out: () => string }> {
    const { file, args, stdio } = helperLaunch(script)
    const launcher = spawn(file, args, { windowsHide: true, stdio, env: baseEnv(), cwd: dir }) as ChildProcessWithoutNullStreams
    started.push(launcher)
    let out = ''
    launcher.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    const pid = await vi.waitFor(() => {
      const m = /pid (\d+)/.exec(out)
      if (!m) throw new Error(`no pid: ${out}`)
      return Number(m[1])
    }, { timeout: HUNG_MS, interval: 100 })
    const helper = identify([pid])
    helpers.push(...helper)
    return { launcher, helper, out: () => out }
  }
  const code = (c: ChildProcess) => exited(c).then(() => c.exitCode)

  it('a stuck helper is ended by its Hive only through its launcher, which holds its handle: never by an id (#603)', async () => {
    // Ready, then answers nothing and ignores its input's end: only its launcher's handle can end it.
    const stuck = "[Console]::Out.WriteLine('pid ' + $PID); $null = [Console]::In.ReadLine(); [Console]::Out.WriteLine('ready'); while ($true) { Start-Sleep -Milliseconds 200 }"
    let proc: ChildProcessWithoutNullStreams | null = null
    const host = new JobHost({
      waitMs: () => 8_000,
      testMode: () => '',
      log: { warn: () => undefined },
      onJoined: () => undefined,
      onLost: () => undefined,
      onFailed: () => undefined,
      launch: () => {
        const { file, args, stdio } = helperLaunch(stuck)
        proc = spawn(file, args, { windowsHide: true, stdio, env: baseEnv(), cwd: dir }) as ChildProcessWithoutNullStreams
        started.push(proc)
        return proc
      }
    })
    expect(await host.ensure()).toBe(true)
    const helper = identify([host.pid!])
    expect(helper).toHaveLength(1)
    helpers.push(...helper)
    // Its request isn't answered within the wait: the host ends it, and the launcher exits once it has.
    expect(await host.request('list', 'stuck-run')).toBeNull()
    expect(await code(proc!)).toBe(1)
    expect(stillSame(helper)).toEqual([])
  }, 60_000)

  it('its launcher told to end it after it has exited by itself ends nothing more, and its control pipe’s end ends nothing', async () => {
    // Exits with 7 at its input's end.
    const own = "[Console]::Out.WriteLine('pid ' + $PID); while ($null -ne [Console]::In.ReadLine()) {}; exit 7"
    const a = await launched(own)
    // The control pipe ends (as Hive gone): the helper runs on, then exits at its input's end with its own code.
    ;(a.launcher.stdio[3] as Writable).end()
    a.launcher.stdin.end()
    expect(await code(a.launcher)).toBe(7)
    expect(stillSame(a.helper)).toEqual([])

    // Told only once the helper has gone (its launcher about to exit, or exited): its own code, nothing ended.
    const b = await launched(own)
    const control = b.launcher.stdio[3] as Writable
    control.on('error', () => undefined)
    b.launcher.stdin.end()
    await waitFor(() => expect(stillSame(b.helper)).toEqual([]))
    const telling = setInterval(() => control.writable && control.write('e'), 10)
    try {
      expect(await code(b.launcher)).toBe(7)
    } finally {
      clearInterval(telling)
    }
  }, 60_000)
})
