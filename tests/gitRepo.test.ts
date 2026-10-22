// The Git view (#607): a project folder's branch, upstream and ahead/behind (as of the last fetch: never fetched by
// itself), remotes, history, tags and identity, and the user's actions on them, against real git with local bare
// repositories as remotes (never a real remote). Switching branch and pulling are refused while an agent works in the
// folder or the merge slot is held, also when the agent starts while the action waits for the lock; actions take only a
// project folder, never a worktree; a push is never forced; no password or token in a remote URL is shown or logged.
// Each test makes its own repositories (`fresh`), so any one runs alone or in any order.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aheadBehindText, folderBusy, gitStatusText, identityProblem, identityWarnings, isNoReplyEmail, parsePushPorcelain, redactRemoteUrl, redactUrlsIn, scrubSecrets, urlSecrets, remoteNameProblem, remoteUrlProblem, type GitRepoSummary } from '../src/shared/gitRepo'
import type { MergeSlotInfo } from '../src/shared/types'
import { tempDir } from './tempDir'

/** This test's folders: the project, its bare remote, another clone of it, and a project inside another repository. */
let proj = ''
let remote = ''
let other = ''
let outer = ''
let nested = ''

/** The project's agents, and their sessions' status by agent id. */
let agents: { id: string; name: string; worktree?: { path: string; branch: string; base: string } }[] = []
let live: Record<string, string> = {}
/** Agents with input of Hive's on its way (#646 round 1): a prompt given and not taken, a line typed and not taken. */
const pendingInput = new Set<string>()
const typedWaiting = new Set<string>()
let slots: MergeSlotInfo[] = []
const asUser = vi.fn((_p: string, _b: string, fn: () => Promise<unknown>) => fn())
/** While set, an action waiting for the project's merge lock stops at its door: `entered` says it got there, `open` lets it in. */
let lockDoor: { entered: () => void; open: Promise<void> } | null = null

vi.mock('../src/main/workspace', () => ({
  workspace: {
    assertProject: (p: string) => {
      if (![proj, nested].some((x) => x.toLowerCase() === p.toLowerCase())) throw new Error(`Not a project in the open workspace: ${p}`)
      return p
    },
    projectConfig: async () => ({ version: 2, agents })
  },
  workspaceOf: () => ({ refresh: async () => ({}) })
}))
vi.mock('../src/main/sessions', () => ({ sessions: { liveFor: (_p: string, id: string) => (live[id] ? { status: live[id] } : null), agentNow: (_p: string, id: string) => (live[id] ? { pending: pendingInput.has(id) } : null), lineWaiting: (_p: string, id: string) => typedWaiting.has(id) } }))
vi.mock('../src/main/mergeSlotHost', () => ({ mergeSlots: { list: () => slots, asUser } }))
vi.mock('../src/main/branchWatch', () => ({ checkProject: async () => undefined }))
vi.mock('../src/main/fsutil', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/fsutil')>()
  return {
    ...real,
    withFileLock: async <T,>(path: string, fn: () => Promise<T>): Promise<T> => {
      const door = lockDoor
      if (door) {
        door.entered()
        await door.open
      }
      return real.withFileLock(path, fn)
    }
  }
})

/** While set, a `git checkout` or `git merge` (a switch, a create, a pull) stops before git starts: `entered`, then `open` (#646). */
let gitDoor: { entered: () => void; open: Promise<void> } | null = null
vi.mock('../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (...args: Parameters<typeof real.git>) => {
      const door = gitDoor
      if (door && (args[1][0] === 'checkout' || args[1][0] === 'merge')) {
        gitDoor = null
        door.entered()
        await door.open
      }
      return real.git(...args)
    }
  }
})

const repo = await import('../src/main/gitRepo')
const fence = await import('../src/main/folderFence')

// Real git work, not a wait: each test runs a few dozen git commands, slow under a full unit run's load.
vi.setConfig({ testTimeout: 60_000 })

const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' }).trim()
const commit = (cwd: string, file: string): void => {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', `add ${file}`)
}
/** Another clone pushes a commit to the remote's main. */
const theyPush = (file: string): void => {
  commit(other, file)
  git(other, 'push', '-q', 'origin', 'HEAD:main')
}

/** New repositories for this test: the project on main, pushed to its bare remote, and another clone of that remote. */
function fresh(): void {
  const base = tempDir('hive-gitrepo-')
  proj = join(base, 'ws', 'proj')
  remote = join(base, 'remote.git')
  other = join(base, 'other')
  outer = join(base, 'outer')
  nested = join(outer, 'nested')
  mkdirSync(proj, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', proj])
  // No global identity in unit tests (noGlobalGit.ts): the repository's own, as Hive's annotated tags need one.
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(proj, 'config', k, v)
  commit(proj, 'a.txt')
  git(proj, 'remote', 'add', 'origin', remote)
  git(proj, 'push', '-q', '-u', 'origin', 'main')
  execFileSync('git', ['clone', '-q', remote, other])
}

beforeEach(() => {
  fresh()
  agents = []
  live = {}
  slots = []
  lockDoor = null
  asUser.mockClear()
})

describe('the summary', () => {
  it('names the branch, its upstream and how far apart they are as of the last fetch, never fetching itself', async () => {
    const s = await repo.repoSummary(proj)
    expect(s).toMatchObject({ isRepo: true, branch: 'main', state: null, remotes: ['origin'], upstream: { name: 'origin/main', remote: 'origin', ahead: 0, behind: 0 }, fetchedAt: null })
    expect(gitStatusText(s)).toBe('main · origin · ↑0 ↓0')
    // Someone else pushes: nothing changes here until the user fetches.
    theyPush('o.txt')
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ behind: 0 })
    expect(await repo.fetchAll(proj)).toBe('Fetched origin.')
    const after = await repo.repoSummary(proj)
    expect(after.upstream).toMatchObject({ ahead: 0, behind: 1 })
    expect(after.fetchedAt).toBeGreaterThan(0)
  })

  it('says a folder without git is no repository, and a detached HEAD by its commit', async () => {
    const plain = join(outer, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(await repo.repoSummary(plain)).toMatchObject({ isRepo: false, branch: null })
    const head = git(proj, 'rev-parse', '--short', 'HEAD')
    git(proj, 'checkout', '-q', '--detach')
    const s = await repo.repoSummary(proj)
    expect(s).toMatchObject({ isRepo: true, branch: null, head, upstream: null })
    expect(gitStatusText(s)).toBe(`detached at ${head}`)
  })

  it("shows a project inside another repository as that repository's, and changes nothing of it", async () => {
    mkdirSync(nested, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', outer])
    commit(outer, 'outer.txt')
    expect(await repo.repoSummary(nested)).toMatchObject({ isRepo: true, branch: 'main', parentRepo: outer })
    await expect(repo.createBranch(nested, 'x')).rejects.toThrow(`This project is inside the git repository in ${outer}`)
    await expect(repo.addRemote(nested, 'origin', remote)).rejects.toThrow(/inside the git repository/)
    expect(git(outer, 'branch', '--list', 'x')).toBe('')
    expect((await repo.repoSummary(proj)).parentRepo).toBeUndefined()
  })
})

describe('pull and push', () => {
  it('pulls by fast-forward only', async () => {
    theyPush('p.txt')
    expect(await repo.pull(proj)).toBe('Pulled 1 commit from origin/main.')
    expect(git(proj, 'rev-parse', 'HEAD')).toBe(git(remote, 'rev-parse', 'main'))
    expect(await repo.pull(proj)).toBe('main is up to date with origin/main.')
  })

  it('refuses a branch that has diverged without changing it, and never forces a push over theirs', async () => {
    theyPush('theirs.txt')
    commit(proj, 'mine.txt')
    const before = git(proj, 'rev-parse', 'HEAD')
    await expect(repo.pull(proj)).rejects.toThrow('main and origin/main have diverged (1 commit here, 1 there)')
    expect(git(proj, 'rev-parse', 'HEAD')).toBe(before)
    await expect(repo.push(proj)).rejects.toThrow(/push was refused \(Hive never forces a push\)/)
    expect(git(remote, 'rev-parse', 'main')).not.toBe(before)
  })

  it('pushes to the upstream, and sets one for a branch that has none', async () => {
    commit(proj, 'push.txt')
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ ahead: 1 })
    expect(await repo.push(proj)).toBe('Pushed main to origin/main.')
    expect(git(remote, 'rev-parse', 'main')).toBe(git(proj, 'rev-parse', 'HEAD'))
    expect(await repo.createBranch(proj, 'feature/x')).toBe('Created feature/x and switched to it.')
    expect(gitStatusText(await repo.repoSummary(proj))).toBe('feature/x · no upstream')
    expect(await repo.push(proj, 'origin')).toBe('Pushed feature/x to origin/feature/x.')
    expect((await repo.repoSummary(proj)).upstream).toMatchObject({ name: 'origin/feature/x', ahead: 0, behind: 0 })
  })
})

describe('Push to…, remotes and tracking (#1385)', () => {
  /** A second bare remote, `backup`, as Darren's NAS. */
  const addBackup = (): string => {
    const backup = join(outer, 'backup.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', backup])
    git(proj, 'remote', 'add', 'backup', backup)
    return backup
  }
  const upstreamOf = (branch: string): string => git(proj, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`)

  it('reads git’s porcelain push lines: pushed, up to date, refused, by branch or tag', () => {
    const out = ['To ../remote.git', ' \trefs/heads/main:refs/heads/main\t0e1eae2..dad582d', '*\trefs/heads/other:refs/heads/other\t[new branch]', '!\trefs/heads/feat:refs/heads/feat\t[rejected] (fetch first)', '=\trefs/tags/v1:refs/tags/v1\t[up to date]', 'Done'].join('\n')
    expect(parsePushPorcelain(out)).toEqual([
      { name: 'main', kind: 'branch', result: 'pushed' },
      { name: 'other', kind: 'branch', result: 'pushed' },
      { name: 'feat', kind: 'branch', result: 'refused' },
      { name: 'v1', kind: 'tag', result: 'upToDate' }
    ])
  })

  it('pushes this branch, or every branch and tag, to another remote without changing what a branch tracks', async () => {
    const backup = addBackup()
    git(proj, 'branch', 'feature/a')
    git(proj, 'tag', 'v1')
    expect(await repo.pushToRemote(proj, 'backup', 'branch')).toBe('Pushed main to backup/main.')
    expect(await repo.pushToRemote(proj, 'backup', 'branch')).toBe('backup/main already has main: nothing to push.')
    expect(await repo.pushToRemote(proj, 'backup', 'all')).toBe('Pushed every branch and tag to backup: 1 branch pushed, 1 already up to date, 1 tag pushed.')
    expect([git(backup, 'rev-parse', 'feature/a'), git(backup, 'rev-parse', 'v1')]).toEqual([git(proj, 'rev-parse', 'feature/a'), git(proj, 'rev-parse', 'v1')])
    // Push still goes where it went: no branch tracks backup.
    expect([upstreamOf('main'), upstreamOf('feature/a')]).toEqual(['origin/main', ''])
    await expect(repo.pushToRemote(proj, 'nowhere', 'all')).rejects.toThrow("There's no remote nowhere.")
  })

  it('with every branch, one the remote has newer commits on is refused by name, never forced, and the rest still go', async () => {
    const backup = addBackup()
    git(proj, 'branch', 'feature/a')
    await repo.pushToRemote(proj, 'backup', 'all')
    // Someone pushed to backup's feature/a; here, main and a new branch move on.
    const elsewhere = join(outer, 'elsewhere')
    execFileSync('git', ['clone', '-q', '-b', 'feature/a', backup, elsewhere])
    commit(elsewhere, 'theirs.txt')
    git(elsewhere, 'push', '-q', 'origin', 'feature/a')
    const theirs = git(backup, 'rev-parse', 'feature/a')
    commit(proj, 'mine.txt')
    git(proj, 'branch', 'feature/b')
    await expect(repo.pushToRemote(proj, 'backup', 'all')).rejects.toThrow('backup refused 1 (Hive never forces a push): feature/a. It has commits they haven\'t: pull or merge them first. The rest: 2 branches pushed, 0 already up to date, 0 tags pushed.')
    expect(git(backup, 'rev-parse', 'feature/a')).toBe(theirs)
    expect(git(backup, 'rev-parse', 'feature/b')).toBe(git(proj, 'rev-parse', 'HEAD'))
    // This branch alone: named as Push names it.
    git(proj, 'checkout', '-q', 'feature/a')
    commit(proj, 'mine2.txt')
    await expect(repo.pushToRemote(proj, 'backup', 'branch')).rejects.toThrow(/backup\/feature\/a has commits feature\/a hasn't, so the push was refused/)
  })

  it('removes a remote, naming the branches that stop tracking it; renames one, its branches following; refuses a name taken or invalid', async () => {
    addBackup()
    await repo.pushToRemote(proj, 'backup', 'branch')
    git(proj, 'branch', 'feature/a')
    await repo.setUpstream(proj, 'feature/a', 'backup', 'main')
    expect((await repo.repoInfo(proj)).branches.find((b) => b.name === 'feature/a')?.upstreamRemote).toBe('backup')
    expect(await repo.renameRemote(proj, 'backup', 'nas')).toBe('Renamed backup to nas: feature/a tracks it by its new name.')
    expect(upstreamOf('feature/a')).toBe('nas/main')
    await expect(repo.renameRemote(proj, 'nas', 'Origin')).rejects.toThrow('There is a remote called Origin already.')
    await expect(repo.renameRemote(proj, 'nas', '-x')).rejects.toThrow(/letters, digits/)
    await expect(repo.renameRemote(proj, 'gone', 'x')).rejects.toThrow("There's no remote gone.")
    expect(await repo.removeRemote(proj, 'nas')).toBe('Removed nas: feature/a no longer tracks a remote branch.')
    expect([upstreamOf('feature/a'), upstreamOf('main')]).toEqual(['', 'origin/main'])
    expect(git(proj, 'remote')).toBe('origin')
    expect(git(proj, 'for-each-ref', 'refs/remotes/nas')).toBe('')
    await expect(repo.removeRemote(proj, 'nas')).rejects.toThrow("There's no remote nas.")
  })

  it('changes what a branch tracks: another remote’s branch (Push goes there then), a new one pushed first only when asked, or nothing', async () => {
    const backup = addBackup()
    await repo.pushToRemote(proj, 'backup', 'branch')
    expect(await repo.setUpstream(proj, 'main', 'backup', 'main')).toBe('main tracks backup/main now.')
    commit(proj, 'b.txt')
    expect(await repo.push(proj)).toBe('Pushed main to backup/main.')
    expect(git(backup, 'rev-parse', 'main')).toBe(git(proj, 'rev-parse', 'HEAD'))
    expect(git(remote, 'rev-parse', 'main')).not.toBe(git(proj, 'rev-parse', 'HEAD'))
    // A remote branch not there yet: refused, unless the user agreed to push it there first.
    git(proj, 'branch', 'feature/c')
    await expect(repo.setUpstream(proj, 'feature/c', 'origin', 'feature/c')).rejects.toThrow('origin has no feature/c (as of the last fetch): push it there first, or fetch.')
    expect(upstreamOf('feature/c')).toBe('')
    expect(await repo.setUpstream(proj, 'feature/c', 'origin', 'feature/c', true)).toBe('Pushed feature/c to origin/feature/c, and it tracks it now.')
    expect([upstreamOf('feature/c'), git(remote, 'rev-parse', 'feature/c')]).toEqual(['origin/feature/c', git(proj, 'rev-parse', 'feature/c')])
    expect(await repo.setUpstream(proj, 'feature/c', null)).toBe('feature/c no longer tracks origin/feature/c.')
    expect(await repo.setUpstream(proj, 'feature/c', null)).toBe('feature/c tracks no remote branch already.')
    await expect(repo.setUpstream(proj, 'nope', null)).rejects.toThrow("There's no branch nope.")
    await expect(repo.setUpstream(proj, 'main', 'origin', 'bad name')).rejects.toThrow(/isn't a valid branch name/)
  })
})

describe('switching branch', () => {
  it('switches to a local branch, and to a remote one as a new branch tracking it', async () => {
    git(other, 'checkout', '-q', '-b', 'theirs')
    commit(other, 't.txt')
    git(other, 'push', '-q', '-u', 'origin', 'theirs')
    await repo.fetchAll(proj)
    expect((await repo.repoInfo(proj)).remoteBranches).toContain('origin/theirs')
    expect(await repo.switchBranch(proj, 'origin/theirs')).toBe('Switched to theirs, tracking origin/theirs.')
    expect((await repo.repoSummary(proj)).upstream?.name).toBe('origin/theirs')
    expect(await repo.switchBranch(proj, 'main')).toBe('Switched to main.')
    expect(asUser).toHaveBeenCalledWith(proj, 'theirs', expect.any(Function))
    await expect(repo.switchBranch(proj, 'nope')).rejects.toThrow("There's no branch nope.")
  })

  it('is refused while an agent works in the project folder or the merge slot is held, saying why', async () => {
    git(proj, 'branch', 'feature/x')
    agents = [{ id: 'a1', name: 'B1' }]
    live = { a1: 'working' }
    await expect(repo.switchBranch(proj, 'feature/x')).rejects.toThrow('B1 is working in the project folder: switch branches once it has finished.')
    theyPush('p.txt')
    await expect(repo.pull(proj)).rejects.toThrow('B1 is working in the project folder: pull once it has finished.')
    expect(git(proj, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    // Idle, it may; a held merge slot still stops it.
    live = { a1: 'idle' }
    slots = [{ project: proj, branch: 'main', holder: { id: 'h', kind: 'agent', agentId: 'a2', name: 'B2', cards: [], since: 0, until: 0, taken: true }, waiting: [] }]
    await expect(repo.createBranch(proj, 'other')).rejects.toThrow('B2 holds the merge slot for main: create and switch to a branch once that merge is done.')
    expect(git(proj, 'branch', '--list', 'other')).toBe('')
    // Creating one without switching moves nothing.
    expect(await repo.createBranch(proj, 'other', true)).toMatch(/^Created other at /)
    expect(git(proj, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    // An agent working in its own worktree doesn't hold the folder.
    slots = []
    agents = [{ id: 'a3', name: 'B3', worktree: { path: join(outer, 'wt'), branch: 'hive/b3', base: 'main' } }]
    live = { a3: 'working' }
    expect(await repo.switchBranch(proj, 'other')).toBe('Switched to other.')
  })

  it("fences the project folder while git switches or pulls it, and only then: Hive's lines and starts there wait for it (#646)", async () => {
    agents = [{ id: 'a1', name: 'B1' }]
    git(proj, 'branch', 'feature/y')
    // git's checkout is held: the folder is fenced (a subfolder too), another folder isn't; a start there waits.
    let entered!: () => void
    let open!: () => void
    const atGit = new Promise<void>((r) => (entered = r))
    gitDoor = { entered, open: new Promise<void>((r) => (open = r)) }
    const switched = repo.switchBranch(proj, 'feature/y')
    await atGit
    expect(fence.folderChanging(proj)).toBe('a Git switch')
    expect(fence.folderChanging(join(proj, 'src'))).toBe('a Git switch')
    expect(fence.folderChanging(other)).toBeNull()
    expect(fence.folderChanging(`${proj}-2`)).toBeNull()
    let steady = false
    const waited = fence.folderSteady(proj).then(() => (steady = true))
    const lifted: string[] = []
    fence.onFolderSteady((f) => lifted.push(f))
    // Still held: nothing may start there (the promise is still pending after the event loop turns).
    await new Promise<void>((r) => setImmediate(r))
    expect(steady).toBe(false)
    open()
    expect(await switched).toBe('Switched to feature/y.')
    await waited
    expect(steady).toBe(true)
    expect(fence.folderChanging(proj)).toBeNull()
    expect(lifted).toEqual([proj])
    // An idle agent with input of Hive's on its way (a prompt given and not taken, a line typed and not taken) counts as
    // working at the fenced check: its CLI may start that turn while git runs, and the fence can't take it back.
    live = { a1: 'ready' }
    pendingInput.add('a1')
    await expect(repo.switchBranch(proj, 'main')).rejects.toThrow(/B1 is working in the project folder/)
    pendingInput.clear()
    typedWaiting.add('a1')
    await expect(repo.switchBranch(proj, 'main')).rejects.toThrow(/B1 is working in the project folder/)
    typedWaiting.clear()
    expect(fence.folderChanging(proj)).toBeNull()
    // Refused (B1 working when the fenced check runs): the fence comes down with it, never left up.
    live = { a1: 'working' }
    await expect(repo.switchBranch(proj, 'main')).rejects.toThrow(/B1 is working in the project folder/)
    expect(fence.folderChanging(proj)).toBeNull()
    // A pull is fenced too.
    live = {}
    theyPush('fenced.txt')
    git(proj, 'fetch', '-q')
    git(proj, 'checkout', '-q', 'main')
    const pulledAt = new Promise<void>((r) => (entered = r))
    gitDoor = { entered, open: new Promise<void>((r) => (open = r)) }
    const pulled = repo.pull(proj)
    await pulledAt
    expect(fence.folderChanging(proj)).toBe('a Git pull')
    open()
    await pulled
    expect(fence.folderChanging(proj)).toBeNull()
  })

  it('is refused when the agent starts working while the action waits for the merge lock', async () => {
    agents = [{ id: 'a1', name: 'B1' }]
    let entered!: () => void
    let open!: () => void
    const atDoor = new Promise<void>((r) => (entered = r))
    lockDoor = { entered, open: new Promise<void>((r) => (open = r)) }
    const created = repo.createBranch(proj, 'raced')
    // It passed the first check (B1 idle) and waits for the lock: B1 starts a turn now.
    await atDoor
    live = { a1: 'working' }
    open()
    await expect(created).rejects.toThrow('B1 is working in the project folder: create and switch to a branch once it has finished.')
    expect(git(proj, 'branch', '--list', 'raced')).toBe('')
    expect(git(proj, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  })

  it('never switches to a branch another worktree has, and takes no worktree for the project folder', async () => {
    const wt = join(outer, 'agentwt')
    git(proj, 'worktree', 'add', '-q', '-b', 'hive/b4', wt, 'main')
    const info = await repo.repoInfo(proj)
    expect(info.worktrees.map((w) => w.branch)).toContain('hive/b4')
    expect(info.branches.find((b) => b.name === 'hive/b4')?.worktree).toBeTruthy()
    await expect(repo.switchBranch(proj, 'hive/b4')).rejects.toThrow(/checked out in another worktree/)
    // Agents' worktrees are read-only here: no action takes one.
    await expect(repo.createTag(wt, 'v0', '')).rejects.toThrow(/Not a project/)
    await expect(repo.switchBranch(wt, 'main')).rejects.toThrow(/Not a project/)
  })
})

describe('remotes, tags, history and identity', () => {
  it('adds a remote and changes its URL', async () => {
    const second = join(outer, 'second.git')
    execFileSync('git', ['init', '-q', '--bare', second])
    expect(await repo.addRemote(proj, 'backup', second)).toBe('Added backup.')
    await expect(repo.addRemote(proj, '-x', second)).rejects.toThrow(/letters, digits/)
    await expect(repo.addRemote(proj, 'backup', second)).rejects.toThrow(/already exists/)
    expect(await repo.setRemoteUrl(proj, 'backup', join(outer, 'third.git'))).toBe("Changed backup's URL.")
    expect(git(proj, 'remote', 'get-url', 'backup')).toBe(join(outer, 'third.git'))
  })

  it('shows and says no password or token of a remote URL, whatever its scheme, nor in what git says when it fails', async () => {
    const SECRET = 'FAKE-SECRET-607'
    git(proj, 'remote', 'add', 'web', `https://me:${SECRET}@127.0.0.1:1/r.git`)
    git(proj, 'remote', 'add', 'files', `ftp://me:${SECRET}@127.0.0.1:1/r.git`)
    git(proj, 'remote', 'add', 'query', `https://127.0.0.1:1/r.git?access_token=${SECRET}`)
    git(proj, 'remote', 'add', 'shell', `ssh://git:${SECRET}@127.0.0.1:1/r.git`)
    const shown = JSON.stringify((await repo.repoInfo(proj)).remotes)
    expect(shown).not.toContain(SECRET)
    expect(shown).toContain('https://•••@127.0.0.1:1/r.git')
    expect(shown).toContain('ftp://•••@127.0.0.1:1/r.git')
    expect(shown).toContain('https://127.0.0.1:1/r.git?•••')
    expect(shown).toContain('ssh://git:•••@127.0.0.1:1/r.git')
    // Fetching from them fails (nothing listens on port 1): git's message quotes the URLs, never the secret.
    const fetched = await repo.fetchAll(proj).then(() => 'fetched', (e: Error) => e.message)
    expect(fetched).toMatch(/^Couldn't fetch: /)
    expect(fetched).not.toContain(SECRET)
    // An edit that keeps the hidden part is refused: the whole URL has to be typed.
    expect(remoteUrlProblem('https://•••@127.0.0.1:1/r.git')).toMatch(/Type the whole URL/)
    await expect(repo.setRemoteUrl(proj, 'web', 'https://•••@127.0.0.1:1/r.git')).rejects.toThrow(/Type the whole URL/)
  })

  it("hides a secret with an apostrophe in it, which git quotes inside apostrophes, in no part", async () => {
    const PARTS = ['Q1QQ', 'Q2QQ', 'Q3QQ']
    const secret = PARTS.join("'")
    const query = `https://127.0.0.1:1/r.git?access_token=${secret}`
    const userinfo = `https://me:${secret}@127.0.0.1:1/r.git`
    const leaks = (text: string): string[] => PARTS.filter((p) => text.includes(p))
    // What git itself says about each (nothing listens on port 1), as gitSays shows it.
    for (const url of [query, userinfo]) {
      let err = ''
      try {
        execFileSync('git', ['-c', 'http.proxy=', 'ls-remote', url], { cwd: proj, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        err = String((e as { stderr?: string }).stderr ?? '')
      }
      expect(err).toMatch(/unable to access|Failed to connect|Could not resolve|Connection refused/i)
      const said = repo.gitSays({ out: '', ok: false, buf: Buffer.alloc(0), err, code: 128 })
      expect(leaks(said), said).toEqual([])
    }
    // And through an action, whose failure is also cleaned of the configured URLs' exact secrets.
    git(proj, 'remote', 'add', 'q', query)
    git(proj, 'remote', 'add', 'u', userinfo)
    const fetched = await repo.fetchAll(proj).then(() => 'fetched', (e: Error) => e.message)
    expect(fetched).toMatch(/^Couldn't fetch: /)
    expect(leaks(fetched), fetched).toEqual([])
    expect(leaks(JSON.stringify((await repo.repoInfo(proj)).remotes))).toEqual([])
  })

  it('tags the commit, annotated with a message, pushes the tag when asked, and lists commits and tags', async () => {
    commit(proj, 'b.txt')
    const head = git(proj, 'rev-parse', '--short', 'HEAD')
    expect(await repo.createTag(proj, 'v1.0', 'First', 'origin')).toBe(`Tagged ${head} v1.0 and pushed it to origin.`)
    expect(git(remote, 'tag', '--list')).toContain('v1.0')
    expect(await repo.createTag(proj, 'light', '')).toBe(`Tagged ${head} light.`)
    await expect(repo.createTag(proj, 'bad name', '')).rejects.toThrow("bad name isn't a valid tag name.")
    const h = await repo.repoHistory(proj)
    expect(h.commits.map((c) => c.subject)).toEqual(['add b.txt', 'add a.txt'])
    expect(h.commits[0]).toMatchObject({ short: head })
    expect(h.commits[0].refs).toContain('tag: v1.0')
    expect(h.tags.find((t) => t.name === 'v1.0')).toMatchObject({ annotated: true, subject: 'First', commit: head })
    expect(h.tags.find((t) => t.name === 'light')).toMatchObject({ annotated: false, commit: head })
  })

  it("sets this repository's identity, and removes it so the global one applies", async () => {
    expect(await repo.setIdentity(proj, 'Dev', '1+dev@users.noreply.github.com')).toBe("Set this repository's commit identity.")
    let info = await repo.repoInfo(proj)
    expect(info.identity.local).toEqual({ name: 'Dev', email: '1+dev@users.noreply.github.com' })
    expect(info.identity.effective.email).toBe('1+dev@users.noreply.github.com')
    await expect(repo.setIdentity(proj, 'Dev', 'not-an-email')).rejects.toThrow("That isn't an email address")
    await repo.setIdentity(proj, '', '')
    info = await repo.repoInfo(proj)
    expect(info.identity.local).toEqual({})
    // No global identity in tests (noGlobalGit.ts): commits would fail, and the section says so.
    expect(identityWarnings(info.identity, info.remotes)[0]).toMatch(/no user\.name or user\.email/)
  })
})

describe('what the window says', () => {
  const s = (over: Partial<GitRepoSummary>): GitRepoSummary => ({ isRepo: true, branch: 'main', head: 'abc1234', state: null, upstream: null, remotes: [], fetchedAt: null, ...over })

  it('puts the branch, remote and counts in the status bar', () => {
    expect(gitStatusText(s({ upstream: { name: 'origin/main', remote: 'origin', ahead: 2, behind: 0 }, remotes: ['origin'] }))).toBe('main · origin · ↑2 ↓0')
    expect(gitStatusText(s({ remotes: ['origin'] }))).toBe('main · no upstream')
    expect(gitStatusText(s({}))).toBe('main')
    expect(gitStatusText(s({ branch: null, state: 'rebase' }))).toBe('detached at abc1234 · rebasing')
    expect(gitStatusText(s({ isRepo: false }))).toBe('')
    expect(aheadBehindText({ ahead: 1, behind: 1, gone: true })).toBe('upstream gone')
  })

  it('says why the folder is busy: an agent at work in it, then the merge slot', () => {
    expect(folderBusy([{ name: 'B1', status: 'idle' }], [], 'switch')).toBeNull()
    expect(folderBusy([{ name: 'B1', status: 'waiting' }], [], 'pull')).toBe('B1 is waiting for your answer in the project folder: pull once it has finished.')
    expect(folderBusy([], [{ branch: 'main', holder: null, byUser: true, waiting: [] }], 'switch')).toBe('Your merge into main is running: switch branches once it is done.')
    expect(folderBusy([], [{ branch: 'main', holder: null, waiting: ['B2', 'B3'] }], 'pull')).toBe('B2, B3 are waiting for the merge slot for main: pull once those merges are done.')
  })

  it('hides passwords and tokens in URLs, in text too, and warns of a personal email on commits that go to GitHub', () => {
    expect(redactRemoteUrl('https://user:ghp_x@github.com/a/b.git')).toBe('https://•••@github.com/a/b.git')
    expect(redactRemoteUrl('https://ghp_x@github.com/a/b.git')).toBe('https://•••@github.com/a/b.git')
    expect(redactRemoteUrl('ssh://git@host/a.git')).toBe('ssh://git@host/a.git')
    expect(redactRemoteUrl('https://host/a.git?x=1&token=s;y=2')).toBe('https://host/a.git?•••')
    expect(redactRemoteUrl("https://me:pa'ss/word@host/a.git#frag")).toBe('https://•••@host/a.git#•••')
    expect(redactRemoteUrl("ssh://git:pa'ss@host/a.git")).toBe('ssh://git:•••@host/a.git')
    expect(redactRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(redactRemoteUrl('C:\\repos\\r.git')).toBe('C:\\repos\\r.git')
    expect(redactUrlsIn("fatal: unable to access 'https://h/r.git?access_token=a'b/': Failed")).toBe("fatal: unable to access 'https://h/r.git?••• Failed")
    expect(urlSecrets("https://me:pa'ss@h/r?t=tok'en%21")).toEqual(expect.arrayContaining(["me:pa'ss", "pa'ss", "t=tok'en%21", "tok'en%21", "tok'en!"]))
    expect(scrubSecrets("x pa'ss y", ["pa'ss"])).toBe('x ••• y')
    expect(isNoReplyEmail('123+me@users.noreply.github.com')).toBe(true)
    const github = [{ fetchUrl: 'git@github.com:a/b.git', pushUrl: 'git@github.com:a/b.git' }]
    const me = { local: {}, global: { name: 'Me', email: 'me@example.com' }, effective: { name: 'Me', email: 'me@example.com' } }
    expect(identityWarnings(me, github)).toEqual([expect.stringContaining('show me@example.com to anyone')])
    expect(identityWarnings(me, [{ fetchUrl: 'https://gitlab.com/a/b.git', pushUrl: 'https://gitlab.com/a/b.git' }])).toEqual([])
    expect(identityWarnings({ ...me, effective: { name: 'Me', email: '1+me@users.noreply.github.com' } }, github)).toEqual([])
  })

  it('checks what the forms send', () => {
    expect(remoteNameProblem('origin')).toBeNull()
    expect(remoteNameProblem('-x')).not.toBeNull()
    expect(remoteUrlProblem('--upload-pack=x')).not.toBeNull()
    expect(remoteUrlProblem('C:\\repos\\r.git')).toBeNull()
    expect(identityProblem('A\nB', '')).not.toBeNull()
    expect(identityProblem('', '')).toBeNull()
  })
})
