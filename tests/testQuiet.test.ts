// Quiet test copies (src/main/testQuiet.ts): an unpackaged Combwork with a test profile (CW_USER_DATA) or CW_TEST_QUIET=1
// shows windows without taking the focus and records Windows notifications instead of showing them; otherwise, or with
// CW_TEST_QUIET=0, everything is as normal. Every e2e suite and scenario starts its copy with a test profile.
import { readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepOffScreen, offScreenOrigin, presentWindow, showOsNotification, takesTestSeams, testNotifyLog, testQuiet } from '../src/main/testQuiet'
import { testTipsOff } from '../src/main/config'
import { tempDir, tempRoot } from './tempDir'

// Two screens side by side: one at the origin, one to its left.
vi.mock('electron', async (original) => ({
  ...(await original<typeof import('electron')>()),
  screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }, { bounds: { x: -1920, y: 200, width: 1920, height: 1080 } }] }
}))

const saved = { quiet: process.env.CW_TEST_QUIET, log: process.env.CW_TEST_NOTIFY_LOG, profile: process.env.CW_USER_DATA }
beforeEach(() => {
  delete process.env.CW_USER_DATA
})
afterEach(() => {
  for (const [k, v] of [['CW_TEST_QUIET', saved.quiet], ['CW_TEST_NOTIFY_LOG', saved.log], ['CW_USER_DATA', saved.profile]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const fakeWindow = (minimized = false) => ({ isMinimized: vi.fn(() => minimized), restore: vi.fn(), show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() })

describe('quiet test copies', () => {
  it('with CW_TEST_QUIET=1, or a test profile unless CW_TEST_QUIET=0', () => {
    delete process.env.CW_TEST_QUIET
    expect(testQuiet()).toBe(false)
    process.env.CW_TEST_QUIET = '0'
    expect(testQuiet()).toBe(false)
    process.env.CW_TEST_QUIET = '1'
    expect(testQuiet()).toBe(true)
    // A test profile: quiet however the copy was started (a suite run on its own, a script), unless turned off.
    process.env.CW_USER_DATA = join(tempRoot(), 'quiet-profile')
    delete process.env.CW_TEST_QUIET
    expect(testQuiet()).toBe(true)
    process.env.CW_TEST_QUIET = '0'
    expect(testQuiet()).toBe(false)
  })

  it('a packaged build is quiet only with CW_TEST_QUIET=1, never for its test profile alone (#1253)', async () => {
    const { app } = await import('electron')
    const packaged = app as { isPackaged: boolean }
    packaged.isPackaged = true
    try {
      process.env.CW_USER_DATA = join(tempRoot(), 'quiet-profile')
      delete process.env.CW_TEST_QUIET
      expect(testQuiet()).toBe(false)
      process.env.CW_TEST_QUIET = '0'
      expect(testQuiet()).toBe(false)
      // The packaged suites' copies: combworkEnv sets it.
      process.env.CW_TEST_QUIET = '1'
      expect(testQuiet()).toBe(true)
    } finally {
      packaged.isPackaged = false
    }
  })

  it("takes the every-copy test seams (tips off, the notify log, the trash folder) unpackaged or quiet, never as the installed app (#1599)", () => {
    // Unpackaged: always, as before.
    expect(takesTestSeams({}, false)).toBe(true)
    expect(testTipsOff({ CW_TEST_TIPS: 'off' }, false)).toBe(true)
    expect(testTipsOff({}, false)).toBe(false)
    // Packaged: only a copy a test started quiet.
    expect(takesTestSeams({ CW_TEST_QUIET: '1' }, true)).toBe(true)
    expect(testTipsOff({ CW_TEST_TIPS: 'off', CW_TEST_QUIET: '1' }, true)).toBe(true)
    // The installed app is never quiet: unchanged, whatever else its environment says.
    for (const env of [{}, { CW_TEST_QUIET: '0' }, { CW_USER_DATA: 'C:\\p' }]) {
      expect(takesTestSeams(env, true)).toBe(false)
      expect(testTipsOff({ ...env, CW_TEST_TIPS: 'off' }, true)).toBe(false)
    }
  })

  it('every e2e suite and scenario starts Combwork with a test profile, and none turns quiet off', () => {
    // A suite that needs a real window (one taking the focus, a native maximise) turns quiet off: list it here.
    const LOUD = ['tests/e2e/carddialog.cjs'] // only with CW_E2E_NATIVE=1, its native maximise check
    const root = join(__dirname, '..')
    const files = ['tests/e2e', 'tests/scenarios'].flatMap((d) => readdirSync(join(root, d)).filter((f) => /\.(c|m)?js$/.test(f)).map((f) => `${d}/${f}`))
    const launching = files.filter((f) => readFileSync(join(root, f), 'utf8').includes('_electron.launch('))
    expect(launching.length).toBeGreaterThan(50)
    for (const f of launching) {
      const text = readFileSync(join(root, f), 'utf8')
      expect(text.includes('CW_USER_DATA'), `${f} starts Combwork without a test profile (CW_USER_DATA)`).toBe(true)
      expect(/CW_TEST_QUIET\W{1,6}['"]?0/.test(text) && !LOUD.includes(f), `${f} turns quiet off: add it to LOUD if it must`).toBe(false)
    }
  })

  it('a window is brought up without the focus when quiet, and shown and focused otherwise', () => {
    process.env.CW_TEST_QUIET = '1'
    const quiet = fakeWindow(true)
    presentWindow(quiet as never)
    expect(quiet.restore).toHaveBeenCalled()
    expect(quiet.showInactive).toHaveBeenCalled()
    expect(quiet.show).not.toHaveBeenCalled()
    expect(quiet.focus).not.toHaveBeenCalled()
    delete process.env.CW_TEST_QUIET
    const normal = fakeWindow()
    presentWindow(normal as never)
    expect(normal.show).toHaveBeenCalled()
    expect(normal.focus).toHaveBeenCalled()
    expect(normal.showInactive).not.toHaveBeenCalled()
  })

  it('a notification is recorded, and shown only when not quiet', () => {
    const dir = tempDir('cw-quiet-')
    try {
      const log = join(dir, 'notify.log')
      process.env.CW_TEST_NOTIFY_LOG = log
      process.env.CW_TEST_QUIET = '1'
      const quiet = { show: vi.fn() }
      expect(showOsNotification(quiet as never, 'One finished', 'alpha')).toBe(false)
      expect(quiet.show).not.toHaveBeenCalled()
      delete process.env.CW_TEST_QUIET
      const shown = { show: vi.fn() }
      expect(showOsNotification(shown as never, 'Two finished', 'beta')).toBe(true)
      expect(shown.show).toHaveBeenCalled()
      testNotifyLog({ kind: 'flash', on: true })
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(lines.map(({ at: _at, ...e }) => e)).toEqual([
        { kind: 'notification', title: 'One finished', body: 'alpha' },
        { kind: 'notification', title: 'Two finished', body: 'beta' },
        { kind: 'flash', on: true }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('without a log file set, nothing is written and nothing breaks', () => {
    delete process.env.CW_TEST_NOTIFY_LOG
    expect(() => testNotifyLog({ kind: 'chime' })).not.toThrow()
  })

  it('test windows open far left of every screen, even as wide as a screen', () => {
    const at = offScreenOrigin(1400)
    expect(at.y).toBe(0)
    expect(at.x + 1400).toBeLessThan(-1920)
    // Widened to a screen's width where it is: still off every screen.
    expect(at.x + 2560).toBeLessThan(-1920)
  })

  it('a test window moved or resized onto a screen goes straight back off', () => {
    const handlers: Record<string, () => void> = {}
    let bounds = { x: -12000, y: 0, width: 1400, height: 850 }
    const win = { isDestroyed: () => false, getBounds: () => bounds, on: (e: string, f: () => void) => (handlers[e] = f), setPosition: vi.fn((x: number, y: number) => (bounds = { ...bounds, x, y })) }
    keepOffScreen(win as never)
    // Still off screen: left alone.
    handlers.resize()
    expect(win.setPosition).not.toHaveBeenCalled()
    // Made 12000 wide: its right edge reaches the left screen. Moved back off.
    bounds = { ...bounds, width: 12000 }
    handlers.resize()
    expect(win.setPosition).toHaveBeenCalledTimes(1)
    expect(bounds.x + bounds.width).toBeLessThan(-1920)
    // Moved onto the main screen: moved back off.
    bounds = { x: 100, y: 100, width: 1400, height: 850 }
    handlers.move()
    expect(bounds.x + bounds.width).toBeLessThan(-1920)
  })
})
