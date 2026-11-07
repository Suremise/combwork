// HI-2709: a card in Review whose change reached its target inside another card's queue merge isn't closed as merged
// outside the rules: reconcile's carried-code walk (carriedWalk.ts) proves which merge brought it, and the card stays in
// Review with a mark (CarriedIn) that holds on later passes; a hand merge is still Done (outside the rules). Unproved
// (a read that can't be made, a merge in flight, merges not all read yet), nothing is written. On real repositories,
// with the queue's merges real where git's answer matters and recorded facts where only their number does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B1, commit, GIT_HEAVY_MS, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { CARRIED_PAGE, forgetCarriedWalks } from '../../src/main/workflow/carriedWalk'
import { carriedInNow } from '../../src/shared/workflow/workView'
import type { CardRecord } from '../../src/main/workflow/factStore'
import { unknown } from '../../src/main/platform/types'

const flags = vi.hoisted(() => ({ ancestorUnknown: false, ancestorThrows: false, containsUnknownAt: null as string | null, headUnknown: false }))
vi.mock('../../src/main/platform/git', async (orig) => {
  const actual = (await orig()) as typeof import('../../src/main/platform/git')
  const unreadable = () => Promise.resolve(unknown({ id: 'test.unknown', text: 'unreadable' } as never))
  return {
    ...actual,
    isAncestor: (repo: string, a: string, b: string) => (flags.ancestorThrows ? Promise.reject(new Error('git went away')) : flags.ancestorUnknown ? unreadable() : actual.isAncestor(repo, a, b)),
    contains: (repo: string, target: string, c: { base: string; revision: string; key?: string | null }, at?: string) => (flags.containsUnknownAt && at === flags.containsUnknownAt ? unreadable() : actual.contains(repo, target, c, at)),
    lineHead: (repo: string, line: string) => (flags.headUnknown ? unreadable() : actual.lineHead(repo, line))
  }
})

let env: Env | null = null
beforeEach(() => {
  flags.ancestorUnknown = false
  flags.ancestorThrows = false
  flags.containsUnknownAt = null
  flags.headUnknown = false
  forgetCarriedWalks()
})
afterEach(() => {
  env?.close()
  env = null
})

const team = (style: 'merge' | 'squash' = 'merge') => (env = setup({ ...preset('git', 'team', { quick: ['quick'], tests: [] }), preChecks: [], okBefore: { mode: 'never', labels: [] }, commands: { quick: 'npm run quick' }, commitMessage: 'combwork', style }))
const mainHead = (e: Env) => sh(e.project, 'rev-parse', 'main')

/** A card started by B1 with a commit of its own, submitted: in Review. Its folder and line. */
async function inReview(e: Env, title: string, file: string, carry?: string): Promise<{ card: CardRecord; folder: string; line: string }> {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  const folder = s.data!.folder as string
  // HI-2684's case: another card's line merged into this one, its commits carried along.
  if (carry) sh(folder, 'merge', '-q', '--no-ff', '-m', `bring in ${carry}`, carry)
  commit(folder, { [file]: `${title}\n` }, `${card.key}: ${title}`)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return { card, folder, line: sh(folder, 'rev-parse', '--abbrev-ref', 'HEAD') }
}

async function mergedByQueue(e: Env, card: CardRecord): Promise<void> {
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  expect(await e.queue().drain('main')).toMatchObject([{ card: card.key, outcome: 'integrated' }])
}

/** A queue merge into main recorded on a card of its own (its start and outcome), at main's head: one more to walk past. */
function recordedMerge(e: Env, n: number, opts: { finished?: boolean } = {}): void {
  const z = e.wf.createCard({ title: `Other ${n}` })
  const head = mainHead(e)
  const entry = `${z.key}/e1`
  e.store.tx((tx) => {
    tx.append(z.id, { kind: 'IntegrationRequested', actor: 'combwork', source: 'recorded', data: { entry, revision: head, key: null, target: 'main', style: 'merge' } })
    tx.append(z.id, { kind: 'IntegrationStarted', actor: 'combwork', source: 'recorded', data: { entry, expected: head, result: head } })
    if (opts.finished !== false) tx.append(z.id, { kind: 'Integrated', actor: 'combwork', source: 'recorded', data: { entry, revision: head, target: 'main', result: head, method: 'merge', by: 'combwork' } })
  })
}

const pass = async (e: Env, card: CardRecord): Promise<string[]> => {
  const again: string[] = []
  await reconcile(e.wf, card, { again: (why) => void again.push(why) })
  return again
}

describe('HI-2709: a card whose code another card carried into its target', () => {
  it("HI-2684's case: carried by a merge commit, it stays in Review with the mark, on every later pass and after a restart", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    expect(await pass(e, x.card)).toEqual([])
    const s = e.wf.state(x.card)
    expect(s.stage).toBe('review')
    expect(s.integrated).toBeNull()
    expect(carriedInNow(s)).toMatchObject({ revision: s.latest!.revision, target: 'main', by: c.card.key })
    // Sticky: again, and from another Combwork's runtime with no walk kept (a restart).
    await pass(e, x.card)
    forgetCarriedWalks()
    const other = e.another()
    await reconcile(other, other.store.card(x.card.id))
    expect(e.wf.state(x.card).stage).toBe('review')
    expect(e.store.facts(x.card.id).filter((f) => f.kind === 'CarriedIn')).toHaveLength(1)
    // Its own review still decides: passed, it is queued and merges, Done by the queue (nothing new to bring in).
    moved(await e.wf.startReview(x.card.key, R1))
    moved(await e.wf.verdict(x.card.key, R1, { pass: true, comment: 'ok' }))
    await e.queue().drain('main')
    expect(e.wf.state(x.card).stage).toBe('done')
  })

  it('carried by a squash merge: proved by the containment reconcile uses, and marked', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team('squash')
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    await pass(e, x.card)
    expect(e.wf.state(x.card).stage).toBe('review')
    expect(carriedInNow(e.wf.state(x.card))).toMatchObject({ by: c.card.key })
  })

  it('merged by hand (a squash) before the queue merge that would have carried it: Done, outside the rules, as before', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    sh(e.project, 'merge', '-q', '--squash', x.line)
    sh(e.project, 'commit', '-qm', 'squashed by hand')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    await pass(e, x.card)
    const s = e.wf.state(x.card)
    expect(s.stage).toBe('done')
    expect(s.integrated).toMatchObject({ by: 'outside', outsideRules: ['review'] })
    expect(s.marks.carriedIn).toBeUndefined()
  })

  it('merged by hand after a queue merge (between two): proved by its absence in that merge, Done outside', async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    recordedMerge(e, 1)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    await pass(e, x.card)
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
  })

  it('a carrier older than a page of later merges: deferred, then found on the next pass; nothing written meanwhile', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    for (let i = 0; i < CARRIED_PAGE; i++) recordedMerge(e, i)
    expect(await pass(e, x.card)).toEqual(['more'])
    expect(e.store.facts(x.card.id).some((f) => f.kind === 'CarriedIn' || f.kind === 'Integrated')).toBe(false)
    expect(await pass(e, x.card)).toEqual([])
    expect(carriedInNow(e.wf.state(x.card))).toMatchObject({ by: c.card.key })
  })

  it('a new merge between pages starts the walk again from the newest; a resubmission hides the old mark', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    for (let i = 0; i < CARRIED_PAGE + 1; i++) recordedMerge(e, i)
    expect(await pass(e, x.card)).toEqual(['more'])
    recordedMerge(e, 99)
    // Restarted: the newest page again (all later merges), not the page below where it got to.
    expect(await pass(e, x.card)).toEqual(['more'])
    expect(await pass(e, x.card)).toEqual([])
    expect(carriedInNow(e.wf.state(x.card))).toMatchObject({ by: c.card.key })
    // A new submission: the mark is for the old one.
    commit(x.folder, { 'src/x2.txt': 'more\n' }, 'more')
    moved(await e.wf.submit(x.card.key, B1, { summary: 'again', followUp: true }))
    expect(carriedInNow(e.wf.state(x.card))).toBeNull()
  })

  it("the target's merges change before the walk's write: nothing written, asked again", async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    const again: string[] = []
    await reconcile(e.wf, x.card, { again: (why) => void again.push(why), afterRead: () => recordedMerge(e, 1) })
    expect(e.wf.state(x.card).stage).toBe('review')
    expect(e.store.facts(x.card.id).some((f) => f.kind === 'Integrated')).toBe(false)
    // The next pass reads the new history: the hand merge is still proved, Done.
    expect(await pass(e, x.card)).toEqual([])
    expect(e.wf.state(x.card).stage).toBe('done')
  })

  it('a queue merge in flight (begun, no outcome: a recovery not done yet), or a read that can\'t be made: deferred, nothing written', async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    recordedMerge(e, 1, { finished: false })
    expect(await pass(e, x.card)).toEqual(['busy'])
    expect(e.wf.state(x.card).stage).toBe('review')
    // Its outcome recorded; then a merge's history unreadable, and a containment at its start unreadable: deferred.
    const z = e.store.cards().find((c) => c.title === 'Other 1')!
    const zEntry = `${z.key}/e1`
    e.store.tx((tx) => void tx.append(z.id, { kind: 'Integrated', actor: 'combwork', source: 'recorded', data: { entry: zEntry, revision: 'x', target: 'main', result: mainHead(e), method: 'merge', by: 'combwork' } }))
    flags.ancestorUnknown = true
    expect(await pass(e, x.card)).toEqual(['unknown'])
    flags.ancestorUnknown = false
    flags.containsUnknownAt = (e.store.facts(z.id).find((f) => f.kind === 'IntegrationStarted')!.data as { expected: string }).expected
    expect(await pass(e, x.card)).toEqual(['unknown'])
    expect(e.wf.state(x.card).stage).toBe('review')
    flags.containsUnknownAt = null
    expect(await pass(e, x.card)).toEqual([])
    expect(e.wf.state(x.card).stage).toBe('done')
  })

  it('a carrier reset out of the target is passed over: the change found in it now arrived by hand', { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const before = mainHead(e)
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    sh(e.project, 'reset', '-q', '--hard', before)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    await pass(e, x.card)
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
  })

  it("HR1's round 1 finding 1: a carrier whose history can't be read (unknown, then a throw) is asked about again, never passed over", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    // Its own read fails inside the carrier's row: deferred, and nothing written.
    flags.ancestorUnknown = true
    expect(await pass(e, x.card)).toEqual(['unknown'])
    flags.ancestorUnknown = false
    flags.ancestorThrows = true
    await expect(reconcile(e.wf, x.card)).rejects.toThrow('git went away')
    flags.ancestorThrows = false
    expect(e.store.facts(x.card.id).some((f) => f.kind === 'CarriedIn' || f.kind === 'Integrated')).toBe(false)
    // Read again: the carrier is found (not skipped for the cursor's sake, which would have closed it as a hand merge).
    expect(await pass(e, x.card)).toEqual([])
    const s = e.wf.state(x.card)
    expect(s.stage).toBe('review')
    expect(carriedInNow(s)).toMatchObject({ by: c.card.key })
  })

  it("HR1's round 1 finding 2: the target's head changed or unreadable at the last read before the write: nothing written; the head recorded is that read", async () => {
    const e = team()
    const x = await inReview(e, 'By hand', 'src/x.txt')
    const before = mainHead(e)
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'by hand', x.line)
    const merged = mainHead(e)
    // Unreadable at the last read.
    const again: string[] = []
    await reconcile(e.wf, x.card, { again: (why) => void again.push(why), afterRead: () => void (flags.headUnknown = true) })
    flags.headUnknown = false
    expect(again).toEqual(['unknown'])
    expect(e.wf.state(x.card).stage).toBe('review')
    // Reset out of the target after the walk's reads: nothing written; the next pass finds it isn't there.
    await reconcile(e.wf, x.card, { again: (why) => void again.push(why), afterRead: () => void sh(e.project, 'reset', '-q', '--hard', before) })
    expect(e.wf.state(x.card).stage).toBe('review')
    expect(e.store.facts(x.card.id).some((f) => f.kind === 'Integrated')).toBe(false)
    expect(await pass(e, x.card)).toEqual([])
    expect(e.wf.state(x.card).stage).toBe('review')
    // Merged again: Done, recording the head the walk proved it at.
    sh(e.project, 'reset', '-q', '--hard', merged)
    expect(await pass(e, x.card)).toEqual([])
    expect(e.wf.state(x.card)).toMatchObject({ stage: 'done', integrated: { by: 'outside', result: merged } })
  })

  it("HR1's round 1 finding 3: a resubmission of the same revision between the walk's read and its write: nothing written for the old one; the new one is proved again", { timeout: GIT_HEAVY_MS }, async () => {
    const e = team()
    const x = await inReview(e, 'Carried', 'src/x.txt')
    const c = await inReview(e, 'Carrier', 'src/c.txt', x.line)
    await mergedByQueue(e, c.card)
    const resubmit = (): void => {
      const last = e.store.facts(x.card.id).findLast((f) => f.kind === 'Submitted')!
      e.store.tx((tx) => void tx.append(x.card.id, { kind: 'Submitted', actor: last.actor, source: 'recorded', ...(last.ruleset ? { ruleset: last.ruleset } : {}), data: last.data as never }))
    }
    const first = e.wf.state(x.card).latest!.id
    await reconcile(e.wf, x.card, { afterRead: resubmit })
    const s = e.wf.state(x.card)
    expect(s.latest!.id).not.toBe(first)
    expect(s.latest!.revision).toBe((e.store.facts(x.card.id).find((f) => f.kind === 'Submitted')!.data as { revision: string }).revision)
    expect(e.store.facts(x.card.id).some((f) => f.kind === 'CarriedIn')).toBe(false)
    await pass(e, x.card)
    expect(carriedInNow(e.wf.state(x.card))).toMatchObject({ by: c.card.key, submission: s.latest!.id })
  })
})
