// Performance: the activity bar's view and a project's tab, from a known saved metrics file (no agent is started).
// Ranges and their trend, the scope (whole workspace, the workspace's own work, one project) and role filters, a
// project's tab holding only its project, each filter framing only the sections it changes (Provider keeping every
// provider to pick from), reading it adds nothing, a scope switched while a slow query is still out
// (the late reply isn't shown), the empty and not-recording states, Export (plain and sanitized) and screenshots at
// two widths in both themes.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'performance-profile')
const ws = path.join(lib.WORK, 'performance-ws')
const out = path.join(lib.WORK, 'performance-export.json')
for (const d of [userData, ws, out]) fs.rmSync(d, { recursive: true, force: true })
lib.enableProviders(userData)
for (const p of ['alpha', 'beta', 'gamma']) fs.mkdirSync(path.join(ws, p), { recursive: true })

const HOUR = 3_600_000
const BOUNDS = 14
const timed = (count, ms) => {
  const histogram = Array(BOUNDS).fill(0)
  // 1, 2, 5, 10, 20, 50, 100, 200, 500 ms…: put each in its bucket.
  const bounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
  const i = bounds.findIndex((b) => ms <= b)
  histogram[i < 0 ? BOUNDS - 1 : i] = count
  return { count, totalMs: count * ms, maxMs: ms, histogram }
}
const apiSeries = (route, role, outcome, count, ms = 8) => ({ route, method: route.includes(':n') ? 'GET' : 'GET', role, outcome, ...timed(count, ms), requestBytes: count * 20, responseBytes: count * 900 })
const mcpSeries = (tool, count, chars) => ({ tool, role: 'agent', mode: 'compact', outcome: 'ok', ...timed(count, 4), chars: count * chars, bytes: count * chars })
const launch = (provider, launches) => ({ provider, role: 'agent', workflow: 'builder', launches, guidanceBytes: launches * 3000, guidanceChars: launches * 3000, customBytes: 0, customChars: 0, roleBytes: 0, roleChars: 0, modeBytes: 0, modeChars: 0, skills: launches * 6, skillCatalogBytes: launches * 1200, skillBytes: launches * 40000, skillsNotDelivered: 0, skillsUnmeasured: 0 })
const part = (api = [], mcp = [], guidance = [], catalog = []) => ({ api: Object.fromEntries(api.map((s, i) => [String(i), s])), mcp: Object.fromEntries(mcp.map((s, i) => [String(i), s])), guidance: Object.fromEntries(guidance.map((s, i) => [String(i), s])), catalog: Object.fromEntries(catalog.map((s, i) => [String(i), s])) })
// Two builder starts' tool lists (HI-2063): 50,000 characters a start, 20,000 of them descriptions and 8,000 parameters'.
const toolList = { role: 'agent', workflow: 'builder', starts: 2, tools: 80, toolsBytes: 102000, toolsChars: 100000, charStarts: 2, partStarts: 2, partToolsChars: 100000, descriptionChars: 40000, paramChars: 16000 }
// The same list to Claude Code reviewers (HI-2553): 3,000 bytes of it up front (deferred tools).
const claudeToolList = { ...toolList, provider: 'claude-code', workflow: 'reviewer', upfrontStarts: 2, upfrontBytes: 6000 }
const now = Date.now()
const hourStart = (t) => Math.floor(t / HOUR) * HOUR
const bucket = (start, projects, workspace = part()) => ({ start, span: 'hour', projects, workspace, skills: { scans: timed(3, 40), sharedScans: 1, hits: 30, misses: 4, invalidations: 1, tooLarge: 0, files: 40, bytes: 120000, headerBytes: 4000, entries: 60 }, dropped: 0, droppedBy: {} })
// The last 24 hours: alpha 30 requests (3 failed), beta 12 (2 refused by a rule), the workspace's own 5 (scripts); 3 days ago alpha 100 more.
const MORE_TOOLS = ['cw_list_projects', 'cw_project_status', 'cw_session_usage', 'cw_list_shared_notes', 'cw_read_shared_note', 'cw_write_shared_note', 'cw_read_latest_handover', 'cw_create_handover', 'cw_notify', 'cw_list_providers', 'cw_agent_activity']
const buckets = [
  // …and one request past the histogram's last bound (> 10 s), so latency sorts meet an overflow (#305).
  bucket(hourStart(now - 3 * 24 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 100), apiSeries('/v1/projects', 'agent', 'ok', 1, 20000)], MORE_TOOLS.map((t, i) => mcpSeries(t, 1, 100 + i))) }),
  bucket(hourStart(now - 5 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 20), apiSeries('/v1/tasks/:n', 'agent', 'server-error', 3, 300)], [mcpSeries('cw_list_tasks', 10, 600), mcpSeries('cw_read_task', 4, 2500)], [launch('claude-code', 2)], [toolList, claudeToolList]) }),
  bucket(hourStart(now - 1 * HOUR), { alpha: part([apiSeries('/v1/tasks', 'agent', 'ok', 7)]), beta: part([apiSeries('/v1/tasks', 'agent', 'ok', 10), { ...apiSeries('/v1/tasks/:n', 'agent', 'refused', 2), reasons: { 'rule:move.doingNobody': 2 } }], [mcpSeries('cw_list_tasks', 2, 600)], [launch('codex', 1)]) }, part([apiSeries('/v1/tasks', 'api', 'ok', 5)]))
]
fs.mkdirSync(path.join(ws, '.combwork', 'metrics'), { recursive: true })
/** Claude Code sessions in a session host's backups (what Provider usage reads), each a request an hour ago. */
const sessionsIn = (host, ids) => {
  const at = new Date(now - HOUR).toISOString()
  fs.mkdirSync(path.join(host, '.combwork', 'sessions'), { recursive: true })
  for (const id of ids) {
    const lines = [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Go' } }, { type: 'assistant', requestId: `${id}-r`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 40 } } }]
    fs.writeFileSync(path.join(host, '.combwork', 'sessions', `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  fs.writeFileSync(path.join(host, '.combwork', 'sessions.json'), JSON.stringify({ version: 1, sessions: ids.map((id) => ({ id, agent: 'claude-code', name: id.slice(-4), createdAt: at, lastActiveAt: at, archived: false })) }))
}
sessionsIn(path.join(ws, 'alpha'), ['66666666-aaaa-bbbb-cccc-000000000001', '66666666-aaaa-bbbb-cccc-000000000002'])
sessionsIn(path.join(ws, '.combwork', 'assistant'), ['66666666-aaaa-bbbb-cccc-000000000003'])
// One loss Combwork couldn't attribute to a project (its bookkeeping was full), in alpha's hour.
Object.assign(buckets[1], { dropped: 1, droppedBy: { '\u0000untracked': 1 } })
// Observed: around the older work, then the last day with a 4-hour gap (Combwork closed) 10 to 6 hours ago.
const observed = [
  [now - 3 * 24 * HOUR - HOUR, now - 3 * 24 * HOUR + 2 * HOUR],
  [now - 26 * HOUR, now - 10 * HOUR],
  [now - 6 * HOUR, now - 60_000]
]
fs.writeFileSync(path.join(ws, '.combwork', 'metrics', 'metrics.json'), JSON.stringify({ version: 1, buckets, observed, evictedThrough: now - 5 * 24 * HOUR }))

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
  const card = (title) => page.locator('.performance-page:visible .card', { hasText: title }).first().locator('.value')
  const requests = () => card('API requests').innerText().catch(() => '')
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `performance-${name}.png`) })
  // Export: the save dialog answered in main, to a test path; each export read back.
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, out)
  const exported = async (modifiers = []) => {
    fs.rmSync(out, { force: true })
    await page.locator('.performance-page:visible button', { hasText: 'Export' }).click({ modifiers })
    const text = await until(async () => fs.existsSync(out) && fs.readFileSync(out, 'utf8'), HUNG_MS)
    return text ? { text, json: JSON.parse(text) } : null
  }
  const trendRequests = (e) => e.json.report.trend.reduce((n, p) => n + p.requests, 0)

  await page.locator('.activitybar button[aria-label="Performance"]').click()
  check('the activity bar opens Performance', !!(await until(async () => (await page.locator('.performance-page:visible h1', { hasText: 'Performance' }).count()) === 1, HUNG_MS)))
  check('24 hours by default: the workspace is every project and its own work', !!(await until(async () => (await requests()) === '47', HUNG_MS)), await requests())
  const bars = page.locator('.perf-trend .daily-col')
  check('an hourly trend with every hour of the range', (await bars.count()) === 25, String(await bars.count()))
  check('the tools table is sorted by characters', (await page.locator('.table-wrap').first().locator('tbody tr td:first-child').allInnerTexts()).join() === 'cw_read_task,cw_list_tasks', (await page.locator('.table-wrap').first().locator('tbody tr td:first-child').allInnerTexts()).join())
  check('the skill service is shown for the workspace', (await page.locator('h2', { hasText: 'Skill service' }).count()) === 1)
  check('the 24 hours don’t reach history removed for space', !/removed to keep/.test(await page.locator('.perf-coverage').innerText()))
  check('coverage: how long Combwork was recording, and the gap', /Recorded for \d+ h/.test(await page.locator('.perf-coverage').innerText()), await page.locator('.perf-coverage').innerText())
  check('…the unrecorded hours are hatched in the trend, not shown as zero', (await page.locator('.perf-trend .daily-col.unobserved').count()) >= 3, String(await page.locator('.perf-trend .daily-col.unobserved').count()))
  // Each table sorts by a header, and remembers it (#250): the tools by calls, the routes by failures, launches by count.
  const perfTable = (header) => page.locator('.performance-page:visible .data-table', { has: page.locator('th', { hasText: header }) }).first()
  const firstCells = async (t) => (await t.locator('tbody tr td:first-child').allInnerTexts()).map((x) => x.trim()).join()
  const tools = perfTable('Per call')
  await tools.locator('th button', { hasText: /^Calls/ }).click()
  check('the tools table sorts by Calls, most first', (await firstCells(tools)) === 'cw_list_tasks,cw_read_task', await firstCells(tools))
  check('…remembered for the table', !!(await until(async () => (await inv('ui:get'))?.panes?.['table-sort:perf-tools:calls'] === 2, HUNG_MS)), JSON.stringify((await inv('ui:get'))?.panes))
  await page.locator('.activitybar button[aria-label="Projects"]').click()
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  check('…and still sorted so when the view comes back', !!(await until(async () => (await firstCells(tools)) === 'cw_list_tasks,cw_read_task', HUNG_MS)), await firstCells(tools))
  await tools.locator('th button', { hasText: /^Calls/ }).click()
  await tools.locator('th button', { hasText: /^Calls/ }).click()
  check('…until it goes back to its default (characters), which keeps nothing', (await firstCells(tools)) === 'cw_read_task,cw_list_tasks' && !Object.keys((await inv('ui:get'))?.panes ?? {}).some((k) => k.startsWith('table-sort:perf-tools:')), await firstCells(tools))
  const routes = perfTable('Route')
  await routes.locator('th button', { hasText: 'Errors' }).click()
  check('the routes table sorts by Errors (real ones, HI-2553)', /\/v1\/tasks\/:n/.test((await routes.locator('tbody tr').first().innerText()) ?? ''), await routes.locator('tbody tr').first().innerText())
  await routes.locator('th button', { hasText: 'Errors' }).click()
  await routes.locator('th button', { hasText: 'Errors' }).click()
  const launches = perfTable('Launches')
  await launches.locator('th button', { hasText: 'Launches' }).click()
  await launches.locator('th button', { hasText: 'Launches' }).click()
  check('the guidance table sorts by Launches (fewest first)', (await firstCells(launches)) === 'Codex,Claude Code', await firstCells(launches))
  await launches.locator('th button', { hasText: 'Launches' }).click()
  const usage = perfTable('Cache read')
  const usageWho = async () => (await usage.locator('tbody tr td:nth-child(2)').allInnerTexts()).map((x) => x.trim()).join()
  check('Provider usage has the agents’ and the Assistant’s rows', !!(await until(async () => (await usageWho()).split(',').sort().join() === 'Agents,Assistant', HUNG_MS)), await usageWho())
  await usage.locator('th button', { hasText: 'Sessions' }).click()
  check('…sorted by Sessions, most first: the agents’ two', (await usageWho()) === 'Agents,Assistant', await usageWho())
  await usage.locator('th button', { hasText: 'Sessions' }).click()
  check('…then fewest first: the Assistant’s one', (await usageWho()) === 'Assistant,Agents', await usageWho())
  await usage.locator('th button', { hasText: 'Sessions' }).click()
  check('the guidance table has each part', /Core\|Project\|Role\|Mode/i.test((await page.locator('.table-wrap th').allInnerTexts()).join('|')), (await page.locator('.table-wrap th').allInnerTexts()).join('|'))
  const guidanceTable = page.locator('.performance-page:visible .table-wrap', { has: page.locator('th', { hasText: 'Core' }) }).filter({ has: page.locator('th', { hasText: 'Workflow role' }) })
  const toolTable = page.locator('.performance-page:visible .table-wrap', { has: page.locator('th', { hasText: 'Descriptions' }) })
  const toolRow = async () => ((await toolTable.locator('tbody tr').allInnerTexts()).join('|')).replace(/\s+/g, ' ')
  check('the Combwork tool list a start, by workflow role, in its parts (HI-2063)', (await toolTable.count()) === 1 && /Builder 2 40 50,000 20,000 8,000 22,000/.test(await toolRow()), await toolRow())
  check('…and each launch’s workflow role (HI-2049)', (await guidanceTable.count()) === 1 && (await guidanceTable.locator('tbody tr', { hasText: 'Builder' }).count()) >= 1, (await page.locator('.table-wrap th').allInnerTexts()).join('|'))
  // HI-2553: failures by kind. Real errors stand out; refusals by a rule read as normal, with their reasons.
  const failures = page.locator('.performance-page:visible .card', { has: page.locator('h3', { hasText: 'Failures' }) })
  check('the Failures card: the real errors, then refused by a rule and wrong calls', /3 real errors/.test(await failures.innerText()) && /2 refused by a rule · 0 wrong calls/.test(await failures.innerText()) && (await failures.locator('.perf-real-errors').count()) === 1, await failures.innerText())
  const reasonsTable = page.locator('.performance-page:visible .table-wrap', { has: page.locator('th', { hasText: /^Reason/ }) }).filter({ has: page.locator('th', { hasText: /^Kind/ }) })
  check('…and the refusals by reason: its rule, never its text', /\/v1\/tasks\/:n\s+Refused\s+rule:move\.doingNobody\s+2/.test(await reasonsTable.locator('tbody').innerText()), await reasonsTable.locator('tbody').innerText().catch(() => ''))
  check('the Combwork tool list by provider, with what Claude Code got up front', /Claude Code\s+Agents\s+Reviewer/.test(await toolRow()) && /Unknown\s+Agents\s+Builder/.test(await toolRow()) && (await toolTable.locator('th', { hasText: 'Up front' }).count()) === 1, await toolRow())
  check('…the Guidance per launch card has the tool list beside it', /Tool list .* a start/.test(await page.locator('.performance-page:visible .card', { hasText: 'Guidance per launch' }).innerText()), await page.locator('.performance-page:visible .card', { hasText: 'Guidance per launch' }).innerText())
  check('cancelled requests are shown apart from failures', /cancelled/.test(await page.locator('.performance-page:visible .card', { hasText: 'API requests' }).innerText()))
  await shot('wide-dark')

  await page.locator('.performance-page:visible .segmented button', { hasText: '7 days' }).click()
  check('7 days adds the older work, with a daily trend', !!(await until(async () => (await requests()) === '148', HUNG_MS)) && (await bars.count()) === 8, `${await requests()} ${await bars.count()}`)
  const tools7 = perfTable('Per call')
  const toolPaging = async () => ((await tools7.locator('.table-paging').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
  check('…its tools table pages: thirteen tools, ten a page', /1–10 of 13/.test(await toolPaging()) && (await tools7.locator('tbody tr').count()) === 10, await toolPaging())
  await tools7.locator('input[aria-label="Filter Tool"]').fill('shared_note')
  check('…and filters by tool', !!(await until(async () => (await firstCells(tools7)).split(',').sort().join() === 'cw_list_shared_notes,cw_read_shared_note,cw_write_shared_note', HUNG_MS)), await firstCells(tools7))
  await tools7.locator('input[aria-label="Filter Tool"]').fill('nothing like a tool')
  check('…no matches: says so', (await tools7.locator('.table-no-match').count()) === 1)
  await tools7.locator('.table-no-match button', { hasText: 'Clear filters' }).click()
  check('…and Clear filters brings them back', !!(await until(async () => /of 13/.test(await toolPaging()), HUNG_MS)), await toolPaging())
  // Latency past the histogram's last bound ("> 10 s") is the slowest, whichever way p95 sorts; rows with none come last (#305).
  const routes7 = perfTable('Route')
  const routeOrder = async () => (await routes7.locator('tbody tr').allInnerTexts()).map((t) => (/\/v1\/\S+/.exec(t) ?? [''])[0])
  await routes7.locator('th button', { hasText: 'p95' }).click()
  check('routes by p95, slowest first: the one over 10 s leads', (await routeOrder())[0] === '/v1/projects' && /> 10 s/.test(await routes7.locator('tbody tr').first().innerText()), JSON.stringify(await routeOrder()))
  await routes7.locator('th button', { hasText: 'p95' }).click()
  check('…fastest first: it comes last', (await routeOrder()).at(-1) === '/v1/projects', JSON.stringify(await routeOrder()))
  await routes7.locator('th button', { hasText: 'p95' }).click()
  check('…and says history Combwork removed for space is unavailable', /removed to keep the performance history under its size limit/.test(await page.locator('.perf-coverage').innerText()), await page.locator('.perf-coverage').innerText())
  await page.locator('.performance-page:visible .segmented button', { hasText: '24 hours' }).click()
  await until(async () => (await requests()) === '47', HUNG_MS)

  // Reading it adds nothing: Refresh shows the same.
  await page.locator('.performance-page:visible button[aria-label="Refresh"]').click()
  await lib.sleep(800)
  check('reading the page adds nothing to it', (await requests()) === '47', await requests())

  await page.locator('.sidebar .row', { hasText: 'alpha' }).click()
  check("the sidebar's project: only its work", !!(await until(async () => (await requests()) === '30', HUNG_MS)), await requests())
  check('…named in the header', (await page.locator('.perf-scope').innerText()).includes('alpha'))
  check('…and no skill service (shared by the workspace)', (await page.locator('h2', { hasText: 'Skill service' }).count()) === 0)
  check("…with the warning that some losses couldn't be attributed, as on its tab", /couldn’t be attributed/.test(await page.locator('.perf-coverage').innerText()))
  await page.locator('.sidebar .row', { hasText: 'Workspace’s own work' }).click()
  check("the workspace's own work", !!(await until(async () => (await requests()) === '5', HUNG_MS)), await requests())
  const ownFile = await exported()
  check("…its trend and its export are its own too (no project's)", ownFile && trendRequests(ownFile) === 5 && Object.keys(ownFile.json.report.projects).length === 0 && ownFile.json.filters.own === true, ownFile && JSON.stringify({ t: trendRequests(ownFile), p: Object.keys(ownFile.json.report.projects), f: ownFile.json.filters }))
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  await until(async () => (await requests()) === '47', HUNG_MS)
  await page.locator('select[aria-label="Who did the work"]').selectOption('api')
  check('the role filter: scripts only', !!(await until(async () => (await requests()) === '5', HUNG_MS)), await requests())
  const scriptsFile = await exported()
  check('…in the trend and the export too, with the filter named', scriptsFile && trendRequests(scriptsFile) === 5 && scriptsFile.json.filters.role === 'api' && scriptsFile.json.report.trend.every((p) => p.launches === 0), scriptsFile && JSON.stringify(scriptsFile.json.filters))
  check('…and what the filter can’t narrow is said', /shared: not per role or provider/.test(await page.locator('.perf-coverage').innerText()))
  await page.locator('select[aria-label="Who did the work"]').selectOption('all')
  await until(async () => (await requests()) === '47', HUNG_MS)

  // Each filter sits with the sections it changes (#270): Who frames the cards, chart and tables, not the skill
  // service; Provider frames launches and the providers' usage only, and keeps every provider to pick from.
  const who = page.locator('.performance-page:visible .perf-group', { has: page.locator('select[aria-label="Who did the work"]') }).first()
  const byProvider = page.locator('.performance-page:visible .perf-by-provider')
  check('Who frames the cards, chart and tables, not the skill service', (await who.locator('.cards').count()) === 1 && (await who.locator('.perf-trend').count()) === 1 && (await who.locator('h2', { hasText: 'Skill service' }).count()) === 0 && (await page.locator('.performance-page:visible .perf-controls select[aria-label="Who did the work"]').count()) === 0)
  check('Provider frames only launches and the providers’ usage', (await byProvider.locator('select[aria-label="Provider"]').count()) === 1 && (await byProvider.locator('.cards').count()) === 0 && (await byProvider.locator('h2', { hasText: 'Combwork tools' }).count()) === 0 && (await byProvider.locator('h2', { hasText: 'Guidance at launch' }).count()) === 1)
  const providerOptions = () => page.locator('select[aria-label="Provider"] option').allInnerTexts()
  const guidanceRows = () => byProvider.locator('.data-table', { has: page.locator('th', { hasText: 'Launches' }) }).locator('tbody tr td:first-child').allInnerTexts()
  check('…offering every provider with data', (await providerOptions()).join() === 'All providers,Claude Code,Codex', (await providerOptions()).join())
  await page.locator('select[aria-label="Provider"]').selectOption('codex')
  check('picking Codex narrows its sections to Codex', !!(await until(async () => (await guidanceRows()).join() === 'Codex', HUNG_MS)), (await guidanceRows()).join())
  check('…leaves the sections it doesn’t frame as they were', (await requests()) === '47' && /3 launches/.test(await page.locator('.performance-page:visible .card', { hasText: 'Guidance per launch' }).innerText()), `${await requests()} ${await page.locator('.performance-page:visible .card', { hasText: 'Guidance per launch' }).innerText()}`)
  check('…and still offers Claude Code', (await providerOptions()).join() === 'All providers,Claude Code,Codex', (await providerOptions()).join())
  await byProvider.scrollIntoViewIfNeeded()
  await shot('provider-codex')
  // Export and Keep current view save what the page loaded, every provider's, so their launches and trend agree with
  // the cards whatever provider is picked (#270, round 2).
  const codexFile = await exported()
  const trendLaunches = (e) => e.json.report.trend.reduce((n, p) => n + p.launches, 0)
  check('…Export with Codex picked saves what the page shows: every provider’s launches, no provider filter', codexFile && trendLaunches(codexFile) === 3 && codexFile.json.filters.provider === undefined && /claude-code/.test(JSON.stringify(codexFile.json.report.projects)) && /codex/.test(JSON.stringify(codexFile.json.report.projects)), codexFile && JSON.stringify({ l: trendLaunches(codexFile), f: codexFile.json.filters }))
  await page.locator('.performance-page:visible .segmented button', { hasText: 'Compare' }).click()
  await page.locator('.performance-page:visible button', { hasText: 'Keep current view' }).click()
  await page.locator('.dialog input.input').first().fill('Codex picked')
  await page.locator('.dialog .btn.primary').click()
  const keptCodex = await until(async () => (await inv('benchmarks:list', { kind: 'workspace' })).entries.find((e) => e.label === 'Codex picked'), HUNG_MS)
  const keptSummary = keptCodex && (await inv('benchmarks:read', { kind: 'workspace' }, keptCodex.id)).summary
  check('…and so does Keep current view', keptSummary && keptSummary.totals.launches === 3 && keptSummary.filters.provider === undefined, keptSummary && JSON.stringify({ t: keptSummary.totals, f: keptSummary.filters }))
  await page.locator('.performance-page:visible .segmented button', { hasText: 'Now' }).click()
  await until(async () => (await requests()) === '47', HUNG_MS)
  await page.locator('select[aria-label="Provider"]').selectOption('claude-code')
  check('Codex → Claude Code in one step', !!(await until(async () => (await guidanceRows()).join() === 'Claude Code', HUNG_MS)), (await guidanceRows()).join())
  await page.locator('select[aria-label="Provider"]').selectOption('')

  // A scope switched while the last query is slow: the late answer for the old scope is never shown.
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = 'metrics:query=2500*1'
  })
  await page.locator('.sidebar .row', { hasText: 'alpha' }).click()
  await lib.sleep(300)
  await page.locator('.sidebar .row', { hasText: 'beta' }).click()
  check('a scope switched during a slow query shows the new scope', !!(await until(async () => (await requests()) === '12', HUNG_MS)), await requests())
  await lib.sleep(3000) // A fixed wait on purpose: the slowed answer for the old choice arrives later, and this checks it doesn't replace the new one.
  check("…and the old scope's late reply doesn't replace it", (await requests()) === '12', await requests())
  await app.evaluate(() => {
    process.env.CW_TEST_SLOW_IPC = ''
  })

  await page.locator('.sidebar .row', { hasText: 'gamma' }).click()
  check('a project with nothing recorded says so', !!(await until(async () => (await page.locator('.perf-empty').count()) === 1, HUNG_MS)))
  await shot('empty')

  // A provider chosen elsewhere stays visible in an empty scope, saying it has nothing there, and can be changed (#294).
  const providerSelect = page.locator('.performance-page:visible select[aria-label="Provider"]')
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  await until(async () => (await requests()) === '47', HUNG_MS)
  await providerSelect.selectOption('claude-code')
  await page.locator('.sidebar .row', { hasText: 'gamma' }).click()
  check('an empty scope keeps a chosen provider’s filter, saying it has nothing there', !!(await until(async () => (await page.locator('.performance-page:visible .perf-empty').count()) === 1 && (await providerSelect.count()) === 1 && (await providerSelect.inputValue()) === 'claude-code' && /Nothing from Claude Code in the last 24 hours/.test(await page.locator('.performance-page:visible .perf-by-provider').innerText()), HUNG_MS)))
  await shot('empty-provider')
  await providerSelect.selectOption('')
  check('…which can be set back to all providers (then, with nothing to filter, it goes)', !!(await until(async () => (await providerSelect.count()) === 0, HUNG_MS)))
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  check('…and back where there is data, everything shows, all providers', !!(await until(async () => (await requests()) === '47' && (await providerSelect.count()) === 1 && (await providerSelect.inputValue()) === '', HUNG_MS)))

  // Export of the whole workspace: plain, then sanitized.
  await page.locator('.sidebar .row', { hasText: 'Whole workspace' }).click()
  await until(async () => (await requests()) === '47', HUNG_MS)
  const plain = (await exported())?.json
  check('Export saves the report with its schema, version, units, coverage and trend', plain && plain.schema === 'combwork-metrics/1' && plain.app.version && plain.units.bytes && plain.coverage.observedMs > 0 && plain.report.trend.length === 25 && 'alpha' in plain.report.projects, JSON.stringify(plain).slice(0, 200))
  const clean = (await exported(['Shift']))?.text
  check('Shift+Export leaves out project names and the workspace path', clean && !/alpha|beta|performance-ws/.test(clean) && JSON.parse(clean).sanitized === true, clean && clean.slice(0, 200))

  // A project's tab: only its project, no scope choice.
  await page.locator('.activitybar button[aria-label="Projects"]').click()
  await page.locator('.sidebar .row', { hasText: 'beta' }).first().click()
  await page.locator('.tab', { hasText: 'Performance' }).click()
  check("a project's Performance tab shows only its project", !!(await until(async () => (await requests()) === '12', HUNG_MS)), await requests())
  check('…with no scope choice and agents as the only role', (await page.locator('select[aria-label="Scope"]').count()) === 0 && (await page.locator('select[aria-label="Who did the work"] option').count()) === 2)
  check('…and its own providers to pick from', (await providerOptions()).join() === 'All providers,Codex', (await providerOptions()).join())
  await shot('tab')

  // Not recording: a banner, and what was recorded is still shown.
  await inv('settings:update', { sessions: { recordPerformance: false } })
  await page.locator('.performance-page:visible button[aria-label="Refresh"]').click()
  check('not recording: a banner says so, the numbers stay', !!(await until(async () => (await page.locator('.perf-banner').count()) === 1, HUNG_MS)) && (await requests()) === '12')
  await inv('settings:update', { sessions: { recordPerformance: true } })

  // Light theme, and a narrow window.
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  await inv('settings:update', { appearance: { theme: 'light' } })
  await lib.sleep(800)
  await shot('wide-light')
  await lib.fitWindow(app, page, { width: 720, height: 900 })
  await lib.sleep(800)
  const overflow = await page.locator('.performance-page:visible').evaluate((el) => el.scrollWidth - el.clientWidth)
  check('narrow: the page itself has no sideways scroll', overflow <= 1, String(overflow))
  // A route stays on one line (HI-2534): its table scrolls sideways rather than breaking "/v1/tasks/:n" into fragments.
  let routeLines = []
  const routesOnOneLine = async () => {
    routeLines = await perfTable('Route')
      .locator('tbody td:first-child')
      .evaluateAll((tds) =>
        tds.map((td) => {
          const r = document.createRange()
          r.selectNodeContents(td)
          return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
        })
      )
      .catch(() => [])
    return routeLines.length > 0 && routeLines.every((n) => n === 1)
  }
  check('narrow: each route is on one line', !!(await until(routesOnOneLine, HUNG_MS)), JSON.stringify(routeLines))
  await shot('narrow-light')
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.sleep(800)
  await shot('narrow-dark')

  await app.close()
  console.log(failed ? `${failed} failed` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
