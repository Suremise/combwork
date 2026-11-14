// A terminal's screen as drawn, for sendPrompt (lib.cjs): what Combwork itself reads (src/main/terminalScreen.ts), not
// the raw output. A CLI that redraws only the cells that changed (Codex 0.169) leaves letters out of the raw output's
// plain text ("Your card wa ch has ended"), though its input holds the whole prompt (HI-3210).
const { Terminal } = require('@xterm/headless')

/** The visible lines of `raw` (a pty's output, pty:buffer) drawn at cols × rows, top to bottom, without trailing blanks. */
async function renderScreen(raw, cols, rows) {
  const term = new Terminal({ cols: Math.max(2, Math.floor(cols) || 120), rows: Math.max(2, Math.floor(rows) || 30), scrollback: 1, allowProposedApi: true })
  try {
    await new Promise((resolve) => term.write(String(raw ?? ''), resolve))
    const buf = term.buffer.active
    const lines = []
    for (let i = 0; i < term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    return lines.join('\n')
  } finally {
    term.dispose()
  }
}

/** A CLI's mark for a paste it holds as one item rather than its text: Claude Code's "[Pasted text #1 +44 lines]", Codex's "[Pasted Content …]". */
const PASTE_MARK = /\[Pasted (?:text|Content)\b/g

/**
 * How often a screen shows a prompt's end (spaces left out, as a CLI wraps it), as Combwork's drawnLine counts it (#600),
 * plus the paste marks on it: a count that rises after the prompt is written says the CLI has drawn it.
 */
function drawnCount(screen, text) {
  const s = String(screen ?? '')
  const end = String(text ?? '').replace(/\s+/g, '').slice(-40)
  return (end ? s.replace(/\s+/g, '').split(end).length - 1 : 0) + (s.match(PASTE_MARK)?.length ?? 0)
}

/**
 * The screen from its last prompt mark (Codex's "› ", Claude Code's "❯ ", a plain "> ") to its end: the CLI's input as
 * it shows, without the conversation above it, where the same prompt sent before can still show (HR1's round 1 of
 * HI-3210). Empty with no mark.
 */
function inputOf(screen) {
  const s = String(screen ?? '')
  const at = Math.max(s.lastIndexOf('› '), s.lastIndexOf('❯ '), s.lastIndexOf('> '))
  return at >= 0 ? s.slice(at) : ''
}

module.exports = { renderScreen, drawnCount, inputOf }
