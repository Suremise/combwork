// HI-3367: a card's unsettled jj advance journal from an earlier cycle (the card put back and restarted), or of a card
// archived or gone, is retired from the live folder: marked superseded on the card first, in one write with a comment when
// it may have moved its target, then archived whole in settled/. Before, a new Started dropped the attempt's question and
// its journal stayed live for good: every reconcile took the card's lock and the repository lock to settle nothing.
// - the retirement runs in settleAdvances, under the card's lock and the repository lock, before any attempt or preview of
//   the new cycle: its marker and comment action are committed before the new cycle's AdvanceAttempted;
// - what warns: anything not positively before the integrate (a crash at integrating, after the export, an undo begun);
// - crash safety: a board write that fails keeps the journal live and the new cycle busy; an archive that fails is
//   archived by the next pass with no second comment; the comment is delivered exactly once;
// - an archived card's journals are retired whole, its archived state rechecked under its locks; a gone card's are
//   archived with nothing said; a board read that fails keeps them; the current cycle's journals are never touched.
// One Git-backed mode (colocated): the retirement is the adapter's and the journals', not jj's.
// Skipped without the fetched jj (npm run jj:fetch); with CW_JJ_REAL=1 its absence fails.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { boardFile } from '../src/main/boardStore'
import type { AdvanceHost } from '../src/main/platform/adapter'
import { AdvanceJournals, attemptPreMutation, type AdvanceJournal, type AdvancePoint } from '../src/main/platform/jjAdvance'
import { advanceHostOf, supersededKey } from '../src/main/workflow/advanceHost'
import { reconcile } from '../src/main/workflow/reconcile'
import { ADVANCE_UNCERTAIN_GATE, type FactData } from '../src/shared/workflow/facts'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjExe } from './jjWorkspaceHarness'
import { B1, R1, moved } from './workflow/harness'
import { started, world, type World } from './jjCardsWorld'
import { timing } from './waits'

if (!jjExe) console.warn(`jjAdvanceSuperseded.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

class Crash extends Error {}

type Card = { id: number; key: string }

/** The card's slot work committed, submitted, reviewed and passed: Approved (its cycle's start already made). */
async function approve(w: World, card: Card, file: string, o: { pins?: boolean } = {}): Promise<void> {
  const a = w.slots['slot-a']
  const st = w.wf.state(w.wf.store.card(card.id)).started!
  w.store.tx((tx) => tx.append(card.id, { kind: 'SlotPrepared', actor: 'combwork', source: 'recorded', data: { lease: st.lease!, line: st.line!, revision: st.base! } } as never))
  writeFileSync(join(a.folder, file), `${file}\n`)
  w.h.jj(a.folder, 'commit', '-m', file)
  moved(await w.wf.submit(card.key, B1, { summary: 'done' }))
  // A restarted cycle's first round names the same pin ref as the earlier cycle's (this world's pins aren't swept): not run.
  if (o.pins !== false) await w.runPins(card.id)
  moved(await w.wf.startReview(card.key, R1))
  moved(await w.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(w.wf.state(w.wf.store.card(card.id)).stage).toBe('approved')
  w.h.jj(w.repo, 'git', 'export')
}

/** Put back by the user and started again: a new cycle, its slot prepared. */
async function restart(w: World, card: Card): Promise<number> {
  const before = w.wf.state(w.wf.store.card(card.id)).cycle
  // A crash after the integrate left jj's main unexported: exported, as the user would, so the start can read it.
  w.h.jj(w.repo, 'git', 'export')
  expect(await w.wf.move(card.key, 'todo', 'user', { confirm: true, reason: 'again' })).toMatchObject({ ok: true })
  moved(await w.wf.start(card.key, B1))
  expect(await w.prepare(card.id)).toEqual({ ok: true, err: '' })
  const cycle = w.wf.state(w.wf.store.card(card.id)).cycle
  expect(cycle).toBeGreaterThan(before)
  return cycle
}

const journals = (w: World): AdvanceJournals => new AdvanceJournals(join(w.home, '.combwork', 'jj-advance'))
const live = (w: World): string[] => (existsSync(journals(w).dir) ? readdirSync(journals(w).dir).filter((n) => n.endsWith('.json')) : [])
const facts = <K extends keyof FactData>(w: World, card: Card, kind: K): FactData[K][] => w.store.facts(card.id).filter((f) => f.kind === kind).map((f) => f.data as FactData[K])
const jjp = (w: World, card: Card) => w.wf.platformOf(w.wf.store.card(card.id))
const pass = async (w: World, card: Card): Promise<void> => {
  await reconcile(w.wf, w.wf.store.card(card.id), {})
  await w.wf.runActions()
}
const recover = async (w: World, card: Card, host: AdvanceHost = advanceHostOf(w.wf)): Promise<void> => {
  await jjp(w, card).recoverAdvances!(host)
  await w.wf.runActions()
}
const advanceWith = async (w: World, card: Card, host: AdvanceHost) => {
  const out = await jjp(w, card).advance!(w.wf.store.card(card.id), w.wf.state(w.wf.store.card(card.id)), host)
  await w.wf.runActions()
  return out
}
/** The board, on a connection of its own. */
function db<T>(w: World, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(boardFile(w.home))
  try {
    return fn(d)
  } finally {
    d.close()
  }
}
/** The card's superseded notices (its comment actions saying so), with their states: delivered once each is `done`. */
const notices = (w: World, card: Card): string[] =>
  db(w, (d) => (d.prepare("SELECT state, payload FROM card_actions WHERE card = ? AND kind = 'comment'").all(card.id) as { state: string; payload: string }[]).filter((r) => r.payload.includes('was never settled')).map((r) => r.state))
const marked = (w: World, card: Card, cycle: number, attempt: string): boolean => !!w.wf.store.meta(supersededKey(card.key, cycle, attempt))
/** The card's journals superseded, from settled/ (every cycle). */
const superseded = (w: World, card: Card): AdvanceJournal[] => {
  const dir = join(journals(w).dir, 'settled')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${card.key}.`))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as AdvanceJournal)
    .filter((j) => j.settled === 'superseded')
}

/** A card Approved whose advance crashed at `point` (its journal left live, unsettled); `ask`: a pass after, asking its question. */
async function crashedAt(point: AdvancePoint, o: { ask?: boolean } = {}) {
  let crashed = false
  const w = await world(true, {
    candidates: true,
    oneSlot: true,
    advance: true,
    advanceHook: (p) => {
      if (p === point && !crashed) {
        crashed = true
        throw new Crash()
      }
    }
  })
  const card = await started(w, 'jj work')
  await approve(w, card, 'work.txt')
  const cycle1 = w.wf.state(card).cycle
  await expect(pass(w, card)).rejects.toBeInstanceOf(Crash)
  if (o.ask) await pass(w, card)
  const [name] = live(w)
  expect(name, 'the crashed attempt’s journal, live').toBeTruthy()
  const attempt = name.slice(`${card.key}.${cycle1}.`.length, -'.json'.length)
  return { w, card, cycle1, attempt }
}

describe('attemptPreMutation (HI-3367): only a journal positively before the integrate needs no notice', () => {
  const j = (phase: string, undos: unknown = []): AdvanceJournal => ({ v: 1, attempt: 'a', planId: 'p', plan: {} as never, phase: phase as never, undos: undos as never })
  it('before integrating, with no undo or only undos before their revert: pre-mutation', () => {
    for (const p of ['requested', 'abandoned', 'confirmed', 'based', 'preparing', 'prepared']) expect(attemptPreMutation(j(p)), p).toBe(true)
    expect(attemptPreMutation(j('prepared', [{ undo: 'u', request: 'r', phase: 'undoBased' }]))).toBe(true)
  })
  it('integrating or later, an undo begun, an unknown phase or undo, undos not a list, or unreadable: may have moved', () => {
    for (const p of ['integrating', 'integrated', 'exporting', 'exported', 'verified', 'nonsense']) expect(attemptPreMutation(j(p)), p).toBe(false)
    expect(attemptPreMutation(j('prepared', [{ undo: 'u', request: 'r', phase: 'reverting' }]))).toBe(false)
    expect(attemptPreMutation(j('prepared', [{ undo: 'u', request: 'r', phase: 'mystery' }]))).toBe(false)
    expect(attemptPreMutation(j('prepared', [null]))).toBe(false)
    expect(attemptPreMutation(j('prepared', 'none'))).toBe(false)
    expect(attemptPreMutation({ ...j('prepared'), undos: undefined as never })).toBe(false)
    expect(attemptPreMutation('unreadable')).toBe(false)
  })
})

describe.skipIf(!jjExe)(`a superseded jj advance journal retired (jj ${TESTED_JJ.version}), HI-3367`, { timeout: timing('test.hangRealJj') }, () => {
  it.each([
    ['a crash at integrating (settled absent, the target moved)', 'crash:afterIntegrate', false],
    ['a crash after the export (settled absent, the target at its candidate)', 'exported', false],
    ['an attempt asked as uncertain', 'integrated', true]
  ] as const)('restarted after %s: one notice committed before the new cycle’s attempt, the journal archived whole, delivered once, never read again', async (_name, point, ask) => {
    const { w, card, cycle1, attempt } = await crashedAt(point, { ask })
    if (ask) {
      expect(w.wf.state(w.wf.store.card(card.id)).requests.some((r) => r.gate === ADVANCE_UNCERTAIN_GATE)).toBe(true)
      // The current cycle's journal is never retired: recovery leaves it live, unmarked.
      await recover(w, card)
      expect(live(w)).toHaveLength(1)
      expect(marked(w, card, cycle1, attempt)).toBe(false)
    }
    const cycle2 = await restart(w, card)
    await approve(w, card, 'again.txt', { pins: false })
    // The new cycle's attempt: its marker and comment action already committed when its AdvanceAttempted is written.
    const seen: { marked: boolean; notices: number }[] = []
    const real = advanceHostOf(w.wf)
    const host: AdvanceHost = {
      ...real,
      attempted: async (...a) => {
        seen.push({ marked: marked(w, card, cycle1, attempt), notices: notices(w, card).length })
        return real.attempted(...a)
      }
    }
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    await advanceWith(w, card, host)
    expect(seen[0]).toEqual({ marked: true, notices: 1 })
    // Archived whole: its phase and undos kept, superseded at the new cycle; the live folder holds no earlier cycle.
    const [old] = superseded(w, card)
    expect(old).toMatchObject({ attempt, settled: 'superseded', supersededAt: cycle2 })
    expect(old.plan.cycle).toBe(cycle1)
    expect(old.phase).not.toBe('requested')
    expect(live(w).filter((n) => n.startsWith(`${card.key}.${cycle1}.`))).toEqual([])
    // Delivered exactly once, and never said again by later passes.
    await recover(w, card)
    await pass(w, card)
    expect(notices(w, card)).toEqual(['done'])
  })

  it('a pre-mutation journal (a crash after the base read) is retired with its marker and no notice', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('based')
    await restart(w, card)
    await recover(w, card)
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(notices(w, card)).toEqual([])
    expect(superseded(w, card)).toHaveLength(1)
    expect(live(w)).toEqual([])
  })

  it('an unfinished undo (stopped while reverting) on a journal otherwise before the integrate: retired with one notice', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('based')
    const file = join(journals(w).dir, `${card.key}.${cycle1}.${attempt}.json`)
    const j = JSON.parse(readFileSync(file, 'utf8')) as AdvanceJournal
    writeFileSync(file, JSON.stringify({ ...j, undos: [{ undo: 'u1', request: 'r1', phase: 'reverting' }] }))
    await restart(w, card)
    await recover(w, card)
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(notices(w, card)).toEqual(['done'])
    expect(superseded(w, card)[0].undos).toEqual([{ undo: 'u1', request: 'r1', phase: 'reverting' }])
    expect(live(w)).toEqual([])
  })

  it('the board write failing keeps the journal live and the new cycle busy (no attempt); once it is written, retired with one notice', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    await restart(w, card)
    await approve(w, card, 'again.txt', { pins: false })
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    const failing: AdvanceHost = { ...advanceHostOf(w.wf), superseded: async () => 'failed' }
    const before = facts(w, card, 'AdvanceAttempted').length
    expect(await advanceWith(w, card, failing)).toBe('busy')
    expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(before)
    expect(live(w)).toHaveLength(1)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    await recover(w, card)
    expect(live(w)).toEqual([])
    expect(notices(w, card)).toEqual(['done'])
  })

  it('the archive failing after the board write (as a crash between them): the next pass archives it, with no second notice', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    await restart(w, card)
    // settled/ made unwritable: a file in its place.
    rmSync(join(journals(w).dir, 'settled'), { recursive: true, force: true })
    writeFileSync(join(journals(w).dir, 'settled'), 'not a folder')
    await recover(w, card)
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(live(w)).toHaveLength(1)
    expect(notices(w, card)).toEqual(['done'])
    rmSync(join(journals(w).dir, 'settled'), { force: true })
    await recover(w, card)
    expect(live(w)).toEqual([])
    expect(superseded(w, card)).toHaveLength(1)
    expect(notices(w, card)).toEqual(['done'])
  })

  it('an archived card in the same cycle: its journal retired with one notice on it; unarchived before the recheck, kept live', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    const archive = (on: boolean) => db(w, (d) => d.prepare('UPDATE cards SET archived = ? WHERE number = ?').run(on ? 1 : 0, card.id))
    archive(true)
    // Unarchived between the first read and the recheck under its locks: nothing retired.
    const store = w.wf.store
    const isArchived = store.isArchived.bind(store)
    let reads = 0
    store.isArchived = (id: number) => (id === card.id && ++reads === 2 ? false : isArchived(id))
    await recover(w, card)
    store.isArchived = isArchived
    expect(reads).toBe(2)
    expect(live(w)).toHaveLength(1)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    // Archived through the recheck: retired, its notice on the archived card.
    await recover(w, card)
    expect(live(w)).toEqual([])
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(notices(w, card)).toEqual(['done'])
  })

  it('a gone card’s journal is archived with nothing written; a board read that fails keeps it', async () => {
    const { w, card } = await crashedAt('crash:afterIntegrate')
    const store = w.wf.store
    const cardByKey = store.cardByKey.bind(store)
    store.cardByKey = () => {
      throw new Error('the board is busy')
    }
    const other = w.wf.createCard({ title: 'other' })
    db(w, (d) => d.prepare('UPDATE cards SET archived = 1 WHERE number = ?').run(card.id))
    await recover(w, other)
    expect(live(w)).toHaveLength(1)
    store.cardByKey = cardByKey
    db(w, (d) => {
      d.exec('PRAGMA foreign_keys = OFF')
      d.prepare('DELETE FROM cards WHERE number = ?').run(card.id)
    })
    const metaBefore = db(w, (d) => (d.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE key LIKE '%advance_superseded:%'").get() as { n: number }).n)
    await recover(w, other)
    expect(live(w)).toEqual([])
    expect(db(w, (d) => (d.prepare("SELECT COUNT(*) AS n FROM board_meta WHERE key LIKE '%advance_superseded:%'").get() as { n: number }).n)).toBe(metaBefore)
    mkdirSync(join(journals(w).dir, 'settled'), { recursive: true })
    expect(readdirSync(join(journals(w).dir, 'settled')).some((n) => n.startsWith(`${card.key}.`))).toBe(true)
  })
})
