// A server connection's key masked wherever Hive writes text (HI-1772, main/keyMatcher.ts): found by its keyed hashes,
// whatever its shape (a dummy key no other rule masks), alone, inside other text, cut at either edge of a string, and
// only while it is in use.
import { afterEach, describe, expect, it } from 'vitest'
import { EDGE_MIN, keysInUse, maskKeys, holdKey } from '../src/main/keyMatcher'
import { maskSecrets, maskText } from '../src/shared/redact'

// No `sk-`, no long hex or base64 run, no credential word before it: only the key matcher can find it.
const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
const OTHER = 'Yq!7#mP2&vL9^tR4~wX8'
const releases: (() => void)[] = []
const use = (k: string): (() => void) => {
  const r = holdKey(k)
  releases.push(r)
  return r
}
afterEach(() => {
  for (const r of releases.splice(0)) r()
})

describe('a key in use', () => {
  it("isn't masked by the other rules alone (the dummy is shaped so)", () => {
    expect(maskText(`output: ${KEY} done`)).toContain(KEY)
  })
  it('alone, embedded, in JSON and twice: masked, the rest kept', () => {
    use(KEY)
    expect(maskKeys(KEY)).toBe('<key>')
    expect(maskKeys(`abc${KEY}def`)).toBe('abc<key>def')
    expect(maskKeys(JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: KEY } }))).toBe('{"env":{"ANTHROPIC_AUTH_TOKEN":"<key>"}}')
    expect(maskKeys(`${KEY} and ${KEY}`)).toBe('<key> and <key>')
    // Through every sink's masking (maskSecrets, maskText).
    expect(maskSecrets(`x ${KEY} y`)).not.toContain(KEY)
    expect(maskText(`x ${KEY} y`)).not.toContain(KEY)
  })
  it('a similar run that is not the key is left alone', () => {
    use(KEY)
    expect(maskKeys(`value ${OTHER} end`)).toBe(`value ${OTHER} end`)
  })
  it('cut at either edge of a string (a screen tail, a split line), down to EDGE_MIN characters', () => {
    use(KEY)
    const half = Math.ceil(KEY.length / 2)
    expect(maskKeys(`printed: ${KEY.slice(0, half)}`)).toBe('printed: <key>')
    expect(maskKeys(`${KEY.slice(half)} and more`)).toBe('<key> and more')
    // Split over two chunks: each masked where it is cut.
    const [a, b] = [`env A=${KEY.slice(0, 11)}`, `${KEY.slice(11)} next`]
    expect(maskKeys(a) + maskKeys(b)).not.toMatch(/Zq!7#mP2&|vL9\^tR4~wX8/)
    // Shorter than EDGE_MIN at an edge can't be told from noise: kept.
    expect(maskKeys(`x ${KEY.slice(0, EDGE_MIN - 1)}`)).toBe(`x ${KEY.slice(0, EDGE_MIN - 1)}`)
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
    use(OTHER)
    expect(maskKeys(`${KEY} ${OTHER}`)).toBe('<key> <key>')
    old()
    expect(maskKeys(`${KEY} ${OTHER}`)).toBe(`${KEY} <key>`)
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
