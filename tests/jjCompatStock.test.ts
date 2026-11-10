// jj's compatibility gates and Git for Windows' stock system settings (HI-2872, Darren's (b) on HI-2799; SPEC §16.3.6):
// its installer's own etc/gitconfig and etc/gitattributes, at system scope, aren't a use; the same keys at global or local
// scope, a changed system value, another system file, or a repository using LFS or attributes still refuse. Real git,
// in a test home laid out as Git for Windows is (<install>/ucrt64/libexec/git-core, <install>/etc/gitconfig): git reads
// the copy as its system config (GIT_CONFIG_SYSTEM) and says where it came from; the machine's own config is never read.
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { allClear, assessJj, gfwStockAttrLine, gfwSystemFiles, type CompatDeps } from '../src/main/platform/jjCompat'
import type { JjRunner } from '../src/main/platform/jjRunner'
import { tempDir } from './tempDir'

const require = createRequire(import.meta.url)
const { gitEnv } = require('./e2e/runContext.cjs') as { gitEnv: (vars?: Record<string, string | undefined>) => NodeJS.ProcessEnv }

/** Git for Windows 2.56.0.windows.4's etc/gitconfig as its installer writes it (default choices), verbatim. */
const STOCK_CONFIG = `[diff "astextplain"]
\ttextconv = astextplain
[filter "lfs"]
\tclean = git-lfs clean -- %f
\tsmudge = git-lfs smudge -- %f
\tprocess = git-lfs filter-process
\trequired = true
[http]
\tsslBackend = openssl
\tsslCAInfo = C:/Program Files/Git/ucrt64/etc/ssl/certs/ca-bundle.crt
[core]
\tautocrlf = true
\tfscache = true
\tsymlinks = false
[pull]
\trebase = false
[credential]
\thelper = manager
[credential "https://dev.azure.com"]
\tuseHttpPath = true
[init]
\tdefaultBranch = master
`
/** Its etc/gitattributes, verbatim. */
const STOCK_ATTRIBUTES = ['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'pdf', 'rtf', 'ods', 'odf', 'odt']
  .flatMap((e) => [`*.${e}\tdiff=astextplain`, `*.${e.toUpperCase()}\tdiff=astextplain`]).join('\n') + '\n'

/** jj's own config sets nothing here. */
const quietJj = { run: async () => ({ ok: true, out: '', err: '', buf: Buffer.alloc(0), code: 0 }) } as unknown as JjRunner

interface Setup {
  root: string
  store: string
  install: string
  git: (...args: string[]) => string
  deps: CompatDeps
}

/**
 * A test home with a Git for Windows install layout holding the stock files (or `config`), a repository with one commit,
 * and the assessment's git: real git reading that system config and an empty global one, `--exec-path` answered as the
 * install's (`execPath` overrides it) and `git var GIT_ATTR_SYSTEM` naming the install's attributes.
 */
function setup(o: { config?: string; systemAt?: string; execPath?: string } = {}): Setup {
  const home = tempDir('jjstock-')
  const install = join(home, 'Git')
  mkdirSync(join(install, 'etc'), { recursive: true })
  mkdirSync(join(install, 'ucrt64', 'libexec', 'git-core'), { recursive: true })
  const systemFile = o.systemAt ?? join(install, 'etc', 'gitconfig')
  writeFileSync(systemFile, o.config ?? STOCK_CONFIG)
  writeFileSync(join(install, 'etc', 'gitattributes'), STOCK_ATTRIBUTES)
  writeFileSync(join(home, 'global'), '')
  const env = gitEnv({ GIT_CONFIG_NOSYSTEM: undefined, GIT_ATTR_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: systemFile, GIT_CONFIG_GLOBAL: join(home, 'global'), XDG_CONFIG_HOME: join(home, 'xdg'), HOME: home, USERPROFILE: home })
  const run = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const root = join(home, 'repo')
  mkdirSync(root)
  run(root, ['init', '-q', '-b', 'main'])
  writeFileSync(join(root, 'a.txt'), 'a\n')
  run(root, ['add', '-A'])
  run(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'])
  const git: CompatDeps['git'] = async (cwd, args) => {
    if (args[0] === '--exec-path') return { ok: true, out: (o.execPath ?? join(install, 'ucrt64', 'libexec', 'git-core')) + '\n', err: '' }
    if (args[0] === 'var' && args[1] === 'GIT_ATTR_SYSTEM') return { ok: true, out: join(install, 'etc', 'gitattributes') + '\n', err: '' }
    try {
      return { ok: true, out: run(cwd, args), err: '' }
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string }
      return { ok: false, out: err.stdout ?? '', err: String(err.stderr ?? e) }
    }
  }
  return { root, store: join(root, '.git'), install, git: (...args) => run(root, args), deps: { git, jj: quietJj } }
}

const CLEAR = { clear: true }

describe("jj's gates and Git for Windows' stock system settings (HI-2872)", () => {
  it('the stock system config and attributes pass lfs and attributes; only its core.autocrlf=true is still a use', async () => {
    const s = setup()
    const a = await assessJj(s.root, s.store, s.deps)
    expect(a.lfs).toEqual(CLEAR)
    // Git's line-ending conversion really converts: still a use, flagged for the dialog's hint (Darren, 10 Nov).
    expect(a.attributes).toEqual({ uses: ['core.autocrlf (system) = true'], autocrlf: true })
    expect(a.submodules).toEqual(CLEAR)
    // Turned off for the repository alone, as the hint says (Git applies the last level's), a default install switches.
    s.git('config', 'core.autocrlf', 'false')
    expect(allClear(await assessJj(s.root, s.store, s.deps))).toBe(true)
  })

  it("the same LFS keys globally (git lfs install's) or locally still refuse", async () => {
    const s = setup()
    s.git('config', '--global', 'core.autocrlf', 'false')
    s.git('config', '--global', 'filter.lfs.clean', 'git-lfs clean -- %f')
    expect((await assessJj(s.root, s.store, s.deps)).lfs).toEqual({ uses: ['filter.lfs.clean (global)'] })
    s.git('config', '--global', '--unset', 'filter.lfs.clean')
    s.git('config', 'filter.lfs.process', 'git-lfs filter-process')
    expect((await assessJj(s.root, s.store, s.deps)).lfs).toEqual({ uses: ['filter.lfs.process (local)'] })
  })

  it('a changed or added system value still refuses', async () => {
    const changed = setup({ config: STOCK_CONFIG.replace('git-lfs smudge -- %f', 'my-lfs smudge -- %f') })
    expect((await assessJj(changed.root, changed.store, changed.deps)).lfs).toEqual({ uses: ['filter.lfs.smudge (system)'] })
    const added = setup({ config: STOCK_CONFIG + '[lfs]\n\turl = https://example.invalid/lfs\n' })
    expect((await assessJj(added.root, added.store, added.deps)).lfs).toEqual({ uses: ['lfs.url (system)'] })
    const filter = setup({ config: STOCK_CONFIG + '[filter "crypt"]\n\tclean = crypt -e\n' })
    expect((await assessJj(filter.root, filter.store, filter.deps)).attributes).toMatchObject({ uses: expect.arrayContaining(['filter.crypt.clean (system)']) })
  })

  it('the stock values from another system file, or from a git that is not Git for Windows, still refuse', async () => {
    const home = tempDir('jjstock-elsewhere-')
    const elsewhere = setup({ systemAt: join(home, 'gitconfig') })
    expect((await assessJj(elsewhere.root, elsewhere.store, elsewhere.deps)).lfs).toMatchObject({ uses: expect.arrayContaining(['filter.lfs.clean (system)']) })
    const other = setup({ execPath: '/usr/lib/git-core' })
    expect((await assessJj(other.root, other.store, other.deps)).lfs).toMatchObject({ uses: expect.arrayContaining(['filter.lfs.clean (system)']) })
    // Its attributes are then a use too.
    expect((await assessJj(other.root, other.store, other.deps)).attributes).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('diff=astextplain')]) })
  })

  it('a repository using LFS or attributes still refuses', async () => {
    const s = setup()
    s.git('config', '--global', 'core.autocrlf', 'false')
    writeFileSync(join(s.root, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    s.git('add', '.gitattributes')
    s.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lfs')
    const a = await assessJj(s.root, s.store, s.deps)
    expect(a.lfs).toMatchObject({ uses: [expect.stringContaining('filter=lfs')] })
    expect(a.attributes).toMatchObject({ uses: [expect.stringContaining('filter=lfs')] })
    // The repository's own astextplain line is a use, though the system's are not.
    writeFileSync(join(s.root, '.gitattributes'), '*.docx diff=astextplain\n')
    s.git('add', '.gitattributes')
    s.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'docx')
    expect((await assessJj(s.root, s.store, s.deps)).attributes).toMatchObject({ uses: [expect.stringMatching(/\.gitattributes: \*\.docx diff=astextplain$/)] })
  })

  it("the stock attribute lines count while their diff driver isn't stock, and any other system attribute line counts", async () => {
    const s = setup()
    s.git('config', '--global', 'core.autocrlf', 'false')
    s.git('config', '--global', 'diff.astextplain.textconv', 'my-converter')
    expect((await assessJj(s.root, s.store, s.deps)).attributes).toMatchObject({ uses: expect.arrayContaining([expect.stringContaining('*.doc')]) })
    const t = setup()
    t.git('config', '--global', 'core.autocrlf', 'false')
    writeFileSync(join(t.install, 'etc', 'gitattributes'), STOCK_ATTRIBUTES + '*.txt text\n')
    expect((await assessJj(t.root, t.store, t.deps)).attributes).toEqual({ uses: [expect.stringMatching(/gitattributes: \*\.txt text$/)] })
  })

  it("finds Git for Windows' files from its exec-path, and nothing for another layout", async () => {
    const at = (out: string): CompatDeps['git'] => async () => ({ ok: true, out, err: '' })
    expect(await gfwSystemFiles('.', { git: at('C:/Program Files/Git/ucrt64/libexec/git-core\n') })).toEqual({ config: join('C:/Program Files/Git', 'etc', 'gitconfig'), attributes: join('C:/Program Files/Git', 'etc', 'gitattributes') })
    expect(await gfwSystemFiles('.', { git: at('C:\\Git\\MINGW64\\libexec\\git-core') })).toEqual({ config: join('C:\\Git', 'etc', 'gitconfig'), attributes: join('C:\\Git', 'etc', 'gitattributes') })
    expect(await gfwSystemFiles('.', { git: at('/usr/lib/git-core') })).toBeNull()
    expect(await gfwSystemFiles('.', { git: at('C:/Git/libexec/git-core') })).toBeNull()
    expect(await gfwSystemFiles('.', { git: async () => ({ ok: false, out: '', err: 'no' }) })).toBeNull()
    expect(gfwStockAttrLine('*.PDF\tdiff=astextplain')).toBe(true)
    expect(gfwStockAttrLine('*.pdf diff=astextplain -text')).toBe(false)
    expect(gfwStockAttrLine('*.txt diff=astextplain')).toBe(false)
  })
})
