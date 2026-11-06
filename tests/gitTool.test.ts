// Git itself missing, too old or failing (#346): never read as "not a repository", and never as merged, clean or
// nothing to lose. Git is hidden from this test process's own PATH (never the machine's), which every git call Combwork
// makes inherits.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { delimiter, dirname, join, win32 } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { GIT_MIN, compareGitVersions, gitFixText, gitOldText, gitProblemText, gitStateOf, gitUnusable, parseGitVersion } from '../src/shared/gitTool'
import { checkGit, gitExe, gitOnPath, gitProblem, gitTool, realGit, realGitBehind, setGitToolForTests } from '../src/main/gitTool'
import { git, gitStatus } from '../src/main/git'
import { withLauncherEnv } from '../src/main/gitWorker'
import { branchStatus, createWorktree, removeCheckedWorktree, worktreeCheck } from '../src/main/worktrees'
import { ensureCombworkExcluded } from '../src/main/combworkVcs'
import { tempDir, tempRoot } from './tempDir'

const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const PATH = process.env.PATH
let root = ''

afterEach(() => {
  process.env.PATH = PATH
  setGitToolForTests({ state: 'unknown' })
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** This process's PATH without the folders holding git (node stays). */
function hideGit(): void {
  process.env.PATH = (PATH ?? '')
    .split(delimiter)
    .filter((d) => d && !gitOnPath({ PATH: d }))
    .join(delimiter)
}

/** A repository on main with one worktree, `cw/wt`, merged and clean (removable while git runs). */
async function project(): Promise<{ p: string; wt: { path: string; branch: string; base: string } }> {
  root = tempDir('cw-gittool-')
  const p = join(root, 'project')
  run(root, 'init', '-q', '-b', 'main', p)
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) run(p, 'config', k, v)
  writeFileSync(join(p, 'a.txt'), 'a\n')
  run(p, 'add', '-A')
  run(p, 'commit', '-qm', 'base')
  const wt = { path: join(root, 'wt'), branch: 'cw/wt', base: 'main' }
  await createWorktree(p, wt.path, wt.branch, 'main')
  return { p, wt }
}

describe('git versions', () => {
  it('reads the version git gives, Git for Windows suffix and all', () => {
    expect(parseGitVersion('git version 2.45.1.windows.1\n')).toBe('2.45.1')
    expect(parseGitVersion('git version 2.38.0')).toBe('2.38.0')
    expect(parseGitVersion('something else')).toBeNull()
    expect(compareGitVersions('2.9.0', '2.38')).toBeLessThan(0)
    expect(compareGitVersions('2.38.0', GIT_MIN)).toBe(0)
  })

  it('below 2.38 is old; below 2.17 nothing of Combwork runs, so it is a problem like a missing git', () => {
    expect(gitStateOf('2.45.1')).toBe('ok')
    expect(gitStateOf('2.37.9')).toBe('old')
    expect(gitUnusable({ state: 'old', version: '2.30.0' })).toBe(false)
    expect(gitUnusable({ state: 'old', version: '2.16.0' })).toBe(true)
    expect(gitUnusable({ state: 'missing' })).toBe(true)
    expect(gitUnusable({ state: 'ok', version: '2.45.0' })).toBe(false)
    expect(gitProblemText({ state: 'missing' })).toBe("Git isn't installed (or isn't on Combwork's PATH)")
    expect(gitProblemText({ state: 'old', version: '2.16.0' })).toMatch(/too old/)
    expect(gitProblemText({ state: 'unknown' })).toBeNull()
    expect(gitFixText({ state: 'missing' })).toMatch(/Install Git for Windows/)
    expect(gitOldText('2.26.0')).toMatch(/keep the branches/)
    expect(gitOldText('2.37.0')).not.toMatch(/keep the branches/)
  })
})

describe('git found', () => {
  it('checks the version and where it is', async () => {
    const t = await checkGit()
    expect(t.state === 'ok' || t.state === 'old').toBe(true)
    expect(t.version).toMatch(/^\d+\.\d+/)
    expect(t.path).toMatch(/git\.(exe|com)$/i)
  })
})

describe('git missing', () => {
  it('is missing, not a failed command: no exit code 1 that reads as "no"', async () => {
    const { p } = await project()
    hideGit()
    const r = await git(p, ['check-ignore', '-q', '--no-index', '--', '.combwork/'])
    expect(r).toMatchObject({ ok: false, missing: true, code: -1 })
    expect(gitTool().state).toBe('missing')
    expect(gitProblem()).toBe("Git isn't installed (or isn't on Combwork's PATH)")
    expect((await checkGit()).state).toBe('missing')
  })

  it('a missing working folder is not a missing git', async () => {
    const r = await git(join(tempRoot(), 'cw-gittool-no-such-folder'), ['status'])
    expect(r.missing).toBeUndefined()
    expect(gitTool().state).not.toBe('missing')
  })

  it('the Changes tab hears git is missing, not that the folder is no repository', async () => {
    const { p } = await project()
    hideGit()
    expect(await gitStatus(p)).toMatchObject({ isRepo: false, gitProblem: "Git isn't installed (or isn't on Combwork's PATH)" })
  })

  it('never removable, never merged, never clean: the worktree and its branch stay', async () => {
    const { p, wt } = await project()
    const check = await worktreeCheck(p, wt)
    expect(check.removable).toBe(true)
    hideGit()
    expect(await worktreeCheck(p, wt)).toMatchObject({ removable: false, reason: "Git isn't installed (or isn't on Combwork's PATH)" })
    await expect(branchStatus(p, wt)).rejects.toThrow(/isn't installed/)
    // A check made while git ran, applied once it can't: nothing goes.
    expect((await removeCheckedWorktree(p, wt, check)).deleted).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
    process.env.PATH = PATH
    expect(run(p, 'branch', '--format=%(refname:short)')).toMatch(/cw\/wt/)
  })

  it('.combwork is still excluded by the line Combwork writes, marked unconfirmed', async () => {
    const { p } = await project()
    hideGit()
    expect(await ensureCombworkExcluded(p)).toMatchObject({ excluded: true, unconfirmed: true })
  })

  it('a git call that runs again clears it', async () => {
    const { p } = await project()
    hideGit()
    await git(p, ['status'])
    expect(gitTool().state).toBe('missing')
    process.env.PATH = PATH
    await git(p, ['status'])
    expect(gitTool().state).not.toBe('missing')
    expect(gitProblem()).toBeNull()
  })
})

describe('git failing', () => {
  it('a branch git cannot count is not "nothing to merge"', async () => {
    const { p, wt } = await project()
    await expect(branchStatus(p, { ...wt, branch: 'cw/gone' })).rejects.toThrow(/Git couldn't check cw\/gone/)
  })

  it('a worktree whose status fails is not clean, and not removable', async () => {
    const { p, wt } = await project()
    // A damaged index: git status fails there.
    writeFileSync(join(p, '.git', 'worktrees', 'wt', 'index'), 'not an index')
    await expect(branchStatus(p, wt)).rejects.toThrow(/Git couldn't check cw\/wt/)
    const c = await worktreeCheck(p, wt)
    expect(c.removable).toBe(false)
    expect(gitProblem()).toBeNull()
  })
})

// HI-2137: where PATH's git is Git for Windows' launcher (<root>\cmd\git.exe), Combwork starts the real git beneath it
// directly; anything else keeps PATH's git.
describe('the git Combwork starts', () => {
  /** A Git for Windows layout: its launcher, and its real git under `mingw` (empty files: only where they are counts). */
  const layouts: string[] = []
  afterEach(() => {
    for (const d of layouts.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function layout(mingw = 'mingw64'): { root: string; launcher: string; execPath: string; real: string } {
    const top = tempDir('cw-gitexe-')
    layouts.push(top)
    const launcher = join(top, 'cmd', 'git.exe')
    const execPath = join(top, mingw, 'libexec', 'git-core')
    for (const d of [dirname(launcher), execPath]) mkdirSync(d, { recursive: true })
    writeFileSync(launcher, '')
    writeFileSync(join(execPath, 'git.exe'), '')
    return { root: top, launcher, execPath, real: join(execPath, 'git.exe') }
  }
  /** git's own answers, as `run` gives them to realGit: by the git asked and its arguments; the calls, in order. */
  function answers(byExe: Record<string, Record<string, string | null>>): { run: (exe: string, args: string[]) => Promise<string | null>; calls: string[] } {
    const calls: string[] = []
    return { calls, run: async (exe, args) => (calls.push(`${exe} ${args.join(' ')}`), byExe[exe]?.[args.join(' ')] ?? null) }
  }
  const SAID = 'git version 2.51.0.windows.1\n'

  it("the launcher, its exec-path under its root and the same version: the real git, with the launcher's PATH folders", async () => {
    const g = layout()
    const { run: ask } = answers({ git: { '--exec-path': `${g.execPath.replace(/\\/g, '/')}\n` }, [g.real]: { '--version': SAID } })
    expect(await realGit(SAID, g.launcher, ask)).toEqual({ exe: g.real, launcherEnv: { pathFirst: [join(g.root, 'mingw64', 'bin'), join(g.root, 'usr', 'bin')].join(delimiter), msystem: 'MINGW64' } })
    // Git for Windows on ARM.
    const arm = layout('clangarm64')
    expect(realGitBehind(arm.launcher, arm.execPath)?.launcherEnv).toEqual({ pathFirst: [join(arm.root, 'clangarm64', 'bin'), join(arm.root, 'usr', 'bin')].join(delimiter), msystem: 'CLANGARM64' })
    // HI-2400: Git for Windows 2.56's UCRT64 build.
    const ucrt = layout('ucrt64')
    const { run: askUcrt } = answers({ git: { '--exec-path': `${ucrt.execPath.replace(/\\/g, '/')}\n` }, [ucrt.real]: { '--version': SAID } })
    expect(await realGit(SAID, ucrt.launcher, askUcrt)).toEqual({ exe: ucrt.real, launcherEnv: { pathFirst: [join(ucrt.root, 'ucrt64', 'bin'), join(ucrt.root, 'usr', 'bin')].join(delimiter), msystem: 'UCRT64' } })
  })

  it("the real git's environment is the launcher's (git-wrapper.c): its MSYSTEM, PLINK_PROTOCOL, HOME, and its folders and ~\\bin before PATH", () => {
    const l = { pathFirst: 'C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin', msystem: 'MINGW64' }
    const top = tempDir('cw-gitenv-')
    layouts.push(top)
    const roaming = join(top, 'roaming')
    const local = join(top, 'local')
    for (const d of [roaming, local]) mkdirSync(d)
    const drive = (p: string): { HOMEDRIVE: string; HOMEPATH: string } => ({ HOMEDRIVE: p.slice(0, 2), HOMEPATH: p.slice(2) })
    // Keys as Windows spelled them (a spread environment's): those keys, never a second one. An inherited MSYSTEM is
    // replaced by the launcher's own; HOME, unset, is HOMEDRIVE and HOMEPATH's folder (a roaming profile's), not USERPROFILE.
    expect(withLauncherEnv({ Path: 'C:\\Windows', Msystem: 'MSYS', ...drive(roaming), USERPROFILE: local }, l)).toEqual({ Path: `C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;${roaming}\\bin;C:\\Windows`, MSYSTEM: 'MINGW64', PLINK_PROTOCOL: 'ssh', HOME: roaming, ...drive(roaming), USERPROFILE: local })
    // HOMEDRIVE and HOMEPATH that aren't a folder, or are the system folder: USERPROFILE.
    expect(withLauncherEnv({ PATH: 'C:\\Windows', ...drive(join(top, 'gone')), USERPROFILE: local }, l)).toMatchObject({ HOME: local, PATH: `C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;${local}\\bin;C:\\Windows` })
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    expect(withLauncherEnv({ PATH: 'C:\\Windows', SystemRoot: process.env.SystemRoot, ...drive(system), USERPROFILE: local }, l)).toMatchObject({ HOME: local })
    // HOME and PLINK_PROTOCOL already set stay; no home at all: no ~\bin.
    expect(withLauncherEnv({ PATH: 'C:\\Windows', HOME: 'D:\\home', USERPROFILE: local, PLINK_PROTOCOL: 'plink' }, l)).toMatchObject({ PATH: 'C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin;D:\\home\\bin;C:\\Windows', HOME: 'D:\\home', PLINK_PROTOCOL: 'plink' })
    expect(withLauncherEnv({}, l)).toEqual({ PATH: 'C:\\Git\\mingw64\\bin;C:\\Git\\usr\\bin', MSYSTEM: 'MINGW64', PLINK_PROTOCOL: 'ssh' })
  })

  it('a different version from the real git (a mismatch, or it failed): PATH git', async () => {
    const g = layout()
    for (const said of ['git version 2.50.1.windows.1\n', null]) {
      const { run: ask } = answers({ git: { '--exec-path': g.execPath }, [g.real]: { '--version': said } })
      expect(await realGit(SAID, g.launcher, ask)).toEqual({ exe: 'git' })
    }
  })

  it('anything but the launcher itself: PATH git, with no exec-path asked', async () => {
    const g = layout()
    for (const onPath of [null, join(g.root, 'cmd', 'git.com'), join(g.root, 'bin', 'git.exe'), join(g.root, 'scoop', 'shims', 'git.exe'), g.real]) {
      const { run: ask, calls } = answers({ git: { '--exec-path': g.execPath }, [g.real]: { '--version': SAID } })
      expect(await realGit(SAID, onPath, ask)).toEqual({ exe: 'git' })
      expect(calls).toEqual([])
    }
  })

  it("the launcher with an exec-path elsewhere, or no real git there: PATH git", async () => {
    const g = layout()
    const other = layout()
    expect(realGitBehind(g.launcher, other.execPath)).toBeNull()
    expect(realGitBehind(g.launcher, join(g.root, 'usr', 'libexec', 'git-core'))).toBeNull()
    rmSync(g.real)
    expect(realGitBehind(g.launcher, g.execPath)).toBeNull()
    const { run: ask } = answers({ git: { '--exec-path': null } })
    expect(await realGit(SAID, other.launcher, ask)).toEqual({ exe: 'git' })
  })

  it('this machine: with the launcher first on PATH, Combwork starts the real git, and git runs', async () => {
    const execPath = run(process.cwd(), '--exec-path').trim()
    const launcher = join(dirname(dirname(dirname(win32.normalize(execPath)))), 'cmd', 'git.exe')
    if (!existsSync(launcher)) return // Not Git for Windows: nothing of this applies.
    process.env.PATH = `${dirname(launcher)}${delimiter}${PATH}`
    await checkGit()
    expect(gitExe().exe.toLowerCase()).toBe(join(win32.normalize(execPath), 'git.exe').toLowerCase())
    const { p } = await project()
    expect(await git(p, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatchObject({ ok: true, out: 'main\n' })
  })

  it('this machine: an alias through sh sees the same environment from the real git as through the launcher', async () => {
    const execPath = win32.normalize(run(process.cwd(), '--exec-path').trim())
    const launcher = join(dirname(dirname(dirname(execPath))), 'cmd', 'git.exe')
    const real = realGitBehind(launcher, execPath)
    if (!real?.launcherEnv) return // Not Git for Windows: nothing of this applies.
    const { p } = await project()
    const roaming = join(root, 'roaming')
    const local = join(root, 'local')
    for (const d of [roaming, local]) mkdirSync(d)
    // The run context's environment, with no global or system git config (as every unit test's git); no Git folder on
    // PATH, an inherited MSYSTEM that isn't the launcher's, a roaming home apart from USERPROFILE.
    const env: NodeJS.ProcessEnv = baseEnv()
    for (const k of Object.keys(env)) if (['PATH', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'MSYSTEM', 'PLINK_PROTOCOL'].includes(k.toUpperCase())) delete env[k]
    Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`, MSYSTEM: 'MSYS', HOMEDRIVE: roaming.slice(0, 2), HOMEPATH: roaming.slice(2), USERPROFILE: local })
    const said = (exe: string, e: NodeJS.ProcessEnv): string => execFileSync(exe, ['-c', 'alias.cwenv=!echo "$MSYSTEM|$HOME|$PLINK_PROTOCOL|$PATH"', 'cwenv'], { cwd: p, env: e, encoding: 'utf8', windowsHide: true })
    const through = said(launcher, env)
    // The launcher's own MSYSTEM (MINGW64, or UCRT64 on Git for Windows 2.56's UCRT64 build, HI-2400), not the inherited one.
    expect(through.startsWith(`${real.launcherEnv.msystem}|`)).toBe(true)
    expect(said(real.exe, withLauncherEnv(env, real.launcherEnv))).toBe(through)
  })

  it("a real git that can't start any more (uninstalled, moved): that git once more from PATH, and git checked again", async () => {
    const { p } = await project()
    const gone = join(root, 'gone', 'mingw64', 'libexec', 'git-core', 'git.exe')
    setGitToolForTests({ state: 'ok', version: '2.51.0' }, { exe: gone, launcherEnv: { pathFirst: join(root, 'gone', 'usr', 'bin'), msystem: 'MINGW64' } })
    expect(await git(p, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatchObject({ ok: true, out: 'main\n' })
    expect(gitExe().exe).not.toBe(gone)
    expect(gitTool().state).not.toBe('missing')
    expect((await checkGit()).state).not.toBe('missing')
    expect(gitExe().exe).not.toBe(gone)
  })

  it('several commands at once that find the real git gone: each runs once more from PATH, none says git is missing', async () => {
    const { p } = await project()
    const gone = join(root, 'gone', 'mingw64', 'libexec', 'git-core', 'git.exe')
    setGitToolForTests({ state: 'ok', version: '2.51.0' }, { exe: gone, launcherEnv: { pathFirst: join(root, 'gone', 'usr', 'bin'), msystem: 'MINGW64' } })
    const rs = await Promise.all(Array.from({ length: 4 }, () => git(p, ['rev-parse', '--abbrev-ref', 'HEAD'])))
    for (const r of rs) expect(r).toMatchObject({ ok: true, out: 'main\n' })
    expect(gitTool().state).not.toBe('missing')
    await checkGit()
    expect(gitExe().exe).not.toBe(gone)
  })
})
