// A lane's cost (#602) kept while what it is made from is unchanged (HI-3294): the board's revision, the usage history's
// writes, the prices and the projects. It was worked out again at every read, about 100 ms of main's time on a large
// board, though the window asks for it on every hover of a lane. Only the lane's agents' sessions are read for it.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-lane-costs-kept-')
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude-home')
process.env.CODEX_HOME = join(base, 'codex-home')
process.env.COPILOT_HOME = join(base, 'copilot-home')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { usageHistory } = await import('../src/main/usageHistory')
const { laneCosts } = await import('../src/main/cardCosts')
const { config } = await import('../src/main/config')
const tasks = await import('../src/main/tasks')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'proj')
const T0 = Date.parse('2026-10-12T10:00:00.000Z')
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()
const B = { id: 'b1', name: 'B1' }
const R = { id: 'r1', name: 'R1' }
const OTHER = { id: 'o1', name: 'O1' }
const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const request = (s: string, i: number, output: number): string => JSON.stringify({ type: 'assistant', sessionId: s, requestId: `r${i}`, timestamp: iso(i), message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } }) + '\n'
const transcript = (s: string, outputs: number[]): string => JSON.stringify({ type: 'user', sessionId: s, timestamp: iso(0), message: { role: 'user', content: 'Task' } }) + '\n' + outputs.map((o, i) => request(s, i + 1, o)).join('')
const file = (n: number): string => join(p, '.combwork', 'sessions', `${sid(n)}.jsonl`)
const user = { kind: 'user' } as const

let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
const timelines = vi.spyOn(usageHistory, 'timelines')

describe("a lane's cost, kept while nothing it is made from changed (HI-3294)", () => {
  beforeAll(async () => {
    mkdirSync(join(p, '.combwork', 'sessions'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [B, R, OTHER] }))
    // The builder's, the reviewer's, and another agent's session, which the lane's cost never reads.
    writeFileSync(file(1), transcript(sid(1), [100, 200]))
    writeFileSync(file(2), transcript(sid(2), [30]))
    writeFileSync(file(3), transcript(sid(3), [5000]))
    const rec = (n: number, a: { id: string; name: string }) => ({ id: sid(n), agent: 'claude-code', agentId: a.id, agentName: a.name, name: `s${n}`, createdAt: iso(0), lastActiveAt: iso(3) })
    writeFileSync(join(p, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [rec(1, B), rec(2, R), rec(3, OTHER)], deleted: [], deletedUsage: [] }))
    mkdirSync(join(wsPath, '.combwork', 'tasks'), { recursive: true })
    const card = { number: 1, title: 'Card 1', description: '', project: 'proj', agent: null, column: 'doing', order: 1, labels: [], blocked: null, blockedBy: [], links: [], comments: [], history: [], held: [{ agent: B.id, name: B.name, role: 'build', from: iso(0), to: iso(2) }], archived: false, createdAt: iso(0), createdBy: 'You', updatedAt: iso(0) }
    writeFileSync(join(wsPath, '.combwork', 'tasks', '1.json'), JSON.stringify(card))
    const lane = { id: 'lane-1', project: 'proj', name: null, builder: B, reviewer: R, cards: [1], rounds: 10, waitMinutes: 30, state: 'active', startedBy: 'You', startedAt: iso(-1), updatedAt: iso(-1), endedAt: null, mergeCommit: null }
    writeFileSync(join(wsPath, '.combwork', 'lanes.json'), JSON.stringify({ version: 1, lanes: [lane] }))
    usageHistory.start()
    w = createWorkspaceService()
    await w.open(wsPath)
    await run(() => usageHistory.opened(w))
  })
  afterAll(async () => {
    timelines.mockRestore()
    await disposeWorkspaceService(w)
    await usageHistory.stop()
  })

  const read = (): Promise<Awaited<ReturnType<typeof laneCosts>>> => run(() => laneCosts(w, ['lane-1']))
  const output = (costs: Awaited<ReturnType<typeof laneCosts>>): number => costs[0].total.outputTokens

  it("reads only the lane's agents' sessions", async () => {
    timelines.mockClear()
    const costs = await read()
    // The builder's 300 and the reviewer's 30: never the other agent's 5,000.
    expect(output(costs)).toBe(330)
    expect(timelines.mock.calls.map((c) => [...(c[2] ?? [])].sort())).toEqual([['b1', 'r1']])
  })

  it('is kept while nothing changed: the same answer, nothing read again', async () => {
    // Read as a running session is (its parser's state kept), so a read again finds nothing new.
    await usageHistory.ingest(p, sid(1), { priority: 1, keepState: 'running' })
    const first = await read()
    timelines.mockClear()
    expect(await read()).toBe(first)
    // A session read again that found nothing new changes nothing.
    expect((await usageHistory.ingest(p, sid(1), { priority: 1, keepState: 'running' }))?.status).toBe('unchanged')
    expect(await read()).toBe(first)
    expect(timelines).not.toHaveBeenCalled()
  })

  it('is worked out again once the history records more use', async () => {
    const first = await read()
    // The builder's next session.
    writeFileSync(file(4), transcript(sid(4), [70]))
    await run(() => w.upsertSession(p, { id: sid(4), agent: 'claude-code', agentId: B.id, agentName: B.name, name: 's4', createdAt: iso(0), lastActiveAt: iso(1) }))
    expect((await usageHistory.ingest(p, sid(4), { priority: 1, keepState: 'running' }))?.status).toBe('written')
    const again = await read()
    expect(again).not.toBe(first)
    expect(output(again)).toBe(400)
  })

  it('is worked out again after a board change', async () => {
    const first = await read()
    timelines.mockClear()
    await run(() => tasks.updateTask(1, { title: 'Renamed' }, user))
    expect(await read()).not.toBe(first)
    expect(timelines).toHaveBeenCalled()
  })

  it('is worked out again after a change of prices', async () => {
    const first = await read()
    const was = config.settings.providers
    try {
      config.settings.providers = structuredClone(was)
      ;(config.settings.providers as unknown as Record<string, unknown>).probe = { changed: true }
      expect(await read()).not.toBe(first)
    } finally {
      config.settings.providers = was
    }
  })

  it('a different ask is kept apart: every listed lane, then the one', async () => {
    const one = await read()
    const all = await run(() => laneCosts(w))
    expect(all.map((l) => l.id)).toEqual(['lane-1'])
    expect(all).not.toBe(one)
    expect(await read()).toBe(one)
  })
})
