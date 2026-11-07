import { Terminal } from '@xterm/headless'
import { createLogger } from './logger'

const log = createLogger('screen')

/**
 * A session terminal's visible screen, kept in the main process so Combwork can read what the CLI shows (its footer)
 * rather than the raw output: a CLI that redraws only the characters that changed (Claude Code without colours,
 * NO_COLOR) never sends the whole line again. One line of scrollback, so it holds one screen (rows × cols cells) and a
 * line: xterm 6.0's reflow, narrowing and shortening at once, can leave a buffer kept to exactly one screen with fewer
 * lines than it shows, and a line feed then throws in its write timer, out of reach of any catch (#1572).
 */
export class TerminalScreen {
  private term: Terminal | null
  /** Writes not taken in yet, with what runs once they are: a terminal rebuilt carries them over. */
  private pending = new Set<() => void>()

  constructor(cols: number, rows: number) {
    this.term = TerminalScreen.create(cols, rows)
  }

  private static create(cols: number, rows: number): Terminal {
    return new Terminal({ cols, rows, scrollback: 1, allowProposedApi: true })
  }

  /** Renders `data`; `parsed` runs once the terminal has taken it in (not after dispose). */
  write(data: string, parsed?: () => void): void {
    const term = this.term
    if (!term) return
    const done = (): void => {
      if (!this.pending.delete(done)) return
      if (this.term) parsed?.()
    }
    this.pending.add(done)
    term.write(data, done)
  }

  resize(cols: number, rows: number): void {
    if (!this.term || cols < 2 || rows < 2) return
    this.term.resize(Math.floor(cols), Math.floor(rows))
    if (!this.broken(this.term)) return
    // A resize left fewer lines than the screen shows: the next line feed would throw in xterm's write timer and stop
    // this screen for good. Start a blank one at the new size instead: the CLI's terminal redraws after a resize.
    log.warn(`a resize to ${Math.floor(cols)}×${Math.floor(rows)} left the screen with fewer lines than it shows: started it again`)
    this.rebuild()
  }

  /** Whether a buffer it reads or may go back to holds fewer lines than its screen (the alternate one only while shown). */
  private broken(term: Terminal): boolean {
    const short = (b: Terminal['buffer']['normal']): boolean => b.length < b.baseY + term.rows
    return short(term.buffer.normal) || (term.buffer.active.type === 'alternate' && short(term.buffer.alternate))
  }

  private rebuild(): void {
    const old = this.term!
    const term = TerminalScreen.create(old.cols, old.rows)
    // What Combwork reads besides the cells: bracketed paste (#597), and which screen the CLI draws on.
    const modes = (old.buffer.active.type === 'alternate' ? '\x1b[?1049h' : '') + (old.modes.bracketedPasteMode ? '\x1b[?2004h' : '')
    if (modes) term.write(modes)
    this.term = term
    old.dispose()
    // The old terminal's pending writes never finish: what waits on them runs once the new one has caught up.
    for (const done of [...this.pending]) term.write('', done)
  }

  /** Whether the CLI has turned bracketed paste on (#597): it then reads a pasted line as text, however it arrives. */
  bracketedPaste(): boolean {
    return !!this.term?.modes.bracketedPasteMode
  }

  /** The visible lines, top to bottom, without trailing blanks. */
  text(): string {
    const buf = this.term?.buffer.active
    if (!buf) return ''
    const lines: string[] = []
    for (let i = 0; i < this.term!.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  /**
   * The visible lines with dim cells blanked (HI-1959): what the user or Combwork typed, without a CLI's dim hint where
   * nothing is typed (Claude Code 2.1.312's empty input shows `Try "how does <filepath> work?"`, dim). The hint's first
   * letter under the CLI's own cursor (inverse, not dim, followed by the dim rest: Claude Code while its terminal
   * reports the focus, HI-2692) is the hint too, and is blanked; an inverse letter in a draft is followed by the draft.
   */
  textWithoutDim(): string {
    const buf = this.term?.buffer.active
    if (!buf) return ''
    const lines: string[] = []
    for (let i = 0; i < this.term!.rows; i++) {
      const line = buf.getLine(buf.viewportY + i)
      let row = ''
      const width = line?.length ?? 0
      for (let x = 0; x < width; x++) {
        const cell = line!.getCell(x)
        // The second half of a wide character: drawn with the first.
        if (!cell || cell.getWidth() === 0) continue
        const cursorOnHint = !!cell.isInverse() && !!line!.getCell(x + cell.getWidth())?.isDim()
        row += cell.isDim() || cursorOnHint ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' '
      }
      lines.push(row.trimEnd())
    }
    return lines.join('\n')
  }

  dispose(): void {
    this.term?.dispose()
    this.term = null
    this.pending.clear()
  }
}
