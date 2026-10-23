// Project-config write stamps (#1432, bounded by #1498): what an inbox line's typing checks (deliveries.ts InboxProject:
// a stamp read before, compared as the line is typed). The stamps are forgotten when the workspace closes and when a
// refresh finds a project gone, so the map doesn't grow across workspaces and removed projects; a write forgotten still
// reads as a change (never as none), whatever closes, reopens, goes or comes back meanwhile. Real workspace service.
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

describe('project-config write stamps (#1498)', async () => {
  const base = tempDir('hive-configwrites-')
  ;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
  const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
  let n = 0
  /** A workspace folder with projects (each a .hive/project.json). */
  const folder = (...projects: string[]): string => {
    const path = join(base, `ws-${++n}`)
    for (const p of projects) {
      mkdirSync(join(path, p, '.hive'), { recursive: true })
      writeFileSync(join(path, p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
    }
    return path
  }
  type Service = ReturnType<typeof createWorkspaceService>
  const writes = (w: Service): Map<string, unknown> => (w as unknown as { configWrites: Map<string, unknown> }).configWrites
  const kept = (w: Service): number => writes(w).size

  it('a write is a change; a snapshot taken after it is not, until the next one', async () => {
    const w = createWorkspaceService()
    const path = folder('alpha')
    await w.open(path)
    const alpha = join(path, 'alpha')
    const before = w.projectConfigWrites(alpha)
    await w.updateProjectConfig(alpha, { chime: 'on' })
    expect(w.projectConfigWrites(alpha)).not.toBe(before)
    const after = w.projectConfigWrites(alpha)
    expect(w.projectConfigWrites(alpha)).toBe(after)
    await w.updateProjectConfig(alpha, { chime: 'off' })
    expect(w.projectConfigWrites(alpha)).not.toBe(after)
    await disposeWorkspaceService(w)
  })

  it('close and reopen with an old snapshot: a write before the close still reads as a change after the reopen, and the next write too', async () => {
    const w = createWorkspaceService()
    const path = folder('alpha', 'beta')
    await w.open(path)
    const alpha = join(path, 'alpha')
    const old = w.projectConfigWrites(alpha)
    await w.updateProjectConfig(alpha, { chime: 'on' })
    await w.close()
    expect(kept(w)).toBe(0)
    await w.open(path)
    // alpha was written after `old` was read: still a change.
    expect(w.projectConfigWrites(alpha)).not.toBe(old)
    // A snapshot from before the close with no write since can read changed (looked at again): never a missed write.
    const now = w.projectConfigWrites(alpha)
    await w.updateProjectConfig(alpha, { chime: 'off' })
    expect(w.projectConfigWrites(alpha)).not.toBe(now)
    await disposeWorkspaceService(w)
  })

  it('a project removed and added back while an old snapshot exists: its write still reads as a change, and its stamp is forgotten while it is gone', async () => {
    const w = createWorkspaceService()
    const path = folder('alpha', 'beta')
    await w.open(path)
    const alpha = join(path, 'alpha')
    const old = w.projectConfigWrites(alpha)
    await w.updateProjectConfig(alpha, { chime: 'on' })
    expect(writes(w).has(alpha.toLowerCase())).toBe(true)
    // Moved out of the workspace (removed): the next refresh finds it gone and forgets its stamp.
    const away = join(base, `away-${n}`)
    renameSync(alpha, away)
    await w.refresh()
    expect(writes(w).has(alpha.toLowerCase())).toBe(false)
    expect(w.projectConfigWrites(alpha)).not.toBe(old)
    // Back again: still a change against the snapshot from before it went.
    renameSync(away, alpha)
    await w.refresh()
    expect(w.projectConfigWrites(alpha)).not.toBe(old)
    await disposeWorkspaceService(w)
  })

  it("the stamps don't grow across closed workspaces: only the open one's written projects are kept", async () => {
    const w = createWorkspaceService()
    for (let i = 0; i < 5; i++) {
      const path = folder('alpha', 'beta')
      await w.open(path)
      await w.updateProjectConfig(join(path, 'alpha'), { chime: 'on' })
      await w.updateProjectConfig(join(path, 'beta'), { chime: 'on' })
      expect(kept(w)).toBe(2)
      await w.close()
      expect(kept(w)).toBe(0)
    }
    await disposeWorkspaceService(w)
  })
})
