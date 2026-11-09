/** The window title a program sets in its terminal output (OSC 0 or 2, ended by BEL or ST). */
const TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** A title sequence longer than this isn't one: its start isn't kept waiting for an end. */
const MAX_TITLE = 1024

/**
 * The last title set in a piece of output, read after `carry` (the unfinished title sequence the previous piece
 * ended with); `carry` is then the unfinished one this piece ends with, if any. Null when it sets none.
 */
export function lastTitle(carry: string, data: string): { title: string | null; carry: string } {
  const text = carry + data
  let title: string | null = null
  let end = 0
  for (const m of text.matchAll(TITLE)) {
    title = m[1]
    end = m.index + m[0].length
  }
  // A piece can end anywhere in a title's sequence, even between its first ESC and "]".
  const open = text.lastIndexOf('\x1b]')
  let rest = open >= end ? text.slice(open) : ''
  if (!/^\x1b\](?:[02]?$|[02];)/.test(rest)) rest = text.endsWith('\x1b') ? '\x1b' : ''
  return { title, carry: rest.length <= MAX_TITLE ? rest : '' }
}

/** Any OSC sequence a program writes (ESC ] payload, ended by BEL or ST): its payload. */
const OSC = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** A turn's state as a CLI writes it to its terminal (HI-2802): working, or not (over, or none begun yet). */
export type TerminalTurn = 'working' | 'done' | 'idle'

/**
 * The last turn state a piece of output says, read after `carry` (as lastTitle): each OSC payload is tried against
 * `pattern` (the adapter's terminalTurn, an advanced setting), whose first group is the state: "working", "done", else
 * idle. Null when it says none.
 */
export function lastTerminalTurn(pattern: RegExp, carry: string, data: string): { turn: TerminalTurn | null; carry: string } {
  const text = carry + data
  let turn: TerminalTurn | null = null
  let end = 0
  for (const m of text.matchAll(OSC)) {
    end = m.index + m[0].length
    const said = pattern.exec(m[1])
    if (!said) continue
    const word = (said[1] ?? '').toLowerCase()
    turn = word === 'working' ? 'working' : word === 'done' ? 'done' : 'idle'
  }
  const open = text.lastIndexOf('\x1b]')
  let rest = open >= end ? text.slice(open) : ''
  if (!rest) rest = text.endsWith('\x1b') ? '\x1b' : ''
  return { turn, carry: rest.length <= MAX_TITLE ? rest : '' }
}
