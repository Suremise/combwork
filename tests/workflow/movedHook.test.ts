// HI-2938: the workflow's `moved` hook, called once a write that moved a card has committed (the app asks for a
// reconciliation on a move into Approved, which builds a jj card's candidate), and never for a write that moved nothing;
// a hook that throws never fails the committed write.
import { afterEach, describe, expect, it } from 'vitest'
import { B1, moved, setup, type Env } from './harness'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

describe('the moved hook (HI-2938)', () => {
  it('is told each committed move, from and to; a write moving nothing tells it nothing; its throw fails nothing', async () => {
    env = setup({ platform: 'none', review: 'none' })
    const seen: string[] = []
    env.wf.cfg.moved = (card, from, to) => void seen.push(`${card.key} ${from}→${to}`)
    const card = env.wf.createCard({ title: 'work' })
    moved(await env.wf.start(card.key, B1))
    expect(seen).toEqual([`${card.key} todo→active`])
    await env.wf.write(env.wf.store.card(card.id), null, 'combwork', () => undefined)
    expect(seen).toHaveLength(1)
    env.wf.cfg.moved = () => {
      throw new Error('hook')
    }
    await env.wf.write(env.wf.store.card(card.id), null, 'combwork', (w) => w.move('todo', 'derived'))
    expect(env.wf.state(env.wf.store.card(card.id)).stage).toBe('todo')
  })
})
