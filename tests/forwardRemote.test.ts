// HI-3126 (SPEC §16.9.4): a forward request under "The target branch follows its remote" reads both branches' remote
// heads, fetched now: the source is its remote's head (never the stale or unpublished local branch), "up to date" is said
// only when the destination's remote has it, a branch tracking none uses its local head, and tracking set up any other way
// or a fetch that fails refuses the request with nothing queued. Real git, a local bare remote, the real board.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import * as electron from 'electron'
import { tempDir } from './tempDir'

const base = tempDir('cw-fwdremote-')
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
let n = 0

/** A commit of `file` in `dir` on what it has checked out; its id. */
function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', file)
  return git(dir, 'rev-parse', 'HEAD')
}

/**
 * A Pair project merging into 1.2.0 (made from main), main listed as the other branch, both pushed to a bare `origin`
 * and tracking it, the project folder detached; `follow` on unless false. `other`: a clone of origin, someone else's.
 */
async function project(o: { follow?: boolean } = {}): Promise<{ w: WS; repo: string; origin: string; other: string }> {
  const ws = join(base, `ws-${++n}`)
  const repo = join(ws, 'p')
  const origin = join(base, `origin-${n}.git`)
  mkdirSync(join(repo, '.combwork'), { recursive: true })
  mkdirSync(join(ws, '.combwork'), { recursive: true })
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(repo, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.com'], ['core.autocrlf', 'false']]) git(repo, 'config', k, v)
  writeFileSync(join(repo, '.gitignore'), '.combwork/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'initial')
  git(repo, 'branch', '1.2.0')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main', '1.2.0')
  git(repo, 'checkout', '-q', '--detach')
  const other = join(base, `other-${n}`)
  git(base, 'clone', '-q', origin, other)
  for (const [k, v] of [['user.name', 'Sam Other'], ['user.email', 'sam@example.com'], ['core.autocrlf', 'false']]) git(other, 'config', k, v)
  const { platform: _p, ...pair } = preset('git', 'pair')
  const options = { ...pair, target: '1.2.0', otherTargets: ['main'], followRemote: o.follow !== false }
  writeFileSync(join(repo, '.combwork', 'project.json'), JSON.stringify({ version: 2, platform: 'git', agents: [{ id: 'b1', name: 'B1' }, { id: 'r1', name: 'R1' }], workflow: { platform: 'git', preset: 'pair', options } }))
  const w = createWorkspaceService()
  await w.open(ws)
  opened.push(w)
  return { w, repo, origin, other }
}

const ask = (w: WS, repo: string, from = 'main', to = '1.2.0') => inWorkspace(w, () => controls.forwardMerge(w, repo, from, to, user))
const cards = async (w: WS, repo: string): Promise<number> => (await workflowFor(w, repo))!.store.cards().length

describe('HI-3126: a forward under follow mode reads the remotes', () => {
  it("brings in a hotfix someone else pushed to the source's remote, though the local branches are equal", async () => {
    const { w, repo, other } = await project()
    git(other, 'checkout', '-q', 'main')
    const hotfix = commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    const localMain = git(repo, 'rev-parse', 'main')
    const made = await ask(w, repo)
    expect(made).toMatchObject({ queued: true, from: 'main', to: '1.2.0' })
    expect(made.localAhead).toBeUndefined()
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card('card' in made ? made.card.number : 0)).forward).toMatchObject({ source: hotfix })
    // The local source isn't moved; the fetched head is kept by a pin of its own.
    expect(git(repo, 'rev-parse', 'main')).toBe(localMain)
    expect(git(repo, 'rev-parse', 'refs/cw/forward/main')).toBe(hotfix)
    // The window offers main even at a local count of 0.
    const view = (await inWorkspace(w, () => controls.queueViews(w, repo, undefined, true))).find((v) => v.target === '1.2.0')
    expect(view?.forward).toMatchObject({ follows: true, behind: [{ from: 'main', commits: 0 }] })
  })

  it("a local source with commits its remote lacks: the remote's head is brought in, and the rest is said", async () => {
    const { w, repo, origin, other } = await project()
    git(repo, 'checkout', '-q', 'main')
    commit(repo, 'unpublished.txt')
    git(repo, 'checkout', '-q', '--detach')
    const before = git(origin, 'rev-parse', '1.2.0')
    // The remote main is in 1.2.0's remote already: up to date, with the local commit named, never brought in.
    expect(await ask(w, repo)).toEqual({ upToDate: true, from: 'main', to: '1.2.0', localAhead: 1 })
    expect(await cards(w, repo)).toBe(0)
    expect(git(origin, 'rev-parse', '1.2.0')).toBe(before)
    // The remote main moves on too: queued with its head, the local commit still named.
    git(other, 'checkout', '-q', 'main')
    const hotfix = commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    const made = await ask(w, repo)
    expect(made).toMatchObject({ queued: true, localAhead: 1 })
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card('card' in made ? made.card.number : 0)).forward).toMatchObject({ source: hotfix })
  })

  it("'up to date' only when the destination's remote has it: a local destination holding it unpublished doesn't count", async () => {
    const { w, repo, other } = await project()
    git(other, 'checkout', '-q', 'main')
    const hotfix = commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    // Local 1.2.0 takes the hotfix in, never published.
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'checkout', '-q', '1.2.0')
    git(repo, 'merge', '-q', '--no-edit', 'origin/main')
    git(repo, 'checkout', '-q', '--detach')
    expect(git(repo, 'merge-base', '--is-ancestor', hotfix, '1.2.0')).toBe('')
    const made = await ask(w, repo)
    expect(made).toMatchObject({ queued: true })
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card('card' in made ? made.card.number : 0)).forward).toMatchObject({ source: hotfix })
  })

  it("'up to date' when the destination's remote has it, though the local destination doesn't", async () => {
    const { w, repo, other } = await project()
    git(other, 'checkout', '-q', 'main')
    commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    git(other, 'checkout', '-q', '1.2.0')
    git(other, 'merge', '-q', '--no-edit', 'main')
    git(other, 'push', '-q', 'origin', '1.2.0')
    expect(await ask(w, repo)).toEqual({ upToDate: true, from: 'main', to: '1.2.0' })
    expect(await cards(w, repo)).toBe(0)
  })

  it('a destination whose remote moved apart from the local one: read against the remote alone', async () => {
    const { w, repo, other } = await project()
    // The remote 1.2.0 has a commit of its own, the local 1.2.0 another: diverged.
    git(other, 'checkout', '-q', '1.2.0')
    commit(other, 'remote-only.txt')
    git(other, 'push', '-q', 'origin', '1.2.0')
    git(repo, 'checkout', '-q', '1.2.0')
    commit(repo, 'local-only.txt')
    git(repo, 'checkout', '-q', '--detach')
    // main has nothing 1.2.0's remote lacks: up to date.
    expect(await ask(w, repo)).toEqual({ upToDate: true, from: 'main', to: '1.2.0' })
  })

  it('a branch that tracks none uses its local head; follow mode off reads the local branches as before', async () => {
    const { w, repo, other } = await project()
    git(repo, 'branch', '--unset-upstream', 'main')
    git(repo, 'checkout', '-q', 'main')
    const local = commit(repo, 'local.txt')
    git(repo, 'checkout', '-q', '--detach')
    git(other, 'checkout', '-q', 'main')
    commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    const made = await ask(w, repo)
    const wf = (await workflowFor(w, repo))!
    expect(wf.state(wf.store.card('card' in made ? made.card.number : 0)).forward).toMatchObject({ source: local })

    const off = await project({ follow: false })
    git(off.other, 'checkout', '-q', 'main')
    commit(off.other, 'hotfix.txt')
    git(off.other, 'push', '-q', 'origin', 'main')
    expect(await ask(off.w, off.repo)).toEqual({ upToDate: true, from: 'main', to: '1.2.0' })
    const view = (await inWorkspace(off.w, () => controls.queueViews(off.w, off.repo, undefined, true))).find((v) => v.target === '1.2.0')
    expect(view?.forward?.follows).toBeUndefined()
  })

  it('tracking set up any other way is refused, nothing queued: half of it, another local branch, a remote that isn’t there', async () => {
    const setups: [string, string[][]][] = [
      ['half', [['config', '--unset', 'branch.main.merge']]],
      ['local', [['config', 'branch.main.remote', '.'], ['config', 'branch.main.merge', 'refs/heads/1.2.0']]],
      ['not a branch', [['config', 'branch.main.merge', 'refs/tags/v1']]],
      ['no such remote', [['config', 'branch.main.remote', 'gone']]]
    ]
    for (const [, steps] of setups) {
      const { w, repo } = await project()
      for (const s of steps) git(repo, ...s)
      await expect(ask(w, repo)).rejects.toThrow(/1\.2\.0 isn’t brought up to date with main: Combwork couldn’t read which remote branch main tracks .*, so nothing was queued/)
      expect(await cards(w, repo)).toBe(0)
    }
    // The destination's tracking too.
    const { w, repo } = await project()
    git(repo, 'config', 'branch.1.2.0.remote', '.')
    await expect(ask(w, repo)).rejects.toThrow(/couldn’t read which remote branch 1\.2\.0 tracks/)
    expect(await cards(w, repo)).toBe(0)
  })

  it("a fetch that fails refuses the request with git's words, nothing queued; Retry merge reads the same way", async () => {
    const { w, repo, origin, other } = await project()
    git(other, 'checkout', '-q', 'main')
    commit(other, 'hotfix.txt')
    git(other, 'push', '-q', 'origin', 'main')
    const made = await ask(w, repo)
    const card = 'card' in made ? made.card.number : 0
    git(repo, 'remote', 'set-url', 'origin', `${origin}-gone`)
    await expect(ask(w, repo, 'main', '1.2.0')).rejects.toThrow(/Combwork couldn’t read the branch main on .*, which main follows, so nothing was queued\. Git said: /)
    // Retry merge freezes its source again from the remote, and is refused the same way when it can't be read.
    await expect(inWorkspace(w, () => controls.queueCardChange(w, card, user, 'retryMerge', 'again'))).rejects.toThrow(/couldn’t read the branch main on /)
    expect(await cards(w, repo)).toBe(1)
  })
})
