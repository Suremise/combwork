import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

// HI-3210: sendPrompt (tests/e2e/lib.cjs) reads a CLI's screen as drawn and presses Enter once the prompt shows there.
const { renderScreen, drawnCount, inputOf } = createRequire(import.meta.url)('./e2e/drawnScreen.cjs') as {
  renderScreen: (raw: string, cols?: number, rows?: number) => Promise<string>
  drawnCount: (screen: string, text: string) => number
  inputOf: (screen: string) => string
}

const PROMPT = 'Your card watch has ended: carry on (cw_read_task with latestComment for the comment in full).'
const plain = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ')

describe('drawnScreen', () => {
  it('reads a prompt that a CLI drew only the changed cells of, which the raw output lacks letters of', async () => {
    // A first frame with a near-identical line, then a redraw of only the cells that differ (as Codex's renderer does).
    const first = PROMPT.replace(/t/g, 'x')
    let diff = ''
    for (let i = 0; i < PROMPT.length; i++) if (PROMPT[i] !== first[i]) diff += `\x1b[3;${i + 3}H${PROMPT[i]}`
    const raw = `\x1b[2J\x1b[3;1H› ${first}${diff}`
    expect(plain(raw)).not.toContain('watch')
    const screen = await renderScreen(raw, 200, 10)
    expect(screen).toContain(`› ${PROMPT}`)
    expect(drawnCount(screen, PROMPT)).toBe(1)
  })

  it('counts the end of a wrapped prompt, spaces left out', async () => {
    const screen = await renderScreen(`› ${PROMPT}`, 30, 10)
    expect(screen.split('\n').length).toBeGreaterThan(2)
    expect(drawnCount(screen, PROMPT)).toBe(1)
    expect(drawnCount(await renderScreen('› ', 30, 10), PROMPT)).toBe(0)
  })

  it("counts a paste a CLI holds as one item (Claude Code's and Codex's marks)", () => {
    expect(drawnCount('❯ [Pasted text #1 +44 lines]', PROMPT)).toBe(1)
    expect(drawnCount('› [Pasted Content 1200 chars]', PROMPT)).toBe(1)
    expect(drawnCount('› ', PROMPT)).toBe(0)
  })

  it('reads the input from its last prompt mark, not the conversation above it', () => {
    expect(inputOf(`› ${PROMPT}\nanswer\n› `)).toBe('› ')
    expect(inputOf(`› ${PROMPT}\nanswer\n› ${PROMPT}`)).toBe(`› ${PROMPT}`)
    expect(inputOf('no mark')).toBe('')
  })
})

describe("lib.cjs's sendPrompt (HI-3210)", () => {
  type Inv = (channel: string, key: string, data?: string) => Promise<unknown>
  const { sendPrompt } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
    sendPrompt: (inv: Inv, key: string, text: string, opts: { submitted: () => Promise<boolean>; tries?: number; waitMs?: number }) => Promise<number>
  }

  /**
   * A CLI with bracketed paste on, drawn whole on each read: its conversation, then its input. Ctrl+U empties the input,
   * a paste is drawn into it, and Enter sends it, unless `dropEnters` are left (a busy Codex's dropped Enter). `reads`
   * counts the screen's reads between a Ctrl+U and the next paste: the wait for the clear.
   */
  const cli = (history: string, dropEnters = 0, { paste = true, draws = true } = {}) => {
    const s = { history, input: '', sent: [] as string[], dropEnters, reading: false, reads: [] as number[], written: false, readsBeforeEnter: 0 }
    const inv: Inv = async (channel, _key, data) => {
      if (channel === 'pty:size') return { cols: 200, rows: 20 }
      if (channel === 'pty:buffer') {
        if (s.reading) s.reads[s.reads.length - 1]++
        if (s.written) s.readsBeforeEnter++
        return `${paste ? '\x1b[?2004h' : ''}\x1b[2J\x1b[H${s.history.replace(/\n/g, '\r\n')}\r\n› ${draws ? s.input : ''}`
      }
      if (channel !== 'pty:write') return undefined
      if (data === '\x15') {
        s.input = ''
        s.reading = true
        s.reads.push(0)
      } else if (data === '\r') {
        s.written = false
        if (s.dropEnters > 0) s.dropEnters--
        else if (s.input) {
          s.sent.push(s.input)
          s.history += `\n› ${s.input}\nanswer`
          s.input = ''
        }
      } else {
        s.reading = false
        s.written = true
        s.input += String(data).replace(/\x1b\[20[01]~/g, '')
      }
      return undefined
    }
    return { s, inv }
  }

  it('pastes straight after Ctrl+U when the same prompt, sent before, still shows above an empty input (HR1, round 1)', async () => {
    const { s, inv } = cli(`› ${PROMPT}\nanswer`)
    const sentBefore = s.sent.length
    expect(await sendPrompt(inv, 'k', PROMPT, { submitted: async () => s.sent.length > sentBefore, waitMs: 5000 })).toBe(1)
    expect(s.sent).toEqual([PROMPT])
    // No wait for a clear, only the count before the paste: the history's copy can never go (the bug waited out its
    // 10 s bound here, about 40 reads).
    expect(s.reads).toEqual([1])
  }, 20000)

  it('a retry waits for its Ctrl+U to clear the text its last attempt left in the input, then pastes it again', async () => {
    const { s, inv } = cli('Codex', 1)
    expect(await sendPrompt(inv, 'k', PROMPT, { submitted: async () => s.sent.length > 0, waitMs: 1000 })).toBe(2)
    expect(s.sent).toEqual([PROMPT])
    // The input emptied at once: read once to see it cleared, then the count before the paste.
    expect(s.reads).toEqual([1, 2])
  }, 20000)

  it('a pasted prompt gets its Enter once it shows; a typed one into a CLI that draws nothing typed (the fake Codex) gets it with no wait', async () => {
    const pasted = cli('Codex')
    expect(await sendPrompt(pasted.inv, 'k', PROMPT, { submitted: async () => pasted.s.sent.length > 0 })).toBe(1)
    const typed = cli('Codex', 0, { paste: false, draws: false })
    expect(await sendPrompt(typed.inv, 'k', PROMPT, { submitted: async () => typed.s.sent.length > 0 })).toBe(1)
    expect(typed.s.sent).toEqual([PROMPT])
    // One look at the screen after the pause (the old wait read it about 40 times over its 10 s bound here).
    expect(typed.s.readsBeforeEnter).toBe(1)
  }, 20000)
})
