// HI-2709: a card in Review is never closed because its change is in its target already, whether merged by hand or
// carried in another card's merge (HI-2684 carried HI-2682's commits, and HI-2682 went to Done with no verdict). It is
// marked (InTarget, for that submission) and stays in Review; once its review passes, the queue finds the change in the
// target and closes it as merged. On real temporary repositories.
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { inTargetNow } from '../../src/shared/workflow/workView'
import type { CardRecord } from '../../src/main/workflow/factStore'
import { boardFile } from '../../src/main/boardStore'
import { isRefusal } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const team = (over: Record<string, unknown> = {}) => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' }, commitMessage: 'combwork', ...over }))
/** The board's edit of a card's blocked-by list (tasks.ts writes these rows), on a connection of its own. */
const block = (e: Env, card: CardRecord, by: CardRecord[]): void => {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    db.prepare("DELETE FROM card_links WHERE card = ? AND kind = 'blockedBy'").run(card.id)
    by.forEach((b, i) => db.prepare("INSERT INTO card_links (card, kind, ord, target) VALUES (?, 'blockedBy', ?, ?)").run(card.id, i, b.id))
  } finally {
    db.close()
  }
}
const done = async (e: Env, card: CardRecord): Promise<void> => void expect(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'finished elsewhere' })).toMatchObject({ to: 'done' })

/** A card started by B1 with a commit of its own (after merging `carry`, another card's line, into it), submitted. */
async function inReview(e: Env, title: string, file: string, carry?: string): Promise<{ card: CardRecord; folder: string; line: string }> {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  if (carry) sh(folder, 'merge', '-q', '--no-ff', '-m', `bring in ${carry}`, carry)
  commit(folder, { [file]: `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return { card, folder, line: sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD') }
}

async function pass(e: Env, card: CardRecord): Promise<void> {
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
}

const marks = (e: Env, card: CardRecord) => e.store.facts(card.id).filter((f) => f.kind === 'InTarget')

describe('HI-2709: a card in Review whose change is already in its target', () => {
  it("HI-2684's case: carried in another card's queue merge, it stays in Review, marked; its review passed, the queue closes it as merged", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await pass(e, c.card)
    expect(await e.queue().drain('main')).toMatchObject([{ card: c.card.key, outcome: 'integrated' }])
    await reconcile(e.wf, x.card)
    const s = e.wf.state(x.card)
    expect(s.stage).toBe('review')
    expect(s.integrated).toBeNull()
    expect(inTargetNow(s)).toEqual({ revision: s.latest!.revision, target: 'main', submission: s.latest!.id })
    // Marked once, however often it is looked at (another Combwork's runtime too).
    await reconcile(e.wf, x.card)
    const other = e.another()
    await reconcile(other, other.store.card(x.card.id))
    expect(marks(e, x.card)).toHaveLength(1)
    expect(e.wf.state(x.card).stage).toBe('review')
    // Its own review decides: passed, the queue finds it in the target and closes it, with no empty merge.
    const before = sh(e.project, 'rev-parse', 'main')
    await pass(e, x.card)
    expect(await e.queue().drain('main')).toMatchObject([{ card: x.card.key, outcome: 'integratedOutside' }])
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
    expect(sh(e.project, 'rev-parse', 'main')).toBe(before)
  })

  it('merged by hand: the same, never Done before its review passes (no "outside the rules" close)', async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    await reconcile(e.wf, x.card)
    expect(e.wf.state(x.card).stage).toBe('review')
    expect(inTargetNow(e.wf.state(x.card))).toMatchObject({ target: 'main' })
    await pass(e, x.card)
    await e.queue().drain('main')
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
  })

  it('the mark is for the submission it was read for: a newer one (submitted meanwhile, or after) has none until looked at again', async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    // A follow-up submitted between the read and the write: nothing written for the old one.
    await reconcile(e.wf, x.card, {
      afterRead: async () => {
        commit(x.folder, { 'src/x2.txt': 'more\n' }, 'more')
        moved(await e.wf.submit(x.card.key, B1, { summary: 'again', followUp: true }))
      }
    })
    expect(marks(e, x.card)).toHaveLength(0)
    // The newer one isn't in main: nothing; merged too, it is marked.
    await reconcile(e.wf, x.card)
    expect(marks(e, x.card)).toHaveLength(0)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand again', x.line)
    await reconcile(e.wf, x.card)
    expect(inTargetNow(e.wf.state(x.card))).toMatchObject({ submission: e.wf.state(x.card).latest!.id })
    expect(e.wf.state(x.card).stage).toBe('review')
  })

  it("HR1's round 4: already in the target and passed, but depending on a card that isn't Done: neither the queue nor reconciliation closes it; its blocker Done, the queue does", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await pass(e, c.card)
    await e.queue().drain('main')
    await reconcile(e.wf, x.card)
    expect(inTargetNow(e.wf.state(x.card))).not.toBeNull()
    block(e, x.card, [blocker])
    await pass(e, x.card)
    expect(await e.queue().drain('main')).toEqual([])
    await reconcile(e.wf, x.card)
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'merging', integrated: null })
    expect(e.wf.queueWaitingOn(x.card.id)).toEqual([blocker.key])
    await done(e, blocker)
    expect(await e.queue().drain('main')).toMatchObject([{ card: x.card.key, outcome: 'integratedOutside' }])
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
  })

  it('a dependency added while containment is read, before the write that would close it: it counts (read in that write)', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const x = await inReview(e, 'By hand', 'src/x.txt')
    await pass(e, x.card)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    await reconcile(e.wf, x.card, { afterRead: () => block(e, x.card, [blocker]) })
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'merging', integrated: null })
    // The queue's own already-in-the-target path: it waits, saying for what, and nothing is closed.
    expect(await e.queue().drain('main')).toEqual([])
  })

  it("an agent's merge report of a card depending on one that isn't Done: refused, saying for what; once it is Done, accepted", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team({ finish: 'agentMerges' })
    const blocker = e.wf.createCard({ title: 'Blocker' })
    const x = await inReview(e, 'Merged by its agent', 'src/x.txt')
    block(e, x.card, [blocker])
    await pass(e, x.card)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by its agent', x.line)
    const refused = await e.wf.reportMerge(x.card.key, B1)
    expect(isRefusal(refused) && refused.rule).toBe('merge.waitsForBlockers')
    expect(isRefusal(refused) && refused.message).toBe(`${x.card.key} depends on ${blocker.key}, which isn't Done: it isn't closed as merged before then.`)
    await reconcile(e.wf, x.card)
    expect(e.wf.state(x.card).stage).not.toBe('done')
    await done(e, blocker)
    moved(await e.wf.reportMerge(x.card.key, B1))
    expect(e.wf.state(x.card).stage).toBe('done')
  })
})
