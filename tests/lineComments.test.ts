// HI-3219: line comments on a card's revision diff: the quote and context cut by characters, the fold of their facts (edit
// versions, resolve and reopen, delete), the counts, and a page of rows within its budget.
import { describe, expect, it } from 'vitest'
import { anchorOf, cutLine, foldLineComments, lineCommentCounts, LINE_COMMENT_LIMITS as L, pageOf } from '../src/shared/workflow/lineComments'
import type { Actor, Fact, FactData, FactKind } from '../src/shared/workflow/facts'

let seq = 0
const fact = <K extends FactKind>(kind: K, data: FactData[K], actor: Actor = 'user'): Fact<K> => ({ seq: ++seq, card: 7, kind, at: `2026-11-14T03:00:${String(seq).padStart(2, '0')}Z`, actor, source: 'recorded', data })
const comment = (id: string, over: Partial<FactData['LineComment']> = {}): Fact<'LineComment'> => fact('LineComment', { id, submission: 3, side: 'new', path: 'a.ts', from: 2, to: 3, lines: 'b\nc', before: 'a', after: 'd', body: 'Trim this.', ...over })

describe('a comment’s quote and context (HI-3219)', () => {
  it('quotes the lines with up to two context lines each side', () => {
    expect(anchorOf('a\nb\nc\nd\ne\nf', 3, 4)).toEqual({ lines: 'c\nd', before: 'a\nb', after: 'e\nf' })
    expect(anchorOf('a\r\nb\r\nc', 1, 1)).toEqual({ lines: 'a', before: '', after: 'b\nc' })
    expect(anchorOf('only', 1, 1)).toEqual({ lines: 'only', before: '', after: '' })
  })

  it('a 5 MB single-line minified file: the anchor and its context at most 2,800 characters', () => {
    const big = 'x'.repeat(5 * 1024 * 1024)
    const a = anchorOf(`${big}\n${big}\n${big}`, 2, 2)
    expect(a.lines).toBe(cutLine(big))
    expect(a.lines.length).toBe(L.line)
    expect(a.lines.endsWith('…')).toBe(true)
    expect(a.lines.length + a.before.length + a.after.length).toBeLessThanOrEqual(2800)
  })

  it('a long range keeps its first and last lines, with how many were left out between', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'y'.repeat(60)}`)
    const a = anchorOf(lines.join('\n'), 1, 500)
    expect(a.lines.length).toBeLessThanOrEqual(L.quote)
    const kept = a.lines.split('\n')
    expect(kept[0]).toBe(lines[0])
    expect(kept.at(-1)).toBe(lines[499])
    const gap = kept.find((l) => /^…\d+ lines…$/.test(l))!
    expect(Number(/\d+/.exec(gap)![0])).toBe(500 - (kept.length - 1))
  })
})

describe('the fold of a card’s comments (HI-3219)', () => {
  it('edits raise the version; resolve and reopen; a deleted one is gone; other facts are ignored', () => {
    const facts: Fact[] = [
      comment('lc-HI-1-1'),
      comment('lc-HI-1-2', { side: 'old', path: 'b.ts', from: 5, to: 5 }),
      fact('LineCommentEdited', { id: 'lc-HI-1-1', body: 'Trim the name.', version: 2 }),
      fact('LineCommentResolved', { id: 'lc-HI-1-1' }),
      fact('LineCommentReopened', { id: 'lc-HI-1-1' }),
      fact('LineCommentResolved', { id: 'lc-HI-1-1' }),
      fact('LineCommentDeleted', { id: 'lc-HI-1-2' }),
      fact('LineCommentResolved', { id: 'lc-nosuch' }),
      fact('Gone', { what: 'line' })
    ]
    const views = foldLineComments(facts)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ id: 'lc-HI-1-1', by: 'user', body: 'Trim the name.', version: 2, state: 'resolved', sent: false, side: 'new', from: 2, to: 3 })
    expect(lineCommentCounts(views)).toEqual({ open: 0, sent: 0, resolved: 1 })
  })

  it('an agent’s comment names the agent', () => {
    expect(foldLineComments([comment('lc-HI-1-9')].map((f) => ({ ...f, actor: 'agent:a-1' as Actor })))[0].by).toBe('a-1')
  })
})

describe('a page of rows (HI-3219)', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `lc-${i}`, body: 'z'.repeat(4000) }))

  it('as many rows as fit in the budget, and where the next page starts', () => {
    const first = pageOf(rows, 0)
    expect(JSON.stringify(first.rows).length).toBeLessThanOrEqual(L.page)
    expect(first.rows.length).toBe(5)
    expect(first.next).toBe(5)
    const last = pageOf(rows, 25)
    expect(last.rows.map((r) => r.id)).toEqual(['lc-25', 'lc-26', 'lc-27', 'lc-28', 'lc-29'])
    expect(last.next).toBeUndefined()
  })

  it('always one row, even one over the budget; past the end, none', () => {
    expect(pageOf(rows, 0, 10).rows).toHaveLength(1)
    expect(pageOf(rows, 99).rows).toEqual([])
  })
})
