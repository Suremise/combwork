/**
 * Whether what a terminal sent to its program is the user typing, not xterm answering the program: focus in/out,
 * cursor and device reports (CSI), colour queries (OSC 10/11, which Codex sends at start, ended by BEL or ST) and
 * DCS/APC/PM/SOS replies such as xterm's version.
 */
const REPLIES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)|\x1bO?./g

/** What the user typed, without xterm's replies ('' when it was only replies). */
export function typedText(data: string): string {
  return data.replace(REPLIES, '')
}

export function isTyping(data: string): boolean {
  return typedText(data) !== ''
}

/**
 * What Ctrl+C or Ctrl+V does in an agent's terminal (#1286): Hive's copy (Ctrl+C with a selection) or paste, or the
 * CLI's ('cli': xterm sends it on, Ctrl+C as ^C and Ctrl+V as ^V), which Settings → Advanced can give both keys to.
 * null for any other key, and for Ctrl+C with nothing selected, which goes on as other keys do (to the CLI, unless it
 * is one of Hive's shortcuts).
 */
export function copyPasteKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, toCli: boolean, hasSelection: boolean): 'copy' | 'paste' | 'cli' | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k !== 'c' && k !== 'v') return null
  if (toCli) return 'cli'
  if (k === 'v') return 'paste'
  return hasSelection ? 'copy' : null
}

/**
 * Whether a key pressed in an agent's pane (`key`, as shortcuts write it: "Ctrl+Shift+P") is one of Hive's shortcuts
 * rather than the CLI's: one bound in Hive (`bound`) that the CLI doesn't use itself (`reserved`). With every key going
 * to the CLI (#1292, Settings → Advanced: All keys go to the CLI), only the command palette's shortcut (`palette`)
 * stays Hive's, so every command is still in reach: a two-step one ("Ctrl+K Ctrl+P") by its first key, which starts
 * Hive's chord, then its second while that chord is pending (`pending`: its first key); any other key goes to the CLI.
 */
export function appTakesTerminalKey(key: string, o: { allKeysToCli: boolean; palette: string | null | undefined; reserved: ReadonlySet<string>; bound: readonly string[]; pending?: string | null }): boolean {
  const norm = key.toUpperCase()
  if (o.allKeysToCli) {
    const steps = o.palette ? o.palette.toUpperCase().split(' ') : []
    if (steps.length === 2) return o.pending ? o.pending.toUpperCase() === steps[0] && norm === steps[1] : norm === steps[0]
    return steps.length === 1 && norm === steps[0]
  }
  if (o.reserved.has(norm)) return false
  return o.bound.includes(norm)
}

/** A key a CLI's input box takes as a new line rather than a send (HI-1327), which Hive can press for a prompt's line break. */
export type TypedNewline = 'alt-enter' | 'ctrl-j'

/**
 * Each typed-newline key as Hive writes it into the CLI's terminal, its one source: Alt+Enter as ESC CR, which Windows'
 * console delivers as one key (Enter with Alt); Ctrl+J in its console's win32-input-mode (J with Ctrl, pressed then
 * released), since a bare line feed arrives as Ctrl+Enter, which Codex doesn't take (HI-1327's probe). Fixed keys Hive
 * presses, never text from a prompt.
 */
export const TYPED_NEWLINE_KEYS: Readonly<Record<TypedNewline, string>> = {
  'alt-enter': '\x1b\r',
  'ctrl-j': '\x1b[74;36;10;1;8;1_\x1b[74;36;10;0;8;1_'
}
