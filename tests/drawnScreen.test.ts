import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

// HI-3210: sendPrompt (tests/e2e/lib.cjs) reads a CLI's screen as drawn and presses Enter once the prompt shows there.
const { renderScreen, drawnCount } = createRequire(import.meta.url)('./e2e/drawnScreen.cjs') as {
  renderScreen: (raw: string, cols?: number, rows?: number) => Promise<string>
  drawnCount: (screen: string, text: string) => number
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
})
