// The Review skipped mark's words (#1625, #1636): whether there is a note is its own select key, so a note is always
// shown as written, even one that reads like a select key ("none", "other"), and no note says so.
import { describe, expect, it } from 'vitest'
import { tr } from '../src/shared/i18n'
import { reviewSkipTip } from '../src/renderer/src/components/reviewSkipTip'

describe("the Review skipped mark's tooltip (#1636)", () => {
  it('says who set it and their note as written, whatever the note reads', () => {
    expect(reviewSkipTip({ by: 'user', reason: '' }, tr)).toBe('Review skipped, set by you.')
    expect(reviewSkipTip({ by: 'user', reason: 'none' }, tr)).toBe('Review skipped, set by you: none')
    expect(reviewSkipTip({ by: 'user', reason: 'other' }, tr)).toBe('Review skipped, set by you: other')
    expect(reviewSkipTip({ by: 'user', reason: 'An installer build' }, tr)).toBe('Review skipped, set by you: An installer build')
    expect(reviewSkipTip({ by: 'assistant', reason: 'none' }, tr)).toBe('Review skipped, set by the Assistant: none')
  })
})
