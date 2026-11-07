// HI-2709: the merge queue honours a card's blockers (SPEC §16.9.1). An approved card blocked by a card that isn't Done
// waits in its queue, shown as waiting on it, while the entries behind it merge; a dependency added at any point before
// its advance begins holds it (in Review, while queued, while it is tested: decided again in the write that begins the
// advance); its blocker into Done runs its queue again, with no new approval. On real temporary repositories.
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { boardFile } from '../../src/main/boardStore'
import { queueLine, queueOrder, queueStateOf } from '../../src/main/workflow/queueState'
import type { CardRecord } from '../../src/main/workflow/factStore'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = () => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' }, commitMessage: 'combwork' }))

/** A card started by B1, committed and submitted: in Review. */
async function submitted(e: Env, title: string, file: string, blockedBy: number[] = []): Promise<CardRecord> {
  const card = e.wf.createCard({ title, blockedBy })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return card
}

/** Its review passed: approved, and so queued. */
async function pass(e: Env, card: CardRecord): Promise<void> {
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
}

const queued = async (e: Env, title: string, file: string, blockedBy: number[] = []): Promise<CardRecord> => {
  const card = await submitted(e, title, file, blockedBy)
  await pass(e, card)
  return card
}

/** The board's edit of a card's blocked-by list (tasks.ts writes these rows), on a connection of its own as another writer. */
const block = (e: Env, card: CardRecord, by: (CardRecord | number)[]): void => {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.prepare("DELETE FROM card_links WHERE card = ? AND kind = 'blockedBy'").run(card.id)
    by.forEach((b, i) => db.prepare("INSERT INTO card_links (card, kind, ord, target) VALUES (?, 'blockedBy', ?, ?)").run(card.id, i, typeof b === 'number' ? b : b.id))
  } finally {
    db.close()
  }
}
const mainHead = (e: Env) => sh(e.project, 'rev-parse', 'main')
/** The user's move of a card into Done past its rules (as the board's drag with a reason). */
const done = async (e: Env, card: CardRecord): Promise<void> => void expect(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'finished elsewhere' })).toMatchObject({ to: 'done' })
/** The `enqueue` actions written for a card (whatever became of them): its queue asked to run. */
const enqueues = (e: Env, card: CardRecord): Record<string, unknown>[] => {
  const db = new DatabaseSync(boardFile(e.home), { readOnly: true })
  try {
    return (db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'enqueue' ORDER BY id").all(card.id) as { payload: string }[]).map((r) => JSON.parse(r.payload))
  } finally {
    db.close()
  }
}
const started = (e: Env, card: CardRecord): boolean => e.store.facts(card.id).some((f) => f.kind === 'IntegrationStarted')

describe('HI-2709: the merge queue and a card blocked by another', () => {
  it('a blocked card waits in the queue, shown as waiting on its blocker; the card behind it merges; its blocker Done runs the queue again and it merges', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    // Blocked once started (HI-2684's case: a start waits for its blockers already), then approved.
    const b = await submitted(e, 'Blocked', 'src/b.txt')
    block(e, b, [blocker])
    await pass(e, b)
    const c = await queued(e, 'Free', 'src/c.txt')
    // Queued, in its place, saying what it waits for.
    expect(queueStateOf(e.wf, b)).toEqual({ state: 'waiting', target: 'main', on: [blocker.key] })
    expect(queueLine(queueStateOf(e.wf, b)!)).toContain(`waiting for ${blocker.key} to be Done`)
    expect(queueOrder(e.wf, 'main').queued.map((q) => [q.key, q.waitingOn ?? null])).toEqual([
      [b.key, [blocker.key]],
      [c.key, null]
    ])
    const out = await e.queue().drain('main')
    expect(out.map((o) => [o.card, o.outcome])).toEqual([[c.key, 'integrated']])
    expect(e.wf.state(b).stage).toBe('merging')
    expect(started(e, b)).toBe(false)
    // Its blocker into Done: its queue is asked to run (no new approval), and it merges.
    expect(enqueues(e, b)).toHaveLength(1)
    await done(e, blocker)
    expect(enqueues(e, b).at(-1)).toEqual({ target: 'main' })
    expect(queueStateOf(e.wf, b)).toMatchObject({ state: 'queued', position: 1 })
    const [o] = await e.queue().drain('main')
    expect(o).toMatchObject({ card: b.key, outcome: 'integrated' })
    expect(e.wf.state(b).stage).toBe('done')
  })

  it('a dependency added while the card is in Review holds it once it is approved; a new queue (a restart) sees the same', async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const b = await submitted(e, 'Blocked later', 'src/b.txt')
    block(e, b, [blocker])
    await pass(e, b)
    const before = mainHead(e)
    expect(await e.queue().drain('main')).toEqual([])
    expect(mainHead(e)).toBe(before)
    // Read again by another Combwork's runtime on the same board: still waiting, nothing begun.
    const other = e.another()
    expect(queueStateOf(other, other.store.card(b.id))).toEqual({ state: 'waiting', target: 'main', on: [blocker.key] })
    expect(await e.queue().runOnce('main')).toBeNull()
    expect(started(e, b)).toBe(false)
  })

  it('a dependency added while it is tested holds it before its advance: no IntegrationStarted, its entry open, the target unmoved', async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const b = await queued(e, 'Tested', 'src/b.txt')
    const before = mainHead(e)
    const [o] = await e.queue({ hooks: { afterTest: () => block(e, b, [blocker]) } }).drain('main')
    expect(o).toEqual({ card: b.key, entry: expect.any(String), outcome: 'waiting', on: [blocker.key] })
    expect(started(e, b)).toBe(false)
    expect(e.wf.state(b).entries.at(-1)?.state).toBe('open')
    expect(mainHead(e)).toBe(before)
  })

  it("added in the advance's own lock, after the queue's last look: the write that would begin it refuses (its authority)", async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const b = await queued(e, 'Locked', 'src/b.txt')
    const before = mainHead(e)
    // The repository lock is taken just before IntegrationStarted's write: the dependency lands there.
    const lock = async <T,>(fn: () => Promise<T>): Promise<T> => {
      block(e, b, [blocker])
      return fn()
    }
    const [o] = await e.queue({ lock }).drain('main')
    expect(o).toMatchObject({ card: b.key, outcome: 'waiting', on: [blocker.key] })
    expect(started(e, b)).toBe(false)
    expect(mainHead(e)).toBe(before)
  })

  it('a blocker reopened from Done while the card is tested holds it again; one that can no longer be read holds it too', async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    await done(e, blocker)
    const b = await queued(e, 'Reopened', 'src/b.txt', [blocker.id])
    expect(queueStateOf(e.wf, b)).toMatchObject({ state: 'queued' })
    const [o] = await e.queue({ hooks: { afterTest: () => void e.store.tx((tx) => tx.setStage(blocker.id, 'active')) } }).drain('main')
    expect(o).toMatchObject({ card: b.key, outcome: 'waiting', on: [blocker.key] })
    expect(started(e, b)).toBe(false)
    // A blocker with no card (deleted, its reference not yet dropped): waited for by its number, never merged on doubt.
    block(e, b, [999999])
    expect(e.wf.queueWaitingOn(b.id)).toEqual(['#999999'])
    expect(await e.queue().drain('main')).toEqual([])
    expect(started(e, b)).toBe(false)
  })
})
