// jj's integration evidence, its pure parts (HI-2798's J5): the export matrix, the remote's choice, the remote and ref
// parsers, the obligations' compare-and-set and idempotent reconstruction, and the Integrated fact's jj provenance. The
// real jj's behaviour is jjIntegrationReal.test.ts'.
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chooseRemote, exportProblem, memoryObligations, parseBookmarkRows, parseLsRemote, parseRemotes, reconstructObligations, refFromFiles, sourcesPrint } from '../src/main/platform/jjIntegration'
import { tempDir } from './tempDir'
import { jjIntegratedOf, jjIntegratedPlatform } from '../src/main/platform/jjFacts'

const id = (c: string): string => c.repeat(40)
const SEP = '\u001f'

describe('the export matrix (s14 §1′)', () => {
  const A = id('a')
  const B = id('b')
  it('colocated: the @git row and the ref both equal T, else a disagreement (a missing row included)', () => {
    expect(exportProblem(true, A, A, A)).toBeNull()
    expect(exportProblem(true, A, A, B)).not.toBeNull()
    expect(exportProblem(true, A, B, A)).not.toBeNull()
    expect(exportProblem(true, A, A, null)).not.toBeNull()
    expect(exportProblem(true, A, null, A)).not.toBeNull()
  })
  it('not colocated: no row and no ref agree (a fresh store); a row needs the ref; a ref alone must equal T', () => {
    expect(exportProblem(false, A, null, null)).toBeNull()
    expect(exportProblem(false, A, null, A)).toBeNull()
    expect(exportProblem(false, A, null, B)).not.toBeNull()
    expect(exportProblem(false, A, A, A)).toBeNull()
    expect(exportProblem(false, A, A, null)).not.toBeNull()
    expect(exportProblem(false, A, B, B)).not.toBeNull()
  })
})

describe("the remote's choice (s17 §2)", () => {
  const row = (remote: string, tracked: boolean) => ({ name: 'main', remote, conflict: false, target: id('a'), tracked })
  it('one tracked remote; several tracked refused', () => {
    expect(chooseRemote('main', [row('', false), row('git', true), row('up', true)], ['origin', 'up'])).toBe('up')
    expect(chooseRemote('main', [row('a', true), row('b', true)], ['a', 'b'])).toMatchObject({ refused: 'ambiguousRemote' })
  })
  it('none tracked: the only remote, else origin, else refused; none configured: no remote', () => {
    expect(chooseRemote('main', [row('x', false)], ['x'])).toBe('x')
    expect(chooseRemote('main', [], ['a', 'origin'])).toBe('origin')
    expect(chooseRemote('main', [], ['a', 'b'])).toMatchObject({ refused: 'ambiguousRemote' })
    expect(chooseRemote('main', [], [])).toBeNull()
    // Another bookmark's tracking says nothing about this one.
    expect(chooseRemote('main', [{ ...row('a', true), name: 'other' }], ['a', 'b'])).toMatchObject({ refused: 'ambiguousRemote' })
  })
})

describe('parsers', () => {
  it('bookmark rows', () => {
    expect(parseBookmarkRows(`main${SEP}${SEP}false${SEP}${id('a')}${SEP}false\nmain${SEP}origin${SEP}false${SEP}${id('a')}${SEP}true\n`)).toEqual([
      { name: 'main', remote: '', conflict: false, target: id('a'), tracked: false },
      { name: 'main', remote: 'origin', conflict: false, target: id('a'), tracked: true }
    ])
    expect(parseBookmarkRows(`main${SEP}${SEP}true${SEP}${SEP}false`)).toEqual([{ name: 'main', remote: '', conflict: true, target: '', tracked: false }])
    expect(parseBookmarkRows(`main${SEP}x`)).toBeNull()
    expect(parseBookmarkRows(`main${SEP}${SEP}false${SEP}nothex${SEP}false`)).toBeNull()
  })
  it('remotes and ls-remote', () => {
    expect(parseRemotes('origin C:/r/remote.git\nup https://x/y z\n')).toEqual(new Map([['origin', 'C:/r/remote.git'], ['up', 'https://x/y z']]))
    expect(parseRemotes('nourl')).toBeNull()
    expect(parseLsRemote('', 'refs/heads/main')).toBeNull()
    expect(parseLsRemote(`${id('a')}\trefs/heads/main\n`, 'refs/heads/main')).toBe(id('a'))
    expect(parseLsRemote(`${id('a')}\trefs/heads/mainx\n`, 'refs/heads/main')).toBe('malformed')
    expect(parseLsRemote(`${id('a')}\trefs/heads/main\n${id('b')}\trefs/heads/main\n`, 'refs/heads/main')).toBe('malformed')
  })
})

describe('obligations: one per integration, compare-and-set, idempotent reconstruction (s17 §2, s20)', () => {
  const fact = (card: string, bundle: string, result: string) => ({ card, cycle: 1, bundle, target: 'main', result, at: 1 })
  it('a tombstone blocks its own key only; a new bundle in the same cycle is a new obligation', () => {
    const s = memoryObligations()
    expect(reconstructObligations(s, [fact('HI-1', 'b0-aaaaaa', id('a'))])).toBe(1)
    expect(s.settle({ card: 'HI-1', cycle: 1, bundle: 'b0-aaaaaa' }, id('a'), 'published', 5, id('c'))).toBe(true)
    expect(reconstructObligations(s, [fact('HI-1', 'b0-aaaaaa', id('a'))])).toBe(0)
    expect(reconstructObligations(s, [fact('HI-1', 'b0-aaaaaa', id('a')), fact('HI-1', 'b1-bbbbbb', id('b'))])).toBe(1)
    expect(s.rows.map((r) => [r.bundle, r.state])).toEqual([['b0-aaaaaa', 'published'], ['b1-bbbbbb', 'owed']])
  })
  it('a settle changes only its exact key and result, and only from owed (a late answer for another result does nothing)', () => {
    const s = memoryObligations()
    reconstructObligations(s, [fact('HI-1', 'b1-bbbbbb', id('b'))])
    expect(s.settle({ card: 'HI-1', cycle: 1, bundle: 'b1-bbbbbb' }, id('a'), 'published', 5, id('c'))).toBe(false)
    expect(s.settle({ card: 'HI-1', cycle: 1, bundle: 'b0-aaaaaa' }, id('b'), 'published', 5, id('c'))).toBe(false)
    expect(s.settle({ card: 'HI-1', cycle: 1, bundle: 'b1-bbbbbb' }, id('b'), 'notHeld', 5)).toBe(true)
    expect(s.settle({ card: 'HI-1', cycle: 1, bundle: 'b1-bbbbbb' }, id('b'), 'published', 6, id('c'))).toBe(false)
    expect(s.rows[0]).toMatchObject({ state: 'notHeld', at: 5 })
  })
})

describe('the synchronous final reads (HR1 round 2): a ref and a remote URL from the store files', () => {
  it('a loose ref, else its packed line; absent null; malformed undefined', () => {
    const store = tempDir('jjint-store-')
    mkdirSync(join(store, 'refs', 'heads'), { recursive: true })
    expect(refFromFiles(store, 'refs/heads/main')).toBeNull()
    writeFileSync(join(store, 'packed-refs'), `# pack-refs with: peeled\n${id('a')} refs/heads/main\n${id('b')} refs/heads/other\n`)
    expect(refFromFiles(store, 'refs/heads/main')).toBe(id('a'))
    writeFileSync(join(store, 'refs', 'heads', 'main'), `${id('c')}\n`)
    expect(refFromFiles(store, 'refs/heads/main')).toBe(id('c'))
    writeFileSync(join(store, 'refs', 'heads', 'main'), 'ref: refs/heads/other\n')
    expect(refFromFiles(store, 'refs/heads/main')).toBeUndefined()
  })
})

describe("the sources' fingerprint (the Assistant's note): raw bytes, any change a difference, unreadable unknown", () => {
  const setup = () => {
    const top = tempDir('jjint-print-')
    const store = join(top, 'store')
    const jjRepo = join(top, 'jjrepo')
    mkdirSync(join(store, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(jjRepo, 'op_heads', 'heads'), { recursive: true })
    writeFileSync(join(jjRepo, 'op_heads', 'heads', 'f'.repeat(128)), '')
    writeFileSync(join(store, 'config'), '[remote "origin"]\n\turl = A\n')
    writeFileSync(join(store, 'refs', 'heads', 'main'), `${id('a')}\n`)
    const print = (): string | undefined => sourcesPrint(store, jjRepo, 'main')
    return { top, store, jjRepo, print }
  }
  it('is stable when nothing changes', () => {
    const w = setup()
    expect(w.print()).toBeDefined()
    expect(w.print()).toBe(w.print())
  })
  it("differs for a mixed-case remote section appended (HR2's round 3: never interpreted, so never ignored)", () => {
    const w = setup()
    const a = w.print()
    writeFileSync(join(w.store, 'config'), '[remote "origin"]\n\turl = A\n[Remote "origin"]\n\turl = B\n')
    expect(w.print()).not.toBe(a)
  })
  it('follows includes (and includeIf, nested, relative to the file naming them): a change in an included file differs', () => {
    const w = setup()
    mkdirSync(join(w.store, 'sub'))
    writeFileSync(join(w.store, 'config'), '[remote "origin"]\n\turl = A\n[include]\n\tpath = extra.cfg\n[includeIf "gitdir:x"]\n\tpath = sub/cond.cfg\n')
    writeFileSync(join(w.store, 'extra.cfg'), '[core]\n\tx = 1\n')
    writeFileSync(join(w.store, 'sub', 'cond.cfg'), '[Include]\n\tpath = deeper.cfg\n')
    writeFileSync(join(w.store, 'sub', 'deeper.cfg'), '')
    const a = w.print()
    expect(a).toBeDefined()
    writeFileSync(join(w.store, 'extra.cfg'), '[remote "origin"]\n\turl = B\n')
    const b = w.print()
    expect(b).not.toBe(a)
    writeFileSync(join(w.store, 'sub', 'deeper.cfg'), '[remote "origin"]\n\turl = C\n')
    expect(w.print()).not.toBe(b)
  })
  it('a ref, the packed refs or the operation heads changing differs; a `~` include or too deep a chain is unknown', () => {
    const w = setup()
    const a = w.print()
    writeFileSync(join(w.store, 'packed-refs'), `${id('b')} refs/heads/other\n`)
    const b = w.print()
    expect(b).not.toBe(a)
    writeFileSync(join(w.store, 'refs', 'heads', 'main'), `${id('c')}\n`)
    const c = w.print()
    expect(c).not.toBe(b)
    writeFileSync(join(w.jjRepo, 'op_heads', 'heads', 'e'.repeat(128)), '')
    expect(w.print()).not.toBe(c)
    writeFileSync(join(w.store, 'config'), '[include]\n\tpath = ~/x.cfg\n')
    expect(w.print()).toBeUndefined()
    writeFileSync(join(w.store, 'config'), '[include]\n\tpath = config\n')
    expect(w.print()).toBeDefined()
    for (let i = 0; i < 12; i++) writeFileSync(join(w.store, `c${i}.cfg`), `[include]\n\tpath = c${i + 1}.cfg\n`)
    writeFileSync(join(w.store, 'config'), '[include]\n\tpath = c0.cfg\n')
    expect(w.print()).toBeUndefined()
  })
})

describe("an Integrated fact's jj provenance", () => {
  const op = 'f'.repeat(128)
  const base = { op, head: id('a'), gitRef: id('a'), via: 'ancestry' as const, bundle: 'b0-abcdef' }
  it('round-trips, and reads only a whole valid record', () => {
    expect(jjIntegratedOf(jjIntegratedPlatform(base))).toEqual(base)
    const cand = { ...base, via: 'candidate' as const, candidate: { attempt: 'abc123', result: id('c') } }
    expect(jjIntegratedOf(jjIntegratedPlatform(cand))).toEqual(cand)
    expect(jjIntegratedOf({ jj: { ...base, gitRef: null } })).toEqual({ ...base, gitRef: null })
    expect(jjIntegratedOf({ jj: { ...base, via: 'candidate' } })).toBeNull()
    expect(jjIntegratedOf({ jj: { ...base, candidate: { attempt: 'abc123', result: id('c') } } })).toBeNull()
    expect(jjIntegratedOf({ jj: { ...base, bundle: 'nope' } })).toBeNull()
    expect(jjIntegratedOf({ jj: { ...base, extra: 1 } })).toBeNull()
    expect(jjIntegratedOf({ jj: { ...base, head: 'short' } })).toBeNull()
    expect(jjIntegratedOf(null)).toBeNull()
  })
})
