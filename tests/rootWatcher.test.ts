// The workspace root's watch (#964). On Windows, a watched folder deleted raises no error: fs.watch sends 'rename' events
// naming the folder's own full path without end (about 100,000 in half a second), even once a folder of that name is
// made again, and each one reset the refresh's timers, keeping the main process busy until the workspace closed. Now the
// watch ends on such an event and is tried again every few seconds until the folder is back; closing the workspace ends it.
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { bound } from './keepType'

const base = tempDir('cw-root-watcher-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')

/** Bounds a hung run; the tests wait for what they expect, never for a time. */
const HUNG_MS = 15_000


describe("the workspace root's watch (#964)", () => {
  let w: ReturnType<typeof createWorkspaceService>
  const wsPath = join(base, 'ws')
  let refreshes = 0

  beforeAll(async () => {
    mkdirSync(join(wsPath, 'alpha'), { recursive: true })
    w = createWorkspaceService()
    await w.open(wsPath)
    const schedule = bound(w, w.scheduleRefresh)
    w.scheduleRefresh = () => {
      refreshes++
      schedule()
    }
  })
  afterAll(async () => {
    await disposeWorkspaceService(w)
  })

  it('a project folder added tells the workspace, as before', async () => {
    refreshes = 0
    mkdirSync(join(wsPath, 'beta'))
    await vi.waitFor(() => expect(refreshes).toBeGreaterThan(0), { timeout: HUNG_MS })
  })

  it('the workspace folder deleted ends the watch (Windows then sends events without end), and made again it is watched again', { timeout: 60_000 }, async () => {
    expect(w['rootWatcher']).not.toBeNull()
    // .combwork's own watcher holds its folders: closed, so the whole workspace folder can go, as when deleted with Combwork's window showing another.
    await w['watcher']?.close()
    w['watcher'] = null
    await vi.waitFor(() => rmSync(wsPath, { recursive: true, force: true }), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(w['rootWatcher']).toBeNull(), { timeout: HUNG_MS })
    expect(w['rootRetry']).not.toBeNull()
    // Made again (Windows may refuse it while the old watch is still closing): watched again, which reads the folder again.
    refreshes = 0
    await vi.waitFor(() => void mkdirSync(join(wsPath, 'gamma'), { recursive: true }), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(w['rootWatcher']).not.toBeNull(), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(refreshes).toBeGreaterThan(0), { timeout: HUNG_MS })
    // And the new watch sees what changes in it.
    refreshes = 0
    mkdirSync(join(wsPath, 'delta'))
    await vi.waitFor(() => expect(refreshes).toBeGreaterThan(0), { timeout: HUNG_MS })
  })

  it('closing the workspace ends the watch and its retry', async () => {
    const other = createWorkspaceService()
    const otherPath = join(base, 'other')
    mkdirSync(otherPath, { recursive: true })
    await other.open(otherPath)
    expect(other['rootWatcher']).not.toBeNull()
    await other['watcher']?.close()
    other['watcher'] = null
    await vi.waitFor(() => rmSync(otherPath, { recursive: true, force: true }), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(other['rootRetry']).not.toBeNull(), { timeout: HUNG_MS })
    await disposeWorkspaceService(other)
    expect(other['rootWatcher']).toBeNull()
    expect(other['rootRetry']).toBeNull()
  })
})
