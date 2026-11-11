// A folder's uncommitted changes, committed or set aside (HI-2944, port 5's folderChanges): only the paths shown, in the
// folder the target is checked out in (found by Combwork, never given), everything checked again under the lock and the
// fence; a stale or empty list refused with nothing done; another staged file kept staged; an untracked file, a rename
// and a deletion; a refusing hook losing nothing; a stash told by its object, kept and named when git fails after making
// it; the caller's guard, an operation under way, a busy folder; Files' Commit it committing .gitignore alone. Real git
// in throwaway repositories.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { commit, gitRepo, sh } from './workflow/harness'
import type { GitResult } from '../src/main/git'

/** The next stash's git: run for real, then answered as failed (a failure after git made the stash). */
let failStashAfter = false
/** A folder whose `rev-parse --show-toplevel` fails (HI-2962): `empty`, answered ok with nothing. */
let failTopIn: { folder: string; empty?: boolean } | null = null
vi.mock('../src/main/git', async (original) => {
  const real = await original<typeof import('../src/main/git')>()
  return {
    ...real,
    git: async (cwd: string, args: string[], max?: number, input?: string, opts?: Parameters<typeof real.git>[4]): Promise<GitResult> => {
      if (failTopIn && args[0] === 'rev-parse' && args.includes('--show-toplevel') && resolve(cwd).toLowerCase() === resolve(failTopIn.folder).toLowerCase())
        return failTopIn.empty ? { ok: true, code: 0, out: '', err: '', buf: Buffer.alloc(0) } : { ok: false, code: 128, out: '', err: 'fatal: unable to read the repository', buf: Buffer.alloc(0) }
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
    for (const fail of [{ folder: join(proj, 'other') }, { folder: join(proj, 'other'), empty: true }]) {
      failTopIn = fail
      await expect(inRepoWorkspace(() => changes.commitIgnore(nested))).rejects.toThrow(/Git could not read the folder's changes/)
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
