// Hook deliveries that arrive twice (HI-2777: Combwork's and a differing admin snippet's handler both run). Only an
// occurrence with the CLI's own identity is matched: handled once, its duplicates given the same decision, its context in
// one delivered response at a time, never another occurrence's reply; the rest handled each time.
import http from 'http'
import { describe, expect, it } from 'vitest'
import { TWINS_PER_RUN, carrying, claimTwin, decisionOnly, endTwins, hasContext, hooksDoubled } from '../src/main/hookTwins'

const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x.txt is locked by Bo' } }
const notice = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'You have a message' } }
let n = 0
const run = (): string => `run${++n}`

describe('duplicate hook deliveries (HI-2777)', () => {
  it('a hook with no identity is never matched', () => {
    expect(claimTwin(run(), null)).toBeNull()
  })

  it('the first delivery is handled, a second of the same identity gets its decision, a different identity is its own', async () => {
    const r = run()
    let told = 0
    const a = claimTwin(r, 'PreToolUse:t1', () => told++)!
    expect(a.first).toBe(true)
    const other = claimTwin(r, 'PreToolUse:t2', () => told++)!
    expect(other.first).toBe(true)
    const twin = claimTwin(r, 'PreToolUse:t1', () => told++)!
    expect(twin.first).toBe(false)
    expect(told).toBe(1)
    expect(hooksDoubled(r)).toBe(true)
    a.entry.computed(deny)
    expect(await twin.entry.twinReply(1000)).toEqual({ reply: deny, carries: false })
    // A third delivery: the same decision again, still never handled.
    expect((await claimTwin(r, 'PreToolUse:t1')!.entry.twinReply(1000)).reply).toEqual(deny)
    endTwins(r)
    expect(hooksDoubled(r)).toBe(false)
  })

  it('launch A then managed B, with B\'s launch copy missing: B is handled (an identity never seen is a first)', () => {
    const r = run()
    expect(claimTwin(r, 'PreToolUse:A')!.first).toBe(true)
    expect(claimTwin(r, 'PreToolUse:B')!.first).toBe(true)
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
  })

  it('interleaved and reordered: managed A, launch B, launch A, managed B: each handled once', () => {
    const r = run()
    const firsts = ['A', 'B', 'A', 'B'].map((k) => claimTwin(r, `PostToolUse:${k}`)!.first)
    expect(firsts).toEqual([true, true, false, false])
    endTwins(r)
  })

  it('a twin arriving while the first is computed waits for it; the first never computed (the run ended) gives none', async () => {
    const r = run()
    const a = claimTwin(r, 'PreToolUse:w')!
    const waiting = claimTwin(r, 'PreToolUse:w')!.entry.twinReply(5000)
    setTimeout(() => a.entry.computed(deny), 20)
    expect((await waiting).reply).toEqual(deny)
    const b = claimTwin(r, 'PreToolUse:x')!
    const stuck = claimTwin(r, 'PreToolUse:x')!.entry.twinReply(5000)
    endTwins(r)
    expect(await stuck).toEqual({ reply: null, carries: false })
    expect(b.first).toBe(true)
  })

  it('waits at most its bound for a first reply never computed', async () => {
    const r = run()
    claimTwin(r, 'PreToolUse:slow')
    const started = Date.now()
    expect(await claimTwin(r, 'PreToolUse:slow')!.entry.twinReply(50)).toEqual({ reply: null, carries: false })
    expect(Date.now() - started).toBeLessThan(2000)
    endTwins(r)
  })

  it('context: a delivered first keeps it from its twins, who get the decision only', async () => {
    const r = run()
    const a = claimTwin(r, 'PostToolUse:c')!
    a.entry.computed(notice)
    a.entry.sending()
    const twin = claimTwin(r, 'PostToolUse:c')!.entry.twinReply(5000)
    a.entry.sent(true)
    expect(await twin).toEqual({ reply: null, carries: false })
  })

  it("context: an aborted first hands it to one twin at a time; three twins can't all take it", async () => {
    const r = run()
    const a = claimTwin(r, 'PostToolUse:d')!
    a.entry.computed(notice)
    a.entry.sending()
    const twins = [1, 2, 3].map(() => claimTwin(r, 'PostToolUse:d')!.entry.twinReply(5000))
    a.entry.sent(false)
    const got = await Promise.all(twins)
    expect(got.filter((g) => g.carries)).toHaveLength(1)
    expect(got.filter((g) => !g.carries).every((g) => g.reply === null)).toBe(true)
    endTwins(r)
  })

  it('an aborted first response with a lock deny: the twin, the only reply received, carries the deny and its reason', async () => {
    const r = run()
    const a = claimTwin(r, 'PreToolUse:lock')!
    const warnDeny = { ...deny, hookSpecificOutput: { ...deny.hookSpecificOutput, additionalContext: 'Bo holds it' } }
    a.entry.computed(warnDeny)
    a.entry.sending()
    a.entry.sent(false)
    const twin = await claimTwin(r, 'PreToolUse:lock')!.entry.twinReply(5000)
    expect(twin.carries).toBe(true)
    expect(twin.reply).toEqual(warnDeny)
    endTwins(r)
  })

  it('a context still being sent when the bound runs out counts as sent: never given twice', async () => {
    const r = run()
    const a = claimTwin(r, 'PostToolUse:e')!
    a.entry.computed(notice)
    a.entry.sending()
    expect(await claimTwin(r, 'PostToolUse:e')!.entry.twinReply(30)).toEqual({ reply: null, carries: false })
    endTwins(r)
  })

  it("keeps a run's newest identities, the oldest going first (a double then, never a drop)", () => {
    const r = run()
    for (let i = 0; i <= TWINS_PER_RUN; i++) claimTwin(r, `PreToolUse:${i}`)
    expect(claimTwin(r, 'PreToolUse:0')!.first).toBe(true)
    expect(claimTwin(r, `PreToolUse:${TWINS_PER_RUN}`)!.first).toBe(false)
    endTwins(r)
  })

  it('a duplicate keeps every field of the decision but its context', () => {
    expect(decisionOnly({ decision: 'block', reason: 'stop', systemMessage: 's', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'c' } })).toEqual({ decision: 'block', reason: 'stop' })
    expect(decisionOnly({ continue: false, stopReason: 'why', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r', updatedInput: { a: 1 } } })).toEqual({ continue: false, stopReason: 'why', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r', updatedInput: { a: 1 } } })
    expect(decisionOnly(notice)).toBeNull()
    expect(hasContext(notice)).toBe(true)
    expect(hasContext(deny)).toBe(false)
  })
})

/**
 * A real local HTTP exchange whose response the client abandons: `serve` gets the server's response once its client
 * has gone (its close already happened, as when Claude Code gives up while the reply is decided).
 */
async function abandonedResponse(): Promise<{ res: http.ServerResponse; done: () => void }> {
  let take!: (r: http.ServerResponse) => void
  const got = new Promise<http.ServerResponse>((r) => (take = r))
  const server = http.createServer((_req, res) => {
    res.once('close', () => take(res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook' })
  req.on('error', () => undefined)
  // The client goes once its request is on its way.
  req.flushHeaders()
  req.write('{}', () => req.destroy())
  const res = await got
  return { res, done: () => server.close() }
}

describe('a response that closed before it could carry context (review round 1)', () => {
  it("the first delivery's response closed while its reply was decided: a twin takes the context, the decision kept", async () => {
    const { res, done } = await abandonedResponse()
    try {
      expect(res.closed || res.destroyed).toBe(true)
      const r = run()
      const a = claimTwin(r, 'PostToolUse:closed')!
      const withDeny = { ...notice, decision: 'block', reason: 'held' }
      a.entry.computed(withDeny)
      a.entry.sending()
      // Its close event has passed: carrying hears it at once, rather than never.
      carrying(res, a.entry)
      const twin = await claimTwin(r, 'PostToolUse:closed')!.entry.twinReply(5000)
      expect(twin).toEqual({ reply: withDeny, carries: true })
      endTwins(r)
    } finally {
      done()
    }
  })

  it('a twin that claimed the context but whose own response had closed releases it to the next, which keeps the decision too', async () => {
    const { res, done } = await abandonedResponse()
    try {
      const r = run()
      const a = claimTwin(r, 'PostToolUse:twin')!
      a.entry.computed(notice)
      a.entry.sending()
      a.entry.sent(false)
      const first = await claimTwin(r, 'PostToolUse:twin')!.entry.twinReply(5000)
      expect(first.carries).toBe(true)
      // The twin's own response was gone while it waited: it can't carry it.
      carrying(res, a.entry)
      const next = await claimTwin(r, 'PostToolUse:twin')!.entry.twinReply(5000)
      expect(next).toEqual({ reply: notice, carries: true })
      endTwins(r)
    } finally {
      done()
    }
  })
})
