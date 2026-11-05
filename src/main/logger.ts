import { app } from 'electron'
import { mkdirSync } from 'original-fs'
import { basename, join } from 'path'
import { isMainThread, Worker } from 'worker_threads'
import { maskKeys } from './keyMatcher'
import { appendLog, BUSY, LOG_STATE_SLOTS, STOP, WRITTEN, type LogBatch } from './logWriter'
import { noteStep, stallClock } from './stallWork'
import { bundledScriptExists, workerHere, workerStarted } from './workerThreads'

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

/** A log write this slow, made here, is noted as a step (HI-1692), so a stall it caused names it. */
const SLOW_WRITE_MS = 50
/** Lines waiting for the writer thread, in all: past this (its disk held up for long), lines are dropped and counted (tests change it). */
export const logLimits = { waitingBytes: 8 * 1024 * 1024 }

/**
 * The log's writer thread (logWriter.ts, HI-1730): lines are queued here and written there, in order, so a disk that
 * holds writes up (a System Restore point freezing the profile's drive: 2–8 s in Darren's log) holds that thread, never
 * main. Written here instead, at once, as before: without the writer's script (unit tests), once it has gone, and from
 * the process's exit on, when what is still queued is written here too (flushLogs), so the last lines aren't lost.
 */
let shared = new Int32Array(new SharedArrayBuffer(LOG_STATE_SLOTS * Int32Array.BYTES_PER_ELEMENT))
let writer: Worker | null = null
let here = false
/** Lines not yet given to the writer, by file; batches given and not yet written (for flushLogs). */
const queued = new Map<string, string[]>()
let queuedBytes = 0
const sent: LogBatch[] = []
let sentBytes = 0
let seq = 0
let dropped = 0
let posting = false

const unpackaged = (): boolean => {
  try {
    return !app.isPackaged
  } catch {
    return true
  }
}

/** The writer thread, started with the first line; null when lines are written here. */
function writerThread(): Worker | null {
  if (writer || here) return writer
  // The writer's script is beside main's: this module may be in a chunk (out/main/chunks, shared with the usage worker).
  const script = forTests?.script ?? join(__dirname, basename(__dirname) === 'chunks' ? '..' : '', 'log-writer.js')
  // Main's own thread only: a worker that logs (the usage worker) writes its lines itself.
  if (!isMainThread && !forTests) {
    here = true
    return null
  }
  // Tests (unpackaged builds): CW_TEST_LOG_DIRECT=1 writes here, as before; CW_TEST_SLOW_LOG_MS holds each write.
  if ((unpackaged() && process.env.CW_TEST_LOG_DIRECT === '1' && !forTests) || !bundledScriptExists(script)) {
    workerHere('log writer', bundledScriptExists(script) ? 'CW_TEST_LOG_DIRECT' : "its script isn't there") // i18n-ignore: Copy Diagnostics' report, in English
    here = true
    return null
  }
  try {
    const slowMs = forTests?.slowMs ?? ((unpackaged() && Number(process.env.CW_TEST_SLOW_LOG_MS)) || 0)
    const w = new Worker(script, { workerData: { state: shared.buffer, slowMs } })
    workerStarted('log writer', w) // i18n-ignore: a worker's name, for Copy Diagnostics' report (English)
    w.on('message', (n: number) => {
      while (sent.length && sent[0].seq <= n) sentBytes -= sent.shift()!.text.length
    })
    const gone = (): void => {
      if (writer !== w) return
      writer = null
      // Nothing writes there now: what it hadn't written is written here, and every line after.
      Atomics.store(shared, BUSY, 0)
      flushLogs()
      appendHere(file('hive.log'), `${new Date().toISOString()} [WARN] [logger] The log's writer thread ended: lines are written on the main thread from now\n`) // i18n-ignore: a line of hive.log
    }
    w.on('error', gone)
    w.on('exit', gone)
    w.unref()
    writer = w
  } catch {
    here = true
  }
  return writer
}

/** Appends a line to a log file in the logs folder, which is kept to MAX_BYTES and one older copy (<name>.1.log). */
function append(name: string, line: string): void {
  let f: string
  try {
    f = file(name)
  } catch {
    return
  }
  if (here || !writerThread()) return appendHere(f, line)
  if (queuedBytes + sentBytes + line.length > logLimits.waitingBytes) {
    dropped++
    return
  }
  const lines = queued.get(f)
  if (lines) lines.push(line)
  else queued.set(f, [line])
  queuedBytes += line.length
  if (posting) return
  posting = true
  setImmediate(post)
}

/** Written at once, on this thread: a write held by the disk holds it, and one that slow is noted (HI-1692). */
function appendHere(f: string, line: string): void {
  const start = stallClock.mono()
  // Tests (unpackaged builds): the same held disk as the writer's, to compare the two.
  const slowMs = unpackaged() && !forTests ? Number(process.env.CW_TEST_SLOW_LOG_MS) || 0 : 0
  if (slowMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slowMs)
  appendLog(f, line, MAX_BYTES)
  if (stallClock.mono() - start >= SLOW_WRITE_MS) noteStep(`log write ${basename(f)}`, start)
}

/** The lines dropped meanwhile, said in hive.log as the next line there. */
function droppedLine(): string | null {
  if (!dropped) return null
  const line = `${new Date().toISOString()} [WARN] [logger] ${dropped} log line(s) weren't written: the logs' drive held writes up for too long\n` // i18n-ignore: a line of hive.log
  dropped = 0
  return line
}

/** Gives the writer what was queued since, one batch a file. */
function post(): void {
  posting = false
  const w = writer
  if (!w || here) return
  const note = droppedLine()
  if (note) {
    const f = file('hive.log')
    queued.set(f, [note, ...(queued.get(f) ?? [])])
  }
  for (const [f, lines] of queued) {
    const b: LogBatch = { seq: ++seq, file: f, text: lines.join(''), maxBytes: MAX_BYTES }
    sent.push(b)
    sentBytes += b.text.length
    w.postMessage(b)
  }
  queued.clear()
  queuedBytes = 0
}

/** The longest flushLogs waits for a batch the writer is writing: the process is ending, it mustn't hang on the disk. */
const FLUSH_WAIT_MS = 2000

/**
 * Writes here, now, what the writer hasn't (at the process's exit, or the writer gone), and every line after: the writer
 * is told to stop, a batch it is writing is waited for (at most FLUSH_WAIT_MS: past that, written here too, so a line may
 * appear twice rather than be lost), then each batch it didn't write, in order, then what was still queued.
 */
export function flushLogs(): void {
  if (here && !sent.length && !queued.size) return
  here = true
  Atomics.store(shared, STOP, 1)
  const until = Date.now() + FLUSH_WAIT_MS
  while (Atomics.load(shared, BUSY) === 1 && Date.now() < until) Atomics.wait(shared, BUSY, 1, 50)
  const written = Atomics.load(shared, WRITTEN)
  for (const b of sent.splice(0)) if (b.seq > written) appendLog(b.file, b.text, b.maxBytes)
  sentBytes = 0
  const note = droppedLine()
  if (note) appendLog(file('hive.log'), note, MAX_BYTES)
  for (const [f, lines] of queued) appendLog(f, lines.join(''), MAX_BYTES)
  queued.clear()
  queuedBytes = 0
}
// The last lines on disk before the process goes (exitLog's own exit line comes after: written here, at once).
process.on('exit', flushLogs)

/** Tests: the writer from this script (a build of logWriter.ts), each write held `slowMs`; null: back to the default. */
let forTests: { script: string; slowMs: number } | null = null
export async function useLogWriter(script: string | null, slowMs = 0): Promise<void> {
  flushLogs()
  const w = writer
  writer = null
  await w?.terminate()
  forTests = script ? { script, slowMs } : null
  shared = new Int32Array(new SharedArrayBuffer(LOG_STATE_SLOTS * Int32Array.BYTES_PER_ELEMENT))
  here = false
  seq = 0
}

/**
 * Whether lines go to the console too (an unpackaged build): no more once its console fails (HI-1684). A write to a
 * closed pipe throws EPIPE, or its stream reports it as an error; uncaught, that error was logged, and its console
 * write threw again, without end. The file log goes on.
 */
// Read safely: a worker that loads this module (the usage worker, through fsutil) has no `app`, and reading it there at
// load threw and ended the worker on every start (HI-1730, since HI-1684 moved this read to the module's top).
let toConsole = unpackaged() && isMainThread
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
  if (closed) append('hive.log', `${at} [INFO] [logger] The console's ${where} is closed (${code}): log lines go to this file only from now\n`) // i18n-ignore: a line of hive.log
  else append('hive.log', `${at} [ERROR] [logger] The console's ${where} failed, so log lines go to this file only from now: ${e instanceof Error ? (e.stack ?? e.message) : safeJson(e)}\n`) // i18n-ignore: a line of hive.log
}
if (toConsole) {
  process.stdout?.on?.('error', (e: unknown) => consoleFailed('stdout', e))
  process.stderr?.on?.('error', (e: unknown) => consoleFailed('stderr', e))
}

/**
 * A line of hive.log as written: its data serialised, then a server connection's key in use masked in it (HI-1772), in
 * any form the serialising wrote it (keyMatcher.ts's forms), before the log or the console get it.
 */
export function logLine(level: Level, scope: string, message: string, extra?: unknown): string {
  const detail = extra instanceof Error ? ` ${extra.stack ?? extra.message}` : extra !== undefined ? ` ${safeJson(extra)}` : ''
  // Its time, level and scope are Hive's own; strict masking (keyMatcher.ts) is for what follows them.
  return `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${maskKeys(`${message}${detail}`)}\n`
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  const line = logLine(level, scope, message, extra)
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
