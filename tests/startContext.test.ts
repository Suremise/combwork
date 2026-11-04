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

const base = tempDir('hive-start-context-')
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
})
