// Cost per card and per lane (#602), on fake Claude Code agents with a price of the user's for their model: a builder
// works on a card in Doing and a reviewer reviews it, in a lane, failing round 1 and passing round 2; the card's panel
// says "cost: ≈ $… · 2 rounds" with each side's part and tokens on hover, and its Work section its cost by round and
// role (HI-1906), adding up to it, screenshotted in both themes; the lane's hover splits its cost into cards and overhead (the builder's turn after
// the card passed, holding none); Performance's Cards table lists the card, sortable, a row opening it. A card held by
// an agent with no session is Unknown, never $0. The Agent API's card leaves the holds out. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and B1 is a 0.9 worktree agent (agents:testLegacy,
// refused by a packaged build).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take.
const HUNG_MS = 15000

const PORT = Number(lib.port(47826))
const userData = path.join(lib.WORK, 'cardcost-profile')
const ws = path.join(lib.WORK, 'cardcost-ws')
const claudeHome = path.join(lib.WORK, 'cardcost-claude-home')
const shots = path.join(lib.WORK, 'cardcost-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 150)
const plain = (s) => (s ?? '').replace(/ /g, ' ')

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.hiveEnv({ HIVE_USER_DATA: userData, HIVE_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, HIVE_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1400, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.waitForProvider(inv)
  // A price for the fake's model, so its usage has an estimated cost (≈).
  await inv('settings:setProviderPrices', 'claude-code', { 'claude-fake': { input: 100000, cachedInput: 10000, cacheWrite: 100000, output: 100000 } })
  const b = await lib.addAgent(inv, alpha, { name: 'B1', location: 'new-worktree' })
  const r = await lib.addAgent(inv, alpha, { name: 'R1' })
  const idle = await lib.addAgent(inv, alpha, { name: 'Idle' })
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, b.worktree?.path].filter(Boolean).map((d) => d.toLowerCase())))
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  for (const a of [b, r]) await inv('session:start', alpha, { agentId: a.id })
  check('the agents start', !!(await until(async () => (await live(b.id))?.status === 'ready' && (await live(r.id))?.status === 'ready', 45000)))
  const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const tokenOf = (a) => launches.filter((l) => l.cwd.toLowerCase() === (a.worktree?.path ?? alpha).toLowerCase()).at(-1)?.token
  const api = async (token, method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const [tb, tr] = [tokenOf(b), tokenOf(r)]
  check('each agent has its token', !!tb && !!tr && tb !== tr)
  /** A turn of an agent: a prompt, answered with some usage, until it has finished. */
  const turn = async (a) => {
    await lib.sendPrompt(inv, lib.ptyKey(alpha, a.id), 'hello', { submitted: async () => ['working', 'finished'].includes((await live(a.id))?.status) })
    return !!(await until(async () => (await live(a.id))?.status === 'finished', HUNG_MS))
  }

  // --- A lane: B1 builds the card, R1 reviews it.
  const n = (await inv('tasks:create', { title: 'Cost per card', project: 'alpha', column: 'doing', agent: b.id })).number
  const lane = await api(tb, 'POST', '/v1/lanes', { cards: [n], reviewer: 'R1', name: 'costs' })
  check('the lane starts', lane.status === 200, JSON.stringify(lane))
  const laneId = lane.body?.lane?.id
  check("the builder's turn on the card", await turn(b))
  check('…to Review', (await api(tb, 'PATCH', `/v1/tasks/${n}`, { column: 'review', comment: 'Ready.' })).status === 200)
  check('the reviewer starts', (await api(tr, 'PATCH', `/v1/tasks/${n}`, { review: 'start' })).status === 200)
  check("the reviewer's turn", await turn(r))
  // Round 1 fails (HI-1906: a card's cost by round), round 2 passes.
  // Its project has no workflow chosen (no Review stage in its rules): the old move, which sends it back to Doing as the
  // verdict intent does (HI-1946), its builder holding it for round 2.
  const failedIt = await api(tr, 'PATCH', `/v1/tasks/${n}`, { review: 'failed', comment: 'Fix it.' })
  check('…and fails it: back in Doing, its builder’s', failedIt.status === 200 && failedIt.body?.column === 'doing' && failedIt.body?.agent?.name === 'B1', JSON.stringify(failedIt.body))
  check("the builder's turn on round 2", await turn(b))
  check('…to Review again', (await api(tb, 'PATCH', `/v1/tasks/${n}`, { column: 'review', comment: 'Fixed.' })).status === 200)
  check('the reviewer starts round 2', (await api(tr, 'PATCH', `/v1/tasks/${n}`, { review: 'start' })).status === 200)
  check("the reviewer's turn on round 2", await turn(r))
  check('…and passes it', (await api(tr, 'PATCH', `/v1/tasks/${n}`, { review: 'passed', column: 'passed', comment: 'Passed.' })).status === 200)
  // Holding no card now: the lane's overhead.
  check("the builder's turn after it passed", await turn(b))

  const cost = (await inv('costs:cards', { numbers: [n] }))[0]
  check('the card has a cost from both sides', !!cost && cost.build.priced > 0 && cost.build.cost > 0 && cost.review.priced > 0 && cost.review.cost > 0 && cost.total.estimated && cost.total.unpriced === 0, JSON.stringify(cost))
  check('…and two rounds', cost?.rounds === 2)
  const holds = JSON.stringify((await inv('tasks:list')).find((c) => c.number === n)?.held?.map((h) => [h.name, h.role, !!h.to]))
  check('…its holds kept on the card: B1 building, R1 reviewing, twice', holds === JSON.stringify([['B1', 'build', true], ['R1', 'review', true], ['B1', 'build', true], ['R1', 'review', true]]), holds)
  // By round and role (HI-1906): each round's builder and reviewer parts, shares of the card's cost, adding up to it.
  const byRound = await inv('costs:rounds', n)
  const parts = byRound?.rounds.flatMap((x) => [x.build, x.review]) ?? []
  check('its cost by round: two rounds, each with a builder’s and a reviewer’s part', byRound?.rounds.length === 2 && parts.every((p) => p.priced > 0 && p.cost > 0) && !byRound.outside, JSON.stringify(byRound))
  check('…adding up to its cost', !!byRound?.total && Math.abs(parts.reduce((a, p) => a + p.cost, 0) - cost.total.cost) < 1e-9 && Math.abs(byRound.total.cost - cost.total.cost) < 1e-9)
  const viaApi = await api(tb, 'GET', `/v1/tasks/${n}`)
  check("the Agent API's card leaves its holds out", viaApi.status === 200 && !('held' in (viaApi.body ?? {})) && !('held' in ((await api(tb, 'GET', `/v1/tasks/${n}?history=false`)).body ?? {})))

  // --- Held by an agent that never ran: unknown, never $0.
  const m = (await inv('tasks:create', { title: 'Nobody ran', project: 'alpha', column: 'doing', agent: idle.id })).number
  const unknown = (await inv('costs:cards', { numbers: [m] }))[0]
  check("a card held by an agent with no session: Unknown", !!unknown && unknown.total.unpriced > 0 && unknown.total.priced === 0 && unknown.unmatched === 1, JSON.stringify(unknown))

  // --- The card's panel.
  const panel = page.locator('.progress-panel')
  await page.locator('.progress-rail').click()
  check('the Progress panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  const row = panel.locator(`.progress-lane[data-lane="${laneId}"]`)
  check('the lane shows', !!(await until(async () => (await row.count()) === 1, HUNG_MS)))
  await row.locator(`.lane-seg[data-card="${n}"]`).click()
  const dialog = page.locator('.dialog[role="dialog"]').first()
  const line = dialog.locator('[data-testid="card-cost"]')
  check('the card says its cost and rounds', !!(await until(async () => /^cost: ≈ \$\d+\.\d\d · 2 rounds$/.test(plain(await line.innerText().catch(() => ''))), HUNG_MS)), await line.innerText().catch(() => ''))
  // Its Work section's table: a row a round and the total, the builder's and reviewer's columns, adding up as shown.
  const table = dialog.locator('[data-testid="card-round-costs"]')
  check('its Work section shows its cost by round', !!(await until(async () => (await table.locator('tbody tr').count()) === 2, HUNG_MS)))
  const cents = (s) => Math.round(Number(plain(s).replace(/[^\d.]/g, '')) * 100)
  const cellsOf = async (round) => Promise.all(['build', 'review', 'total'].map(async (role) => cents(await table.locator(`tr[data-round="${round}"] td[data-role="${role}"]`).innerText())))
  const [r1, r2, sums] = [await cellsOf(1), await cellsOf(2), await cellsOf('total')]
  check('…each round’s builder and reviewer adding up to its total, and the rounds to the card’s cost line', r1[0] + r1[1] === r1[2] && r2[0] + r2[1] === r2[2] && r1[0] + r2[0] === sums[0] && r1[1] + r2[1] === sums[1] && sums[0] + sums[1] === sums[2] && sums[2] === cents((await line.innerText()).replace(/·.*/, '')), JSON.stringify({ r1, r2, sums, line: await line.innerText() }))
  await table.scrollIntoViewIfNeeded()
  const theme0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  for (const theme of ['dark', 'light']) {
    await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme)
    await page.mouse.move(5, 5)
    await page.screenshot({ path: path.join(shots, `card-rounds-${theme}.png`) })
  }
  await page.evaluate((th) => (th ? document.documentElement.setAttribute('data-theme', th) : document.documentElement.removeAttribute('data-theme')), theme0)
  await line.hover()
  const tip = page.locator('.tip', { hasText: 'Builder' }).last()
  check('…its builder’s and reviewer’s parts and tokens on hover', !!(await until(async () => /Builder ≈ \$.*in \d.*Reviewer ≈ \$.*in \d/s.test(plain(await tip.innerText().catch(() => ''))), HUNG_MS)), await tip.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(shots, 'card.png') })
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, HUNG_MS)

  // --- The lane's hover: its cost, on cards and overhead.
  await page.mouse.move(0, 0)
  await row.locator('.progress-lane-top').hover()
  const laneTip = page.locator('[data-testid="lane-cost"]')
  check("the lane's hover: its cost, on cards and overhead", !!(await until(async () => /Cost ≈ \$.*On cards ≈ \$.*Overhead ≈ \$/s.test(plain(await laneTip.innerText().catch(() => ''))), HUNG_MS)), await laneTip.innerText().catch(() => ''))
  const lc = (await inv('costs:lanes', [laneId]))[0]
  check('…overhead is the builder’s turn after the card passed', !!lc && lc.overhead.cost > 0 && lc.onCards.cost > 0 && Math.abs(lc.total.cost - lc.onCards.cost - lc.overhead.cost) < 1e-9 && lc.finished === 1, JSON.stringify(lc))
  await page.screenshot({ path: path.join(shots, 'lane.png') })
  await page.mouse.move(0, 0)

  // --- Performance's Cards table.
  await page.locator('.activitybar button[aria-label="Performance"]').click()
  const cards = page.locator('.performance-page:visible .table-wrap .table:has(th .th-sort:text-is("Rounds"))')
  // The cards by key (#1221).
  const [nName, mName] = [await lib.cardLabel(inv, n), await lib.cardLabel(inv, m)]
  const cardRow = cards.locator('tbody tr', { hasText: `${nName} Cost per card` })
  check('Performance lists the card', !!(await until(async () => (await cardRow.count()) === 1, HUNG_MS)))
  check('…with its cost and rounds', /≈ \$\d/.test(plain(await cardRow.innerText())) && /\b2\b/.test(await cardRow.innerText()), await cardRow.innerText())
  const unknownRow = cards.locator('tbody tr', { hasText: `${mName} Nobody ran` })
  check('…and the unknown one as Unknown, sorted last', /Unknown/.test(await unknownRow.innerText().catch(() => '')) && (await cards.locator('tbody tr').last().innerText()).includes(mName))
  await page.screenshot({ path: path.join(shots, 'performance.png') })
  await cardRow.click()
  // Its title is in a field (innerText leaves it out): the card's own cost line says it is this one.
  check('a row opens its card', !!(await until(async () => (await dialog.count()) === 1 && (await line.count()) === 1 && (await dialog.locator('input').first().inputValue().catch(() => '')) === 'Cost per card', HUNG_MS)))
  await page.keyboard.press('Escape')
  // At 900 px the card's name keeps a readable width (HI-2534): the table scrolls sideways rather than squeezing the
  // title to a word a line.
  await lib.fitWindow(app, page, { width: 900, height: 860 })
  const titleCell = cardRow.locator('td').first()
  const titleWidth = async () => (await titleCell.boundingBox())?.width ?? 0
  check('narrow: the card column keeps its width', !!(await until(async () => (await titleWidth()) >= 180, HUNG_MS)), String(await titleWidth()))
  for (const theme of ['light', 'dark']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.locator(`html[data-theme="${theme}"]`).count()) === 1, HUNG_MS)
    await cards.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(shots, `performance-900-${theme}.png`) })
  }

  for (const a of [b, r]) await inv('session:stop', alpha, a.id).catch(() => undefined)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
