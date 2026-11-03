// The Progress panel's merge card and lanes (#484), on fake Claude Code agents: idle, it is as before (no merge card,
// divider or lanes); lanes show right after the runs (#1309: Pulse lays out top to bottom, no gap), one row each with a segmented bar coloured and patterned by each
// card's column, blocked reason and review rounds, folding a long lane's finished cards into "✓ n", one lane only as
// tall as it is, four rows before the list scrolls and the section's top edge dragged (or Up and Down) for more or fewer
// in whole lanes, never squeezing the runs, double-click for four, kept folded and through a restart (#569), running lanes first, the card being worked as current, an ended or abandoned lane frozen as it was left
// (#512), hover text (with what a failed review's underline and the hatching mean, #706), a click opening the card, and the section folding to its bar; running lanes
// put in the user's order (#568): dragged with a line where they go (the list scrolled, and scrolling near its edge), Alt+Up and Alt+Down said to screen
// readers, the context menu, a new lane on top, a finished one to the very bottom, kept through a restart, and the usual order again; a lane's
// queued list change shown in the Lanes tab, gone once it applies (HI-2151); while an agent holds the merge slot, a
// card in the merge colour on top (holder, branch → main, its running step, time, who waits) with a divider, folding to
// one line; a short, zoomed window keeps the lanes inside the panel and a run readable. Screenshots of the idle, lanes,
// merging and short states in both themes. The lanes are #483's, started through the Agent API. Dev build, throwaway
// profile, workspace and CLAUDE_CONFIG_DIR.
// Dev build only (#1580): it starts this checkout's Electron itself, and B1 and B3 are 0.9 worktree agents
// (agents:testLegacy, refused by a packaged build). Idle and outside slots, each gets its lane in a new conversation
// (HI-2232), so a new token: the suite reads it again from that launch (HI-2254).
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const PORT = Number(lib.port(47925))
const userData = path.join(lib.WORK, 'progresslanes-profile')
const ws = path.join(lib.WORK, 'progresslanes-ws')
const claudeHome = path.join(lib.WORK, 'progresslanes-claude-home')
const shots = path.join(lib.WORK, 'progresslanes-shots')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = 10000) => lib.until(fn, ms, 150)

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
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
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.waitForProvider(inv)
  const b1 = await lib.addAgent(inv, alpha, { name: 'B1', location: 'new-worktree' })
  const r1 = await lib.addAgent(inv, alpha, { name: 'R1' })
  const b3 = await lib.addAgent(inv, alpha, { name: 'B3', location: 'new-worktree' })
  const live = async (id) => (await inv('session:live')).find((s) => s.agentId === id)
  // Their folders trusted, so the fake Claude Code starts at its prompt.
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha, b1.worktree?.path, b3.worktree?.path].filter(Boolean).map((d) => d.toLowerCase())))
  for (const a of [b1, r1, b3]) await inv('session:start', alpha, { agentId: a.id })
  const statuses = async () => (await Promise.all([b1, r1, b3].map((a) => live(a.id)))).map((s) => s?.status)
  check('the agents start', !!(await until(async () => (await statuses()).every((s) => s === 'ready'), 45000)), JSON.stringify(await statuses()))
  // The fake CLI's launches as now (each launch has its own token): read again where an agent is relaunched.
  const launchesNow = () => fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const launchesOf = (a) => launchesNow().filter((l) => l.cwd.toLowerCase() === (a.worktree?.path ?? alpha).toLowerCase())
  // Each agent's token, by the folder it runs in (B1 and B3 in their worktrees): its latest launch's.
  const tokenOf = (a) => launchesOf(a).at(-1)?.token
  const api = async (token, method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const tr = tokenOf(r1)
  // B1's and B3's change once their lanes give them new conversations (HI-2232, below).
  let [t1, t3] = [tokenOf(b1), tokenOf(b3)]
  check('each agent has its own token', !!t1 && !!tr && !!t3 && new Set([t1, tr, t3]).size === 3, JSON.stringify(launchesNow().map((l) => l.cwd)))

  // --- The board a lane reads: B1's eight cards, each somewhere else.
  // Each card's name as the window gives it (#1221): its key.
  const keyOf = new Map()
  const K = (n) => keyOf.get(n) ?? `#${n}`
  const make = async (title, column = 'todo', agent = b1.id) => {
    const c = await inv('tasks:create', { title, project: 'alpha', column, agent })
    keyOf.set(c.number, c.key)
    return c.number
  }
  const lane1 = []
  for (const t of ['Lane data', 'Lane tools', 'Panel layout', 'Segment colours', 'Merge card', 'Lane hover', 'Docs and tip', 'Screenshots']) lane1.push(await make(t, 'doing'))
  const [n1, n2, n3, n4, n5, n6, n7, n8] = lane1
  const toReview = async (n) => api(t1, 'PATCH', `/v1/tasks/${n}`, { column: 'review', comment: 'Ready.' })
  const verdict = async (n, review) => {
    await api(tr, 'PATCH', `/v1/tasks/${n}`, { review: 'start' })
    return api(tr, 'PATCH', `/v1/tasks/${n}`, review === 'passed' ? { review, column: 'passed', comment: 'Passed.' } : { review, comment: '**Round 1: FAILED: 1 finding**: the hover clips\n\n1. Fix it.' })
  }
  await toReview(n1)
  await verdict(n1, 'passed')
  await toReview(n2)
  await verdict(n2, 'passed')
  // #3: failed once, back in Review for round 2. #4: failed, being fixed in Doing.
  await toReview(n3)
  await verdict(n3, 'failed')
  const back = await api(t1, 'PATCH', `/v1/tasks/${n3}`, { column: 'review', comment: 'Fixed.' })
  await toReview(n4)
  await verdict(n4, 'failed')
  await api(t1, 'PATCH', `/v1/tasks/${n4}`, { column: 'doing' })
  await inv('tasks:update', n5, { column: 'todo' })
  await inv('tasks:update', n6, { blocked: 'Waiting for a design decision' })
  await inv('tasks:update', n7, { column: 'hold' })
  await inv('tasks:update', n8, { column: 'todo' })
  check('the board is set up', back.status === 200, JSON.stringify(back))
  // A long lane: 18 cards done (once it has started, below), 4 to do.
  const long = []
  for (let i = 0; i < 22; i++) long.push(await make(`Long ${i + 1}`, 'todo', b3.id))
  await inv('tasks:update', long[18], { column: 'doing' })
  const short = [await make('Small fix', 'review', r1.id), await make('Follow-up', 'todo', r1.id)]

  // --- Idle: the panel as before.
  const panel = page.locator('.progress-panel')
  await page.locator('.progress-rail').click()
  check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  const shoot = async (name) => {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      await lib.sleep(250)
      await page.screenshot({ path: path.join(shots, `${name}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  check('idle: no merge card, divider or lanes', (await panel.locator('.progress-merge, .progress-divider, .progress-lanes').count()) === 0)
  check('idle: "Nothing is running" as before', (await panel.locator('.progress-empty').count()) === 1)
  await shoot('idle')

  // --- Lanes, started through the Agent API (#483) as the Assistant or a script would, while the panel is open: the
  // panel follows lanes-changed. B1's, B3's (long), R1's (paused: its current card blocked), an ended one and an
  // abandoned one, and two more running (of agents that never ran): seven, one more than shows before scrolling (#512).
  for (const name of ['B5', 'B6', 'B7', 'B8']) await lib.addAgent(inv, alpha, { name })
  await inv('tasks:update', short[0], { blocked: 'Waiting for your answer' })
  const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const startLane = async (builder, reviewer, name, cards) => {
    const r = await api(workspaceToken, 'POST', '/v1/lanes', { project: 'alpha', builder, reviewer, name, cards })
    if (r.status !== 200) check(`lane of ${builder} starts`, false, JSON.stringify(r))
    return r.body?.lane?.id
  }
  // B1 quiet first (idle, nothing of Hive's being typed into it or waiting to be): the board set-up above sends it card
  // events, and taking them as its lane starts would make its new conversation owed (or leave it as it is, mid-turn).
  check('B1 is quiet before its lane starts', !!(await until(async () => lib.agentQuiet(PORT, 'alpha', await live(b1.id), tr), 45000)), JSON.stringify(await live(b1.id)))
  const l1 = await startLane('B1', 'R1', 'lanes and loops', lane1)
  const section = panel.locator('.progress-lanes')
  const list = section.locator('.progress-lanes-list')
  // Whole lanes in the list: how many show whole, where each starts and ends, and whether it scrolls.
  const fit = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top
      const rows = [...el.querySelectorAll('.progress-lane')].map((r) => r.getBoundingClientRect())
      const bottoms = rows.map((r) => Math.round(r.bottom - top))
      return { client: el.clientHeight, scroll: el.scrollHeight, whole: bottoms.filter((b) => b <= el.clientHeight + 1).length, bottoms, tops: rows.map((r) => Math.round(r.top - top)) }
    })
  // n lanes show whole, and the next starts right at the bottom edge (no part of it shows); or all of them, unscrolled.
  const showsWhole = (f, n) => f.whole === n && (n >= f.bottoms.length ? f.scroll <= f.client + 1 : Math.abs(f.tops[n] - f.client) <= 1 && f.scroll > f.client + 4)
  // Only as tall as the lane, its margin and the list's padding (6 px each).
  check('one lane: the section is only as tall as it is', !!(await until(async () => (await section.locator('.progress-lane').count()) === 1 && showsWhole(await fit(), 1), HUNG_MS)) && (await fit()).client <= (await fit()).bottoms[0] + 12, JSON.stringify(await fit().catch(() => null)))
  // B3 quiet too, for the same reason: its 22 cards, made above, send it card events of its own.
  check('B3 is quiet before its lane starts', !!(await until(async () => lib.agentQuiet(PORT, 'alpha', await live(b3.id), tr), 45000)), JSON.stringify(await live(b3.id)))
  const l2 = await startLane('B3', 'R1', 'a long lane', long)
  // B1 and B3, idle builders outside slots, are given their new lanes in new conversations (HI-2232), so each has a new
  // launch and token: the merge slot's claims below are their new launches'.
  const renewedNow = async (a) => launchesOf(a).length === 2 && ['ready', 'finished'].includes((await live(a.id))?.status)
  const renewal = async (a) => JSON.stringify({ launches: launchesOf(a).length, status: (await live(a.id))?.status })
  check('B1 and B3, idle outside slots, get their lanes in new conversations', !!(await until(async () => (await renewedNow(b1)) && (await renewedNow(b3)), HUNG_MS)), `${await renewal(b1)} ${await renewal(b3)}`)
  t1 = tokenOf(b1)
  t3 = tokenOf(b3)
  const l3 = await startLane('R1', null, null, short)
  const l4 = await startLane('B5', 'R1', 'merged earlier', [n1, n2])
  const l5 = await startLane('B6', null, 'given up', [n5, n8])
  // Cards merged while their lanes run (HI-2176): a lane started leaves out a card already Done (HI-2097), so #1 and
  // the long lane's first 18 go to Done only now.
  await inv('tasks:update', n1, { column: 'done' })
  for (const n of long.slice(0, 18)) await inv('tasks:update', n, { column: 'done' })
  const ended = await api(workspaceToken, 'POST', `/v1/lanes/${l4}/end`, { mergeCommit: 'abc1234' })
  const dropped = await api(workspaceToken, 'POST', `/v1/lanes/${l5}/end`, { abandoned: true })
  const l6 = await startLane('B7', 'R1', 'six of six', [await make('Seventh lane, one', 'doing')])
  const l7 = await startLane('B8', 'R1', 'one more', [await make('Eighth lane, one', 'todo')])
  check('seven lanes started, one ended and one abandoned', [l1, l2, l3, l4, l5, l6, l7].every(Boolean) && ended.body?.state === 'ended' && dropped.body?.state === 'abandoned', JSON.stringify([ended, dropped]))
  const order = () => section.locator('.progress-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))
  // Running lanes first, newest first, then the paused ones (#512) newest first: R1's (its current card blocked) and
  // B1's (one card at a time, #1270: its card in Passed isn't merged while later ones wait), then the ended and abandoned
  // ones in the order they finished, the latest last (#568).
  const wantOrder = [l7, l6, l2, l3, l1, l4, l5]
  check('the lanes show, a row each: running first (newest first), then paused, then ended and abandoned as they finished', !!(await until(async () => (await order()).join() === wantOrder.join(), HUNG_MS)), JSON.stringify({ got: await order(), want: wantOrder }))
  const row1 = section.locator(`.progress-lane[data-lane="${l1}"]`)
  const top1 = await row1.locator('.progress-lane-top').innerText()
  // #3 is back in Review while #4 is being fixed in Doing: the lane is on #4, the card being built (#512).
  // #2 passed but not merged (the rules on, one card at a time): why it waits takes the name's room (#1279), the name is
  // in its accessible name.
  const label1 = (await row1.getAttribute('aria-label')) ?? ''
  check('a lane says its pair, why it waits, the card being worked and finished/total; its name in its accessible name', /B1 \/ R1/.test(top1) && top1.includes(`waiting: ${K(n2)} not merged`) && new RegExp(`${K(n4)}\\b`).test(top1) && /2\/8/.test(top1) && /lanes and loops/.test(label1), JSON.stringify({ top1, label1 }))
  const segClass = async (n) => (await row1.locator(`.lane-seg[data-card="${n}"]`).getAttribute('class')) ?? ''
  const want = { [n1]: 'done', [n2]: 'passed', [n3]: 'review', [n4]: 'doing', [n5]: 'todo', [n6]: 'blocked', [n7]: 'blocked', [n8]: 'todo' }
  const got = {}
  for (const n of lane1) got[n] = await segClass(n)
  check('one segment per card, in order, by state', lane1.every((n) => got[n].split(' ').includes(want[n])) && (await row1.locator('.lane-seg').count()) === 8, JSON.stringify(got))
  check('a failed round is marked on its segment (and not on the card back in Review)', got[n4].includes('failed') && !got[n3].includes('failed'), JSON.stringify(got))
  const widths = await row1.locator('.lane-seg').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
  check('segments are equal widths', Math.max(...widths) - Math.min(...widths) <= 1, JSON.stringify(widths))
  // Each state its own pattern as well as colour: no two states draw the same.
  const looks = await row1.locator('.lane-seg').evaluateAll((els) => els.map((e) => { const s = getComputedStyle(e); return `${s.backgroundImage}|${s.backgroundColor}|${s.boxShadow}|${getComputedStyle(e, '::before').animationName}` }))
  const byState = {}
  lane1.forEach((n, i) => (byState[want[n]] = looks[i]))
  check('every state looks different', new Set(Object.values(byState)).size === Object.keys(byState).length, JSON.stringify(byState))
  check('doing is animated, and the others are not', /lane-stripes/.test(byState.doing) && Object.entries(byState).every(([k, v]) => k === 'doing' || !/lane-stripes/.test(v)))
  // Under reduced motion the stripes stand still (#1629: they move on the segment's ::before).
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await row1.locator(`.lane-seg[data-card="${n4}"]`).evaluate((e) => getComputedStyle(e, '::before').animationName)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  check('…and still under reduced motion', reduced === 'none', reduced)
  const row2 = section.locator(`.progress-lane[data-lane="${l2}"]`)
  check("a long lane folds its finished cards into one '✓ n'", ((await row2.locator('.lane-seg.finished').innerText().catch(() => '')) === '✓ 18') && (await row2.locator('.lane-seg[data-card]').count()) === 4)
  // A paused lane says why in the paused colour (#1279), and that it is paused in its accessible name.
  const paused3 = section.locator(`[data-lane="${l3}"]`)
  check('a paused, an ended and an abandoned lane say so', /paused/.test((await paused3.getAttribute('aria-label')) ?? '') && (await paused3.locator('.progress-lane-why.paused').count()) === 1 && /merged/.test(await section.locator(`[data-lane="${l4}"]`).innerText()) && /abandoned/.test(await section.locator(`[data-lane="${l5}"]`).innerText()))
  // Six rows show whole before it scrolls (#569; six since HI-1673); the seventh starts at the bottom edge and scrolls.
  check('six lanes show by default, then the list scrolls', showsWhole(await fit(), 6), JSON.stringify(await fit()))
  await shoot('lanes-six')
  // The section's top edge (#569): a splitter whose value is the lanes shown.
  const edge = section.locator('.progress-lanes-edge')
  const edgeSays = async () => ({ now: await edge.getAttribute('aria-valuenow'), text: await edge.getAttribute('aria-valuetext'), max: await edge.getAttribute('aria-valuemax') })
  const edgeMin = async () => Number(await edge.getAttribute('aria-valuemin'))
  check('its top edge is a focusable splitter saying how many lanes show', (await edge.getAttribute('role')) === 'separator' && (await edge.getAttribute('tabindex')) === '0' && JSON.stringify(await edgeSays()) === JSON.stringify({ now: '6', text: '6 of 7 lanes shown', max: '7' }), JSON.stringify(await edgeSays()))
  const pitch = (await fit()).tops[1] - (await fit()).tops[0]
  /** Drags the edge by dy (px), the rows it should snap to between the splitter's range (its floor: HI-1673). */
  const press = async (dy) => {
    const b = await edge.boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + dy / 2, { steps: 4 })
    await page.mouse.move(x, y + dy, { steps: 4 })
    await page.mouse.up()
    return b
  }
  const drag = async (dy, what) => {
    const was = await edgeSays()
    const rows = Math.max(await edgeMin(), Math.min(Number(was.max), Math.round(Number(was.now) - dy / pitch)))
    const b = await edge.boundingBox()
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x, y + dy / 2, { steps: 4 })
    await page.mouse.move(x, y + dy, { steps: 4 })
    await page.mouse.up()
    // Its result kept and drawn before anything reads where the edge is: a drag right after another pressed where the
    // edge had been, not yet moved by the first one's lanes, and so dragged nothing (#1235). Checked, so a drag that
    // missed fails here rather than being made good by the next one.
    const done = await until(async () => (await kept()) === rows && (await edgeSays()).now === String(rows), HUNG_MS)
    check(`the drag ${what} is kept and drawn (${rows} shown)`, !!done, JSON.stringify({ was, dy, kept: await kept(), says: await edgeSays(), box: b, now: await edge.boundingBox() }))
  }
  const kept = () => page.evaluate((w) => window.hive.invoke('ui:get').then((ui) => ui.panes?.[`progress-lanes-rows:${w.toLowerCase()}`] ?? null), ws)
  // Its floor (HI-1673, Darren): with more lanes than six, a drag never shows fewer than six.
  check('the splitter ranges from six (the floor) to the lanes there are', (await edgeMin()) === 6 && (await edgeSays()).max === '7', JSON.stringify({ min: await edgeMin(), says: await edgeSays() }))
  // Dragged up by just under one: seven, kept.
  await drag(-pitch * 0.9, 'up just under a lane')
  check('dragging the top edge up shows more lanes, whole ones', !!(await until(async () => showsWhole(await fit(), 7), HUNG_MS)) && (await edgeSays()).now === '7', JSON.stringify({ fit: await fit(), pitch }))
  check('…kept for the workspace', !!(await until(async () => (await kept()) === 7, HUNG_MS)), String(await kept()))
  // From seven, dragged down two lanes and a half: it stops at the floor, six, kept and drawn (HR5's round 1: from
  // above the floor, so the drag is seen to take effect).
  await press(pitch * 2.5)
  await page.mouse.move(5, 5)
  check('dragging the top edge down never shows fewer than six', !!(await until(async () => (await kept()) === 6 && showsWhole(await fit(), 6) && (await edgeSays()).now === '6', HUNG_MS)), JSON.stringify({ kept: await kept(), fit: await fit(), says: await edgeSays(), pitch }))
  // All the way up: no more than there are, and the runs keep their room.
  const body = () => panel.locator('.progress-body').evaluate((el) => el.getBoundingClientRect().height)
  await drag(-2000, 'all the way up')
  check('…up to all the lanes there are, with no empty space under them', !!(await until(async () => showsWhole(await fit(), 7), HUNG_MS)) && (await edgeSays()).now === '7', JSON.stringify(await fit()))
  check('…while the runs keep their room', (await body()) >= 119, String(await body()))
  await shoot('lanes-all')
  // Seven kept, then a short window zoomed in (#569 round 2): it shows the whole lanes that fit while the runs keep their
  // room, and the splitter (and the accessibility tree) says so, its maximum what fits; seven stays the choice.
  const zoomTo = (f) => app.evaluate(({ webContents }, z) => webContents.getAllWebContents().filter((w) => w.getType() === 'window').forEach((w) => w.setZoomFactor(z)), f)
  const cdp = await page.context().newCDPSession(page)
  const axEdge = async () => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const n = nodes.find((x) => x.role?.value === 'separator' && x.name?.value === 'Lanes shown')
    const prop = (k) => n?.properties?.find((p) => p.name === k)?.value?.value ?? null
    return n ? { value: n.value?.value ?? null, max: prop('valuemax'), text: prop('valuetext') } : null
  }
  const squeezed = async () => {
    const f = await fit()
    const says = await edgeSays()
    return { f, says, body: await body(), ax: await axEdge() }
  }
  // The lanes take priority (HI-1673): squeezed to the floor or below, the runs give way rather than keep their room.
  const honest = (q, n) => showsWhole(q.f, n) && q.says.now === String(n) && q.says.max === String(n) && q.says.text === `${n} of 7 lanes shown` && (n <= 6 || q.body >= 119) && !!q.ax && Number(q.ax.value) === n && Number(q.ax.max) === n
  await lib.fitWindow(app, page, { width: 1400, height: 600 })
  await zoomTo(1.5)
  let tight = null
  const settles = await until(async () => {
    const q = await squeezed()
    tight = q
    return q.f.whole > 0 && q.f.whole < 7 && honest(q, q.f.whole)
  }, HUNG_MS)
  check('kept seven, squeezed: whole lanes that fit, the runs giving way first, and the splitter says what shows and the most that fit', !!settles && (await kept()) === 7, JSON.stringify({ tight, kept: await kept() }))
  const fits = tight?.f.whole ?? 0
  await shoot('lanes-squeezed')
  await edge.focus()
  await page.keyboard.press('ArrowUp')
  check('…Up there sets the choice to what fits, which shows already', !!(await until(async () => (await kept()) === fits, HUNG_MS)) && honest(await squeezed(), fits), JSON.stringify({ kept: await kept(), q: await squeezed() }))
  await zoomTo(1)
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  // Measured again: room for all seven.
  await until(async () => (await edgeSays()).max === '7', HUNG_MS)
  await page.keyboard.press('End')
  check('…End with room again: all seven', !!(await until(async () => showsWhole(await fit(), 7) && (await kept()) === 7, HUNG_MS)), JSON.stringify({ kept: await kept(), f: await fit() }))
  await lib.fitWindow(app, page, { width: 1400, height: 600 })
  await zoomTo(1.5)
  check('…squeezed again, still honest', !!(await until(async () => honest(await squeezed(), fits), HUNG_MS)), JSON.stringify(await squeezed()))
  await page.keyboard.press('End')
  check('…and End there keeps the most that fit', !!(await until(async () => (await kept()) === fits, HUNG_MS)) && honest(await squeezed(), fits), JSON.stringify({ kept: await kept(), q: await squeezed() }))
  await zoomTo(1)
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await cdp.detach().catch(() => undefined)
  // A shorter window: dragged to the top, the edge stops where the runs keep their room, at a whole lane.
  await lib.fitWindow(app, page, { width: 1400, height: 600 })
  await until(async () => (await page.evaluate(() => window.innerHeight)) === 600, HUNG_MS)
  // Measured for the short window before the edge is dragged, and the drag's result waited for, not read once (#601).
  await until(async () => Number((await edgeSays()).max) < 7, HUNG_MS)
  // What the edge said and where it was around each drag, for a failure's detail.
  const trace = []
  const snap = async (at) => trace.push({ at, says: await edgeSays(), kept: await kept(), box: await edge.boundingBox(), f: await fit(), body: await body() })
  await snap('before')
  // Its range there: the floor and the most that fit (HI-1673); a drag stays within it.
  await press(pitch)
  await page.mouse.move(5, 5)
  await snap('after down')
  await press(-2000)
  await page.mouse.move(5, 5)
  await snap('after up')
  let shortFit = null
  const shortOk = await until(async () => {
    shortFit = { f: await fit(), body: await body() }
    // Six (the floor) whole, the runs giving way to them if they must (HI-1673), never more than fit.
    return shortFit.f.whole === 6 && showsWhole(shortFit.f, 6)
  }, HUNG_MS)
  check('in a short window, dragged either way, the floor shows whole and the list ends at a whole lane', !!shortOk, JSON.stringify({ shortFit, says: await edgeSays(), trace }))
  await lib.fitWindow(app, page, { width: 1400, height: 850 })
  await until(async () => (await page.evaluate(() => window.innerHeight)) === 850, HUNG_MS)
  // Double-click: back to six, and nothing kept.
  await edge.dblclick()
  check('double-clicking the top edge goes back to six', !!(await until(async () => showsWhole(await fit(), 6) && (await kept()) === null, HUNG_MS)), JSON.stringify({ fit: await fit(), kept: await kept() }))
  // Keyboard: Up a lane more, Down one fewer, never below the floor, saying so.
  await edge.focus()
  await page.keyboard.press('ArrowUp')
  check('focused, Up shows a lane more and says so', !!(await until(async () => showsWhole(await fit(), 7) && (await kept()) === 7, HUNG_MS)) && (await edgeSays()).text === '7 of 7 lanes shown', JSON.stringify(await edgeSays()))
  await shoot('lanes-edge-focused')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  check('…Down, fewer, but never below six', !!(await until(async () => showsWhole(await fit(), 6) && (await kept()) === 6, HUNG_MS)) && (await edgeSays()).text === '6 of 7 lanes shown', JSON.stringify(await edgeSays()))
  // Ended and abandoned lanes are still: nothing in them animates, and they show no current card.
  const still = await section.locator(`[data-lane="${l4}"] .lane-seg, [data-lane="${l5}"] .lane-seg`).evaluateAll((els) => els.map((e) => getComputedStyle(e, '::before').animationName))
  check('ended and abandoned lanes never animate, and name no current card', still.length === 4 && still.every((a) => a === 'none') && (await section.locator(`[data-lane="${l4}"] .progress-lane-current, [data-lane="${l5}"] .progress-lane-current`).count()) === 0, JSON.stringify(still))
  const panelBox = await panel.boundingBox()
  const sectionBox = await section.boundingBox()
  const runsBox = await panel.locator('.progress-tab-pulse > .progress-body').boundingBox()
  check('the lanes sit at the bottom of the panel, the runs right above them (HI-1673, as #484 had them)', Math.abs(sectionBox.y - (runsBox.y + runsBox.height)) <= 2 && Math.abs(sectionBox.y + sectionBox.height - (panelBox.y + panelBox.height)) <= 2, JSON.stringify({ panelBox, runsBox, sectionBox }))
  // Hover: the card and its round.
  await row1.locator(`.lane-seg[data-card="${n3}"]`).hover()
  const tip = page.locator('.tip', { hasText: `${K(n3)} Panel layout` })
  check('hovering a segment shows the card and its round', !!(await until(async () => (await tip.count()) === 1, HUNG_MS)) && /Review, round 2/.test(await tip.innerText()), await page.locator('.tip').allInnerTexts().then((t) => t.join(' | ')))
  await row1.locator(`.lane-seg[data-card="${n4}"]`).hover()
  check("…and a failed one's", !!(await until(async () => /round 1 failed review/.test((await page.locator('.tip').allInnerTexts()).join(' ')), HUNG_MS)))
  await shoot('lanes')
  // What the marks mean (#706): the red underline's failed round and the reviewer's gist, the hatching's reason, in the
  // hover and in the segment's accessible name. A screenshot of each hover in both themes.
  const marks = [
    [n4, 'failed', [`${K(n4)}: review failed (round 1): waiting for round 2`, 'Reviewer: Round 1: FAILED: 1 finding: the hover clips']],
    [n6, 'blocked', [`${K(n6)}: blocked: Waiting for a design decision`]],
    [n7, 'hold', [`${K(n7)}: On Hold: waiting for you to move it on`]]
  ]
  for (const [n, what, lines] of marks) {
    const seg = row1.locator(`.lane-seg[data-card="${n}"]`)
    const tipOf = page.locator('.tip', { hasText: `${K(n)} ` })
    const notes = async () => tipOf.locator('.lane-seg-note').allInnerTexts().catch(() => [])
    await page.mouse.move(0, 0)
    await seg.hover()
    check(`hovering the ${what} segment says what its mark means, a line each`, !!(await until(async () => JSON.stringify(await notes()) === JSON.stringify(lines), HUNG_MS)), JSON.stringify(await notes()))
    const name = (await seg.getAttribute('aria-label')) ?? ''
    check(`…and its accessible name says it too`, lines.every((l) => name.includes(l)), name)
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      // The theme's repaint can drop the hover: hover again until the tooltip is back with its notes.
      const shown = await until(async () => {
        if ((await notes()).length === lines.length) return true
        await seg.hover()
        return false
      }, HUNG_MS)
      check(`${theme}: the ${what} hover shows for its screenshot`, !!shown)
      await page.screenshot({ path: path.join(shots, `hover-${what}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  // What the cards' facts say (#1225), from the moves above: the revision under review and the last verdict on its
  // revision, a passed card's verdict, and a Done card's merge commit (the ended lane's own record: no merge fact).
  const head7 = String(lib.git(alpha, ['rev-parse', 'HEAD'])).trim().slice(0, 7)
  const workLines = async (row, n) => page.locator('.tip', { hasText: `${K(n)} ` }).locator('.lane-seg-work').allInnerTexts().catch(() => [])
  const work = [
    [row1, n3, 'review', (l) => l.includes(`Under review: ${head7}`) && l.some((x) => x.startsWith(`Last verdict: failed on ${head7}`))],
    [row1, n2, 'passed', (l) => l.some((x) => x.startsWith(`Last verdict: passed on ${head7}`))],
    [section.locator(`.progress-lane[data-lane="${l4}"]`), n1, 'merged', (l) => l.includes('Merged as abc1234')]
  ]
  for (const [row, n, what, ok] of work) {
    const seg = row.locator(`.lane-seg[data-card="${n}"]`)
    await page.mouse.move(0, 0)
    await seg.hover()
    check(`hovering the ${what} segment says what its facts say`, !!(await until(async () => ok(await workLines(row, n)), HUNG_MS)), JSON.stringify(await workLines(row, n)))
    if (what === 'merged') continue
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
      const shown = await until(async () => {
        if (ok(await workLines(row, n))) return true
        await seg.hover()
        return false
      }, HUNG_MS)
      check(`${theme}: the ${what} hover with its facts shows for its screenshot`, !!shown)
      await page.screenshot({ path: path.join(shots, `hover-work-${what}-${theme}.png`) })
    }
    await inv('settings:update', { appearance: { theme: 'dark' } })
  }
  await page.mouse.move(0, 0)
  // A click opens the card.
  await row1.locator(`.lane-seg[data-card="${n6}"]`).click()
  const dialog = page.locator('.dialog[role="dialog"]').first()
  check('a click on a segment opens its card', !!(await until(async () => (await dialog.locator('.task-title-input').inputValue().catch(() => '')) === 'Lane hover', 5000)))
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, HUNG_MS)
  // Folded to its bar, still right after the runs; and back.
  await section.locator('.progress-lanes-bar').click()
  const foldedBox = await section.boundingBox()
  const runsNow = await panel.locator('.progress-tab-pulse > .progress-body').boundingBox()
  check('the lanes fold to their bar, after the runs', (await list.count()) === 0 && foldedBox.height < 40 && Math.abs(foldedBox.y - (runsNow.y + runsNow.height)) <= 2, JSON.stringify({ foldedBox, runsNow }))
  await section.locator('.progress-lanes-bar').click()
  check('…and open again', !!(await until(async () => (await list.count()) === 1, HUNG_MS)))
  check('…with the lanes chosen', !!(await until(async () => showsWhole(await fit(), 6), HUNG_MS)), JSON.stringify(await fit()))

  // --- Merging: B1 holds the slot, running its full test set; B3 waits.
  const run = await api(t1, 'POST', '/v1/progress', { title: 'Full test set', total: 146, step: 112, stepName: 'mergeslot', estimateMs: 600000 })
  const claim = await api(t1, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [n8], timeoutSeconds: 0 })
  const wait = await api(t3, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [long[18]], timeoutSeconds: 0 })
  // B3's token works while its launch runs; a 401 here means it ended (#601): say whether it still runs, and its launches.
  const b3Now = async () => {
    const now = await live(b3.id)
    return { status: now?.status ?? 'not running', runId: now?.runId ?? null, launches: launchesOf(b3).length }
  }
  check('B1 holds the slot and B3 waits', run.status === 200 && claim.body?.held === true && wait.body?.held === false, JSON.stringify([run, claim, wait, ...(wait.status === 401 ? [{ b3: await b3Now() }] : [])]))
  const mergeCard = panel.locator('.progress-merge-card')
  check('a merge card shows on top', !!(await until(async () => (await mergeCard.count()) === 1, HUNG_MS)))
  const branch = b1.worktree?.branch
  const text = await mergeCard.innerText()
  check('it says who merges which cards, branch → main, the current step, time and who waits', new RegExp(`B1 is merging ${K(n8)}`).test(text) && text.includes(`${branch} → main`) && /Full test set · 113 of 146: mergeslot/.test(text) && /so far · \d+ min left/.test(text) && /Waiting: B3/.test(text), `${branch} | ${text}`)
  check('with a divider under it', (await panel.locator('.progress-divider').count()) === 1)
  const colours = await page.evaluate(() => {
    const card = getComputedStyle(document.querySelector('.progress-merge-card')).borderTopColor
    const probe = document.createElement('div')
    document.body.append(probe)
    const of = (v) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color)
    const palette = ['--success', '--warning', '--error', '--info', '--accent', '--signin'].map(of)
    probe.remove()
    return { card, statuses: palette }
  })
  check('in its own colour, no status colour', !colours.statuses.includes(colours.card), JSON.stringify(colours))
  const mergeBox = await mergeCard.boundingBox()
  const firstRun = await panel.locator('.progress-run').first().boundingBox()
  check('above the runs', !!firstRun && mergeBox.y + mergeBox.height < firstRun.y, JSON.stringify({ mergeBox, firstRun }))
  await shoot('merging')
  await mergeCard.getByRole('button', { name: 'Fold the merge to one line' }).click()
  const short1 = await mergeCard.innerText()
  check('the merge card folds to one line', !!(await until(async () => (await mergeCard.locator('.progress-merge-branch').count()) === 0, HUNG_MS)) && /B1 is merging/.test(short1), short1)
  await mergeCard.getByRole('button', { name: 'Show the merge in full' }).click()
  check('…and opens again', !!(await until(async () => (await mergeCard.locator('.progress-merge-branch').count()) === 1, HUNG_MS)))

  // --- A short window, zoomed in (1000×650 at 150%): the lanes take priority (HI-1673, Darren): they stay inside the
  // panel at its bottom, whole lanes, and the runs give way above them. Both themes.
  await lib.fitWindow(app, page, { width: 1000, height: 650 })
  const zoom = (f) => app.evaluate(({ webContents }, z) => webContents.getAllWebContents().filter((w) => w.getType() === 'window').forEach((w) => w.setZoomFactor(z)), f)
  await zoom(1.5)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await lib.sleep(400)
    const box = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON() ?? null
      return { panel: r('.progress-panel'), lanes: r('.progress-lanes'), body: r('.progress-body'), run: r('.progress-run'), merge: r('.progress-merge'), bar: r('.progress-lanes-bar') }
    })
    const inside = box.lanes && box.panel && box.lanes.bottom <= box.panel.bottom + 1 && box.lanes.top >= box.panel.top && Math.abs(box.lanes.bottom - box.panel.bottom) <= 2
    check(`${theme}, short and zoomed: the lanes stay inside the panel, at its bottom, with their bar`, !!inside && !!box.bar && box.bar.height > 20, JSON.stringify(box))
    const runsAbove = box.body && box.body.bottom <= box.lanes.top + 1
    check(`${theme}, short and zoomed: the runs give way above the lanes`, !!runsAbove, JSON.stringify(box))
    const whole = await list.evaluate((el) => { const r = el.getBoundingClientRect(); return [...el.querySelectorAll('.progress-lane')].filter((x) => { const b = x.getBoundingClientRect(); return b.top >= r.top - 1 && b.bottom <= r.bottom + 1 }).length })
    check(`${theme}, short and zoomed: …and the lanes show whole`, whole >= 1, String(whole))
    await page.screenshot({ path: path.join(shots, `small-zoom-${theme}.png`) })
  }
  await zoom(1)
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await lib.fitWindow(app, page, { width: 1400, height: 850 })

  // Released: B3's turn, not taken yet, is no merge: no card. Once it claims, its card; released, none.
  await api(t1, 'POST', '/v1/projects/alpha/merge-slot/release', { branch: 'main' })
  const turn = await until(async () => (await inv('mergeSlots:list')).find((s) => s.holder?.name === 'B3' && !s.holder.taken), 5000)
  check("released, B3's turn (not taken yet) shows no card or divider", !!turn && !!(await until(async () => (await panel.locator('.progress-merge, .progress-divider').count()) === 0, HUNG_MS)), JSON.stringify(await inv('mergeSlots:list')))
  const again = await api(t3, 'POST', '/v1/projects/alpha/merge-slot/claim', { branch: 'main', cards: [long[18]], timeoutSeconds: 0 })
  check('once B3 claims it, its card shows', again.body?.held === true && !!(await until(async () => new RegExp(`B3 is merging ${K(long[18])}`).test(await mergeCard.innerText().catch(() => '')), HUNG_MS)))
  await api(t3, 'POST', '/v1/projects/alpha/merge-slot/release', { branch: 'main' })
  check('free: the merge card and divider go', !!(await until(async () => (await panel.locator('.progress-merge, .progress-divider').count()) === 0, HUNG_MS)))

  // --- A card moving on the board moves its segment.
  await inv('tasks:update', n5, { column: 'doing' })
  check("a card moved on the board changes its lane's segment", !!(await until(async () => /\bdoing\b/.test((await row1.locator(`.lane-seg[data-card="${n5}"]`).getAttribute('class')) ?? ''), HUNG_MS)))
  // …but not the abandoned lane's (#512): B6's lane had #5 in Todo when it was given up, and B1's lane works it now.
  const row5 = section.locator(`.progress-lane[data-lane="${l5}"]`)
  const seg5 = (await row5.locator(`.lane-seg[data-card="${n5}"]`).getAttribute('class')) ?? ''
  check('the abandoned lane keeps the card as it left it, unanimated, while another lane works it', /\btodo\b/.test(seg5) && !/\bdoing\b/.test(seg5) && (await row5.locator(`.lane-seg[data-card="${n5}"]`).evaluate((e) => getComputedStyle(e, '::before').animationName)) === 'none', seg5)
  await row5.locator(`.lane-seg[data-card="${n5}"]`).hover()
  check("…and its hover says it's as the lane left it", !!(await until(async () => /when the lane ended/.test((await page.locator('.tip').allInnerTexts()).join(' ')), HUNG_MS)))
  // R1's lane was paused on its blocked card; its builder moves on to the next one: working, not paused, on that card.
  const row3 = section.locator(`.progress-lane[data-lane="${l3}"]`)
  await inv('tasks:update', short[1], { column: 'doing' })
  check('a builder that moves on past a blocked card: the lane is running, on the card being worked', !!(await until(async () => { const t = await row3.locator('.progress-lane-top').innerText(); return !/paused/.test(t) && new RegExp(`${K(short[1])}\\b`).test(t) }, HUNG_MS)), await row3.locator('.progress-lane-top').innerText())
  check('…its blocked card still flagged in its segment', /\bblocked\b/.test((await row3.locator(`.lane-seg[data-card="${short[0]}"]`).getAttribute('class')) ?? ''))
  // Running again, it sorts with the running lanes, newest first (it was started after B1's and B3's).
  check('…and moves up among the running lanes', !!(await until(async () => (await order()).join() === [l7, l6, l3, l2, l1, l4, l5].join(), HUNG_MS)), JSON.stringify(await order()))
  // A lane ended without a record of its cards (ended before #512 kept one, or the record damaged): B5's merged lane,
  // its record taken out of what is saved (#1018, #1212: the workspace's database). Its card #2 moving on in B1's lane shows there
  // only; B5's says not recorded.
  const { storeDocs, forgetLaneCards } = require('./storeDocs.cjs')
  const old = storeDocs(ws, 'lanes').find((x) => x.id === l4)
  check("an ended lane's cards are kept with it", Array.isArray(old?.frozen) && old.frozen.map((c) => c.column).join() === 'done,passed', JSON.stringify(old?.frozen))
  forgetLaneCards(ws, l4)
  await inv('tasks:update', n2, { column: 'review' })
  const row4 = section.locator(`.progress-lane[data-lane="${l4}"]`)
  const seg4 = async () => (await row4.locator(`.lane-seg[data-card="${n2}"]`).getAttribute('class')) ?? ''
  // Both rows waited for: B1's shows the move once lanes-changed reaches it, which may come after B5's (#1270 round 3).
  const seg1 = async () => (await row1.locator(`.lane-seg[data-card="${n2}"]`).getAttribute('class')) ?? ''
  check("without that record, the merged lane says its cards weren't recorded, not where the board has them now", !!(await until(async () => /\bunrecorded\b/.test(await seg4()) && /\breview\b/.test(await seg1()), HUNG_MS)) && !/\breview\b/.test(await seg4()), JSON.stringify([await seg4(), await seg1()]))
  check('…its count unknown, and no current card', /–\/2/.test(await row4.locator('.progress-lane-top').innerText()) && (await row4.locator('.progress-lane-current').count()) === 0, await row4.locator('.progress-lane-top').innerText())
  await row4.locator(`.lane-seg[data-card="${n2}"]`).hover()
  check('…and its hover says so', !!(await until(async () => /not recorded: the lane ended before Combwork kept where its cards were/.test((await page.locator('.tip').allInnerTexts()).join(' ')), HUNG_MS)))
  await page.mouse.move(5, 5)
  await until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await shoot('lanes-moved-on')

  // --- The user's order (#568). Running: l7, l6, l3, l2, l1 (five show); then l4 and l5, finished.
  const rowOf = (id) => section.locator(`.progress-lane[data-lane="${id}"]`)
  const savedOrder = () => page.evaluate((w) => window.hive.invoke('ui:get').then((ui) => ui.laneOrder?.[w.toLowerCase()] ?? null), ws)
  const said = () => section.locator('.progress-lanes-said').innerText()
  const ordered = async (ids) => !!(await until(async () => (await order()).join() === ids.join(), HUNG_MS))
  const scrollTop = () => list.evaluate((el) => el.scrollTop)
  check('running lanes can be dragged and focused; finished ones neither', (await rowOf(l7).getAttribute('draggable')) === 'true' && (await rowOf(l7).getAttribute('tabindex')) === '0' && (await rowOf(l4).getAttribute('draggable')) === null && (await rowOf(l4).getAttribute('tabindex')) === null)
  check('…and nothing is kept until one is moved', (await savedOrder()) === null, JSON.stringify(await savedOrder()))
  const lineOn = async (id) => {
    const c = (await rowOf(id).getAttribute('class')) ?? ''
    return /\bdrop-before\b/.test(c) ? 'before' : /\bdrop-after\b/.test(c) ? 'after' : null
  }
  const lines = () => section.locator('.progress-lane.drop-before, .progress-lane.drop-after').count()
  // Picks a lane up by its top line, and waits until the panel has it as dragged.
  let held = null
  const pick = async (id) => {
    await page.mouse.move(0, 0)
    const s = await rowOf(id).locator('.progress-lane-top').boundingBox()
    await page.mouse.move(s.x + 30, s.y + s.height / 2)
    await page.mouse.down()
    let k = 0
    // Playwright sends few dragovers: a small move each poll until the drag has started and the row says so.
    return until(async () => {
      await page.mouse.move(s.x + 34 + (k++ % 2), s.y + s.height / 2 + 4)
      return /\bdragging\b/.test((await rowOf(id).getAttribute('class')) ?? '')
    }, HUNG_MS)
  }
  // Moves the dragged lane to (x, y), nudging a pixel each poll until `ok` holds (Playwright sends a dragover only on a move).
  const holdAt = async (x, y, ok) => {
    await page.mouse.move(x, y, { steps: 6 })
    let k = 0
    const seen = await until(async () => {
      held = { x: x + (k++ % 2), y }
      await page.mouse.move(held.x, held.y)
      return ok()
    }, HUNG_MS)
    return !!seen
  }
  // Over a lane's top (0.3) or bottom (0.7) half.
  const over = async (id, half) => {
    const t = await rowOf(id).boundingBox()
    return { x: t.x + 60, y: t.y + t.height * (half === 'top' ? 0.3 : 0.7) }
  }
  // Lets go where it is held: Playwright drops only on a release that straight follows a move.
  const release = async () => {
    await page.mouse.move(held.x, held.y)
    await page.mouse.up()
  }
  // All seven lanes shown for the drags (the edge, End), so the list doesn't scroll under them; six again after.
  await edge.focus()
  await page.keyboard.press('End')
  await until(async () => showsWhole(await fit(), 7), HUNG_MS)
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    // Dark: l1 (the last running lane) above l7, the first; light: l7, now second, after l2, the last running lane.
    const [from, to, half, line] = theme === 'dark' ? [l1, l7, 'top', 'before'] : [l7, l2, 'bottom', 'after']
    const picked = await pick(from)
    const p = await over(to, half)
    const shows = picked && (await holdAt(p.x, p.y, async () => (await lineOn(to)) === line))
    check(`${theme}: a dragged lane is dimmed, and a line shows where it goes`, !!shows && (await lines()) === 1, JSON.stringify({ picked, line: await lineOn(to), cls: await rowOf(from).getAttribute('class') }))
    await page.screenshot({ path: path.join(shots, `lanes-drag-${theme}.png`) })
    await release()
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  let mine = [l1, l6, l3, l2, l7]
  check('dropped, the lanes take the order, the finished ones still last', await ordered([...mine, l4, l5]), JSON.stringify(await order()))
  check('…kept for the workspace', !!(await until(async () => (await savedOrder())?.join() === mine.join(), HUNG_MS)), JSON.stringify(await savedOrder()))
  // Held where it would stay (l6 over l3's top half: it is just above it), or over a finished lane: no line.
  await pick(l6)
  const stay = await over(l3, 'top')
  const fin = await over(l4, 'top')
  // Over a running lane that moves it first, so the line is known to show, then where it wouldn't.
  const moves = await over(l1, 'top')
  const before = await holdAt(moves.x, moves.y, async () => (await lineOn(l1)) === 'before')
  const none1 = await holdAt(stay.x, stay.y, async () => (await lines()) === 0)
  const none2 = before && (await holdAt(moves.x, moves.y, async () => (await lineOn(l1)) === 'before')) && (await holdAt(fin.x, fin.y, async () => (await lines()) === 0))
  check('…no line where it would stay, nor over a finished lane', before && none1 && !!none2, JSON.stringify({ before, none1, none2 }))
  await release()
  check('…and dropped there, nothing moves', await ordered([...mine, l4, l5]), JSON.stringify(await order()))
  await edge.focus()
  await page.keyboard.press('ArrowDown')
  check('(six lanes shown again)', !!(await until(async () => showsWhole(await fit(), 6) && (await kept()) === 6, HUNG_MS)), JSON.stringify(await fit()))
  // The list scrolled to its end (l3 at the top of what shows): a drag in the middle of it lands where it was dropped.
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await until(async () => (await scrollTop()) > 0, HUNG_MS)
  const scrolled = await scrollTop()
  await pick(l7)
  const onL2 = await over(l2, 'top')
  await holdAt(onL2.x, onL2.y, async () => (await lineOn(l2)) === 'before')
  await release()
  mine = [l1, l6, l3, l7, l2]
  check('with the list scrolled, a drag lands where it was dropped', (await ordered([...mine, l4, l5])) && scrolled > 0, JSON.stringify({ order: await order(), scrolled }))
  // Held at the list's top edge, it scrolls up by itself (the pointer still), to drop on a lane out of view: l2 above l1.
  await until(async () => (await scrollTop()) > 0, HUNG_MS)
  await pick(l2)
  const lb = await list.boundingBox()
  await page.mouse.move(lb.x + 60, lb.y + 4, { steps: 6 })
  held = { x: lb.x + 60, y: lb.y + 4 }
  check('dragged to the top edge, the list scrolls up while held there', !!(await until(async () => (await scrollTop()) === 0, HUNG_MS)), String(await scrollTop()))
  const onL1 = await over(l1, 'top')
  check('…and a line shows on the lane it scrolled to', await holdAt(onL1.x, onL1.y, async () => (await lineOn(l1)) === 'before'))
  await release()
  mine = [l2, l1, l6, l3, l7]
  check('…where the lane drops', await ordered([...mine, l4, l5]), JSON.stringify(await order()))
  // Keyboard: Tabbed to (from the top edge, past the Lanes bar, to the first lane), Alt+Down and Alt+Up move it a place,
  // it keeps the focus, and screen readers are told.
  const focusedLane = () => page.evaluate(() => document.activeElement?.getAttribute('data-lane') ?? null)
  await edge.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  check('Tab reaches the first lane', !!(await until(async () => (await focusedLane()) === l2, HUNG_MS)), String(await focusedLane()))
  await page.keyboard.press('Alt+ArrowDown')
  mine = [l1, l2, l6, l3, l7]
  check('Alt+Down moves the focused lane down a place, and it keeps the focus', (await ordered([...mine, l4, l5])) && (await focusedLane()) === l2, JSON.stringify({ order: await order(), focus: await focusedLane() }))
  check('…said to screen readers', (await section.locator('.progress-lanes-said').getAttribute('role')) === 'status' && !!(await until(async () => /B3 \/ R1 \(a long lane\) moved: 2 of 5 running lanes/.test(await said()), HUNG_MS)), await said())
  await page.mouse.move(5, 5)
  await shoot('lanes-focused')
  await page.keyboard.press('Alt+ArrowUp')
  mine = [l2, l1, l6, l3, l7]
  check('Alt+Up moves it up', (await ordered([...mine, l4, l5])) && (await focusedLane()) === l2, JSON.stringify(await order()))
  await page.keyboard.press('Alt+ArrowUp')
  check('…not past the first running lane, and says so', !!(await until(async () => /already the first running lane/.test(await said()), HUNG_MS)) && (await order()).join() === [...mine, l4, l5].join(), await said())
  check('…kept', !!(await until(async () => (await savedOrder())?.join() === mine.join(), HUNG_MS)), JSON.stringify(await savedOrder()))
  // The context menu: Move Up and Move Down (with their keys), and the usual order.
  await rowOf(l3).locator('.progress-lane-top').click({ button: 'right' })
  const menuItem = (label) => page.locator('.menu[role="menu"] .menu-item', { hasText: label })
  check('a running lane has a context menu to move it', !!(await until(async () => (await menuItem('Move Up').count()) === 1, HUNG_MS)) && (await menuItem('Move Down').count()) === 1 && (await menuItem('Usual Order').count()) === 1)
  await shoot('lanes-menu')
  await menuItem('Move Up').click()
  mine = [l2, l1, l3, l6, l7]
  check('…Move Up moves it', await ordered([...mine, l4, l5]), JSON.stringify(await order()))
  // A new lane arrives on top; the moved ones keep their order below it.
  // B9's: an agent of its own (a builder's new lane hides its ended one).
  await lib.addAgent(inv, alpha, { name: 'B9' })
  const l8 = await startLane('B9', null, 'arrives on top', [await make('Ninth lane, one', 'doing', b1.id)])
  check('a lane started since arrives on top, the order below it kept', await ordered([l8, ...mine, l4, l5]), JSON.stringify(await order()))
  // A lane that finishes drops to the very bottom, after those that finished before it.
  const endL6 = await api(workspaceToken, 'POST', `/v1/lanes/${l6}/end`, { abandoned: true })
  mine = [l8, l2, l1, l3, l7]
  check('a lane that finishes drops to the very bottom, the latest finish last', endL6.status === 200 && (await ordered([...mine, l4, l5, l6])), JSON.stringify({ endL6: endL6.status, order: await order() }))
  check('…and a finished lane can no longer be moved', (await rowOf(l6).getAttribute('draggable')) === null)
  await list.evaluate((el) => (el.scrollTop = 0))
  await page.mouse.move(5, 5)
  await shoot('lanes-reordered')

  // --- Hive restarted: the workspace's lanes chosen (five) are kept (#569).
  await app.close().catch(() => undefined)
  // The lanes' agents were in running lanes: Hive offers to resume them (its restart record), in a notice that can cover
  // the lane menu (HI-1809: Usual Order's click timed out under it). Answered Don't Resume, below, until the record is
  // gone (nothing left to offer) and no offer shows.
  const restartRecord = path.join(userData, 'restart.json')
  const offered = fs.existsSync(restartRecord)
  console.log(`INFO restart record before the restart: ${offered ? 'yes' : 'no'}`)
  const app2 = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page2 = await app2.firstWindow()
  page2.on('pageerror', (e) => check('no page errors after the restart', false, e.message))
  await lib.fitWindow(app2, page2, { width: 1400, height: 850 })
  await lib.appReady(page2)
  const inv2 = (ch, ...a) => page2.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  if (!(await page2.evaluate((n) => document.title.includes(n), path.basename(ws)))) await lib.openWorkspace(inv2, page2, ws)
  if (offered) {
    const dontResume = page2.locator('.toast').getByRole('button', { name: "Don't Resume", exact: true })
    const answered = await until(async () => {
      if (await dontResume.count()) await dontResume.first().click().catch(() => undefined)
      return !fs.existsSync(restartRecord) && (await dontResume.count()) === 0
    }, 30000)
    // Its outcome then shows for the usual time, counted only while the window is focused (Popups.tsx), and a test
    // window never is: closed with its × as the user would (HI-2370).
    const outcome = page2.locator('.toast.resolved .popup-close')
    const closed = await until(async () => {
      if (await outcome.count()) await outcome.first().click().catch(() => undefined)
      return (await outcome.count()) === 0
    }, 10000)
    check("the offer to resume the lanes' agents answered Don't Resume, and gone", !!answered && !!closed, String(fs.existsSync(restartRecord)))
  }
  if (!(await until(async () => (await page2.locator('.progress-panel').count()) === 1, 5000))) await page2.locator('.progress-rail').click()
  const edge2 = page2.locator('.progress-lanes-edge')
  const rowsAfter = async () => {
    const now = await edge2.getAttribute('aria-valuenow').catch(() => null)
    const f = await page2.locator('.progress-lanes-list').evaluate((el) => ({ client: el.clientHeight, seventhTop: [...el.querySelectorAll('.progress-lane')][6]?.getBoundingClientRect().top - el.getBoundingClientRect().top })).catch(() => null)
    return { now, f }
  }
  check('after a restart, the lanes chosen are kept', !!(await until(async () => { const r = await rowsAfter(); return r.now === '6' && !!r.f && Math.abs(r.f.seventhTop - r.f.client) <= 1 }, 20000)), JSON.stringify(await rowsAfter()))
  const order2 = () => page2.locator('.progress-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')))
  check("…and the user's order of lanes (#568)", !!(await until(async () => (await order2()).join() === [...mine, l4, l5, l6].join(), HUNG_MS)), JSON.stringify(await order2()))
  // The usual order again, from a lane's context menu: running ones newest first; nothing kept.
  await page2.locator(`.progress-lane[data-lane="${l3}"] .progress-lane-top`).click({ button: 'right' })
  await page2.locator('.menu[role="menu"] .menu-item', { hasText: 'Usual Order' }).click()
  const usualOrder = [l8, l7, l3, l2, l1, l4, l5, l6]
  const saved2 = () => page2.evaluate((w) => window.hive.invoke('ui:get').then((ui) => ui.laneOrder?.[w.toLowerCase()] ?? null), ws)
  check('Usual Order puts the lanes back, and keeps no order', !!(await until(async () => (await order2()).join() === usualOrder.join() && (await saved2()) === null, HUNG_MS)), JSON.stringify({ order: await order2(), saved: await saved2() }))

  // --- A lane's queued list change in the Lanes tab (HI-2151): B10's lane, its first card in flight, changed to add a
  // card and reorder the rest, so Hive queues it behind that card. The tab says what it will do under the lane's bar;
  // once that card is Done the change applies and the line goes.
  const panel2 = page2.locator('.progress-panel')
  const b10 = await lib.addAgent(inv2, alpha, { name: 'B10' })
  const make2 = async (title, column) => {
    const c = await inv2('tasks:create', { title, project: 'alpha', column, agent: b10?.id })
    keyOf.set(c.number, c.key)
    return c.number
  }
  const [q1, q2, q3] = [await make2('Queued one', 'doing'), await make2('Queued two', 'todo'), await make2('Queued three', 'todo')]
  const l9 = await startLane('B10', 'R1', 'queued change', [q1, q2, q3])
  const q4 = await make2('Queued four', 'todo')
  const change = await api(workspaceToken, 'POST', '/v1/lanes', { project: 'alpha', builder: 'B10', reviewer: 'R1', cards: [q1, q4, q3, q2] })
  const laneNow = async () => (await inv2('lanes:list')).find((l) => l.id === l9)
  check('a list change to a lane with its card in flight is queued', change.status === 200 && !!(await until(async () => (await laneNow())?.queued?.join() === [q1, q4, q3, q2].join(), HUNG_MS)), JSON.stringify({ change, lane: await laneNow() }))
  await panel2.locator('.progress-tab[data-tab="lanes"]').click()
  const queuedLine = panel2.locator(`.progress-tab-lanes .progress-lane[data-lane="${l9}"] .progress-lane-queued`)
  const wantLine = `Next, once ${K(q1)} is Done: ${K(q4)} added, new order: ${K(q1)}, ${K(q4)}, ${K(q3)}, ${K(q2)}`
  check('the Lanes tab shows the queued change under the lane', !!(await until(async () => ((await queuedLine.count()) === 1 ? (await queuedLine.innerText()).trim() : '') === wantLine, HUNG_MS)), JSON.stringify({ got: await queuedLine.innerText().catch(() => null), want: wantLine }))
  check('…its whole text in its title', (await queuedLine.getAttribute('title')) === wantLine)
  check('…and no other lane shows one', (await panel2.locator('.progress-lane-queued').count()) === 1)
  await queuedLine.scrollIntoViewIfNeeded()
  for (const theme of ['dark', 'light']) {
    await inv2('settings:update', { appearance: { theme } })
    await until(async () => (await page2.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await lib.sleep(250)
    await page2.screenshot({ path: path.join(shots, `lanes-queued-${theme}.png`) })
  }
  await inv2('settings:update', { appearance: { theme: 'dark' } })
  await inv2('tasks:update', q1, { column: 'done' })
  check('once its card is Done, the change applies', !!(await until(async () => { const l = await laneNow(); return !!l && l.queued === null && l.cards.map((c) => c.number).join() === [q1, q4, q3, q2].join() }, HUNG_MS)), JSON.stringify(await laneNow()))
  check('…and the line goes', !!(await until(async () => (await queuedLine.count()) === 0, HUNG_MS)))
  await app2.close().catch(() => undefined)
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
