// Conflict help on a card the merge queue returned (HI-1181; design HI-1181/s8 and s10, checked by HR4): the conflicting
// files' hunks, as the queue's test merge (or strict's update) left them in its own folder before it aborted. Read there
// by main/workflow/conflictRead.ts, bounded and confined; parsed here, pure. Kept on IntegrationFailed (`conflicts`) and
// shown read-only in the card's Work section, with a short form in the builder's wake.

/** Why a conflicted file's text wasn't read (metadata only): never a guess that it has no conflict. */
export type ConflictNotRead = 'link' | 'outside' | 'missing' | 'binary' | 'notText' | 'budget' | 'error'

/** What stopped a file's hunks short: the file read only in part, or the hunks or room recorded. */
export type ConflictPartial = 'size' | 'hunks' | 'room'

/**
 * One conflict region with up to CONTEXT lines either side. Its sides as git wrote them, the first (`ours`, between
 * `<<<<<<<` and `=======`, or a diff3 base's `|||||||`), the base, the second (`theirs`); which is the target is
 * ConflictsRecord's `oursIs`. Lines left out of a side are counted in `cut`, never put in the text.
 */
export interface ConflictHunk {
  /** Its `<<<<<<<` line, from 1. */
  line: number
  before: string[]
  ours: string[]
  base?: string[]
  theirs: string[]
  after: string[]
  cut?: { ours?: number; base?: number; theirs?: number }
  /** Lines longer than CONFLICT_LIMITS.lineChars kept only to that length: how many (a minified file's one line). */
  clipped?: number
}

export interface ConflictFile {
  /** As git named it, relative to the repository. */
  file: string
  notRead?: ConflictNotRead
  partial?: ConflictPartial
  hunks: ConflictHunk[]
  /** Regions found and not kept: an exact count, only when the file was read and scanned whole. */
  more?: number
}

export interface ConflictsRecord {
  /** Which side git wrote first: the target's (a test merge, a rebase) or the card's (strict's merge of the target in). */
  oursIs: 'target' | 'card'
  files: ConflictFile[]
  /** Conflicted files git listed past the files read. */
  filesLeft?: number
}

/** The record's bounds (design s10). */
export const CONFLICT_LIMITS = { files: 20, fileBytes: 256 * 1024, totalBytes: 1024 * 1024, hunks: 8, sideLines: 40, context: 2, chars: 16_000, lineChars: 400 }

/** Room left for hunks' text across a record's files (chars), spent as they are kept. */
export interface ConflictRoom {
  chars: number
}

interface Region {
  start: number
  base: number | null
  sep: number
  end: number
}

/**
 * The conflict regions in a text: a `<<<<<<<` of 7 or more, then its diff3 base (`|||||||`), `=======` and `>>>>>>>` of
 * the same length. One with no end isn't a region; a stray `=======` outside a region is a line.
 */
function regionsOf(lines: readonly string[]): Region[] {
  const regions: Region[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^(<{7,})(?: |$)/.exec(lines[i])
    if (!open) continue
    const n = open[1].length
    const base = new RegExp(`^\\|{${n}}(?: |$)`)
    const sep = new RegExp(`^={${n}}$`)
    const close = new RegExp(`^>{${n}}(?: |$)`)
    const reopen = new RegExp(`^<{${n}}(?: |$)`)
    let b: number | null = null
    let s: number | null = null
    let e: number | null = null
    for (let j = i + 1; j < lines.length; j++) {
      // Another opening before this one closed: this one was a stray line, the next may be a region.
      if (reopen.test(lines[j])) break
      if (s === null && b === null && base.test(lines[j])) b = j
      else if (s === null && sep.test(lines[j])) s = j
      else if (s !== null && close.test(lines[j])) {
        e = j
        break
      }
    }
    // Never closed: a line like any other (a text cut short ends here; a stray marker in a whole one is text).
    if (s === null || e === null) continue
    regions.push({ start: i, base: b, sep: s, end: e })
    i = e
  }
  return regions
}

/** A side's lines, kept up to `max`, how many were left out. */
function side(lines: readonly string[], from: number, to: number, max: number): { kept: string[]; cut: number } {
  const all = lines.slice(from, to)
  return { kept: all.slice(0, max), cut: Math.max(0, all.length - max) }
}

const charsOf = (h: ConflictHunk): number => [h.before, h.ours, h.base ?? [], h.theirs, h.after].reduce((n, ls) => n + ls.reduce((m, l) => m + l.length + 1, 0), 0)

/**
 * A conflicted file's hunks from its text (`whole`: the text is the whole file; false, it was cut at the read's budget,
 * so the file may have more). Each hunk's context is only lines between it and its neighbours, never shared. Stops at
 * CONFLICT_LIMITS' hunks or at `room`, saying which; an exact count of the rest only when the text was whole.
 */
export function parseConflicts(file: string, text: string, whole: boolean, room: ConflictRoom): ConflictFile {
  const lines = text.split(/\r?\n/)
  // A text cut short ends mid-line: that line isn't scanned. A whole one's last newline ends its last line, no more.
  if (!whole || lines.at(-1) === '') lines.pop()
  const regions = regionsOf(lines)
  const L = CONFLICT_LIMITS
  const hunks: ConflictHunk[] = []
  let stopped: ConflictPartial | null = null
  let prevEnd = -1
  for (let k = 0; k < regions.length; k++) {
    if (hunks.length >= L.hunks) {
      stopped = 'hunks'
      break
    }
    const r = regions[k]
    const next = regions[k + 1]?.start ?? lines.length
    const ours = side(lines, r.start + 1, r.base ?? r.sep, L.sideLines)
    const base = r.base !== null ? side(lines, r.base + 1, r.sep, L.sideLines) : null
    const theirs = side(lines, r.sep + 1, r.end, L.sideLines)
    const afterEnd = Math.min(r.end + 1 + L.context, next)
    const h: ConflictHunk = {
      line: r.start + 1,
      before: lines.slice(Math.max(prevEnd + 1, r.start - L.context), r.start),
      ours: ours.kept,
      ...(base ? { base: base.kept } : {}),
      theirs: theirs.kept,
      after: lines.slice(r.end + 1, afterEnd)
    }
    const cut = { ...(ours.cut ? { ours: ours.cut } : {}), ...(base?.cut ? { base: base.cut } : {}), ...(theirs.cut ? { theirs: theirs.cut } : {}) }
    if (Object.keys(cut).length) h.cut = cut
    // A line past lineChars kept to it, counted (a minified line would take the whole room as context).
    let clipped = 0
    const short = (ls: string[]): string[] => ls.map((l) => (l.length > L.lineChars ? (clipped++, l.slice(0, L.lineChars)) : l))
    h.before = short(h.before)
    h.ours = short(h.ours)
    if (h.base) h.base = short(h.base)
    h.theirs = short(h.theirs)
    h.after = short(h.after)
    if (clipped) h.clipped = clipped
    const size = charsOf(h)
    if (size > room.chars) {
      stopped = 'room'
      break
    }
    room.chars -= size
    hunks.push(h)
    prevEnd = afterEnd - 1
  }
  // Not whole: the rest of the file wasn't scanned, so how many more there are isn't known.
  const partial: ConflictPartial | null = !whole ? 'size' : stopped
  const more = whole && stopped ? regions.length - hunks.length : 0
  return { file, hunks, ...(partial ? { partial } : {}), ...(more ? { more } : {}) }
}

/** Where a file's conflicts are, for agents (the wake's short form): "2 conflicts, lines 10 and 40", or why it wasn't read. */
export function conflictPlaces(f: ConflictFile): string {
  if (f.notRead) return `not read: ${f.notRead}` // i18n-ignore: agent-facing (the builder's wake)
  const at = f.hunks.map((h) => h.line)
  const known = f.hunks.length + (f.more ?? 0)
  const lines = at.length ? `, line${at.length === 1 ? '' : 's'} ${at.length > 2 ? `${at.slice(0, -1).join(', ')} and ${at.at(-1)}` : at.join(' and ')}` : '' // i18n-ignore: agent-facing
  if (f.partial === 'size') return `${f.hunks.length ? `${f.hunks.length}+ conflicts` : 'conflicts not found in the part read'}${lines} (read in part)` // i18n-ignore: agent-facing
  if (!known) return 'no text conflict' // i18n-ignore: agent-facing
  return `${known} conflict${known === 1 ? '' : 's'}${lines}${f.more ? ` (and ${f.more} more)` : ''}` // i18n-ignore: agent-facing
}
