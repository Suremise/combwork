// HI-2807 (SPEC §16.6.2, §16.13.2): a branch made from another branch, a tag or a commit without moving the project
// folder; a target that doesn't exist refused at every save; and Start the next version (1.3.0 → 1.4.0) in one hold:
// the branch at the release's head as shown (pinned), the release added to Other branches, Work merges into moved, what
// can follow offered with both going on (started cards and running lanes stay, even with equal heads), the branch
// removed again when the save is refused, or kept and said when it can't be; and the Assistant's undo of a branch.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'

const base = tempDir('cw-next-version-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const retarget = await import('../src/main/workflow/retarget')
const gitRepoMod = await import('../src/main/gitRepo')
const nv = await import('../src/main/workflow/nextVersion')
const { workflowFor } = await import('../src/main/workflow/service')
const { agentActor } = await import('../src/shared/workflow/facts')
const { preset } = await import('../src/shared/workflow/options')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')
const changes = await import('../src/main/assistantChanges')
const control = await import('../src/main/assistantControl')
const { userUndo } = await import('../src/main/assistantUndo')
const { isVersionBranch, nextVersionName, branchStartArg } = await import('../src/shared/nextVersion')

vi.setConfig({ testTimeout: 60_000 })

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const user = { kind: 'user' } as const
let n = 0
const { platform: _p, ...pair } = preset('git', 'pair')

/** A Pair project merging into 1.3.0, listing main too, with a tag v1.2.0 on main's first commit. */
async function project(): Promise<{ w: WS; repo: string; ws: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(ws, { recursive: true })
  gitRepo(repo)
  commit(repo, { '.gitignore': '.combwork/\n' }, 'ignore')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  sh(repo, 'tag', 'v1.2.0')
  sh(repo, 'branch', '1.3.0')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.3.0', otherTargets: ['main'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, ws }
}
const head = (repo: string, ref: string): string => sh(repo, 'rev-parse', ref)
const hasBranch = (repo: string, b: string): boolean => sh(repo, 'branch', '--list', b) !== ''
const options = async (w: WS, repo: string) => (await inWorkspace(w, () => form.workflowForm(w, repo))).options
/** A commit on 1.3.0 without checking it out (the release moving on). */
const advance = (repo: string, branch: string): string => {
  const tree = sh(repo, 'rev-parse', `${branch}^{tree}`)
  const c = sh(repo, 'commit-tree', tree, '-p', branch, '-m', 'moved on')
  sh(repo, 'update-ref', `refs/heads/${branch}`, c)
  return c
}

describe('the next version’s name (HI-2807)', () => {
  it('reads X.Y and X.Y.Z, with or without v, and proposes the next minor in the same shape; anything else none', () => {
    expect(nextVersionName('1.3.0')).toBe('1.4.0')
    expect(nextVersionName('v2.1')).toBe('v2.2')
    expect(nextVersionName('1.3.7')).toBe('1.4.0')
    expect(nextVersionName('1.9.0')).toBe('1.10.0')
    expect(nextVersionName('main')).toBeNull()
    expect(isVersionBranch('release/1.3')).toBe(false)
    expect(branchStartArg({ ref: ' main ', commit: 5 })).toEqual({ ref: 'main', commit: '' })
    expect(branchStartArg({ commit: 'abc' })).toBeNull()
  })
})

describe('a branch from a branch, a tag or a commit (HI-2807)', () => {
  it('creates from each without moving the folder; the start resolved, a name check refuses a branch or tag of that name', async () => {
    const { w, repo } = await project()
    const folder = sh(repo, 'symbolic-ref', '--short', 'HEAD')
    const second = commit(repo, { 'b.txt': 'b\n' }, 'second')
    await inWorkspace(w, async () => {
      const tag = await gitRepoMod.resolveStart(repo, 'v1.2.0')
      expect(tag).toMatchObject({ kind: 'tag', commit: head(repo, 'v1.2.0^{commit}') })
      expect(await gitRepoMod.resolveStart(repo, 'nope')).toBeNull()
      expect(await gitRepoMod.createBranch(repo, 'from-tag', true, { ref: 'v1.2.0', commit: tag!.commit })).toMatch(/Created from-tag from v1\.2\.0/)
      expect(await gitRepoMod.createBranch(repo, 'from-branch', true, { ref: '1.3.0', commit: '' })).toMatch(/from 1\.3\.0/)
      expect(await gitRepoMod.createBranch(repo, 'from-hash', true, { ref: second, commit: second })).toMatch(/Created from-hash/)
      expect(await gitRepoMod.checkBranchName(repo, 'v1.2.0')).toMatch(/tag v1\.2\.0/)
      expect(await gitRepoMod.checkBranchName(repo, 'from-tag')).toMatch(/already a branch from-tag/)
      expect(await gitRepoMod.checkBranchName(repo, 'bad..name')).toMatch(/isn.t a valid branch name/)
      expect(await gitRepoMod.checkBranchName(repo, 'fine/name')).toBeNull()
      await expect(gitRepoMod.createBranch(repo, 'x', true, { ref: 'nope', commit: '' })).rejects.toThrow(/no branch, tag or commit nope/)
      expect(await gitRepoMod.missingBranches(repo, ['from-tag', '9.9.9'])).toEqual(['9.9.9'])
    })
    expect(head(repo, 'from-tag')).toBe(head(repo, 'v1.2.0^{commit}'))
    expect(head(repo, 'from-hash')).toBe(second)
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe(folder)
  })

  it('refuses a start that moved since it was shown, creating nothing; switching moves the folder to it, as asked', async () => {
    const { w, repo } = await project()
    const shown = head(repo, '1.3.0')
    advance(repo, '1.3.0')
    await expect(inWorkspace(w, () => gitRepoMod.createBranch(repo, 'late', true, { ref: '1.3.0', commit: shown }))).rejects.toThrow(/1\.3\.0 has moved since you were shown it/)
    expect(hasBranch(repo, 'late')).toBe(false)
    await inWorkspace(w, () => gitRepoMod.createBranch(repo, 'here', false, { ref: 'v1.2.0', commit: '' }))
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('here')
  })

  it('removes a branch it made only at that commit and while nothing uses it', async () => {
    const { w, repo } = await project()
    await inWorkspace(w, async () => {
      const a = await gitRepoMod.makeBranchAt(repo, 'made', { ref: '1.3.0', commit: '' })
      // Made again: refused, atomically (a branch made meanwhile).
      await expect(gitRepoMod.makeBranchAt(repo, 'made', { ref: '1.3.0', commit: '' })).rejects.toThrow(/already a branch made/)
      advance(repo, 'made')
      expect(await gitRepoMod.removeMadeBranch(repo, 'made', a.commit)).toEqual({ removed: false, why: 'moved' })
      const b = await gitRepoMod.makeBranchAt(repo, 'used', { ref: '1.3.0', commit: '' })
      expect(await gitRepoMod.removeMadeBranch(repo, 'used', b.commit, async () => 'target')).toEqual({ removed: false, why: 'inUse', use: 'target' })
      sh(repo, 'worktree', 'add', '-q', join(base, `wt-${n}`), 'used')
      expect(await gitRepoMod.removeMadeBranch(repo, 'used', b.commit)).toEqual({ removed: false, why: 'worktree' })
      const c = await gitRepoMod.makeBranchAt(repo, 'free', { ref: '1.3.0', commit: '' })
      expect(await gitRepoMod.removeMadeBranch(repo, 'free', c.commit)).toEqual({ removed: true })
    })
    expect(hasBranch(repo, 'free')).toBe(false)
    expect(hasBranch(repo, 'made')).toBe(true)
  })
})

describe('a target that doesn’t exist (HI-2807)', () => {
  it('is refused at the save, the tab’s and the settings tool’s, also when deleted after the check; one named already stays', async () => {
    const { w, repo } = await project()
    const change = { preset: 'pair' as const, options: { ...pair, target: '1.4.0', otherTargets: ['main', '1.3.0'] } }
    const check = await inWorkspace(w, () => form.checkWorkflowChange(w, repo, change))
    expect(check.missing).toEqual(['1.4.0'])
    await expect(inWorkspace(w, () => form.setWorkflowOptions(w, repo, change))).rejects.toThrow(/1\.4\.0 doesn’t exist, so nothing was saved/)
    await expect(inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.target')!, '1.4.0', repo))).rejects.toThrow(/1\.4\.0 doesn't exist.*cw_branch/)
    await expect(inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.otherTargets')!, ['main', 'gone'], repo))).rejects.toThrow(/gone doesn't exist/)
    // Checked fine, then deleted before the save: still refused there.
    sh(repo, 'branch', '1.4.0', '1.3.0')
    expect((await inWorkspace(w, () => form.checkWorkflowChange(w, repo, change))).missing).toBeUndefined()
    sh(repo, 'branch', '-D', '1.4.0')
    await expect(inWorkspace(w, () => form.setWorkflowOptions(w, repo, change))).rejects.toThrow(/doesn’t exist/)
    // Main isn't a branch here (the template's is master or main): a branch named already is never re-checked.
    sh(repo, 'branch', '1.4.0', '1.3.0')
    await inWorkspace(w, () => form.setWorkflowOptions(w, repo, change))
    expect((await options(w, repo)).target).toBe('1.4.0')
  })
})

describe('Start the next version (HI-2807)', () => {
  it('makes 1.4.0 at 1.3.0’s head, adds 1.3.0 to Other branches and moves Work merges into, in one go; a save beside it doesn’t deadlock', async () => {
    const { w, repo } = await project()
    const plan = await inWorkspace(w, () => nv.nextVersionPlan(w, repo))
    expect(plan).toMatchObject({ from: '1.3.0', name: '1.4.0', listed: false, start: { commit: head(repo, '1.3.0') } })
    const [r] = await Promise.all([
      inWorkspace(w, () => nv.startNextVersion(w, repo, { name: plan.name, from: { ref: plan.from, commit: plan.start!.commit }, base: plan.base })),
      inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: '1.3.0', otherTargets: ['main'], stageNames: { review: 'Check' } } }).catch((e: Error) => e))
    ])
    expect(r).toMatchObject({ name: '1.4.0', from: '1.3.0', added: true, commit: head(repo, '1.3.0') })
    expect(head(repo, '1.4.0')).toBe(head(repo, '1.3.0'))
    const o = await options(w, repo)
    expect(o.target === '1.4.0' || o.target === '1.3.0').toBe(true)
  })

  it('refuses a release that moved since it was shown, a name already taken, and options changed meanwhile, changing nothing', async () => {
    const { w, repo } = await project()
    const plan = await inWorkspace(w, () => nv.nextVersionPlan(w, repo))
    const start = { ref: plan.from, commit: plan.start!.commit }
    advance(repo, '1.3.0')
    await expect(inWorkspace(w, () => nv.startNextVersion(w, repo, { name: '1.4.0', from: start, base: plan.base }))).rejects.toThrow(/has moved since/)
    expect(hasBranch(repo, '1.4.0')).toBe(false)
    const again = await inWorkspace(w, () => nv.nextVersionPlan(w, repo))
    sh(repo, 'branch', '1.4.0', 'v1.2.0')
    await expect(inWorkspace(w, () => nv.startNextVersion(w, repo, { name: '1.4.0', from: { ref: again.from, commit: again.start!.commit }, base: again.base }))).rejects.toThrow(/already a branch 1\.4\.0/)
    expect(head(repo, '1.4.0')).toBe(head(repo, 'v1.2.0^{commit}'))
    // The options changed after the dialog read them: refused, and the branch it made is gone again.
    await inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: '1.3.0', otherTargets: ['main'], stageNames: { review: 'Check' } } }))
    await expect(inWorkspace(w, () => nv.startNextVersion(w, repo, { name: '1.5.0', from: { ref: again.from, commit: again.start!.commit }, base: again.base }))).rejects.toThrow(/changed meanwhile/)
    expect(hasBranch(repo, '1.5.0')).toBe(false)
    expect((await options(w, repo)).target).toBe('1.3.0')
  })

  it('keeps the branch and says so when it moved before the save’s refusal could take it back', async () => {
    const { w, repo } = await project()
    const plan = await inWorkspace(w, () => nv.nextVersionPlan(w, repo))
    let calls = 0
    const err = await inWorkspace(w, () =>
      nv.startNextVersion(w, repo, {
        from: { ref: plan.from, commit: plan.start!.commit },
        base: plan.base,
        check: () => {
          // The authority check at the save's write: the first at the start passes; at the write, the branch is moved and it refuses.
          if (++calls < 2) return
          advance(repo, '1.4.0')
          throw new Error('Control turned down')
        }
      })
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(nv.NextVersionPartial)
    expect(String((err as Error).message)).toMatch(/Created 1\.4\.0 at .*Control turned down.*1\.4\.0 was kept \(it has moved since\)/s)
    expect(hasBranch(repo, '1.4.0')).toBe(true)
    expect((await options(w, repo)).target).toBe('1.3.0')
  })

  it('with equal heads, keeps a running lane and a started card on 1.3.0 and offers only the Todo card; a forged item isn’t moved', async () => {
    const { w, repo } = await project()
    const free = await inWorkspace(w, () => tasks.createTask({ title: 'Free', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    await store.boardWrite(w, async () => wf.store.updateCard(free.number, { target: '1.3.0' }))
    const started = await inWorkspace(w, () => tasks.createTask({ title: 'Started', project: 'p' }, user))
    const lc = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'p' }, user))
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [lc.number], by: 'You' })
    expect(await store.boardWrite(w, async () => wf.start(`#${started.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const plan = await inWorkspace(w, () => nv.nextVersionPlan(w, repo))
    // Made before the branch exists, both going on: nothing reads the new branch's head.
    expect(plan.retarget?.ongoing).toBe(true)
    expect(plan.retarget?.cards.move.map((c) => c.number)).toEqual([free.number])
    expect(plan.retarget?.cards.keep).toEqual(expect.arrayContaining([expect.objectContaining({ number: started.number, why: 'started' })]))
    expect(plan.retarget?.lanes).toEqual([expect.objectContaining({ builder: 'B1' })])
    expect(plan.retarget?.laneMoves).toEqual([])
    // The Assistant's path: its preview made inside the hold, offered, a forged started card left out.
    const r = await inWorkspace(w, () => nv.startNextVersion(w, repo, { preview: true }))
    expect(head(repo, '1.4.0')).toBe(head(repo, '1.3.0'))
    // Equal heads now: a fresh ordinary preview would call 1.3.0 ended; the offered one still keeps them.
    expect(r.preview?.cards.move.map((c) => c.number)).toEqual([free.number])
    const id = retarget.offerRetarget(repo, r.preview!)
    const { confirmed, unknown } = retarget.offeredItems(retarget.offeredRetarget(id, repo)!, [free.key ?? `#${free.number}`, started.key ?? `#${started.number}`])
    expect(unknown).toEqual([started.key ?? `#${started.number}`])
    const moved = await inWorkspace(w, () => retarget.retargetApply(w, repo, confirmed, user))
    expect(moved.moved.cards.map((c) => c.number)).toEqual([free.number])
    expect((await workflowFor(w, repo))!.state((await workflowFor(w, repo))!.store.card(started.number)).started?.target).toBe('1.3.0')
  })
})

describe('the Assistant’s undo of a branch it made (HI-2807)', () => {
  it('removes it while still where it was made and unused; one in use, or moved since, stays', async () => {
    const { w, repo, ws } = await project()
    await control.newAssistantToken(ws)
    const record = async (name: string): Promise<string> => {
      control.newTurn(ws)
      const group = control.currentTurn(ws).id
      await changes.recordingChanges(ws, 'create-branch', `create ${name}`, () =>
        inWorkspace(w, async () => {
          const s = await gitRepoMod.makeBranchAt(repo, name, { ref: '1.3.0', commit: '' })
          await changes.noteChange(w, changes.branchChange('p', name, s.commit))
        })
      )
      return group
    }
    const g1 = await record('1.4.0')
    const [back] = await userUndo(w, { group: g1 })
    expect(back).toMatchObject({ undone: ['branch'], skipped: [] })
    expect(hasBranch(repo, '1.4.0')).toBe(false)
    // Named in Other branches since: in use, stays.
    const g2 = await record('1.5.0')
    await inWorkspace(w, () => form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, target: '1.3.0', otherTargets: ['main', '1.5.0'] } }))
    const [kept] = await userUndo(w, { group: g2 })
    expect(kept.skipped).toEqual([{ field: 'branch', why: 'changed' }])
    expect(hasBranch(repo, '1.5.0')).toBe(true)
    // Moved since: stays.
    const g3 = await record('1.6.0')
    advance(repo, '1.6.0')
    const [moved] = await userUndo(w, { group: g3 })
    expect(moved.skipped).toEqual([{ field: 'branch', why: 'changed' }])
    expect(hasBranch(repo, '1.6.0')).toBe(true)
  })
})
