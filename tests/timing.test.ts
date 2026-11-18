// HI-3378: the tests' one timing file, read by name (tests/timing.cjs), and the check:repo guard that keeps numbers out of
// new waits (scripts/timingLiterals.mjs). The file's entries are checked; an unknown name throws; CW_TEST_TIMING merges an
// override file by name (an unknown name or a bad value an error); CW_TEST_TIMING_SCALE scales the hang values alone.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readDefaults, resolve, timing, timings } from './timing.cjs'
import { tempDir } from './tempDir'

const dir = tempDir('cw-timing-')
mkdirSync(dir, { recursive: true })
const file = (name: string, body: unknown): string => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(body))
  return p
}

describe('the tests’ timing file (HI-3378)', () => {
  it("every entry has a kind and a positive value; the card's names are there", () => {
    const d = readDefaults()
    expect(Object.keys(d).length).toBeGreaterThan(20)
    for (const [name, v] of Object.entries(d)) {
      expect(['hang', 'budget', 'quiet', 'pace', 'interval', 'seam'], name).toContain(v.kind)
      expect(v.ms, name).toBeGreaterThan(0)
    }
    expect(d['test.hang']).toMatchObject({ kind: 'hang', ms: 120_000 })
    expect(d['hang.ui']).toMatchObject({ kind: 'hang', ms: 30_000 })
    expect(d['poll.intervalMs']).toMatchObject({ kind: 'interval', ms: 100 })
    expect(d['quiet.nothingMs']).toMatchObject({ kind: 'quiet' })
  })

  it('by name; an unknown name throws, never a default', () => {
    expect(timing('wait.hang')).toBe(timings()['wait.hang'].ms)
    expect(() => timing('wait.hnag')).toThrow(/no timing named wait\.hnag/)
  })

  it('CW_TEST_TIMING merges an override file by name, plain numbers or entries; an unknown name or a bad value is an error', () => {
    const over = resolve({ CW_TEST_TIMING: file('over.json', { $comment: 'x', 'wait.hang': 5000, 'hang.ui': { ms: 7000 } }) })
    expect([over['wait.hang'].ms, over['hang.ui'].ms, over['test.hang'].ms]).toEqual([5000, 7000, 120_000])
    expect(() => resolve({ CW_TEST_TIMING: file('typo.json', { 'wait.hnag': 5000 }) })).toThrow(/no timing named wait\.hnag/)
    expect(() => resolve({ CW_TEST_TIMING: file('bad.json', { 'wait.hang': -1 }) })).toThrow(/positive number/)
  })

  it('CW_TEST_TIMING_SCALE scales the hang values alone: a budget, a quiet window or an interval keeps its number', () => {
    const d = readDefaults()
    const scaled = resolve({ CW_TEST_TIMING_SCALE: '2' })
    for (const [name, v] of Object.entries(d)) expect(scaled[name].ms, name).toBe(v.kind === 'hang' ? v.ms * 2 : v.ms)
    expect(() => resolve({ CW_TEST_TIMING_SCALE: 'fast' })).toThrow(/positive number/)
  })

  it("CI's file (tests/timing.ci.json) names only timings there are, with positive values", () => {
    const ci = resolve({ CW_TEST_TIMING: join(__dirname, 'timing.ci.json') })
    expect(ci['test.hang'].ms).toBeGreaterThan(readDefaults()['test.hang'].ms)
  })
})

describe('the guard: no literal waits in new test code (HI-3378, scripts/timingLiterals.mjs)', async () => {
  // @ts-expect-error: a plain .mjs module without types
  const { literalsIn, checkTree } = await import('../scripts/timingLiterals.mjs')
  const kinds = (src: string): string[] => literalsIn(src).map((l: { kind: string }) => l.kind)

  it("finds each kind the card names, with a number written in place", () => {
    expect(kinds("it('x', async () => {}, 30000)")).toEqual(['testTimeout'])
    expect(kinds('vi.setConfig({ testTimeout: 60_000 })')).toEqual(['setConfig'])
    expect(kinds('await vi.waitFor(() => expect(a).toBe(1), { timeout: 5000 })')).toEqual(['timeout'])
    expect(kinds("await page.locator('.x').waitFor({ timeout: 2000 })")).toEqual(['timeout'])
    expect(kinds('const r = await lib.until(async () => ok(), 10000)')).toEqual(['until'])
    expect(kinds('await lib.sleep(500)')).toEqual(['sleep'])
    expect(kinds('await page.waitForTimeout(300)')).toEqual(['sleep'])
    expect(kinds('await new Promise((r) => setTimeout(r, 200))')).toEqual(['promiseSleep'])
    expect(kinds('while (!done() && Date.now() - t < 5000) await tick()')).toEqual(['clockLoop'])
    expect(kinds('const HUNG_MS = 15000')).toEqual(['msConstant'])
    expect(kinds('expect(Date.now() - t0).toBeLessThan(2000)')).toEqual(['clockAssert'])
  })

  it("names from the file, simulated time, a number in a string or a comment, and an opted-out line are none", () => {
    expect(kinds("await vi.waitFor(() => expect(a).toBe(1), { timeout: timing('wait.hang') })")).toEqual([])
    expect(kinds("const r = await lib.until(async () => ok(), lib.timing('hang.ui'))")).toEqual([])
    expect(kinds('vi.advanceTimersByTime(5000)')).toEqual([])
    expect(kinds("check('waits 5000 ms', ok) // timeout: 5000")).toEqual([])
    expect(kinds('run({ timeout: 5000 }) // timing-ok: the value under test')).toEqual([])
    expect(kinds('// timing-ok: the child lives this long\nspawn(x, { timeout: 30000 })')).toEqual([])
    expect(kinds('expect(list.length).toBeLessThan(3)')).toEqual([])
  })

  it('a file not on the allow list with one fails; a listed file is the backlog; a listed file with none left fails', () => {
    const files = { 'tests/a.test.ts': 'await lib.sleep(500)', 'tests/b.test.ts': 'await lib.sleep(500)', 'tests/c.test.ts': "it('ok', () => {})" }
    const r = checkTree(Object.keys(files), ['tests/b.test.ts', 'tests/c.test.ts', 'tests/gone.test.ts'], (f: string) => files[f as keyof typeof files])
    expect(r.found.map((f: { file: string }) => f.file)).toEqual(['tests/a.test.ts'])
    expect(r.backlog).toEqual([{ file: 'tests/b.test.ts', count: 1 }])
    expect(r.cleared.sort()).toEqual(['tests/c.test.ts', 'tests/gone.test.ts'])
  })
})
