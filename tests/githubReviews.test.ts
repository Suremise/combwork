// HI-3559: the pure parts of Feedback to GitHub: a card's reviews folded from its facts (a draft, its posting and what
// came of it; a review the user wrote; a draft discarded), a file's hunks from git's headers and whether a comment's lines
// sit in one (where GitHub takes it inline), and the body as posted: the text, the comments listed, an agent's footer.
import { describe, expect, it } from 'vitest'
import { foldGithubReviews, githubFooter, inHunks, inlineOf, listedComments, parseHunks, reviewBody } from '../src/shared/githubReviews'

const at = '2026-11-24T12:00:00.000Z'
const f = (seq: number, kind: string, data: unknown) => ({ seq, kind, at, data })

describe('Feedback to GitHub’s reviews (HI-3559)', () => {
  it('folds a draft through its postings, the user’s own review, and a discarded draft', () => {
    const rows = foldGithubReviews([
      f(1, 'GithubReviewDrafted', { verdict: 0, submission: 5, revision: 'abc', reviewer: 'R1', body: 'Finding 1', auto: true }),
      f(2, 'GithubReviewPosting', { draft: 1, by: 'combwork', submission: 5 }),
      f(3, 'GithubReviewFailed', { posting: 2, error: 'gh auth login' }),
      f(4, 'GithubReviewPosting', { draft: 1, by: 'user', submission: 5 }),
      f(5, 'GithubReviewPosted', { posting: 4, url: 'u', body: 'Finding 1', comments: ['lc-1'], inline: 1, listed: 0 }),
      f(6, 'GithubReviewPosting', { draft: null, by: 'user', submission: 5 }),
      f(7, 'GithubReviewDrafted', { verdict: 0, submission: 6, revision: 'def', reviewer: 'R2', body: 'Second', auto: false }),
      f(8, 'GithubReviewDiscarded', { draft: 7 })
    ])
    expect(rows.map((r) => [r.id, r.state, r.posting?.by ?? null])).toEqual([
      [1, 'posted', 'user'],
      [6, 'posting', 'user'],
      [7, 'discarded', null]
    ])
    expect(rows[0].posted).toEqual({ url: 'u', body: 'Finding 1', comments: ['lc-1'], inline: 1, listed: 0, at })
    expect(rows[0].error).toBeUndefined()
  })

  it('reads hunks from git’s headers and places a comment only inside one, on its side', () => {
    const hunks = parseHunks('diff --git a/x b/x\n@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -20 +21,0 @@\n-e\n')
    expect(hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 0 }
    ])
    expect(inHunks(hunks, 'new', 2, 4)).toBe(true)
    expect(inHunks(hunks, 'new', 4, 5)).toBe(false)
    expect(inHunks(hunks, 'new', 21, 21)).toBe(false)
    expect(inHunks(hunks, 'old', 20, 20)).toBe(true)
    expect(inlineOf({ path: 'x', side: 'old', from: 20, to: 20, body: 'b' })).toEqual({ path: 'x', body: 'b', line: 20, side: 'LEFT' })
  })

  it('posts the text, the comments listed and an agent’s footer, each apart', () => {
    const listed = listedComments([{ path: 'a.ts', side: 'new', from: 3, to: 5, body: 'Why\nthis?' }])
    expect(listed).toBe('**Line comments**\n- `a.ts`, lines 3–5: Why this?')
    expect(reviewBody(' Verdict ', listed, githubFooter('GPT-6 Luna'))).toBe('Verdict\n\n**Line comments**\n- `a.ts`, lines 3–5: Why this?\n\n---\n_Drafted by GPT-6 Luna in Combwork_')
    expect(reviewBody('Mine', '', null)).toBe('Mine')
  })
})
