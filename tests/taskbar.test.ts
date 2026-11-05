import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { badgeDescription, badgeText, shouldFlash, windowTitle } from '../src/shared/taskbar'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { HiveEvent, SessionStatus } from '../src/shared/types'

// Each project's window, a stand-in recording its taskbar flashes (main/taskbar.ts finds it by path).
const windows = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../src/main/windows', () => ({ windowForPath: (p: string) => (windows.has(p) ? { win: windows.get(p) } : null) }))

describe('taskbar button', () => {
  it('the badge: nothing at 0, the number, 9+ above 9', () => {
    expect([0, 1, 9, 10, 42].map(badgeText)).toEqual(['', '1', '9', '9+', '9+'])
    expect(badgeDescription(1)).toBe('1 needs you')
    expect(badgeDescription(3)).toBe('3 need you')
  })

  it('the title starts with the count when there is one', () => {
    expect(windowTitle('alpha — work — Combwork', 2)).toBe('(2) alpha — work — Combwork')
    expect(windowTitle('work — Combwork', 0)).toBe('work — Combwork')
  })

  it('flashes when an agent comes to ask you something while the window is in the background, not on repeats', () => {
    // Asked: waiting, or a question it works on beside (asksYou); finishing isn't asking.
    expect(shouldFlash(false, true, false, true)).toBe(true)
    expect(shouldFlash(true, true, false, true)).toBe(false)
    expect(shouldFlash(false, false, false, true)).toBe(false)
    expect(shouldFlash(false, true, true, true)).toBe(false)
    expect(shouldFlash(false, true, false, false)).toBe(false)
  })
})

// main/taskbar.ts itself, fed the events SessionManager and Settings send.
describe('the taskbar button flashing', () => {
  class FakeWindow extends EventEmitter {
    focused = false
    destroyed = false
    flashes: boolean[] = []
    flashFrame(on: boolean): void {
      this.flashes.push(on)
    }
    isFocused(): boolean {
      return this.focused
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
  let stop: () => void
  let emit: (e: HiveEvent) => void
  const status = (project: string, agentId: string, s: SessionStatus) =>
    emit({ type: 'session-status', state: { provider: 'claude-code', runId: 'r', projectPath: project, agentId, cwd: project, sessionId: '', status: s, startedAt: '', launchSignature: '', unseen: false } })
  const flashSetting = async (on: boolean) => {
    const { config } = await import('../src/main/config')
    config.settings.notifications.flashOnWaiting = on
    emit({ type: 'settings-changed', settings: config.settings })
  }
  const win = (project: string): FakeWindow => {
    const w = new FakeWindow()
    windows.set(project, w)
    return w
  }

  beforeEach(async () => {
    windows.clear()
    ;({ emit } = await import('../src/main/events'))
    stop = (await import('../src/main/taskbar')).startTaskbarFlash()
    await flashSetting(true)
  })
  afterEach(async () => {
    stop()
    const { config } = await import('../src/main/config')
    config.settings.notifications.flashOnWaiting = DEFAULT_SETTINGS.notifications.flashOnWaiting
  })

  it('an agent comes to wait in a background window: it flashes until the window is focused; finishing never does', () => {
    const w = win('C:/ws/alpha')
    status('C:/ws/alpha', 'a1', 'working')
    status('C:/ws/alpha', 'a1', 'finished')
    expect(w.flashes).toEqual([])
    status('C:/ws/alpha', 'a1', 'waiting')
    status('C:/ws/alpha', 'a2', 'waiting')
    expect(w.flashes).toEqual([true, true])
    w.focused = true
    w.emit('focus')
    expect(w.flashes).toEqual([true, true, false])
    // Its listeners went with it: a later focus stops nothing.
    w.emit('focus')
    expect([w.flashes.length, w.listenerCount('focus'), w.listenerCount('closed')]).toEqual([3, 0, 0])
  })

  it('turning the setting off stops a flash under way, and no later wait flashes', async () => {
    const alpha = win('C:/ws/alpha')
    const beta = win('C:/ws/beta')
    status('C:/ws/alpha', 'a1', 'waiting')
    await flashSetting(false)
    expect(alpha.flashes).toEqual([true, false])
    expect([alpha.listenerCount('focus'), alpha.listenerCount('closed')]).toEqual([0, 0])
    status('C:/ws/beta', 'b1', 'waiting')
    status('C:/ws/alpha', 'a2', 'waiting')
    expect([alpha.flashes, beta.flashes]).toEqual([[true, false], []])
    // On again: the next wait flashes, in its own window only.
    await flashSetting(true)
    status('C:/ws/beta', 'b2', 'waiting')
    expect([alpha.flashes, beta.flashes]).toEqual([[true, false], [true]])
  })

  it('other setting changes leave a flash alone; a closed window is forgotten', async () => {
    const w = win('C:/ws/alpha')
    status('C:/ws/alpha', 'a1', 'waiting')
    await flashSetting(true)
    expect(w.flashes).toEqual([true])
    w.destroyed = true
    w.emit('closed')
    await flashSetting(false)
    expect([w.flashes, w.listenerCount('focus')]).toEqual([[true], 0])
  })
})
