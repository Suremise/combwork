// HI-3322: an intent's `alongside` hooks (tasks.ts runIntent: an agent request's attempt fence and the card's 0.9 fields)
// run in the intent's own writes only. What the intent sets off and outlives it (a reconciliation scheduled by its move,
// a candidate's checks, a timer) inherits its async context, but never its hooks: a jj card's verdict once left the
// reviewer's fence on Combwork's own later writes, refused as attempt.staleLaunch after the reviewer's launch ended, so
// the card never came back from its candidate's merge check nor went Done after the user's integration.
import { afterEach, describe, expect, it } from 'vitest'
import { alongside } from '../../src/main/workflow/runtime'
import { B1, moved, setup, type Env } from './harness'

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})

describe("an intent's alongside hooks (HI-3322)", () => {
  it('run in its own writes, and in none it set off that run after it returned', async () => {
    env = setup({ platform: 'none', review: 'none' })
    const wf = env.wf
    const card = wf.createCard({ title: 'work' })
    moved(await wf.start(card.key, B1))
    let ended = false
    const seen: string[] = []
    let later: Promise<void> | null = null
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await alongside(
      {
        before: () => {
          // The fence of a launch that has since ended: it refuses whatever write it is asked in.
          if (ended) throw new Error('attempt.staleLaunch')
          seen.push('before')
        },
        written: async () => void seen.push('written')
      },
      async () => {
        await wf.write(wf.store.card(card.id), null, 'combwork', () => undefined)
        // Set off from inside the intent, run once it has returned (a reconciliation its move scheduled).
        later = gate.then(() => wf.write(wf.store.card(card.id), null, 'outside', (w) => w.move('todo', 'derived')))
      }
    )
    // A write that changes nothing has no `written` (the later one moves the card: it would).
    expect(seen).toEqual(['before'])
    ended = true
    release()
    await later
    expect(seen).toEqual(['before'])
    expect(wf.state(wf.store.card(card.id)).stage).toBe('todo')
  })
})
