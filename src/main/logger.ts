import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'original-fs'
import { join } from 'path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
const logFiles = new Map<string, string>()

export function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function file(name: string): string {
  let f = logFiles.get(name)
  if (!f) {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    f = join(dir, name)
    logFiles.set(name, f)
  }
  return f
}

/** Adds a line to a log file in the logs folder, which is kept to MAX_BYTES and one older copy (<name>.1.log). */
function append(name: string, line: string): void {
  try {
    const f = file(name)
    if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, f.replace(/\.log$/, '.1.log'))
    appendFileSync(f, line)
  } catch {
    // Logging must never crash the app.
  }
}

/**
 * Whether lines go to the console too (an unpackaged build): no more once its console fails (HI-1684). A write to a
 * closed pipe throws EPIPE, or its stream reports it as an error; uncaught, that error was logged, and its console
 * write threw again, without end. The file log goes on.
 */
let toConsole = !app.isPackaged
/** The errors of a console that was closed (its reader gone): expected, said once. */
const PIPE_CLOSED = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

/**
 * The console failed (a write threw, or its stream reported an error): it isn't written to again, and the log file
 * says so, never through the console. A closed pipe is said once; any other error each time, with its stack, as an
 * uncaught one would have been before the console was guarded.
 */
function consoleFailed(where: 'stdout' | 'stderr', e: unknown): void {
  const code = (e as { code?: unknown } | null)?.code
  const closed = typeof code === 'string' && PIPE_CLOSED.has(code)
  const wasOn = toConsole
  toConsole = false
  if (closed && !wasOn) return
  const at = new Date().toISOString()
  if (closed) append('hive.log', `${at} [INFO] [logger] The console's ${where} is closed (${code}): log lines go to this file only from now\n`)
  else append('hive.log', `${at} [ERROR] [logger] The console's ${where} failed, so log lines go to this file only from now: ${e instanceof Error ? (e.stack ?? e.message) : safeJson(e)}\n`)
}
if (toConsole) {
  process.stdout?.on?.('error', (e: unknown) => consoleFailed('stdout', e))
  process.stderr?.on?.('error', (e: unknown) => consoleFailed('stderr', e))
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra !== undefined ? ` ${safeJson(extra)}` : ''
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${detail}\n`
  const where = level === 'error' ? 'stderr' : 'stdout'
  if (toConsole && process[where]?.destroyed) consoleFailed(where, { code: 'ERR_STREAM_DESTROYED' })
  if (toConsole) {
    try {
      ;(level === 'error' ? console.error : console.log)(line.trimEnd())
    } catch (e) {
      consoleFailed(where, e)
    }
  }
  append('hive.log', line)
}

/**
 * A line of the hook journal (logs/hooks.log, #648): each hook an agent's CLI sent, with its launch, ids and receive
 * order, and the status before and after, so a status that went wrong can be traced afterwards (#642's couldn't be).
 * Apart from hive.log, which it would crowd out. Ids, event names and statuses only: never the user's text.
 */
export function hookJournal(line: string): void {
  append('hooks.log', `${new Date().toISOString()} ${line}\n`)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * The user's own text in a log line (a card title, a name, a path, a prompt), between Unicode isolate marks
 * (invisible when the log is read). Help → Copy Diagnostics replaces each marked span (shared/redact.ts).
 */
export function userText(text: unknown): string {
  return `\u2068${String(text).replace(/[\u2068\u2069\r\n]/g, ' ')}\u2069`
}

/** Flags whose values are Hive's own choices (ids, models, modes), never the user's text. */
const PLAIN_VALUE_FLAGS = new Set(['--session-id', '--resume', 'resume', '--model', '-m', '--effort', '--permission-mode', '-s', '--sandbox', '-a', '--ask-for-approval', '--allowedTools'])

/**
 * A command line's arguments as logged: flags, and the values of the flags above, stay; every other value is the
 * user's text by default (a prompt, a session name, instructions, a path) and is marked, whatever it looks like.
 * Codex's `-c key=value` keeps its key, unless the key names an MCP server. A value written into its flag
 * (`--name=x`, `-c=key=value`) is treated the same. cmd.exe's own switches stay.
 */
export function argsForLog(args: string[]): string[] {
  const value = (flag: string | undefined, v: string): string => {
    if (flag && PLAIN_VALUE_FLAGS.has(flag) && /^[\w.:,[\]-]{1,200}$/.test(v)) return v
    if (flag === '-c' || flag === '--config') {
      const key = /^([A-Za-z_][\w.]*)=/.exec(v)?.[1]
      if (key && !key.startsWith('mcp_servers')) return `${key}=${userText(v.slice(key.length + 1))}`
    }
    return userText(v)
  }
  return args.map((arg, i) => {
    const inline = /^(-[^=\s]+)=([^]*)$/.exec(arg)
    if (inline) return `${inline[1]}=${value(inline[1], inline[2])}`
    if (arg.startsWith('-') || /^\/[a-z]$/i.test(arg) || (arg === 'resume' && /^[\w-]{8,}$/.test(args[i + 1] ?? ''))) return arg
    return value(args[i - 1], arg)
  })
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e)
  }
}
