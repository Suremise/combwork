// The usage history's work for a workspace stops when it closes (#1379): an import begun as it opened, still reading
// when the window switched to another workspace, doesn't read the closed one's sessions, which opened its hive.db again
// and held its folder until Hive quit (the user couldn't move or delete it); nor does its housekeeping go on to the
// backups' retention; and a transcript read that takes its saved state from the closed workspace's usage.db closes it
// again after.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('hive-usage-closed-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const { usageHistory } = await import('../src/main/usageHistory')
const { boardOpen } = await import('../src/main/boardStore')
const { sessions } = await import('../src/main/sessions')
const { usageFile } = await import('../src/main/usageDb')

const [wsA, wsB, wsC, wsD] = ['alpha', 'beta', 'gamma', 'delta'].map((n) => join(base, n))
let w: ReturnType<typeof createWorkspaceService>

/** Holds a promise until `release()`: the moment a test switches workspaces in. */
function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

describe('the usage history of a workspace that closed', () => {
  beforeAll(async () => {
    for (const ws of [wsA, wsB, wsC, wsD]) {
      mkdirSync(join(ws, 'proj', '.hive'), { recursive: true })
      writeFileSync(join(ws, 'proj', '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'c1', name: 'Agent 1' }] }))
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

  it("closes the usage.db a transcript read opened for a workspace that closed while it waited", async () => {
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
      const file = usageFile(wsD)
      expect(existsSync(file)).toBe(true)
      // Closed again after the read: the folder can go.
      await vi.waitFor(() => rmSync(join(wsD, '.hive'), { recursive: true }), { timeout: 20000 })
    } finally {
      spy.mockRestore()
      inner.closeInProcess = closeAll
      closeAll?.()
    }
  })
})
