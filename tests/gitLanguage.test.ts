// HI-3534: Combwork reads git's words in places (a dry run's list, "not a git repository", an error it recognises), and a
// git with its translations installed speaks the user's language (LANGUAGE, LC_ALL, LANG or Windows' own). Every git
// Combwork starts runs with LANGUAGE=en (gitEnv): here, a real git given a German catalogue speaks German when started as
// the user's environment has it, and English through git's runner, the merge queue's git, and what Combwork parses of it.
import { execFileSync, spawnSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { git, gitStatus } from '../src/main/git'
import { GIT_LANGUAGE, gitEnv } from '../src/main/gitWorker'
import { gitTree } from '../src/main/workflow/mergeQueue'
import { germanGit, withProcessEnv } from './gitCatalog'
import { tempDir } from './tempDir'
import { commit, gitRepo } from './workflow/harness'

// The run's allowlisted environment and test git config for every git child (never this process's environment).
const { gitEnv: runEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

const tmp = tempDir('cw-git-language-')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const german = germanGit(join(tmp, 'locale'))
const repo = join(tmp, 'repo')
gitRepo(repo)
commit(repo, { 'a.txt': 'a\n' }, 'first')
// An entry whose folder is gone: git's dry run names it, in the language git speaks.
execFileSync('git', ['worktree', 'add', '-q', '-b', 'gone', join(tmp, 'gone')], { cwd: repo, env: runEnv(), stdio: 'ignore' })
rmSync(join(tmp, 'gone'), { recursive: true, force: true })
const notRepo = join(tmp, 'plain')
mkdirSync(notRepo)

const DRY_RUN = ['worktree', 'prune', '--dry-run', '--verbose']
/** What git says on its standard error, started as the user's environment has it (no gitEnv). */
const asUser = (cwd: string, args: string[]): string => spawnSync('git', args, { cwd, env: runEnv(german), encoding: 'utf8' }).stderr

describe('gitEnv', () => {
  it('sets LANGUAGE to English whatever its case or value, keeping the rest; Git for Windows\' launcher still applies', () => {
    expect(GIT_LANGUAGE).toBe('en')
    expect(gitEnv({ Language: 'de', LC_ALL: 'de_DE.UTF-8', PATH: 'C:\\Windows' })).toEqual({ LANGUAGE: 'en', LC_ALL: 'de_DE.UTF-8', PATH: 'C:\\Windows' })
    expect(gitEnv({ PATH: 'C:\\Windows' }, { pathFirst: 'C:\\Git\\mingw64\\bin', msystem: 'MINGW64' })).toMatchObject({ LANGUAGE: 'en', MSYSTEM: 'MINGW64', PATH: expect.stringMatching(/^C:\\Git\\mingw64\\bin;/) })
    // No environment given: Combwork's own, copied, never changed.
    const before = process.env.LANGUAGE
    expect(gitEnv(undefined).LANGUAGE).toBe('en')
    expect(process.env.LANGUAGE).toBe(before)
  })
})

describe('a git speaking German', () => {
  it('speaks German as the user starts it: the catalogue works', () => {
    expect(asUser(repo, DRY_RUN)).toContain('Entferne worktrees/gone: gitdir-Datei verweist auf nicht existierenden Ort')
    expect(asUser(notRepo, ['status'])).toContain('Kein Git-Repository')
  })

  it("speaks English through git's runner and the merge queue's git, whatever LANGUAGE, LC_ALL and LANG say", async () => {
    const r = await git(repo, DRY_RUN, undefined, undefined, { env: runEnv(german) })
    expect(`${r.out}${r.err}`).toContain('Removing worktrees/gone: gitdir file points to non-existent location')
    const q = await gitTree(repo, DRY_RUN, { env: runEnv(german) })
    expect(`${q.out}${q.err}`).toContain('Removing worktrees/gone: gitdir file points to non-existent location')
  })

  it("reads what it parses rightly with Combwork's own environment in German: a folder that is no repository", async () => {
    await withProcessEnv(german, async () => {
      expect(asUser(notRepo, ['status'])).toContain('Kein Git-Repository')
      expect((await gitStatus(notRepo)).isRepo).toBe(false)
      expect((await gitStatus(repo)).isRepo).toBe(true)
    })
  })
})
