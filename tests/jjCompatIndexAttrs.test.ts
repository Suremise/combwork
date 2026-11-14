// HI-3035 (SPEC's jj attributes gate): attribute files Git applies though they aren't where the gate looked on disk,
// on real Git (jj's own checks stood in for: the gate's attributes are Git's). A tracked `.gitattributes` not on disk
// (deleted and not committed, or skip-worktree in a sparse checkout) is read from the index, named as Git names its index
// copy (`:<path>`); an ignored one in a folder holding only untracked files is read, while an ignored folder isn't
// looked into (its files are ignored by jj too). Git converting by each is checked first, so the case is real.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { assessJj, type CompatDeps } from '../src/main/platform/jjCompat'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string>) => NodeJS.ProcessEnv }

// No system or global config or attributes: the machine's own would decide it.
const home = tempDir('jjcia-home-')
writeFileSync(join(home, 'gitconfig'), '')
const env = { ...gitEnv({ HOME: home, USERPROFILE: home, APPDATA: home }), GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), XDG_CONFIG_HOME: home }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const deps: CompatDeps = {
  git: async (cwd, args) => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }
    } catch (e) {
      return { ok: false, out: '', err: String((e as { stderr?: string }).stderr ?? e) }
    }
  },
  jj: { run: async () => ({ ok: true, out: '', err: '', code: 0 }) } as unknown as CompatDeps['jj']
}

function repo(name: string): string {
  const root = join(tempDir(`jjcia-${name}-`), 'repo')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const [k, v] of [['user.name', 'Pat Builder'], ['user.email', 'pat@example.invalid'], ['core.autocrlf', 'false']]) git(root, 'config', k, v)
  return resolve(realpathSync.native(root))
}
const attributes = async (root: string): Promise<unknown> => (await assessJj(root, join(root, '.git'), deps)).attributes

describe('the attributes gate reads what Git applies, not only what is on disk (HI-3035)', () => {
  it('a tracked .gitattributes deleted from the working tree, not committed: its index copy, `:.gitattributes`', async () => {
    const root = repo('deleted')
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(root, '.gitattributes'), '*.txt text eol=crlf\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'c')
    expect(await attributes(root)).toEqual({ uses: [`${join(root, '.gitattributes')}: *.txt text eol=crlf`] })
    rmSync(join(root, '.gitattributes'))
    // Git reads the index's copy: the attribute is set, and a checkout converts by it.
    expect(git(root, 'check-attr', 'eol', '--', 'a.txt')).toBe('a.txt: eol: crlf')
    rmSync(join(root, 'a.txt'))
    git(root, 'checkout', '--', 'a.txt')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
    expect(await attributes(root)).toEqual({ uses: [':.gitattributes: *.txt text eol=crlf'] })
    // Its deletion committed: Git applies nothing, the gate is clear.
    git(root, 'commit', '-qam', 'gone')
    expect(await attributes(root)).toEqual({ clear: true })
  })

  it('a .gitattributes under a sparse checkout (skip-worktree, not on disk): its index copy, `:docs/.gitattributes`', async () => {
    const root = repo('sparse')
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(root, 'docs', 'b.txt'), 'one\ntwo\n')
    writeFileSync(join(root, 'docs', '.gitattributes'), '*.txt text eol=crlf\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'c')
    git(root, 'sparse-checkout', 'set', '--no-cone', '/src/')
    expect(git(root, 'ls-files', '-t', 'docs')).toMatch(/^S docs\/\.gitattributes/m)
    expect(git(root, 'check-attr', 'eol', '--', 'docs/b.txt')).toBe('docs/b.txt: eol: crlf')
    expect(await attributes(root)).toEqual({ uses: [':docs/.gitattributes: *.txt text eol=crlf'] })
  })

  it('an ignored .gitattributes in a folder holding only untracked files is read; an ignored folder isn’t looked into', async () => {
    const root = repo('untracked')
    writeFileSync(join(root, 'a.txt'), 'one\n')
    writeFileSync(join(root, '.gitignore'), '**/.gitattributes\nnode_modules/\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'c')
    expect(await attributes(root)).toEqual({ clear: true })
    // In an ignored folder (its files ignored by Git and jj alike): never read.
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'x', '.gitattributes'), '*.js text\n')
    expect(await attributes(root)).toEqual({ clear: true })
    // Beside new files only (no tracked file in the folder): Git applies it to what is added there.
    mkdirSync(join(root, 'new'))
    writeFileSync(join(root, 'new', 'b.txt'), 'one\r\ntwo\r\n')
    writeFileSync(join(root, 'new', '.gitattributes'), '*.txt text\n')
    expect(git(root, 'check-attr', 'text', '--', 'new/b.txt')).toBe('new/b.txt: text: set')
    expect(await attributes(root)).toEqual({ uses: [`${join(root, 'new', '.gitattributes')}: *.txt text`] })
  })
})
