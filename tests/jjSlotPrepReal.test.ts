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
// (Each later preparation is another card's, 3 to 5: the same card again on the same base carries its binding, HI-2868.)
// - HR1's round 1: a fence lost or a late writer while the `writing` record is saved writes nothing; a fence lost while
//   `written` is saved publishes nothing (the holder's next attempt confirms and publishes); a later attempt taking the
//   journal over refuses this one's publication. A crash before the write then a foreign `jj new` on the same base is
//   rewritten by its own marked write, never taken for it; a crash after it then another operation is confirmed, and an
//   unchanged retry writes nothing; then an unrecorded edit or a foreign write in the slot is uncertain, never published.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { gitHistory } from '../src/main/platform/gitHistory'
import { readOpHeads } from '../src/main/platform/jjView'
import { boardPrepStore, jjLineKey, type JjBinding, type JjPrepStore } from '../src/main/platform/jjSlotPrep'
import type { WorkspaceFence, WorkspaceIdentity } from '../src/main/platform/workspacePort'
import { checkoutOf, generationOf } from '../src/main/platform/jjWorkspacePort'
import { isUnknown } from '../src/main/platform/types'
import { quiet } from '../src/main/slots'
import { jjFileGate, pathKey, rootKey } from '../src/main/platform/jjFileGate'
import { workspaceGateKeys } from '../src/main/platform/jjRunner'
import { SlotStaleView, type StaleViewRow } from '../src/main/slotStaleView'
import { harness, jjExe } from './jjWorkspaceHarness'

if (!jjExe) console.warn(`jjSlotPrepReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const yes: WorkspaceFence = { still: () => true }

// A hung test's bound (HI-2897), not a time budget: each test runs tens of real jj and Git processes (3–11 s alone on
// jj 0.47.1, up to 16 s for the one HR1 crash test before it was split in four), and several times that under a loaded
// machine or a 2-worker jj run, which Vitest's 20 s default for unit tests doesn't leave room for.
const REAL_JJ_MS = 60_000

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

describe.skipIf(!jjExe)(`jj slot preparation on the real jj (${TESTED_JJ.version}), HI-2866`, { timeout: REAL_JJ_MS }, () => {
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
  /** The next preparation's journal write at `phase` crashes once (`writing`: after it is saved, before jj runs). */
  const crashAt = (w: World, phase: string): void => {
    let once = true
    w.setStore({ ...w.store, writeJournal: async (s, ws, j) => { if (j.phase === phase && once) { once = false; if (phase === 'writing') await w.store.writeJournal(s, ws, j); throw new Error('crash') } return w.store.writeJournal(s, ws, j) } })
  }

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
      expect(await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity, 1)).toBe(true)
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
      await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity, 1)
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
      expect((await prepareFor(w2, 3, 6, { fence: losing })).ok).toBe(false)
      expect(w2.wc()).toBe(at)
      expect((await prepareFor(w2, 3, 6, { identity: { ...w2.identity, generation: 'another' } })).ok).toBe(false)
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
      const r = await prepareFor(w2, 3, 6, { fence: racing })
      expect(r.ok).toBe(false)
      expect(w2.wc()).toBe(at)
      expect(w2.pointer()).toMatchObject({ key: w2.key(9, 9) })
    })

    it("the slot listing's polls don't keep an owed detach from running, and never leave the slot stale (HI-2912)", async () => {
      const w = await world(colocated)
      // The listing's view as slotViews has it, of a row the test keeps as the pool would: an operation while a settle
      // attempt runs, owed after one that found the folder busy, until a settle decides.
      const row: StaleViewRow = { folder: w.slot, state: 'lent', op: null, job: null }
      let owes = false
      const view = new SlotStaleView({ row: () => row, owes: () => owes, read: async (f) => { const r = await w.port.stale(f); return isUnknown(r) ? null : r }, generation: generationOf })
      const tries: number[] = []
      for (let c = 1; c <= 4; c++) {
        expect((await prepareFor(w, 1, c)).ok).toBe(true)
        const R = w.work(`a${c}.txt`)
        await w.port.submitted(w.slot, w.key(1, c), [R], w.identity, 1)
        w.integrate(R)
        // Two listings polling, as jjwindow's wait and the window's Slots and copies do.
        const poll = { on: true }
        const loop = async (): Promise<void> => {
          while (poll.on) {
            await view.staleOf('slot-a')
            // A turn of the event loop between polls (a busy slot's answer needs no await), not a pause.
            await new Promise((res) => setImmediate(res))
          }
        }
        const loops = [loop(), loop()]
        // The settle and its owed retries (each attempt fenced by the folder's quiet, as the pool's is), at most 5.
        let n = 0
        let r = { ok: false, err: '' }
        while (!r.ok && n < 5) {
          n++
          row.op = { token: `settle-${c}-${n}` }
          r = await w.port.detach(w.slot, w.main(), { identity: w.identity, fence: { still: () => quiet(w.slot) }, settles: w.key(1, c), target: 'main' })
          row.op = null
          if (!r.ok) owes = true
        }
        owes = false
        poll.on = false
        await Promise.all(loops)
        tries.push(r.ok ? n : -1)
        expect(await w.port.stale(w.slot)).toBe(false)
      }
      // Before (the listing reading whatever the slot's state): every attempt refused, the folder in use (HI-2912).
      expect(tries.every((t) => t > 0), `attempts per detach: ${JSON.stringify(tries)}`).toBe(true)
    })

    it("a write's real owned guard runs under its admission (its checkout read through its ticket); ownership lost while queued writes nothing (HI-2918)", async () => {
      const w = await world(colocated)
      const keys = (await workspaceGateKeys(w.slot))!
      // Queued behind a reader of the slot's checkout; its fence lost while it waits: its recheck refuses, nothing runs.
      let owned = true
      const reader = await jjFileGate.acquire([keys.root], 'shared')
      const lost = prepareFor(w, 1, 1, { fence: { still: () => owned } })
      await expect.poll(() => jjFileGate.writing(keys.root), { timeout: 60_000 }).toBe(true)
      const heads = w.heads()?.join()
      owned = false
      reader.release()
      expect((await lost).ok).toBe(false)
      expect(w.heads()?.join()).toBe(heads)
      // Kept: the preparation's guards (owns → checkoutOf) read through their tickets, no wait behind their own write.
      const reader2 = await jjFileGate.acquire([keys.root], 'shared')
      const kept = prepareFor(w, 1, 2)
      await expect.poll(() => jjFileGate.writing(keys.root), { timeout: 60_000 }).toBe(true)
      reader2.release()
      expect(await kept).toMatchObject({ ok: true })
      expect(jjFileGate.size).toBe(0)
    })

    it("a held recovery's shape as a recheck: its rename probe finds the slot quiet while a Combwork reader waits outside (HI-2918, HI-2913)", async () => {
      const w = await world(colocated)
      const keys = (await workspaceGateKeys(w.slot))!
      const first = await jjFileGate.acquire([keys.root], 'shared')
      const seen: { checkout: unknown; quiet: boolean | null } = { checkout: null, quiet: null }
      const write = h.runner.run(w.slot, ['status'], {
        write: true,
        recheck: async () => {
          // Slow reads first, then the probe, then a proof (HB5's order): the reader outside is queued, holding nothing.
          seen.checkout = await checkoutOf(w.slot)
          seen.quiet = await quiet(w.slot)
          return seen.quiet ? null : 'the folder is in use'
        }
      })
      await expect.poll(() => jjFileGate.writing(keys.root), { timeout: 60_000 }).toBe(true)
      // A Combwork reader outside the write's call tree: queued behind it (writers first).
      const outside = checkoutOf(w.slot)
      first.release()
      expect((await write).ok).toBe(true)
      expect(seen.quiet).toBe(true)
      expect(seen.checkout).not.toBeNull()
      expect(await outside).not.toBeNull()
      expect(jjFileGate.size).toBe(0)
    })

    it("workspace add holds its destination for its whole run: a reader of it waits, then reads the made workspace (HI-2918)", async () => {
      const w = await world(colocated)
      const dest = join(dirname(w.slot), 'slot-b')
      const destKey = rootKey((await pathKey(dest))!)
      const made = w.port.create(w.repo, dest, w.main())
      let seenHeld = false
      let read: Promise<unknown> | null = null
      // Until the add has the destination: then a reader of it is started (its folder may already be there).
      for (let settled = false; !settled; ) {
        if (jjFileGate.writing(destKey)) {
          seenHeld = true
          read ??= checkoutOf(dest)
        }
        settled = await Promise.race([made.then(() => true), new Promise<boolean>((res) => setImmediate(() => res(false)))])
      }
      expect((await made).ok).toBe(true)
      expect(seenHeld).toBe(true)
      expect(await read).not.toBeNull()
      expect(await pathKey(dest)).toBe(destKey.slice('root:'.length))
      expect(jjFileGate.size).toBe(0)
    })

    it("a detach after Done: back on the target's head; the target moving first refuses it, nothing written", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      const R = w.work('a.txt')
      await w.port.submitted(w.slot, w.key(1, 5), [R], w.identity, 1)
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
      await expect(prepareFor(w, 3, 6)).rejects.toThrow('crash')
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      w.setStore(w.store)
      expect(await prepareFor(w, 3, 6)).toEqual({ ok: true, err: '' })
      // After the write, before publication: the pointer still the previous binding; resumed by reading back.
      let crash = true
      w.setStore({ ...w.store, publish: async (...a) => { if (crash) { crash = false; throw new Error('crash') } return w.store.publish(...a) } })
      await expect(prepareFor(w, 4, 7)).rejects.toThrow('crash')
      expect(await w.port.line(w.slot)).toBe(w.key(3, 6))
      const written = w.wc()
      w.setStore(w.store)
      expect(await prepareFor(w, 4, 7)).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(written)
      expect(await w.port.line(w.slot)).toBe(w.key(4, 7))
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
      expect((await prepareFor(w, 3, 6, { fence })).err).toMatch(/no longer holds/)
      expect(w.heads()).toEqual(heads)
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      // A late writer (another process's operation) while it is saved: the head moved, refused before jj runs.
      holding = true
      onSave('writing', () => void h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'late'))
      expect((await prepareFor(w, 3, 6, { fence })).err).toMatch(/changed since the check/)
      expect(w.wc()).toBe(at)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      // The fence lost while the `written` record is saved: the write landed but isn't published; the holder's next
      // attempt confirms it and publishes, with no second write.
      onSave('written', () => (holding = false))
      expect((await prepareFor(w, 4, 7, { fence })).err).toMatch(/no longer holds/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      const written = w.wc()
      expect(written).not.toBe(at)
      expect(w.store.journal(w.identity.store, w.ws, '4.7')).toMatchObject({ phase: 'written' })
      holding = true
      w.setStore(w.store)
      const before = w.heads()
      expect(await prepareFor(w, 4, 7, { fence })).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(written)
      expect(w.heads()).toEqual(before)
      expect(await w.port.line(w.slot)).toBe(w.key(4, 7))
      // A later attempt takes the preparation over while `written` is saved: this one's publication is refused.
      onSave('written', () => {
        const j = w.store.journal(w.identity.store, w.ws, '5.8')
        if (j && j !== 'unreadable') void w.store.writeJournal(w.identity.store, w.ws, { ...j, run: 'a-later-attempt' })
      })
      expect((await prepareFor(w, 5, 8, { fence })).err).toMatch(/binding changed/)
      expect(await w.port.line(w.slot)).toBe(w.key(4, 7))
    })

    // HR1's crashes beside foreign operations, a case each (HI-2897: one test of the four took 15–18 s alone, near the
    // file's bound): each prepares card 1's cycle 5, then crashes the next preparation where it says.
    it('crash before the write, then a foreign `jj new` on the base in the slot: rewritten as its own (HR1)', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      // Crashed after `writing` was journalled, before jj ran; then someone's `jj new` on the same base in the slot.
      crashAt(w, 'writing')
      await expect(prepareFor(w, 3, 6)).rejects.toThrow('crash')
      w.setStore(w.store)
      h.jj(w.slot, 'new', w.main())
      const foreign = w.wc()
      expect(await prepareFor(w, 3, 6)).toEqual({ ok: true, err: '' })
      expect(w.wc()).not.toBe(foreign)
      expect(await w.port.line(w.slot)).toBe(w.key(3, 6))
    })

    it('crash after the write, then another operation elsewhere: its own write, confirmed; retried unchanged, nothing written (HR1)', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      // Crashed after jj ran, before `written` was journalled; then another operation elsewhere: its own write, confirmed.
      crashAt(w, 'written')
      await expect(prepareFor(w, 4, 7)).rejects.toThrow('crash')
      w.setStore(w.store)
      const mine = w.wc()
      h.jj(w.repo, '--ignore-working-copy', 'new', 'main', '--no-edit', '-m', 'other')
      expect(await prepareFor(w, 4, 7)).toEqual({ ok: true, err: '' })
      expect(w.wc()).toBe(mine)
      expect(await w.port.line(w.slot)).toBe(w.key(4, 7))
      // Retried unchanged: idempotent, nothing written.
      const heads = w.heads()
      expect(await prepareFor(w, 4, 7)).toEqual({ ok: true, err: '' })
      expect(w.heads()).toEqual(heads)
    })

    it('crash after the write, then an unrecorded edit in the folder: uncertain, never published, the edit kept (HR1)', async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      // Crashed after jj ran; then an unrecorded edit in the folder: uncertain, never published, the edit kept; again, still.
      crashAt(w, 'written')
      await expect(prepareFor(w, 5, 8)).rejects.toThrow('crash')
      w.setStore(w.store)
      writeFileSync(join(w.slot, 'late.txt'), 'late\n')
      expect((await prepareFor(w, 5, 8)).err).toMatch(/couldn't be read back/)
      expect((await prepareFor(w, 5, 8)).err).toMatch(/couldn't be read back/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
      expect(readFileSync(join(w.slot, 'late.txt'), 'utf8')).toBe('late\n')
    })

    it("crash after the write, then a foreign `jj new` on the same base replaced the slot's working copy: uncertain (HR1)", async () => {
      const w = await world(colocated)
      await prepareFor(w, 1, 5)
      crashAt(w, 'written')
      await expect(prepareFor(w, 3, 6)).rejects.toThrow('crash')
      w.setStore(w.store)
      h.jj(w.slot, 'new', w.main())
      expect((await prepareFor(w, 3, 6)).err).toMatch(/couldn't be read back/)
      expect(await w.port.line(w.slot)).toBe(w.key(1, 5))
    })
  })
})
