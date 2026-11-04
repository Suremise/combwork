// A generalist and the slots (HI-686, SPEC §16.10.6): it isn't counted in the slot pool's size (a builder is), yet a
// card it takes is built where the project's options say, its start lent a slot as a builder's is; a reviewer's start
// is lent none. The workspace, its board, the pool and git are real; the rules are on; no session is started.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

vi.mock('../src/main/workflow/service', async (orig) => ({ ...(await orig<object>()), workflowEnforced: () => true }))

const base = tempDir('generalistslots-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const { leaseForStart, startSlotCards, stopSlotCards } = await import('../src/main/slotCards')
const { builderCountOf } = await import('../src/main/slots')
const tasks = await import('../src/main/tasks')
const { DEFAULT_PROJECT_CONFIG } = await import('../src/shared/defaults')

const wsPath = join(base, 'ws')
const project = join(wsPath, 'alpha')
const ws = createWorkspaceService()
let projectId = 'p1'

/** B1 builds, G1 is a generalist, R1 reviews. */
function writeProject(): void {
  const agents = [
    { id: 'b1', name: 'B1', provider: 'claude-code', workflowRole: 'builder' },
    { id: 'g1', name: 'G1', provider: 'claude-code', workflowRole: 'generalist' },
    { id: 'r1', name: 'R1', provider: 'claude-code', workflowRole: 'reviewer' }
  ]
  writeFileSync(join(project, '.combwork', 'project.json'), JSON.stringify({ ...DEFAULT_PROJECT_CONFIG, id: projectId, agents }))
}
const run = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(ws, fn)

beforeAll(async () => {
  gitRepo(project)
  commit(project, { '.gitignore': '.combwork/\n', 'a.txt': 'a\n' }, 'first')
  mkdirSync(join(project, '.combwork'), { recursive: true })
  writeProject()
  await ws.open(wsPath)
  projectId = (await ws.projectConfig(project)).id ?? 'p1'
  writeProject()
  await ws.refresh()
  startSlotCards()
})

afterAll(async () => {
  stopSlotCards()
  await disposeWorkspaceService(ws)
})

describe('a generalist and the slots (HI-686)', () => {
  it("isn't counted in the slot pool's size: the builders are", async () => {
    expect(await run(async () => builderCountOf(project, () => -1))).toBe(1)
  })

  it("a card it takes is lent a slot as a builder's is; a reviewer's start is lent none", async () => {
    const card = await run(() => tasks.createTask({ title: 'General work', project: 'alpha', agent: 'g1' }, { kind: 'user' }))
    const g = await run(() => leaseForStart(ws, project, { id: card.number }, 'g1', { dry: true, target: 'main' }))
    expect(g && 'slot' in g ? typeof g.slot : g).toBe('string')
    const r = await run(() => leaseForStart(ws, project, { id: card.number }, 'r1', { dry: true, target: 'main' }))
    expect(r).toBeNull()
  })
})
