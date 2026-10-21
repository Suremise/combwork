// The merge queue runner's process ownership (#1360 round 2): a Windows job object per lease, which owns every process
// the runner starts for the whole life of its tree (a shell's detached server too), and a launcher that is in the job,
// and recorded, before the command it runs exists.
//
// The job is held by a supervisor (a hidden PowerShell, its C# compiled by Add-Type), a child of Hive: Windows ends it
// with Hive (Node puts its children in a job that ends them when Hive goes), and the job is made with "kill on close",
// so once the supervisor's handle goes every process in it ends too, by the operating system's guarantee. Processes
// can't break away from it (no breakaway allowed). The job is named after the lease (`Local\HiveQueue-<lease>`), so
// another Hive taking a dead runner's lease over can open it while anything still holds it (a supervisor that outlived
// its Hive), end what is in it and see it empty.
//
// A command starts through the launcher (Node: Hive's own executable as Node, or Node itself in tests), started
// detached (outside Hive's own job, so its children can't break away with Hive's job's leave) and waiting on its input:
// it is put in the job and recorded, and only then told to run the command. A launcher whose input closes first (Hive
// gone, or the record not written) exits without running anything.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
public static class HiveQueueJob {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtLimits info, int len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref Accounting info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a, b; public uint flags; public UIntPtr minWs, maxWs; public uint active; public UIntPtr affinity; public uint prio, sched; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtLimits { public Basic basic; public Io io; public UIntPtr procMem, jobMem, peakProc, peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long u, k, pu, pk; public uint faults, total, active, terminated; }
  const uint KILL_ON_JOB_CLOSE = 0x2000;
  static IntPtr job = IntPtr.Zero;
  static long Ms(long ft) { return (ft - 116444736000000000L) / 10000; }
  /** Makes the job (kill on close, no breakaway): "ready <pid> <start ms>", or why not. */
  public static string Create(string name) {
    job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) return "error create " + Marshal.GetLastWin32Error();
    if (Marshal.GetLastWin32Error() == 183) return "error exists";
    var info = new ExtLimits();
    info.basic.flags = KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(ExtLimits)))) return "error limits " + Marshal.GetLastWin32Error();
    var me = System.Diagnostics.Process.GetCurrentProcess();
    return "ready " + me.Id + " " + new DateTimeOffset(me.StartTime).ToUnixTimeMilliseconds();
  }
  static uint Active(IntPtr h) {
    var a = new Accounting();
    if (!QueryInformationJobObject(h, 1, ref a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return uint.MaxValue;
    return a.active;
  }
  /** Ends every process in a job and waits (15 s at most) until it has none: "ended", or "busy <n>". */
  static string End(IntPtr h) {
    TerminateJobObject(h, 1);
    for (int i = 0; i < 150; i++) {
      uint n = Active(h);
      if (n == 0) return "ended";
      System.Threading.Thread.Sleep(100);
    }
    return "busy " + Active(h);
  }
  public static string Answer(string line) {
    var a = line.Split(' ');
    try {
      switch (a[0]) {
        case "assign": {
          // A launcher, while it is the process that started between the two readings (its pid can't be another's).
          int pid = int.Parse(a[1]); long after = long.Parse(a[2]), before = long.Parse(a[3]);
          IntPtr p = OpenProcess(0x0100 | 0x0001 | 0x1000, false, pid);
          if (p == IntPtr.Zero) return "no open " + Marshal.GetLastWin32Error();
          try {
            long c, e, k, u;
            if (!GetProcessTimes(p, out c, out e, out k, out u)) return "no times";
            long at = Ms(c);
            if (at < after - 50 || at > before + 50) return "no other " + at;
            if (!AssignProcessToJobObject(job, p)) return "no assign " + Marshal.GetLastWin32Error();
            return "ok " + at;
          } finally { CloseHandle(p); }
        }
        case "end": return End(job);
        case "active": return "active " + Active(job);
        case "endjob": {
          // Another lease's job, by its name: gone (closed, so the system ended what was in it) or ended now.
          IntPtr h = OpenJobObjectW(0x0008 | 0x0004, false, a[1]);
          if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "nojob" : "error open " + Marshal.GetLastWin32Error();
          try { return End(h); } finally { CloseHandle(h); }
        }
        default: return "error unknown";
      }
    } catch (Exception x) { return "error " + x.Message.Replace("\n", " "); }
  }
}
`

/**
 * The supervisor's loop: the C# first on its input (a line of base64), then the job's name; one reply per request.
 * Its input closing (Hive gone) ends it, and so the job and all in it.
 */
const SCRIPT = `
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))
[Console]::Out.WriteLine([HiveQueueJob]::Create([Console]::In.ReadLine()))
while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([HiveQueueJob]::Answer($line)) }
`

/**
 * Tests only (`linger`): a supervisor that outlives its Hive, as one whose Hive's job didn't end it would. A detached
 * Node relay (PowerShell started detached gets no console, and reads nothing) starts it and passes its input on, but
 * never closes it: so it stays when its Hive has gone, until it is ended. The relay ends with it.
 */
const RELAY = `
// A process of its own, not Hive's: its exit isn't one of Hive's ways out (exitBy).
const end = process.exit.bind(process)
const p = require('child_process').spawn(process.argv[1], process.argv.slice(2), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
process.stdin.on('data', (d) => p.stdin.write(d))
process.stdin.on('error', () => {})
p.stdout.on('data', (d) => { try { process.stdout.write(d) } catch {} })
process.stdout.on('error', () => {})
p.on('exit', () => end(0))
`

/** A lease's job name, in this Windows session. */
export const jobName = (lease: string): string => `Local\\HiveQueue-${lease}`

/** How long the supervisor gets to compile its C# and make the job (antivirus may scan it). */
const START_MS = 60_000

/** A lease's job and the process holding it. */
export class JobSupervisor {
  private queue: Promise<unknown> = Promise.resolve()
  private lines: string[] = []
  private wake: (() => void) | null = null
  private exited = false
  readonly gone: Promise<void>

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    readonly pid: number,
    readonly started: number
  ) {
    this.gone = new Promise((res) => proc.once('exit', () => res()))
    void this.gone.then(() => {
      this.exited = true
      this.wake?.()
    })
  }

  /**
   * Starts a supervisor with a job of this name. `linger` (tests): one that outlives this process (RELAY). A
   * supervisor that can't start or make its job (PowerShell refused, the name taken) is `{ problem }`.
   */
  static async start(name: string, opts: { linger?: boolean } = {}): Promise<JobSupervisor | { problem: string }> {
    let p: ChildProcessWithoutNullStreams
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')]
      p = opts.linger
        ? spawn(process.execPath, ['-e', RELAY, POWERSHELL, ...args], { windowsHide: true, stdio: 'pipe', cwd: tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true })
        : spawn(POWERSHELL, args, { windowsHide: true, stdio: 'pipe', cwd: tmpdir() })
    } catch (e) {
      return { problem: (e as Error).message }
    }
    p.stdin.write(`${Buffer.from(SOURCE, 'utf8').toString('base64')}\n${name}\n`)
    const reply = await new Promise<string>((res) => {
      let buf = ''
      const timer = setTimeout(() => res('error the supervisor did not start in time'), START_MS) // i18n-ignore: a reason, logged
      const done = (s: string): void => {
        clearTimeout(timer)
        p.stdout.removeAllListeners('data')
        res(s)
      }
      p.stdout.on('data', (d) => {
        buf += String(d)
        const i = buf.indexOf('\n')
        if (i >= 0) done(buf.slice(0, i).trim())
      })
      p.once('exit', () => done('error the supervisor exited')) // i18n-ignore: a reason, logged
      p.once('error', (e) => done(`error ${e.message}`))
    })
    const m = /^ready (\d+) (\d+)$/.exec(reply)
    if (!m) {
      p.kill()
      return { problem: reply.replace(/^error /, '') }
    }
    const s = new JobSupervisor(p, Number(m[1]), Number(m[2]))
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += String(d)
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        s.lines.push(buf.slice(0, i).trim())
        buf = buf.slice(i + 1)
        s.wake?.()
      }
    })
    if (opts.linger) p.unref()
    return s
  }

  get alive(): boolean {
    return !this.exited
  }

  /** One request and its reply, in turn; `error gone` once the supervisor has exited. */
  private ask(line: string): Promise<string> {
    const run = this.queue.then(async () => {
      if (this.exited) return 'error gone'
      this.proc.stdin.write(`${line}\n`)
      while (!this.lines.length) {
        if (this.exited) return 'error gone'
        await new Promise<void>((res) => (this.wake = res))
        this.wake = null
      }
      return this.lines.shift()!
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Puts a process in the job, only while it is the one that started between the two readings (Unix ms). */
  async assign(pid: number, after: number, before: number): Promise<boolean> {
    return (await this.ask(`assign ${pid} ${after} ${before}`)).startsWith('ok ')
  }

  /** Ends every process in the job and waits until it has none: true once it has none. */
  async end(): Promise<boolean> {
    return (await this.ask('end')) === 'ended'
  }

  /** Another lease's job: ended and seen empty, or gone (closed: the system ended what was in it). False otherwise. */
  async endJob(name: string): Promise<boolean> {
    const r = await this.ask(`endjob ${name}`)
    return r === 'ended' || r === 'nojob'
  }

  /** Closes its input (the job closes with it, ending anything left in it) and waits for it to exit. */
  async close(): Promise<void> {
    await this.queue
    this.proc.stdin.end()
    const t = setTimeout(() => this.proc.kill(), 10_000)
    await this.gone
    clearTimeout(t)
  }
}

/**
 * The launcher (run by Node): waits for its input's first line, then runs the command it was given (HIVE_QUEUE_LAUNCH,
 * JSON: command, args, shell) with its own output and what follows on its input, and exits with its code. Its input
 * closing before that line (Hive gone, or the launch given up) ends it with nothing run.
 */
const LAUNCHER = `
// A process of its own, not Hive's: its exit isn't one of Hive's ways out (exitBy).
const end = process.exit.bind(process)
let got = '', started = false
process.stdin.on('data', (d) => {
  if (started) return
  got += d
  const i = got.indexOf('\\n')
  if (i < 0) return
  started = true
  const spec = JSON.parse(process.env.HIVE_QUEUE_LAUNCH)
  delete process.env.HIVE_QUEUE_LAUNCH
  if (process.env.HIVE_QUEUE_RUN_AS_NODE !== undefined) process.env.ELECTRON_RUN_AS_NODE = process.env.HIVE_QUEUE_RUN_AS_NODE
  else delete process.env.ELECTRON_RUN_AS_NODE
  delete process.env.HIVE_QUEUE_RUN_AS_NODE
  const c = require('child_process').spawn(spec.command, spec.args, { stdio: ['pipe', 'inherit', 'inherit'], shell: !!spec.shell, windowsHide: true })
  c.stdin.on('error', () => {})
  const rest = got.slice(i + 1)
  if (rest) c.stdin.write(rest)
  process.stdin.removeAllListeners('data')
  process.stdin.pipe(c.stdin)
  c.on('error', (e) => { process.stderr.write(String(e && e.message)); end(127) })
  c.on('exit', (code, signal) => end(code === null ? 1 : code))
})
process.stdin.on('end', () => { if (!started) end(70) })
`

/**
 * Starts a command's launcher, waiting: detached (outside Hive's own job), hidden, in `cwd` with `env`. Hive's own
 * executable runs it as Node (ELECTRON_RUN_AS_NODE, which the command gets back as it was). The clock readings either
 * side of its start come back with it, for the job's check and the record.
 */
export function startLauncher(spec: { command: string; args: readonly string[]; shell?: boolean }, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { child: ChildProcess; after: number; before: number } {
  const env = opts.env ?? process.env
  const launchEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', HIVE_QUEUE_LAUNCH: JSON.stringify(spec) }
  if (env.ELECTRON_RUN_AS_NODE !== undefined) launchEnv.HIVE_QUEUE_RUN_AS_NODE = env.ELECTRON_RUN_AS_NODE
  else delete launchEnv.HIVE_QUEUE_RUN_AS_NODE
  const after = Date.now()
  const child = spawn(process.execPath, ['-e', LAUNCHER], { cwd: opts.cwd, env: launchEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
  return { child, after, before: Date.now() }
}
