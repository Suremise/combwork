import { createHmac, randomBytes, randomInt } from 'crypto'
import { setKeyMasker } from '../shared/redact'

/**
 * Finds a server connection's key in text without keeping the key (HI-1772): for each key in use, a keyed hash (HMAC,
 * with a salt made for this run of Hive) of every run of FRAGMENT characters in it, and of each of those runs as the key
 * is written once or twice JSON-escaped and URL-encoded (a log's serialised data, a payload inside a payload, a query).
 * Text is scanned once with a rolling hash whose base is secret too, and a window that matches is checked by its HMAC;
 * every matching window is masked, so any FRAGMENT characters or more of a key are masked wherever they are: the whole
 * key, a key inside a longer run or in JSON, or a piece of one cut off by a string's edge or split between strings.
 * Fewer than FRAGMENT characters can't be told from noise and are left.
 *
 * Registered while the key is in use (a launch until its exit is handled, a Set Up terminal, a model reading, a Save,
 * an export: holdKey), counted, and dropped when the last use ends: no key is decrypted at start-up. maskKeys is plugged
 * into shared/redact.ts's maskSecrets (the developer console, its recordings and flight captures, Copy Diagnostics,
 * transcript views) and hive.log's writer, and the exports call it on what they write.
 */

export const FRAGMENT = 8
/** A prime under 2^24: products stay exact in a double (under 2^48). A prefilter only: each hit is checked by its HMAC. */
const MOD = 16777213
/** The rolling hash's base: secret, so the prefilter's hashes say nothing about the key on their own. */
const BASE = randomInt(1 << 12, MOD - 1)
const salt = randomBytes(32)
const mac = (s: string): string => createHmac('sha256', salt).update(s, 'utf8').digest('base64')

const mulMod = (a: number, b: number): number => (a * b) % MOD
/** BASE^(FRAGMENT-1) mod MOD: takes the window's first character out. */
const TOP = (() => {
  let p = 1
  for (let i = 0; i < FRAGMENT - 1; i++) p = mulMod(p, BASE)
  return p
})()

function windows(s: string): number[] {
  const out: number[] = []
  if (s.length < FRAGMENT) return out
  let h = 0
  for (let i = 0; i < FRAGMENT; i++) h = (mulMod(h, BASE) + s.charCodeAt(i)) % MOD
  out.push(h)
  for (let i = FRAGMENT; i < s.length; i++) {
    h = (mulMod((h - mulMod(s.charCodeAt(i - FRAGMENT), TOP) + MOD) % MOD, BASE) + s.charCodeAt(i)) % MOD
    out.push(h)
  }
  return out
}

/** The ways a key is written where Hive may meet it: as it is, JSON-escaped once and twice, URL-encoded. */
function forms(key: string): string[] {
  const once = JSON.stringify(key).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  return [...new Set([key, once, twice, encodeURIComponent(key)])]
}

interface Entry {
  /** Each window's rolling hash → the HMACs of the windows with it. */
  grams: Map<number, Set<string>>
  refs: number
}
const entries = new Map<string, Entry>()
/** All keys' windows together, rebuilt when a key is held or let go. */
let index = new Map<number, Set<string>>()

function rebuild(): void {
  const next = new Map<number, Set<string>>()
  for (const e of entries.values())
    for (const [h, macs] of e.grams) {
      let s = next.get(h)
      if (!s) next.set(h, (s = new Set()))
      for (const m of macs) s.add(m)
    }
  index = next
}

/** A use of a key: masked from now on, until every use is released. Returns its release (safe to call twice). */
export function holdKey(key: string): () => void {
  const id = mac(`key:${key}`)
  let e = entries.get(id)
  if (!e) {
    const grams = new Map<number, Set<string>>()
    for (const f of forms(key))
      windows(f).forEach((h, i) => {
        let s = grams.get(h)
        if (!s) grams.set(h, (s = new Set()))
        s.add(mac(f.slice(i, i + FRAGMENT)))
      })
    e = { grams, refs: 0 }
    entries.set(id, e)
    rebuild()
  }
  e.refs++
  const entry = e
  let released = false
  return () => {
    if (released) return
    released = true
    entry.refs--
    if (entry.refs <= 0 && entries.get(id) === entry) {
      entries.delete(id)
      rebuild()
    }
  }
}

/** How many keys are masked now (tests). */
export const keysInUse = (): number => entries.size

const MASK = '<key>'

/** The text with every run of FRAGMENT or more characters of a key in use masked, in any of the forms it is written in. */
export function maskKeys(text: string): string {
  if (!index.size || !text || text.length < FRAGMENT) return text
  const ranges: [number, number][] = []
  windows(text).forEach((h, i) => {
    const macs = index.get(h)
    if (!macs || !macs.has(mac(text.slice(i, i + FRAGMENT)))) return
    const last = ranges[ranges.length - 1]
    if (last && i <= last[1]) last[1] = i + FRAGMENT
    else ranges.push([i, i + FRAGMENT])
  })
  if (!ranges.length) return text
  let out = ''
  let at = 0
  for (const [s, end] of ranges) {
    out += text.slice(at, s) + MASK
    at = end
  }
  return out + text.slice(at)
}

/** A value with every string in it (and every key of its objects) masked: for what is written as JSON, before encoding. */
export function maskDeep<T>(v: T): T {
  if (!index.size) return v
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return maskKeys(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [maskKeys(k), walk(y)]))
    return x
  }
  return walk(v) as T
}

setKeyMasker(maskKeys)
