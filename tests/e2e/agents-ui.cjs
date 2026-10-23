// Screenshots of the agent dialogs and settings. Throwaway profile and git project; no sessions.
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
// Git in the test repository, waiting out the Hive under test's own git (lib.git, #199).
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
  const env = lib.hiveEnv({ HIVE_USER_DATA: userData })
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

  // Add Agent dialog (+ Add ▾, #975), new worktree option
  await lib.addMenuRun(page, 'Configure Agent and Add…'); await sleep(800)
  check('dialog open', await page.locator('.dialog', { hasText: 'Add an agent' }).count() === 1)
  await page.locator('.choice', { hasText: 'New worktree' }).click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'ui-1-add.png') })
  await page.locator('.dialog input.input').first().fill('Tester')
  check('branch follows name, in the place git can make it (hive/ws is a branch)', !!(await lib.until(async () => (await page.locator('.agent-form.nested input').inputValue()) === 'hive/ws-2/demo/tester', HUNG_MS)), await page.locator('.agent-form.nested input').inputValue())
  // 1.0 adds no agent in a worktree (#1451: main refuses it; #1442 takes the choice out of the dialog): the agent the
  // dialog would have made is made as a 0.9 one, on the branch the dialog shows, for the Merge dialog's check below.
  const testerBranch = await page.locator('.agent-form.nested input').inputValue()
  await page.keyboard.press('Escape')
  await lib.until(async () => (await page.locator('.dialog', { hasText: 'Add an agent' }).count()) === 0, HUNG_MS)
  await lib.addAgent(inv, proj, { location: 'new-worktree', name: 'Tester', branch: testerBranch })
  await lib.until(async () => (await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === 'Tester'), 15000)
  let p = (await inv('workspace:refresh')).projects[0]
  check('the agent on the branch the dialog showed', p.agents.some((a) => a.name === 'Tester' && a.worktree?.branch === 'hive/ws-2/demo/tester') && g('branch --list hive/ws').includes('hive/ws'))
  // The dialog sends the branch it shows: its generated default still records the part as the project's (#703 round 4).
  const projectJson = () => JSON.parse(fs.readFileSync(path.join(proj, '.hive', 'project.json'), 'utf8'))
  check("…its workspace part recorded as the project's", JSON.stringify(projectJson().branchSpaces) === '["ws-2"]', JSON.stringify(projectJson().branchSpaces))
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
  await page.keyboard.press('Escape'); await sleep(300)

  // Project settings → Agents & Worktrees
  await lib.openProjectSettings(page)
  await page.locator('.settings-nav .row', { hasText: 'Agents & Worktrees' }).click(); await sleep(500)
  await page.screenshot({ path: path.join(scratch, 'ui-4-projsettings.png') })
  check('project settings lists agents', await page.locator('.agent-list-row').count() === 2)
  await page.locator('.settings-top input').fill('lock'); await sleep(300)
  check('search finds file locks', await page.locator('.setting', { hasText: 'File locks' }).count() === 1)

  // Files tab root selector
  await page.locator('.tabs .tab', { hasText: 'Files' }).click(); await sleep(600)
  await page.locator('.root-select').selectOption(t.id); await lib.until(async () => (await page.getByText('b.txt').count()) > 0, 10000)
  check('files shows worktree', await page.getByText('b.txt').count() > 0)
  await page.screenshot({ path: path.join(scratch, 'ui-5-files.png') })

  // Global settings
  await page.evaluate(() => document.querySelector('[aria-label="Settings"]')?.click()); await sleep(600)
  await page.locator('.settings-nav .row', { hasText: 'Agents & Worktrees' }).click(); await sleep(400)
  await page.screenshot({ path: path.join(scratch, 'ui-6-global.png') })
  check('global agents settings', await page.locator('.setting', { hasText: 'Default merge style' }).count() === 1)

  // #703 round 4: an agent added with the dialog's default branch in the part the project moved to, removed keeping its
  // worktree; then the branch in the way (hive/ws) goes. The dialog still offers that part and says it reuses the kept
  // worktree; adding works in it again: same folder, same branch, no new one.
  // (Back from Settings to the project's Session tab, where Add Agent is.)
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await page.getByText('demo', { exact: true }).first().click()
  const sessionTab = page.locator('.tabs .tab').filter({ hasText: /^\s*Session\s*$/ })
  await lib.until(async () => (await sessionTab.count()) === 1, HUNG_MS)
  await sessionTab.click()
  await lib.until(async () => (await page.locator('.session-toolbar .add-menu').count()) === 1, HUNG_MS)
  const addWith = async (name) => {
    await lib.addMenuRun(page, 'Configure Agent and Add…')
    const d = page.locator('.dialog', { hasText: 'Add an agent' })
    await lib.until(async () => (await d.count()) === 1, HUNG_MS)
    await d.locator('input.input').first().fill(name)
    await d.locator('.choice', { hasText: 'New worktree' }).click()
    await d.locator('label', { hasText: 'Start a session now' }).locator('input').uncheck()
    return d
  }
  const branchShown = (d) => d.locator('.agent-form.nested input').first().inputValue()
  let keeperDialog = await addWith('Keeper')
  check('Keeper: the default branch in the part the project moved to', !!(await lib.until(async () => (await branchShown(keeperDialog)) === 'hive/ws-2/demo/keeper', HUNG_MS)), await branchShown(keeperDialog))
  // Made as a 0.9 agent on the branch shown (#1451, as above).
  const keeperBranch = await branchShown(keeperDialog)
  await page.keyboard.press('Escape')
  await lib.until(async () => (await keeperDialog.count()) === 0, HUNG_MS)
  await lib.addAgent(inv, proj, { location: 'new-worktree', name: 'Keeper', branch: keeperBranch })
  await lib.until(async () => (await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === 'Keeper'), 15000)
  const keeper = (await inv('workspace:refresh')).projects[0].agents.find((a) => a.name === 'Keeper')
  await inv('agents:remove', proj, keeper.id, { deleteWorktree: false })
  g('branch -D hive/ws')
  check('Keeper removed, its worktree kept; the branch in the way gone', fs.existsSync(keeper.worktree.path) && !g('branch --list hive/ws').split('\n').some((l) => l.trim() === 'hive/ws'))
  keeperDialog = await addWith('Keeper')
  check('…the dialog still offers the part it moved to', !!(await lib.until(async () => (await branchShown(keeperDialog)) === 'hive/ws-2/demo/keeper', HUNG_MS)), await branchShown(keeperDialog))
  const reuseNote = keeperDialog.locator('[data-worktree-match="reuse"]')
  check('…and says it reuses the kept worktree', !!(await lib.until(async () => (await reuseNote.innerText().catch(() => '')).toLowerCase().includes(keeper.worktree.path.toLowerCase()), HUNG_MS)), await reuseNote.innerText().catch(() => ''))
  await page.screenshot({ path: path.join(scratch, 'ui-7-reuse-moved-part.png') })
  // Adding there is refused in 1.0 (#1451): nothing is pinned to the kept worktree.
  await keeperDialog.locator('.btn.primary', { hasText: 'Add Agent' }).click()
  check('…and adding in it is refused (1.0 pins no agent to a worktree)', !!(await lib.until(async () => /pinned to worktrees/.test(await keeperDialog.innerText().catch(() => '')), HUNG_MS)) && !(await inv('workspace:refresh')).projects[0].agents.some((a) => a.name === 'Keeper'), await keeperDialog.innerText().catch(() => ''))
  await page.keyboard.press('Escape')
  await lib.until(async () => (await keeperDialog.count()) === 0, HUNG_MS)

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
