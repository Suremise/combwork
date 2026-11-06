import { describe, expect, it } from 'vitest'
import { findCardRefs } from '../src/shared/cardLinks'

/** findCardRefs() as [linked text, number], with `cards` the numbers on the board (default: 1 to 999). */
const linked = (text: string, cards?: number[]) => findCardRefs(text, (n) => (cards ? cards.includes(n) : n < 1000)).map((m) => [text.slice(m.start, m.end), m.number])

describe('card links: card numbers in terminal output (#440)', () => {
  it('#n alone and in punctuation', () => {
    expect(linked('#12')).toEqual([['#12', 12]])
    expect(linked('#383 is back On Hold')).toEqual([['#383', 383]])
    expect(linked('done (#12), then #13, #14. And #15: #16; "#17" [#18]')).toEqual([
      ['#12', 12],
      ['#13', 13],
      ['#14', 14],
      ['#15', 15],
      ['#16', 16],
      ['#17', 17],
      ['#18', 18]
    ])
    expect(linked('#12-#13 and #12–#13')).toEqual([
      ['#12', 12],
      ['#13', 13],
      ['#12', 12],
      ['#13', 13]
    ])
    expect(linked('Waiting for #12 #13 → Review')).toEqual([
      ['#12', 12],
      ['#13', 13]
    ])
  })

  it('the place in the line, for the terminal columns', () => {
    expect(findCardRefs('see (#7).', () => true)).toEqual([{ start: 5, end: 7, number: 7 }])
  })

  it('not hex, a commit, a version or a leading zero', () => {
    expect(linked('color: #fff; #12ab34 #1a #12abc')).toEqual([])
    expect(linked('#12.5 and #3_x and #012')).toEqual([])
    expect(linked('#1234567 (seven digits) but not #12345678', [1234567, 12345678])).toEqual([['#1234567', 1234567]])
  })

  it('not inside a longer word, path, entity or URL', () => {
    expect(linked('abc#12 é#12 9#12 x_#12 ##12 a/#12 a\\#12 v.#12 &#12;')).toEqual([])
    expect(linked('https://github.com/x/y/issues/12#12 and www.example.com/#12 then #12')).toEqual([['#12', 12]])
    expect(linked('see http://x/#5, (#6)')).toEqual([['#6', 6]])
  })

  it('only the numbers on the board', () => {
    expect(linked('#12 and #5000 and #3', [3, 12])).toEqual([
      ['#12', 12],
      ['#3', 3]
    ])
    expect(linked('#12', [])).toEqual([])
    expect(linked('no hash here', [1])).toEqual([])
  })
})

describe('card links: card keys in terminal output (#1221)', () => {
  // The board: HI-12 is #40, AM-3 is #7; an old key HX of that project finds HI's cards.
  const keys: Record<string, number> = { 'HI-12': 40, 'AM-3': 7, 'HX-12': 40 }
  const keyed = (text: string) => findCardRefs(text, (n) => n === 40, (k) => keys[k] ?? null).map((m) => [text.slice(m.start, m.end), m.number])

  it('a key alone, in punctuation, and beside its number, in order', () => {
    expect(keyed('HI-12')).toEqual([['HI-12', 40]])
    expect(keyed('done (AM-3), then HI-12.')).toEqual([
      ['AM-3', 7],
      ['HI-12', 40]
    ])
    expect(keyed('HI-12 (#40) passed review')).toEqual([
      ['HI-12', 40],
      ['#40', 40]
    ])
    expect(keyed('an old key: HX-12')).toEqual([['HX-12', 40]])
  })

  it('only keys the board has a card for, in capitals, not inside a word, path, version or URL', () => {
    expect(keyed('ZZ-1 UTF-8 re-12 hi-12 Hi-12')).toEqual([])
    expect(keyed('XHI-12 a/HI-12 HI-12.5 HI-12x HI-012 v.HI-12')).toEqual([])
    expect(keyed('https://x/y/HI-12 then HI-12')).toEqual([['HI-12', 40]])
  })
})
