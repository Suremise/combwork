// OpenCode's turns from its server's event stream (HI-2760, design s7 to s22): the recorded 2.2.6 streams
// (tests/fixtures/opencode/real-2.2.6/events) projected as the launcher does, through the tracker (events.ts), the turn
// ledger and the status rules, as SessionManager.handleHookIn takes them: prompts, tools, permissions (several, out of
// order, answered or rejected), retries, ends, a steer, settled snapshots (the A-ends-B-starts interleaving, missed
// executions, a resumed session's history, a stale generation, a bounded-out window), never a guess.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { admit, newLedger } from '../src/main/turnLedger'
import { applyStep, hookStep, type HookStatusInput } from '../src/main/hookStatus'
import type { Ask } from '../src/main/providers/types'
import type { SessionStatus } from '../src/shared/types'
import { COMPACTING_MESSAGE } from '../src/shared/defaults'
import { applyEvent, applySnapshot, expandOpencodeHook, newTracker, normalizeOpencodeHook, projectEvent, type Normalized, type OcEvent, type OcSnapshot, type OcTracker } from '../src/main/providers/opencode/events'

const REC = join(__dirname, 'fixtures', 'opencode', 'real-2.2.6')
type Raw = { type: string; data: Record<string, any>; durable?: { seq: number } }
/** A recording's events: a bare list, or HI-2762's { source, events } (compaction). */
const recorded = (name: string): Raw[] => {
  const j = JSON.parse(readFileSync(join(REC, 'events', `${name}.json`), 'utf8'))
  return Array.isArray(j) ? j : j.events
}
const sidOf = (ev: Raw[]) => ev.find((e) => e.data?.sessionID)!.data.sessionID as string

/** An agent as the status rules see it, with the turn ledger beside it: hooks go through admit, then hookStep. */
class Agent {
  ledger = newLedger(0)
  status: SessionStatus = 'ready'
  statusMessage?: string
  open: Ask[] = []
  waitingOn: Ask | null = null
  question?: { text: string; since: string }
  prompts = 0
  stale: string[] = []
  input(): HookStatusInput {
    return { status: this.status, statusMessage: this.statusMessage, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: this.open, waitingOn: this.waitingOn, question: !!this.question, reviewing: false, safeguardPrompt: false }
  }
  take(hooks: Normalized[]): this {
    for (const h of hooks) {
      const a = admit(this.ledger, h.event, h.ids)
      if (a.verdict !== 'apply') {
        this.stale.push(`${h.event.kind}:${'why' in a ? a.why : a.verdict}`)
        continue
      }
      if (a.event.kind === 'prompt' && !a.event.injected) this.prompts++
      const step = hookStep(a.event, this.input())
      if (step.open !== undefined) this.open = [...step.open]
      if (step.waitingOn !== undefined) this.waitingOn = step.waitingOn
      applyStep(this, step)
    }
    return this
  }
  get turn(): string | null {
    return this.ledger.active?.id ?? null
  }
  get running(): boolean {
    return this.ledger.active?.state === 'running'
  }
}

/** A recorded stream through the projection and the tracker, event by event; what the agent saw after each. */
function play(name: string, t = newTracker(), a = new Agent()) {
  const ev = recorded(name)
  const sid = sidOf(ev)
  const seen: SessionStatus[] = []
  for (const raw of ev) {
    const e = projectEvent(raw, sid)
    if (!e) continue
    a.take(applyEvent(t, 0, e))
    seen.push(a.status)
  }
  return { t, a, seen, sid }
}

describe('the recorded 2.2.6 streams, through the tracker, the ledger and the status rules', () => {
  it('no tool: one prompt, working, finished', () => {
    const { a } = play('no-tool')
    expect([a.prompts, a.status, a.running, a.stale]).toEqual([1, 'finished', false, []])
  })

  it("a shell permission answered once: needs you while it asks, working once answered (not at the tool's end), finished", () => {
    const { a, seen } = play('shell-permission-once')
    expect(seen).toContain('waiting')
    expect(seen.lastIndexOf('waiting')).toBeLessThan(seen.lastIndexOf('working'))
    expect([a.prompts, a.status, a.waitingOn, a.stale]).toEqual([1, 'finished', null, []])
  })

  it('a shell permission rejected: the wait answered, the turn interrupted', () => {
    const { a, seen } = play('shell-permission-reject')
    expect(seen).toContain('waiting')
    expect([a.prompts, a.status, a.waitingOn, a.running]).toEqual([1, 'ready', null, false])
  })

  it('interrupted, failed at once (400), failed after retries, and an MCP tool through execute', () => {
    expect([play('interrupted').a.status, play('interrupted').a.running]).toEqual(['ready', false])
    const f = play('failed-provider-400').a
    expect([f.status, f.prompts]).toEqual(['finished', 1])
    const r = play('failed-transport-retries')
    expect([r.a.prompts, r.a.running]).toEqual([1, false])
    const m = play('mcp-through-execute').a
    expect([m.status, m.prompts, m.stale]).toEqual(['finished', 1, []])
  })

  it('projection keeps only what status needs, text cut, nothing of another session', () => {
    const ev = recorded('shell-permission-once')
    const sid = sidOf(ev)
    const asked = ev.find((e) => e.type === 'permission.asked')!
    expect(projectEvent(asked, sid)).toEqual({ type: 'permission.asked', requestID: asked.data.id, messageID: asked.data.source.messageID, callID: asked.data.source.id, action: 'shell', resources: asked.data.resources.join(' ') })
    expect(projectEvent(asked, 'ses_other')).toBeNull()
    expect(projectEvent({ type: 'session.reasoning.delta', data: { sessionID: sid, delta: 'x' } }, sid)).toBeNull()
    const long = projectEvent({ type: 'session.inbox.enqueued', data: { sessionID: sid, inboxID: 'msg_1', item: { type: 'user', payload: { text: 'x'.repeat(5000) } } }, durable: { seq: 3 } }, sid)!
    expect([long.text!.length, long.seq]).toEqual([2000, 3])
  })
})

/** Hand-made live events of one session. */
const enq = (id: string, seq: number, text = id): OcEvent => ({ type: 'session.inbox.enqueued', inboxID: id, itemType: 'user', text, seq })
const step = (msg: string, seq: number): OcEvent => ({ type: 'session.step.started', assistantMessageID: msg, seq })
const ended = (seq: number, outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded'): OcEvent => ({ type: `session.execution.${outcome}`, seq })
const asked = (req: string, msg: string, call: string): OcEvent => ({ type: 'permission.asked', requestID: req, messageID: msg, callID: call, action: 'shell', resources: 'echo hi' })
const replied = (req: string, reply = 'once'): OcEvent => ({ type: 'permission.replied', requestID: req, reply })
const snap = (o: Partial<OcSnapshot> & { w: number }): OcSnapshot => ({ session: {}, permissions: [], messages: [], boundary: 'start', ...o })
const live = (t: OcTracker, a: Agent, gen: number, ...es: OcEvent[]) => es.forEach((e) => a.take(applyEvent(t, gen, e)))

describe('the tracker: turns, steers and permissions', () => {
  it('a steer while an execution runs is a prompt in that turn, counted, opening none', () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 0, enq('msg_A', 1), step('asst_A1', 3), enq('msg_A2', 4, 'and also this'))
    expect([a.prompts, a.turn, a.running]).toEqual([2, 'msg_A', true])
    live(t, a, 0, ended(5))
    expect([a.status, a.prompts, a.stale]).toEqual(['finished', 2, []])
    // The same submission again (a duplicate frame): nothing.
    live(t, a, 0, enq('msg_A2', 4))
    expect(a.prompts).toBe(2)
  })

  it('two pending permissions answered out of order: each answers only its own call', () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 0, enq('msg_A', 1), step('asst_A1', 2), asked('per_1', 'asst_A1', 'call_1'), asked('per_2', 'asst_A1', 'call_2'))
    expect([a.status, a.waitingOn?.call]).toEqual(['waiting', 'call_2'])
    live(t, a, 0, replied('per_2'))
    // The answered one's wait ends; the one still pending is asked again: still needs you, now for call_1.
    expect([a.status, a.waitingOn?.call]).toEqual(['waiting', 'call_1'])
    live(t, a, 0, replied('per_1', 'reject'))
    expect([a.status, a.waitingOn]).toEqual(['working', null])
    // A reply to a request never seen: nothing.
    live(t, a, 0, replied('per_unknown'))
    expect(a.status).toBe('working')
  })

  it("a failed execution on a refused sign-in is the sign-in's; a transport failure is a retry while the turn goes on", () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 0, enq('msg_A', 1), step('asst_A1', 2), { type: 'session.retry.scheduled', assistantMessageID: 'asst_A1', error: { type: 'provider.transport', message: 'ECONNREFUSED' } })
    expect([a.running, a.stale]).toEqual([true, []])
    live(t, a, 0, { type: 'session.execution.failed', seq: 9, error: { type: 'provider.auth', message: 'Missing auth credential' } })
    expect(a.status).toBe('signin')
  })
})

describe('the tracker: settled snapshots (design s14 to s22)', () => {
  it("A ends and B starts during the snapshot's reads: the settled snapshot shows both, A's buffered end and permission never touch B", () => {
    const t = newTracker()
    const a = new Agent()
    // A runs, with a permission pending, then the stream drops.
    live(t, a, 1, enq('msg_A', 1), step('asst_A1', 2), asked('per_A', 'asst_A1', 'call_A'))
    expect(a.status).toBe('waiting')
    // The settled snapshot (W = 9): A answered and closed, B submitted and running.
    a.take(applySnapshot(t, 2, snap({ w: 9, session: { busy: 100, idle: 50 }, permissions: [], boundary: 'known', messages: [{ id: 'msg_A', type: 'user' }, { id: 'asst_A1', type: 'assistant' }, { id: 'idle_A', type: 'idle', outcome: 'succeeded' }, { id: 'msg_B', type: 'user', text: 'B' }, { id: 'asst_B1', type: 'assistant' }] })))
    expect([a.turn, a.running, a.status, a.waitingOn]).toEqual(['msg_B', true, 'working', null])
    // A's buffered events (all at or below W, and A's non-durable permission events): nothing happens to B.
    live(t, a, 2, ended(6), replied('per_A'), asked('per_A', 'asst_A1', 'call_A'), enq('msg_B', 7))
    expect([a.turn, a.running, a.status, a.prompts]).toEqual(['msg_B', true, 'working', 2])
    // B's own later events still land.
    live(t, a, 2, step('asst_B2', 10), asked('per_B', 'asst_B2', 'call_B'))
    expect(a.status).toBe('waiting')
    live(t, a, 2, replied('per_B'), ended(12))
    expect([a.status, a.prompts]).toEqual(['finished', 2])
  })

  it('two executions completed during a disconnect: replayed in order, each counted once', () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 1, enq('msg_A', 1), ended(3))
    a.take(applySnapshot(t, 2, snap({ w: 20, session: { busy: 10, idle: 20, outcome: 'interrupted' }, boundary: 'known', messages: [{ id: 'msg_A', type: 'user' }, { id: 'idle_A', type: 'idle', outcome: 'succeeded' }, { id: 'msg_B', type: 'user' }, { id: 'idle_B', type: 'idle', outcome: 'failed', error: { type: 'provider.invalid-request', message: 'bad' } }, { id: 'msg_C', type: 'user' }, { id: 'idle_C', type: 'idle', outcome: 'interrupted' }] })))
    expect([a.prompts, a.status, a.running, a.stale]).toEqual([3, 'ready', false, []])
    // The same snapshot again: nothing new.
    a.take(applySnapshot(t, 3, snap({ w: 20, boundary: 'known', messages: [{ id: 'msg_C', type: 'user' }, { id: 'idle_C', type: 'idle', outcome: 'interrupted' }] })))
    expect(a.prompts).toBe(3)
  })

  it("a stale generation's body (in flight when a newer snapshot was taken) is ignored", () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 1, enq('msg_A', 1))
    a.take(applySnapshot(t, 2, snap({ w: 5, session: { busy: 1, idle: 2, outcome: 'succeeded' }, boundary: 'known', messages: [{ id: 'msg_A', type: 'user' }, { id: 'idle_A', type: 'idle', outcome: 'succeeded' }] })))
    expect(a.status).toBe('finished')
    live(t, a, 1, asked('per_old', 'asst_A1', 'call'), enq('msg_old', 99))
    expect([a.status, a.prompts]).toEqual(['finished', 1])
  })

  it("a resumed session's baseline: its closed history counts nothing; one still open at the baseline is replayed", () => {
    const t = newTracker()
    const a = new Agent()
    const history = [{ id: 'm1', type: 'user' }, { id: 'i1', type: 'idle', outcome: 'succeeded' }, { id: 'm2', type: 'user' }, { id: 'i2', type: 'idle', outcome: 'failed' }, { id: 'm3', type: 'user' }, { id: 'i3', type: 'idle', outcome: 'succeeded' }]
    a.take(applySnapshot(t, 1, snap({ w: 30, baseline: true, intent: 'resume', session: { busy: 1, idle: 2, outcome: 'succeeded' }, messages: history })))
    expect([a.prompts, a.status, a.turn]).toEqual([0, 'ready', null])
    // A prompt after the TUI starts is new activity.
    live(t, a, 1, enq('m4', 31), ended(33))
    expect([a.prompts, a.status]).toEqual([1, 'finished'])
    const t2 = newTracker()
    const b = new Agent()
    b.take(applySnapshot(t2, 1, snap({ w: 8, baseline: true, intent: 'resume', session: { busy: 5, idle: 2 }, messages: [...history.slice(0, 2), { id: 'm5', type: 'user' }, { id: 'a5', type: 'assistant' }] })))
    expect([b.prompts, b.turn, b.running]).toEqual([1, 'm5', true])
  })

  it("a new session's baseline is empty: a prompt that completed before the first snapshot is counted, once", () => {
    const t = newTracker()
    const a = new Agent()
    a.take(applySnapshot(t, 1, snap({ w: 4, baseline: true, intent: 'new', session: { busy: 1, idle: 3, outcome: 'succeeded' }, messages: [{ id: 'm1', type: 'user' }, { id: 'a1', type: 'assistant' }, { id: 'i1', type: 'idle', outcome: 'succeeded' }] })))
    expect([a.prompts, a.status]).toEqual([1, 'finished'])
    // Its live events, buffered at or below the watermark: nothing more.
    live(t, a, 1, enq('m1', 1), ended(4))
    expect(a.prompts).toBe(1)
  })

  it('a long execution reached only by paging, and a bounded-out window: nothing invented; idle still ends the open turn', () => {
    const t = newTracker()
    const a = new Agent()
    // Partial: assistants only (the submission beyond the bound) and the session busy: no turn opened, no prompt counted.
    a.take(applySnapshot(t, 1, snap({ w: 50, baseline: true, intent: 'new', boundary: 'partial', session: { busy: 9, idle: 1 }, messages: [{ id: 'a1', type: 'assistant' }, { id: 'a2', type: 'assistant' }] })))
    expect([a.prompts, a.turn]).toEqual([0, null])
    // Known open turn, the window starting inside it: the session's idle ends it by its outcome.
    const t2 = newTracker()
    const b = new Agent()
    live(t2, b, 1, enq('m1', 1))
    b.take(applySnapshot(t2, 2, snap({ w: 60, boundary: 'partial', session: { busy: 9, idle: 12, outcome: 'interrupted' }, messages: [{ id: 'a9', type: 'assistant' }] })))
    expect([b.status, b.running]).toEqual(['ready', false])
  })

  it('a pending permission in a snapshot is raised for the open execution only; one gone since is answered', () => {
    const t = newTracker()
    const a = new Agent()
    live(t, a, 1, enq('m1', 1), step('a1', 2), asked('per_gone', 'a1', 'call_gone'))
    a.take(applySnapshot(t, 2, snap({ w: 5, boundary: 'known', session: { busy: 9, idle: 1 }, messages: [{ id: 'm1', type: 'user' }, { id: 'a1', type: 'assistant' }, { id: 'a2', type: 'assistant' }], permissions: [{ id: 'per_new', messageID: 'a2', callID: 'call_new', action: 'edit', resources: 'x.ts' }, { id: 'per_other', messageID: 'a_unknown', callID: 'c' }] })))
    expect([a.status, a.waitingOn?.call, a.waitingOn?.message]).toEqual(['waiting', 'call_new', 'edit: x.ts'])
  })
})

describe("a compaction (HI-2762's 2.2.6 recording: its own execution, under its inbox item of type compaction)", () => {
  const compacting = (a: Agent) => a.status === 'working' && a.statusMessage === COMPACTING_MESSAGE
  /** The recording's messages as the launcher's snapshot has them: oldest first, projected (ProjectMessage). */
  const messages = () => (JSON.parse(readFileSync(join(REC, 'messages', 'compaction.json'), 'utf8')).body.data as Record<string, any>[]).reverse().map((m) => ({ id: m.id, type: m.type, ...(m.outcome ? { outcome: m.outcome } : {}), ...(m.type === 'compaction' ? { status: m.status, reason: m.reason } : {}) }))
  const ev = recorded('compaction')
  const sid = sidOf(ev)
  const upTo = (type: string, nth = 1) => {
    let n = 0
    return ev.findIndex((e) => e.type === type && ++n === nth)
  }

  it('compacting from its start to its execution’s end, then ready; one prompt counted (the compaction is none), nothing stale', () => {
    const t = newTracker()
    const a = new Agent()
    let during = false
    for (const raw of ev) {
      const e = projectEvent(raw, sid)
      if (!e) continue
      a.take(applyEvent(t, 0, e))
      if (raw.type === 'session.compaction.ended') during = compacting(a)
    }
    expect([during, a.status, a.statusMessage ?? null, a.prompts, a.running, a.stale, t.compacting]).toEqual([true, 'ready', null, 1, false, [], null])
  })

  it('its submission alone says nothing; its start makes the agent compacting', () => {
    const t = newTracker()
    const a = new Agent()
    for (const raw of ev.slice(0, upTo('session.compaction.started'))) {
      const e = projectEvent(raw, sid)
      if (e) a.take(applyEvent(t, 0, e))
    }
    expect([a.status, t.compacting?.shown]).toEqual(['finished', false])
    a.take(applyEvent(t, 0, projectEvent(ev[upTo('session.compaction.started')], sid)!))
    expect(compacting(a)).toBe(true)
  })

  it('the stream dropped after its submission: the settled snapshot after the reconnect starts and ends it, ready', () => {
    const t = newTracker()
    const a = new Agent()
    for (const raw of ev.slice(0, upTo('session.inbox.enqueued', 2) + 1)) {
      const e = projectEvent(raw, sid)
      if (e) a.take(applyEvent(t, 0, e))
    }
    a.take(applySnapshot(t, 2, snap({ w: 21, boundary: 'start', session: { busy: 1, idle: 2, outcome: 'succeeded' }, messages: messages() })))
    expect([a.status, a.statusMessage ?? null, a.prompts, a.stale, t.compacting]).toEqual(['ready', null, 1, [], null])
  })

  it('the stream dropped before it: a snapshot showing it under way makes the agent compacting; its execution’s end, live, ready', () => {
    const t = newTracker()
    const a = new Agent()
    for (const raw of ev.slice(0, upTo('session.execution.succeeded') + 1)) {
      const e = projectEvent(raw, sid)
      if (e) a.take(applyEvent(t, 0, e))
    }
    const running = messages().slice(0, -1).map((m) => (m.type === 'compaction' ? { ...m, status: 'running' } : m))
    a.take(applySnapshot(t, 2, snap({ w: 18, boundary: 'start', session: { busy: 3, idle: 2 }, messages: running })))
    expect(compacting(a)).toBe(true)
    a.take(applyEvent(t, 2, projectEvent(ev[upTo('session.execution.succeeded', 2)], sid)!))
    expect([a.status, a.statusMessage ?? null, a.stale]).toEqual(['ready', null, []])
  })

  it('a resumed session’s closed compaction (at its baseline) counts nothing', () => {
    const t = newTracker()
    const a = new Agent()
    a.take(applySnapshot(t, 1, snap({ w: 21, baseline: true, intent: 'resume', boundary: 'start', session: { busy: 1, idle: 2, outcome: 'succeeded' }, messages: messages() })))
    expect([a.status, a.prompts, t.open]).toEqual(['ready', 0, null])
  })

  it('session.usage.updated is projected (cost and tokens, numbers only) and gives no hook', () => {
    const raw = ev.find((e) => e.type === 'session.usage.updated')!
    const e = projectEvent(raw, sid)!
    expect(e).toEqual({ type: 'session.usage.updated', cost: 0, tokens: { input: 457, output: 312, reasoning: 0, cache: { read: 0, write: 0 } } })
    expect(applyEvent(newTracker(), 0, e)).toEqual([])
    expect(projectEvent({ type: 'session.usage.updated', data: { sessionID: sid, cost: 'x', tokens: { input: '1' } } }, sid)).toMatchObject({ tokens: { input: undefined } })
  })
})

describe('the hook bodies', () => {
  it('a raw body expands into normalized ones; anything else is none, and normalizes to ignore', () => {
    const memo: Record<string, unknown> = {}
    const out = expandOpencodeHook(memo, { hook_event_name: 'OpencodeEvent', session_id: 'ses_x', gen: 0, event: enq('m1', 1) })!
    expect(out).toHaveLength(1)
    expect(normalizeOpencodeHook(out[0] as Record<string, any>)).toMatchObject({ event: { kind: 'prompt', text: 'm1' }, sessionId: 'ses_x', ids: { turn: 'm1' } })
    expect(expandOpencodeHook(memo, { hook_event_name: 'OpencodeNormalized' })).toBeNull()
    expect(normalizeOpencodeHook({ hook_event_name: 'Stop' }).event).toEqual({ kind: 'ignore' })
  })
})
