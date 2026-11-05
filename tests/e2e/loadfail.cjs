// A failed load says so, with Retry, instead of looking like an empty result: the Sessions tab's search, the
// project's Skills tab and the Workspace Overview (first load, and a refresh over the last figures). What a view
// loaded belongs to its project: switching to another whose load fails, or whose load is overtaken by a late answer
// for the last project, never shows the last project's results as its own. The Skills and Templates views, whose
// sidebar and main area both failed to read: the sidebar's Retry reads them again in both, so selecting an item shows it
// (#841). Uses the test-only CW_TEST_FAIL_IPC and
// CW_TEST_SLOW_IPC (unpackaged builds), set in the main process as each step needs it.
// No agents. Dev build, throwaway profile and workspace.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'loadfail-profile')
const ws = path.join(lib.WORK, 'loadfail-ws')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  lib.gitProject(alpha, { 'a.ts': 'export const a = 1\n' })
  lib.gitProject(beta, { 'b.ts': 'export const b = 1\n' })
  // A local skill only alpha has.
  const only = path.join(alpha, '.claude', 'skills', 'alpha-only')
  fs.mkdirSync(only, { recursive: true })
  fs.writeFileSync(path.join(only, 'SKILL.md'), '---\nname: alpha-only\ndescription: Only in alpha.\n---\n\nAlpha.\n')
  lib.enableProviders(userData)

  const env = lib.combworkEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 860 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  // Each call to fail (a new value each time: the same one again isn't read as a change).
  let round = 0
  const failNext = (channel) => app.evaluate((_e, v) => (process.env.CW_TEST_FAIL_IPC = v), `${channel}*1,round${++round}`)
  // Every call fails until cleared (failAll('')): the sidebar's and the main area's read both fail.
  const failAll = (channel) => app.evaluate((_e, v) => (process.env.CW_TEST_FAIL_IPC = v), channel && `${channel},round${++round}`)
  const slowNext = (channel, ms) => app.evaluate((_e, v) => (process.env.CW_TEST_SLOW_IPC = v), `${channel}=${ms}*1,round${++round}`)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(150)
    return v
  }
  const text = (sel) => page.locator(sel).first().innerText().catch(() => '')
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()

  // --- Sessions tab: a failed search isn't "No matches".
  await page.locator('.tab', { hasText: 'Sessions' }).click()
  await failNext('transcript:search')
  await page.locator('.files-filter input').fill('needle')
  const failedBox = page.locator('.load-failed')
  check('search: a failure shows the error with Retry', !!(await until(async () => /Could not load the search results: .*failed/.test(await text('.load-failed')), HUNG_MS)))
  check('search: no "No matches" for a failure', !/No matches/.test(await text('.sessions-scope')))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-1-search.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('search: Retry searches again (a real empty result)', !!(await until(async () => (await failedBox.count()) === 0 && /No matches/.test(await text('.sessions-scope')), HUNG_MS)))

  // --- Skills tab: a failed read isn't "no skills"; Retry loads them without reopening the tab.
  await failNext('skills:list')
  await lib.openMoreTab(page, 'Skills')
  check('skills: a failure shows the error with Retry', !!(await until(async () => /Could not load the skills: .*failed/.test(await text('.load-failed')), HUNG_MS)))
  check('skills: no empty groups for a failure', (await page.locator('.skill-group').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-2-skills.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('skills: Retry loads them', !!(await until(async () => (await failedBox.count()) === 0 && (await page.locator('.skill-group').count()) > 0, HUNG_MS)))
  // A refresh that fails keeps the list, with a note.
  await failNext('skills:list')
  await page.locator('.split-list .pane-header').getByRole('button', { name: 'Refresh' }).click()
  check('skills: a failed refresh keeps the list, with a note', !!(await until(async () => /Could not refresh the skills/.test(await text('.load-stale')) && (await page.locator('.skill-group').count()) > 0, HUNG_MS)))
  await page.locator('.load-stale').getByRole('button', { name: 'Retry' }).click()
  check('skills: Retry clears the note', !!(await until(async () => (await page.locator('.load-stale').count()) === 0, HUNG_MS)))

  // --- A project's results are its own: another project whose load fails or is overtaken never shows them.
  const project = (name) => page.locator('.sidebar').getByText(name, { exact: true }).first().click()
  const alphaOnly = page.locator('.skill-row', { hasText: 'alpha-only' })
  // A project's local skills are under its provider's group, folded at first (#118); opened once in each project (it
  // stays open for that project), so a list of the other project's would show.
  const openProvider = async () => {
    const t = page.locator('.skill-provider-toggle')
    await until(async () => (await t.count()) > 0, HUNG_MS)
    if ((await t.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await t.click()
  }
  await project('beta')
  await lib.openMoreTab(page, 'Skills')
  await until(async () => (await page.locator('.skill-group').count()) > 0, HUNG_MS)
  await openProvider()
  await project('alpha')
  await openProvider()
  check('skills: alpha lists its own local skill', !!(await until(async () => (await alphaOnly.count()) === 1, HUNG_MS)))
  // The Skills tab stays open (both projects show it) while beta's load fails.
  await failNext('skills:list')
  await project('beta')
  check("skills: beta's failed load says so, without alpha's skills", !!(await until(async () => /Could not load the skills/.test(await text('.load-failed')), HUNG_MS)) && (await alphaOnly.count()) === 0)
  check("skills: nor as beta's stale list", (await page.locator('.load-stale').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-5-switch.png') })
  // Whichever Retry shows, so the checks after this one still run if the error showed as a stale note.
  await page.getByRole('button', { name: 'Retry' }).first().click()
  check("skills: Retry loads beta's own", !!(await until(async () => (await failedBox.count()) === 0 && (await page.locator('.skill-group').count()) > 0, HUNG_MS)) && (await alphaOnly.count()) === 0)
  // Alpha's answer arrives late, after beta is shown: it isn't shown as beta's.
  await slowNext('skills:list', 2500)
  await project('alpha')
  await lib.sleep(300)
  await project('beta')
  await until(async () => (await page.locator('.skill-group').count()) > 0, HUNG_MS)
  await lib.sleep(3500) // A fixed wait on purpose: the slowed answer for the old choice arrives later, and this checks it doesn't replace the new one.
  check("skills: alpha's late answer isn't shown in beta", (await alphaOnly.count()) === 0 && (await page.locator('.skill-group').count()) > 0)
  await project('alpha')
  check('skills: back in alpha, its own again', !!(await until(async () => (await alphaOnly.count()) === 1, HUNG_MS)))
  // While beta's own load is slow, alpha's list isn't shown as beta's: beta is loading.
  await slowNext('skills:list', 2500)
  await project('beta')
  await lib.sleep(600)
  check("skills: while beta loads, alpha's skills aren't shown", (await alphaOnly.count()) === 0 && /Loading/.test(await text('.split-list .pane-body')))
  check('skills: then beta has its own', !!(await until(async () => (await page.locator('.skill-group').count()) > 0, HUNG_MS)) && (await alphaOnly.count()) === 0)

  // --- Skills and Templates views: the sidebar's Retry reads the main area's list again too (#841).
  const activity = (name) => page.locator(`.activity-btn[aria-label="${name}"]`).click()
  const sideFailed = page.locator('.sidebar .load-failed')
  await failAll('skills:workspace')
  await activity('Skills')
  check('skills view: the failed read says so in the sidebar', !!(await until(async () => (await sideFailed.count()) === 1, HUNG_MS)))
  await failAll('')
  await sideFailed.getByRole('button', { name: 'Retry' }).click()
  const skillRow = page.locator('.sidebar .skill-row').first()
  check("skills view: the sidebar's Retry lists the skills", !!(await until(async () => (await skillRow.count()) === 1, HUNG_MS)))
  await skillRow.click()
  check('skills view: a skill selected then shows, not a failed read', !!(await until(async () => (await page.locator('.main-area .split .editor-toolbar').count()) === 1 && (await page.locator('.main-area .load-failed').count()) === 0, HUNG_MS)))
  await lib.addAgent(inv, alpha, { name: 'One' })
  await inv('templates:save', alpha, 'workspace', 'Pair', true)
  await failAll('templates:all')
  await activity('Templates')
  check('templates view: the failed read says so in the sidebar', !!(await until(async () => (await sideFailed.count()) === 1, HUNG_MS)))
  await failAll('')
  await sideFailed.getByRole('button', { name: 'Retry' }).click()
  // (The workspace's: Combwork's own are listed too, #1436.)
  const templateRow = page.locator('.sidebar .template-row[data-scope="workspace"]').first()
  check("templates view: the sidebar's Retry lists the templates", !!(await until(async () => (await templateRow.count()) === 1, HUNG_MS)))
  await templateRow.click()
  check('templates view: a template selected then shows', !!(await until(async () => (await page.locator('.template-detail').count()) === 1, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-6-templates-retried.png') })

  // --- Workspace Overview: a failed first load isn't a spinner forever.
  await failNext('workspace:usage')
  await page.keyboard.press('Control+Shift+O')
  check('overview: a failure shows the error with Retry', !!(await until(async () => /Could not load the workspace's usage: .*failed/.test(await text('.load-failed')), HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-3-overview.png') })
  await failedBox.getByRole('button', { name: 'Retry' }).click()
  check('overview: Retry loads it', !!(await until(async () => (await failedBox.count()) === 0 && /Summary/.test(await text('.overview-head')), HUNG_MS)))
  // A failed refresh keeps the figures, with when they're from.
  await failNext('workspace:usage')
  await page.locator('.overview-head').getByRole('button', { name: 'Refresh' }).click()
  check('overview: a failed refresh keeps the figures, with a note', !!(await until(async () => /Could not refresh the usage; last updated \d/.test(await text('.load-stale')) && (await page.locator('.cards').count()) > 0, HUNG_MS)))
  await page.screenshot({ path: path.join(lib.WORK, 'loadfail-4-stale.png') })
  await page.locator('.load-stale').getByRole('button', { name: 'Retry' }).click()
  check('overview: Retry clears the note', !!(await until(async () => (await page.locator('.load-stale').count()) === 0, HUNG_MS)))

  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'All checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
