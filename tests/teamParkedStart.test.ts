// A start reserved before its session exists (HI-2081, HR1's round 3): the real sessions.start, held part-way through
// its own preparation (reserved, not live yet), makes a paused team not parked (the agent starting) and Install Now
// install nothing, though no session of it reports a status yet; released, the team is parked again.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const HUNG_MS = 10000
const base = tempDir('hive-teamparked-start-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const h = vi.hoisted(() => ({ open: [] as unknown[], installed: 0 }))
vi.mock('../src/main/workspace', async (orig) => ({ ...(await orig<object>()), openWorkspaces: () => h.open }))
vi.mock('../src/main/updater', async (orig) => ({ ...(await orig<object>()), restartAndInstall: () => void h.installed++, updateState: () => ({ status: 'ready' }) }))

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const tp = await import('../src/main/teamPause')
const parked = await import('../src/main/teamParked')

describe("a start reserved before its session exists (HI-2081, HR1's round 3)", () => {
  const wsPath = join(base, 'ws')
  const alpha = join(wsPath, 'alpha')
  let w: ReturnType<typeof createWorkspaceService>
  /** Starts held part-way through their preparation (reserved, not live yet) until released. */
  const held: (() => void)[] = []
  beforeAll(async () => {
    mkdirSync(join(alpha, '.combwork'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', alpha])
    writeFileSync(join(alpha, '.combwork', 'project.json'), JSON.stringify({ version: 2, layout: 'auto', agents: [{ id: 'b1', name: 'B1', provider: 'claude-code' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    h.open = [w]
    // sessions.start reserves the start, then this runs (its agent, provider, folder…): held here.
    Object.assign(sessions, { startReserved: () => new Promise((_, reject) => held.push(() => reject(new Error('released')))) })
  })
  afterAll(async () => disposeWorkspaceService(w))

  it('the reserved start keeps the team unparked and Install Now from installing; released, the team is parked', async () => {
    await tp.pauseTeam(w, 'user')
    expect((await parked.scanWorkspace(w)).parked).toBe(true)
    const slow = inWorkspace(w, () => sessions.start(alpha, { agentId: 'b1' })).catch((e: Error) => e.message)
    await vi.waitFor(() => expect(sessions.pendingStart(alpha, 'b1')).not.toBeNull(), { timeout: HUNG_MS })
    expect(sessions.liveFor(alpha, 'b1')).toBeNull()
    const v = await parked.scanWorkspace(w)
    expect(v.parked).toBe(false)
    expect(v.items).toEqual([expect.objectContaining({ agent: 'B1', kind: 'starting' })])
    expect((await parked.installIfParked()).installed).toBe(false)
    expect(h.installed).toBe(0)
    held.shift()!()
    expect(await slow).toBe('released')
    await vi.waitFor(async () => expect((await parked.scanWorkspace(w)).parked).toBe(true), { timeout: HUNG_MS })
  })
})
