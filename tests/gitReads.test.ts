// The Git tab's and status bar's reads (useGitRead, #1366): a burst of reloads while a read is under way (a usage
// change as each agent's session ends) is one more read after it, with no state set meanwhile: fifty state updates in a
// row from the hook's effect were React's update loop (error #185).
import { describe, expect, it } from 'vitest'
import { gitReader, type GitReadState } from '../src/renderer/src/gitReads'

/** A Git read held until the test answers it. */
type Pending = { path: string; answer: (data: string) => void; fail: (e: Error) => void }

function setup(start = 'A') {
  const reads: Pending[] = []
  let state: GitReadState<string> = { for: start, data: null, error: null, loading: true, at: 0 }
  let updates = 0
  const reload = gitReader<string>(
    (path) => new Promise((answer, fail) => reads.push({ path, answer, fail })),
    (change) => {
      state = change(state)
      updates++
    },
    (e) => (e as Error).message
  )
  // An answer's handlers run on the microtask queue: let them all run.
  const settle = () => new Promise<void>((r) => setImmediate(r))
  return { reads, reload, settle, state: () => state, updates: () => updates }
}

describe('Git reads', () => {
  it('a burst of reloads while one is under way is one read after it, with no state set meanwhile', async () => {
    const t = setup()
    t.reload('A')
    expect(t.reads).toHaveLength(1)
    const before = t.updates()
    for (let i = 0; i < 60; i++) t.reload('A')
    expect(t.reads).toHaveLength(1)
    expect(t.updates()).toBe(before)

    t.reads[0].answer('first')
    await t.settle()
    // The catch-up read: one, for the whole burst.
    expect(t.reads).toHaveLength(2)
    expect(t.reads[1].path).toBe('A')
    expect(t.state()).toMatchObject({ for: 'A', data: 'first', loading: true })

    t.reads[1].answer('second')
    await t.settle()
    expect(t.reads).toHaveLength(2)
    expect(t.state()).toMatchObject({ for: 'A', data: 'second', error: null, loading: false })
  })

  it('a read with none asked meanwhile has no catch-up read', async () => {
    const t = setup()
    t.reload('A')
    t.reads[0].answer('only')
    await t.settle()
    expect(t.reads).toHaveLength(1)
    expect(t.state()).toMatchObject({ for: 'A', data: 'only', loading: false })
    // A reload afterwards reads again at once.
    t.reload('A')
    expect(t.reads).toHaveLength(2)
  })

  it("a superseded project's answer never overwrites the current project's", async () => {
    const t = setup()
    t.reload('A')
    t.reload('B')
    // Another project reads at once, without waiting for the first.
    expect(t.reads.map((r) => r.path)).toEqual(['A', 'B'])
    expect(t.state()).toMatchObject({ for: 'B', data: null, loading: true })

    t.reads[1].answer('b')
    await t.settle()
    t.reads[0].answer('a')
    await t.settle()
    expect(t.state()).toMatchObject({ for: 'B', data: 'b', loading: false })
    expect(t.reads).toHaveLength(2)
  })

  it("a superseded read ending leaves the current project's burst to its own read", async () => {
    const t = setup()
    t.reload('A')
    t.reload('B')
    t.reload('B')
    t.reload('B')
    // A's answer arriving doesn't end B's read nor start one.
    t.reads[0].answer('a')
    await t.settle()
    expect(t.reads).toHaveLength(2)
    t.reload('B')
    expect(t.reads).toHaveLength(2)

    t.reads[1].answer('b1')
    await t.settle()
    expect(t.reads.map((r) => r.path)).toEqual(['A', 'B', 'B'])
    t.reads[2].answer('b2')
    await t.settle()
    expect(t.reads).toHaveLength(3)
    expect(t.state()).toMatchObject({ for: 'B', data: 'b2', loading: false })
  })

  it('a failed read keeps the last answer, says why, and still catches up', async () => {
    const t = setup()
    t.reload('A')
    t.reads[0].answer('good')
    await t.settle()
    t.reload('A')
    t.reload('A')
    t.reads[1].fail(new Error('git is busy'))
    await t.settle()
    expect(t.state()).toMatchObject({ for: 'A', data: 'good', error: 'git is busy' })
    expect(t.reads).toHaveLength(3)
    t.reads[2].answer('again')
    await t.settle()
    expect(t.state()).toMatchObject({ for: 'A', data: 'again', error: null, loading: false })
  })
})
