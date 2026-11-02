// HI-2340: a None card's start and submit read the project whole off main's thread (noneBaseline.ts), so the world can
// change while they wait. With the read held (the baseline thread's barrier; its code runs here in unit tests), each
// change before it is let go is seen: the card's paths, the folders left out (gathered again on the new ones), its kind,
// its column, the board closed. A no-code card reads nothing of the project, its declared paths included.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { B1, B2, moved, put, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { isRefusal } from '../../src/main/workflow/runtime'
import { baselineThread } from '../../src/main/noneBaseline'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 30_000

let env: Env | null = null
afterEach(() => {
  baselineThread().release()
  env?.close()
  env = null
})

const files = { 'a.txt': 'a\n', 'big/one.txt': '1\n', 'big/two.txt': '2\n' }
const none = (): Env => (env = setup({ ...preset('none', 'pair'), preChecks: [] }, { files }))

async function until(ok: () => boolean): Promise<void> {
  const end = Date.now() + HUNG_MS
  while (!ok()) {
    if (Date.now() > end) throw new Error('still not so after HUNG_MS')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Starts the card with its whole-project read held; resolves once the read waits (the start in an object: not awaited). */
async function heldStart(e: Env, key: string): Promise<{ p: Promise<unknown> }> {
  baselineThread().hold()
  const p = e.wf.start(key, B1)
  await until(() => baselineThread().pending === 1)
  return { p }
}

describe('a None start or submit waiting on its whole-project read (HI-2340)', () => {
  it("the card's paths changed meanwhile: refused, evidence changed", async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Paths', paths: ['a.txt'] })
    const { p } = await heldStart(e, card.key)
    e.store.updateCard(card.id, { paths: ['a.txt', 'big'] })
    baselineThread().release()
    refusedBy(await p, 'evidence.changed')
    expect(e.wf.state(card).stage).toBe('todo')
  })

  it('the folders left out changed meanwhile: gathered again, its baseline read under the new ones', async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Excluded', paths: ['a.txt'] })
    const { p } = await heldStart(e, card.key)
    e.wf.none.setExcluded(['big'])
    baselineThread().release()
    moved(await p)
    const base = e.wf.state(card).started?.deliverables ?? {}
    expect(Object.keys(base)).toContain('a.txt')
    expect(Object.keys(base).some((f) => f.startsWith('big/'))).toBe(false)
  })

  it('its kind changed to no-code meanwhile: refused, evidence changed (the kind as the board has it now)', async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Kind', paths: ['a.txt'] })
    const { p } = await heldStart(e, card.key)
    e.store.updateCard(card.id, { kind: 'no-code' })
    baselineThread().release()
    refusedBy(await p, 'evidence.changed')
  })

  it('moved by the user meanwhile: refused, left where the user put it', async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Moved', paths: ['a.txt'] })
    const { p } = await heldStart(e, card.key)
    moved(await e.wf.move(card.key, 'hold', 'user'))
    baselineThread().release()
    expect(isRefusal(await p)).toBe(true)
    expect(e.wf.state(card).stage).toBe('hold')
  })

  it('the board closed meanwhile: the start ends, and nothing of it is written', async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Closed', paths: ['a.txt'] })
    const { p } = await heldStart(e, card.key)
    e.store.close()
    baselineThread().release()
    await p.then(
      () => undefined,
      () => undefined
    )
    expect(e.reopen().facts(card.id).some((f) => f.kind === 'Started')).toBe(false)
  })

  it("a submit's paths changed while its unclaimed read waits: refused, evidence changed", async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Submit', paths: ['a.txt'] })
    moved(await e.wf.start(card.key, B1))
    put(e.project, 'a.txt', 'a, edited\n')
    baselineThread().hold()
    const p = e.wf.submit(card.key, B1, { summary: 'x' })
    await until(() => baselineThread().pending === 1)
    e.store.updateCard(card.id, { paths: ['a.txt', 'big'] })
    baselineThread().release()
    refusedBy(await p, 'evidence.changed')
  })

  it("a file edited while another card's read is under way: a later submit reads again and names it (HR3's round 1)", async () => {
    const e = none()
    put(e.project, 'outside.txt', 'o\n')
    const a = e.wf.createCard({ title: 'A', paths: ['a.txt'] })
    const b = e.wf.createCard({ title: 'B', paths: ['b.txt'] })
    moved(await e.wf.start(a.key, B1))
    moved(await e.wf.start(b.key, B2))
    // A's declare reads the project (outside.txt as it was), its answer held.
    const t = baselineThread()
    const held = t.answersHeld
    t.hold({ after: true })
    const declared = e.wf.declarePaths(a.key, B1, ['a.txt'])
    await until(() => t.answersHeld === held + 1)
    // The user edits outside.txt; then B submits its own file.
    put(e.project, 'outside.txt', 'edited by the user\n')
    e.wf.noteWrite('outside.txt', { agents: [], user: true })
    put(e.project, 'b.txt', 'B\n')
    e.wf.noteEdit(b, 'b.txt')
    const submitted = e.wf.submit(b.key, B2, { summary: 'b' })
    await until(() => t.pending === 2)
    t.release()
    await declared
    const r = await submitted
    moved(r)
    expect(((r as { warnings?: string[] }).warnings ?? []).join('\n')).toMatch(/neither its paths .*: outside\.txt\./)
  })

  it('a no-code card with declared paths reads nothing of the project: no hash, no whole-project read, held or not', async () => {
    const e = none()
    const card = e.wf.createCard({ title: 'Decide', kind: 'no-code', paths: ['big', 'a.txt'] })
    const hashes = [vi.spyOn(e.wf.none, 'revision'), vi.spyOn(e.wf.none, 'manifest'), vi.spyOn(e.wf.none, 'deliverables')]
    // Held: a read asked for would never answer, so a start that ends asked for none.
    baselineThread().hold()
    moved(await e.wf.start(card.key, B1))
    expect(baselineThread().pending).toBe(0)
    expect(e.wf.state(card).started).toMatchObject({ base: null, cardKind: 'no-code' })
    expect(e.wf.state(card).started?.deliverables).toBeUndefined()
    const d = await e.wf.declarePaths(card.key, B1, ['big'])
    if (isRefusal(d)) throw new Error(d.message)
    expect(d.unclaimed).toEqual([])
    moved(await e.wf.submit(card.key, B1, { summary: 'decided' }))
    // declarePaths' own revision of what it was given is the only hash (its reply's), never the start's or the evidence's.
    expect(hashes[0].mock.calls.filter((c) => JSON.stringify(c[0]) !== JSON.stringify(['big'])).length).toBe(0)
    expect(hashes[2]).not.toHaveBeenCalled()
    expect(baselineThread().pending).toBe(0)
  })
})
