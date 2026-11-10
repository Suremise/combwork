// Submodules and Git LFS in the folders Combwork makes (HI-1182, src/main/platform/gitModules.ts): with real git and,
// where installed, real git-lfs (skipped, and said, when missing). Each fixture is one HR2 asked for in the design
// (HI-1182/s10–s16): the shared .git/config, the main checkout and its .git/modules left byte for byte as they were; a URL
// override used and kept; two worktrees at different gitlinks prepared at once; active=false and update=none over empty
// folders (nothing run in the superproject); a stray repository at a submodule's path left untouched; a failed clone
// then a retry; nested submodules; a copy's removed last submodule removed by its literal path, an unrelated nested
// repository a glob of it would match kept; junctions never followed; relative URLs resolved as git resolves them; LFS
// pointers filled by the step alone, its objects in the common dir; git-lfs missing a clear failure.
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
import { composeConfigEnv, forgetGitLfsVersion, gitFilesNeeded, gitFilesUse, insidePath, prepareGitFiles, resolveSubmoduleUrl, type GitFilesExec } from '../src/main/platform/gitModules'
import { gitFilesExec } from '../src/main/platform/gitModulesRun'

const req = createRequire(import.meta.url)
const { baseEnv } = req('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }

const root = tempDir('cw-gitmodules-')
const globalConfig = join(root, 'gitconfig')
/** The environment every git here gets: no system config, a global config of the test's own (identity, line endings). */
const ENV: Record<string, string> = { ...baseEnv(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
/** The test's own permission for local (file) submodule URLs, given as a run's environment would carry it: Combwork's entries go before it. */
const FILE_OK = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' }

const lfsInstalled = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { env: ENV, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

beforeAll(() => {
  writeFileSync(globalConfig, '[user]\n\tname = Combwork Test\n\temail = test@example.invalid\n[core]\n\tautocrlf = false\n[init]\n\tdefaultBranch = main\n')
})
afterEach(() => forgetGitLfsVersion())

/** git in `cwd` with the test's environment (and the file protocol allowed, for making fixtures). */
function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(dir: string, files: Record<string, string>): void {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), c)
  }
}
function repo(name: string, files: Record<string, string> = { 'a.txt': `${name}\n` }): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  put(dir, files)
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', name)
  return dir
}
function commitAll(dir: string, message: string, files: Record<string, string> = {}): string {
  put(dir, files)
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', message)
  return g(dir, 'rev-parse', 'HEAD')
}
let n = 0
/** A linked worktree of `project`, detached at `at`, as Combwork's create makes one (LFS smudge skipped). */
function worktree(project: string, at = 'HEAD'): string {
  const dir = join(root, `wt-${++n}`)
  execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, at], { cwd: project, env: { ...ENV, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: 'pipe' })
  return dir
}

/** The run's exec, with the test's environment and the file protocol allowed through GIT_CONFIG_COUNT (composed after Combwork's). */
function exec(o: { log?: string[]; extraEnv?: Record<string, string>; deny?: (args: string[]) => boolean; seen?: { cwd: string; args: string[]; env?: Record<string, string> }[] } = {}): GitFilesExec & { close(): void } {
  const lines = o.log ?? []
  const x = gitFilesExec({ spawn, env: { ...ENV, ...FILE_OK, ...o.extraEnv }, log: { write: (c) => lines.push(c.toString('utf8')) }, timeoutMs: 120_000 })
  return {
    ...x,
    git: async (cwd, args, opt) => {
      o.seen?.push({ cwd, args, ...(opt?.env ? { env: opt.env } : {}) })
      if (o.deny?.(args)) return { ok: false, code: 1, out: '', err: "git: 'lfs' is not a git command." }
      return x.git(cwd, args, opt)
    }
  }
}

/** Files and config of a repository's git dir that must not change, read whole. */
function snapshot(project: string): Record<string, string> {
  const gitDir = join(project, '.git')
  const out: Record<string, string> = { config: readFileSync(join(gitDir, 'config'), 'utf8'), status: g(project, 'submodule', 'status') }
  const modules = join(gitDir, 'modules')
  out.modules = existsSync(modules) ? readdirSync(modules, { recursive: true }).map(String).sort().join('\n') : '(none)'
  out.refs = g(project, 'for-each-ref')
  out.files = readdirSync(project).sort().join('\n')
  return out
}

describe('composeConfigEnv', () => {
  it("puts Combwork's entries first and the run's own after them, renumbered, so theirs still win", () => {
    const env = composeConfigEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always', git_config_key_1: 'submodule.a.url', GIT_CONFIG_VALUE_1: 'mine' }, [
      ['submodule.active', '.'],
      ['submodule.a.url', 'ours']
    ])
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'submodule.active',
      GIT_CONFIG_VALUE_0: '.',
      GIT_CONFIG_KEY_1: 'submodule.a.url',
      GIT_CONFIG_VALUE_1: 'ours',
      GIT_CONFIG_KEY_2: 'protocol.file.allow',
      GIT_CONFIG_VALUE_2: 'always',
      GIT_CONFIG_KEY_3: 'submodule.a.url',
      GIT_CONFIG_VALUE_3: 'mine'
    })
    expect(composeConfigEnv({}, [['submodule.active', '.']])).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'submodule.active', GIT_CONFIG_VALUE_0: '.' })
  })
})

describe('insidePath', () => {
  it('takes only folders strictly inside: never empty, ., absolute, a drive, .. or an empty component', () => {
    const r = join(root, 'inside')
    expect(insidePath(r, 'lib/x')).toBe(join(r, 'lib', 'x'))
    expect(insidePath(r, 'lib[x]')).toBe(join(r, 'lib[x]'))
    for (const bad of ['', '.', '/', '..', '../x', 'a/../../x', 'a//b', 'C:/x', 'C:x', join(root, 'x')]) expect(insidePath(r, bad), bad).toBeNull()
  })
})

describe('resolveSubmoduleUrl, checked against what git submodule init writes', () => {
  /** What `git submodule init` writes for `url` in a superproject whose origin is `remote` (none: no origin). */
  function gitSays(url: string, remote: string | null): string {
    const dir = join(root, `oracle-${++n}`)
    mkdirSync(dir)
    g(dir, 'init', '-q')
    if (remote !== null) g(dir, 'remote', 'add', 'origin', remote)
    writeFileSync(join(dir, '.gitmodules'), `[submodule "s"]\n\tpath = s\n\turl = ${url}\n`)
    g(dir, 'add', '.gitmodules')
    // A gitlink for init to find (any commit id will do: init doesn't fetch).
    g(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},s`)
    g(dir, 'submodule', 'init')
    return g(dir, 'config', '--get', 'submodule.s.url')
  }
  const cases: [string, string][] = [
    ['../lib.git', 'https://example.com/org/app.git'],
    ['./lib.git', 'https://example.com/org/app.git'],
    ['../../other/lib', 'https://example.com/org/app'],
    ['../lib.git', 'https://example.com/org/app/'],
    ['../lib.git', 'git@example.com:org/app.git'],
    ['../../lib.git', 'git@example.com:org/app.git'],
    ['../lib.git', 'ssh://git@example.com/org/app.git'],
    ['../lib', 'C:/work/app'],
    ['../lib', 'C:\\work\\app'],
    ['../lib', '//server/share/app'],
    ['https://example.com/abs.git', 'https://example.com/org/app.git'],
    ['C:/abs/lib', 'https://example.com/org/app.git']
  ]
  it.each(cases)('%s against %s', (url, remote) => {
    expect(resolveSubmoduleUrl(url, remote)).toBe(gitSays(url, remote))
  })
  it("refuses what git would refuse or write relative: past a URL's host, a relative remote, no base", () => {
    expect(resolveSubmoduleUrl('../../../x.git', 'git@example.com:app.git')).toBeNull()
    expect(resolveSubmoduleUrl('../lib', '../app')).toBeNull()
    expect(resolveSubmoduleUrl('../lib', 'app')).toBeNull()
    expect(resolveSubmoduleUrl('../lib', '')).toBeNull()
  })
})

describe('a project with neither', () => {
  it('needs nothing, and the step runs no git that changes anything', async () => {
    const p = repo('plain')
    const wt = worktree(p)
    const x = exec()
    expect(await gitFilesNeeded(x, wt, false)).toBe(false)
    expect(await gitFilesNeeded(x, wt, true)).toBe(false)
    const seen: { cwd: string; args: string[] }[] = []
    expect(await prepareGitFiles(exec({ seen }), { folder: wt, project: p, disposable: true })).toEqual({ ok: true, ran: false })
    expect(seen.map((s) => s.args[0])).toEqual(['ls-files', 'rev-parse'])
  })
  it("an unreadable folder is an error, never 'unused'", async () => {
    const r = await gitFilesNeeded(exec(), join(root, 'not-a-repo-at-all'), false)
    expect(r).toEqual({ error: expect.stringContaining("couldn't tell whether submodules or Git LFS are used") })
  })
})

describe('submodules in a linked worktree', () => {
  it('are checked out, nested ones too, with the shared config, .git/modules and the main checkout as they were', async () => {
    const nest = repo('nest-1', { 'n.txt': 'nested\n' })
    const sub = repo('sub-1', { 's.txt': 'sub\n' })
    g(sub, 'submodule', 'add', '-q', nest, 'nn')
    commitAll(sub, 'nn')
    const p = repo('proj-1')
    g(p, 'submodule', 'add', '-q', sub, 'libs/s')
    commitAll(p, 'sub')
    // The main checkout: its own clones made by the user, as a user's would be.
    const before = snapshot(p)
    const wt = worktree(p)
    expect(readdirSync(join(wt, 'libs', 's'))).toEqual([])
    const use = await gitFilesUse(exec(), wt)
    expect(use).toEqual({ submodules: [{ name: 'libs/s', path: 'libs/s', url: sub }], lfsFiles: 0 })
    const log: string[] = []
    const seen: { cwd: string; args: string[]; env?: Record<string, string> }[] = []
    const r = await prepareGitFiles(exec({ log, seen }), { folder: wt, project: p, disposable: false })
    expect(r, log.join('')).toEqual({ ok: true, ran: true })
    expect(readFileSync(join(wt, 'libs', 's', 's.txt'), 'utf8')).toBe('sub\n')
    expect(readFileSync(join(wt, 'libs', 's', 'nn', 'n.txt'), 'utf8')).toBe('nested\n')
    expect(snapshot(p)).toEqual(before)
    // Never sync, never a top-level --init, never foreach; the nested init only inside the submodule, fenced.
    const all = seen.map((s) => s.args.join(' '))
    expect(all.some((a) => /\bsync\b|foreach/.test(a))).toBe(false)
    const tops = seen.filter((s) => s.args[0] === 'submodule' && s.cwd === wt)
    expect(tops.map((s) => s.args)).toEqual([['submodule', 'update']])
    expect(tops[0].env?.GIT_CONFIG_KEY_0).toBe('submodule.active')
    const nested = seen.filter((s) => s.args[0] === 'submodule' && s.cwd !== wt)
    expect(nested.map((s) => [s.cwd, s.args])).toEqual([[join(wt, 'libs', 's'), ['submodule', 'update', '--init', '--recursive']]])
    expect(nested[0].env?.GIT_CEILING_DIRECTORIES).toBe(wt)
    // Its own clone, in this worktree's git dir.
    expect(existsSync(join(p, '.git', 'worktrees', 'wt-' + n, 'modules', 'libs', 's', 'HEAD'))).toBe(true)
    // A second run changes nothing and passes.
    expect(await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })).toEqual({ ok: true, ran: true })
  })

  it("use the repository's URL override as it is, and leave it there", async () => {
    const real = repo('sub-real', { 'which.txt': 'override\n' })
    const listed = repo('sub-listed', { 'which.txt': 'listed\n' })
    g(real, 'fetch', '-q', listed, 'main')
    // The override must have the gitlinked commit: it is a mirror of the listed one with a commit of its own beside.
    const p = repo('proj-2')
    g(p, 'submodule', 'add', '-q', listed, 's')
    commitAll(p, 'sub')
    rmSync(join(real), { recursive: true, force: true })
    g(root, 'clone', '-q', listed, real)
    g(p, 'config', 'submodule.s.url', real)
    rmSync(listed, { recursive: true, force: true })
    const before = snapshot(p)
    const wt = worktree(p)
    const r = await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })
    expect(r).toEqual({ ok: true, ran: true })
    expect(g(join(wt, 's'), 'remote', 'get-url', 'origin')).toBe(real)
    expect(snapshot(p)).toEqual(before)
  })

  it('two worktrees at different gitlinks, prepared at once, each keep their own', async () => {
    const sub = repo('sub-3', { 'v.txt': '1\n' })
    const p = repo('proj-3')
    g(p, 'submodule', 'add', '-q', sub, 's')
    const one = commitAll(p, 'sub at 1')
    commitAll(sub, 'two', { 'v.txt': '2\n' })
    g(join(p, 's'), 'pull', '-q', 'origin', 'main')
    const two = commitAll(p, 'sub at 2')
    const before = snapshot(p)
    const a = worktree(p, one)
    const b = worktree(p, two)
    const [ra, rb] = await Promise.all([prepareGitFiles(exec(), { folder: a, project: p, disposable: false }), prepareGitFiles(exec(), { folder: b, project: p, disposable: false })])
    expect([ra, rb]).toEqual([
      { ok: true, ran: true },
      { ok: true, ran: true }
    ])
    expect(readFileSync(join(a, 's', 'v.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(b, 's', 'v.txt'), 'utf8')).toBe('2\n')
    expect(snapshot(p)).toEqual(before)
  })

  it('leave active=false and update=none ones alone over their empty folders, running nothing in the superproject', async () => {
    const off = repo('sub-off')
    const none = repo('sub-none')
    const nestIn = repo('sub-none-nest')
    g(none, 'submodule', 'add', '-q', nestIn, 'deep')
    commitAll(none, 'deep')
    const p = repo('proj-4')
    g(p, 'submodule', 'add', '-q', off, 'off')
    g(p, 'submodule', 'add', '-q', none, 'none')
    commitAll(p, 'subs')
    g(p, 'config', 'submodule.off.active', 'false')
    g(p, 'config', 'submodule.none.update', 'none')
    const before = snapshot(p)
    const wt = worktree(p)
    const seen: { cwd: string; args: string[] }[] = []
    const log: string[] = []
    const r = await prepareGitFiles(exec({ seen, log }), { folder: wt, project: p, disposable: false })
    expect(r, log.join('')).toEqual({ ok: true, ran: true })
    expect(readdirSync(join(wt, 'off'))).toEqual([])
    expect(readdirSync(join(wt, 'none'))).toEqual([])
    expect(seen.filter((s) => s.args[0] === 'submodule' && s.cwd !== wt)).toEqual([])
    expect(snapshot(p)).toEqual(before)
  })

  it('stop before anything changes at a stray repository with its own commit and edit, which is left exactly as it was', async () => {
    const sub = repo('sub-5')
    const p = repo('proj-5')
    g(p, 'submodule', 'add', '-q', sub, 's')
    commitAll(p, 'sub')
    const before = snapshot(p)
    const wt = worktree(p)
    // Someone's own repository where the submodule goes: a commit, a staged and a modified file.
    const stray = join(wt, 's')
    g(stray, 'init', '-q', '-b', 'main')
    put(stray, { 'mine.txt': 'mine\n' })
    g(stray, 'add', '-A')
    g(stray, 'commit', '-q', '-m', 'mine')
    put(stray, { 'mine.txt': 'edited\n', 'staged.txt': 'staged\n' })
    g(stray, 'add', 'staged.txt')
    const look = (): string[] => [g(stray, 'rev-parse', 'HEAD'), g(stray, 'status', '--porcelain'), readFileSync(join(stray, '.git', 'config'), 'utf8'), readFileSync(join(stray, 'mine.txt'), 'utf8'), readFileSync(join(stray, '.git', 'index')).toString('base64')]
    const was = look()
    const seen: { cwd: string; args: string[] }[] = []
    const r = await prepareGitFiles(exec({ seen }), { folder: wt, project: p, disposable: true })
    expect(r).toEqual({ ok: false, error: "submodule s: s holds files or a repository Combwork didn't set up. Move it away, or turn off Set up submodules and LFS" })
    expect(seen.some((s) => s.args[0] === 'submodule' || s.args[0] === 'clean')).toBe(false)
    expect(look()).toEqual(was)
    expect(snapshot(p)).toEqual(before)
  })

  it('a folder with files and no repository, or a junction, is never touched either', async () => {
    const sub = repo('sub-6')
    const p = repo('proj-6')
    g(p, 'submodule', 'add', '-q', sub, 's')
    commitAll(p, 'sub')
    const wt = worktree(p)
    put(wt, { 's/loose.txt': 'loose\n' })
    expect(await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })).toMatchObject({ ok: false, error: expect.stringContaining('holds files or a repository') })
    rmSync(join(wt, 's'), { recursive: true, force: true })
    const elsewhere = join(root, 'junction-target-6')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(wt, 's'), 'junction')
    expect(await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })).toMatchObject({ ok: false, error: expect.stringContaining('holds files or a repository') })
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('a clone that fails fails the step with git’s words, and the next run, once it can, finishes it', async () => {
    const p = repo('proj-7')
    const sub = repo('sub-7')
    g(p, 'submodule', 'add', '-q', sub, 's')
    commitAll(p, 'sub')
    const moved = join(root, 'sub-7-moved')
    execFileSync('cmd', ['/c', 'move', sub, moved], { stdio: 'pipe' })
    const wt = worktree(p)
    const r = await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^git submodule update: /) })
    execFileSync('cmd', ['/c', 'move', moved, sub], { stdio: 'pipe' })
    expect(await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })).toEqual({ ok: true, ran: true })
    expect(existsSync(join(wt, 's', 'a.txt'))).toBe(true)
  })

  it('a relative URL is resolved against origin, as the project folder would be', async () => {
    const parent = join(root, 'rel-8')
    mkdirSync(parent)
    const sub = join(parent, 'lib.git')
    g(root, 'clone', '-q', '--bare', repo('sub-8'), sub)
    const origin = join(parent, 'app.git')
    const p = repo('proj-8')
    g(p, 'submodule', 'add', '-q', sub, 's')
    g(p, 'config', '-f', '.gitmodules', 'submodule.s.url', '../lib.git')
    g(p, 'add', '.gitmodules')
    commitAll(p, 'relative')
    g(root, 'clone', '-q', '--bare', p, origin)
    g(p, 'remote', 'add', 'origin', origin)
    g(p, 'config', '--unset', 'submodule.s.url')
    const wt = worktree(p)
    expect(await prepareGitFiles(exec(), { folder: wt, project: p, disposable: false })).toEqual({ ok: true, ran: true })
    expect(existsSync(join(wt, 's', 'a.txt'))).toBe(true)
  })
})

describe("a copy's removed submodules", () => {
  it('removes the folder of the last one, by its literal path, and keeps an unrelated nested repository a glob would match', async () => {
    const sub = repo('sub-9')
    const p = repo('proj-9')
    g(p, 'submodule', 'add', '-q', sub, 'lib[x]')
    const withSub = commitAll(p, 'sub')
    g(p, 'rm', '-q', 'lib[x]')
    g(p, 'rm', '-q', '-f', '.gitmodules')
    const without = commitAll(p, 'no subs')
    const copy = worktree(p, withSub)
    expect(await prepareGitFiles(exec(), { folder: copy, project: p, disposable: true })).toEqual({ ok: true, ran: true })
    expect(existsSync(join(copy, 'lib[x]', 'a.txt'))).toBe(true)
    // Someone else's nested repository at a name `lib[x]` would match as a glob.
    const other = join(copy, 'libx')
    g(copy, 'init', '-q', other)
    put(other, { 'keep.txt': 'keep\n' })
    // The copy reset to the revision without it, as resetTo does (clean -fd leaves nested repositories).
    g(copy, 'checkout', '-q', '--detach', '--force', without)
    g(copy, 'clean', '-fdq')
    expect(existsSync(join(copy, 'lib[x]', 'a.txt'))).toBe(true)
    expect(await gitFilesNeeded(exec(), copy, false)).toBe(false)
    expect(await gitFilesNeeded(exec(), copy, true)).toBe(true)
    const log: string[] = []
    expect(await prepareGitFiles(exec({ log }), { folder: copy, project: p, disposable: true })).toEqual({ ok: true, ran: true })
    expect(existsSync(join(copy, 'lib[x]'))).toBe(false)
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('keep\n')
    // Its clone stays, in the copy's own git dir.
    const gitDir = g(copy, 'rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'modules', 'lib[x]', 'HEAD'))).toBe(true)
    // A slot (not disposable) never removes it.
    const slot = worktree(p, withSub)
    await prepareGitFiles(exec(), { folder: slot, project: p, disposable: false })
    g(slot, 'checkout', '-q', '--detach', without)
    expect(await prepareGitFiles(exec(), { folder: slot, project: p, disposable: false })).toEqual({ ok: true, ran: false })
    expect(existsSync(join(slot, 'lib[x]', 'a.txt'))).toBe(true)
  })

  it('never follows a junction left where the removed submodule was', async () => {
    const sub = repo('sub-10')
    const p = repo('proj-10')
    g(p, 'submodule', 'add', '-q', sub, 's')
    const withSub = commitAll(p, 'sub')
    g(p, 'rm', '-q', 's')
    g(p, 'rm', '-q', '-f', '.gitmodules')
    const without = commitAll(p, 'none')
    const copy = worktree(p, withSub)
    await prepareGitFiles(exec(), { folder: copy, project: p, disposable: true })
    g(copy, 'checkout', '-q', '--detach', '--force', without)
    rmSync(join(copy, 's'), { recursive: true, force: true })
    const target = join(root, 'junction-target-10')
    mkdirSync(target)
    put(target, { 'precious.txt': 'precious\n' })
    symlinkSync(target, join(copy, 's'), 'junction')
    expect(await prepareGitFiles(exec(), { folder: copy, project: p, disposable: true })).toEqual({ ok: true, ran: true })
    expect(readFileSync(join(target, 'precious.txt'), 'utf8')).toBe('precious\n')
  })
})

describe.skipIf(!lfsInstalled)('Git LFS (git-lfs installed)', () => {
  /** A project cloned from a bare origin holding one LFS file in a nested .gitattributes. */
  function lfsProject(name: string, o: { filter?: boolean } = {}): { project: string; content: string } {
    const work = join(root, `${name}-work`)
    mkdirSync(work)
    g(work, 'init', '-q', '-b', 'main')
    g(work, 'lfs', 'install', '--local')
    const content = `${'x'.repeat(2000)}\n`
    put(work, { 'd/.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'd/f.bin': content })
    commitAll(work, 'lfs')
    const origin = join(root, `${name}.git`)
    g(root, 'init', '-q', '--bare', origin)
    // git-lfs reaches a local store only by a file:// URL.
    const url = `file:///${origin.split('\\').join('/')}`
    g(work, 'push', '-q', url, 'main')
    const project = join(root, name)
    execFileSync('git', ['clone', '-q', url, project], { env: { ...ENV, GIT_LFS_SKIP_SMUDGE: '1' }, stdio: 'pipe' })
    // Its filter as `git lfs install` sets it up (here in the repository's own config, so no other test sees it).
    if (o.filter !== false) g(project, 'lfs', 'install', '--local')
    return { project, content }
  }

  it("fills pointer files by the step alone, nested .gitattributes counted, objects in the common dir, config as it was", async () => {
    const { project, content } = lfsProject('lfs-1')
    const wt = worktree(project)
    expect(readFileSync(join(wt, 'd', 'f.bin'), 'utf8')).toMatch(/^version https:\/\/git-lfs/)
    expect(await gitFilesUse(exec(), wt)).toEqual({ submodules: [], lfsFiles: 1 })
    const cfg = readFileSync(join(project, '.git', 'config'), 'utf8')
    const log: string[] = []
    expect(await prepareGitFiles(exec({ log }), { folder: wt, project, disposable: false }), log.join('')).toEqual({ ok: true, ran: true })
    expect(readFileSync(join(wt, 'd', 'f.bin'), 'utf8')).toBe(content)
    expect(readdirSync(join(project, '.git', 'lfs', 'objects')).length).toBeGreaterThan(0)
    expect(readFileSync(join(project, '.git', 'config'), 'utf8')).toBe(cfg)
    expect(g(wt, 'status', '--porcelain')).toBe('')
  })

  it("a submodule's LFS files are smudged as the user's own filter config says (none: they stay pointers, as documented)", async () => {
    // The submodule's repository holds the LFS file; its store is its origin, reached by a file:// URL.
    const { project: lfsRepo, content } = lfsProject('lfs-sub')
    const origin = g(lfsRepo, 'remote', 'get-url', 'origin')
    const p = repo('proj-lfs-sub')
    g(p, 'submodule', 'add', '-q', origin, 's')
    commitAll(p, 'sub with lfs')
    // The user's global config, with and without `git lfs install`'s filter (a config file of each test's own).
    const withFilter = join(root, 'gitconfig-lfs')
    writeFileSync(withFilter, readFileSync(globalConfig, 'utf8'))
    execFileSync('git', ['lfs', 'install', '--skip-repo'], { env: { ...ENV, GIT_CONFIG_GLOBAL: withFilter }, stdio: 'pipe' })
    const a = worktree(p)
    expect(await prepareGitFiles(exec({ extraEnv: { GIT_CONFIG_GLOBAL: withFilter } }), { folder: a, project: p, disposable: false })).toEqual({ ok: true, ran: true })
    expect(readFileSync(join(a, 's', 'd', 'f.bin'), 'utf8')).toBe(content)
    const b = worktree(p)
    expect(await prepareGitFiles(exec(), { folder: b, project: p, disposable: false })).toEqual({ ok: true, ran: true })
    expect(readFileSync(join(b, 's', 'd', 'f.bin'), 'utf8')).toMatch(/^version https:\/\/git-lfs/)
  })

  it("git-lfs missing is a clear failure, never pointer files handed over as ready", async () => {
    const { project } = lfsProject('lfs-2')
    const wt = worktree(project)
    const r = await prepareGitFiles(exec({ deny: (a) => a[0] === 'lfs' }), { folder: wt, project, disposable: false })
    expect(r).toEqual({ ok: false, error: "Git LFS is used, but git-lfs isn't installed" })
  })

  it("with no LFS filter set up (git lfs install never run), a clear failure: git lfs pull would leave the pointers and exit 0", async () => {
    const { project } = lfsProject('lfs-3', { filter: false })
    const wt = worktree(project)
    expect(await prepareGitFiles(exec(), { folder: wt, project, disposable: false })).toEqual({ ok: false, error: "Git LFS is used, but it isn't set up for this repository: run git lfs install" })
    expect(readFileSync(join(wt, 'd', 'f.bin'), 'utf8')).toMatch(/^version https:\/\/git-lfs/)
  })
})

it.skipIf(lfsInstalled)('Git LFS: skipped here, git-lfs is not installed on this machine', () => undefined)
