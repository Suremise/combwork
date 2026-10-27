import { createHmac, randomBytes } from 'crypto'
import { setKeyMasker } from '../shared/redact'

/**
 * Finds a server connection's key in text without keeping the key (HI-1772): for each key in use, its length, a keyed
 * hash (HMAC, a salt made for this run of Hive) of the whole key, of each of its prefixes and suffixes of EDGE_MIN
 * characters or more, and a rolling hash of its first WINDOW characters. Text is scanned once with the rolling hash; a
 * window that matches is checked by hashing the text there. So the key is found anywhere: alone, inside a longer run, in
 * JSON, whatever its shape (no reliance on the `sk-`/hex/base64 rules). A string that starts with the end of a key, or
 * ends with its start (a screen's tail cut mid-key, a line split), is masked there too, down to EDGE_MIN characters.
 *
 * Registered while the key is in use (a launch, a Set Up terminal, a model listing, a Save), counted, and dropped when
 * the last use ends: there is nothing to decrypt at start-up. masked() is plugged into shared/redact.ts's maskSecrets,
 * which hive.log, Copy Diagnostics, the developer console, its recordings and flight captures, transcript views and the
 * exports all go through.
 */

const WINDOW = 16
/** A key's start or end at a string's edge is masked down to this many characters (fewer can't be told from noise). */
export const EDGE_MIN = 8
const MOD = 2147483647
const BASE = 257

interface Entry {
  len: number
  /** The rolling hash of its first WINDOW characters. */
  head: number
  full: string
  /** Keyed hashes of its prefixes and suffixes, by length (EDGE_MIN to len - 1). */
  prefixes: Map<number, string>
  suffixes: Map<number, string>
  refs: number
}

const salt = randomBytes(32)
const mac = (s: string): string => createHmac('sha256', salt).update(s, 'utf8').digest('base64')
const entries = new Map<string, Entry>()

function rolling(s: string, from: number, n: number): number {
  let h = 0
  for (let i = from; i < from + n; i++) h = (h * BASE + s.charCodeAt(i)) % MOD
  return h
}

/** A use of a key: masked from now on, until every use is released. Returns its release (safe to call twice). */
export function holdKey(key: string): () => void {
  const id = mac(key)
  let e = entries.get(id)
  if (!e) {
    const prefixes = new Map<number, string>()
    const suffixes = new Map<number, string>()
    for (let n = EDGE_MIN; n < key.length; n++) {
      prefixes.set(n, mac(key.slice(0, n)))
      suffixes.set(n, mac(key.slice(key.length - n)))
    }
    e = { len: key.length, head: rolling(key, 0, Math.min(WINDOW, key.length)), full: id, prefixes, suffixes, refs: 0 }
    entries.set(id, e)
  }
  e.refs++
  const entry = e
  let released = false
  return () => {
    if (released) return
    released = true
    entry.refs--
    if (entry.refs <= 0 && entries.get(id) === entry) entries.delete(id)
  }
}

/** How many keys are masked now (tests). */
export const keysInUse = (): number => entries.size

const MASK = '<key>'

/** The text with every key in use masked: whole, and cut at either edge. */
export function maskKeys(text: string): string {
  if (!entries.size || !text) return text
  const ranges: [number, number][] = []
  const all = [...entries.values()]
  // Whole keys: a rolling window over the text, per window size in use (keys shorter than WINDOW use their own length).
  for (const w of new Set(all.map((e) => Math.min(WINDOW, e.len)))) {
    const sized = all.filter((e) => Math.min(WINDOW, e.len) === w)
    const heads = new Set(sized.map((e) => e.head))
    if (text.length < w) continue
    // BASE^(w-1): takes the window's first character out.
    let top = 1
    for (let i = 0; i < w - 1; i++) top = (top * BASE) % MOD
    let h = rolling(text, 0, w)
    for (let i = 0; ; i++) {
      if (heads.has(h)) for (const e of sized) if (e.head === h && i + e.len <= text.length && mac(text.slice(i, i + e.len)) === e.full) ranges.push([i, i + e.len])
      if (i + w >= text.length) break
      h = (((h - ((text.charCodeAt(i) * top) % MOD) + MOD) % MOD) * BASE + text.charCodeAt(i + w)) % MOD
    }
  }
  // A key's end at the start of the text, and its start at the end: only within the run of key characters there (a key
  // has no spaces), so most text is checked by no hash at all.
  const lead = /^[\x21-\x7e]*/.exec(text)![0].length
  const trail = /[\x21-\x7e]*$/.exec(text)![0].length
  for (const e of all) {
    for (let n = Math.min(e.len - 1, lead); n >= EDGE_MIN; n--) {
      if (mac(text.slice(0, n)) === e.suffixes.get(n)) {
        ranges.push([0, n])
        break
      }
    }
    for (let n = Math.min(e.len - 1, trail); n >= EDGE_MIN; n--) {
      if (mac(text.slice(text.length - n)) === e.prefixes.get(n)) {
        ranges.push([text.length - n, text.length])
        break
      }
    }
  }
  if (!ranges.length) return text
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [s, end] of ranges) {
    if (end <= at) continue
    out += text.slice(at, Math.max(at, s)) + (s >= at ? MASK : '')
    at = end
  }
  return out + text.slice(at)
}

setKeyMasker(maskKeys)
