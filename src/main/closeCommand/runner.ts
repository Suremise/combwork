// The close command's runner (HI-1368): a small Node process Hive starts detached (cw-close-runner.js, Hive's own
// executable with ELECTRON_RUN_AS_NODE=1), which starts the user's command and outlives Hive if it must ("Don't wait",
// Hive quitting). It reads the command's output as it comes, so the command never blocks on a full pipe, and keeps only
// its last TAIL_BYTES: tail.txt and status.json in the run's folder, each rewritten whole (a temp file, then a rename)
// at most every WRITE_MS. It never kills or cuts short the command; it ends once the command has. Node built-ins only:
// it runs outside the asar.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/** The most output kept, as the last bytes the command wrote (stdout and stderr in the order they came). */
export const TAIL_BYTES = 64 * 1024
/** How often, at most, the tail and status are written while the command runs. */
export const WRITE_MS = 250

/**
 * What Hive asks the runner to run (job.json in the run's folder). Its environment is the runner's own, which Hive gives
 * it (a session command's, as checks get), never written to the folder.
 */
export interface CloseJob {
  command: string
  cwd: string
}

/** The run's state as the runner writes it (status.json): what Hive's panel shows. */
export interface RunStatus {
  runnerPid: number
  commandPid: number | null
  startedAt: string
  state: 'running' | 'exited' | 'spawnFailed'
  exitCode: number | null
  /** Why the command couldn't start (spawnFailed). */
  error?: string
  endedAt?: string
  /** Every byte of output seen; more than TAIL_BYTES: the tail dropped the oldest. */
  bytesSeen: number
  dropped: boolean
}

/** The last `max` bytes written to it, oldest dropped first. */
export class TailRing {
  private chunks: Buffer[] = []
  private size = 0
  seen = 0
  constructor(private readonly max = TAIL_BYTES) {}
  push(b: Buffer): void {
    this.seen += b.length
    // A chunk bigger than the whole ring keeps only its end.
    const chunk = b.length > this.max ? b.subarray(b.length - this.max) : b
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max) {
      const first = this.chunks[0]
      const over = this.size - this.max
      if (first.length <= over) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(over)
        this.size -= over
      }
    }
  }
  get dropped(): boolean {
    return this.seen > this.size
  }
  bytes(): Buffer {
    return Buffer.concat(this.chunks, this.size)
  }
}

/** What the runner needs from outside, so tests can drive it: spawning, files, time. */
export interface RunnerDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  write: (file: string, data: string | Buffer) => void
  now: () => Date
  pid: number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}

/** Codes Windows gives a rename for a moment (a scanner or a reader has the file open): tried again. */
const BRIEF = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Writes a file whole: a temp file beside it, then a rename, so a reader never sees half of it. A rename Windows refuses
 * for a moment (Defender scanning the new file) is tried again, up to about a second: the final status must land, or
 * Hive would read the run as still going with its runner gone. This runner's own thread waits, never Hive's.
 */
function writeWhole(file: string, data: string | Buffer): void {
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, data)
  for (let tries = 0; ; tries++) {
    try {
      renameSync(temp, file)
      return
    } catch (e) {
      if (tries >= 40 || !BRIEF.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

export const nodeDeps = (): RunnerDeps => ({
  spawn: nodeSpawn,
  write: writeWhole,
  now: () => new Date(),
  pid: process.pid,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout)
})

/**
 * Runs the job in `dir` (job.json) to its end: its status and tail written as it goes, and finally. Resolves with the
 * final status once the command has ended (or couldn't start).
 */
export function runJob(dir: string, job: CloseJob, deps: RunnerDeps = nodeDeps(), baseEnv: NodeJS.ProcessEnv = process.env): Promise<RunStatus> {
  const ring = new TailRing()
  const status: RunStatus = { runnerPid: deps.pid, commandPid: null, startedAt: deps.now().toISOString(), state: 'running', exitCode: null, bytesSeen: 0, dropped: false }
  let timer: unknown = null
  let dirty = true
  const flush = (): void => {
    timer = null
    if (!dirty) return
    dirty = false
    status.bytesSeen = ring.seen
    status.dropped = ring.dropped
    try {
      deps.write(join(dir, 'tail.txt'), ring.bytes())
      deps.write(join(dir, 'status.json'), JSON.stringify(status))
    } catch {
      // A write that fails (the folder gone, a full disk) is tried again with the next output; the command goes on.
      dirty = true
    }
  }
  const soon = (): void => {
    dirty = true
    if (timer === null) timer = deps.setTimer(flush, WRITE_MS)
  }
  flush()
  return new Promise((resolve) => {
    const end = (): void => {
      if (timer !== null) deps.clearTimer(timer)
      dirty = true
      flush()
      resolve(status)
    }
    // The command's environment is the user's: this runner's own way of running as Node isn't passed on.
    const env = { ...baseEnv }
    delete env.ELECTRON_RUN_AS_NODE
    let child: ChildProcess
    try {
      child = deps.spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${job.command}"`], { cwd: job.cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      status.state = 'spawnFailed'
      status.error = (e as Error).message
      status.endedAt = deps.now().toISOString()
      return end()
    }
    status.commandPid = child.pid ?? null
    soon()
    // Read as it comes, never paused: the command never waits on a full pipe.
    const take = (b: Buffer): void => {
      ring.push(b)
      soon()
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    let done = false
    child.on('error', (e) => {
      if (done) return
      done = true
      status.state = 'spawnFailed'
      status.error = e.message
      status.endedAt = deps.now().toISOString()
      end()
    })
    // 'close': its exit and the end of both pipes, so the last output is in the tail.
    child.on('close', (code, signal) => {
      if (done) return
      done = true
      status.state = 'exited'
      status.exitCode = code ?? (signal ? 1 : 0)
      status.endedAt = deps.now().toISOString()
      end()
    })
  })
}

/** The runner's entry: the run's folder, its job.json, run to its end. */
export async function runFolder(dir: string): Promise<void> {
  const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')) as CloseJob
  await runJob(dir, job)
}
