// React's commit watch in test copies (HI-1387): the burst counter, the console line lib.cjs reads, and that only a test
// copy's window turns it on. The hook in a real window: the commitburst e2e. The commit chain beside it (HI-1865):
// commits with nothing from outside between them, which fails a suite at React's nested-update limit (the burst is
// recorded only).
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { burstCounter, burstOf, chainCounter, chainOf, COMMIT_BURST_LIMIT, COMMIT_BURST_MARKER, COMMIT_BURST_WINDOW_MS, COMMIT_CHAIN_MARKER, COMMIT_WATCH_ARG, FROM_MAIN_EVENT } from '../src/shared/commitWatch'

const root = join(__dirname, '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')

describe("React's commit watch (HI-1387)", () => {
  it('counts the most commits within its window, forgetting those that have left it', () => {
    const c = burstCounter(250)
    expect([0, 10, 20].map((t) => c.add(t))).toEqual([1, 2, 3])
    // 260 ms after the first: it and the one at 10 have left the window.
    expect(c.add(260)).toBe(3)
    expect(c.add(1000)).toBe(1)
    expect(c.max).toBe(3)
    // A loop's burst: 60 commits 1 ms apart.
    for (let t = 2000; t < 2060; t++) c.add(t)
    expect(c.max).toBe(60)
    // Long runs keep only the window's times (dropped in batches), and count the same.
    const long = burstCounter(250)
    for (let t = 0; t < 50_000; t += 10) long.add(t)
    expect(long.max).toBe(26)
  })

  it('counts commit chains: commits in a row with nothing from outside between them (HI-1865)', () => {
    const c = chainCounter()
    // Fast typing: a key, a commit or two, the next key: however many, each its own short chain.
    for (let k = 0; k < 100; k++) {
      c.outside()
      c.commit()
      if (k % 2) c.commit()
    }
    expect(c.max).toBe(2)
    // A loop: one commit after another with nothing between.
    c.outside()
    for (let k = 0; k < 80; k++) c.commit()
    expect(c.max).toBe(80)
    // Something from outside starts a new one; the longest is kept.
    c.outside()
    expect(c.commit()).toBe(1)
    expect(c.max).toBe(80)
    // Several things from outside before a commit are one start; the first commit ever starts one too.
    const d = chainCounter()
    expect(d.commit()).toBe(1)
    d.outside()
    d.outside()
    expect([d.commit(), d.commit()]).toEqual([1, 2])
  })

  it("reads lib.cjs's console line, and nothing else", () => {
    expect(burstOf(`${COMMIT_BURST_MARKER} 57`)).toBe(57)
    expect(burstOf(`${COMMIT_BURST_MARKER} x`)).toBeNull()
    expect(burstOf('a burst of 57')).toBeNull()
    expect(chainOf(`${COMMIT_CHAIN_MARKER} 82`)).toBe(82)
    expect(chainOf(`${COMMIT_BURST_MARKER} 82`)).toBeNull()
    expect(burstOf(`${COMMIT_CHAIN_MARKER} 82`)).toBeNull()
    // lib.cjs (CommonJS, no TypeScript) has its own copy of the marker, the limit and the window: the same.
    const lib = read('tests/e2e/lib.cjs')
    expect(lib).toContain(`const COMMIT_BURST_MARKER = '${COMMIT_BURST_MARKER}'`)
    expect(lib).toContain(`const COMMIT_CHAIN_MARKER = '${COMMIT_CHAIN_MARKER}'`)
    expect(lib).toContain(`const COMMIT_BURST_LIMIT = ${COMMIT_BURST_LIMIT}`)
    expect(lib).toContain(`within ${COMMIT_BURST_WINDOW_MS} ms`)
  })

  describe("lib.cjs's record of a suite's bursts (burstWatcher)", () => {
    type Page = { on: (e: string, f: (m: { text: () => string }) => void) => void; evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>; say: (t: string) => void }
    const { burstWatcher } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
      burstWatcher: (o?: { onFirst?: () => void; onReach?: (n: number) => void; marker?: string; read?: string }) => { watch: (p: Page) => void; largest: () => number | null; windows: () => number[] }
    }
    /** A window: its console's lines, and what its page says its count is (or a failure, a page gone). */
    const pageOf = (count: unknown): Page => {
      const listeners: ((m: { text: () => string }) => void)[] = []
      return {
        on: (_e, f) => listeners.push(f),
        evaluate: () => (count instanceof Error ? Promise.reject(count) : Promise.resolve(count)),
        say: (t) => listeners.forEach((f) => f({ text: () => t }))
      }
    }
    const settled = () => new Promise((r) => setImmediate(r))

    it('has a burst a window reached before its listener was there, read from the page (HR5, round 1)', async () => {
      const w = burstWatcher()
      w.watch(pageOf(84))
      await settled()
      expect(w.largest()).toBe(84)
    })

    it('records a suite whose largest stays small, and tells no report (no watch) from a burst', async () => {
      const w = burstWatcher()
      expect(w.largest()).toBeNull()
      const p = pageOf(undefined)
      w.watch(p)
      await settled()
      // A page with no watch (undefined): still nothing.
      expect(w.largest()).toBeNull()
      p.say(`${COMMIT_BURST_MARKER} 1`)
      p.say(`${COMMIT_BURST_MARKER} 3`)
      p.say('something else')
      expect(w.largest()).toBe(3)
    })

    it("keeps each window's own largest, the suite's the largest of them, and says the first report and the limit once", async () => {
      let first = 0
      const reached: number[] = []
      const w = burstWatcher({ onFirst: () => first++, onReach: (n) => reached.push(n) })
      const a = pageOf(12)
      const b = pageOf(new Error('Target page, context or browser has been closed'))
      w.watch(a)
      w.watch(b)
      await settled()
      b.say(`${COMMIT_BURST_MARKER} 5`)
      expect(w.windows().sort((x, y) => x - y)).toEqual([5, 12])
      expect(w.largest()).toBe(12)
      for (const n of [40, 50, 51, 84]) b.say(`${COMMIT_BURST_MARKER} ${n}`)
      // A late, smaller report from a page doesn't lower its own.
      a.say(`${COMMIT_BURST_MARKER} 7`)
      expect(w.windows().sort((x, y) => x - y)).toEqual([12, 84])
      expect(w.largest()).toBe(84)
      expect(first).toBe(1)
      expect(reached).toEqual([50])
    })

    it("records the chain the same way, from its own marker and the page's chain (HI-1865)", async () => {
      const reached: number[] = []
      const w = burstWatcher({ marker: COMMIT_CHAIN_MARKER, read: 'chain', onReach: (n) => reached.push(n) })
      // The page's count, as __hiveCommitBurst() gives both: the field it asks for.
      const listeners: ((m: { text: () => string }) => void)[] = []
      const p: Page = {
        on: (_e, f) => listeners.push(f),
        evaluate: (fn, field) => Promise.resolve((fn as (f: unknown) => unknown).call(null, field)),
        say: (t) => listeners.forEach((f) => f({ text: () => t }))
      }
      ;(globalThis as unknown as { window: unknown }).window = { __hiveCommitBurst: () => ({ max: 65, chain: 2 }) }
      try {
        w.watch(p)
        await settled()
      } finally {
        delete (globalThis as unknown as { window?: unknown }).window
      }
      expect(w.largest()).toBe(2)
      // The burst's lines are another count's: not this one's.
      p.say(`${COMMIT_BURST_MARKER} 65`)
      expect(w.largest()).toBe(2)
      p.say(`${COMMIT_CHAIN_MARKER} 82`)
      expect(w.largest()).toBe(82)
      expect(reached).toEqual([82])
    })

    it('fails a suite whose chain reaches the limit as it exits, though it ends with process.exit(0), unless it accepts it (HI-1865)', () => {
      const { baseEnv } = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => NodeJS.ProcessEnv }
      // A suite of a few lines: its window a stand-in saying a chain on its console.
      const suite = (chain: number, accept = '') => {
        const script = [
          'const lib = require(process.argv[1]); const listeners = []',
          "const page = { on: (e, f) => { if (e === 'console') listeners.push(f) }, evaluate: async () => undefined }",
          'lib.watchCommitBursts({ windows: () => [page], on: () => {} })',
          `for (const f of listeners) f({ text: () => '${COMMIT_CHAIN_MARKER} ${chain}' })`,
          'if (process.argv[2]) lib.acceptCommitChain(process.argv[2])',
          'process.exit(0)'
        ].join('\n')
        const r = spawnSync(process.execPath, ['-e', script, join(root, 'tests', 'e2e', 'lib.cjs'), accept], { env: baseEnv(), encoding: 'utf8' })
        return { code: r.status, lines: String(r.stdout).split(/\r?\n/).filter(Boolean) }
      }
      const under = suite(COMMIT_BURST_LIMIT - 1)
      expect(under.code).toBe(0)
      expect(under.lines.some((l) => l.startsWith(`INFO React commit chain: the longest was ${COMMIT_BURST_LIMIT - 1} `))).toBe(true)
      const loop = suite(COMMIT_BURST_LIMIT)
      expect(loop.code).toBe(1)
      expect(loop.lines.some((l) => l.startsWith(`FAIL React commit chain: the longest was ${COMMIT_BURST_LIMIT} `))).toBe(true)
      const accepted = suite(80, 'its loop is on purpose')
      expect(accepted.code).toBe(0)
      expect(accepted.lines.some((l) => l.startsWith('FAIL'))).toBe(false)
      expect(accepted.lines.some((l) => l.includes('accepted by the suite: its loop is on purpose'))).toBe(true)
    })
  })

  it("is on only in a test copy's window, and installed before React DOM loads", () => {
    // Main passes the argument only to a quiet test copy's window; the preload reads it; the page installs the hook first.
    expect(read('src/main/index.ts')).toContain('additionalArguments: testQuiet() ? [COMMIT_WATCH_ARG] : []')
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('const commitWatch = process.argv.includes(COMMIT_WATCH_ARG)')
    // It tells the page of each message and reply from main (the chain's outside, HI-1865), before the page's own code.
    expect(preload).toContain('if (commitWatch) window.dispatchEvent(new Event(FROM_MAIN_EVENT))')
    expect(FROM_MAIN_EVENT).toMatch(/^hive-/)
    expect(COMMIT_WATCH_ARG).toMatch(/^--hive-/)
    const main = read('src/renderer/src/main.tsx')
    const firstImport = main.split(/\r?\n/).find((l) => l.startsWith('import '))
    expect(firstImport).toBe("import './commitWatch'")
    // It imports nothing of React's (React DOM would load before the hook).
    expect(read('src/renderer/src/commitWatch.ts')).not.toMatch(/from 'react/)
  })
})
