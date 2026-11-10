// A folder's repository boundary and the one repository-lock owner (HI-2896, J9f; design HI-2896/s13 and s16, HR1's).
// The boundary: the nearest marker decides, a non-colocated `.jj` hides the Git repository above it, an unreadable one is
// unknown, never Git's. The owner: every take resolves to stores, each once, in one order; a nested take of a store a
// live owner holds runs through, a continuation outliving its take takes the lock again, an out-of-order nested take
// never waits; an unknown folder refuses the whole take. The jj files are written by hand (J0's layout: `.jj/repo`,
// `store/type`, `store/git_target`), so no jj is needed; the real-jj side is jjSeparate.test.ts.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { gitRepo, sh } from './workflow/harness'

/** Each repository lock request the lock's worker got, in order: take or release, and its store. */
const lockTrace: string[] = []
vi.mock('../src/main/repoLockWorker', async (original) => {
  const real = await original<typeof import('../src/main/repoLockWorker')>()
  return {
    ...real,
    handleRequest: (m: Parameters<typeof real.handleRequest>[0], post: Parameters<typeof real.handleRequest>[1]) => {
      lockTrace.push(`${m.type} ${m.dir.toLowerCase()}`)
      return real.handleRequest(m, post)
    }
  }
})
// The wait for a lock another process holds: a second, so a busy store answers in the test's time.
vi.mock('../src/main/advanced', async (original) => {
  const real = await original<typeof import('../src/main/advanced')>()
  const number = real.advanced.number.bind(real.advanced)
  real.advanced.number = ((key: string) => (key === 'cw.merge.lockWaitSeconds' ? 1 : number(key as never))) as typeof real.advanced.number
  return real
})

const { boundaryOf, gitVeto } = await import('../src/main/platform/repoBoundary')
const { commonGitDir, withRepoLock } = await import('../src/main/repoLock')
const { repoContext, withFolderRepoLocks, excludeFile, mainTree, trustRoot } = await import('../src/main/platform/repoPorts')
const { storeLock } = await import('../src/main/slotsApp')
const { fileLockDepth } = await import('../src/main/fsutil')
const { REPO_LOCK_FILE } = await import('../src/main/repoLockCore')

vi.setConfig({ testTimeout: 60_000 })
afterEach(() => void (lockTrace.length = 0))

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const base = tempDir('cw-boundary-')
const real = (p: string): string => resolve(realpathSync(p)).toLowerCase()

/** A non-colocated jj workspace at `root` by J0's layout: `.jj/repo/store` with `type` git and its bare store in `git`. */
function jjSeparate(root: string): { store: string } {
  const store = join(root, '.jj', 'repo', 'store')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'type'), 'git')
  writeFileSync(join(store, 'git_target'), 'git')
  sh(store, 'init', '-q', '--bare', 'git')
  return { store: join(store, 'git') }
}
/** A workspace linked to `main`'s repository (`jj workspace add`): its `.jj/repo` a file naming the shared one. */
function jjLinked(root: string, main: string): void {
  mkdirSync(join(root, '.jj'), { recursive: true })
  writeFileSync(join(root, '.jj', 'repo'), join(main, '.jj', 'repo'))
}

let n = 0
/** An outer Git repository with a non-colocated jj workspace `jj` inside it. */
function outerWithJj(): { outer: string; jj: string; store: string; sub: string } {
  const outer = gitRepo(join(base, `outer-${++n}`))
  const jj = join(outer, 'inner')
  const { store } = jjSeparate(jj)
  const sub = join(jj, 'src')
  mkdirSync(sub)
  return { outer, jj, store, sub }
}

describe('the boundary: the nearest marker decides (s13 §1)', () => {
  it('a non-colocated jj workspace inside a Git repository is jj’s, from it and its subfolders; the Git repository is never named', async () => {
    const w = outerWithJj()
    for (const f of [w.jj, w.sub]) {
      const b = await boundaryOf(f)
      expect(b).toMatchObject({ jj: { root: resolve(w.jj) } })
      expect('jj' in b && real(b.jj.store)).toBe(real(w.store))
      expect(await gitVeto(f)).toMatchObject({ why: 'jj', root: resolve(w.jj) })
    }
    expect(await boundaryOf(w.outer)).toEqual({ git: { root: resolve(w.outer) } })
    expect(await gitVeto(w.outer)).toBeNull()
  })

  it('a linked workspace (its .jj/repo a file) nested in a Git repository: jj’s, the shared repository’s store', async () => {
    const w = outerWithJj()
    const slot = join(w.outer, 'slots', 'slot-a')
    jjLinked(slot, w.jj)
    const b = await boundaryOf(slot)
    expect(b).toMatchObject({ jj: { root: resolve(slot), linked: true } })
    expect('jj' in b && real(b.jj.store)).toBe(real(w.store))
  })

  it('an unreadable nearer .jj is unknown, never the Git repository above: no repo, an empty pointer, another backend, no store, a .jj file', async () => {
    const cases: [string, (root: string) => void, string][] = [
      ['noRepo', (r) => mkdirSync(join(r, '.jj')), 'noRepo'],
      ['empty', (r) => (mkdirSync(join(r, '.jj')), writeFileSync(join(r, '.jj', 'repo'), '')), 'emptyPointer'],
      ['backend', (r) => (mkdirSync(join(r, '.jj', 'repo', 'store'), { recursive: true }), writeFileSync(join(r, '.jj', 'repo', 'store', 'type'), 'local')), 'backend'],
      ['store', (r) => (mkdirSync(join(r, '.jj', 'repo', 'store'), { recursive: true }), writeFileSync(join(r, '.jj', 'repo', 'store', 'type'), 'git'), writeFileSync(join(r, '.jj', 'repo', 'store', 'git_target'), 'gone')), 'gitStore'],
      ['file', (r) => writeFileSync(join(r, '.jj'), 'not a folder'), 'jjNotDir']
    ]
    for (const [name, make, why] of cases) {
      const outer = gitRepo(join(base, `bad-${name}-${++n}`))
      const inner = join(outer, 'inner')
      mkdirSync(inner)
      make(inner)
      expect(await boundaryOf(inner), name).toMatchObject({ unknown: why, root: resolve(inner) })
      expect(await gitVeto(inner), name).toMatchObject({ why })
      await expect(commonGitDir(inner), name).rejects.toThrow(/isn't colocated with Git/)
      expect(await repoContext(inner), name).toBeNull()
      await expect(withFolderRepoLocks([inner], async () => 'ran'), name).rejects.toThrow(/couldn't read the jj repository/)
      expect(lockTrace, name).toEqual([])
    }
  })

  it('a .jj beside a .git: a colocated pair when it names that store; a stray or damaged one leaves Git’s own repository there', async () => {
    const co = gitRepo(join(base, `co-${++n}`))
    mkdirSync(join(co, '.jj', 'repo', 'store'), { recursive: true })
    writeFileSync(join(co, '.jj', 'repo', 'store', 'type'), 'git')
    writeFileSync(join(co, '.jj', 'repo', 'store', 'git_target'), '../../../.git')
    const b = await boundaryOf(co)
    expect(b).toMatchObject({ colocated: { root: resolve(co) } })
    expect('colocated' in b && real(b.colocated.store)).toBe(real(join(co, '.git')))
    const stray = gitRepo(join(base, `stray-${++n}`))
    mkdirSync(join(stray, '.jj'))
    expect(await boundaryOf(stray)).toEqual({ git: { root: resolve(stray) } })
    expect(await gitVeto(stray)).toBeNull()
    expect(real(await commonGitDir(stray))).toBe(real(join(stray, '.git')))
  })

  it('the store itself (a bare Git dir inside .jj) is Git’s: its own lock is never vetoed', async () => {
    const w = outerWithJj()
    expect(await gitVeto(w.store)).toBeNull()
    expect(real(await commonGitDir(w.store))).toBe(real(w.store))
  })

  it('an outer Git repository made after the jj workspace changes nothing: still jj’s, Git vetoed', async () => {
    const top = join(base, `late-${++n}`)
    const jj = join(top, 'inner')
    jjSeparate(jj)
    expect(await gitVeto(jj)).toMatchObject({ why: 'jj' })
    sh(top, 'init', '-q')
    expect(await boundaryOf(jj)).toMatchObject({ jj: { root: resolve(jj) } })
    await expect(commonGitDir(jj)).rejects.toThrow(/isn't colocated with Git/)
  })
})

describe("the ports' folder answers for a non-colocated jj workspace (s13 §1)", () => {
  it('its context is its store (the lock taken there, never the outer repository’s), its exclude file the store’s, trust its own', async () => {
    const w = outerWithJj()
    const c = await repoContext(w.sub)
    expect(c).toMatchObject({ platform: 'jj', root: resolve(w.jj), subfolder: true })
    expect(real(c!.store)).toBe(real(w.store))
    expect(await withFolderRepoLocks([w.sub], async () => 'ran')).toBe('ran')
    expect(lockTrace.map((l) => l.split(' ')[0])).toEqual(['take', 'release'])
    expect(lockTrace.every((l) => real(l.slice(l.indexOf(' ') + 1)) === real(w.store))).toBe(true)
    expect(real(join((await excludeFile(w.sub, { timeout: 5000 }))!, '..'))).toBe(real(join(w.store, 'info')))
    expect(await trustRoot(w.sub, { timeout: 5000 })).toEqual({ none: true })
    expect(await mainTree(w.sub, { timeout: 5000 })).toEqual({ main: resolve(realpathSync(w.jj)) })
  })
})

describe('one lock owner, whatever platform names the store (s13 §2, s16 §1)', () => {
  /** Two stores whose keys sort as `lo` < `hi`, each with a folder Git names it by. */
  function twoStores(): { lo: string; hi: string } {
    const a = gitRepo(join(base, `ka-${++n}`))
    const b = gitRepo(join(base, `kb-${n}`))
    const [lo, hi] = [a, b].sort((x, y) => (real(join(x, '.git')) < real(join(y, '.git')) ? -1 : 1))
    return { lo, hi }
  }
  const gate = (): { wait: Promise<void>; open: () => void } => {
    let open!: () => void
    const wait = new Promise<void>((r) => (open = r))
    return { wait, open }
  }

  it('both aliases of one store (a colocated folder and its store; a jj workspace and its linked slot) take one lock', async () => {
    const co = gitRepo(join(base, `alias-${++n}`))
    await withFolderRepoLocks([co, join(co, '.git')], async () => undefined)
    expect(lockTrace.filter((l) => l.startsWith('take'))).toHaveLength(1)
    lockTrace.length = 0
    const w = outerWithJj()
    const slot = join(base, `alias-slot-${n}`)
    jjLinked(slot, w.jj)
    await withFolderRepoLocks([w.jj, slot], async () => undefined)
    expect(lockTrace.filter((l) => l.startsWith('take'))).toHaveLength(1)
  })

  it('a nested take of a store a live owner holds runs through (an outer project lock, jj’s storeLock inside it)', async () => {
    const w = outerWithJj()
    const inner = await withFolderRepoLocks([w.jj], () => storeLock(w.store, () => withRepoLock(w.store, async () => 'inner')))
    expect(inner).toBe('inner')
    expect(lockTrace.filter((l) => l.startsWith('take'))).toHaveLength(1)
  })

  it('two takers asking for two stores in opposite orders both finish', async () => {
    const { lo, hi } = twoStores()
    const g = gate()
    const first = withFolderRepoLocks([hi, lo], async () => (await g.wait, 'first'))
    const second = withFolderRepoLocks([lo, hi], async () => 'second')
    await vi.waitUntil(() => lockTrace.filter((l) => l.startsWith('take')).length >= 2)
    g.open()
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
  })

  it('a nested take out of order never waits: refused while held elsewhere, taken when free', async () => {
    const { lo, hi } = twoStores()
    const g = gate()
    const holder = withRepoLock(lo, async () => g.wait)
    await vi.waitUntil(() => lockTrace.some((l) => l.startsWith('take')))
    let ran = false
    await expect(withRepoLock(hi, () => withRepoLock(lo, async () => void (ran = true)))).rejects.toThrow(/busy with another change/)
    expect(ran).toBe(false)
    g.open()
    await holder
    expect(await withRepoLock(hi, () => withRepoLock(lo, async () => 'free'))).toBe('free')
  })

  it('a continuation outliving its take takes the lock again: it waits behind another holder, never runs through it', async () => {
    const w = outerWithJj()
    const order: string[] = []
    const resume = gate()
    let child: Promise<void> | null = null
    await storeLock(w.store, async () => {
      // A deferred child: its context inherited inside A, run after A released.
      child = (async () => {
        await resume.wait
        await storeLock(w.store, async () => void order.push('child'))
      })()
    })
    const bHeld = gate()
    const bGo = gate()
    const b = storeLock(w.store, async () => {
      order.push('B in')
      bHeld.open()
      await bGo.wait
      order.push('B out')
    })
    await bHeld.wait
    resume.open()
    // The child asks while B holds: queued behind B's hold on the store's lock file (B's and its own), not run.
    const file = join(realpathSync(w.store), REPO_LOCK_FILE)
    await vi.waitUntil(() => fileLockDepth(file) >= 2 || order.includes('child'))
    expect(order).toEqual(['B in'])
    bGo.open()
    await b
    await child
    expect(order).toEqual(['B in', 'B out', 'child'])
  })

  it('a failed take ends only its own owner: an outer hold stays held', async () => {
    const { lo, hi } = twoStores()
    const g = gate()
    const holder = withRepoLock(lo, async () => g.wait)
    await vi.waitUntil(() => lockTrace.some((l) => l.startsWith('take')))
    const out = await withRepoLock(hi, async () => {
      await expect(withRepoLock(lo, async () => 'x')).rejects.toThrow(/busy/)
      // Still held: a nested take of hi runs through, no new take.
      const before = lockTrace.length
      await withRepoLock(hi, async () => undefined)
      return lockTrace.length - before
    })
    expect(out).toBe(0)
    g.open()
    await holder
  })
})

describe('another process holding the store', () => {
  const tmp = tempDir('cw-boundary-proc-')
  const bundle = join(tmp, 'child.cjs')
  const children: ChildProcess[] = []
  beforeAll(async () => {
    const entry = join(tmp, 'child-entry.cjs')
    writeFileSync(
      entry,
      `const { appendFileSync, existsSync } = require('fs')
const { takeRepoLock } = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'repoLockCore.ts'))})
const [dir, out] = process.argv.slice(2)
;(async () => {
  const r = await takeRepoLock(dir, { profile: 'Other', waitMs: 60000, pollMs: 25 })
  appendFileSync(out, 'held\\n')
  while (!existsSync(out + '.release')) await new Promise((res) => setTimeout(res, 20))
  r.held.release()
  appendFileSync(out, 'released\\n')
})()
`
    )
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { 'original-fs': 'fs' }, logLevel: 'silent' })
  }, 60_000)
  afterAll(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
  })

  it('a jj store held by another process: the take waits, then gives up saying so, never taking it over', async () => {
    const w = outerWithJj()
    const out = join(tmp, `held-${++n}.txt`)
    writeFileSync(out, '')
    children.push(spawn(process.execPath, [bundle, realpathSync(w.store), out], { env: ctx.baseEnv(), stdio: 'ignore', windowsHide: true }))
    await vi.waitUntil(() => readFileSync(out, 'utf8').includes('held'), { timeout: 30_000, interval: 50 })
    let ran = false
    await expect(withFolderRepoLocks([w.jj], async () => void (ran = true))).rejects.toThrow(/Another Combwork is merging/)
    expect(ran).toBe(false)
    writeFileSync(`${out}.release`, '')
    await vi.waitUntil(() => readFileSync(out, 'utf8').includes('released'), { timeout: 30_000, interval: 50 })
    expect(await withFolderRepoLocks([w.jj], async () => 'mine')).toBe('mine')
    expect(existsSync(w.store)).toBe(true)
  })
})
