// Initialise repository (#701): a project folder becomes a git repository on main with a first commit, against real
// git. .combwork is excluded before anything is staged, so it is never in the first commit, and a .gitignore that brings it
// back stops the run before anything is staged; the identity is asked for when git has none and saved to that
// repository's config only, never the global one; a starter .gitignore never replaces the folder's own; a folder inside
// another repository needs the user's say, and one another version control system keeps is refused. Each test makes its
// own folders, so any one runs alone or in any order.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitignoreText, initAbout, initProblem } from '../src/shared/gitInit'
import { tempDir } from './tempDir'

/** The project folders the mocked workspace knows. */
let projects: string[] = []
const refresh = vi.fn(async () => ({}))

vi.mock('../src/main/workspace', () => ({
  workspace: {
    assertProject: (p: string) => {
      if (!projects.some((x) => x.toLowerCase() === p.toLowerCase())) throw new Error(`Not a project in the open workspace: ${p}`)
      return p
    }
  },
  workspaceOf: () => ({ refresh })
}))
// gitRepo's own neighbours (its one-at-a-time queue is used): nothing of them runs here.
vi.mock('../src/main/sessions', () => ({ sessions: {} }))
vi.mock('../src/main/mergeSlotHost', () => ({ mergeSlots: {} }))
vi.mock('../src/main/branchWatch', () => ({ checkProject: async () => undefined }))

const { initCheck, initRepo } = await import('../src/main/gitInit')
const { HiveError, shownError } = await import('../src/main/hiveError')
const { setLanguage } = await import('../src/shared/i18n')
const { shownText } = await import('../src/shared/advanced')

// Real git work, not a wait: each test runs a dozen git commands, slow under a full unit run's load.
vi.setConfig({ testTimeout: 60_000 })

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
/** Git's answer, or null when it fails (an unset config key, no commit yet). */
const gitOr = (cwd: string, ...a: string[]): string | null => {
  try {
    return git(cwd, ...a)
  } catch {
    return null
  }
}
const committed = (cwd: string): string[] => git(cwd, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean)

let base = ''
/** A new project folder (in the workspace) with .combwork and its sessions file in it, and these files. */
function project(name: string, files: Record<string, string> = {}, under = base): string {
  const dir = join(under, name)
  mkdirSync(join(dir, '.combwork'), { recursive: true })
  writeFileSync(join(dir, '.combwork', 'sessions.json'), '{}\n')
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  projects.push(dir)
  return dir
}

const savedGlobal = process.env.GIT_CONFIG_GLOBAL
const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM

beforeEach(() => {
  base = tempDir('hive-gitinit-')
  projects = []
  refresh.mockClear()
  // No identity in the system config either, whatever this machine's has.
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterEach(() => {
  process.env.GIT_CONFIG_GLOBAL = savedGlobal
  if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem
})

/** A global config of this test's own with an identity in it (the unit tests' default has none). */
function globalIdentity(): string {
  const file = join(base, 'global.gitconfig')
  writeFileSync(file, '[user]\n\tname = Global Person\n\temail = global@example.com\n')
  process.env.GIT_CONFIG_GLOBAL = file
  return file
}

describe('initialising', () => {
  it('makes an empty folder a repository on main with an empty first commit, .combwork kept out of it, and refreshes', async () => {
    globalIdentity()
    const p = project('empty')
    const check = await initCheck(p)
    expect(check).toMatchObject({ refused: null, empty: true, hasGitignore: false, identity: { name: 'Global Person', email: 'global@example.com' } })
    expect(check.parentRepo).toBeUndefined()
    const said = await initRepo(p, { gitignore: 'none' })
    expect(said).toBe('Initialised a git repository on main and made an empty first commit. .combwork stays out of git. Agents can work in worktrees now.')
    expect(git(p, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(committed(p)).toEqual([])
    expect(git(p, 'log', '--format=%s|%an|%ae')).toBe('Initial commit|Global Person|global@example.com')
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.combwork\/$/m)
    // .combwork is ignored, not just untracked: git status doesn't list it.
    expect(git(p, 'status', '--porcelain', '--untracked-files=all')).toBe('')
    // The global identity was used, not copied into the repository.
    expect(gitOr(p, 'config', '--local', 'user.name')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('commits the folder with a starter .gitignore, never .combwork nor what the template ignores, and keeps Hive skill copies out', async () => {
    globalIdentity()
    const p = project('node-app', { 'package.json': '{}\n', 'src/index.js': 'x\n', 'node_modules/a/index.js': 'y\n', 'debug.log': 'z\n', '.agents/skills/hive-handover/SKILL.md': 'copy\n' })
    expect((await initCheck(p)).empty).toBe(false)
    const said = await initRepo(p, { gitignore: 'node' })
    expect(said).toBe('Initialised a git repository on main, added a Node .gitignore, and committed 3 files. .combwork stays out of git. Agents can work in worktrees now.')
    expect(committed(p).sort()).toEqual(['.gitignore', 'package.json', 'src/index.js'])
    expect(readFileSync(join(p, '.gitignore'), 'utf8')).toBe(gitignoreText('node'))
    expect(gitignoreText('node')).not.toMatch(/\.combwork/)
  })

  it('keeps the folder\'s own .gitignore, whatever starter one was chosen', async () => {
    globalIdentity()
    const p = project('own', { '.gitignore': 'secret.txt\n', 'a.txt': 'a\n', 'secret.txt': 's\n' })
    const check = await initCheck(p)
    expect(check.hasGitignore).toBe(true)
    expect(initAbout('own', check)).toMatch(/Its own \.gitignore is kept/)
    await initRepo(p, { gitignore: 'python' })
    expect(readFileSync(join(p, '.gitignore'), 'utf8')).toBe('secret.txt\n')
    expect(committed(p).sort()).toEqual(['.gitignore', 'a.txt'])
  })

  it('excludes .combwork before anything is staged: a .gitignore that brings it back stops it with nothing committed, saying so', async () => {
    globalIdentity()
    const p = project('unignored', { '.gitignore': '!/.combwork/\n', 'a.txt': 'a\n' })
    await expect(initRepo(p, { gitignore: 'none' })).rejects.toThrow(/^Initialised a git repository on main, but git still doesn't ignore \.combwork here .*nothing was committed/)
    // The exclude line is there, and nothing was staged or committed.
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.combwork\/$/m)
    expect(gitOr(p, 'rev-parse', '--verify', '-q', 'HEAD')).toBeNull()
    expect(git(p, 'diff', '--cached', '--name-only')).toBe('')
  })
})

describe('the commit identity', () => {
  it('asks for a missing name and email, and saves them to this repository only, never the global config', async () => {
    const globalFile = process.env.GIT_CONFIG_GLOBAL
    const p = project('noid', { 'a.txt': 'a\n' })
    const check = await initCheck(p)
    expect(check.identity).toEqual({})
    expect(initProblem(check, { name: '', email: '' })).toBe('Enter the name your commits are made as')
    expect(initProblem(check, { name: 'Me', email: '' })).toBe('Enter the email your commits are made as')
    expect(initProblem(check, { name: 'Me', email: 'not-an-email' })).toBe("That isn't an email address")
    expect(initProblem(check, { name: 'Me', email: 'me@example.com' })).toBeNull()
    // Refused in main too, before git init: nothing made.
    await expect(initRepo(p, { gitignore: 'none' })).rejects.toThrow(/no name/)
    expect(existsSync(join(p, '.git'))).toBe(false)
    const said = await initRepo(p, { gitignore: 'minimal', name: 'Me', email: 'me@example.com' })
    expect(said).toMatch(/^Initialised a git repository on main, set this repository's commit identity, added a minimal \.gitignore, and committed 2 files\./)
    expect(git(p, 'config', '--local', 'user.name')).toBe('Me')
    expect(git(p, 'config', '--local', 'user.email')).toBe('me@example.com')
    expect(git(p, 'log', '--format=%an <%ae>')).toBe('Me <me@example.com>')
    // The global config is untouched: still the unit tests' empty one.
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(globalFile)
    expect(gitOr(p, 'config', '--global', 'user.name')).toBeNull()
  })

  it('asks only for the part git lacks, and leaves the part it has to the global config', async () => {
    const file = join(base, 'global.gitconfig')
    writeFileSync(file, '[user]\n\tname = Global Person\n')
    process.env.GIT_CONFIG_GLOBAL = file
    const p = project('halfid')
    const check = await initCheck(p)
    expect(check.identity).toEqual({ name: 'Global Person' })
    expect(initProblem(check, { name: '', email: '' })).toBe('Enter the email your commits are made as')
    await initRepo(p, { gitignore: 'none', email: 'me@example.com' })
    expect(gitOr(p, 'config', '--local', 'user.name')).toBeNull()
    expect(git(p, 'config', '--local', 'user.email')).toBe('me@example.com')
    expect(readFileSync(file, 'utf8')).toBe('[user]\n\tname = Global Person\n')
  })

  it("finds an identity the global config includes from another file, and asks for none", async () => {
    const idFile = join(base, 'identity.gitconfig')
    writeFileSync(idFile, '[user]\n\tname = Included Person\n\temail = included@example.com\n')
    const file = join(base, 'global.gitconfig')
    writeFileSync(file, `[include]\n\tpath = ${idFile.replace(/\\/g, '/')}\n`)
    process.env.GIT_CONFIG_GLOBAL = file
    const p = project('included', { 'a.txt': 'a\n' })
    const check = await initCheck(p)
    expect(check.identity).toEqual({ name: 'Included Person', email: 'included@example.com' })
    expect(check.conditionalIdentity).toBeUndefined()
    expect(initProblem(check, { name: '', email: '' })).toBeNull()
    expect(await initRepo(p, { gitignore: 'none' })).not.toMatch(/commit identity/)
    expect(git(p, 'log', '--format=%an <%ae>')).toBe('Included Person <included@example.com>')
    expect(gitOr(p, 'config', '--local', 'user.name')).toBeNull()
    expect(gitOr(p, 'config', '--local', 'user.email')).toBeNull()
  })

  it('with conditional includes, makes what is entered optional and uses it only where the new repository has no identity', async () => {
    const idFile = join(base, 'work.gitconfig')
    writeFileSync(idFile, '[user]\n\tname = Work Person\n\temail = work@example.com\n')
    const work = join(base, 'work')
    mkdirSync(work)
    const file = join(base, 'global.gitconfig')
    writeFileSync(file, `[includeIf "gitdir/i:${work.replace(/\\/g, '/')}/"]\n\tpath = ${idFile.replace(/\\/g, '/')}\n`)
    process.env.GIT_CONFIG_GLOBAL = file
    // Under the included folder: the include gives the new repository its identity, and what was entered isn't saved.
    const p = project('job', { 'a.txt': 'a\n' }, work)
    const check = await initCheck(p)
    expect(check).toMatchObject({ identity: {}, conditionalIdentity: true })
    expect(initProblem(check, { name: '', email: '' })).toBeNull()
    expect(await initRepo(p, { gitignore: 'none', name: 'Typed Person', email: 'typed@example.com' })).not.toMatch(/commit identity/)
    expect(git(p, 'log', '--format=%an <%ae>')).toBe('Work Person <work@example.com>')
    expect(gitOr(p, 'config', '--local', 'user.name')).toBeNull()
    // Elsewhere: what was entered is used, saved to the repository.
    const q = project('home', { 'b.txt': 'b\n' })
    await initRepo(q, { gitignore: 'none', name: 'Typed Person', email: 'typed@example.com' })
    expect(git(q, 'log', '--format=%an <%ae>')).toBe('Typed Person <typed@example.com>')
    expect(git(q, 'config', '--local', 'user.email')).toBe('typed@example.com')
    // Elsewhere with nothing entered: initialised, and it stops before committing, saying so.
    const r = project('bare', { 'c.txt': 'c\n' })
    await expect(initRepo(r, { gitignore: 'none' })).rejects.toThrow(/^Initialised a git repository on main, but git has no name or email to make the first commit as/)
    expect(gitOr(r, 'rev-parse', '--verify', '-q', 'HEAD')).toBeNull()
    expect(readFileSync(file, 'utf8')).toContain('includeIf')
  })

  it("never counts an identity that only an outer repository's conditional include gives, and takes the repository on from where it stopped", async () => {
    const outer = join(base, 'outer')
    mkdirSync(outer)
    execFileSync('git', ['init', '-q', '-b', 'main', outer])
    const idFile = join(base, 'outer.gitconfig')
    writeFileSync(idFile, '[user]\n\tname = Outer Person\n\temail = outer@example.com\n')
    const file = join(base, 'global.gitconfig')
    writeFileSync(file, `[includeIf "gitdir/i:${outer.replace(/\\/g, '/')}/.git"]\n\tpath = ${idFile.replace(/\\/g, '/')}\n`)
    process.env.GIT_CONFIG_GLOBAL = file
    const p = project('child', { 'a.txt': 'a\n' }, outer)
    // The outer repository's include doesn't count: it won't apply to the child's own repository.
    const check = await initCheck(p)
    expect(check).toMatchObject({ refused: null, parentRepo: outer, identity: {}, conditionalIdentity: true })
    // Nothing entered: the repository is made, and it stops before writing anything else, saying what to do.
    await expect(initRepo(p, { gitignore: 'minimal', nested: true })).rejects.toThrow("Initialised a git repository on main, but git has no name or email to make the first commit as here: enter them and choose Make first commit")
    expect(gitOr(p, 'rev-parse', '--verify', '-q', 'HEAD')).toBeNull()
    expect(existsSync(join(p, '.gitignore'))).toBe(false)
    expect(readFileSync(join(p, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\/\.combwork\/$/m)
    // Asked again, it goes on from there: the identity read from the repository itself, so both are needed now.
    const again = await initCheck(p)
    expect(again).toMatchObject({ refused: null, resume: true, identity: {} })
    expect(again.parentRepo).toBeUndefined()
    expect(again.conditionalIdentity).toBeUndefined()
    expect(initProblem(again, { name: '', email: '' })).toBe('Enter the name your commits are made as')
    expect(initAbout('child', again)).toMatch(/^child is a git repository with no commits yet/)
    const said = await initRepo(p, { gitignore: 'minimal', name: 'Child Person', email: 'child@example.com' })
    expect(said).toBe("Set this repository's commit identity, added a minimal .gitignore, and committed 2 files. .combwork stays out of git. Agents can work in worktrees now.")
    expect(git(p, 'log', '--format=%an <%ae>')).toBe('Child Person <child@example.com>')
    expect(committed(p).sort()).toEqual(['.gitignore', 'a.txt'])
    expect((await initCheck(p)).refused).toBe('This folder is a git repository already.')
  })

  it("makes the first commit in a repository made by hand with none yet, reading its identity from it", async () => {
    const p = project('byhand', { 'a.txt': 'a\n' })
    execFileSync('git', ['init', '-q', '-b', 'trunk', p])
    execFileSync('git', ['config', 'user.name', 'Hand Person'], { cwd: p })
    execFileSync('git', ['config', 'user.email', 'hand@example.com'], { cwd: p })
    const check = await initCheck(p)
    expect(check).toMatchObject({ refused: null, resume: true, identity: { name: 'Hand Person', email: 'hand@example.com' } })
    expect(await initRepo(p, { gitignore: 'none' })).toBe('Committed 1 file. .combwork stays out of git. Agents can work in worktrees now.')
    expect(git(p, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk')
    expect(committed(p)).toEqual(['a.txt'])
  })
})

describe('the guards', () => {
  it('needs the user\'s say for a folder inside another repository, naming it', async () => {
    globalIdentity()
    const outer = join(base, 'outer')
    mkdirSync(outer)
    execFileSync('git', ['init', '-q', '-b', 'main', outer])
    const p = project('inner', { 'a.txt': 'a\n' }, outer)
    const check = await initCheck(p)
    expect(check).toMatchObject({ refused: null, parentRepo: outer })
    expect(initAbout('inner', check)).toContain(`inside the git repository in ${outer}`)
    await expect(initRepo(p, { gitignore: 'none' })).rejects.toThrow(`inside the git repository in ${outer}`)
    expect(existsSync(join(p, '.git'))).toBe(false)
    await initRepo(p, { gitignore: 'none', nested: true })
    expect(git(p, 'rev-parse', '--show-toplevel').replace(/\//g, '\\').toLowerCase()).toBe(p.toLowerCase())
    expect(committed(p)).toEqual(['a.txt'])
  })

  it('refuses a folder another version control system keeps, and one that is a repository already', async () => {
    globalIdentity()
    const hg = project('hg', { '.hg/requires': 'store\n', 'a.txt': 'a\n' })
    const check = await initCheck(hg)
    expect(check.refused).toMatch(/^Mercurial keeps this folder/)
    await expect(initRepo(hg, { gitignore: 'none', nested: true })).rejects.toThrow(/^Mercurial keeps this folder/)
    expect(existsSync(join(hg, '.git'))).toBe(false)
    // Below a Jujutsu working copy's root too.
    const jjRoot = join(base, 'jj')
    mkdirSync(join(jjRoot, '.jj'), { recursive: true })
    const jj = project('sub', {}, jjRoot)
    expect((await initCheck(jj)).refused).toMatch(/^Jujutsu keeps this folder/)
    // A colocated Jujutsu repository (.jj beside .git) above it: refused, not taken for a git one to nest in, even confirmed.
    const colo = join(base, 'colocated')
    mkdirSync(join(colo, '.jj'), { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', colo])
    const inner = project('inner', { 'file.txt': 'f\n' }, colo)
    const coloCheck = await initCheck(inner)
    expect(coloCheck.refused).toBe(`Jujutsu keeps this folder (in ${colo}): Combwork makes a git repository only where no other version control system is.`)
    expect(coloCheck.parentRepo).toBeUndefined()
    await expect(initRepo(inner, { gitignore: 'none', nested: true })).rejects.toThrow(/^Jujutsu keeps this folder/)
    expect(existsSync(join(inner, '.git'))).toBe(false)
    const p = project('done')
    await initRepo(p, { gitignore: 'none' })
    expect((await initCheck(p)).refused).toBe('This folder is a git repository already.')
    await expect(initRepo(p, { gitignore: 'none' })).rejects.toThrow('This folder is a git repository already.')
  })

  it('takes only a project of the workspace, and only a starter .gitignore it knows', async () => {
    const stray = join(base, 'stray')
    mkdirSync(stray)
    await expect(initCheck(stray)).rejects.toThrow(/Not a project/)
    await expect(initRepo(stray, { gitignore: 'none' })).rejects.toThrow(/Not a project/)
    const p = project('p')
    await expect(initRepo(p, { gitignore: 'cobol' as never })).rejects.toThrow("There's no starter .gitignore cobol.")
    expect(existsSync(join(p, '.git'))).toBe(false)
  })
})

const DE = join(__dirname, '..', 'locales', 'de')

describe("its refusals (#881): English in the log, the window's language in the dialog", () => {
  const german = (): Record<string, string> => Object.assign({}, ...readdirSync(DE).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DE, f), 'utf8'))))
  afterEach(() => setLanguage('en', {}))

  it('a run that stops part way is a HiveError: its message English, shown in German, the steps capitalised in both', async () => {
    globalIdentity()
    const p = project('unignored-de', { '.gitignore': '!/.combwork/\n', 'a.txt': 'a\n' })
    setLanguage('de', german())
    const e = await initRepo(p, { gitignore: 'none' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(HiveError)
    expect((e as Error).message).toMatch(/^Initialised a git repository on main, but git still doesn't ignore \.combwork here/)
    expect(shownError(e)).toMatch(/^Ein Git-Repository auf main initialisiert, aber git ignoriert \.combwork hier noch immer nicht/)
  })

  it('a failure after the starter .gitignore: its name is text too, so the English stays English and the window follows a language change', async () => {
    globalIdentity()
    // A repository with no commit yet (taken on from there), whose pre-commit hook refuses the first commit.
    const p = project('late-de', { 'a.txt': 'a\n' })
    git(p, 'init', '-q', '-b', 'main')
    writeFileSync(join(p, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    setLanguage('de', german())
    const e = await initRepo(p, { gitignore: 'node' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(HiveError)
    expect((e as Error).message).toMatch(/^Added a Node \.gitignore, but couldn't make the first commit: /)
    expect(shownError(e)).toMatch(/^Eine \.gitignore für Node hinzugefügt, aber der erste Commit konnte nicht erstellt werden: /)
    setLanguage('en', {})
    expect(shownError(e)).toBe((e as Error).message)
  })

  it("the check's refusal: English in refused, its text shown in the language; initRepo refuses with it", async () => {
    globalIdentity()
    const p = project('already-de', { 'a.txt': 'a\n' })
    await initRepo(p, { gitignore: 'none' })
    setLanguage('de', german())
    const check = await initCheck(p)
    expect(check.refused).toBe('This folder is a git repository already.')
    expect(shownText(check.refusedText!)).toBe('Dieser Ordner ist schon ein Git-Repository.')
    const e = await initRepo(p, { gitignore: 'none' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(HiveError)
    expect((e as Error).message).toBe('This folder is a git repository already.')
    expect(shownError(e)).toBe('Dieser Ordner ist schon ein Git-Repository.')
  })

  it('an identity the dialog would refuse too', async () => {
    const p = project('identity-de')
    setLanguage('de', german())
    const e = await initRepo(p, { gitignore: 'none', name: 'Two\nlines' }).catch((x: unknown) => x)
    expect((e as Error).message).toBe('A name is one line, without < or >')
    expect(shownError(e)).toBe('Ein Name ist eine Zeile, ohne < oder >')
  })
})
