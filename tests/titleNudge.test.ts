// A long card title from an agent (HI-1872): kept, never refused, with a line in the reply suggesting a shorter one;
// none for the user's own titles, none with Settings → Advanced → Suggest a shorter title past at 0.
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { CARD_TITLE_NUDGE } from '../src/shared/advanced'
import { changedText, createdText, type TaskChange } from '../src/shared/toolReplies'

const base = tempDir('hive-title-nudge-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
mkdirSync(join(base, 'profile'), { recursive: true })

const { advanced } = await import('../src/main/advanced')
const { titleNudge, titleDetails } = await import('../src/main/titleNudge')
advanced.load(join(base, 'profile'))

afterEach(async () => {
  await advanced.set(CARD_TITLE_NUDGE, 80)
})
afterAll(() => {
  advanced.stop()
  rmSync(base, { recursive: true, force: true })
})

const agent = { kind: 'agent' as const, name: 'B1 (alpha)' }
const long = 'Tray: the restart notice stays after Hive restarts, because the update check in updater.ts runs before the window opens'
const change = (nudge: string | null): TaskChange => ({ number: 7, key: 'AL-7', title: long, column: 'todo', position: 1, of: 1, project: 'alpha', agent: null, changes: [], ...(nudge ? { nudge } : {}) })

describe('titleNudge', () => {
  it('keeps a long agent title and suggests a shorter one, on a line of its own in the reply', () => {
    const nudge = titleNudge(long, agent)
    // Its file name is named too (HI-2061), on the same line.
    expect(nudge).toBe('Titles over 80 characters are cut in git and on the board: consider a shorter one (the detail belongs in the description). A title says the outcome or the problem in words: retitle it without "updater.ts" (hive_update_task with title), keeping it in the description.')
    expect(titleNudge(long, { kind: 'assistant' })).toBe(nudge)
    const created = createdText(change(nudge))
    expect(created.split('\n')).toEqual([`AL-7 created in Todo (1st of 1) for alpha: ${long}`, nudge])
    expect(changedText(change(nudge)).split('\n')[1]).toBe(nudge)
  })

  it('says nothing of a title within the limit, nor of one only a field other than the title changed', () => {
    expect(titleNudge('x'.repeat(80), agent)).toBeNull()
    expect(titleNudge(`  ${'x'.repeat(80)}  `, agent)).toBeNull()
    expect(titleNudge(undefined, agent)).toBeNull()
    expect(createdText(change(null))).not.toContain('\n')
  })

  it("never questions the user's own titles", () => {
    expect(titleNudge(long, { kind: 'user' })).toBeNull()
    expect(titleNudge('Fix src/main/foo.ts timeout of 300 s', { kind: 'user' })).toBeNull()
  })

  // HI-2061: what belongs in the description, named in the title, gets the same kind of line, whatever its length.
  it('names the paths, file names, cards and measurements a short title has', () => {
    expect(titleNudge('Fix src/main/foo.ts timeout of 300 s', agent)).toBe('A title says the outcome or the problem in words: retitle it without "src/main/foo.ts" and "300 s" (hive_update_task with title), keeping them in the description.')
    expect(titleDetails('Follow-up of HI-2012 and #1662: AGENTS.md says it twice', ['HI'])).toEqual(['HI-2012', '#1662', 'AGENTS.md'])
    expect(titleDetails('Logs fill C:\\Users\\x\\AppData past 20 MB, at 95 % CPU', [])).toEqual(['C:\\Users\\x\\AppData', '20 MB', '95 %'])
    expect(titleDetails('Read `package.json` (and tests/e2e/lib.cjs), in 250ms', [])).toEqual(['package.json', 'tests/e2e/lib.cjs', '250ms'])
    // At most three, as written.
    expect(titleDetails('a.ts b.ts c.ts d.ts', [])).toEqual(['a.ts', 'b.ts', 'c.ts'])
    // An old key of a project counts as its key does.
    expect(titleDetails('Carry AM-3 over', ['HI', 'AM'])).toEqual(['AM-3'])
  })

  it('leaves an ordinary title alone: words, versions, standards and products', () => {
    for (const t of [
      'Card titles with paths, numbers or names get a nudge, as long ones do',
      'A lane start leaves its builder on its old conversation when a prompt is pending',
      'Read and/or write the board in UTF-8, with SHA-256 checks',
      'Run on Node.js 24 and Electron 39, version 1.0.0-rc.12',
      'Three agents review two cards in 2 rounds',
      'Tool descriptions: one line plus the key rule, detail read when needed'
    ]) {
      expect(titleDetails(t, ['HI', 'AM']), t).toEqual([])
      expect(titleNudge(t, agent), t).toBeNull()
    }
    // A key no project has is a word ("AB-12" with only HI known), and so is a number without a unit.
    expect(titleDetails('Port AB-12 to 3 machines', ['HI'])).toEqual([])
  })

  it("names them with the length's own line off (0), which turns off only the length's", async () => {
    await advanced.set(CARD_TITLE_NUDGE, 0)
    expect(titleNudge('Fix src/main/foo.ts', agent)).toBe('A title says the outcome or the problem in words: retitle it without "src/main/foo.ts" (hive_update_task with title), keeping it in the description.')
  })

  it('follows the advanced setting: its limit in the line, and none at 0', async () => {
    await advanced.set(CARD_TITLE_NUDGE, 100)
    expect(titleNudge(long, agent)).toMatch(/^Titles over 100 characters/)
    expect(titleNudge('x'.repeat(100), agent)).toBeNull()
    await advanced.set(CARD_TITLE_NUDGE, 0)
    expect(titleNudge('x'.repeat(150), agent)).toBeNull()
    // Its file name is still named (HI-2061): only the length's line is off.
    expect(titleNudge(long, agent)).toBe('A title says the outcome or the problem in words: retitle it without "updater.ts" (hive_update_task with title), keeping it in the description.')
  })
})
