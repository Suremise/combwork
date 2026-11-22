// HI-3473: Branches & remotes' Repository health (platform/git/gitHealth.ts): what it finds (worktree entries whose
// folder is gone, with whose each was; git's lock files, each judged stale or not by its age and the git processes that
// started before it), what each repair does (only the entries and locks the user saw, each proved again), Fetch with
// prune (what a remote has deleted, the local branches tracking it, what was dropped), and what refuses every repair
// before git runs (an agent, a run, a session, a Combwork run, a slot being made). Real git in throwaway repositories;
// Windows' process list stands in by a seam, but for one test of the real listing.
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { germanGit, withProcessEnv } from './gitCatalog'
import { tempDir } from './tempDir'
import { timing } from './waits'
import { commit, gitRepo, sh } from './workflow/harness'
import { lockAsks, pruneAsks, remoteAsks } from '../src/shared/gitHealth'
import type { NamedProcess } from '../src/main/processTree'

// HI-3534: the run's allowlisted environment and test git config for a git child the test starts itself.
const { gitEnv: runEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const norm = (p: string): string => resolve(p).toLowerCase()
/** What the queue counts as building in a folder: none unless a test says. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: (_ws: unknown, folder: string) => (held && held.some((h) => norm(h) === norm(folder)) ? held : null) }))
/** An agent working in a folder: none unless a test says. */
let agent: string | null = null
vi.mock('../src/main/gitRepo', async (original) => ({ ...(await original<typeof import('../src/main/gitRepo')>()), busyAgentIn: async () => agent }))
/** The live sessions: none unless a test says. */
let live: { cwd: string; status: string; agentName: string; agentId: string }[] = []
vi.mock('../src/main/sessions', () => ({ sessions: { liveStates: () => live } }))
/** The workspace's runs: none unless a test says. */
let runs: { source: string; state: string; folder: string; title: string }[] = []
vi.mock('../src/main/progressService', () => ({ progress: { list: () => runs } }))
/** The project's slots as the board records them. */
let slots: { name: string; folder: string; state: string }[] = []
vi.mock('../src/main/agentFolders', async (original) => ({ ...(await original<typeof import('../src/main/agentFolders')>()), boardSlots: async () => slots }))
vi.mock('../src/main/branchWatch', async (original) => ({ ...(await original<typeof import('../src/main/branchWatch')>()), checkProject: async () => undefined }))
/** Windows' process list as a test sets it (null: couldn't be read whole); the real one only where a test asks. */
let procs: NamedProcess[] | null = []
let realProcs = false
vi.mock('../src/main/processTree', async (original) => {
  const real = await original<typeof import('../src/main/processTree')>()
  return { ...real, listNamedProcesses: (ms?: number) => (realProcs ? real.listNamedProcesses(ms) : Promise.resolve(procs)) }
})

/** HR1's round 1: a step before each git command a test watches (null: none), and `git worktree list` made to fail. */
let gitHook: ((args: string[]) => Promise<void> | void) | null = null
let failList = false
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number, input?: string, opts?: Parameters<typeof real.git>[4]) => {
      // A real failure of git's own: the listing asked with an option git doesn't know.
      if (failList && args[0] === 'worktree' && args[1] === 'list') return real.git(cwd, ['worktree', 'list', '--no-such-option'], max, input, opts)
      await gitHook?.(args)
      return real.git(cwd, args, max, input, opts)
    }
  }
})

vi.setConfig({ testTimeout: timing('test.hang') })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const H = await import('../src/main/platform/git/gitHealth')
const { platformLimits } = await import('../src/main/platform/limits')
const { heldStoreKeys, storeKeyOf, withRepoLock } = await import('../src/main/repoLock')
const { namedProcessList } = await vi.importActual<typeof import('../src/main/processTree')>('../src/main/processTree')

const base = tempDir('cw-githealth-')
const w = createWorkspaceService()
w.path = join(base, 'ws')
const staleMs = platformLimits.staleLockMs
afterAll(async () => {
  platformLimits.staleLockMs = staleMs
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

let n = 0
let proj = ''
const gitDir = (): string => sh(proj, 'rev-parse', '--path-format=absolute', '--git-common-dir')
const health = () => inWorkspace(w, () => H.repoHealth(proj))
const inWs = <T>(fn: () => Promise<T>): Promise<T> => inWorkspace(w, fn)

beforeEach(() => {
  proj = join(w.path!, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  commit(proj, { 'a.txt': 'a\n' }, 'first')
  held = null
  agent = null
  live = []
  runs = []
  slots = []
  procs = []
  realProcs = false
  gitHook = null
  failList = false
  // Every lock is old enough unless a test says (the age rule has its own tests).
  platformLimits.staleLockMs = () => 0
})

/** A worktree of the project at `name` beside it, on a new branch; its folder removed when `gone`. */
function worktree(name: string, gone = true): string {
  const at = join(w.path!, `${name}-${n}`)
  sh(proj, 'worktree', 'add', '-q', '-b', `${name}-${n}`, at)
  if (gone) rmSync(at, { recursive: true, force: true })
  return at
}

describe('what git prints', () => {
  it('reads the prune dry run, the remote prune dry run and the process list', () => {
    expect(H.parsePruneDryRun('Removing worktrees/wt1: gitdir file points to non-existent location\nRemoving worktrees/b: gitdir file does not exist\n')).toEqual([
      { id: 'wt1', reason: 'gitdir file points to non-existent location' },
      { id: 'b', reason: 'gitdir file does not exist' }
    ])
    expect([...H.parseLsRemoteHeads(`${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/cw/x\n${'c'.repeat(40)}\tHEAD\n`)]).toEqual(['main', 'cw/x'])
    expect(namedProcessList('4 0 System\n812 1700000000000 git.exe\nend\n', true)).toEqual([
      { pid: 4, started: 0, name: 'System' },
      { pid: 812, started: 1700000000000, name: 'git.exe' }
    ])
    // A listing cut short, failed, or with a row it can't read is no answer.
    expect(namedProcessList('812 1700000000000 git.exe\n', true)).toBeNull()
    expect(namedProcessList('812 1700000000000 git.exe\nend', false)).toBeNull()
    expect(namedProcessList('garbage\nend', true)).toBeNull()
  })

  it('the real process list is read whole, this process in it', async () => {
    const { listNamedProcesses } = await vi.importActual<typeof import('../src/main/processTree')>('../src/main/processTree')
    const list = await listNamedProcesses()
    expect(list?.some((p) => p.pid === process.pid && /node|electron/i.test(p.name))).toBe(true)
  })

  it("names git's lock files, never Combwork's or one outside the git folder", () => {
    for (const p of ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'config.lock', 'shallow.lock', 'ORIG_HEAD.lock', 'worktrees/slot-a/index.lock', 'refs/heads/main.lock', 'refs/remotes/origin/x.lock']) expect(H.isGitLockPath(p), p).toBe(true)
    for (const p of ['cw-merge.lock', '.combwork-move.lock', 'worktrees/index.lock', 'worktrees/a/b/index.lock', 'refs/heads/.lock', 'objects/pack/x.lock', 'index']) expect(H.isGitLockPath(p), p).toBe(false)
    expect(lockAsks([{ path: '../x/index.lock', stamp: 's' }])).toBeNull()
    expect(lockAsks([{ path: 'C:/x/index.lock', stamp: 's' }])).toBeNull()
    expect(lockAsks([{ path: 'refs\\heads\\x.lock', stamp: 's' }])).toBeNull()
    expect(lockAsks([{ path: 'index.lock', stamp: '' }])).toBeNull()
    expect(lockAsks([{ path: 'index.lock', stamp: 's' }])).toEqual([{ path: 'index.lock', stamp: 's' }])
    expect(pruneAsks([{ id: '../x', folder: null }])).toBeNull()
    expect(pruneAsks([])).toBeNull()
    expect(remoteAsks(['--upload-pack=x'])).toBeNull()
    expect(remoteAsks(['origin', 'origin'])).toEqual(['origin'])
  })

  it('a lock is stale only once old enough and while no git that started before it runs', () => {
    const at = 1_000_000
    const git = /^git(?:-remote-[a-z0-9.+-]+)?\.exe$/i
    expect(H.lockHeld(at, at + 30_000, [], git, 60_000)).toEqual({ why: 'young', seconds: 60 })
    expect(H.lockHeld(at, at + 60_000, [], git, 60_000)).toBeNull()
    expect(H.lockHeld(at, at + 60_000, null, git, 60_000)).toEqual({ why: 'unlisted' })
    // Started before it (or within the clock's skew after): may hold it. Another program, or a git started later: not.
    expect(H.lockHeld(at, at + 60_000, [{ pid: 7, started: at - 5, name: 'git.exe' }], git, 60_000)).toMatchObject({ why: 'process', pid: 7 })
    expect(H.lockHeld(at, at + 60_000, [{ pid: 8, started: at + H.START_SKEW_MS, name: 'git-remote-https.exe' }], git, 60_000)).toMatchObject({ why: 'process', pid: 8 })
    expect(H.lockHeld(at, at + 60_000, [{ pid: 9, started: at + H.START_SKEW_MS + 1, name: 'git.exe' }], git, 60_000)).toBeNull()
    expect(H.lockHeld(at, at + 60_000, [{ pid: 10, started: at - 5, name: 'sh.exe' }], git, 60_000)).toBeNull()
  })
})

describe('Prune worktrees', () => {
  it("lists an entry whose folder is gone, with the slot it was; drops only the one asked for, while git still lists it", async () => {
    const a = worktree('wt-a')
    const b = worktree('wt-b')
    slots = [{ name: 'slot-a', folder: a, state: 'gone' }]
    const h = await health()
    expect(h.worktrees.map((x) => ({ folder: norm(x.folder!), owner: x.owner }))).toEqual(expect.arrayContaining([
      { folder: norm(a), owner: { kind: 'slot', name: 'slot-a' } },
      { folder: norm(b), owner: null }
    ]))
    const ea = h.worktrees.find((x) => norm(x.folder!) === norm(a))!
    expect(await inWs(() => H.pruneWorktrees(proj, [{ id: ea.id, folder: ea.folder }]))).toBe('Dropped 1 worktree entry.')
    const left = (await health()).worktrees
    expect(left.map((x) => norm(x.folder!))).toEqual([norm(b)])
    expect(sh(proj, 'worktree', 'list')).not.toContain(`wt-a-${n}`)
  })

  it('HI-3534: lists and drops the entry though the user\'s git speaks German', async () => {
    const a = worktree('wt-de')
    const german = germanGit(join(base, `locale-${n}`))
    await withProcessEnv(german, async () => {
      // The user's git, started with the run's allowlisted environment and those settings, says it in German.
      expect(spawnSync('git', ['worktree', 'prune', '--dry-run', '--verbose'], { cwd: proj, env: runEnv(german), encoding: 'utf8' }).stderr).toContain(`Entferne worktrees/wt-de-${n}`)
      const h = await health()
      expect(h.worktrees.map((x) => ({ id: x.id, folder: norm(x.folder!), reason: x.reason }))).toEqual([{ id: `wt-de-${n}`, folder: norm(a), reason: 'gitdir file points to non-existent location' }])
      expect(await inWs(() => H.pruneWorktrees(proj, [{ id: h.worktrees[0].id, folder: h.worktrees[0].folder }]))).toBe('Dropped 1 worktree entry.')
    })
    expect((await health()).worktrees).toEqual([])
  })

  it('keeps an entry whose folder came back, and one gone since or never listed', async () => {
    const a = worktree('wt-a')
    const [e] = (await health()).worktrees
    mkdirSync(a)
    const r = await inWs(() => H.pruneWorktrees(proj, [e, { id: 'nothing', folder: null }]))
    expect(r).toContain('No worktree entry was dropped.')
    expect(r).toContain('its folder is there')
    expect(r).toContain('it changed since you looked')
    expect(existsSync(join(gitDir(), 'worktrees', e.id))).toBe(true)
  })

  it('an entry whose record names no folder is dropped by its own proof', async () => {
    worktree('wt-a')
    const [e0] = (await health()).worktrees
    rmSync(join(gitDir(), 'worktrees', e0.id, 'gitdir'))
    const [e] = (await health()).worktrees
    expect(e).toMatchObject({ id: e0.id, folder: null })
    expect(await inWs(() => H.pruneWorktrees(proj, [e]))).toBe('Dropped 1 worktree entry.')
    expect(existsSync(join(gitDir(), 'worktrees', e0.id))).toBe(false)
    expect((await health()).worktrees).toEqual([])
  })
})

describe('Remove stale lock', () => {
  it("lists git's lock files (the top, a worktree's own, a ref's) and never Combwork's; removes the stale ones asked for", async () => {
    const wt = worktree('wt-a', false)
    const id = sh(wt, 'rev-parse', '--git-dir').replace(/\\/g, '/').split('/').pop()!
    writeFileSync(join(gitDir(), 'index.lock'), '')
    writeFileSync(join(gitDir(), 'worktrees', id, 'index.lock'), '')
    writeFileSync(join(gitDir(), 'refs', 'heads', 'main.lock'), 'x')
    writeFileSync(join(gitDir(), 'cw-merge.lock'), '')
    const h = await health()
    expect(h.locks.map((l) => l.path)).toEqual(['index.lock', 'refs/heads/main.lock', `worktrees/${id}/index.lock`])
    expect(h.locks.every((l) => l.held === null)).toBe(true)
    const r = await inWs(() => H.removeLocks(proj, h.locks.filter((l) => l.path !== 'refs/heads/main.lock')))
    expect(r).toBe('Removed 2 lock files.')
    expect(existsSync(join(gitDir(), 'index.lock'))).toBe(false)
    expect(existsSync(join(gitDir(), 'refs', 'heads', 'main.lock'))).toBe(true)
    expect(existsSync(join(gitDir(), 'cw-merge.lock'))).toBe(true)
    // git works again where the lock was.
    sh(proj, 'add', '-A')
  })

  it('keeps a lock too new, one an older git may hold, one rewritten since it was listed; and refuses with no process list', async () => {
    const lock = join(gitDir(), 'index.lock')
    writeFileSync(lock, '')
    platformLimits.staleLockMs = () => 3_600_000
    let [l] = (await health()).locks
    expect(l.held).toEqual({ why: 'young', seconds: 3600 })
    expect(await inWs(() => H.removeLocks(proj, [l]))).toContain("it isn't stale now")
    platformLimits.staleLockMs = () => 0
    procs = [{ pid: 4242, started: Date.now() - 3_600_000, name: 'GIT.EXE' }]
    ;[l] = (await health()).locks
    expect(l.held).toMatchObject({ why: 'process', pid: 4242 })
    expect(await inWs(() => H.removeLocks(proj, [l]))).toContain("it isn't stale now")
    procs = []
    ;[l] = (await health()).locks
    expect(l.held).toBeNull()
    writeFileSync(lock, 'written again')
    expect(await inWs(() => H.removeLocks(proj, [l]))).toContain('it changed since you looked')
    procs = null
    ;[l] = (await health()).locks
    expect(l.held).toEqual({ why: 'unlisted' })
    await expect(inWs(() => H.removeLocks(proj, [l]))).rejects.toThrow("Windows' list of processes couldn't be read")
    expect(existsSync(lock)).toBe(true)
  })

  it('refuses a path that is no lock of git’s', async () => {
    await expect(inWs(() => H.removeLocks(proj, [{ path: 'cw-merge.lock', stamp: 'x' }]))).rejects.toThrow('asked for wrongly')
    await expect(inWs(() => H.removeLocks(proj, [{ path: 'objects/x.lock', stamp: 'x' }]))).rejects.toThrow('asked for wrongly')
  })
})

describe('refusals', () => {
  it('refuses while a run, an agent, a session, a Combwork run or a slot being made works on the repository', async () => {
    const a = worktree('wt-a')
    const wt = worktree('wt-b', false)
    const [e] = (await health()).worktrees.filter((x) => norm(x.folder!) === norm(a))
    const tryIt = () => inWs(() => H.pruneWorktrees(proj, [e]))
    held = [wt]
    await expect(tryIt()).rejects.toThrow(/A run or an agent is working in .*wt-b/)
    held = null
    agent = 'HB1'
    await expect(tryIt()).rejects.toThrow(/HB1 is working in/)
    agent = null
    live = [{ cwd: join(wt, 'src'), status: 'working', agentName: 'HB2', agentId: 'a-2' }]
    await expect(tryIt()).rejects.toThrow(/HB2 is working in .*wt-b/)
    // An idle session isn't working.
    live = [{ cwd: wt, status: 'idle', agentName: 'HB2', agentId: 'a-2' }]
    runs = [{ source: 'combwork', state: 'running', folder: proj, title: 'merge check' }]
    await expect(tryIt()).rejects.toThrow('Combwork is running “merge check”')
    runs = [{ source: 'combwork', state: 'passed', folder: proj, title: 'merge check' }]
    slots = [{ name: 'slot-c', folder: join(w.path!, 'elsewhere'), state: 'creating' }]
    await expect(tryIt()).rejects.toThrow('slot-c is being made')
    slots = []
    expect(existsSync(join(gitDir(), 'worktrees', e.id))).toBe(true)
    expect(await tryIt()).toBe('Dropped 1 worktree entry.')
  })
})

describe('Fetch with prune', () => {
  it('lists what a remote deleted with the local branches tracking it, then drops it; refuses a remote it has not', async () => {
    const remote = join(w.path!, `remote${n}.git`)
    sh(w.path!, 'clone', '-q', '--bare', proj, remote)
    sh(proj, 'remote', 'add', 'origin', remote)
    sh(remote, 'branch', 'old', 'main')
    sh(remote, 'branch', 'kept', 'main')
    sh(proj, 'fetch', '-q', 'origin')
    sh(proj, 'branch', '--track', 'old', 'origin/old')
    sh(remote, 'branch', '-D', 'old')
    const found = await inWs(() => H.remotePrunePreview(proj))
    expect(found).toEqual([{ remote: 'origin', branches: [{ name: 'origin/old', trackedBy: ['old'] }] }])
    await expect(inWs(() => H.fetchPrune(proj, ['upstream']))).rejects.toThrow('asked for wrongly')
    expect(await inWs(() => H.fetchPrune(proj, ['origin']))).toBe('Fetched origin. Dropped 1 remote-tracking branch: origin/old.')
    expect(sh(proj, 'branch', '-r')).not.toContain('origin/old')
    expect(sh(proj, 'branch', '-r')).toContain('origin/kept')
    // The local branch stays, its upstream gone.
    expect(sh(proj, 'branch', '--list', 'old')).toContain('old')
    expect(await inWs(() => H.remotePrunePreview(proj))).toEqual([{ remote: 'origin', branches: [] }])
  })

  it('says a remote it could not ask, and refuses while an agent works on the repository', async () => {
    sh(proj, 'remote', 'add', 'origin', join(w.path!, 'no-such-remote.git'))
    const [r] = await inWs(() => H.remotePrunePreview(proj))
    expect(r.remote).toBe('origin')
    expect(r.branches).toEqual([])
    expect(r.error).toBeTruthy()
    agent = 'HB1'
    await expect(inWs(() => H.fetchPrune(proj, ['origin']))).rejects.toThrow(/HB1 is working in/)
  })

  it('HI-3530: names the local branch tracking a deleted branch though tags make both short names ambiguous', async () => {
    const remote = join(w.path!, `remote${n}.git`)
    sh(w.path!, 'clone', '-q', '--bare', proj, remote)
    sh(proj, 'remote', 'add', 'origin', remote)
    sh(remote, 'branch', 'old', 'main')
    sh(proj, 'fetch', '-q', 'origin')
    sh(proj, 'branch', '--track', 'work', 'origin/old')
    // A local branch whose upstream is a local branch of the same short name tracks nothing on the remote.
    sh(proj, 'branch', 'origin/old', 'main')
    sh(proj, 'branch', '--track', 'local', 'refs/heads/origin/old')
    // Tags that git's short names have to step around: the upstream's becomes remotes/origin/old, the branch's heads/work.
    sh(proj, 'tag', 'origin/old', 'HEAD')
    sh(proj, 'tag', 'work', 'HEAD')
    expect(sh(proj, 'for-each-ref', '--format=%(refname:short) %(upstream:short)', 'refs/heads/work').trim()).toBe('heads/work remotes/origin/old')
    sh(remote, 'branch', '-D', 'old')
    expect(await inWs(() => H.remotePrunePreview(proj))).toEqual([{ remote: 'origin', branches: [{ name: 'origin/old', trackedBy: ['work'] }] }])
    expect(await inWs(() => H.fetchPrune(proj, ['origin']))).toBe('Fetched origin. Dropped 1 remote-tracking branch: origin/old.')
    expect(sh(proj, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/')).not.toContain('refs/remotes/origin/old')
    // The local branch and the tags that shared its short name stay.
    expect(sh(proj, 'for-each-ref', '--format=%(refname)', 'refs/heads/origin/old', 'refs/tags/origin/old').trim().split(/\r?\n/)).toEqual(['refs/heads/origin/old', 'refs/tags/origin/old'])
  })
})

describe("HR1's round 1", () => {
  /** A project with a remote `origin` (a bare repository beside it) fetched once, `old` and `kept` on it, a local `old` tracking origin/old. */
  function withRemote(): string {
    const remote = join(w.path!, `remote${n}.git`)
    sh(w.path!, 'clone', '-q', '--bare', proj, remote)
    sh(proj, 'remote', 'add', 'origin', remote)
    sh(remote, 'branch', 'old', 'main')
    sh(remote, 'branch', 'kept', 'main')
    sh(proj, 'fetch', '-q', 'origin')
    sh(proj, 'branch', '--track', 'old', 'origin/old')
    sh(remote, 'branch', '-D', 'old')
    return remote
  }

  it('a local-only tag survives Fetch with prune though the config prunes tags; only the branch listed goes', async () => {
    withRemote()
    sh(proj, 'tag', 'local-only')
    sh(proj, 'config', 'fetch.pruneTags', 'true')
    sh(proj, 'config', 'remote.origin.pruneTags', 'true')
    sh(proj, 'config', 'fetch.prune', 'true')
    expect(await inWs(() => H.remotePrunePreview(proj))).toEqual([{ remote: 'origin', branches: [{ name: 'origin/old', trackedBy: ['old'] }] }])
    expect(await inWs(() => H.fetchPrune(proj, ['origin']))).toBe('Fetched origin. Dropped 1 remote-tracking branch: origin/old.')
    expect(sh(proj, 'tag', '--list')).toBe('local-only')
    expect(sh(proj, 'branch', '-r')).toContain('origin/kept')
  })

  it('a remote fetched with more than its branches (a tag refspec) is listed with why, and refused: its tags survive', async () => {
    withRemote()
    sh(proj, 'tag', 'local-only')
    sh(proj, 'config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*')
    const [r] = await inWs(() => H.remotePrunePreview(proj))
    expect(r).toMatchObject({ remote: 'origin', branches: [] })
    expect(r.error).toContain("isn't fetched as git sets a remote up")
    await expect(inWs(() => H.fetchPrune(proj, ['origin']))).rejects.toThrow("isn't fetched as git sets a remote up")
    expect(sh(proj, 'tag', '--list')).toBe('local-only')
    expect(sh(proj, 'branch', '-r')).toContain('origin/old')
    // A mirror too.
    sh(proj, 'config', '--unset', 'remote.origin.fetch', 'tags')
    sh(proj, 'config', 'remote.origin.mirror', 'true')
    await expect(inWs(() => H.fetchPrune(proj, ['origin']))).rejects.toThrow("isn't fetched as git sets a remote up")
  })

  it("git's fetch runs holding the repository's lock; another taker of it waits for the fetch to end", async () => {
    withRemote()
    const store = storeKeyOf(sh(proj, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    const order: string[] = []
    let entered!: () => void
    const inFetch = new Promise<void>((res) => (entered = res))
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let heldDuringFetch: boolean | null = null
    gitHook = async (args) => {
      if (!args.includes('fetch')) return
      heldDuringFetch = heldStoreKeys().has(store)
      order.push('fetch')
      entered()
      await gate
      order.push('fetch done')
    }
    const fetching = inWs(() => H.fetchPrune(proj, ['origin']))
    await inFetch
    // Another taker (a merge, say), started while git's fetch runs.
    const other = withRepoLock(proj, async () => {
      order.push('other')
    })
    release()
    await Promise.all([fetching, other])
    expect(heldDuringFetch).toBe(true)
    expect(order).toEqual(['fetch', 'fetch done', 'other'])
  })

  it("refuses every repair when git can't list the repository's worktrees, a busy sibling unseen; nothing changes", async () => {
    const a = worktree('wt-a')
    const sibling = worktree('wt-b', false)
    const [e] = (await health()).worktrees.filter((x) => norm(x.folder!) === norm(a))
    writeFileSync(join(gitDir(), 'index.lock'), '')
    const [l] = (await health()).locks
    held = [sibling]
    failList = true
    await expect(inWs(() => H.pruneWorktrees(proj, [e]))).rejects.toThrow("Git couldn't list this repository's worktrees")
    await expect(inWs(() => H.removeLocks(proj, [l]))).rejects.toThrow("Git couldn't list this repository's worktrees")
    expect(existsSync(join(gitDir(), 'worktrees', e.id))).toBe(true)
    expect(existsSync(join(gitDir(), 'index.lock'))).toBe(true)
  })
})
