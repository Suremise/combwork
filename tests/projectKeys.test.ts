// Project keys (#1219, #704; SPEC §16.12): the suggestion and its rules (2–4 letters, unique, none a prefix of another,
// case-insensitive), the 1.0 step (an existing card keeps its number in its project, HI-1061; every old #N still resolves),
// new cards numbered per project, a key changed (the old one an alias), a card moved to another project (its old key an
// alias, its number there again when it comes back), a counter after a change undone part way, and references for the
// Agent API (`HI-12`, `hi-12`, `#12`, 12). HIVE_KEYS_LIVE_DB=<a hive.db> runs the step on a copy of that board.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09 } from './boardDb'
import { cardName, keyProblem, suggestKey, type KeyHeld } from '../src/shared/projectKeys'

const base = tempDir('hive-keys-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const keys = await import('../src/main/projectKeys')
const keysStep = await import('../src/main/schema/keysStep')
const { openDb } = await import('../src/main/db')

const user = { kind: 'user' } as const
let n = 0
type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})
afterEach(() => {
  store.boardTestHooks.upgradeAnswer = null
  store.boardTestHooks.failPut = null
})

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}
async function close(w: WS): Promise<void> {
  const path = w.path!
  opened.splice(opened.indexOf(w), 1)
  await disposeWorkspaceService(w)
  store.closeBoard(path)
}

/** A workspace folder with these projects (each with one agent). */
function workspace(projects = ['hive', 'amberlight']): string {
  const ws = join(base, `ws-${++n}`)
  for (const p of projects) {
    mkdirSync(join(ws, p, '.hive'), { recursive: true })
    writeFileSync(join(ws, p, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  }
  return ws
}
const keyOf = (w: WS, project: string): Promise<string | null> => keys.projectKeyOf(w, join(w.path!, project))

describe('suggested keys and their rules', () => {
  const held = (...ks: [string, string][]): KeyHeld[] => ks.map(([key, projectId]) => ({ key, projectId }))

  it("Darren's projects: HI, AM, AP, MC and WE", () => {
    const got: KeyHeld[] = []
    for (const [name, id] of [['hive', 'p1'], ['amberlight', 'p2'], ['apiary', 'p3'], ['mcp', 'p4'], ['website', 'p5']]) got.push({ key: suggestKey(name, id, got), projectId: id })
    expect(got.map((k) => k.key)).toEqual(['HI', 'AM', 'AP', 'MC', 'WE'])
  })

  it('on a clash, other 2-letter pairs first (the first letter kept first); never a prefix of another; accents and digits dropped', () => {
    expect(suggestKey('history', 'p2', held(['HI', 'p1']))).toBe('HS')
    expect(suggestKey('abc', 'p2', held(['ABC', 'p1']))).toBe('AC')
    expect(suggestKey('ab', 'p2', held(['ABX', 'p1']))).toBe('AA')
    expect(suggestKey('Été 2026', 'p1', [])).toBe('ET')
    expect(suggestKey('2026', 'p1', [])).toBe('PA')
    expect(suggestKey('x', 'p1', [])).toBe('XA')
    // A project's own old key is free to it.
    expect(suggestKey('hive', 'p1', held(['HI', 'p1']))).toBe('HI')
  })

  it('a key is 2–4 letters A–Z, not another project’s (now or before), and neither begins the other; case-insensitive', () => {
    const h = held(['HI', 'p1'], ['AMB', 'p2'])
    expect(keyProblem('H', 'p3', h)).toBe('form')
    expect(keyProblem('HIVES', 'p3', h)).toBe('form')
    expect(keyProblem('H1', 'p3', h)).toBe('form')
    expect(keyProblem('hi', 'p3', h)).toBe('taken')
    expect(keyProblem('AM', 'p3', h)).toBe('prefix')
    expect(keyProblem('HIV', 'p3', h)).toBe('prefix')
    expect(keyProblem('ap', 'p3', h)).toBeNull()
    expect(keyProblem('HIV', 'p1', h)).toBeNull()
  })

  it('a card is named by its key with the number the tools take, until P8', () => {
    expect(cardName({ number: 1240, key: 'HI-1230' })).toBe('HI-1230 (#1240)')
    expect(cardName({ number: 12 })).toBe('#12')
  })
})

describe('a new workspace: keys at its first open, cards numbered per project', () => {
  it('each project gets its key; its cards count from 1, whatever their numbers on the board', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    expect([await keyOf(w, 'hive'), await keyOf(w, 'amberlight')]).toEqual(['HI', 'AM'])
    const made = await inWorkspace(w, async () => {
      const a = await tasks.createTask({ title: 'A', project: 'hive' }, user)
      const b = await tasks.createTask({ title: 'B', project: 'amberlight' }, user)
      const c = await tasks.createTask({ title: 'C', project: 'hive' }, user)
      const d = await tasks.createTask({ title: 'Workspace', project: '' }, user)
      return [a, b, c, d]
    })
    expect(made.map((c) => c.key ?? null)).toEqual(['HI-1', 'AM-1', 'HI-2', null])
    // As the Agent API reads them, and the board lists them.
    expect((await inWorkspace(w, () => tasks.getTask(made[2].number, w))).key).toBe('HI-2')
    expect((await inWorkspace(w, () => tasks.allTasks(w))).map((c) => c.key ?? `#${c.number}`).sort()).toEqual(['#4', 'AM-1', 'HI-1', 'HI-2'])
    // Keys and numbers resolve, any case; a key nobody has, nothing.
    for (const [ref, want] of [['HI-2', made[2].number], ['hi-2', made[2].number], ['AM-1', made[1].number], [`#${made[3].number}`, made[3].number], [made[0].number, made[0].number], ['HI-9', null], ['ZZ-1', null]] as [string | number, number | null][]) expect({ ref, got: keys.cardOfRef(w, ref) }).toEqual({ ref, got: want })
    await close(w)
  })

  it("a project added later gets a key no other has, and none begins another's", async () => {
    const ws = workspace(['hive', 'history'])
    const w = await open(ws)
    await keys.keyProjects(w)
    expect([await keyOf(w, 'history'), await keyOf(w, 'hive')]).toEqual(['HI', 'HV'])
    await close(w)
  })
})

describe('key changes, and cards moved between projects', () => {
  it('a key changed: the cards show it, the old one still resolves, and a key another project had stays theirs', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'amberlight' }, user))
    expect(await keys.changeProjectKey(w, join(ws, 'amberlight'), 'amb')).toBe('AMB')
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).key).toBe('AMB-1')
    expect([keys.cardOfRef(w, 'AMB-1'), keys.cardOfRef(w, 'AM-1')]).toEqual([c.number, c.number])
    // Another project can't take AM (amberlight's alias), nor anything that begins AMB or that AMB begins.
    await expect(keys.changeProjectKey(w, join(ws, 'hive'), 'AM')).rejects.toThrow(/another project’s key/)
    await expect(keys.changeProjectKey(w, join(ws, 'hive'), 'AMBE')).rejects.toThrow(/begin alike/)
    await expect(keys.changeProjectKey(w, join(ws, 'hive'), 'H')).rejects.toThrow(/2 to 4 letters/)
    // Its own old key is its key again.
    expect(await keys.changeProjectKey(w, join(ws, 'amberlight'), 'AM')).toBe('AM')
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).key).toBe('AM-1')
    expect(keys.cardOfRef(w, 'AMB-1')).toBe(c.number)
    await close(w)
  })

  it('a card moved to another project takes its next number there, its old key an alias; back again, its old number', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const [a, b] = await inWorkspace(w, async () => [await tasks.createTask({ title: 'A', project: 'hive' }, user), await tasks.createTask({ title: 'B', project: 'amberlight' }, user)])
    const moved = await inWorkspace(w, () => tasks.updateTask(a.number, { project: 'amberlight' }, user))
    expect(moved.key).toBe('AM-2')
    expect([keys.cardOfRef(w, 'HI-1'), keys.cardOfRef(w, 'AM-2'), keys.cardOfRef(w, 'AM-1')]).toEqual([a.number, a.number, b.number])
    // A new card of hive never takes HI-1 (its alias).
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'hive' }, user))).key).toBe('HI-2')
    const back = await inWorkspace(w, () => tasks.updateTask(a.number, { project: 'hive' }, user))
    expect(back.key).toBe('HI-1')
    expect(keys.cardOfRef(w, 'AM-2')).toBe(a.number)
    await close(w)
  })

  it("a change undone part way (a write that fails) leaves the project's counter where it was", async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'hive' }, user))
    store.boardTestHooks.failPut = () => true
    await expect(inWorkspace(w, () => tasks.createTask({ title: 'Lost', project: 'hive' }, user))).rejects.toThrow()
    store.boardTestHooks.failPut = null
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'hive' }, user))).key).toBe('HI-2')
    await close(w)
  })
})

describe('the 1.0 step: keys for a 0.9 board', () => {
  it('existing cards keep their numbers in their project, each counter carries on, and every old #N resolves', async () => {
    const ws = workspace()
    let w = await open(ws)
    const made = await inWorkspace(w, async () => {
      const out: number[] = []
      for (const [title, project] of [['One', 'hive'], ['Two', 'amberlight'], ['Three', 'hive'], ['Four', '']]) out.push((await tasks.createTask({ title, project }, user)).number)
      return out
    })
    await close(w)
    as09(store.boardFile(ws))
    store.boardTestHooks.upgradeAnswer = 'yes'
    w = await open(ws)
    const read = await inWorkspace(w, () => tasks.allTasks(w))
    const byNumber = new Map(read.map((c) => [c.number, c.key ?? null]))
    expect(made.map((m) => byNumber.get(m))).toEqual([`HI-${made[0]}`, `AM-${made[1]}`, `HI-${made[2]}`, null])
    for (const m of made) expect(keys.cardOfRef(w, `#${m}`)).toBe(m)
    expect(keys.cardOfRef(w, `HI-${made[2]}`)).toBe(made[2])
    // Each project's counter goes on from its highest.
    const next = await inWorkspace(w, () => tasks.createTask({ title: 'Five', project: 'hive' }, user))
    expect(next.key).toBe(`HI-${made[2] + 1}`)
    // Said once, quietly.
    expect(store.keysNoticeDue(w)).toBe(true)
    keys.sayKeysOnce(w)
    await expect.poll(() => store.keysNoticeDue(w)).toBe(false)
    await close(w)
  })
})

const live = process.env.HIVE_KEYS_LIVE_DB
describe.skipIf(!live)("the keys step on a copy of a live board's hive.db (HIVE_KEYS_LIVE_DB)", () => {
  it('gives each project with cards a key, and every card that has a project its own number there: every old #N resolves', () => {
    const copy = join(base, `live-${++n}.db`)
    copyFileSync(live!, copy)
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${copy}-wal`)
    // The board's 1.0 group as the upgrade runs it (the cards step before the keys step), on the copy.
    const opened2 = openDb(copy, { migrations: store.BOARD_MIGRATIONS, hiveVersion: '1.0.0-test', approve: () => true })
    try {
      const r = opened2.reader
      const cards = r.prepare('SELECT number, project_id, project_number FROM cards').all() as { number: number; project_id: string | null; project_number: number | null }[]
      const withProject = cards.filter((c) => c.project_id)
      expect(withProject.every((c) => c.project_number === c.number)).toBe(true)
      const k = keysStep.currentKeys(r)
      console.log(`live copy: ${cards.length} cards, ${withProject.length} with a project; keys ${[...k.values()].sort().join(', ')}`)
      for (const c of withProject) expect(keysStep.cardOfKey(r, k.get(c.project_id!)!, c.number)).toBe(c.number)
    } finally {
      opened2.close()
    }
  })
})
