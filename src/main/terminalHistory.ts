import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createLogger } from './logger'

const log = createLogger('pty')

/** How much of a terminal's latest output is kept as it came (the replay's ordered tail). */
export const MAX_RAW = 512 * 1024
/** Lines of scrollback the base keeps above its screen: older ones are in no replay. */
const BASE_SCROLLBACK = 1000
/** Lines of scrollback a replay rebuilt at the terminal's size keeps (rebuilt): a view's own default. */
const REBUILT_SCROLLBACK = 10000
/** The longest unfinished escape sequence held back from the base: a longer one (a string never ended) goes in as it is. */
const MAX_UNFINISHED = 64 * 1024
/** At most this many rendition (SGR) changes since the last reset are kept to restore it; older ones go first. */
const MAX_SGR = 64

const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016])

/**
 * Where `text`, read from the parser's ground state, ends inside an escape sequence (CSI, OSC, DCS and the other strings,
 * a plain ESC sequence) or between a character's two UTF-16 halves: the index that sequence or character starts at, else
 * its length. What comes before that index leaves a terminal's parser where it started, so a snapshot taken there is
 * complete; what comes after it goes in with the rest of the output (HR1's round 1, HI-3252).
 */
export function completeUpTo(text: string): number {
  // 0 ground, 1 after ESC, 2 an ESC sequence's intermediates, 3 CSI, 4 a string (OSC, DCS, SOS, PM, APC), 5 ESC in a string
  let state = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // CAN and SUB cancel any sequence.
    if (c === 0x18 || c === 0x1a) {
      state = 0
      continue
    }
    if (state === 0) {
      if (c === 0x1b) state = 1
      else if (c === 0x9b) state = 3
      else if (c === 0x9d || c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) state = 4
      if (state) start = i
    } else if (state === 1 || state === 2) {
      if (c === 0x1b) {
        state = 1
        start = i
      } else if (state === 1 && c === 0x5b) state = 3
      else if (state === 1 && (c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f)) state = 4
      else if (c >= 0x20 && c <= 0x2f) state = 2
      else if (c >= 0x30 && c <= 0x7e) state = 0
      // C0 controls inside are carried out, and the sequence goes on.
    } else if (state === 3) {
      if (c === 0x1b) {
        state = 1
        start = i
      } else if (c >= 0x40 && c <= 0x7e) state = 0
    } else if (state === 4) {
      if (c === 0x07 || c === 0x9c) state = 0
      else if (c === 0x1b) state = 5
    } else if (c === 0x5c) state = 0
    else {
      // An ESC that isn't the string's terminator ends it and begins a sequence of its own: read this one after that ESC.
      state = 1
      start = i - 1
      i--
    }
  }
  if (state) return start
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length
}

/** Mode switches and state xterm keeps but its public API doesn't show, so the serializer leaves them out. */
interface ExtraState {
  /** The mouse's report encoding (1005 UTF-8, 1006 SGR, 1015 urxvt, 1016 SGR pixels), the last one set. */
  mouseEncoding?: number
  cursorHidden?: boolean
  /** The cursor's style (DECSCUSR), as its parameter. */
  cursorStyle?: number
  /** The scroll region (DECSTBM) each buffer has, as its parameters; a full-screen one is left out. */
  region: { normal?: string; alternate?: string }
  /** The rendition (SGR) changes since its last reset, as their parameters: what text written next is drawn with. */
  sgr: string[]
  /** The hyperlink (OSC 8) open now, as its parameters and address: text written next links to it. */
  link?: string
}

/** SGR's parameters as written (sub-parameters after a colon, an empty one -1 in xterm's), from xterm's parsed ones. */
function sgrParams(params: (number | number[])[]): string {
  let s = ''
  for (const p of params) s += Array.isArray(p) ? `:${p.map((n) => (n < 0 ? '' : n)).join(':')}` : `${s ? ';' : ''}${p}`
  return s
}

/** Reads `target`'s properties, methods bound to it, and `override`'s in their place. */
function readThrough<T extends object>(target: T, override: (key: PropertyKey) => unknown): T {
  return new Proxy(target, {
    get: (t, key) => {
      const own = override(key)
      if (own !== undefined) return own
      const v = Reflect.get(t, key, t) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
    }
  })
}

/**
 * The terminal as the serializer reads it, each line no longer than the terminal is wide: narrowed, a buffer that
 * doesn't re-wrap (the alternate one) keeps its lines' cells beyond the width, hidden, and the serializer would write
 * them out, to wrap onto the next rows of the view (HR1's round 1, finding 2).
 */
function widthBound(term: Terminal): Terminal {
  type Buffer = Terminal['buffer']['active']
  const bound = (buffer: Buffer): Buffer =>
    readThrough(buffer, (key) =>
      key === 'getLine'
        ? (y: number) => {
            const line = buffer.getLine(y)
            return line && readThrough(line, (k) => (k === 'length' ? Math.min(line.length, term.cols) : undefined))
          }
        : undefined)
  return readThrough(term, (key) =>
    key === 'buffer' ? readThrough(term.buffer, (k) => (k === 'active' || k === 'normal' || k === 'alternate' ? bound(term.buffer[k]) : undefined)) : undefined)
}

/** A headless terminal fed output in order, which can be written out as the escape sequences that redraw it. */
class Mirror {
  readonly term: Terminal
  private readonly serializer = new SerializeAddon()
  private readonly extra: ExtraState = { region: {}, sgr: [] }
  private written = 0
  private parsed = 0

  constructor(cols: number, rows: number, readonly scrollback: number) {
    const term = (this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true }))
    this.serializer.activate(widthBound(term) as unknown as Parameters<SerializeAddon['activate']>[0])
    const extra = this.extra
    // Each handler notes the switch and lets xterm's own handle it (false).
    const mode = (on: boolean) => (params: (number | number[])[]): boolean => {
      for (const p of params) {
        if (typeof p !== 'number') continue
        if (MOUSE_ENCODINGS.has(p)) extra.mouseEncoding = on ? p : extra.mouseEncoding === p ? undefined : extra.mouseEncoding
        else if (p === 25) extra.cursorHidden = !on
      }
      return false
    }
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, mode(true))
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, mode(false))
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      const p = params[0]
      extra.cursorStyle = typeof p === 'number' && p > 0 ? p : undefined
      return false
    })
    term.parser.registerCsiHandler({ final: 'r' }, (params) => {
      const [top, bottom] = params.map((p) => (typeof p === 'number' ? p : 0))
      const full = (!top || top === 1) && (!bottom || bottom >= term.rows)
      extra.region[term.buffer.active.type] = full ? undefined : `${top || 1};${bottom || term.rows}`
      return false
    })
    term.parser.registerCsiHandler({ final: 'm' }, (params) => {
      // Kept from its last reset (a 0 of its own, not a colour's index after 38;5 or in 38;2;r;g;b).
      let reset = params.length ? -1 : 0
      for (let j = 0; j < params.length; j++) {
        const p = params[j]
        if (p === 0) reset = j
        else if ((p === 38 || p === 48 || p === 58) && params[j + 1] === 5) j += 2
        else if ((p === 38 || p === 48 || p === 58) && params[j + 1] === 2) j += 4
      }
      if (reset >= 0) extra.sgr = []
      const kept = sgrParams(params.slice(reset + 1))
      if (kept) extra.sgr.push(kept)
      if (extra.sgr.length > MAX_SGR) extra.sgr.shift()
      return false
    })
    term.parser.registerOscHandler(8, (data) => {
      // "params;address": an empty address closes the link.
      extra.link = data.slice(data.indexOf(';') + 1) ? data : undefined
      return false
    })
    // A full reset (RIS) clears them all, as it does xterm's own.
    term.parser.registerEscHandler({ final: 'c' }, () => {
      extra.mouseEncoding = extra.cursorHidden = extra.cursorStyle = extra.link = undefined
      extra.region = {}
      extra.sgr = []
      return false
    })
  }

  write(data: string): void {
    this.written++
    this.term.write(data, () => this.parsed++)
  }

  /** A resize, taken after what it was given before it. */
  resize(cols: number, rows: number, failed: (err: unknown) => void): void {
    this.written++
    this.term.write('', () => {
      this.parsed++
      try {
        this.term.resize(cols, rows)
        this.extra.region = {}
      } catch (err) {
        failed(err)
      }
    })
  }

  /** Resolves once it has taken in everything it was given. */
  async caughtUp(): Promise<void> {
    while (this.parsed < this.written) await new Promise<void>((r) => this.term.write('', r))
  }

  /** It as escape sequences that redraw it in a fresh terminal of its size. */
  serialize(): string {
    const { term, extra } = this
    // The serializer leaves the normal screen's rendition set as it switches to the alternate one, which a terminal clears
    // with that background: the alternate screen's own cells come after.
    let s = this.serializer.serialize({ scrollback: this.scrollback }).replace('\x1b[?1049h', '\x1b[0m\x1b[?1049h')
    if (extra.mouseEncoding) s += `\x1b[?${extra.mouseEncoding}h`
    if (extra.cursorStyle) s += `\x1b[${extra.cursorStyle} q`
    const buffer = term.buffer.active
    const region = extra.region[buffer.type]
    if (region) s += `\x1b[${region}r`
    // The cursor where it is: the scroll region moves it home, and the serializer's own move back from a full row's
    // end lands a column short. One past the last column (a line feed due) is left as the serializer put it.
    if (buffer.cursorX < term.cols && !term.modes.originMode) s += `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`
    if (extra.cursorHidden) s += '\x1b[?25l'
    // What text written next is drawn with: the cells serialized leave their own rendition.
    s += '\x1b[0m' + extra.sgr.map((p) => `\x1b[${p}m`).join('')
    // The cells serialized lose their links (the serializer writes none); the one open still links what comes next.
    if (extra.link) s += `\x1b]8;${extra.link}\x1b\\`
    return s
  }

  dispose(): void {
    this.term.dispose()
  }
}

/**
 * A terminal's output, for a view made while its process runs (HI-3252): the latest MAX_RAW of it as it came, after a
 * snapshot of the terminal at the point where that starts. Output that falls off the raw queue is drawn into a headless
 * terminal (the base), made only then, so a terminal that never prints that much costs nothing; its snapshot carries
 * what the dropped output set and nothing later repeats: the screen in use, its cells, the cursor, the rendition and the
 * input modes (mouse reporting and its encoding, bracketed paste…). The base takes only whole escape sequences, the rest
 * held back to go before the raw queue, and the process's resizes where they came in the output, so it draws each part
 * at the size the process drew it at. A replay while resizes are still in the raw queue is rebuilt at the size the
 * terminal has now, each part drawn at its own size first (rebuilt).
 */
export class TerminalHistory {
  private chunks: string[] = []
  private size = 0
  /** How many chunks have left the queue: the index of chunks[0] among all that were pushed. */
  private dropped = 0
  /** Resizes in the output still queued: `at` is the index of the first chunk drawn at that size. */
  private resizes: { at: number; cols: number; rows: number }[] = []
  /** How many resizes have been given: a replay rebuilt while another comes is built again. */
  private resizeCount = 0
  /** The size at the queue's start: the base's (made at it) once it exists. */
  private cols: number
  private rows: number
  private base: Mirror | null = null
  /** The end of what fell off the queue that the base hasn't been given: an escape sequence not finished there. */
  private unfinished = ''
  /** The base failed (a parse that threw): replays are the raw queue alone, as before HI-3252. */
  private broken = false

  constructor(cols: number, rows: number, private readonly max = MAX_RAW) {
    this.cols = cols
    this.rows = rows
  }

  /** Output as it came from the process. */
  push(data: string): void {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.max && this.chunks.length > 1) this.drop()
  }

  /** The process was resized: output from now on is drawn at this size. */
  resized(cols: number, rows: number): void {
    this.resizeCount++
    // Nothing queued was drawn at the old size (a pane's first fit, before any output): the queue starts at this one.
    if (!this.chunks.length) return this.apply({ cols, rows })
    const at = this.dropped + this.chunks.length
    const last = this.resizes.at(-1)
    if (last?.at === at) this.resizes.pop()
    this.resizes.push({ at, cols, rows })
  }

  /** The raw output kept, as it came (no snapshot): for its last lines in a log. */
  raw(): string {
    return this.unfinished + this.chunks.join('')
  }

  /**
   * What a new view, at the terminal's size now, replays to show the terminal as it is: the base's snapshot, then the
   * raw queue (or, with resizes in it, the terminal rebuilt). Built in one step once what it is built from has taken in
   * everything given to it, so output that arrives meanwhile is in it, and only what arrives after it is sent (and so
   * not lost, nor drawn twice) — the window's view relies on that (TerminalView).
   */
  async replay(): Promise<string> {
    if (this.resizes.length) {
      const rebuilt = await this.rebuilt()
      if (rebuilt !== null) return rebuilt
    }
    await this.baseCaughtUp()
    return this.snapshot() + this.unfinished + this.chunks.join('')
  }

  dispose(): void {
    this.base?.dispose()
    this.base = null
  }

  private async baseCaughtUp(): Promise<void> {
    for (let base = this.base; base && !this.broken; base = this.base) {
      await base.caughtUp()
      if (this.base === base) return
    }
  }

  /**
   * The terminal drawn afresh: the base's snapshot, then the raw queue with its resizes where they came, in a headless
   * terminal, written out at the size it ends at, with what arrived while it was drawn after it. Null if it couldn't be.
   */
  private async rebuilt(): Promise<string | null> {
    // Built again while resizes keep coming (or the queue moved past it), a few times at most: then as without resizes.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.baseCaughtUp()
      const resizesBefore = this.resizeCount
      const from = this.dropped
      const chunks = [...this.chunks]
      const resizes = this.resizes.filter((r) => r.at >= from)
      // What follows the snapshot: the sequence it was left inside (held back from the base), then the queue. Its end may
      // stop inside an escape sequence too, one begun in either (HR1's round 2): drawn up to it, that part goes after the
      // drawing, as output still to come (completeUpTo, read from the snapshot's ground state).
      const held = this.unfinished
      const text = held + chunks.join('')
      let cut = completeUpTo(text)
      if (text.length - cut > MAX_UNFINISHED) cut = text.length
      let mirror: Mirror | null = null
      try {
        mirror = new Mirror(this.cols, this.rows, REBUILT_SCROLLBACK)
        let failure: unknown = null
        const failed = (err: unknown): void => void (failure ??= err)
        mirror.write(this.snapshot() + held.slice(0, cut))
        let at = held.length
        for (const [i, chunk] of chunks.entries()) {
          while (resizes.length && resizes[0].at <= from + i) {
            const r = resizes.shift()!
            mirror.resize(r.cols, r.rows, failed)
          }
          if (at < cut) mirror.write(chunk.slice(0, cut - at))
          at += chunk.length
        }
        for (const r of resizes) mirror.resize(r.cols, r.rows, failed)
        await mirror.caughtUp()
        if (failure) throw failure
        if (this.resizeCount !== resizesBefore || this.dropped > from + chunks.length || this.broken) continue
        // In one step from here: what arrived while it was drawn comes after it.
        return mirror.serialize() + text.slice(cut) + this.chunks.slice(from + chunks.length - this.dropped).join('')
      } catch (err) {
        log.warn('terminal history: rebuilding its replay at the terminal’s size failed, so a view replays the output as it came', err)
        return null
      } finally {
        mirror?.dispose()
      }
    }
    return null
  }

  private drop(): void {
    const chunk = this.chunks.shift()!
    this.size -= chunk.length
    while (this.resizes.length && this.resizes[0].at <= this.dropped) this.apply(this.resizes.shift()!)
    this.dropped++
    this.feed(chunk)
  }

  /** A resize reached the queue's start: the base (if any) takes it after what it was given before it. */
  private apply(size: { cols: number; rows: number }): void {
    this.cols = size.cols
    this.rows = size.rows
    if (this.base && !this.broken) this.base.resize(size.cols, size.rows, (err) => this.fail(err))
  }

  /** Gives the base what fell off the queue, up to the end of its last whole escape sequence (completeUpTo). */
  private feed(chunk: string): void {
    if (this.broken) return
    const text = this.unfinished + chunk
    let cut = completeUpTo(text)
    if (text.length - cut > MAX_UNFINISHED) cut = text.length
    this.unfinished = text.slice(cut)
    if (!cut) return
    const base = this.base ?? this.makeBase()
    base?.write(text.slice(0, cut))
  }

  private makeBase(): Mirror | null {
    try {
      return (this.base = new Mirror(this.cols, this.rows, BASE_SCROLLBACK))
    } catch (err) {
      this.fail(err)
      return null
    }
  }

  /** The base as escape sequences that redraw it in a fresh terminal of its size, or nothing with no base. */
  private snapshot(): string {
    if (!this.base || this.broken) return ''
    try {
      return this.base.serialize()
    } catch (err) {
      this.fail(err)
      return ''
    }
  }

  private fail(err: unknown): void {
    log.warn('terminal history: its snapshot failed, so a new view replays only the latest output', err)
    this.broken = true
    // What was held back for it would stand before a gap: the raw queue alone from now.
    this.unfinished = ''
    this.dispose()
  }
}
