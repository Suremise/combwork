// Switching a project's version control (#1419, SPEC §16.3.5 and §16.6.5): Git only where a Git repository is found and
// no other version control is, None always; a stale switch and a detection changed meanwhile refused under the lock; each
// platform keeping its own preset, options and answer (`workflow.kept`) across the form's saves and the Assistant's tool;
// OP-29's refusal for a project inside a larger repository, and the queue's backstop; a Git card's refusal with its
// repository gone offering the switch (S20).
import { execFileSync } from 'child_process'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'
import { B1, commit, moved, R1, setup } from './workflow/harness'

const base = tempDir('cw-vcswitch-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const tasks = await import('../src/main/tasks')
const store = await import('../src/main/boardStore')
const lanes = await import('../src/main/lanes')
const form = await import('../src/main/workflow/optionsForm')
const sw = await import('../src/main/workflow/platformSwitch')
const { workflowFor } = await import('../src/main/workflow/service')
const { allOff, preset } = await import('../src/shared/workflow/options')
const { setKept } = await import('../src/shared/workflow/projectWorkflow')
const { switchRefused } = await import('../src/shared/platform/switching')
const { refusalLines, REPOSITORY_GONE_NEXT } = await import('../src/shared/workflow/refusals')
const { englishText } = await import('../src/shared/advanced')
const { agentActor } = await import('../src/shared/workflow/facts')
const { settingEntry } = await import('../src/shared/settingsCatalog')
const settingsTools = await import('../src/main/settingsTools')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
let n = 0
const user = { kind: 'user' } as const

function gitInit(folder: string): void {
  git(folder, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(folder, 'config', k, v)
  writeFileSync(join(folder, '.gitignore'), '.combwork/\n')
  git(folder, 'add', '-A')
  git(folder, 'commit', '-qm', 'initial')
}

/**
 * A workspace with a project `p` (a Git repository unless `none`; inside a larger one with `subfolder`), its project.json
 * recording `platform` and `workflow` as given.
 */
async function workspace(o: { platform: 'git' | 'none'; workflow?: unknown; none?: boolean; subfolder?: boolean }): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  if (o.subfolder) {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    gitInit(ws)
  } else if (!o.none) gitInit(repo)
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: o.platform, agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], ...(o.workflow ? { workflow: o.workflow } : {}) }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

/** Moves a folder away, again while something holds it a moment (a watcher, the scanner: EPERM under load), within a bound for a hung run. */
const moveAway = (from: string, to: string): Promise<void> => vi.waitFor(() => renameSync(from, to), { timeout: 20_000, interval: 100 })

const workflowOf = async (w: WS, repo: string) => (await w.projectConfig(repo)).workflow
const platformOf = (w: WS, repo: string) => w.info()!.projects.find((p) => p.path === repo)!.platform!

describe('setKept (#1419)', () => {
  it('keeps the platform left and restores the one chosen, every other field kept', () => {
    const inGit = { platform: 'git' as const, preset: 'pair' as const, options: { finish: 'combworkMerges' as const }, presetAsked: 'chosen' as const, later: 1 }
    const none = setKept(inGit as never, 'none')
    expect(none).toEqual({ platform: 'none', preset: null, options: {}, kept: { git: { preset: 'pair', options: { finish: 'combworkMerges' }, presetAsked: 'chosen' } }, later: 1 })
    const back = setKept({ ...none, preset: 'solo', options: { review: 'none' } }, 'git')
    expect(back).toEqual({ platform: 'git', preset: 'pair', options: { finish: 'combworkMerges' }, presetAsked: 'chosen', kept: { none: { preset: 'solo', options: { review: 'none' } } }, later: 1 })
    // A platform left with nothing of its own isn't kept; the same platform is no change.
    expect(setKept(none, 'git')).toEqual(inGit)
    expect(setKept(inGit as never, 'git')).toBe(inGit)
  })
})

describe('switchRefused (#1419)', () => {
  it('Git only where a Git repository is found and nothing else is; None always', () => {
    expect(switchRefused('git', { platform: 'git', root: 'C:/r' })).toBeNull()
    expect(switchRefused('git', { platform: 'none' })).toEqual({ why: 'noGit' })
    expect(switchRefused('git', { platform: 'none', other: 'Mercurial' })).toEqual({ why: 'otherFound', vcs: 'Mercurial' })
    for (const d of [{ platform: 'none' as const }, { platform: 'git' as const, root: 'C:/r' }, { platform: 'none' as const, other: 'Jujutsu' }]) expect(switchRefused('none', d)).toBeNull()
  })
})

describe('switching a project (#1419)', () => {
  it('to Git is refused without a repository, with another version control, and when stale; detection is read again under the lock', async () => {
    const { w, repo } = await workspace({ platform: 'none', none: true, workflow: { platform: 'none', preset: null, options: {} } })
    expect((await sw.checkPlatformSwitch(w, repo, 'git')).refused).toEqual({ why: 'noGit' })
    await expect(sw.setPlatform(w, repo, 'git', { expected: 'none' })).rejects.toThrow('No Git repository here: Initialise repository… first.')
    // git init: the offer appears, and the switch can be made.
    gitInit(repo)
    await w.refresh()
    expect(platformOf(w, repo).offer).toEqual({ offer: 'git', why: 'gitFound' })
    expect((await sw.checkPlatformSwitch(w, repo, 'git')).refused).toBeNull()
    // The detection changes between the window's check and the switch: refused under the lock.
    mkdirSync(join(repo, '.hg'))
    await expect(sw.setPlatform(w, repo, 'git', { expected: 'none' })).rejects.toThrow('Mercurial found: not supported yet, so this project can only use None.')
    await moveAway(join(repo, '.hg'), join(repo, 'hg-was'))
    // Stale: the window showed Git, but it is None.
    await expect(sw.setPlatform(w, repo, 'git', { expected: 'git' })).rejects.toThrow('Changed meanwhile: this project uses None now. Look again before switching.')
    expect(await sw.setPlatform(w, repo, 'git', { expected: 'none' })).toEqual({ from: 'none', to: 'git' })
    expect(await w.projectConfig(repo)).toMatchObject({ platform: 'git', workflow: { platform: 'git' } })
    expect(platformOf(w, repo)).toMatchObject({ id: 'git' })
    expect(platformOf(w, repo).offer).toBeUndefined()
  })

  it('to None is never refused for what is detected: a Git repository, Mercurial, colocated jj+git', async () => {
    for (const marker of [null, '.hg', '.jj']) {
      const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: null, options: {} } })
      if (marker) mkdirSync(join(repo, marker))
      await w.refresh()
      const check = await sw.checkPlatformSwitch(w, repo, 'none')
      expect(check).toMatchObject({ from: 'git', to: 'none', refused: null, gitFolder: !marker })
      expect(await sw.setPlatform(w, repo, 'none', { expected: 'git' })).toEqual({ from: 'git', to: 'none' })
      expect((await w.projectConfig(repo)).platform).toBe('none')
      // None chosen knowing what the folder has: no switch back offered while it has that still.
      expect(platformOf(w, repo).offer).toBeUndefined()
      if (marker) {
        // The folder changes again (the other system gone, its Git repository there): offered.
        await moveAway(join(repo, marker), join(repo, `${marker.slice(1)}-was`))
        await w.refresh()
        expect(platformOf(w, repo).offer).toEqual({ offer: 'git', why: 'gitFound' })
        mkdirSync(join(repo, marker))
        await w.refresh()
      }
      // Back to Git: refused while the other version control is there.
      if (marker) await expect(sw.setPlatform(w, repo, 'git')).rejects.toThrow(/not supported yet/)
    }
  })

  it("an options save that waited behind a switch is refused, both platforms' options kept (HR3's round 1, finding 1)", async () => {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: 'pair', options: pair, presetAsked: 'chosen' } })
    // The save reads the project as Git, then waits for its lock while another Combwork on this workspace switches it to
    // None (this Combwork's own switch takes its turn after the save: workflowWrite, #1422), as its switch writes it.
    const mutate = w.mutateProjectConfig.bind(w)
    let first = true
    w.mutateProjectConfig = async (path, fn) => {
      if (first) {
        first = false
        w.mutateProjectConfig = mutate
        await mutate(path, (cfg) => ({ platform: 'none', platformFound: 'git', workflow: setKept(cfg.workflow!, 'none') }))
      }
      return mutate(path, fn)
    }
    await expect(form.setWorkflowOptions(w, repo, { preset: null, options: { ...pair, style: 'squash' } })).rejects.toThrow('Changed meanwhile: this project uses None now. Look again before switching.')
    expect(await w.projectConfig(repo)).toMatchObject({ platform: 'none', workflow: { platform: 'none', preset: null, options: {}, kept: { git: { preset: 'pair', options: pair, presetAsked: 'chosen' } } } })
  })

  it('the round trip: each platform keeps its own preset, options and answer through the form and the tool', async () => {
    const { platform: _p, ...pair } = preset('git', 'pair')
    const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: null, options: allOff('git') } })
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: pair })
    // The answer to "How do you work?" (#1423 writes it; here by hand, as a later field).
    await w.mutateProjectConfig(repo, (c) => ({ workflow: { ...c.workflow!, presetAsked: 'chosen' } }))
    await sw.setPlatform(w, repo, 'none', { expected: 'git' })
    // Nothing kept for None: no preset, no options, no answer.
    expect(await workflowOf(w, repo)).toEqual({ platform: 'none', preset: null, options: {}, kept: { git: { preset: 'pair', options: pair, presetAsked: 'chosen' } } })
    expect((await form.workflowForm(w, repo)).platform).toBe('none')
    // None's options saved (its answer too, #1423): Git's kept stays.
    const { platform: _q, ...solo } = preset('none', 'solo')
    await form.setWorkflowOptions(w, repo, { preset: 'solo', options: solo })
    expect(await workflowOf(w, repo)).toMatchObject({ platform: 'none', preset: 'solo', kept: { git: { preset: 'pair', presetAsked: 'chosen' } } })
    // Back to Git through the Assistant's tool: Pair, its options and its answer; None's now kept.
    await inWorkspace(w, async () => {
      expect(await settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'git', repo)).toEqual({ old: 'none', new: 'git' })
    })
    expect(await workflowOf(w, repo)).toEqual({ platform: 'git', preset: 'pair', options: pair, presetAsked: 'chosen', kept: { none: { preset: 'solo', options: solo, presetAsked: 'chosen' } } })
    expect((await w.projectConfig(repo)).platform).toBe('git')
    // A Git option edited and saved, by the form and the tool: None's kept unchanged.
    await form.setWorkflowOptions(w, repo, { preset: 'pair', options: { ...pair, style: 'squash' } })
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.sameness')!, 'exact', repo))
    expect((await workflowOf(w, repo))!.kept).toEqual({ none: { preset: 'solo', options: solo, presetAsked: 'chosen' } })
    // Back to None: None's restored.
    await sw.setPlatform(w, repo, 'none')
    expect(await workflowOf(w, repo)).toMatchObject({ platform: 'none', preset: 'solo', options: solo, kept: { git: { preset: 'pair', options: { style: 'squash', sameness: 'exact' }, presetAsked: 'chosen' } } })
    // With None's own answer back (#1423: its save recorded it).
    expect(await workflowOf(w, repo)).toMatchObject({ presetAsked: 'chosen' })
  })

  it('the warning lists the running lanes and cards in flight; the tool says them; a card in flight keeps its ruleset', async () => {
    const own = { ...allOff('git'), review: 'agent' as const, noSelfReview: true }
    const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: null, options: own } })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'In flight', project: 'p' }, user))
    const next = await inWorkspace(w, () => tasks.createTask({ title: 'Next', project: 'p' }, user))
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    const ruleset = wf.rulesetOf(wf.store.card(card.number))
    await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [next.number], name: 'next', by: 'B1 (p)' })
    const check = await sw.checkPlatformSwitch(w, repo, 'none')
    expect(check).toMatchObject({ refused: null, lanes: [expect.objectContaining({ name: 'next', builder: 'B1' })], inFlight: [{ number: card.number, title: 'In flight' }] })
    let reply: Awaited<ReturnType<typeof settingsTools.applySetting>> | null = null
    await inWorkspace(w, async () => (reply = await settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'none', repo)))
    expect(reply).toEqual({ old: 'git', new: 'none', note: `These keep git's rules until they finish: lane "next" (B1); #${card.number} In flight.` })
    const after = (await workflowFor(w, repo))!
    expect(after.rulesetOf(after.store.card(card.number)).id).toBe(ruleset.id)
    expect(after.rulesetOf(after.store.card(card.number)).options.platform).toBe('git')
    expect(after.currentRuleset(false).options.platform).toBe('none')
    // The tool refuses Git where no other version control allows it… here it does: a Git repository is there.
    await inWorkspace(w, () => settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'git', repo))
    mkdirSync(join(repo, '.hg'))
    await w.refresh()
    await inWorkspace(w, async () => {
      await settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'none', repo)
      await expect(settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'git', repo)).rejects.toThrow(/Mercurial found: not supported yet/)
      await expect(settingsTools.applySetting(settingEntry('project.workflow.platform')!, 'svn', repo)).rejects.toThrow()
    })
  })
})

describe('OP-29: a project inside a larger repository (#1419)', () => {
  it("Combwork merges and the agent merges need the project's own target", async () => {
    const { w, repo } = await workspace({ platform: 'git', subfolder: true, workflow: { platform: 'git', preset: null, options: allOff('git') } })
    expect(platformOf(w, repo).detected).toMatchObject({ platform: 'git', subfolder: true })
    const { platform: _p, ...pair } = preset('git', 'pair')
    const merges = { ...pair, target: '' }
    for (const finish of ['combworkMerges', 'agentMerges'] as const) {
      const c = await form.checkWorkflowChange(w, repo, { preset: null, options: { ...merges, finish } })
      expect(c.problems).toContainEqual({ kind: 'contradiction', id: 'subfolderTarget' })
    }
    await expect(form.setWorkflowOptions(w, repo, { preset: null, options: merges })).rejects.toThrow('This project is inside a larger repository: name the branch its work merges into.')
    await inWorkspace(w, async () => {
      await expect(settingsTools.applySetting(settingEntry('project.workflow.finish')!, 'agentMerges', repo)).rejects.toThrow(/inside a larger repository/)
    })
    // Its own target named: saved. Committed is done needs none.
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: { ...merges, target: 'main' } })).problems).toEqual([])
    await form.setWorkflowOptions(w, repo, { preset: null, options: { ...merges, target: 'main' } })
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: { ...allOff('git'), finish: 'committed', folder: 'project' } })).problems).toEqual([])
  })

  it("a project at its repository's root has no such rule", async () => {
    const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: null, options: allOff('git') } })
    const { platform: _p, ...pair } = preset('git', 'pair')
    expect((await form.checkWorkflowChange(w, repo, { preset: null, options: { ...pair, target: '' } })).problems).toEqual([])
  })

  it("who named the target is part of the ruleset: the project's own, never one inherited", async () => {
    const { resolveOptions } = await import('../src/main/workflow/rulesets')
    expect(resolveOptions('git', { project: { target: 'main' } }).options.targetOwn).toBe(true)
    expect(resolveOptions('git', { workspace: { git: { target: 'main' } }, project: {} }).options).not.toHaveProperty('targetOwn')
    expect(resolveOptions('git', { project: { target: '' } }).options).not.toHaveProperty('targetOwn')
    // A level can't set it itself.
    expect(resolveOptions('git', { project: { targetOwn: true } as never }).invalid).toMatch(/unknown option targetOwn/)
    // And it is a rule: the same target, named elsewhere, is another ruleset.
    const { compile } = await import('../src/shared/workflow/compile')
    const own = compile(resolveOptions('git', { project: { target: 'main' } }).options)
    const inherited = compile(resolveOptions('git', { workspace: { git: { target: 'main' } } }).options)
    expect(own.ok && inherited.ok && own.ruleset.id !== inherited.ruleset.id).toBe(true)
  })

  it("a lane's next card keeps its rules' own target after a switch to None and after a target edit (HR3's round 2)", async () => {
    const own = { ...allOff('git'), finish: 'committed' as const, folder: 'project' as const, target: 'main' }
    for (const after of ['switch', 'edit'] as const) {
      const { w, repo } = await workspace({ platform: 'git', subfolder: true, workflow: { platform: 'git', preset: null, options: own } })
      const card = await inWorkspace(w, () => tasks.createTask({ title: 'Lane card', project: 'p' }, user))
      await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [card.number], name: 'git lane', by: 'B1 (p)' })
      if (after === 'switch') await sw.setPlatform(w, repo, 'none', { expected: 'git' })
      else await form.setWorkflowOptions(w, repo, { preset: null, options: { ...own, target: 'dev' } })
      const wf = (await workflowFor(w, repo))!
      expect(await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
      expect(wf.rulesetOf(wf.store.card(card.number)).options).toMatchObject({ platform: 'git', target: 'main', targetOwn: true })
    }
  })

  describe("the queue's backstop", () => {
    let env: ReturnType<typeof setup> | null = null
    afterEach(() => {
      env?.close()
      env = null
    })

    /** A card approved and queued, its ruleset's target as given, named by the project itself when `own`. */
    async function queued(target: string, own: boolean) {
      const e = (env = setup({ ...preset('git', 'pair', { quick: [], tests: [] }), target, preChecks: [], mergeChecks: [], ...(own ? { targetOwn: true as const } : {}) }))
      const card = e.wf.createCard({ title: 'Change' })
      const s = await e.wf.start(card.key, B1)
      moved(s)
      commit((s as { data?: Record<string, unknown> }).data!.folder as string, { 'src/change.txt': 'x\n' }, `${card.key}: change`)
      moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
      moved(await e.wf.startReview(card.key, R1))
      moved(await e.wf.verdict(card.key, R1, { pass: true, comment: 'ok' }))
      return { e, card }
    }

    it('no target: the queue pauses in a subfolder project, and merges in a project at its root', async () => {
      const { e, card } = await queued('', false)
      expect(await e.queue({ subfolder: () => true }).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'subfolderTarget' }])
      expect(e.wf.state(card).stage).toBe('merging')
      e.store.setQueuePause('main', null)
      expect(await e.queue({ subfolder: () => false }).drain('main')).toMatchObject([{ outcome: 'integrated' }])
    })

    it("a target inherited from the workspace's or Combwork's defaults pauses it too (HR3's round 1, finding 2)", async () => {
      const { e, card } = await queued('main', false)
      expect(e.wf.rulesetOf(card).options).not.toHaveProperty('targetOwn')
      expect(await e.queue({ subfolder: () => true }).drain('main')).toMatchObject([{ outcome: 'paused', reason: 'subfolderTarget' }])
      expect(e.wf.state(card).stage).toBe('merging')
    })

    it("the project's own target, in the card's ruleset: merged", async () => {
      const { e, card } = await queued('main', true)
      expect(e.wf.rulesetOf(card).options).toMatchObject({ targetOwn: true })
      expect(await e.queue({ subfolder: () => true }).drain('main')).toMatchObject([{ outcome: 'integrated' }])
    })
  })
})

describe('S20: the repository gone (#1419)', () => {
  it("a Git card's start is refused for what can't be read, the switch to None its next step", async () => {
    const { w, repo } = await workspace({ platform: 'git', workflow: { platform: 'git', preset: null, options: allOff('git') } })
    const card = await inWorkspace(w, () => tasks.createTask({ title: 'Blocked', project: 'p' }, user))
    await moveAway(join(repo, '.git'), join(repo, 'git-was'))
    await w.refresh()
    expect(platformOf(w, repo)).toMatchObject({ id: 'git', offer: { offer: 'none', why: 'repositoryGone' } })
    const wf = (await workflowFor(w, repo))!
    const r = await store.boardWrite(w, async () => wf.start(`#${card.number}`, agentActor('b1')))
    expect(r).toMatchObject({ refused: true, rule: 'platform.unknown', values: { offer: 'repositoryGone' }, next: englishText({ m: REPOSITORY_GONE_NEXT, values: { reader: 'agent' } }) })
    expect(wf.state(wf.store.card(card.number)).stage).toBe('todo')
    // Switched to None: the next card starts under None's rules.
    await sw.setPlatform(w, repo, 'none', { expected: 'git' })
    const after = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => after.start(`#${card.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(after.rulesetOf(after.store.card(card.number)).options.platform).toBe('none')
  })

  it("the refusal's next step in the window's words", () => {
    const english = { one: (m: Parameters<typeof englishText>[0] & object, v?: Record<string, string | number>) => englishText(v ? { m: m as never, values: v } : m), list: (x: string[]) => x.join(', '), names: false }
    expect(refusalLines('platform.unknown', { card: 'AM-1', what: 'the line', rule: 'start', offer: 'repositoryGone' }, english as never).next).toBe(englishText({ m: REPOSITORY_GONE_NEXT, values: { reader: 'you' } }))
    expect(refusalLines('platform.unknown', { card: 'AM-1', what: 'the line', rule: 'start' }, english as never).next).toBe('Check Provider Setup or the folder, then try again.')
  })
})
