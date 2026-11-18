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
import { describe, expect, it, vi } from 'vitest'
import { boardFile } from '../src/main/boardStore'
import { FactStore } from '../src/main/workflow/factStore'
import type { AdvanceHost } from '../src/main/platform/adapter'
import { AdvanceJournals, attemptPreMutation, planIdOf, type AdvanceJournal, type AdvancePoint } from '../src/main/platform/jjAdvance'
import { advanceHostOf, supersededKey } from '../src/main/workflow/advanceHost'
import { reconcile } from '../src/main/workflow/reconcile'
import { ADVANCE_UNCERTAIN_GATE, type FactData } from '../src/shared/workflow/facts'
import { TESTED_JJ } from '../src/shared/jjTool'
import { jjExe } from './jjWorkspaceHarness'
import { B1, R1, moved } from './workflow/harness'
import { started, world, type World } from './jjCardsWorld'
import { timing } from './waits'
import { tempDir } from './tempDir'

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

/** Another repository's backing store (a path no repository of this project has). */
const otherStore = (w: World): string => join(w.home, 'elsewhere', '.jj', 'repo', 'store', 'git')
/** A journal with its plan changed, its planId recomputed (AdvanceJournals.read checks it): a valid journal, not an unreadable one. */
const withPlan = (j: AdvanceJournal, plan: Partial<AdvanceJournal['plan']>, attempt = j.attempt): AdvanceJournal => {
  const p = { ...j.plan, ...plan }
  return { ...j, attempt, plan: p, planId: planIdOf(p) }
}
const journalFile = (w: World, card: Card, cycle: number, attempt: string): string => join(journals(w).dir, `${card.key}.${cycle}.${attempt}.json`)
const readJournal = (w: World, card: Card, cycle: number, attempt: string): AdvanceJournal => JSON.parse(readFileSync(journalFile(w, card, cycle, attempt), 'utf8')) as AdvanceJournal

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

describe('AdvanceJournals listing (HI-3367, HR1’s round 1 finding 2): only a missing folder is empty', () => {
  it('a missing folder lists nothing; one that can’t be listed throws, for others() and cardsNamed() alike', async () => {
    const root = tempDir('cw-advance-list-')
    expect(await new AdvanceJournals(join(root, 'none')).others('AM-1', null)).toEqual([])
    expect([...(await new AdvanceJournals(join(root, 'none')).cardsNamed())]).toEqual([])
    // A file where the folder is: readdir fails (not ENOENT).
    writeFileSync(join(root, 'file'), 'x')
    await expect(new AdvanceJournals(join(root, 'file')).others('AM-1', null)).rejects.toThrow()
    await expect(new AdvanceJournals(join(root, 'file')).cardsNamed()).rejects.toThrow()
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
    const ownerOfKey = store.ownerOfKey.bind(store)
    store.ownerOfKey = () => {
      throw new Error('the board is busy')
    }
    const other = w.wf.createCard({ title: 'other' })
    db(w, (d) => d.prepare('UPDATE cards SET archived = 1 WHERE number = ?').run(card.id))
    await recover(w, other)
    expect(live(w)).toHaveLength(1)
    store.ownerOfKey = ownerOfKey
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

  it('the folder is the workspace’s (HR1’s round 1, finding 1): another project’s live journal, and one of a key not known here, are left as they are by this project’s recovery', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    const mine = JSON.parse(readFileSync(join(journals(w).dir, `${card.key}.${cycle1}.${attempt}.json`), 'utf8')) as AdvanceJournal
    // Project B's card on the same board, its attempt live (as while its writer runs, under B's own repository lock).
    const b = FactStore.open(boardFile(w.home), { project: 'other', key: 'BB', projectId: () => 'p-other' })
    const theirs = b.createCard({ title: 'theirs', kind: 'code', labels: [], blockedBy: [] })
    b.close()
    const foreign = (key: string): string => {
      const name = `${key}.7.x1.json`
      const j = withPlan(mine, { card: key, cycle: 7, store: otherStore(w) }, 'x1')
      const text = JSON.stringify(j)
      writeFileSync(join(journals(w).dir, name), text)
      // A valid journal (its planId matches), so it is the ownership and the store that keep it, not unreadability.
      return text
    }
    const theirsText = foreign(theirs.key)
    const unknownText = foreign('ZZ-9')
    expect(await journals(w).read(theirs.key, 7, 'x1')).toMatchObject({ planId: planIdOf(withPlan(mine, { card: theirs.key, cycle: 7, store: otherStore(w) }).plan) })
    // This project's own journal settled so it isn't what the pass is about: restart this card and let it retire.
    await restart(w, card)
    await recover(w, card)
    expect(readFileSync(join(journals(w).dir, `${theirs.key}.7.x1.json`), 'utf8')).toBe(theirsText)
    expect(readFileSync(join(journals(w).dir, 'ZZ-9.7.x1.json'), 'utf8')).toBe(unknownText)
    expect(w.wf.store.meta(supersededKey(theirs.key, 7, 'x1'))).toBeNull()
    // Theirs archived, or gone: still not this project's to touch.
    db(w, (d) => d.prepare('UPDATE cards SET archived = 1 WHERE number = ?').run(theirs.id))
    await recover(w, card)
    expect(readFileSync(join(journals(w).dir, `${theirs.key}.7.x1.json`), 'utf8')).toBe(theirsText)
    db(w, (d) => {
      d.exec('PRAGMA foreign_keys = OFF')
      d.prepare('DELETE FROM cards WHERE number = ?').run(theirs.id)
    })
    await recover(w, card)
    expect(readFileSync(join(journals(w).dir, `${theirs.key}.7.x1.json`), 'utf8')).toBe(theirsText)
    expect(readFileSync(join(journals(w).dir, 'ZZ-9.7.x1.json'), 'utf8')).toBe(unknownText)
  })

  it('a folder that can’t be listed keeps the new cycle busy (no AdvanceAttempted) until it can; then retired with one notice and attempted', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    await restart(w, card)
    await approve(w, card, 'again.txt', { pins: false })
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    const before = facts(w, card, 'AdvanceAttempted').length
    const denied = Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' })
    const spy = vi.spyOn(AdvanceJournals.prototype, 'others').mockRejectedValue(denied)
    try {
      expect(await advanceWith(w, card, advanceHostOf(w.wf))).toBe('busy')
      expect(await advanceWith(w, card, advanceHostOf(w.wf))).toBe('busy')
    } finally {
      spy.mockRestore()
    }
    expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(before)
    expect(live(w).some((n) => n.startsWith(`${card.key}.${cycle1}.`))).toBe(true)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    await advanceWith(w, card, advanceHostOf(w.wf))
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(before + 1)
    expect(notices(w, card)).toEqual(['done'])
  })

  it('HR1’s round 2: ownership read again under the locks: an archived card moved to another project while they were waited for keeps its journal; an active card no longer this project’s is busy, nothing touched', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    const text = readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')
    db(w, (d) => d.prepare('UPDATE cards SET archived = 1 WHERE number = ?').run(card.id))
    const store = w.wf.store
    const ownerOfKey = store.ownerOfKey.bind(store)
    let reads = 0
    // The first read (before the locks) finds it this project's; every read after (under them), another project's.
    store.ownerOfKey = (key: string) => (key === card.key && ++reads > 1 ? { id: card.id, own: false } : ownerOfKey(key))
    try {
      await recover(w, card)
    } finally {
      store.ownerOfKey = ownerOfKey
    }
    expect(reads).toBeGreaterThan(1)
    expect(readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')).toBe(text)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    // Active again, restarted, then moved away (isOwn false) as its advance takes the locks: busy, its journal kept.
    db(w, (d) => d.prepare('UPDATE cards SET archived = 0 WHERE number = ?').run(card.id))
    await restart(w, card)
    await approve(w, card, 'again.txt', { pins: false })
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    const isOwn = store.isOwn.bind(store)
    store.isOwn = (id: number) => (id === card.id ? false : isOwn(id))
    try {
      expect(await advanceWith(w, card, advanceHostOf(w.wf))).toBe('busy')
    } finally {
      store.isOwn = isOwn
    }
    expect(readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')).toBe(text)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
  })

  it('HR1’s round 2: a valid journal of another repository on this project’s card (moved here) is never retired, on the active (earlier cycle) and the archived paths, and doesn’t hold the new cycle', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    // Its plan names another repository's store: written by that repository's writer, under that repository's lock.
    writeFileSync(journalFile(w, card, cycle1, attempt), JSON.stringify(withPlan(readJournal(w, card, cycle1, attempt), { store: otherStore(w) })))
    const text = readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')
    expect(await journals(w).read(card.key, cycle1, attempt)).not.toBe('unreadable')
    // Archived in the same cycle: kept.
    db(w, (d) => d.prepare('UPDATE cards SET archived = 1 WHERE number = ?').run(card.id))
    await recover(w, card)
    expect(readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')).toBe(text)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    // Active, restarted: an earlier cycle's journal of another store, kept; the new cycle attempted all the same.
    db(w, (d) => d.prepare('UPDATE cards SET archived = 0 WHERE number = ?').run(card.id))
    await restart(w, card)
    await approve(w, card, 'again.txt', { pins: false })
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    const before = facts(w, card, 'AdvanceAttempted').length
    await advanceWith(w, card, advanceHostOf(w.wf))
    expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(before + 1)
    expect(readFileSync(journalFile(w, card, cycle1, attempt), 'utf8')).toBe(text)
    expect(marked(w, card, cycle1, attempt)).toBe(false)
    expect(notices(w, card)).toEqual([])
  })

  it('an earlier journal that can’t be read (its store unknown): its notice given once, the file left live, the new cycle not held', async () => {
    const { w, card, cycle1, attempt } = await crashedAt('crash:afterIntegrate')
    writeFileSync(journalFile(w, card, cycle1, attempt), '{ not json')
    await restart(w, card)
    // Recovery's listing passes over a file it can't parse (no lock taken for it); the card's next settling finds it.
    await approve(w, card, 'again.txt', { pins: false })
    await jjp(w, card).reconcile(w.wf.store.card(card.id), {})
    const before = facts(w, card, 'AdvanceAttempted').length
    await advanceWith(w, card, advanceHostOf(w.wf))
    expect(marked(w, card, cycle1, attempt)).toBe(true)
    expect(notices(w, card)).toEqual(['done'])
    expect(existsSync(journalFile(w, card, cycle1, attempt))).toBe(true)
    expect(facts(w, card, 'AdvanceAttempted')).toHaveLength(before + 1)
    await recover(w, card)
    await pass(w, card)
    expect(notices(w, card)).toEqual(['done'])
  })
})
