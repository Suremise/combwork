/**
 * The move of Hive's `.hive` folders to `.combwork` (HI-2462, SPEC §4.3): what is shared between main and the tests, with
 * no file system here. A move is one host's folder: `<host>\.hive` → `<host>\.combwork`, recorded only when Combwork
 * really moved it (combworkMove.ts keeps the map in the workspace's `combwork-moved.json`). Paths stored by absolute path
 * into a moved folder are translated through that map and nothing else: a `.hive` Combwork didn't move (another tool's,
 * one left beside a `.combwork`, a linked one) is never anyone's `.combwork`.
 */

/** The folder's old name: only the move reads or names it. */
export const LEGACY_HIVE_DIR = '.hive'

/** One folder that moved: its old absolute path (`<host>\.hive`, or the Assistant's `<ws>\.hive\assistant\.hive`) and its new one. */
export interface FolderMove {
  from: string
  to: string
}

/** A path's spellings that may appear in text: Windows separators either way. */
const sepRx = String.raw`[\\/]`

const escapeRx = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A prefix's pattern: each separator either way, case-insensitively. */
const rawPattern = (p: string): string =>
  p
    .split(/[\\/]+/)
    .filter((x, i) => x || i === 0)
    .map(escapeRx)
    .join(sepRx)

/** The same prefix as encodeURI writes it in a file link (`file:///D:/my%20ws/.hive`): forward slashes only. */
const encodedPattern = (p: string): string => {
  const fwd = p.replace(/\\/g, '/')
  return escapeRx(encodeURI(fwd))
}

/** Characters that may sit right before a path in text: none of a path's own. */
const BEFORE = String.raw`(?<![\w.~$@+#%{}\-\\:])`
/** What may follow a whole folder's path: a separator, the end, or a character that can't be part of a name. */
const AFTER = String.raw`(?=[\\/]|$|[\s"'\`)>\]|,;#?])`

/** A file link's own form of a path: `file:` and slashes, which lead into the encoded spelling. */
const FILE_URL = String.raw`file:/{2,3}`

/**
 * The moves in the order they must be applied: the longest first, so the Assistant's inner folder
 * (`<ws>\.hive\assistant\.hive`) is matched before the workspace's (`<ws>\.hive`) that holds it.
 */
export const movesInOrder = (moves: readonly FolderMove[]): FolderMove[] => [...moves].sort((a, b) => b.from.length - a.from.length)

interface Matcher {
  rx: RegExp
  to: (sep: string, encoded: boolean) => string
}

function matchers(moves: readonly FolderMove[]): Matcher[] {
  const out: Matcher[] = []
  for (const m of movesInOrder(moves)) {
    const raw = rawPattern(m.from)
    const enc = encodedPattern(m.from)
    out.push({
      // Bare, or after `file:///` (whose slashes come before the drive).
      rx: new RegExp(`(?:${BEFORE}|(?<=${FILE_URL}))(${raw})${AFTER}`, 'gi'),
      to: (sep) => m.to.replace(/[\\/]/g, sep)
    })
    // A file link's encoded spelling, only after `file://`: anywhere else %xx isn't a path.
    if (enc !== escapeRx(m.from.replace(/\\/g, '/'))) out.push({ rx: new RegExp(`(?<=${FILE_URL})(${enc})${AFTER}`, 'gi'), to: () => encodeURI(m.to.replace(/\\/g, '/')) })
  }
  return out
}

/** The separator a matched spelling used (its first), so the new path is written the same way. */
const sepOf = (s: string): string => (/\//.test(s) && !/\\/.test(s) ? '/' : '\\')

/**
 * Text with every whole reference into a moved folder translated (a card's description or comment, a note): only paths
 * that start with a move's old folder, as a whole name (`proj2\.hive` and `x\.hive.bak` aren't `proj\.hive`), case
 * insensitively, with either separator, bare or in a file link (`file:///…`, encoded as encodeURI writes it). The
 * same text when nothing matched.
 */
export function rewriteMovedPaths(text: string, moves: readonly FolderMove[]): string {
  if (!moves.length || !/\.hive/i.test(text)) return text
  // One pass over the text, matches never overlapping: the longest move first at each place.
  const ms = matchers(moves)
  const hits: { start: number; end: number; repl: string }[] = []
  for (const m of ms) {
    m.rx.lastIndex = 0
    for (let r = m.rx.exec(text); r; r = m.rx.exec(text)) {
      const start = r.index + (r[0].length - r[1].length)
      const end = start + r[1].length
      if (hits.some((h) => start < h.end && end > h.start)) continue
      hits.push({ start, end, repl: m.to(sepOf(r[1]), false) })
    }
  }
  if (!hits.length) return text
  hits.sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const h of hits) {
    out += text.slice(at, h.start) + h.repl
    at = h.end
  }
  return out + text.slice(at)
}

/**
 * Where a path into a moved folder is now (null: not into one): for a file opened by an old link, a session's folder
 * looked up by where it ran, a record's path. Only a whole path that starts with a move's old folder.
 */
export function movedPathOf(p: string, moves: readonly FolderMove[]): string | null {
  for (const m of movesInOrder(moves)) {
    const rx = new RegExp(`^${rawPattern(m.from)}(?=[\\\\/]|$)`, 'i')
    const hit = rx.exec(p)
    if (hit) return m.to + p.slice(hit[0].length).replace(/\//g, '\\')
  }
  return null
}

/** A card's context reference into the workspace's old shared folder (`.hive/shared/x.md#h`) as it reads now (`shared:x.md#h`), else as it was. */
export function movedContextRef(ref: string): string {
  const m = /^\.hive[\\/]shared[\\/](.+)$/i.exec(ref.trim())
  return m ? `shared:${m[1].replace(/\\/g, '/')}` : ref
}

/**
 * An info/exclude file's text with Hive's own line for a moved project's old folder replaced by the new one's (`/proj/.hive/`
 * → `/proj/.combwork/`, or the bare `.hive/` form for a repository's own), only where it follows Hive's comment line,
 * and only when `oldGone` (no `.hive` is left there: another tool's, or one made again, keeps its line). A line for the
 * new folder that is already there isn't added twice. Every other line stays as it was.
 */
export function movedExcludeText(text: string, oldLine: string, newLine: string, oldGone: boolean): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const hasNew = lines.some((l) => l.trim() === newLine)
  const bare = oldLine === '/.hive/' ? '.hive/' : null
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const isOld = l.trim() === oldLine || (bare !== null && l.trim() === bare)
    const ours = isOld && i > 0 && /added by (Hive|Combwork)/i.test(lines[i - 1])
    if (ours && oldGone) {
      if (!hasNew && !out.includes(newLine)) out.push(newLine)
      continue
    }
    out.push(l)
  }
  return out.join(nl)
}
