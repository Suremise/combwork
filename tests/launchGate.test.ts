// A launch's command runs only once Combwork has put its terminal's process in the launch's job (#507), and only on Combwork's
// explicit word: a CLI that starts a detached server the moment it runs, with the job host not even started (cold), or
// with tracking slower than any timeout, still leaves it in the job; tracking refused, or the pipe closing without a
// word, never runs it. The gate passes the command line node-pty itself would have built.
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { basename, join } from 'path'
import { createRequire } from 'module'
import * as pty from '@lydell/node-pty'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { commandLineOf, launchGate, type GateWord } from '../src/main/launchGate'
import { tempDir } from './tempDir'
// What the test started that is still running: stopped by its command line (it names the test's folder) and start,
// never by a pid remembered from earlier, which Windows may have given another process since: under load that could
// be a concurrent run's Vitest worker (#547: a likely cause of one exiting with code 1, not reproduced).
type Identity = { pid: number; started: number }
const { stopProcessesIn, identify, endExactly } = createRequire(import.meta.url)('./e2e/folderProcesses.cjs') as { stopProcessesIn: (folder: string, since?: number) => number; identify: (pids: number[]) => Identity[]; endExactly: (targets: Identity[]) => number }

vi.mock('../src/main/events', () => ({ emit: () => undefined, sendPty: () => undefined }))
vi.mock('../src/main/providers', () => ({ allProviders: () => [] }))

describe("the gate's command line", () => {
  it("is node-pty's own, for the arguments that need quoting", () => {
    const { argsToCommandLine } = createRequire(import.meta.url)(join(__dirname, '..', 'node_modules', '@lydell', 'node-pty-win32-x64', 'lib', 'windowsPtyAgent.js')) as { argsToCommandLine: (file: string, args: string[]) => string }
    const cases = [[], ['plain'], ['with space'], [''], ['say "hi"'], ['C:\\dir with space\\'], ['trail\\\\'], ['back\\"slash'], ['"already quoted"'], ['"lopsided'], ['tab\there'], ['--settings', '{"a":"b c"}'], ['/d', '/s', '/c', 'npm install && echo "done"']]
    for (const args of cases) expect(commandLineOf(args)).toBe(argsToCommandLine('x', args).slice(2))
  })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// The CLI the gate starts here is Node, named as Windows has it spelled in the path it was started by: node.exe, or
// node.EXE when Vitest was started through that spelling (#998).
const program = basename(process.execPath)
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

describe.runIf(process.platform === 'win32')('a launch held at its gate', () => {
  const dir = tempDir('cw-gate-')
  const since = Date.now()
  const children: ChildProcess[] = []
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CW_')) env[k] = v
  // A stand-in CLI: the moment it runs, it notes that it ran and starts a detached, hidden server (its pid noted);
  // then it prints its arguments and exits with 7 a moment later. With --stay, it notes its own pid instead, starts
  // nothing and runs until ended, as a CLI does.
  const cli = join(dir, 'cli.cjs')
  writeFileSync(
    cli,
    `const { spawn } = require('child_process'), fs = require('fs')
const [ran, server] = process.argv.slice(2, 4)
fs.writeFileSync(ran, String(Date.now()))
if (process.argv[4] === '--stay') {
  fs.writeFileSync(server, String(process.pid))
  setInterval(() => {}, 1000)
} else {
  spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120000)", server], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  console.log('ARGS ' + JSON.stringify(process.argv.slice(4)))
  setTimeout(() => process.exit(7), 1500)
}
`
  )
  afterAll(async () => {
    const { closeProcessTracking } = await import('../src/main/agentProcesses')
    // The job host's PowerShell works in the run's temp folder: gone before the run removes it (#1020).
    await closeProcessTracking()
    // Its own children, through their handles (not a pid Windows may have reused).
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill()
    stopProcessesIn(dir, since)
  })

  /** Runs the stand-in through spawnPty with this track: its exit code, output, when it ran (0: never) and its server's pid. */
  async function launch(name: string, track: (pid: number, cancelled: AbortSignal) => Promise<GateWord>, extra: string[] = []) {
    const { spawnPty } = await import('../src/main/ptyHost')
    const ran = join(dir, `${name}-ran.txt`)
    const server = join(dir, `${name}-server.txt`)
    let output = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty(`gate-${name}`, { file: process.execPath, args: [cli, ran, server, ...extra], cwd: dir, env, track, onData: (d) => (output += d), onExit: (c) => resolve(c) })
    })
    await new Promise((r) => setTimeout(r, 300))
    const serverPid = existsSync(server) ? Number(readFileSync(server, 'utf8')) : 0
    return { code, output: plain(output), ranAt: existsSync(ran) ? Number(readFileSync(ran, 'utf8')) : 0, serverPid }
  }

  it('keeps in the job a server the CLI starts the moment it runs, with the job host cold', async () => {
    const { trackLaunch, launchEnded } = await import('../src/main/agentProcesses')
    const r = await launch('cold', (pid, cancelled) => trackLaunch({ runId: 'gate1', projectPath: dir, agentId: 'g1', agentName: 'Gate' }, pid, cancelled).then((t): GateWord => (t.tracked ? { go: true } : { go: false, reason: t.reason })), ['with space', 'say "hi"', ''])
    expect(r.code).toBe(7)
    expect(r.output).toContain('ARGS ["with space","say \\"hi\\"",""]')
    expect(r.serverPid > 0 && alive(r.serverPid)).toBe(true)
    expect((await launchEnded('gate1'))?.processes.map((p) => p.pid)).toContain(r.serverPid)
  }, 60000)

  it('holds the CLI for as long as tracking takes, longer than any old timeout, and its server is still tracked', async () => {
    const { trackLaunch, launchEnded } = await import('../src/main/agentProcesses')
    let trackedAt = 0
    const r = await launch('slow', async (pid, cancelled) => {
      await new Promise((res) => setTimeout(res, 17_000))
      const t = await trackLaunch({ runId: 'gate2', projectPath: dir, agentId: 'g2', agentName: 'Slow' }, pid, cancelled)
      trackedAt = Date.now()
      return t.tracked ? { go: true } : { go: false, reason: t.reason }
    })
    expect(r.code).toBe(7)
    expect(trackedAt > 0 && r.ranAt >= trackedAt).toBe(true)
    expect((await launchEnded('gate2'))?.processes.map((p) => p.pid)).toContain(r.serverPid)
  }, 90000)

  it("never runs the CLI when told not to, or when tracking fails, and its terminal says why", async () => {
    const refused = await launch('refused', async () => ({ go: false, reason: "its processes couldn't be tracked (test)" }))
    expect(refused.ranAt).toBe(0)
    expect(refused.serverPid).toBe(0)
    expect(refused.code).toBe(1)
    expect(refused.output.replace(/\s+/g, ' ')).toContain(`Error: Combwork didn't start ${program}: its processes couldn't be tracked (test)`)
    const failed = await launch('failed', () => Promise.reject(new Error('the tracker broke')))
    expect(failed.ranAt).toBe(0)
    expect(failed.output.replace(/\s+/g, ' ')).toContain('the tracker broke')
  }, 60000)

  it('ends a CLI that outlives its gate, rather than leaving it in the job (HI-1819)', async () => {
    const { trackLaunch, launchEnded } = await import('../src/main/agentProcesses')
    const { spawnPty } = await import('../src/main/ptyHost')
    // Combwork quitting just after a launch: its CLI, started as the console closed, missed the close and ran on with no
    // terminal, kept as a leftover that held its slot. Here the gate is ended under its running CLI the same way.
    const ran = join(dir, 'orphan-ran.txt')
    const cliPid = join(dir, 'orphan-pid.txt')
    // The gate's identity, taken while it waits for its word (it can't end before), so ending it later never takes a
    // process that got its pid since (#603).
    let gate: Identity | undefined
    const exited = new Promise<void>((resolve) => {
      spawnPty('gate-orphan', {
        file: process.execPath,
        args: [cli, ran, cliPid, '--stay'],
        cwd: dir,
        env,
        track: (pid, cancelled) => {
          gate = identify([pid])[0]
          return trackLaunch({ runId: 'gate5', projectPath: dir, agentId: 'g5', agentName: 'Orphan', gated: true }, pid, cancelled).then((t): GateWord => (t.tracked ? { go: true } : { go: false, reason: t.reason }))
        },
        onExit: () => resolve()
      })
    })
    await vi.waitFor(() => expect(existsSync(cliPid) && Number(readFileSync(cliPid, 'utf8')) > 0).toBe(true), { timeout: 30_000, interval: 50 })
    const pid = Number(readFileSync(cliPid, 'utf8'))
    expect(gate).toBeDefined()
    // Just the gate, not its tree: its CLI must outlive it.
    expect(endExactly([gate!])).toBe(1)
    await exited
    // Once it has ended, its identity names no process: nothing else is ended.
    expect(endExactly([gate!])).toBe(0)
    expect(alive(pid)).toBe(true)
    // Its launch ends with nothing left: the CLI is ended, not listed to keep.
    expect(await launchEnded('gate5')).toBeNull()
    expect(alive(pid)).toBe(false)
  }, 60000)

  it('ends a CLI started through a .cmd wrapper that outlives its gate, the wrapper and the CLI both (HI-1819)', async () => {
    const { trackLaunch, launchEnded } = await import('../src/main/agentProcesses')
    const { spawnPty } = await import('../src/main/ptyHost')
    // A CLI Combwork starts through cmd.exe (toSpawnable: a .cmd launcher it can't start directly): the gate's child is
    // cmd.exe, and the CLI is cmd.exe's.
    const cliPid = join(dir, 'wrapped-pid.txt')
    const wrapper = join(dir, 'wrapper.cmd')
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${cli}" "${join(dir, 'wrapped-ran.txt')}" "${cliPid}" --stay\r\n`)
    // The gate's identity, taken while it waits for its word (it can't end before), so ending it later never takes a
    // process that got its pid since (#603).
    let gate: Identity | undefined
    const exited = new Promise<void>((resolve) => {
      spawnPty('gate-wrapped', {
        file: process.env.ComSpec || 'cmd.exe',
        args: `/d /s /c "${wrapper}"`,
        cwd: dir,
        env,
        track: (pid, cancelled) => {
          gate = identify([pid])[0]
          return trackLaunch({ runId: 'gate6', projectPath: dir, agentId: 'g6', agentName: 'Wrapped', gated: true }, pid, cancelled).then((t): GateWord => (t.tracked ? { go: true } : { go: false, reason: t.reason }))
        },
        onExit: () => resolve()
      })
    })
    await vi.waitFor(() => expect(existsSync(cliPid) && Number(readFileSync(cliPid, 'utf8')) > 0).toBe(true), { timeout: 30_000, interval: 50 })
    const pid = Number(readFileSync(cliPid, 'utf8'))
    expect(gate).toBeDefined()
    // Just the gate, not its tree: its CLI must outlive it.
    expect(endExactly([gate!])).toBe(1)
    await exited
    // Once it has ended, its identity names no process: nothing else is ended.
    expect(endExactly([gate!])).toBe(0)
    expect(alive(pid)).toBe(true)
    expect(await launchEnded('gate6')).toBeNull()
    expect(alive(pid)).toBe(false)
  }, 60000)

  it('never runs the CLI once its terminal is being killed, whatever word comes after (HI-1819)', async () => {
    const ran = join(dir, 'stopped-ran.txt')
    const gate = launchGate(process.execPath, [cli, ran, join(dir, 'stopped-server.txt')], env)
    let output = ''
    const proc = pty.spawn(gate.file, gate.args, { cols: 120, rows: 30, cwd: dir, env: gate.env, useConptyDll: false })
    proc.onData((d) => (output += d))
    // killPty tells the gate first; tracking says go only after.
    gate.stop('its terminal was closed before it started')
    gate.open(Promise.resolve({ go: true }))
    const code = await new Promise<number>((resolve) => proc.onExit(({ exitCode }) => resolve(exitCode)))
    gate.close()
    expect(existsSync(ran)).toBe(false)
    expect(code).toBe(1)
    expect(plain(output).replace(/\s+/g, ' ')).toContain(`Error: Combwork didn't start ${program}: its terminal was closed before it started`)
  }, 60000)

  it('never runs the CLI when the pipe closes without a word', async () => {
    const ran = join(dir, 'eof-ran.txt')
    const gate = launchGate(process.execPath, [cli, ran, join(dir, 'eof-server.txt')], env)
    let output = ''
    const proc = pty.spawn(gate.file, gate.args, { cols: 120, rows: 30, cwd: dir, env: gate.env, useConptyDll: false })
    proc.onData((d) => (output += d))
    // Combwork goes away before it has said anything: the pipe closes under the waiting gate.
    setTimeout(() => gate.close(), 3000)
    const code = await new Promise<number>((resolve) => proc.onExit(({ exitCode }) => resolve(exitCode)))
    expect(existsSync(ran)).toBe(false)
    expect(code).toBe(1)
    expect(plain(output).replace(/\s+/g, ' ')).toContain(`Error: Combwork didn't start ${program}`)
  }, 60000)

  it("doesn't track a process that has exited, and lets go of a launch stopped while it was being tracked", async () => {
    const { trackLaunch, launchEnded } = await import('../src/main/agentProcesses')
    const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
    await new Promise((r) => gone.once('exit', r))
    expect(await trackLaunch({ runId: 'gate3', projectPath: dir, agentId: 'g3', agentName: 'Gone' }, gone.pid!)).toMatchObject({ tracked: false })
    const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    children.push(live)
    const stopped = new AbortController()
    const pending = trackLaunch({ runId: 'gate4', projectPath: dir, agentId: 'g4', agentName: 'Stopped' }, live.pid!, stopped.signal)
    stopped.abort()
    expect(await pending).toEqual({ tracked: false, reason: 'it was stopped before it started' })
    expect(await launchEnded('gate4')).toBeNull()
  }, 60000)
})
