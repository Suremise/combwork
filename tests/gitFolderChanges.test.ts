// A folder's uncommitted changes, committed or set aside (HI-2944, port 5's folderChanges): only the paths shown, in the
// folder the target is checked out in (found by Combwork, never given), everything checked again under the lock and the
// fence; a stale or empty list refused with nothing done; another staged file kept staged; an untracked file, a rename
// and a deletion; a refusing hook losing nothing; a stash told by its object, kept and named when git fails after making
// it; the caller's guard, an operation under way, a busy folder; Files' Commit it committing .gitignore alone. Real git
// in throwaway repositories.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import type { GitResult } from '../src/main/git'

/** The next stash's git: run for real, then answered as failed (a failure after git made the stash). */
let failStashAfter = false
/** HI-2983: a file written just before the next `stash push` runs (after the changes shown were checked). */
let lateFile: string | null = null
/** HI-2982 (HR2's round 5): an lstat of a path ending so refused (EPERM), as Windows can, though git still reads it. */
let failLstatOf: string | null = null
vi.mock('original-fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>()
  return {
    ...real,
    lstat: (async (p: string, o?: unknown) => {
      if (failLstatOf && String(p).replace(/\\/g, '/').endsWith(`/${failLstatOf}`)) throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${p}'`), { code: 'EPERM' })
      return real.lstat(p, o as Parameters<typeof real.lstat>[1])
    }) as typeof real.lstat
  }
})
/** A folder whose `rev-parse --show-toplevel` fails (HI-2962): `empty`, answered ok with nothing. */
let failTopIn: { folder: string; empty?: boolean } | null = null
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number, input?: string, opts?: Parameters<typeof real.git>[4]): Promise<GitResult> => {
      if (failTopIn && args[0] === 'rev-parse' && args.includes('--show-toplevel') && resolve(cwd).toLowerCase() === resolve(failTopIn.folder).toLowerCase())
        return failTopIn.empty ? { ok: true, code: 0, out: '', err: '', buf: Buffer.alloc(0) } : { ok: false, code: 128, out: '', err: 'fatal: unable to read the repository', buf: Buffer.alloc(0) }
      if (lateFile && args[0] === 'stash' && args[1] === 'push') {
        // HI-2983 (HR1's round 1): a change made after the check, never shown, just before git stashes.
        writeFileSync(join(cwd, lateFile), 'not shown\n')
        lateFile = null
      }
      const r = await real.git(cwd, args, max, input, opts)
      if (failStashAfter && args[0] === 'stash') {
        failStashAfter = false
        return { ...r, ok: false, code: 1, err: 'error: could not write index' }
      }
      return r
    }
  }
})
const norm = (p: string): string => resolve(p).toLowerCase()
const within = (p: string, folder: string): boolean => norm(p) === norm(folder) || norm(p).startsWith(norm(folder) + '\\') || norm(p).startsWith(norm(folder) + '/')
/** What the queue counts as building in a folder: none, unless a test says; as the real one, only what is in the folder asked about. */
let held: string[] | null = null
vi.mock('../src/main/workflow/queueHost', () => ({ folderBuilders: (_ws: unknown, folder: string) => (held?.some((h) => within(h, folder)) ? held.filter((h) => within(h, folder)) : null) }))
/** An agent working in the folder: none, unless a test says; `agentAt` set, only in that folder. */
let agent: string | null = null
let agentAt: string | null = null
/** Each agent check's project and folder, and the fence on a folder then (HI-2962). */
let agentChecks: { project: string; folder: string; fenced: string | null }[] = []
let fencedProbe: string | null = null
vi.mock('../src/main/gitRepo', async (original) => {
  const { folderChanging } = await import('../src/main/folderFence')
  return {
    ...(await original<typeof import('../src/main/gitRepo')>()),
    busyAgentIn: async (project: string, folder: string) => {
      agentChecks.push({ project, folder, fenced: folderChanging(fencedProbe) })
      return agentAt === null || norm(agentAt) === norm(folder) ? agent : null
    }
  }
})

vi.setConfig({ testTimeout: 60_000 })

const { createWorkspaceService, disposeWorkspaceService, inWorkspace } = await import('../src/main/workspace')
const changes = await import('../src/main/gitFolderChanges')
const { worktreeNow } = await import('../src/main/platform/git')
const { GitPlatform } = await import('../src/main/platform/gitPlatform')
const { isUnknown } = await import('../src/main/platform/types')

const base = tempDir('cw-folderchanges-')
const ws = join(base, 'ws')
const w = createWorkspaceService()
w.path = ws
afterAll(async () => {
  await disposeWorkspaceService(w)
  rmSync(base, { recursive: true, force: true })
})

let n = 0
let proj = ''
const read = (rel: string): string => readFileSync(join(proj, rel), 'utf8')
const status = (dir = proj): string => sh(dir, 'status', '--porcelain=v1', '--untracked-files=all')
const head = (dir = proj): string => sh(dir, 'rev-parse', 'HEAD')
const committed = (dir = proj): string[] => sh(dir, 'show', '--no-renames', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()
/** The folder shown with the changes: the project folder unless a test says (where `target` is checked out, as the user saw it). */
const settle = (action: 'commit' | 'setAside', shown: unknown, guard?: () => void, target = 'main', seen = proj) => inWorkspace(w, () => changes.settleChanges(proj, target, seen, action, shown, 'before merging AB-1', guard))

beforeEach(() => {
  proj = join(ws, `proj${++n}`)
  mkdirSync(proj, { recursive: true })
  gitRepo(proj)
  sh(proj, 'config', 'user.name', 'Test')
  sh(proj, 'config', 'user.email', 'test@example.invalid')
  commit(proj, { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': 'node_modules/\n' }, 'files')
  held = null
  agent = null
  agentAt = null
  agentChecks = []
  fencedProbe = null
  failTopIn = null
  failStashAfter = false
  failLstatOf = null
  lateFile = null
})

describe('Commit', () => {
  it('commits only the paths shown, as they are in the folder; another staged file stays staged, unchanged', async () => {
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n/reference/\n')
    writeFileSync(join(proj, 'b.txt'), 'staged b\n')
    sh(proj, 'add', 'b.txt')
    writeFileSync(join(proj, 'a.txt'), 'a, the user kept editing\n')
    const done = await settle('commit', ['.gitignore'])
    expect(done).toMatchObject({ action: 'commit', branch: 'main', files: ['.gitignore'], made: head() })
    expect(committed()).toEqual(['.gitignore'])
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('Commit changes before merging AB-1')
    expect(sh(proj, 'diff', '--cached', '--name-only')).toBe('b.txt')
    expect(sh(proj, 'diff', '--name-only')).toBe('a.txt')
    expect(read('a.txt')).toBe('a, the user kept editing\n')
  })

  it("a file both staged and edited is committed as it is in the folder (the user's latest)", async () => {
    writeFileSync(join(proj, 'a.txt'), 'staged\n')
    sh(proj, 'add', 'a.txt')
    writeFileSync(join(proj, 'a.txt'), 'latest\n')
    await settle('commit', ['a.txt'])
    expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('latest')
    expect(status()).toBe('')
  })

  it('an untracked file, a staged rename (both sides) and a deletion are committed', async () => {
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    sh(proj, 'mv', 'b.txt', 'c.txt')
    rmSync(join(proj, '.gitignore'))
    const done = await settle('commit', ['new.txt', 'c.txt', '.gitignore'])
    expect(done.files.sort()).toEqual(['.gitignore', 'b.txt', 'c.txt', 'new.txt'])
    expect(committed()).toEqual(['.gitignore', 'b.txt', 'c.txt', 'new.txt'])
    expect(status()).toBe('')
  })

  it('a list that is empty, or names a path no longer changed, is refused with nothing done', async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const before = head()
    await expect(settle('commit', [])).rejects.toThrow(/aren't the ones shown/)
    await expect(settle('commit', ['a.txt', 'b.txt'])).rejects.toThrow(/aren't the ones shown/)
    await expect(settle('commit', ['../outside.txt'])).rejects.toThrow(/aren't the ones shown/)
    expect(head()).toBe(before)
    expect(status()).toBe('M a.txt')
  })

  it('a refusing pre-commit hook loses nothing: the files and the index as they were, the intent-to-add undone', async () => {
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "no commits today" >&2\nexit 1\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'b.txt'), 'staged\n')
    sh(proj, 'add', 'b.txt')
    const before = head()
    await expect(settle('commit', ['new.txt', 'a.txt'])).rejects.toThrow(/Git did not commit/)
    expect(head()).toBe(before)
    // (sh trims the first line's leading space.)
    expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['?? new.txt', 'M  b.txt', 'M a.txt'])
    expect(read('new.txt')).toBe('new\n')
  })

  it("the caller's guard refusing: nothing is done", async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const before = head()
    await expect(
      settle('commit', ['a.txt'], () => {
        throw new Error('the pause changed')
      })
    ).rejects.toThrow('the pause changed')
    expect(head()).toBe(before)
    expect(status()).toBe('M a.txt')
  })
})

describe('Set aside', () => {
  it('stashes only the paths shown, named; the new stash told by its object even beside an older one of the same name', async () => {
    writeFileSync(join(proj, 'a.txt'), 'older\n')
    sh(proj, 'stash', 'push', '-q', '-m', 'Combwork: set aside before merging AB-1')
    const older = sh(proj, 'rev-parse', 'refs/stash')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    writeFileSync(join(proj, 'b.txt'), 'staged\n')
    sh(proj, 'add', 'b.txt')
    const done = await settle('setAside', ['a.txt', 'new.txt'])
    expect(done.made).toBe(sh(proj, 'rev-parse', 'refs/stash'))
    expect(done.made).not.toBe(older)
    expect(sh(proj, 'stash', 'list', '--format=%s').split('\n')[0]).toMatch(/Combwork: set aside before merging AB-1$/)
    expect(read('a.txt')).toBe('a\n')
    expect(existsSync(join(proj, 'new.txt'))).toBe(false)
    expect(status()).toBe('M  b.txt')
    // Brought back as it was.
    sh(proj, 'stash', 'pop', '-q')
    expect(read('a.txt')).toBe('edit\n')
    expect(read('new.txt')).toBe('new\n')
  })

  it("git failing after it made the stash: said with the stash, kept (never rolled back)", async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    failStashAfter = true
    const err = await settle('setAside', ['a.txt']).catch((e: Error) => e)
    const top = sh(proj, 'rev-parse', 'refs/stash')
    expect(String(err)).toContain(top.slice(0, 12))
    expect(String(err)).toMatch(/after keeping them in a stash/)
    expect(sh(proj, 'show', 'refs/stash:a.txt')).toBe('edit')
  })

  it('git failing before any stash: said, nothing set aside', async () => {
    const err = await settle('setAside', ['a.txt']).catch((e: Error) => e)
    expect(String(err)).toMatch(/aren't the ones shown/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
  })
})

// HI-3021: a commit or stash past its bound (a slow hook, a signer nobody answers) had git.exe alone ended: on Windows it
// never removed the index.lock it held, so every git after failed on it, and the hook ran on. Now git's whole tree is
// ended, the lock it left removed (only one proved its own), the intent-to-add entries taken out, and the refusal says so.
describe('a commit or stash past its bound (HI-3021)', () => {
  const lockPath = (): string => join(proj, '.git', 'index.lock')
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /**
   * A shell script that starts two node processes, one in the background and one it waits on, each writing its pid to
   * `pids` and running 30 s (past any bound here): a hook's node, npm or gpg. Native programs, as hooks run: one of Git
   * Bash's own (its sleep) is started outside Windows' process tree, where no tree walk finds it.
   */
  const slowScript = (pids: string): string => {
    const node = `"${process.execPath.replace(/\\/g, '/')}" -e 'require("fs").appendFileSync(process.argv[1], process.pid + "\\n"); setTimeout(() => {}, 30000)' "${pids.replace(/\\/g, '/')}"`
    return `#!/bin/sh\n${node} &\n${node}\n`
  }
  const pidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).map(Number).filter((n) => n > 0) : [])
  let bound = 0
  beforeEach(() => {
    bound = changes.folderChangesBounds.actMs
    changes.folderChangesBounds.actMs = 3000
  })
  afterEach(() => {
    changes.folderChangesBounds.actMs = bound
  })

  it('Commit with a pre-commit hook slower than the bound: the hook ended too, no lock left, the files and the index as they were, said', async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'pre-commit'), slowScript(pids))
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const before = head()
    const err = await settle('commit', ['new.txt', 'a.txt']).catch((e: Error) => e)
    expect(String(err)).toMatch(/didn't finish the commit in 3 seconds/)
    expect(String(err)).not.toMatch(/lock on the repository is still there/)
    expect(existsSync(lockPath())).toBe(false)
    // The hook's shell and its sleep: two processes, both ended with git.
    expect(pidsIn(pids)).toHaveLength(2)
    await vi.waitFor(() => expect(pidsIn(pids).filter(alive)).toEqual([]), { timeout: 10_000 })
    expect(head()).toBe(before)
    expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['?? new.txt', 'M a.txt'])
    // The folder is usable again: Commit (no hook now) and the user's own git add.
    rmSync(join(proj, '.git', 'hooks', 'pre-commit'))
    await settle('commit', ['new.txt'])
    expect(committed()).toEqual(['new.txt'])
    sh(proj, 'add', 'a.txt')
  })

  it('Set Aside held up past the bound (a clean filter): ended, no lock left, said; the files on disk as they were', async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    const filter = join(tempDir('cw-folderchanges-filter-'), 'slow.sh')
    writeFileSync(filter, slowScript(pids))
    sh(proj, 'config', 'filter.slow.clean', `sh "${filter.replace(/\\/g, '/')}"`)
    writeFileSync(join(proj, '.git', 'info', 'attributes'), 'new.txt filter=slow\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    const err = await settle('setAside', ['new.txt']).catch((e: Error) => e)
    expect(String(err)).toMatch(/didn't finish setting the changes aside in 3 seconds/)
    expect(String(err)).not.toMatch(/lock on the repository is still there/)
    expect(existsSync(lockPath())).toBe(false)
    await vi.waitFor(() => expect(pidsIn(pids).length > 0 && pidsIn(pids).filter(alive).length === 0).toBe(true), { timeout: 10_000 })
    expect(read('new.txt')).toBe('new\n')
    sh(proj, 'add', 'a.txt')
  })

  it("the lock is removed only when proved its own: made after the command started and before its bound came", async () => {
    writeFileSync(lockPath(), '')
    const born = (await import('fs')).statSync(lockPath()).birthtimeMs
    // Made before the command started (another git's): left.
    expect(await changes.clearOwnLock(lockPath(), born + 1, born + 10_000)).toBe(false)
    // Made once the bound had come (a git started after the end): left.
    expect(await changes.clearOwnLock(lockPath(), born - 10_000, born)).toBe(false)
    expect(existsSync(lockPath())).toBe(true)
    // Made while it ran: removed.
    expect(await changes.clearOwnLock(lockPath(), born - 1, born + 10_000)).toBe(true)
    expect(existsSync(lockPath())).toBe(false)
    // None there: nothing left.
    expect(await changes.clearOwnLock(lockPath(), born - 1, born + 10_000)).toBe(true)
  })
})

// HI-2982: Files' Stop Tracking (`git rm --cached`) leaves the file's removal staged and the file in the folder. Commit
// took each path from the folder (`commit --only`), so the file went back into Git with its local content. Darren's
// decision (11 Nov 2026): git does all the index work; such a path is refused by name, nothing committed or changed.
describe('a file the user stopped tracking (its removal staged, the file kept)', () => {
  const stopTracking = (file: string, content: string, ignore: boolean): void => {
    commit(proj, { [file]: '{}\n' }, 'tracked')
    sh(proj, 'rm', '-q', '--cached', file)
    if (ignore) writeFileSync(join(proj, '.gitignore'), `node_modules/\n${file}\n`)
    writeFileSync(join(proj, file), content)
  }
  const inHead = (file: string): boolean => sh(proj, 'ls-tree', '--name-only', 'HEAD').split('\n').includes(file)
  /** HEAD, every index entry (mode, object, stage), the status and the stashes: compared before and after a refusal. */
  const state = (): string[] => [head(), sh(proj, 'ls-files', '--stage'), status(), sh(proj, 'stash', 'list')]
  const refused = /is staged for removal from Git: commit it yourself in Git; Combwork won't add it back/

  it('Commit with .gitignore (the start warning, H2): refused by name, nothing committed or changed, the secret in no commit', async () => {
    stopTracking('settings.local.json', '{"token":"REAL-SECRET"}\n', true)
    expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['D  settings.local.json', 'M .gitignore'])
    const before = state()
    await expect(settle('commit', ['.gitignore', 'settings.local.json'])).rejects.toThrow(/^settings\.local\.json is staged for removal from Git/)
    expect(state()).toEqual(before)
    expect(sh(proj, 'log', '--all', '-p', '--format=')).not.toContain('REAL-SECRET')
    expect(read('settings.local.json')).toBe('{"token":"REAL-SECRET"}\n')
    // The rest commits as before, the removal left staged for the user.
    await settle('commit', ['.gitignore'])
    expect(committed()).toEqual(['.gitignore'])
    expect(status()).toBe('D  settings.local.json')
    expect(inHead('settings.local.json')).toBe(true)
  })

  it("the kept file's stat failing (EPERM, not a missing file): Commit and Set Aside still refused by name, nothing changed", async () => {
    stopTracking('secret.env', 'LOCAL-SECRET\n', true)
    sh(proj, 'commit', '-q', '-m', 'ignore', '--only', '--', '.gitignore')
    const before = state()
    failLstatOf = 'secret.env'
    for (const action of ['commit', 'setAside'] as const) {
      await expect(settle(action, ['secret.env'])).rejects.toThrow(/^secret\.env is staged for removal from Git/)
      expect(state()).toEqual(before)
    }
    expect(sh(proj, 'log', '--all', '-p', '--format=')).not.toContain('LOCAL-SECRET')
  })

  it('the removal alone (.gitignore committed before): Commit and Set Aside refused by name, neither looping nor leaving a stash', async () => {
    stopTracking('secret.env', 'SECRET=1\n', true)
    sh(proj, 'commit', '-q', '-m', 'ignore', '--only', '--', '.gitignore')
    expect(status()).toBe('D  secret.env')
    const before = state()
    for (const action of ['commit', 'setAside', 'commit', 'setAside'] as const) {
      await expect(settle(action, ['secret.env'])).rejects.toThrow(refused)
      expect(state()).toEqual(before)
    }
    expect(read('secret.env')).toBe('SECRET=1\n')
  })

  it("no ignore line (listed removed and untracked): Commit and Set Aside refused, the staged removal never lost, the file's content kept", async () => {
    stopTracking('a.txt', 'local only\n', false)
    expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['?? a.txt', 'D  a.txt'])
    const before = state()
    await expect(settle('commit', ['a.txt'])).rejects.toThrow(refused)
    await expect(settle('setAside', ['a.txt'])).rejects.toThrow(refused)
    expect(state()).toEqual(before)
    expect(read('a.txt')).toBe('local only\n')
  })

  it('a staged rename whose old name is back on disk: refused by the old name, nothing done', async () => {
    sh(proj, 'mv', 'b.txt', 'c.txt')
    writeFileSync(join(proj, 'b.txt'), 'a new b\n')
    const before = state()
    await expect(settle('commit', ['c.txt'])).rejects.toThrow(/^b\.txt is staged for removal from Git/)
    expect(state()).toEqual(before)
  })

  it("Files' Commit it with .gitignore itself staged for removal and still there: refused by name", async () => {
    sh(proj, 'rm', '-q', '--cached', '.gitignore')
    const before = state()
    await expect(inWorkspace(w, () => changes.commitIgnore(proj))).rejects.toThrow(/^\.gitignore is staged for removal from Git/)
    expect(state()).toEqual(before)
  })
})

describe('the folder and its state, checked under the lock', () => {
  it('acts in the folder the target is checked out in (a linked worktree), never another', async () => {
    const tree = join(base, `tree${n}`)
    sh(proj, 'branch', 'side')
    sh(proj, 'worktree', 'add', '-q', tree, 'side')
    writeFileSync(join(tree, 'a.txt'), 'in the worktree\n')
    writeFileSync(join(proj, 'a.txt'), 'in the project folder\n')
    const done = await settle('commit', ['a.txt'], undefined, 'side', tree)
    expect(resolve(done.folder).toLowerCase()).toBe(resolve(tree).toLowerCase())
    expect(status(tree)).toBe('')
    expect(status()).toBe('M a.txt')
  })

  it('a target checked out nowhere, or another project, is refused', async () => {
    sh(proj, 'branch', 'nowhere')
    await expect(settle('commit', ['a.txt'], undefined, 'nowhere')).rejects.toThrow(/isn't checked out in a folder/)
    await expect(inWorkspace(w, () => changes.settleChanges(join(base, 'elsewhere'), 'main', proj, 'commit', ['a.txt'], 'x'))).rejects.toThrow(/Not a project/)
  })

  it('the target checked out in another folder than the one shown, the same file changed there too: refused, nothing done in either', async () => {
    const tree = join(base, `moved${n}`)
    writeFileSync(join(proj, 'a.txt'), 'shown here\n')
    const before = head()
    // main moves: the project folder detached, main checked out in another folder, whose a.txt the user also edits.
    sh(proj, 'checkout', '-q', '--detach')
    sh(proj, 'worktree', 'add', '-q', tree, 'main')
    writeFileSync(join(tree, 'a.txt'), 'another edit, never shown\n')
    await expect(settle('commit', ['a.txt'])).rejects.toThrow(/checked out changed meanwhile/)
    await expect(settle('setAside', ['a.txt'])).rejects.toThrow(/checked out changed meanwhile/)
    expect(sh(proj, 'rev-parse', 'refs/heads/main')).toBe(before)
    expect(status(tree)).toBe('M a.txt')
    expect(status()).toBe('M a.txt')
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
  })

  it('a merge under way, an agent working there, or a run holding files there: refused, nothing done', async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    agent = 'HB1'
    await expect(settle('commit', ['a.txt'])).rejects.toThrow(/HB1 is working in/)
    agent = null
    held = [join(proj, 'a.txt')]
    await expect(settle('setAside', ['a.txt'])).rejects.toThrow(/An agent or a run is working in/)
    held = null
    writeFileSync(join(proj, '.git', 'MERGE_HEAD'), `${head()}\n`)
    await expect(settle('commit', ['a.txt'])).rejects.toThrow(/in the middle of a merge/)
    rmSync(join(proj, '.git', 'MERGE_HEAD'))
    expect(status()).toBe('M a.txt')
  })

  it('a changed file whose name is in brackets is a file, not a git operation: Commit and Commit it go on beside it', async () => {
    writeFileSync(join(proj, '(draft).md'), 'a draft\n')
    mkdirSync(join(proj, '(notes)'), { recursive: true })
    writeFileSync(join(proj, '(notes)', 'a.md'), 'notes\n')
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n/reference/\n')
    await settle('commit', ['.gitignore'])
    expect(committed()).toEqual(['.gitignore'])
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n/reference/\n/out/\n')
    await inWorkspace(w, () => changes.commitIgnore(proj))
    expect(committed()).toEqual(['.gitignore'])
    // The bracketed ones are changes like any other: committed when shown.
    await settle('commit', ['(draft).md', '(notes)/a.md'])
    expect(committed()).toEqual(['(draft).md', '(notes)/a.md'])
  })

  it('HI-2983: a changed file named exactly as a marker, (MERGE_HEAD), is a file: Commit goes on, and a start lists it', async () => {
    writeFileSync(join(proj, '(MERGE_HEAD)'), 'not a merge\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const now = await worktreeNow(proj)
    expect(isUnknown(now) ? null : now.operations).toEqual([])
    // The start warning's list (port 5's targetChanges): only the project is read from the workflow.
    const listed = await inWorkspace(w, () => new GitPlatform({ cfg: { project: proj } } as unknown as ConstructorParameters<typeof GitPlatform>[0]).targetChanges('main'))
    expect(listed?.files.sort()).toEqual(['(MERGE_HEAD)', 'a.txt'])
    await settle('commit', ['a.txt', '(MERGE_HEAD)'])
    expect(committed()).toEqual(['(MERGE_HEAD)', 'a.txt'])
  })
})

// HI-2983: each path was its own argument, so a few hundred passed Windows' 32,767-character command line (spawn
// ENAMETOOLONG) and both buttons failed with nothing done. The paths now go to git on its input.
describe('many changed files', () => {
  const many = (count: number): string[] => {
    const out: string[] = []
    mkdirSync(join(proj, 'build', 'a fairly long generated folder name'), { recursive: true })
    for (let i = 0; i < count; i++) {
      const rel = `build/a fairly long generated folder name/generated output file number ${String(i).padStart(4, '0')}.txt`
      writeFileSync(join(proj, rel), `${i}\n`)
      out.push(rel)
    }
    return out
  }

  it('Commit of 1,000 untracked files (about 100,000 characters of paths), with a tracked edit: all committed, nothing else', async () => {
    const files = many(1000)
    expect(files.join(' ').length).toBeGreaterThan(32_767)
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'b.txt'), 'staged\n')
    sh(proj, 'add', 'b.txt')
    const done = await settle('commit', [...files, 'a.txt'])
    expect(done.files).toHaveLength(1001)
    expect(committed()).toEqual([...files, 'a.txt'].sort())
    expect(status()).toBe('M  b.txt')
  })

  it("Set Aside of 1,000 files, every change in the folder (a start's warning): still by name, so refused, no stash made, nothing changed", async () => {
    const files = many(1000)
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const before = status()
    await expect(settle('setAside', [...files, 'a.txt'])).rejects.toThrow(/Git can't set aside this many files \(1,001\) at once/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    expect(status()).toBe(before)
  })

  it("a file changed after the check, never shown, stays out of the stash and on disk, even when the shown file was every change (HR1's round 1)", async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    lateFile = 'late.txt'
    await settle('setAside', ['a.txt'])
    expect(lateFile).toBeNull()
    expect(sh(proj, 'diff', '--name-only', 'HEAD', 'refs/stash')).toBe('a.txt')
    // Its untracked files' commit (when git made one) without the late file.
    const untracked = ((): string => {
      try {
        return sh(proj, 'ls-tree', '-r', '--name-only', 'refs/stash^3')
      } catch {
        return ''
      }
    })()
    expect(untracked).not.toContain('late.txt')
    expect(read('late.txt')).toBe('not shown\n')
    expect(status()).toBe('?? late.txt')
  })

  it('Set Aside of some of the changes, given on its input: 150 files beside a staged one not shown', async () => {
    const files = many(150)
    writeFileSync(join(proj, 'b.txt'), 'staged\n')
    sh(proj, 'add', 'b.txt')
    await settle('setAside', files)
    expect(sh(proj, 'show', '--name-only', '--format=', 'refs/stash^3').split('\n').filter(Boolean)).toHaveLength(150)
    expect(status()).toBe('M  b.txt')
  })

  it("Set Aside of 1,000 of the changes but not all (more than git's stash can be given apart): refused, no stash made, nothing changed", async () => {
    const files = many(1000)
    writeFileSync(join(proj, 'b.txt'), 'staged\n')
    sh(proj, 'add', 'b.txt')
    const before = status()
    await expect(settle('setAside', files)).rejects.toThrow(/Git can't set aside this many files \(1,000\) at once/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    expect(status()).toBe(before)
  })

  it('a refusing hook with 1,000 untracked files: the intent-to-add entries taken out again, nothing lost', async () => {
    const files = many(1000)
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    const before = head()
    await expect(settle('commit', files)).rejects.toThrow(/Git did not commit/)
    expect(head()).toBe(before)
    expect(sh(proj, 'ls-files', '--stage')).not.toContain('generated')
    expect(status().split('\n')).toHaveLength(1000)
  })
})

// HI-2983: an untracked repository inside this one is listed whole (`nested/`); the trailing `/` made the window's list
// look stale, and beside other files it was left out with nothing said.
describe('an untracked repository of its own inside the folder', () => {
  const nested = (): void => {
    mkdirSync(join(proj, 'nested'), { recursive: true })
    gitRepo(join(proj, 'nested'))
    commit(join(proj, 'nested'), { 'x.txt': 'x\n' }, 'inner')
  }

  it('alone or beside other files: Commit and Set Aside refused by name, nothing done', async () => {
    nested()
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['?? nested/', 'M a.txt'])
    const before = [head(), status(), sh(proj, 'stash', 'list')]
    for (const shown of [['nested/'], ['a.txt', 'nested/']])
      for (const action of ['commit', 'setAside'] as const) await expect(settle(action, shown)).rejects.toThrow(/^nested\/ is a Git repository of its own inside this one/)
    expect([head(), status(), sh(proj, 'stash', 'list')]).toEqual(before)
  })
})

describe("Files' Commit it", () => {
  it('commits .gitignore alone, as it is now, with another file changed beside it', async () => {
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n/reference/\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const done = await inWorkspace(w, () => changes.commitIgnore(proj))
    expect(done).toMatchObject({ files: ['.gitignore'], branch: 'main' })
    expect(committed()).toEqual(['.gitignore'])
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('Update .gitignore')
    expect(status()).toBe('M a.txt')
  })

  it('no change to .gitignore: said, nothing committed', async () => {
    const before = head()
    await expect(inWorkspace(w, () => changes.commitIgnore(proj))).rejects.toThrow(/\.gitignore has no changes/)
    expect(head()).toBe(before)
  })

  it('a detached HEAD: refused', async () => {
    writeFileSync(join(proj, '.gitignore'), 'x\n')
    sh(proj, 'checkout', '-q', '--detach')
    await expect(inWorkspace(w, () => changes.commitIgnore(proj))).rejects.toThrow(/isn't on a branch/)
  })
})

describe("Files' Commit it from a project in a larger repository (HI-2962)", () => {
  // The workspace is the repository: its project folders `nested` and `other` are folders in it, `own` a repository of its own.
  let nested = ''
  const inRepoWorkspace = async <T>(fn: () => Promise<T>): Promise<T> => {
    w.path = proj
    try {
      return await inWorkspace(w, fn)
    } finally {
      w.path = ws
    }
  }
  beforeEach(() => {
    nested = join(proj, 'nested')
    for (const d of ['nested', 'other', 'own']) mkdirSync(join(proj, d))
    gitRepo(join(proj, 'own'))
    writeFileSync(join(proj, '.gitignore'), 'node_modules/\n/new/\n')
  })

  it('a run in the repository root, or in another project in it, refuses it: nothing committed', async () => {
    const before = head()
    for (const run of [join(proj, '.gitignore'), join(proj, 'other', 'out.log')]) {
      held = [run]
      await expect(inRepoWorkspace(() => changes.commitIgnore(nested))).rejects.toThrow(/An agent or a run is working in/)
      expect(head()).toBe(before)
    }
    expect(status()).toContain('.gitignore')
  })

  it("an agent of another project in the same tree refuses it; one in a repository of its own doesn't", async () => {
    agent = 'HB9'
    agentAt = join(proj, 'other')
    const before = head()
    await expect(inRepoWorkspace(() => changes.commitIgnore(nested))).rejects.toThrow(/HB9 is working in/)
    expect(head()).toBe(before)
    agentAt = join(proj, 'own')
    agentChecks = []
    const done = await inRepoWorkspace(() => changes.commitIgnore(nested))
    expect(done).toMatchObject({ files: ['.gitignore'], branch: 'main', made: head() })
    expect(norm(done.folder)).toBe(norm(proj))
    expect(committed()).toEqual(['.gitignore'])
    // The nested project's own agents first, the other project's too; never the separate repository's.
    const checked = agentChecks.map((c) => norm(c.project))
    expect(checked[0]).toBe(norm(nested))
    expect(checked).toContain(norm(join(proj, 'other')))
    expect(checked).not.toContain(norm(join(proj, 'own')))
  })

  it("another project git can't place (its read failed, or answered nothing) refuses it: nothing committed, the index as it was", async () => {
    writeFileSync(join(proj, 'b.txt'), 'staged b\n')
    sh(proj, 'add', 'b.txt')
    const before = head()
    const cases = [
      { fail: { folder: join(proj, 'other') }, said: /Git could not read the folder's changes: fatal: unable to read the repository/ },
      { fail: { folder: join(proj, 'other'), empty: true }, said: /Git didn't say which repository .*other is in/ }
    ]
    for (const { fail, said } of cases) {
      failTopIn = fail
      await expect(inRepoWorkspace(() => changes.commitIgnore(nested))).rejects.toThrow(said)
      expect(head()).toBe(before)
      expect(sh(proj, 'diff', '--cached', '--name-only')).toBe('b.txt')
      expect(sh(proj, 'diff', '--name-only')).toBe('.gitignore')
    }
  })

  it('the whole tree is fenced while it commits, not only the project folder', async () => {
    fencedProbe = join(proj, 'other')
    await inRepoWorkspace(() => changes.commitIgnore(nested))
    expect(agentChecks.length).toBeGreaterThan(0)
    expect(agentChecks.every((c) => c.fenced !== null)).toBe(true)
  })
})
