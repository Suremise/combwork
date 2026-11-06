// cw_prompt_agent with newConversation (#437): an idle agent's conversation ends and a new one starts on the task. The
// Assistant's authority (Settings → Assistant → Control, its own session) is checked again after the stop's await, so a
// request whose permission ended meanwhile starts nothing; and nothing is stopped for a prompt Combwork just typed.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-newconv-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { ChangeRefused } = await import('../src/main/assistantControl')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'lane')
const s = sessions as unknown as { live: Map<string, { typed?: { at: number; prompts: number }; prompts?: number }>; runs: Map<string, string> }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const id = `${p.toLowerCase()}#b1`

/** B1 running and idle (no process). */
function idleAgent() {
  const state = { provider: 'claude-code', runId: 'run-b1', projectPath: p, agentId: 'b1', cwd: p, sessionId: 'old-session', status: 'ready', startedAt: '', launchSignature: '', unseen: false }
  s.live.set(id, { state, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: null, configuredMode: null } as never)
  s.runs.set(state.runId, id)
}

/** The stop ends the conversation after `during` (what happens while it waits), as stopWhereAndWait does. */
function stopping(during: () => void = () => undefined) {
  return vi.spyOn(sessions, 'stopWhereAndWait').mockImplementation(async () => {
    during()
    s.live.delete(id)
  })
}

/** The Assistant's guard (assistantControl.admit's): allowed until revoke() says why not. */
function authority() {
  let refused: InstanceType<typeof ChangeRefused> | null = null
  return {
    guard: vi.fn(() => {
      if (refused) throw refused
    }),
    revoke: (status: number, message: string) => (refused = new ChangeRefused(status, message))
  }
}

describe('a new conversation for an idle agent', () => {
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    s.live.clear()
    s.runs.clear()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })

  it('ends the conversation and starts a new one on the task, the guard going with the launch', async () => {
    idleAgent()
    const stop = stopping()
    const start = vi.spyOn(sessions, 'start').mockResolvedValue({} as never)
    const { guard } = authority()
    await run(() => sessions.newConversation(p, 'b1', 'New lane: #12', guard))
    expect(stop).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(p, { agentId: 'b1', prompt: 'New lane: #12', allowed: guard })
    // Before the stop and after it; start checks it once more just before it spawns.
    expect(guard).toHaveBeenCalledTimes(2)
  })

  it('starts nothing when the user turns Control down while the agent stops', async () => {
    idleAgent()
    const { guard, revoke } = authority()
    stopping(() => revoke(403, 'The user turned Settings → Assistant → Control down before this change was made.'))
    const start = vi.spyOn(sessions, 'start')
    const refused = await run(() => sessions.newConversation(p, 'b1', 'New lane: #12', guard)).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ChangeRefused)
    expect((refused as InstanceType<typeof ChangeRefused>).status).toBe(403)
    expect(start).not.toHaveBeenCalled()
    expect(s.live.has(id)).toBe(false)
  })

  it("starts nothing when the Assistant's session that asked ends while the agent stops", async () => {
    idleAgent()
    const { guard, revoke } = authority()
    stopping(() => revoke(409, "The Assistant's session that asked for this ended before the change was made."))
    const start = vi.spyOn(sessions, 'start')
    const refused = await run(() => sessions.newConversation(p, 'b1', 'New lane: #12', guard)).catch((e: unknown) => e)
    expect((refused as InstanceType<typeof ChangeRefused>).status).toBe(409)
    expect(start).not.toHaveBeenCalled()
  })

  it('stops nothing when the authority has already ended', async () => {
    idleAgent()
    const { guard, revoke } = authority()
    revoke(403, 'Control is Look and advise.')
    const stop = stopping()
    await expect(run(() => sessions.newConversation(p, 'b1', 'New lane: #12', guard))).rejects.toBeInstanceOf(ChangeRefused)
    expect(stop).not.toHaveBeenCalled()
    expect(s.live.has(id)).toBe(true)
  })

  it("stops nothing while a prompt Combwork typed hasn't been taken (it would be lost)", async () => {
    idleAgent()
    s.live.get(id)!.typed = { at: Date.now(), prompts: 0 }
    const stop = stopping()
    await expect(run(() => sessions.newConversation(p, 'b1', 'New lane: #12'))).rejects.toThrow(/has not taken yet/)
    expect(stop).not.toHaveBeenCalled()
  })

  it('refuses an agent that isn’t running', async () => {
    const stop = stopping()
    await expect(run(() => sessions.newConversation(p, 'b1', 'New lane: #12'))).rejects.toThrow(/isn't running/)
    expect(stop).not.toHaveBeenCalled()
  })
})
