// HI-2540: why a conversation starts fresh rather than resume, the one rule the start (sessions.start) and the window's
// lists (the session list, an agent's resume target) read, so Resume asks the right question before anything starts.
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { freshReasonOf, idleResume, IDLE_RESUME_FLOOR_TOKENS, SESSION_NAMES } from '../src/shared/sessionFresh'

// old-name: begin old-folder-moves-1
const moves = [{ from: 'C:\\ws\\alpha\\.hive', to: 'C:\\ws\\alpha\\.combwork' }]
// old-name: end old-folder-moves-1

describe('freshReasonOf', () => {
  it('renamed: launched by Combwork before HI-2463 (an agent or a folder, no names)', () => {
    expect(freshReasonOf({ agentId: 'b1', cwd: 'C:\\ws\\alpha' }, [])).toBe('renamed')
    expect(freshReasonOf({ agentId: 'b1' }, [])).toBe('renamed')
    expect(freshReasonOf({ cwd: 'C:\\ws\\alpha' }, [])).toBe('renamed')
    // Before the move too: renamed is said first, as the start says it.
    // old-name: begin old-folder-moves-2
    expect(freshReasonOf({ agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\slots\\HI-1' }, moves)).toBe('renamed')
    // old-name: end old-folder-moves-2
  })

  it('a session adopted from outside (neither an agent nor a folder) never knew the old names: it resumes', () => {
    expect(freshReasonOf({}, moves)).toBeNull()
  })

  it('moved: launched since, in a folder inside an old data folder that moved (HI-2462), any spelling of its path', () => {
    // old-name: begin old-folder-moves-3
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\slots\\HI-1' }, moves)).toBe('moved')
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'c:/ws/alpha/.HIVE/slots/HI-1' }, moves)).toBe('moved')
    // old-name: end old-folder-moves-3
  })

  it('launched since, in a folder that did not move: it resumes', () => {
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha' }, moves)).toBeNull()
    // A sibling whose name only starts like the moved folder's.
    // old-name: begin old-folder-moves-4
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hiveish' }, moves)).toBeNull()
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\x' }, [])).toBeNull()
    // old-name: end old-folder-moves-4
  })
})

// HI-3360: a resume counts as cold once its conversation was idle past the threshold, and isn't small where that is known.
describe('idleResume', () => {
  const now = Date.parse('2026-11-18T12:00:00.000Z')
  const hoursAgo = (h: number): string => new Date(now - h * 3_600_000).toISOString()
  const big = { tokens: 120_000, bytes: null }

  it('idle past the threshold: its age and size, tokens and bytes kept apart', () => {
    expect(idleResume(hoursAgo(3), big, 60, now)).toEqual({ since: hoursAgo(3), idleMs: 3 * 3_600_000, tokens: 120_000, bytes: null })
    expect(idleResume(hoursAgo(3), { tokens: null, bytes: 4_200_000 }, 60, now)).toMatchObject({ tokens: null, bytes: 4_200_000 })
  })

  it('within the threshold, or exactly at it: not cold', () => {
    expect(idleResume(hoursAgo(0.5), big, 60, now)).toBeNull()
    expect(idleResume(hoursAgo(1), big, 60, now)).toBeNull()
    expect(idleResume(hoursAgo(0.5), big, 20, now)).not.toBeNull()
  })

  it('small where its tokens are known: never asks; with only its bytes (no way to tell it is small) it does', () => {
    expect(idleResume(hoursAgo(5), { tokens: IDLE_RESUME_FLOOR_TOKENS - 1, bytes: 10 }, 60, now)).toBeNull()
    expect(idleResume(hoursAgo(5), { tokens: IDLE_RESUME_FLOOR_TOKENS, bytes: null }, 60, now)).not.toBeNull()
    expect(idleResume(hoursAgo(5), { tokens: null, bytes: 10 }, 60, now)).not.toBeNull()
    expect(idleResume(hoursAgo(5), { tokens: null, bytes: null }, 60, now)).not.toBeNull()
  })

  it('the rule off (null minutes), no last activity, or one that does not parse: never cold', () => {
    expect(idleResume(hoursAgo(50), big, null, now)).toBeNull()
    expect(idleResume(null, big, 60, now)).toBeNull()
    expect(idleResume(undefined, big, 60, now)).toBeNull()
    expect(idleResume('not a date', big, 60, now)).toBeNull()
  })
})

// HI-3360: agents resumed after a restart, an update or a quit carry on as before. That holds by path: the rule is read
// only by the session list (sessions.idleOf), the Agent API's start routes and the placement; restartResume, lastRun and
// outageResume resume through sessions.start, which never reads it.
describe('the long-idle rule is read only where a resume may ask or start fresh', () => {
  const main = join(__dirname, '..', 'src', 'main')
  const files = readdirSync(main).filter((f) => f.endsWith('.ts'))
  const reads = (f: string): boolean => /\bidleOf\(|\bresumeIdleMinutes\(|\bidleResume\(/.test(readFileSync(join(main, f), 'utf8'))

  it('by sessions (the list and idleOf), the Agent API (servers) and the placement (slotCards) alone', () => {
    expect(files.filter(reads).sort()).toEqual(['servers.ts', 'sessions.ts', 'slotCards.ts'])
  })

  it('never by the restart, quit or outage resumes, nor by sessions.start itself', () => {
    for (const f of ['restartResume.ts', 'lastRun.ts', 'outageResume.ts']) expect(reads(f), f).toBe(false)
    const src = readFileSync(join(main, 'sessions.ts'), 'utf8')
    const start = src.slice(src.indexOf('  async start(projectPath: string, opts: StartOptions)'), src.indexOf('  async start(projectPath: string, opts: StartOptions)') + 4000)
    expect(start.length).toBeGreaterThan(100)
    expect(/idleOf|idleResume|resumeIdleMinutes/.test(start)).toBe(false)
  })
})
