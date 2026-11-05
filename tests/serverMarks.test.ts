// Server-session markers' lifetime (HI-1829, HI-1772): a conversation that ran on a server connection is read without its
// CLI's cost reports, marked by its live run while it runs (each conversation it moves through: /clear, /new), by its
// record (`serverRan`) after. A run's markers go with it (its exit, a launch that failed); one whose record couldn't be
// saved is kept (serverMarks.ts), retried after the host's next record write, dropped with its session, within a strict
// bound: past 32 ids its host fails closed, a closing workspace's hosts with unsaved ids too, and past 16 such hosts every
// read does, until Combwork restarts. Never evicted back to Claude pricing.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-servermarks-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { FAIL_CLOSED_HOSTS_MAX, ServerMarks, UNSAVED_MAX } = await import('../src/main/serverMarks')

describe('the unsaved markers kept (serverMarks.ts)', () => {
  it('kept until saved or deleted; past 32 ids the host fails closed: none evicted to Claude pricing', () => {
    const warned: string[] = []
    const m = new ServerMarks((line) => warned.push(line))
    m.add('C:/ws/alpha', 's1')
    expect(m.ignoresReports('c:/WS/alpha', 's1')).toBe(true)
    expect(m.ignoresReports('C:/ws/alpha', 's2')).toBe(false)
    expect(m.pending('C:/ws/alpha')).toEqual(['s1'])
    m.saved('C:/ws/alpha', 's1')
    expect(m.ignoresReports('C:/ws/alpha', 's1')).toBe(false)
    m.add('C:/ws/alpha', 's2')
    m.deleted('C:/ws/alpha', 's2')
    expect(m.size()).toEqual({ unsaved: 0, failClosedHosts: 0, everywhere: false })
    // Repeated distinct failures: 32 kept, the 33rd fails its host closed, and every one of them still ignores reports.
    for (let i = 0; i < UNSAVED_MAX; i++) m.add('C:/ws/beta', `b${i}`)
    expect(m.size().unsaved).toBe(UNSAVED_MAX)
    m.add('C:/ws/beta', 'b-last')
    expect(m.size()).toEqual({ unsaved: 0, failClosedHosts: 1, everywhere: false })
    for (const id of ['b0', 'b17', 'b31', 'b-last', 'never-seen']) expect(m.ignoresReports('C:/ws/beta', id)).toBe(true)
    expect(m.ignoresReports('C:/ws/alpha', 'other')).toBe(false)
    expect(warned).toHaveLength(1)
  })

  it('a closing workspace fails its hosts with unsaved ids closed, for its reopening; others are untouched', () => {
    const m = new ServerMarks()
    m.add('C:/ws/alpha', 'a1')
    m.add('C:/ws2/gamma', 'g1')
    m.add('C:/ws-other/delta', 'd1')
    m.closing('C:/ws')
    expect(m.ignoresReports('C:/ws/alpha', 'a1')).toBe(true)
    expect(m.ignoresReports('C:/ws/alpha', 'a-new')).toBe(true)
    expect(m.ignoresReports('C:/ws2/gamma', 'g-new')).toBe(false)
    expect(m.ignoresReports('C:/ws-other/delta', 'd1')).toBe(true)
    expect(m.size()).toEqual({ unsaved: 2, failClosedHosts: 1, everywhere: false })
  })

  it('past 16 fail-closed hosts (repeated distinct closed workspaces): one flag for every read, the hosts let go', () => {
    const warned: string[] = []
    const m = new ServerMarks((line) => warned.push(line))
    for (let i = 0; i < FAIL_CLOSED_HOSTS_MAX; i++) {
      m.add(`C:/w${i}/p`, `s${i}`)
      m.closing(`C:/w${i}`)
    }
    expect(m.size()).toEqual({ unsaved: 0, failClosedHosts: FAIL_CLOSED_HOSTS_MAX, everywhere: false })
    m.add('C:/w-last/p', 'x')
    m.closing('C:/w-last')
    expect(m.size()).toEqual({ unsaved: 0, failClosedHosts: 0, everywhere: true })
    for (const host of ['C:/w0/p', 'C:/w15/p', 'C:/w-last/p', 'D:/never/opened']) expect(m.ignoresReports(host, 'any')).toBe(true)
    // Nothing more is kept once every read fails closed.
    m.add('C:/w99/p', 'y')
    expect(m.size()).toEqual({ unsaved: 0, failClosedHosts: 0, everywhere: true })
    expect(warned.at(-1)).toMatch(/^Every session's usage is read without its CLI's cost reports until Combwork restarts/)
  })
})

describe("a run's server markers (sessions.ts)", async () => {
  const { createWorkspaceService, disposeWorkspaceService, WorkspaceService } = await import('../src/main/workspace')
  const { sessions, serverMarksForTests } = await import('../src/main/sessions')
  const { provider: providerAdapter } = await import('../src/main/providers')
  const store = await import('../src/main/boardStore')
  type Live = { state: Record<string, unknown>; adapter: unknown; serverSids?: Set<string>; serverSaved?: Set<string>; serverRecorded?: Set<string> }
  type Manager = {
    live: Map<string, Live>
    serverMarked: (p: string, id: string) => boolean
    serverRunEnding: (l: Live) => { unsaved: string[]; started: Set<string> }
    serverRunEnded: (p: string, ending: { unsaved: string[]; started: Set<string> }) => Promise<void>
    saveServerMarks: (p: string) => Promise<void>
    usageFor: (p: string, path: string, id: string, provider: string, o?: { reportsIgnored?: boolean }) => Promise<{ costUsd: number | null } | null>
  }
  const manager = sessions as unknown as Manager
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  const transcript = join(base, 'server.jsonl')
  let w: ReturnType<typeof createWorkspaceService>
  let k = 0

  beforeAll(async () => {
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    // A server's model with the $9 Claude Code reported for it: read with the report, $9; without it, no price (null).
    const lines = [
      { type: 'user', timestamp: '2026-10-11T09:00:00Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: '2026-10-11T09:00:01Z', requestId: 'r1', message: { model: 'deepseek-flash', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'cost-state', timestamp: '2026-10-11T09:00:02Z', totalCostUSD: 9 }
    ]
    writeFileSync(transcript, lines.map((x) => JSON.stringify(x)).join('\n') + '\n')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    manager.live.clear()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
    store.closeAllBoards()
  })

  /** A live run of agent a1 or a2 on a server connection, its conversation `sid`, as recordSession leaves it. */
  const run = (sid: string, agent = 'a1', o: { saved?: string[]; recorded?: string[] } = {}): Live => {
    const l: Live = { state: { projectPath: alpha, agentId: agent, provider: 'claude-code', sessionId: sid, status: 'idle', runId: `run-${++k}` }, adapter: providerAdapter('claude-code'), serverSids: new Set([sid]), serverSaved: new Set(o.saved ?? []), serverRecorded: new Set(o.recorded ?? [sid]) }
    manager.live.set(`${alpha.toLowerCase()}#${agent}`, l)
    return l
  }
  /** As its process exits: its markers handed over first, then out of live (onExit), then saved or kept. */
  const end = async (l: Live) => {
    const ending = manager.serverRunEnding(l)
    manager.live.delete(`${alpha.toLowerCase()}#${String(l.state.agentId)}`)
    await manager.serverRunEnded(alpha, ending)
  }
  /** As the Sessions tab reads a conversation that isn't running: by its record. */
  const readAfter = async (sid: string) => {
    const rec = await w.sessionRecord(alpha, sid)
    return (await manager.usageFor(alpha, transcript, sid, 'claude-code', { reportsIgnored: !!rec?.serverRan }))?.costUsd
  }
  const record = (sid: string, serverRan = false) => w.upsertSession(alpha, { id: sid, ...(serverRan ? { serverRan: true as const } : {}) })

  it('marked while a run of it is live; after its exit, its record decides (saved before or at the exit)', async () => {
    await record('s-saved', true)
    const l = run('s-saved', 'a1', { saved: ['s-saved'] })
    expect(manager.serverMarked(alpha, 's-saved')).toBe(true)
    expect((await manager.usageFor(alpha, transcript, 's-saved', 'claude-code'))?.costUsd).toBeNull()
    await end(l)
    expect(manager.serverMarked(alpha, 's-saved')).toBe(false)
    expect(await readAfter('s-saved')).toBeNull()
    // A record not yet saved with serverRan (its run's write said otherwise): saved at the exit, then read from it.
    await record('s-late')
    await end(run('s-late'))
    expect((await w.sessionRecord(alpha, 's-late'))?.serverRan).toBe(true)
    expect(manager.serverMarked(alpha, 's-late')).toBe(false)
    expect(await readAfter('s-late')).toBeNull()
  })

  it('/clear or /new (A → B): both go with the run, and both read without the report after', async () => {
    await record('A', true)
    await record('B', true)
    const l = run('A', 'a1', { saved: ['A'] })
    l.serverSids!.add('B')
    l.serverSaved!.add('B')
    l.state.sessionId = 'B'
    expect(manager.serverMarked(alpha, 'A') && manager.serverMarked(alpha, 'B')).toBe(true)
    await end(l)
    expect(manager.serverMarked(alpha, 'A') || manager.serverMarked(alpha, 'B')).toBe(false)
    expect(serverMarksForTests().pending(alpha)).toEqual([])
    expect(await readAfter('A')).toBeNull()
    expect(await readAfter('B')).toBeNull()
  })

  it("a launch that failed before its CLI started the conversation: its marker goes with it, and makes no record", async () => {
    // Taken out of live without an exit (a start given up), and one whose process exited before the CLI started it.
    run('never-spawned', 'a1', { recorded: [] })
    manager.live.clear()
    expect(manager.serverMarked(alpha, 'never-spawned')).toBe(false)
    await end(run('exited-early', 'a1', { recorded: [] }))
    expect(manager.serverMarked(alpha, 'exited-early')).toBe(false)
    expect(await w.sessionRecord(alpha, 'exited-early')).toBeUndefined()
    expect(serverMarksForTests().pending(alpha)).toEqual([])
  })

  it('two live runs of one conversation: marked until the last ends', async () => {
    await record('shared', true)
    const one = run('shared', 'a1', { saved: ['shared'] })
    const two = run('shared', 'a2', { saved: ['shared'] })
    await end(one)
    expect(manager.serverMarked(alpha, 'shared')).toBe(true)
    await end(two)
    expect(manager.serverMarked(alpha, 'shared')).toBe(false)
  })

  it("its record couldn't be saved: kept after the exit (never Claude-priced), saved after the host's next write, then let go", async () => {
    const real = WorkspaceService.prototype.mutateSessions
    const failing = vi.spyOn(WorkspaceService.prototype, 'mutateSessions').mockRejectedValue(new Error('disk full'))
    await end(run('unsaved'))
    expect(manager.serverMarked(alpha, 'unsaved')).toBe(true)
    expect((await manager.usageFor(alpha, transcript, 'unsaved', 'claude-code'))?.costUsd).toBeNull()
    // The host's next record write: tried again, still failing, still kept.
    await manager.saveServerMarks(alpha)
    expect(serverMarksForTests().pending(alpha)).toEqual(['unsaved'])
    failing.mockImplementation(real)
    await manager.saveServerMarks(alpha)
    expect((await w.sessionRecord(alpha, 'unsaved'))?.serverRan).toBe(true)
    expect(serverMarksForTests().pending(alpha)).toEqual([])
    expect(manager.serverMarked(alpha, 'unsaved')).toBe(false)
    expect(await readAfter('unsaved')).toBeNull()
  })

  it('a workspace closing with an unsaved marker: its host fails closed, so its reopening reads it without the report', async () => {
    const ws2 = join(base, 'ws2')
    const beta = join(ws2, 'beta')
    mkdirSync(join(beta, '.combwork'), { recursive: true })
    writeFileSync(join(beta, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'b1', name: 'B1' }] }))
    const other = createWorkspaceService()
    await other.open(ws2)
    vi.spyOn(WorkspaceService.prototype, 'mutateSessions').mockRejectedValue(new Error('disk full'))
    const l: Live = { state: { projectPath: beta, agentId: 'b1', provider: 'claude-code', sessionId: 'b-unsaved', status: 'idle', runId: 'run-beta' }, adapter: providerAdapter('claude-code'), serverSids: new Set(['b-unsaved']), serverRecorded: new Set(['b-unsaved']) }
    await manager.serverRunEnded(beta, manager.serverRunEnding(l))
    vi.restoreAllMocks()
    expect(serverMarksForTests().pending(beta)).toEqual(['b-unsaved'])
    await disposeWorkspaceService(other)
    expect(serverMarksForTests().pending(beta)).toEqual([])
    expect(manager.serverMarked(beta, 'b-unsaved')).toBe(true)
    expect(manager.serverMarked(beta, 'another')).toBe(true)
    // The first workspace's host isn't touched.
    expect(manager.serverMarked(alpha, 'another')).toBe(false)
  })

  // HR2's round 1: while the exit's record write was pending, the run was out of live and nothing marked it ($9 read).
  it('while its exit saves its record (out of live already): still marked and read without the report, saved or not', async () => {
    const real = WorkspaceService.prototype.mutateSessions
    for (const outcome of ['saved', 'failed'] as const) {
      const sid = `pending-${outcome}`
      await record(sid)
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      let entered!: () => void
      const writing = new Promise<void>((r) => (entered = r))
      vi.spyOn(WorkspaceService.prototype, 'mutateSessions').mockImplementation(async function (this: InstanceType<typeof WorkspaceService>, ...args: Parameters<typeof real>) {
        entered()
        await held
        if (outcome === 'failed') throw new Error('disk full')
        return real.apply(this, args) as never
      })
      const l = run(sid)
      const ending = manager.serverRunEnding(l)
      manager.live.delete(`${alpha.toLowerCase()}#a1`)
      // Out of live, its write not begun: held.
      expect(manager.serverMarked(alpha, sid)).toBe(true)
      const done = manager.serverRunEnded(alpha, ending)
      await writing
      // Its write under way: still held, and a read takes no report.
      expect(manager.serverMarked(alpha, sid)).toBe(true)
      expect((await manager.usageFor(alpha, transcript, sid, 'claude-code'))?.costUsd).toBeNull()
      release()
      await done
      vi.restoreAllMocks()
      if (outcome === 'saved') {
        expect((await w.sessionRecord(alpha, sid))?.serverRan).toBe(true)
        expect(manager.serverMarked(alpha, sid)).toBe(false)
        expect(await readAfter(sid)).toBeNull()
      } else {
        expect(serverMarksForTests().pending(alpha)).toContain(sid)
        expect(manager.serverMarked(alpha, sid)).toBe(true)
        serverMarksForTests().deleted(alpha, sid)
      }
    }
  })

  it('a deleted session: its kept marker goes', async () => {
    vi.spyOn(WorkspaceService.prototype, 'mutateSessions').mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'))
    await end(run('to-delete'))
    expect(serverMarksForTests().pending(alpha)).toEqual(['to-delete'])
    vi.restoreAllMocks()
    // As Delete does once its record and copies are gone (deleteOne).
    serverMarksForTests().deleted(alpha, 'to-delete')
    expect(serverMarksForTests().pending(alpha)).toEqual([])
  })
})
