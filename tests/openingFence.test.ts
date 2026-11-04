// Admission to a workspace's databases (#1395, replacing #1379's fence and #1381's closed list): a workspace's databases
// (in its .combwork) are kept open only while a window holds it, admitted by the place the window recorded and dismissed as it
// closes; any other workspace's, closed or never opened, is refused with the workspace's reason, told apart from other
// failures. By real paths: a junction or an 8.3 short name is the same workspace, whichever spelling asks. Only the nearest
// .combwork owns a file. Nothing about closed workspaces is kept.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { placeKey } from '../src/main/fsutil'
import { admit, admittedCount, assertAdmitted, dismiss, isRefusal, ownerOf, refusal, setFenceReason } from '../src/main/openingFence'
import { junction, shortPath } from './pathAliases'
import { tempDir } from './tempDir'

/** A workspace folder with a long name and a .combwork, a junction to it, and its 8.3 name where the volume has one. */
function aliased(): { real: string; via: string; short: string | null } {
  const base = tempDir('hive-fence-')
  const real = join(base, 'WorkspaceWithLongName')
  mkdirSync(join(real, '.combwork'), { recursive: true })
  return { real, via: junction(real, join(base, 'via-junction')), short: shortPath(real) }
}

const ws = join('C:\\', 'fence', 'alpha')
const db = join(ws, '.combwork', 'hive.db')
/** What a refused open throws here (the workspace's own message in the app: setFenceReason). */
setFenceReason(() => new Error('The workspace was closed'))

describe('admission to a workspace’s databases', () => {
  it('refuses a workspace no window holds (never opened, or closed) as a refusal; admitted, refuses none of its files', () => {
    expect(isRefusal(refusal(db))).toBe(true)
    expect(() => assertAdmitted(db)).toThrow(/closed/)
    admit(placeKey(ws))
    try {
      expect(refusal(db)).toBeNull()
      expect(refusal(join(ws, '.combwork', 'assistant', 'journal.db'))).toBeNull()
      expect(refusal(join(ws.toUpperCase(), '.COMBWORK', 'usage.db'))).toBeNull()
      expect(() => assertAdmitted(db)).not.toThrow()
    } finally {
      dismiss(placeKey(ws))
    }
    expect(isRefusal(refusal(db))).toBe(true)
    // Another failure isn't one.
    expect(isRefusal(new Error('The workspace was closed'))).toBe(false)
  })

  it("admits only its own files: not one beside it, a project's .combwork inside it, a file in no .combwork, or a .combwork under its Assistant's home (HR6)", () => {
    admit(placeKey(ws))
    try {
      for (const f of [join('C:\\', 'fence', 'beta', '.combwork', 'hive.db'), join('C:\\', 'fence', 'alphabet', '.combwork', 'hive.db'), join(ws, 'proj', '.combwork', 'notes.db'), join(ws, 'notes.db'), join(ws, '.combwork', 'assistant', '.combwork', 'other.db')]) expect({ f, refused: isRefusal(refusal(f)) }).toEqual({ f, refused: true })
      // Only the nearest .combwork owns a file.
      expect(ownerOf(join(ws, '.combwork', 'assistant', '.combwork', 'other.db'))).toBe(placeKey(join(ws, '.combwork', 'assistant')))
      expect(ownerOf(join(ws, '.combwork', 'assistant', 'journal.db'))).toBe(placeKey(ws))
      expect(ownerOf(join(ws, 'notes.db'))).toBeNull()
    } finally {
      dismiss(placeKey(ws))
    }
  })

  it('admitted by its real place, takes its files by a junction, an 8.3 name, and a file not made yet', () => {
    const p = aliased()
    admit(placeKey(p.via))
    try {
      expect(refusal(join(p.real, '.combwork', 'hive.db'))).toBeNull()
      expect(refusal(join(p.via.toUpperCase(), '.combwork', 'not-made-yet', 'journal.db'))).toBeNull()
      if (p.short) expect(refusal(join(p.short, '.combwork', 'usage.db'))).toBeNull()
      expect(isRefusal(refusal(join(p.via, 'proj', 'notes.db')))).toBe(true)
    } finally {
      dismiss(placeKey(p.via))
    }
    expect(isRefusal(refusal(join(p.real, '.combwork', 'hive.db')))).toBe(true)
  })

  it('keeps nothing of the workspaces closed: however many open and close, the count is back where it was (#1395)', () => {
    const before = admittedCount()
    const many = Array.from({ length: 300 }, (_, i) => placeKey(join('C:\\', 'fence', 'many', `ws-${i}`)))
    for (const at of many) admit(at)
    expect(admittedCount()).toBe(before + many.length)
    for (const at of many) dismiss(at)
    expect(admittedCount()).toBe(before)
    for (const at of many) expect(isRefusal(refusal(join(at, '.combwork', 'hive.db')))).toBe(true)
  })
})
