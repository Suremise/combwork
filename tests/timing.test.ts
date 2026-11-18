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
      expect(['hang', 'budget', 'quiet', 'pace', 'interval', 'seam', 'lock'], name).toContain(v.kind)
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

describe("the reader's edges (HR1's round 1)", () => {
  it("names are own properties only: an inherited one is no timing, from the file, an override or a lookup", () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(() => timing(name), name).toThrow(/no timing named/)
    expect(() => resolve({ CW_TEST_TIMING: file('proto.json', JSON.parse('{"__proto__": 5000}')) })).toThrow(/no timing named __proto__/)
    expect(() => resolve({ CW_TEST_TIMING: file('ctor.json', { constructor: 5000 }) })).toThrow(/no timing named constructor/)
  })

  it("every value in force is from 1 ms to a Node timer's most, after an override and after scaling: never 0, never Infinity", () => {
    expect(() => resolve({ CW_TEST_TIMING_SCALE: '0.00000001' })).toThrow(/outside 1 to/)
    expect(() => resolve({ CW_TEST_TIMING_SCALE: '1e308' })).toThrow(/outside 1 to/)
    expect(() => resolve({ CW_TEST_TIMING: file('huge.json', { 'wait.hang': 2 ** 31 }) })).toThrow(/outside 1 to/)
    expect(() => resolve({ CW_TEST_TIMING: file('zero.json', { 'wait.hang': 0 }) })).toThrow(/positive number/)
    expect(resolve({ CW_TEST_TIMING_SCALE: '0.5' })['wait.hang'].ms).toBe(readDefaults()['wait.hang'].ms / 2)
  })

  it("a lock's age (when another run may take the runner's claims lock) is never scaled: a narrow scale can't break a live holder's lock", () => {
    const d = readDefaults()
    expect(d['runner.lockStaleMs'].kind).toBe('lock')
    for (const scale of ['0.01', '10']) expect(resolve({ CW_TEST_TIMING_SCALE: scale })['runner.lockStaleMs'].ms, scale).toBe(d['runner.lockStaleMs'].ms)
  })
})

describe('the guard: no literal waits in new test code (HI-3378, scripts/timingLiterals.mjs)', async () => {
  // @ts-expect-error: a plain .mjs module without types
  const { literalsIn, checkTree } = await import('../scripts/timingLiterals.mjs')
  const kinds = (src: string): string[] => literalsIn(src).map((l: { kind: string }) => l.kind)
  /** The guard over files (name to source) against a baseline made from `was` (what the backlog held). */
  const verdict = (now: Record<string, string>, was: Record<string, string>) => {
    const baseline: Record<string, string[]> = {}
    for (const [f, src] of Object.entries(was)) baseline[f] = literalsIn(src).map((l: { key: string }) => l.key)
    return checkTree(Object.keys(now), baseline, (f: string) => now[f])
  }

  it('finds each kind the card names, with a number written in place', () => {
    expect(kinds("it('x', async () => {}, 30000)")).toEqual(['testTimeout'])
    expect(kinds('vi.setConfig({ testTimeout: 60_000 })')).toEqual(['setConfig'])
    expect(kinds('await vi.waitFor(() => expect(a).toBe(1), { timeout: 5000 })')).toEqual(['timeout'])
    expect(kinds("await page.locator('.x').waitFor({ timeout: 2000 })")).toEqual(['timeout'])
    expect(kinds('const r = await lib.until(async () => ok(), 10000)')).toEqual(['until'])
    // A helper named until that counts something (until('reads', 2): two reads seen) has no bound: its first argument is no check.
    expect(kinds("await until('reads', 2)")).toEqual([])
    expect(kinds('await until(check, 9000)')).toEqual(['until'])
    expect(kinds('await lib.sleep(500)')).toEqual(['sleep'])
    expect(kinds('await page.waitForTimeout(300)')).toEqual(['sleep'])
    expect(kinds('await new Promise((r) => setTimeout(r, 200))')).toEqual(['promiseSleep'])
    expect(kinds('while (!done() && Date.now() - t < 5000) await tick()')).toEqual(['clockLoop'])
    expect(kinds('const HUNG_MS = 15000')).toEqual(['msConstant'])
    expect(kinds('expect(Date.now() - t0).toBeLessThan(2000)')).toEqual(['clockAssert'])
  })

  it("read from the syntax tree (HR1's round 2): a regular expression inside, a trailing comma, it.each(…)(…); a regular expression that looks like a wait is none", () => {
    expect(kinds("it('x', async () => { const re = /\\)/; work(re) }, 12345)")).toEqual(['testTimeout'])
    expect(kinds("it('x', () => {}, 12345,)")).toEqual(['testTimeout'])
    expect(kinds("it.each([1, 2])('x %s', async (n) => { work(n) }, 12345)")).toEqual(['testTimeout'])
    expect(kinds("test.each`a\n${1}`('x', () => {}, 30000)")).toEqual(['testTimeout'])
    expect(kinds('const pattern = /sleep(500)/;')).toEqual([])
    expect(kinds('const pattern = /setTimeout\\(r, 200\\)/')).toEqual([])
    // A file the guard can't parse is a finding of its own, never a pass by silence.
    expect(kinds('const x = (')).toEqual(['unparsed'])
  })

  it("written over several lines too (HR1's round 1): a test's timeout, until's bound, a Promise's sleep, options", () => {
    expect(kinds("it('x', async () => {\n  work()\n}, 12345)")).toEqual(['testTimeout'])
    expect(kinds("describe('d', () => {\n  it('x', () => {})\n}, 45000)")).toEqual(['testTimeout'])
    expect(kinds('new Promise((r) => {\n  setTimeout(r, 23456)\n})')).toEqual(['promiseSleep'])
    expect(kinds('await lib.until(\n  async () => ok(),\n  9000\n)')).toEqual(['until'])
    expect(kinds('await vi.waitFor(\n  () => expect(a).toBe(1),\n  {\n    timeout: 7000\n  }\n)')).toEqual(['timeout'])
    expect(kinds('expect(\n  Date.now() - t0\n).toBeLessThan(\n  2000\n)')).toEqual(['clockAssert'])
  })

  it('names from the file, simulated time, a number in a string or a comment, and an opted-out line are none; simulated time exempts only itself', () => {
    expect(kinds("await vi.waitFor(() => expect(a).toBe(1), { timeout: timing('wait.hang') })")).toEqual([])
    expect(kinds("const r = await lib.until(async () => ok(), lib.timing('hang.ui'))")).toEqual([])
    expect(kinds("it('x', async () => {}, timing('test.hangReal'))")).toEqual([])
    expect(kinds('vi.advanceTimersByTime(5000)')).toEqual([])
    expect(kinds('vi.advanceTimersByTime(5000); await lib.sleep(500)')).toEqual(['sleep'])
    expect(kinds('vi.useFakeTimers()\nawait new Promise((r) => setTimeout(r, 200))')).toEqual(['promiseSleep'])
    expect(kinds("check('waits 5000 ms, timeout: 5000', ok) // timeout: 5000")).toEqual([])
    expect(kinds('const t = `sleep(500) ${x}`')).toEqual([])
    expect(kinds('run({ timeout: 5000 }) // timing-ok: the value under test')).toEqual([])
    expect(kinds('// timing-ok: the child lives this long\nspawn(x, { timeout: 30000 })')).toEqual([])
    expect(kinds('expect(list.length).toBeLessThan(3)')).toEqual([])
    expect(kinds('await lib.until(fn, HUNG, 200)')).toEqual([])
  })

  it("a backlog file's existing literals pass; one added to it, or one changed, fails (HR1's round 1)", () => {
    const was = { 'tests/old.test.ts': 'await lib.sleep(500)\nit("x", () => {}, 30000)' }
    expect(verdict(was, was).found).toEqual([])
    const added = verdict({ 'tests/old.test.ts': 'await lib.sleep(500)\nawait lib.sleep(9999)\nit("x", () => {}, 30000)' }, was)
    expect(added.found.map((f: { line: number; kind: string }) => [f.line, f.kind])).toEqual([[2, 'sleep']])
    // The same literal twice where the baseline holds it once: the second is new.
    expect(verdict({ 'tests/old.test.ts': 'await lib.sleep(500)\nawait lib.sleep(500)\nit("x", () => {}, 30000)' }, was).found).toHaveLength(1)
    const changed = verdict({ 'tests/old.test.ts': 'await lib.sleep(750)\nit("x", () => {}, 30000)' }, was)
    expect(changed.found.map((f: { kind: string }) => f.kind)).toEqual(['sleep'])
    expect(changed.stale.map((x: { key: string }) => x.key)).toEqual(['sleep await lib.sleep(500)'])
    // A file not in the baseline: each literal is new.
    expect(verdict({ 'tests/new.test.ts': 'await lib.sleep(500)' }, {}).found).toHaveLength(1)
  })

  it('a migration that removes a literal leaves its entry stale (a failure) until --shrink drops it; the shrunk baseline only loses entries', () => {
    const was = { 'tests/old.test.ts': 'await lib.sleep(500)\nit("x", () => {}, 30000)', 'tests/gone.test.ts': 'await lib.sleep(1)' }
    const migrated = verdict({ 'tests/old.test.ts': "await lib.sleep(timing('quiet.nothingMs'))\nit(\"x\", () => {}, 30000)" }, was)
    expect(migrated.found).toEqual([])
    expect(migrated.stale.map((x: { file: string }) => x.file).sort()).toEqual(['tests/gone.test.ts', 'tests/old.test.ts'])
    expect(migrated.shrunk).toEqual({ 'tests/old.test.ts': ['testTimeout it("x", () => {}, 30000)'] })
    expect(migrated.backlog).toEqual([{ file: 'tests/old.test.ts', count: 1 }])
  })
})
