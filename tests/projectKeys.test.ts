// Project keys (#1219, #704; SPEC §16.12): the suggestion and its rules (2–4 letters, unique, none a prefix of another,
// case-insensitive), the 1.0 step (an existing card keeps its number in its project, HI-1061; every old #N still resolves),
// new cards numbered per project, a key changed (the old one an alias), a card moved to another project (its old key an
// alias, its number there again when it comes back), a counter after a change undone part way, and references for the
// Agent API (`HI-12`, `hi-12`, `#12`, 12). CW_KEYS_LIVE_DB=<a combwork.db> runs the step on a copy of that board.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { as09 } from './boardDb'
import { cardName, cardRef, keyProblem, suggestKey, type KeyHeld } from '../src/shared/projectKeys'
import { cardChange, limitLine, releasedLine, wakeLine } from '../src/shared/watch'
import { inboxText } from '../src/shared/deliveries'
import { taskPrompt } from '../src/shared/tasks'
import { taskRow, taskRowText } from '../src/shared/toolReplies'
import { unexpectedCloseText } from '../src/shared/unexpectedClose'

const base = tempDir('cw-keys-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const keys = await import('../src/main/projectKeys')
const keysStep = await import('../src/main/schema/keysStep')
const { openDb } = await import('../src/main/db')
const { staleWhy } = await import('../src/main/deliveries')

// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15000
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
function workspace(projects = ['hike', 'ambrosia']): string {
  const ws = join(base, `ws-${++n}`)
  for (const p of projects) {
    mkdirSync(join(ws, p, '.combwork'), { recursive: true })
    writeFileSync(join(ws, p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
  }
  return ws
}
const keyOf = (w: WS, project: string): Promise<string | null> => keys.projectKeyOf(w, join(w.path!, project))

describe('suggested keys and their rules', () => {
  const held = (...ks: [string, string][]): KeyHeld[] => ks.map(([key, projectId]) => ({ key, projectId }))

  it("a workspace's projects: HI, AM, AP, MC and WE", () => {
    const got: KeyHeld[] = []
    for (const [name, id] of [['hike', 'p1'], ['ambrosia', 'p2'], ['apiary', 'p3'], ['mcp', 'p4'], ['website', 'p5']]) got.push({ key: suggestKey(name, id, got), projectId: id })
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
    expect(suggestKey('hike', 'p1', held(['HI', 'p1']))).toBe('HI')
  })

  it('a key is 2–4 letters A–Z, not another project’s (now or before), and neither begins the other; case-insensitive', () => {
    const h = held(['HI', 'p1'], ['AMB', 'p2'])
    expect(keyProblem('H', 'p3', h)).toBe('form')
    expect(keyProblem('HIKES','p3', h)).toBe('form')
    expect(keyProblem('H1', 'p3', h)).toBe('form')
    expect(keyProblem('hi', 'p3', h)).toBe('taken')
    expect(keyProblem('AM', 'p3', h)).toBe('prefix')
    expect(keyProblem('HIV', 'p3', h)).toBe('prefix')
    expect(keyProblem('ap', 'p3', h)).toBeNull()
    expect(keyProblem('HIV', 'p1', h)).toBeNull()
  })

  it('a card is named by its key alone (HI-1661), its number only when it has none', () => {
    expect(cardName({ number: 1240, key: 'HI-1230' })).toBe('HI-1230')
    expect(cardName({ number: 12 })).toBe('#12')
  })
})

describe('a new workspace: keys at its first open, cards numbered per project', () => {
  it('each project gets its key; its cards count from 1, whatever their numbers on the board', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    expect([await keyOf(w, 'hike'), await keyOf(w, 'ambrosia')]).toEqual(['HI', 'AM'])
    const made = await inWorkspace(w, async () => {
      const a = await tasks.createTask({ title: 'A', project: 'hike' }, user)
      const b = await tasks.createTask({ title: 'B', project: 'ambrosia' }, user)
      const c = await tasks.createTask({ title: 'C', project: 'hike' }, user)
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

  it('New Project…: the key chosen, refused before the folder is made when it can’t be one, or the suggestion (#1221)', async () => {
    const ws = workspace(['hike'])
    const w = await open(ws)
    await keys.keyProjects(w)
    await keys.createProjectWithKey(w, 'web-app', 'wb')
    expect(await keyOf(w, 'web-app')).toBe('WB')
    for (const [name, key, why] of [['taken', 'HI', /another project’s key/], ['prefix', 'HIV', /begin alike/], ['form', 'H1', /2 to 4 letters/]] as const) {
      await expect(keys.createProjectWithKey(w, name, key)).rejects.toThrow(why)
      expect(existsSync(join(ws, name))).toBe(false)
    }
    await keys.createProjectWithKey(w, 'ambrosia', null)
    expect(await keyOf(w, 'ambrosia')).toBe('AM')
    await close(w)
  })

  it("New Project…'s reply lists the project it made, which the window opens, even when its project.json is written during the refresh (HI-1760)", async () => {
    const ws = workspace(['hike'])
    const w = await open(ws)
    await keys.keyProjects(w)
    const info = await keys.createProjectWithKey(w, 'fresh', null)
    expect(info.projects.map((p) => p.name)).toContain('fresh')
    // Its id was given before the refresh read it: none is given (written) meanwhile.
    expect(JSON.parse(readFileSync(join(ws, 'fresh', '.combwork', 'project.json'), 'utf8')).id).toMatch(/^p-/)
    // A write to the new project's project.json after the refresh has read it and before it reports (as the id's was,
    // since HI-1705's parallel reads): the refresh hands back the list from before (#999), and New Project waits for the
    // one that write scheduled. Before the fix the reply had no project, and the window stayed on the one shown.
    const raced = join(ws, 'raced')
    const svc = w as unknown as { projectInfo: (...a: unknown[]) => Promise<{ path: string }> }
    const read = svc.projectInfo.bind(w)
    let wrote = false
    svc.projectInfo = async (...a) => {
      const p = await read(...a)
      if (!wrote && p.path.toLowerCase() === raced.toLowerCase()) {
        wrote = true
        await w.mutateProjectConfig(p.path, () => ({}))
      }
      return p
    }
    const again = await keys.createProjectWithKey(w, 'raced', 'RC')
    expect(wrote).toBe(true)
    expect(again.projects.map((p) => p.name)).toEqual(expect.arrayContaining(['hike', 'fresh', 'raced']))
    await close(w)
  })

  it('New Project… made while its workspace gives way to another (one with a project of the same name) is refused, never answered with that one (HI-1760, HR5 round 1)', async () => {
    type Svc = { projectIds: (o?: { fresh?: boolean }) => Promise<unknown>; refreshesSettled: () => Promise<void>; projectInfo: (...a: unknown[]) => Promise<{ path: string }> }
    /** Holds the next call of `method` until released; `reached` resolves once it is held. */
    const hold = (w: WS, method: 'projectIds' | 'refreshesSettled', when: (a: unknown[]) => boolean = () => true) => {
      const svc = w as unknown as Svc
      const real = (svc[method] as (...a: unknown[]) => Promise<unknown>).bind(w)
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const at = new Promise<void>((r) => (reached = r))
      let held = false
      ;(svc as unknown as Record<string, unknown>)[method] = async (...a: unknown[]) => {
        if (!held && when(a)) {
          held = true
          reached()
          await gate
        }
        return real(...a)
      }
      return { reached: at, release: () => release() }
    }
    // Held at its id; meanwhile the window opens B, which has a "fresh" of its own.
    const a = workspace(['hike'])
    const b = workspace(['hike', 'fresh'])
    const w = await open(a)
    const atIds = hold(w, 'projectIds', (args) => !!(args[0] as { fresh?: boolean } | undefined)?.fresh)
    const creating = w.createProject('fresh')
    await atIds.reached
    await w.open(b)
    atIds.release()
    await expect(creating).rejects.toThrow(/closed/)
    // Held where it waits for the refresh a write meanwhile scheduled (its reply was the list from before).
    const c = workspace(['hike'])
    await w.open(c)
    const svc = w as unknown as Svc
    const read = svc.projectInfo.bind(w)
    let wrote = false
    svc.projectInfo = async (...args) => {
      const p = await read(...args)
      if (!wrote && p.path.toLowerCase() === join(c, 'fresh').toLowerCase()) {
        wrote = true
        await w.mutateProjectConfig(p.path, () => ({}))
      }
      return p
    }
    const atSettled = hold(w, 'refreshesSettled')
    const creating2 = w.createProject('fresh')
    await atSettled.reached
    await w.open(b)
    atSettled.release()
    await expect(creating2).rejects.toThrow(/closed/)
    expect(wrote).toBe(true)
    await close(w)
  })

  it('a key chosen for a project being made is reserved: a key change or another new project meanwhile is refused it (round 1, finding 2)', async () => {
    const ws = workspace(['hike'])
    const w = await open(ws)
    await keys.keyProjects(w)
    // web-app's folder is made only when the test says so.
    const make = w.createProject.bind(w)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    w.createProject = async (name: string) => {
      await held
      return make(name)
    }
    const creating = keys.createProjectWithKey(w, 'web-app', 'ZZ')
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'ZZ')).rejects.toThrow(/ZZ is another project’s key/)
    await expect(keys.createProjectWithKey(w, 'other', 'ZZ')).rejects.toThrow(/ZZ is another project’s key/)
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'ZZA')).rejects.toThrow(/begin alike/)
    expect(existsSync(join(ws, 'other'))).toBe(false)
    release()
    await creating
    expect([await keyOf(w, 'web-app'), await keyOf(w, 'hike')]).toEqual(['ZZ', 'HI'])
    w.createProject = make
    // The reservation ends once it is made: the key is web-app's now.
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'ZZ')).rejects.toThrow(/ZZ is another project’s key/)
    await close(w)
  })

  it('a reservation is its workspace’s own: another workspace changes a key to it, or makes a project with it, meanwhile (round 2, finding 1)', async () => {
    const [wsA, wsB, wsC] = [workspace(['hike']), workspace(['hike']), workspace(['hike'])]
    const [a, b, c] = [await open(wsA), await open(wsB), await open(wsC)]
    for (const w of [a, b, c]) await keys.keyProjects(w)
    const make = a.createProject.bind(a)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    a.createProject = async (name: string) => {
      await held
      return make(name)
    }
    const creating = keys.createProjectWithKey(a, 'web-app', 'ZZ')
    // B's and C's keys are their own: ZZ is free there, for a new project and for a key change.
    await keys.createProjectWithKey(b, 'other', 'ZZ')
    await keys.changeProjectKey(c, join(wsC, 'hike'), 'ZZ')
    expect([await keyOf(b, 'other'), await keyOf(c, 'hike')]).toEqual(['ZZ', 'ZZ'])
    // …and in A, the reservation still holds.
    await expect(keys.changeProjectKey(a, join(wsA, 'hike'), 'ZZ')).rejects.toThrow(/ZZ is another project’s key/)
    release()
    await creating
    expect([await keyOf(a, 'web-app'), await keyOf(a, 'hike')]).toEqual(['ZZ', 'HI'])
    a.createProject = make
    for (const w of [a, b, c]) await close(w)
  })

  it("a moved card's names in the project it left, for the window: under each key that project holds or held (round 1, finding 1)", async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const h = await inWorkspace(w, () => tasks.createTask({ title: 'H', project: 'hike' }, user))
    await inWorkspace(w, () => tasks.updateTask(h.number, { project: 'ambrosia' }, user))
    expect(store.movedNames(w)).toEqual({ 'HI-1': h.number })
    await keys.changeProjectKey(w, join(ws, 'hike'), 'HX')
    expect(store.movedNames(w)).toEqual({ 'HI-1': h.number, 'HX-1': h.number })
    await close(w)
  })

  it("a project added later gets a key no other has, and none begins another's", async () => {
    const ws = workspace(['hike', 'hidden'])
    const w = await open(ws)
    await keys.keyProjects(w)
    expect([await keyOf(w, 'hidden'), await keyOf(w, 'hike')]).toEqual(['HI', 'HK'])
    await close(w)
  })
})

describe('key changes, and cards moved between projects', () => {
  it('a key changed: the cards show it, the old one still resolves, and a key another project had stays theirs', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'ambrosia' }, user))
    expect(await keys.changeProjectKey(w, join(ws, 'ambrosia'), 'amb')).toBe('AMB')
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).key).toBe('AMB-1')
    expect([keys.cardOfRef(w, 'AMB-1'), keys.cardOfRef(w, 'AM-1')]).toEqual([c.number, c.number])
    // Another project can't take AM (ambrosia's alias), nor anything that begins AMB or that AMB begins.
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'AM')).rejects.toThrow(/another project’s key/)
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'AMBE')).rejects.toThrow(/begin alike/)
    await expect(keys.changeProjectKey(w, join(ws, 'hike'), 'H')).rejects.toThrow(/2 to 4 letters/)
    // Its own old key is its key again.
    expect(await keys.changeProjectKey(w, join(ws, 'ambrosia'), 'AM')).toBe('AM')
    expect((await inWorkspace(w, () => tasks.getTask(c.number, w))).key).toBe('AM-1')
    expect(keys.cardOfRef(w, 'AMB-1')).toBe(c.number)
    await close(w)
  })

  it('a card moved to another project takes its next number there, its old key an alias; back again, its old number', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const [a, b] = await inWorkspace(w, async () => [await tasks.createTask({ title: 'A', project: 'hike' }, user), await tasks.createTask({ title: 'B', project: 'ambrosia' }, user)])
    const moved = await inWorkspace(w, () => tasks.updateTask(a.number, { project: 'ambrosia' }, user))
    expect(moved.key).toBe('AM-2')
    expect([keys.cardOfRef(w, 'HI-1'), keys.cardOfRef(w, 'AM-2'), keys.cardOfRef(w, 'AM-1')]).toEqual([a.number, a.number, b.number])
    // A new card of hike never takes HI-1 (its alias).
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'C', project: 'hike' }, user))).key).toBe('HI-2')
    const back = await inWorkspace(w, () => tasks.updateTask(a.number, { project: 'hike' }, user))
    expect(back.key).toBe('HI-1')
    expect(keys.cardOfRef(w, 'AM-2')).toBe(a.number)
    await close(w)
  })

  it("a change undone part way (a write that fails) leaves the project's counter where it was", async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'hike' }, user))
    store.boardTestHooks.failPut = () => true
    await expect(inWorkspace(w, () => tasks.createTask({ title: 'Lost', project: 'hike' }, user))).rejects.toThrow()
    store.boardTestHooks.failPut = null
    expect((await inWorkspace(w, () => tasks.createTask({ title: 'B', project: 'hike' }, user))).key).toBe('HI-2')
    await close(w)
  })
})

describe("key writes stay in the workspace they began in (round 1, finding 1)", () => {
  it('a key given or changed while the window opens another workspace is written in neither', async () => {
    const a = workspace()
    const b = workspace(['other'])
    const w = await open(a)
    const idsOfA = await w.projectIds()
    // The projects' ids are read, and held there while the window opens the other workspace.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const read = w.projectIds.bind(w)
    w.projectIds = (async () => (await held, idsOfA)) as typeof w.projectIds
    const giving = keys.keyProjects(w)
    const changing = keys.changeProjectKey(w, join(a, 'hike'), 'HV')
    // Both have asked (each reads the ids first); the window's own reads are as usual from here.
    w.projectIds = read
    await w.open(b)
    release()
    expect(await giving).toEqual([])
    await expect(changing).rejects.toThrow(/workspace was closed/)
    // The workspace open now has none of A's projects' keys; A has none either.
    expect(store.projectKeys(w)).toEqual([])
    const wa = await open(a)
    expect(store.projectKeys(wa)).toEqual([])
    await close(wa)
    await close(w)
  })
})

describe("another project's card, for an agent confined to its own (round 1, finding 4)", () => {
  it('its key resolves as a key no card has, before and after a key change and a move; and is never named by key', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const [h, a] = await inWorkspace(w, async () => [await tasks.createTask({ title: 'H', project: 'hike' }, user), await tasks.createTask({ title: 'A', project: 'ambrosia' }, user)])
    const asCombwork = (ref: string): number | null => keys.cardOfRef(w, ref, 'hike')
    expect([asCombwork('HI-1'), asCombwork('AM-1'), asCombwork('AM-99')]).toEqual([h.number, null, null])
    await keys.changeProjectKey(w, join(ws, 'ambrosia'), 'AMB')
    expect([asCombwork('AM-1'), asCombwork('AMB-1')]).toEqual([null, null])
    // Moved to hike: now its; its old keys find it for hike's agents, as they do for the Assistant.
    await inWorkspace(w, () => tasks.updateTask(a.number, { project: 'hike' }, user))
    expect([asCombwork('AMB-1'), asCombwork('HI-2'), keys.cardOfRef(w, 'AMB-1')]).toEqual([a.number, a.number, a.number])
    // Names: by key only within the scope.
    expect(keys.cardNamesOf(w, 'ambrosia')(h.number)).toBe(`#${h.number}`)
    expect(keys.cardNamesOf(w, 'hike')(h.number)).toBe('HI-1')
    expect(keys.cardNamesOf(w)(h.number)).toBe('HI-1')
    await close(w)
  })

  it('by the project a card is in now, by its id: renamed, its own; another project in its old folder, not (round 2, finding 2)', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const h = await inWorkspace(w, () => tasks.createTask({ title: 'H', project: 'hike' }, user))
    // hike renamed hikers (its id goes with it); a new project takes the folder hike.
    renameSync(join(ws, 'hike'), join(ws, 'hikers'))
    mkdirSync(join(ws, 'hike', '.combwork'), { recursive: true })
    writeFileSync(join(ws, 'hike', '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent 1' }] }))
    await w.projectIds({ fresh: true })
    // The card as saved still says hike: the board's readers follow its id, and so must keys.
    expect(store.cardKeyOf(w, h.number)?.project).toBe('hike')
    expect((await inWorkspace(w, () => tasks.getTask(h.number, w))).project).toBe('hikers')
    expect([keys.cardOfRef(w, 'HI-1', 'hikers'), keys.cardOfRef(w, `#${h.number}`, 'hikers')]).toEqual([h.number, h.number])
    expect([keys.cardOfRef(w, 'HI-1', 'hike'), keys.cardOfRef(w, 'HI-1', 'ambrosia'), keys.cardOfRef(w, 'HI-9', 'hikers')]).toEqual([null, null, null])
    // Its old key after a key change too.
    await keys.changeProjectKey(w, join(ws, 'hikers'), 'HM')
    expect([keys.cardOfRef(w, 'HI-1', 'hikers'), keys.cardOfRef(w, 'HM-1', 'hikers'), keys.cardOfRef(w, 'HM-1', 'hike'), keys.cardOfRef(w, 'HI-1', 'hike')]).toEqual([h.number, h.number, null, null])
    expect(keys.cardNamesOf(w, 'hikers')(h.number)).toBe('HM-1')
    expect(keys.cardNamesOf(w, 'hike')(h.number)).toBe(`#${h.number}`)
    await close(w)
  })
})

describe('wakes, the inbox and replies name cards by key (round 1, finding 3)', () => {
  it('lines made for a workspace name a card by key alone, "HI-1" (HI-1661); without one, #N as before', async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'A', project: 'hike' }, user))
    const name = 'HI-1'
    const named = <T>(fn: () => T): T => keys.withCardNames(w, fn)
    expect(named(() => wakeLine(cardChange(c.number, c, ['column'])))).toContain(`[CW] ${name} is in Todo`)
    expect(named(() => limitLine({ cards: [c.number], changes: ['column'] }, 60))).toContain(`No change on ${name}`)
    expect(named(() => releasedLine([{ number: c.number, why: 'reassigned', detail: 'B1' }]))).toContain(`${name} was reassigned`)
    expect(named(() => inboxText([{ ids: ['m1'], from: 'Combwork', card: c.number, text: 'changed', at: '', state: 'received' } as never], []))).toContain(`· ${name}:`)
    expect(named(() => staleWhy(null, c.number, 1))).toBe(`${name} is gone`)
    expect(named(() => taskPrompt(c, true))).toContain(`Work on task ${name}`)
    expect(named(() => wakeLine(cardChange(c.number, c, ['column'])))).not.toContain(`#${c.number}`)
    // The work of the workspace's window (HI-1661: its errors, notices and history lines) names it by key too.
    expect(inWorkspace(w, () => cardRef(c.number))).toBe('HI-1')
    // Outside any workspace (the combwork MCP server without names): its number, the only name it knows.
    expect(wakeLine(cardChange(c.number, c, ['column']))).toContain(`[CW] #${c.number} is in Todo`)
    // A text the combwork MCP server words gets the names with its JSON.
    const row = named(() => taskRow({ ...c, agent: null, stalled: null, blockedBy: [c.number] } as never))
    expect(taskRowText(row)).toContain(`after ${name}`)
    expect(taskRowText({ ...row, names: undefined })).toContain(`after #${c.number}`)
    await close(w)
  })

  it("a slot kept for a card in flight names it by key, its digits not the workspace number's (HI-1661 round 1, finding 2)", async () => {
    const ws = workspace()
    const w = await open(ws)
    await keys.keyProjects(w)
    // ambrosia's card takes #1, so hike's first card is HI-1 with the workspace number 2.
    const [, h] = await inWorkspace(w, async () => [await tasks.createTask({ title: 'A', project: 'ambrosia' }, user), await tasks.createTask({ title: 'H', project: 'hike' }, user)])
    expect([h.key, h.number]).toEqual(['HI-1', 2])
    const { keptText } = await import('../src/main/unusedWorktrees')
    // Outside any workspace's work, as Unused worktrees asks.
    expect(await keptText(join(ws, 'hike'), { why: 'inFlight', card: h.number } as never)).toBe('card HI-1, which it held, is still being merged')
    await close(w)
  })

  it("a crash notice's merges name their cards as each one's workspace does (HI-1661 round 1, finding 4)", async () => {
    // Two workspaces, each with its card #1, under different keys: one notice, told outside both.
    const [w1, w2] = [await open(workspace(['hike'])), await open(workspace(['ambrosia']))]
    for (const w of [w1, w2]) await keys.keyProjects(w)
    const [c1, c2] = [await inWorkspace(w1, () => tasks.createTask({ title: 'H', project: 'hike' }, user)), await inWorkspace(w2, () => tasks.createTask({ title: 'A', project: 'ambrosia' }, user))]
    expect([c1.number, c2.number]).toEqual([1, 1])
    const merge = (w: WS, name: string) => ({ agentName: name, branch: 'main', cards: [1], cardNames: [1].map(keys.cardNamesOf(w)), folder: w.path! })
    const text = unexpectedCloseText({ lastSeen: new Date().toISOString(), agents: [], dump: false, merges: [merge(w1, 'B1'), merge(w2, 'B2')] }, null)
    expect(text).toContain('B1 was merging main (HI-1)')
    expect(text).toContain('B2 was merging main (AM-1)')
    expect(text).not.toContain('#1')
    for (const w of [w1, w2]) await close(w)
  })

  it("every card argument of the Combwork tools takes a key as well as a number (Darren, 20 Oct: tools take a key string)", () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'mcp', 'cw-mcp.ts'), 'utf8')
    // No card argument is a number alone: a card is cardArg or cardsArg, or a number-or-string `before`.
    for (const m of src.matchAll(/(\w+): \{ type: 'number'[^}]*\}/g)) expect({ arg: m[1], card: /card|before/i.test(m[1]) }).toEqual({ arg: m[1], card: false })
    expect(src).toContain("items: { type: ['number', 'string'] }")
    expect(src.match(/number: cardArg/g)?.length).toBeGreaterThanOrEqual(3)
    expect(src).toContain('card: cardArg')
  })
})

describe('the 1.0 step: keys for a 0.9 board', () => {
  it('existing cards keep their numbers in their project, each counter carries on, and every old #N resolves', async () => {
    const ws = workspace()
    let w = await open(ws)
    const made = await inWorkspace(w, async () => {
      const out: number[] = []
      for (const [title, project] of [['One', 'hike'], ['Two', 'ambrosia'], ['Three', 'hike'], ['Four', '']]) out.push((await tasks.createTask({ title, project }, user)).number)
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
    const next = await inWorkspace(w, () => tasks.createTask({ title: 'Five', project: 'hike' }, user))
    expect(next.key).toBe(`HI-${made[2] + 1}`)
    // Said once, quietly.
    expect(store.keysNoticeDue(w)).toBe(true)
    keys.sayKeysOnce(w)
    await expect.poll(() => store.keysNoticeDue(w), { timeout: HUNG_MS }).toBe(false)
    await close(w)
  })
})

const live = process.env.CW_KEYS_LIVE_DB
describe.skipIf(!live)("the keys step on a copy of a live board's combwork.db (CW_KEYS_LIVE_DB)", () => {
  it('gives each project with cards a key, and every card that has a project its own number there: every old #N resolves', () => {
    const copy = join(base, `live-${++n}.db`)
    copyFileSync(live!, copy)
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${copy}-wal`)
    // The board's 1.0 group as the upgrade runs it (the cards step before the keys step), on the copy.
    const opened2 = openDb(copy, { migrations: store.BOARD_MIGRATIONS, appVersion: '1.0.0-test', approve: () => true })
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
