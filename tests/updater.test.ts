// Update checks (src/main/updater.ts): a packaged Combwork checks GitHub 30 s after it starts and every 6 hours; one a test
// started (CW_TEST_QUIET=1) never does, automatically or when asked (#1332), since each check counts as a download of
// the release's latest.yml. A downloaded update installs at the end of Combwork's quit, or by Restart and Update, only over an
// older copy read from disk (#1647); a local build is offered, never given, a release of its own version.
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const st = vi.hoisted(() => ({
  checks: 0,
  logged: [] as string[],
  warned: [] as string[],
  handlers: {} as Record<string, (info: unknown) => void>,
  found: { isUpdateAvailable: false } as Record<string, unknown>,
  installs: [] as [boolean, boolean][],
  feeds: [] as Record<string, unknown>[],
  updates: { checkAutomatically: true, downloadAutomatically: true, install: 'auto', prerelease: false },
  settingsChanged: [] as ((s: unknown, prev: unknown) => void)[],
  toasts: [] as { level: string; title: string; actions?: { label: string; command: string; args?: unknown[] }[] }[],
  resolved: [] as [string, string][]
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (event: string, fn: (info: unknown) => void) => void (st.handlers[event] = fn),
    checkForUpdates: async () => {
      st.checks++
      return st.found
    },
    quitAndInstall: (silent: boolean, run: boolean) => void st.installs.push([silent, run]),
    setFeedURL: (options: Record<string, unknown>) => void st.feeds.push(options)
  }
}))
vi.mock('../src/main/config', () => ({
  config: {
    get settings() {
      return { updates: st.updates }
    },
    onSettingsChanged: (fn: (s: unknown, prev: unknown) => void) => void st.settingsChanged.push(fn),
    get: () => ({ lastRunVersion: '0.0.0-test' }),
    update: () => undefined
  }
}))
// The offers' registry: what the notices' buttons resolve to (HI-2425).
vi.mock('../src/main/notify', () => ({ resolveOffer: (offer: string, outcome: string) => (st.resolved.push([offer, outcome]), true), resolveOffers: () => 0 }))
vi.mock('../src/main/events',() => ({ emit: () => undefined, toast: (level: string, title: string, _message: string, actions?: never) => void st.toasts.push({ level, title, actions }) }))
vi.mock('../src/main/logger', async (original) => ({ ...(await original<typeof import('../src/main/logger')>()), createLogger: () => ({ info: (m: string) => st.logged.push(m), warn: (m: string) => st.warned.push(m), error: () => undefined }) }))

const saved = { quiet: process.env.CW_TEST_QUIET, delay: process.env.CW_UPDATE_DELAY }
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  st.checks = 0
  st.logged = []
  st.warned = []
  st.handlers = {}
  st.found = { isUpdateAvailable: false }
  st.installs = []
  st.feeds = []
  st.updates = { checkAutomatically: true, downloadAutomatically: true, install: 'auto', prerelease: false }
  st.settingsChanged = []
  st.toasts = []
  st.resolved = []
  delete process.env.CW_UPDATE_DELAY
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = true
})
afterEach(async () => {
  vi.useRealTimers()
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = false
  for (const [k, v] of [['CW_TEST_QUIET', saved.quiet], ['CW_UPDATE_DELAY', saved.delay]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('update checks', () => {
  it('a packaged Combwork checks 30 s after it starts, then every 6 hours', async () => {
    delete process.env.CW_TEST_QUIET
    const updater = await import('../src/main/updater')
    updater.initUpdater({ restart: () => undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(st.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(st.checks).toBe(2)
  })

  it('automatic checks turned off before the first one: none runs; turned on again: one at once, then every 6 hours (HI-2324)', async () => {
    delete process.env.CW_TEST_QUIET
    const updater = await import('../src/main/updater')
    updater.initUpdater({ restart: () => undefined })
    const change = (checkAutomatically: boolean): void => {
      const prev = { updates: st.updates }
      st.updates = { ...st.updates, checkAutomatically }
      for (const fn of st.settingsChanged) fn({ updates: st.updates }, prev)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    change(false)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 30_000)
    expect(st.checks).toBe(0)
    // A manual check still runs.
    await updater.check(true)
    expect(st.checks).toBe(1)
    change(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(st.checks).toBe(2)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(st.checks).toBe(3)
  })

  it('automatic checks turned off and on again before the first one: one check at once, not a second at 30 s (HI-2324)', async () => {
    delete process.env.CW_TEST_QUIET
    ;(await import('../src/main/updater')).initUpdater({ restart: () => undefined })
    const change = (checkAutomatically: boolean): void => {
      const prev = { updates: st.updates }
      st.updates = { ...st.updates, checkAutomatically }
      for (const fn of st.settingsChanged) fn({ updates: st.updates }, prev)
    }
    change(false)
    change(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(st.checks).toBe(1)
  })

  it("a packaged Combwork reads GitHub's releases through Combwork's provider (HI-2311); a development build sets no feed", async () => {
    delete process.env.CW_TEST_QUIET
    const { CombworkGitHubProvider } = await import('../src/main/updateFeed')
    ;(await import('../src/main/updater')).initUpdater({ restart: () => undefined })
    expect(st.feeds).toEqual([{ provider: 'custom', updateProvider: CombworkGitHubProvider, owner: 'Suremise', repo: 'combwork' }])
    vi.resetModules()
    st.feeds = []
    ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = false
    ;(await import('../src/main/updater')).initUpdater({ restart: () => undefined })
    expect(st.feeds).toEqual([])
  })

  it('a packaged Combwork a test started (CW_TEST_QUIET=1) never checks, and says so (#1332)', async () => {
    process.env.CW_TEST_QUIET = '1'
    const updater = await import('../src/main/updater')
    updater.initUpdater({ restart: () => undefined })
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    expect(st.checks).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(st.logged.some((l) => /test copy.*no update checks/i.test(l))).toBe(true)
    // Asked from Settings → Updates: still none, and the reason is shown.
    const state = await updater.check(true)
    expect(st.checks).toBe(0)
    expect(state.status).toBe('disabled')
  })
})

describe('installing a downloaded update (#1647)', () => {
  // oxlint-disable-next-line typescript/no-require-imports -- the e2e suites' CommonJS helper, shared with them
  const { fakeInstall } = require('./e2e/fakeInstall.cjs') as { fakeInstall: (dir: string, o?: { version?: string; identity?: unknown }) => string }
  const base = tempDir('cw-updater-')
  let n = 0
  /** A packaged Combwork whose install folder's resources are a stand-in (what it reads as the copy on disk), started. */
  const start = async (copy: { version?: string; identity?: unknown }) => {
    const resources = fakeInstall(join(base, `r${++n}`), copy)
    ;(process as { resourcesPath?: string }).resourcesPath = resources
    const electron = (await import('electron')).app as unknown as { quit?: () => void }
    const quits = { n: 0 }
    electron.quit = () => void quits.n++
    process.env.CW_TEST_QUIET = '0'
    const updater = await import('../src/main/updater')
    const restarts = { n: 0 }
    updater.initUpdater({ restart: () => void restarts.n++ })
    return { updater, resources, quits, restarts }
  }
  /** 9.1.1 found and downloaded, as electron-updater tells it. */
  const downloaded = (updater: Awaited<ReturnType<typeof start>>['updater']) => {
    st.handlers['update-available']({ version: '9.1.1', files: [] })
    st.handlers['update-downloaded']({ version: '9.1.1' })
    expect(updater.updateState().status).toBe('ready')
  }

  it('over an older copy: the quit installs it (no restart), Restart and Update too (with one)', async () => {
    const { updater, restarts } = await start({ version: '9.1.0' })
    downloaded(updater)
    expect(st.toasts.map((t) => t.title)).toEqual(['Combwork 9.1.1 is ready'])
    expect(updater.installsOnQuit()).toBe(true)
    updater.installNow(false)
    expect(st.installs).toEqual([[true, false]])
    updater.restartAndInstall()
    expect(restarts.n).toBe(1)
  })

  it("Restart and Update keeps its notice's button until the quit goes ahead: then it says Installing (HI-2425)", async () => {
    const { updater, restarts } = await start({ version: '9.1.0' })
    downloaded(updater)
    // Clicked: the quit is asked for, and may still be cancelled (agents working, unsaved files), so nothing is resolved.
    updater.restartAndInstall('9.1.1')
    expect(restarts.n).toBe(1)
    expect(st.resolved).toEqual([])
    // The quit goes ahead (index.ts quitNow): now the notice says Installing in place of its button.
    updater.markInstalling()
    expect(st.resolved).toEqual([['update:9.1.1', 'Installing: Combwork restarts']])
    // An older version's click resolves its own entry and asks for nothing.
    updater.restartAndInstall('9.0.0')
    expect(restarts.n).toBe(1)
    expect(st.resolved.at(-1)?.[0]).toBe('update:9.0.0')
  })

  it('over a local build of its own version: neither the quit nor Restart and Update installs it, and Combwork says why', async () => {
    const { updater, quits, restarts } = await start({ version: '9.1.1', identity: { version: '9.1.1', commit: 'abc1234', local: true } })
    downloaded(updater)
    // Never told it is ready to install: the state says why not, from the download on.
    expect(st.toasts).toEqual([])
    expect(updater.updateState().notInstalled).toBe('notNewer')
    expect(updater.installsOnQuit()).toBe(false)
    expect(updater.updateState().notInstalled).toBe('notNewer')
    updater.restartAndInstall()
    expect(restarts.n).toBe(0)
    expect(st.toasts.at(-1)).toMatchObject({ level: 'warning', title: "Combwork 9.1.1 wasn't installed" })
    // Reached anyway (asked before the copy changed): quits without installing.
    updater.installNow(true)
    expect(st.installs).toEqual([])
    expect(quits.n).toBe(1)
  })

  it("over a copy that can't be read: never installed, and its path is left out of diagnostics", async () => {
    const { updater, resources } = await start({ identity: { version: '9.1.0', local: false } })
    downloaded(updater)
    expect(updater.installsOnQuit()).toBe(false)
    expect(updater.updateState().notInstalled).toBe('unreadable')
    // The read's error quotes the install folder (one the user chose, outside home and workspaces): Help → Copy
    // Diagnostics leaves it out.
    const line = st.warned.find((w) => w.startsWith('Not installing 9.1.1'))!
    expect(line).toContain(resources)
    const { redactLog } = await import('../src/shared/redact')
    expect(redactLog(`2026-10-26T00:00:00.000Z [WARN] [updates] ${line}`, { home: 'C:\\Users\\nobody', folders: [], names: [] })).not.toContain(resources)
  })

  it('a refusal for a copy unreadable then is lifted once it reads older: Check Now and Restart and Update go on; the same or newer still refuse', async () => {
    const { updater, resources, restarts } = await start({ identity: { version: '9.1.0', local: false } })
    downloaded(updater)
    updater.restartAndInstall()
    expect(restarts.n).toBe(0)
    expect(updater.updateState().notInstalled).toBe('unreadable')
    // The other installer finished: an older copy, readable.
    fakeInstall(resources, { version: '9.1.0', identity: { version: '9.1.0', commit: null, local: false } })
    await updater.check(true)
    expect(updater.updateState()).toMatchObject({ status: 'ready', notInstalled: undefined })
    updater.restartAndInstall()
    expect(restarts.n).toBe(1)
    // A local build of its version, or newer, installed instead: refused again, on the check and on Restart and Update.
    for (const version of ['9.1.1', '9.2.0']) {
      fakeInstall(resources, { version, identity: { version, commit: 'abc1234', local: true } })
      await updater.check(true)
      updater.restartAndInstall()
      expect(updater.updateState().notInstalled, version).toBe('notNewer')
      expect(restarts.n).toBe(1)
    }
  })

  it('the copy read when it installs, not when it was downloaded: a local build installed meanwhile stays', async () => {
    const { updater, resources, quits } = await start({ version: '9.1.0' })
    downloaded(updater)
    expect(updater.installsOnQuit()).toBe(true)
    // A local 9.1.2 installed over it before the quit ends (another Combwork's quit, say).
    fakeInstall(resources, { version: '9.1.2', identity: { version: '9.1.2', commit: 'abc1234', local: true } })
    updater.installNow(false)
    expect(st.installs).toEqual([])
    expect(quits.n).toBe(1)
    expect(updater.updateState().notInstalled).toBe('notNewer')
  })

  it("a local build and a release of its own version: offered by a notice (Open Release Page) once, never downloaded", async () => {
    const version = (await import('electron')).app.getVersion()
    st.found = { isUpdateAvailable: false, updateInfo: { version } }
    const { updater } = await start({ version, identity: { version, commit: 'abc1234def', local: true } })
    expect(updater.updateState().local).toEqual({ commit: 'abc1234def' })
    await updater.check(false)
    expect(updater.updateState()).toMatchObject({ status: 'up-to-date', published: version })
    expect(st.toasts).toHaveLength(1)
    expect(st.toasts[0].actions).toEqual([{ label: 'Open Release Page', command: 'update.releaseNotes', args: [version] }])
    await updater.check(false)
    expect(st.toasts).toHaveLength(1)
    // A release build of that version: nothing offered.
    vi.resetModules()
    const again = await start({ version })
    await again.updater.check(false)
    expect(again.updater.updateState().published).toBeUndefined()
  })
})
