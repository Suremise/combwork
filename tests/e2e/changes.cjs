// The Changes tab shows the selected file's diff even when an older diff answers last, and shows a git failure with
// Retry. Uses the test-only IPC hooks (unpackaged builds): the first git:diff is slow and the first git:status fails.
// No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = lib.timing('hang.ui')

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

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_TEST_SLOW_IPC: 'git:diff=3000*1', CW_TEST_FAIL_IPC: 'git:status*1' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(lib.timing('poll.intervalMs'))
    return v
  }

  await page.getByText('alpha', { exact: true }).first().click()
  await page.locator('.tab', { hasText: 'Version Control' }).click()
  const retry = page.getByRole('button', { name: 'Retry' })
  check('a git failure shows the error, with Retry', !!(await until(async () => (await retry.count()) === 1 && /failed/.test(await page.locator('.empty-state').first().innerText()), lib.timing('hang.ui'))))
  await page.screenshot({ path: path.join(lib.WORK, 'changes-1-error.png') })
  // Main counts the git:diff calls answered (globalThis.__cwSettledIpc, HI-2971). Read before Retry asks for the first
  // diff (a.ts's, slowed 3 s by CW_TEST_SLOW_IPC), so each answer after it is counted.
  const diffsAnswered = () => app.evaluate(() => globalThis.__cwSettledIpc?.['git:diff'] ?? 0)
  const answeredBefore = await diffsAnswered()
  await retry.click()
  const row = (name) => page.locator('.split-list .row', { hasText: name })
  check('Retry loads the changes', !!(await until(async () => (await row('a.ts').count()) === 1 && (await row('b.ts').count()) === 1, lib.timing('hang.ui'))))

  // a.ts is selected and its diff is slow (3 s); b.ts answers at once and must stay shown after a.ts's late answer.
  check('the first file waits for its diff', !!(await until(async () => /Loading the diff/.test(await page.locator('.split-main').innerText()), HUNG_MS)))
  await row('b.ts').click()
  const shown = () => page.locator('.split-main .editor-toolbar strong').innerText().catch(() => '')
  check("the selected file's diff shows", !!(await until(async () => (await shown()) === 'b.ts', lib.timing('hang.ui'))), await shown())
  // The order, observed: b.ts shown with one diff answered, so that one was b.ts's (it can't show without it) and a.ts's
  // was still out. A machine slow enough to answer a.ts first fails here, never passes the check below untested.
  const answeredAtB = await diffsAnswered()
  check("b.ts's diff answered while a.ts's was still out", answeredAtB === answeredBefore + 1, `${answeredAtB} answered, ${answeredBefore} before Retry`)
  // Then a.ts's late answer, and the window has taken the reply: only then the check.
  const lateArrived = !!(await until(async () => (await diffsAnswered()) === answeredBefore + 2, HUNG_MS))
  check("a.ts's late answer reached the window after b.ts's, before the check below", lateArrived, `${await diffsAnswered()} answered, ${answeredBefore} before Retry`)
  await lib.settled(page)
  check("a late answer for another file doesn't replace it", (await shown()) === 'b.ts' && (await row('b.ts').getAttribute('class')).includes('selected'), await shown())
  await page.screenshot({ path: path.join(lib.WORK, 'changes-2-diff.png') })
  await row('a.ts').click()
  check('the other file still loads when chosen', !!(await until(async () => (await shown()) === 'a.ts', lib.timing('hang.ui'))), await shown())

  // Refreshing a.ts fails: its last diff stays, with the error and Retry over it; Retry reads it again.
  await app.evaluate(() => {
    process.env.CW_TEST_FAIL_IPC = 'git:diff*1'
  })
  await page.locator('.split-list .pane-header').getByRole('button', { name: 'Refresh' }).click()
  const stale = page.locator('.split-main .banner', { hasText: 'Could not refresh the diff' })
  check('a failed refresh of the shown diff says so, with Retry', !!(await until(async () => (await stale.count()) === 1 && (await stale.getByRole('button', { name: 'Retry' }).count()) === 1, lib.timing('hang.ui'))))
  check('and keeps the last diff under it', (await shown()) === 'a.ts', await shown())
  await page.screenshot({ path: path.join(lib.WORK, 'changes-3-refresh-failed.png') })
  await stale.getByRole('button', { name: 'Retry' }).click()
  check('Retry reads it again and clears the error', !!(await until(async () => (await stale.count()) === 0 && (await shown()) === 'a.ts', lib.timing('hang.ui'))))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
