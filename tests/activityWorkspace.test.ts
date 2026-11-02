// Activity's workspace level (HI-1664), main's side: what runs now read for many session hosts in one call (each once,
// only the calling window's workspace's, the Assistant's home among them), and the agents working on a card now, found by
// the cards' index (HI-1236) for the session each runs now. Two projects with the same agent id and session ids kept
// apart; a workspace card (no project) on the records of running sessions in either project.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import type { LiveSessionState } from '../src/shared/types'
import { tempDir } from './tempDir'

vi.mock('../src/main/agentProcesses', async (orig) => ({ ...(await orig<object>()), projectLaunches: async (p: string) => [{ agentId: 'b1', runId: `run:${p.toLowerCase()}`, cli: [], processes: [], more: 0 }] }))

const base = tempDir('hive-activity-workspace-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { sessions } = await import('../src/main/sessions')
const { activityCardAgents, activityNowAll } = await import('../src/main/activityWorkspace')

const user = { kind: 'user' } as const
const wsPath = join(base, 'ws')
const otherWs = join(base, 'other')
const project = (ws: string, name: string): string => {
  const p = join(ws, name)
  mkdirSync(join(p, '.hive'), { recursive: true })
  // The same agent id in both projects.
  writeFileSync(join(p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'Builder' }, { id: 'r1', name: 'Reviewer' }] }))
  return p
}
const alpha = project(wsPath, 'alpha')
const beta = project(wsPath, 'beta')
const elsewhere = project(otherWs, 'gamma')
const w = createWorkspaceService()
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const sid = (n: number): string => `0f5c2a8e-1111-4222-8333-9444555500${String(n).padStart(2, '0')}`
const state = (projectPath: string, agentId: string, sessionId: string): LiveSessionState => ({ projectPath, agentId, sessionId, status: 'working' }) as LiveSessionState
let live: LiveSessionState[] = []
const record = (p: string, id: string, agentId: string) => w.mutateSessions(p, (f) => void f.sessions.push({ id, agent: 'claude-code', name: id, createdAt: '', lastActiveAt: '', archived: false, agentId }))

beforeAll(async () => {
  await w.open(wsPath)
  vi.spyOn(sessions, 'liveStates').mockImplementation(() => live)
  vi.spyOn(sessions, 'backgroundTasks').mockImplementation((p: string) => [{ agentId: 'b1', sessionId: sid(1), id: `t:${p.toLowerCase()}`, at: 1 }])
  // The same session id in both projects (as two hosts' records may have).
  for (const p of [alpha, beta]) await record(p, sid(1), 'b1')
  await record(alpha, sid(2), 'b1')
})
afterAll(async () => {
  vi.restoreAllMocks()
  await disposeWorkspaceService(w)
})

describe('what runs now in many session hosts (activity:nowAll)', () => {
  it('reads each host once, however spelt, in one call: its launches and background tasks', async () => {
    const rows = await run(() => activityNowAll([alpha, alpha.toUpperCase(), beta, 42]))
    expect(rows.map((r) => r.path.toLowerCase())).toEqual([alpha.toLowerCase(), beta.toLowerCase()])
    expect(rows[1].now).toEqual({ launches: [{ agentId: 'b1', runId: `run:${beta.toLowerCase()}`, cli: [], processes: [], more: 0 }], tasks: [{ agentId: 'b1', sessionId: sid(1), id: `t:${beta.toLowerCase()}`, at: 1 }], blocks: [] })
  })

  it("reads the Assistant's home as a host", async () => {
    const rows = await run(() => activityNowAll([w.assistantHome]))
    expect(rows.map((r) => r.path.toLowerCase())).toEqual([w.assistantHome.toLowerCase()])
  })

  it("refuses a folder of another workspace (another window's) and anything but a list: nothing read", async () => {
    const launches = vi.spyOn(sessions, 'backgroundTasks')
    launches.mockClear()
    await expect(run(() => activityNowAll([alpha, elsewhere]))).rejects.toThrow()
    await expect(run(() => activityNowAll('not a list'))).rejects.toThrow()
    expect(launches).not.toHaveBeenCalled()
  })
})

describe("a card's agents now (activity:cardAgents)", () => {
  it("a workspace card's: its agents in two projects, each by the session it runs now, never another workspace's", async () => {
    const card = await run(() => tasks.createTask({ title: 'About the workspace', column: 'doing' }, user))
    // On the records of b1's sessions in both projects (an id both have), as a session's cards are kept.
    for (const p of [alpha, beta]) await w.upsertSession(p, { id: sid(1), cards: [{ number: card.number, title: card.title }] })
    live = [state(alpha, 'b1', sid(1)), state(beta, 'b1', sid(1)), state(elsewhere, 'b1', sid(1))]
    const ofCard = vi.spyOn(w, 'sessionsOfCard')
    const found = await run(() => activityCardAgents(card.number))
    expect(found.map((a) => [a.path.toLowerCase(), a.agentId, a.sessionId])).toEqual([
      [alpha.toLowerCase(), 'b1', sid(1)],
      [beta.toLowerCase(), 'b1', sid(1)]
    ])
    // By the cards' index, once for each host with an agent running here: the other workspace's never asked.
    expect(ofCard.mock.calls.map(([p]) => p.toLowerCase())).toEqual([alpha.toLowerCase(), beta.toLowerCase()])
    ofCard.mockRestore()
  })

  it('an agent gone on to another session (another card) no longer counts, nor a stopped one, nor nobody', async () => {
    const card = await run(() => tasks.createTask({ title: 'Done with it', project: 'alpha', agent: 'b1', column: 'doing' }, user))
    await w.upsertSession(alpha, { id: sid(1), cards: [{ number: card.number, title: card.title }] })
    live = [state(alpha, 'b1', sid(1))]
    expect((await run(() => activityCardAgents(card.number))).map((a) => a.sessionId)).toEqual([sid(1)])
    // Its next session, which never worked on it: not this card's.
    live = [state(alpha, 'b1', sid(2))]
    expect(await run(() => activityCardAgents(card.number))).toEqual([])
    live = [{ ...state(alpha, 'b1', sid(1)), status: 'stopped' } as LiveSessionState]
    expect(await run(() => activityCardAgents(card.number))).toEqual([])
    live = []
    expect(await run(() => activityCardAgents(card.number))).toEqual([])
    expect(await run(() => activityCardAgents('x'))).toEqual([])
  })
})
