// What a workspace's .combwork watch tells (HI-1797): a shared note, a skill and a mode changing, a folder of them made after
// the workspace opened, and workspace.json changed by hand, each tell their change; the board's database files, which
// change with every board write, tell nothing (chokidar watched .combwork whole, and read its listing again at each).
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import type { CombworkEvent } from '../src/shared/types'

const base = tempDir('hive-hive-watch-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')

const ws = join(base, 'ws')
mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [] }))
const w = createWorkspaceService()
await w.open(ws)
afterAll(async () => {
  await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const events: string[] = []
vi.spyOn(w, 'emit').mockImplementation((e: CombworkEvent) => void events.push(e.type))
const hive = join(ws, '.combwork')
/** Waits for an event of this type after `from` (the watch's events come a moment after the write). */
const told = (type: string, from: number): Promise<void> => vi.waitFor(() => expect(events.slice(from)).toContain(type), { timeout: 10_000, interval: 50 })
/** Writes `file` until an event of this type is told: a watch starts (or takes a new folder) a moment after it is asked to. */
const toldOnceWatched = (type: string, file: string): Promise<void> => {
  const from = events.length
  let n = 0
  return vi.waitFor(
    () => {
      writeFileSync(file, `written ${++n}\n`)
      expect(events.slice(from)).toContain(type)
    },
    { timeout: 15_000, interval: 200 }
  )
}

describe("a workspace's .combwork watch (HI-1797)", () => {
  it('tells a shared note, a skill and a modes folder made after it opened, and reads workspace.json again', async () => {
    mkdirSync(join(hive, 'shared'), { recursive: true })
    // The watch is up once a note's change is told.
    await toldOnceWatched('notes-changed', join(hive, 'shared', 'note.md'))
    let from = events.length
    mkdirSync(join(hive, 'skills', 'mine'), { recursive: true })
    writeFileSync(join(hive, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n')
    await told('skills-changed', from)
    // A modes folder the workspace didn't have: its appearing is told, and its files from then on.
    from = events.length
    mkdirSync(join(hive, 'personas'), { recursive: true })
    await told('modes-changed', from)
    await toldOnceWatched('modes-changed', join(hive, 'personas', 'old.md'))
    // workspace.json changed outside Combwork: read again (it tells skills-changed).
    from = events.length
    const cfg = JSON.parse(String(await import('fs').then((f) => f.readFileSync(join(hive, 'workspace.json'), 'utf8'))))
    writeFileSync(join(hive, 'workspace.json'), JSON.stringify({ ...cfg, combworkWatchTest: 1 }))
    await told('skills-changed', from)
  })

  it("tells nothing for the board's database files, which every board write changes", async () => {
    // (The writes above have each been told: what they told was waited for.)
    const from = events.length
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(hive, 'combwork.db-wal-test'), 'x'.repeat(i))
      writeFileSync(join(hive, 'combwork.db-journal'), 'x'.repeat(i))
    }
    // A change that is told, after them: once it is, the database files' changes have been seen (and told nothing).
    writeFileSync(join(hive, 'shared', 'after.md'), 'after\n')
    await told('notes-changed', from)
    expect(events.slice(from).filter((e) => e !== 'notes-changed')).toEqual([])
  })
})
