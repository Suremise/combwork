// HI-2463: a conversation Combwork launched before what agents see was renamed (its record has no `names`) remembers the
// old names, so a resume of it starts a new conversation instead, as Start Fresh does: the old record stays, the watch
// stays (the agent's own work carries on), what waited for the old conversation is for the new one, and the user gets one
// notice counting the conversations that did start fresh. A conversation launched since (`names: 2`), and one Combwork
// adopted but never launched (no agent, no folder), resume as before. A real workspace and its session records; the
// launch itself (startReserved), the delivery service and the notice are stand-ins.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const told = vi.hoisted(() => ({ toasts: [] as { title: string; body: string }[] }))
vi.mock('../src/main/events', async (orig) => ({
  ...(await orig<object>()),
  toast: (_kind: string, title: string, body: string) => void told.toasts.push({ title, body })
}))

const base = tempDir('renamedfresh-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const ws = createWorkspaceService()
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)

/** What each launch was given, the conversations carried, and the old watches ended. */
const seen = { launches: [] as { agentId: string; resumeId?: string; prompt?: string; keepWatch?: boolean }[], carried: [] as string[], ended: [] as string[] }
// oxlint-disable-next-line typescript/no-explicit-any -- the manager's private launch, replaced for the test
const internals = sessions as any

beforeAll(async () => {
  mkdirSync(join(project, '.hive'), { recursive: true })
  writeFileSync(join(project, '.hive', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: 'p1', agents: ['b1', 'b2', 'b3', 'b4'].map((id) => ({ id, name: id.toUpperCase(), provider: 'claude-code' })) }))
  await ws.open(wsPath)
  await ws.refresh()
  const rec = (id: string, agentId: string | undefined, o: Record<string, unknown> = {}) => run(() => ws.upsertSession(project, { id, agent: 'claude-code', ...(agentId ? { agentId, cwd: project } : {}), name: id, lastActiveAt: '2026-11-01T00:00:00.000Z', ...o }))
  // Before the rename: launched by Combwork (an agent and a folder), no `names`.
  await rec('00000000-0000-4000-8000-000000000001', 'b1')
  await rec('00000000-0000-4000-8000-000000000002', 'b2')
  // Since: launched with the current names.
  await rec('00000000-0000-4000-8000-000000000003', 'b3', { names: 2 })
  // Adopted, never launched by Combwork: neither an agent nor a folder.
  await rec('00000000-0000-4000-8000-000000000004', undefined)
  internals.startReserved = async (projectPath: string, agentId: string, _id: string, opts: { resumeId?: string; prompt?: string; keepWatch?: boolean }) => {
    seen.launches.push({ agentId, resumeId: opts.resumeId, prompt: opts.prompt, keepWatch: opts.keepWatch })
    return { projectPath, agentId, runId: `run-${agentId}`, status: 'starting' }
  }
  internals.deliveries = { give: async () => undefined, now: async () => undefined, launch: async () => undefined, cancel: async () => 0, carry: async (_h: string, _a: string, from: string) => (seen.carried.push(from), 1) }
  internals.conversationEnds = async (_p: string, agentId: string) => void seen.ended.push(agentId)
})

afterAll(async () => {
  await disposeWorkspaceService(ws)
})

describe('a conversation from before the rename (HI-2463)', () => {
  it('starts fresh with its prompt, keeps the watch, carries what waited; one current or adopted resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await run(() => sessions.start(project, { agentId: 'b1', resumeId: '00000000-0000-4000-8000-000000000001', prompt: 'Carry on with HI-7.' }))
      await run(() => sessions.start(project, { agentId: 'b2', resumeId: '00000000-0000-4000-8000-000000000002' }))
      await run(() => sessions.start(project, { agentId: 'b3', resumeId: '00000000-0000-4000-8000-000000000003' }))
      await run(() => sessions.start(project, { agentId: 'b4', resumeId: '00000000-0000-4000-8000-000000000004' }))
      expect(seen.launches).toEqual([
        { agentId: 'b1', resumeId: undefined, prompt: 'Carry on with HI-7.', keepWatch: true },
        { agentId: 'b2', resumeId: undefined, prompt: undefined, keepWatch: true },
        { agentId: 'b3', resumeId: '00000000-0000-4000-8000-000000000003', prompt: undefined, keepWatch: undefined },
        { agentId: 'b4', resumeId: '00000000-0000-4000-8000-000000000004', prompt: undefined, keepWatch: undefined }
      ])
      expect(seen.carried).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])
      // Its watch was its own work's: never ended, as no resume's is.
      expect(seen.ended).toEqual([])
      // The old records stay, to read in Sessions.
      const kept = await run(() => ws.sessionRecord(project, '00000000-0000-4000-8000-000000000001'))
      expect(kept?.agentId).toBe('b1')
      // One notice once starts are quiet, counting the two that started fresh.
      expect(told.toasts).toEqual([])
      await vi.runAllTimersAsync()
      expect(told.toasts).toHaveLength(1)
      expect(told.toasts[0].body).toMatch(/^2 conversations started fresh/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a start that fails isn't counted in the notice", async () => {
    told.toasts.length = 0
    await run(() => ws.upsertSession(project, { id: '00000000-0000-4000-8000-000000000005', agent: 'claude-code', agentId: 'b1', cwd: project, name: 'x', lastActiveAt: '2026-11-01T00:00:00.000Z' }))
    const launch = internals.startReserved
    internals.startReserved = async () => {
      throw new Error('the CLI is missing (test)')
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await expect(run(() => sessions.start(project, { agentId: 'b1', resumeId: '00000000-0000-4000-8000-000000000005' }))).rejects.toThrow(/CLI is missing/)
      await vi.runAllTimersAsync()
      expect(told.toasts).toEqual([])
    } finally {
      vi.useRealTimers()
      internals.startReserved = launch
    }
  })
})
