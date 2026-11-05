// Keeping a project's .combwork out of version control (#345): git's info/exclude of the repository holding the project
// (its own, a worktree's common one, or one above it), other systems and sync services named, and the notice's text.
import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'module'

// Git as these tests run it (#369): the run context's allowlisted environment, so a shell's GIT_DIR, GIT_WORK_TREE or
// NODE_OPTIONS never points their own git at another repository. Main's git helper runs git with this process's
// environment, so the shell's GIT_* variables and Node's injection settings (NODE_OPTIONS, NODE_PATH: a git child can
// start Node, in a hook) are kept out of it while they run, and put back after (round 1 of #369 missed NODE_OPTIONS).
const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
const gitEnv = baseEnv()
const shellGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^GIT_/i.test(k) || /^NODE_(OPTIONS|PATH)$/i.test(k)))
for (const k of Object.keys(shellGit)) delete process.env[k]
afterAll(() => Object.assign(process.env, shellGit))

/** Makes a git command fail as git would (exit 128) while set (#364: a failed read is never "nothing tracked"). */
let failing: ((args: string[]) => boolean) | null = null
vi.mock('../src/main/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/git')>()
  const failed = (): ReturnType<typeof real.git> => Promise.resolve({ out: '', ok: false, buf: Buffer.alloc(0), err: 'fatal: injected failure', code: 128 })
  return {
    ...real,
    git: ((cwd, args, ...rest) => (failing?.(args) ? failed() : real.git(cwd, args, ...rest))) as typeof real.git,
    gitReading: ((cwd, args) => (failing?.(args) ? failed() : real.gitReading(cwd, args))) as typeof real.gitReading
  }
})
const { ensureCombworkExcluded, excludeLine, hasExcludeLine, combworkVcs, literalPattern, syncServiceOf, trackedCombworkFiles, untrackCombwork, vcsOf } = await import('../src/main/combworkVcs')
afterEach(() => {
  failing = null
})
import { combworkVcsKey, combworkVcsText } from '../src/shared/combworkVcsText'
import { tempDir } from './tempDir'

const base = tempDir('hive-vcs-')
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const folder = (...parts: string[]): string => {
  const d = join(base, `case-${++n}`, ...parts)
  mkdirSync(d, { recursive: true })
  return d
}

describe("these tests' git children (#369)", () => {
  // What main's git helper's child sees: a git alias writes the variables it was given to a file. Run from a shell with
  // them set (the #369 decoy probe), this shows none reached it; in a plain run it is empty too.
  it("main's git helper starts git with none of the shell's GIT_* variables or NODE_OPTIONS / NODE_PATH", async () => {
    const { git } = await import('../src/main/git')
    const out = join(folder(), 'env.txt').replace(/\\/g, '/')
    const r = await git(base, ['-c', `alias.envdump=!printenv NODE_OPTIONS NODE_PATH GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE > "${out}"; true`, 'envdump'])
    expect(r.ok, r.err).toBe(true)
    expect(readFileSync(out, 'utf8').trim()).toBe('')
  })
})

describe('.combwork kept out of version control (#345)', () => {
  it("adds /.combwork/ to a project's own repository once, keeping what the file had", async () => {
    const p = folder('project')
    mkdirSync(join(p, '.git', 'info'), { recursive: true })
    writeFileSync(join(p, '.git', 'info', 'exclude'), '# mine\n*.log')
    // Not a repository git can read (a bare .git folder): the line is written, but git couldn't confirm it (#346).
    expect(await ensureCombworkExcluded(p)).toEqual({ excluded: true, root: p, added: true, unconfirmed: true })
    expect(await ensureCombworkExcluded(p)).toEqual({ excluded: true, root: p, added: false, unconfirmed: true })
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toBe('# mine\n*.log\n# Combwork project metadata (added by Combwork)\n/.combwork/\n')
    expect(await combworkVcs(p)).toEqual({ state: 'excluded' })
  })

  it('takes an entry Hive wrote before 1.1 as its own, adding nothing (HI-2575)', async () => {
    const p = folder('project')
    mkdirSync(join(p, '.git', 'info'), { recursive: true })
    const old = '# Hive project metadata (added by Hive)\n/.combwork/\n'
    writeFileSync(join(p, '.git', 'info', 'exclude'), old)
    expect((await ensureCombworkExcluded(p))?.added).toBe(false)
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toBe(old)
  })

  it('takes the unanchored line someone wrote, and makes info/ when git has none', async () => {
    const p = folder('project')
    mkdirSync(join(p, '.git'), { recursive: true })
    expect((await ensureCombworkExcluded(p))?.added).toBe(true)
    const q = folder('other')
    mkdirSync(join(q, '.git', 'info'), { recursive: true })
    writeFileSync(join(q, '.git', 'info', 'exclude'), '.combwork/\r\n')
    expect((await ensureCombworkExcluded(q))?.added).toBe(false)
  })

  it("a worktree's exclude is its repository's common one", async () => {
    const main = folder('main')
    const common = join(main, '.git')
    mkdirSync(join(common, 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(common, 'worktrees', 'wt', 'commondir'), '../..\n')
    const wt = folder('wt')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(common, 'worktrees', 'wt')}\n`)
    await ensureCombworkExcluded(wt)
    expect(readFileSync(join(common, 'info', 'exclude'), 'utf8')).toContain('/.combwork/')
  })

  it('a repository in a folder above (a workspace kept in git) gets the project\'s path, made later too', async () => {
    const ws = folder('ws')
    const p = join(ws, 'sub', 'project')
    mkdirSync(p, { recursive: true })
    // No repository of its own or the workspace's yet (whatever holds the test's temporary folder).
    expect(vcsOf(p)).toEqual(vcsOf(base))
    if (!vcsOf(base)) expect((await combworkVcs(p)).state).toBe('none')
    // git init in the workspace: the next check excludes it there.
    mkdirSync(join(ws, '.git'))
    expect(await combworkVcs(p)).toEqual({ state: 'excluded' })
    expect(readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')).toContain('\n/sub/project/.combwork/\n')
    expect(excludeLine(ws, p)).toBe('/sub/project/.combwork/')
    expect(hasExcludeLine('.combwork/', '/sub/project/.combwork/')).toBe(false)
  })

  it("a project whose name has git's pattern characters (project[1]) is excluded as git itself says, in a real repository", async () => {
    const ws = folder('ws')
    execFileSync('git', ['init', '-q'], { env: gitEnv, cwd: ws })
    const p = join(ws, 'project[1]')
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'secret.txt'), 'x')
    writeFileSync(join(p, 'code.txt'), 'x')
    expect(excludeLine(ws, p)).toBe('/project\\[1\\]/.combwork/')
    expect(await ensureCombworkExcluded(p)).toEqual({ excluded: true, root: ws, added: true })
    // Git agrees: nothing under .combwork is listed, the project's own file is.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { env: gitEnv, cwd: ws, encoding: 'utf8' })
    expect(status).toContain('project[1]/code.txt')
    expect(status).not.toContain('.combwork')
    expect(literalPattern('a*b?[c]')).toBe('a\\*b\\?\\[c\\]')
  })

  it("isn't reported excluded when a .gitignore rule brings .combwork back (git's answer, not the line Combwork wrote)", async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q'], { env: gitEnv, cwd: p })
    writeFileSync(join(p, '.gitignore'), '!/.combwork/\n')
    const r = await ensureCombworkExcluded(p)
    expect(r).toEqual({ excluded: false, root: p, added: true })
    expect(await combworkVcs(p)).toEqual({ state: 'not-excluded' })
    // The rule goes: excluded (the exclude file unchanged, so the minute's cached answer is asked again after it).
    writeFileSync(join(p, '.gitignore'), '')
    writeFileSync(join(p, '.git', 'info', 'exclude'), readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8') + '# touched\n')
    expect((await ensureCombworkExcluded(p))?.excluded).toBe(true)
  })

  it('names another version control system, the nearest one winning', async () => {
    const hg = folder('hg')
    mkdirSync(join(hg, '.hg'))
    expect(await combworkVcs(hg)).toEqual({ state: 'other-vcs', vcs: 'Mercurial' })
    // A git repository of its own inside an SVN working copy: git's.
    const svn = folder('svn')
    mkdirSync(join(svn, '.svn'))
    const inner = join(svn, 'project')
    mkdirSync(join(inner, '.git'), { recursive: true })
    expect(vcsOf(inner)).toEqual({ kind: 'git', root: inner })
    expect(vcsOf(join(svn))).toEqual({ kind: 'other', name: 'Subversion', root: svn })
  })

  it("knows a sync service's folder, not one that only starts with its name", () => {
    const roots: [string, string][] = [['C:\\Users\\me\\OneDrive', 'OneDrive'], ['D:\\Dropbox\\', 'Dropbox']]
    expect(syncServiceOf('C:\\Users\\me\\OneDrive\\code\\app', roots)).toBe('OneDrive')
    expect(syncServiceOf('c:/users/me/onedrive', roots)).toBe('OneDrive')
    expect(syncServiceOf('C:\\Users\\me\\OneDrive2\\app', roots)).toBeNull()
    expect(syncServiceOf('D:\\Dropbox\\app', roots)).toBe('Dropbox')
    expect(syncServiceOf('D:\\Code\\app', roots)).toBeNull()
  })

  it('says why, and offers Exclude only where Combwork can', () => {
    expect(combworkVcsText({ state: 'excluded' })).toBeNull()
    expect(combworkVcsText(undefined)).toBeNull()
    expect(combworkVcsText({ state: 'none' })).toMatchObject({ title: ".combwork isn't excluded from version control", canExclude: false })
    expect(combworkVcsText({ state: 'not-excluded' })?.canExclude).toBe(true)
    expect(combworkVcsText({ state: 'other-vcs', vcs: 'Mercurial' })?.detail).toContain('Mercurial working copy')
    expect(combworkVcsText({ state: 'excluded', sync: 'OneDrive' })).toMatchObject({ title: '.combwork is synced by OneDrive', canExclude: false })
    expect(combworkVcsText({ state: 'none', sync: 'Dropbox' })?.detail).toContain('Dropbox copies the project folder')
    // A dismissed notice shows again when the situation changes.
    expect(combworkVcsKey({ state: 'none' })).not.toBe(combworkVcsKey({ state: 'none', sync: 'OneDrive' }))
  })
})

describe('.combwork committed before it was excluded (#364)', () => {
  const git = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { env: gitEnv, cwd, encoding: 'utf8' })

  it('says how many files git still tracks, and stops once they are untracked', async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q', '-b', 'main', p], { env: gitEnv })
    mkdirSync(join(p, '.combwork', 'sessions'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), '{}')
    writeFileSync(join(p, '.combwork', 'sessions', 's.jsonl'), 'x')
    writeFileSync(join(p, 'a.txt'), 'a')
    // Committed with add -A before Combwork excluded it.
    git(p, 'add', '-A')
    git(p, 'commit', '-qm', 'everything')
    const v = await combworkVcs(p)
    expect(v).toEqual({ state: 'excluded', tracked: 2 })
    const text = combworkVcsText(v)!
    expect(text).toMatchObject({ title: '2 files in .combwork are committed to git', canUntrack: true, canExclude: false })
    expect(text.detail).toContain('git rm -r --cached .combwork')
    expect(await trackedCombworkFiles(p, p)).toEqual(['.combwork/project.json', '.combwork/sessions/s.jsonl'])
    expect(await untrackCombwork(p, ['.combwork/project.json', '.combwork/sessions/s.jsonl'])).toBe(2)
    expect(await combworkVcs(p)).toEqual({ state: 'excluded' })
    // On disk still, and staged for removal: the user commits it.
    expect(readFileSync(join(p, '.combwork', 'project.json'), 'utf8')).toBe('{}')
    expect(git(p, 'status', '--porcelain')).toMatch(/^D  \.combwork\/project\.json$/m)
  })

  it("asks git again once the index changes: the user's own git rm --cached clears it", async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q', '-b', 'main', p], { env: gitEnv })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'project.json'), '{}')
    git(p, 'add', '-A')
    git(p, 'commit', '-qm', 'hive')
    expect((await combworkVcs(p)).tracked).toBe(1)
    git(p, 'rm', '-r', '--cached', '-q', '.combwork')
    expect((await combworkVcs(p)).tracked).toBeUndefined()
  })

  it("counts only the project's own .combwork in a repository above it, not the workspace's", async () => {
    const ws = folder('ws')
    const p = join(ws, 'project')
    execFileSync('git', ['init', '-q', '-b', 'main', ws], { env: gitEnv })
    mkdirSync(join(ws, '.combwork'), { recursive: true })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(ws, '.combwork', 'workspace.json'), '{}')
    writeFileSync(join(p, '.combwork', 'project.json'), '{}')
    git(ws, 'add', '-A')
    git(ws, 'commit', '-qm', 'workspace')
    expect(await trackedCombworkFiles(p, ws)).toEqual(['.combwork/project.json'])
    expect((await combworkVcs(p)).tracked).toBe(1)
  })

  it('a failed read says nothing, and is asked again: the warning comes back once git answers, the index unchanged', async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q', '-b', 'main', p], { env: gitEnv })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'old.txt'), 'old')
    git(p, 'add', '-A')
    git(p, 'commit', '-qm', 'hive')
    failing = (args) => args.includes('ls-files')
    expect(await trackedCombworkFiles(p, p)).toBeNull()
    expect((await combworkVcs(p)).tracked).toBeUndefined()
    failing = null
    expect(await trackedCombworkFiles(p, p)).toEqual(['.combwork/old.txt'])
    expect((await combworkVcs(p)).tracked).toBe(1)
  })

  it('untracks only the files confirmed: one staged meanwhile refuses it, and nothing changes', async () => {
    const p = folder('project')
    execFileSync('git', ['init', '-q', '-b', 'main', p], { env: gitEnv })
    mkdirSync(join(p, '.combwork'), { recursive: true })
    writeFileSync(join(p, '.combwork', 'old.txt'), 'old')
    writeFileSync(join(p, '.combwork', '[x].txt'), 'a pattern for a name')
    git(p, 'add', '-A')
    git(p, 'commit', '-qm', 'hive')
    const shown = (await trackedCombworkFiles(p, p, { fresh: true }))!
    expect(shown.sort()).toEqual(['.combwork/[x].txt', '.combwork/old.txt'])
    writeFileSync(join(p, '.combwork', 'new.txt'), 'new')
    git(p, 'add', '-f', '.combwork/new.txt')
    await expect(untrackCombwork(p, shown)).rejects.toThrow(/changed since you were shown them: nothing was untracked/)
    expect(git(p, 'ls-files', '--', '.combwork').split(/\r?\n/).filter(Boolean).sort()).toEqual(['.combwork/[x].txt', '.combwork/new.txt', '.combwork/old.txt'])
    // Shown again, as it is now: each path literally ([x] is a name, not a pattern), and only those.
    git(p, 'rm', '--cached', '-q', '.combwork/new.txt')
    expect(await untrackCombwork(p, shown)).toBe(2)
    expect(git(p, 'ls-files', '--', '.combwork')).toBe('')
  })

  it('nothing to say outside a repository, or with nothing tracked', async () => {
    expect(combworkVcsText({ state: 'excluded' })).toBeNull()
    expect(combworkVcsKey({ state: 'excluded', tracked: 2 })).not.toBe(combworkVcsKey({ state: 'excluded' }))
    expect(combworkVcsText({ state: 'not-excluded', tracked: 1 })).toMatchObject({ title: '1 file in .combwork is committed to git', canExclude: true, canUntrack: true })
  })
})
