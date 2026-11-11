// jj's Version Control views, its compatibility assessment and its fallback to Git, against the real jj Combwork is
// tested with (HI-2799, J6): a colocated repository with bookmarks, a divergent change, a conflicted commit and a
// conflicted bookmark, read through the production functions (platform/jjViews.ts, jjCompat.ts, storeSwitch's
// fallbackOf), each read pinned and never writing: the operation heads are the same before and after every view.
//
// Without the fetched jj (npm run jj:fetch) it is skipped, saying so; with CW_JJ_REAL=1 its absence fails.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { TESTED_JJ } from '../src/shared/jjTool'
import { createJjRunner } from '../src/main/platform/jjRunner'
import { jjContextOf } from '../src/main/platform/jjDetect'
import { readOpHeads } from '../src/main/platform/jjView'
import { jjBookmarks, jjCompare, jjConflicts, jjHistory, jjRepoView } from '../src/main/platform/jjViews'
import { assessJj } from '../src/main/platform/jjCompat'
import { isJjViewUnknown } from '../src/shared/jjViews'
import { PLATFORMS } from '../src/shared/platform/descriptors'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { portableJj } = require('./jjPortable.cjs') as { portableJj: () => string | null }
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const exe = portableJj()
if (!exe && process.env.CW_JJ_REAL === '1') throw new Error(`CW_JJ_REAL=1 but jj ${TESTED_JJ.version} isn't fetched: run npm run jj:fetch`)
if (!exe) console.warn(`jjViewsReal.test.ts skipped: jj ${TESTED_JJ.version} isn't fetched (npm run jj:fetch)`)

function isolated(): NodeJS.ProcessEnv {
  const home = tempDir('jjv-home-')
  const config = join(home, 'jj.toml')
  writeFileSync(config, '[user]\nname = "Combwork Test"\nemail = "test@example.invalid"\n[ui]\npaginate = "never"\n')
  return gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home, JJ_CONFIG: config, NO_COLOR: '1' })
}

describe.skipIf(!exe)('jj views, compatibility and fallback on the real jj (HI-2799)', () => {
  const env = isolated()
  const runner = createJjRunner({ exe: exe!, env })
  const jj = (cwd: string, ...args: string[]): string => execFileSync(exe!, args, { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  // The assessment's git: no system config or attributes, an empty global config (the machine's own would decide it).
  const cleanHome = tempDir('jjv-git-')
  writeFileSync(join(cleanHome, 'gitconfig'), '')
  const compatEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cleanHome, 'gitconfig'), XDG_CONFIG_HOME: cleanHome }
  const gitDeps = { git: async (cwd: string, args: string[]) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env: compatEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }
    } catch (e) {
      return { ok: false, out: '', err: String((e as { stderr?: string }).stderr ?? e) }
    }
  }, jj: runner }

  /** A colocated repository (or not, HI-2896): base, then main's commit, a bookmark main on it, and @ an empty child. */
  async function repo(name: string, colocated = true) {
    const parent = tempDir(`jjv-${name}-`)
    const root = join(parent, 'repo')
    mkdirSync(root)
    jj(root, 'git', 'init', colocated ? '--colocate' : '--no-colocate')
    writeFileSync(join(root, 'base.txt'), 'base\n')
    jj(root, 'commit', '-m', 'base')
    writeFileSync(join(root, 'a.txt'), 'one\n')
    jj(root, 'commit', '-m', 'main work')
    jj(root, 'bookmark', 'set', 'main', '-r', '@-')
    const real = resolve(realpathSync.native(root))
    const d = await jjContextOf(real, runner)
    if (!('jj' in d)) throw new Error(`not detected: ${JSON.stringify(d)}`)
    const id = (rev: string, t = 'commit_id'): string => jj(real, '--ignore-working-copy', 'log', '--no-graph', '-r', rev, '-T', t).trim()
    return { root: real, ctx: d.jj, id }
  }
  type Repo = Awaited<ReturnType<typeof repo>>
  /** Each view read changes nothing: the operation heads are the same after it. */
  async function noWrite<T>(r: Repo, read: () => Promise<T>): Promise<T> {
    const before = readOpHeads(r.ctx.jjRepo)
    const out = await read()
    expect(readOpHeads(r.ctx.jjRepo)).toEqual(before)
    return out
  }

  it('repository, history and bookmarks: change id beside commit id, the working copy, jj’s gates', async () => {
    const r = await repo('basic')
    const v = await noWrite(r, () => jjRepoView(r.root, runner))
    if (isJjViewUnknown(v)) throw new Error(JSON.stringify(v))
    expect(v).toMatchObject({ colocated: true, heads: 1, gates: PLATFORMS.jj.gates })
    expect(!isJjViewUnknown(v.workspaces) && v.workspaces.map((w) => w.name)).toEqual(['default'])
    const h = await noWrite(r, () => jjHistory(r.root, runner))
    if (isJjViewUnknown(h)) throw new Error(JSON.stringify(h))
    const main = h.rows.find((x) => x.bookmarks.includes('main'))!
    expect(main).toMatchObject({ commit: r.id('main'), change: r.id('main', 'change_id'), description: 'main work', conflict: false, divergent: false })
    expect(h.rows.find((x) => x.workingCopy)).toMatchObject({ empty: true })
    const b = await noWrite(r, () => jjBookmarks(r.root, runner))
    if (isJjViewUnknown(b)) throw new Error(JSON.stringify(b))
    expect(b.rows.find((x) => x.name === 'main' && x.remote === null)).toMatchObject({ commit: r.id('main'), conflict: false })
    expect(b.rows.find((x) => x.name === 'main' && x.remote === null)?.gitDiffers).toBeUndefined()
    // Git moves main behind jj's back: shown as not the same in Git, never resolved.
    git(r.root, 'branch', '-f', 'main', r.id('main-'))
    const b2 = await jjBookmarks(r.root, runner)
    expect(!isJjViewUnknown(b2) && b2.rows.find((x) => x.name === 'main' && x.remote === null)?.gitDiffers).toBe(true)
  })

  it('compare: one commit each side; a divergent change id and an ambiguous prefix list every commit, none picked', async () => {
    const r = await repo('compare')
    const c = await noWrite(r, () => jjCompare(r.root, 'main-', 'main', runner))
    if (isJjViewUnknown(c) || !('files' in c)) throw new Error(JSON.stringify(c))
    expect(c.files).toEqual([{ status: 'A', path: 'a.txt' }])
    expect(c.diff).toContain('+one')
    expect(await jjCompare(r.root, 'nosuchthing', 'main', runner)).toMatchObject({ from: { none: true } })
    // A divergent change: the same change described twice from one operation.
    const change = r.id('main', 'change_id')
    const base = r.id('main-')
    const op = readOpHeads(r.ctx.jjRepo)![0]
    const mainCommit = r.id('main')
    jj(r.root, '--ignore-working-copy', 'describe', '-r', mainCommit, '-m', 'v1')
    jj(r.root, '--at-op', op, 'describe', '-r', mainCommit, '-m', 'v2')
    // Two heads: every view says so and reads nothing.
    expect(await jjHistory(r.root, runner)).toMatchObject({ jjUnknown: 'heads' })
    jj(r.root, 'status')
    const d = await noWrite(r, () => jjCompare(r.root, base, change, runner))
    if (isJjViewUnknown(d) || 'files' in d) throw new Error(JSON.stringify(d))
    expect('ambiguous' in d.to && d.to.ambiguous.length).toBe(2)
    expect('ambiguous' in d.to && d.to.ambiguous.every((x) => x.divergent && x.change === change)).toBe(true)
    // Picking one by its commit id compares exactly it.
    const one = 'ambiguous' in d.to ? d.to.ambiguous[0].commit : ''
    const e = await jjCompare(r.root, base, one, runner)
    // The bookmark on both variants is conflicted: naming it lists its commits too.
    const byName = await jjCompare(r.root, base, 'main', runner)
    expect(!isJjViewUnknown(byName) && !('files' in byName) && 'ambiguous' in byName.to && byName.to.ambiguous.length).toBe(2)
    expect(!isJjViewUnknown(e) && 'files' in e && e.to.commit).toBe(one)
    const h = await jjHistory(r.root, runner)
    // Both variants show divergent, with the same change id and their own commit ids (the working copy rebased onto each may too).
    expect(!isJjViewUnknown(h) && h.rows.filter((x) => x.divergent && x.change === change).length).toBe(2)
  })

  it('conflicts: a conflicted commit and a conflicted bookmark shown as such', async () => {
    const r = await repo('conflicts')
    // Two sides editing a.txt, then a merge commit storing the conflict.
    jj(r.root, 'new', 'main', '-m', 'left')
    writeFileSync(join(r.root, 'a.txt'), 'left\n')
    jj(r.root, 'new', 'main', '-m', 'right')
    writeFileSync(join(r.root, 'a.txt'), 'right\n')
    jj(r.root, 'new', 'description(substring:"left")', 'description(substring:"right")', '-m', 'merge')
    jj(r.root, 'bookmark', 'set', 'merged', '-r', '@')
    const c = await noWrite(r, () => jjConflicts(r.root, runner))
    if (isJjViewUnknown(c)) throw new Error(JSON.stringify(c))
    expect(c.rows.length).toBeGreaterThan(0)
    expect(c.rows[0].row.conflict).toBe(true)
    expect(c.rows[0].files).toEqual(['a.txt'])
    // A bookmark set to two places from one operation: conflicted.
    const op = readOpHeads(r.ctx.jjRepo)![0]
    jj(r.root, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', 'description(substring:"left")', '--allow-backwards')
    jj(r.root, '--at-op', op, '--ignore-working-copy', 'bookmark', 'set', 'main', '-r', 'description(substring:"right")', '--allow-backwards')
    jj(r.root, 'status')
    const b = await jjBookmarks(r.root, runner)
    if (isJjViewUnknown(b)) throw new Error(JSON.stringify(b))
    expect(b.rows.find((x) => x.name === 'main' && x.remote === null)).toMatchObject({ conflict: true })
    expect(b.rows.find((x) => x.name === 'main' && x.remote === null)?.sides.length).toBe(2)
    // Back to Git is refused, naming the conflicted bookmark and the conflicted commits.
    const { fallbackOf } = await import('../src/main/workflow/storeSwitch')
    const f = await fallbackOf(r.root, runner)
    expect(f).toEqual(expect.arrayContaining([{ code: 'conflictedBookmark', name: 'main' }]))
    expect(f.some((x) => x.code === 'conflictedCommit')).toBe(true)
  })

  it('back to Git: ready when every bookmark is exported and nothing is conflicted; not when Git moved one', async () => {
    const r = await repo('fallback')
    const { fallbackOf } = await import('../src/main/workflow/storeSwitch')
    expect(await fallbackOf(r.root, runner)).toEqual([])
    git(r.root, 'branch', '-f', 'main', r.id('main-'))
    expect(await fallbackOf(r.root, runner)).toEqual([{ code: 'notExported', name: 'main' }])
  })

  it('a head appearing while jj confirms the repository is never merged: every entry point reads nothing (HR2 round 1)', async () => {
    const { pinnedContextOf } = await import('../src/main/platform/jjViews')
    const { fallbackOf } = await import('../src/main/workflow/storeSwitch')
    const entries: [string, (rn: typeof runner) => Promise<unknown>][] = [
      ['context', (rn) => pinnedContextOf(r0.root, rn)],
      ['repository', (rn) => jjRepoView(r0.root, rn)],
      ['history', (rn) => jjHistory(r0.root, rn)],
      ['bookmarks', (rn) => jjBookmarks(r0.root, rn)],
      ['conflicts', (rn) => jjConflicts(r0.root, rn)],
      ['compare', (rn) => jjCompare(r0.root, 'main-', 'main', rn)],
      ['fallback', (rn) => fallbackOf(r0.root, rn)]
    ]
    const r0 = await repo('race')
    for (const [name, read] of entries) {
      // Before each read: one head again (the user's own jj reconciles), then the race armed.
      jj(r0.root, 'status')
      expect(readOpHeads(r0.ctx.jjRepo)!.length).toBe(1)
      let raced = false
      // At jj's own `root` call, another writer makes a second operation from the same base.
      const racing = {
        ...runner,
        run: async (folder: string, args: readonly string[], o?: Parameters<typeof runner.run>[2]) => {
          if (!raced && args.includes('root')) {
            raced = true
            const op = readOpHeads(r0.ctx.jjRepo)![0]
            jj(r0.root, '--ignore-working-copy', 'bookmark', 'create', `${name}-one`, '-r', 'main')
            jj(r0.root, '--at-op', op, '--ignore-working-copy', 'bookmark', 'create', `${name}-two`, '-r', 'main')
          }
          return runner.run(folder, args, o)
        },
        readiness: () => runner.readiness(),
        readinessNow: () => runner.readinessNow(),
        problem: () => runner.problem(),
        shutdown: (ms?: number) => runner.shutdown(ms)
      }
      const out = await read(racing)
      expect(raced, name).toBe(true)
      // Nothing merged them: both heads are still there, and the read said it couldn't read.
      expect(readOpHeads(r0.ctx.jjRepo)!.length, name).toBe(2)
      expect(JSON.stringify(out), name).toMatch(/moved|heads/)
    }
  })

  it('an unreadable .jj (an empty pointer) is unknown before anything runs', async () => {
    const { pinnedContextOf } = await import('../src/main/platform/jjViews')
    const parent = tempDir('jjv-broken-')
    mkdirSync(join(parent, '.jj'), { recursive: true })
    writeFileSync(join(parent, '.jj', 'repo'), '')
    let ran = 0
    const counting = { ...runner, run: async (...a: Parameters<typeof runner.run>) => (ran++, runner.run(...a)), readiness: () => runner.readiness(), readinessNow: () => runner.readinessNow(), problem: () => runner.problem(), shutdown: (ms?: number) => runner.shutdown(ms) }
    expect(await pinnedContextOf(parent, counting)).toEqual({ jjUnknown: 'heads', detail: 'unreadable' })
    expect(await jjHistory(parent, counting)).toEqual({ jjUnknown: 'heads', detail: 'unreadable' })
    expect(ran).toBe(0)
  })

  it('compatibility: clear for a plain repository; each gate found where the repository uses it', async () => {
    const r = await repo('compat')
    const clear = await assessJj(r.root, r.ctx.store, gitDeps)
    expect(clear).toEqual({ attributes: { clear: true }, lfs: { clear: true }, submodules: { clear: true }, hooks: { clear: true }, signing: { clear: true } })
    writeFileSync(join(r.root, '.gitattributes'), '*.txt text eol=lf\n*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(r.root, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ../x\n')
    jj(r.root, 'commit', '-m', 'attributes')
    writeFileSync(join(r.ctx.store, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
    git(r.root, 'config', 'commit.gpgSign', 'true')
    const used = await assessJj(r.root, r.ctx.store, gitDeps)
    expect(used.attributes).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('eol=lf')]) })
    expect(used.lfs).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('filter=lfs')]) })
    expect(used.submodules).toMatchObject({ uses: ['.gitmodules'] })
    expect(used.hooks).toMatchObject({ uses: [expect.stringContaining('pre-commit')] })
    expect(used.signing).toMatchObject({ uses: ['commit.gpgsign (local)'] })
    // A config value Git applies: core.autocrlf in the repository's config is attributes' too.
    git(r.root, 'config', 'core.autocrlf', 'true')
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).attributes).toMatchObject({ uses: expect.arrayContaining(['core.autocrlf (local) = true']) })
    // Turned off at a later level: Git converts nothing, as jj does.
    git(r.root, 'config', 'core.autocrlf', 'false')
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).attributes).not.toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('core.autocrlf')]) })
    // Unreadable is "uses it": git itself failing.
    const broken = await assessJj(r.root, r.ctx.store, { ...gitDeps, git: async () => ({ ok: false, out: '', err: 'boom' }) })
    expect(broken.attributes).toMatchObject({ unknown: expect.stringContaining('boom') })
  })

  it('signing on as Git reads it (HI-2942): a nonzero number refuses, for either key; false stays clear; a value Git refuses fails closed', async () => {
    const r = await repo('numsign')
    const signing = async (): Promise<unknown> => (await assessJj(r.root, r.ctx.store, gitDeps)).signing
    git(r.root, 'config', 'commit.gpgsign', '2')
    expect(git(r.root, 'config', '--type=bool', '--get', 'commit.gpgsign')).toBe('true')
    expect(await signing()).toEqual({ uses: ['commit.gpgsign (local)'] })
    git(r.root, 'config', 'commit.gpgsign', '0')
    expect(await signing()).toEqual({ clear: true })
    git(r.root, 'config', 'tag.gpgsign', '0x10')
    expect(await signing()).toEqual({ uses: ['tag.gpgsign (local)'] })
    git(r.root, 'config', 'tag.gpgsign', 'off')
    expect(await signing()).toEqual({ clear: true })
    git(r.root, 'config', 'tag.gpgsign', 'maybe')
    expect(await signing()).toEqual({ uses: ['tag.gpgsign (local) = maybe'] })
  })

  it('hooks in the folder Git runs them from (HI-2941): core.hooksPath with ~/, relative or absolute; clear when it holds none', async () => {
    const r = await repo('hookspath')
    const clear = { clear: true }
    // The isolated home both git runs here expand ~ to.
    const home = env.HOME!
    const hook = (dir: string): void => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'pre-commit'), '#!/bin/sh\nexit 1\n')
    }
    // ~/ is the home Git expands it to, never a folder named ~ in the repository.
    git(r.root, 'config', 'core.hooksPath', '~/hooks-tilde')
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toEqual(clear)
    hook(join(home, 'hooks-tilde'))
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toMatchObject({ uses: [expect.stringContaining('pre-commit')] })
    // Git's answer, checked: the folder it names is the one found.
    expect(resolve(git(r.root, '-c', `core.hooksPath=~/hooks-tilde`, 'rev-parse', '--git-path', 'hooks'))).toBe(resolve(home, 'hooks-tilde'))
    // Relative: from the working tree's top, where Git runs hooks (a subfolder's run included).
    git(r.root, 'config', 'core.hooksPath', 'tools/hooks')
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toEqual(clear)
    hook(join(r.root, 'tools', 'hooks'))
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toMatchObject({ uses: [expect.stringContaining('pre-commit')] })
    // Absolute.
    const abs = join(tempDir('jjv-hooks-abs-'), 'h')
    git(r.root, 'config', 'core.hooksPath', abs.replace(/\\/g, '/'))
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toEqual(clear)
    hook(abs)
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toMatchObject({ uses: [expect.stringContaining('pre-commit')] })
    // Unset: the store's hooks, as before; Git unable to say is unknown, never clear.
    git(r.root, 'config', '--unset', 'core.hooksPath')
    expect((await assessJj(r.root, r.ctx.store, gitDeps)).hooks).toEqual(clear)
    const failing = { ...gitDeps, git: async (cwd: string, args: string[]) => (args[0] === 'rev-parse' ? { ok: false, out: '', err: 'boom' } : gitDeps.git(cwd, args)) }
    expect((await assessJj(r.root, r.ctx.store, failing)).hooks).toMatchObject({ unknown: expect.stringContaining('boom') })
  })

  it('not colocated (HI-2896): the views read through jj’s store; no bookmark is marked as differing from Git, exported or not', async () => {
    const r = await repo('sep', false)
    expect(r.ctx.colocated).toBe(false)
    const v = await noWrite(r, () => jjRepoView(r.root, runner))
    if (isJjViewUnknown(v)) throw new Error(JSON.stringify(v))
    expect(v).toMatchObject({ colocated: false, heads: 1 })
    const main = (): Promise<unknown> => jjBookmarks(r.root, runner).then((b) => (isJjViewUnknown(b) ? b : b.rows.find((x) => x.name === 'main' && x.remote === null)))
    expect(await noWrite(r, main)).toMatchObject({ commit: r.id('main') })
    expect(((await main()) as { gitDiffers?: true }).gitDiffers).toBeUndefined()
    // One manual export, then main moved: T@git is behind, which nobody sees without a Git working copy.
    jj(r.root, 'git', 'export')
    jj(r.root, 'bookmark', 'set', 'main', '-r', 'main-', '--allow-backwards')
    expect(((await main()) as { gitDiffers?: true }).gitDiffers).toBeUndefined()
    const h = await noWrite(r, () => jjHistory(r.root, runner))
    expect(!isJjViewUnknown(h) && h.rows.some((x) => x.bookmarks.includes('main'))).toBe(true)
  })

  it('not colocated (HI-2896): the assessment asks the store, never the folder (no .git there), and reads jj’s tracked files and the root’s own on disk', async () => {
    const r = await repo('sepcompat', false)
    const sep = { separate: { jjRepo: r.ctx.jjRepo } }
    expect(await assessJj(r.root, r.ctx.store, gitDeps, sep)).toEqual({ attributes: { clear: true }, lfs: { clear: true }, submodules: { clear: true }, hooks: { clear: true }, signing: { clear: true } })
    mkdirSync(join(r.root, 'deep'))
    writeFileSync(join(r.root, 'deep', '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    jj(r.root, 'commit', '-m', 'deep attributes')
    writeFileSync(join(r.ctx.store, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n')
    git(r.ctx.store, '--git-dir', r.ctx.store, 'config', 'commit.gpgSign', 'true')
    // The root's own .gitattributes, not recorded by jj yet (no jj command since): read from disk.
    writeFileSync(join(r.root, '.gitattributes'), '*.txt text eol=lf\n')
    const used = await assessJj(r.root, r.ctx.store, gitDeps, sep)
    expect(used.lfs).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('filter=lfs')]) })
    expect(used.attributes).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('eol=lf')]) })
    expect(used.hooks).toMatchObject({ uses: [expect.stringContaining('pre-commit')] })
    expect(used.signing).toMatchObject({ uses: ['commit.gpgsign (local)'] })
    // Without `separate` git would be asked in a folder with no .git: unknown, never clear.
    const asFolder = await assessJj(r.root, r.ctx.store, gitDeps)
    expect(asFolder.submodules).toMatchObject({ unknown: expect.any(String) })
  })
})
