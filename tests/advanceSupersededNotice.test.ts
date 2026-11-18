// HI-3367 (HR1's round 1, finding 3): the superseded notice through its real delivery. The host's write commits the
// marker and the `comment` action together; the actions worker's comment handler (workflowNotices.ts, commentAsCombwork)
// writes it on the card once, its id the action's, on an archived card too (the notice replaces the question it lost):
// a run again after a restart (the workspace closed and opened again, the action pending again) writes nothing more. A
// write of the host's that fails commits neither; a second call finds the marker ('already') and adds no action.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

const base = tempDir('cw-superseded-notice-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const worker = await import('../src/main/workflow/actionWorker')
const notices = await import('../src/main/workflowNotices')
const service = await import('../src/main/workflow/service')
const { advanceHostOf, supersededKey } = await import('../src/main/workflow/advanceHost')
const { advanced } = await import('../src/main/advanced')
const { allOff } = await import('../src/shared/workflow/options')
advanced.load(join(base, 'profile'))
notices.initWorkflowNotices()

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  advanced.stop()
  for (const w of opened) await disposeWorkspaceService(w).catch(() => undefined)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
let n = 0

async function open(ws: string): Promise<WS> {
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return w
}

/** A workspace with a Git project `p` (the host is the generic workflow's: no platform runs here). */
async function workspace(): Promise<{ w: WS; ws: string; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = gitRepo(join(ws, 'p'))
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  commit(repo, {}, 'ignore .combwork')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, agents: [], workflow: { platform: 'git', preset: null, options: allOff('git') } }))
  return { w: await open(ws), ws, repo }
}

const notes = async (w: WS, c: number) => (await inWorkspace(w, () => tasks.getTask(c))).comments.filter((x) => x.by === 'Combwork' && /was never settled/.test(x.text))
const actions = (ws: string, c: number) => store.workspaceDb(ws).reader.prepare("SELECT id, state FROM card_actions WHERE card = ? AND kind = 'comment'").all(c) as { id: number; state: string }[]
const run = async (w: WS): Promise<void> => {
  await worker.runActions(w)
  await worker.actionsSettled()
}

describe('the superseded notice, delivered by the actions worker (HI-3367)', () => {
  it('one write commits the marker and the comment action; the worker writes one comment; after a restart a run again writes none', async () => {
    const { w, ws, repo } = await workspace()
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p' }, user))).number
    const wf = (await service.workflowFor(w, repo))!
    const host = advanceHostOf(wf)
    const card = wf.store.card(c)
    expect(await host.superseded(card, { cycle: 3, attempt: 'a1' }, { target: 'main' })).toBe('recorded')
    expect(wf.store.meta(supersededKey(card.key, 3, 'a1'))).toBeTruthy()
    // A retry (the archive failed after it): the marker found, nothing more written.
    expect(await host.superseded(card, { cycle: 3, attempt: 'a1' }, { target: 'main' })).toBe('already')
    expect(actions(ws, c)).toHaveLength(1)
    await run(w)
    const said = await notes(w, c)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatchObject({ id: `action-${actions(ws, c)[0].id}`, appText: { id: 'workflow.forYou.advanceSuperseded' } })
    expect(said[0].text).toContain(`${card.key} into main`)
    // A restart: the workspace closed and opened again, the action found pending (a crash before its mark), run again.
    const id = actions(ws, c)[0].id
    store.workspaceDb(ws).writer.prepare("UPDATE card_actions SET state = 'pending' WHERE id = ?").run(id)
    await disposeWorkspaceService(w)
    const again = await open(ws)
    await run(again)
    expect(actions(ws, c)).toEqual([{ id, state: 'done' }])
    expect(await notes(again, c)).toHaveLength(1)
  })

  it('an archived card gets its notice all the same; a pre-mutation attempt (no warning) writes the marker alone; a failed write commits nothing', async () => {
    const { w, ws, repo } = await workspace()
    const c = (await inWorkspace(w, () => tasks.createTask({ title: 'Work', project: 'p' }, user))).number
    await inWorkspace(w, () => tasks.archiveTask(c, true))
    const wf = (await service.workflowFor(w, repo))!
    const host = advanceHostOf(wf)
    const card = wf.store.card(c)
    expect(await host.superseded(card, { cycle: 5, attempt: 'a2' }, { target: 'main' })).toBe('recorded')
    await run(w)
    expect(await notes(w, c)).toHaveLength(1)
    // Pre-mutation: its marker, no action.
    expect(await host.superseded(card, { cycle: 5, attempt: 'a3' }, null)).toBe('recorded')
    expect(wf.store.meta(supersededKey(card.key, 5, 'a3'))).toBeTruthy()
    expect(actions(ws, c)).toHaveLength(1)
    // A write that fails: 'failed', no marker, no action (the journal stays live, tried again).
    const write = wf.write.bind(wf)
    wf.write = (() => Promise.reject(new Error('the board refused the change'))) as typeof wf.write
    try {
      expect(await host.superseded(card, { cycle: 5, attempt: 'a4' }, { target: 'main' })).toBe('failed')
    } finally {
      wf.write = write
    }
    expect(wf.store.meta(supersededKey(card.key, 5, 'a4'))).toBeNull()
    expect(actions(ws, c)).toHaveLength(1)
  })
})
