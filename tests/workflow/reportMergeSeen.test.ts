// HI-3282: where the agent merges, Combwork's reconciliation can see the builder's merge and finish the card before the
// builder's own report of it (the watcher's debounce, then the reconciler's). That report answers OK, already Done,
// writing nothing, when Combwork saw this cycle's merge; any other Done card (the user's override, an earlier cycle's
// merge, a card the queue merges) keeps its refusal. On real temporary repositories.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, commit, moved, R1, setup, sh, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { reconcile } from '../../src/main/workflow/reconcile'
import { isRefusal } from '../../src/main/workflow/runtime'
import type { CardRecord } from '../../src/main/workflow/factStore'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

/** A card started, committed, submitted and passed: Approved, its line's head returned for merging by hand. */
async function passed(e: Env, card: CardRecord, file: string): Promise<string> {
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [file]: `${file}\n` }, file)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  moved(await e.wf.startReview(card.key, R1))
  moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
  return e.wf.state(card).latest!.revision!
}

const seqs = (e: Env, card: CardRecord): string[] => e.store.facts(card.id).map((f) => `${f.seq}:${f.kind}`)

describe('HI-3282: a report of a merge Combwork already saw', () => {
  it('the reconciler finished it first: report merge answers OK, already Done, and writes nothing', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const card = e.wf.createCard({ title: 'A' })
    const rev = await passed(e, card, 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', rev)
    await reconcile(e.wf, card)
    expect(e.wf.state(card)).toMatchObject({ stage: 'done', integrated: { by: 'outside', target: 'main' } })
    const before = seqs(e, card)
    const r = await e.wf.reportMerge(card.key, B1, { result: sh(e.project, 'rev-parse', 'main') })
    expect(isRefusal(r)).toBe(false)
    expect(r).toMatchObject({ ok: true, from: 'done', to: 'done', data: { already: 'Done already: Combwork saw its merge into main; nothing more to report' } })
    // Nothing written: no Refused, no second Integrated, Moved or Finished.
    expect(seqs(e, card)).toEqual(before)
  })

  it('finished between its reads and its write: the same OK, read under the write, nothing written', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const card = e.wf.createCard({ title: 'A' })
    const rev = await passed(e, card, 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', rev)
    // The reconciler's pass lands just before the report's write (after its platform reads).
    const rt = e.wf as unknown as { revalidate: (...a: unknown[]) => Promise<boolean> }
    let raced = false
    rt.revalidate = async () => {
      if (!raced) {
        raced = true
        await reconcile(e.wf, card)
      }
      return false
    }
    const r = await e.wf.reportMerge(card.key, B1)
    expect(raced).toBe(true)
    expect(r).toMatchObject({ ok: true, from: 'done', to: 'done' })
    const after = seqs(e, card)
    const kinds = e.store.facts(card.id).map((f) => f.kind)
    expect(kinds.filter((k) => k === 'Integrated')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'Finished')).toHaveLength(1)
    expect(kinds).not.toContain('Refused')
    expect(e.wf.state(card).integrated).toMatchObject({ by: 'outside' })
    // Asked again: still OK, still nothing.
    moved(await e.wf.reportMerge(card.key, B1))
    expect(seqs(e, card)).toEqual(after)
  })

  it("a Done card with no merge seen (the user's override) is still refused", async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const card = e.wf.createCard({ title: 'A' })
    await passed(e, card, 'a.txt')
    expect(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'finished elsewhere' })).toMatchObject({ to: 'done' })
    expect(e.wf.state(card).integrated).toBeNull()
    const r = await e.wf.reportMerge(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('move.notFromHere')
  })

  it('a merge seen in an earlier cycle counts for nothing: a new cycle Done by override is refused', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'agentMerges', target: 'main' }))
    const card = e.wf.createCard({ title: 'A' })
    const rev = await passed(e, card, 'a.txt')
    sh(e.project, 'merge', '-q', '--no-ff', '-m', 'A', rev)
    await reconcile(e.wf, card)
    expect(e.wf.state(card)).toMatchObject({ stage: 'done', integrated: { by: 'outside' } })
    // More work: the Done card started again (a new cycle), then put in Done by the user with nothing merged.
    moved(await e.wf.start(card.key, B1, { reopen: true }))
    expect(e.wf.state(card).integrated).toBeNull()
    expect(await e.wf.move(card.key, 'done', 'user', { confirm: true, reason: 'not needed after all' })).toMatchObject({ to: 'done' })
    expect(e.store.facts(card.id).filter((f) => f.kind === 'Integrated')).toHaveLength(1)
    const r = await e.wf.reportMerge(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('move.notFromHere')
  })

  it('a card the queue merges is still refused, naming the queue, though its merge was seen', async () => {
    const e = (env = setup({ ...pairOpts, finish: 'combworkMerges', target: 'main' }))
    const card = e.wf.createCard({ title: 'A' })
    await passed(e, card, 'a.txt')
    await e.queue().drain('main')
    expect(e.wf.state(card)).toMatchObject({ stage: 'done', integrated: { target: 'main' } })
    const r = await e.wf.reportMerge(card.key, B1)
    expect(isRefusal(r) && r.rule).toBe('merge.combworkMerges')
  })
})
