// HI-2679 (SPEC §16.9): the forward request on the real board (a temp combwork.db): who may ask, which branches, nothing
// made when there is nothing to bring in, one card per pair, the Assistant's guard checked as it writes; and the window's
// queue listing: an empty destination listed with how far behind it is, counted along the source's first-parent history.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
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
async function project(ahead = 1): Promise<{ w: WS; repo: string }> {
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
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options: { ...pair, target: 'main', otherTargets: ['1.2.0'] } } }))
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
    expect(views.find((v) => v.target === 'main')?.forward).toEqual({ others: ['1.2.0'], behind: [{ from: '1.2.0', commits: 0 }] })
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
