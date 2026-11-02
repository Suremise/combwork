// Cards in the window by key (#1221): the one label wherever a card is named (cardLabel: its key, #N for a card with
// none), and the board's search by key (AM-12, am-12, AM- for a project's cards, an old key; a key form no project has
// is searched as words).
import { describe, expect, it } from 'vitest'
import { cardLabel, nameWithKey } from '../src/shared/projectKeys'
import { cardMatches } from '../src/shared/tasks'

const card = (number: number, key: string | undefined, title = 'A card') => ({ number, ...(key ? { key } : {}), title, description: '', project: 'alpha', agentName: undefined, labels: [] as string[] })
const keys = [
  { key: 'AM', aliases: ['AL'] },
  { key: 'HI', aliases: [] }
]

describe('cardLabel: a card as the window names it', () => {
  it('its key, else #N', () => {
    expect(cardLabel({ number: 40, key: 'HI-12' })).toBe('HI-12')
    expect(nameWithKey(40, 'HI-12')).toBe('HI-12')
    expect(nameWithKey(40, null)).toBe('#40')
    expect(cardLabel({ number: 40 })).toBe('#40')
    expect(cardLabel({ number: 40, key: '' })).toBe('#40')
  })
})

describe("the board's search by key", () => {
  const am12 = card(40, 'AM-12')
  const am3 = card(7, 'AM-3', 'Re-run the tests')
  const hi12 = card(41, 'HI-12')
  const ws = card(5, undefined)
  const find = (q: string) => [am12, am3, hi12, ws].filter((c) => cardMatches(c, q, keys)).map((c) => cardLabel(c))

  it('a key in any case, a project\'s key with no number, and an old key', () => {
    expect(find('AM-12')).toEqual(['AM-12'])
    expect(find('am-12')).toEqual(['AM-12'])
    expect(find('AM-')).toEqual(['AM-12', 'AM-3'])
    expect(find('al-3')).toEqual(['AM-3'])
    expect(find('AL-')).toEqual(['AM-12', 'AM-3'])
    expect(find('AM-99')).toEqual([])
  })

  it('#N is the old number; a key form no project has is words', () => {
    expect(find('#5')).toEqual(['#5'])
    expect(find('#40')).toEqual(['AM-12'])
    expect(find('re-')).toEqual(['AM-3'])
    expect(find('ZZ-1')).toEqual([])
  })

  it("a bare number is a key's digits, in every project, never the workspace number (HI-1661)", () => {
    // HI-1660 is #1662: searching 1662 found HI-1660, not the card someone named 1662.
    expect(find('12')).toEqual(['AM-12', 'HI-12'])
    expect(find('012')).toEqual(['AM-12', 'HI-12'])
    expect(find('3')).toEqual(['AM-3'])
    expect(find('40')).toEqual([])
    expect(find('41')).toEqual([])
    // A card with no key is named by its number, and found by it.
    expect(find('5')).toEqual(['#5'])
  })

  it('a moved card by the name it kept in the project it left (round 1, finding 1)', () => {
    // AM-12 was HI-3 before it moved to amberlight.
    const moved = { 'HI-3': 40 }
    expect([am12, am3, hi12, ws].filter((c) => cardMatches(c, 'hi-3', keys, moved)).map((c) => cardLabel(c))).toEqual(['AM-12'])
    expect([am12, am3, hi12, ws].filter((c) => cardMatches(c, 'HI-', keys, moved)).map((c) => cardLabel(c))).toEqual(['HI-12'])
  })

  it('without the projects\' keys (main), a card\'s own key still matches', () => {
    expect([am12, am3, hi12].filter((c) => cardMatches(c, 'HI-12')).map((c) => c.number)).toEqual([41])
    expect([am12, am3, hi12].filter((c) => cardMatches(c, 'am-')).map((c) => c.number)).toEqual([40, 7])
  })
})
