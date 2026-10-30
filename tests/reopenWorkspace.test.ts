// The window opening the workspace it already has (HI-2141): at a restart, the window asked to open the workspace its
// restore at start was still opening, and that open closed it, so a pass's write in it failed ("The workspace this card
// belongs to has closed"). workspace:open now asks `alreadyHere` first: the window's own workspace, by any name (#455),
// once an open of it under way has ended, is given back as it is, never closed and opened again.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { junction } from './pathAliases'
import { tempDir } from './tempDir'

const base = tempDir('hive-reopen-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')

const made: ReturnType<typeof createWorkspaceService>[] = []
/** A window's workspace service, and a workspace folder with one project. */
function setup(name: string) {
  const ws = join(base, name)
  mkdirSync(join(ws, 'proj'), { recursive: true })
  const w = createWorkspaceService()
  made.push(w)
  return { w, ws }
}
afterEach(async () => {
  for (const w of made.splice(0)) await disposeWorkspaceService(w)
})

describe('opening the workspace a window already has (HI-2141)', () => {
  it('waits for the open under way (a restore), then gives it back without closing it', async () => {
    const { w, ws } = setup('restoring')
    const restore = w.open(ws)
    // Asked while the restore is still opening it, by another name.
    const here = w.alreadyHere(junction(ws, join(base, 'restoring-alias')))
    const restored = await restore
    const life = w.lifetime
    expect((await here)?.path).toBe(restored.path)
    expect(w.path).toBe(ws)
    expect(life.aborted).toBe(false)
    // Asked again once it is open: the same lifetime, still open.
    expect((await w.alreadyHere(ws))?.path).toBe(ws)
    expect(w.lifetime).toBe(life)
    expect(life.aborted).toBe(false)
  })

  it('is null for another folder, for none open, and while the window is opening another', async () => {
    const { w, ws } = setup('first')
    const other = join(base, 'second')
    mkdirSync(other, { recursive: true })
    expect(await w.alreadyHere(ws)).toBeNull()
    await w.open(ws)
    expect(await w.alreadyHere(other)).toBeNull()
    // Switching to `other`: the one it had is going, so opening it again is an open, not this.
    const switching = w.open(other)
    expect(await w.alreadyHere(ws)).toBeNull()
    await switching
    expect((await w.alreadyHere(other))?.path).toBe(other)
  })

  it('is null when the open under way fails, so the window opens it itself', async () => {
    const { w } = setup('failing')
    const missing = join(base, 'failing-missing')
    const failed = w.open(missing)
    const here = w.alreadyHere(missing)
    await expect(failed).rejects.toThrow(/Folder not found/)
    expect(await here).toBeNull()
  })
})
