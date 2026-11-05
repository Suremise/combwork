// Screenshots of the agent dialogs and settings. Throwaway profile and git project; no sessions.
// Dev build only (#1580): it starts this checkout's Electron itself, and Tester is a 0.9 worktree agent
// (agents:testLegacy, refused by a packaged build), for the Merge dialog, Files' folder picker and Remove.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs'), path = require('path')
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000
const scratch = lib.WORK, userData = path.join(scratch, 'agentsui-profile')
const root = path.join(scratch, 'agentsui')
for (const d of [userData, root]) fs.rmSync(d, { recursive: true, force: true })
const ws = path.join(root, 'ws'), proj = path.join(ws, 'demo')
fs.mkdirSync(proj, { recursive: true })
// Git in the test repository, waiting out the Combwork under test's own git (lib.git, #199).
const g = (cmd, cwd = proj) => lib.git(cwd, cmd)
g('init -q -b main'); g('config user.email t@e.com'); g('config user.name T')
fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n'); g('add -A'); g('commit -q -m init')
// A branch from before #703 in the way of hive/ws/demo/…: an agent once called "ws" had hive/ws. New branches go to
// hive/ws-2/demo/…, the dialog's default too, and it stays.
g('branch hive/ws')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(ok ? 'PASS' : 'FAIL', name, extra) }
;(async () => {
  lib.enableProviders(userData)
  const env = lib.hiveEnv({ CW_USER_DATA: userData })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await lib.fitWindow(app, page, { width: 1500, height: 950 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.hive.invoke(c, ...x), [ch, a])
  await inv('workspace:open', ws); await sleep(800)
  await page.getByText('demo', { exact: true }).first().click(); await sleep(500)
  await inv('project:updateConfig', proj, { worktreeSetup: 'npm install' }); await inv('workspace:refresh'); await sleep(300)

  // A new project starts with no agents. Add Agent's main click is Configure Agent and Add… (#286): the dialog, nothing
  // added yet; the quick add (Ctrl+Alt+Shift+N) gives one with the default provider.
  let p0 = (await inv('workspace:refresh')).projects[0]
  check('new project has no agents', p0.agents.length === 0, String(p0.agents.length))
  check('empty Session tab offers Add Agent', (await page.getByText('No agents yet').count()) === 1)
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  const addDialog = page.locator('.dialog', { hasText: 'Add an agent' })
  check("+ Add ▾ → Configure Agent and Add… opens the Add Agent dialog (#975)", !!(await lib.until(async () => (await addDialog.count()) === 1, 5000)))
  await sleep(500)
  check('…without adding an agent', (await inv('workspace:refresh')).projects[0].agents.length === 0)
  await page.keyboard.press('Escape')
  await lib.until(async () => (await addDialog.count()) === 0, HUNG_MS)
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Alt+Shift+N'); await lib.until(async () => (await inv('workspace:refresh')).projects[0].agents.length === 1, 10000)
  p0 = (await inv('workspace:refresh')).projects[0]
  check('quick add: Agent 1, default provider, project folder', p0.agents.length === 1 && p0.agents[0].name === 'Agent 1' && p0.agents[0].provider === 'claude-code' && !p0.agents[0].worktree, JSON.stringify(p0.agents))
  check('one agent: one pane, automatically', (p0.config.layout ?? 'auto') === 'auto' && (await page.locator('.agent-pane').count()) === 1, JSON.stringify(p0.config.layout))
  // One agent or several, each pane has its header (who, controls) and footer (model, mode…).
  check('a single agent has its pane header', (await page.locator('.pane-header-bar', { hasText: 'Agent 1' }).count()) === 1)
  check('…and footer with model and mode', (await page.locator('.pane-footer-bar .mode-badge').count()) === 1)
  check('its session buttons are in its header', (await page.locator('.pane-header-bar button[aria-label="New Session"]').count()) === 1)
  const headerText = await page.locator('.project-header').innerText()
  check('the project header keeps project items only', !/New Session|Archive|Compact/.test(headerText) && (await page.locator('.project-header .mode-badge').count()) === 0, headerText.replace(/\s+/g, ' '))
  check('the status bar has no agent model or mode', (await page.locator('.statusbar .mode-badge, .statusbar .status-item', { hasText: /ctx$|Auto$/ }).count()) === 0)

  // + Add ▾ keeps its width at the window's right edge (#1329): with the side panels folded, the button is near that
  // edge, and its menu was as narrow as the room left (a fixed box with only `left` set), "At once, with your defaults"
  // wrapping over three lines. Now it's as wide as with the panels open, shifted left, its description on one line.
  const addShape = async () => {
    await page.locator('.session-toolbar .add-menu').click()
    await lib.until(async () => (await page.locator('.menu .menu-detail').count()) > 0, HUNG_MS)
    const shape = await page.evaluate(() => {
      const menu = document.querySelector('.menu').getBoundingClientRect()
      const lines = [...document.querySelectorAll('.menu .menu-detail')].map((d) => Math.round(d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight)))
      return { width: menu.width, right: menu.right, lines, anchor: document.querySelector('.session-toolbar .add-menu').getBoundingClientRect().left, inner: innerWidth }
    })
    await page.keyboard.press('Escape')
    await lib.until(async () => (await page.locator('.menu').count()) === 0, HUNG_MS)
    return shape
  }
  const sidePanels = [['Control+Alt+P', '.progress-panel'], ['Control+Alt+I', '.assistant-panel']]
  const panelsOpen = async (open) => {
    for (const [key, sel] of sidePanels) {
      if ((await page.locator(sel).count() > 0) === open) continue
      await page.evaluate(() => document.activeElement?.blur())
      await page.keyboard.press(key)
      await lib.until(async () => (await page.locator(sel).count() > 0) === open, HUNG_MS)
    }
  }
  const panelsBefore = await Promise.all(sidePanels.map(async ([, sel]) => (await page.locator(sel).count()) > 0))
  await panelsOpen(true)
  const roomy = await addShape()
  await panelsOpen(false)
  const atEdge = await addShape()
  check('#1329: with the panels folded, + Add ▾ is near the right edge (its menu has to shift)', atEdge.anchor + roomy.width > atEdge.inner - 8, JSON.stringify(atEdge))
  check('#1329: …its menu keeps its width there, its description on one line, inside the window', atEdge.width === roomy.width && atEdge.lines.every((n) => n === 1) && atEdge.right <= atEdge.inner - 8, JSON.stringify({ roomy, atEdge }))
  for (const [i, [key, sel]] of sidePanels.entries()) {
    if ((await page.locator(sel).count() > 0) === panelsBefore[i]) continue
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press(key)
    await lib.until(async () => (await page.locator(sel).count() > 0) === panelsBefore[i], HUNG_MS)
  }

  // Add Agent dialog (+ Add ▾, #975): no worktree to choose (#1442): agents start in the project folder, a builder in a
  // slot per card.
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  check('dialog open', !!(await lib.until(async () => (await addDialog.count()) === 1, HUNG_MS)))
  check('#1442: no worktree choice (no New worktree, no Existing worktree, no branch)', (await addDialog.locator('.choice', { hasText: /New worktree|Existing worktree|Project folder/ }).count()) === 0 && (await addDialog.locator('.agent-form.nested').count()) === 0, await addDialog.innerText())
  check('#1442: …it says where the agent works instead', /project folder[\s\S]*slots/i.test(await addDialog.locator('[data-where-note]').innerText().catch(() => '')), await addDialog.locator('[data-where-note]').innerText().catch(() => ''))
  await page.screenshot({ path: path.join(scratch, 'ui-1-add.png') })
  await page.keyboard.press('Escape')
  await lib.until(async () => (await addDialog.count()) === 0, HUNG_MS)
  // A 0.9 agent in its own worktree (#1451: 1.0 makes none; made as an upgraded project has one), for the Merge dialog,
  // Files' folder picker and Remove below.
  await lib.addAgent(inv, proj, { location: 'new-worktree', name: 'Tester', branch: 'hive/ws-2/demo/tester' })
  await lib.until(async () => (await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === 'Tester'), 15000)
  let p = (await inv('workspace:refresh')).projects[0]
  check('the 0.9 agent on its branch, shown as its 0.9 worktree (#1442)', p.agents.some((a) => a.name === 'Tester' && a.worktree?.branch === 'hive/ws-2/demo/tester' && a.place?.is === 'legacy' && a.place.branch === 'hive/ws-2/demo/tester'), JSON.stringify(p.agents.map((a) => a.place)))
  check('two agents: two columns, automatically', (p.config.layout ?? 'auto') === 'auto' && (await page.locator('.agent-pane').count()) === 2, JSON.stringify(p.config.layout))
  await sleep(500)
  await page.screenshot({ path: path.join(scratch, 'ui-2-strip.png') })

  // Merge dialog
  const t = p.agents.find((a) => a.name === 'Tester')
  fs.writeFileSync(path.join(t.worktree.path, 'b.txt'), 'b\n')
  await page.evaluate(([project, agentId]) => window.__hiveSet?.({ mergeFor: { project, agentId } }), [proj, t.id])
  await lib.agentMenu(page, 'Tester')
  await page.locator('.menu-item', { hasText: 'Merge…' }).click(); await lib.until(async () => (await page.locator('.dialog', { hasText: "1 file in the worktree isn't committed" }).count()) === 1, 10000)
  await page.screenshot({ path: path.join(scratch, 'ui-3-merge.png') })
  // Only committed work is merged (#1347): the dialog counts the uncommitted files, and Merge is off until they are committed.
  check('merge dialog counts uncommitted files', await page.locator('.dialog', { hasText: "1 file in the worktree isn't committed" }).count() === 1)
  check('…and Merge is off', await page.locator('.dialog').getByRole('button', { name: 'Merge', exact: true }).isDisabled())
  // No workflow, so no merge style of the project's (HI-1765): a merge commit.
  check('…starting on a merge commit for a project with no workflow', !!(await lib.until(async () => (await page.locator('.dialog .choice-list[data-merge-style="read"]').count()) === 1, HUNG_MS)) && (await page.locator('.dialog .choice-list input[type="radio"]').first().isChecked()))
  await page.keyboard.press('Escape'); await sleep(300)

  // Project settings: General (opened first: its key), then Agents (HI-1765)
  await lib.openProjectSettings(page)
  check('project settings open on General, with the key and no default provider (HI-2107)', !!(await lib.until(async () => (await page.locator('.settings-nav .row.selected .label').innerText().catch(() => '')) === 'General' && (await page.locator('.setting', { hasText: 'Project key' }).count()) === 1, HUNG_MS)) && (await page.locator('.setting', { hasText: 'Default provider' }).count()) === 0)
  check('…and no Slots and copies row', (await page.locator('[data-action="open-slot-options"]').count()) === 0)
  await page.screenshot({ path: path.join(scratch, 'ui-4-projgeneral.png') })
  await page.locator('.settings-nav .row', { hasText: /^\s*Agents\s*$/ }).first().click()
  check('project settings lists agents', !!(await lib.until(async () => (await page.locator('.agent-list-row').count()) === 2, HUNG_MS)))
  await page.screenshot({ path: path.join(scratch, 'ui-4-projsettings.png') })
  // File locks is a workflow option since HI-1766 (Version Control → Workflow): not here.
  await page.locator('.settings-top input').fill('lock')
  check('search finds no file locks here', (await page.locator('.setting', { hasText: 'File locks' }).count()) === 0)

  // Files tab root selector
  await page.locator('.tabs .tab', { hasText: 'Files' }).click(); await sleep(600)
  await page.locator('.root-select').selectOption(t.id); await lib.until(async () => (await page.getByText('b.txt').count()) > 0, 10000)
  check('files shows worktree', await page.getByText('b.txt').count() > 0)
  await page.screenshot({ path: path.join(scratch, 'ui-5-files.png') })

  // Global settings
  await page.evaluate(() => document.querySelector('[aria-label="Settings"]')?.click()); await sleep(600)
  await page.locator('.settings-nav .row', { hasText: /^\s*Agents\s*$/ }).first().click()
  check('global agents settings', !!(await lib.until(async () => (await page.locator('.setting', { hasText: 'Count background tasks for up to' }).count()) === 1, HUNG_MS)))
  check('…without File locks, a workflow option since HI-1766', (await page.locator('.setting', { hasText: 'File locks' }).count()) === 0)
  check('…with no Default merge style or Copy into new worktrees (HI-1765)', (await page.locator('.setting', { hasText: 'Default merge style' }).count()) === 0 && (await page.locator('.setting', { hasText: 'Copy into new worktrees' }).count()) === 0)
  await page.screenshot({ path: path.join(scratch, 'ui-6-global.png') })

  // Adding with the dialog (#1442): the agent works in the project folder, with nothing sent for a worktree.
  // (Back from Settings to the project's Session tab, where Add Agent is.)
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await page.getByText('demo', { exact: true }).first().click()
  const sessionTab = page.locator('.tabs .tab').filter({ hasText: /^\s*Session\s*$/ })
  await lib.until(async () => (await sessionTab.count()) === 1, HUNG_MS)
  await sessionTab.click()
  await lib.until(async () => (await page.locator('.session-toolbar .add-menu').count()) === 1, HUNG_MS)
  await lib.addMenuRun(page, 'Configure Agent and Add…')
  await lib.until(async () => (await addDialog.count()) === 1, HUNG_MS)
  await addDialog.locator('input.input').first().fill('Plain')
  await addDialog.locator('label', { hasText: 'Start a session now' }).locator('input').uncheck()
  await addDialog.locator('.btn.primary', { hasText: 'Add Agent' }).click()
  const plain = await lib.until(async () => (await inv('workspace:refresh')).projects[0].agents.find((a) => a.name === 'Plain'), HUNG_MS)
  check('#1442: an agent added with the dialog works in the project folder, with no worktree', !!plain && !plain.worktree && plain.place?.is === 'project' && plain.place.folder === proj && !fs.existsSync(path.join(`${ws}.worktrees`, 'demo', 'plain')), JSON.stringify(plain))
  await inv('agents:remove', proj, plain.id, { deleteWorktree: false })

  // Discard the worktree agent through the API and check cleanup
  await inv('agents:remove', proj, t.id, { deleteWorktree: true })
  check('worktree deleted', !fs.existsSync(t.worktree.path))
  // Any agent can be removed, the first one too.
  const first = (await inv('workspace:refresh')).projects[0].agents[0]
  await inv('agents:remove', proj, first.id, { deleteWorktree: false })
  const p1 = (await inv('workspace:refresh')).projects[0]
  check('the first agent can be removed', p1.agents.length === 0)
  console.log(`${pass}/${pass + fail} passed`)
  await app.close()
  // No delete of its folders here (#324): the runner gives the suite a new folder and removes it when it passes; a run
  // on its own empties them when it starts. Right after app.close() the CLI it stopped can still hold one, and a
  // failed delete here failed a suite whose checks had all passed.
})().catch((e) => { console.error(e); process.exit(1) })
