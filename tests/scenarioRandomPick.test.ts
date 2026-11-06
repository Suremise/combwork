// --random N for the scenario runner (HI-2655): a release's model trial is a few scenarios picked at random, seeded so
// the release card can name the seed and the pick can be run again.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { parseRandom, parseSeed, pickRandom } = require_('./scenarios/randomPick.cjs')
const { SCENARIOS } = require_('./scenarios/scenarios.cjs')

describe('scenario runner --random', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`)

  it('picks the same scenarios for the same seed, in their own order, with no repeats', () => {
    const a = pickRandom(ids, 4, 12345)
    expect(a).toHaveLength(4)
    expect(new Set(a).size).toBe(4)
    expect(pickRandom(ids, 4, 12345)).toEqual(a)
    expect([...a].sort((x: string, y: string) => ids.indexOf(x) - ids.indexOf(y))).toEqual(a)
    for (const id of a) expect(ids).toContain(id)
  })

  it('picks differently across seeds', () => {
    const picks = new Set(Array.from({ length: 10 }, (_, seed) => pickRandom(ids, 3, seed).join(',')))
    expect(picks.size).toBeGreaterThan(5)
  })

  it('takes them all when asked for as many or more', () => {
    expect(pickRandom(ids, 20, 1)).toEqual(ids)
    expect(pickRandom(ids.slice(0, 2), 5, 1)).toEqual(ids.slice(0, 2))
  })

  it('picks from the real scenario set', () => {
    const picked = pickRandom(SCENARIOS, 3, 7)
    expect(picked).toHaveLength(3)
    for (const s of picked) expect(SCENARIOS).toContain(s)
  })

  it('checks --random and --seed', () => {
    expect(parseRandom('3')).toBe(3)
    expect(() => parseRandom('0')).toThrow(/above 0/)
    expect(() => parseRandom('2.5')).toThrow()
    expect(() => parseRandom('')).toThrow()
    expect(parseSeed('42')).toBe(42)
    expect(parseSeed(undefined, () => 9)).toBe(9)
    expect(parseSeed('', () => 9)).toBe(9)
    expect(() => parseSeed('-1')).toThrow(/whole number/)
    expect(() => parseSeed(String(2 ** 32))).toThrow()
    const fresh = parseSeed(undefined)
    expect(Number.isInteger(fresh) && fresh >= 0 && fresh < 2 ** 32).toBe(true)
  })
})
