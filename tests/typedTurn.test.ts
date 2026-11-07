// A turn the user's typing began with no prompt hook (HI-2673), in SessionManager: Claude Code 2.1.319 runs the model on
// a `!` command's output under the command's promptId and sends no UserPromptSubmit (HB1, 6 Nov 22:42:59). The ledger used
// to drop all of that turn's hooks as stale, so the agent stayed "finished" and hooks health said its hooks weren't
// reaching Combwork. While the user's own Enter into the idle pane waits for its hook, a new tool call of a turn never
// seen opens that turn, and any hook of it shows its hooks arrive. An earlier turn's late hook, a sub-agent's, or no hook
// at all still raise the alarm. Hooks as Claude Code sends them (handleHook), the user's typing as the terminal passes
// it (noteUserInput), the check as the transcript's looks run it (checkHooks); no process.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-typedturn-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { claudeCode } = await import('../src/main/providers/claude/adapter')
const { codex } = await import('../src/main/providers/codex/adapter')
const { HOOKS_GRACE_MS, newHooksWatch } = await import('../src/main/hooksHealth')
const { advanced } = await import('../src/main/advanced')
type HooksWatch = ReturnType<typeof newHooksWatch>

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
const STARTED = '2026-11-06T22:39:00.000Z'
type State = { provider: string; runId: string; agentId: string; status: string; hooksMissing?: { after: string } }
type Live = { state: State; hooksWatch: HooksWatch; screenSays: 'idle' | 'working' | null }
const s = sessions as unknown as {
  live: Map<string, Live>
  runs: Map<string, string>
  notify: (...a: unknown[]) => void
  noteUserInput: (key: string, data: string) => void
  checkHooks: (projectPath: string, agentId: string) => Promise<void>
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())
const key = (agentId: string) => `${p.toLowerCase()}#${agentId}`

/** A live agent of this launch, its screen read as `screenSays` says. */
function agent(agentId: string, adapter: unknown = claudeCode, provider = 'claude-code'): { st: State; l: Live } {
  const state = { provider, runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: STARTED, launchSignature: '', unseen: false }
  const l = { state, adapter, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null, hooksWatch: newHooksWatch(Date.parse(STARTED), false, 'id'), screenSays: null as Live['screenSays'], screen: { text: () => 'screen' }, turnScreen: () => l.screenSays }
  s.live.set(key(agentId), l as never)
  s.runs.set(state.runId, key(agentId))
  return { st: state, l: l as unknown as Live }
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: 'x', cwd: p, ...body }))
const prompt = (st: State, turn: string) => hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', prompt_id: turn })
const toolStart = (st: State, turn: string, call: string, extra: Record<string, unknown> = {}) => hook(st, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh release view' }, tool_use_id: call, prompt_id: turn, ...extra })
const toolEnd = (st: State, turn: string, call: string, extra: Record<string, unknown> = {}) => hook(st, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh release view' }, tool_response: {}, tool_use_id: call, prompt_id: turn, ...extra })
const stop = (st: State, turn: string) => hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Done.', prompt_id: turn })
/** A turn its hooks told in full. */
async function fullTurn(st: State, id: string, call: string): Promise<void> {
  await prompt(st, id)
  await toolStart(st, id, call)
  await toolEnd(st, id, call)
  await stop(st, id)
}
/** The user types a `!` command and Enter into its terminal. */
const typeBang = (st: State) => s.noteUserInput(sessions.key(p, st.agentId), '! gh release edit v1.1.0 --draft=false\r')
/**
 * The check as a look at the transcript runs it, once its screen is seen working on that Enter and again once the bound
 * and the grace have passed since (both put back by hand: the check reads the clock).
 */
async function checkPastTheBound(st: State, l: Live): Promise<void> {
  l.screenSays = 'working'
  await run(() => s.checkHooks(p, st.agentId))
  const bound = advanced.number('cw.hooks.missingSeconds') * 1000
  if (l.hooksWatch.submit) l.hooksWatch.submit.at -= bound + HOOKS_GRACE_MS
  if (l.hooksWatch.workAt !== null) l.hooksWatch.workAt -= bound + HOOKS_GRACE_MS
  await run(() => s.checkHooks(p, st.agentId))
}

describe("a turn the user's typing began with no prompt hook (HI-2673)", () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    s.notify = () => undefined
  })
  afterAll(async () => {
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('Enter, no prompt hook, then its tool calls and Stop: working, then finished, and no alarm', async () => {
    const { st, l } = agent('a')
    await fullTurn(st, 'p1', 'c1')
    expect(st.status).toBe('finished')
    typeBang(st)
    await toolStart(st, 'p2', 'c2')
    expect(st.status).toBe('working')
    await toolEnd(st, 'p2', 'c2')
    await checkPastTheBound(st, l)
    expect(st.hooksMissing).toBeUndefined()
    await stop(st, 'p2')
    expect(st.status).toBe('finished')
    expect(st.hooksMissing).toBeUndefined()
  })

  it('a reply with no tool call (only its Stop) opens no turn, but shows its hooks arrive: no alarm', async () => {
    const { st, l } = agent('b')
    await fullTurn(st, 'p1', 'c1')
    typeBang(st)
    await stop(st, 'p2')
    expect(st.status).toBe('finished')
    await checkPastTheBound(st, l)
    expect(st.hooksMissing).toBeUndefined()
  })

  it("a turn taken that way is remembered (HR2's round 1): its Stop or tool end again answers no later prompt", async () => {
    for (const [agentId, again] of [
      ['b2', (st: State) => stop(st, 'p2')],
      ['b3', (st: State) => toolEnd(st, 'p2', 'c2')]
    ] as const) {
      const { st, l } = agent(agentId)
      await fullTurn(st, 'p1', 'c1')
      // p2 by the user's typing, with no prompt hook: only this hook of it comes, and it answers that Enter.
      typeBang(st)
      await again(st)
      expect(l.hooksWatch.submit, agentId).toBeNull()
      // The user's next prompt, p3, whose hooks never come; then p2's hook again (a duplicate, or late).
      typeBang(st)
      await again(st)
      expect(l.hooksWatch.submit, agentId).not.toBeNull()
      await checkPastTheBound(st, l)
      expect(st.hooksMissing?.after, agentId).toBe('prompt')
      // Once raised, the same hook again doesn't take it down.
      await again(st)
      expect(st.hooksMissing?.after, agentId).toBe('prompt')
    }
  })

  it('the alarm already raised (its hooks came after the bound): a hook of the turn never seen takes it down', async () => {
    const { st, l } = agent('c')
    await fullTurn(st, 'p1', 'c1')
    typeBang(st)
    await checkPastTheBound(st, l)
    expect(st.hooksMissing?.after).toBe('prompt')
    await toolStart(st, 'p2', 'c2')
    expect(st.hooksMissing).toBeUndefined()
    expect(st.status).toBe('working')
  })

  it("still raised: no hook at all after the Enter, an earlier turn's late hook, or a sub-agent's", async () => {
    const none = agent('d')
    await fullTurn(none.st, 'p1', 'c1')
    typeBang(none.st)
    await checkPastTheBound(none.st, none.l)
    expect(none.st.hooksMissing?.after).toBe('prompt')

    const late = agent('e')
    await fullTurn(late.st, 'p1', 'c1')
    await fullTurn(late.st, 'p2', 'c2')
    typeBang(late.st)
    await toolEnd(late.st, 'p1', 'c1')
    await stop(late.st, 'p1')
    await checkPastTheBound(late.st, late.l)
    expect(late.st.hooksMissing?.after).toBe('prompt')

    const sub = agent('f')
    await fullTurn(sub.st, 'p1', 'c1')
    typeBang(sub.st)
    await toolStart(sub.st, 'p2', 'c2', { agent_id: 'agent-1' })
    expect(sub.st.status).toBe('finished')
    await checkPastTheBound(sub.st, sub.l)
    expect(sub.st.hooksMissing?.after).toBe('prompt')
  })

  it('an Enter that started nothing (a local command, its screen idle again): a later hook of a turn never seen opens nothing', async () => {
    const { st, l } = agent('g')
    await fullTurn(st, 'p1', 'c1')
    typeBang(st)
    l.screenSays = 'idle'
    await run(() => s.checkHooks(p, st.agentId))
    l.hooksWatch.submit!.at -= HOOKS_GRACE_MS
    await run(() => s.checkHooks(p, st.agentId))
    expect(l.hooksWatch.submit).toBeNull()
    await toolStart(st, 'p2', 'c2')
    expect(st.status).toBe('finished')
  })

  it("a CLI whose capabilities don't say so (Codex): the user's Enter opens nothing", async () => {
    const { st } = agent('h', codex, 'codex')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 't1' })
    await hook(st, { hook_event_name: 'Stop', last_assistant_message: 'Done.', turn_id: 't1' })
    s.noteUserInput(sessions.key(p, st.agentId), 'hello\r')
    await hook(st, { hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: {}, tool_use_id: 'c2', turn_id: 't2' })
    expect(st.status).toBe('finished')
  })
})
