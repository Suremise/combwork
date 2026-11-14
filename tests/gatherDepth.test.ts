// An intent's passes gathered again belong to its own call chain (HI-2916, HR1's round 1): nested passes count up and end
// with their pass; two intents on one card at once, ending in either order, by an answer or a failure, never see or
// clear each other's depth, each keeps its own bounded budget, and nothing is left once they end.
import { describe, expect, it } from 'vitest'
import { GatherDepth } from '../src/main/workflow/gatherDepth'

/** A promise and its settlers, to end a chain exactly when a test says. */
const gate = () => {
  let open!: () => void
  let fail!: (e: Error) => void
  const p = new Promise<void>((res, rej) => {
    open = res
    fail = rej
  })
  return { p, open, fail }
}

describe("a pass's depth is its own call chain's (HI-2916)", () => {
  it('nested passes count up, each ending with its own pass', async () => {
    const g = new GatherDepth()
    const seen: number[] = []
    expect(g.depth(1)).toBe(0)
    await g.again(1, async () => {
      seen.push(g.depth(1))
      await g.again(1, async () => {
        seen.push(g.depth(1), g.depth(2))
      })
      seen.push(g.depth(1))
    })
    expect(seen).toEqual([1, 2, 0, 1])
    expect(g.depth(1)).toBe(0)
  })

  it.each(['A first', 'B first'] as const)('two intents on one card overlapping, %s to end: each sees its own depth, none left after', async (order) => {
    const g = new GatherDepth()
    const a = gate()
    const b = gate()
    const seen: Record<string, number[]> = { A: [], B: [] }
    // A one pass deep; B two passes deep, started while A waits.
    const A = g.again(7, async () => {
      seen.A.push(g.depth(7))
      await a.p
      seen.A.push(g.depth(7))
    })
    const B = g.again(7, () =>
      g.again(7, async () => {
        seen.B.push(g.depth(7))
        await b.p
        seen.B.push(g.depth(7))
      })
    )
    // Outside both chains, nothing.
    expect(g.depth(7)).toBe(0)
    if (order === 'A first') {
      a.open()
      await A
      expect(g.depth(7)).toBe(0)
      b.open()
      await B
    } else {
      b.open()
      await B
      expect(g.depth(7)).toBe(0)
      a.open()
      await A
    }
    expect(seen).toEqual({ A: [1, 1], B: [2, 2] })
    expect(g.depth(7)).toBe(0)
    // A later intent starts from nothing.
    await g.again(7, async () => expect(g.depth(7)).toBe(1))
  })

  it.each(['A first', 'B first'] as const)('one of two overlapping intents failing (%s to end): the other keeps its depth, none left after', async (order) => {
    const g = new GatherDepth()
    const a = gate()
    const b = gate()
    const A = g.again(3, async () => {
      await a.p
      return g.depth(3)
    })
    const B = g.again(3, () => g.again(3, () => b.p.then(() => g.depth(3))))
    if (order === 'A first') {
      a.fail(new Error('A refused'))
      await expect(A).rejects.toThrow('A refused')
      b.open()
      expect(await B).toBe(2)
    } else {
      b.fail(new Error('B refused'))
      await expect(B).rejects.toThrow('B refused')
      a.open()
      expect(await A).toBe(1)
    }
    expect(g.depth(3)).toBe(0)
  })

  it('two overlapping intents, each gathered again while its passes last: each gets its own whole budget', async () => {
    const g = new GatherDepth()
    const BUDGET = 3
    // An intent whose fingerprint always moves: gathered again until its depth reaches the budget, then refused. It
    // yields between passes, so the two interleave.
    const intent = async (passes: number[]): Promise<string> => {
      passes.push(g.depth(9))
      await new Promise<void>((res) => setImmediate(res))
      return g.depth(9) < BUDGET ? g.again(9, () => intent(passes)) : 'refused'
    }
    const a: number[] = []
    const b: number[] = []
    expect(await Promise.all([intent(a), intent(b)])).toEqual(['refused', 'refused'])
    expect(a).toEqual([0, 1, 2, 3])
    expect(b).toEqual([0, 1, 2, 3])
    expect(g.depth(9)).toBe(0)
  })
})
