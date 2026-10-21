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
 * stays Hive's, so every command is still in reach.
 */
export function appTakesTerminalKey(key: string, o: { allKeysToCli: boolean; palette: string | null | undefined; reserved: ReadonlySet<string>; bound: readonly string[] }): boolean {
  const norm = key.toUpperCase()
  if (o.allKeysToCli) return !!o.palette && norm === o.palette.toUpperCase()
  if (o.reserved.has(norm)) return false
  return o.bound.includes(norm)
}
