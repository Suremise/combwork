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
const { titleNudge } = await import('../src/main/titleNudge')
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
    expect(nudge).toBe('Titles over 80 characters are cut in git and on the board: consider a shorter one (the detail belongs in the description).')
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
  })

  it('follows the advanced setting: its limit in the line, and none at 0', async () => {
    await advanced.set(CARD_TITLE_NUDGE, 100)
    expect(titleNudge(long, agent)).toMatch(/^Titles over 100 characters/)
    expect(titleNudge('x'.repeat(100), agent)).toBeNull()
    await advanced.set(CARD_TITLE_NUDGE, 0)
    expect(titleNudge(long, agent)).toBeNull()
  })
})
