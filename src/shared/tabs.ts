/**
 * The rules of a row of tabs (HI-1837, components/Tabs.tsx), kept apart from React so they can be tested: which tab a
 * key moves to, and what a remembered selection becomes when the tabs offered have changed.
 */

/** The tab a key selects from `current` (arrows wrap, Home and End the ends), or null for a key tabs don't take. */
export function tabAfterKey<T extends string>(ids: readonly T[], current: T, key: string): T | null {
  if (!ids.length) return null
  const at = Math.max(0, ids.indexOf(current))
  switch (key) {
    case 'ArrowRight':
      return ids[(at + 1) % ids.length]!
    case 'ArrowLeft':
      return ids[(at - 1 + ids.length) % ids.length]!
    case 'Home':
      return ids[0]!
    case 'End':
      return ids[ids.length - 1]!
  }
  return null
}

/** The tab shown: the one wanted (remembered, or a link's) while it is offered, else `fallback`, else the first. */
export function shownTab<T extends string>(ids: readonly T[], wanted: string | undefined, fallback: T): T {
  if (wanted !== undefined && (ids as readonly string[]).includes(wanted)) return wanted as T
  return ids.includes(fallback) || !ids.length ? fallback : ids[0]!
}

/** The most rows of tabs whose selection is remembered; the least recently chosen go first. */
export const REMEMBERED_TABS_MAX = 100

/** The remembered selections with `key`'s set to `id` (moved to the end, the oldest dropped past the limit). */
export function rememberTab(all: Record<string, string>, key: string, id: string): Record<string, string> {
  const next = { ...all }
  delete next[key]
  next[key] = id
  return Object.fromEntries(Object.entries(next).slice(-REMEMBERED_TABS_MAX))
}
