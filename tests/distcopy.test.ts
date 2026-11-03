// Installers built in a git worktree also go to the main checkout's dist (scripts/distCopy.mjs, #150): the worktree
// detection, the copy plan, and the copy, with a temporary repository and worktree.
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error: a plain .mjs module without types
import { checkoutOf, clearDistInfo, copySet, copyToMain, finishDist, installerFiles, makeRelease, planCopy, provenanceProblem, readUnpackedInfo } from '../scripts/distCopy.mjs'
// @ts-expect-error: a plain .mjs module without types
import { packagedStatus } from './e2e/runner.mjs'
import { tempDir } from './tempDir'

type Info = { version: string; code: string; head: string; branch: string | null; builtAt: string }

describe('installers built in a worktree (scripts/distCopy.mjs)', () => {
  const base = tempDir('hive-distcopy-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const main = join(base, 'main')
  const wt = join(base, 'wt')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }).trim()
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'one')
  git(main, 'worktree', 'add', '-q', '-b', 'hive/agent', wt)
  const head = git(main, 'rev-parse', 'HEAD')
  // As places: git names the main checkout by its long path, the test may know it by a short (8.3) one, as on CI (#389).
  const same = (a: string, b: string) => realpathSync.native(resolve(a)).toLowerCase() === realpathSync.native(resolve(b)).toLowerCase()
  /** An installer "built" in a checkout's dist, with its build-info.json. */
  const build = (dir: string, info: Info) => {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    for (const f of installerFiles(info.version).filter((n: string) => n !== 'build-info.json')) writeFileSync(join(dir, 'dist', f), `${f} from ${info.code}`)
    writeFileSync(join(dir, 'dist', 'build-info.json'), JSON.stringify(info))
  }
  const info = (code: string, branch = 'hive/agent'): Info => ({ version: '9.9.9', code, head, branch, builtAt: '2026-10-05T09:00:00Z' })

  it('tells a linked worktree from the main checkout, and finds the main checkout from either', () => {
    const w = checkoutOf(wt)
    expect(w.worktree).toBe(true)
    expect(same(w.main, main)).toBe(true)
    const m = checkoutOf(main)
    expect(m.worktree).toBe(false)
    expect(same(m.main, main)).toBe(true)
    // The temporary folder around them isn't in git.
    expect(checkoutOf(base)).toBeNull()
  })

  it('copies the installer, blockmap, latest.yml and build info to the main dist; the worktree keeps its own', () => {
    build(wt, info('abc'))
    const lines = copyToMain({ root: wt, version: '9.9.9', info: info('abc') })
    expect(lines[0]).toMatch(/^Installer: .*main[\\/]dist[\\/]Hive-Setup-9\.9\.9\.exe \(copied from this worktree, which keeps its own\)$/)
    for (const f of installerFiles('9.9.9')) {
      expect(existsSync(join(main, 'dist', f)), f).toBe(true)
      expect(existsSync(join(wt, 'dist', f)), f).toBe(true)
    }
    expect(readFileSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'), 'utf8')).toBe('Hive-Setup-9.9.9.exe from abc')
    // The same code built again: replaced without a word.
    expect(copyToMain({ root: wt, version: '9.9.9', info: info('abc') })[0]).toMatch(/copied from this worktree/)
  })

  it('never replaces an installer built from other code, or from code it can’t tell, unless --replace', () => {
    build(wt, info('def', 'hive/other'))
    const refused = copyToMain({ root: wt, version: '9.9.9', info: info('def', 'hive/other') })
    expect(refused[0]).toMatch(/^Not copied to the main checkout: .*Hive-Setup-9\.9\.9\.exe is already there, built from other code: abc \(hive\/agent\) .* where this one is def \(hive\/other\)\.$/)
    expect(refused[1]).toMatch(/--replace/)
    expect(readFileSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'), 'utf8')).toBe('Hive-Setup-9.9.9.exe from abc')
    // No build-info.json beside it (built before #150): can't tell, so not replaced either.
    rmSync(join(main, 'dist', 'build-info.json'))
    expect(copyToMain({ root: wt, version: '9.9.9', info: info('def') })[0]).toMatch(/can't tell \(no build-info\.json\)/)
    // --replace copies it over.
    expect(copyToMain({ root: wt, version: '9.9.9', info: info('def'), replace: true })[0]).toMatch(/copied from this worktree/)
    expect(readFileSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'), 'utf8')).toBe('Hive-Setup-9.9.9.exe from def')
  })

  it('--here keeps it in the worktree; in the main checkout nothing is copied', () => {
    build(wt, info('ghi'))
    expect(copyToMain({ root: wt, version: '9.9.9', info: info('ghi'), here: true })).toEqual([expect.stringMatching(/kept in this worktree: --here/)])
    expect(readFileSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'), 'utf8')).toBe('Hive-Setup-9.9.9.exe from def')
    expect(copyToMain({ root: main, version: '9.9.9', info: info('ghi') })).toEqual([])
  })

  it('notes a main checkout at another commit, and has nothing to copy when no installer was built', () => {
    const to = join(base, 'empty-dist')
    expect(planCopy({ version: '9.9.9', from: join(wt, 'dist'), to, info: info('ghi'), theirs: null, mainHead: 'f'.repeat(40) }).note).toMatch(/main checkout is at ffffffffffff, not at this build's commit/)
    expect(planCopy({ version: '9.9.9', from: join(wt, 'dist'), to, info: info('ghi'), theirs: null, mainHead: head }).note).toBeNull()
    expect(planCopy({ version: '1.0.0', from: join(wt, 'dist'), to, info: info('ghi'), theirs: null })).toMatchObject({ copy: [], refuse: expect.stringMatching(/Hive-Setup-1\.0\.0\.exe.* missing in/) })
    // The whole set or nothing: a blockmap missing, or a build-info.json for other code, is refused.
    rmSync(join(wt, 'dist', 'Hive-Setup-9.9.9.exe.blockmap'))
    expect(planCopy({ version: '9.9.9', from: join(wt, 'dist'), to, info: info('ghi'), theirs: null }).refuse).toMatch(/blockmap missing/)
    build(wt, info('ghi'))
    expect(planCopy({ version: '9.9.9', from: join(wt, 'dist'), to, info: info('zzz'), theirs: null }).refuse).toMatch(/doesn't describe this build/)
  })

  // --- Review round 1: several worktrees at once, and failures part-way.
  const more = ['wt2', 'wt3'].map((n) => {
    const dir = join(base, n)
    git(main, 'worktree', 'add', '-q', '-b', `hive/${n}`, dir)
    return dir
  })
  /** copyToMain in a process of its own (another worktree's npm run dist), resolving with the lines it printed. */
  const copyIn = (root: string, code: string) =>
    new Promise<string>((done) => {
      const src = `import { copyToMain } from ${JSON.stringify(pathToFileURL(join(__dirname, '..', 'scripts', 'distCopy.mjs')).href)}
console.log(copyToMain({ root: ${JSON.stringify(root)}, version: '9.9.9', info: ${JSON.stringify(info(code))} }).join('\\n'))`
      const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('exit', () => done(out))
    })
  /** The main dist's set is one build's: every file says the code its build-info.json names. */
  const consistent = () => {
    const d = join(main, 'dist')
    const code = JSON.parse(readFileSync(join(d, 'build-info.json'), 'utf8')).code
    for (const f of installerFiles('9.9.9').filter((n: string) => n !== 'build-info.json')) expect(readFileSync(join(d, f), 'utf8'), f).toBe(`${f} from ${code}`)
    expect(readdirSync(d).filter((f) => /\.copying-|\.lock$/.test(f))).toEqual([])
    return code
  }

  it('two worktrees copying different builds at once: one whole set wins, the other refuses and changes nothing', async () => {
    for (let round = 0; round < 4; round++) {
      rmSync(join(main, 'dist'), { recursive: true, force: true })
      // Big enough that a copy takes a moment, so the two overlap.
      build(more[0], info(`p${round}`))
      build(more[1], info(`q${round}`))
      for (const [dir, code] of [[more[0], `p${round}`], [more[1], `q${round}`]]) writeFileSync(join(dir, 'dist', 'Hive-Setup-9.9.9.exe'), `Hive-Setup-9.9.9.exe from ${code}`.padEnd(8 << 20, ' '))
      const outs = await Promise.all([copyIn(more[0], `p${round}`), copyIn(more[1], `q${round}`)])
      expect(outs.filter((o) => /copied from this worktree/.test(o)), outs.join('\n---\n')).toHaveLength(1)
      expect(outs.filter((o) => /built from other code/.test(o)), outs.join('\n---\n')).toHaveLength(1)
      const exe = readFileSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'), 'utf8').trimEnd()
      const code = JSON.parse(readFileSync(join(main, 'dist', 'build-info.json'), 'utf8')).code
      expect(exe).toBe(`Hive-Setup-9.9.9.exe from ${code}`)
      expect(readFileSync(join(main, 'dist', 'latest.yml'), 'utf8')).toBe(`latest.yml from ${code}`)
      expect([`p${round}`, `q${round}`]).toContain(code)
      // The one that refused named the winner's code as what is there.
      expect(outs.find((o) => /built from other code/.test(o))).toContain(`other code: ${code}`)
    }
  }, 60_000)

  it('a copy waits while another holds the main dist, then checks again what is there', async () => {
    rmSync(join(main, 'dist'), { recursive: true, force: true })
    build(more[0], info('held'))
    mkdirSync(join(main, 'dist', '.installer-copy.lock'), { recursive: true })
    const waiting = copyIn(more[0], 'held')
    await new Promise((r) => setTimeout(r, 800))
    // Still waiting: nothing copied while the lock is held.
    expect(existsSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'))).toBe(false)
    // Meanwhile the holder copies another build; once it lets go, the waiting copy sees it and refuses.
    build(more[1], info('holder'))
    copySet(join(more[1], 'dist'), join(main, 'dist'), installerFiles('9.9.9'))
    rmSync(join(main, 'dist', '.installer-copy.lock'), { recursive: true })
    expect(await waiting).toMatch(/built from other code: holder/)
    expect(consistent()).toBe('holder')
  }, 30_000)

  it('a copy that fails part-way leaves no build-info.json describing a set it doesn’t match', () => {
    const to = join(main, 'dist')
    expect(consistent()).toBe('holder')
    // Fails while copying to the temporary names (a source missing): the old set and its build info stay as they were.
    build(more[0], info('broken'))
    expect(() => copySet(join(more[0], 'dist'), to, [...installerFiles('9.9.9').slice(0, 3), 'nope.txt', 'build-info.json'])).toThrow(/ENOENT/)
    expect(consistent()).toBe('holder')
    // Fails while moving into place (a folder where a file must go): no build info is left at all, so the next copy
    // can't tell what is there and refuses.
    rmSync(join(to, 'latest.yml'))
    mkdirSync(join(to, 'latest.yml'))
    writeFileSync(join(to, 'latest.yml', 'x'), 'x')
    expect(() => copySet(join(more[0], 'dist'), to, installerFiles('9.9.9'))).toThrow()
    expect(existsSync(join(to, 'build-info.json'))).toBe(false)
    expect(readdirSync(to).filter((f) => f.includes('.copying-'))).toEqual([])
    expect(copyToMain({ root: more[1], version: '9.9.9', info: info('holder') })[0]).toMatch(/can't tell/)
  })

  it('code that changed while it was built: no build-info.json, nothing copied; unchanged: labelled and copied', () => {
    rmSync(join(main, 'dist'), { recursive: true, force: true })
    const ident = (code: string, h = head) => ({ version: '9.9.9', code, head: h, branch: 'hive/wt2' })
    expect(provenanceProblem(ident('a'), ident('a'))).toBeNull()
    expect(provenanceProblem(ident('a'), ident('a+1'))).toMatch(/the code changed while it was built \(a → a\+1\)/)
    expect(provenanceProblem(ident('a'), ident('a', 'f'.repeat(40)))).toMatch(/head changed/)
    expect(provenanceProblem(ident('a'), { ...ident('a'), version: '9.9.10' })).toMatch(/version changed/)
    // Changed: an old build-info.json is removed (it would describe other code), and nothing reaches the main dist.
    build(more[0], info('old'))
    const changed = finishDist({ root: more[0], before: ident('a'), after: ident('a+edit') })
    expect(changed[0]).toMatch(/^The build's code can't be told: the code changed .*build again once the code stays put\.$/)
    expect(changed[1]).toMatch(/unlabelled/)
    expect(existsSync(join(more[0], 'dist', 'build-info.json'))).toBe(false)
    expect(existsSync(join(main, 'dist', 'Hive-Setup-9.9.9.exe'))).toBe(false)
    // Unchanged: labelled with what it was built from, and copied.
    const ok = finishDist({ root: more[0], before: ident('b'), after: ident('b'), builtAt: '2026-10-05T10:00:00Z' })
    expect(ok[0]).toMatch(/copied from this worktree/)
    expect(JSON.parse(readFileSync(join(more[0], 'dist', 'build-info.json'), 'utf8'))).toMatchObject({ version: '9.9.9', code: 'b', head, branch: 'hive/wt2', builtAt: '2026-10-05T10:00:00Z' })
    expect(JSON.parse(readFileSync(join(main, 'dist', 'build-info.json'), 'utf8')).code).toBe('b')
  })

  it("win-unpacked keeps its own record, which a copied installer set never changes: the packaged checks test what is there (#274)", () => {
    rmSync(join(main, 'dist'), { recursive: true, force: true })
    rmSync(join(wt, 'dist'), { recursive: true, force: true })
    const ident = (code: string) => ({ version: '9.9.9', code, head, branch: 'hive/agent' })
    /** A dist built in a checkout from `code`: the installer set and an unpacked app, then finished as dist.mjs does. */
    const dist = (dir: string, code: string, replace = false) => {
      build(dir, info(code))
      mkdirSync(join(dir, 'dist', 'win-unpacked'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'win-unpacked', 'artifact-code.txt'), code)
      return finishDist({ root: dir, before: ident(code), after: ident(code), replace })
    }
    // The main checkout's own build A (unpacked there), then a worktree's build B copied over its installer.
    dist(main, 'A')
    expect(readUnpackedInfo(join(main, 'dist')).code).toBe('A')
    expect(dist(wt, 'B', true)[0]).toMatch(/copied from this worktree/)
    expect(JSON.parse(readFileSync(join(main, 'dist', 'build-info.json'), 'utf8')).code).toBe('B')
    // The main checkout later at B: its win-unpacked is still A's, and the packaged checks say so.
    expect(readFileSync(join(main, 'dist', 'win-unpacked', 'artifact-code.txt'), 'utf8')).toBe('A')
    expect(readUnpackedInfo(join(main, 'dist')).code).toBe('A')
    expect(packagedStatus(readUnpackedInfo(join(main, 'dist')), 'B')).toMatch(/is from other code \(A, hive\/agent; this is B\)/)
    // In the worktree that built B, they pass.
    expect(packagedStatus(readUnpackedInfo(join(wt, 'dist')), 'B')).toBeNull()
    // Code that changed while it was built leaves no record of either; nor does a dist that starts (clearDistInfo).
    finishDist({ root: wt, before: ident('C'), after: ident('C+edit') })
    expect(readUnpackedInfo(join(wt, 'dist'))).toBeNull()
    expect(packagedStatus(readUnpackedInfo(join(wt, 'dist')), 'C')).toMatch(/no record of what it was built from/)
    clearDistInfo(join(main, 'dist'))
    expect(readUnpackedInfo(join(main, 'dist'))).toBeNull()
    expect(existsSync(join(main, 'dist', 'build-info.json'))).toBe(false)
    expect(existsSync(join(main, 'dist', 'win-unpacked', 'artifact-code.txt'))).toBe(true)
  })
})

// npm run release builds in its own checkout's dist (scripts/release.mjs) by npm run dist's rules (HI-2411): makeRelease,
// with the build, the app's stamp and the upload faked.
describe('a release build in dist (makeRelease)', () => {
  const base = tempDir('hive-release-')
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  let n = 0
  type Ident = { version: string; code: string; head: string; branch: string | null }
  const ident = (code: string): Ident => ({ version: '9.9.9', code, head: 'c'.repeat(40), branch: 'main' })
  const exe = (root: string) => join(root, 'dist', 'Hive-Setup-9.9.9.exe')
  /** A checkout whose dist holds what an earlier build left: an installer built from code (and its build-info.json unless info is false). */
  const checkout = (earlier?: { code: string; info?: boolean }) => {
    const root = join(base, `r${++n}`)
    mkdirSync(join(root, 'dist'), { recursive: true })
    if (earlier) {
      writeFileSync(exe(root), `installer from ${earlier.code}`)
      if (earlier.info !== false) writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify({ ...ident(earlier.code), builtAt: '2026-11-02T21:59:00Z' }))
    }
    return root
  }
  /** makeRelease with fakes: steps lists what ran, in order; the "upload" writes the installer as electron-builder does. */
  const release = (root: string, { code = 'new', after = code, replace = false } = {}) => {
    const steps: string[] = []
    const idents = [ident(code), ident(after)]
    const made = makeRelease({
      root,
      replace,
      identity: () => idents.shift(),
      run: (cmd: string) => steps.push(cmd),
      stampApp: (_root: string, id: { version: string; commit: string; local: boolean }) => steps.push(`stamp local=${id.local}`),
      publish: () => {
        steps.push('publish')
        writeFileSync(exe(root), `installer from ${code}`)
      }
    })
    return { made, steps }
  }
  const buildInfo = (root: string) => JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8'))

  it('builds, stamps it a release, uploads, and leaves build-info.json describing the uploaded installer', () => {
    const root = checkout()
    const { made, steps } = release(root)
    expect(steps).toEqual(['npm run build', 'stamp local=false', 'publish'])
    expect(made.refused).toBeUndefined()
    expect(made.lines).toEqual([`Installer: ${exe(root)}`])
    expect(buildInfo(root)).toMatchObject({ ...ident('new'), builtIn: root })
    // No copy lock left behind.
    expect(readdirSync(join(root, 'dist')).filter((f) => f.endsWith('.lock'))).toEqual([])
  })

  it('never builds over a same-named installer from other code, or from code it can’t tell, unless --replace', () => {
    // As seen on 3 Nov 2026: npm run dist's build of other code, with its build-info.json.
    const other = checkout({ code: 'old' })
    const refused = release(other)
    expect(refused.steps).toEqual([])
    expect(refused.made.refused).toMatch(/^Not built: .*Hive-Setup-9\.9\.9\.exe is already there, built from other code: old \(main\) at 2026-11-02T21:59:00Z, where this one is new \(main\)\. .*--replace/)
    expect(readFileSync(exe(other), 'utf8')).toBe('installer from old')
    expect(buildInfo(other).code).toBe('old')
    // No build-info.json beside it: can't tell, so not built over either.
    const unknown = checkout({ code: 'old', info: false })
    expect(release(unknown).made.refused).toMatch(/can't tell \(no build-info\.json\)/)
    expect(readFileSync(exe(unknown), 'utf8')).toBe('installer from old')
    // --replace builds over it, and the record follows the installer.
    const replaced = release(other, { replace: true })
    expect(replaced.steps).toEqual(['npm run build', 'stamp local=false', 'publish'])
    expect(readFileSync(exe(other), 'utf8')).toBe('installer from new')
    expect(buildInfo(other).code).toBe('new')
  })

  it('builds over one of the same code without a word', () => {
    const root = checkout({ code: 'new' })
    const { made, steps } = release(root)
    expect(made.refused).toBeUndefined()
    expect(steps).toContain('publish')
    expect(buildInfo(root).code).toBe('new')
  })

  it('code that changed while it was built: no build-info.json, and none left from before', () => {
    const root = checkout({ code: 'new' })
    const { made } = release(root, { code: 'new', after: 'new+edit' })
    expect(made.lines[0]).toMatch(/^The build's code can't be told: the code changed .*No build-info\.json was written: build again once the code stays put\.$/)
    expect(made.lines[1]).toBe(`Installer: ${exe(root)} (unlabelled)`)
    expect(existsSync(join(root, 'dist', 'build-info.json'))).toBe(false)
  })
})
