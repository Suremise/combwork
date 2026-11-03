// The Git view (#607): a project folder's branch, upstream and ahead/behind (as of the last fetch: never fetched by
// itself), remotes, history, tags and identity, and the user's actions on them, against real git with local bare
// repositories as remotes (never a real remote). Switching branch and pulling are refused while an agent works in the
// folder or the merge slot is held, also when the agent starts while the action waits for the lock; actions take only a
// project folder, never a worktree; a push is never forced; no password or token in a remote URL is shown or logged.
// Each test makes its own repositories (`fresh`), so any one runs alone or in any order.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
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
    projectConfig: async () => ({ version: 2, agents }),
    // The folder contract (#1451) reads no slots here: no Assistant home, no board.
    isAssistantHome: () => false
  },
  workspaceOf: () => ({ refresh: async () => ({}), path: 'ws', worktreesRoot: `${proj}.worktrees`, info: () => ({ projects: [{ path: proj, name: 'proj', platform: { id: 'git' } }] }), projectConfig: async () => ({ version: 2, agents }) })
}))
/** The project's workflow target (#1642: '' for none, the default branch), and the board's open cards' lines. */
let workTarget = ''
let cardLines: { line: string; stage: string; lines?: string[] }[] = []
vi.mock('../src/main/workflow/rulesets', () => ({ resolvedOf: () => ({ options: { target: workTarget } }) }))
vi.mock('../src/main/workflow/cardWork', () => ({ workBadges: () => cardLines.map((b, i) => ({ card: i + 1, line: b.line, stage: b.stage, noCode: false, lines: b.lines ?? [b.line] })) }))
vi.mock('../src/main/sessions', () => ({ sessions: { liveFor: (_p: string, id: string) => (live[id] ? { status: live[id], cwd: agents.find((x) => x.id === id)?.worktree?.path ?? proj } : null), agentNow: (_p: string, id: string) => (live[id] ? { pending: pendingInput.has(id) } : null), lineWaiting: (_p: string, id: string) => typedWaiting.has(id) } }))
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
/** While set, the next deletion of a branch (#1642: `git update-ref -d`, or a push deleting one) stops before git starts, likewise. */
let refDoor: { entered: () => void; open: Promise<void> } | null = null
/** While set, a git command it matches fails as git would, without running (HI-1180: a worktree that can't be removed). */
let gitFails: ((args: string[]) => boolean) | null = null
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
      if (gitFails?.(args[1])) return { ok: false, code: 1, out: '', err: 'error: failed (a test)', buf: Buffer.from('') }
      const atRef = refDoor
      if (atRef && ((args[1][0] === 'update-ref' && args[1][1] === '-d') || args[1][0] === 'push')) {
        refDoor = null
        atRef.entered()
        await atRef.open
      }
      return real.git(...args)
    }
  }
})

const repo = await import('../src/main/gitRepo')
const fence = await import('../src/main/folderFence')
const { gitTestHooks: gitHooks } = await import('../src/main/git')

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
  refDoor = null
  gitFails = null
  asUser.mockClear()
  workTarget = ''
  cardLines = []
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

  it('names the branch by its whole ref, with its upstream, though a tag has its name (HI-2426)', async () => {
    git(proj, 'tag', 'main')
    git(proj, 'tag', 'origin/main')
    const s = await repo.repoSummary(proj)
    expect(s).toMatchObject({ branch: 'main', upstream: { name: 'origin/main', remote: 'origin', ahead: 0, behind: 0 } })
    expect(gitStatusText(s)).toBe('main · origin · ↑0 ↓0')
    // Branches & remotes names them so too, the folder's branch marked current.
    const info = await repo.repoInfo(proj)
    expect(info.branches.map((b) => [b.name, b.current, b.upstream])).toEqual([['main', true, 'origin/main']])
    expect([info.remoteBranches, info.remoteRows?.map((r) => [r.remote, r.branch])]).toEqual([['origin/main'], [['origin', 'main']]])
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

describe("the summary read again only when what it's read from changed (HI-2115)", () => {
  /** How many gits a read of the summary started, and its answer. */
  const counted = async (): Promise<{ n: number; s: GitRepoSummary }> => {
    let n = 0
    gitHooks.started = () => void n++
    try {
      return { s: await repo.repoSummary(proj), n }
    } finally {
      gitHooks.started = undefined
    }
  }
  /** What git says now, read with nothing kept: the answer a read must give. */
  const fromGit = async (): Promise<GitRepoSummary> => {
    repo.forgetSummaries()
    return repo.repoSummary(proj)
  }
  /** Read again with nothing changed: no git, and git's answer. */
  const same = async (): Promise<GitRepoSummary> => {
    await counted()
    const again = await counted()
    expect(again.n).toBe(0)
    expect(again.s).toEqual(await fromGit())
    return again.s
  }
  /** Read after a change: git, and git's answer. */
  const reread = async (): Promise<GitRepoSummary> => {
    const r = await counted()
    expect(r.n).toBeGreaterThan(0)
    expect(r.s).toEqual(await fromGit())
    return r.s
  }

  beforeEach(() => repo.forgetSummaries())

  it('nothing changed: no git; a commit, a branch switch, a detached HEAD and a fetch: git, as git says', async () => {
    await same()
    commit(proj, 'b.txt')
    expect((await reread()).upstream).toMatchObject({ ahead: 1 })
    await same()
    git(proj, 'switch', '-q', '-c', 'feature/y')
    expect(await reread()).toMatchObject({ branch: 'feature/y', upstream: null })
    await same()
    git(proj, 'checkout', '-q', '--detach')
    expect(await reread()).toMatchObject({ branch: null, head: git(proj, 'rev-parse', '--short', 'HEAD') })
    git(proj, 'switch', '-q', 'main')
    await same()
    // The upstream's ref moved by a fetch in a terminal: behind, at once.
    theyPush('o.txt')
    git(proj, 'fetch', '-q')
    const fetched = await reread()
    expect(fetched.upstream).toMatchObject({ ahead: 1, behind: 1 })
    expect(fetched.fetchedAt).toBeGreaterThan(0)
  })

  it("a remote or upstream changed in the repository's config, an included file or the global config: read again", async () => {
    await same()
    git(proj, 'remote', 'add', 'backup', remote)
    expect((await reread()).remotes).toEqual(['backup', 'origin'])
    await same()
    git(proj, 'branch', '--unset-upstream')
    expect((await reread()).upstream).toBeNull()
    await same()
    // The global config (a file of this test's): a remote added there only, nothing of the repository changed.
    mkdirSync(outer, { recursive: true })
    const global = join(outer, 'global.gitconfig')
    writeFileSync(global, '')
    const was = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = global
    try {
      await same()
      writeFileSync(global, `[remote "glob"]\n\turl = ${remote.replace(/\\/g, '/')}\n`)
      expect((await reread()).remotes).toEqual(['backup', 'glob', 'origin'])
      await same()
      // An include in the global config: not plain, so git each time.
      writeFileSync(global, `[remote "glob"]\n\turl = ${remote.replace(/\\/g, '/')}\n[include]\n\tpath = elsewhere.config\n`)
      expect((await reread()).remotes).toEqual(['backup', 'glob', 'origin'])
      await reread()
    } finally {
      process.env.GIT_CONFIG_GLOBAL = was
    }
  })

  it("an include in the repository's config: not plain, so git each time (HR3's HI-2115 round 2, finding 2)", async () => {
    await same()
    // HR3's case: an include whose path line carries a comment, its file written only after the summary was read.
    writeFileSync(join(proj, '.git', 'config'), `${readFileSync(join(proj, '.git', 'config'), 'utf8')}[include]\n\tpath = later.config # this file arrives later\n`)
    expect((await reread()).remotes).toEqual(['origin'])
    await reread()
    writeFileSync(join(proj, '.git', 'later.config'), `[remote "later"]\n\turl = ${remote.replace(/\\/g, '/')}\n`)
    expect((await reread()).remotes).toEqual(['later', 'origin'])
    await reread()
  })

  it("a branch whose commit the files can't give (reftable, unborn) is never kept (HR3's HI-2115 round 1, finding 2)", async () => {
    const table = join(outer, 'table')
    mkdirSync(outer, { recursive: true })
    execFileSync('git', ['init', '-q', '--ref-format=reftable', '-b', 'main', table])
    commit(table, 'a.txt')
    const read = async (): Promise<{ n: number; s: GitRepoSummary }> => {
      let n = 0
      gitHooks.started = () => void n++
      try {
        return { s: await repo.repoSummary(table), n }
      } finally {
        gitHooks.started = undefined
      }
    }
    expect((await read()).n).toBeGreaterThan(0)
    expect((await read()).n).toBeGreaterThan(0)
    // The very next read after a commit is git's: never the last one's head.
    commit(table, 'b.txt')
    expect((await read()).s.head).toBe(git(table, 'rev-parse', '--short', 'HEAD'))
    // Unborn (no commit on its branch yet): asked each time too.
    git(proj, 'switch', '-q', '--orphan', 'empty')
    expect((await counted()).n).toBeGreaterThan(0)
    expect((await counted()).n).toBeGreaterThan(0)
  })

  it('HI-2135: only the most recently read folders are kept; one dropped is read with git again, as it is now', async () => {
    mkdirSync(outer, { recursive: true })
    const repoAt = (name: string): string => {
      const d = join(outer, name)
      execFileSync('git', ['init', '-q', '-b', 'main', d])
      commit(d, 'a.txt')
      return d
    }
    const [a, b] = [repoAt('a'), repoAt('b')]
    const gitsFor = async (root: string): Promise<number> => {
      let n = 0
      gitHooks.started = () => void n++
      try {
        await repo.repoSummary(root)
        return n
      } finally {
        gitHooks.started = undefined
      }
    }
    repo.summariesForTests(2)
    try {
      await same()
      expect(await gitsFor(a)).toBeGreaterThan(0)
      expect(repo.summariesForTests()).toBe(2)
      // proj read again (no git): the most recent, so b drops a, the oldest.
      expect((await counted()).n).toBe(0)
      expect(await gitsFor(b)).toBeGreaterThan(0)
      expect(repo.summariesForTests()).toBe(2)
      // proj again (no git), then a, read with git again: it drops b.
      expect((await counted()).n).toBe(0)
      expect(await gitsFor(a)).toBeGreaterThan(0)
      // b read with git again drops proj, now the oldest; a stays. proj, changed meanwhile, is read with git, as it is now.
      expect(await gitsFor(b)).toBeGreaterThan(0)
      commit(proj, 'b.txt')
      expect(await gitsFor(a)).toBe(0)
      expect(repo.summariesForTests()).toBe(2)
      expect(await reread()).toMatchObject({ head: git(proj, 'rev-parse', '--short', 'HEAD'), upstream: { ahead: 1 } })
    } finally {
      repo.summariesForTests(null)
    }
  })

  it('config given in the environment is never kept', async () => {
    process.env.GIT_CONFIG_COUNT = '0'
    try {
      expect((await counted()).n).toBeGreaterThan(0)
      expect((await counted()).n).toBeGreaterThan(0)
    } finally {
      delete process.env.GIT_CONFIG_COUNT
    }
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
    // Each branch by its outcome, then the tags.
    expect(await repo.pushToRemote(proj, 'backup', 'all')).toBe('Pushed every branch and tag to backup:\nPushed: feature/a.\nAlready up to date: main.\nTags pushed: v1.')
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
    git(proj, 'branch', 'feature/same', git(backup, 'rev-parse', 'main'))
    git(proj, 'push', '-q', 'backup', 'feature/same')
    // Each branch by name with its outcome: pushed, already up to date, refused.
    await expect(repo.pushToRemote(proj, 'backup', 'all')).rejects.toThrow("backup refused 1 branch or tag (Hive never forces a push): it has commits they haven't, so pull or merge them first. What happened to each:\nPushed: feature/b, main.\nAlready up to date: feature/same.\nRefused: feature/a.")
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
    // The confirmation's set: refused when it differs from the branches tracking it now.
    expect(await repo.remoteTracking(proj, 'nas')).toEqual(['feature/a'])
    await expect(repo.removeRemote(proj, 'nas', [])).rejects.toThrow('The branches tracking nas changed since you were asked, so nothing was removed: look at them again.')
    expect(upstreamOf('feature/a')).toBe('nas/main')
    expect(await repo.removeRemote(proj, 'nas', ['feature/a'])).toBe('Removed nas: feature/a no longer tracks a remote branch.')
    expect([upstreamOf('feature/a'), upstreamOf('main')]).toEqual(['', 'origin/main'])
    expect(git(proj, 'remote')).toBe('origin')
    expect(git(proj, 'for-each-ref', 'refs/remotes/nas')).toBe('')
    await expect(repo.removeRemote(proj, 'nas')).rejects.toThrow("There's no remote nas.")
  })

  it('names every branch the remote refuses, however many (HR5’s round 2: none left out past the first few)', async () => {
    const backup = addBackup()
    const head = git(proj, 'rev-parse', 'HEAD')
    const names = Array.from({ length: 30 }, (_, i) => `a${String(i).padStart(3, '0')}`)
    execFileSync('git', ['update-ref', '--stdin'], { cwd: proj, input: names.map((n) => `create refs/heads/${n} ${head}\n`).join('') })
    // The remote's a000–a026 have a commit these branches haven't.
    const newer = git(proj, 'commit-tree', '-p', head, '-m', 'theirs', `${head}^{tree}`)
    git(proj, 'push', '-q', 'backup', ...names.slice(0, 27).map((n) => `${newer}:refs/heads/${n}`))
    const err = await repo.pushToRemote(proj, 'backup', 'all').then(() => '', (e: Error) => e.message)
    expect(err).toContain(`Refused: ${names.slice(0, 27).join(', ')}.`)
    expect(err).toContain(`Pushed: ${[...names.slice(27), 'main'].join(', ')}.`)
    expect(git(backup, 'rev-parse', 'a026')).toBe(newer)
  })

  it('pushes the branch the user confirmed, by name, whichever is checked out by the time it runs', async () => {
    const backup = addBackup()
    git(proj, 'checkout', '-q', '-b', 'private')
    commit(proj, 'private.txt')
    expect(await repo.pushToRemote(proj, 'backup', 'branch', 'main')).toBe('Pushed main to backup/main.')
    expect(git(backup, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('main')
    await expect(repo.pushToRemote(proj, 'backup', 'branch', 'gone')).rejects.toThrow("There's no branch gone.")
  })

  it('lists every branch tracking a remote, past the view’s cap of branches shown', async () => {
    addBackup()
    await repo.pushToRemote(proj, 'backup', 'branch')
    const head = git(proj, 'rev-parse', 'HEAD')
    // More branches than the view shows (BRANCHES_SHOWN), with the one tracking backup made last, so listed last.
    execFileSync('git', ['update-ref', '--stdin'], { cwd: proj, input: Array.from({ length: 210 }, (_, i) => `create refs/heads/b${String(i).padStart(3, '0')} ${head}\n`).join('') })
    git(proj, 'branch', 'zzz-hidden')
    git(proj, 'branch', '--set-upstream-to=backup/main', '--', 'zzz-hidden')
    expect((await repo.repoInfo(proj)).branches.some((b) => b.name === 'zzz-hidden')).toBe(false)
    expect(await repo.remoteTracking(proj, 'backup')).toEqual(['zzz-hidden'])
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
    // An agent working in its own folder (its session there: a 0.9 worktree here, a slot alike) doesn't hold the folder.
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

  it('History shows the project’s target by default, any branch asked for, a page at a time (#1643)', async () => {
    git(proj, 'checkout', '-q', '-b', 'release')
    for (let i = 1; i <= 25; i++) commit(proj, `r${i}.txt`)
    git(proj, 'checkout', '-q', 'main')
    // The target (where the work goes), not the folder's branch.
    const first = await repo.repoHistory(proj, { workTarget: 'release' })
    expect(first).toMatchObject({ ref: 'refs/heads/release', defaultRef: 'refs/heads/release', target: 'release', page: 1, pages: 2, total: 26 })
    expect(first.commits).toHaveLength(20)
    expect(first.commits[0].subject).toBe('add r25.txt')
    expect(first.branches).toEqual(['main', 'release'])
    expect(first.remoteBranches).toEqual(['origin/main'])
    // Back through the older ones; a page past the last is the last.
    const second = await repo.repoHistory(proj, { workTarget: 'release', page: 2 })
    expect(second.commits.map((c) => c.subject)).toEqual([...Array.from({ length: 5 }, (_, i) => `add r${5 - i}.txt`), 'add a.txt'])
    expect((await repo.repoHistory(proj, { workTarget: 'release', page: 99 })).page).toBe(2)
    // Any branch, local or remote; one that isn't a branch here shows the default.
    expect(await repo.repoHistory(proj, { workTarget: 'release', ref: 'refs/heads/main' })).toMatchObject({ ref: 'refs/heads/main', total: 1, pages: 1 })
    expect(await repo.repoHistory(proj, { workTarget: 'release', ref: 'refs/remotes/origin/main' })).toMatchObject({ ref: 'refs/remotes/origin/main', total: 1 })
    for (const bad of ['--all', 'main', 'refs/heads/nope', 'refs/tags/x']) expect(await repo.repoHistory(proj, { workTarget: 'release', ref: bad })).toMatchObject({ ref: 'refs/heads/release' })
    // No target, or one that isn't a branch here: the folder's branch.
    expect(await repo.repoHistory(proj, { workTarget: 'nope' })).toMatchObject({ ref: 'refs/heads/main', target: null })
    expect(await repo.repoHistory(proj)).toMatchObject({ ref: 'refs/heads/main', target: null })
    // A local branch named as a remote's (round 1): each shows its own commits, from its first page.
    git(proj, 'checkout', '-q', '-b', 'origin/main')
    commit(proj, 'local-only.txt')
    git(proj, 'checkout', '-q', 'main')
    const mine = await repo.repoHistory(proj, { workTarget: 'release', ref: 'refs/heads/origin/main', page: 2 })
    const theirs = await repo.repoHistory(proj, { workTarget: 'release', ref: 'refs/remotes/origin/main', page: 2 })
    expect(mine).toMatchObject({ ref: 'refs/heads/origin/main', page: 1, total: 2 })
    expect(mine.commits[0].subject).toBe('add local-only.txt')
    expect(theirs).toMatchObject({ ref: 'refs/remotes/origin/main', page: 1, total: 1 })
    expect(theirs.commits[0].hash).toBe(git(proj, 'rev-parse', 'refs/remotes/origin/main'))
    expect(mine.branches).toContain('origin/main')
    expect(mine.remoteBranches).toContain('origin/main')
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

describe('branches by state, and cleaning up the merged ones (#1642)', () => {
  /**
   * The project's work merges into 1.0.0 (ahead of main): hive/hb1 and hive/hb2 merged into it and unused, hive/slot
   * merged but checked out in a worktree (a slot's), hive/card merged but an open card's line, spike/x with a commit of
   * its own. All pushed to origin.
   */
  const setUp = (): Record<string, string> => {
    workTarget = '1.0.0'
    git(proj, 'checkout', '-q', '-b', '1.0.0')
    commit(proj, 'release.txt')
    for (const b of ['hive/hb1', 'hive/hb2', 'hive/slot', 'hive/card']) git(proj, 'branch', b)
    git(proj, 'checkout', '-q', '-b', 'spike/x')
    commit(proj, 'spike.txt')
    git(proj, 'checkout', '-q', 'main')
    git(proj, 'worktree', 'add', '-q', join(proj, '..', 'slot-a'), 'hive/slot')
    git(proj, 'push', '-q', 'origin', '1.0.0', 'hive/hb1', 'hive/hb2', 'hive/slot', 'hive/card', 'spike/x')
    // No origin/HEAD, on any git: 2.48 and later make it on fetch (remote.<name>.followRemoteHEAD), and origin/main would
    // then be kept as the remote's default branch, not as the project's (HI-2401). Older git ignores the setting.
    git(proj, 'config', 'remote.origin.followRemoteHEAD', 'never')
    git(proj, 'fetch', '-q', 'origin')
    cardLines = [{ line: 'hive/card', stage: 'review' }]
    return Object.fromEntries(['hive/hb1', 'hive/hb2', 'hive/slot', 'hive/card', 'spike/x', 'main', '1.0.0'].map((b) => [b, git(proj, 'rev-parse', b)]))
  }
  const branchNames = (cwd: string): string[] => git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort()

  it("measures each branch against the project's target and offers only the merged ones nothing uses", async () => {
    setUp()
    const info = await repo.repoInfo(proj, workTarget)
    expect([info.target, info.defaultBranch]).toEqual(['1.0.0', 'main'])
    const to = Object.fromEntries(info.branches.map((b) => [b.name, b.toTarget]))
    expect(to).toEqual({ '1.0.0': 0, main: 0, 'hive/hb1': 0, 'hive/hb2': 0, 'hive/slot': 0, 'hive/card': 0, 'spike/x': 1 })
    expect(info.remoteRows?.find((r) => r.name === 'origin/spike/x')).toMatchObject({ remote: 'origin', branch: 'spike/x', toTarget: 1 })
    const { busyLines, cleanupOffer, leftoverBranches, localGroup } = await import('../src/shared/branchCleanup')
    const busy = busyLines(new Map([['hive/card', [{ stage: 'review' as const }]]]))
    const groups = Object.fromEntries(info.branches.map((b) => [b.name, localGroup(b, info, busy)]))
    expect(groups).toEqual({ '1.0.0': 'inUse', main: 'inUse', 'hive/slot': 'inUse', 'hive/card': 'inUse', 'hive/hb1': 'merged', 'hive/hb2': 'merged', 'spike/x': 'unmerged' })
    const offer = cleanupOffer(info, busy)
    expect(offer.local.map((b) => b.name)).toEqual(['hive/hb1', 'hive/hb2'])
    // Never the target, the default branch, a slot's or an open card's branch on the remote either; unmerged never.
    expect(offer.remote.map((r) => [r.name, r.withLocal])).toEqual([
      ['origin/hive/hb1', true],
      ['origin/hive/hb2', true]
    ])
    // The Changes tab's leftover branches (HI-1823): the same free branches, merged and not, never one in use.
    const left = leftoverBranches(info, busy)
    expect([left.merged.map((b) => b.name), left.unmerged.map((b) => [b.name, b.toTarget])]).toEqual([['hive/hb1', 'hive/hb2'], [['spike/x', 1]]])
    // With the card Done, its branch is a leftover too; with no target, none is.
    expect(leftoverBranches(info, busyLines(new Map([['hive/card', [{ stage: 'done' as const }]]]))).merged.map((b) => b.name)).toEqual(['hive/card', 'hive/hb1', 'hive/hb2'])
    expect(leftoverBranches({ ...info, target: null }, busy)).toEqual({ merged: [], unmerged: [] })
    // Without a target asked for (an action reading the branches), nothing is counted.
    expect((await repo.repoInfo(proj)).branches.every((b) => b.toTarget === undefined)).toBe(true)
  })

  it("the Changes tab's leftover read has every local branch, past the 200 Branches & remotes shows (HI-1823)", async () => {
    setUp()
    // 205 branches at one commit (git sorts a tie by name), then zz/leftover: past the first 200 by date.
    const at = git(proj, 'rev-parse', '1.0.0')
    const lines = Array.from({ length: 205 }, (_, i) => `create refs/heads/aa/${String(i).padStart(3, '0')} ${at}`).join('\n')
    execFileSync('git', ['update-ref', '--stdin'], { cwd: proj, input: `${lines}\ncreate refs/heads/zz/leftover ${at}\n` })
    const shown = await repo.repoInfo(proj, workTarget)
    expect(shown.branches.some((b) => b.name === 'zz/leftover')).toBe(false)
    const all = await repo.leftoverInfo(proj, workTarget)
    expect(all.branches).toHaveLength(7 + 205 + 1)
    expect(all.branches.find((b) => b.name === 'zz/leftover')).toMatchObject({ toTarget: 0, worktree: null })
    expect(all.branches.find((b) => b.name === 'hive/slot')?.worktree).toBeTruthy()
    // Counted: merged by git's word, spike/x's one commit; nothing unknown here.
    expect([all.branches.find((b) => b.name === 'spike/x')?.toTarget, all.uncounted]).toEqual([1, 0])
    const { busyLines, leftoverBranches } = await import('../src/shared/branchCleanup')
    const left = leftoverBranches(all, busyLines(new Map([['hive/card', [{ stage: 'review' as const }]]])))
    expect(left.merged.map((b) => b.name)).toContain('zz/leftover')
    expect([left.merged.length, left.unmerged.map((b) => b.name)]).toEqual([2 + 205 + 1, ['spike/x']])
  })

  it("never deletes an open card's earlier line: one back from Done that started again elsewhere (HI-1823)", async () => {
    const at = setUp()
    // Card 2 started on hive/hb1, went to Done, and is open again, started this time in the project folder (on main).
    cardLines = [{ line: 'hive/card', stage: 'review' }, { line: 'main', stage: 'active', lines: ['hive/hb1', 'main'] }]
    const said = await repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }, { name: 'hive/hb2', sha: at['hive/hb2'] }])
    expect(said).toContain('An open card works on hive/hb1')
    expect(branchNames(proj)).toContain('hive/hb1')
    expect(branchNames(proj)).not.toContain('hive/hb2')
    // Done again: its lines are leftovers, deleted as any other.
    cardLines = [{ line: 'hive/card', stage: 'review' }, { line: 'main', stage: 'done', lines: ['hive/hb1', 'main'] }]
    expect(await repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }])).toMatch(/Deleted hive\/hb1\./)
  })

  it('names each branch by its whole ref, though a tag has its name (HR1, HI-1823 round 1)', async () => {
    setUp()
    // Tags called as the target, the folder's branch, a worktree's, an open card's and two free ones (git's short names
    // would turn each into heads/…).
    for (const t of ['1.0.0', 'main', 'hive/slot', 'hive/card', 'hive/hb1', 'spike/x']) git(proj, 'tag', t, 'main')
    const all = await repo.leftoverInfo(proj, workTarget)
    expect(all.branches.map((b) => b.name).sort()).toEqual(['1.0.0', 'hive/card', 'hive/hb1', 'hive/hb2', 'hive/slot', 'main', 'spike/x'])
    expect(all.branches.find((b) => b.name === 'main')?.current).toBe(true)
    expect(all.branches.find((b) => b.name === 'hive/slot')?.worktree).toBeTruthy()
    expect(Object.fromEntries(all.branches.map((b) => [b.name, b.toTarget]))).toMatchObject({ '1.0.0': 0, 'hive/hb1': 0, 'spike/x': 1 })
    const { busyLines, leftoverBranches } = await import('../src/shared/branchCleanup')
    const left = leftoverBranches(all, busyLines(new Map([['hive/card', [{ stage: 'review' as const }]]])))
    // The target, the folder's, the worktree's and the open card's stay protected; the free ones are offered by name.
    expect([left.merged.map((b) => b.name), left.unmerged.map((b) => b.name)]).toEqual([['hive/hb1', 'hive/hb2'], ['spike/x']])
    // And deleted by that name, the tag of the same name kept.
    const said = await repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: git(proj, 'rev-parse', 'refs/heads/hive/hb1') }])
    expect(said).toMatch(/Deleted hive\/hb1\./)
    expect(git(proj, 'tag', '--list', 'hive/hb1')).toBe('hive/hb1')
  })

  it('keeps the branch checked out in the project folder, here and on the remote, though a tag has its name (HI-2426)', async () => {
    const at = setUp()
    git(proj, 'checkout', '-q', 'hive/hb1')
    git(proj, 'tag', 'hive/hb1', 'main')
    // With a free branch beside it, so each says what it did rather than refusing the whole request.
    expect(await repo.deleteRemoteBranches(proj, 'origin', [{ name: 'origin/hive/hb1', sha: at['hive/hb1'] }, { name: 'origin/hive/hb2', sha: at['hive/hb2'] }])).toContain('origin/hive/hb1 is checked out in the project folder')
    expect(await repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }, { name: 'hive/hb2', sha: at['hive/hb2'] }])).toContain('hive/hb1 is checked out in the project folder')
    const has = (cwd: string, b: string): boolean => git(cwd, 'for-each-ref', '--format=%(refname)', `refs/heads/${b}`) !== ''
    expect([has(proj, 'hive/hb1'), has(remote, 'hive/hb1'), has(proj, 'hive/hb2')]).toEqual([true, true, false])
  }, 120_000)

  it('deletes only what it was shown, merged and unused, and says why each other one is kept', async () => {
    const at = setUp()
    git(proj, 'config', 'branch.hive/hb1.description', 'gone with it')
    // hive/hb2 moves on after the dialog showed it.
    git(proj, 'checkout', '-q', 'hive/hb2')
    commit(proj, 'later.txt')
    git(proj, 'checkout', '-q', 'main')
    const items = ['hive/hb1', 'hive/hb2', 'hive/slot', 'hive/card', 'spike/x', 'main', '1.0.0'].map((name) => ({ name, sha: at[name] }))
    const said = await repo.deleteBranches(proj, [...items, { name: '--force', sha: at.main }, { name: 'nope', sha: at.main }])
    expect(branchNames(proj)).toEqual(['1.0.0', 'hive/card', 'hive/hb2', 'hive/slot', 'main', 'spike/x'])
    expect(readFileSync(join(proj, '.git', 'config'), 'utf8')).not.toContain('hive/hb1')
    expect(said).toMatch(/Deleted hive\/hb1\./)
    for (const why of ['hive/hb2 has moved since you were shown it', 'hive/slot is checked out in a worktree or slot', 'An open card works on hive/card', "spike/x has commits that aren't in 1.0.0", 'main is the default branch', '1.0.0 is the branch work merges into', "--force isn't a valid branch name", "There's no branch nope"]) expect(said).toContain(why)
    // Nothing to delete: refused, saying why.
    await expect(repo.deleteBranches(proj, [{ name: 'spike/x', sha: at['spike/x'] }])).rejects.toThrow(/spike\/x has commits that aren't in 1\.0\.0/)
  }, 120_000)

  /** A door that stops an action where `set` puts it, and the promises to wait at it and let it through. */
  const door = (): { at: Promise<void>; door: { entered: () => void; open: Promise<void> }; open: () => void } => {
    let entered!: () => void
    let open!: () => void
    const at = new Promise<void>((r) => (entered = r))
    return { at, door: { entered, open: new Promise<void>((r) => (open = r)) }, open }
  }

  it('reads what a branch is to the project when it deletes it, not when the request was queued (round 2)', async () => {
    const at = setUp()
    // The target becomes hive/hb1 while the deletion waits for the repository's lock.
    const d = door()
    lockDoor = d.door
    const queued = repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }])
    await d.at
    workTarget = 'hive/hb1'
    d.open()
    await expect(queued).rejects.toThrow(/hive\/hb1 is the branch work merges into/)
    lockDoor = null
    expect(branchNames(proj)).toContain('hive/hb1')
    // An open card takes a later branch of the batch while an earlier one is being deleted.
    workTarget = '1.0.0'
    const r = door()
    refDoor = r.door
    const batch = repo.deleteBranches(proj, [
      { name: 'hive/hb1', sha: at['hive/hb1'] },
      { name: 'hive/hb2', sha: at['hive/hb2'] }
    ])
    await r.at
    cardLines = [...cardLines, { line: 'hive/hb2', stage: 'doing' }]
    r.open()
    const said = await batch
    expect(said).toContain('An open card works on hive/hb2')
    expect(branchNames(proj)).toEqual(expect.arrayContaining(['hive/hb2']))
    expect(branchNames(proj)).not.toContain('hive/hb1')
  }, 120_000)

  /** A slot taking `branch` as slot preparation does: under the repository's lock. Says whether it got it. */
  const slotTakes = async (branch: string, folder: string): Promise<string> => {
    const { withRepoLock } = await import('../src/main/repoLock')
    return withRepoLock(proj, async () => {
      // The local branch only: `worktree add` alone would make it again from origin's of the same name.
      try {
        git(proj, 'show-ref', '--verify', '-q', `refs/heads/${branch}`)
      } catch {
        return 'no such branch'
      }
      git(proj, 'worktree', 'add', '-q', folder, branch)
      return 'took it'
    })
  }

  it('holds one lock from a branch’s check to its deletion: a slot, or a target change, waits for it (round 3)', async () => {
    const at = setUp()
    const { workflowWrite } = await import('../src/main/workflow/writes')
    const d = door()
    refDoor = d.door
    const deleting = repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }])
    await d.at
    // Checked and about to go: a slot claims it, and the target moves to it, each as Hive does (lock, workflow write).
    let claim = ''
    const claimed = slotTakes('hive/hb1', join(proj, '..', 'slot-b')).then((r) => (claim = r))
    let retargeted = false
    const retarget = workflowWrite(async () => {
      workTarget = 'hive/hb1'
      retargeted = true
    })
    expect([claim, retargeted]).toEqual(['', false])
    d.open()
    expect(await deleting).toMatch(/Deleted hive\/hb1\./)
    // Each went after it: the slot found no branch to take; the target changed once nothing could be deleted against it.
    expect(await claimed).toBe('no such branch')
    await retarget
    expect(retargeted).toBe(true)
  }, 120_000)

  it('deletes only at the commit it checked: a branch moved at the last moment by git outside Hive stays, with its commit (round 4)', async () => {
    const at = setUp()
    const d = door()
    refDoor = d.door
    const deleting = repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }, { name: 'hive/hb2', sha: at['hive/hb2'] }])
    await d.at
    // A plain git, which knows nothing of Hive's lock, moves hive/hb1 to a commit only it has.
    const unseen = git(proj, 'commit-tree', '-p', at['hive/hb1'], '-m', 'unseen work', `${at['hive/hb1']}^{tree}`)
    git(proj, 'update-ref', 'refs/heads/hive/hb1', unseen)
    d.open()
    const said = await deleting
    expect(said).toContain('hive/hb1 has moved since you were shown it: kept.')
    expect(said).toMatch(/Deleted hive\/hb2\./)
    expect(git(proj, 'rev-parse', 'hive/hb1')).toBe(unseen)
  }, 120_000)

  it('leaves no checked-out branch deleted: one checked out at the last moment is put back and kept, said in use (round 3)', async () => {
    const at = setUp()
    const d = door()
    refDoor = d.door
    const deleting = repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }, { name: 'hive/hb2', sha: at['hive/hb2'] }])
    await d.at
    // Something outside Hive's discipline checks hive/hb1 out after the check: git refuses to delete it.
    git(proj, 'worktree', 'add', '-q', join(proj, '..', 'outside'), 'hive/hb1')
    d.open()
    const said = await deleting
    expect(said).toContain('hive/hb1 is checked out in a worktree or slot: kept.')
    expect(said).toMatch(/Deleted hive\/hb2\./)
    expect(branchNames(proj)).toContain('hive/hb1')
  }, 120_000)

  it('a second Hive changing the target, with a turn of workflow writes of its own, waits for the delete on the shared repository lock (round 5)', async () => {
    const at = setUp()
    const { withRepoLocks } = await import('../src/main/repoLock')
    // Another Hive's own queue of workflow writes: a second, independently loaded instance of the module.
    const ours = await import('../src/main/workflow/writes')
    const otherHive = (await import(/* @vite-ignore */ `../src/main/workflow/writes?another-hive=${Date.now()}`)) as typeof ours
    expect(otherHive.workflowWrite).not.toBe(ours.workflowWrite)
    const d = door()
    refDoor = d.door
    const deleting = repo.deleteBranches(proj, [{ name: 'hive/hb1', sha: at['hive/hb1'] }])
    await d.at
    // Its target change as Hive writes one: the project's repository lock first, then its own turn.
    let retargeted = false
    const retarget = withRepoLocks([proj], () =>
      otherHive.workflowWrite(async () => {
        workTarget = 'hive/hb1'
        retargeted = true
      })
    )
    expect(retargeted).toBe(false)
    d.open()
    expect(await deleting).toMatch(/Deleted hive\/hb1\./)
    await retarget
    expect(retargeted).toBe(true)
  }, 120_000)

  it('holds the lock through a remote’s push: a slot taking the branch waits until it is deleted there (round 3)', async () => {
    const at = setUp()
    const d = door()
    refDoor = d.door
    const deleting = repo.deleteRemoteBranches(proj, 'origin', [{ name: 'origin/hive/hb1', sha: at['hive/hb1'] }])
    await d.at
    let claim = ''
    const claimed = slotTakes('hive/hb1', join(proj, '..', 'slot-c')).then((r) => (claim = r))
    expect(claim).toBe('')
    d.open()
    expect(await deleting).toMatch(/Deleted hive\/hb1 on origin\./)
    expect(branchNames(remote)).not.toContain('hive/hb1')
    // The local branch was never the remote's to delete: the slot takes it once the push is done.
    expect(await claimed).toBe('took it')
  }, 120_000)

  it('checks a remote branch under the repository lock with its use read then (round 2)', async () => {
    const at = setUp()
    const d = door()
    lockDoor = d.door
    const queued = repo.deleteRemoteBranches(proj, 'origin', [{ name: 'origin/hive/hb1', sha: at['hive/hb1'] }])
    await d.at
    cardLines = [{ line: 'hive/hb1', stage: 'doing' }]
    d.open()
    await expect(queued).rejects.toThrow(/An open card works on origin\/hive\/hb1/)
    lockDoor = null
    expect(branchNames(remote)).toContain('hive/hb1')
  }, 120_000)

  it('deletes an unmerged branch only alone, at the commit shown, after listing the commits it drops', async () => {
    const at = setUp()
    const drops = await repo.branchDrops(proj, 'spike/x')
    expect(drops).toMatchObject({ target: '1.0.0', total: 1, commits: [{ short: git(proj, 'rev-parse', '--short', 'spike/x'), subject: 'add spike.txt' }] })
    await expect(repo.deleteBranches(proj, [{ name: 'spike/x', sha: at['spike/x'] }, { name: 'hive/hb1', sha: at['hive/hb1'] }], true)).rejects.toThrow()
    await expect(repo.deleteBranches(proj, [{ name: 'spike/x', sha: at.main }], true)).rejects.toThrow(/moved since you were shown it/)
    await expect(repo.deleteBranches(proj, [{ name: 'hive/card', sha: at['hive/card'] }], true)).rejects.toThrow(/An open card works on hive\/card/)
    expect(await repo.deleteBranches(proj, [{ name: 'spike/x', sha: at['spike/x'] }], true)).toMatch(/Deleted spike\/x/)
    expect(branchNames(proj)).not.toContain('spike/x')
  }, 120_000)

  it('deletes merged branches on the remote only at the commit shown, never one in use or unmerged', async () => {
    const at = setUp()
    const r = (name: string): { name: string; sha: string } => ({ name: `origin/${name}`, sha: at[name] })
    const said = await repo.deleteRemoteBranches(proj, 'origin', [r('hive/hb1'), r('hive/slot'), r('hive/card'), r('spike/x'), r('main'), r('1.0.0'), { name: 'origin/hive/hb2', sha: at.main }])
    expect(branchNames(remote)).toEqual(['1.0.0', 'hive/card', 'hive/hb2', 'hive/slot', 'main', 'spike/x'])
    expect(said).toMatch(/Deleted hive\/hb1 on origin\./)
    for (const why of ['origin/hive/slot is checked out in a worktree or slot', 'An open card works on origin/hive/card', "origin/spike/x has commits that aren't in 1.0.0", 'origin/main is the default branch', 'origin/1.0.0 is the branch work merges into', 'origin/hive/hb2 has moved since you were shown it']) expect(said).toContain(why)
    // The local branch stays: only the remote's went, and its remote-tracking branch with it.
    expect(branchNames(proj)).toContain('hive/hb1')
    expect(git(proj, 'for-each-ref', 'refs/remotes/origin/hive/hb1')).toBe('')
    // Moved on the remote since the last fetch: refused there, never forced.
    commit(other, 'x.txt')
    git(other, 'push', '-q', '-f', 'origin', 'HEAD:refs/heads/hive/hb2')
    await expect(repo.deleteRemoteBranches(proj, 'origin', [r('hive/hb2')])).rejects.toThrow(/origin refused to delete hive\/hb2/)
    expect(branchNames(remote)).toContain('hive/hb2')
  }, 120_000)
})

describe('Update from <target> (HI-1180)', () => {
  /** A branch `card` with its own commit, checked out in a worktree (as a slot is), and a commit on main it hasn't. */
  const cardBranch = (opts: { worktree?: boolean; same?: boolean } = {}): string => {
    git(proj, 'branch', 'card')
    const wt = join(proj, '..', 'wt-card')
    if (opts.worktree !== false) git(proj, 'worktree', 'add', '-q', wt, 'card')
    const at = opts.worktree !== false ? wt : proj
    if (opts.worktree === false) git(proj, 'checkout', '-q', 'card')
    // Both sides change x.txt alike (a conflict) when asked; else each its own file.
    writeFileSync(join(at, opts.same ? 'x.txt' : 'c.txt'), 'the card\n')
    git(at, 'add', '-A')
    git(at, 'commit', '-qm', 'the card')
    if (opts.worktree === false) git(proj, 'checkout', '-q', 'main')
    writeFileSync(join(proj, opts.same ? 'x.txt' : 'm.txt'), 'main\n')
    git(proj, 'add', '-A')
    git(proj, 'commit', '-qm', 'on main')
    return wt
  }
  const head = (ref: string): string => git(proj, 'rev-parse', ref)
  const contains = (branch: string, sha: string): boolean => {
    try {
      git(proj, 'merge-base', '--is-ancestor', sha, branch)
      return true
    } catch {
      return false
    }
  }

  beforeEach(() => {
    workTarget = 'main'
  })

  it('says what it would do, and the branch rows count the target commits a branch lacks', async () => {
    cardBranch()
    const plan = await repo.branchUpdatePlan(proj, 'card')
    expect(plan).toMatchObject({ branch: 'card', target: 'main', behind: 1, ahead: 1, where: 'worktree', card: null, agents: [], approval: null, pushed: false, blocked: null })
    const row = (await repo.repoInfo(proj, 'main')).branches.find((b) => b.name === 'card')
    expect([row?.toTarget, row?.fromTarget]).toEqual([1, 1])
    await expect(repo.branchUpdatePlan(proj, 'main')).rejects.toThrow('main is the target itself.')
    await expect(repo.branchUpdatePlan(proj, 'nope')).rejects.toThrow("There's no branch nope.")
  })

  it('merges the target in where the branch is checked out: one merge commit, then nothing more to do', async () => {
    const wt = cardBranch()
    const main = head('main')
    expect(await repo.updateBranch(proj, 'card', 'merge')).toMatch(/^Merged main into card \([0-9a-f]{7}\)\.$/)
    expect(contains('card', main)).toBe(true)
    expect(git(wt, 'log', '-1', '--format=%s%n%P').split('\n')).toEqual(['Merge main into card', expect.stringMatching(/^[0-9a-f]+ [0-9a-f]+$/)])
    // Clean as Hive's git sees it (its line endings, not this test's git's).
    expect((await repo.branchUpdatePlan(proj, 'card')).blocked).toBeNull()
    expect(asUser).toHaveBeenCalledWith(proj, 'card', expect.any(Function))
    expect(await repo.updateBranch(proj, 'card', 'merge')).toBe('card already has everything in main.')
  })

  it("rebases the branch's commits onto the target: no merge commit", async () => {
    const wt = cardBranch()
    expect(await repo.updateBranch(proj, 'card', 'rebase')).toMatch(/^Rebased card's 1 commit onto main \([0-9a-f]{7}\)\.$/)
    expect(git(wt, 'rev-parse', 'HEAD~1')).toBe(head('main'))
    expect(git(wt, 'log', '-1', '--format=%s')).toBe('the card')
  })

  for (const how of ['merge', 'rebase'] as const) {
    it(`a conflict (${how}) is undone at once, naming its files: the branch and its folder as they were`, async () => {
      const wt = cardBranch({ same: true })
      const was = head('card')
      await expect(repo.updateBranch(proj, 'card', how)).rejects.toThrow(`${how === 'rebase' ? 'Rebasing' : 'Merging'} card with main stopped at a conflict in x.txt, so it was undone: card is as it was.`)
      expect(head('card')).toBe(was)
      expect((await repo.repoSummary(wt)).state).toBeNull()
      expect((await repo.branchUpdatePlan(proj, 'card')).blocked).toBeNull()
    })
  }

  it('is refused while an agent works there, with uncommitted changes there, or git mid-operation there, saying why', async () => {
    const wt = cardBranch()
    agents = [{ id: 'a1', name: 'B1', worktree: { path: wt, branch: 'card', base: 'main' } }]
    live = { a1: 'working' }
    await expect(repo.updateBranch(proj, 'card', 'merge')).rejects.toThrow(`B1 is working in ${wt}: update card once it has finished.`)
    // Idle there: named in the plan, not refused.
    live = { a1: 'finished' }
    expect((await repo.branchUpdatePlan(proj, 'card')).agents).toEqual([{ name: 'B1', status: 'finished' }])
    writeFileSync(join(wt, 'c.txt'), 'changed\n')
    expect((await repo.branchUpdatePlan(proj, 'card')).blocked).toBe(`${wt} has uncommitted changes: commit them, or set them aside, before updating card.`)
    await expect(repo.updateBranch(proj, 'card', 'merge')).rejects.toThrow('has uncommitted changes')
    git(wt, 'checkout', '-q', '--', 'c.txt')
    // An untracked file is git's to judge (a merge that would overwrite it stops).
    writeFileSync(join(wt, 'notes.txt'), 'mine\n')
    expect((await repo.branchUpdatePlan(proj, 'card')).blocked).toBeNull()
  })

  it('updates the branch checked out in the project folder there', async () => {
    cardBranch({ worktree: false })
    git(proj, 'checkout', '-q', 'card')
    expect((await repo.branchUpdatePlan(proj, 'card')).where).toBe('project')
    expect(await repo.updateBranch(proj, 'card', 'merge')).toMatch(/^Merged main into card/)
    expect(contains('HEAD', head('main'))).toBe(true)
  })

  for (const how of ['merge', 'rebase'] as const) {
    it(`a branch checked out nowhere is updated (${how}) in a temporary worktree, removed after`, async () => {
      cardBranch({ worktree: false })
      expect((await repo.branchUpdatePlan(proj, 'card')).where).toBe('temporary')
      await repo.updateBranch(proj, 'card', how)
      expect(contains('card', head('main'))).toBe(true)
      expect(git(proj, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1)
      expect(git(proj, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    })
  }

  it('a conflict in a temporary worktree is undone too, and the worktree removed', async () => {
    cardBranch({ worktree: false, same: true })
    const was = head('card')
    await expect(repo.updateBranch(proj, 'card', 'merge')).rejects.toThrow('stopped at a conflict in x.txt')
    expect(head('card')).toBe(was)
    expect(git(proj, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1)
  })
  /**
   * A pre-merge-commit hook that leaves git's index lock behind and fails (HR4's round 1): the merge stops part way, and
   * git can't abort it while the lock is there. Returns how to take the hook away again.
   */
  const lockingHook = (): (() => void) => {
    const hook = join(proj, '.git', 'hooks', 'pre-merge-commit')
    writeFileSync(hook, '#!/bin/sh\ntouch "$(git rev-parse --git-dir)/index.lock"\nexit 1\n')
    return () => rmSync(hook, { force: true })
  }
  /** Takes away the lock the hook left in `folder`, and aborts what git left there. */
  const unlock = (folder: string): void => {
    const dir = git(folder, 'rev-parse', '--absolute-git-dir')
    rmSync(join(dir, 'index.lock'), { force: true })
    // As Hive's git left the files (its line endings, not this test's git's).
    if (existsSync(join(dir, 'MERGE_HEAD'))) execFileSync('git', ['merge', '--abort'], { cwd: folder })
  }
  const worktrees = (): string[] => git(proj, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length))

  it("an abort that fails is said, with how the folder is left: never that it was undone (HR4's round 1, finding 1)", async () => {
    const wt = cardBranch()
    const was = head('card')
    const unhook = lockingHook()
    try {
      await expect(repo.updateBranch(proj, 'card', 'merge')).rejects.toThrow(`Updating card from main stopped, and Hive couldn't undo it: ${wt} is still in the middle of a merge. Finish or abort it there yourself (git status says how), then check card.`)
      expect(existsSync(join(git(wt, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD'))).toBe(true)
      expect(head('card')).toBe(was)
    } finally {
      unhook()
      unlock(wt)
    }
  })

  it('…in a temporary worktree, which is then kept as git left it, the branch not moved', async () => {
    cardBranch({ worktree: false })
    const was = head('card')
    const unhook = lockingHook()
    try {
      await expect(repo.updateBranch(proj, 'card', 'merge')).rejects.toThrow(/Updating card from main stopped, and Hive couldn't undo it in its temporary folder .+update-[0-9a-f]{8}, kept as git left it: card itself is as it was\./)
      expect(head('card')).toBe(was)
      expect(worktrees().length).toBe(2)
    } finally {
      unhook()
      const kept = worktrees().find((w) => /update-[0-9a-f]{8}$/.test(w))
      if (kept) {
        unlock(kept)
        git(proj, 'worktree', 'remove', '--force', kept)
      }
    }
  })

  it("a temporary worktree that can't be removed is said after the update, not left unsaid", async () => {
    cardBranch({ worktree: false })
    gitFails = (a) => a[0] === 'worktree' && a[1] === 'remove'
    const done = await repo.updateBranch(proj, 'card', 'merge')
    gitFails = null
    expect(done).toMatch(/^Merged main into card \([0-9a-f]{7}\)\.\nHive couldn't remove its temporary folder .+update-[0-9a-f]{8}: remove it in Unused worktrees\.$/)
    expect(contains('card', head('main'))).toBe(true)
    for (const w of worktrees().filter((x) => /update-[0-9a-f]{8}$/.test(x))) git(proj, 'worktree', 'remove', '--force', w)
  })

  for (const how of ['merge', 'rebase'] as const) {
    it(`brings in the target branch's commit, never a tag of the same name (${how}; HR4's round 1, finding 2)`, async () => {
      cardBranch()
      // A tag main where the card began, beside the branch main one commit on.
      git(proj, 'tag', 'main', 'refs/heads/main~1')
      expect(await repo.updateBranch(proj, 'card', how)).toMatch(how === 'rebase' ? /^Rebased card's 1 commit onto main/ : /^Merged main into card/)
      expect(contains('card', head('refs/heads/main'))).toBe(true)
      expect((await repo.branchUpdatePlan(proj, 'card')).behind).toBe(0)
    })
  }

  it("a branch with nothing of its own, behind the target, is counted, and fast-forwarded whichever way (HR4's round 1, finding 3)", async () => {
    git(proj, 'branch', 'card')
    commit(proj, 'later.txt')
    expect(await repo.branchUpdatePlan(proj, 'card')).toMatchObject({ behind: 1, ahead: 0 })
    const row = (await repo.repoInfo(proj, 'main')).branches.find((b) => b.name === 'card')
    expect([row?.toTarget, row?.fromTarget]).toEqual([0, 1])
    expect(await repo.updateBranch(proj, 'card', 'rebase')).toMatch(/^Fast-forwarded card to main \([0-9a-f]{7}\)\.$/)
    expect(head('card')).toBe(head('main'))
  })
})
