// HI-3477 (round 1's finding): Restore From → A Commit…'s picks (renderer components/commitPicks.ts). What the list
// shows and what Restore acts on are both the latest click's answer: an earlier click's answer arriving later, or its
// failure, changes neither.
import { describe, expect, it } from 'vitest'
import { commitPicks } from '../src/renderer/src/components/commitPicks'

interface Plan {
  commit: string
  exists: boolean
}

/** Reads whose answers the test gives, in any order. */
function reads() {
  const waiting = new Map<string, { resolve: (p: Plan) => void; reject: (e: Error) => void }>()
  const read = (commit: string): Promise<Plan> => new Promise((resolve, reject) => waiting.set(commit, { resolve, reject }))
  const answer = async (commit: string, exists = true): Promise<void> => {
    waiting.get(commit)!.resolve({ commit, exists })
    await Promise.resolve()
  }
  const fail = async (commit: string): Promise<void> => {
    waiting.get(commit)!.reject(new Error(`no ${commit}`))
    await Promise.resolve()
  }
  return { read, answer, fail }
}

const errorText = (e: unknown): string => (e as Error).message

describe("A Commit…'s picks", () => {
  it("keeps the latest pick when an earlier pick's answer comes last: shown and chosen alike", async () => {
    const r = reads()
    const picks = commitPicks(r.read, errorText)
    const seen: (string | null)[] = []
    picks.watch((s) => seen.push(s?.plan?.commit ?? null))
    picks.pick('a')
    picks.pick('b')
    await r.answer('b')
    await r.answer('a')
    expect(picks.chosen()?.commit).toBe('b')
    expect(picks.shown()).toEqual({ commit: 'b', plan: { commit: 'b', exists: true } })
    expect(seen).toEqual([null, null, 'b'])
  })

  it('chooses nothing until the latest pick is read, nor while it is the earlier one that answered', async () => {
    const r = reads()
    const picks = commitPicks(r.read, errorText)
    picks.pick('a')
    await r.answer('a')
    expect(picks.chosen()?.commit).toBe('a')
    picks.pick('b')
    expect(picks.chosen()).toBeNull()
    await r.answer('b')
    expect(picks.chosen()?.commit).toBe('b')
  })

  it("an earlier pick's failure arriving last is dropped; the latest's own failure is shown and chooses nothing", async () => {
    const r = reads()
    const picks = commitPicks(r.read, errorText)
    picks.pick('a')
    picks.pick('b')
    await r.answer('b')
    await r.fail('a')
    expect(picks.shown()).toEqual({ commit: 'b', plan: { commit: 'b', exists: true } })
    picks.pick('c')
    await r.fail('c')
    expect(picks.shown()).toEqual({ commit: 'c', plan: null, error: 'no c' })
    expect(picks.chosen()).toBeNull()
  })

  it("a commit without the file is shown, never chosen", async () => {
    const r = reads()
    const picks = commitPicks(r.read, errorText)
    picks.pick('a')
    await r.answer('a', false)
    expect(picks.shown()?.plan).toEqual({ commit: 'a', exists: false })
    expect(picks.chosen()).toBeNull()
  })

  it('stops telling a watcher once it has gone', async () => {
    const r = reads()
    const picks = commitPicks(r.read, errorText)
    const seen: unknown[] = []
    const stop = picks.watch((s) => seen.push(s))
    stop()
    picks.pick('a')
    await r.answer('a')
    expect(seen).toEqual([])
    expect(picks.chosen()?.commit).toBe('a')
  })
})
