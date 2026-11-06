// HI-2651: nothing saves a workspace's settings before its open has read them. Between the open taking the folder (its
// path set, so it is among the open workspaces) and its read of workspace.json, its settings in memory are still the
// defaults its last close left: a save then (the connections' migration on connections-changed, found on HI-2650's
// Sandbox probe) wrote those defaults over the workspace's own. A save then waits for the read and changes what was
// read; one whose open ends first writes nothing; and the migration leaves a workspace still opening for its open's
// workspace-changed. For a new workspace (what its creation seeded) and an existing one (its own settings).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-settings-read-')
process.env.CW_USER_DATA = join(base, 'profile')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { configTestHooks, createWorkspaceService, disposeWorkspaceService, setNewWorkspaceExtras } = await import('../src/main/workspace')
const { emit } = await import('../src/main/events')
const moves = await import('../src/main/connectionMoves')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 10_000
const OWN = { workflow: { git: { loopRounds: 7 } }, connections: { 'claude-code': { on: ['acc-own'] } } }
const services = new Set<ReturnType<typeof createWorkspaceService>>()
let n = 0

afterEach(async () => {
  delete configTestHooks.beforeSettingsRead
  delete configTestHooks.saveWaitsForRead
  setNewWorkspaceExtras(async () => ({}))
  for (const w of services) await disposeWorkspaceService(w)
  services.clear()
})

/** A workspace folder: `existing` has its own settings in workspace.json (none migrated); a new one is seeded with them. */
function workspaceFolder(kind: 'new' | 'existing'): string {
  const path = join(base, `ws-${kind}-${++n}`)
  mkdirSync(join(path, 'alpha', '.combwork'), { recursive: true })
  writeFileSync(join(path, 'alpha', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
  if (kind === 'existing') {
    mkdirSync(join(path, '.combwork'), { recursive: true })
    writeFileSync(join(path, '.combwork', 'workspace.json'), JSON.stringify(OWN))
  } else setNewWorkspaceExtras(async () => structuredClone(OWN))
  return path
}

const saved = (path: string) => JSON.parse(readFileSync(join(path, '.combwork', 'workspace.json'), 'utf8'))

function service() {
  const w = createWorkspaceService()
  services.add(w)
  return w
}

describe("a workspace's settings are never saved before its open has read them (HI-2651)", () => {
  it.each(['new', 'existing'] as const)('a save started before the read waits for it and changes what was read (%s workspace)', async (kind) => {
    const path = workspaceFolder(kind)
    const w = service()
    const saves: Promise<void>[] = []
    configTestHooks.beforeSettingsRead = async () => {
      // Each save either writes now (what the bug did: the defaults over the file) or says it waits for the read.
      let waits = 0
      let bothWait!: () => void
      const waiting = new Promise<void>((r) => (bothWait = r))
      configTestHooks.saveWaitsForRead = () => void (++waits === 2 && bothWait())
      expect(w.readingSettings).toBe(true)
      saves.push(w.saveWorkspaceConfigWith((c) => ({ migrations: { ...c.migrations, accounts1: { at: 'marked' } } })))
      saves.push(w.saveWorkspaceConfig())
      await Promise.race([Promise.all(saves), waiting])
    }
    await w.open(path)
    await Promise.all(saves)
    for (const c of [saved(path), w.config]) expect(c).toMatchObject({ ...OWN, migrations: { accounts1: { at: 'marked' } } })
    expect(w.readingSettings).toBe(false)
  })

  it.each(['new', 'existing'] as const)("connections-changed while it opens doesn't migrate it from the defaults; its open does, from its own (%s workspace)", async (kind) => {
    moves.initConnectionMoves()
    const path = workspaceFolder(kind)
    const w = service()
    configTestHooks.beforeSettingsRead = async () => {
      emit({ type: 'connections-changed' })
      // A migration started by it goes first to the Assistant's home: once that is done, it has looked at the
      // workspace's settings and started its save (what the bug did) before the read below; none started, nothing.
      await moves.ensureMigrated(w.assistantHome)
    }
    await w.open(path)
    // The migration, from the open's workspace-changed, records itself done in the file. Before HI-2651 the one started
    // during the open saved the defaults with its record: whichever write landed last lost the settings (the probe's)
    // or the record (here, behind the open's own MCP save).
    await vi.waitFor(() => expect(saved(path).migrations?.accounts1).toBeTruthy(), { timeout: HUNG_MS, interval: 20 })
    for (const c of [saved(path), w.config]) expect(c).toMatchObject(OWN)
  })

  it('a save waiting for an open that fails before the read writes nothing', async () => {
    const path = workspaceFolder('existing')
    const w = service()
    let save: Promise<void> | null = null
    configTestHooks.beforeSettingsRead = async () => {
      save = w.saveWorkspaceConfigWith(() => ({ migrations: { accounts1: { at: 'never' } } }))
      throw new Error('the open fails here')
    }
    await expect(w.open(path)).rejects.toThrow('the open fails here')
    await save
    expect(w.path).toBeNull()
    expect(existsSync(join(path, '.combwork', 'workspace.json')) && saved(path)).toEqual(OWN)
  })
})
