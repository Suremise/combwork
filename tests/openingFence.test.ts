// The fence at the databases' open (#1379): work begun for an opening of a workspace that has closed can't open that
// workspace's databases again, unless a window has it open again; other workspaces' files, files outside its .hive, and
// work of no opening are never fenced.
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { assertNotFencedOut, currentOpening, fencedOut, inOpening, setOpenCheck } from '../src/main/openingFence'

const ws = join('C:\\', 'fence', 'alpha')
const db = join(ws, '.hive', 'hive.db')

describe('the opening fence', () => {
  it('fences a closed opening out of its own workspace, with the close’s reason', () => {
    const life = new AbortController()
    const reason = new Error('The workspace was closed')
    life.abort(reason)
    setOpenCheck(() => false)
    inOpening({ path: ws, signal: life.signal }, () => {
      expect(fencedOut(db)).toBe(true)
      expect(fencedOut(join(ws, '.hive', 'assistant', 'journal.db'))).toBe(true)
      expect(() => assertNotFencedOut(db)).toThrow(reason)
    })
  })

  it('lets it through while the opening lasts, once the workspace is open again, and for files of other workspaces or outside .hive', () => {
    const life = new AbortController()
    setOpenCheck(() => false)
    inOpening({ path: ws, signal: life.signal }, () => expect(fencedOut(db)).toBe(false))
    life.abort(new Error('closed'))
    inOpening({ path: ws, signal: life.signal }, () => {
      expect(fencedOut(join('C:\\', 'fence', 'beta', '.hive', 'hive.db'))).toBe(false)
      expect(fencedOut(join('C:\\', 'fence', 'alphabet', '.hive', 'hive.db'))).toBe(false)
      expect(fencedOut(join(ws, 'proj', 'notes.db'))).toBe(false)
    })
    setOpenCheck((p) => p === ws)
    inOpening({ path: ws, signal: life.signal }, () => expect(fencedOut(db)).toBe(false))
    setOpenCheck(() => false)
  })

  it('fences nothing for work of no opening, and an inner opening (or none) stands for the work inside it', async () => {
    const closed = new AbortController()
    closed.abort(new Error('closed'))
    setOpenCheck(() => false)
    expect(currentOpening()).toBeNull()
    expect(fencedOut(db)).toBe(false)
    await inOpening({ path: ws, signal: closed.signal }, async () => {
      await Promise.resolve()
      // Carried across awaits, as the work goes on.
      expect(fencedOut(db)).toBe(true)
      inOpening(null, () => expect(fencedOut(db)).toBe(false))
    })
  })
})
