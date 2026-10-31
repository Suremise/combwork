// Guards on an agent's new watch (HI-2197): a plain number that reads as another card's key is refused, naming both,
// never remapped (2189 was HI-2182's number while HB3's card was HI-2189); a number with no such key, `#N` and keys go
// on; a card outside the agent's project stays unknown. A watch is refused while Hive is giving the agent a card in a
// slot (its own start), as it would hold that placement off; and a start that leaves its placement due ends the
// caller's watch.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const slot = vi.hoisted(() => ({ due: null as null | { slot: string; lease: string } }))
vi.mock('../src/main/slotCards', async (orig) => ({ ...(await orig<object>()), placementDue: async () => slot.due }))

const base = tempDir('hive-watchguards-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { clashingNumber, watchWhilePlaced } = await import('../src/main/watchGuards')
const { closeAllBoards } = await import('../src/main/boardStore')
const { keyProjects } = await import('../src/main/projectKeys')

const user = { kind: 'user' } as const
const agent = { kind: 'agent', name: 'Builder (alpha)', self: { project: 'alpha', agentId: 'a1' }, scope: 'alpha' } as const
const wsPath = join(base, 'ws')
const p = join(wsPath, 'alpha')
let w: ReturnType<typeof createWorkspaceService>
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)
/** Cards by key, as created, and alpha's key. */
const made = new Map<string, number>()
let A = ''

beforeAll(async () => {
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(wsPath, name, '.hive'), { recursive: true })
    writeFileSync(join(wsPath, name, '.hive', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Builder' }] }))
  }
  w = createWorkspaceService()
  await w.open(wsPath)
  await keyProjects(w)
  // beta's cards first, so alpha's numbers run ahead of its keys: its key n is never #n.
  for (const project of ['beta', 'beta', 'beta', 'alpha', 'alpha', 'alpha', 'alpha']) {
    const c = await run(() => tasks.createTask({ title: `${project} card`, project, agent: 'a1' }, user))
    made.set(c.key!, c.number)
    if (project === 'alpha') A = c.key!.split('-')[0]
  }
})
afterAll(async () => {
  await disposeWorkspaceService(w)
  closeAllBoards()
})
beforeEach(() => {
  slot.due = null
})

/** The key of the card with this number. */
const keyOf = (n: number): string => [...made].find(([, m]) => m === n)![0]
const pCards = (): [string, number][] => [...made].filter(([k]) => k.startsWith(`${A}-`))

describe("an agent's plain number in a watch (HI-2197)", () => {
  it("refused where it reads as another card's key of its project, naming both; never remapped", async () => {
    // A number that is one alpha card's while another alpha card has the key <its key>-<that number>.
    const [, number] = pCards().find(([, n]) => made.has(`${A}-${n}`) && made.get(`${A}-${n}`) !== n)!
    const why = await run(() => clashingNumber(w, [number], agent))
    expect(why).toBe(`${number} is ${keyOf(number)}'s number (#${number}), not ${A}-${number}, which is another card. Name cards by key: "${A}-${number}" or "${keyOf(number)}".`)
    // As a string of digits too.
    expect(await run(() => clashingNumber(w, [String(number)], agent))).toBe(why)
  })

  it('a number no key of its project reads as, #N, a key and a script (no agent) go on as before', async () => {
    const [, plain] = pCards().find(([, n]) => !made.has(`${A}-${n}`))!
    expect(await run(() => clashingNumber(w, [plain], agent))).toBeNull()
    const [, clash] = pCards().find(([, n]) => made.has(`${A}-${n}`) && made.get(`${A}-${n}`) !== n)!
    expect(await run(() => clashingNumber(w, [`#${clash}`, keyOf(clash)], agent))).toBeNull()
    expect(await run(() => clashingNumber(w, undefined, agent))).toBeNull()
  })

  it("a number of another project's card stays unknown to the agent: nothing of it is named", async () => {
    const [foreignKey, foreign] = [...made].find(([k]) => !k.startsWith(`${A}-`))!
    await expect(run(() => clashingNumber(w, [foreign], agent))).rejects.toThrow(new RegExp(`#${foreign}`))
    await expect(run(() => clashingNumber(w, [foreign], agent))).rejects.not.toThrow(foreignKey)
  })
})

describe("a watch while Hive is giving the agent a card in a slot (HI-2197)", () => {
  it('refused, naming the card and slot, only while a placement of its own Active card is due', async () => {
    const [key, number] = pCards()[0]
    await run(() => tasks.updateTask(number, { column: 'doing' }, user))
    expect(await run(() => watchWhilePlaced(w, p, 'a1'))).toBeNull()
    slot.due = { slot: 'slot-b', lease: 'l-1' }
    expect(await run(() => watchWhilePlaced(w, p, 'a1'))).toBe(`Hive is giving you ${key} in slot-b: end your turn with no watch. The card comes to you as a task; a watch now would hold it off.`)
    // Another agent has no card coming.
    expect(await run(() => watchWhilePlaced(w, p, 'a2'))).toBeNull()
    await run(() => tasks.updateTask(number, { column: 'todo' }, user))
  })
})
