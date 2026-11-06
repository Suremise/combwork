// Server connections' keys masked wherever Combwork writes text (HI-1772, main/keyMatcher.ts): by each saved key's
// fingerprint, any run of FRAGMENT or more of its characters, as it is or JSON-escaped (once, twice) or URL-encoded,
// whatever the key's shape (dummy keys no other rule masks, quotes and backslashes included), alone, inside other text,
// split anywhere, through the sinks that write (combwork.log's line with serialised data, the developer console's events).
// Strict (not loaded yet, unreadable, or after a reset's gap): every long run masked. None: nothing to mask.
import { randomBytes } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, FRAGMENT, maskDeep, maskKeys, maskingState, resetMaskingForTests, setMasking, strict, type MatchSecret } from '../src/main/keyMatcher'
import { maskSecrets, maskText } from '../src/shared/redact'
import { makeEvent } from '../src/shared/devConsole'
import { logLine } from '../src/main/logger'

// No `sk-`, no long hex or base64 run, no credential word before it: only the key matcher can find these.
const KEY = 'Zq!7#mP2&vL9^tR4~wX8'
// Every character JSON and URLs escape: quotes, backslashes, % & = + / ?.
const ODD = 'a"b\\c%d&e=f+g/h?i"j\\k'
const OTHER = 'Yq!7#mP2&vL9^tR4~wY9'
const secret: MatchSecret = { salt: randomBytes(32), base: 4099 }
/** As keyCoverage.ts does once the fingerprints of these keys are loaded. */
const ready = (...keys: string[]): void => setMasking({ state: 'ready', secret, windows: keys.flatMap((k) => fingerprint(secret, k)) })
afterEach(() => resetMaskingForTests())

const leaks = (text: string, key: string): string | null => {
  // Any FRAGMENT characters of it, as it is or escaped, left in the text.
  for (const form of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]) for (let i = 0; i + FRAGMENT <= form.length; i++) if (text.includes(form.slice(i, i + FRAGMENT))) return form.slice(i, i + FRAGMENT)
  return null
}

describe('a saved key, by its fingerprint', () => {
  it("isn't masked by the other rules alone (the dummies are shaped so)", () => {
    expect(maskText(`output: ${KEY} done`)).toContain(KEY)
  })
  it('alone, embedded and twice: masked, the rest kept', () => {
    ready(KEY)
    expect(maskKeys(KEY)).toBe('<key>')
    expect(maskKeys(`abc${KEY}def`)).toBe('abc<key>def')
    expect(maskKeys(`${KEY} and ${KEY}`)).toBe('<key> and <key>')
    expect(maskSecrets(`x ${KEY} y`)).toBe('x <key> y')
    expect(maskText(`x ${KEY} y`)).not.toContain(KEY)
  })
  it('with quotes and backslashes: as it is, JSON-escaped once and twice, and URL-encoded', () => {
    ready(ODD)
    const once = JSON.stringify({ output: ODD })
    const twice = JSON.stringify({ payload: once })
    const url = `https://x.example/?q=${encodeURIComponent(ODD)}`
    for (const t of [ODD, once, twice, url]) expect(leaks(maskKeys(t), ODD), t).toBeNull()
    // JSON masked as values stays valid.
    expect(JSON.parse(JSON.stringify(maskDeep({ output: ODD, nested: [ODD] })))).toEqual({ output: '<key>', nested: ['<key>'] })
  })
  it('split into pieces anywhere: each piece of FRAGMENT or more is masked, wherever it is cut', () => {
    ready(KEY)
    for (let a = 1; a < KEY.length; a++)
      for (let b = a + 1; b <= KEY.length; b++) for (const p of [KEY.slice(0, a), KEY.slice(a, b), KEY.slice(b)]) if (p.length >= FRAGMENT) expect(maskKeys(`[${p}]`), p).toBe('[<key>]')
    // Shorter than FRAGMENT can't be told from noise: kept.
    expect(maskKeys(`x ${KEY.slice(3, 3 + FRAGMENT - 1)} y`)).toContain(KEY.slice(3, 3 + FRAGMENT - 1))
  })
  it('a similar run that is not the key is left alone', () => {
    ready(KEY)
    expect(maskKeys(`value ${OTHER.slice(0, 2)}${'q'.repeat(10)} end`)).toBe(`value ${OTHER.slice(0, 2)}${'q'.repeat(10)} end`)
  })
  it("through the sinks: the developer console's event (its payload) and combwork.log's line with serialised data", () => {
    ready(ODD)
    const e = makeEvent(1, '2026-10-27T00:00:00Z', 'x', { kind: 'hook', name: 'PostToolUse', summary: `ran ${ODD}`, raw: { tool_response: { stdout: `TOKEN=${ODD}\n` } } }, {})
    expect(leaks(JSON.stringify(e), ODD)).toBeNull()
    expect(leaks(logLine('warn', 'test', `said ${ODD}`, { output: ODD }), ODD)).toBeNull()
  })
  it('several keys (one replaced, one current): both masked', () => {
    ready(KEY, ODD)
    expect(maskKeys(`${KEY} ${ODD}`)).toBe('<key> <key>')
  })
  it('linear on long text with no key in it', () => {
    ready(KEY)
    const long = 'a'.repeat(200_000)
    const t0 = performance.now()
    expect(maskKeys(long)).toBe(long)
    // A bound for a hung run, not how long it takes.
    expect(performance.now() - t0).toBeLessThan(5_000)
  })
})

describe('strict and none', () => {
  it('none (no key ever saved): nothing is masked', () => {
    expect(maskingState()).toEqual({ state: 'none', gap: false })
    expect(maskKeys(`plain ${KEY} text`)).toBe(`plain ${KEY} text`)
  })
  it('pending, unavailable or a gap: every run of FRAGMENT or more without whitespace is masked, a key in any form', () => {
    for (const s of [{ state: 'pending' as const }, { state: 'unavailable' as const }, { state: 'ready' as const, gap: true, secret, windows: [] }]) {
      resetMaskingForTests()
      setMasking(s)
      expect(strict()).toBe(true)
      for (const k of [KEY, ODD]) {
        expect(leaks(maskKeys(`short words ${k} ok`), k)).toBeNull()
        expect(leaks(logLine('info', 'x', `printed ${k}`, { out: k }), k)).toBeNull()
        expect(leaks(JSON.stringify(makeEvent(1, '2026-10-27T00:00:00Z', 'x', { kind: 'hook', name: 'n', summary: k, raw: { a: k } }, {})), k)).toBeNull()
      }
      expect(maskKeys('short words stay')).toBe('short words stay')
    }
  })
  it('a gap is sticky: nothing in the process lowers it', () => {
    setMasking({ state: 'ready', gap: true, secret, windows: [] })
    setMasking({ state: 'ready', gap: false })
    expect(maskingState().gap).toBe(true)
  })
  it("combwork.log's time, level and scope are kept in strict mode", () => {
    setMasking({ state: 'unavailable' })
    expect(logLine('info', 'main', `x ${KEY}`)).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[INFO\] \[main\] x <masked>\n$/)
  })
})
