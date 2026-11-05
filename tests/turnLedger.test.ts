import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { admit, endRunning, expectInjected, heard, newLedger, openCalls, reconciles, silentFor, unheardStop, type TurnLedger } from '../src/main/turnLedger'
import { applyStep, hookStep, type HookStatusInput } from '../src/main/hookStatus'
import type { HookEvent, HookIds, ProviderAdapter } from '../src/main/providers/types'
import { COMPACTING_MESSAGE } from '../src/shared/defaults'
import type { SessionStatus } from '../src/shared/types'

/**
 * The turn ledger (#648): hooks as each CLI sends them, through its adapter, the ledger and the status rules, as
 * SessionManager.handleHookNow does. The sequences recorded from the real CLIs (#645's spike) are in tests/fixtures.
 */

const ids = (turn: string | null, extra: Partial<HookIds> = {}): HookIds => ({ turn, call: null, sub: null, continued: false, ...extra })

interface Agent {
  status: SessionStatus
  statusMessage?: string
  ledger: TurnLedger
  stale: string[]
}

const agent = (status: SessionStatus = 'ready'): Agent => ({ status, ledger: newLedger(0), stale: [] })

const input = (a: Agent): HookStatusInput => ({ status: a.status, statusMessage: a.statusMessage, askedAtStart: false, compacting: null, backgroundWakes: false, tasks: 0, attention: 'hooks', reviewed: false, titleAsks: false, open: [], waitingOn: null, question: false, reviewing: false, safeguardPrompt: false })

/** One hook through the ledger and the status rules; `continued`: Combwork answered this Stop with a continuation. */
function feed(a: Agent, ev: HookEvent, i: HookIds, continued = false): Agent {
  const took = admit(a.ledger, ev, i, { hiveContinued: continued, now: a.ledger.seq })
  if (took.verdict === 'apply') applyStep(a, hookStep(took.event, input(a)))
  else a.stale.push(took.verdict === 'stale' ? took.why : 'continued')
  return a
}

/** Hook bodies through a provider's own normaliser. */
function send(adapter: ProviderAdapter, a: Agent, bodies: Record<string, unknown>[], continued: (body: Record<string, unknown>, i: number) => boolean = () => false): Agent {
  bodies.forEach((body, i) => {
    const h = adapter.normalizeHook(body)
    feed(a, h.event, h.ids, h.event.kind === 'stop' && continued(body, i))
  })
  return a
}

const fixture = (name: string): Record<string, unknown>[] => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')).hooks

/** A hook of every kind that can name a turn (`t`), the launch-wide ones too (SessionStart, SessionEnd, compaction). */
const everyKind = (t: string): [HookEvent, HookIds][] => [
  [{ kind: 'toolEnd' }, ids(t, { call: 'c1' })],
  [{ kind: 'toolStart' }, ids(t, { call: 'c2' })],
  [{ kind: 'prompt', text: 'late' }, ids(t)],
  [{ kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'May I?' } }, ids(t)],
  [{ kind: 'stop', lastMessage: null }, ids(t)],
  [{ kind: 'interrupt' }, ids(t)],
  [{ kind: 'idle' }, ids(t)],
  [{ kind: 'signIn', message: null }, ids(t)],
  [{ kind: 'start', source: 'compact' }, ids(t)],
  [{ kind: 'end' }, ids(t)],
  [{ kind: 'compactStart', trigger: 'auto' }, ids(t)],
  [{ kind: 'compactEnd' }, ids(t)]
]

describe('the turn ledger', () => {
  it('a final turn with no tool call ends with its Stop', () => {
    const a = feed(feed(agent(), { kind: 'prompt', text: 'hi' }, ids('t1')), { kind: 'stop', lastMessage: 'done' }, ids('t1'))
    expect(a.status).toBe('finished')
    expect(a.ledger.active).toMatchObject({ id: 't1', state: 'over', endedBy: 'stop' })
  })

  it("a tool's late end after its turn's Stop is old news: the agent stays finished (#642)", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(['a tool end of a turn that is over'])
  })

  it("only a start reopens a turn after its Stop: a tool call it never started, from the ids alone (no screen)", () => {
    // Another Stop hook (the user's) carried the turn on: its next tool call is a start of it, and its own Stop ends it.
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c2' }))
    expect([a.status, a.ledger.active?.state, openCalls(a.ledger)]).toEqual(['working', 'running', 1])
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { continued: true }))
    expect([a.status, a.ledger.active?.state]).toEqual(['finished', 'over'])
    // A start of a call the turn already started (a repeated or delayed PreToolUse) is no start of it.
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    expect([a.status, a.ledger.active?.state]).toEqual(['finished', 'over'])
    // End news never reopens it: a tool end, an interrupt, the CLI idle, a refused sign-in, a Stop.
    const ends: [HookEvent, HookIds][] = [
      [{ kind: 'toolEnd' }, ids('t1', { call: 'c9' })],
      [{ kind: 'interrupt' }, ids('t1')],
      [{ kind: 'idle' }, ids('t1')],
      [{ kind: 'signIn', message: null }, ids('t1')],
      [{ kind: 'stop', lastMessage: null }, ids('t1')]
    ]
    for (const [ev, i] of ends) {
      feed(a, ev, i)
      expect(a.ledger.active?.state, ev.kind).toBe('over')
    }
    expect(a.stale).toEqual(['a tool start of a call its turn started before it ended', 'a tool end of a turn that is over'])
  })

  it('without turn ids (Copilot), a tool end after the turn ended with no tool start since is old news; a start carries it on', () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids(null))
    feed(a, { kind: 'toolStart' }, ids(null))
    feed(a, { kind: 'stop', lastMessage: null }, ids(null))
    feed(a, { kind: 'toolEnd' }, ids(null))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(['a tool end after its turn ended, with no tool start since'])
    feed(a, { kind: 'toolStart' }, ids(null))
    expect([a.status, a.ledger.active?.state]).toEqual(['working', 'running'])
    // No turn known at all: a tool start alone changes nothing (as before the ledger).
    const fresh = feed(agent('ready'), { kind: 'toolStart' }, ids(null))
    expect([fresh.status, fresh.ledger.active]).toEqual(['ready', null])
  })

  it("an earlier turn's late news, of every kind (launch-wide ones too), changes nothing while a later turn runs or after it, and never makes it active", () => {
    for (const [ev, i] of everyKind('t1')) {
      for (const after of [false, true]) {
        const a = agent()
        feed(a, { kind: 'prompt' }, ids('t1'))
        feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
        feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
        feed(a, { kind: 'prompt' }, ids('t2'))
        if (after) feed(a, { kind: 'stop', lastMessage: null }, ids('t2'))
        feed(a, ev, i)
        // HR3's case: a delayed PreCompact or SessionEnd of t1 once t2 is over left it working (Compacting) or stopped.
        expect([a.status, a.statusMessage, a.ledger.active?.id, a.ledger.active?.state], `${ev.kind} ${after}`).toEqual(after ? ['finished', undefined, 't2', 'over'] : ['working', undefined, 't2', 'running'])
        expect(a.stale, ev.kind).toHaveLength(1)
        expect(a.stale[0], ev.kind).toMatch(/of an earlier turn$/)
      }
    }
  })

  it("an id Combwork doesn't remember is stale, never new: only a start opens one under an id never seen (a prompt; a compaction, below)", () => {
    // A turn the CLI began without a prompt hook (no prompt seen), news of every other kind under it: nothing changes.
    const kinds = everyKind('t-never').filter(([ev]) => ev.kind !== 'prompt' && ev.kind !== 'compactStart')
    expect(kinds).toHaveLength(10)
    for (const [ev, i] of kinds) {
      // While a turn runs, and after it ended.
      const a = feed(agent(), { kind: 'prompt' }, ids('t1'))
      feed(a, ev, i)
      expect([a.status, a.ledger.active?.id, a.ledger.active?.state], ev.kind).toEqual(['working', 't1', 'running'])
      feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
      feed(a, ev, i)
      expect([a.status, a.ledger.active?.id, a.ledger.active?.state], ev.kind).toEqual(['finished', 't1', 'over'])
      expect(a.stale, ev.kind).toHaveLength(2)
      expect(a.stale.every((why) => why.endsWith('of a turn Combwork saw no prompt for')), ev.kind).toBe(true)
    }
    // With no turn known yet either.
    const fresh = feed(agent('ready'), { kind: 'toolStart' }, ids('t-never', { call: 'c' }))
    expect([fresh.status, fresh.ledger.active]).toEqual(['ready', null])
    // A prompt under a new id opens it.
    const p = feed(agent(), { kind: 'prompt' }, ids('t-new'))
    expect([p.status, p.ledger.active?.id]).toEqual(['working', 't-new'])
  })

  it("a compaction the CLI begins itself comes under an id of its own, with no prompt (Claude Code 2.1.296): it opens that compaction, and only the compaction's own news follows", () => {
    const a = feed(feed(agent(), { kind: 'prompt' }, ids('t1')), { kind: 'stop', lastMessage: null }, ids('t1'))
    // /compact while idle: PreCompact, SessionStart (compact), PostCompact, all under k1.
    feed(a, { kind: 'compactStart', trigger: 'manual' }, ids('k1'))
    expect([a.status, a.statusMessage, a.ledger.compaction, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['working', COMPACTING_MESSAGE, { id: 'k1', open: true }, 't1', 'over'])
    // A repeated start while it runs is no new compaction (HR3, round 4).
    feed(a, { kind: 'compactStart', trigger: 'manual' }, ids('k1'))
    feed(a, { kind: 'start', source: 'compact' }, ids('k1'))
    feed(a, { kind: 'compactEnd' }, ids('k1'))
    expect([a.status, a.statusMessage, a.ledger.compaction, a.stale]).toEqual(['ready', undefined, { id: 'k1', open: false }, ['a repeated compaction start']])
    // Over: a delayed or repeated start of it, or its other news, changes nothing (it froze the agent "Compacting…").
    feed(a, { kind: 'compactStart', trigger: 'manual' }, ids('k1'))
    feed(a, { kind: 'start', source: 'compact' }, ids('k1'))
    feed(a, { kind: 'compactEnd' }, ids('k1'))
    expect([a.status, a.statusMessage, a.ledger.compaction?.open]).toEqual(['ready', undefined, false])
    expect(a.stale.slice(1)).toEqual(['a compaction start of a compaction that is over', 'a session start of a compaction that is over', 'a compaction end of a compaction that is over'])
    // A turn's news under its id is no turn's: stale.
    feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c9' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('k1'))
    feed(a, { kind: 'idle' }, ids('k1'))
    expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['ready', 't1', 'over'])
    expect(a.stale.slice(4)).toEqual(["a tool start under a compaction's id", "a Stop under a compaction's id", "idle news under a compaction's id"])
    // A new turn ends it: its late news is an earlier one's.
    feed(a, { kind: 'prompt' }, ids('t2'))
    feed(a, { kind: 'compactEnd' }, ids('k1'))
    feed(a, { kind: 'end' }, ids('k1'))
    expect([a.status, a.ledger.compaction, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['working', null, 't2', 'running'])
    expect(a.stale.slice(7)).toEqual(['a compaction end of an earlier turn', 'a session end of an earlier turn'])
    // The launch's SessionEnd under the compaction's id (the latest the CLI named) stops it.
    const b = feed(feed(agent(), { kind: 'prompt' }, ids('t1')), { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(b, { kind: 'compactStart', trigger: 'auto' }, ids('k1'))
    feed(b, { kind: 'compactEnd' }, ids('k1'))
    feed(b, { kind: 'compactStart', trigger: 'auto' }, ids('k1'))
    feed(b, { kind: 'end' }, ids('k1'))
    expect([b.status, b.stale]).toEqual(['stopped', ['a compaction start of a compaction that is over']])
    // A later compaction under an id of its own is a new one; the earlier one's news stays stale.
    const d = feed(feed(agent(), { kind: 'prompt' }, ids('t1')), { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(d, { kind: 'compactStart', trigger: 'manual' }, ids('k1'))
    feed(d, { kind: 'compactEnd' }, ids('k1'))
    feed(d, { kind: 'compactStart', trigger: 'manual' }, ids('k2'))
    expect([d.status, d.ledger.compaction]).toEqual(['working', { id: 'k2', open: true }])
    feed(d, { kind: 'compactStart', trigger: 'manual' }, ids('k1'))
    feed(d, { kind: 'compactEnd' }, ids('k2'))
    expect([d.status, d.statusMessage, d.stale]).toEqual(['ready', undefined, ['a compaction start of an earlier turn']])
    // Only while no turn runs (Darren, option B): one under an id of another while a turn runs opens nothing, and the
    // running turn's own news goes on.
    const c = feed(agent(), { kind: 'prompt' }, ids('t1'))
    feed(c, { kind: 'compactStart', trigger: 'auto' }, ids('k2'))
    feed(c, { kind: 'compactEnd' }, ids('k2'))
    feed(c, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
    expect([c.status, c.statusMessage, c.ledger.compaction, c.ledger.active?.id, c.ledger.active?.state, openCalls(c.ledger)]).toEqual(['working', undefined, null, 't1', 'running', 1])
    expect(c.stale).toEqual(['a compaction start of a turn Combwork saw no prompt for', 'a compaction end of a turn Combwork saw no prompt for'])
    // An end with no start seen opens nothing (above: a compaction end under an id never seen is stale).
  })

  describe('a turn under the id of a compaction the CLI began itself (HI-1916: Codex 0.164, HR5 on 27 Oct)', () => {
    /** An agent whose CLI began a compaction itself under k1 while no turn ran, and (`over`) finished it. */
    const compacted = (over: boolean): Agent => {
      const a = feed(feed(agent(), { kind: 'prompt' }, ids('t1')), { kind: 'stop', lastMessage: null }, ids('t1'))
      feed(a, { kind: 'compactStart', trigger: 'auto' }, ids('k1'))
      if (over) feed(a, { kind: 'compactEnd' }, ids('k1'))
      return a
    }

    it('its prompt begins that turn, after the compaction or while it is still under way; its news then follows as any turn', () => {
      for (const over of [true, false]) {
        const a = compacted(over)
        feed(a, { kind: 'prompt' }, ids('k1'))
        expect([a.status, a.ledger.compaction, a.ledger.active?.id, a.ledger.active?.state], `over ${over}`).toEqual(['working', null, 'k1', 'running'])
        feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c1' }))
        expect(openCalls(a.ledger)).toBe(1)
        feed(a, { kind: 'toolEnd' }, ids('k1', { call: 'c1' }))
        feed(a, { kind: 'stop', lastMessage: null }, ids('k1'))
        expect([a.status, a.ledger.active?.state, a.stale], `over ${over}`).toEqual(['finished', 'over', []])
      }
    })

    it("a turn's news under the id before that prompt stays stale", () => {
      const a = compacted(true)
      feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c1' }))
      feed(a, { kind: 'ask', ask: { kind: 'permission', blocking: true, message: 'May I?' } }, ids('k1'))
      expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['ready', 't1', 'over'])
      expect(a.stale).toEqual(["a tool start under a compaction's id", "a question under a compaction's id"])
    })

    it('a second prompt while it runs is a prompt in the running turn; one after its Stop opens nothing again', () => {
      const a = compacted(true)
      feed(a, { kind: 'prompt' }, ids('k1'))
      expect(admit(a.ledger, { kind: 'prompt' }, ids('k1'), { now: a.ledger.seq })).toMatchObject({ verdict: 'apply', note: 'a prompt in the running turn' })
      feed(a, { kind: 'stop', lastMessage: null }, ids('k1'))
      feed(a, { kind: 'prompt' }, ids('k1'))
      expect([a.status, a.ledger.active?.state, a.stale]).toEqual(['finished', 'over', ['a prompt of a turn that is over']])
    })

    it("the compaction's own late end or SessionStart under the id is old news: the running turn stays working", () => {
      for (const over of [true, false]) {
        const a = compacted(over)
        feed(a, { kind: 'prompt' }, ids('k1'))
        feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c1' }))
        feed(a, { kind: 'compactEnd' }, ids('k1'))
        feed(a, { kind: 'start', source: 'compact' }, ids('k1'))
        feed(a, { kind: 'compactEnd' }, ids('k1'))
        expect([a.status, a.statusMessage, a.ledger.active?.state, openCalls(a.ledger)], `over ${over}`).toEqual(['working', undefined, 'running', 1])
        expect(a.stale, `over ${over}`).toEqual(['a compaction end of the compaction its turn took the id of', 'a session start of the compaction its turn took the id of', 'a compaction end of the compaction its turn took the id of'])
        // The launch's SessionEnd still ends it.
        feed(a, { kind: 'end' }, ids('k1'))
        expect(a.status).toBe('stopped')
      }
    })

    it("a compaction of the turn's own later on (HR6's round 1: a long turn fills its context again) is handled as any turn's: working throughout, seen as compacting", () => {
      const a = compacted(true)
      feed(a, { kind: 'prompt' }, ids('k1'))
      feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c1' }))
      feed(a, { kind: 'toolEnd' }, ids('k1', { call: 'c1' }))
      // Its PreCompact: admitted, and the status rules see a compaction mid-turn (autoCompact: the runtime's compacting).
      const start = admit(a.ledger, { kind: 'compactStart', trigger: 'auto' }, ids('k1'), { now: a.ledger.seq })
      expect(start).toEqual({ verdict: 'apply', event: { kind: 'compactStart', trigger: 'auto' } })
      const step = hookStep((start as { event: HookEvent }).event, input(a))
      expect([step.next, step.actions]).toEqual([null, ['autoCompact']])
      applyStep(a, step)
      // Its SessionStart and PostCompact: admitted too, as a mid-turn compaction's (the turn stays working).
      feed(a, { kind: 'start', source: 'compact' }, ids('k1'))
      feed(a, { kind: 'compactEnd' }, ids('k1'))
      feed(a, { kind: 'toolStart' }, ids('k1', { call: 'c2' }))
      expect([a.status, a.statusMessage, a.ledger.active?.state, openCalls(a.ledger), a.stale]).toEqual(['working', undefined, 'running', 1, []])
      feed(a, { kind: 'toolEnd' }, ids('k1', { call: 'c2' }))
      feed(a, { kind: 'stop', lastMessage: null }, ids('k1'))
      expect(a.status).toBe('finished')
    })

    it("an older compaction's id after a newer turn began is old news", () => {
      const a = compacted(true)
      feed(a, { kind: 'prompt' }, ids('t2'))
      for (const [ev, i] of everyKind('k1')) feed(a, ev, i)
      expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['working', 't2', 'running'])
      expect(a.stale.every((w) => w.endsWith('of an earlier turn'))).toBe(true)
    })

    it("Codex 0.164.0's recorded sequence (HR5's hooks.log): heard as a turn, its question asked, then finished", async () => {
      const { codex } = await import('../src/main/providers/codex/adapter')
      const hooks = fixture('turns-codex-0.164.0-compaction-turn.json')
      const a = feed(feed(agent(), { kind: 'prompt' }, ids('t0')), { kind: 'stop', lastMessage: null }, ids('t0'))
      const asked = hooks.findIndex((b) => b.hook_event_name === 'PermissionRequest')
      send(codex, a, hooks.slice(0, asked))
      expect([a.status, a.ledger.active?.id, openCalls(a.ledger)]).toEqual(['working', hooks[0].turn_id, 1])
      send(codex, a, hooks.slice(asked, asked + 1))
      expect(a.status).toBe('waiting')
      send(codex, a, hooks.slice(asked + 1))
      expect([a.status, a.ledger.active?.state]).toEqual(['finished', 'over'])
      expect(a.stale).toEqual([])
    })
  })

  it("a background task's wake (Darren, 12 Oct): its prompt opens it; should that hook be lost, only a tool call the launch never saw does, only while the CLI woke", () => {
    const woke = (a: Agent, ev: HookEvent, i: HookIds, yes: boolean): Agent => {
      const took = admit(a.ledger, ev, i, { woke: yes, now: a.ledger.seq })
      if (took.verdict === 'apply') applyStep(a, hookStep(took.event, input(a)))
      else a.stale.push(took.verdict === 'stale' ? took.why : 'continued')
      return a
    }
    const background = (): Agent => {
      const a = agent()
      feed(a, { kind: 'prompt' }, ids('t1'))
      feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c1' }))
      feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c1' }))
      feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
      a.status = 'background'
      return a
    }
    // As Claude Code 2.1.296 wakes: a prompt (the task's notification) under a new id.
    const a = background()
    feed(a, { kind: 'prompt', text: '<task-notification>\n<task-id>b1</task-id>…' }, ids('t2'))
    expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['working', 't2', 'running'])
    feed(a, { kind: 'toolStart' }, ids('t2', { call: 'c2' }))
    feed(a, { kind: 'toolEnd' }, ids('t2', { call: 'c2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t2'))
    expect([a.status, a.ledger.active?.state, a.stale]).toEqual(['finished', 'over', []])
    // Its prompt hook lost. Nothing but an identified start opens it, and only while the CLI woke.
    const b = background()
    woke(b, { kind: 'toolStart' }, ids('t2', { call: 'c2' }), false)
    woke(b, { kind: 'toolStart' }, ids('t2', { call: 'c1' }), true)
    woke(b, { kind: 'toolStart' }, ids('t2'), true)
    woke(b, { kind: 'toolStart' }, ids('t2', { call: 'c3', sub: 'agent-1' }), true)
    for (const [ev, i] of everyKind('t2').filter(([e]) => e.kind !== 'toolStart' && e.kind !== 'prompt' && e.kind !== 'compactStart')) woke(b, ev, i, true)
    expect([b.status, b.ledger.active?.id, b.ledger.active?.state]).toEqual(['background', 't1', 'over'])
    expect(b.stale).toHaveLength(13)
    expect(b.stale.every((why) => why.endsWith('of a turn Combwork saw no prompt for'))).toBe(true)
    // While it woke, a tool call the launch never saw: that turn begins.
    woke(b, { kind: 'toolStart' }, ids('t2', { call: 'c2' }), true)
    expect([b.status, b.ledger.active?.id, b.ledger.active?.state, openCalls(b.ledger)]).toEqual(['working', 't2', 'running', 1])
    feed(b, { kind: 'toolEnd' }, ids('t2', { call: 'c2' }))
    feed(b, { kind: 'stop', lastMessage: null }, ids('t2'))
    expect([b.status, b.ledger.active?.state]).toEqual(['finished', 'over'])
    // A turn running, or an earlier turn's id: stale even while it woke.
    feed(b, { kind: 'prompt' }, ids('t3'))
    woke(b, { kind: 'toolStart' }, ids('t4', { call: 'c4' }), true)
    woke(b, { kind: 'toolStart' }, ids('t1', { call: 'c5' }), true)
    expect([b.ledger.active?.id, b.ledger.active?.state]).toEqual(['t3', 'running'])
    expect(b.stale.slice(13)).toEqual(['a tool start of a turn Combwork saw no prompt for', 'a tool start of an earlier turn'])
  })

  it('past the bound on remembered ids, a forgotten id is stale, never a new turn, also while the CLI woke (the bound itself: maxSeen)', () => {
    const a: Agent = { status: 'ready', ledger: newLedger(0, { maxSeen: 5 }), stale: [] }
    for (let n = 0; n < 6; n++) {
      feed(a, { kind: 'prompt' }, ids(`t${n}`))
      feed(a, { kind: 'toolStart' }, ids(`t${n}`, { call: `c${n}` }))
      feed(a, { kind: 'stop', lastMessage: null }, ids(`t${n}`))
    }
    // Six turns, five kept: t0 is forgotten, t1 is the oldest remembered.
    expect([a.ledger.seen.has('t0'), a.ledger.seen.has('t1'), a.ledger.seen.size, a.ledger.forgot]).toEqual([false, true, 5, true])
    for (const t of ['t0', 't1']) {
      feed(a, { kind: 'toolStart' }, ids(t, { call: 'c' }))
      feed(a, { kind: 'toolEnd' }, ids(t, { call: 'c' }))
      feed(a, { kind: 'stop', lastMessage: null }, ids(t))
      feed(a, { kind: 'idle' }, ids(t))
      feed(a, { kind: 'compactStart', trigger: 'auto' }, ids(t))
      feed(a, { kind: 'end' }, ids(t))
    }
    expect([a.status, a.ledger.active?.id, a.ledger.active?.state]).toEqual(['finished', 't5', 'over'])
    const kinds = ['a tool start', 'a tool end', 'a Stop', 'idle news', 'a compaction start', 'a session end']
    expect(a.stale).toEqual([...kinds.map((k) => `${k} of a turn Combwork saw no prompt for`), ...kinds.map((k) => `${k} of an earlier turn`)])
    // While the CLI woke too (HR3's case: a delayed PreToolUse of t0, its own call or a new one), and a compaction start
    // under an id never seen: past the bound an id not remembered may be an earlier one, so nothing opens.
    a.status = 'background'
    for (const call of ['c0', 'c-new']) expect(admit(a.ledger, { kind: 'toolStart' }, ids('t0', { call }), { woke: true }), call).toEqual({ verdict: 'stale', why: 'a tool start of a turn Combwork saw no prompt for' })
    expect(admit(a.ledger, { kind: 'toolStart' }, ids('t-new', { call: 'c-new' }), { woke: true }).verdict).toBe('stale')
    expect(admit(a.ledger, { kind: 'compactStart', trigger: 'auto' }, ids('k-new')).verdict).toBe('stale')
    expect([a.ledger.active?.id, a.ledger.active?.state, a.ledger.compaction]).toEqual(['t5', 'over', null])
    // A prompt still opens a turn.
    feed(a, { kind: 'prompt' }, ids('t6'))
    expect([a.status, a.ledger.active?.id]).toEqual(['working', 't6'])
    // The bound on call ids (maxSeen × 10) closes the wake's opening the same way.
    const b: Agent = { status: 'ready', ledger: newLedger(0, { maxSeen: 2 }), stale: [] }
    feed(b, { kind: 'prompt' }, ids('t1'))
    for (let n = 0; n < 20; n++) feed(b, { kind: 'toolStart' }, ids('t1', { call: `c${n}` }))
    expect(b.ledger.forgot).toBe(false)
    feed(b, { kind: 'toolStart' }, ids('t1', { call: 'c20' }))
    feed(b, { kind: 'stop', lastMessage: null }, ids('t1'))
    expect([b.ledger.calls.has('c0'), b.ledger.forgot]).toEqual([false, true])
    expect(admit(b.ledger, { kind: 'toolStart' }, ids('t2', { call: 'c-new' }), { woke: true }).verdict).toBe('stale')
  })

  it("a Stop Combwork answered with a continuation is not the turn's end: the Stop answered with nothing is", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'), true)
    expect(a.status).toBe('working')
    expect(a.ledger.active).toMatchObject({ state: 'running', continued: 1, stops: 1 })
    // Continuations fire no prompt: the next hooks are the same turn's.
    feed(a, { kind: 'toolStart' }, ids('t1', { call: 'c2', continued: true }))
    feed(a, { kind: 'toolEnd' }, ids('t1', { call: 'c2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { continued: true }))
    expect(a.status).toBe('finished')
  })

  it("a sub-agent's tools are its parent's turn's while it runs, and don't carry on one that is over", () => {
    const a = agent()
    feed(a, { kind: 'prompt' }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { sub: 'agent-1', call: 's1' }))
    expect(a.stale).toEqual([])
    feed(a, { kind: 'toolEnd' }, ids('t1', { sub: 'agent-1', call: 's1' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1'))
    feed(a, { kind: 'toolStart' }, ids('t1', { sub: 'agent-1', call: 's2' }))
    feed(a, { kind: 'stop', lastMessage: null }, ids('t1', { sub: 'agent-1' }))
    expect(a.status).toBe('finished')
    expect(a.stale).toEqual(["a sub-agent's tool outside the running turn", "a sub-agent's Stop"])
  })

  it("a prompt in the running turn isn't a new turn; one Combwork put there itself isn't a prompt at all (Messaging 5)", () => {
    const a = agent()
    feed(a, { kind: 'prompt', text: 'go' }, ids('t1'))
    const mid = admit(a.ledger, { kind: 'prompt', text: 'a word from the user' }, ids('t1'))
    expect(mid).toMatchObject({ verdict: 'apply', note: 'a prompt in the running turn' })
    expect(a.ledger.active?.id).toBe('t1')
    expectInjected(a.ledger, 'You have  2 messages:\ncall cw_inbox')
    const own = admit(a.ledger, { kind: 'prompt', text: 'You have 2 messages: call cw_inbox' }, ids('t1'))
    expect(own).toMatchObject({ verdict: 'apply', event: { kind: 'prompt', injected: true } })
    expect(hookStep((own as { event: HookEvent }).event, input(a))).toEqual({ next: null, actions: [] })
    // Only once: the same text again is the CLI's own.
    expect(admit(a.ledger, { kind: 'prompt', text: 'You have 2 messages: call cw_inbox' }, ids('t1'))).not.toMatchObject({ event: { injected: true } })
  })

  it('an interrupt, a refused sign-in and the CLI idle at its prompt end the running turn', () => {
    for (const ev of [{ kind: 'interrupt' }, { kind: 'signIn', message: null }, { kind: 'idle' }] as HookEvent[]) {
      const a = feed(agent(), { kind: 'prompt' }, ids('t1'))
      feed(a, ev, ids(null))
      expect(a.ledger.active?.state, ev.kind).toBe('over')
      feed(a, { kind: 'toolEnd' }, ids('t1'))
      expect(a.stale, ev.kind).toEqual(['a tool end of a turn that is over'])
    }
  })

  it('silence: of a running turn, from when the CLI was last heard, open tool calls or not (their ends can be lost); never an end by itself', () => {
    const l = newLedger(0)
    expect(silentFor(l, 1000)).toBeNull()
    admit(l, { kind: 'prompt' }, ids('t1'), { now: 0 })
    expect(silentFor(l, 60_000)).toBe(60_000)
    admit(l, { kind: 'toolStart' }, ids('t1', { call: 'c' }), { now: 60_000 })
    expect([silentFor(l, 6 * 3600_000), openCalls(l)]).toEqual([6 * 3600_000 - 60_000, 1])
    admit(l, { kind: 'toolEnd' }, ids('t1', { call: 'c' }), { now: 70_000 })
    heard(l, 100_000)
    expect([silentFor(l, 400_000), openCalls(l)]).toEqual([300_000, 0])
    expect(l.active?.state).toBe('running')
  })

  it("the CLI's record of a turn's end by id reconciles only the turn Combwork has running under that id", () => {
    const l = newLedger(0)
    admit(l, { kind: 'prompt' }, ids('t2'))
    expect(reconciles(l, 't1')).toBe(false)
    expect(reconciles(l, 't2')).toBe(true)
    endRunning(l, 'transcript')
    expect(reconciles(l, 't2')).toBe(false)
    // A running turn whose prompt hook named none can't be told to be the record's.
    const c = newLedger(0)
    admit(c, { kind: 'prompt' }, ids(null))
    expect(reconciles(c, 't1')).toBe(false)
  })

  it("records naming no turn (Copilot): a Stop answered since the turn began that Combwork never got ends it; earlier ones don't", () => {
    // An earlier turn's Stop answered at 900 (in the tail read with the new prompt): not this turn's.
    const c = newLedger(0)
    admit(c, { kind: 'prompt' }, ids(null), { now: 1000 })
    expect(unheardStop(c, [900])).toBe(false)
    // Carried on by Combwork once, then its final Stop missed: the second answer is one Combwork never got.
    const e = newLedger(0)
    admit(e, { kind: 'prompt' }, ids(null), { now: 1000 })
    admit(e, { kind: 'stop', lastMessage: null }, ids(null), { hiveContinued: true, now: 1100 })
    expect(unheardStop(e, [900, 1101])).toBe(false)
    expect(unheardStop(e, [900, 1101, 1500])).toBe(true)
    // A CLI whose records name turns isn't read this way.
    const f = newLedger(0)
    admit(f, { kind: 'prompt' }, ids('t1'), { now: 1000 })
    expect(unheardStop(f, [1500])).toBe(false)
  })
})

describe('the real CLIs’ hooks through the ledger (#645 spike recordings)', () => {
  it('Claude Code 2.1.296: three turns, Stops carried on by blocks and context, end finished each time', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const hooks = fixture('turns-claude-2.1.296.json')
    const a = agent()
    // In the recording a hook blocked every Stop but the last of each turn; Combwork would have answered them so.
    const last = (i: number) => hooks.slice(i + 1).find((b) => b.hook_event_name === 'Stop' || b.hook_event_name === 'UserPromptSubmit')?.hook_event_name !== 'Stop'
    const statuses: string[] = []
    hooks.forEach((body, i) => {
      const h = claudeCode.normalizeHook(body)
      feed(a, h.event, h.ids, h.event.kind === 'stop' && !last(i))
      statuses.push(`${body.hook_event_name}:${a.status}`)
    })
    expect(statuses.filter((s) => s.startsWith('Stop'))).toEqual(['Stop:working', 'Stop:working', 'Stop:working', 'Stop:finished', 'Stop:working', 'Stop:finished', 'Stop:working', 'Stop:finished'])
    expect(a.stale).toEqual(Array(5).fill('continued'))
    // A late PostToolUse of T1's read, arriving now, is old news.
    const late = claudeCode.normalizeHook(hooks.find((b) => b.hook_event_name === 'PostToolUse')!)
    feed(a, late.event, late.ids)
    expect(a.status).toBe('finished')
  })

  it('Codex 0.162.1: a tool turn carried on once by a block, then a turn with no tool call', async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const hooks = fixture('turns-codex-0.162.1.json')
    const a = agent()
    const firstStop = hooks.findIndex((b) => b.hook_event_name === 'Stop')
    send(codex, a, hooks.slice(0, firstStop + 1), (_b, i) => i === firstStop)
    expect(a.status).toBe('working')
    send(codex, a, hooks.slice(firstStop + 1))
    expect(a.status).toBe('finished')
    expect(a.ledger.active?.id).toBe(hooks.at(-1)!.turn_id)
    const post = codex.normalizeHook(hooks.find((b) => b.hook_event_name === 'PostToolUse')!)
    expect(post.ids).toMatchObject({ turn: hooks[1].turn_id, call: expect.stringMatching(/^exec-/) })
    feed(a, post.event, post.ids)
    expect(a.status).toBe('finished')
  })
})

describe("the CLIs' own records of a turn's end", () => {
  const line = (type: string, payload: Record<string, unknown>, timestamp = '2026-10-12T00:00:00.000Z') => JSON.stringify({ timestamp, type, payload }) + '\n'

  it("Codex: its latest task_complete, by turn id; a task started after it means a turn runs", async () => {
    const { rolloutDetails } = await import('../src/main/providers/codex/rollout')
    const done = line('event_msg', { type: 'task_started', turn_id: 't1' }) + line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'ok' }, '2026-10-12T00:00:05.000Z')
    expect(rolloutDetails(done).turnEnded).toEqual({ turn: 't1', at: '2026-10-12T00:00:05.000Z' })
    expect(rolloutDetails(done + line('event_msg', { type: 'task_started', turn_id: 't2' })).turnEnded).toBeNull()
    expect(rolloutDetails(line('event_msg', { type: 'token_count' })).turnEnded).toBeUndefined()
  })

  it('Copilot: when each of its Stop hooks was answered (agentStop hook.end), whatever follows', async () => {
    const { eventsDetails } = await import('../src/main/providers/copilot/events')
    const ev = (type: string, data: Record<string, unknown>, timestamp = '2026-10-12T00:00:00.000Z') => JSON.stringify({ type, data, timestamp }) + '\n'
    const ended = ev('user.message', { content: 'go' }) + ev('assistant.turn_start', { turnId: '0' }) + ev('assistant.turn_end', { turnId: '0' }) + ev('hook.start', { hookType: 'agentStop' }) + ev('hook.end', { hookType: 'agentStop' }, '2026-10-12T00:00:09.000Z')
    expect(eventsDetails(ended).stopsAnswered).toEqual(['2026-10-12T00:00:09.000Z'])
    // The next prompt's hook in the same lines (#648 round 1: a tail read with it): the answer is still the earlier one's.
    const next = ended + ev('hook.start', { hookType: 'userPromptSubmitted' }, '2026-10-12T00:00:20.000Z')
    expect(eventsDetails(next).stopsAnswered).toEqual(['2026-10-12T00:00:09.000Z'])
    expect(eventsDetails(ev('user.message', { content: 'go' })).stopsAnswered).toBeUndefined()
    expect(eventsDetails(ended).turnEnded).toBeUndefined()
    // The real 1.0.93 session's events: three Stops answered (tests/fixtures/copilot).
    const real = readFileSync(join(__dirname, 'fixtures', 'copilot', 'session-state', '5cb5a219-ee72-49a3-b871-cc0c05d27269', 'events.jsonl'), 'utf8')
    expect(eventsDetails(real).stopsAnswered).toHaveLength(3)
  })
})

describe("the adapters' turn ids, Stop replies and idle screens", () => {
  const screen = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

  it('read the ids each CLI sends, and nothing that is not an id', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    expect(claudeCode.normalizeHook({ hook_event_name: 'PreToolUse', prompt_id: 'p-1', tool_use_id: 'toolu_1', agent_id: 'a1', tool_input: {} }).ids).toEqual({ turn: 'p-1', call: 'toolu_1', sub: 'a1', continued: false })
    expect(claudeCode.normalizeHook({ hook_event_name: 'Stop', prompt_id: 'p-1', stop_hook_active: true }).ids).toEqual({ turn: 'p-1', call: null, sub: null, continued: true })
    expect(codex.normalizeHook({ hook_event_name: 'PostToolUse', turn_id: 't-1', tool_use_id: 'exec-1', tool_input: {} }).ids).toEqual({ turn: 't-1', call: 'exec-1', sub: null, continued: false })
    expect(copilot.normalizeHook({ hook_event_name: 'Stop' }).ids).toEqual({ turn: null, call: null, sub: null, continued: false })
    expect(claudeCode.normalizeHook({ hook_event_name: 'Stop', prompt_id: 'not an id: user text' }).ids.turn).toBeNull()
  })

  it('know which Stop replies carry the turn on', async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { codex } = await import('../src/main/providers/codex/adapter')
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    for (const ad of [claudeCode, codex, copilot]) {
      expect(ad.stopContinues({}), ad.id).toBe(false)
      expect(ad.stopContinues({ decision: 'block', reason: 'Fetch your inbox' }), ad.id).toBe(true)
    }
    expect(claudeCode.stopContinues({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'You have mail' } })).toBe(true)
    expect(codex.stopContinues({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'You have mail' } })).toBe(false)
  })

  it("Claude Code 2.1.296's screens, recorded alone and in Combwork: idle at its prompt, or working; older versions aren't read", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const turn = claudeCode.turnScreen('2.1.296')!
    const recorded = screen('screen-claude-2.1.296-idle.txt')
    expect(turn(recorded)).toBe('idle')
    // The same screen with the spinner of a turn under way above its input.
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✻ Brewing… (12s · ↓ 1.2k tokens · esc to interrupt)'))).toBe('working')
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✶ Pondering…'))).toBe('working')
    // A spinner line left above in the history (an earlier moment of the turn) isn't its state now.
    expect(turn(recorded.replace(/✻ Worked for 0s · done 2:19/, '✻ Brewing… (esc to interrupt)\n● plain answer\n✻ Worked for 3s · done 2:20'))).toBe('idle')
    // A dialog, or no status line: not sure.
    expect(turn('Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBeNull()
    expect(turn('※ recap: the work is merged\n❯ ')).toBeNull()
    // As Combwork's own terminal renders it (#648's real check: its input marked ">", its spinner with no "esc to interrupt"):
    // a reply held for seconds ("✢ Embellishing…"), and once done.
    expect(turn(screen('screen-claude-2.1.296-hive-working.txt'))).toBe('working')
    expect(turn(screen('screen-claude-2.1.296-hive-idle.txt'))).toBe('idle')
    expect(claudeCode.turnScreen('2.1.291')).toBeNull()
    expect(claudeCode.turnScreen(null)).toBeNull()
  })

  it("Codex 0.162.1's screens, recorded: idle at its prompt, working; a draft or a queued message isn't sure", async () => {
    const { codex } = await import('../src/main/providers/codex/adapter')
    const turn = codex.turnScreen('0.162.1')!
    const recorded = screen('screen-codex-0.162.1-idle.txt')
    expect(turn(recorded)).toBe('idle')
    // Recorded while a command ran (#645's live rerun): its Working line, a draft in its input, a message it would queue.
    expect(turn(screen('screen-codex-0.162.1-working.txt'))).toBe('working')
    expect(turn(recorded.replace('› Ask Codex to do anything', '› fix the tests'))).toBeNull()
    expect(turn(`${recorded}\ntab to queue message`)).toBeNull()
    expect(codex.turnScreen('0.160.0')).toBeNull()
  })
})
