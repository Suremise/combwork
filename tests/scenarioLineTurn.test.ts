// HI-3408: a fake in a session Combwork started (startedByCombwork) is typed its steps once Combwork's line's turn is
// over and Combwork is quiet (turnEnd.cjs's lineReads, through turnStep), never at an idle status alone. The harness took
// "the line in the conversation and ready or finished" before: a status from before the line's turn ran (fake-codex,
// card-loop-progress-comment) or between its end and the inbox's next ring (card-loop-follow-up-check's follow-up,
// m2) had the steps typed into a turn that dropped them. And a scenario can't be both Combwork-started and given its
// prompt at launch: Combwork's line is its first input.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
type Item = { kind: string; text?: string }
type Live = { status: string; turn?: { state: string } | null; runtime?: { composer: string } }
type Snap = { live: Live | null; items: Item[]; queued?: boolean }
type Look = Record<string, unknown> & { now: number }
type Step = { state: unknown; done: boolean; outcome: string | null; why: string }
const te = require('./scenarios/turnEnd.cjs') as {
  lineReads: (o: { live: () => Promise<Live | null>; conversation: () => Promise<Item[]>; quiet: (s: Live) => Promise<boolean> }) => Record<string, (v: Record<string, unknown>) => unknown>
  gatherLook: (reads: Record<string, (v: Record<string, unknown>) => unknown>, o: { deadline: number; readMs: number }) => Promise<Look>
  turnStep: (s: unknown, l: Look, f: { quietMs: number; waitingQuietMs: number }) => Step
  start: () => unknown
}
const { SCENARIOS } = require('./scenarios/scenarios.cjs') as { SCENARIOS: Array<{ id: string; startedByCombwork?: boolean; promptAtLaunch?: boolean }> }

const FLOORS = { quietMs: 6000, waitingQuietMs: 3000 }
const LINE: Item = { kind: 'user', text: '[CW] New in your inbox: 1 task (AL-1) (m1). Call cw_inbox to read it, act on it, then ack it.' }
const REPLY: Item = { kind: 'assistant', text: 'Done: Work on task AL-1' }
const WAKE: Item = { kind: 'user', text: '[CW] New in your inbox: 1 message (m2). Call cw_inbox to read it, act on it, then ack it.' }
const live = (status: string, turn: string | null, composer = 'free'): Live => ({ status, turn: turn ? { state: turn } : null, runtime: { composer } })

/** What the harness took before: the line in the conversation and the session ready or finished. */
const oldCheck = (s: Snap) => s.items.some((x) => x.kind === 'user' && String(x.text).startsWith('[CW]')) && ['ready', 'finished'].includes(s.live?.status ?? '')

/** Looks a second apart over `snaps` (one per second), through lineReads, gatherLook and turnStep: when it ended, if it did. */
async function run(snaps: Snap[]) {
  let state = te.start()
  for (const [i, s] of snaps.entries()) {
    // Combwork's quiet as the harness reads it: composer free, nothing queued to be offered.
    const reads = te.lineReads({ live: async () => s.live, conversation: async () => s.items, quiet: async (l) => l.runtime?.composer === 'free' && !s.queued })
    const look = { ...(await te.gatherLook(reads, { deadline: Date.now() + 5000, readMs: 1000 })), now: i * 1000 }
    const r = te.turnStep(state, look, FLOORS)
    state = r.state
    if (r.done) return { at: i, outcome: r.outcome }
  }
  return null
}
const repeat = (n: number, s: Snap): Snap[] => Array.from({ length: n }, () => s)

describe("a Combwork-started fake's steps wait for its line's turn and Combwork's quiet (HI-3408)", () => {
  it("card-loop-follow-up-check: not at the line's end while the follow-up waits to ring, nor while it rings; after the follow-up's turn and the floor", async () => {
    const answered = [LINE, REPLY]
    const snaps = [
      ...repeat(2, { live: live('working', 'running'), items: [LINE] }),
      // The line's turn over; the follow-up (m2) queued to ring: the old check typed the steps here.
      ...repeat(8, { live: live('ready', 'over'), items: answered, queued: true }),
      // Combwork typing its doorbell.
      ...repeat(2, { live: live('ready', 'over', 'typing'), items: answered }),
      ...repeat(3, { live: live('working', 'running'), items: [...answered, WAKE] }),
      ...repeat(10, { live: live('ready', 'over'), items: [...answered, WAKE, REPLY] })
    ]
    expect(snaps.findIndex(oldCheck)).toBe(2)
    // The follow-up's turn ends at 15: the floor (6 s) after it.
    expect(await run(snaps)).toEqual({ at: 21, outcome: 'over' })
  })

  it("card-loop-progress-comment on the fake Codex: ready with the line taken before its turn has run (no replies in its rollout) is no end", async () => {
    const snaps = [
      // The line in the rollout, its UserPromptSubmit not yet handled: ready, no turn. The old check typed here.
      ...repeat(8, { live: live('ready', null), items: [LINE] }),
      ...repeat(2, { live: live('working', 'running'), items: [LINE] }),
      // Its end in Combwork's turn ledger alone (the fake Codex records no replies).
      ...repeat(10, { live: live('ready', 'over'), items: [LINE] })
    ]
    expect(snaps.findIndex(oldCheck)).toBe(0)
    expect(await run(snaps)).toEqual({ at: 16, outcome: 'over' })
  })

  it('never before the line is taken, nor while its turn runs, nor with its state unread', async () => {
    expect(await run(repeat(20, { live: live('ready', null), items: [] }))).toBeNull()
    expect(await run(repeat(20, { live: live('ready', 'running'), items: [LINE] }))).toBeNull()
    expect(await run(repeat(20, { live: live('ready', 'unknown'), items: [LINE, REPLY] }))).toBeNull()
  })

  it('never while Combwork has something to type into it, however long it is idle', async () => {
    expect(await run(repeat(30, { live: live('ready', 'over'), items: [LINE, REPLY], queued: true }))).toBeNull()
    expect(await run(repeat(30, { live: live('ready', 'over', 'confirming'), items: [LINE, REPLY] }))).toBeNull()
  })

  it('an earlier turn over (a setup turn) is no end of a line not yet taken', async () => {
    expect(await run(repeat(20, { live: live('finished', 'over'), items: [{ kind: 'user', text: 'set up' }, REPLY] }))).toBeNull()
  })
})

describe("a scenario's premise", () => {
  it("none is both startedByCombwork and promptAtLaunch: Combwork's line is its first input, so a prompt at launch never applies", () => {
    expect(SCENARIOS.filter((s) => s.startedByCombwork && s.promptAtLaunch).map((s) => s.id)).toEqual([])
  })
})
