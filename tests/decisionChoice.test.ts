// HI-3356: a decision that picks one of a question's options is recorded with what was chosen (decisionWithChoice):
// the option's text whole when the question lists options as list entries, else the whole question; free text as typed.
import { describe, expect, it } from 'vitest'
import { decisionWithChoice, optionText } from '../src/shared/decisionChoice'

const R = 'CL-309/r9'
const OPTIONS = ['Which way?', 'A (recommended): extend CL-309. Map each headless row', 'to its card.', 'B: submit CL-309 as is, and card the rest.'].join('\n')

describe('decisionWithChoice (HI-3356)', () => {
  it('a letter, (a), a) and a. answers name the option, its continuation lines included, with the request', () => {
    const want = 'A: extend CL-309. Map each headless row\nto its card. (CL-309/r9)'
    for (const a of ['A', 'a', '(a)', '( A )', 'a)', 'A.', 'a:']) expect(decisionWithChoice(a, OPTIONS, R)).toBe(want)
    expect(decisionWithChoice('B', OPTIONS, R)).toBe('B: submit CL-309 as is, and card the rest. (CL-309/r9)')
  })

  it('numbered options, bullets and emphasis', () => {
    const q = 'Pick one:\n1. Keep the old name.\n2. Rename it: settings.json, the docs and the UI.\n'
    expect(decisionWithChoice('2', q, R)).toBe('2: Rename it: settings.json, the docs and the UI. (CL-309/r9)')
    expect(decisionWithChoice('(1)', q, R)).toBe('1: Keep the old name. (CL-309/r9)')
    const md = 'Options:\n- **A** (recommended): ship it.\n- **B:** wait (a day, maybe two).'
    expect(decisionWithChoice('a', md, R)).toBe('A: ship it. (CL-309/r9)')
    expect(decisionWithChoice('B', md, R)).toBe('B: wait (a day, maybe two). (CL-309/r9)')
    const bracketed = '(a) one thing\n(b) another - with a dash'
    expect(decisionWithChoice('b', bracketed, R)).toBe('B: another - with a dash (CL-309/r9)')
  })

  it('free text, even short words, is kept exactly as typed', () => {
    for (const a of ['Yes', 'A, but keep the alias', 'Use SQLite in memory', '100', 'ok']) expect(decisionWithChoice(a, OPTIONS, R)).toBe(a)
  })

  it('a question with no options: the label with the whole question', () => {
    expect(decisionWithChoice('A', 'Should we do A or B?', R)).toBe('A (CL-309/r9: “Should we do A or B?”)')
    expect(decisionWithChoice('2', 'Shall I go with plan 2?', R)).toBe('2 (CL-309/r9: “Shall I go with plan 2?”)')
  })

  it("inline prose is never taken for options: 'A:' and 'B:' inside a line keep the question", () => {
    const q = 'Use A: as the drive, or choose B: for backups?'
    expect(optionText(q, 'A')).toBeNull()
    expect(decisionWithChoice('B', q, R)).toBe(`B (CL-309/r9: “${q}”)`)
  })

  it('duplicate labels, mixed kinds, nesting at different indents, nested numbering or a missing label keep the whole question', () => {
    const cases = [
      'A: one\nB: two\nA: three', // duplicate
      'A: one\n2: two', // mixed letters and numbers
      '- A: one\n  - B: nested\n- C: three', // a nested list item is no peer
      '1.1 first part\n1.2 second part', // 1.1 isn't a top-level marker
      'A: only one option'
    ]
    for (const q of cases) expect(decisionWithChoice('B', q, R)).toBe(`B (CL-309/r9: “${q}”)`)
    expect(decisionWithChoice('C', 'A: one\nB: two', R)).toBe('C (CL-309/r9: “A: one\nB: two”)')
  })

  it('a long option and a long question are kept whole, never cut', () => {
    const long = 'x'.repeat(700) + ' and never drop the last line'
    expect(decisionWithChoice('A', `A: ${long}\nB: no`, R)).toBe(`A: ${long} (CL-309/r9)`)
    const q = `Do this? ${long}`
    expect(decisionWithChoice('a', q, R)).toBe(`a (CL-309/r9: “${q}”)`)
  })

  it('no question text: the label with the request id, never bare', () => {
    expect(decisionWithChoice('A', undefined, R)).toBe('A (CL-309/r9)')
  })
})
