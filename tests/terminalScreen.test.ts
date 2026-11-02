// The headless screen Hive keeps of each session's terminal (TerminalScreen, #1572): whatever a CLI prints, at whatever
// size, never stops it, and never throws where nothing can catch it (xterm parses in its own timer).
import { afterEach, describe, expect, it, vi } from 'vitest'

const { warnings } = vi.hoisted(() => ({ warnings: [] as string[] }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: (m: string) => void warnings.push(m), debug: () => undefined }), userText: (s: string) => s }))
const { TerminalScreen } = await import('../src/main/terminalScreen')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

type Screen = InstanceType<typeof TerminalScreen>
const screens: Screen[] = []
const screen = (cols: number, rows: number): Screen => {
  const s = new TerminalScreen(cols, rows)
  screens.push(s)
  return s
}
/** Writes `data` and waits until the screen has taken it in: a screen that stopped never does. */
const parsed = (s: Screen, data: string) => new Promise<void>((r) => s.write(data, r))
/** A full redraw, as ConPTY sends after a resize: each row from the top, erased to its end. */
const redraw = (rows: string[]) => '\x1b[H' + rows.map((r) => `${r}\x1b[K`).join('\r\n')

afterEach(() => {
  for (const s of screens.splice(0)) s.dispose()
  warnings.length = 0
})

describe("a session's headless screen (#1572)", () => {
  it('takes a redraw after narrowing and shortening at once, then widening back (the attention suite: 69×37, 27×36, 69×37)', async () => {
    const s = screen(69, 37)
    // Two fake Codex agents' screens: prompt lines a little wider than the window (a path), the cursor low on it.
    await parsed(s, '› C:\\Users\\someone\\AppData\\Local\\hive-test\\e2e\\lanes\\2\\attention-ws.worktrees\\alpha\\copies\r\n'.repeat(6) + '\x1b[33;1H')
    s.resize(27, 36)
    s.resize(69, 37)
    // xterm 6.0 with no scrollback left 36 lines for 37 rows here, and this redraw's last line feed threw in its timer.
    const rows = Array.from({ length: 37 }, (_, i) => `row ${i + 1}`)
    await parsed(s, redraw(rows))
    expect(s.text().split('\n')).toEqual(rows)
    expect(warnings).toEqual([])
  })

  it('starts again, logged, when a resize leaves the shown screen with fewer lines than it has rows', async () => {
    const s = screen(69, 37)
    // On the alternate screen, which has no scrollback: xterm 6.0 leaves it 4 lines short at 26×38.
    s.resize(50, 10)
    await parsed(s, '\x1b[?2004h\x1b[?1049h\x1b[33;1H')
    await parsed(s, 'x\r\n')
    await parsed(s, '\x1b[J\x1b[5;1H')
    // A write not taken in yet when the screen starts again still says it was.
    let pendingParsed = false
    s.write('more', () => (pendingParsed = true))
    s.resize(26, 38)
    expect(warnings).toEqual([expect.stringContaining('26×38')])
    await vi.waitFor(() => expect(pendingParsed).toBe(true), { timeout: HUNG_MS })
    // It keeps what Hive reads besides the cells (bracketed paste), and takes what was going to throw.
    expect(s.bracketedPaste()).toBe(true)
    await parsed(s, '\x1b[K\x1b[41;1H')
    s.resize(114, 50)
    await parsed(s, '\n\x1b[49;1H')
    await parsed(s, '\n')
    const rows = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`)
    await parsed(s, redraw(rows))
    expect(s.text().split('\n')).toEqual(rows)
  })

  it('runs nothing after it is disposed, a write pending then included', async () => {
    const s = screen(40, 10)
    let called = false
    s.write('text', () => (called = true))
    s.dispose()
    await parsed(screen(40, 10), 'a later write on another screen, parsed after the first would have been')
    expect(called).toBe(false)
  })
})
