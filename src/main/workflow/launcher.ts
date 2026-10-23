// A command's launcher (#1360; shared with hive-progress's isolated checks, #1435): a process that is put in a job on
// Hive's process supervisor, and recorded, before the command it runs exists. Node built-ins only: hive-progress runs
// outside the asar and may only require these and out/main/chunks.

import { spawn, type ChildProcess } from 'child_process'

/**
 * The launcher (run by Node): waits for its input's first line, then runs the command it was given (HIVE_QUEUE_LAUNCH,
 * JSON: command, args, shell, verbatim: Windows' arguments as given, a shell's command line) with its own output and what follows on its input, and exits with its code. Its input
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
  const c = require('child_process').spawn(spec.command, spec.args, { stdio: ['pipe', 'inherit', 'inherit'], shell: !!spec.shell, windowsVerbatimArguments: !!spec.verbatim, windowsHide: true })
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
export function startLauncher(spec: { command: string; args: readonly string[]; shell?: boolean; verbatim?: boolean }, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { child: ChildProcess; after: number; before: number } {
  const env = opts.env ?? process.env
  const launchEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', HIVE_QUEUE_LAUNCH: JSON.stringify(spec) }
  if (env.ELECTRON_RUN_AS_NODE !== undefined) launchEnv.HIVE_QUEUE_RUN_AS_NODE = env.ELECTRON_RUN_AS_NODE
  else delete launchEnv.HIVE_QUEUE_RUN_AS_NODE
  const after = Date.now()
  const child = spawn(process.execPath, ['-e', LAUNCHER], { cwd: opts.cwd, env: launchEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
  return { child, after, before: Date.now() }
}
