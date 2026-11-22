// The one repository-lock owner (HI-2896, J9f; design HI-2896/s13 and s16, HR1's): every take resolves to stores, each
// once, in one order; a nested take of a store a live owner holds runs through, a continuation outliving its take takes
// the lock again, an out-of-order nested take never waits; another process holding a store makes the take wait, then give
// up, never taking it over.
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'
import { gitRepo } from './workflow/harness'
import { timing } from './timing.cjs'

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

const { withRepoLock } = await import('../src/main/repoLock')
const { withFolderRepoLocks } = await import('../src/main/platform/repoPorts')
const { fileLockDepth } = await import('../src/main/fsutil')
const { REPO_LOCK_FILE } = await import('../src/main/repoLockCore')

vi.setConfig({ testTimeout: timing('test.hang') })
afterEach(() => void (lockTrace.length = 0))

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs')
const base = tempDir('cw-lockowner-')
const real = (p: string): string => resolve(realpathSync(p)).toLowerCase()

let n = 0

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

  it('both aliases of one store (a folder and its store) take one lock', async () => {
    const co = gitRepo(join(base, `alias-${++n}`))
    await withFolderRepoLocks([co, join(co, '.git')], async () => undefined)
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

  it('an inherited claim that expires while the take waits for its other store: taken again, never run while another holds it (HR1’s round 1)', async () => {
    const { lo: x, hi: y } = twoStores()
    const order: string[] = []
    // H holds Y, so the child waits for it.
    const hIn = gate()
    const hGo = gate()
    const h = withRepoLock(y, async () => (hIn.open(), await hGo.wait))
    await hIn.wait
    // A holds X; its child asks for X (left to A) and Y (waited for), and A returns without waiting for it.
    let child: Promise<void> | null = null
    await withRepoLock(x, async () => {
      child = withFolderRepoLocks([x, y], async () => void order.push('child'))
      await vi.waitUntil(() => fileLockDepth(join(realpathSync(join(y, '.git')), REPO_LOCK_FILE)) >= 2)
    })
    // B takes X once A released it, and holds it.
    const bIn = gate()
    const bGo = gate()
    const b = withRepoLock(x, async () => (order.push('B in'), bIn.open(), await bGo.wait, order.push('B out')))
    await bIn.wait
    // Y is freed: the child has its own lock, finds A's claim on X gone, and takes X itself, behind B.
    hGo.open()
    await h
    await vi.waitUntil(() => fileLockDepth(join(realpathSync(join(x, '.git')), REPO_LOCK_FILE)) >= 2 || order.includes('child'))
    expect(order).toEqual(['B in'])
    bGo.open()
    await b
    await child
    expect(order).toEqual(['B in', 'B out', 'child'])
  })

  describe('a callback admitted on an inherited claim keeps its owner’s lock until it settles (s104, HR1’s round 2)', () => {
    const lockFile = (dir: string): string => join(realpathSync(join(dir, '.git')), REPO_LOCK_FILE)
    // Every gate a test opened is opened again after it, whatever it asserted: no lock is left held for the next test.
    const gates: { open: () => void }[] = []
    afterEach(() => {
      for (const g of gates.splice(0)) g.open()
    })
    /** A holds X; inside it, a child takes `stores` (X among them), is admitted, and parks on a gate; A doesn't await it. */
    async function parkedChild(x: string, stores: string[], o: { order: string[]; aFails?: boolean; childFails?: boolean }) {
      const park = gate()
      const admitted = gate()
      gates.push(park, admitted)
      let child: Promise<unknown> | null = null
      const a = withRepoLock(x, async () => {
        child = withFolderRepoLocks(stores, async () => {
          admitted.open()
          await park.wait
          o.order.push('child resumed')
          if (o.childFails) throw new Error('child failed')
          o.order.push('child done')
        }).catch((e: Error) => void o.order.push(`child: ${e.message}`))
        await admitted.wait
        if (o.aFails) throw new Error('A failed')
        return 'A'
      })
      await admitted.wait
      return { a, park, child: () => child! }
    }

    it('inherited only: A returns, B asks for X and waits; the child resumes and finishes first, then B runs', async () => {
      const { lo: x } = twoStores()
      const order: string[] = []
      const { a, park, child } = await parkedChild(x, [x], { order })
      let aDone = false
      void a.then(() => (aDone = true))
      const b = withRepoLock(x, async () => void order.push('B in'))
      // B queued behind the held lock; A hasn't returned to its caller, its child still parked.
      await vi.waitUntil(() => fileLockDepth(lockFile(x)) >= 2 || order.includes('B in'))
      expect(order).toEqual([])
      expect(aDone).toBe(false)
      park.open()
      expect(await a).toBe('A')
      await child()
      await b
      expect(order).toEqual(['child resumed', 'child done', 'B in'])
    })

    it('mixed (an inherited store and its own): B waits for X until the child is done; its own Y is free again after', async () => {
      const { lo: x, hi: y } = twoStores()
      const order: string[] = []
      const { a, park, child } = await parkedChild(x, [x, y], { order })
      const b = withRepoLock(x, async () => void order.push('B in'))
      await vi.waitUntil(() => fileLockDepth(lockFile(x)) >= 2 || order.includes('B in'))
      expect(order).toEqual([])
      expect(fileLockDepth(lockFile(y))).toBe(1)
      park.open()
      await a
      await child()
      await b
      expect(order).toEqual(['child resumed', 'child done', 'B in'])
      expect(await withRepoLock(y, async () => 'Y free')).toBe('Y free')
    })

    it("the owner failing: its error reaches its caller only once the child has settled, and B waits for X until then", async () => {
      const { lo: x } = twoStores()
      const order: string[] = []
      const { a, park, child } = await parkedChild(x, [x], { order, aFails: true })
      let aSettled = false
      const aOut = a.then(
        () => 'resolved',
        (e: Error) => ((aSettled = true), e.message)
      )
      const b = withRepoLock(x, async () => void order.push('B in'))
      await vi.waitUntil(() => fileLockDepth(lockFile(x)) >= 2 || order.includes('B in'))
      expect(aSettled).toBe(false)
      expect(order).toEqual([])
      park.open()
      expect(await aOut).toBe('A failed')
      await child()
      await b
      expect(order).toEqual(['child resumed', 'child done', 'B in'])
    })

    it('the child failing synchronously (its callback throws before returning a promise): unpinned at once, A returns, X released', async () => {
      const { lo: x } = twoStores()
      const order: string[] = []
      const a = withRepoLock(x, async () => {
        const child = withFolderRepoLocks([x], (() => {
          throw new Error('sync failure')
        }) as () => Promise<void>)
        await child.catch((e: Error) => void order.push(`child: ${e.message}`))
        return 'A'
      })
      expect(await a).toBe('A')
      expect(await withRepoLock(x, async () => (order.push('B in'), 'B'))).toBe('B')
      expect(order).toEqual(['child: sync failure', 'B in'])
    })

    it('the child failing: A still returns its own value, and X is released after the child', async () => {
      const { lo: x } = twoStores()
      const order: string[] = []
      const { a, park, child } = await parkedChild(x, [x], { order, childFails: true })
      const b = withRepoLock(x, async () => void order.push('B in'))
      park.open()
      expect(await a).toBe('A')
      await child()
      await b
      expect(order).toEqual(['child resumed', 'child: child failed', 'B in'])
    })
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
  const tmp = tempDir('cw-lockowner-proc-')
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
  }, timing('hook.hang'))
  afterAll(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill()
  })

  it('a store held by another process: the take waits, then gives up saying so, never taking it over', async () => {
    const repo = gitRepo(join(base, `held-repo-${++n}`))
    const store = join(repo, '.git')
    const out = join(tmp, `held-${++n}.txt`)
    writeFileSync(out, '')
    children.push(spawn(process.execPath, [bundle, realpathSync(store), out], { env: ctx.baseEnv(), stdio: 'ignore', windowsHide: true }))
    await vi.waitUntil(() => readFileSync(out, 'utf8').includes('held'), { timeout: timing('wait.hang'), interval: 50 })
    let ran = false
    await expect(withFolderRepoLocks([repo], async () => void (ran = true))).rejects.toThrow(/Another Combwork is merging/)
    expect(ran).toBe(false)
    writeFileSync(`${out}.release`, '')
    await vi.waitUntil(() => readFileSync(out, 'utf8').includes('released'), { timeout: timing('wait.hang'), interval: 50 })
    expect(await withFolderRepoLocks([repo], async () => 'mine')).toBe('mine')
    expect(existsSync(store)).toBe(true)
  })
})
