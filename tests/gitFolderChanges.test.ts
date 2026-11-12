// A folder's uncommitted changes, committed or set aside (HI-2944, port 5's folderChanges): only the paths shown, in the
// folder the target is checked out in (found by Combwork, never given), everything checked again under the lock and the
// fence; a stale or empty list refused with nothing done; another staged file kept staged; an untracked file, a rename
// and a deletion; a refusing hook losing nothing; a stash told by its object, kept and named when git fails after making
// it; the caller's guard, an operation under way, a busy folder; Files' Commit it committing .gitignore alone. Real git
// in throwaway repositories.
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join, resolve } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import type { GitResult } from '../src/main/git'
import { msysBinFor } from '../src/main/gitWorker'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
type Ids = { pid: number; started: number }[]
const { identify, stillSame, endExactly } = req('./e2e/folderProcesses.cjs') as { identify: (pids: number[]) => Ids; stillSame: (ids: Ids) => number[]; endExactly: (targets: Ids) => number }

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
/** HI-3022: a file written just before the next `checkout-index` (a rename's old side put back) runs. */
let beforeRestore: { file: string; text: string } | null = null
/** HI-3021: each git command and its bound, while a test collects them (null: none). */
let gitCalls: { args: string[]; timeout?: number }[] | null = null
/** HI-3021: the next `rev-parse --verify HEAD` fails as an unreadable HEAD does (not an unborn branch's exit 1). */
let failHeadOnce = false
/** HI-3053: run with the folder once the next commit or `stash push` is made, before Combwork takes its entries in. */
let afterMade: ((cwd: string) => void) | null = null
/** A folder whose `rev-parse --show-toplevel` fails (HI-2962): `empty`, answered ok with nothing. */
let failTopIn: { folder: string; empty?: boolean } | null = null
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number, input?: string, opts?: Parameters<typeof real.git>[4]): Promise<GitResult> => {
      gitCalls?.push({ args, timeout: opts?.timeout })
      if (failHeadOnce && args[0] === 'rev-parse' && args.includes('--verify') && args.includes('HEAD')) {
        // HI-3021 (HR2's round 2): HEAD unreadable for a moment, as git fails reading it.
        failHeadOnce = false
        return { ok: false, code: 128, out: '', err: 'fatal: unable to read HEAD', buf: Buffer.alloc(0) }
      }
      if (failTopIn && args[0] === 'rev-parse' && args.includes('--show-toplevel') && resolve(cwd).toLowerCase() === resolve(failTopIn.folder).toLowerCase())
        return failTopIn.empty ? { ok: true, code: 0, out: '', err: '', buf: Buffer.alloc(0) } : { ok: false, code: 128, out: '', err: 'fatal: unable to read the repository', buf: Buffer.alloc(0) }
      if (beforeRestore && args.includes('checkout-index')) {
        // HI-3022 (HR1's round 1): a file made at a rename's old side just before it is put back from HEAD.
        writeFileSync(join(cwd, beforeRestore.file), beforeRestore.text)
        beforeRestore = null
      }
      if (lateFile && args[0] === 'stash' && args[1] === 'push') {
        // HI-2983 (HR1's round 1): a change made after the check, never shown, just before git stashes.
        writeFileSync(join(cwd, lateFile), 'not shown\n')
        lateFile = null
      }
      const r = await real.git(cwd, args, max, input, opts)
      if (afterMade && r.ok && (args[0] === 'commit' || (args[0] === 'stash' && args[1] === 'push'))) {
        // HI-3053: another git's work once the commit or stash is made, before its entries are taken into the real index.
        const then = afterMade
        afterMade = null
        then(cwd)
      }
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
  failHeadOnce = false
  gitCalls = null
  beforeRestore = null
  failStashAfter = false
  failLstatOf = null
  lateFile = null
  afterMade = null
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

  // HI-3022: git's stash, given a staged rename's old side (in neither the index nor the folder), made the stash then
  // died on it, every try, leaving a stash each time and nothing set aside.
  for (const [what, edit, shown] of [
    ['a pure staged rename', false, ['c.txt']],
    ['a staged rename with an edit', true, ['c.txt']],
    ['a staged rename shown by its old side', false, ['b.txt']]
  ] as const)
    it(`${what}: one stash, the folder clean, and git stash pop --index gives the rename back (HI-3022)`, async () => {
      sh(proj, 'mv', 'b.txt', 'c.txt')
      if (edit) writeFileSync(join(proj, 'c.txt'), 'b\nmore\n')
      const was = status()
      const done = await settle('setAside', [...shown])
      expect(done.files.sort()).toEqual(['b.txt', 'c.txt'])
      expect(done.made).toBe(sh(proj, 'rev-parse', 'refs/stash'))
      expect(sh(proj, 'stash', 'list').split('\n')).toHaveLength(1)
      expect(status()).toBe('')
      expect(read('b.txt')).toBe('b\n')
      expect(existsSync(join(proj, 'c.txt'))).toBe(false)
      sh(proj, 'stash', 'pop', '-q', '--index')
      expect(status()).toBe(was)
      expect(read('c.txt')).toBe(edit ? 'b\nmore\n' : 'b\n')
      expect(existsSync(join(proj, 'b.txt'))).toBe(false)
    })

  it("a staged rename's old side made again just before it is put back (HR1's round 1): never written over, the stash made named", async () => {
    sh(proj, 'mv', 'b.txt', 'c.txt')
    beforeRestore = { file: 'b.txt', text: 'late user work\n' }
    const err = await settle('setAside', ['c.txt']).catch((e: Error) => e)
    const stash = sh(proj, 'rev-parse', 'refs/stash')
    expect(String(err)).toMatch(new RegExp(`after keeping them in a stash \\(${stash.slice(0, 12)}\\).*b\\.txt already exists, no checkout`))
    expect(read('b.txt')).toBe('late user work\n')
    expect(sh(proj, 'show', 'refs/stash:c.txt')).toBe('b')
    expect(existsSync(join(proj, 'c.txt'))).toBe(false)
    expect(sh(proj, 'stash', 'list').split('\n')).toHaveLength(1)
  })

  it('a file added then deleted on disk (AD): set aside, said as done, not as a problem (HI-3022)', async () => {
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    sh(proj, 'add', 'new.txt')
    rmSync(join(proj, 'new.txt'))
    expect(status()).toBe('AD new.txt')
    const done = await settle('setAside', ['new.txt'])
    expect(done.made).toBe(sh(proj, 'rev-parse', 'refs/stash'))
    expect(sh(proj, 'show', 'refs/stash^2:new.txt')).toBe('new')
    expect(status()).toBe('')
  })

  it('git failing before any stash: said, nothing set aside', async () => {
    const err = await settle('setAside', ['a.txt']).catch((e: Error) => e)
    expect(String(err)).toMatch(/aren't the ones shown/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
  })
})

// HI-3021: a commit or stash past its bound (a slow hook, a signer nobody answers) had git.exe alone ended: on Windows it
// never removed the index.lock it held, so every git after failed on it, and the hook ran on. Now git's whole tree is
// ended, and the commit or stash runs against a private copy of the index, so the real index is never locked while hooks
// or filters run; what git did to the shown paths is taken into it in one short step once something is made.
describe('a commit or stash past its bound (HI-3021)', () => {
  const lockPath = (): string => join(proj, '.git', 'index.lock')
  /** Combwork's private indexes (and their locks) left in the git folder. */
  const leftovers = (): string[] => readdirSync(join(proj, '.git')).filter((f) => f.includes('combwork'))
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const fwd = (p: string): string => p.replace(/\\/g, '/')
  /**
   * A shell script that starts two node processes, one in the background and one it waits on, each writing its pid to
   * `pids` and running 30 s (past any bound here): a hook's node, npm or gpg. With `msys` (HI-3047), first a Git Bash
   * `sleep 30` of its own, started in the background by a subshell that then exits: outside Windows' process tree (MSYS's
   * exec leaves its Windows parent gone, and its shell is gone too), found by the timed git's marker. Its winpid is
   * written once it is sleep (until MSYS's exec, `$!` names the forked sh.exe).
   */
  const slowScript = (pids: string, msys = false): string => {
    const node = `"${fwd(process.execPath)}" -e 'require("fs").appendFileSync(process.argv[1], process.pid + "\\n"); setTimeout(() => {}, 30000)' "${fwd(pids)}"`
    return `#!/bin/sh\n${msys ? `( ${sleeper(pids)} )\n` : ''}${node} &\n${node}\n`
  }
  /** Git Bash: a background `sleep 30`, its winpid added to `pids` once it is sleep. */
  const sleeper = (pids: string): string => `sleep 30 & while :; do read -r e < /proc/$!/exename; case "$e" in */sleep*) break;; esac; done; read -r w < /proc/$!/winpid; echo "$w" >> "${fwd(pids)}"`
  const pidsIn = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).map(Number).filter((pid) => pid > 0) : [])
  const lines = (): string[] => status().split('\n').map((l) => l.trim()).filter(Boolean).sort()
  let bound = 0
  beforeEach(() => {
    bound = changes.folderChangesBounds.actMs
    changes.folderChangesBounds.actMs = 3000
  })
  afterEach(() => {
    changes.folderChangesBounds.actMs = bound
  })

  it("Commit with a pre-commit hook slower than the bound: the hook ended too, its Git Bash sleep included, and nothing else; the real index never locked (the user's git add meanwhile kept), as it was; said", async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    // HI-3047 (Git for Windows): the hook starts a Git Bash sleep too; and an unrelated one, started as the hook's is but
    // outside the commit (no marker), is left running.
    const msys = process.platform === 'win32'
    const control = join(tempDir('cw-folderchanges-control-'), 'pids')
    let controlId: { pid: number; started: number }[] = []
    if (msys) {
      const bin = msysBinFor({ env: process.env })
      expect(bin).not.toBeNull()
      spawn(join(bin!, 'sh.exe'), ['-c', sleeper(control)], { stdio: 'ignore', windowsHide: true, env: baseEnv() }).unref()
      await vi.waitFor(() => expect(pidsIn(control)).toHaveLength(1), { timeout: 20_000 })
      // Its identity while it is known to be the test's own (#603): ended by it afterwards.
      controlId = identify(pidsIn(control))
      expect(controlId).toHaveLength(1)
    }
    onTestFinished(() => void endExactly(controlId))
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'pre-commit'), slowScript(pids, msys))
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'b.txt'), 'staged by the user meanwhile\n')
    const before = head()
    const done = settle('commit', ['new.txt', 'a.txt']).catch((e: Error) => e)
    // While the hook runs, the user's own git add works: the real index isn't locked.
    await vi.waitFor(() => expect(pidsIn(pids)).toHaveLength(msys ? 3 : 2), { timeout: 20_000 })
    sh(proj, 'add', 'b.txt')
    const err = await done
    expect(String(err)).toMatch(/didn't finish the commit in 3 seconds.*The files and the index are as they were/)
    await vi.waitFor(() => expect(pidsIn(pids).filter(alive)).toEqual([]), { timeout: 10_000 })
    expect(stillSame(controlId)).toEqual(controlId.map((c) => c.pid))
    expect(existsSync(lockPath())).toBe(false)
    expect(leftovers()).toEqual([])
    expect(head()).toBe(before)
    // No intent-to-add entry left for new.txt; the user's staged b.txt kept.
    expect(lines()).toEqual(['?? new.txt', 'M  b.txt', 'M a.txt'])
    // Usable again: Commit (no hook now).
    rmSync(join(proj, '.git', 'hooks', 'pre-commit'))
    await settle('commit', ['new.txt', 'a.txt'])
    expect(committed()).toEqual(['a.txt', 'new.txt'])
    expect(lines()).toEqual(['M  b.txt'])
  })

  it('Set Aside held up past the bound in a step that holds the index (a slow smudge filter as the files are put back): ended, the stash named, the real index never locked, nothing left', async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    const filter = join(tempDir('cw-folderchanges-filter-'), 'slow.sh')
    writeFileSync(filter, slowScript(pids))
    sh(proj, 'config', 'filter.slow.clean', 'cat')
    sh(proj, 'config', 'filter.slow.smudge', `sh "${fwd(filter)}"`)
    writeFileSync(join(proj, '.git', 'info', 'attributes'), 'a.txt filter=slow\n')
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const done = settle('setAside', ['a.txt']).catch((e: Error) => e)
    // While git checks a.txt out again (its index lock held), the real index is free.
    await vi.waitFor(() => expect(pidsIn(pids).length).toBeGreaterThan(0), { timeout: 20_000 })
    expect(existsSync(lockPath())).toBe(false)
    sh(proj, 'add', 'b.txt')
    const err = await done
    expect(String(err)).toMatch(/didn't finish setting the changes aside in 3 seconds/)
    const made = sh(proj, 'rev-parse', 'refs/stash')
    expect(String(err)).toContain(made.slice(0, 12))
    expect(sh(proj, 'show', 'refs/stash:a.txt')).toBe('edit')
    await vi.waitFor(() => expect(pidsIn(pids).filter(alive)).toEqual([]), { timeout: 10_000 })
    expect(existsSync(lockPath())).toBe(false)
    expect(leftovers()).toEqual([])
    // Usable again: git add, and Commit.
    sh(proj, 'config', '--unset', 'filter.slow.smudge')
    writeFileSync(join(proj, 'a.txt'), 'edit again\n')
    sh(proj, 'add', 'a.txt')
    sh(proj, 'reset', '-q', 'a.txt')
    await settle('commit', ['a.txt'])
    expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('edit again')
  })

  it('Set Aside held up in a clean filter, before any stash: ended, no stash, the real index and the files as they were', async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    const filter = join(tempDir('cw-folderchanges-filter-'), 'slow.sh')
    writeFileSync(filter, slowScript(pids))
    sh(proj, 'config', 'filter.slow.clean', `sh "${fwd(filter)}"`)
    writeFileSync(join(proj, '.git', 'info', 'attributes'), 'new.txt filter=slow\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    const err = await settle('setAside', ['new.txt']).catch((e: Error) => e)
    expect(String(err)).toMatch(/didn't finish setting the changes aside in 3 seconds/)
    expect(String(err)).not.toMatch(/in a stash/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    await vi.waitFor(() => expect(pidsIn(pids).length > 0 && pidsIn(pids).filter(alive).length === 0).toBe(true), { timeout: 10_000 })
    expect(existsSync(lockPath())).toBe(false)
    expect(leftovers()).toEqual([])
    expect(read('new.txt')).toBe('new\n')
    expect(lines()).toEqual(['?? new.txt'])
  })

  const slowPostCommit = (marker: string): void => {
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'post-commit'), `#!/bin/sh\n: > "${fwd(marker)}"\n"${fwd(process.execPath)}" -e 'setTimeout(() => {}, 30000)'\n`)
  }

  it('ended in post-commit, after the commit was made: made, said so, the index taken in (new and edited files committed, nothing left changed)', async () => {
    slowPostCommit(join(tempDir('cw-folderchanges-post-'), 'started'))
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    const before = head()
    const done = await settle('commit', ['a.txt', 'new.txt'])
    expect(done.made).toBe(head())
    expect(head()).not.toBe(before)
    expect(committed()).toEqual(['a.txt', 'new.txt'])
    expect(lines()).toEqual([])
    expect(leftovers()).toEqual([])
  })

  it("ended in post-commit while another program holds the real index's lock (HR2's rounds 1 and 2): made, said so, that lock never touched", async () => {
    const marker = join(tempDir('cw-folderchanges-post-'), 'started')
    slowPostCommit(marker)
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    const before = head()
    const done = settle('commit', ['a.txt']).catch((e: Error) => e)
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 20_000 })
    // Another program takes the index lock and holds it, open, while git still runs and after.
    const fs = await import('fs')
    const fd = fs.openSync(lockPath(), 'wx')
    try {
      fs.writeSync(fd, "not Combwork's")
      const err = await done
      expect(head()).not.toBe(before)
      expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('edit')
      expect(String(err)).toMatch(new RegExp(`Git made the commit \\(${head().slice(0, 12)}\\), but Combwork couldn't update the index`))
      expect(readFileSync(lockPath(), 'utf8')).toBe("not Combwork's")
      expect(leftovers()).toEqual([])
    } finally {
      fs.closeSync(fd)
      rmSync(lockPath(), { force: true })
    }
  })

  it("another git commits while this one's pre-commit hook runs, then this one is ended (HR2's round 3): HEAD moved but not by it, so refused, the other commit and the staging left as they are", async () => {
    const pids = join(tempDir('cw-folderchanges-pids-'), 'pids')
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'pre-commit'), slowScript(pids))
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'b.txt'), 'theirs\n')
    const before = head()
    const done = settle('commit', ['a.txt']).catch((e: Error) => e)
    await vi.waitFor(() => expect(pidsIn(pids)).toHaveLength(2), { timeout: 20_000 })
    // The user's own commit meanwhile, with the real index and no hooks.
    sh(proj, '-c', `core.hooksPath=${fwd(join(tempDir('cw-folderchanges-nohooks-'), 'none'))}`, 'commit', '-q', '-m', 'theirs', '--', 'b.txt')
    const theirs = head()
    expect(theirs).not.toBe(before)
    const err = await done
    expect(String(err)).toMatch(/didn't finish the commit in 3 seconds/)
    expect(head()).toBe(theirs)
    expect(sh(proj, 'log', '-1', '--format=%s')).toBe('theirs')
    // a.txt neither committed nor staged as if it were.
    expect(lines()).toEqual(['M a.txt'])
    expect(leftovers()).toEqual([])
  })

  it("the step into the real index runs no hook, from the hooks folder or set in git's config, and is never bounded (HR2's rounds 3 and 4): made, the index taken in", async () => {
    const dir = tempDir('cw-folderchanges-pic-')
    const fileHook = join(dir, 'file hook ran')
    const configHook = join(dir, 'config hook ran')
    // Each only for the real index (no GIT_INDEX_FILE): the private index's commit runs them too.
    const slow = (marker: string): string => `[ -n "$GIT_INDEX_FILE" ] || { : > "${fwd(marker)}"; "${fwd(process.execPath)}" -e 'setTimeout(() => {}, 30000)'; }`
    mkdirSync(join(proj, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(proj, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\n${slow(fileHook)}\n`)
    writeFileSync(join(dir, 'config-hook.sh'), `#!/bin/sh\n${slow(configHook)}\n`)
    // A name with a dot and capitals, as git keeps a hook's name.
    sh(proj, 'config', 'hook.My.Slow.event', 'post-index-change')
    sh(proj, 'config', 'hook.My.Slow.command', `sh "${fwd(join(dir, 'config-hook.sh'))}"`)
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    gitCalls = []
    const done = await settle('commit', ['a.txt', 'new.txt'])
    expect(done.made).toBe(head())
    expect(committed()).toEqual(['a.txt', 'new.txt'])
    expect(existsSync(fileHook)).toBe(false)
    expect(existsSync(configHook)).toBe(false)
    // Never given a bound: never ended while it holds the real index's lock.
    const takes = gitCalls.filter((c) => c.args.includes('update-index'))
    expect(takes).toHaveLength(1)
    expect(takes[0].timeout).toBeUndefined()
    gitCalls = null
    sh(proj, 'config', '--unset', 'hook.My.Slow.event')
    expect(lines()).toEqual([])
    expect(existsSync(lockPath())).toBe(false)
  })

  // HI-3053: the real index is free while the commit or stash runs, so another git can stage a shown path meanwhile.
  it('Commit: a shown path staged by another git after the commit is made and before its entries are taken in keeps that staging; the other shown path and an unshown staged one as they should be; said with the commit', async () => {
    writeFileSync(join(proj, 'a.txt'), 'content Combwork commits\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    writeFileSync(join(proj, 'b.txt'), 'staged by the user before\n')
    sh(proj, 'add', 'b.txt')
    afterMade = (cwd) => {
      writeFileSync(join(cwd, 'a.txt'), 'concurrently staged snapshot\n')
      sh(cwd, 'add', 'a.txt')
      writeFileSync(join(cwd, 'a.txt'), 'later unstaged text\n')
    }
    const err = await settle('commit', ['a.txt', 'new.txt']).catch((e: Error) => e)
    expect(afterMade).toBeNull()
    expect(committed()).toEqual(['a.txt', 'new.txt'])
    expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('content Combwork commits')
    expect(String(err)).toContain(`Git made the commit (${head().slice(0, 12)}), but another git command staged a.txt meanwhile`)
    // The other git's staging kept, never written over; new.txt taken in; b.txt still staged as it was.
    expect(sh(proj, 'show', ':a.txt')).toBe('concurrently staged snapshot')
    expect(read('a.txt')).toBe('later unstaged text\n')
    expect(sh(proj, 'show', ':b.txt')).toBe('staged by the user before')
    expect(lines()).toEqual(['M  b.txt', 'MM a.txt'])
    expect(existsSync(lockPath())).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('Set Aside: a shown path staged by another git after the stash is made keeps that staging; said with the stash', async () => {
    writeFileSync(join(proj, 'a.txt'), 'set aside\n')
    writeFileSync(join(proj, 'b.txt'), 'b set aside too\n')
    afterMade = (cwd) => {
      writeFileSync(join(cwd, 'a.txt'), 'concurrently staged snapshot\n')
      sh(cwd, 'add', 'a.txt')
    }
    const err = await settle('setAside', ['a.txt', 'b.txt']).catch((e: Error) => e)
    expect(afterMade).toBeNull()
    const made = sh(proj, 'rev-parse', 'refs/stash')
    expect(sh(proj, 'show', 'refs/stash:a.txt')).toBe('set aside')
    expect(String(err)).toContain(`Git set the changes aside in a stash (${made.slice(0, 12)}), but another git command staged a.txt meanwhile`)
    expect(sh(proj, 'show', ':a.txt')).toBe('concurrently staged snapshot')
    expect(lines()).toEqual(['M  a.txt'])
    expect(existsSync(lockPath())).toBe(false)
    expect(leftovers()).toEqual([])
  })

  it('a shown path another git staged to the same entry it had (nothing changed) is taken in as usual: made, nothing said', async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    // git add of a file unchanged since HEAD: its entry is as it was.
    afterMade = (cwd) => void sh(cwd, 'add', 'b.txt')
    const done = await settle('commit', ['a.txt'])
    expect(done.made).toBe(head())
    expect(lines()).toEqual([])
  })

  it("HI-3053 (HR1's round 1): the paths another git changed found in one pass, never a scan per path: 50,000 selected", () => {
    const files = Array.from({ length: 50_000 }, (_, i) => `f${i}`)
    const was = files.map((p, i) => `100644 ${String(i).padStart(40, '0')} 0\t${p}`)
    // f7 restaged, f9 put in conflict (its stages in another order), f11 gone; the rest the same, listed in reverse.
    const now = [...was].reverse().filter((e) => !/\tf(7|9|11)$/.test(e))
    now.push(`100644 ${'7'.repeat(40)} 0\tf7`, `100644 ${'9'.repeat(40)} 3\tf9`, `100644 ${'9'.repeat(40)} 2\tf9`)
    const t = performance.now()
    expect(changes.changedPaths(files, was, now)).toEqual(['f7', 'f9', 'f11'])
    // A bound for a hung run, not how long it should take (a scan per path took seconds at 5,000).
    expect(performance.now() - t).toBeLessThan(5_000)
    // A path's entries in another order are the same.
    expect(changes.changedPaths(['c'], ['100644 a 2\tc', '100644 b 3\tc'], ['100644 b 3\tc', '100644 a 2\tc'])).toEqual([])
    expect(changes.changedPaths(['new'], [], ['100644 a 0\tnew'])).toEqual(['new'])
  })

  it('entries compared whatever their order, each side sorted once (HR2\'s round 4): 50,000 a side', () => {
    const a = Array.from({ length: 50_000 }, (_, i) => `100644 ${String(i).padStart(40, '0')} 0\tf${i}`)
    const b = [...a].reverse()
    const t = performance.now()
    expect(changes.sameEntries(a, b)).toBe(true)
    // A bound for a hung run, not how long it should take (once per entry, it took minutes).
    expect(performance.now() - t).toBeLessThan(5_000)
    expect(changes.sameEntries(a, [...b.slice(1), 'other'])).toBe(false)
    expect(changes.sameEntries(a, b.slice(1))).toBe(false)
  })

  it("HEAD unreadable before the commit (HR2's round 2): refused before anything runs, never taken for a commit made", async () => {
    writeFileSync(join(proj, 'a.txt'), 'edit\n')
    writeFileSync(join(proj, 'new.txt'), 'new\n')
    const before = head()
    failHeadOnce = true
    await expect(settle('commit', ['a.txt', 'new.txt'])).rejects.toThrow(/Git did not commit: git couldn't read HEAD/)
    expect(head()).toBe(before)
    expect(lines()).toEqual(['?? new.txt', 'M a.txt'])
    expect(leftovers()).toEqual([])
  })
})

// HI-3024: a case-only rename's old side, and a removed file whose path is now a folder, were taken for files the user
// stopped tracking but kept (Windows' lstat finds `b.txt` as `B.txt`, and finds a folder): "staged for removal". And
// git's own partial commit can't take either.
describe('a case-only rename, and a removal replaced by a folder (HI-3024)', () => {
  const tree = (): string[] => sh(proj, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean).sort()
  const lines = (): string[] => status().split('\n').map((l) => l.trim()).filter(Boolean).sort()

  it('a case-only rename: Commit commits it (the new name alone in HEAD), another staged change left staged and out of the commit', async () => {
    sh(proj, 'mv', 'b.txt', 'B.txt')
    writeFileSync(join(proj, 'a.txt'), 'staged, not shown\n')
    sh(proj, 'add', 'a.txt')
    expect(lines()).toEqual(['M  a.txt', 'R  b.txt -> B.txt'])
    const was = tree()
    const done = await settle('commit', ['B.txt'])
    expect(done.files.sort()).toEqual(['B.txt', 'b.txt'])
    expect(done.made).toBe(head())
    expect(tree()).toEqual(was.map((p) => (p === 'b.txt' ? 'B.txt' : p)).sort())
    expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('a')
    expect(lines()).toEqual(['M  a.txt'])
  })

  it("a case-only rename of a folder, with an edit: Commit takes the folder's content as it is", async () => {
    commit(proj, { 'lib/one.txt': 'one\n' }, 'lib')
    // git mv can't change a folder's case on Windows ("renaming 'lib' to 'Lib/lib' failed"): renamed on disk, then staged.
    renameSync(join(proj, 'lib'), join(proj, 'lib-'))
    renameSync(join(proj, 'lib-'), join(proj, 'Lib'))
    sh(proj, 'rm', '-r', '-q', '--cached', 'lib')
    sh(proj, 'add', 'Lib')
    expect(status()).toMatch(/^R {2}lib\/one\.txt -> Lib\/one\.txt$/m)
    writeFileSync(join(proj, 'Lib', 'one.txt'), 'one, edited\n')
    await settle('commit', ['Lib/one.txt'])
    expect(tree()).toContain('Lib/one.txt')
    expect(tree()).not.toContain('lib/one.txt')
    expect(sh(proj, 'show', 'HEAD:Lib/one.txt')).toBe('one, edited')
    expect(lines()).toEqual([])
  })

  it('a case-only rename: Set Aside refused saying what it is, nothing set aside or changed', async () => {
    sh(proj, 'mv', 'b.txt', 'B.txt')
    const was = status()
    await expect(settle('setAside', ['B.txt'])).rejects.toThrow(/^b\.txt is renamed to B\.txt, a change of letter case only, which Git can't set aside/)
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    expect(status()).toBe(was)
  })

  it('a removed file whose path is now a folder: never called a kept file; Commit commits the removal alone, the folder left untracked', async () => {
    sh(proj, 'rm', '-q', 'b.txt')
    mkdirSync(join(proj, 'b.txt'))
    writeFileSync(join(proj, 'b.txt', 'x.txt'), 'x\n')
    expect(lines()).toEqual(['?? b.txt/x.txt', 'D  b.txt'])
    const before = head()
    const was = tree()
    await settle('commit', ['b.txt'])
    expect(head()).not.toBe(before)
    expect(tree()).toEqual(was.filter((p) => p !== 'b.txt'))
    expect(lines()).toEqual(['?? b.txt/x.txt'])
    expect(read('b.txt/x.txt')).toBe('x\n')
  })

  it("a removed file whose path is now a folder: Set Aside refused, with the folder's files shown or not (HR1's round 1: the stash would take any made there later), nothing changed", async () => {
    sh(proj, 'rm', '-q', 'b.txt')
    mkdirSync(join(proj, 'b.txt'))
    writeFileSync(join(proj, 'b.txt', 'x.txt'), 'x\n')
    for (const shown of [['b.txt'], ['b.txt', 'b.txt/x.txt']]) {
      // A file made in the folder just before git's stash would run (HI-2983's late file): never reached.
      lateFile = 'b.txt/late.txt'
      await expect(settle('setAside', shown)).rejects.toThrow(/^b\.txt was removed from Git, and a folder of that name is in its place: setting the removal aside would take the folder's files too/)
      lateFile = null
    }
    expect(() => sh(proj, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    expect(read('b.txt/x.txt')).toBe('x\n')
    expect(existsSync(join(proj, 'b.txt', 'late.txt'))).toBe(false)
    expect(lines()).toEqual(['?? b.txt/x.txt', 'D  b.txt'])
  })

  it("a case-only rename beside another file in conflict (HR1's round 1): Commit commits the rename, the other file's conflict kept in the index and on disk", async () => {
    writeFileSync(join(proj, 'a.txt'), 'mine\n')
    sh(proj, 'stash', 'push', '-q')
    commit(proj, { 'a.txt': 'theirs\n' }, 'theirs')
    expect(() => sh(proj, 'stash', 'pop', '-q')).toThrow()
    sh(proj, 'mv', 'b.txt', 'B.txt')
    expect(lines()).toEqual(['R  b.txt -> B.txt', 'UU a.txt'])
    const conflict = sh(proj, 'ls-files', '-u', 'a.txt')
    const onDisk = read('a.txt')
    const was = tree()
    await settle('commit', ['B.txt'])
    expect(tree()).toEqual(was.map((p) => (p === 'b.txt' ? 'B.txt' : p)).sort())
    expect(sh(proj, 'show', 'HEAD:a.txt')).toBe('theirs')
    expect(lines()).toEqual(['UU a.txt'])
    expect(sh(proj, 'ls-files', '-u', 'a.txt')).toBe(conflict)
    expect(read('a.txt')).toBe(onDisk)
  })
})

// HI-3025: a file in conflict with no operation under way (a `git stash pop` that conflicted: `UU`, no MERGE_HEAD) was
// listed as any change, and Commit committed it markers and all (commit --only adds it, marking it resolved).
describe('a file in conflict, no operation under way (HI-3025)', () => {
  it('a conflicted stash pop: Commit and Set Aside refused by name, beside another change too; nothing committed, stashed or changed', async () => {
    writeFileSync(join(proj, 'a.txt'), 'mine\n')
    sh(proj, 'stash', 'push', '-q')
    commit(proj, { 'a.txt': 'theirs\n' }, 'theirs')
    expect(() => sh(proj, 'stash', 'pop', '-q')).toThrow()
    writeFileSync(join(proj, 'b.txt'), 'edit\n')
    const now = await worktreeNow(proj)
    if (isUnknown(now)) throw new Error('unknown')
    // Listed by the notification, with no operation under way.
    expect(now.dirty).toContain('a.txt')
    expect(now.operations ?? []).toEqual([])
    const before = head()
    const stashes = sh(proj, 'stash', 'list')
    const was = status()
    const onDisk = read('a.txt')
    for (const action of ['commit', 'setAside'] as const)
      for (const shown of [['a.txt'], ['b.txt', 'a.txt']]) await expect(settle(action, shown)).rejects.toThrow(/a\.txt is in conflict in Git: resolve it there first/)
    expect(head()).toBe(before)
    expect(sh(proj, 'stash', 'list')).toBe(stashes)
    expect(status()).toBe(was)
    expect(read('a.txt')).toBe(onDisk)
    expect(onDisk).toContain('<<<<<<<')
    // The other change alone still goes.
    await settle('commit', ['b.txt'])
    expect(committed()).toEqual(['b.txt'])
    expect(status()).toMatch(/^UU a\.txt$/m)
  })

  it("Files' Commit it with .gitignore in conflict: refused by name", async () => {
    writeFileSync(join(proj, '.gitignore'), 'mine/\n')
    sh(proj, 'stash', 'push', '-q')
    commit(proj, { '.gitignore': 'theirs/\n' }, 'theirs')
    expect(() => sh(proj, 'stash', 'pop', '-q')).toThrow()
    const before = head()
    await expect(inWorkspace(w, () => changes.commitIgnore(proj))).rejects.toThrow(/\.gitignore is in conflict in Git/)
    expect(head()).toBe(before)
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

// HI-3023: a registered submodule whose only changes are inside it (` M sub`, porcelain v2 `S.M.` or `S..U`) has nothing
// the folder can commit or stash: it was listed, and Commit and Set Aside failed with git's "On branch main".
describe('a submodule changed only inside it', () => {
  const listed = (): Promise<string[] | undefined> => inWorkspace(w, () => new GitPlatform({ cfg: { project: proj } } as unknown as ConstructorParameters<typeof GitPlatform>[0]).targetChanges('main')).then((t) => t?.files.sort())
  beforeEach(() => {
    const sub = join(base, `sub${n}`)
    mkdirSync(sub, { recursive: true })
    gitRepo(sub)
    commit(sub, { 's.txt': 's\n' }, 'sub')
    sh(proj, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'sub')
    sh(proj, 'commit', '-q', '-m', 'add sub')
  })

  for (const [name, change] of [
    ['an edited file', () => writeFileSync(join(proj, 'sub', 's.txt'), 'edited inside\n')],
    ['an untracked file', () => writeFileSync(join(proj, 'sub', 'untracked.txt'), 'u\n')]
  ] as const)
    it(`${name} inside: not in the start's warning, Commit and Set Aside refused by name, nothing done`, async () => {
      change()
      writeFileSync(join(proj, 'a.txt'), 'edit\n')
      expect(status().split('\n').map((l) => l.trim()).sort()).toEqual(['M a.txt', 'M sub'])
      const now = await worktreeNow(proj)
      if (isUnknown(now)) throw new Error('unknown')
      expect(now.insideOnly).toEqual(['sub'])
      expect(now.dirty).toContain('sub') // still work held in the folder, for whatever else asks whether it's clean
      expect(await listed()).toEqual(['a.txt'])
      const before = [head(), status(), sh(proj, 'stash', 'list')]
      for (const shown of [['sub'], ['a.txt', 'sub']])
        for (const action of ['commit', 'setAside'] as const) await expect(settle(action, shown)).rejects.toThrow(/^sub is a submodule whose changes are inside it/)
      expect([head(), status(), sh(proj, 'stash', 'list')]).toEqual(before)
      // Only the inside changes: alone, there is nothing to warn about.
      sh(proj, 'checkout', '--', 'a.txt')
      expect(await listed()).toBeUndefined()
    })

  it('its new commit is listed and committed as usual', async () => {
    writeFileSync(join(proj, 'sub', 's.txt'), 'edited inside\n')
    sh(join(proj, 'sub'), 'commit', '-q', '-am', 'inside')
    const now = await worktreeNow(proj)
    if (isUnknown(now)) throw new Error('unknown')
    expect(now.insideOnly).toBeUndefined()
    expect(await listed()).toEqual(['sub'])
    await settle('commit', ['sub'])
    expect(committed()).toEqual(['sub'])
    expect(status()).toBe('')
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
