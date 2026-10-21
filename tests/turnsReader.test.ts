// Reading a live transcript's turns for hooks health (#1371, turnsReader.ts): which bytes each look gives the adapter.
// History never (a resumed or found-later file is read from its end), whole lines only, and a file replaced, shrunk, or
// another path or conversation starts the reading again; more than 4 MB since the last look forgets what was known.
import { describe, expect, it } from 'vitest'
import { lookAtTurns, MAX_SPAN, type ReadSpan, type TurnsReading } from '../src/main/turnsReader'

/** A file in memory: its text, read by byte offsets (ASCII here, so characters are bytes). */
const file = (text: { now: string }): ReadSpan => async (start, end) => text.now.slice(start, end)
const gone: ReadSpan = async () => null
const at = (path: string, size: number, fresh = false, sessionId = 's1') => ({ path, sessionId, size, fresh })

describe('looking at a transcript for its turns (#1371)', () => {
  it("this launch's new conversation is read from its start; a resumed one (or one found later) from its end", async () => {
    const t = { now: 'a\nb\n' }
    const fresh = await lookAtTurns(undefined, at('f', 4, true), file(t))
    expect(fresh).toMatchObject({ restarted: true, lines: 'a\nb\n', reading: { offset: 4 } })
    const resumed = await lookAtTurns(undefined, at('f', 4), file(t))
    expect(resumed).toMatchObject({ restarted: true, lines: null, reading: { offset: 4 } })
    t.now += 'c\n'
    expect(await lookAtTurns(resumed!.reading, at('f', 6), file(t))).toMatchObject({ restarted: false, lines: 'c\n', reading: { offset: 6 } })
  })

  it('whole lines only: a line still being written waits for the next look', async () => {
    const t = { now: 'a\nb' }
    const first = await lookAtTurns(undefined, at('f', 3, true), file(t))
    expect(first).toMatchObject({ lines: 'a\n', reading: { offset: 2 } })
    t.now += 'c\n'
    expect(await lookAtTurns(first!.reading, at('f', 5), file(t))).toMatchObject({ lines: 'bc\n', reading: { offset: 5 } })
  })

  it('read from the middle of a line (a resumed file found while being written): that line is dropped', async () => {
    const t = { now: 'old\npart' }
    const first = await lookAtTurns(undefined, at('f', 8), file(t))
    t.now += 'ial\nnew\n'
    expect((await lookAtTurns(first!.reading, at('f', 16), file(t)))?.lines).toBe('new\n')
  })

  it('another path or conversation, a shrink, or other first bytes (replaced, the same size or larger) start again from its end', async () => {
    const t = { now: 'a\nb\n' }
    const r = (await lookAtTurns(undefined, at('f', 4, true), file(t)))!.reading
    const memo = r.memo
    memo.kept = true
    expect(await lookAtTurns(r, at('g', 4), file(t))).toMatchObject({ restarted: true, lines: null })
    expect(await lookAtTurns(r, at('f', 4, false, 's2'), file(t))).toMatchObject({ restarted: true, lines: null })
    expect(await lookAtTurns(r, at('f', 2), file({ now: 'a\n' }))).toMatchObject({ restarted: true })
    const replaced = await lookAtTurns(r, at('f', 6), file({ now: 'x\ny\nz\n' }))
    expect(replaced).toMatchObject({ restarted: true, lines: null, reading: { offset: 6 } })
    expect(replaced!.reading.memo).toEqual({})
    // The same file grown: the same reading, its memo kept.
    const grown = await lookAtTurns(r, at('f', 6), file({ now: 'a\nb\nc\n' }))
    expect(grown).toMatchObject({ restarted: false, lines: 'c\n' })
    expect(grown!.reading.memo).toBe(memo)
  })

  it('more than 4 MB since the last look: only the latest, from a whole line, and what the adapter knew is forgotten', async () => {
    const t = { now: 'a\n' }
    const r = (await lookAtTurns(undefined, at('f', 2, true), file(t)))!.reading
    r.memo.kept = true
    t.now += 'x'.repeat(MAX_SPAN) + '\nlast\n'
    const look = await lookAtTurns(r, at('f', t.now.length), file(t))
    expect(look?.lines).toBe('last\n')
    expect(look?.reading.memo).toEqual({})
  })

  it('a file gone meanwhile: nothing changes', async () => {
    const r: TurnsReading = { sessionId: 's1', path: 'f', offset: 2, head: 'a\n', headBytes: 2, memo: {} }
    expect(await lookAtTurns(r, at('f', 4), gone)).toBeNull()
    expect(await lookAtTurns(undefined, at('f', 4), gone)).toBeNull()
  })
})
