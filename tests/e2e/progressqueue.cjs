// The merge queue in the Progress panel (#1356): a project set to "Combwork merges" into `integration` (queueFixture.cjs),
// fake Claude Code agents acting by their own tokens, one merge check the test steers.
// - the queue's card shows, empty ("Nothing queued."), while the options have Combwork merge;
// - a red check: returned with its check's name, Open card and Show log (its run's log) working;
// - the check's run in Runs as "Combwork (merge queue)", with Open log, and in the Agent filter;
// - testing (the card, the target's head, its step), queued (in order, its revision, Remove), Pulse's line, the badge;
// - old rules: the options switch to "The agent merges" with one card testing and two queued; the queue's card stays,
//   with Pause queue, Resume and Remove (with its confirmation) working, through paused (the testing card finishes its
//   checks and waits) → resumed → merged, and the second card → returned (a conflict), shown until seen; a card approved
//   after the switch has no queue entry, and its builder's merge slot shows beside the queue's card;
// - each change announced once in the polite live region;
// - once nothing keeps it (its outcomes seen, no card in flight under the old rules), the queue's card goes.
// Screenshots of the Merges tab (wide and narrow) and Pulse, both themes. Dev build, throwaway profile, workspace and
// CLAUDE_CONFIG_DIR.
// Builders on slots (#1578). Many returns makes the list of returns small with a test seam (CW_TEST_QUEUE_RETURNS):
// NOT RUN on a packaged build (CW_EXE), where the rest runs.
const lib = require('./lib.cjs')
const fs = require('fs')
const path = require('path')
const q = require('./queueFixture.cjs')

const PORT = Number(lib.port(47851))
const fx = q.queueProject('progressqueue')
const HUNG_MS = 60000
const TARGET = 'integration'
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}
const until = (fn, ms) => lib.until(fn, ms, 200)

;(async () => {
  q.prepare(fx)
  // A second project, also on Combwork merges (its queue's card shows, empty): the project filter has both.
  const beta = path.join(fx.ws, 'beta')
  lib.gitProject(beta, { 'b.txt': 'b\n', '.gitignore': '.combwork/\n' })
  lib.git(beta, ['branch', '-M', 'main'])
  lib.git(beta, ['branch', 'integration'])
  const h = await q.startHive(fx, { port: PORT })
  try {
    const { page, inv } = h
    page.on('pageerror', (e) => check('no page errors', false, e.message))
    await lib.fitWindow(h.app, page, { width: 1400, height: 850 })
    // Opening a log is answered in main and recorded (never an editor window).
    await h.app.evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openPath = async (p) => (globalThis.__opened.push(p), '')
    })
    const opened = () => h.app.evaluate(() => globalThis.__opened)
    // Looking at the Merges tab in a focused window sees a return: the window's focus is stubbed (as inbox.cjs does; a
    // test copy never takes the OS focus) and the event Combwork listens for is sent with it.
    await h.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.isFocused = () => true
      w.emit('focus')
    })
    const view = async () => (await inv('queue:list', fx.alpha, TARGET))[0]
    const keyOf = async (n) => (await h.card(n))?.key
    const column = async (n) => (await h.card(n))?.column

    const panel = page.locator('.progress-panel')
    await page.locator('.progress-rail').click()
    check('the panel opens', !!(await until(async () => (await panel.count()) === 1, HUNG_MS)))
    const tab = (name) => panel.locator(`.progress-tab[data-tab="${name}"]`)
    const showTab = async (name) => {
      await tab(name).click()
      return until(async () => (await panel.locator(`.progress-tab-${name}`).count()) === 1, HUNG_MS)
    }
    const card = panel.locator(`.progress-queue-card[data-queue="alpha#${TARGET}"]`)
    const cardText = async () => ((await card.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const said = async () => (await page.locator('[data-queue-said]').innerText().catch(() => '')) ?? ''
    const setWidth = async (px) => {
      await panel.evaluate((el, w) => (el.style.width = `${w}px`), px)
      await until(async () => Math.round((await panel.boundingBox()).width) === px, HUNG_MS)
    }
    const shoot = async (name) => {
      for (const theme of ['dark', 'light']) {
        await inv('settings:update', { appearance: { theme } })
        await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === theme, HUNG_MS)
        await page.mouse.move(5, 5)
        await panel.screenshot({ path: path.join(fx.shots, `progressqueue-${name}-${theme}.png`) })
      }
      await inv('settings:update', { appearance: { theme: 'dark' } })
    }

    // --- HI-2165, one queue alone (alpha's, not worked on yet): left out under All projects while idle, with the filter
    // offered all the same, and shown when alpha is chosen there. Before its agents start (starting one marks alpha
    // worked on).
    await showTab('merges')
    const projectFilter = panel.getByRole('combobox', { name: 'Show the runs of' })
    check("under All projects, an inactive project's idle queue isn't shown, even as the only one (HI-2165)", !!(await until(async () => (await projectFilter.count()) === 1 && (await card.count()) === 0, HUNG_MS)), await panel.innerText().catch(() => ''))
    await projectFilter.selectOption({ label: 'alpha' })
    check('…chosen in the filter, its queue shows', !!(await until(async () => (await card.count()) === 1, HUNG_MS)))
    await projectFilter.selectOption({ label: 'All projects' })
    await until(async () => (await card.count()) === 0, HUNG_MS)

    // --- Combwork merges, nothing queued: the queue's card shows, empty, for the project being worked on (HI-2165: beta,
    // not worked on, is left out under All projects while its queue is idle).
    const reviewer = await q.agent(fx, h, 'R1')
    check('the reviewer has its token', !!reviewer.token)
    await inv('project:setActive', fx.alpha, true)
    await inv('workflow:setOptions', beta, { preset: null, options: q.queueOptions(fx) })
    check("the Merges tab shows the queue's card, empty, while the options have Combwork merge", !!(await until(async () => /Merge queue · integration/.test(await cardText()) && /Nothing queued\./.test(await cardText()), HUNG_MS)), JSON.stringify({ panel: await panel.innerText().catch(() => ''), alpha: await inv('queue:list', fx.alpha).catch((e) => String(e)), beta: await inv('queue:list', beta).catch((e) => String(e)), projects: (await inv('workspace:refresh')).projects.map((p) => p.path) }))
    check('…with Pause queue, and no Release (the merge slot\'s)', (await card.locator('[data-action="pause"]').count()) === 1 && (await card.getByRole('button', { name: /Release/ }).count()) === 0)
    // Recent merges (HI-1924), under the queue's card: nothing yet.
    const history = panel.locator(`[data-queue-history="alpha#${TARGET}"]`)
    const historyText = async () => ((await history.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    const historyRow = (key, outcome) => history.locator(`.progress-queue-history-row[data-outcome="${outcome}"][data-entry^="${key}/"]`)
    check('Recent merges under it: No merges yet.', !!(await until(async () => /Recent merges/i.test(await historyText()) && /No merges yet\./.test(await historyText()), HUNG_MS)), await historyText())

    // --- A red check: returned with its check's name; unseen while the filter shows another project or a dialog covers
    // the panel (HR3's round 1 finding 1); then Show log and Open card.
    const betaCard = panel.locator(`.progress-queue-card[data-queue="beta#${TARGET}"]`)
    check('the project filter offers both projects (each has a queue)', !!(await until(async () => (await projectFilter.count()) === 1 && (await projectFilter.locator('option', { hasText: 'beta' }).count()) === 1, HUNG_MS)))
    check("…under All projects, beta's idle queue isn't shown: it isn't being worked on (HI-2165)", (await betaCard.count()) === 0 && (await card.count()) === 1, await panel.innerText().catch(() => ''))
    await shoot('all-projects-inactive-hidden')
    await projectFilter.selectOption({ label: 'beta' })
    check('…filtered to beta, alpha\'s queue card is not shown', !!(await until(async () => (await card.count()) === 0 && (await betaCard.count()) === 1, HUNG_MS)))
    q.steer(fx, 'fail', 'unit broke')
    const zero = await q.approve(fx, h, reviewer, 'Zero', { 'zero.txt': 'zero\n' })
    const zeroKey = await keyOf(zero.n)
    check('…the return is announced (the window has it)', !!(await until(async () => new RegExp(`${zeroKey} returned: checks failed: quick`).test(await said()), HUNG_MS)), await said())
    const zeroSeen = async () => (await view())?.recent.find((r) => r.card === zero.n && r.outcome === 'returned')?.seen ?? null
    check('…but not seen: its queue card is filtered out', (await card.count()) === 0 && (await zeroSeen()) === null)
    // A dialog over the panel, then all projects: shown, but covered.
    await q.showBoard(page)
    await q.openByTitle(page, zero.n)
    const dialog = page.locator('.dialog').filter({ has: page.locator('.task-title-input') })
    await until(async () => (await dialog.count()) === 1, HUNG_MS)
    await projectFilter.evaluate((el) => {
      el.value = '*'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    check('…all projects under a dialog: its card is drawn, still not seen', !!(await until(async () => /returned/.test(await cardText()), HUNG_MS)) && (await zeroSeen()) === null, await cardText())
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    check('…the dialog closed: seen', !!(await until(zeroSeen, HUNG_MS)))
    const red = await cardText()
    check('a red check: "returned to its builder: checks failed: quick"', new RegExp(`${zeroKey} returned to builder ${zero.builder.name}: checks failed: quick`).test(red), red)
    const zeroRow = card.locator('.progress-queue-returned').first()
    await zeroRow.locator('[data-action="show-log"]').click()
    check('…Show log opens its check\'s log', !!(await until(async () => ((await opened()) ?? []).some((p) => /\.log$/i.test(p)), HUNG_MS)), JSON.stringify(await opened()))
    await zeroRow.locator('[data-action="open-card"]').click()
    check('…Open card opens it', !!(await until(async () => (await dialog.count()) === 1 && (await dialog.locator('.task-title-input').inputValue()) === 'Zero', HUNG_MS)))
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)
    check('…and it leaves the card a few seconds after it was seen', !!(await until(async () => (await card.locator('.progress-queue-returned').count()) === 0, HUNG_MS)))
    // …and stays in Recent merges, with why and how long its check took; a click opens its card.
    const zeroHistory = historyRow(zeroKey, 'returned')
    check('Recent merges: Zero returned, checks failed: quick, with its time and how long it took', !!(await until(async () => (await zeroHistory.count()) === 1 && /Returned: checks failed: quick/.test(await zeroHistory.innerText()) && /took /.test(await zeroHistory.innerText()), HUNG_MS)) && !/No merges yet/.test(await historyText()), await historyText())
    await zeroHistory.locator('.progress-queue-title').click()
    check('…a click on its row opens its card', !!(await until(async () => (await dialog.count()) === 1 && (await dialog.locator('.task-title-input').inputValue()) === 'Zero', HUNG_MS)))
    await page.keyboard.press('Escape')
    await until(async () => (await dialog.count()) === 0, HUNG_MS)

    // --- Testing now and queued; the check's run in Runs.
    q.steer(fx, 'wait')
    const one = await q.approve(fx, h, reviewer, 'One', { 'a.txt': 'one\nTWO by one\nthree\n' })
    const oneKey = await keyOf(one.n)
    const testing = await until(async () => {
      const v = await view()
      return v?.testing?.card === one.n && v.testing.step === 'checks' && v.testing.run ? v : null
    }, HUNG_MS)
    check('One is testing, at its checks, with its run', !!testing, JSON.stringify((await view())?.testing))
    const head = q.head(fx).slice(0, 7)
    check('…its card says what it tests: the card, the target at its head, the check running', !!(await until(async () => (await cardText()).includes(`${oneKey} + ${TARGET} @ ${head} → check: quick`), HUNG_MS)), await cardText())
    check('…and how long so far', /so far/.test(await cardText()))
    const two = await q.approve(fx, h, reviewer, 'Two', { 'a.txt': 'one\nTWO by two\nthree\n' })
    const three = await q.approve(fx, h, reviewer, 'Three', { 'three.txt': 'three\n' })
    const [twoKey, threeKey] = [await keyOf(two.n), await keyOf(three.n)]
    check('Two and Three wait, in order', !!(await until(async () => (await cardText()).includes(`${twoKey} and ${threeKey} waiting`), HUNG_MS)), await cardText())
    const twoRow = card.locator(`.progress-queue-list li[data-entry^="${twoKey}/"]`)
    check("…each with its approved revision and Remove", (await twoRow.locator('code').innerText()) === two.revision.slice(0, 7) && (await twoRow.getByRole('button', { name: `Remove ${twoKey} from the queue` }).count()) === 1)
    check('the Merges badge counts them', !!(await until(async () => (await tab('merges').locator('.progress-tab-badge').textContent().catch(() => '')) === '2', HUNG_MS)), await tab('merges').getAttribute('aria-label'))
    await setWidth(300)
    await shoot('merges-narrow')
    await setWidth(420)
    await shoot('merges-wide')

    // The check's run, in Runs as Combwork (merge queue), Open log; the Agent filter has it beside an agent's run.
    const runId = testing.testing.run
    const own = await fetch(`http://127.0.0.1:${PORT}/v1/progress`, { method: 'POST', headers: { Authorization: `Bearer ${one.builder.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'unit', command: 'npm test' }) })
    check("an agent's own run beside it", own.status === 200)
    await showTab('runs')
    const row = panel.locator(`.progress-tab-runs [data-run="${runId}"]`)
    check("Runs: the check's run, as Combwork (merge queue)", !!(await until(async () => (await row.count()) === 1 && /Combwork \(merge queue\)/.test(await row.innerText()), HUNG_MS)), await panel.locator('.progress-tab-runs').innerText().catch(() => ''))
    const agentFilter = panel.getByRole('combobox', { name: 'Agent' })
    const options = await agentFilter.locator('option').allInnerTexts().catch(() => [])
    check('…the Agent filter has Combwork (merge queue)', options.includes('Combwork (merge queue)'), JSON.stringify(options))
    await agentFilter.selectOption({ label: 'Combwork (merge queue)' })
    check('…which shows only Combwork\'s runs', !!(await until(async () => (await panel.locator('.progress-tab-runs [data-run]').count()) >= 1 && (await panel.locator('.progress-tab-runs').innerText()).includes('Combwork (merge queue)') && !(await panel.locator('.progress-tab-runs').innerText()).includes('npm test\n'), HUNG_MS)))
    await panel.getByRole('button', { name: 'Clear' }).click()
    // A finished one (Zero's red check) has its log: Open log in its details.
    const zeroRun = (await inv('progress:snapshot')).runs.find((r) => r.source === 'combwork' && r.card === zero.n && r.state === 'failed')
    const zeroRunRow = panel.locator(`.progress-tab-runs [data-run="${zeroRun?.id}"]`)
    // Its card's runs and the queue's folded line opened (HI-1701: runs by card, the queue's checks in one line).
    await until(async () => {
      if ((await zeroRunRow.count()) === 1) return true
      for (const t of await panel.locator('.progress-tab-runs .progress-card-toggle[aria-expanded="false"], .progress-tab-runs .progress-group-head[aria-expanded="false"]').all()) await t.click().catch(() => undefined)
      return false
    }, HUNG_MS)
    await zeroRunRow.locator('.progress-details-toggle').click()
    const before = ((await opened()) ?? []).length
    await zeroRunRow.locator('button', { hasText: 'Open log' }).click()
    check("…a finished one's Open log opens its log", !!zeroRun?.logPath && !!(await until(async () => ((await opened()) ?? []).length === before + 1 && (await opened()).at(-1) === zeroRun.logPath, HUNG_MS)), JSON.stringify({ log: zeroRun?.logPath, opened: await opened() }))
    await showTab('pulse')
    check("Pulse's line: integration: testing One · 2 queued", !!(await until(async () => (await panel.locator('.progress-queue-pulse').innerText().catch(() => '')).includes(`${TARGET}: testing ${oneKey} · 2 queued`), HUNG_MS)), await panel.locator('.progress-tab-pulse').innerText().catch(() => ''))
    await shoot('pulse')
    await panel.locator('.progress-queue-pulse').click()
    check('…a click shows the Merges tab', !!(await until(async () => (await tab('merges').getAttribute('aria-selected')) === 'true', HUNG_MS)))

    // --- Old rules: the next cards go to the agent; the queue's card stays, controllable.
    await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx, { finish: 'agentMerges', mergeChecks: [] }) })
    const after = await view()
    check('the options say the agent merges now; the queue keeps its cards in flight', after?.combworkMerges === false && after.inFlight.includes(one.n) && after.queued.length === 2, JSON.stringify({ combworkMerges: after?.combworkMerges, inFlight: after?.inFlight }))
    check("…its card stays", (await card.count()) === 1 && (await cardText()).includes(`${twoKey} and ${threeKey} waiting`), await cardText())
    // Remove from queue, asked first.
    await card.locator(`.progress-queue-list li[data-entry^="${threeKey}/"]`).getByRole('button', { name: `Remove ${threeKey} from the queue` }).click()
    const confirm = page.locator('.dialog').filter({ hasText: `Remove ${threeKey} from the merge queue?` })
    check('Remove asks first', !!(await until(async () => (await confirm.count()) === 1, HUNG_MS)))
    await confirm.getByRole('button', { name: 'Remove from queue' }).click()
    check('…removed: back to Approved, gone from the list', !!(await until(async () => (await column(three.n)) === 'passed' && !(await view()).queued.some((e) => e.card === three.n) && !(await cardText()).includes(threeKey), HUNG_MS)), JSON.stringify({ column: await column(three.n), text: await cardText() }))
    // Pause queue: One finishes its checks and waits, unmerged.
    await card.locator('[data-action="pause"]').click()
    check('Pause queue: paused, by you, with Resume', !!(await until(async () => /Paused by you\./.test(await cardText()) && (await card.locator('[data-action="resume"]').count()) === 1, HUNG_MS)), await cardText())
    check('…announced politely', !!(await until(async () => /Merge queue for integration paused/.test(await said()), HUNG_MS)), await said())
    const pauseRow = history.locator('.progress-queue-history-row[data-pause="user"]').first()
    check('Recent merges: the pause, by you, still paused', !!(await until(async () => (await pauseRow.count()) === 1 && /Paused: by you/.test(await pauseRow.innerText()) && /still paused/.test(await pauseRow.innerText()), HUNG_MS)), await historyText())
    await shoot('merges-paused')
    const target0 = q.head(fx)
    fs.writeFileSync(fx.go, 'go')
    const held = await until(async () => {
      const v = await view()
      return v && !v.runHere && v.paused && (await h.kinds(one.n)).filter((k) => k === 'CheckRan').length >= 1 ? v : null
    }, HUNG_MS)
    check('…One finished its checks and waits, unmerged', !!held && q.head(fx) === target0 && (await column(one.n)) !== 'done', JSON.stringify({ kinds: await h.kinds(one.n) }))
    // The second card's return, not seen while Pulse shows.
    await showTab('pulse')
    // One waits again, its checks done: queued, before Two.
    check("Pulse's line: paused, two waiting", !!(await until(async () => (await panel.locator('.progress-queue-pulse').innerText().catch(() => '')).includes(`${TARGET}: paused · 2 queued`), HUNG_MS)), await panel.locator('.progress-tab-pulse').innerText().catch(() => ''))
    await panel.locator('.progress-queue-pulse').click()
    await card.locator('[data-action="resume"]').click()
    await showTab('pulse')
    check('Resume: One merged (its check passes on the fresh test merge)', !!(await until(async () => (await column(one.n)) === 'done', HUNG_MS)), JSON.stringify(await h.kinds(one.n)))
    check('…announced: resumed, then merged', !!(await until(async () => /Merge queue for integration resumed/.test(await said()) && new RegExp(`${oneKey} merged`).test(await said()), HUNG_MS)), await said())
    const back = await until(async () => {
      const v = await view()
      return v?.recent.find((r) => r.card === two.n && r.outcome === 'returned') ?? null
    }, HUNG_MS)
    check('Two is returned: a conflict in a.txt', back?.reason === 'conflict' && (back.files ?? []).includes('a.txt'), JSON.stringify(back))
    check('…not seen while the Merges tab is not shown', !back?.seen)
    check('…announced once', !!(await until(async () => new RegExp(`${twoKey} returned: conflict in a.txt`).test(await said()), HUNG_MS)) && (await said()).split(`${twoKey} returned`).length === 2, await said())
    // A card approved now: no queue entry; its builder's merge slot shows beside the queue's card.
    const five = await q.approve(fx, h, reviewer, 'Five', { 'five.txt': 'five\n' })
    check('a card approved after the switch has no queue entry', Object.values(five.steps).every((s) => s.status === 200) && !(await h.kinds(five.n)).includes('IntegrationRequested') && !(await view()).queued.some((e) => e.card === five.n), JSON.stringify(await h.kinds(five.n)))
    const slot = await fetch(`http://127.0.0.1:${PORT}/v1/projects/alpha/merge-slot/claim`, { method: 'POST', headers: { Authorization: `Bearer ${five.builder.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: TARGET, cards: [five.n], timeoutSeconds: 0 }) })
    check("…its builder takes the merge slot", (await slot.json().catch(() => null))?.held === true)
    await showTab('merges')
    const twoShown = await until(async () => ((await cardText()).includes(`${twoKey} returned to builder ${two.builder.name}: conflict in a.txt`) ? await cardText() : null), HUNG_MS)
    check("the Merges tab: Two's return on the queue's card", !!twoShown, await cardText())
    const slotCard = panel.locator('.progress-tab-merges .progress-merge-card:not(.progress-queue-card)')
    check("…the merge slot's card beside it, with Release; the queue's card has none", !!(await until(async () => (await slotCard.count()) === 1, HUNG_MS)) && (await slotCard.getByRole('button', { name: /Release/ }).count()) === 1 && (await card.getByRole('button', { name: /Release/ }).count()) === 0)
    await shoot('merges-returned')
    check('…seen now', !!(await until(async () => !!(await view())?.recent.find((r) => r.card === two.n && r.outcome === 'returned')?.seen, HUNG_MS)))
    check('…and it leaves the card a few seconds later', !!(await until(async () => !(await cardText()).includes(`${twoKey} returned`), HUNG_MS)), await cardText())
    // Recent merges, live (no refresh): Two returned (a conflict, before any check ran: no time), One merged with its
    // merge commit (copies) and how long it took; the pause has ended.
    const oneHistory = historyRow(oneKey, 'merged')
    const twoHistory = historyRow(twoKey, 'returned')
    const merged = (await view())?.recent.find((r) => r.card === one.n && r.outcome === 'merged')
    check('Recent merges: One merged, with its merge commit and how long it took', !!(await until(async () => (await oneHistory.count()) === 1 && /Merged/.test(await oneHistory.innerText()) && (await oneHistory.locator('.progress-run-revision code').innerText()) === (merged?.result ?? '').slice(0, 7) && /took /.test(await oneHistory.innerText()), HUNG_MS)), await historyText())
    check('…Two returned on top: a conflict in a.txt, no time taken', !!(await until(async () => (await twoHistory.count()) === 1 && /Returned: conflict in a\.txt/.test(await twoHistory.innerText()), HUNG_MS)) && !/took /.test(await twoHistory.innerText()) && (await history.locator('.progress-queue-history-row').first().getAttribute('data-entry'))?.startsWith(`${twoKey}/`), await historyText())
    check('…the pause ended: how long it lasted', /lasted /.test(await pauseRow.innerText()) && (await pauseRow.getAttribute('data-ended')) === '', await pauseRow.innerText())
    check("…no push said (the project doesn't push)", (await oneHistory.locator('.progress-queue-push').count()) === 0)
    // What merges now first, history after (the Assistant's screenshot OK): alpha's merge slot between its queue's card
    // and its Recent merges, never under them.
    const order = await panel.locator('.progress-tab-merges').evaluate((el) => {
      const at = (sel) => [...el.querySelectorAll('.progress-merge-card, [data-queue-history]')].findIndex((n) => n.matches(sel))
      return { queue: at('.progress-queue-card[data-queue="alpha#integration"]'), slot: at('.progress-merge-card:not(.progress-queue-card)'), history: at('[data-queue-history="alpha#integration"]') }
    })
    check("…alpha's merge slot sits between its queue's card and its Recent merges", order.queue >= 0 && order.queue < order.slot && order.slot < order.history, JSON.stringify(order))
    await shoot('merges-history')
    // The agent filter: One's builder's rows only (the pause of the whole queue still shows); then all agents again.
    await projectFilter.selectOption({ label: 'alpha' })
    const agentOnly = panel.getByRole('combobox', { name: '…and of the agent' })
    const agentChoices = await until(async () => ((await agentOnly.count()) === 1 ? await agentOnly.locator('option').allInnerTexts() : null), HUNG_MS)
    if (agentChoices?.includes(one.builder.name)) {
      await agentOnly.selectOption({ label: one.builder.name })
      check("Recent merges follows the agent filter: One's builder's rows and the queue's pause, not Zero's", !!(await until(async () => (await oneHistory.count()) === 1 && (await zeroHistory.count()) === 0 && (await pauseRow.count()) === 1, HUNG_MS)), await historyText())
      await agentOnly.selectOption({ value: '' })
    } else check("the agent filter offers One's builder", false, JSON.stringify(agentChoices))
    await projectFilter.evaluate((el) => {
      el.value = '*'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    check("…all agents again: Zero's row back", !!(await until(async () => (await zeroHistory.count()) === 1, HUNG_MS)))
    check("the queue's card stays while cards are in flight under the old rules (Zero, Two, Three)", (await card.count()) === 1 && (await view()).inFlight.length === 3, JSON.stringify((await view()).inFlight))
    await fetch(`http://127.0.0.1:${PORT}/v1/projects/alpha/merge-slot/release`, { method: 'POST', headers: { Authorization: `Bearer ${five.builder.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: TARGET }) })
    for (const c of [zero, two, three]) await inv('tasks:archive', c.n, true)
    check('once none is, and its outcomes are seen, the queue\'s card goes', !!(await until(async () => (await card.count()) === 0, HUNG_MS)), await panel.locator('.progress-tab-merges').innerText().catch(() => ''))

    if (q.devSeam('many returns (the list of returns made small, CW_TEST_QUEUE_RETURNS)')) {
      // --- Many returns (#1356's returns policy, HR3's rounds 1 to 4): the window's list of returns made small (the seam: a
      // bound of 2), so four cards pass it. A card queued again takes no place; the rest are counted; a row shown and seen
      // stays usable for its 10 s, and only then does the next come, with nothing else happening (the queue paused).
      await h.app.evaluate(() => {
        process.env.CW_TEST_QUEUE_RETURNS = '2'
      })
      await inv('workflow:setOptions', fx.alpha, { preset: null, options: q.queueOptions(fx) })
      // Not seen meanwhile: the window counts as not focused.
      await h.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.isFocused = () => false
        w.emit('blur')
      })
      q.steer(fx, 'fail', 'many')
      const reds = []
      for (const title of ['P1', 'P2', 'P3', 'P4']) {
        const c = await q.approve(fx, h, reviewer, title, { [`${title.toLowerCase()}.txt`]: `${title}\n` })
        reds.push({ ...c, key: await keyOf(c.n) })
        check(`${title} is returned`, !!(await until(async () => (await column(c.n)) === 'doing', HUNG_MS)), JSON.stringify(await h.kinds(c.n)))
      }
      const [p1, p2, p3, p4] = reds
      await inv('queue:pause', fx.alpha, TARGET)
      await inv('queue:retry', p2.n, 'again')
      const listed = await until(async () => {
        const v = await view()
        return v && v.queued.some((e) => e.card === p2.n) && v.returns.length === 2 ? v : null
      }, HUNG_MS)
      check('the model: P4 and P3 listed, one more (P1); P2, queued again, takes no place', listed?.returns.map((r) => r.card).join() === `${p4.n},${p3.n}` && listed.returnsMore === 1, JSON.stringify({ returns: listed?.returns.map((r) => r.key), more: listed?.returnsMore }))
      await showTab('merges')
      const more = card.locator('[data-more-returns]')
      check('the card shows P4 and P3, and says one more is waiting', !!(await until(async () => (await more.count()) === 1 && /1 more returned card/.test(await more.innerText()) && (await cardText()).includes(`${p4.key} returned`) && (await cardText()).includes(`${p3.key} returned`), HUNG_MS)), await cardText())
      check("…not P2's return (it is queued again)", !(await cardText()).includes(`${p2.key} returned`) && (await cardText()).includes(`${p2.key} waiting`), await cardText())
      await shoot('merges-more')
      // Focused again: P4 and P3 are seen, and stay shown and usable; P1 comes only once they fold.
      await h.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        w.isFocused = () => true
        w.emit('focus')
      })
      const kept = await until(async () => {
        const v = await view()
        return v && v.returns.length === 2 && v.returns.every((r) => !!r.seen) ? v : null
      }, HUNG_MS)
      check('seen: P4 and P3 kept in the list, P1 still counted, not listed', !!kept && kept.returnsMore === 1 && !kept.returns.some((r) => r.card === p1.n), JSON.stringify({ returns: kept?.returns.map((r) => [r.key, r.seen]), more: kept?.returnsMore }))
      const seenAt = kept ? Math.min(...kept.returns.map((r) => Date.parse(r.seen))) : 0
      check('…and straight after, still shown with Open card and Show log (round 4)', (await cardText()).includes(`${p4.key} returned`) && (await cardText()).includes(`${p3.key} returned`) && (await card.locator(`.progress-queue-returned[data-entry^="${p3.key}/"] [data-action="show-log"]`).count()) === 1 && Date.now() - seenAt < 10_000, await cardText())
      const p1Row = card.locator(`.progress-queue-returned[data-entry^="${p1.key}/"]`)
      check('after their 10 s the window reads again by itself: P1, with Open card and Show log; no more waiting', !!(await until(async () => (await p1Row.count()) === 1 && (await more.count()) === 0, HUNG_MS)) && (await p1Row.locator('[data-action="show-log"]').count()) === 1 && Date.now() - seenAt >= 10_000, await cardText())
      const p1Seen = await until(async () => (await view())?.returns.find((r) => r.card === p1.n)?.seen ?? null, HUNG_MS)
      check('…P1 seen, still shown straight after', !!p1Seen && (await p1Row.count()) === 1, await cardText())
      const last = await view()
      check('…still paused, P2 still queued, never shown as returned', last?.paused?.reason === 'user' && last.queued.some((e) => e.card === p2.n) && !(await cardText()).includes(`${p2.key} returned`), JSON.stringify({ paused: last?.paused, queued: last?.queued.map((e) => e.key) }))
      await h.app.evaluate(() => {
        delete process.env.CW_TEST_QUEUE_RETURNS
      })
    }
  } catch (e) {
    check('no exception', false, e.stack)
  } finally {
    await h.app.close().catch(() => {})
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})()
