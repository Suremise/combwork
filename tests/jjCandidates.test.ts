// jj's merge-queue candidates' pure parts (HI-2797's J4): the operation-delta validator (only this attempt's commits, its
// marker, its parent; bookmarks, tags and workspaces unchanged; Git's refs unchanged but for jj's keep refs of exactly its
// commits), the guarded abandon's revset, and the parsers of refs, conflicted files and operations. The real jj's
// behaviour is jjCandidatesReal.test.ts'.
import { describe, expect, it } from 'vitest'
import { deltaProblem, guardedSet, parseConflicted, parseOpLine, parseRefs, pinPrefix, rootFile } from '../src/main/platform/jjCandidates'

const op = (c: string): string => c.repeat(128)
const id = (c: string): string => c.repeat(40)
const SEP = '\u001f'

describe("an operation's delta", () => {
  const side = (refs: [string, string][] = []) => ({ bookmarks: ['main\u001f\u001ffalse\u001fx'], tags: [], workspaces: ['default\u001fw'], refs: new Map(refs) })
  const base = {
    entry: { id: op('b'), parents: [op('a')], args: 'args: jj abandon --config=combwork.txn="t123456"' },
    parent: op('a'),
    attempt: 't123456',
    before: side(),
    after: side(),
    added: [id('1')],
    removed: []
  }

  it("is the attempt's: its parent, its marker, nothing else changed", () => {
    expect(deltaProblem(base)).toBeNull()
  })

  it('names what is not', () => {
    expect(deltaProblem({ ...base, entry: { ...base.entry, parents: [op('c')] } })).toBe('parent')
    expect(deltaProblem({ ...base, entry: { ...base.entry, parents: [op('a'), op('c')] } })).toBe('parent')
    expect(deltaProblem({ ...base, entry: { ...base.entry, args: 'args: jj new --config=combwork.txn="other00"' } })).toBe('marker')
    expect(deltaProblem({ ...base, after: { ...side(), bookmarks: ['main\u001f\u001ffalse\u001fy'] } })).toBe('bookmarks')
    expect(deltaProblem({ ...base, after: { ...side(), tags: ['v1'] } })).toBe('tags')
    expect(deltaProblem({ ...base, after: { ...side(), workspaces: ['default\u001fz'] } })).toBe('workspaces')
  })

  it("allows only jj's keep refs of exactly its own commits; any other ref change is a race", () => {
    expect(deltaProblem({ ...base, after: side([[`refs/jj/keep/${id('1')}`, id('1')]]) })).toBeNull()
    // A keep ref of someone else's commit, or one holding another commit.
    expect(deltaProblem({ ...base, after: side([[`refs/jj/keep/${id('2')}`, id('2')]]) })).toBe(`ref:refs/jj/keep/${id('2')}`)
    expect(deltaProblem({ ...base, after: side([[`refs/jj/keep/${id('1')}`, id('2')]]) })).toBe(`ref:refs/jj/keep/${id('1')}`)
    // A branch exported, a pin of another attempt, a tag.
    expect(deltaProblem({ ...base, after: side([['refs/heads/main', id('3')]]) })).toBe('ref:refs/heads/main')
    expect(deltaProblem({ ...base, before: side([['refs/cw/jj/HI-1/x/c0', id('4')]]), after: side() })).toBe('ref:refs/cw/jj/HI-1/x/c0')
    // An abandoned commit's keep ref going is jj's own.
    expect(deltaProblem({ ...base, added: [], removed: [id('5')], before: side([[`refs/jj/keep/${id('5')}`, id('5')]]), after: side() })).toBeNull()
  })

  it('reads the marker as jj records it in the args, quoted or escaped', () => {
    expect(deltaProblem({ ...base, entry: { ...base.entry, args: 'args: jj new "--config=combwork.txn=\\"t123456\\""' } })).toBeNull()
  })
})

describe('the guarded abandon', () => {
  it('names only what has no outside descendant, bookmark, tag or working copy, closed under descendants', () => {
    const g = guardedSet([id('1'), id('2')])
    const s = `(${id('1')} | ${id('2')})`
    expect(g).toBe(`${s} ~ ::((children(${s}) ~ ${s}) | (${s} & (bookmarks() | remote_bookmarks() | tags() | working_copies())))`)
    expect(guardedSet([])).toContain('none()')
  })
})

describe('parsers', () => {
  it('refs: every line an object id and a name; anything else unreadable', () => {
    expect(parseRefs(`${id('a')} refs/heads/main\n${id('b')} refs/cw/jj/HI-1/t/c0\n`)).toEqual(new Map([['refs/heads/main', id('a')], ['refs/cw/jj/HI-1/t/c0', id('b')]]))
    expect(parseRefs('')).toEqual(new Map())
    expect(parseRefs('nonsense refs/heads/x')).toBeNull()
    expect(parseRefs(`${id('a')}`)).toBeNull()
    expect(parseRefs(`${id('a')} refs/a b`)).toBeNull()
  })

  it('conflicted files: a path and two or more sides', () => {
    expect(parseConflicted(`f.txt${SEP}2\nsub/g h.txt${SEP}3\n`)).toEqual([{ path: 'f.txt', sides: 2 }, { path: 'sub/g h.txt', sides: 3 }])
    expect(parseConflicted('')).toEqual([])
    expect(parseConflicted(`f.txt${SEP}1`)).toBeNull()
    expect(parseConflicted('f.txt')).toBeNull()
  })

  it('operations: a 128-hex id, its parents, its attributes', () => {
    expect(parseOpLine(`${op('a')}${SEP}${op('b')}${SEP}args: jj x`)).toEqual({ id: op('a'), parents: [op('b')], args: 'args: jj x' })
    expect(parseOpLine(`${op('a')}${SEP}${SEP}`)).toEqual({ id: op('a'), parents: [], args: '' })
    expect(parseOpLine(`abc${SEP}${SEP}`)).toBeNull()
    expect(parseOpLine(`${op('a')}${SEP}xyz${SEP}`)).toBeNull()
  })

  it("a pin's prefix and a file's fileset", () => {
    expect(pinPrefix('HI-1/x y', 'abc123')).toBe('refs/cw/jj/HI-1-x-y/abc123/')
    expect(rootFile('a "b"\\c')).toBe('root-file:"a \\"b\\"\\\\c"')
  })
})
