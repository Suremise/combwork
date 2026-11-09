// The start context on each CLI (#1065, after #1032): the reply that puts the Assistant's state view before the model,
// checked against hooks recorded from the real CLIs (tests/fixtures/sessionstart-codex-0.163.0.json,
// tests/fixtures/copilot/sessionstart-1.0.98.json: which reply forms reached the model is written in each), and the
// hook route that gives it: at each SessionStart, and on Copilot, which starts no session after a compaction, with the
// first prompt after one.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { ProviderAdapter } from '../src/main/providers/types'

const base = tempDir('cw-start-context-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { claudeCode: claude } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { copilot } = await import('../src/main/providers/copilot/adapter')
const { newLedger } = await import('../src/main/turnLedger')

interface Recording {
  version: string
  hooks: Record<string, unknown>[]
}
const recording = (file: string): Recording => JSON.parse(readFileSync(join(__dirname, 'fixtures', file), 'utf8'))
const codexHooks = recording('sessionstart-codex-0.163.0.json')
const copilotHooks = recording(join('copilot', 'sessionstart-1.0.98.json'))

describe("each CLI's start context reply (#1065)", () => {
  it('Codex: hookSpecificOutput at each SessionStart, which it sends at the first prompt, on resuming and after a compaction', () => {
    expect(codex.startContextReply('V')).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'V' } })
    expect((codex as ProviderAdapter).startContextAfterCompaction).toBeUndefined()
    const starts = codexHooks.hooks.map((b) => codex.normalizeHook(b).event).filter((e) => e.kind === 'start')
    expect(starts).toEqual([{ kind: 'start', source: 'startup' }, { kind: 'start', source: 'resume' }, { kind: 'start', source: 'compact' }])
  })

  it("Copilot: top-level context (its hookSpecificOutput form doesn't reach the model), with the next prompt after a compaction", () => {
    expect(copilot.startContextReply('V')).toEqual({ additionalContext: 'V' })
    expect(copilot.startContextAfterCompaction).toBe('prompt')
    const events = copilotHooks.hooks.map((b) => copilot.normalizeHook(b).event.kind)
    // Its first prompt's hook comes before SessionStart, and no SessionStart follows its compaction.
    expect(events).toEqual(['prompt', 'start', 'stop', 'compactStart', 'prompt', 'stop', 'end'])
    expect(copilot.normalizeHook(copilotHooks.hooks[1]).event).toEqual({ kind: 'start', source: 'new' })
  })

  it('Claude Code: its SessionStart after a compaction carries it', () => {
    expect((claude as ProviderAdapter).startContextAfterCompaction).toBeUndefined()
  })
})

describe('the start context in the hook replies (#1065)', () => {
  const wsPath = join(base, 'ws')
  const p = join(wsPath, 'alpha')
  type State = { runId: string; agentId: string; sessionId: string; projectPath: string }
  const s = sessions as unknown as { live: Map<string, unknown>; runs: Map<string, string>; notify: (...a: unknown[]) => void; setInbox: (...a: unknown[]) => void }
  let w: ReturnType<typeof createWorkspaceService>
  let n = 0
  const given: (string | null)[] = []

  function agent(adapter: unknown): State {
    const agentId = `a${++n}`
    const st = { provider: 'test', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${n}-0000-4000-8000-000000000000`, status: 'ready', startedAt: new Date().toISOString(), launchSignature: '', unseen: false }
    s.live.set(`${p.toLowerCase()}#${agentId}`, { state: st, adapter, transcriptMtime: '', transcriptPath: null, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger() } as never)
    s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
    return st
  }
  /** Each recorded hook's reply, in order, as this agent's. */
  const replay = (st: State, hooks: Record<string, unknown>[]) =>
    inWorkspace(w, async () => {
      const out: (Record<string, unknown> | null)[] = []
      for (const b of hooks) out.push(await sessions.hookReply(st.runId, { ...b, session_id: st.sessionId, cwd: p }))
      return out
    })

  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
    s.setInbox = () => {}
    sessions.inboxNotice = null
    sessions.startContext = async (_state, source) => {
      given.push(source)
      return `[CW] view (${source})`
    }
  })
  afterAll(async () => {
    sessions.startContext = null
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('HI-2670 (HR1 on s44): made Independent while its view is being made, the session gets none of it', async () => {
    const saved = sessions.startContext
    let release!: () => void
    const made = new Promise<void>((r) => (release = r))
    let asked!: () => void
    const askedP = new Promise<void>((r) => (asked = r))
    const out = { why: null as 'independent' | 'plain' | null }
    const keepsOut = vi.spyOn(sessions, 'keepsOut').mockImplementation(() => out.why)
    sessions.startContext = async () => {
      asked()
      await made
      return '[CW] view (startup)'
    }
    try {
      const st = agent(codex)
      const reply = replay(st, [codexHooks.hooks[0]])
      await askedP
      out.why = 'independent'
      release()
      expect((await reply)[0]).toBeNull()
      // Its own role again: given, as before.
      out.why = null
      expect(((await replay(st, [codexHooks.hooks[0]]))[0]?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext).toBe('[CW] view (startup)')
    } finally {
      keepsOut.mockRestore()
      sessions.startContext = saved
    }
  })

  it('Codex: the view at each SessionStart, and nothing on its other hooks', async () => {
    given.length = 0
    const replies = await replay(agent(codex), codexHooks.hooks)
    const named = codexHooks.hooks.map((b, i) => [b.hook_event_name, replies[i]?.hookSpecificOutput ? (replies[i]!.hookSpecificOutput as { additionalContext: string }).additionalContext : null])
    expect(named).toEqual([
      ['SessionStart', '[CW] view (startup)'],
      ['UserPromptSubmit', null],
      ['PreCompact', null],
      ['PostCompact', null],
      ['SessionStart', '[CW] view (resume)'],
      ['SessionStart', '[CW] view (compact)'],
      ['UserPromptSubmit', null]
    ])
  })

  it('Copilot: the view at SessionStart, then with the first prompt after a compaction, once', async () => {
    given.length = 0
    const st = agent(copilot)
    const replies = await replay(st, copilotHooks.hooks)
    expect(copilotHooks.hooks.map((b, i) => [b.hook_event_name, replies[i]])).toEqual([
      ['UserPromptSubmit', null],
      ['SessionStart', { additionalContext: '[CW] view (new)' }],
      ['Stop', null],
      ['PreCompact', null],
      ['UserPromptSubmit', { additionalContext: '[CW] view (compact)' }],
      ['Stop', null],
      ['SessionEnd', null]
    ])
    // Once: the prompt after that one has nothing.
    const prompt = copilotHooks.hooks[4]
    expect(await replay(st, [prompt])).toEqual([null])
    expect(given).toEqual(['new', 'compact'])
  })

  it("never in a sub-agent's hooks, nor without a view to give", async () => {
    const st = agent(copilot)
    const [pre, prompt] = [copilotHooks.hooks[3], copilotHooks.hooks[4]]
    // Copilot's recorded hooks name no sub-agent: one that did (as Claude Code's do) is marked so here.
    const normalize = copilot.normalizeHook.bind(copilot)
    const fromSub = vi.spyOn(copilot, 'normalizeHook').mockImplementation((body) => {
      const h = normalize(body)
      return body.agent_id ? { ...h, ids: { ...h.ids, sub: 'sub-1' } } : h
    })
    expect(await replay(st, [{ ...pre, agent_id: 'sub-1' }, prompt])).toEqual([null, null])
    fromSub.mockRestore()
    const saved = sessions.startContext
    sessions.startContext = async () => null
    expect(await replay(st, [pre, prompt])).toEqual([null, null])
    sessions.startContext = saved
  })

  describe("into the session itself (HI-2771: a CLI whose hooks take no reply, OpenCode's instruction entries)", () => {
    type Call = { runId: string; sessionId: string; text: string | null; aborted: boolean }
    type Ctx = { chain: Promise<void> }
    const S = sessions as unknown as { live: Map<string, unknown>; sessionContexts: WeakMap<object, Ctx>; constructor: { SESSION_CONTEXT_MS: number } }
    /** Its launch's baseline; with `compactions`, the compactEnd hooks its tracker would make of it (a resync's recovery). */
    const snapshot = (compactions: string[] = []) => ({ hook_event_name: 'OpencodeSnapshot', snapshot: {}, compactions })
    /** A live event whose tracker makes compactEnd hooks (a compaction seen to end). */
    const compactionEnded = (...ids: string[]) => ({ hook_event_name: 'OpencodeEvent', event: { type: 'session.compaction.ended' }, compactions: ids })
    /**
     * A CLI that takes the context into its session, its hooks expanded as OpenCode's tracker expands them (prepareHook:
     * each `compactions` id a compactEnd of that turn). Each delivery recorded and gated: `delivered(n)` once n were made;
     * `hold` makes a delivery wait for its signal.
     */
    function intoSession(opts: { hold?: boolean } = {}) {
      const calls: Call[] = []
      const waiters: { n: number; done: () => void }[] = []
      const adapter = {
        ...copilot,
        prepareHook: async (body: Record<string, any>) => {
          if (Array.isArray(body.compactions)) body.combworkExpanded = body.compactions.map((turn: string) => ({ hook_event_name: 'Expanded', kind: 'compactEnd', turn }))
        },
        normalizeHook: (body: Record<string, any>) => ({ event: { kind: body.kind === 'compactEnd' ? 'compactEnd' : 'other' }, ids: { turn: body.turn ?? null, call: null, sub: null, continued: false } }),
        noticeReply: () => null,
        noticeEvents: undefined,
        startContextReply: undefined,
        startContextTrigger: (body: Record<string, any>) => (body.hook_event_name === 'OpencodeSnapshot' ? { source: 'start' } : null),
        deliverStartContext: async (runId: string, sessionId: string, text: string | null, signal: AbortSignal) => {
          const call = { runId, sessionId, text, aborted: false }
          calls.push(call)
          if (opts.hold) await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }))
          call.aborted = signal.aborted
          for (const waiter of waiters.filter((x) => calls.length >= x.n)) waiter.done()
          return signal.aborted ? 'uncertain' : text === null ? 'removed' : 'put'
        }
      }
      const delivered = (count: number): Promise<void> => (calls.length >= count ? Promise.resolve() : new Promise((done) => waiters.push({ n: count, done })))
      return { adapter, calls, delivered }
    }
    const launchOf = (st: State) => S.live.get(`${p.toLowerCase()}#${st.agentId}`) as object
    /** Its hook as Combwork takes it: its reply, then its handling (where its expanded hooks are). */
    const post = (st: State, body: Record<string, unknown>) =>
      inWorkspace(w, async () => {
        const b = { ...body, session_id: st.sessionId, cwd: p }
        const reply = await sessions.hookReply(st.runId, b)
        await sessions.handleHook(st.runId, b, reply)
        return reply
      })
    /** Every delivery the launch has queued, done (each discarded one included): the queue's own end, never a sleep. */
    const queued = (st: State) => S.sessionContexts.get(launchOf(st))?.chain ?? Promise.resolve()

    it('at its first baseline (the view, before the reply), never at a resync; resumed, as a resume', async () => {
      given.length = 0
      const { adapter, calls } = intoSession()
      const st = agent(adapter)
      expect(await post(st, snapshot())).toBeNull()
      // Delivered before the baseline's reply came back.
      expect(calls.map((c) => c.text)).toEqual(['[CW] view (startup)'])
      await post(st, snapshot())
      await queued(st)
      expect(calls.length).toBe(1)
      expect(calls.every((c) => c.runId === st.runId && c.sessionId === st.sessionId)).toBe(true)
      const resumed = agent(intoSession().adapter)
      ;(launchOf(resumed) as { resumed?: boolean }).resumed = true
      await post(resumed, snapshot())
      expect(given.slice(-1)).toEqual(['resume'])
    })

    it("after a compaction's end, live or recovered by a resync's snapshot, each compaction once; never the start's own history", async () => {
      const { adapter, calls, delivered } = intoSession()
      const st = agent(adapter)
      // The start's own snapshot names an old compaction: closed history its view covers, no refresh of its own.
      await post(st, snapshot(['old']))
      await queued(st)
      expect(calls.map((c) => c.text)).toEqual(['[CW] view (startup)'])
      // A compaction seen to end live: one refresh.
      await post(st, compactionEnded('c1'))
      await delivered(2)
      // The stream lost across the next one's end: the repair snapshot recovers it, once; the same repair again, nothing.
      await post(st, snapshot(['c1', 'c2']))
      await delivered(3)
      await post(st, snapshot(['c1', 'c2']))
      await queued(st)
      expect(calls.map((c) => c.text)).toEqual(['[CW] view (startup)', '[CW] view (compact)', '[CW] view (compact)'])
    })

    it("removes Combwork's entry where no view is due (none made: the journal off, not the Assistant), and with guidance off never makes one", async () => {
      const saved = sessions.startContext
      try {
        sessions.startContext = async () => null
        const off = intoSession()
        await post(agent(off.adapter), snapshot())
        expect(off.calls.map((c) => c.text)).toEqual([null])
        sessions.startContext = saved
        given.length = 0
        const plain = intoSession()
        const st = agent(plain.adapter)
        ;(launchOf(st) as { policy?: unknown }).policy = { guidance: false }
        await post(st, snapshot())
        expect([plain.calls.map((c) => c.text), given]).toEqual([[null], []])
      } finally {
        sessions.startContext = saved
      }
    })

    it('within its budget: a view that takes too long is never sent, a request still out is cut off (uncertain), and the reply comes in time', async () => {
      const saved = sessions.startContext
      const budget = S.constructor.SESSION_CONTEXT_MS
      S.constructor.SESSION_CONTEXT_MS = 200
      try {
        let release!: () => void
        let building!: () => void
        const started = new Promise<void>((r) => (building = r))
        sessions.startContext = () =>
          new Promise((r) => {
            building()
            release = () => r('[CW] late view')
          })
        const slow = intoSession()
        const st = agent(slow.adapter)
        const t0 = Date.now()
        expect(await post(st, snapshot())).toBeNull()
        expect(Date.now() - t0).toBeLessThan(2000)
        await started
        // Its view done only after the deadline: the discarded step ends, having sent nothing.
        release()
        await queued(st)
        expect(slow.calls).toEqual([])
        sessions.startContext = saved
        const hung = intoSession({ hold: true })
        const t1 = Date.now()
        expect(await post(agent(hung.adapter), snapshot())).toBeNull()
        expect(Date.now() - t1).toBeLessThan(2000)
        expect(hung.calls.map((c) => [c.text, c.aborted])).toEqual([['[CW] view (startup)', true]])
      } finally {
        S.constructor.SESSION_CONTEXT_MS = budget
        sessions.startContext = saved
      }
    })

    it('one at a time: a newer refresh supersedes an older one still being made, and a launch no longer running gets none', async () => {
      const saved = sessions.startContext
      try {
        const { adapter, calls, delivered } = intoSession()
        const st = agent(adapter)
        await post(st, snapshot())
        let release!: () => void
        let building!: () => void
        let started = new Promise<void>((r) => (building = r))
        let made = 0
        sessions.startContext = async (_s, source) => {
          if (++made === 1) {
            building()
            await new Promise<void>((r) => (release = r))
          }
          return `[CW] view ${made} (${source})`
        }
        await post(st, compactionEnded('a'))
        await started
        await post(st, compactionEnded('b'))
        release()
        await delivered(2)
        await queued(st)
        // The first refresh, superseded while it was made, sent nothing; the second did.
        expect(calls.map((c) => c.text)).toEqual(['[CW] view (startup)', '[CW] view 2 (compact)'])
        // Replaced by another launch of the agent while its view was made: nothing for the old one.
        made = 0
        started = new Promise<void>((r) => (building = r))
        const chain = queued(st)
        await post(st, compactionEnded('c'))
        await started
        const before = S.sessionContexts.get(launchOf(st))!
        S.live.set(`${p.toLowerCase()}#${st.agentId}`, { ...(launchOf(st) as object) })
        release()
        await chain
        await before.chain
        expect(calls.length).toBe(2)
      } finally {
        sessions.startContext = saved
      }
    })

    it("leaves the other CLIs' reply-based start context as it was", async () => {
      const replies = await replay(agent(codex), [codexHooks.hooks[0]])
      expect((replies[0]?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext).toBe('[CW] view (startup)')
    })
  })
})
