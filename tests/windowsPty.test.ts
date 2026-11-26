// HI-3589: Windows 10's ConPTY ends a line wrapped at the last column with CR LF, and xterm, told only `backend:
// 'conpty'`, took it as two lines: a long line selected and copied in a pane came with a line break in the middle. xterm's
// own core (headless, the same CoreTerminal and Buffer as the window's) with the option windowsPtyOption gives.
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { CONPTY_REFLOW_BUILD, windowsPtyOption } from '../src/shared/windowsPty'

const WIN10 = '10.0.19045'
const WIN11 = '10.0.26200'

const term = (version: string, cols = 8): Terminal => new Terminal({ cols, rows: 4, allowProposedApi: true, windowsPty: windowsPtyOption('win32', version) })
const write = (t: Terminal, data: string): Promise<void> => new Promise((r) => t.write(data, r))

describe("xterm's windowsPty for a pane (HI-3589)", () => {
  it('the build below 21376 (Windows 10), none from it (Windows 11) and elsewhere, or for a version it cannot read', () => {
    expect(windowsPtyOption('win32', WIN10)).toEqual({ backend: 'conpty', buildNumber: 19045 })
    expect(windowsPtyOption('win32', `10.0.${CONPTY_REFLOW_BUILD - 1}`)).toEqual({ backend: 'conpty', buildNumber: CONPTY_REFLOW_BUILD - 1 })
    for (const [platform, version] of [['win32', WIN11], ['win32', `10.0.${CONPTY_REFLOW_BUILD}`], ['win32', ''], ['win32', '10.0'], ['darwin', '14.5.0'], ['linux', '6.8.0']]) expect(windowsPtyOption(platform, version), `${platform} ${version}`).toEqual({ backend: 'conpty' })
  })

  it("Windows 10: a line ConPTY wrapped with CR LF at the last column is one line (its second row is wrapped), so it's copied whole", async () => {
    const t = term(WIN10)
    await write(t, 'abcdefgh\r\nijkl')
    expect(t.buffer.active.getLine(1)!.isWrapped).toBe(true)
    t.dispose()
  })

  it('Windows 11: as before, CR LF ends the line, and a line wrapped by the terminal re-wraps when it widens (#896)', async () => {
    const t = term(WIN11)
    await write(t, 'abcdefgh\r\nijkl')
    expect(t.buffer.active.getLine(1)!.isWrapped).toBe(false)
    const r = term(WIN11)
    // Ended, so the cursor's line is the next one: xterm doesn't reflow the line the cursor is on (reflowCursorLine).
    await write(r, 'abcdefghij\r\n')
    expect(r.buffer.active.getLine(1)!.isWrapped).toBe(true)
    r.resize(12, 4)
    expect(r.buffer.active.getLine(0)!.translateToString(true)).toBe('abcdefghij')
    t.dispose()
    r.dispose()
  })
})
