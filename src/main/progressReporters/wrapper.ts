// hive-progress: runs a command with its output passed through and its exit code returned, and reports it to the Hive
// that launched the agent (report.mts) as a run with an estimate and, when the command prints step lines, steps.
// Outside Hive, or with Hive unreachable, it just runs the command. Node built-ins only (it runs outside the asar).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { assignIsolated, estimateFor, ProgressRun, progressTarget, recordTiming, resolveRun, type Fetch, type FinishOutcome, type IsolatedAssign, type ProgressStart, type RunLink, type Unreachable } from './report.mts'
import { startLauncher } from '../workflow/launcher'
import { agentMsg, inDefaultDialect, say, type AgentMsg } from '../../shared/agentText'

/**
 * What hive-progress says (agent text, HI-2065): its usage, refusals and run lines. It runs as the session's own process,
 * so it speaks the session's dialect (processDialect.ts, loaded first by cw-progress.ts). "hive-progress: " before a
 * line is the command's name, as a shell's error says it: protocol, not wording.
 */
const A = {
  usage: agentMsg({
    id: 'progress.usage',
    text: `Usage: cw-progress [--title <title>] [--card <card>] [--revision <commit>] -- <command> [args...]
       cw-progress --check <name> [--isolated] [--title <title>] [--card <card>] [--revision <commit>]

Runs the command, passing its output through and returning its exit code, and shows it in Combwork's Progress panel
with the time it usually takes, and the card and revision it ran for.
  --card <card>       the card it runs for ("#1061", quoted); without it, the card you are working on (yours in Doing)
  --revision <commit> the commit it runs on: it must be what is checked out here, or nothing runs; without it,
                      what is checked out when it starts
  --check <name>      runs the project's command for that check (the project's options name it), not one of yours;
                      focused:<test> (a card's focused test) runs your command after -- as that test's check
  --isolated          with --check: runs it in a check copy of its own at the card's revision, which nothing else
                      writes, so another agent's edits here can't spoil it (waits for a copy when none is free)
A line the command prints like
  ##cw-progress step=4 total=12 name=carddialog
says step 4 of 12 (carddialog) is starting, and isn't shown. The first total given is the run's: give it within the
first 2 seconds for a bar with steps from the start, or later for one from then on.
  ##cw-progress wait=a test slot (held by B4)
says the command waits (for a queue, a lock) and for what: no time left is shown meanwhile, and the wait doesn't count
against the usual time; "##cw-progress wait=" says it waits no more. A command interrupted by Ctrl+C shows as
stopped, and one whose cw-progress is killed as ended without a report. Outside Combwork it just runs the command.
CW_PROGRESS=0 turns reporting off.`,
    note: '#1220 (--card, --revision, --check), #1435 (--isolated), HI-1367 (focused:<test>), #549 (wait=). Printed by --help and after a wrong option.'
  }),
  focusedNeedsCommand: agentMsg({
    id: 'progress.args.focusedNeedsCommand',
    text: '--check {check} runs the command you give after -- for that test.',
    note: "HI-1367: a focused test's check (focused:<test>) runs a command of the caller's own. check: the check as given."
  }),
  checkNoCommand: agentMsg({
    id: 'progress.args.checkNoCommand',
    text: "--check runs the project's command for {named, select, yes {{check}} other {the check}}: give no command of your own.",
    note: "#1220: a check's command is the project's. named: yes when the check has a name (check)."
  }),
  isolatedNeedsCheck: agentMsg({ id: 'progress.args.isolatedNeedsCheck', text: '--isolated runs a check in a copy of its own: use it with --check <name>.', note: '#1435: --isolated is for checks only.' }),
  cardNeedsValue: agentMsg({
    id: 'progress.args.cardNeedsValue',
    text: '--card needs a value: the card\'s key, as in --card HI-12 (an old --card "#1061" needs its quotes: a shell takes an unquoted # for the start of a comment).',
    note: '#1219: cards are named by key; an unquoted #1061 in a shell is a comment, which leaves --card with no value.'
  }),
  needsValue: agentMsg({ id: 'progress.args.needsValue', text: '--{option} needs a value.', note: 'option: title, revision or check, given last with no value.' }),
  unknownOption: agentMsg({ id: 'progress.args.unknownOption', text: 'Unknown option {option}.', note: 'option: as given.' }),
  noCommandAfterDashes: agentMsg({ id: 'progress.args.noCommandAfterDashes', text: 'No command after --.' }),
  noCommand: agentMsg({ id: 'progress.args.noCommand', text: 'No command given.' }),
  revisionForm: agentMsg({
    id: 'progress.revision.form',
    text: 'revision is a commit (its id, or a name git knows)',
    note: "Checked with git itself when Combwork can't check it (reporting off, outside Combwork), in the same words as Combwork's refusal (check.link.revisionForm)."
  }),
  nothingCheckedOut: agentMsg({
    id: 'progress.revision.nothingCheckedOut',
    text: "Nothing is checked out in {folder} to compare {named} with (or git can't read it): leave --revision out",
    note: 'folder: where it runs; named: the revision given. A folder git cannot read refuses too: a revision that cannot be checked is not taken.'
  }),
  notACommit: agentMsg({ id: 'progress.revision.notACommit', text: "{named} isn't a commit in {folder}", note: 'named: the revision given; folder: where it runs.' }),
  notCheckedOut: agentMsg({
    id: 'progress.revision.notCheckedOut',
    text: "{named} isn't what's checked out here ({head} is): check it out first, or leave --revision out",
    note: '#1220: a run is checked against what is checked out where it runs. head: that commit, short.'
  }),
  slow: agentMsg({
    id: 'progress.unanswered.slow',
    text: 'Combwork is slow to answer: no reply {lend, select, yes {to lend a check copy} other {to look up the command for {check}}} in {seconds} s{retried, select, yes {, asked {asked} times} other {}}, so nothing was run. Try again; Settings → Advanced → "cw-progress: Combwork\'s reply time" gives it longer.',
    note: "HI-1892: Combwork is there but busy. lend: yes for an isolated check's copy (#1435), else the check's command (check) was asked for. retried: yes when it was asked more than once (asked)."
  }),
  refused: agentMsg({
    id: 'progress.unanswered.refused',
    text: "Combwork couldn't be reached {lend, select, yes {to lend a check copy} other {to look up the command for {check}}} (connection {refused, select, yes {refused} other {not allowed: {detail}}} at {url}), so nothing was run. Is Combwork running? A sandbox that blocks local network access (Claude Code's Bash sandbox does) stops it too: run the command outside the sandbox.",
    note: "HI-1892: nothing listens at Combwork's address, or this process may not reach it. refused: yes for a refused connection, else detail is the error's code (EACCES, EPERM). url: Combwork's address."
  }),
  answered: agentMsg({
    id: 'progress.unanswered.answered',
    text: "Combwork couldn't be reached {lend, select, yes {to lend a check copy} other {to look up the command for {check}}} (Combwork answered {status, select, none {with an error} other {{status}}}), so nothing was run.",
    note: 'HI-1892: Combwork answered with no link (an older Combwork without the call, an error). status: its HTTP status, or none.'
  }),
  failed: agentMsg({
    id: 'progress.unanswered.failed',
    text: "Combwork couldn't be reached {lend, select, yes {to lend a check copy} other {to look up the command for {check}}} ({detail}), so nothing was run.",
    note: "HI-1892: the call failed some other way. detail: the error's message."
  }),
  noStart: agentMsg({
    id: 'progress.unrecorded.noStart',
    text: "Combwork didn't take this run's report (no reply in time), so check {check} wasn't recorded: run it again.",
    note: "HI-1892: Combwork never took the run's start."
  }),
  noReply: agentMsg({
    id: 'progress.unrecorded.noReply',
    text: "Combwork didn't confirm it recorded check {check} (no reply to its result, asked twice): if submitting says it hasn't passed, run it again.",
    note: "HI-1892: the run's finish got no reply, sent twice."
  }),
  refusedResult: agentMsg({ id: 'progress.unrecorded.refused', text: "Combwork refused this run's result, so check {check} may not be recorded: run it again.", note: "HI-1892: Combwork answered the finish with an error." }),
  endedBefore: agentMsg({
    id: 'progress.unrecorded.endedBefore',
    text: "Combwork recorded check {check}, but its reply was lost, so how it counted isn't known.",
    note: 'HI-1892: a finish sent again found the first had arrived (its reply lost).'
  }),
  notCheck: agentMsg({
    id: 'progress.uncounted.notCheck',
    text: "not counted as check {check}: Combwork didn't see the check's configured command run. Run it again with cw-progress --check {check}.",
    note: '#1654: what happened, then what to do, so an agent is not left running the same command again for a submit that keeps refusing.'
  }),
  notContained: agentMsg({
    id: 'progress.uncounted.notContained',
    text: "not counted as check {check}: what is checked out here doesn't contain the card's revision. Run it in the card's own folder, at its revision.",
    note: '#1654.'
  }),
  dirty: agentMsg({
    id: 'progress.uncounted.dirty',
    text: 'not counted as check {check}: the folder had uncommitted changes{listed, select, yes { ({changes})} other {}}. Commit or remove them, then run it again.',
    note: "#1654. changes: what changed (paths, or progress.change.*), joined with \", \"; listed: yes when there are any."
  }),
  moved: agentMsg({ id: 'progress.uncounted.moved', text: 'not counted as check {check}: something else was checked out by the time it ended. Run it again.', note: '#1654.' }),
  changed: agentMsg({
    id: 'progress.uncounted.changed',
    text: 'not counted as check {check}: files changed in the folder while it ran{listed, select, yes { ({changes})} other {}}. Run it again with nothing else writing in the folder{isolate, select, yes {, or with --isolated (a check copy of its own)} other {}}.',
    note: '#1654. changes: what changed, joined with ", "; listed: yes when there are any. isolate: yes when --isolated (#1435) would help (a git project, not isolated already).'
  }),
  revisionChanged: agentMsg({ id: 'progress.uncounted.revisionChanged', text: "not counted as check {check}: the card's declared files changed while it ran. Run it again.", note: '#1654: a card on the None platform (#1233).' }),
  changeReflog: agentMsg({ id: 'progress.change.reflog', text: 'a commit or checkout', note: "What a write log's :reflog mark records, in the list of what changed while a check ran." }),
  changeEdit: agentMsg({ id: 'progress.change.edit', text: "an agent's edit", note: "What a write log's :edit mark records, in the list of what changed while a check ran." }),
  checkOutsideCombwork: agentMsg({
    id: 'progress.check.outsideCombwork',
    text: "--check runs the project's command for {check}, which only Combwork knows: run it in a session Combwork started, with reporting on.",
    note: '#1220.'
  }),
  waiting: agentMsg({ id: 'progress.check.waiting', text: 'waiting for {what}', note: '#1435: no check copy is free. what: what it waits for, in Combwork\'s words.' }),
  exitCode: agentMsg({ id: 'progress.run.exitCode', text: 'exit code {code}', note: "A failed run's detail, stored with the run (the Default's words, whoever reads it)." }),
  launcherDidntStart: agentMsg({ id: 'progress.isolated.launcherDidntStart', text: "the check's launcher didn't start", note: '#1435.' }),
  notRunError: agentMsg({ id: 'progress.isolated.notRun', text: "the check wasn't run: {why}", note: "#1435: the launcher wasn't put in its copy's job. why: Combwork's reason, or the error." }),
  notRunStatus: agentMsg({ id: 'progress.isolated.notRunStatus', text: "the check wasn't run: Combwork answered {status}", note: "#1435: Combwork answered with an error and no reason. status: its HTTP status." }),
  notRunUnreachable: agentMsg({ id: 'progress.isolated.notRunUnreachable', text: "the check wasn't run: Combwork couldn't be reached ({detail})", note: "#1435. detail: the error's message." }),
  commandNotFound: agentMsg({ id: 'progress.run.commandNotFound', text: '{file}: command not found', note: "The command doesn't exist (ENOENT), as a shell says it; exit code 127." })
}

/** What `hive-progress --help` prints, and what follows a wrong option (said at call time: the session's dialect). */
export const usage = (): string => say(A.usage)

/** What the options say: a title, and what the run is for (#1220): its card, its revision, the check it runs. */
export interface WrapperOptions {
  title?: string
  card?: string
  revision?: string
  check?: string
  /** Run the check in a check copy (#1435). */
  isolated?: true
}

/** The command to run (empty with --check: the project's command for it runs), or help, or what's wrong. */
export type WrapperArgs = (WrapperOptions & { command: string[] }) | { help: true } | { error: string }

const VALUED = /^--(title|card|revision|check)(?:=([\s\S]*))?$/

export function parseArgs(argv: string[]): WrapperArgs {
  const opts: WrapperOptions = {}
  const done = (command: string[], afterDashes: boolean): WrapperArgs => {
    // A focused test's check (HI-1367, `focused:<test>`) runs a command of your own; any other check, the project's.
    if (opts.check !== undefined && opts.check.startsWith('focused:')) return command.length ? { ...opts, command } : { error: say(A.focusedNeedsCommand, { check: opts.check }) }
    if (opts.check !== undefined) return command.length ? { error: say(A.checkNoCommand, { named: opts.check ? 'yes' : 'no', check: opts.check }) } : { ...opts, command }
    if (opts.isolated) return { error: say(A.isolatedNeedsCheck) }
    if (command.length) return { ...opts, command }
    return { error: say(afterDashes ? A.noCommandAfterDashes : A.noCommand) }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') return done(argv.slice(i + 1), true)
    if (a === '--help' || a === '-h') return { help: true }
    const v = VALUED.exec(a)
    if (v) {
      const name = v[1] as 'title' | 'card' | 'revision' | 'check'
      if (v[2] === undefined && i + 1 >= argv.length) return { error: name === 'card' ? say(A.cardNeedsValue) : say(A.needsValue, { option: name }) }
      opts[name] = v[2] ?? argv[++i]
    } else if (a === '--isolated') opts.isolated = true
    else if (a.startsWith('-')) return { error: say(A.unknownOption, { option: a }) }
    else return done(argv.slice(i), false)
  }
  return done([], false)
}

/** Step lines' opening, the only one read (HI-2594): any other line is the command's own output. */
const STEP_PREFIX = '##cw-progress'

/** What a step line says: the step starting now (from 1), how many there are, and its name; or a log the command wrote. */
export interface StepLine {
  step?: number
  total?: number
  name?: string
  /** "##cw-progress log=<path>": a log or run record (the rest of the line), for the run's details. */
  log?: string
  /** "##cw-progress wait=<what>": it waits for that (the rest of the line, #549); '' when it waits no more. */
  wait?: string
}

/** A step line ("##cw-progress step=4 total=12 name=carddialog": name, log and wait are the rest of the line), or null. */
export function stepLine(line: string): StepLine | null {
  const m = /^##cw-progress(?:[ \t]+(.*?))?[ \t]*\r?\n?$/.exec(line)
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
 * (it starts like "##cw-progress" and hasn't ended); any other partial line goes out at once, so prompts and
 * progress bars without a newline still show.
 */
export class StepFilter {
  private held: Buffer = Buffer.alloc(0)
  private atLineStart = true
  private readonly prefixes = [Buffer.from(STEP_PREFIX)]
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
        if (this.prefixes.some((p) => rest.subarray(0, Math.min(rest.length, p.length)).equals(p.subarray(0, Math.min(rest.length, p.length))))) this.held = Buffer.from(rest)
        else {
          out.push(rest)
          this.atLineStart = false
        }
        break
      }
      const line = data.subarray(i, nl + 1)
      const step = this.prefixes.some((p) => line.subarray(0, p.length).equals(p)) ? stepLine(line.toString('utf8')) : null
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

/** A revision as git takes one, never an option: a commit id, a branch or tag, HEAD~1 (as Hive checks it). */
const REVISION = /^[\w./@^~{}-]{1,100}$/

/**
 * Why `revision` isn't what's checked out in `cwd`, or null when it is: checked with git itself when Hive can't check it,
 * in the same words as Hive's refusal. A folder git can't read refuses too: a revision that can't be checked isn't taken.
 */
export function revisionProblem(cwd: string, revision: string, env: Record<string, string | undefined>): string | null {
  const named = revision.trim()
  if (!named || named.startsWith('-') || !REVISION.test(named)) return say(A.revisionForm)
  const parse = (rev: string): string | null => {
    try {
      const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', rev], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      return r.status === 0 ? String(r.stdout).trim() || null : null
    } catch {
      return null
    }
  }
  const head = parse('HEAD')
  if (!head) return say(A.nothingCheckedOut, { folder: cwd, named })
  const id = parse(`${named}^{commit}`)
  if (!id) return say(A.notACommit, { named, folder: cwd })
  return id === head ? null : say(A.notCheckedOut, { named, head: head.slice(0, 7) })
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
  /** For tests: how often at most output tells Hive the run still goes (default KEEPALIVE_MS). */
  keepAliveMs?: number
  /** For tests: the API calls (report.mts's fetch) and the update interval. */
  fetch?: Fetch
  minIntervalMs?: number
  /**
   * How long it waits for Hive to say what the run is for, and for its start to be taken (default: Hive's setting, which
   * it hands sessions as CW_PROGRESS_REPLY_SECONDS; `replyTimeoutMs`).
   */
  resolveTimeoutMs?: number
  /** How long it waits before asking Hive again, once, when a check's ask or finish got no reply (default 1 s, HI-1892). */
  retryMs?: number
  /** How long a check's finish waits for Hive's reply (default CHECK_FINISH_WAIT_MS); tests shorten it. */
  checkFinishWaitMs?: number
  /** How long the run waits for a step line with the total before it is reported without (default 2 s). */
  startWaitMs?: number
  /** Whether hive-progress runs in Hive's executable as Node (default: whether it does); tests set it. */
  viaElectron?: boolean
  /** The stop signals it listens for (default STOP_SIGNALS); tests pass none, or their own. */
  signals?: NodeJS.Signals[]
  /** How often an isolated check waiting for a check copy asks again at first (default ISOLATED_POLL_MS). */
  isolatedPollMs?: number
}

/**
 * How long hive-progress waits for Hive's reply (HI-1892: a fixed 5 s gave up on a Hive whose main was slow): Settings →
 * Advanced, "hive-progress: Hive's reply time" (cw.progress.replySeconds), handed to sessions as
 * CW_PROGRESS_REPLY_SECONDS; without it, 15 s. Kept within 1 s to 2 minutes whatever is set, so a hung Hive never holds
 * a command for long.
 */
export const REPLY_DEFAULT_S = 15
export const REPLY_MAX_S = 120
export function replyTimeoutMs(env: Record<string, string | undefined>): number {
  const s = Number(env.CW_PROGRESS_REPLY_SECONDS)
  return Math.round(Math.min(REPLY_MAX_S, Math.max(1, Number.isFinite(s) && s > 0 ? s : REPLY_DEFAULT_S)) * 1000)
}
/** How long it waits before asking again, once (a check's ask or finish that got no reply). */
const RETRY_MS = 1000

/**
 * Why Hive gave no answer to a run that needed one, and that nothing was run (HI-1892). `check`: the check whose command
 * the answer was for, or null when it was to lend a check copy (`--isolated`, #1435). Slow: Hive is there but busy (try again; the setting gives it longer); refused:
 * nothing listens at its address, or this process may not reach it (a sandbox that blocks local network access, as
 * Claude Code's Bash sandbox does); anything else, with what happened.
 */
export function unansweredLine(u: Unreachable, check: string | null, waitedMs: number, url: string, asked: number): string {
  const what = { lend: check === null ? 'yes' : 'no', check: check ?? '' }
  if (u.why === 'slow') return say(A.slow, { ...what, seconds: String(Math.round(waitedMs / 1000)), retried: asked > 1 ? 'yes' : 'no', asked: String(asked) })
  if (u.why === 'refused') return say(A.refused, { ...what, refused: u.detail === 'ECONNREFUSED' ? 'yes' : 'no', detail: u.detail, url })
  if (u.status !== undefined) return say(A.answered, { ...what, status: u.status === null ? 'none' : String(u.status) })
  return say(A.failed, { ...what, detail: u.detail })
}

/**
 * What hive-progress says when a check's result may not have been recorded (HI-1892), or null when it was: Hive never
 * took the run's start, gave no reply to its finish (asked twice), or took a finish sent again after the first had
 * arrived (how it counted not said).
 */
export function unrecordedLine(outcome: FinishOutcome | null, check: string): string | null {
  if (outcome === 'noStart') return say(A.noStart, { check })
  if (outcome === 'noReply') return say(A.noReply, { check })
  if (outcome === 'refused') return say(A.refusedResult, { check })
  if (outcome === 'endedBefore') return say(A.endedBefore, { check })
  return null
}

/** How often an isolated check waiting for a check copy asks Hive again (#1435), for the wait's first minute. */
const ISOLATED_POLL_MS = 2000
/** After that each ask comes half as long again later, up to this (HI-1831: an hour's wait was 1,800 asks). */
const ISOLATED_POLL_PROMPT_MS = 60_000
const ISOLATED_POLL_MAX_MS = 10_000

/**
 * How long an isolated check that has waited `waitedMs` waits before asking again, after waiting `lastMs` last time:
 * `firstMs` while the wait is short, so a copy freed soon is taken at once, then backing off to ISOLATED_POLL_MAX_MS.
 */
export function isolatedPollDelay(waitedMs: number, lastMs: number, firstMs = ISOLATED_POLL_MS): number {
  if (waitedMs < ISOLATED_POLL_PROMPT_MS) return firstMs
  return Math.max(firstMs, Math.min(ISOLATED_POLL_MAX_MS, Math.round(lastMs * 1.5)))
}

/** How often at most a command's output tells Hive its run still goes (HI-1993): well within a quiet run's grace (STALE_GRACE_MS). */
export const KEEPALIVE_MS = 60_000

/** Whether output at `now` tells Hive the run still goes: once `every` ms have passed since it last did (or since its start or last step). */
export function keepAliveDue(lastAlive: number, now: number, every = KEEPALIVE_MS): boolean {
  return now - lastAlive >= every
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
  /** When it last told Hive the command still goes (output), ms. */
  private lastAlive = 0
  constructor(
    private readonly start: () => { title: string; command: string; titleFromCommand: boolean; estimateMs?: number; started: number; link: Partial<ProgressStart> },
    private readonly opts: { fetch?: Fetch; minIntervalMs?: number; target: NonNullable<ReturnType<typeof progressTarget>>; startTimeoutMs?: number; keepAliveMs?: number },
    waitMs: number
  ) {
    this.timer = setTimeout(() => this.begin(), waitMs)
  }

  private begin(): void {
    if (this.run) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const s = this.start()
    this.lastAlive = Date.now()
    const left = s.estimateMs === undefined ? undefined : Math.max(0, s.estimateMs - (Date.now() - s.started))
    this.run = new ProgressRun(this.opts.target, { ...s.link, title: s.title, command: s.command, titleFromCommand: s.titleFromCommand, total: this.total, step: this.step, stepName: this.name, estimateMs: left, ...(this.waiting ? { waiting: this.waiting } : {}) }, { fetch: this.opts.fetch, minIntervalMs: this.opts.minIntervalMs, startTimeoutMs: this.opts.startTimeoutMs })
  }

  /**
   * The command wrote output (HI-1993): the run is told it still goes, at most every KEEPALIVE_MS, so a long command with
   * no step lines (a stress loop) isn't taken for one that stopped reporting. One silent for long still is.
   */
  output(now = Date.now()): void {
    if (!this.run || !keepAliveDue(this.lastAlive, now, this.opts.keepAliveMs)) return
    this.lastAlive = now
    this.run.update({})
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
    this.lastAlive = Date.now()
    this.run.update({ ...(late !== undefined ? { total: late, step: this.step ?? 0 } : {}), ...(u.step !== undefined ? { step: this.step } : {}), ...(u.name !== undefined ? { stepName: u.name } : {}) })
  }

  /** Hive's answer to the finish (null: none in `waitMs`); `retry`: sent once more after that many ms when it got no reply. */
  finish(ok: boolean, summary: string | undefined, exitCode: number, stopped = false, waitMs?: number, retry?: number): Promise<unknown> {
    this.begin()
    return this.run!.finish(ok, summary, waitMs, { exitCode, ...(this.log ? { logPath: this.log } : {}), ...(stopped ? { stopped: true } : {}) }, retry)
  }

  /** How the finish went, once it has resolved. */
  finishedAs(): FinishOutcome | null {
    return this.run?.finishedAs() ?? null
  }
}

/** How long a check's finish waits for Hive to say how it counted (Hive answers within 8 s: servers.ts CHECK_REPLY_MS). */
const CHECK_FINISH_WAIT_MS = 9000

/** What's said for each reason a check run didn't count (#1654): what happened, then what to do. */
const UNCOUNTED: Record<string, AgentMsg> = { notCheck: A.notCheck, notContained: A.notContained, dirty: A.dirty, moved: A.moved, changed: A.changed, revisionChanged: A.revisionChanged }

/** Names for what a write log records that isn't a file. */
const MARKS: Record<string, AgentMsg> = { ':reflog': A.changeReflog, ':edit': A.changeEdit }

/**
 * The line hive-progress prints when Hive says a check's run didn't count (#1654), or null (it counted, or Hive didn't
 * say): why, and what to do, so an agent isn't left running the same command again for a submit that keeps refusing.
 */
export function uncountedLine(answer: unknown, isolated: boolean): string | null {
  const c = answer && typeof answer === 'object' ? (answer as { check?: unknown }).check : null
  if (!c || typeof c !== 'object') return null
  const { name, counted, whyNot, changes, platform } = c as Record<string, unknown>
  if (counted !== false || typeof name !== 'string' || typeof whyNot !== 'string' || !Object.hasOwn(UNCOUNTED, whyNot)) return null
  const listed = Array.isArray(changes) ? changes.filter((x): x is string => typeof x === 'string').map((x) => (Object.hasOwn(MARKS, x) ? say(MARKS[x]) : x)) : []
  return say(UNCOUNTED[whyNot], { check: name, listed: listed.length ? 'yes' : 'no', changes: listed.join(', '), isolate: !isolated && platform === 'git' ? 'yes' : 'no' })
}

/**
 * The command's environment: the caller's, without what hive-progress was started with. Run by Hive's executable as
 * Node (its shims), ELECTRON_RUN_AS_NODE is the shims' own: the command gets the caller's value back (kept in
 * CW_PROGRESS_RUN_AS_NODE; usually none), so an Electron app it starts runs as an app.
 */
export function commandEnv(env: Record<string, string | undefined>, viaElectron: boolean): Record<string, string | undefined> {
  const out = { ...env }
  if (viaElectron) {
    delete out.ELECTRON_RUN_AS_NODE
    if (env.CW_PROGRESS_RUN_AS_NODE) out.ELECTRON_RUN_AS_NODE = env.CW_PROGRESS_RUN_AS_NODE
  }
  delete out.CW_PROGRESS_RUN_AS_NODE
  delete out.CW_PROGRESS_DATA
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
    io.stdout.write(`${usage()}\n`)
    return 0
  }
  if ('error' in parsed) {
    io.stderr.write(`cw-progress: ${parsed.error}\n\n${usage()}\n`)
    return 2
  }
  const target = progressTarget(io.env)
  const replyMs = io.resolveTimeoutMs ?? replyTimeoutMs(io.env)
  // A check's command is the project's (#1220), which only Hive knows.
  if (parsed.check !== undefined && !target) {
    io.stderr.write(`cw-progress: ${say(A.checkOutsideCombwork, { check: parsed.check })}\n`)
    return 2
  }
  // What the run is for, checked before anything runs: a revision that isn't checked out, an unknown card or a check
  // with no command is refused here. An older Hive, or one that doesn't answer, just doesn't link it.
  let link: RunLink | null = null
  if (target) {
    const ask = { folder: io.cwd, ...(parsed.card !== undefined ? { card: parsed.card } : {}), ...(parsed.revision !== undefined ? { revision: parsed.revision } : {}), ...(parsed.check !== undefined ? { check: parsed.check } : {}), ...(parsed.isolated ? { isolated: true as const } : {}) }
    // A check needs the answer (its command is Hive's): asked once more if it got none (HI-1892), but never an isolated
    // check's first ask, which may lend a copy Hive is still setting up (it is asked again with its ticket below).
    const retry = parsed.check !== undefined && !parsed.isolated ? (io.retryMs ?? RETRY_MS) : undefined
    let r = await resolveRun(target, ask, { fetch: io.fetch, timeoutMs: replyMs, retry })
    // No check copy free (#1435): said once, then asked again until one is (Ctrl+C stops waiting).
    // Asked at once at first, less often after a minute (isolatedPollDelay).
    let said = ''
    const waitFrom = Date.now()
    let delay = 0
    while ('wait' in r) {
      if (r.wait !== said) io.stderr.write(`cw-progress: ${say(A.waiting, { what: (said = r.wait) })}\n`)
      delay = isolatedPollDelay(Date.now() - waitFrom, delay, io.isolatedPollMs)
      await new Promise((res) => setTimeout(res, delay))
      // Asked again with its ticket: the copy Hive is setting up for this run (none: a new ask).
      r = await resolveRun(target, { ...ask, ...(r.ticket ? { ticket: r.ticket } : {}) }, { fetch: io.fetch, timeoutMs: replyMs })
    }
    if ('refused' in r) {
      io.stderr.write(`cw-progress: ${r.refused}\n`)
      return 2
    }
    if ('link' in r) link = r.link
    else if (parsed.isolated || parsed.check !== undefined) {
      io.stderr.write(`cw-progress: ${unansweredLine(r, parsed.isolated ? null : (parsed.check ?? ''), replyMs, target.url, retry !== undefined && r.why !== 'refused' ? 2 : 1)}\n`)
      return 2
    }
  }
  // A revision named is checked whether or not Hive can (reporting off, outside Hive, Hive unreachable): here, with git.
  if (!link && parsed.revision !== undefined) {
    const wrong = revisionProblem(io.cwd, parsed.revision, io.env)
    if (wrong) {
      io.stderr.write(`cw-progress: ${wrong}\n`)
      return 2
    }
  }
  // A focused test's check (HI-1367) has no configured command: the one given after `--` runs.
  const checkCommand = link?.check?.command || undefined
  const command = checkCommand !== undefined ? [checkCommand] : parsed.command
  const spec = checkCommand !== undefined ? shellSpec(checkCommand, io.env) : spawnSpec(parsed.command, io.env, io.cwd)
  const env = commandEnv(io.env, io.viaElectron ?? !!process.versions.electron)
  const started = Date.now()
  // Not reporting: the command runs as if hive-progress weren't there (its own console, no filtering).
  if (!target) return run(spec, env, io, null)
  // Its run is this one: a reporter inside it (Hive's test runners, another hive-progress) prints step lines instead
  // of reporting a second row (report.mts).
  env.CW_PROGRESS_WRAPPED = '1'
  const label = checkCommand ?? commandLabel(parsed.command)
  const timings = io.env.CW_PROGRESS_DATA ? join(io.env.CW_PROGRESS_DATA, 'timings.json') : null
  const key = timingKey(io.cwd, command)
  // A check is titled by its name (not its command line) unless given a title.
  const title = parsed.title?.trim() || link?.check?.name
  const linked: Partial<ProgressStart> = link
    ? { ...(link.link ? { link: link.link } : {}), card: link.card, ...(link.revision ? { revision: link.revision } : {}), ...(link.check ? { check: link.check.name } : {}), ...(link.folder ? { folder: link.folder } : {}) }
    : {}
  const report = new WrappedRun(
    () => ({ title: title || label, command: label, titleFromCommand: !title, estimateMs: timings ? estimateFor(timings, key) : undefined, started, link: linked }),
    { target, fetch: io.fetch, minIntervalMs: io.minIntervalMs, startTimeoutMs: replyMs, keepAliveMs: io.keepAliveMs },
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
  // An isolated check (#1435): in its copy, its launcher put in the copy's job before the command exists.
  const isolated = link?.isolated && link.folder ? { folder: link.folder, assign: (a: { pid: number; after: number; before: number }) => assignIsolated(target, { lease: link!.isolated!.lease, ...a }, { fetch: io.fetch }) } : undefined
  const code = await run(spec, env, io, (u) => report.onStep(u), (c) => (child = c), ended, forced, isolated, () => report.output())
  for (const s of signals) process.off(s, onSignal)
  // Told to stop, it is stopped however it then ended (a server shutting down cleanly exits 0); a command that ended by
  // an interrupt of its own is stopped too. Its exit code is passed on as it was.
  const stopped = signalled || (code !== 0 && wasInterrupted(code, ended.signal, false))
  const passed = code === 0 && !stopped
  // The time it usually takes: from runs that passed only, leaving out the time it waited (a queue, a lock).
  if (passed && timings) recordTiming(timings, key, Math.max(0, Date.now() - started - report.waitedMs()))
  // A check's result is what a submit needs: its finish is sent once more if it got no reply (HI-1892).
  // A failed run's detail is stored with it, for any reader: the Default's words (HI-2065).
  const answer = await report.finish(passed, passed ? undefined : stopped ? 'interrupted' : inDefaultDialect(() => say(A.exitCode, { code: String(code) })), code, stopped, link?.check ? (io.checkFinishWaitMs ?? CHECK_FINISH_WAIT_MS) : undefined, link?.check ? (io.retryMs ?? RETRY_MS) : undefined)
  // A check that didn't count says why (#1654), or that it may not be recorded; its exit code is the command's all the same.
  const uncounted = link?.check ? (uncountedLine(answer, !!link.isolated) ?? unrecordedLine(report.finishedAs(), link.check.name)) : null
  if (uncounted) io.stderr.write(`cw-progress: ${uncounted}\n`)
  return code
}

/** Why an isolated check's launcher wasn't put in its copy's job (#1435), so nothing ran. */
function notRunLine(r: Exclude<IsolatedAssign, true>): string {
  if ('error' in r) return say(A.notRunError, { why: r.error })
  if ('status' in r) return say(A.notRunStatus, { status: String(r.status) })
  return say(A.notRunUnreachable, { detail: r.unreachable })
}

function run(
  spec: { file: string; args: string[]; verbatim: boolean },
  env: Record<string, string | undefined>,
  io: WrapperIo,
  onStep: ((u: StepLine) => void) | null,
  onChild?: (c: ChildProcess) => void,
  ended?: { signal: NodeJS.Signals | null },
  forced?: { at: number },
  isolated?: { folder: string; assign: (a: { pid: number; after: number; before: number }) => Promise<IsolatedAssign> },
  onOutput?: () => void
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      if (isolated) {
        // Its launcher, waiting: put in the copy's job by Hive, then told to run the command (its output is the command's).
        const l = startLauncher({ command: spec.file, args: spec.args, verbatim: spec.verbatim }, { cwd: isolated.folder, env: env as NodeJS.ProcessEnv })
        child = l.child
        const giveUp = (why: string): void => {
          io.stderr.write(`cw-progress: ${why}\n`)
          child.stdin?.end()
          if (child.exitCode === null) child.kill()
        }
        child.stdin?.on('error', () => undefined)
        if (!child.pid) giveUp(say(A.launcherDidntStart))
        else
          void isolated.assign({ pid: child.pid, after: l.after, before: l.before }).then(
            (ok) => {
              if (ok !== true) return giveUp(notRunLine(ok))
              child.stdin!.write('go\n')
              child.stdin!.end()
            },
            (e: Error) => giveUp(say(A.notRunError, { why: e.message }))
          )
      } else {
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
      }
    } catch (e) {
      io.stderr.write(`cw-progress: ${(e as Error).message}\n`)
      return resolve(127)
    }
    onChild?.(child)
    const filters: StepFilter[] = []
    if (onStep) {
      for (const [stream, to] of [
        [child.stdout, io.stdout],
        [child.stderr, io.stderr]
      ] as const) {
        const f = new StepFilter((b) => {
          to.write(b)
          onOutput?.()
        }, onStep)
        filters.push(f)
        stream?.on('data', (d: Buffer) => f.push(d))
      }
    }
    let settled = false
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      io.stderr.write(`cw-progress: ${e.code === 'ENOENT' ? say(A.commandNotFound, { file: spec.file }) : e.message}\n`)
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
