// Agent pages (#134): one layout for the project, and a page holds as many agents as the layout has panes, so pages
// = agents ÷ panes. Automatic until chosen (up to a 3×2 grid, then pages of six). 4 agents in three columns are two
// pages (the 4th alone on page 2); 6 in a grid of four are two; one at a time has no page buttons; switching the layout
// changes the pages at once; the last page's spare panes are empty; the workflow's Maximum agents of twelve binds the
// user too (HI-2058), and raised to 24 (#562, HI-2001), up to 24 agents: pages, the most page buttons, the agents table, a
// template of 24 round trip (its plan saying how far over twelve, its load without its workflow refused there), and a
// twenty-fifth refused.
// Dev build, throwaway profile and workspace; no sessions are started.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'pages-profile')
const ws = path.join(lib.WORK, 'pages-ws')
const proj = path.join(ws, 'crowd')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(proj, { recursive: true })
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47897) })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1600, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await page.getByText('crowd', { exact: true }).first().click()
  await lib.sleep(500)
  // Panes on screen, and the agents in them (an empty pane has no header).
  const panes = () => page.locator('.agent-pane').count()
  const shown = async () => (await page.locator('.pane-header-bar .agent-name').allInnerTexts()).map((t) => t.trim()).join(',')
  const buttons = () => page.locator('.page-switch button').count()
  const active = async () => (await page.locator('.page-switch button.active').innerText().catch(() => '')).trim()
  const add = async (n) => {
    for (let i = 0; i < n; i++) await inv('agents:add', proj, { location: 'project', provider: 'claude-code' })
    await inv('workspace:refresh')
    await lib.sleep(600)
  }
  const cfg = async () => (await inv('workspace:refresh')).projects[0].config
  const choose = async (label) => {
    await page.locator(`.layout-switch button[aria-label="${label}"]`).click()
    await lib.until(async () => (await page.locator(`.layout-switch button.active[aria-label="${label}"]`).count()) === 1, 5000)
    await lib.sleep(300)
  }
  const go = async (n) => {
    await page.locator(`.page-switch button[aria-label="Agent page ${n}"]`).click()
    await lib.until(async () => (await active()) === String(n), 5000)
  }

  // Four agents in three columns: two pages, the fourth alone on page 2 (beside two empty panes).
  await add(4)
  check('four agents: a grid of four, automatically, one page', (await panes()) === 4 && (await buttons()) === 0 && (await cfg()).layout === 'auto')
  await choose('Three columns')
  check('four agents in three columns: two page buttons, at once', (await buttons()) === 2, String(await buttons()))
  check('page 1 shows agents 1–3', (await shown()) === 'Agent 1,Agent 2,Agent 3', await shown())
  check('the summary chip counts the four agents (#975), none running: stopped, as the header counts them (HI-1908)', (await page.locator('.session-toolbar .summary-chip').innerText()).trim() === '4 stopped', await page.locator('.session-toolbar .summary-chip').innerText())
  await go(2)
  check('page 2 has the fourth agent, its spare panes empty', (await shown()) === 'Agent 4' && (await panes()) === 3, `${await shown()} / ${await panes()}`)
  check('saved as the project layout', (await cfg()).layout === 'columns3', JSON.stringify(await cfg()))
  await page.screenshot({ path: path.join(lib.WORK, 'pages-1-columns3.png') })

  // Six agents in a grid of four: two pages (4 + 2).
  await add(2)
  await choose('Grid of four')
  check('six agents in a grid of four: two pages', (await buttons()) === 2, String(await buttons()))
  await go(1)
  check('page 1: agents 1–4', (await shown()) === 'Agent 1,Agent 2,Agent 3,Agent 4', await shown())
  await go(2)
  check('page 2: agents 5 and 6', (await shown()) === 'Agent 5,Agent 6' && (await panes()) === 4, `${await shown()} / ${await panes()}`)
  // A fresh hover (the tooltip hides on the click that went to page 2).
  await page.mouse.move(0, 0)
  await page.locator('.page-switch button[aria-label="Agent page 2"]').hover()
  const tipText = async () => (await page.locator('.tip').first().textContent({ timeout: 500 }).catch(() => '')) ?? ''
  check('the page button names its agents', !!(await lib.until(async () => (await tipText()).startsWith('Page 2: Agent 5 and Agent 6'), HUNG_MS)), await tipText())
  await page.mouse.move(0, 0)
  // One at a time: no page buttons, the focused agent shown; choosing an agent in the summary chip's list shows it (#975).
  await choose('One at a time')
  check('one at a time: no page buttons, one pane', (await buttons()) === 0 && (await panes()) === 1, `${await buttons()} / ${await panes()}`)
  await lib.showAgent(page, 'Agent 2')
  await lib.until(async () => (await shown()) === 'Agent 2', 5000)
  check("the summary chip's list shows its agent", (await shown()) === 'Agent 2', await shown())
  // The one that shows them all (six: a 3×2 grid) is automatic again.
  await choose('Grid of six')
  check('six agents in the grid of six: one page, saved as automatic', (await buttons()) === 0 && (await panes()) === 6 && (await cfg()).layout === 'auto', JSON.stringify((await cfg()).layout))

  // The seventh (added here, the quick add) opens page 2 of the automatic grid, with a note about memory.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+N')
  await lib.until(async () => (await active()) === '2', 10000)
  check('the seventh agent opens page 2', (await active()) === '2')
  check('page 2 shows it, its spare panes empty', (await shown()) === 'Agent 7' && (await panes()) === 6, `${await shown()} / ${await panes()}`)
  check('a note on what seven agents cost', (await page.locator('.toast', { hasText: '7 agents in this project' }).count()) === 1)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-2-page2.png') })
  await page.keyboard.press('Control+Alt+PageUp')
  await lib.until(async () => (await active()) === '1', 5000)
  check('Ctrl+Alt+PageUp: page 1, its six', (await active()) === '1' && (await shown()).split(',').length === 6)
  await page.keyboard.press('Control+Alt+PageDown')
  await lib.until(async () => (await active()) === '2', 5000)
  await add(1)
  check('Ctrl+Alt+PageDown: page 2, which grows as agents are added', (await active()) === '2' && (await shown()) === 'Agent 7,Agent 8', await shown())
  // Clicking an agent on the other page goes to that page.
  await lib.showAgent(page, 'Agent 3')
  await lib.until(async () => (await active()) === '1', 5000)
  check("choosing an agent on page 1 in the summary chip's list goes there", (await active()) === '1')

  // Twelve, the workflow's Maximum agents by default: raised below to go past it (HI-2001, HI-2058).
  await add(4)
  const n = (await inv('workspace:refresh')).projects[0].agents.length
  check('twelve agents', n === 12, String(n))
  await go(2)
  check('page 2 is a full 3×2 grid too', (await shown()).split(',').length === 6)
  await page.screenshot({ path: path.join(lib.WORK, 'pages-3-twelve.png') })

  // Removing the focused agent on page 2 stays on page 2 (the next agent takes focus) until page 2 empties.
  // Its menu from its pane's header (#975: the agent strip's tab had it), which shows and focuses it first.
  const remove = async (name) => {
    await lib.agentMenu(page, name)
    await page.locator('.menu-item', { hasText: 'Remove Agent…' }).click()
    await page.locator('.dialog-footer button', { hasText: /^Remove$/ }).click()
    // Gone from Combwork and from the panes (the dialog closes before the removal has finished).
    await lib.until(async () => !(await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === name) && !(await page.locator('.pane-header-bar .agent-name').allInnerTexts()).some((t) => t.trim() === name), 10000)
  }
  await remove('Agent 9')
  check('removing an agent on page 2 stays on page 2', (await active()) === '2', await active())
  check('the next agent takes its focus', !!(await lib.until(async () => (await page.locator('.pane-header-bar.focused .agent-name', { hasText: /^Agent 10$/ }).count()) === 1, HUNG_MS)))
  await remove('Agent 12')
  check('removing another agent there stays too', (await active()) === '2', await active())
  const left = (await inv('workspace:refresh')).projects[0].agents
  for (const a of left.slice(7)) await inv('agents:remove', proj, a.id, { deleteWorktree: false })
  await inv('workspace:refresh')
  await lib.sleep(600)
  await remove('Agent 7')
  check('removing the only agent on page 2 goes to page 1', (await page.locator('.page-switch').count()) === 0 && (await panes()) >= 1)

  // --- More than twelve (#562, HI-2001): the workflow's Maximum agents binds the user too (HI-2058); raised, up to 24.
  const setLimit = (v) => lib.setMaxAgents(inv, v, 'workspace')
  const agentsNow = async () => (await inv('workspace:refresh')).projects[0].agents
  const refusal = () => inv('agents:add', proj, { location: 'project', provider: 'claude-code' }).then(() => '', (e) => String(e.message ?? e))
  // + Add ▾'s Configure Agent and Add… (#975), greyed out at the limit.
  const addGreyed = async () => {
    await page.locator('.session-toolbar .add-menu').click()
    await lib.until(async () => (await lib.menuEntry(page, 'Configure Agent and Add…').count()) === 1, HUNG_MS)
    const greyed = (await lib.menuEntry(page, 'Configure Agent and Add…').getAttribute('aria-disabled')) === 'true'
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    return greyed
  }
  await add(12 - (await agentsNow()).length)
  check("at Maximum agents (twelve), + Add ▾'s Configure Agent and Add… is greyed out: it binds the user too", !!(await lib.until(addGreyed, HUNG_MS)))
  const at12 = await refusal()
  check('…and a thirteenth is refused, saying where Maximum agents is raised', at12.endsWith('This project’s workflow allows 12 agents: raise Maximum agents in Version Control → Workflow.'), at12)
  await setLimit(24)
  check("raised to 24: + Add ▾'s Configure Agent and Add… isn't greyed out", !!(await lib.until(async () => !(await addGreyed()), HUNG_MS)))
  await add(12)
  check('twenty-four agents', (await agentsNow()).length === 24, String((await agentsNow()).length))
  const at24 = await refusal()
  check('a twenty-fifth is refused', at24.endsWith('A project can have up to 24 agents.'), at24)
  check("…and + Add ▾'s Configure Agent and Add… is greyed out", !!(await lib.until(addGreyed, HUNG_MS)))
  await choose('Grid of six')
  check('24 in the grid of six: four pages', (await buttons()) === 4, String(await buttons()))
  await go(4)
  check('page 4: a full grid', (await shown()).split(',').length === 6, await shown())
  // The most pages: two columns, all in the toolbar and the window, beside Panes | Tiles, the summary chip and + Add ▾.
  const stripFits = () =>
    page.evaluate(() => {
      const bar = document.querySelector('.session-toolbar')
      const out = [...document.querySelectorAll('.page-switch button, .layout-switch button, .session-toolbar .add-menu, .session-toolbar .summary-chip, .view-switch button')].filter((b) => {
        const r = b.getBoundingClientRect()
        return r.width === 0 || r.left < 0 || r.right > window.innerWidth
      })
      return { overflows: !!bar && bar.scrollWidth > bar.clientWidth + 1, out: out.length }
    })
  // Twelve pages are more than buttons fit: ‹, "1 / 12" (a menu of every page), ›.
  const pager = async () => (await page.locator('.page-switch.compact .page-menu').innerText().catch(() => '')).trim()
  await choose('Two columns')
  // Page 10 of 12: the focused agent's, from page 4 of the grid of six.
  check('24 in two columns: the compact pager, ‹ 10 / 12 › (where the focused agent is)', (await buttons()) === 3 && (await pager()) === '10 / 12', `${await buttons()} / ${await pager()}`)
  await page.locator('.page-switch.compact .page-menu').click()
  check('its menu lists the twelve pages', !!(await lib.until(async () => (await page.locator('.menu-item', { hasText: /^Page \d+/ }).count()) === 12, HUNG_MS)))
  await page.locator('.menu-item', { hasText: /^Page 12/ }).click()
  check('page 12 from the menu: the last two', !!(await lib.until(async () => (await pager()) === '12 / 12', HUNG_MS)) && (await shown()).split(',').length === 2, `${await pager()} / ${await shown()}`)
  await page.locator('.page-switch button[aria-label="Next agent page"]').click()
  check('› after the last goes round to page 1', !!(await lib.until(async () => (await pager()) === '1 / 12', HUNG_MS)), await pager())
  await page.locator('.page-switch button[aria-label="Previous agent page"]').click()
  check('‹ goes back to page 12', !!(await lib.until(async () => (await pager()) === '12 / 12', HUNG_MS)), await pager())
  check('the pager and the layouts fit the toolbar', JSON.stringify(await stripFits()) === '{"overflows":false,"out":0}', JSON.stringify(await stripFits()))
  await page.screenshot({ path: path.join(lib.WORK, 'pages-4-24-columns2.png') })
  await lib.fitWindow(app, page, { width: 1024, height: 700 })
  await lib.until(async () => (await page.evaluate(() => window.innerWidth)) === 1024, HUNG_MS)
  check('…also in a 1024-wide window', JSON.stringify(await stripFits()) === '{"overflows":false,"out":0}', JSON.stringify(await stripFits()))
  await page.screenshot({ path: path.join(lib.WORK, 'pages-5-24-narrow.png') })
  // The agents table (#529) of 24 fits the window's height, without scrolling or fading out.
  const table = async () => {
    await page.evaluate(() => document.activeElement?.blur?.())
    await page.mouse.move(600, 400)
    await lib.until(async () => (await page.locator('.tip').count()) === 0, HUNG_MS)
    await page.locator('.project-header .project-title .badge').first().hover()
    await lib.until(async () => (await page.locator('.tip.agents-tip table.agents-table').count()) === 1, HUNG_MS)
    return page.evaluate(() => {
      const tip = document.querySelector('.tip.agents-tip')
      const r = tip.getBoundingClientRect()
      return { rows: tip.querySelectorAll('tbody tr').length, clipped: tip.classList.contains('clipped'), scrolls: tip.scrollHeight > tip.clientHeight + 1, inside: r.top >= 0 && r.bottom <= window.innerHeight }
    })
  }
  const t700 = await table()
  check('the agents table of 24 fits a 700-high window', t700.rows === 24 && !t700.clipped && !t700.scrolls && t700.inside, JSON.stringify(t700))
  await page.screenshot({ path: path.join(lib.WORK, 'pages-6-24-table.png') })
  await page.mouse.move(600, 400)
  await lib.fitWindow(app, page, { width: 1600, height: 900 })
  await choose('One at a time')
  check('24 one at a time: no page buttons', (await buttons()) === 0 && (await panes()) === 1, `${await buttons()} / ${await panes()}`)

  // A template of 24 (saved, then loaded back into the project), and the limit applying to it.
  const saved = await inv('templates:save', proj, 'project', 'Two dozen', false)
  check('a template of 24 is saved', saved?.saved?.agents?.length === 24, JSON.stringify(saved).slice(0, 200))
  for (const a of (await agentsNow()).slice(3)) await inv('agents:remove', proj, a.id, { deleteWorktree: false })
  check('down to three agents', (await agentsNow()).length === 3)
  await setLimit(null)
  const plan = await inv('templates:plan', proj, 'project', saved.saved.file)
  check("at Maximum agents twelve, the user's plan has 24 agents and nothing blocking, saying how far over", plan.create.length === 24 && plan.blocked.length === 0 && JSON.stringify(plan.maxAgents) === '{"now":12,"needs":24}', JSON.stringify([plan.blocked, plan.maxAgents]))
  await setLimit(24)
  const fits = await inv('templates:plan', proj, 'project', saved.saved.file)
  check('this workspace allows 24: nothing over', fits.maxAgents === null, JSON.stringify(fits.maxAgents))
  await setLimit(null)
  // Its workflow not applied (HI-2058): more agents than Maximum agents can't be loaded, and nothing changes.
  const over = await inv('templates:load', proj, 'project', saved.saved.file, plan.remove.map((a) => a.id)).then(() => '', (e) => String(e.message ?? e))
  check('at twelve, its load without its workflow is refused, nothing changed', /It has 24 agents, and this project’s workflow allows 12 agents: raise Maximum agents in Version Control → Workflow first, or load it with its workflow\. Nothing was changed\./.test(over) && (await agentsNow()).length === 3, `${over} / ${(await agentsNow()).length}`)
  await setLimit(24)
  const loaded = await inv('templates:load', proj, 'project', saved.saved.file, plan.remove.map((a) => a.id))
  check('at 24, loaded: 24 agents again', loaded.created.length === 24 && (await agentsNow()).length === 24, `${loaded.created.length} / ${(await agentsNow()).length}`)
  const after = await refusal()
  check('…and a twenty-fifth is refused', after.endsWith('A project can have up to 24 agents.'), after)

  await app.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.log('FAIL', e.message)
  process.exit(1)
})
