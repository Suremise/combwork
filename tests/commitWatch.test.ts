// React's commit watch in test copies (HI-1387, step 1: recorded, nothing fails on it yet): the burst counter, the
// console line lib.cjs reads, and that only a test copy's window turns it on. The hook in a real window: the commitburst
// e2e.
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { burstCounter, burstOf, COMMIT_BURST_LIMIT, COMMIT_BURST_MARKER, COMMIT_BURST_WINDOW_MS, COMMIT_WATCH_ARG } from '../src/shared/commitWatch'

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

  it("reads lib.cjs's console line, and nothing else", () => {
    expect(burstOf(`${COMMIT_BURST_MARKER} 57`)).toBe(57)
    expect(burstOf(`${COMMIT_BURST_MARKER} x`)).toBeNull()
    expect(burstOf('a burst of 57')).toBeNull()
    // lib.cjs (CommonJS, no TypeScript) has its own copy of the marker, the limit and the window: the same.
    const lib = read('tests/e2e/lib.cjs')
    expect(lib).toContain(`const COMMIT_BURST_MARKER = '${COMMIT_BURST_MARKER}'`)
    expect(lib).toContain(`const COMMIT_BURST_LIMIT = ${COMMIT_BURST_LIMIT}`)
    expect(lib).toContain(`within ${COMMIT_BURST_WINDOW_MS} ms`)
  })

  describe("lib.cjs's record of a suite's bursts (burstWatcher)", () => {
    type Page = { on: (e: string, f: (m: { text: () => string }) => void) => void; evaluate: () => Promise<unknown>; say: (t: string) => void }
    const { burstWatcher } = createRequire(import.meta.url)('./e2e/lib.cjs') as {
      burstWatcher: (o?: { onFirst?: () => void; onReach?: (n: number) => void }) => { watch: (p: Page) => void; largest: () => number | null; windows: () => number[] }
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
  })

  it("is on only in a test copy's window, and installed before React DOM loads", () => {
    // Main passes the argument only to a quiet test copy's window; the preload reads it; the page installs the hook first.
    expect(read('src/main/index.ts')).toContain('additionalArguments: testQuiet() ? [COMMIT_WATCH_ARG] : []')
    expect(read('src/preload/index.ts')).toContain('commitWatch: process.argv.includes(COMMIT_WATCH_ARG)')
    expect(COMMIT_WATCH_ARG).toMatch(/^--hive-/)
    const main = read('src/renderer/src/main.tsx')
    const firstImport = main.split(/\r?\n/).find((l) => l.startsWith('import '))
    expect(firstImport).toBe("import './commitWatch'")
    // It imports nothing of React's (React DOM would load before the hook).
    expect(read('src/renderer/src/commitWatch.ts')).not.toMatch(/from 'react/)
  })
})
