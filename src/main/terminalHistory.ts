import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createLogger } from './logger'

const log = createLogger('pty')

/** How much of a terminal's latest output is kept as it came (the replay's ordered tail). */
export const MAX_RAW = 512 * 1024
/** Lines of scrollback the base keeps above its screen: older ones are in no replay. */
const BASE_SCROLLBACK = 1000

/** Mode switches xterm keeps but its public modes don't show, so the serializer leaves them out. */
interface ExtraModes {
  /** The mouse's report encoding (1005 UTF-8, 1006 SGR, 1015 urxvt, 1016 SGR pixels), the last one set. */
  mouseEncoding?: number
  cursorHidden?: boolean
  /** The cursor's style (DECSCUSR), as its parameter. */
  cursorStyle?: number
  /** The scroll region (DECSTBM) each buffer has, as its parameters; a full-screen one is left out. */
  region: { normal?: string; alternate?: string }
}

const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016])

/**
 * A terminal's output, for a view made while its process runs (HI-3252): the latest MAX_RAW of it as it came, after a
 * snapshot of the terminal at the point where that starts. Output that falls off the raw queue is drawn into a headless
 * terminal (the base), made only then, so a terminal that never prints that much costs nothing; its snapshot carries
 * what the dropped output set and nothing later repeats: the screen in use, its cells, the cursor and the input modes
 * (mouse reporting and its encoding, bracketed paste…). The base takes the process's resizes where they came in the
 * output, so it draws each part at the size the process drew it at.
 */
export class TerminalHistory {
  private chunks: string[] = []
  private size = 0
  /** How many chunks have left the queue: the index of chunks[0] among all that were pushed. */
  private dropped = 0
  /** Resizes in the output still queued: `at` is the index of the first chunk drawn at that size. */
  private resizes: { at: number; cols: number; rows: number }[] = []
  /** The size at the queue's start: the base's (made at it) once it exists. */
  private cols: number
  private rows: number
  private base: { term: Terminal; serializer: SerializeAddon; extra: ExtraModes; written: number; parsed: number } | null = null
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
    const at = this.dropped + this.chunks.length
    const last = this.resizes.at(-1)
    if (last?.at === at) this.resizes.pop()
    this.resizes.push({ at, cols, rows })
  }

  /** The raw output kept, as it came (no snapshot): for its last lines in a log. */
  raw(): string {
    return this.chunks.join('')
  }

  /**
   * What a new view replays to show the terminal as it is: the base's snapshot, then the raw queue. Built in one step
   * once the base has taken in everything given to it, so output that arrives meanwhile is in it, and only what arrives
   * after it is sent (and so not lost, nor drawn twice) — the window's view relies on that (TerminalView).
   */
  async replay(): Promise<string> {
    for (let base = this.base; base && !this.broken && base.parsed < base.written; base = this.base) await new Promise<void>((r) => base!.term.write('', r))
    return this.snapshot() + this.chunks.join('')
  }

  dispose(): void {
    this.base?.term.dispose()
    this.base = null
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
    const base = this.base
    if (!base || this.broken) return
    base.written++
    base.term.write('', () => {
      base.parsed++
      this.guard(() => {
        base.term.resize(size.cols, size.rows)
        base.extra.region = {}
      })
    })
  }

  private feed(chunk: string): void {
    if (this.broken) return
    const base = this.base ?? this.makeBase()
    if (!base) return
    base.written++
    base.term.write(chunk, () => base.parsed++)
  }

  private makeBase(): TerminalHistory['base'] {
    return this.guard(() => {
      const term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: BASE_SCROLLBACK, allowProposedApi: true })
      const serializer = new SerializeAddon()
      term.loadAddon(serializer)
      const extra: ExtraModes = { region: {} }
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
      // A full reset (RIS) clears them all, as it does xterm's own.
      term.parser.registerEscHandler({ final: 'c' }, () => {
        extra.mouseEncoding = extra.cursorHidden = extra.cursorStyle = undefined
        extra.region = {}
        return false
      })
      this.base = { term, serializer, extra, written: 0, parsed: 0 }
      return this.base
    }) ?? null
  }

  /** The base as escape sequences that redraw it in a fresh terminal of its size, or nothing with no base. */
  private snapshot(): string {
    const base = this.base
    if (!base || this.broken) return ''
    return this.guard(() => {
      const { term, serializer, extra } = base
      let s = serializer.serialize({ scrollback: BASE_SCROLLBACK })
      if (extra.mouseEncoding) s += `\x1b[?${extra.mouseEncoding}h`
      if (extra.cursorStyle) s += `\x1b[${extra.cursorStyle} q`
      const buffer = term.buffer.active
      const region = extra.region[buffer.type]
      // The scroll region moves the cursor home: it goes back after it.
      if (region) s += `\x1b[${region}r\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`
      if (extra.cursorHidden) s += '\x1b[?25l'
      return s
    }) ?? ''
  }

  private guard<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch (err) {
      log.warn('terminal history: its snapshot failed, so a new view replays only the latest output', err)
      this.broken = true
      this.dispose()
      return undefined
    }
  }
}
