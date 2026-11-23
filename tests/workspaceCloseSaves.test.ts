// A workspace's close waits for its workspace.json saves under way (HI-3544), as it waits for its refreshes (#1341): a save
// a refresh started and didn't wait for (flagDuplicateNames) wrote into the folder after its window let it go, and a test
// file's removal of its temp folders then failed, logging after its worker closed.
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

const base = tempDir('cw-closesaves-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

// workspace.json's writes, held while `held` is set, so a save is under way when the close begins.
const gate = vi.hoisted(() => ({ held: null as Promise<void> | null, reached: () => undefined as void }))
vi.mock('../src/main/fsutil', async (actual) => {
  const real = await actual<typeof import('../src/main/fsutil')>()
  return {
    ...real,
    writeKeptJson: async (...args: Parameters<typeof real.writeKeptJson>) => {
      if (gate.held && args[0].endsWith('workspace.json')) {
        gate.reached()
        await gate.held
      }
      return real.writeKeptJson(...args)
    }
  }
})

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')

const HUNG_MS = timing('wait.hang')

describe("a workspace's close waits for its workspace.json saves (HI-3544)", () => {
  let w: ReturnType<typeof createWorkspaceService> | null = null
  afterEach(async () => {
    gate.held = null
    if (w) await disposeWorkspaceService(w)
    w = null
  })

  it('a save under way when the close begins ends first, and is written', async () => {
    const wsPath = tempDir('cw-closesaves-ws-')
    const ws = (w = createWorkspaceService())
    await ws.open(wsPath)
    await ws.refreshesSettled()
    let release = (): void => undefined
    gate.held = new Promise<void>((r) => (release = r))
    const reached = new Promise<void>((r) => (gate.reached = r))
    const order: string[] = []
    // Not awaited by its caller, as flagDuplicateNames' save isn't.
    const saving = ws.saveWorkspaceConfigWith(() => ({ flaggedAgentNames: ['b1'] })).then(() => order.push('saved'))
    await reached
    const closing = ws.close().then(() => order.push('closed'))
    // The rest of the close is done (its path let go): only the save is left, held.
    await vi.waitFor(() => expect(ws.path).toBeNull(), { timeout: HUNG_MS })
    release()
    await Promise.all([saving, closing])
    expect(order).toEqual(['saved', 'closed'])
    expect(JSON.parse(readFileSync(join(wsPath, '.combwork', 'workspace.json'), 'utf8')).flaggedAgentNames).toEqual(['b1'])
  })
})
