// Performance → Compare (#117): import scenario benchmarks (the fixtures from a real fake run: a baseline, an
// intentional reduction, and the same reduction that broke a scenario) and see each scenario judged correctness first;
// a project's page refuses a scenario benchmark and compares its own kept views; a file of another kind isn't
// comparable and says why; a pair switched while a slow read is out shows the new pair. Screenshots at two widths in
// both themes. No agent is started.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'perfcompare-profile')
const ws = path.join(lib.WORK, 'perfcompare-ws')
for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)
fs.mkdirSync(path.join(ws, 'alpha'), { recursive: true })
const FIX = path.join(lib.ROOT, 'tests', 'fixtures', 'benchmarks')

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ` (${extra})` : ''}`)
}

;(async () => {
  const { app, page, inv } = await lib.launch({ userData, viewport: { width: 1400, height: 950 } })
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.openWorkspace(inv, page, ws)
  const until = async (fn, ms = 10000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(200)
    return v
  }
  const pageSel = '.performance-page:visible'
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `perfcompare-${name}.png`) })
  // The open dialog answered in main: the next import picks `file`.
  const picks = async (file) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    }, file)
  const importFile = async (file) => {
    await picks(file)
    await page.locator(`${pageSel} button`, { hasText: 'Import' }).click()
    await lib.sleep(600)
  }
  const statusOf = async (id) => (await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: id }).first().locator('.badge').innerText().catch(() => '')).trim()

  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  check('Compare starts empty and says how to begin', !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`, { hasText: 'Nothing to compare yet' }).count()) === 1, HUNG_MS)))

  await importFile(path.join(FIX, 'baseline.json'))
  await importFile(path.join(FIX, 'smaller-wrong.json'))
  check('two imports: the newest is the run, the one before it the baseline', !!(await until(async () => (await page.locator(`${pageSel} .perf-scenarios`).count()) === 1, HUNG_MS)))
  check('comparable: the same scenarios, provider and setup', (await page.locator(`${pageSel} .banner.success`, { hasText: 'Comparable' }).count()) === 1)
  // The Combwork context column's tip names the Assistant's working mode as the Performance page does (#358).
  await page.locator(`${pageSel} .perf-scenarios th`, { hasText: 'Combwork context' }).first().locator('.info-icon').hover()
  const tipText = async () => (await page.locator('.tip:visible').allInnerTexts()).join(' ')
  check('the Combwork context tip says the Assistant’s role and mode, not persona', !!(await until(async () => (await tipText()).includes('the Assistant’s role and mode'), 5000)) && !/persona/i.test(await tipText()), await tipText())
  await page.mouse.move(0, 0)
  check('a smaller reply that broke a scenario is "smaller but failing"', (await statusOf('card-detail')) === 'Smaller but failing', await statusOf('card-detail'))
  check('…and leads the table', (await page.locator(`${pageSel} .perf-scenarios tbody tr`).first().innerText()).includes('card-detail'))
  check('the summary counts it', /1 smaller but failing/.test(await page.locator(`${pageSel} .perf-summary`).innerText()))
  await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().click()
  check('a scenario opens to every measure, with notes', !!(await until(async () => (await page.locator(`${pageSel} .perf-detail-body`, { hasText: 'Tool replies' }).count()) === 1, HUNG_MS)) && /One sample/.test(await page.locator(`${pageSel} .perf-detail-body`).innerText()))
  // A scenario row is a button: Space and Enter open and close it, and Space doesn't scroll the page (#250).
  const cardRow = page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first()
  const expanded = async () => cardRow.getAttribute('aria-expanded')
  const scrolled = () => page.locator('.scroll-page:visible').first().evaluate((el) => el.scrollTop)
  await cardRow.focus()
  const top = await scrolled()
  await page.keyboard.press(' ')
  check('Space on an open scenario closes it', (await expanded()) === 'false' && (await page.locator(`${pageSel} .perf-detail-body`).count()) === 0, await expanded())
  await page.keyboard.press(' ')
  check('…Space opens it again, without scrolling the page', (await expanded()) === 'true' && (await scrolled()) === top, `${await expanded()} ${top} → ${await scrolled()}`)
  await page.keyboard.press('Enter')
  check('…Enter closes it', (await expanded()) === 'false')
  await page.keyboard.press('Enter')
  check('…and opens it', (await expanded()) === 'true' && (await page.locator(`${pageSel} .perf-detail-body`).count()) === 1)
  // The Result filter: the failing one only; then a name with no match, and Clear filters.
  const ids = async () => (await page.locator(`${pageSel} .perf-scenarios .table-wrap > .table > tbody > tr:not(.table-detail):not(.table-no-match) > td:first-child`).allInnerTexts()).map((x) => x.trim())
  const allIds = await ids()
  await page.locator(`${pageSel} .perf-scenarios select[aria-label="Filter Result"]`).selectOption('Smaller but failing')
  check('the Result filter keeps the smaller-but-failing scenario only', JSON.stringify(await ids()) === JSON.stringify(['card-detail']), JSON.stringify(await ids()))
  await page.locator(`${pageSel} .perf-scenarios select[aria-label="Filter Result"]`).selectOption('')
  await page.locator(`${pageSel} .perf-scenarios input[aria-label="Filter Scenario"]`).fill('nothing like a scenario')
  check('…a name with no match says so', (await page.locator(`${pageSel} .perf-scenarios .table-no-match`).count()) === 1)
  await page.locator(`${pageSel} .perf-scenarios .table-no-match button`, { hasText: 'Clear filters' }).click()
  check('…and Clear filters brings every scenario back', JSON.stringify(await ids()) === JSON.stringify(allIds) && allIds.length === 4, JSON.stringify(await ids()))
  await shot('failing-dark')

  await importFile(path.join(FIX, 'smaller.json'))
  await page.locator(`${pageSel} select[aria-label="Baseline"]`).selectOption({ label: 'fake, fixtures v5 (baseline)' })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller replies)' })
  check('the intentional reduction: "smaller, still correct"', !!(await until(async () => (await statusOf('card-detail')) === 'Smaller, still correct', HUNG_MS)), await statusOf('card-detail'))
  await shot('better-dark')

  // A pair switched while a slow read is out: the new pair is what shows.
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'benchmarks:read=2000*2'
  })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller but wrong)' })
  await lib.sleep(200)
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = ''
  })
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller replies)' })
  await lib.sleep(3000) // A fixed wait on purpose: the slowed answer for the old choice arrives later, and this checks it doesn't replace the new one.
  check("a pair switched during a slow read shows the new pair, not the old one's late answer", (await statusOf('card-detail')) === 'Smaller, still correct', await statusOf('card-detail'))
  check('the choice is remembered for the scope', (await inv('benchmarks:list', { kind: 'workspace' })).run !== null)
  check('the table shows the checks themselves: passed and skipped, baseline → run', /4✓ 1– → 4✓ 1–/.test(await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().innerText()), await page.locator(`${pageSel} .perf-scenarios tbody tr`, { hasText: 'card-detail' }).first().innerText())
  check('what each side is, provider and fixtures, is shown', /Fake fake, fixtures v5/.test(await page.locator(`${pageSel} .perf-pair`).innerText()))
  check('the live range and filters are hidden while comparing (they only shape Keep current view)', (await page.locator(`${pageSel} select[aria-label="Who did the work"]`).count()) === 0 && (await page.locator(`${pageSel} .segmented[aria-label="Time range"]`).count()) === 0)

  // The workspace's own work is its own scope: the whole workspace's benchmarks aren't shown as its own.
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Workspace’s own work' })
  check("the workspace's own work lists none of the whole workspace's", !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`).count()) === 1 && (await page.locator(`${pageSel} .perf-scenarios`).count()) === 0, HUNG_MS)))
  await importFile(path.join(FIX, 'baseline.json'))
  check('…and refuses a scenario benchmark there, saying why', !!(await until(async () => (await page.locator('.toast', { hasText: 'not the workspace’s own work' }).count()) >= 1, HUNG_MS)))
  const ownExport = (file, requests, chars, hoursAgo) => {
    const to = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
    const from = new Date(Date.parse(to) - 86_400_000).toISOString()
    // The Assistant's launch and its tool list: no workflow role (HI-2049).
    const guidance = [{ provider: 'claude-code', role: 'assistant', workflow: 'none', launches: 1, guidanceBytes: 4000, customBytes: 0, roleBytes: 500, modeBytes: 300, skillCatalogBytes: 200 }]
    const catalog = [{ role: 'assistant', workflow: 'none', starts: 1, tools: 40, toolsBytes: 20100, toolsChars: 20000, charStarts: 1 }]
    const workspace = { api: [{ route: '/v1/tasks', method: 'GET', role: 'api', outcome: 'ok', count: requests, requestBytes: requests * 10, responseBytes: requests * 100 }], mcp: [{ tool: 'cw_list_tasks', role: 'assistant', mode: 'compact', outcome: 'ok', count: 2, chars }], guidance, catalog }
    fs.writeFileSync(file, JSON.stringify({ schema: 'combwork-metrics/1', app: { version: '0.0.0' }, exportedAt: to, report: { scope: { kind: 'workspace' }, from, to, filters: { own: true }, coverage: { observedMs: 3_600_000, rangeMs: 86_400_000 }, projects: {}, workspace } }))
    return file
  }
  await importFile(ownExport(path.join(lib.WORK, 'perfcompare-own-before.json'), 10, 1000, 30))
  await importFile(ownExport(path.join(lib.WORK, 'perfcompare-own-after.json'), 30, 900, 2))
  const measures = page.locator(`${pageSel} .perf-comparison .data-table`)
  check('two own-work exports compare, measure by measure', !!(await until(async () => (await measures.locator('tbody tr').count()) > 3, HUNG_MS)))
  const names = (await measures.locator('tbody tr td:first-child').allInnerTexts()).map((t) => t.trim())
  check('…with the tool list a launch, and each workflow role’s launches apart (HI-2049)', ['Tool list a launch', 'Guidance a launch · no workflow role', 'Tool list a launch · no workflow role'].every((n) => names.includes(n)) && !names.some((n) => /builders/.test(n)), JSON.stringify(names))
  const changes = async () => (await measures.locator('tbody tr td:last-child').allInnerTexts()).map((t) => { const m = /\(([+-]?[\d.]+)%\)/.exec(t); return m ? Number(m[1]) : null })
  await measures.locator('th button', { hasText: 'Change' }).click()
  const sortedChanges = (await changes()).filter((x) => x !== null)
  check('…sorted by Change, the biggest rise first (+200%), the fall (−10%) after the rises', sortedChanges[0] === 200 && sortedChanges.includes(-10) && sortedChanges.every((x, i) => !i || sortedChanges[i - 1] >= x), JSON.stringify(await changes()))
  await measures.locator('th button', { hasText: 'Change' }).click()
  await measures.locator('th button', { hasText: 'Change' }).click()
  const ownQuery = { scope: { kind: 'workspace' }, own: true, from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() }
  for (let i = 1; i <= 9; i++) await inv('benchmarks:keep', ownQuery, `View ${i}`)
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Whole workspace' })
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Workspace’s own work' })
  const kept = page.locator(`${pageSel} .perf-kept`)
  await until(async () => /\(11\)/.test(await kept.locator('summary').innerText().catch(() => '')), HUNG_MS)
  await kept.locator('summary').click()
  const keptPaging = async () => ((await kept.locator('.table-paging').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  check('the kept list: eleven, ten a page', /1–10 of 11/.test(await keptPaging()), await keptPaging())
  await kept.locator('th button', { hasText: 'When' }).click()
  check('…sorted by When, the newest first', ((await kept.locator('tbody tr').first().innerText()) ?? '').trim().startsWith('View 9'), await kept.locator('tbody tr').first().innerText())
  await kept.locator('input[aria-label="Filter Kept"]').fill('View 7')
  check('…filtered by name', (await kept.locator('tbody tr').count()) === 1 && /View 7/.test(await kept.locator('tbody tr').first().innerText()))
  await kept.locator('select[aria-label="Filter Kind"]').selectOption('Performance view')
  await kept.locator('input[aria-label="Filter Kept"]').fill('nothing like a name')
  check('…no matches: says so', (await kept.locator('.table-no-match').count()) === 1)
  await kept.locator('.table-no-match button', { hasText: 'Clear filters' }).click()
  check('…and Clear filters brings them back', /of 11/.test(await keptPaging()), await keptPaging())
  await kept.locator('th button', { hasText: 'When' }).click()
  await kept.locator('th button', { hasText: 'When' }).click()
  await kept.locator('summary').click()
  await page.locator(`${pageSel} select[aria-label="Scope"]`).selectOption({ label: 'Whole workspace' })
  await until(async () => (await page.locator(`${pageSel} .perf-scenarios`).count()) === 1, HUNG_MS)

  // A Performance export against a scenario benchmark: not comparable, and why.
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Now' }).click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  await page.locator(`${pageSel} button`, { hasText: 'Keep current view' }).click()
  await page.locator('.dialog input.input').first().fill('Today, whole workspace')
  await page.locator('.dialog .btn.primary').click()
  await lib.sleep(800)
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'Today, whole workspace' })
  check('an export against a benchmark is not comparable, and says why', !!(await until(async () => /measure different things/.test(await page.locator(`${pageSel} .banner.warn`).innerText().catch(() => '')), HUNG_MS)))

  // A project's page: a scenario benchmark is refused; its own kept views compare.
  await page.locator('.activitybar button[aria-label="Projects"]').click()
  await page.locator('.sidebar .row', { hasText: 'alpha' }).first().click()
  await page.locator('.tab', { hasText: 'Performance' }).click()
  await page.locator(`${pageSel} .segmented button`, { hasText: 'Compare' }).click()
  check("a project's Compare lists none of the workspace's", !!(await until(async () => (await page.locator(`${pageSel} .perf-compare .empty-state`).count()) === 1, HUNG_MS)))
  await importFile(path.join(FIX, 'baseline.json'))
  check('…and refuses a scenario benchmark, saying where it belongs', !!(await until(async () => (await page.locator('.toast, .notification', { hasText: 'not one of your projects' }).count()) >= 1, HUNG_MS)))
  for (const label of ['Before', 'After']) {
    await page.locator(`${pageSel} button`, { hasText: 'Keep current view' }).click()
    await page.locator('.dialog input.input').first().fill(label)
    await page.locator('.dialog .btn.primary').click()
    await lib.sleep(800)
  }
  check("…its own kept views compare, per hour recorded", !!(await until(async () => (await page.locator(`${pageSel} .perf-comparison table`).count()) === 1, HUNG_MS)))
  const alphaList = await inv('benchmarks:list', { kind: 'project', project: 'alpha' })
  check('…kept for alpha only', alphaList.entries.length === 2 && alphaList.entries.every((e) => e.scope.kind === 'project'), JSON.stringify(alphaList.entries.map((e) => e.scope)))
  await shot('project-dark')

  // Light, and narrow.
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await page.locator(`${pageSel} select[aria-label="Run"]`).selectOption({ label: 'fake, fixtures v5 (smaller but wrong)' })
  // The scenarios table sorts by a header (#250); its default is worst first.
  const scenarioIds = async () => (await page.locator(`${pageSel} .perf-scenarios tbody tr:not(.table-detail) td:first-child`).allInnerTexts()).map((x) => x.trim())
  await until(async () => (await scenarioIds()).length > 1, HUNG_MS)
  await page.locator(`${pageSel} .perf-scenarios th button`, { hasText: 'Scenario' }).click()
  const byName = await scenarioIds()
  check('the scenarios sort by name', byName.length > 1 && byName.every((x, i) => !i || byName[i - 1].localeCompare(x) <= 0), byName.join())
  await page.locator(`${pageSel} .perf-scenarios th button`, { hasText: 'Scenario' }).click()
  await page.locator(`${pageSel} .perf-scenarios th button`, { hasText: 'Scenario' }).click()
  check('…and back to worst first', (await page.locator(`${pageSel} .perf-scenarios th[aria-sort="ascending"]`, { hasText: 'Result' }).count()) === 1, (await scenarioIds()).join())
  check('the kept list is a table too', (await page.locator(`${pageSel} .perf-kept th`, { hasText: 'When' }).count()) === 1)
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(800)
  await shot('failing-light')
  await lib.fitWindow(app, page, { width: 720, height: 900 })
  await lib.sleep(800)
  const overflow = await page.locator(pageSel).evaluate((el) => el.scrollWidth - el.clientWidth)
  check('narrow: the page itself has no sideways scroll', overflow <= 1, String(overflow))
  await shot('narrow-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
