// The merge queue runner's git host (HI-2079): one Node process per lease, put in the lease's job and recorded before it
// runs anything (the launcher's gate, launcher.ts), that starts each of the runner's unbounded git commands as its own
// child, so in the job from its start. A git through it costs git's own start, not a Node start as well (about 80 ms a
// command, measured on the card). Bounded commands (a push, a signed commit) keep the launcher: their bound ends a tree.
//
// Requests go in on its input, one JSON line each; what comes back is framed (FrameDecoder), so a command's output can
// never pass for the host's own word: a start that failed (HI-2020) and an end by a signal (HI-2042) are frames of their
// own, with no nonce. The host is never told to end one command: a host that goes, or says something it shouldn't, fails
// its runner's lease (QueueRunner.fail), whose release ends the job, and the queue takes a new lease (queueHost).

import { spawn, type ChildProcess } from 'child_process'
import { EXITED_QUIET_MS } from '../gitWorker'

/** A request's largest JSON line (its environment, arguments and input): a larger one is never sent. */
export const REQUEST_MAX = 1 << 20
/** A frame's largest payload the runner accepts; the host writes output in OUT_CHUNK pieces. */
export const FRAME_MAX = 1 << 20
export const OUT_CHUNK = 64 * 1024

/**
 * The frames' kinds: started (pid), out, err, exit (code), signal (name), notStarted (Node's code), bounded (HI-2078:
 * `maxBuffer` or `timeout`, `:alive` when its child couldn't be ended).
 */
export type FrameKind = 'S' | 'O' | 'E' | 'X' | 'K' | 'N' | 'B'
const KINDS = new Set<string>(['S', 'O', 'E', 'X', 'K', 'N', 'B'])
/** kind (1 byte), id (u32), length (u32), then the payload. */
const HEAD = 9
/** A command's input goes to the host in pieces of this size (HI-2078). */
const IN_CHUNK = 64 * 1024

/** One frame (the host's input and output alike): its kind, the request's id, then the payload's length and bytes. */
export function frameOf(kind: string, id: number, payload: Buffer | string = ''): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const head = Buffer.alloc(HEAD)
  head.write(kind, 0, 'latin1')
  head.writeUInt32BE(id, 1)
  head.writeUInt32BE(body.length, 5)
  return Buffer.concat([head, body])
}

/**
 * The host (run by Node): its input is framed as its output is (HI-2078: a command's input streamed, not in its
 * request): G, the gate, first; then R, a request (JSON: id, command, args, cwd, env, bounds), run at once; I, a piece of
 * a request's input; J, its input's end. It frames each command's output and end. Its input closing stops it taking
 * more: it exits once what runs has ended (before the gate: at once, having run nothing). Anything else ends it (65).
 */
export const HOST = `
// A process of its own, not Hive's: its exit isn't one of Hive's ways out (exitBy).
const end = process.exit.bind(process)
const cp = require('child_process')
const QUIET = ${EXITED_QUIET_MS}, CHUNK = ${OUT_CHUNK}
const live = new Map()
// Each running command's input, until its end (J) comes.
const stdins = new Map()
let got = Buffer.alloc(0), gated = false, closing = false, blocked = false
const frame = (kind, id, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const head = Buffer.alloc(${HEAD})
  head.write(kind, 0, 'latin1'); head.writeUInt32BE(id, 1); head.writeUInt32BE(body.length, 5)
  if (!process.stdout.write(Buffer.concat([head, body])) && !blocked) {
    // Backpressure: every command's output waits until the runner has read what was written, and no command's quiet
    // after its exit counts meanwhile (HR3's round 1 finding 1: what waits in its paused output is never cut off).
    blocked = true
    for (const r of live.values()) { r.c.stdout.pause(); r.c.stderr.pause(); clearTimeout(r.quiet) }
    process.stdout.once('drain', () => {
      blocked = false
      for (const r of live.values()) { r.c.stdout.resume(); r.c.stderr.resume(); r.wait() }
    })
  }
}
const data = (kind, id) => (d) => { for (let i = 0; i < d.length; i += CHUNK) frame(kind, id, d.subarray(i, i + CHUNK)) }
const done = () => { if (closing && !live.size) end(0) }
function run(s) {
  let c
  try {
    c = cp.spawn(s.command, s.args, { cwd: s.cwd, env: s.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (e) {
    frame('E', s.id, String(e && e.message)); frame('N', s.id, String((e && e.code) || 'error')); return
  }
  if (!c.pid) {
    // A start that failed is told on the next tick: nothing ran.
    c.once('error', (e) => { frame('E', s.id, String(e && e.message)); frame('N', s.id, String((e && e.code) || 'error')) })
    return
  }
  const r = { c, exited: null, quiet: null, timer: null, over: false, wait: () => {} }
  live.set(s.id, r)
  c.on('error', () => {})
  c.stdin.on('error', () => {})
  stdins.set(s.id, c.stdin)
  frame('S', s.id, String(c.pid))
  if (blocked) { c.stdout.pause(); c.stderr.pause() }
  // HI-2078: its bounds, as execFile's (git()'s): each output's bytes counted as they come, and its time. Past one, nothing
  // more of it is framed, its own child is ended by its handle (as execFile does: what it started stays in the job),
  // and B says which (':alive' when the kill failed). Nothing is framed after.
  // No bound given: none. Zero is a bound, as execFile's: any byte is past it (HR3's round 1 finding 2).
  const max = typeof s.maxBuffer === 'number' ? s.maxBuffer : Infinity
  const sizes = { O: 0, E: 0 }
  const bound = (why) => {
    if (r.over) return
    r.over = true
    clearTimeout(r.quiet); clearTimeout(r.timer)
    live.delete(s.id)
    c.stdout.removeAllListeners('data'); c.stderr.removeAllListeners('data')
    c.stdout.destroy(); c.stderr.destroy()
    let killed = false
    try { killed = c.kill() } catch {}
    frame('B', s.id, killed ? why : why + ':alive')
    done()
  }
  const take = (kind) => (d) => {
    if (r.over) return
    sizes[kind] += d.length
    if (sizes[kind] <= max) return data(kind, s.id)(d)
    // As execFile keeps it: what came up to the bound, then the end.
    const room = max - (sizes[kind] - d.length)
    if (room > 0) data(kind, s.id)(d.subarray(0, room))
    bound('maxBuffer')
  }
  if (s.timeout > 0) r.timer = setTimeout(() => bound('timeout'), s.timeout)
  // HI-2043, as onOutputSettled: told once the output has closed, all of it read; once the command has exited, an
  // output kept open (a descendant that got away) is closed after QUIET ms with nothing more, the quiet counted only
  // while its output flows (never while the runner holds it back), and what is already buffered framed first. Nothing
  // is framed after.
  const out = take('O'), err = take('E')
  const settle = () => {
    if (r.over) return
    c.stdout.removeAllListeners('data'); c.stderr.removeAllListeners('data')
    for (let b; !r.over && (b = c.stdout.read()) !== null; ) out(b)
    for (let b; !r.over && (b = c.stderr.read()) !== null; ) err(b)
    if (r.over) return
    r.over = true
    clearTimeout(r.quiet); clearTimeout(r.timer)
    live.delete(s.id)
    c.stdout.destroy(); c.stderr.destroy()
    const [code, signal] = r.exited
    if (code !== null) frame('X', s.id, String(code))
    else frame('K', s.id, String(signal || 'unknown'))
    done()
  }
  r.wait = () => { if (!r.exited || r.over || blocked) return; clearTimeout(r.quiet); r.quiet = setTimeout(settle, QUIET) }
  c.stdout.on('data', out); c.stderr.on('data', err)
  c.stdout.on('data', r.wait); c.stderr.on('data', r.wait)
  c.once('exit', (code, signal) => { r.exited = [code, signal]; r.wait() })
  c.once('close', (code, signal) => { if (!r.exited) r.exited = [code, signal]; settle() })
}
// A command's input written as it comes (I), its end on J. One that takes no more for now holds every input back (this
// host reads nothing more) until it does, or its input is gone (it exited, or ended its input).
const feed = (id, piece) => {
  const w = stdins.get(id)
  if (!w || w.destroyed || w.writableEnded) return
  if (w.write(piece)) return
  process.stdin.pause()
  const go = () => { w.off('drain', go); w.off('close', go); w.off('error', go); process.stdin.resume() }
  w.on('drain', go); w.on('close', go); w.on('error', go)
}
const take = (kind, id, body) => {
  if (!gated) { if (kind !== 'G') end(65); gated = true; return }
  if (kind === 'R') {
    if (closing) return
    let s
    try { s = JSON.parse(body.toString('utf8')) } catch { end(65) }
    return run(s)
  }
  if (kind === 'I') return feed(id, Buffer.from(body))
  if (kind === 'J') { const w = stdins.get(id); stdins.delete(id); if (w && !w.destroyed) w.end(); return }
  end(65)
}
process.stdin.on('data', (d) => {
  got = got.length ? Buffer.concat([got, d]) : d
  while (got.length >= ${HEAD}) {
    const kind = got.toString('latin1', 0, 1), id = got.readUInt32BE(1), len = got.readUInt32BE(5)
    if (len > ${REQUEST_MAX}) end(65)
    if (got.length < ${HEAD} + len) break
    const body = got.subarray(${HEAD}, ${HEAD} + len)
    got = got.subarray(${HEAD} + len)
    take(kind, id, body)
  }
})
process.stdin.on('error', () => {})
process.stdin.on('end', () => {
  if (!gated) end(70)
  closing = true
  // No more input comes: what still waits for its own ends now.
  for (const w of stdins.values()) if (!w.destroyed) w.end()
  stdins.clear()
  done()
})
`

/**
 * A request's result, as the host told it, its output as text and as bytes. `lost`: the host went (or said something it
 * shouldn't) before its end. `bounded` (HI-2078): ended at its bound (`alive`: its child couldn't be ended).
 */
export interface HostResult {
  out: string
  err: string
  outBuf: Buffer
  errBuf: Buffer
  code: number | null
  signal?: string
  notRun?: string
  lost?: string
  bounded?: 'maxBuffer' | 'timeout'
  alive?: boolean
}

/** A request's bounds (HI-2078, as git()'s execFile): each output's bytes, and its time in ms. */
export interface HostBounds {
  maxBuffer?: number
  timeout?: number
}

const NONE = Buffer.alloc(0)
type Told = Omit<HostResult, 'out' | 'err' | 'outBuf' | 'errBuf'>
/** A result with nothing read: the request never reached a command. */
const nothing = (r: Told & { err?: string }): HostResult => ({ ...r, out: '', outBuf: NONE, err: r.err ?? '', errBuf: Buffer.from(r.err ?? '') })

/** One frame, decoded. */
export interface Frame {
  kind: FrameKind
  id: number
  payload: Buffer
}

/**
 * The host's output as frames, however it comes (split anywhere, several at once): `push` gives the whole frames so
 * far, and throws on one that can't be (an unknown kind, a payload over FRAME_MAX); `end` throws when a frame was cut
 * short.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: Frame[] = []
    while (this.buf.length >= HEAD) {
      const kind = this.buf.toString('latin1', 0, 1)
      if (!KINDS.has(kind)) throw new Error(`an unknown frame (${this.buf[0]})`) // i18n-ignore: a reason, logged
      const len = this.buf.readUInt32BE(5)
      if (len > FRAME_MAX) throw new Error(`a frame of ${len} bytes`) // i18n-ignore: a reason, logged
      if (this.buf.length < HEAD + len) break
      out.push({ kind: kind as FrameKind, id: this.buf.readUInt32BE(1), payload: Buffer.from(this.buf.subarray(HEAD, HEAD + len)) })
      this.buf = this.buf.subarray(HEAD + len)
    }
    return out
  }

  end(): void {
    if (this.buf.length) throw new Error('a frame cut short') // i18n-ignore: a reason, logged
  }
}

/**
 * Starts a host, waiting for its gate: detached (outside Hive's own job), hidden, as a launcher is (startLauncher), in
 * `base` (tests: their own) with Hive's executable run as Node. Its commands get each request's own environment.
 */
export function startGitHost(base: NodeJS.ProcessEnv = process.env): { child: ChildProcess; after: number; before: number } {
  const env: NodeJS.ProcessEnv = { ...base, ELECTRON_RUN_AS_NODE: '1' }
  const after = Date.now()
  const child = spawn(process.execPath, ['-e', HOST], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
  return { child, after, before: Date.now() }
}

type Pending = { out: Buffer[]; err: Buffer[]; sizes: { out: number; err: number }; max: number; started: boolean; done: (r: HostResult) => void }

/** What a request has read so far, as a result. */
const read = (p: Pending, r: Told): HostResult => {
  const outBuf = Buffer.concat(p.out)
  const errBuf = Buffer.concat(p.err)
  return { ...r, out: outBuf.toString('utf8'), err: errBuf.toString('utf8'), outBuf, errBuf }
}

/**
 * The runner's side of a host: its requests and what comes back. Once the host goes (its exit, a pipe's error) or says
 * something it shouldn't (a frame that isn't one, for an id that isn't waiting, out of order), every request still
 * waiting is told it was lost, once, and `lost` is called once with why; what was told before stays. Nothing is sent
 * after that. The child's errors are handled from the start.
 */
export class GitHost {
  private readonly pending = new Map<number, Pending>()
  private readonly decoder = new FrameDecoder()
  private next = 1
  private why: string | null = null
  private exited = false
  private outEnded = false

  constructor(
    readonly child: ChildProcess,
    private readonly lost: (why: string) => void
  ) {
    child.on('error', (e) => this.lose(`its process: ${e.message}`)) // i18n-ignore: a reason, logged
    child.stdin?.on('error', (e) => this.lose(`its input: ${e.message}`)) // i18n-ignore: a reason, logged
    child.stdout?.on('error', (e) => this.lose(`its output: ${e.message}`)) // i18n-ignore: a reason, logged
    child.stderr?.on('data', () => undefined)
    child.stderr?.on('error', () => undefined)
    child.stdout?.on('data', (d: Buffer) => {
      if (this.why) return
      try {
        for (const f of this.decoder.push(d)) this.take(f)
      } catch (e) {
        this.lose((e as Error).message)
      }
    })
    // Its exit is told once its output has ended, every frame it wrote read: what ended before then stays told.
    child.stdout?.on('end', () => {
      this.outEnded = true
      try {
        this.decoder.end()
      } catch (e) {
        return this.lose((e as Error).message)
      }
      if (this.exited) this.lose('it ended') // i18n-ignore: a reason, logged
    })
    child.once('exit', (code, signal) => {
      this.exited = true
      if (this.outEnded || !child.stdout) this.lose(`it ended (${code ?? signal})`) // i18n-ignore: a reason, logged
    })
  }

  /** Whether it can take requests: told to go, and not lost. */
  get usable(): boolean {
    return !this.why
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** Its gate opened: it runs requests from here on. */
  go(): void {
    this.child.stdin?.write(frameOf('G', 0))
  }

  /** Stops taking requests (its input ended): it exits once what runs has ended. */
  close(): void {
    try {
      this.child.stdin?.end()
    } catch {
      // Already gone: its exit tells.
    }
  }

  /**
   * Runs a command in it: its output and end, within its bounds (HI-2078: the host ends it there). Its request (all but
   * its input) over REQUEST_MAX is never sent (notRun 'E2BIG'); its input, however long (as git() takes it), follows in
   * pieces as the host takes them (HR3's round 1 finding 1: a patch-id's input runs to the platform's own bounds). One
   * sent while or before the host goes is lost, never taken for an answer. A host that sends more of an output than its
   * bound allows is lost too (what is read here stays bounded).
   */
  request(spec: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; input?: string } & HostBounds): Promise<HostResult> {
    if (this.why) return Promise.resolve(nothing({ code: null, lost: this.why }))
    const id = this.next++
    const { input, ...rest } = spec
    const meta = Buffer.from(JSON.stringify({ id, ...rest }))
    if (meta.length > REQUEST_MAX) return Promise.resolve(nothing({ err: `the command is too long for the merge queue's git host (${meta.length} bytes)`, code: null, notRun: 'E2BIG' })) // i18n-ignore: the command's side of an error, in English as git's messages are
    // No bound given: none. Zero is one (any byte is past it), as execFile's.
    const max = typeof spec.maxBuffer === 'number' ? spec.maxBuffer : Infinity
    return new Promise((done) => {
      this.pending.set(id, { out: [], err: [], sizes: { out: 0, err: 0 }, max, started: false, done })
      void this.send(id, meta, Buffer.from(input ?? '', 'utf8'))
    })
  }

  /** A request's frames: R, then its input in pieces (each written once the host has taken the last), then J. */
  private async send(id: number, meta: Buffer, input: Buffer): Promise<void> {
    const w = this.child.stdin!
    const put = async (b: Buffer): Promise<void> => {
      if (this.why || w.write(b)) return
      // The host takes no more for now: the next piece waits for it (or for the host to go: lost then).
      await new Promise<void>((res) => {
        const go = (): void => {
          w.off('drain', go)
          w.off('close', go)
          w.off('error', go)
          res()
        }
        w.on('drain', go)
        w.on('close', go)
        w.on('error', go)
      })
    }
    try {
      await put(frameOf('R', id, meta))
      for (let i = 0; i < input.length && !this.why; i += IN_CHUNK) await put(frameOf('I', id, input.subarray(i, i + IN_CHUNK)))
      if (!this.why) await put(frameOf('J', id))
    } catch (e) {
      this.lose(`its input: ${(e as Error).message}`) // i18n-ignore: a reason, logged
    }
  }

  private take(f: Frame): void {
    const p = this.pending.get(f.id)
    if (!p) return this.lose(`a frame for ${f.id}, which isn't waiting`) // i18n-ignore: a reason, logged
    const text = (): string => f.payload.toString('utf8')
    if (f.kind === 'S') {
      if (p.started) return this.lose(`a second start for ${f.id}`) // i18n-ignore: a reason, logged
      p.started = true
      return
    }
    if (f.kind === 'O' || f.kind === 'E') {
      // Its output, bounded here too: a start that failed says why before it says so (N); else only after its start.
      if (f.kind === 'O' && !p.started) return this.lose(`O for ${f.id} before its start`) // i18n-ignore: a reason, logged
      const which = f.kind === 'O' ? 'out' : 'err'
      p.sizes[which] += f.payload.length
      if (p.sizes[which] > p.max) return this.lose(`more ${which} for ${f.id} than its bound`) // i18n-ignore: a reason, logged
      p[which].push(f.payload)
      return
    }
    if (f.kind === 'N') {
      if (p.started) return this.lose(`a failed start for ${f.id}, which started`) // i18n-ignore: a reason, logged
      this.pending.delete(f.id)
      return p.done(read(p, { code: null, notRun: text() || 'error' }))
    }
    if (!p.started) return this.lose(`${f.kind} for ${f.id} before its start`) // i18n-ignore: a reason, logged
    if (f.kind === 'B') {
      const [why, still] = text().split(':')
      if ((why !== 'maxBuffer' && why !== 'timeout') || (still !== undefined && still !== 'alive')) return this.lose(`a bound that isn't one for ${f.id}`) // i18n-ignore: a reason, logged
      this.pending.delete(f.id)
      return p.done(read(p, { code: null, bounded: why, ...(still ? { alive: true } : {}) }))
    }
    const code = f.kind === 'X' ? Number(text()) : null
    if (f.kind === 'X' && !Number.isInteger(code)) return this.lose(`an exit that isn't a number for ${f.id}`) // i18n-ignore: a reason, logged
    this.pending.delete(f.id)
    p.done(read(p, { code, ...(f.kind === 'K' ? { signal: text() || 'unknown' } : {}) }))
  }

  /** The host gone, or not to be trusted: each request still waiting lost, once; `lost` told once; nothing sent after. */
  private lose(why: string): void {
    if (this.why) return
    this.why = why
    for (const [, p] of this.pending) p.done(read(p, { code: null, lost: why }))
    this.pending.clear()
    this.lost(why)
  }
}
