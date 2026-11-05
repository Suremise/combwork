// A workspace's databases aren't opened again once a window starts closing it (#1379): an import begun as it opened, a
// session's ingest queued from no window's request, a host's first read waiting for the board's lock, a read resuming
// while the close waits for its file watcher, housekeeping between compression and retention, a transcript read taking
// its saved state from the closed workspace's usage.db. Each used to open its combwork.db or usage.db again as the window
// switched away, holding its folder until Combwork quit (the user couldn't move or delete it).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction } from './pathAliases'

const base = tempDir('hive-usage-closed-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { usageHistory } = await import('../src/main/usageHistory')
const { boardLock, boardOpen, workspaceDb } = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')
const { withFileLock } = await import('../src/main/fsutil')

const [wsA, wsB, wsC, wsD, wsE, wsF, wsG, wsH, wsI] = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'].map((n) => join(base, n))
let w: ReturnType<typeof createWorkspaceService>

/** Holds a promise until `release()`: the moment a test switches workspaces in. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

describe('the usage history of a workspace that closed', () => {
  beforeAll(async () => {
    for (const ws of [wsA, wsB, wsC, wsD, wsE, wsF, wsG, wsH, wsI]) {
      mkdirSync(join(ws, 'proj', '.combwork'), { recursive: true })
      writeFileSync(join(ws, 'proj', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
    }
    mkdirSync(join(base, 'profile'), { recursive: true })
    usageHistory.start()
    w = createWorkspaceService()
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
    await usageHistory.stop()
  })

  it("stops its import when the window switches away: the closed workspace's board isn't opened again", async () => {
    await w.open(wsA)
    // The import's list of projects answers only once the window has switched to beta (as a slow one can).
    const g = gate()
    const list = w.listProjectPaths.bind(w)
    const spy = vi.spyOn(w, 'listProjectPaths').mockImplementationOnce(async (o) => {
      const paths = await list(o)
      await g.held
      return paths
    })
    const importing = usageHistory.opened(w)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 20000 })
    await w.open(wsB)
    expect(boardOpen(wsA)).toBe(false)
    g.release()
    await importing
    spy.mockRestore()
    expect(boardOpen(wsA)).toBe(false)
  })

  it("stops its housekeeping between compression and retention when the window switches away", async () => {
    await w.open(wsC)
    const g = gate()
    const compress = vi.spyOn(sessions, 'compressIdleBackups').mockImplementationOnce(async () => {
      await g.held
      return 0
    })
    const retention = vi.spyOn(sessions, 'applyRetention')
    try {
      // The import (nothing to import), its sweep and attribution, then the backups' housekeeping, held in compression.
      const importing = usageHistory.opened(w)
      await vi.waitFor(() => expect(compress).toHaveBeenCalled(), { timeout: 20000 })
      await w.open(wsB)
      g.release()
      await importing
      expect(retention).not.toHaveBeenCalled()
      expect(boardOpen(wsC)).toBe(false)
    } finally {
      compress.mockRestore()
      retention.mockRestore()
    }
  })

  it("leaves no usage.db open for a transcript read whose workspace closed while it waited", async () => {
    // As a worker thread does: its files stay open until it's told to close them (in-process it closes them when idle).
    const inner = usageHistory as unknown as { closeInProcess: (() => void) | null }
    await usageHistory.storedSessions(wsB, null)
    const closeAll = inner.closeInProcess
    expect(closeAll).toBeTypeOf('function')
    inner.closeInProcess = null
    await w.open(wsD)
    const host = join(wsD, 'proj')
    const transcript = join(base, 'delta-transcript.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: 's1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Task' } }) + '\n')
    // Where the session's saved state is answers only once the window has switched to beta.
    const g = gate()
    const scope = w.sessionScope.bind(w)
    const spy = vi.spyOn(w, 'sessionScope').mockImplementationOnce(async (p) => {
      const s = await scope(p)
      await g.held
      return s
    })
    try {
      const reading = usageHistory.read(host, transcript, '00000000-0000-4000-9000-000000000001', 'claude-code')
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 20000 })
      await w.open(wsB)
      g.release()
      await reading
      // Its saved state isn't looked for in the closed workspace's usage.db (or, sent before the close, the file is closed
      // again after): the folder can go.
      await vi.waitFor(() => rmSync(join(wsD, '.combwork'), { recursive: true }), { timeout: 20000 })
    } finally {
      spy.mockRestore()
      inner.closeInProcess = closeAll
      closeAll?.()
    }
  })

  it("a host's first read, waiting for the board's lock as the window switches away, doesn't open the closed board again", async () => {
    await w.open(wsE)
    const host = join(wsE, 'proj')
    // The board's lock held: the read's move of the host's records into the database waits for it.
    const g = gate()
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const lock = withFileLock(boardLock(resolvePath(wsE)), async () => {
      locked()
      await g.held
    })
    await holding
    const reading = w.sessionsFile(host).then(
      () => 'read',
      (e: Error) => e.message
    )
    await vi.waitFor(() => expect(boardOpen(wsE)).toBe(true), { timeout: 20000 })
    const switching = w.open(wsB)
    await vi.waitFor(() => expect(boardOpen(wsE)).toBe(false), { timeout: 20000 })
    g.release()
    await lock
    await switching
    expect(await reading).toBe('The workspace was closed')
    expect(boardOpen(wsE)).toBe(false)
  })

  it("a session's ingest, finding its transcript as the window switches away, doesn't open the closed board again", async () => {
    const id = '00000000-0000-4000-9000-000000000002'
    const at = new Date().toISOString()
    writeFileSync(join(wsF, 'proj', '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ id, agent: 'claude-code', agentId: 'c1', name: 'a session', createdAt: at, lastActiveAt: at }] }))
    await w.open(wsF)
    const host = join(wsF, 'proj')
    const g = gate()
    const find = sessions.anyTranscript.bind(sessions)
    const spy = vi.spyOn(sessions, 'anyTranscript').mockImplementationOnce(async (p, s) => {
      await g.held
      return find(p, s)
    })
    const providers = vi.spyOn(sessions, 'providerTranscript')
    try {
      // Queued as the tick and a session's end queue it: from no window's request.
      const ingesting = usageHistory.ingest(host, id, { priority: 1, keepState: 'no' }).catch(() => null)
      await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 20000 })
      await w.open(wsB)
      expect(boardOpen(wsF)).toBe(false)
      g.release()
      await ingesting
      expect(providers).toHaveBeenCalled()
      expect(boardOpen(wsF)).toBe(false)
    } finally {
      spy.mockRestore()
      providers.mockRestore()
    }
  })

  it("a read resuming while the window's close waits for its file watcher doesn't open the closed board again", async () => {
    await w.open(wsG)
    const host = join(wsG, 'proj')
    await w.sessionsFile(host)
    expect(boardOpen(wsG)).toBe(true)
    // The close's file watcher stops only when the test says, after its real stop: the board is closed by then, the
    // workspace's path not yet cleared.
    const g = gate()
    const watcher = (w as unknown as { watcher: { close: () => Promise<void> } }).watcher
    const stop = watcher.close.bind(watcher)
    watcher.close = async () => {
      await stop()
      await g.held
    }
    const closing = w.close()
    await vi.waitFor(() => expect(boardOpen(wsG)).toBe(false), { timeout: 20000 })
    expect(w.path).toBe(wsG)
    const reading = w.sessionsFile(host).then(
      () => 'read',
      (e: Error) => e.message
    )
    expect(await reading).toBe('The workspace was closed')
    g.release()
    await closing
    expect(boardOpen(wsG)).toBe(false)
  })

  it('a workspace closed by one name is closed by every other: its board is not opened again through a junction, either way round', async () => {
    // Closed by its real name, asked for through a junction.
    await w.open(wsH)
    await w.sessionsFile(join(wsH, 'proj'))
    const viaH = junction(wsH, join(base, 'theta-alias'))
    await w.open(wsB)
    expect(boardOpen(wsH)).toBe(false)
    expect(() => workspaceDb(viaH)).toThrow('The workspace was closed')
    expect(boardOpen(viaH) || boardOpen(wsH)).toBe(false)
    // Opened and closed through a junction, asked for by its real name.
    const viaI = junction(wsI, join(base, 'iota-alias'))
    await w.open(viaI)
    await w.sessionsFile(join(viaI, 'proj'))
    await w.open(wsB)
    expect(() => workspaceDb(wsI)).toThrow('The workspace was closed')
    expect(boardOpen(wsI) || boardOpen(viaI)).toBe(false)
    // Opened again by the other name: its board opens as it is used.
    await w.open(wsI)
    await w.sessionsFile(join(wsI, 'proj'))
    expect(boardOpen(wsI)).toBe(true)
    await w.open(wsB)
  })
})
