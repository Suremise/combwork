// HI-2679 (SPEC §16.9): the forward request on the real board (a temp combwork.db): who may ask, which branches, nothing
// made when there is nothing to bring in, one card per pair, the Assistant's guard checked as it writes; and the window's
// queue listing: an empty destination listed with how far behind it is, counted along the source's first-parent history.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-forward-')
mkdirSync(join(base, 'profile'), { recursive: true })
;(electron.app as unknown as { getPath: () => string }).getPath = () => join(base, 'profile')

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const store = await import('../src/main/boardStore')
const controls = await import('../src/main/workflow/queueControls')
const { workflowFor } = await import('../src/main/workflow/service')
const { preset } = await import('../src/shared/workflow/options')
const { forwardOf } = await import('../src/shared/workflow/compile')
const { MergeQueue } = await import('../src/main/workflow/mergeQueue')

type WS = ReturnType<typeof createWorkspaceService>
const opened: WS[] = []
afterAll(async () => {
  for (const w of opened) await disposeWorkspaceService(w)
  store.closeAllBoards()
})

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
const user = { kind: 'user' } as const
const assistant = { kind: 'assistant' } as const
const agent = { kind: 'agent', name: 'B1 (p)', self: { project: 'p', agentId: 'b1' }, scope: 'p' } as const
let n = 0

/** A Pair project merging into main, listing 1.2.0 (made from main), main then `ahead` commits ahead. */
async function project(ahead = 1, targets: { target: string; otherTargets: string[] } = { target: 'main', otherTargets: ['1.2.0'] }): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.2.0')
  for (let i = 0; i < ahead; i++) {
    writeFileSync(join(repo, `fix${i}.txt`), `fix ${i}\n`)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', `fix ${i}`)
  }
  const { platform: _p, ...pair } = preset('git', 'pair')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, ...targets } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

describe('the forward request (HI-2679)', () => {
  it("is the user's or the Assistant's, for two of the project's existing targets", async () => {
    const { w, repo } = await project()
    const ask = (from: string, to: string, actor: Parameters<typeof controls.forwardMerge>[4] = user) => inWorkspace(w, () => controls.forwardMerge(w, repo, from, to, actor))
    await expect(ask('main', '1.2.0', agent)).rejects.toThrow(/Only the user or the Assistant/)
    await expect(ask('main', 'main')).rejects.toThrow(/main can’t be brought into main/)
    await expect(ask('elsewhere', '1.2.0')).rejects.toThrow(/elsewhere can’t be brought into 1\.2\.0: 1\.2\.0 must be a branch this project merges work into \(main and 1\.2\.0\)/)
    const made = await ask('main', '1.2.0', assistant)
    expect(made).toMatchObject({ queued: true, from: 'main', to: '1.2.0' })
    const card = 'card' in made ? made.card : null
    expect(card?.labels).toEqual(['forward'])
    expect(card?.title).toBe('Bring 1.2.0 up to date with main')
    const wf = (await workflowFor(w, repo))!
    const s = wf.state(wf.store.card(card!.number))
    expect(s).toMatchObject({ stage: 'merging', forward: { from: 'main', to: '1.2.0', source: git(repo, 'rev-parse', 'main'), by: 'assistant' } })
    // HI-3084: queued, the window's queue names it a forward, so Remove's confirmation says it ends in Done.
    const listed = (await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))).find((v) => v.target === '1.2.0')
    expect(listed?.queued).toMatchObject([{ card: card!.number, forward: { from: 'main', to: '1.2.0' } }])
    // HI-3086: the board offers a drop only where it stays a forward: never Todo, Review, or Passed by a drag on.
    const tasksMod = await import('../src/main/tasks')
    expect(await inWorkspace(w, () => tasksMod.moveColumns(card!.number))).toEqual(['hold', 'doing', 'passed', 'done'])
    // The same pair again while it is open: that card, nothing new.
    const again = await ask('main', '1.2.0')
    expect(again).toMatchObject({ queued: false, card: { number: card!.number } })
    expect(wf.state(wf.store.card(card!.number)).entries).toHaveLength(1)
    // Two at once: one card.
    const [a, b] = await Promise.all([ask('main', '1.2.0'), ask('main', '1.2.0')])
    expect('card' in a && 'card' in b && a.card.number === card!.number && b.card.number === card!.number).toBe(true)
  })

  it('makes nothing when the destination has everything already, or a branch is gone', async () => {
    const { w, repo } = await project(0)
    expect(await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))).toEqual({ upToDate: true, from: 'main', to: '1.2.0' })
    git(repo, 'branch', '-D', '1.2.0')
    await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))).rejects.toThrow(/There is no branch 1\.2\.0/)
  })

  it("checks the Assistant's guard as it writes: withdrawn meanwhile, no card is made", async () => {
    const { w, repo } = await project()
    const wf = (await workflowFor(w, repo))!
    const before = wf.store.cards().length
    await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', assistant, () => { throw new Error('Control turned off') }))).rejects.toThrow(/Control turned off/)
    expect(wf.store.cards().length).toBe(before)
    // Withdrawn after the card is made, as it is started (HR3's round 1): one board change, so no card is left behind,
    // and a later request makes one, whole.
    for (const after of [2, 3]) {
      let calls = 0
      const late = () => {
        if (++calls >= after) throw new Error('Control turned off meanwhile')
      }
      await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', assistant, late))).rejects.toThrow(/turned off meanwhile/)
      expect(calls).toBeGreaterThanOrEqual(after)
      expect(wf.store.cards().length).toBe(before)
      expect((await inWorkspace(w, () => store.boardRead(w, (db) => db.prepare("SELECT count(*) AS n FROM cards WHERE title = 'Bring 1.2.0 up to date with main'").get()))) as { n: number }).toEqual({ n: 0 })
    }
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', assistant))
    expect(made).toMatchObject({ queued: true })
    expect(wf.store.cards().length).toBe(before + 1)
  })
})

/**
 * HI-2885: after a release, a project whose only target is the next version (1.5.0, made from main), main then a commit
 * ahead (the release's merge commit, no change: `empty`). `trunk`: the repository's branch is trunk, the folder detached,
 * so git names no default branch.
 */
async function released(o: { trunk?: boolean } = {}): Promise<{ w: WS; repo: string; main: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const main = o.trunk ? 'trunk' : 'main'
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', main)
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.5.0')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Merge pull request: 1.4.0')
  if (o.trunk) git(repo, 'checkout', '-q', '--detach')
  const { platform: _p, ...pair } = preset('git', 'pair')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: '1.5.0' } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, main }
}

describe('HI-2885: main into the next version after a release', () => {
  it("one target and main: Bring Up to Date… offers main, which can be brought in but never brought up to date", async () => {
    const { w, repo } = await released()
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    expect(views.find((v) => v.target === '1.5.0')?.forward).toEqual({ others: ['main'], behind: [{ from: 'main', commits: 1 }] })
    expect(views.find((v) => v.target === 'main')).toBeUndefined()
    const ask = (from: string, to: string) => inWorkspace(w, () => controls.forwardMerge(w, repo, from, to, user))
    await expect(ask('1.5.0', 'main')).rejects.toThrow(/1\.5\.0 can’t be brought into main: main must be a branch this project merges work into \(1\.5\.0\), and 1\.5\.0 another branch of 1\.5\.0 and main/)
    // An empty merge (1.5.0 has every file of main's): still queued, main's head frozen.
    const made = await ask('main', '1.5.0')
    expect(made).toMatchObject({ queued: true, from: 'main', to: '1.5.0' })
    const wf = (await workflowFor(w, repo))!
    const card = 'card' in made ? made.card : null
    expect(wf.state(wf.store.card(card!.number)).forward).toMatchObject({ from: 'main', to: '1.5.0', source: git(repo, 'rev-parse', 'main') })
  })

  it('no default branch git can name: nothing offered, and none taken', async () => {
    const { w, repo } = await released({ trunk: true })
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    expect(views.find((v) => v.target === '1.5.0')?.forward).toBeUndefined()
    await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, 'trunk', '1.5.0', user))).rejects.toThrow(/trunk can’t be brought into 1\.5\.0/)
  })
})

describe("the window's queue listing (HI-2679)", () => {
  it('lists an empty destination, with how far behind the other target it is; unknown when a branch is gone', async () => {
    const { w, repo } = await project(2)
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    const dest = views.find((v) => v.target === '1.2.0')
    expect(dest?.forward).toEqual({ others: ['main'], behind: [{ from: 'main', commits: 2 }] })
    expect(dest?.queued).toEqual([])
    // HI-2892: main is never brought up to date with another branch: nothing offered or counted into it.
    expect(views.find((v) => v.target === 'main')?.forward).toBeUndefined()
    expect(await controls.commitsBehind(repo, 'gone', '1.2.0')).toBeNull()
  })

  it('counts along the source’s first-parent history: a merge or squash once, a rebase per commit, a direct commit once', async () => {
    const { repo } = await project(0)
    const on = (branch: string, file: string): string => {
      git(repo, 'checkout', '-q', branch)
      writeFileSync(join(repo, file), `${file}\n`)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', file)
      return git(repo, 'rev-parse', 'HEAD')
    }
    const card = (name: string, commits: number): void => {
      git(repo, 'checkout', '-q', '-b', name, 'main')
      for (let i = 0; i < commits; i++) on(name, `${name}${i}.txt`)
      git(repo, 'checkout', '-q', 'main')
    }
    // A card of two commits merged with a merge commit: one.
    card('merged', 2)
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'merged')
    expect(await controls.commitsBehind(repo, 'main', '1.2.0')).toBe(1)
    // One squashed: one more.
    card('squashed', 2)
    git(repo, 'merge', '-q', '--squash', 'squashed')
    git(repo, 'commit', '-qm', 'squashed')
    expect(await controls.commitsBehind(repo, 'main', '1.2.0')).toBe(2)
    // One rebased (fast-forwarded): each of its two commits.
    card('rebased', 2)
    git(repo, 'merge', '-q', '--ff-only', 'rebased')
    expect(await controls.commitsBehind(repo, 'main', '1.2.0')).toBe(4)
    // A direct commit: one more.
    on('main', 'direct.txt')
    expect(await controls.commitsBehind(repo, 'main', '1.2.0')).toBe(5)
  })
})

/**
 * HI-2892: a release (1.4.0, frozen) and the next version made from it (1.5.0), a fix on 1.4.0 since and work on 1.5.0,
 * main behind both, and a branch the names don't order (`next`). The project merges into 1.5.0, listing 1.4.0 and next.
 * `fx`: the file 1.4.0's fix and 1.5.0's work both change (a conflict for a forward between them).
 */
async function versions(o: { conflict?: boolean } = {}): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', 'next')
  git(repo, 'checkout', '-q', '-b', '1.4.0')
  writeFileSync(join(repo, 'release.txt'), 'the release\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the release')
  git(repo, 'checkout', '-q', '-b', '1.5.0')
  writeFileSync(join(repo, o.conflict ? 'fx.txt' : 'work.txt'), 'the next version\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the next version')
  git(repo, 'checkout', '-q', '1.4.0')
  writeFileSync(join(repo, o.conflict ? 'fx.txt' : 'fix.txt'), 'the release fix\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the release fix')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-q', '--detach')
  const { platform: _p, ...pair } = preset('git', 'pair')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, preChecks: [], mergeChecks: [], target: '1.5.0', otherTargets: ['1.4.0', 'next'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

/** A forward card as one made before HI-2892 would be: started straight on the board, no direction asked, no override. */
async function oldForward(w: WS, repo: string, from: string, to: string): Promise<{ number: number; key: string }> {
  const wf = (await workflowFor(w, repo))!
  const { createTask, runIntent } = await import('../src/main/tasks')
  const card = await inWorkspace(w, () => createTask({ title: `Bring ${to} up to date with ${from}`, project: 'p', labels: ['forward'] }, user))
  const source = git(repo, 'rev-parse', from)
  const r = await inWorkspace(w, () => runIntent(wf, card.number, user, (x) => x.forwardStart(card.number, { from, to, source, base: git(repo, 'merge-base', from, to) }, 'user', forwardOf(wf.currentRuleset(false), to))))
  expect(JSON.stringify(r.reply)).not.toMatch(/refus/i)
  expect(wf.state(wf.store.card(card.number)).stage).toBe('merging')
  return { number: card.number, key: wf.store.card(card.number).key }
}

/**
 * HR1's round 1: a repository with no main or master, only 1.4.0 and 1.5.0 (made from it, a fix on 1.4.0 since), 1.5.0
 * checked out: git's default branch falls back to it. The project merges into 1.5.0, listing 1.4.0.
 */
async function versionsOnly(): Promise<{ w: WS; repo: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(repo, 'init', '-q', '-b', '1.4.0')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the release')
  git(repo, 'branch', '1.5.0')
  writeFileSync(join(repo, 'fix.txt'), 'the release fix\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the release fix')
  git(repo, 'checkout', '-q', '1.5.0')
  writeFileSync(join(repo, 'work.txt'), 'the next version\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'the next version')
  const { platform: _p, ...pair } = preset('git', 'pair')
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, preChecks: [], mergeChecks: [], target: '1.5.0', otherTargets: ['1.4.0'] } } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo }
}

const drain = async (w: WS, repo: string, target: string) => {
  const wf = (await workflowFor(w, repo))!
  return inWorkspace(w, () => new MergeQueue(wf, { folder: join(base, `queue-${++n}`), runCheck: async () => ({ ok: true, output: '' }) }).drain(target))
}

describe('HI-2892: forward merges only in the release path’s direction', () => {
  it('the window offers and counts only sources in the direction: 1.4.0 never takes 1.5.0; 1.5.0 takes 1.4.0 and main', async () => {
    const { w, repo } = await versions()
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    const of = (t: string) => views.find((v) => v.target === t)?.forward
    expect(of('1.5.0')).toEqual({ others: ['1.4.0', 'main'], behind: [{ from: '1.4.0', commits: 1 }, { from: 'main', commits: 0 }] })
    expect(of('1.4.0')).toEqual({ others: ['main'], behind: [{ from: 'main', commits: 0 }] })
    // next isn't a version: only main orders into it.
    expect(of('next')).toEqual({ others: ['main'], behind: [{ from: 'main', commits: 0 }] })
  })

  it('a backward or unordered request is refused with its reason; the override, the JSON boolean, is recorded on the card', async () => {
    const { w, repo } = await versions()
    const ask = (from: string, to: string, opts: { override?: boolean } = {}, actor: Parameters<typeof controls.forwardMerge>[4] = user) => inWorkspace(w, () => controls.forwardMerge(w, repo, from, to, actor, undefined, opts))
    await expect(ask('1.5.0', '1.4.0')).rejects.toThrow(/1\.4\.0 isn’t brought up to date with 1\.5\.0: 1\.4\.0 is an older version than 1\.5\.0.*Nothing was queued\. Bring 1\.5\.0 up to date with 1\.4\.0 instead/)
    await expect(ask('1.4.0', 'next')).rejects.toThrow(/Combwork can’t tell which of 1\.4\.0 and next comes first/)
    // Membership and the actor are checked first, override or not.
    await expect(ask('1.5.0', 'main', { override: true })).rejects.toThrow(/1\.5\.0 can’t be brought into main/)
    await expect(ask('1.5.0', '1.4.0', { override: true }, agent)).rejects.toThrow(/Only the user or the Assistant/)
    const wf = (await workflowFor(w, repo))!
    const before = wf.store.cards().length
    // Only the boolean true overrides (the API refuses anything else before it gets here).
    await expect(ask('1.5.0', '1.4.0', { override: 'yes' as unknown as boolean })).rejects.toThrow(/older version/)
    expect(wf.store.cards().length).toBe(before)
    const made = await ask('1.5.0', '1.4.0', { override: true }, assistant)
    expect(made).toMatchObject({ queued: true, from: '1.5.0', to: '1.4.0', overridden: true })
    const card = 'card' in made ? made.card : null
    expect(wf.state(wf.store.card(card!.number)).forward).toMatchObject({ from: '1.5.0', to: '1.4.0', by: 'assistant', override: { by: 'assistant', dir: 'backward', why: 'older' } })
    // In the direction, no override is recorded, asked for or not.
    const fwd = await ask('1.4.0', '1.5.0', { override: true })
    expect('overridden' in fwd).toBe(false)
    expect(wf.state(wf.store.card(('card' in fwd ? fwd.card : null)!.number)).forward?.override).toBeUndefined()
  })

  it('an override never upgrades an open card made without one', async () => {
    const { w, repo } = await versions()
    const old = await oldForward(w, repo, '1.5.0', '1.4.0')
    await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, '1.5.0', '1.4.0', user, undefined, { override: true }))).rejects.toThrow(new RegExp(`${old.key} is bringing 1\\.4\\.0 up to date with 1\\.5\\.0 already, without an override`))
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card(old.number)).forward?.override).toBeUndefined()
  })

  it('an old queued backward card is returned with its reason, neither branch moved; its Retry is refused', async () => {
    const { w, repo } = await versions()
    const [b14, b15] = [git(repo, 'rev-parse', '1.4.0'), git(repo, 'rev-parse', '1.5.0')]
    const old = await oldForward(w, repo, '1.5.0', '1.4.0')
    expect(await drain(w, repo, '1.4.0')).toMatchObject([{ card: old.key, outcome: 'returned', reason: 'direction' }])
    expect([git(repo, 'rev-parse', '1.4.0'), git(repo, 'rev-parse', '1.5.0')]).toEqual([b14, b15])
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card(old.number))).toMatchObject({ stage: 'active', integrated: null })
    await expect(inWorkspace(w, () => controls.queueCardChange(w, old.number, user, 'retryMerge', 'again'))).rejects.toThrow(new RegExp(`${old.key} isn’t merged again: its request recorded no override, and 1\\.4\\.0 is an older version than 1\\.5\\.0`))
    expect(wf.state(wf.store.card(old.number)).stage).toBe('active')
    // HI-2959: nor handed to a builder (the Assistant's or the user's Resolve): refused for its direction, the board
    // unchanged, its stall naming Remove from queue alone.
    const cards = wf.store.cards().length
    for (const by of [assistant, user]) await expect(inWorkspace(w, () => controls.resolveForward(w, old.number, by, 'by hand'))).rejects.toThrow(new RegExp(`${old.key} isn’t merged again: its request recorded no override`))
    expect(wf.store.cards().length).toBe(cards)
    expect(wf.state(wf.store.card(old.number)).stage).toBe('active')
    expect(wf.returnedForward(wf.store.card(old.number))).toBeNull()
    const { forwardWaitOf } = await import('../src/main/queueReturn')
    expect(await forwardWaitOf(w, repo, old.number)).toEqual({ from: '1.5.0', to: '1.4.0', removeOnly: true })
    // Remove from queue ends it, nothing merged.
    await inWorkspace(w, () => controls.queueCardChange(w, old.number, user, 'removeFromQueue', 'not this way'))
    expect(wf.state(wf.store.card(old.number)).stage).toBe('done')
    expect(git(repo, 'rev-parse', '1.4.0')).toBe(b14)
    // HI-3040: a direct forward's way out, as its texts say: removed, then asked again with the override, a new card.
    const again = await inWorkspace(w, () => controls.forwardMerge(w, repo, '1.5.0', '1.4.0', user, undefined, { override: true }))
    expect(again).toMatchObject({ queued: true, overridden: true })
    expect('card' in again && again.card.number).not.toBe(old.number)
  })

  it("no main or master, the checked-out 1.5.0 git's default: still ordered by version, never as main (HR1's round 1)", async () => {
    const { w, repo } = await versionsOnly()
    const { defaultBranch } = await import('../src/main/workflow/targets')
    // The premise: git's default here is the checked-out version branch.
    expect(await defaultBranch(w, repo)).toBe('1.5.0')
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    expect(views.find((v) => v.target === '1.4.0')?.forward).toBeUndefined()
    expect(views.find((v) => v.target === '1.5.0')?.forward).toEqual({ others: ['1.4.0'], behind: [{ from: '1.4.0', commits: 1 }] })
    await expect(inWorkspace(w, () => controls.forwardMerge(w, repo, '1.5.0', '1.4.0', user))).rejects.toThrow(/1\.4\.0 is an older version than 1\.5\.0/)
    const [b14, b15] = [git(repo, 'rev-parse', '1.4.0'), git(repo, 'rev-parse', '1.5.0')]
    const old = await oldForward(w, repo, '1.5.0', '1.4.0')
    expect(await drain(w, repo, '1.4.0')).toMatchObject([{ card: old.key, outcome: 'returned', reason: 'direction' }])
    expect([git(repo, 'rev-parse', '1.4.0'), git(repo, 'rev-parse', '1.5.0')]).toEqual([b14, b15])
  })

  it("HI-2893: a queue whose target isn't one of the project's now, holding no entry, is a past branch's", async () => {
    const { w, repo } = await versions()
    // An old target's queue with only a pause (no entry), and another's with an entry still queued.
    await inWorkspace(w, () => controls.pauseQueue(w, repo, '1.0.0', 'user'))
    git(repo, 'branch', '1.1.0', '1.4.0')
    await oldForward(w, repo, 'main', '1.1.0')
    const views = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    const past = (t: string) => views.find((v) => v.target === t)?.past
    // HI-2927: the pause keeps 1.0.0's queue live (its card and Resume), not a past branch's.
    expect(views.find((v) => v.target === '1.0.0')?.paused).toBeTruthy()
    expect(past('1.0.0')).toBeUndefined()
    expect(past('1.1.0')).toBeUndefined()
    for (const t of ['1.5.0', '1.4.0', 'next']) expect(past(t)).toBeUndefined()
    // 1.1.0's entry settled, its queue holds nothing: a past branch's, in the Agent API's listing (not the window's) too.
    expect(await drain(w, repo, '1.1.0')).toHaveLength(1)
    const after = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    expect(after.filter((v) => v.past).map((v) => v.target)).toEqual(['1.1.0'])
    const api = await inWorkspace(w, () => controls.queueViews(w, repo))
    expect(api.filter((v) => v.past).map((v) => v.target)).toEqual(['1.1.0'])
  })

  it('HI-2994: the Agent API lists every queue the window shows, an old branch’s with a card in flight into it included', async () => {
    const { w, repo } = await versions()
    const tasks = await import('../src/main/tasks')
    const { agentActor } = await import('../src/shared/workflow/facts')
    const { shownQueues } = await import('../src/shared/progressQueue')
    // A card started on 1.4.0 (listed then), and 1.4.0 dropped from the project's targets since: in flight into an old branch.
    const c = await inWorkspace(w, () => tasks.createTask({ title: 'Release fix', project: 'p', target: '1.4.0' }, user))
    const wf = (await workflowFor(w, repo))!
    expect(await store.boardWrite(w, async () => wf.start(`#${c.number}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(wf.state(wf.store.card(c.number)).started?.target).toBe('1.4.0')
    await inWorkspace(w, () => w.mutateProjectConfig(repo, (now) => ({ workflow: { ...now.workflow!, options: { ...now.workflow!.options, otherTargets: ['next'] } } })))
    const window = await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
    const shown = shownQueues(window, Date.now()).map((v) => v.target)
    expect(shown).toContain('1.4.0')
    expect(window.find((v) => v.target === '1.4.0')).toMatchObject({ inFlight: [c.number] })
    // The Agent API's listing (GET /v1/queue, cw_queue list: past branches' left out): the same queue, live.
    const api = await inWorkspace(w, () => controls.queueViews(w, repo))
    const listed = api.filter((v) => !v.past).map((v) => v.target)
    for (const t of shown) expect(listed).toContain(t)
    expect(api.find((v) => v.target === '1.4.0')).toMatchObject({ inFlight: [c.number] })
    expect(api.find((v) => v.target === '1.4.0')?.past).toBeUndefined()
  })

  it("HI-2927: a card in flight, a pause or a Combwork running it keeps an old target's queue live; unreadable targets mark none past", async () => {
    const { w, repo } = await versions()
    const { past: _past, ...one } = (await inWorkspace(w, () => controls.queueViews(w, repo, '1.0.0')))[0]
    const paused = { reason: 'stuck' as const, card: null, files: [], by: 'user' as const, at: new Date().toISOString() }
    const make = (): Parameters<typeof controls.markPast>[0] => [
      { ...one, target: '1.0.0' },
      { ...one, target: 'old-flight', inFlight: [61] },
      { ...one, target: 'old-paused', paused },
      { ...one, target: 'old-run', runBy: 'Combwork-Dev' },
      { ...one, target: '1.5.0' }
    ]
    const named = { default: '1.5.0', others: ['1.4.0'] }
    const views = make()
    controls.markPast(views, named)
    expect(views.filter((v) => v.past).map((v) => v.target)).toEqual(['1.0.0'])
    // Git → None, or git's default unreadable for a moment: the targets are unknown, and no queue is a past branch's.
    const unknown = make()
    controls.markPast(unknown, null)
    expect(unknown.filter((v) => v.past)).toEqual([])
  })

  it('a card with its override recorded keeps it through Retry: the source frozen again, queued, merged', async () => {
    const { w, repo } = await versions({ conflict: true })
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, '1.5.0', '1.4.0', user, undefined, { override: true }))
    const card = 'card' in made ? made.card : null
    // 1.4.0's fix and 1.5.0's work change the same file: it comes back.
    expect(await drain(w, repo, '1.4.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    // Settled on 1.5.0 (1.4.0's fix taken in), then Retry: the new head frozen, its override kept.
    git(repo, 'checkout', '-q', '1.5.0')
    git(repo, 'merge', '-q', '-X', 'ours', '--no-edit', '1.4.0')
    const settled = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', '--detach')
    await inWorkspace(w, () => controls.queueCardChange(w, card!.number, user, 'retryMerge', 'settled'))
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card(card!.number))).toMatchObject({ stage: 'merging', forward: { override: { dir: 'backward', why: 'older' } } })
    expect(await drain(w, repo, '1.4.0')).toMatchObject([{ outcome: 'integrated' }])
    expect(git(repo, 'merge-base', '--is-ancestor', settled, '1.4.0') === '').toBe(true)
  })

  it('HI-2959: a forward made with the override that conflicts can still be handed to a builder; the card merges as a merge commit', async () => {
    const { w, repo } = await versions({ conflict: true })
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, '1.5.0', '1.4.0', user, undefined, { override: true }))
    const card = 'card' in made ? made.card : null
    expect(await drain(w, repo, '1.4.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const { forwardWaitOf } = await import('../src/main/queueReturn')
    expect(await forwardWaitOf(w, repo, card!.number)).toEqual({ from: '1.5.0', to: '1.4.0', removeOnly: false })
    const r = await inWorkspace(w, () => controls.resolveForward(w, card!.number, assistant, 'by hand'))
    const wf = (await workflowFor(w, repo))!
    expect(r).toMatchObject({ from: '1.5.0', to: '1.4.0', source: git(repo, 'rev-parse', '1.5.0') })
    expect(wf.state(wf.store.card(card!.number)).stage).toBe('done')
    expect(wf.store.card(r.card.number).target).toBe('1.4.0')
    expect(wf.rulesetOf(wf.store.card(r.card.number)).options.style).toBe('merge')
  })
})

describe('HI-3085: Retry merge and Resolve on a builder read the direction as the queue does (HI-3049)', () => {
  /** No main or master: trunk (checked out) a fix ahead of 1.2.0, which changes the same file, so trunk into 1.2.0 conflicts. */
  async function trunkProject(): Promise<{ w: WS; repo: string }> {
    const ws = join(base, `ws-${++n}`)
    const repo = join(ws, 'p')
    mkdirSync(join(repo, '.combwork'), { recursive: true })
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    git(repo, 'init', '-q', '-b', 'trunk')
    for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
    writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'initial')
    git(repo, 'branch', '1.2.0')
    writeFileSync(join(repo, 'fix0.txt'), 'fix 0\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'fix 0')
    git(repo, 'checkout', '-q', '1.2.0')
    writeFileSync(join(repo, 'fix0.txt'), 'the 1.2.0 version\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', '1.2.0 changes it too')
    git(repo, 'checkout', '-q', 'trunk')
    const { platform: _p, ...pair } = preset('git', 'pair')
    writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, preChecks: [], mergeChecks: [], target: '1.2.0', otherTargets: ['trunk'] } } }))
    const w = createWorkspaceService()
    await w.open(ws)
    opened.push(w)
    return { w, repo }
  }

  it('the project folder switched to another branch: both wait, saying to check trunk out again, nothing changed; back on trunk, both go', async () => {
    const { w, repo } = await trunkProject()
    const wf = (await workflowFor(w, repo))!
    const returnedOne = async (): Promise<number> => {
      const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'trunk', '1.2.0', user))
      const num = ('card' in made ? made.card : null)!.number
      expect(wf.state(wf.store.card(num)).forward?.defaultBranch).toBe('trunk')
      expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
      return num
    }
    const num = await returnedOne()
    git(repo, 'checkout', '-q', '-b', 'other', '1.2.0')
    const before = wf.store.facts(num).length
    const cards = wf.store.cards().length
    const said = /waits: the project folder has other checked out, so git names other the default branch \(this repository has no main or master\), and it was trunk when .+’s direction was checked\. Check out trunk in the project folder, then try again\./
    await expect(inWorkspace(w, () => controls.queueCardChange(w, num, user, 'retryMerge', 'again'))).rejects.toThrow(said)
    await expect(inWorkspace(w, () => controls.resolveForward(w, num, user, 'by hand'))).rejects.toThrow(said)
    // Nothing written: still returned, no card made.
    expect(wf.store.facts(num).length).toBe(before)
    expect(wf.store.cards().length).toBe(cards)
    expect(wf.state(wf.store.card(num)).stage).toBe('active')
    // Back on trunk: Retry goes (queued again).
    git(repo, 'checkout', '-q', 'trunk')
    await inWorkspace(w, () => controls.queueCardChange(w, num, user, 'retryMerge', 'again'))
    expect(wf.state(wf.store.card(num)).stage).toBe('merging')
    // And Resolve goes on another returned one, recording trunk.
    await inWorkspace(w, () => controls.queueCardChange(w, num, user, 'removeFromQueue', 'done with it'))
    const other = await returnedOne()
    const r = await inWorkspace(w, () => controls.resolveForward(w, other, user, 'by hand'))
    expect(wf.state(wf.store.card(r.card.number)).resolves).toMatchObject({ from: 'trunk', to: '1.2.0', defaultBranch: 'trunk' })
  })

  it('the project folder on no branch (no main or master): both wait, saying to put it on its branch', async () => {
    const { w, repo } = await trunkProject()
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'trunk', '1.2.0', user))
    const num = ('card' in made ? made.card : null)!.number
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    git(repo, 'checkout', '-q', '--detach')
    const said = /waits: Combwork can’t read which branch is this repository’s default now .+ Put the project folder on its branch, then try again\./
    await expect(inWorkspace(w, () => controls.queueCardChange(w, num, user, 'retryMerge', 'again'))).rejects.toThrow(said)
    await expect(inWorkspace(w, () => controls.resolveForward(w, num, user, 'by hand'))).rejects.toThrow(said)
  })
})

describe('HI-2959: Resolve on a builder, on the real board', () => {
  /** project(), with 1.2.0 changing main's fix too: the forward of main into 1.2.0 conflicts. */
  async function conflicting(targets?: Parameters<typeof project>[1]): Promise<{ w: WS; repo: string }> {
    const p = await project(1, targets)
    git(p.repo, 'checkout', '-q', '1.2.0')
    writeFileSync(join(p.repo, 'fix0.txt'), 'the 1.2.0 version\n')
    git(p.repo, 'add', '-A')
    git(p.repo, 'commit', '-qm', '1.2.0 changes it too')
    git(p.repo, 'checkout', '-q', '--detach')
    return p
  }

  it('HI-2985: its destination Work merges into, pinned there: kept when Work merges into moves on, refused elsewhere', async () => {
    // main into 1.2.0, the project's own (HI-2885's common case): the card stores 1.2.0, not none.
    const { w, repo } = await conflicting({ target: '1.2.0', otherTargets: [] })
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))
    const fwd = 'card' in made ? made.card : null
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const r = await inWorkspace(w, () => controls.resolveForward(w, fwd!.number, user, 'by hand'))
    const wf = (await workflowFor(w, repo))!
    const rc = r.card.number
    expect(wf.store.card(rc).target).toBe('1.2.0')
    // Start the next version: Work merges into 1.3.0, 1.2.0 listed.
    git(repo, 'branch', '1.3.0', '1.2.0')
    await inWorkspace(w, () => w.mutateProjectConfig(repo, (now) => ({ workflow: { ...now.workflow!, options: { ...now.workflow!.options, target: '1.3.0', otherTargets: ['1.2.0'] } } })))
    const tasks = await import('../src/main/tasks')
    const lanes = await import('../src/main/lanes')
    const { retargetPreview } = await import('../src/main/workflow/retarget')
    const { agentActor } = await import('../src/shared/workflow/facts')
    // A version retarget leaves it where it is; its Merges into moves nowhere else, nor does a lane on 1.3.0 take it.
    const preview = await inWorkspace(w, () => retargetPreview(w, repo, '1.2.0', '1.3.0', { ongoing: true }))
    expect(preview.cards.move.map((c) => c.number)).not.toContain(rc)
    expect(preview.cards.keep.find((c) => c.number === rc)?.why).toBe('refused')
    await expect(inWorkspace(w, () => tasks.setTarget(rc, '1.3.0', user))).rejects.toThrow(/resolves the merge of main into 1\.2\.0, so it merges into 1\.2\.0 only/)
    await expect(inWorkspace(w, () => tasks.setTarget(rc, null, assistant))).rejects.toThrow(/merges into 1\.2\.0 only/)
    await inWorkspace(w, () => tasks.setTarget(rc, '1.2.0', user))
    expect(wf.store.card(rc).target).toBe('1.2.0')
    await expect(lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [rc], by: 'You' })).rejects.toThrow(/merges into 1\.2\.0, and this lane into 1\.3\.0/)
    // A lane on 1.2.0 takes it, and it starts from 1.2.0.
    expect((await lanes.startLane(w, { project: 'p', builder: 'b1', reviewer: 'r1', cards: [rc], by: 'You', target: '1.2.0' })).lane.target).toBe('1.2.0')
    expect(await store.boardWrite(w, async () => wf.start(`#${rc}`, agentActor('b1')))).toMatchObject({ ok: true })
    expect(wf.state(wf.store.card(rc)).started).toMatchObject({ target: '1.2.0', base: git(repo, 'rev-parse', '1.2.0') })
  })

  it('HI-3000: while its resolution is open, a forward request for the pair returns that card and makes nothing; the queue card says it waits', async () => {
    const { w, repo } = await conflicting()
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))
    const fwd = 'card' in made ? made.card : null
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const rc = (await inWorkspace(w, () => controls.resolveForward(w, fwd!.number, user, 'by hand'))).card.number
    const wf = (await workflowFor(w, repo))!
    // HI-3049: the default branch each was checked with, recorded on the request and on the resolution.
    expect(wf.state(wf.store.card(fwd!.number)).forward?.defaultBranch).toBe('main')
    expect(wf.state(wf.store.card(rc)).resolves?.defaultBranch).toBe('main')
    const key = wf.store.card(rc).key
    const before = wf.store.cards().length
    // The forward is Done; its resolution in Todo is the pair's open work, for the window's request and the Assistant's.
    for (const by of [user, assistant]) {
      const again = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', by))
      expect(again).toMatchObject({ queued: false, from: 'main', to: '1.2.0', card: { number: rc } })
    }
    expect(wf.store.cards().length).toBe(before)
    expect(wf.state(wf.store.card(rc)).entries).toHaveLength(0)
    // The queue card names it beside how far 1.2.0 is behind main (the window then offers nothing for that pair).
    const view = (await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))).find((v) => v.target === '1.2.0')!
    expect(view.forward?.behind.find((b) => b.from === 'main')).toMatchObject({ resolving: { card: rc, key } })
    // HR1's round 1: the lookup reads the open cards alone (the Done forward never folded), once per listing, not per pair.
    const tasks = await import('../src/main/tasks')
    const folded = vi.spyOn(wf, 'state')
    const reads = vi.spyOn(wf.store, 'cardsOpen')
    try {
      expect(controls.openPairs(wf).get('main\n1.2.0')?.id).toBe(rc)
      expect(folded.mock.calls.map(([c]) => (c as { id: number }).id)).toEqual([rc])
      folded.mockClear()
      reads.mockClear()
      // A board change, so the listing is made afresh (not its cached view): one read of the open cards for it.
      await inWorkspace(w, () => tasks.createTask({ title: 'something else', project: 'p' }, user))
      await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))
      expect(reads).toHaveBeenCalledTimes(1)
    } finally {
      folded.mockRestore()
      reads.mockRestore()
    }
    // Done (here by the user's move, nothing to merge): the pair is open again, and a request makes a new forward.
    await inWorkspace(w, () => tasks.moveTask(rc, 'done', { confirm: true, reason: 'resolved elsewhere' }))
    const after = (await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))).find((v) => v.target === '1.2.0')!
    expect(after.forward?.behind.find((b) => b.from === 'main')?.resolving).toBeUndefined()
    expect(await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))).toMatchObject({ queued: true })
  })

  /**
   * HI-3040: trunk the default (no main or master yet), checked out; the project merges into 1.2.0 and lists trunk. The
   * forward of trunk into 1.2.0 conflicts, is resolved on a builder, reviewed and approved; main is made meanwhile (git's
   * default now, so trunk into 1.2.0 reads unordered), and the queue returns it for its direction.
   */
  async function returnedForDirection() {
    // trunk the default (no main or master yet), checked out; the project merges into 1.2.0 and lists trunk.
    const { w, repo } = await conflicting({ target: '1.2.0', otherTargets: ['trunk'], preChecks: [], mergeChecks: [] } as unknown as Parameters<typeof project>[1])
    git(repo, 'branch', '-m', 'main', 'trunk')
    git(repo, 'checkout', '-q', 'trunk')
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'trunk', '1.2.0', user))
    const fwd = 'card' in made ? made.card : null
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const rc = (await inWorkspace(w, () => controls.resolveForward(w, fwd!.number, user, 'by hand'))).card.number
    const wf = (await workflowFor(w, repo))!
    const { agentActor } = await import('../src/shared/workflow/facts')
    const as = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, () => store.boardWrite(w, fn))
    const source = wf.state(wf.store.card(rc)).resolves!.source
    // The builder works in the project folder (no slots here), on a branch of its own from 1.2.0.
    git(repo, 'checkout', '-q', '-b', 'resolve', '1.2.0')
    const started = (await as(() => wf.start(`#${rc}`, agentActor('b1')))) as { data?: { folder?: string } }
    const folder = started.data!.folder!
    expect(wf.state(wf.store.card(rc)).started).toMatchObject({ target: '1.2.0', base: git(repo, 'rev-parse', '1.2.0') })
    try {
      git(folder, 'merge', '-q', '--no-edit', source)
    } catch {
      // the conflict, resolved by hand
    }
    writeFileSync(join(folder, 'fix0.txt'), 'the 1.2.0 version, with the fix\n')
    git(folder, 'add', '-A')
    git(folder, 'commit', '-qm', 'Merge trunk into 1.2.0, resolved')
    const revision = git(folder, 'rev-parse', 'HEAD')
    expect(await as(() => wf.submit(`#${rc}`, agentActor('b1'), { summary: 'merged trunk' }))).toMatchObject({ ok: true })
    // main made meanwhile: git's default now, so trunk into 1.2.0 reads unordered.
    git(repo, 'branch', 'main', 'trunk')
    const override = (actor: Parameters<typeof controls.forwardMerge>[4], guard?: () => void) => inWorkspace(w, () => controls.forwardMerge(w, repo, 'trunk', '1.2.0', actor, guard, { override: true }))
    const recorded = () => wf.store.facts(rc).filter((f) => f.kind === 'ResolutionOverride').length
    // In Review, not returned for its direction: refused as before, nothing written.
    await expect(override(user)).rejects.toThrow(/without an override, so the override wasn’t applied to it/)
    expect(recorded()).toBe(0)
    expect(await as(() => wf.startReview(`#${rc}`, agentActor('r1')))).toMatchObject({ ok: true })
    expect(await as(() => wf.verdict(`#${rc}`, agentActor('r1'), { pass: true, comment: 'ok' }))).toMatchObject({ ok: true })
    const dest = git(repo, 'rev-parse', '1.2.0')
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'direction', transient: false }])
    // Its same revision can't go back in yet.
    expect(JSON.stringify(await as(() => wf.submit(`#${rc}`, agentActor('b1'), { summary: 'again' })))).toContain('requeue.allowed')
    const wakes = () => (inWorkspace(w, () => store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'wake' ORDER BY id").all(rc))) as { payload: string }[]).map((r) => JSON.parse(r.payload) as { agent: string; why: string })
    return { w, repo, wf, rc, as, agentActor, folder, revision, dest, override, recorded, wakes }
  }

  it('HI-3040: a resolution returned for its direction takes the override from a forward request, and its same revision merges', async () => {
    const { w, repo, wf, rc, as, agentActor, revision, dest, override, recorded, wakes } = await returnedForDirection()
    // A project agent can't record it; the Assistant's guard withdrawn as it writes: nothing kept.
    await expect(override(agent)).rejects.toThrow(/Only the user or the Assistant/)
    // The Assistant's guard withdrawn at its 1st, 2nd, … check, the last inside the override's own write: each refused,
    // no fact and no wake left; the first try that gets past every check records it (nothing made), its builder told.
    const woken = wakes().length
    const before = wf.store.cards().length
    let refused = 0
    for (let after = 1; ; after++) {
      let calls = 0
      const r = await override(assistant, () => {
        if (++calls >= after) throw new Error('Control turned off meanwhile')
      }).catch((e: Error) => e)
      if (r instanceof Error) {
        expect(r.message).toMatch(/turned off meanwhile/)
        expect(recorded()).toBe(0)
        expect(wakes()).toHaveLength(woken)
        refused++
        continue
      }
      expect(r).toMatchObject({ queued: false, overridden: true, from: 'trunk', to: '1.2.0', card: { number: rc } })
      expect(wakes().slice(woken)).toEqual([expect.objectContaining({ agent: 'b1', why: expect.stringContaining('Submit the same revision again') })])
      break
    }
    // Checked before the batch, in it, and in the override's write.
    expect(refused).toBeGreaterThanOrEqual(2)
    expect(wf.store.cards().length).toBe(before)
    const s = wf.state(wf.store.card(rc))
    expect(s.resolves?.override).toMatchObject({ by: 'assistant', dir: 'unknown', why: 'unordered' })
    expect(s.overrideEntry).toBe(s.entries.at(-1)!.id)
    // Asked again (the user): the card, nothing more written.
    expect(await override(user)).toMatchObject({ queued: false, card: { number: rc } })
    expect(recorded()).toBe(1)
    // The same revision goes back in, and merges.
    expect(await as(() => wf.submit(`#${rc}`, agentActor('b1'), { summary: 'again, with the override' }))).toMatchObject({ ok: true, data: { requeued: true } })
    const last = await drain(w, repo, '1.2.0')
    expect(last, JSON.stringify(last)).toMatchObject([{ outcome: 'integrated' }])
    expect(git(repo, 'rev-parse', '1.2.0')).not.toBe(dest)
    expect(git(repo, 'merge-base', '--is-ancestor', revision, '1.2.0')).toBe('')
  })

  it('HI-3040 (HR3 round 1): its direction reading forward again, the explicit request still lets that revision back in, and it merges', async () => {
    const { w, repo, wf, rc, as, agentActor, revision, override, recorded, wakes } = await returnedForDirection()
    // The default repaired: main gone again, trunk checked out, so trunk into 1.2.0 reads forward.
    git(repo, 'checkout', '-q', 'trunk')
    git(repo, 'branch', '-D', 'main')
    const woken = wakes().length
    expect(await override(user)).toMatchObject({ queued: false, overridden: true, card: { number: rc } })
    expect(recorded()).toBe(1)
    // No override of the direction recorded (none needed): only that entry's requeue.
    const s = wf.state(wf.store.card(rc))
    expect(s.resolves?.override).toBeUndefined()
    expect(s.overrideEntry).toBe(s.entries.at(-1)!.id)
    expect(wakes().slice(woken)).toEqual([expect.objectContaining({ agent: 'b1', why: expect.stringContaining('Submit the same revision again') })])
    // Asked again: nothing more written.
    expect(await override(assistant)).toMatchObject({ queued: false, card: { number: rc } })
    expect(recorded()).toBe(1)
    expect(await as(() => wf.submit(`#${rc}`, agentActor('b1'), { summary: 'again' }))).toMatchObject({ ok: true, data: { requeued: true } })
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'integrated' }])
    expect(git(repo, 'merge-base', '--is-ancestor', revision, '1.2.0')).toBe('')
  })

  it('HI-3040 (HR3 round 1): moved back to Review after its direction return: refused, no fact, no wake', async () => {
    const { wf, rc, as, override, recorded, wakes } = await returnedForDirection()
    await as(() => wf.move(`#${rc}`, 'review', 'user', { confirm: true, reason: 'look at it again' }))
    const s = wf.state(wf.store.card(rc))
    expect(s.stage).toBe('review')
    // Its direction failure still its last entry.
    expect(s.entries.at(-1)?.failure?.reason).toBe('direction')
    const woken = wakes().length
    for (const by of [user, assistant]) await expect(override(by)).rejects.toThrow(/without an override, so the override wasn’t applied to it/)
    expect(recorded()).toBe(0)
    expect(wakes()).toHaveLength(woken)
    expect(wf.state(wf.store.card(rc)).overrideEntry).toBeNull()
  })

  it('HI-3082: one returned for a red merge check makes a card that says so, never "resolve the conflict"', async () => {
    const { w, repo } = await project()
    await inWorkspace(w, () => w.mutateProjectConfig(repo, (now) => ({ workflow: { ...now.workflow!, options: { ...now.workflow!.options, mergeChecks: ['lint'], commands: { ...now.workflow!.options.commands, lint: 'lint' } } } })))
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))
    const fwd = 'card' in made ? made.card : null
    const wf = (await workflowFor(w, repo))!
    const red = await inWorkspace(w, () => new MergeQueue(wf, { folder: join(base, `queue-${++n}`), runCheck: async () => ({ ok: false, output: 'lint failed' }) }).drain('1.2.0'))
    expect(red).toMatchObject([{ outcome: 'returned', reason: 'checks' }])
    const r = await inWorkspace(w, () => controls.resolveForward(w, fwd!.number, user, 'by hand'))
    expect(r.card.description).toContain('the merge check lint failed')
    expect(r.card.description).toContain('fix what made the check fail')
    expect(r.card.description).toContain('even when the merge changes no file')
    expect(r.card.description).not.toContain('conflict')
  })

  it("is the user's or the Assistant's, only on a returned forward; one board change, never two cards", async () => {
    const { w, repo } = await conflicting()
    const made = await inWorkspace(w, () => controls.forwardMerge(w, repo, 'main', '1.2.0', user))
    const fwd = 'card' in made ? made.card : null
    const resolve = (actor: Parameters<typeof controls.resolveForward>[2], guard?: () => void) => inWorkspace(w, () => controls.resolveForward(w, fwd!.number, actor, 'merge by hand', guard))
    const wf = (await workflowFor(w, repo))!
    const before = wf.store.cards().length
    // Queued, not returned yet: nothing to hand over.
    await expect(resolve(user)).rejects.toThrow(/isn’t a forward merge the merge queue sent back/)
    expect(await drain(w, repo, '1.2.0')).toMatchObject([{ outcome: 'returned', reason: 'conflict' }])
    const source = git(repo, 'rev-parse', 'main')
    // A project agent: refused, as the forward request is.
    await expect(resolve(agent)).rejects.toThrow(/Only the user or the Assistant/)
    // The Assistant's guard withdrawn as it writes (after the card is made, or as the forward ends): nothing kept.
    for (const after of [1, 2, 3]) {
      let calls = 0
      await expect(resolve(assistant, () => { if (++calls >= after) throw new Error('Control turned off meanwhile') })).rejects.toThrow(/turned off meanwhile/)
      expect(wf.store.cards().length).toBe(before)
      expect(wf.state(wf.store.card(fwd!.number)).stage).toBe('active')
    }
    // Two at once (the window and the Assistant): one card, the other refused.
    const both = await Promise.allSettled([resolve(user), resolve(assistant)])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(wf.store.cards().length).toBe(before + 1)
    const fkey = wf.store.card(fwd!.number).key
    const done = (both.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof resolve>>>).value
    expect(done).toMatchObject({ forward: fkey, from: 'main', to: '1.2.0', source })
    const card = done.card
    expect(card).toMatchObject({ column: 'todo', agent: null, links: [fwd!.number], title: 'Resolve: bring 1.2.0 up to date with main' })
    expect(card.description).toContain(`git merge ${source}`)
    expect(card.description).toContain('a conflict in fix0.txt')
    expect(card.description).toContain('resolve the conflict')
    expect(wf.store.card(card.number).target).toBe('1.2.0')
    expect(wf.state(wf.store.card(card.number)).resolves).toMatchObject({ forward: fkey, source })
    // The forward ended, nothing merged; its comment names the new card.
    expect(wf.state(wf.store.card(fwd!.number)).stage).toBe('done')
    const comments = (await inWorkspace(w, () => store.boardRead(w, (db) => db.prepare("SELECT payload FROM card_actions WHERE card = ? AND kind = 'comment' ORDER BY id").all(fwd!.number)))) as { payload: string }[]
    expect(JSON.parse(comments.at(-1)!.payload).text).toContain(`Resolve on a builder made ${wf.store.card(card.number).key}`)
    // The return's own comment before it: the user's choices, never a builder's cw_submit.
    expect(JSON.parse(comments.at(-2)!.payload).text).toMatch(/Resolve on a builder ends it/)
    expect(JSON.parse(comments.at(-2)!.payload).text).not.toContain('cw_submit')
    // Once ended, again: refused.
    await expect(resolve(user)).rejects.toThrow(/isn’t a forward merge the merge queue sent back/)
  })
})
