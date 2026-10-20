// hive-progress: runs a command with its output passed through and its exit code returned, and reports it to the Hive
// that launched the agent (report.mts) as a run with an estimate and, when the command prints step lines, steps.
// Outside Hive, or with Hive unreachable, it just runs the command. Node built-ins only (it runs outside the asar).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { estimateFor, ProgressRun, progressTarget, recordTiming, resolveRun, type Fetch, type ProgressStart, type RunLink } from './report.mts'

export const USAGE = `Usage: hive-progress [--title <title>] [--card <card>] [--revision <commit>] -- <command> [args...]
       hive-progress --check <name> [--title <title>] [--card <card>] [--revision <commit>]

Runs the command, passing its output through and returning its exit code, and shows it in Hive's Progress panel
with the time it usually takes, and the card and revision it ran for.
  --card <card>       the card it runs for ("#1061", quoted); without it, the card you are working on (yours in Doing)
  --revision <commit> the commit it runs on: it must be what is checked out here, or nothing runs; without it,
                      what is checked out when it starts
  --check <name>      runs the project's command for that check (the project's options name it), not one of yours
A line the command prints like
  ##hive-progress step=4 total=12 name=carddialog
says step 4 of 12 (carddialog) is starting, and isn't shown. The first total given is the run's: give it within the
first 2 seconds for a bar with steps from the start, or later for one from then on.
  ##hive-progress wait=a test slot (held by B4)
says the command waits (for a queue, a lock) and for what: no time left is shown meanwhile, and the wait doesn't count
against the usual time; "##hive-progress wait=" says it waits no more. A command interrupted by Ctrl+C shows as
stopped, and one whose hive-progress is killed as ended without a report. Outside Hive it just runs the command.
HIVE_PROGRESS=0 turns reporting off.`

/** What the options say: a title, and what the run is for (#1220): its card, its revision, the check it runs. */
export interface WrapperOptions {
  title?: string
  card?: string
  revision?: string
  check?: string
}

/** The command to run (empty with --check: the project's command for it runs), or help, or what's wrong. */
export type WrapperArgs = (WrapperOptions & { command: string[] }) | { help: true } | { error: string }

const VALUED = /^--(title|card|revision|check)(?:=([\s\S]*))?$/

export function parseArgs(argv: string[]): WrapperArgs {
  const opts: WrapperOptions = {}
  const done = (command: string[], afterDashes: boolean): WrapperArgs => {
    if (opts.check !== undefined) return command.length ? { error: `--check runs the project's command for ${opts.check || 'the check'}: give no command of your own.` } : { ...opts, command }
    if (command.length) return { ...opts, command }
    return { error: afterDashes ? 'No command after --.' : 'No command given.' }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') return done(argv.slice(i + 1), true)
    if (a === '--help' || a === '-h') return { help: true }
    const v = VALUED.exec(a)
    if (v) {
      const name = v[1] as keyof WrapperOptions
      if (v[2] === undefined && i + 1 >= argv.length) return { error: name === 'card' ? '--card needs a value: quote it, as in --card "#1061" (a shell takes an unquoted # for the start of a comment).' : `--${name} needs a value.` }
      opts[name] = v[2] ?? argv[++i]
    } else if (a === '--isolated') return { error: '--isolated (a check run in a copy of its own) comes with check copies in a later Hive: run the check without it.' }
    else if (a.startsWith('-')) return { error: `Unknown option ${a}.` }
    else return done(argv.slice(i), false)
  }
  return done([], false)
}

const STEP_PREFIX = '##hive-progress'

/** What a step line says: the step starting now (from 1), how many there are, and its name; or a log the command wrote. */
export interface StepLine {
  step?: number
  total?: number
  name?: string
  /** "##hive-progress log=<path>": a log or run record (the rest of the line), for the run's details. */
  log?: string
  /** "##hive-progress wait=<what>": it waits for that (the rest of the line, #549); '' when it waits no more. */
  wait?: string
}

/** A step line ("##hive-progress step=4 total=12 name=carddialog": name, log and wait are the rest of the line), or null. */
export function stepLine(line: string): StepLine | null {
  const m = /^##hive-progress(?:[ \t]+(.*?))?[ \t]*\r?\n?$/.exec(line)
  if (!m) return null
  const u: StepLine = {}
  let rest = m[1] ?? ''
  while (rest) {
    const kv = /^(\w+)=(\S*)[ \t]*/.exec(rest)
    if (!kv) break
    const [all, key, value] = kv
    if (key === 'name' || key === 'log' || key === 'wait') {
      u[key] = rest.slice(key.length + 1).trim()
      break
    }
    const n = /^\d+$/.test(value) ? Number(value) : NaN
    if (key === 'step' && Number.isSafeInteger(n)) u.step = n
    else if (key === 'total' && Number.isSafeInteger(n)) u.total = n
    rest = rest.slice(all.length)
  }
  return u
}

/**
 * Passes output through, taking out step lines. A line is held back only while it may still turn out to be one
 * (it starts like "##hive-progress" and hasn't ended); any other partial line goes out at once, so prompts and
 * progress bars without a newline still show.
 */
export class StepFilter {
  private held: Buffer = Buffer.alloc(0)
  private atLineStart = true
  private readonly prefix = Buffer.from(STEP_PREFIX)
  constructor(
    private readonly write: (b: Buffer) => void,
    private readonly onStep: (u: StepLine) => void
  ) {}

  push(chunk: Buffer): void {
    const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk
    this.held = Buffer.alloc(0)
    const out: Buffer[] = []
    let i = 0
    while (i < data.length) {
      const nl = data.indexOf(10, i)
      if (!this.atLineStart) {
        out.push(data.subarray(i, nl === -1 ? data.length : nl + 1))
        if (nl === -1) break
        i = nl + 1
        this.atLineStart = true
        continue
      }
      if (nl === -1) {
        const rest = data.subarray(i)
        const n = Math.min(rest.length, this.prefix.length)
        if (rest.subarray(0, n).equals(this.prefix.subarray(0, n))) this.held = Buffer.from(rest)
        else {
          out.push(rest)
          this.atLineStart = false
        }
        break
      }
      const line = data.subarray(i, nl + 1)
      const step = line.subarray(0, this.prefix.length).equals(this.prefix) ? stepLine(line.toString('utf8')) : null
      if (step) this.onStep(step)
      else out.push(line)
      i = nl + 1
    }
    if (out.length) this.write(out.length === 1 ? out[0] : Buffer.concat(out))
  }

  /** The output ended: a held line goes out (or is taken as a step). */
  end(): void {
    if (!this.held.length) return
    const step = stepLine(this.held.toString('utf8'))
    if (step) this.onStep(step)
    else this.write(this.held)
    this.held = Buffer.alloc(0)
  }
}

// Windows: a command that isn't an .exe (npm.cmd, a .bat, a cmd built-in) needs cmd.exe, whose own parsing of the
// line has to be escaped: the approach cross-spawn takes (each argument quoted for the program, then cmd's special
// characters escaped with ^; twice for npm's node_modules\.bin shims, which hand the line to cmd again).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export function cmdEscapeCommand(cmd: string): string {
  return cmd.replace(CMD_META, '^$1')
}

export function cmdEscapeArgument(arg: string, twice = false): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`.replace(CMD_META, '^$1')
  return twice ? a.replace(CMD_META, '^$1') : a
}

/** The file a command name runs (PATH and PATHEXT, as cmd looks it up), or null when it isn't a file. */
export function resolveCommand(cmd: string, env: Record<string, string | undefined>, cwd: string): string | null {
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const isFile = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isFile()
    } catch {
      return false
    }
  }
  const tryAt = (base: string): string | null => {
    if (extname(base) && isFile(base)) return base
    for (const e of exts) if (isFile(base + e)) return base + e
    return null
  }
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return tryAt(isAbsolute(cmd) ? cmd : join(cwd, cmd))
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
  for (const dir of [cwd, ...(pathKey ? (env[pathKey] ?? '').split(delimiter) : [])].filter(Boolean)) {
    const hit = tryAt(join(dir, cmd))
    if (hit) return hit
  }
  return null
}

/** How to start the command: directly, or (Windows, not an .exe) through cmd.exe with its line escaped. */
export function spawnSpec(command: string[], env: Record<string, string | undefined>, cwd: string, platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  const [cmd, ...args] = command
  if (platform !== 'win32') return { file: cmd, args, verbatim: false }
  const file = resolveCommand(cmd, env, cwd)
  if (file && /\.(exe|com)$/i.test(file)) return { file, args, verbatim: false }
  const twice = !!file && /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file)
  const line = [cmdEscapeCommand(file ?? cmd), ...args.map((a) => cmdEscapeArgument(a, twice))].join(' ')
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** How to start a check's configured command (a command line, as the project's options give it): through the shell. */
export function shellSpec(command: string, env: Record<string, string | undefined>, platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c', command], verbatim: false }
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
}

/** The command line as shown: arguments with spaces or quotes quoted. */
export function commandLabel(command: string[]): string {
  return command.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ')
}

/** What a run's timings are kept under: the command line in its folder (hashed: no paths or arguments are stored). */
export function timingKey(cwd: string, command: string[]): string {
  return createHash('sha256').update(`${cwd.toLowerCase()}\0${command.join('\0')}`).digest('hex').slice(0, 32)
}

export interface WrapperIo {
  env: Record<string, string | undefined>
  cwd: string
  stdout: { write(b: Buffer | string): unknown }
  stderr: { write(b: Buffer | string): unknown }
  stdin?: 'inherit' | 'ignore'
  /** For tests: the API calls (report.mts's fetch) and the update interval. */
  fetch?: Fetch
  minIntervalMs?: number
  /** How long the run waits for a step line with the total before it is reported without (default 2 s). */
  startWaitMs?: number
  /** Whether hive-progress runs in Hive's executable as Node (default: whether it does); tests set it. */
  viaElectron?: boolean
  /** The stop signals it listens for (default STOP_SIGNALS); tests pass none, or their own. */
  signals?: NodeJS.Signals[]
}

/**
 * The command's run as reported: it starts at the first step line that gives the total, or after `waitMs`, so steps
 * the command announces at once show as steps from the start. A run started without a total takes the first one given
 * later (the API takes a late total once); later totals are ignored. Step lines name the step starting (from 1); the
 * API counts the steps finished.
 */
class WrappedRun {
  private run: ProgressRun | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private total: number | undefined
  private step: number | undefined
  private name: string | undefined
  private log: string | undefined
  /** What it waits for now, and since when; how long it waited before (#549). */
  private waiting = ''
  private waitStart = 0
  private waitedBefore = 0
  constructor(
    private readonly start: () => { title: string; command: string; titleFromCommand: boolean; estimateMs?: number; started: number; link: Partial<ProgressStart> },
    private readonly opts: { fetch?: Fetch; minIntervalMs?: number; target: NonNullable<ReturnType<typeof progressTarget>> },
    waitMs: number
  ) {
    this.timer = setTimeout(() => this.begin(), waitMs)
  }

  private begin(): void {
    if (this.run) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const s = this.start()
    const left = s.estimateMs === undefined ? undefined : Math.max(0, s.estimateMs - (Date.now() - s.started))
    this.run = new ProgressRun(this.opts.target, { ...s.link, title: s.title, command: s.command, titleFromCommand: s.titleFromCommand, total: this.total, step: this.step, stepName: this.name, estimateMs: left, ...(this.waiting ? { waiting: this.waiting } : {}) }, { fetch: this.opts.fetch, minIntervalMs: this.opts.minIntervalMs })
  }

  /** How long the command has waited in all (its wait lines), so far. */
  waitedMs(now = Date.now()): number {
    return this.waitedBefore + (this.waiting ? now - this.waitStart : 0)
  }

  onStep(u: StepLine): void {
    if (u.log) this.log = u.log
    if (u.wait !== undefined) {
      const now = Date.now()
      if (u.wait && !this.waiting) this.waitStart = now
      if (!u.wait && this.waiting) this.waitedBefore += now - this.waitStart
      this.waiting = u.wait
      // A wait shows at once (not after the start's wait for a total): the run starts waiting.
      if (!this.run) this.begin()
      else this.run.update({ waiting: u.wait })
    }
    if (u.step === undefined && u.total === undefined && u.name === undefined) return
    if (u.step !== undefined) this.step = Math.max(0, u.step - 1)
    if (u.name !== undefined) this.name = u.name
    if (!this.run) {
      if (u.total !== undefined && u.total > 0) {
        this.total = u.total
        this.begin()
      }
      return
    }
    const late = this.total === undefined && u.total !== undefined && u.total > 0 ? u.total : undefined
    if (late !== undefined) this.total = late
    this.run.update({ ...(late !== undefined ? { total: late, step: this.step ?? 0 } : {}), ...(u.step !== undefined ? { step: this.step } : {}), ...(u.name !== undefined ? { stepName: u.name } : {}) })
  }

  async finish(ok: boolean, summary: string | undefined, exitCode: number, stopped = false): Promise<void> {
    this.begin()
    await this.run!.finish(ok, summary, undefined, { exitCode, ...(this.log ? { logPath: this.log } : {}), ...(stopped ? { stopped: true } : {}) })
  }
}

/**
 * The command's environment: the caller's, without what hive-progress was started with. Run by Hive's executable as
 * Node (its shims), ELECTRON_RUN_AS_NODE is the shims' own: the command gets the caller's value back (kept in
 * HIVE_PROGRESS_RUN_AS_NODE; usually none), so an Electron app it starts runs as an app.
 */
export function commandEnv(env: Record<string, string | undefined>, viaElectron: boolean): Record<string, string | undefined> {
  const out = { ...env }
  if (viaElectron) {
    delete out.ELECTRON_RUN_AS_NODE
    if (env.HIVE_PROGRESS_RUN_AS_NODE) out.ELECTRON_RUN_AS_NODE = env.HIVE_PROGRESS_RUN_AS_NODE
  }
  delete out.HIVE_PROGRESS_RUN_AS_NODE
  delete out.HIVE_PROGRESS_DATA
  return out
}

/**
 * Whether the command ended by an interrupt (#549): Windows' STATUS_CONTROL_C_EXIT (0xC000013A, what a console program
 * Ctrl+C ends exits with), a shell's 130 (128 + SIGINT), or a signal; or hive-progress itself was sent one.
 */
export function wasInterrupted(code: number, signal: NodeJS.Signals | null, signalled: boolean): boolean {
  return signalled || signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGBREAK' || code === 0xc000013a || code === -1073741510 || code === 130
}

/** The signals that mean "stop" (Ctrl+C, Ctrl+Break, the console closing, a polite kill), where the wrapper gets them. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGTERM']
/** How long the command gets to end by itself after hive-progress is told to stop, before it is ended. */
const STOP_GRACE_MS = 5000
/** Once the command has been ended, how long its output may stay open (a descendant that got away) before the run ends anyway. */
const CLOSE_AFTER_KILL_MS = 2000

/** A process as Windows lists it: its id, the id its parent had, and when it started (Unix ms). */
export type ListedProcess = { pid: number; parent: number; started: number }

const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const LIST_PS = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"

/** Every process, as `LIST_PS` prints them (a line each: pid, parent, started). */
export function parseProcessList(out: string): ListedProcess[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split(' ').map(Number))
    .filter((p) => p.length === 3 && p.every(Number.isFinite) && p[0] > 0)
    .map(([pid, parent, started]) => ({ pid, parent, started }))
}

/**
 * `root` and what it started, from `list`, children before their parents (ended in that order, a parent can't start
 * another meanwhile). A parent id is only a number: one whose process ended may be another's by now, so a process that
 * started before the one its parent id names isn't its child but an older orphan, and is left alone with what it
 * started (#655). [] when `root` isn't in `list`.
 */
export function treeToEnd(list: ListedProcess[], root: number): ListedProcess[] {
  const top = list.find((p) => p.pid === root)
  if (!top) return []
  const byParent = new Map<number, ListedProcess[]>()
  for (const p of list) byParent.set(p.parent, [...(byParent.get(p.parent) ?? []), p])
  const found = [top]
  const walk = (parent: ListedProcess): void => {
    for (const k of byParent.get(parent.pid) ?? []) {
      if (k.started < parent.started || found.some((x) => x.pid === k.pid)) continue
      found.push(k)
      walk(k)
    }
  }
  walk(top)
  return found.reverse()
}

/**
 * Ends each of `targets` only while its pid still names the process listed (a handle opened, its start time checked,
 * ended through that handle), so a pid given to another process since the list was read is never ended. Returns the
 * pids it ended.
 */
function endListed(targets: ListedProcess[]): number[] {
  const list = targets.map((t) => `${t.pid}:${t.started}`).join(',')
  const ps = `foreach ($t in '${list}'.Split(',')) { $id, $at = $t.Split(':'); try { $p = [Diagnostics.Process]::GetProcessById([int]$id); $null = $p.Handle; if ([Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - [long]$at) -le 1) { $p.Kill(); $id } } catch {} }`
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  return String(r.stdout ?? '').split(/\r?\n/).map(Number).filter((n) => n > 0)
}

/**
 * Ends the command and everything it started (#549). On Windows a command that isn't an .exe runs through cmd.exe (npm,
 * a .cmd server): ending cmd alone would leave the server running, holding its port, its folder and the output pipes,
 * so the whole tree goes: listed with start times (treeToEnd: never an older process whose parent id is only a reused
 * number, as `taskkill /T` would end, #655) and each ended as the process it was when listed. If that can't run, the
 * command itself is ended (its handle is held, so its pid is still its own).
 */
export function endTree(child: ChildProcess, platform = process.platform): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (platform === 'win32' && child.pid) {
    try {
      const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', LIST_PS], { windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      const tree = treeToEnd(parseProcessList(String(r.stdout ?? '')), child.pid)
      if (tree.length && endListed(tree).includes(child.pid)) return
    } catch {
      // ended below
    }
  }
  try {
    child.kill()
  } catch {
    // already gone
  }
}

/**
 * Runs hive-progress with these arguments; resolves to the exit code to end with (the command's own).
 *
 * Stopping (#549), as Windows lets it be seen: run by Hive's shims, hive-progress is Electron run as Node, a program with
 * no console, and its command gets a hidden console of its own, so a Ctrl+C typed in the agent's terminal reaches
 * neither; an agent (or the user) stopping the command ends the whole process tree at once, which no process can see.
 * That run is told by Hive, from its pid being gone: "ended without a report". Where hive-progress does get a stop
 * signal (run by Node in a console: Ctrl+C, Ctrl+Break, the console closing), it doesn't die at once: the command
 * (which got the same Ctrl+C) has a moment to end, is ended if it doesn't, and the run is reported as stopped. A command
 * that ended by an interrupt itself (STATUS_CONTROL_C_EXIT, 130) is reported as stopped too, not failed.
 */
export async function runWrapped(argv: string[], io: WrapperIo): Promise<number> {
  const parsed = parseArgs(argv)
  if ('help' in parsed) {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }
  if ('error' in parsed) {
    io.stderr.write(`hive-progress: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const target = progressTarget(io.env)
  // A check's command is the project's (#1220), which only Hive knows.
  if (parsed.check !== undefined && !target) {
    io.stderr.write(`hive-progress: --check runs the project's command for ${parsed.check}, which only Hive knows: run it in a session Hive started, with reporting on.\n`)
    return 2
  }
  // What the run is for, checked before anything runs: a revision that isn't checked out, an unknown card or a check
  // with no command is refused here. An older Hive, or one that doesn't answer, just doesn't link it.
  let link: RunLink | null = null
  if (target) {
    const r = await resolveRun(target, { folder: io.cwd, ...(parsed.card !== undefined ? { card: parsed.card } : {}), ...(parsed.revision !== undefined ? { revision: parsed.revision } : {}), ...(parsed.check !== undefined ? { check: parsed.check } : {}) }, { fetch: io.fetch })
    if ('refused' in r) {
      io.stderr.write(`hive-progress: ${r.refused}\n`)
      return 2
    }
    if ('link' in r) link = r.link
    else if (parsed.check !== undefined) {
      io.stderr.write(`hive-progress: Hive couldn't be reached to look up the command for ${parsed.check}, so nothing was run.\n`)
      return 2
    }
  }
  const checkCommand = link?.check?.command
  const command = checkCommand !== undefined ? [checkCommand] : parsed.command
  const spec = checkCommand !== undefined ? shellSpec(checkCommand, io.env) : spawnSpec(parsed.command, io.env, io.cwd)
  const env = commandEnv(io.env, io.viaElectron ?? !!process.versions.electron)
  const started = Date.now()
  // Not reporting: the command runs as if hive-progress weren't there (its own console, no filtering).
  if (!target) return run(spec, env, io, null)
  // Its run is this one: a reporter inside it (Hive's test runners, another hive-progress) prints step lines instead
  // of reporting a second row (report.mts).
  env.HIVE_PROGRESS_WRAPPED = '1'
  const label = checkCommand ?? commandLabel(parsed.command)
  const timings = io.env.HIVE_PROGRESS_DATA ? join(io.env.HIVE_PROGRESS_DATA, 'timings.json') : null
  const key = timingKey(io.cwd, command)
  // A check is titled by its name (not its command line) unless given a title.
  const title = parsed.title?.trim() || link?.check?.name
  const linked: Partial<ProgressStart> = link
    ? { card: link.card, ...(link.revision ? { revision: link.revision } : {}), ...(link.testedCheckout ? { testedCheckout: link.testedCheckout } : {}), ...(link.check ? { check: link.check.name } : {}), ...(link.folder ? { folder: link.folder } : {}) }
    : {}
  const report = new WrappedRun(
    () => ({ title: title || label, command: label, titleFromCommand: !title, estimateMs: timings ? estimateFor(timings, key) : undefined, started, link: linked }),
    { target, fetch: io.fetch, minIntervalMs: io.minIntervalMs },
    io.startWaitMs ?? 2000
  )
  let signalled = false
  let child: ChildProcess | null = null
  const forced = { at: 0 }
  const end = (): void => {
    if (!child) return
    forced.at = Date.now()
    endTree(child)
  }
  const onSignal = (): void => {
    // A second stop ends the command (and what it started) at once; the first gives it a moment (it got the same Ctrl+C).
    if (signalled) return end()
    signalled = true
    setTimeout(end, STOP_GRACE_MS).unref()
  }
  const signals = (io.signals ?? STOP_SIGNALS).filter((s) => {
    try {
      process.on(s, onSignal)
      return true
    } catch {
      return false
    }
  })
  const ended = { signal: null as NodeJS.Signals | null }
  const code = await run(spec, env, io, (u) => report.onStep(u), (c) => (child = c), ended, forced)
  for (const s of signals) process.off(s, onSignal)
  // Told to stop, it is stopped however it then ended (a server shutting down cleanly exits 0); a command that ended by
  // an interrupt of its own is stopped too. Its exit code is passed on as it was.
  const stopped = signalled || (code !== 0 && wasInterrupted(code, ended.signal, false))
  const passed = code === 0 && !stopped
  // The time it usually takes: from runs that passed only, leaving out the time it waited (a queue, a lock).
  if (passed && timings) recordTiming(timings, key, Math.max(0, Date.now() - started - report.waitedMs()))
  await report.finish(passed, passed ? undefined : stopped ? 'interrupted' : `exit code ${code}`, code, stopped)
  return code
}

function run(
  spec: { file: string; args: string[]; verbatim: boolean },
  env: Record<string, string | undefined>,
  io: WrapperIo,
  onStep: ((u: StepLine) => void) | null,
  onChild?: (c: ChildProcess) => void,
  ended?: { signal: NodeJS.Signals | null },
  forced?: { at: number }
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(spec.file, spec.args, {
        cwd: io.cwd,
        env,
        stdio: [io.stdin ?? 'inherit', onStep ? 'pipe' : 'inherit', onStep ? 'pipe' : 'inherit'],
        windowsVerbatimArguments: spec.verbatim,
        // The wrapper runs as Electron (a GUI program) with no console of its own, so the command gets a new one: shown,
        // it is a terminal window popping up (Windows Terminal, when it is the default). Hidden, the output still comes
        // through, and windows the command opens itself still show (only cmd's own window is hidden).
        windowsHide: true
      })
    } catch (e) {
      io.stderr.write(`hive-progress: ${(e as Error).message}\n`)
      return resolve(127)
    }
    onChild?.(child)
    const filters: StepFilter[] = []
    if (onStep) {
      for (const [stream, to] of [
        [child.stdout, io.stdout],
        [child.stderr, io.stderr]
      ] as const) {
        const f = new StepFilter((b) => to.write(b), onStep)
        filters.push(f)
        stream?.on('data', (d: Buffer) => f.push(d))
      }
    }
    let settled = false
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      io.stderr.write(`hive-progress: ${e.code === 'ENOENT' ? `${spec.file}: command not found` : e.message}\n`)
      resolve(e.code === 'ENOENT' ? 127 : 1)
    })
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      for (const f of filters) f.end()
      if (ended) ended.signal = signal
      resolve(code ?? (signal ? 1 : 0))
    }
    child.on('close', done)
    // Ended by hive-progress: its output may be held open by something that got away; the run ends a moment after it.
    child.on('exit', (code, signal) => {
      if (forced?.at) setTimeout(() => done(code, signal), CLOSE_AFTER_KILL_MS).unref()
    })
  })
}
