// Update checks (src/main/updater.ts): a packaged Hive checks GitHub 30 s after it starts and every 6 hours; one a test
// started (HIVE_TEST_QUIET=1) never does, automatically or when asked (#1332), since each check counts as a download of
// the release's latest.yml.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const st = vi.hoisted(() => ({ checks: 0, logged: [] as string[] }))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: () => undefined,
    checkForUpdates: async () => {
      st.checks++
      return { isUpdateAvailable: false }
    }
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
vi.mock('../src/main/events', () => ({ emit: () => undefined, toast: () => undefined }))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: (m: string) => st.logged.push(m), warn: () => undefined, error: () => undefined }) }))

const saved = { quiet: process.env.HIVE_TEST_QUIET, delay: process.env.HIVE_UPDATE_DELAY }
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  st.checks = 0
  st.logged = []
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
