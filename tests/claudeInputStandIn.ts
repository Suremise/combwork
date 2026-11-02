// Claude Code 2.1.312's input box, for unit tests of what Hive types into it (HI-1979), written apart from Hive's code
// as the real CLI was tried: its input between two rules under a footer, wrapped at the box's width and at its line
// breaks; a Ctrl+U deletes the row the cursor is on (at a row begun by a line break, that break); a Backspace one
// character as the user sees it (a grapheme); a bracketed paste is text; Enter sends what is there.
//
// It is fed what Hive writes, by `feed`, or, for a test that records writes its own way, by `from(writes)`: its screen
// replays the writes not read yet each time it is read. Options:
// - `draft`: what is in the input to begin with;
// - `viewport`: the screen's rows (a box taller than that has its top rule off the screen);
// - `lagMs`: how long the screen keeps showing its last drawing after the input changes (a CLI whose redraw is late);
// - `shows`: what the screen shows until it first draws (a stale box), the input as it is otherwise;
// - `input.answers`: how many keys it reads before it stops reading (a busy CLI), raised to read again;
// - `ascii`: drawn as where the terminal doesn't say it shows Unicode (no TERM or WT_SESSION): ">" its prompt mark, and
//   the session's name in its top rule.

const RULE = '─'.repeat(60)
const NAMED_RULE = `${'─'.repeat(53)} demo ─`
const WIDTH = 58

const graphemes = (text: string): string[] => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((g) => g.segment)

/** The input box as Claude Code 2.1.312 draws it, holding `text`. */
export function claudeBox(text = '', ascii = false): string {
  return `${ascii ? NAMED_RULE : RULE}\n${ascii ? '>' : '❯'} ${text ? rows(text).join('\n  ') : ''}\n${RULE}\n  ? for shortcuts`
}

function rows(text: string): string[] {
  return text.split('\n').flatMap((part) => {
    const cps = [...part]
    if (!cps.length) return ['']
    const out: string[] = []
    for (let i = 0; i < cps.length; i += WIDTH) out.push(cps.slice(i, i + WIDTH).join(''))
    return out
  })
}

export interface ClaudeInput {
  input: { text: string; sent: string[]; keys: number; ctrlU: number; answers: number }
  /** What Hive wrote, as the CLI reads it. */
  feed(data: string): void
  /** Reads `writes` (its new entries) before each look at the screen. */
  from(writes: () => readonly string[]): void
  /** A session's `screen`, as SessionManager reads it. */
  screen: { text(): string; textWithoutDim(): string; bracketedPaste(): boolean }
}

export function claudeInput(opts: { draft?: string; viewport?: number; lagMs?: number; shows?: string; paste?: boolean; ascii?: boolean } = {}): ClaudeInput {
  const input = { text: opts.draft ?? '', sent: [] as string[], keys: 0, ctrlU: 0, answers: Infinity }
  let inPaste = false
  let source: (() => readonly string[]) | null = null
  let read = 0
  const draw = (): string => {
    const lines = claudeBox(input.text, opts.ascii).split('\n')
    return lines.slice(-(opts.viewport ?? 1000)).join('\n')
  }
  let shown = opts.shows ?? draw()
  let changedAt = opts.shows === undefined ? -Infinity : Date.now()
  const feed = (data: string): void => {
    for (const part of data.split(/(\x1b\[20[01]~)/)) {
      if (part === '\x1b[200~' || part === '\x1b[201~') inPaste = part === '\x1b[200~'
      else if (inPaste) input.text += part.replace(/\r/g, '\n')
      else
        for (const ch of part) {
          if (input.keys >= input.answers) return
          input.keys++
          if (ch === '\x15') {
            input.ctrlU++
            const last = rows(input.text).at(-1) ?? ''
            input.text = last ? [...input.text].slice(0, -[...last].length).join('') : input.text.slice(0, -1)
          } else if (ch === '\x7f') input.text = graphemes(input.text).slice(0, -1).join('')
          else if (ch === '\r') {
            input.sent.push(input.text)
            input.text = ''
          } else input.text += ch
        }
    }
    changedAt = Date.now()
  }
  const look = (): string => {
    if (source) {
      const all = source()
      for (; read < all.length; read++) feed(all[read])
    }
    if (Date.now() - changedAt >= (opts.lagMs ?? 0)) shown = draw()
    return shown
  }
  return {
    input,
    feed,
    from: (writes) => {
      source = writes
      read = writes().length
    },
    screen: { text: look, textWithoutDim: look, bracketedPaste: () => opts.paste ?? true }
  }
}
