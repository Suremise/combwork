// The fence at the databases' open (#1379): a workspace a window started closing has its databases (in its .hive) refused,
// with the close's reason, until a window opens it again; other workspaces' files and files outside its .hive never are.
// By real paths: a junction or an 8.3 short name is the same workspace, whichever spelling closes, opens or asks.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { assertNotFencedOut, closedCount, fencedOut, markClosed, markOpen } from '../src/main/openingFence'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'

/** A workspace folder with a long name and a .hive, a junction to it, and its 8.3 name where the volume has one. */
function aliased(): { real: string; via: string; short: string | null } {
  const base = tempDir('hive-fence-')
  const real = join(base, 'WorkspaceWithLongName')
  mkdirSync(join(real, '.hive'), { recursive: true })
  return { real, via: junction(real, join(base, 'via-junction')), short: shortPath(real) }
}

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

  it('closed by its real name, refuses its files by a junction, an 8.3 name, and a file not made yet', () => {
    const p = aliased()
    const reason = new Error('closed')
    markClosed(p.real, reason)
    try {
      expect(fencedOut(join(p.via, '.hive', 'hive.db'))).toBe(reason)
      expect(fencedOut(join(p.via.toUpperCase(), '.hive', 'not-made-yet', 'journal.db'))).toBe(reason)
      if (p.short) expect(fencedOut(join(p.short, '.hive', 'usage.db'))).toBe(reason)
      expect(fencedOut(join(p.via, 'proj', 'notes.db'))).toBeNull()
    } finally {
      markOpen(p.real)
    }
  })

  it('closed through a junction, refuses its files by the real name; opened again by either name, refuses none', () => {
    const p = aliased()
    const reason = new Error('closed')
    markClosed(p.via, reason)
    expect(fencedOut(join(p.real, '.hive', 'hive.db'))).toBe(reason)
    markOpen(p.real)
    expect(fencedOut(join(p.via, '.hive', 'hive.db'))).toBeNull()
    markClosed(p.real, reason)
    expect(fencedOut(join(p.via, '.hive', 'hive.db'))).toBe(reason)
    markOpen(p.short ?? p.via)
    expect(fencedOut(join(p.real, '.hive', 'hive.db'))).toBeNull()
  })

  it('keeps a workspace fenced however many close after it, one entry per workspace however often it closes (#1381)', () => {
    const before = closedCount()
    const many = Array.from({ length: 300 }, (_, i) => join('C:\\', 'fence', 'many', `ws-${i}`))
    const fileOf = (at: string): string => join(at, '.hive', 'hive.db')
    try {
      for (const at of many) markClosed(at, new Error(at))
      // Closed again (by another spelling too): still one entry, with the newest reason.
      markClosed(many[0], new Error('again'))
      markClosed(many[0].toUpperCase(), new Error('again, upper'))
      expect(closedCount()).toBe(before + many.length)
      expect(fencedOut(fileOf(many[0]))?.message).toBe('again, upper')
      for (const at of many) expect(fencedOut(fileOf(at))).not.toBeNull()
      // Opened again: its entry goes.
      markOpen(many[1])
      expect(closedCount()).toBe(before + many.length - 1)
      expect(fencedOut(fileOf(many[1]))).toBeNull()
    } finally {
      for (const at of many) markOpen(at)
    }
    expect(closedCount()).toBe(before)
  })
})
