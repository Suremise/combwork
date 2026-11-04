// `npm run test:waits` (#524): a fixed sleep a check follows, with no comment saying why, is found; one whose check
// itself waits for its condition, or with a comment, is not. The samples build the word so this file isn't one.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from './tempDir'
// @ts-expect-error: plain .mjs modules without types
import { findUnbounded, findWaits } from '../scripts/testWaits.mjs'

const ctx = createRequire(import.meta.url)('./e2e/runContext.cjs') as { baseEnv: () => Record<string, string> }
const S = ['sle', 'ep'].join('')
const T = ['setTime', 'out'].join('')
const lines = (...l: string[]): string => l.join('\r\n')

describe('test waits (#524)', () => {
  it('finds a sleep a check follows, and where', () => {
    const found = findWaits(lines('  await click()', `  await lib.${S}(500)`, '  const n = await rows.count()', "  check('three rows', n === 3)"))
    expect(found).toEqual([{ line: 2, code: `await lib.${S}(500)`, commented: false }])
  })

  it('finds the other forms: a promise around setTimeout, waitForTimeout, a sleep on the line of the action', () => {
    expect(findWaits(lines(`  await new Promise((r) => ${T}(r, 300))`, '  expect(seen).toHaveLength(1)'))).toHaveLength(1)
    expect(findWaits(lines(`  await page.waitFor${T.slice(3)}(800)`, "  check('open', ok)"))).toHaveLength(1)
    expect(findWaits(lines(`  await btn.click(); await ${S}(400)`, "  check('done', await done())"))).toHaveLength(1)
  })

  it('marks a sleep with a comment beside or above it as meant', () => {
    expect(findWaits(lines(`  await lib.${S}(4000) // on purpose: no second line comes`, "  check('one line', n === 1)"))[0].commented).toBe(true)
    expect(findWaits(lines('  // Nothing to observe: the absence of a wake is the point.', `  await lib.${S}(4000)`, "  check('one line', n === 1)"))[0].commented).toBe(true)
  })

  it('leaves a sleep whose next check waits for its condition, one with no check after it, and the helper itself', () => {
    expect(findWaits(lines(`  await lib.${S}(300)`, "  check('opens', !!(await lib.until(async () => (await dlg.count()) === 1, 5000)))"))).toEqual([])
    expect(findWaits(lines(`  await ${S}(300)`, '  await expect.poll(() => n).toBe(1)'))).toEqual([])
    expect(findWaits(lines(`  await lib.${S}(300)`, '  await page.keyboard.type(text)', '  await page.keyboard.press("Enter")', '  await other()', "  check('late', ok)"))).toEqual([])
    expect(findWaits(lines(`const ${S} = (ms) => new Promise((r) => ${T}(r, ms))`, '  expect(1).toBe(1)'))).toEqual([])
  })

  it("doesn't let a later check's wait cover the check the sleep is for", () => {
    const found = findWaits(lines(`  await ${S}(500)`, "  check('saved', saved)", "  check('dialog', await lib.until(() => open, 1000))"))
    expect(found).toEqual([{ line: 1, code: `await ${S}(500)`, commented: false }])
  })

  it('finds a short sleep too: only a comment says why it is meant', () => {
    expect(findWaits(lines(`  await ${S}(5)`, "  check('ready', ready)"))).toHaveLength(1)
    expect(findWaits(lines(`  await new Promise((r) => ${T}(r, 5)) // later timestamps differ`, '  expect(b.at).toBeGreaterThan(a.at)'))[0].commented).toBe(true)
  })

  it("takes a polling loop's own pause for the poll it is: a loop that polls state and the check after it", () => {
    const poll = ['  const end = Date.now() + 5000', '  while (Date.now() < end) {', "    if (fs.existsSync(file) && read().includes('hello')) break", `    await new Promise((r) => ${T}(r, 10))`, '  }', '  assert.match(read(), /hello/)']
    expect(findWaits(lines(...poll))).toEqual([])
    expect(findWaits(lines('  for (let i = 0; i < 50; i++) {', '    if (done()) break', `    await ${S}(20)`, '  }', "  check('done', done())"))).toEqual([])
    expect(findWaits(lines(`  while (!done()) await ${S}(20)`, "  check('done', done())"))).toEqual([])
    expect(findWaits(lines('  do {', `    await ${S}(20)`, '  } while (!(await done()))', "  check('done', await done())"))).toEqual([])
  })

  it('finds a sleep in a loop that only repeats actions, counted or timed, whether its check is in the loop or after it', () => {
    const counted = (...after: string[]): string[] => ['  for (let i = 0; i < 3; i++) {', '    await button.click()', `    await ${S}(500)`, ...after]
    expect(findWaits(lines(...counted("    check('open', open)", '  }')))).toHaveLength(1)
    expect(findWaits(lines(...counted('  }', "  check('open', open)")))).toHaveLength(1)
    expect(findWaits(lines('  for (const b of buttons) {', '    await b.click()', `    await ${S}(300)`, '  }', "  check('all on', allOn())"))).toHaveLength(1)
    expect(findWaits(lines('  const end = Date.now() + 2000', '  while (Date.now() < end) {', '    await type(key)', `    await ${S}(100)`, '  }', "  check('typed', typed())"))).toHaveLength(1)
    expect(findWaits(lines(`  for (let i = 0; i < 5; i++) await ${S}(100)`, "  check('done', done())"))).toHaveLength(1)
    // A polling loop whose check sits in its body, after the pause, reads once after a fixed time all the same.
    expect(findWaits(lines('  while (!done()) {', `    await ${S}(20)`, "    check('step', step())", '  }'))).toHaveLength(1)
  })

  it("ignores what a string says: a test's text naming a sleep or a check isn't one", () => {
    expect(findWaits(lines(`  const sample = 'await page.waitFor${T.slice(3)}(500)'`, '  expect(scan(sample)).toHaveLength(1)'))).toEqual([])
    expect(findWaits(lines(`  await lib.${S}(300)`, '  const label = "check(it)"', '  log(label)'))).toEqual([])
  })

  it('finds a wait that states no bound of its own (#570): until, vi.waitFor and expect.poll left to their defaults', () => {
    const W = ['vi.wait', 'For'].join('')
    const P = ['expect.po', 'll'].join('')
    const U = ['unt', 'il'].join('')
    expect(findUnbounded(lines('  await click()', `  await lib.${U}(async () => (await rows.count()) === 3)`))).toEqual([{ line: 2, code: `await lib.${U}(async () => (await rows.count()) === 3)`, commented: false }])
    expect(findUnbounded(lines(`  await ${W}(() => expect(seen).toHaveLength(1))`))).toHaveLength(1)
    expect(findUnbounded(lines(`  await ${W}(() => expect(seen).toHaveLength(1), { interval: 50 })`))).toHaveLength(1)
    expect(findUnbounded(lines(`  await ${P}(() => count()).toBe(2)`))).toHaveLength(1)
    // Over several lines, with a trailing comma.
    expect(findUnbounded(lines(`  await ${W}(`, '    async () => {', '      expect(await read()).toBe(1)', '    },', '  )'))).toEqual([{ line: 1, code: `await ${W}(`, commented: false }])
    // In a ternary, its ':' after the call (#1400: not taken for a definition's return type).
    expect(findUnbounded(lines(`  const id = sent > 0 ? await ${U}(() => turnOf(text)) : null`, `  const v = ready ? ${U}(() => x()) : null`))).toHaveLength(2)
  })

  it('finds a bound under 5 s given as a number: a time budget, not a bound for a hung run', () => {
    const W = ['vi.wait', 'For'].join('')
    const U = ['unt', 'il'].join('')
    expect(findUnbounded(lines(`  check('open', !!(await ${U}(() => open(), 3000)))`))).toHaveLength(1)
    expect(findUnbounded(lines(`  await ${W}(() => expect(n).toBe(1), { timeout: 1_000 })`))).toHaveLength(1)
    // A comment beside or above says why it is short (a retry's pace, a quiet period): the reviewer judges it.
    expect(findUnbounded(lines('  // Nothing should come: 1.5 s in which it must not show.', `  check('none', !(await lib.${U}(() => shown(), 1500)))`))[0].commented).toBe(true)
  })

  it('leaves a wait with a bound of its own: named, or a number of 5 s and more; and helpers, strings, comments and regexes', () => {
    const W = ['vi.wait', 'For'].join('')
    const P = ['expect.po', 'll'].join('')
    const U = ['unt', 'il'].join('')
    expect(findUnbounded(lines(`  await lib.${U}(() => open(), HUNG_MS)`, `  await ${U}(() => open(), 10000, 150)`, `  await ${W}(() => expect(n).toBe(1), { timeout: HUNG_MS, interval: 50 })`, `  await ${W}(() => expect(n).toBe(1), HANG)`, `  await ${P}(() => n, { timeout: 30_000 }).toBe(1)`))).toEqual([])
    expect(findUnbounded(lines(`const ${U} = async (fn, ms = 10000) => {`, '  return fn()', '}', `async function ${U}(fn, ms) {}`))).toEqual([])
    // Definitions with a return type or a body: a method, a function's signature.
    expect(findUnbounded(lines(`  async ${U}(fn: () => boolean, ms: number): Promise<boolean> {`, '  }', `  ${U}(fn, ms) {`, '  }', `export function ${U}(fn: () => unknown, ms?: number): Promise<unknown>`))).toEqual([])
    expect(findUnbounded(lines(`  const sample = 'await ${U}(() => x)'`, `  // await ${U}(() => x)`, `  const re = /${U}\\(/`))).toEqual([])
    // A regex with a bracket in it doesn't throw the reading of the call after it.
    expect(findUnbounded(lines(`  await lib.${U}(async () => /\\(x/.test(await text()), HUNG_MS)`, `  await lib.${U}(() => ok())`))).toEqual([{ line: 2, code: `await lib.${U}(() => ok())`, commented: false }])
  })

  it('never lets a wait with no bound through (#570 round 1): not for a comment above it, a timeout only in a comment, or inside a template', () => {
    const W = ['vi.wait', 'For'].join('')
    // A comment above explains the wait; it isn't a reason for having no bound.
    expect(findUnbounded(lines('  // Waits for the window to load.', `  await ${W}(check)`))).toEqual([{ line: 2, code: `await ${W}(check)`, commented: false }])
    // A timeout in a comment or a string isn't the options' timeout.
    expect(findUnbounded(lines(`  await ${W}(check, {`, '    interval: 50,', '    // timeout: HUNG_MS is not configured here', '  })'))).toHaveLength(1)
    expect(findUnbounded(lines(`  await ${W}(check, { interval: 50, /* timeout: 9000 */ })`))).toHaveLength(1)
    expect(findUnbounded(lines(`  await ${W}(check, { label: 'timeout: 9000' })`))).toHaveLength(1)
    // A template's `${…}` is code: a wait in it is found, and one after a template is read as it is.
    expect(findUnbounded(lines(`  const s = \`\${await ${W}(check)}\``))).toHaveLength(1)
    expect(findUnbounded(lines(`  const s = \`a \${x} b\`; await ${W}(check, { timeout: HUNG_MS })`))).toEqual([])
  })

  it('the command fails on a wait with no bound, whatever is around it, and passes once each states one', () => {
    const W = ['vi.wait', 'For'].join('')
    // A repository of its own with the script and a test file (new files count as changed, so only the bounds decide).
    const repo = tempDir('hive-testwaits-')
    mkdirSync(join(repo, 'scripts'))
    mkdirSync(join(repo, 'tests'))
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'testWaits.mjs'), join(repo, 'scripts', 'testWaits.mjs'))
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, encoding: 'utf8', env: ctx.baseEnv() })
    expect(git('init', '-q', '-b', 'main').status).toBe(0)
    expect(git('add', 'scripts').status).toBe(0)
    expect(git('commit', '-q', '-m', 'script').status).toBe(0)
    const run = (...args: string[]) => spawnSync(process.execPath, [join(repo, 'scripts', 'testWaits.mjs'), ...args], { cwd: repo, encoding: 'utf8', env: ctx.baseEnv() })
    const file = join(repo, 'tests', 'check.test.ts')
    writeFileSync(file, lines('// Wait until the window has loaded.', `await ${W}(check)`, `await ${W}(check, {`, ' interval: 50,', ' // timeout: HUNG_MS is not configured here', '})', `const s = \`\${await ${W}(check)}\``, ''))
    const bad = run()
    expect(bad.status).toBe(1)
    for (const n of [2, 3, 7]) expect(bad.stdout).toContain(`tests/check.test.ts:${n} `)
    expect(bad.stdout).toMatch(/3 wait\(s\) with no bound of their own/)
    // Once committed to the base, the same findings belong to the explicit audit, not unrelated builder checks.
    expect(git('add', 'tests').status).toBe(0)
    expect(git('commit', '-q', '-m', 'existing waits').status).toBe(0)
    expect(run().status).toBe(0)
    const audit = run('--all')
    expect(audit.status).toBe(0)
    expect(audit.stdout).toMatch(/3 wait\(s\) with no bound of their own/)
    // A committed branch addition, a tracked working-tree edit, and an untracked file all count.
    expect(git('checkout', '-q', '-b', 'work').status).toBe(0)
    writeFileSync(file, lines(`await ${W}(changed)`, ''))
    expect(git('commit', '-qam', 'change wait').status).toBe(0)
    expect(run().status).toBe(1)
    expect(run('--base', 'HEAD').status).toBe(0)
    writeFileSync(file, lines(`await ${W}(edited)`, ''))
    expect(run('--base', 'HEAD').status).toBe(1)
    writeFileSync(file, lines(`await ${W}(changed)`, ''))
    const added = join(repo, 'tests', 'new.test.ts')
    writeFileSync(added, lines(`await ${W}(added)`, ''))
    expect(run('--base', 'HEAD').status).toBe(1)
    writeFileSync(added, '')
    writeFileSync(file, lines('const HUNG_MS = 10000', `await ${W}(check, { timeout: HUNG_MS })`, `await ${W}(check, { interval: 50, timeout: HUNG_MS })`, ''))
    const good = run()
    expect(good.stdout).toContain('Every new or changed wait states its bound since main.')
    expect(good.status).toBe(0)
    // The call's first line stays unchanged: deleting only its timeout must still fail.
    const multiline = [`await ${W}(() => {`, '  check()', '}, {', '  timeout: HUNG_MS,', '})', '']
    writeFileSync(file, lines(...multiline))
    expect(git('commit', '-qam', 'bounded multiline wait').status).toBe(0)
    writeFileSync(file, lines(...multiline.filter((l) => !l.includes('timeout:'))))
    const removed = run('--base', 'HEAD')
    expect(removed.status).toBe(1)
    expect(removed.stdout).toContain('tests/check.test.ts:1 ')
    // Editing just the body also makes an existing unbounded call part of the change.
    expect(git('commit', '-qam', 'existing multiline wait').status).toBe(0)
    writeFileSync(file, lines(...multiline.filter((l) => !l.includes('timeout:')).map((l) => l.replace('check()', 'changed()'))))
    expect(run('--base', 'HEAD').status).toBe(1)
    // Deleting a short bound's reason is a change too, even when its call stays untouched.
    writeFileSync(file, lines('// A quiet period in which nothing should arrive.', `await ${W}(check, { timeout: 1000 })`, ''))
    expect(git('commit', '-qam', 'documented short wait').status).toBe(0)
    expect(run('--base', 'HEAD').status).toBe(0)
    writeFileSync(file, lines(`await ${W}(check, { timeout: 1000 })`, ''))
    expect(run('--base', 'HEAD').status).toBe(1)
    // The sleep gate still fails new violations, and deleting a wait creates no finding.
    writeFileSync(file, lines(`await ${S}(100)`, 'expect(ready).toBe(true)', ''))
    const sleep = run('--base', 'HEAD')
    expect(sleep.status).toBe(1)
    expect(sleep.stdout).toMatch(/1 new or changed sleep/)
    writeFileSync(file, '')
    expect(run('--base', 'HEAD').status).toBe(0)
  })

  it("fails when it can't compare with the base: nothing was checked", () => {
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'testWaits.mjs'), '--base', 'no-such-ref-524'], { encoding: 'utf8', env: ctx.baseEnv() })
    expect(run.status).toBe(2)
    expect(run.stderr).toMatch(/Can't compare with no-such-ref-524/)
  })
})
