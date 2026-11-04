// HI-2540: why a conversation starts fresh rather than resume, the one rule the start (sessions.start) and the window's
// lists (the session list, an agent's resume target) read, so Resume asks the right question before anything starts.
import { describe, expect, it } from 'vitest'
import { freshReasonOf, SESSION_NAMES } from '../src/shared/sessionFresh'

const moves = [{ from: 'C:\\ws\\alpha\\.hive', to: 'C:\\ws\\alpha\\.combwork' }]

describe('freshReasonOf', () => {
  it('renamed: launched by Combwork before HI-2463 (an agent or a folder, no names)', () => {
    expect(freshReasonOf({ agentId: 'b1', cwd: 'C:\\ws\\alpha' }, [])).toBe('renamed')
    expect(freshReasonOf({ agentId: 'b1' }, [])).toBe('renamed')
    expect(freshReasonOf({ cwd: 'C:\\ws\\alpha' }, [])).toBe('renamed')
    // Before the move too: renamed is said first, as the start says it.
    expect(freshReasonOf({ agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\slots\\HI-1' }, moves)).toBe('renamed')
  })

  it('a session adopted from outside (neither an agent nor a folder) never knew the old names: it resumes', () => {
    expect(freshReasonOf({}, moves)).toBeNull()
  })

  it('moved: launched since, in a folder inside a .hive that moved (HI-2462), any spelling of its path', () => {
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\slots\\HI-1' }, moves)).toBe('moved')
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'c:/ws/alpha/.HIVE/slots/HI-1' }, moves)).toBe('moved')
  })

  it('launched since, in a folder that did not move: it resumes', () => {
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha' }, moves)).toBeNull()
    // A sibling whose name only starts like the moved folder's.
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hiveish' }, moves)).toBeNull()
    expect(freshReasonOf({ names: SESSION_NAMES, agentId: 'b1', cwd: 'C:\\ws\\alpha\\.hive\\x' }, [])).toBeNull()
  })
})
