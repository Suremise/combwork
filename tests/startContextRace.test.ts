// A card changed while its Start checks its Read first references (#819): its references, project, column or agent
// changed, archived or deleted, the Start stops, launching and delivering nothing and leaving the newer card as it is; unchanged, it starts with the references it checked. The check is held
// at a barrier (checkDocRef) while the card is changed, so the race is reproduced every time, not by timing.
import { mkdirSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const gate = vi.hoisted(() => ({ active: false, entered: () => {}, wait: Promise.resolve() }))
vi.mock('../src/main/docSections', async (original) => {
  const actual = await original<typeof import('../src/main/docSections')>()
  return {
    ...actual,
    checkDocRef: async (...a: Parameters<typeof actual.checkDocRef>) => {
      if (gate.active) {
        gate.active = false
        gate.entered()
        await gate.wait
      }
      return actual.checkDocRef(...a)
    }
  }
})

const base = tempDir('hive-startcontext-')
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')
;(electron.shell as unknown as { trashItem: (p: string) => Promise<void> }).trashItem = (p) => rm(p, { recursive: true, force: true })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const { startTask } = await import('../src/main/taskStart')
const { sessions } = await import('../src/main/sessions')
const { deliveriesOf } = await import('../src/main/deliveries')

describe('a Start whose card changes while its references are checked', () => {
  let w: ReturnType<typeof createWorkspaceService>
  let alpha = ''
  let launched: { project: string; prompt: string }[] = []
  let release = (): void => {}
  const user = { kind: 'user' } as const
  beforeEach(async () => {
    const ws = tempDir('hive-startcontext-ws-')
    alpha = join(ws, 'alpha')
    for (const p of [alpha, join(ws, 'beta')]) {
      mkdirSync(join(p, '.combwork'), { recursive: true })
      writeFileSync(join(p, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [{ id: 'a1', name: 'Agent' }, { id: 'a2', name: 'Other' }] }))
      writeFileSync(join(p, 'PLAN.md'), '# Plan\n\n## Setup\n\nOLD-BRIEF.\n\n## Release\n\nShip.\n')
    }
    w = createWorkspaceService()
    await w.open(ws)
    launched = []
    vi.spyOn(sessions, 'start').mockImplementation(async (p: string, o: { prompt?: string }) => {
      launched.push({ project: p, prompt: String(o.prompt ?? '') })
      return { runId: `run-${launched.length}` } as never
    })
  })
  afterEach(() => {
    release()
    gate.active = false
    vi.restoreAllMocks()
    disposeWorkspaceService(w)
  })

  /** Starts the card, changes it with `change` while its references are being checked, and lets the check go on. */
  const raced = async (n: number, change: () => Promise<unknown>) => {
    gate.wait = new Promise<void>((r) => (release = r))
    const entered = new Promise<void>((r) => (gate.entered = r))
    gate.active = true
    const starting = startTask(n, { kind: 'agent', agentId: 'a1' }, user).then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, error: e.message })
    )
    await entered
    await change()
    release()
    return starting
  }
  const offered = async () => (await deliveriesOf(alpha, 'a1')).filter((d) => d.kind === 'task')

  it('moved to another project meanwhile: refused, nothing launched or delivered, the card left in its new project', async () => {
    await inWorkspace(w, async () => {
      const c = await tasks.createTask({ title: 'Probe', project: 'alpha', context: ['PLAN.md#setup'] }, user)
      const result = await raced(c.number, () => tasks.updateTask(c.number, { project: 'beta' }, user))
      expect(result).toEqual({ ok: false, error: expect.stringMatching(/changed while it was being started/) })
      expect(launched).toEqual([])
      expect(await offered()).toEqual([])
      const card = await tasks.getTask(c.number)
      expect(card.project).toBe('beta')
      expect(card.agent).toBeNull()
    })
  })

  it('its Read first edited meanwhile: refused, nothing launched, the edit kept and the card back where it was', async () => {
    await inWorkspace(w, async () => {
      const c = await tasks.createTask({ title: 'Probe', project: 'alpha', context: ['PLAN.md#setup'] }, user)
      const result = await raced(c.number, () => tasks.updateTask(c.number, { context: ['PLAN.md#release'] }, user))
      expect(result.ok).toBe(false)
      expect(launched).toEqual([])
      expect(await offered()).toEqual([])
      const card = await tasks.getTask(c.number)
      expect(card.context).toEqual(['PLAN.md#release'])
      expect(card.column).toBe('todo')
      expect(card.agent).toBeNull()
      // Started again, it goes with the list as it is now.
      await startTask(c.number, { kind: 'agent', agentId: 'a1' }, user)
      expect((await offered()).map((d) => d.body).join('\n')).toMatch(/first: PLAN\.md#release \(\d+ characters\)/)
    })
  })

  // #819 round 3: the card's whole claimed state counts, not only its references and project.
  for (const [what, change, kept] of [
    ['archived', (n: number) => tasks.archiveTask(n, true), (c: { archived: boolean }) => expect(c.archived).toBe(true)],
    ['moved to Done', (n: number) => tasks.updateTask(n, { column: 'done' }, user), (c: { column: string }) => expect(c.column).toBe('done')],
    ['moved to Review', (n: number) => tasks.updateTask(n, { column: 'review' }, user), (c: { column: string }) => expect(c.column).toBe('review')],
    ['given to another agent', (n: number) => tasks.updateTask(n, { agent: 'a2' }, user), (c: { agent: string | null; column: string }) => expect([c.agent, c.column]).toEqual(['a2', 'doing'])]
  ] as const) {
    it(`${what} meanwhile: refused, nothing launched or delivered, the newer state kept`, async () => {
      await inWorkspace(w, async () => {
        const c = await tasks.createTask({ title: 'Probe', project: 'alpha', context: ['PLAN.md#setup'] }, user)
        const result = await raced(c.number, () => change(c.number))
        expect(result).toEqual({ ok: false, error: expect.stringMatching(/changed while it was being started/) })
        expect(launched).toEqual([])
        expect(await offered()).toEqual([])
        ;(kept as (card: unknown) => void)(await tasks.getTask(c.number))
      })
    })
  }

  it('deleted meanwhile: refused, nothing launched or delivered', async () => {
    await inWorkspace(w, async () => {
      const c = await tasks.createTask({ title: 'Probe', project: 'alpha', context: ['PLAN.md#setup'] }, user)
      const result = await raced(c.number, () => tasks.deleteTask(c.number))
      expect(result.ok).toBe(false)
      expect(launched).toEqual([])
      expect(await offered()).toEqual([])
      await expect(tasks.getTask(c.number)).rejects.toThrow()
    })
  })

  it('unchanged meanwhile: started with the references it checked', async () => {
    await inWorkspace(w, async () => {
      const c = await tasks.createTask({ title: 'Probe', project: 'alpha', context: ['PLAN.md#setup', 'PLAN.md#gone'] }, user)
      const result = await raced(c.number, () => tasks.updateTask(c.number, { labels: ['x'] }, user))
      expect(result.ok).toBe(true)
      expect(launched).toHaveLength(1)
      expect(await offered()).toHaveLength(1)
      const sent = (await offered()).map((d) => d.body).join('\n')
      expect(sent).toMatch(/first: PLAN\.md#setup \(\d+ characters\)/)
      expect(sent).toContain('This reference no longer resolves: PLAN.md#gone')
      expect(sent).not.toContain('OLD-BRIEF')
      expect((await tasks.getTask(c.number)).contextProblems).toMatchObject([{ ref: 'PLAN.md#gone', problem: 'noHeading' }])
    })
  })
})
