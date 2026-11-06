// A card comment as its summary (#532): reports and verdicts lead with a one-line summary, and cw_read_task with
// summary: true gives each comment as that line (with the whole comment's length when there is more).
import { describe, expect, it } from 'vitest'
import { COMMENT_SUMMARY_MAX, commentSummary } from '../src/shared/tasks'

describe("a comment's summary line (#532)", () => {
  const c = (text: string) => ({ at: '2026-10-11T00:00:00.000Z', by: 'HR1 (demo)', text })
  it('the first line that is not blank, with the length of the whole when there is more', () => {
    const report = 'Round 1: FAILED: 2 findings: the retry clears the draft; the outcome cache is unbounded.\n\n1. The retry…\n2. The cache…'
    expect(commentSummary(c(report))).toEqual({ at: '2026-10-11T00:00:00.000Z', by: 'HR1 (demo)', text: 'Round 1: FAILED: 2 findings: the retry clears the draft; the outcome cache is unbounded.', length: report.length })
    expect(commentSummary(c('\n\n  Round 2 ready: both findings fixed.  \nDetails…')).text).toBe('Round 2 ready: both findings fixed.')
  })
  it('a one-line comment is itself, with no length; a long first line is cut', () => {
    expect(commentSummary(c('Merged into main in 4d7a16a.'))).toEqual({ ...c('Merged into main in 4d7a16a.') })
    const long = commentSummary(c('x'.repeat(1000)))
    expect(long.text).toHaveLength(COMMENT_SUMMARY_MAX)
    expect(long.text.endsWith('…')).toBe(true)
    expect(long.length).toBe(1000)
    expect(commentSummary(c('')).text).toBe('')
  })
})
