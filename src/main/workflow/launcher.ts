// A command's launcher (#1360; shared with cw-progress's isolated checks, #1435): a process that is put in a job on
// Combwork's process supervisor, and recorded, before the command it runs exists. Node built-ins only: hive-progress runs
// outside the asar and may only require these and out/main/chunks.

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'

/** HI-2042: the launcher's exit when its command was ended by a signal (its nonce's line says which): never 1 or 127. */
export const SIGNALLED = 129

/**
 * The launcher (run by Node): waits for its input's first line, then runs the command it was given (CW_QUEUE_LAUNCH,
 * JSON: command, args, shell, verbatim: Windows' arguments as given, a shell's command line) with its own output and what follows on its input, and exits with its code. Its input
 * closing before that line (Combwork gone, or the launch given up) ends it with nothing run.
 */
const LAUNCHER = `
// A process of its own, not Combwork's: its exit isn't one of Combwork's ways out (exitBy).
const end = process.exit.bind(process)
let got = '', started = false
process.stdin.on('data', (d) => {
  if (started) return
  got += d
  const i = got.indexOf('\\n')
  if (i < 0) return
  started = true
  const spec = JSON.parse(process.env.CW_QUEUE_LAUNCH)
  delete process.env.CW_QUEUE_LAUNCH
  if (process.env.CW_QUEUE_RUN_AS_NODE !== undefined) process.env.ELECTRON_RUN_AS_NODE = process.env.CW_QUEUE_RUN_AS_NODE
  else delete process.env.ELECTRON_RUN_AS_NODE
  delete process.env.CW_QUEUE_RUN_AS_NODE
  const c = require('child_process').spawn(spec.command, spec.args, { stdio: ['pipe', 'inherit', 'inherit'], shell: !!spec.shell, windowsVerbatimArguments: !!spec.verbatim, windowsHide: true })
  c.stdin.on('error', () => {})
  const rest = got.slice(i + 1)
  if (rest) c.stdin.write(rest)
  process.stdin.removeAllListeners('data')
  process.stdin.pipe(c.stdin)
  // HI-2020: a command that never started (no pid) says so on a line of its own with the launch's nonce, which the command
  // can't know (its spec left the environment above): a command that ran and exited 127 never looks like one.
  c.on('error', (e) => {
    process.stderr.write(String(e && e.message))
    if (!c.pid) require('fs').writeSync(2, '\\n' + spec.nonce + ':notStarted:' + String((e && e.code) || 'error') + '\\n')
    end(127)
  })
  // HI-2042: a command ended by a signal (no exit code of its own) says so the same way, never as an exit 1 (git's "no").
  c.on('exit', (code, signal) => {
    if (code !== null) return end(code)
    require('fs').writeSync(2, '\\n' + spec.nonce + ':signal:' + String(signal || 'unknown') + '\\n')
    end(${SIGNALLED})
  })
})
process.stdin.on('end', () => { if (!started) end(70) })
`

/**
 * Starts a command's launcher, waiting: detached (outside Combwork's own job), hidden, in `cwd` with `env`. Combwork's own
 * executable runs it as Node (ELECTRON_RUN_AS_NODE, which the command gets back as it was). The clock readings either
 * side of its start come back with it, for the job's check and the record.
 */
export function startLauncher(spec: { command: string; args: readonly string[]; shell?: boolean; verbatim?: boolean }, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { child: ChildProcess; after: number; before: number; nonce: string } {
  const env = opts.env ?? process.env
  // HI-2020: the launch's own mark for "the command never started" (launcherNotStarted), unknown to the command.
  const nonce = randomUUID()
  const launchEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', CW_QUEUE_LAUNCH: JSON.stringify({ ...spec, nonce }) }
  if (env.ELECTRON_RUN_AS_NODE !== undefined) launchEnv.CW_QUEUE_RUN_AS_NODE = env.ELECTRON_RUN_AS_NODE
  else delete launchEnv.CW_QUEUE_RUN_AS_NODE
  const after = Date.now()
  const child = spawn(process.execPath, ['-e', LAUNCHER], { cwd: opts.cwd, env: launchEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
  return { child, after, before: Date.now(), nonce }
}

/**
 * HI-2020: whether a launch's command never started, from the launcher's stderr: its nonce's line (written only when the
 * command's start failed, with no pid), and Node's code for why; the stderr without that line. Null for any command that
 * started, whatever it exited with (127 too).
 */
export function launcherNotStarted(stderr: string, nonce: string): { code: string; err: string } | null {
  return launcherSaid(stderr, nonce, 'notStarted', 'error')
}

/**
 * HI-2042: whether a launch's command was ended by a signal, from the launcher's stderr: its nonce's line (written only
 * when the command's exit had no code), and the signal's name; the stderr without that line. Null for any command that
 * exited with a code of its own (1 too).
 */
export function launcherSignalled(stderr: string, nonce: string): { signal: string; err: string } | null {
  const m = launcherSaid(stderr, nonce, 'signal', 'unknown')
  return m ? { signal: m.code, err: m.err } : null
}

/** The launcher's own line of a kind, by this launch's nonce: what it says, and the stderr with only that line taken out. */
function launcherSaid(stderr: string, nonce: string, kind: string, none: string): { code: string; err: string } | null {
  const mark = new RegExp(`(?:\\r?\\n)?${nonce}:${kind}:([^\\r\\n]*)\\r?\\n?`)
  const m = mark.exec(stderr)
  return m ? { code: m[1] || none, err: stderr.replace(mark, '').trim() } : null
}
