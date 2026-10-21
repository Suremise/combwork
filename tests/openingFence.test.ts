// The fence at the databases' open (#1379): a workspace a window started closing has its databases (in its .hive) refused,
// with the close's reason, until a window opens it again; other workspaces' files and files outside its .hive never are.
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { assertNotFencedOut, fencedOut, markClosed, markOpen } from '../src/main/openingFence'

const ws = join('C:\\', 'fence', 'alpha')
const db = join(ws, '.hive', 'hive.db')

describe('the opening fence', () => {
  it("refuses a closed workspace's databases with the close's reason, until it is opened again", () => {
    expect(fencedOut(db)).toBeNull()
    const reason = new Error('The workspace was closed')
    markClosed(ws, reason)
    expect(fencedOut(db)).toBe(reason)
    expect(fencedOut(join(ws, '.hive', 'assistant', 'journal.db'))).toBe(reason)
    expect(fencedOut(join(ws.toUpperCase(), '.HIVE', 'usage.db'))).toBe(reason)
    expect(() => assertNotFencedOut(db)).toThrow(reason)
    markOpen(ws)
    expect(fencedOut(db)).toBeNull()
    expect(() => assertNotFencedOut(db)).not.toThrow()
  })

  it("never refuses another workspace's files, one beside it, or files outside its .hive", () => {
    markClosed(ws, new Error('closed'))
    try {
      expect(fencedOut(join('C:\\', 'fence', 'beta', '.hive', 'hive.db'))).toBeNull()
      expect(fencedOut(join('C:\\', 'fence', 'alphabet', '.hive', 'hive.db'))).toBeNull()
      expect(fencedOut(join(ws, 'proj', '.hive', 'notes.db'))).toBeNull()
      expect(fencedOut(join(ws, 'notes.db'))).toBeNull()
    } finally {
      markOpen(ws)
    }
  })
})
