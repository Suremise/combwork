// Windows ending the session (shutdown, restart, sign-out): every running session's transcript is backed up before
// the callback returns, bytes only (no reading of usage or cost), within its time; and power.ts saves once per notice
// however many windows get it, with session-end catching up on what was written since query-session-end.
import { EventEmitter } from 'events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tempDir, tempRoot } from './tempDir'

// A slow disk: each synchronous write takes this long.
const slow = vi.hoisted(() => ({ ms: 0 }))
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    writeSync: (fd: number, buf: Buffer, off: number, len: number, pos: number): number => {
      for (const end = Date.now() + slow.ms; Date.now() < end; );
      return fs.writeSync(fd, buf, off, len, pos)
    }
  }
})

const SID = '0f5c2a8e-1111-4222-8333-944455556666'
const SID2 = '0f5c2a8e-1111-4222-8333-944455557777'

describe('sessions.backupAllNow', () => {
  async function hive() {
    vi.resetModules()
    const profile = tempDir('cw-shutdown-')
    const electron = await import('electron')
    ;(electron.app as unknown as { getPath: () => string }).getPath = () => profile
    const { sessions } = await import('../src/main/sessions')
    const { config } = await import('../src/main/config')
    const project = join(profile, 'alpha')
    mkdirSync(project)
    const live = (sessions as unknown as { live: Map<string, unknown> }).live
    const add = (agentId: string, sessionId: string, transcriptPath?: string): void =>
      void live.set(`${project}#${agentId}`, { state: { projectPath: project, agentId, sessionId, status: 'working' }, transcriptPath })
    const backup = (sessionId: string): string => readFileSync(join(project, '.combwork', 'sessions', `${sessionId}.jsonl`), 'utf8')
    return { sessions, config, profile, add, backup }
  }

  it('backs up each transcript before it returns, without reading it for usage or cost', async () => {
    const { sessions, profile, add, backup } = await hive()
    const t = join(profile, 'one.jsonl')
    writeFileSync(t, '{"a":1}\n')
    add('a1', SID, t)
    // A transcript Combwork hasn't found yet: left out, and counted.
    add('a2', SID2)
    const parse = vi.spyOn(sessions as unknown as { transcriptChanged: () => Promise<void> }, 'transcriptChanged')
    expect(sessions.backupAllNow(2000)).toEqual({ saved: 1, incomplete: 0, skipped: 1, failed: 0 })
    expect(backup(SID)).toBe('{"a":1}\n')
    appendFileSync(t, '{"a":2}\n')
    expect(sessions.backupAllNow(1000).saved).toBe(1)
    expect(backup(SID)).toBe('{"a":1}\n{"a":2}\n')
    expect(parse).not.toHaveBeenCalled()
  })

  it('counts a failure, and leaves out what is past its time', async () => {
    const { sessions, profile, add } = await hive()
    add('a1', SID, join(profile, 'missing.jsonl'))
    expect(sessions.backupAllNow(2000)).toEqual({ saved: 0, incomplete: 0, skipped: 0, failed: 1 })
    const t = join(profile, 'two.jsonl')
    writeFileSync(t, '{}\n')
    add('a2', SID2, t)
    expect(sessions.backupAllNow(0)).toEqual({ saved: 0, incomplete: 0, skipped: 2, failed: 0 })
  })

  describe('on a slow disk', () => {
    afterEach(() => void (slow.ms = 0))

    it("stops at its time: a copy it can't finish is incomplete, and the next session isn't tried", async () => {
      const { sessions, profile, add } = await hive()
      for (const [agent, sid] of [['a1', SID], ['a2', SID2]]) {
        const t = join(profile, `${agent}.jsonl`)
        writeFileSync(t, Buffer.alloc(8 * 1024 * 1024, 'x'))
        add(agent, sid, t)
      }
      slow.ms = 60
      const t = Date.now()
      expect(sessions.backupAllNow(20)).toEqual({ saved: 0, incomplete: 1, skipped: 1, failed: 0 })
      // One 1 MB step of 60 ms past the budget, not 16 of them.
      expect(Date.now() - t).toBeLessThan(250)
      // The copy it couldn't finish isn't put in place.
      expect(existsSync(join(profile, 'alpha', '.combwork', 'sessions', `${SID}.jsonl`))).toBe(false)
    })
  })

  it('does nothing with transcript backups turned off', async () => {
    const { sessions, config, profile, add } = await hive()
    const t = join(profile, 'three.jsonl')
    writeFileSync(t, '{}\n')
    add('a1', SID, t)
    config.settings.sessions.backupTranscripts = false
    expect(sessions.backupAllNow(2000)).toEqual({ saved: 0, incomplete: 0, skipped: 0, failed: 0 })
  })
})

describe('power: Windows ending the session', () => {
  async function power() {
    vi.resetModules()
    const windows = [new EventEmitter(), new EventEmitter()]
    const powerMonitor = Object.assign(new EventEmitter(), { isOnBatteryPower: () => false })
    const app = Object.assign(new EventEmitter(), { getPath: () => tempRoot() })
    vi.doMock('electron', () => ({ app, powerMonitor, powerSaveBlocker: { start: () => 1, stop: () => undefined }, BrowserWindow: { getAllWindows: () => windows } }))
    // Each save's budget, noted as it runs: one already here when emit returns ran inside the callback.
    const saves: number[] = []
    vi.doMock('../src/main/sessions', () => ({
      sessions: { liveStates: () => [], backupAllNow: (budget: number) => (saves.push(budget), { saved: 1, skipped: 0, failed: 0 }) }
    }))
    vi.doMock('../src/main/config', () => ({ config: { settings: { general: { keepAwake: 'plugged-in' } }, onSettingsChanged: () => undefined } }))
    vi.doMock('../src/main/events', () => ({ emit: () => undefined, onCombworkEvent: () => undefined }))
    vi.doMock('../src/main/workspace', () => ({ openWorkspaces: () => [] }))
    vi.doMock('../src/main/logger', () => ({ createLogger: () => ({ info: () => undefined, warn: () => undefined }) }))
    const mod = await import('../src/main/power')
    mod.startPowerWatch()
    return { windows, saves, budgets: mod.SHUTDOWN_BUDGET_MS }
  }

  it('saves once per notice for all windows, done when the callback returns; session-end catches up', async () => {
    const { windows, saves, budgets } = await power()
    for (const w of windows) w.emit('query-session-end', { preventDefault: () => undefined })
    expect(saves).toEqual([budgets['query-session-end']])
    for (const w of windows) w.emit('session-end', {})
    expect(saves).toEqual([budgets['query-session-end'], budgets['session-end']])
    // Well inside the ~5 s Windows waits before offering to end an app: shutdown isn't held up.
    expect(budgets['query-session-end'] + budgets['session-end']).toBeLessThan(5000)
  })

  it('never cancels the shutdown; one cancelled by another app leaves the next one to save again', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T18:00:00Z') })
    try {
      const { windows, saves } = await power()
      const preventDefault = vi.fn()
      windows[0].emit('query-session-end', { preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
      // No session-end: the shutdown was cancelled. A minute later Windows asks again.
      vi.setSystemTime(new Date('2026-10-02T18:01:00Z'))
      windows[1].emit('query-session-end', { preventDefault })
      expect(saves).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
