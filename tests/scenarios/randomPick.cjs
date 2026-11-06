// --random N (HI-2655): a release's model trial runs a few scenarios picked at random, once each. The pick is seeded, so
// the card can name its seed (or the ids) and the same pick can be run again: `--random N --seed S`, or `--only <ids>`.

/** A seed: --seed's value (a whole number from 0 to 2^32-1), else a new one. */
function parseSeed(v, fresh = () => Math.floor(Math.random() * 2 ** 32)) {
  if (v === undefined || v === null || v === '') return fresh()
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 32) throw new Error(`--seed must be a whole number from 0 to 4294967295, not "${v}".`)
  return n
}

/** A --random value: a whole number above 0, or an error saying what it must be. */
function parseRandom(v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--random must be a whole number of scenarios above 0, not "${v}".`)
  return n
}

/** mulberry32: a small seeded generator, the same numbers for the same seed on every machine. */
function generator(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` of `items` picked by `seed`, in the items' own order (all of them when there are no more). */
function pickRandom(items, count, seed) {
  if (count >= items.length) return [...items]
  const next = generator(seed)
  const idx = items.map((_, i) => i)
  // A partial Fisher-Yates shuffle: the first `count` places are the pick.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(next() * (idx.length - i))
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const picked = new Set(idx.slice(0, count))
  return items.filter((_, i) => picked.has(i))
}

module.exports = { parseSeed, parseRandom, pickRandom }
