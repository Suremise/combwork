// A server connection's key masked wherever Hive writes text (HI-1772, main/keyMatcher.ts): any run of FRAGMENT or more
// of its characters, as it is or JSON-escaped (once, twice) or URL-encoded, found by keyed hashes whatever the key's
// shape (dummy keys no other rule masks, quotes and backslashes included), alone, inside other text, split into pieces
// anywhere, through the sinks that write (hive.log's line with serialised data, the developer console's events), and
// only while it is in use.
import { afterEach, describe, expect, it } from 'vitest'
import { FRAGMENT, holdKey, keysInUse, maskDeep, maskKeys } from '../src/main/keyMatcher'
import { maskSecrets, maskText } from '../src/shared/redact'
import { makeEvent } from '../src/shared/devConsole'

// No `sk-`, no long hex or base64 run, no credential word before it: only the key matcher can find these.
const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
// Every character JSON and URLs escape: quotes, backslashes, % & = + / ?.
const ODD = 'a"b\\c%d&e=f+g/h?i"j\\k'
const OTHER = 'Yq!7#mP2&vL9^tR4~wY9'
const releases: (() => void)[] = []
const use = (k: string): (() => void) => {
  const r = holdKey(k)
  releases.push(r)
  return r
}
afterEach(() => {
  for (const r of releases.splice(0)) r()
})
const leaks = (text: string, key: string): string | null => {
  // Any FRAGMENT characters of it, as it is or escaped, left in the text.
  for (const form of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]) for (let i = 0; i + FRAGMENT <= form.length; i++) if (text.includes(form.slice(i, i + FRAGMENT))) return form.slice(i, i + FRAGMENT)
  return null
}

describe('a key in use', () => {
  it("isn't masked by the other rules alone (the dummies are shaped so)", () => {
    expect(maskText(`output: ${KEY} done`)).toContain(KEY)
  })
  it('alone, embedded and twice: masked, the rest kept', () => {
    use(KEY)
    expect(maskKeys(KEY)).toBe('<key>')
    expect(maskKeys(`abc${KEY}def`)).toBe('abc<key>def')
    expect(maskKeys(`${KEY} and ${KEY}`)).toBe('<key> and <key>')
    expect(maskSecrets(`x ${KEY} y`)).toBe('x <key> y')
    expect(maskText(`x ${KEY} y`)).not.toContain(KEY)
  })
  it('with quotes and backslashes: as it is, JSON-escaped once and twice, and URL-encoded', () => {
    use(ODD)
    const once = JSON.stringify({ output: ODD })
    const twice = JSON.stringify({ payload: once })
    const url = `https://x.example/?q=${encodeURIComponent(ODD)}`
    for (const t of [ODD, once, twice, url]) expect(leaks(maskKeys(t), ODD), t).toBeNull()
    // Its encoded forms stay valid where the rest is: JSON masked as values parses.
    expect(JSON.parse(JSON.stringify(maskDeep({ output: ODD, nested: [ODD] })))).toEqual({ output: '<key>', nested: ['<key>'] })
  })
  it('split into pieces anywhere: each piece of FRAGMENT or more is masked, wherever it is cut', () => {
    use(KEY)
    for (let a = 1; a < KEY.length; a++)
      for (let b = a + 1; b <= KEY.length; b++) {
        const pieces = [KEY.slice(0, a), KEY.slice(a, b), KEY.slice(b)].filter(Boolean)
        for (const p of pieces) {
          const masked = maskKeys(`[${p}]`)
          if (p.length >= FRAGMENT) expect(masked, p).toBe('[<key>]')
        }
      }
    // Shorter than FRAGMENT can't be told from noise: kept.
    expect(maskKeys(`x ${KEY.slice(3, 3 + FRAGMENT - 1)} y`)).toContain(KEY.slice(3, 3 + FRAGMENT - 1))
  })
  it('a similar run that is not the key is left alone', () => {
    use(KEY)
    expect(maskKeys(`value ${OTHER.slice(0, 2)}${'q'.repeat(10)} end`)).toBe(`value ${OTHER.slice(0, 2)}${'q'.repeat(10)} end`)
  })
  it("through the sinks: the developer console's event (its payload) and hive.log's line with serialised data", async () => {
    use(ODD)
    const e = makeEvent(1, '2026-10-27T00:00:00Z', 'x', { kind: 'hook', name: 'PostToolUse', summary: `ran ${ODD}`, raw: { tool_response: { stdout: `TOKEN=${ODD}\n` } } }, {})
    expect(leaks(JSON.stringify(e), ODD)).toBeNull()
    const { logLine } = await import('../src/main/logger')
    expect(leaks(logLine('warn', 'test', `said ${ODD}`, { output: ODD }), ODD)).toBeNull()
  })
  it('before it is used, and after its last use ends, nothing is masked; uses are counted', () => {
    expect(maskKeys(KEY)).toBe(KEY)
    const r1 = use(KEY)
    const r2 = use(KEY)
    expect(keysInUse()).toBe(1)
    r1()
    r1()
    expect(maskKeys(KEY)).toBe('<key>')
    r2()
    expect(keysInUse()).toBe(0)
    expect(maskKeys(KEY)).toBe(KEY)
  })
  it('a replaced key: the old one masked while a use of it remains, the new one too', () => {
    const old = use(KEY)
    use(ODD)
    expect(maskKeys(`${KEY} ${ODD}`)).toBe('<key> <key>')
    old()
    expect(maskKeys(`${KEY} ${ODD}`)).toBe(`${KEY} <key>`)
  })
  it('linear on long text with no key in it', () => {
    use(KEY)
    const long = 'a'.repeat(200_000)
    const t0 = performance.now()
    expect(maskKeys(long)).toBe(long)
    // A bound for a hung run, not how long it takes.
    expect(performance.now() - t0).toBeLessThan(5_000)
  })
})
