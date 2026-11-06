// An agent's card in Doing on the agent: the chip in its pane header (and its name's hover and the summary chip's list, #975) and the Workspace Overview's running
// list, its line in the project's sidebar tooltip; clicking opens the card; leaving Doing removes it. In the pane header
// the chip is its icon and number (+n), the titles on hover; in the Assistant's workspace section the agent's state mark
// has its cards and what it is doing (its progress) in its tooltip (#311, #979). The session
// records the card (its record in the workspace's database, #1061) and the Sessions tab shows "Worked on #n", unlinked once the card is deleted.
// The agent runs the fake Claude Code (fake-claude/). Dev build, throwaway profile, workspace and CLAUDE_CONFIG_DIR.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { sessionsOf } = require('./storeDocs.cjs')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 20000

const userData = path.join(lib.WORK, 'cardchip-profile')
const ws = path.join(lib.WORK, 'cardchip-ws')
const claudeHome = path.join(lib.WORK, 'cardchip-claude-home')
const alpha = path.join(ws, 'alpha')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, claudeHome]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  // Every read of the agents' input recorded, for typeLine (#1560).
  lib.logFakeInput(claudeHome)
  lib.gitProject(alpha)
  fs.writeFileSync(path.join(claudeHome, 'fake-trusted.json'), JSON.stringify([alpha.toLowerCase()]))
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const PORT = lib.port(47896)
  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: PORT, CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  const live = async (id) => (await inv('session:live')).find((s) => s.projectPath.toLowerCase() === alpha.toLowerCase() && s.agentId === id)
  const until = async (fn, ms = 20000) => {
    const t = Date.now()
    let v
    while (!(v = await fn()) && Date.now() - t < ms) await lib.sleep(300)
    return v
  }

  await page.getByText('alpha', { exact: true }).first().click()
  const coder = await lib.addAgent(inv, alpha, { name: 'Coder' })
  await lib.addAgent(inv, alpha, { name: 'Other' })
  await inv('project:updateConfig', alpha, { layout: 'columns2' })
  // A running session with one exchange (so Combwork keeps its record).
  await inv('session:start', alpha, { agentId: coder.id })
  await until(async () => ['waiting', 'ready'].includes((await live(coder.id))?.status), HUNG_MS)
  if ((await live(coder.id))?.status === 'waiting') await inv('pty:write', lib.ptyKey(alpha, coder.id), '\r')
  await until(async () => (await live(coder.id))?.status === 'ready', HUNG_MS)
  // Typed again if a wake of Combwork's disturbed it (lib.typeLine, #1560).
  await lib.typeLine(inv, lib.ptyKey(alpha, coder.id), claudeHome, null, 'hello', { live: () => live(coder.id) })
  check('Coder ran once', !!(await until(async () => (await live(coder.id))?.status === 'finished', HUNG_MS)))
  const sessionId = (await live(coder.id)).sessionId

  const header = page.locator('.pane-header-bar', { hasText: 'Coder' })
  check('no chip before it has a card', (await header.locator('.card-chip').count()) === 0)

  // A card in Todo for it shows nothing; in Doing it shows.
  const card = await inv('tasks:create', { title: 'Attention inbox', project: 'alpha', agent: coder.id })
  await lib.sleep(800) // On purpose: that nothing shows is the check, so it gives a chip time to show wrongly.
  check('a Todo card shows no chip', (await header.locator('.card-chip').count()) === 0)
  await inv('tasks:update', card.number, { column: 'doing' })
  check('the pane header shows the card’s key only, at any width (#311, #1221)', !!(await until(async () => (await header.locator('.card-chip').innerText().catch(() => '')).trim() === `${card.key}`, 5000)), await header.locator('.card-chip').innerText().catch(() => ''))
  let tip = await lib.hoverTip(page, header.locator('.card-chip'), (t) => t.includes(`${card.key} Attention inbox`))
  check("…its tooltip has the card's title", tip.includes(`${card.key} Attention inbox`), tip)
  tip = await lib.hoverTip(page, header.locator('.agent-name'), (t) => t.includes(`Working on ${card.key} Attention inbox`))
  check("the name's tooltip lists the card with its title (#975: the strip tab's did)", tip.includes(`Working on ${card.key} Attention inbox`), tip)
  await page.mouse.move(5, 5)
  // The summary chip's list of agents (#975) gives each agent's card.
  await page.locator('.session-toolbar .summary-chip').click()
  check("the summary chip's list gives the card", !!(await until(async () => (await lib.menuEntry(page, 'Coder').innerText().catch(() => '')).includes(`${card.key} Attention inbox`), 5000)), await lib.menuEntry(page, 'Coder').innerText().catch(() => ''))
  await page.keyboard.press('Escape')
  await until(async () => (await page.locator('.menu').count()) === 0, 5000)
  check('the other agent shows none', (await page.locator('.pane-header-bar', { hasText: 'Other' }).locator('.card-chip').count()) === 0)
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-1-pane.png') })

  // A second Doing card: "+1".
  const second = await inv('tasks:create', { title: 'Prompt snippets', project: 'alpha', agent: coder.id, column: 'doing' })
  check('a second Doing card shows +1', !!(await until(async () => /\+1/.test(await header.locator('.card-chip').innerText().catch(() => '')), 5000)))
  const headerChip = async () => (await header.locator('.card-chip').innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, '')
  check('…in the pane header too, still without titles', !!(await until(async () => (await headerChip()) === `${card.key}+1`, 5000)), await headerChip())
  const both = (t) => t.includes(`${card.key} Attention inbox`) && t.includes(`${second.key} Prompt snippets`)
  tip = await lib.hoverTip(page, header.locator('.card-chip'), both)
  check("…whose tooltip lists both cards' titles", both(tip), tip)
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-1b-short.png') })
  await page.mouse.move(5, 5)

  // Clicking opens the card.
  await header.locator('.card-chip').click()
  const dialog = lib.cardDialog(page, await lib.cardLabel(inv, card.number))
  check('clicking the chip opens the card', !!(await until(async () => (await dialog.count()) === 1, 5000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-2-dialog.png') })
  await page.keyboard.press('Escape')
  await until(async () => (await dialog.count()) === 0, HUNG_MS)

  // The session records both cards.
  const recorded = async () => sessionsOf(alpha).sessions.find((s) => s.id === sessionId)?.cards ?? []
  check('the session records its cards', !!(await until(async () => (await recorded()).length === 2, 8000)), JSON.stringify(await recorded()))

  // The sidebar's tooltip for the project: its agents as a table (#529), the agent's row with its card. Shown (hoverTip:
  // pointer away, then hovered until the tip says it), then its row read.
  await lib.hoverTip(page, page.locator('.project-row', { hasText: 'alpha' }).locator('.project-status'), (t) => t.includes(`${card.key} Attention inbox +1`))
  const coderCard = page.locator('.tip.agents-tip tr[data-agent="Coder"] .agents-table-card')
  const tipText = (await until(async () => (await coderCard.count()) === 1 && (await coderCard.innerText()), 10000)) || ''
  check("the project's tooltip lists the agent's card", tipText.includes(`${card.key} Attention inbox +1`), tipText)

  // The Workspace Overview's running list.
  await page.keyboard.press('Control+Shift+O')
  const runningChip = page.locator('.running-row', { hasText: 'Coder' }).locator('.card-chip')
  check('the Workspace Overview shows it on the running agent', !!(await until(async () => (await runningChip.count()) === 1, 8000)))
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-3-overview.png') })
  // HI-2000: with a long title the chip keeps its key whole on one line; only the title is cut. In both themes.
  const long = 'Attention inbox: every request for the user in one place, sorted by who waits longest, with a reply box'
  await inv('tasks:update', card.number, { title: long })
  await until(async () => ((await runningChip.innerText().catch(() => '')) ?? '').includes('Attention inbox:'), 8000)
  // A narrow window, so the row squeezes the chip.
  await lib.fitWindow(app, page, { width: 640, height: 900 })
  await until(async () => runningChip.evaluate((chip) => { const t = chip.querySelector('.card-chip-title'); return !!t && t.scrollWidth > t.clientWidth }).catch(() => false), 8000)
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    const k = await runningChip.evaluate((chip) => {
      const key = chip.querySelector('.card-chip-number')
      const title = chip.querySelector('.card-chip-title')
      const range = document.createRange()
      if (key) range.selectNodeContents(key)
      return { lines: key ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0, cut: !!title && title.scrollWidth > title.clientWidth }
    })
    check(`…a long title: its key on one line, its title cut (${theme})`, k.lines === 1 && k.cut, JSON.stringify(k))
    await page.locator('.running-row', { hasText: 'Coder' }).screenshot({ path: path.join(lib.WORK, `cardchip-running-long-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await lib.fitWindow(app, page, { width: 1500, height: 900 })
  await inv('tasks:update', card.number, { title: 'Attention inbox' })
  await page.locator('.activity-btn[aria-label="Projects"]').click()
  await page.locator('.project-row', { hasText: 'alpha' }).click()

  // The Assistant's workspace section (#311, #979): Coder's state mark has what it is doing (its progress run) and its
  // cards in its tooltip and its accessible name.
  const launches = fs.readFileSync(path.join(claudeHome, 'fake-launches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const coderToken = launches.filter((l) => l.cwd.toLowerCase() === alpha.toLowerCase()).at(-1)?.token
  const progress = async (p, body) => (await fetch(`http://127.0.0.1:${PORT}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${coderToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
  const run = await progress('/v1/progress', { title: 'e2e: 12 suites with a long title to cut short', total: 12, step: 4 })
  check('Coder reports a progress run', !!run?.id, JSON.stringify(run))
  /** The Assistant's panel at a width (a saved preference, taken by reloading the page), open. */
  const assistantAt = async (width) => {
    await inv('ui:setPane', 'assistant', width)
    await page.reload()
    await lib.appReady(page)
    if ((await page.locator('.assistant-panel').count()) === 0) await page.keyboard.press('Control+Alt+I')
    await until(async () => (await page.locator(`.assistant-agent[data-agent="${coder.id}"]`).count()) === 1, 10000)
  }
  const row = page.locator(`.assistant-agent[data-agent="${coder.id}"]`)
  await assistantAt(430)
  // Its state first (#979: the state its mark draws), then what it is doing.
  const rowTip = (t) => /^Coder: [^·\n]+ · e2e: 12 suites with a long title to cut short 4\/12/.test(t) && t.includes(`Working on ${card.key} Attention inbox`) && t.includes(`Working on ${second.key} Prompt snippets`) && t.includes('Progress: e2e: 12 suites with a long title to cut short 4/12')
  tip = await lib.hoverTip(page, row, rowTip)
  check("Coder's mark's tooltip: its progress, both cards with their titles and its run", rowTip(tip), tip)
  check('…and its accessible name says its state and what it is doing', /^Coder: [^·]+ · e2e: 12 suites/.test((await row.getAttribute('aria-label')) ?? ''), await row.getAttribute('aria-label'))
  await page.mouse.move(5, 5)
  await page.locator('.assistant-panel').screenshot({ path: path.join(lib.WORK, 'cardchip-assistant.png') })
  await progress(`/v1/progress/${run.id}/finish`, { ok: true })
  check('once the run ends, the mark says its status again', !!(await until(async () => !((await row.getAttribute('aria-label')) ?? 'e2e').includes('e2e'), 8000)), await row.getAttribute('aria-label'))
  await page.keyboard.press('Control+Alt+I')
  await page.locator('.project-row', { hasText: 'alpha' }).click()

  // Out of Doing: gone.
  await inv('tasks:update', card.number, { column: 'review' })
  await inv('tasks:update', second.number, { column: 'review' })
  check('moving the cards out of Doing removes the chip', !!(await until(async () => (await header.locator('.card-chip').count()) === 0, 5000)))

  // The Sessions tab: "Worked on", linked; a deleted card stays, unlinked.
  await inv('tasks:delete', second.number)
  // Its running session, from its ⋯ (#978).
  await header.getByRole('button', { name: 'More', exact: true }).click()
  await page.locator('.menu .menu-item', { hasText: 'Open in Sessions Tab' }).click()
  const worked = page.locator('.worked-on')
  // Once the board has caught up with the deletion: the deleted card is unlinked (in a tooltip's wrapper, whose
  // layout puts a line break in innerText), so the words are compared with their spacing evened out.
  check('a card still there is a link, a deleted one is not', !!(await until(async () => (await worked.locator('a.link').count()) === 1 && (await worked.locator('.tip-wrap').count()) === 1, 8000)))
  const words = async () => (await worked.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  // By key (#1221); the deleted card, no longer on the board, by its number.
  check('the Sessions tab says what the session worked on', (await words()).includes(`Worked on ${card.key} Attention inbox, #${second.number} Prompt snippets`), await words())
  await page.screenshot({ path: path.join(lib.WORK, 'cardchip-4-sessions.png') })
  await worked.locator('a.link').click()
  check('the link opens the card', !!(await until(async () => (await dialog.count()) === 1, 5000)))

  await inv('session:stop', alpha)
  await lib.until(async () => (await inv('session:live')).length === 0, 15000)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
