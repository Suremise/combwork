// HI-3510: what 1.6.0's jj left in a workspace, read by a Combwork without jj (no migration, SPEC §16.3.6). A card or a
// lane started under jj keeps `platform: 'jj'` in its stored ruleset: every intent on it, an agent's, the Assistant's or
// the user's, is refused `platform.removed` (never a TypeError from an adapter that isn't there), reconciliation leaves
// it, and the user's moves to Todo and Done still work, its next start then under the project's rules. Its ruleset is
// never rewritten. The rulesets are stored as a 1.6.0 Combwork left them: a real one with its platform set to jj.
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { B1, commit, moved, R1, refusedBy, setup, type Env } from './harness'
import { preset } from '../../src/shared/workflow/options'
import { boardFile } from '../../src/main/boardStore'
import { reconcile } from '../../src/main/workflow/reconcile'
import { isRefusal, PlatformRemoved } from '../../src/main/workflow/runtime'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

const pairOpts = { ...preset('git', 'pair'), preChecks: [], mergeChecks: [] }

/**
 * Each stored ruleset named here as a jj project's in 1.6.0: a copy under an id of its own (a jj ruleset's id was never a
 * Git or None one's), its platform jj, and the cards' facts and running lanes that named it naming the copy instead.
 * The project's current rules stay its own.
 */
function asJj(e: Env, of: { card: number } | { lane: string }): void {
  const db = new DatabaseSync(boardFile(e.home))
  try {
    const ids = 'card' in of ? (db.prepare('SELECT DISTINCT ruleset AS id FROM card_facts WHERE card = ? AND ruleset IS NOT NULL').all(of.card) as { id: string }[]) : (db.prepare('SELECT ruleset AS id FROM lane_runs WHERE lane = ?').all(of.lane) as { id: string }[])
    for (const { id } of ids) {
      const jj = `${id}~jj`
      db.prepare("INSERT OR IGNORE INTO rulesets (id, data) SELECT ?, json_set(json_set(data, '$.options.platform', 'jj'), '$.id', ?) FROM rulesets WHERE id = ?").run(jj, jj, id)
      if ('card' in of) db.prepare('UPDATE card_facts SET ruleset = ? WHERE ruleset = ? AND card = ?').run(jj, id, of.card)
      else db.prepare('UPDATE lane_runs SET ruleset = ? WHERE ruleset = ? AND lane = ?').run(jj, id, of.lane)
    }
  } finally {
    db.close()
  }
}

/** A card started and submitted under Pair: in Review, its ruleset then made jj's. */
async function jjInReview(e: Env, title: string) {
  const card = e.wf.createCard({ title })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  commit(s.data!.folder as string, { [`${title}.txt`]: `${title}\n` }, title)
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  asJj(e, { card: card.id })
  return card
}

describe("a card started under a platform Combwork no longer has (HI-3510)", () => {
  it("refuses every intent on it, saying so, whoever asks; reads give nothing; reconciliation leaves it", async () => {
    env = setup(pairOpts)
    const e = env
    const card = await jjInReview(e, 'old')
    expect(e.wf.removedPlatformOf(e.store.card(card.id))).toBe('jj')
    for (const [what, r] of [
      ['start review', await e.wf.startReview(card.key, R1)],
      ['verdict', await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' })],
      ['submit', await e.wf.submit(card.key, B1, { summary: 'again' })],
      ["the Assistant's start review", await e.wf.startReview(card.key, 'assistant')],
      ["the user's verdict", await e.wf.verdict(card.id, 'user', { pass: true, comment: 'ok' })],
      ["the user's drag to Doing", await e.wf.move(card.id, 'active', 'user')]
    ] as const) {
      const x = refusedBy(r, 'platform.removed')
      expect(x.values, what).toMatchObject({ card: card.key, platform: 'jj' })
    }
    expect(e.wf.checksOf(card.key)).toBeNull()
    // Reconciliation leaves it: nothing asked of an adapter that isn't there.
    await expect(reconcile(e.wf, e.store.card(card.id))).resolves.toBeUndefined()
    // Any other path that would ask its adapter meets a named error, never a TypeError.
    expect(() => e.wf.platformOf(e.store.card(card.id))).toThrow(PlatformRemoved)
    // Nothing of it was rewritten: its stage and its rules are as 1.6.0 left them.
    expect(e.store.card(card.id).stage).toBe('review')
    expect(e.wf.rulesetOf(e.store.card(card.id)).options.platform).toBe('jj')
  })

  it("says it to agents as a fact, and to the user what to do", async () => {
    env = setup(pairOpts)
    const card = await jjInReview(env, 'told')
    const r = refusedBy(await env.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }), 'platform.removed')
    expect(r.message).toBe(`${card.key} was started under jj, a version control Combwork no longer has, so its moves can’t be checked.`)
    expect(r.next).toBe('Its moves stay refused; the user’s moves to Todo and Done are not.')
    expect(r.override).toBe('the user')
    const { refusalLines } = await import('../../src/shared/workflow/refusals')
    const { tr } = await import('../../src/shared/i18n')
    expect(refusalLines('platform.removed', { card: card.key, platform: 'jj' }, { one: (m, v) => tr(m, { ...v, reader: 'you' }), list: (xs) => xs.join(', '), names: true }).next).toBe('Move it to Todo to start it again under this project’s version control, or to Done.')
  })

  it("the user's moves to Todo and Done go on; from Todo it starts again under the project's rules", async () => {
    env = setup(pairOpts)
    const e = env
    const back = await jjInReview(e, 'back')
    moved(await e.wf.move(back.id, 'todo', 'user'))
    expect(e.wf.removedPlatformOf(e.store.card(back.id))).toBeNull()
    moved(await e.wf.start(back.key, B1))
    expect(e.wf.rulesetOf(e.store.card(back.id)).options.platform).toBe('git')
    const done = await jjInReview(e, 'done')
    const r = await e.wf.move(done.id, 'done', 'user', { confirm: true, reason: 'from 1.6.0' })
    expect(isRefusal(r) ? r.rule : 'moved').toBe('moved')
    expect(e.store.card(done.id).stage).toBe('done')
  })

  it("a Todo card of a lane started under jj is refused its start; the lane's own ruleset stays", async () => {
    env = setup(pairOpts)
    const e = env
    const c1 = e.wf.createCard({ title: 'one' })
    const c2 = e.wf.createCard({ title: 'two' })
    e.wf.startLane('L', [c1.id, c2.id], 'R1')
    asJj(e, { lane: 'L' })
    const r = refusedBy(await e.wf.start(c1.key, B1), 'platform.removed')
    expect(r.values).toMatchObject({ card: c1.key, platform: 'jj' })
    expect(e.store.card(c1.id).stage).toBe('todo')
  })
})
