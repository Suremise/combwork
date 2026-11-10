// A jj slot's preparation for a card on the real jj (HI-2866, J9a; design HI-2866/s7, s10, s13, HR1's): the port's owned,
// journalled `prepare` and `detach`, and `line` answered from the slot's completed binding, in both Git-backed modes.
// The bindings live in a board_meta table (an in-memory database through the app's own store, jjSlotPrep.ts).
// - A card cycle prepared: the slot on its base, its key the line; again: nothing written.
// - One lane's lease, two cards: B prepared once A's submitted work is in the target; A's late settle never matches B.
// - A card's next cycle under the same lease: the old cycle's late settle never matches.
// - Refused before any write: A's work not in the target, extra work beyond what A submitted, the fence lost, the folder
//   replaced, the binding changed by another preparation meanwhile; nothing in the slot changes.
// - A detach after Done: the slot put back on the target's head; the target moving first refuses it.
// - Crashes: before the write, and after it before publication: resumed, without a second write.
// - HR1's round 1: a fence lost or a late writer while the `writing` record is saved writes nothing; a fence lost while
//   `written` is saved publishes nothing (the holder's next attempt confirms and publishes); a later attempt taking the
//   journal over refuses this one's publication. A crash before the write then a foreign `jj new` on the same base is
//   rewritten by its own marked write, never taken for it; a crash after it then another operation is confirmed, and an
//   unchanged retry writes nothing; then an unrecorded edit or a foreign write in the slot is uncertain, never published.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { gitHistory } from '../src/main/platform/gitHistory'
import { readOpHeads } from '../src/main/platform/jjView'
import { boardPrepStore, jjLineKey, type JjBinding, type JjPrepStore } from '../src/main/platform/jjSlotPrep'
import type { WorkspaceFence, WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { harness, jjExe } from './jjWorkspaceHarness'

if (!jjExe) console.warn(`jjSlotPrepReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const yes: WorkspaceFence = { still: () => true }

/** board_meta in memory, behind the app's store (one transaction per write). */
function memoryStore(): JjPrepStore {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return boardPrepStore({
    read: (fn) => fn(db as never),
    write: async (fn) => {
      db.exec('BEGIN')
      try {
        const r = fn(db as never)
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    }
  })
}

describe.skipIf(!jjExe)(`jj slot preparation on the real jj (${TESTED_JJ.version}), HI-2866`, () => {
  const h = harness()

  async function world(colocated: boolean) {
    const store = memoryStore()
    let prepStore: JjPrepStore = store
    const port = h.portWith({ prep: () => prepStore, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at) })
    const { repo, root } = h.repo(`prep${colocated ? 'c' : 'n'}`, colocated)
    const main = (): string => h.id(repo, 'main')
    const slot = join(root, 'slot-a')
    expect((await port.create(repo, slot, main())).ok).toBe(true)
    const identity = (await port.identity!(slot))!
    const ws = identity.workspace
    const key = (card: number, cycle: number): string => jjLineKey(ws, card, cycle)
    const wc = (): string => h.jj(slot, '--ignore-working-copy', 'log', '--no-graph', '-r', `${ws}@`, '-T', 'commit_id ++ " " ++ empty ++ " " ++ parents.map(|p| p.commit_id()).join(",")').trim()
    const pointer = (): JjBinding | null | 'unreadable' => store.pointer(identity.store, ws)
    /** The card's work: a commit made in the slot (an agent's `jj commit`). */
    const work = (file: string): string => {
      writeFileSync(join(slot, file), `${file}\n`)
      h.jj(slot, 'commit', '-m', file)
      return h.id(slot, `${ws}@-`)
    }
    /** The user integrates: main moved onto the card's work (plain jj). */
    const integrate = (rev: string): void => void h.jj(repo, 'bookmark', 'set', 'main', '-r', rev, '--allow-backwards')
    return { store, setStore: (s: JjPrepStore) => (prepStore = s), port, repo, slot, identity, ws, key, main, wc, pointer, work, integrate, heads: () => readOpHeads(join(repo, '.jj', 'repo')) }
  }
  type World = Awaited<ReturnType<typeof world>>
  const prepareFor = (w: World, card: number, cycle: number, o: { lease?: string; fence?: WorkspaceFence; identity?: WorkspaceIdentity } = {}) => w.port.prepare(w.slot, w.key(card, cycle), w.main(), { identity: o.identity ?? w.identity, fence: o.fence ?? yes, lease: o.lease ?? 'L1', target: 'main' })

  describe.each([true, false] as const)('colocated: %s', (colocated) => {
    it("a card cycle prepared: the slot on its base, its key the slot's line; again, nothing written", async () => {
      const w = await world(colocated)
      expect(await w.port.line(w.slot)).toBeNull()
      expect(await prepareFor(w, 1, 5)).toEqual({ ok: true, err: '' })
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      const [, empty, parents] = w.wc().split(' ')
      expect(empty).toBe('true')
      expect(parents).toBe(w.main())
      const heads = w.heads()
      expect(await prepareFor(w, 1, 5)).toEqual({ ok: true, err: '' })
      expect(w.heads()).toEqual(heads)
      expect(await w.port.lineHead(w.repo, w.key(1, 5))).toBeNull()
    })

    it("one lane's lease, two cards: B once A's submitted work is in the target; A's late settle never matches B", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      const R = w.work('a.txt')
      expect(await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity)).toBe(true)
      // Not in the target yet: B refused, nothing changed.
      const before = w.wc()
      expect((await prepareFor(w, 2, 7)).err).toMatch(/isn't in its target/)
      expect(w.wc()).toBe(before)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      // The user integrates: now B (the same lease) is prepared on main.
      w.integrate(R)
      expect(await prepareFor(w, 2, 7)).toEqual({ ok: true, err: '' })
      expect(await w.port.line(w.slot)).toBe(w.key(2, 7))
      // A's late settle (its own line): not B's binding, refused; B untouched.
      const atB = w.wc()
      const late = await w.port.detach(w.slot, w.main(), { identity: w.identity, fence: yes, settles: w.key(1, 5), target: 'main' })
      expect(late.ok).toBe(false)
      expect(w.wc()).toBe(atB)
      expect(w.pointer()).toMatchObject({ key: w.key(2, 7), lease: 'L1' })
    })

    it("a card's next cycle under the same lease: the old cycle's late settle never matches it", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      expect(await prepareFor(w, 1, 9)).toEqual({ ok: true, err: '' })
      expect(await w.port.line(w.slot)).toBe(w.key(1, 9))
      expect((await w.port.detach(w.slot, w.main(), { identity: w.identity, fence: yes, settles: w.key(1, 5), target: 'main' })).ok).toBe(false)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 9))
    })

    it('refused before any write: extra work beyond what the card submitted, a lost fence, a replaced folder, a binding changed meanwhile', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      const R = w.work('a.txt')
      await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity)
      w.integrate(R)
      w.work('more.txt')
      const extra = w.wc()
      expect((await prepareFor(w, 2, 7)).err).toMatch(/holds work/)
      expect(w.wc()).toBe(extra)
      const w2 = await world(colocated)
      await prepareFor(w2, 1, 5)
      let calls = 0
      const losing: WorkspaceFence = { still: () => ++calls < 3 }
      const at = w2.wc()
      expect((await prepareFor(w2, 1, 6, { fence: losing })).ok).toBe(false)
      expect(w2.wc()).toBe(at)
      expect((await prepareFor(w2, 1, 6, { identity: { ...w2.identity, generation: 'another' } })).ok).toBe(false)
      expect(w2.wc()).toBe(at)
      // Another preparation publishes while this one is between its check and its write: superseded, the slot untouched.
      let n = 0
      const racing: WorkspaceFence = {
        still: async () => {
          if (++n === 3) {
            const now = w2.store.pointer(w2.identity.store, w2.ws) as JjBinding
            await w2.store.publish(w2.identity.store, w2.ws, now, { ...now, prep: '9.9', key: w2.key(9, 9) }, { kind: 'prepare', prep: '9.9', next: { ...now, prep: '9.9', key: w2.key(9, 9) }, prev: now, phase: 'planned' })
          }
          return true
        }
      }
      const r = await prepareFor(w2, 1, 6, { fence: racing })
      expect(r.ok).toBe(false)
      expect(w2.wc()).toBe(at)
      expect(w2.pointer()).toMatchObject({ key: w2.key(9, 9) })
    })

    it("a detach after Done: back on the target's head; the target moving first refuses it, nothing written", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      const R = w.work('a.txt')
      await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity)
      w.integrate(R)
      const old = w.main()
      // The target moves on (the user's next commit on main) after the caller read it: refused.
      h.jj(w.repo, 'new', 'main', '-m', 'next')
      writeFileSync(join(w.repo, 'n.txt'), 'n\n')
      h.jj(w.repo, 'commit', '-m', 'next')
      h.jj(w.repo, 'bookmark', 'set', 'main', '-r', '@-')
      const at = w.wc()
      expect((await w.port.detach(w.slot, old, { identity: w.identity, fence: yes, settles: w.key(1, 5), target: 'main' })).err).toMatch(/changed since the check/)
      expect(w.wc()).toBe(at)
      expect(await w.port.detach(w.slot, w.main(), { identity: w.identity, fence: yes, settles: w.key(1, 5), target: 'main' })).toEqual({ ok: true, err: '' })
      expect(await w.port.line(w.slot)).toBeNull()
      expect(w.wc().split(' ')[2]).toBe(w.main())
      expect(w.pointer()).toMatchObject({ key: null, base: w.main() })
    })

    it('crashes: before the write, and after it before publication, each resumed without a second write', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      // Before the write: the journal's `writing` record never lands.
      let once = true
      w.setStore({ ...w.store, writeJournal: async (s, ws, j) => { if (j.phase === 'writing' && once) { once = false; throw new Error('crash') } return w.store.writeJournal(s, ws, j) } })
      const at = w.wc()
      await expect(prepareFor(w, 1, 6)).rejects.toThrow('crash')
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      w.setStore(w.store)
      expect(await prepareFor(w, 1, 6)).toEqual({ ok: true, err: '' })
      // After the write, before publication: the pointer still the previous binding; resumed by reading back.
      let crash = true
      w.setStore({ ...w.store, publish: async (...a) => { if (crash) { crash = false; throw new Error('crash') } return w.store.publish(...a) } })
      await expect(prepareFor(w, 1, 7)).rejects.toThrow('crash')
      expect(await w.port.line(w.slot)).toBe(w.key(1, 6))
      const written = w.wc()
      w.setStore(w.store)
      expect(await prepareFor(w, 1, 7)).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(written)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 7))
    })

    it("the journal's awaits (HR1): a fence lost or a late writer while `writing` is saved writes nothing; lost while `written` is saved publishes nothing", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      let holding = true
      const fence: WorkspaceFence = { still: () => holding }
      const onSave = (phase: string, then: () => void): void => {
        w.setStore({ ...w.store, writeJournal: async (s, ws, j) => { await w.store.writeJournal(s, ws, j); if (j.phase === phase) then() } })
      }
      // The fence lost while the `writing` record is saved: refused before jj runs.
      onSave('writing', () => (holding = false))
      const at = w.wc()
      const heads = w.heads()
      expect((await prepareFor(w, 1, 6, { fence })).err).toMatch(/no longer holds/)
      expect(w.heads()).toEqual(heads)
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      // A late writer (another process's operation) while it is saved: the head moved, refused before jj runs.
      holding = true
      onSave('writing', () => void h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'late'))
      expect((await prepareFor(w, 1, 6, { fence })).err).toMatch(/changed since the check/)
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      // The fence lost while the `written` record is saved: the write landed but isn't published; the holder's next
      // attempt confirms it and publishes, with no second write.
      onSave('written', () => (holding = false))
      expect((await prepareFor(w, 1, 7, { fence })).err).toMatch(/no longer holds/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      const written = w.wc()
      expect(written).not.toBe(at)
      expect(w.store.journal(w.identity.store, w.ws, '1.7')).toMatchObject({ phase: 'written' })
      holding = true
      w.setStore(w.store)
      const before = w.heads()
      expect(await prepareFor(w, 1, 7, { fence })).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(written)
      expect(w.heads()).toEqual(before)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 7))
      // A later attempt takes the preparation over while `written` is saved: this one's publication is refused.
      onSave('written', () => {
        const j = w.store.journal(w.identity.store, w.ws, '1.8')
        if (j && j !== 'unreadable') void w.store.writeJournal(w.identity.store, w.ws, { ...j, run: 'a-later-attempt' })
      })
      expect((await prepareFor(w, 1, 8, { fence })).err).toMatch(/binding changed/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 7))
    })

    it('crashes beside foreign operations (HR1): before the write then a foreign `jj new` on the base, rewritten as its own; after it then another operation, confirmed; then an edit or a foreign write, uncertain', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      const crashAt = (phase: string): void => {
        let once = true
        w.setStore({ ...w.store, writeJournal: async (s, ws, j) => { if (j.phase === phase && once) { once = false; if (phase === 'writing') await w.store.writeJournal(s, ws, j); throw new Error('crash') } return w.store.writeJournal(s, ws, j) } })
      }
      // Crashed after `writing` was journalled, before jj ran; then someone's `jj new` on the same base in the slot.
      crashAt('writing')
      await expect(prepareFor(w, 1, 6)).rejects.toThrow('crash')
      w.setStore(w.store)
      h.jj(w.slot, 'new', w.main())
      const foreign = w.wc()
      expect(await prepareFor(w, 1, 6)).toEqual({ ok: true, err: '' })
      expect(w.wc()).not.toBe(foreign)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 6))
      // Crashed after jj ran, before `written` was journalled; then another operation elsewhere: its own write, confirmed.
      crashAt('written')
      await expect(prepareFor(w, 1, 7)).rejects.toThrow('crash')
      w.setStore(w.store)
      const mine = w.wc()
      h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'other')
      expect(await prepareFor(w, 1, 7)).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(mine)
      // Retried unchanged: idempotent, nothing written.
      const heads = w.heads()
      expect(await prepareFor(w, 1, 7)).toEqual({ ok: true, err: '' })
      expect(w.heads()).toEqual(heads)
      // Crashed after jj ran; then an unrecorded edit in the folder: uncertain, never published, the edit kept; again, still.
      crashAt('written')
      await expect(prepareFor(w, 1, 8)).rejects.toThrow('crash')
      w.setStore(w.store)
      writeFileSync(join(w.slot, 'late.txt'), 'late\n')
      expect((await prepareFor(w, 1, 8)).err).toMatch(/couldn't be read back/)
      expect((await prepareFor(w, 1, 8)).err).toMatch(/couldn't be read back/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 7))
      expect(readFileSync(join(w.slot, 'late.txt'), 'utf8')).toBe('late\n')
      // Crashed after jj ran; then someone's `jj new` on the same base replaced the slot's working copy: uncertain.
      const w2 = await world(colocated)
      await prepareFor(w2, 1, 5)
      let once = true
      w2.setStore({ ...w2.store, writeJournal: async (s, ws, j) => { if (j.phase === 'written' && once) { once = false; throw new Error('crash') } return w2.store.writeJournal(s, ws, j) } })
      await expect(prepareFor(w2, 1, 6)).rejects.toThrow('crash')
      w2.setStore(w2.store)
      h.jj(w2.slot, 'new', w2.main())
      expect((await prepareFor(w2, 1, 6)).err).toMatch(/couldn't be read back/)
      expect(await w2.port.line(w2.slot)).toBe(w2.key(1, 5))
    })
  })
})
