// What a new view of a running terminal replays (HI-3252): once its output outgrows the raw queue, a snapshot of the
// terminal where the queue starts comes first, so a CLI that switched to the alternate screen, turned mouse reporting and
// bracketed paste on and drew a header once, then only updates a few cells, is shown as it is, not as the suffix alone.
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { completeUpTo, MAX_RAW, TerminalHistory } from '../src/main/terminalHistory'

vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined }) }))

const write = (t: Terminal, d: string): Promise<void> => new Promise((r) => t.write(d, r))

/**
 * What a view shows and how it takes input: the screen in use, its lines, each cell's rendition (colours, bold), the
 * cursor and the input modes.
 */
function state(t: Terminal): unknown {
  const b = t.buffer.active
  const lines: string[] = []
  const attrs: string[] = []
  for (let i = 0; i < t.rows; i++) {
    const line = b.getLine(b.viewportY + i)
    // What it shows: a narrowed buffer that doesn't re-wrap keeps cells beyond its width, hidden.
    lines.push(line?.translateToString(true, 0, t.cols) ?? '')
    let a = ''
    // A 256-colour index under 16 is the same colour as the 16-colour one: the serializer writes it as that.
    const colour = (palette: boolean, mode: number, n: number): string => (palette && n < 16 ? `p/${n}` : `${mode}/${n}`)
    for (let x = 0; x < (line ? t.cols : 0); x++) {
      const c = line!.getCell(x)!
      // Its rendition, not its hyperlink: links drawn before the cut aren't kept (the serializer writes none).
      if (c.getFgColorMode() || c.getBgColorMode() || c.isBold() || c.isUnderline() || c.isItalic() || c.isInverse() || c.isDim()) a += `${x}:${colour(c.isFgPalette(), c.getFgColorMode(), c.getFgColor())}/${colour(c.isBgPalette(), c.getBgColorMode(), c.getBgColor())}/${c.isBold()}/${c.isUnderline()} `
    }
    attrs.push(a)
  }
  const core = (t as unknown as { _core: { coreMouseService: { activeEncoding: string }; coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string } } } })._core
  return { buffer: b.type, lines, attrs, cursor: [b.cursorX, b.cursorY], modes: { ...t.modes }, encoding: core.coreMouseService.activeEncoding, hidden: core.coreService.isCursorHidden, cursorStyle: core.coreService.decPrivateModes.cursorStyle }
}

/** A terminal and a history given the same output and resizes, in order. */
function pair(cols: number, rows: number, max: number): { live: Terminal; history: TerminalHistory; out: (d: string) => Promise<void>; resize: (c: number, r: number) => Promise<void> } {
  const live = new Terminal({ cols, rows, allowProposedApi: true })
  const history = new TerminalHistory(cols, rows, max)
  return {
    live,
    history,
    out: async (d) => {
      history.push(d)
      await write(live, d)
    },
    resize: async (c, r) => {
      await write(live, '')
      live.resize(c, r)
      history.resized(c, r)
    }
  }
}

/** A fresh view of the size given, with the replay written into it. */
async function view(history: TerminalHistory, cols: number, rows: number): Promise<Terminal> {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await write(t, await history.replay())
  return t
}

const SEED = '\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[1;1H\x1b[1;33mPersistent header\x1b[0m'
const frame = (i: number): string => `\x1b[2;1H\x1b[32mupdate ${i}\x1b[0m\x1b[K\x1b[3;1Hrow three ${i}\x1b[K\x1b[4;1H${'·'.repeat(160)}`

describe("a running terminal's replay", () => {
  it('restores the alternate screen, its input modes and cells drawn once, after the queue has dropped them', async () => {
    // HG1's probe shape (HI-3251): the modes and the header once, then thousands of frames rewriting a few rows.
    const live = new Terminal({ cols: 120, rows: 32, allowProposedApi: true })
    const history = new TerminalHistory(120, 32)
    history.push(SEED)
    let all = SEED
    for (let i = 0; all.length < MAX_RAW * 1.2; i++) {
      const f = frame(i)
      history.push(f)
      all += f
    }
    await write(live, all)
    expect(history.raw().length).toBeLessThanOrEqual(MAX_RAW)
    expect(history.raw()).not.toContain('?1049h')
    const shown = await view(history, 120, 32)
    expect(state(shown)).toEqual(state(live))
    expect(state(shown)).toMatchObject({ buffer: 'alternate', modes: { bracketedPasteMode: true, mouseTrackingMode: 'vt200' }, encoding: 'SGR', hidden: true })
    expect((state(shown) as { lines: string[] }).lines[0]).toBe('Persistent header')
  })

  it('is the output as it came while it fits the queue', async () => {
    const history = new TerminalHistory(80, 24, 1000)
    history.push(SEED)
    history.push('more')
    expect(await history.replay()).toBe(SEED + 'more')
  })

  it('draws each part at the size the process drew it at', async () => {
    const live = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
    const history = new TerminalHistory(80, 10, 400)
    const out = async (d: string): Promise<void> => {
      history.push(d)
      await write(live, d)
    }
    await out(`\x1b[1;1H${'w'.repeat(70)}`)
    history.resized(40, 10)
    live.resize(40, 10)
    for (let i = 0; i < 40; i++) await out(`\x1b[5;1Hline ${i}\x1b[K`)
    expect(history.raw()).not.toContain('www')
    expect(state(await view(history, 40, 10))).toEqual(state(live))
  })

  it('loses nothing nor draws it twice when output arrives while it is built', async () => {
    const live = new Terminal({ cols: 60, rows: 10, allowProposedApi: true })
    const history = new TerminalHistory(60, 10, 300)
    const out = async (d: string): Promise<void> => {
      history.push(d)
      await write(live, d)
    }
    await out(SEED)
    for (let i = 0; i < 30; i++) await out(`\x1b[3;1Hn ${i}\x1b[K`)
    // The base has output still to take in as the replay starts, and more comes before it is built.
    for (let i = 30; i < 40; i++) history.push(`\x1b[3;1Hn ${i}\x1b[K`)
    const replay = history.replay()
    for (let i = 40; i < 50; i++) history.push(`\x1b[4;1Hm ${i}\x1b[K`)
    const shown = new Terminal({ cols: 60, rows: 10, allowProposedApi: true })
    await write(shown, await replay)
    // What comes after it was built reaches the view as live output.
    const later = '\x1b[5;1Hafter'
    history.push(later)
    await write(shown, later)
    for (let i = 30; i < 40; i++) await write(live, `\x1b[3;1Hn ${i}\x1b[K`)
    for (let i = 40; i < 50; i++) await write(live, `\x1b[4;1Hm ${i}\x1b[K`)
    await write(live, later)
    expect(state(shown)).toEqual(state(live))
  })

  it('restores a scroll region and the cursor style, and a full reset clears them', async () => {
    const live = new Terminal({ cols: 50, rows: 12, allowProposedApi: true })
    const history = new TerminalHistory(50, 12, 300)
    const out = async (d: string): Promise<void> => {
      history.push(d)
      await write(live, d)
    }
    await out('\x1b[?1049h\x1b[3;10r\x1b[5 q\x1b[1;1Htop')
    for (let i = 0; i < 40; i++) await out(`\x1b[10;1Hscrolled ${i}\n`)
    const shown = await view(history, 50, 12)
    // Lines scrolled inside the region, the top line kept.
    await out('\x1b[10;1Hone more\n')
    await write(shown, '\x1b[10;1Hone more\n')
    expect(state(shown)).toEqual(state(live))
    // DECSCUSR 5 is a blinking bar.
    expect(state(shown)).toMatchObject({ cursorStyle: 'bar' })

    const reset = new TerminalHistory(50, 12, 100)
    reset.push('\x1b[?1006h\x1b[3;10r\x1b[?25l')
    reset.push('\x1bc')
    for (let i = 0; i < 20; i++) reset.push(`\x1b[2;1Hupdate ${i}`)
    expect(reset.raw()).not.toContain('\x1bc')
    const snapshot = await reset.replay()
    expect(snapshot).not.toContain('?1006h')
    expect(snapshot).not.toContain('?25l')
    expect(snapshot).not.toMatch(/\x1b\[3;10r/)
  })

  // HR1's round 1, finding 1: output comes in chunks cut anywhere, inside an escape sequence or a character too.
  it('is the same wherever a chunk cuts what fell off the queue from what is kept', async () => {
    const stream = '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b]0;a title\x07\x1bP$qm\x1b\\\x1b[2;3H\x1b[31;1mred \u{1f600}\x1b[38;5;0mzero\x1b[48:2::10:20:30mrgb\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b[0;4munder'
    const filler = '\x1b[5;1Hfiller'
    for (let k = 1; k < stream.length; k++) {
      // At most what follows the cut: the first chunk falls off, the second stays.
      const { live, history, out } = pair(40, 8, stream.length - k + filler.length)
      await out(stream.slice(0, k))
      await out(stream.slice(k))
      await out(filler)
      expect(state(await view(history, 40, 8)), `cut at ${k}: ${JSON.stringify(stream.slice(k - 3, k + 3))}`).toEqual(state(live))
    }
  })

  it('restores mouse encoding split across the cut, and the rendition text after it is drawn with', async () => {
    // HR1's probe: the mode's parameter cut in two, the second half in the kept output.
    const { live, history, out } = pair(80, 8, 32)
    await out('\x1b[?1049h\x1b[?1000h')
    await out('\x1b[?100')
    await out('6h' + 'x'.repeat(32))
    const shown = await view(history, 80, 8)
    expect(state(shown)).toEqual(state(live))
    expect(state(shown)).toMatchObject({ encoding: 'SGR' })
    expect((state(shown) as { lines: string[] }).lines[0]).toBe('x'.repeat(32))

    const sgr = pair(40, 6, 40)
    await sgr.out('\x1b[31;1m')
    await sgr.out('\x1b[3;1H' + '·'.repeat(36))
    await sgr.out('\x1b[1;1Hred text')
    expect(sgr.history.raw()).not.toContain('31;1m')
    expect(state(await view(sgr.history, 40, 6))).toEqual(state(sgr.live))
  })

  // HR1's round 1, finding 2: resizes still in the kept output, or with nothing after them.
  it('draws output still kept at the size it was drawn at, after a resize', async () => {
    for (const alternate of [true, false]) {
      // HR1's probe: 80 wide, then 20, the wide rows' chunk partly kept.
      const { live, history, out, resize } = pair(80, 10, 100)
      await out(`${alternate ? '\x1b[?1049h' : ''}${'A'.repeat(50)}`)
      await out(`\x1b[5;1H${'b'.repeat(70)}`)
      await resize(20, 10)
      await out('\x1b[9;1HZ')
      expect(state(await view(history, 20, 10)), alternate ? 'alternate' : 'classic').toEqual(state(live))

      // A resize with no output after it, and one while nothing has fallen off the queue.
      const quiet = pair(60, 8, 120)
      await quiet.out(`${alternate ? '\x1b[?1049h' : ''}${'w'.repeat(50)}`)
      await quiet.out(`\x1b[4;1H${'v'.repeat(55)}`)
      await quiet.out(`\x1b[6;1H${'u'.repeat(40)}`)
      await quiet.resize(30, 8)
      expect(state(await view(quiet.history, 30, 8)), `${alternate ? 'alternate' : 'classic'}, nothing after`).toEqual(state(quiet.live))
      const small = pair(60, 8, 10_000)
      await small.out(`${alternate ? '\x1b[?1049h' : ''}${'w'.repeat(50)}`)
      await small.resize(30, 8)
      await small.out('\x1b[3;1Hafter')
      expect(state(await view(small.history, 30, 8)), `${alternate ? 'alternate' : 'classic'}, under the limit`).toEqual(state(small.live))
    }
  })

  it('finds where output stops inside an escape sequence or a character', () => {
    for (const [text, at] of [
      ['plain', 5],
      ['ab\x1b', 2],
      ['ab\x1b[?100', 2],
      ['ab\x1b[?1006h', 10],
      ['a\x1b]0;title', 1],
      ['a\x1b]0;title\x07b', 12],
      ['a\x1b]0;t\x1b\\b', 9],
      ['a\x1bP$qm\x1b', 1],
      // An ESC in a string that isn't its end ends it, and starts a sequence of its own.
      ['a\x1b]0;t\x1b[3', 6],
      // CAN cancels the sequence.
      ['a\x1b[12\x18b', 7],
      ['a\x1b(', 1],
      ['a\x1b(B', 4],
      ['x\u{1f600}', 3],
      ['x\ud83d', 1],
      ['\x9b1;2', 0]
    ] as const)
      expect(completeUpTo(text), JSON.stringify(text)).toBe(at)
  })

  it('keeps the hyperlink open at the cut for the text after it', async () => {
    const history = new TerminalHistory(40, 6, 40)
    history.push('\x1b]8;;https://example.com\x1b\\')
    history.push('\x1b[3;1H' + '·'.repeat(36))
    history.push('link')
    const replay = await history.replay()
    expect(replay.indexOf('\x1b]8;;https://example.com\x1b\\')).toBeGreaterThanOrEqual(0)
    expect(replay.indexOf('\x1b]8;;https://example.com\x1b\\')).toBeLessThan(replay.lastIndexOf('link'))
  })

  it('is the output as it came, under the limit, when only a first fit came before it', async () => {
    const history = new TerminalHistory(120, 32, 1000)
    history.resized(90, 30)
    history.push('\x1b[?1049hfirst screen')
    expect(await history.replay()).toBe('\x1b[?1049hfirst screen')
  })
})
