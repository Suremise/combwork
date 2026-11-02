// Structural sharing (HI-1806): a new copy of data the window already has (a workspace main sent again, the same in
// most of its parts) keeps the old objects wherever they are equal, so what reads one of them by reference (a selector,
// React.memo) sees no change there. Plain objects and arrays only, as IPC delivers them; anything else is compared by
// reference.

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype

/** `next`, with each part equal to the same part of `prev` replaced by `prev`'s: `prev` itself when they are equal throughout. */
export function keepSame<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length
    const out = next.map((v, i) => {
      const kept = i < prev.length ? keepSame(prev[i], v) : v
      if (kept !== prev[i]) same = false
      return kept
    })
    return (same ? prev : out) as T
  }
  if (plain(prev) && plain(next)) {
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(prev).length
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const kept = Object.hasOwn(prev, k) ? keepSame(prev[k], next[k]) : next[k]
      if (kept !== prev[k] || !Object.hasOwn(prev, k)) same = false
      out[k] = kept
    }
    return (same ? prev : out) as T
  }
  return next
}
