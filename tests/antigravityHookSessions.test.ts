// The Antigravity CLI's hooks through sessions (HI-2545, design s56): each hook prepared once in the launch's order, then
// normalized, admitted to the turn ledger and given its notice (noticeIn), with agy 1.5.0's recorded payloads and
// transcripts. One turn per invocation zero however often it comes (its step read late included); a checkpoint once per
// place, in its own running turn only (never an earlier turn's, an earlier conversation's or a subagent's); the user's /new
// followed; a subagent's edit of a file another agent holds refused; every reply that waits settled; a tool not refused
// allowed (1.5.0 denies on no answer); and a turn whose status line says idle with no hook (a cancelled prompt) interrupted
// after the grace, only if nothing else is heard.
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-agy-hook-sessions-')
process.env.CW_USER_DATA = join(base, 'userdata')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { antigravity } = await import('../src/main/providers/antigravity/adapter')
const { profilesRoot } = await import('../src/main/providers/antigravity/home')
const { newLedger } = await import('../src/main/turnLedger')
const { advanced } = await import('../src/main/advanced')
const deliveries = await import('../src/main/deliveries')
const { initInboxNotices } = await import('../src/main/inboxNotices')

const ADV = join(__dirname, 'fixtures', 'advanced')
const T = join(__dirname, 'fixtures', 'antigravity')
type Row = { event: string; payload: Record<string, any> }
const RUN: Row[] = readFileSync(join(ADV, 'hooks-run-antigravity-1.5.0.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l))
const MAIN = 'db7643ec-6d85-4160-8c57-1dba0c9ab0b7'
const NEW = '7b021c00-2f4b-4025-8c8c-42eaf40d5306'
const PARENT = 'f57ee6fa-3d66-4a22-b458-764656e4d25d'
const CHILD = 'ded852d1-0c96-4f30-bf60-bc1a470ed6c8'
const fixture = (name: string): string => readFileSync(join(T, name), 'utf8').replace(/\r\n/g, '\n')
const recorded = (event: string, pick: (p: Record<string, any>) => boolean = () => true): Record<string, any> => structuredClone(RUN.find((r) => r.event === event && pick(r.payload))!.payload)

describe("agy's hooks through sessions (s56)", () => {
  const wsPath = join(base, 'ws')
  const p = join(wsPath, 'alpha')
  type State = { runId: string; agentId: string; sessionId: string; status: string; projectPath: string }
  type Live = { state: State; ledger: ReturnType<typeof newLedger>; idleGrace?: unknown; hookMemo?: Record<string, unknown> }
  const s = sessions as unknown as { live: Map<string, Live>; runs: Map<string, string>; notify: (...a: unknown[]) => void; setInbox: (...a: unknown[]) => void }
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
  let n = 0

  /** A working Antigravity agent on conversation `conv`, whose profile holds these transcripts. */
  function agent(conv: string, convs: Record<string, string>): { st: State; l: Live } {
    const agentId = `g${++n}`
    for (const [c, text] of Object.entries(convs)) {
      const logs = join(profilesRoot(), agentId, '.gemini', 'antigravity-cli', 'brain', c, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      writeFileSync(join(logs, 'transcript_full.jsonl'), text)
    }
    const st = { provider: 'antigravity', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: conv, status: 'ready', startedAt: new Date().toISOString(), launchSignature: '', unseen: false }
    s.live.set(`${p.toLowerCase()}#${agentId}`, { state: st, adapter: antigravity, transcriptMtime: '', transcriptPath: null, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger() } as never)
    s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
    return { st, l: s.live.get(`${p.toLowerCase()}#${agentId}`)! }
  }
  /** A hook as the hook server handles it (its event from the URL): its reply, then handled in order with that reply. */
  const hook = (st: State, event: string, payload: Record<string, any>) =>
    run(async () => {
      const full = { ...structuredClone(payload), hook_event_name: event }
      const reply = sessions.hookReply(st.runId, full)
      await sessions.handleHook(st.runId, full, reply)
      return reply
    })
  const zero = (conv: string, at: number) => ({ ...recorded('PreInvocation', (q) => q.invocationNum === 0), conversationId: conv, initialNumSteps: at })
  const later = (conv: string, at: number, k = 1) => ({ ...recorded('PreInvocation', (q) => q.invocationNum === 1), conversationId: conv, initialNumSteps: at, invocationNum: k })
  const stop = (conv: string, execution = 0) => ({ ...recorded('Stop'), conversationId: conv, executionNum: execution })
  const leave = (st: State) => run(() => deliveries.createDelivery(p, { agentId: st.agentId, conversation: st.sessionId, kind: 'rebrief', from: { kind: 'combwork', name: 'Combwork' }, body: 'x' }))
  const ephemeral = (r: Record<string, any> | null): string | undefined => r?.injectSteps?.[0]?.ephemeralMessage
  const turns = (l: Live): string[] => [...l.ledger.seen]

  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, fileLocks: 'ask', agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
    s.setInbox = () => {}
    initInboxNotices()
    await advanced.set('antigravity.hooks.userStepWaitSeconds', 0)
  })
  afterEach(() => deliveries.settledForTests())
  afterAll(async () => {
    await advanced.set('antigravity.hooks.userStepWaitSeconds', null)
    sessions.inboxNotice = null
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('an invocation zero is one turn however often it comes, its step read late included; a repeated prompt typed again is another', async () => {
    const main = fixture('run-tools-continue-1.5.0.jsonl')
    // Its step not on disk yet: a turn the CLI began (cli), then, delivered again once the step is there, the same turn.
    const { st, l } = agent(MAIN, { [MAIN]: '' })
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    expect([st.status, turns(l)]).toEqual(['working', [`${MAIN}:i1`]])
    writeFileSync(join(profilesRoot(), st.agentId, '.gemini', 'antigravity-cli', 'brain', MAIN, '.system_generated', 'logs', 'transcript_full.jsonl'), main)
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    expect(turns(l)).toEqual([`${MAIN}:i1`])
    // Over, then the same hook late: never reopened.
    await hook(st, 'Stop', stop(MAIN))
    expect(st.status).toBe('finished')
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    expect([st.status, turns(l)]).toEqual(['finished', [`${MAIN}:i1`]])
    // The next prompt (step 6, the same words or not): its own turn.
    await hook(st, 'PreInvocation', zero(MAIN, 7))
    expect([st.status, turns(l)]).toEqual(['working', [`${MAIN}:i1`, `${MAIN}:i7`]])
  })

  it("a checkpoint between a turn's model calls, once per place; none for an earlier turn's late call, nor at a turn's start", async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    const m = await leave(st)
    // Its start (invocation zero) carries none.
    expect(await hook(st, 'PreInvocation', zero(MAIN, 1))).toBeNull()
    expect(ephemeral(await hook(st, 'PreInvocation', later(MAIN, 3)))).toContain(m.id)
    // The same place again (a repeated delivery): no second one.
    expect(await hook(st, 'PreInvocation', later(MAIN, 3))).toBeNull()
    await hook(st, 'Stop', stop(MAIN))
    // Turn B runs; turn A's late model call (position 5, before B's start at 7) is A's: no notice, B untouched.
    await hook(st, 'PreInvocation', zero(MAIN, 7))
    const m2 = await leave(st)
    expect(await hook(st, 'PreInvocation', later(MAIN, 5, 2))).toBeNull()
    expect(st.status).toBe('working')
    // B's own call gets it.
    expect(ephemeral(await hook(st, 'PreInvocation', later(MAIN, 9)))).toContain(m2.id)
  })

  it('a drain at the Stop of a running turn, never after a continuation (executionNum > 0)', async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    await leave(st)
    const drain = (await hook(st, 'Stop', stop(MAIN))) as Record<string, any> | null
    expect(drain?.decision).toBe('continue')
    expect(st.status).toBe('working')
    expect(await hook(st, 'Stop', stop(MAIN, 1))).toBeNull()
    expect(st.status).toBe('finished')
  })

  it("a drain decided after agy stopped waiting for the Stop's reply (its hook's timeout) isn't given: the turn just ends", async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    await leave(st)
    const late = vi.spyOn(antigravity, 'noticeDeadlineMs').mockReturnValue(0)
    try {
      expect(await hook(st, 'Stop', stop(MAIN))).toBeNull()
      expect(st.status).toBe('finished')
    } finally {
      late.mockRestore()
    }
  })

  it("a notice not given (past the hook's timeout, or the launch made Independent while it was drafted) isn't counted as told: a later checkpoint tells it (HR1's round 1)", async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    const m = await leave(st)
    const late = vi.spyOn(antigravity, 'noticeDeadlineMs').mockReturnValue(0)
    try {
      expect(await hook(st, 'PreInvocation', later(MAIN, 3))).toBeNull()
    } finally {
      late.mockRestore()
    }
    expect(ephemeral(await hook(st, 'PreInvocation', later(MAIN, 5, 2)))).toContain(m.id)
    // Made Independent while the notice is drafted: none given, and none counted.
    const m2 = await leave(st)
    const real = sessions.inboxNotice!
    const out = { why: null as 'independent' | 'plain' | null }
    const keepsOut = vi.spyOn(sessions, 'keepsOut').mockImplementation(() => out.why)
    try {
      sessions.inboxNotice = async (state, at) => {
        const d = await real(state, at)
        out.why = 'independent'
        return d
      }
      expect(await hook(st, 'PreInvocation', later(MAIN, 7, 3))).toBeNull()
      sessions.inboxNotice = real
      out.why = null
      expect(ephemeral(await hook(st, 'PreInvocation', later(MAIN, 9, 4)))).toContain(m2.id)
    } finally {
      sessions.inboxNotice = real
      keepsOut.mockRestore()
    }
  })

  it("a status report queued behind a new turn's start is about the turn it arrived in: it never asks, idles or ends the new one, whose locks stay (HR1's round 1)", async () => {
    const ordered = sessions as unknown as { inHookOrder: (key: string, fn: () => Promise<void> | void) => Promise<void> }
    const status = (st: State, o: Record<string, unknown>) => run(() => sessions.handleStatusLine(st.runId, { conversation_id: MAIN, session_id: MAIN, model: null, ...o }))
    const drain = (st: State) => run(() => ordered.inHookOrder(st.runId, () => undefined))
    for (const report of [{ agent_state: 'idle' }, { agent_state: 'tool_use', tool_confirmation_pending: true }]) {
      const { st, l } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(st, 'PreInvocation', zero(MAIN, 1))
      // Turn A runs; the launch's queue is held while B's start and the report arrive in that order.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const held = run(() => ordered.inHookOrder(st.runId, () => gate))
      const next = hook(st, 'PreInvocation', zero(MAIN, 7))
      await status(st, report)
      release()
      await held
      await next
      await drain(st)
      expect(l.ledger.active?.id).toBe(`${MAIN}:i7`)
      expect(l.idleGrace, JSON.stringify(report)).toBeUndefined()
      expect(st.status, JSON.stringify(report)).toBe('working')
      // B's own prompt, reported after the rejected one, is put to the person (HR2's round 2: never hidden by it).
      await status(st, { agent_state: 'tool_use', tool_confirmation_pending: true })
      await drain(st)
      expect(st.status, JSON.stringify(report)).toBe('waiting')
      // Answered (its falling edge): working again.
      await status(st, { agent_state: 'working' })
      await drain(st)
      expect(st.status, JSON.stringify(report)).toBe('working')
      // B claims a file: another agent's edit of it is still refused (B's claim stands).
      const edit = recorded('PreToolUse', (q) => q.toolCall.name === 'edit_file')
      edit.toolCall.args.Path = join(p, `held-${l.state.agentId}.txt`)
      expect(await hook(st, 'PreToolUse', { ...edit, stepIdx: 9 })).toEqual({ decision: 'allow' })
      const other = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(other.st, 'PreInvocation', zero(MAIN, 1))
      expect(((await hook(other.st, 'PreToolUse', edit)) as Record<string, unknown> | null)?.decision).toBe('deny')
    }
  })

  it("status reports, however they queue, end as the last valid one says: the prompt showing and the idle grace are derived from it (HR2's round 3, the Assistant's note)", async () => {
    const ordered = sessions as unknown as { inHookOrder: (key: string, fn: () => Promise<void> | void) => Promise<void> }
    const PENDING = { agent_state: 'tool_use', tool_confirmation_pending: true }
    const WORKING = { agent_state: 'working', tool_confirmation_pending: false }
    // Another conversation's report (not the one the launch runs): stale, dropped in order.
    const OTHER = { agent_state: 'working', conversation_id: NEW, session_id: NEW }
    const IDLE = { agent_state: 'idle' }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // [the reports, the status they end in, whether a grace stands then]
    const cases: [Record<string, unknown>[], string, boolean][] = [
      [[PENDING, WORKING], 'working', false],
      [[WORKING, PENDING], 'waiting', false],
      [[PENDING, PENDING], 'waiting', false],
      [[PENDING, OTHER], 'waiting', false],
      [[PENDING, OTHER, WORKING], 'working', false],
      [[WORKING, OTHER, PENDING, WORKING, PENDING], 'waiting', false],
      [[PENDING, IDLE], 'working', true],
      [[IDLE, PENDING], 'waiting', false],
      [[IDLE, OTHER], 'working', true],
      [[IDLE, WORKING, IDLE], 'working', true],
      [[IDLE, IDLE, WORKING], 'working', false]
    ]
    try {
    for (const [reports, want, graced] of cases) {
      const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(st, 'PreInvocation', zero(MAIN, 1))
      // Held: every report arrives before any is applied.
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const held = run(() => ordered.inHookOrder(st.runId, () => gate))
      for (const r of reports) await run(() => sessions.handleStatusLine(st.runId, { conversation_id: MAIN, session_id: MAIN, model: null, ...r }))
      release()
      await held
      await run(() => ordered.inHookOrder(st.runId, () => undefined))
      expect(st.status, JSON.stringify(reports)).toBe(want)
      expect(!!(s.live.get(`${p.toLowerCase()}#${st.agentId}`) as Live).idleGrace, JSON.stringify(reports)).toBe(graced)
      // The same, applied one at a time as they come: the same end.
      const { st: one } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(one, 'PreInvocation', zero(MAIN, 1))
      for (const r of reports) {
        await run(() => sessions.handleStatusLine(one.runId, { conversation_id: MAIN, session_id: MAIN, model: null, ...r }))
        await run(() => ordered.inHookOrder(one.runId, () => undefined))
      }
      expect(one.status, JSON.stringify(reports)).toBe(want)
      expect(!!(s.live.get(`${p.toLowerCase()}#${one.agentId}`) as Live).idleGrace, JSON.stringify(reports)).toBe(graced)
    }
    } finally {
      vi.useRealTimers()
    }
  })

  it("idle and working reports, however they queue, leave only the latest idle period's grace: a fresh one gets its full time, the turn and its locks stay (HR2's round 4)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const ordered = sessions as unknown as { inHookOrder: (key: string, fn: () => Promise<void> | void) => Promise<void> }
      const drain = (st: State) => run(() => ordered.inHookOrder(st.runId, () => undefined))
      const report = (st: State, o: Record<string, unknown>) => run(() => sessions.handleStatusLine(st.runId, { conversation_id: MAIN, session_id: MAIN, model: null, ...o }))
      const IDLE = { agent_state: 'idle' }
      const WORKING = { agent_state: 'working' }
      for (const reports of [[IDLE, WORKING], [IDLE, WORKING, IDLE, WORKING], [WORKING, IDLE, WORKING]]) {
        const { st, l } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
        await hook(st, 'PreInvocation', zero(MAIN, 1))
        const edit = recorded('PreToolUse', (q) => q.toolCall.name === 'edit_file')
        edit.toolCall.args.Path = join(p, `grace-${l.state.agentId}.txt`)
        expect(await hook(st, 'PreToolUse', { ...edit, stepIdx: 2 })).toEqual({ decision: 'allow' })
        // Held: all of them arrive before any is applied; the last says working, so no grace stands.
        let release!: () => void
        const gate = new Promise<void>((r) => (release = r))
        const held = run(() => ordered.inHookOrder(st.runId, () => gate))
        for (const r of reports) await report(st, r)
        release()
        await held
        await drain(st)
        expect(l.idleGrace, JSON.stringify(reports)).toBeUndefined()
        // A fresh idle period just before the old one would have ended: it gets its full grace.
        await vi.advanceTimersByTimeAsync(2900)
        await report(st, IDLE)
        await drain(st)
        await vi.advanceTimersByTimeAsync(101)
        await drain(st)
        expect([l.ledger.active?.state, st.status], JSON.stringify(reports)).toEqual(['running', 'working'])
        // Its lock still stands: another agent's edit of the file is refused.
        const other = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
        await hook(other.st, 'PreInvocation', zero(MAIN, 1))
        expect(((await hook(other.st, 'PreToolUse', edit)) as Record<string, unknown> | null)?.decision).toBe('deny')
        // Its own grace, once it has run its full time: interrupted.
        await vi.advanceTimersByTimeAsync(3000)
        await drain(st)
        expect(st.status, JSON.stringify(reports)).toBe('ready')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("the user's /new: its prompt moves the launch to it; the old conversation's late events carry no notice", async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl'), [NEW]: fixture('run-new-1.5.0.jsonl') })
    // The agent as its project has it (the session it moves to is recorded under it).
    const defs = vi.spyOn(sessions as unknown as { agentDef: (...a: unknown[]) => Promise<unknown> }, 'agentDef').mockResolvedValue({ agent: { id: st.agentId, name: 'Gem', provider: 'antigravity' }, count: 1 })
    try {
      await hook(st, 'PreInvocation', zero(MAIN, 1))
      await hook(st, 'Stop', stop(MAIN))
      await hook(st, 'SessionStart', { ...recorded('SessionStart'), conversationId: NEW })
      expect(st.sessionId).toBe(MAIN)
      await hook(st, 'PreInvocation', zero(NEW, 1))
      expect([st.sessionId, st.status]).toEqual([NEW, 'working'])
      await leave(st)
      expect(await hook(st, 'PreInvocation', later(MAIN, 3))).toBeNull()
      expect(st.status).toBe('working')
    } finally {
      defs.mockRestore()
    }
  })

  it("a subagent's hooks: no turn, session or notice; its edit of a file another agent holds is refused, as the agent's own would be", async () => {
    const convs = { [PARENT]: fixture('subagent-parent-1.5.0.jsonl'), [CHILD]: fixture('subagent-child-1.5.0.jsonl') }
    const holder = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    const edit = recorded('PreToolUse', (q) => q.toolCall.name === 'edit_file')
    const file = join(p, 'notes.txt')
    edit.toolCall.args.Path = file
    await hook(holder.st, 'PreInvocation', zero(MAIN, 1))
    expect(await hook(holder.st, 'PreToolUse', edit)).toEqual({ decision: 'allow' })
    const { st, l } = agent(PARENT, convs)
    await hook(st, 'PreInvocation', zero(PARENT, 1))
    await leave(st)
    expect(await hook(st, 'PreInvocation', zero(CHILD, 1))).toBeNull()
    expect(await hook(st, 'PreInvocation', later(CHILD, 3))).toBeNull()
    expect([st.sessionId, turns(l)]).toEqual([PARENT, [`${PARENT}:i1`]])
    const refused = (await hook(st, 'PreToolUse', { ...edit, conversationId: CHILD })) as Record<string, any> | null
    expect(refused?.decision).toBe('deny')
    expect(String(refused?.reason)).toMatch(/notes\.txt/)
    // A read edits nothing: allowed (no answer would deny it).
    expect(await hook(st, 'PreToolUse', { ...recorded('PreToolUse', (q) => q.toolCall.name === 'read_file'), conversationId: CHILD })).toEqual({ decision: 'allow' })
  })

  it('a reply that waits is always settled: a preparation that fails, a launch gone, an event left out', async () => {
    const { st } = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
    const failing = vi.spyOn(antigravity, 'prepareHook').mockRejectedValueOnce(new Error('unreadable'))
    try {
      expect(await hook(st, 'PreInvocation', zero(MAIN, 1))).toBeNull()
    } finally {
      failing.mockRestore()
    }
    // Not prepared: no turn was taken, so it is a turn when it comes again.
    await hook(st, 'PreInvocation', zero(MAIN, 1))
    expect(st.status).toBe('working')
    expect(await hook(st, 'PostInvocation', recorded('PostInvocation'))).toBeNull()
    expect(await hook(st, 'Stop', { ...stop(MAIN), conversationId: 'not-a-conversation' })).toBeNull()
  })

  it("its status line idle with no hook (a cancelled prompt): the turn is interrupted after the grace, unless anything else is heard", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const status = (st: State, o: Record<string, unknown>) => run(() => sessions.handleStatusLine(st.runId, { conversation_id: st.sessionId, session_id: st.sessionId, model: null, ...o }))
      const settle = () => run(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve()
      })
      const grace = 3000
      // Idle, nothing else: interrupted once, its claims gone.
      const a = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(a.st, 'PreInvocation', zero(MAIN, 1))
      await status(a.st, { agent_state: 'tool_use', tool_confirmation_pending: true })
      await settle()
      expect(a.st.status).toBe('waiting')
      await status(a.st, { agent_state: 'idle' })
      await settle()
      await vi.advanceTimersByTimeAsync(grace + 10)
      await settle()
      expect(a.st.status).toBe('ready')
      expect(a.l.idleGrace).toBeUndefined()
      // Idle, then working again before the grace ends: nothing.
      const b = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(b.st, 'PreInvocation', zero(MAIN, 1))
      await status(b.st, { agent_state: 'idle' })
      await settle()
      await status(b.st, { agent_state: 'working' })
      await vi.advanceTimersByTimeAsync(grace + 10)
      await settle()
      expect(b.st.status).toBe('working')
      // Idle, then a hook of the launch (its Stop, its next call): no interrupt, the turn as the hooks say.
      const c = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await hook(c.st, 'PreInvocation', zero(MAIN, 1))
      await status(c.st, { agent_state: 'idle' })
      await settle()
      await hook(c.st, 'PreInvocation', later(MAIN, 3))
      expect(c.l.idleGrace).toBeUndefined()
      await vi.advanceTimersByTimeAsync(grace + 10)
      expect(c.st.status).toBe('working')
      // Idle with no turn running: no grace at all.
      const d = agent(MAIN, { [MAIN]: fixture('run-tools-continue-1.5.0.jsonl') })
      await status(d.st, { agent_state: 'idle' })
      await settle()
      expect(d.l.idleGrace).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
