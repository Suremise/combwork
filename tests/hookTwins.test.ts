// Hook deliveries that arrive twice (HI-2777: Combwork's and a differing admin snippet's handler both run). Only an
// occurrence with the CLI's own identity is matched: handled once, its duplicates given the same decision, its context in
// one delivered response at a time, never another occurrence's reply; the rest handled each time.
import http from 'http'
import { describe, expect, it } from 'vitest'
import { TWINS_PER_RUN, answering, carrying, claimTwin, decisionOnly, endTwins, hasContext, hooksDoubled } from '../src/main/hookTwins'
import { claudeCode } from '../src/main/providers/claude/adapter'

const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x.txt is locked by Bo' } }
const notice = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'You have a message' } }
let n = 0
const run = (): string => `run${++n}`
/** A delivery of the identity `key` whose body is the same each time (a copy). */
const claim = (r: string, key: string, onDoubled?: () => void) => claimTwin(r, { key, unique: true }, { key }, onDoubled)

describe('duplicate hook deliveries (HI-2777)', () => {
  it('a hook with no identity is never matched', () => {
    expect(claimTwin(run(), null, {})).toBeNull()
  })

  it('the first delivery is handled, a second of the same identity gets its decision, a different identity is its own', async () => {
    const r = run()
    let told = 0
    const a = claim(r,'PreToolUse:t1', () => told++)!
    expect(a.first).toBe(true)
    const other = claim(r,'PreToolUse:t2', () => told++)!
    expect(other.first).toBe(true)
    const twin = claim(r,'PreToolUse:t1', () => told++)!
    expect(twin.first).toBe(false)
    expect(told).toBe(1)
    expect(hooksDoubled(r)).toBe(true)
    a.entry.computed(deny)
    expect(await twin.entry.twinReply(1000)).toEqual({ reply: deny, carries: false })
    // A third delivery: the same decision again, still never handled.
    expect((await claim(r,'PreToolUse:t1')!.entry.twinReply(1000)).reply).toEqual(deny)
    endTwins(r)
    expect(hooksDoubled(r)).toBe(false)
  })

  it('launch A then managed B, with B\'s launch copy missing: B is handled (an identity never seen is a first)', () => {
    const r = run()
    expect(claim(r,'PreToolUse:A')!.first).toBe(true)
    expect(claim(r,'PreToolUse:B')!.first).toBe(true)
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
  })

  it('interleaved and reordered: managed A, launch B, launch A, managed B: each handled once', () => {
    const r = run()
    const firsts = ['A', 'B', 'A', 'B'].map((k) => claim(r,`PostToolUse:${k}`)!.first)
    expect(firsts).toEqual([true, true, false, false])
    endTwins(r)
  })

  it('a twin arriving while the first is computed waits for it; the first never computed (the run ended) gives none', async () => {
    const r = run()
    const a = claim(r,'PreToolUse:w')!
    const waiting = claim(r,'PreToolUse:w')!.entry.twinReply(5000)
    setTimeout(() => a.entry.computed(deny), 20)
    expect((await waiting).reply).toEqual(deny)
    const b = claim(r,'PreToolUse:x')!
    const stuck = claim(r,'PreToolUse:x')!.entry.twinReply(5000)
    endTwins(r)
    expect(await stuck).toEqual({ reply: null, carries: false })
    expect(b.first).toBe(true)
  })

  it('waits at most its bound for a first reply never computed', async () => {
    const r = run()
    claim(r,'PreToolUse:slow')
    const started = Date.now()
    expect(await claim(r,'PreToolUse:slow')!.entry.twinReply(50)).toEqual({ reply: null, carries: false })
    expect(Date.now() - started).toBeLessThan(2000)
    endTwins(r)
  })

  it('context: a delivered first keeps it from its twins, who get the decision only', async () => {
    const r = run()
    const a = claim(r,'PostToolUse:c')!
    a.entry.computed(notice)
    a.entry.sending()
    const twin = claim(r,'PostToolUse:c')!.entry.twinReply(5000)
    a.entry.sent(true)
    expect(await twin).toEqual({ reply: null, carries: false })
  })

  it("context: an aborted first hands it to one twin at a time; three twins can't all take it", async () => {
    const r = run()
    const a = claim(r,'PostToolUse:d')!
    a.entry.computed(notice)
    a.entry.sending()
    const twins = [1, 2, 3].map(() => claim(r,'PostToolUse:d')!.entry.twinReply(5000))
    a.entry.sent(false)
    const got = await Promise.all(twins)
    expect(got.filter((g) => g.carries)).toHaveLength(1)
    expect(got.filter((g) => !g.carries).every((g) => g.reply === null)).toBe(true)
    endTwins(r)
  })

  it('an aborted first response with a lock deny: the twin, the only reply received, carries the deny and its reason', async () => {
    const r = run()
    const a = claim(r,'PreToolUse:lock')!
    const warnDeny = { ...deny, hookSpecificOutput: { ...deny.hookSpecificOutput, additionalContext: 'Bo holds it' } }
    a.entry.computed(warnDeny)
    a.entry.sending()
    a.entry.sent(false)
    const twin = await claim(r,'PreToolUse:lock')!.entry.twinReply(5000)
    expect(twin.carries).toBe(true)
    expect(twin.reply).toEqual(warnDeny)
    endTwins(r)
  })

  it('a context still being sent when the bound runs out counts as sent: never given twice', async () => {
    const r = run()
    const a = claim(r,'PostToolUse:e')!
    a.entry.computed(notice)
    a.entry.sending()
    expect(await claim(r,'PostToolUse:e')!.entry.twinReply(30)).toEqual({ reply: null, carries: false })
    endTwins(r)
  })

  it("keeps a run's newest identities, the oldest going first (a double then, never a drop)", () => {
    const r = run()
    for (let i = 0; i <= TWINS_PER_RUN; i++) claim(r,`PreToolUse:${i}`)
    expect(claim(r,'PreToolUse:0')!.first).toBe(true)
    expect(claim(r,`PreToolUse:${TWINS_PER_RUN}`)!.first).toBe(false)
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

/** A delivery as the hook route claims it (servers.ts), its response still open. */
function deliver(r: string, body: Record<string, any>) {
  return claimTwin(r, claudeCode.hookOccurrence(body), body)
}

/** A delivery claimed and, if the first, answered (its response written): the CLI may go on to its next event. */
function handled(r: string, body: Record<string, any>) {
  const c = deliver(r, body)
  if (c?.first) c.entry.answered()
  return c
}

describe('only a copy is a twin (HI-2850)', () => {
  // The fields Claude Code sends (tests/fixtures/advanced/prompt-task-notification-claude-2.1.317.json).
  const base = { session_id: 'a803e062-9d8d-4265-9f0c-f773a6aadf6d', transcript_path: 'C:\\home\\projects\\D--work\\a803e062-9d8d-4265-9f0c-f773a6aadf6d.jsonl', cwd: 'D:\\work', permission_mode: 'bypassPermissions' }
  const turn = '16fb8131-909c-4601-8896-8dcdc5d83e19'
  const prompt = (text: string, pid = turn) => ({ ...base, hook_event_name: 'UserPromptSubmit', prompt_id: pid, prompt: text })
  const tool = (ev: 'PreToolUse' | 'PostToolUse', id: string, extra: Record<string, unknown> = {}) => ({ ...base, hook_event_name: ev, prompt_id: turn, tool_name: 'Bash', tool_input: { command: 'jj log' }, tool_use_id: id, ...extra })
  const queued = '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-e605" from-name="alpha · HB2">\nHB2 here: my plan for the shared types, unless you object.\n</cross-session-message>'

  it("the recorded case (HB3, 10 Nov 01:49:35): a message queued mid-turn is submitted under the turn's prompt_id; it is handled, nothing doubled", () => {
    const r = run()
    expect(handled(r, prompt('[CW] New in your inbox: 1 task (HI-2797) (m38350).'))!.first).toBe(true)
    expect(handled(r, tool('PreToolUse', 'toolu_01Pcb5g3E3EJTReWRnxeHLiP'))!.first).toBe(true)
    expect(handled(r, tool('PostToolUse', 'toolu_01Pcb5g3E3EJTReWRnxeHLiP'))!.first).toBe(true)
    // The queued message, attached at the tool boundary: the same prompt_id, its own text.
    expect(handled(r, prompt(queued))!.first).toBe(true)
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
  })

  it('a real copy, arriving while the first is answered (the CLI runs both handlers at once), is a twin: of a prompt, a queued prompt and a tool call', () => {
    const r = run()
    const a = deliver(r, prompt('go'))!
    expect(a.first).toBe(true)
    expect(deliver(r, prompt('go'))!.first).toBe(false)
    expect(hooksDoubled(r)).toBe(true)
    a.entry.answered()
    // Its keys in another order (another writer's JSON): the same copy.
    const pre = tool('PreToolUse', 'toolu_x')
    expect(deliver(r, pre)!.first).toBe(true)
    expect(deliver(r, Object.fromEntries(Object.entries(pre).reverse()))!.first).toBe(false)
    const q = deliver(r, prompt(queued))!
    expect(q.first).toBe(true)
    expect(deliver(r, prompt(queued))!.first).toBe(false)
    endTwins(r)
  })

  it('one identity, a body that differs: two occurrences, each handled (never a drop)', () => {
    const r = run()
    expect(deliver(r, tool('PreToolUse', 'toolu_y'))!.first).toBe(true)
    expect(deliver(r, tool('PreToolUse', 'toolu_y', { tool_input: { command: 'other' } }))!.first).toBe(true)
    expect(deliver(r, prompt('one'))!.first).toBe(true)
    expect(deliver(r, prompt('two'))!.first).toBe(true)
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
  })

  it("HR2's case: two messages queued with the same text, submitted one after the other with no tool call between: both handled, nothing doubled", () => {
    const r = run()
    expect(handled(r, prompt('go on'))!.first).toBe(true)
    // Claude Code submits the second only once the first's handlers have answered.
    expect(handled(r, prompt('Same again.'))!.first).toBe(true)
    expect(handled(r, prompt('Same again.'))!.first).toBe(true)
    expect(handled(r, prompt('Same again.'))!.first).toBe(true)
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
  })

  it('…and with hooks really doubled: each of them handled once, its own copy answered from it', () => {
    const r = run()
    for (let k = 0; k < 3; k++) {
      const a = deliver(r, prompt('Same again.'))!
      expect(a.first).toBe(true)
      expect(deliver(r, prompt('Same again.'))!.first).toBe(false)
      a.entry.answered()
    }
    expect(hooksDoubled(r)).toBe(true)
    endTwins(r)
  })

  it('a tool call or the session start is one event whenever its copy comes, even after the first was answered', () => {
    const r = run()
    expect(handled(r, tool('PreToolUse', 'toolu_late'))!.first).toBe(true)
    expect(deliver(r, tool('PreToolUse', 'toolu_late'))!.first).toBe(false)
    const start = { ...base, hook_event_name: 'SessionStart', source: 'startup' }
    expect(handled(r, start)!.first).toBe(true)
    expect(deliver(r, start)!.first).toBe(false)
    endTwins(r)
  })

  it("a sub-agent's tool calls (agent_id) are never taken for each other, and a prompt's copy beside them is its twin", () => {
    const r = run()
    const p = deliver(r, prompt('review it'))!
    expect(p.first).toBe(true)
    const sub = { agent_id: 'a136948b260e2cd4d', agent_type: 'general-purpose' }
    expect(handled(r, tool('PreToolUse', 'toolu_s1', sub))!.first).toBe(true)
    expect(handled(r, tool('PreToolUse', 'toolu_s2', sub))!.first).toBe(true)
    expect(handled(r, tool('PostToolUse', 'toolu_s1', sub))!.first).toBe(true)
    expect(deliver(r, prompt('review it'))!.first).toBe(false)
    endTwins(r)
  })

  it("answering: the first's response finishing or closing ends its window; one already closed ends it at once", () => {
    const listeners: Record<string, () => void> = {}
    const res = { destroyed: false, closed: false, writableFinished: false, once: (e: 'finish' | 'close', f: () => void) => (listeners[e] = f) }
    const r = run()
    const a = deliver(r, prompt('x'))!
    answering(res, a.entry)
    expect(a.entry.open).toBe(true)
    listeners.finish()
    expect(a.entry.open).toBe(false)
    expect(deliver(r, prompt('x'))!.first).toBe(true)
    const b = deliver(r, prompt('y'))!
    answering({ ...res, closed: true }, b.entry)
    expect(b.entry.open).toBe(false)
    endTwins(r)
  })

  it('hooks with no identity (Stop, Notification, SubagentStop) are never matched, however alike', () => {
    const r = run()
    for (const ev of ['Stop', 'Notification', 'SubagentStop']) {
      const body = { ...base, hook_event_name: ev, prompt_id: turn }
      expect(deliver(r, body)).toBeNull()
      expect(deliver(r, body)).toBeNull()
    }
    expect(hooksDoubled(r)).toBe(false)
    endTwins(r)
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
      const a = claim(r,'PostToolUse:closed')!
      const withDeny = { ...notice, decision: 'block', reason: 'held' }
      a.entry.computed(withDeny)
      a.entry.sending()
      // Its close event has passed: carrying hears it at once, rather than never.
      carrying(res, a.entry)
      const twin = await claim(r,'PostToolUse:closed')!.entry.twinReply(5000)
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
      const a = claim(r,'PostToolUse:twin')!
      a.entry.computed(notice)
      a.entry.sending()
      a.entry.sent(false)
      const first = await claim(r,'PostToolUse:twin')!.entry.twinReply(5000)
      expect(first.carries).toBe(true)
      // The twin's own response was gone while it waited: it can't carry it.
      carrying(res, a.entry)
      const next = await claim(r,'PostToolUse:twin')!.entry.twinReply(5000)
      expect(next).toEqual({ reply: notice, carries: true })
      endTwins(r)
    } finally {
      done()
    }
  })
})
