// Markdown documents by section (#817): headings outside code fences and front matter, GitHub-style unique slugs, each
// section's size with its subsections, CRLF documents, and finding a heading by slug or text (ambiguous or unknown).
import { describe, expect, it } from 'vitest'
import { docOutline, findHeading, headingId, sectionText, slugOf } from '../src/shared/docSections'
import { MAX_ROWS, docOutlineText, docSectionText } from '../src/shared/toolReplies'
import { guideTarget } from '../src/shared/userGuide'

const doc = [
  '---',
  'title: # not a heading',
  '---',
  '# Plan',
  'Intro.',
  '',
  '## Core contracts',
  'The contracts.',
  '```ts',
  '# not a heading either',
  '```',
  '### Errors',
  'Errors here.',
  '## Setup',
  'First setup.',
  '~~~~',
  '## still code',
  '~~~',
  'still code (a shorter fence closes nothing)',
  '~~~~',
  '## Setup',
  'Second setup.',
  '    # indented four: code, not a heading',
  '#hashtag is text',
  '## Closing hashes ##'
].join('\n')

describe('docOutline', () => {
  const outline = docOutline(doc)
  it('finds the headings outside front matter and code fences, with their levels and lines', () => {
    expect(outline.map((h) => `${h.level} ${h.text} ${h.line}`)).toEqual(['1 Plan 4', '2 Core contracts 7', '3 Errors 12', '2 Setup 14', '2 Setup 21', '2 Closing hashes 25'])
  })
  it('gives each a unique slug, numbering duplicates as GitHub does', () => {
    expect(outline.map((h) => h.slug)).toEqual(['plan', 'core-contracts', 'errors', 'setup', 'setup-1', 'closing-hashes'])
    const twice = docOutline('# A\n# A-1\n# A\n# A')
    expect(twice.map((h) => h.slug)).toEqual(['a', 'a-1', 'a-2', 'a-3'])
  })
  it("sizes each section with its subsections, up to the next heading of its level or higher", () => {
    const lines = doc.split('\n')
    const chars = (from: number, to: number) => lines.slice(from - 1, to - 1).reduce((n, l) => n + l.length + 1, 0)
    expect(outline.find((h) => h.slug === 'core-contracts')!.size).toBe(chars(7, 14))
    expect(outline.find((h) => h.slug === 'errors')!.size).toBe(chars(12, 14))
    // The level-1 heading runs to the end (the last line has no ending).
    expect(outline[0].size).toBe(doc.length - lines.slice(0, 3).join('\n').length - 1)
  })
  it('reads CRLF documents the same, sizes counting each line ending once', () => {
    const crlf = docOutline(doc.replace(/\n/g, '\r\n'))
    expect(crlf).toEqual(outline)
  })
  it('a lone --- that never closes is no front matter', () => {
    expect(docOutline('---\n# Title').map((h) => h.text)).toEqual(['Title'])
  })
})

describe('slugs', () => {
  it("are the heading's words in lower case, punctuation dropped, spaces hyphens", () => {
    expect(slugOf('Core contracts: the `API` (v2)!')).toBe('core-contracts-the-api-v2')
    expect(slugOf('[Linked](https://x.y) *heading* _here_')).toBe('linked-heading-here')
    expect(slugOf('Größe & Über')).toBe('größe--über')
    expect(slugOf('snake_case stays')).toBe('snake_case-stays')
  })
})

describe('findHeading and sectionText', () => {
  const outline = docOutline(doc)
  it('by slug or by text (any case, with or without #), the section with its subsections', () => {
    for (const asked of ['core-contracts', 'Core contracts', '## core CONTRACTS']) {
      const m = findHeading(outline, asked)
      expect('heading' in m && m.heading.slug).toBe('core-contracts')
    }
    const m = findHeading(outline, 'core-contracts')
    if (!('heading' in m)) throw new Error('not found')
    expect(sectionText(doc, m.heading)).toBe(['## Core contracts', 'The contracts.', '```ts', '# not a heading either', '```', '### Errors', 'Errors here.'].join('\n'))
  })
  it('a heading two sections share is ambiguous by its text, listing both with their slugs', () => {
    for (const asked of ['Setup', 'setup', '## Setup']) {
      const m = findHeading(outline, asked)
      expect('ambiguous' in m && m.ambiguous.map((h) => h.slug)).toEqual(['setup', 'setup-1'])
    }
  })
  it('every slug the outline lists reads its own section as #<slug>, the first of two the same too', () => {
    const read = (asked: string): string => {
      const m = findHeading(outline, asked)
      if (!('heading' in m)) throw new Error(`${asked}: ${JSON.stringify(m)}`)
      return sectionText(doc, m.heading)
    }
    for (const h of outline) expect(read(`#${h.slug}`).split('\n')[0]).toBe(doc.split('\n')[h.line - 1])
    expect(read('#setup')).toBe(['## Setup', 'First setup.', '~~~~', '## still code', '~~~', 'still code (a shorter fence closes nothing)', '~~~~'].join('\n'))
    expect(read('#setup-1')).toBe(['## Setup', 'Second setup.', '    # indented four: code, not a heading', '#hashtag is text'].join('\n'))
    // A numbered slug asked for without # is one heading too.
    expect(read('setup-1')).toBe(read('#setup-1'))
    // #<slug> that isn't one: the closest.
    const m = findHeading(outline, '#setup-9')
    expect('closest' in m && m.closest.length).toBeGreaterThan(0)
  })
  it('different texts whose slugs collide are told apart by text, and each by #<slug>', () => {
    const md = '# C++\n\nPlus.\n\n# C\n\nPlain.\n'
    const o = docOutline(md)
    expect(o.map((h) => h.slug)).toEqual(['c', 'c-1'])
    const pick = (asked: string): string => {
      const m = findHeading(o, asked)
      return 'heading' in m ? m.heading.text : JSON.stringify(m)
    }
    expect([pick('C++'), pick('C'), pick('#c'), pick('#c-1'), pick('c-1')]).toEqual(['C++', 'C', 'C++', 'C', 'C'])
  })
  it("a heading's explicit id (#1535) is its slug whatever its text, kept through a rename, and never another's", () => {
    const md = '# Plan\n\n## Version Control <a id="git"></a>\n\nText.\n\n## Git\n\nOther.\n\n## Setup <a id="setup"></a>\n'
    const o = docOutline(md)
    expect(o.map((h) => [h.text, h.slug, !!h.fixed])).toEqual([['Plan', 'plan', false], ['Version Control', 'git', true], ['Git', 'git-1', false], ['Setup', 'setup', true]])
    const renamed = docOutline(md.replace('## Version Control', '## Source control'))
    const m = findHeading(renamed, '#git')
    expect('heading' in m && m.heading.text).toBe('Source control')
    expect('heading' in m && sectionText(md.replace('## Version Control', '## Source control'), m.heading)).toBe('## Source control <a id="git"></a>\n\nText.')
    expect(headingId('Setup <a id="setup"></a>')).toBe('setup')
    expect(headingId('Setup')).toBeNull()
  })
  it('an explicit id two headings carry (a section copied with its anchor) fixes neither: #id is ambiguous, each section its own', () => {
    const md = '# Doc\n\n## First <a id="setup"></a>\n\nOne.\n\n## Second <a id="setup"></a>\n\nTwo.\n\n## Setup\n\nThree.\n'
    const o = docOutline(md)
    expect(o.map((h) => [h.text, h.slug, !!h.fixed, h.sharedId])).toEqual([['Doc', 'doc', false, undefined], ['First', 'setup', false, 'setup'], ['Second', 'setup-1', false, 'setup'], ['Setup', 'setup-2', false, undefined]])
    const m = findHeading(o, '#setup')
    expect('ambiguous' in m && m.ambiguous.map((h) => h.text)).toEqual(['First', 'Second'])
    // As a bare slug too, any case (hive_read_section's heading: setup), after the heading text ("Setup" is a heading's).
    expect(findHeading(o, '#SETUP')).toEqual(m)
    const noText = docOutline(md.replace('## Setup\n\nThree.\n', ''))
    for (const asked of ['setup', 'SETUP', '#setup', '#Setup']) {
      const bare = findHeading(noText, asked)
      expect('ambiguous' in bare && bare.ambiguous.map((h) => h.text), asked).toEqual(['First', 'Second'])
    }
    const byText = findHeading(o, 'setup')
    expect('heading' in byText && byText.heading.text).toBe('Setup')
    // Each section is its own, found by its line, never the first with a slug.
    expect(sectionText(md, o[1])).toBe('## First <a id="setup"></a>\n\nOne.')
    expect(sectionText(md, o[2])).toBe('## Second <a id="setup"></a>\n\nTwo.')
    const second = findHeading(o, '#setup-1')
    expect('heading' in second && second.heading.text).toBe('Second')
  })
  it('an unknown heading gives the closest ones, never an empty section', () => {
    const m = findHeading(outline, 'core contract')
    expect('closest' in m && m.closest[0].slug).toBe('core-contracts')
    const far = findHeading(outline, 'nothing like it at all')
    expect('closest' in far && far.closest.length).toBe(5)
    expect(findHeading([], 'x')).toEqual({ closest: [] })
  })
})

describe('every way of naming a heading decides ambiguity alike (#1535)', () => {
  // Unique id "git" (renamed text), shared id "setup" (two headings), shared id "dup" that is also a heading's text.
  const md = [
    '# Doc',
    '## Version Control <a id="git"></a>',
    'Git.',
    '## First <a id="setup"></a>',
    'One.',
    '## Second <a id="setup"></a>',
    'Two.',
    '## Third <a id="dup"></a>',
    'Three.',
    '## Fourth <a id="dup"></a>',
    'Four.',
    '## Dup',
    'Text.',
    ''
  ].join('\n')
  const o = docOutline(md)
  const what = (asked: string): string => {
    const m = findHeading(o, asked)
    return 'heading' in m ? m.heading.text : 'ambiguous' in m ? `ambiguous: ${m.ambiguous.map((h) => h.text).join(', ')}` : 'missing'
  }
  const cases: [string, string][] = [
    ['#git', 'Version Control'],
    ['#GIT', 'Version Control'],
    ['git', 'Version Control'],
    ['GIT', 'Version Control'],
    ['Version Control', 'Version Control'],
    ['#setup', 'ambiguous: First, Second'],
    ['#SETUP', 'ambiguous: First, Second'],
    ['setup', 'ambiguous: First, Second'],
    ['SETUP', 'ambiguous: First, Second'],
    ['#setup-1', 'Second'],
    ['First', 'First'],
    // Heading text first, as documented: "Dup" is a heading's; #dup is the id.
    ['dup', 'Dup'],
    ['#dup', 'ambiguous: Third, Fourth'],
    ['#nothing', 'missing'],
    ['nothing', 'missing']
  ]
  it.each(cases)('findHeading(%s): %s', (asked, expected) => expect(what(asked)).toBe(expected))

  it("the Docs view's Learn more goes only to a heading one id names, by the same resolver", () => {
    expect(guideTarget(md, 'git')).toBe('git')
    expect(guideTarget(md, 'GIT')).toBe('git')
    expect(guideTarget(md, 'setup')).toBeNull()
    expect(guideTarget(md, 'dup')).toBeNull()
    expect(guideTarget(md, 'nothing')).toBeNull()
  })
})

describe("the hive tools' replies", () => {
  const outline = { path: 'docs/PLAN.md', size: 12_345, headings: docOutline(doc) }
  it('an outline: a heading a line, indented by level, with its slug and size', () => {
    const text = docOutlineText(outline)
    expect(text.split('\n')[0]).toBe('docs/PLAN.md: 6 headings, 12k characters. [slug] and size per section (subsections included):')
    expect(text).toContain('\n  ## Core contracts [core-contracts] ')
    expect(text).toContain('\n    ### Errors [errors] ')
    expect(text.endsWith('hive_read_section reads one as #<slug>.')).toBe(true)
    // depth: only the levels down to it.
    expect(docOutlineText(outline, 1)).not.toContain('Core contracts')
    expect(docOutlineText({ path: 'x.md', size: 40, headings: [] })).toBe('x.md (40 characters) has no headings: read it whole.')
  })
  it('a long outline stops at MAX_ROWS, saying how to list fewer', () => {
    const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ level: 2, text: `S${i}`, slug: `s${i}`, size: 10 }))
    expect(docOutlineText({ path: 'big.md', size: 99_999, headings: many })).toContain('\n… 5 more: depth=1 lists fewer.')
  })
  it('a section: where it is, then its text; a long one its subsections', () => {
    const h = outline.headings[1]
    expect(docSectionText({ path: 'docs/PLAN.md', heading: h, content: 'TEXT' })).toBe(`docs/PLAN.md#core-contracts (${h.size} characters)\n\nTEXT`)
    const partial = docSectionText({ path: 'docs/PLAN.md', heading: h, content: 'INTRO', subsections: [outline.headings[2]], partial: true })
    expect(partial).toContain('\n\nINTRO\n\n    ### Errors [errors] ')
    expect(partial.endsWith('or this whole section with full=true.')).toBe(true)
  })
})
