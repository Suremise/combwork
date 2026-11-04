import { describe, expect, it } from 'vitest'
import { findPaths, joinPath, pathCandidates, resolveLink, type LinkRoot, type PathMatch } from '../src/shared/fileLinks'

/** findPaths() as [linked text, path, line, col], with `files` the paths that are files (default: any without a space). */
const linked = (text: string, files?: string[]) =>
  findPaths(text, (m: PathMatch) => (files ? files.includes(m.path) : !m.path.includes(' '))).map((m) => [text.slice(m.start, m.end), m.path, m.line, m.col])

describe('file links: paths in terminal output', () => {
  it('relative paths with either slash, and names with an extension', () => {
    expect(linked('● Update(src/main/sessions.ts)')).toEqual([['src/main/sessions.ts', 'src/main/sessions.ts', undefined, undefined]])
    expect(linked('Edited src\\renderer\\App.tsx and package.json.')).toEqual([
      ['src\\renderer\\App.tsx', 'src\\renderer\\App.tsx', undefined, undefined],
      ['package.json', 'package.json', undefined, undefined]
    ])
    expect(linked('see ./docs/SPEC.md, ../other/x.md')).toEqual([
      ['./docs/SPEC.md', './docs/SPEC.md', undefined, undefined],
      ['../other/x.md', '../other/x.md', undefined, undefined]
    ])
  })

  it('the line and column in the usual forms', () => {
    expect(linked('FAIL tests/x.test.ts:42:7')).toEqual([['tests/x.test.ts:42:7', 'tests/x.test.ts', 42, 7]])
    expect(linked('at foo (src/a.ts:12)')).toEqual([['src/a.ts:12', 'src/a.ts', 12, undefined]])
    expect(linked('src/a.cs(10,5): error CS1002')).toEqual([['src/a.cs(10,5)', 'src/a.cs', 10, 5]])
    expect(linked('  File "tools/run.py", line 8, in main')).toEqual([['tools/run.py", line 8', 'tools/run.py', 8, undefined]])
    expect(linked('D:\\work\\app\\src\\a.ts:3')).toEqual([['D:\\work\\app\\src\\a.ts:3', 'D:\\work\\app\\src\\a.ts', 3, undefined]])
  })

  it('not words, numbers, URLs or bare dots', () => {
    expect(linked('version 1.2.3 is out')).toEqual([])
    expect(linked('Thinking... done.')).toEqual([])
    expect(linked('https://github.com/x/y/blob/main/a.ts')).toEqual([])
    expect(linked('plain words only')).toEqual([])
  })

  it('brackets and braces in names, and brackets around a path', () => {
    expect(linked('app/[slug]/page.tsx:12', ['app/[slug]/page.tsx'])).toEqual([['app/[slug]/page.tsx:12', 'app/[slug]/page.tsx', 12, undefined]])
    expect(linked('routes/{id}.ts and #1/notes.md')).toEqual([
      ['routes/{id}.ts', 'routes/{id}.ts', undefined, undefined],
      ['#1/notes.md', '#1/notes.md', undefined, undefined]
    ])
    expect(linked('[src/a.ts]', ['src/a.ts'])).toEqual([['src/a.ts', 'src/a.ts', undefined, undefined]])
    expect(linked('[src/a.ts:4]', ['src/a.ts'])).toEqual([['src/a.ts:4', 'src/a.ts', 4, undefined]])
  })
})

describe('file links: quoted references', () => {
  // Every name, quote and way of writing a location: a quoted reference is one link to its whole name when that is
  // a file, and none when it isn't, even when pieces of it are files ("file.ts" in "missing file.ts").
  const names = ['notes.ts', 'my notes.ts', 'src/a.ts', 'my docs/my notes.ts', 'C:\\My Work\\a.md']
  const after: [string, (q: string) => string, number | undefined, number | undefined][] = [
    ['no location', (q) => q, undefined, undefined],
    [':line after', (q) => `${q}:12`, 12, undefined],
    [':line:col after', (q) => `${q}:12:3`, 12, 3],
    ['(line,col) after', (q) => `${q}(12,3)`, 12, 3],
    ['", line N" after', (q) => `${q}, line 12`, 12, undefined]
  ]
  const inside: [string, string, number, number | undefined][] = [
    [':line inside', ':12', 12, undefined],
    [':line:col inside', ':12:3', 12, 3],
    ['(line,col) inside', '(12,3)', 12, 3]
  ]
  /** Every piece of a name between spaces and slashes, except the name itself. */
  const pieces = (name: string): string[] => {
    const seps = [...name.matchAll(/[ \\/]/g)].map((m) => m.index)
    const starts = [0, ...seps.map((i) => i + 1)]
    const ends = [...seps, name.length]
    return starts.flatMap((a) => ends.filter((b) => b > a).map((b) => name.slice(a, b))).filter((p) => p !== name)
  }

  const cases: { name: string; how: string; text: string; line?: number; col?: number }[] = []
  for (const name of names)
    for (const q of ['"', "'", '`']) {
      for (const [how, write, line, col] of after) cases.push({ name, how: `${q} ${how}`, text: `open ${write(q + name + q)} now`, line, col })
      for (const [how, loc, line, col] of inside) cases.push({ name, how: `${q} ${how}`, text: `open ${q}${name}${loc}${q} now`, line, col })
    }

  it.each(cases)('$name, $how: one link when it is a file', ({ name, text, line, col }) => {
    expect(linked(text, [name, ...pieces(name)]).map(([, path, l, c]) => [path, l, c])).toEqual([[name, line, col]])
  })

  it.each(cases)('$name, $how: no link when it is not, whatever its pieces are', ({ name, text }) => {
    expect(linked(text, pieces(name))).toEqual([])
    // Nor are its pieces looked up: the only candidate is the whole name.
    expect(pathCandidates(text).map((m) => m.path)).toEqual([name])
  })

  it('quoted text is one reference: a path inside a quoted sentence is not a link of its own', () => {
    expect(linked('commit "Fix src/a.ts"', ['src/a.ts'])).toEqual([])
  })

  it("an apostrophe isn't a quote", () => {
    expect(linked("the project's src/a.ts isn't", ['src/a.ts'])).toEqual([['src/a.ts', 'src/a.ts', undefined, undefined]])
  })
})

describe('file links: unquoted paths with spaces', () => {
  it('the longest beginning of a run of words that is a file', () => {
    expect(linked('C:/ws/my app/src/app.ts:12 failed', ['C:/ws/my app/src/app.ts'])).toEqual([['C:/ws/my app/src/app.ts:12', 'C:/ws/my app/src/app.ts', 12, undefined]])
    expect(linked('Edited src/my file.ts', ['src/my file.ts', 'file.ts'])).toEqual([['src/my file.ts', 'src/my file.ts', undefined, undefined]])
    // A space in the first folder's name: the word before it joins in.
    expect(linked('then my docs/my notes.ts:6', ['my docs/my notes.ts'])).toEqual([['my docs/my notes.ts:6', 'my docs/my notes.ts', 6, undefined]])
    expect(linked('FAIL tests/x.test.ts:42', ['tests/x.test.ts'])).toEqual([['tests/x.test.ts:42', 'tests/x.test.ts', 42, undefined]])
  })

  it('an absolute path that is not a file as a whole links none of its pieces', () => {
    expect(linked('C:/ws/my app/src/app.ts:12', ['app/src/app.ts'])).toEqual([])
  })

  it('a folder and then a file are two things', () => {
    expect(linked('Updated src/components and README.md', ['README.md'])).toEqual([['README.md', 'README.md', undefined, undefined]])
  })

  it('the candidates include every reading, for the caller to look up', () => {
    const all = pathCandidates('C:/ws/my app/src/app.ts:12').map((m) => m.path)
    expect(all).toEqual(expect.arrayContaining(['C:/ws/my app/src/app.ts', 'C:/ws/my', 'app/src/app.ts']))
  })
})

describe('file links: where a path leads', () => {
  const roots: LinkRoot[] = [
    { path: 'C:\\ws\\hive', project: 'C:\\ws\\hive', agentId: null },
    { path: 'C:\\ws\\web', project: 'C:\\ws\\web', agentId: null },
    { path: 'C:\\ws\\hive\\.combwork\\worktrees\\two', project: 'C:\\ws\\hive', agentId: 'two' }
  ]

  it('joins and normalises', () => {
    expect(joinPath('C:\\ws\\hive', './src/../docs/x.md')).toBe('C:\\ws\\hive\\docs\\x.md')
    expect(joinPath('C:\\ws\\hive', 'D:/other/x.md')).toBe('D:\\other\\x.md')
  })

  it("an agent's relative path: its own folder", () => {
    expect(resolveLink('src/a.ts', 'C:\\ws\\hive', roots)).toEqual({ project: 'C:\\ws\\hive', agentId: null, root: 'C:\\ws\\hive', rel: 'src/a.ts' })
    expect(resolveLink('src\\a.ts', 'C:\\ws\\hive\\.combwork\\worktrees\\two', roots)).toEqual({ project: 'C:\\ws\\hive', agentId: 'two', root: 'C:\\ws\\hive\\.combwork\\worktrees\\two', rel: 'src/a.ts' })
  })

  it('another workspace project, and the Assistant (from the workspace)', () => {
    expect(resolveLink('..\\web\\index.html', 'C:\\ws\\hive', roots)?.project).toBe('C:\\ws\\web')
    expect(resolveLink('c:\\WS\\web\\index.html', 'C:\\ws\\hive', roots)?.rel).toBe('index.html')
    expect(resolveLink('hive/docs/SPEC.md', 'C:\\ws', roots)).toMatchObject({ project: 'C:\\ws\\hive', rel: 'docs/SPEC.md' })
  })

  it('nothing outside the projects, or in .git', () => {
    expect(resolveLink('C:\\Users\\me\\.claude\\settings.json', 'C:\\ws\\hive', roots)).toBeNull()
    expect(resolveLink('../notes.md', 'C:\\ws\\hive', roots)).toBeNull()
    expect(resolveLink('.git/config', 'C:\\ws\\hive', roots)).toBeNull()
  })
})
