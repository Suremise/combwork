// The Assistant's journal and the usage history (usage.db) opened under another name for their workspace's folder (#1456,
// as #1402 for combwork.db): a junction or an 8.3 short name is another connection to the same file, which the window's close
// closes too, by the place the window recorded as it opened, never by what a spelling resolves to at the close. So a
// junction removed or pointed at another workspace before the close neither keeps this one's open nor closes another's.
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { junction, shortPath } from './pathAliases'
import { moveFolder } from './moveFolder'
import { DEFAULT_JOURNAL, type JournalSettings } from '../src/shared/journal'
import { bound, spyOnPrivate } from './keepType'

const base = tempDir('cw-assistant-aliases-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (f: string) => Promise<void> }).trashItem = async (f) => rmSync(f, { force: true })
// The longest a wait here waits for what it waits on: a bound for a hung run (tests/README.md).
const HUNG_MS = 10_000

const { createWorkspaceService, disposeWorkspaceService } = await import('../src/main/workspace')
const journal = await import('../src/main/journal')
const { usageHistory } = await import('../src/main/usageHistory')
const worker = await import('../src/main/usageWorker')
const { usageFile } = await import('../src/main/usageDb')
const { closeAllBoards } = await import('../src/main/boardStore')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
let n = 0

/** A workspace with a project `p`. */
function workspace(): string {
  const ws = join(base, `ws-${++n}`)
  mkdirSync(join(ws, 'p', '.combwork'), { recursive: true })
  writeFileSync(join(ws, 'p', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  return ws
}
async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
/** Another name for `ws`: a junction (removed by `drop`), or its 8.3 short name (null where the volume makes none). */
function aliasOf(kind: 'junction' | '8.3', ws: string): { path: string; drop: () => void } | null {
  if (kind === '8.3') {
    const s = shortPath(ws)
    return s ? { path: s, drop: () => undefined } : null
  }
  const path = junction(ws, join(base, `alias-${++n}`))
  return { path, drop: () => unlinkSync(path) }
}

const all: JournalSettings = { ...DEFAULT_JOURNAL, scope: ['decision', 'plan', 'event', 'incident', 'insight', 'preference', 'moment'] }
const home = (ws: string): string => join(ws, '.combwork', 'assistant')
/** The journal of the workspace at `ws` (by that spelling), opened by writing to it. */
const useJournal = (ws: string): number => journal.writeEntry(home(ws), all, { kind: 'decision', summary: `Entry ${++n}` }, 'assistant')
const journalOpen = (ws: string): boolean => journal.journalOpen(home(ws))
/** The usage history of the workspace at `ws` (by that spelling), opened by reading it. */
const useUsage = (ws: string): Promise<unknown> => usageHistory.storedSessions(ws, null)
/** Whether the worker has the usage.db of the workspace really at `ws` open: it is only ever sent where a file really is. */
const usageOpen = (ws: string): boolean => worker.openFiles().includes(usageFile(ws).toLowerCase())
/** Whether the worker was sent a spelling under `alias` (never: the file where it really is). */
const usageByAlias = (alias: string): boolean => worker.openFiles().some((f) => f.startsWith(join(alias, '.combwork').toLowerCase()))

/** Nothing holds the folder: it can be moved (Windows refuses while a connection has a file in it open). */
async function moves(ws: string): Promise<void> {
  await moveFolder(ws, `${ws}-moved`)
}

let closeAll: (() => void) | null = null

describe("the Assistant's journal and usage.db under another name for their workspace (#1456)", () => {
  beforeAll(async () => {
    mkdirSync(join(base, 'profile'), { recursive: true })
    usageHistory.start()
    // As a worker thread does: its files stay open until it's told to close them (in-process it closes them when idle).
    const w = await open(workspace())
    await useUsage(w.path!)
    closeAll = usageHistory['closeInProcess']
    expect(closeAll).toBeTypeOf('function')
    usageHistory['closeInProcess'] = null
    await w.close()
  })
  afterAll(async () => {
    for (const w of opened) await disposeWorkspaceService(w)
    usageHistory['closeInProcess'] = closeAll
    closeAll?.()
    await usageHistory.stop()
    journal.closeAllJournals()
    closeAllBoards()
  })

  for (const kind of ['junction', '8.3'] as const) {
    it(`${kind}: the window opened by the real path, both opened only by the other name, closed with the window`, async ({ skip }) => {
      const ws = workspace()
      const alias = aliasOf(kind, ws)
      if (!alias) return skip('this volume makes no 8.3 names')
      try {
        const w = await open(ws)
        useJournal(alias.path)
        await useUsage(alias.path)
        expect([journalOpen(alias.path), usageOpen(ws), usageByAlias(alias.path)]).toEqual([true, true, false])
        await w.close()
        expect(journalOpen(alias.path)).toBe(false)
        await vi.waitFor(() => expect(usageOpen(ws)).toBe(false), { timeout: HUNG_MS })
      } finally {
        alias.drop()
      }
      await moves(ws)
    })

    it(`${kind}: the window opened by the other name, both opened by it and by the real path, all closed with the window`, async ({ skip }) => {
      const ws = workspace()
      const alias = aliasOf(kind, ws)
      if (!alias) return skip('this volume makes no 8.3 names')
      try {
        const w = await open(alias.path)
        for (const p of [alias.path, ws]) {
          useJournal(p)
          await useUsage(p)
        }
        expect([journalOpen(alias.path), journalOpen(ws), usageOpen(ws), usageByAlias(alias.path)]).toEqual([true, true, true, false])
        await w.close()
        expect([journalOpen(alias.path), journalOpen(ws)]).toEqual([false, false])
        await vi.waitFor(() => expect(usageOpen(ws)).toBe(false), { timeout: HUNG_MS })
      } finally {
        alias.drop()
      }
      await moves(ws)
    })
  }

  it('the junction the window opened by removed before it closes: what was opened by the real path closes all the same', async () => {
    const ws = workspace()
    const alias = aliasOf('junction', ws)!
    const w = await open(alias.path)
    useJournal(alias.path)
    await useUsage(alias.path)
    useJournal(ws)
    await useUsage(ws)
    alias.drop()
    await w.close()
    expect([journalOpen(alias.path), journalOpen(ws)]).toEqual([false, false])
    await vi.waitFor(() => expect(usageOpen(ws)).toBe(false), { timeout: HUNG_MS })
    await moves(ws)
  })

  it("the junction the window opened by pointed at another window's workspace before it closes: that one's stay open, this one's close", async () => {
    const [ws, other] = [workspace(), workspace()]
    const alias = aliasOf('junction', ws)!
    try {
      const w = await open(alias.path)
      useJournal(alias.path)
      await useUsage(alias.path)
      useJournal(ws)
      await useUsage(ws)
      const w2 = await open(other)
      useJournal(other)
      await useUsage(other)
      alias.drop()
      junction(other, alias.path)
      await w.close()
      expect([journalOpen(alias.path), journalOpen(ws), journalOpen(other)]).toEqual([false, false, true])
      await vi.waitFor(() => expect(usageOpen(ws)).toBe(false), { timeout: HUNG_MS })
      expect(usageOpen(other)).toBe(true)
      // The other window's still work.
      expect(useJournal(other)).toBeGreaterThan(0)
      await expect(useUsage(other)).resolves.toEqual([])
      await w2.close()
      expect(journalOpen(other)).toBe(false)
      await vi.waitFor(() => expect(usageOpen(other)).toBe(false), { timeout: HUNG_MS })
    } finally {
      unlinkSync(alias.path)
    }
    await moves(ws)
  })

  it('a journal being deleted by one name is closed under every other, and refused under it meanwhile', async () => {
    const ws = workspace()
    const alias = aliasOf('junction', ws)!
    try {
      const w = await open(ws)
      useJournal(ws)
      useJournal(alias.path)
      const deleting = journal.deleteJournal(home(ws))
      expect(() => useJournal(alias.path)).toThrow(/being deleted/)
      await deleting
      expect([journalOpen(ws), journalOpen(alias.path)]).toEqual([false, false])
      expect(journal.hasJournal(home(alias.path))).toBe(false)
      await w.close()
    } finally {
      alias.drop()
    }
  })

  it("a usage request keeps the file it resolved as it entered: a junction pointed at another window's workspace while it waits for the worker (HR6 round 1)", async () => {
    const [a, b] = [workspace(), workspace()]
    const via = aliasOf('junction', a)!
    const wa = await open(a)
    const wb = await open(b)
    const transport = bound(usageHistory, usageHistory['transport'])
    const spy = spyOnPrivate(usageHistory, 'transport', usageHistory['transport']).mockImplementationOnce(async () => {
      via.drop()
      junction(b, via.path)
      return transport()
    })
    try {
      await useUsage(via.path)
      expect({ a: existsSync(usageFile(a)), b: existsSync(usageFile(b)) }).toEqual({ a: true, b: false })
      expect([usageOpen(a), usageOpen(b)]).toEqual([true, false])
      // Recorded as a's: its window's close closes it.
      await wa.close()
      await vi.waitFor(() => expect(usageOpen(a)).toBe(false), { timeout: HUNG_MS })
      await wb.close()
    } finally {
      spy.mockRestore()
      via.drop()
    }
    await moves(a)
  })

  for (const bOpen of [false, true]) {
    it(`deleting a journal opened through a junction since pointed at another workspace deletes the one it opened${bOpen ? ", leaving the other's open connection be" : ''} (HR6 round 1)`, async () => {
      const [a, b] = [workspace(), workspace()]
      const via = aliasOf('junction', a)!
      const wa = await open(a)
      const wb = await open(b)
      try {
        useJournal(via.path)
        useJournal(b)
        if (!bOpen) journal.closeJournal(home(b))
        via.drop()
        junction(b, via.path)
        await journal.deleteJournal(home(via.path))
        expect({ a: existsSync(journal.journalFile(home(a))), b: existsSync(journal.journalFile(home(b))) }).toEqual({ a: false, b: true })
        expect(journalOpen(b)).toBe(bOpen)
        expect(useJournal(b)).toBeGreaterThan(0)
        await wa.close()
        await wb.close()
      } finally {
        via.drop()
      }
    })
  }
})
