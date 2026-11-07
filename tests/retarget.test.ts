// HI-2680 (SPEC §16.5.4): when a project's Work merges into moves on (1.1.0 → 1.2.0), on the real board: the preview
// (what can follow the new target, what stays and why), the apply bound to it (each card only from the target it was
// seen with, the project's target still the new one, the caller still allowed), and the finished branch kept in Other
// branches work can merge into while anything records it, serial with a lane start on it.
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-retarget-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const retarget = await import('../src/main/workflow/retarget')
const { workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
let n = 0
const { platform: _p, ...pair } = preset('git', 'pair')

/** A Pair project merging into 1.1.0, listing main and 1.2.0 too (each a branch). */
async function project(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.1.0')
  git(repo, 'branch', '1.2.0')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.1.0', otherTargets: ['main', '1.2.0'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}
const card = (w: WS, title: string) => inWorkspace(w, () => tasks.createTask({ title, project: 'p' }, user))
/** A card's own target set as the board keeps it (one named while 1.1.0 was another listed branch). */
const own = async (w: WS, repo: string, number: number, target: string | null) => {
  const wf = (await workflowFor(w, repo))!
  await store.boardWrite(w, async () => wf.store.updateCard(number, { target: target ?? undefined }))
}
const ownOf = async (w: WS, repo: string, number: number) => (await workflowFor(w, repo))!.store.card(number).target ?? null
/** Work merges into moved on to `to` (as the tab saves it). */
const moveTarget = (w: WS, repo: string, to: string, others = ['main', '1.1.0', '1.2.0'].filter((b) => b !== to)) => inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: to, otherTargets: others } }))

describe('the retarget preview (HI-2680)', () => {
  it('moves Todo cards on 1.1.0 with no work; keeps one with work, one started on it, and a running lane, each with why', async () => {
    const { w, repo } = await project()
    const free = await card(w, 'Free')
    await own(w, repo, free.number, '1.1.0')
    const busy = await card(w, 'Has work')
    await own(w, repo, busy.number, '1.1.0')
    const started = await card(w, 'Started')
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${started.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    // Put back with changes left in the project folder it worked in: its work.
    expect(await store.boardWrite(w, async () => wf.start(`#${busy.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(await store.boardWrite(w, async () => wf.putBack(`#${busy.number}`, 'user'))).toMatchObject({ ok: true })
    writeFileSync(join(repo, 'left.txt'), 'left\n')
    const lc = await card(w, 'Lane card')
    await lanes.startLane(w, { project: 'p', builder: 'r1', reviewer: 'b1', cards: [lc.number], by: 'You' })
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    expect(p.cards.move.map((c) => c.number)).toEqual([free.number])
    expect(p.cards.keep).toEqual(expect.arrayContaining([expect.objectContaining({ number: busy.number, why: 'work' }), expect.objectContaining({ number: started.number, why: 'started' })]))
    expect(p.lanes).toEqual([expect.objectContaining({ builder: 'R1' })])
    // The tab's check shows it while the target changes.
    const check = await inWorkspace(w, () => form.checkWorkflowChange(w, repo, { preset: 'pair', options: { ...pair, target: '1.2.0', otherTargets: ['main', '1.1.0'] } }))
    expect(check.retarget?.cards.move.map((c) => c.number)).toEqual([free.number])
    rmSync(join(repo, 'left.txt'))
  })
})

describe('the retarget apply (HI-2680)', () => {
  it('moves each card as it was previewed; one changed meanwhile, or after the target moved on again, or once refused, stays', async () => {
    const { w, repo } = await project()
    const cards = [await card(w, 'One'), await card(w, 'Two'), await card(w, 'Three')]
    for (const c of cards) await own(w, repo, c.number, '1.1.0')
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    expect(p.cards.move).toHaveLength(3)
    await moveTarget(w, repo, '1.2.0')
    // Two changed to main between the preview and the apply: never overwritten.
    await own(w, repo, cards[1].number, 'main')
    const r = await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    expect(r.moved.cards.map((c) => c.number)).toEqual([cards[0].number, cards[2].number])
    expect(r.skipped).toEqual([expect.objectContaining({ card: cards[1].number, why: 'changed' })])
    // Moved onto the project's own target now: none of its own.
    expect(await ownOf(w, repo, cards[0].number)).toBeNull()
    expect(await ownOf(w, repo, cards[1].number)).toBe('main')
    // The target moved on again (to main) before an apply: nothing more moves.
    const more = await card(w, 'Four')
    await own(w, repo, more.number, '1.1.0')
    const p2 = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await moveTarget(w, repo, 'main')
    const r2 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user))
    expect(r2).toMatchObject({ moved: { cards: [] }, skipped: [{ card: more.number, why: 'targetChanged' }] })
    // Back on 1.2.0, the caller's authority withdrawn: refused, nothing moved.
    await moveTarget(w, repo, '1.2.0')
    const r3 = await inWorkspace(w, () => retarget.retargetApply(w, repo, p2, user, () => { throw new Error('Control turned off') }))
    expect(r3).toMatchObject({ moved: { cards: [] }, skipped: [{ card: more.number, why: 'refused' }] })
    expect(await ownOf(w, repo, more.number)).toBe('1.1.0')
  })
})

describe('the finished branch in Other branches work can merge into (HI-2680)', () => {
  it('stays while anything records it: the tab and the settings tool refuse taking it out, naming what; once moved, it goes', async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Still on 1.1.0')
    await own(w, repo, c.number, '1.1.0')
    await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
    await expect(moveTarget(w, repo, '1.2.0', ['main'])).rejects.toThrow(/1\.1\.0 can’t be taken out of Other branches work can merge into while these use it: .*Still|HI-\d+|#\d+/)
    await expect(inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main'], repo))).rejects.toThrow(/1\.1\.0 can’t be taken out/)
    const p = await inWorkspace(w, () => retarget.retargetPreview(w, repo, '1.1.0', '1.2.0'))
    await inWorkspace(w, () => retarget.retargetApply(w, repo, p, user))
    await moveTarget(w, repo, '1.2.0', ['main'])
    expect((await w.projectConfig(repo)).workflow?.options.otherTargets).toEqual(['main'])
  })

  it('a lane start on it and its removal are serial: whichever comes second is refused', async () => {
    // The lane first: the removal is refused, naming the lane.
    {
      const { w, repo } = await project()
      await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
      const c = await card(w, 'Lane card')
      await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.1.0' })
      await expect(moveTarget(w, repo, '1.2.0', ['main'])).rejects.toThrow(/1\.1\.0 can’t be taken out .*B1/)
    }
    // The removal first: it holds the lanes' lock (as the save does) while it writes the list; the start, its own check
    // made before or after, decides under that lock afterwards and is refused, nothing recorded.
    {
      const { w, repo } = await project()
      await moveTarget(w, repo, '1.2.0', ['main', '1.1.0'])
      const c = await card(w, 'Lane card')
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const removal = lanes.withLanesLock(w, async () => {
        await gate
        await w.mutateProjectConfig(repo, (cfg) => ({ workflow: { ...cfg.workflow!, options: { ...cfg.workflow!.options, otherTargets: ['main'] } } }))
      })
      const start = lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [c.number], by: 'You', target: '1.1.0' })
      release()
      await removal
      await expect(start).rejects.toThrow(/1\.1\.0 isn’t a branch work can merge into here/)
      expect(await lanes.laneOf(w, 'p', 'b1')).toBeNull()
    }
  })

  it("the settings tool's reply to a target change names what can follow it, and how", async () => {
    const { w, repo } = await project()
    const c = await card(w, 'Free')
    await own(w, repo, c.number, '1.1.0')
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main', '1.1.0'], repo))
    const r = await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.target')!, '1.2.0', repo))
    expect(r.note).toMatch(/These still on 1\.1\.0 can follow 1\.2\.0 .*: .*\. To move them, ask the user, then cw_queue retarget/)
  })
})
