/**
 * Card references in a terminal line ("#383 is back On Hold", "(#12)", "#12,", "HI-12 passed"), which the terminal links
 * to their cards (#440; keys #1221). Only references that are cards on the workspace's board are links (the caller
 * decides): a GitHub issue, a stray "#5" or a "UTF-8" in output isn't underlined.
 */

export interface CardMatch {
  /** Where `#n` or `AM-12` starts and ends in the line (end exclusive). */
  start: number
  end: number
  number: number
}

/**
 * `#n`, not inside a longer word (`abc#12`), path (`a/#12`) or HTML entity (`&#12;`), and not hex (`#fff`, `#12ab`,
 * a commit) or a version (`#12.5`). Up to seven digits, no leading zero.
 */
const CARD_RE = /(?<![\p{L}\p{N}_&#/\\.])#([1-9]\d{0,6})(?![\p{L}\p{N}_]|[.-][\p{L}\p{N}_])/gu
/**
 * A card's key, `AM-12` (#1221): 2–4 capital letters, a hyphen and a number with no leading zero, not inside a longer
 * word, path or version (`XAM-12`, `a/AM-12`, `AM-12.5`). Capitals only, as Combwork writes keys: `re-1` in output isn't one.
 */
const KEY_RE = /(?<![\p{L}\p{N}_/\\.-])([A-Z]{2,4})-([1-9]\d{0,8})(?![\p{L}\p{N}_]|[.-][\p{L}\p{N}_])/gu
/** A URL, whose fragment (`https://x/y#12`) is the web link's. */
const URL_RE = /\b(?:[a-z][\w+.-]*:\/\/|www\.)\S+/gi

/**
 * The card references in a line, in order: the numbers `isCard` accepts, and the keys `keyCard` finds a card for (its
 * number, or null).
 */
export function findCardRefs(text: string, isCard: (n: number) => boolean, keyCard: (key: string) => number | null = () => null): CardMatch[] {
  if (!text.includes('#') && !text.includes('-')) return []
  const urls = [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length])
  const inUrl = (start: number): boolean => urls.some(([a, b]) => start >= a && start < b)
  const out: CardMatch[] = []
  for (const m of text.matchAll(CARD_RE)) {
    const start = m.index
    if (inUrl(start)) continue
    const number = Number(m[1])
    if (isCard(number)) out.push({ start, end: start + m[0].length, number })
  }
  for (const m of text.matchAll(KEY_RE)) {
    const start = m.index
    if (inUrl(start)) continue
    const number = keyCard(m[0])
    if (number !== null) out.push({ start, end: start + m[0].length, number })
  }
  return out.sort((a, b) => a.start - b.start)
}
