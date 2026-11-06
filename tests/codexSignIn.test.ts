// A Codex turn refused for its sign-in sends no hook (#309): SessionManager reads the refusal from the rollout and marks
// the agent "needs sign-in". A read a newer hook overtakes (the next prompt, after signing in again, arriving while the
// read is in flight) is older than that hook and doesn't undo it (#480). Codex's hooks as it sends them (handleHook),
// its rollout in a file, no process, the provider's check stubbed.
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-codex-signin-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { codex } = await import('../src/main/providers/codex/adapter')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
type State = { runId: string; agentId: string; sessionId: string; status: string; statusMessage?: string | null }
const s = sessions as unknown as {
  live: Map<string, { state: State; looks?: Set<Promise<void>> }>
  runs: Map<string, string>
  signedOut: Map<string, unknown>
  hookQueues: Map<string, Promise<void>>
  notify: (...a: unknown[]) => void
  readDetails: (l: unknown, path: string, size: number) => Promise<void>
}
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T> | T): Promise<T> => inWorkspace(w, async () => fn())

const line = (timestamp: string, payload: Record<string, unknown>): string => JSON.stringify({ timestamp, type: 'event_msg', payload }) + '\n'
// A turn Codex ended on an expired sign-in (its 401, codex_error_info unauthorized).
const REFUSAL =
  line('2026-10-09T10:00:00.000Z', { type: 'task_started', turn_id: 't1' }) +
  line('2026-10-09T10:00:01.000Z', { type: 'task_complete', turn_id: 't1', error: { message: 'unexpected status 401 Unauthorized', codex_error_info: 'unauthorized' } })

/** A working Codex agent, with its rollout so far in a file of its own. */
function agent(agentId: string): { st: State; l: unknown; rollout: string } {
  const rollout = join(base, `${agentId}.jsonl`)
  writeFileSync(rollout, REFUSAL)
  const st = { provider: 'codex', runId: `run-${agentId}`, projectPath: p, agentId, cwd: p, sessionId: `0000000${agentId}-0000-4000-8000-000000000000`, status: 'working', startedAt: '2026-10-09T09:00:00.000Z', launchSignature: '', unseen: false }
  const l = { state: st, adapter: codex, transcriptMtime: '', transcriptPath: rollout, defaultModel: false, modeTail: '', launchMode: null, configuredMode: null }
  s.live.set(`${p.toLowerCase()}#${agentId}`, l as never)
  s.runs.set(st.runId, `${p.toLowerCase()}#${agentId}`)
  return { st, l, rollout }
}
const hook = (st: State, body: Record<string, unknown>) => run(() => sessions.handleHook(st.runId, { session_id: st.sessionId, cwd: p, ...body }))
/** Until what is queued for the launch (its hooks, and a refusal read from its rollout) has run. */
const settled = async (st: State): Promise<void> => {
  for (let q = s.hookQueues.get(st.runId); q; q = s.hookQueues.get(st.runId)) await q
}

describe('a Codex turn refused for its sign-in', () => {
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
    // What its sessions still have under way (a look at the rollout after a turn's end) ends before its folder goes (#1034).
    for (const l of s.live.values()) {
      await settled(l.state)
      for (let looks = [...(l.looks ?? [])]; looks.length; looks = [...(l.looks ?? [])]) await Promise.allSettled(looks)
    }
    s.live.clear()
    s.signedOut.clear()
    await disposeWorkspaceService(w)
  })

  it('needs sign-in', async () => {
    const { st, l, rollout } = agent('a')
    await run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await settled(st)
    expect(st.status).toBe('signin')
  })

  it("doesn't undo the next prompt that arrived while the read was in flight", async () => {
    const { st, l, rollout } = agent('b')
    const reading = run(() => s.readDetails(l, rollout, statSync(rollout).size))
    await hook(st, { hook_event_name: 'UserPromptSubmit', prompt: 'try again' })
    expect(st.status).toBe('working')
    await reading
    await settled(st)
    expect(st.status).toBe('working')
  })
})
