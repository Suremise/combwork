// HI-3111: a merge onto a branch whose signing comes from `includeIf "onbranch:<branch>"` is signed as that branch says,
// though Combwork makes it in a detached worktree (the queue's folder, the Merge dialog's temporary worktree) where
// onbranch matches nothing. The reader (branchConfig.ts) has git evaluate the config in that very worktree with its HEAD
// on the target for the read alone: git's own order across scopes, gitdir conditions, config.worktree, nested includes
// and wildmatch. Any step failing is unknown and nothing commits; a HEAD left on the target by a failed restore is put
// back by the queue's next round before anything else. Real ssh signing (a throwaway key, no passphrase, local config).
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { B1, GIT_HEAVY_MS, moved, setup, sh, type Env } from './harness'
import { tempDir } from '../tempDir'
import { preset, type WorkflowOptions } from '../../src/shared/workflow/options'
import { resolveProgram } from '../../src/main/platform/gitSigning'
import { gitExe } from '../../src/main/gitTool'
import { withLauncherEnv } from '../../src/main/gitWorker'
import { gitTree } from '../../src/main/workflow/mergeQueue'
import { git } from '../../src/main/git'
import { targetSigning, type BranchConfigRun } from '../../src/main/branchConfig'
import { createWorktree, mergeWorktree } from '../../src/main/worktrees'

const slash = (p: string): string => p.replace(/\\/g, '/')
const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

let env: Env | null = null
afterEach(() => {
  env?.close()
  env = null
})
let keygen = ''
beforeAll(async () => {
  const use = gitExe()
  keygen = (await resolveProgram('ssh-keygen', process.cwd(), use.launcherEnv ? withLauncherEnv(process.env, use.launcherEnv) : process.env))!
})
/** A throwaway ed25519 key with no passphrase, and an allowed-signers file naming it. */
function keyPair(): { key: string; allowed: string } {
  const dir = tempDir('cw-sign-key-')
  const key = slash(join(dir, 'id_ed25519'))
  execFileSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'combwork-test', '-f', key], { windowsHide: true })
  const allowed = slash(join(dir, 'allowed_signers'))
  writeFileSync(allowed, `* ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`)
  return { key, allowed }
}
/** A file setting ssh signing with `key`, for an include. */
function signingFile(dir: string, name: string, key: string): string {
  const p = join(dir, name)
  writeFileSync(p, `[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${key}\n`)
  return slash(p)
}
/** %G? of a commit: G good, N none. */
const sig = (repo: string, rev: string): string => spawnSync('git', ['-C', repo, 'log', '-1', '--format=%G?', rev], { encoding: 'utf8', windowsHide: true }).stdout.trim()
const runner: BranchConfigRun = (cwd, args) => git(cwd, args)

/** A repository on main, and a detached worktree of it (as the queue's folder is) at main's commit. */
function repoWithDetached(): { repo: string; folder: string; at: string; root: string } {
  const root = tempDir('cw-branch-config-')
  const repo = join(root, 'repo')
  run(root, 'init', '-q', '-b', 'main', repo)
  run(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'a')
  run(repo, 'branch', 'release')
  const folder = join(root, 'folder')
  run(repo, 'worktree', 'add', '-q', '--detach', folder, 'main')
  return { repo, folder, at: run(repo, 'rev-parse', 'main'), root }
}
const values = (r: Awaited<ReturnType<typeof targetSigning>>): Record<string, string> => {
  if ('failed' in r) throw new Error(r.failed)
  const out: Record<string, string> = {}
  for (let i = 0; i < r.args.length; i += 2) {
    const [k, ...v] = r.args[i + 1].split('=')
    out[k] = v.join('=')
  }
  return out
}
const detachedAt = (folder: string, at: string): boolean => spawnSync('git', ['-C', folder, 'symbolic-ref', '-q', 'HEAD']).status === 1 && run(folder, 'rev-parse', 'HEAD') === at

describe('the target branch’s signing settings, read in the merge’s own worktree (HI-3111)', () => {
  it('applies onbranch for the target only, as git orders scopes and values, nested in a gitdir condition and from config.worktree', async () => {
    const { repo, folder, at, root } = repoWithDetached()
    const gd = join(repo, '.git')
    writeFileSync(join(gd, 'rel.cfg'), '[commit]\n\tgpgsign = true\n')
    run(repo, 'config', 'includeIf.onbranch:rel[e]ase.path', 'rel.cfg')
    // Matching and not: release (a character class, git's own wildmatch) has it; main doesn't.
    expect(values(await targetSigning(runner, folder, 'release', at))).toEqual({ 'commit.gpgsign': 'true' })
    expect(values(await targetSigning(runner, folder, 'main', at))).toEqual({})
    // A local value after the include in the same file wins; one before it loses.
    run(repo, 'config', 'commit.gpgsign', 'false')
    expect(values(await targetSigning(runner, folder, 'release', at))['commit.gpgsign']).toBe('false')
    // A global include giving false, the local file true later (local after global): true, as on the branch.
    run(repo, 'config', '--unset', 'commit.gpgsign')
    run(repo, 'config', '--unset', 'includeIf.onbranch:rel[e]ase.path')
    run(repo, 'config', 'commit.gpgsign', 'true')
    writeFileSync(join(root, 'gfalse.cfg'), '[commit]\n\tgpgsign = false\n')
    const global = join(root, 'global')
    writeFileSync(global, `[includeIf "onbranch:release"]\n\tpath = ${slash(join(root, 'gfalse.cfg'))}\n`)
    const withGlobal: BranchConfigRun = async (cwd, args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: global } })
      return { ok: r.status === 0, code: r.status, out: r.stdout, err: r.stderr }
    }
    expect(values(await targetSigning(withGlobal, folder, 'release', at))['commit.gpgsign']).toBe('true')
    run(repo, 'config', '--unset', 'commit.gpgsign')
    // An exact gitdir condition naming this worktree's own git dir, nesting onbranch:release.
    const own = run(folder, 'rev-parse', '--absolute-git-dir')
    writeFileSync(join(gd, 'nested.cfg'), '[includeIf "onbranch:release"]\n\tpath = deep.cfg\n')
    writeFileSync(join(gd, 'deep.cfg'), '[user]\n\tsigningkey = KEY\n')
    run(repo, 'config', `includeIf.gitdir:${slash(own)}.path`, 'nested.cfg')
    expect(values(await targetSigning(runner, folder, 'release', at))['user.signingkey']).toBe('KEY')
    // This worktree's own config.worktree: kept, in its place after the common config.
    run(repo, 'config', 'extensions.worktreeConfig', 'true')
    run(folder, 'config', '--worktree', 'gpg.format', 'ssh')
    expect(values(await targetSigning(runner, folder, 'release', at))['gpg.format']).toBe('ssh')
    // Nothing of the repository's moved: main and release where they were, the folder detached at `at`.
    expect(detachedAt(folder, at)).toBe(true)
    expect(run(repo, 'branch', '--show-current')).toBe('main')
  })

  it('fails closed: a folder not detached at `at` is never touched; an unreadable include, a failed read or restore is unknown, HEAD put back', async () => {
    const { repo, folder, at } = repoWithDetached()
    // No onbranch condition anywhere: nothing to add, and nothing is touched (one git).
    expect(await targetSigning(runner, folder, 'release', at)).toEqual({ args: [] })
    writeFileSync(join(repo, '.git', 'rel.cfg'), '[commit]\n\tgpgsign = true\n')
    run(repo, 'config', 'includeIf.onbranch:release.path', 'rel.cfg')
    // Not detached at `at` (the project folder, on main): refused before anything changes.
    expect(await targetSigning(runner, repo, 'release', at)).toMatchObject({ failed: expect.stringMatching(/not detached/) })
    expect(run(repo, 'branch', '--show-current')).toBe('main')
    // An include that is a directory: git can't read it on release (every git there fails, git's restore too); HEAD is
    // written back detached all the same.
    mkdirSync(join(repo, '.git', 'dir.cfg'))
    run(repo, 'config', '--add', 'includeIf.onbranch:release.path', 'dir.cfg')
    expect(await targetSigning(runner, folder, 'release', at)).toMatchObject({ failed: expect.any(String) })
    expect(detachedAt(folder, at)).toBe(true)
    run(repo, 'config', '--unset-all', 'includeIf.onbranch:release.path')
    run(repo, 'config', 'includeIf.onbranch:release.path', 'rel.cfg')
    // The read failing: unknown, HEAD restored.
    const readFails: BranchConfigRun = async (cwd, args) => (args[0] === 'config' ? { ok: false, code: 128, out: '', err: 'injected' } : runner(cwd, args))
    expect(await targetSigning(readFails, folder, 'release', at)).toEqual({ failed: 'injected' })
    expect(detachedAt(folder, at)).toBe(true)
    // git's restore failing: unknown though the read worked (the caller commits nothing), and HEAD written back detached.
    const restoreFails: BranchConfigRun = async (cwd, args) => (args[0] === 'update-ref' ? { ok: false, code: 128, out: '', err: 'injected restore' } : runner(cwd, args))
    expect(await targetSigning(restoreFails, folder, 'release', at)).toEqual({ failed: 'injected restore' })
    expect(detachedAt(folder, at)).toBe(true)
    expect(run(repo, 'rev-parse', 'release')).toBe(at)
    // HR3's round 1: thrown, not answered (a cancellation, a lost lease). The read throwing: HEAD detached again first,
    // then the same error thrown.
    const cancelled = new Error('cancelled')
    const readThrows: BranchConfigRun = async (cwd, args) => {
      if (args[0] === 'config' && args.includes('^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$')) throw cancelled
      return runner(cwd, args)
    }
    await expect(targetSigning(readThrows, folder, 'release', at)).rejects.toBe(cancelled)
    expect(detachedAt(folder, at)).toBe(true)
    // The restore throwing: HEAD written back detached (it was still this read's), unknown, nothing committed.
    const restoreThrows: BranchConfigRun = async (cwd, args) => {
      if (args[0] === 'update-ref') throw new Error('restore cancelled')
      return runner(cwd, args)
    }
    expect(await targetSigning(restoreThrows, folder, 'release', at)).toEqual({ failed: 'restore cancelled' })
    expect(detachedAt(folder, at)).toBe(true)
    // Both throwing: detached again, and the read's error is the one thrown.
    const bothThrow: BranchConfigRun = async (cwd, args) => (args[0] === 'update-ref' ? Promise.reject(new Error('restore cancelled')) : readThrows(cwd, args))
    await expect(targetSigning(bothThrow, folder, 'release', at)).rejects.toBe(cancelled)
    expect(detachedAt(folder, at)).toBe(true)
    // Neither the target nor the user's folder moved; the next attempt reads as usual.
    expect(run(repo, 'rev-parse', 'release')).toBe(at)
    expect(run(repo, 'branch', '--show-current')).toBe('main')
    expect(values(await targetSigning(runner, folder, 'release', at))).toEqual({ 'commit.gpgsign': 'true' })
    expect(detachedAt(folder, at)).toBe(true)
  })

  it('replays the signing settings in git’s order, so of two names for one setting the one git takes last wins (HR3’s round 1)', async () => {
    const { repo, folder, at } = repoWithDetached()
    // gpg.program and gpg.openpgp.program name the same signer: the later of the two counts. On release the include's
    // gpg.program comes last, so git there runs "missing-gpg-third"; read back through the -c's, the same.
    run(repo, 'config', 'gpg.program', 'missing-gpg-first')
    run(repo, 'config', 'gpg.openpgp.program', 'missing-gpg-second')
    writeFileSync(join(repo, '.git', 'rel.cfg'), '[gpg]\n\tprogram = missing-gpg-third\n')
    run(repo, 'config', 'includeIf.onbranch:release.path', 'rel.cfg')
    const r = await targetSigning(runner, folder, 'release', at)
    if ('failed' in r) throw new Error(r.failed)
    const tried = spawnSync('git', [...r.args, '-c', 'commit.gpgsign=true', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-q', '-m', 'x'], { cwd: folder, encoding: 'utf8', windowsHide: true })
    expect(tried.status).not.toBe(0)
    expect(`${tried.stderr}`).toMatch(/missing-gpg-third/)
    expect(detachedAt(folder, at)).toBe(true)
  })
})

function work(folder: string, files: Record<string, string>, message: string): void {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(folder, f), text)
  sh(folder, 'add', '-A')
  sh(folder, '-c', 'commit.gpgsign=false', '-c', 'user.name=Combwork Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', message)
}
/** A Pair project merging into main (the project folder detached, as the queue's own tests have it), its card submitted. */
async function queued(o: Partial<WorkflowOptions> = {}) {
  const e = (env = setup({ ...preset('git', 'pair'), review: 'none', noSelfReview: false, preChecks: [], mergeChecks: [], ...o }))
  sh(e.project, 'checkout', '-q', '--detach')
  const { key, allowed } = keyPair()
  sh(e.project, 'config', 'gpg.ssh.allowedSignersFile', allowed)
  const card = e.wf.createCard({ title: 'A' })
  const s = await e.wf.start(card.key, B1)
  moved(s)
  work(s.data!.folder as string, { 'a.txt': 'A\n' }, 'A')
  moved(await e.wf.submit(card.key, B1, { summary: 'x' }))
  return { e, key, card }
}

describe('the merge queue signs as the target branch says (HI-3111)', () => {
  for (const style of ['merge', 'squash'] as const) {
    it(`${style}: signed with signing from includeIf onbranch:main; unsigned when it names another branch`, { timeout: GIT_HEAVY_MS }, async () => {
      const { e, key } = await queued({ style })
      sh(e.project, 'config', 'includeIf.onbranch:main.path', signingFile(join(e.project, '.git'), 'main-signing.cfg', key))
      expect((await e.queue().drain('main')).map((x) => x.outcome)).toContain('integrated')
      expect(sig(e.project, 'main')).toBe('G')
    })
  }

  it('unsigned when the include names another branch only (the control)', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, key } = await queued()
    sh(e.project, 'config', 'includeIf.onbranch:release.path', signingFile(join(e.project, '.git'), 'release-signing.cfg', key))
    expect((await e.queue().drain('main')).map((x) => x.outcome)).toContain('integrated')
    expect(sig(e.project, 'main')).toBe('N')
  })

  it('a restore that fails: no commit command runs, main unmoved; the next round puts the folder back and merges, signed', { timeout: GIT_HEAVY_MS }, async () => {
    const { e, key } = await queued()
    sh(e.project, 'config', 'includeIf.onbranch:main.path', signingFile(join(e.project, '.git'), 'main-signing.cfg', key))
    const before = sh(e.project, 'rev-parse', 'main').trim()
    // Every restore of this drain fails (the queue goes round again on `again`): what runs after the first is recorded.
    const after: string[][] = []
    let failed = false
    const failing = {
      git: async (cwd: string, args: string[], opts?: Parameters<typeof gitTree>[2]) => {
        if (failed) after.push(args)
        if (args[0] === 'update-ref' && args.includes('--no-deref')) {
          failed = true
          return { ok: false, code: 128, out: '', err: 'injected restore failure' }
        }
        return opts ? gitTree(cwd, args, opts) : git(cwd, args)
      }
    }
    const first = await e.queue(failing).drain('main')
    expect(first.map((x) => x.outcome)).not.toContain('integrated')
    // After the failed restore: no merge, commit or rebase ran (the round stopped), and main is where it was.
    expect(after.filter((a) => a.some((x) => x === 'merge' || x === 'commit' || x === 'rebase'))).toEqual([])
    expect(sh(e.project, 'rev-parse', 'main').trim()).toBe(before)
    // Its tries spent, the queue paused saying git's words; resumed, the next round forces its folder detached again
    // first, then merges, signed.
    const q = e.queue()
    expect(q.paused('main')?.message ?? '').toMatch(/injected restore failure/)
    // As if Combwork had stopped mid-read: the queue's folder left on main. The next round detaches it before anything.
    sh(join(e.home, 'queue'), 'symbolic-ref', 'HEAD', 'refs/heads/main')
    q.resume('main')
    expect((await q.drain('main')).map((x) => x.outcome)).toContain('integrated')
    expect(sig(e.project, 'main')).toBe('G')
  })
})

describe('the Merge dialog into a branch checked out nowhere signs as that branch says (HI-3111)', () => {
  for (const squash of [false, true]) {
    it(`${squash ? 'squash' : 'merge commit'} into release with includeIf onbranch:release: signed`, async () => {
      const root = tempDir('cw-dialog-sign-')
      const project = join(root, 'project')
      run(root, 'init', '-q', '-b', 'main', project)
      for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['core.autocrlf', 'false']]) run(project, 'config', k, v)
      writeFileSync(join(project, 'f.txt'), 'base\n')
      run(project, 'add', '-A')
      run(project, 'commit', '-qm', 'base')
      run(project, 'branch', 'release')
      const a = { path: join(root, 'wt', 'a'), branch: 'cw/a', base: 'main' }
      await createWorktree(project, a.path, a.branch, 'main')
      writeFileSync(join(a.path, 'a.txt'), 'A\n')
      run(a.path, 'add', '-A')
      run(a.path, 'commit', '-qm', 'work A')
      const { key, allowed } = keyPair()
      run(project, 'config', 'gpg.ssh.allowedSignersFile', allowed)
      run(project, 'config', 'includeIf.onbranch:release.path', signingFile(join(project, '.git'), 'release-signing.cfg', key))
      expect(await mergeWorktree(project, a, { squash, message: 'into release', target: 'release' })).toMatchObject({ ok: true })
      expect(sig(project, 'release')).toBe('G')
      // A commit by hand on main (the include names release only) stays unsigned: the control.
      expect(sig(project, 'main')).toBe('N')
    })
  }
})
