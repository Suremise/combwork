// The usage history's work for a workspace stops when it closes (#1379): an import begun as it opened, still reading
// when the window switched to another workspace, doesn't read the closed one's sessions, which opened its hive.db again
// and held its folder until Hive quit (the user couldn't move or delete it).
import { mkdirSync, rmSync, writeFileSync } from 'fs'
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

const [wsA, wsB] = ['alpha', 'beta'].map((n) => join(base, n))
let w: ReturnType<typeof createWorkspaceService>

describe('the usage history of a workspace that closed', () => {
  beforeAll(async () => {
    for (const ws of [wsA, wsB]) {
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
    let answer!: () => void
    const switched = new Promise<void>((resolve) => (answer = resolve))
    const list = w.listProjectPaths.bind(w)
    const spy = vi.spyOn(w, 'listProjectPaths').mockImplementationOnce(async (o) => {
      const paths = await list(o)
      await switched
      return paths
    })
    const importing = usageHistory.opened(w)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 20000 })
    await w.open(wsB)
    expect(boardOpen(wsA)).toBe(false)
    answer()
    await importing
    spy.mockRestore()
    expect(boardOpen(wsA)).toBe(false)
  })
})
