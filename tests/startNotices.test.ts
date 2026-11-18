// HI-3214: a start after an update and a quit shows "Combwork updated to …" beside exactly one offer to resume, naming only
// the agents that can resume. 1.5.0-rc.1's start of 14 Nov showed the offer twice (the queue told it as the workspace's
// slots recovered, then the window's start notices told it again), and listed HB6, started in a newer conversation since.
// Both start paths run here for real: the updater's notice (its packaged guard met by a packaged stand-in, its last run
// another version) and restart recovery (its queue and its start notices), each telling through main's toast(), which
// this test's teller records. Sessions, workspaces and the offers' registry are stood in for, as restartRecovery.test does.
import { writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dropLoggerListenersAfterEach, loggerListenerCounts } from './loggerListeners'
import { tempDir } from './tempDir'
import { timing } from './timing.cjs'

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take. The updater's
// notice is told 4 s after it starts, so this is well past it.
const HUNG_MS = timing('wait.hang')

const h = vi.hoisted(() => ({
  workspaces: [] as unknown[],
  toasts: [] as { title: string; message?: string; offer?: string; id?: string }[],
  openOffers: new Set<string>(),
  resolved: [] as [string, string][]
}))

vi.mock('electron-updater', () => ({ autoUpdater: { on: () => undefined, checkForUpdates: async () => ({ isUpdateAvailable: false }), quitAndInstall: () => undefined, setFeedURL: () => undefined } }))
// Its last run another version (the update), and no automatic checks (none is about this).
vi.mock('../src/main/config', () => ({
  config: {
    get settings() {
      return { updates: { checkAutomatically: false, downloadAutomatically: false, install: 'manual', prerelease: false } }
    },
    onSettingsChanged: () => undefined,
    get: () => ({ lastRunVersion: '0.0.0-before' }),
    update: () => undefined
  }
}))
vi.mock('../src/main/sessions', () => ({
  sessions: {
    liveStates: () => [],
    liveFor: () => null,
    pendingStart: () => null,
    resumeHoldFor: async () => null,
    start: async () => {
      throw new Error('nothing resumes here: the offer is never answered')
    },
    stop: () => undefined,
    stopWhereAndWait: async () => undefined
  }
}))
vi.mock('../src/main/workspace', () => ({
  openWorkspaces: () => h.workspaces,
  workspaceOf: (p: string) => (h.workspaces as { path: string }[]).find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())),
  workspaceFor: (p: string) => (h.workspaces as { path: string }[]).find((w) => p.toLowerCase().startsWith(w.path.toLowerCase())) ?? null,
  inWorkspace: (_w: unknown, fn: () => unknown) => fn()
}))
vi.mock('../src/main/lanes', () => ({ listLanes: async () => [] }))
vi.mock('../src/main/teamPause', () => ({ pausedFor: () => null }))
vi.mock('../src/main/tasks', () => ({ allTasks: async () => [] }))
vi.mock('../src/main/deliveries', () => ({ createDelivery: async () => null, leaveDelivery: async () => null, roundOf: () => 1 }))
vi.mock('../src/main/assistantControl', () => ({ assistantHome: (ws: string) => join(ws, '.combwork', 'assistant') }))
vi.mock('../src/main/notify', () => ({
  resolveOffer: (offer: string, outcome: string) => {
    h.resolved.push([offer, outcome])
    return h.openOffers.delete(offer)
  },
  resolveOffers: () => 0,
  dropOfferActions: (offer: string) => h.openOffers.has(offer)
}))
vi.mock('../src/main/advanced', () => ({ advanced: { get: (id: string) => ({ 'cw.restart.resumeAfterUpdate': true, 'cw.restart.resumeReadySeconds': 90 })[id] } }))

dropLoggerListenersAfterEach()
const listenersAtStart = loggerListenerCounts()
afterAll(() => {
  expect(loggerListenerCounts()).toEqual(listenersAtStart)
})

let restart: typeof import('../src/main/restartResume') | null = null
beforeEach(async () => {
  vi.resetModules()
  Object.assign(h, { workspaces: [], toasts: [], openOffers: new Set(), resolved: [] })
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = true
})
afterEach(async () => {
  restart?.stopRestartRecovery()
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = false
})

describe('a start after an update and a quit (HI-3214)', () => {
  it('"updated to" beside exactly one offer, naming only the agents that can resume, once both start paths have run', async () => {
    const dir = tempDir('cw-start-notices-')
    const wsPath = join(dir, 'ws')
    const project = join(wsPath, 'alpha')
    // HB6 left that conversation (its last is s-hb6 now), as the user's had by 01:00; Worker and Builder are on theirs.
    const agents = ['worker', 'builder', 'hb6']
    const ws = { path: wsPath, config: { advanced: {} }, isAssistantHome: () => false, info: () => ({ projects: [{ path: project, agents: agents.map((id) => ({ id, name: id, lastSessionId: `s-${id}` })) }] }), projectConfig: async () => ({ agents: agents.map((id) => ({ id, name: id })) }) }
    h.workspaces = [ws]
    const at = new Date().toISOString()
    const entry = (agentId: string, sessionId = `s-${agentId}`) => ({ workspace: wsPath, projectPath: project, project: 'alpha', agentId, agentName: agentId, provider: 'claude-code', sessionId, status: 'working', from: '0.0.0-before', at, state: 'pending', changedAt: at })
    const file = join(dir, 'restart.json')
    writeFileSync(file, JSON.stringify({ version: 1, reason: 'quit', entries: [entry('hb6', 's-old'), entry('worker'), entry('builder')] }))

    restart = await import('../src/main/restartResume')
    const events = await import('../src/main/events')
    const updater = await import('../src/main/updater')
    events.setToastTeller((t) => {
      h.toasts.push({ title: t.title, message: t.message, offer: t.offer, id: t.id })
      if (t.offer) h.openOffers.add(t.offer)
      return { id: t.id ?? `toast-${h.toasts.length}` }
    })
    restart.setTimingsForTests({ recordFile: file, readyMs: 300, stopMs: 50 })
    restart.loadRestartRecord(file)
    restart.initRestartRecovery()

    // As Combwork starts: the updater (its notice due in 4 s), the workspace's merge slots recovered (the queue decides),
    // then the window's start notices, and the workspace read again.
    updater.initUpdater({ restart: () => undefined })
    restart.workspaceRecovering(wsPath, Promise.resolve())
    await vi.waitFor(() => expect(restart!.restartRecord()?.entries.map((e) => e.state)).toEqual(['skipped', 'offered', 'offered']), { timeout: HUNG_MS })
    await restart.startRestartRecovery()
    events.emit({ type: 'workspace-changed', workspace: null })
    await vi.waitFor(() => expect(h.toasts.some((t) => /updated to/.test(t.title))).toBe(true), { timeout: HUNG_MS })
    // Both paths done: the queue has gone round since the last event, with none under way.
    const passes = restart.queueForTests().passes
    events.emit({ type: 'workspace-changed', workspace: null })
    await vi.waitFor(() => expect(restart!.queueForTests()).toMatchObject({ passes: expect.any(Number), pumping: false }), { timeout: HUNG_MS })
    await vi.waitFor(() => expect(restart!.queueForTests().passes).toBeGreaterThan(passes), { timeout: HUNG_MS })

    const updated = h.toasts.filter((t) => /updated to/.test(t.title))
    const offers = h.toasts.filter((t) => /Resume the .*working\?/.test(t.title))
    expect(updated.map((t) => t.title)).toEqual(['Combwork updated to 0.0.0-test'])
    expect(offers).toHaveLength(1)
    expect(offers[0].title).toBe('Resume the 2 agents that were working?')
    expect(offers[0].message).toContain('worker (alpha) and builder (alpha)')
    expect(offers[0].message).not.toContain('hb6')
    expect(h.resolved).toEqual([])
    expect(restart.restartRecord()?.entries.find((e) => e.agentId === 'hb6')).toMatchObject({ state: 'skipped', why: 'movedOn' })
  })
})
