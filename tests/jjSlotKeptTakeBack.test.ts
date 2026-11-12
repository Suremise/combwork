// A kept jj slot's take-back that fails, is cut short, or finds its folder gone (HI-3032, from HI-3019's hunt; HI-2995's
// kept slot). On the real jj, through the pool, as jjSlotPutBack.test.ts:
// - A: the take-back's install fails once: the slot is kept (dirty, still the card's), and the card's next start gets it;
// - B: the Combwork taking it back is gone mid-way and another takes the operation over: kept, and given back the same;
// - D: its folder gone, seen by a refresh first: the card's start says so ("its folder is gone");
// - C2: a lane that took it back and went on to another card keeps that card's work for that card (HI-3057);
// - F: its workspace forgotten by the user (jj workspace forget), its folder left: said so, and Remove… trashes the
//   folder whole only on the port's fresh proof that jj lists no such workspace (HI-3097).
// Skipped without the fetched jj (npm run jj:fetch).

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardFile, closeBoard, workspaceDb } from '../src/main/boardStore'
import { fileSlotConn, SlotPool, SlotStore, type OpHolder } from '../src/main/slots'
import { gitHistory } from '../src/main/platform/gitHistory'
import { boardPrepStore, jjLineKey } from '../src/main/platform/jjSlotPrep'
import { JJ_REFUSED, type JjPortDeps } from '../src/main/platform/jjWorkspacePort'
import { TESTED_JJ } from '../src/shared/jjTool'
import { admitted } from './admitted'
import { harness, jjExe } from './jjWorkspaceHarness'
import { tempDir } from './tempDir'

if (!jjExe) console.warn(`jjSlotKeptTakeBack.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

const REAL_JJ_MS = 180_000
const closers: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c()
})

type Run = { ok: boolean; exitCode: number; logPath: null; settled: boolean }

function world(colocated = true, more: Partial<JjPortDeps> = {}) {
  const h = harness()
  const { repo, root } = h.repo('keptback', colocated)
  const ws = join(tempDir('keptback-'), 'ws')
  const dismiss = admitted(ws)
  workspaceDb(ws)
  const conn = fileSlotConn(boardFile(ws))
  closers.push(() => {
    conn.close()
    closeBoard(ws)
    dismiss()
  })
  const prep = boardPrepStore(conn)
  const port = h.portWith({ prep: () => prep, contains: (s, t, c, at) => gitHistory.contains(s, t, c, at), ...more })
  const dead = new Set<number>()
  const holderOf = (pid: number): OpHolder => ({ self: async () => ({ pid, started: 1000 + pid }), alive: async (p) => !dead.has(p), live: new Set() })
  // The slot's install (npm ci for the lock file the card's commit added): failing, or held at a gate, as a test says.
  const runs: { fail: boolean; gate: Promise<void> | null; calls: number } = { fail: false, gate: null, calls: 0 }
  const runner = async (): Promise<Run> => {
    runs.calls++
    if (runs.gate) await runs.gate
    return runs.fail ? { ok: false, exitCode: 1, logPath: null, settled: true } : { ok: true, exitCode: 0, logPath: null, settled: true }
  }
  const store = new SlotStore(conn, 'p-jj')
  const poolOf = (pid: number): SlotPool => {
    const pool = new SlotPool({ store, workspaces: port, project: repo, root, options: async () => ({ setup: '', archive: '', copy: '' }), builders: () => 4, cap: () => 4, runner, settle: async () => true, holder: holderOf(pid), sessionIn: () => null })
    closers.push(() => pool.close())
    return pool
  }
  return { h, repo, port, pool: poolOf(1), poolOf, dead, runs, store, main: () => h.id(repo, 'main') }
}
type World = ReturnType<typeof world>

/** Card 1 lent a slot, a commit made there (with a package-lock.json when `lock`), put back: kept for card 1. */
async function putBackWithWork(w: World, lock: boolean): Promise<{ name: string; folder: string; R: string }> {
  const lent = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
  if (!lent.ok) throw new Error(`not lent: ${JSON.stringify(lent)}`)
  const row = w.store.slot(lent.slot.name)!
  const ws = row.identity!.workspace
  expect(await w.pool.prepare(lent.lease.id, { line: jjLineKey(ws, 1, 1), base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
  writeFileSync(join(row.folder, 'one.txt'), 'one\n')
  if (lock) writeFileSync(join(row.folder, 'package-lock.json'), '{"lockfileVersion":3}\n')
  w.h.jj(row.folder, 'commit', '-m', 'card 1 work')
  const R = w.h.id(row.folder, `${ws}@-`)
  expect(await w.port.submitted(row.folder, jjLineKey(ws, 1, 1), [R], row.identity, 1)).toBe(true)
  await w.pool.release(lent.lease.id, 'putBack')
  await w.pool.refresh()
  expect(w.store.slot(row.name)?.state).toBe('dirty')
  expect(w.pool.keptCard(row.name)).toBe(1)
  return { name: row.name, folder: row.folder, R }
}

describe.skipIf(!jjExe)('a kept jj slot taken back (HI-3032)', { timeout: REAL_JJ_MS }, () => {
  it('A: its install fails once: kept for the card, which gets it back with its work next time', async () => {
    const w = world()
    const a = await putBackWithWork(w, true)
    w.runs.fail = true
    const first = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(first).toMatchObject({ ok: false, refusal: { why: 'setupFailed', slot: a.name } })
    expect(w.store.slot(a.name)).toMatchObject({ state: 'dirty', warmError: expect.any(String) })
    expect(w.pool.keptCard(a.name)).toBe(1)
    expect(w.store.openLease(a.name)).toBeNull()
    // Never another card's, never tidied away.
    expect(await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })).toMatchObject({ ok: true, slot: { name: expect.not.stringMatching(new RegExp(`^${a.name}$`)) } })
    w.runs.fail = false
    await w.pool.refresh()
    expect(await w.pool.tidy()).not.toContain(a.name)
    const second = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(second).toMatchObject({ ok: true, slot: { name: a.name } })
    expect(w.store.slot(a.name)?.warmError ?? null).toBeNull()
    expect(w.h.id(a.folder, '@-')).toBe(a.R)
  })

  it.each(['failed', 'interrupted'] as const)('A/B then D: a take-back %s, then its folder deleted: Remove… still names its work, kept in the store', async (how) => {
    const w = world()
    const a = await putBackWithWork(w, true)
    if (how === 'failed') {
      w.runs.fail = true
      expect(await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })).toMatchObject({ ok: false, refusal: { why: 'setupFailed' } })
      w.runs.fail = false
    } else {
      let open: () => void = () => undefined
      w.runs.gate = new Promise<void>((res) => (open = res))
      const before = w.runs.calls
      const going = w.poolOf(2).lend({ card: 1, agent: 'a-1' }, { target: 'main' })
      await expect.poll(() => w.runs.calls, { timeout: 60_000 }).toBeGreaterThan(before)
      w.dead.add(2)
      await w.pool.refresh()
      w.runs.gate = null
      open()
      await going
    }
    // The take-back's own lease, the slot's newest, ended with no head recorded (warm's fail and recover record none):
    // the work's commit is the card's earlier lease's.
    expect(w.store.slot(a.name)?.state).toBe('dirty')
    rmSync(a.folder, { recursive: true, force: true })
    await w.pool.refresh()
    expect(w.store.slot(a.name)?.state).toBe('gone')
    expect(w.pool.keptCommit(a.name)).toBe(a.R)
    expect(await w.pool.removeKeptGone(a.name, w.pool.keptRecord(a.name)!)).toEqual({ ok: true })
    expect(w.h.id(w.repo, a.R)).toBe(a.R)
  })

  it('B: cut short (the Combwork taking it back gone): kept for the card, which gets it back', async () => {
    const w = world()
    const a = await putBackWithWork(w, true)
    // Another Combwork (process 2) takes the slot back for card 1 and is in its install when it dies.
    let open: () => void = () => undefined
    w.runs.gate = new Promise<void>((res) => (open = res))
    const p2 = w.poolOf(2)
    const before = w.runs.calls
    const going = p2.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    await expect.poll(() => w.runs.calls, { timeout: 60_000 }).toBeGreaterThan(before)
    w.dead.add(2)
    await w.pool.refresh()
    expect(w.store.slot(a.name)).toMatchObject({ state: 'dirty', warmError: expect.any(String), op: null })
    expect(w.pool.keptCard(a.name)).toBe(1)
    expect(w.store.openLease(a.name)).toBeNull()
    w.runs.gate = null
    open()
    expect(await going).toMatchObject({ ok: false })
    await w.pool.refresh()
    await w.pool.tidy()
    expect(await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })).toMatchObject({ ok: true, slot: { name: a.name } })
    expect(w.h.id(a.folder, '@-')).toBe(a.R)
  })

  it.each([true, false])('D: its folder gone, seen by a refresh first: the start says so; Remove… ends it (colocated: %s)', async (colocated) => {
    const w = world(colocated)
    const a = await putBackWithWork(w, false)
    rmSync(a.folder, { recursive: true, force: true })
    await w.pool.refresh()
    expect(w.store.slot(a.name)?.state).toBe('gone')
    const again = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(again).toMatchObject({ ok: false, refusal: { slot: a.name, error: expect.stringMatching(/its folder is gone/) } })
    // Ended by the user's Remove… (only the record shown): the slot and its record gone, its submitted commit still in
    // jj's store, and the card no longer refused as kept: lent a fresh slot.
    const rec = w.pool.keptRecord(a.name)!
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: 'another' })).toEqual({ ok: false, why: 'changed' })
    expect(await w.pool.removeKeptGone(a.name, rec)).toEqual({ ok: true })
    expect(w.store.slot(a.name)).toBeNull()
    expect(w.pool.keptCard(a.name)).toBeNull()
    expect(w.h.id(w.repo, a.R)).toBe(a.R)
    const fresh = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    // Colocated too (HI-3046): the Git worktree entry the deleted folder left is proved Combwork's and cleared.
    expect(fresh).toMatchObject({ ok: true })
  })

  it('D: its folder back before Remove…: refused, nothing removed, still kept', async () => {
    const w = world()
    const a = await putBackWithWork(w, false)
    renameSync(a.folder, `${a.folder}-moved-away`)
    await w.pool.refresh()
    const rec = w.pool.keptRecord(a.name)!
    renameSync(`${a.folder}-moved-away`, a.folder)
    expect(await w.pool.removeKeptGone(a.name, rec)).toEqual({ ok: false, why: 'changed' })
    expect(w.store.slot(a.name)).not.toBeNull()
    expect(w.pool.keptCard(a.name)).toBe(1)
    expect(w.h.id(a.folder, '@-')).toBe(a.R)
  })

  it('C: a lane lent for the card takes its kept slot; the lane ending with the work not in main keeps it again', async () => {
    const w = world()
    const a = await putBackWithWork(w, false)
    // A lane lent for another card: never the kept slot.
    const other = await w.pool.lend({ lane: 'lane-0', agent: 'a-0', startsCard: 2 }, { target: 'main' })
    expect(other).toMatchObject({ ok: true })
    expect(other.ok && other.slot.name).not.toBe(a.name)
    const lane = await w.pool.lend({ lane: 'lane-1', agent: 'a-1', startsCard: 1 }, { target: 'main' })
    expect(lane).toMatchObject({ ok: true, slot: { name: a.name }, lease: { kind: 'lane', lane: 'lane-1' } })
    expect(w.h.id(a.folder, '@-')).toBe(a.R)
    // The lane ends (the card's work still not in main): kept for the card again, not lent with no lease.
    await w.pool.release(lane.ok ? lane.lease.id : '', 'laneEnded')
    await w.pool.refresh()
    expect(w.store.slot(a.name)?.state).toBe('dirty')
    expect(w.pool.keptCard(a.name)).toBe(1)
    expect(await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })).toMatchObject({ ok: true, slot: { name: a.name } })
  })

  // HI-3057 (HI-3051's hunt): the lane goes on to card 2 in the slot it took back for card 1, whose work then reaches main.
  // Card 2's work, committed (submitted), committed with an edit beside it, or only an edit, is kept for card 2, which
  // gets the slot back with it; card 1 then starts in another slot.
  it.each([
    [true, 'committed'],
    [false, 'committed'],
    [true, 'committed+edit'],
    [false, 'committed+edit'],
    [true, 'edit'],
    [false, 'edit']
  ] as const)('C2: a lane gone on to its next card keeps that card\'s work for it (colocated: %s, %s)', async (colocated, work) => {
    const w = world(colocated)
    const a = await putBackWithWork(w, false)
    const lane = await w.pool.lend({ lane: 'lane-1', agent: 'a-1', startsCard: 1 }, { target: 'main' })
    expect(lane).toMatchObject({ ok: true, slot: { name: a.name } })
    if (!lane.ok) throw new Error('lane refused')
    w.h.jj(w.repo, 'bookmark', 'set', 'main', '-r', a.R)
    const row = w.store.slot(a.name)!
    const ws = row.identity!.workspace
    expect(await w.pool.prepare(lane.lease.id, { line: jjLineKey(ws, 2, 1), base: w.main(), install: false, target: 'main' })).toMatchObject({ ok: true })
    let R2: string | null = null
    if (work !== 'edit') {
      writeFileSync(join(a.folder, 'two.txt'), 'two\n')
      w.h.jj(a.folder, 'commit', '-m', 'card 2 work')
      R2 = w.h.id(a.folder, '@-')
      expect(await w.port.submitted(a.folder, jjLineKey(ws, 2, 1), [R2], row.identity, 1)).toBe(true)
    }
    if (work !== 'committed') writeFileSync(join(a.folder, 'edit.txt'), 'not committed\n')
    await w.pool.release(lane.lease.id, 'laneEnded')
    await w.pool.refresh()
    expect(w.store.slot(a.name)?.state).toBe('dirty')
    expect(w.pool.keptCard(a.name)).toBe(2)
    expect(w.pool.keptSlotFor(1)).toBeNull()
    // Card 1 (its work in main) starts elsewhere; card 2 gets its slot back, its work in it.
    const one = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(one).toMatchObject({ ok: true })
    expect(one.ok && one.slot.name).not.toBe(a.name)
    expect(await w.pool.lend({ card: 2, agent: 'a-2' }, { target: 'main' })).toMatchObject({ ok: true, slot: { name: a.name } })
    if (R2) expect(w.h.id(a.folder, '@-')).toBe(R2)
    if (work !== 'committed') expect(readFileSync(join(a.folder, 'edit.txt'), 'utf8')).toBe('not committed\n')
  })
})

/**
 * HI-3097: a world whose port's removal of a forgotten workspace can be stepped into (`proof`: before the proof's reads;
 * `trash`: synchronously right before the final head check) and whose trash can fail once; the folders it trashed.
 */
function forgetting(colocated: boolean) {
  const at: { proof: (() => void) | null; trash: (() => void) | null; failTrash: boolean } = { proof: null, trash: null, failTrash: false }
  const bin = tempDir('keptforgot-bin-')
  const trashed: { from: string; to: string }[] = []
  const w = world(colocated, {
    hooks: { beforeForgottenProof: () => at.proof?.(), beforeForgottenTrash: () => at.trash?.() },
    trash: async (p) => {
      if (at.failTrash) {
        at.failTrash = false
        throw new Error('the Recycle Bin refused it')
      }
      const to = join(bin, `${trashed.length + 1}-${basename(p)}`)
      renameSync(p, to)
      trashed.push({ from: p, to })
    }
  })
  return { w, at, trashed }
}

/** Card 1's kept slot, its workspace then forgotten by the user from the project folder, a refresh seeing it. */
async function forgotten(w: World): Promise<{ name: string; folder: string; R: string; workspace: string; generation: string }> {
  const a = await putBackWithWork(w, false)
  const row = w.store.slot(a.name)!
  const workspace = row.identity!.workspace
  w.h.jj(w.repo, 'workspace', 'forget', workspace)
  await w.pool.refresh()
  expect(w.store.slot(a.name)?.state).toBe('gone')
  expect(existsSync(a.folder)).toBe(true)
  expect(w.pool.keptCard(a.name)).toBe(1)
  return { ...a, workspace, generation: row.identity!.generation }
}

describe.skipIf(!jjExe)('a kept jj slot whose workspace the user forgot (HI-3097)', { timeout: REAL_JJ_MS }, () => {
  it.each([true, false])('F: the start says so; Remove… trashes the folder whole, an edit in it too; the card starts afresh (colocated: %s)', async (colocated) => {
    const { w, trashed } = forgetting(colocated)
    const a = await forgotten(w)
    writeFileSync(join(a.folder, 'edit.txt'), 'not committed\n')
    const start = await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })
    expect(start).toMatchObject({ ok: false, refusal: { slot: a.name, error: expect.stringMatching(/jj no longer lists its workspace/) } })
    expect(await w.pool.keptPreview(1)).toEqual({ wait: expect.stringMatching(/jj no longer lists its workspace/) })
    // The window's record of another generation: refused, nothing removed.
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: 'another' })).toEqual({ ok: false, why: 'changed' })
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: a.generation })).toEqual({ ok: true })
    expect(w.store.slot(a.name)).toBeNull()
    expect(w.pool.keptCard(a.name)).toBeNull()
    expect(existsSync(a.folder)).toBe(false)
    expect(trashed.map((t) => t.from)).toEqual([a.folder])
    expect(readFileSync(join(trashed[0].to, 'edit.txt'), 'utf8')).toBe('not committed\n')
    // The card's commit stays in jj's store; the card starts afresh.
    expect(w.h.id(w.repo, a.R)).toBe(a.R)
    expect(await w.pool.lend({ card: 1, agent: 'a-1' }, { target: 'main' })).toMatchObject({ ok: true })
  })

  it.each([true, false])('F: the workspace listed again after Remove… found it eligible: refused, the folder and the record kept (colocated: %s)', async (colocated) => {
    const { w, at, trashed } = forgetting(colocated)
    const a = await forgotten(w)
    // Its name registered again elsewhere between the pool's read and the port's proof.
    at.proof = () => void w.h.jj(w.repo, 'workspace', 'add', '--name', a.workspace, join(tempDir('keptforgot-again-'), 'again'))
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: a.generation })).toMatchObject({ ok: false, why: 'kept', kept: { why: 'gitRefused', detail: JJ_REFUSED.listed } })
    expect(trashed).toEqual([])
    expect(existsSync(a.folder)).toBe(true)
    expect(w.store.slot(a.name)?.state).toBe('gone')
    expect(w.pool.keptCard(a.name)).toBe(1)
  })

  it.each([true, false])('F: the repository moved between the proof and the trash: refused, the folder kept (colocated: %s)', async (colocated) => {
    const { w, at, trashed } = forgetting(colocated)
    const a = await forgotten(w)
    at.trash = () => void w.h.jj(w.repo, '--ignore-working-copy', 'bookmark', 'create', 'moved-meanwhile', '-r', 'main')
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: a.generation })).toMatchObject({ ok: false, why: 'kept', kept: { why: 'gitRefused', detail: JJ_REFUSED.moved } })
    expect(trashed).toEqual([])
    expect(existsSync(a.folder)).toBe(true)
    expect(w.pool.keptCard(a.name)).toBe(1)
  })

  it.each([
    [true, true],
    [false, true],
    [true, false],
    [false, false]
  ])('F: the trash failing, then Remove… again (colocated: %s, listed again meanwhile: %s): proved afresh', async (colocated, again) => {
    const { w, at, trashed } = forgetting(colocated)
    const a = await forgotten(w)
    at.failTrash = true
    expect(await w.pool.removeKeptGone(a.name, { card: 1, generation: a.generation })).toMatchObject({ ok: false, why: 'kept', kept: { why: 'gitRefused' } })
    expect(existsSync(a.folder)).toBe(true)
    expect(w.store.slot(a.name)?.state).toBe('gone')
    expect(w.pool.keptCard(a.name)).toBe(1)
    // A restart: another Combwork, the same board.
    const p2 = w.poolOf(2)
    if (again) w.h.jj(w.repo, 'workspace', 'add', '--name', a.workspace, join(tempDir('keptforgot-again-'), 'again'))
    const r = await p2.removeKeptGone(a.name, { card: 1, generation: a.generation })
    if (again) {
      // Listed again: no longer eligible (the pool's read sees it), or refused by the port's proof; kept either way.
      expect(r.ok).toBe(false)
      expect(trashed).toEqual([])
      expect(existsSync(a.folder)).toBe(true)
      expect(w.pool.keptCard(a.name)).toBe(1)
    } else {
      expect(r).toEqual({ ok: true })
      expect(trashed.map((t) => t.from)).toEqual([a.folder])
      expect(w.store.slot(a.name)).toBeNull()
    }
  })
})
