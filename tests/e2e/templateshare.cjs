// Templates view and tab, export and import (#127): the Templates view on the activity bar (after Skills and Dialects, HI-2444) lists Combwork's
// own (#1436), the workspace's templates and each project's, with a filter; selecting one shows its agents and layout; Rename…,
// Duplicate… (into another project), Load into Project… (the project chosen, then loading's own confirmation),
// Export… to a test folder (nothing personal in the file), Import… of that file (where to keep it; a name clash offers
// Keep Both), an invalid file refused with the reason, and Delete. A project's Templates tab lists its own and the
// workspace's with their scopes, and loads into that project. Screenshots and reachability at 1700 and 900 px in both
// themes. #271: Edit… in the view (name, description, layout; an agent changed in the Agent Settings dialog, one added
// (a taken name refused), moved, one removed), saved, then loaded: exactly those agents. #702: alpha's names are taken
// in beta, so loading alpha's templates there marks them, greys Load template out, and loads them renamed. #510: an agent's Save saves the
// template too; changes not saved survive leaving the editor (marked in the list), and Cancel discards them. The file dialogs and the
// Recycle Bin are answered in main (never the real ones). Agents use the fake Claude
// Code (fake-claude/), never started. Dev build, throwaway profile and workspace; a quiet test copy.
const lib = require('./lib.cjs')
const { _electron } = require('playwright-core')
const fs = require('fs')
const os = require('os')
const path = require('path')
// Only its agents (HI-1910): its workflow, ticked by default, would open Version Control → Workflow after the load.
const agentsOnly = async (d) => {
  const box = d.locator('[data-workflow-apply]')
  if (await box.count()) await box.uncheck()
}
// The longest a wait here waits for what it waits on: a bound for a hung run, never how long it should take (#570).
const HUNG_MS = 10000

const userData = path.join(lib.WORK, 'templateshare-profile')
const ws = path.join(lib.WORK, 'templateshare-ws')
const claudeHome = path.join(lib.WORK, 'templateshare-claude-home')
const exports_ = path.join(lib.WORK, 'templateshare-files')
const alpha = path.join(ws, 'alpha')
const beta = path.join(ws, 'beta')
let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !extra ? '' : ` (${extra})`}`)
}

;(async () => {
  for (const d of [userData, ws, ws + '.worktrees', claudeHome, exports_]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(claudeHome, { recursive: true })
  fs.mkdirSync(exports_, { recursive: true })
  lib.gitProject(alpha)
  lib.gitProject(beta)
  lib.enableProviders(userData)
  const cfgFile = path.join(userData, 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.settings.providers['claude-code'].executablePath = path.join(__dirname, 'fake-claude', 'fake-claude.cmd')
  cfg.settings.general = { ...cfg.settings.general, confirmOnQuit: 'never' }
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))

  const env = lib.combworkEnv({ CW_USER_DATA: userData, CW_API_PORT: lib.port(47921), CLAUDE_CONFIG_DIR: claudeHome })
  const app = await _electron.launch({ executablePath: lib.ELECTRON, args: [lib.ROOT], cwd: lib.ROOT, env })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => check('no page errors', false, e.message))
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await lib.appReady(page)
  const inv = (ch, ...a) => page.evaluate(([c, x]) => window.combwork.invoke(c, ...x), [ch, a])
  await lib.openWorkspace(inv, page, ws)
  await lib.waitForProvider(inv)
  const projectCfg = (p) => lib.projectConfig(userData, p) // with this user's view over it (HI-1749)
  const dialog = page.locator('.dialog').last()
  const shot = (name) => page.screenshot({ path: path.join(lib.WORK, `templateshare-${name}.png`) })
  const sidebar = page.locator('.sidebar')
  // The view's main area (a project's Templates tab has a .tab-body of its own).
  const detail = page.locator('.main-area > .tab-body .template-detail')
  // The templates kept in the workspace and its projects (Combwork's own, #1436, aside), and one of them by name.
  const rowNames = async (where) => (await where.locator('.template-row:not([data-scope="combwork"]) .label').allInnerTexts()).map((t) => t.split('\n')[0].trim())
  const userRow = (where, name) => where.locator(`.template-row:not([data-scope="combwork"])[aria-label="${name}"]`)
  const CW_NAMES = ['Solo', 'Pair', 'Pair: one provider', 'Team 3×3', 'Team 6×6', 'Team 6 + pool']
  // (Their headers are upper-case by CSS.)
  const groups = async () => (await sidebar.locator('.template-group .skill-group').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
  const templatesOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [])
  const wsTemplates = path.join(ws, '.combwork', 'templates')
  const own = (p) => path.join(p, '.combwork', 'templates')
  // The file dialogs, answered in main (a deleted template goes to the suite's trash folder, #414).
  const saveTo = (file) => app.evaluate(({ dialog: d }, f) => { d.showSaveDialog = async () => ({ canceled: false, filePath: f }) }, file)
  const openFile = (file) => app.evaluate(({ dialog: d }, f) => { d.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, file)
  const toast = async (re) => lib.until(async () => (await page.locator('.toast').allInnerTexts()).some((t) => re.test(t)), 5000)

  // --- alpha: Builder (builder) and Reviewer, two columns: "Pair" for the workspace, "Solo" for alpha only.
  await lib.addAgent(inv, alpha, { name: 'Builder', role: 'builder', model: 'opus' })
  await lib.addAgent(inv, alpha, { name: 'Reviewer' })
  await inv('project:updateConfig', alpha, { layout: 'columns2' })
  await inv('templates:save', alpha, 'workspace', 'Pair', false)
  await inv('templates:save', alpha, 'project', 'Solo', false)
  await lib.addAgent(inv, beta, { name: 'Old' })
  await inv('workspace:refresh')

  // --- The Templates view, after Skills and Dialects (HI-2444).
  const bar = await page.locator('.activitybar .activity-btn').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  check('the Templates icon follows Skills and Dialects on the activity bar', bar.indexOf('Dialects') === bar.indexOf('Skills') + 1 && bar.indexOf('Templates') === bar.indexOf('Dialects') + 1, JSON.stringify(bar))
  await page.locator('.activitybar [aria-label="Templates"]').click()
  check("the view lists Combwork's own, the workspace's templates, then each project's under its name", !!(await lib.until(async () => JSON.stringify(await groups()) === '["combwork 6","workspace 1","alpha 1"]', 5000)) && JSON.stringify(await rowNames(sidebar)) === '["Pair","Solo"]' && JSON.stringify(await sidebar.locator('.template-row[data-scope="combwork"]').evaluateAll((l) => l.map((x) => x.getAttribute('aria-label')))) === JSON.stringify(CW_NAMES), JSON.stringify([await groups(), await rowNames(sidebar)]))
  await sidebar.locator('select[aria-label="Show templates of"]').selectOption({ label: 'alpha' })
  check('the filter shows one project\'s', !!(await lib.until(async () => JSON.stringify(await rowNames(sidebar)) === '["Solo"]', HUNG_MS)))
  await sidebar.locator('select[aria-label="Show templates of"]').selectOption({ label: 'All templates' })
  await userRow(sidebar, 'Pair').click()
  await detail.waitFor({ timeout: 5000 })
  const table = (await detail.locator('table tbody tr').allInnerTexts()).map((r) => r.split('\t').map((c) => c.trim()))
  // HI-2109: the CLI each suggests; no model, effort or mode (a template keeps none).
  check('selecting one shows its agents (role in the workflow with its note, the CLI it suggests) and layout; nothing of worktrees or models', table.length === 2 && table[0][0] === 'Builder' && /^Builder\s+builder$/.test(table[0][1]) && table[1][1] === 'Reviewer' && table[0][2] === 'Claude Code' && table[0].length === 3 && !/opus/i.test(table.flat().join()) && !/worktree|project folder/i.test((await detail.innerText()).replace(await detail.locator('[data-template-workflow-view]').innerText().catch(() => ''), '')) && /2 agents, two columns layout/i.test(await detail.innerText()), JSON.stringify(table))
  await shot('1-view')

  // Rename: in place, the file kept.
  await detail.getByRole('button', { name: 'Rename…' }).click()
  await dialog.locator('input.input').fill('Team')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  check('Rename… renames it where it is kept, the file kept', !!(await lib.until(async () => JSON.stringify(await rowNames(sidebar)) === '["Team","Solo"]', 5000)) && JSON.parse(fs.readFileSync(path.join(wsTemplates, 'pair.json'), 'utf8')).name === 'Team')

  // Duplicate into beta.
  await detail.getByRole('button', { name: 'Duplicate…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta (this project only)' })
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click()
  check('Duplicate… copies it into another project', !!(await lib.until(async () => templatesOf(own(beta)).length === 1, 5000)) && !!(await lib.until(async () => JSON.stringify(await groups()) === '["combwork 6","workspace 1","alpha 1","beta 1"]', 5000)), JSON.stringify(await groups()))

  // Load into Project…: the project chosen, then the list of who goes and who comes.
  await userRow(sidebar, 'Team').first().click()
  await detail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const confirmLoad = page.locator('.dialog', { hasText: 'Load "Team"?' })
  await confirmLoad.waitFor({ timeout: 5000 })
  check("…then loading's confirmation, for the chosen project", (await confirmLoad.locator('.template-plan-table tbody tr[data-state="removed"]').evaluateAll((l) => l.map((x) => x.dataset.agent))).join() === 'Old')
  // Its names are alpha's agents' (#702): free ones filled in (#1440), so Load template is ready; chosen here instead.
  const nameBoxes = (d) => d.locator('.template-plan-name-input')
  const loadOf = (d) => d.getByRole('button', { name: 'Load template' })
  check("…alpha's names: free ones filled in, none marked, Load template ready", JSON.stringify(await nameBoxes(confirmLoad).evaluateAll((l) => l.map((x) => x.value))) === '["Builder (beta)","Reviewer (beta)"]' && (await confirmLoad.locator('.template-plan-table .field-error').count()) === 0 && (await loadOf(confirmLoad).isEnabled()), JSON.stringify(await nameBoxes(confirmLoad).evaluateAll((l) => l.map((x) => x.value))))
  await nameBoxes(confirmLoad).nth(0).fill('BBuilder')
  await nameBoxes(confirmLoad).nth(1).fill('BReviewer')
  await lib.until(() => loadOf(confirmLoad).isEnabled(), 5000)
  await agentsOnly(confirmLoad)
  await loadOf(confirmLoad).click()
  check('Load into Project… replaces that project\'s agents and layout', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => a.name)) === '["BBuilder","BReviewer"]' && projectCfg(beta).layout === 'columns2', 10000)), JSON.stringify(projectCfg(beta).agents.map((a) => a.name)))

  // Export to a test folder: what the template holds, nothing personal.
  const exported = path.join(exports_, 'Team.combwork-template.json')
  await saveTo(exported)
  await detail.getByRole('button', { name: 'Export…' }).click()
  check('Export… writes the template file', !!(await lib.until(async () => fs.existsSync(exported), 5000)) && !!(await toast(/Template exported/)))
  const text = fs.readFileSync(exported, 'utf8')
  const json = JSON.parse(text)
  check('the exported file holds the template and nothing personal (no paths, ids, sessions, user names; its workflow the rules only, HI-1910)', JSON.stringify(Object.keys(json).sort()) === '["agents","layout","name","savedAt","version","workflow"]' && !/"target"|"commands"|"email"/.test(JSON.stringify(json.workflow)) && !/templateshare|Users|"id"|lastSessionId/i.test(text) && !text.toLowerCase().includes(os.userInfo().username.toLowerCase()), text.slice(0, 200))

  // Import it into alpha: where to keep it asked; again, a clash: Keep Both.
  const importInto = async (label) => {
    await openFile(exported)
    await sidebar.locator('[aria-label="Import Template…"]').click()
    const ask = page.locator('.dialog', { hasText: 'Import "Team"' })
    await ask.waitFor({ timeout: 5000 })
    await ask.locator('select').selectOption({ label })
    await ask.getByRole('button', { name: 'Import', exact: true }).click()
  }
  await importInto('alpha (this project only)')
  check('Import… asks where to keep it, then imports it there', !!(await lib.until(async () => templatesOf(own(alpha)).length === 2, 5000)))
  const importedFile = templatesOf(own(alpha)).find((f) => f !== 'solo.json')
  const imported = JSON.parse(fs.readFileSync(path.join(own(alpha), importedFile), 'utf8'))
  check('export then import round-trips it exactly', JSON.stringify(imported) === JSON.stringify(json), JSON.stringify(imported).slice(0, 200))
  await importInto('alpha (this project only)')
  const clash = page.locator('.dialog', { hasText: 'A template of that name is already there' })
  check('a name already there: Replace or Keep Both', !!(await lib.until(async () => (await clash.count()) === 1, 5000)) && (await clash.getByRole('button', { name: 'Replace' }).count()) === 1)
  await clash.getByRole('button', { name: 'Keep Both' }).click()
  check('Keep Both adds it as "Team (2)"', !!(await lib.until(async () => templatesOf(own(alpha)).map((f) => JSON.parse(fs.readFileSync(path.join(own(alpha), f), 'utf8')).name).sort().join() === 'Solo,Team,Team (2)', 5000)))

  // An invalid file: refused with the reason, nothing asked or written.
  const bad = path.join(exports_, 'future.json')
  fs.writeFileSync(bad, JSON.stringify({ ...json, version: 99 }))
  await openFile(bad)
  const before = templatesOf(wsTemplates).length + templatesOf(own(alpha)).length + templatesOf(own(beta)).length
  await sidebar.locator('[aria-label="Import Template…"]').click()
  check('an invalid file is refused, saying why', !!(await toast(/Could not import the template[\s\S]*newer version of Combwork/)) && (await page.locator('.dialog').count()) === 0 && templatesOf(wsTemplates).length + templatesOf(own(alpha)).length + templatesOf(own(beta)).length === before)

  // Delete Team (2).
  await userRow(sidebar, 'Team (2)').click()
  await detail.locator('[aria-label="Delete template"]').click()
  await page.locator('.dialog', { hasText: 'Delete "Team (2)"?' }).getByRole('button', { name: 'Delete' }).click()
  check('Delete removes it (to the Recycle Bin)', !!(await lib.until(async () => templatesOf(own(alpha)).length === 2, 5000)) && !!(await lib.until(async () => !(JSON.stringify(await rowNames(sidebar))).includes('Team (2)'), 5000)))

  // --- alpha's Templates tab: its own and the workspace's, with their scopes; Load goes into alpha.
  await page.locator('.activitybar [aria-label="Projects"]').click()
  await page.locator('.project-row', { hasText: 'alpha' }).first().click()
  await lib.openMoreTab(page, 'Templates')
  const tab = page.locator('.split-list').filter({ has: page.locator('.pane-header', { hasText: 'Templates' }) })
  await tab.waitFor({ timeout: 5000 })
  // Each row's name and the badge saying where it is kept.
  const tabRows = async () => tab.locator('.template-row .label').evaluateAll((els) => els.map((el) => `${el.firstChild.textContent.trim()}: ${el.querySelector('.badge')?.textContent.trim() ?? ''}`))
  check("the project's tab lists its own, the workspace's and Combwork's, each with its scope", !!(await lib.until(async () => JSON.stringify(await tabRows()) === JSON.stringify(['Solo: alpha', 'Team: alpha', 'Team: Workspace', ...CW_NAMES.map((n) => `${n}: Combwork`)]), 5000)), JSON.stringify(await tabRows()))
  await userRow(tab, 'Solo').click()
  const tabDetail = page.locator('.split-main .template-detail')
  const ids = JSON.stringify(projectCfg(alpha).agents.map((a) => a.id))
  await tabDetail.getByRole('button', { name: 'Load into This Project…' }).click()
  const confirmTab = page.locator('.dialog', { hasText: 'Load "Solo"?' })
  await confirmTab.waitFor({ timeout: 5000 })
  await agentsOnly(confirmTab)
  await confirmTab.getByRole('button', { name: 'Load template' }).click()
  check("Load into This Project… loads into the tab's project (new agents, as the template has them)", !!(await lib.until(async () => JSON.stringify(projectCfg(alpha).agents.map((a) => a.id)) !== ids, 10000)) && JSON.stringify(projectCfg(alpha).agents.map((a) => a.name)) === '["Builder","Reviewer"]')

  // --- Reachable at 1700 and 900 px, in both themes: the detail's buttons inside the window and clickable.
  const reachable = (sel) =>
    page.evaluate((s) => {
      const els = [...document.querySelectorAll(`${s} .template-detail-actions button`)]
      return els.length > 0 && els.every((el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return r.right <= window.innerWidth && r.width > 0 && !!t && (t === el || el.contains(t))
      })
    }, sel)
  for (const width of [1700, 900]) {
    for (const theme of ['dark', 'light']) {
      await inv('settings:update', { appearance: { theme } })
      await lib.fitWindow(app, page, { width, height: 800 })
      await lib.sleep(400)
      check(`${theme}, ${width} px: the tab's template actions are inside the window and clickable`, await reachable('.split-main'))
      await shot(`tab-${width}-${theme}`)
    }
  }
  await page.locator('.activitybar [aria-label="Templates"]').click()
  await userRow(sidebar, 'Solo').click()
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(400)
    check(`${theme}, 900 px: the view's template actions are inside the window and clickable`, await reachable('.main-area > .tab-body'))
    await shot(`view-900-${theme}`)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })

  // --- #271: Edit… a template in the view: its name, description and layout; Reviewer changed in the Agent Settings
  // dialog (a note, and Either as its role in the workflow, #1436), Tester added (a name taken refused), moved up,
  // Builder removed; saved, then loaded into beta: exactly those agents, in that order, with that layout. Both themes.
  await lib.fitWindow(app, page, { width: 1700, height: 900 })
  await userRow(sidebar, 'Team').first().click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  const editor = page.locator('.main-area > .tab-body .template-editor')
  await editor.waitFor({ timeout: 5000 })
  check('Edit… opens the editor with its agents', JSON.stringify(await editor.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.agent))) === '["Builder","Reviewer"]')
  await editor.locator('#template-name').fill('Team edited')
  await editor.locator('#template-description').fill('Builds, then reviews.')
  await editor.locator('#template-layout').selectOption('columns3')
  await editor.locator('[aria-label="Edit Reviewer…"]').click()
  const agentDialog = page.locator('.dialog', { hasText: 'Reviewer settings (template)' })
  await agentDialog.waitFor({ timeout: 5000 })
  check('…each agent in the Agent Settings dialog (template mode: its role in the workflow and note; nothing of where it works)', (await agentDialog.getByRole('radiogroup', { name: 'Role in the workflow' }).count()) === 1 && (await agentDialog.locator('[aria-label="Works in"]').count()) === 0 && (await agentDialog.locator('.provider-choice').count()) === 1)
  await agentDialog.locator('#agent-role').fill('checker')
  await agentDialog.locator('.workflow-role-choice [data-workflow-role="either"]').click()
  await shot('edit-agent-dialog')
  await agentDialog.getByRole('button', { name: 'Save' }).click()
  await lib.until(async () => (await agentDialog.count()) === 0, HUNG_MS)
  await editor.getByRole('button', { name: 'Add Agent…' }).click()
  const newAgent = page.locator('.dialog', { hasText: 'New agent (template)' })
  await newAgent.waitFor({ timeout: 5000 })
  await newAgent.locator('input[aria-label="Name"]').fill('reviewer')
  check('…a name another agent of the template has is refused', (await newAgent.getByRole('button', { name: 'Save' }).isDisabled()) && /Another agent of the template is called "reviewer"/.test(await newAgent.innerText()))
  await newAgent.locator('input[aria-label="Name"]').fill('Tester')
  await newAgent.getByRole('button', { name: 'Save' }).click()
  await lib.until(async () => (await newAgent.count()) === 0, HUNG_MS)
  await editor.locator('[aria-label="Move Tester up"]').click()
  await editor.locator('[aria-label="Remove Builder"]').click()
  const editedRows = await editor.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.dataset.agent))
  check('…added, moved and removed in the editor', JSON.stringify(editedRows) === '["Tester","Reviewer"]', JSON.stringify(editedRows))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`editor-${theme}`)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await editor.getByRole('button', { name: 'Save Template' }).click()
  const teamFile = path.join(wsTemplates, 'pair.json')
  const savedTeam = await lib.until(async () => {
    const j = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
    // (Its agents' Saves saved it already, #510: Save Template's own save is the one without Builder.)
    return j.name === 'Team edited' && !j.agents.some((x) => x.name === 'Builder') ? j : null
  }, 5000)
  check('Save Template writes it where it is kept: name, description, layout and the agents in order', !!savedTeam && savedTeam.description === 'Builds, then reviews.' && savedTeam.layout === 'columns3' && JSON.stringify(savedTeam.agents.map((a) => [a.name, a.role, a.note ?? '', 'worktree' in a])) === '[["Tester","builder","",false],["Reviewer","either","checker",false]]', JSON.stringify(savedTeam))
  check('…and the view shows it again, with its description', !!(await lib.until(async () => (await detail.count()) === 1 && /Builds, then reviews\./.test(await detail.innerText()), 5000)))
  await detail.getByRole('button', { name: 'Load into Project…' }).click()
  await dialog.locator('select').selectOption({ label: 'beta' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  const loadEdited = page.locator('.dialog', { hasText: 'Load "Team edited"?' })
  await loadEdited.waitFor({ timeout: 5000 })
  // (Reviewer is alpha's agent's name: changed. Tester is free.)
  await nameBoxes(loadEdited).nth(1).fill('BReviewer')
  await lib.until(() => loadOf(loadEdited).isEnabled(), 5000)
  await agentsOnly(loadEdited)
  await loadOf(loadEdited).click()
  check('loaded into beta: exactly those agents, in order, with that layout', !!(await lib.until(async () => JSON.stringify(projectCfg(beta).agents.map((a) => [a.name, a.workflowRole, a.role ?? '', !!a.worktree])) === '[["Tester","builder","",false],["BReviewer","either","checker",false]]' && projectCfg(beta).layout === 'columns3', 15000)), JSON.stringify(projectCfg(beta).agents))
  // A save made while the editor is open is never overwritten (#271): the draft (a new name) is open; "Team edited" is
  // changed on disk (a description) and the editor's own list refreshes (another template saved, from the palette).
  // The editor says so; Save is refused, keeping both the draft and the change; Discard and Reload shows the change.
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  await editor.locator('#template-name').fill('Local draft')
  const onDisk = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
  fs.writeFileSync(teamFile, JSON.stringify({ ...onDisk, description: 'external change must survive', savedAt: new Date(Date.now() + 1000).toISOString() }, null, 2))
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Save Agents as Template')
  await lib.sleep(300)
  await page.keyboard.press('Enter')
  await dialog.locator('input.input').waitFor({ timeout: 5000 })
  await dialog.locator('input.input').fill('Bump')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  check('the editor says the template was saved again meanwhile', !!(await lib.until(async () => (await editor.locator('.template-stale').count()) === 1, 8000)))
  await editor.getByRole('button', { name: 'Save Template' }).click()
  check('…Save is refused, saying why', !!(await lib.until(async () => /changed since you started editing it/.test(await editor.innerText()), 5000)), await editor.innerText())
  const kept = JSON.parse(fs.readFileSync(teamFile, 'utf8'))
  check('…the change made meanwhile survives', kept.description === 'external change must survive' && kept.name === 'Team edited', JSON.stringify(kept))
  check('…and the draft is still open', (await editor.locator('#template-name').inputValue()) === 'Local draft')
  await shot('editor-stale')
  await editor.getByRole('button', { name: 'Discard and Reload' }).click()
  await page.locator('.dialog', { hasText: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click()
  check('Discard and Reload shows it as it is now', !!(await lib.until(async () => (await editor.count()) === 0 && /external change must survive/.test(await detail.innerText()), 5000)))


  // --- #510: an agent's Save in the editor saves the template too (Save means save), and the editor stays open. Its
  // changes not saved yet (a new name) survive leaving it for another template: the list marks it, and it opens again
  // with them. Cancel then discards them. Both themes.
  await userRow(sidebar, 'Team edited').first().click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  await editor.locator('[aria-label="Edit Tester…"]').click()
  const testerDialog = page.locator('.dialog', { hasText: 'Tester settings (template)' })
  await testerDialog.waitFor({ timeout: 5000 })
  check("the agent's dialog says its Save saves it in the template", /Save saves it in the template/.test(await testerDialog.innerText()), await testerDialog.innerText())
  await testerDialog.locator('#agent-role').fill('qa')
  await testerDialog.getByRole('button', { name: 'Save' }).click()
  const roleOf = () => JSON.parse(fs.readFileSync(teamFile, 'utf8')).agents.find((a) => a.name === 'Tester')?.note
  check("an agent's Save saves the template, with no Save Template", !!(await lib.until(() => roleOf() === 'qa', 5000)), String(roleOf()))
  // (The file is written a moment before the editor has the reply.)
  check('…the editor stays open, with nothing left unsaved', !!(await lib.until(async () => (await editor.count()) === 1 && (await editor.locator('.template-unsaved-note').count()) === 0 && (await editor.getByRole('button', { name: 'Save Template' }).isDisabled()), 5000)))
  // Nothing should come: 1.5 s in which the stale note must not show (a quiet period, the point of the check).
  check('…and never says it was saved again meanwhile (its own save)', !(await lib.until(async () => (await editor.locator('.template-stale').count()) > 0, 1500)))
  await editor.getByRole('button', { name: 'Close' }).click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  check('closed and opened again: the change is kept', /qa/.test(await editor.locator('tbody tr[data-agent="Tester"]').innerText()))
  // A change not saved, then another template: nothing lost.
  await editor.locator('#template-name').fill('Team pending')
  check('a change not saved is marked in the editor', (await editor.locator('.template-unsaved-note').count()) === 1)
  await userRow(sidebar, 'Bump').first().click()
  const teamRow = userRow(sidebar, 'Team edited').first()
  check('…another template: the list marks this one "Not saved"', !!(await lib.until(async () => (await teamRow.locator('.template-unsaved').count()) === 1, 5000)))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`unsaved-row-${theme}`)
  }
  await teamRow.click()
  check('…back: the editor opens again with the change', !!(await lib.until(async () => (await editor.count()) === 1 && (await editor.locator('#template-name').inputValue()) === 'Team pending', 5000)))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`unsaved-editor-${theme}`)
  }
  await inv('settings:update', { appearance: { theme: 'dark' } })
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await page.locator('.dialog', { hasText: 'Discard your changes?' }).getByRole('button', { name: 'Discard' }).click()
  check('Cancel discards it: the editor closes, the mark goes, the template is as saved', !!(await lib.until(async () => (await editor.count()) === 0 && (await teamRow.locator('.template-unsaved').count()) === 0, 5000)) && JSON.parse(fs.readFileSync(teamFile, 'utf8')).name === 'Team edited')

  // --- #510 round 2: a slow save. While it runs nothing in the editor can change (so no edit is lost when it ends, and
  // no agent's Save is accepted that isn't saved); then Reload Window and quitting ask about a draft not saved.
  const slow = (v) => app.evaluate((_e, x) => void (process.env.CW_TEST_SLOW_IPC = x), v)
  const disabledNow = async () => ({
    name: await editor.locator('#template-name').isDisabled(),
    edit: await editor.locator('[aria-label="Edit Tester…"]').isDisabled(),
    add: await editor.getByRole('button', { name: 'Add Agent…' }).isDisabled(),
    remove: await editor.locator('[aria-label="Remove Tester"]').isDisabled()
  })
  const teamNow = () => JSON.parse(fs.readFileSync(teamFile, 'utf8'))
  await teamRow.click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  await editor.locator('#template-name').fill('Team slow')
  await slow('templates:update=2500*1')
  await editor.getByRole('button', { name: 'Save Template' }).click()
  await lib.until(async () => /Saving…/.test(await editor.innerText()), HUNG_MS)
  const whileSaving = await disabledNow()
  check('a slow Save Template: while it saves, the name, agents and their buttons are disabled', Object.values(whileSaving).every(Boolean), JSON.stringify(whileSaving))
  await shot('saving')
  check('…then it is saved and the editor closes', !!(await lib.until(async () => (await editor.count()) === 0 && teamNow().name === 'Team slow', 8000)), JSON.stringify(teamNow().name))
  // An agent's Save while its template save is slow: no other Save can start until it is done, and each one saved is.
  const slowRow = userRow(sidebar, 'Team slow').first()
  await slowRow.click()
  await detail.getByRole('button', { name: 'Edit…' }).click()
  await editor.waitFor({ timeout: 5000 })
  const saveTester = async (role) => {
    await editor.locator('[aria-label="Edit Tester…"]').click()
    await testerDialog.waitFor({ timeout: 5000 })
    await testerDialog.locator('#agent-role').fill(role)
    await testerDialog.getByRole('button', { name: 'Save' }).click()
    await lib.until(async () => (await testerDialog.count()) === 0, HUNG_MS)
  }
  // (Another value: Combwork reads the setting again only when it changes.)
  await slow('templates:update=2501*1')
  await saveTester('first-save')
  const duringAgentSave = await disabledNow()
  check("an agent's Save saving slowly: no other agent can be edited meanwhile", duringAgentSave.edit && duringAgentSave.add && duringAgentSave.name && teamNow().agents.find((a) => a.name === 'Tester')?.note !== 'first-save', JSON.stringify(duringAgentSave))
  check('…then it is saved', !!(await lib.until(() => teamNow().agents.find((a) => a.name === 'Tester')?.note === 'first-save', 8000)))
  await lib.until(async () => !(await editor.locator('[aria-label="Edit Tester…"]').isDisabled()), HUNG_MS)
  await saveTester('second-save')
  check('…and the next agent Save is saved too, with nothing left unsaved', !!(await lib.until(async () => teamNow().agents.find((a) => a.name === 'Tester')?.note === 'second-save' && (await editor.locator('.template-unsaved-note').count()) === 0, 5000)))
  // A draft not saved: Reload Window asks first (and Cancel keeps it), quitting asks too, and Save and quit saves it.
  await editor.locator('#template-name').fill('Team at quit')
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette input').fill('Reload Window')
  await lib.sleep(300)
  await page.keyboard.press('Enter')
  const askSave = page.locator('.dialog', { hasText: 'Save your changes?' })
  check('Reload Window with a template draft asks to save it first', !!(await lib.until(async () => (await askSave.count()) === 1 && /Template "Team slow"/.test(await askSave.innerText()), 5000)), await askSave.innerText().catch(() => ''))
  await shot('reload-asks')
  await askSave.getByRole('button', { name: 'Cancel' }).click()
  check('…Cancel keeps the draft, still open', !!(await lib.until(async () => (await askSave.count()) === 0, HUNG_MS)) && (await editor.locator('#template-name').inputValue()) === 'Team at quit')
  const q = await lib.quitWatch(app)
  await inv('app:quit')
  const quitDialog = page.locator('.dialog', { hasText: 'unsaved changes' })
  check('quitting with a template draft asks about it', !!(await lib.until(async () => (await quitDialog.count()) === 1 && /pair\.json/.test(await quitDialog.innerText()), 5000)), await quitDialog.innerText().catch(() => ''))
  for (const theme of ['dark', 'light']) {
    await inv('settings:update', { appearance: { theme } })
    await lib.sleep(300)
    await shot(`quit-asks-${theme}`)
  }
  await quitDialog.getByRole('button', { name: 'Save and quit' }).click()
  check('…Save and quit saves it, then Combwork quits', !!(await q.untilDecided(8000)) && teamNow().name === 'Team at quit', JSON.stringify(teamNow().name))
  await q.gone(30000)
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
  await app.close()
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
