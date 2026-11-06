/**
 * OSC 52 (#736): a terminal program asking the terminal to set (`ESC ] 52 ; c ; <base64> BEL`) or read (`… ; ? BEL`)
 * the clipboard. Copilot's own mouse selection copies this way (Ctrl+C or right-click on it), and Claude Code sends one
 * alongside its native copy. Combwork takes writes from a terminal the user is using and never answers a read: a program
 * must not read the user's clipboard.
 */

/** The most text a program may put on the clipboard in one write. */
export const OSC52_MAX_BYTES = 1024 * 1024
/**
 * How recently the user must have pressed a key or a mouse button in the terminal for its program to write the
 * clipboard: the copy is the program's answer to that key (Copilot's Ctrl+C), not something it does unasked. Generous,
 * for a loaded machine.
 */
export const OSC52_INPUT_MS = 10_000

export type Osc52Refusal = 'read' | 'not-in-use' | 'too-large' | 'invalid' | 'blocked' | 'declined'

/** What Combwork does with a write it would take (#1292, Settings → Advanced): take it, ask the user first, or take none. */
export type Osc52Policy = 'allow' | 'ask' | 'block'

/** A write osc52() takes, by the policy: written, asked about first, or refused ('blocked'). Reads and the rest are refused either way. */
export function osc52Decision(r: Osc52, policy: Osc52Policy | string | undefined): { write: string } | { ask: string } | { refuse: Osc52Refusal } {
  if (r.kind === 'refused') return { refuse: r.reason }
  if (policy === 'block') return { refuse: 'blocked' }
  if (policy === 'ask') return { ask: r.text }
  return { write: r.text }
}
export type Osc52 = { kind: 'write'; text: string } | { kind: 'refused'; reason: Osc52Refusal }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * What to do with an OSC 52 sequence's data (`<selections>;<base64 or ?>`, as xterm.js hands it to its handler).
 * `inUse`: the terminal has the focus and had the user's key or mouse input in the last OSC52_INPUT_MS. Every selection
 * (c, p, s, 0-7) is Windows' one clipboard. An empty or malformed payload changes nothing (the protocol's "clear").
 */
export function osc52(data: string, inUse: boolean): Osc52 {
  const sep = data.indexOf(';')
  const payload = sep < 0 ? '' : data.slice(sep + 1)
  if (payload === '?') return { kind: 'refused', reason: 'read' }
  if (!inUse) return { kind: 'refused', reason: 'not-in-use' }
  if (payload.length > Math.ceil(OSC52_MAX_BYTES / 3) * 4) return { kind: 'refused', reason: 'too-large' }
  if (sep < 0 || !payload || !BASE64.test(payload)) return { kind: 'refused', reason: 'invalid' }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
  } catch {
    return { kind: 'refused', reason: 'invalid' }
  }
  if (bytes.length > OSC52_MAX_BYTES) return { kind: 'refused', reason: 'too-large' }
  return { kind: 'write', text: new TextDecoder().decode(bytes) }
}

/** The most of a clipboard write the question shows (#1292, Ask each time): the rest is counted, not shown. */
export const OSC52_PREVIEW = 500
/** The most lines of it the question shows. */
export const OSC52_PREVIEW_LINES = 6

/** What the question shows of a clipboard write: its first lines, at most OSC52_PREVIEW characters, and how many it leaves out. */
export function clipboardPreview(text: string): { lines: string[]; more: number } {
  const out: string[] = []
  let shown = 0
  // How far into the text the preview reaches: each line shown and the line break before it (\n or \r\n).
  let reached = 0
  const re = /\r?\n/g
  let start = 0
  while (out.length < OSC52_PREVIEW_LINES && shown < OSC52_PREVIEW) {
    const m = re.exec(text)
    const end = m ? m.index : text.length
    const part = text.slice(start, end).slice(0, OSC52_PREVIEW - shown)
    out.push(part)
    shown += part.length
    reached = start + part.length
    if (!m) break
    start = m.index + m[0].length
  }
  // Every character not shown, line breaks included.
  return { lines: out, more: text.length - reached }
}
