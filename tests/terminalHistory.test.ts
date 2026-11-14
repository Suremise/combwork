// What a new view of a running terminal replays (HI-3252): once its output outgrows the raw queue, a snapshot of the
// terminal where the queue starts comes first, so a CLI that switched to the alternate screen, turned mouse reporting and
// bracketed paste on and drew a header once, then only updates a few cells, is shown as it is, not as the suffix alone.
import { Terminal } from '@xterm/headless'
import { describe, expect, it, vi } from 'vitest'
import { MAX_RAW, TerminalHistory } from '../src/main/terminalHistory'

vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined }) }))

const write = (t: Terminal, d: string): Promise<void> => new Promise((r) => t.write(d, r))

/** What a view shows and how it takes input: the screen in use, its lines, the cursor and the input modes. */
function state(t: Terminal): unknown {
  const b = t.buffer.active
  const lines: string[] = []
  for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  const core = (t as unknown as { _core: { coreMouseService: { activeEncoding: string }; coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: string } } } })._core
  return { buffer: b.type, lines, cursor: [b.cursorX, b.cursorY], modes: { ...t.modes }, encoding: core.coreMouseService.activeEncoding, hidden: core.coreService.isCursorHidden, cursorStyle: core.coreService.decPrivateModes.cursorStyle }
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
})
