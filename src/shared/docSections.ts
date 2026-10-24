// Markdown documents by section (#817): a document's headings with their sizes, and one section's text, so an agent reads
// the part of a long plan or note it needs. Node built-ins only (hive-mcp.js and the Agent API share it).
//
// Headings are ATX headings (`#` to `######` at the start of a line, up to three spaces in), outside fenced code (``` or
// ~~~) and outside front matter (a `---` block at the very top). A section runs from its heading to the next heading of
// the same or a higher level, so it includes its subsections.
//
// Slugs follow GitHub's rule, one rule for the outline and for references to sections (#818): the heading's text as
// shown (links as their words, code and emphasis marks dropped), lower case, every character that isn't a letter, a
// digit, a space, a hyphen or an underscore removed, each space a hyphen. A slug used before gets -1, -2… in order.
//
// A heading can carry an explicit id (#1535), an empty anchor anywhere on its line: `## Version Control <a id="git"></a>`.
// Its slug is then that id, whatever its text, so links to it survive a rename. An HTML anchor rather than `{#git}`:
// GitHub hides it and still scrolls to `#git`, where `{#git}` would show as text in the guide on GitHub.

/** One heading of a document. */
export interface DocHeading {
  /** 1 for `#`, up to 6. */
  level: number
  /** Its text as shown. */
  text: string
  /** Its slug, unique in the document: its explicit id when it has one. */
  slug: string
  /** Its slug is an explicit id (`<a id="…"></a>`), kept when its text changes. */
  fixed?: true
  /** The explicit id it carries that another heading carries too: no reference names it for sure. */
  sharedId?: string
  /** Its line, from 1. */
  line: number
  /** Its section's size in characters (the heading line and everything to the next heading of its level or higher). */
  size: number
}

/** A heading's text as shown: links as their words, images, code and emphasis marks and closing hashes dropped. */
export function headingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A heading text's slug before duplicates are numbered (GitHub's rule). */
export function slugOf(text: string): string {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

const EXPLICIT_ID = /<a\s+id="([^"\s<>]+)"\s*>\s*<\/a>/i

/** A heading's explicit id (`<a id="git"></a>` on its line), or null. */
export function headingId(raw: string): string | null {
  return EXPLICIT_ID.exec(raw)?.[1] ?? null
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The document's lines (LF, CRLF or CR), each without its ending. */
const linesOf = (md: string): string[] => md.split(/\r\n|\r|\n/)

/** Where each heading is: its line index, level and raw text. */
function headingLines(lines: string[]): { at: number; level: number; raw: string }[] {
  const out: { at: number; level: number; raw: string }[] = []
  let i = 0
  // Front matter: a `---` line first, to the next `---` or `...` line (none: not front matter).
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && (l.trim() === '---' || l.trim() === '...'))
    if (end > 0) i = end + 1
  }
  let fence: { char: string; len: number } | null = null
  for (; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (fence) {
      // Closed by a fence of the same character, at least as long, with nothing after it.
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && !line.slice(line.indexOf(f[1]) + f[1].length).trim()) fence = null
      continue
    }
    if (f) {
      // A ``` fence's info string can't hold a backtick.
      if (f[1][0] === '`' && line.slice(line.indexOf(f[1]) + f[1].length).includes('`')) continue
      fence = { char: f[1][0], len: f[1].length }
      continue
    }
    const h = ATX.exec(line)
    if (h) out.push({ at: i, level: h[1].length, raw: (h[2] ?? '').trim() })
  }
  return out
}

/** The document's headings in order, each with its unique slug and its section's size. */
export function docOutline(md: string): DocHeading[] {
  const lines = linesOf(md)
  // Each line's length with its ending (one character: sizes count the text, not CRLF twice).
  const lineSize = lines.map((l, k) => l.length + (k < lines.length - 1 ? 1 : 0))
  const found = headingLines(lines)
  // Explicit ids are taken first: a heading without one never gets another's id as its slug. An id two headings carry
  // fixes neither: the first keeps it as its slug, the others are numbered from it, and each is marked `sharedId`.
  const ids = found.map((h) => headingId(h.raw))
  const count = new Map<string, number>()
  for (const id of ids) if (id) count.set(id, (count.get(id) ?? 0) + 1)
  const used = new Map<string, number>([...count.keys()].map((id) => [id, 0]))
  const firstTaken = new Set<string>()
  return found.map((h, k) => {
    const text = headingText(h.raw)
    const id = ids[k]
    const shared = id && count.get(id)! > 1 ? id : null
    // As github-slugger numbers them: a slug used before gets the next number of its own, skipping any taken.
    const base = shared ?? slugOf(h.raw)
    let slug = base
    if (id && !shared) slug = id
    else if (shared && !firstTaken.has(shared)) firstTaken.add(shared)
    else {
      while (used.has(slug)) {
        const n = (used.get(base) ?? 0) + 1
        used.set(base, n)
        slug = `${base}-${n}`
      }
      used.set(slug, 0)
    }
    const next = found.slice(k + 1).find((x) => x.level <= h.level)
    const end = next ? next.at : lines.length
    let size = 0
    for (let l = h.at; l < end; l++) size += lineSize[l]
    return { level: h.level, text, slug, ...(id && !shared ? { fixed: true as const } : {}), ...(shared ? { sharedId: shared } : {}), line: h.at + 1, size }
  })
}

/** The text of the section a heading starts (from `docOutline`), with its subsections. */
export function sectionText(md: string, heading: DocHeading): string {
  const lines = linesOf(md)
  const outline = docOutline(md)
  // By its line: the heading itself, whatever slugs the others have.
  const k = outline.findIndex((h) => h.line === heading.line)
  const next = outline.slice(k + 1).find((x) => x.level <= heading.level)
  return lines.slice(heading.line - 1, next ? next.line - 1 : lines.length).join('\n').replace(/\n+$/, '')
}

/** What a heading asked for finds: the section, several headings it could mean, or none (with the closest). */
export type SectionMatch = { heading: DocHeading } | { ambiguous: DocHeading[] } | { closest: DocHeading[] }

/** How many closest headings an unknown one lists. */
const CLOSEST = 5

/** Edit distance between two short strings (for the closest headings). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/**
 * The heading `asked` names, in this order:
 * - `#<slug>` (no space after `#`): exactly the section with that slug, also the first of several with the same text
 *   (`#setup`; `#setup-1` is the second), as a reference to a section (`file#slug`) names it; an explicit id several
 *   headings carry is ambiguous, listing them;
 * - a heading's text (any case, with or without its `#` marks and a space): that heading; several with that text are
 *   ambiguous, listed each with its own slug;
 * - a slug (`core-contracts`, `setup-1`): that heading; an explicit id several headings carry is ambiguous, as with `#`.
 * None: the closest headings.
 */
export function findHeading(outline: DocHeading[], asked: string): SectionMatch {
  const q = asked.trim()
  if (/^#[^#\s]/.test(q)) return bySlug(outline, q.slice(1)) ?? { closest: closest(outline, q.slice(1)) }
  const text = q.replace(/^#+\s+/, '')
  const plain = (t: string): string => headingText(t).toLowerCase()
  const byText = outline.filter((h) => plain(h.text) === plain(text))
  if (byText.length > 1) return { ambiguous: byText }
  if (byText.length === 1) return { heading: byText[0] }
  return bySlug(outline, text) ?? { closest: closest(outline, text) }
}

/** The heading a slug names (any case), or null; an explicit id several headings carry names none of them for sure (#1535). */
function bySlug(outline: DocHeading[], slug: string): SectionMatch | null {
  const is = (s: string | undefined): boolean => s === slug || s === slug.toLowerCase()
  const sharing = outline.filter((h) => is(h.sharedId))
  if (sharing.length) return { ambiguous: sharing }
  const exact = outline.find((h) => is(h.slug))
  return exact ? { heading: exact } : null
}

/** The headings closest to one asked for that none is: containing it or contained in it first, then by edit distance. */
function closest(outline: DocHeading[], asked: string): DocHeading[] {
  const slug = slugOf(asked)
  const ranked = outline
    .map((h) => ({ h, d: h.slug.includes(slug) || (slug && slug.includes(h.slug)) ? 0 : distance(slug, h.slug) / Math.max(slug.length, h.slug.length, 1) }))
    .sort((a, b) => a.d - b.d)
  return ranked.slice(0, CLOSEST).map((r) => r.h)
}
