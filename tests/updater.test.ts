// Update checks (src/main/updater.ts): a packaged Hive checks GitHub 30 s after it starts and every 6 hours; one a test
// started (HIVE_TEST_QUIET=1) never does, automatically or when asked (#1332), since each check counts as a download of
// the release's latest.yml. A downloaded update installs at the end of Hive's quit, or by Restart and Update, only over an
// older copy read from disk (#1647); a local build is offered, never given, a release of its own version.
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

const st = vi.hoisted(() => ({
  checks: 0,
  logged: [] as string[],
  handlers: {} as Record<string, (info: unknown) => void>,
  found: { isUpdateAvailable: false } as Record<string, unknown>,
  installs: [] as [boolean, boolean][],
  toasts: [] as { level: string; title: string; actions?: { label: string; command: string; args?: unknown[] }[] }[]
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (event: string, fn: (info: unknown) => void) => void (st.handlers[event] = fn),
    checkForUpdates: async () => {
      st.checks++
      return st.found
    },
    quitAndInstall: (silent: boolean, run: boolean) => void st.installs.push([silent, run])
  }
}))
vi.mock('../src/main/config', () => ({
  config: {
    settings: { updates: { checkAutomatically: true, downloadAutomatically: true, install: 'auto', prerelease: false } },
    onSettingsChanged: () => undefined,
    get: () => ({ lastRunVersion: '0.0.0-test' }),
    update: () => undefined
  }
}))
vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: (level: string, title: string, _message: string, actions?: never) => void st.toasts.push({ level, title, actions }) }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: (m: string) => st.logged.push(m), warn: () => undefined, error: () => undefined }) }))

const saved = { quiet: process.env.HIVE_TEST_QUIET, delay: process.env.HIVE_UPDATE_DELAY }
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  st.checks = 0
  st.logged = []
  st.handlers = {}
  st.found = { isUpdateAvailable: false }
  st.installs = []
  st.toasts = []
  delete process.env.HIVE_UPDATE_DELAY
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = true
})
afterEach(async () => {
  vi.useRealTimers()
  ;((await import('electron')).app as { isPackaged: boolean }).isPackaged = false
  for (const [k, v] of [['HIVE_TEST_QUIET', saved.quiet], ['HIVE_UPDATE_DELAY', saved.delay]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('update checks', () => {
  it('a packaged Hive checks 30 s after it starts, then every 6 hours', async () => {
    delete process.env.HIVE_TEST_QUIET
    const updater = await import('../src/main/updater')
    updater.initUpdater({ restart: () => undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(st.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(st.checks).toBe(2)
  })

  it('a packaged Hive a test started (HIVE_TEST_QUIET=1) never checks, and says so (#1332)', async () => {
    process.env.HIVE_TEST_QUIET = '1'
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
  const base = tempDir('hive-updater-')
  let n = 0
  /** A packaged Hive whose install folder's resources are a stand-in (what it reads as the copy on disk), started. */
  const start = async (copy: { version?: string; identity?: unknown }) => {
    const resources = fakeInstall(join(base, `r${++n}`), copy)
    ;(process as { resourcesPath?: string }).resourcesPath = resources
    const electron = (await import('electron')).app as unknown as { quit?: () => void }
    const quits = { n: 0 }
    electron.quit = () => void quits.n++
    process.env.HIVE_TEST_QUIET = '0'
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
    expect(updater.installsOnQuit()).toBe(true)
    updater.installNow(false)
    expect(st.installs).toEqual([[true, false]])
    updater.restartAndInstall()
    expect(restarts.n).toBe(1)
  })

  it('over a local build of its own version: neither the quit nor Restart and Update installs it, and Hive says why', async () => {
    const { updater, quits, restarts } = await start({ version: '9.1.1', identity: { version: '9.1.1', commit: 'abc1234', local: true } })
    downloaded(updater)
    expect(updater.installsOnQuit()).toBe(false)
    expect(updater.updateState().notInstalled).toBe('notNewer')
    updater.restartAndInstall()
    expect(restarts.n).toBe(0)
    expect(st.toasts.at(-1)).toMatchObject({ level: 'warning', title: "Hive Desktop 9.1.1 wasn't installed" })
    // Reached anyway (asked before the copy changed): quits without installing.
    updater.installNow(true)
    expect(st.installs).toEqual([])
    expect(quits.n).toBe(1)
  })

  it('over a copy that can\'t be read: never installed', async () => {
    const { updater } = await start({ identity: { version: '9.1.0', local: false } })
    downloaded(updater)
    expect(updater.installsOnQuit()).toBe(false)
    expect(updater.updateState().notInstalled).toBe('unreadable')
  })

  it('the copy read when it installs, not when it was downloaded: a local build installed meanwhile stays', async () => {
    const { updater, resources, quits } = await start({ version: '9.1.0' })
    downloaded(updater)
    expect(updater.installsOnQuit()).toBe(true)
    // A local 9.1.2 installed over it before the quit ends (another Hive's quit, say).
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
