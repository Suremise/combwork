// A compaction Claude Code began by itself while its agent was idle (#1115), in SessionManager: Claude Code's hooks as
// it sends them (handleHook), its transcript in a file, no process. It precomputes a compaction in the background, idle
// too, sending PreCompact at once and PostCompact only once it uses it: Hive watches it as its own Compact, so the
// agent shows "Compacting…" until a compaction more in the transcript (or PostCompact, a prompt, the time limit), never
// until its next turn.
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { COMPACTING_MESSAGE } from '../src/shared/defaults'
import { tempDir } from './tempDir'

const base = tempDir('hive-auto-compaction-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { claudeCode } = await import('../src/main/providers/claude/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; status: string; statusMessage?: string }
type Launch = { state: State; compacting?: object; looks?: Set<Promise<void>> }
const s = sessions as unknown as {
  live: Map<string, Launch>
  runs: Map<string, string>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  backup: (projectPath: string, agentId: string, force?: boolean) => Promise<void>
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const line = (o: Record<string, unknown>, at = Date.now()): string => JSON.stringify({ timestamp: new Date(at).toISOString(), ...o }) + '\n'
const prompt = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } })
/** A compaction recorded in the transcript, now or (`at`) earlier. */
const boundary = (at = Date.now()): string => line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 150_000 } }, at)

/** An idle Claude Code agent whose transcript has had one compaction already, a minute ago. */
function agent(agentId: string): { st: State; l: Launch; transcript: string } {
  const transcript = join(base, `${agentId}.jsonl`)
  writeFileSync(transcript, prompt('go') + boundary(Date.now() - 60_000) + prompt('carry on'))
  const st = { provider: 'claude-code', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'ready', startedAt: new Date(Date.now() - 60_000).toISOString(), launchSignature: '', unseen: false }
  const l = { state: st, adapter: claudeCode, transcriptMtime: '', transcriptPath: transcript, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st, l: l as never, transcript }
}
/** A hook as Claude Code sends it, answered as the hook server answers it (sessions.hookReply). */
const hook = (st: State, body: Record<string, unknown>) =>
  run(() => {
    const full = { session_id: st.sessionId, cwd: p, ...body }
    return sessions.handleHook(st.runId, full, sessions.hookReply(st.runId, full))
  })
/** Until nothing any launch began runs: its hooks and what they queued, and its transcript's looks. */
const quiet = async (): Promise<void> => {
  for (;;) {
    const running = [...s.hookQueues.values(), ...[...s.live.values()].flatMap((l) => [...(l.looks ?? [])])]
    if (!running.length) return
    await Promise.allSettled(running)
  }
}
const preCompact = { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null }

describe('a compaction Claude Code began by itself while idle (#1115)', () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork'), { recursive: true })
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    vi.spyOn(providerService, 'refresh').mockResolvedValue([])
    s.notify = () => {}
  })
  afterAll(async () => {
    await quiet()
    s.live.clear()
    await disposeWorkspaceService(w)
  })

  it('with no PostCompact: compacting until a compaction more is in its transcript, then idle again', async () => {
    const { st, l, transcript } = agent('nopost')
    await hook(st, preCompact)
    expect([st.status, st.statusMessage, !!l.compacting]).toEqual(['working', COMPACTING_MESSAGE, true])
    await quiet()
    // The transcript grows with nothing recorded since it began: still compacting.
    appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }))
    await run(() => s.backup(p, st.agentId, true))
    expect([st.status, !!l.compacting]).toEqual(['working', true])
    // A compaction more: over, idle again with nothing left watching.
    appendFileSync(transcript, boundary())
    await run(() => s.backup(p, st.agentId, true))
    expect([st.status, st.statusMessage, l.compacting]).toEqual(['ready', undefined, undefined])
  })

  it('its compaction written while Hive is still reading the transcript ends it: it is no earlier compaction (round 2)', async () => {
    const { st, l, transcript } = agent('slowread')
    // The first look at the transcript after PreCompact is held until the compaction is recorded.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const lookup = vi.spyOn(sessions as unknown as { liveTranscript: () => Promise<string | null> }, 'liveTranscript').mockImplementationOnce(async () => {
      await gate
      return transcript
    })
    await hook(st, preCompact)
    appendFileSync(transcript, boundary())
    const held = run(() => s.backup(p, st.agentId, true))
    release()
    await held
    await run(() => s.backup(p, st.agentId, true))
    lookup.mockRestore()
    expect([st.status, st.statusMessage, l.compacting]).toEqual(['ready', undefined, undefined])
  })

  it('PostCompact, or a prompt starting a turn, ends the watch as it ends Hive’s own', async () => {
    const said = agent('post')
    await hook(said.st, preCompact)
    await hook(said.st, { hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'x' })
    expect([said.st.status, said.st.statusMessage, said.l.compacting]).toEqual(['ready', undefined, undefined])
    const prompted = agent('prompted')
    await hook(prompted.st, preCompact)
    await hook(prompted.st, { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    expect([prompted.st.status, prompted.l.compacting]).toEqual(['working', undefined])
    // The turn's own compaction count later changes nothing.
    appendFileSync(prompted.transcript, boundary())
    await run(() => s.backup(p, prompted.st.agentId, true))
    expect(prompted.st.status).toBe('working')
    await quiet()
  })

  it('mid-turn: the turn goes on, and nothing watches it (its Stop ends the turn)', async () => {
    const { st, l } = agent('midturn')
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await hook(st, preCompact)
    expect([st.status, l.compacting]).toEqual(['working', undefined])
    await quiet()
  })
})
