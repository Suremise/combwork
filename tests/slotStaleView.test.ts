// The slot listing's view of a jj slot's staleness (HI-2912, src/main/slotStaleView.ts): not read while the pool works on
// the slot or it owes a settle, decided right before the read; one read per folder at a time; its last answer for the
// same folder otherwise, never a fresh one; a known Stale never lost to an answer that couldn't be read. Deterministic:
// each read and generation is a promise the test settles.
import { describe, expect, it } from 'vitest'
import { SlotStaleView, type StaleViewRow } from '../src/main/slotStaleView'

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** A pool of slots the test changes, and the reads the view started, each settled by the test. */
function world() {
  const rows = new Map<string, StaleViewRow>()
  const owed = new Set<string>()
  const generations = new Map<string, string | null>()
  const reads: { folder: string; answer: (v: boolean | null) => void }[] = []
  let gate: ReturnType<typeof deferred<void>> | null = null
  const view = new SlotStaleView({
    row: (name) => rows.get(name) ?? null,
    owes: (name) => owed.has(name),
    read: (folder) => {
      const d = deferred<boolean | null>()
      reads.push({ folder, answer: d.resolve })
      return d.promise
    },
    generation: async (folder) => {
      if (gate) await gate.promise
      return generations.has(folder) ? generations.get(folder)! : 'g1'
    }
  })
  const slot = (name: string, more: Partial<StaleViewRow> = {}): StaleViewRow => {
    const r = { folder: `C:\\ws.worktrees\\shop\\${name}`, state: 'ready', op: null, job: null, ...more }
    rows.set(name, r)
    return r
  }
  /** Lets the view's awaits run, with nothing settled. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  return { view, rows, owed, generations, reads, slot, flush, hold: () => (gate = deferred<void>()), release: () => gate?.resolve() }
}

describe("the slot listing's staleness (HI-2912)", () => {
  it('reads it when nothing works on the slot, and keeps the answer', async () => {
    const w = world()
    w.slot('slot-a')
    const asked = w.view.staleOf('slot-a')
    await w.flush()
    expect(w.reads.map((r) => r.folder)).toEqual(['C:\\ws.worktrees\\shop\\slot-a'])
    w.reads[0].answer(true)
    expect(await asked).toBe(true)
    expect(w.view.size).toBe(1)
  })

  it('reads nothing while the slot has an operation, a job or owes a settle: its last answer for that folder', async () => {
    const w = world()
    const row = w.slot('slot-a')
    const first = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[0].answer(true)
    expect(await first).toBe(true)
    for (const busy of [() => (row.op = { token: 't' }), () => ((row.op = null), (row.job = 'j1')), () => ((row.job = null), w.owed.add('slot-a'))]) {
      busy()
      expect(await w.view.staleOf('slot-a')).toBe(true)
    }
    expect(w.reads).toHaveLength(1)
  })

  it('decides after its await: an operation begun meanwhile starts no read', async () => {
    const w = world()
    const row = w.slot('slot-a')
    w.hold()
    const asked = w.view.staleOf('slot-a')
    await w.flush()
    row.op = { token: 't' }
    w.release()
    expect(await asked).toBe(false)
    expect(w.reads).toHaveLength(0)
  })

  it('one read per folder at a time: listings meanwhile share it, and none starts once the slot owes a settle', async () => {
    const w = world()
    w.slot('slot-a')
    const a = w.view.staleOf('slot-a')
    const b = w.view.staleOf('slot-a')
    await w.flush()
    expect(w.reads).toHaveLength(1)
    // A settle that found the slot busy: owed. The read already going ends; later listings start none.
    w.owed.add('slot-a')
    const c = w.view.staleOf('slot-a')
    await w.flush()
    expect(w.reads).toHaveLength(1)
    w.reads[0].answer(false)
    expect([await a, await b, await c]).toEqual([false, false, false])
    for (let i = 0; i < 3; i++) await w.view.staleOf('slot-a')
    expect(w.reads).toHaveLength(1)
  })

  it("an answer that couldn't be read never replaces a known Stale (its Recover… stays)", async () => {
    const w = world()
    w.slot('slot-a')
    const first = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[0].answer(true)
    expect(await first).toBe(true)
    const again = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[1].answer(null)
    expect(await again).toBe(true)
  })

  it('stale, then suppressed while recovered, then a fresh read: not stale', async () => {
    const w = world()
    const row = w.slot('slot-a')
    const first = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[0].answer(true)
    expect(await first).toBe(true)
    // The user's Recover…: an operation on the slot. Stale shown meanwhile, nothing read.
    row.op = { token: 'recover' }
    expect(await w.view.staleOf('slot-a')).toBe(true)
    expect(w.reads).toHaveLength(1)
    row.op = null
    const after = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[1].answer(false)
    expect(await after).toBe(false)
  })

  it('a slot never read, busy: not shown stale, and nothing kept for it', async () => {
    const w = world()
    w.slot('slot-b', { op: { token: 't' } })
    expect(await w.view.staleOf('slot-b')).toBe(false)
    expect(w.reads).toHaveLength(0)
    expect(w.view.size).toBe(0)
  })

  it("a folder replaced at the same path (another generation): the old one's answer isn't shown once it can be read", async () => {
    const w = world()
    const row = w.slot('slot-a')
    const first = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[0].answer(true)
    expect(await first).toBe(true)
    // Busy, nothing of the folder is touched: the answer kept for its path.
    w.owed.add('slot-a')
    expect(await w.view.staleOf('slot-a')).toBe(true)
    // Readable again, another folder there: its own read decides; one that couldn't be read never shows the old answer.
    w.owed.delete('slot-a')
    w.generations.set(row.folder, 'g2')
    const replaced = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[1].answer(null)
    expect(await replaced).toBe(false)
    // A generation that can't be read: nothing kept is trusted, nothing read.
    w.generations.set(row.folder, null)
    expect(await w.view.staleOf('slot-a')).toBe(false)
    expect(w.reads).toHaveLength(2)
  })

  it('a slot removed, gone or being removed: what was kept for it goes', async () => {
    const w = world()
    w.slot('slot-a')
    w.slot('slot-b')
    for (const n of ['slot-a', 'slot-b']) {
      const p = w.view.staleOf(n)
      await w.flush()
      w.reads.at(-1)!.answer(true)
      await p
    }
    expect(w.view.size).toBe(2)
    w.view.keepOnly(['slot-b'])
    expect(w.view.size).toBe(1)
    w.rows.get('slot-b')!.state = 'removing'
    expect(await w.view.staleOf('slot-b')).toBe(false)
    expect(w.view.size).toBe(0)
  })

  it("an owed settle's refusal for good clears the record: read again, Stale shown", async () => {
    const w = world()
    w.slot('slot-a')
    w.owed.add('slot-a')
    expect(await w.view.staleOf('slot-a')).toBe(false)
    expect(w.reads).toHaveLength(0)
    // The settle decided (a refusal for good: the slot is stale), its record cleared in its end write.
    w.owed.delete('slot-a')
    const after = w.view.staleOf('slot-a')
    await w.flush()
    w.reads[0].answer(true)
    expect(await after).toBe(true)
  })
})
