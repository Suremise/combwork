// jj's merge-queue candidates' pure parts (HI-2797's J4): the operation-delta validator (only this attempt's commits, its
// marker, its parent; bookmarks, tags and workspaces unchanged; Git's refs unchanged but for jj's keep refs of exactly its
// commits), the guarded abandon's revset, and the parsers of refs, conflicted files and operations. The real jj's
// behaviour is jjCandidatesReal.test.ts'.
import { describe, expect, it } from 'vitest'
import { deltaProblem, guardedSet, parseConflicted, parseOpLine, parseRefs, pinPrefix, rootFile, shapeProblem, validUpdate } from '../src/main/platform/jjCandidates'

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

describe("a step's shape (the same check in preparation and in recovery)", () => {
  const c = (commit: string, parents: string[], change = 'k'.repeat(32)) => ({ commit, change, parents, empty: false, divergent: false, conflict: false })
  it('duplicate: n commits, one root on the target, one head, nothing removed', () => {
    const step = { kind: 'duplicate' as const, n: 2, onto: id('t') }
    expect(shapeProblem(step, { added: [c(id('1'), [id('t')]), c(id('2'), [id('1')])], removed: [] })).toBeNull()
    expect(shapeProblem(step, { added: [c(id('1'), [id('t')])], removed: [] })).toBe('shape')
    expect(shapeProblem(step, { added: [c(id('1'), [id('x')]), c(id('2'), [id('1')])], removed: [] })).toBe('shape')
    expect(shapeProblem(step, { added: [c(id('1'), [id('t')]), c(id('2'), [id('t')])], removed: [] })).toBe('shape')
  })
  it('new: one commit on exactly its parents', () => {
    const step = { kind: 'new' as const, parents: [id('t'), id('r')] }
    expect(shapeProblem(step, { added: [c(id('1'), [id('t'), id('r')])], removed: [] })).toBeNull()
    expect(shapeProblem(step, { added: [c(id('1'), [id('r'), id('t')])], removed: [] })).toBe('shape')
    expect(shapeProblem(step, { added: [c(id('1'), [id('t'), id('r')])], removed: [id('9')] })).toBe('shape')
  })
  it("restore: exactly its commit rewritten, on its parent, its change kept; an outside descendant rebased isn't its shape", () => {
    const step = { kind: 'restore' as const, into: id('e'), change: 'k'.repeat(32), parent: id('t') }
    expect(shapeProblem(step, { added: [c(id('f'), [id('t')])], removed: [id('e')] })).toBeNull()
    expect(shapeProblem(step, { added: [c(id('f'), [id('t')]), c(id('d'), [id('f')], 'm'.repeat(32))], removed: [id('e'), id('o')] })).toBe('shape')
    expect(shapeProblem(step, { added: [c(id('f'), [id('t')], 'm'.repeat(32))], removed: [id('e')] })).toBe('shape')
  })
  it('abandon: exactly what it would abandon, nothing added (nothing rebased)', () => {
    const step = { kind: 'abandon' as const, will: [id('1'), id('2')] }
    expect(shapeProblem(step, { added: [], removed: [id('2'), id('1')] })).toBeNull()
    expect(shapeProblem(step, { added: [c(id('3'), [id('t')])], removed: [id('1'), id('2')] })).toBe('shape')
    expect(shapeProblem(step, { added: [], removed: [id('1')] })).toBe('shape')
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

describe("strict's update: what validUpdate accepts (HI-2853/s10 §2)", () => {
  const prefix = pinPrefix('HI-1', 'upd001')
  const u = {
    attempt: 'upd001', card: 'HI-1', kind: 'update' as const, how: 'merge' as const, style: 'merge' as const, revision: id('1'), base: id('2'), expected: id('3'),
    phase: 'done' as const, baseOp: op('a'), ops: [], commits: [id('4')], result: id('4'), outcome: 'updated' as const,
    pins: [{ ref: `${prefix}candidate`, oid: id('4'), state: 'created' as const }]
  }
  const want = { card: 'HI-1', revision: id('1'), base: id('2'), expected: id('3'), attempt: 'upd001', result: id('4') }
  const gitAt = (oid: string | null) => async () => ({ ok: true, out: oid ? `${oid} ${prefix}candidate\n` : '', buf: Buffer.alloc(0), err: '', code: 0 })
  it('accepts exactly a finished, leaf update for this input and target, its pin holding its result now', async () => {
    expect(await validUpdate(gitAt(id('4')), u, want)).toBe(true)
  })
  it('refuses, saying why', async () => {
    const g = gitAt(id('4'))
    expect(await validUpdate(g, undefined, want)).toBe('missing')
    expect(await validUpdate(g, { ...u, kind: undefined }, want)).toBe('notUpdated')
    expect(await validUpdate(g, { ...u, kind: 'candidate' }, want)).toBe('notUpdated')
    expect(await validUpdate(g, { ...u, phase: 'pinned' }, want)).toBe('notUpdated')
    expect(await validUpdate(g, { ...u, outcome: 'conflict' }, want)).toBe('notUpdated')
    expect(await validUpdate(g, { ...u, step: { name: 'update', parent: op('a'), shape: { kind: 'new', parents: [] } } }, want)).toBe('unsettled')
    expect(await validUpdate(g, { ...u, uncertain: [id('9')] }, want)).toBe('unsettled')
    expect(await validUpdate(g, { ...u, updated: { attempt: 'zzzzzz', result: id('5') } }, want)).toBe('unsettled')
    expect(await validUpdate(g, { ...u, card: 'HI-2' }, want)).toBe('foreign')
    expect(await validUpdate(g, u, { ...want, attempt: 'other1' })).toBe('foreign')
    expect(await validUpdate(g, { ...u, revision: id('6') }, want)).toBe('input')
    expect(await validUpdate(g, { ...u, base: id('6') }, want)).toBe('input')
    expect(await validUpdate(g, { ...u, expected: id('6') }, want)).toBe('expected')
    expect(await validUpdate(g, u, { ...want, result: id('6') })).toBe('result')
    expect(await validUpdate(g, { ...u, pins: [] }, want)).toBe('unpinned')
    expect(await validUpdate(gitAt(id('7')), u, want)).toBe('pinMoved')
    expect(await validUpdate(gitAt(null), u, want)).toBe('pinMoved')
  })
})
