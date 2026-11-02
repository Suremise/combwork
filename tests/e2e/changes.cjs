// The Changes tab shows the selected file's diff even when an older diff answers last, and shows a git failure with
// Retry. Uses the test-only IPC hooks (unpackaged builds): the first git:diff is slow and the first git:status fails.
// No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'changes-profile')
const ws = path.join(lib.WORK, 'changes-ws')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 1\n' })
  fs.writeFileSync(path.join(alpha, 'a.ts'), 'export const a = 2 // AAA\n')
  fs.writeFileSync(path.join(alpha, 'b.ts'), 'export const b = 2 // BBB\n')
  lib.enableProviders(userData)

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_TEST_SLOW_IPC: 'git:diff=3000*1', HIVE_TEST_FAIL_IPC: 'git:status*1' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }

  await page.getByText('alpha', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const retry = page.getByRole('button', { name: 'Retry' })
  check('a git failure shows the error, with Retry', !!(await until(async () => (await retry.count()) === 1 && /failed/.test(await page.locator('.empty-state').first().innerText()), 8000)))
  await page.screenshot({ path: path.join(lib.WORK, 'changes-1-error.png') })
  await retry.click()
  const row = (name) => page.locator('.split-list .row', { hasText: name })
  check('Retry loads the changes', !!(await until(async () => (await row('a.ts').count()) === 1 && (await row('b.ts').count()) === 1, 8000)))

  // a.ts is selected and its diff is slow (3 s); b.ts answers at once and must stay shown after a.ts's late answer.
  check('the first file waits for its diff', !!(await until(async () => /Loading the diff/.test(await page.locator('.split-main').innerText()), HUNG_MS)))
  await row('b.ts').click()
  const shown = () => page.locator('.split-main .editor-toolbar strong').innerText().catch(() => '')
  check("the selected file's diff shows", !!(await until(async () => (await shown()) === 'b.ts', 5000)), await shown())
  await lib.sleep(3500) // A fixed wait on purpose: the slowed answer for the old choice arrives later, and this checks it doesn't replace the new one.
  check("a late answer for another file doesn't replace it", (await shown()) === 'b.ts' && (await row('b.ts').getAttribute('class')).includes('selected'), await shown())
  await page.screenshot({ path: path.join(lib.WORK, 'changes-2-diff.png') })
  await row('a.ts').click()
  check('the other file still loads when chosen', !!(await until(async () => (await shown()) === 'a.ts', 5000)), await shown())

  // Refreshing a.ts fails: its last diff stays, with the error and Retry over it; Retry reads it again.
  await app.evaluate(() => {
    process.env.HIVE_TEST_FAIL_IPC = 'git:diff*1'
  })
  await page.locator('.split-list .pane-header').getByRole('button', { name: 'Refresh' }).click()
  const stale = page.locator('.split-main .banner', { hasText: 'Could not refresh the diff' })
  check('a failed refresh of the shown diff says so, with Retry', !!(await until(async () => (await stale.count()) === 1 && (await stale.getByRole('button', { name: 'Retry' }).count()) === 1, 5000)))
  check('and keeps the last diff under it', (await shown()) === 'a.ts', await shown())
  await page.screenshot({ path: path.join(lib.WORK, 'changes-3-refresh-failed.png') })
  await stale.getByRole('button', { name: 'Retry' }).click()
  check('Retry reads it again and clears the error', !!(await until(async () => (await stale.count()) === 0 && (await shown()) === 'a.ts', 5000)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
