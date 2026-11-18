// HI-3369: the line comments being written over a revision's diff, kept while the window is open (lineCommentDrafts.ts):
// each workspace's own, even where two workspaces have the same card, submission and path; and the kept list is the
// one a save or cancel changes, so one that ends after its layer is gone still takes its draft out, telling any layer
// showing that file by then (HR1's round 1 on HI-3369).
import { afterEach, describe, expect, it } from 'vitest'
import { changeDrafts, clearKeptDrafts, keptFor, keptKey, type Draft } from '../src/renderer/src/lineCommentDrafts'

afterEach(() => clearKeptDrafts())
const d = (from: number): Draft => ({ side: 'new', from, to: from })

describe('kept line comment drafts (HI-3369)', () => {
  it('two workspaces with the same card, submission and path keep apart: each sees its own draft and held text', () => {
    const a = keptFor(keptKey('D:\\Work\\A', 7, 1, 'src/index.ts'))
    const b = keptFor(keptKey('D:\\Work\\B', 7, 1, 'src/index.ts'))
    expect(a).not.toBe(b)
    changeDrafts(a, (ds) => [...ds, d(3)])
    a.store.values.set('text:draft:new:3-3', "A's words")
    expect(b.drafts).toEqual([])
    expect(b.store.values.size).toBe(0)
    // Back in A (the same path, any case Windows gives it): its draft and text are there.
    const again = keptFor(keptKey('d:\\work\\a', 7, 1, 'src/index.ts'))
    expect(again).toBe(a)
    expect(again.drafts).toEqual([d(3)])
    expect(again.store.values.get('text:draft:new:3-3')).toBe("A's words")
  })

  it('another card, submission or path of one workspace is another file', () => {
    const keys = [keptKey('w', 7, 1, 'a.ts'), keptKey('w', 8, 1, 'a.ts'), keptKey('w', 7, 2, 'a.ts'), keptKey('w', 7, 1, 'b.ts')]
    expect(new Set(keys.map((k) => keptFor(k))).size).toBe(4)
  })

  it('a save ending after its layer is gone still takes its draft out: the file chosen again shows it gone', () => {
    const k = keptFor(keptKey('w', 7, 1, 'a.ts'))
    changeDrafts(k, (ds) => [...ds, d(1), d(5)])
    // The layer that started the save is gone (another file chosen): nothing subscribes. Its save ends now.
    const saved = d(1)
    changeDrafts(k, (ds) => ds.filter((x) => x.from !== saved.from))
    expect(keptFor(keptKey('w', 7, 1, 'a.ts')).drafts).toEqual([d(5)])
  })

  it('a layer showing the file when a save ends is told, and reads the list without the draft', () => {
    const k = keptFor(keptKey('w', 7, 1, 'a.ts'))
    changeDrafts(k, () => [d(1)])
    let told = 0
    const tell = (): void => void told++
    k.subs.add(tell)
    changeDrafts(k, (ds) => ds.filter((x) => x.from !== 1))
    expect([told, k.drafts]).toEqual([1, []])
    // A change that changes nothing tells nobody.
    changeDrafts(k, (ds) => ds)
    expect(told).toBe(1)
    k.subs.delete(tell)
  })
})
