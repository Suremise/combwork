// The "Permission mode changed" offer (#1234): Combwork offers to switch a running agent when its permission mode setting
// changes, never because it restarted. An agent given a task in a new conversation stops and starts again; a refresh
// landing while the new launch reads its settings once saw a session with no mode yet and offered to switch it into
// the mode it was already in.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

// The notices Combwork raises, recorded (and still sent).
const toasts = vi.hoisted(() => ({ titles: [] as string[] }))
vi.mock('../src/main/events', async (original) => {
  const real = await original<typeof import('../src/main/events')>()
  return {
    ...real,
    toast: (...a: Parameters<typeof real.toast>) => {
      toasts.titles.push(a[1])
      return real.toast(...a)
    }
  }
})

const base = tempDir('cw-modeoffer-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
// A test copy on its CLI test home (tests/cliHomes.ts), as an e2e run is: its agents start with no connection (the
// seam, HI-1755; connections are on for everyone since HI-1774).
process.env.CW_USER_DATA = join(base, 'profile')
process.env.CW_TEST_CLI_HOME_CONNECTION = '1'

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { sessions } = await import('../src/main/sessions')
const { providerService } = await import('../src/main/providerService')
const { config } = await import('../src/main/config')
const accounts = await import('../src/main/accounts')

const wsPath = join(base, 'ws')
const p = join(wsPath, 'ambrosia')
const id = `${p.toLowerCase()}#amb1`
const s = sessions as unknown as { live: Map<string, { configuredMode?: string | null }>; runs: Map<string, string>; modeOffers: Map<string, unknown>; modeOfferTimer: NodeJS.Timeout | null }
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** A refresh of the project's agents, as the window's after a session starts or stops. */
const refresh = () => run(async () => sessions.liveInfo(p, await w.projectConfig(p)))
// Its mode is its connection's (HI-2106): changed as the connection dialog changes it (HI-2122).
const setMode = (mode: string) => run(async () => accounts.updateConnection((await w.projectConfig(p)).agents.find((a) => a.id === 'amb1')!.connection!, { permissionMode: mode as never }))
/** Bounds a hung run only: the offer is sent 400 ms after the refresh that makes it. */
const HUNG_MS = 10000
const offered = () => s.modeOffers.size > 0 || s.modeOfferTimer !== null

describe('the offer to switch a running agent to a changed permission mode', () => {
  const info = providerService.info
  const enabled = config.settings.providers['claude-code'].enabled
  beforeAll(async () => {
    mkdirSync(join(wsPath, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'amb1', name: 'AMB1', provider: 'claude-code', permissionMode: 'auto' }] }))
    w = createWorkspaceService()
    await w.open(wsPath)
    providerService.info = ((pid: string) => ({ provider: pid, found: true, path: join(base, 'no-cli.exe') })) as never
    config.settings.providers['claude-code'].enabled = true
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    s.live.clear()
    s.runs.clear()
    if (s.modeOfferTimer) clearTimeout(s.modeOfferTimer)
    s.modeOfferTimer = null
    s.modeOffers.clear()
    toasts.titles.length = 0
    await setMode('auto')
  })
  afterAll(async () => {
    providerService.info = info
    config.settings.providers['claude-code'].enabled = enabled
    await disposeWorkspaceService(w)
  })

  it('a restart into a new conversation offers nothing, though a refresh lands while the launch reads its settings', async () => {
    const effective = sessions.effective.bind(sessions)
    let during: { offered: boolean; configured: string | null | undefined } | null = null
    vi.spyOn(sessions, 'effective').mockImplementation(async (...a) => {
      // The launch's own read (a refresh passes its reads): the window refreshes meanwhile.
      if (!a[2] && !during) {
        await refresh()
        during = { offered: offered(), configured: s.live.get(id)?.configuredMode }
      }
      return effective(...a)
    })
    // Stopped just before its terminal would start, past the launch's read of its settings.
    const past = new Error('past the launch')
    let configured: string | null | undefined
    const started = run(() =>
      sessions.start(p, {
        agentId: 'amb1',
        prompt: 'New lane: #12',
        allowed: () => {
          configured = s.live.get(id)?.configuredMode
          if (configured) throw past
        }
      })
    )
    await expect(started).rejects.toBe(past)
    expect(during).toEqual({ offered: false, configured: undefined })
    expect(configured).toBe('auto')
    expect(offered()).toBe(false)
    expect(toasts.titles).toEqual([])
  })

  it('a change of its setting while it runs still offers to switch it', async () => {
    const state = { provider: 'claude-code', runId: 'run-amb1', projectPath: p, agentId: 'amb1', cwd: p, sessionId: 'its-session', status: 'ready', startedAt: '', launchSignature: '', unseen: false, permissionMode: 'auto' }
    // Launched in what its settings said (launch sets configuredMode).
    s.live.set(id, { state, transcriptMtime: '', defaultModel: false, modeTail: '', launchMode: 'auto', configuredMode: 'auto' } as never)
    s.runs.set(state.runId, id)
    await refresh()
    expect(offered()).toBe(false)
    await setMode('plan')
    await refresh()
    await vi.waitFor(() => expect(toasts.titles).toEqual(['Permission mode changed to Plan']), { timeout: HUNG_MS })
  })
})
