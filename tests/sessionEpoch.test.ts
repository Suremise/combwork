// An agent's terminal is made once per run of its session (HI-2213), however often main tells that run's start.
import { describe, expect, it } from 'vitest'
import { sessionEpochBook } from '../src/shared/sessionEpoch'

describe('sessionEpochBook', () => {
  it("a run's first start makes a new terminal; its start told again makes none", () => {
    const book = sessionEpochBook()
    expect(book.starting('k', 'r1', undefined, undefined)).toBe(1)
    expect(book.starting('k', 'r1', 1, 'r1')).toBeUndefined()
  })
  it('a terminal the workspace already mounted for the run (epoch 0) is kept, not made again', () => {
    const book = sessionEpochBook()
    expect(book.starting('k', 'r1', undefined, 'r1')).toBe(0)
    expect(book.starting('k', 'r1', 0, 'r1')).toBeUndefined()
  })
  it('a new run gets a new terminal, even when the workspace showed it first over the last run’s terminal', () => {
    const book = sessionEpochBook()
    expect(book.starting('k', 'r1', undefined, undefined)).toBe(1)
    expect(book.starting('k', 'r2', 1, 'r2')).toBe(2)
    expect(book.starting('k', 'r3', 2, undefined)).toBe(3)
  })
  it('each terminal keeps its own run', () => {
    const book = sessionEpochBook()
    expect(book.starting('a', 'r1', undefined, undefined)).toBe(1)
    expect(book.starting('b', 'r1', undefined, undefined)).toBe(1)
    expect(book.starting('a', 'r1', 1, 'r1')).toBeUndefined()
  })
})
