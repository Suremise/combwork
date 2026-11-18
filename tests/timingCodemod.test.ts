// HI-3382: the e2e suites' and scenarios' waits moved to names (scripts/timingCodemod.mjs), read by syntax: only hang
// bounds move, never shorter than they were; negative waits, expected rejections, short action budgets, zeros and
// non-hang constants are left and reported. A string, a comment or a regular expression that looks like a wait is none.
import { describe, expect, it } from 'vitest'

const { migrate, hangName } = (await import('../scripts/timingCodemod.mjs')) as {
  migrate: (src: string, file?: string) => { out: string; changed: { line: number; from: string; to: string }[]; left: { line: number; why: string }[] }
  hangName: (ms: number, text?: string) => string | null
}
const SUITE = 'tests/e2e/x.cjs'
const lib = "const lib = require('./lib.cjs')\n"

describe('the name a bound becomes (never shorter)', () => {
  it('by value: up to 30 s hang.ui, to 120 s hang.step, to 300 s hang.slow, past that none', () => {
    expect([hangName(500), hangName(30_000), hangName(30_001), hangName(120_000), hangName(300_000), hangName(300_001)]).toEqual(['hang.ui', 'hang.ui', 'hang.step', 'hang.step', 'hang.slow', null])
  })
  it("by the work: a start, a merge or a turn at 10 s is still hang.step", () => {
    expect(hangName(10_000, "(await live(b2.id))?.status === 'ready'")).toBe('hang.step')
    expect(hangName(10_000, 'facts(c6).find((f) => f.kind === "BuilderPlaced")')).toBe('hang.step')
    expect(hangName(10_000, 'page.locator(".x").isVisible()')).toBe('hang.ui')
  })
})

describe('until (HI-3382)', () => {
  it('lib.until and until with a literal bound: named, its interval left; multiline and with a trailing comma', () => {
    const src = `${lib}await lib.until(() => page.isVisible(), 5000, 20)\nawait until(\n  () => x(),\n  15000,\n)\n`
    const r = migrate(src, SUITE)
    expect(r.out).toContain("lib.until(() => page.isVisible(), lib.timing('hang.ui'), 20)")
    expect(r.out).toContain("() => x(),\n  lib.timing('hang.ui'),\n)")
    expect(r.left).toEqual([])
  })

  it('aliased and destructured: const wait = lib.until, const { until: w } = lib', () => {
    const src = `${lib}const wait = lib.until\nconst { until: w } = lib\nawait wait(() => a(), 9000)\nawait w(() => b(), 45000)\n`
    const r = migrate(src, SUITE)
    expect(r.out).toContain("wait(() => a(), lib.timing('hang.ui'))")
    expect(r.out).toContain("w(() => b(), lib.timing('hang.step'))")
  })

  it('nested: an until inside another\'s predicate, each its own', () => {
    const r = migrate(`${lib}await until(async () => (await until(() => c(), 2000)) && d(), 60000)\n`, SUITE)
    expect(r.out).toContain("until(async () => (await until(() => c(), lib.timing('hang.ui'))) && d(), lib.timing('hang.step'))")
  })

  it('no bound written: one is written in (until\'s bound is required now)', () => {
    const r = migrate(`${lib}await lib.until(() => ready())\n`, SUITE)
    expect(r.out).toContain("lib.until(() => ready(), lib.timing('hang.ui'))")
  })

  it('a local wrapper with a literal default: its calls get bounds, the default goes', () => {
    const src = `${lib}const until = async (fn, ms = 10000) => { const t = Date.now(); while (!(await fn()) && Date.now() - t < ms) await lib.sleep(200) }\nawait until(() => a())\n`
    const r = migrate(src, SUITE)
    expect(r.out).toContain('const until = async (fn, ms) =>')
    expect(r.out).toContain("await until(() => a(), lib.timing('hang.ui'))")
  })

  it('a negative wait (nothing happens within it): left, reported', () => {
    const src = `${lib}check('not sent', !(await lib.until(() => sent(), 3000)))\nexpect(await until(() => moved(), 2000)).toBe(false)\n`
    const r = migrate(src, SUITE)
    expect(r.out).toBe(src)
    expect(r.left.map((l) => l.why)).toEqual([expect.stringMatching(/negative/), expect.stringMatching(/negative/)])
  })

  it('a bound of 0 or past every name: left, reported', () => {
    const r = migrate(`${lib}await until(() => a(), 0)\nawait until(() => b(), 600000)\n`, SUITE)
    expect(r.changed).toEqual([])
    expect(r.left).toHaveLength(2)
  })

  it('strings, templates, comments and regular expressions that look like waits are none', () => {
    const src = `${lib}const s = 'await until(() => x(), 5000)'\nconst t = \`until(f, 9000)\`\n// await until(() => y(), 7000)\nconst re = /until\\(f, 8000\\)/\n`
    const r = migrate(src, SUITE)
    expect(r.out).toBe(src)
    expect(r.changed).toEqual([])
  })
})

describe('timeouts and constants (HI-3382)', () => {
  it("Playwright's: a hang bound named; a short action budget, an expected rejection and a 0 left", () => {
    const src = `${lib}await el.waitFor({ timeout: 5000 })\nawait btn.click({ timeout: 300 })\nawait el.waitFor({ timeout: 8000 }).catch(() => undefined)\nawait el.waitFor({ timeout: 0 })\n`
    const r = migrate(src, SUITE)
    expect(r.out).toContain("el.waitFor({ timeout: lib.timing('hang.ui') })")
    expect(r.out).toContain('btn.click({ timeout: 300 })')
    expect(r.out).toContain('waitFor({ timeout: 8000 }).catch')
    expect(r.out).toContain('waitFor({ timeout: 0 })')
    expect(r.left).toHaveLength(3)
  })

  it("a child process's timeout: spawn.hang; an option object of something else: left", () => {
    const src = `${lib}execFileSync('git', ['status'], { timeout: 20000 })\nlib.typeLine(inv, k, h, null, 'x', { timeout: 9000 })\n`
    const r = migrate(src, SUITE)
    expect(r.out).toContain("{ timeout: lib.timing('spawn.hang') }")
    expect(r.out).toContain("{ timeout: 9000 }")
    expect(r.left).toHaveLength(1)
  })

  it('HUNG_MS by value; another *_MS constant left (a budget, a quiet or a pace)', () => {
    const r = migrate(`${lib}const HUNG_MS = 20000\nconst TICK_MS = 300\n`, SUITE)
    expect(r.out).toContain("const HUNG_MS = lib.timing('hang.ui')")
    expect(r.out).toContain('const TICK_MS = 300')
    expect(r.left).toHaveLength(1)
  })

  it("timing is reached as the file can: lib.timing with lib, timing in lib.cjs, a require otherwise", () => {
    expect(migrate('const HUNG_MS = 20000\n', 'tests/e2e/lib.cjs').out).toBe("const HUNG_MS = timing('hang.ui')\n")
    const plain = migrate("const fs = require('fs')\nconst HUNG_MS = 20000\n", 'tests/scenarios/harness.cjs').out
    expect(plain).toContain("const fs = require('fs')\nconst { timing } = require('../timing.cjs')")
    expect(plain).toContain("const HUNG_MS = timing('hang.ui')")
  })
})
