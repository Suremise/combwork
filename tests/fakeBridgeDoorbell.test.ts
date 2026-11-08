// The fakes' reading of Combwork's doorbell (tests/e2e/fake-bridge.cjs): new work (tasks, handovers) is their prompt,
// anything else a wake (HI-2746: a card's task named by its key was taken as a wake).
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { inboxNotice } from '../src/shared/doorbell'
import { namedBy } from '../src/shared/projectKeys'

const require = createRequire(import.meta.url)
const bridge = require('./e2e/fake-bridge.cjs') as { doorbellIsWork: (text: string) => boolean }

describe('the fakes tell work from a wake in a doorbell', () => {
  it('a task or handover is work, its card named by key or number, or none', () => {
    for (const t of [
      '[CW] New in your inbox: 1 task (AL-1) (m1). Call cw_inbox to read it, act on it, then ack it.',
      '[CW] New in your inbox: 2 tasks (AL-1, AL-12) (m1, m2). Call cw_inbox to read them, act on them, then ack them.',
      '[CW] New in your inbox: 1 task (#12) (m1). Call cw_inbox to read it, act on it, then ack it.',
      '[CW] New in your inbox: 1 task (m5). Call cw_inbox to read it, act on it, then ack it.',
      '[CW] New in your inbox: 1 task (ABCD-2746) and 1 handover (m1, m2). Call cw_inbox to read them, act on them, then ack them.'
    ])
      expect(bridge.doorbellIsWork(t), t).toBe(true)
  })

  it('a message, card event or anything beside work is a wake', () => {
    for (const t of [
      '[CW] New in your inbox: 1 message (m2). Call cw_inbox to read it, act on it, then ack it.',
      '[CW] New in your inbox: 1 card event (AL-1) (m3). Call cw_inbox to read it.',
      '[CW] New in your inbox: 1 task (AL-1) and 1 message (m1, m2). Call cw_inbox to read them, act on them, then ack them.'
    ])
      expect(bridge.doorbellIsWork(t), t).toBe(false)
  })

  it("Combwork's own doorbell for a card's task, by key, is work", () => {
    const doorbell = (names: ((n: number) => string) | null) => namedBy(names, () => inboxNotice('doorbell', [{ id: 'm1', kind: 'task', card: 1 }]))
    const keyed = doorbell((n) => `AL-${n}`)
    expect(keyed).toContain('(AL-1)')
    expect(bridge.doorbellIsWork(keyed)).toBe(true)
    expect(bridge.doorbellIsWork(doorbell(null))).toBe(true)
  })
})
