// Recent workspaces (#144): forgetting one ignores the case of its path (Windows paths), each entry says whether its
// folder is there, and Clear Recent keeps only the workspaces open in a window (none here).
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { config } from '../src/main/config'
import { onCombworkEvent } from '../src/main/events'
import { clearRecent, recentFor, removeRecent } from '../src/main/recentWorkspaces'
import { tempDir } from './tempDir'

const here = tempDir('hive-recent-')
afterAll(() => rmSync(here, { recursive: true, force: true }))

describe('recent workspaces (#144)', () => {
  it('says which folders are there, and forgets one whatever the case of its path, telling every window', () => {
    const gone = join(here, 'Gone Workspace')
    config.get().recentWorkspaces = [here, gone, 'C:\\Work\\Alpha']
    const list = recentFor(null)
    expect(list.map((r) => [r.path, r.exists])).toEqual([[here, true], [gone, false], ['C:\\Work\\Alpha', false]])
    expect(list.some((r) => r.openElsewhere)).toBe(false)
    const events: string[] = []
    const off = onCombworkEvent((e) => events.push(e.type))
    try {
      removeRecent('c:/work/ALPHA')
      expect(config.get().recentWorkspaces).toEqual([here, gone])
      removeRecent(gone.toUpperCase())
      expect(config.get().recentWorkspaces).toEqual([here])
      expect(events.filter((t) => t === 'recent-changed')).toHaveLength(2)
      // Something not in the list: nothing changes.
      removeRecent('C:\\Nowhere')
      expect(config.get().recentWorkspaces).toEqual([here])
    } finally {
      off?.()
    }
  })

  it('Clear Recent keeps only workspaces open in a window', () => {
    config.get().recentWorkspaces = [here, 'C:\\Work\\Beta']
    clearRecent()
    expect(config.get().recentWorkspaces).toEqual([])
  })
})
