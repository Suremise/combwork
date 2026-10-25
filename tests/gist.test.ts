// A short plain-text form of Markdown (#1635), for the For you chip's tooltip: an agent's question's marks taken out and
// its first sentence or two kept, never a wall of `**`, backticks and run-together lists.
import { describe, expect, it } from 'vitest'
import { gist, plainMarkdown } from '../src/shared/gist'

describe('plainMarkdown', () => {
  it('takes out the marks and runs the text into one line', () => {
    const md = '## Which way?\n\n**Agent side:** keep `hive_submit` as it is.\n\n1. Wrap the line\n2. Or cut it with _an ellipsis_\n\n> quoted [the spec](docs/SPEC.md)\n\n---\n'
    expect(plainMarkdown(md)).toBe('Which way? Agent side: keep hive_submit as it is. Wrap the line Or cut it with an ellipsis quoted the spec')
  })
  it('leaves out a fenced block, closed or not', () => {
    expect(plainMarkdown('Run this:\n\n```sh\nnpm test\n```\nthen tell me.')).toBe('Run this: then tell me.')
    expect(plainMarkdown('Run this:\n```\nnpm test')).toBe('Run this:')
  })
  it("keeps a code span's text as written: file names, globs and patterns aren't read as Markdown (HR4's round 1)", () => {
    expect(gist('Should I keep `__init__.py`?')).toBe('Should I keep __init__.py?')
    expect(gist('Should we remove `__pycache__`?')).toBe('Should we remove __pycache__?')
    expect(plainMarkdown('Match `**/*.ts` and `**/*.tsx`, or only `src/*_test_*.ts`?')).toBe('Match **/*.ts and **/*.tsx, or only src/*_test_*.ts?')
    expect(plainMarkdown('Is ``a `tick` inside`` fine, and `[x](y)` too?')).toBe('Is a `tick` inside fine, and [x](y) too?')
    expect(plainMarkdown('**Keep** `__init__.py` _here_?')).toBe('Keep __init__.py here?')
  })
  it('keeps words with underscores and stars between them', () => {
    expect(plainMarkdown('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
  })
})

describe('gist', () => {
  it('keeps a short text whole', () => {
    expect(gist('OK to push the **release** tag?')).toBe('OK to push the release tag?')
  })
  it('keeps the first sentences that fit', () => {
    const long = `Should the status line wrap or be cut? The chip already ellipsises. ${'More detail follows here. '.repeat(20)}`
    expect(gist(long, 100)).toBe('Should the status line wrap or be cut? The chip already ellipsises.')
  })
  it('cuts a first sentence too long at a word, with an ellipsis', () => {
    const g = gist(`${'word '.repeat(60)}end.`, 50)
    expect(g.length).toBeLessThanOrEqual(50)
    expect(g).toMatch(/^word( word)*…$/)
  })
})
