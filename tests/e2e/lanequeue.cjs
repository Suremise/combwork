// Editing a lane's cards in Progress → Lanes (HI-2898), on fake Claude Code agents: a running lane opened to its cards
// shows its card in flight with a lock and its waiting cards with grips; a card moved with Alt+Up (queued behind the card
// in flight, said under the bar with Cancel Change) and dragged back; a move refused in place (it would go before a card
// it depends on), nothing changed; a card dropped from the board onto the lane; a Done card dropped from the board
// refused; Add Card… taking a card given to another agent off that agent; a card on another lane refused with Move Here,
// which moves it in one change, and the notification's Undo putting both lanes and its agent back; × taking a card off
// and Ctrl+Z putting it back; Cancel Change; and Ended today listing a lane that ended, opening to its cards read only.
// Screenshots of the editable queue with a refusal, and of Ended today, in both themes. Dev build, throwaway profile,
// workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const PORT = Number(lib.port(47938))
const userData = path.join(lib.WORK, 'lanequeue-profile')
const ws = path.join(lib.WORK, 'lanequeue-ws')
const claudeHome = path.join(lib.WORK, 'lanequeue-claude-home')
const shots = path.join(lib.WORK, 'lanequeue-shots')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms = HUNG_MS) => lib.until(fn, ms, 150)

;(async () => {
  for (const d of [userData, ws, claudeHome, shots]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [claudeHome, shots]) fs.mkdirSync(d, { recursive: true })
  lib.gitProject(alpha)
  lib.git(alpha, ['branch', '-M', 'main'])
  lib.gitProject(beta)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never', showTips: false }
  cfg.settings.notifications = { ...cfg.settings.notifications, desktopNotifications: false, chimeEnabled: false }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: String(PORT), CLAUDE_CONFIG_DIR: claudeHome, CW_TEST_TIPS: 'off' })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('alpha', { exact: true }).first().click()
  await lib.waitForProvider(inv)
  const b1 = await lib.addAgent(inv, alpha, { name: 'B1', workflowRole: 'builder' })
  const b2 = await lib.addAgent(inv, alpha, { name: 'B2', workflowRole: 'builder' })
  const b3 = await lib.addAgent(inv, alpha, { name: 'B3', workflowRole: 'builder' })
  const r1 = await lib.addAgent(inv, alpha, { name: 'R1', workflowRole: 'either' })
  check('the agents are added', [b1, b2, b3, r1].every((a) => a?.id))
  const workspaceToken = JSON.parse(fs.readFileSync(path.join(userData, 'agent-api.json'), 'utf8')).token
  const api = async (method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${route}`, { method, headers: { Authorization: `Bearer ${workspaceToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const keyOf = new Map()
  const K = (n) => keyOf.get(n) ?? `#${n}`
  const make = async (title, column = 'todo', agent = null, project = 'alpha') => {
    const c = await inv('tasks:create', { title, project, column, ...(agent ? { agent } : {}) })
    keyOf.set(c.number, c.key)
    return c.number
  }
  // B1's lane: its first card in flight (so a change of its order is queued behind it), three waiting. A4 depends on A3.
  const [a1, a2, a3, a4] = [await make('Queue data', 'doing', b1.id), await make('Queue rows', 'todo', b1.id), await make('Queue drag', 'todo', b1.id), await make('Queue keys', 'todo', b1.id)]
  await inv('tasks:update', a4, { blockedBy: [a3] })
  // B2's lane, its card in flight too, and one waiting that Move here takes.
  const [c1, c2] = [await make('Other lane first', 'doing', b2.id), await make('Other lane next', 'todo', b2.id)]
  // On the board only: one for the drag, one given to B3 for Add Card…, a Done one, and one of another project.
  const [x1, x2, done] = [await make('From the board'), await make('Given to B3', 'todo', b3.id), await make('Finished already', 'done')]
  const other = await make('Beta card', 'todo', null, 'beta')
  const startLane = async (builder, cards) => {
    const r = await api('POST', '/v1/lanes', { project: 'alpha', builder, reviewer: 'R1', cards })
    if (r.status !== 200) check(`the lane of ${builder} starts`, false, JSON.stringify(r))
    return r.body?.lane?.id
  }
  const la = await startLane('B1', [a1, a2, a3, a4])
  const lb = await startLane('B2', [c1, c2])
  check('two lanes started', !!la && !!lb)
  const laneNow = async (id) => (await inv('lanes:list')).find((l) => l.id === id)
  const listOf = async (id) => {
    const l = await laneNow(id)
    return (l?.queued ?? l?.cards.map((c) => c.number) ?? []).join()
  }
  const card = async (n) => (await inv('tasks:list')).find((c) => c.number === n)

  // --- The Lanes tab, B1's lane opened to its cards.
  const panel = page.locator('.progress-panel')
  await page.locator('.progress-rail').click()
  check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
  await panel.locator('.progress-tab[data-tab="lanes"]').click()
  const tab = panel.locator('.progress-tab-lanes')
  const lane = (id) => tab.locator(`.progress-lanes-list .progress-lane[data-lane="${id}"]`)
  const row = (id, n) => lane(id).locator(`.progress-lane-queue-row[data-card="${n}"]`)
  const rows = (id) => lane(id).locator('.progress-lane-queue-row').evaluateAll((els) => els.map((e) => Number(e.dataset.card)))
  await until(async () => (await lane(la).count()) === 1, HUNG_MS)
  await lane(la).locator('.progress-lane-expand').click()
  check('the lane opens to its cards', !!(await until(async () => (await rows(la)).join() === [a1, a2, a3, a4].join(), HUNG_MS)), JSON.stringify(await rows(la)))
  check('…its card in flight with a lock, not movable', (await row(la, a1).locator('.progress-lane-queue-lock').count()) === 1 && !/\bmovable\b/.test((await row(la, a1).getAttribute('class')) ?? ''))
  check('…its waiting cards with grips and ×', (await lane(la).locator('.progress-lane-queue-row.movable .progress-lane-queue-grip').count()) === 3 && (await lane(la).locator('.progress-lane-queue-remove').count()) === 3)
  const toast = (re) => page.locator('.toast', { hasText: re }).last()
  // The theme's repaint drawn: two animation frames after its condition (a condition, never a fixed time).
  const painted = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
  // The pop-ups sit over the panel's bottom right: closed before a click there (each has its ×).
  const clearToasts = async () => {
    for (let i = 0; i < 20 && (await page.locator('.toast .popup-close').count()); i++) await page.locator('.toast .popup-close').first().click().catch(() => undefined)
  }

  // --- Alt+Up: queued behind the card in flight, said under the bar with Cancel Change.
  await row(la, a3).focus()
  await page.keyboard.press('Alt+ArrowUp')
  check('Alt+Up moves a card up: queued behind the card in flight', !!(await until(async () => (await listOf(la)) === [a1, a3, a2, a4].join() && (await laneNow(la))?.queued !== null, HUNG_MS)), await listOf(la))
  check('…the queue shows the new order', !!(await until(async () => (await rows(la)).join() === [a1, a3, a2, a4].join(), HUNG_MS)), JSON.stringify(await rows(la)))
  check('…a notification says so, and when it applies', !!(await until(async () => (await toast(/Moved/).count()) > 0, HUNG_MS)) && new RegExp(`Moved ${K(a3)} in B1 / R1`).test(await toast(/Moved/).innerText()) && new RegExp(`once ${K(a1)} is Done`).test(await toast(/Moved/).innerText()), await toast(/Moved/).innerText().catch(() => ''))
  const queuedLine = lane(la).locator('.progress-lane-queued')
  check('…the queued change shows under the bar, with Cancel Change', !!(await until(async () => (await queuedLine.count()) === 1, HUNG_MS)) && (await queuedLine.locator('[data-action="lane-cancel-change"]').count()) === 1)
  check('…and the focus stays on the card moved', !!(await until(async () => (await page.evaluate(() => document.activeElement?.getAttribute('data-card'))) === String(a3), HUNG_MS)))

  // --- A move refused in place: A4 up once (still after A3, which it depends on), then again, before A3. Nothing changes.
  await row(la, a4).focus()
  await page.keyboard.press('Alt+ArrowUp')
  check('A4 moves up once, still after A3', !!(await until(async () => (await listOf(la)) === [a1, a3, a4, a2].join() && (await rows(la)).join() === [a1, a3, a4, a2].join(), HUNG_MS)), await listOf(la))
  const revBefore = (await laneNow(la)).listRev
  await row(la, a4).focus()
  await page.keyboard.press('Alt+ArrowUp')
  const refusal = lane(la).locator('.progress-lane-refusal')
  check('a move before a card it depends on is refused in place, saying why', !!(await until(async () => (await refusal.count()) === 1 && /depends on/.test(await refusal.innerText()), HUNG_MS)), await refusal.innerText().catch(() => ''))
  check('…and nothing changed', (await listOf(la)) === [a1, a3, a4, a2].join() && (await laneNow(la)).listRev === revBefore)
  // Said to screen readers only once main made it (HI-2932): the refused move is never announced as made.
  const saidQ = lane(la).locator('.visually-hidden[role="status"]')
  check('…and the refused move is not said as made', !new RegExp(`${K(a4)}: 2 of`).test(await saidQ.innerText().catch(() => '')), await saidQ.innerText().catch(() => ''))
  await clearToasts()
  await refusal.scrollIntoViewIfNeeded()
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await painted()
    await page.screenshot({ path: path.join(shots, `queue-refused-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await refusal.locator('.icon-button, button').last().click()
  check('…and the refusal can be dismissed', !!(await until(async () => (await refusal.count()) === 0, HUNG_MS)))

  // --- Dragged back: A2 above A3 (its top half). The list is the lane's own again, so nothing stays queued.
  await row(la, a2).dragTo(row(la, a3), { targetPosition: { x: 60, y: 3 } })
  check('a card dragged above another goes there', !!(await until(async () => (await listOf(la)) === [a1, a2, a3, a4].join(), HUNG_MS)), await listOf(la))
  check('…the list as it was: nothing left queued', !!(await until(async () => (await laneNow(la))?.queued === null && (await queuedLine.count()) === 0, HUNG_MS)))

  // --- Dropped on the locked row (HI-2969): its top half is no place, so no line shows and the drop does nothing, never
  // "after the last row" (the list's own handler took it so, and the card went last).
  const box = async (n) => (await row(la, n).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const from = await box(a2)
  const onto = await box(a1)
  await page.mouse.move(from.x + 60, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(onto.x + 60, onto.y + 8, { steps: 6 })
  await page.mouse.move(onto.x + 60, onto.y + 3, { steps: 2 })
  const lines = () => lane(la).locator('.progress-lane-queue-row.drop-before, .progress-lane-queue-row.drop-after').count()
  check('over the locked row, the card being dragged', !!(await until(async () => /\bdragging\b/.test((await row(la, a2).getAttribute('class')) ?? ''), HUNG_MS)))
  await painted()
  check('…no drop line shows', (await lines()) === 0, String(await lines()))
  await page.screenshot({ path: path.join(shots, 'queue-drop-locked.png') })
  await page.mouse.up()
  check('…and once dropped, the drag ends', !!(await until(async () => !/\bdragging\b/.test((await row(la, a2).getAttribute('class')) ?? ''), HUNG_MS)))
  // Nothing happened: a move made after it lands where it would from the list as it was (one place down, not stuck last).
  await row(la, a2).focus()
  await page.keyboard.press('Alt+ArrowDown')
  check('…and nothing moved: A2 still second (one Alt+Down puts it third)', !!(await until(async () => (await listOf(la)) === [a1, a3, a2, a4].join(), HUNG_MS)), await listOf(la))
  await row(la, a2).focus()
  await page.keyboard.press('Alt+ArrowUp')
  check('…and back', !!(await until(async () => (await listOf(la)) === [a1, a2, a3, a4].join() && (await laneNow(la))?.queued === null, HUNG_MS)), await listOf(la))

  // --- Two quick moves (HI-2932): Alt+Down twice before the first is answered moves A2 two places, neither refused as
  // changed meanwhile; then Alt+Up twice puts it back.
  await row(la, a2).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Alt+ArrowDown')
  check('two quick Alt+Downs move a card two places', !!(await until(async () => (await listOf(la)) === [a1, a3, a4, a2].join() && (await rows(la)).join() === [a1, a3, a4, a2].join(), HUNG_MS)), `${await listOf(la)} ${await refusal.innerText().catch(() => '')}`)
  check('…neither refused', (await refusal.count()) === 0, await refusal.innerText().catch(() => ''))
  check('…said once made, at its place now', !!(await until(async () => new RegExp(`${K(a2)}: 4 of 4`).test(await saidQ.innerText().catch(() => '')), HUNG_MS)), await saidQ.innerText().catch(() => ''))
  await row(la, a2).focus()
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.press('Alt+ArrowUp')
  check('…two quick Alt+Ups put it back', !!(await until(async () => (await listOf(la)) === [a1, a2, a3, a4].join() && (await laneNow(la))?.queued === null && (await refusal.count()) === 0, HUNG_MS)), `${await listOf(la)} ${await refusal.innerText().catch(() => '')}`)

  // --- Cards from the board: one dropped onto the lane's row joins it (queued after the card in flight); a Done one is refused.
  await page.getByRole('button', { name: 'Task Board' }).click()
  const tile = (n) => page.locator(`.task-card[data-task="${n}"]`)
  check('the board shows', !!(await until(async () => (await tile(x1).count()) === 1, HUNG_MS)))
  await tile(x1).dragTo(lane(la).locator('.progress-lane-top'))
  check('a card dragged from the board onto a lane joins it, last', !!(await until(async () => (await listOf(la)) === [a1, a2, a3, a4, x1].join(), HUNG_MS)), await listOf(la))
  await tile(done).dragTo(lane(la).locator('.progress-lane-top'))
  check('a Done card dragged from the board is refused in place', !!(await until(async () => (await refusal.count()) === 1 && /Done already/.test(await refusal.innerText()), HUNG_MS)), await refusal.innerText().catch(() => ''))
  await tile(other).dragTo(lane(la).locator('.progress-lane-top'))
  check("…and so is another project's card", !!(await until(async () => (await refusal.count()) === 1 && /isn’t one of alpha’s cards/.test(await refusal.innerText()), HUNG_MS)), await refusal.innerText().catch(() => ''))
  check('…nothing changed', (await listOf(la)) === [a1, a2, a3, a4, x1].join())

  // --- Cancel Change drops the queued change (the card from the board), keeping the lane's own list.
  await clearToasts()
  await queuedLine.locator('[data-action="lane-cancel-change"]').click()
  check('Cancel Change drops the queued change', !!(await until(async () => (await laneNow(la))?.queued === null && (await listOf(la)) === [a1, a2, a3, a4].join(), HUNG_MS)), await listOf(la))

  // --- Add Card…: a card given to B3 joins, taken off B3 in the same change.
  await clearToasts()
  await lane(la).locator('[data-action="lane-add-card"]').click()
  const picker = lane(la).locator('.progress-lane-picker')
  await picker.locator('input').fill(K(x2))
  check('Add Card… finds the card by its key', !!(await until(async () => (await picker.locator(`.progress-lane-picker-card[data-card="${x2}"]`).count()) === 1, HUNG_MS)))
  await page.keyboard.press('Enter')
  check('…Enter adds it', !!(await until(async () => (await listOf(la)) === [a1, a2, a3, a4, x2].join(), HUNG_MS)), `${await listOf(la)} ${await refusal.innerText().catch(() => '')}`)
  check('…taken off B3, so the lane can take it', !!(await until(async () => (await card(x2))?.agent === null, HUNG_MS)), JSON.stringify((await card(x2))?.agent))

  // --- A card on B2's lane: refused, with Move Here; that moves it in one change, and Undo puts everything back.
  await clearToasts()
  await lane(la).locator('[data-action="lane-add-card"]').click()
  await picker.locator('input').fill(K(c2))
  check("Add Card… says a card is on another lane", !!(await until(async () => /on the lane of B2/.test(await picker.innerText().catch(() => '')), HUNG_MS)), await picker.innerText().catch(() => ''))
  await picker.locator(`.progress-lane-picker-card[data-card="${c2}"]`).click()
  check('…adding it is refused, naming that lane, with Move Here', !!(await until(async () => (await refusal.count()) === 1 && /on the lane of B2/.test(await refusal.innerText()) && (await refusal.locator('[data-action="lane-move-here"]').count()) === 1, HUNG_MS)), await refusal.innerText().catch(() => ''))
  await refusal.locator('[data-action="lane-move-here"]').click()
  check('Move Here takes it off B2’s lane and onto this one', !!(await until(async () => (await listOf(lb)) === [c1].join() && (await listOf(la)).split(',').map(Number).includes(c2), HUNG_MS)), `${await listOf(la)} / ${await listOf(lb)}`)
  check('…taken off B2', (await card(c2))?.agent === null, JSON.stringify((await card(c2))?.agent))
  const moved = toast(new RegExp(`Moved ${K(c2)} to B1 / R1`))
  check('…a notification says so, with Undo', !!(await until(async () => (await moved.count()) > 0, HUNG_MS)))
  await moved.getByRole('button', { name: 'Undo' }).click()
  check('Undo puts both lanes back, and its agent', !!(await until(async () => (await listOf(lb)) === [c1, c2].join() && !(await listOf(la)).split(',').map(Number).includes(c2) && (await card(c2))?.agent === b2.id, HUNG_MS)), `${await listOf(la)} / ${await listOf(lb)} / ${(await card(c2))?.agent} ${JSON.stringify(await page.locator('.toast').allInnerTexts())}`)

  // --- × takes a card off (back to the board), and Ctrl+Z in the tab puts it back.
  const before = await listOf(la)
  await clearToasts()
  await row(la, a4).hover()
  await row(la, a4).locator('.progress-lane-queue-remove').click()
  check('× takes a card off the lane', !!(await until(async () => !(await listOf(la)).split(',').map(Number).includes(a4), HUNG_MS)), await listOf(la))
  check('…it stays on the board, in Todo', (await card(a4))?.column === 'todo' && !(await card(a4))?.archived)
  await lane(la).locator('.progress-lane-top').click()
  await page.keyboard.press('Control+z')
  check('Ctrl+Z in the tab puts it back', !!(await until(async () => (await listOf(la)) === before, HUNG_MS)), `${await listOf(la)} (was ${before})`)

  // --- Ended today: a lane that ended shows there, collapsed, and opens to its cards, read only.
  const e1 = await make('Ended lane card', 'todo', b3.id)
  const lc = await startLane('B3', [e1])
  const end = await api('POST', `/v1/lanes/${lc}/end`, { abandoned: true })
  check('a third lane is started and abandoned', end.status === 200, JSON.stringify(end))
  const ended = tab.locator('.progress-lanes-ended')
  check('Ended today shows, collapsed, with one lane', !!(await until(async () => (await ended.count()) === 1 && /Ended today \(1\)/.test(await ended.innerText()), HUNG_MS)), await ended.innerText().catch(() => ''))
  check('…and the lane is not in the list below', (await lane(lc).count()) === 0)
  await clearToasts()
  await ended.locator('.progress-lanes-ended-bar').click()
  const endedLane = ended.locator(`.progress-lane[data-lane="${lc}"]`)
  check('…it opens to the lane: builder and reviewer, abandoned', !!(await until(async () => (await endedLane.count()) === 1 && /B3 \/ R1/.test(await endedLane.innerText()) && /abandoned/.test(await endedLane.innerText()), HUNG_MS)), await endedLane.innerText().catch(() => ''))
  await endedLane.locator('.progress-lane-expand').click()
  check('…which opens to its cards, read only', !!(await until(async () => (await endedLane.locator(`.progress-lane-queue-row[data-card="${e1}"]`).count()) === 1, HUNG_MS)) && (await endedLane.locator('.progress-lane-queue-row.movable, [data-action="lane-add-card"]').count()) === 0)
  await clearToasts()
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
    await painted()
    await page.screenshot({ path: path.join(shots, `ended-today-${theme}.png`) })
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  await app.close().catch(() => undefined)
  console.log(failed ? `\n${failed} FAILED` : '\nAll passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log(`FAIL ${e.stack ?? e}`)
  process.exit(1)
})
