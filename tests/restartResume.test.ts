// Restarts announced and resumed (HI-1707): the installer's request checked (for this process and copy, fresh, whole,
// once), the restart record's merge and what a start makes of it, the line a resumed agent is given, and Combwork's side of
// the request: taken once, acknowledged, never acted on when it is someone else's.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { atStart, checkRequest, mergeSnapshot, parseRecord, resumeNote, REQUEST_FILE, type RestartEntry, type RestartRecord, type RequestTarget } from '../src/shared/restartResume'
import { dropLoggerListenersAfterEach, loggerListenerCounts } from './loggerListeners'
import { tempDir } from './tempDir'

// A test that loads restartResume again (vi.resetModules) loads the logger again: what it listens to is taken off after it (HI-1728).
dropLoggerListenersAfterEach()
const listenersAtStart = loggerListenerCounts()
afterAll(() => {
  expect(loggerListenerCounts()).toEqual(listenersAtStart)
})

const HUNG_MS = 15_000
const NONCE = '0f8fad5b-d9cb-469f-a165-70867728950e'
const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const target = (o: Partial<RequestTarget> = {}): RequestTarget => ({ pid: 4242, startedAt: NOW - 3_600_000, exe: 'C:\\Programs\\Hive\\Hive.exe', now: NOW, seen: new Set(), ...o })
const request = (o: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, nonce: NONCE, pid: 4242, pidCreated: new Date(NOW - 3_600_000 + 800).toISOString(), exe: 'C:\\Programs\\Hive\\Hive.exe', reason: 'install', at: new Date(NOW - 2000).toISOString(), ...o })

describe("the installer's request to close (checkRequest)", () => {
  it('is taken when it names this process, its start, this copy, and is fresh', () => {
    const r = checkRequest(request(), target(), same)
    expect(r.ok).toBe(true)
  })

  it.each([
    ['too big', `${request()}${' '.repeat(5000)}`, /too big/],
    ['partial (cut off as it was written)', request().slice(0, 40), /malformed/],
    ['not a GUID nonce (it names files)', request({ nonce: '..\\..\\x' }), /its nonce/],
    ['another reason', request({ reason: 'update' }), /malformed/],
    ['for another process', request({ pid: 999 }), /another process/],
    ['for an earlier process with the same id', request({ pidCreated: new Date(NOW - 9_000_000).toISOString() }), /earlier process/],
    ['for another copy of Combwork', request({ exe: 'C:\\Other\\Hive.exe' }), /another copy/],
    ['stale', request({ at: new Date(NOW - 120_000).toISOString() }), /stale/]
  ])('is refused when %s', (_what, text, why) => {
    const r = checkRequest(text, target(), same)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.why).toMatch(why)
  })

  it('is refused as a replay once its nonce was handled', () => {
    const r = checkRequest(request(), target({ seen: new Set([NONCE]) }), same)
    expect(!r.ok && r.why).toMatch(/replay/)
  })
})

const entry = (o: Partial<RestartEntry>): RestartEntry => ({ workspace: 'C:\\ws', projectPath: 'C:\\ws\\alpha', project: 'alpha', agentId: 'a1', agentName: 'Coder', provider: 'claude-code', sessionId: 's1', status: 'working', from: '1.0.0-rc.4', at: new Date(NOW).toISOString(), state: 'pending', changedAt: new Date(NOW).toISOString(), ...o })

describe('the restart record', () => {
  it("keeps an earlier offer the user hasn't answered when Combwork closes again, replaces an agent's entry with its newer one, and takes the latest close's reason", () => {
    const before: RestartRecord = { version: 1, reason: 'quit', entries: [entry({ agentId: 'offered', state: 'offered' }), entry({ agentId: 'a1', sessionId: 'old', state: 'offered' }), entry({ agentId: 'done', state: 'resumed' })] }
    const after = mergeSnapshot(before, [entry({ agentId: 'a1', sessionId: 'new' }), entry({ agentId: 'a2' })], 'update')
    expect(after.reason).toBe('update')
    expect(after.entries.map((e) => [e.agentId, e.sessionId, e.state])).toEqual([
      ['offered', 's1', 'offered'],
      ['a1', 'new', 'pending'],
      ['a2', 's1', 'pending']
    ])
  })

  it('at a start: what the last run left queued or starting is pending again, and what waited over a day is skipped', () => {
    const r = atStart({ version: 1, reason: 'install', entries: [entry({ agentId: 'q', state: 'queued' }), entry({ agentId: 's', state: 'starting' }), entry({ agentId: 'old', state: 'offered', at: new Date(NOW - 25 * 3_600_000).toISOString() }), entry({ agentId: 'r', state: 'resumed' })] }, NOW)
    expect(r.entries.map((e) => [e.agentId, e.state, e.why ?? null])).toEqual([
      ['q', 'pending', null],
      ['s', 'pending', null],
      ['old', 'skipped', 'expired'],
      ['r', 'resumed', null]
    ])
    expect(r.reason).toBe('install')
  })

  it("a record with no reason it knows is a quit's: it offers, never resumes by itself on a guess", () => {
    expect(parseRecord(JSON.stringify({ version: 1, entries: [entry({})] }))?.reason).toBe('quit')
    expect(parseRecord(JSON.stringify({ version: 1, reason: 'update', entries: [entry({})] }))?.reason).toBe('update')
  })
})

describe('the line a resumed agent is given (resumeNote)', () => {
  it('says why, from which version to which and when, its card, round and lane, and to re-arm its watch', () => {
    const note = resumeNote(entry({ status: 'watching', card: { label: 'HI-1673', round: 2 }, lane: { id: 'lane-1', name: 'Lanes from the bottom', role: 'builder' }, at: '2026-10-26T10:00:00.000Z' }), '1.0.0-rc.5', 'install')
    expect(note).toBe("[CW] Combwork restarted for an update (1.0.0-rc.4 → 1.0.0-rc.5) at 10:00 UTC; your session was stopped and is resumed now. You were on HI-1673, round 2, in lane 'Lanes from the bottom' (its builder). Carry on: re-arm your card watch if you were waiting.")
  })

  it('after a quit, with no card or lane: why, and to carry on', () => {
    expect(resumeNote(entry({ from: '1.0.0', at: '2026-10-26T09:30:00.000Z' }), '1.0.0', 'quit')).toBe('[CW] Combwork was quit and started again at 09:30 UTC; your session was stopped and is resumed now. Carry on where you were.')
  })
})

describe("Combwork's side of the request (watchRestartRequests)", () => {
  const exe = (app as unknown as { getPath: (k: string) => string }).getPath('exe')
  const started = (): string => new Date(Date.now() - process.uptime() * 1000).toISOString()
  const write = (dir: string, o: Record<string, unknown> = {}): void => writeFileSync(join(dir, REQUEST_FILE), JSON.stringify({ v: 1, nonce: NONCE, pid: process.pid, pidCreated: started(), exe, reason: 'install', at: new Date().toISOString(), ...o }))

  it("removes one left from an earlier process at start without acting on it, then takes this process's once, acknowledged", async () => {
    vi.resetModules()
    const { watchRestartRequests, stopWatchingRestartRequests } = await import('../src/main/restartResume')
    const dir = tempDir('hive-restart-request-')
    write(dir, { pid: 1, nonce: '11111111-2222-4333-8444-555555555555' })
    const asked = vi.fn()
    watchRestartRequests(asked, dir)
    try {
      expect(existsSync(join(dir, REQUEST_FILE))).toBe(false)
      expect(asked).not.toHaveBeenCalled()
      write(dir)
      await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1), { timeout: HUNG_MS })
      expect(readdirSync(dir).sort()).toEqual([`restart-ack-${NONCE}.json`, `restart-request.${NONCE}.taken`])
      expect(JSON.parse(readFileSync(join(dir, `restart-ack-${NONCE}.json`), 'utf8'))).toMatchObject({ nonce: NONCE, pid: process.pid })
      // The same request again (a duplicate event, or written again): a replay, removed, not acted on.
      write(dir)
      await vi.waitFor(() => expect(existsSync(join(dir, REQUEST_FILE))).toBe(false), { timeout: HUNG_MS })
      expect(asked).toHaveBeenCalledTimes(1)
    } finally {
      stopWatchingRestartRequests()
    }
  })
})
