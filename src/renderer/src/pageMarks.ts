// What the page did lately (HI-1775): each store update, by the parts it changed, the same in a row counted as one, so a
// long task's line in hive.log names the updates made in it (windowHealth.ts). It imports nothing (the store imports it).

const marks: { at: number; what: string; n: number }[] = []

/** A mark now (epoch ms): the same as the last within a moment adds to it; a small ring, only the last moments matter. */
function mark(what: string): void {
  const at = Date.now()
  const last = marks.at(-1)
  if (last && last.what === what && at - last.at < 100) {
    last.n++
    last.at = at
    return
  }
  marks.push({ at, what, n: 1 })
  if (marks.length > 300) marks.shift()
}

/** The store was updated: these parts (null: by a function, so which isn't known before it runs). */
export function storeUpdated(keys: readonly string[] | null): void {
  mark(`store ${keys ? keys.slice(0, 4).join('+') + (keys.length > 4 ? '+…' : '') : 'update'}`)
}

/** The marks made between two times (epoch ms), in words ("store tasks ×3"). */
export function marksBetween(from: number, to: number): string[] {
  return marks.filter((m) => m.at >= from && m.at <= to).map((m) => (m.n > 1 ? `${m.what} ×${m.n}` : m.what))
}
