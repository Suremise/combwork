// Hand Over to… links the target's conversation with the one it came from (#782): bound to the target's launch and
// recorded with that launch's conversation whenever its id is known, never by a wait that gives up first. A stopped
// target is started with the handover as its launch's task and the source session on the launch; Codex names its
// conversation only with its first prompt, which a question at start can hold off for minutes. The real SessionManager's
// handOver and recordSession, with the launch, the delivery service and the CLI's hooks given by the test, in its order.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-handoverlink-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace, workspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')

type Live = { state: { runId: string; sessionId: string; projectPath: string; agentId: string; provider: string; cwd: string; startedAt: string; status: string }; name: string; adapter: { descriptor: { capabilities: { fixedSessionId: boolean } } }; handedOverFrom?: string }
type Internals = {
  live: Map<string, Live>
  recordSession: (projectPath: string, agent: { id: string; name: string }, l: Live) => Promise<void>
  deliveries: unknown
  combworkMcp: unknown
}
const internals = sessions as unknown as Internals

describe('a handover links the conversations it joins, whenever the target names its own (#782)', () => {
  const wsPath = join(base, 'ws')
  const proj = join(wsPath, 'demo')
  const from = '11111111-1111-4111-8111-111111111111'
  let w: ReturnType<typeof createWorkspaceService>
  const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
  const key = (agentId: string) => `${proj.toLowerCase()}#${agentId}`
  // The session's record as Combwork keeps it (#1061: in the workspace's database).
  const linkOf = async (id: string): Promise<string | undefined> => (await run(() => workspace.sessionsFile(proj))).sessions.find((s) => s.id === id)?.handedOverFrom
  // A launch of `agentId` as Combwork keeps it: Codex's, its session not named yet.
  const launch = (agentId: string, runId: string, handedOverFrom?: string): Live => {
    const l: Live = { state: { runId, sessionId: '', projectPath: proj, agentId, provider: 'codex', cwd: proj, startedAt: new Date().toISOString(), status: 'ready' }, name: 'Session', adapter: { descriptor: { capabilities: { fixedSessionId: false } } }, ...(handedOverFrom ? { handedOverFrom } : {}) }
    internals.live.set(key(agentId), l)
    return l
  }
  // The CLI's first hook names its session (handleHookIn): the launch's conversation is recorded.
  const named = (l: Live, sessionId: string) => {
    l.state.sessionId = sessionId
    return run(() => internals.recordSession(proj, { id: l.state.agentId, name: l.state.agentId }, l))
  }
  const given: { now: unknown[]; launched: { line: string }[] } = { now: [], launched: [] }
  const saved = { deliveries: internals.deliveries, combworkMcp: internals.combworkMcp }

  beforeAll(async () => {
    mkdirSync(join(proj, '.combwork'), { recursive: true })
    writeFileSync(join(proj, '.combwork', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'src', name: 'Source', provider: 'codex', lastSessionId: from }, { id: 'dst', name: 'Target', provider: 'codex' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    internals.combworkMcp = () => ({})
    internals.deliveries = {
      give: async () => undefined,
      now: async (_host: string, nd: unknown) => void given.now.push(nd),
      cancel: async () => 0,
      launch: async (_host: string, _nd: unknown, start: (line: string) => Promise<unknown>) => {
        given.launched.push({ line: 'doorbell' })
        return start('doorbell')
      }
    }
    vi.spyOn(sessions, 'latestHandover').mockResolvedValue({ relPath: 'handovers/2026-10-17-demo.md' } as never)
  })
  afterEach(() => {
    internals.live.clear()
    given.now = []
    given.launched = []
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    internals.deliveries = saved.deliveries
    internals.combworkMcp = saved.combworkMcp
    await disposeWorkspaceService(w)
  })

  it('a stopped target starts with the handover as its task and the source on its launch, linked when it names its session, however late', async () => {
    const start = vi.spyOn(sessions, 'start').mockImplementation(async (_p, opts) => launch(opts.agentId!, 'run-a', opts.handedOverFrom).state as never)
    try {
      // handOver returns with the target launched and nothing named yet: it waits for no session id.
      await run(() => sessions.handOver(proj, 'src', 'dst', { handover: false }))
      expect(start).toHaveBeenCalledWith(proj, { agentId: 'dst', prompt: 'doorbell', handedOverFrom: from })
      expect(given).toEqual({ now: [], launched: [{ line: 'doorbell' }] })
    } finally {
      start.mockRestore()
    }
    // Its CLI asked something at start, answered long after; then its first prompt names its session.
    const l = internals.live.get(key('dst'))!
    expect(l.handedOverFrom).toBe(from)
    await named(l, '22222222-2222-4222-8222-222222222222')
    expect(await linkOf('22222222-2222-4222-8222-222222222222')).toBe(from)
    // A conversation the CLI moves to later in that launch (/new) wasn't handed over.
    await named(l, '33333333-3333-4333-8333-333333333333')
    expect(await linkOf('33333333-3333-4333-8333-333333333333')).toBeUndefined()
  })

  it("a launch that ends before naming its session takes the link with it: the agent's next launch isn't linked", async () => {
    launch('dst', 'run-b', from)
    // Stopped before its first prompt; started again (by the user, with no handover).
    internals.live.delete(key('dst'))
    const next = launch('dst', 'run-c')
    await named(next, '44444444-4444-4444-8444-444444444444')
    expect(await linkOf('44444444-4444-4444-8444-444444444444')).toBeUndefined()
  })

  it('a running target is given it in its session: linked at once when named, else when it names it, and only in that launch', async () => {
    // Named already: linked as the handover is given.
    const named1 = launch('dst', 'run-d')
    await named(named1, '55555555-5555-4555-8555-555555555555')
    await run(() => sessions.handOver(proj, 'src', 'dst', { handover: false }))
    expect(given.now).toHaveLength(1)
    expect(await linkOf('55555555-5555-4555-8555-555555555555')).toBe(from)
    // Not named yet (Codex before its first prompt): its launch keeps the link until it is.
    internals.live.clear()
    const unnamed = launch('dst', 'run-e')
    await run(() => sessions.handOver(proj, 'src', 'dst', { handover: false }))
    expect(unnamed.handedOverFrom).toBe(from)
    await named(unnamed, '66666666-6666-4666-8666-666666666666')
    expect(await linkOf('66666666-6666-4666-8666-666666666666')).toBe(from)
  })

  it('a running target started again while the handover was being given: the new launch gets no link of the old one', async () => {
    const old = launch('dst', 'run-f')
    const real = internals.deliveries as { now: (h: string, nd: unknown) => Promise<unknown> }
    const now = real.now
    // The delivery lands, then the agent restarts before Combwork links: another launch, by then.
    real.now = async (h, nd) => {
      await now(h, nd)
      internals.live.delete(key('dst'))
      launch('dst', 'run-g')
    }
    try {
      await run(() => sessions.handOver(proj, 'src', 'dst', { handover: false }))
    } finally {
      real.now = now
    }
    expect(old.handedOverFrom).toBeUndefined()
    expect(internals.live.get(key('dst'))?.handedOverFrom).toBeUndefined()
  })

  // HI-2420 (HR1's round 1): the Assistant's hand-over carries its guard. Revoked while the handover is still being read
  // (before anything is given or launched), the target gets nothing: neither a delivery nor a launch.
  for (const running of [false, true]) {
    it(`the Assistant's hand-over revoked while its handover is read: the ${running ? 'running' : 'stopped'} target is given nothing (HI-2420)`, async () => {
      if (running) launch('dst', 'run-h')
      const start = vi.spyOn(sessions, 'start').mockImplementation(async (_p, opts) => {
        opts.allowed?.()
        return launch(opts.agentId!, 'run-i').state as never
      })
      let release!: () => void
      let reached!: () => void
      const held = new Promise<void>((r) => (release = r))
      const reading = new Promise<void>((r) => (reached = r))
      vi.spyOn(sessions, 'latestHandover').mockImplementationOnce(async () => {
        reached()
        await held
        return { relPath: 'handovers/2026-10-17-demo.md' } as never
      })
      let revoked = false
      const allowed = () => {
        if (revoked) throw new Error('Control was turned down meanwhile')
      }
      try {
        const op = run(() => sessions.handOver(proj, 'src', 'dst', { handover: false, allowed }))
        await reading
        revoked = true
        release()
        await expect(op).rejects.toThrow(/turned down/)
        expect(start).not.toHaveBeenCalled()
        expect(given).toEqual({ now: [], launched: [] })
      } finally {
        start.mockRestore()
      }
    })
  }
})
