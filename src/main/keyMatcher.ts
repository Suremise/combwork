import { createHmac } from 'crypto'
import { isMainThread } from 'worker_threads'
import { setKeyMasker } from '../shared/redact'

/**
 * Finds server connections' keys in text without the keys (HI-1772): each key ever saved left a fingerprint
 * (keyCoverage.ts keeps them, encrypted, across Replace, Remove and restarts): a keyed hash (HMAC, a secret salt) of
 * every run of FRAGMENT characters of it, as it is, JSON-escaped once and twice, and URL-encoded. Text is scanned once
 * with a rolling hash whose base is secret too, and a window that matches is checked by its HMAC; every matching window
 * is masked, so any FRAGMENT characters or more of a key are masked wherever they are, whole or cut anywhere.
 *
 * Strict (`strict()`): while the fingerprints aren't loaded yet in main, can't be read, or a reset lost some (a coverage
 * gap, for good), every run of FRAGMENT or more characters without whitespace is masked instead: a key has no
 * whitespace in any of its forms, so none of it can pass. `none` (no key was ever saved): nothing to mask.
 *
 * maskKeys is plugged into shared/redact.ts's maskSecrets (the developer console, its recordings and flight captures,
 * Copy Diagnostics, transcript views) and hive.log's line (logger.ts logLine); the exports mask what they write with it.
 */

export const FRAGMENT = 8
/** A prime under 2^24: products stay exact in a double. A prefilter only: each hit is checked by its HMAC. */
export const MOD = 16777213
/** The HMAC kept per window: its first bytes, enough to tell a key's window from others. */
const MAC_BYTES = 12

export type MaskingState = 'none' | 'pending' | 'ready' | 'unavailable'
export interface MatchSecret {
  salt: Buffer
  base: number
}
/** A window's fingerprint: its prefilter hash and its truncated HMAC. */
export type Window = [hash: number, mac: string]

// Electron's main process starts pending (strict) until keyCoverage says what it has; a worker (and a plain Node test
// run, which loads no coverage) has none.
let state: MaskingState = isMainThread && (process as { type?: string }).type === 'browser' ? 'pending' : 'none'
let gap = false
let secret: MatchSecret | null = null
let top = 1
let index = new Map<number, Set<string>>()

const mac = (s: MatchSecret, text: string): string => createHmac('sha256', s.salt).update(text, 'utf8').digest().subarray(0, MAC_BYTES).toString('base64')

function hashes(s: MatchSecret, text: string): number[] {
  const out: number[] = []
  if (text.length < FRAGMENT) return out
  let h = 0
  for (let i = 0; i < FRAGMENT; i++) h = ((h * s.base) % MOD + text.charCodeAt(i)) % MOD
  out.push(h)
  const t = topOf(s)
  for (let i = FRAGMENT; i < text.length; i++) {
    h = ((((h - ((text.charCodeAt(i - FRAGMENT) * t) % MOD) + MOD) % MOD) * s.base) % MOD + text.charCodeAt(i)) % MOD
    out.push(h)
  }
  return out
}

/** base^(FRAGMENT-1) mod MOD: takes a window's first character out. */
function topOf(s: MatchSecret): number {
  let p = 1
  for (let i = 0; i < FRAGMENT - 1; i++) p = (p * s.base) % MOD
  return p
}

/** The ways a key is written where Hive may meet it: as it is, JSON-escaped once and twice, URL-encoded. */
function forms(key: string): string[] {
  const once = JSON.stringify(key).slice(1, -1)
  const twice = JSON.stringify(once).slice(1, -1)
  return [...new Set([key, once, twice, encodeURIComponent(key)])]
}

/** A key's fingerprint under a secret: every window of every form (kept, encrypted, by keyCoverage.ts). */
export function fingerprint(s: MatchSecret, key: string): Window[] {
  const out: Window[] = []
  for (const f of forms(key)) hashes(s, f).forEach((h, i) => out.push([h, mac(s, f.slice(i, i + FRAGMENT))]))
  return out
}

/** What keyCoverage.ts loaded or decided: the state, the sticky gap, and (ready) the secret and every key's windows. */
export function setMasking(o: { state: MaskingState; gap?: boolean; secret?: MatchSecret | null; windows?: Window[] }): void {
  state = o.state
  if (o.gap !== undefined) gap = gap || o.gap
  if (o.secret !== undefined) {
    secret = o.secret
    top = secret ? topOf(secret) : 1
  }
  if (o.windows) {
    index = new Map()
    addWindows(o.windows)
  }
}

/** A newly saved key's windows, matched from now on. */
export function addWindows(windows: Window[]): void {
  for (const [h, m] of windows) {
    let s = index.get(h)
    if (!s) index.set(h, (s = new Set()))
    s.add(m)
  }
}

/** Whether every long run is masked: not loaded yet, unreadable, or a coverage gap (sticky). */
export const strict = (): boolean => gap || state === 'pending' || state === 'unavailable'
export const maskingState = (): { state: MaskingState; gap: boolean } => ({ state, gap })

const MASK = '<key>'
const STRICT_MASK = '<masked>'
const LONG_RUN = new RegExp(`[^\\s]{${FRAGMENT},}`, 'g')

/** The text with every run of FRAGMENT or more characters of a saved key masked (strict: every long run). */
export function maskKeys(text: string): string {
  if (!text) return text
  if (strict()) return text.replace(LONG_RUN, STRICT_MASK)
  if (state === 'none' || !secret || !index.size || text.length < FRAGMENT) return text
  const s = secret
  const ranges: [number, number][] = []
  // The rolling hash inline (as hashes() does), checked against the index as it goes.
  let h = 0
  for (let i = 0; i < FRAGMENT; i++) h = ((h * s.base) % MOD + text.charCodeAt(i)) % MOD
  for (let i = 0; ; i++) {
    const macs = index.get(h)
    if (macs && macs.has(mac(s, text.slice(i, i + FRAGMENT)))) {
      const last = ranges[ranges.length - 1]
      if (last && i <= last[1]) last[1] = i + FRAGMENT
      else ranges.push([i, i + FRAGMENT])
    }
    if (i + FRAGMENT >= text.length) break
    h = ((((h - ((text.charCodeAt(i) * top) % MOD) + MOD) % MOD) * s.base) % MOD + text.charCodeAt(i + FRAGMENT)) % MOD
  }
  if (!ranges.length) return text
  let out = ''
  let at = 0
  for (const [start, end] of ranges) {
    out += text.slice(at, start) + MASK
    at = end
  }
  return out + text.slice(at)
}

/** A value with every string in it (and every key of its objects) masked: for what is written as JSON, before encoding. */
export function maskDeep<T>(v: T): T {
  if (state === 'none' && !gap) return v
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return maskKeys(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [maskKeys(k), walk(y)]))
    return x
  }
  return walk(v) as T
}

/** For tests: as a process that has loaded nothing (the gap included, which nothing else lowers). */
export function resetMaskingForTests(to: MaskingState = 'none'): void {
  state = to
  gap = false
  secret = null
  top = 1
  index = new Map()
}

setKeyMasker(maskKeys)
