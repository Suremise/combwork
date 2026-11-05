import { randomBytes } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { join } from 'path'

/**
 * A terminal's command started only once Hive has put its process in the launch's job (#507), so that nothing it
 * starts can escape the job by starting before it was there.
 *
 * node-pty gives no way to start a process suspended, and on Windows it knows the process's id only once it runs. So
 * the terminal runs a gate first: a hidden PowerShell (a console program on every Windows, so it shares the terminal's
 * console, which Electron's own executable doesn't) that connects to a pipe made for this launch and waits for Hive's
 * word; meanwhile Hive puts the gate in the job. Then the gate starts the real command (in the job from its first
 * instruction, as is everything it starts) with the same command line node-pty would have given it, on the same
 * console, and ends with its exit code. The command and its arguments reach the gate in variables of its environment,
 * removed before the command starts, so nothing is quoted twice. The gate uses no cmdlet: PowerShell loads no module.
 * The gate starts the command only on Hive's explicit `go`: Hive refusing (`stop <why>`), the pipe failing or closing
 * without a word, all end the gate with that reason, and the command never runs. Hive says `go` only when its caller
 * says so (ptyHost's track: the process is in the job).
 */

export const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** How long the gate waits to connect to its pipe (Hive made it before the terminal started). */
const CONNECT_MS = 30_000

const GATE_SCRIPT = `
$pipe = $env:HIVE_GATE_PIPE; $file = $env:HIVE_GATE_FILE; $argline = $env:HIVE_GATE_ARGS
foreach ($n in @('HIVE_GATE_PIPE', 'HIVE_GATE_FILE', 'HIVE_GATE_ARGS')) { [Environment]::SetEnvironmentVariable($n, $null) }
$word = $null
$why = 'Combwork gave no word to start it'
try {
  $c = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, [System.IO.Pipes.PipeDirection]::InOut)
  $c.Connect(${CONNECT_MS})
  $word = [System.IO.StreamReader]::new($c).ReadLine()
  $c.Dispose()
} catch { $why = "its connection to Combwork failed ($($_.Exception.InnerException.Message))" }
if ($word -ne 'go') {
  if ($word -and $word.StartsWith('stop ')) { $why = $word.Substring(5) }
  [Console]::Error.WriteLine("Error: Combwork didn't start $([System.IO.Path]::GetFileName($file)): $why")
  exit 1
}
$s = [System.Diagnostics.ProcessStartInfo]::new($file, $argline)
$s.UseShellExecute = $false
try { $p = [System.Diagnostics.Process]::Start($s) } catch { [Console]::Error.WriteLine("Error: could not start $($file): $($_.Exception.InnerException.Message)"); exit 1 }
$p.WaitForExit()
exit $p.ExitCode
`
const GATE_ARGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(GATE_SCRIPT, 'utf16le').toString('base64')]

/**
 * Arguments as one Windows command line, quoted exactly as node-pty quotes them (its argsToCommandLine, from winpty:
 * an argument with a space or tab is quoted unless it already is, backslashes before a quote doubled), so the command
 * gets the arguments it would have had started by node-pty itself.
 */
export function commandLineOf(args: string[]): string {
  return args
    .map((arg) => {
      const lopsided = (arg[0] !== '"') !== (arg[arg.length - 1] !== '"')
      const unquoted = arg[0] !== '"' && arg[arg.length - 1] !== '"'
      const quote = arg === '' || ((arg.includes(' ') || arg.includes('\t')) && arg.length > 1 && (lopsided || unquoted))
      let out = quote ? '"' : ''
      let slashes = 0
      for (const ch of arg) {
        if (ch === '\\') slashes++
        else if (ch === '"') {
          out += `${'\\'.repeat(slashes * 2 + 1)}"`
          slashes = 0
        } else {
          out += '\\'.repeat(slashes) + ch
          slashes = 0
        }
      }
      return out + (quote ? `${'\\'.repeat(slashes * 2)}"` : '\\'.repeat(slashes))
    })
    .join(' ')
}

/** What the gate is told: start the command, or not and why (shown in the terminal, and as the start's failure). */
export type GateWord = { go: true } | { go: false; reason: string }

export interface LaunchGate {
  /** What the terminal runs instead: the gate, with the command in its environment. */
  file: string
  args: string[]
  env: Record<string, string>
  /** The gate's process is known: it is told `word` once that has settled (a rejection refuses, with its message). */
  open(word: Promise<GateWord>): void
  /** The terminal is being killed: the gate is told to stop, whatever word comes later (none if it had its word). */
  stop(reason: string): void
  /** The terminal has exited (or never started): the pipe closes. */
  close(): void
}

/** A gate for this command (Windows): listening on its pipe until the gate has had its word. */
export function launchGate(file: string, args: string[] | string, env: Record<string, string>): LaunchGate {
  const name = `combwork-gate-${randomBytes(16).toString('hex')}`
  let socket: Socket | null = null
  let said: string | null = null
  let server: Server | null = createServer((s) => {
    // The first connection is the gate's; the pipe takes no other.
    server?.close()
    server = null
    socket = s
    s.on('error', () => undefined)
    tell()
  })
  server.on('error', () => undefined)
  server.listen(`\\\\.\\pipe\\${name}`)
  const tell = (): void => {
    if (!socket || said === null) return
    socket.end(`${said}\n`)
    socket = null
  }
  return {
    file: POWERSHELL,
    args: GATE_ARGS,
    env: { ...env, HIVE_GATE_PIPE: name, HIVE_GATE_FILE: file, HIVE_GATE_ARGS: typeof args === 'string' ? args : commandLineOf(args) },
    open(word) {
      void word
        .catch((e: unknown): GateWord => ({ go: false, reason: e instanceof Error ? e.message : String(e) }))
        .then((w) => {
          if (said !== null) return
          said = w.go ? 'go' : `stop ${w.reason.replace(/[\r\n]+/g, ' ')}`
          tell()
        })
    },
    stop(reason) {
      if (said !== null) return
      said = `stop ${reason.replace(/[\r\n]+/g, ' ')}`
      tell()
    },
    close() {
      server?.close()
      server = null
      socket?.destroy()
      socket = null
    }
  }
}
