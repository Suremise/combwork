// The turn ledger in SessionManager (#648): Codex's hooks as it sends them (handleHook, with the reply Hive gave), its
// rollout in a file, no process. A late tool end after Stop leaves the agent finished; a Stop Hive carried on isn't an
// end; a Stop that never came is made up for by Codex's own record of the turn's end; silence with no sign of an end
// leaves the state unknown (never idle) until the CLI is heard, its idle prompt shows, or the user marks it idle.
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-turn-ledger-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { codex, codexTurnScreen } = await import('../src/main/providers/codex/adapter')
const { newLedger, openCalls } = await import('../src/main/turnLedger')
const { agentRuntime, runtimeLabel } = await import('../src/shared/runtime')

/** The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. */
const HUNG_MS = 15_000
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; status: string; turn?: { state: string; silentSince?: string } }
type Launch = { state: State; ledger: { heard: number }; looks?: Set<Promise<void>>; screen?: { text: () => string }; turnScreen?: (s: string) => 'idle' | 'working' | null }
const s = sessions as unknown as {
  live: Map<string, Launch>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  readDetails: (l: unknown, path: string, size: number) => Promise<void>
  checkSilence: (projectPath: string, agentId: string) => void
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const event = (payload: Record<string, unknown>): string => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n'

/** A working Codex agent with an empty rollout of its own. */
function agent(agentId: string): { st: State; l: Launch; rollout: string } {
  const rollout = join(base, `${agentId}.jsonl`)
  writeFileSync(rollout, '')
  const st = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
  const l = { state: st, adapter: codex, transcriptMtime: '', transcriptPath: rollout, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, ledger: newLedger() }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st, l: l as never, rollout }
}
/** A hook as Codex sends it, answered as the hook server answers it (sessions.hookReply). */
const hook = (st: State, body: Record<string, unknown>) =>
  run(() => {
    const full = { session_id: st.sessionId, cwd: p, ...body }
    return sessions.handleHook(st.runId, full, sessions.hookReply(st.runId, full))
  })
/** Until what is queued for the launch (its hooks, what its rollout or screen said) has run. */
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}
/** Until nothing any launch began runs: its hooks and what they queued, and its transcript's looks (backups). */
const quiet = async (): Promise<void> => {
  for (;;) {
    const running = [...s.hookQueues.values(), ...[...s.live.values()].flatMap((l) => [...(l.looks ?? [])])]
    if (!running.length) return
    await Promise.allSettled(running)
  }
}
const pre = (turn: string, call: string) => ({ hook_event_name: 'PreToolUse', turn_id: turn, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: call })
const post = (turn: string, call: string) => ({ hook_event_name: 'PostToolUse', turn_id: turn, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: call })

describe('the turn ledger in a session', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.hive'), { recursive: true })
    mkdirSync(join(wsPath, '.hive'), { recursive: true })
    writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
  })
  afterEach(() => {
    sessions.inboxNotice = null
    delete process.env.HIVE_TEST_SILENT_MS
  })
  afterAll(async () => {
    // What the tests' hooks began ends before their folder goes: a transcript backup still running then failed and logged
    // after the file's teardown (#1054: "Closing rpc while onUserConsoleLog was pending", under load).
    await quiet()
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it("stays finished when a tool's end reaches Hive after its turn's Stop (#642)", async () => {
    const { st } = agent('late')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, pre('t1', 'exec-1'))
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done' })
    expect(st.status).toBe('finished')
    await hook(st, post('t1', 'exec-1'))
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it("isn't over at a Stop Hive answered with a continuation, only at the one it answered with nothing", async () => {
    const { st } = agent('cont')
    let drains = 1
    sessions.inboxNotice = (_st, at) => (at === 'drain' && drains-- > 0 ? '[CW] You have mail: call cw_inbox' : null)
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false, last_assistant_message: 'Done' })
    expect(st.status).toBe('working')
    expect(st.turn).toEqual({ state: 'running', id: 't1' })
    await hook(st, pre('t1', 'exec-2'))
    await hook(st, post('t1', 'exec-2'))
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: true, last_assistant_message: 'Read my inbox' })
    expect(st.status).toBe('finished')
  })

  it("ends the turn a Stop never came for from Codex's own record of it (task_complete), and only that turn", async () => {
    const { st, l, rollout } = agent('lost')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    // An older turn's record changes nothing.
    appendFileSync(rollout, event({ type: 'task_complete', turn_id: 't0' }))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect(st.status).toBe('working')
    await hook(st, pre('t1', 'exec-3'))
    await hook(st, post('t1', 'exec-3'))
    // The final reply, then no Stop: Codex records the turn's end.
    appendFileSync(rollout, event({ type: 'task_complete', turn_id: 't1', last_agent_message: 'Watching for the revised document.' }))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it("after silence with no sign of the turn's end, the state is unknown, not idle, until the user marks it idle", async () => {
    const { st, l } = agent('silent')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 5000
    l.turnScreen = codexTurnScreen
    // Its screen visibly at work (a long reply): heard, so not silent.
    l.screen = { text: () => '• Working (40s • esc to interrupt)\n\n› Ask Codex to do anything' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    expect(Date.now() - l.ledger.heard).toBeLessThan(5000)
    // A screen that shows neither (a draft in its input): unknown.
    l.ledger.heard = Date.now() - 5000
    l.screen = { text: () => '• Done.\n\n› half a sentence the user typed' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.status).toBe('working')
    expect(st.turn).toMatchObject({ state: 'unknown', id: 't1', silentSince: expect.any(String) })
    // Any hook says more: the turn runs again, as far as Hive knows.
    await hook(st, { hook_event_name: 'PreToolUse', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'exec-4' })
    await hook(st, post('t1', 'exec-4'))
    expect(st.turn).toEqual({ state: 'running', id: 't1' })
    l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('unknown')
    await run(() => sessions.markIdle(p, st.agentId))
    expect(st.status).toBe('ready')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it('after silence, a CLI idle at its prompt on screen has ended its turn', async () => {
    const { st, l } = agent('screen')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    process.env.HIVE_TEST_SILENT_MS = '1000'
    l.ledger.heard = Date.now() - 5000
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '• Done.\n\n  Worked for 5s • 02:29\n\n› Ask Codex to do anything\n\n  ? for shortcuts' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.status).toBe('finished')
    expect(st.turn).toEqual({ state: 'over', id: 't1' })
  })

  it('a tool end and the Stop both lost: the screen decides (idle: over; working: running); unreadable, unknown only after the longer silence an open call allows', async () => {
    process.env.HIVE_TEST_SILENT_MS = '1000'
    const lost = async (name: string, screen: string | null): Promise<{ st: State; l: Launch }> => {
      const { st, l } = agent(name)
      await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
      await hook(st, pre('t1', 'exec-5'))
      l.turnScreen = codexTurnScreen
      l.screen = screen === null ? undefined : { text: () => screen }
      return { st, l }
    }
    // Idle at its prompt: over, though the call never ended.
    const idle = await lost('lost-idle', '• Done.\n\n› Ask Codex to do anything\n\n  ? for shortcuts')
    idle.l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, idle.st.agentId)
    await settled(idle.st)
    expect([idle.st.status, idle.st.turn?.state]).toEqual(['finished', 'over'])
    // Visibly at work (the tool is still running): heard, running.
    const busy = await lost('lost-busy', '• Working (6m 02s • esc to interrupt)\n\n› Ask Codex to do anything')
    busy.l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, busy.st.agentId)
    await settled(busy.st)
    expect([busy.st.status, busy.st.turn?.state]).toEqual(['working', 'running'])
    // Its screen not read: an open call may be a long test run, so not unknown yet; past the longer silence, unknown.
    const unread = await lost('lost-unread', null)
    unread.l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, unread.st.agentId)
    await settled(unread.st)
    expect([unread.st.status, unread.st.turn?.state]).toEqual(['working', 'running'])
    unread.l.ledger.heard = Date.now() - 13_000
    s.checkSilence(p, unread.st.agentId)
    await settled(unread.st)
    expect([unread.st.status, unread.st.turn?.state]).toEqual(['working', 'unknown'])
  })

  it('keeps its runtime facts where it learns them, and the label is projected from them (mid-turn compaction, a question, a sign-in)', async () => {
    const { st } = agent('facts')
    const rt = () => agentRuntime(st as never)
    expect(rt().lifecycle).toBe('starting')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    expect(rt()).toMatchObject({ lifecycle: 'running', turn: 'running', maintenance: null, attention: null, composer: 'free' })
    // Codex compacts by itself mid-turn: still working, the status word unchanged, but compacting is a fact of its own.
    await hook(st, { hook_event_name: 'PreCompact', turn_id: 't1', trigger: 'auto' })
    expect([st.status, rt().maintenance, runtimeLabel(st as never)]).toEqual(['working', 'compacting', 'Compacting the conversation…'])
    await hook(st, { hook_event_name: 'PostCompact', turn_id: 't1' })
    expect([rt().maintenance, runtimeLabel(st as never)]).toEqual([null, 'Working…'])
    // A question it asks and doesn't stop for (Codex's request_user_input_async; hooks attention at 0.160.0's version).
    const q = { tool_name: 'request_user_input_async', tool_input: { questions: [{ question: 'Which colour?' }] } }
    await hook(st, { hook_event_name: 'PreToolUse', turn_id: 't1', tool_use_id: 'q1', ...q })
    expect(rt().attention).toBe('question')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: '<send_user_message_question_reply>Red' })
    expect(rt().attention).toBe(null)
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1' })
    expect(rt()).toMatchObject({ lifecycle: 'running', turn: 'over', maintenance: null })
    expect(runtimeLabel(st as never)).toBeNull()
  })

  it("holds its composer while Hive types a line, confirms a wake or waits for a line to be taken, and frees it after", async () => {
    const { st } = agent('composer')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1' })
    const composer = () => agentRuntime(st as never).composer
    expect(composer()).toBe('free')
    // Typing a line (sendPrompt): held while it types, and after, until its CLI takes it.
    const sending = run(() => sessions.sendPrompt(p, st.agentId, 'next task'))
    await vi.waitFor(() => expect(composer()).toBe('held'), { timeout: HUNG_MS })
    await sending
    expect(composer()).toBe('held')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't2', prompt: 'next task' })
    expect(composer()).toBe('free')
    // Confirming a wake (watches' hold): held until released.
    const release = sessions.holdForConfirm(p, st.agentId, st.runId)!
    expect(composer()).toBe('held')
    release()
    expect(composer()).toBe('free')
  })

  it("a continuation's tool start that reaches Hive before the CLI has redrawn: the turn goes on from its ids alone", async () => {
    const { st, l } = agent('redraw')
    // The screen still shows the idle frame throughout: it decides nothing here.
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '• Done.\n\n› Ask Codex to do anything' }
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, pre('t1', 'exec-5'))
    await hook(st, post('t1', 'exec-5'))
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: false })
    expect(st.status).toBe('finished')
    // Another Stop hook carries the turn on: its next tool call, one the turn never started, is a start of it.
    await hook(st, pre('t1', 'exec-6'))
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    // A repeat of a call it started before its Stop is no start of it; the continuation's own Stop ends it.
    await hook(st, pre('t1', 'exec-5'))
    await hook(st, post('t1', 'exec-6'))
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1', stop_hook_active: true })
    expect([st.status, st.turn?.state]).toEqual(['finished', 'over'])
  })

  it("a late tool start after the turn's Stop (nothing goes on): working only until a look after the silence finds its screen idle", async () => {
    process.env.HIVE_TEST_SILENT_MS = '1000'
    const { st, l } = agent('latestart')
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '• Done.\n\n› Ask Codex to do anything' }
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, { hook_event_name: 'Stop', turn_id: 't1' })
    await hook(st, pre('t1', 'exec-7'))
    expect(st.status).toBe('working')
    l.ledger.heard = Date.now() - 5000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['finished', 'over'])
  })

  it("Copilot: a turn's Stop answered while its prompt still waits in the queue is this turn's, also after Hive's continuation", async () => {
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const q = sessions as unknown as { inHookOrder: (key: string, fn: () => Promise<void>) => Promise<void> }
    for (const continued of [false, true]) {
      const { st, l, rollout } = agent(continued ? 'queued-cont' : 'queued')
      // Copilot's hooks carry no notice yet (#650): one that would carry the turn on, as its hooks reference says a block does.
      Object.assign(l, { adapter: Object.assign(Object.create(copilot), { noticeReply: (e: string, text: string) => (e === 'Stop' ? { decision: 'block', reason: text } : null) }) })
      const ev = (type: string, data: Record<string, unknown>, at: number) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() }) + '\n'
      if (continued) {
        sessions.inboxNotice = (_st, at) => (at === 'drain' ? '[CW] You have mail: call cw_inbox' : null)
        await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
        await hook(st, { hook_event_name: 'Stop' })
        sessions.inboxNotice = null
      }
      // The launch's queue is held (an earlier hook recording the session); the prompt arrives and waits behind it.
      let release: (() => void) | undefined
      const held = run(() => q.inHookOrder(st.runId, () => new Promise<void>((r) => (release = r))))
      await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: HUNG_MS })
      const prompt = continued ? null : hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'quick one' })
      const arrived = Date.now()
      // The turn is short: its Stop is answered (and that hook lost) when the prompt has arrived but isn't handled yet. With
      // continuations: the answer to Hive's, then the final one's.
      appendFileSync(rollout, continued ? ev('hook.end', { hookType: 'agentStop' }, arrived) + ev('hook.end', { hookType: 'agentStop' }, arrived + 1) : ev('hook.end', { hookType: 'agentStop' }, arrived))
      const reading = run(() => s.readDetails(l, rollout, statSync(rollout).size))
      // Hive handles the prompt only later than that record (a turn taken as begun when handled would call it earlier).
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(arrived + 2), { timeout: HUNG_MS })
      release!()
      await held
      await prompt
      await reading
      await settled(st)
      expect([st.status, st.turn?.state], String(continued)).toEqual(['finished', 'over'])
    }
  })

  it('Mark idle after a tool call and a mid-turn compaction whose ends were lost too: no open call or compaction is left behind', async () => {
    process.env.HIVE_TEST_SILENT_MS = '1000'
    const { st, l } = agent('markcompact')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    await hook(st, pre('t1', 'exec-1'))
    await hook(st, { hook_event_name: 'PreCompact', turn_id: 't1', trigger: 'auto' })
    expect([agentRuntime(st as never).maintenance, openCalls(l.ledger as never)]).toEqual(['compacting', 1])
    // PostToolUse, PostCompact and the Stop never come; the screen isn't read: unknown (past an open call's longer
    // silence), then the user marks it idle.
    l.ledger.heard = Date.now() - 13_000
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect(st.turn?.state).toBe('unknown')
    await run(() => sessions.markIdle(p, st.agentId))
    expect([st.status, agentRuntime(st as never).maintenance, agentRuntime(st as never).attention, runtimeLabel(st as never), openCalls(l.ledger as never)]).toEqual(['ready', null, null, null, 0])
  })

  it("a Claude Code turn its background task's end began: by its prompt hook (2.1.296); with that hook lost, only once its transcript says the task ended", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const claude = (st: State, body: Record<string, unknown>) => hook(st, { transcript_path: undefined, ...body })
    for (const how of ['prompt', 'transcript', 'running'] as const) {
      const { st, l } = agent(`wake-${how}`)
      const launch = l as unknown as { adapter: unknown; tasks?: Map<string, { at: number; expiresAt?: number }>; woke?: boolean }
      launch.adapter = claudeCode
      await claude(st, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'run the tests in the background' })
      // Its turn ends with a task running: background.
      launch.tasks = new Map([['b1', { at: Date.now() }]])
      await claude(st, { hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: false })
      expect(st.status, how).toBe('background')
      if (how === 'prompt') {
        // As Claude Code 2.1.296 wakes (#648's probe): the task's notification is the new turn's prompt.
        await claude(st, { hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>' })
        expect([st.status, st.turn], how).toEqual(['working', { state: 'running', id: 'p2' }])
      }
      if (how === 'transcript') {
        // Its prompt hook lost; its transcript shows the task ended (the CLI wakes) before any other hook of the new turn.
        launch.tasks.clear()
        launch.woke = true
      }
      await claude(st, { hook_event_name: 'PreToolUse', prompt_id: 'p2', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_1' })
      if (how === 'running') {
        // Its prompt hook lost, and nothing says the task ended (it merely runs): no evidence of a wake, so stale.
        expect([st.status, st.turn], how).toEqual(['background', { state: 'over', id: 'p1' }])
        continue
      }
      expect([st.status, st.turn], how).toEqual(['working', { state: 'running', id: 'p2' }])
      expect(launch.woke, how).toBe(false)
      launch.tasks.clear()
      await claude(st, { hook_event_name: 'PostToolUse', prompt_id: 'p2', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_1' })
      await claude(st, { hook_event_name: 'Stop', prompt_id: 'p2', stop_hook_active: false })
      expect([st.status, st.turn], how).toEqual(['finished', { state: 'over', id: 'p2' }])
      // With nothing due to wake it, a hook of a turn Hive saw no prompt for is stale.
      await claude(st, { hook_event_name: 'PreToolUse', prompt_id: 'p3', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'toolu_2' })
      expect([st.status, st.turn], how).toEqual(['finished', { state: 'over', id: 'p2' }])
    }
  })

  it("an idle /compact under its own prompt_id (Claude Code 2.1.296): compacting, then idle; a delayed PreCompact of an earlier turn changes nothing", async () => {
    const { claudeCode } = await import('../src/main/providers/claude/adapter')
    const { st, l } = agent('own-compaction')
    ;(l as unknown as { adapter: unknown }).adapter = claudeCode
    const claude = (body: Record<string, unknown>) => hook(st, { transcript_path: undefined, ...body })
    await claude({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'go' })
    await claude({ hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: false })
    await claude({ hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'manual', custom_instructions: '' })
    expect([st.status, runtimeLabel(st as never)]).toEqual(['working', 'Compacting the conversation…'])
    // Its start again while it runs is no new compaction.
    await claude({ hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'manual', custom_instructions: '' })
    await claude({ hook_event_name: 'SessionStart', prompt_id: 'k1', source: 'compact' })
    await claude({ hook_event_name: 'PostCompact', prompt_id: 'k1', trigger: 'manual' })
    expect([st.status, agentRuntime(st as never).maintenance]).toEqual(['ready', null])
    // HR3's round-4 case: its PreCompact again once it is over kept the agent "Compacting…" for good. Now nothing changes.
    await claude({ hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'auto', custom_instructions: '' })
    expect([st.status, agentRuntime(st as never).maintenance, runtimeLabel(st as never)]).toEqual(['ready', null, null])
    // A new turn, over; then the earlier compaction's or turn's delayed news: nothing changes (HR3's round-3 case).
    await claude({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: 'again' })
    await claude({ hook_event_name: 'Stop', prompt_id: 'p2', stop_hook_active: false })
    for (const late of [{ hook_event_name: 'PreCompact', prompt_id: 'p1', trigger: 'auto' }, { hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'auto' }, { hook_event_name: 'SessionEnd', prompt_id: 'p1', reason: 'other' }]) {
      await claude(late)
      expect([st.status, st.turn, agentRuntime(st as never).maintenance], JSON.stringify(late)).toEqual(['finished', { state: 'over', id: 'p2' }, null])
    }
    // The launch's SessionEnd, under the latest compaction's id with none of it running (as at the probe's stop): stopped.
    const { st: st2, l: l2 } = agent('own-compaction-end')
    ;(l2 as unknown as { adapter: unknown }).adapter = claudeCode
    const claude2 = (body: Record<string, unknown>) => hook(st2, { transcript_path: undefined, ...body })
    await claude2({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'go' })
    await claude2({ hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: false })
    await claude2({ hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'manual', custom_instructions: '' })
    await claude2({ hook_event_name: 'PostCompact', prompt_id: 'k1', trigger: 'manual' })
    await claude2({ hook_event_name: 'PreCompact', prompt_id: 'k1', trigger: 'manual', custom_instructions: '' })
    await claude2({ hook_event_name: 'SessionEnd', prompt_id: 'k1', reason: 'other' })
    expect([st2.status, agentRuntime(st2 as never).maintenance]).toEqual(['stopped', null])
  })

  it('never ends a turn on silence alone: a short silence is left as it is', async () => {
    const { st, l } = agent('short')
    await hook(st, { hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'go' })
    process.env.HIVE_TEST_SILENT_MS = '60000'
    l.ledger.heard = Date.now() - 5000
    l.turnScreen = codexTurnScreen
    l.screen = { text: () => '› Ask Codex to do anything' }
    s.checkSilence(p, st.agentId)
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
  })

  it("a Copilot turn (no turn ids) ends from a Stop answered after it began that Hive never got, not from an earlier turn's", async () => {
    const { copilot } = await import('../src/main/providers/copilot/adapter')
    const { st, l, rollout } = agent('copilot')
    Object.assign(l, { adapter: Object.assign(Object.create(copilot), { noticeReply: (e: string, text: string) => (e === 'Stop' ? { decision: 'block', reason: text } : null) }) })
    const ev = (type: string, data: Record<string, unknown>, at: Date) => JSON.stringify({ type, data, timestamp: at.toISOString() }) + '\n'
    // A Stop answered just before the prompt (an earlier turn's), read in the same tail as the new prompt's hook.
    const before = new Date(Date.now() - 1000)
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(rollout, ev('hook.end', { hookType: 'agentStop' }, before) + ev('hook.start', { hookType: 'userPromptSubmitted' }, new Date()))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    // Hive carries it on once (its Stop answered), then its final Stop never reaches Hive.
    sessions.inboxNotice = (_st, at) => (at === 'drain' ? '[CW] You have mail: call cw_inbox' : null)
    await hook(st, { hook_event_name: 'Stop' })
    sessions.inboxNotice = null
    appendFileSync(rollout, ev('hook.end', { hookType: 'agentStop' }, new Date(Date.now() + 5)))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['working', 'running'])
    appendFileSync(rollout, ev('hook.end', { hookType: 'agentStop' }, new Date(Date.now() + 10)))
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect([st.status, st.turn?.state]).toEqual(['finished', 'over'])
  })
})
